import type { ViewKey } from "../store";

// The funnel's backbone. Step 2 is a *parallel pair*, not a sequence: Heat
// (attention net) and Screen (quality net) are two independent lenses over the
// same seed pool — later stages take names that clear both. They share step 2.
export interface NavStage {
  key: ViewKey;
  step: number | null; // funnel step number (null for overview/candidates)
  en: string;
  zh: string;
  hint?: { en: string; zh: string }; // small tag, e.g. which lens a parallel branch is
}

export const OVERVIEW: NavStage = { key: "overview", step: null, en: "Discovery Run", zh: "发现总览" };

export const FUNNEL: NavStage[] = [
  { key: "seeds", step: 1, en: "Seed Table", zh: "看多种子表" },
  { key: "heat", step: 2, en: "Heat Ignition", zh: "热度点火", hint: { en: "attention · vol+social", zh: "被关注 · 量价+社交" } },
  { key: "screen", step: 2, en: "Screen", zh: "发现筛选", hint: { en: "quality · rating+thesis", zh: "质量 · 评分+论点" } },
  { key: "catalyst", step: 3, en: "Catalyst TPMN", zh: "催化剂 TPMN" },
  { key: "shortlist", step: 4, en: "Shortlist", zh: "登顶广度", hint: { en: "top across 3 lenses", zh: "三维登顶 · 交集精选" } },
  { key: "conviction", step: 5, en: "Conviction", zh: "管理层语气" },
];

// The synthesized output of step 2 — strong-buy × ecosystem, the shortlist that
// carries into the deeper stages. Rendered as a highlighted output node.
export const FOCUS: NavStage = {
  key: "focus",
  step: null,
  en: "Focus List",
  zh: "重点名单",
  hint: { en: "strong-buy × ecosystem", zh: "强买 × 生态 · 交集" },
};

// The synthesis at the Conviction gate — Tier-1/2 names past Conviction 6,
// ranked by conviction. The funnel's terminal output node.
export const RANKING: NavStage = {
  key: "ranking",
  step: null,
  en: "Composite Rank",
  zh: "综合排行",
  hint: { en: "Tier-1/2 · conviction > 6", zh: "金/银档 · 语气 > 6" },
};

// The entry-timing layer — a buy-only Bollinger+MACD overlay on the ranked
// names, answering "of the good companies, which is a buy right NOW". Sits after
// Composite Rank as the funnel's final, actionable output node.
export const TIMING: NavStage = {
  key: "timing",
  step: null,
  en: "Buy Timing",
  zh: "择时买点",
  hint: { en: "Bollinger + MACD · buy points now", zh: "布林带 + MACD · 当前买点" },
};

// The sell/de-risk companion to Buy Timing — vetted holdings breaking DOWN
// through the MA20 with momentum falling. A warning to trim, never a hard exit.
export const WARNINGS: NavStage = {
  key: "warnings",
  step: null,
  en: "Risk · De-risk",
  zh: "减仓预警",
  hint: { en: "MA20 breakdown · trim warnings", zh: "跌破 MA20 · 减仓提示" },
};

// The live hit-rate ledger — every day's forward-score picks, graded against
// what actually happened 5/10/20 days later. The out-of-sample check on the
// calibrated weights: the system grading itself.
export const LEDGER: NavStage = {
  key: "ledger",
  step: null,
  en: "Ledger",
  zh: "实盘账本",
  hint: { en: "the system grades itself", zh: "系统给自己打分" },
};

// A standalone tool (not a funnel stage): backtest entry/exit points over the
// price history and tune the rules.
export const BACKTEST: NavStage = {
  key: "backtest",
  step: null,
  en: "Tracker",
  zh: "组合跟踪",
  hint: { en: "your basket since Day 1", zh: "自选组合 · 自 Day 1" },
};
