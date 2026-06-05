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
