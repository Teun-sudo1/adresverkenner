#!/usr/bin/env python3
"""Smoke test for Adresverkenner.

Starts Chrome headless, drives the app over the DevTools protocol and checks
that the main features work at three test addresses: the report, the water
simulation (does the water actually rise?), 3D, cartoon, sun and night,
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
             '--no-first-run', '--no-default-browser-check', 'about:blank'],
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
            self.errors.append('console.error: ' + ' '.join(str(a.get('value', a.get('description', ''))) for a in m['params']['args']))
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


class Results:
    def __init__(self):
        self.items = []

    def check(self, name, ok, detail=''):
        self.items.append((name, bool(ok), detail))
        print(f"  {'OK  ' if ok else 'FOUT'} {name}{f'  ({detail})' if detail else ''}", flush=True)
        return ok


def open_address(b, base_url, address_id):
    b.send('Page.navigate', {'url': f'{base_url}?id={address_id}'})
    ready = b.wait_for("typeof loadAddress === 'function' && typeof pendingLoads !== 'undefined' "
                       "&& document.getElementById('r-hoogte').textContent !== '–'", 90)
    # Let the slower sections (heritage, years, CBS, environment) arrive too.
    b.wait_for('pendingLoads === 0', 90)
    b.js("setTheme('light', true); localStorage.setItem('adresrapport.welcomeSeen', '1')")
    return ready


def choose_scenario(b, value):
    b.js(f"(() => {{ const s = document.getElementById('flood-scenario'); s.value = '{value}'; s.dispatchEvent(new Event('change')); }})()")
    return b.wait_for("(() => { const t = document.getElementById('flood-info').textContent; return !!water || (t && !t.endsWith('…')); })()", 120)


def test_report(b, r, key):
    r.check(f'{key}: adres geladen', b.js("document.getElementById('r-address').textContent"))
    for section in ('heritage-section', 'years-section', 'env-section', 'cbs-section'):
        r.check(f'{key}: {section} zichtbaar', not b.js(f"document.getElementById('{section}').hidden"))
    r.check(f'{key}: bomen geteld', b.js("document.getElementById('r-bomen').textContent") not in ('–', 'niet beschikbaar'),
            b.js("document.getElementById('r-bomen').textContent"))


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
    b.js("map.jumpTo({center: [current.lon, current.lat], zoom: 17.8, pitch: 60, bearing: 20})")
    b.pump(3)
    b.screenshot(f'{key}-3d')
    if b.js('!!water'):
        b.js("document.getElementById('flood-play').click()")
        b.pump(2)
        mid = b.js('water3d.group ? water3d.group.scale.z * 100 + Math.round(water3d.group.position.z * 100) : null')
        b.pump(9)
        r.check(f'{key}: 3D-water speelt af', mid is not None and b.js("document.getElementById('flood-level').value") == '100', f'tussenstand {mid}')
    b.js("document.getElementById('cartoon').click()")
    r.check(f'{key}: cartoon', b.wait_for("cartoon && !!map.getLayer('three-3d')", 30))
    b.pump(3)
    b.screenshot(f'{key}-cartoon')
    if with_night:
        b.js("document.getElementById('sun-toggle').click()")
        b.js("(() => { document.getElementById('sun-date').value = '2026-06-21'; const t = document.getElementById('sun-time'); t.value = 1380; t.dispatchEvent(new Event('input')); })()")
        b.pump(3)
        r.check(f'{key}: nacht met verlichte ramen', b.js('nightFactor() === 1 && three.windows && three.windows.mesh.visible'),
                f"{b.js('three.windows ? three.windows.threshold.length : 0')} ramen")
        b.screenshot(f'{key}-nacht')
    b.js("document.getElementById('view3d').click()")
    b.pump(2)
    r.check(f'{key}: 3D uit zet cartoon en zon uit', b.js('!is3D && !cartoon && !sun.on'))


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
    r.check(f'{key}: omgevingslaag met legenda', b.wait_for("!!map.getLayer('env-layer') && document.getElementById('env-legend-img').naturalWidth > 0", 30))
    b.js("(() => { const s = document.getElementById('env-layer'); s.value = ''; s.dispatchEvent(new Event('change')); })()")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default=(ROOT / 'index.html').as_uri(), help='pagina om te testen (standaard het lokale index.html)')
    parser.add_argument('--chrome', default=os.environ.get('CHROME', CHROME), help='pad naar Google Chrome')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    print(f'Test van {args.url}', flush=True)

    b = Browser(args.chrome)
    r = Results()
    try:
        for key, (address_id, label) in ADDRESSES.items():
            print(f'\n{label}', flush=True)
            if not r.check(f'{key}: rapport geladen', open_address(b, args.url, address_id)):
                continue
            test_report(b, r, key)
            b.screenshot(f'{key}-rapport')
            if key == 'rotterdam':
                test_water_rises(b, r, key, 'regen70')
                test_water_rises(b, r, key, 'ov_kleine')
            if key == 'prinsengracht':
                test_tools(b, r, key)
            test_3d(b, r, key, with_night=(key == 'prinsengracht'))
    finally:
        b.close()

    failed = [i for i in r.items if not i[1]]
    print(f'\n{len(r.items) - len(failed)} van {len(r.items)} controles geslaagd.')
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
