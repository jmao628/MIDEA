"""LLM-derived supply-chain map (upstream / downstream / peers) per seed
ticker, so the dashboard can draw a radial ecosystem graph on a stock's detail
page — who feeds it, who it feeds, and who it competes with.

Why an LLM (not a database): there is no clean, free machine-readable feed of
"who supplies whom" for US equities. The model knows the major, well-reported
relationships (NVDA→TSMC, AAPL→its assemblers, etc.). We ask it for *major*
relationships only, with a one-line reason per edge, and we label the output
honestly in the UI as AI-derived and non-exhaustive.

Like ``sectors.py`` this is a **cached** fetch: only tickers missing from
``data/newsagg/supplychain.json`` are looked up; existing ones are kept. So the
daily run is usually a no-op and only newly-added SA names cost an API call.

Cache safety — IMPORTANT: this file is only ever *merged*, never replaced.
``--refresh`` re-maps the requested names (``--tickers X,Y`` or, with no
``--tickers``, the whole rated universe) and writes them OVER the existing
cache — every other map is preserved. So ``--refresh --tickers MU,NVDA`` re-maps
just those two and leaves the other ~500 untouched. (It used to blow the whole
file away — it no longer does.) Each ticker is checkpointed as it completes, so
an interrupted rebuild keeps its progress and never loses prior maps.

To rebuild everything from scratch, delete the file first, then run with no
``--refresh``:  ``rm data/newsagg/supplychain.json && python -m newsagg.supplychain``.

Provider: OpenAI (the user's gateway), same as ``catalyst.py`` — it reads
``OPENAI_API_KEY`` (and, if the gateway needs it, ``OPENAI_BASE_URL``) from the
environment, never from code or the repo. The gateway requires streaming, so we
stream and collect the output text. No key / SDK → this step logs a warning and
is skipped; the rest of the pipeline is unaffected.

Writes ``data/newsagg/supplychain.json`` =
    {ticker: {upstream: [Edge], downstream: [Edge], peers: [Edge], model, ok}}
where Edge = {ticker, name, reason}.

    OPENAI_API_KEY=... python -m newsagg.supplychain              # fill missing
    OPENAI_API_KEY=... python -m newsagg.supplychain --tickers MU --refresh  # re-map one, keep the rest
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
from pathlib import Path

from newsagg.config import load_settings

logger = logging.getLogger("newsagg.supplychain")

SUPPLYCHAIN_FILE = "supplychain.json"
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")

# Keep each relationship list short so the graph stays readable and the model
# stays on the *major* names instead of padding with speculative small fry —
# but roomy enough not to truncate a genuinely deep upstream (e.g. semis).
MAX_PER_LIST = 8


def _load(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


def rated_seed_tickers(output_dir: Path) -> dict[str, str]:
    """Rated tickers in the SA seed snapshot → company name.

    A ticker is "rated" if it appears in any widget row carrying a rating
    (Buy / Strong Buy / a numeric quant grade). Those are the only names that
    reach the later pipeline stages, so they're the only ones worth mapping.
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
                if not t or not (r.get("rating") or "").strip():
                    continue
                # First non-empty company name wins.
                out.setdefault(t, (r.get("company") or "").strip())
    return out


# JSON schema forced on the model — every list is an array of {ticker,name,reason}.
_EDGE = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "ticker": {"type": "string", "description": "US exchange ticker, e.g. NVDA. Empty string if not publicly traded / unknown."},
        "name": {"type": "string", "description": "Company name."},
        "reason": {"type": "string", "description": "One short clause: why this relationship exists."},
        "importance": {
            "type": "integer",
            "enum": [1, 2, 3],
            "description": "How critical / hard-to-replace this relationship is: 1 = minor / easily substituted, "
            "2 = significant, 3 = critical (sole-source, deeply integrated, or the counterparty's fortunes "
            "materially swing this company).",
        },
    },
    "required": ["ticker", "name", "reason", "importance"],
}
_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "upstream": {"type": "array", "items": _EDGE, "description": "Key suppliers / inputs this company depends on."},
        "downstream": {"type": "array", "items": _EDGE, "description": "Key customers / channels that depend on this company."},
        "peers": {"type": "array", "items": _EDGE, "description": "Direct competitors in the same market."},
    },
    "required": ["upstream", "downstream", "peers"],
}


def _prompt(ticker: str, name: str, sector: str = "", industry: str = "") -> str:
    who = f"{ticker} ({name})" if name else ticker
    ctx = ""
    if sector or industry:
        ctx = f" It is classified under sector '{sector}', industry '{industry}'."
    return (
        f"Map the supply chain around the US-listed company {who}.{ctx}\n\n"
        "FIRST, in your reasoning, state precisely what this specific company actually does — its core "
        "products/services and what it must buy to deliver them — using the sector/industry above to pin down "
        "the RIGHT company (don't confuse it with a similarly-named or adjacent business). A cloud / AI-"
        "infrastructure company's key upstream is its GPU/chip and server suppliers; a fabless chip designer's "
        "is its foundry; a retailer's downstream is its end customers. THEN map:\n"
        "- upstream: its most important suppliers / input providers (who it buys from or depends on)\n"
        "- downstream: its most important customers / distribution channels (who buys from or depends on it)\n"
        "- peers: its most direct competitors\n\n"
        "Be THOROUGH on upstream — walk each layer of inputs the company actually consumes and name the "
        "dominant supplier in each, e.g. for a chipmaker: wafer-fab EQUIPMENT (Applied Materials AMAT, Lam "
        "Research LRCX, KLA KLAC, ASML), the FOUNDRY (TSMC TSM, GlobalFoundries GFS), EDA/IP (Synopsys SNPS, "
        "Cadence CDNS, Arm ARM), substrates/memory/components, and assembly/test. Do NOT skip an obvious, "
        "critical supplier just because it is a very large or a foreign-domiciled company — include it with its "
        "US ticker or US-listed ADR (e.g. ASML, TSM). It's fine to list a supplier that is not itself in any "
        "watchlist; completeness of the real supply chain matters more.\n\n"
        f"Rules:\n"
        f"- MAJOR, well-established relationships only. At most {MAX_PER_LIST} per list; fewer is fine — but do "
        "not drop a genuinely critical supplier to stay under the cap.\n"
        "- Prefer publicly-traded companies and give their US ticker (or US-listed ADR) in `ticker`. "
        "If a relationship is important but the counterparty isn't publicly traded (or you're unsure of the ticker), "
        "leave `ticker` empty but still list it by name.\n"
        "- `reason` is one short clause (e.g. 'fabs its chips', 'largest cloud customer').\n"
        "- `importance` 1-3: how critical / hard-to-replace the tie is — 3 = sole-source or deeply "
        "integrated (the counterparty is nearly irreplaceable, or its results materially swing this company), "
        "2 = significant, 1 = minor / easily substituted.\n"
        "- Do NOT invent tickers or relationships you aren't confident about. Omit rather than guess.\n"
        "- If the company itself is obscure and you have little reliable information, return short or empty lists.\n\n"
        "Return ONLY a single JSON object (no prose, no markdown fences) of the exact shape:\n"
        '{"upstream": [{"ticker": "", "name": "", "reason": "", "importance": 1}], '
        '"downstream": [...], "peers": [...]}\n'
        "Every edge object must have all four keys; `importance` is an integer 1-3."
    )


def _extract_json(text: str) -> dict | None:
    """Pull the JSON object out of the model's text (tolerant of stray prose)."""
    text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def _complete(client, model: str, prompt: str) -> str:
    """One NON-streamed chat.completions call; returns the text. This gateway
    only serves plain non-streamed /chat/completions (both /responses and the
    streaming path 500), so we use that (no web search — model's own knowledge)."""
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    return (resp.choices[0].message.content or "") if resp.choices else ""


def _clean_edges(raw: list) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for e in raw[:MAX_PER_LIST]:
        if not isinstance(e, dict):
            continue
        name = (e.get("name") or "").strip()
        if not name:
            continue
        tk = (e.get("ticker") or "").strip().upper()
        # Guard against the model echoing punctuation / prose into the ticker.
        if tk and not tk.replace(".", "").replace("-", "").isalpha():
            tk = ""
        key = tk or name.lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            imp = int(e.get("importance", 2))
        except (TypeError, ValueError):
            imp = 2
        imp = min(3, max(1, imp))
        out.append({"ticker": tk, "name": name, "reason": (e.get("reason") or "").strip(), "importance": imp})
    return out


def _fetch_one(client, ticker: str, name: str, model: str = MODEL, sector: str = "", industry: str = "") -> dict | None:
    """One call. Returns the cleaned map, or None on failure."""
    try:
        text = _complete(client, model, _prompt(ticker, name, sector, industry))
    except Exception as exc:  # noqa: BLE001
        logger.warning("  %s: API error (%s)", ticker, exc)
        return None

    parsed = _extract_json(text)
    if parsed is None:
        logger.warning("  %s: could not parse JSON response", ticker)
        return None

    return {
        "upstream": _clean_edges(parsed.get("upstream") or []),
        "downstream": _clean_edges(parsed.get("downstream") or []),
        "peers": _clean_edges(parsed.get("peers") or []),
        "model": model,
        "ok": True,
    }


def fetch_missing(
    tickers: dict[str, str],
    have: dict[str, dict],
    workers: int = 4,
    model: str = MODEL,
    sectors: dict[str, dict] | None = None,
    out_path: Path | None = None,
    base: dict[str, dict] | None = None,
) -> dict[str, dict]:
    """Look up the supply chain for tickers not already cached. If ``out_path``
    is given, checkpoint after every ticker (``base`` = the full existing cache
    to preserve, overlaid with new results) so a long run survives interruption."""
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai SDK not installed — `pip install openai`; skipping supply chain")
        return {}

    if not os.environ.get("OPENAI_API_KEY"):
        logger.warning("OPENAI_API_KEY not set — skipping supply-chain enrichment")
        return {}

    missing = {t: n for t, n in tickers.items() if t not in have}
    if not missing:
        logger.info("no new tickers — supply-chain cache already complete (%d)", len(have))
        return {}
    logger.info("mapping supply chain for %d new tickers via %s…", len(missing), model)

    from concurrent.futures import ThreadPoolExecutor, as_completed

    sectors = sectors or {}
    client = OpenAI()
    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(
                _fetch_one, client, t, n, model,
                (sectors.get(t) or {}).get("sector", ""),
                (sectors.get(t) or {}).get("industry", ""),
            ): t
            for t, n in missing.items()
        }
        for i, fut in enumerate(as_completed(futures), 1):
            t = futures[fut]
            res = fut.result()
            if res:
                out[t] = res
                # Checkpoint after every ticker so a long rebuild is never lost.
                if out_path is not None:
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    out_path.write_text(json.dumps({**(base or {}), **out}))
            if i % 10 == 0 or i == len(missing):
                logger.info("  %d/%d…", i, len(missing))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Map upstream/downstream/peers per seed ticker (full universe, LLM, cached)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override")
    ap.add_argument("--refresh", action="store_true", help="re-map the requested names (or the full rated universe), KEEPING every other cached map")
    ap.add_argument("--limit", type=int, default=None, help="cap how many new tickers to map this run")
    ap.add_argument("--model", default=MODEL, help=f"OpenAI model id (default {MODEL})")
    ap.add_argument("--min-cap", type=float, default=3e8, help="skip tickers below this market cap (default $300M)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    out_path = settings.output_dir / SUPPLYCHAIN_FILE
    existing = _load(out_path)  # everything currently cached — NEVER dropped
    have = dict(existing)

    if args.tickers:
        names = {t.strip().upper(): "" for t in args.tickers.split(",") if t.strip()}
    else:
        # Map the FULL seed universe the dashboard shows — home-widget rows AND
        # the followed-analyst feed (e.g. JPM) — not just rows carrying a rating,
        # so no ticker is shown in the UI without a supply-chain map.
        from newsagg.marketcap import seed_names

        names = seed_names(settings.output_dir)
    if not names:
        logger.warning("no seed tickers (run the SA scrape first, or pass --tickers)")
        return 1

    # Skip tiny / illiquid names — not worth an API call, and their supply-chain
    # position rarely matters. Only skip when the cap is KNOWN and below the bar.
    caps = _load(settings.output_dir / "marketcaps.json")
    if args.min_cap and caps:
        before = len(names)
        names = {t: n for t, n in names.items() if not (isinstance(caps.get(t), (int, float)) and caps[t] < args.min_cap)}
        skipped = before - len(names)
        if skipped:
            logger.info("skipping %d tickers below $%.0fM market cap", skipped, args.min_cap / 1e6)

    # --refresh re-maps the REQUESTED names only; every other cached map is kept.
    if args.refresh:
        for t in names:
            have.pop(t, None)

    if args.limit:
        # Only map the first N *uncached* tickers this run (spread cost over days).
        pending = [t for t in names if t not in have][: args.limit]
        names = {t: names[t] for t in pending}

    # Sector/industry context helps the model pin down the RIGHT company.
    sectors = _load(settings.output_dir / "sectors.json")

    fetched = fetch_missing(names, have, model=args.model, sectors=sectors, out_path=out_path, base=existing)
    merged = {**existing, **fetched}  # untouched maps survive; refetched overwrite
    if not merged:
        logger.warning("no supply-chain data resolved (no key / API error); keeping existing file")
        return 1

    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged))
    logger.info("wrote %d supply-chain maps (+%d new)", len(merged), len(fetched))
    print(f"supplychain: {len(merged)} (+{len(fetched)} new)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
