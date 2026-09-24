import { useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import {
  buildFocus,
  capLabel,
  sectorLabel,
  SUSTAINED_DAYS,
  FOCUS_ECO_LINKS,
  type FocusItem,
} from "../pipeline";
import { ViewHead, StatStrip } from "../ui";
import { MethodInfo } from "../MethodInfo";

const GRP_COLOR: Record<string, string> = {
  upstream: "#5fb0e8",
  downstream: "#48c78e",
  peers: "#e9c46a",
};

type FilterKey = "all" | "core" | "both" | "strong" | "sustained" | "linked";
type SortKey = "gates" | "score" | "links" | "rvol" | "streak";

export function FocusView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const marketCaps = useStore((s) => s.marketCaps);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("score");
  const [sector, setSector] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "cards">("cards");

  const all = useMemo(
    () => buildFocus(data, heat, technical, marketCaps, sectors, supplychain),
    [data, heat, technical, marketCaps, sectors, supplychain],
  );

  const coreN = all.filter((i) => i.core).length;
  const g3N = all.filter((i) => i.gates >= 3).length;
  const strongN = all.filter((i) => i.strongBuy).length;
  const sustainedN = all.filter((i) => i.buyStreak >= SUSTAINED_DAYS).length;
  const linkedN = all.filter((i) => i.links > 0).length;

  const sectorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) if (i.sector) m.set(i.sector, (m.get(i.sector) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const shown = useMemo(() => {
    let rows = all;
    if (filter === "core") rows = rows.filter((i) => i.core);
    else if (filter === "both") rows = rows.filter((i) => i.gates >= 3);
    else if (filter === "strong") rows = rows.filter((i) => i.strongBuy);
    else if (filter === "sustained") rows = rows.filter((i) => i.buyStreak >= SUSTAINED_DAYS);
    else if (filter === "linked") rows = rows.filter((i) => i.links > 0);
    if (sector) rows = rows.filter((i) => i.sector === sector);
    const key = (i: FocusItem) =>
      sort === "links"
        ? i.ecoWeight
        : sort === "rvol"
          ? (i.rvol ?? -1)
          : sort === "streak"
            ? i.buyStreak
            : sort === "gates"
              ? i.gates
              : i.score;
    return [...rows].sort((a, b) => key(b) - key(a) || b.score - a.score);
  }, [all, filter, sector, sort]);

  const FILTERS: { k: FilterKey; label: string; n: number }[] = [
    { k: "all", label: t("All", "全部"), n: all.length },
    { k: "core", label: t("★ Core (2 hard)", "★ 核心(两硬)"), n: coreN },
    { k: "both", label: t("3+ gates", "≥3 闸"), n: g3N },
    { k: "strong", label: t("Strong Buy", "强力买入"), n: strongN },
    { k: "sustained", label: t(`Sustained ${SUSTAINED_DAYS}d`, `持续买入 ${SUSTAINED_DAYS} 天`), n: sustainedN },
    { k: "linked", label: t("Connected", "有关联"), n: linkedN },
  ];
  const SORTS: { k: SortKey; label: string }[] = [
    { k: "gates", label: t("Gates", "过闸数") },
    { k: "score", label: t("Composite", "综合分") },
    { k: "streak", label: t("Buy streak", "买入连续") },
    { k: "links", label: t("Ecosystem", "生态权重") },
    { k: "rvol", label: "RVOL" },
  ];

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Step 2 · Output", "第 2 步 · 输出")}
        title={t("Focus List · Graded, Not Cut", "重点名单 · 分级不砍")}
        desc={t(
          `Inclusive on purpose — nothing is dropped prematurely; the deeper stages (catalyst + earnings-call) do the fine cut. The SCORE (0–10) weights two dimensions: BUY 0–5 (strong-buy 3.0 or ${SUSTAINED_DAYS}-day sustained 1.6, plus up to 2.0 for a longer streak) · ECOSYSTEM 0–4.5 (tied to a mega-cap anchor, or ≥${FOCUS_ECO_LINKS} in-universe links, weighted by CRITICALITY — a sole-source / hard-to-replace edge counts most), plus a +0.5 both-nets bonus. THESIS (analyst write-up) is shown as a signal flag but is NO LONGER scored — its point now sits in Buy. Sorted by gates fired, then the composite. ★ Core = both hard signals (buy + ecosystem) fire.`,
          `刻意做成包容——不提前砍票,精挑留给后面的催化剂+财报电话。综合分(0–10)只看两个维度:买入 0–5(强买 3.0 或 连续${SUSTAINED_DAYS}天 1.6,外加最多 2.0 的更长连续买入天数) · 生态 0–4.5(挂靠大票锚,或 ≥${FOCUS_ECO_LINKS} 个 universe 内关联,按"关键度"加权——越独家/非他不可分越高),再加 +0.5 双网命中。论点(分析师发文)作为信号标记显示,但已不再计分——那 1 分现已并入买入。先按过闸数排,再按综合分。★ 核心 = 两个硬信号(买入+生态)全中。`,
        )}
        actions={<MethodInfo />}
      />

      <StatStrip
        stats={[
          { k: t("On the list", "名单内"), v: all.length, d: t("any signal, graded", "任一信号,分级"), color: "#3dd6c4" },
          { k: t("★ Core", "★ 核心"), v: coreN, d: t("2 hard signals", "两硬信号全中"), color: "#f2a73c" },
          { k: t("3+ gates", "≥3 闸"), v: g3N, d: t("high conviction", "高信度"), color: "#48c78e" },
          { k: t("Strong Buy", "强力买入"), v: strongN, d: t("gauge = strong buy", "表针=强买") },
        ]}
      />

      {/* controls */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
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
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted2">{t("Sort", "排序")}</span>
          {SORTS.map((s) => (
            <button
              key={s.k}
              onClick={() => setSort(s.k)}
              className={`rounded-md px-2 py-0.5 text-[12px] transition-colors ${
                sort === s.k ? "bg-white/[0.08] text-text" : "text-muted hover:text-text"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex overflow-hidden rounded-lg border border-line">
          {(["list", "cards"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-[12px] transition-colors ${
                mode === m ? "bg-signal/15 text-signal" : "text-muted hover:text-text"
              }`}
            >
              {m === "list" ? t("☰ Ranked", "☰ 榜单") : t("▦ Cards", "▦ 卡片")}
            </button>
          ))}
        </div>
      </div>

      {sectorCounts.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted2">{t("Sector:", "板块:")}</span>
          <button
            onClick={() => setSector(null)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
              sector === null ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"
            }`}
          >
            {t("All", "全部")}
          </button>
          {sectorCounts.map(([sec, n]) => (
            <button
              key={sec}
              onClick={() => setSector(sector === sec ? null : sec)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
                sector === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"
              }`}
            >
              {sectorLabel(sec, lang)} {n}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t(
            "Nothing here yet — needs technical data (strong-buy gauges) and supply-chain maps. Run technical + supplychain on the Mac.",
            "暂时为空——需要技术数据(强买表针)和供应链映射。在 Mac 上跑 technical + supplychain。",
          )}
        </div>
      ) : mode === "cards" ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {shown.map((i, idx) => (
            <FocusCard key={i.ticker} item={i} rank={idx} onOpen={openDetail} lang={lang} t={t} />
          ))}
        </div>
      ) : (
        <FocusTable rows={shown} maxScore={10} onOpen={openDetail} lang={lang} t={t} />
      )}
    </div>
  );
}

// Dense ranked leaderboard — the whole list top-to-bottom by score, so the
// strongest names read first without hunting through sector cards.
function FocusTable({
  rows,
  maxScore,
  onOpen,
  lang,
  t,
}: {
  rows: FocusItem[];
  maxScore: number;
  onOpen: (t: string) => void;
  lang: "en" | "zh";
  t: (en: string, zh: string) => string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead className="sticky top-0 z-[1] bg-panel">
          <tr className="text-[10.5px] uppercase tracking-wide text-muted2">
            <th className="px-3 py-2 text-right font-medium">#</th>
            <th className="px-3 py-2 text-left font-medium">{t("Ticker", "标的")}</th>
            <th className="px-3 py-2 text-left font-medium">{t("Signals", "信号")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Eco", "生态")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("Score", "综合分")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i, idx) => {
            const crit = i.neighbors.some((n) => n.importance >= 3);
            return (
              <tr
                key={i.ticker}
                onClick={() => onOpen(i.ticker)}
                className="cursor-pointer border-t border-line transition-colors hover:bg-white/[0.04]"
              >
                <td className="px-3 py-2 text-right font-mono text-[11px] text-muted2">{idx + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-signal">{i.ticker}</span>
                    {i.core && <span className="text-[10px] text-gold">★</span>}
                    <span className="truncate text-[11px] text-muted">{i.company}</span>
                    {i.sector && <span className="text-[10px] text-muted2">· {sectorLabel(i.sector, lang)}</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Dot on={i.gBuy} c="#48c78e" title={t("Buy", "买入")} />
                    <Dot on={i.gEco} c={i.anchors > 0 ? "#e9c46a" : "#5fb0e8"} title={t("Ecosystem", "生态")} />
                    <Dot on={i.gThesis} c="#8aa" title={t("Thesis", "论点")} />
                    <span className="ml-1 font-mono text-[11px] text-muted2">{i.gates}/3</span>
                    {i.buyStreak >= SUSTAINED_DAYS && (
                      <span className="ml-1 rounded bg-ok/10 px-1 text-[9.5px] font-medium text-ok">
                        {t(`${i.buyStreak}d`, `${i.buyStreak}天`)}
                      </span>
                    )}
                    {i.strongBuy && <span className="ml-0.5 rounded bg-gold/10 px-1 text-[9.5px] font-medium text-gold">SB</span>}
                  </div>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums text-[12px]">
                  {i.links > 0 ? (
                    <span style={{ color: crit ? "#e9c46a" : undefined }}>
                      {crit ? "! " : ""}
                      {i.links}·{i.ecoWeight}
                    </span>
                  ) : (
                    <span className="text-muted2">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="ml-auto flex w-[92px] items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-inset">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${(i.score / maxScore) * 100}%`, background: i.gates >= 3 ? "#3dd6c4" : "#5a6a7c" }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-[13px] font-semibold" style={{ color: i.gates >= 3 ? "#3dd6c4" : "#c7d2dc" }}>
                      {i.score.toFixed(1)}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Dot({ on, c, title }: { on: boolean; c: string; title: string }) {
  return (
    <span
      title={title}
      className="h-2 w-2 rounded-full"
      style={{ background: on ? c : "transparent", border: on ? "none" : "1px solid #2a3a49" }}
    />
  );
}

function Sparkline({ data, up }: { data: number[]; up: boolean }) {
  const W = 92;
  const H = 30;
  if (!data || data.length < 2) return <div style={{ width: W, height: H }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const rng = max - min || 1;
  const n = data.length;
  const x = (i: number) => (i * W) / (n - 1);
  const y = (v: number) => H - 3 - ((v - min) / rng) * (H - 6);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const col = up ? "#3dd6c4" : "#ff5a78";
  const gid = `sg-${up ? "u" : "d"}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.28" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill={`url(#${gid})`} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={col}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FocusCard({
  item,
  rank,
  onOpen,
  lang,
  t,
}: {
  item: FocusItem;
  rank: number;
  onOpen: (t: string) => void;
  lang: "en" | "zh";
  t: (en: string, zh: string) => string;
}) {
  const up = (item.changePct ?? 0) >= 0;
  // Tier drives the whole card's tone: core = gold aura, high-conviction = teal.
  const accent = item.core ? "#e9c46a" : item.gates >= 3 ? "#3dd6c4" : "#3a4a5a";
  const gateDefs: { on: boolean; c: string; label: string }[] = [
    { on: item.gBuy, c: "#48c78e", label: t("Buy", "买") },
    { on: item.gEco, c: item.anchors > 0 ? "#e9c46a" : "#5fb0e8", label: t("Eco", "生") },
    { on: item.gThesis, c: "#9aa7b3", label: t("Thesis", "论") },
  ];
  return (
    <div
      onClick={() => onOpen(item.ticker)}
      className="view-in group relative cursor-pointer overflow-hidden rounded-2xl border bg-panel2 p-3.5 transition-all duration-200 hover:-translate-y-1"
      style={{
        animationDelay: `${Math.min(rank, 24) * 16}ms`,
        borderColor: item.core ? "#e9c46a55" : item.gates >= 3 ? "#3dd6c433" : "var(--line,#22303c)",
        boxShadow: item.core ? "0 0 0 1px #e9c46a22, 0 6px 22px -12px #e9c46a55" : undefined,
      }}
    >
      {/* accent glow that intensifies on hover */}
      <div
        className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full opacity-25 blur-2xl transition-opacity duration-300 group-hover:opacity-60"
        style={{ background: accent }}
      />
      {/* left tier rail */}
      <div className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accent }} />

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-muted2">#{rank + 1}</span>
            <span className="font-mono text-[17px] font-bold text-signal group-hover:underline">{item.ticker}</span>
            {item.core && (
              <span className="rounded-full border border-gold/60 bg-gold/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-gold">
                ★ {t("CORE", "核心")}
              </span>
            )}
            {item.buyStreak >= SUSTAINED_DAYS && (
              <span className="rounded-full border border-ok/45 bg-ok/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-ok">
                {t(`${item.buyStreak}D`, `${item.buyStreak}天`)}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted">
            {item.company || "—"} · {capLabel(item.cap, lang)}
            {item.sector ? ` · ${sectorLabel(item.sector, lang)}` : ""}
          </div>
        </div>
        <div className="flex flex-none flex-col items-end">
          <Sparkline data={item.spark} up={up} />
          {item.changePct != null && (
            <span className="mt-0.5 font-mono text-[10px] font-semibold" style={{ color: up ? "#48c78e" : "#ff5a78" }}>
              {up ? "+" : ""}
              {item.changePct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* score + gate meter */}
      <div className="relative mt-3 flex items-end justify-between">
        <div className="flex items-center gap-2.5">
          <div className="leading-none">
            <span className="font-disp text-[26px] font-semibold" style={{ color: item.gates >= 3 ? "#3dd6c4" : "#c7d2dc" }}>
              {item.score.toFixed(1)}
            </span>
            <span className="ml-0.5 text-[11px] text-muted2">/10</span>
          </div>
          {/* segmented gate meter */}
          <div className="flex items-center gap-1" title={`${item.gates}/3`}>
            {gateDefs.map((g, i) => (
              <span
                key={i}
                title={g.label}
                className="h-4 w-1.5 rounded-full transition-all"
                style={{ background: g.on ? g.c : "#26323d", boxShadow: g.on ? `0 0 6px ${g.c}88` : "none" }}
              />
            ))}
            <span className="ml-0.5 font-mono text-[10px] text-muted2">{item.gates}/3</span>
          </div>
        </div>
      </div>

      {/* ecosystem chips */}
      {item.neighbors.length > 0 && (
        <div className="relative mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
          <span className="text-[9.5px] uppercase text-muted2">
            {t(`eco ${item.ecoWeight}`, `生态 ${item.ecoWeight}`)}
          </span>
          {item.neighbors
            .slice()
            .sort((a, b) => Number(b.anchor) - Number(a.anchor) || b.importance - a.importance)
            .slice(0, 5)
            .map((n) => (
              <button
                key={n.ticker}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(n.ticker);
                }}
                className="rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-transform hover:scale-110"
                style={{
                  color: GRP_COLOR[n.kind],
                  borderColor: n.importance >= 3 ? GRP_COLOR[n.kind] : `${GRP_COLOR[n.kind]}55`,
                  background: `${GRP_COLOR[n.kind]}${n.importance >= 3 ? "26" : "14"}`,
                }}
                title={
                  (n.kind === "upstream"
                    ? t(`${n.ticker} supplies ${item.ticker}`, `${n.ticker} 供应 ${item.ticker}`)
                    : n.kind === "downstream"
                      ? t(`${n.ticker} buys from ${item.ticker}`, `${n.ticker} 采购自 ${item.ticker}`)
                      : t(`${n.ticker} competes with ${item.ticker}`, `${n.ticker} 与 ${item.ticker} 竞争`)) +
                  (n.importance >= 3 ? t(" · critical", " · 关键/非他不可") : "")
                }
              >
                {n.anchor ? "⚓ " : ""}
                {n.importance >= 3 ? "!" : ""}
                {n.ticker}
              </button>
            ))}
          {item.neighbors.length > 5 && (
            <span className="text-[10px] text-muted2">+{item.neighbors.length - 5}</span>
          )}
        </div>
      )}
    </div>
  );
}
