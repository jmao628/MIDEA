import { useMemo } from "react";
import { useStore, useT } from "../../store";
import { FORWARD_TIER, TIMING_META, type ForwardTier } from "../pipeline";
import { ViewHead, ForwardBadge } from "../ui";
import type { LedgerHorizon, LedgerStat, LedgerRecent } from "../../types";
import type { TechTiming } from "../../types";

const HORIZONS: { key: LedgerHorizon; en: string; zh: string }[] = [
  { key: "5", en: "1 week", zh: "1 周" },
  { key: "10", en: "2 weeks", zh: "2 周" },
  { key: "20", en: "4 weeks", zh: "4 周" },
];
const TIERS: ForwardTier[] = ["prime", "favourable", "neutral", "wait"];

const pct = (x: number | null | undefined, digits = 2): string => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(digits)}%`);
const p0 = (x: number | null | undefined): string => (x == null ? "—" : `${(100 * x).toFixed(0)}%`);
const retColor = (x: number | null | undefined): string => (x == null ? "#5a6a7c" : x > 0 ? "#48c78e" : x < 0 ? "#ff6b81" : "#c7d2dc");

// One stat cell: hit rate on top, excess (or mean, for the universe) below.
function StatCell({ s, isUniverse }: { s: LedgerStat | undefined; isUniverse?: boolean }) {
  if (!s || !s.n) return <td className="px-2 py-2 text-center font-mono text-[11px] text-muted2">—</td>;
  const v = isUniverse ? s.mean : s.excess;
  return (
    <td className="px-2 py-2 text-center">
      <div className="font-mono text-[13px] font-semibold tabular-nums" style={{ color: s.hit >= 0.6 ? "#48c78e" : s.hit >= 0.5 ? "#c7d2dc" : "#ff6b81" }}>{p0(s.hit)}</div>
      <div className="font-mono text-[10px] tabular-nums" style={{ color: retColor(v) }}>{pct(v)}</div>
      <div className="text-[9px] text-muted2">n={s.n}</div>
    </td>
  );
}

function RecentRow({ r, onOpen, lang }: { r: LedgerRecent; onOpen: (t: string) => void; lang: "en" | "zh" }) {
  const meta = TIMING_META[r.state as TechTiming["timing"]];
  const stateLabel = meta ? (lang === "zh" ? meta.zh : meta.en) : r.state;
  const cell = (r_: number | null, x: number | null) => (
    <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums">
      <span style={{ color: retColor(r_) }}>{pct(r_, 1)}</span>
      {x != null && <span className="ml-1 text-[9px] text-muted2">({pct(x, 1)})</span>}
    </td>
  );
  return (
    <tr className="border-t border-line/60 hover:bg-white/[0.03]">
      <td className="px-2 py-1.5 font-mono text-[10.5px] text-muted2">{r.date}</td>
      <td className="px-2 py-1.5">
        <button onClick={() => onOpen(r.ticker)} className="font-disp text-[13px] font-bold tracking-tight text-text hover:text-signal">{r.ticker}</button>
      </td>
      <td className="px-2 py-1.5"><ForwardBadge score={r.score} /></td>
      <td className="px-2 py-1.5 text-[10.5px] text-muted">{stateLabel}</td>
      <td className="px-2 py-1.5 text-right font-mono text-[11px] text-muted">${r.entry.toFixed(2)}</td>
      {cell(r.r5, r.x5)}
      {cell(r.r10, r.x10)}
      {cell(r.r20, r.x20)}
    </tr>
  );
}

export function LedgerView() {
  const ledger = useStore((s) => s.ledger);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const g = ledger?.graded;
  const prime20 = g?.by_tier?.prime?.["20"];
  const uni20 = g?.universe?.["20"];
  const edge = prime20 && uni20 && prime20.n ? prime20.hit - uni20.hit : null;

  // States with enough graded samples to mean anything, biggest first.
  const states = useMemo(() => {
    if (!g) return [];
    return Object.entries(g.by_state)
      .filter(([, hz]) => (hz["20"]?.n ?? 0) >= 10)
      .sort((a, b) => (b[1]["20"]?.n ?? 0) - (a[1]["20"]?.n ?? 0));
  }, [g]);

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Ledger · Out-of-sample", "账本 · 样本外")}
        title={t("Ledger · The System Grades Itself", "实盘账本 · 系统给自己打分")}
        desc={t(
          "Every technical run logs each name's 4-week forward score, tier and timing state on that trading day. Once 5 / 10 / 20 trading days have passed, the pick is graded against what the price actually did — raw return and the excess over the same-day universe. The calibration that set the weights was in-sample; this is the running out-of-sample check. If prime setups stop beating the universe, the weights are stale: re-run the calibration.",
          "每次 technical 运行都会记录当天每只票的 4 周前瞻分、档位和时机状态。等过了 5 / 10 / 20 个交易日,再用真实走势给它打分——原始收益,以及相对当日universe的超额。定权重的校准是样本内的;这里是持续的样本外检验。如果“最佳设置”不再跑赢universe,说明权重过期了,该重跑校准。",
        )}
      />

      {!ledger || !g ? (
        <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-8 text-center text-[13px] text-muted">
          {t("No ledger yet — it starts with the next ", "还没有账本——下次运行 ")}
          <code className="font-mono text-signal">python -m newsagg.technical</code>
          {t(" run, and grades picks as they mature.", " 后开始记录,等持有期到了自动打分。")}
        </div>
      ) : (
        <>
          {/* headline tiles */}
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-line bg-panel2 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted2">{t("Days logged", "记录天数")}</div>
              <div className="mt-1 font-disp text-[26px] font-bold leading-none">{ledger.n_dates}</div>
              <div className="mt-1 text-[10.5px] text-muted2">{ledger.first_date} → {ledger.asof}</div>
            </div>
            <div className="rounded-xl border border-line bg-panel2 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted2">{t("Days graded (4w)", "已打分天数 (4 周)")}</div>
              <div className="mt-1 font-disp text-[26px] font-bold leading-none">{g.n_graded_dates}</div>
              <div className="mt-1 text-[10.5px] text-muted2">{t("picks need 20 trading days to mature", "需要 20 个交易日才能打分")}</div>
            </div>
            <div className="rounded-xl border p-4" style={{ borderColor: `${FORWARD_TIER.prime.color}55`, background: `${FORWARD_TIER.prime.color}0f` }}>
              <div className="text-[10px] uppercase tracking-wide text-muted2">{t("Prime · 4w hit rate", "最佳设置 · 4 周命中")}</div>
              <div className="mt-1 font-disp text-[26px] font-bold leading-none" style={{ color: FORWARD_TIER.prime.color }}>{prime20?.n ? p0(prime20.hit) : "—"}</div>
              <div className="mt-1 text-[10.5px] text-muted2">
                {prime20?.n ? `${t("excess", "超额")} ${pct(prime20.excess)} · n=${prime20.n}` : t("nothing matured yet", "还没有到期的样本")}
              </div>
            </div>
            <div className="rounded-xl border border-line bg-panel2 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted2">{t("Prime vs universe · 4w", "最佳 vs universe · 4 周")}</div>
              <div className="mt-1 font-disp text-[26px] font-bold leading-none" style={{ color: retColor(edge) }}>{edge == null ? "—" : `${edge >= 0 ? "+" : ""}${(100 * edge).toFixed(0)} pts`}</div>
              <div className="mt-1 text-[10.5px] text-muted2">{uni20?.n ? `${t("universe hit", "universe 命中")} ${p0(uni20.hit)} · ${pct(uni20.mean)}` : "—"}</div>
            </div>
          </div>

          {/* by tier */}
          <div className="mb-5 overflow-x-auto rounded-xl border border-line bg-panel2 p-4">
            <div className="mb-2 text-[13px] font-semibold">{t("By forward tier — hit rate · excess over the universe · n", "按前瞻档位 —— 命中率 · 相对universe超额 · 样本数")}</div>
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted2">
                  <th className="px-2 py-1.5">{t("tier", "档位")}</th>
                  {HORIZONS.map((h) => <th key={h.key} className="px-2 py-1.5 text-center">{lang === "zh" ? h.zh : h.en}</th>)}
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => {
                  const hz = g.by_tier[tier];
                  const meta = FORWARD_TIER[tier];
                  return (
                    <tr key={tier} className="border-t border-line/60">
                      <td className="px-2 py-2">
                        <span className="text-[12px] font-semibold" style={{ color: meta.color }}>{lang === "zh" ? meta.zh : meta.en}</span>
                      </td>
                      {HORIZONS.map((h) => <StatCell key={h.key} s={hz?.[h.key]} />)}
                    </tr>
                  );
                })}
                <tr className="border-t border-line">
                  <td className="px-2 py-2 text-[12px] font-semibold text-muted">{t("Universe (all logged)", "universe（全部记录）")}</td>
                  {HORIZONS.map((h) => <StatCell key={h.key} s={g.universe[h.key]} isUniverse />)}
                </tr>
              </tbody>
            </table>
            <div className="mt-2 text-[10.5px] text-muted2">
              {t(
                "Read: a tier earns its keep when its hit rate and excess sit above the universe row. Small n early on — don't over-read the first weeks.",
                "读法:某档位的命中率和超额都高于universe那一行,才算站得住。前几周样本少,别过度解读。",
              )}
            </div>
          </div>

          {/* by timing state */}
          {states.length > 0 && (
            <div className="mb-5 overflow-x-auto rounded-xl border border-line bg-panel2 p-4">
              <div className="mb-2 text-[13px] font-semibold">{t("By timing state (≥10 graded)", "按时机状态（≥10 个已打分）")}</div>
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted2">
                    <th className="px-2 py-1.5">{t("state", "状态")}</th>
                    {HORIZONS.map((h) => <th key={h.key} className="px-2 py-1.5 text-center">{lang === "zh" ? h.zh : h.en}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {states.map(([st, hz]) => {
                    const meta = TIMING_META[st as TechTiming["timing"]];
                    return (
                      <tr key={st} className="border-t border-line/60">
                        <td className="px-2 py-2 text-[12px] font-semibold text-muted">{meta ? (lang === "zh" ? meta.zh : meta.en) : st}</td>
                        {HORIZONS.map((h) => <StatCell key={h.key} s={hz[h.key]} />)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* recent prime / favourable picks */}
          <div className="overflow-x-auto rounded-xl border border-line bg-panel2 p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <div className="text-[13px] font-semibold">{t("Recent prime & favourable picks — what happened next", "最近的最佳/有利设置 —— 之后发生了什么")}</div>
              <div className="text-[10.5px] text-muted2">{t("raw return (excess vs same-day universe)", "原始收益（括号内为相对当日universe超额）")}</div>
            </div>
            {g.recent.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-muted2">{t("No matured picks yet.", "还没有到期的记录。")}</div>
            ) : (
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted2">
                    <th className="px-2 py-1.5">{t("date", "日期")}</th>
                    <th className="px-2 py-1.5">{t("ticker", "代码")}</th>
                    <th className="px-2 py-1.5">{t("score", "分数")}</th>
                    <th className="px-2 py-1.5">{t("state", "状态")}</th>
                    <th className="px-2 py-1.5 text-right">{t("entry", "入场价")}</th>
                    {HORIZONS.map((h) => <th key={h.key} className="px-2 py-1.5 text-right">{lang === "zh" ? h.zh : h.en}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {g.recent.slice(0, 120).map((r) => <RecentRow key={`${r.date}-${r.ticker}`} r={r} onOpen={openDetail} lang={lang} />)}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-4 text-[10.5px] leading-relaxed text-muted2">
            {t(
              "Grades the TECHNICAL 4-week score (the calibrated base) — the narrative bonuses aren't logged yet. Returns are close-to-close from the snapshot day, before costs; excess is vs the mean of every name logged that day.",
              "打分对象是**技术**4 周前瞻分(校准过的基础分)——叙事加分暂未记录。收益为快照日收盘到收盘、未扣成本;超额为相对当日全部记录票的均值。",
            )}
          </div>
        </>
      )}
    </div>
  );
}
