#!/usr/bin/env node
/**
 * Stage 1 — parse the WhatsApp exports into deduplicated listing blocks.
 *
 * READ-ONLY with respect to every live data source: this script only reads the
 * chat exports + media folders under whatsapp/, and writes a single file to
 * data/whatsapp/. It never touches Airtable or data/*.json.
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
const OUT_DIR = path.join(ROOT, 'data', 'whatsapp');

// Export folders, oldest first. Each new dump lands in its own dated folder
// ("whatsapp 111126") and is discovered automatically — see discoverGroups().
// They cover different periods of the SAME groups, so group numbers repeat
// across folders on purpose: that is what lets the dedupe treat them as one
// timeline. Every such folder is gitignored (private numbers + media).
const SOURCE_DIRS = ['whatsapp', 'whatsapp 111126'];

// Everything before this date is ignored (currently a no-op: the exports start
// 8.6.2026, but the cutoff is part of the agreed spec).
const SINCE = '2025-05-01';

// Legacy (iPhone) dump: three loose chat files, media in sibling folders.
const LEGACY_CHATS = { '_chat.txt': 4, '_chat 2.txt': 5, '_chat 3.txt': 6 };

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

/* The two export formats differ in more than cosmetics:
 *
 *   iPhone   [12.9.2026, 13:17:44] sender: body      media: <מצורף: FILE>
 *   Android  12.9.2026, 13:17 - sender: body         media: FILE (קובץ מצורף)
 *
 * Android has no seconds (so the 180s block window becomes minute-grained),
 * and it writes "<המדיה לא נכללה>" for messages whose file was left out of the
 * dump — the export only carries media for the most recent ~1,000 messages.
 *
 * NOTE on the sender split: the body may be empty (297 such headers in group 4
 * alone) — the line ends right after "sender:". Requiring a space there made
 * those headers fail to match and get swallowed as continuation text. The
 * sender is taken up to the FIRST ": " rather than with [^:]+, because display
 * names contain colons ("~ 8:8 🫂🥺♥️").
 */
const IOS_HDR = /^‏?\[(\d{1,2})\.(\d{1,2})\.(\d{4}), (\d{1,2}):(\d{2}):(\d{2})\] ([\s\S]*)$/;
const AND_HDR = /^[‎‏]*(\d{1,2})\.(\d{1,2})\.(\d{4}), (\d{1,2}):(\d{2}) - ([\s\S]*)$/;
const SENDER_RE = /^(.*?):(?: ([\s\S]*))?$/;
const IOS_ATTACH_RE = /<מצורף:\s*([^>]+?)\s*>/g;
const AND_ATTACH_RE = /^\s*([\w.\-]+\.\w{2,4})\s*\(קובץ מצורף\)\s*$/;
const MEDIA_OMITTED = /<המדיה לא נכללה>|<Media omitted>/;

const BLOCK_GAP_SEC = 180;      // same sender, messages this close = one listing
const RESERVE_WINDOW_SEC = 1800; // "reserved" note counts if within 30min after

// ------------------------------------------------------------ source discovery
/**
 * Find every chat file across the export folders, with the media folder that
 * belongs to it. Two layouts exist:
 *   whatsapp/_chat 2.txt          + whatsapp/WhatsApp Chat - 5️⃣…/   (iPhone)
 *   whatsapp 111126/group-5/*.txt + the same folder                 (Android)
 * Group numbers come from the folder/file name and repeat across dumps,
 * because they are the same WhatsApp groups at different times.
 */
function discoverGroups() {
  const out = [];
  SOURCE_DIRS.forEach((rel) => {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);

    // --- iPhone layout: loose _chat*.txt + "WhatsApp Chat - N️⃣…" media dirs
    Object.entries(LEGACY_CHATS).forEach(([file, group]) => {
      if (!entries.includes(file)) return;
      const mediaDir = entries
        .map((d) => path.join(dir, d))
        .find((d) => path.basename(d).startsWith('WhatsApp Chat -')
          && fs.statSync(d).isDirectory()
          && new RegExp(`${group}️?⃣`).test(path.basename(d)));
      out.push({ group, label: `${rel}/${file}`, chat: path.join(dir, file), mediaDir, format: 'ios' });
    });

    // --- Android layout: one folder per group, chat + media together
    entries.forEach((d) => {
      const full = path.join(dir, d);
      if (!d.startsWith('group-') || !fs.statSync(full).isDirectory()) return;
      const chat = fs.readdirSync(full).find((f) => f.endsWith('.txt'));
      if (!chat) return;
      // "group-center" is a separate branch of the initiative — numbered past
      // the main groups so it never collides with them in the dedupe.
      const n = d === 'group-center' ? 7 : Number(d.replace('group-', ''));
      out.push({ group: n, label: `${rel}/${d}`, chat: path.join(full, chat), mediaDir: full, format: 'android' });
    });
  });
  return out;
}

// ---------------------------------------------------------------- media hashes
/** MD5 every media file of a group folder, keyed by the filename the chat cites. */
function hashDir(dir) {
  const map = {};
  if (!dir || !fs.existsSync(dir)) return map;
  fs.readdirSync(dir).forEach((fn) => {
    const p = path.join(dir, fn);
    if (fn.startsWith('.') || fn.endsWith('.txt') || !fs.statSync(p).isFile()) return;
    map[fn] = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  });
  return map;
}

// ---------------------------------------------------------------- chat parsing
function parseChat({ chat, group, format }) {
  const raw = fs.readFileSync(chat, 'utf8');
  const HDR = format === 'ios' ? IOS_HDR : AND_HDR;
  const msgs = [];
  let cur = null;
  let sysLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = HDR.exec(line);
    if (m) {
      const rest = format === 'ios' ? m[7] : m[6];
      const sp = SENDER_RE.exec(rest);
      // A header with no "sender:" is a WhatsApp notice (joins, leaves, group
      // settings). Android writes a lot of them; they are never listings.
      if (!sp) { sysLines++; cur = null; continue; }
      if (cur) msgs.push(cur);
      const [, D, M, Y, hh, mm] = m;
      const ss = format === 'ios' ? m[6] : '00';
      cur = {
        date: `${Y}-${M.padStart(2, '0')}-${D.padStart(2, '0')}`,
        time: `${hh.padStart(2, '0')}:${mm}:${ss}`,
        sec: Number(hh) * 3600 + Number(mm) * 60 + Number(ss),
        sender: sp[1].trim(),
        body: sp[2] || '',
      };
    } else if (cur) {
      cur.body += '\n' + line.replace(/\n$/, '');
    }
  }
  if (cur) msgs.push(cur);

  // Pull out attached filenames while the format is still known, so the rest
  // of the pipeline only ever sees a plain list.
  msgs.forEach((x) => {
    const files = [];
    let omitted = 0;
    if (format === 'ios') {
      let a;
      IOS_ATTACH_RE.lastIndex = 0;
      while ((a = IOS_ATTACH_RE.exec(x.body)) !== null) files.push(a[1].trim());
    } else {
      x.body.split('\n').forEach((l) => {
        const a = AND_ATTACH_RE.exec(stripMarks(l));
        if (a) files.push(a[1]);
      });
    }
    // Media the export left out: still evidence that something was shown,
    // but there is no file to hash or to identify the item from.
    if (MEDIA_OMITTED.test(x.body)) omitted = (x.body.match(MEDIA_OMITTED) || []).length;
    x.files = files;
    x.mediaOmitted = omitted;
  });

  return {
    sysLines,
    msgs: msgs
      .filter((x) => !SYSTEM_MARKERS.some((s2) => x.body.includes(s2)))
      .filter((x) => x.date >= SINCE)
      .map((x) => ({ ...x, group })),
  };
}

/**
 * Mask donor phone numbers. The chats are full of private contact details and
 * data/ is published to GitHub Pages — raw numbers must never reach an output
 * file. Dedupe still uses the real numbers, but only in memory.
 */
// Donors write their number every way imaginable: with +972, with a leading
// 0, with neither ("50-812-5191"), in Arabic-Indic digits, and split by
// spaces, ASCII hyphens, U+2011 hyphens, dots or direction marks. Matching a
// fixed shape missed the bare-local form and leaked real numbers into the
// published files, so instead: pull out every run of 8-15 digits, strip the
// separators, and redact it if what remains is an Israeli mobile number.
const DIGIT = '[0-9\\u0660-\\u0669]';
const SEP = '[\\s\\u00a0.\\-\\u2010-\\u2015\\u200e\\u200f\\u202a-\\u202e]*';
const PHONE_RE = new RegExp(`\\+?${SEP}${DIGIT}(?:${SEP}${DIGIT}){7,14}`, 'g');
const MOBILE_RE = /^(?:972)?0?5\d{8}$/;
const asciiDigits = (s) => s.replace(/[\u0660-\u0669]/g,
  (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48)).replace(/\D/g, '');
const asMobile = (run) => {
  const d = asciiDigits(run);
  return MOBILE_RE.test(d) ? '0' + d.replace(/^972/, '').replace(/^0/, '') : null;
};
const redact = (s) => (s || '').replace(PHONE_RE, (m) => (asMobile(m) ? '[טלפון]' : m));

const stripMarks = (s) => s.replace(/[‎‏]/g, '');
const cleanText = (body) =>
  stripMarks(body.replace(/‏?<מצורף:[^>]*>/g, ''))
    .split('\n')
    .filter((l) => !AND_ATTACH_RE.test(l) && !MEDIA_OMITTED.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  const files = b.msgs.flatMap((m) => m.files || []);
  b.mediaFiles = files;
  b.mediaOmitted = b.msgs.reduce((n, m) => n + (m.mediaOmitted || 0), 0);
  b.mediaCount = files.length + b.mediaOmitted;
  b.mediaHashes = [...new Set(files.map((f) => (mediaHashes[b.group] || {})[f]).filter(Boolean))];
  // same detector as redact(), so a number that identifies a donor for the
  // dedupe is exactly one that gets masked on the way out
  b.phones = [...new Set((b.text.match(PHONE_RE) || []).map(asMobile).filter(Boolean))];
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
  const sources = discoverGroups();
  if (!sources.length) throw new Error(`no chat exports found under ${SOURCE_DIRS.join(', ')}`);

  console.log('⏳ hashing media…');
  const mediaHashes = {};
  sources.forEach((src) => {
    const map = hashDir(src.mediaDir);
    // one group can be fed by several dumps (different periods) — merge them
    mediaHashes[src.group] = Object.assign(mediaHashes[src.group] || {}, map);
    console.log(`  ${src.label}: ${Object.keys(map).length} media files hashed`);
  });

  console.log('⏳ parsing chats…');
  let allBlocks = [];
  const coverage = [];
  sources.forEach((src) => {
    const { msgs, sysLines } = parseChat(src);
    const blocks = toBlocks(msgs).map((b) => enrichBlock(b, mediaHashes));
    // a candidate listing has either real text or media attached
    const cand = blocks.filter((b) => b.text.length >= 15 || b.mediaCount > 0);
    const dates = msgs.map((m) => m.date).sort();
    coverage.push({ source: src.label, group: src.group, format: src.format,
      from: dates[0] || null, to: dates[dates.length - 1] || null,
      messages: msgs.length, candidates: cand.length });
    console.log(`  ${src.label} (group ${src.group}, ${src.format}): ${msgs.length} msgs `
      + `${dates[0] || '-'}→${dates[dates.length - 1] || '-'} → ${blocks.length} blocks → ${cand.length} candidates`
      + ` [${sysLines} notices skipped]`);
    allBlocks = allBlocks.concat(cand);
  });

  const ann = dropAnnouncements(allBlocks);
  console.log(`\n⏳ dropped ${ann.removed} announcement blocks (${ann.templates} recurring templates)`);
  allBlocks = ann.kept;

  console.log(`⏳ deduplicating ${allBlocks.length} candidate blocks…`);
  const { listings, stats } = dedupe(allBlocks);

  const inGroups = {};
  listings.forEach((l) => {
    const n = l.seenInGroups.length;
    inGroups[n] = (inGroups[n] || 0) + 1;
  });

  const out = {
    generated: new Date().toISOString(),
    source: `whatsapp exports (${sources.length} chats, groups ${[...new Set(sources.map((x) => x.group))].sort((a, b) => a - b).join(',')})`,
    coverage: coverage,
    since: SINCE,
    candidateBlocks: allBlocks.length,
    listings: listings.length,
    merges: stats,
    spread: {
      postedInOneGroup: inGroups[1] || 0,
      postedInTwoGroups: inGroups[2] || 0,
      postedInThreeOrMore: Object.entries(inGroups)
        .filter(([n]) => Number(n) >= 3).reduce((a, [, v]) => a + v, 0),
      needsReview: listings.filter((l) => l.needsReview).length,
    },
    data: listings,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'wa-blocks.json'), JSON.stringify(out, null, 1));

  console.log(`\n✅ ${allBlocks.length} blocks → ${listings.length} unique listings`);
  console.log(`   merged by: media ${stats.media}, phone ${stats.phone}, text ${stats.text}`);
  console.log(`   blacklisted boilerplate hashes: ${stats.blacklistedHashes}`);
  console.log(`   posted in 1 group: ${inGroups[1] || 0} | 2: ${inGroups[2] || 0} | 3+: ${out.spread.postedInThreeOrMore}`);
  console.log(`   clusters needing manual review (>3 blocks): ${out.spread.needsReview}`);
  console.log(`📝 data/whatsapp/wa-blocks.json`);
}

// Also used by members.js, which counts the join/leave notices this file skips.
module.exports = { discoverGroups, IOS_HDR, AND_HDR, SENDER_RE, redact, SOURCE_DIRS };

if (require.main === module) main();
