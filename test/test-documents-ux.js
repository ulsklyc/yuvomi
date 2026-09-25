/**
 * Dokumente-Modul: UX-/UI-Audit-Verträge.
 *
 * Pinnt die Befunde des UX-Audits, damit sie nicht zurückfallen. Jeder Test
 * benennt das konkrete Fehlverhalten, das er verhindert — nicht nur die Regel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { eachRule } from './css-rules.js';

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
  assert.match(page, /CATEGORIES\.filter\(\(category\) => present\.get\(category\) \|\| category === state\.category\)/);
  assert.match(page, /filter-chip__count/);
  assert.match(chipCss, /\.filter-chip__count\s*\{/);
});

test('Kategorie und Ordner zählen sich gegenseitig heraus (echte Facetten)', () => {
  // Ein Zähler darf nie ins Leere führen: jede Achse zählt unter der jeweils
  // anderen, aber nicht unter sich selbst.
  // Seit 2026-09-25 rechnet utils/document-facets.js; die Seite reicht die
  // jeweils andere Achse als `inScope` hinein.
  assert.match(page, /function folderCounts\(\)[\s\S]{0,200}inScope: matchesCategory/);
  assert.match(page, /function categoryCounts\(\)[\s\S]{0,200}inScope: matchesFolder/);
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
  assert.match(css, /\.documents-filters__chips\s*\{[^}]*overflow-x:\s*auto/);
  // Die tote Desktop-Override-Regel (stand VOR der Basisregel und verlor daher)
  // darf nicht zurückkommen.
  assert.doesNotMatch(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]{0,200}border-inline-start:\s*none/);
});

test('die Dropzone zeigt den Tastaturfokus des versteckten Datei-Inputs', () => {
  // Der Input ist sr-only (1x1px, geclippt) aber tab-fokussierbar — ohne diese
  // Regel verschwand der Fokus beim Durchtabben spurlos.
  //
  // Die Dropzone stand bis Runde 6 / Phase 4e doppelt (calendar.css und
  // documents.css) und wohnt seitdem EINMAL in document-attach.css. Die Zusage
  // gilt der Komponente, nicht der Datei, in der sie zufällig lag.
  assert.match(read('../public/styles/document-attach.css'),
    /\.document-dropzone:focus-within\s*\{[^}]*outline:/);
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
  assert.match(read('../public/utils/document-facets.js'), /export const DOCUMENT_SORTS = \['updated', 'name', 'size', 'expiring'\]/);
  assert.match(page, /const SORTS = DOCUMENT_SORTS/);
  assert.match(page, /localStorage\.setItem\('yuvomi-documents-sort', state\.sort\)/);
  assert.match(page, /localStorage\.setItem\('yuvomi-documents-sort-dir', state\.sortDirection\)/);
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

test('Ordnerlöschung bietet Behalten oder Mitlöschen mit exakten Server-Zahlen an', () => {
  const block = page.slice(page.indexOf('function folderDeleteChoice('), page.indexOf('// `showSize`'));
  assert.match(block, /delete-impact/);
  assert.match(block, /modal-actions modal-actions--stack/);
  assert.match(block, /documents-folder-delete-unfile/);
  assert.match(block, /documents-folder-delete-documents/);
  assert.match(block, /can_delete_documents/);
  assert.match(block, /documents=\$\{choice\}/);
  assert.match(block, /expected_documents=\$\{impact\.documents\}/);
  assert.match(block, /expected_folders=\$\{impact\.removed_folders\}/);
  assert.match(block, /choice === 'delete'[\s\S]*expected_snapshot=\$\{encodeURIComponent\(impact\.snapshot\)\}/);
  assert.match(block, /const expectedSnapshot = choice === 'delete'[\s\S]*: '';/);
  assert.match(block, /handleError: \(err\) => handleFolderDeleteError\(err, folder, \{ delayed: true \}\)/);
  assert.match(block, /catch \(err\) \{\s*await handleFolderDeleteError\(err, folder\);\s*\}/);
  assert.match(block, /function handleFolderDeleteError[\s\S]{0,260}handleFolderDeleteFailure\(\{/);
  assert.match(block, /result\.contents_changed[\s\S]*folderDeleteContentsChangedToast/);
  assert.match(block, /failed_documents[\s\S]*failure_stage !== 'concurrency'/);
  assert.match(block, /result\.folder_deleted === false && result\.contents_changed && hasNonConcurrencyFailure[\s\S]*folderDeleteContentsChangedWithFailuresToast/);
  assert.match(block, /linked_records/);
  for (const key of ['nav.calendar', 'nav.housekeeping', 'splitExpenses.title', 'nav.tasks', 'nav.budget', 'nav.inventory']) {
    assert.ok(block.includes(`t('${key}')`), `linked-record module label ${key} is missing`);
  }
  assert.ok(block.includes("t('documents.deleteFolderKeepDocuments'"));
  assert.ok(block.includes("t('documents.deleteFolderWithDocuments'"));
});

test('Ordner mit nur unsichtbaren Dokumenten erklärt die fehlende Löschoption', () => {
  const block = page.slice(page.indexOf('async function deleteFolder(folder)'), page.indexOf('\nfunction openFolderModal'));
  assert.match(block, /impact\.documents > 0\s*\|\|\s*!impact\.can_delete_documents/);
});

test('ein leerer Ordner bestätigt den exakten Null-Dokumente-Impact', () => {
  const start = page.indexOf('if (impact.documents > 0 || !impact.can_delete_documents)');
  const branch = page.slice(start, page.indexOf('if (!choice)', start));
  assert.match(branch, /deleteFolderImpact/);
  assert.match(branch, /documents:\s*0/);
  assert.doesNotMatch(branch, /deleteFolderConfirmDetail|deleteFolderSubtreeDetail/);
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
  // Unterscheidbar ueber Glyphe und Text, nicht ueber eine eigene Farbe
  // (Ortsetiketten teilen seit 2026-09-25 den records-Ton, Test weiter unten).
  assert.match(page, /doc-badge--google-drive"><i data-lucide="cloud"/);
  const rule = [...eachRule(css)].find((r) => r.selector.split(',').map((x) => x.trim()).includes('.doc-badge--google-drive'));
  assert.ok(rule, '.doc-badge--google-drive fehlt');
  assert.doesNotMatch(rule.body, /#[0-9a-f]{3,8}/i);
});

test('Upload-Ziel nutzt die lesbare gemeinsame Formularsteuerung', () => {
  const storageSettings = read('../public/settings/pages/documents-storage.js');
  assert.match(storageSettings, /select\.className\s*=\s*(['"])form-input\1/);
  assert.doesNotMatch(storageSettings, /select\.className\s*=\s*(['"])form-select\1/);
});

test('nicht konfigurierte Upload-Ziele sind nicht auswählbar', () => {
  const storageSettings = read('../public/settings/pages/documents-storage.js');
  assert.match(storageSettings, /const availableBackends\s*=\s*new Set\(\[(['"])local\1\]\)/);
  assert.match(storageSettings, /data\.enabled\s*&&\s*data\.configured/);
  assert.match(storageSettings, /drive\.configured\s*&&\s*drive\.connected/);
  assert.match(storageSettings, /option\.disabled\s*=\s*!availableBackends\.has\(backend\)/);
});

test('die Speicher-Einstellungen sind von der Seite aus verlinkt — nur für Admins', () => {
  // Blatt liegt seit dem IA-Umbau unter `sync` (Critique 2026-07-27).
  assert.match(page, /state\.isAdmin \? `<a class="document-storage-target__link" href="\/settings\/sync\/storage"/);
  const routes = read('../server/routes/documents.js');
  assert.match(routes, /is_admin: isAdminRequest\(req\)/);
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

test('alle unterstützten Sprachen enthalten die Optionen für die Ordnerlöschung', () => {
  const localeDir = resolve(HERE, '../public/locales');
  const files = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
  const keys = [
    'deleteFolderImpact',
    'deleteFolderKeepDocuments',
    'deleteFolderKeepDocuments_one',
    'deleteFolderWithDocuments',
    'deleteFolderWithDocuments_one',
    'deleteFolderDocumentsUnavailable',
    'deleteFolderLinkedRecords',
    'folderDeletedWithDocumentsToast',
    'folderDeletedWithDocumentsToast_one',
    'folderDeletePartialToast',
    'folderDeleteContentsChangedBeforeCommitToast',
    'folderDeleteContentsChangedToast',
    'folderDeleteContentsChangedWithFailuresToast',
    'folderDeleteInProgressToast',
  ];

  for (const file of files) {
    const documents = JSON.parse(read(`../public/locales/${file}`)).documents;
    for (const key of keys) {
      assert.equal(typeof documents?.[key], 'string', `${file}: ${key} fehlt`);
      assert.notEqual(documents[key].trim(), '', `${file}: ${key} ist leer`);
    }
    assert.equal('deleteFolderConfirmDetail' in documents, false,
      `${file}: deleteFolderConfirmDetail wird nicht mehr verwendet`);
    assert.equal('deleteFolderSubtreeDetail' in documents, false,
      `${file}: deleteFolderSubtreeDetail wird nicht mehr verwendet`);
    assert.equal('deleteFolderSubtreeDetail_one' in documents, false,
      `${file}: deleteFolderSubtreeDetail_one wird nicht mehr verwendet`);
  }

  const english = JSON.parse(read('../public/locales/en.json')).documents;
  assert.match(english.deleteFolderLinkedRecords, /^If you also delete the documents,/);
});

// --------------------------------------------------------
// Folder tree upload
// --------------------------------------------------------

test('folder upload is a separate choice and does not change the regular multi-file input', () => {
  assert.match(page, /from '\/utils\/folder-upload\.js'/);
  assert.match(page, /id="document-file" type="file" multiple/);
  assert.match(page, /id="document-folder-input" type="file" webkitdirectory/);
  assert.match(page, /supportsDirectoryUpload,/);
  assert.match(page, /function canPickDirectory\(\)/);
  assert.match(page, /navigator\.maxTouchPoints/);
});

test('folder upload offers its secondary link only when the browser supports it', () => {
  // Since the 2026-09-25 critique the page head no longer carries a folder
  // action: the link below the drop zone is the one way, and it opens the
  // native picker within the same click (no timeout - browsers may block a
  // delayed programmatic click).
  const binding = page.slice(page.indexOf('function bindFolderUpload'), page.indexOf('function updateFolderUploadProgress'));
  assert.match(binding, /const directorySupported = canPickDirectory\(\)/);
  assert.match(binding, /folderChoice\.hidden = !directorySupported/);
  assert.match(binding, /folderChoice\?\.addEventListener\('click', \(\) => folderInput\.click\(\)\)/);
  assert.doesNotMatch(page, /initialUpload/);
  assert.ok(page.includes("t('documents.folderUpload.chooseFolder')"));
});

test('folder upload shows one preview with conflicts and rejected files before writing', () => {
  assert.match(page, /function renderFolderUploadPreview\(/);
  assert.match(page, /id="document-folder-upload-preview"/);
  assert.match(page, /data-folder-conflict-default/);
  assert.match(page, /data-file-conflict-default/);
  assert.match(page, /data-folder-conflict-key/);
  assert.doesNotMatch(page, /data-file-conflict-key/);
  assert.match(page, /folder-upload-tree/);
  assert.match(page, /role="list"/);
  assert.match(page, /role="listitem"/);
  assert.doesNotMatch(page, /role="tree"|role="treeitem"/);
  assert.match(page, /folder-upload-rejected/);
  assert.match(page, /panel\._folderUpload\.ready = false/);
  assert.match(page, /panel\._folderUpload\.ready = true/);
});

test('dropping files emits the ordinary input change path that clears a selected folder', () => {
  const drop = page.slice(page.indexOf("dropzone.addEventListener('drop'"), page.indexOf('const FOLDER_UPLOAD_REASON_KEYS'));
  assert.match(drop, /input\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.doesNotMatch(drop, /syncSelectedFile\(\);/);
  const normalFileChange = page.slice(page.indexOf("fileInput.addEventListener('change'"), page.indexOf("folderInput.addEventListener('change'"));
  assert.match(normalFileChange, /submit\.textContent = t\('documents\.uploadAction'\)/);
});

test('folder conflict metadata reuses the already loaded status and fetches only its counterpart', () => {
  const loader = page.slice(page.indexOf('async function loadUploadConflictDocuments'), page.indexOf('function folderUploadTargetId'));
  assert.match(loader, /state\.allDocuments/);
  assert.match(loader, /state\.status === 'active' \? 'archived' : 'active'/);
  assert.doesNotMatch(loader, /Promise\.all/);
});

test('folder upload keeps sequential writes, exposes cancellation and preserves failures', () => {
  assert.match(page, /executeFolderUploadPlan\(/);
  assert.match(page, /function updateFolderUploadProgress\(/);
  assert.match(page, /function renderFolderUploadResult\(/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /data-folder-upload-cancel/);
  assert.match(page, /shouldCancel:/);
  assert.ok(page.includes("t('documents.folderUpload.failedTitle')"));
  assert.match(page, /await loadUploadConflictDocuments\(\)/);
  assert.match(page, /plan\.counts\.upload < 1 && plan\.counts\.createFolders < 1/);
});

test('running folder uploads freeze plan controls, cancel on modal close, and surface non-success outcomes', () => {
  const modal = page.slice(page.indexOf('function openDocumentModal'), page.indexOf('function bindDropzone'));
  assert.match(modal, /onClose\(\)\s*\{[\s\S]*requestFolderUploadCancel/);
  const binding = page.slice(page.indexOf('function bindFolderUpload'), page.indexOf('function updateFolderUploadProgress'));
  assert.match(binding, /if \(panel\._folderUpload\.running\) return/);
  const save = page.slice(page.indexOf('async function saveFolderUpload'), page.indexOf('async function saveDocument'));
  assert.match(save, /setFolderUploadControlsDisabled\(panel, true\)/);
  assert.match(save, /folderUploadOutcome\(result\)/);
  assert.match(save, /runRateLimitedOperation\([\s\S]*loadFolders\(\)[\s\S]*loadDocuments\(\)/);
  assert.match(save, /catch \(refreshError\)[\s\S]*folderUploadOutcome\(result\)/);
  assert.match(save, /outcome\.tone/);
  assert.doesNotMatch(save, /uploadedToast', \{ count: result\.uploaded\.length \}\), 'success'/);
  const result = page.slice(page.indexOf('function renderFolderUploadResult'), page.indexOf('async function saveFolderUpload'));
  assert.match(result, /result\.cancelled[\s\S]*documents\.folderUpload\.cancelledDetail/);
  assert.match(page, /'rate-limited': 'documents\.folderUpload\.reasonRateLimited'/);
});

test('folder preview avoids horizontal overflow on mobile', () => {
  assert.match(css, /\.document-upload-meta\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.folder-upload-preview\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.folder-upload-tree__item\s*\{[^}]*min-width:\s*0[^}]*padding-inline-start:\s*calc\(/);
  const mobileConflictRule = [...eachRule(css)].find((rule) =>
    rule.selector === '.folder-upload-conflict'
      && rule.at.includes('@media (max-width: 639px)'),
  );
  assert.ok(mobileConflictRule, 'the conflict rule must live inside the mobile media query');
  assert.match(mobileConflictRule.body, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('every supported locale contains the complete folder-upload text set', () => {
  const localeDir = resolve(HERE, '../public/locales');
  const files = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
  const reference = JSON.parse(read('../public/locales/de.json')).documents.folderUpload;
  const expectedKeys = Object.keys(reference || {}).sort();
  assert.ok(expectedKeys.length > 0, 'de.json must define documents.folderUpload');

  for (const file of files) {
    const strings = JSON.parse(read(`../public/locales/${file}`)).documents?.folderUpload;
    assert.ok(strings, `${file}: documents.folderUpload is missing`);
    assert.deepEqual(Object.keys(strings).sort(), expectedKeys, `${file}: key set does not match`);
    for (const key of expectedKeys) {
      assert.equal(typeof strings[key], 'string', `${file}: ${key} is not a string`);
      assert.notEqual(strings[key].trim(), '', `${file}: ${key} is empty`);
    }
  }
});

test('folder-upload count labels have singular forms in every supported locale', () => {
  const localeDir = resolve(HERE, '../public/locales');
  const countKeys = ['selectedFolder', 'uploadAction', 'uploadedToast'];

  for (const file of readdirSync(localeDir).filter((entry) => entry.endsWith('.json'))) {
    const strings = JSON.parse(read(`../public/locales/${file}`)).documents.folderUpload;
    for (const key of countKeys) {
      assert.equal(typeof strings[`${key}_one`], 'string', `${file}: ${key}_one is missing`);
      assert.notEqual(strings[`${key}_one`].trim(), '', `${file}: ${key}_one is empty`);
    }
  }
});

test('new folder-upload locale copy does not introduce em or en dashes', () => {
  for (const file of ['ru.json', 'uk.json']) {
    const strings = JSON.parse(read(`../public/locales/${file}`)).documents.folderUpload;
    for (const value of Object.values(strings)) {
      assert.doesNotMatch(value, /[—–]/, `${file}: folder-upload copy must use hyphens`);
    }
  }
});

// --------------------------------------------------------
// Teilen ueber das Teilen-Menue des Geraets (D#1014)
// --------------------------------------------------------
import { SHAREABLE_MIME, isShareableMime, fileShareSupport } from '../public/utils/web-share.js';

test('die Teilbarkeit eines Typs wohnt in web-share.js und ist eine Teilmenge der Upload-Typen', () => {
  // Die Web Share API kennt keine Office-Formate. Wer die Liste im Viewer ein
  // zweites Mal ausschriebe, haette beim naechsten Upload-Typ zwei Wahrheiten.
  const server = read('../server/routes/documents.js');
  const allowed = server.slice(server.indexOf('const ALLOWED_MIME'), server.indexOf(']);', server.indexOf('const ALLOWED_MIME')));
  for (const mime of SHAREABLE_MIME) {
    assert.ok(allowed.includes(`'${mime}'`), `${mime} ist teilbar, aber kein Upload-Typ - die Liste ist keine Teilmenge mehr`);
  }
  assert.equal(isShareableMime('application/pdf'), true);
  assert.equal(isShareableMime('image/jpeg; charset=binary'), true, 'MIME-Parameter duerfen die Antwort nicht kippen');
  for (const office of [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]) {
    assert.equal(isShareableMime(office), false, `${office} steht nicht auf der Liste der Web Share API`);
  }
});

test('fileShareSupport unterscheidet Typ, Kontext und Browser - und fragt canShare mit einer leeren Probe', () => {
  // Seit der Re-Critique 2026-09-25 (P2) sind "kein sicherer Kontext" und "der
  // Browser kann es nicht" zwei Antworten: der Hinweis nannte in einem
  // sicheren Kontext ohne navigator.share HTTPS als moegliche Ursache.
  const seen = [];
  const nav = { share() {}, canShare(data) { seen.push(data); return true; } };
  class FakeFile {
    constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts?.type; }
  }
  const pdf = { name: 'pass.pdf', mime_type: 'application/pdf' };
  assert.equal(fileShareSupport({ name: 'x.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { navigator: nav, secure: true, FileCtor: FakeFile }), 'type');
  assert.equal(fileShareSupport(pdf, { navigator: nav, secure: false, FileCtor: FakeFile }), 'insecure', 'ohne sicheren Kontext gibt es navigator.share() nicht');
  assert.equal(fileShareSupport(pdf, { navigator: { share() {} }, secure: true, FileCtor: FakeFile }), 'browser', 'share ohne canShare reicht nicht');
  assert.equal(fileShareSupport(pdf, { navigator: { canShare: () => true }, secure: true, FileCtor: FakeFile }), 'browser', "'share' in navigator ist nicht die Frage");
  assert.equal(fileShareSupport(pdf, { navigator: { share() {}, canShare: () => false }, secure: true, FileCtor: FakeFile }), 'browser', 'der Browser hat das letzte Wort');
  assert.equal(fileShareSupport(pdf, { navigator: nav, secure: true, FileCtor: FakeFile }), 'ok');
  // Die Probe traegt den Typ und keinen Inhalt: gefragt wird, BEVOR geladen ist.
  const probe = seen.at(-1).files[0];
  assert.equal(probe.type, 'application/pdf');
  assert.deepEqual(probe.parts, []);
  assert.equal(fileShareSupport(pdf, { navigator: { share() {}, canShare() { throw new TypeError('nope'); } }, secure: true, FileCtor: FakeFile }), 'browser', 'ein werfendes canShare ist ein Nein, kein Absturz');
  // Ohne sicheren Kontext entscheidet der Kontext, auch wenn der Browser es koennte.
  assert.equal(fileShareSupport(pdf, { navigator: { share() {}, canShare: () => false }, secure: false, FileCtor: FakeFile }), 'insecure');
});

test('Teilen gibt es nur im Viewer, gated ueber die eine Probe, nie ueber "share in navigator"', () => {
  assert.match(page, /import \{ fileShareSupport \} from '\/utils\/web-share\.js'/);
  assert.match(page, /const shareSupport = fileShareSupport\(doc\)/);
  assert.doesNotMatch(page, /'share' in navigator/, 'das ist auch dort wahr, wo nur Links teilbar sind');
  assert.doesNotMatch(page, /navigator\.share\b[^(]/, 'navigator.share wird aufgerufen, nicht abgefragt');
  // Der Knopf existiert nur bei 'ok'; sonst steht die Erklaerung, kein toter Knopf.
  assert.match(page, /\$\{shareSupport === 'ok' \? `\s*<button type="button"[^>]*data-action="share"/);
  assert.match(page, /shareSupport !== 'ok' \? `<p class="document-viewer__note">\$\{t\(SHARE_NOTE_KEYS\[shareSupport\]\)\}<\/p>`/);
  // Die Zeile bleibt bei Ansehen/Download/Kebab.
  const actions = page.slice(page.indexOf('function renderActions(doc)'), page.indexOf('function renderSelectBox'));
  assert.doesNotMatch(actions, /share/i, 'kein Teilen in der Zeile - dort zaehlt der Klick sofort und die Datei ist noch nicht da');
});

test('die Datei wird beim Oeffnen geholt, der Klick muendet ohne await in navigator.share()', () => {
  const prep = page.slice(page.indexOf('function prepareShare(panel)'), page.indexOf('function renderViewerContent'));
  assert.match(prep, /fetch\(downloadUrl, \{ credentials: 'same-origin', signal: shareAbort\.signal \}\)/, 'derselbe authentifizierte Endpunkt, abbrechbar');
  assert.match(prep, /new File\(\[blob\], doc\.original_name \|\| doc\.name, \{ type: doc\.mime_type \}\)/);
  const click = prep.slice(prep.indexOf("btn.addEventListener('click'"));
  assert.doesNotMatch(click, /await|fetch\(/, 'zwischen Klick und share() darf nichts warten - iOS verbraucht sonst die Nutzeraktivierung');
  assert.match(click, /navigator\.canShare\(\{ files: \[shareFile\] \}\)/, 'der Browser entscheidet zuletzt, mit der echten Datei');
  assert.match(click, /navigator\.share\(\{ files: \[shareFile\], title: doc\.name \}\)/);
  assert.match(click, /err\?\.name === 'AbortError'\) return/, 'ein geschlossenes Teilen-Menue ist kein Fehler');
  // Beim Schliessen: Fetch abbrechen, Datei freigeben - der Viewer war bisher
  // die einzige Stelle, die nie ein Dokument in den Speicher holte.
  const close = page.slice(page.indexOf('onClose() {', page.indexOf('function openDocumentViewer')), page.indexOf('onSave(panel)', page.indexOf('function openDocumentViewer')));
  assert.match(close, /shareAbort\.abort\(\)/);
  assert.match(close, /shareFile = null/);
  // Der Knopf startet gesperrt und beschaeftigt, bis die Datei da ist.
  assert.match(page, /data-action="share" disabled aria-busy="true"/);
  assert.match(prep, /btn\.disabled = false;\s*btn\.removeAttribute\('aria-busy'\)/);
  for (const key of ['shareAction', 'sharePreparing', 'shareUnsupportedType', 'shareInsecure', 'shareBrowserUnsupported', 'shareFailed']) {
    assert.equal(typeof de.documents[key], 'string', `de.json: documents.${key} fehlt`);
  }
});

// --------------------------------------------------------
// Critique 2026-09-25 - Werkzeug-Last (Entscheidung 1)
// --------------------------------------------------------

const facets = await import('../public/utils/document-facets.js').catch(() => null);

/** Der Markup-Block der Filterzeile - von ihrem Oeffnen bis zum Browser-Layout. */
function filterRowMarkup() {
  const start = page.indexOf('<div class="documents-filters">');
  const end = page.indexOf('<div class="documents-browser-layout">');
  assert.ok(start > 0 && end > start, 'Filterzeile oder Browser-Layout nicht gefunden');
  return page.slice(start, end);
}

test('die Facetten-Zaehler zaehlen unter der aktiven Suche (als Programm)', () => {
  // Bei "Keine Treffer" zaehlten Kategorien und Ordner weiter 9 - ein Zaehler,
  // der auf eine Liste zeigt, die es unter dieser Suche nicht gibt.
  assert.ok(facets, 'public/utils/document-facets.js fehlt');
  const docs = [
    { id: 1, name: 'Police Hausrat', category: 'insurance', folder_id: 10, original_name: 'a.pdf' },
    { id: 2, name: 'Kfz-Schein', category: 'vehicle', folder_id: 11, original_name: 'b.pdf' },
    { id: 3, name: 'Arztbrief', description: 'Hausarzt Befund', category: 'medical', folder_id: null, original_name: 'c.pdf' },
    { id: 4, name: 'Police Kfz', category: 'insurance', folder_id: 11, original_name: 'd.pdf' },
  ];
  const folders = [{ id: 10, parent_id: null }, { id: 11, parent_id: 10 }];
  const subtreeOf = (id) => new Set(id === 10 ? [10, 11] : [id]);

  const cat = facets.categoryFacetCounts(docs, { query: 'police' });
  assert.equal(cat.get(''), 2);
  assert.equal(cat.get('insurance'), 2);
  assert.equal(cat.get('vehicle'), undefined, 'Kfz-Schein trifft "police" nicht');

  const none = facets.categoryFacetCounts(docs, { query: 'gibt es nicht' });
  assert.equal(none.get(''), 0, 'eine Suche ohne Treffer zaehlt 0, nicht den Bestand');

  const fold = facets.folderFacetCounts(docs, folders, { query: 'haus', subtreeOf });
  assert.equal(fold.get(''), 2, 'Name UND Beschreibung zaehlen');
  assert.equal(fold.get('__none'), 1);
  assert.equal(fold.get('10'), 1, 'Teilbaum: nur der Treffer in 10 selbst');
  assert.equal(fold.get('11'), 0);

  // Die andere Achse greift weiter zusammen mit der Suche.
  const scoped = facets.folderFacetCounts(docs, folders, {
    query: 'police', inScope: (doc) => doc.category === 'insurance', subtreeOf,
  });
  assert.equal(scoped.get('10'), 2, 'Ordner 10 zaehlt die Police aus seinem Unterordner mit');
});

test('die Seite zaehlt Kategorie, Ordner und Ablauf unter der Suche und zeichnet sie beim Tippen neu', () => {
  assert.match(page, /from '\/utils\/document-facets\.js'/);
  const cat = page.slice(page.indexOf('function categoryCounts()'), page.indexOf('function renderCategoryChips'));
  assert.match(cat, /categoryFacetCounts\(state\.allDocuments, \{ query: state\.query, inScope: matchesFolder \}\)/);
  const fold = page.slice(page.indexOf('function folderCounts()'), page.indexOf('function categoryCounts()'));
  assert.match(fold, /folderFacetCounts\(state\.allDocuments, state\.folders, \{[^}]*query: state\.query[^}]*inScope: matchesCategory/);
  const exp = page.slice(page.indexOf('function expiringCount()'), page.indexOf('function applyFilters'));
  assert.match(exp, /matchesDocumentQuery\(doc, state\.query\)/);
  // Die Liste nutzt dieselbe Suchregel wie die Zaehler - EINE Regel, zwei Leser.
  const list = page.slice(page.indexOf('function filteredDocuments()'), page.indexOf('function listClasses'));
  assert.match(list, /matchesDocumentQuery\(doc, state\.query\)/);
  // Die Suche zeichnet die Facetten mit, nicht nur die Liste.
  const onQuery = page.slice(page.indexOf("id: 'documents-search'", page.indexOf('function bindPageEvents')), page.indexOf("_container.querySelector('#documents-status')"));
  assert.match(onQuery, /renderFacets\(\)/);
});

test('die Sortierung ist umkehrbar und kennt je Schluessel ihre natuerliche Richtung (als Programm)', () => {
  assert.ok(facets, 'public/utils/document-facets.js fehlt');
  const docs = [
    { name: 'b', updated_at: '2026-01-02', file_size: 5, expires_at: '2026-03-01' },
    { name: 'a', updated_at: '2026-01-03', file_size: 1, expires_at: null },
    { name: 'c', updated_at: '2026-01-01', file_size: 9, expires_at: '2026-02-01' },
  ];
  const names = (list) => list.map((d) => d.name).join('');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'name' })), 'abc');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'name', direction: 'desc' })), 'cba');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'updated' })), 'abc', 'Neueste zuerst');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'updated', direction: 'asc' })), 'cba');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'size' })), 'cba', 'Groesste zuerst');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'expiring' })), 'cba');
  assert.equal(names(facets.sortDocuments(docs, { sort: 'expiring', direction: 'desc' })), 'bca',
    'ohne Ablaufdatum bleibt in beiden Richtungen am Ende');
  assert.equal(facets.defaultSortDirection('name'), 'asc');
  assert.equal(facets.defaultSortDirection('updated'), 'desc');
});

test('die Filterzeile traegt keine Werkzeuge mehr - Sortierung und Auswahl stehen im Kopf-Menue', () => {
  // Mobil lag die Filterzeile bei 1267px auf 375px Viewport, Sortierung bei
  // x=1020 und Auswahl bei x=1203 - erreichbar nur per Wischen ins Ungewisse.
  const row = filterRowMarkup();
  assert.doesNotMatch(row, /<select/, 'keine Sortier-Auswahl in der Filterzeile');
  assert.doesNotMatch(row, /documents-select-btn|documents-filters__end/, 'kein Auswahl-Knopf in der Filterzeile');
  assert.doesNotMatch(row, /class="btn\b/, 'kein Knopf ausser Segment und Chips');

  const toolbar = page.slice(page.indexOf('<div class="page-toolbar'), page.indexOf('<div class="documents-selectbar"'));
  assert.match(toolbar, /documentsToolsMenuHtml\(\)/, 'das Menue sitzt im Kopf');
  const menu = page.slice(page.indexOf('function documentsToolsMenuHtml'), page.indexOf('function bindPageEvents'));
  assert.match(menu, /class="popover-menu documents-tools-menu" id="documents-tools-menu" popover role="menu"/);
  assert.match(menu, /popovertarget="documents-tools-menu" aria-haspopup="menu" aria-expanded="false"/);
  assert.match(menu, /role="menuitemradio" aria-checked="\$\{on\}"[\s\S]*data-sort="/);
  assert.match(menu, /data-sort-direction="/, 'die Richtung ist umkehrbar');
  assert.match(menu, /role="menuitem"[^>]*data-action="enter-select"/);
  assert.match(page, /installPopoverMenus\(_container\)/, 'Pfeiltasten und Fokus kommen aus dem geteilten Menue');
  for (const key of ['toolsMenuLabel', 'sortDirectionLabel', 'sortAscending', 'sortDescending']) {
    assert.ok(page.includes(`t('documents.${key}')`), `documents.${key} wird nicht benutzt`);
    assert.equal(typeof de.documents[key], 'string', `de.json: documents.${key} fehlt`);
  }
  assert.doesNotMatch(de.documents.sortName, /\(|\u2013/, 'mit umkehrbarer Richtung ist "(A-Z)" eine Falschauskunft');
});

test('Aktiv/Archiviert ist ein Segment, und "Alle Kategorien" zeigt die Auswahl wie jede Chipreihe der App', () => {
  const row = filterRowMarkup();
  assert.match(row, /class="segmented documents-status" id="documents-status" role="radiogroup"/);
  assert.match(row, /class="segmented__item\$\{on \? ' is-active' : ''\}"[\s\S]{0,120}role="radio"/);
  assert.doesNotMatch(row, /data-status="[^"]*"[^>]*filter-chip|filter-chip[^>]*data-status=/, 'der Status ist kein Chip mehr');
  assert.match(page, /wireTablist\(_container\.querySelector\('#documents-status'\), \{[\s\S]{0,200}mode: 'select'/);
  // "Alle Kategorien" ist in einer Einfachauswahl eine echte Auswahl: es traegt
  // aria-pressed="true", und DESIGN.md sagt, der aktive Chip beantwortet
  // "wo bin ich". Ungetoent sagte er optisch "aus" und dem Screenreader "an".
  // Notizen, Inventar, Kontakte und Vorrat toenen ihr "Alle" ebenso; die
  // ungetoente Fassung vom 2026-09-25 war die Ausnahme (Entscheidung Betreiber).
  const chips = page.slice(page.indexOf('function renderCategoryChips'), page.indexOf('function renderExpiringChip'));
  const allChip = chips.slice(chips.indexOf('data-category=""') - 200, chips.indexOf('data-category=""') + 80);
  assert.match(allChip, /\$\{!state\.category \? ' filter-chip--active' : ''\}/, '"Alle Kategorien" toent wie jede gewaehlte Option');
  assert.match(allChip, /aria-pressed="\$\{!state\.category\}"/, 'Tonung und aria-pressed folgen derselben Bedingung');
});

test('mobil scrollt nur die Chip-Spur, nicht die Filterzeile', () => {
  const mobile = [...eachRule(css)].filter((rule) => rule.at.includes('@media (max-width: 767px)'));
  const rowRule = mobile.find((rule) => rule.selector === '.documents-filters');
  assert.ok(!rowRule || !/overflow-x:\s*auto/.test(rowRule.body), 'die Filterzeile selbst darf mobil nicht scrollen');
  const base = [...eachRule(css)].find((rule) => rule.selector === '.documents-filters' && rule.at.length === 0);
  assert.match(base.body, /overflow:\s*hidden/);
  const track = [...eachRule(css)].find((rule) => rule.selector === '.documents-filters__chips' && rule.at.length === 0);
  assert.ok(track, '.documents-filters__chips fehlt');
  assert.match(track.body, /overflow-x:\s*auto/);
  assert.match(track.body, /min-width:\s*0/);
  assert.match(page, /wireScrollFade\(_container\.querySelector\('\.documents-filters__chips'\)\)/);
});

test('der Upload hat EINEN Weg zur Dateiwahl, einen Nebenweg zum Ordner und EINEN Groessenhinweis', () => {
  // Vorher vier Wege (Kopf "Ordner hochladen", "Dateien auswaehlen", "Ordner
  // auswaehlen", Drop-Zone) und zwei 5-MB-Hinweise untereinander.
  assert.doesNotMatch(page, /id="documents-upload-folder"/, 'kein Kopfknopf "Ordner hochladen"');
  assert.doesNotMatch(page, /document-upload-choices|document-upload-choice\b/, 'keine zwei Wahlknoepfe ueber der Drop-Zone');
  const modal = page.slice(page.indexOf('function openDocumentModal'), page.indexOf('function bindDropzone'));
  assert.equal((modal.match(/<label class="document-dropzone"[^>]*for="document-file"/g) || []).length, 1);
  assert.match(modal, /<button type="button" class="document-folder-link" id="document-folder-choice"[^>]*hidden>/);
  assert.equal((modal.match(/id="document-size-hint"/g) || []).length, 1);
  const sizeHints = (page.match(/t\('documents\.(fileHint|folderUpload\.limitHint|folderUpload\.adminLimitHint)'/g) || []);
  assert.ok(sizeHints.length >= 2, 'Datei- und Ordnermodus haben je ihren Text');
  assert.doesNotMatch(modal, /documents\.fileHint[\s\S]{0,200}documents\.folderUpload\.limitHint/, 'nicht beide Hinweise nebeneinander');
  const preview = page.slice(page.indexOf('function renderFolderUploadPreview'), page.indexOf('function canPickDirectory'));
  assert.doesNotMatch(preview, /folder-upload-preview__limit/, 'die Vorschau wiederholt den Hinweis nicht');
  const binding = page.slice(page.indexOf('function bindFolderUpload'), page.indexOf('function updateFolderUploadProgress'));
  assert.match(binding, /folderChoice\.hidden = !directorySupported/, 'ohne Ordnerwahl im Browser kein Nebenlink');
  assert.match(binding, /folderChoice\?\.addEventListener\('click', \(\) => folderInput\.click\(\)\)/);
  assert.match(binding, /setSizeHint\(panel, 'folder'/);
  assert.match(binding, /setSizeHint\(panel, 'files'\)/);
  assert.equal(typeof de.documents.folderUpload.chooseFolder, 'string');
  assert.match(de.documents.folderUpload.chooseFolder, /^oder /);
});

// --------------------------------------------------------
// Critique 2026-09-25, Entscheidung 3 - Ablauf mobil
// --------------------------------------------------------

const expiry = await import('../public/utils/document-expiry.js').catch(() => null);

test('der Ablauf-Chip steht als ERSTES Meta-Element', () => {
  // Er stand zuletzt, und die Zeilen-Meta ist einzeilig mit overflow: hidden:
  // bei 375px war "Laeuft in 5 Tagen ab" 0px sichtbar (Critique P1) - genau
  // die Angabe, fuer die ein Ablaufdatum eingetragen wird.
  const meta = page.slice(page.indexOf('function renderMeta('), page.indexOf('function docSupportsThumbnail'));
  const chip = meta.indexOf('${expiryChipHtml(doc)}');
  const category = meta.indexOf('CATEGORY_ICONS[doc.category]');
  assert.ok(chip > 0, 'renderMeta zeigt den Ablauf-Chip');
  assert.ok(category > 0);
  assert.ok(chip < category, 'der Chip steht vor der Kategorie');
  assert.equal((meta.match(/expiryChipHtml\(doc\)/g) || []).length, 1, 'genau einmal');
});

test('die Zeilen-Meta laesst ganze Eintraege fallen statt sie in sich umzubrechen', () => {
  // Gemessen bei 375px: die Meta-Spans schrumpften als Flex-Items auf ihre
  // Mindestbreite und brachen INNEN um ("Ganze / Familie"), die Meta wurde
  // 35-69px hoch und die Zeilen sprangen zwischen 76 und 159px.
  const rules = [...eachRule(css)].filter((rule) => rule.at.length === 0);
  // Seit 2026-09-25 teilt die Rasterkarte diese Regeln (Selektorliste).
  const own = (selector) => (rule) => rule.selector.split(',').map((s) => s.trim()).includes(selector);
  const meta = rules.find((rule) => own('.document-row__meta')(rule) && /overflow/.test(rule.body));
  assert.ok(meta, '.document-row__meta fehlt');
  assert.match(meta.body, /flex-wrap:\s*wrap/);
  assert.match(meta.body, /overflow:\s*hidden/);
  assert.match(meta.body, /height:\s*calc\(1lh/, 'eine Zeile hoch, der Umbruch landet unsichtbar in Zeile zwei');
  const items = rules.find(own('.document-row__meta > *'));
  assert.ok(items, '.document-row__meta > * fehlt');
  assert.match(items.body, /white-space:\s*nowrap/);
  // Ist der Chip allein breiter als die Spalte ("Seit 10 Tagen abgelaufen"
  // 165px in 153px), kuerzt er mit Ellipse statt mitten im Buchstaben.
  const chip = rules.find(own('.document-row__meta > .doc-badge'));
  assert.ok(chip, '.document-row__meta > .doc-badge fehlt');
  assert.match(chip.body, /max-width:\s*100%/);
  assert.match(chip.body, /text-overflow:\s*ellipsis/);
  assert.match(chip.body, /display:\s*block/, 'text-overflow greift an keinem Flex-Container');
});

test('das Zeilen-Icon bleibt quadratisch', () => {
  // Mobil 28x42 (bis 14x42): die Kachel schrumpfte als Flex-Item mit, weil
  // die Textspalte ihre Basis aus der Meta-Zeile nimmt.
  const icon = [...eachRule(css)].find((rule) => rule.at.length === 0
    && rule.selector.split(',').map((s) => s.trim()).includes('.document-row__icon')
    && /width:\s*42px/.test(rule.body));
  assert.ok(icon, 'Icon-Regel fehlt');
  assert.match(icon.body, /flex-shrink:\s*0/);
});

test('Zeile und Viewer lesen den Ablauf aus EINER Regel (als Programm)', () => {
  assert.ok(expiry, 'public/utils/document-expiry.js fehlt');
  const status = (state, days) => ({ state, days, endDateKey: '2026-09-30' });
  // Zeile: nur wenn es Aufmerksamkeit braucht.
  assert.equal(expiry.expiryChipSpec(null), null);
  assert.equal(expiry.expiryChipSpec(status('valid', 200)), null);
  assert.deepEqual(expiry.expiryChipSpec(status('expiring', 5)),
    { tone: 'expiring', key: 'documents.expiringInDays', params: { count: 5 }, shortKey: 'documents.expiringShort' });
  assert.deepEqual(expiry.expiryChipSpec(status('expired', -10)),
    { tone: 'unavailable', key: 'documents.expiredDays', params: { count: 10 }, shortKey: 'documents.expiredShort' });
  // Viewer: immer, wenn ein Datum gesetzt ist - auch weit in der Zukunft.
  assert.equal(expiry.expiryViewerSpec(null), null);
  assert.deepEqual(expiry.expiryViewerSpec(status('valid', 200)),
    { tone: null, key: 'documents.expiryValidUntil', dateKey: '2026-09-30' });
  assert.deepEqual(expiry.expiryViewerSpec(status('expiring', 5)),
    { tone: 'expiring', key: 'documents.expiryEndsOn', dateKey: '2026-09-30' });
  assert.deepEqual(expiry.expiryViewerSpec(status('expired', -10)),
    { tone: 'unavailable', key: 'documents.expiryEndedOn', dateKey: '2026-09-30' });
  for (const key of ['expiryValidUntil', 'expiryEndsOn', 'expiryEndedOn']) {
    assert.match(de.documents[key] || '', /\{\{date\}\}/, `documents.${key} traegt {{date}}`);
  }
});

test('der Viewer nennt das Ablaufdatum in seiner Meta-Zeile', () => {
  const viewer = page.slice(page.indexOf('<div class="document-viewer__meta">'), page.indexOf('<span class="document-viewer__actions">'));
  assert.match(viewer, /\$\{expiryViewerHtml\(doc\)\}/);
  const fn = page.slice(page.indexOf('function expiryViewerHtml('), page.indexOf('function storageBadgeHtml'));
  assert.match(fn, /expiryViewerSpec\(dateStatus\(doc\.expires_at\)\)/);
  // Das Datum ist ein Tagesschluessel: formatDate() liest ihn als Wanduhrzeit,
  // ein Umweg ueber new Date()/toISOString() kippte je nach Zone auf den Vortag.
  assert.match(fn, /formatDate\(spec\.dateKey\)/);
  assert.doesNotMatch(fn, /new Date|toISOString/);
  assert.match(fn, /esc\(/);
});

// --------------------------------------------------------
// Critique 2026-09-25, Entscheidung 2 - Vorschaubilder lokaler Dokumente
// --------------------------------------------------------

const thumbs = await import('../public/utils/document-thumbs.js').catch(() => null);
const thumbsSrc = (() => {
  try { return read('../public/utils/document-thumbs.js'); } catch { return ''; }
})();

const MB = 1024 * 1024;
const localDoc = (over = {}) => ({
  id: 1, updated_at: '2026-09-25 10:00:00', storage_backend: 'local',
  mime_type: 'application/pdf', file_size: 120000, ...over,
});

test('eine Vorschau bekommen nur lokale Bilder und PDFs bis 10 MB (als Programm)', () => {
  assert.ok(thumbs, 'public/utils/document-thumbs.js fehlt');
  const kind = thumbs.documentThumbKind;
  assert.equal(kind(localDoc()), 'pdf');
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'IMAGE/JPEG; charset=binary']) {
    assert.equal(kind(localDoc({ mime_type: mime })), 'image', mime);
  }
  // Andere Typen: nichts zu zeigen, und kein Abruf.
  for (const mime of ['text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/svg+xml', '', null]) {
    assert.equal(kind(localDoc({ mime_type: mime })), null, String(mime));
  }
  // Nur lokal: Paperless hat seinen eigenen Thumbnail-Pfad, WebDAV/Drive
  // kaemen ueber das Netz eines Dritten.
  for (const backend of ['dms', 'webdav', 'google_drive']) {
    assert.equal(kind(localDoc({ storage_backend: backend })), null, backend);
  }
  assert.equal(kind(localDoc({ storage_backend: undefined, storage_provider: 'external' })), null, 'Altzeile eines DMS-Links');
  assert.equal(kind(localDoc({ storage_backend: undefined, storage_provider: 'local' })), 'pdf', 'Altzeile lokal');
  // Grenze: 10 MB gerade noch, darueber die Glyphe; unbekannte Groesse nie.
  assert.equal(kind(localDoc({ file_size: 10 * MB })), 'pdf');
  assert.equal(kind(localDoc({ file_size: 10 * MB + 1 })), null);
  for (const size of [0, -1, null, undefined, 'viel']) {
    assert.equal(kind(localDoc({ file_size: size })), null, `Groesse ${size}`);
  }
  assert.equal(kind(null), null);
});

/** Ein Abruf, der erst auf Zuruf antwortet - so laesst sich die Nebenlaeufigkeit zaehlen. */
function deferredFetch() {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve, reject });
  });
  const ok = (size = 1000) => ({ ok: true, status: 200, blob: async () => ({ size, type: 'application/pdf', arrayBuffer: async () => new ArrayBuffer(8) }) });
  return { calls, fetchImpl, ok };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Vorschauen laden hoechstens zwei gleichzeitig und ohne HTTP-Cache (als Programm)', async () => {
  assert.ok(thumbs, 'public/utils/document-thumbs.js fehlt');
  const net = deferredFetch();
  const ac = new AbortController();
  const store = thumbs.createDocumentThumbs({
    signal: ac.signal,
    fetchImpl: net.fetchImpl,
    renderers: { pdf: async () => 'data:image/jpeg;base64,AA', image: async () => 'data:image/webp;base64,AA' },
  });
  const loads = [1, 2, 3, 4, 5].map((id) => store.load(localDoc({ id })));
  await tick();
  assert.equal(net.calls.length, 2, 'zwei Abrufe, drei warten');
  assert.equal(store.queued, 3);
  // Jede Datei wird ohne HTTP-Cache geholt: keine Kopie auf der Platte.
  for (const call of net.calls) {
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.signal, ac.signal, 'der Abruf faellt mit der Seite');
    assert.match(call.url, /^\/api\/v1\/documents\/\d+\/preview$/);
  }
  net.calls[0].resolve(net.ok());
  await tick(); await tick(); await tick();
  assert.equal(net.calls.length, 3, 'ein freier Platz zieht genau einen nach');
  net.calls.slice(1).forEach((call) => call.resolve(net.ok()));
  await tick(); await tick(); await tick();
  net.calls.slice(3).forEach((call) => call.resolve(net.ok()));
  assert.deepEqual(await Promise.all(loads), Array(5).fill('data:image/jpeg;base64,AA'));
  assert.equal(net.calls.length, 5);
  // Zweiter Blick: aus dem Seitenspeicher, ohne neuen Abruf.
  assert.equal(store.peek(localDoc({ id: 3 })), 'data:image/jpeg;base64,AA');
  assert.equal(await store.load(localDoc({ id: 3 })), 'data:image/jpeg;base64,AA');
  assert.equal(net.calls.length, 5);
  // Eine ersetzte Datei (neues updated_at) ist eine neue Vorschau.
  assert.equal(store.peek(localDoc({ id: 3, updated_at: '2026-09-26 08:00:00' })), undefined);
  // Ohne Anspruch kein Abruf.
  assert.equal(await store.load(localDoc({ id: 9, file_size: 11 * MB })), null);
  assert.equal(net.calls.length, 5);
});

test('der Vorschau-Speicher lebt nur im Seitenspeicher', () => {
  // Arztbriefe und Ausweise: eine Kopie in IndexedDB, localStorage oder der
  // Cache-API laege unverschluesselt auf dem Geraet und ueberlebte die Abmeldung.
  assert.ok(thumbsSrc, 'public/utils/document-thumbs.js fehlt');
  const code = thumbsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const store of [/\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bcaches\s*\./, /\bCacheStorage\b/, /navigator\.storage/]) {
    assert.doesNotMatch(code, store, `document-thumbs.js benutzt ${store}`);
  }
  assert.match(code, /cache:\s*'no-store'/);
  assert.match(code, /new Map\(\)/, 'der Speicher ist eine Map');
  // Die Seite reicht den Speicher an nichts Persistentes weiter.
  const wiring = page.slice(page.indexOf('function wireLocalThumbs('), page.indexOf('function showLocalThumb('));
  assert.ok(wiring.length > 0, 'wireLocalThumbs fehlt');
  assert.doesNotMatch(wiring, /localStorage|sessionStorage|indexedDB|caches\./);
});

test('beim Verlassen der Seite faellt der Vorschau-Speicher (als Programm)', async () => {
  assert.ok(thumbs, 'public/utils/document-thumbs.js fehlt');
  const net = deferredFetch();
  const ac = new AbortController();
  let disposed = 0;
  const store = thumbs.createDocumentThumbs({
    signal: ac.signal,
    fetchImpl: net.fetchImpl,
    renderers: { pdf: async () => 'data:image/jpeg;base64,AA', image: async () => 'x', dispose: () => { disposed += 1; } },
  });
  const first = store.load(localDoc({ id: 1 }));
  await tick();
  net.calls[0].resolve(net.ok());
  assert.equal(await first, 'data:image/jpeg;base64,AA');
  assert.equal(store.size, 1);
  // Zwei laufen, zwei warten - dann verlaesst man die Seite.
  const running = [2, 3].map((id) => store.load(localDoc({ id })));
  const waiting = store.load(localDoc({ id: 4 }));
  const late = store.load(localDoc({ id: 5 }));
  await tick();
  assert.equal(store.queued, 2);
  ac.abort();
  assert.equal(store.size, 0, 'nichts bleibt im Speicher');
  assert.equal(store.queued, 0, 'die Warteschlange ist leer');
  assert.equal(disposed, 1, 'der pdf.js-Worker wird beendet');
  assert.equal(await waiting, null, 'ein wartender Auftrag haengt nicht ewig');
  assert.equal(await late, null);
  // Der abgebrochene Abruf endet still, auch wenn er noch eine Datei liefert.
  net.calls[1].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  net.calls[2].resolve(net.ok());
  assert.deepEqual(await Promise.all(running), [null, null]);
  assert.equal(store.size, 0, 'was nach dem Verlassen ankommt, wird nicht mehr gespeichert');
  // Und danach loest nichts mehr einen Abruf aus.
  const calls = net.calls.length;
  assert.equal(await store.load(localDoc({ id: 6 })), null);
  assert.equal(net.calls.length, calls);
});

test('kaputte und geschuetzte Dateien enden in der Glyphe, Programmierfehler nicht (als Programm)', async () => {
  assert.ok(thumbs, 'public/utils/document-thumbs.js fehlt');
  const pdfError = (name) => Object.assign(new Error(name), { name });
  const behaviours = {
    1: () => { throw pdfError('PasswordException'); },
    2: () => { throw pdfError('InvalidPDFException'); },
    3: () => { throw new TypeError('renderer is broken'); },
  };
  let fetches = 0;
  const store = thumbs.createDocumentThumbs({
    signal: new AbortController().signal,
    fetchImpl: async (url) => {
      fetches += 1;
      if (url.includes('/7/')) return { ok: false, status: 415 };
      if (url.includes('/8/')) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, blob: async () => ({ size: url.includes('/9/') ? 11 * MB : 10, arrayBuffer: async () => new ArrayBuffer(8) }) };
    },
    renderers: { pdf: async () => behaviours[currentId](), image: async () => 'x' },
  });
  let currentId = 0;
  for (const id of [1, 2]) {
    currentId = id;
    assert.equal(await store.load(localDoc({ id })), null, `Fall ${id} -> Glyphe`);
    assert.equal(store.peek(localDoc({ id })), null, 'gemerkt: kein zweiter Versuch');
  }
  assert.equal(await store.load(localDoc({ id: 7 })), null, 'HTTP 415');
  assert.equal(await store.load(localDoc({ id: 8 })), null, 'offline');
  assert.equal(await store.load(localDoc({ id: 9 })), null, 'Antwort groesser als angegeben');
  const before = fetches;
  await store.load(localDoc({ id: 1 }));
  assert.equal(fetches, before, 'ein gescheitertes Dokument wird nicht erneut geholt');
  currentId = 3;
  await assert.rejects(store.load(localDoc({ id: 3 })), /renderer is broken/, 'ein TypeError im eigenen Code wird nicht verschluckt');
  assert.equal(thumbs.isExpectedThumbError(new ReferenceError('x')), false);
  assert.equal(thumbs.isExpectedThumbError(pdfError('UnknownErrorException')), true);
});

test('die Dokumentenseite haengt die Vorschauen an das Seitenleben', () => {
  assert.match(page, /import \{ createPageController \} from '\/utils\/page-lifecycle\.js'/);
  const render = page.slice(page.indexOf('export async function render('), page.indexOf('container.replaceChildren();', page.indexOf('export async function render(')));
  assert.match(render, /export async function render\(container, context = \{\}\)/);
  assert.match(render, /_pageController = createPageController\(context\.signal\)/);
  assert.match(render, /createDocumentThumbs\(\{ signal: _pageController\.signal/);
  assert.match(render, /_thumbObserver\?\.disconnect\(\)/, 'der Observer faellt mit der Seite');
  // Lazy: erst im Blick, und die Liste zeichnet nach jedem Rendern neu an.
  const wiring = page.slice(page.indexOf('function wireLocalThumbs('), page.indexOf('function showLocalThumb('));
  assert.match(wiring, /new IntersectionObserver\(/);
  assert.match(wiring, /_thumbs\.peek\(doc\)/, 'Gerendertes kommt sofort aus dem Seitenspeicher');
  assert.match(wiring, /_thumbs\.load\(doc\)/);
  const list = page.slice(page.indexOf('function renderDocuments('), page.indexOf('function visibleFolderRows('));
  assert.match(list, /wireLocalThumbs\(list\)/);
  // Zeile und Karte tragen denselben Rahmen; nur Kandidaten melden sich an.
  assert.match(page, /renderThumbSlot\(doc, 'document-row__icon'\)/);
  assert.match(page, /renderThumbSlot\(doc, 'document-card__media'\)/);
  assert.match(page, /const local = documentThumbKind\(doc\) \? ' data-local-thumb' : ''/);
});

test('der Paperless-Pfad bleibt, wie er war', () => {
  const fn = page.slice(page.indexOf('function docSupportsThumbnail('), page.indexOf('function renderDocIconSlot('));
  assert.match(fn, /documentStorageBackend\(doc\) === 'dms'/);
  assert.match(fn, /doc\.dms_provider === 'paperless'/);
  const slot = page.slice(page.indexOf('function renderDocIconSlot('), page.indexOf('function renderThumbSlot('));
  assert.match(slot, /src="\/api\/v1\/documents\/\$\{doc\.id\}\/thumbnail"/);
  assert.match(slot, /data-thumb="clickable"/);
});

test('die Rasterkarte traegt eine feste Vorschauflaeche, das Bild fuellt sie ohne Verzerrung', () => {
  const rules = [...eachRule(css)];
  const top = rules.filter((rule) => rule.at.length === 0);
  const media = top.find((rule) => rule.selector === '.document-card__media');
  assert.ok(media, '.document-card__media fehlt');
  assert.match(media.body, /aspect-ratio:\s*\d+\s*\/\s*\d+/, 'feste Form: ein spaet ankommendes Bild schiebt nichts');
  assert.match(media.body, /border-radius:\s*var\(--radius-/);
  assert.match(media.body, /background:\s*var\(--color-/);
  const img = top.find((rule) => rule.selector === '.document-thumb__img');
  assert.match(img.body, /object-fit:\s*cover/);
  const frame = top.find((rule) => rule.selector === '.document-thumb--ready::after');
  assert.ok(frame, 'der Rahmen liegt ueber dem Bild');
  assert.match(frame.body, /var\(--color-border-subtle\)/);
  // Einblenden nur ohne abbestellte Bewegung, und nur frisch angekommene Bilder.
  const fade = rules.filter((rule) => /animation:\s*document-thumb-in/.test(rule.body));
  assert.ok(fade.length > 0, 'Einblend-Regel fehlt');
  for (const rule of fade) {
    assert.ok(rule.at.some((at) => /prefers-reduced-motion:\s*no-preference/.test(at)), `${rule.selector} blendet auch bei reduzierter Bewegung ein`);
    assert.match(rule.selector, /\[data-thumb-fresh\]/);
  }
});

// --------------------------------------------------------
// Critique 2026-09-25, Entscheidungen 4 und 5 - Rollen, Kanon, Polish
// --------------------------------------------------------

const roving = await import('../public/utils/roving-toolbar.js').catch(() => null);
const topRules = (source) => [...eachRule(source)].filter((rule) => rule.at.length === 0);
const rulesFor = (source, selector) => [...eachRule(source)]
  .filter((rule) => rule.selector.split(',').map((s) => s.trim()).includes(selector));
const fnBody = (name, next) => page.slice(page.indexOf(`function ${name}(`), page.indexOf(`function ${next}(`));
const LOCALES = readdirSync(resolve(HERE, '../public/locales')).filter((f) => f.endsWith('.json'));

test('Kategorie und Ordner sagen, wofuer sie stehen - im Dialog und im Filter', () => {
  // Zwei Ordnungsachsen nebeneinander ("Versicherung" und "Versicherungen"),
  // und nirgends stand, wann welche gilt (Critique H10). Option A: beide
  // bleiben, die Rolle steht dabei - Art des Dokuments gegen Ablageort.
  const modal = fnBody('openDocumentModal', 'bindDropzone');
  assert.match(modal, /<select class="input" id="document-category" aria-describedby="document-category-hint">/);
  assert.match(modal, /<p class="document-form__hint" id="document-category-hint">\$\{t\('documents\.categoryHint'\)\}<\/p>/);
  assert.match(modal, /<select class="input" id="document-folder" aria-describedby="document-folder-hint">/);
  assert.match(modal, /<p class="document-form__hint" id="document-folder-hint">\$\{t\('documents\.folderHint'\)\}<\/p>/);
  assert.match(page, /id="documents-category" role="group" aria-label="\$\{t\('documents\.categoryFilterLabel'\)\}"/);
  assert.match(page, /<aside class="documents-folder-browser" aria-label="\$\{t\('documents\.folderFilterLabel'\)\}">/);
  assert.match(de.documents.categoryHint, /Art/);
  assert.match(de.documents.folderHint, /Ablageort/);
  assert.match(de.documents.categoryFilterLabel, /Art des Dokuments/);
  assert.match(de.documents.folderFilterLabel, /Ablageort/);
});

test('die Rasterkarte folgt dem Kartenkanon: randlos, --radius-md, shadow-sm', () => {
  // DESIGN.md, Cards: 12px, randlos auf dem Grouped-Grund, die Trennung leistet
  // der Schatten. Die Karte trug eine Kante und --radius-lg (16px).
  const card = rulesFor(css, '.document-card').filter((rule) => rule.at.length === 0);
  assert.ok(card.length > 0);
  for (const rule of card) {
    assert.doesNotMatch(rule.body, /(^|[;\s])border(-color)?:\s*(?!none)/, `${rule.selector} traegt eine Kante`);
    assert.doesNotMatch(rule.body, /--radius-lg/);
  }
  assert.ok(card.some((rule) => /border-radius:\s*var\(--radius-md\)/.test(rule.body)), 'Radius --radius-md');
  assert.ok(card.some((rule) => /box-shadow:\s*var\(--shadow-sm\)/.test(rule.body)), 'Ruhe-Schatten --shadow-sm');
  // Die Auswahl ist ein Ring aus box-shadow, keine Kantenfarbe an einer Karte ohne Kante.
  const selected = topRules(css).find((rule) => rule.selector === '.document-card.is-selected');
  assert.ok(selected);
  assert.doesNotMatch(selected.body, /border-color/);
  assert.match(selected.body, /box-shadow:\s*0 0 0 2px var\(--module-accent\)/);
});

test('das Raster hat mobil zwei Spalten und bei 1280px drei statt zwei', () => {
  // Gemessen vorher: 1280px -> 2 Spalten a 362px (Liste 740px), 375px -> eine
  // Spalte, Karte 443-451px hoch. minmax(min(N, 50% - gap/2)) haelt beides:
  // nie weniger als zwei Spalten, und ab 3N + 2 gaps eine dritte.
  const grid = topRules(css).find((rule) => rule.selector === '.documents-list--grid');
  const m = grid.body.match(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\((\d+)px,\s*calc\(50% - var\(--space-4\) \/ 2\)\),\s*1fr\)\)/);
  assert.ok(m, `Spaltenformel: ${grid.body}`);
  const n = Number(m[1]);
  assert.ok(3 * n + 2 * 16 <= 740, `bei 740px Listenbreite passen drei Spalten a ${n}px`);
  assert.ok(n >= 180, 'die Karte behaelt ihre Aktionszeile');
  assert.match(grid.body, /gap:\s*var\(--space-4\)/);
});

test('die Karte ist kompakt: 4:3-Vorschau, Titel zweizeilig, Meta einzeilig, kein Mindest-Leerraum', () => {
  const rules = topRules(css);
  const media = rules.find((rule) => rule.selector === '.document-card__media');
  assert.match(media.body, /aspect-ratio:\s*4\s*\/\s*3/, 'ehrliche feste Form, flacher als 16/10 zu hoch war es nicht - 4:3 ist der Kanon-Rahmen');
  const title = rules.find((rule) => rule.selector === '.document-card__title');
  assert.ok(title, '.document-card__title fehlt als eigene Regel');
  assert.match(title.body, /-webkit-line-clamp:\s*2/);
  const meta = rules.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes('.document-card__meta')
    && /height:\s*calc\(1lh/.test(rule.body));
  assert.ok(meta, 'die Kartenmeta nutzt die Einzeilen-Mechanik der Zeile');
  assert.match(meta.body, /overflow:\s*hidden/);
  assert.match(meta.body, /flex-wrap:\s*wrap/);
  assert.ok(!rules.some((rule) => rule.selector === '.document-card__description' && /min-height/.test(rule.body)),
    'kein fester Leerraum fuer eine fehlende Beschreibung');
  // Die Beschreibung erscheint nur, wenn es eine gibt - der Dateiname als
  // Ersatz wiederholte, was Titel und Vorschau schon sagen.
  const card = fnBody('renderGridCard', 'renderListItem');
  assert.doesNotMatch(card, /doc\.description \|\| doc\.original_name/);
  assert.match(card, /doc\.description \? `<p class="document-card__description">\$\{esc\(doc\.description\)\}<\/p>` : ''/);
});

test('der Kopf hat EINE Hoehe: Ansichtsumschalter so hoch wie Suche und Knoepfe', () => {
  // Gemessen vorher bei 1280px: Suche 44, Umschalter 48, Menueknopf 44; mobil
  // 48 / 52 / 48. Der Umschalter ist ein Well mit 2px Rand - seine Knoepfe
  // muessen um genau diesen Rand kleiner sein als --target-base.
  const toggle = topRules(css).find((rule) => rule.selector === '.documents-view-toggle');
  assert.match(toggle.body, /padding:\s*var\(--space-0h\)/);
  const btn = topRules(css).find((rule) => rule.selector === '.documents-view-toggle__btn');
  assert.match(btn.body, /width:\s*calc\(var\(--target-base\) - 2 \* var\(--space-0h\)\)/);
  assert.match(btn.body, /height:\s*calc\(var\(--target-base\) - 2 \* var\(--space-0h\)\)/);
});

test('der Ordner-Kebab ist immer sichtbar, ruhig in Tertiaerfarbe', () => {
  // list-row.css: EINE Sichtbarkeitsregel, immer sichtbar - Ruhe durch Kontrast.
  // Hier stand opacity: 0 bis Hover, und der Name verlor trotzdem den Platz.
  const all = [...eachRule(css)].filter((rule) => rule.selector.includes('.documents-folder-item__menu'));
  assert.ok(all.length > 0);
  for (const rule of all) {
    assert.doesNotMatch(rule.body, /opacity:\s*0/, `${rule.selector} blendet den Kebab aus`);
    assert.doesNotMatch(rule.body, /pointer-events:\s*none/, `${rule.selector} macht ihn unklickbar`);
  }
  const base = topRules(css).find((rule) => rule.selector === '.documents-folder-item__menu');
  assert.match(base.body, /color:\s*var\(--color-text-tertiary\)/);
});

test('lange Ordnernamen brechen zweizeilig um und tragen den ganzen Namen im title', () => {
  // "Versicheru..." ohne title: der Name war nirgends ganz zu lesen.
  const name = topRules(css).find((rule) => rule.selector === '.documents-folder-item__name');
  assert.match(name.body, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(name.body, /white-space:\s*nowrap/);
  assert.match(page, /<span class="list-row__name documents-folder-item__name" title="\$\{esc\(item\.name\)\}">/);
});

test('die Karte hebt sich beim Hover wie jede interaktive Karte - leise und nie bei reduzierter Bewegung', () => {
  // DESIGN.md: Hover-Anhebung nur fuer interaktive Karten. Die Dokumentkarte
  // oeffnet den Betrachter, darf also - im Mass der Notizkarte (1px, shadow-md),
  // nicht mit 2px plus Flaechenwechsel plus 6 % Zoom der Vorschau.
  const hover = [...eachRule(css)].filter((rule) => rule.selector === '.document-card:hover');
  const base = hover.find((rule) => rule.at.length === 0);
  assert.match(base.body, /transform:\s*translateY\(-1px\)/);
  assert.match(base.body, /box-shadow:\s*var\(--shadow-md\)/);
  assert.doesNotMatch(base.body, /background/);
  assert.ok(hover.some((rule) => rule.at.some((at) => /prefers-reduced-motion:\s*reduce/.test(at))
    && /transform:\s*none/.test(rule.body)), 'reduzierte Bewegung: keine Anhebung');
  // Der Zoom bleibt der kleinen Zeilenkachel; auf der grossen Vorschau schnitte er den Briefkopf an.
  const zoom = [...eachRule(css)].filter((rule) => /scale\(1\.06\)/.test(rule.body));
  assert.ok(zoom.length > 0);
  for (const rule of zoom) assert.match(rule.selector, /^\.document-row__icon\.document-thumb--ready:hover/);
});

test('Speicher-Badges sind Ortsetiketten: neutral, Kapsel, unterschieden durch Glyphe und Text', () => {
  // Violett ist die Stimme der App, Gruen heisst "erledigt" - beides trugen
  // hier Ortsangaben (Google Drive, WebDAV). Neutral statt records-Waschung:
  // die waere der Modulton zweimal blass im eigenen Raum (Skalen-Regel).
  const rules = topRules(css);
  const badge = rules.find((rule) => rule.selector === '.doc-badge');
  assert.match(badge.body, /border-radius:\s*var\(--radius-full\)/);
  for (const mod of ['dms', 'webdav', 'google-drive', 'folder']) {
    const own = rules.filter((rule) => rule.selector.split(',').map((s) => s.trim()).includes(`.doc-badge--${mod}`));
    assert.ok(own.length > 0, `.doc-badge--${mod} fehlt`);
    for (const rule of own) {
      assert.doesNotMatch(rule.body, /--color-(accent|success|info)/, `.doc-badge--${mod} spricht mit einer Statusstimme`);
      assert.match(rule.body, /background:\s*var\(--color-fill-well\)/, `.doc-badge--${mod} steht auf der neutralen Well-Flaeche`);
      assert.match(rule.body, /color:\s*var\(--color-text-secondary\)/);
    }
  }
  const fn = fnBody('storageBadgeHtml', 'renderActions');
  const icons = [...fn.matchAll(/doc-badge--(dms|webdav|google-drive|folder)"><i data-lucide="([a-z-]+)"/g)].map((m) => m[2]);
  assert.equal(icons.length, 4, 'jedes Ortsetikett traegt seine Glyphe');
  assert.equal(new Set(icons).size, 4, 'vier verschiedene Glyphen');
});

test('der Hinweis im Betrachter hat ein Lesemass', () => {
  // Gemessen 153 Zeichen auf 926px (Critique, Detektor line-length).
  const note = topRules(css).find((rule) => rule.selector === '.document-viewer__note');
  // Die volle Basis bricht den Hinweis in seine eigene Zeile; ein max-width
  // kappte sie mit, und er rueckte neben die Aktionen. Das Mass kommt deshalb
  // ueber die Polsterung jenseits von N ch.
  assert.match(note.body, /flex-basis:\s*100%/);
  assert.doesNotMatch(note.body, /max-width/);
  const m = note.body.match(/padding-inline-end:\s*max\(0px,\s*calc\(100% - (\d+)ch\)\)/);
  assert.ok(m, 'Lesemass in ch ueber padding-inline-end');
  assert.ok(Number(m[1]) <= 60);
  assert.match(note.body, /box-sizing:\s*border-box/);
});

test('Ordner gleich Kategorie steht einmal da - in Zeile, Karte UND Betrachter (als Programm)', () => {
  assert.equal(typeof facets?.folderRepeatsCategory, 'function', 'folderRepeatsCategory fehlt in document-facets.js');
  assert.equal(facets.folderRepeatsCategory('Schule', 'Schule'), true);
  assert.equal(facets.folderRepeatsCategory(' schule ', 'Schule'), true);
  // Die Pluralform der Kategorie sagt dasselbe (Re-Critique 2026-09-25:
  // "Versicherung · Versicherungen"). Sprachneutral ueber eine kurze Endung.
  assert.equal(facets.folderRepeatsCategory('Versicherungen', 'Versicherung'), true, 'Plural der Kategorie');
  assert.equal(facets.folderRepeatsCategory('Reise', 'Reisen'), true, 'Singular der Kategorie');
  assert.equal(facets.folderRepeatsCategory('Tax', 'Taxes'), true);
  assert.equal(facets.folderRepeatsCategory('Okullar', 'Okul'), true, 'tr: -lar');
  assert.equal(facets.folderRepeatsCategory('Steuererklaerungen', 'Steuern'), false, 'ein eigenes Wort bleibt sichtbar');
  assert.equal(facets.folderRepeatsCategory('Schulbus', 'Schule'), false, 'kein Praefix, keine Dopplung');
  assert.equal(facets.folderRepeatsCategory('Arbeitsvertrag', 'Arbeit'), false, 'lange Endung = anderes Wort');
  assert.equal(facets.folderRepeatsCategory('Ev', 'Evler'), false, 'zu kurzer Stamm traegt keine Aussage');
  assert.equal(facets.folderRepeatsCategory('', 'Schule'), false);
  assert.equal(facets.folderRepeatsCategory(null, 'Schule'), false);
  assert.equal(facets.folderRepeatsCategory('', ''), false, 'kein Ordner ist keine Dopplung');
  // Der Betrachter zeigte "Schule Schule", renderMeta nicht: zwei Regeln fuer eine Frage.
  // Die Zeile fragt seit der Re-Critique showsFolderChip, das die Dopplungsregel
  // einschliesst - als Programm belegt: dieselbe Dopplung faellt dort heraus.
  assert.match(fnBody('renderMeta', 'docSupportsThumbnail'), /showsFolderChip\(doc, categoryLabel, state\.folderId\)/);
  assert.equal(facets.showsFolderChip({ folder_id: 1, folder_name: 'Schule' }, 'Schule', ''), false);
  const viewer = page.slice(page.indexOf('<div class="document-viewer__meta">'), page.indexOf('<span class="document-viewer__actions">'));
  assert.match(viewer, /doc\.folder_name && !folderRepeatsCategory\(doc\.folder_name, categoryLabel\)/);
});

test('Einzel-Archivieren meldet einen Fehler statt ihn zu verschlucken', () => {
  // archiveSelected hatte ein catch, die Einzelaktion nicht: ein 403/500 lief
  // als unbehandelte Rejection durch, ohne Meldung, mit Erfolgs-Annahme.
  const run = fnBody('runDocumentAction', 'deleteDocuments');
  const branch = run.slice(run.indexOf("if (action === 'archive')"), run.indexOf("if (action === 'push-dms')"));
  assert.match(branch, /try \{[\s\S]*api\.patch\(`\/documents\/\$\{doc\.id\}\/archive`[\s\S]*\} catch \(err\) \{[\s\S]*showToast\(err\.data\?\.error \?\? t\('common\.unknownError'\), 'danger'\)/);
});

test('die Leermeldung nennt den Suchbegriff so, wie er getippt wurde', () => {
  // Gesucht "Kassenbon", gemeldet "kassenbon": die Seite zitierte ihre
  // normalisierte Vergleichsform statt der Eingabe.
  const empty = fnBody('emptyStateFor', 'renderEmptyState');
  assert.match(empty, /t\('documents\.emptySearchDescription', \{ query: state\.queryText \}\)/);
  assert.match(page, /state\.queryText = String\(value \?\? ''\)\.trim\(\);/);
  assert.match(fnBody('clearSearch', 'resetFilters'), /state\.queryText = '';/);
  // Leeren zeichnet auch die Zaehler neu: sie zaehlen unter der Suche, und
  // `_search.clear()` ruft onQuery nicht - die Chips blieben auf dem Suchstand.
  assert.match(fnBody('clearSearch', 'resetFilters'), /renderFacets\(\);/);
});

test('vor "Loeschen" steht in beiden Kontextmenues ein Trenner', () => {
  const sep = /<div class="popover-menu__separator" role="separator"><\/div>\s*<button class="documents-context-menu__item documents-context-menu__item--danger"/;
  assert.match(fnBody('openDocumentMenu', 'renameFolder'), sep);
  assert.match(fnBody('openFolderMenu', 'moveFolder'), sep);
  // Der Trenner ist kein Eintrag: die Pfeiltasten laufen nur ueber [data-menu-action].
  assert.match(fnBody('openContextMenu', 'positionContextMenu'), /querySelectorAll\('\[data-menu-action\]'\)/);
});

test('ein Dokument ist EIN Tab-Stopp, seine Aktionen bleiben sichtbar und per Pfeil erreichbar (als Programm)', () => {
  // Sam: 3 Tab-Stopps je Dokument, 27 bei neun Dokumenten. Die Aktionsleiste
  // ist jetzt eine Symbolleiste mit rovingem tabindex (APG toolbar).
  assert.ok(roving, 'public/utils/roving-toolbar.js fehlt');
  const { rovingIndex } = roving;
  assert.equal(rovingIndex('ArrowRight', 0, 3), 1);
  assert.equal(rovingIndex('ArrowRight', 2, 3), 0, 'am Ende zurueck an den Anfang');
  assert.equal(rovingIndex('ArrowLeft', 0, 3), 2);
  assert.equal(rovingIndex('Home', 2, 3), 0);
  assert.equal(rovingIndex('End', 0, 3), 2);
  assert.equal(rovingIndex('ArrowDown', 0, 3), null, 'Hoch/Runter bleibt dem Scrollen');
  assert.equal(rovingIndex('Tab', 0, 3), null);
  assert.equal(rovingIndex('ArrowRight', 0, 0), null);
  // Ausgeblendete Aktionen (Herunterladen unter 30rem) zaehlen nicht mit -
  // sonst liefe der Pfeil auf ein unsichtbares Ziel und der Fokus verschwaende.
  const item = (name, shown) => ({ name, getClientRects: () => (shown ? [{}] : []) });
  const bar = { querySelectorAll: () => [item('view', true), item('download', false), item('menu', true)] };
  assert.deepEqual(roving.toolbarItems(bar).map((el) => el.name), ['view', 'menu']);
  const actions = fnBody('renderActions', 'renderSelectBox');
  assert.equal((actions.match(/tabindex="0"/g) || []).length, 1, 'genau ein Einstieg je Dokument');
  assert.equal((actions.match(/tabindex="-1"/g) || []).length, 2);
  for (const cls of ['document-card__actions', 'document-row__actions']) {
    assert.match(page, new RegExp(`<div class="${cls}" role="toolbar" aria-label="\\$\\{esc\\(t\\('documents\\.actionsFor', \\{ name: doc\\.name \\}\\)\\)\\}">`));
  }
  assert.match(fnBody('renderDocuments', 'visibleFolderRows'), /wireRovingToolbars\(list\)/);
  assert.match(de.documents.actionsFor, /\{\{name\}\}/);
});

test('der Ablauf-Chip hat eine Kurzform fuer schmale Zeilen und Karten (als Programm)', () => {
  // Mobil stand "Seit 10 Tagen abge..." - die Zahl, um die es geht, fiel weg.
  const status = (state, days) => ({ state, days, endDateKey: '2026-09-30' });
  assert.deepEqual(expiry.expiryChipSpec(status('expiring', 5)),
    { tone: 'expiring', key: 'documents.expiringInDays', params: { count: 5 }, shortKey: 'documents.expiringShort' });
  assert.deepEqual(expiry.expiryChipSpec(status('expired', -10)),
    { tone: 'unavailable', key: 'documents.expiredDays', params: { count: 10 }, shortKey: 'documents.expiredShort' });
  const chip = fnBody('expiryChipHtml', 'expiryViewerHtml');
  assert.match(chip, /<span class="doc-badge__full">\$\{full\}<\/span><span class="doc-badge__short" aria-hidden="true">\$\{short\}<\/span>/);
  assert.match(chip, /title="\$\{full\}"/);
  const rules = [...eachRule(css)];
  const short = rules.find((rule) => rule.at.length === 0 && rule.selector === '.doc-badge__short');
  assert.match(short.body, /display:\s*none/);
  // Schmal heisst: die Zeile unter 30rem (Container list-rows) und jede Karte
  // unter 12rem Inhaltsbreite (eigener Container). Die Langform bleibt fuer Screenreader da.
  for (const container of [/@container list-rows \(max-width: 30rem\)/, /@container document-card \(max-width: 12rem\)/]) {
    const inQuery = rules.filter((rule) => rule.at.some((at) => container.test(at)));
    assert.ok(inQuery.some((rule) => /\.doc-badge__short/.test(rule.selector) && /display:\s*inline/.test(rule.body)), `${container} zeigt die Kurzform`);
    const full = inQuery.find((rule) => /\.doc-badge__full/.test(rule.selector));
    assert.ok(full, `${container} blendet die Langform aus`);
    assert.doesNotMatch(full.body, /display:\s*none/, 'visuell weg, fuer Screenreader da');
    assert.match(full.body, /clip-path:\s*inset\(50%\)/);
  }
  assert.match(topRules(css).find((rule) => rule.selector === '.document-card' && /container/.test(rule.body))?.body || '',
    /container:\s*document-card \/ inline-size/);
  assert.equal(de.documents.expiredShort, 'Abgelaufen');
  assert.match(de.documents.expiringShort, /\{\{count\}\}/);
});

test('kein Gedankenstrich in den Dokument- und Beleg-Texten, in keiner Sprache', () => {
  for (const file of LOCALES) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    const name = data.inventory?.attachmentDocumentName ?? '';
    assert.doesNotMatch(name, /[\u2013\u2014]/, `${file}: inventory.attachmentDocumentName`);
    for (const [key, value] of Object.entries(data.documents || {})) {
      if (typeof value === 'string') assert.doesNotMatch(value, /[\u2013\u2014]/, `${file}: documents.${key}`);
    }
  }
});

test('der Betrachter schiebt ein zu hohes PDF nicht nach oben ueber die Meta-Zeile', () => {
  // Gemessen 375x812 (Gesamtpruefung 2026-09-25): der Rumpf ist flex:1 und zentriert,
  // der iframe fest 65vh. Wird der Rumpf kuerzer als 65vh (Ablaufzeile + Teilen-Hinweis
  // machen die Meta-Zeile hoch), laeuft der iframe zentriert nach BEIDEN Seiten ueber
  // und deckt den Hinweis ab (iframe-Oberkante 340px, Hinweis bis 392px). `safe center`
  // laesst den Ueberlauf nur nach unten zu, der Modal-Rumpf scrollt dann.
  const body = topRules(css).find((rule) => rule.selector === '.document-viewer__body');
  assert.ok(body, '.document-viewer__body fehlt');
  const values = [...body.body.matchAll(/align-items:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(values.at(-1), 'safe center', 'die letzte align-items-Deklaration ist safe center');
  assert.ok(values.includes('center'), 'davor steht center als Rueckfall fuer Browser ohne safe');
});

test('der immer sichtbare Ordner-Kebab traegt am Zeiger die volle Zielgroesse', () => {
  // Solange er per Hover erschien (opacity 0 + pointer-events: none), mass Sonde 4
  // ihn gar nicht. Seit er immer sichtbar ist, steht er als EINZELZIEL da - die
  // Ordnerzeilen liegen weiter als 16px auseinander - und 32x32 (--target-sm)
  // reisst am Desktop die 40px (Gesamtpruefung 2026-09-25, test:document-guards).
  const base = topRules(css).find((rule) => rule.selector === '.documents-folder-item__menu');
  assert.ok(base, '.documents-folder-item__menu fehlt');
  assert.match(base.body, /width:\s*var\(--target-md\)/);
  assert.match(base.body, /height:\s*var\(--target-md\)/);
  assert.doesNotMatch(base.body, /--target-sm/);
});

test('die Ordnerzeile behaelt das Zeilenpolster und rueckt je Ebene darauf ein', () => {
  // Vorher `calc(var(--folder-depth, 0) * 14px)`: die Regel ueberschrieb das
  // `padding-inline` von `.list-row`, und die Zeilen der Tiefe 0 ("Alle
  // Dokumente", "Kein Ordner", jeder Wurzelordner) klebten mit Icon bzw. Pfeil
  // an der linken Kante der Ordnerleiste.
  const rules = [...eachRule(css)].filter((rule) => rule.at.length === 0
    && rule.selector.split(',').map((x) => x.trim()).includes('.documents-folder-item')
    && /padding-inline-start/.test(rule.body));
  assert.equal(rules.length, 1, 'genau eine Einrueckregel');
  const value = /padding-inline-start:\s*([^;]+);/.exec(rules[0].body)[1];
  assert.match(value, /var\(--space-3\)/, 'Tiefe 0 startet beim Polster von .list-row (--space-3), nicht bei 0');
  assert.match(value, /var\(--folder-depth, 0\) \* 14px/, 'die Stufe je Ebene bleibt 14px');
});

// --------------------------------------------------------
// Runde 2 nach der Re-Critique 2026-09-25 (30/40)
// --------------------------------------------------------

const localeData = (file) => JSON.parse(read(`../public/locales/${file}`));

test('Fristen: der Ablauf-Chip steht VOR den Kategorien, abgesetzt, und heisst nach dem, was er zaehlt', () => {
  // Re-Critique P1: am Ende der Spur lag er bei 1280px hinter der sichtbaren
  // Kante (x=1646 bei 1248), bei 375px sah man nur "Alle Kategorien". Und
  // "Laeuft bald ab 4" zaehlte ein abgelaufenes Dokument mit.
  const track = page.slice(page.indexOf('<div class="documents-filters__chips">'), page.indexOf('<div class="documents-browser-layout">'));
  const deadlines = track.indexOf('id="documents-expiring-filter"');
  const categories = track.indexOf('id="documents-category"');
  assert.ok(deadlines > 0 && categories > 0, 'beide Gruppen stehen in der Spur');
  assert.ok(deadlines < categories, 'Fristen vor den Kategorien');
  assert.match(track, /<div class="documents-filter-chips documents-filter-chips--deadlines" id="documents-expiring-filter" role="group" aria-label="\$\{t\('documents\.expiringFilterGroupLabel'\)\}"><\/div>/);
  // Abgesetzt mit derselben Haarlinie wie Segment und Spur - kein neuer Ton -
  // und nur, wenn der Chip steht (die leere Gruppe ist display: none).
  const sep = topRules(css).find((rule) => rule.selector === '.documents-filter-chips--deadlines:not(:empty)');
  assert.ok(sep, 'Trennregel fehlt');
  assert.match(sep.body, /border-inline-end:\s*1px solid var\(--color-border\)/);
  assert.match(sep.body, /padding-inline-end:\s*var\(--space-2\)/);
  const chip = fnBody('renderExpiringChip', 'renderFolderBrowser');
  assert.match(chip, /if \(!present && !state\.expiringSoon\) return;/, 'nur bei Treffern oder aktivem Filter');
  assert.match(chip, /title="\$\{t\('documents\.expiringFilterGroupLabel'\)\}"/);
  assert.equal(de.documents.expiringFilterLabel, 'Fristen');
  assert.notEqual(localeData('en.json').documents.expiringFilterLabel, 'Expiring soon', 'en sagt nicht mehr "bald"');
  for (const file of LOCALES) {
    const docs = localeData(file).documents;
    assert.ok(docs.expiringFilterGroupLabel?.trim(), `${file}: documents.expiringFilterGroupLabel fehlt`);
    if (file !== 'de.json') assert.notEqual(docs.expiringFilterGroupLabel, de.documents.expiringFilterGroupLabel, `${file}: uebersetzt`);
  }
});

test('kompakte Zeile: kein Auge, die Zeile oeffnet, und das Menue traegt Ansehen fuer die Tastatur', () => {
  // Re-Critique P2: mobil blieben dem Titel 153px, weil Auge und Kebab je 48px
  // standen - und ein Tipp auf die Zeile oeffnet ohnehin den Betrachter.
  const compact = [...eachRule(css)].filter((rule) => rule.at.some((a) => /@container list-rows \(max-width: 30rem\)/.test(a)));
  const hides = compact.find((rule) => rule.selector.split(',').map((x) => x.trim()).includes('.document-row__actions [data-action="view"]'));
  assert.ok(hides, 'das Auge faellt unter 30rem weg');
  assert.match(hides.body, /display:\s*none/);
  // Raster und breite Liste behalten es: sonst blendet es keine Regel aus.
  const elsewhere = [...eachRule(css)].filter((rule) => /\[data-action="view"\]/.test(rule.selector)
    && /display:\s*none/.test(rule.body) && !rule.at.some((a) => /list-rows \(max-width: 30rem\)/.test(a)));
  assert.deepEqual(elsewhere.map((rule) => rule.selector), []);
  assert.match(fnBody('handleDocumentAction', 'runDocumentAction'), /if \(doc\) openDocumentViewer\(doc\);/, 'die Zeile oeffnet den Betrachter');
  // Die Zeile ist kein Tab-Stopp. Wer per Tastatur kommt, landet auf dem Kebab
  // (erster SICHTBARER Eintrag), und dort muss Ansehen stehen - sonst waere das
  // Dokument ohne Maus nicht zu oeffnen (Codex-Review zu PR #754).
  const menu = fnBody('openDocumentMenu', 'renameFolder');
  assert.match(menu, /const viewShown = eye\?\.getClientRects\(\)\.length > 0;/);
  assert.match(menu, /\$\{viewShown \? '' : `\s*<button class="documents-context-menu__item" type="button" role="menuitem" data-menu-action="view">/);
  assert.match(fnBody('runDocumentAction', 'deleteDocuments'), /if \(action === 'view'\) openDocumentViewer\(doc\);/);
});

test('der Tab-Stopp einer Leiste liegt nie auf einem ausgeblendeten Knopf - auch nach einer Groessenaenderung (als Programm)', () => {
  // Das Auge traegt im Markup den Einstieg. Unter 30rem ist es ausgeblendet,
  // und ein Einstieg auf display: none nimmt die ganze Leiste aus der Tab-Kette.
  const item = (name, shown, tabIndex) => ({ name, shown, tabIndex, getClientRects() { return this.shown ? [{}] : []; } });
  const view = item('view', false, 0);
  const download = item('download', false, -1);
  const kebab = item('menu', true, -1);
  const items = [view, download, kebab];
  const toolbar = {
    querySelector: (sel) => (sel === '[tabindex="0"]' ? items.find((el) => el.tabIndex === 0) ?? null : null),
    querySelectorAll: () => items,
  };
  const root = () => ({ dataset: {}, addEventListener() {}, querySelectorAll: () => [toolbar] });
  roving.repairRovingStops(root());
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, 0], 'der Kebab ist der erste sichtbare Eintrag');
  assert.equal(roving.firstRovingStop(root()), kebab, 'die Sprungmarke findet genau diesen Einstieg');
  assert.equal(roving.firstRovingStop({ querySelectorAll: () => [] }), null);

  // Breit angefangen, dann schmal geworden (Drehen, Fenster, Ordnerleiste):
  // die Leiste muss ihren Einstieg nachziehen, ohne neu gezeichnet zu werden.
  view.shown = true;
  view.tabIndex = 0;
  kebab.tabIndex = -1;
  const observed = [];
  let onResize = null;
  const before = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(fn) { onResize = fn; } observe(el) { observed.push(el); } disconnect() {} };
  try {
    const list = root();
    roving.wireRovingToolbars(list);
    assert.deepEqual(observed, [list], 'die Liste wird beobachtet');
    view.shown = false;
    onResize([]);
    assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, 0]);
  } finally {
    globalThis.ResizeObserver = before;
  }
});

test('der Ordner-Kebab nennt seinen Ordner', () => {
  // Re-Critique P2: sieben Mal "Ordneraktionen" ohne Namen hintereinander.
  const tree = page.slice(page.indexOf('function renderFolderBrowser()'), page.indexOf('// Der Auslöser trägt den Ordner, in dem man steht'));
  assert.match(tree, /data-folder-menu="\$\{esc\(item\.id\)\}" aria-label="\$\{esc\(t\('documents\.folderActionsFor', \{ name: item\.name \}\)\)\}" title="\$\{esc\(t\('documents\.folderActionsFor', \{ name: item\.name \}\)\)\}"/);
  assert.doesNotMatch(page, /t\('documents\.folderActions'\)/);
  for (const file of LOCALES) {
    const docs = localeData(file).documents;
    assert.match(docs.folderActionsFor ?? '', /\{\{name\}\}/, `${file}: documents.folderActionsFor mit {{name}}`);
    assert.equal(docs.folderActions, undefined, `${file}: der namenlose Schluessel ist weg`);
  }
});

test('eine Sprungmarke fuehrt an Werkzeugen, Filtern und Ordnern vorbei zum ersten Dokument', () => {
  // Re-Critique P2: 33 Tab-Stopps bis Dokument 1, 16 davon in der Ordnerliste.
  // Das Muster ist das der Shell (router.js, `.sr-only` + `:focus-visible` in
  // layout.css) - nur bei Fokus sichtbar, kein eigenes CSS.
  const head = page.slice(page.indexOf('<div class="documents-page'), page.indexOf('<div class="page-toolbar'));
  assert.match(head, /<a class="sr-only documents-skip" href="#documents-list" data-documents-skip>\$\{t\('documents\.skipToDocuments'\)\}<\/a>/);
  const skip = fnBody('skipToDocuments', 'renderDmsHeaderBtn');
  assert.match(skip, /event\.preventDefault\(\);/, 'kein Hash in der Adresse, kein Router-Lauf');
  assert.match(skip, /firstRovingStop\(list\)/);
  assert.match(skip, /list\.setAttribute\('tabindex', '-1'\)/, 'ohne Dokument faengt der Listencontainer den Fokus');
  assert.match(skip, /\.focus\(\)/);
  assert.match(page, /querySelector\('\[data-documents-skip\]'\)\?\.addEventListener\('click', skipToDocuments\)/);
  assert.match(read('../public/styles/layout.css'), /\.sr-only:focus-visible\s*\{/);
  for (const file of LOCALES) assert.ok(localeData(file).documents.skipToDocuments?.trim(), `${file}: documents.skipToDocuments`);
});

test('der Teilen-Hinweis nennt die Ursache, die zutrifft - HTTPS nur, wenn es an der Verbindung liegt', () => {
  const viewer = fnBody('openDocumentViewer', 'renderViewerContent');
  assert.match(page, /const SHARE_NOTE_KEYS = \{\s*type: 'documents\.shareUnsupportedType',\s*insecure: 'documents\.shareInsecure',\s*browser: 'documents\.shareBrowserUnsupported',\s*\};/);
  assert.match(viewer, /t\(SHARE_NOTE_KEYS\[shareSupport\]\)/);
  for (const file of LOCALES) {
    const docs = localeData(file).documents;
    assert.match(docs.shareInsecure ?? '', /HTTPS/, `${file}: shareInsecure nennt die Verbindung`);
    assert.ok(docs.shareBrowserUnsupported?.trim(), `${file}: shareBrowserUnsupported fehlt`);
    assert.doesNotMatch(docs.shareBrowserUnsupported, /HTTPS|HTTP/, `${file}: der Browser-Fall schickt niemanden zu HTTPS`);
    assert.equal(docs.shareUnavailable, undefined, `${file}: der Sammel-Schluessel ist weg`);
  }
});

test('der Betrachter bietet Bearbeiten an, schliesst sich dafuer und gibt den Ausloeser weiter', () => {
  // Re-Critique (Alex): im Betrachter sah man den Fehler im Titel, musste aber
  // schliessen, die Zeile wiederfinden und ueber den Kebab gehen.
  const viewer = fnBody('openDocumentViewer', 'renderViewerContent');
  const actions = viewer.slice(viewer.indexOf('<span class="document-viewer__actions">'), viewer.indexOf('document-viewer__note'));
  assert.match(actions, /\$\{canEditDocuments\(\) \? `\s*<button type="button" class="btn btn--ghost btn--icon btn--icon-sm" data-action="edit-document"\s*title="\$\{t\('common\.edit'\)\}" aria-label="\$\{t\('common\.edit'\)\}">\s*<i data-lucide="pencil" class="icon-md" aria-hidden="true"><\/i>/);
  assert.match(page, /function canEditDocuments\(\) \{\s*return !isNavModuleReadOnly\('documents'\);\s*\}/);
  // Der Ausloeser des Betrachters wird VOR dem Oeffnen gemerkt; beim Wechsel
  // bekommt er den Fokus zurueck, damit der Bearbeiten-Dialog ihn als seinen
  // Ausloeser merkt (modal.js merkt document.activeElement). Mobil schliesst
  // der Betrachter animiert, und der Fokus stuende sonst auf einem Knopf, der
  // gleich aus dem DOM faellt.
  assert.match(viewer.slice(0, viewer.indexOf('openSharedModal({')), /const opener = document\.activeElement;/);
  const edit = viewer.slice(viewer.indexOf("querySelector('[data-action=\"edit-document\"]')"));
  assert.match(edit, /if \(opener\?\.isConnected && opener !== document\.body\) opener\.focus\(\);\s*openDocumentModal\(doc\);/);
  assert.doesNotMatch(edit.slice(0, edit.indexOf('openDocumentModal(doc)')), /closeModal\(/, 'kein eigenes Schliessen: openModal ersetzt den Betrachter, EIN History-Marker');
});

test('der Kategorie-Hinweis nennt echte Kategorien als Beispiele, in jeder Sprache ihre eigenen', () => {
  // Re-Critique P3: "Rechnung, Vertrag oder Ausweis" sind keine Kategorien.
  for (const file of LOCALES) {
    const docs = localeData(file).documents;
    for (const category of ['finance', 'insurance', 'school']) {
      assert.ok(docs.categoryHint.includes(docs.category[category]), `${file}: categoryHint nennt "${docs.category[category]}"`);
    }
  }
});

test('die festen Ordnerzeilen fluchten mit dem Baum: derselbe Platz vor dem Symbol', () => {
  // "Alle Dokumente" und "Kein Ordner" hatten keinen Pfeil-Platz, ihre Symbole
  // standen 32px links von denen der eigenen Ordner (Re-Critique 2026-09-25).
  assert.equal(typeof facets?.folderRowLead, 'function', 'folderRowLead fehlt in utils/document-facets.js');
  const { folderRowLead } = facets;
  assert.equal(folderRowLead({ managed: false }, true), 'slot', 'feste Zeile neben einem Baum bekommt den Platzhalter');
  assert.equal(folderRowLead({ managed: false }, false), 'none', 'ohne eigene Ordner ruecken die festen Zeilen nicht ein');
  assert.equal(folderRowLead({ managed: true, branch: true }, true), 'toggle');
  assert.equal(folderRowLead({ managed: true, branch: false }, true), 'slot');
  // Und die Seite fragt die Regel wirklich - ein Helfer, den niemand ruft, misst nichts.
  const tree = page.slice(page.indexOf('function renderFolderBrowser()'), page.indexOf('// Der Auslöser trägt den Ordner, in dem man steht'));
  assert.match(tree, /folderRowLead\(item, /);
  assert.doesNotMatch(tree, /!item\.managed \? ''/, 'die alte Sonderregel fuer feste Zeilen ist weg');
});

test('die Sichtbarkeit steht nur an Dokumenten, die vom Standard abweichen', () => {
  // "Ganze Familie" stand auf JEDER Zeile (Re-Critique 2026-09-25) - der
  // Standard als Rauschen, das die Ausnahmen (privat, ausgewaehlte Personen)
  // unsichtbar machte. Eine Angabe, die ueberall gleich ist, sagt nichts.
  assert.equal(facets?.DOCUMENT_DEFAULT_VISIBILITY, 'family', 'der Standard steht an EINER Stelle');
  assert.equal(typeof facets?.showsVisibility, 'function', 'showsVisibility fehlt in document-facets.js');
  assert.equal(facets.showsVisibility('family'), false);
  assert.equal(facets.showsVisibility('private'), true);
  assert.equal(facets.showsVisibility('restricted'), true);
  // Die Zeile fragt die Regel wirklich, und das Formular setzt denselben Standard.
  const meta = fnBody('renderMeta', 'docSupportsThumbnail');
  assert.match(meta, /showsVisibility\(doc\.visibility\)/);
  assert.match(page, /\(doc\?\.visibility \|\| DOCUMENT_DEFAULT_VISIBILITY\) === 'family'/);
});

test('Ordner- und Chip-Zaehler folgen EINEM Rezept, das in Dark nicht unter die Buehne sinkt', () => {
  // Der Ordnerzaehler lag auf --color-surface-2, in Dark dunkler als die Buehne
  // ("schwarze Loecher"), waehrend die Chip-Zaehler currentColor mischen: zwei
  // Rezepte fuer dieselbe Sache (Re-Critique 2026-09-25).
  const bg = (source, selector) => {
    const rule = [...eachRule(source)].find((r) => r.at.length === 0 && r.selector === selector);
    assert.ok(rule, `${selector} fehlt`);
    return (/(?:^|;)\s*background:\s*([^;]+);/.exec(rule.body) || [])[1]?.trim();
  };
  const recipe = 'color-mix(in srgb, currentColor var(--tint-state), transparent)';
  assert.equal(bg(chipCss, '.filter-chip__count'), recipe, 'der Chip-Zaehler nennt die Stufe, nicht die Zahl');
  assert.equal(bg(css, '.documents-folder-item__count'), recipe, 'der Ordnerzaehler mischt wie der Chip-Zaehler');
  const active = [...eachRule(css)].find((r) => r.at.length === 0 && r.selector === '.documents-folder-item--active .documents-folder-item__count');
  assert.ok(!active || !/background/.test(active.body), 'aktiv toent die Tinte, die Fuellung folgt ihr von selbst');
});

test('eine Ansicht ohne ein einziges Dokument zeigt keine Facetten-Moebel', () => {
  // Das leere Archiv zeigte "Alle Kategorien 0" allein in der Spur und neun
  // Ordner mit 0 (Re-Critique 2026-09-25) - Zaehler, die nur sagen, dass es
  // nichts gibt, was der Leerzustand darunter schon sagt.
  const chips = fnBody('renderCategoryChips', 'renderExpiringChip');
  assert.match(chips, /if \(!state\.allDocuments\.length && !state\.category\) return;/,
    'ohne Dokumente in dieser Ansicht keine Kategorie-Chips (ausser eine Kategorie ist aktiv)');
  const tree = page.slice(page.indexOf('function renderFolderBrowser()'), page.indexOf('// Der Auslöser trägt den Ordner, in dem man steht'));
  assert.match(tree, /const showCounts = state\.allDocuments\.length > 0;/);
  assert.match(tree, /\$\{showCounts \? `<span class="documents-folder-item__count">/);
  // Und die Spur verschwindet samt Haarlinie, wenn keine Gruppe einen Chip traegt.
  const spur = [...eachRule(css)].find((r) => r.at.length === 0 && r.selector === '.documents-filters__chips:not(:has(.filter-chip))');
  assert.ok(spur && /display:\s*none/.test(spur.body), 'leere Chip-Spur ausblenden');
});

test('der Dokument-Dialog fuehrt das Ablaufdatum offen und hat ein Abbrechen im Fuss', () => {
  // Re-Critique 2026-09-25: das Datum, das Erinnerung und Fristen-Filter
  // treibt, lag hinter "Weitere Einstellungen", und der Fuss hatte nur den
  // Primaerknopf - anders als die Dialoge von Inventar und Haushaltshilfe.
  const modal = page.slice(page.indexOf('function openDocumentModal('), page.indexOf('    onClose() {\n      requestFolderUploadCancel'));
  const advanced = modal.slice(modal.indexOf('const advancedFieldsHtml = `'), modal.indexOf('`;', modal.indexOf('const advancedFieldsHtml = `')));
  assert.doesNotMatch(advanced, /document-expires-at|document-expiry-reminder-days/, 'Ablauf gehoert nicht ins Akkordeon');
  assert.match(modal, /\$\{expiryFieldsHtml\}\s*\$\{advancedSection\(/, 'das Ablaufdatum steht vor dem Akkordeon');
  // Das zweite Raster haelt die Zeilenluft des ersten (12px), statt an dessen Hinweis zu stossen.
  const expiryGrid = [...eachRule(css)].find((r) => r.at.length === 0 && r.selector === '.document-expiry-grid');
  assert.ok(expiryGrid && /margin-top:\s*var\(--space-3\)/.test(expiryGrid.body), '.document-expiry-grid braucht den Rasterabstand');
  assert.match(modal, /class="modal-grid modal-grid--2 document-expiry-grid"/);
  assert.doesNotMatch(modal, /const advancedOpen = [^;]*expires_at/, 'das Datum oeffnet das Akkordeon nicht mehr');
  // Die Erinnerungstage erscheinen erst mit einem Datum - ohne Datum gibt es nichts zu erinnern.
  assert.match(modal, /id="document-expiry-reminder" \$\{doc\?\.expires_at \? '' : 'hidden'\}/);
  assert.match(page, /reminderGroup\.hidden = !expiresInput\.value/);
  assert.match(page, /expiry_reminder_days: expiresAt && form\.querySelector\('#document-expiry-reminder-days'\)\.value !== ''/);
  // Der Fuss: Abbrechen ueber den Schliessweg des Modals, dann der Primaerknopf.
  assert.match(modal, /<button type="button" class="btn btn--secondary" data-action="close-modal">\$\{t\('common\.cancel'\)\}<\/button>\s*<button type="submit" class="btn btn--primary" id="document-submit">/);
});

test('gesperrte Sammelaktionen treten zurueck, statt zu warnen', () => {
  // Re-Critique 2026-09-25: `disabled` auf .btn--danger ergab ueber
  // `.btn:disabled { opacity: 0.4 }` eine laute rosa Flaeche, solange nichts
  // gewaehlt war. Das Projektmuster "inaktiv, aber erreichbar"
  // (`.btn[aria-disabled='true']`, layout.css) deckt die Farbe ab und laesst
  // den Knopf in der Tab-Ordnung.
  const update = fnBody('updateSelectUI', 'selectedDocuments');
  assert.match(update, /btn\.setAttribute\('aria-disabled', String\(n === 0\)\)/);
  assert.doesNotMatch(update, /btn\.disabled\s*=/, 'kein natives disabled mehr an den Sammelaktionen');
  // Ein gesperrter Knopf nimmt Klicks an - der Verteiler muss sie verwerfen.
  const bar = page.slice(page.indexOf("_container.querySelector('#documents-selectbar')?.addEventListener('click'"), page.indexOf("if (action === 'select-cancel') exitSelectMode();"));
  assert.match(bar, /if \(button\?\.getAttribute\('aria-disabled'\) === 'true'\) return;/);
  const layout = read('../public/styles/layout.css');
  const muted = [...eachRule(layout)].find((r) => r.at.length === 0 && r.selector === ".btn[aria-disabled='true']");
  assert.ok(muted && /background-color:\s*transparent/.test(muted.body), 'das gedeckte Rezept deckt auch die Gefahrfarbe ab');
});

test('im gewaehlten Ordner nennt die Zeile den Ordner nicht noch einmal', () => {
  // Re-Critique 2026-09-25: im Ordner "Belege" trug jede Zeile den Chip
  // "Belege" - das sagt die Breadcrumb schon. Dokumente aus UNTERordnern
  // (der Ordnerfilter zeigt sie mit) behalten ihren Ordner: das ist dort Auskunft.
  assert.equal(typeof facets?.showsFolderChip, 'function', 'showsFolderChip fehlt in document-facets.js');
  const { showsFolderChip } = facets;
  const doc = { folder_id: 7, folder_name: 'Belege' };
  assert.equal(showsFolderChip(doc, 'Finanzen', ''), true, 'in "Alle Dokumente" steht der Ordner');
  assert.equal(showsFolderChip(doc, 'Finanzen', '7'), false, 'im eigenen Ordner nicht');
  assert.equal(showsFolderChip(doc, 'Finanzen', 7), false, 'Zahl oder Text - dieselbe Auswahl');
  assert.equal(showsFolderChip({ folder_id: 9, folder_name: 'Kassenbons' }, 'Finanzen', '7'), true, 'Unterordner bleibt sichtbar');
  assert.equal(showsFolderChip({ folder_id: 3, folder_name: 'Versicherungen' }, 'Versicherung', ''), false, 'die Dopplungsregel gilt weiter');
  assert.equal(showsFolderChip({ folder_id: null, folder_name: null }, 'Finanzen', '__none'), false, 'ohne Ordner kein Chip');
  const meta = fnBody('renderMeta', 'docSupportsThumbnail');
  assert.match(meta, /showsFolderChip\(doc, categoryLabel, state\.folderId\)/, 'die Zeile fragt die Regel wirklich');
});

test('in der schmalen Rasterkarte passt der Titel: Subheadline und bis zu drei Zeilen', () => {
  // Re-Critique 2026-09-25: bei 375px (zwei Spalten, 140px Titelbreite) stand
  // der Titel in Headline-Groesse (17px) und brach nach zwei Zeilen ab - vier
  // von vierzehn Titeln endeten in "...". Gemessen: 15px und drei Zeilen lassen
  // nur noch einen 62-Zeichen-Titel abschneiden; die Karte waechst dabei um
  // hoechstens 14px. Breit bleibt es bei Headline und zwei Zeilen.
  const narrow = [...eachRule(css)].find((r) => r.at.some((a) => a.includes('@container document-card (max-width: 12rem)'))
    && r.selector === '.document-card__title');
  assert.ok(narrow, 'die schmale Karte braucht eine eigene Titelregel');
  assert.match(narrow.body, /font-size:\s*var\(--type-secondary\)/);
  assert.match(narrow.body, /-webkit-line-clamp:\s*3/);
  assert.match(narrow.body, /(^|[^-])line-clamp:\s*3/);
  const base = [...eachRule(css)].find((r) => r.at.length === 0 && r.selector === '.document-card__title');
  assert.match(base.body, /-webkit-line-clamp:\s*2/, 'breit bleiben es zwei Zeilen');
  assert.ok(css.indexOf('@container document-card (max-width: 12rem) {\n  .document-card__title') > css.indexOf('.document-card__title {\n  hyphens: auto;'),
    'die Container-Regel steht HINTER der Basisregel, sonst gewinnt die Basis');
});

test('eine leere Suche bietet die andere Ansicht an - aber nur, wenn sie dort etwas findet', () => {
  // Re-Critique 2026-09-25 (Alex): "in dieser Ansicht" stand da, ein Weg ins
  // Archiv nicht. Der Knopf erscheint nur mit Treffern drueben - ein Weg in
  // den naechsten Leerzustand waere schlechter als keiner.
  const empty = fnBody('emptyStateFor', 'renderEmptyState');
  assert.match(empty, /otherStatusHits\(\) > 0/, 'der Weg haengt an echten Treffern der anderen Ansicht');
  assert.match(empty, /id: 'documents-empty-other-status'/);
  assert.match(empty, /state\.status === 'active' \? 'documents\.searchArchivedAction' : 'documents\.searchActiveAction'/);
  const render = fnBody('renderEmptyState', 'renderDocuments');
  assert.match(render, /if \(state\.query\) probeOtherStatusSearch\(\);/, 'der Leerzustand der Suche fragt die andere Ansicht');
  assert.match(render, /#documents-empty-other-status'\)\?\.addEventListener\('click', \(\) => _statusTablist\?\.setActive\(otherStatus\(\), \{ focus: true \}\)\)/);
  // Die Probe verwirft veraltete Antworten und schluckt keine Programmierfehler.
  const probe = page.slice(page.indexOf('async function probeOtherStatusSearch()'), page.indexOf('function emptyStateFor()'));
  assert.match(probe, /if \(token !== otherStatusProbe \|\| state\.query !== query \|\| state\.status !== status\) return;/);
  assert.match(probe, /if \(err\?\.name !== 'ApiError'\) throw err;/);
  for (const file of readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'))) {
    const locale = JSON.parse(read(`../public/locales/${file}`));
    for (const key of ['searchArchivedAction', 'searchActiveAction']) {
      assert.equal(typeof locale.documents?.[key], 'string', `${file}: documents.${key} fehlt`);
    }
  }
});
