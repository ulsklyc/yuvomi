/**
 * Modul: Modul-Icons
 * Zweck: Eigener monoliniger Icon-Set für die Yuvomi-MODUL-ZEICHEN (1.6 Strich auf
 * viewBox 24). Jedes Zeichen ist eine BESCHREIBUNG; daraus wird ein SVG-Element
 * (`moduleIconEl`) oder Markup (`moduleIconHTML`) — kein innerHTML.
 *
 * ER GEHÖRT NICHT MEHR NUR DER NAVIGATION (2026-08-17). Der Satz hieß „Nav Icons",
 * und danach hat er sich auch verhalten: die Leisten zeichneten mit ihm, jede
 * andere Stelle, an der ein Modul sich zu erkennen gibt — Widget-Kopf,
 * Kennzahl-Kachel, „Heute wichtig", Suche, Wand, die Modul-Liste der
 * Einstellungen — griff zu Lucide. Dasselbe Modul trug damit zwei Zeichen von
 * zwei Händen: Notizen war in der Leiste ein Zettel (`sticky-note`) und im
 * Widget-Kopf eine Stecknadel (`pin`), Haushaltshilfe in der Leiste ein Pinsel
 * und auf der Kachel Funkeln (`sparkles`). Nicht drei Fehler, sondern EIN
 * Fehler: die Zuordnung Modul → Zeichen stand an fünf Stellen.
 *
 * Sie steht jetzt an genau einer (MODULE_ICON, unten), und jede Bau-Stelle holt
 * ihr Zeichen über `moduleIconEl()` bzw. `moduleIconHTML()`. Was der Satz nicht
 * kennt, fällt weiter auf Lucide zurück — sichtbar an derselben Strichstärke,
 * dafür sorgt `--icon-stroke` (tokens.css) über die Marke `.module-glyph`.
 *
 * Schlüssel = Lucide-Icon-Name, damit der Rückfall denselben Namen versteht.
 * Aufruf: NAV_ICONS['calendar']?.()  → SVGElement
 */

const NS = 'http://www.w3.org/2000/svg';

/* Die Wurzelattribute jedes Zeichens. Die Strichstärke steht hier als
 * Zeichen-Voreinstellung; was am Bildschirm ankommt, entscheidet
 * `--icon-stroke` (tokens.css) — CSS schlägt das Präsentationsattribut, und nur
 * so gilt EINE Strichstärke auch für die Lucide-Rückfälle.
 *
 * `width`/`height` STEHEN AUS DEMSELBEN GRUND HIER, und sie sind es, die #949
 * geschlossen haben. Der Satz gab sein SVG ohne Grundmass aus; ein SVG mit
 * viewBox, aber ohne Mass hat kein eigenes, sondern nimmt die Breite seines
 * Kastens. In einer Box mit fester Groesse (Leiste, Siegel, Modul-Scheibe) fiel
 * das nie auf - in einer flexiblen Zeile wurden aus 20px 489px: die vier
 * Kuechen-Kinder in den Einstellungen (drei Stellen, eine Ursache). Der
 * Lucide-Rueckfall hatte das Mass die ganze Zeit, weil `lucide.createIcons()`
 * width/height setzt; damit sagte derselbe Name je nach Hand etwas anderes.
 * Als PRAESENTATIONSATTRIBUT unterliegt es jeder CSS-Regel, die einen Ort
 * bemisst - es aendert also nur die Orte, die bisher gar kein Mass hatten. */
const ROOT_ATTRS = {
  viewBox: '0 0 24 24',
  width: '24',
  height: '24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.6',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
};

/* Ein gefülltes Detail (Kerzenflamme, Kalenderpunkte, Sand): der eine
 * Vollton-Akzent, der einem Umriss seinen Blickpunkt gibt. */
const SOLID = { fill: 'currentColor', stroke: 'none' };

/* DIE MARKE, AN DER DIE STRICHSTÄRKE HÄNGT. Jedes Zeichen aus diesen Helfern
 * trägt sie — auch der Lucide-Rückfall, dessen Klassen `lucide.createIcons()`
 * auf das erzeugte <svg> übernimmt. Damit gilt `--icon-stroke` über EINEN
 * Selektor statt über eine wachsende Liste von Orten (layout.css). */
const GLYPH_CLASS = 'module-glyph';

/**
 * EIN ZEICHEN IST EINE BESCHREIBUNG, KEINE DOM-FOLGE — `[tag, attribute]`.
 *
 * Es war eine DOM-Folge, und daran ist die Verallgemeinerung zuerst gescheitert:
 * die Fabriken riefen `createElementNS`, also brauchte JEDER Weg zum Zeichen ein
 * `document` — auch der, der nur eine Zeichenkette wollte (das Dashboard baut
 * sein Markup als String). Vierzehn Dashboard-Tests fielen mit „document is not
 * defined", und sie hatten recht: eine Funktion, die Text erzeugt, darf keinen
 * Browser voraussetzen. Aus der Beschreibung leiten sich BEIDE Formen ab, und
 * keine der beiden ist die Quelle der anderen.
 */
const ICON_SHAPES = {
  'layout-dashboard': [
    ['rect', { x: '3.5', y: '3.5', width: '7.5', height: '7.5', rx: '2.2' }],
    ['rect', { x: '13', y: '3.5', width: '7.5', height: '5', rx: '2' }],
    ['rect', { x: '13', y: '10.5', width: '7.5', height: '10', rx: '2.2' }],
    ['rect', { x: '3.5', y: '12.5', width: '7.5', height: '8', rx: '2' }],
  ],

  'calendar-clock': [
    ['rect', { x: '3.5', y: '5.5', width: '17', height: '15', rx: '3' }],
    ['path', { d: 'M3.5 10h17' }],
    ['path', { d: 'M8 3.2v4.6M16 3.2v4.6' }],
    ['circle', { cx: '16.5', cy: '16.5', r: '3.2' }],
    ['path', { d: 'M16.5 14.8v1.9l1.25.8' }],
  ],
  'calendar': [
    ['rect', { x: '3.5', y: '5.5', width: '17', height: '15', rx: '3' }],
    ['path', { d: 'M3.5 10h17' }],
    ['path', { d: 'M8 3.2v4.6M16 3.2v4.6' }],
    ['circle', { cx: '8.5', cy: '14.5', r: '.9', ...SOLID }],
    ['circle', { cx: '12', cy: '14.5', r: '.9', ...SOLID }],
    ['circle', { cx: '15.5', cy: '14.5', r: '.9', ...SOLID }],
  ],

  'check-square': [
    ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '4.5' }],
    ['path', { d: 'm8 12.3 2.8 2.8 5.6-5.6' }],
  ],

  'sticky-note': [
    ['path', { d: 'M5.5 4.5h9.5L18.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V6a1.5 1.5 0 0 1 1.5-1.5z' }],
    ['path', { d: 'M15 4.5V7a1.5 1.5 0 0 0 1.5 1.5H19' }],
    ['path', { d: 'M8 13h7M8 16.5h5' }],
  ],

  'cake': [
    ['path', { d: 'M4 19.5h16' }],
    ['path', { d: 'M5.5 19.5v-6.2a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.2' }],
    ['path', { d: 'M5.5 15c1.2.8 1.8.8 3 0s1.8-.8 3 0 1.8.8 3 0 1.8-.8 3 0' }],
    ['path', { d: 'M12 7.5v3.8' }],
    ['path', { d: 'M12 4.5c.8.6.8 1.4 0 2-.8-.6-.8-1.4 0-2z', ...SOLID }],
  ],

  'book-user': [
    ['rect', { x: '3.5', y: '4', width: '17', height: '16', rx: '3' }],
    ['circle', { cx: '10', cy: '11', r: '2.4' }],
    ['path', { d: 'M6.5 17.5c.6-2 2-3 3.5-3s2.9 1 3.5 3' }],
    ['path', { d: 'M16 9h2.5M16 12h2M16 15h2.5' }],
  ],

  'wallet': [
    ['path', { d: 'M4 8.5a2.5 2.5 0 0 1 2.5-2.5H17l1 2.5' }],
    ['rect', { x: '3.5', y: '7.5', width: '17', height: '12', rx: '2.5' }],
    ['circle', { cx: '16.5', cy: '13.5', r: '1.3' }],
  ],

  'folder-lock': [
    ['path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h3.4l2 2.2H18a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z' }],
    ['path', { d: 'M8 13.5h8M8 16.5h5' }],
  ],

  'paintbrush': [
    ['path', { d: 'm4.5 19.5 7-7' }],
    ['path', { d: 'm14 6 4 4-3.5 3.5L10.5 9.5z' }],
    ['path', { d: 'M14 6 17 3l4 4-3 3' }],
    ['path', { d: 'M5 17.5c-.5 1-.5 1.8 0 2.5 1 .6 1.9.5 2.5 0' }],
  ],

  'utensils': [
    ['path', { d: 'M7.5 3.5v8a2 2 0 0 1-2 2h-.5v7' }],
    ['path', { d: 'M5.5 3.5v6M7.5 3.5v6M9.5 3.5v6' }],
    ['path', { d: 'M17 3.5c-1.8 0-3 1.5-3 3.5v5h2.2v8.5h1.6V3.5z' }],
  ],

  'settings': [
    ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],

  'grid-2x2': [
    ['circle', { cx: '6.5', cy: '6.5', r: '1.6' }],
    ['circle', { cx: '12', cy: '6.5', r: '1.6' }],
    ['circle', { cx: '17.5', cy: '6.5', r: '1.6' }],
    ['circle', { cx: '6.5', cy: '12', r: '1.6' }],
    ['circle', { cx: '12', cy: '12', r: '1.6' }],
    ['circle', { cx: '17.5', cy: '12', r: '1.6' }],
    ['circle', { cx: '6.5', cy: '17.5', r: '1.6' }],
    ['circle', { cx: '12', cy: '17.5', r: '1.6' }],
    ['circle', { cx: '17.5', cy: '17.5', r: '1.6' }],
  ],

  // Overflow-Glyph für den „Mehr"-Tab: die nahezu universelle horizontale
  // Ellipse liest eindeutig als „mehr/Überlauf" statt als „Apps/Dashboard"
  // (das 3×3-Raster war mehrdeutig).
  'more-horizontal': [
    ['circle', { cx: '5.5', cy: '12', r: '1.7' }],
    ['circle', { cx: '12', cy: '12', r: '1.7' }],
    ['circle', { cx: '18.5', cy: '12', r: '1.7' }],
  ],

  'shopping-cart': [
    ['path', { d: 'M3 4.5h2.4L7.5 16h10.2l2-7H7' }],
    ['circle', { cx: '9', cy: '19.2', r: '1.4' }],
    ['circle', { cx: '17', cy: '19.2', r: '1.4' }],
  ],

  'book-text': [
    ['path', { d: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H18a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19.5z' }],
    ['path', { d: 'M8 8h8M8 12h8M8 16h5' }],
  ],

  'receipt-text': [
    ['path', { d: 'M4 3.5v17l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2V3.5z' }],
    ['path', { d: 'M8 9h8M8 13h8M8 17h4' }],
  ],

  'box': [
    ['path', { d: 'M21 8L12 13 3 8' }],
    ['path', { d: 'M3 8l9-5 9 5v8l-9 5-9-5z' }],
    ['path', { d: 'M12 13v9' }],
  ],

  'heart-pulse': [
    ['path', { d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z' }],
    ['path', { d: 'M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27' }],
  ],

  'award': [
    ['circle', { cx: '12', cy: '9', r: '5.5' }],
    ['path', { d: 'M12 6.2l.9 1.8 2 .3-1.45 1.4.34 2L12 10.75 10.21 11.7l.34-2L9.1 8.3l2-.3z' }],
    ['path', { d: 'M8.7 14.1 7 21l5-2.8L17 21l-1.7-6.9' }],
  ],

  'package': [
    ['path', { d: 'M12 3.5 20 7.5v9L12 20.5 4 16.5v-9z' }],
    ['path', { d: 'M4 7.5 12 11.5 20 7.5' }],
    ['path', { d: 'M12 11.5V20.5' }],
  ],

  // Vorrat: Deckelkiste. Der Deckel sitzt als eigener Körper auf dem Korpus,
  // damit sich das Zeichen bei 20px noch von `package` (Kubus) und `box`
  // (Sendung) unterscheidet — drei Behälter in einer Familie brauchen drei
  // Silhouetten, nicht drei Beschriftungen.
  'archive': [
    ['rect', { x: '3', y: '3.5', width: '18', height: '5', rx: '1.8' }],
    ['path', { d: 'M4.8 8.5v9.7a2.3 2.3 0 0 0 2.3 2.3h9.8a2.3 2.3 0 0 0 2.3-2.3V8.5' }],
    ['path', { d: 'M9.9 12.5h4.2' }],
  ],

  // Familie: zwei Menschen, einer vorn. Bewusst NICHT die drei Kreise der
  // Bildmarke — die ist als Marke gesetzt und wird nicht zum Modulzeichen.
  'users': [
    ['circle', { cx: '9.2', cy: '8', r: '3.4' }],
    ['path', { d: 'M3 20.5v-1.1a5.2 5.2 0 0 1 5.2-5.2h2a5.2 5.2 0 0 1 5.2 5.2v1.1' }],
    ['path', { d: 'M16.4 4.9a3.4 3.4 0 0 1 0 6.2' }],
    ['path', { d: 'M17.8 14.4a5.2 5.2 0 0 1 3.2 4.8v1.3' }],
  ],

  // Zyklus: derselbe Kalenderkörper wie `calendar`, damit die Verwandtschaft
  // sichtbar bleibt — nur die Tagespunkte weichen dem Herz.
  'calendar-heart': [
    ['rect', { x: '3.5', y: '5.5', width: '17', height: '15', rx: '3' }],
    ['path', { d: 'M3.5 10h17' }],
    ['path', { d: 'M8 3.2v4.6M16 3.2v4.6' }],
    ['path', { d: 'M12 18.3c-1.6-1.1-3.3-2.5-3.3-4.2a1.95 1.95 0 0 1 3.3-1.4 1.95 1.95 0 0 1 3.3 1.4c0 1.7-1.7 3.1-3.3 4.2z' }],
  ],

  'cloud-sun': [
    ['path', { d: 'M8.8 3v1.7M4.3 4.8l1.2 1.2M2.5 9.3h1.7M13.3 4.8l-1.2 1.2' }],
    ['path', { d: 'M6.2 12.6a3.6 3.6 0 0 1 4.9-4.9' }],
    ['path', { d: 'M17.4 20.5H8.9a3.7 3.7 0 0 1-.5-7.4 4.8 4.8 0 0 1 9.1 1 3.2 3.2 0 0 1-.1 6.4z' }],
  ],

  'clock': [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M12 6.9V12l3.5 2.1' }],
  ],

  // Kennzahlen: vier gleiche Felder. Der Unterschied zu `layout-dashboard` ist
  // die Gleichheit — dort sagt die ungleiche Aufteilung „Übersicht", hier sagt
  // das Raster „vier Zahlen nebeneinander".
  'layout-grid': [
    ['rect', { x: '3.5', y: '3.5', width: '7.5', height: '7.5', rx: '2.2' }],
    ['rect', { x: '13', y: '3.5', width: '7.5', height: '7.5', rx: '2.2' }],
    ['rect', { x: '3.5', y: '13', width: '7.5', height: '7.5', rx: '2.2' }],
    ['rect', { x: '13', y: '13', width: '7.5', height: '7.5', rx: '2.2' }],
  ],

  // Countdown: der Sand liegt unten und ist gefüllt — dieselbe Sprache wie die
  // Kerzenflamme in `cake` und die Tagespunkte in `calendar`, das eine
  // Vollton-Detail, das dem Umriss einen Blickpunkt gibt.
  'hourglass': [
    ['path', { d: 'M6.5 3.5h11M6.5 20.5h11' }],
    ['path', { d: 'M7.6 3.5v3.2c0 1 .4 1.9 1.1 2.6L12 12l-3.3 2.7c-.7.7-1.1 1.6-1.1 2.6v3.2' }],
    ['path', { d: 'M16.4 3.5v3.2c0 1-.4 1.9-1.1 2.6L12 12l3.3 2.7c.7.7 1.1 1.6 1.1 2.6v3.2' }],
    ['path', { d: 'M9.4 19.1c.4-1.5 1.3-2.5 2.6-2.5s2.2 1 2.6 2.5z', ...SOLID }],
  ],
};

/* Die Fabrikform des Satzes. Sie bleibt exportiert, weil `replaceNavIcon`
 * (router.js) ein bestehendes Zeichen ERSETZT statt eines anzulegen und dabei
 * die Klassen des alten übernimmt. */
export const NAV_ICONS = Object.fromEntries(
  Object.keys(ICON_SHAPES).map((name) => [name, () => svgEl(ICON_SHAPES[name])]),
);

function svgEl(shapes) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries(ROOT_ATTRS)) s.setAttribute(k, v);
  for (const [tag, shapeAttrs] of shapes) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(shapeAttrs)) child.setAttribute(k, v);
    s.appendChild(child);
  }
  return s;
}

/* Attributwerte für den Zeichenketten-Weg. Alle Werte dieses Moduls sind
 * literale Zahlen und Pfade; escapt wird trotzdem, weil ein Icon-NAME aus
 * Modul-Metadaten Dritter kommen kann und derselbe Weg ihn ausgibt. */
function attrs(map) {
  return Object.entries(map)
    .map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
    .join('');
}

function svgMarkup(shapes, className) {
  const children = shapes.map(([tag, a]) => `<${tag}${attrs(a)}/>`).join('');
  return `<svg${attrs({ ...ROOT_ATTRS, class: className })}>${children}</svg>`;
}

/**
 * EIN MODUL, EIN ZEICHEN — und die Zuordnung steht hier, nicht fünfmal verteilt.
 *
 * Die Schlüssel sind Modul-Ids (`navItems().module`, `widgetIcon(id)`,
 * `renderMetricTile(tile.id)`, `BUILT_IN_MODULES`), die Werte Icon-Namen dieses
 * Satzes. Die Dashboard-eigenen Einträge unten (Familie, Zyklus, Wetter, Uhr,
 * Kennzahlen, Countdown) sind keine Module im Sinne der README-Tabelle, tragen
 * aber dieselbe Absender-Rolle im Widget-Kopf und gehören deshalb in dieselbe
 * Tabelle.
 */
export const MODULE_ICON = {
  dashboard:        'layout-dashboard',
  calendar:         'calendar',
  schedule:         'calendar-clock',
  tasks:            'check-square',
  notes:            'sticky-note',
  meals:            'utensils',
  recipes:          'book-text',
  shopping:         'shopping-cart',
  pantry:           'archive',
  kitchen:          'utensils',
  housekeeping:     'paintbrush',
  waste:            'trash-2',
  documents:        'folder-lock',
  inventory:        'package',
  rewards:          'award',
  contacts:         'book-user',
  birthdays:        'cake',
  health:           'heart-pulse',
  budget:           'wallet',
  'split-expenses': 'receipt-text',
  settings:         'settings',
  // Dashboard-Widgets ohne eigenes Modul
  family:           'users',
  cycle:            'calendar-heart',
  weather:          'cloud-sun',
  clock:            'clock',
  metrics:          'layout-grid',
  countdown:        'hourglass',
  quicklinks:        'compass',
};

/**
 * Das Zeichen zu einem Icon-Namen als Element — Yuvomis Hand, wo es sie gibt,
 * sonst Lucide unter demselben Namen.
 * @param {string} name        Icon-Name (Schlüssel dieses Satzes / Lucide)
 * @param {string} [className] Zusätzliche Klasse für das erzeugte Element
 * @returns {SVGElement|HTMLElement}
 */
export function moduleIconEl(name, className) {
  const shapes = ICON_SHAPES[name];
  const el = shapes ? svgEl(shapes) : document.createElement('i');
  if (!shapes) {
    el.dataset.lucide = name;
    el.setAttribute('aria-hidden', 'true');
  }
  for (const cls of `${GLYPH_CLASS} ${className ?? ''}`.split(/\s+/).filter(Boolean)) {
    el.classList.add(cls);
  }
  return el;
}

/**
 * Dasselbe für die Bau-Stellen, die ihr Markup als Zeichenkette zusammensetzen
 * (Dashboard, Einstellungen). OHNE `document`: die Beschreibung wird direkt
 * serialisiert — siehe den Kommentar an ICON_SHAPES.
 * @returns {string}
 */
export function moduleIconHTML(name, className) {
  const cls = `${GLYPH_CLASS}${className ? ` ${className}` : ''}`;
  const shapes = ICON_SHAPES[name];
  if (shapes) return svgMarkup(shapes, cls);
  return `<i${attrs({ 'data-lucide': name, class: cls, 'aria-hidden': 'true' })}></i>`;
}
