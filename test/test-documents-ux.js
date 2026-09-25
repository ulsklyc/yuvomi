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
  assert.match(page, /doc-badge--google-drive/);
  assert.match(css, /\.doc-badge--google-drive\s*\{/);
  assert.doesNotMatch(css, /\.doc-badge--google-drive\s*\{[^}]*#[0-9a-f]{3,8}/i);
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
  const seen = [];
  const nav = { share() {}, canShare(data) { seen.push(data); return true; } };
  class FakeFile {
    constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts?.type; }
  }
  const pdf = { name: 'pass.pdf', mime_type: 'application/pdf' };
  assert.equal(fileShareSupport({ name: 'x.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { navigator: nav, secure: true, FileCtor: FakeFile }), 'type');
  assert.equal(fileShareSupport(pdf, { navigator: nav, secure: false, FileCtor: FakeFile }), 'unavailable', 'ohne sicheren Kontext gibt es navigator.share() nicht');
  assert.equal(fileShareSupport(pdf, { navigator: { share() {} }, secure: true, FileCtor: FakeFile }), 'unavailable', 'share ohne canShare reicht nicht');
  assert.equal(fileShareSupport(pdf, { navigator: { canShare: () => true }, secure: true, FileCtor: FakeFile }), 'unavailable', "'share' in navigator ist nicht die Frage");
  assert.equal(fileShareSupport(pdf, { navigator: { share() {}, canShare: () => false }, secure: true, FileCtor: FakeFile }), 'unavailable', 'der Browser hat das letzte Wort');
  assert.equal(fileShareSupport(pdf, { navigator: nav, secure: true, FileCtor: FakeFile }), 'ok');
  // Die Probe traegt den Typ und keinen Inhalt: gefragt wird, BEVOR geladen ist.
  const probe = seen.at(-1).files[0];
  assert.equal(probe.type, 'application/pdf');
  assert.deepEqual(probe.parts, []);
  assert.equal(fileShareSupport(pdf, { navigator: { share() {}, canShare() { throw new TypeError('nope'); } }, secure: true, FileCtor: FakeFile }), 'unavailable', 'ein werfendes canShare ist ein Nein, kein Absturz');
});

test('Teilen gibt es nur im Viewer, gated ueber die eine Probe, nie ueber "share in navigator"', () => {
  assert.match(page, /import \{ fileShareSupport \} from '\/utils\/web-share\.js'/);
  assert.match(page, /const shareSupport = fileShareSupport\(doc\)/);
  assert.doesNotMatch(page, /'share' in navigator/, 'das ist auch dort wahr, wo nur Links teilbar sind');
  assert.doesNotMatch(page, /navigator\.share\b[^(]/, 'navigator.share wird aufgerufen, nicht abgefragt');
  // Der Knopf existiert nur bei 'ok'; sonst steht die Erklaerung, kein toter Knopf.
  assert.match(page, /\$\{shareSupport === 'ok' \? `\s*<button type="button"[^>]*data-action="share"/);
  assert.match(page, /shareSupport !== 'ok' \? `<p class="document-viewer__note">\$\{t\(shareSupport === 'type' \? 'documents\.shareUnsupportedType' : 'documents\.shareUnavailable'\)\}<\/p>`/);
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
  for (const key of ['shareAction', 'sharePreparing', 'shareUnsupportedType', 'shareUnavailable', 'shareFailed']) {
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

test('Aktiv/Archiviert ist ein Segment, und im Ruhezustand ist kein Filter getoent', () => {
  const row = filterRowMarkup();
  assert.match(row, /class="segmented documents-status" id="documents-status" role="radiogroup"/);
  assert.match(row, /class="segmented__item\$\{on \? ' is-active' : ''\}"[\s\S]{0,120}role="radio"/);
  assert.doesNotMatch(row, /data-status="[^"]*"[^>]*filter-chip|filter-chip[^>]*data-status=/, 'der Status ist kein Chip mehr');
  assert.match(page, /wireTablist\(_container\.querySelector\('#documents-status'\), \{[\s\S]{0,200}mode: 'select'/);
  // "Alle Kategorien" ist die Abwesenheit eines Filters - getoent sah es aus
  // wie ein aktiver Filter, der Grundzustand trug zwei getoente Chips.
  const chips = page.slice(page.indexOf('function renderCategoryChips'), page.indexOf('function renderExpiringChip'));
  const allChip = chips.slice(chips.indexOf('data-category=""') - 200, chips.indexOf('data-category=""') + 80);
  assert.doesNotMatch(allChip, /filter-chip--active/, '"Alle Kategorien" traegt nie die Tonung');
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
