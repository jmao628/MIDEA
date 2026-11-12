#!/bin/bash
#
# Refresh the SeekingAlpha login when the session expires.
#
# First export your cookies in your normal browser:
#   Cookie-Editor -> Export -> Export as JSON   (downloads a file)
# Then run this: it grabs the newest SeekingAlpha cookie export from your
# Downloads folder, installs it, and kicks off a scrape.
#
#   bash newsagg/deploy/refresh_cookies.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="$REPO_DIR/data/newsagg/sa_cookies.json"

# Newest Cookie-Editor / EditThisCookie export for seekingalpha in ~/Downloads.
SRC="$(ls -t "$HOME"/Downloads/*seekingalpha*json*.json 2>/dev/null | head -1 || true)"

if [[ -z "${SRC:-}" ]]; then
  echo "ERROR: no SeekingAlpha cookie export found in ~/Downloads."
  echo "Export it first: Cookie-Editor -> Export -> Export as JSON, then re-run."
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
echo "✓ Installed cookies from: $SRC"
echo "  -> $DEST"

# Sanity check: must look like a JSON array of cookie objects.
if ! head -c 40 "$DEST" | grep -q '\[\s*{'; then
  echo "WARNING: that file doesn't look like a cookie JSON export — double-check the export step."
fi

# Trigger a scrape now if the launchd job is installed; else run directly.
if launchctl list 2>/dev/null | grep -q com.newsagg.scrape; then
  launchctl start com.newsagg.scrape
  echo "✓ Started a scrape (com.newsagg.scrape). Refresh the page in a minute."
else
  echo "Running a scrape now…"
  cd "$REPO_DIR"
  "$REPO_DIR/.venv/bin/python" -m newsagg.sa_scrape
fi
