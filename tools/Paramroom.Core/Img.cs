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

    public static Img Load(Stream s)
    {
        var r = ImageResult.FromStream(s, ColorComponents.RedGreenBlueAlpha);
        CheckSize(r.Width, r.Height);
        return FromRgba(r.Data, r.Width, r.Height);
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
