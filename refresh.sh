#!/usr/bin/env bash
# One-shot daily refresh for MIDEA on the Mac:
#   pull the latest code → rebuild the dashboard → fetch the latest prices
#   (fwd4w scores, volumes, QQQ benchmark, ledger snapshot) → no-LLM catalysts
#   → restart the local server. Every step that can fail is allowed to fail
#   without stopping the rest, so one flaky feed never leaves the site down.
#
#   ./refresh.sh            full refresh
#   ./refresh.sh --no-pull  skip git pull / rebuild (data only)
#   ./refresh.sh --calibrate  also re-run the calibration at the end (slow)
#
# Best run after the US close (16:00 ET) for settled daily bars; during the
# session it captures live intraday prices, which keep moving until the close.

set -u
cd "$(dirname "$0")"

PULL=1
CALIBRATE=0
for a in "$@"; do
  case "$a" in
    --no-pull) PULL=0 ;;
    --calibrate) CALIBRATE=1 ;;
  esac
done

# A dead proxy (leftover VPN config) silently breaks git AND yfinance.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

BRANCH="claude/financial-news-aggregation-etpcn3"
PORT=8000
LOG=/tmp/midea-serve.log
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

if [ "$PULL" = 1 ]; then
  step "1/6 pull latest code"
  git pull --ff-only origin "$BRANCH" || warn "git pull failed — continuing with the code already here"

  step "2/6 rebuild dashboard"
  ( cd newsagg/dashboard \
    && { [ -d node_modules ] || npm install --silent; } \
    && npm run build 2>&1 | grep -E "error TS|✓ built" ) || warn "dashboard build failed — serving the previous build"
else
  step "1-2/6 skipped (--no-pull)"
fi

step "3/6 market caps (cached, fast)"
python -m newsagg.marketcap || warn "marketcap failed — keeping the previous caps"

step "4/6 prices · technicals · 4-week scores · benchmark · ledger  (a few minutes)"
python -m newsagg.technical || warn "technical failed — keeping the previous snapshot (merge-protected)"

step "5/6 no-LLM catalysts (earnings dates → the +15 narrative bonus)"
python -m newsagg.catalyst_data || warn "catalyst_data failed — catalyst bonus stays as it was"

if [ "$CALIBRATE" = 1 ]; then
  step "5b calibration (slow)"
  python -m newsagg.calibrate || warn "calibrate failed"
fi

step "6/6 restart server on :$PORT"
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
nohup python newsagg/deploy/serve.py "$PORT" > "$LOG" 2>&1 &
sleep 1
if curl -sI "http://localhost:$PORT" | head -1 | grep -q 200; then
  echo "server up → http://localhost:$PORT/newsagg/web/dashboard/"
else
  warn "server did not answer — see $LOG"
fi

step "summary"
python3 - <<'PY'
import json, os, datetime
d = "data/newsagg/"
def load(f):
    p = d + f
    return json.load(open(p)) if os.path.exists(p) else None
t = load("technical_latest.json") or {}
tk = t.get("tickers", {})
n_fwd = sum(1 for v in tk.values() if v.get("fwd4w"))
ga = t.get("generated_at", "?")
h = load("price_history.json") or {}
n_vol = sum(1 for v in h.get("tickers", {}).values() if v.get("volumes"))
led = load("ledger.json") or {}
g = led.get("graded", {})
prime = g.get("by_tier", {}).get("prime", {}).get("20", {})
cat = load("catalyst_data.json") or {}
print(f"technicals : {len(tk)} tickers · fwd4w on {n_fwd} · generated {ga[:16]}")
print(f"history    : volumes stored for {n_vol} tickers · benchmark {'yes' if os.path.exists(d+'benchmark_history.json') else 'no'}")
print(f"ledger     : {led.get('n_dates', 0)} days logged ({led.get('first_date','—')} → {led.get('asof','—')}) · {g.get('n_graded_dates', 0)} graded"
      + (f" · prime 4w hit {100*prime['hit']:.0f}% n={prime['n']}" if prime.get("n") else ""))
print(f"catalysts  : {sum(1 for v in cat.values() if isinstance(v, dict) and v.get('catalysts'))} tickers with a no-LLM catalyst")
print("→ hard-refresh the browser (Cmd+Shift+R)")
PY
