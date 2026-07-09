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

  let charts = [];
  const destroyCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

  const REACT_EMOJI = { like: '👍', love: '❤️', care: '🥰', haha: '😂', wow: '😮', sorry: '😢', anger: '😡' };
  const contentType = (p, net) => {
    if (net === 'instagram') return p.type === 'REEL' ? 'ריל' : p.type === 'CAROUSEL_ALBUM' ? 'אלבום' : 'תמונה';
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
      m('👁', p.reach), m('▶️', p.plays || p.videoViews), m('⏱', p.avgWatchSec, ' שנ׳'),
      p.watchMin != null ? `<span>🎬 <b>${fmt(p.watchMin)} דק׳</b></span>` : '',
      reacts ? `<span>${reacts}</span>` : m('❤️', p.likes),
      m('💬', p.comments), m('🔖', p.saves), m('🔁', p.shares), m('🖱', p.clicks),
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
        (acct.reach28 != null ? kpiCard(fmt(acct.reach28), 'Reach (28 ימים)') : '') +
        (acct.engagement28 ? kpiCard(fmt(acct.engagement28), 'מעורבות (28 ימים)', true) : '') +
        (acct.pageViews28 ? kpiCard(fmt(acct.pageViews28), 'צפיות בעמוד') : '') +
        (acct.newFollows28 != null ? kpiCard(fmt(acct.newFollows28), 'עוקבים חדשים (28 ימים)') : '') +
        kpiCard(fmt(avg), 'ממוצע מעורבות לפוסט', true) +
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

  // Facebook-only insight charts: content-type comparison, posting-by-weekday,
  // daily follower growth. Derived from the posts + followsSeries.
  function renderFbInsights(data) {
    const fb = (data.social || {}).facebook;
    if (!fb) return;
    const posts = fb.posts || [];

    // content type → avg engagement
    const byType = {};
    posts.forEach((p) => {
      const t = contentType(p, 'facebook');
      (byType[t] = byType[t] || []).push(p.engagement || 0);
    });
    const typeNames = Object.keys(byType);
    charts.push(new Chart(document.getElementById('fbTypeChart'), {
      type: 'bar',
      data: {
        labels: typeNames,
        datasets: [{ label: 'ממוצע מעורבות', data: typeNames.map((t) => Math.round(byType[t].reduce((a, b) => a + b, 0) / byType[t].length)), backgroundColor: BRAND.pink, borderRadius: 6 }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { family: 'Heebo' } } }, y: { ticks: { font: { family: 'Heebo' } } } } },
    }));

    // posting by weekday → avg engagement (best time to post)
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const byDay = days.map(() => []);
    posts.forEach((p) => { const d = new Date(p.ts || p.date); if (!isNaN(d)) byDay[d.getDay()].push(p.engagement || 0); });
    charts.push(new Chart(document.getElementById('fbWeekdayChart'), {
      type: 'bar',
      data: {
        labels: days,
        datasets: [
          { label: 'ממוצע מעורבות', data: byDay.map((a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0), backgroundColor: BRAND.green, borderRadius: 6, yAxisID: 'y' },
          { label: 'מספר פוסטים', data: byDay.map((a) => a.length), type: 'line', borderColor: BRAND.pinkDeep, backgroundColor: BRAND.pinkDeep, tension: 0.3, yAxisID: 'y1' },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 12 } } } }, scales: { x: { ticks: { font: { family: 'Heebo' } } }, y: { position: 'right', ticks: { font: { family: 'Heebo' } } }, y1: { position: 'left', grid: { drawOnChartArea: false }, ticks: { font: { family: 'Heebo' }, precision: 0 } } } },
    }));

    // daily follower growth
    const fs = (fb.followsSeries || []).filter((x) => x.date);
    const host = document.getElementById('fbFollowsWrap');
    if (fs.length) {
      charts.push(new Chart(document.getElementById('fbFollowsChart'), {
        type: 'bar',
        data: { labels: fs.map((x) => shortDate(x.date)), datasets: [{ label: 'עוקבים חדשים ליום', data: fs.map((x) => x.follows), backgroundColor: BRAND.pink, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { family: 'Heebo' } } }, y: { ticks: { font: { family: 'Heebo' }, precision: 0 } } } },
      }));
    } else if (host) {
      host.innerHTML = '<p class="post-card__date">אין עדיין נתוני גידול יומי (ייאספו עם הזמן)</p>';
    }
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
    const labels = hist.map((h) => shortDate(h.date));
    charts.push(new Chart(document.getElementById('socialFollowersChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'פייסבוק', data: hist.map((h) => h.fb_followers), borderColor: '#4267B2', backgroundColor: '#4267B233', tension: 0.35, fill: true },
          { label: 'אינסטגרם', data: hist.map((h) => h.ig_followers), borderColor: BRAND.pinkDeep, backgroundColor: BRAND.pink + '33', tension: 0.35, fill: true },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo' } } } },
        scales: { x: { ticks: { font: { family: 'Heebo' } } }, y: { ticks: { font: { family: 'Heebo' } } } } },
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
    charts.push(new Chart(document.getElementById('socialVsOrgChart'), {
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'מעורבות ברשתות (שבועי)', data: hist.map((h) => (h.fb_engagement || 0) + (h.ig_engagement || 0)), borderColor: BRAND.pink, backgroundColor: BRAND.pink, tension: 0.35, yAxisID: 'y' },
          { type: 'line', label: 'משתתפות רשומות (מצטבר)', data: hist.map((h) => memAt(h.date)), borderColor: BRAND.green, backgroundColor: BRAND.green, tension: 0.35, yAxisID: 'y1' },
          { type: 'bar', label: 'פריטים שנמסרו (שבועי)', data: hist.map((h) => itemsAt(h.date)), backgroundColor: BRAND.green + '55', yAxisID: 'y1', borderRadius: 5 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 12 } } } },
        scales: {
          x: { ticks: { font: { family: 'Heebo' } } },
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

    const tabs = document.getElementById('socialTabs');
    if (!tabs.dataset.wired) {
      tabs.dataset.wired = '1';
      tabs.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    }
    showTab('overview');
  }

  return { init };
})();
