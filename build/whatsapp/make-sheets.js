#!/usr/bin/env node
/**
 * Prepare the vision pass: pick one representative photo per photo-only
 * listing and emit the work list. The companion Python script builds numbered
 * contact sheets so many listings can be identified per image.
 *
 * Usage: node build/whatsapp/make-sheets.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXP = path.join(ROOT, 'data', 'whatsapp');
// Media folders come from parse.js, which already knows every dump's layout.
const { discoverGroups } = require('./parse.js');
const folders = {};
discoverGroups().forEach((src) => { folders[src.group] = src.mediaDirs; });

// Photos from live days do not live in any export folder: the collector keeps
// them on the phone and the bundle carries only their hash. They arrive here
// through the private photo mailbox — `git pull` in that clone, which is
// gitignored because these are pictures of people's homes and this repo is
// published. A live photo is named by its sha256, so one flat folder is enough
// and a file never needs to be matched to a group.
const LIVE_PHOTOS = process.env.WA_LIVE_PHOTOS || path.join(ROOT, 'wa-live-photos', 'photos');
const LIVE_NAME = /^[0-9a-f]{64}\./i;

const blocks = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-blocks.json'), 'utf8')).data;
const byId = new Map(blocks.map((b) => [b.id, b]));
const listings = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-listings.json'), 'utf8')).data;

const targets = [];
let awaitingMailbox = 0;
listings.filter((l) => l.isListing && l.unidentified).forEach((l) => {
  const b = byId.get(l.id);
  if (!b || !b.mediaFiles.length) return;
  // Every folder this block's photos could be in: the live mailbox first, then
  // the export dumps of each group it appeared in.
  const dirs = [LIVE_PHOTOS, ...b.seenInGroups.flatMap((g) => folders[g] || [])];
  // resolve the first existing photo (skip videos — a still frame needs ffmpeg)
  for (const dir of dirs) {
    const photo = b.mediaFiles.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)
      && fs.existsSync(path.join(dir, f)));
    if (photo) {
      targets.push({
        id: l.id, date: l.date, city: l.city,
        mediaCount: b.mediaCount,
        text: l.rawText.slice(0, 80),
        file: path.join(dir, photo),
      });
      return;
    }
  }
  // A live listing whose photo has not reached the mailbox yet — it is on the
  // phone, waiting for the next run of photos.sh. Not an error, just not here.
  if (b.mediaFiles.some((f) => LIVE_NAME.test(f))) awaitingMailbox++;
});

fs.writeFileSync(path.join(EXP, 'vision-todo.json'), JSON.stringify({
  generated: new Date().toISOString(),
  count: targets.length,
  data: targets,
}, null, 1));

const noPhoto = listings.filter((l) => l.isListing && l.unidentified).length
  - targets.length - awaitingMailbox;
const live = targets.filter((t) => LIVE_NAME.test(path.basename(t.file))).length;
console.log(`✅ ${targets.length} photo-only listings queued for vision (${live} from the live feed)`);
if (awaitingMailbox) console.log(`   ⏳ ${awaitingMailbox} live listing(s) waiting on the photo mailbox — git pull ${path.dirname(LIVE_PHOTOS)}`);
if (noPhoto) console.log(`   (${noPhoto} unidentified listings have no usable still image — video only or missing)`);
console.log('📝 data/whatsapp/vision-todo.json');
