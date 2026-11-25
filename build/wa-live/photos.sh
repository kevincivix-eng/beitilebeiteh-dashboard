#!/data/data/com.termux/files/usr/bin/bash
# Mail the photos the parser asked for, and nothing else.
#
# The bundle that goes to the public repo carries a hash per photo and never
# the photo. That is the right default — those are pictures of people's homes —
# but it leaves the items in a photo-only listing uncounted, because the
# identification pass needs to see the picture.
#
# So this moves exactly the photos the build asked for, into a separate PRIVATE
# repo. Two properties make that safe to run unattended:
#
#   - The build publishes the list (data/whatsapp/vision-wanted.json). The
#     phone never decides what is interesting; it answers a request. Once a
#     photo has been identified it leaves the list and is deleted here, so the
#     mailbox holds only what is still open — a few dozen files.
#   - Every name off the network is checked against ^[0-9a-f]{64}\.(jpg|…)$
#     before it reaches the filesystem. The list comes from our own site, but a
#     name from the network that is pasted into a path is how "../../" gets in,
#     and a hash is trivial to validate.
#
# Unconfigured, it exits quietly. The collector is the single point of failure
# in this whole setup, so a feature that is not set up yet must not be able to
# break the thing that works.
#
# Install as ~/wa-live/photos.sh. Configure in ~/wa-live/photos.env:
#     WA_PHOTOS_REPO=git@github.com:<user>/<private-repo>.git
set -u

export PATH="/data/data/com.termux/files/usr/bin:$PATH"

WA_DATA_DIR="${WA_DATA_DIR:-$HOME/wa-data}"
LOG="$WA_DATA_DIR/photos.log"
ENV_FILE="${WA_PHOTOS_ENV:-$HOME/wa-live/photos.env}"
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

REPO="${WA_PHOTOS_REPO:-}"
MEDIA="${WA_MEDIA_DIR:-$WA_DATA_DIR/media}"
CLONE="${WA_PHOTOS_CLONE:-$HOME/wa-photos}"
KEY="${WA_PHOTOS_KEY:-$HOME/.ssh/id_ed25519_wa_photos}"
BRANCH="${WA_PHOTOS_BRANCH:-main}"
WANTED_URL="${WA_WANTED_URL:-https://kevincivix-eng.github.io/beitilebeiteh-dashboard/data/whatsapp/vision-wanted.json}"
MAX_FILES="${WA_PHOTOS_MAX:-400}"

say() { echo "$(date '+%F %T') $*" >> "$LOG"; }

[ -n "$REPO" ] || exit 0
[ -d "$MEDIA" ] || { say "✗ no media store at $MEDIA"; exit 1; }
[ -f "$KEY" ] || { say "✗ no ssh key at $KEY"; exit 1; }

mkdir -p "$WA_DATA_DIR"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

WANTED="$WA_DATA_DIR/vision-wanted.json"
# curl is not guaranteed on a Termux install, and node certainly is — it is
# what runs the collector. Either one, whichever the phone actually has.
fetch_wanted() {
  if command -v curl >/dev/null; then
    curl -fsS --max-time 60 "$WANTED_URL" -o "$WANTED.tmp" 2>>"$LOG"
  else
    node -e '
      const fs = require("fs");
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 60000);
      fetch(process.argv[1], { signal: ac.signal })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
        .then((b) => { fs.writeFileSync(process.argv[2], b); clearTimeout(t); })
        .catch((e) => { console.error(e.message); process.exit(1); });
    ' "$WANTED_URL" "$WANTED.tmp" 2>>"$LOG"
  fi
}
fetch_wanted || { say "— could not fetch the wanted list (offline? not deployed yet?)"; exit 0; }
mv -f "$WANTED.tmp" "$WANTED"

# Validate here, in one place, so nothing downstream handles an unchecked name.
NAMES="$WA_DATA_DIR/vision-wanted.names"
node -e '
const fs = require("fs");
const ok = /^[0-9a-f]{64}\.(jpg|jpeg|png|webp)$/;
let list = [];
try { list = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).files || []; } catch { process.exit(3); }
const good = [...new Set(list.filter((f) => typeof f === "string" && ok.test(f)))];
fs.writeFileSync(process.argv[2], good.join("\n") + (good.length ? "\n" : ""));
console.error(`${good.length} wanted, ${list.length - good.length} rejected`);
' "$WANTED" "$NAMES" 2>>"$LOG" || { say "✗ wanted list unreadable"; exit 1; }

COUNT=$(wc -l < "$NAMES" | tr -d ' ')
if [ "$COUNT" -gt "$MAX_FILES" ]; then
  say "✗ list asks for $COUNT photos (cap $MAX_FILES) — refusing, something is wrong upstream"
  exit 1
fi

if [ ! -d "$CLONE/.git" ]; then
  say "— first run: cloning the photo mailbox"
  rm -rf "$CLONE"
  git clone --quiet "$REPO" "$CLONE" 2>>"$LOG" || { say "✗ clone failed (deploy key not added to the private repo?)"; exit 1; }
  git -C "$CLONE" config user.name  "wa-collector"
  git -C "$CLONE" config user.email "collector@beitilebeiteh.local"
  git -C "$CLONE" checkout -q -B "$BRANCH"
fi

cd "$CLONE" || exit 1
git fetch --quiet origin "$BRANCH" 2>>"$LOG" && git reset --hard --quiet "origin/$BRANCH"
mkdir -p photos

# Add what is wanted and missing.
ADDED=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "photos/$f" ] && continue
  [ -f "$MEDIA/$f" ] || continue
  cp -f "$MEDIA/$f" "photos/$f" && ADDED=$((ADDED + 1))
done < "$NAMES"

# Drop what is no longer wanted: identified, or no longer read as a listing.
#
# The membership test is pure bash on purpose. It was `grep -qxF … || rm`, and
# in a shell whose PATH had no grep that reads as "no match" for every file and
# deletes the entire mailbox — a missing tool must never be the same answer as
# "not wanted". A `case` against the newline-delimited list cannot fail that way.
WANTSET=$'\n'"$(cat "$NAMES")"$'\n'
REMOVED=0
for p in photos/*; do
  [ -f "$p" ] || continue
  b=${p##*/}
  case "$WANTSET" in
    *$'\n'"$b"$'\n'*) ;;
    *) rm -f "$p" && REMOVED=$((REMOVED + 1)) ;;
  esac
done

MISSING=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "photos/$f" ] || MISSING=$((MISSING + 1))
done < "$NAMES"

git add -A photos
if git diff --cached --quiet; then
  if [ "$MISSING" -gt 0 ]; then
    # Wanted, not in the mailbox, and not in the store either: the photo was
    # captured before this phone's media store existed, or the download failed
    # at capture time. Nothing here can fix that, and it must not look like
    # success.
    say "⚠ $MISSING of $COUNT wanted photo(s) are not in the store — cannot be identified"
  else
    say "nothing to mail ($COUNT wanted, all already sent)"
  fi
  exit 0
fi
git commit --quiet -m "Photos for identification: +$ADDED -$REMOVED ($COUNT open)" || exit 1
if git push --quiet origin "$BRANCH" 2>>"$LOG"; then
  say "✓ mailed +$ADDED -$REMOVED ($COUNT wanted${MISSING:+, $MISSING not in the store})"
else
  say "✗ push rejected — will retry next run"
  exit 1
fi
