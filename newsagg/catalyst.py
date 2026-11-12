"""Stage 3 — Catalyst discovery (TPMN), per Focus-List ticker.

For each ticker we ask an LLM **with web search** to find UPCOMING, DATED,
SOURCED catalysts over the next ~6 months (earnings, product launches / FDA
decisions, contract wins, M&A, capital return, index adds, estimate-revision
cycles, …). The model is used strictly as a *cited extractor* — every catalyst
must carry a real ``source_url`` or it is dropped — so we don't rank on
hallucinated dates. The TPMN score is then computed **deterministically in
Python** from those facts:

    T — Trigger    : a typed, sourced catalyst exists at all (+ a type weight)
    P — Probability: chance it happens AND surprises up (de-rated by priced_in)
    M — Magnitude  : expected re-rating if it fires (est. % upside)
    N — Nearness   : how soon (dated near-term events beat vague far-off ones)

Provider: OpenAI (the user's gateway). It reads ``OPENAI_API_KEY`` (and, if the
gateway needs it, ``OPENAI_BASE_URL``) from the environment — never from code or
the repo. The gateway here requires streaming, so we stream and collect the
output text. No key / SDK → this step logs a warning and is skipped; the rest of
the pipeline is unaffected.

Like ``supplychain.py`` this is a **cached, incremental** fetch: only tickers
missing from ``data/newsagg/catalyst.json`` are looked up (unless --refresh).

Writes ``data/newsagg/catalyst.json`` =
    {ticker: {catalysts: [Catalyst], score, best_type, model, ok, generated_at}}

    OPENAI_API_KEY=... python -m newsagg.catalyst --limit 25
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
from datetime import date
from pathlib import Path

from newsagg.config import load_settings
from newsagg.supplychain import rated_seed_tickers

logger = logging.getLogger("newsagg.catalyst")

CATALYST_FILE = "catalyst.json"
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")

# At most this many catalysts kept per name (the strongest few).
MAX_CATALYSTS = 6

CATALYST_TYPES = (
    "earnings", "guidance", "approval", "order", "m_and_a",
    "capital_return", "policy", "index", "mgmt", "revision", "other",
)

# Score scale (per catalyst): total = T + P + M + N.
#   T  timing 0-25  — a peak curve on days-to-event (peaks at ~2 weeks)
#   P  probability 0-3, M  magnitude 0-3, N  narrative 0-2  (graded by the LLM)
# So a near-term, high-conviction, narrative-hot catalyst tops out near 33.


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


BYPASS_CAP = 100e9  # ecosystem "anchor" = mega cap (matches the dashboard)


def _seed_info(output_dir: Path) -> dict[str, dict]:
    """{ticker: {company, rated, has_thesis}} from the SA snapshot."""
    data = _load(output_dir / "seekingalpha_latest.json")
    out: dict[str, dict] = {}
    for w in (data.get("home_widgets") or []):
        for g in w.get("groups", []):
            for r in g.get("rows", []):
                t = (r.get("ticker") or "").strip().upper()
                if not t:
                    continue
                cur = out.setdefault(t, {"company": "", "rated": False, "has_thesis": False})
                if not cur["company"] and r.get("company"):
                    cur["company"] = (r.get("company") or "").strip()
                if (r.get("rating") or "").strip():
                    cur["rated"] = True
                if r.get("analyst") or r.get("article"):
                    cur["has_thesis"] = True
    for p in (data.get("my_analyst_picks") or []):
        t = (p.get("ticker") or "").strip().upper()
        if t:
            out.setdefault(t, {"company": "", "rated": False, "has_thesis": False})["has_thesis"] = True
    return out


def _eco_neighbors(output_dir: Path) -> dict[str, list[dict]]:
    """Symmetrized supply-chain adjacency: ticker -> [{ticker, importance}]."""
    sc = _load(output_dir / "supplychain.json")
    adj: dict[str, dict[str, int]] = {}

    def add(a: str, b: str, imp: int) -> None:
        if not a or not b or a == b:
            return
        m = adj.setdefault(a, {})
        if b not in m or imp > m[b]:
            m[b] = imp

    for t, rec in sc.items():
        if not isinstance(rec, dict):
            continue
        for kind in ("upstream", "downstream", "peers"):
            for e in (rec.get(kind) or []):
                b = (e.get("ticker") or "").strip().upper()
                if not b:
                    continue
                try:
                    imp = min(3, max(1, int(e.get("importance", 2) or 2)))
                except (TypeError, ValueError):
                    imp = 2
                add(t.upper(), b, imp)
                add(b, t.upper(), imp)
    return {t: [{"ticker": b, "importance": i} for b, i in m.items()] for t, m in adj.items()}


def focus_ranked(output_dir: Path) -> list[tuple[str, str, float]]:
    """Port of the dashboard's Focus-List priority so catalysts are fetched
    highest-value first: rank rated names by a buy + ecosystem + thesis composite
    (attention was dropped from the score, matching the UI). Returns ordered
    [(ticker, company, score)] for names actually on the Focus List."""
    seeds = _seed_info(output_dir)
    tech = _load(output_dir / "technical_latest.json")
    ticks = tech.get("tickers") or {}
    no_data = set(tech.get("no_data") or [])
    caps = _load(output_dir / "marketcaps.json")
    eco = _eco_neighbors(output_dir)

    rated = {t for t, s in seeds.items() if s.get("rated")}

    def is_anchor(tk: str) -> bool:
        c = caps.get(tk)
        return isinstance(c, (int, float)) and c >= BYPASS_CAP

    out: list[tuple[str, str, float]] = []
    for t in rated:
        if t in no_data:
            continue
        tt = ticks.get(t) or {}
        strong = ((tt.get("gauge") or {}).get("summary")) == "strong_buy"
        streak = int(tt.get("buy_streak") or 0)
        neigh = [n for n in eco.get(t, []) if n["ticker"] in rated and n["ticker"] != t]
        links = len(neigh)
        anchors = sum(1 for n in neigh if is_anchor(n["ticker"]))
        eco_w = sum((6 if is_anchor(n["ticker"]) else 2) * (n["importance"] / 2) for n in neigh)
        g_buy = strong or streak >= 5
        g_eco = anchors >= 1 or links >= 3
        g_thesis = bool(seeds[t].get("has_thesis"))
        gates = int(g_buy) + int(g_eco) + int(g_thesis)
        if gates == 0 and links == 0 and streak < 3:
            continue  # not on the Focus List
        buy_part = (2.5 if strong else (1.3 if g_buy else 0.0)) + min(streak, 5) / 5 * 1.5
        eco_part = min(eco_w / 16.0, 1.0) * 4.5
        thesis_part = 1.0 if g_thesis else 0.0
        out.append((t, seeds[t].get("company", ""), round(buy_part + eco_part + thesis_part, 2)))
    out.sort(key=lambda x: x[2], reverse=True)
    return out


def _prompt(ticker: str, name: str, sector: str = "") -> str:
    who = f"{ticker} ({name})" if name else ticker
    ctx = f" It is classified in the '{sector}' sector." if sector else ""
    today = date.today().isoformat()
    return (
        f"You are a buy-side equity-research analyst. Today is {today}. Using web search, identify the "
        f"UPCOMING catalysts over roughly the next 6 months that could RE-RATE the US-listed company "
        f"{who}.{ctx} A catalyst is a specific, identifiable future event or process — not a vague hope. "
        "Cross-check with primary sources (company IR / press releases, SEC filings, the FDA/regulatory "
        "calendar, official earnings-date calendars, exchange index-rebalance schedules) and reputable "
        "financial press. Prefer PRIMARY, DATED sources.\n\n"
        "Catalyst types (pick the closest):\n"
        "- earnings: the next scheduled quarterly print.\n"
        "- guidance: a guide raise/cut, pre-announcement, analyst/investor day, capacity or price update.\n"
        "- approval: an FDA PDUFA / CHMP / other regulatory decision, or a major product launch/certification.\n"
        "- order: a large contract, design win, backlog award, or a customer/partner announcement.\n"
        "- m_and_a: a deal, strategic review, activist stake, spin-off, or take-private.\n"
        "- capital_return: buyback authorization, dividend initiation/raise, or special dividend.\n"
        "- policy: a law, tariff, subsidy, or regulatory change that materially helps this company.\n"
        "- index: addition to / promotion within a major index (forced buying).\n"
        "- mgmt: a CEO/CFO change or key hire.\n"
        "- revision: an estimate-revision / upgrade cycle already underway.\n\n"
        "Return ONLY a JSON object (no prose, no markdown fences):\n"
        '{"ticker":"' + ticker + '","catalysts":[{'
        '"type":"...",'
        '"title":"short headline label",'
        '"cls":"A or B",'
        '"event_date":"YYYY-MM-DD or null",'
        '"window_days":null,'
        '"P":0,"M":0,"N":0,'
        '"summary":"2-3 sentences: WHAT the event is, WHY it could re-rate the stock, and WHAT to watch for",'
        '"thesis":"one short headline clause",'
        '"evidence":"one line justifying the P/M/N grades",'
        '"source_url":"https://..."}]}\n\n'
        "TIMING — classify each catalyst A or B and give the days accordingly:\n"
        "- A (timed): there IS an objective calendar date (earnings, a regulatory decision date, an index "
        "rebalance, a lockup expiry, a dated investor day). Put the ISO date in event_date; leave window_days null.\n"
        "- B (untimed): no fixed date. Set window_days = your best estimate of the number of DAYS FROM TODAY to "
        "the MIDPOINT of the likely window. Anchoring guidance: a downstream/supplier company that typically "
        "follows an upstream ANCHOR's report by ~1-2 quarters → ~45-90 days (take the midpoint); a deal or "
        "regulatory process with a rough expected close → its midpoint; if an analyst/author stated an expected "
        "timeframe, use theirs. Leave event_date null.\n\n"
        "GRADE each catalyst (integers only, be conservative — when unsure, grade LOWER):\n"
        "- P probability / evidence strength 0-3: 0 = pure speculation · 1 = directional evidence (channel checks, "
        "management hints) · 2 = hard evidence in hand (bookings, data readouts, filings) · 3 = already announced, "
        "only the confirmation/close remains.\n"
        "- M magnitude / financial impact if it fires 0-3: 0 = noise · 1 = moves one quarter · 2 = moves the full "
        "year's numbers · 3 = changes the multi-year narrative / TAM.\n"
        "- N narrative fit vs today's hottest market themes 0-2: 0 = unrelated · 1 = tangential · 2 = squarely on "
        "the single hottest theme right now.\n\n"
        "Rules:\n"
        "- EVERY catalyst MUST have a real, specific source_url (a page that actually documents the event/date). "
        "No credible source → omit it. NEVER invent dates, events, or URLs.\n"
        "- List the strongest, most concrete catalysts first; skip generic 'could beat earnings' filler.\n"
        "- If you find nothing credible, return an empty catalysts array."
    )


def _extract_json(text: str) -> dict | None:
    """Pull the JSON object out of the model's text (tolerant of stray prose)."""
    text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    # Fall back to the outermost {...} span.
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def _timing(days: int | None) -> float:
    """T (0-25): a peak curve on days-to-event. Peaks at ~2 weeks; too-near
    (<0 → 0) and too-far both decay. T = 25·exp(−((days−14)²)/(2·21²))."""
    if days is None or days < 0:
        return 0.0
    return 25.0 * math.exp(-((days - 14) ** 2) / (2 * 21 * 21))


def _days_to(cat: dict, today: date) -> int | None:
    """A-class: calendar date − today. B-class: estimated window midpoint days."""
    ed = cat.get("event_date")
    if ed:
        try:
            return (date.fromisoformat(str(ed)[:10]) - today).days
        except ValueError:
            pass
    wd = cat.get("window_days")
    try:
        return int(wd) if wd is not None else None
    except (TypeError, ValueError):
        return None


def _lvl(x, hi: int) -> int:
    try:
        return max(0, min(hi, int(round(float(x)))))
    except (TypeError, ValueError):
        return 0


# Score floors — the tunable knobs of the multiplicative model (keep in sync
# with pipeline.ts _tpmnStrength).
_P_FLOOR = 0.4  # P=0 → 0.40, P=3 → 1.0
_T_FLOOR = 0.2  # timing=0 → 0.20, timing peak → 1.0
_N_FLOOR = 0.7  # N=0 → 0.70, N=2 → 1.0


def _tpmn(cat: dict, today: date) -> dict:
    """Per-catalyst 0-10 score, MULTIPLICATIVE so scores spread. Magnitude leads
    (sector-neutral, a hard ceiling), probability & narrative are gentle floors,
    and timing is the peak curve (T/25). Replaces the additive sum, which let the
    near-universal earnings catalyst saturate every name to ~9.8."""
    ctype = cat.get("type") if cat.get("type") in CATALYST_TYPES else "other"
    days = _days_to(cat, today)
    T = round(_timing(days), 1)
    P = _lvl(cat.get("P"), 3)
    M = _lvl(cat.get("M"), 3)
    N = _lvl(cat.get("N"), 2)
    mag = M / 3
    prob = _P_FLOOR + (1 - _P_FLOOR) * (P / 3)
    tfac = _T_FLOOR + (1 - _T_FLOOR) * (T / 25)
    narr = _N_FLOOR + (1 - _N_FLOOR) * (N / 2)
    score = round(mag * prob * tfac * narr * 10, 1)
    cls = "A" if cat.get("event_date") else ("B" if cat.get("window_days") is not None else (cat.get("cls") or "B"))
    return {"T": T, "P": P, "M": M, "N": N, "days": days, "cls": cls, "score": score, "type": ctype}


def _clean(parsed: dict, today: date) -> list[dict]:
    """Keep only sourced catalysts; attach TPMN; sort strongest first."""
    out: list[dict] = []
    for c in (parsed.get("catalysts") or [])[: MAX_CATALYSTS * 2]:
        if not isinstance(c, dict):
            continue
        url = (c.get("source_url") or "").strip()
        if not url.startswith("http"):
            continue  # no citation → drop (guards against hallucinated events)
        tpmn = _tpmn(c, today)
        # Store only forward-looking dated catalysts. An A-class event already in
        # the past at fetch time is spent — and if we kept it, the "a catalyst
        # fired" staleness test would re-trigger every run and never converge.
        # (Events that pass BETWEEN fetches are handled by the live decay + the
        # re-analysis below.)
        if tpmn["cls"] == "A" and tpmn["days"] is not None and tpmn["days"] < 0:
            continue
        wd = c.get("window_days")
        try:
            wd = int(wd) if wd is not None else None
        except (TypeError, ValueError):
            wd = None
        cat = {
            "type": tpmn["type"],
            "title": (c.get("title") or "").strip()[:160],
            "cls": tpmn["cls"],
            "event_date": (str(c.get("event_date"))[:10] if c.get("event_date") else None),
            "window_days": wd,
            "source_url": url,
            "summary": (c.get("summary") or "").strip()[:600],
            "thesis": (c.get("thesis") or "").strip()[:200],
            "evidence": (c.get("evidence") or "").strip()[:200],
            "tpmn": tpmn,
        }
        out.append(cat)
    out.sort(key=lambda x: x["tpmn"]["score"], reverse=True)
    return out[:MAX_CATALYSTS]


def _complete(client, model: str, prompt: str) -> str:
    """One NON-streamed chat.completions call; returns the text.

    This gateway implements /chat/completions but NOT /responses (the Responses
    API 500s for every model), AND its STREAMING path also 500s — only the plain
    non-streamed /chat/completions works. So we use that. No native web_search
    tool means the model answers from its own knowledge, so dates and sources are
    only as current as its training cutoff (see the module note).
    """
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    return (resp.choices[0].message.content or "") if resp.choices else ""


def _fetch_one(client, ticker: str, name: str, today: date, model: str, sector: str = "") -> dict | None:
    try:
        text = _complete(client, model, _prompt(ticker, name, sector))
    except Exception as exc:  # noqa: BLE001
        logger.warning("  %s: API error (%s)", ticker, exc)
        return None
    parsed = _extract_json(text)
    if parsed is None:
        logger.warning("  %s: could not parse JSON response", ticker)
        return None
    cats = _clean(parsed, today)
    return {
        "catalysts": cats,
        "score": cats[0]["tpmn"]["score"] if cats else 0.0,
        "best_type": cats[0]["type"] if cats else None,
        "model": model,
        "ok": True,
        "generated_at": today.isoformat(),
    }


def _is_stale(entry: dict, today: date, max_age_days: float) -> bool:
    """A cached ticker worth re-fetching. Two triggers:
    1. the record is older than ``max_age_days`` (fresh market catalysts may
       have appeared since), or
    2. ANY dated catalyst it holds has already fired. A fired event (an earnings
       print, an approval, an up/down-stream read-through) is exactly when NEW
       catalysts appear — fresh guidance, estimate revisions, follow-on deals —
       so the whole ticker must be re-analysed, not just when the LAST one fires.
    """
    ga = entry.get("generated_at")
    if not ga:
        return True
    try:
        age = (today - date.fromisoformat(ga)).days
    except ValueError:
        return True  # unparseable stamp — refresh it
    if age >= max_age_days:
        return True
    for c in entry.get("catalysts") or []:
        if c.get("cls") != "A" or not c.get("event_date"):
            continue
        try:
            if date.fromisoformat(c["event_date"]) < today:
                return True  # a dated catalyst has fired → re-scan for what's next
        except ValueError:
            continue
    return False


def fetch_missing(
    tickers: dict[str, str],
    have: dict[str, dict],
    today: date,
    workers: int = 3,
    model: str = MODEL,
    sectors: dict[str, dict] | None = None,
    out_path: Path | None = None,
    refetch: set[str] | None = None,
    base: dict[str, dict] | None = None,
) -> dict[str, dict]:
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai SDK not installed — `pip install openai`; skipping catalyst")
        return {}
    if not os.environ.get("OPENAI_API_KEY"):
        logger.warning("OPENAI_API_KEY not set — skipping catalyst discovery")
        return {}

    refetch = refetch or set()
    missing = {t: n for t, n in tickers.items() if t not in have or t in refetch}
    if not missing:
        logger.info("no new tickers — catalyst cache already complete (%d)", len(have))
        return {}
    nnew = sum(1 for t in missing if t not in have)
    logger.info(
        "finding catalysts for %d tickers via %s (web search) — %d new, %d stale re-fetch…",
        len(missing), model, nnew, len(missing) - nnew,
    )

    from concurrent.futures import ThreadPoolExecutor, as_completed

    sectors = sectors or {}
    client = OpenAI()
    endpoint = str(getattr(client, "base_url", "") or "")
    logger.info("OpenAI endpoint: %s", endpoint)
    if "api.openai.com" in endpoint:
        logger.warning(
            "hitting the DEFAULT api.openai.com — a custom-gateway key will 401 here. "
            "Set OPENAI_BASE_URL (and re-run install_mac.sh so the launchd job has it baked in)."
        )
    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(_fetch_one, client, t, n, today, model, (sectors.get(t) or {}).get("sector", "")): t
            for t, n in missing.items()
        }
        for i, fut in enumerate(as_completed(futures), 1):
            t = futures[fut]
            res = fut.result()
            if res:
                out[t] = res
                # Checkpoint after every ticker so a long background run persists
                # progress (survives Ctrl-C / a dropped connection) and the
                # dashboard fills in live.
                if out_path is not None:
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    out_path.write_text(json.dumps({**(base if base is not None else have), **out}))
            if i % 5 == 0 or i == len(missing):
                logger.info("  %d/%d… (%d with catalysts so far)", i, len(missing), sum(1 for v in out.values() if v.get("catalysts")))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage 3 — find dated, sourced catalysts per ticker (LLM web search, cached)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override (e.g. the Focus List)")
    ap.add_argument("--refresh", action="store_true", help="re-fetch all, ignore cache")
    ap.add_argument("--limit", type=int, default=25, help="cap how many new tickers to fetch this run (default 25; --limit 0 = all uncached; web search is slow)")
    ap.add_argument("--model", default=MODEL, help=f"OpenAI model id (default {MODEL})")
    ap.add_argument("--min-cap", type=float, default=3e8, help="skip tickers below this market cap (default $300M)")
    ap.add_argument("--max-age", type=float, default=0.0, help="re-fetch cached tickers older than N days (or whose dated catalysts have all fired); 0 = never re-fetch (default)")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    out_path = settings.output_dir / CATALYST_FILE
    existing = _load(out_path)  # everything currently cached — NEVER dropped
    have = dict(existing)

    if args.tickers:
        names = {t.strip().upper(): "" for t in args.tickers.split(",") if t.strip()}
    else:
        # Fetch highest Focus-List score first, so the limited daily budget goes
        # to the most promising names. Falls back to rated seeds if the Focus
        # inputs (technical / supplychain) aren't there yet.
        ranked = focus_ranked(settings.output_dir)
        if ranked:
            logger.info("focus-ranked %d names (top: %s)", len(ranked), ", ".join(t for t, _, _ in ranked[:5]))
            names = {t: c for t, c, _ in ranked}
        else:
            names = rated_seed_tickers(settings.output_dir)
    if not names:
        logger.warning("no tickers (run the SA scrape first, or pass --tickers)")
        return 1

    caps = _load(settings.output_dir / "marketcaps.json")
    if args.min_cap and caps:
        before = len(names)
        names = {t: n for t, n in names.items() if not (isinstance(caps.get(t), (int, float)) and caps[t] < args.min_cap)}
        skipped = before - len(names)
        if skipped:
            logger.info("skipping %d tickers below $%.0fM market cap", skipped, args.min_cap / 1e6)

    today = date.today()

    # --refresh re-fetches the REQUESTED names but PRESERVES every other cached
    # map (drop only the requested ones from `have` so they count as missing).
    if args.refresh:
        for t in names:
            have.pop(t, None)

    # Staleness: cached names old enough (or whose dated catalysts have all
    # fired) are eligible to be re-fetched so new market catalysts get picked up.
    stale: set[str] = set()
    if args.max_age > 0:
        stale = {t for t in names if t in have and _is_stale(have[t], today, args.max_age)}
        if stale:
            logger.info("%d cached tickers stale (>%.0fd or events fired) — will re-fetch", len(stale), args.max_age)

    if args.limit:
        # New tickers first, then stale re-fetches — both in Focus-rank order.
        pending = [t for t in names if t not in have][: args.limit]
        if len(pending) < args.limit:
            pending += [t for t in names if t in stale and t not in pending][: args.limit - len(pending)]
        names = {t: names[t] for t in pending}

    sectors = _load(settings.output_dir / "sectors.json")

    fetched = fetch_missing(names, have, today, workers=args.workers, model=args.model, sectors=sectors, out_path=out_path, refetch=stale, base=existing)
    merged = {**existing, **fetched}  # untouched maps survive; refetched overwrite
    if not merged:
        logger.warning("no catalyst data resolved (no key / API error); keeping existing file")
        return 1

    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged))
    withcat = sum(1 for v in merged.values() if v.get("catalysts"))
    logger.info("wrote %d catalyst maps (+%d new, %d with ≥1 catalyst)", len(merged), len(fetched), withcat)
    print(f"catalyst: {len(merged)} (+{len(fetched)} new, {withcat} with catalysts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
