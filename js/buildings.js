// 3D view, building colours and filters, the three.js cartoon style and the light/dark theme.
// Loaded as a classic script; see index.html for the load order.

// ---------- 3D view ----------

// Set by loadAddress; the 3D scene is built around this location.
let current = null;
let sceneFor = null;

// Cartoon and Zon are always visible and switch 3D on when used; switching
// 3D off turns them off too.
async function set3D(on) {
  if (on === is3D) return;
  is3D = on;
  $('view3d').setAttribute('aria-pressed', is3D);
  if (!is3D) {
    if (cartoon) toggleCartoon();
    if (sun.on) toggleSun();
  }
  await mapReady;
  for (const id of ['pand-fill', 'pand-line']) map.setLayoutProperty(id, 'visibility', is3D ? 'none' : 'visible');
  updateSunPanel();
  applyBuildingStyle();
  updateLegendHint();
  map.easeTo(is3D ? { pitch: 60, bearing: -20, zoom: Math.max(map.getZoom(), 17) } : { pitch: 0, bearing: 0 });
  if (is3D) {
    loadScene();
    loadTreeHeights(current).catch(err => console.error(err));
  }
  updateTreeLayer();
  // The flat water image isn't redrawn while in 3D, so refresh it on the way back.
  if (water && !is3D) drawWaterImage();
  updateWaterVisibility();
  updateRain();
}

$('view3d').addEventListener('click', () => set3D(!is3D));

// The searched building stands out; the pand ids arrive after the scene may
// already have started loading, so this is applied separately.
let highlightIds = [];
function highlight3D(ids) {
  highlightIds = ids;
  applyBuildingStyle();
}

// ---------- Building colours and filters ----------

// Each theme sorts panden into classes. The map colours by class and hides
// classes switched off in the legend. One table per theme drives both the
// MapLibre expression (2D tiles, 3D blocks) and `classify` (three.js
// buildings), so all of them agree.
const STATUS_GROUPS = {
  gebruik: ['Pand in gebruik', 'Pand in gebruik (niet ingemeten)'],
  bouw: ['Bouwvergunning verleend', 'Bouw gestart'],
  verbouwing: ['Verbouwing pand'],
  buiten: ['Pand buiten gebruik'],
  sloop: ['Sloopvergunning verleend', 'Pand gesloopt']
};
const FUNCTION_KEYS = {
  woonfunctie: 'woon', winkelfunctie: 'winkel', kantoorfunctie: 'kantoor', industriefunctie: 'industrie',
  bijeenkomstfunctie: 'bijeenkomst', onderwijsfunctie: 'onderwijs', gezondheidszorgfunctie: 'zorg',
  logiesfunctie: 'logies', sportfunctie: 'sport'
};

const BUILDING_THEMES = {
  bouwjaar: {
    classes: [...YEAR_CLASSES.map((c, i) => ({ key: `y${i}`, label: c.label, color: c.color })),
      { key: 'onbekend', label: 'onbekend', color: UNKNOWN_YEAR_COLOR }],
    expr: ['step', ['to-number', ['get', 'bouwjaar'], 0], 'onbekend', ...YEAR_CLASSES.flatMap((c, i) => [c.from, `y${i}`])],
    classify: p => {
      const y = Number(p.bouwjaar) || 0;
      let key = 'onbekend';
      YEAR_CLASSES.forEach((c, i) => { if (y >= c.from) key = `y${i}`; });
      return key;
    }
  },
  status: {
    classes: [
      { key: 'gebruik', label: 'In gebruik', color: '#4daf4a' },
      { key: 'bouw', label: 'Vergund of in aanbouw', color: '#377eb8' },
      { key: 'verbouwing', label: 'Verbouwing', color: '#ff7f00' },
      { key: 'buiten', label: 'Buiten gebruik', color: '#984ea3' },
      { key: 'sloop', label: 'Sloopvergunning of gesloopt', color: '#e41a1c' },
      { key: 'overig', label: 'Overig', color: '#9e9e9e' }
    ],
    expr: ['match', ['coalesce', ['get', 'status'], ''],
      ...Object.entries(STATUS_GROUPS).flatMap(([key, values]) => [values, key]), 'overig'],
    classify: p => Object.keys(STATUS_GROUPS).find(k => STATUS_GROUPS[k].includes(p.status)) ?? 'overig'
  },
  // Roof-level theme: colours each roof plane of the detailed buildings in 3D
  // by its suitability for solar panels; other buildings stay neutral.
  zon: {
    roofLevel: true,
    classes: [...SOLAR_CLASSES, { key: 'geen', label: 'Geen dakdata (verder dan 60 m)', color: '#dee2e6' }],
    expr: 'geen',
    classify: () => 'geen'
  },
  functie: {
    classes: [
      { key: 'woon', label: 'Wonen', color: '#f2b134' },
      { key: 'woon+', label: 'Wonen + andere functie', color: '#f7d488' },
      { key: 'winkel', label: 'Winkel', color: '#e15759' },
      { key: 'kantoor', label: 'Kantoor', color: '#4e79a7' },
      { key: 'industrie', label: 'Industrie', color: '#9c755f' },
      { key: 'bijeenkomst', label: 'Bijeenkomst', color: '#b07aa1' },
      { key: 'onderwijs', label: 'Onderwijs', color: '#59a14f' },
      { key: 'zorg', label: 'Gezondheidszorg', color: '#ff9da7' },
      { key: 'logies', label: 'Logies', color: '#76b7b2' },
      { key: 'sport', label: 'Sport', color: '#8cd17d' },
      { key: 'gemengd', label: 'Gemengd, zonder wonen', color: '#d37295' },
      { key: 'overig', label: 'Overig', color: '#bab0ac' },
      { key: 'geen', label: 'Geen (bijgebouw)', color: '#dcdcdc' }
    ],
    // A pand's gebruiksdoel lists the uses of its units, comma-separated.
    expr: ['let', 'd', ['coalesce', ['get', 'gebruiksdoel'], ''],
      ['case',
        ['==', ['var', 'd'], ''], 'geen',
        ['in', ',', ['var', 'd']], ['case', ['in', 'woonfunctie', ['var', 'd']], 'woon+', 'gemengd'],
        ['match', ['var', 'd'], ...Object.entries(FUNCTION_KEYS).flat(), 'overig']]],
    classify: p => {
      const d = p.gebruiksdoel || '';
      if (!d) return 'geen';
      if (d.includes(',')) return d.includes('woonfunctie') ? 'woon+' : 'gemengd';
      return FUNCTION_KEYS[d] ?? 'overig';
    }
  }
};

let colorBy = 'bouwjaar';
const hiddenClasses = Object.fromEntries(Object.keys(BUILDING_THEMES).map(k => [k, new Set()]));
let cartoon = false;
const isDark = () => document.documentElement.dataset.theme === 'dark';

// Mixes two #rrggbb colours; t is the share of `b`.
function mixColor(a, b, t) {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function themeColor(theme) {
  const t = BUILDING_THEMES[theme];
  return ['match', t.expr, ...t.classes.flatMap(c => [c.key, c.color]), '#cccccc'];
}

function themeClassColor(theme, props) {
  const t = BUILDING_THEMES[theme];
  const key = t.classify(props);
  return t.classes.find(c => c.key === key)?.color ?? '#cccccc';
}

function themeFilter(theme) {
  const hidden = [...hiddenClasses[theme]];
  return hidden.length ? ['!', ['in', BUILDING_THEMES[theme].expr, ['literal', hidden]]] : null;
}

function renderLegend() {
  const t = BUILDING_THEMES[colorBy];
  $('legend-items').replaceChildren(...(t ? t.classes : []).map(c => {
    const off = hiddenClasses[colorBy].has(c.key);
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'checkbox');
    li.setAttribute('aria-checked', !off);
    li.classList.toggle('off', off);
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = c.color;
    li.append(sw, c.label);
    if (t.roofLevel) {
      li.removeAttribute('role');
      li.removeAttribute('tabindex');
      li.style.cursor = 'default';
      return li;
    }
    const toggle = () => {
      const set = hiddenClasses[colorBy];
      set.has(c.key) ? set.delete(c.key) : set.add(c.key);
      renderLegend();
      applyBuildingStyle();
    };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    return li;
  }));
  $('legend-filter-hint').hidden = !t;
  $('legend-filter-hint').textContent = t?.roofLevel
    ? 'Kleurt de dakvlakken binnen 60 m van het adres in 3D, naar oriëntatie en helling.'
    : 'Klik een categorie aan of uit om panden te filteren.';
  updateLegendHint();
}

function updateLegendHint() {
  // Roof colours only exist in 3D; the legend text already says so.
  $('legend-hint').hidden = !colorBy || is3D || BUILDING_THEMES[colorBy].roofLevel || map.getZoom() >= BAG_TILE_ZOOM;
}
map.on('zoomend', updateLegendHint);

// The cartoon style has its own colours, so it can't be combined with a
// colour theme: turning cartoon on sets the theme to "Geen", turning it off
// restores the previous theme, and picking a theme turns cartoon off.
let themeBeforeCartoon = 'bouwjaar';

function updateCartoonButton() {
  if (colorBy) cartoon = false;
  $('cartoon').setAttribute('aria-pressed', cartoon);
  $('cartoon').title = cartoon ? 'Terug naar gewone 3D met kleuring' : 'Speelse cartoonstijl in 3D (zet de kleuring van panden uit)';
}

$('color-by').addEventListener('change', () => {
  colorBy = $('color-by').value;
  // Roof colours only exist in 3D.
  if (BUILDING_THEMES[colorBy]?.roofLevel) set3D(true);
  updateCartoonButton();
  renderLegend();
  applyBuildingStyle();
});

function toggleCartoon() {
  cartoon = !cartoon;
  if (cartoon) {
    themeBeforeCartoon = colorBy || themeBeforeCartoon;
    colorBy = '';
  } else if (!colorBy) {
    colorBy = themeBeforeCartoon;
  }
  $('color-by').value = colorBy;
  updateCartoonButton();
  renderLegend();
  applyBuildingStyle();
}

$('cartoon').addEventListener('click', () => {
  if (!is3D) {
    set3D(true);
    if (!cartoon) toggleCartoon();
  } else {
    toggleCartoon();
  }
});

const neutralBuildingColor = () => isDark() ? '#8a93a6' : '#d5d9e0';

async function applyBuildingStyle() {
  await mapReady;
  const selected = ['in', ['get', 'identificatie'], ['literal', highlightIds]];
  const fill = colorBy ? themeColor(colorBy) : neutralBuildingColor();
  const filter = colorBy ? themeFilter(colorBy) : null;
  map.setPaintProperty('panden-fill', 'fill-color', fill);
  map.setFilter('panden-fill', filter);
  map.setLayoutProperty('panden-fill', 'visibility', colorBy && !is3D && !BUILDING_THEMES[colorBy].roofLevel ? 'visible' : 'none');
  // Buildings with a detailed (LoD 2.2) model are drawn by three.js instead.
  const detailIds = [...detailById.keys()];
  const filters3d = [filter, detailIds.length && ['!', ['in', ['get', 'identificatie'], ['literal', detailIds]]]].filter(Boolean);
  map.setPaintProperty('pand-3d', 'fill-extrusion-color', ['case', selected, '#1a5fb4', fill]);
  map.setFilter('pand-3d', filters3d.length > 1 ? ['all', ...filters3d] : filters3d[0] ?? null);
  map.setLayoutProperty('pand-3d', 'visibility', is3D && !cartoon ? 'visible' : 'none');
  applyMapLight();
  setThreeVisible(is3D);
}

renderLegend();
updateCartoonButton();

// ---------- three.js layer: cartoon, detailed roofs, sun and shadow ----------

// MapLibre can only extrude flat blocks and can't cast shadows, so one
// three.js custom layer draws: the cartoon style, the real roof shapes of
// buildings near the address (3D BAG LoD 2.2) and, with the sun on, the
// shadows of all buildings on the ground.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
let THREE = null;
let sceneFeatures = [];
let sceneVersion = 0;
// Detailed buildings near the address, by pand id: { ground, surfaces } in RD + NAP.
let detailById = new Map();
const three = { scene: null, origin: null, s: 1, key: '', sunLight: null, ambient: null, plane: null, shadowDirty: true };

const TOON_WALLS = ['#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff', '#ffadad'];
const TOON_ROOFS = ['#e07a5f', '#3d405b', '#81b29a', '#c06c84', '#6c5b7b', '#355c7d'];

// Stable per-building colour choice (FNV-1a hash of the pand id).
function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Local metres around the address: x east, y north, z up.
function localFrame() {
  const origin = maplibregl.MercatorCoordinate.fromLngLat([current.lon, current.lat], 0);
  const s = origin.meterInMercatorCoordinateUnits();
  const fromLngLat = ([lng, lat]) => {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    return [(m.x - origin.x) / s, -(m.y - origin.y) / s];
  };
  return { origin, s, fromLngLat, fromRd: (x, y) => fromLngLat(rdToWgs84(x, y)) };
}

// Collects flat-shaded triangles with per-vertex colours. Each triangle is
// wound counter-clockwise around its normal, so lighting faces the right way.
class MeshBuilder {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.ids = []; }
  // `id` (the pand id) is kept per triangle, so a hover hit can be traced back.
  tri(a, b, c, n, rgb, id) {
    this.ids.push(id);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    if ((uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(rgb.r, rgb.g, rgb.b);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

const signedArea = r => r.reduce((a, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return a + x * y2 - x2 * y; }, 0) / 2;

// A flat-roofed LoD 1.3 block: walls, a roof-coloured trim band (cartoon) and
// the roof. Outlines go into `lines` when given.
function addFlatBuilding(mb, lines, f, frame, wall, roof, trimBand) {
  const h = f.properties.hoogte, id = f.properties.identificatie;
  const trim = trimBand ? Math.min(0.8, h * 0.08) : 0;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const rings = poly.map((ring, ri) => {
      const r = ring.map(frame.fromLngLat);
      if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
      // Outer rings counter-clockwise, holes clockwise, so (dy, -dx) points out of the walls.
      if ((ri === 0) !== (signedArea(r) > 0)) r.reverse();
      return r;
    }).filter(r => r.length >= 3);
    if (!rings.length) continue;
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const [px, py] = r[(i - 1 + r.length) % r.length], [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const n = [(by - ay) / len, -(bx - ax) / len, 0];
        for (const [z0, z1, c] of [[0, h - trim, wall], [h - trim, h, roof]]) {
          if (z1 <= z0) continue;
          mb.tri([ax, ay, z0], [bx, by, z0], [bx, by, z1], n, c, id);
          mb.tri([ax, ay, z0], [bx, by, z1], [ax, ay, z1], n, c, id);
        }
        if (lines) {
          lines.push(ax, ay, h, bx, by, h, ax, ay, 0.05, bx, by, 0.05);
          // Vertical outline only at real corners, not along curved walls.
          const v1x = ax - px, v1y = ay - py, v2x = bx - ax, v2y = by - ay;
          const cos = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
          if (cos < 0.9) lines.push(ax, ay, 0, ax, ay, h);
        }
      }
    }
    const flat = rings.flat();
    const faces = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)),
      rings.slice(1).map(r => r.map(([x, y]) => new THREE.Vector2(x, y))));
    for (const [a, b, c] of faces) mb.tri([...flat[a], h], [...flat[b], h], [...flat[c], h], [0, 0, 1], roof, id);
  }
}

// A LoD 2.2 building: every wall and roof surface is a planar polygon in 3D.
// Its normal (Newell's method) picks the plane to triangulate in. `roof` is a
// colour, or a function of the surface for per-plane colours.
function addDetailedBuilding(mb, b, frame, wall, roof, id) {
  for (const surf of b.surfaces) {
    if (surf.type === 'GroundSurface') continue;
    const rings = surf.rings.map(r => r.map(([x, y, z]) => [...frame.fromRd(x, y), z - b.ground]));
    const r0 = rings[0];
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < r0.length; i++) {
      const [x1, y1, z1] = r0[i], [x2, y2, z2] = r0[(i + 1) % r0.length];
      nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
    }
    const len = Math.hypot(nx, ny, nz);
    if (!len || r0.length < 3) continue;
    const n = [nx / len, ny / len, nz / len];
    const drop = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const to2 = p => drop === 0 ? new THREE.Vector2(p[1], p[2]) : drop === 1 ? new THREE.Vector2(p[0], p[2]) : new THREE.Vector2(p[0], p[1]);
    const flat = rings.flat();
    const faces = THREE.ShapeUtils.triangulateShape(r0.map(to2), rings.slice(1).map(r => r.map(to2)));
    const color = surf.type !== 'RoofSurface' ? wall : typeof roof === 'function' ? roof(surf) : roof;
    for (const [a, b2, c] of faces) mb.tri(flat[a], flat[b2], flat[c], n, color, id);
  }
}

// Parses one page of 3D BAG CityJSON features into LoD 2.2 surfaces.
function parseLod22(page) {
  const { scale, translate } = page.metadata.transform;
  const out = [];
  for (const f of page.features) {
    const V = f.vertices.map(([i, j, k]) => [i * scale[0] + translate[0], j * scale[1] + translate[1], k * scale[2] + translate[2]]);
    for (const [key, obj] of Object.entries(f.CityObjects)) {
      if (obj.type !== 'Building') continue;
      const surfaces = [];
      for (const childId of obj.children || []) {
        const geom = f.CityObjects[childId]?.geometry?.find(g => g.lod === '2.2');
        if (!geom) continue;
        const types = geom.semantics?.surfaces || [];
        geom.boundaries.forEach((shell, si) => shell.forEach((surface, fi) => {
          const sem = geom.semantics?.values?.[si]?.[fi];
          const attrs = types[sem] || {};
          // Polygons sharing a semantic object form one roof plane.
          surfaces.push({ type: attrs.type || 'WallSurface', plane: `${childId}:${sem}`, attrs, rings: surface.map(ring => ring.map(i => V[i])) });
        }));
      }
      if (surfaces.length) out.push([key.replace('NL.IMBAG.Pand.', ''), { ground: obj.attributes?.b3_h_maaiveld ?? 0, surfaces }]);
    }
  }
  return out;
}

// Detailed models are heavy, so only within DETAIL_RADIUS of the address.
async function loadDetail(ctx) {
  const r = DETAIL_RADIUS;
  let url = `${BAG3D}?limit=100&bbox=${[ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r].map(Math.round).join(',')}`;
  const byId = new Map();
  for (let i = 0; url && i < 4; i++) {
    const page = await getJSON(url);
    for (const [id, b] of parseLod22(page)) byId.set(id, b);
    url = page.links?.find(l => l.rel === 'next')?.href;
  }
  return byId;
}

function buildThreeScene() {
  if (!current || !THREE) return;
  const dark = isDark();
  const hidden = colorBy ? hiddenClasses[colorBy] : null;
  const key = [sceneVersion, trees.version, trees.on, highlightIds.join(','), dark, cartoon, colorBy, hidden ? [...hidden].join(',') : '', sun.on].join('|');
  if (key === three.key) return;
  three.key = key;

  const frame = localFrame();
  const visible = p => !(hidden && hidden.has(BUILDING_THEMES[colorBy].classify(p)));
  const colors = (id, p) => {
    const sel = highlightIds.includes(id);
    if (cartoon) {
      const k = hashId(id);
      return [sel ? '#ffd23f' : TOON_WALLS[k % TOON_WALLS.length], sel ? '#e05a2b' : TOON_ROOFS[(k >>> 8) % TOON_ROOFS.length]];
    }
    const base = sel ? '#1a5fb4' : colorBy ? themeClassColor(colorBy, p) : neutralBuildingColor();
    return [base, mixColor(base, '#000000', 0.18)];
  };
  // Color.setStyle converts the sRGB hex to the linear values three expects.
  const toColor = hex => new THREE.Color().setStyle(hex);

  // Flat blocks are drawn here in cartoon mode; otherwise MapLibre draws them
  // and here they only cast (invisible) shadows when the sun is on.
  const flat = new MeshBuilder(), flatLines = [], detail = new MeshBuilder();
  if (cartoon || sun.on) {
    for (const f of sceneFeatures) {
      const id = f.properties.identificatie;
      if (detailById.has(id) || !visible(f.properties)) continue;
      const [w, r] = colors(id, f.properties);
      addFlatBuilding(flat, cartoon ? flatLines : null, f, frame, toColor(w), toColor(r), cartoon);
    }
  }
  const propsById = new Map(sceneFeatures.map(f => [f.properties.identificatie, f.properties]));
  const roofSolar = colorBy === 'zon';
  for (const [id, b] of detailById) {
    const p = propsById.get(id) || {};
    if (!visible(p)) continue;
    const [w, r] = colors(id, p);
    // With the solar theme each roof plane gets its suitability colour.
    const roof = roofSolar
      ? surf => toColor(SOLAR_CLASSES.find(c => c.key === solarClass(roofFactor(surf))).color)
      : toColor(r);
    addDetailedBuilding(detail, b, frame, toColor(roofSolar ? neutralBuildingColor() : w), roof, id);
  }

  const scene = new THREE.Scene();
  const gradient = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  // Faces are pushed back a little so outlines on their edges stay visible.
  const material = () => cartoon
    ? new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const lineMaterial = new THREE.LineBasicMaterial({ color: dark ? 0x000000 : 0x1b1b2f });
  const pickables = [];
  if (flat.pos.length) {
    const mesh = new THREE.Mesh(flat.geometry(), cartoon ? material() : new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    // Invisible shadow casters aren't hoverable; MapLibre draws those blocks.
    if (cartoon) {
      mesh.userData.faceIds = flat.ids;
      pickables.push(mesh);
    }
    mesh.castShadow = sun.on;
    mesh.receiveShadow = sun.on && cartoon;
    scene.add(mesh);
  }
  if (flatLines.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(flatLines, 3));
    scene.add(new THREE.LineSegments(g, lineMaterial));
  }
  if (detail.pos.length) {
    const mesh = new THREE.Mesh(detail.geometry(), material());
    mesh.userData.faceIds = detail.ids;
    pickables.push(mesh);
    mesh.castShadow = mesh.receiveShadow = sun.on;
    scene.add(mesh);
    if (cartoon) scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), lineMaterial));
  }

  pickables.push(...addTrees(scene, frame, sun.on));
  const windows = sun.on ? addWindows(scene, frame) : null;

  const ambient = new THREE.AmbientLight(0xffffff, 1.6);
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  const extent = SCENE_RADIUS + 80;
  Object.assign(sunLight.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 3000 });
  sunLight.shadow.mapSize.set(4096, 4096);
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.3;
  scene.add(ambient, sunLight, sunLight.target);
  let plane = null;
  if (sun.on) {
    plane = new THREE.Mesh(new THREE.PlaneGeometry(2 * extent, 2 * extent),
      new THREE.ShadowMaterial({ opacity: dark ? 0.5 : 0.3, depthWrite: false }));
    plane.position.z = 0.03;
    plane.receiveShadow = true;
    scene.add(plane);
  }

  // The rain and water groups outlive scene rebuilds, so move them over before disposing.
  moveRain3D(three.scene, scene);
  moveWater3D(three.scene, scene);
  three.scene?.traverse(o => { o.geometry?.dispose(); o.material?.gradientMap?.dispose(); o.material?.dispose(); });
  Object.assign(three, { scene, origin: frame.origin, s: frame.s, sunLight, ambient, plane, pickables, propsById, windows });
  updateSunLight();
}

function threeLayer() {
  let renderer, camera;
  return {
    id: 'three-3d', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      camera = new THREE.Camera();
      // MapLibre may leave image flipping on; three.js's setup uploads
      // textures that don't allow it.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.shadowMap.enabled = true;
      // The 3D water is clipped at ground level when a flood drops.
      renderer.localClippingEnabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // Shadows only change with the sun or the buildings, not with the camera.
      renderer.shadowMap.autoUpdate = false;
    },
    render(gl, matrix) {
      if (!three.scene) return;
      // Local metres → Mercator units (y flips: Mercator y grows southward).
      const local = new THREE.Matrix4().makeTranslation(three.origin.x, three.origin.y, three.origin.z)
        .scale(new THREE.Vector3(three.s, -three.s, three.s));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(local);
      three.matrix = camera.projectionMatrix;
      renderer.resetState();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      if (three.shadowDirty) {
        renderer.shadowMap.needsUpdate = true;
        three.shadowDirty = false;
      }
      renderer.render(three.scene, camera);
    }
  };
}

async function setThreeVisible(on) {
  await mapReady;
  if (!on) {
    if (map.getLayer('three-3d')) map.removeLayer('three-3d');
    return;
  }
  try {
    THREE ??= await import(THREE_URL);
  } catch (err) {
    console.error(err);
    setStatus(`3D-details konden niet laden: ${err.message}`, true);
    return;
  }
  if (!is3D) return;
  buildThreeScene();
  if (!map.getLayer('three-3d')) map.addLayer(threeLayer());
  buildWater3D();
  updateWater3D();
  map.triggerRepaint();
}

// What's under the mouse in the three.js scene: a ray from the camera through
// the pointer, intersected with the buildings and trees drawn here.
let raycaster = null;
function pick3D(point) {
  if (!THREE || !three.scene || !three.matrix || !three.pickables?.length) return null;
  const canvas = map.getCanvas();
  const x = (point.x / canvas.clientWidth) * 2 - 1, y = -(point.y / canvas.clientHeight) * 2 + 1;
  const inv = three.matrix.clone().invert();
  const near = new THREE.Vector4(x, y, -1, 1).applyMatrix4(inv);
  const far = new THREE.Vector4(x, y, 1, 1).applyMatrix4(inv);
  const a = new THREE.Vector3(near.x / near.w, near.y / near.w, near.z / near.w);
  const b = new THREE.Vector3(far.x / far.w, far.y / far.w, far.z / far.w);
  raycaster ??= new THREE.Raycaster();
  raycaster.set(a, b.sub(a).normalize());
  const hit = raycaster.intersectObjects(three.pickables, false)[0];
  if (!hit) return null;
  if (hit.object.userData.tree) {
    const t = trees.list[hit.instanceId];
    return t && { text: treeText(t) };
  }
  const id = hit.object.userData.faceIds?.[hit.faceIndex];
  const p = three.propsById?.get(id);
  return p && { text: buildingText(p) };
}

// ---------- Night: lit windows ----------

// Windows on the walls of the buildings near the address: one per 3 m of wall
// per 3 m storey. After sunset more and more of them light up.
const NIGHT_RADIUS = 150, MAX_WINDOWS = 40000;
const WINDOW_LIT = '#ffd27a', WINDOW_DARK = '#1e2533';

function addWindows(scene, frame) {
  const placements = [];
  const m = new THREE.Matrix4(), along = new THREE.Vector3(), up = new THREE.Vector3(0, 0, 1), out = new THREE.Vector3();
  for (const f of sceneFeatures) {
    const h = f.properties.hoogte;
    const floors = Math.floor((h - 0.5) / 3);
    if (!f.properties.hoogteBekend || floors < 1) continue;
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    const r = ring.map(frame.fromLngLat);
    if (Math.hypot(r[0][0], r[0][1]) > NIGHT_RADIUS) continue;
    if (signedArea(r) < 0) r.reverse();
    for (let i = 0; i + 1 < r.length && placements.length < MAX_WINDOWS; i++) {
      const [ax, ay] = r[i], [bx, by] = r[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.floor(len / 3);
      if (n < 1) continue;
      along.set((bx - ax) / len, (by - ay) / len, 0);
      out.set(along.y, -along.x, 0);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        for (let fl = 0; fl < floors; fl++) {
          // Slightly in front of the wall so the window isn't hidden inside it.
          m.makeBasis(along, up, out).scale(new THREE.Vector3(1.2, 1.4, 1))
            .setPosition(ax + (bx - ax) * t + out.x * 0.06, ay + (by - ay) * t + out.y * 0.06, 1.7 + fl * 3);
          placements.push(m.clone());
        }
      }
    }
  }
  if (!placements.length) return null;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), placements.length);
  placements.forEach((p, i) => mesh.setMatrixAt(i, p));
  // A fixed random threshold per window decides when its light goes on.
  const threshold = Float32Array.from(placements, () => Math.random());
  for (let i = 0; i < placements.length; i++) mesh.setColorAt(i, new THREE.Color(WINDOW_DARK));
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, threshold, lit: -1 };
}

function updateWindows(night) {
  const w = three.windows;
  if (!w) return;
  w.mesh.visible = night > 0;
  // Up to ~55% of windows lit in full darkness.
  const share = Math.round(0.55 * night * 100) / 100;
  if (share === w.lit) return;
  w.lit = share;
  const lit = new THREE.Color(WINDOW_LIT), dark = new THREE.Color(WINDOW_DARK);
  for (let i = 0; i < w.threshold.length; i++) w.mesh.setColorAt(i, w.threshold[i] < share ? lit : dark);
  w.mesh.instanceColor.needsUpdate = true;
}

// ---------- Sun and shadow ----------

const sun = { on: false };

// Sun position (after SunCalc, V. Agafonkin): altitude above the horizon and
// azimuth clockwise from north, both in radians.
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.valueOf() / 864e5 - 0.5 + 2440588 - 2451545;
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const e = rad * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = rad * lat;
  const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const fromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { altitude, azimuth: (fromSouth + 3 * Math.PI) % (2 * Math.PI) };
}

// The date and time in the panel, in the browser's time zone.
function sunDate(minutes = Number($('sun-time').value)) {
  const [y, m, d] = $('sun-date').value.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

const fmtClock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const COMPASS = ['noorden', 'noordoosten', 'oosten', 'zuidoosten', 'zuiden', 'zuidwesten', 'westen', 'noordwesten'];

// Sunrise and sunset (minutes after midnight) by scanning the day; the sun's
// centre is at -0.833° when its upper edge touches the horizon.
function sunTimes() {
  const limit = -0.833 * Math.PI / 180;
  let rise = null, set = null, prev = null;
  for (let t = 0; t <= 1440; t += 5) {
    const up = sunPosition(sunDate(t), current.lat, current.lon).altitude > limit;
    if (prev !== null && up && !prev) rise = t;
    if (prev !== null && !up && prev) set = t;
    prev = up;
  }
  return { rise, set };
}

function currentSun() {
  return current ? sunPosition(sunDate(), current.lat, current.lon) : null;
}

// 0 by day, 1 at night: from sunset until the sun is 6° below the horizon
// (end of civil twilight).
function nightFactor() {
  const pos = sun.on ? currentSun() : null;
  return pos ? Math.min(1, Math.max(0, -pos.altitude * 180 / Math.PI / 6)) : 0;
}

function updateSunLight() {
  if (!three.scene) return;
  const pos = sun.on ? currentSun() : null;
  updateWindows(nightFactor());
  if (pos) {
    const up = pos.altitude > 0;
    const c = Math.cos(pos.altitude);
    three.sunLight.position.set(Math.sin(pos.azimuth) * c * 1000, Math.cos(pos.azimuth) * c * 1000, Math.sin(pos.altitude) * 1000);
    three.sunLight.intensity = up ? 0.8 + 2 * Math.min(1, Math.sin(pos.altitude) * 2) : 0;
    three.sunLight.castShadow = up;
    three.ambient.intensity = up ? 1.1 : 0.5 - 0.25 * nightFactor();
    if (three.plane) three.plane.visible = up;
  } else {
    three.sunLight.position.set(-600, -1000, 1800);
    three.sunLight.intensity = 2.2;
    three.sunLight.castShadow = false;
    three.ambient.intensity = 1.6;
  }
  three.shadowDirty = true;
  map.triggerRepaint();
}

// MapLibre lights its own 3D blocks: from the sun when it's on.
function applyMapLight() {
  const pos = sun.on ? currentSun() : null;
  const dark = isDark();
  if (pos) {
    const altDeg = pos.altitude * 180 / Math.PI;
    map.setLight({ anchor: 'map', color: '#ffffff', position: [1.5, pos.azimuth * 180 / Math.PI, Math.min(90, Math.max(0, 90 - altDeg))],
      intensity: altDeg > 0 ? 0.55 : 0.15 });
  } else {
    map.setLight({ anchor: 'viewport', color: '#ffffff', position: [1.5, 210, 30], intensity: dark ? 0.35 : 0.5 });
  }
}

function updateSun() {
  applyMapTheme();
  const minutes = Number($('sun-time').value);
  $('sun-clock').textContent = fmtClock(minutes);
  if (current) {
    const pos = currentSun();
    const { rise, set } = sunTimes();
    const times = rise != null && set != null ? ` · op ${fmtClock(rise)}, onder ${fmtClock(set)}` : '';
    const season = ` · bomen: ${TREE_SEASONS[treeSeason()].label}`;
    $('sun-info').textContent = (pos.altitude > 0
      ? `Zon ${nf.format(Math.round(pos.altitude * 180 / Math.PI))}° hoog, uit het ${COMPASS[Math.round(pos.azimuth / (Math.PI / 4)) % 8]}${times}`
      : `De zon is onder${times}`) + season;
  }
  updateSunLight();
  applyMapLight();
}

function updateSunPanel() {
  $('sun').hidden = !(is3D && sun.on);
}

function toggleSun() {
  sun.on = !sun.on;
  if (!sun.on) hideSunHours();
  $('sun-toggle').setAttribute('aria-pressed', sun.on);
  updateSunPanel();
  buildThreeScene();
  updateSun();
}

$('sun-toggle').addEventListener('click', () => {
  if (!is3D) {
    set3D(true);
    if (!sun.on) toggleSun();
  } else {
    toggleSun();
  }
});
$('sun-date').addEventListener('input', () => {
  updateSun();
  updateTreeSeason();
});
$('sun-time').addEventListener('input', updateSun);

let sunFrame = 0;
$('sun-play').addEventListener('click', () => {
  if (sunFrame) { cancelAnimationFrame(sunFrame); sunFrame = 0; $('sun-play').textContent = '▶'; return; }
  if (!current) return;
  // Sweep from sunrise to sunset in about twelve seconds.
  const { rise, set } = sunTimes();
  const from = rise ?? 0, to = set ?? 1435;
  const t0 = performance.now();
  $('sun-play').textContent = '❚❚';
  const step = now => {
    const t = Math.min(1, (now - t0) / 12000);
    $('sun-time').value = Math.round((from + (to - from) * t) / 5) * 5;
    updateSun();
    if (t < 1) sunFrame = requestAnimationFrame(step);
    else { sunFrame = 0; $('sun-play').textContent = '▶'; }
  };
  sunFrame = requestAnimationFrame(step);
});

// Start at today and the current time, rounded to five minutes.
(() => {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  $('sun-date').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $('sun-time').value = Math.round((now.getHours() * 60 + now.getMinutes()) / 5) * 5 % 1440;
  $('sun-clock').textContent = fmtClock(Number($('sun-time').value));
})();

const THEME_KEY = 'adresrapport.theme';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function savedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  if (save) try { localStorage.setItem(THEME_KEY, theme); } catch {}
  $('theme').textContent = theme === 'dark' ? '☀' : '☾';
  $('theme').setAttribute('aria-label', theme === 'dark' ? 'Lichte modus' : 'Donkere modus');
  applyMapTheme();
}

// PDOK has no dark basemap, so invert its brightness, turn the hues back
// (water stays blue) and mute the colours.
async function applyMapTheme() {
  await mapReady;
  const dark = isDark();
  // With the sun on, night dims the map (and aerial photo) as well.
  const dim = 1 - 0.65 * nightFactor();
  map.setPaintProperty('brt', 'raster-brightness-min', dark ? 0.85 * dim : 0);
  map.setPaintProperty('brt', 'raster-brightness-max', dark ? 0.08 : dim);
  map.setPaintProperty('brt', 'raster-hue-rotate', dark ? 180 : 0);
  map.setPaintProperty('brt', 'raster-saturation', dark ? -0.4 : -0.5 * (1 - dim));
  map.setPaintProperty('luchtfoto', 'raster-brightness-max', (dark ? 0.8 : 1) * dim);
  map.setPaintProperty('buurt-line', 'line-color', dark ? '#b39ddb' : '#6a3d9a');
  applyBuildingStyle();
}

$('theme').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark', true));
systemDark.addEventListener('change', e => { if (!savedTheme()) setTheme(e.matches ? 'dark' : 'light', false); });
setTheme(document.documentElement.dataset.theme, false);

// 3D BAG heights are metres above NAP; we want height above ground level.
function heightsFrom3DBag(cityObjects) {
  const out = {};
  for (const [key, obj] of Object.entries(cityObjects)) {
    const a = obj.attributes;
    if (obj.type !== 'Building' || !a) continue;
    out[key.replace('NL.IMBAG.Pand.', '')] = a;
  }
  return out;
}

const heightAboveGround = a => a.b3_h_dak_70p - a.b3_h_maaiveld;

async function loadScene() {
  if (!current || sceneFor === current) return;
  const ctx = current;
  sceneFor = ctx;
  try {
    const r = SCENE_RADIUS;
    const bbox = [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r].map(Math.round).join(',');
    const dLon = r / (111320 * Math.cos(ctx.lat * Math.PI / 180)), dLat = r / 110574;
    // 3D BAG has heights but no gebruiksdoel, so join that (and the current
    // status) from BAG on the pand id.
    const [data, bag, detail] = await Promise.all([
      getJSON(`${BAG3D_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAG3D:lod13` +
        `&outputFormat=application/json&srsName=EPSG:4326&count=20000&bbox=${bbox},EPSG:28992` +
        `&propertyName=identificatie,oorspronkelijkbouwjaar,status,b3_h_70p,b3_h_maaiveld,geom`),
      track(fetchAllFeatures(`${BAG}/collections/pand/items?f=json&limit=1000&bbox=${[ctx.lon - dLon, ctx.lat - dLat, ctx.lon + dLon, ctx.lat + dLat].join(',')}`))
        .catch(() => []),
      loadDetail(ctx).catch(err => { console.error(err); return new Map(); })
    ]);
    if (current !== ctx) return;
    const bagById = new Map(bag.map(f => [f.properties.identificatie, f.properties]));
    const features = data.features.map(f => {
      const p = f.properties;
      const id = p.identificatie.replace('NL.IMBAG.Pand.', '');
      const b = bagById.get(id);
      const h = p.b3_h_70p - p.b3_h_maaiveld;
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          identificatie: id,
          bouwjaar: p.oorspronkelijkbouwjaar,
          status: b?.status ?? p.status,
          gebruiksdoel: b?.gebruiksdoel ?? null,
          // Parts without a usable height get a nominal 3 m so they stay visible.
          hoogte: h > 0 ? h : 3,
          hoogteBekend: h > 0
        }
      };
    });
    await setLayerData('scene3d', features);
    sceneFeatures = features;
    detailById = detail;
    sceneVersion++;
    if (sun.on) updateSun();
    applyBuildingStyle();
  } catch (err) {
    console.error(err);
    sceneFor = null;
    setStatus(`3D-weergave niet beschikbaar: ${err.message}`, true);
  }
}
