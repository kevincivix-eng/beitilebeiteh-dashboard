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
WATCHDOG_ID=7118
mkdir -p "$WA_DATA_DIR"
echo "$(date '+%F %T') boot script ran" >> "$WA_DATA_DIR/boot.log"

# A wake lock is what stops Android suspending the process between messages.
(command -v termux-wake-lock >/dev/null && timeout 5 termux-wake-lock) 2>/dev/null || true

pgrep -x sshd >/dev/null || sshd

# Start both, every time, and let each one decide whether it is the one.
#
# There used to be a `pgrep` guard here and it was wrong twice over. It asked
# whether NODE was running, but run.sh needs seconds to launch node, so two boot
# runs inside that window each started a supervisor — two collectors on one
# WhatsApp account, which WhatsApp resolves by kicking one off. Rewriting the
# guard to look for the supervisor did not help either: these start as `./run.sh`,
# so a pattern with a directory in it never matched, and eight publishers piled
# up unnoticed. A process search is the wrong instrument — it answers about a
# moment, and two copies starting in the same second both get the same answer.
# Each script now takes a lock and a second copy exits by itself, so starting
# one that is already running costs a process that lives for a few milliseconds.
(cd "$HOME/wa-live" && setsid nohup ./run.sh >/dev/null 2>&1 < /dev/null &)
(cd "$HOME/wa-live" && setsid nohup ./push-loop.sh >/dev/null 2>&1 < /dev/null &)

# Ask ANDROID to re-run this script every 15 minutes.
#
# Everything above only helps while something of ours is still alive. When
# Android kills Termux outright there is no supervisor left to notice — which
# is exactly what happened the first night: the collector went quiet at 15:06
# and nothing restarted it, because the only thing that would have was itself.
# A JobScheduler job is held by the system, not by us, so it survives the kill
# and brings everything back. Needs the Termux:API app; without it the command
# is missing and this is a no-op, so the loops above stay the fallback.
#
# ONLY IF IT IS NOT ALREADY REGISTERED. Registering a job makes it fire right
# away, and the thing it fires is this script — which would register it again,
# and again. Re-registering unconditionally ran this script every 7 seconds
# instead of every 15 minutes, which is a battery fire, not a watchdog. The
# job survives reboots on its own (--persisted), so there is nothing to renew.
if command -v termux-job-scheduler >/dev/null; then
  if ! timeout 10 termux-job-scheduler -p 2>/dev/null | grep -q "Pending Job $WATCHDOG_ID:"; then
    timeout 10 termux-job-scheduler \
      --script "$HOME/.termux/boot/start-collector.sh" \
      --job-id "$WATCHDOG_ID" --period-ms 900000 --persisted true \
      --network any >/dev/null 2>&1 || true
  fi
fi
