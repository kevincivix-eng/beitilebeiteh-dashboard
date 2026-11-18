#!/usr/bin/env node
/**
 * Turn the collector's raw store into daily bundles the build can read.
 *
 * The store on the phone holds things the site must never see: photo bytes and
 * WhatsApp display names. A bundle is the subset that is safe to publish —
 * redacted text, a content hash per photo, an opaque id per sender — in the
 * shape `build/whatsapp/live-source.js` feeds to the existing parser, so live
 * days and exported days go through exactly the same dedupe and weighing.
 *
 * One file per day, because days are append-only once they are over: only the
 * current day's file changes, which keeps the push small and the history
 * honest. A later deletion still rewrites nothing — it is a separate event.
 *
 * Usage:
 *   node export-bundle.js [--out DIR] [--since YYYY-MM-DD] [--all]
 *
 * By default it writes only days that changed since the last run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = path.resolve(argOf('--out', path.join(store.DIRS.root, 'bundles')));
const SINCE = argOf('--since', '2000-01-01');
const ALL = args.includes('--all');

// The store writes timestamps in UTC, which is unambiguous but is NOT the clock
// the groups live by. Two hours matter here: a listing posted at 01:30 in Rahat
// is 23:30 UTC the day before, and would be counted on the wrong day — and the
// exported chats this data joins are in local time throughout.
const TZ = process.env.WA_TZ || 'Asia/Jerusalem';
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
/** UTC ISO -> { date: 'YYYY-MM-DD', time: 'HH:MM:SS', sec } in the groups' own time. */
function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [date, time] = fmt.format(d).split(' ');
  const [hh, mm, ss] = time.split(':').map(Number);
  return { date, time, sec: hh * 3600 + mm * 60 + ss };
}

/** group-4 -> 4, group-center -> 7 (the branch group is group 7 to the parser). */
const groupNumber = (slug) => {
  if (slug === 'group-center') return 7;
  const m = /^group-(\d+)$/.exec(slug);
  return m ? Number(m[1]) : null;
};

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Everything the store knows, grouped by the day it happened. */
function collect() {
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, messages: [], events: [] });
    return days.get(d);
  };

  const md = store.DIRS.messages;
  if (fs.existsSync(md)) {
    for (const slug of fs.readdirSync(md)) {
      const group = groupNumber(slug);
      if (group === null) continue;
      for (const f of fs.readdirSync(path.join(md, slug))) {
        if (!f.endsWith('.jsonl')) continue;
        for (const r of readJsonl(path.join(md, slug, f))) {
          // The file is named after the UTC day; the local day can differ, so
          // the record's own timestamp decides which bundle it belongs to.
          const st = localStamp(r.at);
          if (!st || st.date < SINCE) continue;
          const { date } = st;
          day(date).messages.push({
            id: r.id,
            group,
            time: st.time,
            sec: st.sec,
            // an opaque, stable id: enough to tell one moderator's burst of
            // forwards from another's, without carrying anybody's name
            sender: `m:${(r.senderHash || 'unknown').slice(0, 10)}`,
            text: r.text || '',
            // content hashes only — the photo itself stays on the phone
            media: (r.media || []).filter((m) => m.sha256)
              .map((m) => ({ sha256: m.sha256, md5: m.md5, kind: m.kind })),
            // a photo we could not download is still evidence something was shown
            mediaFailed: (r.media || []).filter((m) => m.error).length,
            phoneHashes: r.phoneHashes || [],
          });
        }
      }
    }
  }

  const ed = store.DIRS.events;
  if (fs.existsSync(ed)) {
    for (const f of fs.readdirSync(ed)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const r of readJsonl(path.join(ed, f))) {
        const st = localStamp(r.at);
        if (!st || st.date < SINCE) continue;
        const group = groupNumber(r.group);
        day(st.date).events.push({
          type: r.type,
          group,
          at: r.at,
          time: st.time,
          ...(r.targetId ? { targetId: r.targetId } : {}),
          ...(r.count ? { count: r.count } : {}),
          // who joined or left, as opaque ids: six joins by one woman are not six women
          ...(r.whoHashes ? { whoHashes: r.whoHashes } : {}),
        });
      }
    }
  }

  for (const d of days.values()) d.messages.sort((a, b) => a.sec - b.sec || a.group - b.group);
  return days;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const days = collect();
  if (!days.size) { console.log('nothing in the store yet'); return; }

  let written = 0;
  let skipped = 0;
  for (const [date, d] of [...days.entries()].sort()) {
    const body = {
      date,
      source: 'wa-live',
      tz: TZ,
      messages: d.messages,
      events: d.events,
    };
    const json = JSON.stringify(body, null, 1);
    const file = path.join(OUT, `${date}.json`);
    // A finished day never changes, so skipping identical files keeps the push
    // to the one day that actually moved.
    if (!ALL && fs.existsSync(file)) {
      const old = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (old === crypto.createHash('sha256').update(json).digest('hex')) { skipped++; continue; }
    }
    fs.writeFileSync(file, json);
    written++;
    const photos = d.messages.reduce((n, m) => n + m.media.length, 0);
    const dels = d.events.filter((e) => e.type === 'message-deleted').length;
    console.log(`  ${date}: ${d.messages.length} messages · ${photos} photos · ${dels} deletions · ${d.events.length - dels} membership`);
  }
  console.log(`\n✅ ${written} day file(s) written${skipped ? `, ${skipped} unchanged` : ''} → ${OUT}`);
}

module.exports = { collect, groupNumber };
if (require.main === module) main();
