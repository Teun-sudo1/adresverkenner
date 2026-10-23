// Groeikaart: a whole municipality on a dark map, its buildings lighting up
// period by period by construction year. A separate map in a full-screen
// layer, so the address view underneath stays as it was.
// The buildings come from the 3D BAG map service (WMS), which can filter on
// construction year; each period is one tile layer, coloured here in the
// browser because the service only draws its own grey style.
// Loaded as a classic script; see index.html for the load order.

const GROWTH_WMS = 'https://data.3dbag.nl/api/BAG3D/wms';
const GEMEENTEN = 'https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/gemeentegebied/items';

// Periods, oldest first, on a dark-to-light ramp so new building glows brightest.
const GROWTH_ERAS = [
  { to: 1800, label: 'vóór 1800', color: '#5b1a78' },
  { from: 1800, to: 1900, label: '1800–1899', color: '#7d2181' },
  { from: 1900, to: 1925, label: '1900–1924', color: '#9e2b7b' },
  { from: 1925, to: 1945, label: '1925–1944', color: '#bd3a6b' },
  { from: 1945, to: 1960, label: '1945–1959', color: '#d64f56' },
  { from: 1960, to: 1975, label: '1960–1974', color: '#e86a3e' },
  { from: 1975, to: 1990, label: '1975–1989', color: '#f28a2a' },
  { from: 1990, to: 2000, label: '1990–1999', color: '#f6ab2a' },
  { from: 2000, to: 2010, label: '2000–2009', color: '#f8c847' },
  { from: 2010, to: 2020, label: '2010–2019', color: '#fae17a' },
  { from: 2020, label: '2020 en later', color: '#fdf5c4' }
];
const GROWTH_STEP_MS = 1300;

const growth = { map: null, ready: null, shown: -1, timer: 0, gemeente: null, popup: null, counts: null };

function eraFilter(e) {
  const parts = [e.from != null && `oorspronkelijkbouwjaar >= ${e.from}`, e.to != null && `oorspronkelijkbouwjaar < ${e.to}`].filter(Boolean);
  return encodeURIComponent(parts.join(' AND '));
}

// The service draws grey fills with dark outlines; repaint them in the
// period's colour, keeping the outlines a little darker.
maplibregl.addProtocol('groei', async (params, abort) => {
  const url = new URL(params.url.replace(/^groei:/, 'https:'));
  const hex = url.searchParams.get('kleur');
  url.searchParams.delete('kleur');
  const res = await fetch(url, { signal: abort.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ${url.hostname}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const [r, g, b] = hex.match(/\w\w/g).map(h => parseInt(h, 16));
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const shade = 0.6 + 0.4 * Math.min(1, (d[i] + d[i + 1] + d[i + 2]) / 383);
    d[i] = r * shade;
    d[i + 1] = g * shade;
    d[i + 2] = b * shade;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return { data: await blob.arrayBuffer() };
});

function createGrowthMap() {
  const m = new maplibregl.Map({
    container: 'groei-map',
    // Keeps the drawn frame readable, for the smoke test's pixel count.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        grijs: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png'],
          attribution: 'Kaartgegevens &copy; Kadaster · Panden: <a href="https://3dbag.nl">3D BAG</a> (TU Delft)'
        },
        ...Object.fromEntries(GROWTH_ERAS.map((e, i) => [`era${i}`, {
          type: 'raster', tileSize: 512, minzoom: 8, maxzoom: 19,
          tiles: [`groei://${GROWTH_WMS.replace(/^https:\/\//, '')}?service=WMS&version=1.3.0&request=GetMap&layers=BAG3D:lod12&styles=` +
            `&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true` +
            `&CQL_FILTER=${eraFilter(e)}&kleur=${e.color.slice(1)}`]
        }])),
        masker: { type: 'geojson', data: emptyFC },
        grens: { type: 'geojson', data: emptyFC }
      },
      layers: [
        // Inverted and desaturated: a dark map that lets the buildings glow.
        { id: 'grijs', type: 'raster', source: 'grijs',
          paint: { 'raster-brightness-min': 0.82, 'raster-brightness-max': 0.02, 'raster-saturation': -1, 'raster-contrast': -0.2 } },
        ...GROWTH_ERAS.map((e, i) => ({ id: `era${i}`, type: 'raster', source: `era${i}`,
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 700, delay: 0 }, 'raster-fade-duration': 0 } })),
        { id: 'masker', type: 'fill', source: 'masker', paint: { 'fill-color': '#05070d', 'fill-opacity': 0.72 } },
        { id: 'grens', type: 'line', source: 'grens', paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': 1.5 } }
      ]
    },
    center: [5.3, 52.15],
    zoom: 7,
    maxPitch: 0,
    dragRotate: false
  });
  m.touchZoomRotate.disableRotation();
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  m.on('click', e => showGrowthInfo(e));
  growth.ready = new Promise(resolve => m.once('load', resolve));
  return m;
}

// ---------- Timeline ----------

function renderTimeline() {
  const max = growth.counts ? Math.max(...growth.counts) : 0;
  $('groei-timeline').replaceChildren(...GROWTH_ERAS.map((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.setProperty('--c', e.color);
    const n = growth.counts?.[i];
    // One bar per period: how many of today's buildings date from it.
    b.style.setProperty('--h', max ? `${Math.max(2, n / max * 100)}%` : '0');
    b.title = n != null ? `${e.label}: ${nf.format(n)} panden` : e.label;
    b.setAttribute('aria-label', `Toon panden tot en met ${e.label}${n != null ? ` (${nf.format(n)} panden)` : ''}`);
    b.innerHTML = `<span class="bar"><i></i></span><span class="sw"></span><span class="lab">${e.from ?? ''}</span>`;
    b.addEventListener('click', () => { stopGrowth(); showEra(i); });
    return b;
  }));
}

function showEra(i) {
  growth.shown = i;
  GROWTH_ERAS.forEach((e, k) => growth.map.setPaintProperty(`era${k}`, 'raster-opacity', k <= i ? 1 : 0));
  [...$('groei-timeline').children].forEach((b, k) => {
    b.classList.toggle('on', k <= i);
    b.setAttribute('aria-pressed', k <= i);
  });
  const e = GROWTH_ERAS[i];
  $('groei-year').textContent = i < 0 ? '' : e.to ? e.to - 1 : 'Nu';
  // With counts: how many of today's buildings stood by then, and what share.
  let count = '';
  if (growth.counts && i >= 0) {
    const sum = growth.counts.slice(0, i + 1).reduce((a, b) => a + b, 0);
    const total = growth.counts.reduce((a, b) => a + b, 0);
    count = e.to ? `: ${nf.format(sum)} (${nf.format(Math.round(sum / total * 100))}%)` : `: ${nf.format(total)}`;
  }
  $('groei-caption').textContent = i < 0 ? '' : (e.to
    ? `Panden van nu die er in ${e.to - 1} al stonden`
    : 'Alle panden van nu') + count;
}

function playGrowth() {
  stopGrowth();
  if (reducedMotion.matches) { showEra(GROWTH_ERAS.length - 1); return; }
  let i = growth.shown >= GROWTH_ERAS.length - 1 ? -1 : growth.shown;
  showEra(i);
  $('groei-play').textContent = '❚❚';
  $('groei-play').setAttribute('aria-label', 'Pauzeren');
  growth.timer = setInterval(() => {
    i++;
    showEra(i);
    if (i >= GROWTH_ERAS.length - 1) stopGrowth();
  }, GROWTH_STEP_MS);
}

function stopGrowth() {
  clearInterval(growth.timer);
  growth.timer = 0;
  $('groei-play').textContent = '▶';
  $('groei-play').setAttribute('aria-label', 'Afspelen');
}

// ---------- Choosing a municipality ----------

attachSuggestGemeente($('groei-q'), $('groei-list'));

function attachSuggestGemeente(input, list) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const data = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(q)}&fq=type:gemeente&rows=8&fl=gemeentenaam`);
        list.replaceChildren(...data.response.docs.map(d => Object.assign(document.createElement('option'), { value: d.gemeentenaam })));
      } catch (err) { console.error(err); }
    }, 150);
  });
}

async function showGemeente(query) {
  setGrowthStatus('Gemeente zoeken…');
  try {
    await growth.ready;
    const s = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(query)}&fq=type:gemeente&rows=1&fl=gemeentenaam`);
    const naam = s.response.docs[0]?.gemeentenaam;
    if (!naam) { setGrowthStatus(`Geen gemeente gevonden voor "${query}".`, true); return; }
    const data = await getJSON(`${GEMEENTEN}?f=json&naam=${encodeURIComponent(naam)}`);
    const f = data.features[0];
    if (!f) { setGrowthStatus(`Geen grens gevonden voor ${naam}.`, true); return; }
    growth.gemeente = naam;
    $('groei-q').value = naam;
    $('groei-title').textContent = `Zo groeide ${naam}`;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    // Everything outside the municipality dimmed: the world with the municipality as holes.
    const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    growth.map.getSource('masker').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...polys.map(p => p[0])] } });
    growth.map.getSource('grens').setData(f);
    const xs = polys.flatMap(p => p[0].map(c => c[0])), ys = polys.flatMap(p => p[0].map(c => c[1]));
    growth.map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
      { padding: { top: 90, bottom: 150, left: 30, right: 30 }, duration: 0 });
    setGrowthStatus('Panden laden…');
    growth.counts = null;
    renderTimeline();
    showEra(-1);
    countPerEra(naam, polys);
    // Start once the tiles of every period are in, so the playback doesn't stall.
    growth.map.once('idle', () => {
      if (growth.gemeente !== naam) return;
      setGrowthStatus('');
      playGrowth();
    });
  } catch (err) {
    console.error(err);
    setGrowthStatus(`Fout: ${err.message}`, true);
  }
}

// Buildings per period inside the municipality: one count (WFS "hits") per
// period, filtered on a simplified outline in RD coordinates. 3D BAG counts
// building parts, so the totals are close to, not exactly, the number of panden.
async function countPerEra(naam, polys) {
  const rings = polys
    .map(p => simplifyRing(p[0].map(([lon, lat]) => wgs84ToRd(lon, lat)), 50))
    .filter(r => r.length >= 4 && ringArea(r) > 10000);
  if (!rings.length) return;
  const wkt = `MULTIPOLYGON(${rings.map(r => `((${r.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(',')}))`).join(',')})`;
  // Busy, the service answers with an error report (status 200), so this
  // checks the answer itself, retries, and doesn't use the response cache.
  const count = async e => {
    const cql = encodeURIComponent(`INTERSECTS(geom,${wkt}) AND `) + eraFilter(e);
    const url = `${GROWTH_WMS.replace('/wms', '/wfs')}?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAG3D:lod12&resultType=hits&CQL_FILTER=${cql}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      // No answer at all (no connection, timed out): retrying won't help.
      const n = await fetchWithRetry(url).then(r => r.text()).then(t => t.match(/numberMatched="(\d+)"/)?.[1]);
      if (n != null) return Number(n);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw new Error('Telling niet beschikbaar');
  };
  try {
    // At most four at a time: each count is a spatial query on the server.
    const counts = new Array(GROWTH_ERAS.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < GROWTH_ERAS.length) {
        const i = next++;
        counts[i] = await count(GROWTH_ERAS[i]);
      }
    }));
    if (growth.gemeente !== naam) return;
    growth.counts = counts;
    renderTimeline();
    showEra(growth.shown);
  } catch (err) {
    // The bars and the buildings both come from 3D BAG; when it doesn't
    // answer, say so instead of showing an empty map.
    console.warn(err);
    if (growth.gemeente === naam) setGrowthStatus('De panden komen van de 3D BAG (TU Delft), die nu niet reageert. Probeer het later opnieuw.', true);
  }
}

function setGrowthStatus(text, isError = false) {
  $('groei-status').textContent = text;
  $('groei-status').classList.toggle('error', isError);
}

$('groei-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('groei-q').value.trim();
  if (q) showGemeente(q);
});
$('groei-play').addEventListener('click', () => (growth.timer ? stopGrowth() : playGrowth()));

// ---------- Building info on click ----------

async function showGrowthInfo(e) {
  if (growth.shown < 0) return;
  const p = growth.map.project(e.lngLat);
  const sw = growth.map.unproject([p.x - 4, p.y + 4]), ne = growth.map.unproject([p.x + 4, p.y - 4]);
  const a = maplibregl.MercatorCoordinate.fromLngLat(sw), b = maplibregl.MercatorCoordinate.fromLngLat(ne);
  const R = 20037508.34;
  const bbox = [a.x * 2 * R - R, R - a.y * 2 * R, b.x * 2 * R - R, R - b.y * 2 * R].join(',');
  try {
    const data = await getJSON(`${GROWTH_WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=BAG3D:lod12&query_layers=BAG3D:lod12` +
      `&crs=EPSG:3857&bbox=${bbox}&width=9&height=9&i=4&j=4&info_format=application/json&feature_count=1`);
    const props = data.features?.[0]?.properties;
    growth.popup?.remove();
    if (!props) return;
    const year = props.oorspronkelijkbouwjaar;
    growth.popup = new maplibregl.Popup({ closeButton: false, offset: 8 })
      .setLngLat(e.lngLat).setText(`Bouwjaar ${year ?? 'onbekend'}`).addTo(growth.map);
  } catch (err) {
    console.error(err);
  }
}

// ---------- Open and close ----------

async function openGrowth() {
  $('groei').hidden = false;
  growth.map ??= createGrowthMap();
  growth.map.resize();
  renderTimeline();
  await growth.ready;
  showEra(growth.shown);
  // With an address on screen, start with its municipality.
  const gem = $('r-gemeente').textContent.trim();
  if (!growth.gemeente && gem && gem !== '–') showGemeente(gem);
  else if (!growth.gemeente) $('groei-q').focus();
}

function closeGrowth() {
  if ($('groei').hidden) return;
  stopGrowth();
  growth.popup?.remove();
  $('groei').hidden = true;
  $('groei-open').focus();
}

$('groei-close').addEventListener('click', closeGrowth);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGrowth(); });
