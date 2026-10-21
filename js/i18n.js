// Language: Dutch (the app's own language) or English. The choice is kept in
// this browser; switching reloads the page. In English every text that
// reaches the screen is translated on the way: fixed texts through a
// dictionary, texts with numbers and names in them through patterns. The
// code itself keeps writing Dutch, so nothing else needs to know.
// Loaded first, before config.js; see index.html for the load order.

const LANG_KEY = 'adresrapport.lang';
let LANG = 'nl';
try { if (localStorage.getItem(LANG_KEY) === 'en') LANG = 'en'; } catch {}
const LOCALE = LANG === 'en' ? 'en-GB' : 'nl-NL';
document.documentElement.lang = LANG;

function setLanguage(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch {}
  location.reload();
}

// ---------- Translating ----------

const I18N_ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const i18nCache = new Map();
// The Dutch original of every translated text node, for code that reads the
// page back (the section summaries), and what we wrote, to skip our own change.
const i18nOriginal = new WeakMap();
const i18nWritten = new WeakMap();

// Whole texts first, then patterns, then single phrases inside longer texts.
function translateText(text) {
  const key = text.trim();
  if (!key || !/[a-zà-ÿ]/i.test(key)) return text;
  if (!i18nCache.has(key)) {
    let out = EN_TEXT[key];
    if (out == null) {
      out = key;
      for (const [re, rep] of EN_PATTERNS) out = out.replace(re, rep);
      for (const [re, en] of EN_PHRASE_RES) out = out.replace(re, en);
    }
    if (i18nCache.size > 5000) i18nCache.clear();
    i18nCache.set(key, out);
  }
  return text.replace(key, i18nCache.get(key));
}

function translateTextNode(node) {
  const p = node.parentElement;
  if (!p || p.closest('script, style, [translate="no"]')) return;
  if (i18nWritten.get(node) === node.nodeValue) return;
  const original = node.nodeValue;
  const t = translateText(original);
  i18nOriginal.set(node, original);
  if (t !== original) {
    i18nWritten.set(node, t);
    node.nodeValue = t;
  }
}

function translateAttrs(el) {
  for (const a of I18N_ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const t = translateText(v);
      if (t !== v) el.setAttribute(a, t);
    }
  }
}

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) { translateTextNode(node); return; }
  if (node.nodeType !== Node.ELEMENT_NODE || node.closest('[translate="no"]')) return;
  translateAttrs(node);
  if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
    else translateAttrs(n);
  }
}

// The text of an element as the code wrote it, in Dutch, whatever is shown.
function nlText(el) {
  if (!el) return '';
  if (LANG !== 'en') return el.textContent;
  let out = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out += i18nWritten.get(n) === n.nodeValue ? i18nOriginal.get(n) : n.nodeValue;
  }
  return out;
}

// ---------- English ----------

// Whole texts, as they appear on screen (trimmed).
const EN_TEXT = {
  // Page, title bar and settings
  'Uitleg': 'About', 'Donkere modus': 'Dark mode', 'Lichte modus': 'Light mode', 'Donker / licht': 'Dark / light',
  'Instellingen': 'Settings', 'Print / PDF': 'Print / PDF', 'Printen of opslaan als pdf': 'Print or save as PDF',
  'Adresinfo verbergen': 'Hide address info', 'Adresinfo inklappen': 'Collapse address info', 'Adresinfo uitklappen': 'Expand address info', 'Adresinfo in- of uitklappen': 'Collapse or expand address info', 'Adresinfo': 'Address info', 'Rapport in- of uitklappen': 'Expand or collapse the report',
  'Kwaliteit van de kaart': 'Map quality', 'Automatisch': 'Automatic', 'Mooi': 'Detailed', 'Snel': 'Fast',
  '(Mooi, en Snel als het hapert)': '(Detailed, and Fast when it stutters)',
  '(kleiner 3D-gebied, geen dakvormen, minder regen)': '(smaller 3D area, no roof shapes, less rain)',
  'Nu: Mooi.': 'Now: Detailed.', 'Nu: Snel.': 'Now: Fast.',
  'De kaart haperde, dus de weergave staat nu op Snel.': 'The map was stuttering, so the display is now set to Fast.',
  'Toch Mooi': 'Detailed anyway', 'Melding sluiten': 'Close message', 'Gegevens laden': 'Loading data', 'Taal': 'Language',
  // Search
  'Bijv. Damrak 1 Amsterdam': 'E.g. Damrak 1 Amsterdam', 'Bijv. Coolsingel 40 Rotterdam': 'E.g. Coolsingel 40 Rotterdam',
  'Zoek': 'Search', 'Of klik op de kaart om het dichtstbijzijnde adres op te halen.': 'Or click the map to fetch the nearest address.',
  'Twee adressen vergelijken': 'Compare two addresses', 'Lijst met adressen ophalen': 'Fetch a list of addresses',
  'Recent gezocht': 'Recent searches', 'Zoeken…': 'Searching…', 'Adres ophalen…': 'Fetching address…',
  'Adres zoeken bij klikpunt…': 'Looking for the address at this point…', 'Geen adres gevonden.': 'No address found.',
  'Geen adres gevonden bij dit punt.': 'No address found at this point.', 'Adres niet gevonden.': 'Address not found.',
  'BAG-gegevens ophalen…': 'Fetching BAG data…', 'Verblijfsobject niet gevonden in BAG.': 'Unit not found in the BAG.',
  'Geen pand gekoppeld aan dit adres.': 'No building linked to this address.',
  'Dit adres is een lig- of standplaats; er is geen pand met bouwjaar.': 'This address is a mooring or pitch; there is no building with a construction year.',
  // Welcome
  'Welkom bij Adresverkenner': 'Welcome to Adresverkenner',
  'Alles over een Nederlands adres op één plek: het gebouw, de grond eronder, de buurt en wat er gebeurt bij hevige regen of een overstroming. Gemaakt met open data van onder meer het Kadaster, het CBS en de Klimaateffectatlas.':
    'Everything about a Dutch address in one place: the building, the ground beneath it, the neighbourhood and what happens in heavy rain or a flood. Made with open data from the Kadaster, Statistics Netherlands (CBS) and the Climate Impact Atlas, among others.',
  'Of probeer:': 'Or try:', 'Naar de kaart': 'To the map', 'Sluiten': 'Close',
  'Rapport per adres': 'Report per address',
  'Bouwjaar, oppervlakte, hoogte, perceel, monumenten, klimaatrisico\'s, voorzieningen en buurtcijfers van het CBS. Ook te printen als pdf.':
    'Construction year, floor area, height, parcel, monuments, climate risks, amenities and neighbourhood figures from Statistics Netherlands. Can be printed as PDF.',
  '3D, dag en nacht': '3D, day and night', 'De omgeving tot 750 m in 3D met dakvormen, bomen en lantaarns. Kies een tijd voor zon en schaduw, of kijk vanaf het dak.':
    'The surroundings up to 750 m in 3D with roof shapes, trees and street lights. Pick a time for sun and shadow, or look out from the roof.',
  'Water en regen': 'Water and rain', 'Zie hoe diep het water komt bij hevige regen of een overstroming, en of het nu regent bij het adres.':
    'See how deep the water gets in heavy rain or a flood, and whether it is raining at the address right now.',
  'Zie een hele gemeente groeien, van vóór 1800 tot nu, periode na periode.': 'Watch a whole municipality grow, from before 1800 until now, period by period.',
  'Kleur panden op bouwjaar of gebruik, toon geluid, lucht of hitte, meet afstanden, analyseer een gebied en deel de kaart.':
    'Colour buildings by construction year or use, show noise, air or heat, measure distances, analyse an area and share the map.',
  'Vergelijken en lijsten': 'Compare and lists', 'Zet twee adressen naast elkaar, of haal tot 200 adressen tegelijk op als CSV voor Excel.':
    'Put two addresses side by side, or fetch up to 200 addresses at once as a CSV for Excel.',
  'Tip: klik ook gewoon op de kaart om het dichtstbijzijnde adres op te halen. Alle knoppen voor de kaart staan in de werkbalk linksboven; thema, taal en kwaliteit kun je later altijd wijzigen. De waterkaarten zijn modelscenario\'s: ze geven een indicatie, geen voorspelling voor een specifiek adres.':
    'Tip: you can also just click the map to fetch the nearest address. All map buttons are in the toolbar at the top left; you can always change the theme, language and quality later. The water maps are model scenarios: they give an indication, not a forecast for a specific address.',
  // Report
  'Alles openklappen': 'Expand all', 'Alles dichtklappen': 'Collapse all',
  'Bouwjaar': 'Construction year', 'Oppervlakte': 'Floor area', 'dit verblijfsobject': 'this unit',
  'Pand': 'Building', 'Zonnepanelen (schatting)': 'Solar panels (estimate)', 'Verblijfsobject': 'Unit', 'Perceel': 'Parcel',
  'Erfgoed': 'Heritage', 'Locatie': 'Location', 'Klimaat en omgeving': 'Climate and environment', 'Buurt in cijfers': 'Neighbourhood in figures',
  'Bouwjaren in de omgeving': 'Construction years nearby', 'Verblijfsobjecten in dit pand': 'Units in this building',
  'Voorzieningen in de buurt': 'Amenities nearby',
  'Pand-ID': 'Building ID', 'Status': 'Status', 'Gebruiksdoel': 'Use', 'Gebruiksdoelen': 'Uses', 'Verblijfsobjecten': 'Units',
  'Totale opp.': 'Total area', 'Grondvlak': 'Footprint', 'Hoogte': 'Height', 'Bouwlagen': 'Storeys', 'Daktype': 'Roof type',
  'Volume': 'Volume', 'Maaiveld': 'Ground level', 'VBO-ID': 'Unit ID', 'Kadastraal': 'Cadastral', 'Perceelgrootte': 'Parcel size',
  'Bebouwd': 'Built on', 'Rijksmonument': 'National monument', 'Beschermd gezicht': 'Protected townscape', 'Rijksmonumenten': 'National monuments',
  'Postcode': 'Postcode', 'Buurt': 'Neighbourhood', 'Wijk': 'District', 'Gemeente': 'Municipality', 'Provincie': 'Province',
  'Coördinaten': 'Coordinates', 'Bomen': 'Trees', 'Bekijk in BAG Viewer ↗': 'View in BAG Viewer ↗', 'register ↗': 'register ↗',
  'Adres': 'Address', 'Oppervlakte (m²)': 'Floor area (m²)', 'Nee': 'No', 'niet beschikbaar': 'not available', 'berekenen…': 'calculating…',
  'Geen rijksmonument': 'Not a national monument', 'n.v.t. (geen pand)': 'n/a (no building)',
  'Bron: BAG, BRK en Locatieserver via PDOK; hoogtes uit 3D BAG (TU Delft / 3DGI). BAG kent oppervlakte per verblijfsobject, niet per pand; de totale oppervlakte is de som van alle verblijfsobjecten in het pand. Grondvlak is berekend uit de pandcontour. Hoogte is de typische dakhoogte (70e percentiel) boven maaiveld.':
    'Source: BAG, BRK and Locatieserver via PDOK; heights from 3D BAG (TU Delft / 3DGI). The BAG records floor area per unit, not per building; the total is the sum of all units in the building. The footprint is calculated from the building outline. Height is the typical roof height (70th percentile) above ground level.',
  'Bron: Rijksdienst voor het Cultureel Erfgoed. Gemeentelijke monumenten staan niet in een landelijke open dataset; vraag die na bij de gemeente.':
    'Source: Cultural Heritage Agency of the Netherlands. Municipal monuments are not in a national open dataset; ask the municipality.',
  'Bronnen: Klimaateffectatlas (overstroming, bodemdaling, paalrot, hitte) en RIVM Atlas Leefomgeving (geluid, luchtkwaliteit). Waarden gelden voor de locatie of de buurt, niet specifiek voor dit pand.':
    'Sources: Climate Impact Atlas (flooding, subsidence, pile rot, heat) and RIVM Atlas Leefomgeving (noise, air quality). Values apply to the location or the neighbourhood, not to this building specifically.',
  'Bron: CBS Wijken en Buurten. Per kengetal het meest recente jaar met een gepubliceerde waarde; ontbrekende waarden zijn geheim of nog niet beschikbaar. Daaronder dezelfde waarde voor de hele gemeente en voor Nederland (CBS Kerncijfers wijken en buurten 2024).':
    'Source: CBS Wijken en Buurten. For each figure the most recent year with a published value; missing values are confidential or not yet available. Below each, the same value for the whole municipality and for the Netherlands (CBS key figures 2024).',
  'Hemelsbrede afstand tot de dichtstbijzijnde, met het aantal in de buurt. Loopminuten bij 4,8 km/u in een rechte lijn; via de straat is het meestal wat verder. Zolang dit blok open is, staan ze op de kaart. Bron: © OpenStreetMap-bijdragers (ODbL), via de kaarttegels van OpenFreeMap; niet alles is even volledig ingetekend.':
    'Straight-line distance to the nearest one, with the number nearby. Walking minutes at 4.8 km/h in a straight line; via the streets it is usually a little further. While this section is open, they are shown on the map. Source: © OpenStreetMap contributors (ODbL), via OpenFreeMap’s map tiles; not everything is mapped equally completely.',
  'Indicatie uit de 3D BAG-dakvlakken (oriëntatie en helling), met ~950 kWh per kWp per jaar op een ideaal dak en panelen van 420 Wp (1,75 m²). Schaduw van bomen en buren en obstakels op het dak zijn niet meegerekend; bekijk schaduw met de knop Zon. Bij een pand met meerdere woningen gaat het om het hele dak.':
    'An indication from the 3D BAG roof planes (orientation and pitch), with ~950 kWh per kWp per year on an ideal roof and 420 Wp panels (1.75 m²). Shade from trees, neighbours and obstacles on the roof is not included; see shadows with the Sun button. For a building with several homes this is the whole roof.',
  'Toon de daken op de kaart (3D)': 'Show the roofs on the map (3D)', 'Geschikte dakvlakken': 'Suitable roof planes', 'Panelen': 'Panels',
  'Opbrengst': 'Yield', 'Dakvlak': 'Roof plane', 'Geschiktheid': 'Suitability', 'Toon als tabel': 'Show as table', 'Periode': 'Period', 'Panden': 'Buildings',
  'Dit dak is weinig geschikt voor zonnepanelen: de dakvlakken zijn klein of liggen ongunstig.': 'This roof is not very suitable for solar panels: the roof planes are small or badly oriented.',
  'Zeer geschikt': 'Very suitable', 'Geschikt': 'Suitable', 'Matig': 'Moderate', 'Ongeschikt': 'Unsuitable', 'Plat': 'Flat',
  'Bevolking': 'Population', 'Inwoners': 'Residents', 'Huishoudens': 'Households', 'Gem. huishoudgrootte': 'Avg. household size',
  'Inwoners per km²': 'Residents per km²', '65 jaar en ouder': '65 and older', 'Wonen': 'Housing', 'Woningen': 'Homes',
  'Gem. WOZ-waarde': 'Avg. property value (WOZ)', 'Koopwoningen': 'Owner-occupied', 'Huurwoningen': 'Rented', 'Corporatiewoningen': 'Social housing',
  'Gebouwd vóór 2000': 'Built before 2000', 'Inkomen': 'Income', 'Gem. inkomen per inwoner': 'Avg. income per resident',
  'Voorzieningen (gem. afstand)': 'Amenities (avg. distance)', 'Grote supermarkt': 'Large supermarket', 'Basisschool': 'Primary school',
  'Huisarts': 'GP', 'Treinstation': 'Train station',
  'Overstroming en wateroverlast': 'Flooding and waterlogging', 'Kans op > 50 cm water': 'Chance of > 50 cm of water',
  'Hevige regen, 70 mm in 1 uur': 'Heavy rain, 70 mm in 1 hour', 'Bodem en fundering': 'Soil and foundations',
  'Bodembeweging': 'Ground movement', 'Risico paalrot (buurt)': 'Pile rot risk (neighbourhood)', 'Hitte': 'Heat',
  'Stedelijk hitte-eiland': 'Urban heat island', 'Geluid en lucht': 'Noise and air', 'Geluid, alle bronnen': 'Noise, all sources',
  'Fijnstof PM2,5 (2024)': 'Particulate matter PM2.5 (2024)', 'droog': 'dry', 'droog binnen 15 m': 'dry within 15 m', 'verwaarloosbaar': 'negligible',
  'Supermarkt': 'Supermarket', 'Bus- of tramhalte': 'Bus or tram stop', 'Station (trein of metro)': 'Station (train or metro)', 'School': 'School',
  'Apotheek': 'Pharmacy', 'Speeltuin': 'Playground', 'Park': 'Park', 'Laadpaal': 'Charging point', 'Sporthal of sportcentrum': 'Sports hall or centre', 'Zwembad': 'Swimming pool', 'Sportveld': 'Sports field', 'Loopafstand op de kaart (5, 10 en 15 minuten)': 'Walking distance on the map (5, 10 and 15 minutes)', 'dit pand': 'this building',
  'Adres ligt in 3 panden; bouwjaar van het eerste getoond.': 'The address lies in 3 buildings; the first one’s year is shown.',
  'onbekend': 'unknown', 'Dak': 'Roof', 'schuin': 'pitched', 'plat': 'flat', 'meerdere platte vlakken': 'several flat planes',
  // Map buttons and panels
  'Kaart': 'Map', 'Luchtfoto': 'Aerial photo', 'Achtergrondkaart': 'Base map', 'Weergave': 'View', 'Zon': 'Sun', 'Regen': 'Rain',
  'Overstroming': 'Flood', 'Groeikaart': 'Growth map', 'Lagen en gereedschap': 'Layers and tools', 'Kaart en weergave': 'Map and view',
  'Kleur panden, layers, meten, opslaan en delen': 'Colour buildings, layers, measure, save and share',
  'Toon panden in 3D rond het adres': 'Show buildings around the address in 3D', 'Schaduwen en zonuren (zet 3D aan)': 'Shadows and sun hours (turns on 3D)',
  'Live regenradar, regen nu en de komende 2 uur': 'Live rain radar, rain now and the next 2 hours',
  'Overstroming of hevige regen simuleren rond het adres': 'Simulate a flood or heavy rain around the address',
  'Groeikaart: zie een hele gemeente groeien, periode na periode': 'Growth map: watch a whole municipality grow, period by period',
  'Tijd': 'Time', 'Tijd, zon en schaduw': 'Time, sun and shadow', 'Speel een dag af': 'Play a day', 'Tijdstip': 'Time of day',
  'Zonuren op deze dag': 'Sun hours on this day', 'Zonuren verbergen': 'Hide sun hours', 'Hoogtemodel ophalen…': 'Fetching the elevation model…',
  'Meten': 'Measure', 'Afstand': 'Distance', 'Meting wissen': 'Clear measurement', 'Kaart opslaan als afbeelding': 'Save map as image',
  'Klik punten aan op de kaart. Dubbelklik of Enter om af te ronden, Esc om te stoppen.': 'Click points on the map. Double-click or Enter to finish, Esc to stop.',
  'Klaar. Kies opnieuw om een nieuwe meting te starten.': 'Done. Choose again to start a new measurement.',
  'Link naar deze weergave delen': 'Share a link to this view',
  'De link onthoudt het adres en de weergave: kaarthoek, 3D, zon, water, layer en regen': 'The link remembers the address and the view: camera, 3D, sun, water, layer and rain',
  'Link gekopieerd. Wie hem opent, ziet deze kaart met dezelfde weergave.': 'Link copied. Whoever opens it sees this map with the same view.',
  'Layers': 'Layers', 'Geen': 'None', 'Kleur panden op': 'Colour buildings by', 'Gebruik': 'Use',
  'Klik een categorie aan of uit om panden te filteren.': 'Click a category on or off to filter buildings.',
  'Kleurt de dakvlakken binnen 60 m van het adres in 3D, naar oriëntatie en helling.': 'Colours the roof planes within 60 m of the address in 3D, by orientation and pitch.',
  'Zoom verder in om de panden te zien.': 'Zoom in further to see the buildings.',
  'Zonnepotentie daken (3D)': 'Solar potential of roofs (3D)',
  'vóór 1900': 'before 1900', '2010 en later': '2010 and later', 'Pand in gebruik': 'Building in use', 'Pand in gebruik (niet ingemeten)': 'Building in use (not surveyed)',
  'Vergund of in aanbouw': 'Permitted or under construction', 'Buiten gebruik': 'Out of use', 'Sloopvergunning of gesloopt': 'Demolition permit or demolished',
  'Verbouwing': 'Renovation', 'In gebruik': 'In use', 'Wonen + andere functie': 'Housing + other use', 'Gemengd, zonder wonen': 'Mixed, no housing',
  'Kantoor': 'Office', 'Winkel': 'Shop', 'Bijeenkomst': 'Assembly', 'Onderwijs': 'Education', 'Gezondheidszorg': 'Healthcare',
  'Industrie': 'Industry', 'Logies': 'Lodging', 'Sport': 'Sport', 'Overig': 'Other', 'Geen (bijgebouw)': 'None (outbuilding)',
  'Geen dakdata (verder dan 60 m)': 'No roof data (beyond 60 m)',
  'Draaien en kantelen': 'Rotate and tilt',
  'Draaien en kantelen. Sleep langs de rand om te draaien, in het midden omhoog of omlaag om te kantelen, tik voor het noorden boven. Pijltjestoetsen werken ook.':
    'Rotate and tilt. Drag along the edge to rotate, in the middle up or down to tilt, tap for north up. Arrow keys work too.',
  'Rondvlucht om het adres': 'Fly around the address', 'Rondkijken stoppen': 'Stop looking around', 'Lagen': 'Layers', 'Gereedschap': 'Tools', 'Analyse': 'Analysis', 'Gebied analyseren': 'Analyse an area', 'Gebied': 'Area', 'Straal rond adres': 'Radius around address', 'Straal rond het adres': 'Radius around the address', 'Zelf tekenen': 'Draw an area', 'Klik punten op de kaart. Dubbelklik, of klik het eerste punt opnieuw, om het gebied te sluiten; Esc stopt.': 'Click points on the map. Double-click, or click the first point again, to close the area; Esc stops.', 'Analyseer gebied': 'Analyse area', 'Dichtheid als heatmap': 'Density as a heatmap', 'Bebouwingsdichtheid': 'Building density', 'Bouwjaar (mediaan per vak)': 'Construction year (median per cell)', 'Hoogte (gemiddeld per vak)': 'Height (average per cell)', 'Kleuren als bij Kleur panden op bouwjaar (tab Lagen).': 'Colours as in Colour buildings by construction year (Layers tab).', 'Loopafstand': 'Walking distance', 'Cirkels voor 5, 10 en 15 minuten': 'Circles for 5, 10 and 15 minutes', 'Snelheid': 'Speed', 'Lopen': 'Walk', 'Fietsen': 'Cycle', 'In een rechte lijn, lopen 4,8 km/u en fietsen 15 km/u; via de straat is het wat verder.': 'In a straight line, walking 4.8 km/h and cycling 15 km/h; via the streets it is a little further.', 'Oppervlakte gebied': 'Area size', 'Bouwjaar (mediaan)': 'Construction year (median)', 'Bouwperiode': 'Construction period', 'Gebied analyseren…': 'Analysing area…', 'Kies eerst een adres.': 'Choose an address first.', 'Heatmap berekenen…': 'Calculating heatmap…', 'Een gebied heeft minstens drie punten nodig. Kies Zelf tekenen om opnieuw te beginnen.': 'An area needs at least three points. Choose Draw an area to start again.', 'Let op: het gebied heeft heel veel panden; niet alle zijn meegeteld.': 'Note: the area has very many buildings; not all were counted.', 'Kleur panden, layers, meten, opslaan, delen en analyse': 'Colour buildings, layers, measure, save, share and analysis',  'Rondkijken stoppen (Esc)': 'Stop looking around (Esc)', 'Thema': 'Theme', 'Licht': 'Light', 'Donker': 'Dark', 'Uitzicht vanaf het dak': 'View from the roof', 'Stoppen': 'Stop',
  'Zoek eerst een adres voor een rondvlucht.': 'First search for an address to fly around.',
  'Zoek eerst een adres voor het uitzicht vanaf het dak.': 'First search for an address for the view from the roof.',
  // Rain
  'Regen nu': 'Rain now', 'Regen sluiten': 'Close rain', 'Radarbeelden pauzeren': 'Pause radar images', 'Radarbeelden afspelen': 'Play radar images',
  'laatste beeld': 'latest image', 'Regen in beeld laten vallen': 'Show the rain falling', 'Komende 2 uur': 'Next 2 hours',
  'Radar: RainViewer, verwachting: Open-Meteo (KNMI-model).': 'Radar: RainViewer, forecast: Open-Meteo (KNMI model).',
  'Radar laden…': 'Loading radar…', 'Kon de regen hier niet aflezen.': 'Couldn’t read the rain here.', 'Verwachting niet beschikbaar.': 'Forecast not available.',
  'Droog de komende 2 uur.': 'Dry for the next 2 hours.', 'Regen de komende 2 uur.': 'Rain for the next 2 hours.',
  'licht': 'light', 'motregen': 'drizzle', 'zwaarder': 'heavier', 'mm': 'mm',
  // Flood
  'Overstroming sluiten': 'Close flood', 'Scenario': 'Scenario', 'Uit': 'Off', 'Hevige regen: 70 mm in 1 uur': 'Heavy rain: 70 mm in 1 hour',
  'Overstroming (van vaak naar zeldzaam)': 'Flood (from frequent to rare)',
  'ca. 1× per 10 jaar (grote kans)': 'about once every 10 years (high chance)', 'ca. 1× per 100 jaar (middelgrote kans)': 'about once every 100 years (medium chance)',
  'ca. 1× per 1.000 jaar (kleine kans)': 'about once every 1,000 years (low chance)', 'ca. 1× per 10.000 jaar (zeer kleine kans)': 'about once every 10,000 years (very low chance)',
  'nog zeldzamer (extreem kleine kans)': 'even rarer (extremely low chance)',
  'Hoe zeldzamer het scenario, hoe extremer de overstroming: een kleinere kans geeft dus meer water, een grotere kans vaak geen.':
    'The rarer the scenario, the more extreme the flood: a smaller chance therefore means more water, a larger chance often none.',
  'Waterstand t.o.v. de piek': 'Water level relative to the peak', 'Waterstand ten opzichte van de piek': 'Water level relative to the peak',
  'Laat het water stijgen tot de piek': 'Let the water rise to the peak', 'piek': 'peak', 'Regendruppels tonen tijdens de bui': 'Show raindrops during the shower',
  'Bekijk de echte regen nu': 'See the real rain now', 'Wat is de piek?': 'What is the peak?',
  'Piek = de hoogste waterstand tijdens en vlak na een bui van 70 mm in één uur. Het model geeft geen tijdsverloop: de schuif laat het water overal naar verhouding opkomen, zoals tijdens een bui.':
    'Peak = the highest water level during and just after a shower of 70 mm in one hour. The model has no timeline: the slider lets the water rise proportionally everywhere, as during a shower.',
  'Piek = de grootste waterdiepte bij een overstroming met deze kans, bijvoorbeeld na een dijkdoorbraak. Niet elke plek bereikt die op hetzelfde moment. Het model geeft geen tijdsverloop: de schuif laat het hele wateroppervlak gelijkmatig zakken, zodat ondiepe plekken eerst droogvallen.':
    'Peak = the greatest water depth in a flood with this chance, for example after a dike breach. Not every spot reaches it at the same moment. The model has no timeline: the slider lowers the whole water surface evenly, so shallow spots fall dry first.',
  'Zoek eerst een adres.': 'First search for an address.', 'Waterdiepte ophalen en berekenen…': 'Fetching and calculating water depth…',
  // Compare and list
  'Adres A': 'Address A', 'Adres B': 'Address B', 'Vergelijk': 'Compare', 'Kenmerk': 'Feature', 'Op de kaart': 'On the map', 'Gegevens ophalen…': 'Fetching data…',
  'Verschillen staan vet; gelijke waarden zijn grijs. Buurtcijfers zijn van het CBS, milieuwaarden gelden voor het adrespunt.':
    'Differences are in bold; equal values are grey. Neighbourhood figures are from Statistics Netherlands; environmental values apply to the address point.',
  'Plak adressen, één per regel (maximaal 200). Per adres komen de kerngegevens in een tabel: gebouw, zonnepanelen, monument, water, milieu en buurt. Download het geheel als CSV voor Excel.':
    'Paste addresses, one per line (up to 200). For each address the key figures go into a table: building, solar panels, monument, water, environment and neighbourhood. Download it all as CSV for Excel.',
  'Adressen': 'Addresses', 'Ophalen': 'Fetch', 'Download CSV': 'Download CSV', 'Ingevoerd': 'Entered', 'niet gevonden': 'not found',
  'Woonplaats': 'Town', 'Status pand': 'Building status', 'Adressen in het pand': 'Addresses in the building', 'Hoogte (m)': 'Height (m)',
  'Opbrengst (kWh per jaar)': 'Yield (kWh per year)', 'Hitte-eiland (°C warmer)': 'Heat island (°C warmer)', 'Geluid (dB Lden)': 'Noise (dB Lden)',
  'Bodembeweging (mm/jaar; − is daling)': 'Ground movement (mm/year; − is subsidence)', 'Buurt: gem. WOZ-waarde (€)': 'Neighbourhood: avg. property value (€)',
  'Buurt: inwoners': 'Neighbourhood: residents', 'Buurt: koopwoningen (%)': 'Neighbourhood: owner-occupied (%)',
  'Buurt: gem. inkomen per inwoner (€)': 'Neighbourhood: avg. income per resident (€)', 'Breedtegraad': 'Latitude', 'Lengtegraad': 'Longitude',
  'Locatieserver-id': 'Locatieserver ID',
  // Groeikaart
  'Groeikaart sluiten': 'Close growth map', 'Gemeente, bijv. Utrecht': 'Municipality, e.g. Utrecht', 'Toon': 'Show', 'Bouwperiodes': 'Construction periods',
  'Afspelen': 'Play', 'Pauzeren': 'Pause', 'Gemeente zoeken…': 'Looking up the municipality…', 'Panden laden…': 'Loading buildings…',
  'Alle panden van nu': 'All of today’s buildings',
  'De panden van nu, gekleurd op bouwjaar. Gesloopte panden ontbreken, en bij oude panden is het bouwjaar vaak een schatting. Klik een pand voor het bouwjaar.':
    'Today’s buildings, coloured by construction year. Demolished buildings are missing, and for old buildings the year is often an estimate. Click a building for its year.',
  'vóór 1800': 'before 1800', '2020 en later': '2020 and later', 'Nu': 'Now',
  // Search for places
  'Straat': 'Street', 'Plaats': 'Place', 'Niet gevonden.': 'Not found.', 'Geen adres of plaats gevonden.': 'No address or place found.',
  'Klik op de kaart om een adres te kiezen.': 'Click the map to choose an address.',
  'Klik op de kaart om een adres te kiezen in deze straat.': 'Click the map to choose an address in this street.',
  'Klik op de kaart om een adres te kiezen bij deze postcode.': 'Click the map to choose an address at this postcode.',
  // Map controls (MapLibre)
  'Zoom in': 'Zoom in', 'Zoom out': 'Zoom out', 'Map marker': 'Map marker', 'Kaart van het adres': 'Map of the address'
};

// [regular expression, replacement] for texts with numbers or names in them.
// Numbers are already in English notation (en-GB) when they reach the screen.
const I18N_NUM = '([\\d.,]+)';
const EN_PATTERNS = [
  [`^Dit gebied is ${I18N_NUM} km²; analyseer maximaal ${I18N_NUM} km² tegelijk\\.$`, 'This area is $1 km²; analyse at most $2 km² at a time.'],
  [`^${I18N_NUM} vakken van ${I18N_NUM} × ${I18N_NUM} m met panden, tot ${I18N_NUM} m van het adres\\.$`, '$1 cells of $2 × $3 m with buildings, up to $4 m from the address.'],
  [`^${I18N_NUM} jaar oud$`, '$1 years old'],
  [`^Zon ${I18N_NUM}° hoog, uit het `, 'Sun $1° high, from the '],
  ['from the noordoosten', 'from the northeast'], ['from the zuidoosten', 'from the southeast'], ['from the zuidwesten', 'from the southwest'],
  ['from the noordwesten', 'from the northwest'], ['from the noorden', 'from the north'], ['from the oosten', 'from the east'],
  ['from the zuiden', 'from the south'], ['from the westen', 'from the west'],
  [' · op (\\d\\d:\\d\\d), onder (\\d\\d:\\d\\d)', ' · sunrise $1, sunset $2'],
  ['^(Noord|Noordoost|Oost|Zuidoost|Zuid|Zuidwest|West|Noordwest), (\\d+)°$', (m, d, a) => `${EN_DIRECTIONS[d]}, ${a}°`],
  [`^Ongeveer ${I18N_NUM} panelen, samen ~${I18N_NUM} kWh per jaar: het stroomverbruik van ~${I18N_NUM} huishoudens\\.$`, 'About $1 panels, together ~$2 kWh per year: the electricity use of ~$3 households.'],
  [`^Dit pand \\((\\d+)\\) is ouder dan ${I18N_NUM}% van de ${I18N_NUM} panden binnen ${I18N_NUM} m\\. Middelste bouwjaar: (\\d+)\\.$`, 'This building ($1) is older than $2% of the $3 buildings within $4 m. Median construction year: $5.'],
  [`^${I18N_NUM} panden binnen ${I18N_NUM} m\\. Middelste bouwjaar: (\\d+)\\.$`, '$1 buildings within $2 m. Median construction year: $3.'],
  [`^Staafdiagram: aantal panden per bouwperiode binnen ${I18N_NUM} m, dit pand valt in (.+)\\.$`, 'Bar chart: number of buildings per construction period within $1 m; this building falls in $2.'],
  [`^Staafdiagram: verwachte regen per kwartier, `, 'Bar chart: expected rain per quarter hour, '],
  [`^Bron: 3D BAG\\. ${I18N_NUM} panden zonder bekend bouwjaar zijn weggelaten\\.$`, 'Source: 3D BAG. $1 buildings without a known construction year are left out.'],
  [`^Bron: 3D BAG\\.$`, 'Source: 3D BAG.'],
  [`^(Hevige regen|Overstroming): ${I18N_NUM}% van het gebied tot ${I18N_NUM} m nat, max\\. ${I18N_NUM} m diep\\. `, '$1: $2% of the area up to $3 m wet, max. $4 m deep. '],
  [`Verfijnd met het AHN-hoogtemodel: ${I18N_NUM} m tot ${I18N_NUM} m van het adres, ${I18N_NUM} m daarbuiten\\.`, 'Refined with the AHN elevation model: $1 m up to $2 m from the address, $3 m beyond.'],
  [`${I18N_NUM} m detail tot ${I18N_NUM} m van het adres, ${I18N_NUM} m daarbuiten\\.`, '$1 m detail up to $2 m from the address, $3 m beyond.'],
  [`^Geen water van betekenis binnen ${I18N_NUM} m van het adres\\.$`, 'No significant water within $1 m of the address.'],
  [`^Maaiveld bij dit adres: ${I18N_NUM} m (boven|onder) NAP`, 'Ground level at this address: $1 m $2 NAP (Amsterdam datum)'],
  [`^Maaiveld bij dit adres: op NAP-hoogte`, 'Ground level at this address: at NAP level (Amsterdam datum)'],
  [`^Uitzicht vanaf het dak, ${I18N_NUM} m hoog\\. Sleep om rond te kijken\\.$`, 'View from the roof, $1 m up. Drag to look around.'],
  [`^Uren zon op (.+), rekening houdend met gebouwen en bomen\\. Beweeg over de kaart voor de waarde per plek\\.$`, 'Hours of sun on $1, taking buildings and trees into account. Move over the map for the value at each spot.'],
  [`^${I18N_NUM} uur zon$`, '$1 hours of sun'], [`^${I18N_NUM} uur$`, '$1 hours'],
  [`^${I18N_NUM} mm per jaar (daling|stijging)$`, '$1 mm per year $2'],
  [`^tot ${I18N_NUM} cm water binnen 15 m$`, 'up to $1 cm of water within 15 m'],
  [`^ouder dan ${I18N_NUM}% van de omgeving$`, 'older than $1% of the surroundings'],
  [`^Panden van nu die er in (\\d+) al stonden`, 'Today’s buildings that already stood in $1'],
  [`^Toon panden tot en met `, 'Show buildings up to '],
  [`^Zo groeide (.+)$`, 'How $1 grew'],
  [`^Geen adres gevonden voor (.+)\\.$`, 'No address found for $1.'],
  [`^${I18N_NUM} van ${I18N_NUM} opgehaald…$`, '$1 of $2 fetched…'],
  [`^Regen verwacht vanaf (.+)\\.$`, 'Rain expected from $1.'], [`^Regen tot ongeveer (.+)\\.$`, 'Rain until about $1.'],
  [`^Het regent `, 'It’s raining '], [`^Droog (bij dit adres|midden op de kaart)`, 'Dry $1'],
  [`^Gegevens laden… \\(${I18N_NUM} (verzoek|verzoeken)\\)$`, 'Loading data… ($1 requests)'],
  [`^Schaduw berekenen… `, 'Calculating shadows… '],
  [`^${I18N_NUM} van ${I18N_NUM} \\(`, '$1 of $2 ('],
  [`^${I18N_NUM} (adressen|adres)$`, '$1 addresses'],
  [`^geen binnen `, 'none within '],
  [`^≈ ${I18N_NUM} \\(geschat, 3 m per laag\\)$`, '≈ $1 (estimated, 3 m per storey)'],
  [`^Nu: (Snel|Mooi), automatisch gekozen omdat Mooi haperde\\.$`, 'Now: Fast, chosen automatically because Detailed was stuttering.']
].map(([re, rep]) => [new RegExp(re), rep]);

const EN_DIRECTIONS = { Noord: 'North', Noordoost: 'Northeast', Oost: 'East', Zuidoost: 'Southeast', Zuid: 'South', Zuidwest: 'Southwest', West: 'West', Noordwest: 'Northwest' };

// Phrases replaced inside any text that isn't in the lists above. Whole words
// only, so street and place names stay as they are.
const EN_PHRASES = [
  ['Buurt in cijfers', 'Neighbourhood in figures'], ['bij dit adres', 'at this address'], ['midden op de kaart', 'in the middle of the map'],
  ['Bij het adres', 'At the address'], ['diepste punt', 'deepest point'], ['De zon is onder', 'The sun is down'],
  ['bomen', 'trees'], ['droog', 'dry'], ['1\\.000', '1,000'], ['10\\.000', '10,000'], ['herfst', 'autumn'], ['lente', 'spring'], ['zomer', 'summer'], ['winter \\(kaal\\)', 'winter (bare)'],
  ['dak schuin', 'pitched roof'], ['dak plat', 'flat roof'], ['m hoog', 'm tall'], ['verblijfsobjecten', 'units'], ['verblijfsobject', 'unit'],
  ['door dit pand', 'covered by this building'], ['bebouwd', 'built on'], ['inwoners', 'residents'], ['gemeente', 'municipality'],
  ['bus- of tramhalte', 'bus or tram stop'], ['station \\(trein of metro\\)', 'station (train or metro)'], ['huisarts', 'GP'], ['apotheek', 'pharmacy'],
  ['geen voorzieningen', 'no amenities'], ['min fietsen', 'min by bike'], ['Binnen', 'Within'], ['vóór', 'before'], ['vanaf', 'from'], ['mediaan', 'median'],
  ['hoogste', 'highest'], ['van het gebied', 'of the area'], ['Analyse lukte niet', 'Analysis failed'], ['Heatmap niet beschikbaar', 'Heatmap not available'],
  ['niet beschikbaar', 'not available'],
  ['supermarkt', 'supermarket'], ['halte', 'stop'], ['laadpaal', 'charging point'], ['speeltuin', 'playground'],
  ['min lopen', 'min walk'], ['sporthal of sportcentrum', 'sports hall or centre'], ['zwembad', 'swimming pool'], ['sportveld', 'sports field'],
  ['binnen', 'within'], ['van panden', 'of buildings'], ['panden', 'buildings'], ['panelen', 'panels'], ['kWh per jaar', 'kWh per year'], ['per jaar', 'per year'],
  ['\\(nok', '(ridge'], ['t\\.o\\.v\\. NAP', 'relative to NAP (Amsterdam datum)'], ['Ja, nr\\.', 'Yes, no.'], ['ja, nr\\.', 'yes, no.'], ['nee', 'no'], ['Woonhuis', 'House'], ['Horeca', 'Hospitality'],
  ['Geen rijksmonument', 'Not a national monument'], ['Rijksmonument', 'National monument'], ['beschermd gezicht', 'protected townscape'], ['droog bij overstromingen', 'dry in floods'],
  ['water alleen bij extreem zeldzame overstroming', 'water only in an extremely rare flood'], ['water bij overstroming', 'water in a flood'],
  ['ca\\. 1× per', 'about once every'], ['jaar', 'years'], ['dB geluid', 'dB noise'], ['nog zeldzamer', 'even rarer'],
  ['gemiddeld', 'on average'], ['WHO-advies', 'WHO guideline'], ['zeer goed', 'very good'], ['goed', 'good'], ['redelijk', 'fair'],
  ['matig', 'moderate'], ['tamelijk slecht', 'rather poor'], ['zeer slecht', 'very poor'], ['slecht', 'poor'],
  ['zeer laag', 'very low'], ['laag', 'low'], ['zeer hoog', 'very high'], ['hoog', 'high'], ['van panden', 'of buildings'],
  ['daling', 'subsidence'], ['stijging', 'rise'], ['boven', 'above'],
  ['extreem klein', 'extremely small'], ['zeer klein', 'very small'], ['middelgroot', 'medium'], ['klein', 'small'], ['groot', 'large'],
  ['onder het adrespunt', 'under the address point'], ['onder zeeniveau', 'below sea level'],
  ['lichte regen', 'light rain'], ['matige regen', 'moderate rain'], ['zware regen', 'heavy rain'], ['motregen', 'drizzle'],
  ['laatste', 'latest'], ['mm per uur', 'mm per hour'], ['mm/u', 'mm/h'],
  ['woonfunctie', 'residential'], ['bijeenkomstfunctie', 'assembly'], ['celfunctie', 'detention'], ['gezondheidszorgfunctie', 'healthcare'],
  ['industriefunctie', 'industrial'], ['kantoorfunctie', 'office'], ['logiesfunctie', 'lodging'], ['onderwijsfunctie', 'education'],
  ['sportfunctie', 'sport'], ['winkelfunctie', 'retail'], ['overige gebruiksfunctie', 'other use'],
  ['Pand in gebruik', 'Building in use'], ['Verblijfsobject in gebruik', 'Unit in use'], ['Pand gesloopt', 'Building demolished'],
  ['Bouwvergunning verleend', 'Building permit granted'], ['Bouw gestart', 'Construction started'], ['Pand buiten gebruik', 'Building out of use'],
  ['Sloopvergunning verleend', 'Demolition permit granted'], ['Verbouwing pand', 'Building renovation'],
  ['Gestopt', 'Stopped'], ['adressen opgehaald', 'addresses fetched'], ['adres opgehaald', 'address fetched'],
  ['niet gevonden \\(rood in de tabel\\)', 'not found (red in the table)'], ['alleen de eerste', 'only the first'], ['worden opgehaald', 'will be fetched'],
  ['Alle panden van nu', 'All of today’s buildings'], ['vóór', 'before'], ['en later', 'and later'],
  ['niet beschikbaar', 'not available'], ['Waterdiepte', 'Water depth'], ['Zonuren', 'Sun hours'],
  ['Afbeelding opslaan mislukt', 'Saving the image failed'], ['Kopiëren lukte niet\\. De link', 'Copying didn’t work. The link'],
  ['Onderdeel kon niet laden', 'Part couldn’t load'], ['Fout', 'Error'], ['Voorzieningen', 'Amenities'], ['3D-weergave', '3D view'],
  ['3D-details konden niet laden', '3D details couldn’t load'], ['geschat', 'estimated'], ['Overstroming', 'Flood'], ['Hevige regen', 'Heavy rain'],
  ['Supermarkt', 'Supermarket'], ['Bus- of tramhalte', 'Bus or tram stop'], ['Station \\(trein of metro\\)', 'Station (train or metro)'],
  ['Huisarts', 'GP'], ['Apotheek', 'Pharmacy'], ['Speeltuin', 'Playground'], ['Laadpaal', 'Charging point'],
  ['Legenda', 'Legend'], ['Kaartgegevens', 'Map data'], ['Panden', 'Buildings'], ['Luchtfoto', 'Aerial photo'],
  ['Boomhoogte', 'Tree height'], ['Groenkaart', 'Green map'], ['Bodemdaling', 'Subsidence'], ['Stikstofdioxide', 'Nitrogen dioxide'],
  ['Risico paalrot \\(per buurt\\)', 'Pile rot risk (per neighbourhood)'], ['Geluid, alle bronnen', 'Noise, all sources'],
  ['Overstromingskans', 'Flood probability'], ['Hittekaart', 'Heat map'], ['gevoelstemperatuur', 'felt temperature']
];
const EN_PHRASE_RES = EN_PHRASES.map(([nl, en]) => [new RegExp(`(?<![\\p{L}])${nl}(?![\\p{L}])`, 'gu'), en]);

// ---------- Start ----------

if (LANG === 'en') {
  translateNode(document.body);
  document.title = translateText(document.title);
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') {
        const v = r.target.getAttribute(r.attributeName);
        if (v) {
          const t = translateText(v);
          if (t !== v) r.target.setAttribute(r.attributeName, t);
        }
      } else for (const n of r.addedNodes) translateNode(n);
    }
    const t = translateText(document.title);
    if (t !== document.title) document.title = t;
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
}
