"""Fetch real market caps for the seed universe via yfinance, so cap-size
gating (big caps bypass heat) uses actual market cap instead of SA's
inconsistent cap-group labels.

Writes ``data/newsagg/marketcaps.json`` = {ticker: market_cap_usd}.

    python -m newsagg.marketcap
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from newsagg.config import load_settings

logger = logging.getLogger("newsagg.marketcap")

MARKETCAP_FILE = "marketcaps.json"

# A persistent skip-list of tickers Yahoo can't price (delisted / OTC / foreign
# `.CA` names). They never resolve, so re-fetching them every run is pure waste;
# once a run confirms a ticker has no data it's parked here and skipped next time.
# `--recheck` (in the price jobs) ignores this and re-validates the whole
# universe, so a name that later relists comes back.
NO_PRICE_FILE = "no_price.json"


def load_dead_tickers(output_dir: Path) -> set[str]:
    """Tickers previously confirmed to have no Yahoo price data."""
    try:
        raw = json.loads((output_dir / NO_PRICE_FILE).read_text())
        return {str(t).upper() for t in (raw.get("tickers") or [])}
    except (OSError, ValueError):
        return set()


def save_dead_tickers(output_dir: Path, dead: set[str]) -> None:
    from datetime import datetime, timezone

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / NO_PRICE_FILE).write_text(
        json.dumps({"tickers": sorted(dead), "updated_at": datetime.now(timezone.utc).isoformat()})
    )


def seed_names(output_dir: Path) -> dict[str, str]:
    """Every seed ticker → company name — the FULL universe the dashboard shows:
    all home-widget rows (rated or not) PLUS the followed-analyst Buy/Strong-Buy
    feed (my_analyst_picks, e.g. JPM). This is the single source of truth so every
    enrichment job (caps, technical, sectors, supply chain) covers the SAME names
    the UI does — no ticker gets skipped by one job and shown by another.
    """
    path = output_dir / "seekingalpha_latest.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except ValueError:
        return {}
    out: dict[str, str] = {}
    for w in data.get("home_widgets", []):
        for g in w.get("groups", []):
            for r in g.get("rows", []):
                t = (r.get("ticker") or "").strip().upper()
                if t:
                    out.setdefault(t, (r.get("company") or "").strip())
    for p in data.get("my_analyst_picks", []):
        t = (p.get("ticker") or "").strip().upper()
        if t:
            out.setdefault(t, "")
    return out


def seed_tickers(output_dir: Path) -> list[str]:
    """All tickers in the seed universe (see seed_names)."""
    return sorted(seed_names(output_dir))


def _market_cap(tk) -> int | None:
    # fast_info only — it's one cheap request. (The full .info fallback is
    # far too slow across hundreds of tickers, so we skip it.)
    try:
        fi = tk.fast_info
        mc = getattr(fi, "market_cap", None)
        if mc is None:
            try:
                mc = fi["marketCap"]
            except Exception:  # noqa: BLE001
                mc = None
        return int(mc) if mc else None
    except Exception:  # noqa: BLE001
        return None


def fetch_caps(tickers: list[str], workers: int = 10) -> dict[str, int]:
    """Fetch market caps in parallel (fast_info per ticker)."""
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def one(t: str) -> tuple[str, int | None]:
        # yfinance uses '-' for share classes (BRK.B -> BRK-B).
        return t, _market_cap(yf.Ticker(t.replace(".", "-")))

    caps: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(one, t) for t in tickers]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                t, mc = fut.result()
            except Exception:  # noqa: BLE001
                continue
            if mc:
                caps[t] = mc
            if i % 40 == 0:
                logger.info("  %d/%d…", i, len(tickers))
    return caps


def main() -> int:
    p = argparse.ArgumentParser(description="Fetch seed-universe market caps (yfinance)")
    p.add_argument("--config", default=None)
    p.add_argument("--recheck", action="store_true", help="ignore the no-price skip-list and re-fetch the whole universe (re-validates relisted names)")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    universe = seed_tickers(settings.output_dir)
    if not universe:
        logger.warning("no seed tickers found (run the SA scrape first)")
        return 1

    # Skip tickers Yahoo has already told us it can't price (delisted/OTC/.CA).
    dead = set() if args.recheck else load_dead_tickers(settings.output_dir)
    tickers = [t for t in universe if t not in dead]
    if dead:
        logger.info("skipping %d known no-price tickers (--recheck to re-validate)", len(universe) - len(tickers))
    logger.info("fetching market caps for %d tickers…", len(tickers))
    caps = fetch_caps(tickers)
    out_path = settings.output_dir / MARKETCAP_FILE

    # Safety net: a network failure (e.g. Yahoo unreachable) yields 0 caps —
    # don't overwrite a previously-good marketcaps.json with nothing.
    if not caps:
        if out_path.exists():
            logger.warning("fetched 0 market caps (network?); keeping existing marketcaps.json")
        else:
            logger.warning(
                "fetched 0 market caps and no existing file — is Yahoo reachable? "
                "try: HTTPS_PROXY=http://127.0.0.1:<port> python -m newsagg.marketcap"
            )
        print("market caps: 0 (kept previous / none)")
        return 1

    # Merge into the existing file so a partial run (outage / skip-list) only
    # refreshes the caps it fetched and never shrinks the set — a run that
    # reached one ticker used to overwrite the whole file with one cap.
    existing: dict = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text()) or {}
        except (OSError, ValueError):
            existing = {}
    merged = {**existing, **caps}
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged))
    logger.info("wrote %d/%d market caps (%d total after merge)", len(caps), len(tickers), len(merged))
    print(f"market caps: {len(caps)}/{len(tickers)} ({len(merged)} total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
