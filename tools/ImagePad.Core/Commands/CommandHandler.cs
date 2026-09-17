// Routes UiCommand to the session. Only routing here, so the boundary between UI and back end stays one thin layer and
// can be tested without a UI.
using ImagePad.Session;

namespace ImagePad.Commands;

public sealed class CommandHandler(ImagePadSession session)
{
    public async Task<CommandResult> ExecuteAsync(UiCommand command, CancellationToken cancellationToken = default)
    {
        try
        {
            switch (command)
            {
                case UiCommand.LoadImageFile c: await session.LoadFileAsync(c.Path, cancellationToken); break;
                case UiCommand.LoadImageUrl c: await session.LoadUrlAsync(c.Url, cancellationToken); break;
                case UiCommand.LoadImagePixels c: session.SetSource(c.Image, c.Name); break;
                case UiCommand.LoadImageData c: session.LoadBytes(c.Bytes, c.Name); break;
                case UiCommand.ClearHistory: session.ClearHistory(); break;
                case UiCommand.SetFit c: session.SetFit(c.Fit); break;
                case UiCommand.SetPrimCount c: session.SetPrimCount(c.Count); break;
                case UiCommand.RefreshTargets: await session.RefreshTargetsAsync(); break;
                case UiCommand.SelectTarget c: session.SelectTarget(c.Name); break;
                case UiCommand.SetSchedule c: session.SetSchedule(c.Schedule); break;
                case UiCommand.SetHold c: session.SetHold(c.Milliseconds); break;
                case UiCommand.StartSending: await session.StartSendingAsync(); break;
                case UiCommand.StopSending: await session.StopSendingAsync(); break;
                default: return new CommandResult.Failed($"未対応の操作です: {command.GetType().Name}");
            }
            return new CommandResult.Done();
        }
        catch (ImageSourceException e) { return new CommandResult.Failed(e.Message); }
        catch (OperationCanceledException) { return new CommandResult.Done(); }
    }
}
