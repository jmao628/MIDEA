"""Stage 5 — Management Conviction (four-layer tone read).

Read scope (matches the dashboard's ConvictionView): for EACH sector, every
Tier-1 shortlist name plus the top ``TIER2_PER_SECTOR`` Tier-2 names by composite
strength — a tone read is expensive, so it's spent on each sector's real leaders,
not the whole ~280-name Focus tail. ``_read_targets`` is a port of the frontend's
buildFocus + buildShortlist so the names read here are exactly the ones shown.

For each selected name we ask an LLM **with web search** to READ the most recent
management commentary — the ticker's own earnings-call transcript / 10-Q-K / press
release, or, if the company has no useful recent call of its own (pre-revenue, no
transcript, freshly-IPO'd), an UPSTREAM ANCHOR's call read through to it — and to
score how much the tone actually backs the thesis. Four layers, graded by the LLM
from the source text, each with a short evidence quote and a confidence:

    L1  Tone baseline        0-2 : guidance vs last quarter — downgrade 0 / flat 1 / clear upgrade 2
    L2  Evasion              0-3 : answers to hard questions — dodges 0 / vague 1 / occasional 2 / straight numbers 3
    L3  Hard vs soft          0-3 : commitments — all soft 0 / mostly soft 1 / mixed 2 / hard/dated 3
    L4  Walk the talk         0-2 : insider actions vs words — talks up but sells 0 / no signal 1 / bullish & buying 2

The total (0-10) is summed **deterministically in Python** from those four layer
scores — the LLM only grades the layers and cites the text, it never returns the
total. Every record carries the source (own vs upstream-anchor), the anchor used,
the call reference/date, and a source_url; a record with no citable source is kept
only with low confidence so the UI can gray it out.

Provider: OpenAI (the user's gateway). Reads ``OPENAI_API_KEY`` (and, if the
gateway needs it, ``OPENAI_BASE_URL``) from the environment — never from code or
the repo. The gateway requires streaming, so we stream and collect the output
text. No key / SDK → this step logs a warning and is skipped.

Like ``catalyst.py`` this is a **cached, incremental** fetch: only Shortlist names
missing from ``data/newsagg/conviction.json`` are looked up (unless --refresh),
and each ticker is checkpointed as it completes so a long run is never lost.

Writes ``data/newsagg/conviction.json`` =
    {ticker: {layers:{L1..L4:{score,max,evidence,confidence}}, total, confidence,
              source, anchor_ticker, anchor_name, call_ref, call_date, source_url,
              summary, model, ok, generated_at}}

    OPENAI_API_KEY=... python -m newsagg.conviction --limit 25
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import date
from pathlib import Path

from newsagg.catalyst import (
    BYPASS_CAP,
    _complete,
    _eco_neighbors,
    _extract_json,
    _load,
    _seed_info,
    _timing,
    _P_FLOOR,
    _T_FLOOR,
    _N_FLOOR,
)
from newsagg.config import load_settings

logger = logging.getLogger("newsagg.conviction")

CONVICTION_FILE = "conviction.json"
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")

# Per-layer caps (the rubric's ranges). raw_total = L1+L2+L3+L4 ∈ [0,10].
_LAYER_MAX = {"L1": 2, "L2": 3, "L3": 3, "L4": 2}
# Hedging is a language-density SUPPRESSOR (0-3), not an additive layer: the
# final total = raw_total × (1 − 0.15·hedging). So pervasive hedging (level 3)
# docks the score 45% — confident numbers wrapped in mushy language don't get a
# free 10. This is the main cure for score saturation.
_HEDGE_STEP = 0.15

# Read universe (matches the dashboard's ConvictionView): for EACH sector, every
# Tier-1 shortlist name plus the top N Tier-2 names by composite strength.
SHORTLIST_CAT_BAR = 6  # catalyst score must EXCEED this to count (mirror pipeline.ts)
TIER2_PER_SECTOR = 15


def _anchor_for(ticker: str, eco: dict[str, list[dict]], caps: dict, names: dict[str, str]) -> tuple[str, str]:
    """Best upstream ANCHOR for read-through: the most tightly-linked mega-cap
    ecosystem neighbor (importance first, then market cap). Empty if none — most
    names read their OWN call and never need this."""
    best: tuple[int, float, str] | None = None
    for n in eco.get(ticker, []):
        b = n.get("ticker", "")
        cap = caps.get(b)
        if not b or b == ticker or not isinstance(cap, (int, float)) or cap < BYPASS_CAP:
            continue
        imp = int(n.get("importance", 2) or 2)
        key = (imp, float(cap), b)
        if best is None or key > best:
            best = key
    if not best:
        return "", ""
    tk = best[2]
    return tk, names.get(tk, "")


def _prompt(ticker: str, name: str, sector: str, anchor_ticker: str, anchor_name: str) -> str:
    who = f"{ticker} ({name})" if name else ticker
    ctx = f" It is classified in the '{sector}' sector." if sector else ""
    anchor_line = ""
    if anchor_ticker:
        who_anchor = f"{anchor_ticker} ({anchor_name})" if anchor_name else anchor_ticker
        anchor_line = (
            f" If {ticker} has NO useful recent call of its own (pre-revenue, no transcript, "
            f"just IPO'd), you MAY instead read the most recent earnings call of its upstream "
            f"anchor {who_anchor} and read its tone THROUGH to {ticker}; set source='upstream_anchor' "
            f"and fill anchor_ticker/anchor_name. Otherwise ALWAYS prefer {ticker}'s own call."
        )
    today = date.today().isoformat()
    return (
        f"You are a buy-side analyst reading MANAGEMENT TONE line by line. Today is {today}. Using web search, "
        f"find and READ the FULL TEXT of the MOST RECENT quarterly earnings-call TRANSCRIPT for the US-listed "
        f"company {who}{ctx} — BOTH the prepared remarks AND the analyst Q&A. ALSO pull up the PRIOR quarter's "
        "transcript (you need it for L4 follow-through). Good transcript sources include Motley Fool, Seeking "
        "Alpha, Roic.ai, Quartr, TIKR, the company's own IR site, and the 8-K exhibit on SEC EDGAR. If truly no "
        "transcript exists, fall back to the latest 10-Q/10-K MD&A or guidance press release. Read the actual "
        "words management used — do not judge from a headline or a summary article."
        + anchor_line + "\n\n"
        "Then grade FOUR layers, and for EACH layer support the grade with a DIRECT VERBATIM QUOTE — the exact "
        "words from the transcript, copied character-for-character inside double quotes — prefixed with WHO said "
        "it and WHERE, e.g. `CFO, Q&A: \"...\"` or `CEO, prepared remarks: \"...\"`. Quote the single most "
        "telling line (or two) for that layer. Do NOT paraphrase, summarize, or clean up the wording; if you "
        "cannot find a real verbatim line to quote for a layer, lower that layer's confidence rather than "
        "inventing one.\n\n"
        "SCORING DISCIPLINE — this score must DISCRIMINATE, not flatter. A normal solid quarter lands 5-7 out of "
        "10. Reserve the top of each layer for genuinely exceptional, hedge-free behaviour. Before giving any layer "
        "its MAX, re-read your own quote and ask 'does this line, on its own, fully earn the top mark with NO "
        "hedge?' — if it hedges, defers, or is only partial, drop a point. The evidence quote must be the STRONGEST "
        "line you can find for that grade; if the strongest line still contains a hedge, the grade MUST reflect the "
        "hedge (do not score 3 and then quote a line that says 'let's take it offline'). When unsure, grade LOWER.\n\n"
        "LAYERS (integers only):\n"
        "- L1 Tone baseline 0-2 — the DIRECTION of guidance/outlook vs the prior quarter: "
        "0 = a cut / downgrade / lowered outlook · 1 = flat / reiterated / in-line / merely 'reaffirmed' · "
        "2 = an EXPLICIT, quantified RAISE of the guide (numbers moved up). A qualitative 'we feel great' with no "
        "raised number is 1, not 2.\n"
        "- L2 Directness 0-3 — how DIRECTLY management answers the HARD analyst questions in Q&A (not the easy "
        "ones): 0 = repeatedly dodges / changes the subject · 1 = vague, talks around it · 2 = mostly straight but "
        "with a hedge on a key question · 3 = clean, quantified, head-on answers with NO deflection. ANY of 'take "
        "it offline', 'we'll follow up', 'hard to say / to quantify', 'we don't break that out', or a non-answer on "
        "a KEY question CAPS this at 2 — a 3 means they took the hard question head-on with specifics.\n"
        "- L3 Hard vs soft 0-3 — how CONCRETE the forward commitments are: 0 = all soft ('we're optimistic', "
        "'well-positioned') · 1 = one vague number or a single soft target · 2 = a mix, some hard some soft · "
        "3 = MULTIPLE hard, dated, QUANTIFIED commitments (e.g. specific revenue AND margin targets, dated "
        "milestones, signed backlog) — one lone number is not enough for a 3.\n"
        "- L4 Follow-through 0-2 — did management DELIVER on the SPECIFIC promises/targets they made on the PRIOR "
        "quarter's call? Compare the two transcripts: 0 = they MISSED, walked back, or quietly DROPPED a prior "
        "commitment (e.g. hyped a product/metric last quarter, then went silent on it) · 1 = roughly in line, "
        "mixed, or not enough prior specificity to judge · 2 = they explicitly HIT or BEAT what they committed to "
        "last quarter. Insiders are only a MODIFIER here, not the driver: IGNORE routine 10b5-1 / RSU-tax / "
        "option-exercise sales (that is mechanical, not a view). Only UNUSUAL open-market activity counts — real "
        "cluster BUYING can confirm a 2; conspicuous cluster SELLING into a bullish story is a red flag that caps "
        "this at 1.\n\n"
        "SEPARATELY, rate HEDGING — the density of weak/uncertain LANGUAGE across the whole call. This is about "
        "linguistic STYLE (weak modals + uncertainty words: 'we think', 'hopefully', 'should', 'roughly', 'kind "
        "of', 'a bit', 'somewhat', 'try to', 'I guess', 'to some degree'), SEPARATE from whether they dodged a "
        "question (L2) or quantified commitments (L3). 0 = crisp, declarative, confident throughout · 1 = mostly "
        "crisp, some hedging · 2 = noticeably hedgy · 3 = pervasive hedging / vague qualifiers everywhere. High "
        "hedging DISCOUNTS the whole score, so confident numbers wrapped in mushy language don't get a free pass. "
        "Quote one representative line (crisp or hedgy).\n\n"
        "Return ONLY a JSON object (no prose, no markdown fences):\n"
        '{"ticker":"' + ticker + '",'
        '"source":"own or upstream_anchor",'
        '"anchor_ticker":"' + anchor_ticker + ' or empty",'
        '"anchor_name":"",'
        '"call_ref":"e.g. Q2 FY2026 earnings call",'
        '"call_date":"YYYY-MM-DD or null",'
        '"source_url":"https://... (the actual transcript page you read)",'
        '"summary":"3-4 sentences: the overall read on management tone and whether it backs the thesis",'
        '"L1":{"score":0,"evidence":"speaker, segment: \\"exact verbatim quote from the transcript\\"","confidence":0.0},'
        '"L2":{"score":0,"evidence":"...","confidence":0.0},'
        '"L3":{"score":0,"evidence":"...","confidence":0.0},'
        '"L4":{"score":0,"evidence":"last Q they said \\"...\\"; this Q: \\"...\\" (+ any unusual insider action)","confidence":0.0},'
        '"hedging":{"level":0,"evidence":"a representative crisp or hedgy verbatim line","confidence":0.0}}\n\n'
        "Rules:\n"
        "- Each layer's `evidence` MUST contain a VERBATIM quote copied from the transcript (exact wording, in "
        "double quotes), attributed to the speaker. This is the whole point — the quote is the receipt for the grade.\n"
        "- source_url MUST be the real transcript/filing page you actually read. NEVER invent URLs or quotes; a "
        "fabricated quote is worse than a low grade.\n"
        "- confidence 0.0-1.0 per layer = how directly the quoted words pin that grade (low if you had to infer "
        "beyond what was literally said).\n"
        "- L4: the quote may instead cite a specific Form 4 / buyback disclosure (e.g. 'CEO sold 40,000 sh on "
        "2026-05-03 per Form 4', '$300M repurchased in Q1 per the release') — still a concrete, sourced fact.\n"
        "- If you cannot find ANY citable recent transcript/filing for the company OR its anchor, set every score "
        "to 0, every confidence to 0, source_url to '' and say so in summary. Do NOT fabricate a call."
    )


def _lvl(x, hi: int) -> int:
    try:
        return max(0, min(hi, int(round(float(x)))))
    except (TypeError, ValueError):
        return 0


def _conf(x) -> float:
    try:
        return round(max(0.0, min(1.0, float(x))), 2)
    except (TypeError, ValueError):
        return 0.0


def _clean(parsed: dict, ticker: str, anchor_ticker: str, anchor_name: str, model: str, today: date) -> dict:
    """Grade the four layers deterministically; sum the total; keep provenance."""
    layers: dict[str, dict] = {}
    confs: list[float] = []
    for k, hi in _LAYER_MAX.items():
        raw = parsed.get(k) if isinstance(parsed.get(k), dict) else {}
        score = _lvl(raw.get("score"), hi)
        conf = _conf(raw.get("confidence"))
        confs.append(conf)
        layers[k] = {
            "score": score,
            "max": hi,
            # Roomy — the evidence is a verbatim transcript quote (with speaker),
            # so it must not be clipped mid-sentence.
            "evidence": (raw.get("evidence") or "").strip()[:700],
            "confidence": conf,
        }
    raw_total = sum(layers[k]["score"] for k in _LAYER_MAX)  # 0-10 (pre-suppression)
    hraw = parsed.get("hedging") if isinstance(parsed.get("hedging"), dict) else {}
    h_level = _lvl(hraw.get("level"), 3)
    h_conf = _conf(hraw.get("confidence"))
    h_factor = round(1 - _HEDGE_STEP * h_level, 2)  # 0→1.0, 3→0.55
    hedging = {
        "level": h_level,
        "factor": h_factor,
        "evidence": (hraw.get("evidence") or "").strip()[:400],
        "confidence": h_conf,
    }
    total = round(raw_total * h_factor, 1)  # final 0-10, hedging-discounted
    src = (parsed.get("source") or "own").strip().lower()
    src = "upstream_anchor" if src.startswith("upstream") else "own"
    a_tk = (parsed.get("anchor_ticker") or "").strip().upper()
    if a_tk and not a_tk.replace(".", "").replace("-", "").isalpha():
        a_tk = ""
    if src == "upstream_anchor" and not a_tk:
        a_tk = anchor_ticker
    a_name = (parsed.get("anchor_name") or "").strip() or (anchor_name if a_tk == anchor_ticker else "")
    url = (parsed.get("source_url") or "").strip()
    if not url.startswith("http"):
        url = ""
    return {
        "layers": layers,
        "hedging": hedging,
        "raw_total": raw_total,
        "total": total,
        "confidence": round(sum(confs) / len(confs), 2) if confs else 0.0,
        "source": src if src == "own" else "upstream_anchor",
        "anchor_ticker": a_tk if src == "upstream_anchor" else "",
        "anchor_name": a_name if src == "upstream_anchor" else "",
        "call_ref": (parsed.get("call_ref") or "").strip()[:120],
        "call_date": (str(parsed.get("call_date"))[:10] if parsed.get("call_date") else None),
        "source_url": url,
        "summary": (parsed.get("summary") or "").strip()[:900],
        "model": model,
        "ok": bool(url),  # a real citation → trustworthy; else low-confidence placeholder
        "generated_at": today.isoformat(),
    }


def _fetch_one(client, ticker: str, name: str, today: date, model: str, sector: str, anchor: tuple[str, str]) -> dict | None:
    a_tk, a_name = anchor
    try:
        text = _complete(client, model, _prompt(ticker, name, sector, a_tk, a_name))
    except Exception as exc:  # noqa: BLE001
        logger.warning("  %s: API error (%s)", ticker, exc)
        return None
    parsed = _extract_json(text)
    if parsed is None:
        logger.warning("  %s: could not parse JSON response", ticker)
        return None
    return _clean(parsed, ticker, a_tk, a_name, model, today)


def _is_stale(entry: dict, today: date, max_age_days: float) -> bool:
    """Re-read a name whose record is older than ``max_age_days`` (a new quarterly
    call has likely happened) or that never got a citable source (retry it)."""
    if not entry.get("ok") or not entry.get("source_url"):
        return True
    ga = entry.get("generated_at")
    if not ga:
        return True
    try:
        return (today - date.fromisoformat(ga)).days >= max_age_days
    except ValueError:
        return True


def fetch_missing(
    tickers: dict[str, str],
    have: dict[str, dict],
    today: date,
    workers: int = 3,
    model: str = MODEL,
    sectors: dict[str, dict] | None = None,
    anchors: dict[str, tuple[str, str]] | None = None,
    out_path: Path | None = None,
    refetch: set[str] | None = None,
    base: dict[str, dict] | None = None,
) -> dict[str, dict]:
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai SDK not installed — `pip install openai`; skipping conviction")
        return {}
    if not os.environ.get("OPENAI_API_KEY"):
        logger.warning("OPENAI_API_KEY not set — skipping conviction read")
        return {}

    refetch = refetch or set()
    anchors = anchors or {}
    missing = {t: n for t, n in tickers.items() if t not in have or t in refetch}
    if not missing:
        logger.info("no new tickers — conviction cache already complete (%d)", len(have))
        return {}
    nnew = sum(1 for t in missing if t not in have)
    logger.info(
        "reading management tone for %d tickers via %s (web search) — %d new, %d stale re-fetch…",
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
            ex.submit(
                _fetch_one, client, t, n, today, model,
                (sectors.get(t) or {}).get("sector", ""),
                anchors.get(t, ("", "")),
            ): t
            for t, n in missing.items()
        }
        for i, fut in enumerate(as_completed(futures), 1):
            t = futures[fut]
            res = fut.result()
            if res:
                out[t] = res
                if out_path is not None:
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    out_path.write_text(json.dumps({**(base if base is not None else have), **out}))
            if i % 5 == 0 or i == len(missing):
                logger.info("  %d/%d… (%d with a citable call so far)", i, len(missing), sum(1 for v in out.values() if v.get("ok")))
    return out


# ── Shortlist tiering (port of the dashboard's buildFocus + buildShortlist) ───
# Kept deliberately close to pipeline.ts so the names this job READS are exactly
# the ones the ConvictionView SHOWS. Small ranking drift (we skip the +0.5
# screen/advancing bonus, which needs heat state) can't change a name's TIER —
# tier is decided by core (buy×eco) and catalyst>6, both computed identically.


def _cat_live_score10(c: dict, today: date) -> float:
    """One catalyst's live 0-10 (timing recomputed for today), mirroring
    pipeline.ts catLiveScore10."""
    tp = c.get("tpmn") or {}
    ed = c.get("event_date")
    days = None
    if ed:
        try:
            days = (date.fromisoformat(str(ed)[:10]) - today).days
        except ValueError:
            days = tp.get("days")
    else:
        days = tp.get("days")
    T = _timing(days)
    P = float(tp.get("P") or 0)
    M = float(tp.get("M") or 0)
    N = float(tp.get("N") or 0)
    strength = (M / 3) * (_P_FLOOR + (1 - _P_FLOOR) * (P / 3)) * (_T_FLOOR + (1 - _T_FLOOR) * (T / 25)) * (_N_FLOOR + (1 - _N_FLOOR) * (N / 2))
    return round(strength * 100) / 10


def _cat_ticker_score(entry: dict | None, today: date) -> float:
    """A ticker's depth-weighted catalyst 0-10 (mirror catTickerScore): -1 if not
    fetched, 0 if fetched with no catalysts."""
    if not entry:
        return -1.0
    cats = entry.get("catalysts") or []
    if not cats:
        return 0.0
    scores = sorted((_cat_live_score10(c, today) for c in cats), reverse=True)
    best = scores[0]
    depth = sum((scores[i] / 10) * (0.5 ** (i - 1)) for i in range(1, len(scores)))
    factor = min(depth * 0.5, 1.0)
    return round((best + (10 - best) * factor) * 10) / 10


def _shortlist_rows(output_dir: Path) -> list[dict]:
    """Every Focus name with its shortlist tier, sector, and composite strength."""
    seeds = _seed_info(output_dir)  # {ticker: {company, rated, has_thesis}}
    universe = set(seeds)
    tech = _load(output_dir / "technical_latest.json")
    ticks = tech.get("tickers") or {}
    no_data = set(tech.get("no_data") or [])
    caps = _load(output_dir / "marketcaps.json")
    eco = _eco_neighbors(output_dir)
    sectors = _load(output_dir / "sectors.json")
    cats = _load(output_dir / "catalyst.json")
    today = date.today()

    def is_anchor(tk: str) -> bool:
        c = caps.get(tk)
        return isinstance(c, (int, float)) and c >= BYPASS_CAP

    rows: list[dict] = []
    for t, s in seeds.items():
        if not s.get("rated") or t in no_data:
            continue
        tt = ticks.get(t) or {}
        strong = ((tt.get("gauge") or {}).get("summary")) == "strong_buy"
        streak = int(tt.get("buy_streak") or 0)
        attn = ((tt.get("attention") or {}).get("score")) or 0
        neigh = [n for n in eco.get(t, []) if n["ticker"] in universe and n["ticker"] != t]
        links = len(neigh)
        anchors = sum(1 for n in neigh if is_anchor(n["ticker"]))
        eco_w = sum((6 if is_anchor(n["ticker"]) else 2) * (n["importance"] / 2) for n in neigh)
        g_buy = strong or streak >= 5
        g_eco = anchors >= 1 or links >= 3
        # Focus membership (inclusive; a pure-thesis-only name with no other signal
        # would be Tier 3 anyway and we never read Tier 3, so skipping it is safe).
        if not (g_buy or g_eco or links > 0 or streak >= 3):
            continue
        core = g_buy and g_eco
        buy_part = (3.0 if strong else 1.6 if g_buy else 0.0) + min(streak, 5) / 5 * 2.0
        eco_part = min(eco_w / 16.0, 1.0) * 4.5
        focus_score = round((buy_part + eco_part) * 10) / 10
        cscore = _cat_ticker_score(cats.get(t), today)
        cat_hot = cscore > SHORTLIST_CAT_BAR
        conditions = 1 + int(core) + int(cat_hot)
        tier = 4 - conditions  # 3→1, 2→2, 1→3
        cat01 = cscore / 10 if cscore >= 0 else 0.0
        composite = round((0.45 * cat01 + 0.45 * focus_score / 10 + 0.10 * attn / 100) * 1000) / 10
        rows.append({
            "ticker": t,
            "company": s.get("company") or (sectors.get(t) or {}).get("name", ""),
            "sector": (sectors.get(t) or {}).get("sector", ""),
            "tier": tier,
            "composite": composite,
        })
    return rows


def _read_targets(output_dir: Path) -> dict[str, str]:
    """The conviction read universe: for EACH sector, ALL Tier-1 names + the top
    TIER2_PER_SECTOR Tier-2 names by composite. Ordered Tier-1 (all sectors) first
    then Tier-2, each by strength, so a capped daily run does the best names first."""
    rows = _shortlist_rows(output_dir)
    if not rows:
        return {}
    by_sector: dict[str, list[dict]] = {}
    for r in rows:
        if r["tier"] <= 2:
            by_sector.setdefault(r["sector"], []).append(r)
    selected: list[dict] = []
    for sec_rows in by_sector.values():
        selected.extend(r for r in sec_rows if r["tier"] == 1)
        t2 = sorted((r for r in sec_rows if r["tier"] == 2), key=lambda r: r["composite"], reverse=True)
        selected.extend(t2[:TIER2_PER_SECTOR])
    # Tier-1 first, then by composite — highest-value reads lead a limited run.
    selected.sort(key=lambda r: (r["tier"], -r["composite"]))
    n1 = sum(1 for r in selected if r["tier"] == 1)
    logger.info(
        "read universe: %d names across %d sectors (%d Tier-1 + %d Tier-2 top-%d/sector)",
        len(selected), len(by_sector), n1, len(selected) - n1, TIER2_PER_SECTOR,
    )
    return {r["ticker"]: r["company"] for r in selected}


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage 5 — read management tone (four layers) per Shortlist name (LLM web search, cached)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--tickers", default=None, help="comma-separated override")
    ap.add_argument("--refresh", action="store_true", help="re-read the requested names, KEEPING every other cached record")
    ap.add_argument("--limit", type=int, default=25, help="cap how many new tickers to read this run (default 25; --limit 0 = all uncached)")
    ap.add_argument("--model", default=MODEL, help=f"OpenAI model id (default {MODEL})")
    ap.add_argument("--min-cap", type=float, default=3e8, help="skip tickers below this market cap (default $300M)")
    ap.add_argument("--max-age", type=float, default=0.0, help="re-read cached tickers older than N days (a new quarterly call has likely happened); 0 = never (default)")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s")

    settings = load_settings(args.config)
    out_path = settings.output_dir / CONVICTION_FILE
    existing = _load(out_path)  # everything currently cached — NEVER dropped
    have = dict(existing)

    if args.tickers:
        names = {t.strip().upper(): "" for t in args.tickers.split(",") if t.strip()}
    else:
        names = _read_targets(settings.output_dir)
    if not names:
        logger.warning("no Shortlist survivors yet (run technical + supplychain + catalyst first, or pass --tickers)")
        return 1

    caps = _load(settings.output_dir / "marketcaps.json")
    if args.min_cap and caps:
        before = len(names)
        names = {t: n for t, n in names.items() if not (isinstance(caps.get(t), (int, float)) and caps[t] < args.min_cap)}
        skipped = before - len(names)
        if skipped:
            logger.info("skipping %d tickers below $%.0fM market cap", skipped, args.min_cap / 1e6)

    today = date.today()

    if args.refresh:
        for t in names:
            have.pop(t, None)

    stale: set[str] = set()
    if args.max_age > 0:
        stale = {t for t in names if t in have and _is_stale(have[t], today, args.max_age)}
        if stale:
            logger.info("%d cached tickers stale (>%.0fd or no citable call) — will re-read", len(stale), args.max_age)

    if args.limit:
        pending = [t for t in names if t not in have][: args.limit]
        if len(pending) < args.limit:
            pending += [t for t in names if t in stale and t not in pending][: args.limit - len(pending)]
        names = {t: names[t] for t in pending}

    # Upstream-anchor candidates (mega-cap ecosystem neighbors) for read-through.
    eco = _eco_neighbors(settings.output_dir)
    from newsagg.marketcap import seed_names

    all_names = seed_names(settings.output_dir)
    anchors = {t: _anchor_for(t, eco, caps, all_names) for t in names}
    sectors = _load(settings.output_dir / "sectors.json")

    fetched = fetch_missing(
        names, have, today, workers=args.workers, model=args.model, sectors=sectors,
        anchors=anchors, out_path=out_path, refetch=stale, base=existing,
    )
    merged = {**existing, **fetched}
    if not merged:
        logger.warning("no conviction data resolved (no key / API error); keeping existing file")
        return 1

    settings.output_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(merged))
    withcall = sum(1 for v in merged.values() if v.get("ok"))
    logger.info("wrote %d conviction reads (+%d new, %d with a citable call)", len(merged), len(fetched), withcall)
    print(f"conviction: {len(merged)} (+{len(fetched)} new, {withcall} with a citable call)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
