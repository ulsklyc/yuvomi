/**
 * Tests: SortableJS-Integration (Drag-and-Drop-Sortierung)
 * Läuft im Node-Kontext - kein echtes DOM/Drag verfügbar, daher:
 *   - makeSortable() nur in den Guard-Pfaden geprüft (der lazy Vendor-Import
 *     löst einen absoluten Browser-Pfad auf, den es unter Node nicht gibt).
 *   - Komponente/CSS/Vendor/i18n strukturell geprüft, analog test-category-manager.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Minimales Window/Navigator-Mock, wie in test-ux-utils.js: sortable.js importiert
// vibrate() aus ux.js, das window.matchMedia + navigator.vibrate anfasst.
const vibrateCalls = [];
global.window = { matchMedia: () => ({ matches: false }) };
Object.defineProperty(global, 'navigator', {
  value: { vibrate: (pattern) => vibrateCalls.push(pattern) },
  writable: true,
  configurable: true,
});

const { makeSortable } = await import('../public/utils/sortable.js');

// --------------------------------------------------------
// makeSortable() - Guard-Pfade (kein Vendor-Import ohne DOM/listEl)
// --------------------------------------------------------

test('makeSortable: ohne listEl → null, kein Fehler', async () => {
  assert.equal(await makeSortable(null, { onEnd: () => {} }), null);
});

test('makeSortable: ohne onEnd-Callback → null (Persistenz-Callback ist Pflicht)', async () => {
  assert.equal(await makeSortable({}, {}), null);
});

// --------------------------------------------------------
// sortable.js - touch-sichere, reduced-motion-bewusste Konfiguration
// --------------------------------------------------------

const wrapperSource = read('../public/utils/sortable.js');

test('sortable.js: lädt SortableJS lazy aus dem Vendor-Pfad, kein CDN', () => {
  assert.match(wrapperSource, /import\(\s*'\/vendor\/sortablejs\/sortable\.esm\.min\.js'\s*\)/);
  assert.doesNotMatch(wrapperSource, /https?:\/\/(?!github\.com)/, 'kein Runtime-CDN-Verweis erlaubt');
});

test('sortable.js: touch-sicher via delay/delayOnTouchOnly', () => {
  assert.match(wrapperSource, /delay:\s*\d+/);
  assert.match(wrapperSource, /delayOnTouchOnly:\s*true/);
});

test('sortable.js: respektiert prefers-reduced-motion', () => {
  assert.match(wrapperSource, /prefers-reduced-motion:\s*reduce/);
  assert.match(wrapperSource, /animation:\s*reduced\s*\?\s*0/);
});

test('sortable.js: nutzt vibrate() aus ux.js als Drop-Feedback', () => {
  assert.match(wrapperSource, /import \{ vibrate \} from '\.\/ux\.js'/);
  assert.match(wrapperSource, /vibrate\(/);
});

test('sortable.js: definiert ghost/chosen/drag-Klassen für modulweites CSS-Styling', () => {
  assert.match(wrapperSource, /ghostClass:\s*'sortable-ghost'/);
  assert.match(wrapperSource, /chosenClass:\s*'sortable-chosen'/);
  assert.match(wrapperSource, /dragClass:\s*'sortable-drag'/);
});

// --------------------------------------------------------
// Vendor-Datei: self-hosted, gepinnt, dokumentiert
// --------------------------------------------------------

test('vendor: sortable.esm.min.js liegt self-hosted vor und ist dokumentiert', () => {
  const path = '../public/vendor/sortablejs/sortable.esm.min.js';
  assert.ok(existsSync(new URL(path, import.meta.url)));
  const src = read(path);
  assert.match(src, /SortableJS 1\.15\.7/);
  assert.match(src, /MIT License/);
  assert.match(src, /export default/, 'muss ein valides ESM-Default-Export bleiben');
  // Grobe Minifizierungs-Prüfung: Header-Kommentar (~9 Zeilen) + eine lange Codezeile.
  assert.ok(src.split('\n').length < 20, 'sollte minifiziert sein (wenige Zeilen)');
});

test('vendor: LICENSE und README dokumentieren Version/Quelle', () => {
  assert.ok(existsSync(new URL('../public/vendor/sortablejs/LICENSE', import.meta.url)));
  const readme = read('../public/vendor/sortablejs/README.md');
  assert.match(readme, /1\.15\.7/);
  assert.match(readme, /sortablejs/);
});

// --------------------------------------------------------
// category-manager.js - Drag-Handle, Tastatur-Fallback, geteilter Persistenz-Pfad
// --------------------------------------------------------

const comp = read('../public/components/category-manager.js');

test('category-manager: importiert den Sortable-Wrapper', () => {
  assert.match(comp, /import \{[^}]*\bmakeSortable\b[^}]*\} from '\/utils\/sortable\.js'/);
});

test('category-manager: Drag-Handle ist kein Button (kein Tab-Stop, keine Fake-Aktion)', () => {
  assert.match(comp, /<span class="cat-row__handle" role="img" aria-label="[^"]*"/);
  assert.match(comp, /<span class="cat-subrow__handle" role="img" aria-label="[^"]*"/);
  assert.doesNotMatch(comp, /<button[^>]*cat-row__handle/);
});

test('category-manager: Drag-Handle nutzt grip-vertical (Lucide)', () => {
  assert.match(comp, /cat-row__handle[\s\S]{0,120}data-lucide="grip-vertical"/);
  assert.match(comp, /cat-subrow__handle[\s\S]{0,120}data-lucide="grip-vertical"/);
});

test('category-manager: Tastatur-Fallback (Auf/Ab-Buttons) bleibt erhalten, Drag ist nie der einzige Weg', () => {
  // Seit dem Komponenten-Kanon (2026-09-26) baut `_rowActionsHtml()` die
  // Knoepfe ueber rowActionHtml({ action: `${prefix}up` }), prefix 'sub-' fuer
  // Unterkategorien. Geprueft wird die Regel - beide Ebenen haben Auf/Ab im
  // Markup UND im Klick-Verteiler -, nicht die Schreibweise des Attributs.
  const markup = (a) => new RegExp(`data-action="${a}"`).test(comp);
  const viaHelper = /const prefix = sub \? 'sub-' : '';/.test(comp)
    && /action: `\$\{prefix\}up`/.test(comp) && /action: `\$\{prefix\}down`/.test(comp);
  for (const a of ['up', 'down', 'sub-up', 'sub-down']) {
    assert.ok(markup(a) || viaHelper, `kein Knopf mit data-action="${a}"`);
    assert.match(comp, new RegExp(`action === '${a}'`), `der Klick-Verteiler kennt "${a}" nicht`);
  }
  assert.match(comp, /async _move\(key, delta\)/);
  assert.match(comp, /async _subMove\(parent, subKey, delta\)/);
});

test('category-manager: Auf/Ab-Buttons UND Drag-Ende rufen denselben Persistenz-Pfad auf', () => {
  const persistOrderCalls = comp.match(/this\._persistOrder\(/g) || [];
  const persistSubOrderCalls = comp.match(/this\._persistSubOrder\(/g) || [];
  assert.ok(persistOrderCalls.length >= 2, '_persistOrder muss von _move UND vom Drag-onEnd aufgerufen werden');
  assert.ok(persistSubOrderCalls.length >= 2, '_persistSubOrder muss von _subMove UND vom Sub-Drag-onEnd aufgerufen werden');
});

test('category-manager: Reorder-Fehler lösen ein Rollback aus (Teil-Render aus unverändertem State)', () => {
  // Der Rollback zeichnet nur den betroffenen Ausschnitt neu (Gruppe bzw.
  // Sublist), nicht die ganze Komponente - stellt die servergültige Reihenfolge
  // wieder her und verwirft die optimistische Drag-Vorschau.
  assert.match(comp, /async _persistOrder\([\s\S]*?catch \(err\) \{[\s\S]*?this\._renderGroup\(/);
  assert.match(comp, /async _persistSubOrder\([\s\S]*?catch \(err\) \{[\s\S]*?this\._renderSublist\(/);
});

// --------------------------------------------------------
// Partielles Re-Rendering: Mutationen zeichnen nur den betroffenen Ausschnitt
// neu (Finding 8), statt bei jeder Aktion alle SortableJS-Instanzen zu ersetzen.
// --------------------------------------------------------

test('category-manager: bietet scope-fähige Teil-Renderer neben dem Voll-Render', () => {
  assert.match(comp, /_render\(\)\s*\{/, 'Voll-Render bleibt für Erstbefüllung/Fallback');
  assert.match(comp, /_renderGroup\(groupKey\)\s*\{/, 'Gruppen-Teil-Render muss existieren');
  assert.match(comp, /_renderSublist\(parentKey\)\s*\{/, 'Sublist-Teil-Render muss existieren');
});

test('category-manager: Teil-Render verdrahtet nur den neu gebauten Ausschnitt (_wireSortableIn(root))', () => {
  assert.match(comp, /_wireSortableIn\(root\)\s*\{/, 'scope-fähiges Wiring muss existieren');
  // Der Voll-Render verdrahtet den ganzen Container, die Teil-Render nur Sektion/Zeile.
  assert.match(comp, /_wireSortableIn\(this\._groupsEl\)/);
  assert.match(comp, /_wireSortableIn\(newSection\)/);
  assert.match(comp, /_wireSortableIn\(row\)/);
});

test('category-manager: Teil-Render zerstört nur die Sortable-Instanzen des Ausschnitts (_destroySortablesIn)', () => {
  assert.match(comp, /_destroySortablesIn\(container\)\s*\{/);
  assert.match(comp, /container\.contains\(s\.el\)/, 'Selektion über die Listen-Element-Zugehörigkeit');
  // Voll-Render/disconnected nutzen weiterhin den kompletten Abbau.
  assert.match(comp, /_destroySortables\(\)\s*\{/);
});

test('category-manager: top-level-Mutationen zeichnen nur ihre Gruppe neu', () => {
  // Add/Rename/Delete/Reorder rufen _renderGroup statt des Voll-_render() auf.
  const groupRenders = comp.match(/this\._renderGroup\(/g) || [];
  assert.ok(groupRenders.length >= 4, `mindestens Add/Rename/Delete/Reorder-Erfolg, gefunden: ${groupRenders.length}`);
});

test('category-manager: subcategory-Mutationen zeichnen nur ihre Sublist neu', () => {
  const subRenders = comp.match(/this\._renderSublist\(/g) || [];
  assert.ok(subRenders.length >= 4, `mindestens Add/Rename/Delete/Reorder-Erfolg, gefunden: ${subRenders.length}`);
});

test('category-manager: Refresh ohne Render (_fetch) trennt Datenladen vom Zeichnen', () => {
  assert.match(comp, /async _fetch\(\)\s*\{[\s\S]*?api\.get\(this\._basePath\)/);
  // _load bleibt der Voll-Load-Pfad (Erstbefüllung), gebaut auf _fetch.
  assert.match(comp, /async _load\(\)\s*\{[\s\S]*?await this\._fetch\(\);[\s\S]*?this\._render\(\);/);
});

test('category-manager: aria-live-Region sagt Umsortierungen an', () => {
  assert.match(comp, /role="status" aria-live="polite" id="cat-manager-announce"/);
  assert.match(comp, /_announce\(message\)/);
  assert.match(comp, /t\('category\.reorderAnnounce'/);
});

test('category-manager: hält den Fokus nach erfolgreichem Button-Reorder auf der bewegten Zeile', () => {
  assert.match(comp, /_restoreReorderFocus\(rowSelector, dir/, 'Fokus-Restore-Helper muss existieren');
  // Nur der Button-Pfad übergibt Fokus-Absicht (Zeile + gedrückte Richtung); der
  // Drag-Pfad (rollbackRender:true) übergibt bewusst keine.
  assert.match(comp, /focusKey:\s*key/);
  assert.match(comp, /focusSubKey:\s*subKey/);
  assert.match(comp, /focusDir:\s*delta > 0 \? 'down' : 'up'/);
  // Beide Erfolgspfade stellen den Fokus wieder her.
  assert.match(comp, /async _persistOrder\([\s\S]*?this\._restoreReorderFocus\(/);
  assert.match(comp, /async _persistSubOrder\([\s\S]*?this\._restoreReorderFocus\(/);
  // Fallback-Kette endet auf einem fokussierbaren Element (Umbenennen), nie <body>.
  assert.match(comp, /data-action="\$\{prefix\}rename"/);
});

test('category-manager: Drag-Import-Fehler warnt einmalig statt still zu schlucken', () => {
  assert.match(comp, /_warnDragUnavailable\(/, 'Warn-Helfer muss existieren');
  assert.match(comp, /if \(this\._dragWarned\) return;/, 'nur einmal warnen');
  assert.match(comp, /console\.warn\(/);
  assert.doesNotMatch(comp, /\.catch\(\(\) => \{\}\)/, 'kein stiller Catch mehr');
});

test('category-manager: Sublist-Reorder schließt die Add-Zeile von Drag/Index aus', () => {
  assert.match(comp, /draggable:\s*'\.cat-subrow'/);
});

test('category-manager: räumt Sortable-Instanzen bei Re-Render und disconnectedCallback auf', () => {
  assert.match(comp, /_destroySortables\(\)/);
  assert.match(comp, /disconnectedCallback\(\)\s*\{[\s\S]*?_destroySortables\(\)/);
});

test('category-manager: nutzt weiterhin kein innerHTML', () => {
  assert.doesNotMatch(comp, /\.innerHTML/);
});

// --------------------------------------------------------
// CSS: Drag-States über Tokens, modulweit themed
// --------------------------------------------------------

const css = read('../public/styles/category-manager.css');

test('category-manager.css: definiert ghost/chosen/drag-States', () => {
  assert.match(css, /\.cat-row\.sortable-ghost/);
  assert.match(css, /\.cat-row\.sortable-chosen/);
  assert.match(css, /\.cat-row\.sortable-drag/);
});

test('category-manager.css: Drag-States nutzen Tokens, keine hartkodierten Farben', () => {
  const dragBlockMatch = css.match(/\/\* -{5,}[\s\S]*Drag-and-Drop-Sortierung[\s\S]*?\*\/([\s\S]*)$/);
  assert.ok(dragBlockMatch, 'Drag-and-Drop-Sektion muss vorhanden sein');
  const dragBlock = dragBlockMatch[1];
  assert.doesNotMatch(dragBlock, /#[0-9a-fA-F]{3,8}\b/, 'keine hartkodierten Hex-Farben im Drag-Styling');
  assert.match(dragBlock, /var\(--active-module-accent/);
});

test('category-manager.css: respektiert prefers-reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

// --------------------------------------------------------
// i18n: dragHandle + reorderAnnounce in allen Locales
// --------------------------------------------------------

const LOCALES = [
  'ar', 'cs', 'de', 'el', 'en', 'es', 'fa', 'fr', 'hi', 'hu', 'id', 'it',
  'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'uk', 'vi', 'zh',
];

test('locales: category.dragHandle und category.reorderAnnounce existieren in allen Sprachen', () => {
  const missing = [];
  for (const lang of LOCALES) {
    const data = JSON.parse(read(`../public/locales/${lang}.json`));
    if (typeof data.category?.dragHandle !== 'string' || !data.category.dragHandle.length) {
      missing.push(`${lang}: dragHandle`);
    }
    if (typeof data.category?.reorderAnnounce !== 'string' || !data.category.reorderAnnounce.length) {
      missing.push(`${lang}: reorderAnnounce`);
    }
  }
  assert.deepEqual(missing, []);
});

test('locales: reorderAnnounce interpoliert {{name}}, {{position}} und {{total}}', () => {
  for (const lang of LOCALES) {
    const data = JSON.parse(read(`../public/locales/${lang}.json`));
    const msg = data.category.reorderAnnounce;
    assert.match(msg, /\{\{name\}\}/, `${lang} fehlt {{name}}`);
    assert.match(msg, /\{\{position\}\}/, `${lang} fehlt {{position}}`);
    assert.match(msg, /\{\{total\}\}/, `${lang} fehlt {{total}}`);
  }
});

// --------------------------------------------------------
// Vibrate-Mock tatsächlich genutzt (Sanity: Testsetup selbst funktioniert)
// --------------------------------------------------------

test('Testsetup: vibrate-Mock ist einsatzbereit', () => {
  assert.equal(vibrateCalls.length, 0); // in diesen Tests nie real ausgelöst (kein DOM-Drag)
});

// --------------------------------------------------------
// Verbund mehrerer Listen (#808: Aufgabenboard)
//
// Der Wrapper war fuer EINE Liste gebaut, und seine Abbruchbedingung sagte das:
// gleicher Index heisst "nichts passiert". Sobald Listen in einer `group`
// zusammenhaengen, stimmt das nicht mehr - Platz 0 in "Offen" ist nicht Platz 0
// in "Erledigt". Ohne die Erweiterung waere ausgerechnet der haeufigste Zug
// still verfallen: die oberste Karte in die naechste Spalte.
// --------------------------------------------------------

/**
 * Der Argument-Block eines Aufrufs, ueber Klammerbalance abgegrenzt.
 *
 * Nicht ueber eine Zeichenzahl: die erste Fassung schnitt 700 Zeichen ab dem
 * Aufruf heraus und wurde rot, als ein Kommentar dazukam - ein Test, der beim
 * Kommentieren bricht, misst die Laenge und nicht die Sache.
 */
function callBlockOf(source, needle) {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `Reichweite: "${needle}" gefunden`);
  // Die Klammer des Aufrufs selbst, nicht die naechste im Text danach.
  const open = source.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') { depth--; if (depth === 0) return source.slice(open, i + 1); }
  }
  return source.slice(open);
}

/** Faengt die Optionen ab, mit denen der Wrapper Sortable.create() ruft. */
function onEndOf() {
  const source = read('../public/utils/sortable.js');
  // Der Block der onEnd-Bedingung, ohne dass ein Vendor-Import noetig waere.
  const at = source.indexOf('onEnd(evt) {');
  assert.ok(at > 0, 'Reichweite: der onEnd-Block wurde gefunden');
  return source.slice(at, source.indexOf('},', at));
}

test('makeSortable: der Drop verfaellt nur, wenn Liste UND Platz gleich bleiben', () => {
  const block = onEndOf();
  // Die Bedingung muss beide Haelften tragen. Eine, die nur den Index vergleicht,
  // wuerde einen Listenwechsel auf gleichem Platz verschlucken.
  assert.match(block, /evt\.from\s*===\s*evt\.to/, 'die Liste zaehlt mit');
  assert.match(block, /evt\.oldIndex\s*===\s*evt\.newIndex/, 'und der Platz auch');

  // Und sie muessen UND-verknuepft sein: ein ODER liesse jeden Zug innerhalb
  // einer Liste verfallen.
  assert.match(block, /evt\.from === evt\.to && evt\.oldIndex === evt\.newIndex/,
    'beide Haelften UND-verknuepft - ein ODER haette jede Umsortierung verschluckt');
});

test('makeSortable: reicht group und sort an SortableJS durch', () => {
  const source = read('../public/utils/sortable.js');
  assert.match(source, /makeSortable\(listEl, \{[^)]*group[^)]*sort = true/,
    'beide sind benannte Optionen mit dokumentiertem Standard');
  const created = source.slice(source.indexOf('Sortable.create('), source.indexOf('onEnd(evt)'));
  assert.match(created, /^\s*group,\s*$/m, 'group geht an SortableJS');
  assert.match(created, /^\s*sort,\s*$/m, 'sort ebenfalls');
});

// --------------------------------------------------------
// Aufgabenboard: kein zweiter Drag daneben (#808)
// --------------------------------------------------------

test('tasks: das Board zieht ueber den Wrapper, nicht mehr ueber natives DnD', () => {
  const source = read('../public/pages/tasks.js');
  assert.match(source, /makeSortable\(zone, \{/, 'die Spalten haengen am Wrapper');

  // Die eigene Touch-Simulation war der Grund fuer #808: acht Pixel Weg und
  // KEINE Zeitschwelle - Scrollen ueber einer Karte nahm sie mit. Sie ist weg,
  // und mit ihr das native draggable, das keine Schwelle kennt.
  assert.ok(!/draggable="true"/.test(source), 'keine Karte traegt natives draggable mehr');
  for (const rest of ['dragstart', 'dragover', 'dragleave', 'touchmove', 'kanban-card--ghost']) {
    assert.ok(!source.includes(rest), `Rueckstand des alten Drags: ${rest}`);
  }
});

test('tasks: das Board bietet keine Reihenfolge an, die es nicht speichert', () => {
  const source = read('../public/pages/tasks.js');
  const call = callBlockOf(source, 'makeSortable(zone, {');
  assert.match(call, /sort:\s*false/,
    'innerhalb einer Spalte gibt es keinen Rang - eine umsortierte Karte bliebe sonst liegen, bis etwas anderes neu zeichnet');
  assert.match(call, /group:/, 'zwischen den Spalten bleibt der Zug erlaubt');
  assert.match(call, /draggable:\s*'\.kanban-card'/,
    'sonst waere auch der Leerzustands-Hinweis im Spaltenkoerper ziehbar');
});

test('tasks: Drag-Ende und Weiterschalt-Knopf gehen denselben Weg', () => {
  const source = read('../public/pages/tasks.js');
  // Die Zusage aus dem Kopf von sortable.js. Zwei getrennte Wege, die dasselbe
  // zu tun behaupten, laufen auseinander, sobald einer einen Sonderfall bekommt -
  // und der Sonderfall steht hier schon: die vierte Spalte ist die Ablage, kein
  // Status (#688).
  const drop = source.slice(source.indexOf('onEnd: (evt)'), source.indexOf('onEnd: (evt)') + 500);
  assert.match(drop, /runColumnMove\(/, 'der Drop laeuft durch runColumnMove');
  const clicks = source.slice(source.indexOf('function wireKanbanClicks'));
  assert.match(clicks, /runColumnMove\(/, 'der Knopf ebenfalls');
});

test('tasks: der Weiterschalt-Knopf wird nicht zum Griff (Review zu #808)', () => {
  const source = read('../public/pages/tasks.js');
  const call = callBlockOf(source, 'makeSortable(zone, {');
  // Der alte Touch-Handler nahm den Knopf ausdruecklich aus; beim Umstellen ging
  // die Zeile verloren. Ohne Filter kennt SortableJS nur `a` und `img`, also
  // haette ein langer Druck auf den Knopf die Karte aufgenommen statt sie
  // weiterzuschalten - ausgerechnet an dem Element, das der Tastaturweg ist.
  assert.match(call, /filter:\s*'\[data-next-status\]'/,
    'der Statusknopf ist vom Ziehen ausgenommen');
});

test('sortable.js: Filtern heisst nicht ziehen, nicht: nicht bedienen', () => {
  const source = read('../public/utils/sortable.js');
  // SortableJS ruft mit seinem Standard ein preventDefault() auf dem
  // Aufsetz-Ereignis; auf Touch nimmt das dem gefilterten Element auch den
  // Klick. Ein Knopf, den man vom Ziehen ausnimmt, waere damit tot statt
  // geschuetzt - und der Filter versprechen genau das nicht.
  assert.match(source, /preventOnFilter:\s*false/,
    'ein gefiltertes Element bleibt bedienbar');
});
