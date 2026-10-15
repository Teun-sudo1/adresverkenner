// Settings, data sources and shared helpers used by every other script.
// Loaded as a classic script; see index.html for the load order.

const LOCATIESERVER = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
const BAG = 'https://api.pdok.nl/kadaster/bag/ogc/v2';
const BRK = 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1';
const BAG3D = 'https://api.3dbag.nl/collections/pand/items';
const KEA_WMS = 'https://cas.cloud.sogelink.com/public/data/org/gws/YWFMLMWERURF/kea_public/wms';
const ALO_WMS = 'https://data.rivm.nl/geo/alo/wms';
// Half-width in metres of the area loaded for the 3D view: 500 × 500 m is
// typically 500–1,500 building parts in a single ~1 MB request.
const SCENE_RADIUS = 250;
// Simple blocks around the detailed scene, so the 3D view reaches further.
const SCENE_RADIUS_OUTER = 750;
// Half-width in metres around the address with real roof shapes (3D BAG LoD
// 2.2): those models are heavy, so only the nearby buildings get them.
const DETAIL_RADIUS = 60;

// Suitability of a roof plane for solar panels, by its yield relative to an
// ideal roof (south, ~36°). One amber hue, darker = better.
const SOLAR_CLASSES = [
  { key: 'zeer', min: 0.9, label: 'Zeer geschikt', color: '#c2410c' },
  { key: 'goed', min: 0.7, label: 'Geschikt', color: '#f97316' },
  { key: 'matig', min: 0.55, label: 'Matig', color: '#fdba74' },
  { key: 'niet', min: -Infinity, label: 'Ongeschikt', color: '#a8a29e' }
];
// 3D BAG's WFS serves flat LoD 1.3 footprints (one per roof part) with heights,
// much lighter than the full 3D models from the OGC API.
const BAG3D_WFS = 'https://data.3dbag.nl/api/BAG3D/wfs';
// Half-widths in metres of the water simulation: 0.5 m detail near the
// address, 1 m out to the same distance as the 3D buildings.
const WATER_RADIUS_DETAIL = 100;
const WATER_RADIUS = 250;
const KEA_WCS = 'https://cas.cloud.sogelink.com/public/data/org/gws/YWFMLMWERURF/kea_public/ows';
const AHN_WCS = 'https://service.pdok.nl/rws/ahn/wcs/v1_0';
// National 0.5 m water-depth map for a 70 mm/hour storm, as a Cloud-Optimized
// GeoTIFF: only the tiles around the address are downloaded.
const PLUVIAL_COG = 'https://kea-nl-wateroverlast.nbg1.your-objectstorage.com/cog/wateroverlast_waterdiepte_hevige_neerslag_waterdiepte_70mm_1h_waterdiepte.cog.tif';
const WATER_SCENARIOS = {
  regen70: { kind: 'pluvial' },
  // The flood maps per probability class: the rarer the event, the more
  // extreme the flood, so a smaller chance means more water.
  ...Object.fromEntries(['grote', 'middelgrote', 'kleine', 'zeer_kleine', 'extreem_kleine'].map(k =>
    [`ov_${k}`, { kind: 'fluvial', coverage: `kea_public__maximale_waterdiepte_nederland_${k}_kans_20260128` }]))
};
// Newest first. The newest CBS year often has many fields not yet published,
// so each statistic falls back to the most recent year that has a value.
const CBS_YEARS = [2024, 2023];
// CBS StatLine: key figures for all of the Netherlands (row 0 of the 2024 table).
const CBS_NL = 'https://opendata.cbs.nl/ODataApi/odata/85984NED/TypedDataSet?$top=1&$format=json';
// Above this many units we skip fetching them (one request per unit).
const MAX_UNITS = 100;
// BAG vector tiles are only published at zoom 17; MapLibre overzooms them.
const BAG_TILE_ZOOM = 17;
const RECENT_KEY = 'adresrapport.recent';
const LOOKUP_FIELDS = [
  'id', 'weergavenaam', 'centroide_ll', 'adresseerbaarobject_id', 'postcode', 'buurtnaam', 'wijknaam',
  'gemeentenaam', 'provincienaam', 'woonplaatsnaam', 'gekoppeld_perceel', 'centroide_rd'
].join(',');

const YEAR_CLASSES = [
  { from: 1000, label: 'vóór 1900', color: '#7f2704' },
  { from: 1900, label: '1900–1944', color: '#d94801' },
  { from: 1945, label: '1945–1969', color: '#fd8d3c' },
  { from: 1970, label: '1970–1989', color: '#fdd0a2' },
  { from: 1990, label: '1990–2009', color: '#9ecae1' },
  { from: 2010, label: '2010 en later', color: '#3182bd' }
];
const UNKNOWN_YEAR_COLOR = '#bdbdbd';
const yearColor = ['step', ['to-number', ['get', 'bouwjaar'], 0], UNKNOWN_YEAR_COLOR,
  ...YEAR_CLASSES.flatMap(c => [c.from, c.color])];

const $ = id => document.getElementById(id);
// Animations (rising water, rain) are skipped when the system asks for less motion.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Loading indicator: counts the app's own data requests (not map tiles) and
// shows a thin bar while any are running.
let pendingLoads = 0;
function track(promise) {
  pendingLoads++;
  updateLoadBar();
  const done = () => { pendingLoads--; updateLoadBar(); };
  promise.then(done, done);
  return promise;
}
// Public data services sometimes drop a connection or answer a one-off server
// error; try once more before giving up. Also used inside the water worker.
async function fetchWithRetry(url, init) {
  try {
    const res = await fetch(url, init);
    if (res.status < 500) return res;
  } catch (err) {
    if (init?.signal?.aborted) throw err;
  }
  await new Promise(r => setTimeout(r, 800));
  return fetch(url, init);
}

// ---------- Response cache ----------

// Data for an address rarely changes within a day, so GET responses are kept
// in the browser's Cache Storage for a day: revisiting an address is then
// almost instant. Identical requests running at the same time share one
// download. Where Cache Storage isn't available, this is a plain fetch.
const CACHE_NAME = 'adresrapport-v1';
const CACHE_TTL = 24 * 3600 * 1000;
let cacheStore;
const inflight = new Map();

function openCache() {
  cacheStore ??= (async () => {
    try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { return null; }
  })();
  return cacheStore;
}

async function cachedFetch(url, init = {}) {
  // Range reads (the rain COG) and abortable requests (autocomplete) skip the cache.
  if (init.signal || init.headers?.Range) return fetch(url, init);
  if (!inflight.has(url)) {
    inflight.set(url, (async () => {
      const cache = await openCache();
      const hit = await cache?.match(url).catch(() => null);
      if (hit && Date.now() - Number(hit.headers.get('x-cached-at')) < CACHE_TTL) return hit;
      const res = await fetchWithRetry(url, init);
      if (res.ok && cache) {
        const headers = new Headers(res.headers);
        headers.set('x-cached-at', String(Date.now()));
        cache.put(url, new Response(await res.clone().arrayBuffer(), { status: res.status, headers })).catch(() => {});
      }
      return res;
    })().finally(() => setTimeout(() => inflight.delete(url))));
  }
  return (await inflight.get(url)).clone();
}

// Clear out expired entries once the page has settled.
setTimeout(async () => {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (!res || Date.now() - Number(res.headers.get('x-cached-at')) >= CACHE_TTL) cache.delete(req);
  }
}, 5000);

function updateLoadBar() {
  $('loadbar').hidden = pendingLoads === 0;
  $('loadbar').title = `Gegevens laden… (${pendingLoads} ${pendingLoads === 1 ? 'verzoek' : 'verzoeken'})`;
}
const nf = new Intl.NumberFormat('nl-NL');
const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
