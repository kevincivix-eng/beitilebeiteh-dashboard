#!/usr/bin/env node
/**
 * Stage 2 — turn deduplicated listing blocks into structured records:
 *   { date, city (Hebrew), items: [{ nameHe, qty }], reserved, ... }
 *
 * City resolution is fully deterministic (regex map + inheritance).
 * Item extraction is lexicon-driven: build/whatsapp/lexicon.json maps Arabic
 * phrases to Hebrew item names. Anything the lexicon cannot resolve is written
 * to data/experimental/wa-unresolved.json for an LLM pass, whose results are
 * folded back into the lexicon — so re-runs stay deterministic and cheap.
 *
 * Usage: node build/whatsapp/extract.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXP = path.join(ROOT, 'data', 'experimental');

const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf8')).map
  .map((c) => ({ he: c.he, res: c.patterns.map((p) => new RegExp(p, 'i')) }));

const lexPath = path.join(__dirname, 'lexicon.json');
const lexicon = fs.existsSync(lexPath) ? JSON.parse(fs.readFileSync(lexPath, 'utf8')) : { entries: [] };

// Items identified from the listing photos. Roughly 38% of listings are a photo
// with only a city/phone in the caption — the text says nothing about the goods,
// so the picture is the only evidence of what was actually passed on.
const visPath = path.join(__dirname, 'vision-results.json');
const vision = fs.existsSync(visPath) ? JSON.parse(fs.readFileSync(visPath, 'utf8')).results : {};

// Compile lexicon entries once. Each entry: { ar: "regex", he: "שם עברי", qty: 1 }
//
// Arabic word boundaries need care in both directions:
//  - a bare boundary lets "مهد" (cradle) match inside the name "مهدي"
//  - a strict boundary misses the clitics that attach to almost every noun:
//    و/ال prefixes ("واحذية" = and-shoes) and ها/هن suffixes ("كراسيها" = her chairs)
// So: allow a known prefix and a known suffix, but nothing else.
const AR_LETTER = '\\u0621-\\u064A';
const PREFIX = '(?:و|ف|ب|ل|ك|ال|وال|بال|فال|لل|بال)?';
const SUFFIX = '(?:ها|هن|هم|ات|ين|كن|نا)?';
const lexRules = (lexicon.entries || []).map((e) => ({
  re: new RegExp(`(?<![${AR_LETTER}])${PREFIX}(?:${e.ar})${SUFFIX}(?![${AR_LETTER}])`, 'i'),
  he: e.he, qty: e.qty || 1, cat: e.cat || null,
}));

const CITY_INHERIT_MIN = 30 * 60; // seconds: reuse a nearby listing's city
const toSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };

/**
 * Normalize Arabic orthography before matching. The chats are dialectal and
 * inconsistently spelled — أواعى vs أواعي, فرشة vs فرشه — which was the single
 * biggest cause of missed items. Lexicon patterns are written in normalized
 * form (ي, ه, ا) and both sides go through this.
 */
function normalizeAr(s) {
  return s
    .replace(/[ً-ٰٟـ]/g, '') // diacritics + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

function detectCity(text) {
  const t = normalizeAr(text);
  for (const c of cities) {
    for (const re of c.res) if (re.test(t)) return c.he;
  }
  return null;
}

/**
 * Arabic quantity words/numerals that commonly precede an item.
 * Returns a multiplier when the text states an explicit count.
 */
const AR_NUM = {
  'وحده': 1, 'واحد': 1, 'واحده': 1, 'ثنتين': 2, 'اثنين': 2, 'تنتين': 2,
  'ثلاث': 3, 'ثلاثه': 3, 'تلات': 3, 'اربع': 4, 'اربعه': 4, 'خمس': 5,
  'خمسه': 5, 'ست': 6, 'سته': 6, 'سبع': 7, 'ثمان': 8, 'تسع': 9, 'عشر': 10,
};

// Words that mean the number next to them is a SIZE or an AGE, never a count:
// "عبايات 48 42 46" is three abayas in sizes 48/42/46 — reading 46 as the
// quantity produced half-tonne listings. Sizes also appear bare, so plain
// numbers are only trusted when small.
const SIZE_MARKER = /(نمره|نمرة|نمر|رقم|مقاس|قياس|جيل|عمر|سن|صف|شهر|سنه|سنين|اشهر|كيلو|متر|سم)/;
const MAX_TEXT_QTY = 12; // a caption claiming more than a dozen is almost always a size list

function quantityNear(text, idx) {
  const before = text.slice(Math.max(0, idx - 20), idx);
  // an explicit size/age word anywhere close by disqualifies the number
  if (SIZE_MARKER.test(before)) return 1;
  const digit = before.match(/(\d{1,2})\s*$/);
  if (digit) {
    const n = Number(digit[1]);
    // Sizes cluster in the 20s-50s (clothes/shoes); counts are small.
    if (n > 0 && n <= MAX_TEXT_QTY) return n;
    return 1;
  }
  for (const [w, n] of Object.entries(AR_NUM)) if (new RegExp(w + '\\s*$').test(before)) return n;
  return 1;
}

/**
 * Rules run in lexicon order and CONSUME the text they match, so a specific
 * rule ("سرير اطفال" → מיטת תינוק) prevents a later generic one ("سرير" →
 * מיטה) from double-counting the same words.
 */
function extractItems(rawText) {
  const found = [];
  const seen = new Set();
  let work = normalizeAr(rawText);
  lexRules.forEach((r) => {
    const m = r.re.exec(work);
    if (!m) return;
    const qty = r.qty * quantityNear(work, m.index);
    // blank out the matched span so later, broader rules can't re-match it
    work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
    if (seen.has(r.he)) return;
    seen.add(r.he);
    found.push({ nameHe: r.he, qty, matched: m[0] });
  });
  return found;
}

function main() {
  const src = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-blocks.json'), 'utf8'));
  const blocks = src.data;

  // ---- city: direct detection, then inherit from a nearby post by the same
  // moderator (they often send the photo, then the city in the next message).
  const listings = blocks.map((b) => ({ ...b, city: detectCity(b.text) }));
  let inherited = 0;
  for (let i = 0; i < listings.length; i++) {
    if (listings[i].city) continue;
    for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
      const a = listings[i]; const p = listings[j];
      if (!p.city || p.sender !== a.sender || p.date !== a.date) continue;
      if (Math.abs(toSec(a.time) - toSec(p.time)) > CITY_INHERIT_MIN) break;
      a.city = p.city; a.cityInherited = true; inherited++;
      break;
    }
  }

  // ---- items via lexicon + listing classification
  //
  // Not every block is an item offer. The chats also carry coordination
  // ("send her a private message"), group rules, greetings and reservation
  // notices ("all reserved, stop sending"). Counting those as deliveries would
  // inflate every KPI. The reliable signal is MEDIA: items get photographed.
  // A text-only block only counts when it names an item AND a city and is not
  // merely announcing that something was already taken.
  const RESERVE_ONLY = /^[\s\W]*(انحجز|انحجزن|انحجزو|انحجزت|احتجز)/;
  // Group rules / thank-you posts enumerate example item types ("books, TV,
  // carpets…") and would otherwise be mined for phantom items. A genuine offer
  // is photographed, so these only count when media is attached.
  const ANNOUNCEMENT = /قواعد|قوانين|وقت ننشر|اهلا وسهلا بالصبايا|المشرفات|تعليمات|ممنوع النشر|مساحه للنساء|بنذكركن|نذكركن/;
  const isListing = (l, items) => {
    const t = normalizeAr(l.text);
    if (ANNOUNCEMENT.test(t) && l.mediaCount === 0) return false;
    if (l.mediaCount > 0) return true;
    if (items.length === 0) return false;
    if (!l.city) return false;
    if (RESERVE_ONLY.test(t)) return false;
    return true;
  };

  let fromVision = 0; let visionNotItem = 0;
  const out = listings.map((l) => {
    // Prose that enumerates example item types must not be mined for items,
    // even when a photo is attached — the words describe the initiative, not
    // the goods on offer. Such a post still counts as a delivery if it has
    // media, but its item stays unidentified rather than invented.
    let items = ANNOUNCEMENT.test(normalizeAr(l.text)) ? [] : extractItems(l.text);

    // Fall back to what the photo shows when the caption named nothing.
    const v = vision[l.id];
    let visionUsed = false;
    if (!items.length && v) {
      if (v.notAnItem) { l.notAnItem = true; visionNotItem++; }
      else if (v.items && v.items.length) {
        items = v.items.map((i) => ({ ...i, source: 'vision' }));
        visionUsed = true; fromVision++;
      }
    }
    return {
      id: l.id,
      date: l.date,
      time: l.time,
      city: l.city || 'אחר',
      cityInherited: !!l.cityInherited,
      cityResolved: !!l.city,
      items,
      unidentified: items.length === 0,
      itemSource: visionUsed ? 'vision' : (items.length ? 'text' : null),
      // a promo graphic / pet photo / group photo is not an item offer at all
      isListing: l.notAnItem ? false : isListing(l, items),
      reserved: l.reserved,
      sender: l.sender,
      seenInGroups: l.seenInGroups,
      mergedBy: l.mergedBy,
      blockCount: l.blockCount,
      needsReview: l.needsReview,
      mediaCount: l.mediaCount,
      rawText: l.text,
    };
  });

  const real = out.filter((l) => l.isListing);
  const resolvedCity = real.filter((l) => l.cityResolved).length;
  const withItems = real.filter((l) => !l.unidentified).length;
  const unresolved = real.filter((l) => l.unidentified);

  fs.writeFileSync(path.join(EXP, 'wa-listings.json'), JSON.stringify({
    generated: new Date().toISOString(),
    blocks: out.length,
    listings: real.length,
    nonListings: out.length - real.length,
    cityResolved: resolvedCity,
    cityInherited: inherited,
    itemsResolved: withItems,
    unidentified: unresolved.length,
    lexiconEntries: lexRules.length,
    data: out,
  }, null, 1));

  // Unresolved listings, compacted for an LLM extraction pass
  fs.writeFileSync(path.join(EXP, 'wa-unresolved.json'), JSON.stringify({
    generated: new Date().toISOString(),
    count: unresolved.length,
    note: 'Listings the lexicon could not resolve to an item. Feed to the LLM pass; fold results back into build/whatsapp/lexicon.json.',
    data: unresolved.map((l) => ({ id: l.id, date: l.date, city: l.city, text: l.rawText.slice(0, 300) })),
  }, null, 1));

  const pct = (n) => Math.round((n / real.length) * 100);
  console.log(`✅ ${out.length} blocks → ${real.length} item listings (${out.length - real.length} non-listings excluded)`);
  console.log(`   city resolved: ${resolvedCity} (${pct(resolvedCity)}%) — of which inherited: ${inherited}`);
  console.log(`   items resolved: ${withItems} (${pct(withItems)}%)`);
  console.log(`      from caption text: ${withItems - fromVision} (${lexRules.length} lexicon rules)`);
  console.log(`      from photo (vision): ${fromVision}`);
  console.log(`   excluded as not-an-item by vision: ${visionNotItem}`);
  console.log(`   still unidentified: ${unresolved.length} (${pct(unresolved.length)}%)`);
  console.log('📝 data/experimental/wa-listings.json + wa-unresolved.json');
}

main();
