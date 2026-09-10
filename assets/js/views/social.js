/* Social view: FB/IG page + post analytics, and social-vs-project comparison.
   Data comes from data/social.json + data/social-history.json (built from the
   Meta Graph API). Falls back to bundled demo data until the token is set. */
const SocialView = (() => {
  const NET = { facebook: '📘', instagram: '📸' };

  const isoWeek = (d) => {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
  };
  const shortDate = (s) => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }); };
  const engRate = (eng, reach) => (reach ? Math.round((eng / reach) * 1000) / 10 : 0);

  // Engagement rate: of the people a post reached, what share reacted to it.
  // Lets posts with very different reach be compared on quality, not size.
  const ER_TIP = 'שיעור מעורבות = (לייקים + תגובות + שמירות + שיתופים) ÷ reach × 100. '
    + 'כלומר: מכל 100 אנשים שראו את התוכן, כמה הגיבו אליו. '
    + 'כך אפשר להשוות בין פוסטים שהגיעו לכמויות שונות של אנשים.';
  const infoTip = (text, tip) =>
    `<span class="info-tip" tabindex="0" data-tip="${tip}">${text}<span class="info-tip__icon">ⓘ</span></span>`;
  // weighted: total engagement ÷ total reach, so one tiny-reach post can't skew it
  const weightedRate = (posts) => {
    const withReach = posts.filter((p) => p.reach > 0);
    const reach = withReach.reduce((a, p) => a + p.reach, 0);
    return reach ? Math.round((withReach.reduce((a, p) => a + (p.engagement || 0), 0) / reach) * 1000) / 10 : null;
  };

  let charts = [];
  const destroyCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

  const REACT_EMOJI = { like: '👍', love: '❤️', care: '🥰', haha: '😂', wow: '😮', sorry: '😢', anger: '😡' };
  const contentType = (p, net) => {
    if (net === 'instagram') {
      // media_type says VIDEO for Reels and feed videos alike (and never
      // "REEL"), so every video used to be labelled "תמונה". media_product_type
      // is what tells a Reel apart.
      if (p.productType === 'REELS' || p.type === 'REEL') return 'ריל'; // REEL: legacy demo data
      if (p.type === 'VIDEO') return 'וידאו';
      if (p.type === 'CAROUSEL_ALBUM') return 'קרוסלה';
      if (p.type === 'IMAGE') return 'תמונה';
      return 'פוסט';
    }
    const t = p.type || '';
    if (/video/i.test(t)) return 'וידאו';
    if (/photo/i.test(t)) return 'תמונה';
    if (/shared|link/i.test(t)) return 'שיתוף';
    if (/status/i.test(t)) return 'סטטוס';
    return 'פוסט';
  };

  function postCard(p, net) {
    const thumb = p.image
      ? `<img src="${p.image}" alt="" loading="lazy" />`
      : (net === 'instagram' ? '📸' : '📘');
    const m = (icon, v, suf) => (v != null ? `<span>${icon} <b>${fmt(v)}${suf || ''}</b></span>` : '');
    const reacts = p.reactions
      ? Object.entries(p.reactions).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
        .slice(0, 4).map(([k, v]) => `${REACT_EMOJI[k] || '👍'}${fmt(v)}`).join(' ')
      : '';
    const meta = [
      p.reach != null
        ? `<span data-tip="${net === 'facebook' ? 'צופים ייחודיים' : 'Reach'}">👁 <b>${fmt(p.reach)}</b></span>` : '',
      m('▶️', p.plays || p.videoViews), m('⏱', p.avgWatchSec, ' שנ׳'),
      p.watchMin != null ? `<span>🎬 <b>${fmt(p.watchMin)} דק׳</b></span>` : '',
      reacts ? `<span>${reacts}</span>` : m('❤️', p.likes),
      m('💬', p.comments), m('🔖', p.saves), m('🔁', p.shares), m('🖱', p.clicks),
      net === 'instagram' && p.reach > 0
        ? `<span data-tip="שיעור מעורבות">📊 <b>${engRate(p.engagement || 0, p.reach)}%</b></span>` : '',
    ].filter(Boolean).join('');
    return `<a class="post-card" href="${p.link || '#'}" target="_blank" rel="noopener">
      <div class="post-card__thumb">${thumb}</div>
      <div class="post-card__body">
        <p class="post-card__text">${(p.text || '—').replace(/</g, '&lt;')}</p>
        <div class="post-card__meta">${meta || '<span>—</span>'}</div>
        <div class="post-card__date"><span class="post-type">${contentType(p, net)}</span> · ${shortDate(p.date)} · מעורבות ${fmt(p.engagement)}</div>
      </div>
    </a>`;
  }

  function renderNetwork(net, data) {
    const src = data.social && data.social[net];
    const acct = src ? (src.page || src.account) : null;
    const posts = src ? (src.posts || src.media || []) : [];
    const kpiEl = document.getElementById(net === 'facebook' ? 'fbKpis' : 'igKpis');
    if (acct) {
      const totalEng = posts.reduce((s, p) => s + (p.engagement || 0), 0);
      const avg = posts.length ? Math.round(totalEng / posts.length) : 0;
      kpiEl.innerHTML =
        kpiCard(fmt(acct.followers), 'עוקבים', true) +
        // Facebook no longer reports reach; its replacement counts unique VIEWERS
        // of the page's content — close to reach, but not the same definition,
        // so it is labelled for what it is rather than as "Reach".
        (acct.reach28 != null
          ? kpiCard(fmt(acct.reach28), net === 'facebook' ? 'צופים ייחודיים (28 ימים)' : 'Reach (28 ימים)')
          : '') +
        (acct.engagement28 ? kpiCard(fmt(acct.engagement28), 'מעורבות (28 ימים)', true) : '') +
        (acct.profileVisits28 ? kpiCard(fmt(acct.profileVisits28), 'כניסות לפרופיל (28 ימים)') : '') +
        (acct.newFollows28 != null ? kpiCard(fmt(acct.newFollows28), 'עוקבים חדשים (28 ימים)') : '') +
        kpiCard(fmt(avg), 'ממוצע מעורבות לפוסט', true) +
        (net === 'instagram' && weightedRate(posts) != null
          ? kpiCard(weightedRate(posts) + '%', infoTip('שיעור מעורבות',
            ER_TIP + ' כאן: סך המעורבות בפוסטים ÷ סך ה-reach שלהם.'))
          : '') +
        kpiCard(fmt(posts.length), 'פוסטים אחרונים');
    } else {
      kpiEl.innerHTML = kpiCard('—', 'אין נתונים');
    }
    const recent = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
    const top = [...posts].sort((a, b) => (b.engagement || 0) - (a.engagement || 0)).slice(0, 5);
    document.getElementById(net === 'facebook' ? 'fbRecent' : 'igRecent').innerHTML =
      recent.map((p) => postCard(p, net)).join('') || '<p class="post-card__date">אין פוסטים</p>';
    document.getElementById(net === 'facebook' ? 'fbTop' : 'igTop').innerHTML =
      top.map((p) => postCard(p, net)).join('') || '<p class="post-card__date">אין פוסטים</p>';
  }

  // ---- per-network insight charts: Facebook and Instagram share these builders ----
  const TYPE_ORDER = ['ריל', 'וידאו', 'תמונה', 'קרוסלה', 'שיתוף', 'סטטוס', 'פוסט'];
  // Resolved at call time: BRAND is defined in app.js, which loads AFTER this
  // file — reading it while this module initialises throws and takes the
  // whole social page down with it.
  const typeColor = (t) => ({
    'ריל': BRAND.pinkDeep, 'וידאו': BRAND.green, 'תמונה': BRAND.pink, 'קרוסלה': '#7fa37e',
  })[t] || BRAND.pink;
  const heebo = { family: 'Heebo' };
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const byTypeOrder = (a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b);

  // content type -> average engagement. withCounts shows "(n)" posts per type
  // and colours each type, so a type backed by 2 posts isn't read like one backed by 30.
  function typeChart(canvasId, posts, net, withCounts) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const byType = {};
    posts.forEach((p) => { const t = contentType(p, net); (byType[t] = byType[t] || []).push(p.engagement || 0); });
    const names = Object.keys(byType).sort(byTypeOrder);
    charts.push(new Chart(el, {
      type: 'bar',
      data: {
        labels: names.map((t) => (withCounts ? `${t} (${byType[t].length})` : t)),
        datasets: [{ label: 'ממוצע מעורבות', data: names.map((t) => mean(byType[t])),
          backgroundColor: withCounts ? names.map((t) => typeColor(t)) : BRAND.pink, borderRadius: 6 }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: heebo } }, y: { ticks: { font: heebo } } } },
    }));
  }

  // posting weekday -> average engagement + number of posts (best time to post)
  function weekdayChart(canvasId, posts) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const byDay = days.map(() => []);
    posts.forEach((p) => { const d = new Date(p.ts || p.date); if (!isNaN(d)) byDay[d.getDay()].push(p.engagement || 0); });
    charts.push(new Chart(el, {
      type: 'bar',
      data: {
        labels: days,
        datasets: [
          { label: 'ממוצע מעורבות', data: byDay.map(mean), backgroundColor: BRAND.green, borderRadius: 6, yAxisID: 'y' },
          { label: 'מספר פוסטים', data: byDay.map((a) => a.length), type: 'line', borderColor: BRAND.pinkDeep, backgroundColor: BRAND.pinkDeep, tension: 0.3, yAxisID: 'y1' },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 12 } } } }, scales: { x: { ticks: { font: heebo } }, y: { position: 'right', ticks: { font: heebo } }, y1: { position: 'left', grid: { drawOnChartArea: false }, ticks: { font: heebo, precision: 0 } } } },
    }));
  }

  // net (not cumulative) engagement per publish date, from each post's own numbers
  function engByDateChart(canvasId, posts, series) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const byDate = {};
    posts.forEach((p) => {
      if (!p.date) return;
      const row = byDate[p.date] = byDate[p.date] || {};
      series.forEach((sr) => { row[sr.key] = (row[sr.key] || 0) + (p[sr.key] || 0); });
    });
    const dates = Object.keys(byDate).sort();
    if (!dates.length) return;
    charts.push(new Chart(el, {
      type: 'line',
      data: {
        labels: dates.map((d) => shortDate(d)),
        datasets: series.map((sr) => ({
          label: sr.label, data: dates.map((d) => byDate[d][sr.key]),
          borderColor: sr.color, backgroundColor: sr.color, tension: 0.3, borderWidth: 2,
          pointRadius: dates.length > 20 ? 0 : 3, ...(sr.dash ? { borderDash: sr.dash } : {}),
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 12 } } } },
        scales: { x: { ticks: { font: heebo, maxTicksLimit: 10 } }, y: { ticks: { font: heebo, precision: 0 } } },
      },
    }));
  }

  // daily new followers
  function followsChart(canvasId, hostId, series) {
    const fs = (series || []).filter((x) => x.date);
    const host = document.getElementById(hostId);
    const el = document.getElementById(canvasId);
    if (fs.length && el) {
      charts.push(new Chart(el, {
        type: 'bar',
        data: { labels: fs.map((x) => shortDate(x.date)), datasets: [{ label: 'עוקבים חדשים ליום', data: fs.map((x) => x.follows), backgroundColor: BRAND.pink, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: heebo } }, y: { ticks: { font: heebo, precision: 0 } } } },
      }));
    } else if (host) {
      host.innerHTML = '<p class="post-card__date">אין עדיין נתוני גידול יומי (ייאספו עם הזמן)</p>';
    }
  }

  // engagement rate per post, in publish order, one colour per content type.
  // Stacked axes put each post's single bar at full width despite one dataset per type.
  function rateChart(canvasId, posts, net) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const rows = posts.filter((p) => p.reach > 0 && p.date)
      .sort((a, b) => String(a.ts || a.date).localeCompare(String(b.ts || b.date)))
      .map((p) => ({ p, t: contentType(p, net), r: engRate(p.engagement || 0, p.reach) }));
    if (!rows.length) {
      el.insertAdjacentHTML('afterend', '<p class="post-card__date">אין עדיין נתוני reach לפוסטים</p>');
      return;
    }
    const types = [...new Set(rows.map((x) => x.t))].sort(byTypeOrder);
    charts.push(new Chart(el, {
      type: 'bar',
      data: {
        labels: rows.map((x) => shortDate(x.p.date)),
        datasets: types.map((t) => ({
          label: t, data: rows.map((x) => (x.t === t ? x.r : null)),
          backgroundColor: typeColor(t), borderRadius: 4,
        })),
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { font: heebo } },
          tooltip: { callbacks: { label: (c) => {
            const row = rows[c.dataIndex];
            return `${c.dataset.label}: ${c.parsed.y}% · reach ${fmt(row.p.reach)} · מעורבות ${fmt(row.p.engagement)}`;
          } } },
        },
        scales: {
          x: { stacked: true, ticks: { font: heebo, maxTicksLimit: 14 } },
          y: { stacked: true, beginAtZero: true, ticks: { font: heebo, callback: (v) => v + '%' } },
        },
      },
    }));
  }

  function renderFbInsights(data) {
    const fb = (data.social || {}).facebook;
    if (!fb) return;
    const posts = fb.posts || [];
    typeChart('fbTypeChart', posts, 'facebook', false);
    weekdayChart('fbWeekdayChart', posts);
    engByDateChart('fbEngagementByDateChart', posts, [
      { key: 'likes', label: 'לייקים', color: BRAND.pink },
      { key: 'comments', label: 'תגובות', color: BRAND.green },
      { key: 'shares', label: 'שיתופים', color: BRAND.pinkDeep },
      { key: 'clicks', label: 'קליקים', color: BRAND.ink, dash: [4, 3] },
    ]);
    followsChart('fbFollowsChart', 'fbFollowsWrap', fb.followsSeries);
  }

  // Instagram: the same four charts (saves instead of clicks — Instagram has no
  // clicks) plus engagement rate, which Instagram's per-post reach makes possible.
  function renderIgInsights(data) {
    const ig = (data.social || {}).instagram;
    if (!ig) return;
    const posts = ig.media || [];
    typeChart('igTypeChart', posts, 'instagram', true);
    weekdayChart('igWeekdayChart', posts);
    rateChart('igRateChart', posts, 'instagram');
    engByDateChart('igEngagementByDateChart', posts, [
      { key: 'likes', label: 'לייקים', color: BRAND.pink },
      { key: 'comments', label: 'תגובות', color: BRAND.green },
      { key: 'saves', label: 'שמירות', color: BRAND.ink },
      { key: 'shares', label: 'שיתופים', color: BRAND.pinkDeep },
    ]);
    followsChart('igFollowsChart', 'igFollowsWrap', ig.followsSeries);
  }

  function renderOverview(data) {
    const s = data.social || {};
    const fb = s.facebook || {}, ig = s.instagram || {};
    const fbA = fb.page || {}, igA = ig.account || {};
    const followers = (fbA.followers || 0) + (igA.followers || 0);
    const eng = (fbA.engagement28 || 0) + (igA.engagement28 || 0);
    const allPosts = [...(fb.posts || []), ...(ig.media || [])];
    const totalPostEng = allPosts.reduce((s, p) => s + (p.engagement || 0), 0);
    const avgEng = allPosts.length ? Math.round(totalPostEng / allPosts.length) : 0;
    document.getElementById('socialKpis').innerHTML =
      kpiCard(fmt(followers), 'סה"כ עוקבים', true) +
      (eng ? kpiCard(fmt(eng), 'מעורבות (28 ימים)') : '') +
      kpiCard(fmt(avgEng), 'ממוצע מעורבות לפוסט', true) +
      kpiCard(fmt(allPosts.length), 'פוסטים אחרונים');

    const hist = data.socialhistory || [];
    // History is the long-running record: the build persists every
    // reconstructed point into it, so it keeps days that have since rolled out
    // of Meta's 90/30-day window. The live trend only fills dates the history
    // doesn't have yet. Observed values always win over reconstructed ones.
    const byDate = new Map();
    const fill = (points, key) => (points || []).forEach((p) => {
      if (!p || !p.date || !(p.followers > 0)) return;
      const r = byDate.get(p.date) || { date: p.date };
      if (r[key] > 0) return;
      r[key] = p.followers;
      byDate.set(p.date, r);
    });
    fill(hist.map((h) => ({ date: h.date, followers: h.fb_followers })), 'fb');
    fill(hist.map((h) => ({ date: h.date, followers: h.ig_followers })), 'ig');
    fill(fb.followerTrend, 'fb');
    fill(ig.followerTrend, 'ig');
    const followerData = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const hasIg = followerData.some((x) => x.ig != null);
    const radius = (key) => (followerData.filter((x) => x[key] != null).length > 20 ? 0 : 3);

    // Both networks share one "follower count" axis on purpose. Instagram
    // (~2,200) dwarfs Facebook (~70), so the Facebook line sits near zero —
    // that IS the real comparison, and a second axis would hide it.
    const FB_C = '#4267B2', IG_C = '#C13584';
    const axisFont = { family: 'Heebo' };
    charts.push(new Chart(document.getElementById('socialFollowersChart'), {
      type: 'line',
      data: {
        labels: followerData.map((x) => shortDate(x.date)),
        datasets: [
          { label: 'פייסבוק', data: followerData.map((x) => x.fb ?? null), yAxisID: 'y',
            borderColor: FB_C, backgroundColor: FB_C + '33', tension: 0.35, fill: !hasIg,
            pointRadius: radius('fb'), borderWidth: 2 },
          ...(hasIg ? [{ label: 'אינסטגרם', data: followerData.map((x) => x.ig ?? null), yAxisID: 'y',
            borderColor: IG_C, backgroundColor: IG_C + '22', tension: 0.35, fill: false,
            pointRadius: radius('ig'), borderWidth: 2 }] : []),
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { font: axisFont } } },
        scales: {
          x: { ticks: { font: axisFont, maxTicksLimit: 8 } },
          y: { position: 'left', beginAtZero: true,
            title: { display: true, text: 'מספר עוקבים', font: axisFont },
            ticks: { font: axisFont } },
        },
      },
    }));

    // social engagement vs project (registered members + weekly items delivered)
    const members = data.members || [];
    const memAt = (dateStr) => {
      const t = new Date(dateStr);
      let cum = null;
      members.forEach((m) => { if (m.cumulative != null && new Date(m.date) <= t) cum = m.cumulative; });
      return cum;
    };
    const tl = data.itemsTimeline || data.itemstimeline || { weeks: [] };
    const itemsAt = (dateStr) => {
      const wk = isoWeek(new Date(dateStr));
      const row = (tl.weeks || []).find((w) => w.week === wk);
      return row ? Object.values(row.values).reduce((a, b) => a + b, 0) : 0;
    };
    const engTrend = (fb.engagementTrend && fb.engagementTrend.length >= 2) ? fb.engagementTrend : null;
    const vsRows = engTrend
      ? engTrend.map((x) => ({ date: x.date, eng: x.engagement }))
      : hist.filter((h) => h.fb_engagement != null || h.ig_engagement != null)
        .map((h) => ({ date: h.date, eng: (h.fb_engagement || 0) + (h.ig_engagement || 0) }));
    const many = vsRows.length > 20;
    charts.push(new Chart(document.getElementById('socialVsOrgChart'), {
      data: {
        labels: vsRows.map((x) => shortDate(x.date)),
        datasets: [
          { type: 'line', label: 'מעורבות ברשתות (יומי)', data: vsRows.map((x) => x.eng), borderColor: BRAND.pink, backgroundColor: BRAND.pink, tension: 0.35, yAxisID: 'y', pointRadius: many ? 0 : 3, borderWidth: 2 },
          { type: 'line', label: 'משתתפות רשומות (מצטבר)', data: vsRows.map((x) => memAt(x.date)), borderColor: BRAND.green, backgroundColor: BRAND.green, tension: 0.35, yAxisID: 'y1', pointRadius: many ? 0 : 3, borderWidth: 2, spanGaps: true },
          { type: 'bar', label: 'פריטים שנמסרו (שבועי)', data: vsRows.map((x) => itemsAt(x.date)), backgroundColor: BRAND.green + '55', yAxisID: 'y1', borderRadius: 5 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 12 } } } },
        scales: {
          x: { ticks: { font: { family: 'Heebo' }, maxTicksLimit: 8 } },
          y: { position: 'right', title: { display: true, text: 'מעורבות', font: { family: 'Heebo' } }, ticks: { font: { family: 'Heebo' } } },
          y1: { position: 'left', grid: { drawOnChartArea: false }, title: { display: true, text: 'מיזם', font: { family: 'Heebo' } }, ticks: { font: { family: 'Heebo' } } },
        },
      },
    }));
  }

  function showTab(name) {
    document.querySelectorAll('#view-social .social-tab').forEach((t) => (t.hidden = t.id !== 'socialTab-' + name));
    document.querySelectorAll('#socialTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  }

  function init(data) {
    destroyCharts();
    document.getElementById('socialDemoNote').hidden = !(data.social && data.social.demo);
    renderOverview(data);
    renderNetwork('facebook', data);
    renderNetwork('instagram', data);
    renderFbInsights(data);
    renderIgInsights(data);

    const tabs = document.getElementById('socialTabs');
    if (!tabs.dataset.wired) {
      tabs.dataset.wired = '1';
      tabs.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    }
    showTab('overview');
  }

  return { init };
})();
