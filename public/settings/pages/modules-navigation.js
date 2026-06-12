import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import {
  KITCHEN_CHILD_IDS,
  expandModuleOrder,
  normalizeModuleOrder,
} from '/settings/module-order.js';

// Eingebaute Module in kanonischer Domänen-Reihenfolge. Dashboard und Settings
// sind gesperrte Rows (nicht sortierbar, nicht deaktivierbar). Die Kitchen-
// Kinder werden zu einer expandierbaren Kitchen-Row zusammengefasst.
const BUILT_IN_MODULES = Object.freeze([
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', locked: true },
  { id: 'calendar', labelKey: 'nav.calendar', icon: 'calendar' },
  { id: 'tasks', labelKey: 'nav.tasks', icon: 'check-square' },
  { id: 'notes', labelKey: 'nav.notes', icon: 'sticky-note' },
  { id: 'contacts', labelKey: 'nav.contacts', icon: 'book-user' },
  { id: 'birthdays', labelKey: 'nav.birthdays', icon: 'cake' },
  { id: 'budget', labelKey: 'nav.budget', icon: 'wallet' },
  { id: 'documents', labelKey: 'nav.documents', icon: 'folder-lock' },
  { id: 'housekeeping', labelKey: 'nav.housekeeping', icon: 'paintbrush' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', locked: true },
]);

const KITCHEN_CHILD_LABEL_KEYS = Object.freeze({
  meals: 'nav.meals',
  recipes: 'nav.recipes',
  shopping: 'nav.shopping',
});
const KITCHEN_CHILD_ICONS = Object.freeze({
  meals: 'utensils',
  recipes: 'book-text',
  shopping: 'shopping-cart',
});

const DEFAULT_MODULE_ACCENT = 'var(--color-accent)';

function thirdPartyStatusLabel(module) {
  if (module.status === 'error') return t('settings.thirdPartyModulesStatusError');
  return module.enabled ? t('settings.thirdPartyModulesStatusEnabled') : t('settings.thirdPartyModulesStatusDisabled');
}

// Baut die geordnete Liste der Navigations-Rows: gesperrte, gewöhnliche, Kitchen
// (als ein expandierbarer Eintrag) und Drittanbieter-Module — sortiert nach der
// normalisierten Modul-Reihenfolge der Preferences.
function buildRows(preferences, thirdPartyModules) {
  const disabled = new Set(Array.isArray(preferences.disabled_modules) ? preferences.disabled_modules : []);
  const kitchenChildren = KITCHEN_CHILD_IDS.map((id) => ({
    id,
    label: t(KITCHEN_CHILD_LABEL_KEYS[id]),
    icon: KITCHEN_CHILD_ICONS[id],
    enabled: !disabled.has(id),
  }));

  const rows = [];
  let kitchenInserted = false;

  for (const module of BUILT_IN_MODULES) {
    if (KITCHEN_CHILD_IDS.includes(module.id)) continue;
    rows.push({
      type: 'built-in',
      id: module.id,
      orderId: module.id,
      label: t(module.labelKey),
      icon: module.icon,
      enabled: module.locked || !disabled.has(module.id),
      locked: module.locked === true,
      sortable: module.locked !== true,
    });
  }

  const kitchenEnabledChildren = kitchenChildren.filter((child) => child.enabled).length;
  const kitchenRow = {
    type: 'kitchen',
    id: 'kitchen',
    orderId: 'kitchen',
    label: t('nav.kitchen'),
    icon: 'utensils',
    children: kitchenChildren,
    enabledChildren: kitchenEnabledChildren,
    enabled: kitchenEnabledChildren > 0,
    locked: false,
    sortable: true,
  };

  const thirdPartyRows = thirdPartyModules.map((module) => {
    const menuHidden = module.menu?.show === false;
    return {
      type: 'third-party',
      id: module.id,
      orderId: `third-party-${module.id}`,
      label: module.menu?.label || module.name || module.id,
      icon: module.menu?.icon || module.icon || 'box',
      enabled: module.enabled && module.status === 'enabled',
      status: menuHidden ? t('settings.modulesMenuDisabled') : thirdPartyStatusLabel(module),
      error: module.error,
      toggleDisabled: module.status === 'error',
      hasError: module.status === 'error',
      menuHidden,
      sortable: !menuHidden,
      accent: module.accent,
      locked: false,
    };
  });

  // Kitchen an erster Definitionsposition einfügen (vor das erste Home-Modul),
  // damit es konsistent mit der globalen Navigation erscheint.
  const ordered = [];
  for (const row of rows) {
    if (!kitchenInserted && ['contacts', 'birthdays', 'budget', 'documents', 'housekeeping'].includes(row.id)) {
      ordered.push(kitchenRow);
      kitchenInserted = true;
    }
    ordered.push(row);
  }
  if (!kitchenInserted) ordered.push(kitchenRow);
  ordered.push(...thirdPartyRows);

  // Stabil nach normalisierter Modul-Reihenfolge sortieren. Locked-Rows bleiben
  // an ihrer Definitionsposition (sie tauchen nicht in module_order auf).
  const normalizedOrder = normalizeModuleOrder(preferences.module_order || []);
  const orderIndex = new Map(normalizedOrder.map((id, index) => [id, index]));
  return ordered
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ai = orderIndex.has(a.row.orderId) ? orderIndex.get(a.row.orderId) : Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.has(b.row.orderId) ? orderIndex.get(b.row.orderId) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

function rowControlsHtml(row) {
  return `
    <button type="button" class="settings-module-drag" aria-label="${esc(t('settings.modulesDragHandle'))}" title="${esc(t('settings.modulesDragHandle'))}"${row.sortable ? '' : ' disabled'}>
      <i data-lucide="grip-vertical" aria-hidden="true"></i>
    </button>
    <div class="settings-module-move-buttons">
      <button type="button" class="settings-module-move" data-module-move="up" aria-label="${esc(t('settings.modulesMoveUp'))}" title="${esc(t('settings.modulesMoveUp'))}"${row.sortable ? '' : ' disabled'}>
        <i data-lucide="chevron-up" aria-hidden="true"></i>
      </button>
      <button type="button" class="settings-module-move" data-module-move="down" aria-label="${esc(t('settings.modulesMoveDown'))}" title="${esc(t('settings.modulesMoveDown'))}"${row.sortable ? '' : ' disabled'}>
        <i data-lucide="chevron-down" aria-hidden="true"></i>
      </button>
    </div>
  `;
}

function builtInRowHtml(row) {
  const statusLabel = row.enabled ? t('settings.thirdPartyModulesStatusEnabled') : t('settings.thirdPartyModulesStatusDisabled');
  const statusClass = row.enabled ? 'settings-module-status--enabled' : 'settings-module-status--disabled';
  return `
    <div class="settings-module-row settings-module-row--sortable" data-module-row-id="${esc(row.orderId)}"${row.sortable ? ` draggable="true" data-module-order-id="${esc(row.orderId)}"` : ''}>
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon">
        <i data-lucide="${esc(row.icon)}" aria-hidden="true"></i>
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          ${row.locked ? `<span class="settings-module-origin">${esc(t('settings.modulesBuiltInBadge'))}</span>` : ''}
          <span class="settings-module-status ${statusClass}">${esc(statusLabel)}</span>
        </div>
      </div>
      <label class="toggle-row settings-module-row__toggle">
        <input type="checkbox" data-built-in-module-toggle="${esc(row.id)}"${row.enabled ? ' checked' : ''}${row.locked ? ' disabled' : ''}>
        <span>${t('settings.thirdPartyModulesEnableLabel')}</span>
      </label>
    </div>
  `;
}

function kitchenRowHtml(row) {
  const statusLabel = row.enabled ? t('settings.thirdPartyModulesStatusEnabled') : t('settings.thirdPartyModulesStatusDisabled');
  return `
    <div class="settings-module-row settings-module-row--sortable settings-module-row--kitchen" data-module-row-id="${esc(row.orderId)}" draggable="true" data-module-order-id="${esc(row.orderId)}">
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon">
        <i data-lucide="${esc(row.icon)}" aria-hidden="true"></i>
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          <span class="settings-module-status ${row.enabled ? 'settings-module-status--enabled' : 'settings-module-status--disabled'}">${esc(statusLabel)}</span>
        </div>
        <button type="button" class="settings-disclosure__trigger settings-module-kitchen__trigger" aria-expanded="false" data-kitchen-expand>
          <i data-lucide="chevron-down" class="settings-disclosure__icon" aria-hidden="true"></i>
          <span>${t('settings.kitchenActiveCount', { count: row.enabledChildren })}</span>
        </button>
        <div class="settings-disclosure__panel settings-module-kitchen__children" data-kitchen-children hidden>
          ${row.children.map((child) => `
            <label class="toggle-row settings-module-kitchen__child">
              <input type="checkbox" data-kitchen-child-toggle="${esc(child.id)}"${child.enabled ? ' checked' : ''}>
              <i data-lucide="${esc(child.icon)}" aria-hidden="true"></i>
              <span>${esc(child.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function thirdPartyRowHtml(row) {
  const statusClass = row.hasError
    ? 'settings-module-status--error'
    : row.enabled ? 'settings-module-status--enabled' : 'settings-module-status--disabled';
  return `
    <div class="settings-module-row settings-module-row--sortable" data-module-row-id="${esc(row.orderId)}"${row.sortable ? ` draggable="true" data-module-order-id="${esc(row.orderId)}"` : ''}>
      ${rowControlsHtml(row)}
      <div class="settings-module-row__icon" style="--module-row-accent:${esc(row.accent) || DEFAULT_MODULE_ACCENT}">
        <i data-lucide="${esc(row.icon)}" aria-hidden="true"></i>
      </div>
      <div class="settings-module-row__body">
        <div class="settings-module-row__title">
          <strong>${esc(row.label)}</strong>
          <span class="settings-module-origin">${esc(t('settings.modulesExternalBadge'))}</span>
          <span class="settings-module-status ${statusClass}">${esc(row.status)}</span>
        </div>
        ${row.error ? `<p class="form-error">${esc(row.error)}</p>` : ''}
      </div>
      <label class="toggle-row settings-module-row__toggle">
        <input type="checkbox" data-third-party-module-toggle="${esc(row.id)}"${row.enabled ? ' checked' : ''}${row.toggleDisabled ? ' disabled' : ''}>
        <span>${t('settings.thirdPartyModulesEnableLabel')}</span>
      </label>
    </div>
  `;
}

function rowHtml(row) {
  if (row.type === 'kitchen') return kitchenRowHtml(row);
  if (row.type === 'third-party') return thirdPartyRowHtml(row);
  return builtInRowHtml(row);
}

function renderPage(container, rows) {
  container.replaceChildren();
  const list = rows.length
    ? `<div class="settings-modules-list settings-modules-list--sortable" id="module-toggles">${rows.map(rowHtml).join('')}</div>`
    : `
      <div class="empty-state empty-state--compact">
        <div class="empty-state__title">${t('settings.thirdPartyModulesEmptyTitle')}</div>
        <div class="empty-state__description">${t('settings.thirdPartyModulesEmptyHint')}</div>
      </div>
    `;

  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.modulesTitle')}</h3>
        <p class="form-hint">${t('settings.modulesHint')}</p>
        <p class="form-hint">${t('settings.modulesDragHint')}</p>
        ${list}
      </div>
    </section>
  `);
  window.lucide?.createIcons({ el: container });
}

// Reihenfolge der sichtbaren, sortierbaren Order-IDs (inkl. dem einen Kitchen-
// Eintrag). Wird vor dem Speichern via expandModuleOrder zurück auf die
// kanonischen Kitchen-Kinder erweitert.
function collectVisibleGlobalOrder(list) {
  return [...list.querySelectorAll('[data-module-order-id]')]
    .map((rowEl) => rowEl.dataset.moduleOrderId)
    .filter(Boolean);
}

function collectOrdinaryDisabledIds(list) {
  return [...list.querySelectorAll('[data-built-in-module-toggle]')]
    .filter((input) => !input.checked)
    .map((input) => input.dataset.builtInModuleToggle);
}

function collectEnabledKitchenChildren(list) {
  return new Set(
    [...list.querySelectorAll('[data-kitchen-child-toggle]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset.kitchenChildToggle),
  );
}

// Reine, testbare Berechnung der Save-Payload: gewöhnliche disabled IDs plus die
// nicht aktivierten Kitchen-Kinder ergeben `disabled_modules`; die sichtbare
// Order (inkl. dem einen Kitchen-Eintrag) wird via expandModuleOrder zurück auf
// die kanonischen Kitchen-Kinder erweitert.
export function buildNavigationPayload(ordinaryDisabledIds, enabledKitchenChildren, visibleGlobalOrder) {
  return {
    disabled_modules: [
      ...ordinaryDisabledIds,
      ...KITCHEN_CHILD_IDS.filter((id) => !enabledKitchenChildren.has(id)),
    ],
    module_order: expandModuleOrder(visibleGlobalOrder),
  };
}

// Reine, testbare Toggle-Persistenz: deaktiviert den Input während des Saves,
// stellt bei Fehlschlag den vorherigen Zustand wieder her und re-rendert nur bei
// erfolgreichem Save (ein fehlschlagender Re-Render darf NICHT den Restore-Pfad
// auslösen).
export async function persistModuleToggle(input, enabled, save, rerender) {
  input.disabled = true;
  try {
    await save();
  } catch (error) {
    input.checked = !enabled;
    input.disabled = false;
    throw error;
  }
  await rerender();
}

async function saveNavigationState(list) {
  const payload = buildNavigationPayload(
    collectOrdinaryDisabledIds(list),
    collectEnabledKitchenChildren(list),
    collectVisibleGlobalOrder(list),
  );
  const response = await api.put('/preferences', payload);
  const savedDisabled = response?.data?.disabled_modules ?? payload.disabled_modules;
  const savedOrder = response?.data?.module_order ?? payload.module_order;
  window.oikos?.setDisabledModules?.(savedDisabled);
  window.oikos?.setModuleOrder?.(savedOrder);
}

function bindKitchenDisclosure(container) {
  const trigger = container.querySelector('[data-kitchen-expand]');
  const panel = container.querySelector('[data-kitchen-children]');
  if (!trigger || !panel) return;
  trigger.addEventListener('click', () => {
    const expanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });
}

function bindModuleListEvents(container, user) {
  const list = container.querySelector('#module-toggles');
  if (!list) return;
  let dragged = null;
  let dragStartOrder = '';
  let savingOrder = false;

  const saveIfChanged = async (previousOrder) => {
    const currentOrder = collectVisibleGlobalOrder(list).join('|');
    if (currentOrder === previousOrder || savingOrder) return;
    savingOrder = true;
    try {
      await saveNavigationState(list);
      window.oikos?.showToast(t('settings.modulesSaved'), 'success');
    } catch (error) {
      window.oikos?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
      await render(container, { user });
    } finally {
      savingOrder = false;
    }
  };

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-module-order-id]');
    if (!row) return;
    dragged = row;
    dragStartOrder = collectVisibleGlobalOrder(list).join('|');
    row.classList.add('settings-module-row--dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.moduleOrderId);
  });

  list.addEventListener('dragend', async () => {
    const previousOrder = dragStartOrder;
    dragged?.classList.remove('settings-module-row--dragging');
    dragged = null;
    dragStartOrder = '';
    await saveIfChanged(previousOrder);
  });

  list.addEventListener('dragover', (event) => {
    if (!dragged) return;
    event.preventDefault();
    const row = event.target.closest('[data-module-order-id]');
    if (!row || row === dragged) return;
    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    list.insertBefore(dragged, before ? row : row.nextSibling);
  });

  list.addEventListener('drop', (event) => {
    if (!dragged) return;
    event.preventDefault();
  });

  list.addEventListener('click', async (event) => {
    if (event.target.closest('[data-kitchen-expand]')) return;
    const btn = event.target.closest('[data-module-move]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('[data-module-order-id]');
    if (!row) return;
    const previousOrder = collectVisibleGlobalOrder(list).join('|');
    if (btn.dataset.moduleMove === 'up') {
      const prev = row.previousElementSibling;
      if (prev?.matches('[data-module-order-id]')) list.insertBefore(row, prev);
    } else {
      const next = row.nextElementSibling;
      if (next?.matches('[data-module-order-id]')) list.insertBefore(next, row);
    }
    await saveIfChanged(previousOrder);
  });

  list.addEventListener('change', async (event) => {
    const input = event.target.closest(
      '[data-built-in-module-toggle], [data-third-party-module-toggle], [data-kitchen-child-toggle]',
    );
    if (!input) return;
    const enabled = input.checked;
    try {
      await persistModuleToggle(
        input,
        enabled,
        async () => {
          if (input.dataset.thirdPartyModuleToggle) {
            await api.patch(`/modules/${encodeURIComponent(input.dataset.thirdPartyModuleToggle)}`, { enabled });
            await window.oikos?.refreshThirdPartyModules?.();
          }
          await saveNavigationState(list);
          window.oikos?.showToast(t('settings.thirdPartyModulesSaved'), 'success');
        },
        () => render(container, { user }),
      );
    } catch (error) {
      window.oikos?.showToast(error.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  const isAdmin = user?.role === 'admin';
  const [preferencesResult, modulesResult] = await Promise.allSettled([
    api.get('/preferences'),
    isAdmin ? api.get('/modules?admin=1') : Promise.resolve({ data: [] }),
  ]);

  const preferences = preferencesResult.status === 'fulfilled' ? (preferencesResult.value?.data ?? {}) : {};
  const thirdPartyModules = modulesResult.status === 'fulfilled' ? (modulesResult.value?.data ?? []) : [];

  const rows = buildRows(preferences, thirdPartyModules);
  renderPage(container, rows);
  bindKitchenDisclosure(container);
  bindModuleListEvents(container, user);
}
