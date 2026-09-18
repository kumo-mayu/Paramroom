// The back end behind the commands: holds the current image, encodes it for the avatar's decoder, finds the VRChat
// client and runs the send loop. State changes are published as whole snapshots through SnapshotChanged, raised on
// background threads (a UI marshals them to its own thread).
using System.Diagnostics;

namespace Paramroom.Session;

public sealed class SessionOptions
{
    public double HoldMs { get; init; } = 100;                 // initial interval; measured: 100 ms keeps loss near 0, 80 ms lost 11% (docs/measure)
    public int? EncodePrimsLimit { get; init; }                 // fewer primitives than the decoder holds (tests, quick sends)
    public TimeSpan ProgressInterval { get; init; } = TimeSpan.FromMilliseconds(250);
    // a render of 4000 primitives at 512 px takes tens of ms; twice a second is enough to watch the image build up
    public TimeSpan ReceivedPreviewInterval { get; init; } = TimeSpan.FromMilliseconds(500);
    // While sending, ask the client every so often whether it still has the same avatar. Packets meant for one decoder
    // produce a broken picture on another, so sending has to stop when the avatar is swapped. 0 disables the check.
    public TimeSpan AvatarCheckInterval { get; init; } = TimeSpan.FromSeconds(5);
    // How often to look for VRChat again while no target is selected. Without this, starting VRChat after this app
    // would need the user to press the refresh button. 0 disables it.
    public TimeSpan TargetScanInterval { get; init; } = TimeSpan.FromSeconds(10);
    public int PreviewLongSide { get; init; } = 512;
}

public sealed class ParamroomSession : IAsyncDisposable
{
    const int WireBitsReserved = 2;  // epoch

    readonly ITargetFinder finder;
    readonly Func<VrcClient, IOscTransport> transportFactory;
    readonly IImageDecoder decoder;
    readonly IImageFetcher fetcher;
    readonly SessionOptions options;
    readonly ISourceHistory history;
    readonly object gate = new();
    SessionSnapshot snapshot = SessionSnapshot.Initial;
    Img? sourceImage;
    string? qrText;   // when set, the source is a QR code made from this text instead of a picture
    Task? scanTask;
    CancellationTokenSource? scanCts;
    CancellationTokenSource? encodeCts, searchCts, sendCts;
    Task sendTask = Task.CompletedTask;
    int lastEpoch;

    public ParamroomSession(ITargetFinder finder, Func<VrcClient, IOscTransport> transportFactory, IImageDecoder decoder, IImageFetcher fetcher, SessionOptions? options = null, ISourceHistory? history = null)
    {
        this.finder = finder; this.transportFactory = transportFactory; this.decoder = decoder; this.fetcher = fetcher;
        this.options = options ?? new SessionOptions();
        this.history = history ?? new InMemoryHistory();
        snapshot = snapshot with { HoldMs = this.options.HoldMs, History = this.history.Load() };
    }

    void Remember(SourceKind kind, string value, string name)
    {
        var next = Update(s => s with { History = HistoryRules.Add(s.History, new HistoryEntry(kind, value, name, DateTimeOffset.Now)) });
        // losing the history file must not stop loading the image
        try { history.Save(next.History); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public void ClearHistory()
    {
        Update(s => s with { History = Array.Empty<HistoryEntry>() });
        try { history.Save(Array.Empty<HistoryEntry>()); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public void LoadBytes(byte[] bytes, string name) => SetSource(DecodeOrThrow(bytes), name);

    // VRChat syncs parameters about every 83-100 ms; much faster sends are dropped, much slower ones only waste time.
    // up to 3 s for very congested instances (public worlds), where parameter sync can lag by seconds
    public const double MinHoldMs = 50, MaxHoldMs = 3000;

    public void SetHold(double milliseconds)
    {
        if (double.IsNaN(milliseconds) || milliseconds < MinHoldMs || milliseconds > MaxHoldMs)
            throw new ImageSourceException($"送信の間隔は {MinHoldMs}〜{MaxHoldMs} ミリ秒で指定してください。");
        Update(s => s with { HoldMs = milliseconds });
    }

    public event Action<SessionSnapshot>? SnapshotChanged;

    public SessionSnapshot Snapshot { get { lock (gate) return snapshot; } }

    // Last encode task, for tests that need to wait for it.
    public Task EncodeTask { get; private set; } = Task.CompletedTask;

    SessionSnapshot Update(Func<SessionSnapshot, SessionSnapshot> change)
    {
        SessionSnapshot next;
        lock (gate) { next = change(snapshot); if (ReferenceEquals(next, snapshot)) return next; snapshot = next; }
        SnapshotChanged?.Invoke(next);
        return next;
    }

    // ---- image

    public async Task LoadFileAsync(string path, CancellationToken cancellationToken = default)
    {
        byte[] bytes;
        try { bytes = await File.ReadAllBytesAsync(path, cancellationToken); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw new ImageSourceException($"ファイルを読めませんでした: {e.Message}", e); }
        SetSource(DecodeOrThrow(bytes), Path.GetFileName(path));
        Remember(SourceKind.File, Path.GetFullPath(path), Path.GetFileName(path));
    }

    public async Task LoadUrlAsync(string url, CancellationToken cancellationToken = default)
    {
        url = url.Trim();
        if (DropParsing.BytesFromDataUri(url) is { } inline) { LoadBytes(inline, "ブラウザから落とした画像"); return; }
        byte[] bytes;
        try { bytes = await fetcher.FetchAsync(url, cancellationToken); }
        catch (HttpRequestException e) { throw new ImageSourceException($"画像を取得できませんでした。URL とネットワークを確認してください（{e.Message}）。", e); }
        // a connection dropped mid-download is an IOException (HttpIOException since .NET 8), not HttpRequestException
        catch (IOException e) { throw new ImageSourceException($"画像の取得が途中で切れました。もう一度試してください（{e.Message}）。", e); }
        catch (TaskCanceledException e) when (!cancellationToken.IsCancellationRequested) { throw new ImageSourceException("画像の取得が時間切れになりました。もう一度試すか、ファイルとして保存してから選んでください。", e); }
        var name = Uri.TryCreate(url, UriKind.Absolute, out var uri) ? Path.GetFileName(uri.LocalPath) : url;
        name = string.IsNullOrEmpty(name) ? url : name;
        SetSource(DecodeOrThrow(bytes), name);
        Remember(SourceKind.Url, url, name);
    }

    Img DecodeOrThrow(byte[] bytes)
    {
        try { return decoder.Decode(bytes); }
        catch (Exception e) { throw new ImageSourceException("画像として読めませんでした。PNG・JPEG などの画像ファイル（URL なら画像そのものの URL）を指定してください。", e); }
    }

    // A QR code made from text. It goes through the same packets as a picture, but it is a handful of them instead of
    // a thousand, so it is complete in well under a second (docs/research/09).
    public void SetQrText(string text)
    {
        text = text?.Trim() ?? "";
        lock (gate) { qrText = text.Length > 0 ? text : null; if (qrText != null) sourceImage = null; }
        if (qrText is null) { Update(s => s with { Source = null }); return; }
        QrMode.QrData qr;
        try { qr = QrMode.Build(qrText); }
        catch (Exception e)
        {
            Update(s => s with { Encode = new EncodeState.Failed("QR コードを作れませんでした：" + e.Message) });
            return;
        }
        var spec = DecoderSpec.For(Snapshot.Target);
        var preview = QrPreview(qr, spec.Canvas);
        Update(s => s with { Source = new SourceInfo(Shorten(qrText), qr.Modules, qr.Modules, preview) });
        StartEncode();
    }

    static string Shorten(string t) => t.Length <= 40 ? t : t[..38] + "…";

    Preview QrPreview(QrMode.QrData qr, int R)
    {
        // the finished code: every unit present
        var L = PrimLayout.Of(DecoderFormat.Default.Config(DecoderFormat.Default.N), 254);
        var units = QrMode.Encode(qr, L, 254);
        var all = units.Select(u => (bool[]?)u).ToList();
        return ToPreview(Img.FromRgbBytes(QrRenderer.Render(R, L, all), R, R), Aspect.Code(1, 1));
    }

    public void SetSource(Img image, string name)
    {
        lock (gate) { sourceImage = image; qrText = null; }
        var preview = ToPreview(image, Aspect.Code(image.W, image.H));
        Update(s => s with { Source = new SourceInfo(name, image.W, image.H, preview) });
        StartEncode();
    }

    public void SetFit(FitMode fit)
    {
        if (Snapshot.Fit == fit) return;
        Update(s => s with { Fit = fit });
        StartEncode();
    }

    // fewer than ~50 primitives is not a picture any more (the encoder's early stop also starts at 50)
    public const int MinPrimCount = 50;

    public void SetPrimCount(int? count)
    {
        if (count is int c && c < MinPrimCount) throw new ImageSourceException($"図形の数は {MinPrimCount} 個以上にしてください。");
        if (Snapshot.PrimCount == count) return;
        Update(s => s with { PrimCount = count });
        StartEncode();
    }

    // ---- targets

    // started on the first search; runs until the session is disposed
    void EnsureScanLoop()
    {
        if (scanTask is not null || options.TargetScanInterval <= TimeSpan.Zero) return;
        scanCts = new CancellationTokenSource();
        scanTask = Task.Run(() => ScanLoop(scanCts.Token));
    }

    public async Task RefreshTargetsAsync()
    {
        EnsureScanLoop();
        searchCts?.Cancel();
        var cts = searchCts = new CancellationTokenSource();
        Update(s => s with { SearchingTargets = true });
        IReadOnlyList<VrcClient> found;
        try { found = await Task.Run(() => finder.FindAsync(cts.Token), cts.Token); }
        catch (OperationCanceledException) { return; }
        catch (Exception) { found = Array.Empty<VrcClient>(); }
        var before = Snapshot;
        var usable = found.Where(IsUsable).ToList();
        VrcClient? target = before.Target is { } cur ? found.FirstOrDefault(c => c.Name == cur.Name && IsUsable(c)) : null;
        target ??= usable.Count == 1 ? usable[0] : null;
        Update(s => s with { SearchingTargets = false, Targets = found, Target = target });
        ReencodeIfSpecChanged();
    }

    // Looks for VRChat again, every TargetScanInterval, as long as nothing usable is selected. It stops on its own once
    // a target is found and resumes if that target disappears, so VRChat can be started before or after this app.
    async Task ScanLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(options.TargetScanInterval, ct); }
            catch (OperationCanceledException) { return; }
            var s = Snapshot;
            if (s.SearchingTargets) continue;              // a search is already running
            if (s.Send is SendState.Active) continue;      // the send loop watches the target itself
            if (s.Target is { } t)
            {
                // A target we already have can go away: VRChat restarts with a different OSCQuery port, so the old one
                // answers nothing. Ask it directly (cheap) and only fall back to a full search when it is gone.
                VrcClient? now = null;
                bool asked = false;
                try { now = await VrcDiscovery.RecheckAsync(t); asked = true; }
                catch (Exception) { }
                // A target with no OSCQuery address (a fixed one, PARAMROOM_TARGET) cannot be asked; leave it alone.
                if (t.QueryIp is null || !asked) continue;
                if (now is not null && IsUsable(now))
                {
                    // still there; keep the fresh copy (the avatar or its Int count may have changed)
                    if (now != t) { Update(x => x with { Target = now, Targets = x.Targets.Select(c => c.Name == now.Name ? now : c).ToList() }); ReencodeIfSpecChanged(); }
                    continue;
                }
                Update(x => x with { Target = null });     // really gone: search again below
            }
            try { await RefreshTargetsAsync(); }
            catch (Exception) { /* keep trying */ }
        }
    }

    public static bool IsUsable(VrcClient c) => c.ParamroomParams > 0 && c.Problem == null;

    public void SelectTarget(string name)
    {
        var s0 = Snapshot;
        var t = s0.Targets.FirstOrDefault(c => c.Name == name) ?? throw new ImageSourceException("その送信先は見つかりません。「送信先を探す」でもう一度探してください。");
        if (!IsUsable(t)) throw new ImageSourceException("そのクライアントのアバターには Paramroom が入っていないようです。Paramroom を入れたアバターに着替えてから探し直してください。");
        Update(s => s with { Target = t });
        ReencodeIfSpecChanged();
    }

    void ReencodeIfSpecChanged()
    {
        var s = Snapshot;
        if (sourceImage is null) return;
        var spec = DecoderSpec.For(s.Target);
        if (s.Encode is EncodeState.Ready r && r.Image.Spec.SameLayout(spec) && r.Image.Fit == s.Fit && r.Image.RequestedPrims == s.PrimCount) return;
        if (s.Encode is EncodeState.Running) { /* restart with the new spec */ }
        StartEncode();
    }

    // ---- schedule

    public void SetSchedule(string schedule)
    {
        if (Schedules.Create(schedule, new double[] { double.PositiveInfinity, 1 }) is null) throw new ImageSourceException($"送り方の指定が違います: {schedule}");
        Update(s => s with { Schedule = schedule });
    }

    // ---- encoding

    void StartEncode()
    {
        Img? src;
        string? qr;
        lock (gate) { src = sourceImage; qr = qrText; }
        if (src is null && qr is null) return;
        encodeCts?.Cancel();
        var cts = encodeCts = new CancellationTokenSource();
        var s0 = Snapshot;
        var spec = DecoderSpec.For(s0.Target);
        var fit = s0.Fit;
        var requested = s0.PrimCount;

        // QR 専用のデコーダー（docs/research/09 §6）。図形の枠を使わないので、割り付けも詰め方も別。
        if (spec.IsQrOnly)
        {
            if (qr is null)
            {
                Update(s => s with { Encode = new EncodeState.Failed("このアバターのデコーダーは QR 専用です。画像は送れません。QR にしたい文字列を入れてください。") });
                return;
            }
            var qL = QrOnly.LayoutFor(spec.Ints);
            if (qL is null)
            {
                Update(s => s with { Encode = new EncodeState.Failed($"Int {spec.Ints} 個では QR が入りません（{QrOnly.MinBytes} 個以上で作り直してください）。") });
                return;
            }
            try
            {
                var data = QrOnly.Build(qr);
                var units = QrOnly.Encode(data, qL);
                var (rgb, side) = RenderQrOnly(qL, units.Select(u => (bool[]?)u).ToList());
                var prev = ToPreview(Img.FromRgbBytes(rgb, side, side), Aspect.Code(1, 1), nearest: true);
                var cfgQr = spec.Format.Config(1);
                var image = new EncodedImage(spec, fit, requested, Aspect.Code(1, 1), cfgQr, PrimLayout.Of(cfgQr, 254), units,
                    Enumerable.Repeat(1.0, units.Count).ToArray(), data.Modules * data.Modules, 0, prev, Qr: true, QrOnlyLayout: qL);
                Update(s => s with { Encode = new EncodeState.Ready(image) });
            }
            catch (Exception e)
            {
                Update(s => s with { Encode = new EncodeState.Failed("QR コードを作れませんでした：" + e.Message) });
            }
            return;
        }

        int P = 8 * spec.Ints - WireBitsReserved;
        var cfg = spec.Format.Config(Math.Min(Math.Min(spec.Capacity, requested ?? int.MaxValue), options.EncodePrimsLimit ?? int.MaxValue));
        PrimLayout layout;
        try { layout = PrimLayout.Of(cfg, P); }
        catch (InvalidOperationException) { Update(s => s with { Encode = new EncodeState.Failed($"Int {spec.Ints} 個には図形が入りません。アバターの Paramroom を作り直してください。") }); return; }
        if (layout.SpareBits < 8)
        {
            // the counts that work depend on the format (format 3 starts at 10, format 6 at 11), so ask the format
            var good = string.Join(" / ", spec.Format.GoodIntCounts());
            Update(s => s with { Encode = new EncodeState.Failed($"Int {spec.Ints} 個では縦横比を送る余白がありません。この形式で使える数（{good}）で作り直してください。") });
            return;
        }
        // A QR code needs no search: the modules go straight into the packets, so it is ready at once.
        if (qr is not null)
        {
            try
            {
                var data = QrMode.Build(qr);
                var units = QrMode.Encode(data, layout, P);
                var all = units.Select(u => (bool[]?)u).ToList();
                var prev = ToPreview(Img.FromRgbBytes(QrRenderer.Render(cfg.R, layout, all), cfg.R, cfg.R), Aspect.Code(1, 1));
                var image = new EncodedImage(spec, fit, requested, Aspect.Code(1, 1), cfg, layout, units,
                    Enumerable.Repeat(1.0, units.Count).ToArray(), data.Modules * data.Modules, 0, prev, Qr: true);
                Update(s => s with { Encode = new EncodeState.Ready(image) });
            }
            catch (Exception e)
            {
                Update(s => s with { Encode = new EncodeState.Failed("QR コードを作れませんでした：" + e.Message) });
            }
            return;
        }
        Update(s => s with { Encode = new EncodeState.Running(0, cfg.MaxPrims) });
        EncodeTask = Task.Run(() =>
        {
            try
            {
                var img = src!;
                int aspect = fit == FitMode.Crop ? Aspect.Code(1, 1) : Aspect.Code(img.W, img.H);
                if (fit == FitMode.Crop) { int m = Math.Min(img.W, img.H); img = img.Crop((img.W - m) >> 1, (img.H - m) >> 1, m, m); }
                img = img.Resize(cfg.R, cfg.R);
                var lastReport = Stopwatch.StartNew();
                var res = new PrimEncoder(cfg, img).Encode(P, (done, total) =>
                {
                    if (cts.IsCancellationRequested || lastReport.Elapsed < options.ProgressInterval) return;
                    lastReport.Restart();
                    Update(s => ReferenceEquals(encodeCts, cts) ? s with { Encode = new EncodeState.Running(done, total) } : s);
                }, cts.Token);
                var preview = ToPreview(Img.FromRgbBytes(Canvas(res.Canvas), cfg.R, cfg.R), aspect);
                var encoded = new EncodedImage(spec, fit, requested, aspect, cfg, res.Layout, res.Units, res.Gains, res.Prims, res.Seconds, preview);
                Update(s => ReferenceEquals(encodeCts, cts) ? s with { Encode = new EncodeState.Ready(encoded) } : s);
            }
            catch (OperationCanceledException) { }
            catch (Exception e) { Update(s => ReferenceEquals(encodeCts, cts) ? s with { Encode = new EncodeState.Failed("図形への変換に失敗しました: " + e.Message) } : s); }
        });
    }

    static byte[] Canvas(double[] canvas)
    {
        var b = new byte[canvas.Length];
        for (int i = 0; i < b.Length; i++) b[i] = (byte)Math.Max(0, Math.Min(255, Math.Floor(canvas[i] + 0.5)));
        return b;
    }

    // the image as the avatar shows it: the square canvas reshaped to the aspect ratio, long side PreviewLongSide
    // nearest = 升目の絵（QR）。なめらかに拡大するとぼやけて、画面上で読めなくなる
    Preview ToPreview(Img square, int aspectCode, bool nearest = false)
    {
        double ratio = Aspect.Ratio(aspectCode);
        int L = options.PreviewLongSide;
        int w = ratio >= 1 ? L : Math.Max(1, (int)Math.Round(L * ratio)), h = ratio >= 1 ? Math.Max(1, (int)Math.Round(L / ratio)) : L;
        var img = nearest && w >= square.W ? square.ResizeNearest(w, h) : square.Resize(w, h);
        return new Preview(img.ToRgbBytes(), w, h);
    }

    // ---- sending

    public async Task StartSendingAsync()
    {
        var s0 = Snapshot;
        if (s0.Encode is not EncodeState.Ready ready)
            throw new ImageSourceException(s0.Encode is EncodeState.Running ? "図形への変換が終わるまでお待ちください。" : "先に送る画像を選んでください。");
        if (s0.Target is not { } target)
            throw new ImageSourceException(s0.Targets.Count == 0
                ? "送信先の VRChat が見つかっていません。VRChat を起動し（OSC を有効にして）Paramroom 入りのアバターを着てから「送信先を探す」を押してください。"
                : "送信先を選んでください。");
        if (!ready.Image.Spec.SameLayout(DecoderSpec.For(target)))
        {
            ReencodeIfSpecChanged();
            throw new ImageSourceException("送信先のアバターに合わせて変換し直しています。終わったらもう一度押してください。");
        }
        await StopSendingAsync(keepProgress: false);

        var image = ready.Image;
        var schedule = Schedules.Create(s0.Schedule, image.Gains) ?? Schedules.Create(Schedules.Default, image.Gains)!;
        int epoch = lastEpoch = lastEpoch % 3 + 1;  // 1..3; a new epoch makes receivers clear the old image
        // the avatar tells which parameter names it has (prefixed, or the plain D0.. of avatars built earlier)
        string prefix = Snapshot.Target?.ParamPrefix ?? "";
        // QR 専用は縦横比コードもモードのビットも持たない（docs/research/09 §6）
        var packets = image.Spec.IsQrOnly
            ? Packets.BuildQrOnly(image.Units, epoch, image.Spec.Ints)
            : Packets.Build(image.Units, epoch, image.Aspect, image.Spec.Ints, image.Qr);
        var bundles = packets.Select(p => OscSender.Bundle(p, prefix)).ToArray();
        IOscTransport transport;
        try { transport = transportFactory(target); }
        catch (Exception e) { throw new ImageSourceException($"送信先に接続できませんでした: {e.Message}", e); }

        var cts = sendCts = new CancellationTokenSource();
        var start = new SendProgress(epoch, s0.Schedule, target.Name, 0, 0, image.Units.Count, TimeSpan.Zero, null);
        Update(s => s with { Send = new SendState.Active(start) });
        sendTask = Task.Run(() => SendLoop(image, bundles, schedule, transport, start, cts.Token));
    }

    // what the receivers have so far, drawn the way their decoder would (a picture or a QR code)
    // QR 専用のときは 1 マス 1 画素（＋余白）なので、画像モードとは大きさが違う
    static (byte[] Rgb, int Side) RenderQrOnly(QrOnly.Layout L, IReadOnlyList<bool[]?> received)
    {
        var r = new QrOnlyRenderer(L);
        foreach (var u in received) if (u is not null) r.Apply(u);
        var (side, px) = r.Render();
        var rgb = new byte[side * side * 3];
        for (int i = 0; i < side * side; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = px[i];
        return (rgb, side);
    }

    // 受け取った人に見えている絵。QR 専用・QR モード・画像で描き方が違う
    static (byte[] Rgb, int Side) RenderReceived(EncodedImage image, IReadOnlyList<bool[]?> received) =>
        image.QrOnlyLayout is { } qL ? RenderQrOnly(qL, received)
        : image.Qr ? (QrRenderer.Render(image.Config.R, image.Layout, received), image.Config.R)
                   : (PrimRenderer.Render(image.Config, image.Layout, received), image.Config.R);

    // null while the target still matches what was encoded; otherwise the message to show
    async Task<string?> CheckTargetStillFits(EncodedImage image)
    {
        var target = Snapshot.Target;
        if (target is null) return null;
        VrcClient? now;
        try { now = await VrcDiscovery.RecheckAsync(target); }
        catch (Exception) { return null; }   // a hiccup in the query is not a reason to stop sending
        if (now is null) return null;        // a fixed address (no OSCQuery): nothing to compare against
        if (!IsUsable(now))
            return "アバターが変わり、Paramroom が入っていないアバターになりました。送信を止めました。";
        var spec = DecoderSpec.For(now);
        if (!spec.SameLayout(image.Spec))
            return $"アバターが {spec.DisplayName}・Int {spec.Ints} 個に変わりました。送信を止めたので、画像を作り直して送り直してください。";
        if (now.AvatarId is { } id && target.AvatarId is { } was && id != was)
            return "アバターが変わりました（同じ形式ですが別のアバターです）。送信を止めました。";
        return null;
    }

    void SendLoop(EncodedImage image, byte[][] bundles, Func<int, int> schedule, IOscTransport transport, SendProgress progress, CancellationToken ct)
    {
        var received = new bool[]?[image.Units.Count];
        int distinct = 0, renderedDistinct = -1;
        long sent = 0;
        var sw = Stopwatch.StartNew();
        var lastProgress = TimeSpan.Zero;
        var lastRender = -options.ReceivedPreviewInterval; // render at the first packet
        Preview? receivedPreview = null;
        // The check is an HTTP request, so it runs off the sending thread: the loop must keep its 100 ms beat.
        var lastCheck = TimeSpan.Zero;
        Task<string?>? check = null;
        try
        {
            using var timer = TimerResolution.Begin();
            // the next send time advances by the current interval, so a change applies from the next packet
            double target = 0;
            for (int k = 0; !ct.IsCancellationRequested; k++, target += Snapshot.HoldMs)
            {
                while (sw.Elapsed.TotalMilliseconds < target - 2 && !ct.IsCancellationRequested) Thread.Sleep(1);
                while (sw.Elapsed.TotalMilliseconds < target && !ct.IsCancellationRequested) Thread.SpinWait(50);
                if (ct.IsCancellationRequested) break;
                int unit = schedule(k);
                transport.Send(bundles[unit]);
                sent++;
                if (received[unit] is null) { received[unit] = image.Units[unit]; distinct++; }

                var now = sw.Elapsed;
                if (distinct != renderedDistinct && now - lastRender >= options.ReceivedPreviewInterval)
                {
                    var (recvRgb, recvSide) = RenderReceived(image, received);
                    receivedPreview = ToPreview(Img.FromRgbBytes(recvRgb, recvSide, recvSide), image.Aspect, nearest: image.Qr);
                    renderedDistinct = distinct; lastRender = now;
                    progress = progress with { Received = receivedPreview };
                }
                if (check is { IsCompleted: true })
                {
                    var changed = check.Result;
                    check = null;
                    if (changed is not null)
                    {
                        Update(s => s with { Send = new SendState.Failed(changed) });
                        return;
                    }
                }
                else if (check is null && options.AvatarCheckInterval > TimeSpan.Zero && now - lastCheck >= options.AvatarCheckInterval)
                {
                    lastCheck = now;
                    check = Task.Run(() => CheckTargetStillFits(image), ct);
                }
                if (now - lastProgress >= options.ProgressInterval)
                {
                    lastProgress = now;
                    progress = progress with { PacketsSent = sent, DistinctUnits = distinct, Elapsed = now };
                    var p = progress;
                    Update(s => !ct.IsCancellationRequested && s.Send is SendState.Active ? s with { Send = new SendState.Active(p) } : s);
                }
            }
            if (renderedDistinct != distinct)
            {
                var (lastRgb, lastSide) = RenderReceived(image, received);
                progress = progress with { Received = ToPreview(Img.FromRgbBytes(lastRgb, lastSide, lastSide), image.Aspect, nearest: image.Qr) };
            }
            var final = progress with { PacketsSent = sent, DistinctUnits = distinct, Elapsed = sw.Elapsed };
            Update(s => s.Send is SendState.Active ? s with { Send = new SendState.Stopped(final) } : s);
        }
        catch (Exception e)
        {
            Update(s => s with { Send = new SendState.Failed("送信中にエラーが起きました: " + e.Message) });
        }
        finally { transport.Dispose(); }
    }

    public Task StopSendingAsync() => StopSendingAsync(keepProgress: true);

    async Task StopSendingAsync(bool keepProgress)
    {
        sendCts?.Cancel();
        try { await sendTask; } catch { }
        sendCts = null;
        if (!keepProgress) Update(s => s with { Send = new SendState.Idle() });
    }

    public async ValueTask DisposeAsync()
    {
        encodeCts?.Cancel(); searchCts?.Cancel(); scanCts?.Cancel();
        await StopSendingAsync(keepProgress: true);
        if (scanTask is not null) { try { await scanTask.WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception) { } }
        encodeCts?.Dispose(); searchCts?.Dispose(); scanCts?.Dispose();
    }
}
