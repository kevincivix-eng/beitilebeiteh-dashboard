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

// Microsoft Graph (SharePoint Excel — membership tracking)
const MS_TENANT = process.env.MS_TENANT_ID;
const MS_CLIENT = process.env.MS_CLIENT_ID;
const MS_SECRET = process.env.MS_CLIENT_SECRET;
const XLSX_SHARE_URL = process.env.SHAREPOINT_XLSX_URL;

// Meta Graph API (Facebook Page + Instagram — social analytics)
const META_TOKEN = process.env.META_PAGE_TOKEN;
const META_PAGE = process.env.META_PAGE_ID;
const META_IG = process.env.META_IG_USER_ID;
const GRAPH = 'https://graph.facebook.com/v21.0';

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

/**
 * Fetch membership tracking from the org's SharePoint Excel via Microsoft Graph
 * (app-only / client-credentials). Returns { members, latest, series } or null
 * if Graph isn't configured / reachable (build then keeps the committed snapshot).
 */
async function fetchMembers() {
  if (!MS_TENANT || !MS_CLIENT || !MS_SECRET || !XLSX_SHARE_URL) {
    console.warn('⚠️ Graph not configured — skipping live members refresh.');
    return null;
  }
  try {
    // 1. token (client credentials)
    const tokRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_CLIENT, client_secret: MS_SECRET,
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
      }),
    });
    const tok = (await tokRes.json()).access_token;
    if (!tok) throw new Error('no Graph token');

    // 2. resolve share link → download xlsx
    const shareId = 'u!' + Buffer.from(XLSX_SHARE_URL).toString('base64')
      .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    const dl = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());

    // 3. parse "דף מסכם" sheet
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets['דף מסכם'];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    // cols: 0 שבוע | 1 יום | 2 מצטרפים | 3 עוזבים | 4 בקבוצה | 5 מצטבר
    const series = [];
    rows.slice(1).forEach((r) => {
      const d = r[1];
      if (!(d instanceof Date) || isNaN(d)) return;
      series.push({
        date: d.toISOString().slice(0, 10),
        joined: r[2] ?? null, left: r[3] ?? null,
        inGroup: r[4] ?? null, cumulative: r[5] ?? null,
      });
    });
    const withCum = series.filter((s) => s.cumulative != null);
    const latest = withCum[withCum.length - 1] || null;
    console.log(`✅ Members from SharePoint: ${series.length} rows, latest cumulative=${latest?.cumulative}`);
    return { members: latest?.cumulative ?? null, latest, series };
  } catch (e) {
    console.warn('⚠️ Members fetch failed (keeping snapshot):', e.message);
    return null;
  }
}

/**
 * Fetch Facebook Page + Instagram analytics via the Meta Graph API (app-only
 * Page/System-User token). Returns { facebook, instagram } or null if not
 * configured. Also merges a daily snapshot into data/social-history.json so we
 * build our own long-term history beyond Meta's ~93-day insights window.
 */
async function fetchSocial() {
  if (!META_TOKEN) {
    console.warn('⚠️ Meta not configured — keeping social snapshot.');
    return null;
  }
  // A Page access token resolves to its own page via `me`, so we don't need the
  // page id (avoids ID-mismatch errors). META_PAGE stays optional/for reference.
  const FB = 'me';
  const g = async (path, params = {}) => {
    const q = new URLSearchParams({ access_token: META_TOKEN, ...params });
    const res = await fetch(`${GRAPH}/${path}?${q}`);
    const j = await res.json();
    if (j.error) throw new Error(`${path}: ${j.error.message}`);
    return j;
  };
  const sum = (arr, k) => (arr || []).reduce((s, x) => s + (x[k] || 0), 0);
  const insightVal = (data, name) => {
    const m = (data || []).find((d) => d.name === name);
    const v = m && m.values && m.values[m.values.length - 1];
    return v ? v.value : 0;
  };
  const insight28 = (data, name) => {
    const m = (data || []).find((d) => d.name === name);
    return m ? sum(m.values, 'value') : 0;
  };

  try {
    console.log(`ℹ️ Meta cfg: pageId=${META_PAGE}, tokenLen=${(META_TOKEN || '').length}, igId=${META_IG || '(none)'}`);
    // ---- Facebook page ----
    let facebook = null;
    // followers: try followers_count, fall back to fan_count only if it errors
    let pgRaw = await g(`${FB}`, { fields: 'id,followers_count,fan_count,name' }).catch((e) => ({ error: { message: e.message } }));
    if (pgRaw.error) console.warn('⚠️ FB page info error:', pgRaw.error.message);
    let pg = pgRaw.error ? await g(`${FB}`, { fields: 'id,fan_count,name' }).catch(() => ({})) : pgRaw;
    // resolve the concrete page id from the token — /{page-id}/posts behaves
    // differently (and more permissively) than /me/posts.
    const pageId = pg.id || META_PAGE || FB;
    console.log(`ℹ️ FB page resolved: name=${pg.name || '(none)'} id=${pageId} followers=${pg.followers_count ?? pg.fan_count ?? 'n/a'}`);
    // page-level insights (needs read_insights). page_impressions/reach are
    // deprecated in v21; page_post_engagements + page_views_total still work.
    const pIns = await g(`${pageId}/insights`, {
      metric: 'page_post_engagements', period: 'days_28',
    }).catch(() => ({ data: [] }));
    const pViews = await g(`${pageId}/insights`, {
      metric: 'page_views_total', period: 'day',
    }).catch(() => ({ data: [] }));
    // Try the rich fields (reactions/comments summary + reach); they need
    // pages_read_user_content + read_insights. If unavailable, fall back to the
    // basic fields (text/image/date/shares/link) that work with what we have.
    let rich = true;
    let fbPostsRaw = await g(`${pageId}/posts`, {
      fields: 'created_time,message,permalink_url,full_picture,shares,reactions.summary(true),comments.summary(true)',
      limit: '15',
    }).catch((e) => ({ error: { message: e.message } }));
    if (!fbPostsRaw || fbPostsRaw.error) {
      if (fbPostsRaw && fbPostsRaw.error) console.warn('⚠️ FB rich posts unavailable:', fbPostsRaw.error.message);
      rich = false;
      fbPostsRaw = await g(`${pageId}/posts`, {
        fields: 'created_time,message,permalink_url,full_picture,shares',
        limit: '15',
      }).catch((e) => { console.warn('⚠️ FB posts error:', e.message); return { data: [] }; });
    }
    const fbPosts = (fbPostsRaw.data || []).map((p) => {
      const likes = rich && p.reactions && p.reactions.summary ? p.reactions.summary.total_count : null;
      const comments = rich && p.comments && p.comments.summary ? p.comments.summary.total_count : null;
      const shares = p.shares ? p.shares.count : 0;
      return {
        id: p.id, date: (p.created_time || '').slice(0, 10), text: p.message || '',
        link: p.permalink_url, image: p.full_picture || null,
        reach: null, likes, comments, shares,
        // engagement = full sum when we have it, else shares as a proxy for ranking
        engagement: rich ? (likes || 0) + (comments || 0) + shares : shares,
      };
    });
    facebook = {
      page: {
        followers: pg.followers_count || pg.fan_count || 0,
        reach28: null, // page reach/impressions deprecated in Graph v21
        engagement28: insight28(pIns.data, 'page_post_engagements'),
        pageViews28: insight28(pViews.data, 'page_views_total'),
      },
      posts: fbPosts,
    };

    // ---- Instagram ----
    let instagram = null;
    if (META_IG) {
      const ig = await g(`${META_IG}`, { fields: 'followers_count,media_count,username' });
      const igIns = await g(`${META_IG}/insights`, {
        metric: 'reach,profile_views,accounts_engaged', period: 'days_28', metric_type: 'total_value',
      }).catch(() => ({ data: [] }));
      const igMediaRaw = await g(`${META_IG}/media`, {
        fields: 'caption,media_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count,insights.metric(reach,saved,shares)',
        limit: '12',
      }).catch(() => ({ data: [] }));
      const igMedia = (igMediaRaw.data || []).map((m) => {
        const ins = (m.insights && m.insights.data) || [];
        const reach = insightVal(ins, 'reach');
        const saves = insightVal(ins, 'saved');
        const shares = insightVal(ins, 'shares');
        const likes = m.like_count || 0, comments = m.comments_count || 0;
        return {
          id: m.id, date: (m.timestamp || '').slice(0, 10), type: m.media_type,
          text: m.caption || '', link: m.permalink,
          image: m.thumbnail_url || m.media_url || null,
          reach, likes, comments, saves, shares, engagement: likes + comments + saves + shares,
        };
      });
      const igTotal = (name) => {
        const m = (igIns.data || []).find((d) => d.name === name);
        return m ? (m.total_value ? m.total_value.value : sum(m.values, 'value')) : 0;
      };
      instagram = {
        account: {
          followers: ig.followers_count || 0,
          reach28: igTotal('reach'),
          engagement28: igTotal('accounts_engaged'),
          profileViews28: igTotal('profile_views'),
        },
        media: igMedia,
      };
    }

    console.log(`✅ Social: FB followers=${facebook.page.followers}, posts=${facebook.posts.length}` +
      (instagram ? `; IG followers=${instagram.account.followers}, media=${instagram.media.length}` : ''));
    return { updated: new Date().toISOString(), facebook, instagram, tiktok: null };
  } catch (e) {
    console.warn('⚠️ Social fetch failed (keeping snapshot):', e.message);
    return null;
  }
}

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
    'העברות',
  ]);
  console.log(`✅ EVENT: ${events.length}, חפצים מועברים: ${items.length}`);

  // ---- membership tracking (SharePoint Excel via Graph) ----
  const membersData = await fetchMembers();

  // ---- social analytics (Meta Graph API) ----
  const socialData = await fetchSocial();

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
    members: membersData?.members ?? null, // latest cumulative joiners (SharePoint)
    updated: new Date().toISOString(),
  };

  // ---- per-city directional breakdown (drives the home-page map filter) ----
  // For each city we compute OUTgoing (city is origin) and INcoming (city is
  // destination) stats separately, so the KPI strip stays correct when the map
  // direction toggle is flipped. Items/weight are joined item→event→destination
  // (items only carry עיר מוצא, but each item links to its delivery via 'העברות',
  // and the delivery carries 'לאן נמסרת'). Multi-destination deliveries split the
  // item totals evenly across their destinations.
  const itemsByEvent = {};
  items.forEach((r) => {
    const evs = f(r, 'העברות') || [];
    const qty = f(r, 'כמות') || 0;
    const w = f(r, 'משקל חפץ כפול כמות') || 0;
    (Array.isArray(evs) ? evs : [evs]).forEach((id) => {
      const a = itemsByEvent[id] || (itemsByEvent[id] = { items: 0, weightKg: 0 });
      a.items += qty; a.weightKg += w;
    });
  });

  // ---- item count per flow (origin -> destination) for the sankey toggle ----
  // Items are attributed to the delivery's destination(s); multi-destination
  // deliveries split the item total evenly, mirroring the per-city logic.
  const flowItemsMap = {};
  events.forEach((r) => {
    const from = (f(r, 'מאיפה יוצאת המסירה') || '').trim();
    if (!from) return;
    let dests = f(r, 'לאן נמסרת') || [];
    if (typeof dests === 'string') dests = dests.split(',').map((d) => d.trim());
    dests = dests.map((d) => (d || '').trim()).filter(Boolean);
    if (!dests.length) return;
    const agg = itemsByEvent[r.id] || { items: 0 };
    const share = agg.items / dests.length;
    dests.forEach((to) => { const key = `${from}|${to}`; flowItemsMap[key] = (flowItemsMap[key] || 0) + share; });
  });
  flows.forEach((fl) => { fl.items = Math.round(flowItemsMap[`${fl.from}|${fl.to}`] || 0); });

  const cityDir = {};
  const ensureDir = (c) =>
    (cityDir[c] = cityDir[c] || {
      out: { deliveries: 0, people: 0, items: 0, weightKg: 0, partners: new Set() },
      in: { deliveries: 0, people: 0, items: 0, weightKg: 0, partners: new Set() },
    });
  events.forEach((r) => {
    const from = (f(r, 'מאיפה יוצאת המסירה') || '').trim();
    let dests = f(r, 'לאן נמסרת') || [];
    if (typeof dests === 'string') dests = dests.split(',').map((d) => d.trim());
    dests = dests.map((d) => (d || '').trim()).filter(Boolean);
    const ppl = f(r, 'אנשים שמועבר עליהם') || 0;
    const agg = itemsByEvent[r.id] || { items: 0, weightKg: 0 };

    if (from) {
      const s = ensureDir(from).out;
      s.deliveries += 1; s.people += ppl; s.items += agg.items; s.weightKg += agg.weightKg;
      dests.forEach((d) => { if (d !== from) s.partners.add(d); });
    }
    const n = dests.length || 1;
    dests.forEach((d) => {
      const s = ensureDir(d).in;
      s.deliveries += 1; s.people += ppl;
      s.items += agg.items / n; s.weightKg += agg.weightKg / n;
      if (from && from !== d) s.partners.add(from);
    });
  });

  const packDir = (s) => ({
    deliveries: s.deliveries,
    people: s.people,
    items: Math.round(s.items),
    weightTon: Math.round((s.weightKg / 1000) * 100) / 100,
    partners: s.partners.size,
  });
  kpis.byCity = {};
  Object.entries(cityDir).forEach(([c, d]) => {
    kpis.byCity[c] = { out: packDir(d.out), in: packDir(d.in) };
  });

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
  // members.json — refresh from SharePoint when available; else keep the
  // committed snapshot (and backfill kpis.members from it so the card stays populated).
  if (membersData?.series?.length) {
    write('members.json', membersData.series);
  } else if (kpis.members == null) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'members.json'), 'utf8'));
      const lastCum = [...prev].reverse().find((r) => r.cumulative != null);
      if (lastCum) kpis.members = lastCum.cumulative;
      console.log(`↩︎ kept members.json snapshot (members=${kpis.members})`);
    } catch { /* no snapshot yet */ }
  }

  // social.json — refresh from Meta when available; else keep committed snapshot.
  // Also append a daily snapshot to social-history.json (our own long-term series).
  if (socialData) {
    write('social.json', socialData);
    try {
      const histPath = path.join(DATA_DIR, 'social-history.json');
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch { /* first run */ }
      hist = hist.filter((h) => !h.demo);
      const fbP = socialData.facebook?.page || {};
      const igA = socialData.instagram?.account || {};
      const today = new Date().toISOString().slice(0, 10);
      const row = {
        date: today,
        fb_followers: fbP.followers || 0, fb_reach: fbP.reach28 || 0, fb_engagement: fbP.engagement28 || 0,
        ig_followers: igA.followers || 0, ig_reach: igA.reach28 || 0, ig_engagement: igA.engagement28 || 0,
      };
      const i = hist.findIndex((h) => h.date === today);
      if (i >= 0) hist[i] = row; else hist.push(row);
      hist.sort((a, b) => a.date.localeCompare(b.date));
      write('social-history.json', hist);
    } catch (e) { console.warn('⚠️ social-history update failed:', e.message); }
  } else {
    console.log('↩︎ kept social.json / social-history.json snapshot');
  }

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
