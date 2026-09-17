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
public static class DecoderFormat
{
    public static readonly Dictionary<int, (int R, int N, string Prefab)> Known = new()
    {
        [1] = (256, 1000, "ImagePadPrimDecoder"),
        [2] = (512, 2000, "ImagePadPrimDecoder512n2000"),
        [3] = (512, 4000, "ImagePadPrimDecoder512"),
    };
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
