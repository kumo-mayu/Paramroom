using System.Globalization;
using System.Windows.Data;

namespace ImagePad.App.ViewModels;

public static class Converters
{
    public static IValueConverter Not { get; } = new NotConverter();

    // 空の絵の枠に「次にやること」を出すため
    public static IValueConverter NullToVisible { get; } = new NullToVisibleConverter();

    sealed class NullToVisibleConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is null ? System.Windows.Visibility.Visible : System.Windows.Visibility.Collapsed;
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
    }

    sealed class NotConverter : IValueConverter
    {
        public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is bool b ? !b : true;
        public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => value is bool b ? !b : false;
    }
}
