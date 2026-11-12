import { useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import {
  buildFocus,
  buildShortlist,
  buildTimingBoard,
  sectorLabel,
  TIMING_SELL_STATES,
  type TimingRow,
} from "../pipeline";
import { ViewHead, TimingBadge, SignalChips } from "../ui";
import type { TechTiming } from "../../types";

type Tab = "all" | "breakdown" | "trim";
const SELL_COLOR: Record<string, string> = { breakdown: "#ff6b81", trim: "#e8935f" };
const sc = (s: TechTiming["timing"]): string => SELL_COLOR[s] ?? "#e8935f";

// %B position on the band rail (same gauge as the buy board, red-anchored).
function BandGauge({ pctb }: { pctb: number }) {
  const pos = Math.max(0, Math.min(1, (pctb + 0.15) / 1.3));
  const midPos = (0.5 + 0.15) / 1.3;
  const color = pctb < 0.05 ? "#48c78e" : pctb > 1 ? "#c99bf0" : "#e8935f";
  return (
    <div className="w-full">
      <div className="relative h-[7px] w-full rounded-full" style={{ background: "linear-gradient(90deg, rgba(72,199,142,0.22), rgba(232,147,95,0.16) 50%, rgba(255,107,129,0.30))" }}>
        <span className="absolute top-[-3px] h-[13px] w-px bg-white/30" style={{ left: `${midPos * 100}%` }} />
        <span className="absolute top-1/2 h-[12px] w-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0b0f14] transition-[left] duration-500" style={{ left: `${pos * 100}%`, background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
    </div>
  );
}

function FeatureCard({ r, rank, lang, onOpen, t }: { r: TimingRow; rank: number; lang: "en" | "zh"; onOpen: (x: string) => void; t: (en: string, zh: string) => string }) {
  const tm = r.timing;
  const col = sc(tm.timing);
  const lifted = rank === 1;
  return (
    <button
      onClick={() => onOpen(r.ticker)}
      className="rank-rise group relative flex flex-1 flex-col rounded-2xl border bg-panel2 px-4 pb-4 pt-4 text-left transition-[transform,box-shadow] duration-200 hover:-translate-y-1"
      style={{ borderColor: `${col}66`, boxShadow: lifted ? `0 0 34px ${col}33` : `0 0 18px ${col}22`, marginTop: lifted ? 0 : 16, background: `linear-gradient(180deg, ${col}18, transparent 62%)` }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg font-disp text-[13px] font-bold" style={{ color: "#0b0f14", background: col, boxShadow: `0 0 14px ${col}88` }}>{rank}</span>
          <span className="font-disp text-[20px] font-bold tracking-tight text-text group-hover:text-signal">{r.ticker}</span>
        </div>
        <div className="text-right">
          <div className="font-disp text-[26px] font-bold leading-none tabular-nums" style={{ color: col }}>{tm.breakdown}</div>
          <div className="text-[8.5px] uppercase tracking-wide text-muted2">{t("severity", "破位强度")}</div>
        </div>
      </div>
      <div className="mb-2 truncate text-[10.5px] text-muted2">{r.company || "—"}{r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""} · {t("Tier", "档")} {r.tier}</div>
      <div className="mb-2"><TimingBadge timing={tm} size="md" /></div>
      <SignalChips signals={tm.signals} lang={lang} />
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1"><BandGauge pctb={tm.bb.pctb} /></div>
        <span className="flex-none font-mono text-[11px] text-muted">%B {tm.bb.pctb.toFixed(2)}</span>
      </div>
    </button>
  );
}

function Row({ r, rank, lang, onOpen, t }: { r: TimingRow; rank: number; lang: "en" | "zh"; onOpen: (x: string) => void; t: (en: string, zh: string) => string }) {
  const tm = r.timing;
  const col = sc(tm.timing);
  return (
    <div
      onClick={() => onOpen(r.ticker)}
      className="group flex cursor-pointer items-center gap-3 rounded-xl border bg-panel2 px-3 py-2.5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5"
      style={{ borderColor: "var(--line,#22303c)" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${col}66`; e.currentTarget.style.boxShadow = `0 0 16px ${col}18`; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line,#22303c)"; e.currentTarget.style.boxShadow = "none"; }}
    >
      <span className="grid h-7 w-7 flex-none place-items-center rounded-lg font-mono text-[12px] font-semibold" style={{ color: rank <= 3 ? "#0b0f14" : "#c7d2dc", background: rank <= 3 ? col : "transparent", border: rank <= 3 ? "none" : "1px solid var(--line2,#2b3a48)" }}>{rank}</span>

      <div className="min-w-0 flex-[1.7]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-disp text-[15px] font-bold tracking-tight text-text group-hover:text-signal">{r.ticker}</span>
          <TimingBadge timing={tm} />
          <span className="truncate text-[10px] text-muted2">{r.company || "—"}{r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""} · {t("Tier", "档")} {r.tier}</span>
        </div>
        <div className="mt-1"><SignalChips signals={tm.signals} lang={lang} max={4} /></div>
      </div>

      <div className="hidden w-[160px] flex-none md:block">
        <BandGauge pctb={tm.bb.pctb} />
        <div className="mt-1 flex justify-between text-[8.5px] uppercase tracking-wide text-muted2">
          <span>{t("lower", "下轨")}</span>
          <span className="text-muted">%B {tm.bb.pctb.toFixed(2)}</span>
          <span>{t("upper", "上轨")}</span>
        </div>
      </div>

      <div className="hidden w-[76px] flex-none text-right sm:block">
        <div className="font-mono text-[14px] font-semibold" style={{ color: tm.macd.cross === "bull" ? "#48c78e" : "#ff5a78" }}>{tm.macd.cross === "bull" ? t("bull", "金叉") : t("bear", "死叉")}</div>
        <div className="text-[8px] uppercase tracking-wide text-muted2">MACD</div>
      </div>

      <div className="w-[52px] flex-none text-right">
        <div className="font-disp text-[17px] font-semibold leading-none" style={{ color: col }}>{tm.breakdown}</div>
        <div className="text-[8px] uppercase tracking-wide text-muted2">{t("severity", "破位")}</div>
      </div>
    </div>
  );
}

function Pill({ label, count, color, active, onClick }: { label: string; count: number; color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-xl border px-3 py-2 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5"
      style={{ borderColor: active ? color : `${color}33`, background: active ? `linear-gradient(130deg, ${color}26, ${color}0a)` : "transparent", boxShadow: active ? `0 0 18px ${color}33` : undefined }}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: active ? `0 0 8px ${color}` : undefined }} />
      <span className="text-[12.5px] font-semibold tracking-tight" style={{ color: active ? color : "#c7d2dc" }}>{label}</span>
      <span className="font-disp text-[16px] font-bold tabular-nums" style={{ color: active ? color : "#6f7f8e" }}>{count}</span>
    </button>
  );
}

export function WarningView() {
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

  const [tab, setTab] = useState<Tab>("all");
  const [sector, setSector] = useState<string | null>(null);

  const focus = useMemo(
    () => buildFocus(data, heat, technical, marketCaps, sectors, supplychain),
    [data, heat, technical, marketCaps, sectors, supplychain],
  );
  const shortlist = useMemo(() => buildShortlist(focus, catalyst), [focus, catalyst]);
  const board = useMemo(() => buildTimingBoard(shortlist, technical), [shortlist, technical]);

  const allSells = useMemo(
    () => board.filter((r) => TIMING_SELL_STATES.includes(r.timing.timing)).sort((a, b) => b.timing.breakdown - a.timing.breakdown),
    [board],
  );
  // Sector counts across ALL warnings (so a chip reads e.g. "Technology 4").
  const sectorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of allSells) if (r.sector) m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [allSells]);
  const sells = useMemo(() => (sector ? allSells.filter((r) => r.sector === sector) : allSells), [allSells, sector]);
  const nBreakdown = sells.filter((r) => r.timing.timing === "breakdown").length;
  const nTrim = sells.filter((r) => r.timing.timing === "trim").length;

  const rows = useMemo(() => (tab === "all" ? sells : sells.filter((r) => r.timing.timing === tab)), [sells, tab]);
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);

  const noData = !technical || board.length === 0;

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Companion · De-risk", "配套 · 减仓预警")}
        title={t("Risk · De-risk Warnings", "减仓预警 · 破位监控")}
        desc={t(
          "The sell-side companion to Buy Timing — vetted holdings breaking DOWN through the MA20 middle band with short-term momentum falling. These are de-risk WARNINGS (trim / tighten), never a forced exit: if a name keeps falling to the lower band it becomes a BUY again. The extreme-oversold zone is never a sell.",
          "择时买点的卖出侧配套——已入围的持仓正跌破 MA20 中轨、短期动能向下。这些是减仓预警(减仓/收紧),不是强制清仓:若继续砸到下轨,它又变回买点。极度超卖区永远不是卖出。",
        )}
      />

      {noData ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t("No timing data yet. Run ", "暂无择时数据。在 Mac 上运行 ")}
          <code className="font-mono text-signal">python -m newsagg.technical</code>
          {t(" on the Mac.", " 后自动出现。")}
        </div>
      ) : allSells.length === 0 ? (
        <div className="rounded-2xl border p-8 text-center" style={{ borderColor: "rgba(72,199,142,0.35)", background: "linear-gradient(160deg, rgba(72,199,142,0.08), transparent)" }}>
          <div className="mb-1 font-disp text-[20px] font-bold" style={{ color: "#5fe3a1" }}>{t("All clear", "全部安全")}</div>
          <div className="text-[13px] text-muted">
            {t(`Nothing in the vetted set is breaking down right now (${board.length} names scored). No de-risk action needed.`, `当前入围池里没有任何票破位(已对 ${board.length} 只打分)。无需减仓动作。`)}
          </div>
        </div>
      ) : (
        <>
          {/* hero */}
          <div className="mb-4 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-[#ff6b8114] to-transparent p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <div className="flex items-baseline gap-2.5">
                <span className="font-disp text-[44px] font-bold leading-none" style={{ color: "#ff6b81" }}>{sells.length}</span>
                <div className="leading-tight">
                  <div className="text-[13px] font-semibold text-text">{t("names flashing a de-risk warning", "只票触发减仓预警")}</div>
                  <div className="text-[11px] text-muted2">{t(`of ${board.length} vetted names · re-scored daily`, `共 ${board.length} 只入围票 · 每日重排`)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* tabs */}
          <div className="mb-4 flex flex-wrap gap-2">
            <Pill label={t("All Warnings", "全部预警")} count={sells.length} color="#ff8a5f" active={tab === "all"} onClick={() => setTab("all")} />
            <Pill label={t("Breakdown", "破位·减仓")} count={nBreakdown} color={SELL_COLOR.breakdown} active={tab === "breakdown"} onClick={() => setTab("breakdown")} />
            <Pill label={t("Trim", "减仓预警")} count={nTrim} color={SELL_COLOR.trim} active={tab === "trim"} onClick={() => setTab("trim")} />
          </div>

          {/* sector filter — same as Buy Timing */}
          <div className="mb-5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-muted2">{t("Sector:", "板块:")}</span>
            <button
              onClick={() => setSector(null)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${sector === null ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
            >
              {t("All", "全部")} {allSells.length}
            </button>
            {sectorCounts.slice(0, 8).map(([sec, n]) => (
              <button
                key={sec}
                onClick={() => setSector(sector === sec ? null : sec)}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${sector === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
              >
                {sectorLabel(sec, lang)} {n}
              </button>
            ))}
          </div>

          <div key={`${tab}-${sector ?? "all"}`} className="view-in">
            {rows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
                {t("No names in this category right now.", "该分类当前没有票。")}
              </div>
            ) : (
              <>
                {podium.length >= 2 && (
                  <div className="mb-5 flex items-start gap-3">
                    {podium[1] && <FeatureCard r={podium[1]} rank={2} lang={lang} onOpen={openDetail} t={t} />}
                    <FeatureCard r={podium[0]} rank={1} lang={lang} onOpen={openDetail} t={t} />
                    {podium[2] && <FeatureCard r={podium[2]} rank={3} lang={lang} onOpen={openDetail} t={t} />}
                  </div>
                )}
                <div className="space-y-2">
                  {(podium.length >= 2 ? rest : rows).map((r, i) => (
                    <Row key={r.ticker} r={r} rank={(podium.length >= 2 ? 3 : 0) + i + 1} lang={lang} onOpen={openDetail} t={t} />
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
