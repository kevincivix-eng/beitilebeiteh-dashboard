#!/usr/bin/env node
/**
 * Count group membership from the chat exports — the WhatsApp notices that
 * parse.js deliberately throws away ("X הצטרף/ה לקבוצה", "Y יצא/ה").
 *
 * Why this file exists: the member numbers on the dashboard come from a
 * SharePoint spreadsheet that is maintained by hand. The chats carry the same
 * events, so counting them here removes that manual step.
 *
 * THE ONE THING TO KNOW: an export only holds the membership events that
 * happened while THAT phone was in THAT group. Export from a phone added last
 * month and you get last month's events plus one aggregated summary line for
 * everything before it ("A, B ו-137 נוספים יצא/ה") — a lump with no dates.
 * So a per-day series is only honest inside each chat's own coverage window,
 * which is why every output row carries the groups it was actually counted
 * from, and the aggregated lumps are reported separately instead of being
 * spread over days they did not happen on.
 *
 * Usage: node build/whatsapp/members.js
 */
const fs = require('fs');
const path = require('path');
const { discoverGroups, IOS_HDR, AND_HDR } = require('./parse.js');
const { loadLive } = require('./live-source');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'whatsapp');

const SINCE_LIVE = '2025-05-01';

const stripMarks = (s) => s.replace(/[‎‏‪-‮]/g, '');

// Hebrew export wording. Each event is counted once: "X צירף/ה את Y" and
// "Y צורף/ה" are the same kind of event reported from two sides, and WhatsApp
// writes only one of them per actual join.
const EVENTS = [
  { kind: 'joined', re: /הצטרף\/ה לקבוצה/ },
  { kind: 'joined', re: /צירף\/ה את|הוסיף\/ה את|צירפת את/ },
  { kind: 'joined', re: /צורף\/ה(?! את)|צורפת(?! על ידי)/ },
  { kind: 'left', re: /יצא\/ה/ },
  { kind: 'left', re: /הסיר\/ה את|הוסר\/ה|הסרת את/ },
];

// "A, B ו-137 נוספים יצא/ה" — WhatsApp collapses everything that happened
// before this phone could see it into one line. The count is real; the dates
// are not, so these are kept apart from the daily series.
const LUMP_RE = /ו־?-?\s*‏?(\d+)\s*(?:אנשים\s*)?נוספים/;
// The same collapsing happens for additions, but there WhatsApp spells out
// every name instead of giving a count: "A, B, … ו-Z צורפו".
const LUMP_LIST_RE = /צורפו\s*$/;
const namedInLump = (t) => t.split(',').filter((x) => x.trim()).length;

function classify(text) {
  const t = stripMarks(text);
  if (LUMP_LIST_RE.test(t)) return 'joined';
  for (const e of EVENTS) if (e.re.test(t)) return e.kind;
  return null;
}

/**
 * Membership straight from the collector.
 *
 * The exports could only ever report what happened while the exporting phone
 * was already in the group, which is why everything older arrives as one
 * undated lump ("ועוד 137 יצאו"). The collector has no such blind spot: it is
 * in all seven groups continuously, so every join and leave is a dated event
 * with the group it happened in.
 */
function liveDays(since) {
  const live = loadLive(since);
  const perDay = new Map();
  for (const e of live.membership) {
    if (e.type !== 'joined' && e.type !== 'left') continue;
    const d = perDay.get(e.date) || { joined: 0, left: 0, groups: new Set() };
    d[e.type] += e.count || (e.whoHashes || []).length || 1;
    if (e.group) d.groups.add(e.group);
    perDay.set(e.date, d);
  }
  return perDay;
}

function main() {
  const liveOnly = process.argv.includes('--live-only') || process.env.WA_LIVE_ONLY === '1';
  if (liveOnly) return mainLiveOnly();

  const chats = discoverGroups();
  if (!chats.length) throw new Error('no chat exports found');

  const perDay = new Map();   // date -> { joined, left, groups:Set }
  const lumps = [];
  const coverage = [];

  chats.forEach((src) => {
    const HDR = src.format === 'ios' ? IOS_HDR : AND_HDR;
    const seen = { joined: 0, left: 0 };
    let first = null; let last = null;
    let cur = null;

    const flush = () => {
      if (!cur) return;
      const kind = classify(cur.text);
      if (kind) {
        const t = stripMarks(cur.text);
        const lump = t.match(LUMP_RE);
        const lumpList = LUMP_LIST_RE.test(t);
        if (lump || lumpList) {
          // a summary of events from before this phone joined the group
          lumps.push({ group: src.group, source: src.label, date: cur.date, kind,
            people: lump ? Number(lump[1]) + namedInLump(cur.text) : namedInLump(cur.text) });
        } else {
          const d = perDay.get(cur.date) || { joined: 0, left: 0, groups: new Set() };
          d[kind]++; d.groups.add(src.group);
          perDay.set(cur.date, d);
          seen[kind]++;
        }
      }
      cur = null;
    };

    fs.readFileSync(src.chat, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = HDR.exec(line);
      if (m) {
        flush();
        const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        if (!first || date < first) first = date;
        if (!last || date > last) last = date;
        cur = { date, text: src.format === 'ios' ? m[7] : m[6] };
      } else if (cur) {
        cur.text += ' ' + line;
      }
    });
    flush();

    coverage.push({ source: src.label, group: src.group, from: first, to: last, ...seen });
    console.log(`  ${src.label.padEnd(26)} ${first}→${last}  joined ${String(seen.joined).padStart(5)}  left ${String(seen.left).padStart(5)}`);
  });

  // The collector's days extend the same map — they are the same events,
  // counted from a feed that does not have the exports' blind spot.
  const lastExport = [...perDay.keys()].sort().pop() || '0000-00-00';
  const fromLive = liveDays(SINCE_LIVE);
  let liveAdded = 0;
  for (const [date, d] of fromLive) {
    if (date <= lastExport) continue;   // the exports already covered that day
    perDay.set(date, { ...d, live: true });
    liveAdded++;
  }
  if (liveAdded) console.log(`  wa-live (collector)         ${liveAdded} day(s) after ${lastExport}`);

  // Daily series. "cumulative" is the running total of joins — the number the
  // dashboard shows — and intentionally ignores leavers.
  const days = [...perDay.keys()].sort();
  let cum = 0;
  const series = days.map((date) => {
    const d = perDay.get(date);
    cum += d.joined;
    return { date, joined: d.joined, left: d.left, cumulative: cum,
      groups: [...d.groups].sort((a, b) => a - b), ...(d.live ? { live: true } : {}) };
  });

  const totals = series.reduce((a, r) => ({ joined: a.joined + r.joined, left: a.left + r.left }), { joined: 0, left: 0 });
  const lumpJoined = lumps.filter((l) => l.kind === 'joined').reduce((a, l) => a + l.people, 0);
  const lumpLeft = lumps.filter((l) => l.kind === 'left').reduce((a, l) => a + l.people, 0);

  fs.writeFileSync(path.join(OUT_DIR, 'members.json'), JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Counted from the chat exports. Only covers days inside each chat\'s own window — see coverage.',
    totals: { ...totals, undatedJoined: lumpJoined, undatedLeft: lumpLeft },
    coverage,
    undated: lumps,
    data: series,
  }, null, 1));

  console.log(`\n✅ ${series.length} days with membership events`);
  console.log(`   joined ${totals.joined} | left ${totals.left} | cumulative joins ${cum}`);
  console.log(`   undated lumps (events from before a phone joined): +${lumpJoined} joined, ${lumpLeft} left`);
  console.log('📝 data/whatsapp/members.json');
}

/**
 * What the daily build runs. The exports are not on the build machine, so the
 * counted days already in members.json are kept exactly as they are and only
 * the collector's days are recomputed — the same frozen-history-plus-live-tail
 * split the listings use.
 */
function mainLiveOnly() {
  const file = path.join(OUT_DIR, 'members.json');
  if (!fs.existsSync(file)) throw new Error('--live-only needs an existing data/whatsapp/members.json');
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));

  const kept = (prev.data || []).filter((r) => !r.live);
  const lastExport = kept.length ? kept[kept.length - 1].date : '0000-00-00';
  let cum = kept.length ? kept[kept.length - 1].cumulative : 0;

  const added = [...liveDays(SINCE_LIVE).entries()]
    .filter(([date]) => date > lastExport)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => {
      cum += d.joined;
      return { date, joined: d.joined, left: d.left, cumulative: cum,
        groups: [...d.groups].sort((a, b) => a - b), live: true };
    });

  const series = kept.concat(added);
  const totals = series.reduce((a, r) => ({ joined: a.joined + r.joined, left: a.left + r.left }), { joined: 0, left: 0 });

  fs.writeFileSync(file, JSON.stringify({
    ...prev,
    generated: new Date().toISOString(),
    totals: { ...prev.totals, ...totals },
    data: series,
  }, null, 1));

  console.log(`✅ kept ${kept.length} counted days, added ${added.length} from the collector`);
  console.log(`   cumulative joins ${cum}`);
  console.log('📝 data/whatsapp/members.json');
}

main();
