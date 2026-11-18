/**
 * Append-only store for the live collector.
 *
 * Everything here is written ONCE and never rewritten. That is the whole point:
 * in these groups a listing is routinely deleted the moment the item is taken,
 * so whatever we hold at the instant of capture is all we will ever have. A
 * later deletion is recorded as its own event next to the original, so the
 * record says "this was posted, and then withdrawn" instead of losing the post.
 *
 * Nothing here is inside the repo's published data/ directory — these files
 * carry raw text and media and must never reach GitHub Pages.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.WA_DATA_DIR || path.join(require('os').homedir(), 'wa-live-data');
const DIRS = {
  root: ROOT,
  messages: path.join(ROOT, 'messages'),
  events: path.join(ROOT, 'events'),
  media: path.join(ROOT, 'media'),
  auth: path.join(ROOT, 'auth'),
};

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

/** Stable per-install salt: lets equal numbers hash equal (for dedupe) without storing any number. */
const SALT_FILE = path.join(ROOT, '.phone-salt');
if (!fs.existsSync(SALT_FILE)) fs.writeFileSync(SALT_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SALT = fs.readFileSync(SALT_FILE, 'utf8').trim();

const hashPhone = (digits) => crypto.createHash('sha256').update(SALT + digits).digest('hex').slice(0, 16);

// Israeli mobile numbers, written every way donors write them. Same detector as
// the export pipeline: pull a run of digits, decide on the digits alone.
const DIGIT = '[0-9\\u0660-\\u0669]';
const SEP = '[\\s\\u00a0.\\-\\u2010-\\u2015\\u200e\\u200f\\u202a-\\u202e]*';
// No separator before the first digit: letting it eat the leading space glued
// the previous word to the marker and broke the word tokens the dedupe compares.
const PHONE_RE = new RegExp(`\\+?${DIGIT}(?:${SEP}${DIGIT}){7,14}`, 'g');
const MOBILE_RE = /^(?:972)?0?5\d{8}$/;
const asciiDigits = (s) => s.replace(/[٠-٩]/g,
  (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48)).replace(/\D/g, '');

/** Replace every phone number with a marker, and return the hashes separately. */
function redact(text) {
  const hashes = [];
  const clean = (text || '').replace(PHONE_RE, (m) => {
    const d = asciiDigits(m);
    if (!MOBILE_RE.test(d)) return m;
    hashes.push(hashPhone('0' + d.replace(/^972/, '').replace(/^0/, '')));
    return '[טלפון]';
  });
  return { text: clean, phoneHashes: [...new Set(hashes)] };
}

const appendLine = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
};

const dayFile = (dir, group, date) => path.join(dir, group, `${date}.jsonl`);

/** One message, exactly as it looked when it arrived. */
function writeMessage(group, rec) {
  appendLine(dayFile(DIRS.messages, group, rec.date), rec);
}

/** Deletions, edits, joins, leaves — anything that happens TO the record. */
function writeEvent(rec) {
  appendLine(path.join(DIRS.events, `${rec.date}.jsonl`), rec);
}

/** Media is content-addressed, so the same photo forwarded to six groups is stored once. */
function writeMedia(buffer, ext) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const file = path.join(DIRS.media, `${sha}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return { sha256: sha, md5: crypto.createHash('md5').update(buffer).digest('hex'), file, bytes: buffer.length };
}

/** Small heartbeat so a stuck collector is visible instead of silently dead. */
function writeState(patch) {
  const file = path.join(ROOT, 'state.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...patch, updated: new Date().toISOString() }, null, 1));
}

const readState = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8')); } catch { return {}; }
};

module.exports = { DIRS, redact, hashPhone, writeMessage, writeEvent, writeMedia, writeState, readState };
