import { memo, useEffect, useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import { buildFocus, companyMap, noDataSet, belowMinCap, sectorLabel, FORWARD_TIER, forwardTier } from "../pipeline";

// Landing page: per sector, a clean row of "firing chips" — only the names
// lighting up (breakouts, new 52-week highs, top movers), each a glowing chip
// with ticker + today's move (pulsing halo = breakout, white ring = 52w high,
// dot size = attention). No positional axis, so nothing overlaps and every label
// stays on its dot. Click a chip to open; the full ranked list sits below.

interface Mover {
  ticker: string;
  company: string;
  sector: string;
  changePct: number;
  fwd4w: number | null; // 0-4 week forward score (technical, calibrated) — null until technical carries it
  onFocus: boolean;
  attnScore: number;
  rvol: number | null;
  buyStreak: number;
  newHigh: boolean;
  breakout: boolean;
  obvUp: boolean;
}

const SECTOR_COLOR: Record<string, string> = {
  Technology: "#5fb0e8",
  "Financial Services": "#e9c46a",
  "Consumer Cyclical": "#e879a6",
  Healthcare: "#48c78e",
  Energy: "#f4a261",
  "Consumer Defensive": "#3dd6c4",
  Industrials: "#9b8cf0",
  "Basic Materials": "#c98a5e",
  "Communication Services": "#6ee7d6",
  Utilities: "#7fa8c9",
  "Real Estate": "#d4a373",
};
const secColor = (s: string) => SECTOR_COLOR[s] ?? "#8aa0b4";
function hexToRgb(h: string): string {
  const n = parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
// ── Firing Chips — the names lighting up, no axis ────────────────────────────
// A clean wrapping row of glowing chips instead of a positional strip (which
// overlapped and split labels from their dots). Only the sector's igniters
// (breakout / new 52w high) plus its top movers show, strongest-move first.
// Each chip: dot (pulses on breakout, white ring on 52w high) + ticker + move %.
function dotR(m: Mover): number {
  return 4 + Math.min(m.attnScore / 100, 1) * 3; // 4..7px by attention
}

const SectorStrip = memo(function SectorStrip({
  rows,
  color,
  focusSpot,
  onPick,
  lang,
  metric,
}: {
  rows: Mover[];
  color: string;
  focusSpot: boolean;
  onPick: (t: string) => void;
  lang: "en" | "zh";
  metric: "move" | "forward"; // the chip's number: today's move, or the 4-week forward score
}) {
  const rgb = hexToRgb(color);

  // Igniters first (breakout / new 52w high), topped up with the top names by
  // the active metric so a quiet sector still shows its leaders.
  const chips = useMemo(() => {
    const key = (m: Mover) => (metric === "forward" ? (m.fwd4w ?? -1) : m.changePct);
    const byKey = rows.map((_, i) => i).sort((a, b) => key(rows[b]) - key(rows[a]));
    const set = new Set<number>();
    for (const i of byKey) {
      if (set.size >= 8) break;
      if (rows[i].breakout || rows[i].newHigh) set.add(i);
    }
    for (const i of byKey) {
      if (set.size >= 5) break;
      set.add(i);
    }
    return byKey.filter((i) => set.has(i));
  }, [rows, metric]);

  return (
    <div className="flex w-full flex-wrap items-center gap-2 px-3 py-3.5">
      {chips.map((i, k) => {
        const m = rows[i];
        const r = dotR(m);
        const up = m.changePct >= 0;
        const dim = focusSpot && !m.onFocus ? 0.3 : 1;
        return (
          <button
            key={m.ticker}
            onClick={() => onPick(m.ticker)}
            title={`${m.company} · RVOL ${m.rvol != null ? `${m.rvol.toFixed(1)}×` : "—"} · ${t2(lang, "attn", "注意力")} ${Math.round(m.attnScore)}`}
            className="ignite-in group flex flex-none items-center gap-2 rounded-full border px-2.5 py-1 transition-transform duration-150 hover:-translate-y-0.5"
            style={{ opacity: dim, borderColor: `rgba(${rgb},0.35)`, background: `rgba(${rgb},0.07)`, animationDelay: `${Math.min(k * 45, 360)}ms` }}
          >
            <span className="relative grid flex-none place-items-center" style={{ width: r * 2, height: r * 2 }}>
              {m.breakout && (
                <span
                  className="ignite-halo absolute rounded-full"
                  style={{ left: "50%", top: "50%", width: r * 2.6, height: r * 2.6, background: `rgba(${rgb},0.85)` }}
                />
              )}
              <span
                className="rounded-full"
                style={{
                  width: r * 2,
                  height: r * 2,
                  background: `radial-gradient(circle at 35% 30%, rgba(${rgb},1), rgba(${rgb},0.55))`,
                  boxShadow: `0 0 8px rgba(${rgb},0.8)`,
                  border: m.newHigh ? "1.5px solid rgba(255,255,255,0.95)" : "none",
                }}
              />
            </span>
            <span className="font-disp text-[12px] font-bold tracking-wide" style={{ color: `rgb(${rgb})` }}>
              {m.ticker}
            </span>
            {metric === "forward" ? (
              <span className="font-mono text-[10.5px] font-semibold" style={{ color: m.fwd4w != null ? FORWARD_TIER[forwardTier(m.fwd4w)].color : "#7b8da0" }}>
                {m.fwd4w != null ? Math.round(m.fwd4w) : "—"}
                <span className="ml-0.5 text-[8.5px] uppercase opacity-70">4w</span>
              </span>
            ) : (
              <span className="font-mono text-[10.5px] font-semibold" style={{ color: up ? "#48c78e" : "#ff6b6b" }}>
                {up ? "+" : ""}
                {m.changePct.toFixed(1)}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});

function t2(lang: "en" | "zh", en: string, zh: string) {
  return lang === "zh" ? zh : en;
}

// True only during the US regular trading session (Mon–Fri 09:30–16:00
// America/New_York). The live batch move is only meaningful while the market is
// actually trading — that's a genuine intraday move. OUTSIDE the session (nights,
// weekends), the daily snapshot's `change_pct` already holds the last settled
// session's move: stable, and matching what a finance site shows for the day. So
// we only overlay live moves during the session; otherwise the settled bar wins,
// which stops the board mixing days (some chips live, some snapshot) and stops
// the number drifting after the close.
function usMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (typ: string) => parts.find((p) => p.type === typ)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  let hh = parseInt(get("hour"), 10);
  if (hh === 24) hh = 0; // hour12:false can emit "24" at midnight
  const mins = hh * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Weekend in New York? Friday's close is the latest completed session, so the
// snapshot isn't "stale" over a weekend even though it's > a day old.
function nyWeekend(now: Date = new Date()): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  return wd === "Sat" || wd === "Sun";
}

function MoverRow({
  rank,
  m,
  max,
  color,
  onClick,
  lang,
  metric,
}: {
  rank: number;
  m: Mover;
  max: number;
  color: string;
  onClick: () => void;
  lang: "en" | "zh";
  metric: "move" | "forward"; // the row's number: today's move, or the 4-week forward score
}) {
  const up = m.changePct >= 0;
  const top = rank === 1;
  const fwd = metric === "forward";
  const fwdColor = m.fwd4w != null ? FORWARD_TIER[forwardTier(m.fwd4w)].color : "#7b8da0";
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04] ${
        top ? "bg-white/[0.03]" : ""
      }`}
      style={top ? { boxShadow: `inset 0 0 0 1px ${color}44` } : undefined}
    >
      <span
        className="grid h-5 w-5 flex-none place-items-center rounded font-mono text-[10px] font-semibold"
        style={{ background: top ? color : "transparent", color: top ? "#08131a" : "#7b8da0" }}
      >
        {rank}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[13px] font-semibold text-text">{m.ticker}</span>
          {m.onFocus && (
            <span className="text-[10px] text-gold" title={lang === "zh" ? "在重点名单" : "on Focus List"}>
              ★
            </span>
          )}
          {m.newHigh && <span className="text-[9px] text-signal" title="52-week high">52w</span>}
        </span>
        <span className="block truncate text-[11px] text-muted2">{m.company}</span>
      </span>
      <span className="flex flex-none items-center gap-2">
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-inset">
          <span
            className="block h-full rounded-full"
            style={
              fwd
                ? { width: `${Math.max(6, m.fwd4w ?? 0)}%`, background: fwdColor }
                : {
                    width: `${Math.max(6, (Math.abs(m.changePct) / max) * 100)}%`,
                    background: up ? "linear-gradient(90deg,#2fae9e,#3dd6c4)" : "linear-gradient(90deg,#c96,#e88)",
                  }
            }
          />
        </span>
        {fwd ? (
          <span className="w-16 text-right font-mono text-[12.5px] font-semibold" style={{ color: fwdColor }}>
            {m.fwd4w != null ? Math.round(m.fwd4w) : "—"}
            <span className="ml-0.5 text-[9px] uppercase opacity-70">4w</span>
          </span>
        ) : (
          <span className={`w-16 text-right font-mono text-[12.5px] font-semibold ${up ? "text-ok" : "text-bad"}`}>
            {up ? "+" : ""}
            {m.changePct.toFixed(2)}%
          </span>
        )}
      </span>
    </button>
  );
}

export function OverviewView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const marketCaps = useStore((s) => s.marketCaps);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const [focusSpot, setFocusSpot] = useState(false);

  const focusSet = useMemo(() => {
    const f = buildFocus(data, heat, technical, marketCaps, sectors, supplychain);
    return new Set(f.map((x) => x.ticker));
  }, [data, heat, technical, marketCaps, sectors, supplychain]);

  // Unrated small-caps (< $2B with only a text list "BUY", no quant, no analyst
  // — e.g. the $195M penny stock PERF) are kept off the leaderboard, matching
  // the rest of the funnel.
  const tiny = useMemo(() => belowMinCap(data, marketCaps), [data, marketCaps]);

  // The leaderboard's strong-buy set (stable across polls unless the set changes).
  const sbKey = useMemo(() => {
    const noData = noDataSet(technical);
    return Object.entries(technical?.tickers ?? {})
      .filter(([tk, tt]) => !noData.has(tk) && tt.gauge?.summary === "strong_buy" && !tiny.has(tk))
      .map(([tk]) => tk)
      .sort()
      .join(",");
  }, [technical, tiny]);

  // Live overlay: the leaderboard ranks by "today's move", which the daily
  // technical snapshot only refreshes once a run. Batch-fetch live moves for the
  // strong-buy set every 60s (one yfinance call via serve.py) so it auto-updates
  // and re-ranks. Falls back to the snapshot when the endpoint is absent (Vite
  // dev) or a name isn't returned.
  const [live, setLive] = useState<{ moves: Record<string, number>; at: number } | null>(null);
  useEffect(() => {
    if (!sbKey) return;
    let alive = true;
    const pull = () => {
      // Off-hours: the settled daily bar (change_pct) is the latest move — don't
      // overlay a re-fetched number that would drift or disagree between chips.
      if (!usMarketOpen()) {
        if (alive) setLive(null);
        return;
      }
      fetch(`/api/quotes?tickers=${encodeURIComponent(sbKey)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (alive && j && j.quotes && Object.keys(j.quotes).length) setLive({ moves: j.quotes as Record<string, number>, at: Date.now() });
        })
        .catch(() => {});
    };
    pull();
    const id = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sbKey]);

  // Ranking key: today's move (the "what's firing" view) or the calibrated
  // 0-4 week forward score (the "what to buy next" view).
  const [sortBy, setSortBy] = useState<"move" | "forward">("move");

  const movers = useMemo<Mover[]>(() => {
    const noData = noDataSet(technical);
    const cmap = companyMap(data);
    const lm = live?.moves ?? {};
    const out: Mover[] = [];
    for (const [ticker, tt] of Object.entries(technical?.tickers ?? {})) {
      if (noData.has(ticker)) continue;
      if (tt.gauge?.summary !== "strong_buy") continue;
      if (tiny.has(ticker)) continue;
      const at = tt.attention;
      out.push({
        ticker,
        company: cmap.get(ticker) ?? "",
        sector: sectors?.[ticker]?.sector ?? "",
        changePct: lm[ticker] ?? tt.change_pct ?? 0, // live move if we have it
        fwd4w: tt.fwd4w?.score ?? null,
        onFocus: focusSet.has(ticker),
        attnScore: at?.score ?? 0,
        rvol: at?.rvol ?? null,
        buyStreak: tt.buy_streak ?? 0,
        newHigh: !!at?.new_high_52w,
        breakout: at?.phase === "breakout" || at?.phase === "igniting",
        obvUp: !!at?.obv_up,
      });
    }
    const cmp = (a: Mover, b: Mover) =>
      sortBy === "forward" ? (b.fwd4w ?? -1) - (a.fwd4w ?? -1) || b.changePct - a.changePct : b.changePct - a.changePct;
    return out.sort(cmp);
  }, [technical, data, sectors, focusSet, tiny, live, sortBy]);
  const hasForward = movers.some((m) => m.fwd4w != null);

  const bySector = useMemo(() => {
    const m = new Map<string, Mover[]>();
    for (const mv of movers) {
      const key = mv.sector || "Other";
      const arr = m.get(key);
      if (arr) arr.push(mv);
      else m.set(key, [mv]);
    }
    const cmp = (a: Mover, b: Mover) =>
      sortBy === "forward" ? (b.fwd4w ?? -1) - (a.fwd4w ?? -1) || b.changePct - a.changePct : b.changePct - a.changePct;
    for (const arr of m.values()) arr.sort(cmp);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [movers, sortBy]);

  const focusCount = movers.filter((m) => m.onFocus).length;

  return (
    <div className="view-in space-y-5">
      {/* HEADER */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-disp text-[23px] font-semibold tracking-tight">
            {t("Strong-Buy Leaderboard", "强力买入榜")}
            <span className="inline-flex items-center rounded-full border border-gold/30 bg-gold/[0.07] px-2.5 py-0.5">
              <span className="pill-sheen font-mono text-[13px] font-bold">{movers.length}</span>
            </span>
          </h1>
          <p className="caption-scan relative mt-1.5 flex w-fit flex-wrap items-center gap-2 text-[11.5px] text-muted2">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
            </span>
            {sortBy === "forward"
              ? t("what's firing per sector · ranked by the calibrated 4-week forward score", "每板块今日在点火的票 · 按校准的 4 周前瞻分排名")
              : t("what's firing per sector · ranked by today's move", "每板块今日在点火的票 · 按当日涨跌排名")}
            {live ? (
              <span
                className="rounded-full border px-2 py-[1px] font-mono text-[10px]"
                style={{ color: "#48c78e", borderColor: "#48c78e55", background: "#48c78e14" }}
                title={t("Live moves — batch-refreshed every 60s from the local server", "实时涨跌 · 每 60 秒经本地服务器批量刷新")}
              >
                ● {t("LIVE", "实时")} {new Date(live.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            ) : (
              (() => {
                const g = technical?.generated_at ? new Date(technical.generated_at) : null;
                if (!g) return null;
                const stale = !nyWeekend() && Date.now() - g.getTime() > 30 * 3600 * 1000; // prices should refresh daily (Fri data isn't stale over a weekend)
                const d = g.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                return (
                  <span
                    className="rounded-full border px-2 py-[1px] font-mono text-[10px]"
                    style={stale ? { color: "#f2a73c", borderColor: "#f2a73c66", background: "#f2a73c14" } : { color: "#6f7f8e", borderColor: "var(--line,#22303c)" }}
                    title={stale ? t("Prices haven't refreshed — run the local server (serve.py) for live moves, or the yfinance job needs the VPN/proxy.", "价格未刷新 —— 用本地服务器(serve.py)拿实时涨跌,或 yfinance 任务需要 VPN/代理。") : ""}
                  >
                    {stale ? t(`⚠ prices as of ${d} (stale)`, `⚠ 价格截至 ${d}(已过期)`) : t(`prices ${d}`, `价格 ${d}`)}
                  </span>
                );
              })()
            )}
          </p>
        </div>

        {/* controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {hasForward && (
            <div className="flex overflow-hidden rounded-xl border border-line bg-panel2/70 text-[11.5px]">
              <button
                onClick={() => setSortBy("move")}
                className={`px-3 py-2 transition-colors ${sortBy === "move" ? "bg-signal/15 text-signal" : "text-muted hover:text-text"}`}
                title={t("Rank by today's move", "按当日涨跌排序")}
              >
                {t("Today's move", "当日涨跌")}
              </button>
              <button
                onClick={() => setSortBy("forward")}
                className={`px-3 py-2 transition-colors ${sortBy === "forward" ? "bg-signal/15 text-signal" : "text-muted hover:text-text"}`}
                title={t("Rank by the calibrated 0-4 week forward score", "按校准的 4 周前瞻分排序")}
              >
                {t("4-week forward", "4 周前瞻")}
              </button>
            </div>
          )}
          <button
            onClick={() => setFocusSpot((v) => !v)}
            className={`rounded-xl border px-3 py-2 text-[11.5px] transition-colors ${
              focusSpot ? "border-gold/50 bg-gold/10 text-gold" : "border-line bg-panel2/70 text-muted hover:text-text"
            }`}
            title={t("Spotlight Focus-List names", "只高亮重点名单")}
          >
            ★ {t("Focus", "重点")} {focusCount}
          </button>
        </div>
      </div>

      {/* legend */}
      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-muted2">
        <span className="font-medium text-muted">
          {t(
            "Per sector: the names FIRING today — breakouts, new highs & top movers — as chips, strongest move first.",
            "每个板块：今天在「点火」的票（突破 / 新高 / 领涨）以标签呈现，涨幅最强在前。",
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#3dd6c4", boxShadow: "0 0 7px #3dd6c4" }} /> {t("breakout (pulsing)", "突破(脉动)")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full ring-[1.5px] ring-white/80" /> 52w {t("high", "新高")}
        </span>
        <span>{t("dot size = attention · click a chip to open", "点大小 = 注意力 · 点标签进入")}</span>
      </div>

      {movers.length === 0 ? (
        <div className="grid h-64 place-items-center rounded-2xl border border-line bg-panel2 text-[13px] text-muted">
          {t("No strong-buy names yet — run the technical job.", "暂无强力买入标的 — 先跑技术数据。")}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bySector.map(([sec, rows]) => {
            const color = secColor(sec);
            const max = Math.max(...rows.map((r) => Math.abs(r.changePct)), 0.01);
            return (
              <div key={sec} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel2">
                <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                    {sectorLabel(sec === "Other" ? undefined : sec, lang)}
                  </span>
                  <span className="font-mono text-[11px] text-muted2">{rows.length}</span>
                </header>
                <div className="relative min-h-[92px] w-full border-b border-line/60">
                  <SectorStrip rows={rows} color={color} focusSpot={focusSpot} onPick={openDetail} lang={lang} metric={sortBy} />
                </div>
                <div className="max-h-[300px] overflow-y-auto p-1.5">
                  {rows.map((m, i) => (
                    <MoverRow key={m.ticker} rank={i + 1} m={m} max={max} color={color} lang={lang} metric={sortBy} onClick={() => openDetail(m.ticker)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
