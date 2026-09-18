// Recently used image sources (files and URLs), newest first. Kept as readable JSON (%LOCALAPPDATA%\ImagePad\history.json,
// IMAGEPAD_HOME overrides the folder) so it can be looked at or edited without the app.
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace ImagePad;

public enum SourceKind { File, Url }

public sealed record HistoryEntry(
    [property: JsonConverter(typeof(JsonStringEnumConverter))] SourceKind Kind,
    string Value,
    string Name,
    DateTimeOffset UsedAt);

public interface ISourceHistory
{
    IReadOnlyList<HistoryEntry> Load();
    void Save(IReadOnlyList<HistoryEntry> entries);
}

public sealed class InMemoryHistory : ISourceHistory
{
    IReadOnlyList<HistoryEntry> entries = Array.Empty<HistoryEntry>();
    public IReadOnlyList<HistoryEntry> Load() => entries;
    public void Save(IReadOnlyList<HistoryEntry> e) => entries = e;
}

public sealed class JsonFileHistory(string path) : ISourceHistory
{
    static readonly JsonSerializerOptions Options = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string DefaultPath()
    {
        var home = Environment.GetEnvironmentVariable("IMAGEPAD_HOME");
        if (string.IsNullOrWhiteSpace(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImagePad");
        return Path.Combine(home, "history.json");
    }

    public IReadOnlyList<HistoryEntry> Load()
    {
        // a hand-edited file can contain nulls or entries without a value; drop them rather than hand them to the UI
        try
        {
            var list = File.Exists(path) ? JsonSerializer.Deserialize<List<HistoryEntry>>(File.ReadAllText(path), Options) : null;
            return list?.Where(e => e is not null && !string.IsNullOrEmpty(e.Value)).ToList() ?? new List<HistoryEntry>();
        }
        // a broken file only loses the history; the app must still start
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException) { return Array.Empty<HistoryEntry>(); }
    }

    public void Save(IReadOnlyList<HistoryEntry> entries)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(entries, Options));
        File.Move(tmp, path, overwrite: true);
    }
}

public static class HistoryRules
{
    // the user asked for about 10 to start with (2026-09-17)
    public const int MaxEntries = 10;

    public static IReadOnlyList<HistoryEntry> Add(IReadOnlyList<HistoryEntry> entries, HistoryEntry entry) =>
        new[] { entry }.Concat(entries.Where(e => !(e.Kind == entry.Kind && string.Equals(e.Value, entry.Value, entry.Kind == SourceKind.File ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))))
            .Take(MaxEntries).ToList();
}

// What a browser drop carries. Chromium puts the link URL, plain text and an HTML fragment; for a dragged picture the
// fragment has <img src="...">, which is the image itself (the link URL may be the page around it).
public static class DropParsing
{
    static readonly Regex ImgSrc = new(@"<img\b[^>]*?\bsrc\s*=\s*(?:""([^""]+)""|'([^']+)'|([^\s>]+))", RegexOptions.IgnoreCase);

    public static string? ImageUrlFromHtml(string? html)
    {
        if (string.IsNullOrEmpty(html)) return null;
        var m = ImgSrc.Match(html);
        if (!m.Success) return null;
        var src = System.Net.WebUtility.HtmlDecode(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value);
        return src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || src.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || src.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) ? src : null;
    }

    // first http(s) URL in a text (text/x-moz-url is "url\ntitle")
    public static string? UrlFromText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var line = text.Split('\n', '\r').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
        return line is not null && (line.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || line.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) ? line : null;
    }

    // data:image/png;base64,.... -> bytes (null when not a base64 data URI)
    public static byte[]? BytesFromDataUri(string uri)
    {
        var comma = uri.IndexOf(',');
        if (!uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || comma < 0 || !uri[..comma].EndsWith(";base64", StringComparison.OrdinalIgnoreCase)) return null;
        try { return Convert.FromBase64String(uri[(comma + 1)..]); } catch (FormatException) { return null; }
    }
}
