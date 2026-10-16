// Living water in 3D: small moving waves and glints of sunlight on the
// canals and ditches around the address (BGT waterdeel) and on the simulated
// flood water. One shared material does the waves; while it's in view the
// map keeps redrawing. On Snel, or when the system asks for less motion, the
// water lies still.
// Loaded as a classic script; see index.html for the load order.

const BGT_WATER = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/waterdeel/items';
const CANAL_RADIUS = 500;
const canals = { list: [], version: 0 };
// Shared by every water material: the clock and how much sun glints off it.
const waterUniforms = { uTime: { value: 0 }, uGlint: { value: 1 } };

// A Lambert material with waves on its upward faces: drifting light and dark
// patches and, in daylight, glints on the highest crests.
function livingWaterMaterial(params) {
  const material = new THREE.MeshLambertMaterial(params);
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, waterUniforms);
    shader.vertexShader = 'varying vec3 vWaterPos;\nvarying float vWaterUp;\n' + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vWaterPos = (modelMatrix * vec4(position, 1.0)).xyz;\n  vWaterUp = normal.z;');
    shader.fragmentShader = `uniform float uTime;
uniform float uGlint;
varying vec3 vWaterPos;
varying float vWaterUp;
float waterHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float waterNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(waterHash(i), waterHash(i + vec2(1.0, 0.0)), u.x),
             mix(waterHash(i + vec2(0.0, 1.0)), waterHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Three layers of drifting noise in different directions, from swells of
// several metres (visible from afar) to small ripples: 0 in troughs, 1 on crests.
float waterWaves(vec2 p, float t) {
  return 0.45 * waterNoise(p * 0.18 + vec2(t * 0.25, t * 0.1))
       + 0.3 * waterNoise(p * 0.5 - vec2(t * 0.15, t * 0.35))
       + 0.25 * waterNoise(p * 1.4 + vec2(t * 0.5, -t * 0.25));
}
` + shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if (vWaterUp > 0.5) {
    float w = waterWaves(vWaterPos.xy, uTime);
    // Dark troughs, lighter crests, and a pale sheen where the light catches.
    gl_FragColor.rgb *= 0.7 + 0.55 * w;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.78, 0.9, 1.0), smoothstep(0.55, 0.75, w) * 0.35 * (0.4 + 0.6 * uGlint));
    // Bright glints on the highest crests, only with sunlight.
    float glint = smoothstep(0.66, 0.76, w) * uGlint;
    gl_FragColor.rgb += vec3(1.0, 0.97, 0.88) * glint * 0.7;
    gl_FragColor.a = min(1.0, gl_FragColor.a + glint * 0.3);
  }`);
  };
  return material;
}

// Glints follow the sun: full by day, none at night.
function updateWaterGlint() {
  const pos = timeOn() ? currentSun() : null;
  waterUniforms.uGlint.value = pos ? Math.max(0, Math.min(1, pos.altitude * 180 / Math.PI / 8)) : (isDark() ? 0.35 : 1);
}

// Called from the three.js layer every frame it draws.
function animateWater() {
  const moving = !reducedMotion.matches && !isFast() && (three.canals?.visible || water3d.group?.visible);
  if (!moving) return;
  waterUniforms.uTime.value = performance.now() / 1000;
  map.triggerRepaint();
}

async function loadCanals(ctx, stale) {
  const r = CANAL_RADIUS;
  const dLon = r / (111320 * Math.cos(ctx.lat * Math.PI / 180)), dLat = r / 110574;
  try {
    const features = await track(fetchAllFeatures(`${BGT_WATER}?f=json&limit=1000&bbox=${[ctx.lon - dLon, ctx.lat - dLat, ctx.lon + dLon, ctx.lat + dLat].join(',')}`));
    if (stale()) return;
    // Ended registrations are water that was filled in or redrawn.
    canals.list = features.filter(f => !f.properties.eind_registratie && /Polygon/.test(f.geometry?.type));
    canals.version++;
    applyBuildingStyle();
  } catch (err) {
    console.error(err);
  }
}

// Flat water surfaces just above the map's own blue.
function addCanals(scene, frame) {
  if (!canals.list.length) return null;
  const pos = [];
  for (const f of canals.list) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const rings = poly.map(ring => {
        const r = ring.map(frame.fromLngLat);
        if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
        return r;
      }).filter(r => r.length >= 3);
      if (!rings.length) continue;
      const flat = rings.flat();
      const faces = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)),
        rings.slice(1).map(r => r.map(([x, y]) => new THREE.Vector2(x, y))));
      for (const tri of faces) for (const k of tri) pos.push(flat[k][0], flat[k][1], 0.08);
    }
  }
  if (!pos.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Every face points up; set it directly, the triangles' winding varies.
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  const mesh = new THREE.Mesh(geometry, livingWaterMaterial({
    color: isDark() ? 0x24547e : 0x3f86c6, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide
  }));
  mesh.frustumCulled = false;
  mesh.receiveShadow = sun.on;
  mesh.renderOrder = 1;
  scene.add(mesh);
  return mesh;
}
