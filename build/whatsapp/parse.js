#!/usr/bin/env node
/**
 * Stage 1 — parse the WhatsApp exports into deduplicated listing blocks.
 *
 * READ-ONLY with respect to every live data source: this script only reads the
 * chat exports + media folders under whatsapp/, and writes a single file to
 * data/experimental/. It never touches Airtable or data/*.json.
 *
 * The three groups mirror each other imperfectly, so a listing posted to all
 * three must collapse to ONE record. Dedupe uses three signals, unioned
 * transitively (see README in the plan):
 *   1. media MD5   — the same photo file is forwarded byte-identically
 *   2. phone+date  — same donor contact within a few days
 *   3. fuzzy text  — token Jaccard, catches rewrites/typos
 *
 * Usage: node build/whatsapp/parse.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const WA_DIR = path.join(ROOT, 'whatsapp');
const OUT_DIR = path.join(ROOT, 'data', 'experimental');

// Everything before this date is ignored (currently a no-op: the exports start
// 8.6.2026, but the cutoff is part of the agreed spec).
const SINCE = '2025-05-01';

const CHAT_FILES = ['_chat.txt', '_chat 2.txt', '_chat 3.txt'];

// WhatsApp system/administrative lines — never listings.
const SYSTEM_MARKERS = [
  'הצטרף/ה לקבוצה', 'יצא/ה', 'צירף/ה את', 'הוסר/ה', 'שינית את',
  'יצרת את הקבוצה', 'ההודעות והשיחות מוצפנות', 'החלפת את תמונת',
  'הפכת את', 'כל חברי הקבוצה', 'שינה/תה את', 'הוסרת', 'הצטרפת',
  'קוד האבטחה',
  // 2nd-person / passive variants that also appear in these exports
  'צירפת את', 'צורפו על ידי', 'צורף/ה', 'הסרת את', 'הוסיף/ה את', 'הסיר/ה את',
  'הודעות נעלמות', 'שינה את נושא', 'אין לך הרשאה',
];

const RESERVED_RE = /انحجز|انحجزن|انحجزو|انحجزت|احتجز/;
// NOTE: the body may be empty (297 such headers in group 4 alone) — the line
// ends right after "sender:". Requiring a space there made those headers fail
// to match and get swallowed as continuation text of the previous message.
const MSG_RE = /^‏?\[(\d{1,2})\.(\d{1,2})\.(\d{4}), (\d{1,2}):(\d{2}):(\d{2})\] ([^:]+):[ ]?([\s\S]*)$/;
const ATTACH_RE = /<מצורף:\s*([^>]+?)\s*>/g;

const BLOCK_GAP_SEC = 180;      // same sender, messages this close = one listing
const RESERVE_WINDOW_SEC = 1800; // "reserved" note counts if within 30min after

// ---------------------------------------------------------------- media hashes
/** Map every media file in the group folders to its MD5. */
function hashMedia() {
  const byGroup = {}; // group -> { filename: md5 }
  const dirs = fs.readdirSync(WA_DIR)
    .filter((d) => d.startsWith('WhatsApp Chat -') && fs.statSync(path.join(WA_DIR, d)).isDirectory());
  dirs.forEach((d) => {
    // group number is encoded as a keycap emoji (4️⃣/5️⃣/6️⃣) in the folder name
    const m = d.match(/([4-9])️?⃣/);
    const group = m ? Number(m[1]) : null;
    if (!group) return;
    const map = {};
    fs.readdirSync(path.join(WA_DIR, d)).forEach((fn) => {
      const p = path.join(WA_DIR, d, fn);
      if (!fs.statSync(p).isFile() || fn.startsWith('.')) return;
      map[fn] = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    });
    byGroup[group] = map;
    console.log(`  group ${group}: ${Object.keys(map).length} media files hashed`);
  });
  return byGroup;
}

// ---------------------------------------------------------------- chat parsing
function parseChat(file, group) {
  const raw = fs.readFileSync(path.join(WA_DIR, file), 'utf8');
  const msgs = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = MSG_RE.exec(line);
    if (m) {
      if (cur) msgs.push(cur);
      const [, D, M, Y, hh, mm, ss] = m;
      cur = {
        date: `${Y}-${M.padStart(2, '0')}-${D.padStart(2, '0')}`,
        time: `${hh.padStart(2, '0')}:${mm}:${ss}`,
        sec: Number(hh) * 3600 + Number(mm) * 60 + Number(ss),
        sender: m[7].trim(),
        body: m[8],
      };
    } else if (cur) {
      cur.body += '\n' + line.replace(/\n$/, '');
    }
  }
  if (cur) msgs.push(cur);

  return msgs
    .filter((x) => !SYSTEM_MARKERS.some((s) => x.body.includes(s)))
    .filter((x) => x.date >= SINCE)
    .map((x) => ({ ...x, group }));
}

/**
 * Mask donor phone numbers. The chats are full of private contact details and
 * data/ is published to GitHub Pages — raw numbers must never reach an output
 * file. Dedupe still uses the real numbers, but only in memory.
 */
// Deliberately permissive about separators: the chats use spaces, ASCII
// hyphens, U+2011 non-breaking hyphens, dots, or nothing at all.
const SEP = '[\\s\\-\\u2010-\\u2015.]*';
const PHONE_RE = new RegExp(`(?:\\+?972${SEP}|0)5\\d${SEP}\\d{3}${SEP}\\d{4}`, 'g');
const redact = (s) => (s || '').replace(PHONE_RE, '[טלפון]');

const stripMarks = (s) => s.replace(/[‎‏]/g, '');
const cleanText = (body) =>
  stripMarks(body.replace(/‏?<מצורף:[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Group consecutive messages from one sender into a single listing block. */
function toBlocks(msgs) {
  const blocks = [];
  let cur = null;
  for (const m of msgs) {
    if (m.body.includes('ההודעה הזו נמחקה')) continue;
    if (cur && m.sender === cur.sender && m.date === cur.date && m.sec - cur.lastSec <= BLOCK_GAP_SEC) {
      cur.msgs.push(m);
      cur.lastSec = m.sec;
    } else {
      if (cur) blocks.push(cur);
      cur = { sender: m.sender, date: m.date, group: m.group, time: m.time, sec: m.sec, lastSec: m.sec, msgs: [m] };
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function enrichBlock(b, mediaHashes) {
  b.text = b.msgs.map((m) => cleanText(m.body)).filter(Boolean).join(' ').trim();
  const files = [];
  b.msgs.forEach((m) => {
    let a;
    ATTACH_RE.lastIndex = 0;
    while ((a = ATTACH_RE.exec(m.body)) !== null) files.push(a[1].trim());
  });
  b.mediaFiles = files;
  b.mediaCount = files.length;
  b.mediaHashes = [...new Set(files.map((f) => (mediaHashes[b.group] || {})[f]).filter(Boolean))];
  b.phones = [...new Set(
    (b.text.match(/(?:\+?972[\s\-‑]?|0)5\d[\s\-‑]?\d{3}[\s\-‑]?\d{4}/g) || [])
      .map((p) => p.replace(/[^\d]/g, '').replace(/^972/, '0'))
      .filter((p) => p.length === 10)
  )];
  b.reserved = RESERVED_RE.test(b.text);
  // Arabic token set, used for the fuzzy-text dedupe signal
  b.tokens = [...new Set(
    b.text.replace(/[^؀-ۿ\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2)
  )];
  return b;
}

/**
 * Drop recurring announcement templates (group rules, the moderators' phone
 * list, weekly greetings). They are not listings, and because they repeat with
 * near-identical wording they would otherwise chain into giant false clusters.
 * Detected generically: the same normalized Arabic text posted on >2 distinct
 * dates is a template, not an item offer.
 */
function dropAnnouncements(blocks) {
  const key = (b) => b.tokens.slice(0, 10).join(' ');
  const dates = new Map();
  blocks.forEach((b) => {
    if (b.tokens.length < 4) return;
    const k = key(b);
    if (!dates.has(k)) dates.set(k, new Set());
    dates.get(k).add(b.date);
  });
  const templates = new Set([...dates.entries()].filter(([, d]) => d.size > 2).map(([k]) => k));

  // The moderators' contact card lists several phone numbers with almost no
  // prose — it is a directory, not an item offer.
  const isContactCard = (b) => b.phones.length >= 3 && b.tokens.length < 12;

  const kept = blocks.filter((b) =>
    !(b.tokens.length >= 4 && templates.has(key(b))) && !isContactCard(b));
  return { kept, removed: blocks.length - kept.length, templates: templates.size };
}

// ------------------------------------------------------------------- dedupe
class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra === rb) return false; this.p[ra] = rb; return true; }
}

const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);

function dedupe(blocks) {
  const dsu = new DSU(blocks.length);
  const stats = { media: 0, phone: 0, text: 0, blacklistedHashes: 0 };
  const mergedBy = blocks.map(() => new Set());

  // --- signal 1: media MD5.
  // Guard: a hash is only identity-bearing if it appears at most ONCE per group.
  // Boilerplate images (group rules, banners) are reposted many times and would
  // otherwise chain unrelated listings together.
  const perHashGroupCount = new Map();
  blocks.forEach((b) => b.mediaHashes.forEach((h) => {
    if (!perHashGroupCount.has(h)) perHashGroupCount.set(h, new Map());
    const g = perHashGroupCount.get(h);
    g.set(b.group, (g.get(b.group) || 0) + 1);
  }));
  const usableHash = new Set();
  perHashGroupCount.forEach((groups, h) => {
    if (Math.max(...groups.values()) <= 1) usableHash.add(h);
    else stats.blacklistedHashes++;
  });

  const byHash = new Map();
  blocks.forEach((b, i) => b.mediaHashes.forEach((h) => {
    if (!usableHash.has(h)) return;
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(i);
  }));
  byHash.forEach((idxs) => {
    for (let k = 1; k < idxs.length; k++) {
      if (dsu.union(idxs[0], idxs[k])) stats.media++;
      mergedBy[idxs[0]].add('media'); mergedBy[idxs[k]].add('media');
    }
  });

  const jaccard = (A, B) => {
    const sa = new Set(A); let inter = 0;
    B.forEach((t) => { if (sa.has(t)) inter++; });
    const union = A.length + B.length - inter;
    return union ? inter / union : 0;
  };

  // --- signal 2: same donor phone, different group, within 1 day.
  // A phone identifies a DONOR, not a listing — the same person offers many
  // different items over time. Requiring corroborating text overlap prevents
  // collapsing a donor's whole history into one record.
  const byPhone = new Map();
  blocks.forEach((b, i) => b.phones.forEach((p) => {
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(i);
  }));
  byPhone.forEach((idxs) => {
    for (let a = 0; a < idxs.length; a++) {
      for (let c = a + 1; c < idxs.length; c++) {
        const i = idxs[a]; const j = idxs[c];
        if (blocks[i].group === blocks[j].group) continue;
        if (Math.abs(dayNum(blocks[i].date) - dayNum(blocks[j].date)) > 1) continue;
        if (jaccard(blocks[i].tokens, blocks[j].tokens) < 0.4) continue;
        if (dsu.union(i, j)) stats.phone++;
        mergedBy[i].add('phone'); mergedBy[j].add('phone');
      }
    }
  });

  // --- signal 3: fuzzy Arabic token overlap, different group, within 2 days
  const byDay = new Map();
  blocks.forEach((b, i) => {
    if (b.tokens.length < 4) return;
    const d = dayNum(b.date);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(i);
  });
  [...byDay.keys()].sort((a, b) => a - b).forEach((d) => {
    const near = [...(byDay.get(d) || []), ...(byDay.get(d + 1) || []), ...(byDay.get(d + 2) || [])];
    (byDay.get(d) || []).forEach((i) => {
      near.forEach((j) => {
        if (i >= j) return;
        if (blocks[i].group === blocks[j].group) return;
        if (jaccard(blocks[i].tokens, blocks[j].tokens) < 0.6) return;
        if (dsu.union(i, j)) stats.text++;
        mergedBy[i].add('text'); mergedBy[j].add('text');
      });
    });
  });

  // --- collapse clusters into one listing each
  const clusters = new Map();
  blocks.forEach((_, i) => {
    const r = dsu.find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  });

  const listings = [];
  clusters.forEach((idxs) => {
    // representative = the richest text, tie-broken by earliest post
    const sorted = [...idxs].sort((a, b) => {
      const t = blocks[b].text.length - blocks[a].text.length;
      return t !== 0 ? t : (blocks[a].date + blocks[a].time).localeCompare(blocks[b].date + blocks[b].time);
    });
    const rep = blocks[sorted[0]];
    const earliest = idxs.map((i) => blocks[i]).sort((a, b) =>
      (a.date + a.time).localeCompare(b.date + b.time))[0];
    const by = new Set();
    idxs.forEach((i) => mergedBy[i].forEach((x) => by.add(x)));
    listings.push({
      id: `wa-${earliest.date}-${earliest.time.replace(/:/g, '')}-${earliest.group}`,
      date: earliest.date,          // earliest posting = when the item was offered
      time: earliest.time,
      // members whose WhatsApp display name is just their phone number
      sender: redact(rep.sender),
      text: redact(rep.text),
      mediaCount: Math.max(...idxs.map((i) => blocks[i].mediaCount)),
      mediaFiles: rep.mediaFiles,
      // real numbers stay in memory for dedupe only — never serialized
      phoneCount: new Set(idxs.flatMap((i) => blocks[i].phones)).size,
      reserved: idxs.some((i) => blocks[i].reserved),
      seenInGroups: [...new Set(idxs.map((i) => blocks[i].group))].sort(),
      mergedBy: [...by].sort(),
      blockCount: idxs.length,
      needsReview: idxs.length > 3, // suspicious cluster size -> manual check
      members: idxs.map((i) => ({
        group: blocks[i].group, date: blocks[i].date, time: blocks[i].time,
        text: redact(blocks[i].text).slice(0, 200),
      })),
    });
  });

  listings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { listings, stats };
}

// ---------------------------------------------------------------------- main
function main() {
  console.log('⏳ hashing media…');
  const mediaHashes = hashMedia();

  console.log('⏳ parsing chats…');
  let allBlocks = [];
  CHAT_FILES.forEach((file, i) => {
    const group = i + 4; // groups are numbered 4, 5, 6
    const msgs = parseChat(file, group);
    const blocks = toBlocks(msgs).map((b) => enrichBlock(b, mediaHashes));
    // a candidate listing has either real text or media attached
    const cand = blocks.filter((b) => b.text.length >= 15 || b.mediaHashes.length > 0);
    console.log(`  ${file} (group ${group}): ${msgs.length} content msgs → ${blocks.length} blocks → ${cand.length} candidates`);
    allBlocks = allBlocks.concat(cand);
  });

  const ann = dropAnnouncements(allBlocks);
  console.log(`\n⏳ dropped ${ann.removed} announcement blocks (${ann.templates} recurring templates)`);
  allBlocks = ann.kept;

  console.log(`⏳ deduplicating ${allBlocks.length} candidate blocks…`);
  const { listings, stats } = dedupe(allBlocks);

  const inGroups = { 1: 0, 2: 0, 3: 0 };
  listings.forEach((l) => { inGroups[l.seenInGroups.length]++; });

  const out = {
    generated: new Date().toISOString(),
    source: 'whatsapp exports (groups 4,5,6)',
    since: SINCE,
    candidateBlocks: allBlocks.length,
    listings: listings.length,
    merges: stats,
    coverage: {
      postedInOneGroup: inGroups[1],
      postedInTwoGroups: inGroups[2],
      postedInAllThree: inGroups[3],
      needsReview: listings.filter((l) => l.needsReview).length,
    },
    data: listings,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'wa-blocks.json'), JSON.stringify(out, null, 1));

  console.log(`\n✅ ${allBlocks.length} blocks → ${listings.length} unique listings`);
  console.log(`   merged by: media ${stats.media}, phone ${stats.phone}, text ${stats.text}`);
  console.log(`   blacklisted boilerplate hashes: ${stats.blacklistedHashes}`);
  console.log(`   posted in 1 group: ${inGroups[1]} | 2 groups: ${inGroups[2]} | all 3: ${inGroups[3]}`);
  console.log(`   clusters needing manual review (>3 blocks): ${out.coverage.needsReview}`);
  console.log(`📝 data/experimental/wa-blocks.json`);
}

main();
