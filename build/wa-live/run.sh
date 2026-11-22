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
# Exactly one of me, whoever starts me. boot.sh used to guard this by asking
# whether node was running, but run.sh needs a few seconds to get node up — so
# two boot.sh runs inside that window started two supervisors, two collectors,
# and WhatsApp then kicked one of them off the account (disconnect 440). A lock
# held on an open file settles it without a race: the second copy simply exits.
LOCK="$WA_DATA_DIR/run.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "$(date '+%F %T') another run already holds the lock — exiting" >> "$WA_DATA_DIR/run.log"; exit 0; }

# Keep the log from eating the phone. Baileys logs every message it handles,
# so run.log reached 100 MB in four days — on a device that is also storing the
# photos. One generation back is kept, which is as much history as anyone has
# ever needed here: a crash is diagnosed from the last few hundred lines.
MAX_LOG=$((20 * 1024 * 1024))
rotate() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size
  size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_LOG" ] && mv -f "$f" "$f.1"
  return 0
}

while true; do
  rotate "$WA_DATA_DIR/run.log"
  echo "$(date '+%F %T') starting collector" >> "$WA_DATA_DIR/run.log"
  node collector.js >> "$WA_DATA_DIR/run.log" 2>&1
  echo "$(date '+%F %T') collector exited ($?) — restarting in 10s" >> "$WA_DATA_DIR/run.log"
  sleep 10
done
