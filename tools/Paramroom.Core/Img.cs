// RGB image (double, 0..255, rows top-down) with the same crop / resize as sim/lib/image.js.
using StbImageSharp;

namespace Paramroom;

public sealed class Img
{
    public readonly int W, H;
    public readonly double[] Data; // RGB interleaved

    public Img(int w, int h) { W = w; H = h; Data = new double[w * h * 3]; }

    // PNG / JPEG / BMP ...; alpha is composited on white (as sim/lib/image.js loadPNG)
    public static Img Load(string path)
    {
        using var s = File.OpenRead(path);
        return Load(s);
    }

    // An image is kept at 8 bytes per channel while it is loaded, so a huge one (a 4 MB PNG can be 12000x12000)
    // would take gigabytes. Nothing here needs more than the canvas, so anything past the limit is refused with a
    // message that says why, instead of ending as an out-of-memory error.
    public const int MaxPixels = 64_000_000;   // 64 Mpx, e.g. 8000x8000

    // longSide > 0 なら、その長辺に収まるまで縮めながら読む（元の大きさの配列を作らない）
    public static Img Load(Stream s, int longSide = 0)
    {
        var r = ImageResult.FromStream(s, ColorComponents.RedGreenBlueAlpha);
        CheckSize(r.Width, r.Height);
        var (w, h) = ScaledSize(r.Width, r.Height, longSide);
        return w == r.Width && h == r.Height ? FromRgba(r.Data, r.Width, r.Height)
                                             : FromRgbaScaled(r.Data, r.Width, r.Height, w, h);
    }

    public static void CheckSize(int w, int h)
    {
        if ((long)w * h > MaxPixels)
            throw new InvalidOperationException($"画像が大きすぎます（{w}x{h} = {(long)w * h / 1_000_000} メガ画素）。{MaxPixels / 1_000_000} メガ画素までにしてください。");
    }

    // 8-bit RGBA rows top-down, alpha composited on white
    public static Img FromRgba(byte[] rgba, int w, int h)
    {
        CheckSize(w, h);
        var img = new Img(w, h);
        for (int i = 0, j = 0; i < w * h; i++, j += 4)
        {
            double a = rgba[j + 3] / 255.0;
            for (int k = 0; k < 3; k++) img.Data[i * 3 + k] = rgba[j + k] * a + 255 * (1 - a);
        }
        return img;
    }

    // 8-bit RGBA を、元の大きさの double 配列を作らずに縮める（docs/research/11）。
    // 4000x3000 の写真だと、その配列だけで 288 MB になる。
    // 計算の順序は FromRgba と ResizeArea をそのまま続けたものと同じなので、結果は 1 bit も変わらない。
    public static Img FromRgbaScaled(byte[] rgba, int W, int H, int w, int h)
    {
        CheckSize(W, H);
        if (w > W || h > H) throw new ArgumentException("FromRgbaScaled は縮小だけ");
        var o = new Img(w, h);
        double sx = (double)W / w, sy = (double)H / h;
        Parallel.For(0, h, Y =>
        {
            double y0 = Y * sy, y1 = (Y + 1) * sy;
            Span<double> acc = stackalloc double[3];
            for (int X = 0; X < w; X++)
            {
                double x0 = X * sx, x1 = (X + 1) * sx, wsum = 0;
                acc.Clear();
                for (int y = (int)Math.Floor(y0); y < (int)Math.Ceiling(y1); y++)
                {
                    double wy = Math.Min(y + 1, y1) - Math.Max(y, y0);
                    for (int x = (int)Math.Floor(x0); x < (int)Math.Ceiling(x1); x++)
                    {
                        double wgt = (Math.Min(x + 1, x1) - Math.Max(x, x0)) * wy;
                        wsum += wgt;
                        int j = (y * W + x) * 4;
                        double a = rgba[j + 3] / 255.0, bg = 255 * (1 - a);
                        acc[0] += (rgba[j] * a + bg) * wgt;
                        acc[1] += (rgba[j + 1] * a + bg) * wgt;
                        acc[2] += (rgba[j + 2] * a + bg) * wgt;
                    }
                }
                int q = (Y * w + X) * 3;
                o.Data[q] = acc[0] / wsum; o.Data[q + 1] = acc[1] / wsum; o.Data[q + 2] = acc[2] / wsum;
            }
        });
        return o;
    }

    // longSide より大きければ、その長辺に収まるところまで縮めながら読む（0 = 縮めない）
    public static (int W, int H) ScaledSize(int w, int h, int longSide)
    {
        int max = Math.Max(w, h);
        if (longSide <= 0 || max <= longSide) return (w, h);
        double s = (double)longSide / max;
        return (Math.Max(1, (int)Math.Round(w * s)), Math.Max(1, (int)Math.Round(h * s)));
    }

    // RGB bytes (rounded) for previews
    public byte[] ToRgbBytes()
    {
        var b = new byte[Data.Length];
        for (int i = 0; i < b.Length; i++) b[i] = (byte)Math.Max(0, Math.Min(255, Math.Floor(Data[i] + 0.5)));
        return b;
    }

    public static Img FromRgbBytes(byte[] rgb, int w, int h)
    {
        var img = new Img(w, h);
        for (int i = 0; i < rgb.Length; i++) img.Data[i] = rgb[i];
        return img;
    }

    public Img Crop(int x0, int y0, int w, int h)
    {
        var o = new Img(w, h);
        for (int y = 0; y < h; y++) Array.Copy(Data, ((y0 + y) * W + x0) * 3, o.Data, y * w * 3, w * 3);
        return o;
    }

    public Img Resize(int w, int h)
    {
        if (w == W && h == H) { var c = new Img(w, h); Array.Copy(Data, c.Data, Data.Length); return c; }
        return w <= W && h <= H ? ResizeArea(w, h) : ResizeBilinear(w, h);
    }

    // 最近傍。QR のような升目の絵を拡大するのに使う（なめらかに拡大するとぼやけて読めなくなる）
    public Img ResizeNearest(int w, int h)
    {
        var o = new Img(w, h);
        for (int Y = 0; Y < h; Y++)
        {
            int sy = Math.Min(H - 1, (int)((long)Y * H / h));
            for (int X = 0; X < w; X++)
            {
                int sx = Math.Min(W - 1, (int)((long)X * W / w));
                for (int c = 0; c < 3; c++) o.Data[(Y * w + X) * 3 + c] = Data[(sy * W + sx) * 3 + c];
            }
        }
        return o;
    }

    Img ResizeArea(int w, int h)
    {
        var o = new Img(w, h);
        double sx = (double)W / w, sy = (double)H / h;
        Parallel.For(0, h, Y =>
        {
            double y0 = Y * sy, y1 = (Y + 1) * sy;
            Span<double> acc = stackalloc double[3];
            for (int X = 0; X < w; X++)
            {
                double x0 = X * sx, x1 = (X + 1) * sx, wsum = 0;
                acc.Clear();
                for (int y = (int)Math.Floor(y0); y < (int)Math.Ceiling(y1); y++)
                {
                    double wy = Math.Min(y + 1, y1) - Math.Max(y, y0);
                    for (int x = (int)Math.Floor(x0); x < (int)Math.Ceiling(x1); x++)
                    {
                        double wgt = (Math.Min(x + 1, x1) - Math.Max(x, x0)) * wy;
                        wsum += wgt;
                        int p = (y * W + x) * 3;
                        acc[0] += Data[p] * wgt; acc[1] += Data[p + 1] * wgt; acc[2] += Data[p + 2] * wgt;
                    }
                }
                int q = (Y * w + X) * 3;
                o.Data[q] = acc[0] / wsum; o.Data[q + 1] = acc[1] / wsum; o.Data[q + 2] = acc[2] / wsum;
            }
        });
        return o;
    }

    Img ResizeBilinear(int w, int h)
    {
        var o = new Img(w, h);
        for (int Y = 0; Y < h; Y++)
        {
            double fy = Math.Min(Math.Max((Y + 0.5) * H / h - 0.5, 0), H - 1);
            int y0 = (int)Math.Floor(fy), y1 = Math.Min(y0 + 1, H - 1); double ty = fy - y0;
            for (int X = 0; X < w; X++)
            {
                double fx = Math.Min(Math.Max((X + 0.5) * W / w - 0.5, 0), W - 1);
                int x0 = (int)Math.Floor(fx), x1 = Math.Min(x0 + 1, W - 1); double tx = fx - x0;
                for (int k = 0; k < 3; k++)
                {
                    double a = Data[(y0 * W + x0) * 3 + k], b = Data[(y0 * W + x1) * 3 + k];
                    double c = Data[(y1 * W + x0) * 3 + k], d = Data[(y1 * W + x1) * 3 + k];
                    o.Data[(Y * w + X) * 3 + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
                }
            }
        }
        return o;
    }
}
