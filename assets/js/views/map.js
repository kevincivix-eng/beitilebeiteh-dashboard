/* Home view: Leaflet flow map + KPI strip.
   Restores the original map behaviour (inbound/outbound toggle, animated flow
   lines, thickness + location filters, auto-zoom) in the new brand styling. */
const MapView = (() => {
  const locations = {
    'אל קסום': { lat: 31.28444, lng: 34.91611 },
    'חורה': { lat: 31.3004, lng: 34.935688 },
    'כסיפה': { lat: 31.245278, lng: 35.092778 },
    'לקיה': { lat: 31.324884, lng: 34.866219 },
    'תל שבע': { lat: 31.246667, lng: 34.856111 },
    'ערערה בנגב': { lat: 31.160927, lng: 35.019757 },
    'נווה מדבר': { lat: 31.02417, lng: 34.70417 },
    'רהט': { lat: 31.39547, lng: 34.75699 },
    'שגב שלום': { lat: 31.19918, lng: 34.83956 },
    'ערד': { lat: 31.2588, lng: 35.2128 },
    'חברון': { lat: 31.5326, lng: 35.0998 },
    'אופקים': { lat: 31.3147, lng: 34.6203 },
    'באר שבע': { lat: 31.2518, lng: 34.7913 },
  };

  // Per-council colours come from the shared palette (councilColor in app.js)
  const locColors = {};

  let map, flows = [], kpiData = {};
  const filters = { location: null, thickness: null, viewMode: 'outbound' };

  const HOME_SUBTITLE = 'זרימת המסירות בין יישובי הנגב המזרחי';

  // Render the home KPI strip — global totals, or scoped to a single city when
  // a location filter is active on the map. When scoped, the numbers follow the
  // map's direction toggle: outbound = items the city sent, inbound = received.
  function renderKpis(loc) {
    const k = kpiData || {};
    const entry = loc && k.byCity ? k.byCity[loc] : null;
    const inbound = filters.viewMode === 'inbound';
    // entry may be the new {out,in} shape or (legacy) a flat object
    const c = entry ? (entry.out ? entry[inbound ? 'in' : 'out'] : entry) : null;
    const el = document.getElementById('homeKpis');
    if (!el) return;
    if (c) {
      el.innerHTML =
        kpiCard(fmt(c.deliveries), inbound ? 'מסירות שהתקבלו' : 'מסירות שיצאו') +
        kpiCard(fmt(c.items), inbound ? 'פריטים שהתקבלו' : 'פריטים שנמסרו', true) +
        // weight is only meaningful on the outbound side (origin-based measure)
        (inbound ? '' : kpiCard(fmt(c.weightTon) + ' טון', 'משקל שנמסר')) +
        kpiCard(fmt(c.people), 'נהנים', true) +
        kpiCard(fmt(c.partners), inbound ? 'יישובי מוצא' : 'יישובי יעד');
    } else {
      el.innerHTML =
        (k.members != null ? kpiCard(fmt(k.members), 'מספר משתתפות', true) : '') +
        kpiCard(fmt(k.deliveries), 'מסירות') +
        kpiCard(fmt(k.items), 'פריטים שנמסרו', true) +
        kpiCard(fmt(k.weightTon) + ' טון', 'משקל כולל') +
        kpiCard(fmt(k.people), 'נהנים', true) +
        kpiCard(fmt(k.cities), 'יישובים פעילים');
    }
    const sub = document.querySelector('#view-home .view__head p');
    if (sub) sub.textContent = loc
      ? `מציג נתונים עבור: ${loc} (${inbound ? 'פריטים נכנסים' : 'פריטים יוצאים'})`
      : HOME_SUBTITLE;
  }

  const getWeight = (c) => (c <= 10 ? 4 : c <= 50 ? 8 : 14);
  const getColor = (k) => locColors[k] || '#9b8fa6';
  const checkThickness = (c, r) =>
    r === 'low' ? c <= 10 : r === 'medium' ? c > 10 && c <= 50 : r === 'high' ? c > 50 : true;

  // Quadratic bezier anchored EXACTLY at the two city points; only the middle
  // bows out (to the right of travel direction) so A→B and B→A separate while
  // both endpoints still touch their markers precisely.
  function curvedPath(start, end, curvature) {
    const [lat1, lng1] = start, [lat2, lng2] = end;
    const dx = lng2 - lng1, dy = lat2 - lat1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [start, end];
    // perpendicular (right normal) unit vector, scaled by distance for a gentle arc
    const nLat = (-dx / len) * len * curvature;
    const nLng = (dy / len) * len * curvature;
    const cLat = (lat1 + lat2) / 2 + nLat;
    const cLng = (lng1 + lng2) / 2 + nLng;
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      pts.push([a * lat1 + b * cLat + c * lat2, a * lng1 + b * cLng + c * lng2]);
    }
    return pts;
  }

  function drawFlows() {
    const bounds = [];
    flows.forEach((fl) => {
      (fl.layers || []).forEach((l) => map.removeLayer(l));
      fl.layers = [];
    });

    flows.forEach((fl) => {
      const outbound = filters.viewMode === 'outbound';
      const srcKey = outbound ? fl.from : fl.to;
      const dstKey = outbound ? fl.to : fl.from;
      const start = locations[srcKey], end = locations[dstKey];
      if (!start || !end) return;
      bounds.push([start.lat, start.lng], [end.lat, end.lng]);

      const color = getColor(outbound ? fl.from : fl.to);
      const tip = `<div class="popup-title">${fl.from} &larr; ${fl.to}</div><div class="popup-stat">העברות: <strong>${fl.count}</strong></div>`;

      // Self-loop → ring marker
      if (fl.from === fl.to) {
        const circle = L.circleMarker([start.lat, start.lng], {
          radius: 9 + getWeight(fl.count), color, fill: false, weight: getWeight(fl.count) / 2, opacity: 0.85,
        }).addTo(map).bindTooltip(tip, { sticky: true, direction: 'top', className: 'custom-tooltip' });
        fl.layers.push(circle);
        return;
      }

      const latlngs = curvedPath([start.lat, start.lng], [end.lat, end.lng], 0.18);
      const base = L.polyline(latlngs, { color, weight: getWeight(fl.count), opacity: 0.8, lineCap: 'round' })
        .addTo(map)
        .bindTooltip(tip, { sticky: true, direction: 'top', className: 'custom-tooltip' });
      fl.layers.push(base);

      // animated dash always moves physically from→to
      const anim = L.polyline(outbound ? latlngs : latlngs.slice().reverse(), {
        color: '#fff', weight: Math.max(2, getWeight(fl.count) / 3), opacity: 0.7,
        dashArray: '8, 60', className: 'flow-anim',
      }).addTo(map);
      fl.layers.push(anim);
    });

    updateMapVisibility();
    if (bounds.length) {
      const b = L.latLngBounds(bounds);
      if (b.isValid()) map.fitBounds(b, { padding: [50, 50] });
    }
  }

  function updateMapVisibility() {
    flows.forEach((fl) => {
      if (!fl.layers) return;
      const loc = filters.viewMode === 'outbound' ? fl.from : fl.to;
      const visible = (!filters.location || loc === filters.location) &&
        (!filters.thickness || checkThickness(fl.count, filters.thickness));
      fl.layers.forEach((l) => (visible ? l.addTo(map) : map.removeLayer(l)));
    });
    updateLegendUI();
    renderKpis(filters.location);
  }

  function updateLegendUI() {
    document.querySelectorAll('#mapLegend .legend-item[data-type="location"]').forEach((it) => {
      const on = filters.location === it.dataset.value;
      it.classList.toggle('active-filter', on);
      it.style.opacity = filters.location && !on ? '0.4' : '1';
    });
    document.querySelectorAll('#mapLegend .legend-item[data-type="thickness"]').forEach((it) => {
      const on = filters.thickness === it.dataset.value;
      it.classList.toggle('active-filter', on);
      it.style.opacity = filters.thickness && !on ? '0.4' : '1';
    });
    const reset = document.getElementById('mapReset');
    if (reset) reset.style.display = filters.location || filters.thickness ? 'block' : 'none';
  }

  // Cities shown in the legend depend on direction: origins when looking at
  // outbound flows, destinations when looking at inbound — so receiving-only
  // cities (e.g. חברון) are selectable in inbound mode.
  function legendCities() {
    const out = filters.viewMode === 'outbound';
    return [...new Set(flows.map((f) => (out ? f.from : f.to)))].sort();
  }

  function buildLegend() {
    const out = filters.viewMode === 'outbound';
    const cities = legendCities();
    const el = document.getElementById('mapLegend');
    el.innerHTML = `
      <div class="legend-mode">
        <span class="legend-mode__label" id="mapModeLabel">${out ? 'מוצא החפץ' : 'יעד החפץ'}</span>
        <button class="legend-mode__btn" id="mapModeBtn" title="החלפת כיוון">${out ? '↗︎ יוצא' : '↙︎ נכנס'}</button>
      </div>
      <h4>מקרא (לחץ לסינון)</h4>
      ${cities.map((o) => `
        <div class="legend-item" data-type="location" data-value="${o}">
          <span class="legend-dot" style="background:${locColors[o]}"></span><span>${o}</span>
        </div>`).join('')}
      <hr class="legend-hr">
      <h4>עובי קו (כמות)</h4>
      <div class="legend-item" data-type="thickness" data-value="low"><span class="legend-dot" style="height:3px"></span><span>1–10</span></div>
      <div class="legend-item" data-type="thickness" data-value="medium"><span class="legend-dot" style="height:6px"></span><span>11–50</span></div>
      <div class="legend-item" data-type="thickness" data-value="high"><span class="legend-dot" style="height:10px"></span><span>50+</span></div>
      <div id="mapReset" class="legend-reset">נקה סינון</div>`;

    el.querySelectorAll('.legend-item').forEach((it) =>
      it.addEventListener('click', () => {
        const t = it.dataset.type, v = it.dataset.value;
        if (t === 'location') filters.location = filters.location === v ? null : v;
        else filters.thickness = filters.thickness === v ? null : v;
        updateMapVisibility();
      })
    );
    document.getElementById('mapReset').addEventListener('click', () => {
      filters.location = null; filters.thickness = null; updateMapVisibility();
    });
    document.getElementById('mapModeBtn').addEventListener('click', () => {
      filters.viewMode = filters.viewMode === 'outbound' ? 'inbound' : 'outbound';
      filters.location = null;
      buildLegend(); // rebuild location list for the new direction
      drawFlows();
    });
  }

  function init(data) {
    kpiData = data.kpis || {};
    renderKpis(null);

    flows = (data.flows || []).map((f) => ({ ...f }));
    const allCities = [...new Set(flows.flatMap((f) => [f.from, f.to]))].sort();
    allCities.forEach((c) => (locColors[c] = councilColor(c)));

    map = L.map('map', { center: [31.22, 34.92], zoom: 10, zoomControl: false });
    L.control.zoom({ position: 'topleft' }).addTo(map);
    // CARTO's free basemap tiles now require an API key (they show an
    // "API KEY REQUIRED" watermark without one) — use Esri's light gray
    // canvas instead, a free no-key basemap with a similar light aesthetic.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; OpenStreetMap &copy; Esri', maxZoom: 19, maxNativeZoom: 16,
    }).addTo(map);

    const active = new Set(flows.flatMap((f) => [f.from, f.to]));
    Object.keys(locations).forEach((key) => {
      if (!active.has(key)) return;
      const loc = locations[key];
      L.circleMarker([loc.lat, loc.lng], {
        radius: 5, fillColor: councilColor(key), color: '#fff', weight: 2, fillOpacity: 0.9,
      }).addTo(map)
        .bindTooltip(key, { direction: 'top', className: 'custom-tooltip' })
        .on('click', () => {
          filters.location = filters.location === key ? null : key;
          updateMapVisibility();
        });
      L.marker([loc.lat, loc.lng], {
        icon: L.divIcon({ className: 'location-label', html: key, iconSize: [90, 18], iconAnchor: [45, -8] }),
      }).addTo(map);
    });

    buildLegend();
    drawFlows();
    setTimeout(() => map.invalidateSize(), 200);
  }

  return { init };
})();
