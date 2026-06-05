/* Items view: category bar + top-15 items bar. */
const ItemsView = (() => {
  function init(data) {
    const cats = (data.categories?.categories) || [];
    const top = (data.categories?.topItems) || [];

    new Chart(document.getElementById('catBar'), {
      type: 'bar',
      data: {
        labels: cats.map((c) => c.name),
        datasets: [{ label: 'כמות', data: cats.map((c) => c.count), backgroundColor: BRAND.pink, borderRadius: 6 }],
      },
      options: barOpts(),
    });

    new Chart(document.getElementById('topItemsBar'), {
      type: 'bar',
      data: {
        labels: top.map((c) => c.name),
        datasets: [{ label: 'כמות', data: top.map((c) => c.count), backgroundColor: BRAND.green, borderRadius: 6 }],
      },
      options: barOpts(true),
    });
  }

  function barOpts(horizontal) {
    return {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { family: 'Heebo' } }, grid: { display: !horizontal } },
        y: { ticks: { font: { family: 'Heebo' } }, grid: { display: horizontal } },
      },
    };
  }

  return { init };
})();
