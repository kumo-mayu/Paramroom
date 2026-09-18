// 画像の読み込みは Windows の画像コーデック（WIC）を先に使う。StbImageSharp は WebP・HEIC・AVIF を読めないが、
// ネット上の画像は WebP が多い。WIC で読めない形式（拡張の入っていない AVIF など）は StbImageSharp に回す。
using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Paramroom.App.Services;

public sealed class WicImageDecoder : IImageDecoder
{
    readonly StbImageDecoder fallback = new();

    public Img Decode(byte[] bytes, int longSide = 0)
    {
        try
        {
            using var ms = new MemoryStream(bytes);
            var decoder = BitmapDecoder.Create(ms, BitmapCreateOptions.PreservePixelFormat | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
            BitmapSource frame = decoder.Frames[0];
            var bgra = new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0);
            int w = bgra.PixelWidth, h = bgra.PixelHeight;
            var pixels = new byte[w * h * 4];
            bgra.CopyPixels(pixels, w * 4, 0);
            for (int i = 0; i < pixels.Length; i += 4) (pixels[i], pixels[i + 2]) = (pixels[i + 2], pixels[i]);
            var (tw, th) = Img.ScaledSize(w, h, longSide);
            return tw == w && th == h ? Img.FromRgba(pixels, w, h) : Img.FromRgbaScaled(pixels, w, h, tw, th);
        }
        catch (Exception) when (bytes.Length > 0)
        {
            return fallback.Decode(bytes, longSide);
        }
    }

    // クリップボードの画像など、既に WPF の絵になっているもの
    public static Img FromBitmapSource(BitmapSource source)
    {
        var bgra = new FormatConvertedBitmap(source, PixelFormats.Bgra32, null, 0);
        int w = bgra.PixelWidth, h = bgra.PixelHeight;
        var pixels = new byte[w * h * 4];
        bgra.CopyPixels(pixels, w * 4, 0);
        for (int i = 0; i < pixels.Length; i += 4) (pixels[i], pixels[i + 2]) = (pixels[i + 2], pixels[i]);
        // クリップボードの絵は α が 0 のまま来ることがある。透明として白に潰すと真っ白になるので、α は見ない
        for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
        return Img.FromRgba(pixels, w, h);
    }
}
