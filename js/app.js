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
  const t = $(id)?.textContent.trim();
  return t && t !== '–' ? t : '';
};
const definitions = id => [...$(id).querySelectorAll('dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim()]);
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
$('controls-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('controls-open');
  $('controls-toggle').setAttribute('aria-expanded', open);
  // Make room for the controls sheet.
  if (open && phone.matches) setPanelState(0);
});

// ---------- Welcome ----------

// Shown on the first visit. The real search box (autocomplete included) moves
// into the dialog while it's open, so searching there is the way in.
const WELCOME_KEY = 'adresrapport.welcomeSeen';
const searchHome = { parent: $('search').parentNode, next: $('search').nextSibling };
let focusBeforeWelcome = null;

function openWelcome() {
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

// ---------- Deep links ----------

window.addEventListener('popstate', e => {
  if (e.state?.id) loadAddress(e.state.id, { pushHistory: false });
});

const initialId = new URLSearchParams(location.search).get('id');
if (initialId) {
  try { history.replaceState({ id: initialId }, '', location.href); } catch {}
  loadAddress(initialId, { pushHistory: false });
}
renderRecent();

startQualityWatch();
updateQualityText();

// A shared link goes straight to its report.
let welcomeSeen = false;
try { welcomeSeen = !!localStorage.getItem(WELCOME_KEY); } catch {}
if (!initialId && !welcomeSeen) openWelcome();
