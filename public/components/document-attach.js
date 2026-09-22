/**
 * Modul: Beleg-Feld (Dokumente anhängen)
 * Zweck: Ein Formularfeld, das Dokumente aus dem Dokumente-Modul an einen
 *        Datensatz hängt - vorhandene verknüpfen oder neue hochladen.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 *
 * Warum geteilt: Kalender, Hauswirtschaft und Dokumente führten je eine eigene
 * Dropzone, und keine davon konnte ein bereits abgelegtes Dokument auswählen -
 * hochladen ging, wiederverwenden nicht. Diese Komponente ist die eine Stelle,
 * an der beides passiert (#583).
 *
 * Muster wie rrule-ui.js: HTML-Fragment für den Modal-Content, danach ein
 * bind()-Aufruf im onSave-Hook, der einen Controller zurückgibt.
 *
 *   ${renderDocumentAttachField({ attachments: entry.attachments })}
 *   const belege = bindDocumentAttachField(panel, { category: 'finance' });
 *   body.attachment_document_ids = await belege.commit();
 *
 * commit() lädt erst beim Speichern hoch. Bricht der Nutzer das Formular ab,
 * bleibt keine verwaiste Datei im Dokumente-Modul zurück.
 *
 * DAS FELD SCHREIBT IN EIN FREMDES MODUL (#1265). Es hängt an Aufgaben, Budget,
 * Gemeinsamen Ausgaben und Inventar, das Hochladen ist aber `POST /documents`
 * und damit eine Frage an das Dokumente-Recht - das Recht der Seite sagt
 * darüber nichts. Wer `tasks: write` und `documents: read` hatte, sah ein
 * Hochladen-Feld, dessen Speichern im 403 endete. Die Antwort je Stufe, gemessen
 * an dem, was der Server annimmt:
 *
 *   - `write`: unverändert.
 *   - `read`:  Hochladen verschwindet - der Knopf, das Dateifeld, der Hinweis
 *              auf die Größe, und die Ablagefläche wird gar nicht erst
 *              verdrahtet (bei Ziehen gibt es kein Markup zum Wegnehmen).
 *              Vorhandene Anhänge bleiben als Zustand stehen und lassen sich
 *              öffnen. Verknüpfen und Lösen BLEIBEN: die Auswahl liest
 *              `GET /documents`, und die Verknüpfung speichert die Seite über
 *              ihren EIGENEN Pfad (`PUT /tasks/:id/documents`,
 *              `attachment_document_ids`) - der Server urteilt dort über das
 *              Modul der Seite, nicht über Dokumente.
 *   - `none`:  kein Feld. Schon das Lesen antwortet mit 403, die Auswahl bliebe
 *              leer und jeder Anhang-Link ginge ins Leere. bind() findet dann
 *              kein Feld und gibt `null` zurück; alle vier Aufrufer lassen die
 *              Verknüpfungen in diesem Fall unberührt (sie senden das Feld
 *              nicht mit), statt sie mit einer leeren Liste zu löschen.
 *
 * Die Entscheidung fällt EINMAL, beim Rendern; bind() verdrahtet nur, was im
 * Markup steht.
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { isPreviewable } from '/utils/document-preview.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { pathAccess, mayWritePath } from '/utils/module-access.js';



// Spiegelt die Upload-Allowlist des Servers (server/routes/documents.js).
// Der Server bleibt die Instanz, die ablehnt - das accept-Attribut erspart dem
// Nutzer nur den Umweg über eine Fehlermeldung.
const ACCEPT = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

const FIELD_CLASS = 'doc-attach';

/**
 * HTML des Beleg-Felds. Gehört in den Modal-Content.
 * @param {object} options
 * @param {object[]} [options.attachments] - bereits verknüpfte Dokumente
 * @param {string} [options.label] - Feld-Beschriftung
 * @param {string} [options.hint] - Hinweistext unter den Aktionen. Ohne ihn
 *        steht der allgemeine Hinweis da - der nennt das Hochladen und entfällt
 *        deshalb, wo es nicht angeboten wird.
 * @param {string} [options.icon] - Lucide-Icon der leeren Fläche
 * @returns {string} leer, wenn das Dokumente-Modul nicht einmal lesbar ist
 */
export function renderDocumentAttachField({
  attachments = [],
  label = t('documentAttach.label'),
  hint,
  icon = 'paperclip',
  maxItems = 0,
} = {}) {
  if (pathAccess('/documents') === 'none') return '';
  const canUpload = mayWritePath('/documents');
  const hintText = hint ?? (canUpload ? t('documentAttach.hint', { size: maxUploadMb() }) : '');
  // Vorbelegung als data-Attribut: hält render und bind entkoppelt, der
  // Aufrufer muss die Liste nicht ein zweites Mal an bind() reichen.
  const initial = attachments
    .filter((a) => a?.document_id)
    .map((a) => ({ id: a.document_id, name: a.name || a.original_name || '', mime: a.mime_type || '' }));

  return `
    <div class="form-group ${FIELD_CLASS}" data-doc-attach
         data-doc-attach-initial="${esc(JSON.stringify(initial))}"
         data-doc-attach-max="${Number(maxItems) || 0}">
      <span class="form-label" id="doc-attach-label">${esc(label)}</span>
      <div class="doc-attach__chips" data-doc-attach-chips role="list"
           aria-labelledby="doc-attach-label"></div>
      <p class="doc-attach__empty" data-doc-attach-empty hidden>
        <i data-lucide="${esc(icon)}" aria-hidden="true"></i>
        <span>${esc(t('documentAttach.emptyState'))}</span>
      </p>
      <div class="doc-attach__actions">
        ${canUpload ? `<button class="btn btn--secondary doc-attach__action" type="button" data-doc-attach-upload>
          <i data-lucide="upload" aria-hidden="true"></i>
          <span>${esc(t('documentAttach.uploadAction'))}</span>
        </button>` : ''}
        <button class="btn btn--secondary doc-attach__action" type="button" data-doc-attach-pick>
          <i data-lucide="folder-open" aria-hidden="true"></i>
          <span>${esc(t('documentAttach.pickAction'))}</span>
        </button>
      </div>
      ${canUpload ? `<input class="sr-only" type="file" multiple accept="${ACCEPT}" data-doc-attach-input
             aria-labelledby="doc-attach-label">` : ''}
      ${hintText ? `<p class="form-hint">${esc(hintText)}</p>` : ''}
    </div>`;
}

/**
 * Die verknüpften Belege für eine LESEANSICHT (#1265 P7): je Dokument ein Link,
 * als DOM gebaut, damit er als `node` in `openDetailView`-Zeilen passt.
 *
 * Dieselbe Rechtefrage wie das Feld oben, und aus demselben Grund: die Belege
 * gehören dem Dokumente-Modul. Bei `documents: none` antwortet schon das Lesen
 * mit 403, jeder Link ginge ins Leere - dann gibt es keine Zeile (`null`), und
 * die Leseansicht schweigt über sie wie P6 über den Beleg eines Einsatzes.
 * Bei `read` und `write` öffnet der Link das Dokument; Lösen und Hochladen
 * gibt es hier nicht, eine Leseansicht bietet keine Handlung an.
 *
 * @param {object[]} attachments - `{ document_id, name, original_name, mime_type }`
 * @returns {HTMLElement|null}
 */
export function attachmentLinksNode(attachments = []) {
  if (pathAccess('/documents') === 'none') return null;
  const list = (attachments || []).filter(Boolean);
  const docs = list.filter((a) => a.document_id);
  // Ein Beleg, den der Server nicht nennt (#1358): die Zeile kommt mit
  // `document_id: null` und ohne Namen. Wie beim Beleg eines Einsatzes steht
  // dann ein ruhiges "Vorhanden" statt eines Links, der ins Leere ginge.
  const hidden = list.length > docs.length;
  if (!docs.length && !hidden) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-chips';
  if (hidden) {
    const present = document.createElement('span');
    present.className = 'detail-attachment detail-attachment--present';
    present.textContent = t('documentAttach.presentHidden');
    wrap.appendChild(present);
  }
  for (const doc of docs) {
    const name = doc.name || doc.original_name || '';
    const link = document.createElement('a');
    link.className = 'detail-attachment detail-attachment--file';
    // Vorschaubar -> /preview, sonst /download: dieselbe Weiche wie die Chips
    // des Felds, sonst endete eine DOCX im 415.
    link.href = `/api/v1/documents/${Number(doc.document_id)}/${isPreviewable(doc.mime_type) ? 'preview' : 'download'}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = t('documentAttach.openAction', { name });
    const icon = document.createElement('i');
    icon.dataset.lucide = 'paperclip';
    icon.className = 'icon-md';
    icon.setAttribute('aria-hidden', 'true');
    link.append(icon, document.createTextNode(name));
    wrap.appendChild(link);
  }
  return wrap;
}

/**
 * Verdrahtet das Feld und gibt einen Controller zurück.
 *
 * Ein Feld je Formular: bind() greift das erste `[data-doc-attach]` im Panel,
 * und die Beschriftungs-ID ist fest. Zwei Beleg-Felder in einem Modal gäbe es
 * bisher nirgends - käme das auf, braucht render() eine Instanz-ID.
 *
 * @param {HTMLElement} panel - Container, in dem das Feld steckt
 * @param {object} options
 * @param {string|Function} [options.category] - Dokument-Kategorie für neue
 *        Uploads. Ein fester String (Standard) oder eine Funktion, die bei
 *        jedem commit() frisch ausgewertet wird - für Aufrufer mit einem
 *        Kategorie-Auswahlfeld im Formular (z. B. Inventar).
 * @param {string} [options.folderKey] - Schlüssel des Systemordners, in dem das
 *        Modul seine Belege ablegt ('budget', 'tasks', ...). Er bestimmt, WELCHER
 *        Ordner gemeint ist; `folderName` ist nur dessen Beschriftung, falls er
 *        erst noch entstehen muss. Vor Migration v157 trug der Name selbst die
 *        Identität, und zwei Sprachen ergaben zwei Ordner.
 * @param {string} [options.folderName] - Beschriftung für einen neu entstehenden Ordner
 * @param {string|Function} [options.visibility] - Sichtbarkeit neuer Uploads.
 *        Fester String oder eine Funktion, die bei jedem commit() frisch
 *        ausgewertet wird - fuer Formulare, in denen die Sichtbarkeit des
 *        Datensatzes selbst noch umgestellt werden kann.
 * @param {Function} [options.allowedMemberIds] - () => number[], nur fuer
 *        `restricted` ausgewertet: wer das Dokument sehen darf.
 * @param {Function} [options.documentName] - (file) => Anzeigename des Uploads
 * @param {number} [options.maxFileSize]
 * @returns {{ commit: Function, documentIds: Function, isDirty: Function }|null}
 */
export function bindDocumentAttachField(panel, {
  category = 'other',
  folderKey = '',
  folderName = '',
  visibility = 'family',
  allowedMemberIds = null,
  documentName = null,
  maxFileSize = maxUploadBytes(),
} = {}) {
  const field = panel?.querySelector('[data-doc-attach]');
  if (!field) return null;

  const chipsEl = field.querySelector('[data-doc-attach-chips]');
  const emptyEl = field.querySelector('[data-doc-attach-empty]');
  // Fehlt das Dateifeld, hat render() das Hochladen nicht angeboten (kein
  // Schreibrecht auf Dokumente) - dann bleibt auch jede Verdrahtung dafuer aus.
  const fileInput = field.querySelector('[data-doc-attach-input]');
  const initialIds = readInitialIds(field);
  // 0 = unbegrenzt. Bei 1 nimmt das Feld genau einen Beleg an (Zahlungsnachweis:
  // das Datenmodell hat dort eine einzelne Spalte, ein zweiter Beleg ginge beim
  // Speichern verloren) - dann ersetzt eine neue Wahl die bisherige.
  const maxItems = Number(field.dataset.docAttachMax) || 0;
  if (maxItems === 1) fileInput?.removeAttribute('multiple');

  // Zwei Sorten Einträge in einer Liste, damit die Reihenfolge der Chips der
  // Reihenfolge des Hinzufügens entspricht:
  //   { kind: 'document', id, name }  - existiert bereits serverseitig
  //   { kind: 'file', file, name }    - wird erst bei commit() hochgeladen
  const items = initialIds.map((entry) => ({ kind: 'document', id: entry.id, name: entry.name, mime: entry.mime || '' }));

  const renderChips = () => {
    chipsEl.replaceChildren();
    for (const [index, item] of items.entries()) {
      // Bereits abgelegte Dokumente sind anklickbar - ein Beleg, den man nicht
      // ansehen kann, ist kein Beleg. Wartende Uploads haben noch keine URL.
      // Vorschaubar -> /preview, sonst /download. Der feste /preview-Link war
      // fuer eine DOCX oder XLSX ein 415: die Datei war angehaengt, aber nicht
      // mehr zu oeffnen. Welche Typen der Browser inline zeigt, steht einmal in
      // utils/document-preview.js.
      const href = `/api/v1/documents/${item.id}/${isPreviewable(item.mime) ? 'preview' : 'download'}`;
      const nameHtml = item.kind === 'file'
        ? `<span class="doc-attach__chip-name">${esc(item.name)}</span>`
        : `<a class="doc-attach__chip-name" href="${href}"
              target="_blank" rel="noopener noreferrer"
              title="${esc(t('documentAttach.openAction', { name: item.name }))}">${esc(item.name)}</a>`;
      chipsEl.insertAdjacentHTML('beforeend', `
        <span class="doc-attach__chip${item.kind === 'file' ? ' doc-attach__chip--pending' : ''}" role="listitem">
          <i data-lucide="${item.kind === 'file' ? 'upload-cloud' : 'file-text'}" aria-hidden="true"></i>
          ${nameHtml}
          <button class="doc-attach__chip-remove" type="button" data-doc-attach-remove="${index}"
                  aria-label="${esc(t('documentAttach.removeAction', { name: item.name }))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </span>`);
    }
    emptyEl.hidden = items.length > 0;
    if (window.lucide) window.lucide.createIcons({ el: chipsEl });
  };

  /** Nimmt einen Eintrag auf; bei maxItems=1 ersetzt er den bisherigen. */
  const addItem = (item) => {
    if (maxItems === 1) items.length = 0;
    else if (maxItems && items.length >= maxItems) {
      window.yuvomi?.showToast(t('documentAttach.limitReached', { count: maxItems }), 'danger');
      return false;
    }
    items.push(item);
    return true;
  };

  chipsEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-doc-attach-remove]');
    if (!button) return;
    items.splice(Number(button.dataset.docAttachRemove), 1);
    renderChips();
  });

  if (fileInput) wireUpload(field, fileInput, (files) => {
    for (const file of files || []) {
      if (file.size > maxFileSize) {
        window.yuvomi?.showToast(t('documents.fileTooLarge', { size: maxUploadMb() }), 'danger');
        continue;
      }
      if (!addItem({ kind: 'file', file, name: file.name })) break;
    }
    renderChips();
  });

  field.querySelector('[data-doc-attach-pick]').addEventListener('click', async () => {
    const alreadyLinked = new Set(items.filter((i) => i.kind === 'document').map((i) => i.id));
    const picked = await openDocumentPicker(panel, { excludeIds: alreadyLinked, single: maxItems === 1 });
    for (const doc of picked) {
      if (!addItem({ kind: 'document', id: doc.id, name: doc.name, mime: doc.mime_type || '' })) break;
    }
    if (picked.length) renderChips();
  });

  renderChips();

  return {
    /** IDs ohne Upload - für Aufrufer, die nur den aktuellen Stand brauchen. */
    documentIds: () => items.filter((i) => i.kind === 'document').map((i) => i.id),

    /** true, sobald noch nicht hochgeladene Dateien warten. */
    isDirty: () => items.some((i) => i.kind === 'file'),

    /**
     * Lädt wartende Dateien hoch und gibt alle Dokument-IDs zurück.
     * Wirft, wenn ein Upload fehlschlägt - der Aufrufer soll dann nicht
     * speichern, sonst stünde die Buchung ohne den Beleg da, den der Nutzer
     * angehängt zu haben glaubt.
     * @returns {Promise<number[]>}
     */
    async commit() {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        // Sichtbarkeit erst beim Hochladen aufloesen: in einem Formular, das
        // sie selbst fuehrt (Aufgaben), kann sie zwischen Dateiwahl und
        // Speichern noch umgestellt worden sein.
        const vis = typeof visibility === 'function' ? visibility() : visibility;
        const res = await api.post('/documents', {
          name: documentName ? documentName(item.file) : item.file.name,
          description: '',
          category: typeof category === 'function' ? category() : category,
          visibility: vis,
          status: 'active',
          allowed_member_ids: vis === 'restricted' && allowedMemberIds ? allowedMemberIds() : [],
          original_name: item.file.name,
          content_data: await readFileAsDataUrl(item.file),
          ...(folderKey ? { folder_key: folderKey } : {}),
          ...(folderName ? { folder_name: folderName } : {}),
        });
        item.kind = 'document';
        item.id = res.data?.id;
        item.name = res.data?.name || item.name;
        item.mime = res.data?.mime_type || item.file?.type || '';
        delete item.file;
      }
      return items.filter((i) => i.id).map((i) => i.id);
    },
  };
}

/**
 * Die drei Wege, auf denen eine Datei zum Hochladen ins Feld kommt: Knopf,
 * Dateidialog und Fallenlassen. Nur verdrahtet, wenn render() das Dateifeld
 * gezeichnet hat - ohne Schreibrecht auf Dokumente haengt am Feld also auch
 * kein `drop`, und eine hineingezogene Datei wird gar nicht erst angenommen.
 *
 * @param {HTMLElement} field
 * @param {HTMLInputElement} fileInput
 * @param {(files: FileList|File[]) => void} acceptFiles
 */
function wireUpload(field, fileInput, acceptFiles) {
  field.querySelector('[data-doc-attach-upload]')?.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    acceptFiles(fileInput.files);
    // Zurücksetzen, sonst löst dieselbe Datei beim zweiten Mal kein change aus.
    fileInput.value = '';
  });

  // Fallenlassen statt suchen (#733). Der Browser öffnet eine hierher gezogene
  // Datei sonst im Tab und verwirft dabei das ausgefüllte Formular darunter -
  // deshalb hängt der Abbruch am Feld und nicht am Fenster: Dateien, die
  // woanders landen, gehen weiterhin ihren eigenen Weg.
  const setDragging = (on) => field.classList.toggle('doc-attach--dragging', on);
  field.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  });
  field.addEventListener('dragleave', (event) => {
    // Nur, wenn der Zeiger das Feld wirklich verlässt - beim Wechsel zwischen
    // Kindelementen feuert dragleave sonst und das Feld flackert.
    if (field.contains(event.relatedTarget)) return;
    setDragging(false);
  });
  field.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer.files);
  });
}

/** Liest die von renderDocumentAttachField hinterlegte Vorbelegung. */
function readInitialIds(field) {
  try {
    return JSON.parse(field.dataset.docAttachInitial || '[]');
  } catch {
    return [];
  }
}

/**
 * Auswahl-Overlay für bereits abgelegte Dokumente.
 *
 * Bewusst ein Overlay im Panel und kein zweites Modal: Das geteilte Modal ist
 * nicht verschachtelbar, und ein zweites würde das Formular darunter schließen.
 *
 * @param {HTMLElement} panel
 * @param {object} options
 * @param {Set<number>} [options.excludeIds] - bereits verknüpfte Dokumente
 * @param {boolean} [options.single] - nur ein Dokument wählbar
 * @returns {Promise<object[]>} ausgewählte Dokumente
 */
function openDocumentPicker(panel, { excludeIds = new Set(), single = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'doc-attach-picker';
    overlay.insertAdjacentHTML('afterbegin', `
      <div class="doc-attach-picker__panel" role="dialog" aria-modal="true"
           aria-label="${esc(t('documentAttach.pickerTitle'))}">
        <div class="doc-attach-picker__header">
          <strong>${esc(t('documentAttach.pickerTitle'))}</strong>
          <button class="btn btn--icon" type="button" data-picker-close
                  aria-label="${esc(t('common.cancel'))}">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </div>
        <input class="form-input doc-attach-picker__search" type="search" data-picker-search
               placeholder="${esc(t('documentAttach.searchPlaceholder'))}"
               aria-label="${esc(t('documentAttach.searchPlaceholder'))}">
        <div class="doc-attach-picker__list" data-picker-list>
          <p class="doc-attach-picker__status">${esc(t('common.loading'))}</p>
        </div>
        <div class="doc-attach-picker__footer">
          <button class="btn btn--secondary" type="button" data-picker-close>${esc(t('common.cancel'))}</button>
          <button class="btn btn--primary" type="button" data-picker-confirm disabled>
            ${esc(t('documentAttach.confirmSelection'))}
          </button>
        </div>
      </div>`);
    panel.append(overlay);
    if (window.lucide) window.lucide.createIcons({ el: overlay });

    const listEl = overlay.querySelector('[data-picker-list]');
    const searchEl = overlay.querySelector('[data-picker-search]');
    const confirmEl = overlay.querySelector('[data-picker-confirm]');
    // Der Auslöser bekommt den Fokus zurück - das Overlay liegt über einem
    // offenen Modal, sonst fiele der Fokus auf <body>.
    const opener = document.activeElement;
    const selected = new Set();
    let documents = [];

    const close = (result) => {
      overlay.remove();
      if (opener?.isConnected) opener.focus();
      resolve(result);
    };
    // Das Overlay liegt ueber einem offenen Modal; die Zurueck-Geste meint
    // deshalb zuerst den Picker (#871). Ohne Auswahl heisst zu: abgebrochen.
    attachOverlay(overlay, () => close(null));

    const renderList = () => {
      const needle = searchEl.value.trim().toLowerCase();
      const visible = documents.filter((doc) => {
        if (excludeIds.has(doc.id)) return false;
        if (!needle) return true;
        return `${doc.name} ${doc.original_name || ''}`.toLowerCase().includes(needle);
      });

      listEl.replaceChildren();
      if (!visible.length) {
        listEl.insertAdjacentHTML('afterbegin',
          `<p class="doc-attach-picker__status">${esc(t('documentAttach.noDocuments'))}</p>`);
        return;
      }
      for (const doc of visible) {
        listEl.insertAdjacentHTML('beforeend', `
          <label class="doc-attach-picker__item">
            <input type="checkbox" value="${doc.id}" ${selected.has(doc.id) ? 'checked' : ''}>
            <span class="doc-attach-picker__item-body">
              <span class="doc-attach-picker__item-name">${esc(doc.name)}</span>
              <span class="doc-attach-picker__item-meta">${esc(pickerMeta(doc))}</span>
            </span>
          </label>`);
      }
    };

    listEl.addEventListener('change', (event) => {
      const box = event.target.closest('input[type="checkbox"]');
      if (!box) return;
      const id = Number(box.value);
      // Ein-Dokument-Feld: die neue Wahl ersetzt die alte, statt eine zweite
      // Checkbox stehen zu lassen, die beim Übernehmen ignoriert würde.
      if (single && box.checked) {
        selected.clear();
        for (const other of listEl.querySelectorAll('input[type="checkbox"]')) {
          if (other !== box) other.checked = false;
        }
      }
      if (box.checked) selected.add(id); else selected.delete(id);
      confirmEl.disabled = selected.size === 0;
    });

    searchEl.addEventListener('input', renderList);
    overlay.querySelectorAll('[data-picker-close]').forEach((button) => {
      button.addEventListener('click', () => close([]));
    });
    confirmEl.addEventListener('click', () => {
      close(documents.filter((doc) => selected.has(doc.id)));
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close([]);
    });
    // Escape und Fokus-Trap auf Overlay-Ebene: sonst tabbt man aus dem Dialog
    // heraus in das Formular darunter.
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close([]); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button, input')].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    searchEl.focus();

    api.get('/documents').then((res) => {
      documents = res.data || [];
      renderList();
    }).catch(() => {
      listEl.replaceChildren();
      listEl.insertAdjacentHTML('afterbegin',
        `<p class="doc-attach-picker__status">${esc(t('documentAttach.loadFailed'))}</p>`);
    });
  });
}

/** Zweitzeile eines Picker-Eintrags: Ordner und Datum, soweit vorhanden. */
function pickerMeta(doc) {
  return [doc.folder_name, doc.created_at ? formatDate(doc.created_at) : '']
    .filter(Boolean)
    .join(' · ');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t('documents.fileReadError')));
    reader.readAsDataURL(file);
  });
}
