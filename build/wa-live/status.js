#!/usr/bin/env node
/**
 * What has the collector actually caught? Run it any time; it only reads.
 *
 * The headline number is how long ago the collector last said anything. A
 * silent collector looks exactly like a quiet day in the groups, so the
 * heartbeat — not the message count — is what tells you it is still alive.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const countLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

const state = store.readState();
console.log(`\n📂 ${store.DIRS.root}`);
console.log(`💓 last heartbeat: ${ago(state.alive)}${state.alive ? ` (${state.alive.slice(0, 19).replace('T', ' ')})` : ''}`);
if (state.lastDisconnect) console.log(`🔌 last disconnect: ${ago(state.lastDisconnect)} (code ${state.lastDisconnectCode})`);
if (state.groups) console.log(`👥 groups: ${state.groups.join(', ')}`);
if (state.counters) {
  const c = state.counters;
  console.log(`📊 since this run started: ${c.messages} messages · ${c.media} media · ${c.deleted} deletions · +${c.joined}/-${c.left} members`);
}

const days = {};
const msgDir = store.DIRS.messages;
if (fs.existsSync(msgDir)) {
  for (const group of fs.readdirSync(msgDir)) {
    for (const f of fs.readdirSync(path.join(msgDir, group))) {
      if (!f.endsWith('.jsonl')) continue;
      const d = f.replace('.jsonl', '');
      (days[d] = days[d] || {})[group] = countLines(path.join(msgDir, group, f));
    }
  }
}
const sorted = Object.keys(days).sort();
if (!sorted.length) { console.log('\n(nothing captured yet)\n'); process.exit(0); }

console.log('\nday         messages  groups');
sorted.slice(-10).forEach((d) => {
  const g = days[d];
  const total = Object.values(g).reduce((a, b) => a + b, 0);
  console.log(`${d}  ${String(total).padStart(8)}  ${Object.keys(g).sort().join(' ')}`);
});

const evDir = store.DIRS.events;
const evFiles = fs.existsSync(evDir) ? fs.readdirSync(evDir).filter((f) => f.endsWith('.jsonl')).sort() : [];
const ev = { deleted: 0, joined: 0, left: 0 };
for (const f of evFiles) {
  for (const line of fs.readFileSync(path.join(evDir, f), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.type === 'message-deleted') ev.deleted++;
    else if (r.type === 'joined') ev.joined += r.count || 1;
    else if (r.type === 'left') ev.left += r.count || 1;
  }
}
const media = fs.existsSync(store.DIRS.media) ? fs.readdirSync(store.DIRS.media).length : 0;
console.log(`\n🗑  deletions caught after the post was already saved: ${ev.deleted}`);
console.log(`👤 membership events on record: +${ev.joined} / -${ev.left}`);
console.log(`🖼  media files stored: ${media}\n`);
