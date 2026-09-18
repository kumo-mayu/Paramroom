// Finds running VRChat clients with OSCQuery (vrchat-community/vrc-oscquery-lib) instead of a hard-coded OSC port:
// every client advertises an "_oscjson._tcp" service named VRChat-Client-XXXXXX; its HOST_INFO gives the OSC UDP
// address/port the client listens on, and its tree lists the current avatar's parameters.
using System.Net;
using VRC.OSCQuery;

namespace ImagePad;

public sealed record VrcClient(string Name, string OscIp, int OscPort, string? AvatarId, int ImagePadParams, int? Format, string? Problem)
{
    public override string ToString() => $"{Name}: OSC {OscIp}:{OscPort}, avatar {AvatarId}, ImagePad Int params {(ImagePadParams > 0 ? $"{ImagePadParams} (D0..D{ImagePadParams - 1})" : "0")}, format {(Format?.ToString() ?? "-")}{(Problem != null ? " (" + Problem + ")" : "")}";
}

// ImagePad_Format (local-only avatar parameter set by the prefab) -> decoder variant
// Field widths: centre / radius / angle / colour RGB / alpha bits of one primitive. The light variant (formats 4-5,
// 47 bit) packs 5 primitives into 32 Int instead of 4 with nearly the same picture
// (measure/results/2026-09-17/precision: 16 images, 0.972-0.976 vs 0.977, joiners at 20 s 0.797 vs 0.771).
// Must match the Unity prefab builder (ImagePadPrimBuilder.Formats).
public sealed record DecoderFormatInfo(int R, int N, int Cb, int Rb, int Ab, int[] Col, int ABits, string Prefab, string Name)
{
    public int PrimBits => 2 * Cb + 2 * Rb + Ab + Col.Sum() + ABits;

    public PrimConfig Config(int maxPrims) => new() { R = R, MaxPrims = maxPrims, LayoutPrims = N, Cb = Cb, Rb = Rb, Ab = Ab, Col = Col, ABits = ABits };

    // The Int counts a prefab can be built with: the smallest count for each number of primitives per packet, and only
    // those that still leave 8 spare bits for the aspect code. Same rule as ImagePadPrimBuilder.GoodLayouts, so an
    // error message can name the counts that actually work for THIS format (they differ: format 3 starts at 10,
    // format 6 at 11).
    public IEnumerable<int> GoodIntCounts()
    {
        int prevK = -1;
        for (int b = 1; b <= VrcDiscovery.MaxParams; b++)
        {
            PrimLayout l;
            try { l = PrimLayout.Of(Config(N), 8 * b - 2); }
            catch (InvalidOperationException) { continue; }
            if (l.SpareBits < 8 || l.K == prevK) continue;
            prevK = l.K;
            yield return b;
        }
    }

    public bool SameFields(DecoderFormatInfo o) => R == o.R && N == o.N && Cb == o.Cb && Rb == o.Rb && Ab == o.Ab && ABits == o.ABits && Col.SequenceEqual(o.Col);
}

public static class DecoderFormat
{
    static readonly int[] C565 = { 5, 6, 5 }, C444 = { 4, 4, 4 };

    public static readonly Dictionary<int, DecoderFormatInfo> Known = new()
    {
        [1] = new(256, 1000, 9, 8, 6, C565, 2, "ImagePadPrimDecoder", "256px・図形 1000 個"),
        [2] = new(512, 2000, 9, 8, 6, C565, 2, "ImagePadPrimDecoder512n2000", "512px・図形 2000 個"),
        [3] = new(512, 4000, 9, 8, 6, C565, 2, "ImagePadPrimDecoder512", "512px・図形 4000 個"),
        [4] = new(512, 4000, 8, 6, 5, C444, 2, "ImagePadPrimDecoder512Light", "512px・図形 4000 個（軽量）"),
        [5] = new(512, 5000, 8, 6, 5, C444, 2, "ImagePadPrimDecoder512Light5000", "512px・図形 5000 個（軽量）"),
        // 1024 canvas: the coordinates take 10 bits and the angle 5, so the primitive stays at 59 bits and the packet
        // keeps 8 spare bits for the aspect code (docs/research/08 §17). Built to measure the GPU cost in VRChat.
        [6] = new(1024, 4000, 10, 8, 5, C565, 2, "ImagePadPrimDecoder1024", "1024px・図形 4000 個（実験用）"),
    };

    // what is assumed when the avatar does not tell (prefabs before ImagePad_Format)
    public static DecoderFormatInfo Default => Known[3];
}

public static class VrcDiscovery
{
    public const int MaxParams = 32;

    public static async Task<List<VrcClient>> FindAsync(double waitSec)
    {
        var found = new Dictionary<string, OSCQueryServiceProfile>();
        using var svc = new OSCQueryServiceBuilder()
            .WithServiceName("ImagePad-Sender")
            .WithTcpPort(Extensions.GetAvailableTcpPort())
            .WithUdpPort(Extensions.GetAvailableUdpPort())
            .WithDefaults()
            .Build();
        void Add(OSCQueryServiceProfile p) { if (p?.name != null && p.name.StartsWith("VRChat-Client")) lock (found) found[p.name] = p; }
        svc.OnOscQueryServiceAdded += Add;
        var until = DateTime.UtcNow.AddSeconds(waitSec);
        while (DateTime.UtcNow < until)
        {
            svc.RefreshServices();
            foreach (var p in svc.GetOSCQueryServices()) Add(p);
            await Task.Delay(500);
        }
        var clients = new List<VrcClient>();
        List<OSCQueryServiceProfile> profiles;
        lock (found) profiles = found.Values.ToList();
        foreach (var p in profiles)
        {
            try
            {
                var host = await Extensions.GetHostInfo(p.address, p.port);
                var tree = await Extensions.GetOSCTree(p.address, p.port);
                string? avatar = tree.GetNodeWithPath("/avatar/change")?.Value?.FirstOrDefault()?.ToString();
                if (Environment.GetEnvironmentVariable("IMAGEPAD_DEBUG") == "1")
                    Console.WriteLine($"  [debug] {p.name} D0 value: {string.Join(",", tree.GetNodeWithPath("/avatar/parameters/D0")?.Value ?? Array.Empty<object>())}");
                // ImagePad Int parameters: consecutive D0, D1, ... of type i (the prefab defines D0..D(B-1))
                int ok = 0; string? problem = null;
                for (int i = 0; i < MaxParams; i++)
                {
                    var node = tree.GetNodeWithPath($"/avatar/parameters/D{i}");
                    if (node == null) { if (i == 0) problem = "D0 missing"; break; }
                    if (node.OscType != "i") { problem = $"D{i} type {node.OscType} (expected i)"; break; }
                    ok++;
                }
                int? format = null;
                var fnode = tree.GetNodeWithPath("/avatar/parameters/ImagePad_Format");
                if (fnode?.Value is { Length: > 0 } fv && double.TryParse(fv[0]?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var fd)) format = (int)Math.Round(fd);
                string ip = string.IsNullOrEmpty(host.oscIP) || host.oscIP == "0.0.0.0" ? p.address.ToString() : host.oscIP;
                clients.Add(new VrcClient(p.name, ip, host.oscPort, avatar, ok, format, problem));
            }
            catch (Exception e) { clients.Add(new VrcClient(p.name, p.address.ToString(), 0, null, 0, null, "query failed: " + e.Message)); }
        }
        return clients.OrderBy(c => c.OscPort).ToList();
    }
}
