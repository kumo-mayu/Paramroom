using Net.Codecrete.QrCodeGenerator;
using Paramroom;
using Paramroom.Commands;
using Paramroom.Session;

namespace Paramroom.Core.Tests;

// QR 専用モード（docs/research/09 §6）。参照実装は sim/codecs/qronly.js で、
// 同じマス目を入れれば同じパケットが出ることを突き合わせ済み（2026-09-18）。
public class QrOnlyTests
{
    // docs/research/09 §6 の表と同じ割り付けになること（プレハブに焼き込む値なので固定しておく）
    [Theory]
    [InlineData(3, 8, 14, 219)]
    [InlineData(4, 8, 22, 140)]
    [InlineData(5, 7, 31, 99)]
    [InlineData(6, 7, 39, 79)]
    [InlineData(8, 6, 56, 55)]
    [InlineData(16, 5, 121, 26)]
    [InlineData(32, 4, 250, 13)]
    public void TheLayoutIsWhatTheDocumentSays(int bytes, int u, int pay, int maxUnits)
    {
        var L = QrOnly.LayoutFor(bytes);
        Assert.NotNull(L);
        Assert.Equal(u, L.U);
        Assert.Equal(pay, L.Pay);
        Assert.Equal(pay - QrOnly.Head, L.First);
        Assert.Equal(maxUnits, L.MaxUnits);
    }

    [Fact]
    public void TooFewIntsHaveNoLayout()
    {
        Assert.Null(QrOnly.LayoutFor(1));
        Assert.Null(QrOnly.LayoutFor(2));
    }

    // 送ったものを受信側と同じ描き方で描き直すと、元の QR のマス目にそのまま戻る。
    // 三隅の切り出しパターンは送っていないので、これは「受信側が描いた模様が正しい」ことも見ている。
    [Theory]
    [InlineData(3, "a")]
    [InlineData(4, "https://kumo-mayu.booth.pm")]
    [InlineData(6, "https://x.com/kumo_mayu/status/1234567890123456789")]
    [InlineData(8, "hello world 12345")]
    [InlineData(32, "https://pbs.twimg.com/media/ABCDEFGHIJKLMNOPQR?format=jpg&name=large")]
    public void WhatTheDecoderDrawsIsTheOriginalCode(int bytes, string text)
    {
        var L = QrOnly.LayoutFor(bytes)!;
        var code = QrOnly.Build(text);
        var units = QrOnly.Encode(code, L);
        var r = new QrOnlyRenderer(L);
        foreach (var u in units) r.Apply(u);

        const int quiet = 4;
        var (side, px) = r.Render(quiet);
        int n = code.Modules;
        Assert.Equal(n + 2 * quiet, side);
        var qr = QrCode.EncodeText(text, QrCode.Ecc.Medium);
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
                Assert.Equal(qr.GetModule(x, y), px[(quiet + y) * side + quiet + x] == 0);
        // 余白は白のまま
        for (int i = 0; i < side; i++) Assert.Equal(255, px[i]);
    }

    // 届いていないパケットのマスは白。切り出しパターンは最初から出ている（版さえ分かれば描けるので）
    [Fact]
    public void MissingPacketsLeaveTheirCellsWhiteButTheCornersAreDrawn()
    {
        var L = QrOnly.LayoutFor(4)!;
        var code = QrOnly.Build("https://kumo-mayu.booth.pm");
        var units = QrOnly.Encode(code, L);
        Assert.True(units.Count > 3);

        var r = new QrOnlyRenderer(L);
        r.Apply(units[0]);                     // 版が分かるのは先頭パケットだけ
        const int quiet = 4;
        var (side, px) = r.Render(quiet);
        int n = code.Modules;
        bool Black(int x, int y) => px[(quiet + y) * side + quiet + x] == 0;

        Assert.True(Black(0, 0));              // 左上の切り出しパターンの角
        Assert.False(Black(7, 7));             // 分離帯は白
        Assert.True(Black(n - 1, 0));          // 右上
        Assert.True(Black(0, n - 1));          // 左下

        // 最後のパケットに入っているマスは、まだ全部白
        int last = 0;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                if (QrOnly.Skipped(n, x, y)) continue;
                int j = y * n + x - QrOnly.SkippedBefore(n, x, y);
                int id = j < L.First ? 0 : 1 + (j - L.First) / L.Pay;
                if (id != units.Count - 1) continue;
                last++;
                Assert.False(Black(x, y));
            }
        Assert.True(last > 0);
    }

    [Fact]
    public void ALongTextIsRefusedWithAReadableMessage()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => QrOnly.Build(new string('a', 400)));
        Assert.Contains("QR 専用モード", ex.Message);
    }

    // 除外したマスの数は版によらず 192（8x8 が 3 つ）で、閉じた式の数え方が総当たりと一致すること
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(5)]
    [InlineData(10)]
    public void TheClosedFormCountOfSkippedCellsMatchesCountingThemOneByOne(int version)
    {
        int n = QrOnly.SideOf(version);
        int seen = 0;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                Assert.Equal(seen, QrOnly.SkippedBefore(n, x, y));
                if (QrOnly.Skipped(n, x, y)) seen++;
            }
        Assert.Equal(3 * 8 * 8, seen);
        Assert.Equal(n * n - seen, QrOnly.CellCount(n));
    }
}

// QR 専用のアバター相手に、セッションが何を作り何を見せるか（docs/research/09 §6）
public class QrOnlySessionTests
{
    sealed class OneTarget(VrcClient c) : ITargetFinder
    {
        public Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<VrcClient>>(new[] { c });
    }
    sealed class Capture : IOscTransport
    {
        public readonly List<byte[]> Sent = new();
        public void Send(byte[] d) { lock (Sent) Sent.Add(d); }
        public void Dispose() { }
    }
    static async Task WaitFor(Func<bool> cond, int timeoutMs = 20000, Func<string>? describe = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!cond()) { if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException(describe?.Invoke()); await Task.Delay(10); }
    }
    static VrcClient QrOnlyTarget(int ints) => new("VRChat-Client-TEST", "127.0.0.1", 9000, "avtr_test", ints, DecoderFormat.QrOnlyId, null);

    // 升目の絵をなめらかに拡大するとぼやけて、画面上で読めなくなる。白と黒だけであることを見る。
    [Theory]
    [InlineData(3)]
    [InlineData(16)]
    public async Task ThePreviewOfAQrStaysBlackAndWhite(int ints)
    {
        var transport = new Capture();
        await using var session = new ParamroomSession(new OneTarget(QrOnlyTarget(ints)), _ => transport, new StbImageDecoder(), new HttpImageFetcher());
        var handler = new CommandHandler(session);
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.RefreshTargets()));
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.LoadQrText("https://kumo-mayu.booth.pm")));
        await WaitFor(() => session.Snapshot.Encode is EncodeState.Ready, describe: () => session.Snapshot.Encode.ToString()!);

        var image = ((EncodeState.Ready)session.Snapshot.Encode).Image;
        Assert.True(image.Spec.IsQrOnly);
        Assert.NotNull(image.QrOnlyLayout);          // 図形用の Layout ではなく、こちらで描くこと
        Assert.Equal("QR 専用", image.Spec.DisplayName);
        Assert.DoesNotContain(image.Preview.Rgb, b => b != 0 && b != 255);
    }

    // 受け取った人の見え方は、QR 専用の升目で描かれていないといけない（図形用の描き方だと絵にならない）
    [Fact]
    public async Task TheReceivedPreviewIsDrawnAsTheQrGrid()
    {
        var transport = new Capture();
        await using var session = new ParamroomSession(new OneTarget(QrOnlyTarget(3)), _ => transport, new StbImageDecoder(), new HttpImageFetcher(),
            new SessionOptions { HoldMs = 2, ProgressInterval = TimeSpan.FromMilliseconds(10), ReceivedPreviewInterval = TimeSpan.FromMilliseconds(10) });
        var handler = new CommandHandler(session);
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.RefreshTargets()));
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.LoadQrText("https://kumo-mayu.booth.pm")));
        await WaitFor(() => session.Snapshot.Encode is EncodeState.Ready);
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.StartSending()));
        await WaitFor(() => session.Snapshot.Send is SendState.Active { Progress.Received: not null }, describe: () => session.Snapshot.Send.ToString()!);
        var received = ((SendState.Active)session.Snapshot.Send).Progress.Received!;
        Assert.IsType<CommandResult.Done>(await handler.ExecuteAsync(new UiCommand.StopSending()));

        Assert.DoesNotContain(received.Rgb, b => b != 0 && b != 255);

        // 25x25 の QR ＋ 余白 4 の升目の絵であること。図形用の 512px の絵なら、こうはならない。
        int side = received.Width, cells = 25 + 8;
        Assert.Equal(side, received.Height);
        byte At(int cx, int cy) => received.Rgb[((int)((cy + 0.5) * side / cells) * side + (int)((cx + 0.5) * side / cells)) * 3];

        // 切り出しパターンは最初のパケットから出ている（受信側が描くので）
        Assert.Equal(0, At(4, 4));            // 左上の切り出しパターンの中（余白 4 ＋ 模様の中心）
        Assert.Equal(255, At(11, 4));         // 分離帯は白
        Assert.Equal(0, At(4, cells - 5));    // 左下
        Assert.Equal(0, At(cells - 5, 4));    // 右上
        for (int c = 0; c < cells; c++)
        {
            Assert.Equal(255, At(c, 0));      // 余白（上端）は白
            Assert.Equal(255, At(0, c));      // 余白（左端）は白
        }

        // 1 行あたりの色の変わり目が升目の数を超えない＝升目のまま拡大されている
        for (int cy = 0; cy < cells; cy++)
        {
            int y = (int)((cy + 0.5) * side / cells), changes = 0;
            for (int x = 1; x < side; x++) if (received.Rgb[(y * side + x) * 3] != received.Rgb[(y * side + x - 1) * 3]) changes++;
            Assert.True(changes < cells, $"{cy} 行目の色の変わり目が {changes} 回（升目 {cells} 個より多い）");
        }
    }
}
