#!/usr/bin/env node
/**
 * Stages 3+4 — enrich listings with catalog weights, then aggregate into
 * dashboard-shaped JSON under data/experimental/.
 *
 * SAFETY: reads data/kpis.json + data/weights.json (live, read-only) purely to
 * build the merged volume view. It never writes outside data/experimental/ and
 * never contacts Airtable.
 *
 * Usage: node build/whatsapp/build-exp.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXP = path.join(ROOT, 'data', 'experimental');
const LIVE = path.join(ROOT, 'data');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const addPath = path.join(__dirname, 'catalog-additions.json');
const additions = fs.existsSync(addPath) ? JSON.parse(fs.readFileSync(addPath, 'utf8')) : { items: [] };

// Container rows: catalog weight is for a whole bag/box, not one object inside.
const containers = JSON.parse(fs.readFileSync(path.join(__dirname, 'units.json'), 'utf8')).containers;

// Display-only categories for the catalog rows that have none (never written back).
const catFallback = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories-fallback.json'), 'utf8')).map;

// name -> { unitKg, category, estimated }
const byName = new Map();
catalog.items.forEach((i) => byName.set(i.name, {
  unitKg: i.unitKg,
  category: i.category || catFallback[i.name] || 'אחר',
  estimated: false,
}));
(additions.items || []).forEach((i) => byName.set(i.name, { unitKg: i.unitKg, category: i.category || 'אחר', estimated: true }));

const UNIDENTIFIED = 'פריט לא מזוהה';

const isoWeek = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
};
const round2 = (n) => Math.round(n * 100) / 100;

function main() {
  const src = JSON.parse(fs.readFileSync(path.join(EXP, 'wa-listings.json'), 'utf8'));
  const listings = src.data.filter((l) => l.isListing);

  // ---------------------------------------------------------------- enrich
  const unknownNames = new Map();
  const enriched = listings.map((l) => {
    const items = l.items.map((it) => {
      const hit = byName.get(it.nameHe);
      if (!hit) unknownNames.set(it.nameHe, (unknownNames.get(it.nameHe) || 0) + 1);
      const unitKg = hit ? hit.unitKg : null;
      const cont = containers[it.nameHe];

      // The vision pass counted individual objects (25 pairs of shoes); the
      // caption pass counts catalog units (one bag of shoes). Weigh each with
      // the matching figure, otherwise object counts get charged a full
      // container weight apiece.
      const countsObjects = it.source === 'vision' && !!cont;
      let weightKg = null;
      let units = it.qty; // quantity expressed in catalog units, for the items KPI
      if (unitKg != null) {
        if (countsObjects) {
          weightKg = cont.perObjectKg * it.qty;
          units = Math.max(1, Math.round(weightKg / unitKg));
        } else {
          weightKg = unitKg * it.qty;
        }
      }
      return {
        ...it,
        category: hit ? hit.category : 'אחר',
        unitKg,
        countsObjects,
        objectLabel: countsObjects ? cont.object : null,
        units,
        weightKg,
        weightEstimated: hit ? hit.estimated : true,
      };
    });
    return { ...l, items };
  });

  // ---------------------------------------------------------------- aggregate
  const cityAgg = {};       // city -> { deliveries, items, weightKg, estimatedKg }
  const catAgg = {};        // category -> { count, weightKg }
  const itemAgg = {};       // item name -> count
  const weekAgg = {};       // isoWeek -> { category: count }
  const catSet = [];
  let totalItems = 0; let totalKg = 0; let estimatedKg = 0;
  let unidentifiedListings = 0; let reservedCount = 0;

  enriched.forEach((l) => {
    const city = l.city || 'אחר';
    const c = cityAgg[city] || (cityAgg[city] = { deliveries: 0, items: 0, weightKg: 0, estimatedKg: 0, unidentified: 0 });
    c.deliveries++;
    if (l.reserved) reservedCount++;
    const wk = isoWeek(new Date(l.date));

    if (!l.items.length) {
      unidentifiedListings++;
      c.unidentified++;
      // still counts as a delivery; contributes no item count and no weight
      itemAgg[UNIDENTIFIED] = (itemAgg[UNIDENTIFIED] || 0) + 1;
      return;
    }

    l.items.forEach((it) => {
      // count in catalog units so the series stays comparable with the
      // historical Airtable numbers (a bag of clothes = 1 item, not 30)
      const n = it.units != null ? it.units : it.qty;
      totalItems += n;
      c.items += n;
      if (it.weightKg != null) {
        totalKg += it.weightKg;
        c.weightKg += it.weightKg;
        if (it.weightEstimated) { estimatedKg += it.weightKg; c.estimatedKg += it.weightKg; }
      }
      const cat = it.category || 'אחר';
      if (!catSet.includes(cat)) catSet.push(cat);
      const ca = catAgg[cat] || (catAgg[cat] = { count: 0, weightKg: 0 });
      ca.count += n;
      ca.weightKg += it.weightKg || 0;
      itemAgg[it.nameHe] = (itemAgg[it.nameHe] || 0) + n;
      weekAgg[wk] = weekAgg[wk] || {};
      weekAgg[wk][cat] = (weekAgg[wk][cat] || 0) + n;
    });
  });

  const dates = enriched.map((l) => l.date).sort();
  const kpis = {
    source: 'whatsapp',
    period: { from: dates[0], to: dates[dates.length - 1] },
    deliveries: enriched.length,
    items: totalItems,
    weightTon: round2(totalKg / 1000),
    weightEstimatedTon: round2(estimatedKg / 1000),
    weightEstimatedPct: totalKg ? Math.round((estimatedKg / totalKg) * 100) : 0,
    unidentifiedListings,
    unidentifiedPct: Math.round((unidentifiedListings / enriched.length) * 100),
    cities: Object.keys(cityAgg).length,
    reservedCount,
    byCity: Object.fromEntries(Object.entries(cityAgg).map(([k, v]) => [k, {
      out: {
        deliveries: v.deliveries,
        items: v.items,
        weightTon: round2(v.weightKg / 1000),
        unidentified: v.unidentified,
      },
    }])),
    updated: new Date().toISOString(),
  };

  const categories = Object.entries(catAgg)
    .map(([name, v]) => ({ name, count: v.count, weight: Math.round(v.weightKg) }))
    .sort((a, b) => b.count - a.count);
  const topItems = Object.entries(itemAgg)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const weights = {
    totalTon: kpis.weightTon,
    estimatedPct: kpis.weightEstimatedPct,
    byCategory: categories.map((c) => ({ name: c.name, ton: round2(c.weight / 1000) })),
    byCity: Object.entries(cityAgg)
      .map(([name, v]) => ({ name, ton: round2(v.weightKg / 1000) }))
      .sort((a, b) => b.ton - a.ton),
  };

  const itemsTimeline = {
    categories: catSet,
    weeks: Object.keys(weekAgg).sort().map((wk) => ({ week: wk, values: weekAgg[wk] })),
  };

  // ------------------------------------------------- merged volume (old+new)
  // The historical Airtable period (…→ May 2026) and the WhatsApp period
  // (Jun 2026 →) barely overlap, so per-city totals can simply be added. The
  // check below fails loudly if that assumption ever stops holding.
  const liveKpis = JSON.parse(fs.readFileSync(path.join(LIVE, 'kpis.json'), 'utf8'));
  const liveWeights = JSON.parse(fs.readFileSync(path.join(LIVE, 'weights.json'), 'utf8'));
  const liveTimeline = JSON.parse(fs.readFileSync(path.join(LIVE, 'items-timeline.json'), 'utf8'));
  const liveLastWeek = liveTimeline.weeks.map((w) => w.week).sort().pop();
  const newFirstWeek = itemsTimeline.weeks.map((w) => w.week).sort()[0];
  const overlap = liveLastWeek >= newFirstWeek;

  const oldTonByCity = Object.fromEntries((liveWeights.byCity || []).map((c) => [c.name, c.ton]));
  const volumeCities = new Set([
    ...Object.keys(liveKpis.byCity || {}),
    ...Object.keys(cityAgg),
  ]);
  const volume = {
    note: 'נפח לפי עיר מוצא — איחוד ההיסטוריה (Airtable) עם הנתונים החדשים (וואטסאפ)',
    overlapWarning: overlap ? `חפיפת תקופות: היסטוריה עד ${liveLastWeek}, חדש מ-${newFirstWeek}` : null,
    periods: { old: `… → ${liveLastWeek}`, new: `${newFirstWeek} → …` },
    cities: [...volumeCities].map((name) => {
      const o = (liveKpis.byCity || {})[name];
      const oldOut = o && o.out ? o.out : { deliveries: 0, items: 0 };
      const n = cityAgg[name] || { deliveries: 0, items: 0, weightKg: 0 };
      return {
        name,
        old: { deliveries: oldOut.deliveries || 0, items: oldOut.items || 0, ton: oldTonByCity[name] || 0 },
        new: { deliveries: n.deliveries, items: n.items, ton: round2(n.weightKg / 1000) },
        total: {
          deliveries: (oldOut.deliveries || 0) + n.deliveries,
          items: (oldOut.items || 0) + n.items,
          ton: round2((oldTonByCity[name] || 0) + n.weightKg / 1000),
        },
      };
    }).sort((a, b) => b.total.items - a.total.items),
  };

  // ------------------------------------------------------------------ write
  const w = (name, obj) => {
    fs.writeFileSync(path.join(EXP, name), JSON.stringify(obj, null, 1));
    console.log(`📝 data/experimental/${name}`);
  };
  w('kpis.json', kpis);
  w('categories.json', { categories, topItems });
  w('weights.json', weights);
  w('items-timeline.json', itemsTimeline);
  w('volume.json', volume);
  w('wa-items.json', { generated: new Date().toISOString(), count: enriched.length, data: enriched });

  console.log('');
  console.log(`✅ ${kpis.deliveries} deliveries | ${kpis.items} items | ${kpis.weightTon} ton`);
  console.log(`   period: ${kpis.period.from} → ${kpis.period.to}`);
  console.log(`   unidentified listings: ${unidentifiedListings} (${kpis.unidentifiedPct}%) — no item/weight contribution`);
  console.log(`   weight estimated: ${kpis.weightEstimatedPct}%`);
  console.log(`   cities: ${kpis.cities} | reserved (collected, not displayed): ${reservedCount}`);
  if (unknownNames.size) {
    console.log(`   ⚠️ names missing from catalog (${unknownNames.size}):`);
    [...unknownNames.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`      ${c}× ${n}`));
  }
  if (overlap) console.log(`   ⚠️ ${volume.overlapWarning}`);
}

main();
