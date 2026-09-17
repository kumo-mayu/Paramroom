// Rotated-ellipse primitive geometry, identical to makeGeom in sim/codecs/prim.js and DrawPrim in
// ImagePadPrimDecoder.shader (pixel centre test u^2/rx^2 + v^2/ry^2 <= 1). Shared by the encoder and the renderer so the
// encoder's canvas and the preview are the same pixels.
namespace ImagePad;

internal static class PrimGeometry
{
    public struct Ell { public double cx, cy, rx, ry, c, s, irx, iry, A, inv2A, Bk, Ck; public int bx0, bx1, by0, by1; }
    public static Ell Geom(ReadOnlySpan<int> codes, int R, double cmax, double rN, double aN)
    {
        var e = new Ell();
        e.cx = codes[0] / cmax * R; e.cy = codes[1] / cmax * R;
        e.rx = Math.Max(0.5, R / 2.0 * Math.Pow((codes[2] + 1) / rN, 2));
        e.ry = Math.Max(0.5, R / 2.0 * Math.Pow((codes[3] + 1) / rN, 2));
        double th = codes[4] / aN * Math.PI;
        e.c = Math.Cos(th); e.s = Math.Sin(th);
        double ex = Math.Sqrt(e.rx * e.rx * e.c * e.c + e.ry * e.ry * e.s * e.s), ey = Math.Sqrt(e.rx * e.rx * e.s * e.s + e.ry * e.ry * e.c * e.c);
        e.bx0 = Math.Max(0, (int)Math.Floor(e.cx - ex - 0.5)); e.bx1 = Math.Min(R - 1, (int)Math.Ceiling(e.cx + ex));
        e.by0 = Math.Max(0, (int)Math.Floor(e.cy - ey - 0.5)); e.by1 = Math.Min(R - 1, (int)Math.Ceiling(e.cy + ey));
        e.irx = 1 / (e.rx * e.rx); e.iry = 1 / (e.ry * e.ry);
        // row-invariant terms of the quadratic in dx (see Span)
        e.A = e.c * e.c * e.irx + e.s * e.s * e.iry; e.inv2A = 1 / (2 * e.A);
        e.Bk = 2 * e.c * e.s * (e.irx - e.iry); e.Ck = e.s * e.s * e.irx + e.c * e.c * e.iry;
        return e;
    }
    public static bool Inside(in Ell e, int x, double dy)
    {
        double dx = x + 0.5 - e.cx, u = dx * e.c + dy * e.s, v = dy * e.c - dx * e.s;
        return u * u * e.irx + v * v * e.iry <= 1;
    }
    // covered pixel run [xa, xb] of row y (empty when xa > xb); exact = endpoints checked with the decoder's pixel test
    // (the analytic run can differ by one pixel at an end in rare rounding cases; the search uses the fast run and every
    // chosen primitive is re-scored exactly, so emitted colours match the decoder raster)
    public static void Span(in Ell e, int y, out int xa, out int xb, bool exact = true)
    {
        double dy = y + 0.5 - e.cy;
        double B = dy * e.Bk, C = dy * dy * e.Ck - 1;
        double disc = B * B - 4 * e.A * C;
        if (disc < 0) { xa = 1; xb = 0; return; }
        double sq = Math.Sqrt(disc);
        xa = Math.Max(e.bx0, (int)Math.Ceiling(e.cx + (-B - sq) * e.inv2A - 0.5));
        xb = Math.Min(e.bx1, (int)Math.Floor(e.cx + (-B + sq) * e.inv2A - 0.5));
        if (!exact) return;
        while (xa - 1 >= e.bx0 && Inside(e, xa - 1, dy)) xa--;
        while (xa <= xb && !Inside(e, xa, dy)) xa++;
        while (xb + 1 <= e.bx1 && Inside(e, xb + 1, dy)) xb++;
        while (xb >= xa && !Inside(e, xb, dy)) xb--;
    }
}
