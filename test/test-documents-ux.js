/**
 * Dokumente-Modul: UX-/UI-Audit-Verträge.
 *
 * Pinnt die Befunde des UX-Audits, damit sie nicht zurückfallen. Jeder Test
 * benennt das konkrete Fehlverhalten, das er verhindert — nicht nur die Regel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), 'utf8');

const page = read('../public/pages/documents.js');
const css = read('../public/styles/documents.css');
const chipCss = read('../public/styles/filter-chip.css');
const indexHtml = read('../public/index.html');
const de = JSON.parse(read('../public/locales/de.json'));

// --------------------------------------------------------
// P0 — Leerzustände
// --------------------------------------------------------

test('der Leerzustand unterscheidet Suche, Filter, Archiv und Erstnutzung', () => {
  // Vorher gab es EINEN Zustand: eine Suche ohne Treffer behauptete "Noch keine
  // Dokumente" und bot Hochladen an, während der Ordner-Browser daneben 6 zählte.
  assert.match(page, /function emptyStateFor\(\)/);
  for (const key of [
    'documents.emptySearchTitle',
    'documents.emptyFilterTitle',
    'documents.emptyArchivedTitle',
    'documents.emptyTitle',
  ]) {
    assert.ok(page.includes(`t('${key}')`), `Leerzustand ${key} fehlt`);
  }
});

test('Such- und Filter-Leerzustand bieten die auflösende Aktion an, nicht "Hochladen"', () => {
  assert.match(page, /documents-empty-clear-search/);
  assert.match(page, /documents-empty-reset/);
  assert.match(page, /function resetFilters\(\)/);
  assert.match(page, /function clearSearch\(\)/);
  // Die Suchvariante darf nicht die Upload-Aktion als Primäraktion führen.
  const searchBranch = page.slice(page.indexOf('if (state.query)'), page.indexOf('if (hasActiveFilter())'));
  assert.doesNotMatch(searchBranch, /documents-empty-upload/);
});

test('der Archiv-Leerzustand führt zurück in die aktive Liste', () => {
  assert.match(page, /documents-empty-active/);
  assert.ok(page.includes("t('documents.showActiveAction')"));
});

// --------------------------------------------------------
// P0 — Kategorie-Facette
// --------------------------------------------------------

test('Kategorie-Chips sind Facetten mit Trefferzahl statt 15 fester Filter', () => {
  assert.match(page, /function categoryCounts\(\)/);
  assert.match(page, /function renderCategoryChips\(\)/);
  // Nur belegte Kategorien (oder die gerade aktive) werden gerendert.
  assert.match(page, /CATEGORIES\.filter\(\(category\) => counts\.get\(category\) \|\| category === state\.category\)/);
  assert.match(page, /filter-chip__count/);
  assert.match(chipCss, /\.filter-chip__count\s*\{/);
});

test('Kategorie und Ordner zählen sich gegenseitig heraus (echte Facetten)', () => {
  // Ein Zähler darf nie ins Leere führen: jede Achse zählt unter der jeweils
  // anderen, aber nicht unter sich selbst.
  assert.match(page, /function folderCounts\(\)[\s\S]{0,120}state\.allDocuments\.filter\(matchesCategory\)/);
  assert.match(page, /function categoryCounts\(\)[\s\S]{0,120}state\.allDocuments\.filter\(matchesFolder\)/);
});

test('der Kategoriefilter läuft client-seitig ohne Netzwerk-Roundtrip', () => {
  // /documents wird nur noch nach Status gefiltert — sonst ließen sich keine
  // ehrlichen Kategoriezähler bilden.
  assert.match(page, /\/documents\?status=\$\{encodeURIComponent\(state\.status\)\}/);
  assert.doesNotMatch(page, /params\.set\('category'/);
});

// --------------------------------------------------------
// P1 — CSS-Reihenfolge, Fokus, Touch
// --------------------------------------------------------

test('die Kategorie-Facette bleibt einzeilig statt unbegrenzt zu wachsen', () => {
  // Bei 375px Fensterbreite stapelten sich 15 Chips auf 8 Zeilen (461px hoch),
  // das erste Dokument lag damit unter der Falz.
  assert.match(css, /\.documents-filter-chips\s*\{[^}]*overflow-x:\s*auto/);
  // Die tote Desktop-Override-Regel (stand VOR der Basisregel und verlor daher)
  // darf nicht zurückkommen.
  assert.doesNotMatch(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]{0,200}border-inline-start:\s*none/);
});

test('die Dropzone zeigt den Tastaturfokus des versteckten Datei-Inputs', () => {
  // Der Input ist sr-only (1x1px, geclippt) aber tab-fokussierbar — ohne diese
  // Regel verschwand der Fokus beim Durchtabben spurlos.
  assert.match(css, /\.document-dropzone:focus-within\s*\{[^}]*outline:/);
});

test('kompakte Chips halten das Touch-Maß über die Zeigergenauigkeit, nicht die Breite', () => {
  // Ein Tablet im Hochformat (768–1023px) ist Touch und bekam über eine reine
  // max-width-Regel 32px-Chips — unter dem 44pt-Minimum.
  assert.match(chipCss, /@media \(hover: none\)\s*\{[^}]*\.filter-chip--sm\s*\{[^}]*min-height:\s*var\(--target-base\)/);
  assert.doesNotMatch(css, /\.documents-filter-chip\b/);
});

// --------------------------------------------------------
// P1 — Upload-Modal
// --------------------------------------------------------

test('das Namensfeld erzwingt beim Anlegen nichts, damit der Dateiname-Fallback greift', () => {
  // `required` machte den vorhandenen Auto-Namen-Fallback unerreichbar.
  assert.match(page, /id="document-name"[^>]*\$\{isEdit \? 'required'/);
  assert.match(page, /file\.name\.replace\(\/\\\.\[\^\.\]\+\$\/, ''\)/);
});

test('die Datei steht im Anlege-Formular vor den Metadaten', () => {
  const form = page.slice(page.indexOf('<form id="document-form"'), page.indexOf('id="document-error"'));
  assert.ok(
    form.indexOf('${isEdit ? \'\' : fileFieldHtml}') < form.indexOf('id="document-name"'),
    'Die Datei muss vor dem Namensfeld stehen — sie liefert den Namen',
  );
});

test('Kategorie-Default ist "Sonstiges", nicht die erste Listenposition', () => {
  // Default war `medical` (erstes Element) — unaufmerksame Uploads landeten in
  // der sensibelsten Kategorie.
  assert.match(page, /\(doc\?\.category \|\| 'other'\) === category/);
});

test('der Upload akzeptiert mehrere Dateien und meldet Fortschritt', () => {
  assert.match(page, /id="document-file" type="file" multiple/);
  assert.match(page, /accept="\$\{esc\(state\.allowedMimeTypes\.join\(','\)\)\}"/);
  assert.ok(page.includes("t('documents.uploadProgress'"));
});

test('Grenzwerte kommen vom Server statt aus einer Client-Kopie', () => {
  assert.match(page, /state\.maxFileSize = Number\(res\.data\?\.max_file_size\)/);
  assert.match(page, /state\.allowedMimeTypes = Array\.isArray\(res\.data\?\.allowed_mime_types\)/);
});

test('die Sichtbarkeit liegt offen im Formular, nicht im Akkordeon', () => {
  // Sie ist das beworbene Kernversprechen ("steuere, wer jede Datei sehen darf").
  const advanced = page.slice(page.indexOf('const advancedFieldsHtml'), page.indexOf('const fileFieldHtml'));
  assert.doesNotMatch(advanced, /id="document-visibility"/);
  assert.match(page, /id="document-visibility"/);
});

// --------------------------------------------------------
// P2 — Konsistenz
// --------------------------------------------------------

test('Dokumente nutzen die geteilte Chip-Vokabel statt einer vierten Kopie', () => {
  assert.match(indexHtml, /styles\/filter-chip\.css/);
  assert.match(page, /class="filter-chip filter-chip--sm/);
  // Die Basis darf nur an einer Stelle definiert sein.
  const tasksCss = read('../public/styles/tasks.css');
  assert.doesNotMatch(tasksCss, /^\.filter-chip\s*\{/m);
  assert.match(chipCss, /^\.filter-chip\s*\{/m);
});

test('das Kontextmenü nutzt die native Popover-API wie die Kontakte', () => {
  assert.match(page, /menu\.setAttribute\('popover', 'auto'\)/);
  assert.match(page, /menu\.showPopover\(\)/);
  assert.match(css, /\.documents-context-menu:popover-open\s*\{[^}]*display:\s*flex/);
  // Die handgebaute Outside-Click-Verwaltung ist damit weg.
  assert.doesNotMatch(page, /document\.addEventListener\('click', onDoc, true\)/);
});

test('beide Kebab-Auslöser kündigen ihr Menü gleich an', () => {
  const folderMenu = page.slice(page.indexOf('data-folder-menu='), page.indexOf('data-folder-menu=') + 400);
  assert.match(folderMenu, /aria-haspopup="menu"/);
  assert.match(folderMenu, /aria-expanded="false"/);
});

test('die Bearbeiten-Aktion heißt wie überall sonst "Bearbeiten"', () => {
  // Label war "Einstellungen" neben einem Stift-Icon.
  assert.ok(page.includes("data-menu-action=\"edit\""));
  assert.match(page, /data-menu-action="edit"[\s\S]{0,140}t\('common\.edit'\)/);
  assert.equal(de.documents.editAction, undefined, 'editAction ist ersetzt und muss entfernt sein');
});

test('die Listenansicht trägt Datum und Größe als eigene Spalten', () => {
  // Vorher zeigte die Zeile kein Datum — der Wechsel Raster→Liste nahm Information weg.
  assert.match(page, /document-row__stats/);
  assert.match(page, /document-row__date/);
  assert.match(page, /renderMeta\(doc, \{ showSize: false \}\)/);
  assert.match(css, /\.document-row__stats\s*\{/);
});

test('die Liste ist sortierbar und merkt sich die Wahl', () => {
  assert.match(page, /const SORTS = \['updated', 'name', 'size'\]/);
  assert.match(page, /localStorage\.setItem\('yuvomi-documents-sort'/);
  assert.match(page, /function sortDocuments\(/);
});

// --------------------------------------------------------
// P3 — Restbefunde
// --------------------------------------------------------

test('der DMS-Button belegt seinen Platz von Anfang an (kein Layout-Sprung)', () => {
  // Er wurde früher erst nach dem await nachgehängt und schob die Ansicht-Umschaltung zur Seite.
  assert.match(page, /id="documents-dms-link-btn"[\s\S]{0,300}hidden>/);
  assert.match(page, /btn\.hidden = !state\.dmsAccounts\.length/);
});

test('die DMS-Suche unterscheidet Fehler von "keine Treffer"', () => {
  // Ein toter DMS-Server sah vorher aus wie ein leeres Suchergebnis.
  assert.match(page, /const showSearchError = \(q\) =>/);
  assert.ok(page.includes("t('documents.dmsSearchError')"));
  assert.ok(page.includes("t('common.retry')"));
  assert.ok(page.includes("t('documents.dmsSearching')"));
});

test('das DMS-Suchfeld hat ein sichtbares Label', () => {
  assert.match(page, /searchLabel\.setAttribute\('for', 'dms-search'\)/);
  assert.ok(page.includes("t('documents.dmsSearchLabel')"));
});

test('die DMS-Verknüpfung erbt nicht stillschweigend das aktive Filter-Chip', () => {
  const linkCall = page.slice(page.indexOf("api.post('/documents/dms/link'"), page.indexOf("api.post('/documents/dms/link'") + 260);
  assert.match(linkCall, /category: 'other'/);
  assert.doesNotMatch(linkCall, /state\.category/);
});

test('die DMS-Vorschau ist groß genug zum Erkennen und lässt sich vergrößern (#536)', () => {
  // 40x40 zeigte nur einen grauen Fleck: die Kachel steht jetzt im Seitenformat
  // und der Seitenkopf bleibt sichtbar, statt mittig weggeschnitten zu werden.
  const media = css.slice(css.indexOf('.dms-result__media {'), css.indexOf('.dms-result__media svg'));
  assert.match(media, /width:\s*72px/);
  assert.match(media, /height:\s*96px/);
  assert.match(css, /\.dms-result__thumb\s*\{[^}]*object-position:\s*top/);

  // Klick auf die Kachel öffnet die große Vorschau - kein zweites openModal,
  // weil das Modal-System genau ein Overlay hält.
  assert.match(page, /function openDmsPreview\(/);
  assert.ok(page.includes("t('documents.dmsPreviewOpen')"));
  const preview = page.slice(page.indexOf('function openDmsPreview('), page.indexOf('function readFileAsDataUrl'));
  assert.doesNotMatch(preview, /openSharedModal|openModal\(/);
  // Escape schließt zuerst nur die Vorschau (Capture-Phase vor dem Modal-Handler).
  assert.match(preview, /addEventListener\('keydown', onKey, true\)/);
  assert.match(preview, /e\.stopPropagation\(\)/);
  // Verknüpfen ist direkt aus der Vorschau möglich und teilt sich den Pfad mit der Liste.
  assert.ok(preview.includes("t('documents.dmsLinkBtn')"));
  assert.match(page, /async function linkDmsDocument\(/);
});

test('Mehrfachauswahl ist opt-in und standardmäßig verborgen', () => {
  assert.match(page, /id="documents-selectbar"[^>]*hidden>/);
  // `.btn` und die Selectbar setzen ein eigenes display und schlagen sonst das
  // UA-`[hidden] { display: none }` — der DMS-Button blieb dadurch sichtbar,
  // obwohl kein DMS-Konto existierte.
  assert.match(
    css,
    /\.documents-selectbar\[hidden\],\s*\.documents-dms-link-btn\[hidden\]\s*\{[^}]*display:\s*none/,
  );
  for (const fn of ['enterSelectMode', 'exitSelectMode', 'toggleSelectAll', 'moveSelected', 'archiveSelected', 'deleteSelected']) {
    assert.ok(page.includes(`function ${fn}`), `${fn} fehlt`);
  }
});

test('Google Drive has a distinct upload label, icon and storage badge', () => {
  assert.match(page, /backend === 'google_drive'\) return t\('documents\.storageGoogleDrive'\)/);
  assert.match(page, /backend === 'google_drive'\) return 'cloud-upload'/);
  assert.match(page, /doc-badge--google-drive/);
  assert.match(css, /\.doc-badge--google-drive\s*\{/);
  assert.doesNotMatch(css, /\.doc-badge--google-drive\s*\{[^}]*#[0-9a-f]{3,8}/i);
});

test('die Speicher-Einstellungen sind von der Seite aus verlinkt — nur für Admins', () => {
  assert.match(page, /state\.isAdmin \? `<a class="document-storage-target__link" href="\/settings\/documents\/storage"/);
  const routes = read('../server/routes/documents.js');
  assert.match(routes, /is_admin: isAdmin\(req\)/);
});

test('das Rückgängig-Löschen stellt die Server-Sortierung wieder her', () => {
  // Vorher wurde beim Undo fest nach Namen sortiert, was die Datums-Ordnung zerschoss.
  assert.match(page, /function deleteDocuments\(docs\)/);
  const del = page.slice(page.indexOf('function deleteDocuments'), page.indexOf('function deleteDocuments') + 1400);
  assert.doesNotMatch(del, /localeCompare/);
  assert.match(del, /applyFilters\(\)/);
  // Kein Nachladen auf einen abgehängten Container nach Seitenwechsel.
  assert.match(del, /if \(_container !== owner\) return/);
});

test('das Speichern referenziert den Submit-Button am Panel, nicht am Formular (#543)', () => {
  // Der Modal-Footer mit dem Submit-Button wird beim Öffnen ans Panel gehoben und
  // liegt außerhalb des Formular-DOM. form.querySelector('#document-submit') fände
  // dann null, und submit.disabled würfe einen unbehandelten TypeError, der als
  // generischer Fehler-Toast erscheint, statt das Dokument zu speichern.
  assert.match(page, /async function saveDocument\(event, doc, panel\)/);
  const save = page.slice(page.indexOf('async function saveDocument'), page.indexOf('async function saveDocument') + 900);
  assert.match(save, /panel\.querySelector\('#document-submit'\)/);
  assert.doesNotMatch(save, /form\.querySelector\('#document-submit'\)/);
  // Der Submit-Handler reicht das Panel an saveDocument durch.
  assert.match(page, /saveDocument\(event, doc, panel\)/);
});
