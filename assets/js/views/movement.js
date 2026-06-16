/* Movement view: d3-sankey origin→destination + intra/inter-city pie + KPIs. */
const MovementView = (() => {
  function init(data) {
    const flows = data.flows || [];

    // KPIs
    const totalMoves = flows.reduce((s, f) => s + f.count, 0);
    const intra = flows.filter((f) => f.from === f.to).reduce((s, f) => s + f.count, 0);
    const inter = totalMoves - intra;
    const totalItems = (data.kpis || {}).items;
    document.getElementById('movementKpis').innerHTML =
      kpiCard(fmt(totalMoves), 'סך תנועות (מוצא→יעד)', true) +
      kpiCard(fmt(totalItems), 'מספר חפצים') +
      kpiCard(fmt(inter), 'תנועות בין-יישוביות', true) +
      kpiCard(fmt(intra), 'תנועות תוך-יישוביות');

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

    // Origins must appear on the RIGHT (RTL reading) and destinations on the LEFT.
    // d3-sankey always places link-sources on the left and link-targets on the
    // right, so we map d3-source = destination and d3-target = origin.
    const ORG = 'מ:', DST = 'ל:';
    const orgName = (f) => `${ORG} ${f.from}`;
    const dstName = (f) => `${DST} ${f.to}`;
    const nodeNames = [...new Set(flows.flatMap((f) => [dstName(f), orgName(f)]))];
    const idx = new Map(nodeNames.map((n, i) => [n, i]));
    const nodes = nodeNames.map((n) => ({ name: n, origin: n.startsWith(ORG) }));
    const links = flows.map((f) => ({
      source: idx.get(dstName(f)), target: idx.get(orgName(f)),
      value: f.count, from: f.from, to: f.to,
    }));

    const margin = 86, top = 30;
    const width = Math.max(host.clientWidth || 700, 560);
    const height = Math.min(Math.max(nodeNames.length * 17, 380), 700);
    const sankey = d3.sankey()
      .nodeWidth(14).nodePadding(11)
      .extent([[margin, top], [width - margin, height - 8]]);
    const graph = sankey({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });

    const svg = d3.select(host).append('svg')
      .attr('width', width).attr('height', height).attr('dir', 'ltr');

    const color = (d) => (d.origin ? BRAND.pink : BRAND.green);

    // column headers (no arrow — direction conveyed by labels)
    svg.append('text').attr('class', 'sankey-head').attr('x', width - 2).attr('y', 16)
      .attr('text-anchor', 'end').text('מוצא');
    svg.append('text').attr('class', 'sankey-head').attr('x', 2).attr('y', 16)
      .attr('text-anchor', 'start').text('יעד');

    svg.append('g').selectAll('rect').data(graph.nodes).join('rect')
      .attr('x', (d) => d.x0).attr('y', (d) => d.y0)
      .attr('height', (d) => Math.max(1, d.y1 - d.y0)).attr('width', (d) => d.x1 - d.x0)
      .attr('fill', color).attr('rx', 3)
      .append('title').text((d) => d.name.slice(2).trim());

    svg.append('g').attr('fill', 'none').selectAll('path').data(graph.links).join('path')
      .attr('d', d3.sankeyLinkHorizontal())
      .attr('stroke', (d) => (d.target.origin ? BRAND.pink : BRAND.green))
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', (d) => Math.max(1, d.width))
      .append('title').text((d) => `${d.from} → ${d.to}: ${d.value}`);

    // outer labels: destinations to the far left, origins to the far right
    svg.append('g').selectAll('text').data(graph.nodes).join('text')
      .attr('class', 'sankey-label')
      .attr('x', (d) => (d.origin ? d.x1 + 7 : d.x0 - 7))
      .attr('y', (d) => (d.y0 + d.y1) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (d) => (d.origin ? 'start' : 'end'))
      .text((d) => d.name.slice(2).trim());
  }

  return { init };
})();
