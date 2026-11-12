import { useEffect, useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import {
  buildFocus,
  buildShortlist,
  capLabel,
  sectorLabel,
  timingSortKey,
  SHORTLIST_CAT_BAR,
  SHORTLIST_W,
  type LeaderRow,
} from "../pipeline";
import { ViewHead, TimingBadge } from "../ui";
import type { TechTiming } from "../../types";

const TIER_META: Record<1 | 2 | 3, { color: string; glow: string; medal: string; en: string; zh: string; cond: { en: string; zh: string } }> = {
  1: { color: "#f0c862", glow: "#f0c862", medal: "1st", en: "First — all three", zh: "第一名榜单 · 三条全中", cond: { en: "Focus · Core · Catalyst > 6", zh: "在名单 · 核心 · 催化剂 > 6" } },
  2: { color: "#cdd6e2", glow: "#cdd6e2", medal: "2nd", en: "Second — two of three", zh: "第二名榜单 · 满足两条", cond: { en: "Focus + one of Core / Catalyst > 6", zh: "在名单 + 核心/催化剂>6 其一" } },
  3: { color: "#cd8b5e", glow: "#cd8b5e", medal: "3rd", en: "Third — focus only", zh: "第三名榜单 · 仅在名单", cond: { en: "on the Focus List", zh: "仅在重点名单里" } },
};
const LENS = { cat: "#48c78e", focus: "#3dd6c4", attn: "#5fb0e8" } as const;

// Animated strength meter — fills from 0 → value each time it mounts (so it
// re-plays when you switch tabs).
function Strength({ v, color, delay }: { v: number; color: string; delay: number }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setGrown(true), 40 + delay);
    return () => clearTimeout(id);
  }, [delay]);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-inset">
      <div
        className="h-full rounded-full"
        style={{
          width: grown ? `${Math.max(2, v)}%` : "0%",
          background: `linear-gradient(90deg, ${color}77, ${color})`,
          boxShadow: `0 0 8px ${color}88`,
          transition: "width 0.9s cubic-bezier(0.22,0.61,0.36,1)",
        }}
      />
    </div>
  );
}

// A compact lens value with its own tiny bar.
function Lens({ label, value, pct, color, on }: { label: string; value: string; pct: number; color: string; on?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[8.5px] uppercase tracking-wide text-muted2">{label}</span>
        <span className="font-mono text-[11px] font-semibold" style={{ color: on ? color : "#c7d2dc" }}>{value}</span>
      </div>
      <div className="mt-0.5 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, pct)}%`, background: color, opacity: on ? 1 : 0.5 }} />
      </div>
    </div>
  );
}

function CondPill({ on, color, label }: { on: boolean; color: string; label: string }) {
  return (
    <span
      className="rounded px-1.5 py-[1px] text-[8.5px] font-semibold uppercase tracking-wide transition-colors"
      style={{
        color: on ? "#0b0f14" : "#5a6a7c",
        background: on ? color : "transparent",
        border: on ? "none" : "1px solid var(--line,#22303c)",
      }}
    >
      {label}
    </span>
  );
}

function Row({ r, rank, idx, lang, timing, onOpen, t }: { r: LeaderRow; rank: number; idx: number; lang: "en" | "zh"; timing: TechTiming | null; onOpen: (x: string) => void; t: (en: string, zh: string) => string }) {
  const meta = TIER_META[r.tier];
  const top = rank === 1;
  return (
    <div
      onClick={() => onOpen(r.ticker)}
      className="ignite-in group flex cursor-pointer items-center gap-3 rounded-xl border bg-panel2 px-3 py-2.5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5"
      style={{
        borderColor: top ? `${meta.color}66` : "var(--line,#22303c)",
        boxShadow: top ? `0 0 18px ${meta.glow}33` : undefined,
        animationDelay: `${Math.min(idx * 30, 500)}ms`,
      }}
    >
      {/* rank badge */}
      <span
        className="grid h-8 w-8 flex-none place-items-center rounded-lg font-disp text-[14px] font-bold tabular-nums"
        style={{ color: "#0b0f14", background: meta.color, boxShadow: top ? `0 0 12px ${meta.glow}88` : undefined }}
      >
        {rank}
      </span>

      {/* name + condition pills */}
      <div className="min-w-0 flex-[1.5]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-disp text-[15px] font-bold tracking-tight text-text transition-colors group-hover:text-signal">{r.ticker}</span>
          {top && <span className="text-[11px]" style={{ color: meta.color }} title={t("tier leader", "本榜第一")}>♛</span>}
          <TimingBadge timing={timing} />
          <CondPill on={r.core} color="#f0c862" label={t("Core", "核心")} />
          <CondPill on={r.catHot} color={LENS.cat} label={r.catScore >= 0 ? `CAT ${r.catScore.toFixed(1)}` : t("no cat", "无催化")} />
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-muted2">
          {r.company || "—"} · {capLabel(r.cap, lang)}
          {r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""}
        </div>
      </div>

      {/* three lenses */}
      <div className="hidden w-[240px] flex-none items-stretch gap-2.5 md:flex">
        <Lens label={t("Catalyst", "催化剂")} value={r.catScore >= 0 ? r.catScore.toFixed(1) : "—"} pct={r.catScore >= 0 ? r.catScore * 10 : 0} color={LENS.cat} on={r.catHot} />
        <Lens label={t("Core", "核心")} value={r.focusScore.toFixed(1)} pct={r.focusScore * 10} color={LENS.focus} on={r.core} />
        <Lens label={t("Attn", "注意力")} value={Math.round(r.attnScore).toString()} pct={r.attnScore} color={LENS.attn} />
      </div>

      {/* composite strength */}
      <div className="w-[124px] flex-none">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[8.5px] uppercase tracking-wide text-muted2">{t("strength", "强度")}</span>
          <span className="font-disp text-[16px] font-semibold leading-none" style={{ color: meta.color }}>{r.composite.toFixed(0)}</span>
        </div>
        <Strength v={r.composite} color={meta.color} delay={Math.min(idx * 25, 400)} />
      </div>
    </div>
  );
}

// One big tab in the tier switcher.
function TierTab({ tier, count, active, lang, onClick }: { tier: 1 | 2 | 3; count: number; active: boolean; lang: "en" | "zh"; onClick: () => void }) {
  const meta = TIER_META[tier];
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-3 overflow-hidden rounded-2xl border px-4 py-3 text-left transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5"
      style={{
        borderColor: active ? meta.color : `${meta.color}30`,
        background: active ? `linear-gradient(120deg, ${meta.color}22, ${meta.color}0a)` : "transparent",
        boxShadow: active ? `0 0 22px ${meta.glow}33` : undefined,
      }}
    >
      <span
        className="grid h-9 w-9 flex-none place-items-center rounded-xl font-mono text-[10px] font-bold"
        style={{ color: "#0b0f14", background: meta.color, boxShadow: active ? `0 0 14px ${meta.glow}88` : undefined, opacity: active ? 1 : 0.75 }}
      >
        {meta.medal}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-disp text-[13.5px] font-semibold tracking-tight" style={{ color: active ? meta.color : "#c7d2dc" }}>
          {lang === "zh" ? meta.zh : meta.en}
        </div>
        <div className="truncate text-[9.5px] text-muted2">{lang === "zh" ? meta.cond.zh : meta.cond.en}</div>
      </div>
      <span className="font-disp text-[24px] font-bold leading-none tabular-nums" style={{ color: active ? meta.color : "#6f7f8e" }}>{count}</span>
    </button>
  );
}

export function ShortlistView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const marketCaps = useStore((s) => s.marketCaps);
  const catalyst = useStore((s) => s.catalyst);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const [sector, setSector] = useState<string | null>(null);
  const [tab, setTab] = useState<1 | 2 | 3 | null>(null); // null = auto-pick first non-empty
  const [sortBy, setSortBy] = useState<"strength" | "entry">("strength"); // "entry" = best buy point now

  const focus = useMemo(
    () => buildFocus(data, heat, technical, marketCaps, sectors, supplychain),
    [data, heat, technical, marketCaps, sectors, supplychain],
  );
  const rows = useMemo(() => buildShortlist(focus, catalyst), [focus, catalyst]);

  const shown = useMemo(() => (sector ? rows.filter((r) => r.sector === sector) : rows), [rows, sector]);
  const tier = (n: 1 | 2 | 3) => shown.filter((r) => r.tier === n);
  const t1 = tier(1);
  const t2 = tier(2);
  const t3 = tier(3);
  // Active tab: user's choice, else the first tier that actually has names.
  const activeTier: 1 | 2 | 3 = tab ?? (t1.length ? 1 : t2.length ? 2 : 3);
  const timingOf = (tk: string): TechTiming | null => technical?.tickers?.[tk]?.timing ?? null;
  const baseRows = activeTier === 1 ? t1 : activeTier === 2 ? t2 : t3;
  // "entry" re-ranks the board by the live Bollinger+MACD entry-timing score, so
  // the best BUY POINTS float up (a good name at a good price) — independent of
  // the composite strength order.
  const activeRows = useMemo(() => {
    if (sortBy !== "entry") return baseRows;
    return [...baseRows].sort(
      (a, b) => timingSortKey(technical?.tickers?.[b.ticker]) - timingSortKey(technical?.tickers?.[a.ticker]) || b.composite - a.composite,
    );
  }, [baseRows, sortBy, technical]);

  const sectorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.sector) m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Stage 4 · Shortlist", "Stage 4 · 登顶广度")}
        title={t("Shortlist · Three Leaderboards", "登顶榜单 · 三级")}
        desc={t(
          `Three conditions per Focus name — on the FOCUS LIST · CORE (buy × ecosystem) · CATALYST > ${SHORTLIST_CAT_BAR}. Tier 1 meets all three, Tier 2 meets two, Tier 3 only the first. Within each tier, names rank by weighted strength: Catalyst ${SHORTLIST_W.cat} · Core ${SHORTLIST_W.focus} · Attention ${SHORTLIST_W.attn}.`,
          `每只 Focus 票三条件——在重点名单 · 核心(买入×生态) · 催化剂 > ${SHORTLIST_CAT_BAR}。第一名榜单三条全中,第二名满足两条,第三名仅第一条。每个榜单内按加权强度排名:催化剂 ${SHORTLIST_W.cat} · 核心 ${SHORTLIST_W.focus} · 注意力 ${SHORTLIST_W.attn}。`,
        )}
      />

      {focus.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t("No Focus List yet — run technical + supplychain first.", "暂无重点名单 —— 先跑 technical + supplychain。")}
        </div>
      ) : (
        <>
          {/* sector filter */}
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-muted2">{t("Sector:", "板块:")}</span>
            <button
              onClick={() => setSector(null)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${sector === null ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
            >
              {t("All", "全部")} {rows.length}
            </button>
            {sectorCounts.slice(0, 9).map(([sec, n]) => (
              <button
                key={sec}
                onClick={() => setSector(sector === sec ? null : sec)}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${sector === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
              >
                {sectorLabel(sec, lang)} {n}
              </button>
            ))}

            {/* sort: composite strength vs live entry-timing */}
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[10.5px] text-muted2">{t("Sort:", "排序:")}</span>
              {(["strength", "entry"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setSortBy(k)}
                  className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${sortBy === k ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
                >
                  {k === "strength" ? t("Strength", "强度") : t("Entry Now", "买点")}
                </button>
              ))}
            </div>
          </div>

          {/* tier switcher — one board at a time */}
          <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <TierTab tier={1} count={t1.length} active={activeTier === 1} lang={lang} onClick={() => setTab(1)} />
            <TierTab tier={2} count={t2.length} active={activeTier === 2} lang={lang} onClick={() => setTab(2)} />
            <TierTab tier={3} count={t3.length} active={activeTier === 3} lang={lang} onClick={() => setTab(3)} />
          </div>

          {/* active board */}
          <div key={activeTier} className="view-in space-y-2">
            {activeRows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
                {t("No names in this leaderboard yet.", "该榜单暂无票。")}
              </div>
            ) : (
              activeRows.map((r, i) => (
                <Row key={r.ticker} r={r} rank={i + 1} idx={i} lang={lang} timing={timingOf(r.ticker)} onOpen={openDetail} t={t} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
