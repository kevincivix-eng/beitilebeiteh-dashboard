#!/usr/bin/env node
/**
 * Publish the list of photos the parser needs and cannot reach.
 *
 * About half of all listings are a photo with nothing but a city and a phone
 * number in the caption. Those are identified from the picture, and the result
 * is cached in vision-results.json keyed by the photo's filename — which for a
 * live day is the photo's sha256, a name that never moves.
 *
 * The problem this file solves is transport, not identification. The collector
 * keeps the photo bytes on the phone and sends only its hash, so from the day
 * the frozen export ends, every photo-only listing counts as a delivery with
 * zero items and zero weight. The phone is the only machine that has the file;
 * it has no idea which ones matter.
 *
 * So the build publishes the shopping list. This runs in CI right after
 * extract.js, writes data/whatsapp/vision-wanted.json, and that file ships with
 * the site like any other. The phone fetches it, pushes exactly those photos to
 * a private repo, and drops them again once they leave the list.
 *
 * The authority deciding what is wanted is therefore the same parser that does
 * the counting — no lexicon copy on the phone, no heuristic to drift.
 *
 * Usage: node build/whatsapp/vision-wanted.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXP = path.join(ROOT, 'data', 'whatsapp');

// A live photo is named by its content. Anything else came out of a chat
// export, whose files sit on the machine that holds the export — that one is
// resolvable locally and is none of the phone's business.
const LIVE_NAME = /^[0-9a-f]{64}\.(?:jpg|jpeg|png|webp)$/i;
const STILL = /\.(?:jpg|jpeg|png|webp)$/i;

const read = (f, fallback) => {
  const p = path.join(EXP, f);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

const listings = read('wa-listings.json', { data: [] }).data;
const blocks = read('wa-blocks.json', { data: [] }).data;
const byId = new Map(blocks.map((b) => [b.id, b]));

const visPath = path.join(__dirname, 'vision-results.json');
const vision = fs.existsSync(visPath)
  ? JSON.parse(fs.readFileSync(visPath, 'utf8')).results
  : {};

// Same cutoff build-exp.js merges from: before June the Airtable record is the
// one that counts, and identifying a photo from a listing nothing counts would
// cost the phone an upload for no number on the dashboard. Live days are all
// well after this, so it is a guard, not a filter.
const FROM = process.env.WA_FROM || '2026-06-01';

const wanted = [];
let noStill = 0;
let exportEra = 0;

for (const l of listings) {
  if (!l.isListing || !l.unidentified) continue;
  if (l.date < FROM) continue;
  const b = byId.get(l.id);
  if (!b || !b.mediaFiles || !b.mediaFiles.length) continue;

  const stills = b.mediaFiles.filter((f) => STILL.test(f));
  if (!stills.length) { noStill++; continue; }
  // Already identified from one of its photos — nothing to fetch.
  if (stills.some((f) => vision[path.basename(f)])) continue;

  const live = stills.filter((f) => LIVE_NAME.test(f));
  if (!live.length) { exportEra++; continue; }

  wanted.push({
    id: l.id,
    date: l.date,
    city: l.city,
    mediaCount: b.mediaCount,
    text: (l.rawText || '').slice(0, 80),
    // One photo per listing, the way the export path has always worked: a
    // contact sheet cell shows one picture and 98% of listings were settled
    // from the first one. The rest are listed so a second pass can ask for
    // another angle without going back to the phone's own storage.
    file: live[0],
    alternates: live.slice(1, 4),
  });
}

const out = {
  generated: new Date().toISOString(),
  note: 'Photos the live collector holds that the parser needs to identify. Fetched by the phone; contains hashes only.',
  count: wanted.length,
  files: wanted.map((w) => w.file),
  data: wanted,
};

fs.mkdirSync(EXP, { recursive: true });
fs.writeFileSync(path.join(EXP, 'vision-wanted.json'), JSON.stringify(out, null, 1));

console.log(`📷 ${wanted.length} live photo(s) wanted for identification`);
if (exportEra) console.log(`   ${exportEra} unidentified listing(s) are export-era — resolved locally, not requested`);
if (noStill) console.log(`   ${noStill} unidentified listing(s) have no still image (video only)`);
console.log('📝 data/whatsapp/vision-wanted.json');
