// Fast port of the prim encoder (sim/codecs/prim.js, rotated ellipses, layout s = 1) producing the same wire format.
//
// What "the same" means here: the packets have the same layout and the decoder draws exactly the same picture from
// them (sim/verify-cs.js compares the C# canvas with the JS decoder's render: max difference 0). The chosen primitives
// are NOT bit-identical to the JS encoder's, and cannot be: the climbs run in parallel from separate RNG streams and
// the sums are accumulated in a different order. Quality matches (msssim 0.8747 vs 0.8729 on the same image), and the
// output is deterministic for a given seed and independent of the thread count.
//
// Same greedy search as the JS encoder (error-weighted random candidates, hill climbing of the best few, polish), with
// these speed-ups:
//   - candidate scoring in O(rows) instead of O(pixels): an ellipse covers one contiguous pixel run per row (computed
//     analytically, endpoints checked with the exact pixel-centre test of the decoder), and the per-channel sums the
//     closed-form colour / alpha solve needs (sum c, c^2, t*c, t) come from per-row prefix sums
//   - no subsampled search: every candidate is scored exactly at full resolution
//   - the error map for candidate sampling and the prefix sums are updated only on the rows a new primitive touches
//   - candidate sampling by binary search on per-row error prefix sums; row-invariant ellipse terms precomputed
//   - random candidates are scored in parallel, the climbs run in parallel (each with its own seeded RNG, so the output
//     is deterministic for a given seed and independent of the thread count)
using System.Diagnostics;

namespace ImagePad;

public sealed class PrimConfig
{
    public int Cb = 9, Rb = 8, Ab = 6, ABits = 2, R = 512, MaxPrims = 4000;
    // primitive capacity of the decoder the layout (unit id bits, primitives per unit) is made for; 0 = MaxPrims.
    // Encoding fewer primitives than the decoder holds (MaxPrims < LayoutPrims) just sends fewer units.
    public int LayoutPrims = 0;
    public int[] Col = { 5, 6, 5 };
    public double StopFrac = 2e-5;
    public int NRand = 200, NClimb = 4, MaxAge = 100, MaxIter = 600;
    public uint Seed = 0x5eed;
    public string Label => $"e{Cb}.{Rb}.{Ab}-c{Col[0]}{Col[1]}{Col[2]}a{ABits}-r{R}-n{MaxPrims}";
}

public sealed class PrimLayout
{
    public int U, Pay, K, K0, Units, MaxPrims, PrimBits;
    public int[] Widths = Array.Empty<int>();
    public const int NGeom = 5;

    public static PrimLayout Of(PrimConfig cfg, int P)
    {
        var widths = new[] { cfg.Cb, cfg.Cb, cfg.Rb, cfg.Rb, cfg.Ab, cfg.Col[0], cfg.Col[1], cfg.Col[2], cfg.ABits };
        int primBits = widths.Sum();
        for (int u = 1; u <= 16; u++)
        {
            int pay = P - u;
            if (primBits > pay) continue; // split primitives (s = 2) are not supported here
            int k = pay / primBits, k0 = Math.Max(0, (pay - 16) / primBits);
            int cap = cfg.LayoutPrims > 0 ? cfg.LayoutPrims : cfg.MaxPrims;
            int maxPrims = k0 + (int)Math.Ceiling(Math.Max(0, cap - k0) / (double)k) * k;
            int units = 1 + (maxPrims - k0) / k;
            if (units <= (1 << u)) return new PrimLayout { U = u, Pay = pay, K = k, K0 = k0, Units = units, MaxPrims = maxPrims, PrimBits = primBits, Widths = widths };
        }
        throw new InvalidOperationException("prim: layout does not fit");
    }
    public int SpareBits => Pay - Math.Max(16 + K0 * PrimBits, K * PrimBits);
}

// mulberry32 (sim/lib/transport.js)
public sealed class Mulberry32
{
    uint s;
    public Mulberry32(uint seed) { s = seed; }
    public double Next()
    {
        s += 0x6D2B79F5;
        uint t = s;
        t = (t ^ (t >> 15)) * (1 | t);
        t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t;
        return (t ^ (t >> 14)) / 4294967296.0;
    }
}

public sealed class PrimResult
{
    public required PrimLayout Layout;
    public required List<bool[]> Units;   // P bits each (padded)
    public required double[] Gains;        // gains[0] = +inf (background unit)
    public required double[] Canvas;       // encoder canvas (RGB 0..255) = decoder render
    public int Prims;
    public double Seconds;
}

public sealed unsafe class PrimEncoder
{
    readonly PrimConfig cfg;
    readonly int R, NP, W1;
    readonly double[] tgt, cur, err, errPre, rowErr; // errPre: per row prefix of err (R+1 per row)
    readonly double[] preT;  // per row prefix of t (3 per entry)
    readonly double[] preD;  // per row prefix of c, c^2, t*c per channel (9 per entry)
    readonly int[] gmax = new int[5];
    readonly int[] cLv = new int[3];
    readonly double[] alphas;
    readonly double cmax, rN, aN;

    public PrimEncoder(PrimConfig cfg, Img target)
    {
        if (target.W != cfg.R || target.H != cfg.R) throw new ArgumentException("target must be R x R");
        this.cfg = cfg; R = cfg.R; NP = R * R; W1 = R + 1;
        tgt = target.Data; cur = new double[NP * 3]; err = new double[NP]; errPre = new double[R * W1]; rowErr = new double[R];
        preT = new double[R * W1 * 3]; preD = new double[R * W1 * 9];
        gmax[0] = gmax[1] = (1 << cfg.Cb) - 1; gmax[2] = gmax[3] = (1 << cfg.Rb) - 1; gmax[4] = (1 << cfg.Ab) - 1;
        for (int c = 0; c < 3; c++) cLv[c] = (1 << cfg.Col[c]) - 1;
        int nA = cfg.ABits > 0 ? 1 << cfg.ABits : 1;
        alphas = new double[nA];
        for (int q = 0; q < nA; q++) alphas[q] = cfg.ABits > 0 ? (q + 1.0) / (1 << cfg.ABits) : 0.5;
        cmax = (1 << cfg.Cb) - 1; rN = 1 << cfg.Rb; aN = 1 << cfg.Ab;
    }

    // ---- geometry (shared with the renderer, PrimGeometry.cs)
    PrimGeometry.Ell Geom(ReadOnlySpan<int> codes) => PrimGeometry.Geom(codes, R, cmax, rN, aN);
    static void Span(in PrimGeometry.Ell e, int y, out int xa, out int xb, bool exact = true) => PrimGeometry.Span(e, y, out xa, out xb, exact);

    // ---- scoring: error delta of the shape with the optimal quantized colour / alpha (scoreSums in prim.js)
    struct Score { public double d; public int q, r, g, b; }
    Score Evaluate(ReadOnlySpan<int> codes, bool exact = false)
    {
        var e = Geom(codes);
        long n = 0;
        double St0 = 0, St1 = 0, St2 = 0, Sc0 = 0, Sc1 = 0, Sc2 = 0, Scc0 = 0, Scc1 = 0, Scc2 = 0, Stc0 = 0, Stc1 = 0, Stc2 = 0;
        fixed (double* pT = preT, pD = preD)
        {
            for (int y = e.by0; y <= e.by1; y++)
            {
                Span(e, y, out int xa, out int xb, exact);
                if (xa > xb) continue;
                n += xb - xa + 1;
                double* t1 = pT + (y * W1 + xb + 1) * 3, t0 = pT + (y * W1 + xa) * 3;
                double* d1 = pD + (y * W1 + xb + 1) * 9, d0 = pD + (y * W1 + xa) * 9;
                St0 += t1[0] - t0[0]; St1 += t1[1] - t0[1]; St2 += t1[2] - t0[2];
                Sc0 += d1[0] - d0[0]; Scc0 += d1[1] - d0[1]; Stc0 += d1[2] - d0[2];
                Sc1 += d1[3] - d0[3]; Scc1 += d1[4] - d0[4]; Stc1 += d1[5] - d0[5];
                Sc2 += d1[6] - d0[6]; Scc2 += d1[7] - d0[7]; Stc2 += d1[8] - d0[8];
            }
        }
        var res = new Score { d = 0 };
        if (n == 0) return res;
        double best = double.PositiveInfinity;
        Span<double> Sc = stackalloc double[] { Sc0, Sc1, Sc2 }, Scc = stackalloc double[] { Scc0, Scc1, Scc2 };
        Span<double> Sd = stackalloc double[] { St0 - Sc0, St1 - Sc1, St2 - Sc2 }, Sdc = stackalloc double[] { Stc0 - Scc0, Stc1 - Scc1, Stc2 - Scc2 };
        Span<int> cc = stackalloc int[3];
        for (int q = 0; q < alphas.Length; q++)
        {
            double a = alphas[q], tot = 0;
            for (int ch = 0; ch < 3; ch++)
            {
                double col = Sc[ch] / n + Sd[ch] / (a * n);
                col = col < 0 ? 0 : col > 255 ? 255 : col;
                int lv = cLv[ch], qc = (int)Math.Floor(col / 255 * lv + 0.5);
                double v = qc * 255.0 / lv;
                cc[ch] = qc;
                tot += -2 * a * (v * Sd[ch] - Sdc[ch]) + a * a * (n * v * v - 2 * v * Sc[ch] + Scc[ch]);
            }
            if (tot < best) { best = tot; res.q = q; res.r = cc[0]; res.g = cc[1]; res.b = cc[2]; }
        }
        res.d = best;
        return res;
    }

    // ---- state maintenance
    void RebuildRow(int y)
    {
        double et = 0;
        fixed (double* pT = preT, pD = preD, pt = tgt, pc = cur, pe = err)
        {
            double* t = pT + y * W1 * 3, d = pD + y * W1 * 9;
            for (int k = 0; k < 3; k++) t[k] = 0;
            for (int k = 0; k < 9; k++) d[k] = 0;
            for (int x = 0; x < R; x++)
            {
                int i = y * R + x;
                double* t0 = t + x * 3, t1 = t + (x + 1) * 3, d0 = d + x * 9, d1 = d + (x + 1) * 9;
                double e = 0;
                for (int ch = 0; ch < 3; ch++)
                {
                    double tv = pt[i * 3 + ch], cv = pc[i * 3 + ch], df = tv - cv;
                    t1[ch] = t0[ch] + tv;
                    d1[ch * 3] = d0[ch * 3] + cv; d1[ch * 3 + 1] = d0[ch * 3 + 1] + cv * cv; d1[ch * 3 + 2] = d0[ch * 3 + 2] + tv * cv;
                    e += df * df;
                }
                pe[i] = e; et += e; errPre[y * W1 + x + 1] = et;
            }
        }
        rowErr[y] = et;
    }

    void Apply(ReadOnlySpan<int> codes, in Score sc)
    {
        var e = Geom(codes);
        double a = alphas[sc.q], ia = 1 - a;
        double r = sc.r * 255.0 / cLv[0] * a, g = sc.g * 255.0 / cLv[1] * a, b = sc.b * 255.0 / cLv[2] * a;
        var rows = new List<int>();
        for (int y = e.by0; y <= e.by1; y++)
        {
            Span(e, y, out int xa, out int xb);
            if (xa > xb) continue;
            for (int x = xa; x <= xb; x++)
            {
                int o = (y * R + x) * 3;
                cur[o] = cur[o] * ia + r; cur[o + 1] = cur[o + 1] * ia + g; cur[o + 2] = cur[o + 2] * ia + b;
            }
            rows.Add(y);
        }
        Parallel.ForEach(rows, RebuildRow);
    }

    int SamplePixel(Mulberry32 rnd, double[] rowCum)
    {
        double t = rnd.Next() * rowCum[R - 1];
        int lo = 0, hi = R - 1;
        while (lo < hi) { int m = (lo + hi) >> 1; if (rowCum[m] < t) lo = m + 1; else hi = m; }
        double acc = lo > 0 ? rowCum[lo - 1] : 0;
        int y = lo, row = y * R;
        // first x with acc + prefix(x+1) >= t
        double tt = t - acc; int b0 = y * W1, lx = 0, hx = R - 1;
        while (lx < hx) { int m = (lx + hx) >> 1; if (errPre[b0 + m + 1] < tt) lx = m + 1; else hx = m; }
        return row + lx;
    }

    int ToCode(double x, int f) => Math.Max(0, Math.Min(gmax[f], (int)Math.Floor(x / R * gmax[f] + 0.5)));
    int RadCode(double r) => Math.Max(0, Math.Min((int)rN - 1, (int)Math.Floor(Math.Sqrt(r / (R / 2.0)) * rN - 1 + 0.5)));

    void RandomShape(Span<int> codes, Mulberry32 rnd, double[] rowCum)
    {
        int p = SamplePixel(rnd, rowCum);
        double px = p % R + rnd.Next(), py = p / R + rnd.Next();
        double sz = Math.Exp(Math.Log(1.5) + rnd.Next() * (Math.Log(R / 2.0) - Math.Log(1.5)));
        codes[0] = ToCode(px, 0); codes[1] = ToCode(py, 1);
        codes[2] = RadCode(sz * (0.2 + 0.8 * rnd.Next())); codes[3] = RadCode(sz * (0.2 + 0.8 * rnd.Next()));
        codes[4] = (int)Math.Floor(rnd.Next() * (gmax[4] + 1));
    }

    void Mutate(ReadOnlySpan<int> src, Span<int> dst, Mulberry32 rnd)
    {
        src.CopyTo(dst);
        int nf = rnd.Next() < 0.3 ? 2 : 1;
        int f = (int)Math.Floor(rnd.Next() * 5);
        for (int t = 0; t < nf; t++)
        {
            int m = gmax[f];
            int span = rnd.Next() < 0.5 ? 1 : Math.Max(1, (int)Math.Floor((m + 1) / 16.0 * rnd.Next() * 2 + 0.5));
            int d = (int)Math.Floor((rnd.Next() * 2 - 1) * span + 0.5);
            if (d == 0) d = rnd.Next() < 0.5 ? -1 : 1;
            if (f == 4) dst[f] = (dst[f] + d + m + 1) % (m + 1);
            else dst[f] = Math.Max(0, Math.Min(m, dst[f] + d));
            f = (int)Math.Floor(rnd.Next() * 5);
        }
    }

    sealed class Cand { public int[] Codes = new int[5]; public Score S; }

    void Climb(Cand c, Mulberry32 rnd, int maxAge, int maxIter)
    {
        Span<int> trial = stackalloc int[5];
        for (int age = 0, it = 0; age < maxAge && it < maxIter; it++)
        {
            Mutate(c.Codes, trial, rnd);
            var s = Evaluate(trial);
            if (s.d < c.S.d) { trial.CopyTo(c.Codes); c.S = s; age = 0; } else age++;
        }
    }

    readonly double[] prof = new double[4];
    public PrimResult Encode(int P, Action<int, int>? progress = null, CancellationToken cancellationToken = default)
    {
        var sw = Stopwatch.StartNew();
        var L = PrimLayout.Of(cfg, P);
        // background: quantized mean (bg565)
        double m0 = 0, m1 = 0, m2 = 0;
        for (int i = 0; i < NP; i++) { m0 += tgt[i * 3] / NP; m1 += tgt[i * 3 + 1] / NP; m2 += tgt[i * 3 + 2] / NP; }
        int q0 = (int)Math.Floor(m0 / 255 * 31 + 0.5), q1 = (int)Math.Floor(m1 / 255 * 63 + 0.5), q2 = (int)Math.Floor(m2 / 255 * 31 + 0.5);
        int bgCode = (q0 << 11) | (q1 << 5) | q2;
        double b0 = q0 * 255.0 / 31, b1 = q1 * 255.0 / 63, b2 = q2 * 255.0 / 31;
        for (int i = 0; i < NP; i++) { cur[i * 3] = b0; cur[i * 3 + 1] = b1; cur[i * 3 + 2] = b2; }
        Parallel.For(0, R, RebuildRow);

        var rnd = new Mulberry32(cfg.Seed);
        var cands = Enumerable.Range(0, cfg.NRand).Select(_ => new Cand()).ToArray();
        var rowCum = new double[R];
        var prims = new List<Cand>();
        var hist = new List<double>();
        // requested primitives, rounded up to whole units, within the decoder capacity
        int target = Math.Min(L.MaxPrims, cfg.MaxPrims <= L.K0 ? cfg.MaxPrims : L.K0 + (int)Math.Ceiling((cfg.MaxPrims - L.K0) / (double)L.K) * L.K);
        int target0 = target;
        for (int j = 0; j < target; j++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var pw = Stopwatch.StartNew();
            double acc = 0;
            for (int y = 0; y < R; y++) { acc += rowErr[y]; rowCum[y] = acc; }
            double sse = acc;
            foreach (var c in cands) RandomShape(c.Codes, rnd, rowCum);
            Parallel.For(0, cands.Length, i => cands[i].S = Evaluate(cands[i].Codes));
            prof[0] += pw.Elapsed.TotalSeconds; pw.Restart();
            var order = Enumerable.Range(0, cands.Length).OrderBy(i => cands[i].S.d).ThenBy(i => i).ToArray(); // stable, like Array.sort
            int nClimb = Math.Min(cfg.NClimb, cands.Length);
            var climbs = new Cand[nClimb];
            var seeds = new uint[nClimb];
            for (int ci = 0; ci < nClimb; ci++)
            {
                var src = cands[order[ci]];
                climbs[ci] = new Cand { S = src.S }; src.Codes.CopyTo(climbs[ci].Codes, 0);
                seeds[ci] = (uint)(rnd.Next() * 4294967296.0);
            }
            Parallel.For(0, nClimb, ci => Climb(climbs[ci], new Mulberry32(seeds[ci]), cfg.MaxAge, cfg.MaxIter));
            prof[1] += pw.Elapsed.TotalSeconds; pw.Restart();
            var best = climbs[0];
            for (int ci = 1; ci < nClimb; ci++) if (climbs[ci].S.d < best.S.d) best = climbs[ci];
            Climb(best, rnd, 30, 150); // polish
            best.S = Evaluate(best.Codes, exact: true);
            prof[2] += pw.Elapsed.TotalSeconds; pw.Restart();
            Apply(best.Codes, best.S);
            prof[3] += pw.Elapsed.TotalSeconds;
            prims.Add(best);
            hist.Add(-Math.Min(0, best.S.d));
            // early stop when gains become negligible (keep unit-aligned count)
            if (j + 1 >= 50 && j + 1 < target && target == target0)
            {
                double gain = 0;
                for (int t = hist.Count - 20; t < hist.Count; t++) gain += hist[t];
                if (gain / 20 < cfg.StopFrac * sse) target = L.K0 + (int)Math.Ceiling((j + 1 - L.K0) / (double)L.K) * L.K;
            }
            if (progress != null && (j + 1) % 250 == 0) progress(j + 1, target);
        }

        if (Environment.GetEnvironmentVariable("IMAGEPAD_PROFILE") == "1") Console.Error.WriteLine($"profile: rand {prof[0]:F2} s, climbs {prof[1]:F2} s, polish {prof[2]:F2} s, apply {prof[3]:F2} s");
        // pack (same bit layout as prim.js)
        var units = new List<List<bool>>();
        void Put(List<bool> bits, int v, int w) { for (int i = w - 1; i >= 0; i--) bits.Add(((v >> i) & 1) == 1); }
        List<bool> Header(int id) { var b = new List<bool>(); Put(b, id, L.U); return b; }
        void PutPrim(List<bool> bits, Cand p)
        {
            for (int f = 0; f < 5; f++) Put(bits, p.Codes[f], L.Widths[f]);
            Put(bits, p.S.r, cfg.Col[0]); Put(bits, p.S.g, cfg.Col[1]); Put(bits, p.S.b, cfg.Col[2]);
            if (cfg.ABits > 0) Put(bits, p.S.q, cfg.ABits);
        }
        var u0 = Header(0); Put(u0, bgCode, 16); units.Add(u0);
        int N = prims.Count;
        for (int j = 0; j < Math.Min(N, L.K0); j++) PutPrim(units[0], prims[j]);
        for (int j = L.K0; j < N; j += L.K)
        {
            var u = Header(units.Count);
            for (int t = 0; t < L.K; t++) PutPrim(u, prims[j + t]);
            units.Add(u);
        }
        var gains = new double[units.Count];
        gains[0] = double.PositiveInfinity;
        for (int j = 0; j < N; j++) gains[j < L.K0 ? 0 : 1 + (j - L.K0) / L.K] += hist[j];
        var padded = units.Select(u => { var a = new bool[P]; for (int i = 0; i < u.Count; i++) a[i] = u[i]; return a; }).ToList();
        return new PrimResult { Layout = L, Units = padded, Gains = gains, Canvas = cur, Prims = N, Seconds = sw.Elapsed.TotalSeconds };
    }
}
