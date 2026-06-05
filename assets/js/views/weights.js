/* Weights view: total saved waste + weight by category + by origin city. */
const WeightsView = (() => {
  function init(data) {
    const w = data.weights || { byCategory: [], byCity: [], totalTon: 0 };

    document.getElementById('weightsKpis').innerHTML =
      kpiCard(fmt(w.totalTon) + ' טון', 'סך פסולת שנחסכה מהטמנה', true) +
      kpiCard(fmt(Math.round(w.totalTon * 1000)) + ' ק"ג', 'משקל כולל') +
      kpiCard(fmt((w.byCity || []).length), 'יישובי מוצא');

    const cat = (w.byCategory || []).filter((c) => c.ton > 0).sort((a, b) => b.ton - a.ton);
    new Chart(document.getElementById('weightCatBar'), {
      type: 'bar',
      data: { labels: cat.map((c) => c.name), datasets: [{ label: 'טון', data: cat.map((c) => c.ton), backgroundColor: BRAND.green, borderRadius: 6 }] },
      options: opts(),
    });

    const city = (w.byCity || []).filter((c) => c.ton > 0);
    new Chart(document.getElementById('weightCityBar'), {
      type: 'bar',
      data: { labels: city.map((c) => c.name), datasets: [{ label: 'טון', data: city.map((c) => c.ton), backgroundColor: BRAND.pink, borderRadius: 6 }] },
      options: opts(true),
    });
  }

  function opts(horizontal) {
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
