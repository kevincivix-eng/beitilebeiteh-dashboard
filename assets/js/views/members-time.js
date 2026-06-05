/* Members timeline: bar (new joiners) + line (cumulative). Source: Excel-derived members.json */
const MembersView = (() => {
  function init(data) {
    const rows = (data.members || []).filter((r) => r.date);
    const labels = rows.map((r) => r.date);
    const joined = rows.map((r) => r.joined || 0);
    const left = rows.map((r) => r.left || 0);
    const cumulative = rows.map((r) => r.cumulative || 0);
    const inGroup = rows.map((r) => r.inGroup || 0);

    const last = rows[rows.length - 1] || {};
    document.getElementById('membersKpis').innerHTML =
      kpiCard(fmt(last.cumulative), 'סך מצטרפים מצטבר', true) +
      kpiCard(fmt(last.inGroup), 'חברים פעילים בקבוצה') +
      kpiCard(fmt(joined.reduce((a, b) => a + b, 0)), 'סך מצטרפים') +
      kpiCard(fmt(left.reduce((a, b) => a + b, 0)), 'סך עוזבים');

    new Chart(document.getElementById('membersChart'), {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'מצטרפים חדשים', data: joined, backgroundColor: BRAND.pink, yAxisID: 'y', borderRadius: 4 },
          { type: 'bar', label: 'עוזבים', data: left, backgroundColor: BRAND.pinkDeep, yAxisID: 'y', borderRadius: 4 },
          { type: 'line', label: 'חברים מצטבר', data: cumulative, borderColor: BRAND.green, backgroundColor: BRAND.green, yAxisID: 'y1', tension: 0.3, pointRadius: 0, borderWidth: 3 },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo' } } } },
        scales: {
          x: { ticks: { font: { family: 'Heebo' }, maxTicksLimit: 12 }, grid: { display: false } },
          y: { position: 'right', title: { display: true, text: 'יומי', font: { family: 'Heebo' } } },
          y1: { position: 'left', grid: { display: false }, title: { display: true, text: 'מצטבר', font: { family: 'Heebo' } } },
        },
      },
    });
  }

  return { init };
})();
