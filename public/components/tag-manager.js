/**
 * Modul: Tag-Manager Web Component (<yuvomi-tag-manager>)
 * Zweck: Aufgaben-Tags haushaltsweit umbenennen, zusammenführen und entfernen (#586).
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 *
 * Bewusst NICHT der generische category-manager, obwohl die Zeilen ähnlich
 * aussehen. Der verwaltet eine Registry: er legt an, sortiert und sperrt das
 * Löschen, solange etwas darauf zeigt. Ein Tag hat keine Registry - er entsteht,
 * indem ihn eine Aufgabe trägt, und verschwindet mit der letzten. Damit fallen
 * Anlegen und Sortieren weg, und "noch in Benutzung" ist kein Hindernis, sondern
 * die Definition. Die beiden Komponenten zu verschmelzen hieße, dem Tag eine
 * Registry anzudichten - genau die Vermischung mit der Kategorie, die #586
 * auseinanderhält.
 *
 * Verhalten:
 *   - lädt /tasks/tags und zeigt jeden Tag mit seiner Häufigkeit
 *   - Umbenennen auf einen vorhandenen Namen führt zusammen (Server-Semantik)
 *   - Löschen fragt in der Zeile nach, ohne window.confirm
 *   - dispatcht nach jeder Mutation `tag-manager-changed` mit der frischen Liste
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { holdUntilStyled } from '/utils/component-style.js';
import { isImeComposing } from '/utils/ux.js';

/**
 * Haengt an die Erfolgsmeldung an, was liegen blieb (#830).
 *
 * Der Server benennt an gesperrten Aufgaben nichts um, statt den ganzen Aufruf
 * abzuweisen. Ohne diesen Zusatz meldete die Oberflaeche „umbenannt" und der
 * alte Name staende weiter da, ohne dass irgendwo stuende warum.
 */
function withSkipped(message, skipped) {
  return skipped ? `${message} ${t('tasks.tagsSkippedLocked', { count: skipped })}` : message;
}

class TagManagerElement extends HTMLElement {
  constructor() {
    super();
    this._tags = [];
    // Genau eine Zeile ist je Modus offen: { tag, mode: 'rename' | 'delete' }.
    // Als Zustand und nicht als DOM-Abfrage, damit ein Neuzeichnen (nach einer
    // Mutation) die offene Zeile nicht stillschweigend wieder zuklappt.
    this._open = null;
    // Wohin der Fokus nach dem naechsten Neuzeichnen geht: { tag, fallbackIndex }.
    // Ein Neuzeichnen ersetzt die Zeile samt Knopf, auf dem der Fokus stand -
    // ohne Ziel fiele er auf <body>, und wer per Tastatur verwaltet, sucht.
    this._focusAfter = null;
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onKeydown = this._onKeydown.bind(this);
  }

  connectedCallback() {
    // Dieselben `cat-`-Klassen wie der Kategorien-Verwalter, also dessen Blatt.
    holdUntilStyled(this, '/styles/category-manager.css');
    this._renderShell();
    this.load();
  }

  disconnectedCallback() {
    this._root?.removeEventListener('click', this._onClick);
    this._root?.removeEventListener('submit', this._onSubmit);
    this._root?.removeEventListener('keydown', this._onKeydown);
  }

  _renderShell() {
    this.replaceChildren();
    // Kein eigenes <h3>: die Komponente lebt in einem Modal, dessen Kopfzeile
    // den Titel schon trägt (dieselbe Begründung wie im category-manager).
    this.insertAdjacentHTML('beforeend', `
      <div class="cat-manager">
        <p class="cat-manager__hint">${esc(t('tasks.manageTagsHint'))}</p>
        <div class="sr-only" role="status" aria-live="polite" id="tag-manager-announce"></div>
        <ul class="cat-list" id="tag-manager-list"></ul>
      </div>`);
    this._root = this.querySelector('.cat-manager');
    this._listEl = this.querySelector('#tag-manager-list');
    this._announceEl = this.querySelector('#tag-manager-announce');
    this._root.addEventListener('click', this._onClick);
    this._root.addEventListener('submit', this._onSubmit);
    this._root.addEventListener('keydown', this._onKeydown);
    // Die Mehr-Menues der Zeilen (#2152): Lage, Schliessen nach der Wahl, Pfeiltasten.
    installPopoverMenus(this._root);
  }

  async load() {
    try {
      const res = await api.get('/tasks/tags');
      this._tags = res.data ?? [];
    } catch {
      this._tags = [];
    }
    this._renderList();
  }

  _announce(message) {
    if (this._announceEl) this._announceEl.textContent = message;
  }

  _renderList() {
    this._listEl.replaceChildren();

    if (!this._tags.length) {
      this._listEl.insertAdjacentHTML('beforeend',
        `<li class="cat-row"><span class="cat-row__name">${esc(t('tasks.tagsEmpty'))}</span></li>`);
      return;
    }

    this._tags.forEach(({ tag, count }, index) => {
      this._listEl.insertAdjacentHTML('beforeend', this._rowMarkup(tag, count, index));
    });
    if (window.lucide) window.lucide.createIcons({ el: this._listEl });

    // Fokus in die gerade geöffnete Zeile: ohne das landet er nach dem
    // Neuzeichnen am Listenanfang, und wer per Tastatur umbenennt, sucht.
    const renameInput = this.querySelector('#tag-rename-input');
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
      return;
    }
    // Die Rueckfrage zum Entfernen: der Fokus geht auf "Abbrechen", den
    // ungefaehrlichen der beiden Knoepfe.
    const cancel = this._open?.mode === 'delete' ? this._listEl.querySelector('[data-cancel]') : null;
    if (cancel) { cancel.focus(); return; }
    this._restoreFocus();
  }

  /**
   * Nach Abbrechen, Umbenennen oder Entfernen: der Fokus geht an den
   * Mehr-Knopf der Zeile, von der die Handlung kam (#2152). Gibt es die Zeile
   * nicht mehr (entfernt, oder unter neuem Namen mit einer anderen
   * zusammengefuehrt), an den Mehr-Knopf der Zeile, die jetzt an ihrem Platz
   * steht, sonst an die davor - nie auf <body>.
   */
  _restoreFocus() {
    const intent = this._focusAfter;
    this._focusAfter = null;
    if (!intent) return;
    const rows = [...this._listEl.querySelectorAll('.cat-row[data-tag]')];
    const own = rows.find((row) => row.dataset.tag === intent.tag);
    const row = own ?? rows[Math.min(intent.fallbackIndex ?? 0, rows.length - 1)];
    (row?.querySelector('.row-action--more') ?? this._listEl.querySelector('.cat-row__name'))?.focus();
  }

  _rowMarkup(tag, count, index = 0) {
    const open = this._open?.tag === tag ? this._open.mode : null;

    if (open === 'rename') {
      return `
        <li class="cat-row">
          <form class="cat-add-form" data-rename="${esc(tag)}" style="flex:1">
            <input class="input form-input" id="tag-rename-input" type="text" name="name"
                   value="${esc(tag)}" maxlength="64" autocomplete="off"
                   aria-label="${esc(t('tasks.tagRenameLabel', { tag }))}">
            <button type="submit" class="btn btn--primary btn--sm">${esc(t('common.save'))}</button>
            <button type="button" class="btn btn--secondary btn--sm" data-cancel>${esc(t('common.cancel'))}</button>
          </form>
        </li>`;
    }

    if (open === 'delete') {
      return `
        <li class="cat-row">
          <span class="cat-row__name">${esc(t('tasks.tagDeleteConfirm', { tag, count }))}</span>
          <div class="cat-row__actions">
            <button type="button" class="btn btn--danger btn--sm" data-delete-confirm="${esc(tag)}">
              ${esc(t('common.delete'))}
            </button>
            <button type="button" class="btn btn--secondary btn--sm" data-cancel>${esc(t('common.cancel'))}</button>
          </div>
        </li>`;
    }

    // D10 ZEILEN-ENDZONE (#2152): der Name ist das Umbenennen-Ziel, am Ende
    // steht EIN Mehr-Knopf mit Umbenennen und Entfernen. Vorher standen Stift
    // und Papierkorb sichtbar nebeneinander - der Papierkorb dauerhaft rot in
    // jeder Zeile. Sortieren gibt es nicht: die Liste ordnet die Haeufigkeit.
    return `
      <li class="cat-row" data-tag="${esc(tag)}">
        <i data-lucide="tag" class="cat-row__icon" aria-hidden="true"></i>
        <button type="button" class="cat-row__name" data-rename-start="${esc(tag)}"
                title="${esc(t('tasks.tagRenameLabel', { tag }))}">${esc(tag)}</button>
        <span class="cat-row__count">${esc(t('tasks.tagUsageCount', { count }))}</span>
        <div class="cat-row__actions row-actions">
          ${rowMenuHtml({
    id: `tag-row-menu-${index}`,
    label: t('common.moreActionsNamed', { name: tag }),
    items: [
      { action: 'tag-rename', icon: 'pencil', label: t('tasks.tagRenameLabel', { tag }), attrs: { 'data-rename-start': tag } },
      { action: 'tag-delete', icon: 'trash-2', danger: true, label: t('tasks.tagDeleteLabel', { tag }), attrs: { 'data-delete-start': tag } },
    ],
  })}
        </div>
      </li>`;
  }

  _onClick(e) {
    const renameStart = e.target.closest('[data-rename-start]');
    if (renameStart) {
      this._open = { tag: renameStart.dataset.renameStart, mode: 'rename' };
      this._renderList();
      return;
    }

    const deleteStart = e.target.closest('[data-delete-start]');
    if (deleteStart) {
      this._open = { tag: deleteStart.dataset.deleteStart, mode: 'delete' };
      this._renderList();
      return;
    }

    if (e.target.closest('[data-cancel]')) {
      this._focusAfter = this._open ? { tag: this._open.tag, fallbackIndex: this._indexOf(this._open.tag) } : null;
      this._open = null;
      this._renderList();
      return;
    }

    const confirmDelete = e.target.closest('[data-delete-confirm]');
    if (confirmDelete) this._delete(confirmDelete.dataset.deleteConfirm);
  }

  /**
   * Escape in einer geoeffneten Zeile (Umbenennen, Rueckfrage zum Entfernen)
   * bricht genau diese Zeile ab, nicht den ganzen Dialog (#2152) - wie die
   * Bearbeiten-Zeile im Abo-Verwalter. Der Fokus geht zurueck an den
   * Mehr-Knopf der Zeile, aus dem die Handlung kam.
   */
  _onKeydown(e) {
    if (e.key !== 'Escape' || !this._open) return;
    // Esc waehrend einer IME-Umwandlung bricht die Umwandlung ab, nicht das
    // Umbenennen (Codex an #2177) - wie im Bearbeiten-Feld des Abo-Verwalters.
    if (isImeComposing(e)) return;
    if (!e.target.closest?.('[data-rename], [data-cancel], [data-delete-confirm]')) return;
    e.preventDefault();
    e.stopPropagation();
    this._focusAfter = { tag: this._open.tag, fallbackIndex: this._indexOf(this._open.tag) };
    this._open = null;
    this._renderList();
  }

  _indexOf(tag) {
    return Math.max(0, this._tags.findIndex((entry) => entry.tag === tag));
  }

  _onSubmit(e) {
    const form = e.target.closest('[data-rename]');
    if (!form) return;
    e.preventDefault();
    this._rename(form.dataset.rename, form.elements.name.value);
  }

  async _rename(from, rawTo) {
    const to = String(rawTo ?? '').trim();
    // Kein Aufruf für einen unveränderten Namen: der Server zählte null
    // Änderungen und meldete trotzdem Erfolg - eine Rückmeldung, die nichts
    // bedeutet. Ein reiner Wechsel der Schreibweise ist dagegen eine Änderung.
    if (!to || to === from) {
      this._focusAfter = { tag: from, fallbackIndex: this._indexOf(from) };
      this._open = null;
      this._renderList();
      return;
    }

    try {
      const res = await api.put(`/tasks/tags/${encodeURIComponent(from)}`, { name: to });
      const fallbackIndex = this._indexOf(from);
      this._tags = res.data?.tags ?? this._tags;
      // Die Zeile heisst jetzt `to` - auch dann, wenn sie mit einer
      // vorhandenen zusammengefuehrt wurde.
      this._focusAfter = { tag: to, fallbackIndex };
      this._open = null;
      const renamedMsg = withSkipped(t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 }), res.data?.skipped);
      this._announce(renamedMsg);
      window.yuvomi?.showToast?.(renamedMsg, 'success');
      this._renderList();
      this.dispatchEvent(new CustomEvent('tag-manager-changed', { detail: { tags: this._tags } }));
    } catch (err) {
      window.yuvomi?.showToast?.(err.message ?? t('common.errorGeneric'), 'danger');
    }
  }

  async _delete(tag) {
    try {
      const res = await api.delete(`/tasks/tags/${encodeURIComponent(tag)}`);
      const fallbackIndex = this._indexOf(tag);
      this._tags = res.data?.tags ?? this._tags;
      // Die Zeile ist weg: der Fokus geht an die, die jetzt an ihrem Platz steht.
      this._focusAfter = { tag: null, fallbackIndex };
      this._open = null;
      const deletedMsg = withSkipped(t('tasks.tagDeleted', { count: res.data?.updated ?? 0 }), res.data?.skipped);
      this._announce(deletedMsg);
      window.yuvomi?.showToast?.(deletedMsg, 'success');
      this._renderList();
      this.dispatchEvent(new CustomEvent('tag-manager-changed', { detail: { tags: this._tags } }));
    } catch (err) {
      window.yuvomi?.showToast?.(err.message ?? t('common.errorGeneric'), 'danger');
    }
  }
}

customElements.define('yuvomi-tag-manager', TagManagerElement);
