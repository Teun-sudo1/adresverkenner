// "Regen nu": the live rain radar (RainViewer, past two hours as a loop),
// whether it rains at the address right now (read from the latest radar
// frame), real rain falling in the view when it does, and the forecast for
// the next two hours per quarter (Open-Meteo, KNMI model).
// Loaded as a classic script; see index.html for the load order.

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const RADAR_REFRESH_MS = 5 * 60 * 1000;
const RADAR_FRAME_MS = 600;
// RainViewer's free tiles go up to zoom 7; MapLibre enlarges them beyond that,
// which suits radar's ~1 km resolution.
const RADAR_MAX_ZOOM = 7;
const radar = { frames: [], host: '', index: 0, timer: 0, refresh: 0, playing: !reducedMotion.matches, active: false };
// Live rain at the address: level 0 (dry) to 4 (heavy), from the radar colour.
const liveRain = { level: 0, time: null };
const RAIN_LEVELS = ['droog', 'motregen', 'lichte regen', 'matige regen', 'zware regen'];
// How much of the rain animation to show per level.
const RAIN_DENSITY = [0, 0.2, 0.45, 0.75, 1];

const radarLayerId = i => `radar-${i}`;

// Where "here" is: the address, or the middle of the map without one.
function rainPlace() {
  if (current) return { lon: current.lon, lat: current.lat };
  const c = map.getCenter();
  return { lon: c.lng, lat: c.lat };
}

// ---------- Radar layers ----------

function clearRadarLayers() {
  for (let i = 0; i < radar.frames.length; i++) {
    if (map.getLayer(radarLayerId(i))) map.removeLayer(radarLayerId(i));
    if (map.getSource(radarLayerId(i))) map.removeSource(radarLayerId(i));
  }
  radar.frames = [];
}

async function loadRadarFrames() {
  // Always fresh: the radar changes every few minutes, so no response cache.
  const res = await track(fetchWithRetry(RAINVIEWER_API));
  if (!res.ok) throw new Error(`HTTP ${res.status} bij RainViewer`);
  const data = await res.json();
  await mapReady;
  if (!radar.active) return;
  clearRadarLayers();
  radar.host = data.host;
  radar.frames = data.radar.past;
  // Each frame is its own layer, so the loop only switches opacity and every
  // frame's tiles load once.
  const before = ['sunhours-2d', 'water-2d-outer', 'water-2d', 'buurt-line'].find(id => map.getLayer(id));
  radar.frames.forEach((f, i) => {
    map.addSource(radarLayerId(i), {
      type: 'raster', tileSize: 256, maxzoom: RADAR_MAX_ZOOM, attribution: 'Radar © RainViewer',
      tiles: [`${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`]
    });
    map.addLayer({ id: radarLayerId(i), type: 'raster', source: radarLayerId(i),
      paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } }, before);
  });
  showRadarFrame(radar.frames.length - 1);
}

function showRadarFrame(i) {
  radar.index = i;
  radar.frames.forEach((_, k) => map.setPaintProperty(radarLayerId(k), 'raster-opacity', k === i ? 0.75 : 0));
  const f = radar.frames[i];
  if (!f) return;
  const time = new Date(f.time * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  $('radar-time').textContent = i === radar.frames.length - 1 ? `${time} (laatste)` : time;
}

// Loop through the frames, lingering on the latest one.
function radarTick() {
  if (!radar.frames.length) return;
  const next = (radar.index + 1) % radar.frames.length;
  showRadarFrame(next);
  radar.timer = setTimeout(radarTick, next === radar.frames.length - 1 ? RADAR_FRAME_MS * 3 : RADAR_FRAME_MS);
}

function setRadarPlaying(on) {
  radar.playing = on;
  clearTimeout(radar.timer);
  $('radar-play').textContent = on ? '❚❚' : '▶';
  $('radar-play').setAttribute('aria-label', on ? 'Radarbeelden pauzeren' : 'Radarbeelden afspelen');
  if (on) radar.timer = setTimeout(radarTick, RADAR_FRAME_MS);
}

// ---------- Rain at the address, from the latest radar frame ----------

// The radar colour scheme as seen in its tiles: beige drizzle, light blue
// light rain, blue moderate rain; anything darker or warmer counts as heavy.
function radarLevel([r, g, b, a]) {
  if (a < 30) return 0;
  if (r > 140 && g > 140 && b < 180) return 1;
  if (b > 200 && g > 195) return 2;
  if (b > 200 && g > 150) return 3;
  return 4;
}

async function sampleRadarAt(lon, lat) {
  const f = radar.frames[radar.frames.length - 1];
  if (!f) return null;
  const n = 2 ** RADAR_MAX_ZOOM;
  const fx = (lon + 180) / 360 * n;
  const fy = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const px = Math.floor((fx - tx) * 256), py = Math.floor((fy - ty) * 256);
  const res = await fetchWithRetry(`${radar.host}${f.path}/256/${RADAR_MAX_ZOOM}/${tx}/${ty}/2/1_1.png`);
  const bmp = await createImageBitmap(await res.blob());
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
  g.drawImage(bmp, 0, 0);
  // The wettest pixel within ~2 km, so a shower at the edge still counts.
  const d = g.getImageData(Math.max(0, px - 1), Math.max(0, py - 1), 3, 3).data;
  let level = 0;
  for (let i = 0; i < d.length; i += 4) level = Math.max(level, radarLevel(d.slice(i, i + 4)));
  return { level, time: f.time };
}

async function updateRainNow() {
  const { lon, lat } = rainPlace();
  try {
    const s = await sampleRadarAt(lon, lat);
    if (!s || !radar.active) return;
    liveRain.level = s.level;
    liveRain.time = s.time;
    const time = new Date(s.time * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const where = current ? 'bij dit adres' : 'midden op de kaart';
    $('rain-now').textContent = s.level
      ? `Het regent ${where}: ${RAIN_LEVELS[s.level]} (radar ${time}).`
      : `Droog ${where} (radar ${time}).`;
  } catch (err) {
    console.error(err);
    $('rain-now').textContent = 'Kon de regen hier niet aflezen.';
  }
  updateRain();
}

// ---------- Forecast: next two hours ----------

async function loadForecast() {
  const { lon, lat } = rainPlace();
  const url = `${OPEN_METEO}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&minutely_15=precipitation` +
    '&forecast_minutely_15=8&timezone=Europe%2FAmsterdam&models=knmi_seamless';
  try {
    // Fresh each time: a forecast from an hour ago is no use.
    const res = await track(fetchWithRetry(url));
    if (!res.ok) throw new Error(`HTTP ${res.status} bij Open-Meteo`);
    const m = (await res.json()).minutely_15;
    renderForecast(m.time.map((t, i) => ({ time: t.slice(11, 16), mm: m.precipitation[i] ?? 0 })));
  } catch (err) {
    console.error(err);
    $('forecast-headline').textContent = 'Verwachting niet beschikbaar.';
    $('forecast-chart').replaceChildren();
  }
}

// One series (rain per quarter, as mm per hour) in the accent colour.
function renderForecast(slots) {
  const wet = s => s.mm >= 0.05;
  const firstWet = slots.find(wet), firstDry = slots.find(s => !wet(s));
  $('forecast-headline').textContent = !firstWet ? 'Droog de komende 2 uur.'
    : wet(slots[0]) ? (firstDry ? `Regen tot ongeveer ${firstDry.time}.` : 'Regen de komende 2 uur.')
    : `Regen verwacht vanaf ${firstWet.time}.`;
  $('forecast-table').tBodies[0].replaceChildren(...slots.map(s => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'), b = document.createElement('td');
    a.textContent = s.time;
    b.textContent = nf1.format(s.mm);
    b.className = 'num';
    tr.append(a, b);
    return tr;
  }));
  if (!firstWet) { $('forecast-chart').replaceChildren(); return; }

  const W = 230, H = 90, left = 26, right = 4, top = 8, bottom = 18;
  const plotW = W - left - right, plotH = H - top - bottom;
  const perHour = slots.map(s => s.mm * 4);
  const yMax = niceMax(Math.max(1, ...perHour));
  const slot = plotW / slots.length, barW = Math.min(24, slot - 2);
  const y = v => top + plotH - (v / yMax) * plotH;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, text) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Staafdiagram: verwachte regen per kwartier, ${$('forecast-headline').textContent}` });
  svg.append(el('line', { class: 'axis', x1: left, x2: W - right, y1: y(0) + 0.5, y2: y(0) + 0.5 }));
  svg.append(el('text', { x: left - 4, y: y(0) + 3, 'text-anchor': 'end' }, '0'));
  svg.append(el('text', { x: left - 4, y: y(yMax) + 3, 'text-anchor': 'end' }, `${nf.format(yMax)}`));
  svg.append(el('text', { x: left - 4, y: y(yMax) + 13, 'text-anchor': 'end' }, 'mm/u'));
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  slots.forEach((s, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    const v = perHour[i], h = Math.max(0, y(0) - y(v)), r = Math.min(4, h, barW / 2);
    const d = h > 0 ? `M${x},${y(0)}V${y(v) + r}Q${x},${y(v)} ${x + r},${y(v)}H${x + barW - r}Q${x + barW},${y(v)} ${x + barW},${y(v) + r}V${y(0)}Z` : '';
    const hit = el('rect', { class: 'hit', x: left + i * slot, y: top, width: slot, height: plotH, tabindex: 0,
      'aria-label': `${s.time}: ${nf1.format(v)} mm per uur` });
    const show = () => {
      const strong = document.createElement('strong');
      strong.textContent = `${nf1.format(v)} mm/u`;
      tip.replaceChildren(strong, s.time);
      tip.style.left = `${((x + barW / 2) / W) * 100}%`;
      tip.style.top = `${((Math.min(y(v), y(0) - 4) - 4) / H) * 100}%`;
      tip.hidden = false;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    hit.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(hit, el('path', { class: 'bar own', d }));
    if (i % 2 === 0) svg.append(el('text', { x: left + i * slot, y: H - 4, 'text-anchor': 'start' }, s.time));
  });
  $('forecast-chart').replaceChildren(svg, tip);
}

// ---------- The Regen button ----------

async function startRainLive() {
  radar.active = true;
  $('rainlive').hidden = false;
  $('rain-live-toggle').setAttribute('aria-pressed', 'true');
  $('radar-time').textContent = 'Radar laden…';
  $('rain-now').textContent = '';
  loadForecast();
  try {
    await loadRadarFrames();
    setRadarPlaying(radar.playing);
    await updateRainNow();
  } catch (err) {
    console.error(err);
    $('radar-time').textContent = `Radar niet beschikbaar: ${err.message}`;
  }
  clearInterval(radar.refresh);
  radar.refresh = setInterval(async () => {
    try {
      await loadRadarFrames();
      await updateRainNow();
      loadForecast();
    } catch (err) { console.error(err); }
  }, RADAR_REFRESH_MS);
}

function stopRainLive() {
  radar.active = false;
  liveRain.level = 0;
  clearTimeout(radar.timer);
  clearInterval(radar.refresh);
  $('rainlive').hidden = true;
  $('rain-live-toggle').setAttribute('aria-pressed', 'false');
  mapReady.then(clearRadarLayers);
  updateRain();
  updatePhoneCards(false);
}

$('rain-live-toggle').addEventListener('click', () => {
  if (radar.active) { stopRainLive(); return; }
  startRainLive();
  updatePhoneCards(true);
});
$('rainlive-close').addEventListener('click', stopRainLive);
$('radar-play').addEventListener('click', () => setRadarPlaying(!radar.playing));
$('radar-latest').addEventListener('click', () => {
  setRadarPlaying(false);
  showRadarFrame(radar.frames.length - 1);
});
$('rain-live-anim').addEventListener('change', updateRain);

// From the heavy-rain scenario to the real rain now.
$('show-radar').addEventListener('click', () => { if (!radar.active) $('rain-live-toggle').click(); });

// A new address: read the rain and forecast there.
function onRainPlaceChanged() {
  if (!radar.active) return;
  updateRainNow();
  loadForecast();
}
