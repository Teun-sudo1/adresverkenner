// Water depth processing (runs in a Web Worker) and the flood simulation controls.
// Loaded as a classic script; see index.html for the load order.

// ---------- Water depth processing ----------

// RD New → WGS84, Schreutelkamp & Strang van Hees polynomial (≈0.3 m accurate,
// well within the 0.5 m raster cells).
function rdToWgs84(x, y) {
  const dX = (x - 155000) * 1e-5, dY = (y - 463000) * 1e-5;
  const K = [[0, 1, 3235.65389], [2, 0, -32.58297], [0, 2, -0.24750], [2, 1, -0.84978], [0, 3, -0.06550], [2, 2, -0.01709],
    [1, 0, -0.00738], [4, 0, 0.00530], [2, 3, -0.00039], [4, 1, 0.00033], [1, 1, -0.00012]];
  const L = [[1, 0, 5260.52916], [1, 1, 105.94684], [1, 2, 2.45656], [3, 0, -0.81885], [1, 3, 0.05594], [3, 1, -0.05607],
    [0, 1, 0.01199], [3, 2, -0.00256], [1, 4, 0.00128], [0, 2, 0.00022], [2, 0, -0.00022], [5, 0, 0.00026]];
  let lat = 0, lon = 0;
  for (const [p, q, k] of K) lat += k * dX ** p * dY ** q;
  for (const [p, q, l] of L) lon += l * dX ** p * dY ** q;
  return [5.38720621 + lon / 3600, 52.15517440 + lat / 3600];
}

// Sharpens a coarse (5 m) flood-depth grid with the 0.5 m terrain model.
// Water level per coarse cell = mean ground height + depth; that level is
// interpolated bilinearly to 0.5 m and the fine terrain is subtracted, so the
// shoreline follows kerbs, dikes and slopes instead of 5 m blocks. Pixels
// without terrain (buildings, open water) stay dry.
function refineDepth(coarse, dtm) {
  const cw = coarse.width, ch = coarse.height, cres = coarse.res;
  const sum = new Float64Array(cw * ch), cnt = new Uint32Array(cw * ch);
  const cellOf = (X, Y) => {
    const ci = Math.floor((X - coarse.x0) / cres), cj = Math.floor((coarse.y0 - Y) / cres);
    return ci >= 0 && cj >= 0 && ci < cw && cj < ch ? cj * cw + ci : -1;
  };
  for (let j = 0; j < dtm.height; j++) {
    for (let i = 0; i < dtm.width; i++) {
      const z = dtm.data[j * dtm.width + i];
      if (isNaN(z)) continue;
      const c = cellOf(dtm.x0 + (i + 0.5) * dtm.res, dtm.y0 - (j + 0.5) * dtm.res);
      if (c >= 0) { sum[c] += z; cnt[c]++; }
    }
  }
  const level = new Float64Array(cw * ch).fill(NaN);
  for (let c = 0; c < cw * ch; c++) {
    const d = coarse.data[c];
    if (d > 0 && cnt[c]) level[c] = sum[c] / cnt[c] + d;
  }

  const out = new Float32Array(dtm.width * dtm.height);
  for (let j = 0; j < dtm.height; j++) {
    for (let i = 0; i < dtm.width; i++) {
      const z = dtm.data[j * dtm.width + i];
      if (isNaN(z)) continue;
      const fx = (dtm.x0 + (i + 0.5) * dtm.res - coarse.x0) / cres - 0.5;
      const fy = (coarse.y0 - (dtm.y0 - (j + 0.5) * dtm.res)) / cres - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
      let acc = 0, wsum = 0;
      for (const [di, dj, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
        const ci = i0 + di, cj = j0 + dj;
        if (ci < 0 || cj < 0 || ci >= cw || cj >= ch) continue;
        const l = level[cj * cw + ci];
        if (isNaN(l) || w === 0) continue;
        acc += l * w;
        wsum += w;
      }
      if (wsum > 0) out[j * dtm.width + i] = Math.max(0, acc / wsum - z);
    }
  }
  return { ...dtm, data: out };
}

// Rasterises building footprints (RD New polygons) onto a grid's pixels.
// OffscreenCanvas so this also runs inside the water worker.
function footprintMask(grid, features) {
  const g = new OffscreenCanvas(grid.width, grid.height).getContext('2d');
  const px = ([x, y]) => [(x - grid.x0) / grid.res, (grid.y0 - y) / grid.res];
  for (const f of features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      g.beginPath();
      for (const ring of poly) {
        ring.forEach((c, i) => (i ? g.lineTo : g.moveTo).apply(g, px(c)));
        g.closePath();
      }
      // Even-odd keeps courtyards open.
      g.fill('evenodd');
    }
  }
  const rgba = g.getImageData(0, 0, grid.width, grid.height).data;
  const mask = new Uint8Array(grid.width * grid.height);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] > 127;
  return mask;
}

// The terrain model leaves out cars, trees and street furniture. Fill those
// gaps from neighbouring heights so they don't show up as dry specks, but keep
// building footprints empty so the water stops at the walls.
function fillTerrainGaps(dtm, mask, passes = 20) {
  const { width: w, height: h } = dtm;
  let cur = Float32Array.from(dtm.data);
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    let changed = false;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!isNaN(cur[k]) || mask[k]) continue;
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const v = cur[jj * w + ii];
          if (!isNaN(v)) { s += v; n++; }
        }
        if (n) { next[k] = s / n; changed = true; }
      }
    }
    cur = next;
    if (!changed) break;
  }
  return { ...dtm, data: cur };
}

// Depth bands for the 3D water: a slab from one level to the next over the
// area at least that deep. Finer steps where most street flooding happens.
const WATER_LEVELS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

// Averages f×f blocks (dry = 0). The 3D water uses a 1 m grid: still far
// finer than the 5 m source, with a quarter of the contour work.
function downsample(grid, f) {
  const w = Math.floor(grid.width / f), h = Math.floor(grid.height / f);
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let dj = 0; dj < f; dj++) for (let di = 0; di < f; di++) {
        const v = grid.data[(j * f + dj) * grid.width + i * f + di];
        if (v > 0) s += v;
      }
      data[j * w + i] = s / (f * f);
    }
  }
  return { data, width: w, height: h, x0: grid.x0, y0: grid.y0, res: grid.res * f };
}

// Douglas–Peucker on a closed ring in pixel units. The ring starts and ends on
// the same point, so it is first split at the vertex farthest from the start.
function simplifyRing(ring, tol) {
  if (ring.length <= 8) return ring;
  const last = ring.length - 1;
  let mid = 1, dmid = -1;
  for (let i = 1; i < last; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > dmid) { dmid = d; mid = i; }
  }
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[mid] = keep[last] = 1;
  const stack = [[0, mid], [mid, last]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let far = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (ring[i][0] - ax) - dx * (ring[i][1] - ay)) / len;
      if (d > dmax) { dmax = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

// Builds the 3D depth bands from a (1 m) grid.
function waterContours(grid) {
  const values = Array.from(grid.data, v => (v > 0 ? v : 0));
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const levels = WATER_LEVELS.filter(l => l <= max);
  if (!levels.length) return { features: [], max };
  const toLngLat = ([px, py]) => rdToWgs84(grid.x0 + px * grid.res, grid.y0 - py * grid.res);
  const contours = d3.contours().size([grid.width, grid.height]).thresholds(levels)(values);
  const features = [];
  contours.forEach((c, k) => {
    // Simplify in pixel space, then drop specks under ~1 m².
    const polys = c.coordinates
      .map(poly => poly.map(ring => simplifyRing(ring, 0.4)).filter((ring, i) => ring.length >= 4 && (i > 0 || ringArea(ring) >= 1)))
      .filter(poly => poly.length && ringArea(poly[0]) >= 1);
    if (!polys.length) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: polys.map(poly => poly.map(ring => ring.map(toLngLat))) },
      properties: { base: k ? levels[k - 1] : 0, top: c.value }
    });
  });
  return { features, max };
}

// Colour ramp for the flat water image: light and translucent when shallow,
// dark and opaque when deep.
const WATER_RAMP = [[0.02, [158, 202, 225, 140]], [0.1, [107, 174, 214, 170]], [0.3, [66, 146, 198, 195]],
  [0.5, [33, 113, 181, 210]], [1, [8, 81, 156, 220]], [2, [8, 48, 107, 230]]];

function waterColor(d) {
  if (!(d >= WATER_RAMP[0][0])) return null;
  for (let k = 1; k < WATER_RAMP.length; k++) {
    const [d1, c1] = WATER_RAMP[k];
    if (d <= d1) {
      const [d0, c0] = WATER_RAMP[k - 1], t = (d - d0) / (d1 - d0);
      return c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
    }
  }
  return WATER_RAMP[WATER_RAMP.length - 1][1];
}

// Paints the grid into RGBA pixels, with `depthAt` mapping peak depth to the
// depth at the current slider position.
// Pixels inside `hole` (an RD box covered by a sharper grid) stay transparent.
function paintWater(grid, depthAt, rgba, hole) {
  for (let j = 0; j < grid.height; j++) {
    const y = grid.y0 - (j + 0.5) * grid.res;
    for (let i = 0; i < grid.width; i++) {
      const k = j * grid.width + i, o = k * 4;
      const x = grid.x0 + (i + 0.5) * grid.res;
      const inHole = hole && x > hole[0] && x < hole[2] && y > hole[1] && y < hole[3];
      const c = inHole ? null : waterColor(depthAt(grid.data[k]));
      if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3]; }
      else rgba[o + 3] = 0;
    }
  }
}

function gridBounds(g) {
  return [g.x0, g.y0 - g.height * g.res, g.x0 + g.width * g.res, g.y0];
}

function gridCorners(grid) {
  const x1 = grid.x0 + grid.width * grid.res, y1 = grid.y0 - grid.height * grid.res;
  return [rdToWgs84(grid.x0, grid.y0), rdToWgs84(x1, grid.y0), rdToWgs84(x1, y1), rdToWgs84(grid.x0, y1)];
}

// ---------- Flood simulation ----------

// fflate rather than the browser's DecompressionStream: Safari's version
// fails ("The I/O read operation failed") on some of these raster tiles.
async function inflate(bytes) {
  return fflate.unzlibSync(bytes);
}

function rangeSource(url) {
  return async (offset, length) => {
    const res = await fetchWithRetry(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} bij ${new URL(url).hostname}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

// Downloads an RD New window from a WCS as GeoTIFF. Axis names differ per server.
async function fetchCoverage(base, coverageId, [minX, minY, maxX, maxY], ax, ay, extra = '') {
  const url = `${base}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${coverageId}` +
    `&subset=${ax}(${minX},${maxX})&subset=${ay}(${minY},${maxY})&format=image/tiff${extra}`;
  // cachedFetch exists on the page, not in the water worker.
  const res = await (typeof cachedFetch === 'function' ? cachedFetch : fetchWithRetry)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ${new URL(url).hostname}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const tiff = await openTiff(async (o, n) => buf.subarray(o, o + n), inflate);
  return tiff.readWindow(minX, minY, maxX, maxY);
}

// Follows OGC API "next" links; dense city centres exceed one page.
async function fetchAllFeatures(url, maxPages = 6) {
  const features = [];
  for (let i = 0; url && i < maxPages; i++) {
    const res = await (typeof cachedFetch === 'function' ? cachedFetch : fetchWithRetry)(url, { headers: { Accept: 'application/geo+json, application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} bij ${new URL(url).hostname}`);
    const page = await res.json();
    features.push(...page.features);
    url = page.links?.find(l => l.rel === 'next')?.href;
  }
  return features;
}

// Copies the part of a grid inside an RD box.
function cropGrid(grid, [minX, minY, maxX, maxY]) {
  const c0 = Math.max(0, Math.round((minX - grid.x0) / grid.res)), c1 = Math.min(grid.width, Math.round((maxX - grid.x0) / grid.res));
  const r0 = Math.max(0, Math.round((grid.y0 - maxY) / grid.res)), r1 = Math.min(grid.height, Math.round((grid.y0 - minY) / grid.res));
  const w = c1 - c0, h = r1 - r0, data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) data.set(grid.data.subarray((r0 + j) * grid.width + c0, (r0 + j) * grid.width + c1), j * w);
  return { data, width: w, height: h, x0: grid.x0 + c0 * grid.res, y0: grid.y0 - r0 * grid.res, res: grid.res };
}

// Writes `src` over `dst` where they overlap; both must share a resolution.
function pasteGrid(dst, src) {
  const data = dst.data.slice();
  const ci = Math.round((src.x0 - dst.x0) / dst.res), cj = Math.round((dst.y0 - src.y0) / dst.res);
  for (let j = 0; j < src.height; j++) {
    for (let i = 0; i < src.width; i++) {
      const x = ci + i, y = cj + j;
      if (x >= 0 && y >= 0 && x < dst.width && y < dst.height) data[y * dst.width + x] = src.data[j * src.width + i];
    }
  }
  return { ...dst, data };
}

// Downloads and processes the water for one address. Runs in a Web Worker,
// so it may only use its arguments and the functions in WORKER_FUNCTIONS.
// Returns a sharp 0.5 m grid near the address, a 1 m grid for the wider area
// and the 3D depth bands built from both.
async function computeWater(p) {
  const box = r => [p.x - r, p.y - r, p.x + r, p.y + r].map(Math.round);
  const bi = box(p.rInner), bo = box(p.rOuter);
  let inner, outer;
  if (p.kind === 'pluvial') {
    // Already 0.5 m: read the whole area once and derive both grids.
    const full = await (await openTiff(rangeSource(p.urls.pluvial), inflate)).readWindow(...bo);
    inner = cropGrid(full, bi);
    outer = downsample(full, 2);
  } else {
    // 5 m depths sharpened with the terrain model: 0.5 m near the address,
    // 1 m (resampled by the terrain service) further out. A margin of coarse
    // cells keeps the interpolation complete at the edges.
    const RD = 'http://www.opengis.net/def/crs/EPSG/0/28992';
    const pad = b => [b[0] - 10, b[1] - 10, b[2] + 10, b[3] + 10];
    const [coarse, dtmIn, dtmOut, panden] = await Promise.all([
      fetchCoverage(p.urls.kea, p.coverage, pad(bo), 'X', 'Y'),
      fetchCoverage(p.urls.ahn, 'dtm_05m', bi, 'x', 'y'),
      fetchCoverage(p.urls.ahn, 'dtm_05m', bo, 'x', 'y', '&SCALEFACTOR=0.5'),
      fetchAllFeatures(`${p.urls.bag}/collections/pand/items?f=json&limit=1000&bbox=${bo.join(',')}&bbox-crs=${RD}&crs=${RD}`)
    ]);
    inner = refineDepth(coarse, fillTerrainGaps(dtmIn, footprintMask(dtmIn, panden)));
    outer = refineDepth(coarse, fillTerrainGaps(dtmOut, footprintMask(dtmOut, panden), 10));
  }
  for (const g of [inner, outer]) for (let i = 0; i < g.data.length; i++) if (!(g.data[i] > 0)) g.data[i] = 0;

  const { features } = waterContours(pasteGrid(outer, downsample(inner, 2)));
  const maxOf = g => g.data.reduce((m, v) => (v > m ? v : m), 0);
  // Deepest water within 15 m of the address point (the point itself
  // usually lies inside the building, which stays dry).
  let nearMax = 0;
  for (let j = 0; j < inner.height; j++) {
    for (let i = 0; i < inner.width; i++) {
      const dx = inner.x0 + (i + 0.5) * inner.res - p.x, dy = inner.y0 - (j + 0.5) * inner.res - p.y;
      const v = inner.data[j * inner.width + i];
      if (dx * dx + dy * dy <= 225 && v > nearMax) nearMax = v;
    }
  }
  let wet = 0;
  for (const v of outer.data) if (v >= WATER_LEVELS[0]) wet++;
  return { inner, outer, features, max: Math.max(maxOf(inner), maxOf(outer)), nearMax, wetShare: wet / outer.data.length };
}

const D3_URLS = ['https://cdn.jsdelivr.net/npm/d3-array@3.2.4/dist/d3-array.min.js',
  'https://cdn.jsdelivr.net/npm/d3-contour@4.0.2/dist/d3-contour.min.js'];
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
const WORKER_FUNCTIONS = [fetchWithRetry, openTiff, inflate, rangeSource, fetchCoverage, fetchAllFeatures, rdToWgs84, refineDepth,
  footprintMask, fillTerrainGaps, downsample, simplifyRing, ringArea, waterContours, cropGrid, pasteGrid, computeWater];

// The worker is assembled from this page's own functions, so the water code
// exists once and the map stays responsive while it runs.
function startWaterWorker() {
  const src = [
    `importScripts(${[...D3_URLS, FFLATE_URL].map(u => JSON.stringify(u)).join(', ')});`,
    `const TIFF_TYPE_SIZE = ${JSON.stringify(TIFF_TYPE_SIZE)};`,
    `const WATER_LEVELS = ${JSON.stringify(WATER_LEVELS)};`,
    ...WORKER_FUNCTIONS.map(String),
    `onmessage = async e => {
      try {
        const r = await computeWater(e.data);
        postMessage(r, [r.inner.data.buffer, r.outer.data.buffer]);
      } catch (err) {
        postMessage({ error: err.message || String(err) });
      }
    };`
  ].join('\n');
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

let waterWorker = null;
let d3ForMainThread;

// Starting a new calculation cancels the previous one.
async function computeWaterInBackground(params) {
  waterWorker?.terminate();
  let worker;
  try {
    worker = waterWorker = startWaterWorker();
  } catch {
    // No workers (unusual): load d3 here and compute on the main thread.
    d3ForMainThread ??= Promise.all(D3_URLS.map(u => new Promise((res, rej) =>
      document.head.append(Object.assign(document.createElement('script'), { src: u, onload: res, onerror: rej })))));
    await d3ForMainThread;
    return computeWater(params);
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = e => {
      worker.terminate();
      if (waterWorker === worker) waterWorker = null;
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    worker.onerror = e => {
      worker.terminate();
      reject(new Error(e.message || 'rekenfout in het achtergrondproces'));
    };
    worker.postMessage(params);
  });
}

// The COG header is opened once and reused for every address.
let pluvialTiff;
function getPluvial() {
  pluvialTiff ??= openTiff(rangeSource(PLUVIAL_COG), inflate).catch(err => { pluvialTiff = undefined; throw err; });
  return pluvialTiff;
}

async function pluvialNear(x, y, r = 15) {
  const g = await (await getPluvial()).readWindow(x - r, y - r, x + r, y + r);
  return g.data.reduce((m, v) => (v > m ? v : m), 0);
}

let waterScenario = '';
// Computed water per address and scenario, so switching back is instant.
const waterResults = new Map();
let water = null;
let waterLoad = 0;
const waterCanvases = { inner: document.createElement('canvas'), outer: document.createElement('canvas') };

function setFloodInfo(text) {
  $('flood-info').textContent = text;
}

// The data holds only the peak: the highest water each spot reaches in the
// scenario. The slider lowers that whole surface by up to the maximum depth.
function waterDrop() {
  return water ? (1 - $('flood-level').value / 100) * water.max : 0;
}

// Depth at the current slider position for a spot whose peak depth is `d`.
// A flood raises one water surface, so the slider lowers it evenly and the
// shallow edges dry out first. Rain falls everywhere at once, so with heavy
// rain every spot fills in proportion to its peak depth.
function depthNow(d) {
  if (!water) return 0;
  return water.kind === 'pluvial' ? d * ($('flood-level').value / 100) : d - waterDrop();
}

const fmtWater = d => d < WATER_LEVELS[0] ? 'droog' : d < 1 ? `${Math.round(d * 100)} cm` : `${nf1.format(d)} m`;

const PEAK_EXPLAIN = {
  pluvial: 'Piek = de hoogste waterstand tijdens en vlak na een bui van 70 mm in één uur. Het model geeft geen tijdsverloop: de schuif laat het water overal naar verhouding opkomen, zoals tijdens een bui.',
  fluvial: 'Piek = de grootste waterdiepte bij een overstroming met deze kans, bijvoorbeeld na een dijkdoorbraak. Niet elke plek bereikt die op hetzelfde moment. Het model geeft geen tijdsverloop: de schuif laat het hele wateroppervlak gelijkmatig zakken, zodat ondiepe plekken eerst droogvallen.'
};

async function updateWaterVisibility() {
  await mapReady;
  for (const id of ['water-2d', 'water-2d-outer']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', water && !is3D ? 'visible' : 'none');
  }
  updateWater3D();
}

// Lowering the slider drops the whole water surface, so shallow edges dry
// out first, like a real flood receding.
let drawPending = false;
function applyWaterLevel() {
  updateRain();
  const level = Number($('flood-level').value);
  $('flood-pct').textContent = level === 100 ? 'piek'
    : water?.kind === 'pluvial' ? `${level}%` : `−${fmtWater(waterDrop()).replace('droog', '0 cm')}`;
  if (water) {
    $('flood-now').textContent = `Bij het adres: ${fmtWater(depthNow(water.nearMax))} · diepste punt: ${fmtWater(depthNow(water.max))}`;
  }
  if (!water || drawPending) return;
  drawPending = true;
  requestAnimationFrame(async () => {
    drawPending = false;
    if (!water) return;
    await mapReady;
    updateWater3D();
    if (!is3D) drawWaterImage();
  });
}

// Two images: the 1 m wide area with a hole, and the 0.5 m area on top.
// They are canvas sources: MapLibre reads the canvas directly, so every frame
// of the rising animation shows. (With image sources each new frame aborted
// the one still loading, and on a fast computer only the last one appeared.)
let waterUploadTimer = 0;
async function drawWaterImage() {
  const images = [
    { key: 'outer', grid: water.outer, hole: gridBounds(water.inner), source: 'water-img-outer', layer: 'water-2d-outer' },
    { key: 'inner', grid: water.inner, hole: null, source: 'water-img', layer: 'water-2d' }
  ];
  await mapReady;
  for (const im of images) {
    const canvas = waterCanvases[im.key];
    if (canvas.width !== im.grid.width || canvas.height !== im.grid.height) {
      canvas.width = im.grid.width;
      canvas.height = im.grid.height;
    }
    const ctx2d = canvas.getContext('2d');
    const img = ctx2d.createImageData(im.grid.width, im.grid.height);
    paintWater(im.grid, depthNow, img.data, im.hole);
    ctx2d.putImageData(img, 0, 0);
    const coordinates = gridCorners(im.grid);
    const src = map.getSource(im.source);
    if (!src) {
      map.addSource(im.source, { type: 'canvas', canvas, coordinates, animate: false });
      // Sharp pixels for the outer image: smoothing would fade its edge into the
      // cut-out and leave a light seam around the detailed area.
      map.addLayer({ id: im.layer, type: 'raster', source: im.source,
        paint: { 'raster-fade-duration': 0, 'raster-resampling': im.hole ? 'nearest' : 'linear' } }, 'buurt-line');
    } else if (JSON.stringify(src.coordinates) !== JSON.stringify(coordinates)) {
      src.setCoordinates(coordinates);
    }
    // Upload the new pixels: let the source run briefly, then pause it so the
    // map doesn't keep redrawing while nothing changes.
    map.getSource(im.source).play();
  }
  clearTimeout(waterUploadTimer);
  waterUploadTimer = setTimeout(() => images.forEach(im => map.getSource(im.source)?.pause()), 250);
  updateWaterVisibility();
}

async function loadWater() {
  const mine = ++waterLoad;
  const sc = WATER_SCENARIOS[waterScenario];
  water = null;
  disposeWater3D();
  updateRain();
  updateWaterVisibility();
  $('flood-controls').hidden = !sc;
  $('flood-scenario-hint').hidden = sc?.kind !== 'fluvial';
  $('flood-now').textContent = '';
  if (!sc) { waterWorker?.terminate(); return; }
  $('flood-explain').textContent = PEAK_EXPLAIN[sc.kind];
  if (!current) { setFloodInfo('Zoek eerst een adres.'); return; }
  const ctx = current;
  setFloodInfo('Waterdiepte ophalen en berekenen…');
  try {
    const cacheKey = `${waterScenario}|${Math.round(ctx.x)},${Math.round(ctx.y)}`;
    const res = waterResults.get(cacheKey) ?? await track(computeWaterInBackground({
      kind: sc.kind, coverage: sc.coverage, x: ctx.x, y: ctx.y, rInner: WATER_RADIUS_DETAIL, rOuter: WATER_RADIUS,
      urls: { pluvial: PLUVIAL_COG, kea: KEA_WCS, ahn: AHN_WCS, bag: BAG }
    }));
    waterResults.delete(cacheKey);
    waterResults.set(cacheKey, res);
    if (waterResults.size > 8) waterResults.delete(waterResults.keys().next().value);
    if (mine !== waterLoad) return;
    if (res.max < WATER_LEVELS[0]) {
      setFloodInfo(`Geen water van betekenis binnen ${WATER_RADIUS} m van het adres.`);
      return;
    }
    water = { ...res, kind: sc.kind };
    prepareRain();
    stopWaterPlay();
    $('flood-level').value = reducedMotion.matches ? 100 : 0;
    buildWater3D();
    applyWaterLevel();
    if (!is3D) drawWaterImage();
    updateWaterVisibility();
    if (!reducedMotion.matches) playWater();
    const at = sc.kind === 'pluvial' ? 'Hevige regen' : 'Overstroming';
    setFloodInfo(`${at}: ${nf.format(Math.round(res.wetShare * 100))}% van het gebied tot ${WATER_RADIUS} m nat, max. ${nf1.format(res.max)} m diep. ` +
      (sc.kind === 'fluvial'
        ? `Verfijnd met het AHN-hoogtemodel: 0,5 m tot ${WATER_RADIUS_DETAIL} m van het adres, 1 m daarbuiten.`
        : `0,5 m detail tot ${WATER_RADIUS_DETAIL} m van het adres, 1 m daarbuiten.`));
  } catch (err) {
    if (mine !== waterLoad) return;
    console.error(err);
    setFloodInfo(`Waterdiepte niet beschikbaar: ${err.message}`);
  }
}

$('flood-scenario').addEventListener('change', () => {
  waterScenario = $('flood-scenario').value;
  loadWater();
});

// The Overstroming button opens the panel; closing it also clears the water.
const floodPanel = { open: false };
function setFloodPanel(open) {
  floodPanel.open = open;
  $('flood').hidden = !open;
  $('flood-toggle').setAttribute('aria-pressed', open);
  if (!open && waterScenario) {
    $('flood-scenario').value = '';
    $('flood-scenario').dispatchEvent(new Event('change'));
  }
  updatePhoneCards(open);
  if (open) updateFloodNap();
}

// Ground level at the address relative to NAP (roughly mean sea level), at
// the top of the panel. 3D BAG gives it per building; addresses without a
// building (houseboats, pitches) use the AHN terrain model around the point.
async function updateFloodNap() {
  const ctx = current;
  if (!ctx) { $('flood-nap').hidden = true; return; }
  let v = ctx.maaiveld;
  if (v == null) {
    if (!floodPanel.open || ctx.napTried) return;
    ctx.napTried = true;
    try {
      // On the water itself the terrain model is empty: look further out, to the quay.
      for (const r of [5, 15, 30]) {
        const g = await fetchCoverage(AHN_WCS, 'dtm_05m', [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r].map(Math.round), 'x', 'y');
        const valid = [...g.data].filter(h => Math.abs(h) < 500).sort((a, b) => a - b);
        if (valid.length) { v = valid[Math.floor(valid.length / 2)]; break; }
      }
      if (v == null || current !== ctx || ctx.maaiveld != null) return;
    } catch (err) {
      console.error(err);
      return;
    }
  }
  if (current !== ctx) return;
  const where = Math.abs(v) < 0.05 ? 'op NAP-hoogte' : `${nf1.format(Math.abs(v))} m ${v < 0 ? 'onder' : 'boven'} NAP`;
  $('flood-nap').textContent = `Maaiveld bij dit adres: ${where}${v < 0 ? ', onder zeeniveau' : ''}.`;
  $('flood-nap').hidden = false;
}

$('flood-toggle').addEventListener('click', () => setFloodPanel(!floodPanel.open));
$('flood-close').addEventListener('click', () => setFloodPanel(false));
$('flood-level').addEventListener('input', applyWaterLevel);

// ---------- 3D water (three.js) ----------

// In 3D the water is one three.js mesh of depth bands. Heavy rain scales it in
// height; a flood shifts it down and a plane at ground level clips what sinks
// below. Each frame of the animation is then a single number. (As a MapLibre
// extrusion every height change meant rebuilding the layer, which a running
// animation never let finish, so the water stayed at its peak.)
const water3d = { group: null, source: null };

// One depth band: walls from z0 to z1 and a flat top, from a GeoJSON polygon.
function addSlab(mb, poly, frame, z0, z1, rgb) {
  const rings = poly.map((ring, ri) => {
    const r = ring.map(frame.fromLngLat);
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    if ((ri === 0) !== (signedArea(r) > 0)) r.reverse();
    return r;
  }).filter(r => r.length >= 3);
  if (!rings.length) return;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const n = [(by - ay) / len, -(bx - ax) / len, 0];
      mb.tri([ax, ay, z0], [bx, by, z0], [bx, by, z1], n, rgb);
      mb.tri([ax, ay, z0], [bx, by, z1], [ax, ay, z1], n, rgb);
    }
  }
  const flat = rings.flat();
  const faces = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)),
    rings.slice(1).map(r => r.map(([x, y]) => new THREE.Vector2(x, y))));
  for (const [a, b, c] of faces) mb.tri([...flat[a], z1], [...flat[b], z1], [...flat[c], z1], [0, 0, 1], rgb);
}

function disposeWater3D() {
  if (!water3d.group) return;
  water3d.group.parent?.remove(water3d.group);
  // The bands share one material; dispose each resource once.
  const done = new Set();
  water3d.group.traverse(o => {
    for (const r of [o.geometry, o.material]) if (r && !done.has(r)) { done.add(r); r.dispose(); }
  });
  Object.assign(water3d, { group: null, source: null });
  map.triggerRepaint();
}

function buildWater3D() {
  if (!THREE || !three.scene || !current || !water) return;
  if (water3d.source === water) {
    if (water3d.group.parent !== three.scene) three.scene.add(water3d.group);
    return;
  }
  disposeWater3D();
  const frame = localFrame();
  const rgb = new THREE.Color().setStyle('#2f7fd0');
  const material = new THREE.MeshLambertMaterial({
    color: 0x2f7fd0, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
    clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]
  });
  // One mesh per depth band, so bands can appear one by one as the rain fills up.
  const group = new THREE.Group();
  for (const f of water.features) {
    const mb = new MeshBuilder();
    for (const poly of f.geometry.coordinates) addSlab(mb, poly, frame, f.properties.base, f.properties.top, rgb);
    const mesh = new THREE.Mesh(mb.geometry(), material);
    mesh.userData.top = f.properties.top;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  three.scene.add(group);
  Object.assign(water3d, { group, source: water });
  updateWater3D();
}

function moveWater3D(from, to) {
  if (!water3d.group) return;
  from?.remove(water3d.group);
  to.add(water3d.group);
}

function updateWater3D() {
  const g = water3d.group;
  if (!g) return;
  const level = Number($('flood-level').value) / 100;
  if (water?.kind === 'pluvial') {
    g.scale.z = Math.max(level, 1e-4);
    g.position.z = 0;
    // Rain is only centimetres deep, so scaling alone looks like a full sheet
    // from the start. The bands therefore appear one by one over the rise,
    // deepest first: water collects in the lowest spots and spreads from there.
    // (Bands are ordered shallow to deep.)
    const n = g.children.length;
    g.children.forEach((m, k) => { m.visible = level > 0 && k >= Math.floor((1 - level) * n); });
  } else {
    for (const m of g.children) m.visible = true;
    g.scale.z = 1;
    g.position.z = -waterDrop();
  }
  g.visible = !!water && is3D && (water.kind !== 'pluvial' || level > 0);
  map.triggerRepaint();
}

// Lets the water rise from nothing to the peak in about eight seconds.
let playFrame = 0;
function stopWaterPlay() {
  cancelAnimationFrame(playFrame);
  playFrame = 0;
  $('flood-play').textContent = '▶';
}

function playWater() {
  stopWaterPlay();
  $('flood-play').textContent = '❚❚';
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(100, Math.round((now - t0) / 80));
    $('flood-level').value = p;
    applyWaterLevel();
    if (p < 100) playFrame = requestAnimationFrame(step);
    else stopWaterPlay();
  };
  playFrame = requestAnimationFrame(step);
}

$('flood-play').addEventListener('click', () => (playFrame ? stopWaterPlay() : playWater()));
// Dragging the slider takes over from the animation.
$('flood-level').addEventListener('pointerdown', stopWaterPlay);
