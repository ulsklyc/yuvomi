/**
 * LAB — Catálogo de compras
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { categoryLabel as officialCategoryLabel } from '/utils/shopping-categories.js';
import { mayWritePath } from '/utils/module-access.js';
import { formatMoney, currencyFractionDigits } from '/utils/money.js';
import { openModal, closeModal, reportFieldError } from '/components/modal.js';

let currentCurrency = 'EUR';
const canEdit = () => mayWritePath('/shopping');

const dateFormatter = new Intl.DateTimeFormat((typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'), {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

let state = {
  products: [],
  categories: [],
  query: '',
};

function money(cents) {
  if (cents === null || cents === undefined) return '-';
  return formatMoney(Number(cents) / 10 ** currencyFractionDigits(currentCurrency), currentCurrency);
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return dateFormatter.format(date);
}

function categoryLabel(name) {
  if (!name) return t('shoppingCustom.uncategorized');
  return officialCategoryLabel(name);
}

async function loadData() {
  const [catalogRes, categoriesRes] = await Promise.all([
    api.get('/shopping/catalog'),
    api.get('/shopping/categories'),
  ]);

  try { currentCurrency = (await api.get('/preferences')).data?.currency ?? 'EUR'; }
  catch { currentCurrency = 'EUR'; }
  state.products = catalogRes.data ?? [];
  state.categories = categoriesRes.data ?? [];
}

function productCard(product) {
  const count = Number(product.price_history_count) || 0;

  return `
    <article class="catalog-card" data-product-id="${product.id}">
      <div>
        <h3 class="catalog-card__name">${esc(product.name)}</h3>
        <div class="catalog-card__category">
          ${esc(categoryLabel(product.category))}
        </div>
      </div>

      <div class="catalog-card__prices">
        <div class="catalog-price">
          <span>${esc(t('shoppingCustom.lastPrice'))}</span>
          <strong>${money(product.last_price_cents)}</strong>
        </div>

        <div class="catalog-price">
          <span>${esc(t('shoppingCustom.lowestPrice'))}</span>
          <strong>${money(product.lowest_price_cents)}</strong>
        </div>
      </div>

      <div class="catalog-history-count">
        ${count === 0
          ? t('shoppingCustom.noPrices')
          : t('shoppingCustom.priceCount', { count })}
      </div>

      <div class="catalog-card__actions">
        ${rowActionHtml({ icon: 'history', action: 'history', label: t('shoppingCustom.viewHistory', { name: product.name }), attrs: { 'data-id': product.id } })}
        ${canEdit() ? `
          ${rowActionHtml({ icon: 'pencil', action: 'edit', label: t('shoppingCustom.editNamed', { name: product.name }), attrs: { 'data-id': product.id } })}
          ${rowActionHtml({ icon: 'trash-2', action: 'delete', tone: 'danger', label: t('shoppingCustom.deleteNamed', { name: product.name }), attrs: { 'data-id': product.id } })}
        ` : ''}
      </div>
    </article>
  `;
}

function filteredProducts() {
  const q = state.query.trim().toLocaleLowerCase((typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'));

  if (!q) return state.products;

  return state.products.filter((product) =>
    String(product.name ?? '')
      .toLocaleLowerCase((typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'))
      .includes(q)
  );
}

function renderProducts(container) {
  const results = container.querySelector('#catalog-results');
  if (!results) return;

  const products = filteredProducts();

  if (!products.length) {
    results.replaceChildren();
    results.insertAdjacentHTML('beforeend', `
      <div class="catalog-empty">
        ${state.query
          ? esc(t('shoppingCustom.nothingFound', { query: state.query }))
          : esc(t('shoppingCustom.empty'))}
      </div>
    `);
    return;
  }

  results.replaceChildren();
  results.insertAdjacentHTML('beforeend', products.map(productCard).join(''));

  if (window.lucide) {
    window.lucide.createIcons({ el: results });
  }
}

function categoryOptions(selected = '') {
  const options = state.categories.map((category) => {
    const name = category.name;
    return `
      <option value="${esc(name)}" ${name === selected ? 'selected' : ''}>
        ${esc(categoryLabel(name))}
      </option>
    `;
  }).join('');

  return `
    <option value="" ${!selected ? 'selected' : ''}>${esc(t('shoppingCustom.uncategorized'))}</option>
    ${options}
  `;
}

function openProductForm(container, product = null) {
  if (!canEdit()) return;
  const editing = Boolean(product);

  openModal({
    title: editing ? t('shoppingCustom.editProduct') : t('shoppingCustom.newProduct'),
    size: 'sm',
    content: `
      <form id="catalog-product-form" novalidate autocomplete="off">
        <div class="form-group">
          <label class="form-label" for="catalog-product-name">${esc(t('shoppingCustom.name'))}</label>
          <input class="form-input"
                 id="catalog-product-name"
                 type="text"
                 required
                 value="${esc(product?.name ?? '')}">
        </div>

        <div class="form-group">
          <label class="form-label" for="catalog-product-category">${esc(t('shoppingCustom.category'))}</label>
          <select class="form-input" id="catalog-product-category">
            ${categoryOptions(product?.category ?? '')}
          </select>
        </div>

        <div class="modal-panel__footer">
          <button type="button"
                  class="btn btn--secondary"
                  id="catalog-product-cancel">
            ${esc(t('shoppingCustom.cancel'))}
          </button>

          <button type="submit"
                  class="btn btn--primary">
            ${esc(t(editing ? 'common.save' : 'common.add'))}
          </button>
        </div>
      </form>
    `,
    onSave: (panel) => {
      const form = panel.querySelector('#catalog-product-form');
      const nameEl = panel.querySelector('#catalog-product-name');
      const categoryEl = panel.querySelector('#catalog-product-category');

      panel.querySelector('#catalog-product-cancel')
        ?.addEventListener('click', () => closeModal());

      form?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const name = nameEl.value.trim();

        if (!name) {
          reportFieldError(nameEl, t('shoppingCustom.nameRequired'));
          return;
        }

        const payload = {
          name,
          category: categoryEl.value || null,
        };

        try {
          let response;

          if (editing) {
            response = await api.patch(
              `/shopping/catalog/${product.id}`,
              payload
            );

            const index = state.products.findIndex(
              (p) => p.id === product.id
            );

            if (index !== -1) {
              state.products[index] = {
                ...state.products[index],
                ...response.data,
              };
            }
          } else {
            response = await api.post('/shopping/catalog', payload);
            state.products.push(response.data);
          }

          state.products.sort((a, b) =>
            a.name.localeCompare(b.name, (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en'), {
              sensitivity: 'base',
            })
          );

          closeModal({ force: true });
          renderProducts(container);
        } catch (err) {
          window.yuvomi?.showToast?.(
            err.data?.error ?? t('shoppingCustom.saveFailed'),
            'danger'
          );
        }
      });
    },
  });
}

async function openHistory(product) {
  try {
    const response = await api.get(
      `/shopping/catalog/${product.id}/history`
    );

    const data = response.data;
    const history = data.history ?? [];
    const info = data.product ?? product;

    openModal({
      title: product.name,
      size: 'md',
      content: `
        <div class="catalog-history">
          <div class="catalog-history__summary">
            <div class="catalog-history__metric">
              <span>${esc(t('shoppingCustom.lastPrice'))}</span>
              <strong>${money(info.last_price_cents)}</strong>
            </div>

            <div class="catalog-history__metric">
              <span>${esc(t('shoppingCustom.lowestPrice'))}</span>
              <strong>${money(info.lowest_price_cents)}</strong>
            </div>
          </div>

          ${history.length
            ? `
              <div class="catalog-history__list">
                ${history.map((entry) => `
                  <div class="catalog-history__row">
                    <span>${formatDate(entry.purchased_at)}</span>
                    <strong>${money(entry.unit_price_cents)}</strong>
                  </div>
                `).join('')}
              </div>
            `
            : `
              <div class="catalog-empty">
                ${esc(t('shoppingCustom.noHistory'))}
              </div>
            `}
        </div>

        <div class="modal-panel__footer">
          <button type="button"
                  class="btn btn--primary"
                  id="catalog-history-close">
            ${esc(t('shoppingCustom.close'))}
          </button>
        </div>
      `,
      onSave: (panel) => {
        panel.querySelector('#catalog-history-close')
          ?.addEventListener('click', () => closeModal());
      },
    });
  } catch (err) {
    window.yuvomi?.showToast?.(
      err.data?.error ?? t('shoppingCustom.historyFailed'),
      'danger'
    );
  }
}

function confirmDelete(container, product) {
  if (!canEdit()) return;
  openModal({
    title: t('shoppingCustom.deleteProduct'),
    size: 'sm',
    content: `
      <p class="catalog-confirm-text">
        ${esc(t('shoppingCustom.confirmDelete', { name: product.name }))}
      </p>

      <p class="catalog-confirm-text">
        ${esc(t('shoppingCustom.deleteWarning'))}
      </p>

      <div class="modal-panel__footer">
        <button type="button"
                class="btn btn--secondary"
                id="catalog-delete-cancel">
          ${esc(t('shoppingCustom.cancel'))}
        </button>

        <button type="button"
                class="btn btn--danger"
                id="catalog-delete-confirm">
          ${esc(t('shoppingCustom.delete'))}
        </button>
      </div>
    `,
    onSave: (panel) => {
      panel.querySelector('#catalog-delete-cancel')
        ?.addEventListener('click', () => closeModal());

      panel.querySelector('#catalog-delete-confirm')
        ?.addEventListener('click', async () => {
          try {
            await api.delete(`/shopping/catalog/${product.id}`);

            state.products = state.products.filter(
              (p) => p.id !== product.id
            );

            closeModal({ force: true });
            renderProducts(container);

            window.yuvomi?.showToast?.(
              t('shoppingCustom.deleted', { name: product.name }),
              'success'
            );
          } catch (err) {
            window.yuvomi?.showToast?.(
              err.data?.error ?? t('shoppingCustom.deleteFailed'),
              'danger'
            );
          }
        });
    },
  });
}

function wireActions(container) {
  wirePageSearch(container, { id: 'catalog-search', delay: 0, onQuery(query) {
    state.query = query;
    renderProducts(container);
  }});

  container.querySelector('#catalog-new')
    ?.addEventListener('click', () => {
      if (!canEdit()) return;
      openProductForm(container);
    });

  container.querySelector('#catalog-results')
    ?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;

      const id = Number(button.dataset.id);
      const product = state.products.find((p) => p.id === id);
      if (!product) return;

      if (button.dataset.action === 'history') {
        openHistory(product);
      }

      if (!canEdit() && button.dataset.action !== 'history') return;
      if (button.dataset.action === 'edit') {
        openProductForm(container, product);
      }

      if (button.dataset.action === 'delete') {
        confirmDelete(container, product);
      }
    });
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="catalog-page app-page app-page--reading" data-composition="reading">
      <div class="catalog-toolbar">
        <button type="button" class="btn btn--secondary" id="catalog-back">${esc(t('shoppingCustom.backShopping'))}</button>
        ${renderPageSearch({ id: 'catalog-search', label: t('shoppingCustom.searchProduct'), placeholder: t('shoppingCustom.searchProduct'), clearLabel: t('shoppingCustom.cancel'), className: 'catalog-search' })}

        <button type="button"
                class="catalog-new-btn"
                id="catalog-new" ${canEdit() ? '' : 'hidden'}>
          <i data-lucide="plus" class="icon-md"></i>
          <span>${esc(t('shoppingCustom.newProduct'))}</span>
        </button>
      </div>

      <div class="catalog-results"
           id="catalog-results">
      </div>
    </section>
  `);

  renderKitchenTabsBar(container, '/catalog');
  container.querySelector('#catalog-back')?.addEventListener('click', () => window.yuvomi.navigate('/shopping'));

  try {
    await loadData();
    renderProducts(container);
    wireActions(container);

    if (window.lucide) {
      window.lucide.createIcons({ el: container });
    }
  } catch (err) {
    const results = container.querySelector('#catalog-results');

    if (results) {
      results.replaceChildren();
    results.insertAdjacentHTML('beforeend', `
        <div class="catalog-empty">
          ${esc(t('shoppingCustom.loadFailed'))}
        </div>
      `);
    }

    console.error('Catalog load error:', err);
  }
}
