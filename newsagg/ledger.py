"""Live hit-rate ledger — the system grades itself.

Every ``newsagg.technical`` run appends one dated snapshot of every ticker's
0-4 week forward score (``fwd4w``, the technical base), its tier and its timing
state, keyed by the TRADING day of the data (so an intraday re-run overwrites
the same day rather than double-counting). Then every snapshot old enough is
graded against ``price_history.json``: the realised 5 / 10 / 20-trading-day
return from that day's close, and the excess over the same-day universe of
snapshotted names.

That turns the one-off, in-sample calibration into a running OUT-OF-SAMPLE
check: if "prime" setups stop beating the universe, the weights are stale and
``newsagg.calibrate`` should be re-run. It also grades the timing states, so
band_break's 70% four-week hit rate has to keep earning its keep.

Writes ``data/newsagg/ledger.json``:

    {
      "asof": "2026-09-15", "n_dates": 12, "first_date": "…",
      "snapshots": {date: {ticker: [score, tier, state, close]}},
      "graded": {
        "n_graded_dates": 9,
        "universe": {"5": {n, hit, mean, excess=0}, "10": …, "20": …},
        "by_tier":  {tier:  {"5": {n, hit, mean, excess}, …}},
        "by_state": {state: {…}},
        "recent": [{date, ticker, score, tier, state, entry, r5, r10, r20, x5, x10, x20}, …]
      }
    }

Runs automatically at the end of ``newsagg.technical``; also standalone:

    python -m newsagg.ledger
"""

from __future__ import annotations

import argparse
import json
import logging
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("newsagg.ledger")

LEDGER_FILE = "ledger.json"
HORIZONS = (5, 10, 20)
RECENT_MAX = 300
# Mirrors the dashboard's FORWARD_TIER cut-offs (pipeline.ts forwardTier).
TIER_CUTS = ((70.0, "prime"), (55.0, "favourable"), (40.0, "neutral"))


def tier_of(score: float) -> str:
    for cut, name in TIER_CUTS:
        if score >= cut:
            return name
    return "wait"


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        return {}


def build_snapshot(out_dir: Path) -> tuple[str | None, dict[str, list]]:
    """(trading date, {ticker: [score, tier, state, close]}) from the current
    technical snapshot. The date is the most common last bar across the price
    history — the day the data actually describes."""
    tech = _load(out_dir / "technical_latest.json").get("tickers", {})
    hist = _load(out_dir / "price_history.json").get("tickers", {})
    if not tech or not hist:
        return None, {}
    last_dates = Counter(str(rec.get("dates", [None])[-1])[:10] for rec in hist.values() if rec.get("dates"))
    if not last_dates:
        return None, {}
    day = last_dates.most_common(1)[0][0]
    rows: dict[str, list] = {}
    for tk, row in tech.items():
        fw = row.get("fwd4w") or {}
        score = fw.get("score")
        if score is None:
            continue
        rec = hist.get(tk) or {}
        dates = rec.get("dates") or []
        closes = rec.get("closes") or []
        if not dates or str(dates[-1])[:10] != day or not closes:
            continue  # this name's history doesn't end on the snapshot day — skip, don't misdate
        state = ((row.get("timing") or {}).get("timing")) or "neutral"
        rows[tk] = [round(float(score), 1), tier_of(float(score)), state, round(float(closes[-1]), 4)]
    return day, rows


def _stat(vals: list[tuple[float, float]]) -> dict:
    """vals = [(raw, excess)] → n, hit, mean, excess."""
    n = len(vals)
    if not n:
        return {"n": 0, "hit": 0.0, "mean": 0.0, "excess": 0.0}
    return {
        "n": n,
        "hit": sum(1 for r, _ in vals if r > 0) / n,
        "mean": sum(r for r, _ in vals) / n,
        "excess": sum(x for _, x in vals) / n,
    }


def grade(snapshots: dict[str, dict[str, list]], hist: dict[str, dict]) -> dict:
    # date → index per ticker, built once
    index: dict[str, dict[str, int]] = {}
    closes: dict[str, list[float]] = {}
    for tk, rec in hist.items():
        ds = rec.get("dates") or []
        cs = rec.get("closes") or []
        if len(ds) == len(cs) and ds:
            index[tk] = {str(d)[:10]: i for i, d in enumerate(ds)}
            closes[tk] = [float(c) for c in cs]

    by_tier: dict[str, dict[int, list]] = defaultdict(lambda: defaultdict(list))
    by_state: dict[str, dict[int, list]] = defaultdict(lambda: defaultdict(list))
    universe: dict[int, list] = defaultdict(list)
    recent: list[dict] = []
    graded_dates = 0

    for day in sorted(snapshots):
        rows = snapshots[day]
        # realised returns for this day, per horizon
        real: dict[int, dict[str, float]] = {h: {} for h in HORIZONS}
        for tk in rows:
            i = index.get(tk, {}).get(day)
            if i is None:
                continue
            cs = closes[tk]
            for h in HORIZONS:
                if i + h < len(cs) and cs[i] > 0:
                    real[h][tk] = cs[i + h] / cs[i] - 1
        if not real[HORIZONS[0]]:
            continue  # nothing has matured yet
        graded_dates += 1
        mean = {h: (sum(real[h].values()) / len(real[h]) if real[h] else None) for h in HORIZONS}
        for tk, (score, tier, state, entry) in rows.items():
            rec = {"date": day, "ticker": tk, "score": score, "tier": tier, "state": state, "entry": entry}
            for h in HORIZONS:
                r = real[h].get(tk)
                x = (r - mean[h]) if (r is not None and mean[h] is not None) else None
                rec[f"r{h}"] = None if r is None else round(r, 4)
                rec[f"x{h}"] = None if x is None else round(x, 4)
                if r is not None and x is not None:
                    by_tier[tier][h].append((r, x))
                    by_state[state][h].append((r, x))
                    universe[h].append((r, 0.0))
            if tier in ("prime", "favourable") and rec["r5"] is not None:
                recent.append(rec)

    recent.sort(key=lambda r: (r["date"], -r["score"]), reverse=True)
    fmt = lambda d: {str(h): _stat(d[h]) for h in HORIZONS}  # noqa: E731
    return {
        "n_graded_dates": graded_dates,
        "universe": fmt(universe),
        "by_tier": {t: fmt(d) for t, d in by_tier.items()},
        "by_state": {s: fmt(d) for s, d in by_state.items()},
        "recent": recent[:RECENT_MAX],
    }


def run(out_dir: Path) -> dict | None:
    """Append today's snapshot (idempotent per trading day), grade, write."""
    path = out_dir / LEDGER_FILE
    ledger = _load(path)
    snapshots: dict[str, dict[str, list]] = ledger.get("snapshots") or {}
    day, rows = build_snapshot(out_dir)
    if day and rows:
        snapshots[day] = rows
        logger.info("ledger: snapshot %s — %d names with a forward score", day, len(rows))
    elif not snapshots:
        logger.warning("ledger: nothing to snapshot yet (technical_latest.json has no fwd4w) — run newsagg.technical")
        return None
    hist = _load(out_dir / "price_history.json").get("tickers", {})
    graded = grade(snapshots, hist)
    days = sorted(snapshots)
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asof": days[-1],
        "first_date": days[0],
        "n_dates": len(days),
        "snapshots": snapshots,
        "graded": graded,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    prime = graded["by_tier"].get("prime", {}).get("20", {})
    logger.info(
        "ledger: %d snapshot days, %d graded · prime 20d: n=%d hit=%.0f%% excess=%+.2f%%",
        len(days), graded["n_graded_dates"], prime.get("n", 0), 100 * prime.get("hit", 0), 100 * prime.get("excess", 0),
    )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Append today's forward-score snapshot and grade the ledger")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")
    from newsagg.config import load_settings

    out = run(load_settings(args.config).output_dir)
    if not out:
        return 1
    g = out["graded"]
    print(f"ledger: {out['n_dates']} days ({out['first_date']} → {out['asof']}), {g['n_graded_dates']} graded")
    for tier in ("prime", "favourable", "neutral", "wait"):
        s = g["by_tier"].get(tier, {}).get("20")
        if s and s["n"]:
            print(f"  {tier:<11} 20d  n={s['n']:<5} hit={100 * s['hit']:.0f}%  mean={100 * s['mean']:+.2f}%  excess={100 * s['excess']:+.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
