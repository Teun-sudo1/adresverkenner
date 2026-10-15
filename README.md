# Adresverkenner

Alles over een Nederlands adres op één kaart: het gebouw, de grond eronder, de buurt, en wat er gebeurt bij hevige regen of een overstroming. Alles draait in de browser op open data van onder meer het Kadaster, het CBS, de Rijksdienst voor het Cultureel Erfgoed, het RIVM en de Klimaateffectatlas. Er is geen eigen server en er zijn geen API-sleutels nodig.

**Probeer het:** https://teun-sudo1.github.io/adresverkenner/

## Wat kun je ermee

- **Rapport per adres:** bouwjaar, oppervlakte, hoogte, dakvorm, perceel, monumentstatus, buurtcijfers van het CBS, klimaat- en milieurisico's, en een schatting van de zonnepanelen-opbrengst. Ook te printen als pdf.
- **3D:** de omgeving tot 250 m in 3D, met echte dakvormen dichtbij, bomen, en een speelse cartoonstijl.
- **Zon en schaduw:** schaduwen op elk tijdstip, een zonuren-kaart per dag, nachtweergave met verlichte ramen, en bomen per seizoen.
- **Water:** hevige regen en overstromingen (van eens per 10 tot eens per 10.000 jaar) die oplopen naar hun piek, met regendruppels, plus de actuele regenradar.
- **Kaartlagen en filters:** panden kleuren op bouwjaar, status, gebruiksdoel of zonnepotentie, omgevingslagen (geluid, lucht, hitte, groen), meten, en de kaart opslaan als afbeelding.
- **Overal bruikbaar:** licht en donker thema, telefoonweergave, en deelbare links per adres.

## Starten

Open `index.html` in een browser. Dat werkt ook direct vanaf schijf (`file://`). Houd de hele map bij elkaar: de pagina laadt `css/` en `js/` mee.

De live versie draait op GitHub Pages: elke push naar `main` staat na een minuut of twee online. Er is geen build-stap.

Lokaal serveren kan ook:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Opbouw

`index.html` bevat alleen de pagina-opbouw. De scripts zijn gewone (geen module-)scripts die één globale scope delen, zodat openen vanaf schijf werkt: ES-modules worden op `file://` geblokkeerd. De laadvolgorde staat onderaan `index.html` en doet ertoe: code die tijdens het laden draait, mag alleen dingen uit eerdere bestanden gebruiken. Binnen functies (die later draaien) mag alles.

| Bestand | Inhoud |
|---|---|
| `js/config.js` | Instellingen, bron-URL's, scenario's, de laadindicator (`track`) en de responscache (`cachedFetch`) |
| `js/map.js` | MapLibre-kaart, achtergrondlagen, basislagen en de hover-popup |
| `js/buildings.js` | 3D-weergave, kleuring en filters van panden, three.js-laag (cartoon, dakvormen LoD 2.2, zon, schaduw, nachtramen), licht/donker-thema |
| `js/report.js` | Adres zoeken, het rapport (BAG, perceel, erfgoed, bouwjaarprofiel, klimaat, CBS) |
| `js/tiff.js` | Minimale GeoTIFF-lezer voor de hoogte- en waterrasters |
| `js/water.js` | Waterdiepteberekening (draait in een Web Worker) en de besturing van de watersimulatie |
| `js/rain.js` | Regendruppels en kringen tijdens de bui |
| `js/solar.js` | Zonnepanelen-schatting per dakvlak |
| `js/sunhours.js` | Zonuren-kaart (schaduw over het AHN-oppervlaktemodel) |
| `js/layers.js` | Omgevingslagen (WMS) met legenda |
| `js/radar.js` | Live regenradar (RainViewer), afgelopen 2 uur als lus |
| `js/trees.js` | Bomen uit de BGT, in 2D en 3D, met seizoenen |
| `js/tools.js` | Meten en kaart opslaan als afbeelding |
| `js/app.js` | Print, telefoonweergave, welkomstscherm, deellinks en opstart |
| `css/app.css` | Alle opmaak, met kleurvariabelen voor licht en donker |

### De water-worker

`computeWater` draait in een Web Worker die wordt samengesteld uit de eigen functies van de pagina (`WORKER_FUNCTIONS` in `js/water.js`). Functies in die lijst mogen daarom alleen hun argumenten en andere functies uit die lijst gebruiken, plus `TIFF_TYPE_SIZE`, `WATER_LEVELS`, d3 en fflate. Een nieuwe hulpfunctie die de worker nodig heeft, moet in `WORKER_FUNCTIONS` erbij.

## Databronnen

Alle bronnen worden direct vanuit de browser opgevraagd en moeten dus CORS toestaan. Dat geldt voor elke bron hieronder (gecontroleerd in oktober 2026).

| Bron | Gebruikt voor | Waar |
|---|---|---|
| PDOK Locatieserver | Adres zoeken, suggesties, klikken op de kaart | `report.js` |
| PDOK BAG (OGC API en vectortegels) | Panden, verblijfsobjecten, bouwjaar, status, gebruiksdoel | `report.js`, `map.js`, `buildings.js` |
| 3D BAG (OGC API en WFS) | Hoogtes, dakvormen LoD 2.2, bouwjaren in de omgeving | `buildings.js`, `report.js` |
| PDOK BRK Kadastrale kaart | Percelen | `report.js` |
| PDOK CBS Wijken en Buurten | Buurtcijfers (meest recente jaar met waarde, per kengetal) | `report.js`, `CBS_YEARS` in `config.js` |
| PDOK AHN (WCS) | Maaiveld (DTM) en oppervlak (DSM): waterverfijning, zonuren, boomhoogtes | `water.js`, `sunhours.js`, `trees.js` |
| PDOK BGT | Bomen (vegetatieobject, type boom) | `trees.js` |
| PDOK BRT-achtergrondkaart en luchtfoto | Achtergrondkaarten | `map.js` |
| RCE (openbaar WFS en geovoorziening) | Rijksmonumenten en beschermde stads- en dorpsgezichten | `report.js` |
| Klimaateffectatlas (WMS, WCS, opslag) | Overstromingsdieptes, overstromingskans, bodemdaling, paalrot, hitte, de hevige-regen-COG | `config.js`, `report.js`, `layers.js` |
| RIVM Atlas Leefomgeving (WMS) | Geluid, NO₂, fijnstof, boomhoogte, groen | `report.js`, `layers.js` |
| RainViewer (API en tegels) | Live regenradar, afgelopen 2 uur in stappen van 10 minuten | `radar.js` |

Bibliotheken (vastgepinde versies van CDN): MapLibre GL 4.7.1, fflate 0.8.2, d3-array 3.2.4 en d3-contour 4.0.2 (alleen in de worker), three.js 0.160.0 (pas geladen bij 3D).

## Onderhoud

### Gedateerde laagnamen

De Klimaateffectatlas en het RIVM zetten een datum in hun laagnamen, zoals `_20260128` of `rivm_nsl_20260401_…`. Bij een nieuwe versie verdwijnt de oude naam vaak, en dan toont de app `–` of geen kaartlaag. Controleer dan de GetCapabilities van de dienst en werk de namen bij op deze plekken:

- `WATER_SCENARIOS` in `js/config.js`: overstromingsdieptes (WCS).
- `ENV_GROUPS` in `js/report.js`: de waarden in het rapport.
- `ENV_LAYERS` in `js/layers.js`: de omgevingslagen op de kaart.
- `PLUVIAL_COG` in `js/config.js`: het hevige-regenbestand. De Klimaateffectatlas heeft nieuwe scenario's aangekondigd (90 mm/uur, 155 mm in 2 uur).
- `CBS_YEARS` in `js/config.js`: voeg een nieuw jaar vooraan toe zodra het CBS het publiceert.

### Cache

Antwoorden van GET-verzoeken worden een dag bewaard in de Cache Storage van de browser (`cachedFetch` in `js/config.js`). Bij een netwerkhapering of serverfout probeert `fetchWithRetry` het eenmaal opnieuw; die helper wordt ook in de water-worker gebruikt. De regenradar gaat altijd langs de cache heen, omdat die elke paar minuten verandert. Verandert de vorm van de opgehaalde data, verhoog dan `CACHE_NAME` (bijvoorbeeld naar `adresrapport-v2`), zodat oude antwoorden niet meer gebruikt worden. (De opslagnamen in de browser, zoals `adresrapport.theme`, dateren van vóór de naam Adresverkenner; ze zijn bewust zo gebleven, zodat bestaande instellingen bewaard blijven.) Berekend water wordt per adres en scenario in het geheugen bewaard zolang de pagina open is.

### Testen

`tests/smoke_test.py` start Chrome onzichtbaar en loopt de app door op drie testadressen: rapport, watersimulatie (loopt het water echt op?), 3D, cartoon, zon en nacht, bomen en seizoenen, meten, omgevingslagen en de regenradar. Een fout in de console laat de test falen; een kortstondige storing bij een externe databron telt als waarschuwing. Screenshots komen in `tests/output/` (niet in git).

```sh
pip install websocket-client
python3 tests/smoke_test.py                                               # lokale map
python3 tests/smoke_test.py --url https://teun-sudo1.github.io/adresverkenner/   # live site
```

Een run duurt een paar minuten, omdat alle data live wordt opgehaald. De testadressen:

- Prinsengracht 263, Amsterdam: rijksmonument, dakvormen, bomen, beschermd stadsgezicht.
- Van Heukelomstraat 201, Rotterdam: diep in een polder, veel water in de scenario's.
- Damrak 1, Amsterdam: dichte binnenstad, droog bij de meeste overstromingsscenario's.

Safari is niet automatisch getest. Eerder bleek Safari strenger met het uitpakken van rasters; daarom gebruikt de app fflate in plaats van de ingebouwde `DecompressionStream`.

## Bekende beperkingen

- De watersimulatie toont de piekdiepte uit het model, geen tijdsverloop; de schuif is een benadering.
- Zonnepanelen zijn een schatting zonder schaduw van bomen en buren.
- Bomen zijn een optioneel onderdeel van de BGT; niet elke gemeente houdt ze volledig bij. De BGT kent geen boomsoort, dus alle bomen worden als loofboom getoond (kaal in de winter).
- De regenradar komt van de gratis RainViewer-API: tegels tot zoomniveau 7 (ongeveer 1 km per pixel) en de afgelopen 2 uur, zonder voorspelling.
- Gemeentelijke monumenten, energielabels (EP-Online, API-sleutel nodig) en WOZ-waardes per adres zijn niet als open data beschikbaar.
- three.js tekent buiten MapLibre om. De hover in 3D gebruikt daarom een eigen straal, die een gewoon MapLibre-blok vóór een boom niet ziet.

## Ideeën voor later

- Deellink die ook de weergave onthoudt (3D, zon, scenario, laag).
- Tijdreis met historische luchtfoto's.
- Twee adressen vergelijken; bulkmodus met CSV-export.
