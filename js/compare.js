// Key figures per address, without the map: for comparing two addresses side
// by side and for a whole list at once (bulk), downloadable as CSV.
// Loaded as a classic script; see index.html for the load order.

// ---------- Key figures ----------

// A number gets `dec` decimals (`plain`: without thousands separator); text is
// shown as is. `compare: false` keeps a figure out of the comparison (CSV only).
const FIGURES = [
  { key: 'adres', label: 'Adres' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'woonplaats', label: 'Woonplaats' },
  { key: 'gemeente', label: 'Gemeente' },
  { key: 'buurt', label: 'Buurt' },
  { key: 'bouwjaar', label: 'Bouwjaar', dec: 0, plain: true },
  { key: 'oppervlakte', label: 'Oppervlakte (m²)', dec: 0 },
  { key: 'gebruiksdoel', label: 'Gebruiksdoel' },
  { key: 'pandstatus', label: 'Status pand' },
  { key: 'objecten', label: 'Adressen in het pand', dec: 0 },
  { key: 'hoogte', label: 'Hoogte (m)', dec: 1 },
  { key: 'dak', label: 'Dak' },
  { key: 'panelen', label: 'Zonnepanelen (schatting)', dec: 0 },
  { key: 'kwh', label: 'Opbrengst (kWh per jaar)', dec: 0 },
  { key: 'monument', label: 'Rijksmonument' },
  { key: 'water50', label: 'Kans op > 50 cm water' },
  { key: 'hitte', label: 'Hitte-eiland (°C warmer)', dec: 1 },
  { key: 'geluid', label: 'Geluid (dB Lden)', dec: 0 },
  { key: 'no2', label: 'NO₂ (µg/m³)', dec: 1 },
  { key: 'bodem', label: 'Bodembeweging (mm/jaar; − is daling)', dec: 1 },
  { key: 'woz', label: 'Buurt: gem. WOZ-waarde (€)', dec: 0 },
  { key: 'inwoners', label: 'Buurt: inwoners', dec: 0 },
  { key: 'koop', label: 'Buurt: koopwoningen (%)', dec: 0 },
  { key: 'inkomen', label: 'Buurt: gem. inkomen per inwoner (€)', dec: 0 },
  { key: 'lat', label: 'Breedtegraad', dec: 6, plain: true, compare: false },
  { key: 'lon', label: 'Lengtegraad', dec: 6, plain: true, compare: false },
  { key: 'id', label: 'Locatieserver-id', compare: false }
];

const envByLabel = label => ENV_GROUPS.flatMap(([, list]) => list).find(it => it.label === label);
const ENV_FIGURES = [
  ['water50', 'Kans op > 50 cm water', v => FLOOD_CLASSES[v] || 'verwaarloosbaar'],
  ['hitte', 'Stedelijk hitte-eiland'],
  ['geluid', 'Geluid, alle bronnen', v => v > 0 ? v : null],
  ['no2', 'NO₂ (2024)'],
  ['bodem', 'Bodembeweging']
].map(([key, label, value = v => v]) => ({ key, item: envByLabel(label), value }));

const CBS_FIGURES = [['woz', 'gemiddelde_woningwaarde', v => v * 1000], ['inwoners', 'aantal_inwoners'],
  ['koop', 'percentage_koopwoningen'], ['inkomen', 'gemiddeld_inkomen_per_inwoner', v => v * 1000]];

// Resolves a Locatieserver id or typed address to { query, found, ...figures }.
// Every part that fails just stays empty; only an unknown address is an error.
async function keyFigures(query) {
  let id = /^adr-[0-9a-f]+$/.test(query) ? query : null;
  if (!id) {
    const s = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(query)}&fq=type:adres&rows=1&fl=id`);
    id = s.response.docs[0]?.id;
    if (!id) return { query, found: false };
  }
  const doc = (await getJSON(`${LOCATIESERVER}/lookup?id=${encodeURIComponent(id)}&fl=${LOOKUP_FIELDS}`)).response.docs[0];
  if (!doc) return { query, found: false };
  const { lon, lat } = parsePoint(doc.centroide_ll);
  const rd = parsePoint(doc.centroide_rd);
  const f = {
    query, found: true, id, lat, lon,
    adres: doc.weergavenaam, postcode: doc.postcode, woonplaats: doc.woonplaatsnaam,
    gemeente: doc.gemeentenaam, buurt: doc.buurtnaam
  };

  const building = (async () => {
    // Only a verblijfsobject (type 01) lies in a pand; see loadAddress.
    if (doc.adresseerbaarobject_id?.slice(4, 6) !== '01') return;
    const vbo = (await getJSON(`${BAG}/collections/verblijfsobject/items?f=json&identificatie=${doc.adresseerbaarobject_id}`)).features[0];
    if (!vbo) return;
    const vp = vbo.properties;
    Object.assign(f, { oppervlakte: vp.oppervlakte, gebruiksdoel: formatDoel(vp.gebruiksdoel) });
    const panden = await Promise.all((vp['pand.href'] || []).map(h => getJSON(withJson(h))));
    if (!panden.length) return;
    const pp = panden[0].properties;
    Object.assign(f, { bouwjaar: pp.bouwjaar, pandstatus: pp.status, objecten: pp.aantal_verblijfsobjecten });
    await Promise.all([
      getJSON(`${BAG3D}/NL.IMBAG.Pand.${pp.identificatie}`).then(item => {
        const a = heightsFrom3DBag(item.feature.CityObjects)[pp.identificatie];
        if (!a) return;
        Object.assign(f, { hoogte: heightAboveGround(a), dak: ROOF_TYPES[a.b3_dak_type] ?? a.b3_dak_type });
        const own = parseLod22({ metadata: item.metadata, features: [item.feature] }).find(([pid]) => pid === pp.identificatie);
        if (!own) return;
        const planes = roofPlanes(own[1]).filter(p => p.panels > 0);
        f.panelen = planes.reduce((s, p) => s + p.panels, 0);
        f.kwh = Math.round(planes.reduce((s, p) => s + p.kwh, 0) / 100) * 100;
      }).catch(() => {}),
      rceWfs(RCE_WFS, 'openbaar:rijksmonumentpunten', [rd.lon - 100, rd.lat - 100, rd.lon + 100, rd.lat + 100]).then(points => {
        const own = points.features.filter(m => panden.some(p => pointInGeometry(m.geometry.coordinates, p.geometry)));
        f.monument = own.length ? `ja, nr. ${own.map(m => m.properties.rijksmonument_nummer).join(', ')}` : 'nee';
      }).catch(() => {})
    ]);
  })().catch(() => {});

  const environment = Promise.all(ENV_FIGURES.map(({ key, item, value }) =>
    featureInfo(item.base, item.layer, rd.lon, rd.lat)
      .then(p => {
        const v = p?.[item.key || 'GRAY_INDEX'];
        // -9999 is the rasters' no-data value.
        if (typeof v === 'number' && v > -9999) f[key] = value(v);
      })
      .catch(() => {})));

  const buurt = fetchBuurtYears(lon, lat).then(years => {
    for (const [key, stat, value = v => v] of CBS_FIGURES) {
      const hit = buurtStat(years, stat);
      if (hit) f[key] = value(hit.value);
    }
  }).catch(() => {});

  await Promise.all([building, environment, buurt]);
  return f;
}

const fmtFigure = (fig, v) => {
  if (v == null || v === '') return '–';
  if (typeof v !== 'number') return String(v);
  if (fig.plain) return v.toFixed(fig.dec ?? 0);
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: fig.dec ?? 0, maximumFractionDigits: fig.dec ?? 0 }).format(v);
};

// ---------- Dialogs ----------

function openDialog(id, focusId) {
  closeWelcome();
  $(id).hidden = false;
  $(id).dataset.returnFocus = document.activeElement?.id || '';
  $(focusId).focus();
}

function closeDialog(id) {
  if ($(id).hidden) return;
  $(id).hidden = true;
  const back = $($(id).dataset.returnFocus);
  back?.focus?.();
}

for (const id of ['compare', 'bulk']) {
  $(id).querySelector('.dialog-close').addEventListener('click', () => closeDialog(id));
  $(id).addEventListener('click', e => { if (e.target === $(id)) closeDialog(id); });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDialog('compare'); closeDialog('bulk'); }
});

// Suggestions under an address field, via the browser's own list.
function attachSuggest(input, list) {
  let timer, abort;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    delete input.dataset.id;
    if (q.length < 3) return;
    timer = setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        const data = await getJSON(`${LOCATIESERVER}/suggest?q=${encodeURIComponent(q)}&fq=type:adres&rows=8&fl=weergavenaam`, abort.signal);
        list.replaceChildren(...data.response.docs.map(d => Object.assign(document.createElement('option'), { value: d.weergavenaam })));
      } catch (err) {
        if (err.name !== 'AbortError') console.error(err);
      }
    }, 200);
  });
}

// ---------- Compare two addresses ----------

attachSuggest($('cmp-a'), $('cmp-a-list'));
attachSuggest($('cmp-b'), $('cmp-b-list'));

// Opened from the link under the search box (loaded on first use, see app.js).
function openCompare() {
  // Start from the address on screen.
  if (addressId && !$('cmp-a').value) {
    $('cmp-a').value = $('q').value;
    $('cmp-a').dataset.id = addressId;
  }
  openDialog('compare', $('cmp-a').value ? 'cmp-b' : 'cmp-a');
}

let compareRun = 0;
$('compare-form').addEventListener('submit', async e => {
  e.preventDefault();
  const mine = ++compareRun;
  const inputs = [$('cmp-a'), $('cmp-b')];
  $('compare-status').textContent = 'Gegevens ophalen…';
  $('compare-status').className = 'hint';
  $('compare-result').hidden = true;
  try {
    const [a, b] = await Promise.all(inputs.map(i => keyFigures(i.dataset.id || i.value.trim())));
    if (mine !== compareRun) return;
    const missing = [a, b].map((f, i) => f.found ? null : `"${inputs[i].value}"`).filter(Boolean);
    if (missing.length) {
      $('compare-status').textContent = `Geen adres gevonden voor ${missing.join(' en ')}.`;
      $('compare-status').className = 'hint error';
      return;
    }
    renderCompare(a, b);
    $('compare-status').textContent = '';
  } catch (err) {
    if (mine !== compareRun) return;
    console.error(err);
    $('compare-status').textContent = `Fout: ${err.message}`;
    $('compare-status').className = 'hint error';
  }
});

function renderCompare(a, b) {
  const head = $('compare-table').tHead.rows[0];
  for (const [i, f] of [a, b].entries()) {
    const th = head.cells[i + 1];
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = 'Op de kaart';
    open.addEventListener('click', () => { closeDialog('compare'); loadAddress(f.id); });
    th.replaceChildren(f.adres.split(',')[0], document.createElement('br'), open);
  }
  $('compare-table').tBodies[0].replaceChildren(...FIGURES.filter(fig => fig.compare !== false && fig.key !== 'adres').map(fig => {
    const tr = document.createElement('tr');
    const va = fmtFigure(fig, a[fig.key]), vb = fmtFigure(fig, b[fig.key]);
    // Rows that differ stand out; equal rows recede.
    tr.className = va === vb ? 'same' : '';
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = fig.label;
    tr.append(th, ...[va, vb].map(v => {
      const td = document.createElement('td');
      td.textContent = v;
      if (typeof a[fig.key] === 'number' || typeof b[fig.key] === 'number') td.className = 'num';
      return td;
    }));
    return tr;
  }));
  $('compare-result').hidden = false;
}

// ---------- Bulk: a whole list at once ----------

const BULK_MAX = 200;
// Addresses fetched at the same time; each one makes about fifteen requests.
const BULK_PARALLEL = 4;
const BULK_PREVIEW = ['adres', 'bouwjaar', 'oppervlakte', 'gebruiksdoel', 'monument', 'water50', 'woz'];
const bulk = { rows: [], run: 0 };

function openBulk() { openDialog('bulk', 'bulk-input'); }

function bulkLines() {
  return [...new Set($('bulk-input').value.split(/\r?\n/).map(l => l.replace(/[;\t]+/g, ' ').trim()).filter(Boolean))];
}

$('bulk-input').addEventListener('input', () => {
  const n = bulkLines().length;
  $('bulk-count').textContent = n ? `${nf.format(n)} ${n === 1 ? 'adres' : 'adressen'}${n > BULK_MAX ? `; alleen de eerste ${BULK_MAX} worden opgehaald` : ''}` : '';
});

$('bulk-run').addEventListener('click', async () => {
  const lines = bulkLines().slice(0, BULK_MAX);
  if (!lines.length) { $('bulk-input').focus(); return; }
  const mine = ++bulk.run;
  bulk.rows = new Array(lines.length);
  let next = 0, done = 0;
  $('bulk-run').hidden = true;
  $('bulk-stop').hidden = false;
  $('bulk-download').hidden = true;
  $('bulk-progress').hidden = false;
  $('bulk-progress').max = lines.length;
  $('bulk-progress').value = 0;
  renderBulkTable();
  const progress = () => {
    $('bulk-progress').value = done;
    $('bulk-status').textContent = `${nf.format(done)} van ${nf.format(lines.length)} opgehaald…`;
  };
  progress();
  const worker = async () => {
    while (next < lines.length && mine === bulk.run) {
      const i = next++;
      bulk.rows[i] = await keyFigures(lines[i]).catch(err => ({ query: lines[i], found: false, error: err.message }));
      if (mine !== bulk.run) return;
      done++;
      progress();
      renderBulkTable();
    }
  };
  await Promise.all(Array.from({ length: BULK_PARALLEL }, worker));
  if (mine !== bulk.run) return;
  finishBulk(false);
});

function finishBulk(stopped) {
  const rows = bulk.rows.filter(Boolean);
  const missing = rows.filter(r => !r.found).length;
  $('bulk-run').hidden = false;
  $('bulk-stop').hidden = true;
  $('bulk-progress').hidden = true;
  $('bulk-download').hidden = !rows.length;
  $('bulk-status').textContent = `${stopped ? 'Gestopt: ' : ''}${nf.format(rows.length - missing)} ${rows.length - missing === 1 ? 'adres' : 'adressen'} opgehaald` +
    (missing ? `, ${nf.format(missing)} niet gevonden (rood in de tabel).` : '.');
}

$('bulk-stop').addEventListener('click', () => {
  bulk.run++;
  finishBulk(true);
});

function renderBulkTable() {
  const figs = BULK_PREVIEW.map(k => FIGURES.find(f => f.key === k));
  const head = document.createElement('tr');
  head.append(...['Ingevoerd', ...figs.map(f => f.label)].map(t => Object.assign(document.createElement('th'), { scope: 'col', textContent: t })));
  $('bulk-table').tHead.replaceChildren(head);
  $('bulk-table').tBodies[0].replaceChildren(...bulk.rows.filter(Boolean).map(r => {
    const tr = document.createElement('tr');
    if (!r.found) tr.className = 'missing';
    const cells = [r.query, ...figs.map(f => r.found ? fmtFigure(f, r[f.key]) : (f.key === 'adres' ? 'niet gevonden' : ''))];
    tr.append(...cells.map((t, i) => Object.assign(document.createElement('td'), {
      textContent: t, className: i > 0 && typeof r[figs[i - 1].key] === 'number' ? 'num' : ''
    })));
    return tr;
  }));
  $('bulk-table').hidden = false;
}

// CSV for Dutch Excel: semicolons, decimal commas and a BOM so accents survive.
function bulkCsv() {
  const cell = v => {
    const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[";\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = ['Ingevoerd', 'Gevonden', ...FIGURES.map(f => f.label)];
  const lines = bulk.rows.filter(Boolean).map(r =>
    [r.query, r.found ? 'ja' : 'nee', ...FIGURES.map(f => {
      const v = r[f.key];
      return typeof v === 'number' && f.dec != null ? Number(v.toFixed(f.dec)) : v;
    })].map(cell).join(';'));
  return '﻿' + [head.map(cell).join(';'), ...lines].join('\r\n');
}

$('bulk-download').addEventListener('click', () => {
  const blob = new Blob([bulkCsv()], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `adresverkenner-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
