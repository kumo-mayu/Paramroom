using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Media.Imaging;
using ImagePad.App.ViewModels;

namespace ImagePad.App;

public partial class MainWindow : Window
{
    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
    }

    // Formats a browser puts on a drag, in the order they are read (booth-asset-manager MainWindow.ReadText):
    // Chromium registers CFSTR_INETURLW / CFSTR_INETURLA / text/x-moz-url / CF_UNICODETEXT / CF_TEXT / HTML Format.
    // W and A differ in encoding; reading one as the other garbles the URL.
    static readonly (string Format, bool IsUnicode)[] UrlFormats =
    {
        ("UniformResourceLocatorW", true),
        ("UniformResourceLocator", false),
        ("text/x-moz-url", true),
        (DataFormats.UnicodeText, true),
        (DataFormats.Text, false),
    };

    void OnDragOver(object sender, DragEventArgs e)
    {
        bool usable = SafePresent(e.Data, DataFormats.FileDrop) || SafePresent(e.Data, DataFormats.Html) || SafePresent(e.Data, DataFormats.Bitmap)
                      || UrlFormats.Any(f => SafePresent(e.Data, f.Format));
        e.Effects = usable ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    void OnDrop(object sender, DragEventArgs e)
    {
        var vm = (MainViewModel)DataContext;
        e.Handled = true;
        if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths) { vm.LoadDropped(paths); return; }
        // A picture dragged from a page: the HTML fragment's <img src> is the image. The link URL may be the page it sits
        // in (an <a> around the <img>), which is not an image, so the HTML comes first here.
        if (DropParsing.ImageUrlFromHtml(Read(e.Data, DataFormats.Html, true)) is { } imageUrl) { vm.LoadDroppedUrl(imageUrl); return; }
        foreach (var (format, unicode) in UrlFormats)
            if (DropParsing.UrlFromText(Read(e.Data, format, unicode)) is { } url) { vm.LoadDroppedUrl(url); return; }
        if (SafePresent(e.Data, DataFormats.Bitmap) && e.Data.GetData(DataFormats.Bitmap) is BitmapSource bitmap) vm.LoadDroppedBitmap(bitmap);
    }

    static bool SafePresent(IDataObject data, string format)
    {
        try { return data.GetDataPresent(format); } catch (Exception ex) when (ex is COMException or NotSupportedException) { return false; }
    }

    // registered formats (CFSTR_INETURL*) arrive as raw HGLOBAL bytes with a trailing NUL
    static string? Read(IDataObject data, string format, bool unicode)
    {
        try
        {
            if (!data.GetDataPresent(format)) return null;
            return data.GetData(format) switch
            {
                string text => text,
                MemoryStream stream => (unicode ? Encoding.Unicode : Encoding.Default).GetString(stream.ToArray()).TrimEnd((char)0),
                _ => null,
            };
        }
        // some formats claim to be present but cannot be read; try the next one
        catch (Exception ex) when (ex is COMException or NotSupportedException) { return null; }
    }
}
