import type { ReactNode } from "react";
import { useT, useStore } from "../store";
import type { TechTiming } from "../types";
import { TIMING_META, SIGNAL_META, FORWARD_TIER, forwardTier } from "./pipeline";

// 0-4 week forward-score pill: the score plus its tier word. Tone by tier —
// green = prime setup, teal = favourable, amber = neutral, slate = wait. Shared
// by the Buy-Timing board, the leaderboard and the detail page.
export function ForwardBadge({ score, size = "sm" }: { score: number | null | undefined; size?: "sm" | "md" | "lg" }) {
  const lang = useStore((s) => s.lang);
  if (score == null) return null;
  const meta = FORWARD_TIER[forwardTier(score)];
  const pad = size === "lg" ? "px-2.5 py-1 text-[13px]" : size === "md" ? "px-2 py-0.5 text-[11.5px]" : "px-1.5 py-[1px] text-[9.5px]";
  return (
    <span
      title={lang === "zh" ? meta.hint.zh : meta.hint.en}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded font-semibold uppercase tracking-wide ${pad}`}
      style={{ color: meta.color, background: `${meta.color}1f`, border: `1px solid ${meta.color}66` }}
    >
      <span className="tabular-nums">{Math.round(score)}</span>
      <span className="opacity-80">{lang === "zh" ? meta.zh : meta.en}</span>
    </span>
  );
}

// Entry-timing badge (Bollinger+MACD state). Green = buy now, amber = wait,
// violet = hot/overheated, slate = idle. Shared by the leaderboard + detail.
const TIMING_TONE: Record<"buy" | "watch" | "hot" | "idle" | "sell" | "trim", { fg: string; bg: string; bd: string }> = {
  buy: { fg: "#5fe3a1", bg: "rgba(72,199,142,0.14)", bd: "rgba(72,199,142,0.45)" },
  watch: { fg: "#f0c862", bg: "rgba(240,200,98,0.12)", bd: "rgba(240,200,98,0.4)" },
  hot: { fg: "#c99bf0", bg: "rgba(201,155,240,0.12)", bd: "rgba(201,155,240,0.4)" },
  idle: { fg: "#7f8f9e", bg: "transparent", bd: "var(--line,#22303c)" },
  sell: { fg: "#ff6b81", bg: "rgba(255,90,120,0.14)", bd: "rgba(255,90,120,0.45)" },
  trim: { fg: "#e8935f", bg: "rgba(224,120,90,0.13)", bd: "rgba(224,120,90,0.42)" },
};

export function TimingBadge({ timing, size = "sm" }: { timing: TechTiming | null | undefined; size?: "sm" | "md" }) {
  const lang = useStore((s) => s.lang);
  if (!timing) return null;
  const meta = TIMING_META[timing.timing];
  const tone = TIMING_TONE[meta.tone];
  const label = lang === "zh" ? meta.zh : meta.en;
  const hint = lang === "zh" ? meta.hint.zh : meta.hint.en;
  const pad = size === "md" ? "px-2 py-0.5 text-[11.5px]" : "px-1.5 py-[1px] text-[9.5px]";
  return (
    <span
      title={`${hint} · score ${timing.score}${timing.divergence ? " · RSI divergence" : ""}${timing.squeeze ? " · squeeze" : ""}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded font-semibold uppercase tracking-wide ${pad}`}
      style={{ color: tone.fg, background: tone.bg, border: `1px solid ${tone.bd}` }}
    >
      {(meta.tone === "buy" || meta.tone === "sell" || meta.tone === "trim") && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {label}
      {timing.timing !== "neutral" && <span className="tabular-nums opacity-70">{timing.score}</span>}
    </span>
  );
}

// The evidence chips behind a timing state — "why it's a buy" (broke lower band,
// MACD turned, RSI divergence, …). Reads the `signals` codes off the timing.
const SIGNAL_TONE: Record<"buy" | "hot" | "info" | "sell", { fg: string; bd: string }> = {
  buy: { fg: "#5fe3a1", bd: "rgba(72,199,142,0.4)" },
  hot: { fg: "#c99bf0", bd: "rgba(201,155,240,0.38)" },
  info: { fg: "#7fb6e6", bd: "rgba(95,176,232,0.35)" },
  sell: { fg: "#ff6b81", bd: "rgba(255,90,120,0.4)" },
};

export function SignalChips({ signals, max, lang: langProp }: { signals: string[] | undefined; max?: number; lang?: "en" | "zh" }) {
  const storeLang = useStore((s) => s.lang);
  const lang = langProp ?? storeLang;
  if (!signals || signals.length === 0) return null;
  const list = max ? signals.slice(0, max) : signals;
  const extra = max && signals.length > max ? signals.length - max : 0;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {list.map((code) => {
        const m = SIGNAL_META[code];
        if (!m) return null;
        const tone = SIGNAL_TONE[m.tone];
        return (
          <span
            key={code}
            className="inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-[1px] text-[9.5px] font-medium"
            style={{ color: tone.fg, border: `1px solid ${tone.bd}`, background: `${tone.fg}12` }}
          >
            {lang === "zh" ? m.zh : m.en}
          </span>
        );
      })}
      {extra > 0 && <span className="text-[9.5px] text-muted2">+{extra}</span>}
    </div>
  );
}

export function ViewHead({
  eyebrow,
  title,
  desc,
  actions,
}: {
  eyebrow: string;
  title: string;
  desc?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-signal">
          {eyebrow}
        </div>
        <h2 className="font-disp text-[22px] font-semibold tracking-tight">{title}</h2>
        {desc && <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  sub,
  right,
  pad0,
  children,
}: {
  title?: string;
  sub?: string;
  right?: ReactNode;
  pad0?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-line bg-panel ${pad0 ? "overflow-hidden" : "p-[18px]"}`}>
      {title && (
        <div
          className={`flex items-center justify-between ${pad0 ? "border-b border-line px-[18px] py-4" : "mb-3.5"}`}
        >
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {sub && <span className="text-[11px] text-muted2">{sub}</span>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatStrip({
  stats,
}: {
  stats: { k: string; v: ReactNode; d?: string; color?: string }[];
}) {
  return (
    <div className="mb-[18px] grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
      {stats.map((s) => (
        <div key={s.k} className="rounded-[11px] border border-line bg-panel px-4 py-3.5">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted2">{s.k}</div>
          <div className="font-disp text-[26px] font-semibold leading-none" style={{ color: s.color }}>
            {s.v}
          </div>
          {s.d && <div className="mt-1.5 text-[11.5px] text-muted">{s.d}</div>}
        </div>
      ))}
    </div>
  );
}

const CHIP_CLS: Record<string, string> = {
  dead: "text-dead border-dead/40 bg-dead/10",
  ignite: "text-ignite border-ignite/45 bg-ignite/10",
  detonate: "text-detonate border-detonate/45 bg-detonate/10",
  ultralow: "text-muted2 border-line bg-inset",
  ok: "text-ok border-ok/40 bg-ok/10",
  wait: "text-muted2 border-line bg-inset",
  no: "text-bad border-bad/40 bg-bad/10",
  signal: "text-signal border-signal/40 bg-signal/10",
  gold: "text-gold border-gold/40 bg-gold/10",
};

export function Chip({ kind, children }: { kind: keyof typeof CHIP_CLS; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${CHIP_CLS[kind]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

// Honest placeholder for a pipeline stage whose computation isn't wired yet.
export function Pending({ title, needs }: { title: string; needs: string[] }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-dashed border-line2 bg-panel2 p-6">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-gold">
        <span>◷</span> {title}
      </div>
      <div className="mb-3 text-[12.5px] text-muted">
        {t("Structure is in place — fills in automatically once these are wired:", "结构已就位，等下面这些接入后自动填充：")}
      </div>
      <ul className="space-y-1.5">
        {needs.map((n, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] text-muted">
            <span className="text-muted2">›</span>
            <span>{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TickerCell({ ticker, company }: { ticker: string; company?: string }) {
  return (
    <div>
      <div className="font-mono text-[13px] font-semibold text-signal">{ticker}</div>
      {company && <div className="text-[11px] text-muted">{company}</div>}
    </div>
  );
}
