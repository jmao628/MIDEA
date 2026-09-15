"""Daily price-track accumulator — a GROWING, dated close history for the
Backtest lab's watchlist, so a strategy can be FORWARD-tracked from the day
tracking started (not just over the trailing window the technical file holds).

Where the trailing ``technical_latest.json`` close_series slides (it only keeps
the last ~N days), this file only ever GROWS: one dated close per ticker per
run. So once you start it, "how would my rule have done since I started" becomes
answerable, and it keeps extending forward every day.

Source per ticker, cheapest-first:
  1. today's close from ``technical_latest.json`` (already fetched by the daily
     technical job — no extra Yahoo call), else
  2. a live yfinance fetch (for names you added that aren't in the seed universe).

The watchlist is ``data/newsagg/watchlist.json`` (written by the dashboard via
the serve.py ``/api/watchlist`` endpoint). yfinance fallback needs Yahoo
reachable — behind a VPN pass the proxy (``PROXY=...`` in run_now / the plist).

Writes ``data/newsagg/price_track.json`` =
    {start_date, generated_at, tickers: {TK: {dates: [YYYY-MM-DD], closes: [float]}}}

    python -m newsagg.track                      # track the watchlist
    python -m newsagg.track --tickers NVDA,MSFT  # one-off add
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import date
from pathlib import Path

from newsagg.config import load_settings

logger = logging.getLogger("newsagg.track")

TRACK_FILE = "price_track.json"
WATCH_FILE = "watchlist.json"


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


def _watchlist(output_dir: Path) -> list[str]:
    data = _load(output_dir / WATCH_FILE)
    out: list[str] = []
    for t in data.get("tickers") or []:
        s = str(t).strip().upper()
        if s and s not in out:
            out.append(s)
    return out


def _closes_from_technical(output_dir: Path) -> dict[str, float]:
    """Last close per ticker from the daily technical file (no Yahoo call)."""
    tech = _load(output_dir / "technical_latest.json")
    out: dict[str, float] = {}
    for tk, rec in (tech.get("tickers") or {}).items():
        cs = rec.get("close_series") if isinstance(rec, dict) else None
        if isinstance(cs, list) and cs:
            try:
                out[tk] = float(cs[-1])
            except (TypeError, ValueError):
                pass
    return out


def _fetch_close(ticker: str) -> float | None:
    """Live close for a ticker not in the technical file (needs Yahoo)."""
    try:
        from newsagg import technical as tech

        bars = tech._fetch_bars(ticker)
        out = tech.compute_ticker(bars, tech.TechParams()) if bars else None
        return float(out["price"]) if out and out.get("price") is not None else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("  %s: live fetch failed (%s)", ticker, exc)
        return None


def _append(track: dict, ticker: str, today: str, close: float) -> None:
    rec = track["tickers"].setdefault(ticker, {"dates": [], "closes": []})
    if rec["dates"] and rec["dates"][-1] == today:
        rec["closes"][-1] = close  # same-day re-run overwrites today's point
    else:
        rec["dates"].append(today)
        rec["closes"].append(close)


def main() -> int:
    ap = argparse.ArgumentParser(description="Grow a dated close history for the backtest watchlist (forward tracking)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated names to track this run (added to the watchlist set)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    out_dir = settings.output_dir
    out_path = out_dir / TRACK_FILE
    track = _load(out_path) or {}
    track.setdefault("tickers", {})

    names = _watchlist(out_dir)
    if args.tickers:
        for t in args.tickers.split(","):
            s = t.strip().upper()
            if s and s not in names:
                names.append(s)
    if not names:
        logger.info("watchlist empty — nothing to track (add names in the dashboard's My-list box)")
        # still write an (empty) file so the dashboard can read it
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(track))
        return 0

    today = date.today().isoformat()
    have = _closes_from_technical(out_dir)
    recorded = 0
    missing: list[str] = []
    for tk in names:
        close = have.get(tk)
        if close is None:
            close = _fetch_close(tk)
        if close is None:
            missing.append(tk)
            continue
        _append(track, tk, today, close)
        recorded += 1

    track["generated_at"] = today
    track.setdefault("start_date", today)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(track))

    logger.info("tracked %d/%d names on %s (since %s)%s", recorded, len(names), today, track["start_date"], f"; no price for {', '.join(missing)}" if missing else "")
    print(f"track: {recorded}/{len(names)} names, since {track['start_date']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
