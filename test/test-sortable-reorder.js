/**
 * Tests: SortableJS-Integration (Drag-and-Drop-Sortierung)
 * Läuft im Node-Kontext - kein echtes DOM/Drag verfügbar, daher:
 *   - reorder() ist eine reine Funktion → real importiert und verhaltensgeprüft.
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

const { makeSortable, reorder } = await import('../public/utils/sortable.js');

// --------------------------------------------------------
// reorder() - reine Reihenfolge-Berechnung
// --------------------------------------------------------

test('reorder: verschiebt ein Element nach hinten', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
});

test('reorder: verschiebt ein Element nach vorne', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
});

test('reorder: Nachbar-Swap (typischer Drag-Fall)', () => {
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 2), ['a', 'c', 'b']);
});

test('reorder: gleiche Position ändert nichts', () => {
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});

test('reorder: mutiert das Eingabe-Array nicht', () => {
  const input = ['a', 'b', 'c'];
  reorder(input, 0, 2);
  assert.deepEqual(input, ['a', 'b', 'c']);
});

test('reorder: funktioniert mit Objekten (Kategorie-artige Einträge)', () => {
  const items = [{ key: 'x' }, { key: 'y' }, { key: 'z' }];
  const next = reorder(items, 2, 0);
  assert.deepEqual(next.map((i) => i.key), ['z', 'x', 'y']);
});

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
  assert.match(comp, /import \{ makeSortable \} from '\/utils\/sortable\.js'/);
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
  assert.match(comp, /data-action="up"/);
  assert.match(comp, /data-action="down"/);
  assert.match(comp, /data-action="sub-up"/);
  assert.match(comp, /data-action="sub-down"/);
  assert.match(comp, /async _move\(key, delta\)/);
  assert.match(comp, /async _subMove\(parent, subKey, delta\)/);
});

test('category-manager: Auf/Ab-Buttons UND Drag-Ende rufen denselben Persistenz-Pfad auf', () => {
  const persistOrderCalls = comp.match(/this\._persistOrder\(/g) || [];
  const persistSubOrderCalls = comp.match(/this\._persistSubOrder\(/g) || [];
  assert.ok(persistOrderCalls.length >= 2, '_persistOrder muss von _move UND vom Drag-onEnd aufgerufen werden');
  assert.ok(persistSubOrderCalls.length >= 2, '_persistSubOrder muss von _subMove UND vom Sub-Drag-onEnd aufgerufen werden');
});

test('category-manager: Reorder-Fehler lösen ein Rollback aus (Neu-Render aus unverändertem State)', () => {
  assert.match(comp, /async _persistOrder\([\s\S]*?catch \(err\) \{[\s\S]*?this\._render\(\);/);
  assert.match(comp, /async _persistSubOrder\([\s\S]*?catch \(err\) \{[\s\S]*?this\._render\(\);/);
});

test('category-manager: aria-live-Region sagt Umsortierungen an', () => {
  assert.match(comp, /role="status" aria-live="polite" id="cat-manager-announce"/);
  assert.match(comp, /_announce\(message\)/);
  assert.match(comp, /t\('category\.reorderAnnounce'/);
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
