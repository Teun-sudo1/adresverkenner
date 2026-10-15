# Adresrapport

Een webapp die alles over een Nederlands adres op één kaart zet: het gebouw (BAG, 3D BAG), de grond (BRK), de buurt (CBS), erfgoed (RCE), klimaat- en milieurisico's, zonnepotentie en schaduw, en een watersimulatie voor hevige regen en overstromingen. Alles draait in de browser op open data; er is geen eigen server of API-sleutel.

## Starten

Open `index.html` in een browser. Dat werkt ook direct vanaf schijf (`file://`). Houd de hele map bij elkaar: de pagina laadt `css/` en `js/` mee.

Voor deellinks die anderen kunnen openen, zet je de map op een statische host (bijvoorbeeld GitHub Pages of Netlify). Er is geen build-stap.

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
| `js/trees.js` | Bomen uit de BGT, in 2D en 3D |
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

Antwoorden van GET-verzoeken worden een dag bewaard in de Cache Storage van de browser (`cachedFetch` in `js/config.js`). Verandert de vorm van de opgehaalde data, verhoog dan `CACHE_NAME` (bijvoorbeeld naar `adresrapport-v2`), zodat oude antwoorden niet meer gebruikt worden. Berekend water wordt per adres en scenario in het geheugen bewaard zolang de pagina open is.

### Testen

Er is geen automatische testsuite. Bij het bouwen is getest door Chrome headless aan te sturen via het DevTools-protocol: adressen laden, knoppen klikken, screenshots maken en de console op fouten controleren. Goede testadressen:

- Prinsengracht 263, Amsterdam: rijksmonument, dakvormen, bomen, beschermd stadsgezicht.
- Van Heukelomstraat 201, Rotterdam: diep in een polder, veel water in de scenario's.
- Damrak 1, Amsterdam: dichte binnenstad, droog bij de meeste overstromingsscenario's.

Safari is niet automatisch getest. Eerder bleek Safari strenger met het uitpakken van rasters; daarom gebruikt de app fflate in plaats van de ingebouwde `DecompressionStream`.

## Bekende beperkingen

- De watersimulatie toont de piekdiepte uit het model, geen tijdsverloop; de schuif is een benadering.
- Zonnepanelen zijn een schatting zonder schaduw van bomen en buren.
- Bomen zijn een optioneel onderdeel van de BGT; niet elke gemeente houdt ze volledig bij.
- Gemeentelijke monumenten, energielabels (EP-Online, API-sleutel nodig) en WOZ-waardes per adres zijn niet als open data beschikbaar.
- three.js tekent buiten MapLibre om. De hover in 3D gebruikt daarom een eigen straal, die een gewoon MapLibre-blok vóór een boom niet ziet.

## Ideeën voor later

- Live regenradar als laag over de kaart (nog uitzoeken welke open bron zonder sleutel en met CORS werkt).
- Deellink die ook de weergave onthoudt (3D, zon, scenario, laag).
- Tijdreis met historische luchtfoto's.
- Twee adressen vergelijken; bulkmodus met CSV-export.
