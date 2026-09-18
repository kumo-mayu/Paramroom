// One OSCQuery service for the whole life of the app, instead of a new one per search.
//
// Building an OSCQueryService opens a TCP (HTTP) port and a UDP port and announces them over mDNS. The old search built
// one every time and threw it away, so an app waiting for a Paramroom avatar re-announced itself on fresh ports every
// scan (every 10 s). Here the service is made once; VRChat clients it has seen over mDNS are read from its cache, and
// the app's own announcement stays the same.
//
// The service also advertises /avatar/change, so VRChat sends the new avatar ID to our UDP port when the avatar is
// swapped (the same approach as the author's vrc-osc-recorder). A swap is then "read the avatar again" rather than
// "find VRChat again". The receiving port is bound to loopback only: VRChat runs on the same PC, and a socket open to the
// LAN could trigger a firewall prompt.
using System.Net;
using System.Net.Sockets;
using System.Text;
using VRC.OSCQuery;

namespace Paramroom;

public sealed class VrcConnection : IDisposable
{
    public const string ServiceName = "Paramroom-Sender";

    readonly OSCQueryService service;
    readonly UdpClient udp;
    readonly CancellationTokenSource cts = new();
    readonly Dictionary<string, OSCQueryServiceProfile> seen = new();
    bool swept;

    public int TcpPort { get; }
    public int UdpPort { get; }

    // raised on a background thread with the new avatar ID
    public event Action<string>? AvatarChanged;

    public VrcConnection()
    {
        udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        UdpPort = ((IPEndPoint)udp.Client.LocalEndPoint!).Port;
        TcpPort = Extensions.GetAvailableTcpPort();
        service = new OSCQueryServiceBuilder()
            .WithServiceName(ServiceName)
            .WithTcpPort(TcpPort)
            .WithUdpPort(UdpPort)
            .WithOscIP(IPAddress.Loopback)
            .WithDefaults()
            .Build();
        service.AddEndpoint<string>("/avatar/change", Attributes.AccessValues.WriteOnly);
        service.OnOscQueryServiceAdded += Remember;
        _ = Task.Run(() => ReceiveLoop(cts.Token));
    }

    void Remember(OSCQueryServiceProfile p)
    {
        // mDNS entries without a name have been seen in practice (vrc-osc-recorder); skip them instead of throwing
        if (p?.name != null && p.name.StartsWith("VRChat-Client")) lock (seen) seen[p.name] = p;
    }

    // The VRChat clients seen so far. The first call waits for mDNS answers; later ones only ask again briefly, since
    // the service keeps listening in between. Entries of a VRChat that has quit stay in the cache (the library reports
    // additions only), so callers must check that a client still answers.
    public async Task<IReadOnlyList<OSCQueryServiceProfile>> VrchatServicesAsync(double firstWaitSec, CancellationToken ct = default)
    {
        var until = DateTime.UtcNow.AddSeconds(swept ? Math.Min(1, firstWaitSec) : firstWaitSec);
        while (true)
        {
            service.RefreshServices();
            foreach (var p in service.GetOSCQueryServices()) Remember(p);
            if (DateTime.UtcNow >= until) break;
            await Task.Delay(500, ct);
        }
        swept = true;
        lock (seen) return seen.Values.ToList();
    }

    async Task ReceiveLoop(CancellationToken ct)
    {
        var buffer = new byte[65535];
        while (!ct.IsCancellationRequested)
        {
            int n;
            try { n = await udp.Client.ReceiveAsync(buffer.AsMemory(), SocketFlags.None, ct); }
            catch (OperationCanceledException) { return; }
            catch (ObjectDisposedException) { return; }
            catch (SocketException) { continue; }   // e.g. a reset from an ICMP reply; keep listening
            foreach (var id in OscParse.AvatarChanges(buffer.AsSpan(0, n).ToArray()))
            {
                try { AvatarChanged?.Invoke(id); } catch (Exception) { /* a handler's fault must not stop the loop */ }
            }
        }
    }

    public void Dispose()
    {
        cts.Cancel();
        service.OnOscQueryServiceAdded -= Remember;
        udp.Dispose();
        service.Dispose();
        cts.Dispose();
    }
}

// Just enough OSC reading to pick /avatar/change out of what VRChat sends (a message or a bundle of them).
public static class OscParse
{
    public static IEnumerable<string> AvatarChanges(byte[] data)
    {
        var found = new List<string>();
        try { Walk(data, 0, data.Length, found); }
        catch (Exception e) when (e is ArgumentException or IndexOutOfRangeException) { /* malformed: ignore */ }
        return found;
    }

    static void Walk(byte[] d, int start, int end, List<string> found)
    {
        if (end - start >= 16 && ReadString(d, start, end, out int afterTag) == "#bundle")
        {
            int pos = afterTag + 8;                         // time tag
            while (pos + 4 <= end)
            {
                int size = (d[pos] << 24) | (d[pos + 1] << 16) | (d[pos + 2] << 8) | d[pos + 3];
                pos += 4;
                if (size < 0 || pos + size > end) return;
                Walk(d, pos, pos + size, found);
                pos += size;
            }
            return;
        }
        string address = ReadString(d, start, end, out int p1);
        if (address != "/avatar/change" || p1 >= end) return;
        string tags = ReadString(d, p1, end, out int p2);
        if (tags.Length >= 2 && tags[0] == ',' && tags[1] == 's') found.Add(ReadString(d, p2, end, out _));
    }

    // an OSC string: ASCII/UTF-8 up to a NUL, padded to a multiple of 4
    static string ReadString(byte[] d, int start, int end, out int next)
    {
        int z = Array.IndexOf(d, (byte)0, start, end - start);
        if (z < 0) throw new ArgumentException("unterminated OSC string");
        next = start + ((z - start) / 4 + 1) * 4;
        return Encoding.UTF8.GetString(d, start, z - start);
    }
}
