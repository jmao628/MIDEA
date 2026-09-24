import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, useT } from "../../store";
import {
  buildFocus,
  buildCatalystRows,
  catalystTypeLabel,
  catLiveDays,
  sectorLabel,
  capLabel,
  CATALYST_BAR,
  type CatalystRow,
  type CatalystStatus,
} from "../pipeline";
import { ViewHead, StatStrip } from "../ui";
import type { Catalyst } from "../../types";

const STATUS_META: Record<CatalystStatus, { color: string; en: string; zh: string }> = {
  advance: { color: "#48c78e", en: "Advancing", zh: "过闸" },
  watch: { color: "#e9c46a", en: "Watch", zh: "观察" },
  none: { color: "#5a6a7c", en: "No catalyst", zh: "无催化剂" },
  pending: { color: "#3a4a5a", en: "Pending", zh: "待抓取" },
};

function timing(c: Catalyst, t: (en: string, zh: string) => string): { label: string; near: boolean } {
  const days = catLiveDays(c);
  if (c.cls === "B") {
    if (days == null) return { label: t("window TBD", "窗口待定"), near: false };
    return { label: t(`~${days}d window`, `~${days} 天窗口`), near: days <= 30 };
  }
  // A-class — real date
  if (days == null) return { label: t("date TBD", "日期待定"), near: false };
  if (days < 0) return { label: t(`${-days}d ago`, `${-days} 天前`), near: false };
  if (days === 0) return { label: t("today", "今天"), near: true };
  return { label: t(`in ${days}d`, `${days} 天后`), near: days <= 30 };
}

// Recent price trend — quick context on whether the catalyst sits on a rising or
// falling stock.
function Spark({ data, up }: { data: number[]; up: boolean }) {
  const W = 52,
    H = 16;
  if (!data || data.length < 2) return <span className="inline-block flex-none" style={{ width: W, height: H }} />;
  const min = Math.min(...data),
    max = Math.max(...data),
    rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - 2 - ((v - min) / rng) * (H - 4)}`).join(" ");
  return (
    <svg width={W} height={H} className="flex-none overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? "#48c78e" : "#ff6b6b"} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// A 90-day "runway" of dated catalysts, CLASSIFIED into one lane per catalyst
// type. To stay legible with 100+ catalysts, each lane is AGGREGATED into
// density cells: one soft cell per time-bucket, brighter/larger the more
// catalysts fall in it, with the count shown. Zoom makes the buckets finer so
// clustered dates separate. Hover reads the names; click opens the strongest.
const RUNWAY_ZOOMS = [1, 2, 4] as const;
// zoom → { bucket width in days (finer de-clusters), px per day (spread) }
const ZOOM_CFG: Record<number, { bucket: number; ppd: number }> = {
  1: { bucket: 7, ppd: 13 },
  2: { bucket: 3.5, ppd: 24 },
  4: { bucket: 2, ppd: 44 },
};

function _hex(color: string, alpha: number): string {
  return color + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
}

interface CellItem {
  ticker: string;
  company: string;
  score: number;
  days: number;
}
interface Cell {
  key: number;
  midDays: number;
  count: number;
  color: string;
  names: string; // tooltip preview
  items: CellItem[]; // every catalyst in the bucket, strongest first
}

function Runway({
  rows,
  onOpen,
  lang,
  t,
}: {
  rows: CatalystRow[];
  onOpen: (t: string) => void;
  lang: "en" | "zh";
  t: (en: string, zh: string) => string;
}) {
  const MAXD = 90;
  const [zoom, setZoom] = useState(1);
  const [pop, setPop] = useState<{ x: number; y: number; type: string; days: number; color: string; items: CellItem[] } | null>(null);
  const { bucket, ppd } = ZOOM_CFG[zoom];

  // Live days so the runway shifts left each day and drops events once they pass.
  const dated = rows
    .map((r) => ({ r, days: r.best ? catLiveDays(r.best) : null }))
    .filter(
      (x): x is { r: CatalystRow; days: number } =>
        x.days != null && x.days >= 0 && x.days <= MAXD && x.r.status !== "pending",
    );
  if (dated.length === 0) return null;

  const byType = new Map<string, { r: CatalystRow; days: number }[]>();
  for (const { r, days } of dated) {
    const type = r.best!.type;
    (byType.get(type) ?? byType.set(type, []).get(type)!).push({ r, days });
  }
  const lanes = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);

  const LABEL_W = 84;
  const trackW = MAXD * ppd;
  const LANE_H = 26;
  const marks = [0, 7, 14, 30, 45, 60, 90].filter((m) => m <= MAXD);

  // Aggregate one lane into density cells, one per non-empty time-bucket.
  const cellsFor = (arr: { r: CatalystRow; days: number }[]): Cell[] => {
    const buckets = new Map<number, { r: CatalystRow; days: number }[]>();
    for (const it of arr) {
      const b = Math.floor(it.days / bucket);
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(it);
    }
    return [...buckets.entries()].map(([b, items]) => {
      const sorted = [...items].sort((a, z) => z.r.catScore - a.r.catScore);
      const advancing = items.some((i) => i.r.status === "advance");
      const names = sorted.slice(0, 6).map((i) => i.r.ticker).join(", ") + (sorted.length > 6 ? "…" : "");
      return {
        key: b,
        midDays: Math.min((b + 0.5) * bucket, MAXD),
        count: items.length,
        color: advancing ? "#48c78e" : "#e9c46a",
        names,
        items: sorted.map((i) => ({ ticker: i.r.ticker, company: i.r.company, score: i.r.catScore, days: i.days })),
      };
    });
  };
  const laid = lanes.map(([type, arr]) => ({ type, cells: cellsFor(arr) }));

  return (
    <div className="mb-4 rounded-xl border border-line bg-panel2 px-4 py-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold tracking-tight text-text">
            {t("Catalyst Runway", "催化剂时间线")}
            <span className="ml-2 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted2">
              {t("next 90 days", "未来 90 天")}
            </span>
          </span>
          <span className="text-[10.5px] leading-none text-muted2">
            {t("bubble size = catalyst count · click to list the names", "气泡大小 = 催化剂数 · 点击查看名单")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2.5 text-[10px] font-medium">
            <span className="flex items-center gap-1.5 text-ok">
              <span className="h-2 w-2 rounded-full bg-ok" style={{ boxShadow: "0 0 6px #48c78e" }} />
              {t("advancing", "过闸")}
            </span>
            <span className="flex items-center gap-1.5 text-warn">
              <span className="h-2 w-2 rounded-full bg-warn" style={{ boxShadow: "0 0 6px #e9c46a" }} />
              {t("watch", "观察")}
            </span>
          </span>
          {/* segmented zoom control with a sliding highlight */}
          <div className="relative flex items-center gap-0.5 rounded-full border border-line/70 bg-inset p-0.5">
            {RUNWAY_ZOOMS.map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`relative z-10 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors duration-200 ${
                  zoom === z ? "text-[#0b0f14]" : "text-muted2 hover:text-text"
                }`}
              >
                {zoom === z && (
                  <span className="absolute inset-0 -z-10 rounded-full bg-signal" style={{ boxShadow: "0 0 10px #3dd6c455" }} />
                )}
                {z}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto pb-1">
        <div style={{ width: LABEL_W + trackW }}>
          <div className="space-y-0.5">
            {laid.map(({ type, cells }) => (
              <div key={type} className="flex items-center">
                <span
                  className="sticky left-0 z-10 flex-none truncate bg-panel2 pr-2 text-right text-[10px] text-muted2"
                  style={{ width: LABEL_W }}
                >
                  {catalystTypeLabel(type, lang)}
                </span>
                <div className="relative flex-none" style={{ width: trackW, height: LANE_H }}>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-line/50" />
                  {cells.map((c, i) => {
                    const size = Math.min(22, 11 + (c.count - 1) * 2.4);
                    const a = 0.5 + Math.min(c.count, 8) / 8 * 0.5;
                    return (
                      <button
                        key={c.key}
                        onClick={(e) => {
                          if (c.count === 1) {
                            onOpen(c.items[0].ticker);
                            return;
                          }
                          const PW = 252;
                          const PH = 340;
                          // Right next to the cursor (flip left near the edge).
                          // Rendered via a portal so viewport coords are exact.
                          let x = e.clientX + 12;
                          if (x + PW > window.innerWidth - 8) x = e.clientX - PW - 12;
                          x = Math.max(8, x);
                          const y = Math.max(8, Math.min(e.clientY - 14, window.innerHeight - PH - 8));
                          setPop({ x, y, type, days: Math.round(c.midDays), color: c.color, items: c.items });
                        }}
                        title={`${catalystTypeLabel(type, lang)} · ${Math.round(c.midDays)}d · ${c.count} · ${c.names}`}
                        className="cat-cell absolute grid cursor-pointer place-items-center rounded-full font-mono font-semibold transition-[filter] hover:z-10 hover:brightness-125"
                        style={{
                          left: c.midDays * ppd,
                          top: "50%",
                          width: size,
                          height: size,
                          marginLeft: -size / 2,
                          marginTop: -size / 2,
                          background: _hex(c.color, a),
                          boxShadow: `0 0 7px ${_hex(c.color, 0.28)}`,
                          fontSize: size >= 16 ? 9 : 8,
                          color: "#0b0f14",
                          animationDelay: `${Math.min(i * 18, 260)}ms`,
                        }}
                      >
                        {c.count > 1 ? c.count : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-1.5 flex">
            <span className="flex-none" style={{ width: LABEL_W }} />
            <div className="relative h-3 flex-none" style={{ width: trackW }}>
              {marks.map((m) => (
                <span
                  key={m}
                  className="absolute -translate-x-1/2 font-mono text-[9px] text-muted2"
                  style={{ left: m * ppd }}
                >
                  {m === 0 ? t("today", "今") : `${m}d`}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* bucket picker — every name in the clicked cell, strongest first.
          Portaled to <body> so `position: fixed` is relative to the viewport,
          not the transformed `.view-in` ancestor (which was offsetting it). */}
      {pop &&
        createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPop(null)} />
          <div
            className="cat-pop fixed z-50 flex max-h-[340px] w-[252px] flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl backdrop-blur-xl"
            style={{ left: pop.x, top: pop.y, background: "rgba(15,21,29,0.94)", transformOrigin: "top left" }}
          >
            <div
              className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3.5 py-2.5"
              style={{ background: `linear-gradient(180deg, ${pop.color}14, transparent)` }}
            >
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: pop.color, boxShadow: `0 0 7px ${pop.color}` }} />
                <span className="text-[11.5px] font-semibold text-text">{catalystTypeLabel(pop.type, lang)}</span>
                <span className="font-mono text-[10px] text-muted2">{t(`· in ${pop.days}d`, `· ${pop.days} 天后`)}</span>
              </span>
              <span className="flex-none rounded-full bg-white/[0.07] px-2 py-0.5 font-mono text-[10px] font-semibold text-muted">
                {pop.items.length}
              </span>
            </div>
            <div className="cat-scroll overflow-y-auto p-1.5">
              {pop.items.map((it, i) => {
                const hot = it.score >= CATALYST_BAR;
                return (
                  <button
                    key={it.ticker}
                    onClick={() => {
                      onOpen(it.ticker);
                      setPop(null);
                    }}
                    className="group relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <span className="w-3.5 flex-none text-right font-mono text-[9px] tabular-nums text-muted2">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12.5px] font-bold leading-tight text-text transition-colors group-hover:text-signal">
                        {it.ticker}
                      </div>
                      {it.company && <div className="truncate text-[9.5px] leading-tight text-muted2">{it.company}</div>}
                    </div>
                    <span
                      className="flex-none rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums"
                      style={{ color: hot ? "#48c78e" : "#c7d2dc", background: hot ? "#48c78e18" : "rgba(255,255,255,0.05)" }}
                    >
                      {it.score.toFixed(1)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>,
          document.body,
        )}
    </div>
  );
}

function TpmnMini({ tpmn }: { tpmn: Catalyst["tpmn"] }) {
  const dims: [string, number, number][] = [
    ["T", tpmn.T, 25],
    ["P", tpmn.P, 3],
    ["M", tpmn.M, 3],
    ["N", tpmn.N, 2],
  ];
  return (
    <div className="flex items-center gap-2">
      {dims.map(([k, v, max]) => (
        <div key={k} className="flex items-center gap-1" title={`${k} ${k === "T" ? v.toFixed(1) : v}/${max}`}>
          <span className="font-mono text-[8px] uppercase tracking-wide text-muted2">{k}</span>
          <span className="h-[3px] w-5 overflow-hidden rounded-full bg-white/[0.07]">
            <span className="block h-full rounded-full bg-signal/70" style={{ width: `${Math.max(8, (v / max) * 100)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function TypeChip({ type, lang }: { type: string; lang: "en" | "zh" }) {
  return (
    <span className="flex-none rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted">
      {catalystTypeLabel(type, lang)}
    </span>
  );
}

function Src({ url, t }: { url: string; t: (en: string, zh: string) => string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex-none font-mono text-[9.5px] text-signal/80 hover:text-signal hover:underline"
    >
      {t("source", "来源")} ↗
    </a>
  );
}

// A secondary catalyst inside the expanded detail — compact, with its summary.
function CatalystLine({ c, lang, t }: { c: Catalyst; lang: "en" | "zh"; t: (en: string, zh: string) => string }) {
  const cd = timing(c, t);
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <TypeChip type={c.type} lang={lang} />
        <span className={`flex-none font-mono text-[10px] ${cd.near ? "text-ok" : "text-muted2"}`}>{cd.label}</span>
      </div>
      <div className="mt-1 text-[12px] leading-snug text-text">{c.title}</div>
      {c.summary && <div className="mt-1.5 text-[11px] leading-relaxed text-muted2">{c.summary}</div>}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <TpmnMini tpmn={c.tpmn} />
        <Src url={c.source_url} t={t} />
      </div>
    </div>
  );
}

function Row({
  r,
  rank,
  onOpen,
  lang,
  t,
}: {
  r: CatalystRow;
  rank: number;
  onOpen: (t: string) => void;
  lang: "en" | "zh";
  t: (en: string, zh: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const meta = STATUS_META[r.status];
  const best = r.best;
  const more = r.cat ? r.cat.catalysts.length - 1 : 0;
  const cd = best ? timing(best, t) : null;
  const hasDetail = !!best && (!!best.summary || more > 0);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    // When collapsing, the card shrinks under the scroll position — pull it back
    // into view so the page doesn't strand you in the gap it left behind.
    if (!next)
      requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  return (
    <div
      ref={cardRef}
      className="group relative overflow-hidden rounded-xl border bg-panel2 transition-[transform,border-color] duration-200 hover:-translate-y-0.5"
      style={{ borderColor: r.status === "advance" ? `${meta.color}3a` : "var(--line,#22303c)" }}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: meta.color, opacity: r.status === "advance" ? 0.9 : 0.3 }} />

      {/* header — click opens the ticker */}
      <button onClick={() => onOpen(r.ticker)} className="flex w-full items-center gap-2 px-4 pt-3 text-left">
        <span className="font-mono text-[10px] tabular-nums text-muted2">{rank}</span>
        <span className="font-mono text-[15px] font-bold tracking-tight text-text transition-colors group-hover:text-signal">
          {r.ticker}
        </span>
        {r.core && <span className="text-[10px] text-gold" title="Focus Core">★</span>}
        <span className="ml-auto flex items-baseline gap-0.5">
          {r.catScore >= 0 ? (
            <>
              <span className="font-disp text-[20px] font-semibold leading-none" style={{ color: r.status === "advance" ? meta.color : "#c7d2dc" }}>
                {r.catScore.toFixed(1)}
              </span>
              <span className="text-[9px] text-muted2">/10</span>
            </>
          ) : (
            <span className="text-[10px] text-muted2">{t("pending", "待抓")}</span>
          )}
        </span>
      </button>
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-0.5">
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted2">
          {r.company || "—"} · {capLabel(r.cap, lang)}
          {r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""}
        </span>
        <Spark data={r.spark} up={(r.changePct ?? 0) >= 0} />
        {r.changePct != null && (
          <span className="flex-none font-mono text-[10px] font-semibold" style={{ color: r.changePct >= 0 ? "#48c78e" : "#ff6b6b" }}>
            {r.changePct >= 0 ? "+" : ""}
            {r.changePct.toFixed(1)}%
          </span>
        )}
      </div>

      {/* primary catalyst — always compact; full title (wraps, no truncation) */}
      {best && cd && (
        <div className="mx-2.5 mb-2.5 rounded-lg bg-white/[0.025] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <TypeChip type={best.type} lang={lang} />
            <span className={`flex-none font-mono text-[10px] ${cd.near ? "text-ok" : "text-muted2"}`}>{cd.label}</span>
          </div>
          <div className="mt-1.5 text-[12px] leading-snug text-text">{best.title}</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <TpmnMini tpmn={best.tpmn} />
            <Src url={best.source_url} t={t} />
          </div>
        </div>
      )}

      {/* expanded detail — the primary summary + the other catalysts */}
      {open && best && (
        <div className="space-y-2 px-2.5 pb-1">
          {best.summary && (
            <p className="rounded-lg bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-muted">{best.summary}</p>
          )}
          {r.cat!.catalysts
            .filter((c) => c !== best)
            .map((c, i) => (
              <CatalystLine key={i} c={c} lang={lang} t={t} />
            ))}
        </div>
      )}

      {/* one clear, fixed-position toggle bar */}
      {hasDetail ? (
        <button
          onClick={toggle}
          className="mt-1 flex w-full items-center justify-center gap-1.5 border-t border-line/60 py-2 text-[10.5px] text-muted2 transition-colors hover:bg-white/[0.04] hover:text-text"
        >
          <span className={`inline-block transition-transform duration-200 ${open ? "rotate-180" : ""}`}>⌄</span>
          {open
            ? t("Collapse", "收起")
            : more > 0
              ? t(`Details · +${more} more`, `展开详情 · 另 ${more} 条`)
              : t("Details", "展开详情")}
        </button>
      ) : (
        <div className="pb-2.5" />
      )}
    </div>
  );
}

export function CatalystView() {
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

  const focus = useMemo(
    () => buildFocus(data, heat, technical, marketCaps, sectors, supplychain),
    [data, heat, technical, marketCaps, sectors, supplychain],
  );
  const rows = useMemo(() => buildCatalystRows(focus, catalyst), [focus, catalyst]);

  const counts = useMemo(() => {
    const c = { advance: 0, watch: 0, none: 0, pending: 0 } as Record<CatalystStatus, number>;
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const [filter, setFilter] = useState<CatalystStatus | "all">("all");
  const [sector, setSector] = useState<string | null>(null);

  const sectorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.sector && r.status !== "pending") m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const shown = useMemo(() => {
    let list = rows;
    if (filter !== "all") list = list.filter((r) => r.status === filter);
    if (sector) list = list.filter((r) => r.sector === sector);
    return list;
  }, [rows, filter, sector]);

  const fetched = counts.advance + counts.watch + counts.none;

  const FILTERS: { k: CatalystStatus | "all"; label: string; n: number }[] = [
    { k: "all", label: t("All", "全部"), n: rows.length },
    { k: "advance", label: t("Advancing", "过闸"), n: counts.advance },
    { k: "watch", label: t("Watch", "观察"), n: counts.watch },
    { k: "pending", label: t("Pending", "待抓取"), n: counts.pending },
  ];

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Stage 3 · Catalyst", "Stage 3 · 催化剂")}
        title={t("Catalyst · TPMN", "催化剂 · TPMN")}
      />

      {catalyst == null ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t(
            "No catalyst data yet — run  python -m newsagg.catalyst  on the Mac (OpenAI web search). It caches to catalyst.json and fills in here.",
            "暂无催化剂数据 —— 在 Mac 上跑  python -m newsagg.catalyst (OpenAI 联网搜)。结果缓存到 catalyst.json 后这里自动填充。",
          )}
        </div>
      ) : (
        <>
          <StatStrip
            stats={[
              { k: t("Advancing", "过闸"), v: counts.advance, d: t(`catalyst ≥ ${CATALYST_BAR}`, `催化剂 ≥ ${CATALYST_BAR}`), color: "#48c78e" },
              { k: t("Watch", "观察"), v: counts.watch, d: t("has a weaker catalyst", "有较弱催化剂"), color: "#e9c46a" },
              { k: t("Coverage", "覆盖"), v: `${fetched}/${rows.length}`, d: t("Focus names fetched", "重点名单已抓取") },
            ]}
          />

          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.k}
                onClick={() => setFilter(f.k)}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
                  filter === f.k ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"
                }`}
              >
                {f.label} <span className="font-mono text-[11px] opacity-70">{f.n}</span>
              </button>
            ))}
            {sectorCounts.length > 0 && <span className="mx-1 h-4 w-px bg-line" />}
            {sector && (
              <button onClick={() => setSector(null)} className="rounded-full border border-signal/50 bg-signal/10 px-2.5 py-0.5 text-[12px] text-signal">
                {sectorLabel(sector, lang)} ✕
              </button>
            )}
            {!sector &&
              sectorCounts.slice(0, 8).map(([sec, n]) => (
                <button
                  key={sec}
                  onClick={() => setSector(sec)}
                  className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted hover:text-text"
                >
                  {sectorLabel(sec, lang)} {n}
                </button>
              ))}
          </div>

          <Runway rows={shown} onOpen={openDetail} lang={lang} t={t} />

          {shown.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
              {t("No names match this filter.", "该筛选下没有匹配的票。")}
            </div>
          ) : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
              {shown.map((r, i) => (
                <Row key={r.ticker} r={r} rank={i + 1} onOpen={openDetail} lang={lang} t={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
