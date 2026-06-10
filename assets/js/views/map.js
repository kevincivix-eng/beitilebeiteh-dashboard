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

  // Brand-tinted per-location colors (pinks & greens rotation)
  const palette = ['#da91bf', '#4e724d', '#c46ca6', '#7fa37e', '#a85a8c', '#6b8f6a',
    '#e0a3cf', '#9bbf9a', '#cf7fb6', '#5c7d5b', '#b863a0', '#8aae89', '#d49cc6'];
  const locColors = {};

  let map, flows = [];
  const filters = { location: null, thickness: null, viewMode: 'outbound' };

  const getWeight = (c) => (c <= 10 ? 4 : c <= 50 ? 8 : 14);
  const getColor = (k) => locColors[k] || '#9b8fa6';
  const checkThickness = (c, r) =>
    r === 'low' ? c <= 10 : r === 'medium' ? c > 10 && c <= 50 : r === 'high' ? c > 50 : true;

  function curvedPath(start, end, offset) {
    const [lat1, lng1] = start, [lat2, lng2] = end;
    const dx = lng2 - lng1, dy = lat2 - lat1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [start, end];
    const oLat1 = lat1 + (-dx / len) * offset, oLng1 = lng1 + (dy / len) * offset;
    const oLat2 = lat2 + (-dx / len) * offset, oLng2 = lng2 + (dy / len) * offset;
    const cLat = (oLat1 + oLat2) / 2 + -dx * 0.15, cLng = (oLng1 + oLng2) / 2 + dy * 0.15;
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      pts.push([a * oLat1 + b * cLat + c * oLat2, a * oLng1 + b * cLng + c * oLng2]);
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

      const latlngs = curvedPath([start.lat, start.lng], [end.lat, end.lng], 0.012);
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

  function buildLegend() {
    const origins = Object.keys(locColors);
    const el = document.getElementById('mapLegend');
    el.innerHTML = `
      <div class="legend-mode">
        <span class="legend-mode__label" id="mapModeLabel">מוצא החפץ</span>
        <button class="legend-mode__btn" id="mapModeBtn" title="החלפת כיוון">↗︎ יוצא</button>
      </div>
      <h4>מקרא (לחץ לסינון)</h4>
      ${origins.map((o) => `
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
      const out = filters.viewMode === 'outbound';
      document.getElementById('mapModeLabel').textContent = out ? 'מוצא החפץ' : 'יעד החפץ';
      document.getElementById('mapModeBtn').textContent = out ? '↗︎ יוצא' : '↙︎ נכנס';
      drawFlows();
    });
  }

  function init(data) {
    const k = data.kpis || {};
    document.getElementById('homeKpis').innerHTML =
      kpiCard(fmt(k.deliveries), 'מסירות', true) +
      kpiCard(fmt(k.items), 'פריטים שנמסרו') +
      kpiCard(fmt(k.weightTon) + ' טון', 'משקל כולל', true) +
      kpiCard(fmt(k.people), 'נהנים') +
      kpiCard(fmt(k.cities), 'יישובים פעילים');

    flows = (data.flows || []).map((f) => ({ ...f }));
    const origins = [...new Set(flows.map((f) => f.from))].sort();
    origins.forEach((o, i) => (locColors[o] = palette[i % palette.length]));

    map = L.map('map', { center: [31.22, 34.92], zoom: 10, zoomControl: false });
    L.control.zoom({ position: 'topleft' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19,
    }).addTo(map);

    const active = new Set(flows.flatMap((f) => [f.from, f.to]));
    Object.keys(locations).forEach((key) => {
      if (!active.has(key)) return;
      const loc = locations[key];
      L.circleMarker([loc.lat, loc.lng], {
        radius: 5, fillColor: BRAND.green, color: '#fff', weight: 2, fillOpacity: 0.9,
      }).addTo(map).bindPopup(`<div class="popup-title">${key}</div>`);
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
