// Print, welcome dialog, deep links and start-up.
// Loaded as a classic script; see index.html for the load order.

// ---------- Print ----------

$('print').addEventListener('click', async () => {
  // Copy the current map view into the panel so it appears on paper.
  await new Promise(resolve => { map.once('render', resolve); map.triggerRepaint(); });
  $('print-map').src = map.getCanvas().toDataURL('image/png');
  await $('print-map').decode().catch(() => {});
  window.print();
});

// ---------- Report sections ----------

// Every report section is a collapsible block with a one-line summary, so the
// sidebar stays calm and you open what you're looking for. Which ones are
// open is remembered.
const SECTIONS_KEY = 'adresrapport.openSections';
const sectionEls = [...document.querySelectorAll('details.section')];
let openSections = new Set();
try { openSections = new Set(JSON.parse(localStorage.getItem(SECTIONS_KEY)) || []); } catch {}
let printing = false;

for (const d of sectionEls) {
  d.open = openSections.has(d.dataset.key);
  d.addEventListener('toggle', () => {
    if (printing) return;
    d.open ? openSections.add(d.dataset.key) : openSections.delete(d.dataset.key);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...openSections])); } catch {}
    updateToggleAll();
  });
}

function updateToggleAll() {
  const anyClosed = sectionEls.some(d => !d.hidden && !d.open);
  $('toggle-sections').textContent = anyClosed ? 'Alles openklappen' : 'Alles dichtklappen';
}
$('toggle-sections').addEventListener('click', () => {
  const open = sectionEls.some(d => !d.hidden && !d.open);
  for (const d of sectionEls) d.open = open;
});

// Paper gets everything: open all sections while printing.
window.addEventListener('beforeprint', () => { printing = true; for (const d of sectionEls) d.open = true; });
window.addEventListener('afterprint', () => {
  for (const d of sectionEls) d.open = openSections.has(d.dataset.key);
  printing = false;
});

// The summaries read what the sections show, so they follow every loader
// without each one having to report back.
const shown = id => {
  const t = nlText($(id)).trim();
  return t && t !== '–' ? t : '';
};
// A value can carry its own short form (data-v), without the extra lines under it.
const definitions = id => [...$(id).querySelectorAll('dt')].map(dt => [nlText(dt).trim(), (dt.nextElementSibling.dataset.v ?? nlText(dt.nextElementSibling)).trim()]);
const withoutYear = t => t.replace(/\s*\(\d{4}\)$/, '');

function summarize() {
  const set = (key, parts) => {
    const text = parts.filter(Boolean).join(' · ');
    if ($(`sum-${key}`).textContent !== text) $(`sum-${key}`).textContent = text;
  };
  const height = shown('r-hoogte'), units = shown('r-aantal');
  set('pand', [/^\d/.test(height) && `${height.split(' (')[0]} hoog`, shown('r-dak') && `dak ${shown('r-dak')}`,
    units && `${units} verblijfsobject${units === '1' ? '' : 'en'}`]);
  const panels = shown('r-solar-panels');
  set('solar', panels ? [`${panels.split(' (')[0]} panelen`, shown('r-solar-yield')] : [shown('solar-headline') && 'weinig geschikt']);
  set('vbo', [shown('r-doel'), shown('r-opp')]);
  set('perceel', [shown('r-perceelopp'), shown('r-bebouwd').replace(' door dit pand', ' bebouwd')]);
  const monument = shown('r-monument'), gezicht = shown('r-gezicht');
  set('erfgoed', [monument.startsWith('Ja') ? 'Rijksmonument' : monument === 'Nee' ? 'Geen rijksmonument' : '',
    gezicht && gezicht !== 'Nee' && 'beschermd gezicht']);
  set('locatie', [shown('r-buurt'), shown('r-gemeente')]);
  const env = definitions('env');
  const floods = env.filter(([k]) => k.startsWith('Overstroming,'));
  const wet = floods.find(([, v]) => v !== 'droog' && v !== '–');
  const noise = env.find(([k]) => k.startsWith('Geluid'))?.[1].match(/^\d+ dB/)?.[0];
  const when = wet?.[0].replace('Overstroming, ', '');
  set('klimaat', [floods.length && (!wet ? 'droog bij overstromingen'
    : when === 'nog zeldzamer' ? 'water alleen bij extreem zeldzame overstroming' : `water bij overstroming ${when}`),
    noise && `${noise} geluid`]);
  const cbs = Object.fromEntries(definitions('cbs'));
  set('buurt', [cbs['Inwoners'] && `${withoutYear(cbs['Inwoners'])} inwoners`,
    cbs['Gem. WOZ-waarde'] && cbs['Gem. WOZ-waarde'] !== '–' && `WOZ ${withoutYear(cbs['Gem. WOZ-waarde'])}`]);
  const near = Object.fromEntries(definitions('amenities'));
  set('voorzieningen', [near['Supermarkt'] && near['Supermarkt'] !== '–' && `supermarkt ${near['Supermarkt']}`,
    near['Bus- of tramhalte'] && near['Bus- of tramhalte'] !== '–' && `halte ${near['Bus- of tramhalte']}`]);
  const older = shown('years-headline').match(/ouder dan (\d+%)/)?.[1];
  set('bouwjaren', [older && `ouder dan ${older} van de omgeving`]);
  const rows = $('units').rows.length;
  set('eenheden', [rows && `${rows} adressen`]);
  // The "click on the map" hint is only useful before the first address.
  document.querySelector('#panel > p.hint').hidden = !$('result').hidden;
  updateToggleAll();
}

let summaryPending = false;
new MutationObserver(() => {
  if (summaryPending) return;
  summaryPending = true;
  requestAnimationFrame(() => { summaryPending = false; summarize(); });
}).observe($('result'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });

// ---------- Hiding the address info ----------

// The whole sidebar (or the phone drawer) can be put away for a clear map;
// the Adresinfo button on the map brings it back.
// On a computer the sidebar slides aside and a tab on the map's edge brings it
// back; it stays as you left it.
const PANEL_KEY = 'adresrapport.panelHidden';
const wide = matchMedia('(min-width: 701px)');
function setPanelHidden(hidden, { focus = true } = {}) {
  document.body.classList.toggle('panel-hidden', hidden);
  // Out of the tab order while it's away.
  $('panel').inert = hidden;
  for (const id of ['panel-show', 'panel-toggle']) $(id).setAttribute('aria-expanded', !hidden);
  $('panel-toggle').setAttribute('aria-label', hidden ? 'Adresinfo uitklappen' : 'Adresinfo inklappen');
  if (wide.matches) try { localStorage.setItem(PANEL_KEY, hidden ? '1' : ''); } catch {}
  if (focus) (hidden ? $(wide.matches ? 'panel-toggle' : 'panel-show') : $('panel-hide')).focus();
}
$('panel-hide').addEventListener('click', () => setPanelHidden(true));
$('panel-show').addEventListener('click', () => setPanelHidden(false));
$('panel-toggle').addEventListener('click', () => setPanelHidden(!document.body.classList.contains('panel-hidden')));
try { if (wide.matches && localStorage.getItem(PANEL_KEY)) setPanelHidden(true, { focus: false }); } catch {}

// ---------- Phone layout ----------

// On a phone the report is a drawer: collapsed (search and address only),
// half or nearly full screen. The CSS only applies on narrow screens.
const phone = matchMedia('(max-width: 700px)');
const PANEL_STATES = ['panel-collapsed', '', 'panel-expanded'];
let panelState = 1;

function setPanelState(i) {
  panelState = i;
  document.body.classList.remove('panel-collapsed', 'panel-expanded');
  if (PANEL_STATES[i]) document.body.classList.add(PANEL_STATES[i]);
  $('panel-handle').setAttribute('aria-expanded', i > 0);
  if (i === 0) $('panel').scrollTop = 0;
}

$('panel-handle').addEventListener('click', () => setPanelState((panelState + 1) % 3));

// Active panels (Regen, Zon) show as compact cards on the map, without the
// whole Opties sheet; opening one folds the report away so the map stays visible.
function updatePhoneCards(opened) {
  document.body.classList.toggle('show-cards', radar.active || floodPanel.open || (sun.on && is3D));
  if (opened && phone.matches) setPanelState(0);
}
// "Lagen en gereedschap": a drawer on the right of the map, or on a phone the
// sheet with all map panels. On a computer it stays as you left it.
const DRAWER_KEY = 'adresrapport.drawer';
function setControlsOpen(open) {
  document.body.classList.toggle('controls-open', open);
  $('controls-toggle').setAttribute('aria-expanded', open);
  if (phone.matches) {
    // Make room for the controls sheet.
    if (open) setPanelState(0);
  } else {
    try { localStorage.setItem(DRAWER_KEY, open ? '1' : ''); } catch {}
  }
}
$('controls-toggle').addEventListener('click', () => setControlsOpen(!document.body.classList.contains('controls-open')));
$('drawer-close').addEventListener('click', () => { setControlsOpen(false); $('controls-toggle').focus(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('controls-open') && $('drawer').contains(document.activeElement)) {
    setControlsOpen(false);
    $('controls-toggle').focus();
  }
});
try { if (!phone.matches && localStorage.getItem(DRAWER_KEY)) setControlsOpen(true); } catch {}

// ---------- Welcome ----------

// Shown on the first visit. The real search box (autocomplete included) moves
// into the dialog while it's open, so searching there is the way in.
const WELCOME_KEY = 'adresrapport.welcomeSeen';
const searchHome = { parent: $('search').parentNode, next: $('search').nextSibling };
let focusBeforeWelcome = null;

// The basic choices up front: light or dark, Dutch or English.
function updateWelcomePrefs() {
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', b.dataset.themeChoice === (isDark() ? 'dark' : 'light'));
  for (const b of document.querySelectorAll('[data-lang-choice]')) b.setAttribute('aria-pressed', b.dataset.langChoice === LANG);
}
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => { setTheme(b.dataset.themeChoice, true); updateWelcomePrefs(); });
for (const b of document.querySelectorAll('[data-lang-choice]')) b.addEventListener('click', () => { if (b.dataset.langChoice !== LANG) setLanguage(b.dataset.langChoice); });

function openWelcome() {
  updateWelcomePrefs();
  focusBeforeWelcome = document.activeElement;
  $('welcome-search-slot').append($('search'));
  $('welcome').hidden = false;
  $('q').focus();
}

function closeWelcome() {
  if ($('welcome').hidden) return;
  $('welcome').hidden = true;
  searchHome.parent.insertBefore($('search'), searchHome.next);
  closeSuggestions();
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch {}
  focusBeforeWelcome?.focus?.();
}

$('help').addEventListener('click', openWelcome);
$('welcome-close').addEventListener('click', closeWelcome);
$('welcome-start').addEventListener('click', closeWelcome);
$('welcome').addEventListener('click', e => { if (e.target === $('welcome')) closeWelcome(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWelcome(); });
for (const b of document.querySelectorAll('#welcome [data-id]')) b.addEventListener('click', () => loadAddress(b.dataset.id));

// ---------- Language ----------

for (const r of document.querySelectorAll('input[name=lang]')) {
  r.checked = r.value === LANG;
  r.addEventListener('change', () => setLanguage(r.value));
}

// ---------- Modules loaded on first use ----------

// The comparison, the address list and the Groeikaart load when first opened.
const lazyScripts = {};
function loadScript(src) {
  lazyScripts[src] ??= new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement('script'), {
    src, onload: resolve,
    onerror: () => { delete lazyScripts[src]; reject(new Error(`Onderdeel kon niet laden (${src}).`)); }
  })));
  return lazyScripts[src];
}
for (const [id, src, open] of [['open-compare', 'js/compare.js', 'openCompare'], ['open-bulk', 'js/compare.js', 'openBulk'], ['groei-open', 'js/growth.js', 'openGrowth']]) {
  $(id).addEventListener('click', () => loadScript(src).then(() => window[open]()).catch(err => setStatus(err.message, true)));
}

// ---------- Deep links ----------

window.addEventListener('popstate', e => {
  if (e.state?.id) loadAddress(e.state.id, { pushHistory: false });
});

const initialParams = new URLSearchParams(location.search);
const initialId = initialParams.get('id');
if (initialId) {
  try { history.replaceState({ id: initialId }, '', location.href); } catch {}
  openSharedLink(initialParams);
}
renderRecent();

startQualityWatch();
updateQualityText();

// A shared link goes straight to its report.
let welcomeSeen = false;
try { welcomeSeen = !!localStorage.getItem(WELCOME_KEY); } catch {}
if (!initialId && !welcomeSeen) openWelcome();
