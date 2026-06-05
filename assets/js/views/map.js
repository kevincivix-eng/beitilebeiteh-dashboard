/* Home view: Leaflet flow map + KPI strip. Geometry reused from original repo. */
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

  // Brand-tinted per-origin colors (pinks & greens rotation)
  const palette = ['#da91bf', '#4e724d', '#c46ca6', '#7fa37e', '#a85a8c', '#6b8f6a',
    '#e8b6d6', '#9bbf9a', '#cf7fb6', '#5c7d5b', '#b863a0', '#8aae89', '#d49cc6'];
  const locColors = {};
  Object.keys(locations).forEach((k, i) => (locColors[k] = palette[i % palette.length]));

  let map, flows = [], state = { origin: null };

  function getWeight(c) { return c <= 10 ? 3 : c <= 50 ? 7 : 13; }

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
    flows.forEach((fl) => {
      (fl.layers || []).forEach((l) => map.removeLayer(l));
      fl.layers = [];
      if (state.origin && fl.from !== state.origin) return;
      const a = locations[fl.from], b = locations[fl.to];
      if (!a || !b) return;
      const color = locColors[fl.from] || '#999';
      const weight = getWeight(fl.count);
      if (fl.from === fl.to) {
        const m = L.circleMarker([a.lat, a.lng], {
          radius: 6 + Math.min(fl.count / 8, 18), color, fillColor: color,
          fillOpacity: 0.25, weight: 2,
        }).bindPopup(`<div class="popup-title">${fl.from} → ${fl.to}</div>${fl.count} מסירות`);
        m.addTo(map); fl.layers.push(m);
        return;
      }
      const path = curvedPath([a.lat, a.lng], [b.lat, b.lng], 0.012);
      const line = L.polyline(path, { color, weight, opacity: 0.78, lineCap: 'round' })
        .bindPopup(`<div class="popup-title">${fl.from} → ${fl.to}</div>${fl.count} מסירות`);
      line.addTo(map); fl.layers.push(line);
    });
  }

  function buildLegend() {
    const el = document.getElementById('mapLegend');
    const origins = [...new Set(flows.map((f) => f.from))].sort();
    el.innerHTML = '<h4>סינון לפי יישוב מוצא</h4>' +
      origins.map((o) =>
        `<div class="legend-item" data-o="${o}"><span class="legend-dot" style="background:${locColors[o]}"></span>${o}</div>`
      ).join('') +
      `<div class="legend-item" data-o="" style="margin-top:6px;font-weight:700"><span class="legend-dot" style="background:var(--ink)"></span>הצג הכל</div>`;
    el.querySelectorAll('.legend-item').forEach((it) =>
      it.addEventListener('click', () => {
        const o = it.dataset.o || null;
        state.origin = state.origin === o ? null : o;
        el.querySelectorAll('.legend-item').forEach((x) =>
          (x.style.opacity = !state.origin || x.dataset.o === state.origin || x.dataset.o === '' ? '1' : '0.4'));
        drawFlows();
      })
    );
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

    drawFlows();
    buildLegend();
    setTimeout(() => map.invalidateSize(), 200);
  }

  return { init };
})();
