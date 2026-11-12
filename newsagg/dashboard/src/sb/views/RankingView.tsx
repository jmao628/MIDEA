import { useMemo, useState, type ReactNode } from "react";
import { useStore, useT } from "../../store";
import {
  buildConviction,
  buildConvictionRanking,
  buildFocus,
  buildShortlist,
  capLabel,
  sectorLabel,
  RANK_COLORS,
  RANK_MIN_CONVICTION,
  type RankingRow,
} from "../pipeline";
import { ViewHead } from "../ui";

const MEDAL = ["#f0c862", "#cdd6e2", "#cd8b5e"]; // gold · silver · bronze
const medalColor = (rank: number): string => MEDAL[rank - 1] ?? "#6f7f8e";
const TIER_COLOR: Record<1 | 2, string> = { 1: "#f0c862", 2: "#cdd6e2" };

const DIMS = [
  { key: "conv" as const, en: "Conviction", zh: "语气", color: RANK_COLORS.conv },
  { key: "cat" as const, en: "Catalyst", zh: "催化", color: RANK_COLORS.cat },
  { key: "core" as const, en: "Core", zh: "核心", color: RANK_COLORS.core },
  { key: "attn" as const, en: "Attention", zh: "注意力", color: RANK_COLORS.attn },
];

const SECTOR_HUE: Record<string, string> = {
  Technology: "#5fb0e8",
  Healthcare: "#48c78e",
  "Financial Services": "#7bd88f",
  "Consumer Cyclical": "#e0785a",
  "Consumer Defensive": "#c9a86a",
  Industrials: "#9aa7b4",
  Energy: "#e0b45a",
  "Basic Materials": "#b58bd6",
  "Communication Services": "#3dd6c4",
  Utilities: "#6f8fb0",
  "Real Estate": "#d68b9a",
};
const sectorHue = (s: string): string => SECTOR_HUE[s] ?? "#8aa0b2";

// Conviction 0-10 → a warmth (all rows are > 6, so this spreads the upper band).
function convColor(v: number): string {
  if (v >= 8.5) return "#48c78e";
  if (v >= 7.5) return "#7bd88f";
  if (v >= 6.75) return "#f0c862";
  return "#e0b45a";
}

// The single-signal ranking bar: width = conviction / 10.
function ConvBar({ v }: { v: number }) {
  const col = convColor(v);
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-inset">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, v * 10)}%`, background: `linear-gradient(90deg, ${col}88, ${col})`, boxShadow: `0 0 8px ${col}66` }}
      />
    </div>
  );
}

// A four-axis radar of the full profile (context — conviction is the ranking key,
// but the shortlist strength that put it in its tier still shows here).
function Radar({ r, lang, size = 132 }: { r: RankingRow; lang: "en" | "zh"; size?: number }) {
  const c = size / 2;
  const R = size / 2 - 24;
  const vals = [
    { v: r.conviction / 10, a: -90, color: RANK_COLORS.conv, lab: lang === "zh" ? "语气" : "Conv" },
    { v: Math.max(0, r.catScore) / 10, a: 0, color: RANK_COLORS.cat, lab: lang === "zh" ? "催化" : "Cat" },
    { v: r.focusScore / 10, a: 90, color: RANK_COLORS.core, lab: lang === "zh" ? "核心" : "Core" },
    { v: (r.attnScore ?? 0) / 100, a: 180, color: RANK_COLORS.attn, lab: lang === "zh" ? "注意力" : "Attn" },
  ];
  const pt = (v: number, a: number, rad = R) => {
    const t = (a * Math.PI) / 180;
    return [c + Math.cos(t) * rad * v, c + Math.sin(t) * rad * v];
  };
  const poly = vals.map((x) => pt(x.v, x.a).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-none">
      {[0.33, 0.66, 1].map((g) => (
        <polygon key={g} points={vals.map((x) => pt(1, x.a, R * g).join(",")).join(" ")} fill="none" stroke="var(--line2,#2b3a48)" strokeWidth="1" />
      ))}
      {vals.map((x) => {
        const [px, py] = pt(1, x.a);
        return <line key={x.a} x1={c} y1={c} x2={px} y2={py} stroke="var(--line,#22303c)" strokeWidth="1" />;
      })}
      <polygon points={poly} fill="rgba(61,214,196,0.16)" stroke={RANK_COLORS.core} strokeWidth="1.5" />
      {vals.map((x) => {
        const [px, py] = pt(x.v, x.a);
        const [lx, ly] = pt(1.32, x.a);
        return (
          <g key={x.lab}>
            <circle cx={px} cy={py} r="3" fill={x.color} />
            <text x={lx} y={ly + 3} textAnchor="middle" fontSize="8.5" fill="var(--muted2,#5f7183)">{x.lab}</text>
          </g>
        );
      })}
    </svg>
  );
}

function PodiumCard({ r, rank, showTier, onOpen, t }: { r: RankingRow; rank: number; showTier: boolean; onOpen: (x: string) => void; t: (en: string, zh: string) => string }) {
  const col = medalColor(rank);
  const lifted = rank === 1;
  return (
    <button
      onClick={() => onOpen(r.ticker)}
      className="rank-rise group relative flex flex-1 flex-col items-center rounded-2xl border bg-panel2 px-3 pb-4 pt-5 text-center transition-[transform,box-shadow] duration-200 hover:-translate-y-1"
      style={{ borderColor: `${col}66`, boxShadow: lifted ? `0 0 34px ${col}33` : `0 0 18px ${col}22`, marginTop: lifted ? 0 : 22, background: `linear-gradient(180deg, ${col}14, transparent 60%)` }}
    >
      <span className="mb-2 grid h-9 w-9 place-items-center rounded-xl font-disp text-[16px] font-bold" style={{ color: "#0b0f14", background: col, boxShadow: `0 0 16px ${col}88` }}>{rank}</span>
      {lifted && <span className="absolute -top-3 text-[16px]" style={{ color: col }}>♛</span>}
      <div className="flex items-center gap-1.5">
        <span className="font-disp text-[19px] font-bold tracking-tight text-text transition-colors group-hover:text-signal">{r.ticker}</span>
        {showTier && (
          <span className="rounded px-1 py-[1px] font-mono text-[8.5px] font-bold uppercase" style={{ color: "#0b0f14", background: TIER_COLOR[r.tier] }}>T{r.tier}</span>
        )}
      </div>
      <span className="mt-0.5 max-w-full truncate text-[10px] text-muted2">{r.company || "—"}</span>
      <span className="mt-2 font-disp text-[30px] font-bold leading-none tabular-nums" style={{ color: convColor(r.conviction) }}>{r.conviction.toFixed(1)}</span>
      <span className="text-[9px] uppercase tracking-wide text-muted2">{t("conviction", "语气分")}</span>
      <div className="mt-3 w-full"><ConvBar v={r.conviction} /></div>
    </button>
  );
}

function RankRow({
  r,
  rank,
  showTier,
  open,
  onToggle,
  onOpen,
  lang,
  t,
}: {
  r: RankingRow;
  rank: number;
  showTier: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: (x: string) => void;
  lang: "en" | "zh";
  t: (en: string, zh: string) => string;
}) {
  const col = medalColor(rank);
  const top = rank <= 3;
  const L = r.conv.layers;
  return (
    <div className="rank-rise overflow-hidden rounded-xl border bg-panel2" style={{ borderColor: top ? `${col}44` : "var(--line,#22303c)" }}>
      <button onClick={onToggle} className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.02]">
        <span
          className="grid h-8 w-8 flex-none place-items-center rounded-lg font-disp text-[14px] font-bold tabular-nums"
          style={{ color: top ? "#0b0f14" : "#c7d2dc", background: top ? col : "transparent", border: top ? "none" : "1px solid var(--line2,#2b3a48)" }}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-[1.4]">
          <div className="flex items-center gap-2">
            <span className="font-disp text-[15px] font-bold tracking-tight text-text group-hover:text-signal">{r.ticker}</span>
            {showTier && (
              <span className="rounded px-1.5 py-[1px] font-mono text-[9px] font-bold uppercase tracking-wide" style={{ color: "#0b0f14", background: TIER_COLOR[r.tier] }}>
                {t(`T${r.tier}`, `${r.tier === 1 ? "金" : "银"}`)}
              </span>
            )}
            {/* shortlist strength — the tie-break when convictions match */}
            <span className="font-mono text-[9.5px] text-muted2" title={t("Shortlist strength — breaks ties at equal conviction", "登顶强度 —— 语气分打平时的次级排序")}>
              SL {r.shortlistComposite.toFixed(0)}
            </span>
          </div>
          <div className="truncate text-[10.5px] text-muted2">{r.company || "—"} · {capLabel(r.cap, lang)}{r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""}</div>
        </div>
        <div className="hidden min-w-0 flex-[1.6] sm:block"><ConvBar v={r.conviction} /></div>
        <div className="w-[70px] flex-none text-right">
          <span className="font-disp text-[19px] font-bold leading-none tabular-nums" style={{ color: convColor(r.conviction) }}>{r.conviction.toFixed(1)}</span>
          <span className="text-[10px] text-muted2">/10</span>
        </div>
        <span className="flex-none text-[11px] text-muted2 transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>›</span>
      </button>

      {open && (
        <div className="view-in grid gap-4 border-t border-line px-4 py-4 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center">
            <Radar r={r} lang={lang} />
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
              {DIMS.map((d) => (
                <div key={d.key} className="flex items-center gap-1.5 text-[10px] text-muted2">
                  <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                  {lang === "zh" ? d.zh : d.en}
                  <span className="font-mono text-text">
                    {d.key === "attn" ? Math.round(r.attnScore) : (d.key === "conv" ? r.conviction : d.key === "cat" ? r.catScore : r.focusScore).toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <span className="rounded px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: "#0b0f14", background: RANK_COLORS.conv }}>{t("Conviction", "语气")} {r.conviction.toFixed(1)}</span>
              <span className="font-mono text-muted2">L1 {L.L1.score}/{L.L1.max} · L2 {L.L2.score}/{L.L2.max} · L3 {L.L3.score}/{L.L3.max} · L4 {L.L4.score}/{L.L4.max}</span>
              {(r.conv.hedging?.level ?? 0) > 0 && <span className="font-mono" style={{ color: "#e0785a" }}>hedge −{Math.round((1 - r.conv.hedging.factor) * 100)}%</span>}
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted2">
              {r.conv.source === "upstream_anchor" && <span className="rounded px-1.5 py-[1px] text-[9.5px] font-semibold uppercase" style={{ color: "#e0b45a", background: "#e0b45a1a" }}>⇡ {r.conv.anchor_ticker || t("anchor", "上游锚")}</span>}
              <span>{r.conv.call_ref || t("call", "电话会")}{r.conv.call_date ? ` · ${r.conv.call_date}` : ""}</span>
              <span>· {t("shortlist", "登顶强度")} {r.shortlistComposite.toFixed(0)}</span>
            </div>
            {r.conv.summary && <p className="text-[11.5px] leading-relaxed text-muted">{r.conv.summary}</p>}
            <button onClick={() => onOpen(r.ticker)} className="mt-2.5 text-[11px] text-signal hover:underline">{t("full breakdown ↗", "完整拆解 ↗")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// A leaderboard: a header, a podium for the top 3, then the ranked rest. Used
// both per tier and per sector (same display), so `showTier` toggles the badges.
function Board({ header, rows, showTier, open, setOpen, onOpen, lang, t }: { header: ReactNode; rows: RankingRow[]; showTier: boolean; open: string | null; setOpen: (x: string | null) => void; onOpen: (x: string) => void; lang: "en" | "zh"; t: (en: string, zh: string) => string }) {
  if (!rows.length) return null;
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);
  const row = (r: RankingRow, rank: number) => (
    <RankRow key={r.ticker} r={r} rank={rank} showTier={showTier} open={open === r.ticker} onToggle={() => setOpen(open === r.ticker ? null : r.ticker)} onOpen={onOpen} lang={lang} t={t} />
  );
  return (
    <section className="mb-8">
      {header}
      {podium.length >= 2 ? (
        <div className="mb-4 flex items-end gap-3">
          {podium.length === 3 && <PodiumCard r={podium[1]} rank={2} showTier={showTier} onOpen={onOpen} t={t} />}
          <PodiumCard r={podium[0]} rank={1} showTier={showTier} onOpen={onOpen} t={t} />
          {podium[2] && <PodiumCard r={podium[2]} rank={3} showTier={showTier} onOpen={onOpen} t={t} />}
          {podium.length === 2 && <div className="flex-1" />}
        </div>
      ) : (
        <div className="mb-2 space-y-2">{podium.map((r, i) => row(r, i + 1))}</div>
      )}
      <div className="space-y-2">{rest.map((r, i) => row(r, i + 4))}</div>
    </section>
  );
}

export function RankingView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const marketCaps = useStore((s) => s.marketCaps);
  const catalyst = useStore((s) => s.catalyst);
  const conviction = useStore((s) => s.conviction);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const [mode, setMode] = useState<"tier" | "sector">("tier");
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const focus = buildFocus(data, heat, technical, marketCaps, sectors, supplychain);
    const shortlist = buildShortlist(focus, catalyst);
    return buildConvictionRanking(buildConviction(shortlist, conviction));
  }, [data, heat, technical, marketCaps, sectors, supplychain, catalyst, conviction]);

  const t1 = rows.filter((r) => r.tier === 1);
  const t2 = rows.filter((r) => r.tier === 2);

  // Per-sector: within a sector, keep the same (tier, conviction) order.
  const bySector = useMemo(() => {
    const m = new Map<string, RankingRow[]>();
    for (const r of rows) {
      const k = r.sector || "__none";
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Conviction Gate · Ranking", "语气闸 · 综合排行")}
        title={t("Ranking · by Management Conviction", "综合排行 · 按管理层语气")}
        desc={t(
          `Shortlist Tier 1 and Tier 2 names whose Conviction cleared ${RANK_MIN_CONVICTION}, ranked by Conviction score. The tier already bakes in core + catalyst, so it isn't re-counted — Tier 1 ranks above Tier 2, and within each tier Conviction decides.`,
          `登顶第一名(Tier 1)与第二名(Tier 2)中、管理层语气 > ${RANK_MIN_CONVICTION} 的票,按语气分排名。档位本身已包含核心+催化剂,故不重复计分——金档在银档之上,同档内按语气分排。`,
        )}
      />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t(`No Tier 1/2 name has cleared Conviction ${RANK_MIN_CONVICTION} yet — run catalyst + conviction first.`, `暂无金/银档票的语气分 > ${RANK_MIN_CONVICTION} —— 先跑 catalyst + conviction。`)}
        </div>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <div className="flex rounded-full border border-line p-0.5">
              {(["tier", "sector"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded-full px-3 py-1 text-[12px] transition-colors ${mode === m ? "bg-signal/15 text-signal" : "text-muted hover:text-text"}`}>
                  {m === "tier" ? t("By tier", "按档位") : t("By sector", "分板块")}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-3 text-[10.5px] text-muted2">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TIER_COLOR[1] }} />{t("Tier 1", "金档")} {t1.length}</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TIER_COLOR[2] }} />{t("Tier 2", "银档")} {t2.length}</span>
            </div>
          </div>

          {mode === "tier"
            ? ([1, 2] as const).map((tier) => {
                const col = TIER_COLOR[tier];
                const tRows = tier === 1 ? t1 : t2;
                return (
                  <Board
                    key={tier}
                    rows={tRows}
                    showTier={false}
                    open={open}
                    setOpen={setOpen}
                    onOpen={openDetail}
                    lang={lang}
                    t={t}
                    header={
                      <div className="mb-3 flex items-center gap-2.5 border-b pb-2" style={{ borderColor: `${col}44` }}>
                        <span className="grid h-6 w-6 place-items-center rounded-md font-mono text-[10px] font-bold" style={{ color: "#0b0f14", background: col }}>{tier}</span>
                        <h3 className="font-disp text-[15px] font-semibold tracking-tight" style={{ color: col }}>
                          {tier === 1 ? t("Tier 1 · Gold", "第一名榜 · 金档") : t("Tier 2 · Silver", "第二名榜 · 银档")}
                        </h3>
                        <span className="rounded-full bg-white/[0.06] px-1.5 py-[1px] font-mono text-[10.5px] text-muted2">{tRows.length}</span>
                        <span className="ml-auto text-[10px] text-muted2">{t("ranked by conviction", "按语气分排名")}</span>
                      </div>
                    }
                  />
                );
              })
            : bySector.map(([sec, secRows]) => {
                const hue = sec === "__none" ? "#8aa0b2" : sectorHue(sec);
                return (
                  <Board
                    key={sec}
                    rows={secRows}
                    showTier
                    open={open}
                    setOpen={setOpen}
                    onOpen={openDetail}
                    lang={lang}
                    t={t}
                    header={
                      <div className="mb-3 flex items-center gap-2.5 border-b pb-2" style={{ borderColor: `${hue}44` }}>
                        <span className="h-3.5 w-1 flex-none rounded-full" style={{ background: hue, boxShadow: `0 0 8px ${hue}88` }} />
                        <h3 className="font-disp text-[15px] font-semibold tracking-tight" style={{ color: hue }}>{sec === "__none" ? t("Unclassified", "未分类") : sectorLabel(sec, lang)}</h3>
                        <span className="rounded-full bg-white/[0.06] px-1.5 py-[1px] font-mono text-[10.5px] text-muted2">{secRows.length}</span>
                        <span className="ml-auto text-[10px] text-muted2">{t("ranked by conviction", "按语气分排名")}</span>
                      </div>
                    }
                  />
                );
              })}

          <p className="mt-4 text-[11px] leading-relaxed text-muted2">
            {t(
              "Ranking key = Conviction (0-10). Core + Catalyst are not re-added — they already decided the tier. The radar (open a row) shows the full profile; shortlist strength breaks ties.",
              "排名依据 = 语气分(0-10)。核心 + 催化剂不再加进来——它们已决定了档位。点开某行的雷达图看完整画像;登顶强度用于同分时的次级排序。",
            )}
          </p>
        </>
      )}
    </div>
  );
}
