// Spatial analysis, the Analyse tab of "Lagen en gereedschap": figures for an
// area (a radius around the address or a drawn polygon), a density grid over
// the neighbourhood, and walking or cycling distance rings with what lies
// within them. Loaded as a classic script; see index.html for the load order.

const analysis = { mode: 'straal', drawing: false, points: [], run: 0, heatRun: 0 };
const AREA_MAX_KM2 = 4;
const HEAT_RADIUS = 750, HEAT_CELL = 50;

// ---------- Tabs in the drawer ----------

const TAB_KEY = 'adresrapport.drawerTab';
const drawerTabs = [...document.querySelectorAll('#drawer-tabs [role=tab]')];

function showDrawerTab(name) {
  for (const t of drawerTabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  try { localStorage.setItem(TAB_KEY, name); } catch {}
}
for (const t of drawerTabs) {
  t.addEventListener('click', () => showDrawerTab(t.dataset.tab));
  // Arrow keys move between the tabs, as in any tab list.
  t.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const next = drawerTabs[(drawerTabs.indexOf(t) + step + drawerTabs.length) % drawerTabs.length];
    showDrawerTab(next.dataset.tab);
    next.focus();
  });
}
try { showDrawerTab(localStorage.getItem(TAB_KEY) || 'lagen'); } catch { showDrawerTab('lagen'); }

// ---------- Helpers ----------

function circlePolygon(lon, lat, r, n = 64) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2;
    ring.push([lon + Math.sin(a) * r / kx, lat + Math.cos(a) * r / 110574]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function bboxOf(ring) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Centre of a (multi)polygon's first outer ring: good enough to decide
// whether a building lies in the area.
function ringCentre(geometry) {
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

const median = values => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (n, total) => `${nf.format(Math.round(n / total * 100))}%`;

function addRows(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------- Area analysis ----------

function setAreaMode(mode) {
  analysis.mode = mode;
  $('area-radius-mode').setAttribute('aria-pressed', mode === 'straal');
  $('area-draw-mode').setAttribute('aria-pressed', mode === 'tekenen');
  $('area-radius-row').hidden = mode !== 'straal';
  $('area-draw-hint').hidden = mode !== 'tekenen';
  $('area-run').hidden = mode !== 'straal';
  if (mode === 'tekenen') startDrawing();
  else stopDrawing();
}
$('area-radius-mode').addEventListener('click', () => setAreaMode('straal'));
$('area-draw-mode').addEventListener('click', () => setAreaMode('tekenen'));
$('area-radius').addEventListener('input', () => {
  $('area-radius-value').textContent = `${nf.format(Number($('area-radius').value))} m`;
  if (current && analysis.mode === 'straal') showArea(circlePolygon(current.lon, current.lat, Number($('area-radius').value)));
});
$('area-run').addEventListener('click', () => {
  if (!current) { $('area-status').textContent = 'Kies eerst een adres.'; return; }
  analyseArea(circlePolygon(current.lon, current.lat, Number($('area-radius').value)));
});

function showArea(geometry) {
  setLayerData('analyse-gebied', geometry ? [{ type: 'Feature', properties: {}, geometry }] : []);
}

// Drawing: click points on the map, double-click (or click the first point
// again) to close the area; Escape stops.
function startDrawing() {
  if (measure.mode) stopMeasure(false);
  Object.assign(analysis, { drawing: true, points: [] });
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  showArea(null);
  $('area-result').replaceChildren();
  $('area-status').textContent = '';
}

function stopDrawing() {
  if (!analysis.drawing) return;
  analysis.drawing = false;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  drawPreview();
}

function drawPreview(cursor) {
  const pts = cursor ? [...analysis.points, cursor] : analysis.points;
  const features = [];
  if (pts.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  for (const p of analysis.points) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
  setLayerData('analyse-tekenen', analysis.drawing ? features : []);
}

function finishDrawing() {
  const pts = analysis.points;
  stopDrawing();
  if (pts.length < 3) {
    $('area-status').textContent = 'Een gebied heeft minstens drie punten nodig. Kies Zelf tekenen om opnieuw te beginnen.';
    return;
  }
  analyseArea({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
}

map.on('click', e => {
  if (!analysis.drawing) return;
  const p = [e.lngLat.lng, e.lngLat.lat];
  // Clicking near the first point closes the area.
  if (analysis.points.length >= 3) {
    const first = map.project(analysis.points[0]);
    if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) { finishDrawing(); return; }
  }
  analysis.points.push(p);
  drawPreview();
});
map.on('dblclick', e => {
  if (!analysis.drawing) return;
  e.preventDefault();
  // The double click's two clicks each added a point; drop the duplicate.
  analysis.points.pop();
  finishDrawing();
});
map.on('mousemove', e => { if (analysis.drawing && analysis.points.length) drawPreview([e.lngLat.lng, e.lngLat.lat]); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && analysis.drawing) {
    analysis.points = [];
    stopDrawing();
    setAreaMode('straal');
  }
});

async function analyseArea(geometry) {
  const run = ++analysis.run;
  const ring = geometry.coordinates[0];
  const area = areaM2(geometry);
  showArea(geometry);
  $('area-result').replaceChildren();
  if (area > AREA_MAX_KM2 * 1e6) {
    $('area-status').textContent = `Dit gebied is ${nf1.format(area / 1e6)} km²; analyseer maximaal ${AREA_MAX_KM2} km² tegelijk.`;
    return;
  }
  $('area-status').textContent = 'Gebied analyseren…';
  const [minLon, minLat, maxLon, maxLat] = bboxOf(ring);
  const [x0, y0] = wgs84ToRd(minLon, minLat), [x1, y1] = wgs84ToRd(maxLon, maxLat);
  const rdBox = [x0, y0, x1, y1];
  const wgsBox = [minLon, minLat, maxLon, maxLat].join(',');
  const centre = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const reach = distanceM(centre[0], centre[1], maxLon, maxLat);
  const inside = p => pointInGeometry(p, geometry);
  try {
    const [panden, heights, pois, treesFound, monuments] = await Promise.all([
      track(fetchAllFeatures(`${BAG}/collections/pand/items?f=json&limit=1000&bbox=${wgsBox}`, 12)),
      getJSON(`${BAG3D_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAG3D:lod12&outputFormat=application/json` +
        `&count=40000&bbox=${rdBox.map(Math.round).join(',')},EPSG:28992&propertyName=identificatie,b3_h_70p,b3_h_maaiveld`).catch(() => null),
      track(fetchPois(centre[0], centre[1], reach)).catch(() => null),
      track(fetchAllFeatures(`${BGT_TREES}?f=json&limit=1000&bbox=${wgsBox}`, 12)).catch(() => null),
      rceWfs(RCE_WFS, 'openbaar:rijksmonumentpunten', rdBox).catch(() => null)
    ]);
    if (run !== analysis.run) return;
    const gone = /gesloopt|niet gerealiseerd|ten onrechte|ingetrokken/i;
    const mine = panden.filter(f => f.geometry && !gone.test(f.properties.status || '') && inside(ringCentre(f.geometry)));
    const heightById = new Map((heights?.features || []).map(f => [String(f.properties.identificatie).replace('NL.IMBAG.Pand.', ''), f.properties.b3_h_70p - f.properties.b3_h_maaiveld]));
    const rows = [['Oppervlakte gebied', area < 1e6 ? `${nf.format(Math.round(area / 100) * 100)} m²` : `${nf1.format(area / 1e6)} km²`]];
    if (!mine.length) {
      rows.push(['Panden', 'geen']);
    } else {
      const units = mine.reduce((s, f) => s + (f.properties.aantal_verblijfsobjecten || 0), 0);
      rows.push(['Panden', `${nf.format(mine.length)} · ${nf.format(units)} verblijfsobjecten`]);
      const years = mine.map(f => f.properties.bouwjaar).filter(isKnownYear);
      if (years.length) {
        const before = years.filter(y => y < 1945).length, after = years.filter(y => y >= 1990).length;
        rows.push(['Bouwjaar (mediaan)', String(Math.round(median(years)))]);
        rows.push(['Bouwperiode', `vóór 1945 ${pct(before, years.length)} · 1945–1989 ${pct(years.length - before - after, years.length)} · vanaf 1990 ${pct(after, years.length)}`]);
      }
      const uses = new Map();
      for (const f of mine) for (const u of String(f.properties.gebruiksdoel || '').split(',').map(s => s.trim()).filter(Boolean)) uses.set(u, (uses.get(u) || 0) + 1);
      if (uses.size) rows.push(['Gebruik', [...uses].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u, n]) => `${u} ${pct(n, mine.length)}`).join(' · ')]);
      const hs = mine.map(f => heightById.get(f.properties.identificatie)).filter(h => h > 0);
      if (hs.length) rows.push(['Hoogte', `mediaan ${nf1.format(median(hs))} m · hoogste ${nf.format(Math.round(Math.max(...hs)))} m`]);
      const built = mine.reduce((s, f) => s + areaM2(f.geometry), 0);
      rows.push(['Bebouwd', `${pct(Math.min(built, area), area)} van het gebied`]);
    }
    if (treesFound) rows.push(['Bomen', nf.format(treesFound.filter(f => f.geometry?.type === 'Point' && inside(f.geometry.coordinates)).length)]);
    if (monuments) rows.push(['Rijksmonumenten', nf.format(monuments.features.filter(f => f.geometry?.type === 'Point' && inside(f.geometry.coordinates)).length)]);
    if (pois) {
      const counts = AMENITIES.map(a => [a.label.toLowerCase(), pois.filter(p => a.is(p.props) && inside([p.lon, p.lat])).length]).filter(([, n]) => n);
      rows.push(['Voorzieningen', counts.length ? counts.map(([l, n]) => `${l} ${nf.format(n)}`).join(' · ') : 'geen']);
    }
    const dl = document.createElement('dl');
    addRows(dl, rows);
    $('area-result').replaceChildren(dl);
    $('area-status').textContent = panden.length >= 12000 ? 'Let op: het gebied heeft heel veel panden; niet alle zijn meegeteld.' : '';
  } catch (err) {
    if (run !== analysis.run) return;
    console.error(err);
    $('area-status').textContent = `Analyse lukte niet: ${err.message}`;
  }
}

// ---------- Density as a heatmap ----------

// A grid of 50 × 50 m cells over 750 m around the address, coloured by how
// much of each cell is built on, the median construction year or the
// average height of the buildings whose centre lies in it.
const HEAT_RAMPS = {
  dichtheid: ['#deebf7', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  hoogte: ['#fee6ce', '#fdae6b', '#fd8d3c', '#e6550d', '#a63603']
};
const HEAT_STEPS = { dichtheid: [0.1, 0.25, 0.4, 0.55], hoogte: [6, 10, 15, 25] };

async function updateHeatmap() {
  const metric = $('heat-metric').value;
  const run = ++analysis.heatRun;
  $('heat-legend').hidden = !metric;
  $('heat-year-legend').hidden = metric !== 'bouwjaar';
  if (!metric || !current) {
    setLayerData('heatmap', []);
    $('heat-info').textContent = metric ? 'Kies eerst een adres.' : '';
    return;
  }
  const ctx = current;
  $('heat-info').textContent = 'Heatmap berekenen…';
  try {
    analysis.heatData = analysis.heatFor === ctx ? analysis.heatData : await getJSON(`${BAG3D_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAG3D:lod12` +
      `&outputFormat=application/json&srsName=EPSG:28992&count=40000&bbox=${[ctx.x - HEAT_RADIUS, ctx.y - HEAT_RADIUS, ctx.x + HEAT_RADIUS, ctx.y + HEAT_RADIUS].map(Math.round).join(',')},EPSG:28992` +
      `&propertyName=identificatie,oorspronkelijkbouwjaar,b3_h_70p,b3_h_maaiveld,geom`);
    analysis.heatFor = ctx;
    if (run !== analysis.heatRun || current !== ctx) return;
    const cells = heatCells(analysis.heatData.features, ctx, metric);
    const ramp = HEAT_RAMPS[metric], steps = HEAT_STEPS[metric];
    const features = cells.map(c => {
      const corners = [[c.x, c.y], [c.x + HEAT_CELL, c.y], [c.x + HEAT_CELL, c.y + HEAT_CELL], [c.x, c.y + HEAT_CELL], [c.x, c.y]].map(([x, y]) => rdToWgs84(x, y));
      const color = metric === 'bouwjaar' ? null : ramp[steps.filter(s => c.value >= s).length];
      return { type: 'Feature', properties: { bouwjaar: metric === 'bouwjaar' ? c.value : 0, kleur: color }, geometry: { type: 'Polygon', coordinates: [corners] } };
    });
    map.setPaintProperty('heatmap', 'fill-color', metric === 'bouwjaar' ? yearColor : ['get', 'kleur']);
    await setLayerData('heatmap', features);
    if (metric !== 'bouwjaar') {
      $('heat-ramp').style.background = `linear-gradient(to right, ${ramp.join(', ')})`;
      const fmt = metric === 'dichtheid' ? s => `${Math.round(s * 100)}%` : s => `${s} m`;
      $('heat-lo').textContent = metric === 'dichtheid' ? '< 10% bebouwd' : '< 6 m';
      $('heat-hi').textContent = `≥ ${fmt(steps[steps.length - 1])}`;
    }
    $('heat-info').textContent = `${nf.format(cells.length)} vakken van ${HEAT_CELL} × ${HEAT_CELL} m met panden, tot ${HEAT_RADIUS} m van het adres.`;
  } catch (err) {
    if (run !== analysis.heatRun) return;
    console.error(err);
    $('heat-info').textContent = `Heatmap niet beschikbaar: ${err.message}`;
  }
}
$('heat-metric').addEventListener('change', updateHeatmap);

function heatCells(features, ctx, metric) {
  const n = Math.round(2 * HEAT_RADIUS / HEAT_CELL);
  const gx0 = ctx.x - HEAT_RADIUS, gy0 = ctx.y - HEAT_RADIUS;
  const grid = Array.from({ length: n * n }, () => ({ years: [], heights: [], polys: [] }));
  for (const f of features) {
    if (!f.geometry) continue;
    const p = f.properties;
    const [cx, cy] = ringCentre(f.geometry);
    const i = Math.floor((cx - gx0) / HEAT_CELL), j = Math.floor((cy - gy0) / HEAT_CELL);
    if (i >= 0 && j >= 0 && i < n && j < n) {
      if (isKnownYear(p.oorspronkelijkbouwjaar)) grid[j * n + i].years.push(p.oorspronkelijkbouwjaar);
      const h = p.b3_h_70p - p.b3_h_maaiveld;
      if (h > 0) grid[j * n + i].heights.push(h);
    }
    if (metric !== 'dichtheid') continue;
    // For coverage, a building counts in every cell its outline overlaps.
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    const [bx0, by0, bx1, by1] = bboxOf(ring);
    for (let jj = Math.max(0, Math.floor((by0 - gy0) / HEAT_CELL)); jj <= Math.min(n - 1, Math.floor((by1 - gy0) / HEAT_CELL)); jj++) {
      for (let ii = Math.max(0, Math.floor((bx0 - gx0) / HEAT_CELL)); ii <= Math.min(n - 1, Math.floor((bx1 - gx0) / HEAT_CELL)); ii++) grid[jj * n + ii].polys.push(f.geometry);
    }
  }
  const out = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const g = grid[j * n + i], x = gx0 + i * HEAT_CELL, y = gy0 + j * HEAT_CELL;
    let value = null;
    if (metric === 'dichtheid' && g.polys.length) {
      // Share of 10 × 10 sample points in the cell that fall inside a building.
      let hits = 0;
      for (let sy = 0; sy < 10; sy++) for (let sx = 0; sx < 10; sx++) {
        const pt = [x + (sx + 0.5) * HEAT_CELL / 10, y + (sy + 0.5) * HEAT_CELL / 10];
        if (g.polys.some(poly => pointInGeometry(pt, poly))) hits++;
      }
      value = hits ? hits / 100 : null;
    } else if (metric === 'bouwjaar' && g.years.length) value = Math.round(median(g.years));
    else if (metric === 'hoogte' && g.heights.length) value = g.heights.reduce((s, h) => s + h, 0) / g.heights.length;
    if (value != null) out.push({ x, y, value });
  }
  return out;
}

// ---------- Walking or cycling distance ----------

function setWalkSpeed(speed) {
  walk.speed = speed;
  for (const s of Object.keys(SPEEDS)) $(`walk-speed-${s}`).setAttribute('aria-pressed', s === speed);
  updateWalkRings();
  updateWalkCounts();
}
for (const s of Object.keys(SPEEDS)) $(`walk-speed-${s}`).addEventListener('click', () => setWalkSpeed(s));
$('walk-show').addEventListener('change', () => { updateWalkRings(); updateWalkCounts(); });

// What lies within each ring, per kind of amenity.
async function updateWalkCounts() {
  const run = ++analysis.walkRun;
  if (!$('walk-show').checked || !current) { $('walk-counts').replaceChildren(); return; }
  const ctx = current, speed = SPEEDS[walk.speed];
  const reach = WALK_MINUTES[WALK_MINUTES.length - 1] * speed.mPerMin;
  try {
    const pois = await track(fetchPois(ctx.lon, ctx.lat, reach));
    if (run !== analysis.walkRun || current !== ctx) return;
    const items = pois.map(p => ({ ...p, d: distanceM(ctx.lon, ctx.lat, p.lon, p.lat) }));
    addRows($('walk-counts'), WALK_MINUTES.map(min => {
      const within = items.filter(p => p.d <= min * speed.mPerMin);
      const parts = AMENITIES.map(a => [a.label.toLowerCase(), within.filter(p => a.is(p.props)).length]).filter(([, n]) => n);
      return [`Binnen ${min} min ${speed.label}`, parts.length ? parts.map(([l, n]) => `${l} ${nf.format(n)}`).join(' · ') : 'geen voorzieningen'];
    }));
  } catch (err) {
    console.error(err);
    if (run === analysis.walkRun) addRows($('walk-counts'), [['Voorzieningen', `niet beschikbaar: ${err.message}`]]);
  }
}
analysis.walkRun = 0;

// ---------- A new address ----------

// Called by loadAddress: the radius follows the new address, a drawn area
// and its figures are dropped, and the heatmap and rings are redrawn.
function resetAnalysis() {
  analysis.run++;
  stopDrawing();
  showArea(null);
  $('area-result').replaceChildren();
  $('area-status').textContent = '';
  if ($('heat-metric').value) updateHeatmap();
  updateWalkCounts();
}
