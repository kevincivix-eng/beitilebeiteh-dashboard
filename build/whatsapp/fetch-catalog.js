#!/usr/bin/env node
/**
 * Cache the Airtable item catalog ("רשימת חפצים") locally.
 *
 * STRICTLY READ-ONLY: issues a single HTTPS GET per page. This script contains
 * no write verb and must never gain one — the experiment is not allowed to
 * modify the production Airtable base.
 *
 * Usage: AIRTABLE_API_KEY=pat... node build/whatsapp/fetch-catalog.js
 *    or: node -r ./config.js build/whatsapp/fetch-catalog.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appOPXerkRuO4YH1D';
const TABLE = 'רשימת חפצים';
const OUT = path.join(__dirname, 'catalog.json');

if (!API_KEY) {
  console.error('❌ AIRTABLE_API_KEY missing.');
  process.exit(1);
}

const W = 'משקל מוערך ליחידה (ק"ג)';

function getPage(offset) {
  return new Promise((resolve, reject) => {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`
      + `?pageSize=100${offset ? `&offset=${offset}` : ''}`;
    https.get(url, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${res.statusCode}: ${body}`));
        resolve(JSON.parse(body));
      });
    }).on('error', reject);
  });
}

(async () => {
  const records = [];
  let offset;
  do {
    const page = await getPage(offset);
    if (page.error) throw new Error(JSON.stringify(page.error));
    records.push(...page.records);
    offset = page.offset;
  } while (offset);

  const items = records
    .map((r) => ({
      name: (r.fields.Name || '').trim(),
      unitKg: r.fields[W] ?? null,
      category: (r.fields['קטגוריה'] || '').trim() || null,
    }))
    .filter((x) => x.name);

  fs.writeFileSync(OUT, JSON.stringify({
    fetched: new Date().toISOString(),
    source: `Airtable ${BASE_ID} / ${TABLE} (read-only)`,
    count: items.length,
    items,
  }, null, 1));

  const noWeight = items.filter((i) => i.unitKg == null).length;
  console.log(`✅ cached ${items.length} catalog items (${noWeight} without unit weight)`);
  console.log(`📝 build/whatsapp/catalog.json`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
