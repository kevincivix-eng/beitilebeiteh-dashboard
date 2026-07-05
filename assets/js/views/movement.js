/* Movement view: d3-sankey origin→destination + intra/inter-city pie + KPIs.
   The sankey is interactive: hover a city node to see its in/out transfer
   count, click to highlight it (dimming the rest) and scope the top KPI strip
   to that municipality — outbound when an origin (right) node is clicked,
   inbound when a destination (left) node is clicked. */
const MovementView = (() => {
  let kpiData = {};
  let totals = {};
  let allFlows = [];
  let metric = 'moves'; // 'moves' (deliveries) | 'items' (item count)
  const flowVal = (f) => (metric === 'items' ? (f.items || 0) : f.count);
  const MOVE_SUBTITLE = 'זרימת מסירות בין יישובי מוצא ויעד';

  function setSubtitle(txt) {
    const p = document.querySelector('#view-movement .view__head p');
    if (p) p.textContent = txt || MOVE_SUBTITLE;
  }

  // Render the top KPI strip: global totals, or scoped to one city by direction.
  function renderKpis(city, dir) {
    const el = document.getElementById('movementKpis');
    const c = city && kpiData.byCity ? kpiData.byCity[city] : null;
    if (c && dir) {
      const s = c[dir];
      const inb = dir === 'in';
      el.innerHTML =
        kpiCard(fmt(s.deliveries), inb ? 'תנועות נכנסות' : 'תנועות יוצאות', true) +
        kpiCard(fmt(s.items), inb ? 'פריטים שהתקבלו' : 'פריטים שנמסרו') +
        (inb ? '' : kpiCard(fmt(s.weightTon) + ' טון', 'משקל שנמסר', true)) +
        kpiCard(fmt(s.people), 'נהנים') +
        kpiCard(fmt(s.partners), inb ? 'יישובי מוצא' : 'יישובי יעד', true);
      setSubtitle(`מציג: ${city} · ${inb ? 'נכנסות' : 'יוצאות'} (לחצו שוב לניקוי)`);
    } else {
      el.innerHTML =
        kpiCard(fmt(totals.moves), 'סך תנועות (מוצא→יעד)', true) +
        kpiCard(fmt(totals.items), 'מספר חפצים') +
        kpiCard(fmt(totals.inter), 'תנועות בין-יישוביות', true) +
        kpiCard(fmt(totals.intra), 'תנועות תוך-יישוביות');
      setSubtitle(null);
    }
  }

  function init(data) {
    kpiData = data.kpis || {};
    const flows = data.flows || [];
    allFlows = flows;

    // KPIs
    const totalMoves = flows.reduce((s, f) => s + f.count, 0);
    const intra = flows.filter((f) => f.from === f.to).reduce((s, f) => s + f.count, 0);
    const inter = totalMoves - intra;
    const totalItems = kpiData.items;
    totals = { moves: totalMoves, items: totalItems, inter, intra };
    renderKpis(null, null);

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

    // metric toggle next to the sankey title
    const seg = document.getElementById('sankeyMetric');
    if (seg && !seg.dataset.wired) {
      seg.dataset.wired = '1';
      seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
        metric = b.dataset.metric;
        seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        drawSankey();
      }));
    }

    drawSankey();
  }

  function drawSankey() {
    // sankey excludes self-loops; drop zero-value flows for the active metric
    const flows = allFlows.filter((f) => f.from !== f.to && flowVal(f) > 0);
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
      value: flowVal(f), from: f.from, to: f.to,
    }));

    const top = 38, botPad = 14, margin = 28;
    const width = Math.max(host.clientWidth || 700, 560);
    const cardH = Math.max(host.clientHeight || 0, 460);

    const svg = d3.select(host).append('svg')
      .attr('width', width).attr('dir', 'ltr');

    const color = (d) => councilColor(d.name.slice(2).trim());

    // Measure label sizes first so the node width = the name-cube width.
    const measureG = svg.append('g').attr('opacity', 0);
    let maxTW = 0, maxTH = 0;
    measureG.selectAll('text').data(nodes).join('text')
      .attr('class', 'sankey-label').text((d) => d.name.slice(2).trim())
      .each(function () { const b = this.getBBox(); maxTW = Math.max(maxTW, b.width); maxTH = Math.max(maxTH, b.height); });
    measureG.remove();
    const padX = 14, padY = 6;
    const badgeW = Math.ceil(maxTW + padX * 2);
    const badgeH = Math.ceil(maxTH + padY * 2);

    const GAP = 3; // near-zero gap between councils for a dense look

    const originCount = nodes.filter((n) => n.origin).length;
    const maxCount = Math.max(originCount, nodes.length - originCount, 1);

    // Fit everything into the available card height — no scrolling. The SVG
    // height equals the visible area; bars fill it (never below the cube height).
    const availH = Math.max(host.clientHeight || 0, cardH);

    // Run d3 for ordering + relative flow sizes only; we re-lay-out vertically.
    const sankey = d3.sankey()
      .nodeWidth(badgeW).nodePadding(8)
      .extent([[margin, top], [width - margin, availH - botPad]]);
    const graph = sankey({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });

    // Fit each column into availH: every node gets the cube height as a baseline,
    // then the remaining space is shared proportionally to throughput.
    const columns = Array.from(d3.group(graph.nodes, (d) => d.x0).values());
    let contentBottom = top;
    columns.forEach((col) => {
      col.sort((a, b) => a.y0 - b.y0);
      const nC = col.length;
      const gapsT = GAP * (nC - 1);
      const avail = availH - top - botPad;
      const colVal = col.reduce((s, n) => s + (n.value || 0), 0) || 1;
      const extra = Math.max(avail - nC * badgeH - gapsT, 0);
      let cursor = top;
      col.forEach((n) => {
        n.__barH = badgeH + extra * ((n.value || 0) / colVal);
        n.__cyy = cursor + n.__barH / 2;
        cursor += n.__barH + GAP;
      });
      contentBottom = Math.max(contentBottom, cursor - GAP);
    });
    const height = Math.round(Math.max(availH, contentBottom + botPad));
    svg.attr('height', height);

    // Re-stack the links vertically inside the fitted bars. A single global
    // scale keeps every node's ribbons within its bar and preserves relative
    // flow sizes; ribbons are constant-width so d3.sankeyLinkHorizontal works.
    let k = Infinity;
    graph.nodes.forEach((n) => { if (n.value > 0) k = Math.min(k, n.__barH / n.value); });
    if (!isFinite(k)) k = 1;
    graph.nodes.forEach((n) => {
      const place = (lks, endKey) => {
        const arr = (lks || []).slice().sort((a, b) => (a[endKey]) - (b[endKey]));
        const totalW = arr.reduce((s, l) => s + l.value * k, 0);
        let y = n.__cyy - totalW / 2;
        arr.forEach((l) => { const w = l.value * k; l.width = w; l[endKey] = y + w / 2; y += w; });
      };
      place(n.sourceLinks, 'y0'); // this node is the d3-source (destination)
      place(n.targetLinks, 'y1'); // this node is the d3-target (origin)
    });

    // column headers (no arrow — direction conveyed by the side)
    svg.append('text').attr('class', 'sankey-head').attr('x', width - 2).attr('y', 16)
      .attr('text-anchor', 'end').text('מוצא');
    svg.append('text').attr('class', 'sankey-head').attr('x', 2).attr('y', 16)
      .attr('text-anchor', 'start').text('יעד');

    const cy = (d) => d.__cyy;
    const nodeH = (d) => d.__barH;

    // --- proportional sankey links (symmetric, stacked by flow) ---
    const linkSel = svg.append('g').attr('fill', 'none').selectAll('path').data(graph.links).join('path')
      .attr('d', d3.sankeyLinkHorizontal())
      .attr('stroke', (d) => councilColor(d.from)) // colour links by origin council
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', (d) => Math.max(1, d.width));
    linkSel.append('title').text((d) => `${d.from} → ${d.to}: ${d.value}`);

    // --- colored node bar: proportional throughput height, BEHIND the cube ---
    const rectSel = svg.append('g').selectAll('rect').data(graph.nodes).join('rect')
      .attr('class', 'sankey-cube')
      .attr('x', (d) => d.x0).attr('width', badgeW)
      .attr('y', (d) => cy(d) - nodeH(d) / 2).attr('height', nodeH)
      .attr('rx', 10).attr('fill', color)
      .style('cursor', 'pointer');

    // --- white name cube, vertically centered on the colored bar ---
    const badgeSel = svg.append('g').selectAll('rect').data(graph.nodes).join('rect')
      .attr('class', 'sankey-badge')
      .attr('x', (d) => d.x0).attr('width', badgeW)
      .attr('y', (d) => cy(d) - badgeH / 2).attr('height', badgeH)
      .attr('rx', badgeH / 2).attr('fill', '#fff')
      .attr('stroke', color).attr('stroke-opacity', 0.4).attr('stroke-width', 1.25)
      .style('cursor', 'pointer');

    // --- names on top ---
    const labelSel = svg.append('g').selectAll('text').data(graph.nodes).join('text')
      .attr('class', 'sankey-label')
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .style('cursor', 'pointer').style('fill', BRAND.ink)
      .attr('x', (d) => d.x0 + badgeW / 2).attr('y', cy)
      .text((d) => d.name.slice(2).trim());

    // ---- interactivity: hover tooltip + click-to-filter ----
    host.style.position = 'relative';
    let tip = host.querySelector('.sankey-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'sankey-tip'; host.appendChild(tip); }
    let selected = null; // selected node datum

    const isRelated = (d, n) => n === d ||
      graph.links.some((l) => (l.source === d && l.target === n) || (l.target === d && l.source === n));
    const linkTouches = (d, l) => l.source === d || l.target === d;

    function highlight(d) {
      rectSel.attr('opacity', (n) => (isRelated(d, n) ? 1 : 0.15));
      badgeSel.attr('opacity', (n) => (isRelated(d, n) ? 1 : 0.18));
      labelSel.attr('opacity', (n) => (isRelated(d, n) ? 1 : 0.18));
      linkSel.attr('stroke-opacity', (l) => (linkTouches(d, l) ? 0.6 : 0.05));
    }
    function clearHighlight() {
      rectSel.attr('opacity', 1);
      badgeSel.attr('opacity', 1);
      labelSel.attr('opacity', 1);
      linkSel.attr('stroke-opacity', 0.3);
    }
    function showTip(ev, d) {
      const city = d.name.slice(2).trim();
      const dir = d.origin ? 'out' : 'in';
      const field = metric === 'items' ? 'items' : 'deliveries';
      const stat = (kpiData.byCity && kpiData.byCity[city]) ? kpiData.byCity[city][dir][field] : Math.round(d.value);
      const label = metric === 'items'
        ? (d.origin ? 'פריטים יוצאים' : 'פריטים נכנסים')
        : (d.origin ? 'העברות יוצאות' : 'העברות נכנסות');
      tip.innerHTML = `<strong>${city}</strong><br>${label}: ${fmt(stat)}`;
      tip.style.display = 'block';
      const r = host.getBoundingClientRect();
      tip.style.left = (ev.clientX - r.left + 14) + 'px';
      tip.style.top = (ev.clientY - r.top + 14) + 'px';
    }

    const attach = (sel) => sel
      .on('mousemove', (ev, d) => { showTip(ev, d); if (!selected) highlight(d); })
      .on('mouseout', () => { tip.style.display = 'none'; if (!selected) clearHighlight(); })
      .on('click', (ev, d) => {
        ev.stopPropagation();
        if (selected === d) {
          selected = null; clearHighlight(); renderKpis(null, null);
        } else {
          selected = d; highlight(d);
          renderKpis(d.name.slice(2).trim(), d.origin ? 'out' : 'in');
        }
      });
    attach(rectSel);
    attach(badgeSel);
    attach(labelSel);
    svg.on('click', () => { if (selected) { selected = null; clearHighlight(); renderKpis(null, null); } });
  }

  return { init };
})();
