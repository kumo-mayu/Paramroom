// Where images come from: files, URLs and decoders. The decoder is swappable because the app can use Windows Imaging
// Component (WebP / HEIC / AVIF when the codecs are installed) while the command line and tests use StbImageSharp.
using System.Net.Http;

namespace Paramroom;

public interface IImageDecoder
{
    // throws when the bytes are not an image this decoder can read
    Img Decode(byte[] bytes);
}

public sealed class StbImageDecoder : IImageDecoder
{
    public Img Decode(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes);
        return Img.Load(ms);
    }
}

public interface IImageFetcher
{
    Task<byte[]> FetchAsync(string url, CancellationToken cancellationToken);
}

public sealed class HttpImageFetcher : IImageFetcher
{
    // Enough for photos and screenshots; a bigger download is almost certainly not the image the user meant and would
    // only be shrunk to 512 px anyway.
    public const long MaxBytes = 50L * 1024 * 1024;

    static readonly HttpClient Client = CreateClient();

    static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        // Some image hosts refuse requests without a browser-like user agent.
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Paramroom/0.1");
        c.DefaultRequestHeaders.Accept.ParseAdd("image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5");
        return c;
    }

    public async Task<byte[]> FetchAsync(string url, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new ImageSourceException("http:// か https:// で始まる画像の URL を入れてください。");
        using var response = await Client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new ImageSourceException($"画像を取得できませんでした（サーバーの応答 {(int)response.StatusCode}）。URL が画像そのものを指しているか確認してください。");
        if (response.Content.Headers.ContentLength is long len && len > MaxBytes)
            throw new ImageSourceException($"画像が大きすぎます（{len / 1024 / 1024} MB）。50 MB までの画像を指定してください。");
        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var ms = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (ms.Length + read > MaxBytes) throw new ImageSourceException("画像が大きすぎます。50 MB までの画像を指定してください。");
            ms.Write(buffer, 0, read);
        }
        return ms.ToArray();
    }
}

// A problem the user can fix (wrong URL, not an image, too large); the message is shown as is.
public sealed class ImageSourceException(string message, Exception? inner = null) : Exception(message, inner);
