// QR mode: the same packets carry a QR code's modules instead of primitives (docs/research/09).
//
// The decoder stores every unit's payload as fixed-width slots - one per primitive, primBits data bits each, plus an
// "arrived" flag. A QR code is one bit per module, so the modules go into those very same slots. Nothing about the
// packet layout, the store, the epoch handling or the aspect code changes; the shader just reads a slot as module bits
// instead of as a shape. Which of the two a packet means is the bit right before the aspect byte, so any prefab can
// show either and the sender decides.
//
//   unit 0: [unit id u][header 16][k0 slots]      header = [modules 8][reserved 8]
//   unit i: [unit id u][k slots]                  slot = primBits module bits, row by row
//
// A 25 x 25 code is 625 bits = 3 packets, so it is complete in about 0.3 s (a picture takes 100 s).
using Net.Codecrete.QrCodeGenerator;

namespace Paramroom;

public static class QrMode
{
    public const int Quiet = 4;          // modules of white margin, as the QR standard asks for
    public const int MaxModules = 177;   // version 40

    public sealed record QrData(int Modules, bool[] Bits, string Text)
    {
        public int Version => (Modules - 17) / 4;
    }

    // error correction level; M is the default (L is not worth it here: the packets are few and repeat every second)
    public static QrData Build(string text, QrCode.Ecc? ecc = null)
    {
        if (string.IsNullOrEmpty(text)) throw new ArgumentException("text is empty");
        var qr = QrCode.EncodeText(text, ecc ?? QrCode.Ecc.Medium);
        int n = qr.Size;
        if (n > MaxModules) throw new InvalidOperationException($"QR が大きすぎます（{n}x{n}）。文字列を短くしてください。");
        var bits = new bool[n * n];
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
                bits[y * n + x] = qr.GetModule(x, y);
        return new QrData(n, bits, text);
    }

    // how many packets the code needs with this decoder layout
    public static int UnitsNeeded(PrimLayout L, int modules)
    {
        int bits = modules * modules;
        if (bits <= L.K0 * L.PrimBits) return 1;
        return 1 + (int)Math.Ceiling((bits - L.K0 * L.PrimBits) / (double)(L.K * L.PrimBits));
    }

    // the units, in the same bool[P] form the primitive encoder produces (Packets.Build adds the epoch and the bytes)
    public static List<bool[]> Encode(QrData qr, PrimLayout L, int P)
    {
        int need = UnitsNeeded(L, qr.Modules);
        if (need > L.Units)
            throw new InvalidOperationException($"QR {qr.Modules}x{qr.Modules} には {need} パケット要りますが、このアバターは {L.Units} までです。");
        var units = new List<bool[]>(need);
        int bit = 0;
        for (int id = 0; id < need; id++)
        {
            var u = new bool[P];
            int o = 0;
            for (int i = L.U - 1; i >= 0; i--) u[o++] = ((id >> i) & 1) == 1;
            if (id == 0)
            {
                for (int i = 7; i >= 0; i--) u[o++] = ((qr.Modules >> i) & 1) == 1;
                o += 8;   // reserved
            }
            int slots = id == 0 ? L.K0 : L.K;
            for (int s = 0; s < slots; s++)
                for (int i = 0; i < L.PrimBits; i++, o++)
                    u[o] = bit < qr.Bits.Length && qr.Bits[bit++];
            units.Add(u);
        }
        return units;
    }
}

// Renders received units the way the avatar decoder does (sim/codecs/qrmode.js decoder.render, QrPixel in the shader):
// white everywhere, black where a module's bit is 1, and white wherever the packet holding that module has not arrived.
// Used for the "what receivers see" preview while sending.
public static class QrRenderer
{
    // units[id] = the unit's bits ([unit id][payload]) or null when not received. Returns RGB 0..255 bytes, R x R.
    public static byte[] Render(int R, PrimLayout L, IReadOnlyList<bool[]?> units)
    {
        var px = new byte[R * R * 3];
        Array.Fill(px, (byte)255);
        if (units.Count == 0 || units[0] is not bool[] u0) return px;

        int n = 0;
        for (int i = 0; i < 8; i++) n = (n << 1) | (u0[L.U + i] ? 1 : 0);
        if (n < 21 || n > QrMode.MaxModules) return px;

        int cells = n + 2 * QrMode.Quiet;
        int cell = R / cells;
        if (cell < 1) return px;
        int pad = (R - cell * cells) / 2;

        for (int my = 0; my < n; my++)
        {
            for (int mx = 0; mx < n; mx++)
            {
                int idx = my * n + mx;
                int slot = idx / L.PrimBits, off = idx % L.PrimBits;
                int unit = slot < L.K0 ? 0 : 1 + (slot - L.K0) / L.K;
                int inUnit = slot < L.K0 ? slot : (slot - L.K0) % L.K;
                if (unit >= units.Count || units[unit] is not bool[] u) continue;   // not arrived: stays white
                int at = L.U + (unit == 0 ? 16 : 0) + inUnit * L.PrimBits + off;
                if (at >= u.Length || !u[at]) continue;                              // white module
                int x0 = pad + (QrMode.Quiet + mx) * cell, y0 = pad + (QrMode.Quiet + my) * cell;
                for (int y = y0; y < y0 + cell; y++)
                    for (int x = x0; x < x0 + cell; x++)
                    {
                        int o = (y * R + x) * 3;
                        px[o] = px[o + 1] = px[o + 2] = 0;
                    }
            }
        }
        return px;
    }
}
