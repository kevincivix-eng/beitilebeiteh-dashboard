#!/usr/bin/env node
/**
 * Extend the membership series with the days counted from the WhatsApp chats.
 *
 * The series used to come only from a hand-maintained SharePoint spreadsheet.
 * That spreadsheet is no longer updated, so it is history: everything up to
 * its last row stays exactly as recorded, and the chat-derived days take over
 * after it. The two are NOT averaged or reconciled — splicing keeps the
 * published cumulative figure continuous, where swapping wholesale would make
 * it visibly drop (the chats count ~12% fewer joins over the overlap, since
 * not every group of the initiative is in the exports).
 *
 * Only `joined` carries over. Leavers and in-group headcount are not shown on
 * the dashboard, and the chats report them too unevenly to publish.
 */
const fs = require('fs');
const path = require('path');

const WA_MEMBERS = path.join(__dirname, '..', 'data', 'whatsapp', 'members.json');

function mergeMembers(series) {
  if (!Array.isArray(series) || !series.length) return { series, added: 0 };
  let wa;
  try { wa = JSON.parse(fs.readFileSync(WA_MEMBERS, 'utf8')); } catch { return { series, added: 0 }; }

  const rows = [...series].filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const lastRecorded = rows[rows.length - 1];
  let cum = lastRecorded.cumulative || 0;

  const extra = (wa.data || [])
    .filter((r) => r.date > lastRecorded.date && r.joined > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      cum += r.joined;
      return { date: r.date, joined: r.joined, left: null, inGroup: null, cumulative: cum, source: 'whatsapp' };
    });

  return { series: rows.concat(extra), added: extra.length, from: lastRecorded.date, cumulative: cum };
}

module.exports = { mergeMembers };
