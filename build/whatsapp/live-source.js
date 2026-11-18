/**
 * Reads the live collector's daily bundles and hands the parser the same thing
 * a chat export does.
 *
 * The point is that nothing downstream has to know where a day came from. A
 * bundle day produces the identical `{ date, time, sec, sender, body, group,
 * files, mediaOmitted }` message shape as `parseChat`, so blocking, the four
 * dedupe signals, the weighing and the vision lookup all run unchanged — and a
 * listing cross-posted to six groups collapses to one whether those six copies
 * arrived live or came out of six exported files.
 *
 * Two differences are deliberate:
 *
 *  - A "filename" here is the photo's sha256 plus its extension. It is stable
 *    forever, which is what the export path never managed: re-exporting
 *    renumbered every file and silently invalidated the vision results keyed to
 *    the old names.
 *  - Phone numbers were already masked on the phone and never left it. What
 *    comes through instead is a salted hash per number, which the dedupe can
 *    still compare for equality. It will not match a number from an export —
 *    those two worlds only meet at the seam between the last export day and the
 *    first live day, and the text signal covers that.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE_DIR = process.env.WA_LIVE_BUNDLES || path.join(ROOT, 'data', 'whatsapp', 'live');

const EXT = { imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp', documentMessage: 'bin' };
const fileNameFor = (m) => `${m.sha256}.${EXT[m.kind] || 'bin'}`;

/**
 * @returns {{ msgs, mediaHashes, days, deletions, membership, from, to }}
 *   msgs         parser-shaped messages from every bundle day
 *   mediaHashes  group -> filename -> md5, for the media dedupe signal
 *   deletions    one row per post that was withdrawn after it was captured
 */
function loadLive(since = '2000-01-01') {
  const out = {
    msgs: [], mediaHashes: {}, days: [], deletions: [], membership: [],
    from: null, to: null, photos: 0,
  };
  if (!fs.existsSync(BUNDLE_DIR)) return out;

  const files = fs.readdirSync(BUNDLE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const date = f.replace('.json', '');
    if (date < since) continue;
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8')); } catch { continue; }

    for (const m of bundle.messages || []) {
      const files2 = (m.media || []).map(fileNameFor);
      out.photos += files2.length;
      out.mediaHashes[m.group] = out.mediaHashes[m.group] || {};
      (m.media || []).forEach((x) => { out.mediaHashes[m.group][fileNameFor(x)] = x.md5; });
      out.msgs.push({
        date,
        time: m.time,
        sec: m.sec,
        sender: m.sender,
        body: m.text || '',
        group: m.group,
        files: files2,
        mediaOmitted: m.mediaFailed || 0,
        // carried through so dedupe can still match a donor across groups
        phoneHashes: m.phoneHashes || [],
        liveId: m.id,
      });
    }

    for (const e of bundle.events || []) {
      if (e.type === 'message-deleted') out.deletions.push({ date, ...e });
      else out.membership.push({ date, ...e });
    }
    out.days.push({ date, messages: (bundle.messages || []).length, events: (bundle.events || []).length });
  }

  const dates = out.days.map((d) => d.date).sort();
  out.from = dates[0] || null;
  out.to = dates[dates.length - 1] || null;
  return out;
}

module.exports = { loadLive, BUNDLE_DIR, fileNameFor };
