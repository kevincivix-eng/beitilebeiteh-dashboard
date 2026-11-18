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
