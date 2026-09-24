// Transforms the scraped SeekingAlpha snapshot into the SuperBeta pipeline's
// data shapes. Only Stage-1 (seed table) and the ticker universe are real
// today; heat / catalyst / conviction / technical are computed later and are
// surfaced as "pending" in their views.

import type { Catalyst, CatalystData, CatalystTPMN, CatalystTicker, ConvictionData, ConvictionTicker, HeatData, MarketCaps, SAData, TechnicalData, TechTicker, TechTiming, SectorData, SupplyChainData } from "../types";

// yfinance GICS sectors → short Chinese labels.
export const SECTOR_CN: Record<string, string> = {
  Technology: "科技",
  Healthcare: "医疗",
  "Financial Services": "金融",
  "Consumer Cyclical": "可选消费",
  "Consumer Defensive": "必需消费",
  Industrials: "工业",
  Energy: "能源",
  "Basic Materials": "原材料",
  "Communication Services": "通讯",
  Utilities: "公用",
  "Real Estate": "地产",
};

export function sectorCN(sector: string | undefined): string {
  if (!sector) return "其他";
  return SECTOR_CN[sector] ?? sector;
}

// Lang-aware label: English keeps yfinance's own English sector; Chinese maps it.
export function sectorLabel(sector: string | undefined, lang: "en" | "zh"): string {
  if (!sector) return lang === "zh" ? "其他" : "—";
  return lang === "zh" ? SECTOR_CN[sector] ?? sector : sector;
}

export type CatalystType =
  | "earnings"
  | "guidance"
  | "new_order"
  | "policy"
  | "m_and_a"
  | "other"
  | "unknown";

export type Role = "upstream" | "downstream" | "unknown";

export interface SeedRow {
  src: string; // SeekingAlpha | Substack | Schwab YT | X
  date: string | null;
  author: string | null;
  followers: string | null; // pending until we join follower counts
  ticker: string;
  company: string;
  reasoning: string; // article thesis / summary (only for analyst-thesis rows)
  articleUrl: string | null; // link to the analyst's SeekingAlpha article
  evidence: string | null;
  catalyst: CatalystType; // pending real LLM classification
  role: Role; // pending real LLM classification
  weight: number | null; // author weight — pending whitelist join
  rating: string | null; // best display rating (BUY/STRONG BUY or quant score)
  quant: number | null; // best numeric quant score
  tags: string[]; // SA widgets it appears in (Quant/Coverage/Ideas/...)
  hasThesis: boolean; // appears in "Most Compelling Analyst Ideas" (analyst wrote a bull thesis)
}

export interface UniStock {
  ticker: string;
  company: string;
  quant: number | null; // best numeric quant score across widgets
  rated: boolean; // has an SA rating (quant score or BUY/STRONG BUY) somewhere
  tags: string[]; // widgets it appears in
  caps: string[]; // cap-size buckets
}

const NUM_RE = /^[0-5]\.\d{2}$/;

function shortTag(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("quant rating")) return "Quant";
  if (t.includes("analyst coverage")) return "Coverage";
  if (t.includes("top quant")) return "TopQuant";
  if (t.includes("compelling")) return "Ideas";
  if (t.includes("strong buy")) return "StrongBuy";
  if (t.includes("value idea")) return "Value";
  if (t.includes("dividend")) return "Dividend";
  if (t.includes("growth idea")) return "Growth";
  if (t.includes("momentum")) return "Momentum";
  if (t.includes("profitab")) return "Profit";
  if (t.includes("eps revision")) return "EPS";
  return title.split(" ").slice(0, 2).join(" ");
}

export function companyMap(data: SAData | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const w of data?.home_widgets ?? [])
    for (const g of w.groups)
      for (const r of g.rows) if (r.company && !m.has(r.ticker)) m.set(r.ticker, r.company);
  return m;
}

// Stage-1 seeds: every bullish SeekingAlpha ticker across all widgets, one
// deduped row per ticker. Rows that appear in "Most Compelling Analyst Ideas"
// (an analyst actually wrote a bull thesis) are flagged hasThesis and carry
// the author + article; the rest are quant/coverage-list bulls. Thesis rows
// sort first, then by quant score.
export function buildSeeds(data: SAData | null): SeedRow[] {
  if (!data) return [];
  const cmap = companyMap(data);
  const map = new Map<string, SeedRow>();

  for (const w of data.home_widgets) {
    const tag = shortTag(w.title);
    for (const g of w.groups) {
      for (const r of g.rows) {
        const cur: SeedRow =
          map.get(r.ticker) ??
          {
            src: "SeekingAlpha",
            date: data.generated_at ? data.generated_at.slice(0, 10) : null,
            author: null,
            followers: null,
            ticker: r.ticker,
            company: r.company ?? cmap.get(r.ticker) ?? "",
            reasoning: "",
            articleUrl: null,
            evidence: null,
            catalyst: "unknown",
            role: "unknown",
            weight: null,
            rating: null,
            quant: null,
            tags: [],
            hasThesis: false,
          };

        if (!cur.tags.includes(tag)) cur.tags.push(tag);
        if (r.company && !cur.company) cur.company = r.company;
        if (r.rating) {
          if (NUM_RE.test(r.rating)) {
            const n = parseFloat(r.rating);
            cur.quant = cur.quant == null ? n : Math.max(cur.quant, n);
            if (!cur.rating) cur.rating = r.rating;
          } else {
            cur.rating = r.rating; // BUY / STRONG BUY wins for display
          }
        }
        // Any row an analyst wrote a thesis for (author + article) is a ★ seed,
        // regardless of which "… Ideas" widget it came from.
        if (r.analyst || r.article) {
          cur.hasThesis = true;
          if (r.analyst) cur.author = r.analyst;
          if (r.article && !cur.reasoning) {
            cur.reasoning = r.article;
            cur.articleUrl = r.article_url;
          }
        }
        map.set(r.ticker, cur);
      }
    }
  }

  // Merge in the "My Analysts" feed — recent Buy/Strong Buy articles from the
  // analysts you follow. These are always ★ thesis seeds (author + article).
  for (const p of data.my_analyst_picks ?? []) {
    const cur: SeedRow =
      map.get(p.ticker) ??
      {
        src: "SeekingAlpha",
        date: p.published,
        author: null,
        followers: null,
        ticker: p.ticker,
        company: cmap.get(p.ticker) ?? "",
        reasoning: "",
        articleUrl: null,
        evidence: null,
        catalyst: "unknown",
        role: "unknown",
        weight: null,
        rating: null,
        quant: null,
        tags: [],
        hasThesis: false,
      };
    cur.hasThesis = true;
    if (p.author) cur.author = p.author;
    if (p.article_title && !cur.reasoning) {
      cur.reasoning = p.article_title;
      cur.articleUrl = p.article_url;
    }
    if (p.rating) cur.rating = p.rating;
    if (p.published) cur.date = p.published;
    if (!cur.tags.includes("MyAnalyst")) cur.tags.push("MyAnalyst");
    map.set(p.ticker, cur);
  }

  return [...map.values()].sort((a, b) => {
    if (a.hasThesis !== b.hasThesis) return a.hasThesis ? -1 : 1;
    return (b.quant ?? -1) - (a.quant ?? -1);
  });
}

export type CapSize = "large" | "mid" | "small" | "unknown";

// Infer cap size from the SA widget cap-group labels a ticker appears in
// (Large Cap / S&P 500, Mid Cap / Mid Cap 400, Small Cap / Small Cap 600).
export function capSizeOf(caps: string[]): CapSize {
  const j = caps.join(" ").toLowerCase();
  if (j.includes("large") || j.includes("s&p 500")) return "large";
  if (j.includes("small")) return "small";
  if (j.includes("mid")) return "mid";
  return "unknown";
}

// Cap-size from real market cap (USD), falling back to SA cap-group labels
// when we don't have a market cap for the ticker. Large ≥ $10B, Mid ≥ $2B.
export function capSizeFromCap(marketCap: number | undefined, labels: string[]): CapSize {
  if (marketCap && marketCap > 0) {
    if (marketCap >= 10e9) return "large";
    if (marketCap >= 2e9) return "mid";
    return "small";
  }
  return capSizeOf(labels);
}

// Only true mega caps are "already discovered" enough to skip social heat.
// Everything below this still runs the heat/discovery funnel.
export const BYPASS_MARKET_CAP = 100e9; // ≥ $100B

// Confirmed no-data tickers (technical tried and failed = OTC/foreign). A seed
// that's merely absent from technical (added since the last run) is NOT here, so
// it still shows while it waits to be fetched.
export function noDataSet(technical: TechnicalData | null): Set<string> {
  return new Set(technical?.no_data ?? []);
}

export function bypassesHeat(marketCap: number | undefined): boolean {
  return !!marketCap && marketCap >= BYPASS_MARKET_CAP;
}

// Static safety-net set of well-known US large-caps (~$10B+). Used ONLY as a
// last-resort cap signal for the ecosystem graph's gold/blue ring split when
// neither sectors.json's market_cap nor the (flaky) marketcaps.json feed has a
// value — e.g. NVDA/MSFT/AMD when yfinance's fast_info dropped them. Once
// sectors.json backfills market_cap (python -m newsagg.sectors), that reliable
// number takes over and this list is just a floor.
export const LARGE_CAP_TICKERS = new Set<string>([
  // Semis & semicap
  "NVDA", "AMD", "INTC", "MU", "AVGO", "QCOM", "TXN", "AMAT", "ADI", "LRCX", "KLAC", "MCHP",
  "MRVL", "NXPI", "ON", "STM", "SWKS", "QRVO", "MPWR", "TER", "ENPH", "FSLR", "SNPS", "CDNS",
  // Tech hardware / software / services
  "AAPL", "MSFT", "ORCL", "CRM", "NOW", "INTU", "ADBE", "IBM", "ACN", "CSCO", "ANET", "APH",
  "TEL", "GLW", "HPQ", "HPE", "DELL", "WDC", "STX", "PANW", "CRWD", "FTNT", "SNOW", "PLTR",
  "WDAY", "TEAM", "DDOG", "ZS", "NET", "SNX",
  // Communication services
  "GOOGL", "GOOG", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS",
  // Consumer
  "AMZN", "TSLA", "HD", "LOW", "NKE", "MCD", "SBUX", "BKNG", "TGT", "WMT", "COST", "PG",
  "KO", "PEP", "PM", "MO", "CL", "KMB", "MDLZ", "MNST", "EL",
  // Financials
  "BRK-B", "JPM", "BAC", "WFC", "C", "GS", "MS", "AXP", "BLK", "SPGI", "SCHW", "USB", "PNC",
  "TFC", "COF", "MMC", "ICE", "CME", "V", "MA", "PYPL",
  // Healthcare
  "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "AMGN", "BMY", "GILD",
  "CVS", "CI", "ELV", "ISRG", "MDT", "SYK", "BSX", "VRTX", "REGN",
  // Industrials
  "CAT", "DE", "HON", "UNP", "UPS", "BA", "GE", "MMM", "LMT", "RTX", "NOC", "GD", "EMR",
  "ETN", "ITW", "CSX", "NSC", "FDX", "PH", "ZBRA",
  // Energy
  "XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "VLO", "OXY", "WMB", "KMI", "OKE",
  // Materials
  "LIN", "APD", "SHW", "FCX", "NEM", "ECL", "DOW", "DD", "NUE",
  // Utilities
  "NEE", "DUK", "SO", "D", "AEP", "EXC", "SRE", "XEL",
  // Real estate
  "AMT", "PLD", "CCI", "EQIX", "PSA", "O", "SPG", "WELL", "DLR",
]);

// Seeds held out of the ranked universe: any name with NO numeric SA quant
// Micro-caps too small to be worth ranking — e.g. PERF, a $1.92 / ~$195M penny
// stock. This is the ONLY inclusion filter on the seed universe: everything else
// stays (including thesis-only names with no SA rating). Only names with a KNOWN
// market cap below the floor are cut, so a name still pending its market-cap
// fetch isn't dropped by mistake.
export const MIN_MARKET_CAP = 3e8; // $300M
export function belowMinCap(
  data: SAData | null,
  marketCaps: MarketCaps | null,
): Set<string> {
  const out = new Set<string>();
  for (const s of buildSeeds(data)) {
    const mc = marketCaps?.[s.ticker];
    if (mc != null && mc < MIN_MARKET_CAP) out.add(s.ticker);
  }
  return out;
}

// Passes the heat gate if it's a mega cap (bypass), OR social heat has
// ignited/detonated, OR price-volume attention has ignited. The last lane is
// what lets thinly-discussed mid/small caps through — social mentions are too
// sparse for them, but volume/breakout/OBV show accumulation first.
export function passesHeatGate(
  marketCap: number | undefined,
  phase: string,
  attnIgnites = false,
): boolean {
  return (
    bypassesHeat(marketCap) || phase === "ignite" || phase === "detonate" || attnIgnites
  );
}

export function buildUniverse(data: SAData | null): UniStock[] {
  const map = new Map<string, UniStock>();
  for (const w of data?.home_widgets ?? []) {
    const tag = shortTag(w.title);
    for (const g of w.groups) {
      for (const r of g.rows) {
        const cur =
          map.get(r.ticker) ??
          ({ ticker: r.ticker, company: r.company ?? "", quant: null, rated: false, tags: [], caps: [] } as UniStock);
        if (r.rating) {
          cur.rated = true; // any rating cell (quant score or BUY/STRONG BUY)
          if (NUM_RE.test(r.rating)) {
            const n = parseFloat(r.rating);
            cur.quant = cur.quant == null ? n : Math.max(cur.quant, n);
          }
        }
        if (r.company && !cur.company) cur.company = r.company;
        if (!cur.tags.includes(tag)) cur.tags.push(tag);
        if (g.label && !cur.caps.includes(g.label)) cur.caps.push(g.label);
        map.set(r.ticker, cur);
      }
    }
  }
  return [...map.values()].sort((a, b) => (b.quant ?? -1) - (a.quant ?? -1));
}

// Stage 2 — Rankings. The whole rated seed universe (all ~277) is ranked by
// several independent lenses (price-volume attention, raw relative volume,
// momentum, social heat). The top `topN` of EACH lens advances to Stage 3 —
// so a name can qualify by volume even if it's socially silent, and vice
// versa. Mega caps auto-advance (already discovered). This replaces the old
// binary ignite gate, which surfaced too few names.
export interface RankItem {
  ticker: string;
  company: string;
  cap: CapSize;
  sector: string; // raw yfinance sector ("" if unknown)
  value: number;
  display: string;
  rank: number;
  meetsBar: boolean; // value clears this lens's minimum threshold
  inTop: boolean; // top-N of this lens AND clears the bar (the ranking path)
  strongBuy: boolean; // technical gauge = 强力买入 (a separate advance path)
  advancing: boolean; // inTop || strongBuy
}

export interface BiText {
  en: string;
  zh: string;
}

export interface Ranking {
  key: string;
  label: BiText;
  desc: BiText;
  rows: RankItem[];
}

export interface StrongBuyItem {
  ticker: string;
  company: string;
  cap: CapSize;
  sector: string;
  score: number; // price-volume attention score (for sorting)
  rvol: number | null;
}

export interface RankBundle {
  rankings: Ranking[];
  advancing: Set<string>; // union of every lens's top-N (+ mega caps)
  advancingBy: Map<string, string[]>; // ticker -> lens keys it advanced in
  strongBuys: StrongBuyItem[]; // every rated ticker with a 强力买入 gauge, sorted
  universe: number; // rated seed count
}

interface Lens {
  key: string;
  label: BiText;
  desc: BiText;
  min: number; // value must clear this to count as "ignited" (else stays dim)
  get: (t: string) => number | null;
  fmt: (v: number) => string;
  tie?: (t: string) => number; // continuous tiebreaker when many share a score
}

export function buildRankings(
  data: SAData | null,
  _heat: HeatData | null, // social-heat lens removed; kept positional for callers
  technical: TechnicalData | null,
  marketCaps: MarketCaps | null,
  sectors: SectorData | null = null,
  topN = 10,
): RankBundle {
  // Rated seeds, minus confirmed no-data OTC/foreign ADRs (newly-added seeds
  // pending their first fetch still count — they're not confirmed no-data).
  const noData = noDataSet(technical);
  const tiny = belowMinCap(data, marketCaps);
  const uni = buildUniverse(data).filter(
    (u) => u.rated && !noData.has(u.ticker) && !tiny.has(u.ticker),
  );
  const cmap = companyMap(data);
  const capsByTicker = new Map(uni.map((u) => [u.ticker, u.caps]));
  const capOf = (t: string) => capSizeFromCap(marketCaps?.[t], capsByTicker.get(t) ?? []);
  const sectorOf = (t: string) => sectors?.[t]?.sector ?? "";
  const attn = (t: string) => technical?.tickers?.[t]?.attention;
  const isStrongBuy = (t: string) => technical?.tickers?.[t]?.gauge?.summary === "strong_buy";

  const momentum = (t: string): number | null => {
    const cs = technical?.tickers?.[t]?.close_series;
    if (!cs || cs.length < 2 || !cs[0]) return null;
    return (cs[cs.length - 1] / cs[0] - 1) * 100;
  };

  // `min` = the "达标" bar. A name in the top-N still stays dim (not 入选) unless
  // it clears the bar — so on a weak day nothing lights up rather than forcing it.
  const lenses: Lens[] = [
    {
      key: "rvol",
      label: { en: "Relative Volume", zh: "放量 RVOL" },
      desc: { en: "5-day / 20-day avg volume · bar 1.5×", zh: "近 5 日 / 20 日均量,达标线 1.5×" },
      min: 1.5,
      get: (t) => attn(t)?.rvol ?? null,
      fmt: (v) => `${v.toFixed(2)}×`,
    },
    {
      key: "momentum",
      label: { en: "Momentum 60d", zh: "动量 60 日" },
      desc: { en: "Return over last 60 trading days · bar +10%", zh: "近 60 个交易日涨幅,达标线 +10%" },
      min: 10,
      get: (t) => momentum(t),
      fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
    },
  ];

  const rankings: Ranking[] = [];
  const advancing = new Set<string>();
  const advancingBy = new Map<string, string[]>();

  for (const L of lenses) {
    const rows: RankItem[] = uni
      .map((u) => ({ t: u.ticker, v: L.get(u.ticker) }))
      .filter((x): x is { t: string; v: number } => x.v != null && !Number.isNaN(x.v))
      .sort((a, b) => b.v - a.v || (L.tie?.(b.t) ?? 0) - (L.tie?.(a.t) ?? 0))
      .map((x, i) => {
        const meetsBar = x.v >= L.min;
        const inTop = i < topN && meetsBar;
        const strongBuy = isStrongBuy(x.t);
        return {
          ticker: x.t,
          company: cmap.get(x.t) ?? "",
          cap: capOf(x.t),
          sector: sectorOf(x.t),
          value: x.v,
          display: L.fmt(x.v),
          rank: i + 1,
          meetsBar,
          inTop,
          strongBuy,
          advancing: inTop || strongBuy,
        };
      });
    if (!rows.length) continue;
    rankings.push({ key: L.key, label: L.label, desc: L.desc, rows });
    for (const r of rows) {
      if (!r.inTop) continue; // ranking path: top-N clearing the bar
      advancing.add(r.ticker);
      advancingBy.set(r.ticker, [...(advancingBy.get(r.ticker) ?? []), L.key]);
    }
  }

  // Strong-Buy path: any rated ticker whose technical gauge reads 强力买入
  // advances regardless of rank (not tied to the top-10 line).
  for (const u of uni) {
    if (isStrongBuy(u.ticker)) {
      advancing.add(u.ticker);
      const prev = advancingBy.get(u.ticker) ?? [];
      if (!prev.includes("strongbuy")) advancingBy.set(u.ticker, [...prev, "strongbuy"]);
    }
  }

  // Mega caps are already discovered — auto-advance them.
  for (const u of uni) {
    if (bypassesHeat(marketCaps?.[u.ticker])) {
      advancing.add(u.ticker);
      if (!advancingBy.has(u.ticker)) advancingBy.set(u.ticker, ["bypass"]);
    }
  }

  // Full 强力买入 list, sorted by attention score (then RVOL), for its own card.
  const strongBuys: StrongBuyItem[] = uni
    .filter((u) => isStrongBuy(u.ticker))
    .map((u) => ({
      ticker: u.ticker,
      company: cmap.get(u.ticker) ?? "",
      cap: capOf(u.ticker),
      sector: sectorOf(u.ticker),
      score: attn(u.ticker)?.score ?? 0,
      rvol: attn(u.ticker)?.rvol ?? null,
    }))
    .sort((a, b) => b.score - a.score || (b.rvol ?? 0) - (a.rvol ?? 0));

  return { rankings, advancing, advancingBy, strongBuys, universe: uni.length };
}

// Screen — the *quality net*, run in PARALLEL with Heat (not downstream of it).
// A seed is a screen candidate when it (0) has an SA rating (quant score or
// BUY/STRONG BUY — thesis-only mentions with no rating, e.g. IREN, don't
// qualify) AND (1) has author quality — proxied by an analyst thesis until an
// author whitelist exists. Whether it ALSO cleared the attention board (Heat)
// is recorded as `advanced` (the overlap is what later stages act on) but is no
// longer a gate — so Screen and Heat are two independent lenses.
export type GateVia = "bypass" | "social" | "volume";

export interface ScreenRow {
  ticker: string;
  company: string;
  cap: CapSize;
  bypass: boolean; // mega cap that skipped social heat
  advanced: boolean; // also cleared the Heat attention board (the overlap)
  via: GateVia; // if advanced, how it cleared the attention board
  lenses: string[]; // ranking lenses it advanced in (attention/rvol/momentum/social)
  phase: string | null; // social heat phase
  attnPhase: string | null; // price-volume attention phase
  attnScore: number | null;
  rvol: number | null;
  hasThesis: boolean;
  author: string | null;
  reasoning: string;
  articleUrl: string | null;
  rating: string | null;
  z: number | null;
}

const CAP_RANK: Record<CapSize, number> = { large: 0, mid: 1, small: 2, unknown: 3 };

export function buildScreen(
  data: SAData | null,
  heat: HeatData | null,
  marketCaps: MarketCaps | null,
  technical: TechnicalData | null,
): { candidates: ScreenRow[]; total: number; passedHeat: number } {
  const seeds = buildSeeds(data);
  const uniCaps = new Map(buildUniverse(data).map((u) => [u.ticker, u.caps]));
  const { advancing, advancingBy } = buildRankings(data, heat, technical, marketCaps);
  const noData = noDataSet(technical);
  const tiny = belowMinCap(data, marketCaps);
  const candidates: ScreenRow[] = [];
  let passedHeat = 0;

  for (const s of seeds) {
    // Confirmed no-data (OTC / foreign ADR) → out. Pending new seeds stay.
    if (noData.has(s.ticker)) continue;
    // Unrated small-cap (text-only rating, < $2B) → out.
    if (tiny.has(s.ticker)) continue;
    // Quality net: must have an SA rating AND an analyst thesis. Independent of Heat.
    if (s.rating == null && s.quant == null) continue;
    if (!s.hasThesis) continue;
    const mc = marketCaps?.[s.ticker];
    const cap = capSizeFromCap(mc, uniCaps.get(s.ticker) ?? []);
    const ht = heat?.tickers?.[s.ticker];
    const phase = ht?.phase ?? null;
    const attn = technical?.tickers?.[s.ticker]?.attention;
    // Overlap with the Heat attention board (recorded, not gated).
    const advanced = advancing.has(s.ticker);
    const lenses = advancingBy.get(s.ticker) ?? [];
    if (advanced) passedHeat++;
    const via: GateVia = bypassesHeat(mc)
      ? "bypass"
      : lenses.includes("social") && !lenses.some((l) => l !== "social")
        ? "social"
        : "volume";
    candidates.push({
      ticker: s.ticker,
      company: s.company,
      cap,
      bypass: bypassesHeat(mc),
      advanced,
      via,
      lenses,
      phase,
      attnPhase: attn?.phase ?? null,
      attnScore: attn?.score ?? null,
      rvol: attn?.rvol ?? null,
      hasThesis: s.hasThesis,
      author: s.author,
      reasoning: s.reasoning,
      articleUrl: s.articleUrl,
      rating: s.rating,
      z: ht?.z ?? null,
    });
  }

  // Overlap (in both nets) first, then by cap, then by heat z / attention.
  candidates.sort(
    (a, b) =>
      Number(b.advanced) - Number(a.advanced) ||
      CAP_RANK[a.cap] - CAP_RANK[b.cap] ||
      (b.z ?? -99) - (a.z ?? -99) ||
      (b.attnScore ?? -1) - (a.attnScore ?? -1),
  );
  // Seed pool = deduped bulls minus confirmed no-data and report-only (matches
  // the seed table's "All").
  const total = seeds.filter((s) => !noData.has(s.ticker) && !tiny.has(s.ticker)).length;
  return { candidates, total, passedHeat };
}

export const CATALYST_CN: Record<CatalystType, string> = {
  earnings: "财报",
  guidance: "指引",
  new_order: "新订单",
  policy: "政策",
  m_and_a: "并购",
  other: "其他",
  unknown: "待定",
};

export const ROLE_CN: Record<Role, string> = {
  upstream: "上游",
  downstream: "下游",
  unknown: "待定",
};

export const CATALYST_EN: Record<CatalystType, string> = {
  earnings: "Earnings",
  guidance: "Guidance",
  new_order: "New Order",
  policy: "Policy",
  m_and_a: "M&A",
  other: "Other",
  unknown: "TBD",
};

export const ROLE_EN: Record<Role, string> = {
  upstream: "Upstream",
  downstream: "Downstream",
  unknown: "TBD",
};

export const CAP_LABEL: Record<CapSize, { en: string; zh: string }> = {
  large: { en: "Large", zh: "大盘" },
  mid: { en: "Mid", zh: "中盘" },
  small: { en: "Small", zh: "小盘" },
  unknown: { en: "—", zh: "—" },
};

export function capLabel(cap: CapSize, lang: "en" | "zh"): string {
  return lang === "zh" ? CAP_LABEL[cap].zh : CAP_LABEL[cap].en;
}

// ── Bollinger+MACD entry-timing display ──────────────────────────────────────
// Presentation for the timing state computed in newsagg.technical. `tone` maps
// to the UI's color roles: green = a buy signal now, amber = wait, slate = idle.

export type TimingTone = "buy" | "watch" | "hot" | "idle" | "sell" | "trim";

export const TIMING_META: Record<
  TechTiming["timing"],
  { en: string; zh: string; tone: TimingTone; hint: { en: string; zh: string } }
> = {
  strong_buy: { en: "Strong Buy", zh: "强买入", tone: "buy", hint: { en: "broke the lower band + confirmed turn", zh: "跌破下轨 + 拐头确认" } },
  band_break: { en: "Band Break", zh: "跌破下轨", tone: "buy", hint: { en: "below the lower band — a discount on a vetted name", zh: "跌破布林下轨——好票打折,买入信号" } },
  oversold_watch: { en: "Oversold", zh: "超卖埋伏", tone: "watch", hint: { en: "broke recently, bouncing weakly — not yet confirmed", zh: "近期跌破，弱反弹，未确认" } },
  pullback_buy: { en: "Pullback Buy", zh: "强势回踩", tone: "buy", hint: { en: "dipped back into the bands after a breakout", zh: "突破后回落进轨道内" } },
  momentum: { en: "Momentum", zh: "动能确定", tone: "hot", hint: { en: "confirmed uptrend, holding above MA20", zh: "上涨趋势确认，站稳 MA20" } },
  breakdown: { en: "Breakdown", zh: "破位·减仓", tone: "sell", hint: { en: "broke MA20, momentum down, MA20 rolling — de-risk", zh: "跌破 MA20、动能向下、均线掉头——减仓去风险" } },
  trim: { en: "Trim", zh: "减仓预警", tone: "trim", hint: { en: "early crack below MA20, momentum weakening — de-risk", zh: "初步跌破 MA20、动能转弱——减仓预警" } },
  overheated: { en: "Overheated", zh: "过热·等回落", tone: "hot", hint: { en: "above the upper band — wait for the pullback", zh: "突破上轨，等回落进轨道再买" } },
  neutral: { en: "—", zh: "观望", tone: "idle", hint: { en: "no entry signal", zh: "无买点信号" } },
};

// Sell states — de-risk WARNINGS, never a hard exit. Kept separate from the buy
// count so they show under their own tabs.
export const TIMING_SELL_STATES: TechTiming["timing"][] = ["breakdown", "trim"];

export function timingLabel(state: TechTiming["timing"], lang: "en" | "zh"): string {
  return lang === "zh" ? TIMING_META[state].zh : TIMING_META[state].en;
}

// The concrete evidence chips behind a timing state — the "why it's a buy".
// tone: "buy" green · "hot" violet (overheated) · "info" blue (context).
export const SIGNAL_META: Record<string, { en: string; zh: string; tone: "buy" | "hot" | "info" | "sell" }> = {
  band_break: { en: "Broke lower band", zh: "跌破下轨", tone: "buy" },
  macd_capitulation: { en: "MACD extreme low", zh: "MACD 极度负", tone: "buy" },
  macd_turn: { en: "MACD turning up", zh: "MACD 拐头", tone: "buy" },
  rsi_divergence: { en: "RSI divergence", zh: "RSI 底背离", tone: "buy" },
  capitulation: { en: "Capitulation volume", zh: "恐慌放量", tone: "buy" },
  reclaim: { en: "Reclaimed band", zh: "收复下轨", tone: "buy" },
  pullback: { en: "Pullback into bands", zh: "回落轨道内", tone: "buy" },
  squeeze: { en: "Bollinger squeeze", zh: "布林收口", tone: "info" },
  uptrend_hold: { en: "Holding above MA20", zh: "站稳 MA20", tone: "info" },
  above_upper: { en: "Above upper band", zh: "突破上轨", tone: "hot" },
  // sell-side receipts
  broke_ma20: { en: "Broke MA20", zh: "跌破 MA20", tone: "sell" },
  macd_death_cross: { en: "MACD death cross", zh: "MACD 死叉", tone: "sell" },
  macd_weakening: { en: "Momentum down", zh: "动能转弱", tone: "sell" },
  ma20_rolling: { en: "MA20 rolling over", zh: "MA20 掉头", tone: "sell" },
  below_ma50: { en: "Lost MA50", zh: "跌破 MA50", tone: "sell" },
  breakdown_volume: { en: "Distribution volume", zh: "破位放量", tone: "sell" },
  // 0-4 week forward-score receipts (calibrated: the edge at this horizon is contrarian)
  at_lower_band: { en: "At the lower band now", zh: "此刻跌破下轨·折扣", tone: "buy" },
  laggard_3m: { en: "3-month laggard", zh: "3个月落后·均值回归", tone: "buy" },
  deep_dip_20d: { en: "Deep 20d dip", zh: "20日深回撤", tone: "buy" },
  overextended_fading: { en: "Overextended, fading", zh: "贴上轨·动能衰减", tone: "hot" },
  // narrative layer — logic-weighted (can't be calibrated on price history)
  catalyst_4w: { en: "Catalyst within 4 weeks", zh: "4周内有催化剂", tone: "info" },
  conviction_strong: { en: "Management conviction", zh: "管理层语气强", tone: "info" },
};

// "Best entry now" sort key: the timing score, or -1 when a name has no timing
// data yet (so it sinks below anything that does).
export function timingSortKey(tech: TechTicker | null | undefined): number {
  return tech?.timing ? tech.timing.score : -1;
}

// The states that are an ACTIONABLE buy right now (green badges) — used for the
// funnel count and to order the Buy-Timing board.
export const TIMING_BUY_STATES: TechTiming["timing"][] = ["strong_buy", "band_break", "pullback_buy"];
// Display order on the Buy-Timing board: buy signals first, idle last.
export const TIMING_ORDER: TechTiming["timing"][] = [
  "strong_buy",
  "band_break",
  "pullback_buy",
  "oversold_watch",
  "momentum",
  "breakdown",
  "trim",
  "overheated",
  "neutral",
];

export interface TimingRow {
  ticker: string;
  company: string;
  sector: string;
  tier: 1 | 2 | 3;
  composite: number; // Shortlist composite strength, for context
  timing: TechTiming;
  forward: ForwardScore | null; // 0-4 week forward score (null until technical carries fwd4w)
}

// Join the Shortlist (the vetted, good companies) with their live entry-timing
// and 0-4 week forward score so the Buy-Timing page can answer "which good name
// is the best buy for the next month". Ordered by the forward score (the
// calibrated ranking key), falling back to the timing score for names that
// don't carry one yet, then composite strength.
export function buildTimingBoard(
  shortlist: LeaderRow[],
  technical: TechnicalData | null,
  catalyst: CatalystData | null = null,
  catalystData: CatalystData | null = null,
  conviction: ConvictionData | null = null,
): TimingRow[] {
  if (!technical) return [];
  const rows: TimingRow[] = [];
  for (const r of shortlist) {
    const tech = technical.tickers?.[r.ticker];
    const tm = tech?.timing;
    if (!tm) continue;
    const forward = buildForward(tech, catalyst?.[r.ticker] ?? null, catalystData?.[r.ticker] ?? null, conviction?.[r.ticker] ?? null);
    rows.push({ ticker: r.ticker, company: r.company, sector: r.sector, tier: r.tier, composite: r.composite, timing: tm, forward });
  }
  rows.sort((a, b) => forwardSortKey(b) - forwardSortKey(a) || b.composite - a.composite || a.ticker.localeCompare(b.ticker));
  return rows;
}
export function forwardSortKey(r: TimingRow): number {
  return r.forward ? r.forward.score : r.timing.score;
}

// ── 0-4 week forward score ───────────────────────────────────────────────────
// The technical base (`fwd4w`, computed in newsagg.technical and calibrated on
// this universe's realised returns — IC +0.06, positive on 65% of dates, +2.0%
// top-vs-bottom quintile 4-week excess) plus a NARRATIVE layer the price
// history can't calibrate, so it's weighted by logic and kept as a bonus:
//   · catalyst within 4 weeks — the strongest live catalyst (the LLM file or the
//     no-LLM earnings feed) whose event lands inside the window; up to +15,
//     scaled by its live TPMN strength (which already peaks ~2 weeks out);
//   · management conviction — a cited read that clears the bar; up to +10.
// A missing source contributes 0, so the score degrades to pure technical when
// the LLM data is stale — and lights up on its own once it's refreshed.
export const FORWARD_CAT_MAX = 15;
export const FORWARD_CONV_MAX = 10;
export const FORWARD_WINDOW_DAYS = 28;

export type ForwardTier = "prime" | "favourable" | "neutral" | "wait";
export const FORWARD_TIER: Record<ForwardTier, { en: string; zh: string; color: string; hint: { en: string; zh: string } }> = {
  prime: { en: "Prime setup", zh: "最佳设置", color: "#5fe3a1", hint: { en: "top of the calibrated 4-week ranking — the setups that led", zh: "校准排序的最前列——历史上 4 周领涨的设置" } },
  favourable: { en: "Favourable", zh: "有利", color: "#3dd6c4", hint: { en: "an above-average 4-week setup", zh: "4 周设置优于平均" } },
  neutral: { en: "Neutral", zh: "中性", color: "#f0c862", hint: { en: "no contrarian setup yet — the middle of the pack lagged", zh: "还没有可买的逆向设置——中间组历史上落后" } },
  wait: { en: "Wait", zh: "等待", color: "#7f8f9e", hint: { en: "extended, or no setup — wait for the pullback", zh: "过热或没有设置——等回落" } },
};
export function forwardTier(score: number): ForwardTier {
  if (score >= 70) return "prime";
  if (score >= 55) return "favourable";
  if (score >= 40) return "neutral";
  return "wait";
}

export interface ForwardScore {
  score: number; // 0-100 blended (technical + narrative bonuses, clamped)
  tech: number; // the calibrated technical base (fwd4w)
  parts: NonNullable<TechTicker["fwd4w"]>["parts"];
  catBonus: number; // 0..FORWARD_CAT_MAX
  convBonus: number; // 0..FORWARD_CONV_MAX
  catDays: number | null; // days to the catalyst that earned the bonus
  catScore: number | null; // its live 0-10
  convTotal: number | null; // the conviction total that earned the bonus
  signals: string[]; // fwd4w receipts + catalyst_4w / conviction_strong
  tier: ForwardTier;
}

export function buildForward(
  tech: TechTicker | null | undefined,
  cat: CatalystTicker | null,
  catData: CatalystTicker | null,
  conv: ConvictionTicker | null,
): ForwardScore | null {
  const fw = tech?.fwd4w;
  if (!fw) return null;
  // Catalyst inside the window: the best live score across both feeds.
  let catScore: number | null = null;
  let catDays: number | null = null;
  for (const src of [cat, catData]) {
    for (const c of src?.catalysts ?? []) {
      const d = catLiveDays(c);
      if (d == null || d < 0 || d > FORWARD_WINDOW_DAYS) continue;
      const s = catLiveScore10(c);
      if (catScore == null || s > catScore) {
        catScore = s;
        catDays = d;
      }
    }
  }
  const catBonus = catScore != null ? FORWARD_CAT_MAX * Math.max(0, Math.min(1, catScore / 10)) : 0;
  const convTotal = conv?.ok ? conv.total : null;
  const convBonus =
    convTotal != null && convTotal >= CONVICTION_BAR ? FORWARD_CONV_MAX * Math.min(1, (convTotal - CONVICTION_BAR) / (10 - CONVICTION_BAR)) : 0;
  const signals = [...fw.signals];
  if (catBonus > 0) signals.push("catalyst_4w");
  if (convBonus > 0) signals.push("conviction_strong");
  const score = Math.max(0, Math.min(100, fw.score + catBonus + convBonus));
  return { score, tech: fw.score, parts: fw.parts, catBonus, convBonus, catDays, catScore, convTotal, signals, tier: forwardTier(score) };
}

// Focus List — step 2's synthesized output. A name earns a spot if it is
// technically strong (gauge = strong buy) OR ecosystem-connected (linked to
// another universe name). Each carries a transparent composite score that
// rewards being strong-buy, in both nets, well-connected (esp. to mega-cap
// anchors) and getting price-volume attention. This is the shortlist that
// carries into the deeper (catalyst / conviction / timing) stages.
export interface FocusNeighbor {
  ticker: string;
  kind: "upstream" | "downstream" | "peers";
  anchor: boolean;
  importance: number; // 1 minor · 2 significant · 3 critical
}
export interface FocusItem {
  ticker: string;
  company: string;
  cap: CapSize;
  sector: string;
  strongBuy: boolean;
  buyStreak: number; // consecutive recent days reading Buy/Strong-Buy
  inBoth: boolean; // in the Heat attention board AND the quality net
  attnScore: number | null;
  rvol: number | null;
  z: number | null;
  links: number;
  anchors: number;
  ecoWeight: number; // quantified ecosystem importance (anchors + links + criticality)
  neighbors: FocusNeighbor[];
  // Signal gates (graded, not a hard filter): how many independent signals fire.
  gBuy: boolean;
  gEco: boolean;
  gThesis: boolean;
  gates: number; // count of the three above that pass (0-3)
  core: boolean; // both hard signals fire (buy + ecosystem)
  score: number;
  spark: number[]; // recent close series, for a card sparkline
  changePct: number | null;
}

// A name is "sustained buy" when its gauge has read Buy/Strong-Buy this many
// consecutive days — a maintained posture, not a one-day flip.
export const SUSTAINED_DAYS = 5;
// Focus-List signal bars (see buildFocus). Kept here so the UI can state the rule.
export const FOCUS_ATTN_BAR = 55; // price-volume attention score
export const FOCUS_RVOL_BAR = 1.5; // relative volume ×
export const FOCUS_ECO_LINKS = 3; // in-universe links that count as an ecosystem signal

// Symmetrized ecosystem adjacency. The LLM maps each ticker one-directionally
// (A lists B), so a lot of real links are missing on the other end (B never
// lists A). We infer the reverse edge: if A says B is its customer (downstream),
// then A is B's supplier (upstream). Peers are mutual. This roughly doubles
// coverage with no extra API calls. Returns ticker → deduped neighbors (keeping
// the higher importance when an edge exists both ways).
const _REV: Record<string, "upstream" | "downstream" | "peers"> = {
  upstream: "downstream",
  downstream: "upstream",
  peers: "peers",
};

export function buildEcoAdjacency(
  supplychain: SupplyChainData | null,
  marketCaps: MarketCaps | null,
): Map<string, FocusNeighbor[]> {
  const adj = new Map<string, Map<string, { kind: "upstream" | "downstream" | "peers"; importance: number }>>();
  const add = (a: string, b: string, kind: "upstream" | "downstream" | "peers", imp: number) => {
    if (!a || !b || a === b) return;
    let m = adj.get(a);
    if (!m) {
      m = new Map();
      adj.set(a, m);
    }
    const prev = m.get(b);
    if (!prev || imp > prev.importance) m.set(b, { kind, importance: imp });
  };
  for (const [t, map] of Object.entries(supplychain ?? {})) {
    for (const kind of ["upstream", "downstream", "peers"] as const) {
      for (const e of map[kind] ?? []) {
        const b = (e.ticker || "").trim().toUpperCase();
        if (!b) continue;
        const imp = Math.min(3, Math.max(1, e.importance ?? 2));
        add(t, b, kind, imp);
        add(b, t, _REV[kind], imp); // inferred reverse edge
      }
    }
  }
  const out = new Map<string, FocusNeighbor[]>();
  for (const [t, m] of adj) {
    out.set(
      t,
      [...m.entries()].map(([ticker, v]) => ({
        ticker,
        kind: v.kind,
        importance: v.importance,
        anchor: bypassesHeat(marketCaps?.[ticker]),
      })),
    );
  }
  return out;
}

export function buildFocus(
  data: SAData | null,
  heat: HeatData | null,
  technical: TechnicalData | null,
  marketCaps: MarketCaps | null,
  sectors: SectorData | null,
  supplychain: SupplyChainData | null,
): FocusItem[] {
  const uni = buildUniverse(data);
  const inUni = new Set(uni.map((u) => u.ticker));
  const cmap = companyMap(data);
  const capsByTicker = new Map(uni.map((u) => [u.ticker, u.caps]));
  const noData = noDataSet(technical);
  const eco = buildEcoAdjacency(supplychain, marketCaps);
  const { advancing } = buildRankings(data, heat, technical, marketCaps);
  const quality = new Set(buildScreen(data, heat, marketCaps, technical).candidates.map((c) => c.ticker));
  const tiny = belowMinCap(data, marketCaps);

  const rated = uni.filter((u) => u.rated && !tiny.has(u.ticker));
  const items: FocusItem[] = [];
  for (const u of rated) {
    const t = u.ticker;
    if (noData.has(t)) continue; // confirmed no-data → out (pending seeds stay)
    const tt = technical?.tickers?.[t];
    const gauge = tt?.gauge?.summary;
    const strongBuy = gauge === "strong_buy";
    const buyStreak = tt?.buy_streak ?? 0;
    const attn = tt?.attention;
    const attnScore = attn?.score ?? null;

    // ecosystem neighbors that are in-universe (symmetrized graph, deduped)
    const neighbors = (eco.get(t) ?? []).filter((n) => inUni.has(n.ticker) && n.ticker !== t);
    const rvol = attn?.rvol ?? null;
    const links = neighbors.length;
    const anchors = neighbors.filter((n) => n.anchor).length;
    const sustained = buyStreak >= SUSTAINED_DAYS;
    const inBoth = quality.has(t) && advancing.has(t);

    // Quantified ecosystem weight — being tied into the universe is treated as a
    // first-class signal (the user can't scrape every analyst thesis, but the
    // supply-chain graph is durable): anchors count for far more than a small-cap
    // link, and each edge scales by its criticality (importance 1-3, 3 = sole-
    // source / hard-to-replace). "irreplaceable to someone big" scores highest.
    const ecoWeight = neighbors.reduce(
      (s, n) => s + (n.anchor ? 6 : 2) * (n.importance / 2),
      0,
    );

    // Graded signal gates (NOT a hard filter — a name only needs one to appear,
    // and the list is RANKED by how many fire, so nothing is dropped prematurely;
    // the deeper stages, catalyst + earnings-call, do the fine cut later):
    const gBuy = strongBuy || sustained;
    const gEco = anchors >= 1 || links >= FOCUS_ECO_LINKS;
    const gThesis = quality.has(t); // analyst thesis — a bonus, not required
    const gates = Number(gBuy) + Number(gEco) + Number(gThesis);

    // Inclusive membership: any real signal keeps it (low-signal names just sink).
    if (gates === 0 && links === 0 && buyStreak < 3) continue;

    const core = gBuy && gEco; // both hard signals fire (buy + ecosystem)
    // 0-10 score, each dimension CAPPED so no single one (e.g. a mega-cap's huge
    // ecosystem) can dominate: Buy 0-5 · Ecosystem 0-4.5 (capped) · both-nets
    // bonus 0-0.5. Thesis and Attention are NOT scored — analyst thesis is shown
    // as a signal flag, and the point it used to carry now sits in Buy.
    const buyPart = (strongBuy ? 3.0 : gBuy ? 1.6 : 0) + (Math.min(buyStreak, 5) / 5) * 2.0;
    const ecoPart = Math.min(ecoWeight / 16, 1) * 4.5;
    const bonus = inBoth ? 0.5 : 0;
    const score = Math.round((buyPart + ecoPart + bonus) * 10) / 10;

    items.push({
      ticker: t,
      company: cmap.get(t) || sectors?.[t]?.name || "",
      cap: capSizeFromCap(marketCaps?.[t], capsByTicker.get(t) ?? []),
      sector: sectors?.[t]?.sector ?? "",
      strongBuy,
      buyStreak,
      inBoth,
      attnScore,
      rvol,
      z: heat?.tickers?.[t]?.z ?? null,
      links,
      anchors,
      ecoWeight: Math.round(ecoWeight * 10) / 10,
      neighbors,
      gBuy,
      gEco,
      gThesis,
      gates,
      core,
      score,
      spark: tt?.close_series ?? [],
      changePct: tt?.change_pct ?? null,
    });
  }
  // Graded: most gates first, then composite score (ecosystem-heavy).
  items.sort(
    (a, b) => b.gates - a.gates || b.score - a.score || a.ticker.localeCompare(b.ticker),
  );
  return items;
}

// ── Stage 3 — Catalyst (TPMN) ────────────────────────────────────────────────
// Joins the Focus List to the catalyst.json produced by newsagg.catalyst. A
// Focus name ADVANCES if its strongest catalyst clears the bar; names with a
// catalyst below the bar are "watch", names fetched with none are "none", and
// names not yet fetched are "pending" (inclusive — nothing is cut here either).
// TPMN → 0-10, MULTIPLICATIVE so scores actually spread. Magnitude leads (it's
// the sector-neutral differentiator and a hard ceiling — a low-M catalyst can't
// score high however soon it is); probability and narrative are gentle floors;
// timing is the peak curve (T/25). The old additive sum let the near-universal
// earnings catalyst saturate every name to ~9.8. Floors are the tunable knobs.
const _P_FLOOR = 0.4; // P=0 → 0.40, P=3 → 1.0
const _T_FLOOR = 0.2; // timing=0 → 0.20, timing peak → 1.0
const _N_FLOOR = 0.7; // N=0 → 0.70, N=2 → 1.0
function _tpmnStrength(T: number, P: number, M: number, N: number): number {
  const mag = M / 3;
  const prob = _P_FLOOR + (1 - _P_FLOOR) * (P / 3);
  const tfac = _T_FLOOR + (1 - _T_FLOOR) * (T / 25);
  const narr = _N_FLOOR + (1 - _N_FLOOR) * (N / 2);
  return mag * prob * tfac * narr; // 0..1
}
export function catScore10(tpmn: CatalystTPMN): number {
  return Math.round(_tpmnStrength(tpmn.T, tpmn.P, tpmn.M, tpmn.N) * 100) / 10;
}

// LIVE timing — recomputed against TODAY on every render so dated catalysts age
// on their own between fetches: the countdown ticks down and, once the event
// passes, T decays to 0 (the score drops) without re-running the LLM.
const _MS_DAY = 86400000;
export function catLiveDays(c: Catalyst): number | null {
  if (c.event_date) {
    const d = new Date(c.event_date + "T00:00:00").getTime();
    if (!Number.isNaN(d)) return Math.round((d - Date.now()) / _MS_DAY);
  }
  return c.tpmn.days; // B-class window / undated → keep the stored estimate
}
function _timingCurve(days: number | null): number {
  if (days == null || days < 0) return 0;
  return 25 * Math.exp(-((days - 14) ** 2) / (2 * 21 * 21));
}
// A catalyst's live 0-10 (T recomputed for today; P/M/N unchanged).
export function catLiveScore10(c: Catalyst): number {
  return Math.round(_tpmnStrength(_timingCurve(catLiveDays(c)), c.tpmn.P, c.tpmn.M, c.tpmn.N) * 100) / 10;
}

// A ticker's catalyst score: the STRONGEST catalyst is the base, and additional
// catalysts add a depth bonus weighted by THEIR OWN strength (which already
// encodes P/M/N importance) with diminishing returns — so more strong catalysts
// lift the score toward 10, weak ones barely move it, and it never just sums.
// Returns -1 if not fetched, 0 if fetched with no catalysts.
export function catDepthBonus(scoresDesc: number[]): number {
  let depth = 0;
  for (let i = 1; i < scoresDesc.length; i++) depth += (scoresDesc[i] / 10) * Math.pow(0.5, i - 1);
  const factor = Math.min(depth * 0.5, 1); // 0-1 of the remaining headroom to 10
  return factor;
}
export function catTickerScore(cat: CatalystTicker | null): number {
  if (!cat) return -1;
  if (!cat.catalysts.length) return 0;
  // LIVE scores so the ticker score decays as events pass, without re-fetching.
  const scores = cat.catalysts.map((c) => catLiveScore10(c)).sort((a, b) => b - a);
  const best = scores[0];
  const score = best + (10 - best) * catDepthBonus(scores);
  return Math.round(score * 10) / 10;
}

// The live-strongest catalyst for a ticker (drives the headline card). Chosen by
// today's score so a passed event yields to a fresher upcoming one on its own.
export function catLiveBest(cat: CatalystTicker | null): Catalyst | null {
  if (!cat || !cat.catalysts.length) return null;
  let best = cat.catalysts[0];
  let bestScore = catLiveScore10(best);
  for (const c of cat.catalysts) {
    const s = catLiveScore10(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

export const CATALYST_BAR = 5.5; // 0-10 to advance

export type CatalystStatus = "advance" | "watch" | "none" | "pending";

export interface CatalystRow {
  ticker: string;
  company: string;
  cap: CapSize;
  sector: string;
  focusScore: number; // the Focus List composite
  gates: number;
  core: boolean;
  cat: CatalystTicker | null; // full catalyst record (null = not fetched yet)
  catScore: number; // best catalyst TPMN score, or -1 if pending
  best: Catalyst | null; // strongest catalyst
  status: CatalystStatus;
  spark: number[]; // recent close series, for a price sparkline
  changePct: number | null;
}

export function buildCatalystRows(
  focus: FocusItem[],
  catalyst: CatalystData | null,
): CatalystRow[] {
  const rows: CatalystRow[] = focus.map((f) => {
    const cat = catalyst?.[f.ticker] ?? null;
    const best = catLiveBest(cat);
    // Depth-weighted 0-10 score: strongest catalyst + a diminishing bonus from
    // the rest (weighted by their own strength). Recomputed here so old and new
    // cache entries share one scale.
    const catScore = catTickerScore(cat);
    const status: CatalystStatus = !cat
      ? "pending"
      : !best
        ? "none"
        : catScore >= CATALYST_BAR
          ? "advance"
          : "watch";
    return {
      ticker: f.ticker,
      company: f.company,
      cap: f.cap,
      sector: f.sector,
      focusScore: f.score,
      gates: f.gates,
      core: f.core,
      cat,
      catScore,
      best,
      status,
      spark: f.spark,
      changePct: f.changePct,
    };
  });
  // Advancing (highest catalyst) first, then by catalyst score, then Focus score.
  const rank: Record<CatalystStatus, number> = { advance: 0, watch: 1, none: 2, pending: 3 };
  rows.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.catScore - a.catScore ||
      b.focusScore - a.focusScore,
  );
  return rows;
}

// ── Shortlist — three tiered leaderboards ────────────────────────────────────
// Three conditions on each Focus name: (1) it's on the FOCUS LIST (always true
// here), (2) it's CORE (buy × ecosystem both fire), (3) its CATALYST clears 6.
//   Tier 1 (gold)   = all three
//   Tier 2 (silver) = two (focus + exactly one of core / catalyst>6)
//   Tier 3 (bronze) = one  (focus only)
// Within each tier, names rank by a weighted STRENGTH composite:
//   Catalyst 0.45 · Core/Focus 0.45 · Attention 0.10  (each normalised 0-1).
export const SHORTLIST_CAT_BAR = 6; // catalyst score must exceed this
export const SHORTLIST_W = { cat: 0.45, focus: 0.45, attn: 0.1 };

export interface LeaderRow {
  ticker: string;
  company: string;
  sector: string;
  cap: CapSize;
  focusScore: number; // 0-10
  attnScore: number; // 0-100
  catScore: number; // 0-10, -1 if not catalyst-fetched
  core: boolean;
  catHot: boolean; // catScore > SHORTLIST_CAT_BAR
  tier: 1 | 2 | 3; // 1 = all three conditions … 3 = focus only
  composite: number; // 0-100 weighted strength
}

export function buildShortlist(focus: FocusItem[], catalyst: CatalystData | null): LeaderRow[] {
  if (!focus.length) return [];
  const rows: LeaderRow[] = focus.map((f) => {
    const catScore = catTickerScore(catalyst?.[f.ticker] ?? null);
    const cat01 = catScore >= 0 ? catScore / 10 : 0;
    const focus01 = f.score / 10;
    const attn01 = (f.attnScore ?? 0) / 100;
    const composite =
      Math.round((SHORTLIST_W.cat * cat01 + SHORTLIST_W.focus * focus01 + SHORTLIST_W.attn * attn01) * 1000) / 10;
    const core = f.core;
    const catHot = catScore > SHORTLIST_CAT_BAR;
    const conditions = 1 + Number(core) + Number(catHot); // in-focus is always true
    return {
      ticker: f.ticker,
      company: f.company,
      sector: f.sector,
      cap: f.cap,
      focusScore: f.score,
      attnScore: f.attnScore ?? 0,
      catScore,
      core,
      catHot,
      tier: (4 - conditions) as 1 | 2 | 3, // 3 cond → tier 1, 2 → 2, 1 → 3
      composite,
    };
  });
  rows.sort((a, b) => a.tier - b.tier || b.composite - a.composite || a.ticker.localeCompare(b.ticker));
  return rows;
}

// ── Stage 5 — Conviction (management tone) ───────────────────────────────────
// Joins the Shortlist survivors to conviction.json (four-layer LLM tone read).
// The read universe is, PER SECTOR, every Tier-1 name plus the top
// CONV_TIER2_PER_SECTOR Tier-2 names by composite strength — a management-tone
// read is expensive, so it's spent on each sector's genuine leaders rather than
// the whole 280-name tail. This MUST match newsagg/conviction.py's _read_targets
// so the page shows exactly the names the job reads. A name not yet fetched is
// "pending"; a fetched name with no citable call is "unsourced" (kept, low-
// confidence). The 0-10 total is L1+L2+L3+L4, computed in Python.
export const CONVICTION_BAR = 6; // 0-10 total to "advance" (backs the thesis)
export const CONV_TIER2_PER_SECTOR = 15; // top-N Tier-2 read per sector

export type ConvictionStatus = "advance" | "watch" | "unsourced" | "pending";

export interface ConvictionRow {
  ticker: string;
  company: string;
  sector: string;
  cap: CapSize;
  tier: 1 | 2 | 3; // shortlist tier
  catScore: number; // shortlist catalyst 0-10 (-1 pending)
  focusScore: number; // 0-10
  attnScore: number; // 0-100
  shortlistComposite: number; // 0-100 shortlist strength (core+catalyst+attn — already in the tier)
  conv: ConvictionTicker | null; // null = not fetched
  total: number; // 0-10 (-1 if pending)
  confidence: number; // 0-1
  status: ConvictionStatus;
}

// Per-sector selection: all Tier-1 + top-N Tier-2 by composite (mirrors _read_targets).
//
// PLUS: any survivor that ALREADY has a real conviction read (conv.ok) is kept no
// matter its current tier. The conviction.json read is expensive and only runs
// occasionally, so the technical tiers drift underneath it between runs — a name
// the LLM scored in the last read can slip to Tier 3 on fresh price data and
// vanish from the tier-gated selection, leaving the page showing only the newly
// promoted names the LLM never read (all "unsourced" 0/10 cards). Anchoring on
// the real reads keeps those genuine scores on the page until the next read
// re-aligns the tiers.
function selectConvictionTargets(rows: LeaderRow[], conviction: ConvictionData | null): LeaderRow[] {
  const bySector = new Map<string, LeaderRow[]>();
  for (const r of rows) {
    if (r.tier > 2) continue;
    const arr = bySector.get(r.sector) ?? [];
    arr.push(r);
    bySector.set(r.sector, arr);
  }
  const selected: LeaderRow[] = [];
  const picked = new Set<string>();
  const take = (r: LeaderRow) => {
    if (picked.has(r.ticker)) return;
    picked.add(r.ticker);
    selected.push(r);
  };
  for (const secRows of bySector.values()) {
    secRows.filter((r) => r.tier === 1).forEach(take);
    secRows
      .filter((r) => r.tier === 2)
      .sort((a, b) => b.composite - a.composite)
      .slice(0, CONV_TIER2_PER_SECTOR)
      .forEach(take);
  }
  // Anchor: fold in every survivor that carries a genuine conviction read, even
  // Tier-3 names the fresh tiers demoted out of the gate above.
  if (conviction) {
    for (const r of rows) {
      if (conviction[r.ticker]?.ok) take(r);
    }
  }
  return selected;
}

export function buildConviction(rows: LeaderRow[], conviction: ConvictionData | null): ConvictionRow[] {
  const survivors = selectConvictionTargets(rows, conviction);
  const out: ConvictionRow[] = survivors.map((r) => {
    const conv = conviction?.[r.ticker] ?? null;
    const total = conv ? conv.total : -1;
    const status: ConvictionStatus = !conv
      ? "pending"
      : !conv.ok
        ? "unsourced"
        : total >= CONVICTION_BAR
          ? "advance"
          : "watch";
    return {
      ticker: r.ticker,
      company: r.company,
      sector: r.sector,
      cap: r.cap,
      tier: r.tier,
      catScore: r.catScore,
      focusScore: r.focusScore,
      attnScore: r.attnScore,
      shortlistComposite: r.composite,
      conv,
      total,
      confidence: conv?.confidence ?? 0,
      status,
    };
  });
  const rank: Record<ConvictionStatus, number> = { advance: 0, watch: 1, unsourced: 2, pending: 3 };
  out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.total - a.total ||
      b.confidence - a.confidence ||
      a.ticker.localeCompare(b.ticker),
  );
  return out;
}

// ── Conviction Ranking — the synthesis at the Conviction gate ─────────────────
// The Shortlist TIER already encodes core + catalyst, so we DON'T re-blend them
// (that would double-count). The gate simply ranks the tiered survivors by the
// new deep signal — Conviction — with Tier as the primary bucket: Tier 1 above
// Tier 2, and within each tier Conviction decides (shortlist strength breaks
// ties). Universe = Tier 1 and Tier 2 names whose Conviction cleared the bar.
export const RANK_MIN_CONVICTION = 6; // conviction total must EXCEED this
export const RANK_COLORS = { conv: "#c99be0", cat: "#48c78e", core: "#3dd6c4", attn: "#5fb0e8" } as const;

export interface RankingRow {
  ticker: string;
  company: string;
  sector: string;
  cap: CapSize;
  tier: 1 | 2; // shortlist tier (the bucket)
  conv: ConvictionTicker; // guaranteed ok
  conviction: number; // 0-10 — the ranking key
  catScore: number; // 0-10 (context / radar)
  focusScore: number; // 0-10 core (context / radar)
  attnScore: number; // 0-100 (context / radar)
  shortlistComposite: number; // 0-100 shortlist strength (tie-break + context)
}

export function buildConvictionRanking(rows: ConvictionRow[]): RankingRow[] {
  const out: RankingRow[] = rows
    .filter((r) => (r.tier === 1 || r.tier === 2) && r.conv && r.conv.ok && r.total > RANK_MIN_CONVICTION)
    .map((r) => ({
      ticker: r.ticker,
      company: r.company,
      sector: r.sector,
      cap: r.cap,
      tier: r.tier as 1 | 2,
      conv: r.conv as ConvictionTicker,
      conviction: r.total,
      catScore: r.catScore,
      focusScore: r.focusScore,
      attnScore: r.attnScore ?? 0,
      shortlistComposite: r.shortlistComposite,
    }));
  // Tier first (1 above 2), then Conviction desc, then shortlist strength.
  out.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.conviction - a.conviction ||
      b.shortlistComposite - a.shortlistComposite ||
      a.ticker.localeCompare(b.ticker),
  );
  return out;
}

export const CATALYST_TYPE_LABEL: Record<string, { en: string; zh: string }> = {
  earnings: { en: "Earnings", zh: "财报" },
  guidance: { en: "Guidance", zh: "指引" },
  approval: { en: "Approval", zh: "获批" },
  order: { en: "Order / Contract", zh: "订单/合同" },
  m_and_a: { en: "M&A", zh: "并购" },
  capital_return: { en: "Capital Return", zh: "资本回报" },
  policy: { en: "Policy", zh: "政策" },
  index: { en: "Index Add", zh: "指数纳入" },
  mgmt: { en: "Management", zh: "管理层" },
  revision: { en: "Est. Revision", zh: "预期修正" },
  other: { en: "Other", zh: "其他" },
};

export function catalystTypeLabel(type: string | null | undefined, lang: "en" | "zh"): string {
  if (!type) return lang === "zh" ? "其他" : "Other";
  const l = CATALYST_TYPE_LABEL[type];
  return l ? (lang === "zh" ? l.zh : l.en) : type;
}
