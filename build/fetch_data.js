#!/usr/bin/env node
/**
 * Build-time data fetch for "מביתי לביתך" dashboard.
 * Pulls EVENT + חפצים מועברים from Airtable, aggregates, and writes data/*.json.
 * Token is read from env (AIRTABLE_API_KEY) — never shipped to the browser.
 *
 * Local dev: AIRTABLE_API_KEY=pat... node build/fetch_data.js
 * CI: token provided via GitHub Actions secret.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appOPXerkRuO4YH1D';
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!API_KEY) {
  console.error('❌ AIRTABLE_API_KEY missing.');
  process.exit(1);
}

function fetchTable(table, fields) {
  return new Promise((resolve, reject) => {
    const records = [];
    const go = (offset) => {
      let q = `pageSize=100`;
      if (fields) fields.forEach((f) => (q += `&fields%5B%5D=${encodeURIComponent(f)}`));
      if (offset) q += `&offset=${offset}`;
      const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}?${q}`;
      https
        .get(url, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode < 200 || res.statusCode >= 300)
              return reject(new Error(`${table} ${res.statusCode}: ${data}`));
            const j = JSON.parse(data);
            records.push(...j.records);
            if (j.offset) go(j.offset);
            else resolve(records);
          });
        })
        .on('error', reject);
    };
    go();
  });
}

const f = (r, k) => r.fields[k];
const firstVal = (v) => (Array.isArray(v) ? v[0] : v);

(async () => {
  console.log('⏳ Fetching Airtable…');
  const events = await fetchTable('EVENT', [
    'מאיפה יוצאת המסירה',
    'לאן נמסרת',
    'אנשים שמועבר עליהם',
    'תאריך',
  ]);
  const items = await fetchTable('חפצים מועברים', [
    'כמות',
    'קטגוריה לBI',
    'חפץ לBI',
    'משקל חפץ כפול כמות',
    'עיר מוצא',
    'תאריך העברה',
  ]);
  console.log(`✅ EVENT: ${events.length}, חפצים מועברים: ${items.length}`);

  // ---- flows.json (origin -> each destination) ----
  const flowMap = {};
  const cities = new Set();
  events.forEach((r) => {
    const from = (f(r, 'מאיפה יוצאת המסירה') || '').trim();
    let dests = f(r, 'לאן נמסרת') || [];
    if (typeof dests === 'string') dests = dests.split(',').map((d) => d.trim());
    if (!from) return;
    cities.add(from);
    dests.forEach((d) => {
      const to = (d || '').trim();
      if (!to) return;
      cities.add(to);
      const key = `${from}|${to}`;
      flowMap[key] = (flowMap[key] || 0) + 1;
    });
  });
  const flows = Object.entries(flowMap).map(([k, count]) => {
    const [from, to] = k.split('|');
    return { from, to, count };
  });

  // ---- KPIs ----
  const totalItems = items.reduce((s, r) => s + (f(r, 'כמות') || 0), 0);
  const totalWeightKg = items.reduce((s, r) => s + (f(r, 'משקל חפץ כפול כמות') || 0), 0);
  const totalPeople = events.reduce((s, r) => s + (f(r, 'אנשים שמועבר עליהם') || 0), 0);
  const kpis = {
    deliveries: events.length,
    items: totalItems,
    weightTon: Math.round((totalWeightKg / 1000) * 100) / 100,
    people: totalPeople,
    cities: cities.size,
    updated: new Date().toISOString(),
  };

  // ---- categories.json (by קטגוריה לBI) + top items ----
  const catMap = {};
  const itemMap = {};
  items.forEach((r) => {
    const cat = (f(r, 'קטגוריה לBI') || 'אחר').trim() || 'אחר';
    const name = (f(r, 'חפץ לBI') || 'אחר').trim() || 'אחר';
    const qty = f(r, 'כמות') || 0;
    const w = f(r, 'משקל חפץ כפול כמות') || 0;
    catMap[cat] = catMap[cat] || { count: 0, weight: 0 };
    catMap[cat].count += qty;
    catMap[cat].weight += w;
    itemMap[name] = (itemMap[name] || 0) + qty;
  });
  const categories = Object.entries(catMap)
    .map(([name, v]) => ({ name, count: v.count, weight: Math.round(v.weight) }))
    .sort((a, b) => b.count - a.count);
  const topItems = Object.entries(itemMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // ---- weights.json (by category, by origin city) ----
  const cityWeight = {};
  items.forEach((r) => {
    const city = (firstVal(f(r, 'עיר מוצא')) || 'אחר').trim() || 'אחר';
    const w = f(r, 'משקל חפץ כפול כמות') || 0;
    cityWeight[city] = (cityWeight[city] || 0) + w;
  });
  const weights = {
    totalTon: kpis.weightTon,
    byCategory: categories.map((c) => ({ name: c.name, ton: Math.round((c.weight / 1000) * 100) / 100 })),
    byCity: Object.entries(cityWeight)
      .map(([name, w]) => ({ name, ton: Math.round((w / 1000) * 100) / 100 }))
      .sort((a, b) => b.ton - a.ton),
  };

  // ---- items-timeline.json (per ISO week, by category) ----
  const isoWeek = (d) => {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
  };
  const tlMap = {};
  const catSet = new Set();
  items.forEach((r) => {
    const dRaw = firstVal(f(r, 'תאריך העברה'));
    if (!dRaw) return;
    const d = new Date(dRaw);
    if (isNaN(d)) return;
    const wk = isoWeek(d);
    const cat = (f(r, 'קטגוריה לBI') || 'אחר').trim() || 'אחר';
    const qty = f(r, 'כמות') || 0;
    catSet.add(cat);
    tlMap[wk] = tlMap[wk] || {};
    tlMap[wk][cat] = (tlMap[wk][cat] || 0) + qty;
  });
  const itemsTimeline = {
    categories: [...catSet],
    weeks: Object.keys(tlMap)
      .sort()
      .map((wk) => ({ week: wk, values: tlMap[wk] })),
  };

  // ---- write ----
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const write = (name, obj) => {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj));
    console.log(`📝 ${name}`);
  };
  write('kpis.json', kpis);
  write('flows.json', flows);
  write('categories.json', { categories, topItems });
  write('weights.json', weights);
  write('items-timeline.json', itemsTimeline);

  console.log('\n✅ Done.', JSON.stringify(kpis));
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
