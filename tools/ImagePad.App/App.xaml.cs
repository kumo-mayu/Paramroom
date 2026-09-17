using System.Windows;
using ImagePad.App.Services;
using ImagePad.App.ViewModels;
using ImagePad.Commands;
using ImagePad.Session;

namespace ImagePad.App;

public partial class App : Application
{
    ImagePadSession? session;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show($"予期しないエラーが起きました。\n\n{args.Exception.Message}", "ImagePad", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };

        // IMAGEPAD_TARGET=host:port[:Int の数[:format]] を付けると、VRChat を探さず決まった宛先に送る（画面の確認用。
        // 受け側は measure/osc/check-sender.js など）。付けなければ OSCQuery で VRChat を探す
        ITargetFinder finder = FixedTargetFinder.FromSpec(Environment.GetEnvironmentVariable("IMAGEPAD_TARGET")) ?? (ITargetFinder)new OscQueryTargetFinder();
        session = new ImagePadSession(finder, c => new UdpOscTransport(c.OscIp, c.OscPort), new WicImageDecoder(), new HttpImageFetcher());
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
        base.OnExit(e);
    }
}
