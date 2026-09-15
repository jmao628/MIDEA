"""Fetch GICS-style sector / industry for the seed universe via yfinance, so the
dashboard can classify heat-ignition names by sector (why is it all healthcare?).

Sector rarely changes, so this is a *cached* fetch: only tickers missing from
``data/newsagg/sectors.json`` are looked up; existing ones are kept. That keeps
the daily run cheap (usually a no-op) even though yfinance's .info is heavy.

Writes ``data/newsagg/sectors.json`` = {ticker: {sector, industry, name, market_cap}}.

The market cap comes from the SAME ``.info`` call (free — it's already fetched),
and unlike ``marketcap.py``'s ``fast_info`` feed (flaky, often missing mega-caps)
``.info["marketCap"]`` is reliably populated, so the dashboard uses it as the
cap source for the per-sector ecosystem graph's large/small ring split.

    python -m newsagg.sectors
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from newsagg.config import load_settings
from newsagg.marketcap import seed_tickers, load_dead_tickers

logger = logging.getLogger("newsagg.sectors")

SECTORS_FILE = "sectors.json"


def _load(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


def _fetch_one(ticker: str) -> dict | None:
    import yfinance as yf

    tk = yf.Ticker(ticker.replace(".", "-"))
    try:
        info = tk.info
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(info, dict):
        return None
    sector = info.get("sector")
    industry = info.get("industry")
    name = info.get("longName") or info.get("shortName") or ""
    if not sector and not industry:
        return None
    mc = info.get("marketCap")
    # Belt-and-suspenders: if .info didn't carry a market cap, try fast_info
    # before giving up, so more tickers get a real number in one pass.
    if not (isinstance(mc, (int, float)) and mc > 0):
        try:
            fi = tk.fast_info
            mc = getattr(fi, "market_cap", None)
            if mc is None:
                try:
                    mc = fi["marketCap"]
                except Exception:  # noqa: BLE001
                    mc = None
        except Exception:  # noqa: BLE001
            mc = None
    # Always store the key (0 = genuinely no cap from yfinance) so the backfill
    # check below treats it as done and never re-fetches it every run.
    market_cap = int(mc) if isinstance(mc, (int, float)) and mc > 0 else 0
    return {"sector": sector or "", "industry": industry or "", "name": name, "market_cap": market_cap}


def fetch_missing(tickers: list[str], have: dict[str, dict], workers: int = 8) -> dict[str, dict]:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Re-fetch tickers with no cached entry OR an entry that predates a field we
    # now store (`name`, `market_cap`), so both backfill on a normal run without
    # a --refresh. Cap size only needs a rough bucket, so a one-time backfill is
    # enough — we don't re-pull caps daily.
    missing = [t for t in tickers if t not in have or not have[t].get("name") or "market_cap" not in have[t]]
    if not missing:
        logger.info("no new tickers — sectors cache already complete (%d)", len(have))
        return {}
    logger.info("fetching sector/name for %d tickers…", len(missing))

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_fetch_one, t): t for t in missing}
        for i, fut in enumerate(as_completed(futures), 1):
            t = futures[fut]
            res = fut.result()
            if res:
                out[t] = res
            if i % 40 == 0:
                logger.info("  %d/%d…", i, len(missing))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch/refresh sector classification (yfinance, cached)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override")
    ap.add_argument("--refresh", action="store_true", help="re-fetch all, ignore cache")
    ap.add_argument("--recheck", action="store_true", help="ignore the no-price skip-list and try the whole universe")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    out_path = settings.output_dir / SECTORS_FILE
    have = {} if args.refresh else _load(out_path)

    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = seed_tickers(settings.output_dir)
        # Skip tickers Yahoo can't price (delisted/OTC/.CA) — same dead-list the
        # price jobs maintain, so sectors doesn't re-404 hundreds of them.
        dead = set() if args.recheck else load_dead_tickers(settings.output_dir)
        if dead:
            before = len(tickers)
            tickers = [t for t in tickers if t not in dead]
            logger.info("skipping %d known no-price tickers (--recheck to re-validate)", before - len(tickers))
    if not tickers:
        logger.warning("no tickers (run the SA scrape first, or pass --tickers)")
        return 1

    fetched = fetch_missing(tickers, have)
    merged = {**have, **fetched}
    if not merged:
        logger.warning("no sectors resolved (network?); keeping existing file")
        return 1

    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged))
    logger.info("wrote %d sectors (+%d new)", len(merged), len(fetched))
    print(f"sectors: {len(merged)} (+{len(fetched)} new)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
