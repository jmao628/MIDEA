// Portfolio tracker — buy-and-hold a hand-picked basket from a chosen Day 1 and
// track each name's (and the equal-weight basket's) return, off the dated price
// history the technical job writes (price_history.json). No entry/exit rules —
// just "what has my basket done since the day I started".

import type { PriceTrack } from "../types";

export interface Pick {
  ticker: string;
  has: boolean; // dated history present with a Day-1 anchor
  day1Close: number | null;
  nowClose: number | null;
  ret: number | null; // nowClose / day1Close − 1
  day1Used: string | null; // the actual anchor date used (first ≥ Day 1)
  spark: number[]; // closes since the anchor
}

export interface Basket {
  picks: Pick[];
  ret: number | null; // equal-weight basket return since Day 1
  best: Pick | null;
  worst: Pick | null;
  curve: { d: string; v: number }[]; // basket value, 1.0 at Day 1
  covered: number; // picks with usable data
  days: number; // trading days elapsed on the curve
  minDate: string | null; // earliest date available across picks (bound the picker)
}

// First index whose date is ≥ day1 (the anchor). −1 if none.
function anchorIdx(dates: string[], day1: string): number {
  for (let i = 0; i < dates.length; i++) if (dates[i] >= day1) return i;
  return -1;
}

export function buildBasket(hist: PriceTrack | null, tickers: string[], day1: string): Basket {
  const picks: Pick[] = tickers.map((tk) => {
    const s = hist?.tickers?.[tk];
    if (!s || !s.dates?.length || !s.closes?.length) {
      return { ticker: tk, has: false, day1Close: null, nowClose: null, ret: null, day1Used: null, spark: [] };
    }
    const i0 = anchorIdx(s.dates, day1);
    if (i0 < 0 || i0 >= s.closes.length - 0) {
      // Day 1 is after all available data (or no anchor) — no return yet.
      const okAnchor = i0 >= 0 && i0 < s.closes.length;
      const d1 = okAnchor ? s.closes[i0] : null;
      const now = s.closes[s.closes.length - 1];
      return {
        ticker: tk,
        has: okAnchor && i0 <= s.closes.length - 1,
        day1Close: d1,
        nowClose: now,
        ret: d1 && d1 > 0 ? now / d1 - 1 : null,
        day1Used: okAnchor ? s.dates[i0] : null,
        spark: okAnchor ? s.closes.slice(i0) : [],
      };
    }
    const d1 = s.closes[i0];
    const now = s.closes[s.closes.length - 1];
    return {
      ticker: tk,
      has: true,
      day1Close: d1,
      nowClose: now,
      ret: d1 > 0 ? now / d1 - 1 : null,
      day1Used: s.dates[i0],
      spark: s.closes.slice(i0),
    };
  });

  const usable = picks.filter((p) => p.has && p.ret != null);
  const ret = usable.length ? usable.reduce((s, p) => s + (p.ret ?? 0), 0) / usable.length : null;

  let best: Pick | null = null;
  let worst: Pick | null = null;
  for (const p of usable) {
    if (!best || (p.ret ?? -Infinity) > (best.ret ?? -Infinity)) best = p;
    if (!worst || (p.ret ?? Infinity) < (worst.ret ?? Infinity)) worst = p;
  }

  // Equal-weight basket value over time (1.0 at Day 1). Union of dates ≥ Day 1
  // across usable picks; each pick carried forward to the as-of close.
  const curve: { d: string; v: number }[] = [];
  let minDate: string | null = null;
  if (usable.length) {
    const dateSet = new Set<string>();
    for (const p of usable) {
      const s = hist!.tickers[p.ticker];
      if (s.dates[0] && (!minDate || s.dates[0] < minDate)) minDate = s.dates[0];
      const i0 = anchorIdx(s.dates, day1);
      for (let i = i0; i < s.dates.length; i++) dateSet.add(s.dates[i]);
    }
    const dates = [...dateSet].sort();
    // per-pick pointer that advances with the timeline
    const ptr = new Map<string, { i: number; s: PriceTrack["tickers"][string]; base: number }>();
    for (const p of usable) {
      const s = hist!.tickers[p.ticker];
      ptr.set(p.ticker, { i: anchorIdx(s.dates, day1), s, base: p.day1Close ?? s.closes[0] });
    }
    for (const d of dates) {
      let sum = 0;
      let n = 0;
      for (const p of usable) {
        const st = ptr.get(p.ticker)!;
        while (st.i + 1 < st.s.dates.length && st.s.dates[st.i + 1] <= d) st.i++;
        if (st.s.dates[st.i] <= d && st.base > 0) {
          sum += st.s.closes[st.i] / st.base;
          n++;
        }
      }
      if (n) curve.push({ d, v: sum / n });
    }
  } else {
    for (const p of picks) {
      const s = hist?.tickers?.[p.ticker];
      if (s?.dates?.length && (!minDate || s.dates[0] < minDate)) minDate = s.dates[0];
    }
  }

  return { picks, ret, best, worst, curve, covered: usable.length, days: Math.max(0, curve.length - 1), minDate };
}
