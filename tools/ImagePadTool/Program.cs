// imagepad: prim encoder + OSC sender for the ImagePad avatar decoder (C# port of measure/osc/send-image.js).
//
//   imagepad send   <image> [--fit stretch|crop] [--epoch 1] [--schedule fast+sqrt/8(default)|sqrt|fast|fast+sqrtB/k|fast+baseB/k|carousel] [--hold 100] [--duration 0]
//                           [--client <name part | OSC port>] [--wait 3] [--R 512 --n 4000] [--force] [--seed N]
//                           [--host 127.0.0.1 --port 9000] [--no-bundle]
//   imagepad send   --units units.json [...]                  (send a previously encoded image)
//   imagepad encode <image> [--R 512 --n 4000 | --format 3..6] [--fit ...] [--refine 3] [--out units.json] [--png canvas.png]
//   imagepad list                                             (VRChat clients found with OSCQuery)
//
// Destination: by default the VRChat client is found with OSCQuery (vrc-oscquery-lib): the client whose current avatar
// has the Int parameters D0..D31. With several such clients pick one with --client. --port (and --host) send to a fixed
// address instead (no OSCQuery).
// Decoder variant: the prefab's local-only parameter ImagePad_Format (1 = 256/1000, 2 = 512/2000, 3 = 512/4000,
// 4 = 512/4000 light, 5 = 512/5000 light, 6 = 1024/4000) and the number of synced Int parameters D0..D(B-1) (the good
// counts differ per format: 10/18/25/32 for format 3, 9/15/21/26/32 for 4, 9/15/21/27/32 for 5, 11/18/25/32 for 6) are
// read with OSCQuery and select the canvas, the primitive capacity (unit layout) and the packet size automatically.
// --n below the capacity encodes fewer primitives with the same layout (fewer units, the decoder skips missing ones).
// Without OSCQuery data (older prefabs, --port) the defaults are 512/4000 and 32 Int, or --R / --n / --bytes; data that
// does not match the avatar (--R/--n/--bytes or --units) is refused unless --force.
using System.Globalization;
using System.Text.Json;
using ImagePad;

// Without this an unexpected exception prints a stack trace that contains the paths of the machine this was built
// on. Exit inside the handler so the runtime does not print it afterwards.
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    Console.Error.WriteLine("エラー: " + ((e.ExceptionObject as Exception)?.Message ?? e.ExceptionObject.ToString()));
    Environment.Exit(2);
};

var argv = args.ToList();
if (argv.Count == 0 || (argv[0] != "send" && argv[0] != "encode" && argv[0] != "list"))
{
    Console.WriteLine("usage: imagepad send|encode|list [<image>] [--units units.json] [--fit stretch|crop] [--epoch 1] [--schedule fast+sqrt/8(default)|sqrt|fast|fast+sqrtB/k|fast+baseB/k|carousel] [--client name|port] [--R 512 --n 4000] [--out units.json] [--png out.png]");
    return 1;
}
string cmd = argv[0];
string paramPrefix = "";   // the avatar's parameter names (prefixed, or the plain D0.. of avatars built earlier)
string? Opt(string name) { int i = argv.IndexOf("--" + name); return i >= 0 && i + 1 < argv.Count ? argv[i + 1] : null; }
double Num(string name, double d) => Opt(name) is string s ? double.Parse(s, CultureInfo.InvariantCulture) : d;
bool Flag(string name) => argv.Contains("--" + name);

if (cmd == "list")
{
    foreach (var c in await VrcDiscovery.FindAsync(Num("wait", 3))) Console.WriteLine(c);
    return 0;
}

// ---- destination (send) and decoder format
string host = "127.0.0.1"; int port = 9000; int? format = null; int? avatarBytes = null;
if (cmd == "send")
{
    if (Opt("port") != null) { host = Opt("host") ?? host; port = (int)Num("port", 9000); }
    else
    {
        Console.WriteLine("looking for VRChat clients (OSCQuery)...");
        var all = await VrcDiscovery.FindAsync(Num("wait", 3));
        foreach (var c in all) Console.WriteLine("  " + c);
        var sel = all.Where(c => c.ImagePadParams > 0 && c.Problem == null).ToList();
        if (Opt("client") is string want) sel = all.Where(c => c.Name.Contains(want) || c.OscPort.ToString() == want).ToList();
        if (sel.Count != 1)
        {
            Console.WriteLine(sel.Count == 0 ? "no VRChat client with the ImagePad Int parameters D0.. found (use --client or --port)" : "several VRChat clients match: choose one with --client <name part | OSC port>");
            return 2;
        }
        host = sel[0].OscIp; port = sel[0].OscPort; format = sel[0].Format; avatarBytes = sel[0].ImagePadParams; paramPrefix = sel[0].ParamPrefix;
        Console.WriteLine($"-> sending to {sel[0].Name}");
    }
}
if (Opt("format") is string fo) format = int.Parse(fo);
DecoderFormatInfo? avatarFormat = null;
if (format is int f)
{
    if (!DecoderFormat.Known.TryGetValue(f, out var kf)) { Console.WriteLine($"unknown ImagePad_Format {f}"); return 2; }
    avatarFormat = kf;
    Console.WriteLine($"decoder format {f}: canvas {kf.R}, up to {kf.N} primitives");
}
int nBytes = avatarBytes ?? (int)Num("bytes", 32);
if (avatarBytes is int ab && Opt("bytes") is string ob && int.Parse(ob) != ab) { Console.WriteLine($"--bytes {ob} ignored: the avatar has {ab} Int parameters"); }
if (nBytes < 1 || nBytes > 32) { Console.WriteLine($"unsupported Int parameter count {nBytes}"); return 2; }
// r / capacity / bytes of the data vs the avatar's decoder
// fieldBits: the data's primitive bit count (null = the avatar format's own); a light-format avatar reads other widths
bool CheckMatch(int r, int capacity, int bytes, int? fieldBits = null)
{
    bool ok = avatarFormat is not { } af || (af.R == r && af.N == capacity && (fieldBits is null || fieldBits == af.PrimBits));
    ok &= avatarBytes is not int abm || abm == bytes;
    if (ok) return true;
    Console.WriteLine($"the avatar's decoder is {(avatarFormat is { } a2 ? $"{a2.R}/{a2.N}" : "?")} with {(avatarBytes?.ToString() ?? "?")} Int, the data is {r}/{capacity} with {bytes} Int{(Flag("force") ? " (--force: sending anyway)" : "; use matching options or --force")}");
    return Flag("force");
}

int P = 8 * nBytes - 2;
List<bool[]> units; double[] gains; int aspect;

if (Opt("units") is string unitsFile)
{
    using var doc = JsonDocument.Parse(File.ReadAllText(unitsFile));
    var root = doc.RootElement;
    int r = root.GetProperty("R").GetInt32(), n = root.GetProperty("n").GetInt32();
    int cap = root.TryGetProperty("capacity", out var cp) ? cp.GetInt32() : n;
    int fileBytes = root.TryGetProperty("bytes", out var bp) ? bp.GetInt32() : 32;
    aspect = root.GetProperty("aspect").GetInt32();
    units = root.GetProperty("units").EnumerateArray().Select(e => e.GetString()!.Select(c => c == '1').ToArray()).ToList();
    gains = root.GetProperty("gains").EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Number ? e.GetDouble() : double.PositiveInfinity).ToArray();
    Console.WriteLine($"loaded {units.Count} units (R {r}, n {n} of capacity {cap}, {fileBytes} Int, aspect {aspect}) from {unitsFile}");
    int? bitsOfFile = root.TryGetProperty("cb", out var jcb) ? 2 * jcb.GetInt32() + 2 * root.GetProperty("rb").GetInt32() + root.GetProperty("ab").GetInt32() + root.GetProperty("col").EnumerateArray().Sum(e => e.GetInt32()) + root.GetProperty("aBits").GetInt32() : 58;
    if (!CheckMatch(r, cap, fileBytes, bitsOfFile)) return 3;
    nBytes = fileBytes; P = 8 * nBytes - 2;
}
else
{
    string file = argv.Count > 1 && !argv[1].StartsWith("--") ? argv[1] : throw new ArgumentException("image path required");
    int R = Opt("R") != null ? (int)Num("R", 512) : avatarFormat?.R ?? 512;
    int capacity = avatarFormat?.N ?? (Opt("n") != null ? (int)Num("n", 4000) : R == 512 ? 4000 : 1000);
    int n = Opt("n") != null ? (int)Num("n", capacity) : capacity;
    if (n > capacity) { Console.WriteLine($"--n {n} exceeds the decoder capacity {capacity}"); if (!Flag("force")) return 3; }
    if (!CheckMatch(R, capacity, nBytes)) return 3;
    string fit = Opt("fit") ?? "stretch";
    var img = Img.Load(file);
    aspect = fit == "crop" ? Aspect.Code(1, 1) : Aspect.Code(img.W, img.H);
    if (fit == "crop") { int s = Math.Min(img.W, img.H); img = img.Crop((img.W - s) >> 1, (img.H - s) >> 1, s, s); }
    img = img.Resize(R, R);
    // At 1024 the coordinates need 10 bits, and the angle has to give one back (5) or the packet loses the 8 spare
    // bits the aspect code needs - that is what decoder format 6 does, so --R 1024 matches it by default.
    var cfg = avatarFormat is { } fmt && fmt.R == R ? fmt.Config(n)
        : new PrimConfig { R = R, MaxPrims = n, LayoutPrims = capacity, Cb = R >= 1024 ? 10 : 9, Ab = R >= 1024 ? 5 : 6 };
    // precision experiments (bits per field); the avatar decoder must be built with the same widths
    if (Opt("cb") is string ocb) cfg.Cb = int.Parse(ocb);
    if (Opt("rb") is string orb) cfg.Rb = int.Parse(orb);
    if (Opt("ab") is string oab) cfg.Ab = int.Parse(oab);
    // docs/research/08 §15: re-fit the primitives afterwards (encoder only, the packets are unchanged)
    if (Opt("refine") is string orf) cfg.RefineSweeps = int.Parse(orf);
    if (Opt("refine-iters") is string ori) cfg.RefineIters = int.Parse(ori);
    if (Opt("batch") is string obp) cfg.BatchPlace = int.Parse(obp);
    if (Opt("nclimb") is string onc) cfg.NClimb = int.Parse(onc);
    if (Opt("abits") is string oal) cfg.ABits = int.Parse(oal);
    if (Opt("col") is string ocol) cfg.Col = ocol.Split(',').Select(int.Parse).ToArray();
    if (Opt("seed") is string seed) cfg.Seed = uint.Parse(seed);
    var L = PrimLayout.Of(cfg, P);
    if (L.SpareBits < 8) throw new InvalidOperationException("no spare byte for the aspect code");
    Console.WriteLine($"encoding {file} ({cfg.Label}, {nBytes} Int: {L.K} primitives/packet, unit id {L.U} bits, capacity {L.Units} units, {Environment.ProcessorCount} threads)...");
    var res = new PrimEncoder(cfg, img).Encode(P, (j, t) => Console.Write($"\r  {j}/{t} primitives   "));
    Console.WriteLine($"\rencoded {res.Prims} primitives -> {res.Units.Count} units in {res.Seconds:F2} s");
    units = res.Units; gains = res.Gains;
    if (Opt("out") is string outFile)
    {
        using var fs = File.Create(outFile);
        using var w = new Utf8JsonWriter(fs);
        w.WriteStartObject();
        w.WriteString("image", file); w.WriteString("cfg", cfg.Label); w.WriteNumber("cb", cfg.Cb); w.WriteNumber("rb", cfg.Rb); w.WriteNumber("ab", cfg.Ab); w.WriteNumber("aBits", cfg.ABits); w.WriteStartArray("col"); foreach (var cc in cfg.Col) w.WriteNumberValue(cc); w.WriteEndArray(); w.WriteNumber("R", R); w.WriteNumber("n", n); w.WriteNumber("capacity", capacity); w.WriteNumber("bytes", nBytes); w.WriteNumber("aspect", aspect);
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
    bool bundle = !Flag("no-bundle");
    var packets = Packets.Build(units, epoch, aspect, nBytes);
    int N = packets.Length;
    // sqrt: square-root rule from the start (late joiners); fast: every unit once in greedy order first (viewers already
    // present get more detail sooner, e.g. 512/4000 at 10 s 0.892 vs 0.871), then the square-root rule; carousel: units in
    // order, repeated. sim/results/fastfirst.md: fast is worse for viewers joining during the first pass (N x 100 ms).
    // also the first-pass variants of sim/lib/schedules-ff.js: fast+sqrt/k, fast+sqrtB/k, fast+baseB/k
    string sched = Opt("schedule") ?? "fast+sqrt/8"; // default chosen from measure/results/2026-09-17/fastfirst (2026-09-17)
    if (Schedules.Create(sched, gains) is not { } schedule) { Console.WriteLine($"unknown schedule {sched}"); return 2; }
    Console.WriteLine($"aspect code {aspect} (w/h {Aspect.Ratio(aspect):F3}); sending {packets.Length} units x {nBytes} Int to {host}:{port}: epoch {epoch}, schedule {sched}, hold {hold} ms, {(bundle ? "OSC bundle" : "single messages")}. Ctrl+C to stop.");
    OscSender.Run(packets, schedule, host, port, hold, duration, bundle, paramPrefix);
}
return 0;
