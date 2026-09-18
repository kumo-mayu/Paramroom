// 画面の状態。操作は UiCommand にして CommandHandler に渡し、表示はセッションのスナップショットから作る。
// スナップショットは丸ごと差し替わるので、絵は参照が変わったときだけ作り直す（1 秒に何度も届くため）。
using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Paramroom.Commands;
using Paramroom.Session;

namespace Paramroom.App.ViewModels;

// ToString は読み上げ・UI Automation に出る名前（record の既定だと中身を全部並べてしまう）
public sealed record ScheduleOption(string Name, string Label, string Description) { public override string ToString() => Label; }

public sealed record TargetOption(string Name, string Label, bool Usable) { public override string ToString() => Label; }

public sealed record HistoryOption(HistoryEntry Entry)
{
    public string Label => (Entry.Kind == SourceKind.File ? "ファイル：" : "URL：") + Entry.Name;
    public override string ToString() => Label;
}

public sealed record PrimCountOption(int? Count, string Label) { public override string ToString() => Label; }

public sealed record HoldOption(double Milliseconds, string Label, string Description) { public override string ToString() => Label; }

public sealed class MainViewModel : ViewModelBase
{
    readonly CommandHandler handler;
    SessionSnapshot? applied;
    SessionSnapshot? pending;
    int applyQueued;

    public MainViewModel(ParamroomSession session, CommandHandler handler)
    {
        this.handler = handler;
        session.SnapshotChanged += OnSnapshot;
        ChooseFileCommand = new RelayCommand(ChooseFile, () => !IsBusy);
        LoadUrlCommand = new RelayCommand(() => Run(new UiCommand.LoadImageUrl(UrlText)), () => !IsBusy && !string.IsNullOrWhiteSpace(UrlText));
        MakeQrCommand = new RelayCommand(() => Run(new UiCommand.LoadQrText(QrText)), () => !IsBusy && !string.IsNullOrWhiteSpace(QrText));
        RefreshTargetsCommand = new RelayCommand(() => Run(new UiCommand.RefreshTargets()), () => !IsSearching);
        StartStopCommand = new RelayCommand(() => Run(IsSending ? new UiCommand.StopSending() : new UiCommand.StartSending()), () => IsSending || CanStart);
        PasteCommand = new RelayCommand(Paste, () => !IsBusy);
        Apply(session.Snapshot);
    }

    public RelayCommand ChooseFileCommand { get; }
    public RelayCommand LoadUrlCommand { get; }
    public RelayCommand MakeQrCommand { get; }
    public RelayCommand RefreshTargetsCommand { get; }
    public RelayCommand StartStopCommand { get; }
    public RelayCommand PasteCommand { get; }

    public IReadOnlyList<ScheduleOption> ScheduleOptions { get; } = new[]
    {
        new ScheduleOption("fast+sqrt/8", "おすすめ", "今見ている人には速く届き、途中から来た人にも 20 秒ほどで大まかな絵が出ます。"),
        new ScheduleOption("fast", "今いる人を優先", "今見ている人に一番速く届きます。途中から来た人には、1 周が終わるまで崩れた絵が見えます。"),
        new ScheduleOption("sqrt", "途中から来る人を優先", "いつ来た人にも同じ速さで届きます。今見ている人には少し遅くなります。"),
    };

    // 実測（2026-09-17、docs/measure）：受け側の更新は約 83〜100 ms ごと。100 ms で取りこぼしはほぼ 0、80 ms では 11% 落ちた
    public IReadOnlyList<HoldOption> HoldOptions { get; } = new[]
    {
        new HoldOption(67, "67 ミリ秒（速い・取りこぼしが多い）", "実測では 100 ミリ秒より短いとパケットを取りこぼしました。届く速さはあまり上がらないことがあります。"),
        new HoldOption(83, "83 ミリ秒（やや速い）", "実測では 80 ミリ秒で 1 割ほど取りこぼしました。混んでいないワールド向けです。"),
        new HoldOption(100, "100 ミリ秒（おすすめ）", "実測で取りこぼしがほぼ無かった間隔です。"),
        new HoldOption(117, "117 ミリ秒", "少し余裕を持たせた間隔です。"),
        new HoldOption(150, "150 ミリ秒（ゆっくり）", "人が多く、同期が遅れがちなワールド向けです。"),
        new HoldOption(200, "200 ミリ秒（とてもゆっくり）", "届くのは遅くなりますが、取りこぼしはさらに起きにくくなります。"),
        new HoldOption(250, "250 ミリ秒", "人の多いワールドで、同期が遅れているとき向けです。"),
        new HoldOption(300, "300 ミリ秒", "人の多いワールドで、同期が遅れているとき向けです。"),
        new HoldOption(400, "400 ミリ秒", "混雑したワールド向けです。1 周の時間は 100 ミリ秒の 4 倍かかります。"),
        new HoldOption(500, "500 ミリ秒", "混雑したワールド向けです。1 周の時間は 100 ミリ秒の 5 倍かかります。"),
        new HoldOption(750, "750 ミリ秒", "とても混雑したワールド向けです。"),
        new HoldOption(1000, "1000 ミリ秒（1 秒）", "とても混雑したワールド向けです。1 周に 100 ミリ秒の 10 倍かかります。"),
    };

    HoldOption? selectedHold;
    public HoldOption? SelectedHold
    {
        get => selectedHold;
        set
        {
            if (!SetField(ref selectedHold, value) || value is null || applying) return;
            Run(new UiCommand.SetHold(value.Milliseconds));
        }
    }

    string holdText = "";
    public string HoldText { get => holdText; private set => SetField(ref holdText, value); }

    // 一覧に無い間隔（50〜3000 ミリ秒）。現地で試しながら決められるように、再ビルドせずに入れられる欄を置く
    string customHoldText = "";
    public string CustomHoldText { get => customHoldText; set => SetField(ref customHoldText, value); }

    public RelayCommand ApplyCustomHoldCommand => applyCustomHold ??= new RelayCommand(() =>
    {
        if (double.TryParse(CustomHoldText.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var ms))
            Run(new UiCommand.SetHold(ms));
        else Message = "送信の間隔はミリ秒の数字で入れてください（例：350）。";
    }, () => !string.IsNullOrWhiteSpace(CustomHoldText));
    RelayCommand? applyCustomHold;

    // 図形の数。アバターの上限より少なくすると、パケットが減って 1 周が短くなる（細部は粗くなる）。
    // 上限を超える値はアバターの上限で止まる
    public IReadOnlyList<PrimCountOption> PrimCountOptions { get; } = new[]
    {
        new PrimCountOption(null, "アバターの上限まで（おすすめ）"),
        new PrimCountOption(3000, "3000 個"),
        new PrimCountOption(2000, "2000 個"),
        new PrimCountOption(1000, "1000 個"),
        new PrimCountOption(500, "500 個"),
    };

    PrimCountOption? selectedPrimCount;
    public PrimCountOption? SelectedPrimCount
    {
        get => selectedPrimCount;
        set
        {
            if (!SetField(ref selectedPrimCount, value) || value is null || applying) return;
            Run(new UiCommand.SetPrimCount(value.Count));
        }
    }

    // ---- 履歴

    public ObservableCollection<HistoryOption> History { get; } = new();

    HistoryOption? selectedHistory;
    public HistoryOption? SelectedHistory { get => selectedHistory; set => SetField(ref selectedHistory, value); }

    public RelayCommand LoadHistoryCommand => loadHistory ??= new RelayCommand(() =>
    {
        if (SelectedHistory?.Entry is not { } e) return;
        if (e.Kind == SourceKind.Url) { UrlText = e.Value; Run(new UiCommand.LoadImageUrl(e.Value)); }
        else Run(new UiCommand.LoadImageFile(e.Value));
    }, () => !IsBusy && SelectedHistory is not null);
    RelayCommand? loadHistory;

    public RelayCommand ClearHistoryCommand => clearHistory ??= new RelayCommand(() => Run(new UiCommand.ClearHistory()), () => History.Count > 0);
    RelayCommand? clearHistory;

    // ---- 画像

    string urlText = "";
    public string UrlText { get => urlText; set => SetField(ref urlText, value); }

    // text to turn into a QR code. A QR code goes out in a handful of packets, so it is on the avatar in well under a
    // second, where a picture takes about 100 seconds (docs/research/09).
    string qrText = "";
    public string QrText { get => qrText; set => SetField(ref qrText, value); }

    bool isBusy;
    public bool IsBusy { get => isBusy; private set => SetField(ref isBusy, value); }

    // a QR code has no primitives to count and no aspect to fit, so those choices are only for a picture
    bool isPicture = true;
    public bool IsPicture { get => isPicture; private set => SetField(ref isPicture, value); }

    ImageSource? sourceImage;
    public ImageSource? SourceImage { get => sourceImage; private set => SetField(ref sourceImage, value); }

    string sourceText = "画像を選ぶか、URL を入れるか、ファイルをここへドラッグしてください。";
    public string SourceText { get => sourceText; private set => SetField(ref sourceText, value); }

    bool fitCrop;
    public bool FitStretch { get => !fitCrop; set { if (value) SetFit(false); } }
    public bool FitCrop { get => fitCrop; set { if (value) SetFit(true); } }

    void SetFit(bool crop)
    {
        if (fitCrop == crop) return;
        fitCrop = crop;
        OnPropertyChanged(nameof(FitStretch)); OnPropertyChanged(nameof(FitCrop));
        Run(new UiCommand.SetFit(crop ? FitMode.Crop : FitMode.Stretch));
    }

    // ---- 変換

    ImageSource? encodedImage;
    public ImageSource? EncodedImage { get => encodedImage; private set => SetField(ref encodedImage, value); }

    string encodeText = "画像を選ぶと、アバターで表示できる形（図形の集まり）に変換します。";
    public string EncodeText { get => encodeText; private set => SetField(ref encodeText, value); }

    double encodeProgress;
    public double EncodeProgress { get => encodeProgress; private set => SetField(ref encodeProgress, value); }

    bool isEncoding;
    public bool IsEncoding { get => isEncoding; private set => SetField(ref isEncoding, value); }

    // ---- 送信先

    public ObservableCollection<TargetOption> Targets { get; } = new();

    TargetOption? selectedTarget;
    public TargetOption? SelectedTarget
    {
        get => selectedTarget;
        set
        {
            if (!SetField(ref selectedTarget, value) || value is null || applying) return;
            Run(new UiCommand.SelectTarget(value.Name));
        }
    }

    string targetText = "送信先を探しています…";
    public string TargetText { get => targetText; private set => SetField(ref targetText, value); }

    bool isSearching;
    public bool IsSearching { get => isSearching; private set => SetField(ref isSearching, value); }

    // ---- 送信

    ScheduleOption? selectedSchedule;
    public ScheduleOption? SelectedSchedule
    {
        get => selectedSchedule;
        set
        {
            if (!SetField(ref selectedSchedule, value) || value is null || applying) return;
            Run(new UiCommand.SetSchedule(value.Name));
        }
    }

    bool isSending;
    public bool IsSending { get => isSending; private set { if (SetField(ref isSending, value)) OnPropertyChanged(nameof(StartStopText)); } }

    bool canStart;
    public bool CanStart { get => canStart; private set => SetField(ref canStart, value); }

    public string StartStopText => IsSending ? "送信を止める" : "送信を始める";

    string sendText = "変換が終わり、送信先が決まると送信を始められます。";
    public string SendText { get => sendText; private set => SetField(ref sendText, value); }

    double sendProgress;
    public double SendProgress { get => sendProgress; private set => SetField(ref sendProgress, value); }

    ImageSource? receivedImage;
    public ImageSource? ReceivedImage { get => receivedImage; private set => SetField(ref receivedImage, value); }

    string message = "";
    public string Message { get => message; private set { if (SetField(ref message, value)) OnPropertyChanged(nameof(HasMessage)); } }
    public bool HasMessage => Message.Length > 0;

    // ---- 操作

    async void Run(UiCommand command)
    {
        bool loads = command is UiCommand.LoadImageFile or UiCommand.LoadImageUrl or UiCommand.LoadImagePixels;
        if (loads) { IsBusy = true; Message = ""; }
        try
        {
            var result = await handler.ExecuteAsync(command);
            if (result is CommandResult.Failed failed) Message = failed.Message;
            else if (command is UiCommand.StartSending or UiCommand.LoadImageFile or UiCommand.LoadImageUrl) Message = "";
        }
        catch (Exception e) { Message = "予期しないエラーが起きました: " + e.Message; }
        finally { if (loads) IsBusy = false; CommandManager.InvalidateRequerySuggested(); }
    }

    void ChooseFile()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "送る画像を選ぶ",
            Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff;*.heic;*.avif|すべてのファイル|*.*",
        };
        if (dialog.ShowDialog() == true) Run(new UiCommand.LoadImageFile(dialog.FileName));
    }

    public void LoadDropped(string[] paths)
    {
        if (paths.Length > 0 && !IsBusy) Run(new UiCommand.LoadImageFile(paths[0]));
    }

    // a URL dragged from a browser (the image itself, or a link)
    public void LoadDroppedUrl(string url)
    {
        if (IsBusy) return;
        if (!url.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) UrlText = url;
        Run(new UiCommand.LoadImageUrl(url));
    }

    public void LoadDroppedBitmap(BitmapSource bitmap)
    {
        if (!IsBusy) Run(new UiCommand.LoadImagePixels(Services.WicImageDecoder.FromBitmapSource(bitmap), "ドラッグした画像"));
    }

    void Paste()
    {
        if (Clipboard.ContainsImage() && Clipboard.GetImage() is BitmapSource bmp)
            Run(new UiCommand.LoadImagePixels(Services.WicImageDecoder.FromBitmapSource(bmp), "クリップボードの画像"));
        else if (Clipboard.ContainsText() && Clipboard.GetText().Trim() is { } text && (text.StartsWith("http://") || text.StartsWith("https://")))
        {
            UrlText = text;
            Run(new UiCommand.LoadImageUrl(text));
        }
    }

    // ---- 状態を画面へ

    void OnSnapshot(SessionSnapshot snapshot)
    {
        // 送信中は 1 秒に数回届く。画面の更新が追いつかないときは最後の 1 つだけ当てる
        Interlocked.Exchange(ref pending, snapshot);
        if (Interlocked.Exchange(ref applyQueued, 1) == 1) return;
        RunOnUiThread(() =>
        {
            Interlocked.Exchange(ref applyQueued, 0);
            if (Interlocked.Exchange(ref pending, null) is { } latest) Apply(latest);
        });
    }

    bool applying;

    void Apply(SessionSnapshot s)
    {
        var old = applied;
        applied = s;
        applying = true;
        try
        {
            // 画像
            if (!ReferenceEquals(old?.Source, s.Source))
            {
                SourceImage = s.Source is { } src ? ToBitmap(src.Preview) : null;
                SourceText = s.Source is { } info ? $"{info.Name}（{info.Width} × {info.Height}）" : SourceText;
            }
            if (!ReferenceEquals(old?.History, s.History))
            {
                var keep = SelectedHistory?.Entry;
                History.Clear();
                foreach (var e in s.History) History.Add(new HistoryOption(e));
                SelectedHistory = History.FirstOrDefault(h => keep is not null && h.Entry.Kind == keep.Kind && h.Entry.Value == keep.Value) ?? History.FirstOrDefault();
            }

            if (old?.Fit != s.Fit) { fitCrop = s.Fit == FitMode.Crop; OnPropertyChanged(nameof(FitStretch)); OnPropertyChanged(nameof(FitCrop)); }

            // 変換
            if (!ReferenceEquals(old?.Encode, s.Encode) || old?.HoldMs != s.HoldMs)
            {
                IsEncoding = s.Encode is EncodeState.Running;
                switch (s.Encode)
                {
                    case EncodeState.Idle:
                        EncodedImage = null; EncodeProgress = 0;
                        break;
                    case EncodeState.Running r:
                        EncodeProgress = r.Total > 0 ? (double)r.Done / r.Total : 0;
                        EncodeText = $"図形に変換しています… {r.Done} / {r.Total}";
                        break;
                    case EncodeState.Ready ready:
                        var img = ready.Image;
                        if (!ReferenceEquals((old?.Encode as EncodeState.Ready)?.Image, img) || EncodedImage is null) EncodedImage = ToBitmap(img.Preview);
                        EncodeProgress = 1;
                        double lap = img.Units.Count * s.HoldMs / 1000;
                        IsPicture = !img.Qr;
                        string what = img.Qr ? $"QR コード（{(int)Math.Sqrt(img.Prims)} × {(int)Math.Sqrt(img.Prims)} 升）" : $"図形 {img.Prims} 個";
                        EncodeText = $"変換しました：{what}、{img.Units.Count} パケット（1 周 約 {FormatDuration(TimeSpan.FromSeconds(lap))}）。" +
                                     $"{img.Spec.DisplayName}・Int {img.Spec.Ints} 個のアバター向け{(img.Spec.Assumed ? "（アバターの種類が分からないため既定の設定）" : "")}";
                        break;
                    case EncodeState.Failed f:
                        EncodedImage = null; EncodeProgress = 0; EncodeText = f.Message;
                        break;
                }
            }

            // 送信先
            if (!ReferenceEquals(old?.Targets, s.Targets) || !ReferenceEquals(old?.Target, s.Target) || old?.SearchingTargets != s.SearchingTargets)
            {
                IsSearching = s.SearchingTargets;
                if (!ReferenceEquals(old?.Targets, s.Targets))
                {
                    Targets.Clear();
                    foreach (var c in s.Targets) Targets.Add(new TargetOption(c.Name, Describe(c), ParamroomSession.IsUsable(c)));
                }
                SelectedTarget = s.Target is { } t ? Targets.FirstOrDefault(o => o.Name == t.Name) : null;
                TargetText = s.SearchingTargets ? "送信先の VRChat を探しています…"
                    : s.Target is { } tt ? TargetDetail(tt)
                    : s.Targets.Count == 0 ? "VRChat が見つかりません。VRChat を起動して OSC を有効にし、Paramroom 入りのアバターを着てから「探し直す」を押してください。"
                    : s.Targets.Any(ParamroomSession.IsUsable) ? "送信先を選んでください。"
                    : "見つかった VRChat のアバターに Paramroom が入っていません。Paramroom 入りのアバターに着替えてから「探し直す」を押してください。";
            }

            if (old is null || old.PrimCount != s.PrimCount)
                SelectedPrimCount = PrimCountOptions.FirstOrDefault(o => o.Count == s.PrimCount);

            if (old?.HoldMs != s.HoldMs)
            {
                // 一覧に無い値は選択を外す（一覧に無い項目を選ばせると、コンボボックスは前の表示のまま残る）
                SelectedHold = HoldOptions.FirstOrDefault(o => o.Milliseconds == s.HoldMs);
                HoldText = SelectedHold is { } h ? h.Description : $"今の間隔は {s.HoldMs} ミリ秒（入力した値）です。1 周に 100 ミリ秒の {s.HoldMs / 100:0.#} 倍かかります。";
            }

            if (!ReferenceEquals(old?.Schedule, s.Schedule))
                SelectedSchedule = ScheduleOptions.FirstOrDefault(o => o.Name == s.Schedule) ?? new ScheduleOption(s.Schedule, s.Schedule, "");

            // 送信
            if (!ReferenceEquals(old?.Send, s.Send))
            {
                IsSending = s.Send is SendState.Active;
                switch (s.Send)
                {
                    case SendState.Idle:
                        ReceivedImage = null; SendProgress = 0;
                        SendText = "変換が終わり、送信先が決まると送信を始められます。";
                        break;
                    case SendState.Active a:
                        ShowProgress(a.Progress, old?.Send, sending: true);
                        break;
                    case SendState.Stopped st:
                        ShowProgress(st.Progress, old?.Send, sending: false);
                        break;
                    case SendState.Failed f:
                        SendText = f.Message;
                        break;
                }
            }
            CanStart = s.Encode is EncodeState.Ready && s.Target is not null;
        }
        finally { applying = false; }
        CommandManager.InvalidateRequerySuggested();
    }

    void ShowProgress(SendProgress p, SendState? oldSend, bool sending)
    {
        var oldPreview = oldSend switch { SendState.Active a => a.Progress.Received, SendState.Stopped st => st.Progress.Received, _ => null };
        if (!ReferenceEquals(oldPreview, p.Received)) ReceivedImage = p.Received is { } r ? ToBitmap(r) : null;
        SendProgress = p.TotalUnits > 0 ? (double)p.DistinctUnits / p.TotalUnits : 0;
        string head = sending ? $"送信中 {FormatDuration(p.Elapsed)}" : $"止めました（{FormatDuration(p.Elapsed)} 送信）";
        SendText = $"{head}・{p.PacketsSent} パケット・送った図形の種類 {p.DistinctUnits} / {p.TotalUnits}" +
                   (sending ? "" : "。アバターの表示は、最後に届いた状態のまま残ります。");
    }

    static string Describe(VrcClient c)
    {
        string where = $"VRChat（ポート {c.OscPort}）";
        if (!ParamroomSession.IsUsable(c)) return $"{where}：Paramroom なし";
        var spec = DecoderSpec.For(c);
        var note = spec.Unknown ? $"（形式 {spec.FormatId} は未対応）" : spec.Assumed ? "（種類不明）" : "";
        return $"{where}：{spec.DisplayName}・Int {spec.Ints} 個{note}";
    }

    static string TargetDetail(VrcClient c)
    {
        var spec = DecoderSpec.For(c);
        if (spec.Unknown)
            return $"送信先：VRChat（ポート {c.OscPort}）。アバターは形式 {spec.FormatId} と言っていますが、このアプリはそれを知りません（アプリのほうが古い可能性があります）。"
                 + $"512px・図形 4000 個として送りますが、絵は正しく出ません。";
        return spec.Assumed
            ? $"送信先：VRChat（ポート {c.OscPort}）。アバターの種類が読めないため、512px・図形 4000 個・Int {spec.Ints} 個として送ります。"
            : $"送信先：VRChat（ポート {c.OscPort}）。アバターは {spec.DisplayName}・Int {spec.Ints} 個に対応しています。";
    }

    static string FormatDuration(TimeSpan t) =>
        t.TotalMinutes >= 1 ? $"{(int)t.TotalMinutes} 分 {t.Seconds} 秒"
        : t.TotalSeconds >= 1 ? $"{t.Seconds} 秒"
        : $"{t.TotalSeconds:0.0} 秒";   // a QR code is well under a second, and "0 秒" reads like nothing happened

    static BitmapSource ToBitmap(Preview p)
    {
        var bmp = BitmapSource.Create(p.Width, p.Height, 96, 96, PixelFormats.Rgb24, null, p.Rgb, p.Width * 3);
        bmp.Freeze();
        return bmp;
    }
}
