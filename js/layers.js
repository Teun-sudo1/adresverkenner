// Environment map layers: the same national maps as in the report's
// "Klimaat en omgeving" section, shown as a WMS overlay with its legend.
// Loaded as a classic script; see index.html for the load order.

const ENV_LAYERS = {
  geluid: { label: 'Geluid, alle bronnen (Lden)', base: ALO_WMS, layer: 'rivm_Geluid_lden_allebronnen_actueel', source: 'RIVM Atlas Leefomgeving' },
  no2: { label: 'Stikstofdioxide NO₂ (2024)', base: ALO_WMS, layer: 'rivm_nsl_20260401_gm_NO22024', source: 'RIVM Atlas Leefomgeving' },
  pm25: { label: 'Fijnstof PM2,5 (2024)', base: ALO_WMS, layer: 'rivm_nsl_20260401_gm_PM252024', source: 'RIVM Atlas Leefomgeving' },
  hitte: { label: 'Stedelijk hitte-eiland', base: KEA_WMS, layer: 'hitteeiland', source: 'Klimaateffectatlas' },
  overstroming: { label: 'Kans op > 50 cm water', base: KEA_WMS, layer: 'plaatsgebonden_overstromingskans_huidig_50_cm_20251120', source: 'Klimaateffectatlas' },
  bodemdaling: { label: 'Bodemdaling', base: KEA_WMS, layer: 'nl_bodemdaling_totaal_v20260623', source: 'Klimaateffectatlas' },
  paalrot: { label: 'Risico paalrot (per buurt)', base: KEA_WMS, layer: 'risicopaalrot_huidig', source: 'Klimaateffectatlas' },
  boomhoogte: { label: 'Boomhoogte (2022)', base: ALO_WMS, layer: 'rivm_20240101_boomhoogte_2022', source: 'RIVM Atlas Leefomgeving' },
  groen: { label: 'Groenkaart (2022)', base: ALO_WMS, layer: 'rivm_20240101_groenkaart_2022', source: 'RIVM Atlas Leefomgeving' }
};

$('env-layer').append(...Object.entries(ENV_LAYERS).map(([key, l]) => {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = l.label;
  return o;
}));

async function showEnvLayer(key) {
  await mapReady;
  if (map.getLayer('env-layer')) map.removeLayer('env-layer');
  if (map.getSource('env-layer')) map.removeSource('env-layer');
  const l = ENV_LAYERS[key];
  $('env-legend').hidden = !l;
  if (!l) return;
  $('env-source').textContent = `Bron: ${l.source}`;
  map.addSource('env-layer', {
    type: 'raster', tileSize: 256, attribution: l.source,
    tiles: [`${l.base}?service=WMS&version=1.3.0&request=GetMap&layers=${l.layer}&styles=&format=image/png&transparent=true` +
      '&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}']
  });
  // Under the water and sun-hours images and the outlines.
  const before = ['sunhours-2d', 'water-2d-outer', 'water-2d', 'buurt-line'].find(id => map.getLayer(id));
  map.addLayer({ id: 'env-layer', type: 'raster', source: 'env-layer', paint: { 'raster-opacity': 0.7 } }, before);
  $('env-legend-img').src = `${l.base}?service=WMS&version=1.3.0&request=GetLegendGraphic&layer=${l.layer}&format=image/png`;
  $('env-legend-img').alt = `Legenda: ${l.label}`;
}

$('env-layer').addEventListener('change', () => showEnvLayer($('env-layer').value));
