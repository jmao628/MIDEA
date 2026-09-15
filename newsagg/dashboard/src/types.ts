// Shapes mirror what newsagg.sa_scrape writes to seekingalpha_latest.json.

export interface WidgetRow {
  ticker: string;
  company: string | null;
  rating: string | null;
  article: string | null;
  article_url: string | null;
  analyst: string | null;
}

export interface WidgetGroup {
  label: string;
  rows: WidgetRow[];
}

export interface HomeWidget {
  title: string;
  description: string;
  groups: WidgetGroup[];
}

export interface AnalystPick {
  analyst: string;
  profile_url: string;
  ticker: string;
  rating: string;
  article_title: string;
  article_url: string;
  published: string | null;
  rank: number | null;
}

export interface MyAnalystPick {
  ticker: string;
  rating: string; // Buy | Strong Buy
  article_title: string;
  article_url: string;
  author: string | null;
  published: string | null;
}

export interface SAData {
  generated_at: string | null;
  home_widgets: HomeWidget[];
  analyst_picks: AnalystPick[];
  my_analyst_picks?: MyAnalystPick[];
  top_analysts: { name: string; profile_url: string; rank: number | null }[];
  counts?: Record<string, number>;
  errors?: string[];
}

export type MarketCaps = Record<string, number>; // ticker -> market cap (USD)

export interface HeatTicker {
  mentions: number;
  z: number | null;
  vel: number | null;
  accel: number | null;
  phase: "dead" | "ignite" | "detonate" | "watch" | "ultralow" | "warming";
  days: number;
  series: number[];
  z_series: (number | null)[];
}

export interface HeatData {
  generated_at: string | null;
  params: Record<string, number>;
  tickers: Record<string, HeatTicker>;
}

// Price-volume attention: is a mid/small cap starting to get noticed?
export interface TechAttention {
  score: number; // 0-100 composite attention score
  phase: "breakout" | "igniting" | "accumulating" | "quiet";
  ignites: boolean; // passes price-volume ignition (igniting | breakout)
  rvol: number | null; // 5d avg volume / 20d avg volume
  new_high_20d: boolean;
  new_high_52w: boolean;
  dist_to_high: number | null; // fraction below the 20-day high
  obv_up: boolean; // on-balance-volume rising (accumulation)
  above_sma50: boolean;
  sma50_rising: boolean;
}

// investing.com-style mechanical MA + oscillator aggregate. Display only — lags.
export interface TechGauge {
  summary: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  ma_buy: number;
  ma_sell: number;
  osc_buy: number;
  osc_sell: number;
  osc_neutral: number;
  rsi: number | null;
  macd_hist: number | null;
}

// Bollinger + MACD entry-timing (newsagg.technical.compute_timing). A buy-only
// overlay: the funnel picks a good company, this answers "is now a good price".
export type TimingState =
  | "strong_buy" // 扣扳机: broke the lower band, turned, bounce has strength
  | "band_break" // 跌破下轨: below the lower band now — a buy on a vetted name
  | "oversold_watch" // 埋伏: broke recently, bouncing weakly / not yet confirmed
  | "pullback_buy" // Buy B — 强势回踩: dipped back into the bands after a breakout
  | "momentum" // confirmed uptrend, holding above MA20
  | "breakdown" // 破位·减仓: decisive MA20 break, momentum down, MA20 rolling — de-risk
  | "trim" // 减仓预警: early crack below MA20, momentum weakening — de-risk warning
  | "overheated" // above the upper band — wait for the pullback, don't chase
  | "neutral";

export interface TechTiming {
  timing: TimingState;
  label: string; // Chinese badge label
  score: number; // 0-100, "best entry now" sort key (higher = buy sooner)
  signals: string[]; // active evidence codes (band_break, macd_turn, …) — the "receipts"
  rebound: number; // 0-100 rebound-momentum strength (buy states)
  rebound_parts?: Record<string, number>;
  breakdown: number; // 0-100 breakdown severity (sell states — trim/breakdown)
  breakdown_parts?: Record<string, number>;
  regime: "up" | "down" | "range";
  squeeze: boolean; // Bollinger bandwidth in the bottom 20% of its 120d range
  divergence: boolean; // RSI bullish divergence present
  bb: { upper: number; middle: number; lower: number; pctb: number; bandwidth: number };
  macd: { line: number; signal: number; hist: number; hist_prev: number | null; hist_z: number; cross: "bull" | "bear" };
}

// 0-4 week forward score (newsagg.technical.compute_fwd4w). Weighted by what
// newsagg.calibrate measured on this universe's realised 1/2/4-week returns:
// the edge at this horizon is contrarian, so it rewards being low in the bands
// and lagging, penalises overextended-and-fading, and ignores trend regime,
// MACD momentum and "confirmed" rebounds (none carried forward power).
export interface Fwd4w {
  score: number; // 0-100
  parts: { band: number; below: number; lag: number; dip: number; hot: number }; // hot ≤ 0
  signals: string[]; // at_lower_band · laggard_3m · deep_dip_20d · overextended_fading
  pctb: number;
  mom63: number; // 3-month return
  dd20: number; // ≤ 0: distance below the 20d high
}

// Bollinger rails + MACD histogram over the 60d tail, aligned to close_series.
export interface BandSeries {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
  macd_hist: number[];
}

export interface TechTicker {
  price: number;
  change_pct: number | null;
  atr_pct: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  days: number;
  attention: TechAttention;
  gauge: TechGauge;
  buy_streak?: number; // consecutive recent days reading Buy/Strong-Buy
  timing?: TechTiming | null; // Bollinger+MACD entry timing
  fwd4w?: Fwd4w | null; // 0-4 week forward score (calibrated)
  close_series: number[];
  vol_series: number[];
  band_series?: BandSeries | null;
}

export interface TechnicalData {
  generated_at?: string;
  no_data?: string[]; // seeds technical tried but couldn't price (OTC / foreign ADR)
  tickers: Record<string, TechTicker>;
}

export type SectorData = Record<string, { sector: string; industry: string; name?: string; market_cap?: number }>;

// LLM-derived supply chain (newsagg/supplychain.py). One short reason per edge.
export interface SupplyEdge {
  ticker: string; // US ticker, or "" if not publicly traded / unknown
  name: string;
  reason: string;
  importance?: number; // 1 minor · 2 significant · 3 critical / hard-to-replace
}
export interface SupplyMap {
  upstream: SupplyEdge[];
  downstream: SupplyEdge[];
  peers: SupplyEdge[];
  model?: string;
  ok?: boolean;
}
export type SupplyChainData = Record<string, SupplyMap>;

export interface Health {
  last_attempt: string | null;
  last_success: string | null;
  auth_ok: boolean;
  widgets: number;
}

// One aggregated row for the ranking table.
export interface RankRow {
  ticker: string;
  company: string;
  score: number | null; // best numeric quant/analyst score seen
  badges: string[]; // e.g. ["STRONG BUY"]
  tags: string[]; // which widgets it appears in
  caps: string[]; // cap-size buckets (Large/Mid/Small Cap, ...)
}

// Stage 3 — catalyst discovery (TPMN). Written by newsagg.catalyst.
// Per catalyst: score is MULTIPLICATIVE — (M/3)·(0.4+0.6·P/3)·(0.2+0.8·T/25)·
// (0.7+0.3·N/2)·10, so magnitude leads and scores actually spread (see pipeline).
export interface CatalystTPMN {
  T: number; // timing 0-25 (peak curve on days-to-event, peaks ~2 weeks)
  P: number; // probability / evidence strength 0-3
  M: number; // magnitude / impact 0-3
  N: number; // narrative fit 0-2
  days: number | null; // days to the event (A) or window midpoint (B)
  cls: string; // "A" timed / "B" untimed
  score: number; // 0-10 multiplicative strength (see comment above)
  type: string;
}
export interface Catalyst {
  type: string;
  title: string;
  cls: string;
  event_date: string | null;
  window_days: number | null;
  source_url: string;
  summary: string; // 2-3 sentence write-up of the catalyst
  thesis: string; // short headline clause
  evidence: string; // P/M/N justification
  tpmn: CatalystTPMN;
}
export interface CatalystTicker {
  catalysts: Catalyst[];
  score: number;
  best_type: string | null;
  model: string;
  ok: boolean;
  generated_at: string;
}
export type CatalystData = Record<string, CatalystTicker>;

// Stage 5 — Management Conviction (four-layer tone read). Written by
// newsagg.conviction from an earnings call / filing (the ticker's OWN, or an
// upstream anchor's, read through). Total = L1+L2+L3+L4 ∈ [0,10], summed in
// Python; each layer carries source-text evidence + a 0-1 confidence.
export interface ConvictionLayer {
  score: number; // 0..max
  max: number; // 2 / 3 / 3 / 2
  evidence: string; // short quote / paraphrase from the source
  confidence: number; // 0-1, how well the text pins this grade
}
// Hedging is a language-density suppressor (not an additive layer): the final
// total = raw_total × (1 − 0.15·level). High hedging discounts the whole score.
export interface ConvictionHedging {
  level: number; // 0 crisp … 3 pervasive hedging
  factor: number; // 0.55 … 1.0 multiplier applied to raw_total
  evidence: string; // a representative crisp/hedgy line
  confidence: number;
}
export interface ConvictionTicker {
  layers: { L1: ConvictionLayer; L2: ConvictionLayer; L3: ConvictionLayer; L4: ConvictionLayer };
  hedging: ConvictionHedging;
  raw_total: number; // L1+L2+L3+L4 before the hedging discount (0-10)
  total: number; // 0-10, hedging-discounted (raw_total × factor)
  confidence: number; // 0-1 overall (mean of layers)
  source: "own" | "upstream_anchor";
  anchor_ticker: string; // set when source = upstream_anchor
  anchor_name: string;
  call_ref: string; // e.g. "Q2 FY2026 earnings call"
  call_date: string | null;
  source_url: string; // the actual transcript / filing / Form 4 ("" if none found)
  summary: string; // 3-4 sentence read on management tone
  model: string;
  ok: boolean; // true = a real citation was found
  generated_at: string;
}
export type ConvictionData = Record<string, ConvictionTicker>;

// Growing, dated close history for the backtest watchlist (newsagg.track) — used
// to FORWARD-track a strategy from the day tracking started.
export interface PriceTrack {
  start_date?: string;
  generated_at?: string;
  tickers: Record<string, { dates: string[]; closes: number[] }>;
}
