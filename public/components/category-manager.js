/**
 * Modul: Generischer Category-Manager Web Component
 * Zweck: Wiederverwendbare Verwaltung von Kategorien (und optional Subkategorien)
 *        für Budget, Tasks, Contacts. Konfiguration per configure().
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 *
 * Verhalten:
 *   - configure({ basePath, groups, supportsSubcategories, labelResolver, titleKey, hintKey })
 *   - Lädt via api.get(basePath); mutiert über post/put/patch/delete relativ zu basePath
 *   - Dispatcht nach jeder Mutation `category-manager-changed`
 *   - Zeigt Server-Guard-Fehler (in-use/last) als Toast
 *   - Räumt Listener in disconnectedCallback() auf
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

class CategoryManagerElement extends HTMLElement {
  constructor() {
    super();
    this._basePath = '';
    this._groups = [{ key: '', labelKey: '', addLabelKey: 'common.add' }];
    this._supportsSub = false;
    this._labelResolver = (item) => item.label ?? item.name; // Server liefert lokalisiertes `label`
    this._titleKey = 'category.manageTitle';
    this._hintKey = 'category.manageHint';
    this._cats = [];
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  configure(opts) {
    this._basePath = opts.basePath;
    if (Array.isArray(opts.groups) && opts.groups.length) this._groups = opts.groups;
    this._supportsSub = !!opts.supportsSubcategories;
    if (typeof opts.labelResolver === 'function') this._labelResolver = opts.labelResolver;
    if (opts.titleKey) this._titleKey = opts.titleKey;
    if (opts.hintKey) this._hintKey = opts.hintKey;
    this._renderShell();
    this._load();
  }

  disconnectedCallback() {
    this._root?.removeEventListener('click', this._onClick);
    this._root?.removeEventListener('submit', this._onSubmit);
  }

  _renderShell() {
    this.replaceChildren();
    this.insertAdjacentHTML('beforeend', `
      <div class="cat-manager">
        <h3 class="cat-manager__title" tabindex="-1">${esc(t(this._titleKey))}</h3>
        <p class="cat-manager__hint">${esc(t(this._hintKey))}</p>
        <div class="cat-manager__groups" id="cat-manager-groups"></div>
      </div>`);
    this._root = this.querySelector('.cat-manager');
    this._groupsEl = this.querySelector('#cat-manager-groups');
    this._root.addEventListener('click', this._onClick);
    this._root.addEventListener('submit', this._onSubmit);
  }

  async _load() {
    try {
      const res = await api.get(this._basePath);
      this._cats = res.data ?? [];
      this._render();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  _inGroup(groupKey) {
    if (!groupKey) return this._cats;
    return this._cats.filter((c) => (c.type ?? c.group ?? '') === groupKey);
  }

  _render() {
    if (!this._groupsEl) return;
    this._groupsEl.replaceChildren();
    this._groups.forEach((g) => {
      const items = this._inGroup(g.key);
      const tmp = document.createElement('div');
      tmp.insertAdjacentHTML('beforeend', `
        <section class="cat-group" data-group="${esc(g.key)}">
          ${g.labelKey ? `<h4 class="cat-group__title">${esc(t(g.labelKey))}</h4>` : ''}
          <ul class="cat-list">
            ${items.map((c, i) => this._rowHtml(c, g, i === 0, i === items.length - 1)).join('')}
          </ul>
          <form class="cat-add-form" data-group="${esc(g.key)}" novalidate autocomplete="off">
            <input class="form-input" type="text" maxlength="60"
                   placeholder="${esc(t('category.addPlaceholder'))}"
                   aria-label="${esc(t('category.addPlaceholder'))}" />
            <button type="submit" class="btn btn--primary">${esc(t(g.addLabelKey || 'common.add'))}</button>
          </form>
        </section>`);
      this._groupsEl.appendChild(tmp.firstElementChild);
    });
    if (window.lucide) window.lucide.createIcons({ el: this._groupsEl });
  }

  _rowHtml(cat, group, isFirst, isLast) {
    // Subkategorie-Block wird erst in Task 5 ergänzt; group wird dort ausgewertet.
    return `
      <li class="cat-row" data-key="${esc(String(cat.key))}">
        <span class="cat-row__name" data-action="rename"
              title="${esc(t('category.renameHint'))}">${esc(this._labelResolver(cat))}</span>
        <div class="cat-row__actions">
          <button class="btn btn--icon btn--ghost" data-action="up"
                  aria-label="${esc(t('category.moveUp'))}" ${isFirst ? 'disabled' : ''}>
            <i data-lucide="chevron-up" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" data-action="down"
                  aria-label="${esc(t('category.moveDown'))}" ${isLast ? 'disabled' : ''}>
            <i data-lucide="chevron-down" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--danger-outline" data-action="delete"
                  aria-label="${esc(t('category.delete'))}">
            <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
          </button>
        </div>
      </li>`;
  }

  _notifyChanged() {
    this.dispatchEvent(new CustomEvent('category-manager-changed', { bubbles: true }));
  }

  async _onSubmit(e) {
    e.preventDefault();
    const form = e.target.closest('.cat-add-form');
    if (!form) return;
    const input = form.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    const group = form.dataset.group;
    try {
      const body = { name };
      if (group) body.type = group;
      const res = await api.post(this._basePath, body);
      this._cats.push(res.data);
      this._render();
      window.oikos?.showToast(t('category.added'), 'success');
      this._notifyChanged();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _onClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const row = target.closest('[data-key]');
    if (!row) return;
    const key = row.dataset.key;
    const action = target.dataset.action;
    if (action === 'rename') await this._rename(key);
    else if (action === 'up') await this._move(key, -1);
    else if (action === 'down') await this._move(key, 1);
    else if (action === 'delete') await this._delete(key);
  }

  async _rename(key) {
    const cat = this._cats.find((c) => String(c.key) === key);
    if (!cat) return;
    const { promptModal } = await import('/components/modal.js');
    const newName = await promptModal(t('category.renamePrompt'), this._labelResolver(cat));
    if (!newName || newName === cat.name) return;
    try {
      const res = await api.put(`${this._basePath}/${encodeURIComponent(key)}`, { name: newName });
      const idx = this._cats.findIndex((c) => String(c.key) === key);
      if (idx >= 0) this._cats[idx] = res.data;
      this._render();
      window.oikos?.showToast(t('category.renamed'), 'success');
      this._notifyChanged();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _move(key, delta) {
    const cat = this._cats.find((c) => String(c.key) === key);
    if (!cat) return;
    const groupKey = cat.type ?? cat.group ?? '';
    const group = this._inGroup(groupKey);
    const idx = group.findIndex((c) => String(c.key) === key);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= group.length) return;
    [group[idx], group[nextIdx]] = [group[nextIdx], group[idx]];
    try {
      const body = { order: group.map((c) => c.key) };
      if (groupKey) body.type = groupKey;
      await api.patch(`${this._basePath}/reorder`, body);
      await this._load();
      this._notifyChanged();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }

  async _delete(key) {
    const cat = this._cats.find((c) => String(c.key) === key);
    if (!cat) return;
    const { confirmModal } = await import('/components/modal.js');
    const confirmed = await confirmModal(
      t('category.deleteConfirm', { name: this._labelResolver(cat) }),
      { danger: true, confirmLabel: t('common.delete') }
    );
    if (!confirmed) return;
    try {
      await api.delete(`${this._basePath}/${encodeURIComponent(key)}`);
      this._cats = this._cats.filter((c) => String(c.key) !== key);
      this._render();
      window.oikos?.showToast(t('category.deleted'), 'default');
      this._notifyChanged();
    } catch (err) {
      window.oikos?.showToast(err.message, 'danger');
    }
  }
}

customElements.define('oikos-category-manager', CategoryManagerElement);
export { CategoryManagerElement };
