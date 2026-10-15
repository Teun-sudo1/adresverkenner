// Trees from the BGT (Basisregistratie Grootschalige Topografie): green crowns
// on the flat map, trees with trunk and crown in 3D (casting shadows with the
// sun on), and a count in the report. The BGT only gives positions; height
// comes from the AHN surface model minus the ground, the crown width is
// estimated from the height.
// Loaded as a classic script; see index.html for the load order.

const BGT_TREES = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/vegetatieobject_punt/items';
const DEFAULT_TREE_HEIGHT = 6;
const trees = { on: true, list: [], version: 0, heightsFor: null, ready: Promise.resolve() };

// A wider crown for taller trees, within sensible bounds (metres).
const crownRadius = h => Math.min(7, Math.max(1.5, 0.25 * h + 0.5));

async function loadTrees(ctx, stale) {
  const r = SCENE_RADIUS;
  const dLon = r / (111320 * Math.cos(ctx.lat * Math.PI / 180)), dLat = r / 110574;
  let finish;
  trees.ready = new Promise(res => { finish = res; });
  try {
    const features = await track(fetchAllFeatures(`${BGT_TREES}?f=json&limit=1000&bbox=${[ctx.lon - dLon, ctx.lat - dLat, ctx.lon + dLon, ctx.lat + dLat].join(',')}`));
    if (stale()) return;
    // Only current trees; ended registrations are trees that were cut down.
    trees.list = features
      .filter(f => f.properties.plus_type === 'boom' && !f.properties.eind_registratie)
      .map(f => {
        const [lon, lat] = f.geometry.coordinates;
        const [x, y] = wgs84ToRd(lon, lat);
        return { id: f.properties.lokaal_id, lon, lat, x, y, h: DEFAULT_TREE_HEIGHT, measured: false };
      });
    trees.heightsFor = null;
    trees.version++;
    updateTreeLayer();
    const near = trees.list.filter(t => Math.hypot(t.x - ctx.x, t.y - ctx.y) <= 50).length;
    setField('r-bomen', `${nf.format(near)} binnen 50 m · ${nf.format(trees.list.length)} binnen ${r} m`);
  } catch (err) {
    console.error(err);
    if (!stale()) setField('r-bomen', 'niet beschikbaar');
  } finally {
    finish();
  }
}

// Height per tree: highest surface within 2 m of the trunk minus the ground.
// Young trees or gaps in the data fall back to a modest default.
async function loadTreeHeights(ctx) {
  await trees.ready;
  if (current !== ctx || trees.heightsFor === ctx || !trees.list.length) return;
  const r = SCENE_RADIUS;
  const box = [ctx.x - r, ctx.y - r, ctx.x + r, ctx.y + r].map(Math.round);
  const [dsm, dtm] = await track(Promise.all([
    fetchCoverage(AHN_WCS, 'dsm_05m', box, 'x', 'y', '&SCALEFACTOR=0.5'),
    fetchCoverage(AHN_WCS, 'dtm_05m', box, 'x', 'y', '&SCALEFACTOR=0.5')
  ]));
  if (current !== ctx) return;
  const at = (g, x, y) => {
    const i = Math.floor((x - g.x0) / g.res), j = Math.floor((g.y0 - y) / g.res);
    return i >= 0 && j >= 0 && i < g.width && j < g.height ? g.data[j * g.width + i] : NaN;
  };
  for (const t of trees.list) {
    let top = -Infinity, ground = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const s = at(dsm, t.x + dx, t.y + dy), g = at(dtm, t.x + dx, t.y + dy);
        if (s > top) top = s;
        if (g < ground) ground = g;
      }
    }
    const h = top - ground;
    t.measured = h >= 2;
    t.h = t.measured ? Math.min(35, h) : DEFAULT_TREE_HEIGHT;
  }
  trees.heightsFor = ctx;
  trees.version++;
  updateTreeLayer();
  applyBuildingStyle();
}

// Flat map: crowns as circles at their estimated width in metres.
async function updateTreeLayer() {
  await mapReady;
  setLayerData('bomen', trees.list.map(t => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    properties: { kroon: crownRadius(t.h), hoogte: t.h, gemeten: t.measured }
  })));
  map.setLayoutProperty('bomen', 'visibility', trees.on && !is3D ? 'visible' : 'none');
}

// 3D: one instanced trunk mesh and one instanced crown mesh for all trees.
// Returns the meshes, for hover picking.
function addTrees(scene, frame, castShadow) {
  if (!trees.on || !trees.list.length) return [];
  const n = trees.list.length;
  const trunkGeom = new THREE.CylinderGeometry(1, 1, 1, cartoon ? 6 : 8);
  trunkGeom.rotateX(Math.PI / 2);
  trunkGeom.translate(0, 0, 0.5);
  const crownGeom = new THREE.IcosahedronGeometry(1, cartoon ? 1 : 2);
  const gradient = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  const material = () => cartoon
    ? new THREE.MeshToonMaterial({ gradientMap: gradient })
    : new THREE.MeshLambertMaterial();
  const trunks = new THREE.InstancedMesh(trunkGeom, material(), n);
  const crowns = new THREE.InstancedMesh(crownGeom, material(), n);
  const greens = cartoon ? ['#7bc950', '#5fae3e', '#9ad65c', '#4f9a34'] : ['#4f7f3a', '#5b8c41', '#466f33', '#628f48'];
  const trunkColor = new THREE.Color().setStyle(cartoon ? '#8b5a2b' : '#6b4f3a');
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  trees.list.forEach((t, i) => {
    const [x, y] = frame.fromLngLat([t.lon, t.lat]);
    const r = crownRadius(t.h);
    const trunkH = Math.max(1, t.h - 1.6 * r);
    const trunkR = Math.min(0.45, 0.12 + 0.012 * t.h);
    trunks.setMatrixAt(i, m.compose(p.set(x, y, 0), q, s.set(trunkR, trunkR, trunkH + 0.3 * r)));
    trunks.setColorAt(i, trunkColor);
    crowns.setMatrixAt(i, m.compose(p.set(x, y, trunkH + 0.8 * r), q, s.set(r, r, r * 0.9)));
    crowns.setColorAt(i, new THREE.Color().setStyle(greens[hashId(String(t.id)) % greens.length]));
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = castShadow;
    mesh.receiveShadow = castShadow && cartoon;
    mesh.frustumCulled = false;
    mesh.userData.tree = true;
    scene.add(mesh);
  }
  return [trunks, crowns];
}

const treeText = t => `Boom · ${t.measured ? '' : '~'}${nf.format(Math.round(t.h))} m hoog`;

function setTreesVisible(on) {
  trees.on = on;
  $('trees-toggle').setAttribute('aria-pressed', on);
  updateTreeLayer();
  applyBuildingStyle();
}

$('trees-toggle').addEventListener('click', () => setTreesVisible(!trees.on));
