// Finds running VRChat clients with OSCQuery (vrchat-community/vrc-oscquery-lib) instead of a hard-coded OSC port:
// every client advertises an "_oscjson._tcp" service named VRChat-Client-XXXXXX; its HOST_INFO gives the OSC UDP
// address/port the client listens on, and its tree lists the current avatar's parameters.
using System.Net;
using VRC.OSCQuery;

namespace ImagePad;

public sealed record VrcClient(string Name, string OscIp, int OscPort, string? AvatarId, int ImagePadParams, string? Problem);

public static class VrcDiscovery
{
    public const int ParamCount = 32;

    public static async Task<List<VrcClient>> FindAsync(double waitSec)
    {
        var found = new Dictionary<string, OSCQueryServiceProfile>();
        using var svc = new OSCQueryServiceBuilder()
            .WithServiceName("ImagePad-Sender")
            .WithTcpPort(Extensions.GetAvailableTcpPort())
            .WithUdpPort(Extensions.GetAvailableUdpPort())
            .WithDefaults()
            .Build();
        void Add(OSCQueryServiceProfile p) { if (p.name.StartsWith("VRChat-Client")) lock (found) found[p.name] = p; }
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
                int ok = 0; string? problem = null;
                for (int i = 0; i < ParamCount; i++)
                {
                    var node = tree.GetNodeWithPath($"/avatar/parameters/D{i}");
                    if (node == null) { problem ??= $"D{i} missing"; continue; }
                    if (node.OscType != "i") { problem ??= $"D{i} type {node.OscType} (expected i)"; continue; }
                    ok++;
                }
                string ip = string.IsNullOrEmpty(host.oscIP) || host.oscIP == "0.0.0.0" ? p.address.ToString() : host.oscIP;
                clients.Add(new VrcClient(p.name, ip, host.oscPort, avatar, ok, problem));
            }
            catch (Exception e) { clients.Add(new VrcClient(p.name, p.address.ToString(), 0, null, 0, "query failed: " + e.Message)); }
        }
        return clients.OrderBy(c => c.OscPort).ToList();
    }
}
