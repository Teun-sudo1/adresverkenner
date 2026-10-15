// Shareable links: the URL holds the address and the view (camera, basemap,
// building colours, layer, 3D, sun, water scenario and live rain), so whoever
// opens the link sees the same map.
// Loaded as a classic script; see index.html for the load order.

// The Locatieserver id of the address on screen; set by loadAddress.
let addressId = null;
// While a shared link is being applied, its own changes mustn't rewrite the URL.
let applyingView = false;

function viewParams() {
  const c = map.getCenter();
  const p = [['id', addressId],
    ['kaart', [c.lng.toFixed(6), c.lat.toFixed(6), map.getZoom().toFixed(2), Math.round(map.getBearing()), Math.round(map.getPitch())].join(',')]];
  if (document.querySelector('#layers [data-layer=luchtfoto]').getAttribute('aria-pressed') === 'true') p.push(['basis', 'luchtfoto']);
  if (colorBy !== 'bouwjaar') p.push(['kleur', colorBy || 'geen']);
  if ($('env-layer').value) p.push(['laag', $('env-layer').value]);
  if (is3D) p.push(['3d', '1']);
  if (sun.on) p.push(['zon', `${$('sun-date').value},${$('sun-time').value}`]);
  if (waterScenario) p.push(['water', waterScenario]);
  if (radar.active) p.push(['regen', '1']);
  // Commas stay readable; everything else is encoded.
  return p.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`).join('&');
}

let shareTimer = 0;
function scheduleShareUrl() {
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    if (!addressId || applyingView) return;
    const search = `?${viewParams()}`;
    if (search !== location.search) try { history.replaceState({ id: addressId }, '', search); } catch {}
  }, 400);
}
map.on('moveend', scheduleShareUrl);
// Every button and menu in the app changes the view, so listen at the top.
document.addEventListener('click', scheduleShareUrl);
document.addEventListener('change', scheduleShareUrl);
$('sun-time').addEventListener('input', scheduleShareUrl);

// Picks a menu option the way a user would, if the option exists.
function chooseOption(id, value) {
  const s = $(id);
  if (![...s.options].some(o => o.value === value)) return;
  s.value = value;
  s.dispatchEvent(new Event('change'));
}

async function openSharedLink(params) {
  const id = params.get('id');
  const k = params.get('kaart')?.split(',').map(Number);
  const camera = k?.length === 5 && k.every(Number.isFinite)
    ? { center: [k[0], k[1]], zoom: k[2], bearing: k[3], pitch: k[4] } : null;
  const zon = params.get('zon')?.split(',');
  const sunOk = zon && /^\d{4}-\d\d-\d\d$/.test(zon[0]) && Number(zon[1]) >= 0 && Number(zon[1]) < 1440;
  applyingView = true;
  try {
    await mapReady;
    if (params.get('basis') === 'luchtfoto') document.querySelector('#layers [data-layer=luchtfoto]').click();
    const kleur = params.get('kleur');
    if (kleur) chooseOption('color-by', kleur === 'geen' ? '' : kleur);
    if (params.get('laag')) chooseOption('env-layer', params.get('laag'));
    if (sunOk) {
      $('sun-date').value = zon[0];
      $('sun-time').value = Math.round(Number(zon[1]) / 5) * 5;
      updateTreeSeason();
    }
    const water = params.get('water');
    if (WATER_SCENARIOS[water]) {
      setFloodPanel(true);
      chooseOption('flood-scenario', water);
    }
    const loaded = loadAddress(id, { pushHistory: false, camera });
    if (params.get('3d') === '1' || sunOk) {
      await set3D(true);
      if (sunOk && !sun.on) toggleSun();
    }
    if (camera) map.jumpTo(camera);
    if (params.get('regen') === '1' && !radar.active) $('rain-live-toggle').click();
    await loaded;
  } finally {
    applyingView = false;
  }
}

// ---------- Copy the link ----------

$('share-link').addEventListener('click', async () => {
  clearTimeout(shareTimer);
  const url = addressId ? `${location.href.split(/[?#]/)[0]}?${viewParams()}` : location.href;
  // A phone offers its own share sheet; elsewhere the link goes to the clipboard.
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: document.title, url }); } catch {}
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link gekopieerd. Wie hem opent, ziet deze kaart met dezelfde weergave.');
  } catch {
    showToast(`Kopiëren lukte niet. De link: ${url}`);
  }
});
