import { useStore } from "./store";
import { usePoller } from "./lib/usePoller";
import { TopBar } from "./sb/TopBar";
import { FunnelRail } from "./sb/FunnelRail";
import { Banner } from "./sb/Banner";
import { OverviewView } from "./sb/views/OverviewView";
import { SeedsView } from "./sb/views/SeedsView";
import { HeatView } from "./sb/views/HeatView";
import { ScreenView } from "./sb/views/ScreenView";
import { FocusView } from "./sb/views/FocusView";
import { CatalystView } from "./sb/views/CatalystView";
import { ShortlistView } from "./sb/views/ShortlistView";
import { ConvictionView } from "./sb/views/ConvictionView";
import { RankingView } from "./sb/views/RankingView";
import { TimingView } from "./sb/views/TimingView";
import { WarningView } from "./sb/views/WarningView";
import { LedgerView } from "./sb/views/LedgerView";
import { BacktestView } from "./sb/views/BacktestView";
import { StockDetail } from "./sb/views/StockDetail";

const VIEWS = {
  overview: OverviewView,
  seeds: SeedsView,
  heat: HeatView,
  screen: ScreenView,
  focus: FocusView,
  catalyst: CatalystView,
  shortlist: ShortlistView,
  conviction: ConvictionView,
  ranking: RankingView,
  timing: TimingView,
  warnings: WarningView,
  ledger: LedgerView,
  backtest: BacktestView,
} as const;

export default function App() {
  usePoller();
  const view = useStore((s) => s.view);
  const View = VIEWS[view];

  return (
    <div className="grid h-screen w-screen grid-cols-[264px_1fr] grid-rows-[56px_1fr] overflow-hidden">
      <TopBar />
      <FunnelRail />
      <main className="overflow-y-auto px-7 py-6">
        <Banner />
        <View />
      </main>
      <StockDetail />
    </div>
  );
}
