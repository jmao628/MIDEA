#!/bin/bash
#
# One-time setup for local daily automation on macOS.
#
# Installs launchd jobs for the current user:
#   com.newsagg.scrape     — SeekingAlpha scrape once a day        (:00)
#   com.newsagg.marketcap  — yfinance market caps                 (:10)
#   com.newsagg.technical  — yfinance price-volume + technicals    (:15)
#   com.newsagg.sectors    — yfinance sector classification (cached)(:17)
#   com.newsagg.heat       — Ape Wisdom social heat accumulation   (:20)
#   com.newsagg.supplychain— OpenAI upstream/downstream/peers (cached)(:25)
#   com.newsagg.catalyst   — LLM catalyst discovery + stale re-fetch  (:30)
#   com.newsagg.conviction — LLM management-tone read of shortlist    (:35)
#   com.newsagg.web        — local web server on http://localhost:8000
#
# Re-run this any time to update the schedule. Uninstall with uninstall_mac.sh.
#
# Usage:
#   bash newsagg/deploy/install_mac.sh            # daily at 09:00 local
#   bash newsagg/deploy/install_mac.sh 7          # daily at 07:00 local
#   bash newsagg/deploy/install_mac.sh 17         # daily at 17:00 (5 PM) local
#   PORT=8080 bash newsagg/deploy/install_mac.sh  # serve on a different port
#
# NOTE: launchd schedules in LOCAL wall-clock time. Hour 17 fires at 5 PM in the
# Mac's timezone — that IS 5 PM Eastern only if the Mac is set to Eastern time
# (it auto-tracks EST/EDT). The install output prints the current timezone so
# you can confirm; if the Mac is elsewhere, pass the local hour equal to 5 PM ET.

set -euo pipefail

HOUR="${1:-9}"
PORT="${PORT:-8000}"
# Optional: proxy for the yfinance jobs (market cap + technical) when Yahoo is
# only reachable through a VPN/proxy. e.g. PROXY=http://127.0.0.1:3213 bash ...
PROXY="${PROXY:-}"

PROXY_LINES=""
if [[ -n "$PROXY" ]]; then
  PROXY_LINES="    <key>HTTPS_PROXY</key><string>$PROXY</string>
    <key>HTTP_PROXY</key><string>$PROXY</string>"
fi

# The supply-chain and catalyst jobs both call OpenAI, and launchd jobs do NOT
# inherit your shell env — so we bake the OPENAI_API_KEY that's set *right now*
# (at install time) into those plists. They live in ~/Library/LaunchAgents (not
# the repo), so the key never touches version control. Re-run install after
# `export`ing it.
OPENAI_LINES=""
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_LINES="    <key>OPENAI_API_KEY</key><string>$OPENAI_API_KEY</string>"
fi
# CRITICAL for a custom gateway: launchd jobs don't inherit your shell, so the
# base URL must be baked in too — otherwise the SDK hits api.openai.com and your
# gateway key 401s. Bake OPENAI_BASE_URL (and OPENAI_MODEL) if set at install.
if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
  OPENAI_LINES="$OPENAI_LINES
    <key>OPENAI_BASE_URL</key><string>$OPENAI_BASE_URL</string>"
fi
if [[ -n "${OPENAI_MODEL:-}" ]]; then
  OPENAI_LINES="$OPENAI_LINES
    <key>OPENAI_MODEL</key><string>$OPENAI_MODEL</string>"
fi
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "WARNING: OPENAI_API_KEY not set — the catalyst/supplychain/conviction jobs will be skipped. export it, then re-run."
elif [[ -z "${OPENAI_BASE_URL:-}" ]]; then
  echo "WARNING: OPENAI_BASE_URL not set — if you use a custom OpenAI gateway, export it before installing or the jobs will 401 against api.openai.com."
fi

# Daily catalyst budget: CAT_LIMIT = 0 means NO cap — re-analyse every new focus
# name and every stale one (older than CAT_MAX_AGE days, or with a catalyst that
# fired) the same day. Set CAT_LIMIT to a number to cap OpenAI spend/time.
CAT_LIMIT="${CAT_LIMIT:-0}"
CAT_MAX_AGE="${CAT_MAX_AGE:-4}"
CAT_WORKERS="${CAT_WORKERS:-6}" # parallelism — higher finishes the no-cap run faster

# Daily conviction budget: same no-cap default. Management calls are quarterly,
# so CONV_MAX_AGE re-reads a name whose last read is older than N days (a new
# call has likely landed). Only the shortlist survivors get read (see the module).
CONV_LIMIT="${CONV_LIMIT:-0}"
CONV_MAX_AGE="${CONV_MAX_AGE:-25}"
CONV_WORKERS="${CONV_WORKERS:-6}"

# Price freshness: by default the technical (price/volume) job runs ONCE a day.
# The Strong-Buy leaderboard ranks by "today's move", so a once-a-day pull shows
# a "stale" badge for most of the session. Set TECH_EVERY_MIN (e.g. 60) to re-pull
# prices every N minutes instead — the leaderboard then stays fresh on its own.
# yfinance needs Yahoo reachable, so keep the VPN/proxy up (pass PROXY=...).
TECH_EVERY_MIN="${TECH_EVERY_MIN:-}"
if [[ -n "$TECH_EVERY_MIN" ]]; then
  TECH_SCHED="  <key>StartInterval</key><integer>$(( TECH_EVERY_MIN * 60 ))</integer>"
  echo "Technical prices: every ${TECH_EVERY_MIN} min (intraday) — keep the VPN/proxy up."
else
  TECH_SCHED="  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>15</integer>
  </dict>"
fi

# Repo root = two levels up from this script (newsagg/deploy/ -> repo).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PY="$REPO_DIR/.venv/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "ERROR: virtualenv python not found at $PY"
  echo "Create it first:  cd \"$REPO_DIR\" && python3 -m venv .venv && source .venv/bin/activate && pip install -r newsagg/requirements.txt"
  exit 1
fi

LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$REPO_DIR/data/newsagg/logs"
mkdir -p "$LA_DIR" "$LOG_DIR"

SCRAPE_PLIST="$LA_DIR/com.newsagg.scrape.plist"
HEAT_PLIST="$LA_DIR/com.newsagg.heat.plist"
MCAP_PLIST="$LA_DIR/com.newsagg.marketcap.plist"
TECH_PLIST="$LA_DIR/com.newsagg.technical.plist"
SECTOR_PLIST="$LA_DIR/com.newsagg.sectors.plist"
SUPPLY_PLIST="$LA_DIR/com.newsagg.supplychain.plist"
CATALYST_PLIST="$LA_DIR/com.newsagg.catalyst.plist"
CONVICTION_PLIST="$LA_DIR/com.newsagg.conviction.plist"
TRACK_PLIST="$LA_DIR/com.newsagg.track.plist"
WEB_PLIST="$LA_DIR/com.newsagg.web.plist"

echo "Repo:   $REPO_DIR"
echo "Python: $PY"
echo "Timezone: $(date '+%Z (UTC%z)') — the schedule below is in THIS local time."
if [[ "$HOUR" == "17" ]]; then
  case "$(date +%Z)" in
    EST|EDT) echo "         ✓ Mac is on Eastern time, so 17:00 = 5 PM ET." ;;
    *) echo "         ⚠ Mac is NOT on Eastern time — 17:00 here is NOT 5 PM ET. Pass the local hour that equals 5 PM ET instead." ;;
  esac
fi
echo "Daily full re-run ${HOUR}:00–${HOUR}:40 local (scrape→…→track); web server on http://localhost:${PORT}"

cat > "$SCRAPE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.scrape</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.sa_scrape</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/scrape.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/scrape.log</string>
</dict>
</plist>
EOF

cat > "$HEAT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.heat</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.heat</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>20</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/heat.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/heat.log</string>
</dict>
</plist>
EOF

cat > "$MCAP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.marketcap</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.marketcap</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PROXY_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>10</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/marketcap.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/marketcap.log</string>
</dict>
</plist>
EOF

cat > "$TECH_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.technical</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.technical</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PROXY_LINES
  </dict>
$TECH_SCHED
  <key>StandardOutPath</key><string>$LOG_DIR/technical.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/technical.log</string>
</dict>
</plist>
EOF

cat > "$SECTOR_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.sectors</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.sectors</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PROXY_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>17</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/sectors.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/sectors.log</string>
</dict>
</plist>
EOF

cat > "$SUPPLY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.supplychain</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.supplychain</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$OPENAI_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>25</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/supplychain.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/supplychain.log</string>
</dict>
</plist>
EOF

cat > "$CATALYST_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.catalyst</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.catalyst</string>
    <string>--limit</string>
    <string>$CAT_LIMIT</string>
    <string>--max-age</string>
    <string>$CAT_MAX_AGE</string>
    <string>--workers</string>
    <string>$CAT_WORKERS</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$OPENAI_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/catalyst.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/catalyst.log</string>
</dict>
</plist>
EOF

cat > "$CONVICTION_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.conviction</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.conviction</string>
    <string>--limit</string>
    <string>$CONV_LIMIT</string>
    <string>--max-age</string>
    <string>$CONV_MAX_AGE</string>
    <string>--workers</string>
    <string>$CONV_WORKERS</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$OPENAI_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>35</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/conviction.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/conviction.log</string>
</dict>
</plist>
EOF

cat > "$TRACK_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.track</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>newsagg.track</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PROXY_LINES
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>40</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/track.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/track.log</string>
</dict>
</plist>
EOF

cat > "$WEB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.newsagg.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$REPO_DIR/newsagg/deploy/serve.py</string>
    <string>$PORT</string>
    <string>$REPO_DIR</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$PROXY_LINES
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/web.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/web.log</string>
</dict>
</plist>
EOF

# Clear any stale process squatting on the web port (e.g. a manual `serve.py`
# left running, or an old launchd process that didn't exit) so the reloaded web
# job actually owns the port and serves from the correct repo root. This is what
# prevents the recurring "dashboard 404 from a zombie server" problem.
PORT_PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [[ -n "$PORT_PIDS" ]]; then
  echo "Clearing stale process on port $PORT: $PORT_PIDS"
  kill -9 $PORT_PIDS 2>/dev/null || true
fi

# Reload jobs (unload first if already installed; ignore errors).
for plist in "$SCRAPE_PLIST" "$HEAT_PLIST" "$MCAP_PLIST" "$TECH_PLIST" "$SECTOR_PLIST" "$SUPPLY_PLIST" "$CATALYST_PLIST" "$CONVICTION_PLIST" "$TRACK_PLIST" "$WEB_PLIST"; do
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load -w "$plist"
done

echo
echo "✓ Installed. The web page is now always available at:"
echo "    http://localhost:${PORT}/newsagg/web/"
echo
echo "Run a scrape right now to populate it:"
echo "    launchctl start com.newsagg.scrape"
echo
echo "Logs:   $LOG_DIR/scrape.log   $LOG_DIR/web.log"
echo "Remove: bash newsagg/deploy/uninstall_mac.sh"
