import { create } from "zustand";
import type { CatalystData, ConvictionData, HeatData, Health, HomeWidget, LedgerData, MarketCaps, PriceTrack, SAData, TechnicalData, SectorData, SupplyChainData } from "./types";

export type ConnStatus = "connecting" | "live" | "stale" | "error";
export type Lang = "en" | "zh";

export type ViewKey =
  | "overview"
  | "seeds"
  | "heat"
  | "screen"
  | "focus"
  | "catalyst"
  | "shortlist"
  | "conviction"
  | "ranking"
  | "timing"
  | "warnings"
  | "ledger"
  | "backtest";

interface DashboardState {
  data: SAData | null;
  heat: HeatData | null;
  technical: TechnicalData | null;
  sectors: SectorData | null;
  supplychain: SupplyChainData | null;
  catalyst: CatalystData | null;
  catalystData: CatalystData | null; // no-LLM signals (earnings date + recent news)
  conviction: ConvictionData | null;
  track: PriceTrack | null;
  history: PriceTrack | null; // dated 1y closes per ticker (tracker)
  ledger: LedgerData | null; // live hit-rate ledger (the system grading itself)
  marketCaps: MarketCaps | null;
  health: Health | null;
  status: ConnStatus;
  lastUpdated: number | null; // epoch ms of last successful fetch
  view: ViewKey; // active view in the funnel
  ticker: string; // focused ticker (search / row click)
  detail: string | null; // ticker whose full detail page is open (overlay)
  lang: Lang; // UI language (default English)
  setData: (d: SAData) => void;
  setHeat: (h: HeatData | null) => void;
  setTechnical: (t: TechnicalData | null) => void;
  setSectors: (s: SectorData | null) => void;
  setSupplychain: (s: SupplyChainData | null) => void;
  setCatalyst: (c: CatalystData | null) => void;
  setCatalystData: (c: CatalystData | null) => void;
  setConviction: (c: ConvictionData | null) => void;
  setTrack: (t: PriceTrack | null) => void;
  setHistory: (h: PriceTrack | null) => void;
  setLedger: (l: LedgerData | null) => void;
  setMarketCaps: (m: MarketCaps | null) => void;
  setHealth: (h: Health | null) => void;
  setStatus: (s: ConnStatus) => void;
  setView: (v: ViewKey) => void;
  setTicker: (t: string) => void;
  openDetail: (t: string) => void;
  closeDetail: () => void;
  toggleLang: () => void;
}

export const useStore = create<DashboardState>((set) => ({
  data: null,
  heat: null,
  technical: null,
  sectors: null,
  supplychain: null,
  catalyst: null,
  catalystData: null,
  conviction: null,
  track: null,
  history: null,
  ledger: null,
  marketCaps: null,
  health: null,
  status: "connecting",
  lastUpdated: null,
  view: "overview",
  ticker: "",
  detail: null,
  lang: "en",
  setData: (d) => set({ data: d, status: "live", lastUpdated: Date.now() }),
  setHeat: (h) => set({ heat: h }),
  setTechnical: (t) => set({ technical: t }),
  setSectors: (s) => set({ sectors: s }),
  setSupplychain: (s) => set({ supplychain: s }),
  setCatalyst: (c) => set({ catalyst: c }),
  setCatalystData: (c) => set({ catalystData: c }),
  setConviction: (c) => set({ conviction: c }),
  setTrack: (t) => set({ track: t }),
  setHistory: (h) => set({ history: h }),
  setLedger: (l) => set({ ledger: l }),
  setMarketCaps: (m) => set({ marketCaps: m }),
  setHealth: (h) => set({ health: h }),
  setStatus: (s) => set({ status: s }),
  setView: (v) => set({ view: v }),
  setTicker: (t) => set({ ticker: t.toUpperCase().replace(/[^A-Z.:-]/g, "") }),
  openDetail: (t) => set({ detail: t.toUpperCase().replace(/[^A-Z.:-]/g, "") }),
  closeDetail: () => set({ detail: null }),
  toggleLang: () => set((s) => ({ lang: s.lang === "en" ? "zh" : "en" })),
}));

// i18n helper: `const t = useT(); t("English", "中文")`. Default is English.
export const useT = () => {
  const lang = useStore((s) => s.lang);
  return (en: string, zh: string) => (lang === "zh" ? zh : en);
};

// Stable empty reference: selectors must NOT return a fresh `?? []` each call,
// or useSyncExternalStore sees a new snapshot every render → infinite loop.
const EMPTY_WIDGETS: HomeWidget[] = [];
export const useWidgets = (): HomeWidget[] =>
  useStore((s) => s.data?.home_widgets ?? EMPTY_WIDGETS);
