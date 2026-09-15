"""Price-volume *attention* signal + a technical summary for the seed universe.

Mid/small caps that are starting to get market attention usually show it in
price/volume long before Reddit does. This module computes, per ticker, from
daily OHLCV (yfinance — the same Yahoo bars TradingView/investing.com use, so
every indicator here is deterministic arithmetic that matches any provider):

  * an **attention** signal — relative volume, breakout, OBV accumulation and
    trend — that lets a mid/small cap pass the heat gate even when social
    mentions are too sparse to ignite; and
  * a **gauge** — the investing.com-style MA + oscillator mechanical aggregate
    (Strong Buy…Strong Sell). Display only, and it lags — never a filter.

Writes ``data/newsagg/technical_latest.json`` = {ticker: {...}}.

    python -m newsagg.technical
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from newsagg.config import load_settings
from newsagg.marketcap import seed_tickers, load_dead_tickers, save_dead_tickers

logger = logging.getLogger("newsagg.technical")

TECHNICAL_FILE = "technical_latest.json"
# Benchmark daily history, written alongside so newsagg.calibrate can split its
# results by market regime (tape above / below its 50-day MA) offline.
BENCHMARK_TICKER = "QQQ"
BENCHMARK_FILE = "benchmark_history.json"
PRICE_HISTORY_FILE = "price_history.json"  # dated 1y closes per ticker (for the tracker)


@dataclass
class TechParams:
    rvol_short: int = 5  # recent-volume window
    rvol_long: int = 20  # baseline-volume window
    rvol_min: float = 1.5  # relative-volume ignition threshold
    breakout_window: int = 20  # N-day high for breakout
    near_high_pct: float = 0.05  # "within 5% of the 20-day high" counts as coiled
    obv_window: int = 20  # OBV-slope lookback
    detonate_rvol: float = 2.0  # 52-week-high breakout needs this much volume


# ---------------------------------------------------------------- math helpers


def _sma(xs: list[float], n: int) -> float | None:
    if len(xs) < n:
        return None
    return sum(xs[-n:]) / n


def _ema_series(xs: list[float], n: int) -> list[float | None]:
    if len(xs) < n:
        return []
    k = 2 / (n + 1)
    e = sum(xs[:n]) / n
    out: list[float | None] = [None] * (n - 1) + [e]
    for x in xs[n:]:
        e = x * k + e * (1 - k)
        out.append(e)
    return out


def _slope(ys: list[float]) -> float:
    n = len(ys)
    if n < 2:
        return 0.0
    mx = (n - 1) / 2
    my = sum(ys) / n
    denom = sum((i - mx) ** 2 for i in range(n))
    if denom == 0:
        return 0.0
    return sum((i - mx) * (y - my) for i, y in enumerate(ys)) / denom


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) < n + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    for i in range(n, len(gains)):  # Wilder smoothing
        avg_g = (avg_g * (n - 1) + gains[i]) / n
        avg_l = (avg_l * (n - 1) + losses[i]) / n
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return 100 - 100 / (1 + rs)


def _macd(closes: list[float]) -> tuple[float, float, float] | None:
    e12 = _ema_series(closes, 12)
    e26 = _ema_series(closes, 26)
    if not e26 or e26[-1] is None:
        return None
    line_series = [
        (a - b) if (a is not None and b is not None) else None for a, b in zip(e12, e26)
    ]
    vals = [m for m in line_series if m is not None]
    sig = _ema_series(vals, 9)
    line = line_series[-1] or 0.0
    if not sig or sig[-1] is None:
        return (line, line, 0.0)
    signal = sig[-1]
    return (line, signal, line - signal)


def _stoch_k(highs, lows, closes, n: int = 14) -> float | None:
    if len(closes) < n:
        return None
    hh, ll = max(highs[-n:]), min(lows[-n:])
    if hh == ll:
        return 50.0
    return 100 * (closes[-1] - ll) / (hh - ll)


def _cci(highs, lows, closes, n: int = 20) -> float | None:
    if len(closes) < n:
        return None
    tp = [(highs[i] + lows[i] + closes[i]) / 3 for i in range(len(closes))][-n:]
    ma = sum(tp) / n
    md = sum(abs(x - ma) for x in tp) / n
    if md == 0:
        return 0.0
    return (tp[-1] - ma) / (0.015 * md)


def _williams_r(highs, lows, closes, n: int = 14) -> float | None:
    if len(closes) < n:
        return None
    hh, ll = max(highs[-n:]), min(lows[-n:])
    if hh == ll:
        return -50.0
    return -100 * (hh - closes[-1]) / (hh - ll)


def _atr(highs, lows, closes, n: int = 14) -> float | None:
    if len(closes) < n + 1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(
            max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        )
    a = sum(trs[:n]) / n
    for t in trs[n:]:
        a = (a * (n - 1) + t) / n
    return a


def _obv(closes: list[float], volumes: list[float]) -> list[float]:
    o = [0.0]
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            o.append(o[-1] + volumes[i])
        elif closes[i] < closes[i - 1]:
            o.append(o[-1] - volumes[i])
        else:
            o.append(o[-1])
    return o


def _stdev(xs: list[float], n: int) -> float | None:
    """Population standard deviation of the last n values (Bollinger uses N, not N-1)."""
    if len(xs) < n:
        return None
    w = xs[-n:]
    m = sum(w) / n
    return (sum((x - m) ** 2 for x in w) / n) ** 0.5


def _bollinger(closes: list[float], n: int = 20, k: float = 2.0) -> dict | None:
    """Bollinger Bands + the two normalized quantities the timing engine runs on:
    %B (where price sits inside the bands: <0 below lower, >1 above upper, 0.5 at
    the MA20 middle) and bandwidth ((upper−lower)/middle — the volatility regime)."""
    mid = _sma(closes, n)
    sd = _stdev(closes, n)
    if mid is None or sd is None or mid == 0:
        return None
    upper = mid + k * sd
    lower = mid - k * sd
    price = closes[-1]
    width = upper - lower
    pctb = (price - lower) / width if width else 0.5
    return {
        "upper": upper,
        "middle": mid,
        "lower": lower,
        "pctb": pctb,
        "bandwidth": width / mid,
    }


def _bandwidth_series(closes: list[float], n: int = 20, k: float = 2.0, lookback: int = 120) -> list[float]:
    """Bandwidth at each of the last ``lookback`` days — its own percentile tells
    a squeeze (coiling, low band width) from an expansion (trend releasing)."""
    out: list[float] = []
    start = max(n, len(closes) - lookback)
    for i in range(start, len(closes) + 1):
        w = closes[:i]
        mid = _sma(w, n)
        sd = _stdev(w, n)
        if mid and sd is not None and mid:
            out.append((2 * k * sd) / mid)
    return out


def _pctb_series(closes: list[float], n: int = 20, k: float = 2.0, days: int = 12) -> list[float]:
    """%B for each of the last ``days`` sessions (the middle-band streak + the
    'recently touched the lower/upper band' tests read off this)."""
    out: list[float] = []
    start = max(n, len(closes) - days + 1)
    for i in range(start, len(closes) + 1):
        w = closes[:i]
        mid = _sma(w, n)
        sd = _stdev(w, n)
        if mid and sd is not None:
            width = 2 * k * sd
            out.append((w[-1] - (mid - k * sd)) / width if width else 0.5)
    return out


def _macd_full(closes: list[float]) -> dict | None:
    """MACD line / signal / histogram as ALIGNED series (not just the last value),
    so the timing engine can measure the histogram's trough, its z-score, and its
    turn. 12/26/9, matching the display gauge's _macd."""
    e12 = _ema_series(closes, 12)
    e26 = _ema_series(closes, 26)
    if not e26 or e26[-1] is None:
        return None
    line_series = [(a - b) if (a is not None and b is not None) else None for a, b in zip(e12, e26)]
    vals = [m for m in line_series if m is not None]
    sig = _ema_series(vals, 9)
    lines, signals, hists = [], [], []
    for lv, sv in zip(vals, sig):
        if sv is None:
            continue
        lines.append(lv)
        signals.append(sv)
        hists.append(lv - sv)
    if not hists:
        return None
    return {"lines": lines, "signals": signals, "hists": hists}


def _rsi_series(closes: list[float], n: int = 14, lookback: int = 40) -> list[tuple[int, float]]:
    """(index, RSI) for the last ``lookback`` sessions — powers divergence."""
    out: list[tuple[int, float]] = []
    start = max(n + 1, len(closes) - lookback)
    for i in range(start, len(closes) + 1):
        r = _rsi(closes[:i], n)
        if r is not None:
            out.append((i - 1, r))
    return out


def _bullish_divergence(closes: list[float], window: int = 30, n_rsi: int = 14) -> bool:
    """Price makes a LOWER low but RSI makes a HIGHER low = selling pressure
    waning even as price drops — the strongest 'the bounce has legs' tell.

    Robust + deterministic: split the recent window in half, take each half's
    price-low bar, compare price and RSI-at-that-bar across the two lows.
    """
    if len(closes) < n_rsi + window + 1:
        return False
    idxs = list(range(len(closes) - window, len(closes)))
    rsi_at = {i: _rsi(closes[: i + 1], n_rsi) for i in idxs}
    half = len(idxs) // 2
    older, recent = idxs[:half], idxs[half:]
    lo_o = min(older, key=lambda i: closes[i])
    lo_r = min(recent, key=lambda i: closes[i])
    if rsi_at.get(lo_o) is None or rsi_at.get(lo_r) is None:
        return False
    return closes[lo_r] < closes[lo_o] and rsi_at[lo_r] > rsi_at[lo_o]


def _capitulation(closes: list[float], volumes: list[float], lookback: int = 10) -> bool:
    """A volume climax at a recent price low — panic sellers flushed out in one
    go, a classic exhaustion/bottom tell. Volume at the lowest close of the last
    ``lookback`` days ran ≥2× the prior 20-day baseline."""
    if len(volumes) < 26:
        return False
    base = sum(volumes[-26:-6]) / 20
    if base <= 0:
        return False
    rc = closes[-lookback:]
    rv = volumes[-lookback:]
    lo_i = min(range(len(rc)), key=lambda i: rc[i])
    return rv[lo_i] >= 2.0 * base


# ---------------------------------------------------- Bollinger + MACD timing
#
# A BUY-ONLY entry-timing overlay on top of the funnel. The first five funnel
# stages already decided a name is a GOOD COMPANY; this layer only answers "is
# NOW a good price to buy it". Two setups, both accumulation-on-weakness:
#
#   Buy A — oversold bounce : price broke the lower band while MACD hit an
#           extreme trough (market oversold on a quality name = a discount). We
#           WAIT (埋伏) while it may still fall, then TRIGGER (扣扳机) once the
#           rebound-momentum score confirms sellers are exhausted.
#   Buy B — pullback after strength : it rode ABOVE the upper band (overheated),
#           took its brief profit-taking dip back INTO the bands, and the uptrend
#           structure held — buy that discount, don't chase the breakout.
#
# Everything here is deterministic Python off the daily closes/volumes — no LLM,
# no extra fetch. Thresholds are module constants so they're easy to tune.

# Timing thresholds — the tunable knobs.
_MACD_EXTREME_Z = -1.5     # MACD histogram z-score at/below this = "extremely negative"
_REBOUND_TRIGGER = 50      # rebound-momentum score (with a confirmed turn) to fire Buy-A (扣扳机)
_LOWER_BAND_TOUCH = 0.05   # %B at/below this = at/through the lower band
_UPPER_BAND_BREAK = 1.0    # %B above this = above the upper band (overheated)
_MID_STREAK_DAYS = 5       # consecutive days above MA20 to confirm momentum
_SQUEEZE_PCTL = 0.20       # bandwidth in the bottom 20% of its 120d range = squeeze


def _pctl_rank(xs: list[float], v: float) -> float:
    """Fraction of xs at or below v (0-1) — v's own percentile within the series."""
    if not xs:
        return 0.5
    return sum(1 for x in xs if x <= v) / len(xs)


def _trend_regime(closes: list[float]) -> str:
    """up / down / range from price vs a rising/falling MA50 (MA200 as a tie-break).
    A label only — it NEVER vetoes a buy (quality names are bought on weakness)."""
    price = closes[-1]
    ma50 = _sma(closes, 50)
    ma50_prev = _sma(closes[:-5], 50)
    if ma50 is None or ma50_prev is None or ma50 == 0:
        return "range"
    slope = (ma50 - ma50_prev) / ma50  # MA50 must actually be sloping, not flat noise
    if price > ma50 and slope > 0.001:
        return "up"
    if price < ma50 and slope < -0.001:
        return "down"
    return "range"


def _rebound_momentum(
    closes: list[float],
    volumes: list[float],
    bb: dict,
    hists: list[float],
    rsi: float | None,
) -> tuple[int, dict]:
    """0-100 — how much STRENGTH a bounce off the lows has (the thing 'is the
    rebound strong?' actually asks). Weighted read of five exhaustion tells; a
    high score means sellers are done, not merely that price is low.

        30  MACD histogram turning up off its trough (+ how fast)
        25  RSI bullish divergence (price lower low, RSI higher low)
        20  %B reclaiming the lower band (mean-reversion actually underway)
        15  a capitulation volume climax at the recent low
        10  oversold depth (low RSI + stretched below MA50)
    """
    parts: dict[str, float] = {}

    # 30 — MACD histogram recovery off its recent trough. A base for the turn
    # itself (buying early is the point), then more as the recovery extends.
    macd_pts = 0.0
    if len(hists) >= 3 and hists[-1] > hists[-2]:  # must be turning up
        trough = min(hists[-15:]) if len(hists) >= 15 else min(hists)
        span = abs(trough) or 1e-9
        macd_pts = 16 + _clamp((hists[-1] - trough) / span, 0.0, 1.0) * 14
    parts["macd_upturn"] = round(macd_pts, 1)

    # 25 — RSI bullish divergence (binary, but it's the strongest single tell).
    div = _bullish_divergence(closes)
    parts["rsi_divergence"] = 25.0 if div else 0.0

    # 20 — %B reclaiming the band: rising and back above the lower rail.
    pb = bb["pctb"]
    prev_bb = _bollinger(closes[:-5]) if len(closes) >= 25 else None
    reclaiming = prev_bb is not None and pb > prev_bb["pctb"] and pb > 0
    parts["reclaim"] = round(_clamp(pb / 0.35, 0.0, 1.0) * 20, 1) if reclaiming else 0.0

    # 15 — capitulation volume climax at the low.
    parts["capitulation"] = 15.0 if _capitulation(closes, volumes) else 0.0

    # 10 — oversold depth: low RSI + how far price is stretched below MA50.
    depth = 0.0
    if rsi is not None:
        depth += _clamp((35 - rsi) / 20, 0.0, 1.0) * 0.6
    ma50 = _sma(closes, 50)
    if ma50 and closes[-1] < ma50:
        depth += _clamp((ma50 - closes[-1]) / ma50 / 0.15, 0.0, 1.0) * 0.4
    parts["oversold_depth"] = round(depth * 10, 1)

    score = int(round(sum(parts.values())))
    return _clamp(score, 0, 100), parts


# Human-readable state labels (the badge text).
_TIMING_LABEL = {
    "strong_buy": "强买入",
    "band_break": "跌破下轨",
    "oversold_watch": "超卖埋伏",
    "pullback_buy": "强势回踩",
    "momentum": "动能确定",
    "breakdown": "破位·减仓",
    "trim": "减仓预警",
    "overheated": "过热·等回落",
    "neutral": "观望",
}
# Sort key for "best entry right now" — higher = buy sooner. Sell states carry a
# LOW base (they're not buys); within their own tab they re-sort by breakdown
# severity (set on `score` below).
_TIMING_BASE = {
    "strong_buy": 85,
    "band_break": 62,
    "pullback_buy": 70,
    "momentum": 58,
    "oversold_watch": 45,
    "neutral": 50,
    "breakdown": 30,
    "trim": 20,
    "overheated": 25,
}


def _breakdown_volume(closes: list[float], volumes: list[float], lookback: int = 5) -> bool:
    """A recent DOWN day on expanded volume — distribution as the trend cracks."""
    if len(volumes) < 26:
        return False
    base = sum(volumes[-26:-6]) / 20
    if base <= 0:
        return False
    for i in range(-lookback, 0):
        if closes[i] < closes[i - 1] and volumes[i] >= 1.5 * base:
            return True
    return False


def _breakdown_momentum(highs, lows, closes, volumes, bb: dict, hists: list[float], line: float, signal: float) -> tuple[int, dict]:
    """0-100 — how decisively the uptrend is breaking DOWN through the MA20 middle
    band (the mirror of _rebound_momentum). Higher = trend more broken.

        30  MACD rolling over (falling histogram + death cross)
        20  distance price has slipped below MA20 (in ATR)
        20  MA20 itself rolling over (slope turning down)
        15  price lost the MA50
        15  volume expansion on the breakdown
    """
    parts: dict[str, float] = {}
    mid = bb["middle"]
    price = closes[-1]

    macd_pts = 0.0
    if len(hists) >= 2 and hists[-1] < hists[-2]:  # histogram falling = momentum down
        macd_pts = 14.0
        if line < signal:  # death cross
            macd_pts += 10.0
        peak = max((abs(h) for h in hists[-15:]), default=0.0) or 1e-9
        macd_pts += _clamp(-hists[-1] / peak, 0.0, 1.0) * 6
    parts["macd_down"] = round(macd_pts, 1)

    atr = _atr(highs, lows, closes)
    parts["below_mid_depth"] = round(_clamp((mid - price) / atr / 2.0, 0.0, 1.0) * 20, 1) if (atr and mid and price < mid) else 0.0

    mid_prev = _sma(closes[:-5], 20)
    roll = 0.0
    if mid and mid_prev:
        slope = (mid - mid_prev) / mid
        roll = _clamp(-slope / 0.02, 0.0, 1.0) * 20  # −2% over 5d = full marks
    parts["ma20_roll"] = round(roll, 1)

    ma50 = _sma(closes, 50)
    parts["below_ma50"] = 15.0 if (ma50 and price < ma50) else 0.0
    parts["breakdown_vol"] = 15.0 if _breakdown_volume(closes, volumes) else 0.0

    return int(_clamp(sum(parts.values()), 0, 100)), parts


def compute_timing(highs, lows, closes, volumes, p: TechParams) -> dict | None:
    """The Bollinger+MACD entry-timing state for one ticker (see section header)."""
    if len(closes) < 40:
        return None
    bb = _bollinger(closes)
    macd = _macd_full(closes)
    if bb is None or macd is None:
        return None
    hists = macd["hists"]
    rsi = _rsi(closes)

    # MACD extremity (z-score of the histogram over ~120d) + its turn.
    hwin = hists[-120:]
    hmean = sum(hwin) / len(hwin)
    hsd = (sum((x - hmean) ** 2 for x in hwin) / len(hwin)) ** 0.5
    hist_z = (hists[-1] - hmean) / hsd if hsd else 0.0
    # "Recently hit an extreme trough" — NOT "is extreme right now". The rebound
    # score only builds AFTER the bottom, so pairing it with the current bar being
    # extreme is self-contradictory; we key off the deepest histogram of the last
    # ~10 sessions instead, which is what "the capitulation just happened" means.
    recent_hist_min = min(hists[-10:])
    hist_min_z = (recent_hist_min - hmean) / hsd if hsd else 0.0
    macd_extreme = hist_min_z <= _MACD_EXTREME_Z
    line, signal = macd["lines"][-1], macd["signals"][-1]
    cross = "bull" if line > signal else "bear"

    bwseries = _bandwidth_series(closes)
    squeeze = bool(bwseries) and _pctl_rank(bwseries, bb["bandwidth"]) <= _SQUEEZE_PCTL

    pbs = _pctb_series(closes)
    pb = bb["pctb"]
    touched_lower = bool(pbs) and min(pbs[-10:]) <= _LOWER_BAND_TOUCH
    was_above_upper = bool(pbs) and max(pbs[-10:]) > _UPPER_BAND_BREAK
    # consecutive trailing days above the MA20 middle band (%B > 0.5)
    mid_streak = 0
    for x in reversed(pbs):
        if x > 0.5:
            mid_streak += 1
        else:
            break

    rebound, rparts = _rebound_momentum(closes, volumes, bb, hists, rsi)
    regime = _trend_regime(closes)

    # A CONFIRMED TURN decides 埋伏 vs 扣扳机 (structure), while the rebound score
    # measures HOW STRONG the bounce is (magnitude / ranking). Keeping them
    # separate is the fix for the chicken-and-egg where the score only builds
    # after the extreme: we fire on the turn, then rank by strength.
    turning_up = len(hists) >= 2 and hists[-1] > hists[-2]
    reclaimed = pb > _LOWER_BAND_TOUCH  # price back above the lower rail
    confirmed_turn = turning_up and reclaimed

    # ── SELL side (de-risk WARNING, not a hard exit) — a break DOWN through the
    # MA20 middle band with short-term momentum turning down. Kept in the middle
    # zone only: the extreme-oversold zone (at/through the lower band) is a BUY,
    # never a sell, so the buy states below are checked FIRST and the sell states
    # can only fire when price has NOT reached the lower band.
    price = closes[-1]
    sma20 = bb["middle"]
    sma50 = _sma(closes, 50)
    sma20_prev = _sma(closes[:-5], 20)
    below_mid = pb < 0.5                                  # below the MA20 middle band
    below_mid_streak = 0
    for x in reversed(pbs):
        if x < 0.5:
            below_mid_streak += 1
        else:
            break
    ma20_rolling = sma20 is not None and sma20_prev is not None and sma20 <= sma20_prev
    below_ma50 = sma50 is not None and price < sma50
    macd_death = line < signal                            # death cross
    macd_weak = len(hists) >= 2 and hists[-1] < hists[-2]  # short-term momentum down
    # Confirmed break (loud warning) vs an early crack (soft warning). A healthy
    # pullback keeps MA20 RISING and price above MA50 → neither fires.
    breakdown_now = below_mid and below_mid_streak >= 2 and macd_death and (ma20_rolling or below_ma50)
    trim_now = below_mid and macd_weak and (ma20_rolling or macd_death)

    # State machine — checked in priority order. Breaking the lower band is, on a
    # name the funnel already vetted, treated as a DISCOUNT — a buy signal on its
    # own (band_break), no confirmed turn required. A confirmed turn on top of a
    # recent break upgrades it to the premium strong_buy.
    curr_below = pb <= _LOWER_BAND_TOUCH  # price at/through the lower band RIGHT NOW
    if pb > _UPPER_BAND_BREAK:
        state = "overheated"
    elif touched_lower and confirmed_turn and rebound >= _REBOUND_TRIGGER:
        state = "strong_buy"            # 扣扳机: broke the band, turned, bounce has strength
    elif curr_below:
        state = "band_break"            # 跌破下轨: below the lower band now = a buy on a vetted name
    elif touched_lower:
        state = "oversold_watch"        # 埋伏: broke recently, bouncing weakly / not yet confirmed
    elif breakdown_now:
        state = "breakdown"             # 破位·减仓: decisive MA20 break, momentum down, MA20 rolling
    elif was_above_upper and 0.3 < pb < 0.8 and regime != "down" and line > 0:
        state = "pullback_buy"          # Buy B — 强势回踩 (a healthy pullback, MA20 still up)
    elif trim_now:
        state = "trim"                  # 减仓预警: early crack below MA20, momentum weakening
    elif regime == "up" and line > 0 and mid_streak >= _MID_STREAK_DAYS and hists[-1] > 0:
        state = "momentum"              # real uptrend + MACD bull, not just above MA20 in chop
    else:
        state = "neutral"

    # Breakdown severity (0-100) — only meaningful for the two sell states.
    breakdown_score, bparts = (
        _breakdown_momentum(highs, lows, closes, volumes, bb, hists, line, signal)
        if state in ("breakdown", "trim") else (0, {})
    )

    # The concrete signals firing right now — the "receipts" for the state, shown
    # as chips so you can see WHY it's a buy (broke the band, MACD turned, etc.).
    # Ordered strongest-evidence first.
    signals: list[str] = []
    if curr_below:
        signals.append("band_break")       # price is BELOW the lower band RIGHT NOW (a true break)
    if macd_extreme:
        signals.append("macd_capitulation")  # MACD histogram at an extreme trough
    if turning_up:
        signals.append("macd_turn")        # MACD histogram turning up
    if rparts.get("rsi_divergence", 0) > 0:
        signals.append("rsi_divergence")   # price lower low, RSI higher low
    if rparts.get("capitulation", 0) > 0:
        signals.append("capitulation")     # volume climax at the low
    if touched_lower and not curr_below and pb > _LOWER_BAND_TOUCH:
        signals.append("reclaim")          # back above the lower rail
    if squeeze:
        signals.append("squeeze")          # Bollinger bandwidth compressed
    if was_above_upper and 0.3 < pb < 0.9:
        signals.append("pullback")         # eased back into the bands after a breakout
    if pb > _UPPER_BAND_BREAK:
        signals.append("above_upper")      # above the upper band (overheated)
    if regime == "up" and mid_streak >= _MID_STREAK_DAYS:
        signals.append("uptrend_hold")     # holding above MA20 in an uptrend
    # SELL-side receipts — only on the two sell states (so a death cross on an
    # oversold BUY name doesn't read as a sell).
    if state in ("breakdown", "trim"):
        if below_mid and below_mid_streak >= 1:
            signals.append("broke_ma20")       # closed below the MA20 middle band
        if macd_death:
            signals.append("macd_death_cross")  # MACD line crossed below signal
        elif macd_weak:
            signals.append("macd_weakening")   # short-term momentum turning down
        if ma20_rolling:
            signals.append("ma20_rolling")     # MA20 flattening / turning down
        if below_ma50:
            signals.append("below_ma50")       # lost the MA50 trend line
        if bparts.get("breakdown_vol", 0) > 0:
            signals.append("breakdown_volume")  # distribution — down day on heavy volume

    score = _TIMING_BASE[state]
    if state == "strong_buy":
        score = 85 + round(rebound * 0.15)          # 85-100
    elif state == "band_break":
        # A buy now; ranked by how much momentum is building + deeper capitulation
        # (MACD extreme) scores higher. Capped below strong_buy's 85 floor.
        score = min(84, 58 + round(rebound * 0.2) + (8 if macd_extreme else 0))
    elif state == "oversold_watch":
        score = 40 + round(rebound * 0.25)          # 40-65, ranks埋伏 by strength
    elif state == "pullback_buy":
        score = 68 + round(_clamp((0.6 - abs(pb - 0.5)) / 0.6, 0, 1) * 10)
    elif state in ("breakdown", "trim"):
        # Sells sort within their own tab by breakdown severity (higher = more
        # urgent to de-risk). Segregated from the buy tabs, so this never mixes.
        score = breakdown_score

    return {
        "timing": state,
        "label": _TIMING_LABEL[state],
        "score": int(_clamp(score, 0, 100)),
        "signals": signals,
        "rebound": rebound,
        "rebound_parts": rparts,
        "breakdown": breakdown_score,
        "breakdown_parts": bparts,
        "regime": regime,
        "squeeze": squeeze,
        "divergence": rparts.get("rsi_divergence", 0) > 0,
        "bb": {
            "upper": round(bb["upper"], 2),
            "middle": round(bb["middle"], 2),
            "lower": round(bb["lower"], 2),
            "pctb": round(pb, 3),
            "bandwidth": round(bb["bandwidth"], 4),
        },
        "macd": {
            "line": round(line, 3),
            "signal": round(signal, 3),
            "hist": round(hists[-1], 3),
            "hist_prev": round(hists[-2], 3) if len(hists) >= 2 else None,
            "hist_z": round(hist_z, 2),
            "cross": cross,
        },
    }


def timing_series(closes: list[float], tail: int = 60) -> dict | None:
    """Bollinger bands + MACD histogram over the last ``tail`` sessions, aligned
    to close_series, so the detail chart can draw the rails and the MACD subplot."""
    if len(closes) < 40:
        return None
    upper, middle, lower = [], [], []
    for i in range(len(closes) - tail + 1, len(closes) + 1):
        if i < 20:
            upper.append(None); middle.append(None); lower.append(None)
            continue
        bb = _bollinger(closes[:i])
        if bb is None:
            upper.append(None); middle.append(None); lower.append(None)
        else:
            upper.append(round(bb["upper"], 2))
            middle.append(round(bb["middle"], 2))
            lower.append(round(bb["lower"], 2))
    macd = _macd_full(closes)
    hist = [round(h, 3) for h in macd["hists"][-tail:]] if macd else []
    return {"upper": upper, "middle": middle, "lower": lower, "macd_hist": hist}


# ------------------------------------------------------------ attention signal


def compute_attention(highs, lows, closes, volumes, p: TechParams) -> dict:
    n = len(closes)
    price = closes[-1]

    v_short = sum(volumes[-p.rvol_short :]) / min(p.rvol_short, n)
    v_long = sum(volumes[-p.rvol_long :]) / min(p.rvol_long, n)
    rvol = (v_short / v_long) if v_long > 0 else None

    prior_high = max(highs[-(p.breakout_window + 1) : -1]) if n >= p.breakout_window + 1 else max(highs[:-1] or highs)
    new_high_20 = price >= prior_high
    win_high = max(highs[-p.breakout_window :])
    dist_to_high = (win_high - price) / win_high if win_high > 0 else None

    prior_52 = max(highs[-253:-1]) if n >= 253 else max(highs[:-1] or highs)
    new_high_52 = price >= prior_52

    obv = _obv(closes, volumes)
    obv_slope = _slope(obv[-p.obv_window :])
    obv_up = obv_slope > 0

    sma50 = _sma(closes, 50)
    sma50_prev = _sma(closes[:-5], 50)
    above50 = sma50 is not None and price > sma50
    sma50_up = sma50 is not None and sma50_prev is not None and sma50 > sma50_prev

    vol_s = _clamp(((rvol or 0) - 1) / 1.5, 0, 1)
    if new_high_20:
        bo_s = 1.0
    elif dist_to_high is not None:
        bo_s = _clamp(1 - dist_to_high / 0.10, 0, 1)
    else:
        bo_s = 0.0
    obv_s = 1.0 if obv_up else 0.0
    tr_s = 1.0 if (above50 and sma50_up) else (0.5 if above50 else 0.0)
    score = round(100 * (0.40 * vol_s + 0.25 * bo_s + 0.20 * obv_s + 0.15 * tr_s))

    if new_high_52 and rvol and rvol >= p.detonate_rvol:
        phase = "breakout"
    elif (
        rvol
        and rvol >= p.rvol_min
        and (new_high_20 or (dist_to_high is not None and dist_to_high <= p.near_high_pct))
        and obv_up
    ):
        phase = "igniting"
    elif obv_up and above50:
        phase = "accumulating"
    else:
        phase = "quiet"

    return {
        "score": score,
        "phase": phase,
        "ignites": phase in ("igniting", "breakout"),
        "rvol": round(rvol, 2) if rvol is not None else None,
        "new_high_20d": new_high_20,
        "new_high_52w": new_high_52,
        "dist_to_high": round(dist_to_high, 3) if dist_to_high is not None else None,
        "obv_up": obv_up,
        "above_sma50": above50,
        "sma50_rising": sma50_up,
    }


# --------------------------------------------------------------- gauge (display)


def _vote_osc(rsi, stoch, cci, wr, macd_hist, roc) -> tuple[int, int, int]:
    buy = sell = neut = 0

    def tally(v: int):
        nonlocal buy, sell, neut
        buy += v == 1
        sell += v == -1
        neut += v == 0

    if rsi is not None:
        tally(1 if rsi < 30 else -1 if rsi > 70 else 0)
    if stoch is not None:
        tally(1 if stoch < 20 else -1 if stoch > 80 else 0)
    if cci is not None:
        tally(1 if cci < -100 else -1 if cci > 100 else 0)
    if wr is not None:
        tally(1 if wr < -80 else -1 if wr > -20 else 0)
    if macd_hist is not None:
        tally(1 if macd_hist > 0 else -1)
    if roc is not None:
        tally(1 if roc > 0 else -1 if roc < 0 else 0)
    return buy, sell, neut


def compute_gauge(highs, lows, closes, p: TechParams) -> dict:
    price = closes[-1]
    ma_buy = ma_sell = 0
    for n in (5, 10, 20, 50, 100, 200):
        s = _sma(closes, n)
        if s is not None:
            ma_buy += price > s
            ma_sell += price <= s
        e = _ema_series(closes, n)
        if e and e[-1] is not None:
            ma_buy += price > e[-1]
            ma_sell += price <= e[-1]

    rsi = _rsi(closes)
    stoch = _stoch_k(highs, lows, closes)
    cci = _cci(highs, lows, closes)
    wr = _williams_r(highs, lows, closes)
    macd = _macd(closes)
    macd_hist = macd[2] if macd else None
    roc = 100 * (closes[-1] - closes[-13]) / closes[-13] if len(closes) >= 13 and closes[-13] else None
    osc_buy, osc_sell, osc_neut = _vote_osc(rsi, stoch, cci, wr, macd_hist, roc)

    buy = ma_buy + osc_buy
    sell = ma_sell + osc_sell
    total = buy + sell + osc_neut
    frac = (buy - sell) / total if total else 0.0
    if frac > 0.5:
        summary = "strong_buy"
    elif frac > 0.1:
        summary = "buy"
    elif frac < -0.5:
        summary = "strong_sell"
    elif frac < -0.1:
        summary = "sell"
    else:
        summary = "neutral"

    return {
        "summary": summary,
        "ma_buy": ma_buy,
        "ma_sell": ma_sell,
        "osc_buy": osc_buy,
        "osc_sell": osc_sell,
        "osc_neutral": osc_neut,
        "rsi": round(rsi, 1) if rsi is not None else None,
        "macd_hist": round(macd_hist, 3) if macd_hist is not None else None,
    }


def _buy_streak(highs, lows, closes, p: TechParams, max_days: int = 5) -> int:
    """How many of the most-recent trading days read Buy/Strong-Buy in a row.

    Recomputed retroactively from the daily series (no history file needed): for
    each of the last ``max_days`` days we re-run the mechanical gauge on the data
    *as it stood that day* and count consecutive Buy days ending today. A high
    streak = a sustained buy posture, not a one-day blip.
    """
    streak = 0
    for k in range(max_days):
        n = len(closes) - k
        if n < 50:
            break
        g = compute_gauge(highs[:n], lows[:n], closes[:n], p)
        if g["summary"] in ("buy", "strong_buy"):
            streak += 1
        else:
            break
    return streak


def compute_ticker(bars: dict, p: TechParams) -> dict | None:
    highs, lows, closes, volumes = bars["highs"], bars["lows"], bars["closes"], bars["volumes"]
    if len(closes) < 30:
        return None
    price = closes[-1]
    prev = closes[-2] if len(closes) >= 2 else price
    atr = _atr(highs, lows, closes)
    tail = 60
    out = {
        "price": round(price, 2),
        "change_pct": round(100 * (price - prev) / prev, 2) if prev else None,
        "atr_pct": round(100 * atr / price, 2) if atr and price else None,
        "sma20": round(_sma(closes, 20), 2) if _sma(closes, 20) else None,
        "sma50": round(_sma(closes, 50), 2) if _sma(closes, 50) else None,
        "sma200": round(_sma(closes, 200), 2) if _sma(closes, 200) else None,
        "days": len(closes),
        "attention": compute_attention(highs, lows, closes, volumes, p),
        "gauge": compute_gauge(highs, lows, closes, p),
        "buy_streak": _buy_streak(highs, lows, closes, p),
        "timing": compute_timing(highs, lows, closes, volumes, p),
        "fwd4w": compute_fwd4w(closes),
        "close_series": [round(c, 2) for c in closes[-tail:]],
        "vol_series": [int(v) for v in volumes[-tail:]],
        "band_series": timing_series(closes, tail),
    }
    return out


# ------------------------------------------------------ 0-4 week forward score
# Weighted by what newsagg.calibrate showed actually has forward power in this
# universe (1416 names, 29k samples, 68 dates): the 0-4 week edge is contrarian /
# mean-reversion — a name at/through the lower Bollinger band NOW earned +1.46%
# 4-week excess at a 70% hit rate, deep 20d drawdowns and 3-month laggards led —
# while trend regime, MACD momentum and a "confirmed" rebound carried no forward
# power (the rebound trigger was slightly negative: by the time the turn
# confirms, the fat part of the bounce is gone). So: reward being low in the
# bands and lagging; penalise overextended-and-fading; ignore the rest. Kept to
# five terms with fixed cut-offs to limit in-sample fitting. newsagg.calibrate
# imports THIS function, so every calibration tests exactly what ships.
_FWD4W_BAND_SPAN = 0.7  # %B at/above this scores 0 on band position; ≤ 0 scores full
_FWD4W_BELOW = 0.05  # %B at/below this = at/through the lower band now
_FWD4W_LAG_HI, _FWD4W_LAG_SPAN = 0.10, 0.40  # 3-month return ≥ +10% → 0 … ≤ −30% → full
_FWD4W_DIP_SPAN = 0.15  # ≥ 15% below the 20d high → full
_FWD4W_W = {"band": 45.0, "below": 10.0, "lag": 30.0, "dip": 15.0, "hot": -10.0}


def compute_fwd4w(closes: list[float]) -> dict | None:
    """0-100 score of how likely a name is to outperform over the next 0-4
    weeks, from closes only. Returns the score, its five parts, and the
    machine-readable signals that fired, or None when there isn't enough
    history (mirrors the calibrator's guards exactly)."""
    if len(closes) < 70 or closes[-1] <= 0:
        return None
    bb = _bollinger(closes)
    m = _macd_full(closes)
    if not bb or not m or len(m["hists"]) < 30:
        return None
    hists = m["hists"]
    pctb = bb["pctb"]
    mom63 = closes[-1] / closes[-64] - 1 if len(closes) > 64 and closes[-64] > 0 else 0.0
    dd20 = closes[-1] / max(closes[-20:]) - 1  # ≤ 0: how far below the 20d high
    parts = {
        "band": _FWD4W_W["band"] * _clamp((_FWD4W_BAND_SPAN - pctb) / _FWD4W_BAND_SPAN, 0.0, 1.0),
        "below": _FWD4W_W["below"] if pctb <= _FWD4W_BELOW else 0.0,
        "lag": _FWD4W_W["lag"] * _clamp((_FWD4W_LAG_HI - mom63) / _FWD4W_LAG_SPAN, 0.0, 1.0),
        "dip": _FWD4W_W["dip"] * _clamp(-dd20 / _FWD4W_DIP_SPAN, 0.0, 1.0),
        "hot": _FWD4W_W["hot"] if (pctb >= _UPPER_BAND_BREAK and hists[-1] < hists[-2]) else 0.0,
    }
    signals = []
    if parts["below"]:
        signals.append("at_lower_band")
    if parts["lag"] >= _FWD4W_W["lag"] * 0.5:
        signals.append("laggard_3m")
    if parts["dip"] >= _FWD4W_W["dip"] * 0.5:
        signals.append("deep_dip_20d")
    if parts["hot"]:
        signals.append("overextended_fading")
    return {
        "score": _clamp(sum(parts.values()), 0.0, 100.0),
        "parts": {k: round(v, 1) for k, v in parts.items()},
        "signals": signals,
        "pctb": round(pctb, 3),
        "mom63": round(mom63, 4),
        "dd20": round(dd20, 4),
    }


# ---------------------------------------------------------------------- fetch


def _fetch_bars(ticker: str) -> dict | None:
    import yfinance as yf

    df = yf.Ticker(ticker.replace(".", "-")).history(period="1y", auto_adjust=False)
    if df is None or df.empty:
        return None
    highs, lows, closes, volumes, dates = [], [], [], [], []
    for ts, h, low, c, v in zip(df.index, df["High"], df["Low"], df["Close"], df["Volume"]):
        if c != c or v != v:  # skip NaN rows
            continue
        highs.append(float(h))
        lows.append(float(low))
        closes.append(float(c))
        volumes.append(float(v))
        dates.append(ts.date().isoformat() if hasattr(ts, "date") else str(ts)[:10])
    return {"highs": highs, "lows": lows, "closes": closes, "volumes": volumes, "dates": dates}


def _fast_quote(ticker: str) -> tuple[float, float] | None:
    """(last_price, previous_close) from yfinance fast_info — a stable, purpose-
    built live price + official prior close. Unlike the tail of a 1y daily
    history (whose last bar flickers intraday — sometimes today's partial print,
    sometimes not), these two fields are consistent, so the header price and the
    day's % never jump around."""
    import yfinance as yf

    try:
        fi = yf.Ticker(ticker.replace(".", "-")).fast_info
        lp = fi.last_price
        pc = fi.previous_close
        lp = float(lp) if lp is not None else 0.0
        pc = float(pc) if pc is not None else 0.0
        if lp > 0 and pc > 0:
            return lp, pc
    except Exception:  # noqa: BLE001
        return None
    return None


def live_ticker(ticker: str, p: TechParams | None = None) -> dict | None:
    """Technicals computed against the LIVE price. Splices the reliable fast_info
    price onto the daily series as the provisional latest close, so the header
    price, the day's %, %B, and every timing signal are all consistent and
    current — instead of reading an unreliable intraday tail bar. Falls back to
    the plain daily computation when fast_info is unavailable."""
    p = p or TechParams()
    bars = _fetch_bars(ticker)
    if not bars or len(bars["closes"]) < 30:
        return None
    closes = bars["closes"]
    # Median of the last 20 closes = a robust magnitude anchor for this stock.
    _recent = sorted(closes[-20:])
    anchor = _recent[len(_recent) // 2]
    fq = _fast_quote(ticker)
    if fq and anchor > 0 and abs(fq[0] - anchor) / anchor > 0.35:
        fq = None  # fast_info returned a wrong-ticker price → fall back to daily bars
    if fq:
        live_price, prev_close = fq
        # Last daily bar == the official prior close → series ends yesterday, so
        # APPEND the live price as today. Else the last bar is today's partial →
        # OVERWRITE it with the live price. Either way the series ends at `live`.
        if abs(closes[-1] - prev_close) <= max(1e-4, prev_close * 1e-5):
            bars["highs"].append(max(live_price, closes[-1]))
            bars["lows"].append(min(live_price, closes[-1]))
            bars["closes"].append(live_price)
            bars["volumes"].append(bars["volumes"][-1] if bars["volumes"] else 0.0)
        else:
            bars["closes"][-1] = live_price
            bars["highs"][-1] = max(bars["highs"][-1], live_price)
            bars["lows"][-1] = min(bars["lows"][-1], live_price)
        out = compute_ticker(bars, p)
        if out:
            out["price"] = round(live_price, 2)
            out["change_pct"] = round(100 * (live_price - prev_close) / prev_close, 2)
        return out
    return compute_ticker(bars, p)


# Yahoo throttles a burst of a thousand requests, and its symptom is a silent
# EMPTY frame (not an error) — so a single attempt per ticker drops almost the
# whole universe at once. Retry each empty/failed fetch with backoff, keep the
# pool modest, and stagger submissions so we stay under the limit rather than
# trip it. Tunable via env: TECH_WORKERS, TECH_FETCH_ATTEMPTS.
_FETCH_ATTEMPTS = 3
_FETCH_BACKOFF_S = 2.0  # 2s, then 4s (+ jitter) between attempts
_FETCH_STAGGER_S = 0.15  # small pause before each fetch to smooth the rate


def build_technical(tickers: list[str], p: TechParams | None = None, workers: int = 4) -> tuple[dict, dict]:
    """Returns (technicals, price_history) — the second is dated 1y closes per
    ticker for the tracker (return-since-Day-1 for any date)."""
    import os
    import random
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed

    p = p or TechParams()
    workers = int(os.environ.get("TECH_WORKERS", workers))
    attempts = int(os.environ.get("TECH_FETCH_ATTEMPTS", _FETCH_ATTEMPTS))

    def one(t: str) -> tuple[str, dict | None, dict | None]:
        bars = None
        for attempt in range(attempts):
            time.sleep(_FETCH_STAGGER_S)
            try:
                bars = _fetch_bars(t)
            except Exception:  # noqa: BLE001
                bars = None
            # A non-empty series is a real answer (even a short one — a new IPO
            # legitimately has < 30 bars and must NOT be retried). Empty/None is
            # the throttle signature, so back off and try again.
            if bars and bars["closes"]:
                break
            if attempt < attempts - 1:
                time.sleep(_FETCH_BACKOFF_S * (2**attempt) + random.uniform(0, 0.5))
        try:
            tech = compute_ticker(bars, p) if bars else None
        except Exception:  # noqa: BLE001
            return t, None, None
        hist = None
        if bars and len(bars["closes"]) >= 2 and bars.get("dates"):
            # Volumes ride along (aligned with closes — _fetch_bars drops NaN
            # rows for both together) so newsagg.calibrate can test the
            # attention components (rvol / OBV), which it can't from closes.
            hist = {
                "dates": bars["dates"],
                "closes": [round(c, 4) for c in bars["closes"]],
                "volumes": [int(v) for v in bars["volumes"]],
            }
        return t, tech, hist

    out: dict[str, dict] = {}
    hist_out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(one, t) for t in tickers]
        for i, fut in enumerate(as_completed(futures), 1):
            t, res, hist = fut.result()
            if res:
                out[t] = res
            if hist:
                hist_out[t] = hist
            if i % 40 == 0:
                logger.info("  %d/%d…", i, len(tickers))
    return out, hist_out


def main() -> int:
    ap = argparse.ArgumentParser(description="Compute price-volume attention + technical gauge (yfinance)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override (e.g. FORM,IREN)")
    ap.add_argument("--recheck", action="store_true", help="ignore the no-price skip-list and re-fetch the whole universe (re-validates relisted names)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    manual = bool(args.tickers)
    if manual:
        universe = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        universe = seed_tickers(settings.output_dir)
    if not universe:
        logger.warning("no tickers (run the SA scrape first, or pass --tickers)")
        return 1

    # Skip tickers Yahoo has already confirmed it can't price (delisted/OTC/.CA),
    # so a full run doesn't burn minutes re-failing hundreds of dead names. Only
    # on the full-universe pass (a manual --tickers run fetches exactly what's asked).
    dead = load_dead_tickers(settings.output_dir)
    # First run after this feature ships: seed the skip-list from the last run's
    # no_data so the very next run is already fast (no need to re-learn the dead).
    if not dead and not manual:
        try:
            prev = json.loads((settings.output_dir / TECHNICAL_FILE).read_text())
            dead = {str(t).upper() for t in (prev.get("no_data") or [])}
        except (OSError, ValueError):
            dead = set()
    if not manual and not args.recheck and dead:
        tickers = [t for t in universe if t not in dead]
        logger.info("skipping %d known no-price tickers (--recheck to re-validate)", len(universe) - len(tickers))
    else:
        tickers = universe

    logger.info("computing technicals for %d tickers…", len(tickers))
    tech, history = build_technical(tickers)
    out_path = settings.output_dir / TECHNICAL_FILE

    if not tech:
        if out_path.exists():
            logger.warning("computed 0 technicals (network?); keeping existing file")
        else:
            logger.warning(
                "computed 0 technicals and no existing file — is Yahoo reachable? "
                "try: HTTPS_PROXY=http://127.0.0.1:<port> python -m newsagg.technical"
            )
        return 1

    # MERGE with the existing snapshot so a partial run (network flake, rate
    # limit, a collapsed seed) only refreshes the names it actually fetched and
    # never wipes the ones it couldn't reach — a run that came back with ONE
    # ticker used to overwrite a 700-ticker snapshot. Back the old file up
    # first (technical_latest.bak.json) so a bad run is always recoverable.
    existing_tech: dict = {}
    if out_path.exists():
        try:
            raw_prev = out_path.read_text()
            existing_tech = json.loads(raw_prev).get("tickers", {}) or {}
            out_path.with_suffix(".bak.json").write_text(raw_prev)
        except (OSError, ValueError):
            existing_tech = {}
    merged = {**existing_tech, **tech}
    if not manual and existing_tech and len(tech) < max(10, len(existing_tech) // 2):
        logger.warning(
            "only %d/%d technicals fetched vs %d already stored — keeping the prior "
            "entries for the names this run couldn't reach",
            len(tech), len(tickers), len(existing_tech),
        )

    # no-data over the FULL universe — names with NO snapshot at all (neither
    # fetched now nor carried over) stay hidden in the UI.
    no_data = sorted(set(universe) - set(merged.keys()))
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tickers": merged,
        "no_data": no_data,
    }
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload))

    # Update the persistent no-price skip-list (full-universe runs only — this is
    # the authoritative price pass). A ticker we FETCHED but got nothing for is
    # parked; --recheck rebuilds the list from scratch so relisted names return.
    # BUT only trust this run's failures if the run itself was healthy: a run
    # that lost most of what it tried (Yahoo outage / rate limit / no network)
    # says nothing about which names are delisted, and parking them all makes
    # every following run skip the whole universe — one bad --recheck marked
    # 1170 live names dead and pinned the snapshot at a single ticker.
    if not manual:
        newly_dead = set(tickers) - set(tech.keys())
        healthy = len(tech) >= max(1, len(tickers) // 2)
        if not healthy:
            logger.warning(
                "run fetched only %d/%d — not updating the no-price skip-list "
                "(looks like an outage, not delistings)",
                len(tech), len(tickers),
            )
        else:
            new_dead = (newly_dead if args.recheck else (dead | newly_dead)) & set(universe)
            save_dead_tickers(settings.output_dir, new_dead)
            added = len(newly_dead - dead)
            logger.info("no-price skip-list: %d tickers (%+d this run)", len(new_dead), added)

    # Dated 1y close history for the tracker (return-since-Day-1). Merge with any
    # existing file so a name that failed this run keeps its prior history.
    if history:
        hist_path = settings.output_dir / PRICE_HISTORY_FILE
        try:
            existing = json.loads(hist_path.read_text()).get("tickers", {}) if hist_path.exists() else {}
        except ValueError:
            existing = {}
        existing.update(history)
        hist_path.write_text(json.dumps({"generated_at": payload["generated_at"], "tickers": existing}))
        logger.info("wrote price history for %d tickers", len(existing))

    # Benchmark daily history alongside (one request), so newsagg.calibrate can
    # split its results by MARKET REGIME offline — dips behave differently when
    # the tape is above vs below its 50-day MA. Keep the old file on a miss.
    if not manual:
        try:
            bench = _fetch_bars(BENCHMARK_TICKER)
        except Exception:  # noqa: BLE001
            bench = None
        if bench and bench.get("dates"):
            (settings.output_dir / BENCHMARK_FILE).write_text(
                json.dumps(
                    {
                        "generated_at": payload["generated_at"],
                        "ticker": BENCHMARK_TICKER,
                        "dates": bench["dates"],
                        "closes": [round(c, 4) for c in bench["closes"]],
                        "volumes": [int(v) for v in bench["volumes"]],
                    }
                )
            )
            logger.info("wrote %s benchmark history (%d bars)", BENCHMARK_TICKER, len(bench["dates"]))
        else:
            logger.warning("benchmark %s fetch failed — keeping the previous benchmark file (if any)", BENCHMARK_TICKER)

    logger.info("wrote technicals for %d/%d tickers", len(tech), len(tickers))
    print(f"technicals: {len(tech)}/{len(tickers)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
