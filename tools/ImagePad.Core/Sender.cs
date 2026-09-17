// Packets, square-root-rule schedule and OSC sender (ports of measure/osc/send-image.js and sim/lib/transport.js).
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace ImagePad;

public static class Aspect
{
    // sim/codecs/prim.js aspectCode: 0 = unknown (1:1), 1..255: log2(w/h) = (code-1)/254*4-2
    public static int Code(double w, double h)
    {
        double l = Math.Max(-2, Math.Min(2, Math.Log2(w / h)));
        return 1 + (int)Math.Floor((l + 2) / 4 * 254 + 0.5);
    }
    public static double Ratio(int code) => code == 0 ? 1 : Math.Pow(2, (code - 1) / 254.0 * 4 - 2);
}

public static class Packets
{
    // [epoch 2][unit P = 8*nBytes-2 bits] -> nBytes bytes (= synced Int parameters), last byte = aspect code (unit padding)
    public static byte[][] Build(IReadOnlyList<bool[]> units, int epoch, int aspect, int nBytes)
    {
        return units.Select(u =>
        {
            var bits = new bool[8 * nBytes];
            bits[0] = ((epoch >> 1) & 1) == 1; bits[1] = (epoch & 1) == 1;
            Array.Copy(u, 0, bits, 2, Math.Min(u.Length, 8 * nBytes - 2));
            var bytes = new byte[nBytes];
            for (int i = 0; i < nBytes; i++) { int v = 0; for (int k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] ? 1 : 0); bytes[i] = (byte)v; }
            bytes[nBytes - 1] = (byte)aspect;
            return bytes;
        }).ToArray();
    }
}

// transport.js sqrtSchedule: unit i sent with frequency p_i ∝ sqrt(gain_i), realised by stride scheduling
public sealed class SqrtSchedule
{
    readonly int n;
    readonly double[] pass, stride;
    readonly int[] heap;
    readonly List<int> seq = new();

    public SqrtSchedule(double[] gains, double alpha = 0)
    {
        n = gains.Length;
        var g = gains.Select(v => double.IsFinite(v) ? Math.Max(v, 0) : double.NaN).ToArray();
        var finite = g.Where(v => double.IsFinite(v) && v > 0).ToArray();
        double maxG = finite.Length > 0 ? finite.Max() : 1, minG = finite.Length > 0 ? finite.Min() : 1;
        var f = g.Select(v => Math.Sqrt(double.IsNaN(v) ? 2 * maxG : Math.Max(v, minG * 1e-3))).ToArray();
        double sum = f.Sum();
        stride = f.Select(v => 1 / ((1 - alpha) * v / sum + alpha / n)).ToArray();
        pass = stride.Select(s => s / 2).ToArray();
        heap = Enumerable.Range(0, n).ToArray();
        for (int i = (n >> 1) - 1; i >= 0; i--) Down(i);
    }
    bool Less(int a, int b) => pass[a] < pass[b] || (pass[a] == pass[b] && a < b);
    void Down(int i)
    {
        for (;;)
        {
            int l = 2 * i + 1, r = l + 1, m = i;
            if (l < n && Less(heap[l], heap[m])) m = l;
            if (r < n && Less(heap[r], heap[m])) m = r;
            if (m == i) return;
            (heap[i], heap[m]) = (heap[m], heap[i]); i = m;
        }
    }
    public int this[int k]
    {
        get
        {
            while (seq.Count <= k) { int u = heap[0]; seq.Add(u); pass[u] += stride[u]; Down(0); }
            return seq[k];
        }
    }
}

public static class OscSender
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint p);

    static void Str(List<byte> b, string s) { b.AddRange(Encoding.ASCII.GetBytes(s)); b.Add(0); while (b.Count % 4 != 0) b.Add(0); }
    static void Int(List<byte> b, int v) { b.Add((byte)(v >> 24)); b.Add((byte)(v >> 16)); b.Add((byte)(v >> 8)); b.Add((byte)v); }

    // one OSC bundle with /avatar/parameters/D0..D(n-1) ,i
    public static byte[] Bundle(byte[] packet)
    {
        var b = new List<byte>(1400);
        Str(b, "#bundle"); b.AddRange(new byte[] { 0, 0, 0, 0, 0, 0, 0, 1 });
        for (int i = 0; i < packet.Length; i++)
        {
            var m = new List<byte>(40);
            Str(m, $"/avatar/parameters/D{i}"); Str(m, ",i"); Int(m, packet[i]);
            Int(b, m.Count); b.AddRange(m);
        }
        return b.ToArray();
    }

    public static void Run(byte[][] packets, Func<int, int> schedule, string host, int port, double holdMs, double durationSec, bool bundle)
    {
        using var udp = new UdpClient();
        udp.Connect(host, port);
        var bundles = packets.Select(Bundle).ToArray();
        var singles = bundle ? null : packets.Select(p => Enumerable.Range(0, p.Length).Select(i =>
        {
            var m = new List<byte>(); Str(m, $"/avatar/parameters/D{i}"); Str(m, ",i"); Int(m, p[i]); return m.ToArray();
        }).ToArray()).ToArray();
        bool stop = false;
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop = true; };
        timeBeginPeriod(1);
        try
        {
            var sw = Stopwatch.StartNew();
            for (int k = 0; !stop; k++)
            {
                double target = k * holdMs;
                while (sw.Elapsed.TotalMilliseconds < target - 2) Thread.Sleep(1);
                while (sw.Elapsed.TotalMilliseconds < target) Thread.SpinWait(50);
                int u = schedule(k);
                if (bundle) udp.Send(bundles[u]); else foreach (var m in singles![u]) udp.Send(m);
                if (k % 50 == 0) Console.Write($"\r{k} packets sent ({sw.Elapsed.TotalSeconds:F0} s)   ");
                if (durationSec > 0 && sw.Elapsed.TotalSeconds > durationSec) break;
            }
            Console.WriteLine();
        }
        finally { timeEndPeriod(1); }
    }
}

// sim/lib/schedules-ff.js firstPassWith: units 0..N-1 once, every k-th slot taken by filler(i), then after(i)
public static class FirstPass
{
    public static Func<int, int> With(int n, int k, Func<int, int> filler, Func<int, int> after)
    {
        var seq = new List<int>();
        int next = 0, fk = 0, ak = 0;
        return slot =>
        {
            while (seq.Count <= slot)
            {
                int j = seq.Count;
                if (next < n) seq.Add(k > 0 && j % k == k - 1 ? filler(fk++) : next++);
                else seq.Add(after(ak++));
            }
            return seq[slot];
        };
    }
}

// Windows sleeps in ~15.6 ms steps unless the timer resolution is raised; a 100 ms packet interval needs ~1 ms.
public sealed class TimerResolution : IDisposable
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint p);
    readonly bool active;
    TimerResolution() { if (OperatingSystem.IsWindows()) { timeBeginPeriod(1); active = true; } }
    public static TimerResolution Begin() => new();
    public void Dispose() { if (active) timeEndPeriod(1); }
}
