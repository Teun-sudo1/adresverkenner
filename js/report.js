// The address report: search, BAG building data, parcels, environment and CBS statistics.
// Loaded as a classic script; see index.html for the load order.

// ---------- Building height (3D BAG) ----------

const ROOF_TYPES = { slanted: 'schuin', 'multiple horizontal': 'meerdere platte vlakken', 'single horizontal': 'plat', horizontal: 'plat' };

async function loadHeight(pandId, stale) {
  try {
    const item = await getJSON(`${BAG3D}/NL.IMBAG.Pand.${pandId}`);
    if (stale()) return;
    const a = heightsFrom3DBag(item.feature.CityObjects)[pandId];
    if (!a) return;
    const h = heightAboveGround(a);
    setField('r-hoogte', `${nf1.format(h)} m (nok ${nf1.format(a.b3_h_dak_max - a.b3_h_maaiveld)} m)`);
    setField('r-lagen', a.b3_bouwlagen ?? `≈ ${Math.max(1, Math.round(h / 3))} (geschat, 3 m per laag)`);
    setField('r-dak', ROOF_TYPES[a.b3_dak_type] ?? a.b3_dak_type);
    setField('r-volume', a.b3_volume_lod22 != null ? `${nf.format(Math.round(a.b3_volume_lod22))} m³` : null);
    setField('r-maaiveld', `${nf1.format(a.b3_h_maaiveld)} m t.o.v. NAP`);
    // The same item carries the detailed roof planes for the solar estimate.
    const own = parseLod22({ metadata: item.metadata, features: [item.feature] }).find(([id]) => id === pandId);
    renderSolar(own?.[1]);
  } catch (err) {
    // 404 means the pand isn't in 3D BAG yet (e.g. very new buildings).
    if (!stale()) setField('r-hoogte', 'niet beschikbaar');
  }
}

// ---------- Climate and environment ----------

async function featureInfo(base, layer, x, y) {
  // A 10 m box centred on the point, sampled at its middle pixel.
  const bbox = [x - 5, y - 5, x + 5, y + 5].join(',');
  const url = `${base}?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=${layer}&query_layers=${layer}` +
    `&crs=EPSG:28992&bbox=${bbox}&width=11&height=11&i=5&j=5&info_format=application/json`;
  const data = await getJSON(url);
  return data.features?.[0]?.properties ?? null;
}

const depth = v => v > 0 ? `${nf1.format(v)} m` : 'droog';
const FLOOD_CLASSES = ['', 'extreem klein (< 1/30.000 per jaar)', 'zeer klein (1/3.000–1/30.000 per jaar)',
  'klein (1/300–1/3.000 per jaar)', 'middelgroot (1/30–1/300 per jaar)', 'groot (> 1/30 per jaar)'];
const PILE_ROT_CLASSES = [[0.8, 'zeer laag'], [3, 'laag'], [6, 'matig'], [15, 'hoog'], [100, 'zeer hoog']];
const NOISE_CLASSES = [[45, 'zeer goed'], [50, 'goed'], [55, 'redelijk'], [60, 'matig'], [65, 'tamelijk slecht'], [70, 'slecht'], [Infinity, 'zeer slecht']];
const classify = (v, classes) => classes.find(([max]) => v <= max)[1];

const ENV_GROUPS = [
  ['Overstroming en wateroverlast', [
    ...[['grote', 'ca. 1× per 10 jaar'], ['middelgrote', 'ca. 1× per 100 jaar'], ['kleine', 'ca. 1× per 1.000 jaar'],
      ['zeer_kleine', 'ca. 1× per 10.000 jaar'], ['extreem_kleine', 'nog zeldzamer']].map(([k, when]) =>
      ({ base: KEA_WMS, layer: `maximale_waterdiepte_nederland_${k}_kans_20260128`, label: `Overstroming, ${when}`, fmt: depth })),
    { base: KEA_WMS, layer: 'plaatsgebonden_overstromingskans_huidig_50_cm_20251120', label: 'Kans op > 50 cm water',
      // Class 0: no scenario puts 50 cm of water here.
      fmt: v => FLOOD_CLASSES[v] || 'verwaarloosbaar' },
    // The address point usually falls inside the building, which the rain
    // model leaves empty, so look at the street around it.
    { get: (x, y) => pluvialNear(x, y), label: 'Hevige regen, 70 mm in 1 uur',
      fmt: v => v >= 0.02 ? `tot ${nf.format(Math.round(v * 100))} cm water binnen 15 m` : 'droog binnen 15 m' }
  ]],
  ['Bodem en fundering', [
    { base: KEA_WMS, layer: 'nl_bodemdaling_totaal_v20260623', key: 'snelheid', label: 'Bodembeweging',
      fmt: v => `${nf1.format(Math.abs(v))} mm per jaar ${v < 0 ? 'daling' : 'stijging'}` },
    { base: KEA_WMS, layer: 'risicopaalrot_huidig', key: 'no_cc_risi', label: 'Risico paalrot (buurt)',
      fmt: v => `${classify(v, PILE_ROT_CLASSES)} (${nf1.format(v)}% van panden)` }
  ]],
  ['Hitte', [
    { base: KEA_WMS, layer: 'hitteeiland', label: 'Stedelijk hitte-eiland', fmt: v => `+${nf1.format(v)} °C gemiddeld` }
  ]],
  ['Geluid en lucht', [
    { base: ALO_WMS, layer: 'rivm_Geluid_lden_allebronnen_actueel', label: 'Geluid, alle bronnen',
      fmt: v => v > 0 ? `${v} dB Lden (${classify(v, NOISE_CLASSES)})` : null },
    { base: ALO_WMS, layer: 'rivm_nsl_20260401_gm_NO22024', label: 'NO₂ (2024)', fmt: v => `${nf1.format(v)} µg/m³ (WHO-advies 10)` },
    { base: ALO_WMS, layer: 'rivm_nsl_20260401_gm_PM252024', label: 'Fijnstof PM2,5 (2024)', fmt: v => `${nf1.format(v)} µg/m³ (WHO-advies 5)` }
  ]]
];

async function loadEnvironment(x, y, stale) {
  const items = ENV_GROUPS.flatMap(([, list]) => list);
  const values = await Promise.all(items.map(it =>
    (it.get ? it.get(x, y) : featureInfo(it.base, it.layer, x, y).then(p => p?.[it.key || 'GRAY_INDEX']))
      .catch(() => undefined)));
  if (stale()) return;

  const frag = document.createDocumentFragment();
  let i = 0;
  for (const [title, list] of ENV_GROUPS) {
    const dl = document.createElement('dl');
    for (const it of list) {
      const v = values[i++];
      const dt = document.createElement('dt');
      dt.textContent = it.label;
      const dd = document.createElement('dd');
      // -9999 is the rasters' no-data value: outside the flood zone, for example.
      const usable = typeof v === 'number' && (v > -9999 || it.fmt === depth);
      dd.textContent = (usable && it.fmt(v)) || '–';
      dl.append(dt, dd);
    }
    const h3 = document.createElement('h3');
    h3.textContent = title;
    frag.append(h3, dl);
  }
  $('env').replaceChildren(frag);
  $('env-section').hidden = false;
}

map.on('click', async e => {
  // While measuring, clicks place points instead of looking up addresses.
  if (measure.mode) return;
  setStatus('Adres zoeken bij klikpunt…');
  try {
    const { lng, lat } = e.lngLat;
    const data = await getJSON(`${LOCATIESERVER}/reverse?lat=${lat}&lon=${lng}&type=adres&rows=1&fl=id,afstand`);
    const doc = data.response.docs[0];
    if (!doc) { setStatus('Geen adres gevonden bij dit punt.', true); return; }
    loadAddress(doc.id);
  } catch (err) {
    setStatus(`Fout: ${err.message}`, true);
  }
});

// ---------- Helpers ----------

function getJSON(url, signal) {
  return track((async () => {
    const res = await cachedFetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} bij ${new URL(url).hostname}`);
    return res.json();
  })());
}

function withJson(href) {
  const u = new URL(href);
  u.searchParams.set('f', 'json');
  return u.toString();
}

function parsePoint(wkt) {
  const [lon, lat] = wkt.match(/POINT\(([^ ]+) ([^)]+)\)/).slice(1).map(Number);
  return { lon, lat };
}

// Approximate area in m² of a (Multi)Polygon in WGS84, using a local
// equirectangular projection. Accurate to well under 1% at building scale.
function areaM2(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const lat0 = polys[0][0][0][1] * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110574;
  const ringArea = ring => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
    }
    return Math.abs(a / 2);
  };
  return polys.reduce((sum, [outer, ...holes]) =>
    sum + ringArea(outer) - holes.reduce((h, r) => h + ringArea(r), 0), 0);
}

function setStatus(msg, isError = false) {
  // Mirrored in the welcome dialog, which covers the panel while it's open.
  for (const id of ['status', 'welcome-status']) {
    $(id).textContent = msg;
    $(id).className = isError ? 'hint error' : 'hint';
  }
  $('status').className = isError ? 'error' : '';
}

function setField(id, value) {
  $(id).textContent = value ?? '–';
}

function formatDoel(s) {
  return s ? s.replaceAll(',', ', ') : null;
}

function m2(v) {
  return v != null ? `${nf.format(Math.round(v))} m²` : null;
}

function unitAddress(p) {
  const nr = `${p.huisnummer ?? ''}${p.huisletter ?? ''}${p.toevoeging ? '-' + p.toevoeging : ''}`;
  return `${p.openbare_ruimte_naam} ${nr}`.trim();
}

const RESULT_FIELDS = ['r-bomen', 'r-bouwjaar', 'r-leeftijd', 'r-opp', 'r-pandid', 'r-pandstatus', 'r-panddoel', 'r-aantal', 'r-totaal',
  'r-footprint', 'r-hoogte', 'r-lagen', 'r-dak', 'r-volume', 'r-maaiveld', 'r-vboid', 'r-doel', 'r-vbostatus', 'r-perceel', 'r-perceelopp', 'r-bebouwd',
  'r-postcode', 'r-buurt', 'r-wijk', 'r-gemeente', 'r-provincie', 'r-coords'];

function resetResult() {
  for (const id of RESULT_FIELDS) setField(id, null);
  $('r-leeftijd').textContent = '';
  $('r-bagviewer').parentElement.hidden = true;
  $('units-section').hidden = true;
  $('units').replaceChildren();
  $('cbs-section').hidden = true;
  $('cbs').replaceChildren();
  $('env-section').hidden = true;
  $('env').replaceChildren();
  $('heritage-section').hidden = true;
  $('solar-section').hidden = true;
  $('solar-table').tBodies[0].replaceChildren();
  for (const id of ['r-monument', 'r-gezicht', 'r-monumenten-nabij']) setField(id, null);
  $('years-section').hidden = true;
  $('years-chart').replaceChildren();
  for (const s of ['pand', 'perceel', 'buurt', 'scene3d', 'monumenten', 'bomen']) setLayerData(s, []);
  trees.list = [];
  trees.version++;
}

// ---------- Recent searches (per browser) ----------

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function addRecent(id, name) {
  const list = [{ id, name }, ...getRecent().filter(r => r.id !== id)].slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  renderRecent();
}

function renderRecent() {
  const list = getRecent();
  $('recent').hidden = !list.length || !$('result').hidden;
  $('recent-list').replaceChildren(...list.map(r => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = r.name;
    b.addEventListener('click', () => loadAddress(r.id));
    li.append(b);
    return li;
  }));
}

// ---------- Autocomplete ----------

let suggestions = [];
let activeIndex = -1;
let suggestAbort;
let suggestTimer;

function renderSuggestions() {
  const ul = $('suggestions');
  ul.replaceChildren(...suggestions.map((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = s.weergavenaam;
    li.className = i === activeIndex ? 'active' : '';
    li.addEventListener('mousedown', e => { e.preventDefault(); pickSuggestion(i); });
    return li;
  }));
  ul.hidden = !suggestions.length;
  $('q').setAttribute('aria-expanded', !ul.hidden);
}

function closeSuggestions() {
  suggestions = [];
  activeIndex = -1;
  renderSuggestions();
}

function pickSuggestion(i) {
  const s = suggestions[i];
  $('q').value = s.weergavenaam;
  closeSuggestions();
  loadAddress(s.id);
}

$('q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (q.length < 3) { closeSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    suggestAbort?.abort();
    suggestAbort = new AbortController();
    try {
      const data = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(q)}&fq=type:adres&rows=8&fl=id,weergavenaam`, suggestAbort.signal);
      suggestions = data.response.docs;
      activeIndex = -1;
      renderSuggestions();
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err);
    }
  }, 200);
});

$('q').addEventListener('keydown', e => {
  if ($('suggestions').hidden) return;
  if (e.key === 'ArrowDown') { activeIndex = (activeIndex + 1) % suggestions.length; renderSuggestions(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length; renderSuggestions(); e.preventDefault(); }
  else if (e.key === 'Escape') { closeSuggestions(); e.stopPropagation(); }
});

$('q').addEventListener('blur', () => setTimeout(closeSuggestions, 100));

$('search').addEventListener('submit', async e => {
  e.preventDefault();
  if (activeIndex >= 0) { pickSuggestion(activeIndex); return; }
  const q = $('q').value.trim();
  if (!q) return;
  closeSuggestions();
  setStatus('Zoeken…');
  try {
    // /suggest ranks typed addresses far better than /free (e.g. "Amsteldijk 10"
    // matches Amsteldijk 10, not 35D-10).
    const data = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(q)}&fq=type:adres&rows=1&fl=id`);
    const id = data.response.docs[0]?.id;
    if (!id) { setStatus('Geen adres gevonden.', true); return; }
    loadAddress(id);
  } catch (err) {
    setStatus(`Fout: ${err.message}`, true);
  }
});

// ---------- Address report ----------

let loadId = 0;

async function loadAddress(lsId, { pushHistory = true, camera = null } = {}) {
  const mine = ++loadId;
  const stale = () => mine !== loadId;
  closeWelcome();
  $('go').disabled = true;
  setStatus('Adres ophalen…');

  try {
    const data = await getJSON(`${LOCATIESERVER}/lookup?id=${encodeURIComponent(lsId)}&fl=${LOOKUP_FIELDS}`);
    if (stale()) return;
    const doc = data.response.docs[0];
    if (!doc) { setStatus('Adres niet gevonden.', true); return; }
    const { lon, lat } = parsePoint(doc.centroide_ll);

    // Some browsers refuse pushState on file:// pages; the report still works without it.
    if (pushHistory) try { history.pushState({ id: lsId }, '', `?id=${encodeURIComponent(lsId)}`); } catch {}
    addressId = lsId;
    document.title = `${doc.weergavenaam} – Adresverkenner`;
    $('q').value = doc.weergavenaam;
    addRecent(lsId, doc.weergavenaam);

    marker.setLngLat([lon, lat]).addTo(map);
    // A shared link brings its own camera.
    if (camera) map.jumpTo(camera);
    else map.flyTo({ center: [lon, lat], zoom: 18 });
    resetResult();
    $('result').hidden = false;
    $('recent').hidden = true;
    $('print').hidden = false;

    $('r-address').textContent = doc.weergavenaam.split(',')[0];
    $('r-place').textContent = [doc.postcode, doc.woonplaatsnaam].filter(Boolean).join(' ');
    setField('r-postcode', doc.postcode);
    setField('r-buurt', doc.buurtnaam);
    setField('r-wijk', doc.wijknaam);
    setField('r-gemeente', doc.gemeentenaam);
    setField('r-provincie', doc.provincienaam);
    setField('r-perceel', doc.gekoppeld_perceel?.join(', '));
    setField('r-coords', `${lat.toFixed(6)}, ${lon.toFixed(6)}`);

    // Parcel, neighbourhood and environment data don't depend on BAG; load them alongside.
    const rd = parsePoint(doc.centroide_rd);
    current = { lon, lat, x: rd.lon, y: rd.lat, pandIds: [] };
    sceneFor = null;
    hideSunHours();
    // Drop the previous address's 3D buildings; they'd sit in the wrong place.
    sceneFeatures = [];
    detailById = new Map();
    sceneVersion++;
    highlight3D([]);
    if (is3D) loadScene();
    if (sun.on) updateSun();
    if (waterScenario) loadWater();
    const parcels = loadParcels(doc.gekoppeld_perceel || [], [lon, lat], stale);
    loadBuurt(lon, lat, stale);
    loadEnvironment(current.x, current.y, stale);
    // Heritage and the year profile start now and pick up the pand (or none,
    // for houseboats and pitches) once it is known.
    let resolvePanden;
    pandenKnown = new Promise(r => { resolvePanden = r; });
    loadHeritage(current, pandenKnown, stale);
    loadYearProfile(current, pandenKnown.then(p => p[0]?.properties.bouwjaar ?? null), stale);
    loadTrees(current, stale);
    onRainPlaceChanged();
    if (is3D) loadTreeHeights(current).catch(err => console.error(err));

    // Positions 5–6 of a BAG object id give its type: 01 = verblijfsobject,
    // 02 = ligplaats, 03 = standplaats. Only verblijfsobjecten sit in a pand.
    const aoId = doc.adresseerbaarobject_id;
    if (aoId?.slice(4, 6) !== '01') {
      setStatus('Dit adres is een lig- of standplaats; er is geen pand met bouwjaar.');
      resolvePanden([]);
      return;
    }

    setStatus('BAG-gegevens ophalen…');
    const vboData = await getJSON(`${BAG}/collections/verblijfsobject/items?f=json&identificatie=${aoId}`);
    if (stale()) return;
    const vbo = vboData.features[0];
    if (!vbo) throw new Error('Verblijfsobject niet gevonden in BAG.');
    const vp = vbo.properties;
    setField('r-opp', m2(vp.oppervlakte));
    setField('r-vboid', vp.identificatie);
    setField('r-doel', formatDoel(vp.gebruiksdoel));
    setField('r-vbostatus', vp.status);

    // A verblijfsobject can lie in more than one pand; use the first for the
    // headline year and draw all of them.
    const panden = await Promise.all((vp['pand.href'] || []).map(h => getJSON(withJson(h))));
    if (stale()) return;
    resolvePanden(panden);
    if (!panden.length) { setStatus('Geen pand gekoppeld aan dit adres.'); return; }

    showPanden(panden);
    const pp = panden[0].properties;
    current.pandIds = panden.map(p => p.properties.identificatie);
    highlight3D(current.pandIds);
    loadHeight(pp.identificatie, stale);
    setField('r-bouwjaar', pp.bouwjaar);
    if (pp.bouwjaar) {
      const age = new Date().getFullYear() - pp.bouwjaar;
      $('r-leeftijd').textContent = age > 0 ? `${age} jaar oud` : 'nieuwbouw';
    }
    setField('r-pandid', panden.map(p => p.properties.identificatie).join(', '));
    setField('r-pandstatus', pp.status);
    setField('r-panddoel', formatDoel(pp.gebruiksdoel));
    setField('r-aantal', pp.aantal_verblijfsobjecten);
    const footprint = panden.reduce((s, p) => s + areaM2(p.geometry), 0);
    setField('r-footprint', m2(footprint));
    $('r-bagviewer').href = `https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=${pp.identificatie}`;
    $('r-bagviewer').parentElement.hidden = false;
    setStatus(panden.length > 1 ? `Adres ligt in ${panden.length} panden; bouwjaar van het eerste getoond.` : '');

    parcels.then(parcelArea => {
      if (stale() || !parcelArea) return;
      // A pand can extend over neighbouring parcels, so cap at 100%.
      setField('r-bebouwd', `${nf.format(Math.min(100, Math.round(footprint / parcelArea * 100)))}% door dit pand`);
    });

    await loadUnits(panden[0], vp.identificatie, stale);
  } catch (err) {
    if (stale()) return;
    console.error(err);
    setStatus(`Fout: ${err.message}`, true);
  } finally {
    if (!stale()) $('go').disabled = false;
  }
}

async function loadUnits(pand, currentVboId, stale) {
  const hrefs = pand.properties['verblijfsobject.href'] || [];
  if (hrefs.length > MAX_UNITS) {
    setField('r-totaal', `niet berekend (> ${MAX_UNITS} objecten)`);
    return;
  }
  setField('r-totaal', 'berekenen…');
  const units = (await Promise.all(hrefs.map(h => getJSON(withJson(h))))).map(u => u.properties);
  if (stale()) return;

  const sum = units.reduce((s, u) => s + (u.oppervlakte || 0), 0);
  setField('r-totaal', m2(sum));

  units.sort((a, b) => unitAddress(a).localeCompare(unitAddress(b), 'nl', { numeric: true }));
  $('units').replaceChildren(...units.map(u => {
    const tr = document.createElement('tr');
    if (u.identificatie === currentVboId) tr.className = 'current';
    for (const [text, cls] of [[unitAddress(u)], [formatDoel(u.gebruiksdoel) ?? '–'], [u.oppervlakte != null ? nf.format(u.oppervlakte) : '–', 'num']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    return tr;
  }));
  $('units-section').hidden = units.length < 2;
}

// ---------- Heritage (RCE) ----------

// Rijksmonumenten as points; a monument point inside the pand outline means
// the pand is (part of) a rijksmonument. Protected townscapes as areas.
const RCE_WFS = 'https://data.geo.cultureelerfgoed.nl/openbaar/wfs';
const RCE_GEZICHTEN_WFS = 'https://services.rce.geovoorziening.nl/rce/wfs';
let pandenKnown = Promise.resolve([]);

function rceWfs(base, type, [minX, minY, maxX, maxY]) {
  return getJSON(`${base}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${type}&outputFormat=application/json` +
    `&srsName=EPSG:4326&count=5000&bbox=${[minX, minY, maxX, maxY].map(Math.round).join(',')},EPSG:28992`);
}

// Even-odd point-in-polygon test for a GeoJSON (Multi)Polygon.
function pointInGeometry([x, y], geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let inside = false;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function linkTo(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

async function loadHeritage(ctx, pandenP, stale) {
  const r = SCENE_RADIUS;
  const [points, gezichten, panden] = await Promise.all([
    rceWfs(RCE_WFS, 'openbaar:rijksmonumentpunten', [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r]).catch(() => null),
    rceWfs(RCE_GEZICHTEN_WFS, 'rce:Townscapes', [ctx.x - 1, ctx.y - 1, ctx.x + 1, ctx.y + 1]).catch(() => null),
    pandenP
  ]);
  if (stale()) return;
  if (!points && !gezichten) return;

  if (points) {
    setLayerData('monumenten', points.features);
    const own = points.features.filter(f => panden.some(p => pointInGeometry(f.geometry.coordinates, p.geometry)));
    const dd = $('r-monument');
    if (!panden.length) {
      setField('r-monument', 'n.v.t. (geen pand)');
    } else if (!own.length) {
      setField('r-monument', 'Nee');
    } else {
      dd.replaceChildren();
      for (const [i, f] of own.entries()) {
        const p = f.properties;
        const kind = (p.subcategorie || p.hoofdcategorie || '').replace(/\s*\(.*\)$/, '');
        if (i) dd.append(document.createElement('br'));
        dd.append(`Ja, nr. ${p.rijksmonument_nummer}${kind ? ` (${kind})` : ''} · `,
          linkTo(p.rijksmonumenturl || `https://monumentenregister.cultureelerfgoed.nl/monumenten/${p.rijksmonument_nummer}`, 'register ↗'));
      }
    }
    setField('r-monumenten-nabij', `${nf.format(points.features.length)} binnen ${r} m`);
  }

  const g = gezichten?.features[0]?.properties;
  if (g) {
    $('r-gezicht').replaceChildren(g.KICHLINK ? linkTo(g.KICHLINK, g.NAAM) : g.NAAM);
  } else {
    setField('r-gezicht', gezichten ? 'Nee' : null);
  }
  $('heritage-section').hidden = false;
}

// ---------- Building years around the address ----------

// One series (number of panden per period) with the address's own period in
// the accent colour, so a single-hue bar chart without a legend.
async function loadYearProfile(ctx, ownYearP, stale) {
  const r = SCENE_RADIUS;
  const bbox = [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r].map(Math.round).join(',');
  const [data, ownYear] = await Promise.all([
    getJSON(`${BAG3D_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAG3D:lod12&outputFormat=application/json` +
      `&count=20000&bbox=${bbox},EPSG:28992&propertyName=identificatie,oorspronkelijkbouwjaar`).catch(() => null),
    ownYearP
  ]);
  if (stale() || !data) return;
  renderYearProfile(data.features.map(f => f.properties.oorspronkelijkbouwjaar), ownYear);
}

// BAG uses 1005 for "year unknown"; anything that early isn't a real year.
const isKnownYear = y => y >= 1200 && y <= new Date().getFullYear() + 5;

// Period width (10, 25, 50 or 100 years) such that there are at most ~20
// bars; the oldest few percent are grouped into one "before" bar.
function yearBins(years) {
  const sorted = [...years].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.03)], hi = sorted[sorted.length - 1];
  const size = [10, 25, 50, 100].find(s => Math.floor(hi / s) - Math.floor(lo / s) + 1 <= 20) ?? 100;
  const start = Math.floor(lo / size) * size, end = Math.floor(hi / size) * size;
  const bins = [];
  if (sorted[0] < start) bins.push({ from: -Infinity, to: start, label: `vóór ${start}`, count: 0 });
  for (let b = start; b <= end; b += size) bins.push({ from: b, to: b + size, label: `${b}–${b + size - 1}`, count: 0 });
  for (const y of sorted) bins.find(b => y >= b.from && y < b.to).count++;
  return bins;
}

const niceMax = v => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map(m => m * p).find(m => m >= v); };

function renderYearProfile(allYears, ownYear) {
  const years = allYears.filter(isKnownYear);
  const unknown = allYears.length - years.length;
  if (years.length < 5) return;
  const bins = yearBins(years);
  const own = isKnownYear(ownYear) ? bins.findIndex(b => ownYear >= b.from && ownYear < b.to) : -1;

  // Headline: the one number worth reading first.
  const older = years.filter(y => y > ownYear).length;
  const median = [...years].sort((a, b) => a - b)[Math.floor(years.length / 2)];
  $('years-headline').textContent = own >= 0
    ? `Dit pand (${ownYear}) is ouder dan ${nf.format(Math.round(older / years.length * 100))}% van de ${nf.format(years.length)} panden binnen ${SCENE_RADIUS} m. Middelste bouwjaar: ${median}.`
    : `${nf.format(years.length)} panden binnen ${SCENE_RADIUS} m. Middelste bouwjaar: ${median}.`;

  // Layout in SVG units; the SVG scales to the panel width.
  const W = 340, H = 150, left = 30, right = 4, top = 20, bottom = 22;
  const plotW = W - left - right, plotH = H - top - bottom;
  const slot = plotW / bins.length, barW = Math.min(24, slot - 2);
  const yMax = niceMax(Math.max(...bins.map(b => b.count)));
  const y = v => top + plotH - (v / yMax) * plotH;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, text) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Staafdiagram: aantal panden per bouwperiode binnen ${SCENE_RADIUS} m${own >= 0 ? `, dit pand valt in ${bins[own].label}` : ''}.` });
  // Recessive axis: baseline plus two y labels.
  svg.append(el('line', { class: 'axis', x1: left, x2: W - right, y1: y(0) + 0.5, y2: y(0) + 0.5 }));
  svg.append(el('text', { x: left - 4, y: y(0) + 3, 'text-anchor': 'end' }, '0'));
  svg.append(el('text', { x: left - 4, y: y(yMax) + 3, 'text-anchor': 'end' }, nf.format(yMax)));
  // At most ~5 x labels at period starts.
  const every = Math.ceil(bins.length / 5);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const showTip = (b, cx, cy) => {
    const strong = document.createElement('strong');
    strong.textContent = `${nf.format(b.count)} panden`;
    tip.replaceChildren(strong, b.label);
    tip.style.left = `${(cx / W) * 100}%`;
    tip.style.top = `${(cy / H) * 100}%`;
    tip.hidden = false;
  };

  bins.forEach((b, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    const h = Math.max(0, y(0) - y(b.count));
    const r = Math.min(4, h, barW / 2);
    // Rounded data end, square at the baseline.
    const d = h > 0
      ? `M${x},${y(0)}V${y(b.count) + r}Q${x},${y(b.count)} ${x + r},${y(b.count)}H${x + barW - r}Q${x + barW},${y(b.count)} ${x + barW},${y(b.count) + r}V${y(0)}Z`
      : '';
    // The hit area spans the whole slot and plot height, larger than the bar.
    const hit = el('rect', { class: 'hit', x: left + i * slot, y: top, width: slot, height: plotH, tabindex: 0,
      'aria-label': `${b.label}: ${b.count} panden` });
    hit.addEventListener('pointerenter', () => showTip(b, x + barW / 2, Math.min(y(b.count), y(0) - 4) - 4));
    hit.addEventListener('focus', () => showTip(b, x + barW / 2, Math.min(y(b.count), y(0) - 4) - 4));
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    hit.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(hit, el('path', { class: `bar${i === own ? ' own' : ''}`, d }));
    if (i % every === 0) {
      // Labels near the right edge hang leftwards so they aren't clipped.
      const lx = left + i * slot, nearEnd = lx > W - 30;
      svg.append(el('text', { x: nearEnd ? lx + slot : lx, y: H - 8, 'text-anchor': nearEnd ? 'end' : 'start' },
        b.from === -Infinity ? `<${b.to}` : String(b.from)));
    }
    if (i === own) {
      svg.append(el('text', { class: 'own-label', x: x + barW / 2, y: y(b.count) - 5, 'text-anchor': 'middle' }, 'dit pand'));
    }
  });

  $('years-chart').replaceChildren(svg, tip);
  $('years-table').tBodies[0].replaceChildren(...bins.map((b, i) => {
    const tr = document.createElement('tr');
    if (i === own) tr.className = 'current';
    const a = document.createElement('td'), c = document.createElement('td');
    a.textContent = b.label;
    c.textContent = nf.format(b.count);
    c.className = 'num';
    tr.append(a, c);
    return tr;
  }));
  $('years-note').textContent = `Bron: 3D BAG.${unknown ? ` ${nf.format(unknown)} panden zonder bekend bouwjaar zijn weggelaten.` : ''}`;
  $('years-section').hidden = false;
}

// ---------- Parcels (BRK) ----------

// Resolves to the total registered parcel area in m², or null.
async function loadParcels(ids, [lon, lat], stale) {
  try {
    // Locatieserver ids look like "ASD04-F-6346": AKR municipality, section, number.
    const results = await Promise.all(ids.map(id => {
      const [akr, sectie, nummer] = id.split('-');
      return getJSON(`${BRK}/collections/perceel/items?f=json&akr_kadastrale_gemeente_code_waarde=${encodeURIComponent(akr)}&sectie=${encodeURIComponent(sectie)}&perceelnummer=${encodeURIComponent(nummer)}`);
    }));
    if (stale()) return null;
    let features = results.flatMap(r => r.features);
    // Some addresses have no linked parcel; then take the parcel under the address point.
    if (!features.length) {
      const d = 1e-6;
      const hit = await getJSON(`${BRK}/collections/perceel/items?f=json&limit=5&bbox=${[lon - d, lat - d, lon + d, lat + d].join(',')}`);
      if (stale()) return null;
      features = hit.features.filter(f => pointInGeometry([lon, lat], f.geometry));
      const p = features[0]?.properties;
      if (p) setField('r-perceel', `${p.akr_kadastrale_gemeente_code_waarde}-${p.sectie}-${p.perceelnummer} (onder het adrespunt)`);
    }
    if (!features.length) return null;
    setLayerData('perceel', features);
    const area = features.reduce((s, f) => s + (f.properties.kadastrale_grootte_waarde || 0), 0);
    setField('r-perceelopp', m2(area));
    return area || null;
  } catch (err) {
    console.error(err);
    if (!stale()) setField('r-perceelopp', 'niet beschikbaar');
    return null;
  }
}

// ---------- Neighbourhood statistics (CBS) ----------

const fmtInt = v => nf.format(v);
const fmtPct = v => `${nf.format(v)}%`;
const fmtKm = v => `${nf1.format(v)} km`;
const CBS_GROUPS = [
  ['Bevolking', [
    ['aantal_inwoners', 'Inwoners', fmtInt],
    ['aantal_huishoudens', 'Huishoudens', fmtInt],
    ['gemiddelde_huishoudsgrootte', 'Gem. huishoudgrootte', v => nf1.format(v)],
    ['bevolkingsdichtheid_inwoners_per_km2', 'Inwoners per km²', fmtInt],
    ['percentage_personen_65_jaar_en_ouder', '65 jaar en ouder', fmtPct]
  ]],
  ['Wonen', [
    ['woningvoorraad', 'Woningen', fmtInt],
    ['gemiddelde_woningwaarde', 'Gem. WOZ-waarde', v => `€ ${nf.format(v * 1000)}`],
    ['percentage_koopwoningen', 'Koopwoningen', fmtPct],
    ['percentage_huurwoningen', 'Huurwoningen', fmtPct],
    ['perc_huurwoningen_in_bezit_woningcorporaties', 'Corporatiewoningen', fmtPct],
    ['percentage_bouwjaarklasse_tot_2000', 'Gebouwd vóór 2000', fmtPct]
  ]],
  ['Inkomen', [
    ['gemiddeld_inkomen_per_inwoner', 'Gem. inkomen per inwoner', v => `€ ${nf.format(v * 1000)}`]
  ]],
  ['Voorzieningen (gem. afstand)', [
    ['grote_supermarkt_gemiddelde_afstand_in_km', 'Grote supermarkt', fmtKm],
    ['basisonderwijs_gemiddelde_afstand_in_km', 'Basisschool', fmtKm],
    ['huisartsenpraktijk_gemiddelde_afstand_in_km', 'Huisarts', fmtKm],
    ['treinstation_gemiddelde_afstand_in_km', 'Treinstation', fmtKm]
  ]]
];

// CBS uses large negative codes (e.g. -99997) for secret or missing values.
const validStat = v => typeof v === 'number' && v > -99990;

// The neighbourhood of a point in each CBS year that has it, newest first.
async function fetchBuurtYears(lon, lat) {
  // A tiny bbox around the point finds the neighbourhood regardless of
  // code changes between CBS years.
  const d = 1e-6;
  const bbox = [lon - d, lat - d, lon + d, lat + d].join(',');
  const results = await Promise.all(CBS_YEARS.map(y =>
    getJSON(`https://api.pdok.nl/cbs/wijken-en-buurten-${y}/ogc/v1/collections/buurten/items?f=json&limit=1&bbox=${bbox}`)
      .then(r => ({ year: y, feature: r.features[0] }))
      .catch(() => ({ year: y, feature: null }))));
  return results.filter(r => r.feature);
}

// The newest valid value of a CBS statistic, with its year.
function buurtStat(years, key) {
  const hit = years.find(y => validStat(y.feature.properties[key]));
  return hit ? { value: hit.feature.properties[key], year: hit.year } : null;
}

async function loadBuurt(lon, lat, stale) {
  const years = await fetchBuurtYears(lon, lat);
  if (stale()) return;
  if (!years.length) return;

  setLayerData('buurt', [years[0].feature]);

  const frag = document.createDocumentFragment();
  for (const [title, stats] of CBS_GROUPS) {
    const dl = document.createElement('dl');
    for (const [key, label, fmt] of stats) {
      const hit = buurtStat(years, key);
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = hit ? fmt(hit.value) : '–';
      if (hit) {
        const yr = document.createElement('span');
        yr.className = 'yr';
        yr.textContent = ` (${hit.year})`;
        dd.append(yr);
      }
      dl.append(dt, dd);
    }
    const h3 = document.createElement('h3');
    h3.textContent = title;
    frag.append(h3, dl);
  }
  const p = years[0].feature.properties;
  $('cbs-section').querySelector('h2').textContent = `Buurt in cijfers – ${p.buurtnaam}`;
  $('cbs').replaceChildren(frag);
  $('cbs-section').hidden = false;
}
