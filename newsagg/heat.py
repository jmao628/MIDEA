"""Heat Signal — turn each ticker's daily mention series into z / velocity /
acceleration / phase, per the SuperBeta framework (Stage 2).

Ape Wisdom only exposes today's snapshot, so we accumulate it daily into a
history store (``mentions_history.json``) and compute z-scores off the growing
series. Heat gets more reliable as history builds; below ``min_days`` a ticker
is marked "warming".

Run daily (after the SA scrape):
    python -m newsagg.heat            # fetch Ape Wisdom, store, recompute
    python -m newsagg.heat --no-fetch # just recompute from stored history
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from math import log
from pathlib import Path

from newsagg.collectors.apewisdom import ApeWisdomCollector
from newsagg.config import Settings, load_settings
from newsagg.http import get_client

logger = logging.getLogger("newsagg.heat")

HISTORY_FILE = "mentions_history.json"
HEAT_FILE = "heat_latest.json"
MAX_HISTORY = 120  # days of mention history to retain per ticker


@dataclass
class HeatParams:
    window: int = 60  # baseline lookback (days)
    sigma_floor: float = 0.35
    z_low: float = 0.5  # ignition line
    z_high: float = 2.0  # detonation line
    vel_threshold: float = 0.15
    vel_window: int = 3
    ultra_low: int = 5  # median mentions below this => ultra-low coverage
    min_days: int = 8  # need at least this many baseline points for a z


def _median(xs: list[float]) -> float:
    return statistics.median(xs) if xs else 0.0


def _mad_sigma(xs: list[float], mu: float) -> float:
    """Median absolute deviation scaled to a robust std estimate."""
    if not xs:
        return 0.0
    return 1.4826 * statistics.median([abs(x - mu) for x in xs])


def _slope(ys: list[float]) -> float:
    """OLS slope of ys over index 0..n-1."""
    n = len(ys)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def compute_ticker_heat(mentions: list[int], p: HeatParams) -> dict:
    """Compute {z, vel, accel, phase, …} from a chronological mention series."""
    n = len(mentions)
    x = [log(1 + max(0, m)) for m in mentions]

    # z per day: baseline is the prior up-to-`window` days (lag 1, excludes today).
    z_series: list[float | None] = [None] * n
    for i in range(n):
        base = x[max(0, i - p.window) : i]
        if len(base) < p.min_days:
            continue
        mu = _median(base)
        sigma = max(_mad_sigma(base, mu), p.sigma_floor)
        z_series[i] = (x[i] - mu) / sigma

    z_today = z_series[-1] if n else None
    zs = [z for z in z_series if z is not None]

    vel = _slope(zs[-p.vel_window :]) if len(zs) >= 2 else None
    prev_vel = _slope(zs[-p.vel_window - 1 : -1]) if len(zs) >= p.vel_window + 1 else None
    accel = (vel - prev_vel) if (vel is not None and prev_vel is not None) else None

    med_recent = _median([float(m) for m in mentions[-p.window :]])

    phase = _phase(z_today, vel, accel, med_recent, p)

    return {
        "mentions": mentions[-1] if mentions else 0,
        "z": round(z_today, 2) if z_today is not None else None,
        "vel": round(vel, 3) if vel is not None else None,
        "accel": round(accel, 3) if accel is not None else None,
        "phase": phase,
        "days": n,
        "series": mentions[-p.window :],
        "z_series": [round(z, 2) if z is not None else None for z in z_series[-p.window :]],
    }


def _phase(
    z: float | None, vel: float | None, accel: float | None, med_recent: float, p: HeatParams
) -> str:
    if med_recent < p.ultra_low:
        return "ultralow"  # too little coverage — bypass heat timing
    if z is None:
        return "warming"  # not enough history yet
    if z >= p.z_high:
        return "detonate"
    if z >= p.z_low and vel is not None and vel >= p.vel_threshold and accel is not None and accel >= 0:
        return "ignite"
    if z >= p.z_low:
        return "watch"  # in band, momentum not confirmed
    return "dead"


# --------------------------------------------------------------------------
# accumulation + orchestration
# --------------------------------------------------------------------------
async def fetch_snapshot(settings: Settings) -> list:
    """Fetch a broad Ape Wisdom snapshot (not filtered to the watchlist)."""
    settings.apewisdom.filter_to_watchlist = False
    settings.apewisdom.max_pages = max(settings.apewisdom.max_pages, 4)
    async with get_client(
        user_agent=settings.user_agent, timeout_s=settings.request_timeout_s
    ) as client:
        return await ApeWisdomCollector(settings, client).collect()


def store_snapshot(entries: list, output_dir: Path, day: str) -> Path:
    """Append today's mentions for each ticker to the history store."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / HISTORY_FILE
    hist: dict = {}
    if path.exists():
        try:
            hist = json.loads(path.read_text())
        except ValueError:
            hist = {}

    for e in entries:
        arr = hist.setdefault(e.ticker, [])
        arr[:] = [r for r in arr if r.get("date") != day]  # overwrite same-day
        arr.append({"date": day, "mentions": e.mentions, "upvotes": e.upvotes})
        arr.sort(key=lambda r: r["date"])
        if len(arr) > MAX_HISTORY:
            del arr[: len(arr) - MAX_HISTORY]

    path.write_text(json.dumps(hist))
    logger.info("stored %d ticker snapshots (%s)", len(entries), day)
    return path


def build_heat(output_dir: Path, params: HeatParams) -> dict:
    """Compute heat for every ticker in history; write heat_latest.json."""
    path = output_dir / HISTORY_FILE
    hist: dict = {}
    if path.exists():
        try:
            hist = json.loads(path.read_text())
        except ValueError:
            hist = {}

    tickers = {}
    for ticker, arr in hist.items():
        mentions = [int(r.get("mentions", 0)) for r in sorted(arr, key=lambda r: r["date"])]
        if not mentions:
            continue
        tickers[ticker] = compute_ticker_heat(mentions, params)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "params": asdict(params),
        "tickers": tickers,
    }
    (output_dir / HEAT_FILE).write_text(json.dumps(payload, ensure_ascii=False))
    counts: dict[str, int] = {}
    for t in tickers.values():
        counts[t["phase"]] = counts.get(t["phase"], 0) + 1
    logger.info("heat: %d tickers, phases=%s", len(tickers), counts)
    return payload


async def _main(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    params = HeatParams()
    if not args.no_fetch:
        entries = await fetch_snapshot(settings)
        if entries:
            day = datetime.now(timezone.utc).date().isoformat()
            store_snapshot(entries, settings.output_dir, day)
        else:
            logger.warning("Ape Wisdom returned no data; recomputing from stored history")
    build_heat(settings.output_dir, params)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Heat Signal — Ape Wisdom z/velocity/phase")
    p.add_argument("--config", default=None)
    p.add_argument("--no-fetch", action="store_true", help="recompute from stored history only")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
