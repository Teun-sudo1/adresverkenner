// Rain in the view: during the heavy-rain scenario, and when the live radar
// shows real rain at the address. Streaks over the flat map, or drops falling
// through 3D space, plus ripples where the scenario's water stands. Purely
// for atmosphere; water depths come from the model, rain levels from the radar.
// Loaded as a classic script; see index.html for the load order.

const rain = {
  enabled: !reducedMotion.matches,
  frame: 0,
  last: 0,
  // Wet spots to put ripples on: { lngLat, depth } sampled from the water grids.
  wet: [],
  streaks: [],
  ripples2d: [],
  group: null,
  groupKey: '',
  drops: null,
  ripples3d: []
};
$('rain-toggle').checked = rain.enabled;

// The scenario rains while the bui is still on its way to the peak: whenever
// the water level is below 100%, which is what ▶ plays through.
function scenarioRaining() {
  return rain.enabled && waterScenario === 'regen70' && !!water && Number($('flood-level').value) < 100;
}

// Real rain from the radar, unless switched off or the system asks for less motion.
function liveRaining() {
  return radar.active && liveRain.level > 0 && $('rain-live-anim').checked && !reducedMotion.matches;
}

function isRaining() {
  return scenarioRaining() || liveRaining();
}

// Share of the full downpour to show: the scenario is a heavy storm, real
// rain follows the radar level.
function rainDensity() {
  return Math.max(scenarioRaining() ? 1 : 0, liveRaining() ? RAIN_DENSITY[liveRain.level] : 0);
}

function updateRain() {
  $('rain-row').hidden = waterScenario !== 'regen70';
  $('show-radar').hidden = waterScenario !== 'regen70';
  if (isRaining()) {
    if (!rain.frame) {
      rain.last = performance.now();
      rain.frame = requestAnimationFrame(rainStep);
    }
  } else {
    stopRain();
  }
}

function stopRain() {
  cancelAnimationFrame(rain.frame);
  rain.frame = 0;
  const canvas = $('rain-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  rain.streaks = [];
  rain.ripples2d = [];
  if (rain.group) {
    rain.group.visible = false;
    map.triggerRepaint();
  }
}

$('rain-toggle').addEventListener('change', () => {
  rain.enabled = $('rain-toggle').checked;
  updateRain();
});

// Samples up to 1,500 wet cells near the address as ripple spots.
function prepareRain() {
  rain.wet = [];
  if (!water) return;
  const cells = [];
  for (const g of [water.inner, water.outer]) {
    for (let k = 0; k < 4000; k++) {
      const i = Math.floor(Math.random() * g.width), j = Math.floor(Math.random() * g.height);
      const depth = g.data[j * g.width + i];
      if (depth >= 0.05) cells.push({ x: g.x0 + (i + 0.5) * g.res, y: g.y0 - (j + 0.5) * g.res, depth });
    }
  }
  rain.wet = cells.slice(0, 1500).map(c => ({ lngLat: rdToWgs84(c.x, c.y), depth: c.depth, local: null }));
  rain.groupKey = '';
}

// A random wet spot that is still under water at the current level.
function pickWetSpot() {
  for (let tries = 0; tries < 30 && rain.wet.length; tries++) {
    const s = rain.wet[Math.floor(Math.random() * rain.wet.length)];
    if (depthNow(s.depth) >= WATER_LEVELS[0]) return s;
  }
  return null;
}

function rainStep(now) {
  const dt = Math.min(0.05, (now - rain.last) / 1000);
  rain.last = now;
  if (is3D && THREE && three.scene) {
    clear2d();
    step3d(dt, now);
  } else {
    if (rain.group) rain.group.visible = false;
    step2d(dt, now);
  }
  rain.frame = requestAnimationFrame(rainStep);
}

// ---------- Flat map: streaks over the screen, ripples on wet spots ----------

function clear2d() {
  const canvas = $('rain-canvas');
  if (canvas.width) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function step2d(dt, now) {
  const canvas = $('rain-canvas');
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const dark = isDark();

  // About one streak per 1,500 px², falling slightly slanted by the wind.
  const target = Math.round((w * h) / 1500 * rainDensity() * (isFast() ? 0.5 : 1));
  while (rain.streaks.length < target) rain.streaks.push({ x: Math.random() * w, y: Math.random() * h, v: 700 + Math.random() * 400 });
  rain.streaks.length = target;
  ctx.strokeStyle = dark ? 'rgba(190, 210, 245, 0.45)' : 'rgba(90, 120, 170, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const s of rain.streaks) {
    s.y += s.v * dt;
    s.x += s.v * dt * 0.18;
    if (s.y > h) { s.y -= h + 20; s.x = Math.random() * w; }
    if (s.x > w) s.x -= w;
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - 2.5, s.y - 14);
  }
  ctx.stroke();

  // Ripples: ~40 per second on spots still under water.
  for (let n = Math.floor(40 * dt + Math.random()); n > 0; n--) {
    const s = pickWetSpot();
    if (s) rain.ripples2d.push({ s, t0: now });
  }
  ctx.lineWidth = 1.2;
  rain.ripples2d = rain.ripples2d.filter(r => now - r.t0 < 600);
  for (const r of rain.ripples2d) {
    const t = (now - r.t0) / 600;
    const p = map.project(r.s.lngLat);
    if (p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) continue;
    ctx.strokeStyle = dark ? `rgba(210, 225, 255, ${0.7 * (1 - t)})` : `rgba(255, 255, 255, ${0.85 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1 + 6 * t, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- 3D: drops falling through space, ripples on the water ----------

const RAIN_RADIUS = 150, RAIN_TOP = 70, RIPPLE_POOL = 120;
const dropCount = () => (isFast() ? 2000 : 5000);

// The group lives in the three.js scene; scene rebuilds hand it over.
function moveRain3D(from, to) {
  if (!rain.group) return;
  from?.remove(rain.group);
  to.add(rain.group);
}

function ensureRain3D() {
  const key = `${current.lon},${current.lat},${isDark()},${quality.mode}`;
  if (rain.group && rain.groupKey === key) {
    if (rain.group.parent !== three.scene) three.scene.add(rain.group);
    return;
  }
  if (rain.group) {
    rain.group.parent?.remove(rain.group);
    rain.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }
  const frame = localFrame();
  for (const s of rain.wet) s.local = frame.fromLngLat(s.lngLat);

  // Drops: short streaks, each a pair of points, slanted a little by the wind.
  const count = dropCount();
  const pos = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 2 - 1) * RAIN_RADIUS, y = (Math.random() * 2 - 1) * RAIN_RADIUS, z = Math.random() * RAIN_TOP;
    pos.set([x, y, z, x + 0.15, y + 0.1, z + 1.2], i * 6);
  }
  const dropGeom = new THREE.BufferGeometry();
  dropGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const drops = new THREE.LineSegments(dropGeom, new THREE.LineBasicMaterial({
    color: isDark() ? 0xc8d8f5 : 0x5a78aa, transparent: true, opacity: 0.55, depthWrite: false
  }));
  drops.frustumCulled = false;

  // Ripples: a pool of rings that grow and fade on the water surface.
  const circle = [];
  for (let i = 0; i <= 24; i++) circle.push(new THREE.Vector3(Math.cos(i / 24 * Math.PI * 2), Math.sin(i / 24 * Math.PI * 2), 0));
  const ringGeom = new THREE.BufferGeometry().setFromPoints(circle);
  rain.ripples3d = [];
  const group = new THREE.Group();
  group.add(drops);
  for (let i = 0; i < RIPPLE_POOL; i++) {
    const ring = new THREE.Line(ringGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.visible = false;
    group.add(ring);
    rain.ripples3d.push({ ring, t0: 0 });
  }
  Object.assign(rain, { group, drops, groupKey: key });
  three.scene.add(group);
}

function step3d(dt, now) {
  if (!current) return;
  ensureRain3D();
  rain.group.visible = true;

  // Fall at ~9 m/s; drops that reach the ground start again at the top.
  const pos = rain.drops.geometry.attributes.position.array;
  const fall = 9 * dt;
  for (let i = 0; i < pos.length; i += 6) {
    pos[i + 2] -= fall;
    pos[i + 5] -= fall;
    if (pos[i + 2] < 0) {
      pos[i + 2] += RAIN_TOP;
      pos[i + 5] += RAIN_TOP;
    }
  }
  rain.drops.geometry.attributes.position.needsUpdate = true;
  // Lighter rain: draw only part of the drops (two vertices per drop).
  rain.drops.geometry.setDrawRange(0, Math.round(rain.drops.geometry.attributes.position.count * rainDensity() / 2) * 2);

  // Ripples on the water surface, at the current depth of each spot.
  // Ripples need the scenario's water to land in.
  let spawn = scenarioRaining() && rain.wet.length ? Math.round(60 * dt + Math.random()) : 0;
  for (const r of rain.ripples3d) {
    const t = (now - r.t0) / 700;
    if (r.ring.visible && t >= 1) r.ring.visible = false;
    if (!r.ring.visible && spawn > 0) {
      const s = pickWetSpot();
      spawn--;
      if (!s?.local) continue;
      r.ring.position.set(s.local[0], s.local[1], depthNow(s.depth) + 0.05);
      r.ring.visible = true;
      r.t0 = now;
    } else if (r.ring.visible) {
      r.ring.scale.setScalar(0.15 + 0.9 * t);
      r.ring.material.opacity = 0.8 * (1 - t);
    }
  }
  map.triggerRepaint();
}
