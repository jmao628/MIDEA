// Backtest engine — runs an entry/exit strategy over each ticker's recent daily
// close series (the `close_series` already in technical_latest.json) and reports
// how the trade POINTS would have performed. Pure functions, so the view can
// recompute live as you drag the controls, and the optimizer can sweep a grid.
//
// Honest scope: the close series is a RECENT window (~the last N trading days),
// so this is a short-horizon "what has been working lately" backtest, not a
// multi-year study. It's for tuning entry/exit points against current behaviour.

// Minimal price source — anything with per-ticker close arrays. Both the trailing
// technical file and the growing forward price-track satisfy this, so the engine
// runs over either without change.
export interface PriceSource {
  tickers?: Record<string, { close_series?: number[] }>;
}

export type EntryKind = "breakout" | "momentum" | "bollinger" | "pullback";

export interface BtParams {
  entry: EntryKind;
  lookback: number; // N-day high (breakout) / momentum lookback
  threshold: number; // momentum return threshold (fraction, e.g. 0.05)
  holdDays: number; // max holding period
  stopLoss: number; // fraction, 0 = off
  takeProfit: number; // fraction, 0 = off
}

export interface Trade {
  ticker: string;
  entry: number; // index into the series
  exit: number;
  ret: number; // fraction
  days: number;
  reason: "hold" | "stop" | "target";
}

export interface TickerStat {
  ticker: string;
  n: number;
  win: number; // win rate 0-1
  avg: number; // avg return per trade
  total: number; // compounded
}

export interface BtResult {
  trades: Trade[];
  n: number;
  winRate: number;
  avg: number;
  median: number;
  total: number; // cumulative P&L, fixed size per trade (Σ of per-trade returns)
  maxDD: number; // max drawdown of the cumulative-P&L curve (≤ 0)
  profitFactor: number; // gross wins / gross losses
  equity: number[]; // cumulative P&L, starts at 0
  hist: { lo: number; hi: number; count: number }[];
  perTicker: TickerStat[];
  benchmark: number; // avg buy-&-hold over the window
  window: number; // series length used
  universe: number; // tickers considered
}

export const ENTRY_META: Record<EntryKind, { en: string; zh: string; usesLookback: boolean; usesThreshold: boolean; desc: { en: string; zh: string } }> = {
  breakout: { en: "Breakout", zh: "突破", usesLookback: true, usesThreshold: false, desc: { en: "close makes a new N-day high", zh: "收盘创 N 日新高" } },
  momentum: { en: "Momentum", zh: "动量", usesLookback: true, usesThreshold: true, desc: { en: "N-day return clears the threshold", zh: "N 日涨幅超过阈值" } },
  bollinger: { en: "Bollinger ride", zh: "布林骑轨", usesLookback: false, usesThreshold: false, desc: { en: "close rides +2σ–+3σ, SMA20 rising", zh: "收盘骑 +2σ~+3σ、SMA20 上行" } },
  pullback: { en: "SMA reclaim", zh: "均线收复", usesLookback: false, usesThreshold: false, desc: { en: "close crosses back above a rising SMA20", zh: "收盘上穿上行的 SMA20" } },
};

const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function stdev(a: number[], m: number): number {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

// Does an entry fire at day i, using data up to and including i?
function fires(c: number[], i: number, p: BtParams): boolean {
  if (p.entry === "breakout") {
    if (i < p.lookback) return false;
    let hi = -Infinity;
    for (let k = i - p.lookback; k < i; k++) hi = Math.max(hi, c[k]);
    return c[i] > hi;
  }
  if (p.entry === "momentum") {
    if (i < p.lookback) return false;
    return c[i] / c[i - p.lookback] - 1 >= p.threshold;
  }
  // bollinger / pullback both need a 20-day window
  if (i < 20) return false;
  const win = c.slice(i - 19, i + 1);
  const sma = mean(win);
  const prev = mean(c.slice(i - 20, i));
  if (p.entry === "bollinger") {
    const sd = stdev(win, sma);
    const upper = sma + 2 * sd;
    const top = sma + 3 * sd;
    return sma > prev && c[i] >= upper && c[i] <= top;
  }
  // pullback: cross back above a rising SMA20
  const smaPrev = mean(c.slice(i - 20, i)); // SMA at i-1 window
  return sma > prev && c[i] > sma && c[i - 1] <= smaPrev;
}

// Walk forward from an entry at i; apply stop / target / max-hold.
function simulate(c: number[], i: number, p: BtParams): Trade | null {
  const last = c.length - 1;
  if (i >= last) return null;
  const e = c[i];
  const stop = p.stopLoss > 0 ? e * (1 - p.stopLoss) : -Infinity;
  const target = p.takeProfit > 0 ? e * (1 + p.takeProfit) : Infinity;
  for (let d = 1; d <= p.holdDays; d++) {
    const j = i + d;
    if (j > last) break;
    const px = c[j];
    if (px <= stop) return { ticker: "", entry: i, exit: j, ret: px / e - 1, days: d, reason: "stop" };
    if (px >= target) return { ticker: "", entry: i, exit: j, ret: px / e - 1, days: d, reason: "target" };
  }
  const j = Math.min(i + p.holdDays, last);
  return { ticker: "", entry: i, exit: j, ret: c[j] / e - 1, days: j - i, reason: "hold" };
}

function warmup(p: BtParams): number {
  if (p.entry === "breakout" || p.entry === "momentum") return Math.max(2, p.lookback);
  return 21;
}

export function runBacktest(tech: PriceSource | null, tickers: string[], p: BtParams): BtResult {
  const trades: Trade[] = [];
  const perT = new Map<string, Trade[]>();
  let benchSum = 0;
  let benchN = 0;
  let win = 0;
  const wu = warmup(p);

  for (const tk of tickers) {
    const c = tech?.tickers?.[tk]?.close_series;
    if (!c || c.length < wu + 2) continue;
    // buy-&-hold baseline over the usable window
    if (c[wu] > 0) {
      benchSum += c[c.length - 1] / c[wu] - 1;
      benchN++;
    }
    let i = wu;
    const tt: Trade[] = [];
    while (i < c.length - 1) {
      if (fires(c, i, p)) {
        const tr = simulate(c, i, p);
        if (tr) {
          tr.ticker = tk;
          trades.push(tr);
          tt.push(tr);
          if (tr.ret > 0) win++;
          i = tr.exit + 1; // no overlapping trades within a ticker
          continue;
        }
      }
      i++;
    }
    if (tt.length) perT.set(tk, tt);
  }

  const rets = trades.map((t) => t.ret);
  const n = trades.length;
  const avg = n ? mean(rets) : 0;
  const sorted = [...rets].sort((a, b) => a - b);
  const median = n ? sorted[Math.floor(n / 2)] : 0;

  // Cumulative P&L over the trade sequence, FIXED SIZE per trade (additive Σ of
  // returns) — not compounded. Compounding many overlapping trades produces an
  // unrealistic exponential-then-crash curve; additive P&L is the honest
  // signal-quality view and its drawdown is meaningful.
  const seq = [...trades].sort((a, b) => a.entry - b.entry || a.exit - b.exit);
  const equity: number[] = [0];
  let peak = 0;
  let maxDD = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const tr of seq) {
    const v = equity[equity.length - 1] + tr.ret;
    equity.push(v);
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v - peak);
    if (tr.ret >= 0) grossWin += tr.ret;
    else grossLoss += -tr.ret;
  }
  const total = equity[equity.length - 1];
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Histogram of per-trade returns (percent bins).
  const edges = [-Infinity, -0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15, Infinity];
  const hist = edges.slice(0, -1).map((lo, k) => ({ lo, hi: edges[k + 1], count: 0 }));
  for (const r of rets) {
    const k = edges.findIndex((_, idx) => idx < edges.length - 1 && r >= edges[idx] && r < edges[idx + 1]);
    if (k >= 0) hist[k].count++;
  }

  const perTicker: TickerStat[] = [...perT.entries()]
    .map(([tk, ts]) => {
      const rs = ts.map((t) => t.ret);
      const tot = ts.reduce((m, t) => m * (1 + t.ret), 1) - 1;
      return { ticker: tk, n: ts.length, win: ts.filter((t) => t.ret > 0).length / ts.length, avg: mean(rs), total: tot };
    })
    .sort((a, b) => b.total - a.total || b.avg - a.avg);

  return {
    trades,
    n,
    winRate: n ? win / n : 0,
    avg,
    median,
    total,
    maxDD,
    profitFactor,
    equity,
    hist,
    perTicker,
    benchmark: benchN ? benchSum / benchN : 0,
    window: tech ? Math.max(0, ...tickers.map((t) => tech.tickers?.[t]?.close_series?.length ?? 0)) : 0,
    universe: tickers.length,
  };
}

// ── Optimizer — a grid sweep over two params, returns each cell's avg return ──
export interface SweepAxis { key: "lookback" | "holdDays" | "takeProfit" | "stopLoss"; label: string; values: number[]; fmt: (v: number) => string }
export interface SweepCell { rv: number; cv: number; avg: number; n: number; total: number }
export interface SweepResult { rows: SweepAxis; cols: SweepAxis; cells: SweepCell[][]; best: { r: number; c: number } | null }

export function optimize(tech: PriceSource | null, tickers: string[], p: BtParams): SweepResult {
  const pct = (v: number) => (v === 0 ? "off" : `${Math.round(v * 100)}%`);
  const holdAxis: SweepAxis = { key: "holdDays", label: "hold (days)", values: [3, 5, 8, 13, 21], fmt: (v) => String(v) };
  const usesLb = ENTRY_META[p.entry].usesLookback;
  const colAxis: SweepAxis = usesLb
    ? { key: "lookback", label: "lookback (N)", values: [5, 10, 15, 20, 30], fmt: (v) => String(v) }
    : { key: "takeProfit", label: "take-profit", values: [0, 0.05, 0.08, 0.12, 0.2], fmt: pct };

  const cells: SweepCell[][] = holdAxis.values.map((rv) =>
    colAxis.values.map((cv) => {
      const params: BtParams = { ...p, holdDays: rv, [colAxis.key]: cv } as BtParams;
      const r = runBacktest(tech, tickers, params);
      return { rv, cv, avg: r.avg, n: r.n, total: r.total };
    }),
  );

  let best: { r: number; c: number } | null = null;
  let bestVal = -Infinity;
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.n >= 8 && cell.avg > bestVal) {
        bestVal = cell.avg;
        best = { r, c };
      }
    }),
  );
  return { rows: holdAxis, cols: colAxis, cells, best };
}
