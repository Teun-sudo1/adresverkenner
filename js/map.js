// The MapLibre map, its sources and base layers, layer switching and map clicks.
// Loaded as a classic script; see index.html for the load order.

// ---------- Map ----------

const map = new maplibregl.Map({
  container: 'map',
  // Needed so the map canvas can be copied into the print layout.
  preserveDrawingBuffer: true,
  // Snel quality draws one pixel per CSS pixel on high-resolution screens.
  pixelRatio: isFast() ? 1 : devicePixelRatio,
  style: {
    version: 8,
    sources: {
      brt: {
        type: 'raster',
        tiles: ['https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Kaartgegevens &copy; <a href="https://www.kadaster.nl">Kadaster</a>'
      },
      luchtfoto: {
        type: 'raster',
        tiles: ['https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Luchtfoto &copy; Beeldmateriaal Nederland'
      },
      bagtiles: {
        type: 'vector',
        tiles: [`${BAG}/tiles/WebMercatorQuad/{z}/{y}/{x}?f=mvt`],
        minzoom: BAG_TILE_ZOOM,
        maxzoom: BAG_TILE_ZOOM
      }
    },
    layers: [
      { id: 'brt', type: 'raster', source: 'brt' },
      { id: 'luchtfoto', type: 'raster', source: 'luchtfoto', layout: { visibility: 'none' } },
      {
        id: 'panden-fill', type: 'fill', source: 'bagtiles', 'source-layer': 'pand',
        paint: {
          'fill-color': yearColor,
          'fill-opacity': 0.65,
          'fill-outline-color': 'rgba(0,0,0,0.25)'
        }
      }
    ]
  },
  center: [5.3, 52.15],
  zoom: 7
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');
// Replacing the water image quickly cancels the previous load; that's expected.
map.on('error', e => { if (e.error?.name !== 'AbortError') console.error(e.error || e); });

const emptyFC = { type: 'FeatureCollection', features: [] };
const mapReady = new Promise(resolve => map.on('load', () => {
  for (const id of ['buurt', 'perceel', 'pand']) map.addSource(id, { type: 'geojson', data: emptyFC });
  map.addLayer({ id: 'buurt-line', type: 'line', source: 'buurt',
    paint: { 'line-color': '#6a3d9a', 'line-width': 2, 'line-dasharray': [4, 3] } });
  map.addLayer({ id: 'perceel-line', type: 'line', source: 'perceel',
    paint: { 'line-color': '#e66100', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'pand-fill', type: 'fill', source: 'pand', paint: { 'fill-color': '#1a5fb4', 'fill-opacity': 0.3 } });
  map.addLayer({ id: 'pand-line', type: 'line', source: 'pand', paint: { 'line-color': '#1a5fb4', 'line-width': 3 } });
  // Tree crowns at their estimated width: circle radius in pixels = metres / (metres per pixel).
  map.addSource('bomen', { type: 'geojson', data: emptyFC });
  map.addLayer({ id: 'bomen', type: 'circle', source: 'bomen', minzoom: 15,
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 15, ['*', ['get', 'kroon'], 0.34], 20, ['*', ['get', 'kroon'], 10.9]],
      'circle-color': '#5fae3e', 'circle-opacity': 0.55, 'circle-stroke-color': '#3d7a28', 'circle-stroke-width': 0.5
    } });
  map.addSource('monumenten', { type: 'geojson', data: emptyFC });
  map.addLayer({ id: 'monumenten', type: 'circle', source: 'monumenten',
    paint: { 'circle-radius': 4, 'circle-color': '#8e44ad', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' } });
  map.addSource('scene3d', { type: 'geojson', data: emptyFC });
  map.addLayer({
    id: 'pand-3d', type: 'fill-extrusion', source: 'scene3d', layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': yearColor,
      'fill-extrusion-height': ['get', 'hoogte'],
      'fill-extrusion-opacity': 0.9
    }
  });
  resolve();
}));
const marker = new maplibregl.Marker({ color: '#d1242f' });

async function setLayerData(source, features) {
  await mapReady;
  map.getSource(source).setData({ type: 'FeatureCollection', features });
}

function boundsOf(features) {
  const bounds = new maplibregl.LngLatBounds();
  const extend = c => typeof c[0] === 'number' ? bounds.extend(c) : c.forEach(extend);
  for (const f of features) extend(f.geometry.coordinates);
  return bounds;
}

async function showPanden(features) {
  await setLayerData('pand', features);
  if (features.length) {
    map.fitBounds(boundsOf(features), { padding: 80, maxZoom: is3D ? 17.5 : 19, pitch: map.getPitch(), bearing: map.getBearing() });
  }
}

for (const btn of document.querySelectorAll('#layers button')) {
  btn.addEventListener('click', async () => {
    await mapReady;
    for (const b of document.querySelectorAll('#layers button')) {
      const on = b === btn;
      b.setAttribute('aria-pressed', on);
      map.setLayoutProperty(b.dataset.layer, 'visibility', on ? 'visible' : 'none');
    }
  });
}

let is3D = false;

// One hover handler for all hoverable layers, so a monument point on top of a
// building wins instead of two popups fighting.
const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
const HOVER_LAYERS = ['monumenten', 'bomen', 'pand-3d', 'panden-fill'];

function buildingText(p) {
  const parts = [`Bouwjaar ${p.bouwjaar ?? 'onbekend'}`, p.status, formatDoel(p.gebruiksdoel)];
  if (p.hoogteBekend) parts.push(`${nf1.format(p.hoogte)} m hoog`);
  return parts.filter(Boolean).join(' · ');
}

function hoverText(f) {
  const p = f.properties;
  if (f.layer.id === 'bomen') return `Boom · ${p.gemeten ? '' : '~'}${nf.format(Math.round(p.hoogte))} m hoog`;
  if (f.layer.id === 'monumenten') {
    const kind = (p.subcategorie || p.hoofdcategorie || '').replace(/\s*\(.*\)$/, '');
    return [`Rijksmonument ${p.rijksmonument_nummer}`, kind].filter(Boolean).join(' · ');
  }
  return buildingText(p);
}

map.on('mousemove', e => {
  const layers = HOVER_LAYERS.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
  const f = hits.find(h => h.layer.id === 'monumenten') || hits.find(h => h.layer.id === 'bomen') || hits[0];
  // In 3D, buildings and trees drawn by three.js are picked with a ray.
  const picked = is3D && typeof pick3D === 'function' ? pick3D(e.point) : null;
  // With the sun-hours map on, every spot also gets its hours of sun.
  const hours = typeof sunHoursAt === 'function' ? sunHoursAt(e.lngLat) : null;
  const text = [picked ? picked.text : f && hoverText(f), hours != null && `${nf1.format(hours)} uur zon`].filter(Boolean).join(' · ');
  map.getCanvas().style.cursor = f || picked ? 'pointer' : '';
  if (text) hoverPopup.setLngLat(e.lngLat).setText(text).addTo(map);
  else hoverPopup.remove();
});
map.on('mouseout', () => hoverPopup.remove());
