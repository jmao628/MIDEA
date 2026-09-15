import { useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import { buildScreen, buildUniverse, buildEcoAdjacency, buildFocus, capSizeFromCap, capLabel, sectorLabel, LARGE_CAP_TICKERS } from "../pipeline";
import { ViewHead, Card, StatStrip } from "../ui";
import { MethodInfo } from "../MethodInfo";

const GRP_COLOR: Record<string, string> = {
  upstream: "#5fb0e8",
  downstream: "#48c78e",
  peers: "#e9c46a",
};

// Gold inner ring = 大盘: market cap ≥ $1T.
const GOLD_CAP = 1e12;

const PHASE_L: Record<string, { en: string; zh: string }> = {
  detonate: { en: "Detonate", zh: "引爆" },
  ignite: { en: "Ignite", zh: "点火" },
  watch: { en: "Watch", zh: "观察" },
  dead: { en: "Dead", zh: "死水" },
  ultralow: { en: "Ultra-low", zh: "超低覆盖" },
  warming: { en: "Warming", zh: "积累中" },
};

const ATTN_L: Record<string, { en: string; zh: string }> = {
  breakout: { en: "Breakout", zh: "突破" },
  igniting: { en: "Igniting", zh: "量价点火" },
  accumulating: { en: "Accumulating", zh: "吸筹中" },
  quiet: { en: "Quiet", zh: "沉寂" },
};

export function ScreenView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const marketCaps = useStore((s) => s.marketCaps);
  const supplychain = useStore((s) => s.supplychain);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();
  const [scSector, setScSector] = useState<string | null>(null);
  const [ecoSector, setEcoSector] = useState<string | null>(null);
  const sectorOf = (tk: string) => sectors?.[tk]?.sector ?? "";

  const { candidates, total, passedHeat } = useMemo(
    () => buildScreen(data, heat, marketCaps, technical),
    [data, heat, marketCaps, technical],
  );
  const scSectorCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const x of candidates) {
      const s = sectorOf(x.ticker);
      if (s) c.set(s, (c.get(s) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, sectors]);
  const shownCands = scSector ? candidates.filter((x) => sectorOf(x.ticker) === scSector) : candidates;

  // Ecosystem network — grouped strictly BY SECTOR. Each graph contains ONLY
  // that sector's own stocks (Tech shows tech, never WFC). Within a sector the
  // ring is split by MARKET CAP: large caps sit on the inner gold ring, smaller
  // caps on the outer blue ring. Edges are supply-chain ties that stay inside
  // the sector (a member's supplier/customer/peer that is ALSO in this sector).
  const ecoSectors = useMemo(() => {
    const bySector = new Map<string, EcoMember[]>();
    if (!supplychain) return bySector;
    const uni = buildUniverse(data);
    const inUni = new Set(uni.map((u) => u.ticker));
    const companyOf = new Map(uni.map((u) => [u.ticker, u.company]));
    const eco = buildEcoAdjacency(supplychain, marketCaps); // symmetrized
    // A representative cap VALUE for ordering the ring. Cap sources, in order of
    // reliability: (1) sectors.json market_cap — from yfinance .info, populated
    // for every node; (2) the marketcaps.json fast_info feed — flaky, often
    // missing mega-caps; (3) the static large-cap safety net; (4) the SA cap-size
    // label → a nominal value. GOLD RING = a real market cap ≥ $1T (大盘).
    const CAP_NOMINAL: Record<string, number> = { large: 2e10, mid: 4e9, small: 5e8, unknown: 1e8 };
    for (const u of uni) {
      const sec = sectorOf(u.ticker);
      if (!sec) continue;
      // Best numeric cap we have: prefer the reliable sectors.json .info cap,
      // then the flaky fast_info feed.
      const secCap = sectors?.[u.ticker]?.market_cap;
      const numeric =
        typeof secCap === "number" && secCap > 0
          ? secCap
          : typeof marketCaps?.[u.ticker] === "number" && marketCaps[u.ticker] > 0
            ? marketCaps[u.ticker]
            : undefined;
      if (typeof numeric === "number" && numeric < 3e8) continue; // drop tiny/illiquid
      const size = capSizeFromCap(numeric, u.caps); // large|mid|small|unknown
      const known = LARGE_CAP_TICKERS.has(u.ticker);
      // Gold ring is a STRICT market-cap threshold: ≥ $1T. It needs a real cap
      // number (sectors.json .info cap), so run `python -m newsagg.sectors` to
      // backfill caps if the gold ring looks empty.
      const large = typeof numeric === "number" && numeric >= GOLD_CAP;
      const capVal = numeric ?? (known ? 2e10 : CAP_NOMINAL[size]);
      // Keep only ties whose other end is in THIS sector and in your universe —
      // that is what makes the graph a pure single-sector network.
      const links = (eco.get(u.ticker) ?? [])
        .filter((n) => n.ticker !== u.ticker && inUni.has(n.ticker) && sectorOf(n.ticker) === sec)
        .map((n) => ({ ticker: n.ticker, kind: n.kind, importance: n.importance }));
      const m: EcoMember = {
        ticker: u.ticker,
        company: companyOf.get(u.ticker) ?? "",
        cap: capVal,
        large,
        links,
      };
      if (!bySector.has(sec)) bySector.set(sec, []);
      bySector.get(sec)!.push(m);
    }
    return bySector;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplychain, data, marketCaps, sectors]);

  const ecoSectorCounts = useMemo(
    () => [...ecoSectors.entries()].map(([s, m]) => [s, m.length] as [string, number]).sort((a, b) => b[1] - a[1]),
    [ecoSectors],
  );
  // The ecosystem graph is always ONE sector (a mixed "All" is an unreadable
  // hairball). Default to the sector with the most names.
  const effEcoSector = ecoSector ?? ecoSectorCounts[0]?.[0] ?? null;
  const ecoMembers = effEcoSector ? ecoSectors.get(effEcoSector) ?? [] : [];
  const linkTotal = useMemo(
    () => [...ecoSectors.values()].reduce((s, m) => s + m.length, 0),
    [ecoSectors],
  );

  // Nodes to "light up" = names scoring high on YOUR Focus List (score ≥ 7/10).
  const hotScores = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of buildFocus(data, heat, technical, marketCaps, sectors, supplychain)) m.set(f.ticker, f.score);
    return m;
  }, [data, heat, technical, marketCaps, sectors, supplychain]);

  const HUB_EN: Record<string, string> = {
    Technology: "Tech",
    Healthcare: "Health",
    "Financial Services": "Finance",
    "Consumer Cyclical": "Cyclical",
    "Consumer Defensive": "Defensive",
    "Communication Services": "Comms",
    "Basic Materials": "Materials",
    Industrials: "Industry",
    "Real Estate": "Real Est.",
    Utilities: "Utilities",
    Energy: "Energy",
  };
  const hubLabel = effEcoSector ? (lang === "zh" ? sectorLabel(effEcoSector, "zh") : HUB_EN[effEcoSector] ?? effEcoSector) : "HUB";

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Stage 2 · Screen (quality net)", "Stage 2 · 发现筛选（质量网）")}
        title={t("Screen · The Quality Net", "发现筛选 · 质量筛")}
        desc={t(
          "Run in parallel with Heat, not after it. The quality net keeps seeds that (1) carry an SA rating (thesis-only mentions with no rating are out) and (2) have an analyst thesis. The ✓ column marks names that ALSO cleared the Heat attention board — that overlap is what later stages act on.",
          "与热度点火并行，不是它的下游。质量网留下同时满足：(1) 有 SA 评分（无评分的纯提及出局）、(2) 有分析师看多论点 的种子。带 ✓ 的是同时也过了热度注意力榜的票——两网交集才是后续阶段真正处理的对象。",
        )}
        actions={<MethodInfo />}
      />

      <StatStrip
        stats={[
          { k: t("Seeds", "种子"), v: total, d: t("all deduped bulls", "去重后全部看多票") },
          { k: t("Quality net", "质量网"), v: candidates.length, d: t("rating + thesis", "有评分 + 有论点"), color: "#3dd6c4" },
          { k: t("In both nets", "两网交集"), v: passedHeat, d: t("also cleared Heat", "同时过热度榜"), color: "#f2a73c" },
        ]}
      />

      {supplychain && (
        <div className="mb-4">
        <Card
          title={t("Ecosystem Links", "生态关联网络")}
          sub={
            linkTotal
              ? t(`${linkTotal} names · grouped by sector · pick one below`, `${linkTotal} 只 · 按板块分组 · 下方选板块`)
              : t("no in-sector links mapped yet", "尚未映射到板块内关联")
          }
          right={<MethodInfo />}
        >
          {linkTotal === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-muted">
              {t(
                "Once more tickers are mapped (python -m newsagg.supplychain), the ones whose suppliers/customers/peers are also in your universe show up here — the interconnected cluster worth focusing on.",
                "等映射了更多票（python -m newsagg.supplychain），那些上下游/同业也落在你 universe 内的票会出现在这里——就是值得重点看的相互关联簇。",
              )}
            </div>
          ) : (
            <>
              {/* graph legend */}
              <div className="mb-3 space-y-1.5 rounded-lg border border-line bg-inset px-3 py-2 text-[11px] leading-relaxed">
                <div className="text-muted">
                  {t(
                    "One sector at a time — every node belongs to THIS sector (a Tech graph shows only Tech names). Centre = the sector. Three rings by market cap: inner gold = mega-caps (≥ $1T), middle teal = large-caps ($100B–$1T), outer blue = the rest (< $100B). Edges are supply-chain ties that stay inside the sector — a member's supplier, customer, or peer that is also in this sector (edge colour tells you which). A glowing halo = it's on your Focus List. Click any node.",
                    "一次看一个板块——每个节点都属于该板块（Tech 图里只有 Tech 的票）。中心 = 该板块。按市值分三圈：内圈金色 = 超大盘（≥$1万亿），中圈青色 = 大盘（$1000亿–$1万亿），外圈蓝色 = 其余（<$1000亿）。连线是留在板块内部的产业链关系——某成员的供应商 / 客户 / 同业且同属该板块（连线颜色区分）。发光光晕 = 在你的 Focus 名单里。点任意节点。",
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1.5" style={{ color: "#f0d78a" }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: "#e9c46a" }} />
                    {t("mega cap (≥$1T)", "超大盘（≥$1万亿）")}
                  </span>
                  <span className="flex items-center gap-1.5" style={{ color: "#5eead4" }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: "#2dd4bf" }} />
                    {t("large cap ($100B–$1T)", "大盘（$1000亿–$1万亿）")}
                  </span>
                  <span className="flex items-center gap-1.5" style={{ color: "#8fd6ea" }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: "#5fb0e8" }} />
                    {t("smaller (<$100B)", "中小盘（<$1000亿）")}
                  </span>
                  <span className="text-muted2">·</span>
                  <span className="text-muted2">{t("Edge colour = tie type:", "连线颜色 = 关系类型：")}</span>
                  {(["upstream", "downstream", "peers"] as const).map((k) => (
                    <span key={k} className="flex items-center gap-1.5" style={{ color: GRP_COLOR[k] }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: GRP_COLOR[k] }} />
                      {k === "upstream"
                        ? t("supplier (upstream)", "供应商（上游）")
                        : k === "downstream"
                          ? t("customer (downstream)", "客户（下游）")
                          : t("peer", "同业")}
                    </span>
                  ))}
                </div>
              </div>
              {/* sector picker — the graph is always one sector (no "All") */}
              {ecoSectorCounts.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] text-muted2">{t("Sector:", "板块:")}</span>
                  {ecoSectorCounts.map(([sec, n]) => (
                    <button
                      key={sec}
                      onClick={() => setEcoSector(sec)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${effEcoSector === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
                    >
                      {sectorLabel(sec, lang)} {n}
                    </button>
                  ))}
                </div>
              )}
              <EcoGraph members={ecoMembers} scores={hotScores} hub={hubLabel} onOpen={openDetail} t={t} />
            </>
          )}
        </Card>
        </div>
      )}

      <Card
        title={t("Quality Net", "质量网 · Screen")}
        sub={t(`${shownCands.length} names · in-both-nets first, then by cap`, `${shownCands.length} 只 · 两网交集在前，再按市值`)}
        pad0
      >
        {scSectorCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-[18px] py-2.5">
            <span className="text-[10.5px] text-muted2">{t("Sector:", "板块:")}</span>
            <button
              onClick={() => setScSector(null)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${scSector === null ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
            >
              {t("All", "全部")} {candidates.length}
            </button>
            {scSectorCounts.map(([sec, n]) => (
              <button
                key={sec}
                onClick={() => setScSector(scSector === sec ? null : sec)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${scSector === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"}`}
              >
                {sectorLabel(sec, lang)} {n}
              </button>
            ))}
          </div>
        )}
        {candidates.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-muted">
            {t("No candidates yet — no rated seed has an analyst thesis yet, or the SA scrape hasn't run.", "暂无候选。可能：还没有带评分的种子有分析师论点，或 SA 抓取还没跑。")}
          </div>
        ) : (
          <div className="max-h-[calc(100vh-320px)] overflow-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead className="sticky top-0 z-[1] bg-panel">
                <tr className="text-[11px] uppercase tracking-wide text-muted2">
                  <th className="px-3 py-2 text-left font-medium">{t("Ticker", "标的")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("Sector", "板块")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("Cap", "市值")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("Heat overlap", "热度交集")}</th>
                  <th className="px-3 py-2 text-right font-medium">z</th>
                  <th className="px-3 py-2 text-right font-medium">RVOL</th>
                  <th className="px-3 py-2 text-left font-medium">{t("Author", "作者")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("Thesis", "论点")}</th>
                </tr>
              </thead>
              <tbody>
                {shownCands.map((c) => (
                  <tr
                    key={c.ticker}
                    onClick={() => openDetail(c.ticker)}
                    className="cursor-pointer border-t border-line hover:bg-white/[0.03]"
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-mono font-semibold text-signal">{c.ticker}</span>
                      <span className="ml-2 text-[11px] text-muted">{c.company}</span>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted">
                      {sectorOf(c.ticker) ? sectorLabel(sectorOf(c.ticker), lang) : <span className="text-muted2">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted">{capLabel(c.cap, lang)}</td>
                    <td className="px-3 py-2.5">
                      {!c.advanced ? (
                        <span className="text-[11px] text-muted2">{t("· not in heat", "· 未过热度")}</span>
                      ) : c.via === "bypass" ? (
                        <span className="inline-block whitespace-nowrap rounded-full border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] font-medium text-signal">
                          ✓ {t("Mega bypass", "大票直通")}
                        </span>
                      ) : c.via === "social" ? (
                        <span className="inline-block whitespace-nowrap rounded-full border border-ignite/40 bg-ignite/10 px-2 py-0.5 text-[11px] font-medium text-ignite">
                          ✓ {c.phase ? (PHASE_L[c.phase]?.[lang] ?? c.phase) : t("Ignite", "点火")}
                        </span>
                      ) : (
                        <span className="inline-block whitespace-nowrap rounded-full border border-ok/40 bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">
                          ✓ {c.attnPhase ? (ATTN_L[c.attnPhase]?.[lang] ?? c.attnPhase) : t("Igniting", "量价点火")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {c.z != null ? c.z.toFixed(2) : <span className="text-muted2">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {c.rvol != null ? `${c.rvol.toFixed(1)}×` : <span className="text-muted2">—</span>}
                    </td>
                    <td className="px-3 py-2.5">{c.author ?? <span className="text-muted2">—</span>}</td>
                    <td className="max-w-[320px] px-3 py-2.5">
                      {c.articleUrl ? (
                        <a
                          href={c.articleUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={c.reasoning}
                          onClick={(e) => e.stopPropagation()}
                          className="block truncate text-signal hover:underline"
                        >
                          {c.reasoning} ↗
                        </a>
                      ) : (
                        <span className="truncate text-muted">{c.reasoning || "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Ecosystem graph ────────────────────────────────────────────────────────
// A radial network for ONE sector. Centre = the sector hub. THREE rings by
// market cap: inner gold = mega-caps (≥$1T), middle teal = large-caps
// ($100B–$1T), outer blue = the rest (<$100B). Every node belongs to this
// sector — no cross-sector nodes. Edges are supply-chain ties that stay inside
// the sector, coloured by tie type. All members are shown.
type EcoLink = { ticker: string; kind: string; importance: number };
type EcoMember = { ticker: string; company: string; cap: number; large: boolean; links: EcoLink[] };

// Cap tier: 1 = mega (≥$1T), 2 = large ($100B–$1T), 3 = the rest.
const ecoTier = (cap: number): 1 | 2 | 3 => (cap >= 1e12 ? 1 : cap >= 1e11 ? 2 : 3);

function EcoGraph({
  members,
  scores,
  hub,
  onOpen,
  t,
}: {
  members: EcoMember[];
  scores: Map<string, number>;
  hub: string;
  onOpen: (t: string) => void;
  t: (en: string, zh: string) => string;
}) {
  // Per-ring caps are generous so (nearly) every name shows; only truncate the
  // huge small-cap ring, keeping the most connected / Focus-listed names.
  const RING_MAX = { 1: 18, 2: 48, 3: 120 } as const;
  const byCap = [...members].sort((a, b) => b.cap - a.cap);
  const t1 = byCap.filter((m) => ecoTier(m.cap) === 1).slice(0, RING_MAX[1]);
  const t2 = byCap.filter((m) => ecoTier(m.cap) === 2).slice(0, RING_MAX[2]);
  const t3 = byCap
    .filter((m) => ecoTier(m.cap) === 3)
    .sort(
      (a, b) =>
        (scores.has(b.ticker) ? 1 : 0) - (scores.has(a.ticker) ? 1 : 0) ||
        b.links.length - a.links.length ||
        b.cap - a.cap,
    )
    .slice(0, RING_MAX[3]);

  if (!t1.length && !t2.length && !t3.length) {
    return (
      <div className="py-10 text-center text-[12.5px] text-muted">
        {t(
          "No names mapped in this sector yet — refresh supply-chain, or pick another sector.",
          "该板块暂无映射到的票——刷新供应链数据，或换一个板块。",
        )}
      </div>
    );
  }

  const W = 1120;
  const H = 1120;
  const cx = W / 2;
  const cy = H / 2;

  type Ring = { tier: 1 | 2 | 3; r: number; stroke: string; fill: string; label: string; hotStroke: string; nodeR: number; ms: EcoMember[] };
  const rings: Ring[] = [
    { tier: 1, r: 172, stroke: "#e9c46a", fill: "#2a2413", label: "#f0d78a", hotStroke: "#ffe08a", nodeR: 18, ms: t1 },
    { tier: 2, r: 322, stroke: "#2dd4bf", fill: "#0e2a28", label: "#5eead4", hotStroke: "#99f6e4", nodeR: 11, ms: t2 },
    { tier: 3, r: 468, stroke: "#5fb0e8", fill: "#123244", label: "#8fb6cc", hotStroke: "#7ff0e2", nodeR: 0, ms: t3 },
  ];

  // Place every node; build a position map for edges + a flat render list.
  type Placed = { m: EcoMember; x: number; y: number; ang: number; ring: Ring; nodeR: number };
  const placed: Placed[] = [];
  const pos = new Map<string, { x: number; y: number }>();
  for (const ring of rings) {
    const n = ring.ms.length;
    ring.ms.forEach((m, i) => {
      const ang = (n ? i / n : 0) * 2 * Math.PI - Math.PI / 2;
      const x = cx + ring.r * Math.cos(ang);
      const y = cy + ring.r * Math.sin(ang);
      const nodeR = ring.tier === 3 ? 5 + Math.min(m.links.length, 8) * 0.7 : ring.nodeR;
      placed.push({ m, x, y, ang, ring, nodeR });
      pos.set(m.ticker, { x, y });
    });
  }

  // Same-sector edges, de-duplicated by unordered pair. Keep the strongest tie.
  const edges = new Map<string, { a: string; b: string; kind: string; importance: number }>();
  for (const m of members) {
    if (!pos.has(m.ticker)) continue;
    for (const l of m.links) {
      if (!pos.has(l.ticker)) continue;
      const key = m.ticker < l.ticker ? `${m.ticker}|${l.ticker}` : `${l.ticker}|${m.ticker}`;
      const prev = edges.get(key);
      if (!prev || l.importance > prev.importance)
        edges.set(key, { a: m.ticker, b: l.ticker, kind: l.kind, importance: l.importance });
    }
  }

  const GRP: Record<string, string> = GRP_COLOR;
  const drawn = t1.length + t2.length + t3.length;

  return (
    <div>
      <div className="mb-2 text-[11px] text-muted2">
        {t(
          `${hub} sector · ${drawn} of ${members.length} shown · mega ${t1.length} (≥$1T) · large ${t2.length} ($100B–$1T) · small ${t3.length} · glow = on your Focus List · click any node`,
          `${hub} 板块 · 展示 ${drawn}/${members.length} · 超大盘 ${t1.length}(≥$1万亿) · 大盘 ${t2.length}($1000亿–$1万亿) · 中小盘 ${t3.length} · 发光 = 在你的 Focus 名单里 · 点任意节点`,
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-[#0a1017]">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 760, display: "block" }}>
          <defs>
            <radialGradient id="ecoCoreGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3dd6c4" stopOpacity="0.30" />
              <stop offset="100%" stopColor="#3dd6c4" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx={cx} cy={cy} r={250} fill="url(#ecoCoreGlow)" />

          {/* faint ring guides */}
          {rings.map((ring) => (
            <circle key={`ring${ring.tier}`} cx={cx} cy={cy} r={ring.r} fill="none" stroke={`${ring.stroke}22`} strokeWidth={1} />
          ))}

          {/* center → mega-cap spokes (innermost populated tier) */}
          {t1.map((m) => {
            const p = pos.get(m.ticker)!;
            return <line key={`sp${m.ticker}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#e9c46a55" strokeWidth={1.2} />;
          })}

          {/* same-sector supply-chain edges, coloured by tie type */}
          {[...edges.values()].map((e) => {
            const pa = pos.get(e.a)!;
            const pb = pos.get(e.b)!;
            const c = GRP[e.kind] ?? "#5fb0e8";
            return (
              <line
                key={`e${e.a}-${e.b}`}
                className="eco-edge"
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={c}
                strokeWidth={e.importance >= 3 ? 2 : 1}
                strokeOpacity={e.importance >= 3 ? 0.8 : 0.4}
              />
            );
          })}

          {/* center hub */}
          <circle cx={cx} cy={cy} r={32} fill="#0e2a3a" stroke="#3dd6c4" strokeWidth={2} style={{ filter: "drop-shadow(0 0 12px #3dd6c4aa)" }} />
          <text x={cx} y={cy + 4} textAnchor="middle" fontSize={hub.length > 7 ? 10 : 12} fontWeight="700" fill="#3dd6c4">
            {hub}
          </text>

          {/* nodes + labels, per ring */}
          {placed.map(({ m, x, y, ang, ring, nodeR }) => {
            const hot = scores.has(m.ticker); // in your Focus List → light up
            const inside = ring.tier === 1; // mega-cap labels sit inside the node
            const labelR = ring.r + nodeR + (ring.tier === 3 ? 9 : 12);
            const lx = inside ? x : cx + labelR * Math.cos(ang);
            const ly = inside ? y + 3.5 : cy + labelR * Math.sin(ang);
            const anchorRight = Math.cos(ang) >= 0;
            const fontSize = ring.tier === 1 ? 9.5 : ring.tier === 2 ? 9 : hot ? 8.5 : 7.8;
            return (
              <g key={m.ticker} className="eco-node" onClick={() => onOpen(m.ticker)}>
                <circle
                  cx={x}
                  cy={y}
                  r={hot ? nodeR + 1.5 : nodeR}
                  fill={ring.fill}
                  stroke={hot ? ring.hotStroke : `${ring.stroke}bb`}
                  strokeWidth={hot ? 2.6 : ring.tier === 3 ? 1.4 : 2}
                  style={{ filter: `drop-shadow(0 0 ${hot ? 9 : ring.tier === 3 ? 0 : 6}px ${ring.stroke}${hot ? "" : "88"})` }}
                />
                <text
                  x={lx}
                  y={ly}
                  textAnchor={inside ? "middle" : anchorRight ? "start" : "end"}
                  fontSize={fontSize}
                  fontFamily="ui-monospace, monospace"
                  fontWeight={ring.tier === 1 || hot ? 700 : 500}
                  fill={hot ? ring.hotStroke : ring.label}
                >
                  {m.ticker}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
