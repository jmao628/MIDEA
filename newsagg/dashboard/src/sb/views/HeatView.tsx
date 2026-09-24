import { useMemo, useState } from "react";
import { useStore, useT } from "../../store";
import { buildRankings, companyMap, sectorLabel, type Ranking } from "../pipeline";
import { ViewHead, Card, StatStrip } from "../ui";
import { MethodInfo } from "../MethodInfo";

const LENS_COLOR: Record<string, string> = {
  attention: "#3dd6c4",
  rvol: "#5fb0e8",
  momentum: "#f2a73c",
  social: "#e9c46a",
};

function RankingCard({ ranking, filter }: { ranking: Ranking; filter: string | null }) {
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();
  const color = LENS_COLOR[ranking.key] ?? "#3dd6c4";
  const base = filter ? ranking.rows.filter((r) => r.sector === filter) : ranking.rows;
  const rows = base.filter((r) => r.inTop);
  return (
    <Card
      title={ranking.label[lang]}
      sub={t(`${rows.length} qualified · ${base.length} total`, `${rows.length} 达标入选 · 共 ${base.length} 只`)}
      pad0
      right={<span className="h-2 w-2 rounded-full" style={{ background: color }} />}
    >
      <div className="px-[18px] pb-1 pt-2 text-[11px] text-muted2">{ranking.desc[lang]}</div>
      <table className="w-full text-[13px]">
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-[18px] py-4 text-[12px] text-muted2">
                {t("No ticker clears this lens today.", "今日无票达标此维度。")}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.ticker}
                onClick={() => openDetail(r.ticker)}
                className="cursor-pointer border-t border-line transition-colors hover:bg-white/[0.03]"
              >
                <td className="w-8 py-2 pl-[18px] pr-1 text-right font-mono text-[11px] text-muted2">{r.rank}</td>
                <td className="py-2 pl-2">
                  <span className="font-mono font-semibold text-signal">{r.ticker}</span>
                  <span className="ml-2 text-[11px] text-muted">{r.company}</span>
                </td>
                <td className="py-2 text-[11px] text-muted2">{sectorLabel(r.sector, lang)}</td>
                <td className="py-2 pr-2 text-right font-mono tabular-nums" style={{ color }}>
                  {r.display}
                </td>
                <td className="w-14 py-2 pr-[18px] text-right">
                  <span
                    className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium"
                    style={{ color, borderColor: `${color}66`, background: `${color}18` }}
                  >
                    {t("PASS", "入选")}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

export function HeatView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const marketCaps = useStore((s) => s.marketCaps);
  const lang = useStore((s) => s.lang);
  const t = useT();
  const [filter, setFilter] = useState<string | null>(null);
  // The Strong-Buy section has its OWN sector filter so clicking it doesn't
  // re-filter (and reflow) the ranking board above it, which made the page jump.
  const [sbFilter, setSbFilter] = useState<string | null>(null);

  const openDetail = useStore((s) => s.openDetail);
  const cmap = useMemo(() => companyMap(data), [data]);

  const bundle = useMemo(
    () => buildRankings(data, heat, technical, marketCaps, sectors),
    [data, heat, technical, marketCaps, sectors],
  );

  const bypassOnly = useMemo(() => {
    const out: string[] = [];
    for (const [tk, lenses] of bundle.advancingBy) {
      if (lenses.length === 1 && lenses[0] === "bypass") out.push(tk);
    }
    return out.sort((a, b) => (marketCaps?.[b] ?? 0) - (marketCaps?.[a] ?? 0));
  }, [bundle.advancingBy, marketCaps]);

  const sectorCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const tk of bundle.advancing) {
      const sec = sectors?.[tk]?.sector ?? "";
      if (sec) c.set(sec, (c.get(sec) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [bundle.advancing, sectors]);

  if (bundle.rankings.length === 0) {
    return (
      <div className="view-in">
        <ViewHead
          eyebrow={t("Stage 2 · Heat Ignition", "Stage 2 · 热度点火")}
          title={t("Heat Ignition · Multi-Lens Ranking", "热度点火 · 多维排名")}
          desc={t(
            "Every SA-rated seed, ranked by several independent lenses: price-volume attention, relative volume, momentum, social heat.",
            "全部有 SA 评分的票,按量价注意力 / 放量 / 动量 / 社交热度多个维度分别排名。",
          )}
          actions={<MethodInfo />}
        />
        <Card>
          <div className="p-6 text-center text-[13px] text-muted">
            {t("No price-volume or heat data yet. Run ", "还没有量价或热度数据。运行 ")}
            <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-signal">python -m newsagg.technical</code>
            {t(" and ", " 与 ")}
            <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-signal">python -m newsagg.heat</code>.
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Stage 2 · Heat Ignition", "Stage 2 · 热度点火")}
        title={t("Heat Ignition · Multi-Lens Ranking", "热度点火 · 多维排名")}
        desc={t(
          "The whole seed pool, ranked by several independent lenses — attention, relative volume, 60-day momentum, social heat. Each lens lights up its top-10 that clear the bar (weak days stay dim). Any lens PASS advances. Rankings recompute every daily technical run, so they shift with each day's price-volume. Click a row for detail.",
          "种子池全部在此,按多个独立维度分别排名——量价注意力、放量 RVOL、60 日动量、社交热度。每个维度取前 10 且达标才点亮入选(弱势那天没票达标就全灰,不硬凑)。排名每天随技术数据重算,会跟着当日量价变化。任一维度入选即晋级下一轮。点行看详情。",
        )}
        actions={<MethodInfo />}
      />

      {technical?.generated_at && (
        <div className="mb-3 flex items-center gap-1.5 text-[11px] text-muted2">
          <span className="h-1.5 w-1.5 rounded-full bg-signal/70" />
          {t("Board data as of ", "排名数据更新于 ")}
          {new Date(technical.generated_at).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {t(" · recomputes with each daily technical run", " · 每次每日技术抓取后重算")}
        </div>
      )}

      <StatStrip
        stats={[
          { k: t("Seed Pool", "种子池"), v: bundle.universe, d: t("SA-rated tickers", "有 SA 评分的票") },
          {
            k: t("Advancing", "入选下一轮"),
            v: bundle.advancing.size,
            d: t("union of top-10 + strong buy + mega bypass", "各维度前10 + 强买 + 大票直通 的并集"),
            color: "#3dd6c4",
          },
          {
            k: t("Lenses", "排名维度"),
            v: bundle.rankings.length,
            d: t("attn / rvol / momentum / social", "量价/放量/动量/社交(有数据的)"),
          },
          {
            k: t("Top Sector", "主导板块"),
            v: sectorCounts.length ? sectorLabel(sectorCounts[0][0], lang) : "—",
            d: sectorCounts.length
              ? t(`${sectorCounts[0][1]} advancing`, `${sectorCounts[0][1]} 只入选`)
              : t("awaiting sector data", "待板块数据"),
            color: "#f2a73c",
          },
        ]}
      />

      {sectorCounts.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted2">{t("By sector:", "按板块看入选:")}</span>
          <button
            onClick={() => setFilter(null)}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
              filter === null ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"
            }`}
          >
            {t("All", "全部")} {bundle.advancing.size}
          </button>
          {sectorCounts.map(([sec, n]) => (
            <button
              key={sec}
              onClick={() => setFilter(filter === sec ? null : sec)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
                filter === sec ? "border-signal/50 bg-signal/10 text-signal" : "border-line text-muted hover:text-text"
              }`}
            >
              {sectorLabel(sec, lang)} {n}
            </button>
          ))}
        </div>
      )}

      {/* the multi-lens board is the core of the step — show it first */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))]">
        {bundle.rankings.map((r) => (
          <RankingCard key={r.key} ranking={r} filter={filter} />
        ))}
      </div>

      {(() => {
        const bpRows = filter ? bypassOnly.filter((tk) => (sectors?.[tk]?.sector ?? "") === filter) : bypassOnly;
        return bpRows.length > 0 ? (
          <div className="mt-4">
          <Card
            title={t("Mega-Cap Bypass", "大票直通")}
            sub={t(
              `≥ $100B · ${bpRows.length} names · already discovered, skip the heat gate · by market cap`,
              `≥ $1000亿 · ${bpRows.length} 只 · 已被充分覆盖,跳过热度闸 · 按市值排序`,
            )}
            pad0
          >
            <div className="max-h-[300px] overflow-y-auto">
              <table className="w-full text-[13px]">
                <tbody>
                  {bpRows.map((tk, i) => (
                    <tr
                      key={tk}
                      onClick={() => openDetail(tk)}
                      className="cursor-pointer border-t border-line transition-colors hover:bg-white/[0.03]"
                    >
                      <td className="w-8 py-2 pl-[18px] pr-1 text-right font-mono text-[11px] text-muted2">{i + 1}</td>
                      <td className="py-2 pl-2">
                        <span className="font-mono font-semibold text-signal">{tk}</span>
                        <span className="ml-2 text-[11px] text-muted">{cmap.get(tk) ?? ""}</span>
                      </td>
                      <td className="py-2 text-[11px] text-muted2">{sectorLabel(sectors?.[tk]?.sector ?? "", lang)}</td>
                      <td className="py-2 pr-1 text-right font-mono tabular-nums text-signal">
                        {marketCaps?.[tk] ? `$${(marketCaps[tk] / 1e9).toFixed(0)}B` : "—"}
                      </td>
                      <td className="w-14 py-2 pr-[18px] text-right">
                        <span className="whitespace-nowrap rounded-full border border-signal/40 bg-signal/10 px-2 py-0.5 text-[10px] font-medium text-signal">
                          {t("BYPASS", "直通")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          </div>
        ) : null;
      })()}

      {(() => {
        const sbRows = sbFilter ? bundle.strongBuys.filter((s) => s.sector === sbFilter) : bundle.strongBuys;
        const sbSectors = (() => {
          const c = new Map<string, number>();
          for (const s of bundle.strongBuys) if (s.sector) c.set(s.sector, (c.get(s.sector) ?? 0) + 1);
          return [...c.entries()].sort((a, b) => b[1] - a[1]);
        })();
        return bundle.strongBuys.length > 0 ? (
          <div className="mt-4">
            <Card
              title={t("Strong Buy · All", "强力买入 · 全部")}
              sub={t(
                `${sbRows.length} names · technical gauge = strong buy · by attention score`,
                `${sbRows.length} 只 · 技术表针=强买 · 按注意力分排序`,
              )}
              pad0
            >
              {sbSectors.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-[18px] py-2.5">
                  <span className="text-[10.5px] text-muted2">{t("Sector:", "板块:")}</span>
                  <button
                    onClick={() => setSbFilter(null)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${sbFilter === null ? "border-gold/50 bg-gold/10 text-gold" : "border-line text-muted hover:text-text"}`}
                  >
                    {t("All", "全部")} {bundle.strongBuys.length}
                  </button>
                  {sbSectors.map(([sec, n]) => (
                    <button
                      key={sec}
                      onClick={() => setSbFilter(sbFilter === sec ? null : sec)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${sbFilter === sec ? "border-gold/50 bg-gold/10 text-gold" : "border-line text-muted hover:text-text"}`}
                    >
                      {sectorLabel(sec, lang)} {n}
                    </button>
                  ))}
                </div>
              )}
              <div className="max-h-[300px] overflow-y-auto">
                <table className="w-full text-[13px]">
                  <tbody>
                    {sbRows.map((s, i) => (
                      <tr
                        key={s.ticker}
                        onClick={() => openDetail(s.ticker)}
                        className="cursor-pointer border-t border-line transition-colors hover:bg-white/[0.03]"
                      >
                        <td className="w-8 py-2 pl-[18px] pr-1 text-right font-mono text-[11px] text-muted2">{i + 1}</td>
                        <td className="py-2 pl-2">
                          <span className="font-mono font-semibold text-signal">{s.ticker}</span>
                          <span className="ml-2 text-[11px] text-muted">{s.company}</span>
                        </td>
                        <td className="py-2 text-[11px] text-muted2">{sectorLabel(s.sector, lang)}</td>
                        <td className="py-2 text-right font-mono tabular-nums text-gold">{s.score}</td>
                        <td className="w-16 py-2 pr-1 text-right font-mono tabular-nums text-muted">
                          {s.rvol != null ? `${s.rvol.toFixed(2)}×` : "—"}
                        </td>
                        <td className="w-14 py-2 pr-[18px] text-right">
                          <span className="whitespace-nowrap rounded-full border border-gold/45 bg-gold/10 px-2 py-0.5 text-[10px] font-medium text-gold">
                            {t("STRONG", "强买")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        ) : null;
      })()}
    </div>
  );
}
