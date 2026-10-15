// Map tools: measuring distances and areas, and saving the current map view
// as an image.
// Loaded as a classic script; see index.html for the load order.

// ---------- Measuring ----------

const measure = { mode: null, points: [], cursor: null };
const MEASURE_COLOR = '#d6336c';

// Great-circle distance in metres.
function haversine([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, R = 6371008.8;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const fmtLength = m => m >= 1000 ? `${nf1.format(m / 1000)} km` : `${nf.format(Math.round(m * 10) / 10)} m`;
const pathLength = pts => pts.slice(1).reduce((s, p, i) => s + haversine(pts[i], p), 0);

mapReady.then(() => {
  map.addSource('measure', { type: 'geojson', data: emptyFC });
  map.addLayer({ id: 'measure-fill', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': MEASURE_COLOR, 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': MEASURE_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'measure-points', type: 'circle', source: 'measure', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': MEASURE_COLOR, 'circle-stroke-width': 2 } });
});

function updateMeasure() {
  const pts = measure.cursor ? [...measure.points, measure.cursor] : measure.points;
  const features = measure.points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
  const area = measure.kind === 'area' && pts.length >= 3;
  if (pts.length >= 2) {
    features.push({ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: area ? [...pts, pts[0]] : pts } });
  }
  if (area) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
  setLayerData('measure', features);

  let text = '';
  if (measure.kind === 'distance') {
    text = pts.length >= 2 ? `Afstand: ${fmtLength(pathLength(pts))}` : '';
  } else if (area) {
    const ring = [...pts, pts[0]];
    text = `Oppervlakte: ${nf.format(Math.round(areaM2({ type: 'Polygon', coordinates: [ring] })))} m² · omtrek ${fmtLength(pathLength(ring))}`;
  }
  $('measure-result').textContent = text;
}

function startMeasure(mode) {
  stopMeasure(false);
  Object.assign(measure, { mode, kind: mode, points: [], cursor: null });
  $('measure-dist').setAttribute('aria-pressed', mode === 'distance');
  $('measure-area').setAttribute('aria-pressed', mode === 'area');
  $('measure-panel').hidden = false;
  $('measure-hint').textContent = 'Klik punten aan op de kaart. Dubbelklik of Enter om af te ronden, Esc om te stoppen.';
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  updateMeasure();
}

// Ends measuring; the shape stays on the map until cleared.
function stopMeasure(keep = true) {
  if (!measure.mode) return;
  measure.mode = null;
  measure.cursor = null;
  $('measure-dist').setAttribute('aria-pressed', 'false');
  $('measure-area').setAttribute('aria-pressed', 'false');
  $('measure-hint').textContent = keep && measure.points.length ? 'Klaar. Kies opnieuw om een nieuwe meting te starten.' : '';
  map.getCanvas().style.cursor = '';
  // Let a double click finish first, then zoom works again.
  setTimeout(() => map.doubleClickZoom.enable(), 300);
  updateMeasure();
}

function clearMeasure() {
  stopMeasure(false);
  measure.points = [];
  measure.kind = null;
  $('measure-panel').hidden = true;
  updateMeasure();
}

map.on('click', e => {
  if (!measure.mode) return;
  measure.points.push([e.lngLat.lng, e.lngLat.lat]);
  updateMeasure();
});
map.on('dblclick', e => {
  if (!measure.mode) return;
  e.preventDefault();
  // The double click's two clicks each added a point; drop the duplicate.
  measure.points.pop();
  stopMeasure();
});
map.on('mousemove', e => {
  if (!measure.mode || !measure.points.length) return;
  measure.cursor = [e.lngLat.lng, e.lngLat.lat];
  updateMeasure();
});
document.addEventListener('keydown', e => {
  if (!measure.mode) return;
  if (e.key === 'Enter') stopMeasure();
  if (e.key === 'Escape') stopMeasure();
});

$('measure-dist').addEventListener('click', () => (measure.mode === 'distance' ? stopMeasure() : startMeasure('distance')));
$('measure-area').addEventListener('click', () => (measure.mode === 'area' ? stopMeasure() : startMeasure('area')));
$('measure-clear').addEventListener('click', clearMeasure);

// ---------- Saving the map as an image ----------

// The map canvas (MapLibre and three.js draw into the same one) plus the rain
// overlay, with a footer naming the address, the date and the data sources.
async function saveMapImage() {
  await mapReady;
  await new Promise(res => { map.once('render', res); map.triggerRepaint(); });
  const src = map.getCanvas();
  const dpr = src.width / src.clientWidth;
  const footer = Math.round(40 * dpr);
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + footer;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const rainCanvas = $('rain-canvas');
  if (rainCanvas.width) ctx.drawImage(rainCanvas, 0, 0, src.width, src.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, src.height, out.width, footer);
  ctx.fillStyle = '#1d2433';
  ctx.font = `600 ${Math.round(13 * dpr)}px system-ui, -apple-system, sans-serif`;
  const title = $('r-address').textContent ? `${$('r-address').textContent}, ${$('r-place').textContent}` : 'Adresverkenner';
  ctx.fillText(`${title} · ${new Date().toLocaleDateString('nl-NL')}`, 10 * dpr, src.height + 17 * dpr);
  ctx.fillStyle = '#5a6475';
  ctx.font = `${Math.round(11 * dpr)}px system-ui, -apple-system, sans-serif`;
  const attribution = document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || '';
  ctx.fillText(`Bronnen: ${attribution}, BAG, 3D BAG, PDOK`, 10 * dpr, src.height + 32 * dpr, out.width - 20 * dpr);

  const slug = (title.split(',')[0] || 'kaart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  out.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `adresverkenner-${slug}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

$('save-image').addEventListener('click', () => saveMapImage().catch(err => {
  console.error(err);
  setStatus(`Afbeelding opslaan mislukt: ${err.message}`, true);
}));
