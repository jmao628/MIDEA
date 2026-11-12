# MIDEA

### Market Ignition & Discovery Engine

A **local-only** equity discovery terminal that funnels a large universe of
bullish-rated US small/mid-caps down to a short, evidence-backed list of names
worth researching now. It doesn't predict prices — it **ranks what deserves a
look**, using cited evidence at every step.

The app lives in [`newsagg/`](newsagg/). It runs entirely on your own machine
(`localhost:8000`), refreshes daily via `launchd`, and keeps its data in git.

---

## The funnel

```
1  Seed Table        看多种子表      SeekingAlpha bullish ratings
2  Heat  ∥  Screen   热度 ∥ 筛选     attention (vol+social) × quality (rating+thesis)
      └─→ Focus List  重点名单        strong-buy × ecosystem (intersection)
3  Catalyst (TPMN)   催化剂          dated, sourced upcoming catalysts (LLM + web search)
4  Shortlist         登顶广度        three tiered leaderboards
5  Conviction        管理层语气       LLM reads earnings-call transcripts, four-layer tone
      └─→ Composite Rank 综合排行     Tier-1/2 past Conviction 6, ranked by conviction
```

## Principles

- **AI is a cited extractor, not an oracle.** Every catalyst carries a
  `source_url`; every conviction layer carries a **verbatim quote**. All scores
  are computed **deterministically in Python** — the model only finds facts and
  grades layers.
- **Scores must discriminate.** Anti-saturation is the through-line: multiplicative
  catalyst scoring, a peak-curve for timing, a hedging-language discount for tone.
- **Rank, don't prematurely cut.** Each stage ranks by strength; the fine cut is
  left to the deepest signals (catalyst + management conviction).
- **Local, reproducible, cheap.** No cloud bill, no black box; every score traces
  back to its source.

## Stack

- **Frontend** — React 19 · Vite · Tailwind 4 · Zustand · TypeScript (`newsagg/dashboard/`)
- **Backend** — Python 3.14 `newsagg` package: SeekingAlpha scrape · yfinance
  (prices / caps / sectors) · Ape Wisdom (social heat) · OpenAI gateway
  (gpt-5.5 + web search) for supply-chain, catalyst, and conviction.

## Run

```bash
# data pipeline (from the repo root)
python -m newsagg.sa_scrape        # seed universe
python -m newsagg.technical        # prices / attention
python -m newsagg.catalyst  --limit 0 --workers 6
python -m newsagg.conviction --limit 0 --workers 6

# dashboard
cd newsagg/dashboard && npm run build
python -m http.server 8000         # then open http://localhost:8000/newsagg/web/dashboard/
```

Daily automation (macOS): `bash newsagg/deploy/install_mac.sh`.
See [`newsagg/README.md`](newsagg/README.md) for details.

---

> _An earlier prototype (a basketball prediction-market engine) also lives in this
> repository under `src/`, `frontend/`, and `config/`. MIDEA is the active project._
