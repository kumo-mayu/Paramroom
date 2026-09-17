// What the UI shows. The session replaces the whole snapshot on every change (records, never mutated), so a UI can
// compare references to see what changed and never observes a half-updated state.
namespace ImagePad.Session;

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
// ImagePad_Format), the defaults 512/4000 are used.
public sealed record DecoderSpec(DecoderFormatInfo Format, int Ints, int? FormatId, bool Assumed)
{
    public static DecoderSpec Default { get; } = new(DecoderFormat.Default, 32, null, true);

    public int Canvas => Format.R;
    public int Capacity => Format.N;

    public static DecoderSpec For(VrcClient? target)
    {
        if (target is null || target.ImagePadParams <= 0) return Default;
        if (target.Format is int f && DecoderFormat.Known.TryGetValue(f, out var known))
            return new DecoderSpec(known, target.ImagePadParams, f, false);
        return Default with { Ints = target.ImagePadParams };
    }

    public bool SameLayout(DecoderSpec other) => Format.SameFields(other.Format) && Ints == other.Ints;
}

public abstract record EncodeState
{
    private protected EncodeState() { }
    public sealed record Idle() : EncodeState;
    public sealed record Running(int Done, int Total) : EncodeState;
    public sealed record Ready(EncodedImage Image) : EncodeState;
    public sealed record Failed(string Message) : EncodeState;
}

public sealed record EncodedImage(
    DecoderSpec Spec, FitMode Fit, int Aspect, PrimConfig Config, PrimLayout Layout,
    IReadOnlyList<bool[]> Units, double[] Gains, int Prims, double Seconds, Preview Preview);

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
    EncodeState Encode,
    bool SearchingTargets,
    IReadOnlyList<VrcClient> Targets,
    VrcClient? Target,
    string Schedule,
    // milliseconds each packet is held before the next one is sent
    double HoldMs,
    SendState Send)
{
    public static SessionSnapshot Initial { get; } = new(
        null, FitMode.Stretch, new EncodeState.Idle(), false, Array.Empty<VrcClient>(), null, Schedules.Default, 100, new SendState.Idle());
}
