// QR 専用モード（docs/research/09 §6、詰め方 A+）。参照実装は sim/codecs/qronly.js。
//
// 画像モードの割り付け（図形 1 個ぶんの枠）を借りないので、Int が少なくても成立する。
//   [epoch 2][ユニット番号 u][中身]
//   ユニット 0 の中身 = [版 6][マス...]   ユニット i の中身 = [マス...]
// 中身は 1 bit = 1 マス。ただし三隅の切り出しパターンと分離帯（8x8 を 3 つ = 192 マス）は送らない。
// あの模様は版によらず同じなので受信側が描く。行優先で数えた「前にある除外マス数」が閉じた式で出るため、
// シェーダ側の添字の計算も足し算で済む。
//
// u（ユニット番号の bit 数）は対応する最大の版で決まる。プレハブに焼き込む値なので、
// 小さい QR を送るときは少し無駄になるが、そのぶん版を選ばず同じプレハブで送れる。
using Net.Codecrete.QrCodeGenerator;

namespace Paramroom;

public static class QrOnly
{
    public const int Head = 6;          // 版（1..40 を 0..39 として 6 bit）
    public const int MaxVersion = 10;   // 57x57。これ以上は表示板の解像度でもカメラでも実用外
    public const int Corner = 8;        // 切り出しパターン 7x7 ＋ 分離帯 1
    public const int MinBytes = 3;      // これ未満では先頭パケットにヘッダが入らない
    public const int MaxBytes = 16;     // シェーダが読むのは _P0.._P15

    public static int SideOf(int version) => 17 + 4 * version;
    public static int CellCount(int n) => n * n - 3 * Corner * Corner;

    public static bool Skipped(int n, int x, int y) =>
        (y < Corner && (x < Corner || x >= n - Corner)) || (y >= n - Corner && x < Corner);

    // 行優先で (x,y) より前にある除外マスの数
    public static int SkippedBefore(int n, int x, int y)
    {
        int s;
        if (y < Corner) s = 16 * y;
        else if (y < n - Corner) s = 16 * Corner;
        else s = 16 * Corner + Corner * (y - (n - Corner));
        if (y < Corner) s += Math.Min(x, Corner) + Math.Max(0, x - (n - Corner));
        else if (y >= n - Corner) s += Math.Min(x, Corner);
        return s;
    }

    // 切り出しパターン（分離帯を含む 8x8）。true = 黒
    public static bool Finder(int n, int x, int y)
    {
        int u, v;
        if (y < Corner && x < Corner) { u = x; v = y; }
        else if (y < Corner) { u = x - (n - 7); v = y; }
        else { u = x; v = y - (n - 7); }
        if (u < 0 || u > 6 || v < 0 || v > 6) return false;      // 分離帯は白
        return u == 0 || u == 6 || v == 0 || v == 6 || (u >= 2 && u <= 4 && v >= 2 && v <= 4);
    }

    public sealed record Layout(int Bytes, int P, int U, int Pay, int First, int MaxUnits);

    public static Layout? LayoutFor(int bytes, int maxVersion = MaxVersion)
    {
        int P = 8 * bytes - 2, maxCells = CellCount(SideOf(maxVersion));
        for (int u = 1; u <= 12; u++)
        {
            int pay = P - u;
            if (pay <= Head) continue;
            int first = pay - Head;
            int maxUnits = 1 + (int)Math.Ceiling((maxCells - first) / (double)pay);
            if (maxUnits <= (1 << u)) return new Layout(bytes, P, u, pay, first, maxUnits);
        }
        return null;
    }

    public static int UnitsNeeded(Layout L, int n)
    {
        int cells = CellCount(n);
        return cells <= L.First ? 1 : 1 + (int)Math.Ceiling((cells - L.First) / (double)L.Pay);
    }

    public sealed record Code(int Modules, int Version, bool[] Cells, string Text);

    // 文字列から QR を作り、送るマスだけを行優先で並べる
    public static Code Build(string text, QrCode.Ecc? ecc = null)
    {
        if (string.IsNullOrEmpty(text)) throw new ArgumentException("text is empty");
        var qr = QrCode.EncodeText(text, ecc ?? QrCode.Ecc.Medium);
        int n = qr.Size, v = (n - 17) / 4;
        if (v > MaxVersion)
            throw new InvalidOperationException($"QR が大きすぎます（{n}x{n}、版 {v}）。QR 専用モードは版 {MaxVersion}（{SideOf(MaxVersion)}x{SideOf(MaxVersion)}）までです。文字列を短くしてください。");
        var cells = new List<bool>(CellCount(n));
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
                if (!Skipped(n, x, y)) cells.Add(qr.GetModule(x, y));
        return new Code(n, v, cells.ToArray(), text);
    }

    public static List<bool[]> Encode(Code code, Layout L)
    {
        int need = UnitsNeeded(L, code.Modules);
        if (need > L.MaxUnits)
            throw new InvalidOperationException($"QR {code.Modules}x{code.Modules} には {need} パケット要りますが、このアバターは {L.MaxUnits} までです。");
        var units = new List<bool[]>(need);
        int j = 0;
        for (int id = 0; id < need; id++)
        {
            var u = new bool[L.P];
            int o = 0;
            for (int b = L.U - 1; b >= 0; b--) u[o++] = ((id >> b) & 1) == 1;
            if (id == 0) for (int b = Head - 1; b >= 0; b--) u[o++] = (((code.Version - 1) >> b) & 1) == 1;
            int room = id == 0 ? L.First : L.Pay;
            for (int i = 0; i < room && j < code.Cells.Length; i++) u[o++] = code.Cells[j++];
            units.Add(u);
        }
        return units;
    }
}

// 送ったものを確かめるための、受信側と同じ描き方（1 マス 1 画素、余白付き）
public sealed class QrOnlyRenderer
{
    readonly QrOnly.Layout L;
    readonly Dictionary<int, bool[]> have = new();
    int version;

    public QrOnlyRenderer(QrOnly.Layout layout) => L = layout;

    public void Apply(bool[] unit)
    {
        int id = 0, o = 0;
        for (int b = 0; b < L.U; b++) id = (id << 1) | (unit[o++] ? 1 : 0);
        if (id == 0) { int v = 0; for (int b = 0; b < QrOnly.Head; b++) v = (v << 1) | (unit[o++] ? 1 : 0); version = v + 1; }
        have[id] = unit.Skip(o).ToArray();
    }

    // 0..255 の灰色 1 チャネル。side = n + 2*quiet
    public (int side, byte[] pixels) Render(int quiet = 4)
    {
        int n = QrOnly.SideOf(version > 0 ? version : 1), side = n + 2 * quiet;
        var px = new byte[side * side];
        Array.Fill(px, (byte)255);
        if (version == 0) return (side, px);
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                bool black;
                if (QrOnly.Skipped(n, x, y)) black = QrOnly.Finder(n, x, y);
                else
                {
                    int j = y * n + x - QrOnly.SkippedBefore(n, x, y);
                    int id = j < L.First ? 0 : 1 + (j - L.First) / L.Pay;
                    int off = j < L.First ? j : (j - L.First) % L.Pay;
                    black = have.TryGetValue(id, out var bits) && bits[off];
                }
                if (black) px[(quiet + y) * side + quiet + x] = 0;
            }
        return (side, px);
    }
}
