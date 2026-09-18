using System.Net;
using System.Text;
using Paramroom;
using Paramroom.Session;

namespace Paramroom.Core.Tests;

// VRChat が見つかった後は、アバターを替えても「VRChat を探し直す」のではなく「アバターを読み直す」だけで済むこと。
// 以前は Paramroom の入っていないアバターを着ていると、10 秒ごとに OSCQuery サービスを作り直して
// 新しいポートで名乗り直していた。
public class ConnectionTests
{
    // VRChat の OSCQuery を真似る最小の HTTP サーバー。HOST_INFO と、今のアバターのパラメータの木を返す
    sealed class FakeVrchat : IDisposable
    {
        readonly HttpListener http = new();
        public int Port { get; }
        public volatile bool HasParamroom;
        public volatile string AvatarId = "avtr_plain";

        public FakeVrchat()
        {
            for (Port = 47100; ; Port++)
            {
                try { http.Prefixes.Clear(); http.Prefixes.Add($"http://127.0.0.1:{Port}/"); http.Start(); break; }
                catch (HttpListenerException) when (Port < 47200) { }
            }
            _ = Task.Run(Serve);
        }

        async Task Serve()
        {
            while (http.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await http.GetContextAsync(); } catch { return; }
                string body = ctx.Request.Url!.Query.Contains("HOST_INFO")
                    ? """{"NAME":"VRChat-Client-Fake","OSC_IP":"127.0.0.1","OSC_PORT":9000,"OSC_TRANSPORT":"UDP","EXTENSIONS":{"ACCESS":true,"CLIPMODE":false,"RANGE":true,"TYPE":true,"VALUE":true}}"""
                    : Tree();
                var bytes = Encoding.UTF8.GetBytes(body);
                ctx.Response.ContentType = "application/json";
                ctx.Response.ContentLength64 = bytes.Length;
                await ctx.Response.OutputStream.WriteAsync(bytes);
                ctx.Response.Close();
            }
        }

        string Tree()
        {
            static string Node(string name, string type, string value) =>
                $"\"{name}\":{{\"FULL_PATH\":\"/avatar/parameters/{name}\",\"ACCESS\":3,\"TYPE\":\"{type}\",\"VALUE\":[{value}]}}";
            var ps = new List<string>();
            if (HasParamroom)
            {
                for (int i = 0; i < 32; i++) ps.Add(Node($"Paramroom_D{i}", "i", "0"));
                ps.Add(Node("Paramroom_Format", "i", "4"));
            }
            ps.Add(Node("VelocityX", "f", "0.0"));
            return "{\"FULL_PATH\":\"/\",\"ACCESS\":0,\"CONTENTS\":{\"avatar\":{\"FULL_PATH\":\"/avatar\",\"ACCESS\":0,\"CONTENTS\":{"
                + $"\"change\":{{\"FULL_PATH\":\"/avatar/change\",\"ACCESS\":3,\"TYPE\":\"s\",\"VALUE\":[\"{AvatarId}\"]}},"
                + "\"parameters\":{\"FULL_PATH\":\"/avatar/parameters\",\"ACCESS\":0,\"CONTENTS\":{" + string.Join(",", ps) + "}}}}}}";
        }

        public void Dispose() { http.Stop(); http.Close(); }
    }

    // mDNS で見つけた VRChat を返す役。何回探し直したかを数え、アバターの切り替えを知らせられる
    sealed class Finder(FakeVrchat vrc) : ITargetFinder, IAvatarChangeSource
    {
        public int Searches;
        public event Action<string>? AvatarChanged;
        public void Swap(string id) => AvatarChanged?.Invoke(id);

        public async Task<IReadOnlyList<VrcClient>> FindAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Searches);
            return new[] { await VrcDiscovery.InspectAsync("VRChat-Client-Fake", IPAddress.Loopback, vrc.Port) };
        }
    }

    static ParamroomSession NewSession(ITargetFinder finder, TimeSpan scan) =>
        new(finder, _ => throw new InvalidOperationException(), new StbImageDecoder(), new HttpImageFetcher(),
            new SessionOptions { TargetScanInterval = scan, AvatarChangeSettle = TimeSpan.FromMilliseconds(10) });

    static async Task Until(Func<bool> done, int ms = 5000)
    {
        for (int t = 0; t < ms && !done(); t += 20) await Task.Delay(20);
    }

    [Fact]
    public async Task APlainAvatarDoesNotMakeItSearchAgain()
    {
        using var vrc = new FakeVrchat();
        var finder = new Finder(vrc);
        await using var session = NewSession(finder, TimeSpan.FromMilliseconds(30));
        await session.RefreshTargetsAsync();
        Assert.Single(session.Snapshot.Targets);        // VRChat is there
        Assert.Null(session.Snapshot.Target);           // but its avatar has no Paramroom
        await Task.Delay(400);                          // a dozen scans
        Assert.Equal(1, finder.Searches);               // only read again, never searched again

        vrc.HasParamroom = true;                        // put on a Paramroom avatar
        await Until(() => session.Snapshot.Target is not null);
        Assert.NotNull(session.Snapshot.Target);        // picked up by reading the avatar again
        Assert.Equal(32, session.Snapshot.Target!.ParamroomParams);
        Assert.Equal(1, finder.Searches);
    }

    [Fact]
    public async Task AnAvatarChangeIsReadAtOnce()
    {
        using var vrc = new FakeVrchat();
        var finder = new Finder(vrc);
        // the periodic scan is far away, so only the /avatar/change report can find the new avatar in time
        await using var session = NewSession(finder, TimeSpan.FromHours(1));
        await session.RefreshTargetsAsync();
        Assert.Null(session.Snapshot.Target);

        vrc.HasParamroom = true; vrc.AvatarId = "avtr_paramroom";
        finder.Swap("avtr_paramroom");
        await Until(() => session.Snapshot.Target is not null, 2000);
        Assert.Equal("avtr_paramroom", session.Snapshot.Target?.AvatarId);
        Assert.Equal(1, finder.Searches);
    }

    [Fact]
    public async Task ItSearchesAgainWhenVrchatStopsAnswering()
    {
        var vrc = new FakeVrchat();
        vrc.HasParamroom = true;
        var finder = new Finder(vrc);
        await using var session = NewSession(finder, TimeSpan.FromMilliseconds(30));
        await session.RefreshTargetsAsync();
        Assert.NotNull(session.Snapshot.Target);
        vrc.Dispose();                                  // VRChat quits (or restarts on another port)
        await Until(() => finder.Searches > 1);
        Assert.True(finder.Searches > 1);
        Assert.Null(session.Snapshot.Target);
    }

    static byte[] Osc(string address, string arg)
    {
        var b = new List<byte>();
        void Str(string s) { b.AddRange(Encoding.UTF8.GetBytes(s)); b.Add(0); while (b.Count % 4 != 0) b.Add(0); }
        Str(address); Str(",s"); Str(arg);
        return b.ToArray();
    }

    [Fact]
    public void ReadsTheAvatarIdFromAMessageOrABundle()
    {
        Assert.Equal(new[] { "avtr_1234" }, OscParse.AvatarChanges(Osc("/avatar/change", "avtr_1234")));
        Assert.Empty(OscParse.AvatarChanges(Osc("/avatar/parameters/Foo", "x")));

        var m = Osc("/avatar/change", "avtr_abc");
        var bundle = new List<byte>();
        bundle.AddRange(Encoding.ASCII.GetBytes("#bundle\0"));
        bundle.AddRange(new byte[] { 0, 0, 0, 0, 0, 0, 0, 1 });
        bundle.AddRange(new byte[] { 0, 0, 0, (byte)m.Length });
        bundle.AddRange(m);
        Assert.Equal(new[] { "avtr_abc" }, OscParse.AvatarChanges(bundle.ToArray()));

        Assert.Empty(OscParse.AvatarChanges(new byte[] { 1, 2, 3 }));   // garbage is ignored, not thrown
    }
}
