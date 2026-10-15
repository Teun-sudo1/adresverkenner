// Live rain radar (RainViewer): the past two hours in 10-minute frames,
// looped over the map. RainViewer's free tiles go up to zoom 7; MapLibre
// enlarges them beyond that, which suits radar's ~1 km resolution.
// Loaded as a classic script; see index.html for the load order.

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_REFRESH_MS = 5 * 60 * 1000;
const RADAR_FRAME_MS = 600;
const radar = { frames: [], index: 0, timer: 0, refresh: 0, playing: !reducedMotion.matches, active: false };

const radarLayerId = i => `radar-${i}`;

function clearRadarLayers() {
  for (let i = 0; i < radar.frames.length; i++) {
    if (map.getLayer(radarLayerId(i))) map.removeLayer(radarLayerId(i));
    if (map.getSource(radarLayerId(i))) map.removeSource(radarLayerId(i));
  }
  radar.frames = [];
}

async function loadRadarFrames() {
  // Always fresh: the radar changes every few minutes, so no response cache.
  const res = await track(fetch(RAINVIEWER_API));
  if (!res.ok) throw new Error(`HTTP ${res.status} bij RainViewer`);
  const data = await res.json();
  await mapReady;
  if (!radar.active) return;
  clearRadarLayers();
  radar.frames = data.radar.past;
  // Each frame is its own layer, so the loop only switches opacity and the
  // tiles of every frame are loaded once.
  const before = ['sunhours-2d', 'water-2d-outer', 'water-2d', 'buurt-line'].find(id => map.getLayer(id));
  radar.frames.forEach((f, i) => {
    map.addSource(radarLayerId(i), {
      type: 'raster', tileSize: 256, maxzoom: 7, attribution: 'Radar © RainViewer',
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
  const time = new Date(f.time * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const last = i === radar.frames.length - 1;
  $('radar-time').textContent = last ? `${time} (laatste beeld)` : time;
}

// Loop through the frames, lingering a little on the latest one.
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

async function startRadar() {
  radar.active = true;
  $('radar-controls').hidden = false;
  $('radar-time').textContent = 'Radar laden…';
  try {
    await loadRadarFrames();
    setRadarPlaying(radar.playing);
  } catch (err) {
    console.error(err);
    $('radar-time').textContent = `Radar niet beschikbaar: ${err.message}`;
  }
  clearInterval(radar.refresh);
  radar.refresh = setInterval(() => loadRadarFrames().catch(err => console.error(err)), RADAR_REFRESH_MS);
}

function stopRadar() {
  radar.active = false;
  clearTimeout(radar.timer);
  clearInterval(radar.refresh);
  $('radar-controls').hidden = true;
  mapReady.then(clearRadarLayers);
}

$('radar-play').addEventListener('click', () => setRadarPlaying(!radar.playing));
$('radar-latest').addEventListener('click', () => {
  setRadarPlaying(false);
  showRadarFrame(radar.frames.length - 1);
});

// From the heavy-rain scenario straight to the current radar.
$('show-radar').addEventListener('click', () => {
  $('env-layer').value = 'radar';
  $('env-layer').dispatchEvent(new Event('change'));
});
