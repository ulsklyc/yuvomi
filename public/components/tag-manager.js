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
import { rowActionHtml } from '/utils/row-action.js';

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
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    this._renderShell();
    this.load();
  }

  disconnectedCallback() {
    this._root?.removeEventListener('click', this._onClick);
    this._root?.removeEventListener('submit', this._onSubmit);
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

    for (const { tag, count } of this._tags) {
      this._listEl.insertAdjacentHTML('beforeend', this._rowMarkup(tag, count));
    }
    if (window.lucide) window.lucide.createIcons({ el: this._listEl });

    // Fokus in die gerade geöffnete Zeile: ohne das landet er nach dem
    // Neuzeichnen am Listenanfang, und wer per Tastatur umbenennt, sucht.
    this.querySelector('#tag-rename-input')?.focus();
    this.querySelector('#tag-rename-input')?.select();
  }

  _rowMarkup(tag, count) {
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

    return `
      <li class="cat-row">
        <i data-lucide="tag" class="cat-row__icon" aria-hidden="true"></i>
        <button type="button" class="cat-row__name" data-rename-start="${esc(tag)}"
                title="${esc(t('tasks.tagRenameLabel', { tag }))}">${esc(tag)}</button>
        <span class="cat-row__count">${esc(t('tasks.tagUsageCount', { count }))}</span>
        <div class="cat-row__actions">
          ${rowActionHtml({ icon: 'pencil', label: t('tasks.tagRenameLabel', { tag }), attrs: { 'data-rename-start': tag } })}
          ${rowActionHtml({ icon: 'trash-2', tone: 'danger', label: t('tasks.tagDeleteLabel', { tag }), attrs: { 'data-delete-start': tag } })}
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
      this._open = null;
      this._renderList();
      return;
    }

    const confirmDelete = e.target.closest('[data-delete-confirm]');
    if (confirmDelete) this._delete(confirmDelete.dataset.deleteConfirm);
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
      this._open = null;
      this._renderList();
      return;
    }

    try {
      const res = await api.put(`/tasks/tags/${encodeURIComponent(from)}`, { name: to });
      this._tags = res.data?.tags ?? this._tags;
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
      this._tags = res.data?.tags ?? this._tags;
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
