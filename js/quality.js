// Display quality: "mooi" (full detail) or "snel" (lighter: smaller 3D area,
// no detailed roofs, sharper-but-cheaper rendering, less rain). The user
// picks Automatisch, Mooi or Snel; Automatisch starts Mooi and switches to
// Snel when the map keeps stuttering.
// Loaded as a classic script; see index.html for the load order.

const QUALITY_KEY = 'adresrapport.quality';
const quality = { setting: 'auto', mode: 'mooi', autoSwitched: false };
try { quality.setting = localStorage.getItem(QUALITY_KEY) || 'auto'; } catch {}
quality.mode = quality.setting === 'snel' ? 'snel' : 'mooi';
const isFast = () => quality.mode === 'snel';

function setQualityMode(mode) {
  if (mode === quality.mode) return;
  quality.mode = mode;
  // Draw at one pixel per CSS pixel on high-resolution screens: a quarter of the work.
  map.setPixelRatio(isFast() ? 1 : devicePixelRatio);
  // The 3D scene and the rain depend on the mode; rebuild them.
  sceneFor = null;
  three.key = '';
  rain.groupKey = '';
  if (is3D) loadScene();
  applyBuildingStyle();
  updateQualityText();
}

function updateQualityText() {
  $('quality-now').textContent = `Nu: ${isFast() ? 'Snel' : 'Mooi'}` +
    (quality.autoSwitched && isFast() && quality.setting === 'auto' ? ', automatisch gekozen omdat Mooi haperde.' : '.');
  for (const r of document.querySelectorAll('input[name=quality]')) r.checked = r.value === quality.setting;
}

for (const r of document.querySelectorAll('input[name=quality]')) {
  r.addEventListener('change', () => {
    quality.setting = r.value;
    try { localStorage.setItem(QUALITY_KEY, r.value); } catch {}
    quality.autoSwitched = false;
    setQualityMode(r.value === 'snel' ? 'snel' : 'mooi');
    updateQualityText();
  });
}

$('settings-btn').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', open);
});
document.addEventListener('click', e => {
  if (!$('settings').hidden && !e.target.closest('#settings, #settings-btn')) {
    $('settings').hidden = true;
    $('settings-btn').setAttribute('aria-expanded', 'false');
  }
});

// ---------- Automatic switch ----------

// Watches the time between frames while the map is drawing. Idle gaps (the
// map doesn't redraw when nothing moves) are left out, so only real
// animation counts. Two slow 3-second windows in a row switch to Snel.
const SLOW_FPS = 22;
let frameTimes = [];
let slowWindows = 0;

function startQualityWatch() {
  map.on('render', () => frameTimes.push(performance.now()));
  setInterval(() => {
    const times = frameTimes;
    frameTimes = [];
    if (quality.setting !== 'auto' || isFast()) return;
    const gaps = times.slice(1).map((t, i) => t - times[i]).filter(g => g < 500).sort((a, b) => a - b);
    if (gaps.length < 30) { slowWindows = 0; return; }
    const fps = 1000 / gaps[Math.floor(gaps.length / 2)];
    slowWindows = fps < SLOW_FPS ? slowWindows + 1 : 0;
    if (slowWindows >= 2) {
      slowWindows = 0;
      quality.autoSwitched = true;
      setQualityMode('snel');
      showToast('De kaart haperde, dus de weergave staat nu op Snel.', 'Toch Mooi', () => {
        quality.setting = 'mooi';
        try { localStorage.setItem(QUALITY_KEY, 'mooi'); } catch {}
        setQualityMode('mooi');
        updateQualityText();
      });
    }
  }, 3000);
}

// ---------- Toast ----------

let toastTimer = 0;
function showToast(text, actionLabel, action) {
  $('toast-text').textContent = text;
  $('toast-action').hidden = !actionLabel;
  $('toast-action').textContent = actionLabel || '';
  $('toast-action').onclick = () => { $('toast').hidden = true; action?.(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 12000);
}
$('toast-close').addEventListener('click', () => { $('toast').hidden = true; });
