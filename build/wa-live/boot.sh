#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot entry point — install me as ~/.termux/boot/start-collector.sh
#
# Starts both halves on every boot, and after Android has killed Termux:
#   sshd    so the collector can be reached and repaired remotely
#   run.sh  the supervisor that keeps node alive
#
# Both are started unconditionally but guarded, so running this twice is safe.
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
export WA_DATA_DIR="${WA_DATA_DIR:-$HOME/wa-data}"
mkdir -p "$WA_DATA_DIR"
echo "$(date '+%F %T') boot script ran" >> "$WA_DATA_DIR/boot.log"

# A wake lock is what stops Android suspending the process between messages.
(command -v termux-wake-lock >/dev/null && timeout 5 termux-wake-lock) 2>/dev/null || true

pgrep -x sshd >/dev/null || sshd

# `pgrep -x node` matches the process name only — matching the command line
# would also match this script, and killing or counting ourselves is how the
# first restart attempt silently did nothing.
pgrep -x node >/dev/null || (cd "$HOME/wa-live" && setsid nohup ./run.sh >/dev/null 2>&1 < /dev/null &)

# The hourly publisher. Matched on the script path because it is a bash loop,
# not a node process, so `pgrep -x` would match every other shell on the phone.
pgrep -f "wa-live/push-loop.sh" >/dev/null \
  || (cd "$HOME/wa-live" && setsid nohup ./push-loop.sh >/dev/null 2>&1 < /dev/null &)

# Ask ANDROID to re-run this script every 15 minutes.
#
# Everything above only helps while something of ours is still alive. When
# Android kills Termux outright there is no supervisor left to notice — which
# is exactly what happened the first night: the collector went quiet at 15:06
# and nothing restarted it, because the only thing that would have was itself.
# A JobScheduler job is held by the system, not by us, so it survives the kill
# and brings everything back. Needs the Termux:API app; without it the command
# is missing and this is a no-op, so the loops above stay the fallback.
if command -v termux-job-scheduler >/dev/null; then
  timeout 10 termux-job-scheduler \
    --script "$HOME/.termux/boot/start-collector.sh" \
    --job-id 7118 --period-ms 900000 --persisted true \
    --network any >/dev/null 2>&1 || true
fi
