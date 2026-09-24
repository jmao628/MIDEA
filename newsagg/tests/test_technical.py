"""Tests for the price-volume attention + technical gauge computation.

The indicators are deterministic arithmetic, so we assert on constructed
series where the expected signal is unambiguous.
"""

import math

from newsagg.technical import (
    TechParams,
    _bollinger,
    _macd_full,
    _obv,
    _rsi,
    compute_attention,
    compute_gauge,
    compute_ticker,
    compute_timing,
)

P = TechParams()


def _flat(n: int, price: float = 50.0, vol: float = 1_000_000.0):
    highs = [price * 1.01] * n
    lows = [price * 0.99] * n
    closes = [price] * n
    vols = [vol] * n
    return highs, lows, closes, vols


def test_rsi_all_gains_is_100():
    # A monotonically rising series has no losses → RSI pins at 100.
    closes = [float(i) for i in range(1, 40)]
    assert _rsi(closes) == 100.0


def test_obv_tracks_direction():
    closes = [10, 11, 12, 11]  # up, up, down
    vols = [100, 200, 300, 400]
    obv = _obv(closes, vols)
    assert obv == [0, 200, 500, 100]  # +200 +300 -400


def test_flat_series_does_not_ignite():
    highs, lows, closes, vols = _flat(120)
    a = compute_attention(highs, lows, closes, vols, P)
    assert a["ignites"] is False
    assert a["phase"] in ("quiet", "accumulating")
    assert a["rvol"] is not None and abs(a["rvol"] - 1.0) < 0.01


def test_volume_breakout_ignites():
    # Gentle uptrend, then the last 3 days break to new highs on 3x volume.
    n = 260
    closes, highs, lows, vols = [], [], [], []
    price = 20.0
    for i in range(n):
        price *= 1.0 + 0.0015 + 0.02 * math.sin(i / 9)
        closes.append(price)
        highs.append(price * 1.01)
        lows.append(price * 0.99)
        vols.append(1_000_000.0)
    for k in (3, 2, 1):
        closes[-k] = closes[-4] * (1.03 + 0.02 * (3 - k))
        highs[-k] = closes[-k] * 1.01
        lows[-k] = closes[-k] * 0.985
        vols[-k] = 1_000_000.0 * (2.5 + 0.8 * (3 - k))
    a = compute_attention(highs, lows, closes, vols, P)
    assert a["ignites"] is True
    assert a["phase"] in ("igniting", "breakout")
    assert a["new_high_20d"] is True
    assert a["obv_up"] is True
    assert a["rvol"] is not None and a["rvol"] >= P.rvol_min


def test_gauge_summary_is_a_known_bucket():
    highs, lows, closes, _ = _flat(220, price=50.0)
    # nudge into a mild uptrend so MAs disagree a bit
    closes = [50 + i * 0.05 for i in range(220)]
    highs = [c * 1.01 for c in closes]
    lows = [c * 0.99 for c in closes]
    g = compute_gauge(highs, lows, closes, P)
    assert g["summary"] in ("strong_buy", "buy", "neutral", "sell", "strong_sell")
    assert g["rsi"] is None or 0.0 <= g["rsi"] <= 100.0


def test_compute_ticker_shape():
    highs, lows, closes, vols = _flat(120)
    out = compute_ticker(
        {"highs": highs, "lows": lows, "closes": closes, "volumes": vols}, P
    )
    assert out is not None
    for key in ("price", "attention", "gauge", "close_series", "vol_series"):
        assert key in out
    assert len(out["close_series"]) <= 60


def test_too_short_history_is_none():
    highs, lows, closes, vols = _flat(10)
    assert compute_ticker(
        {"highs": highs, "lows": lows, "closes": closes, "volumes": vols}, P
    ) is None


# ---- Bollinger + MACD entry-timing layer ------------------------------------


def test_bollinger_pctb_at_middle_is_half():
    # A flat series sits exactly on its MA20 → %B == 0.5, and with zero variance
    # the band collapses (bandwidth 0).
    closes = [50.0] * 60
    bb = _bollinger(closes)
    assert bb is not None
    assert abs(bb["pctb"] - 0.5) < 1e-9
    assert bb["bandwidth"] == 0.0


def test_bollinger_pctb_below_lower_when_price_dumps():
    closes = [50.0] * 40 + [50 - i for i in range(1, 6)]  # sharp drop off a flat base
    bb = _bollinger(closes)
    assert bb is not None
    assert bb["pctb"] < 0  # price broke below the lower rail


def test_macd_full_returns_aligned_series():
    closes = [20 + i * 0.1 for i in range(120)]
    m = _macd_full(closes)
    assert m is not None
    assert len(m["lines"]) == len(m["signals"]) == len(m["hists"])
    assert len(m["hists"]) > 0


def test_timing_oversold_bounce_scores_and_labels():
    # Uptrend, then a deep flush to a new low, then a sharp reclaim on heavy
    # volume — the oversold-bounce setup. Assert the engine produces a valid
    # state, a 0-100 rebound score, and the band/MACD payloads.
    n = 200
    closes, highs, lows, vols = [], [], [], []
    price = 30.0
    for i in range(n):
        price *= 1.004
        closes.append(price); highs.append(price * 1.01); lows.append(price * 0.99); vols.append(1_000_000.0)
    # a 6-day flush, capitulation volume on the low, then a 3-day snap-back
    for k, mult in zip(range(6, 0, -1), (0.97, 0.96, 0.95, 0.955, 0.98, 1.02)):
        closes[-k] = closes[-7] * mult
        highs[-k] = closes[-k] * 1.01
        lows[-k] = closes[-k] * 0.98
        vols[-k] = 1_000_000.0 * (3.0 if mult < 0.96 else 1.2)
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] in _all_timing_states()
    assert 0 <= t["rebound"] <= 100
    assert 0 <= t["score"] <= 100
    assert t["regime"] in ("up", "down", "range")
    assert set(t["bb"]) >= {"upper", "middle", "lower", "pctb", "bandwidth"}
    assert set(t["macd"]) >= {"line", "signal", "hist", "hist_z", "cross"}


def test_compute_ticker_includes_timing_and_bands():
    n = 120
    closes = [20 + 5 * math.sin(i / 8) + i * 0.05 for i in range(n)]
    highs = [c * 1.02 for c in closes]
    lows = [c * 0.98 for c in closes]
    vols = [1_000_000.0 + 50_000 * math.sin(i / 5) for i in range(n)]
    out = compute_ticker({"highs": highs, "lows": lows, "closes": closes, "volumes": vols}, P)
    assert out is not None
    assert out["timing"] is not None
    assert out["timing"]["timing"] in _all_timing_states()
    assert out["band_series"] is not None
    assert len(out["band_series"]["middle"]) == len(out["close_series"])


def test_timing_sharp_v_bounce_is_strong_buy():
    # A deep 4-day flush through the lower band on climax volume, then a hard
    # 3-day rip back: oversold + a confirmed MACD turn + strong rebound = 扣扳机.
    closes, vols, p = [], [], 50.0
    for _ in range(170):
        p *= 1.003
        closes.append(p); vols.append(1_000_000.0)
    for i in range(4):
        p *= 0.955
        closes.append(p); vols.append(1_000_000.0 * (3.5 if i == 3 else 1.5))
    for _ in range(3):
        p *= 1.03
        closes.append(p); vols.append(1_600_000.0)
    highs = [c * 1.015 for c in closes]
    lows = [c * 0.985 for c in closes]
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] == "strong_buy"
    assert t["rebound"] >= 50
    assert t["score"] >= 85


def test_timing_flat_series_is_neutral():
    # No trend, no oversold flush → no buy signal (guards the momentum gate from
    # firing on noise that merely drifts above MA20).
    closes = [50.0 + math.sin(i / 3) * 0.2 for i in range(160)]
    highs = [c * 1.01 for c in closes]
    lows = [c * 0.99 for c in closes]
    vols = [1_000_000.0] * len(closes)
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] == "neutral"


def test_timing_steady_uptrend_is_momentum():
    closes = [20 + i * 0.15 for i in range(160)]
    highs = [c * 1.01 for c in closes]
    lows = [c * 0.99 for c in closes]
    vols = [1_000_000.0] * len(closes)
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] == "momentum"


def test_timing_below_lower_band_is_a_buy():
    # Price sitting below its lower Bollinger band right now reads as band_break —
    # a buy signal on its own (a vetted name at a discount), no confirmed turn
    # required. Uptrend base, then a clean multi-day slide that ends below the band.
    closes, vols, p = [], [], 40.0
    for _ in range(180):
        p *= 1.004
        closes.append(p); vols.append(1_000_000.0)
    for _ in range(6):  # steady slide that leaves price under the lower rail today
        p *= 0.97
        closes.append(p); vols.append(1_300_000.0)
    highs = [c * 1.01 for c in closes]
    lows = [c * 0.99 for c in closes]
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["bb"]["pctb"] <= 0.05  # actually below the band
    assert t["timing"] == "band_break"
    assert TIMING_META_BUY(t["timing"])  # a buy-tone state


def TIMING_META_BUY(state: str) -> bool:
    return state in {"strong_buy", "band_break", "pullback_buy"}


def test_timing_ma20_breakdown_is_a_sell():
    # Strong uptrend then a break down through the MA20 middle band with MACD
    # rolling over (but not yet all the way to the lower band) → a de-risk SELL
    # warning (trim or breakdown), carrying the MA20-break receipt.
    closes, p = [], 40.0
    for _ in range(150):
        p *= 1.005
        closes.append(p)
    for _ in range(6):  # a gentle 6-day slide below MA20, momentum turning down
        p *= 0.994
        closes.append(p)
    highs = [c * 1.015 for c in closes]
    lows = [c * 0.985 for c in closes]
    vols = [1_000_000.0] * len(closes)
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] in ("trim", "breakdown")
    assert "broke_ma20" in t["signals"]
    assert t["breakdown"] >= 0


def test_timing_deep_dip_stays_buy_not_sell():
    # A deep dip all the way through the lower band is the EXTREME-oversold zone —
    # a BUY on a vetted name, never a sell.
    closes, p = [], 40.0
    for _ in range(180):
        p *= 1.004
        closes.append(p)
    for _ in range(6):
        p *= 0.97
        closes.append(p)
    highs = [c * 1.01 for c in closes]
    lows = [c * 0.99 for c in closes]
    vols = [1_000_000.0] * len(closes)
    t = compute_timing(highs, lows, closes, vols, P)
    assert t is not None
    assert t["timing"] in ("band_break", "strong_buy", "oversold_watch")  # a buy zone
    assert t["timing"] not in ("trim", "breakdown")


def _all_timing_states():
    return {
        "strong_buy", "band_break", "oversold_watch", "pullback_buy", "momentum",
        "breakdown", "trim", "overheated", "neutral",
    }
