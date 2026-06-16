/* Movement view: d3-sankey origin→destination + intra/inter-city pie + KPIs. */
const MovementView = (() => {
  function init(data) {
    const flows = data.flows || [];

    // KPIs
    const totalMoves = flows.reduce((s, f) => s + f.count, 0);
    const intra = flows.filter((f) => f.from === f.to).reduce((s, f) => s + f.count, 0);
    const inter = totalMoves - intra;
    const pct = (n) => (totalMoves ? Math.round((n / totalMoves) * 100) : 0);
    document.getElementById('movementKpis').innerHTML =
      kpiCard(fmt(totalMoves), 'סך תנועות', true) +
      kpiCard(`${fmt(inter)} · ${pct(inter)}%`, 'תנועות בין-יישוביות') +
      kpiCard(`${fmt(intra)} · ${pct(intra)}%`, 'תנועות תוך-יישוביות', true);

    // Inline plugin: always render the percentage on each slice.
    const pctLabels = {
      id: 'pctLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0) || 1;
        ctx.save();
        ctx.font = '700 15px Heebo, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        meta.data.forEach((arc, i) => {
          const v = chart.data.datasets[0].data[i];
          if (!v) return;
          const p = Math.round((v / total) * 100);
          const { x, y } = arc.tooltipPosition();
          ctx.fillText(p + '%', x, y);
        });
        ctx.restore();
      },
    };

    // Pie
    new Chart(document.getElementById('movementPie'), {
      type: 'doughnut',
      data: {
        labels: ['בין-יישובית', 'תוך-יישובית'],
        datasets: [{ data: [inter, intra], backgroundColor: [BRAND.pink, BRAND.green], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Heebo', size: 14 } } },
          tooltip: {
            callbacks: {
              label: (c) => `${c.label}: ${fmt(c.parsed)} (${Math.round((c.parsed / totalMoves) * 100)}%)`,
            },
          },
        },
      },
      plugins: [pctLabels],
    });

    drawSankey(flows.filter((f) => f.from !== f.to)); // sankey excludes self-loops
  }

  function drawSankey(flows) {
    const host = document.getElementById('sankey');
    host.innerHTML = '';
    const nodeNames = [...new Set(flows.flatMap((f) => [f.from + ' ', ' ' + f.to]))];
    // distinct src/dst namespaces so a city can be both source and target
    const idx = new Map(nodeNames.map((n, i) => [n, i]));
    const nodes = nodeNames.map((n) => ({ name: n }));
    const links = flows.map((f) => ({
      source: idx.get(f.from + ' '), target: idx.get(' ' + f.to), value: f.count, from: f.from, to: f.to,
    }));

    const width = Math.max(host.clientWidth || 600, 520);
    const height = Math.min(Math.max(nodeNames.length * 16, 360), 620);
    const sankey = d3.sankey()
      .nodeWidth(14).nodePadding(10)
      .extent([[1, 6], [width - 1, height - 6]]);
    const graph = sankey({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });

    const svg = d3.select(host).append('svg')
      .attr('width', width).attr('height', height).attr('dir', 'ltr');

    const color = (name) => (name.startsWith(' ') ? BRAND.green : BRAND.pink);

    svg.append('g').selectAll('rect').data(graph.nodes).join('rect')
      .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
      .attr('height', (d) => Math.max(1, d.y1 - d.y0)).attr('width', (d) => d.x1 - d.x0)
      .attr('fill', (d) => color(d.name)).attr('rx', 3)
      .append('title').text((d) => d.name.trim());

    svg.append('g').attr('fill', 'none').selectAll('path').data(graph.links).join('path')
      .attr('d', d3.sankeyLinkHorizontal())
      .attr('stroke', (d) => color(d.target.name))
      .attr('stroke-opacity', 0.32)
      .attr('stroke-width', (d) => Math.max(1, d.width))
      .append('title').text((d) => `${d.from} → ${d.to}: ${d.value}`);

    svg.append('g').selectAll('text').data(graph.nodes).join('text')
      .attr('x', (d) => (d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6))
      .attr('y', (d) => (d.y0 + d.y1) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (d) => (d.x0 < width / 2 ? 'start' : 'end'))
      .text((d) => d.name.trim());
  }

  return { init };
})();
