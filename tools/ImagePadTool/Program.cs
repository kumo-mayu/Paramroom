// imagepad: prim encoder + OSC sender for the ImagePad avatar decoder (C# port of measure/osc/send-image.js).
//
//   imagepad send   <image> [--R 512] [--n 4000] [--fit stretch|crop] [--epoch 1] [--hold 100] [--duration 0]
//                           [--host 127.0.0.1] [--port 9000] [--no-bundle] [--schedule sqrt|carousel] [--seed N]
//   imagepad encode <image> [--R 512] [--n 4000] [--fit ...] [--out units.json] [--png canvas.png] [--threads N]
//   imagepad send   --units units.json [--epoch ..] ...      (send a previously encoded image)
//   imagepad list                                             (VRChat clients found with OSCQuery)
//
// Destination: by default the VRChat client is found with OSCQuery (vrc-oscquery-lib): the client whose current avatar
// has the Int parameters D0..D31. With several such clients pick one with --client <name part | OSC port>.
// --host/--port send to a fixed address instead (no OSCQuery).
//
// --R / --n must match the avatar prefab: ImagePadPrimDecoder = 256/1000, ImagePadPrimDecoder512n2000 = 512/2000,
// ImagePadPrimDecoder512 = 512/4000 (default).
using System.Globalization;
using System.Text.Json;
using ImagePad;

var argv = args.ToList();
if (argv.Count == 0 || (argv[0] != "send" && argv[0] != "encode" && argv[0] != "list"))
{
    Console.WriteLine("usage: imagepad send|encode <image> [--R 512] [--n 4000] [--fit stretch|crop] [--epoch 1] [--hold 100] [--duration 0] [--port 9000] [--out units.json] [--png out.png] [--units units.json]");
    return 1;
}
string cmd = argv[0];
string? Opt(string name) { int i = argv.IndexOf("--" + name); return i >= 0 && i + 1 < argv.Count ? argv[i + 1] : null; }
double Num(string name, double d) => Opt(name) is string s ? double.Parse(s, CultureInfo.InvariantCulture) : d;
bool Flag(string name) => argv.Contains("--" + name);
if (Opt("threads") is string th) ThreadPool.SetMinThreads(int.Parse(th), int.Parse(th));

if (argv[0] == "list")
{
    foreach (var c in await VrcDiscovery.FindAsync(Num("wait", 3)))
        Console.WriteLine($"{c.Name}: OSC {c.OscIp}:{c.OscPort}, avatar {c.AvatarId}, ImagePad params {c.ImagePadParams}/32{(c.Problem != null ? " (" + c.Problem + ")" : "")}");
    return 0;
}

const int P = 254;
List<bool[]> units; double[] gains; int aspect; int R, n;

if (Opt("units") is string unitsFile)
{
    using var doc = JsonDocument.Parse(File.ReadAllText(unitsFile));
    var root = doc.RootElement;
    R = root.GetProperty("R").GetInt32(); n = root.GetProperty("n").GetInt32(); aspect = root.GetProperty("aspect").GetInt32();
    units = root.GetProperty("units").EnumerateArray().Select(e => e.GetString()!.Select(c => c == '1').ToArray()).ToList();
    gains = root.GetProperty("gains").EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Number ? e.GetDouble() : double.PositiveInfinity).ToArray();
    Console.WriteLine($"loaded {units.Count} units (R {R}, n {n}, aspect {aspect}) from {unitsFile}");
}
else
{
    string file = argv.Count > 1 ? argv[1] : throw new ArgumentException("image path required");
    R = (int)Num("R", 512); n = (int)Num("n", R == 512 ? 4000 : 1000);
    string fit = Opt("fit") ?? "stretch";
    var img = Img.Load(file);
    aspect = fit == "crop" ? Aspect.Code(1, 1) : Aspect.Code(img.W, img.H);
    if (fit == "crop") { int s = Math.Min(img.W, img.H); img = img.Crop((img.W - s) >> 1, (img.H - s) >> 1, s, s); }
    img = img.Resize(R, R);
    var cfg = new PrimConfig { R = R, MaxPrims = n, Cb = R >= 1024 ? 10 : 9 };
    if (Opt("seed") is string seed) cfg.Seed = uint.Parse(seed);
    var L = PrimLayout.Of(cfg, P);
    if (L.SpareBits < 8) throw new InvalidOperationException("no spare byte for the aspect code");
    Console.WriteLine($"encoding {file} ({cfg.Label}, {L.Units} units, {Environment.ProcessorCount} threads)...");
    var res = new PrimEncoder(cfg, img).Encode(P, (j, t) => Console.Write($"\r  {j}/{t} primitives   "));
    Console.WriteLine($"\rencoded {res.Prims} primitives -> {res.Units.Count} units in {res.Seconds:F2} s");
    units = res.Units; gains = res.Gains;
    if (Opt("out") is string outFile)
    {
        using var fs = File.Create(outFile);
        using var w = new Utf8JsonWriter(fs);
        w.WriteStartObject();
        w.WriteString("image", file); w.WriteString("cfg", cfg.Label); w.WriteNumber("R", R); w.WriteNumber("n", n); w.WriteNumber("aspect", aspect);
        w.WriteNumber("encSec", res.Seconds); w.WriteNumber("prims", res.Prims);
        w.WriteStartArray("units"); foreach (var u in units) w.WriteStringValue(new string(u.Select(b => b ? '1' : '0').ToArray())); w.WriteEndArray();
        w.WriteStartArray("gains"); foreach (var g in gains) { if (double.IsFinite(g)) w.WriteNumberValue(g); else w.WriteNullValue(); } w.WriteEndArray();
        w.WriteEndObject();
        Console.WriteLine($"wrote {outFile}");
    }
    if (Opt("png") is string png)
    {
        var bytes = res.Canvas.Select(v => (byte)Math.Max(0, Math.Min(255, Math.Floor(v + 0.5)))).ToArray();
        using var fs = File.Create(png);
        new StbImageWriteSharp.ImageWriter().WritePng(bytes, R, R, StbImageWriteSharp.ColorComponents.RedGreenBlue, fs);
        Console.WriteLine($"wrote {png}");
    }
}

if (cmd == "send")
{
    int epoch = Math.Max(1, Math.Min(3, (int)Num("epoch", 1)));
    double hold = Num("hold", 100), duration = Num("duration", 0);
    string host; int port;
    if (Opt("port") != null) { host = Opt("host") ?? "127.0.0.1"; port = (int)Num("port", 9000); }
    else
    {
        Console.WriteLine("looking for VRChat clients (OSCQuery)...");
        var all = await VrcDiscovery.FindAsync(Num("wait", 3));
        foreach (var c in all) Console.WriteLine($"  {c.Name}: OSC {c.OscIp}:{c.OscPort}, avatar {c.AvatarId}, ImagePad params {c.ImagePadParams}/32{(c.Problem != null ? " (" + c.Problem + ")" : "")}");
        var sel = all.Where(c => c.ImagePadParams == VrcDiscovery.ParamCount).ToList();
        if (Opt("client") is string want) sel = all.Where(c => c.Name.Contains(want) || c.OscPort.ToString() == want).ToList();
        if (sel.Count != 1)
        {
            Console.WriteLine(sel.Count == 0 ? "no VRChat client with the ImagePad parameters D0..D31 found (use --client or --port)" : "several VRChat clients match: choose one with --client <name part | OSC port>");
            return 2;
        }
        host = sel[0].OscIp; port = sel[0].OscPort;
        Console.WriteLine($"-> sending to {sel[0].Name}");
    }
    bool bundle = !Flag("no-bundle");
    var packets = Packets.Build(units, epoch, aspect);
    Func<int, int> schedule;
    if ((Opt("schedule") ?? "sqrt") == "sqrt") { var s = new SqrtSchedule(gains); schedule = k => s[k]; }
    else schedule = k => k % packets.Length;
    Console.WriteLine($"aspect code {aspect} (w/h {Aspect.Ratio(aspect):F3}); sending to {host}:{port}: epoch {epoch}, hold {hold} ms, {(bundle ? "OSC bundle" : "single messages")}. Ctrl+C to stop.");
    OscSender.Run(packets, schedule, host, port, hold, duration, bundle);
}
return 0;
