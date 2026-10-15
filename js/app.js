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

// A shared link goes straight to its report.
let welcomeSeen = false;
try { welcomeSeen = !!localStorage.getItem(WELCOME_KEY); } catch {}
if (!initialId && !welcomeSeen) openWelcome();
