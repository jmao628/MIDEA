import { useEffect, useState } from "react";
import { useStore, type ConnStatus } from "../store";

const STATUS: Record<ConnStatus, { label: string; color: string }> = {
  connecting: { label: "CONNECTING", color: "#e7b84c" },
  live: { label: "LIVE", color: "#5bc48c" },
  stale: { label: "STALE", color: "#f2a73c" },
  error: { label: "NO DATA", color: "#e5636b" },
};

export function TopBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const status = useStore((s) => s.status);
  const generatedAt = useStore((s) => s.data?.generated_at ?? null);
  const ticker = useStore((s) => s.ticker);
  const setTicker = useStore((s) => s.setTicker);
  const setView = useStore((s) => s.setView);
  const openDetail = useStore((s) => s.openDetail);
  const closeDetail = useStore((s) => s.closeDetail);
  const lang = useStore((s) => s.lang);
  const toggleLang = useStore((s) => s.toggleLang);
  const meta = STATUS[status];

  const goHome = () => {
    closeDetail();
    setView("overview");
  };
  const submitSearch = () => {
    const t = ticker.trim();
    if (t) openDetail(t);
  };

  const runDate = generatedAt
    ? new Date(generatedAt).toLocaleDateString("en-CA")
    : now.toLocaleDateString("en-CA");

  return (
    <div className="col-span-2 flex items-center gap-4 border-b border-line bg-[linear-gradient(180deg,#0E141D,#0A0E15)] px-5">
      <button
        onClick={goHome}
        title="回到发现总览"
        className="-ml-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-white/[0.04]"
      >
        <span className="midea-word font-disp text-[19px] font-semibold tracking-[0.34em]">
          MIDEA
        </span>
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-1.5 focus-within:border-signal/50">
        <span className="text-muted2">⌕</span>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitSearch()}
          placeholder={lang === "zh" ? "搜代码 ↵" : "Ticker ↵"}
          spellCheck={false}
          className="w-28 bg-transparent font-mono text-[13px] uppercase text-text outline-none placeholder:normal-case placeholder:text-muted2"
        />
      </div>

      <button
        onClick={toggleLang}
        title="Language / 语言"
        className="flex overflow-hidden rounded-lg border border-line text-[11px] font-semibold"
      >
        <span className={`px-2 py-1.5 transition-colors ${lang === "en" ? "bg-signal/15 text-signal" : "text-muted2"}`}>
          EN
        </span>
        <span className={`px-2 py-1.5 transition-colors ${lang === "zh" ? "bg-signal/15 text-signal" : "text-muted2"}`}>
          中
        </span>
      </button>

      <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 font-mono text-[12px] text-muted">
        RUN <b className="text-text">{runDate}</b>
      </div>

      <div
        className="flex items-center gap-1.5 font-mono text-[11px] font-semibold"
        style={{ color: meta.color }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
        {meta.label}
        <span className="ml-1 tabular-nums text-muted">{now.toLocaleTimeString([], { hour12: false })}</span>
      </div>
    </div>
  );
}
