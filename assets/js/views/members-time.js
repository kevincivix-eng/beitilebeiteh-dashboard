/* Members over time: cumulative total and daily new joiners, shown apart.
 *
 * The old chart put both on one canvas with two y-axes, so the daily bars
 * (tens) and the cumulative line (thousands) fought for the same space. They
 * are now two stacked panels on one shared time axis: hovering either one
 * moves a crosshair through both and fills a single readout line.
 * Below them, a calendar of daily joiners exposes weekly rhythm and waves
 * that a bar chart flattens.
 *
 * Leavers and active-in-group are deliberately not shown (product decision).
 * Source: SharePoint-derived members.json. */
const MembersView = (() => {
  const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const GRID = 'rgba(58,51,64,.07)';
  const TICK = '#8a8590';

  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const dmy = (d) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
  const sumLast = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0);

  // vertical hairline at the hovered day
  const crosshair = {
    id: 'membersCrosshair',
    afterDatasetsDraw(chart) {
      const a = chart.getActiveElements();
      if (!a.length) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = 'rgba(58,51,64,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0].element.x, chartArea.top);
      ctx.lineTo(a[0].element.x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function init(data) {
    const rows = (data.members || []).filter((r) => r.date);
    if (!rows.length) return;
    const dates = rows.map((r) => parse(r.date));
    const joined = rows.map((r) => r.joined || 0);
    const cumulative = rows.map((r) => r.cumulative || 0);
    const lastIdx = rows.length - 1;

    const peakIdx = joined.indexOf(Math.max(...joined));
    document.getElementById('membersKpis').innerHTML =
      kpiCard(fmt(cumulative[lastIdx]), 'סך חברים מצטבר', true) +
      kpiCard(fmt(sumLast(joined, 30)), 'מצטרפים חדשים · 30 ימים') +
      kpiCard(fmt(sumLast(joined, 7)), 'מצטרפים חדשים · 7 ימים') +
      kpiCard(fmt(joined[peakIdx]), `שיא יומי · ${dmy(dates[peakIdx])}`);

    const readout = document.getElementById('membersReadout');
    const show = (i) => {
      readout.innerHTML =
        `<span class="members-readout__date">${DAYS[dates[i].getUTCDay()]} ${dmy(dates[i])}</span>` +
        `<span><i class="members-dot members-dot--cum"></i>סך מצטבר <b>${fmt(cumulative[i])}</b></span>` +
        `<span><i class="members-dot members-dot--new"></i>הצטרפו ביום <b>${fmt(joined[i])}</b></span>`;
    };
    show(lastIdx);

    const labels = rows.map((r) => r.date);
    const monthTick = (v) => { const d = dates[v]; return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`; };
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      layout: { padding: { left: 4 } },
    };
    const yAxis = (title) => ({
      position: 'right',
      beginAtZero: true,
      afterFit: (s) => { s.width = 64; }, // same width on both panels keeps the days aligned
      // the readout already names both series; on phones the rotated title just eats width
      title: { display: window.innerWidth > 640, text: title, color: TICK, font: { family: 'Heebo', size: 12 } },
      ticks: { color: TICK, font: { family: 'Heebo', size: 11 }, maxTicksLimit: 5, callback: (v) => fmt(v) },
      grid: { color: GRID },
    });

    let cumChart = null;
    let newChart = null;
    // hovering one panel activates the same day on the other
    const sync = {
      id: 'membersSync',
      afterEvent(chart) {
        const a = chart.getActiveElements();
        if (!a.length) return;
        const i = a[0].index;
        show(i);
        const other = chart === cumChart ? newChart : cumChart;
        if (!other || other.getActiveElements()[0]?.index === i) return;
        other.setActiveElements([{ datasetIndex: 0, index: i }]);
        other.draw();
      },
    };

    cumChart = new Chart(document.getElementById('membersCumChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: cumulative, borderColor: BRAND.green, backgroundColor: 'rgba(78,114,77,.16)',
          fill: 'origin', borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: BRAND.green, tension: 0.25,
        }],
      },
      options: {
        ...base,
        scales: { x: { ticks: { display: false }, grid: { display: false } }, y: yAxis('סך מצטבר') },
      },
      plugins: [sync, crosshair],
    });

    newChart = new Chart(document.getElementById('membersNewChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: joined, backgroundColor: BRAND.pink, hoverBackgroundColor: BRAND.pinkDeep,
          barPercentage: 1, categoryPercentage: 0.9,
        }],
      },
      options: {
        ...base,
        scales: {
          x: { ticks: { color: TICK, font: { family: 'Heebo', size: 11 }, maxTicksLimit: 10, maxRotation: 0, callback: monthTick }, grid: { display: false } },
          y: yAxis('מצטרפים ביום'),
        },
      },
      plugins: [sync, crosshair],
    });

    [cumChart, newChart].forEach((c) => c.canvas.addEventListener('mouseleave', () => {
      [cumChart, newChart].forEach((k) => { k.setActiveElements([]); k.draw(); });
      show(lastIdx);
    }));

    drawCalendar(dates, joined);
  }

  /* One square per day, one column per week (Sunday on top). Colour is the
   * number of new joiners on a fixed step scale, so one record day doesn't
   * wash every other day out to the same pale shade. */
  function drawCalendar(dates, joined) {
    const STEPS = [
      { max: 0, color: '#ebe8dc', label: '0' },
      { max: 9, color: '#f3dcea', label: '1–9' },
      { max: 29, color: '#e6b5d4', label: '10–29' },
      { max: 99, color: '#da91bf', label: '30–99' },
      { max: 299, color: '#c46ca6', label: '100–299' },
      { max: Infinity, color: '#8e4476', label: '300+' },
    ];
    const colorOf = (v) => STEPS.find((s) => v <= s.max).color;
    const CELL = 13; const GAP = 3; const LEFT = 0; const TOP = 20; const DAY_COL = 34;
    const offset = dates[0].getUTCDay();
    const weeks = Math.ceil((joined.length + offset) / 7);
    const width = LEFT + weeks * (CELL + GAP) + DAY_COL;
    const height = TOP + 7 * (CELL + GAP);

    let svg = `<svg class="members-cal__svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="לוח שנה של מצטרפים חדשים ביום">`;
    [0, 2, 4, 6].forEach((r) => {
      svg += `<text x="${width - 2}" y="${TOP + r * (CELL + GAP) + CELL - 2}" text-anchor="end" class="members-cal__lbl">${DAYS[r]}</text>`;
    });
    let lastMonth = -1;
    joined.forEach((v, i) => {
      const k = i + offset;
      const x = LEFT + Math.floor(k / 7) * (CELL + GAP);
      const y = TOP + (k % 7) * (CELL + GAP);
      const m = dates[i].getUTCMonth();
      if (m !== lastMonth && dates[i].getUTCDate() <= 7 && k % 7 === 0) {
        lastMonth = m;
        svg += `<text x="${x}" y="12" class="members-cal__lbl">${MONTHS[m]}</text>`;
      }
      svg += `<rect data-i="${i}" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${colorOf(v)}"/>`;
    });
    svg += '</svg>';

    const wrap = document.getElementById('membersCal');
    wrap.innerHTML = svg;
    // on narrow screens the calendar scrolls sideways — open on the latest weeks
    wrap.scrollLeft = wrap.scrollWidth;

    // average joiners by weekday — the rhythm the calendar shows by eye
    const sums = [0, 0, 0, 0, 0, 0, 0]; const counts = [0, 0, 0, 0, 0, 0, 0];
    joined.forEach((v, i) => { const d = dates[i].getUTCDay(); sums[d] += v; counts[d]++; });
    const avg = sums.map((s, d) => (counts[d] ? s / counts[d] : 0));
    const best = avg.indexOf(Math.max(...avg));

    const read = document.getElementById('membersCalReadout');
    const idle = `היום החזק ביותר: <b>${DAYS[best]}</b> · ממוצע ${fmt(Math.round(avg[best]))} מצטרפים`;
    read.innerHTML = idle;
    const pick = (e) => {
      const i = e.target.dataset?.i;
      wrap.querySelectorAll('rect.is-on').forEach((r) => r.classList.remove('is-on'));
      if (i === undefined) { read.innerHTML = idle; return; }
      e.target.classList.add('is-on');
      read.innerHTML = `${DAYS[dates[i].getUTCDay()]} ${dmy(dates[i])} · <b>${fmt(joined[i])}</b> מצטרפים חדשים`;
    };
    wrap.addEventListener('mouseover', pick);
    wrap.addEventListener('click', pick);
    wrap.addEventListener('mouseleave', () => pick({ target: {} }));

    document.getElementById('membersCalLegend').innerHTML =
      '<span>פחות</span>' +
      STEPS.map((s) => `<i style="background:${s.color}" title="${s.label}"></i>`).join('') +
      '<span>יותר</span>';
  }

  return { init };
})();
