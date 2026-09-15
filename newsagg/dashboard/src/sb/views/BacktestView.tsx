import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useT } from "../../store";
import { buildFocus, buildShortlist, sectorLabel } from "../pipeline";
import { buildBasket, type Basket } from "../tracker";
import { ViewHead } from "../ui";

const GOOD = "#48c78e";
const BAD = "#e0785a";
const TIER_COLOR: Record<1 | 2 | 3, string> = { 1: "#f0c862", 2: "#cdd6e2", 3: "#cd8b5e" };
const pctS = (v: number | null | undefined, d = 1): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const retColor = (v: number | null | undefined): string => (v == null ? "var(--muted2)" : v >= 0 ? GOOD : BAD);

const todayISO = (): string => new Date().toISOString().slice(0, 10);
const LIST_KEY = "midea.track.list.v1";
const DAY1_KEY = "midea.track.day1.v1";
function loadList(): string[] {
  try {
    const s = localStorage.getItem(LIST_KEY);
    if (s) return JSON.parse(s) as string[];
  } catch {
    /* ignore */
  }
  return [];
}
function loadDay1(): string {
  try {
    return localStorage.getItem(DAY1_KEY) || todayISO();
  } catch {
    return todayISO();
  }
}

function Tile({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel2 px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-wide text-muted2">{label}</div>
      <div className="mt-1 font-disp text-[22px] font-bold leading-none tabular-nums" style={{ color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div className="mt-1 truncate text-[10px] text-muted2">{sub}</div>}
    </div>
  );
}

function Spark({ c, up }: { c: number[]; up: boolean }) {
  if (!c || c.length < 2) return null;
  const min = Math.min(...c);
  const max = Math.max(...c);
  const pts = c.map((v, i) => `${((i / (c.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / (max - min || 1)) * 26).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-6 w-24">
      <polyline points={pts} fill="none" stroke={up ? GOOD : BAD} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Basket value curve, 1.0 at Day 1.
function BasketCurve({ curve, sig }: { curve: Basket["curve"]; sig: string }) {
  if (curve.length < 2) return <div className="grid h-52 place-items-center text-[12px] text-muted2">not enough days yet — the basket curve grows daily</div>;
  const W = 100, H = 100;
  const vals = curve.map((c) => c.v);
  const min = Math.min(...vals, 1);
  const max = Math.max(...vals, 1);
  const x = (i: number) => (i / (curve.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * H;
  const pts = curve.map((c, i) => `${x(i).toFixed(2)},${y(c.v).toFixed(2)}`);
  const up = vals[vals.length - 1] >= 1;
  const col = up ? GOOD : BAD;
  const area = `M${x(0)},${H} L` + pts.join(" L") + ` L${x(curve.length - 1)},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-52 w-full">
      <defs>
        <linearGradient id="bkg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={col} stopOpacity="0.22" />
          <stop offset="1" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={y(1)} x2={W} y2={y(1)} stroke="var(--line2,#2b3a48)" strokeWidth="0.5" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <path d={area} fill="url(#bkg)" />
      <path key={sig} d={"M" + pts.join(" L")} className="bt-draw" fill="none" stroke={col} strokeWidth="1.6" pathLength={1} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function BacktestView() {
  const data = useStore((s) => s.data);
  const heat = useStore((s) => s.heat);
  const technical = useStore((s) => s.technical);
  const sectors = useStore((s) => s.sectors);
  const supplychain = useStore((s) => s.supplychain);
  const marketCaps = useStore((s) => s.marketCaps);
  const catalyst = useStore((s) => s.catalyst);
  const history = useStore((s) => s.history);
  const openDetail = useStore((s) => s.openDetail);
  const lang = useStore((s) => s.lang);
  const t = useT();

  const [myList, setMyList] = useState<string[]>(loadList);
  const [day1, setDay1] = useState<string>(loadDay1);
  const [q, setQ] = useState("");

  // The shortlisted pool — every name that reached the Shortlist (all tiers).
  const shortlist = useMemo(() => {
    const focus = buildFocus(data, heat, technical, marketCaps, sectors, supplychain);
    return buildShortlist(focus, catalyst);
  }, [data, heat, technical, marketCaps, sectors, supplychain, catalyst]);

  const inList = useMemo(() => new Set(myList), [myList]);
  const pool = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return shortlist.filter((r) => !needle || r.ticker.includes(needle) || (r.company || "").toUpperCase().includes(needle));
  }, [shortlist, q]);

  const basket = useMemo(() => buildBasket(history, myList, day1), [history, myList, day1]);
  const sig = `${day1}|${myList.join(",")}|${basket.curve.length}`;

  // Persist + sync the list with the server (so the daily jobs price these names).
  const loaded = useRef(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/watchlist")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && Array.isArray(j.tickers) && j.tickers.length) setMyList(j.tickers as string[]);
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(myList));
    } catch {
      /* ignore */
    }
    if (!loaded.current) return;
    const id = setTimeout(() => {
      fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: myList }) }).catch(() => {});
    }, 800);
    return () => clearTimeout(id);
  }, [myList]);
  useEffect(() => {
    try {
      localStorage.setItem(DAY1_KEY, day1);
    } catch {
      /* ignore */
    }
  }, [day1]);

  const add = (tk: string) => {
    const s = tk.trim().toUpperCase();
    if (s && !myList.includes(s)) setMyList((l) => [...l, s]);
  };
  const remove = (tk: string) => setMyList((l) => l.filter((x) => x !== tk));

  const pickRows = [...basket.picks].sort((a, b) => (b.ret ?? -Infinity) - (a.ret ?? -Infinity));

  return (
    <div className="view-in">
      <ViewHead
        eyebrow={t("Lab · Tracker", "实验室 · 组合跟踪")}
        title={t("Portfolio Tracker · Returns Since Day 1", "组合跟踪 · 自 Day 1 的收益")}
        desc={t(
          "Drag names from the shortlisted pool into your basket, set a Day 1, and track each stock's and the equal-weight basket's return since then. Prices are kept and refreshed by the daily jobs, so the record keeps growing.",
          "从登顶名单里把票拖进你的组合,设一个 Day 1,就能跟踪每只票、以及等权组合自那天起的收益。价格由每日任务保留并刷新,记录持续增长。",
        )}
      />

      {/* Day 1 + basket summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-line bg-panel2 px-3.5 py-3">
          <div className="text-[10px] uppercase tracking-wide text-muted2">{t("Day 1", "起始日")}</div>
          <input
            type="date"
            value={day1}
            min={basket.minDate ?? undefined}
            max={todayISO()}
            onChange={(e) => setDay1(e.target.value || todayISO())}
            className="mt-1 w-full bg-transparent font-mono text-[13px] text-text focus:outline-none"
            style={{ colorScheme: "dark" }}
          />
        </div>
        <Tile label={t("Basket return", "组合收益")} value={pctS(basket.ret)} color={retColor(basket.ret)} sub={t(`${basket.covered} tracked · ${basket.days}d`, `${basket.covered} 只 · ${basket.days} 天`)} />
        <Tile label={t("Best", "最强")} value={basket.best ? `${basket.best.ticker} ${pctS(basket.best.ret)}` : "—"} color={GOOD} />
        <Tile label={t("Worst", "最弱")} value={basket.worst ? `${basket.worst.ticker} ${pctS(basket.worst.ret)}` : "—"} color={BAD} />
        <Tile label={t("Names", "只数")} value={String(myList.length)} sub={basket.covered < myList.length ? t(`${myList.length - basket.covered} pending data`, `${myList.length - basket.covered} 只待数据`) : t("all priced", "均有价格")} />
        <Tile label={t("Since", "自")} value={basket.days ? `${basket.days}d` : "—"} sub={day1} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Shortlisted pool */}
        <div className="rounded-2xl border border-line bg-panel p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] font-semibold">{t("Shortlisted", "登顶名单")}</span>
            <span className="font-mono text-[11px] text-muted2">{shortlist.length}</span>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search ticker / name…", "搜代码 / 名称…")}
            className="mb-2 w-full rounded-lg border border-line bg-inset px-2.5 py-1.5 text-[12px] text-text placeholder:text-muted2 focus:border-signal/60 focus:outline-none"
          />
          <div className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
            {pool.slice(0, 400).map((r) => {
              const on = inList.has(r.ticker);
              return (
                <div
                  key={r.ticker}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", r.ticker)}
                  onClick={() => (on ? remove(r.ticker) : add(r.ticker))}
                  className={`flex cursor-grab items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors active:cursor-grabbing ${on ? "border-signal/40 bg-signal/[0.07]" : "border-line hover:border-line2 hover:bg-white/[0.02]"}`}
                  title={t("drag into your basket, or click to add", "拖进组合,或点击加入")}
                >
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: TIER_COLOR[r.tier] }} title={`Tier ${r.tier}`} />
                  <span className="font-disp text-[13px] font-bold text-text">{r.ticker}</span>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted2">{r.company || "—"}{r.sector ? ` · ${sectorLabel(r.sector, lang)}` : ""}</span>
                  <span className="flex-none text-[13px]" style={{ color: on ? GOOD : "var(--muted2)" }}>{on ? "✓" : "+"}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* My basket + curve */}
        <div className="space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              add(e.dataTransfer.getData("text/plain"));
            }}
            className="rounded-2xl border border-dashed border-line2 bg-panel p-3"
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold">{t("My basket", "我的组合")}</span>
              {myList.length > 0 && <button onClick={() => setMyList([])} className="text-[11px] text-muted2 hover:text-text">{t("clear", "清空")}</button>}
            </div>
            {myList.length === 0 ? (
              <div className="grid h-24 place-items-center text-center text-[12px] text-muted2">{t("Drag names here (or click one on the left) to start your basket.", "把票拖到这里(或点左边)开始你的组合。")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-muted2">
                      <th className="py-1.5 text-left font-medium">{t("Ticker", "标的")}</th>
                      <th className="px-2 text-right font-medium">{t("Day 1", "起始价")}</th>
                      <th className="px-2 text-right font-medium">{t("Now", "现价")}</th>
                      <th className="px-2 text-right font-medium">{t("Return", "收益")}</th>
                      <th className="px-2 text-right font-medium">{t("Since Day 1", "自 Day 1")}</th>
                      <th className="px-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pickRows.map((p) => (
                      <tr key={p.ticker} className="border-t border-line/60">
                        <td className="py-1.5">
                          <button onClick={() => openDetail(p.ticker)} className="font-disp font-bold text-text hover:text-signal">{p.ticker}</button>
                        </td>
                        <td className="px-2 text-right tabular-nums text-muted2">{p.day1Close != null ? p.day1Close.toFixed(2) : "—"}</td>
                        <td className="px-2 text-right tabular-nums text-muted">{p.nowClose != null ? p.nowClose.toFixed(2) : "—"}</td>
                        <td className="px-2 text-right font-semibold tabular-nums" style={{ color: retColor(p.ret) }}>{p.has ? pctS(p.ret) : t("pending", "待数据")}</td>
                        <td className="px-2"><div className="flex justify-end">{p.spark.length > 1 ? <Spark c={p.spark} up={(p.ret ?? 0) >= 0} /> : null}</div></td>
                        <td className="px-1 text-right"><button onClick={() => remove(p.ticker)} className="text-muted2 hover:text-[#e0785a]" title={t("remove", "移除")}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold">{t("Basket value since Day 1", "组合净值 · 自 Day 1")}</span>
              <span className="font-mono text-[11px]" style={{ color: retColor(basket.ret) }}>{pctS(basket.ret)}</span>
            </div>
            <BasketCurve curve={basket.curve} sig={sig} />
          </div>

          <p className="text-[11px] leading-relaxed text-muted2">
            {t(
              "Equal-weight buy-&-hold from Day 1 (no stop / target / holding limit). If a name shows \"pending\", its price history hasn't been fetched yet — it fills in on the next daily run. Set Day 1 within the available history.",
              "自 Day 1 起等权买入持有(无止损/止盈/持有限制)。若某只显示「待数据」,说明它的价格历史还没抓到,下一次每日运行会补上。Day 1 请设在已有历史范围内。",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
