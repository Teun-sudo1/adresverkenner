// Camera: the round dial top right (drag to turn and tilt, tap for north up)
// and the fly-around, a ten-second orbit around the address when 3D opens,
// from the opposite time of day to now so day turns to night or back.
// Loaded as a classic script; see index.html for the load order.

// ---------- Fly-around ----------

const FLIGHT_MS = 10000;
const FLOWN_KEY = 'adresrapport.flown';
const flight = { frame: 0, restore: null };

function flownIds() {
  try { return JSON.parse(localStorage.getItem(FLOWN_KEY)) || []; } catch { return []; }
}

function markFlown(id) {
  const list = [id, ...flownIds().filter(x => x !== id)].slice(0, 300);
  try { localStorage.setItem(FLOWN_KEY, JSON.stringify(list)); } catch {}
}

// Called when 3D opens: only on the first visit to an address.
function maybeFlyAround() {
  if (!addressId || applyingView || reducedMotion.matches || flownIds().includes(addressId)) return;
  markFlown(addressId);
  flyAround();
}

const waitUntil = (test, ms) => new Promise(resolve => {
  const t0 = performance.now();
  const tick = () => (test() || performance.now() - t0 > ms ? resolve() : setTimeout(tick, 100));
  tick();
});

const easeInOut = t => 0.5 - 0.5 * Math.cos(Math.PI * t);

async function flyAround() {
  stopFlight();
  const ctx = current;
  if (!ctx) return;
  // Wait for the 3D buildings, so the flight shows them from the start.
  await waitUntil(() => current !== ctx || (sceneFor === ctx && sceneFeatures.length > 0 && three.scene), 20000);
  if (current !== ctx || !is3D || flight.frame) return;

  const before = { date: $('sun-date').value, time: $('sun-time').value };
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  $('sun-date').value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  updateTreeSeason();
  const nowMin = Math.round((today.getHours() * 60 + today.getMinutes()) / 5) * 5;
  flight.restore = () => {
    $('sun-date').value = before.date;
    $('sun-time').value = before.time;
    updateTreeSeason();
    updateSun();
  };

  const t0 = performance.now();
  let lastMin = -1;
  const step = now => {
    const t = Math.min(1, (now - t0) / FLIGHT_MS);
    const e = easeInOut(t);
    // One full turn, rising from 60° to the usual 75° tilt and zooming in a little.
    map.jumpTo({ center: [ctx.lon, ctx.lat], bearing: -20 - 360 * e, pitch: 60 + 15 * e, zoom: 16.4 + 0.6 * e });
    // From twelve hours away back to now, in the slider's five-minute steps.
    const min = (Math.round((nowMin + 720 + 720 * e) / 5) * 5) % 1440;
    if (min !== lastMin) {
      lastMin = min;
      $('sun-time').value = min;
      updateSun();
    }
    if (t < 1) flight.frame = requestAnimationFrame(step);
    else stopFlight();
  };
  flight.frame = requestAnimationFrame(step);
}

// Ends the flight; the date and time go back to how they were.
function stopFlight() {
  if (!flight.frame && !flight.restore) return;
  cancelAnimationFrame(flight.frame);
  flight.frame = 0;
  const restore = flight.restore;
  flight.restore = null;
  restore?.();
}

// Any touch, click, scroll or key on the map takes over from the flight.
for (const type of ['pointerdown', 'wheel', 'keydown']) {
  map.getCanvasContainer().addEventListener(type, () => { if (flight.frame) stopFlight(); }, { passive: true });
}

// ---------- Controls top right ----------

class CameraControl {
  onAdd() {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group camera-ctrl';
    box.innerHTML = `
      <button type="button" class="dial" title="Draaien en kantelen" aria-label="Draaien en kantelen. Sleep langs de rand om te draaien, in het midden omhoog of omlaag om te kantelen, tik voor het noorden boven. Pijltjestoetsen werken ook.">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle class="ring" cx="24" cy="24" r="21"/>
          <g class="ticks">${[0, 90, 180, 270].map(a => `<line x1="24" y1="4.5" x2="24" y2="8" transform="rotate(${a} 24 24)"/>`).join('')}</g>
          <g class="needle"><path class="north" d="M24 8 L28.5 24 L19.5 24 Z"/><path class="south" d="M24 40 L28.5 24 L19.5 24 Z"/></g>
          <circle class="hub" cx="24" cy="24" r="2.6"/>
        </svg>
      </button>
      <button type="button" class="fly" title="Rondvlucht om het adres" aria-label="Rondvlucht om het adres">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10l5-3v10l-5-3z"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>
      </button>`;
    this.box = box;
    setupDial(box.querySelector('.dial'));
    box.querySelector('.fly').addEventListener('click', async () => {
      if (!current) { setStatus('Zoek eerst een adres voor een rondvlucht.'); return; }
      if (addressId) markFlown(addressId);
      if (!is3D) await set3D(true);
      flyAround();
    });
    return box;
  }
  onRemove() { this.box.remove(); }
}

function setupDial(dial) {
  const needle = dial.querySelector('.needle');
  const show = () => {
    // The needle points north and flattens as the map tilts.
    const squash = 0.55 + 0.45 * Math.cos(map.getPitch() * Math.PI / 180);
    needle.style.transform = `rotate(${-map.getBearing()}deg) scaleY(${squash.toFixed(3)})`;
  };
  map.on('rotate', show);
  map.on('pitch', show);
  show();

  let drag = null;
  const angleAt = e => {
    const r = dial.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  dial.addEventListener('pointerdown', e => {
    stopFlight();
    const r = dial.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    drag = { x: e.clientX, y: e.clientY, angle: angleAt(e), bearing: map.getBearing(), pitch: map.getPitch(),
      onRing: dist > r.width * 0.28, moved: false };
    dial.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  dial.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.onRing) {
      // Turning the ring turns the needle with it.
      let delta = angleAt(e) - drag.angle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      drag.angle = angleAt(e);
      drag.bearing -= delta;
      map.setBearing(drag.bearing);
    } else {
      map.jumpTo({ bearing: drag.bearing + dx * 0.6, pitch: Math.min(85, Math.max(0, drag.pitch - dy * 0.6)) });
    }
  });
  const end = () => {
    if (drag && !drag.moved) map.easeTo({ bearing: 0 });
    drag = null;
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', () => { drag = null; });
  dial.addEventListener('keydown', e => {
    const turn = { ArrowLeft: -15, ArrowRight: 15 }[e.key];
    const tilt = { ArrowUp: 10, ArrowDown: -10 }[e.key];
    if (turn) map.easeTo({ bearing: map.getBearing() + turn, duration: 200 });
    else if (tilt) map.easeTo({ pitch: Math.min(85, Math.max(0, map.getPitch() + tilt)), duration: 200 });
    else return;
    e.preventDefault();
  });
  // A click without dragging (also Enter or Space on the keyboard) puts north up.
  dial.addEventListener('click', e => { if (e.detail === 0) map.easeTo({ bearing: 0 }); });
}

map.addControl(new CameraControl(), 'top-right');
