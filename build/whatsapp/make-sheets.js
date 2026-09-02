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
const WA = path.join(ROOT, 'whatsapp');

// group number -> media folder
const folders = {};
fs.readdirSync(WA)
  .filter((d) => d.startsWith('WhatsApp Chat -') && fs.statSync(path.join(WA, d)).isDirectory())
  .forEach((d) => {
    const m = d.match(/([4-9])️?⃣/);
    if (m) folders[Number(m[1])] = d;
  });

const blocks = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-blocks.json'), 'utf8')).data;
const byId = new Map(blocks.map((b) => [b.id, b]));
const listings = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-listings.json'), 'utf8')).data;

const targets = [];
listings.filter((l) => l.isListing && l.unidentified).forEach((l) => {
  const b = byId.get(l.id);
  if (!b || !b.mediaFiles.length) return;
  // resolve the first existing photo (skip videos — a still frame needs ffmpeg)
  for (const g of b.seenInGroups) {
    const dir = folders[g];
    if (!dir) continue;
    const photo = b.mediaFiles.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)
      && fs.existsSync(path.join(WA, dir, f)));
    if (photo) {
      targets.push({
        id: l.id, date: l.date, city: l.city,
        mediaCount: b.mediaCount,
        text: l.rawText.slice(0, 80),
        file: path.join(WA, dir, photo),
      });
      return;
    }
  }
});

fs.writeFileSync(path.join(EXP, 'vision-todo.json'), JSON.stringify({
  generated: new Date().toISOString(),
  count: targets.length,
  data: targets,
}, null, 1));

const noPhoto = listings.filter((l) => l.isListing && l.unidentified).length - targets.length;
console.log(`✅ ${targets.length} photo-only listings queued for vision`);
if (noPhoto) console.log(`   (${noPhoto} unidentified listings have no usable still image — video only or missing)`);
console.log('📝 data/whatsapp/vision-todo.json');
