/**
 * Modul: Kalender-Abos (persoenlich)
 * Zweck: ICS-/Webcal-Abonnements und der einmalige Kalenderimport - also alles,
 *        was Termine in den Kalender HEREIN bringt, ohne dass ein Konto mit
 *        Zugangsdaten daran haengt.
 *
 * Warum unter `personal`: der Server ist hier eigentuemerbasiert gebaut und war
 * es immer. `GET /api/v1/calendar/subscriptions` liefert `shared = 1 OR
 * created_by = ich`, und PATCH/DELETE/sync antworten 403, wenn das Abo einem
 * anderen gehoert - `isAdmin` ist dort ein ZUSATZrecht, keine Voraussetzung.
 * Jedes Mitglied darf sein eigenes Abo also anlegen, aendern, abgleichen und
 * loeschen; erreichbar war das nur nie, weil das Blatt `sync-calendar`
 * adminOnly ist. Der Kalenderimport ebenso: er traegt kein Admin-Gate und
 * vermerkt nur, wer importiert hat.
 *
 * Was NICHT hierher gehoert und auf `sync-calendar` bleibt: CalDAV-Konten und
 * die Google-/Apple-Anbindung. Die haengen an Zugangsdaten des Haushalts und
 * ihre Routen tragen `requireAdmin`.
 *
 * Schwesterblatt ist `personal-feeds` (was HERAUS geht). Rein und raus stehen
 * bewusst getrennt: es sind zwei Richtungen, nicht zwei Haelften einer Sache.
 */

import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { closeModal, confirmModal, openModal, refocusAfterRender } from '/components/modal.js';
import { toggleRowHtml } from '/settings/components.js';
import { loadFamilyUsers } from '/settings/family-users.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

// --------------------------------------------------------------------------
// Page scaffold
// --------------------------------------------------------------------------

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.ics.title')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.ics.holidayHint')}</p>
        <div id="ics-accounts" class="settings-sync-accounts"></div>
        <div id="ics-add-form-wrapper" hidden>
          <form id="ics-add-form" class="settings-form settings-form--compact" novalidate autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="ics-url">${t('settings.ics.form.url')}</label>
              <input class="form-input" type="url" id="ics-url" required placeholder="https://..." />
            </div>
            <div class="form-group">
              <label class="form-label" for="ics-name">${t('settings.ics.form.name')}</label>
              <input class="form-input" type="text" id="ics-name" required maxlength="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ics-color">${t('settings.ics.form.color')}</label>
              <input class="form-input form-input--color" type="color" id="ics-color" value="#6366f1" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ics-assignee">${t('settings.sync.defaultAssignee')}</label>
              <select class="form-input" id="ics-assignee">
                <option value="">${t('settings.sync.defaultAssigneeNone')}</option>
                <option value="" disabled data-loading>${t('common.loading')}</option>
              </select>
              <p class="form-hint">${t('settings.sync.defaultAssigneeHint')}</p>
            </div>
            <div class="form-group">
              ${toggleRowHtml({
                label: t('settings.ics.form.shared'),
                attrs: { id: 'ics-shared' },
              })}
            </div>
            <div id="ics-add-error" class="form-error" role="alert" hidden></div>
            <div class="settings-form-actions">
              <button type="submit" class="btn btn--primary" id="ics-submit-btn">${t('settings.ics.actions.submit')}</button>
              <button type="button" class="btn btn--secondary" id="ics-cancel-btn">${t('settings.ics.actions.cancel')}</button>
            </div>
          </form>
        </div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="ics-add-btn">${t('settings.ics.add')}</button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.calendarImport.title')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.calendarImport.description')}</p>
        <form id="cal-import-form" class="settings-form settings-form--compact" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="cal-import-file">${t('settings.calendarImport.fileLabel')}</label>
            <input class="form-input" type="file" id="cal-import-file" accept=".ics,text/calendar" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cal-import-url">${t('settings.calendarImport.urlLabel')}</label>
            <input class="form-input" type="url" id="cal-import-url" placeholder="https://..." />
            <small class="form-hint">${t('settings.calendarImport.urlHint')}</small>
          </div>
          <div class="form-group">
            <label class="form-label" for="cal-import-color">${t('settings.calendarImport.colorLabel')}</label>
            <input class="form-input form-input--color" type="color" id="cal-import-color" value="#007AFF" />
          </div>
          <div id="cal-import-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary" id="cal-import-submit">${t('settings.calendarImport.submit')}</button>
          </div>
        </form>
      </div>
    </section>
  `);
}

// --------------------------------------------------------------------------
// ICS / Webcal subscriptions
// --------------------------------------------------------------------------

function renderIcsList(container, subs, user) {
  const listEl = container.querySelector('#ics-accounts');
  if (!listEl) return;
  listEl.replaceChildren();

  if (subs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'form-hint';
    empty.textContent = t('settings.ics.empty');
    listEl.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'settings-members';
  for (const sub of subs) {
    const li = document.createElement('li');
    // Dieselbe Zeilen-Grammatik wie die Kalenderauswahl darueber (#732): gleiche
    // Aufgabe, gleiche Zeile. Die Regel steht in settings.css, hier wird sie nur
    // angefordert.
    li.className = 'settings-member settings-member--sync-row';

    const dot = document.createElement('span');
    dot.className = 'settings-avatar settings-avatar--sm';
    dot.style.background = sub.color;
    dot.style.flexShrink = '0';
    li.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'settings-member__info';

    const nameLine = document.createElement('span');
    nameLine.className = 'settings-member__name';
    nameLine.textContent = sub.name;

    const badge = document.createElement('span');
    badge.className = `badge ${sub.shared ? 'badge--success' : 'badge--neutral'}`;
    badge.style.marginLeft = 'var(--space-2)';
    badge.textContent = sub.shared ? t('settings.ics.badges.shared') : t('settings.ics.badges.private');
    nameLine.appendChild(badge);
    info.appendChild(nameLine);

    const meta = document.createElement('span');
    meta.className = 'settings-member__meta';
    const formatted = formatSyncTime(sub.last_sync);
    meta.textContent = formatted
      ? `${t('settings.ics.status.lastSync')} ${formatted}`
      : t('settings.ics.status.never');
    info.appendChild(meta);
    li.appendChild(info);

    const isOwner = sub.created_by === user?.id || user?.role === 'admin';
    if (isOwner) {
      li.appendChild(buildIcsActions(container, sub, subs, user));
    }
    ul.appendChild(li);
  }
  listEl.appendChild(ul);
  window.lucide?.createIcons({ el: listEl });
}

function buildIcsActions(container, sub, subs, user) {
  const actions = document.createElement('div');
  actions.className = 'cat-row__actions';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--icon btn--ghost';
  syncBtn.title = t('settings.ics.actions.sync');
  syncBtn.setAttribute('aria-label', t('settings.ics.actions.sync'));
  const syncIcon = document.createElement('i');
  syncIcon.setAttribute('data-lucide', 'refresh-cw');
  syncIcon.className = 'icon-md';
  syncIcon.setAttribute('aria-hidden', 'true');
  syncBtn.appendChild(syncIcon);
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const res = await api.post(`/calendar/subscriptions/${sub.id}/sync`, {});
      const idx = subs.findIndex((s) => s.id === sub.id);
      if (idx >= 0) subs[idx] = res.data;
      renderIcsList(container, subs, user);
      showToast(t('settings.ics.syncedToast'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
      syncBtn.disabled = false;
    }
  });
  actions.appendChild(syncBtn);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn--icon btn--ghost';
  editBtn.title = t('settings.ics.actions.edit');
  editBtn.setAttribute('aria-label', t('settings.ics.actions.edit'));
  const editIcon = document.createElement('i');
  editIcon.setAttribute('data-lucide', 'pencil');
  editIcon.className = 'icon-sm';
  editIcon.setAttribute('aria-hidden', 'true');
  editBtn.appendChild(editIcon);
  editBtn.addEventListener('click', () => openIcsEditModal(container, sub, subs, user));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--icon btn--danger-outline';
  delBtn.title = t('settings.ics.actions.delete');
  delBtn.setAttribute('aria-label', t('settings.ics.actions.delete'));
  const delIcon = document.createElement('i');
  delIcon.setAttribute('data-lucide', 'trash-2');
  delIcon.className = 'icon-sm';
  delIcon.setAttribute('aria-hidden', 'true');
  delBtn.appendChild(delIcon);
  delBtn.addEventListener('click', async () => {
    if (!await confirmModal(t('settings.ics.confirm_delete'), {
      danger: true,
      confirmLabel: t('common.delete'),
      detail: t('settings.ics.confirm_delete_detail'),
    })) return;
    try {
      await api.delete(`/calendar/subscriptions/${sub.id}`);
      const idx = subs.findIndex((s) => s.id === sub.id);
      if (idx >= 0) subs.splice(idx, 1);
      renderIcsList(container, subs, user);
      refocusAfterRender();
      showToast(t('settings.ics.deletedToast'), 'default');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  actions.appendChild(delBtn);

  return actions;
}

function openIcsEditModal(container, sub, subs, user) {
  openModal({
    title: t('settings.ics.actions.edit'),
    size: 'sm',
    content: `
      <form id="ics-edit-form" class="settings-form">
        <div class="form-group">
          <label class="form-label" for="ics-edit-name">${t('settings.ics.form.name')}</label>
          <input class="form-input" type="text" id="ics-edit-name" value="${esc(sub.name)}" required maxlength="100" />
        </div>
        <div class="settings-name-color-row">
          <div class="form-group settings-color-field">
            <label class="form-label" for="ics-edit-color">${t('settings.ics.form.color')}</label>
            <input class="settings-color-button" type="color" id="ics-edit-color" value="${esc(sub.color) || '#3b82f6'}" />
          </div>
          <div class="form-group settings-color-field">
            ${toggleRowHtml({
              label: t('settings.ics.form.shared'),
              checked: !!sub.shared,
              attrs: { id: 'ics-edit-shared' },
            })}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="ics-edit-assignee">${t('settings.sync.defaultAssignee')}</label>
          <select class="form-input" id="ics-edit-assignee">
            <option value="">${t('settings.sync.defaultAssigneeNone')}</option>
            <option value="" disabled data-loading>${t('common.loading')}</option>
          </select>
          <p class="form-hint">${t('settings.sync.defaultAssigneeHint')}</p>
        </div>
        <div id="ics-edit-error" class="form-error" role="alert" hidden></div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="ics-edit-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('settings.ics.actions.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      // Assignee-Optionen async nachladen — Modal öffnet sofort (kein Fetch-Block).
      const assigneeSel = panel.querySelector('#ics-edit-assignee');
      if (assigneeSel) {
        loadFamilyUsers().then((users) => {
          assigneeSel.querySelector('option[data-loading]')?.remove();
          for (const u of users) {
            const opt = document.createElement('option');
            opt.value = String(u.id);
            opt.textContent = u.display_name;
            if (Number(sub.default_assignee_user_id) === u.id) opt.selected = true;
            assigneeSel.appendChild(opt);
          }
        });
      }
      panel.querySelector('#ics-edit-cancel')?.addEventListener('click', () => closeModal());
      panel.querySelector('#ics-edit-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type=submit]');
        const errEl = panel.querySelector('#ics-edit-error');
        const name = panel.querySelector('#ics-edit-name').value.trim();
        const color = panel.querySelector('#ics-edit-color').value;
        const shared = panel.querySelector('#ics-edit-shared').checked ? 1 : 0;
        const assigneeVal = panel.querySelector('#ics-edit-assignee').value;
        const default_assignee_user_id = assigneeVal ? Number(assigneeVal) : null;
        errEl.hidden = true;
        submitBtn.disabled = true;
        try {
          const res = await api.patch(`/calendar/subscriptions/${sub.id}`, { name, color, shared, default_assignee_user_id });
          const idx = subs.findIndex((s) => s.id === sub.id);
          if (idx >= 0) subs[idx] = res.data;
          renderIcsList(container, subs, user);
          showToast(t('settings.ics.updatedToast'), 'success');
          closeModal({ force: true });
        } catch (err) {
          errEl.textContent = err.message || t('common.errorGeneric');
          errEl.hidden = false;
          submitBtn.disabled = false;
        }
      });
    },
  });
}

function bindIcsEvents(container, subs, user) {
  const addBtn = container.querySelector('#ics-add-btn');
  const formWrapper = container.querySelector('#ics-add-form-wrapper');
  const addForm = container.querySelector('#ics-add-form');
  const cancelBtn = container.querySelector('#ics-cancel-btn');
  const submitBtn = container.querySelector('#ics-submit-btn');
  const errorEl = container.querySelector('#ics-add-error');

  // Die Zuweisungsliste erst beim Aufklappen holen und nur einmal: Das Formular
  // steht dauerhaft im DOM, ein Nachladen bei jedem Öffnen wäre derselbe Abruf
  // ohne neues Ergebnis.
  const assigneeSel = container.querySelector('#ics-assignee');
  let assigneesLoaded = false;
  const fillAssignees = () => {
    if (assigneesLoaded || !assigneeSel) return;
    assigneesLoaded = true;
    loadFamilyUsers().then((users) => {
      assigneeSel.querySelector('option[data-loading]')?.remove();
      for (const u of users) {
        const opt = document.createElement('option');
        opt.value = String(u.id);
        opt.textContent = u.display_name;
        assigneeSel.appendChild(opt);
      }
    }).catch(() => { assigneesLoaded = false; });
  };

  addBtn?.addEventListener('click', () => {
    formWrapper.hidden = false;
    addBtn.hidden = true;
    fillAssignees();
    container.querySelector('#ics-url')?.focus();
  });

  cancelBtn?.addEventListener('click', () => {
    formWrapper.hidden = true;
    addBtn.hidden = false;
    addForm?.reset();
    errorEl.hidden = true;
  });

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const url = container.querySelector('#ics-url').value.trim();
    const name = container.querySelector('#ics-name').value.trim();
    const color = container.querySelector('#ics-color').value;
    const shared = container.querySelector('#ics-shared').checked ? 1 : 0;
    const assigneeVal = assigneeSel?.value || '';
    const default_assignee_user_id = assigneeVal ? Number(assigneeVal) : null;

    submitBtn.disabled = true;
    try {
      const res = await api.post('/calendar/subscriptions', {
        url, name, color, shared, default_assignee_user_id,
      });
      subs.push(res.data);
      renderIcsList(container, subs, user);
      addForm.reset();
      formWrapper.hidden = true;
      addBtn.hidden = false;
      if (res.syncError) {
        showToast(`${t('settings.ics.status.syncError')}: ${res.syncError}`, 'danger');
      } else {
        showToast(t('settings.ics.addedToast'), 'success');
      }
    } catch (err) {
      errorEl.textContent = err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// One-time calendar import (ICS file or shared feed → editable local events)
// --------------------------------------------------------------------------

function bindCalendarImport(container) {
  const form = container.querySelector('#cal-import-form');
  if (!form) return;
  const fileInput = container.querySelector('#cal-import-file');
  const urlInput = container.querySelector('#cal-import-url');
  const colorInput = container.querySelector('#cal-import-color');
  const errorEl = container.querySelector('#cal-import-error');
  const submitBtn = container.querySelector('#cal-import-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const file = fileInput.files?.[0];
    const url = urlInput.value.trim();
    if (!file && !url) {
      errorEl.textContent = t('settings.calendarImport.errorNoSource');
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    try {
      const payload = { color: colorInput.value };
      if (file) payload.ics = await file.text();
      else payload.url = url;

      const res = await api.post('/calendar/import', payload);
      const { imported = 0, skipped = 0 } = res.data || {};
      form.reset();

      if (imported === 0 && skipped > 0) {
        showToast(t('settings.calendarImport.allDuplicates'), 'default');
      } else if (skipped > 0) {
        showToast(t('settings.calendarImport.successWithSkipped', { count: imported, skipped }), 'success');
      } else {
        showToast(t('settings.calendarImport.success', { count: imported }), 'success');
      }
    } catch (err) {
      errorEl.textContent = err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export async function render(container, { user } = {}) {
  renderPage(container);

  let subs = [];
  const [res] = await Promise.allSettled([api.get('/calendar/subscriptions')]);
  if (res.status === 'fulfilled') subs = res.value.data || [];
  renderIcsList(container, subs, user);
  bindIcsEvents(container, subs, user);
  bindCalendarImport(container);

  window.lucide?.createIcons({ el: container });
}
