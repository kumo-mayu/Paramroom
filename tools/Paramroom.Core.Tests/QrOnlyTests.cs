using Net.Codecrete.QrCodeGenerator;
using Paramroom;

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
