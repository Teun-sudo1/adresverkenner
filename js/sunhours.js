// Sun hours map: for the chosen day, how many hours of sun each spot gets.
// Shade is cast over the AHN surface model (buildings and trees, 1 m) every
// quarter of an hour from sunrise to sunset.
// Loaded as a classic script; see index.html for the load order.

const SUNHOURS_STEP_MIN = 15;
// Extra margin so tall buildings and trees just outside the area still cast shade.
const SUNHOURS_MARGIN = 100;
const sunHours = { on: false, grid: null, max: 0, run: 0, canvas: document.createElement('canvas') };

// WGS84 → RD New, inverse of rdToWgs84 (≈0.3 m accurate).
function wgs84ToRd(lon, lat) {
  const dF = 0.36 * (lat - 52.15517440), dL = 0.36 * (lon - 5.38720621);
  const R = [[0, 1, 190094.945], [1, 1, -11832.228], [2, 1, -114.221], [0, 3, -32.391], [1, 0, -0.705], [3, 1, -2.340], [1, 3, -0.608], [0, 2, -0.008], [2, 3, 0.148]];
  const S = [[1, 0, 309056.544], [0, 2, 3638.893], [2, 0, 73.077], [1, 2, -157.984], [3, 0, 59.788], [0, 1, 0.433], [2, 2, -6.439], [1, 1, -0.032], [0, 4, 0.092], [1, 4, -0.054]];
  let x = 155000, y = 463000;
  for (const [p, q, r] of R) x += r * dF ** p * dL ** q;
  for (const [p, q, s] of S) y += s * dF ** p * dL ** q;
  return [x, y];
}

// Which cells of a height grid are in the sun, for one sun position. Cells are
// swept starting at the sun's side; each carries the height of the shadow
// "ceiling" from the cell one step towards the sun, lowered by the sun's
// slope. A cell is lit when that ceiling isn't above its own surface.
function litMask(g, azimuth, altitude) {
  const W = g.width, H = g.height, z = g.data;
  const di = Math.sin(azimuth), dj = -Math.cos(azimuth);   // towards the sun, in columns / rows
  const alongCols = Math.abs(di) >= Math.abs(dj);
  const major = alongCols ? W : H, minor = alongCols ? H : W;
  const dir = Math.sign(alongCols ? di : dj) || 1;
  const offset = alongCols ? dj / Math.abs(di) : di / Math.abs(dj);   // minor shift per major step
  const fall = Math.hypot(1, offset) * g.res * Math.tan(altitude);
  const idx = alongCols ? (a, b) => b * W + a : (a, b) => a * W + b;
  const ceiling = new Float32Array(W * H), lit = new Uint8Array(W * H);
  const start = dir > 0 ? major - 1 : 0, end = dir > 0 ? -1 : major;
  for (let a = start; a !== end; a -= dir) {
    const prev = a + dir;
    const hasPrev = prev >= 0 && prev < major;
    for (let b = 0; b < minor; b++) {
      const k = idx(a, b), h = z[k];
      let shade = -Infinity;
      if (hasPrev) {
        const pb = b + offset, b0 = Math.floor(pb), t = pb - b0;
        if (b0 >= 0 && b0 + 1 < minor) shade = ceiling[idx(prev, b0)] * (1 - t) + ceiling[idx(prev, b0 + 1)] * t - fall;
        else if (b0 >= 0 && b0 < minor) shade = ceiling[idx(prev, b0)] - fall;
      }
      ceiling[k] = Math.max(h, shade);
      // A little tolerance so noise in the surface model doesn't shade itself.
      lit[k] = shade <= h + 0.3 ? 1 : 0;
    }
  }
  return lit;
}

async function computeSunHours() {
  const run = ++sunHours.run;
  const ctx = current;
  $('sunhours-info').textContent = 'Hoogtemodel ophalen…';
  const r = SCENE_RADIUS, m = SUNHOURS_MARGIN;
  const box = [ctx.x - r - m, ctx.y - r - m, ctx.x + r + m, ctx.y + r + m].map(Math.round);
  const dsm = await track(fetchCoverage(AHN_WCS, 'dsm_05m', box, 'x', 'y', '&SCALEFACTOR=0.5'));
  if (run !== sunHours.run) return;
  // Fill small gaps from neighbours; open water and other big gaps become the lowest ground.
  const filled = fillTerrainGaps(dsm, new Uint8Array(dsm.data.length), 10);
  let lowest = Infinity;
  for (const v of filled.data) if (v < lowest) lowest = v;
  for (let i = 0; i < filled.data.length; i++) if (isNaN(filled.data[i])) filled.data[i] = lowest;

  const hours = new Float32Array(filled.data.length);
  const { rise, set } = sunTimes();
  const from = rise ?? 0, to = set ?? 1440;
  let steps = 0;
  for (let t = from; t <= to; t += SUNHOURS_STEP_MIN) {
    const pos = sunPosition(sunDate(t), ctx.lat, ctx.lon);
    if (pos.altitude < 2 * Math.PI / 180) continue;
    const lit = litMask(filled, pos.azimuth, pos.altitude);
    for (let i = 0; i < hours.length; i++) hours[i] += lit[i] * SUNHOURS_STEP_MIN / 60;
    // Keep the page responsive between steps.
    if (++steps % 4 === 0) {
      $('sunhours-info').textContent = `Schaduw berekenen… ${Math.round((t - from) / (to - from) * 100)}%`;
      await new Promise(res => setTimeout(res));
      if (run !== sunHours.run) return;
    }
  }
  if (run !== sunHours.run) return;
  const grid = cropGrid({ ...filled, data: hours }, [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r]);
  sunHours.grid = grid;
  sunHours.max = grid.data.reduce((a, v) => (v > a ? v : a), 0);
  $('sunhours-max').textContent = `${nf1.format(sunHours.max)} uur`;
  $('sunhours-info').textContent = `Uren zon op ${new Date(sunDate(720)).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })}, rekening houdend met gebouwen en bomen. Beweeg over de kaart voor de waarde per plek.`;
  drawSunHours();
}

// Sequential amber ramp: dark for little sun, light yellow for a lot.
const SUNHOURS_RAMP = [[0, [92, 58, 10]], [0.5, [214, 136, 30]], [1, [255, 236, 150]]];

function drawSunHours() {
  const g = sunHours.grid;
  const c = sunHours.canvas;
  c.width = g.width;
  c.height = g.height;
  const ctx2d = c.getContext('2d');
  const img = ctx2d.createImageData(g.width, g.height);
  for (let i = 0; i < g.data.length; i++) {
    const t = sunHours.max ? g.data[i] / sunHours.max : 0;
    const k = t <= 0.5 ? 0 : 1, u = (t - SUNHOURS_RAMP[k][0]) / (SUNHOURS_RAMP[k + 1][0] - SUNHOURS_RAMP[k][0]);
    const [c0, c1] = [SUNHOURS_RAMP[k][1], SUNHOURS_RAMP[k + 1][1]];
    img.data.set([0, 1, 2].map(j => Math.round(c0[j] + (c1[j] - c0[j]) * u)).concat(190), i * 4);
  }
  ctx2d.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  const coordinates = gridCorners(g);
  const src = map.getSource('sunhours-img');
  if (src) {
    src.updateImage({ url, coordinates });
  } else {
    map.addSource('sunhours-img', { type: 'image', url, coordinates });
    // Below the water, so a flood still shows on top.
    const before = ['water-2d-outer', 'water-2d', 'buurt-line'].find(id => map.getLayer(id));
    map.addLayer({ id: 'sunhours-2d', type: 'raster', source: 'sunhours-img', paint: { 'raster-fade-duration': 0 } }, before);
  }
  map.setLayoutProperty('sunhours-2d', 'visibility', 'visible');
  $('sunhours-legend').hidden = false;
}

function hideSunHours() {
  sunHours.on = false;
  sunHours.run++;
  sunHours.grid = null;
  $('sunhours-btn').textContent = 'Zonuren op deze dag';
  $('sunhours-btn').setAttribute('aria-pressed', 'false');
  $('sunhours-legend').hidden = true;
  $('sunhours-info').textContent = '';
  if (map.getLayer('sunhours-2d')) map.setLayoutProperty('sunhours-2d', 'visibility', 'none');
}

// Sun hours at a map position, for the hover popup.
function sunHoursAt(lngLat) {
  const g = sunHours.grid;
  if (!g) return null;
  const [x, y] = wgs84ToRd(lngLat.lng, lngLat.lat);
  const i = Math.floor((x - g.x0) / g.res), j = Math.floor((g.y0 - y) / g.res);
  if (i < 0 || j < 0 || i >= g.width || j >= g.height) return null;
  return g.data[j * g.width + i];
}

async function startSunHours() {
  if (!current) return;
  sunHours.on = true;
  $('sunhours-btn').textContent = 'Zonuren verbergen';
  $('sunhours-btn').setAttribute('aria-pressed', 'true');
  try {
    await computeSunHours();
  } catch (err) {
    console.error(err);
    $('sunhours-info').textContent = `Zonuren niet beschikbaar: ${err.message}`;
  }
}

$('sunhours-btn').addEventListener('click', () => (sunHours.on ? hideSunHours() : startSunHours()));

// A new date means new sun paths: recompute, shortly after the last change.
let sunHoursTimer = 0;
$('sun-date').addEventListener('input', () => {
  if (!sunHours.on) return;
  clearTimeout(sunHoursTimer);
  sunHoursTimer = setTimeout(startSunHours, 400);
});
