// Solar panel potential per roof plane, from the 3D BAG LoD 2.2 roof surfaces
// (tilt and orientation per plane). An indication, not a quote: shade from
// trees and neighbours and obstacles on the roof aren't included.
// Loaded as a classic script; see index.html for the load order.

const PANEL_AREA = 1.75;        // m² per panel
const PANEL_KWP = 0.42;         // kWp per panel
const YIELD_PER_KWP = 950;      // kWh per kWp per year on an ideal Dutch roof
const HOUSEHOLD_KWH = 2500;     // average household electricity use per year
const MIN_PLANE_AREA = 3;       // smaller planes can't hold a panel sensibly

// Yearly irradiation on a tilted plane relative to the best orientation
// (south, ~36°). A simple diffuse + direct model tuned to the Netherlands:
// about 55% diffuse light and a representative sun height of 40°. It gives
// south-west ≈ 0.92, east/west ≈ 0.74, flat ≈ 0.85 and north ≈ 0.48.
function solarFactor(tiltDeg, azimuthDeg) {
  const r = Math.PI / 180, h = 40 * r, diffuse = 0.55;
  const H = (T, D) => diffuse * (1 + Math.cos(T)) / 2 +
    (1 - diffuse) * Math.max(0, Math.cos(T) * Math.sin(h) + Math.sin(T) * Math.cos(h) * Math.cos(D)) / Math.sin(h);
  return H(tiltDeg * r, (azimuthDeg - 180) * r) / H(36.5 * r, 0);
}

// Flat roofs get panels on low racks, which yields about 87% of an ideal roof.
function roofFactor(surf) {
  const tilt = surf.attrs?.b3_hellingshoek ?? 0;
  if (tilt < 10) return 0.87;
  return solarFactor(tilt, surf.attrs?.b3_azimut ?? 180);
}

function solarClass(factor) {
  return SOLAR_CLASSES.find(c => factor >= c.min).key;
}

// Area of a planar 3D polygon with holes (Newell's method; metres in RD).
function polygonArea3d(rings) {
  const ringArea = r => {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < r.length; i++) {
      const [x1, y1, z1] = r[i], [x2, y2, z2] = r[(i + 1) % r.length];
      nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
    }
    return Math.hypot(nx, ny, nz) / 2;
  };
  return ringArea(rings[0]) - rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
}

// Groups a building's roof polygons into planes with area, tilt, orientation,
// suitability and a panel and yield estimate.
function roofPlanes(building) {
  const planes = new Map();
  for (const surf of building.surfaces) {
    if (surf.type !== 'RoofSurface') continue;
    const p = planes.get(surf.plane) || { area: 0, surf, tilt: surf.attrs?.b3_hellingshoek ?? 0, azimuth: surf.attrs?.b3_azimut ?? null };
    p.area += polygonArea3d(surf.rings);
    planes.set(surf.plane, p);
  }
  return [...planes.values()].map(p => {
    const factor = roofFactor(p.surf);
    const cls = solarClass(factor);
    // Usable share: edges, hatches and spacing between rows on flat roofs.
    const usable = p.tilt < 10 ? 0.5 : 0.7;
    const counts = p.area >= MIN_PLANE_AREA && (cls === 'zeer' || cls === 'goed');
    const panels = counts ? Math.floor(p.area * usable / PANEL_AREA) : 0;
    return { ...p, factor, cls, panels, kwh: panels * PANEL_KWP * YIELD_PER_KWP * factor };
  }).sort((a, b) => b.area - a.area);
}

const DIRECTIONS = ['Noord', 'Noordoost', 'Oost', 'Zuidoost', 'Zuid', 'Zuidwest', 'West', 'Noordwest'];
const planeLabel = p => p.tilt < 10 ? 'Plat' : `${DIRECTIONS[Math.round(p.azimuth / 45) % 8]}, ${nf.format(Math.round(p.tilt))}°`;

function renderSolar(building) {
  if (!building) return;
  const planes = roofPlanes(building).filter(p => p.area >= 1);
  if (!planes.length) return;
  const good = planes.filter(p => p.panels > 0);
  const panels = good.reduce((s, p) => s + p.panels, 0);
  const kwh = good.reduce((s, p) => s + p.kwh, 0);
  const goodArea = good.reduce((s, p) => s + p.area, 0);

  $('solar-headline').textContent = panels
    ? `Ongeveer ${nf.format(panels)} panelen, samen ~${nf.format(Math.round(kwh / 100) * 100)} kWh per jaar: het stroomverbruik van ~${(h => (h >= 10 ? nf.format(Math.round(h)) : nf1.format(h)))(kwh / HOUSEHOLD_KWH)} huishoudens.`
    : 'Dit dak is weinig geschikt voor zonnepanelen: de dakvlakken zijn klein of liggen ongunstig.';
  setField('r-solar-planes', `${good.length} van ${planes.length} (${nf.format(Math.round(goodArea))} m²)`);
  setField('r-solar-panels', panels ? `~${nf.format(panels)} (${nf1.format(panels * PANEL_KWP)} kWp)` : '–');
  setField('r-solar-yield', panels ? `~${nf.format(Math.round(kwh / 100) * 100)} kWh per jaar` : '–');

  // The eight largest planes; small dormers and edges add little.
  $('solar-table').tBodies[0].replaceChildren(...planes.slice(0, 8).map(p => {
    const tr = document.createElement('tr');
    const c = SOLAR_CLASSES.find(k => k.key === p.cls);
    const name = document.createElement('td');
    name.textContent = planeLabel(p);
    const area = document.createElement('td');
    area.className = 'num';
    area.textContent = nf.format(Math.round(p.area));
    const fit = document.createElement('td');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = c.color;
    fit.append(sw, ` ${c.label}`);
    tr.append(name, area, fit);
    return tr;
  }));
  $('solar-section').hidden = false;
}

$('solar-show').addEventListener('click', () => {
  $('color-by').value = 'zon';
  $('color-by').dispatchEvent(new Event('change'));
});
