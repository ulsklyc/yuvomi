/**
 * Modul: Feed-Abos (persoenlich)
 * Zweck: Die vier schreibgeschuetzten ICS-Feeds, mit denen eine Person
 *        Yuvomi-Daten in ihrem eigenen Kalenderprogramm abonniert - der
 *        Haushaltskalender, die Inventar-Fristen, der Zyklus und der eigene
 *        Schichtplan.
 *
 * Warum ein eigenes Blatt und warum unter `personal`: alle vier Tokens haengen
 * an der eigenen users-Zeile (calendar_feed_token, Migration 61;
 * inventory_deadlines_feed_token, Migration 144; cycle_feed_token,
 * Migration 180; schedule_feed_token, Migration 183), und alle vier Routen
 * tragen serverseitig bewusst keinen
 * Admin-Check. Die ersten beiden lagen trotzdem auf `sync-calendar`, das
 * adminOnly ist - in einem Haushalt mit fuenf Mitgliedern konnte also genau
 * eine Person ihr eigenes Abo einrichten oder zurueckziehen. Was in den Feed
 * HINEIN kommt (CalDAV-Konten, ICS-Abos, Kalenderimport), bleibt eine
 * Haushaltsfrage und damit auf dem gegateten Blatt; was aus ihm HERAUS geht,
 * ist persoenlich. Vierter Fall desselben Musters, siehe die Kommentare an
 * `personal-calendar`, `personal-tasks` und `modules-navigation` in
 * ../registry.js.
 *
 * Der Zyklus-Feed unterscheidet sich vom Inventar-Feed genau an der Stelle,
 * die server/services/cycle-ics.js dokumentiert: der FEED-INHALT ist
 * personengebunden (nicht nur das Token), keine Haushalts-Aggregation - das
 * haelt Zyklusdaten aus dem Betreuungs-Freigabe-System heraus (#584). Der
 * Schichtplan-Feed liegt genauso: gefeedet werden nur die eigenen aufgeloesten
 * Eintraege des Token-Besitzers, siehe server/services/schedule-ics.js.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { createInlineError, toggleRowHtml } from '/settings/components.js';

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.feedExportTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.feedExportDescription')}</p>
        <div id="feed-export-body"></div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.inventoryFeedTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.inventoryFeedDescription')}</p>
        <div id="inventory-feed-body"></div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.cycleFeedTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.cycleFeedDescription')}</p>
        <div id="cycle-feed-body"></div>
      </div>
    </section>
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.scheduleFeedTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.scheduleFeedDescription')}</p>
        <div id="schedule-feed-body"></div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.wasteFeedTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.wasteFeedDescription')}</p>
        <div id="waste-feed-body"></div>
      </div>
    </section>

  `);
}

// --------------------------------------------------------------------------
// Read-only ICS export feed
// --------------------------------------------------------------------------

function renderFeedExportInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.feedExportInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="feed-activate">${t('settings.feedExportActivate')}</button>
    </div>
  `);
}

function renderFeedExportActive(body, data) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="feed-url">${t('settings.feedExportUrlLabel')}</label>
      <input id="feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.feedExportHint')}</p>
    </div>
    <div class="form-group">
      ${toggleRowHtml({
        label: t('settings.feedExportShowAssignees'),
        checked: !!data.showAssignees,
        attrs: { id: 'feed-show-assignees', 'aria-describedby': 'feed-show-assignees-hint' },
      })}
      <p class="form-hint" id="feed-show-assignees-hint">${t('settings.feedExportShowAssigneesHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="feed-copy">${t('settings.feedExportCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.feedExportSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="feed-regen">${t('settings.feedExportRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="feed-disable">${t('settings.feedExportDisable')}</button>
    </div>
  `);
}

async function loadFeedExport(container) {
  const body = container.querySelector('#feed-export-body');
  if (!body) return;

  const reload = () => loadFeedExport(container);

  let res;
  try {
    res = await api.get('/calendar/feed');
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  if (!data) {
    renderFeedExportInactive(body);
    body.querySelector('#feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/calendar/feed/regenerate');
        showToast(t('settings.feedExportTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderFeedExportActive(body, data);

  body.querySelector('#feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.feedExportCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.feedExportRegenerateConfirm'),
      { danger: true, detail: t('settings.feedExportRegenerateConfirmDetail') })) return;
    try {
      await api.post('/calendar/feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.feedExportDisableConfirm'),
      { danger: true, detail: t('settings.feedExportDisableConfirmDetail') })) return;
    try {
      await api.delete('/calendar/feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#feed-show-assignees')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const next = input.checked;
    input.disabled = true;
    try {
      await api.put('/calendar/feed', { showAssignees: next });
      showToast(t('settings.feedExportSaved'), 'success');
    } catch (err) {
      input.checked = !next; // Fehlschlag → visuellen Zustand zurücksetzen
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      input.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Read-only ICS export feed - inventory warranty deadlines
// --------------------------------------------------------------------------

function renderInventoryFeedInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.inventoryFeedInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="inventory-feed-activate">${t('settings.inventoryFeedActivate')}</button>
    </div>
  `);
}

function renderInventoryFeedActive(body, data) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="inventory-feed-url">${t('settings.inventoryFeedUrlLabel')}</label>
      <input id="inventory-feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.inventoryFeedHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="inventory-feed-copy">${t('settings.inventoryFeedCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.inventoryFeedSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="inventory-feed-regen">${t('settings.inventoryFeedRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="inventory-feed-disable">${t('settings.inventoryFeedDisable')}</button>
    </div>
  `);
}

async function loadInventoryFeed(container) {
  const body = container.querySelector('#inventory-feed-body');
  if (!body) return;

  const reload = () => loadInventoryFeed(container);

  let res;
  try {
    res = await api.get('/inventory/deadlines-feed');
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  if (!data) {
    renderInventoryFeedInactive(body);
    body.querySelector('#inventory-feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/inventory/deadlines-feed/regenerate');
        showToast(t('settings.inventoryFeedTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderInventoryFeedActive(body, data);

  body.querySelector('#inventory-feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.inventoryFeedCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#inventory-feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.inventoryFeedRegenerateConfirm'),
      { danger: true, detail: t('settings.inventoryFeedRegenerateConfirmDetail') })) return;
    try {
      await api.post('/inventory/deadlines-feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#inventory-feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.inventoryFeedDisableConfirm'),
      { danger: true, detail: t('settings.inventoryFeedDisableConfirmDetail') })) return;
    try {
      await api.delete('/inventory/deadlines-feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
}

// --------------------------------------------------------------------------
// Read-only ICS export feed - predicted cycle (Phase 5)
// --------------------------------------------------------------------------

function renderCycleFeedInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.cycleFeedInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="cycle-feed-activate">${t('settings.cycleFeedActivate')}</button>
    </div>
  `);
}

function renderCycleFeedActive(body, data) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="cycle-feed-url">${t('settings.cycleFeedUrlLabel')}</label>
      <input id="cycle-feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.cycleFeedHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="cycle-feed-copy">${t('settings.cycleFeedCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.cycleFeedSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="cycle-feed-regen">${t('settings.cycleFeedRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="cycle-feed-disable">${t('settings.cycleFeedDisable')}</button>
    </div>
  `);
}

async function loadCycleFeed(container) {
  const body = container.querySelector('#cycle-feed-body');
  if (!body) return;

  const reload = () => loadCycleFeed(container);

  let res;
  try {
    res = await api.get('/health/cycle/feed');
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  if (!data) {
    renderCycleFeedInactive(body);
    body.querySelector('#cycle-feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/health/cycle/feed/regenerate');
        showToast(t('settings.cycleFeedTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderCycleFeedActive(body, data);

  body.querySelector('#cycle-feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.cycleFeedCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#cycle-feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.cycleFeedRegenerateConfirm'),
      { danger: true, detail: t('settings.cycleFeedRegenerateConfirmDetail') })) return;
    try {
      await api.post('/health/cycle/feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#cycle-feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.cycleFeedDisableConfirm'),
      { danger: true, detail: t('settings.cycleFeedDisableConfirmDetail') })) return;
    try {
      await api.delete('/health/cycle/feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
}

// --------------------------------------------------------------------------
// Read-only ICS export feed - own schedule
// --------------------------------------------------------------------------

function renderScheduleFeedInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.scheduleFeedInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="schedule-feed-activate">${t('settings.scheduleFeedActivate')}</button>
    </div>
  `);
}

function renderScheduleFeedActive(body, data) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="schedule-feed-url">${t('settings.scheduleFeedUrlLabel')}</label>
      <input id="schedule-feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.scheduleFeedHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="schedule-feed-copy">${t('settings.scheduleFeedCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.scheduleFeedSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="schedule-feed-regen">${t('settings.scheduleFeedRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="schedule-feed-disable">${t('settings.scheduleFeedDisable')}</button>
    </div>
  `);
}

async function loadScheduleFeed(container) {
  const body = container.querySelector('#schedule-feed-body');
  if (!body) return;

  const reload = () => loadScheduleFeed(container);

  let res;
  try {
    res = await api.get('/schedule/feed');
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  if (!data) {
    renderScheduleFeedInactive(body);
    body.querySelector('#schedule-feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/schedule/feed/regenerate');
        showToast(t('settings.scheduleFeedTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderScheduleFeedActive(body, data);

  body.querySelector('#schedule-feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.scheduleFeedCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#schedule-feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.scheduleFeedRegenerateConfirm'),
      { danger: true, detail: t('settings.scheduleFeedRegenerateConfirmDetail') })) return;
    try {
      await api.post('/schedule/feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#schedule-feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.scheduleFeedDisableConfirm'),
      { danger: true, detail: t('settings.scheduleFeedDisableConfirmDetail') })) return;
    try {
      await api.delete('/schedule/feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
}

// --------------------------------------------------------------------------
// Read-only ICS export feed - waste pickups, with an optional per-type
// selection (#1063 Phase 10). Content is household-wide like the inventory
// feed above (no owner/visibility column on waste data) - only the token and
// the type selection are personal, see server/services/waste-ics.js.
// --------------------------------------------------------------------------

function renderWasteFeedInactive(body) {
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <p class="settings-card-description">${t('settings.wasteFeedInactive')}</p>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="waste-feed-activate">${t('settings.wasteFeedActivate')}</button>
    </div>
  `);
}

function wasteFeedTypeRowsHtml(types, selectedIds) {
  return types.map((type) => toggleRowHtml({
    label: type.name,
    checked: selectedIds === null || selectedIds.includes(type.id),
    swatchColor: type.color,
    attrs: { 'data-waste-feed-type': String(type.id) },
  })).join('');
}

function renderWasteFeedActive(body, data, types) {
  const webcal = data.url.replace(/^https?:\/\//i, 'webcal://');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `
    <div class="form-group">
      <label class="form-label" for="waste-feed-url">${t('settings.wasteFeedUrlLabel')}</label>
      <input id="waste-feed-url" class="form-input" type="text" readonly value="${esc(data.url)}">
      <p class="form-hint">${t('settings.wasteFeedHint')}</p>
    </div>
    ${types.length ? `
      <div class="form-group">
        <span class="form-label">${t('settings.wasteFeedTypesLabel')}</span>
        <p class="form-hint">${t('settings.wasteFeedTypesHint')}</p>
        <div id="waste-feed-types">${wasteFeedTypeRowsHtml(types, data.type_ids)}</div>
      </div>
    ` : ''}
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="waste-feed-copy">${t('settings.wasteFeedCopy')}</button>
      <a class="btn btn--secondary" href="${esc(webcal)}">${t('settings.wasteFeedSubscribe')}</a>
      <button type="button" class="btn btn--secondary" id="waste-feed-regen">${t('settings.wasteFeedRegenerate')}</button>
      <button type="button" class="btn btn--danger-outline" id="waste-feed-disable">${t('settings.wasteFeedDisable')}</button>
    </div>
  `);
}

async function loadWasteFeed(container) {
  const body = container.querySelector('#waste-feed-body');
  if (!body) return;

  const reload = () => loadWasteFeed(container);

  let res;
  let typesRes;
  try {
    [res, typesRes] = await Promise.all([api.get('/waste/feed'), api.get('/waste/types')]);
  } catch (err) {
    body.replaceChildren();
    body.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  const data = res?.data;
  const types = typesRes?.data ?? [];
  if (!data) {
    renderWasteFeedInactive(body);
    body.querySelector('#waste-feed-activate')?.addEventListener('click', async () => {
      try {
        await api.post('/waste/feed/regenerate');
        showToast(t('settings.wasteFeedTitle'), 'success');
        await reload();
      } catch (err) {
        showToast(err.message || t('common.errorGeneric'), 'danger');
      }
    });
    return;
  }

  renderWasteFeedActive(body, data, types);

  body.querySelector('#waste-feed-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(t('settings.wasteFeedCopied'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#waste-feed-regen')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.wasteFeedRegenerateConfirm'),
      { danger: true, detail: t('settings.wasteFeedRegenerateConfirmDetail') })) return;
    try {
      await api.post('/waste/feed/regenerate');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  body.querySelector('#waste-feed-disable')?.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.wasteFeedDisableConfirm'),
      { danger: true, detail: t('settings.wasteFeedDisableConfirmDetail') })) return;
    try {
      await api.delete('/waste/feed');
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  // Leeres Ergebnis (alle abgewaehlt) oder alle angehakt heisst wieder "kein
  // Filter" - derselbe "leeres Set = alle"-Vertrag wie ueberall sonst in
  // dieser Codebase (state.people in calendar.js), server-seitig als null
  // statt eines leeren Arrays gespeichert (siehe waste-ics.js).
  body.querySelector('#waste-feed-types')?.addEventListener('change', async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.wasteFeedType) return;
    const checked = [...body.querySelectorAll('[data-waste-feed-type]')]
      .filter((el) => el.checked)
      .map((el) => Number(el.dataset.wasteFeedType));
    const typeIds = (checked.length === 0 || checked.length === types.length) ? null : checked;
    input.disabled = true;
    try {
      await api.put('/waste/feed/types', { type_ids: typeIds });
      showToast(t('settings.wasteFeedSaved'), 'success');
    } catch (err) {
      input.checked = !input.checked;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      input.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export async function render(container) {
  renderPage(container);
  await loadFeedExport(container);
  await loadInventoryFeed(container);
  await loadCycleFeed(container);
  await loadScheduleFeed(container);
  await loadWasteFeed(container);
  window.lucide?.createIcons({ el: container });
}
