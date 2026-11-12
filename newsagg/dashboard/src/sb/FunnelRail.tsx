import { useStore } from "../store";
import { buildSeeds, buildScreen, buildRankings, buildFocus, buildCatalystRows, buildShortlist, buildConviction, buildConvictionRanking, buildTimingBoard, noDataSet, belowMinCap, TIMING_BUY_STATES, TIMING_SELL_STATES } from "./pipeline";
import { OVERVIEW, FUNNEL, FOCUS, RANKING, TIMING, WARNINGS, LEDGER, type NavStage } from "./nav";

// Funnel counts. Seeds + heat-ignition are real; the rest show "—" until
// their computations are wired.
function useCounts(): Record<string, number | null> {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const catalyst = useStore((s) => s.catalyst);
  const conviction = useStore((s) => s.conviction);
  const marketCaps = useStore((s) => s.marketCaps);
  // Exclude CONFIRMED no-data OTC/foreign ADRs (pending new seeds still count)
  // and micro-caps below the market-cap floor (e.g. PERF).
  const noData = noDataSet(technical);
  const tiny = belowMinCap(data, marketCaps);
  const seeds = buildSeeds(data).filter((r) => !noData.has(r.ticker) && !tiny.has(r.ticker));

  // Stage 2 advances the union of every ranking lens's top-N (+ mega caps).
  let heatCount: number | null = null;
  if (heat || technical) {
    heatCount = buildRankings(data, heat, technical, marketCaps).advancing.size;
  }

  const screenCount =
    heat || technical ? buildScreen(data, heat, marketCaps, technical).candidates.length : null;

  const focus =
    technical || supplychain
      ? buildFocus(data, heat, technical, marketCaps, sectors, supplychain)
      : [];
  const focusCount = technical || supplychain ? focus.length : null;

  // Catalyst = Focus names whose strongest catalyst clears the bar (advancing).
  const catalystCount = catalyst
    ? buildCatalystRows(focus, catalyst).filter((r) => r.status === "advance").length
    : null;

  // Shortlist = Tier 1 + Tier 2 (names meeting ≥2 of the three conditions).
  const shortlist =
    technical || supplychain ? buildShortlist(focus, catalyst) : [];
  const shortlistCount = technical || supplychain ? shortlist.filter((r) => r.tier <= 2).length : null;

  // Conviction = Shortlist survivors whose management-tone read backs the thesis.
  const convRows = conviction ? buildConviction(shortlist, conviction) : [];
  const convictionCount = conviction ? convRows.filter((r) => r.status === "advance").length : null;

  // Composite Rank = Tier-1/2 names past Conviction 6 (the synthesis universe).
  const rankingCount = conviction ? buildConvictionRanking(convRows).length : null;

  // Buy Timing = vetted names that are an ACTIONABLE buy right now; Warnings =
  // vetted names flashing a de-risk (MA20 breakdown) signal.
  const timingBoard = technical ? buildTimingBoard(shortlist, technical) : [];
  const timingCount = technical ? timingBoard.filter((r) => TIMING_BUY_STATES.includes(r.timing.timing)).length : null;
  const warningsCount = technical ? timingBoard.filter((r) => TIMING_SELL_STATES.includes(r.timing.timing)).length : null;

  return {
    seeds: seeds.length,
    heat: heatCount,
    screen: screenCount,
    focus: focusCount,
    catalyst: catalystCount,
    shortlist: shortlistCount,
    conviction: convictionCount,
    ranking: rankingCount,
    timing: timingCount,
    warnings: warningsCount,
  };
}

function NavRow({
  stage,
  count,
  branch,
}: {
  stage: NavStage;
  count: number | null;
  branch?: boolean; // a parallel branch that shares the step number of the row above
}) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const lang = useStore((s) => s.lang);
  const active = view === stage.key;
  const primary = lang === "zh" ? stage.zh : stage.en;
  // Subtitle follows the selected language — only the descriptive hint, never a
  // cross-language echo of the name (that showed Chinese in English mode).
  const hint = stage.hint ? (lang === "zh" ? stage.hint.zh : stage.hint.en) : "";
  return (
    <button
      onClick={() => setView(stage.key)}
      className={`relative flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors ${
        active ? "text-text" : "text-muted hover:bg-[#0E141D] hover:text-text"
      }`}
    >
      {active && <span className="absolute left-0 h-6 w-[3px] rounded-r bg-signal" />}
      {stage.step != null &&
        (branch ? (
          // parallel branch: a dot connected up to the numbered row above it
          <span className="relative grid h-5 w-5 flex-none place-items-center">
            <span className="absolute left-1/2 bottom-1/2 h-[18px] w-px -translate-x-1/2 bg-line2" />
            <span className={`z-[1] h-2 w-2 rounded-full ${active ? "bg-signal" : "border border-line2 bg-panel2"}`} />
          </span>
        ) : (
          <span
            className={`grid h-5 w-5 flex-none place-items-center rounded-full border text-[10px] font-semibold transition-colors ${
              active ? "border-signal bg-signal text-ink" : "border-line2 text-muted2"
            }`}
          >
            {stage.step}
          </span>
        ))}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{primary}</span>
        {hint && <span className="block text-[10px] text-muted2">{hint}</span>}
      </span>
      <span className="font-mono text-[13px] font-semibold text-text">
        {/* overview is a landing page, not a counted stage → no "—" */}
        {stage.key === "overview" ? null : count == null ? <span className="text-muted2">—</span> : count}
      </span>
    </button>
  );
}

export function FunnelRail() {
  const counts = useCounts();
  const lang = useStore((s) => s.lang);
  const ledger = useStore((s) => s.ledger);
  return (
    <aside className="relative overflow-y-auto border-r border-line bg-panel2 py-4">
      <div className="relative">
        <NavRow stage={OVERVIEW} count={null} />
      </div>

      <div className="px-5 pb-2 pt-4 text-[10.5px] uppercase tracking-[0.14em] text-muted2">
        {lang === "zh" ? "发现漏斗 · Funnel" : "Discovery Funnel"}
      </div>
      {FUNNEL.map((s, i) => (
        <div key={s.key} className="relative">
          {/* a stage that repeats the previous stage's number is a parallel branch */}
          <NavRow stage={s} count={counts[s.key]} branch={i > 0 && FUNNEL[i - 1].step === s.step} />
          {/* the synthesized step-2 output sits right after the Heat/Screen pair */}
          {s.key === "screen" && (
            <div className="relative bg-gradient-to-r from-signal/[0.06] to-transparent">
              <NavRow stage={FOCUS} count={counts.focus} />
            </div>
          )}
          {/* the Conviction-gate synthesis + the final buy-timing layer sit right
              after the Conviction stage; the ledger (the system grading its own
              picks) closes the loop underneath them */}
          {s.key === "conviction" && (
            <>
              <div className="relative bg-gradient-to-r from-signal/[0.06] to-transparent">
                <NavRow stage={RANKING} count={counts.ranking} />
              </div>
              <div className="relative bg-gradient-to-r from-signal/[0.06] to-transparent">
                <NavRow stage={TIMING} count={counts.timing} />
              </div>
              <div className="relative bg-gradient-to-r from-[#ff6b81]/[0.06] to-transparent">
                <NavRow stage={WARNINGS} count={counts.warnings} />
              </div>
              <div className="relative bg-gradient-to-r from-[#c99bf0]/[0.06] to-transparent">
                <NavRow stage={LEDGER} count={ledger ? ledger.n_dates : null} />
              </div>
            </>
          )}
        </div>
      ))}
    </aside>
  );
}
