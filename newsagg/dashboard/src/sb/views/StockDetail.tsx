import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, useT, type Lang } from "../../store";
import {
  buildSeeds,
  buildUniverse,
  buildFocus,
  buildRankings,
  capSizeFromCap,
  bypassesHeat,
  passesHeatGate,
  sectorLabel,
  capLabel,
  catLiveScore10,
  catLiveDays,
  catLiveBest,
  catTickerScore,
  catalystTypeLabel,
  buildShortlist,
  SHORTLIST_CAT_BAR,
  SHORTLIST_W,
  CATALYST_BAR,
  TIMING_META,
  buildForward,
  FORWARD_TIER,
  FORWARD_CAT_MAX,
  FORWARD_CONV_MAX,
  type ForwardScore,
  type FocusItem,
  type LeaderRow,
} from "../pipeline";
import { TimingBadge, SignalChips, ForwardBadge } from "../ui";
import type { BandSeries, Catalyst, CatalystTicker, ConvictionTicker, SupplyEdge, SupplyMap, TechTicker, TechTiming } from "../../types";

// Human labels for the ranking lenses a name advanced in (Heat Ignition).
const LENS_LABEL: Record<string, { en: string; zh: string }> = {
  rvol: { en: "Rel. Volume", zh: "放量" },
  momentum: { en: "Momentum 60d", zh: "动量 60 日" },
  strongbuy: { en: "Strong Buy", zh: "强力买入" },
  bypass: { en: "Mega-cap", zh: "大票直通" },
};

// Transparent Focus-score breakdown for one ticker: every component of the 0-10
// composite, shown with its formula so you can see exactly how the score is built.
function ScoreBreakdown({
  item,
  advBy,
  lang,
  t,
}: {
  item: FocusItem;
  advBy: string[];
  lang: Lang;
  t: (en: string, zh: string) => string;
}) {
  const buyBase = item.strongBuy ? 2.5 : item.gBuy ? 1.3 : 0;
  const streakAdd = (Math.min(item.buyStreak, 5) / 5) * 1.5;
  const rows: { label: string; note: string; val: number; max: number; color: string }[] = [
    {
      label: t("Buy", "买入"),
      note: `${item.strongBuy ? t("strong-buy 2.5", "强买 2.5") : item.gBuy ? t("buy 1.3", "买入 1.3") : "0"} + ${t(`${item.buyStreak}d streak`, `连买 ${item.buyStreak} 天`)} ${streakAdd.toFixed(1)}`,
      val: buyBase + streakAdd,
      max: 4,
      color: "#48c78e",
    },
    {
      label: t("Ecosystem", "生态"),
      note: t(`eco-weight ${item.ecoWeight} ÷ 16 ×4.5 (capped)`, `生态权重 ${item.ecoWeight} ÷ 16 ×4.5（封顶）`),
      val: Math.min(item.ecoWeight / 16, 1) * 4.5,
      max: 4.5,
      color: "#5fb0e8",
    },
    {
      label: t("Thesis", "论点"),
      note: item.gThesis ? t("analyst thesis +1", "有分析师论点 +1") : t("none", "无"),
      val: item.gThesis ? 1 : 0,
      max: 1,
      color: "#9aa7b3",
    },
    {
      label: t("Both-nets", "双网"),
      note: item.inBoth ? t("in quality ∩ advancing +0.5", "质量∩被关注 +0.5") : t("no", "否"),
      val: item.inBoth ? 0.5 : 0,
      max: 0.5,
      color: "#e9c46a",
    },
  ];
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{t("Focus score — how it's built", "重点名单打分 · 拆解")}</div>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-mono text-muted2">{t(`gates ${item.gates}/3`, `过闸 ${item.gates}/3`)}</span>
          {item.core && (
            <span className="rounded-full border border-gold/50 bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold">★ {t("Core", "核心")}</span>
          )}
          <span className="font-mono text-[15px] font-semibold text-signal">
            {item.score.toFixed(1)}
            <span className="text-[10px] text-muted2">/10</span>
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 text-[12px]">
            <span className="w-16 flex-none text-muted">{r.label}</span>
            <span className="h-1.5 w-24 flex-none overflow-hidden rounded-full bg-inset">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (r.val / r.max) * 100)}%`, background: r.color }} />
            </span>
            <span className="flex-1 truncate text-[11px] text-muted2">{r.note}</span>
            <span className="w-10 flex-none text-right font-mono text-text">{r.val.toFixed(1)}</span>
          </div>
        ))}
      </div>
      {advBy.length > 0 && (
        <div className="mt-3 border-t border-line pt-2 text-[11px] text-muted2">
          {t("Advancing via: ", "被关注来自: ")}
          {advBy.map((k) => (LENS_LABEL[k] ? (lang === "zh" ? LENS_LABEL[k].zh : LENS_LABEL[k].en) : k)).join(" · ")}
        </div>
      )}
    </div>
  );
}

// Shortlist — the three conditions that set the tier, and the weighted strength
// composite, all with THIS ticker's actual numbers.
const TIER_LABEL: Record<1 | 2 | 3, { color: string; en: string; zh: string }> = {
  1: { color: "#f0c862", en: "Tier 1 · all three", zh: "第一名 · 三条全中" },
  2: { color: "#cdd6e2", en: "Tier 2 · two of three", zh: "第二名 · 中两条" },
  3: { color: "#cd8b5e", en: "Tier 3 · focus only", zh: "第三名 · 仅在名单" },
};
function ShortlistBreakdown({ row, lang, t }: { row: LeaderRow; lang: Lang; t: (en: string, zh: string) => string }) {
  const tl = TIER_LABEL[row.tier];
  const cat01 = Math.max(0, row.catScore) / 10;
  const focus01 = row.focusScore / 10;
  const attn01 = row.attnScore / 100;
  const conds: { on: boolean; label: string; note: string }[] = [
    { on: true, label: t("On Focus List", "在重点名单"), note: t("reached the shortlist", "进入登顶名单") },
    { on: row.core, label: t("Core", "核心"), note: t("buy × ecosystem both fire", "买入 × 生态双触发") },
    { on: row.catHot, label: t(`Catalyst > ${SHORTLIST_CAT_BAR}`, `催化剂 > ${SHORTLIST_CAT_BAR}`), note: row.catScore >= 0 ? t(`catalyst ${row.catScore.toFixed(1)}`, `催化剂 ${row.catScore.toFixed(1)}`) : t("not fetched", "未抓取") },
  ];
  const parts: { label: string; w: number; norm: number; color: string }[] = [
    { label: t("Catalyst", "催化剂"), w: SHORTLIST_W.cat, norm: cat01, color: "#48c78e" },
    { label: t("Core", "核心"), w: SHORTLIST_W.focus, norm: focus01, color: "#3dd6c4" },
    { label: t("Attention", "注意力"), w: SHORTLIST_W.attn, norm: attn01, color: "#5fb0e8" },
  ];
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{t("Shortlist — how it's built", "登顶名单打分 · 拆解")}</div>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: "#0b0f14", background: tl.color }}>{lang === "zh" ? tl.zh : tl.en}</span>
          <span className="font-mono text-[15px] font-semibold text-signal">{row.composite.toFixed(1)}<span className="text-[10px] text-muted2">/100</span></span>
        </div>
      </div>
      {/* the three tier conditions */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {conds.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]" style={{ color: c.on ? "#0b0f14" : "var(--muted2)", background: c.on ? "#48c78e" : "transparent", borderColor: c.on ? "transparent" : "var(--line,#22303c)" }} title={c.note}>
            {c.on ? "✓" : "○"} {c.label}
          </span>
        ))}
      </div>
      {/* weighted strength composite */}
      <div className="space-y-2">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-3 text-[12px]">
            <span className="w-16 flex-none text-muted">{p.label}</span>
            <span className="h-1.5 w-24 flex-none overflow-hidden rounded-full bg-inset">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(4, p.norm * 100)}%`, background: p.color }} />
            </span>
            <span className="flex-1 truncate font-mono text-[11px] text-muted2">{p.w} × {(p.norm * 100).toFixed(0)}% = {(p.w * p.norm * 100).toFixed(1)}</span>
            <span className="w-10 flex-none text-right font-mono text-text">{(p.w * p.norm * 100).toFixed(1)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-line pt-2 font-mono text-[11px] text-muted2">
        {t(`strength = 0.45·cat + 0.45·core + 0.10·attn = ${row.composite.toFixed(1)}`, `强度 = 0.45·催 + 0.45·核 + 0.10·注 = ${row.composite.toFixed(1)}`)}
      </div>
    </div>
  );
}

// Each catalyst type gets its own accent colour, rendered as a small live
// "signal" glyph (a solid core with a slow pulsing halo) — cleaner and more
// premium than an emoji, and the motion reads as "active".
const TYPE_COLOR: Record<string, string> = {
  earnings: "#5fb0e8",
  guidance: "#8aa2ff",
  approval: "#48c78e",
  order: "#3dd6c4",
  m_and_a: "#e9c46a",
  capital_return: "#f2a73c",
  policy: "#c98bff",
  index: "#7fce9e",
  mgmt: "#9aa7b3",
  revision: "#e08bd0",
  other: "#9b8cf0",
};

function TypeGlyph({ type }: { type: string }) {
  const c = TYPE_COLOR[type] ?? TYPE_COLOR.other;
  return (
    <span className="relative grid h-3.5 w-3.5 flex-none place-items-center" aria-hidden>
      <span
        className="absolute inset-0 rounded-full"
        style={{ background: c, opacity: 0.16, animation: "catpulse 2.6s ease-in-out infinite" }}
      />
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
    </span>
  );
}

function catDayLabel(c: Catalyst, t: (en: string, zh: string) => string): { label: string; near: boolean } {
  const d = catLiveDays(c);
  if (c.cls === "B") return d == null ? { label: t("window TBD", "窗口待定"), near: false } : { label: t(`~${d}d`, `~${d}天`), near: d <= 30 };
  if (d == null) return { label: t("TBD", "待定"), near: false };
  if (d < 0) return { label: t(`${-d}d ago`, `${-d}天前`), near: false };
  if (d === 0) return { label: t("today", "今天"), near: true };
  return { label: t(`in ${d}d`, `${d}天后`), near: d <= 30 };
}

// Animated ring for the composite catalyst score.
function Ring({ score, color }: { score: number; color: string }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setGrown(true), 60);
    return () => clearTimeout(id);
  }, []);
  const R = 22;
  const C = 2 * Math.PI * R;
  const shown = grown ? score : 0;
  return (
    <svg width="58" height="58" viewBox="0 0 58 58" className="flex-none">
      <circle cx="29" cy="29" r={R} fill="none" stroke="#1c2734" strokeWidth="5" />
      <circle
        cx="29"
        cy="29"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - shown / 10)}
        transform="rotate(-90 29 29)"
        style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.22,0.61,0.36,1)" }}
      />
      <text x="29" y="33.5" textAnchor="middle" fill="#e7edf4" fontFamily="ui-monospace, monospace" fontSize="14" fontWeight="700">
        {score.toFixed(1)}
      </text>
    </svg>
  );
}

function TpmnRow({ tpmn }: { tpmn: Catalyst["tpmn"] }) {
  const dims: [string, number, number, string][] = [
    ["T", tpmn.T, 25, "#9b8cf0"],
    ["P", tpmn.P, 3, "#5fb0e8"],
    ["M", tpmn.M, 3, "#e9c46a"],
    ["N", tpmn.N, 2, "#48c78e"],
  ];
  return (
    <div className="flex items-center gap-2.5">
      {dims.map(([k, v, max, c]) => (
        <div key={k} className="flex items-center gap-1" title={`${k} ${k === "T" ? v.toFixed(1) : v}/${max}`}>
          <span className="font-mono text-[9px] text-muted2">{k}</span>
          <span className="h-1.5 w-8 overflow-hidden rounded-full bg-inset">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(6, (v / max) * 100)}%`, background: c }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// One catalyst, fully recorded: icon + type + title + timing + score, its
// summary, the P/M/N justification, its T/P/M/N meter, and a source link.
function CatItem({ c, lang, t }: { c: Catalyst; lang: Lang; t: (en: string, zh: string) => string }) {
  const cd = catDayLabel(c, t);
  const sc = catLiveScore10(c);
  return (
    <div className="rounded-lg border border-line/60 bg-white/[0.02] p-2.5 transition-colors hover:bg-white/[0.045]">
      <div className="flex items-center gap-2">
        <TypeGlyph type={c.type} />
        <span className="flex-none rounded border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">{catalystTypeLabel(c.type, lang)}</span>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-text">{c.title}</span>
        <span className={`flex-none font-mono text-[10px] ${cd.near ? "text-ok" : "text-muted2"}`}>{cd.label}</span>
        <span className="flex-none font-mono text-[13px] font-semibold" style={{ color: sc >= CATALYST_BAR ? "#48c78e" : "#c7d2dc" }}>
          {sc.toFixed(1)}
        </span>
      </div>
      {c.summary && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{c.summary}</p>}
      {c.evidence && <p className="mt-1 text-[10px] italic text-muted2">P/M/N · {c.evidence}</p>}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <TpmnRow tpmn={c.tpmn} />
        <a
          href={c.source_url}
          target="_blank"
          rel="noreferrer"
          className="flex-none font-mono text-[10px] text-signal/80 hover:text-signal hover:underline"
        >
          {t("source", "来源")} ↗
        </a>
      </div>
    </div>
  );
}

// No-LLM live signals: the next earnings date (a dated forward catalyst) + the
// company's recent news headlines (keyword-typed, each linked to its source).
// Always current — it never needs the LLM gateway.
function LiveSignals({ cat, lang, t }: { cat: CatalystTicker; lang: Lang; t: (en: string, zh: string) => string }) {
  const items = cat.catalysts || [];
  const forward = items.filter((c) => c.tpmn?.cls !== "news");
  const news = items.filter((c) => c.tpmn?.cls === "news");
  if (!forward.length && !news.length) return null;
  const earn = forward[0];
  let days: number | null = null;
  if (earn?.event_date) {
    const d = Math.round((new Date(earn.event_date).getTime() - Date.now()) / 86400000);
    days = Number.isFinite(d) ? d : null;
  }
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{t("Latest Signals · no-LLM", "最新信号 · 无 LLM")}</div>
        <div className="text-[10.5px] text-muted2">{t("earnings date + recent news (yfinance)", "财报日 + 最新新闻(yfinance)")}</div>
      </div>

      {earn?.event_date && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-line2 bg-inset px-3 py-2">
          <span className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: "#0b0f14", background: "#5fb0e8" }}>{t("Earnings", "财报")}</span>
          <span className="font-mono text-[13px] text-text">{earn.event_date}</span>
          {days != null && (
            <span className="font-mono text-[12px]" style={{ color: days <= 14 && days >= 0 ? "#48c78e" : "#8aa0b2" }}>
              {days >= 0 ? t(`in ${days}d`, `${days} 天后`) : t("passed", "已过")}
            </span>
          )}
          <a href={earn.source_url} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-signal hover:underline">{t("source ↗", "来源 ↗")}</a>
        </div>
      )}

      {news.length > 0 && (
        <div className="space-y-1.5">
          {news.slice(0, 6).map((n, i) => (
            <a
              key={i}
              href={n.source_url}
              target="_blank"
              rel="noreferrer"
              className="group flex items-start gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-white/[0.03]"
            >
              <span className="mt-[2px] rounded px-1 py-[1px] text-[8.5px] font-semibold uppercase tracking-wide text-muted2" style={{ border: "1px solid var(--line2,#2b3a48)" }}>
                {catalystTypeLabel(n.type, lang)}
              </span>
              <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted group-hover:text-text">{n.title}</span>
              <span className="flex-none font-mono text-[9.5px] text-muted2">{n.event_date || ""}</span>
            </a>
          ))}
        </div>
      )}

      <div className="mt-3 text-[10.5px] leading-relaxed text-muted2">
        {t(
          "Raw signals from free feeds (no LLM): the scheduled earnings date, plus recent headlines keyword-typed by kind. It does NOT judge magnitude or sector impact — read the sources.",
          "免费数据源的原始信号(无 LLM):已排定的财报日 + 最新新闻(按关键词粗分类)。它不判断量级/板块影响——点进来源自己读。",
        )}
      </div>
    </div>
  );
}

// Full catalyst record for a ticker: an animated score ring, a base+depth
// composition bar, and every catalyst laid out in detail.
function CatBreakdown({ cat, lang, t }: { cat: CatalystTicker; lang: Lang; t: (en: string, zh: string) => string }) {
  const total = catTickerScore(cat);
  const prim = catLiveBest(cat) ?? cat.catalysts[0];
  const primScore = catLiveScore10(prim);
  const depth = Math.round((total - primScore) * 10) / 10;
  const color = total >= CATALYST_BAR ? "#48c78e" : "#c7d2dc";
  const n = cat.catalysts.length;
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold">{t("Catalyst score — how it's built", "催化剂打分 · 全部记录")}</div>
          <div className="mt-0.5 text-[11px] text-muted2">{n} {t(n === 1 ? "catalyst" : "catalysts", "条催化剂")}</div>
        </div>
        <Ring score={total} color={color} />
      </div>

      {/* composition — base (strongest) + depth toward 10 */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className="text-muted2">
            {t("Base (strongest)", "主分(最强)")} <span className="font-mono text-muted">{primScore.toFixed(1)}</span>
          </span>
          <span className="text-gold">
            +{depth.toFixed(1)} {t("depth", "深度加成")}
          </span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-inset">
          <div className="h-full" style={{ width: `${(primScore / 10) * 100}%`, background: color, transition: "width 0.8s ease" }} />
          <div className="h-full" style={{ width: `${(depth / 10) * 100}%`, background: "#e9c46a", transition: "width 0.8s ease" }} />
        </div>
      </div>

      {/* every catalyst, full detail — strongest (live) first */}
      <div className="space-y-2">
        {[...cat.catalysts]
          .sort((a, b) => catLiveScore10(b) - catLiveScore10(a))
          .map((c, i) => (
            <CatItem key={i} c={c} lang={lang} t={t} />
          ))}
      </div>

      <div className="mt-2.5 border-t border-line pt-2 text-[10.5px] leading-relaxed text-muted2">
        {t(
          "Base = the strongest catalyst; the rest fill the remaining headroom to 10, weighted by their own strength (P/M/N) with diminishing returns.",
          "基准 = 最强那条;其余按各自强度(P/M/N)递减加权,填补到 10 分的余量。",
        )}
      </div>
    </div>
  );
}

type L = { en: string; zh: string; color: string };
const lbl = (m: L, lang: Lang) => (lang === "zh" ? m.zh : m.en);

// Trend WORDS, deliberately not buy/sell verdicts: the calibration found this
// lagging MA + oscillator vote carries no 0-4 week forward power, so it reads
// as context ("where the trend is") while the forward score makes the call.
const GAUGE: Record<string, L & { pos: number }> = {
  strong_buy: { en: "Strong uptrend", zh: "强势上行", color: "#48c78e", pos: 0.92 },
  buy: { en: "Uptrend", zh: "上行", color: "#7fce9e", pos: 0.7 },
  neutral: { en: "Range", zh: "震荡", color: "#e9c46a", pos: 0.5 },
  sell: { en: "Downtrend", zh: "下行", color: "#f2a73c", pos: 0.3 },
  strong_sell: { en: "Strong downtrend", zh: "强势下行", color: "#ff5a78", pos: 0.08 },
};

const ATTN: Record<string, L> = {
  breakout: { en: "Breakout", zh: "突破", color: "#ff5a78" },
  igniting: { en: "Igniting", zh: "量价点火", color: "#3dd6c4" },
  accumulating: { en: "Accumulating", zh: "吸筹中", color: "#5fb0e8" },
  quiet: { en: "Quiet", zh: "沉寂", color: "#5a6a7c" },
};

const SOCIAL: Record<string, L> = {
  detonate: { en: "Detonate", zh: "引爆", color: "#ff5a78" },
  ignite: { en: "Ignite", zh: "点火", color: "#f2a73c" },
  watch: { en: "Watch", zh: "观察", color: "#e9c46a" },
  dead: { en: "Dead", zh: "死水", color: "#5c7c99" },
  ultralow: { en: "Ultra-low", zh: "超低覆盖", color: "#5a6a7c" },
  warming: { en: "Warming", zh: "积累中", color: "#3dd6c4" },
};

// Stage 5 — the four-layer management-tone read for this ticker (conviction.py).
const CONV_LAYERS: { key: "L1" | "L2" | "L3" | "L4"; color: string; en: string; zh: string }[] = [
  { key: "L1", color: "#5fb0e8", en: "Tone", zh: "语气" },
  { key: "L2", color: "#3dd6c4", en: "Directness", zh: "直白" },
  { key: "L3", color: "#48c78e", en: "Hard vs soft", zh: "硬软" },
  { key: "L4", color: "#f0c862", en: "Follow-through", zh: "兑现度" },
];
function convColor(total: number): string {
  if (total >= 7.5) return "#48c78e";
  if (total >= 6) return "#7bd88f";
  if (total >= 4) return "#f0c862";
  return "#e0785a";
}
const fmtConv = (n: number): string => (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1));
function ConvBreakdown({ conv, lang, t }: { conv: ConvictionTicker; lang: Lang; t: (en: string, zh: string) => string }) {
  const col = convColor(conv.total);
  const anchor = conv.source === "upstream_anchor";
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">{t("Management Conviction", "管理层语气")}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted2">
            <span
              className="rounded px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide"
              style={{ color: anchor ? "#e0b45a" : "#7bd88f", background: anchor ? "#e0b45a1a" : "#7bd88f1a" }}
            >
              {anchor ? `⇡ ${t("anchor", "上游锚")}${conv.anchor_ticker ? " · " + conv.anchor_ticker : ""}` : `● ${t("own call", "自身")}`}
            </span>
            <span className="truncate">{conv.call_ref || t("call", "电话会")}{conv.call_date ? ` · ${conv.call_date}` : ""}</span>
          </div>
        </div>
        <div className="flex-none text-right">
          <div className="font-disp text-[24px] font-bold leading-none tabular-nums" style={{ color: col }}>
            {fmtConv(conv.total)}<span className="text-[12px] text-muted2">/10</span>
          </div>
          <div className="text-[9px] uppercase tracking-wide text-muted2">{t("conf", "置信")} {Math.round(conv.confidence * 100)}%</div>
        </div>
      </div>
      <div className="space-y-2.5">
        {CONV_LAYERS.map((l) => {
          const d = conv.layers[l.key];
          return (
            <div key={l.key} className="flex gap-3 border-t border-line/60 pt-2.5 first:border-t-0 first:pt-0">
              <div className="w-[118px] flex-none">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-muted2">{lang === "zh" ? l.zh : l.en}</span>
                  <span className="font-mono text-[10.5px] font-semibold" style={{ color: l.color }}>{d.score}<span className="text-muted2">/{d.max}</span></span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: d.max }).map((_, i) => (
                    <span key={i} className="h-1.5 flex-1 rounded-full" style={{ background: i < d.score ? l.color : "rgba(255,255,255,0.07)" }} />
                  ))}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                {d.evidence
                  ? <p className="text-[11px] leading-relaxed text-muted">“{d.evidence}”</p>
                  : <p className="text-[10.5px] italic text-muted2">{lang === "zh" ? "无可引用原话" : "no verbatim quote"}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {(conv.hedging?.level ?? 0) > 0 && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-dashed border-line2 px-2.5 py-2">
          <span className="mt-[1px] flex-none text-[10px] uppercase tracking-wide text-muted2">{t("Hedging", "对冲语气")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3].map((i) => (
                <span key={i} className="h-1.5 w-4 rounded-full" style={{ background: i <= conv.hedging.level ? "#e0785a" : "rgba(255,255,255,0.07)" }} />
              ))}
              <span className="ml-0.5 font-mono text-[10.5px] font-semibold" style={{ color: "#e0785a" }}>−{Math.round((1 - conv.hedging.factor) * 100)}%</span>
              <span className="text-[10px] text-muted2">({fmtConv(conv.raw_total)} → {fmtConv(conv.total)})</span>
            </div>
            {conv.hedging.evidence && <p className="mt-1 text-[10.5px] italic leading-snug text-muted2">“{conv.hedging.evidence}”</p>}
          </div>
        </div>
      )}
      {conv.summary && <p className="mt-3 text-[11.5px] leading-relaxed text-muted">{conv.summary}</p>}
      {conv.source_url && (
        <a href={conv.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] text-signal hover:underline">
          {t("source ↗", "原文 ↗")}
        </a>
      )}
    </div>
  );
}

function Flag({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
        on ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-inset text-muted2"
      }`}
    >
      {on ? "✓ " : "· "}
      {children}
    </span>
  );
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
      <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted2">{label}</div>
      <div className="font-mono text-[15px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function GaugeMeter({ summary }: { summary: string }) {
  const lang = useStore((s) => s.lang);
  const g = GAUGE[summary] ?? GAUGE.neutral;
  return (
    <div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full">
        <div
          className="absolute inset-0"
          style={{
            background: "linear-gradient(90deg,#ff5a78,#f2a73c,#e9c46a,#7fce9e,#48c78e)",
          }}
        />
        <div
          className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded-full border-2 border-ink bg-white"
          style={{ left: `calc(${g.pos * 100}% - 3px)` }}
        />
      </div>
      <div className="mt-2 text-center text-[15px] font-semibold" style={{ color: g.color }}>
        {lbl(g, lang)}
      </div>
    </div>
  );
}

// Price line + volume bars.
function PriceChart({ closes, vols }: { closes: number[]; vols: number[] }) {
  const W = 720,
    H = 200,
    PADL = 40,
    PADR = 12,
    priceH = 130,
    volY = 150,
    volH = H - volY - 8;
  const n = closes.length;
  if (n < 2) return <div className="p-4 text-[12px] text-muted">数据太短。</div>;
  const xs = (i: number) => PADL + (i * (W - PADL - PADR)) / (n - 1);
  const pMax = Math.max(...closes),
    pMin = Math.min(...closes);
  const yP = (v: number) => 10 + (1 - (v - pMin) / (pMax - pMin || 1)) * (priceH - 10);
  const vMax = Math.max(1, ...vols);
  const yV = (v: number) => volY + (1 - v / vMax) * volH;
  const path = closes.map((c, i) => `${xs(i)},${yP(c)}`).join(" L");
  const up = closes[n - 1] >= closes[0];
  const col = up ? "#48c78e" : "#ff5a78";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: "100%" }}>
      {vols.map((v, i) => (
        <rect
          key={i}
          x={xs(i) - (W - PADL - PADR) / n / 2.6}
          y={yV(v)}
          width={(W - PADL - PADR) / n / 1.3}
          height={volY + volH - yV(v)}
          fill="rgba(95,124,153,.35)"
        />
      ))}
      <path d={`M${path}`} fill="none" stroke={col} strokeWidth="1.6" strokeLinejoin="round" />
      <text x="2" y="12" fontSize="9" fill="#5a6a7c">
        {pMax.toFixed(1)}
      </text>
      <text x="2" y={priceH} fontSize="9" fill="#5a6a7c">
        {pMin.toFixed(1)}
      </text>
      <text x="2" y={volY + 8} fontSize="9" fill="#5a6a7c">
        量 {(vMax / 1e6).toFixed(1)}M
      </text>
    </svg>
  );
}

// Price with the Bollinger envelope overlaid + a MACD-histogram subplot — the
// two indicators the entry-timing state is read from, so you can eyeball why a
// name reads oversold / overheated.
function TimingChart({ closes, band, t }: { closes: number[]; band: BandSeries; t: (en: string, zh: string) => string }) {
  const W = 720,
    H = 240,
    PADL = 40,
    PADR = 12,
    priceH = 150,
    macdY = 176,
    macdH = H - macdY - 8;
  const n = closes.length;
  if (n < 2) return <div className="p-4 text-[12px] text-muted">{t("series too short", "数据太短")}</div>;
  const xs = (i: number) => PADL + (i * (W - PADL - PADR)) / (n - 1);
  const bandVals = [...band.upper, ...band.lower, ...closes].filter((v): v is number => v != null);
  const pMax = Math.max(...bandVals),
    pMin = Math.min(...bandVals);
  const yP = (v: number) => 10 + (1 - (v - pMin) / (pMax - pMin || 1)) * (priceH - 10);
  // Bollinger envelope as a filled band between upper & lower (where both exist).
  const envTop: string[] = [];
  const envBot: string[] = [];
  for (let i = 0; i < n; i++) {
    if (band.upper[i] != null) envTop.push(`${xs(i)},${yP(band.upper[i]!)}`);
  }
  for (let i = n - 1; i >= 0; i--) {
    if (band.lower[i] != null) envBot.push(`${xs(i)},${yP(band.lower[i]!)}`);
  }
  const envelope = envTop.length && envBot.length ? `M${envTop.join(" L")} L${envBot.join(" L")} Z` : "";
  const midPath = band.middle
    .map((v, i) => (v != null ? `${xs(i)},${yP(v)}` : null))
    .filter(Boolean)
    .join(" L");
  const pricePath = closes.map((c, i) => `${xs(i)},${yP(c)}`).join(" L");
  const up = closes[n - 1] >= closes[0];
  const col = up ? "#48c78e" : "#ff5a78";
  // MACD histogram subplot (aligned to the right edge — it may be shorter than n).
  const hist = band.macd_hist;
  const hn = hist.length;
  const hOffset = n - hn; // right-align the histogram under the price
  const hMax = Math.max(1e-9, ...hist.map((h) => Math.abs(h)));
  const hZero = macdY + macdH / 2;
  const yH = (h: number) => hZero - (h / hMax) * (macdH / 2 - 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: "100%" }}>
      {envelope && <path d={envelope} fill="rgba(95,176,232,0.10)" stroke="none" />}
      <path d={`M${envTop.join(" L")}`} fill="none" stroke="#5fb0e8" strokeWidth="1" strokeOpacity="0.55" />
      <path d={`M${envBot.join(" L")}`} fill="none" stroke="#5fb0e8" strokeWidth="1" strokeOpacity="0.55" />
      {midPath && <path d={`M${midPath}`} fill="none" stroke="#e9c46a" strokeWidth="1" strokeDasharray="4 3" strokeOpacity="0.7" />}
      <path d={`M${pricePath}`} fill="none" stroke={col} strokeWidth="1.7" strokeLinejoin="round" />
      {/* MACD histogram */}
      <line x1={PADL} y1={hZero} x2={W - PADR} y2={hZero} stroke="#3a4a59" strokeWidth="0.7" />
      {hist.map((h, i) => {
        const gi = hOffset + i;
        return (
          <rect
            key={i}
            x={xs(gi) - (W - PADL - PADR) / n / 2.6}
            y={Math.min(hZero, yH(h))}
            width={(W - PADL - PADR) / n / 1.3}
            height={Math.abs(yH(h) - hZero)}
            fill={h >= 0 ? "rgba(72,199,142,0.75)" : "rgba(255,90,120,0.7)"}
          />
        );
      })}
      <text x="2" y="12" fontSize="9" fill="#5a6a7c">{pMax.toFixed(1)}</text>
      <text x="2" y={priceH} fontSize="9" fill="#5a6a7c">{pMin.toFixed(1)}</text>
      <text x="2" y={macdY + 8} fontSize="9" fill="#5a6a7c">MACD</text>
      <text x={W - PADR - 96} y="12" fontSize="9" fill="#5fb0e8">{t("Bollinger 20·2σ", "布林带 20·2σ")}</text>
    </svg>
  );
}

const REBOUND_PART_LABEL: Record<string, { en: string; zh: string; max: number }> = {
  macd_upturn: { en: "MACD upturn", zh: "MACD 拐头", max: 30 },
  rsi_divergence: { en: "RSI divergence", zh: "RSI 底背离", max: 25 },
  reclaim: { en: "%B reclaim", zh: "%B 收复", max: 20 },
  capitulation: { en: "Capitulation vol", zh: "恐慌放量", max: 15 },
  oversold_depth: { en: "Oversold depth", zh: "超卖深度", max: 10 },
};

const BREAKDOWN_PART_LABEL: Record<string, { en: string; zh: string; max: number }> = {
  macd_down: { en: "MACD rolling", zh: "MACD 走弱", max: 30 },
  below_mid_depth: { en: "Below MA20", zh: "跌破 MA20", max: 20 },
  ma20_roll: { en: "MA20 rolling", zh: "MA20 掉头", max: 20 },
  below_ma50: { en: "Lost MA50", zh: "跌破 MA50", max: 15 },
  breakdown_vol: { en: "Distribution vol", zh: "破位放量", max: 15 },
};

// The entry-timing readout: the state, the rebound-momentum breakdown (only when
// an oversold setup is live), and the raw Bollinger / MACD numbers behind it.
// The 0-4 week forward read — the headline verdict for a name. Score, tier, the
// receipts that fired, the five calibrated parts (the overextension penalty
// shown as the negative it is) and the narrative bonuses on top. This replaces
// the old "Strong Buy vs bear" collision: the trend gauge is context, this is
// the call.
const FWD_PARTS: { key: "band" | "below" | "lag" | "dip" | "hot"; max: number; en: string; zh: string }[] = [
  { key: "band", max: 45, en: "Band position", zh: "带内位置" },
  { key: "below", max: 10, en: "At lower band now", zh: "此刻跌破下轨" },
  { key: "lag", max: 30, en: "3-month laggard", zh: "3 个月落后" },
  { key: "dip", max: 15, en: "20d dip depth", zh: "20 日回撤深度" },
  { key: "hot", max: 10, en: "Overextended, fading", zh: "贴上轨·动能衰减" },
];
function ForwardPanel({ forward, lang, t }: { forward: ForwardScore; lang: Lang; t: (en: string, zh: string) => string }) {
  const meta = FORWARD_TIER[forward.tier];
  const narrative = forward.catBonus + forward.convBonus;
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: `${meta.color}55`, background: `linear-gradient(180deg, ${meta.color}12, transparent 70%)` }}>
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold">{t("Next 0-4 weeks · Forward Score", "未来 0–4 周 · 前瞻分")}</div>
          <div className="mt-0.5 text-[11px] text-muted2">{lang === "zh" ? meta.hint.zh : meta.hint.en}</div>
        </div>
        <div className="flex items-center gap-3">
          <ForwardBadge score={forward.score} size="lg" />
          <div className="text-right">
            <div className="font-disp text-[34px] font-bold leading-none tabular-nums" style={{ color: meta.color }}>{Math.round(forward.score)}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted2">/100</div>
          </div>
        </div>
      </div>

      {/* reason chain */}
      {forward.signals.length > 0 && (
        <div className="mb-3 mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted2">{t("Why", "理由")}</div>
          <SignalChips signals={forward.signals} />
        </div>
      )}

      {/* the five calibrated parts */}
      <div className="space-y-1.5">
        {FWD_PARTS.map((p) => {
          const v = forward.parts[p.key] ?? 0;
          const neg = p.key === "hot";
          const frac = Math.min(1, Math.abs(v) / p.max);
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span className="w-[118px] flex-none text-[10px] text-muted2">{t(p.en, p.zh)}</span>
              <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-inset">
                <span className="block h-full rounded-full" style={{ width: `${frac * 100}%`, background: v === 0 ? "transparent" : neg ? "#ff6b81" : meta.color }} />
              </div>
              <span className="w-[56px] flex-none text-right font-mono text-[10px]" style={{ color: neg && v < 0 ? "#ff6b81" : "#c7d2dc" }}>
                {v.toFixed(0)}/{neg ? "−" : ""}{p.max}
              </span>
            </div>
          );
        })}
      </div>

      {/* narrative layer */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel2/60 px-3 py-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] uppercase tracking-wide text-muted2">{t("Catalyst within 4 weeks", "4 周内催化剂")}</span>
            <span className="font-mono text-[13px] font-semibold" style={{ color: forward.catBonus > 0 ? "#7fb6e6" : "#5a6a7c" }}>
              +{forward.catBonus.toFixed(0)}<span className="text-[10px] text-muted2">/{FORWARD_CAT_MAX}</span>
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px] text-muted2">
            {forward.catScore != null
              ? t(`live TPMN ${forward.catScore.toFixed(1)}/10 · in ${forward.catDays}d`, `实时 TPMN ${forward.catScore.toFixed(1)}/10 · ${forward.catDays} 天后`)
              : t("none inside the window", "窗口内没有")}
          </div>
        </div>
        <div className="rounded-lg border border-line bg-panel2/60 px-3 py-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] uppercase tracking-wide text-muted2">{t("Management conviction", "管理层语气")}</span>
            <span className="font-mono text-[13px] font-semibold" style={{ color: forward.convBonus > 0 ? "#7fb6e6" : "#5a6a7c" }}>
              +{forward.convBonus.toFixed(0)}<span className="text-[10px] text-muted2">/{FORWARD_CONV_MAX}</span>
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px] text-muted2">
            {forward.convTotal != null ? t(`cited read ${forward.convTotal.toFixed(1)}/10`, `有引用的评分 ${forward.convTotal.toFixed(1)}/10`) : t("no cited read yet", "尚无可引用的评分")}
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10.5px] leading-relaxed text-muted2">
        {t(
          `Technical ${Math.round(forward.tech)} + narrative ${narrative.toFixed(0)}. The technical part was calibrated on this universe's realised 1/2/4-week returns (IC +0.06, positive on 65% of weeks, +2.0% top-vs-bottom quintile 4-week excess): at this horizon the edge is contrarian, so trend, momentum and "confirmed" rebounds carry no weight. The narrative part can't be calibrated on price history and is weighted by logic.`,
          `技术 ${Math.round(forward.tech)} + 叙事 ${narrative.toFixed(0)}。技术部分在这套universe的真实 1/2/4 周收益上校准(IC +0.06、65% 的周次为正、前后 1/5 组 4 周超额 +2.0%):这个周期的优势是逆向的,所以趋势、动量、“确认”拐头都不计权重。叙事部分无法用价格历史校准,按逻辑给权重。`,
        )}
      </div>
    </div>
  );
}

function TimingPanel({ timing, band, closes, t }: { timing: TechTiming; band: BandSeries | null | undefined; closes: number[]; t: (en: string, zh: string) => string }) {
  const meta = TIMING_META[timing.timing];
  const pctb = timing.bb.pctb;
  // Rebound momentum only means something in the oversold zone — showing it on a
  // name pressed to the upper band (with "oversold" copy) was the source of the
  // old confusion. Up there the honest read is extension, not rebound.
  const showRebound = (timing.timing === "strong_buy" || timing.timing === "band_break" || timing.timing === "oversold_watch") && pctb < 0.5;
  const showExtension = pctb >= 0.8 && !showRebound;
  const showBreakdown = timing.timing === "breakdown" || timing.timing === "trim";
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{t("Entry Timing · Bollinger + MACD", "择时买点 · 布林带 + MACD")}</div>
        <TimingBadge timing={timing} size="md" />
      </div>

      <div className="mb-2 text-[11.5px] leading-relaxed text-muted2">{t(meta.hint.en, meta.hint.zh)}</div>

      {/* signal receipts — why this reads the way it does */}
      {timing.signals && timing.signals.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted2">{t("Signals firing", "触发信号")}</div>
          <SignalChips signals={timing.signals} />
        </div>
      )}

      {band && closes.length >= 2 && <TimingChart closes={closes} band={band} t={t} />}

      {/* rebound-momentum breakdown (oversold-zone setups only) */}
      {showRebound && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11.5px] font-semibold text-muted">{t("Rebound momentum", "反弹动能")}</span>
            <span className="font-mono text-[15px] font-semibold" style={{ color: timing.rebound >= 50 ? "#48c78e" : "#f0c862" }}>
              {timing.rebound}<span className="text-[11px] text-muted2">/100</span>
            </span>
          </div>
          <div className="text-[10.5px] text-muted2">
            {timing.rebound >= 50
              ? t("Sellers exhausted — the bounce has strength (扣扳机).", "卖压衰竭，反弹有劲（扣扳机）。")
              : t("Oversold but the turn isn't confirmed — may still fall (埋伏).", "超卖但拐头未确认，可能续跌（埋伏）。")}
            {" "}
            {t("Note: the calibration found the raw band break led the next 4 weeks MORE than waiting for confirmation.", "注:校准显示,裸的跌破下轨比等确认后再买,接下来 4 周表现更好。")}
          </div>
          {timing.rebound_parts && (
            <div className="mt-2 space-y-1.5">
              {Object.entries(REBOUND_PART_LABEL).map(([k, m]) => {
                const v = timing.rebound_parts?.[k] ?? 0;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-[92px] flex-none text-[10px] text-muted2">{t(m.en, m.zh)}</span>
                    <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-inset">
                      <span className="block h-full rounded-full" style={{ width: `${(v / m.max) * 100}%`, background: v > 0 ? "#48c78e" : "transparent" }} />
                    </div>
                    <span className="w-[46px] flex-none text-right font-mono text-[10px] text-muted">{v.toFixed(0)}/{m.max}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* extension read (pressed to the upper band) */}
      {showExtension && (
        <div className="mt-3 rounded-lg border border-dashed px-3 py-2.5" style={{ borderColor: "#c99bf055" }}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[11.5px] font-semibold text-muted">{t("Extension", "延展度")}</span>
            <span className="font-mono text-[13px] font-semibold" style={{ color: "#c99bf0" }}>%B {pctb.toFixed(2)}</span>
          </div>
          <div className="text-[10.5px] leading-relaxed text-muted2">
            {timing.macd.hist_prev != null && timing.macd.hist < timing.macd.hist_prev
              ? t(
                  "Pressed to the upper band with momentum fading — the calibration found these do NOT lead the next 4 weeks. Wait for the pullback into the bands.",
                  "贴着上轨且动能衰减——校准显示这类票接下来 4 周并不领涨。等回落进轨道再买。",
                )
              : t(
                  "Pressed to the upper band with momentum still rising — a hold, not a fresh buy; the next 4 weeks favoured the laggards.",
                  "贴着上轨、动能仍在上行——持有而非新买;接下来 4 周历史上更偏向落后者。",
                )}
          </div>
        </div>
      )}

      {/* breakdown-severity meter (sell / de-risk states) */}
      {showBreakdown && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11.5px] font-semibold text-muted">{t("Breakdown severity", "破位强度")}</span>
            <span className="font-mono text-[15px] font-semibold" style={{ color: "#ff6b81" }}>
              {timing.breakdown}<span className="text-[11px] text-muted2">/100</span>
            </span>
          </div>
          <div className="text-[10.5px] text-muted2">
            {t(
              "A de-risk WARNING, not a forced exit — the entry structure has broken (below MA20, momentum down). Trim / tighten; a fresh oversold dip can be re-bought.",
              "这是减仓预警,不是强制清仓——买入结构已破(跌破 MA20、动能向下)。减仓/收紧;若再砸到超卖可重新买回。",
            )}
          </div>
          {timing.breakdown_parts && (
            <div className="mt-2 space-y-1.5">
              {Object.entries(BREAKDOWN_PART_LABEL).map(([k, m]) => {
                const v = timing.breakdown_parts?.[k] ?? 0;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-[92px] flex-none text-[10px] text-muted2">{t(m.en, m.zh)}</span>
                    <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-inset">
                      <span className="block h-full rounded-full" style={{ width: `${(v / m.max) * 100}%`, background: v > 0 ? "#ff6b81" : "transparent" }} />
                    </div>
                    <span className="w-[46px] flex-none text-right font-mono text-[10px] text-muted">{v.toFixed(0)}/{m.max}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* raw indicator numbers */}
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat
          label={t("%B (band pos.)", "%B 带内位置")}
          value={pctb.toFixed(2)}
          color={pctb < 0.05 ? "#48c78e" : pctb > 1 ? "#c99bf0" : undefined}
        />
        <Stat label={t("Bandwidth", "带宽")} value={`${(timing.bb.bandwidth * 100).toFixed(1)}%`} color={timing.squeeze ? "#f0c862" : undefined} />
        <Stat label={t("Trend regime", "趋势体制")} value={t(timing.regime, timing.regime === "up" ? "上涨" : timing.regime === "down" ? "下跌" : "震荡")} />
        <Stat label={t("MACD hist z", "MACD 柱 z")} value={timing.macd.hist_z.toFixed(2)} color={timing.macd.hist_z <= -1.5 ? "#48c78e" : undefined} />
        <Stat label="MACD line" value={timing.macd.line.toFixed(3)} color={timing.macd.line >= 0 ? "#48c78e" : "#ff5a78"} />
        <Stat label={t("MACD cross", "MACD 交叉")} value={timing.macd.cross === "bull" ? t("bull", "金叉") : t("bear", "死叉")} color={timing.macd.cross === "bull" ? "#48c78e" : "#ff5a78"} />
        <Stat label={t("Upper / Lower", "上轨/下轨")} value={`${timing.bb.upper} / ${timing.bb.lower}`} />
        <Stat label="MA20" value={`$${timing.bb.middle}`} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Flag on={timing.divergence}>{t("RSI bullish divergence", "RSI 底背离")}</Flag>
        <Flag on={timing.squeeze}>{t("Bollinger squeeze", "布林收口")}</Flag>
      </div>

      <div className="mt-3 text-[11px] leading-relaxed text-muted2">
        {t(
          "A buy-only entry overlay on a name the funnel already likes: buy oversold weakness once the bounce confirms, or buy the pullback back into the bands after a breakout. Never a filter — a good company at a bad price just waits.",
          "在漏斗已经看好的票上叠加的『只做买点』择时：超卖见底、反弹确认后买入，或突破后回落进轨道再买。它从不做筛选——好公司但价格不好，就等。",
        )}
      </div>
    </div>
  );
}

// Ecosystem map. Suppliers flow in from the left, customers out to the right —
// a clean two-sided value chain (links stay in their own half, so they never
// cross). Competitors (peers) aren't a flow, so they sit in a chip strip below.
// Nodes in our own Buy universe glow with a ↗ badge and are clickable.
const SC_GROUPS = {
  upstream: { en: "Upstream · suppliers", zh: "上游 · 供应商", color: "#5fb0e8" },
  downstream: { en: "Downstream · customers", zh: "下游 · 客户", color: "#48c78e" },
  peers: { en: "Peers · competitors", zh: "同业 · 竞品", color: "#e9c46a" },
} as const;

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function SupplyChainGraph({
  ticker,
  company,
  map,
  inUniverse,
}: {
  ticker: string;
  company: string;
  map: SupplyMap;
  inUniverse: Set<string>;
}) {
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const up = map.upstream ?? [];
  const down = map.downstream ?? [];
  const peers = map.peers ?? [];
  const groups: { key: keyof typeof SC_GROUPS; edges: SupplyEdge[] }[] = [
    { key: "upstream", edges: up },
    { key: "downstream", edges: down },
    { key: "peers", edges: peers },
  ];
  if (up.length + down.length + peers.length === 0) return null;

  const inUni = (e: SupplyEdge) => !!e.ticker && e.ticker !== ticker && inUniverse.has(e.ticker);

  // --- two-column flow geometry ---
  const W = 640;
  const cx = W / 2;
  const nodeW = 108;
  const nodeH = 34;
  const rowH = 54;
  const topPad = 18;
  const rows = Math.max(up.length, down.length, 1);
  const H = topPad * 2 + rows * rowH;
  const cy = topPad + (rows * rowH) / 2;
  const leftX = 92;
  const rightX = W - 92;
  const colY = (i: number, n: number) => cy + (i - (n - 1) / 2) * rowH;
  const cW = 138;
  const cH = 46;

  function SideNode({ e, x, y, color, dir }: { e: SupplyEdge; x: number; y: number; color: string; dir: 1 | -1 }) {
    const hot = inUni(e);
    const hasBoth = !!e.ticker && !!e.name;
    const label = e.ticker || trunc(e.name, 15);
    const bx = x + (nodeW / 2) * dir; // outer corner for the badge
    return (
      <g
        style={{ cursor: hot ? "pointer" : "default" }}
        onClick={hot ? () => openDetail(e.ticker) : undefined}
      >
        <title>{(e.name || e.ticker) + (e.reason ? ` — ${e.reason}` : "")}</title>
        <rect
          x={x - nodeW / 2}
          y={y - nodeH / 2}
          width={nodeW}
          height={nodeH}
          rx={9}
          fill={hot ? `${color}2b` : "#131c25"}
          stroke={hot ? color : `${color}3a`}
          strokeWidth={hot ? 2.4 : 1}
          style={hot ? { filter: `drop-shadow(0 0 7px ${color})` } : undefined}
        />
        <text
          x={x}
          y={hasBoth ? y - 1 : y + 3.5}
          textAnchor="middle"
          fontSize={e.ticker ? 12 : 10.5}
          fontFamily={e.ticker ? "ui-monospace, monospace" : "inherit"}
          fontWeight={hot ? 700 : 500}
          fill={hot ? "#fff" : "#9aa7b3"}
        >
          {label}
        </text>
        {hasBoth && (
          <text x={x} y={y + 10} textAnchor="middle" fontSize="7.5" fill={hot ? color : "#5f6d7a"}>
            {trunc(e.name, 18)}
          </text>
        )}
        {hot && (
          <>
            <circle cx={bx - 3 * dir} cy={y - nodeH / 2 + 3} r="7.5" fill={color} />
            <text x={bx - 3 * dir} y={y - nodeH / 2 + 6.5} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#0c141b">
              ↗
            </text>
          </>
        )}
      </g>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{t("Supply-Chain Ecosystem", "供应链生态图")}</div>
        <div className="flex gap-3 text-[10.5px]">
          {groups.map((g) => (
            <span key={g.key} className="flex items-center gap-1 text-muted2">
              <span className="h-2 w-2 rounded-full" style={{ background: SC_GROUPS[g.key].color }} />
              {lbl({ ...SC_GROUPS[g.key] }, lang)}
            </span>
          ))}
        </div>
      </div>
      <div className="mb-2 text-[11px] leading-relaxed text-muted2">
        {t(
          "AI-derived, major relationships only — not exhaustive. Suppliers flow in from the left, customers out to the right. A ↗ node is in your Buy universe — click it (or its card below) to open that ticker.",
          "AI 推断，仅列主要关系，非穷举。左边流入的是供应商，右边流出的是客户。带 ↗ 的节点在你的 Buy universe 内——点它（或下方卡片）即可跳到那只票。",
        )}
        {map.model ? ` · ${map.model}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: "100%" }}>
        {/* curved connectors — left links stay left, right links stay right */}
        {up.map((e, i) => {
          const y = colY(i, up.length);
          const sx = cx - cW / 2;
          const ex = leftX + nodeW / 2;
          const hot = inUni(e);
          return (
            <path
              key={`ul${i}`}
              d={`M${sx},${cy} C${sx - 46},${cy} ${ex + 46},${y} ${ex},${y}`}
              fill="none"
              stroke={hot ? SC_GROUPS.upstream.color : `${SC_GROUPS.upstream.color}40`}
              strokeWidth={hot ? 2 : 1.1}
            />
          );
        })}
        {down.map((e, i) => {
          const y = colY(i, down.length);
          const sx = cx + cW / 2;
          const ex = rightX - nodeW / 2;
          const hot = inUni(e);
          return (
            <path
              key={`dl${i}`}
              d={`M${sx},${cy} C${sx + 46},${cy} ${ex - 46},${y} ${ex},${y}`}
              fill="none"
              stroke={hot ? SC_GROUPS.downstream.color : `${SC_GROUPS.downstream.color}40`}
              strokeWidth={hot ? 2 : 1.1}
            />
          );
        })}
        {/* center node */}
        <rect
          x={cx - cW / 2}
          y={cy - cH / 2}
          width={cW}
          height={cH}
          rx={11}
          fill="#0e2a3a"
          stroke="#3dd6c4"
          strokeWidth="2"
          style={{ filter: "drop-shadow(0 0 9px #3dd6c477)" }}
        />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="15" fontFamily="ui-monospace, monospace" fontWeight="700" fill="#3dd6c4">
          {ticker}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="8.5" fill="#8aa">
          {trunc(company || "", 24)}
        </text>
        {/* nodes */}
        {up.map((e, i) => (
          <SideNode key={`un${i}`} e={e} x={leftX} y={colY(i, up.length)} color={SC_GROUPS.upstream.color} dir={-1} />
        ))}
        {down.map((e, i) => (
          <SideNode key={`dn${i}`} e={e} x={rightX} y={colY(i, down.length)} color={SC_GROUPS.downstream.color} dir={1} />
        ))}
      </svg>

      {/* peers — a competitor strip (not a flow), clickable when in-universe */}
      {peers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: SC_GROUPS.peers.color }}>
            <span className="h-2 w-2 rounded-full" style={{ background: SC_GROUPS.peers.color }} />
            {lbl({ ...SC_GROUPS.peers }, lang)}
          </span>
          {peers.map((e, i) => {
            const hot = inUni(e);
            return (
              <button
                key={i}
                onClick={hot ? () => openDetail(e.ticker) : undefined}
                title={(e.name || e.ticker) + (e.reason ? ` — ${e.reason}` : "")}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] font-medium ${hot ? "cursor-pointer text-white" : "cursor-default"}`}
                style={{
                  borderColor: hot ? SC_GROUPS.peers.color : `${SC_GROUPS.peers.color}3a`,
                  background: hot ? `${SC_GROUPS.peers.color}26` : "transparent",
                  color: hot ? "#fff" : "#9aa7b3",
                  boxShadow: hot ? `0 0 7px ${SC_GROUPS.peers.color}` : undefined,
                }}
              >
                {e.ticker || trunc(e.name, 16)}
                {hot ? " ↗" : ""}
              </button>
            );
          })}
        </div>
      )}

      {/* relationship reader — every edge with its reason, always visible */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: SC_GROUPS[g.key].color }}>
              <span className="h-2 w-2 rounded-full" style={{ background: SC_GROUPS[g.key].color }} />
              {lbl({ ...SC_GROUPS[g.key] }, lang)}
              <span className="text-muted2">· {g.edges.length}</span>
            </div>
            <div className="space-y-1.5">
              {g.edges.length === 0 && <div className="text-[11px] text-muted2">—</div>}
              {g.edges.map((e, i) => {
                const hot = inUni(e);
                return (
                  <div
                    key={i}
                    onClick={hot ? () => openDetail(e.ticker) : undefined}
                    className={`rounded-lg border px-2.5 py-1.5 ${
                      hot
                        ? "cursor-pointer border-line2 bg-white/[0.04] hover:bg-white/[0.08]"
                        : "border-line bg-panel"
                    }`}
                    style={hot ? { borderColor: `${SC_GROUPS[g.key].color}66` } : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] font-semibold" style={{ color: hot ? SC_GROUPS[g.key].color : "#c7d2dc" }}>
                        {e.ticker || trunc(e.name, 15)}
                      </span>
                      {hot && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold"
                          style={{ color: "#0c141b", background: SC_GROUPS[g.key].color }}
                        >
                          {t("open ↗", "打开 ↗")}
                        </span>
                      )}
                    </div>
                    {e.ticker && e.name && <div className="text-[10.5px] text-muted">{e.name}</div>}
                    {e.reason && <div className="mt-0.5 text-[11px] leading-snug text-muted2">{e.reason}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StockDetail() {
  const ticker = useStore((s) => s.detail);
  const close = useStore((s) => s.closeDetail);
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const catalyst = useStore((s) => s.catalyst);
  const catalystData = useStore((s) => s.catalystData);
  const conviction = useStore((s) => s.conviction);
  const marketCaps = useStore((s) => s.marketCaps);
  const lang = useStore((s) => s.lang);
  const t = useT();

  // Live per-ticker refresh: the daily launchd job only rewrites the shared
  // technical file once a day, so opening a ticker hits the server's on-demand
  // /api/quote endpoint for a fresh yfinance pull, then re-polls every 60s while
  // the panel is open. Falls back to the cached file if the fetch fails.
  const [live, setLive] = useState<(TechTicker & { generated_at?: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveErr, setLiveErr] = useState(false);

  const refresh = useCallback(async () => {
    if (!ticker) return;
    setLoading(true);
    setLiveErr(false);
    // The first on-demand yfinance pull is often slow/cold and can drop once
    // (proxy hiccup) — which left the panel stuck on the stale daily close until
    // you clicked refresh. Retry a couple of times so the AUTO-load succeeds.
    const attempt = async (): Promise<boolean> => {
      try {
        const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}&t=${Date.now()}`);
        if (!res.ok) throw new Error(String(res.status));
        const j = await res.json();
        if (j && typeof j.price === "number") {
          setLive(j as TechTicker & { generated_at?: string });
          return true;
        }
      } catch {
        /* fall through to retry */
      }
      return false;
    };
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
      ok = await attempt();
    }
    setLiveErr(!ok);
    setLoading(false);
  }, [ticker]);

  useEffect(() => {
    setLive(null);
    setLiveErr(false);
    if (!ticker) return;
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [ticker, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const seed = useMemo(
    () => (ticker ? buildSeeds(data).find((s) => s.ticker === ticker) : undefined),
    [data, ticker],
  );
  const caps = useMemo(
    () => (ticker ? buildUniverse(data).find((u) => u.ticker === ticker)?.caps ?? [] : []),
    [data, ticker],
  );
  const inUniverse = useMemo(
    () => new Set(buildUniverse(data).map((u) => u.ticker)),
    [data],
  );
  const focusItem = useMemo(
    () =>
      ticker
        ? buildFocus(data, heat, technical, marketCaps, sectors, supplychain).find((f) => f.ticker === ticker)
        : undefined,
    [data, heat, technical, marketCaps, sectors, supplychain, ticker],
  );
  const shortlistRow = useMemo(() => {
    if (!ticker) return undefined;
    const focus = buildFocus(data, heat, technical, marketCaps, sectors, supplychain);
    return buildShortlist(focus, catalyst).find((r) => r.ticker === ticker);
  }, [ticker, data, heat, technical, marketCaps, sectors, supplychain, catalyst]);
  const advBy = useMemo(
    () => (ticker ? buildRankings(data, heat, technical, marketCaps).advancingBy.get(ticker) ?? [] : []),
    [data, heat, technical, marketCaps, ticker],
  );

  if (!ticker) return null;
  const tech: TechTicker | undefined = live ?? technical?.tickers?.[ticker];
  const liveTime = live?.generated_at
    ? new Date(live.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  // When the on-demand live fetch fails (e.g. no VPN to Yahoo), show WHEN the
  // cached daily snapshot was taken instead of a vague label.
  const snapTime = technical?.generated_at
    ? new Date(technical.generated_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const h = heat?.tickers?.[ticker];
  // Prefer the reliable sectors.json .info market cap; fall back to the flaky
  // fast_info feed. (Run `python -m newsagg.sectors` to backfill caps.)
  const secMc = sectors?.[ticker]?.market_cap;
  const mc = typeof secMc === "number" && secMc > 0 ? secMc : marketCaps?.[ticker];
  const cap = capSizeFromCap(mc, caps);
  const a = tech?.attention;
  const attnIgnites = a?.ignites ?? false;
  const passes = passesHeatGate(mc, h?.phase ?? "", attnIgnites);
  const company = seed?.company ?? "";

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm" onClick={close}>
      <div
        className="my-6 h-fit w-full max-w-3xl rounded-2xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between border-b border-line px-6 py-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[22px] font-bold text-signal">{ticker}</span>
              {tech && (
                <span className="font-mono text-[20px] font-semibold tabular-nums">
                  ${tech.price.toFixed(2)}
                </span>
              )}
              {tech?.change_pct != null && (
                <span
                  className="font-mono text-[14px] font-semibold"
                  style={{ color: tech.change_pct >= 0 ? "#48c78e" : "#ff5a78" }}
                >
                  {tech.change_pct >= 0 ? "+" : ""}
                  {tech.change_pct.toFixed(2)}%
                </span>
              )}
              <button
                onClick={refresh}
                disabled={loading}
                title={t("Refresh live quote", "刷新实时报价")}
                className="ml-1 grid h-6 w-6 place-items-center rounded-md border border-line text-[13px] text-muted hover:text-text disabled:opacity-50"
              >
                <span className={loading ? "inline-block animate-spin" : ""}>⟳</span>
              </button>
              {liveTime ? (
                <span className="flex items-center gap-1 text-[11px] text-ok">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
                  {t(`Live · ${liveTime}`, `实时 · ${liveTime}`)}
                </span>
              ) : liveErr ? (
                <span
                  className="flex items-center gap-1 text-[11px] text-muted2"
                  title={t(
                    "Live quote fetch failed (needs the VPN proxy to reach Yahoo). Showing the latest daily snapshot — it auto-upgrades to Live once the fetch works.",
                    "实时报价抓取失败（需要 VPN 代理才能连 Yahoo）。显示最近一次每日快照——抓取一旦成功会自动切回实时。",
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-muted2/60" />
                  {snapTime ? t(`snapshot · ${snapTime}`, `快照 · ${snapTime}`) : t("daily snapshot", "每日快照")}
                </span>
              ) : loading ? (
                <span className="text-[11px] text-muted2">{t("· fetching…", "· 抓取中…")}</span>
              ) : null}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {company || "—"} · {capLabel(cap, lang)}
              {mc ? (
                <>
                  {" · "}
                  <span className={mc >= 1e12 ? "font-medium text-[#f0d78a]" : ""}>
                    {mc >= 1e12 ? `$${(mc / 1e12).toFixed(2)}T` : `$${(mc / 1e9).toFixed(1)}B`}
                    {mc >= 1e12 ? t(" · large cap", " · 大盘") : ""}
                  </span>
                </>
              ) : (
                <span className="text-muted2">{t(" · cap n/a", " · 市值缺失")}</span>
              )}
              {sectors?.[ticker]?.sector ? ` · ${sectorLabel(sectors[ticker].sector, lang)}` : ""}
              {sectors?.[ticker]?.industry ? ` · ${sectors[ticker].industry}` : ""}
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-lg border border-line px-3 py-1 text-[13px] text-muted hover:text-text"
          >
            {t("Close ✕", "关闭 ✕")}
          </button>
        </div>

        <div className="space-y-4 p-6">
          {/* gate summary */}
          <div className="flex flex-wrap items-center gap-2">
            {bypassesHeat(mc) ? (
              <span className="rounded-full border border-signal/40 bg-signal/10 px-3 py-1 text-[12px] font-medium text-signal">
                {t("Mega-cap bypass (≥$100B)", "大票直通（≥$100B）")}
              </span>
            ) : (
              <span
                className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
                  passes ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-inset text-muted2"
                }`}
              >
                {passes ? t("Passes heat gate", "通过热度闸") : t("No heat gate", "未过热度闸")}
              </span>
            )}
            {a && (
              <span
                className="rounded-full border px-3 py-1 text-[12px] font-medium"
                style={{
                  color: (ATTN[a.phase] ?? ATTN.quiet).color,
                  borderColor: `${(ATTN[a.phase] ?? ATTN.quiet).color}66`,
                  background: `${(ATTN[a.phase] ?? ATTN.quiet).color}18`,
                }}
              >
                {t("PV", "量价")} · {lbl(ATTN[a.phase] ?? ATTN.quiet, lang)} · {a.score}
              </span>
            )}
            {h && (
              <span
                className="rounded-full border px-3 py-1 text-[12px] font-medium"
                style={{
                  color: (SOCIAL[h.phase] ?? SOCIAL.dead).color,
                  borderColor: `${(SOCIAL[h.phase] ?? SOCIAL.dead).color}66`,
                  background: `${(SOCIAL[h.phase] ?? SOCIAL.dead).color}18`,
                }}
              >
                {t("Social", "社交")} · {lbl(SOCIAL[h.phase] ?? SOCIAL.dead, lang)}
                {h.z != null ? ` · z ${h.z.toFixed(2)}` : ""}
              </span>
            )}
          </div>

          {focusItem && <ScoreBreakdown item={focusItem} advBy={advBy} lang={lang} t={t} />}

          {catalyst?.[ticker] && catalyst[ticker].catalysts.length > 0 && (
            <CatBreakdown cat={catalyst[ticker]} lang={lang} t={t} />
          )}

          {catalystData?.[ticker] && catalystData[ticker].catalysts.length > 0 && (
            <LiveSignals cat={catalystData[ticker]} lang={lang} t={t} />
          )}

          {shortlistRow && <ShortlistBreakdown row={shortlistRow} lang={lang} t={t} />}

          {conviction?.[ticker] && conviction[ticker].ok && (
            <ConvBreakdown conv={conviction[ticker]} lang={lang} t={t} />
          )}

          {!tech && (
            <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-5 text-center text-[13px] text-muted">
              {t("No price-volume data for this ticker yet. Run ", "还没有该票的量价数据。在 Mac 上运行 ")}
              <code className="font-mono text-signal">python -m newsagg.technical</code>
              {t(" on the Mac.", " 后自动出现。")}
            </div>
          )}

          {tech && (
            <>
              {/* price + volume */}
              <div className="rounded-xl border border-line bg-panel2 p-4">
                <div className="mb-2 text-[12px] font-semibold text-muted">
                  {t(`Price · Volume (last ${tech.close_series.length}d)`, `价格 · 成交量（近 ${tech.close_series.length} 日）`)}
                </div>
                <PriceChart closes={tech.close_series} vols={tech.vol_series} />
              </div>

              {/* 0-4 week forward score — the headline call (technical base + narrative bonus) */}
              {tech.fwd4w &&
                (() => {
                  const fw = buildForward(tech, catalyst?.[ticker ?? ""] ?? null, catalystData?.[ticker ?? ""] ?? null, conviction?.[ticker ?? ""] ?? null);
                  return fw ? <ForwardPanel forward={fw} lang={lang} t={t} /> : null;
                })()}

              {/* entry timing — Bollinger + MACD */}
              {tech.timing && (
                <TimingPanel timing={tech.timing} band={tech.band_series} closes={tech.close_series} t={t} />
              )}

              {/* attention detail */}
              {a && (
                <div className="rounded-xl border border-line bg-panel2 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-[13px] font-semibold">{t("Price-Volume Attention", "量价注意力信号")}</div>
                    <div className="text-[12px] text-muted">
                      {t("score", "注意力分")} <span className="font-mono font-semibold text-signal">{a.score}</span>/100
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <Stat label={t("RVOL", "RVOL 相对量")} value={a.rvol != null ? `${a.rvol.toFixed(2)}×` : "—"} color={a.rvol && a.rvol >= 1.5 ? "#3dd6c4" : undefined} />
                    <Stat label={t("Dist. to 20d high", "距20日高")} value={a.dist_to_high != null ? `${(a.dist_to_high * 100).toFixed(1)}%` : "—"} />
                    <Stat label={t("ATR", "ATR 波动")} value={tech.atr_pct != null ? `${tech.atr_pct}%` : "—"} />
                    <Stat label="SMA50" value={tech.sma50 != null ? `$${tech.sma50}` : "—"} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Flag on={a.new_high_20d}>{t("20d high", "20日新高")}</Flag>
                    <Flag on={a.new_high_52w}>{t("52w high", "52周新高")}</Flag>
                    <Flag on={a.obv_up}>{t("OBV up", "OBV 吸筹")}</Flag>
                    <Flag on={a.above_sma50}>{t("Above SMA50", "站上 SMA50")}</Flag>
                    <Flag on={a.sma50_rising}>{t("SMA50 rising", "SMA50 上行")}</Flag>
                  </div>
                </div>
              )}

              {/* technical gauge (display only) */}
              <div className="rounded-xl border border-line bg-panel2 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-[13px] font-semibold text-muted">{t("Trend context · mechanical gauge", "趋势背景 · 机械表针")}</div>
                  <div className="text-[11px] text-muted2">{t("MA + oscillator vote · lags · carried no 4-week forward power in calibration", "MA + 震荡指标投票 · 滞后 · 校准显示对 4 周无前瞻力")}</div>
                </div>
                <GaugeMeter summary={tech.gauge.summary} />
                {tech.buy_streak != null && (
                  <div className="mt-3 flex items-center justify-center gap-2 text-[12px]">
                    <span className="text-muted2">{t("Sustained buy", "持续买入迹象")}</span>
                    <span
                      className="rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold"
                      style={
                        tech.buy_streak >= 5
                          ? { color: "#48c78e", borderColor: "#48c78e66", background: "#48c78e18" }
                          : { color: "#8695a3", borderColor: "var(--line, #2a3a49)" }
                      }
                    >
                      {t(`${tech.buy_streak} / 5 days`, `连续 ${tech.buy_streak} / 5 天`)}
                    </span>
                  </div>
                )}
                <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <Stat label={t("MA buy/sell", "均线 买/卖")} value={`${tech.gauge.ma_buy} / ${tech.gauge.ma_sell}`} />
                  <Stat label={t("Osc buy/neu/sell", "震荡 买/中/卖")} value={`${tech.gauge.osc_buy}/${tech.gauge.osc_neutral}/${tech.gauge.osc_sell}`} />
                  <Stat label="RSI(14)" value={tech.gauge.rsi != null ? tech.gauge.rsi.toFixed(1) : "—"} color={tech.gauge.rsi != null ? (tech.gauge.rsi > 70 ? "#ff5a78" : tech.gauge.rsi < 30 ? "#48c78e" : undefined) : undefined} />
                  <Stat label={t("MACD hist", "MACD 柱")} value={tech.gauge.macd_hist != null ? tech.gauge.macd_hist.toFixed(2) : "—"} color={tech.gauge.macd_hist != null ? (tech.gauge.macd_hist >= 0 ? "#48c78e" : "#ff5a78") : undefined} />
                </div>
                <div className="mt-3 text-[11.5px] leading-relaxed text-muted2">
                  {t(
                    "Note: a mechanical MA + oscillator vote — in a downtrend it often reads Sell even on a big up day. Read it for posture, not as a filter.",
                    "注：这是均线与震荡指标的机械投票，趋势下行时即便当天大涨也常显示卖出——用来看当前姿态，不作为筛选依据。",
                  )}
                </div>
              </div>
            </>
          )}

          {/* supply-chain ecosystem */}
          {supplychain?.[ticker] &&
            (supplychain[ticker].upstream?.length ||
              supplychain[ticker].downstream?.length ||
              supplychain[ticker].peers?.length) ? (
            <SupplyChainGraph
              ticker={ticker}
              company={company}
              map={supplychain[ticker]}
              inUniverse={inUniverse}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-4 text-center text-[12px] text-muted2">
              {t(
                "No supply-chain map yet. It appears after ",
                "还没有供应链生态图。在 Mac 上运行 ",
              )}
              <code className="font-mono text-signal">python -m newsagg.supplychain</code>
              {t(" runs on the Mac (needs OPENAI_API_KEY).", " 后出现（需 OPENAI_API_KEY）。")}
            </div>
          )}

          {/* SA thesis */}
          {seed && (seed.hasThesis || seed.rating) && (
            <div className="rounded-xl border border-line bg-panel2 p-4">
              <div className="mb-2 text-[13px] font-semibold">{t("SeekingAlpha Bull Thesis", "SeekingAlpha 看多论点")}</div>
              <div className="mb-2 flex flex-wrap gap-2 text-[12px] text-muted">
                {seed.rating && (
                  <span className="rounded-md border border-gold/40 bg-gold/10 px-2 py-0.5 font-medium text-gold">
                    {seed.rating}
                  </span>
                )}
                {seed.author && <span>{t("Analyst: ", "分析师：")}{seed.author}</span>}
              </div>
              {seed.articleUrl ? (
                <a
                  href={seed.articleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] text-signal hover:underline"
                >
                  {seed.reasoning || t("View article", "查看文章")} ↗
                </a>
              ) : (
                <div className="text-[13px] text-muted">{seed.reasoning || "—"}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
