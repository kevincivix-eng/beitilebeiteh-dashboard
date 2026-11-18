#!/usr/bin/env node
/**
 * Live collector — reads the initiative's WhatsApp groups as they happen.
 *
 * WHY THIS EXISTS: the weekly "export chat" route loses data by design.
 * Moderators delete a listing once the item is taken, so an export taken days
 * later is missing exactly the deliveries we are trying to count, and an
 * export with media only reaches back about a thousand messages. Here the
 * message and its photos are written to disk within a second of arriving, and
 * a later deletion is recorded as a separate event — the post itself is never
 * removed or rewritten.
 *
 * It connects as a LINKED DEVICE of the number already in the groups (the same
 * mechanism as WhatsApp Web), so it reads and never sends.
 *
 * Usage:
 *   node collector.js                      # shows a QR to scan from the phone
 *   WA_PAIR=9725XXXXXXXX node collector.js # prints an 8-character code instead
 *   WA_DATA_DIR=~/wa-data node collector.js
 *
 * The pairing code matters when the collector runs ON the phone whose account
 * it links: a QR shown on that screen cannot be scanned by that same screen.
 * Enter the code in WhatsApp -> Linked devices -> Link with phone number.
 */
const path = require('path');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  downloadMediaMessage, fetchLatestBaileysVersion, getContentType,
  normalizeMessageContent, isJidGroup, proto,
} = require('baileys');

const store = require('./store');

// Which groups to follow. Every group of the initiative is named "…من بيتي لبيتك…",
// so new groups are picked up without touching this file.
const GROUP_RE = new RegExp(process.env.WA_GROUP_RE || 'من بيتي لبيتك');

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(ts(), ...a);

const MEDIA_TYPES = {
  imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg',
  documentMessage: 'bin', stickerMessage: 'webp',
};

/** The groups we follow, resolved at connect time: jid -> { name, slug }. */
const groups = new Map();
let pairingAsked = false;
const counters = { messages: 0, media: 0, deleted: 0, joined: 0, left: 0 };

const slugFor = (name) => {
  // The group names differ only by a leading keycap digit (1️⃣…6️⃣); that digit
  // is the stable identity, and it survives a rename of the rest of the name.
  const m = name.match(/([1-9])️?⃣/);
  if (m) return `group-${m[1]}`;
  if (/المركز/.test(name)) return 'group-center';
  return 'group-' + name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 24).toLowerCase();
};

const dateOf = (unixSeconds) => new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);

/** Pull whatever text the message carries, whatever shape it came in. */
function textOf(msg) {
  const m = normalizeMessageContent(msg) || {};
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || '';
}

async function captureMedia(sock, waMsg, kind) {
  try {
    const buf = await downloadMediaMessage(waMsg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage });
    const saved = store.writeMedia(buf, MEDIA_TYPES[kind] || 'bin');
    counters.media++;
    return { kind, sha256: saved.sha256, md5: saved.md5, bytes: saved.bytes };
  } catch (err) {
    // A photo deleted before we reached it is the one case we cannot win; record
    // the attempt so the gap is visible rather than looking like a text-only post.
    log('⚠️  media download failed:', err.message);
    return { kind, error: String(err.message || err).slice(0, 120) };
  }
}

async function onMessage(sock, waMsg, upsertType) {
  const jid = waMsg.key?.remoteJid;
  if (!jid || !isJidGroup(jid) || !groups.has(jid)) return;
  const content = normalizeMessageContent(waMsg.message);
  if (!content) return;

  const group = groups.get(jid).slug;
  const stamp = Number(waMsg.messageTimestamp || 0) || Math.floor(Date.now() / 1000);
  const date = dateOf(stamp);

  // A deletion arrives as a message of its own, pointing at the one to remove.
  const protocolMsg = content.protocolMessage;
  if (protocolMsg?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
    counters.deleted++;
    store.writeEvent({
      type: 'message-deleted', date, at: new Date(stamp * 1000).toISOString(),
      group, targetId: protocolMsg.key?.id || null,
      by: waMsg.key?.participant ? store.hashPhone(waMsg.key.participant.split('@')[0]) : null,
    });
    log(`🗑  deletion in ${group} (the post itself is kept)`);
    return;
  }
  if (protocolMsg) return; // key shares, ephemeral settings — not content

  const kind = getContentType(content);
  const media = MEDIA_TYPES[kind] ? [await captureMedia(sock, waMsg, kind)] : [];
  const { text, phoneHashes } = store.redact(textOf(waMsg.message));
  const sender = waMsg.key?.participant || waMsg.participant || jid;

  store.writeMessage(group, {
    id: waMsg.key?.id,
    date,
    at: new Date(stamp * 1000).toISOString(),
    group,
    // the sender identifies a moderator across groups for the dedupe; the number
    // itself is never written
    senderHash: store.hashPhone(sender.split('@')[0].split(':')[0]),
    senderName: waMsg.pushName || null,
    kind,
    text,
    phoneHashes,
    media,
    live: upsertType === 'notify',
  });
  counters.messages++;
  if (counters.messages % 25 === 0) heartbeat();
}

function onParticipants({ id, participants, action, author }) {
  if (!groups.has(id)) return;
  const group = groups.get(id).slug;
  const date = new Date().toISOString().slice(0, 10);
  const joined = action === 'add' || action === 'invite';
  const left = action === 'remove' || action === 'leave';
  if (!joined && !left) return;              // promote/demote are not membership
  if (joined) counters.joined += participants.length; else counters.left += participants.length;
  store.writeEvent({
    type: joined ? 'joined' : 'left',
    date, at: new Date().toISOString(), group, action,
    count: participants.length,
    // who, as an opaque id — enough to tell one woman's six joins apart from six women
    whoHashes: participants.map((p) => store.hashPhone(p.split('@')[0].split(':')[0])),
    byHash: author ? store.hashPhone(author.split('@')[0].split(':')[0]) : null,
  });
  log(`${joined ? '➕' : '➖'} ${group}: ${participants.length} ${joined ? 'joined' : 'left'}`);
}

function heartbeat(extra = {}) {
  store.writeState({
    alive: new Date().toISOString(),
    groups: [...groups.values()].map((g) => g.slug).sort(),
    counters: { ...counters },
    ...extra,
  });
}

async function refreshGroups(sock) {
  const all = await sock.groupFetchAllParticipating();
  groups.clear();
  for (const [jid, meta] of Object.entries(all)) {
    if (!GROUP_RE.test(meta.subject || '')) continue;
    groups.set(jid, { name: meta.subject, slug: slugFor(meta.subject) });
  }
  log(`👥 following ${groups.size} groups: ${[...groups.values()].map((g) => g.slug).join(', ')}`);
  heartbeat();
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(store.DIRS.auth);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // Read-only presence: never mark the groups as read, never appear online.
    markOnlineOnConnect: false,
    // We keep our own history; asking for WhatsApp's would flood the first run.
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing by code instead of by QR. Must be asked for after the socket opens
  // its connection but before it is registered, and only once.
  if (process.env.WA_PAIR && !state.creds.registered && !pairingAsked) {
    pairingAsked = true;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(process.env.WA_PAIR.replace(/\D/g, ''));
        console.log(`\n🔑 Pairing code: ${code.match(/.{1,4}/g).join('-')}`);
        console.log('   WhatsApp -> Settings -> Linked devices -> Link a device');
        console.log('   -> "Link with phone number instead" -> type this code\n');
      } catch (err) {
        log('⚠️  could not request a pairing code:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !process.env.WA_PAIR) {
      console.log('\n📱 Scan this from the phone: WhatsApp → Settings → Linked devices → Link a device\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      log('✅ connected');
      await refreshGroups(sock);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      heartbeat({ lastDisconnect: new Date().toISOString(), lastDisconnectCode: code || null });
      if (loggedOut) {
        log('⛔ logged out on the phone — delete the auth folder and scan again');
        process.exit(1);
      }
      log(`🔌 disconnected (${code}) — reconnecting in 5s`);
      setTimeout(start, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      try { await onMessage(sock, m, type); } catch (err) { log('⚠️  message failed:', err.message); }
    }
  });

  // Belt and braces: some deletions surface here rather than as a revoke message.
  sock.ev.on('messages.delete', (item) => {
    const keys = item.keys || [];
    for (const k of keys) {
      if (!groups.has(k.remoteJid)) continue;
      counters.deleted++;
      store.writeEvent({
        type: 'message-deleted', date: new Date().toISOString().slice(0, 10),
        at: new Date().toISOString(), group: groups.get(k.remoteJid).slug, targetId: k.id, via: 'delete-event',
      });
    }
  });

  sock.ev.on('group-participants.update', (u) => {
    try { onParticipants(u); } catch (err) { log('⚠️  participants failed:', err.message); }
  });

  sock.ev.on('groups.upsert', () => refreshGroups(sock).catch(() => {}));

  setInterval(() => heartbeat(), 60_000).unref();
  return sock;
}

process.on('SIGINT', () => { heartbeat({ stopped: new Date().toISOString() }); log('bye'); process.exit(0); });
process.on('unhandledRejection', (e) => log('⚠️  unhandled:', e?.message || e));

log(`📂 storing in ${store.DIRS.root}`);
start().catch((e) => { log('fatal:', e); process.exit(1); });
