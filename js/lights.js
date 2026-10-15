// Street lights from the BGT (paal, type lichtmast): small dots on the flat
// map; in 3D a pole with a lamp that glows at night and throws a pool of
// light on the street. Not every municipality registers its street lights.
// Loaded as a classic script; see index.html for the load order.

const BGT_POLES = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/paal/items';
const lights = { list: [], version: 0 };
const LIGHT_HEIGHT = 6;
const LIGHT_POOL_RADIUS = 7;

async function loadLights(ctx, stale) {
  const r = SCENE_RADIUS;
  const dLon = r / (111320 * Math.cos(ctx.lat * Math.PI / 180)), dLat = r / 110574;
  try {
    const features = await track(fetchAllFeatures(`${BGT_POLES}?f=json&limit=1000&bbox=${[ctx.lon - dLon, ctx.lat - dLat, ctx.lon + dLon, ctx.lat + dLat].join(',')}`));
    if (stale()) return;
    lights.list = features
      .filter(f => f.properties.plus_type === 'lichtmast' && !f.properties.eind_registratie)
      .map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    lights.version++;
    setLayerData('lantaarns', lights.list.map(l => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: {} })));
    updateLightLayer();
    applyBuildingStyle();
  } catch (err) {
    // Street lights are atmosphere; the report doesn't depend on them.
    console.error(err);
  }
}

async function updateLightLayer() {
  await mapReady;
  map.setLayoutProperty('lantaarns', 'visibility', is3D ? 'none' : 'visible');
}

// A soft round spot, bright in the middle, for the light on the street.
let lightPoolTexture = null;
function poolTexture() {
  if (lightPoolTexture) return lightPoolTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,214,140,1)');
  grad.addColorStop(0.4, 'rgba(255,190,100,0.45)');
  grad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  lightPoolTexture = new THREE.CanvasTexture(c);
  return lightPoolTexture;
}

// 3D: poles and lamp heads, plus a glow around each lamp and a pool of light
// below it that only show at night (see updateLights).
function addLights(scene, frame) {
  if (!lights.list.length) return null;
  const n = lights.list.length;
  const poleGeom = new THREE.CylinderGeometry(0.13, 0.17, 1, 8);
  poleGeom.rotateX(Math.PI / 2);
  poleGeom.translate(0, 0, 0.5);
  const poles = new THREE.InstancedMesh(poleGeom, new THREE.MeshLambertMaterial({ color: 0x3d4045 }), n);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd9d4c0 }), n);
  const glow = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), n);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(2 * LIGHT_POOL_RADIUS, 2 * LIGHT_POOL_RADIUS),
    new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  lights.list.forEach((l, i) => {
    const [x, y] = frame.fromLngLat([l.lon, l.lat]);
    poles.setMatrixAt(i, m.compose(p.set(x, y, 0), q, s.set(1, 1, LIGHT_HEIGHT)));
    heads.setMatrixAt(i, m.compose(p.set(x, y, LIGHT_HEIGHT), q, s.set(1, 1, 1)));
    glow.setMatrixAt(i, m.compose(p.set(x, y, LIGHT_HEIGHT), q, s.set(1, 1, 1)));
    // Just above the street, below the water so a flood covers it.
    pools.setMatrixAt(i, m.compose(p.set(x, y, 0.05), q, s.set(1, 1, 1)));
  });
  for (const mesh of [poles, heads, glow, pools]) {
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  glow.renderOrder = pools.renderOrder = 2;
  return { heads, glow, pools, night: -1 };
}

function updateLights(night) {
  const l = three.lights;
  if (!l || l.night === night) return;
  l.night = night;
  l.heads.material.color.set(night > 0.3 ? 0xffd27a : 0xd9d4c0);
  l.glow.material.opacity = 0.55 * night;
  l.pools.material.opacity = 0.7 * night;
  l.glow.visible = l.pools.visible = night > 0;
}
