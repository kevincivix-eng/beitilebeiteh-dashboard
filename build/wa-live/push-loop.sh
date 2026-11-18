#!/data/data/com.termux/files/usr/bin/bash
# Publish on a schedule, separately from collecting.
#
# Capture has to be instant — a listing is deleted minutes after the item goes.
# Publishing does not: the dashboard is read by people, not by the minute. So
# the collector runs continuously and this pushes once an hour, which keeps the
# repo history readable and the build queue short.
#
# A failed push is not an error worth stopping for: the phone may be off wifi,
# or someone may have pushed to main in between. The bundle stays on disk and
# the next hour carries it, so nothing is ever lost by a push that did not land.
cd "$(dirname "$0")" || exit 1
export WA_DATA_DIR="${WA_DATA_DIR:-$HOME/wa-data}"
INTERVAL="${WA_PUSH_INTERVAL:-3600}"

while true; do
  ./push.sh >/dev/null 2>&1 || true
  sleep "$INTERVAL"
done
