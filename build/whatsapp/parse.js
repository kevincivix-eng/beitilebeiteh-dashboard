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
const { loadLive } = require('./live-source');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'whatsapp');

// Export folders, oldest first. Each new dump lands in its own dated folder
// ("whatsapp 111126") and is discovered automatically — see discoverGroups().
// They cover different periods of the SAME groups, so group numbers repeat
// across folders on purpose: that is what lets the dedupe treat them as one
// timeline. Every such folder is gitignored (private numbers + media).
// Oldest first. A later dump SUPERSEDES an earlier one for the same group:
// the exports overlap in time, and two copies of one period would be counted
// twice (the dedupe only ever merges across different groups, never within
// one). Media folders are the exception — those accumulate from every dump,
// because a text-only export carries no files at all.
const SOURCE_DIRS = ['whatsapp', 'whatsapp 111126', 'whatsapp 1811'];

// Everything before this date is ignored (currently a no-op: the exports start
// 8.6.2026, but the cutoff is part of the agreed spec).
const SINCE = '2025-05-01';

// Which group a chat file belongs to is read from the export itself: the
// group's own name starts with a keycap digit ("4️⃣من بيتي لبيتك"). File names
// cannot be trusted — "_chat 2.txt" is group 5 in one dump and group 2 in the
// next.
const GROUP_IN_NAME = /([1-9])️?⃣\s*من\s*بيتي/;
const GROUP_KEYCAP = /([1-9])️?⃣/;

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
// Text-only iPhone export: the file is gone, only the fact of it remains.
const IOS_OMITTED = /(התמונה|הסרטון|האודיו|הקובץ|מדבקה|הודעה קולית)[^\n]{0,12}הושמט/;

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
  const chats = new Map();   // group -> newest chat found
  const media = new Map();   // group -> [folders], from every dump

  const groupOf = (text) => {
    // The branch group is also called "1️⃣…" but is a different group
    // ("من بيتي لبيتك المركز"), so it is numbered past the main ones.
    if (/المركز|group-center/.test(text)) return 7;
    const m = GROUP_IN_NAME.exec(text) || GROUP_KEYCAP.exec(text);
    return m ? Number(m[1]) : null;
  };

  SOURCE_DIRS.forEach((rel) => {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) return;

    const addChat = (file, mediaDir) => {
      const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
      const format = AND_HDR.test(head.split('\n')[0]) ? 'android' : 'ios';
      // The group's own name appears in the first lines — as the sender of the
      // "group created" notice, or in the notice text itself.
      const group = groupOf(head.split('\n').slice(0, 20).join('\n'))
        || groupOf(path.basename(file))
        || groupOf(path.basename(path.dirname(file)));
      if (!group) { console.warn(`  ⚠️ skipped ${rel}/${path.basename(file)} — could not tell which group it is`); return; }
      chats.set(group, { group, label: `${rel}/${path.basename(file)}`, chat: file, mediaDir, format });
    };

    fs.readdirSync(dir).forEach((entry) => {
      const full = path.join(dir, entry);
      let st; try { st = fs.statSync(full); } catch { return; }

      if (st.isFile() && /^_chat.*\.txt$/i.test(entry)) { addChat(full, null); return; }
      if (!st.isDirectory()) return;

      // A media folder, a per-group folder, or both at once
      const inner = fs.readdirSync(full);
      const g = groupOf(entry) || (entry === 'group-center' ? 7 : null)
        || (/^group-(\d+)$/.test(entry) ? Number(entry.replace('group-', '')) : null);
      if (g) (media.get(g) || media.set(g, []).get(g)).push(full);
      inner.filter((f) => f.endsWith('.txt')).forEach((f) => addChat(path.join(full, f), full));
    });
  });

  // Every dump's media belongs to the chat that survived for that group.
  return [...chats.values()].map((c) => ({
    ...c,
    mediaDirs: [...new Set([...(media.get(c.group) || []), c.mediaDir].filter(Boolean))],
  })).sort((a, b) => a.group - b.group);
}

// ---------------------------------------------------------------- media hashes
/**
 * MD5 every media file of a group folder.
 *
 * Indexed twice. By filename, for exports that cite the file by name
 * ("<מצורף: 00000038-PHOTO-…jpg>"). And by the timestamp inside that
 * filename, because a text-only export says nothing but "התמונה הושמטה" —
 * the photo is still on disk from an earlier dump of the same group, and the
 * send time is the only thing linking the two.
 */
const FILE_STAMP = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\./;
function hashDir(dir) {
  const byName = {}; const byStamp = {};
  if (!dir || !fs.existsSync(dir)) return { byName, byStamp };
  fs.readdirSync(dir).forEach((fn) => {
    const p = path.join(dir, fn);
    if (fn.startsWith('.') || fn.endsWith('.txt') || !fs.statSync(p).isFile()) return;
    byName[fn] = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    const t = FILE_STAMP.exec(fn);
    if (t) {
      const key = `${t[1]}-${t[2]}-${t[3]} ${t[4]}:${t[5]}:${t[6]}`;
      (byStamp[key] = byStamp[key] || []).push(fn);
    }
  });
  return { byName, byStamp };
}

// ---------------------------------------------------------------- chat parsing
function parseChat({ chat, group, format }, byStamp = {}) {
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
      // Media stripped from this export, but kept by an earlier one: the
      // file is named after the send time, so look it up by that.
      const stripped = (stripMarks(x.body).match(new RegExp(IOS_OMITTED.source, 'g')) || []).length;
      if (stripped) {
        const pool = (byStamp[`${x.date} ${x.time}`] || []).filter((f) => !files.includes(f));
        files.push(...pool.slice(0, stripped));
        omitted += Math.max(0, stripped - pool.length);
      }
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
    .filter((l) => !AND_ATTACH_RE.test(l) && !MEDIA_OMITTED.test(l) && !IOS_OMITTED.test(l))
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

/**
 * @param deleted  liveId -> ISO time the post was withdrawn. In these groups a
 *   listing is taken down once the item is handed over, so a withdrawal is the
 *   closest thing we have to a confirmed delivery — and it is only ever visible
 *   to the live collector, never to an export taken afterwards.
 */
function dedupe(blocks, deleted = new Map()) {
  const dsu = new DSU(blocks.length);
  const stats = { media: 0, phone: 0, text: 0, simultaneous: 0, blacklistedHashes: 0 };
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

  // --- signal 4: one moderator forwarding the same listing to every group.
  //
  // The posts land seconds apart (median 10s), which is the only thing left to
  // match on when a text-only export carries no filename to hash and the
  // caption is a bare city name. Pairs are taken nearest-in-time first, and a
  // cluster may hold AT MOST ONE block per group — that guard is what keeps a
  // moderator's burst of several different listings from collapsing into one,
  // since each copy can only claim a group that is still free.
  const SIM_WINDOW_SEC = 180;
  const groupsOf = new Map();   // dsu root -> Set(group)
  blocks.forEach((b, i) => {
    const r = dsu.find(i);
    if (!groupsOf.has(r)) groupsOf.set(r, new Set());
    groupsOf.get(r).add(b.group);
  });

  const buckets = new Map();
  blocks.forEach((b, i) => {
    const k = `${b.sender}|${b.date}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });

  const pairs = [];
  buckets.forEach((idxs) => {
    const sorted = [...idxs].sort((a, b) => blocks[a].sec - blocks[b].sec);
    for (let a = 0; a < sorted.length; a++) {
      for (let c = a + 1; c < sorted.length; c++) {
        const i = sorted[a]; const j = sorted[c];
        const dt = Math.abs(blocks[i].sec - blocks[j].sec);
        if (dt > SIM_WINDOW_SEC) break;              // sorted: no closer pair ahead
        if (blocks[i].group === blocks[j].group) continue;
        // same shape: a forward carries the same number of photos
        if (blocks[i].mediaCount !== blocks[j].mediaCount) continue;
        // if both actually say something, they must say the same thing
        const ti = blocks[i].tokens; const tj = blocks[j].tokens;
        if (ti.length >= 4 && tj.length >= 4 && jaccard(ti, tj) < 0.3) continue;
        pairs.push([dt, i, j]);
      }
    }
  });
  pairs.sort((a, b) => a[0] - b[0]);
  pairs.forEach(([, i, j]) => {
    const ri = dsu.find(i); const rj = dsu.find(j);
    if (ri === rj) return;
    const gi = groupsOf.get(ri); const gj = groupsOf.get(rj);
    for (const g of gj) if (gi.has(g)) return;       // that group is already spoken for
    dsu.union(i, j);
    const root = dsu.find(i);
    const merged = new Set([...gi, ...gj]);
    groupsOf.set(root, merged);
    stats.simultaneous++;
    mergedBy[i].add('time'); mergedBy[j].add('time');
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
    // A withdrawal in ANY of the groups counts: the moderator deletes the post
    // group by group, and the first deletion is when the item went.
    const takenDown = idxs
      .flatMap((i) => (blocks[i].liveIds || []).map((id) => deleted.get(id)))
      .filter(Boolean).sort();
    listings.push({
      id: `wa-${earliest.date}-${earliest.time.replace(/:/g, '')}-${earliest.group}`,
      date: earliest.date,          // earliest posting = when the item was offered
      time: earliest.time,
      // members whose WhatsApp display name is just their phone number
      sender: redact(rep.sender),
      text: redact(rep.text),
      mediaCount: Math.max(...idxs.map((i) => blocks[i].mediaCount)),
      // every copy's files, not just the representative's: a text-only export
      // can win the "richest text" tie-break while carrying no photo at all,
      // and the photo is what the vision pass is keyed on
      mediaFiles: [...new Set(idxs.flatMap((i) => blocks[i].mediaFiles))],
      // real numbers stay in memory for dedupe only — never serialized
      phoneCount: new Set(idxs.flatMap((i) => blocks[i].phones)).size,
      reserved: idxs.some((i) => blocks[i].reserved),
      ...(blocks[sorted[0]].live ? { live: true } : {}),
      ...(takenDown.length ? { withdrawnAt: takenDown[0], withdrawnInGroups: takenDown.length } : {}),
      seenInGroups: [...new Set(idxs.map((i) => blocks[i].group))].sort(),
      mergedBy: [...by].sort(),
      blockCount: idxs.length,
      // A healthy cluster holds exactly one copy per group — the same listing
      // forwarded around. More copies than groups means some group has two,
      // which is how an over-merge shows up (a donor's phone number matching
      // a different listing of hers the same evening).
      needsReview: idxs.length > new Set(idxs.map((i) => blocks[i].group)).size,
      members: idxs.map((i) => ({
        group: blocks[i].group, date: blocks[i].date, time: blocks[i].time,
        text: redact(blocks[i].text).slice(0, 200),
      })),
    });
  });

  listings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { listings, stats };
}

// Where one live listing ends and the next begins.
//
// One moderator relays almost everything into these groups, forwarding an offer
// to all six in a burst and then pausing to pick up the next. That rhythm is
// the boundary, and live timestamps are accurate to the second, so it is
// visible: measured over a full afternoon, messages inside one offer arrive at
// most 15s apart (a caption typed after the photos), while consecutive offers
// are never closer than 21s. 20s sits in that gap.
//
// The tempting rule — "the donor's phone number ends the offer" — is wrong, and
// the data says so: in group 6 she posted the number after the FIRST of ten
// photos and carried on. Cutting there put nine clothing photos into the next
// offer's block, whose matching photos then chained two unrelated listings into
// one. Splitting too eagerly is recoverable (the dedupe rejoins copies);
// merging two offers is not.
const LIVE_GAP_SEC = 20;

/**
 * Same contract as toBlocks(), with the live-only gap above. Kept separate on
 * purpose: the exports are minute-resolution and already parsed into 6,231
 * listings, and re-cutting them on a rule derived from live seconds would
 * silently reshape a year of published history.
 */
function liveToBlocks(msgs) {
  const blocks = [];
  let cur = null;
  for (const m of msgs) {
    if (cur && m.sender === cur.sender && m.date === cur.date && m.sec - cur.lastSec <= LIVE_GAP_SEC) {
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

/**
 * Blocks from the live collector, in the same shape the exports produce.
 *
 * Exports and live days meet at a seam — the last exported day is the day
 * before the collector was linked — and from there on the live feed is the only
 * source. It is also the better one: it holds the listings that were deleted
 * after delivery, which an export taken days later can no longer see.
 */
function liveBlocks(mediaHashes) {
  const live = loadLive(SINCE);
  if (!live.msgs.length) return { blocks: [], live };

  // Media hashes come from the bundle, not from a folder on disk: the photo
  // itself never leaves the phone, only its md5.
  Object.entries(live.mediaHashes).forEach(([group, byName]) => {
    mediaHashes[group] = Object.assign(mediaHashes[group] || {}, byName);
  });

  // One group at a time. toBlocks joins consecutive messages from one sender,
  // and the live feed interleaves all seven groups — without the split, a
  // moderator forwarding one listing to six groups would come out as a single
  // block instead of the six copies the dedupe is meant to collapse.
  const byGroup = new Map();
  live.msgs.forEach((m) => {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  });

  const blocks = [];
  for (const [, msgs] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    msgs.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    liveToBlocks(msgs).map((b) => enrichBlock(b, mediaHashes)).forEach((b) => {
      // The text reached us already masked, so there is no number left in it to
      // find. The salted hashes stand in for the numbers: equality is all the
      // dedupe ever asked of them.
      b.phones = [...new Set(b.msgs.flatMap((m) => m.phoneHashes || []))];
      b.live = true;
      b.liveIds = b.msgs.map((m) => m.liveId).filter(Boolean);
      blocks.push(b);
    });
  }
  return { blocks: blocks.filter((b) => b.text.length >= 15 || b.mediaCount > 0), live };
}

// ---------------------------------------------------------------------- main
/**
 * Live-only mode: re-cut the live tail, keep the exported history as it is.
 *
 * The daily build runs on GitHub, where the chat exports do not exist and never
 * will — they are gigabytes of private media and are gitignored. What IS in the
 * repo is the result of the last full run, so the exported listings are treated
 * as settled history and only the collector's days are parsed again. Nothing is
 * lost by it: the exports stopped the day the collector was linked, so the two
 * sources touch at a single seam and never overlap.
 */
function frozenHistory() {
  const file = path.join(OUT_DIR, 'wa-blocks.json');
  if (!fs.existsSync(file)) {
    throw new Error('--live-only needs a previous data/whatsapp/wa-blocks.json to build on');
  }
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    listings: (prev.data || []).filter((l) => !l.live),
    coverage: (prev.coverage || []).filter((c) => c.group !== 'live'),
    source: prev.source,
  };
}

function main() {
  const liveOnly = process.argv.includes('--live-only') || process.env.WA_LIVE_ONLY === '1';
  const mediaHashes = {};   // group -> filename -> md5
  let allBlocks = [];
  let coverage = [];
  let frozen = { listings: [], coverage: [], source: '' };

  if (liveOnly) {
    frozen = frozenHistory();
    coverage = frozen.coverage;
    console.log(`📚 keeping ${frozen.listings.length} listings from the exported history as-is`);
  } else {
    ({ allBlocks, coverage } = parseExports(mediaHashes));
  }

  const { blocks: liveCand, live } = liveBlocks(mediaHashes);
  if (liveCand.length) {
    console.log(`\n⏳ live collector: ${live.msgs.length} msgs over ${live.days.length} day(s) `
      + `${live.from}→${live.to}, ${live.photos} photos → ${liveCand.length} candidates`);
    coverage = coverage.concat([{ source: 'wa-live (collector on the phone)', group: 'live', format: 'live',
      from: live.from, to: live.to, messages: live.msgs.length, candidates: liveCand.length }]);
    allBlocks = allBlocks.concat(liveCand);
  } else if (liveOnly) {
    console.log('ℹ️  no live bundles yet — nothing to add');
  }

  finish({ allBlocks, coverage, live, frozen, liveOnly });
}

function parseExports(mediaHashes) {
  const sources = discoverGroups();
  if (!sources.length) throw new Error(`no chat exports found under ${SOURCE_DIRS.join(', ')}`);

  console.log('⏳ hashing media…');
  const mediaStamps = {};   // group -> "date time" -> [filename]
  sources.forEach((src) => {
    mediaHashes[src.group] = mediaHashes[src.group] || {};
    mediaStamps[src.group] = mediaStamps[src.group] || {};
    let n = 0;
    src.mediaDirs.forEach((dir) => {
      const { byName, byStamp } = hashDir(dir);
      Object.assign(mediaHashes[src.group], byName);
      Object.entries(byStamp).forEach(([k, v]) => {
        mediaStamps[src.group][k] = [...new Set([...(mediaStamps[src.group][k] || []), ...v])];
      });
      n += Object.keys(byName).length;
    });
    console.log(`  group ${src.group}: ${n} media files hashed from ${src.mediaDirs.length} folder(s)`);
  });

  console.log('⏳ parsing chats…');
  let allBlocks = [];
  const coverage = [];
  sources.forEach((src) => {
    mediaHashes[src.group] = mediaHashes[src.group] || {};
    const { msgs, sysLines } = parseChat(src, mediaStamps[src.group]);
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

  return { allBlocks, coverage, sources };
}

function finish({ allBlocks, coverage, live, frozen, liveOnly }) {
  const ann = dropAnnouncements(allBlocks);
  console.log(`\n⏳ dropped ${ann.removed} announcement blocks (${ann.templates} recurring templates)`);
  allBlocks = ann.kept;

  console.log(`⏳ deduplicating ${allBlocks.length} candidate blocks…`);
  // A deletion means the item went — UNLESS it follows the post immediately,
  // which is the moderator fixing a mistyped number: seen today, a number
  // deleted 5 seconds after it was sent and reposted a moment later. A real
  // withdrawal comes minutes or hours later, once someone has collected.
  const CORRECTION_SEC = 120;
  const postedAt = new Map();
  (live.msgs || []).forEach((m) => { if (m.liveId) postedAt.set(m.liveId, m); });
  const corrections = [];
  const deleted = new Map();
  (live.deletions || []).forEach((d) => {
    if (!d.targetId) return;
    const post = postedAt.get(d.targetId);
    const [hh, mm, ss] = (d.time || '00:00:00').split(':').map(Number);
    const after = post && post.date === d.date ? (hh * 3600 + mm * 60 + ss) - post.sec : Infinity;
    if (after >= 0 && after < CORRECTION_SEC) { corrections.push(after); return; }
    deleted.set(d.targetId, d.at);
  });
  if (corrections.length) {
    console.log(`   (${corrections.length} deletion(s) within ${CORRECTION_SEC}s of posting treated as corrections, not deliveries)`);
  }
  const fresh = dedupe(allBlocks, deleted);
  const stats = fresh.stats;
  // In live-only mode the exported listings were never re-cut, so they come
  // through untouched and only the collector's days are new.
  const listings = frozen.listings.concat(fresh.listings)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const inGroups = {};
  listings.forEach((l) => {
    const n = l.seenInGroups.length;
    inGroups[n] = (inGroups[n] || 0) + 1;
  });

  const out = {
    generated: new Date().toISOString(),
    source: [
      coverage.filter((c) => c.group !== 'live').length
        ? `whatsapp exports (${coverage.filter((c) => c.group !== 'live').length} chats)` : null,
      coverage.some((c) => c.group === 'live') ? 'live collector' : null,
    ].filter(Boolean).join(' + '),
    mode: liveOnly ? 'live-only (exported history kept as-is)' : 'full re-parse',
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
    liveFeed: live.days.length ? {
      from: live.from, to: live.to, days: live.days.length,
      messages: live.msgs.length, photos: live.photos,
      listings: listings.filter((l) => l.live).length,
      // listings taken down after the item was handed over — invisible to an export
      withdrawn: listings.filter((l) => l.withdrawnAt).length,
      membershipEvents: live.membership.length,
    } : null,
    data: listings,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'wa-blocks.json'), JSON.stringify(out, null, 1));

  console.log(`\n✅ ${allBlocks.length} blocks → ${listings.length} unique listings`);
  console.log(`   merged by: media ${stats.media}, phone ${stats.phone}, text ${stats.text}, same-moment ${stats.simultaneous}`);
  console.log(`   blacklisted boilerplate hashes: ${stats.blacklistedHashes}`);
  console.log(`   posted in 1 group: ${inGroups[1] || 0} | 2: ${inGroups[2] || 0} | 3+: ${out.spread.postedInThreeOrMore}`);
  console.log(`   clusters needing manual review (a group with two copies): ${out.spread.needsReview}`);
  if (out.liveFeed) {
    console.log(`   live feed: ${out.liveFeed.listings} listings, `
      + `${out.liveFeed.withdrawn} of them withdrawn after delivery`);
  }
  console.log(`📝 data/whatsapp/wa-blocks.json`);
}

// Also used by members.js, which counts the join/leave notices this file skips.
module.exports = { discoverGroups, IOS_HDR, AND_HDR, SENDER_RE, redact, SOURCE_DIRS };

if (require.main === module) main();
