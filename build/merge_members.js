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

  const merged = rows.concat(extra);
  assertOnlyGrows(merged);
  return { series: merged, added: extra.length, from: lastRecorded.date, cumulative: cum };
}

/**
 * The published figure counts everyone who ever joined. Leavers are recorded —
 * 8,314 of them so far — but are never subtracted, so the line can only ever
 * go up. It is a count of women the initiative reached, not of who is in a
 * group today, and the two answer different questions.
 *
 * This is checked rather than trusted because the mistake is invisible: a
 * series that quietly nets out leavers still looks like a plausible chart, and
 * nobody would notice until the number went down one day.
 */
function assertOnlyGrows(series) {
  for (let i = 1; i < series.length; i++) {
    const step = (series[i].cumulative || 0) - (series[i - 1].cumulative || 0);
    if (step < 0) {
      throw new Error(`members: cumulative fell on ${series[i].date} `
        + `(${series[i - 1].cumulative} → ${series[i].cumulative}). `
        + 'The published total counts joiners only and must never net out leavers.');
    }
    if (series[i].joined != null && step !== series[i].joined) {
      throw new Error(`members: ${series[i].date} moved the total by ${step} `
        + `but only ${series[i].joined} joined that day.`);
    }
  }
}

module.exports = { mergeMembers };
