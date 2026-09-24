#!/bin/bash
#
# Remove the local daily-automation launchd jobs installed by install_mac.sh.

set -uo pipefail

LA_DIR="$HOME/Library/LaunchAgents"

for label in com.newsagg.scrape com.newsagg.heat com.newsagg.marketcap com.newsagg.technical com.newsagg.sectors com.newsagg.supplychain com.newsagg.catalyst com.newsagg.conviction com.newsagg.track com.newsagg.web; do
  plist="$LA_DIR/$label.plist"
  if [[ -f "$plist" ]]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "removed $label"
  else
    echo "$label not installed"
  fi
done

echo "✓ Uninstalled. (Your data and code are untouched.)"
