// Send orders by name (sim/lib/schedules-ff.js). The default fast+sqrt/8 was chosen on 2026-09-17 from
// measure/results/2026-09-17/fastfirst: viewers present from the start get most of the fast first pass, viewers joining
// during it still get a coarse image within ~20 s.
using System.Text.RegularExpressions;

namespace Paramroom;

public static class Schedules
{
    public const string Default = "fast+sqrt/8";

    // sqrt: square-root rule from the start; fast: every unit once in greedy order, then sqrt;
    // fast+sqrt/k, fast+sqrtB/k, fast+baseB/k: fast first pass with every k-th slot given to the sqrt rule (over all units
    // or the first B) or to re-sending units 0..B-1; carousel: units in order, repeated. null for an unknown name.
    public static Func<int, int>? Create(string name, double[] gains)
    {
        int n = gains.Length;
        if (name == "sqrt") { var s = new SqrtSchedule(gains); return k => s[k]; }
        if (name == "fast") { var s = new SqrtSchedule(gains); return k => k < n ? k : s[k - n]; }
        if (name == "carousel") return k => k % n;
        var m = Regex.Match(name, @"^fast\+(sqrt|base)(\d*)/(\d+)$");
        if (!m.Success) return null;
        int b = m.Groups[2].Value == "" ? n : Math.Min(n, int.Parse(m.Groups[2].Value)), every = int.Parse(m.Groups[3].Value);
        Func<int, int> filler;
        if (m.Groups[1].Value == "base") filler = i => i % b;
        else { var sf = new SqrtSchedule(gains.Take(b).ToArray()); filler = i => sf[i]; }
        var sq = new SqrtSchedule(gains);
        return FirstPass.With(n, every, filler, k => sq[k]);
    }
}
