// Facilities near the address from OpenStreetMap: the nearest supermarket,
// stop, station, school and so on, with straight-line distances, in a report
// section and as markers on the map while that section is open.
// The points come from OpenFreeMap's vector tiles (OpenMapTiles schema, zoom
// 14), read here with a small decoder: unlike the Overpass servers they are
// served from a fast CDN, and they're cached for a day like everything else.
// Loaded as a classic script; see index.html for the load order.

const OPENFREEMAP = 'https://tiles.openfreemap.org/planet';
const POI_ZOOM = 14;
const AMENITY_RADIUS = 1500;

// `is`: a test on the tile's class and subclass. Within `r` metres.
const AMENITIES = [
  { key: 'supermarkt', label: 'Supermarkt', r: 1500, is: p => p.subclass === 'supermarket',
    icon: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.4h11.2L21 7H6"/>' },
  { key: 'halte', label: 'Bus- of tramhalte', r: 800, is: p => p.class === 'bus' || p.subclass === 'tram_stop',
    icon: '<rect x="5" y="3" width="14" height="14" rx="2"/><path d="M5 10h14M8 17v3M16 17v3"/>' },
  { key: 'station', label: 'Station (trein of metro)', r: 1500, is: p => p.class === 'railway' && (p.subclass === 'station' || p.subclass === 'halt'),
    icon: '<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 16l-3 5M15 16l3 5"/>' },
  { key: 'school', label: 'School', r: 1500, is: p => p.class === 'school' && p.subclass !== 'kindergarten',
    icon: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/>' },
  { key: 'huisarts', label: 'Huisarts', r: 1500, is: p => p.subclass === 'doctors',
    icon: '<path d="M12 5v14M5 12h14"/>' },
  { key: 'apotheek', label: 'Apotheek', r: 1500, is: p => p.subclass === 'pharmacy',
    icon: '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/>' },
  { key: 'speeltuin', label: 'Speeltuin', r: 1000, is: p => p.subclass === 'playground',
    icon: '<path d="M4 21V4h16v17"/><path d="M9 4v9M15 4v9M8 13h8"/>' },
  { key: 'park', label: 'Park', r: 1500, is: p => p.class === 'park',
    icon: '<path d="M12 3l6 8h-3.5l4.5 6H5l4.5-6H6z"/><path d="M12 17v4"/>' },
  { key: 'sporthal', label: 'Sporthal of sportcentrum', r: 1500, is: p => p.class === 'sports_centre' || p.class === 'stadium' || p.class === 'gymnastics',
    icon: '<path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/>' },
  { key: 'zwembad', label: 'Zwembad', r: 1500, is: p => p.class === 'swimming_pool' || p.subclass === 'swimming',
    icon: '<path d="M2 18c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0 2 .7 2 .7"/><circle cx="16" cy="6" r="2"/><path d="M4 14l5-5 3 3 2-2"/>' },
  // Fields for club sports and courts; not ping-pong or chess tables and boules courts.
  { key: 'sportveld', label: 'Sportveld', r: 1500,
    is: p => p.class === 'pitch' && !/^(table_tennis|chess|table_soccer|boules|dog_agility|undefined)$/.test(String(p.subclass)),
    icon: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 5v14"/><circle cx="12" cy="12" r="2.5"/>' },
  { key: 'laadpaal', label: 'Laadpaal', r: 1000, is: p => p.subclass === 'charging_station',
    icon: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' }
];

const amenities = { found: [], markers: [] };

// ---------- Reading vector tiles ----------

// Minimal protobuf reading for Mapbox Vector Tiles: only the "poi" layer,
// only point features, with their properties.
function readVarint(buf, pos) {
  let v = 0, shift = 0, b;
  do {
    b = buf[pos.i++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b >= 0x80);
  return v;
}

function* pbfFields(buf, start = 0, end = buf.length) {
  const pos = { i: start };
  while (pos.i < end) {
    const key = readVarint(buf, pos);
    const field = Math.floor(key / 8), type = key & 7;
    if (type === 0) yield { field, value: readVarint(buf, pos) };
    else if (type === 2) {
      const len = readVarint(buf, pos);
      yield { field, start: pos.i, end: pos.i + len };
      pos.i += len;
    } else if (type === 5) pos.i += 4;
    else if (type === 1) pos.i += 8;
    else throw new Error('Onbekend veldtype in kaarttegel');
  }
}

const zigzag = n => (n % 2 ? -(n + 1) / 2 : n / 2);
const utf8 = new TextDecoder();

function poiPoints(buf, z, x, y) {
  const out = [];
  for (const layer of pbfFields(buf)) {
    if (layer.field !== 3) continue;
    let name = '', extent = 4096;
    const keys = [], values = [], features = [];
    for (const f of pbfFields(buf, layer.start, layer.end)) {
      if (f.field === 1) name = utf8.decode(buf.subarray(f.start, f.end));
      else if (f.field === 2) features.push(f);
      else if (f.field === 3) keys.push(utf8.decode(buf.subarray(f.start, f.end)));
      else if (f.field === 4) {
        let v = null;
        for (const vf of pbfFields(buf, f.start, f.end)) v = vf.field === 1 ? utf8.decode(buf.subarray(vf.start, vf.end)) : vf.value ?? null;
        values.push(v);
      } else if (f.field === 5) extent = f.value;
    }
    if (name !== 'poi') continue;
    for (const feat of features) {
      const props = {};
      let geom = null, type = 0;
      for (const ff of pbfFields(buf, feat.start, feat.end)) {
        if (ff.field === 3) type = ff.value;
        else if (ff.field === 2 || ff.field === 4) {
          const ints = [];
          const pos = { i: ff.start };
          while (pos.i < ff.end) ints.push(readVarint(buf, pos));
          if (ff.field === 2) for (let k = 0; k + 1 < ints.length; k += 2) props[keys[ints[k]]] = values[ints[k + 1]];
          else geom = ints;
        }
      }
      // Type 1 is a point: one MoveTo command, then zigzag x and y in tile units.
      if (type !== 1 || !geom || geom.length < 3) continue;
      const px = (x + zigzag(geom[1]) / extent) / 2 ** z, py = (y + zigzag(geom[2]) / extent) / 2 ** z;
      out.push({ props, lon: px * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * py))) * 180 / Math.PI });
    }
  }
  return out;
}

// The tiles' address changes with each OpenFreeMap release; the TileJSON says where they are.
let poiTileUrl = null;
async function poiTiles() {
  poiTileUrl ??= getJSON(OPENFREEMAP).then(j => j.tiles[0]).catch(err => { poiTileUrl = null; throw err; });
  return poiTileUrl;
}

// Every point in the zoom-14 tiles that touch the circle around the address.
async function fetchPois(lon, lat, radius = AMENITY_RADIUS) {
  const template = await poiTiles();
  const n = 2 ** POI_ZOOM;
  const dLon = radius / (111320 * Math.cos(lat * Math.PI / 180)), dLat = radius / 110574;
  const tx = l => Math.floor((l + 180) / 360 * n);
  const ty = b => Math.floor((1 - Math.log(Math.tan(b * Math.PI / 180) + 1 / Math.cos(b * Math.PI / 180)) / Math.PI) / 2 * n);
  const tiles = [];
  for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++) {
    for (let y = ty(lat + dLat); y <= ty(lat - dLat); y++) tiles.push([x, y]);
  }
  const lists = await Promise.all(tiles.map(async ([x, y]) => {
    const res = await cachedFetch(template.replace('{z}', POI_ZOOM).replace('{x}', x).replace('{y}', y));
    if (!res.ok) throw new Error(`HTTP ${res.status} bij tiles.openfreemap.org`);
    return poiPoints(new Uint8Array(await res.arrayBuffer()), POI_ZOOM, x, y);
  }));
  return lists.flat();
}

// Metres between two points, accurate enough at neighbourhood scale.
function distanceM(lon1, lat1, lon2, lat2) {
  const kx = 111320 * Math.cos(lat1 * Math.PI / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110574);
}

const fmtDistance = m => m < 1000 ? `${nf.format(Math.round(m / 10) * 10)} m` : `${nf1.format(m / 1000)} km`;

async function loadAmenities(ctx, stale) {
  clearAmenityMarkers();
  amenities.found = [];
  $('amenities-section').hidden = true;
  updateWalkRings();
  try {
    const points = await track(fetchPois(ctx.lon, ctx.lat));
    if (stale()) return;
    const items = points.map(p => ({ ...p, d: distanceM(ctx.lon, ctx.lat, p.lon, p.lat) }));
    amenities.found = AMENITIES.map(a => {
      const mine = items.filter(it => a.is(it.props) && it.d <= a.r).sort((x, y) => x.d - y.d);
      return { ...a, nearest: mine[0] || null, count: mine.length };
    });
    renderAmenities();
  } catch (err) {
    console.error(err);
    if (stale()) return;
    $('amenities').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'hint', textContent: `Voorzieningen niet beschikbaar: ${err.message}`
    }));
    $('amenities-section').hidden = false;
  }
}

const amenityName = (a, it) => it.props.name || a.label.toLowerCase();

function renderAmenities() {
  $('amenities').replaceChildren(...amenities.found.flatMap(a => {
    const dt = document.createElement('dt');
    dt.textContent = a.label;
    const dd = document.createElement('dd');
    if (a.nearest) {
      dd.textContent = `${fmtDistance(a.nearest.d)} · ${walkMinutes(a.nearest.d)} min lopen · ${amenityName(a, a.nearest)}`;
      dd.dataset.v = fmtDistance(a.nearest.d);
      const cmp = document.createElement('span');
      cmp.className = 'cmp';
      cmp.textContent = `${nf.format(a.count)} binnen ${fmtDistance(a.r)}`;
      dd.append(cmp);
    } else {
      dd.textContent = `geen binnen ${fmtDistance(a.r)}`;
      dd.dataset.v = '–';
    }
    return [dt, dd];
  }));
  $('amenities-section').hidden = false;
  updateAmenityMarkers();
}

// ---------- Markers on the map ----------

function clearAmenityMarkers() {
  for (const m of amenities.markers) m.remove();
  amenities.markers = [];
}

function updateAmenityMarkers() {
  clearAmenityMarkers();
  updateWalkRings();
  if (!$('amenities-section').open) return;
  for (const a of amenities.found) {
    if (!a.nearest) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'amenity-marker';
    const text = `${a.label}: ${amenityName(a, a.nearest)}, ${fmtDistance(a.nearest.d)}`;
    el.title = text;
    el.setAttribute('aria-label', text);
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.icon}</svg>`;
    const popup = new maplibregl.Popup({ closeButton: false, offset: 16 }).setText(text);
    amenities.markers.push(new maplibregl.Marker({ element: el }).setLngLat([a.nearest.lon, a.nearest.lat]).setPopup(popup).addTo(map));
  }
}

$('amenities-section').addEventListener('toggle', updateAmenityMarkers);

// ---------- Walking distance ----------

// Circles for 5, 10 and 15 minutes' walk (4.8 km/h) or cycle (15 km/h), as
// the crow flies; via the streets it's usually a little further. They show
// with the markers while the section is open, or from the Analyse tab.
const WALK_MINUTES = [5, 10, 15], WALK_M_PER_MIN = 80;
const SPEEDS = { lopen: { label: 'lopen', mPerMin: WALK_M_PER_MIN }, fietsen: { label: 'fietsen', mPerMin: 250 } };
const walk = { speed: 'lopen' };
const WALK_KEY = 'adresrapport.walk';
const walkMinutes = m => Math.max(1, Math.round(m / WALK_M_PER_MIN));
const walkLabels = [];
try { $('walk-toggle').checked = localStorage.getItem(WALK_KEY) !== '0'; } catch {}

function walkCircle(lon, lat, r) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  const ring = [];
  for (let i = 0; i <= 96; i++) {
    const a = i / 96 * Math.PI * 2;
    ring.push([lon + Math.sin(a) * r / kx, lat + Math.cos(a) * r / 110574]);
  }
  return ring;
}

function updateWalkRings() {
  for (const m of walkLabels.splice(0)) m.remove();
  const section = $('amenities-section');
  const fromAnalysis = $('walk-show').checked;
  const show = !!current && (fromAnalysis || (!section.hidden && section.open && $('walk-toggle').checked));
  // The report section always walks; the Analyse tab can switch to cycling.
  const speed = fromAnalysis ? SPEEDS[walk.speed] : SPEEDS.lopen;
  setLayerData('loopafstand', show ? WALK_MINUTES.map(min => ({ type: 'Feature', properties: { min },
    geometry: { type: 'LineString', coordinates: walkCircle(current.lon, current.lat, min * speed.mPerMin) } })) : []);
  if (!show) return;
  for (const min of WALK_MINUTES) {
    const el = document.createElement('div');
    el.className = 'walk-label';
    el.textContent = `${min} min ${speed.label}`;
    walkLabels.push(new maplibregl.Marker({ element: el }).setLngLat([current.lon, current.lat + min * speed.mPerMin / 110574]).addTo(map));
  }
}

$('walk-toggle').addEventListener('change', () => {
  try { localStorage.setItem(WALK_KEY, $('walk-toggle').checked ? '1' : '0'); } catch {}
  updateWalkRings();
});
