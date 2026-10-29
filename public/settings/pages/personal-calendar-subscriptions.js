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
import { t } from '/i18n.js';
import { dateTimeText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { captureModalContext, closeModal, confirmModal, openModal, refocusAfterRender, reportFieldErrors, constraintErrors } from '/components/modal.js';
import { settingRowHtml, settingSwitchRowHtml, toggleRowHtml, fileDropzoneHtml, wireFileDropzone } from '/settings/components.js';
import { colorPickerHtml, wireColorPicker } from '/utils/color-picker.js';
import { USER_COLOR_DEFAULT } from '/utils/color.js';
import { assigneeIdsOf, buildAssigneeMenu } from '/settings/assignee-menu.js';
import { formRowHtml, formRowsHtml } from '/utils/form-row.js';
import { rowActionEl } from '/utils/row-action.js';
import { loadErrorSentence } from '/utils/friendly-error.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeText(date);
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
            ${/* EIN FORMULAR-DIALEKT (R19, Einstellungen B7): Adresse, Name,
                 Farbe, Zuweisung und Teilen als Zeilen der Gruppe. */ ''}
            <div class="row-carrier settings-group">
              ${settingRowHtml({
                label: t('settings.ics.form.url'), labelFor: 'ics-url', labelExtra: REQUIRED_MARK,
                control: '<input class="form-input" type="url" id="ics-url" required placeholder="https://..." />',
              })}
              ${settingRowHtml({
                label: t('settings.ics.form.name'), labelFor: 'ics-name', labelExtra: REQUIRED_MARK,
                control: '<input class="form-input" type="text" id="ics-name" required maxlength="100" />',
              })}
              ${settingRowHtml({
                label: t('settings.ics.form.color'), labelId: 'ics-color-label', stacked: true,
                control: colorPickerHtml({ id: 'ics-color', value: USER_COLOR_DEFAULT, labelledBy: 'ics-color-label' }),
              })}
              ${settingRowHtml({
                label: t('settings.sync.defaultAssignees'), labelFor: 'ics-assignee',
                description: t('settings.sync.defaultAssigneesHint'), descriptionId: 'ics-assignee-hint',
                control: '<span data-assignee-slot="ics-assignee"></span>',
              })}
              ${settingSwitchRowHtml({
                label: t('settings.ics.form.shared'),
                attrs: { id: 'ics-shared' },
              })}
            </div>
            <div id="ics-add-error" class="form-error" role="alert" hidden></div>
            <div class="settings-form-actions">
              <button type="button" class="btn btn--secondary" id="ics-cancel-btn">${t('settings.ics.actions.cancel')}</button>
              <button type="submit" class="btn btn--primary" id="ics-submit-btn">${t('settings.ics.actions.submit')}</button>
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
          ${/* Derselbe Dialekt wie das Abo darueber (R19). */ ''}
          <div class="row-carrier settings-group">
            ${settingRowHtml({
              label: t('settings.calendarImport.fileLabel'), labelFor: 'cal-import-file', stacked: true,
              control: fileDropzoneHtml({
                id: 'cal-import-dropzone', inputId: 'cal-import-file', accept: '.ics,text/calendar',
                title: t('settings.calendarImport.dropzoneTitle'), titleTouch: t('settings.calendarImport.dropzoneTitleTouch'),
                hint: t('settings.calendarImport.dropzoneHint'), icon: 'calendar-plus',
              }),
            })}
            ${settingRowHtml({
              label: t('settings.calendarImport.urlLabel'), labelFor: 'cal-import-url',
              description: t('settings.calendarImport.urlHint'), descriptionId: 'cal-import-url-hint',
              control: '<input class="form-input" type="url" id="cal-import-url" aria-describedby="cal-import-url-hint" placeholder="https://..." />',
            })}
            ${settingRowHtml({
              label: t('settings.calendarImport.colorLabel'), labelId: 'cal-import-color-label', stacked: true,
              control: colorPickerHtml({ id: 'cal-import-color', value: USER_COLOR_DEFAULT, labelledBy: 'cal-import-color-label' }),
            })}
            ${settingRowHtml({
              label: t('settings.calendarImport.assigneesLabel'), labelFor: 'cal-import-assignees',
              description: t('settings.calendarImport.assigneesHint'), descriptionId: 'cal-import-assignees-hint',
              control: '<span data-assignee-slot="cal-import-assignees"></span>',
            })}
            ${settingRowHtml({
              label: t('settings.calendarImport.targetCalendarLabel'), labelFor: 'cal-import-calendar',
              control: `<select class="form-input" id="cal-import-calendar">
                <option value="" disabled data-loading>${t('common.loading')}</option>
              </select>`,
            })}
            ${settingRowHtml({
              label: t('settings.calendarImport.newCalendarNameLabel'), labelFor: 'cal-import-new-calendar-name',
              attrs: { id: 'cal-import-new-calendar-group', hidden: true },
              control: '<input class="form-input" type="text" id="cal-import-new-calendar-name" maxlength="80" />',
            })}
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
  // Zeilenaktionen der Shell (Komponenten-Kanon 2026-09-26): `.row-action`,
  // Loeschen `--danger`, und jeder Name nennt das Abo - drei Abos mit drei
  // Knoepfen hiessen vorher neunmal „Bearbeiten"/„Loeschen"/„Synchronisieren".
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const name = sub.name;

  const syncBtn = rowActionEl({ icon: 'refresh-cw', label: t('settings.ics.actions.syncNamed', { name }) });
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

  const editBtn = rowActionEl({
    icon: 'pencil',
    label: t('common.editNamed', { name }),
    onClick: () => openIcsEditModal(container, sub, subs, user),
  });
  actions.appendChild(editBtn);

  const delBtn = rowActionEl({ icon: 'trash-2', tone: 'danger', label: t('common.deleteNamed', { name }) });
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
      <form id="ics-edit-form" class="settings-form" novalidate>
        ${/* DER DIALOG SPRICHT DENSELBEN DIALEKT (R19, B7): Name, Farbe,
             Teilen und Zuweisung als Zeilen im Traeger - vorher Felder unter
             ihren Etiketten und ein Schalter, der neben der Farbe klemmte. */ ''}
        ${formRowsHtml([
          formRowHtml({
            label: t('settings.ics.form.name'), labelFor: 'ics-edit-name', labelExtra: REQUIRED_MARK, field: true,
            control: `<input class="form-input" type="text" id="ics-edit-name" value="${esc(sub.name)}" required maxlength="100" />`,
          }),
          formRowHtml({
            label: t('settings.ics.form.color'), labelId: 'ics-edit-color-label', stacked: true,
            control: colorPickerHtml({ id: 'ics-edit-color', value: sub.color || USER_COLOR_DEFAULT, labelledBy: 'ics-edit-color-label' }),
          }),
          toggleRowHtml({
            control: 'switch',
            label: t('settings.ics.form.shared'),
            checked: !!sub.shared,
            attrs: { id: 'ics-edit-shared' },
          }),
          formRowHtml({
            label: t('settings.sync.defaultAssignees'), labelFor: 'ics-edit-assignee',
            description: t('settings.sync.defaultAssigneesHint'), descriptionId: 'ics-edit-assignee-hint',
            control: '<span data-assignee-slot="ics-edit-assignee"></span>',
          }),
        ])}
        <div id="ics-edit-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="ics-edit-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('settings.ics.actions.save')}</button>
        </div>
      </form>
    `,
    onSave(panel) {
      wireColorPicker(panel);
      // Die Personen laden im Knopf nach - der Dialog oeffnet sofort.
      const storedAssignees = storedAssigneeIds(sub);
      mountAssigneeField(panel.querySelector('#ics-edit-form'), 'ics-edit-assignee', storedAssignees);
      panel.querySelector('#ics-edit-cancel')?.addEventListener('click', () => closeModal());
      panel.querySelector('#ics-edit-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        // KEINE BROWSER-BLASEN (Critique R21): `novalidate`, die Regeln des Markups melden sich am Feld (constraintErrors, components/modal.js).
        if (reportFieldErrors(constraintErrors(e.currentTarget))) return;
        const submitBtn = panel.querySelector('[type=submit]');
        const errEl = panel.querySelector('#ics-edit-error');
        const name = panel.querySelector('#ics-edit-name').value.trim();
        const color = panel.querySelector('#ics-edit-color').value;
        const shared = panel.querySelector('#ics-edit-shared').checked ? 1 : 0;
        const assignee = assigneePatch(panel.querySelector('#ics-edit-assignee'), storedAssignees);
        errEl.hidden = true;
        // Geschlossen wird nur dieser Dialog, nicht einer, der waehrend der
        // Anfrage aufgegangen ist (#1997).
        const modalContext = captureModalContext();
        submitBtn.disabled = true;
        try {
          const res = await api.patch(`/calendar/subscriptions/${sub.id}`, { name, color, shared, ...assignee });
          const idx = subs.findIndex((s) => s.id === sub.id);
          if (idx >= 0) subs[idx] = res.data;
          renderIcsList(container, subs, user);
          showToast(t('settings.ics.updatedToast'), 'success');
          closeModal({ force: true, context: modalContext });
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
  wireColorPicker(container);
  const addBtn = container.querySelector('#ics-add-btn');
  const formWrapper = container.querySelector('#ics-add-form-wrapper');
  const addForm = container.querySelector('#ics-add-form');
  const cancelBtn = container.querySelector('#ics-cancel-btn');
  const submitBtn = container.querySelector('#ics-submit-btn');
  const errorEl = container.querySelector('#ics-add-error');

  // Das Feld der Personen entsteht beim Aufklappen, jedes Mal leer: das
  // Formular steht dauerhaft im DOM, und `reset()` kennt den Knopf nicht. Die
  // Mitgliederliste haelt family-users.js ohnehin einmal je Seitenaufruf.
  const fillAssignees = () => mountAssigneeField(addForm, 'ics-assignee', []);

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
    const default_assignee_user_ids = assigneeIdsOf(container.querySelector('#ics-assignee'));

    submitBtn.disabled = true;
    try {
      const res = await api.post('/calendar/subscriptions', {
        url, name, color, shared, default_assignee_user_ids,
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

function populateCalendarImportTarget(container, calendars = []) {
  const select = container.querySelector('#cal-import-calendar');
  if (!select) return;
  select.replaceChildren();
  for (const calendar of calendars) {
    const option = document.createElement('option');
    option.value = String(calendar.id);
    option.textContent = calendar.name;
    if (calendar.is_default) option.selected = true;
    select.appendChild(option);
  }
  const createOption = document.createElement('option');
  createOption.value = '__new';
  createOption.textContent = t('settings.calendarImport.createNewCalendar');
  select.appendChild(createOption);
  if (!select.value && select.options.length) select.selectedIndex = 0;
}

function bindCalendarImport(container, calendars = []) {
  wireColorPicker(container);
  const form = container.querySelector('#cal-import-form');
  if (!form) return;
  const fileInput = container.querySelector('#cal-import-file');
  const urlInput = container.querySelector('#cal-import-url');
  const colorInput = container.querySelector('#cal-import-color');
  const calendarSelect = container.querySelector('#cal-import-calendar');
  const newCalendarGroup = container.querySelector('#cal-import-new-calendar-group');
  const newCalendarNameInput = container.querySelector('#cal-import-new-calendar-name');
  const errorEl = container.querySelector('#cal-import-error');
  const submitBtn = container.querySelector('#cal-import-submit');
  const importedCalendars = [...calendars];
  const dropzone = wireFileDropzone(container, 'cal-import-file');
  // Personen fuer diesen Lauf (#1940): gespeichert wird nichts, nach dem
  // Import steht das Feld wieder leer.
  mountAssigneeField(form, 'cal-import-assignees', []);

  const syncNewCalendarVisibility = () => {
    if (newCalendarGroup) newCalendarGroup.hidden = calendarSelect?.value !== '__new';
  };
  calendarSelect?.addEventListener('change', syncNewCalendarVisibility);
  syncNewCalendarVisibility();

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
    let createdCalendarId = null;
    try {
      const payload = { color: colorInput.value };
      const people = assigneeIdsOf(container.querySelector('#cal-import-assignees'));
      if (people.length) payload.assignee_user_ids = people;
      if (file) payload.ics = await file.text();
      else payload.url = url;
      if (calendarSelect?.value === '__new') {
        const name = newCalendarNameInput?.value.trim() || '';
        if (!name) {
          errorEl.textContent = t('settings.calendarImport.errorNoCalendarName');
          errorEl.hidden = false;
          return;
        }
        const created = await api.post('/calendar/calendars', { name, color: colorInput.value });
        createdCalendarId = created.data.id;
        payload.local_calendar_id = created.data.id;
      } else if (calendarSelect?.value) {
        payload.local_calendar_id = Number(calendarSelect.value);
      }

      const res = await api.post('/calendar/import', payload);
      if (createdCalendarId != null) {
        importedCalendars.push({ id: createdCalendarId, name: newCalendarNameInput?.value.trim() });
      }
      const { imported = 0, skipped = 0, assigned = 0 } = res.data || {};
      form.reset();
      dropzone.reset();
      mountAssigneeField(form, 'cal-import-assignees', []);
      populateCalendarImportTarget(container, importedCalendars);
      syncNewCalendarVisibility();

      if (assigned > 0) {
        // Schon vorhandene Termine haben Personen dazubekommen (#1940): das ist
        // der Zweck des zweiten Laufs und steht im Satz, nicht "alles doppelt".
        showToast(t('settings.calendarImport.successWithAssigned', { imported, skipped, assigned }), 'success');
      } else if (imported === 0 && skipped > 0) {
        showToast(t('settings.calendarImport.allDuplicates'), 'default');
      } else if (skipped > 0) {
        showToast(t('settings.calendarImport.successWithSkipped', { count: imported, skipped }), 'success');
      } else {
        showToast(t('settings.calendarImport.success', { count: imported }), 'success');
      }
    } catch (err) {
      if (createdCalendarId != null) {
        try {
          await api.delete(`/calendar/calendars/${createdCalendarId}`);
        } catch (cleanupErr) {
          console.warn('[Calendar import] Could not remove calendar after failed import:', cleanupErr);
        }
      }
      // Ein Serverfehler beim Anlegen des Kalenders oder beim Import sagt den
      // Satz der App (#1695), nie den des Servers. Die 400 des Imports nennen
      // weiter ihre Ursache, bis dessen Scheibe kommt.
      errorEl.textContent = (err?.status >= 500 && loadErrorSentence(err)) || err.message || t('common.errorGeneric');
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/** Die gespeicherten Standard-Personen eines Abos (#1897), auch aus der Altform. */
function storedAssigneeIds(sub) {
  if (Array.isArray(sub?.default_assignee_user_ids)) return sub.default_assignee_user_ids.map(Number);
  return sub?.default_assignee_user_id != null ? [Number(sub.default_assignee_user_id)] : [];
}

/**
 * Setzt den Personen-Knopf (assignee-menu.js) an die Stelle seines Platzhalters
 * im Formular. Ein zweiter Aufruf ersetzt den ersten - samt seinem Menue.
 * @param {HTMLElement|null} form  Wirt des Menues (ausserhalb eines Labels)
 * @param {string} id              id des Knopfs, dieselbe wie `labelFor`
 * @param {number[]} currentIds
 */
function mountAssigneeField(form, id, currentIds) {
  const slot = form?.querySelector(`[data-assignee-slot="${id}"]`);
  if (!slot) return;
  const old = slot.querySelector('.assignee-menu__trigger');
  if (old) document.getElementById(old.getAttribute('popovertarget'))?.remove();
  const trigger = buildAssigneeMenu({ currentIds, host: form, id, triggerClass: 'form-input' });
  trigger.setAttribute('aria-describedby', `${id}-hint`);
  slot.replaceChildren(trigger);
}

/**
 * Der Zustaendigen-Wert fuer PATCH /calendar/subscriptions/:id. Hat niemand
 * die Personen angefasst, bleibt das Feld weg, und der Server laesst die
 * gespeicherten stehen - so traegt ein Speichern von Name oder Farbe nichts
 * ein, was der Knopf (noch) nicht kennt (#1207). Sonst die Menge in der
 * Reihenfolge der Wahl (#1897).
 */
function assigneePatch(trigger, stored) {
  const ids = assigneeIdsOf(trigger);
  const same = ids.length === stored.length && ids.every((id, i) => id === Number(stored[i]));
  return same ? {} : { default_assignee_user_ids: ids };
}

export const __test = { assigneePatch, openIcsEditModal, storedAssigneeIds };

export async function render(container, { user } = {}) {
  renderPage(container);

  let subs = [];
  let calendars = [];
  const [res, calendarsRes] = await Promise.allSettled([
    api.get('/calendar/subscriptions'),
    api.get('/calendar/calendars'),
  ]);
  if (res.status === 'fulfilled') subs = res.value.data || [];
  if (calendarsRes.status === 'fulfilled') calendars = calendarsRes.value.data || [];
  populateCalendarImportTarget(container, calendars);
  renderIcsList(container, subs, user);
  bindIcsEvents(container, subs, user);
  bindCalendarImport(container, calendars);

  window.lucide?.createIcons({ el: container });
}
