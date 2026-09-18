using System.Text;
using ImagePad;
using ImagePad.Commands;
using ImagePad.Session;

namespace ImagePad.Core.Tests;

public class LayoutTests
{
    // the table the Unity builder offers (measure/unity/.../ImagePadPrimBuilder.cs GoodLayouts, sim/codecs/prim.js layout)
    [Theory]
    [InlineData(4000, 32, 10, 4, 3, 1001)]
    [InlineData(4000, 25, 11, 3, 2, 1334)]
    [InlineData(4000, 18, 11, 2, 1, 2001)]
    [InlineData(4000, 10, 12, 1, 0, 4001)]
    [InlineData(2000, 17, 10, 2, 1, 1001)]
    [InlineData(1000, 32, 8, 4, 3, 251)]
    public void MatchesTheBuilderTable(int prims, int ints, int u, int k, int k0, int units)
    {
        var L = PrimLayout.Of(new PrimConfig { R = 512, MaxPrims = prims }, 8 * ints - 2);
        Assert.Equal((u, k, k0, units), (L.U, L.K, L.K0, L.Units));
        Assert.True(L.SpareBits >= 8, "room for the aspect byte");
    }

    [Fact]
    public void FewerPrimitivesKeepTheDecoderLayout()
    {
        var full = PrimLayout.Of(new PrimConfig { MaxPrims = 4000 }, 254);
        var fewer = PrimLayout.Of(new PrimConfig { MaxPrims = 2000, LayoutPrims = 4000 }, 254);
        Assert.Equal((full.U, full.K, full.K0), (fewer.U, fewer.K, fewer.K0));
    }
}

public class AspectAndPacketTests
{
    [Theory]
    [InlineData(1, 1, 128)]
    [InlineData(16, 9, 181)]
    [InlineData(3, 2, 165)]
    [InlineData(9, 16, 75)]
    public void AspectCodesMatchTheJsEncoder(int w, int h, int code) => Assert.Equal(code, Aspect.Code(w, h));

    [Fact]
    public void PacketCarriesEpochUnitAndAspectInTheLastByte()
    {
        var unit = new bool[8 * 25 - 2];
        unit[0] = true; // first bit after the epoch
        var p = Packets.Build(new[] { unit }, epoch: 2, aspect: 181, nBytes: 25)[0];
        Assert.Equal(25, p.Length);
        Assert.Equal(0b1010_0000, p[0]);   // epoch 10, then the unit's first bit
        Assert.Equal(181, p[24]);
    }
}

public class ScheduleTests
{
    static double[] Gains(int n) => Enumerable.Range(0, n).Select(i => i == 0 ? double.PositiveInfinity : 1000.0 / (i + 1)).ToArray();

    [Fact]
    public void FastSendsEveryUnitOnceFirst()
    {
        var s = Schedules.Create("fast", Gains(50))!;
        Assert.Equal(Enumerable.Range(0, 50), Enumerable.Range(0, 50).Select(s));
    }

    [Fact]
    public void FastWithSqrtFillerGivesEveryEighthSlotToTheFiller()
    {
        var s = Schedules.Create("fast+sqrt/8", Gains(100))!;
        var firstPass = Enumerable.Range(0, 120).Select(s).ToList();
        var nonFiller = firstPass.Where((_, slot) => slot % 8 != 7).Take(100);
        Assert.Equal(Enumerable.Range(0, 100), nonFiller);
    }

    [Fact]
    public void UnknownNameIsRejected() => Assert.Null(Schedules.Create("fastest", Gains(4)));
}

public class RendererTests
{
    static Img TestImage(int w, int h)
    {
        var img = new Img(w, h);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 3;
                bool disc = (x - w / 2) * (x - w / 2) + (y - h / 3) * (y - h / 3) < w * w / 16;
                img.Data[i] = disc ? 230 : 255.0 * x / w;
                img.Data[i + 1] = disc ? 40 : 255.0 * y / h;
                img.Data[i + 2] = 90;
            }
        return img;
    }

    [Fact]
    public void RenderOfAllUnitsEqualsTheEncoderCanvas()
    {
        var cfg = new PrimConfig { R = 256, MaxPrims = 80 };
        var res = new PrimEncoder(cfg, TestImage(256, 256)).Encode(254);
        var rendered = PrimRenderer.Render(cfg, res.Layout, res.Units.Select(u => (bool[]?)u).ToList());
        int maxDiff = rendered.Select((v, i) => Math.Abs(v - (int)Math.Floor(res.Canvas[i] + 0.5))).Max();
        Assert.True(maxDiff <= 1, $"max diff {maxDiff}");
    }

    [Fact]
    public void MissingUnitsAreSkippedAndBackgroundIsGreyWithoutUnitZero()
    {
        var cfg = new PrimConfig { R = 256, MaxPrims = 20 };
        var res = new PrimEncoder(cfg, TestImage(256, 256)).Encode(254);
        var none = PrimRenderer.Render(cfg, res.Layout, new bool[]?[res.Units.Count]);
        Assert.All(none, v => Assert.Equal(128, v));
    }
}

public class SessionTests
{
    sealed class FakeFinder(params VrcClient[] clients) : ITargetFinder
    {
        public Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<VrcClient>>(clients);
    }

    sealed class CaptureTransport : IOscTransport
    {
        public readonly List<byte[]> Sent = new();
        public void Send(byte[] datagram) { lock (Sent) Sent.Add(datagram); }
        public void Dispose() { }
    }

    static async Task WaitFor(Func<bool> condition, int timeoutMs = 20000, Func<string>? describe = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!condition()) { if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException(describe?.Invoke()); await Task.Delay(10); }
    }

    // OSC bundle -> (address, int value) messages
    static List<(string, int)> Parse(byte[] b)
    {
        string Str(ref int o) { int e = o; while (b[e] != 0) e++; var s = Encoding.ASCII.GetString(b, o, e - o); o = (e + 4) & ~3; return s; }
        int BE(int o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        var list = new List<(string, int)>();
        int off = 0;
        Assert.Equal("#bundle", Str(ref off));
        off += 8;
        while (off < b.Length)
        {
            int size = BE(off); off += 4; int m = off;
            var addr = Str(ref m); Str(ref m);
            list.Add((addr, BE(m)));
            off += size;
        }
        return list;
    }

    [Fact]
    public async Task EncodesForTheFoundAvatarAndSendsItsPacketSize()
    {
        var client = new VrcClient("VRChat-Client-TEST", "127.0.0.1", 9000, "avtr_test", 25, 3, null);
        var transport = new CaptureTransport();
        await using var session = new ImagePadSession(new FakeFinder(client), _ => transport, new StbImageDecoder(), new HttpImageFetcher(),
            new SessionOptions { HoldMs = 2, EncodePrimsLimit = 40, ProgressInterval = TimeSpan.FromMilliseconds(10), ReceivedPreviewInterval = TimeSpan.FromMilliseconds(20) });
        var handler = new CommandHandler(session);

        Assert.IsType<CommandResult.Failed>(await handler.ExecuteAsync(new UiCommand.StartSending()));

        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.RefreshTargets()));
        Assert.Equal(client, session.Snapshot.Target);
        var image = new Img(320, 180);
        for (int i = 0; i < image.Data.Length; i++) image.Data[i] = i % 7 * 30;
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.LoadImagePixels(image, "test.png")));
        await WaitFor(() => session.Snapshot.Encode is EncodeState.Ready);
        var ready = (EncodeState.Ready)session.Snapshot.Encode;
        Assert.Equal(25, ready.Image.Spec.Ints);
        Assert.Equal(Aspect.Code(16, 9), ready.Image.Aspect);
        // the preview uses the transmitted (quantized) aspect ratio, as the avatar does: code 181 = 1.7836 -> 512 x 287
        Assert.Equal((512, 287), (ready.Image.Preview.Width, ready.Image.Preview.Height));

        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.StartSending()));
        await WaitFor(() => session.Snapshot.Send is SendState.Active { Progress.Received: not null } && transport.Sent.Count > 30, describe: () => $"{session.Snapshot.Send} sent={transport.Sent.Count}");
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.StopSending()));

        var stopped = Assert.IsType<SendState.Stopped>(session.Snapshot.Send);
        Assert.Equal(1, stopped.Progress.Epoch);
        Assert.True(stopped.Progress.DistinctUnits > 0);
        byte[] first;
        lock (transport.Sent) first = transport.Sent[0];
        var messages = Parse(first);
        Assert.Equal(25, messages.Count);
        Assert.Equal("/avatar/parameters/D24", messages[24].Item1);
        Assert.Equal(ready.Image.Aspect, messages[24].Item2);
        Assert.Equal(1, messages[0].Item2 >> 6); // epoch 1
    }

    [Fact]
    public async Task UnreadableBytesGiveAMessageInsteadOfAnException()
    {
        await using var session = new ImagePadSession(new FakeFinder(), _ => new CaptureTransport(), new StbImageDecoder(), new HttpImageFetcher());
        var path = Path.GetTempFileName();
        await File.WriteAllTextAsync(path, "not an image");
        try
        {
            var result = await new CommandHandler(session).ExecuteAsync(new UiCommand.LoadImageFile(path));
            Assert.Contains("画像として読めません", Assert.IsType<CommandResult.Failed>(result).Message);
        }
        finally { File.Delete(path); }
    }
}

public class HoldTests
{
    sealed class NoFinder : ITargetFinder
    {
        public Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<VrcClient>>(Array.Empty<VrcClient>());
    }

    [Fact]
    public async Task IntervalIsValidatedAndPublished()
    {
        await using var session = new ImagePadSession(new NoFinder(), _ => throw new InvalidOperationException(), new StbImageDecoder(), new HttpImageFetcher());
        var handler = new CommandHandler(session);
        Assert.Equal(100, session.Snapshot.HoldMs);
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.SetHold(150)));
        Assert.Equal(150, session.Snapshot.HoldMs);
        Assert.IsType<CommandResult.Failed>(await handler.ExecuteAsync(new UiCommand.SetHold(10)));
        Assert.Equal(150, session.Snapshot.HoldMs);
    }
}

public class FormatTests
{
    // must match ImagePadPrimBuilder.Formats / GoodLayouts in the Unity project
    [Theory]
    [InlineData(4, 32, 5, 801)]
    [InlineData(4, 26, 4, 1001)]
    [InlineData(5, 32, 5, 1001)]
    [InlineData(5, 27, 4, 1251)]
    public void LightFormatsPackMorePrimitives(int formatId, int ints, int k, int units)
    {
        var f = DecoderFormat.Known[formatId];
        Assert.Equal(47, f.PrimBits);
        var L = PrimLayout.Of(f.Config(f.N), 8 * ints - 2);
        Assert.Equal((k, units), (L.K, L.Units));
        Assert.True(L.SpareBits >= 8);
    }

    // format 6 (1024 canvas): the coordinates take 10 bits and the angle 5, which leaves the packet exactly the 8
    // spare bits the aspect code needs. One bit more anywhere and the aspect code no longer fits, so this is checked.
    [Theory]
    [InlineData(32, 4, 1001)]
    [InlineData(25, 3, 1334)]
    [InlineData(18, 2, 2001)]
    [InlineData(11, 1, 4001)]
    public void BigFormatKeepsRoomForTheAspectCode(int ints, int k, int units)
    {
        var f = DecoderFormat.Known[6];
        Assert.Equal((1024, 10, 5), (f.R, f.Cb, f.Ab));
        Assert.Equal(59, f.PrimBits);
        var L = PrimLayout.Of(f.Config(f.N), 8 * ints - 2);
        Assert.Equal((k, units), (L.K, L.Units));
        Assert.True(L.SpareBits >= 8, $"{ints} Int: spare {L.SpareBits}");
    }

    // the Int counts an error message may suggest have to be the ones that actually work for that format
    [Theory]
    [InlineData(3, new[] { 10, 18, 25, 32 })]
    [InlineData(4, new[] { 9, 15, 21, 26, 32 })]
    [InlineData(5, new[] { 9, 15, 21, 27, 32 })]
    [InlineData(6, new[] { 11, 18, 25, 32 })]
    public void GoodIntCountsMatchThePrefabBuilder(int formatId, int[] expected) =>
        Assert.Equal(expected, DecoderFormat.Known[formatId].GoodIntCounts().ToArray());

    // an avatar newer than this build must be reported, not silently treated as format 3
    // The QR mode shares the packets with the picture mode; these check the packing the shader relies on.
    [Fact]
    public void QrFitsInAFewPackets()
    {
        var f = DecoderFormat.Known[3];
        var L = PrimLayout.Of(f.Config(f.N), 254);
        var qr = QrMode.Build("https://example.com/abc");
        Assert.Equal(25, qr.Modules);                       // version 2
        Assert.Equal(3, QrMode.UnitsNeeded(L, qr.Modules)); // 625 bits at 58 bits per slot
        var units = QrMode.Encode(qr, L, 254);
        Assert.Equal(3, units.Count);
        // unit 0 carries the module count in the 16-bit header the picture mode uses for the background colour
        int n = 0;
        for (int i = 0; i < 8; i++) n = (n << 1) | (units[0][L.U + i] ? 1 : 0);
        Assert.Equal(25, n);
        // the first module bit sits right after the header (a QR code always starts with a black finder module)
        Assert.True(units[0][L.U + 16]);
    }

    [Fact]
    public void QrModeBitRidesInEveryPacket()
    {
        var f = DecoderFormat.Known[3];
        var L = PrimLayout.Of(f.Config(f.N), 254);
        var units = QrMode.Encode(QrMode.Build("https://example.com/abc"), L, 254);
        foreach (var p in Packets.Build(units, 1, 128, 32, qr: true))
        {
            Assert.Equal(128, p[31]);            // aspect code still in the last byte
            Assert.Equal(1, p[30] & 1);          // mode bit is the one before it (bit 247 = lowest bit of byte 30)
        }
        foreach (var p in Packets.Build(units, 1, 128, 32, qr: false))
            Assert.Equal(0, p[30] & 1);
    }

    // a picture with too many pixels must be refused with a message, not end as an out-of-memory error
    [Fact]
    public void HugeImagesAreRefused()
    {
        var e = Assert.Throws<InvalidOperationException>(() => Img.CheckSize(12000, 12000));
        Assert.Contains("大きすぎます", e.Message);
        Img.CheckSize(4000, 4000);   // 16 Mpx is fine
    }

    [Fact]
    public void UnknownFormatIsFlagged()
    {
        var spec = ImagePad.Session.DecoderSpec.For(new VrcClient("c", "127.0.0.1", 9000, null, 32, 99, null));
        Assert.True(spec.Unknown);
        Assert.Equal(99, spec.FormatId);
    }

    [Fact]
    public void SpecFollowsTheAvatarFormat()
    {
        var client = new VrcClient("c", "127.0.0.1", 9000, null, 26, 4, null);
        var spec = ImagePad.Session.DecoderSpec.For(client);
        Assert.Equal(8, spec.Format.Cb);
        Assert.False(spec.SameLayout(ImagePad.Session.DecoderSpec.For(client with { Format = 3 })));
    }
}

public class PrimCountTests
{
    sealed class OneClient : ITargetFinder
    {
        public Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<VrcClient>>(new[] { new VrcClient("c", "127.0.0.1", 9000, null, 32, 3, null) });
    }

    [Fact]
    public async Task FewerPrimitivesMeanFewerUnitsWithTheSameLayout()
    {
        await using var session = new ImagePadSession(new OneClient(), _ => throw new InvalidOperationException(), new StbImageDecoder(), new HttpImageFetcher());
        var handler = new CommandHandler(session);
        await handler.ExecuteAsync(new UiCommand.RefreshTargets());
        Assert.IsType<CommandResult.Failed>(await handler.ExecuteAsync(new UiCommand.SetPrimCount(10)));
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.SetPrimCount(200)));
        var image = new Img(256, 256);
        for (int i = 0; i < image.Data.Length; i++) image.Data[i] = (i * 37) % 251;
        await handler.ExecuteAsync(new UiCommand.LoadImagePixels(image, "t"));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (session.Snapshot.Encode is not EncodeState.Ready && sw.ElapsedMilliseconds < 20000) await Task.Delay(10);
        var ready = Assert.IsType<EncodeState.Ready>(session.Snapshot.Encode);
        Assert.Equal(200, ready.Image.RequestedPrims);
        Assert.True(ready.Image.Units.Count <= 1 + (200 - 3 + 3) / 4, $"{ready.Image.Units.Count} units");
        Assert.Equal(10, ready.Image.Layout.U); // still the 4000-primitive decoder's unit ids
    }
}

public class DropAndHistoryTests
{
    [Fact]
    public void ImageUrlComesFromTheImgTagNotTheLinkAround()
    {
        // what Chromium puts as "HTML Format" when a linked picture is dragged (header trimmed)
        const string html = "<html><body><!--StartFragment--><a href=\"https://example.com/page\"><img src=\"https://cdn.example.com/a/b.png?x=1&amp;y=2\" alt=\"x\"></a><!--EndFragment--></body></html>";
        Assert.Equal("https://cdn.example.com/a/b.png?x=1&y=2", DropParsing.ImageUrlFromHtml(html));
        Assert.Null(DropParsing.ImageUrlFromHtml("<p>no picture</p>"));
        Assert.Null(DropParsing.ImageUrlFromHtml("<img src=\"/relative.png\">"));
    }

    [Fact]
    public void UrlTextAndDataUris()
    {
        Assert.Equal("https://example.com/i.jpg", DropParsing.UrlFromText("https://example.com/i.jpg\nTitle"));
        Assert.Null(DropParsing.UrlFromText("hello"));
        Assert.Equal(new byte[] { 1, 2, 3 }, DropParsing.BytesFromDataUri("data:image/png;base64,AQID"));
        Assert.Null(DropParsing.BytesFromDataUri("data:image/svg+xml,<svg/>"));
    }

    [Fact]
    public void HistoryKeepsTenNewestWithoutDuplicates()
    {
        IReadOnlyList<HistoryEntry> h = Array.Empty<HistoryEntry>();
        for (int i = 0; i < 12; i++) h = HistoryRules.Add(h, new HistoryEntry(SourceKind.Url, $"https://e/{i}.png", $"{i}.png", DateTimeOffset.Now));
        h = HistoryRules.Add(h, new HistoryEntry(SourceKind.Url, "https://e/5.png", "5.png", DateTimeOffset.Now));
        Assert.Equal(10, h.Count);
        Assert.Equal("https://e/5.png", h[0].Value);
        Assert.Single(h, e => e.Value == "https://e/5.png");
    }

    [Fact]
    public async Task LoadedFilesAreRememberedAndSaved()
    {
        var dir = Path.Combine(Path.GetTempPath(), "imagepad-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var png = Path.Combine(dir, "a.png");
            var pixels = new byte[4 * 4 * 3];
            PngWriter.WriteRgb(png, pixels, 4, 4);
            var store = new JsonFileHistory(Path.Combine(dir, "history.json"));
            await using (var session = new ImagePadSession(new FixedTargetFinder(new VrcClient("c", "127.0.0.1", 1, null, 32, 3, null)), _ => throw new InvalidOperationException(), new StbImageDecoder(), new HttpImageFetcher(), new SessionOptions { EncodePrimsLimit = 50 }, store))
            {
                Assert.IsType<CommandResult.Done>(await new CommandHandler(session).ExecuteAsync(new UiCommand.LoadImageFile(png)));
                Assert.Equal(png, session.Snapshot.History[0].Value);
            }
            await using var reopened = new ImagePadSession(new FixedTargetFinder(new VrcClient("c", "127.0.0.1", 1, null, 32, 3, null)), _ => throw new InvalidOperationException(), new StbImageDecoder(), new HttpImageFetcher(), history: store);
            Assert.Equal("a.png", Assert.Single(reopened.Snapshot.History).Name);
        }
        finally { Directory.Delete(dir, true); }
    }
}
