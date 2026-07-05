/* App shell: load data once, route between views, init each view lazily. */
const App = {
  data: {},
  initialized: {},
  views: {
    home: () => MapView.init(App.data),
    movement: () => MovementView.init(App.data),
    items: () => ItemsView.init(App.data),
    members: () => MembersView.init(App.data),
    'items-time': () => ItemsTimeView.init(App.data),
    weights: () => WeightsView.init(App.data),
  },
};

// Brand palette shared with views
const BRAND = {
  pink: '#da91bf',
  pinkDeep: '#c46ca6',
  green: '#4e724d',
  cream: '#f5f3e6',
  ink: '#3a3340',
  // categorical palette for charts (brand-tinted)
  cats: ['#da91bf', '#4e724d', '#c46ca6', '#7fa37e', '#e8b6d6', '#9bbf9a', '#a85a8c', '#6b8f6a', '#f0cfe5', '#3f5c3e'],
};

// Per-council brand palette — each municipality keeps its colour consistently
// across every view that breaks data down by council (map, sankey, weights…).
const COUNCIL_COLORS = {
  'ערערה בנגב': '#8f3d77',
  'חורה': '#6a8769',
  'רהט': '#5f1b4d',
  'כסיפה': '#97af94',
  'תל שבע': '#b86aa1',
  'שגב שלום': '#5d605c',
  'לקיה': '#929990',
  'נווה מדבר': '#d49bbe',
  'באר שבע': '#eec7de',
  'אל קסום': '#4c4c4d',
  // councils not in the supplied palette — consistent brand-toned fallbacks
  'חברון': '#a8577f',
  'ערד': '#7d9b7a',
  'אופקים': '#c08fb4',
  'להבים': '#bcae9e',
  'אחר': '#b3aeb6',
};
const COUNCIL_FALLBACK = '#9b8fa6';
// normalize a few known short/spelling variants to the canonical data names
const COUNCIL_ALIASES = {
  'ערערה': 'ערערה בנגב',
  'שגב': 'שגב שלום',
  'אל קאסום': 'אל קסום',
};
function councilColor(name) {
  const key = COUNCIL_ALIASES[(name || '').trim()] || (name || '').trim();
  return COUNCIL_COLORS[key] || COUNCIL_FALLBACK;
}

const fmt = (n) => (n == null ? '—' : n.toLocaleString('he-IL'));

function kpiCard(val, label, green) {
  return `<div class="kpi ${green ? 'kpi--green' : ''}"><div class="kpi__val">${val}</div><div class="kpi__label">${label}</div></div>`;
}

async function loadData() {
  const files = ['kpis', 'flows', 'categories', 'weights', 'items-timeline', 'members'];
  const results = await Promise.all(
    files.map((f) => fetch(`data/${f}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null))
  );
  files.forEach((f, i) => (App.data[f.replace('-', '')] = results[i]));
  // normalize keys
  App.data.itemsTimeline = App.data.itemstimeline;
}

function showView(name) {
  if (!App.views[name]) name = 'home';
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  const el = document.getElementById('view-' + name);
  if (el) el.hidden = false;
  document.querySelectorAll('.nav__item').forEach((a) =>
    a.classList.toggle('active', a.dataset.view === name)
  );
  if (!App.initialized[name]) {
    try { App.views[name](); } catch (e) { console.error('view init failed', name, e); }
    App.initialized[name] = true;
  }
  // close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  document.querySelector('.sidebar__scrim')?.classList.remove('show');
}

function router() {
  const name = (location.hash || '#home').slice(1);
  showView(name);
}

document.addEventListener('DOMContentLoaded', async () => {
  // mobile menu
  const sidebar = document.getElementById('sidebar');
  const scrim = document.createElement('div');
  scrim.className = 'sidebar__scrim';
  document.body.appendChild(scrim);
  document.getElementById('menuToggle').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    scrim.classList.toggle('show');
  });
  scrim.addEventListener('click', () => {
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
  });

  await loadData();

  if (App.data.kpis?.updated) {
    const d = new Date(App.data.kpis.updated);
    document.getElementById('lastUpdated').textContent =
      'עודכן: ' + d.toLocaleDateString('he-IL');
  }

  window.addEventListener('hashchange', router);
  router();
});
