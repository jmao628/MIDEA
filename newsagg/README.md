# newsagg — Financial News Aggregation

Turns a watchlist of tickers into a **daily bullish-seed table** by collecting
opinions from SeekingAlpha, Substack, and Schwab's YouTube channel, plus social
heat from Ape Wisdom, then normalizing each piece with an LLM.

```
step 1  collectors   ─► raw_items.json + mentions.json   ← YOU ARE HERE
step 2  normalize    ─► LLM extracts {is_bull, ticker, reasoning, ...}
step 3  web display  ─► daily bullish seed table
```

## Step 1: the collection layer

| Source | How | Output |
|---|---|---|
| **SeekingAlpha** | per-ticker RSS `/api/sa/combined/{TICKER}.xml` for title/author/date; login cookie to scrape paywalled full text | `RawItem` (full body) |
| **Substack** | per-publication RSS `{pub}.substack.com/feed` (full text by default) | `RawItem` (full body) |
| **Schwab** | YouTube Data API for new video titles/descriptions; `yt-dlp` for transcripts | `RawItem` |
| **X (via Ape Wisdom)** | free JSON API for per-ticker daily mention counts | `MentionEntry` (heat only) |

Ape Wisdom output is **heat/popularity raw material** — it never becomes a seed
on its own; it gets joined onto seeds in step 2.

### Setup

```bash
pip install -r newsagg/requirements.txt

cp newsagg/config.example.yaml newsagg/config.yaml   # fill in your lists
cp newsagg/.env.example .env                         # fill in secrets
```

Edit `newsagg/config.yaml`:
- `seekingalpha.tickers` — tickers whose SA feed to subscribe to
- `substack.publications` — publication subdomains
- `schwab_youtube.channel_id` (or `channel_handle`)
- `watchlist` — union universe used to filter Ape Wisdom

Edit `.env`:
- `SA_COOKIE` — SeekingAlpha login cookie (for paywalled full text)
- `YOUTUBE_API_KEY` — YouTube Data API v3 key

### Run

```bash
python -m newsagg.cli            # collect everything, dump JSON to data/newsagg/
python -m newsagg.cli --no-write # summary only
python -m newsagg.cli -v         # debug logging
```

Output lands in `data/newsagg/`:
- `raw_items_YYYY-MM-DD.json` — the documents (feeds the step-2 LLM)
- `mentions_YYYY-MM-DD.json` — per-ticker social mention counts

## SeekingAlpha tracker + live web page

A separate track from the RSS pipeline: scrape the **Top Performing Analysts**
page for their **Buy / Strong Buy** calls, plus the homepage **Tech &
Communication** ticker widgets (Latest Quant Ratings + Latest Analyst
Coverage), and show it all on an auto-refreshing web page.

These SA pages are JS-rendered and personalized behind the paywall, so we drive
a real headless browser (Playwright) with your login cookie.

### One-time setup

```bash
pip install -r newsagg/requirements.txt
python -m playwright install chromium        # downloads the browser (~150MB)
```

### Connect your paid account (via cookie export — most reliable)

SA blocks automated *login*, so instead log in with your **normal browser** and
hand the scraper your session cookies:

1. In your everyday Chrome, make sure you're logged into SeekingAlpha.
2. Install the **Cookie-Editor** extension (Chrome Web Store).
3. On any seekingalpha.com page, click Cookie-Editor → **Export** → **Export as
   JSON** (this copies all SA cookies to your clipboard).
4. Save them to `data/newsagg/sa_cookies.json` in this project.
5. Run the scraper — it imports that file automatically.

The file stays on your machine only (gitignored, never transmitted), and it
includes the HttpOnly auth cookies a manual copy would miss.

_Alternative:_ `python -m newsagg.sa_login` opens a real-Chrome window to log in
manually and persists the session in `data/newsagg/sa_profile/`. Works when SA
doesn't challenge the automated login; the cookie-export path above is the
fallback when it does.

### Scrape

```bash
python -m newsagg.sa_scrape             # one scrape -> data/newsagg/seekingalpha_latest.json
python -m newsagg.sa_scrape --watch 15  # keep re-scraping every 15 min (for the live page)
python -m newsagg.sa_scrape --recon     # capture debug artifacts only (first run / fixing selectors)
python -m newsagg.sa_scrape --headed    # watch the browser work (debugging)
```

Every run also writes recon artifacts to `data/newsagg/sa_debug/` — screenshots,
rendered HTML, and every SA `/api/` JSON response. SA changes its markup often;
if a section comes back empty, those artifacts are how we lock in exact
extraction.

### View the live page

Serve the repo root and open the page — it reads
`seekingalpha_latest.json` and auto-refreshes every 60s:

```bash
python -m http.server 8000        # run from the BBet repo root
```

Then open <http://localhost:8000/newsagg/web/>. For a truly live board, run the
scraper in `--watch` mode in one terminal and the web server in another.

## Dashboard (React + TS + Tailwind)

A single-page, full-screen trading-terminal dashboard lives in
`newsagg/dashboard/`. Three columns (25% / 45% / 30%), dark theme, a slim
header with a live clock + global ticker input, and panels:

| Column | Panel | Data |
|---|---|---|
| Left | SeekingAlpha Feed | live (scraped widgets) |
| Middle top | Schwab Live Stream | placeholder (source not wired) |
| Middle bottom | Live Caption & Signal | placeholder |
| Right top | X (Twitter) Ticker | driven by the header ticker input |
| Right bottom | Stock Ranking | live (all tickers, sortable) |

State is a Zustand store; the data layer polls `seekingalpha_latest.json` every
15s (swap to WebSocket/SSE once a streaming source exists). Build it into the
folder the local `http.server` already serves:

```bash
cd newsagg/dashboard
npm install          # first time (use a mirror if slow: npm config set registry https://registry.npmmirror.com)
npm run build        # outputs to ../web/dashboard/
```

Then open <http://localhost:8000/newsagg/web/dashboard/> (the launchd web job
already serves the repo root). Rebuild after pulling dashboard changes. For
live-editing the UI: `npm run dev` (Vite on :5173, proxies data from :8000).

### Schwab live stream embed

The middle-top panel embeds the Schwab Network YouTube live stream. Point it at
the channel by creating `data/newsagg/dashboard.json` (local, no rebuild needed):

```json
{ "schwabChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx" }
```

Get the channel id: open the Schwab Network YouTube channel → any video → the
channel link → the `UC…` id is in that URL (or use a "find YouTube channel id"
site with `@SchwabNetwork`). Refresh the dashboard and the live stream appears.

## Run it daily on your Mac (local automation)

Instead of running commands by hand, install two launchd jobs — a daily scrape
and an always-on local web server:

```bash
bash newsagg/deploy/install_mac.sh          # daily scrape at 09:00 local
bash newsagg/deploy/install_mac.sh 7        # ...or pick the hour (07:00)
```

This installs:
- **com.newsagg.scrape** — runs `sa_scrape` once a day (catches up on wake if
  the Mac was asleep at the scheduled time).
- **com.newsagg.web** — keeps the page live at <http://localhost:8000/newsagg/web/>
  whenever you're logged in.

Populate it immediately without waiting for the schedule:

```bash
launchctl start com.newsagg.scrape
```

Logs land in `data/newsagg/logs/`. Remove everything with
`bash newsagg/deploy/uninstall_mac.sh`.

**Cookie refresh:** your SeekingAlpha session (`sa_cookies.json`) expires after
a few weeks. When the page stops updating, re-export cookies (see above) and the
next daily run picks them up. Everything runs on your machine, so the page is
only reachable while your Mac is on and logged in.

## Heat Signal (Stage 2)

Turns each ticker's daily mention series into z-score / velocity / phase. Ape
Wisdom only exposes today's snapshot, so we **accumulate it daily** into
`data/newsagg/mentions_history.json` and compute z off the growing series — heat
gets meaningful after ~1–2 weeks of accumulation (before that, tickers read
"warming").

```bash
python -m newsagg.heat            # fetch Ape Wisdom, append today, recompute
python -m newsagg.heat --no-fetch # recompute from stored history only
```

Writes `data/newsagg/heat_latest.json` (per-ticker `{z, vel, accel, phase,
series, z_series}`), which the dashboard's Heat view reads (table + dual chart:
mention bars over a z curve with the 0.5 ignite / 2.0 detonate lines). Phases:
`dead` (z<0.5) · `watch` (in band, no momentum) · `ignite` (z∈[0.5,2.0) &
vel≥0.15 & accel≥0) · `detonate` (z≥2.0) · `ultralow` (median mentions <5). The
`install_mac.sh` automation runs this daily alongside the SA scrape.

### Notes on robustness

- Each collector is isolated: one failing source doesn't sink the run (errors
  are collected and surfaced in the summary).
- No secrets? Collectors degrade gracefully — SA returns RSS summaries only
  without a cookie; YouTube is skipped without an API key.
- HTTP has exponential-backoff retry (2s/4s/8s/16s) on 429/5xx.
- De-dup here is only syntactic (same URL). Semantic de-dup (same ticker +
  catalyst + nearby date) is a step-2 concern, after the LLM extracts fields.
