/* Items timeline: stacked bar by week & category. */
const ItemsTimeView = (() => {
  function init(data) {
    const tl = data.itemsTimeline || { categories: [], weeks: [] };
    const labels = tl.weeks.map((w) => w.week);
    const datasets = tl.categories.map((cat, i) => ({
      label: cat,
      data: tl.weeks.map((w) => w.values[cat] || 0),
      backgroundColor: BRAND.cats[i % BRAND.cats.length],
      borderRadius: 2,
    }));

    new Chart(document.getElementById('itemsTimeChart'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Heebo' }, boxWidth: 14 } } },
        scales: {
          x: { stacked: true, ticks: { font: { family: 'Heebo' }, maxTicksLimit: 14 }, grid: { display: false } },
          y: { stacked: true, ticks: { font: { family: 'Heebo' } } },
        },
      },
    });
  }

  return { init };
})();
