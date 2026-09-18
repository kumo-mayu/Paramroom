// What the UI shows. The session replaces the whole snapshot on every change (records, never mutated), so a UI can
// compare references to see what changed and never observes a half-updated state.
namespace Paramroom.Session;

public enum FitMode
{
    // the whole image, stretched to the square canvas; the avatar restores the aspect ratio
    Stretch,
    // the centre square only
    Crop,
}

// RGB bytes (rows top-down) for display
public sealed record Preview(byte[] Rgb, int Width, int Height);

public sealed record SourceInfo(string Name, int Width, int Height, Preview Preview);

// What the avatar's decoder expects. Assumed = the avatar did not tell (no target yet, or a prefab without
// Paramroom_Format), the defaults 512/4000 are used. Unknown = the avatar named a format this build does not know
// (an avatar newer than the app): the defaults are used too, but the user has to be told, because sending 512 data
// to a decoder that expects something else produces a broken picture rather than a slightly worse one.
public sealed record DecoderSpec(DecoderFormatInfo Format, int Ints, int? FormatId, bool Assumed, bool Unknown = false)
{
    public static DecoderSpec Default { get; } = new(DecoderFormat.Default, 32, null, true);

    public int Canvas => Format.R;
    public int Capacity => Format.N;

    // QR 専用のデコーダー（docs/research/09 §6）。画像は出せないが Int 3 個から動く。
    // 図形が無いので Format の中身は使わない（下の IsQrOnly を見てから分岐すること）。
    public bool IsQrOnly => FormatId == DecoderFormat.QrOnlyId;
    // 画面に出す名前。QR 専用のときは Format の中身に意味が無いので、そちらを見せない
    public string DisplayName => IsQrOnly ? DecoderFormat.QrOnlyName : Format.Name;

    public static DecoderSpec For(VrcClient? target)
    {
        if (target is null || target.ParamroomParams <= 0) return Default;
        if (target.Format == DecoderFormat.QrOnlyId)
            return new DecoderSpec(DecoderFormat.Default, target.ParamroomParams, DecoderFormat.QrOnlyId, false);
        if (target.Format is int f && DecoderFormat.Known.TryGetValue(f, out var known))
            return new DecoderSpec(known, target.ParamroomParams, f, false);
        if (target.Format is int unknown)
            return Default with { Ints = target.ParamroomParams, FormatId = unknown, Unknown = true };
        return Default with { Ints = target.ParamroomParams };
    }

    public bool SameLayout(DecoderSpec other) => Format.SameFields(other.Format) && Ints == other.Ints;

    // n x n の QR がこの送信先で何パケットになるか。入らない組み合わせなら null。
    // 「QR は一瞬で出ます」は Int の数と QR の大きさで大きく変わる（3 Int なら短い URL でも 3.2 秒）ので、
    // 画面には決め打ちの文言ではなくこの値から作った文を出す。
    public int? QrPackets(int modules)
    {
        if (IsQrOnly)
            return QrOnly.LayoutFor(Ints) is { } q ? QrOnly.UnitsNeeded(q, modules) : null;
        try
        {
            var layout = PrimLayout.Of(Format.Config(Format.N), 8 * Ints - 2);
            return layout.SpareBits < 8 ? null : QrMode.UnitsNeeded(layout, modules);
        }
        catch (InvalidOperationException) { return null; }
    }
}

public abstract record EncodeState
{
    private protected EncodeState() { }
    public sealed record Idle() : EncodeState;
    public sealed record Running(int Done, int Total) : EncodeState;
    public sealed record Ready(EncodedImage Image) : EncodeState;
    public sealed record Failed(string Message) : EncodeState;
}

// Qr = the units hold a QR code's modules instead of primitives (docs/research/09). The packets are the same shape;
// a bit in every packet tells the avatar which one it is, so any prefab can show either.
// QrOnlyLayout != null = QR 専用のデコーダー向け（docs/research/09 §6）。Config と Layout は図形用の
// 値なので意味を持たない。絵を描くときはこちらを見ること。
public sealed record EncodedImage(
    DecoderSpec Spec, FitMode Fit, int? RequestedPrims, int Aspect, PrimConfig Config, PrimLayout Layout,
    IReadOnlyList<bool[]> Units, double[] Gains, int Prims, double Seconds, Preview Preview, bool Qr = false,
    QrOnly.Layout? QrOnlyLayout = null);

public sealed record SendProgress(
    int Epoch, string Schedule, string TargetName, long PacketsSent, int DistinctUnits, int TotalUnits,
    TimeSpan Elapsed, Preview? Received);

public abstract record SendState
{
    private protected SendState() { }
    public sealed record Idle() : SendState;
    public sealed record Active(SendProgress Progress) : SendState;
    // stopped by the user (or the image changed); the last progress stays visible
    public sealed record Stopped(SendProgress Progress) : SendState;
    public sealed record Failed(string Message) : SendState;
}

public sealed record SessionSnapshot(
    SourceInfo? Source,
    FitMode Fit,
    // primitives to encode; null = as many as the avatar's decoder holds. Fewer primitives = fewer packets = shorter lap
    int? PrimCount,
    EncodeState Encode,
    bool SearchingTargets,
    IReadOnlyList<VrcClient> Targets,
    VrcClient? Target,
    string Schedule,
    // milliseconds each packet is held before the next one is sent
    double HoldMs,
    SendState Send,
    // recently loaded files and URLs, newest first
    IReadOnlyList<HistoryEntry> History)
{
    public static SessionSnapshot Initial { get; } = new(
        null, FitMode.Stretch, null, new EncodeState.Idle(), false, Array.Empty<VrcClient>(), null, Schedules.Default, 100, new SendState.Idle(), Array.Empty<HistoryEntry>());
}
