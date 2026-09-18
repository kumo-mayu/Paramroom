using System.Windows;
using Paramroom.App.Services;
using Paramroom.App.ViewModels;
using Paramroom.Commands;
using Paramroom.Session;

namespace Paramroom.App;

public partial class App : Application
{
    ParamroomSession? session;
    ITargetFinder? finder;   // owns the OSCQuery service (VrcConnection) for the life of the app

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show($"予期しないエラーが起きました。\n\n{args.Exception.Message}", "Paramroom", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };

        // PARAMROOM_TARGET=host:port[:Int の数[:format]] を付けると、VRChat を探さず決まった宛先に送る（画面の確認用。
        // 受け側は measure/osc/check-sender.js など）。付けなければ OSCQuery で VRChat を探す
        finder = FixedTargetFinder.FromSpec(Environment.GetEnvironmentVariable("PARAMROOM_TARGET")) ?? (ITargetFinder)new OscQueryTargetFinder();
        session = new ParamroomSession(finder, c => new UdpOscTransport(c.OscIp, c.OscPort), new WicImageDecoder(), new HttpImageFetcher(),
            history: new JsonFileHistory(JsonFileHistory.DefaultPath()));
        var handler = new CommandHandler(session);
        var vm = new MainViewModel(session, handler);
        var window = new MainWindow(vm);
        MainWindow = window;
        window.Show();
        _ = handler.ExecuteAsync(new UiCommand.RefreshTargets());
    }

    protected override void OnExit(ExitEventArgs e)
    {
        // 止めずに閉じると送信のスレッドが残り、プロセスが終わらない
        session?.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3));
        (finder as IDisposable)?.Dispose();   // stops announcing the OSCQuery service
        base.OnExit(e);
    }
}
