"""Calibrate the FORWARD-looking power of the timing engine against realised
1 / 2 / 4-week returns — evidence for how a 0-4 week upside score should weight
its components, instead of hand-picked weights.

Reads ``data/newsagg/price_history.json`` (dated 1y closes — and, once
``newsagg.technical`` has run with volume support, volumes — per ticker). For
every ticker and every ``--step``-th trading day with enough lookback it
computes — using ONLY the bars up to that day, so there is no lookahead — the
production timing state (``compute_timing``) and the production 0-4 week score
(``compute_fwd4w``) — the same code the dashboard runs — plus a few close-only
and volume features, then measures the forward 5 / 10 / 20-trading-day return.

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
  breakdown fired, rebound trigger, a band touch WITH vs WITHOUT volume)
  mass-tie at zero, so quintiles are the wrong lens; compare the pooled
  excess return when the signal fired against when it didn't.
* **Per timing state.** N, mean raw forward return, hit rate, and excess vs
  the same-date universe — e.g. "band_break: 4w avg +x%, excess +y%, hit z%".
* **By market regime.** The same headline stats split by whether the
  benchmark (QQQ, from ``benchmark_history.json`` — fetched live if the file
  isn't there yet) sat above or below its 50-day MA on the sample date. This
  is the test of whether "a dip is a discount" holds when the tape is weak.

Highs/lows are approximated by a ±0.5% envelope, as the offline rebuild does;
close- and volume-driven parts are exact.

    python -m newsagg.calibrate [--step 5] [--lookback 130] [--max-tickers N]
                                [--no-timing] [--data price_history.json]
                                [--benchmark benchmark_history.json]

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
BENCHMARK_FILE = "benchmark_history.json"
BENCHMARK = "QQQ"
REGIME_MA = 50  # benchmark above/below this MA = "up" / "down" tape
HORIZONS = (5, 10, 20)  # trading days ≈ 1 / 2 / 4 weeks
MIN_CROSS = 30  # tickers needed on a date for a cross-sectional stat
REGIME_CODE = {"up": 1.0, "range": 0.0, "down": -1.0}
REGIME_STATES = ("band_break", "strong_buy", "oversold_watch", "pullback_buy", "momentum", "overheated", "neutral")


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


def _sma(xs: list[float], n: int) -> float | None:
    return sum(xs[-n:]) / n if len(xs) >= n else None


# ── benchmark → market regime per date ───────────────────────────────────────
def _load_benchmark(out_dir: Path, override: str | None) -> dict | None:
    p = Path(override) if override else out_dir / BENCHMARK_FILE
    if p.exists():
        try:
            o = json.loads(p.read_text())
            if o.get("dates") and o.get("closes"):
                return o
        except ValueError:
            pass
    # Not written yet (needs one technical run) → try a live fetch so the regime
    # split still runs today; if Yahoo isn't reachable, skip the split.
    try:
        from newsagg.technical import _fetch_bars

        b = _fetch_bars(BENCHMARK)
        if b and b.get("dates"):
            logger.info("no %s yet — fetched %s live for the regime split", BENCHMARK_FILE, BENCHMARK)
            return {"dates": b["dates"], "closes": b["closes"]}
    except Exception as exc:  # noqa: BLE001
        logger.warning("no benchmark history and live fetch failed (%s) — regime split skipped", exc)
    return None


def regime_map(bench: dict | None) -> dict[str, str]:
    """date → "up" | "down": benchmark close above / below its 50-day MA."""
    if not bench:
        return {}
    dates, closes = bench["dates"], [float(c) for c in bench["closes"]]
    out: dict[str, str] = {}
    for i, d in enumerate(dates):
        ma = _sma(closes[: i + 1], REGIME_MA)
        if ma is not None:
            out[str(d)[:10]] = "up" if closes[i] > ma else "down"
    return out


# ── per-sample features (no lookahead: only bars up to the date) ─────────────
def _features(w: list[float], vols: list[float] | None, p: TechParams, with_timing: bool) -> dict | None:
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
        "rvol": None,
        "vspike": None,
        "timing": None,
        "score": None,
        "rebound": None,
        "breakdown": None,
    }
    # Volume features (present once the history carries volumes): 5d/20d
    # relative volume, and the biggest single-day spike in the last 3 bars vs
    # the 20d average — the "capitulation on the dip" signature.
    if vols and len(vols) >= 20:
        base = _mean0(vols[-20:])
        if base > 0:
            f["rvol"] = _mean0(vols[-5:]) / base
            f["vspike"] = max(vols[-3:]) / base
    # The production 0-4 week score — imported from technical.py so this test
    # always measures exactly the formula the dashboard ships.
    fw = compute_fwd4w(w)
    f["fwd4w"] = fw["score"] if fw else None
    if with_timing:
        highs = [c * 1.005 for c in w]
        lows = [c * 0.995 for c in w]
        v = vols if (vols and len(vols) == len(w)) else [1_000_000.0] * len(w)
        t = compute_timing(highs, lows, w, v, p)
        if t:
            f["timing"] = t.get("timing")
            f["score"] = float(t.get("score") or 0)
            f["rebound"] = float(t.get("rebound") or 0)
            f["breakdown"] = float(t.get("breakdown") or 0)
    return f


NUMERIC = ("score", "fwd4w", "rebound", "pctb", "hist_z", "regime", "mom21", "mom63", "dd20", "rvol", "vspike")
# On/off signals: (label, predicate on a row). Quintiles mass-tie at zero for
# these, so they're compared as fired-vs-not instead.
BINARY = (
    ("overext", lambda r: r.get("overext") == 1.0),
    ("breakdown>0", lambda r: (r.get("breakdown") or 0) > 0),
    (f"rebound>={_REBOUND_TRIGGER}", lambda r: (r.get("rebound") or 0) >= _REBOUND_TRIGGER),
    ("pctb<=0.05", lambda r: r.get("pctb") is not None and r["pctb"] <= 0.05),
    ("pctb>=1.0", lambda r: r.get("pctb") is not None and r["pctb"] >= 1.0),
    # the band touch WITH vs WITHOUT volume behind it
    ("band&rvol>=1.5", lambda r: r.get("pctb") is not None and r["pctb"] <= 0.05 and (r.get("rvol") or 0) >= 1.5),
    ("band&rvol<1.5", lambda r: r.get("pctb") is not None and r["pctb"] <= 0.05 and r.get("rvol") is not None and r["rvol"] < 1.5),
    ("vspike>=2", lambda r: (r.get("vspike") or 0) >= 2.0),
)


def collect(history: dict[str, dict], step: int, lookback: int, with_timing: bool, max_tickers: int | None) -> tuple[list[dict], bool]:
    """Returns (rows, had_volumes)."""
    p = TechParams()
    rows: list[dict] = []
    tickers = sorted(history)
    if max_tickers:
        tickers = tickers[:max_tickers]
    max_fwd = max(HORIZONS)
    had_vol = False
    t0 = time.time()
    for n, tk in enumerate(tickers, 1):
        rec = history.get(tk) or {}
        raw_c = rec.get("closes") or []
        raw_d = rec.get("dates") or []
        raw_v = rec.get("volumes")
        if len(raw_d) != len(raw_c):
            continue
        use_v = bool(raw_v) and len(raw_v) == len(raw_c)
        # Filter bad bars JOINTLY so dates / closes / volumes stay aligned.
        trip = [(str(d)[:10], float(c), float(raw_v[i]) if use_v else 0.0) for i, (d, c) in enumerate(zip(raw_d, raw_c)) if c == c and c > 0]
        if len(trip) < lookback + max_fwd + 1:
            continue
        dates = [x[0] for x in trip]
        closes = [x[1] for x in trip]
        vols = [x[2] for x in trip] if use_v else None
        had_vol = had_vol or use_v
        for t in range(lookback - 1, len(closes) - max_fwd, step):
            lo = max(0, t - 260)  # cap the window: MA200 is the longest lookback
            w = closes[lo : t + 1]
            wv = vols[lo : t + 1] if vols else None
            try:
                f = _features(w, wv, p, with_timing)
            except Exception:  # noqa: BLE001
                f = None
            if not f:
                continue
            fwd = {h: closes[t + h] / closes[t] - 1 for h in HORIZONS}
            rows.append({"date": dates[t], "ticker": tk, **f, **{f"fwd{h}": v for h, v in fwd.items()}})
        if n % 100 == 0:
            logger.info("  %d/%d tickers… (%d samples, %.0fs)", n, len(tickers), len(rows), time.time() - t0)
    return rows, had_vol


# ── evaluation blocks (each takes the row subset it should describe) ─────────
def _feature_block(feat: str, by_date: dict[str, list[dict]], dates: list[str], date_mean: dict) -> dict | None:
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
                quint_excess[h][q].append(r[f"fwd{h}"] - date_mean[h][d])
                quint_raw[h][q].append(r[f"fwd{h}"])
    if not ics[20]:
        return None
    out: dict = {}
    for h in HORIZONS:
        ic = ics[h]
        top, bot = _mean(quint_excess[h][4]), _mean(quint_excess[h][0])
        out[f"fwd{h}"] = {
            "ic_mean": _mean0(ic),
            "ic_pos_share": _hit(ic) or 0.0,
            "n_dates": len(ic),
            "q_excess": [_mean(q) for q in quint_excess[h]],
            "q_hit": [_hit(q) for q in quint_raw[h]],
            "spread_q5_q1": (top - bot) if (top is not None and bot is not None) else None,
        }
    return out


def _binary_block(rows: list[dict], date_mean: dict) -> dict:
    out: dict = {}
    for label, pred in BINARY:
        on = [r for r in rows if pred(r)]
        off = [r for r in rows if not pred(r)]
        if len(on) < 20:
            continue
        out[label] = {"n_on": len(on), "n_off": len(off)}
        for h in HORIZONS:
            out[label][f"fwd{h}"] = {
                "on_excess": _mean([r[f"fwd{h}"] - date_mean[h][r["date"]] for r in on]),
                "on_hit": _hit([r[f"fwd{h}"] for r in on]),
                "off_excess": _mean([r[f"fwd{h}"] - date_mean[h][r["date"]] for r in off]),
                "off_hit": _hit([r[f"fwd{h}"] for r in off]),
            }
    return out


def _state_block(rows: list[dict], date_mean: dict) -> dict:
    by_state: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("timing"):
            by_state[r["timing"]].append(r)
    out: dict = {}
    for st, rs in by_state.items():
        out[st] = {"n": len(rs)}
        for h in HORIZONS:
            raw = [r[f"fwd{h}"] for r in rs]
            out[st][f"fwd{h}"] = {
                "mean": _mean0(raw),
                "excess": _mean0([r[f"fwd{h}"] - date_mean[h][r["date"]] for r in rs]),
                "hit": _hit(raw) or 0.0,
            }
    return out


def _universe_block(rows: list[dict]) -> dict:
    return {h: {"mean": _mean0([r[f"fwd{h}"] for r in rows]), "hit": _hit([r[f"fwd{h}"] for r in rows]) or 0.0} for h in HORIZONS}


def evaluate(rows: list[dict], regimes: dict[str, str]) -> dict:
    by_date: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_date[r["date"]].append(r)
    dates = [d for d, rs in by_date.items() if len(rs) >= MIN_CROSS]
    # same-date universe mean → "excess" strips the tape out of every stat
    date_mean = {h: {d: _mean0([r[f"fwd{h}"] for r in by_date[d]]) for d in dates} for h in HORIZONS}
    pooled = [r for d in dates for r in by_date[d]]

    features = {feat: blk for feat in NUMERIC if (blk := _feature_block(feat, by_date, dates, date_mean))}

    # ── by market regime ────────────────────────────────────────────────────
    regime: dict = {}
    if regimes:
        for reg in ("up", "down"):
            r_dates = [d for d in dates if regimes.get(d) == reg]
            r_rows = [r for d in r_dates for r in by_date[d]]
            if len(r_dates) < 3 or not r_rows:
                continue
            regime[reg] = {
                "n_dates": len(r_dates),
                "n_samples": len(r_rows),
                "universe": _universe_block(r_rows),
                "features": {feat: blk for feat in ("fwd4w", "score") if (blk := _feature_block(feat, by_date, r_dates, date_mean))},
                "binary": {k: v for k, v in _binary_block(r_rows, date_mean).items() if k in ("pctb<=0.05", "band&rvol>=1.5", "band&rvol<1.5")},
                "states": {k: v for k, v in _state_block(r_rows, date_mean).items() if k in REGIME_STATES},
            }
        unmapped = sum(1 for d in dates if d not in regimes)
        if unmapped:
            logger.info("%d sample dates had no benchmark bar (excluded from the regime split)", unmapped)

    return {
        "n_samples": len(rows),
        "n_dates": len(dates),
        "universe": _universe_block(pooled),
        "features": features,
        "binary": _binary_block(pooled, date_mean),
        "states": _state_block(pooled, date_mean),
        "regime": regime,
    }


# ── report ───────────────────────────────────────────────────────────────────
def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:+.2f}%"


def _p0(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.0f}%"


def _print_states(states: dict) -> None:
    print(f"{'state':<15} {'N':>6}  " + "  ".join(f"{h:>2}d mean / excess / hit" for h in HORIZONS))
    for st, s in sorted(states.items(), key=lambda kv: -kv[1]["n"]):
        cells = "  ".join(f"{_pct(s[f'fwd{h}']['mean']):>8} {_pct(s[f'fwd{h}']['excess']):>8} {_p0(s[f'fwd{h}']['hit']):>4}" for h in HORIZONS)
        print(f"{st:<15} {s['n']:>6}  {cells}")


def _print_binary(binary: dict) -> None:
    print(f"{'signal':<16} {'N on':>6} {'N off':>6}  " + "  ".join(f"{h:>2}d on exc/hit | off exc/hit" for h in HORIZONS))
    for label, s in binary.items():
        cells = "  ".join(
            f"{_pct(s[f'fwd{h}']['on_excess']):>8} {_p0(s[f'fwd{h}']['on_hit']):>4} | {_pct(s[f'fwd{h}']['off_excess']):>8} {_p0(s[f'fwd{h}']['off_hit']):>4}"
            for h in HORIZONS
        )
        print(f"{label:<16} {s['n_on']:>6} {s['n_off']:>6}  {cells}")


def report(res: dict, had_vol: bool) -> None:
    print()
    print(f"samples {res['n_samples']}  |  cross-sectional dates {res['n_dates']}  (≥{MIN_CROSS} tickers each)")
    u = res["universe"]
    print("universe baseline:  " + "  ".join(f"{h}d {_pct(u[h]['mean'])} (hit {_p0(u[h]['hit'])})" for h in HORIZONS))
    if not had_vol:
        print("(no volumes in price_history.json yet — volume features skipped; run newsagg.technical once, then re-run)")
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
    _print_binary(res["binary"])
    print()
    print("── TIMING STATES · what actually happened after each state fired (excess = vs same-date universe) ──")
    _print_states(res["states"])
    if res.get("regime"):
        print()
        print(f"── MARKET REGIME · {BENCHMARK} above vs below its {REGIME_MA}d MA on the sample date ──")
        for reg, blk in res["regime"].items():
            u = blk["universe"]
            print()
            print(f"[{reg.upper()} tape]  dates {blk['n_dates']} · samples {blk['n_samples']} · universe 20d {_pct(u[20]['mean'])} (hit {_p0(u[20]['hit'])})")
            for feat, hz in blk["features"].items():
                s = hz.get("fwd20")
                if s:
                    print(f"  {feat:<8} 20d IC {s['ic_mean']:+.3f} · IC>0 {_p0(s['ic_pos_share'])} · Q5 exc {_pct(s['q_excess'][4])} · Q5-Q1 {_pct(s['spread_q5_q1'])} · hitQ5 {_p0(s['q_hit'][4])}")
            if blk["binary"]:
                _print_binary(blk["binary"])
            if blk["states"]:
                _print_states(blk["states"])
    print()
    print("read: IC>0 share is the robust signal (forward windows overlap, so don't trust raw significance).")
    print("      Q5-Q1 = 4w excess return of the top vs bottom quintile — the spread a ranking would capture.")
    print("      regime blocks with few dates are indicative only — a bull year has little DOWN tape to learn from.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Calibrate timing-engine forward power vs realised 1/2/4-week returns")
    ap.add_argument("--config", default=None)
    ap.add_argument("--data", default=None, help="price_history.json path (default: settings output dir)")
    ap.add_argument("--benchmark", default=None, help="benchmark_history.json path (default: next to the data)")
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
    regimes = regime_map(_load_benchmark(out_dir, args.benchmark))
    logger.info(
        "calibrating on %d tickers (step %d, lookback %d, timing=%s, regime dates=%d)…",
        len(history), args.step, args.lookback, not args.no_timing, len(regimes),
    )

    rows, had_vol = collect(history, args.step, args.lookback, not args.no_timing, args.max_tickers)
    if not rows:
        logger.error("no samples — is the history long enough (need > lookback + 20 bars)?")
        return 1
    res = evaluate(rows, regimes)
    report(res, had_vol)
    (out_dir / CALIBRATION_FILE).write_text(json.dumps(res, indent=1))
    logger.info("wrote %s", out_dir / CALIBRATION_FILE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
