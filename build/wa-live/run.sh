#!/data/data/com.termux/files/usr/bin/bash
# Keep the collector running on the phone.
#
# Android will kill a background process eventually no matter how the battery
# settings are set, so the supervisor matters more than the app: if node exits
# for any reason, wait a few seconds and start it again. The wake lock stops
# the CPU sleeping between messages.
cd "$(dirname "$0")"
export WA_DATA_DIR="${WA_DATA_DIR:-$HOME/wa-data}"
# Needs the separate Termux:API app; without it the command exists but hangs,
# so never let it block the collector from starting.
(command -v termux-wake-lock >/dev/null && timeout 5 termux-wake-lock) 2>/dev/null || true
mkdir -p "$WA_DATA_DIR"
while true; do
  echo "$(date '+%F %T') starting collector" >> "$WA_DATA_DIR/run.log"
  node collector.js >> "$WA_DATA_DIR/run.log" 2>&1
  echo "$(date '+%F %T') collector exited ($?) — restarting in 10s" >> "$WA_DATA_DIR/run.log"
  sleep 10
done
