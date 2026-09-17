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
