"""No-LLM catalyst signals — real, sourced, current, straight from free feeds.

The LLM catalyst stage (``catalyst.py``) needs the OpenAI gateway, which is
flaky. This module fills the same gap WITHOUT any LLM, using only free data:

  * next EARNINGS DATE (+ ex-dividend) from yfinance — the single hardest,
    most-reliable forward catalyst, fully dated and sourced;
  * recent NEWS headlines from yfinance ``.news`` — the company's latest
    disclosures, keyword-classified into a catalyst type (crude but no LLM),
    each with its real article link.

What it deliberately does NOT do: judge "the narrative", grade a headline's
magnitude, or reason about sector impact — that needs an LLM. This is the raw
signal layer; you read it.

Writes ``data/newsagg/catalyst_data.json`` in the SAME per-ticker shape as
``catalyst.json`` (so the dashboard can show it), under a distinct file so it
never clobbers the LLM catalysts:

    {ticker: {catalysts: [Catalyst], score, best_type, source: "yfinance",
              ok, generated_at}}

    python -m newsagg.catalyst_data --tickers NVDA,TTMI      # test a few
    python -m newsagg.catalyst_data                          # whole universe
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path

from newsagg.catalyst import _tpmn
from newsagg.config import load_settings
from newsagg.marketcap import seed_tickers, load_dead_tickers

logger = logging.getLogger("newsagg.catalyst_data")

CATALYST_DATA_FILE = "catalyst_data.json"

# Keyword → catalyst type. First match wins; order matters (specific first).
_TYPE_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("approval", ("fda", "pdufa", "approval", "approved", "clearance", "chmp", "authorized", "ind ", "phase 3", "phase iii", "topline")),
    ("m_and_a", ("acquire", "acquisition", "merger", "to buy", "takeover", "buyout", "activist", "stake in", "spin-off", "spinoff", "take-private")),
    ("capital_return", ("buyback", "repurchase", "special dividend", "dividend increase", "raises dividend", "boosts dividend")),
    ("guidance", ("guidance", "raises outlook", "cuts outlook", "lowers outlook", "preliminary results", "pre-announce", "guides", "warns", "cuts forecast", "raises forecast")),
    ("order", ("contract", "awarded", "wins", "design win", "backlog", "order", "to supply", "selected by", "partnership")),
    ("index", ("s&p 500", "s&p500", "added to", "index inclusion", "rebalance", "joins the")),
    ("policy", ("tariff", "subsidy", "sanction", "regulation", "antitrust", "ban on", "export control")),
    ("mgmt", ("ceo", "cfo", "resign", "steps down", "appoints", "names ", "new chief")),
    ("revision", ("upgrade", "downgrade", "raises target", "lowers target", "price target", "initiates coverage", "reiterates")),
    ("earnings", ("earnings", "quarterly results", "q1", "q2", "q3", "q4", "beats", "misses", "reports results", "fiscal")),
]


def _classify(title: str) -> str:
    t = title.lower()
    for typ, kws in _TYPE_KEYWORDS:
        if any(k in t for k in kws):
            return typ
    return "other"


def _next_earnings(tk) -> str | None:
    """Next FUTURE earnings date (ISO) from yfinance — tolerant of the several
    shapes yfinance has used across versions (earnings_dates DataFrame, or the
    calendar dict/DataFrame). Never raises (needs lxml; degrades to None)."""
    today = date.today()
    # 1) earnings_dates: a DataFrame indexed by timestamp (past + a few future).
    ed = None
    try:
        ed = tk.get_earnings_dates(limit=12)
    except Exception:  # noqa: BLE001
        try:
            ed = tk.earnings_dates
        except Exception:  # noqa: BLE001
            ed = None
    try:
        if ed is not None and hasattr(ed, "index") and len(ed.index):
            future = []
            for ts in ed.index:
                d = ts.date() if hasattr(ts, "date") else None
                if d and d >= today:
                    future.append(d)
            if future:
                return min(future).isoformat()
    except Exception:  # noqa: BLE001
        pass
    # 2) calendar: dict {"Earnings Date": [date, ...]} or a DataFrame.
    try:
        cal = tk.calendar
        vals = None
        if isinstance(cal, dict):
            vals = cal.get("Earnings Date")
        elif cal is not None and hasattr(cal, "loc"):
            try:
                vals = cal.loc["Earnings Date"].tolist()
            except Exception:  # noqa: BLE001
                vals = None
        if vals is not None:
            if not isinstance(vals, (list, tuple)):
                vals = [vals]
            for v in vals:
                d = v.date() if hasattr(v, "date") else (v if isinstance(v, date) else None)
                if d and d >= today:
                    return d.isoformat()
    except Exception:  # noqa: BLE001
        pass
    return None


def _news_items(tk, limit: int = 8) -> list[dict]:
    """Recent news as [{title, link, publisher, published(ISO)}]. Handles both the
    old flat yfinance .news schema and the newer nested `content` one."""
    try:
        raw = tk.news or []
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    for it in raw[:limit]:
        if not isinstance(it, dict):
            continue
        content = it.get("content") if isinstance(it.get("content"), dict) else None
        title = (it.get("title") or (content or {}).get("title") or "").strip()
        if not title:
            continue
        link = it.get("link") or ""
        if not link and content:
            cu = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
            link = (cu or {}).get("url", "") if isinstance(cu, dict) else ""
        pub = it.get("publisher") or ((content or {}).get("provider") or {}).get("displayName", "")
        ts = it.get("providerPublishTime")
        published = None
        if isinstance(ts, (int, float)):
            published = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        elif content and content.get("pubDate"):
            published = str(content["pubDate"])[:10]
        out.append({"title": title[:180], "link": link, "publisher": pub, "published": published})
    return out


def _build_one(ticker: str, company: str, today: date) -> dict | None:
    import yfinance as yf

    tk = yf.Ticker(ticker.replace(".", "-"))
    cats: list[dict] = []
    # Relevance tokens — a headline that names the ticker or the company is about
    # THIS company; tangential market news (that yfinance sometimes returns) isn't.
    rel_tokens = {ticker.lower()}
    if company:
        first = company.lower().split()[0]
        if len(first) >= 3 and first not in ("the", "inc", "inc.", "corp"):
            rel_tokens.add(first)

    # Forward catalyst: the next earnings date (scheduled → high probability).
    ed = _next_earnings(tk)
    if ed:
        raw = {
            "type": "earnings", "title": "Next scheduled earnings", "event_date": ed,
            "window_days": None, "P": 3, "M": 2, "N": 1,
            "summary": "The next scheduled quarterly earnings print — a dated, high-probability catalyst.",
            "thesis": "Quarterly print", "evidence": "yfinance earnings calendar",
            "source_url": f"https://finance.yahoo.com/quote/{ticker}",
        }
        tp = _tpmn(raw, today)
        cats.append({
            "type": "earnings", "title": raw["title"], "cls": tp["cls"],
            "event_date": ed, "window_days": None,
            "source_url": raw["source_url"], "summary": raw["summary"],
            "thesis": raw["thesis"], "evidence": raw["evidence"], "tpmn": tp,
        })

    # Recent disclosures: news headlines, keyword-typed (past events → narrative
    # signal; scored gently by recency, not future timing).
    for n in _news_items(tk):
        typ = _classify(n["title"])
        days_ago = None
        if n.get("published"):
            try:
                days_ago = (today - date.fromisoformat(n["published"][:10])).days
            except ValueError:
                days_ago = None
        # A recency-decayed 0-10 so fresh disclosures rank above stale ones,
        # down-weighted when the headline doesn't actually name this company.
        recency = max(0.0, 1 - (days_ago or 30) / 30) if days_ago is not None else 0.3
        relevant = any(tok in n["title"].lower() for tok in rel_tokens)
        score = round((3.0 + 4.0 * recency) * (1.0 if relevant else 0.5), 1)
        cats.append({
            "type": typ, "title": n["title"], "cls": "news",
            "event_date": n.get("published"), "window_days": None,
            "source_url": n.get("link") or f"https://finance.yahoo.com/quote/{ticker}/news",
            "summary": f"{n.get('publisher') or 'News'} — recent disclosure (keyword-typed, unscored by impact).",
            "thesis": "Recent disclosure", "evidence": f"{n.get('publisher') or 'news'} {n.get('published') or ''}".strip(),
            "tpmn": {"T": 0.0, "P": 0, "M": 0, "N": 0, "days": days_ago, "cls": "news", "score": score, "type": typ},
            "_rel": relevant,
        })

    if not cats:
        return None
    # Forward catalysts (the next earnings) rank ABOVE recent news; within each,
    # by score. So the real dated catalyst is always on top, news is context.
    cats.sort(key=lambda c: (c["cls"] != "news", c["tpmn"]["score"]), reverse=True)
    for c in cats:
        c.pop("_rel", None)
    return {
        "catalysts": cats[:8],
        "score": cats[0]["tpmn"]["score"],
        "best_type": cats[0]["type"],
        "source": "yfinance",
        "ok": True,
        "generated_at": today.isoformat(),
    }


def build(tickers: list[str], names: dict[str, str] | None = None, workers: int = 8) -> dict[str, dict]:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    today = date.today()
    names = names or {}

    def one(t: str):
        try:
            return t, _build_one(t, names.get(t, ""), today)
        except Exception as exc:  # noqa: BLE001
            logger.warning("  %s: %s", t, exc)
            return t, None

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one, t) for t in tickers]
        for i, f in enumerate(as_completed(futs), 1):
            t, res = f.result()
            if res:
                out[t] = res
            if i % 40 == 0:
                logger.info("  %d/%d…", i, len(tickers))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="No-LLM catalyst signals from yfinance (earnings date + recent news)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override (e.g. NVDA,TTMI)")
    ap.add_argument("--recheck", action="store_true", help="ignore the no-price skip-list")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = seed_tickers(settings.output_dir)
        dead = set() if args.recheck else load_dead_tickers(settings.output_dir)
        if dead:
            before = len(tickers)
            tickers = [t for t in tickers if t not in dead]
            logger.info("skipping %d known no-price tickers", before - len(tickers))
    if not tickers:
        logger.warning("no tickers (run the SA scrape first, or pass --tickers)")
        return 1

    from newsagg.marketcap import seed_names

    names = seed_names(settings.output_dir)
    logger.info("building no-LLM catalyst signals for %d tickers…", len(tickers))
    data = build(tickers, names=names)
    if not data:
        logger.warning("no signals resolved (network?); keeping existing file")
        return 1

    out_path = settings.output_dir / CATALYST_DATA_FILE
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data))
    withcat = sum(1 for v in data.values() if v.get("catalysts"))
    logger.info("wrote %d tickers (%d with signals)", len(data), withcat)
    print(f"catalyst_data: {len(data)} tickers ({withcat} with signals)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
