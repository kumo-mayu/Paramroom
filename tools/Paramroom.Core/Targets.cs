// Where packets go. Kept behind interfaces so the app can be exercised without VRChat (PARAMROOM_TARGET) and tests can
// capture what would be sent.
using System.Net.Sockets;

namespace Paramroom;

public interface ITargetFinder
{
    Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken);
}

public sealed class OscQueryTargetFinder(double waitSeconds = 3) : ITargetFinder
{
    public async Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await VrcDiscovery.FindAsync(waitSeconds);
    }
}

// A fixed destination instead of OSCQuery: "host:port[:ints[:format]]", e.g. "127.0.0.1:9130:25:3". For checking the app
// without VRChat (packets go to a local listener such as measure/osc/check-sender.js).
public sealed class FixedTargetFinder(VrcClient client) : ITargetFinder
{
    public static FixedTargetFinder? FromSpec(string? spec)
    {
        if (string.IsNullOrWhiteSpace(spec)) return null;
        var p = spec.Split(':');
        if (p.Length < 2 || !int.TryParse(p[1], out int port)) throw new ArgumentException($"PARAMROOM_TARGET の形式が違います: {spec}（host:port[:Int の数[:format]]）");
        int ints = p.Length > 2 && int.TryParse(p[2], out int b) ? b : 32;
        int? format = p.Length > 3 && int.TryParse(p[3], out int f) ? f : 3;
        return new FixedTargetFinder(new VrcClient($"固定の送信先 {p[0]}:{port}", p[0], port, null, ints, format, null));
    }

    public Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<VrcClient>>(new[] { client });
}

public interface IOscTransport : IDisposable
{
    void Send(byte[] datagram);
}

public sealed class UdpOscTransport : IOscTransport
{
    readonly UdpClient udp = new();

    public UdpOscTransport(string host, int port)
    {
        // On Windows a UDP send to a port nobody listens on (VRChat restarting, a wrong port) makes the *next* send throw
        // "connection reset" from the ICMP reply. Sending is fire-and-forget, so turn that report off.
        if (OperatingSystem.IsWindows())
        {
            const int SIO_UDP_CONNRESET = -1744830452;
            udp.Client.IOControl(SIO_UDP_CONNRESET, new byte[] { 0, 0, 0, 0 }, null);
        }
        udp.Connect(host, port);
    }

    public void Send(byte[] datagram) => udp.Send(datagram);
    public void Dispose() => udp.Dispose();
}
