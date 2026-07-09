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

  function postCard(p, net) {
    const thumb = p.image
      ? `<img src="${p.image}" alt="" loading="lazy" />`
      : (net === 'instagram' ? '📸' : '📘');
    const m = (icon, v, suf) => (v != null ? `<span>${icon} <b>${fmt(v)}${suf || ''}</b></span>` : '');
    const meta = [
      m('👁', p.reach), m('▶️', p.plays || p.videoViews), m('⏱', p.avgWatchSec, ' שנ׳'),
      m('❤️', p.likes), m('💬', p.comments), m('🔖', p.saves),
      m('🔁', p.shares), m('🖱', p.clicks),
    ].filter(Boolean).join('');
    const rate = (p.reach && p.engagement != null) ? ` · ${engRate(p.engagement, p.reach)}% מעורבות` : '';
    return `<a class="post-card" href="${p.link || '#'}" target="_blank" rel="noopener">
      <div class="post-card__thumb">${thumb}</div>
      <div class="post-card__body">
        <p class="post-card__text">${(p.text || '—').replace(/</g, '&lt;')}</p>
        <div class="post-card__meta">${meta || '<span>—</span>'}</div>
        <div class="post-card__date">${shortDate(p.date)}${rate}</div>
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
    document.getElementById('socialDemoNote').hidden = !(data.social && data.social.demo);
    renderOverview(data);
    renderNetwork('facebook', data);
    renderNetwork('instagram', data);

    const tabs = document.getElementById('socialTabs');
    if (!tabs.dataset.wired) {
      tabs.dataset.wired = '1';
      tabs.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    }
    showTab('overview');
  }

  return { init };
})();
