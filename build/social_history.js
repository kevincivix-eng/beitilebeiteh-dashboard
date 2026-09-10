/**
 * Maintain social-history.json — the dashboard's own long-running follower record.
 *
 * Meta only returns a trailing window of follower history (Facebook ~90 days,
 * Instagram 30). Each build reconstructs that window, but a day that rolls out
 * of it is gone for good — so without keeping it, the chart could never grow
 * longer than the window. Here every reconstructed point is written into the
 * history, which each build carries forward from the last published copy: once
 * a day has been seen, it stays.
 *
 * Observed beats reconstructed. A date that already has a value is never
 * overwritten by a back-calculated one; reconstruction only fills gaps.
 */

const isCount = (v) => typeof v === 'number' && v > 0;

function mergeSocialHistory(hist, socialData, today) {
  const rows = new Map(
    (Array.isArray(hist) ? hist : [])
      .filter((h) => h && h.date && !h.demo)
      .map((h) => [h.date, { ...h }]),
  );

  // --- today's observed snapshot
  const fb = socialData.facebook || null;
  const ig = socialData.instagram || null;
  const fbP = (fb && fb.page) || {};
  const igA = (ig && ig.account) || {};
  // A network we could not fetch is recorded as null, not 0 — a zero would
  // plot as the whole audience vanishing for a day.
  const snap = {
    fb_followers: isCount(fbP.followers) ? fbP.followers : null,
    fb_reach: fb ? (fbP.reach28 ?? null) : null,
    fb_engagement: fb ? (fbP.engagement28 ?? null) : null,
    ig_followers: isCount(igA.followers) ? igA.followers : null,
    ig_reach: ig ? (igA.reach28 ?? null) : null,
    ig_engagement: ig ? (igA.engagement28 ?? null) : null,
  };
  const todayRow = rows.get(today) || { date: today };
  // A later build on the same day refreshes today's values, but a network that
  // failed this time must not erase what an earlier build today recorded.
  Object.entries(snap).forEach(([k, v]) => { if (v != null) todayRow[k] = v; });
  rows.set(today, todayRow);

  // --- persist the reconstructed trends, filling gaps only
  const fill = (trend, key) => {
    let n = 0;
    (trend || []).forEach((p) => {
      if (!p || !p.date || !isCount(p.followers)) return;
      if (p.date > today) return; // never persist a date that hasn't happened
      const r = rows.get(p.date) || { date: p.date };
      if (isCount(r[key])) return;
      r[key] = p.followers;
      rows.set(p.date, r);
      n++;
    });
    return n;
  };
  const filled = {
    fb: fill(fb && fb.followerTrend, 'fb_followers'),
    ig: fill(ig && ig.followerTrend, 'ig_followers'),
  };

  const merged = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { hist: merged, filled };
}

module.exports = { mergeSocialHistory };
