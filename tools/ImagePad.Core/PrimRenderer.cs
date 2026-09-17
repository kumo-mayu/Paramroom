// Renders a set of received units the way the avatar decoder does (sim/codecs/prim.js decoder.render, DrawPrim in the
// shader): background from unit 0 (grey 128 until it arrives), then every present primitive in index order, blended with
// hard edges. Used for the "what receivers see" preview while sending.
namespace ImagePad;

public static class PrimRenderer
{
    // units[id] = the unit's bits ([unit id][payload], as produced by the encoder) or null when not received.
    // Returns RGB 0..255 bytes, R x R.
    public static byte[] Render(PrimConfig cfg, PrimLayout L, IReadOnlyList<bool[]?> units)
    {
        int R = cfg.R;
        var cur = new double[R * R * 3];
        double b0 = 128, b1 = 128, b2 = 128;
        if (units.Count > 0 && units[0] is bool[] u0)
        {
            int bg = Read(u0, L.U, 16);
            b0 = ((bg >> 11) & 31) * 255.0 / 31; b1 = ((bg >> 5) & 63) * 255.0 / 63; b2 = (bg & 31) * 255.0 / 31;
        }
        for (int i = 0; i < R * R; i++) { cur[i * 3] = b0; cur[i * 3 + 1] = b1; cur[i * 3 + 2] = b2; }

        double cmax = (1 << cfg.Cb) - 1, rN = 1 << cfg.Rb, aN = 1 << cfg.Ab;
        Span<int> codes = stackalloc int[5];
        for (int j = 0; j < L.MaxPrims; j++)
        {
            int uid, off;
            if (j < L.K0) { uid = 0; off = L.U + 16 + j * L.PrimBits; }
            else { uid = 1 + (j - L.K0) / L.K; off = L.U + (j - L.K0) % L.K * L.PrimBits; }
            if (uid >= units.Count || units[uid] is not bool[] bits) continue;
            for (int f = 0; f < 5; f++) { codes[f] = Read(bits, off, L.Widths[f]); off += L.Widths[f]; }
            double r = Read(bits, off, cfg.Col[0]) * 255.0 / ((1 << cfg.Col[0]) - 1); off += cfg.Col[0];
            double g = Read(bits, off, cfg.Col[1]) * 255.0 / ((1 << cfg.Col[1]) - 1); off += cfg.Col[1];
            double b = Read(bits, off, cfg.Col[2]) * 255.0 / ((1 << cfg.Col[2]) - 1); off += cfg.Col[2];
            double a = cfg.ABits > 0 ? (Read(bits, off, cfg.ABits) + 1.0) / (1 << cfg.ABits) : 0.5;
            var e = PrimGeometry.Geom(codes, R, cmax, rN, aN);
            double ia = 1 - a, ra = r * a, ga = g * a, ba = b * a;
            for (int y = e.by0; y <= e.by1; y++)
            {
                PrimGeometry.Span(e, y, out int xa, out int xb);
                for (int x = xa; x <= xb; x++)
                {
                    int o = (y * R + x) * 3;
                    cur[o] = cur[o] * ia + ra; cur[o + 1] = cur[o + 1] * ia + ga; cur[o + 2] = cur[o + 2] * ia + ba;
                }
            }
        }
        var outBytes = new byte[cur.Length];
        for (int i = 0; i < cur.Length; i++) outBytes[i] = (byte)Math.Max(0, Math.Min(255, Math.Floor(cur[i] + 0.5)));
        return outBytes;
    }

    static int Read(bool[] bits, int off, int n)
    {
        int v = 0;
        for (int i = 0; i < n; i++) v = (v << 1) | (off + i < bits.Length && bits[off + i] ? 1 : 0);
        return v;
    }
}
