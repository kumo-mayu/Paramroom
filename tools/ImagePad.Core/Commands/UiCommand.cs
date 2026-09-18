// Requests from a UI to the back end. A UI only builds these and passes them to CommandHandler; it never calls the
// services directly, so screens can be changed or replaced without touching the logic (the pattern of
// booth-asset-manager / vrc-osc-recorder). The cases are all in this file.
using ImagePad.Session;

namespace ImagePad.Commands;

public abstract record UiCommand
{
    private protected UiCommand() { }

    public sealed record LoadImageFile(string Path) : UiCommand;

    public sealed record LoadImageUrl(string Url) : UiCommand;

    // already decoded pixels (e.g. pasted from the clipboard)
    public sealed record LoadImagePixels(Img Image, string Name) : UiCommand;

    // encoded image bytes (e.g. a data: URI dropped from a browser)
    public sealed record LoadImageData(byte[] Bytes, string Name) : UiCommand;

    // a QR code made from this text, instead of a picture. Empty goes back to the picture.
    public sealed record LoadQrText(string Text) : UiCommand;

    public sealed record ClearHistory() : UiCommand;

    public sealed record SetFit(FitMode Fit) : UiCommand;

    // null = the avatar decoder's capacity
    public sealed record SetPrimCount(int? Count) : UiCommand;

    public sealed record RefreshTargets() : UiCommand;

    public sealed record SelectTarget(string Name) : UiCommand;

    public sealed record SetSchedule(string Schedule) : UiCommand;

    // packet interval in ms; applies immediately, also while sending
    public sealed record SetHold(double Milliseconds) : UiCommand;

    // starts sending the encoded image with the next epoch; while sending, restarts with the current image
    public sealed record StartSending() : UiCommand;

    public sealed record StopSending() : UiCommand;
}

public abstract record CommandResult
{
    private protected CommandResult() { }

    public sealed record Done() : CommandResult;

    // something the user can act on; Message is shown as is
    public sealed record Failed(string Message) : CommandResult;
}
