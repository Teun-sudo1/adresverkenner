#!/usr/bin/env python3
"""Smoke test for Adresverkenner.

Starts Chrome headless, drives the app over the DevTools protocol and checks
that the main features work at three test addresses: the report, the water
simulation (does the water actually rise?), 3D, sun and night,
trees, measuring and the environment layers. Console errors fail the run.
Screenshots go to tests/output/.

Usage:
    python3 tests/smoke_test.py                 # tests the local index.html
    python3 tests/smoke_test.py --url https://teun-sudo1.github.io/adresverkenner/

Needs Google Chrome and the websocket-client package (pip install websocket-client).
Takes a few minutes: every address loads live data from PDOK and other sources.
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:
    sys.exit('websocket-client ontbreekt: pip install websocket-client')

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'tests' / 'output'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
PORT = 9339

# Test addresses (Locatieserver ids) and what each one is good for.
ADDRESSES = {
    'prinsengracht': ('adr-65a166e372b34a0d9af1a9cbefc76632', 'Prinsengracht 263, Amsterdam: monument, dakvormen, bomen'),
    'rotterdam': ('adr-52d81e8de2de65f13c910a53e1a477f9', 'Van Heukelomstraat 201, Rotterdam: polder, veel water'),
    'damrak': ('adr-8f4d573be765b4c80dd635ba73747903', 'Damrak 1, Amsterdam: dichte binnenstad'),
}

# Counts "water blue" pixels in the map canvas, to see the water grow.
COUNT_WATER_PIXELS = """(() => {
  const src = map.getCanvas(), c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d'); g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) if (d[i + 2] - d[i] > 45 && d[i + 2] > 110) n++;
  return n;
})()"""


class Browser:
    """A headless Chrome tab driven over the DevTools protocol."""

    def __init__(self, chrome):
        self.profile = tempfile.mkdtemp(prefix='adresverkenner-test-')
        self.proc = subprocess.Popen(
            [chrome, '--headless=new', f'--remote-debugging-port={PORT}', f'--user-data-dir={self.profile}',
             '--window-size=1400,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
             '--no-first-run', '--no-default-browser-check',
             # GitHub's Linux runners don't allow Chrome's sandbox.
             *(['--no-sandbox'] if os.environ.get('CI') else []), 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json'))
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError('Chrome start niet')
        page = next(t for t in targets if t['type'] == 'page')
        self.ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=5, suppress_origin=True)
        self.ws.settimeout(0.5)
        self.msg_id = 0
        self.errors = []
        # Network failures of outside data services: reported, not failing the run.
        self.network = []
        for domain in ('Runtime.enable', 'Log.enable', 'Page.enable', 'Network.enable'):
            self.send(domain)
        self.send('Network.setCacheDisabled', {'cacheDisabled': True})

    def _handle(self, m):
        method = m.get('method')
        if method == 'Runtime.exceptionThrown':
            d = m['params']['exceptionDetails']
            self.errors.append('exception: ' + d.get('exception', {}).get('description', d.get('text', '')))
        elif method == 'Runtime.consoleAPICalled' and m['params']['type'] == 'error':
            text = 'console.error: ' + ' '.join(str(a.get('value', a.get('description', ''))) for a in m['params']['args'])
            # A service that didn't answer (no connection, timed out) is a network hiccup, not a bug in the app.
            (self.network if NETWORK_FAILURE.search(text) else self.errors).append(text)
        elif method == 'Log.entryAdded' and m['params']['entry']['level'] == 'error':
            e = m['params']['entry']
            if 'favicon' in e.get('url', ''):
                return
            # "Failed to load resource" from a data service is the service's hiccup;
            # whether the feature still works is what the checks themselves test.
            if e.get('source') == 'network' or e['text'].startswith('Failed to load resource'):
                self.network.append(f"{e['text']} {e.get('url', '')}")
            else:
                self.errors.append(f"log.error: {e['text']} {e.get('url', '')}")

    def send(self, method, params=None, timeout=120):
        self.msg_id += 1
        self.ws.send(json.dumps({'id': self.msg_id, 'method': method, 'params': params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if m.get('id') == self.msg_id:
                return m.get('result', m)
            self._handle(m)
        raise TimeoutError(method)

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                self._handle(json.loads(self.ws.recv()))
            except websocket.WebSocketTimeoutException:
                pass

    def js(self, expression):
        r = self.send('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        return r.get('result', {}).get('value')

    def wait_for(self, expression, timeout=90):
        end = time.time() + timeout
        while time.time() < end:
            if self.js(expression):
                return True
            self.pump(0.5)
        return False

    def screenshot(self, name):
        self.pump(1)
        data = self.send('Page.captureScreenshot', {'format': 'png'})['data']
        (OUTPUT / f'{name}.png').write_bytes(base64.b64decode(data))

    def close(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            self.proc.wait(timeout=10)
            shutil.rmtree(self.profile, ignore_errors=True)


# Outside sources whose outage would fail many checks at once. They're probed
# before the run; checks that need a source that is down count as a warning.
SOURCES = {
    '3D BAG': ['https://api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.0363100012169583',
               'https://data.3dbag.nl/api/BAG3D/wfs?service=WFS&version=2.0.0&request=GetCapabilities'],
}
DOWN = set()
NETWORK_FAILURE = re.compile(r'Failed to fetch|signal timed out|TimeoutError|NetworkError|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED')


def probe_sources():
    # Each URL gets a hard 25 s limit, in a daemon thread: a server that half
    # answers can keep urllib waiting far beyond its socket timeout, and such a
    # thread mustn't hold up the end of the run either.
    import threading

    def answers(url, out):
        try:
            with urllib.request.urlopen(url, timeout=20) as res:
                out.append(res.status < 500)
        except Exception:
            out.append(False)

    for name, urls in SOURCES.items():
        for url in urls:
            out = []
            t = threading.Thread(target=answers, args=(url, out), daemon=True)
            t.start()
            t.join(25)
            if not (out and out[0]):
                DOWN.add(name)
                break
    for name in sorted(DOWN):
        print(f'LET OP: {name} reageert niet; controles die {name} nodig hebben, tellen als waarschuwing.', flush=True)


class Results:
    def __init__(self):
        self.items = []
        self.skipped = []

    def check(self, name, ok, detail='', needs=None):
        if not ok and needs in DOWN:
            self.skipped.append((name, needs))
            print(f"  LET OP {name}  ({needs} reageert niet)", flush=True)
            return ok
        self.items.append((name, bool(ok), detail))
        print(f"  {'OK  ' if ok else 'FOUT'} {name}{f'  ({detail})' if detail else ''}", flush=True)
        return ok

    def skip(self, name, needs):
        self.skipped.append((name, needs))
        print(f"  LET OP {name} overgeslagen  ({needs} reageert niet)", flush=True)


def open_address(b, base_url, address_id):
    b.send('Page.navigate', {'url': f'{base_url}?id={address_id}'})
    # The height comes from 3D BAG, the construction year from BAG; wait for the height unless 3D BAG is down.
    field = 'r-bouwjaar' if '3D BAG' in DOWN else 'r-hoogte'
    ready = b.wait_for("typeof loadAddress === 'function' && typeof pendingLoads !== 'undefined' "
                       f"&& !['', '–'].includes(document.getElementById('{field}').textContent)", 90)
    # Let the slower sections (heritage, years, CBS, environment) arrive too.
    b.wait_for('pendingLoads === 0', 90)
    b.js("setTheme('light', true); localStorage.setItem('adresrapport.welcomeSeen', '1')")
    # Headless Chrome renders on the CPU and would trip the automatic switch to Snel.
    b.js("quality.setting = 'mooi'; localStorage.setItem('adresrapport.quality', 'mooi'); setQualityMode('mooi')")
    # The fly-around on first opening 3D has its own test; skip it elsewhere.
    b.js("addressId && markFlown(addressId)")
    return ready


def choose_scenario(b, value):
    if b.js("document.getElementById('flood').hidden"):
        b.js("document.getElementById('flood-toggle').click()")
    b.js(f"(() => {{ const s = document.getElementById('flood-scenario'); s.value = '{value}'; s.dispatchEvent(new Event('change')); }})()")
    return b.wait_for("(() => { const t = document.getElementById('flood-info').textContent; return !!water || (t && !t.endsWith('…')); })()", 120)


def test_welcome(b, r, base_url):
    """The welcome screen on a first visit must keep up with the app: every
    toolbar function mentioned, its numbers matching the settings, fully
    translated, and an example address that loads."""
    b.send('Page.navigate', {'url': base_url})
    ok = b.wait_for("typeof loadAddress === 'function' && !document.getElementById('welcome').hidden", 30)
    b.pump(1)
    b.screenshot('welkom')
    r.check('welkom: verschijnt bij eerste bezoek, met de zoekbalk erin',
            ok and b.js("document.getElementById('welcome-search-slot').contains(document.getElementById('q'))"))
    themes = b.js("""(() => {
      const pick = t => { document.querySelector(`[data-theme-choice=${t}]`).click(); return document.documentElement.dataset.theme
        + (document.querySelector(`[data-theme-choice=${t}]`).getAttribute('aria-pressed') === 'true' ? '' : '?'); };
      return [pick('dark'), pick('light'), document.querySelector('[data-lang-choice=nl]').getAttribute('aria-pressed')].join(' ');
    })()""")
    r.check('welkom: thema en taal kiezen', themes == 'dark light true', themes)
    # Each toolbar button (except the base maps) and the search extras need a mention.
    missing = b.js("""(() => {
      const text = document.getElementById('welcome').textContent.toLowerCase();
      const names = [...document.querySelectorAll('#toolbar .tb-group:not(#layers) .lbl')].map(l => l.textContent.trim());
      return [...names, 'Vergelijk', 'lijst'].filter(n => !text.includes(n.toLowerCase()));
    })()""")
    r.check('welkom: noemt elke knop van de werkbalk', ok and not missing, f"ontbreekt: {', '.join(missing)}" if missing else '')
    b.js("loadScript('js/compare.js')")
    b.wait_for("typeof BULK_MAX !== 'undefined'", 20)
    numbers = b.js("""(() => {
      const text = document.getElementById('welcome').textContent;
      return [`${SCENE_RADIUS_OUTER} m`, `${BULK_MAX} adressen`].filter(n => !text.includes(n));
    })()""")
    r.check('welkom: getallen kloppen met de instellingen', ok and not numbers, f"niet gevonden: {', '.join(numbers)}" if numbers else '3D-gebied en lijstmaximum')
    # In English nothing may stay Dutch (addresses and the brand name excepted).
    b.js("localStorage.setItem('adresrapport.lang', 'en')")
    b.send('Page.navigate', {'url': base_url})
    b.wait_for("typeof loadAddress === 'function' && !document.getElementById('welcome').hidden", 30)
    b.pump(1)
    dutch = b.js("""[...document.querySelectorAll('#welcome h2, #welcome h3, #welcome p, #welcome button:not([data-id])')]
      .filter(el => /[a-z]{3}/i.test(el.textContent) && el.textContent.trim() === nlText(el).trim() && !/^Adresverkenner$/.test(el.textContent.trim())
        && !el.closest('[translate=no]'))
      .map(el => el.textContent.trim().slice(0, 40))""")
    r.check('welkom: helemaal vertaald in het Engels', not dutch, '; '.join(dutch))
    b.js("localStorage.removeItem('adresrapport.lang')")
    b.send('Page.navigate', {'url': base_url})
    b.wait_for("typeof loadAddress === 'function' && !document.getElementById('welcome').hidden", 30)
    b.js("document.querySelector('#welcome [data-id]').click()")
    loaded = b.wait_for("document.getElementById('welcome').hidden && !document.getElementById('result').hidden "
                        "&& document.getElementById('r-address').textContent !== ''", 30)
    r.check('welkom: voorbeeldadres laadt', loaded, b.js("document.getElementById('r-address').textContent"))


def test_analysis(b, r, key):
    """Analyse tab: figures for a radius and for a drawn area, the density grid and the walking/cycling rings."""
    b.js("document.getElementById('controls-toggle').click(); document.getElementById('tab-analyse').click()")
    b.js("map.jumpTo({center: [current.lon, current.lat], zoom: 16.5, pitch: 0, bearing: 0})")
    rows = "Object.fromEntries([...document.querySelectorAll('#area-result dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))"
    b.js("(() => { const s = document.getElementById('area-radius'); s.value = 250; s.dispatchEvent(new Event('input')); document.getElementById('area-run').click(); })()")
    ok = b.wait_for("document.querySelectorAll('#area-result dt').length >= 5", 90)
    res = b.js(rows) or {}
    r.check(f'{key}: gebied analyseren (straal 250 m)', ok and res.get('Panden', 'geen') != 'geen' and 'Bouwjaar (mediaan)' in res,
            ' · '.join(f'{k}: {v}' for k, v in list(res.items())[:5]))
    # Draw a square around the middle of the map by clicking; close it on the first point.
    before = b.js('addressId')
    b.js("document.getElementById('area-draw-mode').click()")
    left, top, w, h = b.js("(() => { const r = map.getCanvas().getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    cx, cy = left + w / 2, top + h / 2
    for x, y in ((cx - 120, cy - 120), (cx + 120, cy - 120), (cx + 120, cy + 120), (cx - 120, cy + 120), (cx - 120, cy - 120)):
        for t in ('mouseMoved', 'mousePressed', 'mouseReleased'):
            b.send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
        b.pump(0.4)
    ok = b.wait_for("!analysis.drawing && document.querySelectorAll('#area-result dt').length >= 3", 90)
    res = b.js(rows) or {}
    r.check(f'{key}: zelf een gebied tekenen', ok and b.js('addressId') == before and 'Oppervlakte gebied' in res,
            f"{res.get('Oppervlakte gebied')}, {res.get('Panden')}")
    b.js("document.getElementById('area-radius-mode').click()")
    # Heatmap: building density, then construction year.
    for metric in ('dichtheid', 'bouwjaar'):
        b.js(f"(() => {{ const s = document.getElementById('heat-metric'); s.value = '{metric}'; s.dispatchEvent(new Event('change')); }})()")
        b.wait_for("/^[\\d.,]+ vakken/.test(document.getElementById('heat-info').textContent)", 90)
        b.js("window.__cells = null; map.getSource('heatmap').getData().then(d => window.__cells = d.features.length)")
        b.wait_for('window.__cells !== null', 5)
        cells = b.js('window.__cells')
        b.screenshot(f'{key}-heatmap-{metric}')
        r.check(f'{key}: heatmap {metric}', (cells or 0) > 30, b.js("document.getElementById('heat-info').textContent"), needs='3D BAG')
    b.js("(() => { const s = document.getElementById('heat-metric'); s.value = ''; s.dispatchEvent(new Event('change')); })()")
    # Walking rings with what lies within them, then cycling.
    b.js("(() => { const c = document.getElementById('walk-show'); c.checked = true; c.dispatchEvent(new Event('change')); })()")
    ok = b.wait_for("document.querySelectorAll('#walk-counts dt').length === 3 && document.querySelectorAll('.walk-label').length === 3", 60)
    walk = b.js("document.querySelector('#walk-counts dd').textContent")
    b.js("document.getElementById('walk-speed-fietsen').click()")
    bike = b.wait_for("document.querySelector('.walk-label')?.textContent.includes('fietsen') && document.querySelector('#walk-counts dt').textContent.includes('fietsen')", 60)
    r.check(f'{key}: loop- en fietsafstand in Analyse', ok and bike, walk)
    b.js("document.getElementById('walk-speed-lopen').click(); (() => { const c = document.getElementById('walk-show'); c.checked = false; c.dispatchEvent(new Event('change')); })()")
    b.js("document.getElementById('tab-lagen').click(); document.getElementById('controls-toggle').click()")


def test_report(b, r, key):
    r.check(f'{key}: adres geladen', b.js("document.getElementById('r-address').textContent"))
    for section in ('heritage-section', 'years-section', 'env-section', 'cbs-section'):
        r.check(f'{key}: {section} zichtbaar', not b.js(f"document.getElementById('{section}').hidden"),
                needs='3D BAG' if section == 'years-section' else None)
    r.check(f'{key}: bomen geteld', b.js("document.getElementById('r-bomen').textContent") not in ('–', 'niet beschikbaar'),
            b.js("document.getElementById('r-bomen').textContent"))
    # Sidebar: sections folded with a one-line summary each.
    b.pump(1)
    sums = b.js("[...document.querySelectorAll('details.section:not([hidden])')].map(d => d.dataset.key + ': ' + d.querySelector('.sum').textContent)")
    empty = [s for s in sums if s.endswith(': ')]
    r.check(f'{key}: samenvattingen in de zijbalk', sums and not empty, '; '.join(sums)[:220] if not empty else f'leeg: {empty}', needs='3D BAG')
    cmp = b.js("[...document.querySelectorAll('#cbs .cmp')].map(e => e.textContent)")
    r.check(f'{key}: buurt vergeleken met gemeente en NL', len(cmp) >= 8 and all('NL' in c or 'gemeente' in c for c in cmp), (cmp or ['geen'])[0])
    b.wait_for("!document.getElementById('amenities-section').hidden", 60)
    near = b.js("[...document.querySelectorAll('#amenities dd')].filter(d => d.dataset.v !== '–').length")
    summary = b.js("document.getElementById('sum-voorzieningen').textContent")
    kinds = b.js('AMENITIES.length')
    sport = b.js("['sporthal', 'zwembad', 'sportveld'].filter(k => amenities.found.find(a => a.key === k)?.nearest).length")
    r.check(f'{key}: voorzieningen in de buurt', near >= 5 and sport >= 1, f'{near} van {kinds} soorten, {sport} van 3 sport, {summary}')
    # Opening the section shows the walking circles around the address, closing it removes them.
    b.js("document.getElementById('amenities-section').open = true")
    b.pump(1)
    b.js("window.__rings = null; map.getSource('loopafstand').getData().then(d => window.__rings = d.features.length)")
    b.wait_for('window.__rings !== null', 5)
    rings = b.js('window.__rings')
    labels = b.js("document.querySelectorAll('.walk-label').length")
    b.js("document.getElementById('amenities-section').open = false")
    b.pump(0.5)
    gone = b.js("document.querySelectorAll('.walk-label').length")
    r.check(f'{key}: loopafstand op de kaart', rings == 3 and labels == 3 and gone == 0, f'{rings} cirkels, {labels} labels')
    b.js("document.getElementById('toggle-sections').click()")
    r.check(f'{key}: alles openklappen', b.js("[...document.querySelectorAll('details.section')].every(d => d.open)"))
    b.js("document.getElementById('toggle-sections').click()")
    # The address info folds aside (it slides, so wait for it) and comes back with the tab on the map's edge.
    width = b.js("document.getElementById('map').clientWidth")
    b.js("document.getElementById('panel-hide').click()")
    b.pump(0.8)
    hidden = b.js("document.getElementById('panel').inert && document.getElementById('panel').getBoundingClientRect().right <= 1")
    wider = b.js("document.getElementById('map').clientWidth")
    b.js("document.getElementById('panel-toggle').click()")
    b.pump(0.8)
    r.check(f'{key}: adresinfo inklappen en uitklappen',
            hidden and wider > width and b.js("!document.getElementById('panel').inert && document.getElementById('panel').getBoundingClientRect().left === 0"), f'kaart {width} → {wider} px')


def test_water_rises(b, r, key, scenario):
    b.js("map.jumpTo({center: [current.lon, current.lat], zoom: 16.8, pitch: 0, bearing: 0})")
    b.pump(2)
    base = b.js(COUNT_WATER_PIXELS)
    if not choose_scenario(b, scenario) or not b.js('!!water'):
        r.check(f'{key}: {scenario} geladen', False, b.js("document.getElementById('flood-info').textContent"))
        return
    samples = []
    for _ in range(9):
        b.pump(1.0)
        samples.append((int(b.js("document.getElementById('flood-level').value")), b.js(COUNT_WATER_PIXELS) - base))
    levels = [s[0] for s in samples]
    pixels = [s[1] for s in samples]
    r.check(f'{key}: {scenario} schuif loopt op naar de piek', levels[0] < 100 and levels[-1] == 100, f'schuif {levels}')
    r.check(f'{key}: {scenario} water groeit in beeld', pixels[-1] > pixels[0] + 1000, f'pixels {pixels[0]} → {pixels[-1]}')


def test_3d(b, r, key, with_night=True):
    b.js("document.getElementById('view3d').click()")
    r.check(f'{key}: 3D-scène geladen', b.wait_for('sceneFeatures.length > 0 && !!three.scene', 120),
            f"{b.js('sceneFeatures.length')} delen, {b.js('detailById.size')} met dakvorm")
    r.check(f'{key}: bomen in 3D', b.wait_for('trees.heightsFor === current', 90), f"{b.js('trees.list.length')} bomen")
    if b.js('canals.list.length'):
        t0 = b.js('waterUniforms.uTime.value'); b.pump(1)
        r.check(f'{key}: levend water in 3D', b.js('!!three.canals') and b.js('waterUniforms.uTime.value') > t0, f"{b.js('canals.list.length')} waterdelen")
    if b.js('trees.list.length'):
        b.pump(2)
        meshes = b.js("(() => { let n = 0; three.scene && three.scene.traverse(o => { if (o.isInstancedMesh && o.userData.tree) n++; }); return n; })()")
        r.check(f'{key}: bomen standaard getekend in 3D', meshes == 2, f'{meshes} boomlagen')
    b.js("map.jumpTo({center: [current.lon, current.lat], zoom: 17.8, pitch: 60, bearing: 20})")
    b.pump(3)
    b.screenshot(f'{key}-3d')
    if b.js('!!water'):
        b.js("document.getElementById('flood-play').click()")
        b.pump(2)
        mid = b.js('water3d.group ? water3d.group.scale.z * 100 + Math.round(water3d.group.position.z * 100) : null')
        b.pump(9)
        r.check(f'{key}: 3D-water speelt af', mid is not None and b.js("document.getElementById('flood-level').value") == '100', f'tussenstand {mid}')
    if with_night:
        # Snel: smaller 3D area without detailed roofs; then back to Mooi.
        full = b.js('sceneFeatures.length')
        b.js("document.querySelector('input[name=quality][value=snel]').click()")
        ok = b.wait_for('quality.mode === "snel" && sceneFeatures.length > 0 && sceneFeatures.length < ' + str(full) + ' && detailById.size === 0', 90)
        r.check(f'{key}: kwaliteit Snel', ok, f"{full} → {b.js('sceneFeatures.length')} delen, pixelratio {b.js('map.getPixelRatio()')}")
        b.js("document.querySelector('input[name=quality][value=mooi]').click()")
        r.check(f'{key}: terug naar Mooi', b.wait_for('quality.mode === "mooi" && detailById.size > 0', 90))
    if with_night:
        b.js("document.getElementById('sun-toggle').click()")
        b.js("(() => { document.getElementById('sun-date').value = '2027-01-15'; document.getElementById('sun-date').dispatchEvent(new Event('input')); const t = document.getElementById('sun-time'); t.value = 840; t.dispatchEvent(new Event('input')); })()")
        b.pump(4)
        bare = b.js("(() => { let r = false; three.scene.traverse(o => { if (o.isInstancedMesh && o.userData.tree && o.material.transparent && !o.castShadow) r = true; }); return r; })()")
        r.check(f'{key}: bomen kaal in de winter', b.js("treeSeason() === 'winter'") and bare)
        b.screenshot(f'{key}-winter')
        b.js("(() => { document.getElementById('sun-date').value = '2026-06-21'; const t = document.getElementById('sun-time'); t.value = 1380; t.dispatchEvent(new Event('input')); })()")
        b.pump(3)
        r.check(f'{key}: nacht met verlichte ramen', b.js('nightFactor() === 1 && three.windows && three.windows.mesh.visible'),
                f"{b.js('three.windows ? three.windows.threshold.length : 0')} ramen")
        b.screenshot(f'{key}-nacht')
    b.js("document.getElementById('view3d').click()")
    b.pump(2)
    r.check(f'{key}: 3D uit zet zon uit', b.js('!is3D && !sun.on'))
    if b.js('floodPanel.open'):
        b.js("document.getElementById('flood-close').click()")
        b.pump(1)
        r.check(f'{key}: overstroming sluiten wist het water', b.js("document.getElementById('flood').hidden && !water && !waterScenario"))


def test_tools(b, r, key):
    b.js("map.jumpTo({center: [current.lon, current.lat], zoom: 18, pitch: 0, bearing: 0})")
    b.pump(2)
    left, top = b.js("(() => { const r = map.getCanvas().getBoundingClientRect(); return [r.left, r.top]; })()")
    b.js("document.getElementById('measure-dist').click()")
    for x, y in ((300, 300), (500, 300)):
        for t in ('mouseMoved', 'mousePressed', 'mouseReleased'):
            b.send('Input.dispatchMouseEvent', {'type': t, 'x': left + x, 'y': top + y, 'button': 'left', 'clickCount': 1})
        b.pump(0.3)
    b.send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13})
    b.pump(0.5)
    r.check(f'{key}: afstand meten', b.js("document.getElementById('measure-result').textContent").startswith('Afstand'),
            b.js("document.getElementById('measure-result').textContent"))
    b.js("document.getElementById('measure-clear').click()")
    b.js("(() => { const s = document.getElementById('env-layer'); s.value = 'geluid'; s.dispatchEvent(new Event('change')); })()")
    r.check(f'{key}: layer met legenda', b.wait_for("!!map.getLayer('env-layer') && document.getElementById('env-legend-img').naturalWidth > 0", 30))
    b.js("document.getElementById('rain-live-toggle').click()")
    ok = b.wait_for("radar.frames.length > 0 && !!map.getLayer('radar-0') && document.getElementById('rain-now').textContent !== ''", 40)
    first = b.js("document.getElementById('radar-time').textContent")
    b.pump(2.5)
    r.check(f'{key}: regenradar laadt en speelt af', ok and b.js("document.getElementById('radar-time').textContent") != first,
            f"{b.js('radar.frames.length')} beelden, {first}")
    r.check(f'{key}: regen nu bij het adres', b.js("document.getElementById('rain-now').textContent"), b.js("document.getElementById('rain-now').textContent"))
    r.check(f'{key}: verwachting komende 2 uur', b.wait_for("document.getElementById('forecast-headline').textContent !== ''", 30),
            b.js("document.getElementById('forecast-headline').textContent"))
    # Real rain in view, simulated: pretend the radar shows light rain here.
    b.js("liveRain.level = 2; updateRain()")
    b.pump(1.5)
    r.check(f'{key}: echte regen valt in beeld', b.js("isRaining() && rain.frame !== 0 && rain.streaks.length > 0"), f"{b.js('rain.streaks.length')} strepen")
    b.js("map.jumpTo({zoom: 7.5})")
    b.pump(4)
    b.screenshot(f'{key}-radar')
    b.js("document.getElementById('rain-live-toggle').click()")
    b.pump(1)
    r.check(f'{key}: regenradar stopt', b.js("!radar.active && !map.getLayer('radar-0') && rain.frame === 0"))


def test_flight(b, r, key):
    """First 3D visit to an address: a 10 s orbit from the opposite time of day back to now."""
    b.js("localStorage.removeItem('adresrapport.flown')")
    b.js("document.getElementById('view3d').click()")
    started = b.wait_for('flight.frame !== 0', 60)
    b.pump(4)
    before = b.js("document.getElementById('sun-time').value")
    mid = b.js("[Math.round(map.getBearing()), document.getElementById('sun-time').value, !document.getElementById('sun').hidden]")
    b.wait_for('flight.frame === 0', 20)
    b.pump(1)
    end = b.js("[Math.round(((map.getBearing() % 360) + 360) % 360), Math.round(map.getPitch()), sun.on]")
    r.check(f'{key}: rondvlucht bij eerste keer 3D', started and mid[2] and end == [340, 75, False], f'halverwege {mid}, eind {end}')
    r.check(f'{key}: tijd in 3D zonder Zon', b.js("is3D && !sun.on && !document.getElementById('sun').hidden && document.getElementById('sunhours-row').hidden"))
    b.js("document.getElementById('view3d').click()")
    b.pump(1)
    b.js("document.getElementById('view3d').click()")
    b.pump(2)
    r.check(f'{key}: geen rondvlucht bij tweede keer', b.js('flight.frame === 0'))
    b.js("document.getElementById('view3d').click()")
    b.pump(1)


def test_growth(b, r, key):
    """Groeikaart: opens with the address's municipality and plays to now."""
    b.js("document.getElementById('groei-open').click()")
    ok = b.wait_for("growth.gemeente === 'Amsterdam' && growth.shown === GROWTH_ERAS.length - 1 && growth.timer === 0", 120)
    lit = b.js("""(() => { const c = growth.map.getCanvas(), t = document.createElement('canvas');
        t.width = c.width; t.height = c.height; const g = t.getContext('2d'); g.drawImage(c, 0, 0);
        const d = g.getImageData(0, 0, t.width, t.height).data; let n = 0;
        for (let i = 0; i < d.length; i += 16) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) n++;
        return n; })()""")
    b.wait_for('growth.counts !== null', 60)
    counts = b.js('growth.counts')
    r.check(f'{key}: groeikaart telt panden per periode', counts and len(counts) == 11 and sum(counts) > 100000, f'{sum(counts or [])} panden', needs='3D BAG')
    r.check(f'{key}: groeikaart speelt af voor de gemeente', ok and lit > 2000, f'{lit} gekleurde pixels, titel {b.js("document.getElementById('groei-title').textContent")}', needs='3D BAG')
    b.screenshot(f'{key}-groeikaart')
    b.js("document.getElementById('groei-close').click()")


def test_roof_view(b, r, key):
    """View from the roof: the camera on the ridge, turning on the spot."""
    b.js("document.querySelector('.camera-ctrl .roof').click()")
    ok = b.wait_for('roofView.on', 90)
    b.pump(2)
    alt = b.js('roofView.alt')
    b.screenshot(f'{key}-dak')
    # Dragging to look around ends in a click on the map: that mustn't load another address.
    left, top = b.js("(() => { const r = map.getCanvas().getBoundingClientRect(); return [r.left, r.top]; })()")
    before = b.js('addressId')
    for t, x in (('mouseMoved', 600), ('mousePressed', 600), ('mouseMoved', 640), ('mouseReleased', 640)):
        b.send('Input.dispatchMouseEvent', {'type': t, 'x': left + x, 'y': top + 400, 'button': 'left', 'clickCount': 1})
    b.pump(2)
    r.check(f'{key}: rondkijken laadt geen ander adres', b.js('roofView.on') and b.js('addressId') == before and b.js('pendingLoads') == 0)
    b.js("document.getElementById('roofview-stop').click()")
    b.pump(1)
    r.check(f'{key}: uitzicht vanaf het dak', ok and alt and alt > 5 and b.js('!roofView.on && map.dragPan.isEnabled()'), f'{alt and round(alt)} m hoog')


def test_english(b, r, key, base_url):
    """English: texts translated on screen, while the summaries still read the Dutch originals."""
    b.js("localStorage.setItem('adresrapport.lang', 'en')")
    ok = open_address(b, base_url, ADDRESSES[key][0])
    b.pump(2)
    shown = b.js("""[document.querySelector('#flood-toggle').textContent, document.querySelector('details[data-key=pand] h2').textContent,
        document.getElementById('sum-erfgoed').textContent, document.getElementById('search').querySelector('button').textContent].join(' | ')""")
    b.screenshot(f'{key}-english')
    r.check(f'{key}: Engelse versie', ok and shown.startswith('Flood | Building | National monument') and shown.endswith('Search'), shown)
    b.js("localStorage.removeItem('adresrapport.lang')")


def test_share(b, r, key, base_url):
    """Sets a view, then opens the page's own URL fresh: the view must come back."""
    b.js("document.querySelector('#layers [data-layer=luchtfoto]').click()")
    b.js("(() => { const s = document.getElementById('env-layer'); s.value = 'geluid'; s.dispatchEvent(new Event('change')); })()")
    b.js("document.getElementById('flood-toggle').click()")
    b.js("(() => { const s = document.getElementById('flood-scenario'); s.value = 'ov_grote'; s.dispatchEvent(new Event('change')); })()")
    b.js("document.getElementById('sun-toggle').click()")
    b.wait_for('is3D && sun.on', 30)
    b.js("(() => { document.getElementById('sun-date').value = '2026-03-21'; const t = document.getElementById('sun-time'); t.value = 600; t.dispatchEvent(new Event('input')); })()")
    b.js("map.jumpTo({center: [current.lon + 0.0005, current.lat], zoom: 17.5, pitch: 50, bearing: 30})")
    # The link follows 0.4 s after the last change; with 3D and shadows on the
    # CPU, headless Chrome can take a few seconds per frame, so wait for it.
    b.wait_for("location.search.includes('zon=1') && location.search.includes(',30,50')", 10)
    search = b.js('location.search')
    state = b.js("JSON.stringify({applyingView, addressId: !!addressId, is3D, sun: sun.on, roof: roofView.on})")
    r.check(f'{key}: link onthoudt de weergave', all(t in search for t in ('id=', 'kaart=', 'basis=luchtfoto', 'laag=geluid', '3d=1', 'tijd=2026-03-21,600', 'zon=1', 'water=ov_grote')), f'{search}  {state}')
    b.send('Page.navigate', {'url': base_url + search})
    b.pump(2)
    ok = b.wait_for("typeof addressId !== 'undefined' && addressId && is3D && sun.on && !applyingView", 90)
    state = b.js("""[document.querySelector('#layers [data-layer=luchtfoto]').getAttribute('aria-pressed'), document.getElementById('env-layer').value,
        waterScenario, !document.getElementById('flood').hidden, document.getElementById('sun-date').value, document.getElementById('sun-time').value,
        Math.round(map.getPitch()), Math.round(map.getBearing()), +map.getZoom().toFixed(1)].join(' ')""")
    r.check(f'{key}: gedeelde link zet de weergave terug', ok and state == 'true geluid ov_grote true 2026-03-21 600 50 30 17.5', state)
    b.js("document.getElementById('view3d').click()")
    b.js("document.getElementById('flood-close').click()")
    b.js("document.querySelector('#layers [data-layer=brt]').click()")
    b.js("(() => { const s = document.getElementById('env-layer'); s.value = ''; s.dispatchEvent(new Event('change')); })()")
    b.pump(1)


def test_compare_bulk(b, r, key):
    b.js("document.getElementById('open-compare').click()")
    b.wait_for("typeof keyFigures === 'function' && !document.getElementById('compare').hidden", 30)
    b.js("document.getElementById('cmp-b').value = 'Coolsingel 40 Rotterdam'")
    b.js("document.getElementById('compare-form').requestSubmit()")
    ok = b.wait_for("!document.getElementById('compare-result').hidden", 90)
    rows = b.js("document.querySelectorAll('#compare-table tbody tr').length")
    year = b.js("[...document.querySelectorAll('#compare-table tbody tr')].find(r => r.cells[0].textContent === 'Bouwjaar')?.cells[2].textContent")
    r.check(f'{key}: twee adressen vergelijken', ok and rows > 15 and year == '1920', f'{rows} kenmerken, bouwjaar B {year}')
    b.js("document.querySelector('#compare .dialog-close').click()")
    b.js("document.getElementById('open-bulk').click()")
    b.wait_for("!document.getElementById('bulk').hidden", 30)
    b.js("(() => { const t = document.getElementById('bulk-input'); t.value = 'Damrak 1 Amsterdam\\nxyzxyz nergens 99999\\nCoolsingel 40 Rotterdam'; t.dispatchEvent(new Event('input')); })()")
    b.js("document.getElementById('bulk-run').click()")
    ok = b.wait_for("!document.getElementById('bulk-download').hidden", 120)
    csv = b.js("bulkCsv()") or ''
    lines = csv.strip().split('\r\n')
    r.check(f'{key}: lijst met adressen als CSV', ok and len(lines) == 4 and ';nee;' in lines[2] and 'Coolsingel 40, 3011AD Rotterdam' in lines[3],
            b.js("document.getElementById('bulk-status').textContent"))
    b.js("document.querySelector('#bulk .dialog-close').click()")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default=(ROOT / 'index.html').as_uri(), help='pagina om te testen (standaard het lokale index.html)')
    parser.add_argument('--chrome', default=os.environ.get('CHROME', CHROME), help='pad naar Google Chrome')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    print(f'Test van {args.url}', flush=True)

    probe_sources()
    b = Browser(args.chrome)
    r = Results()
    try:
        print('\nWelkomstscherm', flush=True)
        test_welcome(b, r, args.url)
        for key, (address_id, label) in ADDRESSES.items():
            print(f'\n{label}', flush=True)
            if not r.check(f'{key}: rapport geladen', open_address(b, args.url, address_id)):
                continue
            test_report(b, r, key)
            b.screenshot(f'{key}-rapport')
            needs_3d = '3D BAG' in DOWN
            if key == 'rotterdam':
                if needs_3d: r.skip(f'{key}: rondvlucht en tijd in 3D', '3D BAG')
                else: test_flight(b, r, key)
                test_water_rises(b, r, key, 'regen70')
                test_water_rises(b, r, key, 'ov_kleine')
            if key == 'prinsengracht':
                test_tools(b, r, key)
                test_analysis(b, r, key)
                test_growth(b, r, key)
            if needs_3d: r.skip(f'{key}: 3D-scène, bomen, water en nacht in 3D', '3D BAG')
            else: test_3d(b, r, key, with_night=(key == 'prinsengracht'))
            if key == 'damrak':
                test_english(b, r, key, args.url)
                if needs_3d: r.skip(f'{key}: uitzicht vanaf het dak', '3D BAG')
                else: test_roof_view(b, r, key)
                test_share(b, r, key, args.url)
                test_compare_bulk(b, r, key)
    except (websocket.WebSocketConnectionClosedException, ConnectionError) as err:
        # Headless Chrome renders on the CPU and can occasionally crash under load.
        r.check('testbrowser bleef draaien', False, f'{type(err).__name__}; draai de test opnieuw')
    finally:
        b.close()

    failed = [i for i in r.items if not i[1]]
    print(f'\n{len(r.items) - len(failed)} van {len(r.items)} controles geslaagd.')
    if r.skipped:
        print(f"{len(r.skipped)} controle(s) als waarschuwing, omdat {', '.join(sorted({n for _, n in r.skipped}))} niet reageerde.")
    if b.errors:
        print(f'{len(b.errors)} fout(en) in de console:')
        for e in b.errors[:20]:
            print('  ' + e[:300])
    if b.network:
        print(f'{len(b.network)} netwerkfout(en) bij externe bronnen (waarschuwing):')
        for e in b.network[:10]:
            print('  ' + e[:300])
    print(f'Screenshots: {OUTPUT}')
    sys.exit(1 if failed or b.errors else 0)


if __name__ == '__main__':
    main()
