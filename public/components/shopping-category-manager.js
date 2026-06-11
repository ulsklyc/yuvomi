/**
 * Modul: Shopping-Category-Manager Web Component
 * Zweck: Kanonischer Ort für die Verwaltung der Einkaufskategorien
 *        (hinzufügen, umbenennen, sortieren, löschen). Lebt im Shopping-Modul.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js, /utils/shopping-categories.js
 *
 * Verhalten:
 *   - Lädt Kategorien via api.get('/shopping/categories')
 *   - Mutiert über die bestehenden POST/PUT/PATCH-reorder/DELETE-Endpoints
 *   - Dispatcht nach jeder Mutation ein `shopping-categories-changed`-Event,
 *     damit die Shopping-Seite ihren State neu lädt
 *   - Respektiert den serverseitigen Last-Category-Deletion-Guard (zeigt dessen
 *     Fehlermeldung als Toast)
 *   - Räumt Listener in disconnectedCallback() auf
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { categoryLabel } from '/utils/shopping-categories.js';

class ShoppingCategoryManagerElement extends HTMLElement {
  constructor() {
    super();
    this._cats = [];
    this._onListClick = this._onListClick.bind(this);
    this._onAddSubmit = this._onAddSubmit.bind(this);
  }

  connectedCallback() {
    this._renderShell();
    this._load();
  }

  disconnectedCallback() {
    this._list?.removeEventListener('click', this._onListClick);
    this._addForm?.removeEventListener('submit', this._onAddSubmit);
  }

  /** Statisches Gerüst (Überschrift, leere Liste, Add-Form) aufbauen. */
  _renderShell() {
    this.replaceChildren();
    this.insertAdjacentHTML('beforeend', `
      <div class="shopping-cat-manager">
        <h3 class="shopping-cat-manager__title" tabindex="-1">${t('settings.shoppingCategoriesLabel')}</h3>
        <p class="shopping-cat-manager__hint">${t('settings.shoppingCategoriesHint')}</p>
        <ul class="shopping-cat-list" id="shopping-cat-list"></ul>
        <form class="shopping-cat-add-form" id="shopping-cat-add-form" novalidate autocomplete="off">
          <input class="form-input shopping-cat-add-form__input" type="text" id="shopping-cat-add-input"
                 placeholder="${t('settings.shoppingCategoryPlaceholder')}" maxlength="60"
                 aria-label="${t('settings.shoppingCategoryPlaceholder')}" />
          <button type="submit" class="btn btn--primary">${t('common.add')}</button>
        </form>
      </div>
    `);

    this._heading = this.querySelector('.shopping-cat-manager__title');
    this._list = this.querySelector('#shopping-cat-list');
    this._addForm = this.querySelector('#shopping-cat-add-form');
    this._addInput = this.querySelector('#shopping-cat-add-input');

    this._list.addEventListener('click', this._onListClick);
    this._addForm.addEventListener('submit', this._onAddSubmit);
  }

  /** Verschiebt den Tastatur-Fokus auf die Überschrift (für Deep-Link-Öffnung). */
  focusHeading() {
    this._heading?.focus();
  }

  async _load() {
    try {
      const res = await api.get('/shopping/categories');
      this._cats = res.data ?? [];
      this._renderList();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  /** Einzelne Kategorie-Row als HTML. */
  _rowHtml(cat, isFirst, isLast) {
    return `
      <li class="shopping-cat-row" data-cat-id="${cat.id}">
        <i data-lucide="${esc(cat.icon)}" class="shopping-cat-row__icon icon-md" aria-hidden="true"></i>
        <span class="shopping-cat-row__name" data-action="rename-cat"
              title="${t('settings.shoppingCategoryRenameHint')}">${esc(categoryLabel(cat.name))}</span>
        <div class="shopping-cat-row__actions">
          <button class="btn btn--icon btn--ghost" data-action="move-cat-up" data-id="${cat.id}"
                  aria-label="${t('settings.shoppingCategoryMoveUp')}" ${isFirst ? 'disabled' : ''}>
            <i data-lucide="chevron-up" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" data-action="move-cat-down" data-id="${cat.id}"
                  aria-label="${t('settings.shoppingCategoryMoveDown')}" ${isLast ? 'disabled' : ''}>
            <i data-lucide="chevron-down" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--danger-outline" data-action="delete-cat" data-id="${cat.id}"
                  aria-label="${t('settings.shoppingCategoryDelete')}">
            <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
          </button>
        </div>
      </li>`;
  }

  _renderList() {
    if (!this._list) return;
    // DOM-API statt innerHTML (Security-Constraint des Projekts)
    this._list.replaceChildren();
    this._cats.forEach((c, i) => {
      const tmp = document.createElement('div');
      tmp.insertAdjacentHTML('beforeend', this._rowHtml(c, i === 0, i === this._cats.length - 1));
      this._list.appendChild(tmp.firstElementChild);
    });
    if (window.lucide) window.lucide.createIcons({ el: this._list });
  }

  /** Benachrichtigt die umgebende Seite, dass sich die Kategorien geändert haben. */
  _notifyChanged() {
    this.dispatchEvent(new CustomEvent('shopping-categories-changed', {
      bubbles: true,
      detail: { categories: this._cats.map((c) => ({ ...c })) },
    }));
  }

  async _onAddSubmit(e) {
    e.preventDefault();
    const name = this._addInput.value.trim();
    if (!name) return;
    try {
      const res = await api.post('/shopping/categories', { name });
      this._cats.push(res.data);
      this._renderList();
      this._addInput.value = '';
      this._addInput.focus();
      this._notifyChanged();
      window.oikos?.showToast(t('settings.shoppingCategoryAdded'), 'success');
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _onListClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const rowEl = target.closest('[data-cat-id]');
    const id = rowEl ? Number(rowEl.dataset.catId) : Number(target.dataset.id);

    if (action === 'rename-cat') {
      await this._rename(id);
    } else if (action === 'move-cat-up') {
      await this._move(id, -1);
    } else if (action === 'move-cat-down') {
      await this._move(id, 1);
    } else if (action === 'delete-cat') {
      await this._delete(id);
    }
  }

  async _rename(id) {
    const cat = this._cats.find((c) => c.id === id);
    if (!cat) return;
    const { promptModal } = await import('/components/modal.js');
    const newName = await promptModal(t('settings.shoppingCategoryRenamePrompt'), categoryLabel(cat.name));
    if (!newName || newName === cat.name) return;
    try {
      const res = await api.put(`/shopping/categories/${id}`, { name: newName });
      const idx = this._cats.findIndex((c) => c.id === id);
      if (idx >= 0) this._cats[idx] = res.data;
      this._renderList();
      this._notifyChanged();
      window.oikos?.showToast(t('settings.shoppingCategoryRenamed'), 'success');
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _move(id, delta) {
    const idx = this._cats.findIndex((c) => c.id === id);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= this._cats.length) return;
    // Snapshot vor der optimistischen Mutation, um bei API-Fehler zurückzurollen.
    const snapshot = [...this._cats];
    [this._cats[idx], this._cats[nextIdx]] = [this._cats[nextIdx], this._cats[idx]];
    this._renderList();
    try {
      await api.patch('/shopping/categories/reorder', { order: this._cats.map((c) => c.id) });
      this._notifyChanged();
    } catch (err) {
      this._cats = snapshot;
      this._renderList();
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _delete(id) {
    const cat = this._cats.find((c) => c.id === id);
    if (!cat) return;
    const { confirmModal } = await import('/components/modal.js');
    const confirmed = await confirmModal(
      t('settings.shoppingCategoryDeleteConfirm', { name: categoryLabel(cat.name) }),
      { danger: true, confirmLabel: t('common.delete') }
    );
    if (!confirmed) return;
    try {
      // Der Server verweigert das Löschen der letzten Kategorie; dessen
      // Fehlermeldung wird unten als Toast angezeigt (Last-Category-Guard).
      await api.delete(`/shopping/categories/${id}`);
      this._cats = this._cats.filter((c) => c.id !== id);
      this._renderList();
      this._notifyChanged();
      window.oikos?.showToast(t('settings.shoppingCategoryDeleted'), 'default');
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }
}

customElements.define('oikos-shopping-category-manager', ShoppingCategoryManagerElement);

export { ShoppingCategoryManagerElement };
