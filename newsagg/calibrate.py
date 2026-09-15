"""Calibrate the FORWARD-looking power of the timing engine against realised
1 / 2 / 4-week returns — evidence for how a 0-4 week upside score should weight
its components, instead of hand-picked weights.

Reads ``data/newsagg/price_history.json`` (dated 1y closes per ticker, written
by ``newsagg.technical``). For every ticker and every ``--step``-th trading day
with enough lookback it computes — using ONLY the closes up to that day, so
there is no lookahead — the production timing state (``compute_timing``) and
the production 0-4 week score (``compute_fwd4w``) — the same code the dashboard
runs — plus a few close-only features, then measures the forward 5 / 10 /
20-trading-day return.

What it reports:

* **Per feature — cross-sectional Spearman IC.** On each date, rank-correlate
  the feature ACROSS tickers with the forward return, then average over dates.
  This is the standard test of *ranking* power (does a higher score pick the
  better names that day?), immune to the overall tape. Also the share of
  dates with IC > 0 — the robust read, since 20-day forward windows sampled
  every 5 days overlap and inflate naive significance.
* **Per feature — quintile spread.** Within each date, cut the feature into
  quintiles; pool the *excess* forward return (minus that date's universe
  mean) per quintile. Top-minus-bottom spread and hit rates.
* **On/off signals — fired vs not.** Sparse binary signals (overextended,
  breakdown fired, rebound trigger) mass-tie at zero, so quintiles are the
  wrong lens; compare the pooled excess return when the signal fired against
  when it didn't.
* **Per timing state.** N, mean raw forward return, hit rate, and excess vs
  the same-date universe — e.g. "band_break: 4w avg +x%, excess +y%, hit z%".

Volume is not in the history file, so the attention (rvol / OBV) components
can't be tested here; highs/lows are approximated by a ±0.5% envelope, as the
offline rebuild does. Close-driven parts (Bollinger, MACD, regime, momentum)
are exact.

    python -m newsagg.calibrate [--step 5] [--lookback 130] [--max-tickers N]
                                [--no-timing] [--data path/to/price_history.json]

Writes ``data/newsagg/calibration.json`` with the same tables.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import statistics
import time
from collections import defaultdict
from pathlib import Path

from newsagg.technical import _REBOUND_TRIGGER, TechParams, _bollinger, _macd_full, _trend_regime, compute_fwd4w, compute_timing

logger = logging.getLogger("newsagg.calibrate")

CALIBRATION_FILE = "calibration.json"
HORIZONS = (5, 10, 20)  # trading days ≈ 1 / 2 / 4 weeks
MIN_CROSS = 30  # tickers needed on a date for a cross-sectional stat
REGIME_CODE = {"up": 1.0, "range": 0.0, "down": -1.0}


# ── small stats helpers (stdlib only) ────────────────────────────────────────
def _ranks(xs: list[float]) -> list[float]:
    """Average-tie ranks, 1-based."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def _pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else 0.0


def _spearman(xs: list[float], ys: list[float]) -> float:
    return _pearson(_ranks(xs), _ranks(ys))


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _hit(xs: list[float]) -> float | None:
    return sum(1 for x in xs if x > 0) / len(xs) if xs else None


def _mean0(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


# ── per-sample features (no lookahead: only `w` = closes up to the date) ─────
def _features(w: list[float], p: TechParams, with_timing: bool) -> dict | None:
    if len(w) < 70 or w[-1] <= 0:
        return None
    bb = _bollinger(w)
    m = _macd_full(w)
    if not bb or not m or len(m["hists"]) < 30:
        return None
    hists = m["hists"]
    tail = hists[-60:]
    sd = statistics.pstdev(tail) if len(tail) > 1 else 0.0
    hist_z = (hists[-1] - _mean0(tail)) / sd if sd > 0 else 0.0
    f: dict = {
        "pctb": bb["pctb"],
        "hist_z": hist_z,
        "regime": REGIME_CODE.get(_trend_regime(w), 0.0),
        "mom21": w[-1] / w[-22] - 1 if len(w) > 22 and w[-22] > 0 else 0.0,
        "mom63": w[-1] / w[-64] - 1 if len(w) > 64 and w[-64] > 0 else 0.0,
        "dd20": w[-1] / max(w[-20:]) - 1,  # ≤ 0: how far below the 20d high
        # overextended-and-fading: above the upper band with momentum rolling
        "overext": 1.0 if (bb["pctb"] >= 1.0 and hists[-1] < hists[-2]) else 0.0,
        "timing": None,
        "score": None,
        "rebound": None,
        "breakdown": None,
    }
    # The production 0-4 week score — imported from technical.py so this test
    # always measures exactly the formula the dashboard ships.
    fw = compute_fwd4w(w)
    f["fwd4w"] = fw["score"] if fw else None
    if with_timing:
        highs = [c * 1.005 for c in w]
        lows = [c * 0.995 for c in w]
        vols = [1_000_000.0] * len(w)
        t = compute_timing(highs, lows, w, vols, p)
        if t:
            f["timing"] = t.get("timing")
            f["score"] = float(t.get("score") or 0)
            f["rebound"] = float(t.get("rebound") or 0)
            f["breakdown"] = float(t.get("breakdown") or 0)
    return f


NUMERIC = ("score", "fwd4w", "rebound", "pctb", "hist_z", "regime", "mom21", "mom63", "dd20")
# On/off signals: (label, predicate on a row). Quintiles mass-tie at zero for
# these, so they're compared as fired-vs-not instead.
BINARY = (
    ("overext", lambda r: r.get("overext") == 1.0),
    ("breakdown>0", lambda r: (r.get("breakdown") or 0) > 0),
    (f"rebound>={_REBOUND_TRIGGER}", lambda r: (r.get("rebound") or 0) >= _REBOUND_TRIGGER),
    ("pctb<=0.05", lambda r: r.get("pctb") is not None and r["pctb"] <= 0.05),
    ("pctb>=1.0", lambda r: r.get("pctb") is not None and r["pctb"] >= 1.0),
)


def collect(history: dict[str, dict], step: int, lookback: int, with_timing: bool, max_tickers: int | None) -> list[dict]:
    p = TechParams()
    rows: list[dict] = []
    tickers = sorted(history)
    if max_tickers:
        tickers = tickers[:max_tickers]
    max_fwd = max(HORIZONS)
    t0 = time.time()
    for n, tk in enumerate(tickers, 1):
        rec = history.get(tk) or {}
        closes = [float(c) for c in (rec.get("closes") or []) if c == c and c > 0]
        dates = rec.get("dates") or []
        if len(closes) < lookback + max_fwd + 1 or len(dates) != len(closes):
            continue
        for t in range(lookback - 1, len(closes) - max_fwd, step):
            w = closes[max(0, t - 260) : t + 1]  # cap the window: MA200 is the longest lookback
            try:
                f = _features(w, p, with_timing)
            except Exception:  # noqa: BLE001
                f = None
            if not f:
                continue
            fwd = {h: closes[t + h] / closes[t] - 1 for h in HORIZONS}
            rows.append({"date": dates[t], "ticker": tk, **f, **{f"fwd{h}": v for h, v in fwd.items()}})
        if n % 100 == 0:
            logger.info("  %d/%d tickers… (%d samples, %.0fs)", n, len(tickers), len(rows), time.time() - t0)
    return rows


def evaluate(rows: list[dict]) -> dict:
    by_date: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_date[r["date"]].append(r)
    dates = [d for d, rs in by_date.items() if len(rs) >= MIN_CROSS]

    # same-date universe mean → "excess" strips the tape out of every stat
    date_mean = {h: {d: _mean0([r[f"fwd{h}"] for r in by_date[d]]) for d in dates} for h in HORIZONS}

    def excess(r: dict, h: int) -> float:
        return r[f"fwd{h}"] - date_mean[h][r["date"]]

    # ── per feature: IC + quintiles ─────────────────────────────────────────
    features: dict[str, dict] = {}
    for feat in NUMERIC:
        ics = {h: [] for h in HORIZONS}
        quint_excess = {h: [[] for _ in range(5)] for h in HORIZONS}
        quint_raw = {h: [[] for _ in range(5)] for h in HORIZONS}
        for d in dates:
            rs = [r for r in by_date[d] if r.get(feat) is not None]
            if len(rs) < MIN_CROSS:
                continue
            xs = [float(r[feat]) for r in rs]
            if max(xs) == min(xs):
                continue  # constant on this date → no ranking information
            rk = _ranks(xs)
            for h in HORIZONS:
                ys = [r[f"fwd{h}"] for r in rs]
                ics[h].append(_spearman(xs, ys))
                for r, rank in zip(rs, rk):
                    q = min(4, int((rank - 1) / len(rs) * 5))
                    quint_excess[h][q].append(excess(r, h))
                    quint_raw[h][q].append(r[f"fwd{h}"])
        if not ics[20]:
            continue
        features[feat] = {}
        for h in HORIZONS:
            ic = ics[h]
            top, bot = _mean(quint_excess[h][4]), _mean(quint_excess[h][0])
            features[feat][f"fwd{h}"] = {
                "ic_mean": _mean0(ic),
                "ic_pos_share": _hit(ic) or 0.0,
                "n_dates": len(ic),
                "q_excess": [_mean(q) for q in quint_excess[h]],
                "q_hit": [_hit(q) for q in quint_raw[h]],
                "spread_q5_q1": (top - bot) if (top is not None and bot is not None) else None,
            }

    # ── on/off signals: fired vs not ────────────────────────────────────────
    pooled = [r for d in dates for r in by_date[d]]
    binary: dict[str, dict] = {}
    for label, pred in BINARY:
        on = [r for r in pooled if pred(r)]
        off = [r for r in pooled if not pred(r)]
        if len(on) < 20:
            continue
        binary[label] = {"n_on": len(on), "n_off": len(off)}
        for h in HORIZONS:
            binary[label][f"fwd{h}"] = {
                "on_excess": _mean([excess(r, h) for r in on]),
                "on_hit": _hit([r[f"fwd{h}"] for r in on]),
                "off_excess": _mean([excess(r, h) for r in off]),
                "off_hit": _hit([r[f"fwd{h}"] for r in off]),
            }

    # ── per timing state ────────────────────────────────────────────────────
    states: dict[str, dict] = {}
    by_state: dict[str, list[dict]] = defaultdict(list)
    for r in pooled:
        if r.get("timing"):
            by_state[r["timing"]].append(r)
    for st, rs in by_state.items():
        states[st] = {"n": len(rs)}
        for h in HORIZONS:
            raw = [r[f"fwd{h}"] for r in rs]
            states[st][f"fwd{h}"] = {"mean": _mean0(raw), "excess": _mean0([excess(r, h) for r in rs]), "hit": _hit(raw) or 0.0}

    universe = {h: {"mean": _mean0([r[f"fwd{h}"] for r in rows]), "hit": _hit([r[f"fwd{h}"] for r in rows]) or 0.0} for h in HORIZONS}
    return {"n_samples": len(rows), "n_dates": len(dates), "universe": universe, "features": features, "binary": binary, "states": states}


# ── report ───────────────────────────────────────────────────────────────────
def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:+.2f}%"


def _p0(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.0f}%"


def report(res: dict) -> None:
    print()
    print(f"samples {res['n_samples']}  |  cross-sectional dates {res['n_dates']}  (≥{MIN_CROSS} tickers each)")
    u = res["universe"]
    print("universe baseline:  " + "  ".join(f"{h}d {_pct(u[h]['mean'])} (hit {_p0(u[h]['hit'])})" for h in HORIZONS))
    print()
    print("── FEATURES · does a higher value pick the better names? (IC = rank corr across tickers per date) ──")
    print(f"{'feature':<10} {'hz':>3} {'IC mean':>8} {'IC>0':>6} {'dates':>5} {'Q1 exc':>8} {'Q3 exc':>8} {'Q5 exc':>8} {'Q5-Q1':>8} {'hitQ1':>6} {'hitQ5':>6}")
    for feat, hz in res["features"].items():
        for h in HORIZONS:
            s = hz.get(f"fwd{h}")
            if not s:
                continue
            q = s["q_excess"]
            print(
                f"{feat:<10} {h:>3} {s['ic_mean']:>+8.3f} {_p0(s['ic_pos_share']):>6} {s['n_dates']:>5} "
                f"{_pct(q[0]):>8} {_pct(q[2]):>8} {_pct(q[4]):>8} {_pct(s['spread_q5_q1']):>8} "
                f"{_p0(s['q_hit'][0]):>6} {_p0(s['q_hit'][4]):>6}"
            )
    print()
    print("── ON/OFF SIGNALS · excess return when the signal fired vs when it didn't ──")
    print(f"{'signal':<14} {'N on':>6} {'N off':>6}  " + "  ".join(f"{h:>2}d on exc/hit | off exc/hit" for h in HORIZONS))
    for label, s in res["binary"].items():
        cells = "  ".join(
            f"{_pct(s[f'fwd{h}']['on_excess']):>8} {_p0(s[f'fwd{h}']['on_hit']):>4} | {_pct(s[f'fwd{h}']['off_excess']):>8} {_p0(s[f'fwd{h}']['off_hit']):>4}"
            for h in HORIZONS
        )
        print(f"{label:<14} {s['n_on']:>6} {s['n_off']:>6}  {cells}")
    print()
    print("── TIMING STATES · what actually happened after each state fired (excess = vs same-date universe) ──")
    print(f"{'state':<15} {'N':>6}  " + "  ".join(f"{h:>2}d mean / excess / hit" for h in HORIZONS))
    order = sorted(res["states"].items(), key=lambda kv: -kv[1]["n"])
    for st, s in order:
        cells = "  ".join(f"{_pct(s[f'fwd{h}']['mean']):>8} {_pct(s[f'fwd{h}']['excess']):>8} {_p0(s[f'fwd{h}']['hit']):>4}" for h in HORIZONS)
        print(f"{st:<15} {s['n']:>6}  {cells}")
    print()
    print("read: IC>0 share is the robust signal (forward windows overlap, so don't trust raw significance).")
    print("      Q5-Q1 = 4w excess return of the top vs bottom quintile — the spread a ranking would capture.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Calibrate timing-engine forward power vs realised 1/2/4-week returns")
    ap.add_argument("--config", default=None)
    ap.add_argument("--data", default=None, help="price_history.json path (default: settings output dir)")
    ap.add_argument("--step", type=int, default=5, help="sample every N trading days (default 5)")
    ap.add_argument("--lookback", type=int, default=130, help="min bars before the first sample (default 130)")
    ap.add_argument("--max-tickers", type=int, default=None)
    ap.add_argument("--no-timing", action="store_true", help="skip compute_timing (fast: close-only features)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    if args.data:
        path = Path(args.data)
        out_dir = path.parent
    else:
        from newsagg.config import load_settings

        out_dir = load_settings(args.config).output_dir
        path = out_dir / "price_history.json"
    if not path.exists():
        logger.error("no price history at %s — run newsagg.technical first", path)
        return 1
    history = json.loads(path.read_text()).get("tickers", {})
    logger.info("calibrating on %d tickers (step %d, lookback %d, timing=%s)…", len(history), args.step, args.lookback, not args.no_timing)

    rows = collect(history, args.step, args.lookback, not args.no_timing, args.max_tickers)
    if not rows:
        logger.error("no samples — is the history long enough (need > lookback + 20 bars)?")
        return 1
    res = evaluate(rows)
    report(res)
    (out_dir / CALIBRATION_FILE).write_text(json.dumps(res, indent=1))
    logger.info("wrote %s", out_dir / CALIBRATION_FILE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
