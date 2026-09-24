"""Tests for the Heat Signal computation."""

from newsagg.heat import HeatParams, compute_ticker_heat

P = HeatParams()


def test_flat_series_is_dead():
    # Steady mentions around 40 → z ~0 → dead water.
    out = compute_ticker_heat([40] * 40, P)
    assert out["phase"] == "dead"
    assert out["z"] is not None and abs(out["z"]) < 0.5


def test_ultra_low_coverage():
    # Median mentions below 5 → ultra-low, bypasses heat regardless of z.
    out = compute_ticker_heat([1, 0, 2, 1, 3, 0, 1, 2, 1, 0, 2, 1], P)
    assert out["phase"] == "ultralow"


def test_spike_detonates():
    # Long calm baseline then a big spike today → z well above 2.0.
    series = [30] * 40 + [400]
    out = compute_ticker_heat(series, P)
    assert out["z"] is not None and out["z"] >= P.z_high
    assert out["phase"] == "detonate"


def test_rising_ramp_is_hot_in_band():
    # Calm baseline, then a mild 3-day ramp landing in the [0.5, 2.0) band with
    # positive velocity → "ignite" or "watch" (never dead/detonate).
    series = [30] * 40 + [40, 48, 55]
    out = compute_ticker_heat(series, P)
    assert out["z"] is not None
    assert P.z_low <= out["z"] < P.z_high, out["z"]
    assert out["vel"] is not None and out["vel"] >= P.vel_threshold
    assert out["phase"] in ("ignite", "watch")


def test_warming_when_too_short():
    # Fewer than min_days of baseline → no z yet → warming.
    out = compute_ticker_heat([30, 35, 40], P)
    assert out["phase"] == "warming"
    assert out["z"] is None
    assert out["days"] == 3
