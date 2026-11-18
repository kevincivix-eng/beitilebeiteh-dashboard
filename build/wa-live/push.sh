#!/data/data/com.termux/files/usr/bin/bash
# Send the day's bundles to GitHub, which is what makes the dashboard update
# without anybody touching it.
#
# The phone is the only writer of data/whatsapp/live/, so the working clone can
# always be reset to origin before copying — no merge, no conflict, nothing to
# resolve on a device with no keyboard. The push itself triggers the deploy
# workflow, which re-parses the live days and rebuilds the site.
#
# What leaves the phone is the bundle: redacted text, a hash per photo, an
# opaque id per sender. The photos and the numbers never go anywhere.
#
# Install as ~/wa-live/push.sh and run it from cron or after each collection.
set -u

export PATH="/data/data/com.termux/files/usr/bin:$PATH"
WA_DATA_DIR="${WA_DATA_DIR:-$HOME/wa-data}"
CLONE="${WA_PUSH_CLONE:-$HOME/wa-push}"
REPO="${WA_PUSH_REPO:-git@github.com:kevincivix-eng/beitilebeiteh-dashboard.git}"
KEY="${WA_PUSH_KEY:-$HOME/.ssh/id_ed25519_wa_push}"
BRANCH="${WA_PUSH_BRANCH:-main}"
LOG="$WA_DATA_DIR/push.log"

say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

say "— exporting bundles"
cd "$HOME/wa-live" || { say "✗ no ~/wa-live"; exit 1; }
WA_DATA_DIR="$WA_DATA_DIR" node export-bundle.js >>"$LOG" 2>&1 || { say "✗ export failed"; exit 1; }

if [ ! -d "$CLONE/.git" ]; then
  say "— first run: cloning"
  rm -rf "$CLONE"
  git clone --quiet --filter=blob:none --no-checkout "$REPO" "$CLONE" || { say "✗ clone failed"; exit 1; }
  git -C "$CLONE" sparse-checkout set data/whatsapp/live || exit 1
  git -C "$CLONE" checkout "$BRANCH" --quiet || exit 1
  git -C "$CLONE" config user.name  "wa-collector"
  git -C "$CLONE" config user.email "collector@beitilebeiteh.local"
fi

cd "$CLONE" || exit 1
git fetch --quiet origin "$BRANCH" || { say "✗ fetch failed (network? key?)"; exit 1; }
# Safe because nothing but this script ever writes that directory.
git reset --hard --quiet "origin/$BRANCH" || exit 1

mkdir -p data/whatsapp/live
cp -f "$WA_DATA_DIR"/bundles/*.json data/whatsapp/live/ 2>/dev/null

# `git status`, not `git diff`: a day that has never been pushed is an
# UNTRACKED file, which git diff does not report at all — the first real push
# silently reported "nothing new".
git add data/whatsapp/live
DAYS=$(git diff --cached --name-only -- data/whatsapp/live | wc -l | tr -d ' ')
if [ "$DAYS" -eq 0 ]; then
  say "nothing new to push"
  exit 0
fi
git commit --quiet -m "Live feed: $DAYS day(s) through $(date '+%F %H:%M')" || exit 1
if git push --quiet origin "$BRANCH"; then
  say "✓ pushed $DAYS day file(s)"
else
  say "✗ push rejected — someone else moved main; will retry next run"
  exit 1
fi
