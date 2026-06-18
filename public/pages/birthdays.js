import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal } from '/components/modal.js';
import { stagger, deleteWithUndo } from '/utils/ux.js';
import { t, formatDate, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';

let state = {
  birthdays: [],
  upcoming: [],
  query: '',
  loading: true,
};
let _container = null;

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';
}

const REMINDER_OFFSETS = () => [
  { value: '',     label: t('reminders.offsetNone')   },
  { value: '0',    label: t('reminders.offsetAtTime') },
  { value: '15',   label: t('reminders.offset15min')  },
  { value: '60',   label: t('reminders.offset1hour')  },
  { value: '1440', label: t('reminders.offset1day')   },
  { value: '2880', label: t('reminders.offset2days')  },
  { value: '10080', label: t('reminders.offset1week') },
  { value: '20160', label: t('reminders.offset2weeks') },
  { value: 'custom', label: t('reminders.offsetCustom') },
];

function renderBirthdayReminderSection(birthday = null) {
  const currentOffset = birthday?.reminder_offset ?? '0';
  const customAmount = birthday?.reminder_custom_amount || 1;
  const customUnit = birthday?.reminder_custom_unit || 'days';
  return `
    <div class="reminder-section">
      <div class="form-group" style="margin:0">
        <label class="form-label" for="bd-reminder-offset">${t('reminders.offsetLabel')}</label>
        <select class="form-input" id="bd-reminder-offset" style="min-height:44px">
          ${REMINDER_OFFSETS().map((o) =>
            `<option value="${o.value}" ${currentOffset === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="modal-grid modal-grid--2 reminder-custom" id="bd-reminder-custom" ${currentOffset === 'custom' ? '' : 'hidden'}>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="bd-reminder-custom-amount">${t('reminders.customAmountLabel')}</label>
          <input class="form-input" type="number" id="bd-reminder-custom-amount" min="1" max="999" value="${customAmount}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="bd-reminder-custom-unit">${t('reminders.customUnitLabel')}</label>
          <select class="form-input" id="bd-reminder-custom-unit">
            <option value="minutes" ${customUnit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
            <option value="hours" ${customUnit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
            <option value="days" ${customUnit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
            <option value="weeks" ${customUnit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
          </select>
        </div>
      </div>
    </div>`;
}

function ageNote(birthday) {
  if (birthday.days_until === 0) return t('birthdays.ageNoteToday', { age: birthday.next_age });
  if (birthday.days_until === 1) return t('birthdays.ageNoteTomorrow', { age: birthday.next_age });
  return t('birthdays.ageNoteDays', { age: birthday.next_age, days: birthday.days_until });
}

function photoAvatar(birthday, extraClass = '') {
  if (birthday.photo_data) {
    return `<img class="birthday-avatar ${extraClass}" src="${birthday.photo_data}" alt="${esc(birthday.name)}">`;
  }
  return `<span class="birthday-avatar birthday-avatar--fallback ${extraClass}">${esc(initials(birthday.name))}</span>`;
}

function filteredBirthdays() {
  const q = state.query.trim().toLowerCase();
  const list = !q ? state.birthdays : state.birthdays.filter((birthday) =>
    birthday.name.toLowerCase().includes(q) ||
    (birthday.notes || '').toLowerCase().includes(q)
  );
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

function suggestions() {
  const q = state.query.trim().toLowerCase();
  if (!q) return [];
  return state.birthdays
    .filter((birthday) => birthday.name.toLowerCase().includes(q))
    .slice(0, 6);
}

async function loadData() {
  const [allRes, upcomingRes] = await Promise.all([
    api.get('/birthdays'),
    api.get('/birthdays/upcoming?limit=4'),
  ]);
  state.birthdays = allRes.data ?? [];
  state.upcoming = upcomingRes.data ?? [];
  updateBirthdayBadge();
}

function updateBirthdayBadge() {
  const soon = state.upcoming.filter((b) => b.days_until <= 3).length;
  document.querySelectorAll('[data-route="/birthdays"] .nav-badge').forEach((el) => el.remove());
  if (!soon) return;
  document.querySelectorAll('[data-route="/birthdays"]').forEach((navItem) => {
    let anchor = navItem.querySelector('.nav-item__icon-wrap');
    if (!anchor) {
      const icon = navItem.querySelector('.nav-item__icon');
      anchor = document.createElement('span');
      anchor.className = 'nav-item__icon-wrap';
      if (icon) { icon.replaceWith(anchor); anchor.appendChild(icon); }
      else navItem.prepend(anchor);
    }
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = String(soon);
    anchor.appendChild(badge);
  });
}

function renderSuggestions() {
  const dropdown = _container.querySelector('#birthdays-autocomplete');
  if (!dropdown) return;
  const items = suggestions();
  if (!items.length) {
    dropdown.hidden = true;
    dropdown.replaceChildren();
    return;
  }
  dropdown.hidden = false;
  dropdown.replaceChildren();
  dropdown.insertAdjacentHTML('beforeend', items.map((birthday, idx) => `
    <button class="birthday-suggestion" type="button" data-index="${idx}" data-name="${esc(birthday.name)}">
      ${photoAvatar(birthday, 'birthday-avatar--xs')}
      <span>
        <strong>${esc(birthday.name)}</strong>
        <small>${esc(ageNote(birthday))}</small>
      </span>
    </button>
  `).join(''));
}

function renderUpcoming() {
  const host = _container.querySelector('#birthdays-upcoming');
  if (!host) return;
  if (state.loading) {
    host.setAttribute('aria-busy', 'true');
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 2, lines: 2 }));
    return;
  }
  host.removeAttribute('aria-busy');
  if (!state.upcoming.length) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', `<div class="empty-state empty-state--compact">
      <div class="empty-state__title">${t('birthdays.emptyTitle')}</div>
      <div class="empty-state__description">${t('birthdays.emptyDescription')}</div>
    </div>`);
    return;
  }
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', state.upcoming.map((birthday) => `
    <article class="birthday-card">
      <div class="birthday-card__media">${photoAvatar(birthday)}</div>
      <div class="birthday-card__body">
        <div class="birthday-card__top">
          <div>
            <div class="birthday-card__name">${esc(birthday.name)}</div>
            <div class="birthday-card__date">${esc(formatDate(birthday.next_birthday))}</div>
          </div>
          <div class="birthday-card__pill">
            ${birthday.days_until === 0 ? esc(t('common.today')) : birthday.days_until === 1 ? esc(t('common.tomorrow')) : esc(`${birthday.days_until}d`)}
          </div>
        </div>
        <div class="birthday-card__note">${esc(ageNote(birthday))}</div>
      </div>
    </article>
  `).join(''));
}

function renderList() {
  const host = _container.querySelector('#birthdays-list');
  if (!host) return;
  if (state.loading) {
    host.setAttribute('aria-busy', 'true');
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));
    return;
  }
  host.removeAttribute('aria-busy');
  const list = filteredBirthdays();
  if (!list.length) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', `<div class="empty-state">
      <div class="empty-state__title">${t('birthdays.emptyTitle')}</div>
      <div class="empty-state__description">${t('birthdays.emptyDescription')}</div>
      <p class="empty-state__hint">${t('emptyHint.birthdays')}</p>
    </div>`);
    return;
  }

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', list.map((birthday) => `
    <article class="birthday-item" data-id="${birthday.id}">
      <div class="birthday-item__media">${photoAvatar(birthday)}</div>
      <div class="birthday-item__body">
        <div class="birthday-item__row">
          <strong class="birthday-item__name">${esc(birthday.name)}</strong>
          <span class="birthday-item__next">${esc(formatDate(birthday.next_birthday))}</span>
        </div>
        <div class="birthday-item__meta">${esc(formatDate(birthday.birth_date))}</div>
        <div class="birthday-item__note">${esc(ageNote(birthday))}</div>
        ${birthday.notes ? `<div class="birthday-item__notes">${esc(birthday.notes)}</div>` : ''}
      </div>
      <div class="birthday-item__actions">
        <button class="contact-action-btn" type="button" data-action="edit" data-id="${birthday.id}" aria-label="${t('common.edit')}">
          <i data-lucide="pencil" style="width:16px;height:16px;" aria-hidden="true"></i>
        </button>
        <button class="contact-action-btn" type="button" data-action="delete" data-id="${birthday.id}" aria-label="${t('common.delete')}">
          <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `).join(''));

  if (window.lucide) window.lucide.createIcons({ el: host });
  stagger(host.querySelectorAll('.birthday-item'));
}

function renderPage() {
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', `
    <div class="birthdays-page">
      <div class="birthdays-toolbar">
        <h1 class="u-toolbar-title">${t('birthdays.title')}</h1>
      </div>
      <p class="birthdays-toolbar__subtitle">${t('birthdays.calendarHint')}</p>

      <div class="birthdays-grid">
        <aside class="birthdays-panel birthdays-panel--upcoming">
          <div class="birthdays-section__header">
            <h2>${t('birthdays.upcomingTitle')}</h2>
            <p>${t('birthdays.upcomingHint')}</p>
          </div>
          <div class="birthday-cards" id="birthdays-upcoming"></div>
        </aside>

        <section class="birthdays-panel birthdays-panel--list">
          <div class="birthdays-toolbar birthdays-toolbar--embedded">
            <label class="birthdays-toolbar__search" for="birthdays-search">
              <span class="birthdays-toolbar__search-label sr-only">${t('birthdays.searchPlaceholder')}</span>
              <span class="birthdays-toolbar__search-control">
                <i data-lucide="search" class="birthdays-toolbar__search-icon" aria-hidden="true"></i>
                <input type="search" class="birthdays-toolbar__search-input" id="birthdays-search"
                       placeholder="${t('birthdays.searchPlaceholder')}" autocomplete="off" value="${esc(state.query)}">
                <div class="autocomplete-dropdown birthdays-autocomplete" id="birthdays-autocomplete" hidden></div>
              </span>
            </label>
          </div>
          <div class="birthdays-section__header birthdays-section__header--spaced">
            <h2>${t('birthdays.peopleTitle')}</h2>
            <p>${t('birthdays.peopleHint')}</p>
          </div>
          <div class="birthdays-list" id="birthdays-list"></div>
        </section>
      </div>

      <button class="page-fab" id="fab-new-birthday" aria-label="${t('birthdays.addButton')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `);

  renderUpcoming();
  renderList();
  renderSuggestions();
  if (window.lucide) window.lucide.createIcons({ el: _container });
}

function bindEvents() {
  const openCreate = () => openBirthdayModal({ mode: 'create' });
  _container.querySelector('#fab-new-birthday').addEventListener('click', openCreate);

  const search = _container.querySelector('#birthdays-search');
  search.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderSuggestions();
    renderList();
  });
  search.addEventListener('focus', renderSuggestions);
  search.addEventListener('blur', () => {
    setTimeout(() => {
      const dropdown = _container.querySelector('#birthdays-autocomplete');
      if (dropdown) dropdown.hidden = true;
    }, 100);
  });

  _container.querySelector('#birthdays-autocomplete').addEventListener('click', (e) => {
    const btn = e.target.closest('.birthday-suggestion');
    if (!btn) return;
    state.query = btn.dataset.name;
    search.value = state.query;
    renderList();
    renderSuggestions();
  });

  _container.querySelector('#birthdays-list').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]');
    if (!action) return;
    const id = Number(action.dataset.id);
    const birthday = state.birthdays.find((item) => item.id === id);
    if (!birthday) return;
    if (action.dataset.action === 'edit') {
      openBirthdayModal({ mode: 'edit', birthday });
      return;
    }
    if (action.dataset.action === 'delete') {
      await deleteBirthday(id, birthday.name);
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });
}

function birthdayPreviewHtml(name, photoData) {
  if (photoData) return `<img class="birthday-preview__image" src="${photoData}" alt="${esc(name || '')}">`;
  return `<span class="birthday-preview__fallback">${esc(initials(name))}</span>`;
}

function openBirthdayModal({ mode, birthday = null }) {
  const isEdit = mode === 'edit';
  let photoData = birthday?.photo_data || null;

  openSharedModal({
    title: isEdit ? t('birthdays.editTitle') : t('birthdays.newTitle'),
    content: `
      <div class="birthday-modal">
        <div class="birthday-modal__identity">
          <div class="birthday-modal__photo-wrap">
            <button type="button" class="birthday-avatar-editor" id="birthday-preview" aria-label="${t('birthdays.photoLabel')}">
              ${birthdayPreviewHtml(birthday?.name || '', photoData)}
            </button>
            <input class="sr-only" id="bd-photo" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
            <div class="birthday-modal__photo-actions">
              <button type="button" class="birthday-modal__photo-action" id="bd-photo-edit" aria-label="${t('birthdays.photoLabel')}" title="${t('birthdays.photoLabel')}">
                <i data-lucide="pencil" aria-hidden="true"></i>
              </button>
              <button type="button" class="birthday-modal__photo-action birthday-modal__photo-action--danger" id="bd-remove-photo" aria-label="${t('birthdays.removePhoto')}" title="${t('birthdays.removePhoto')}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="birthday-modal__fields">
            <div class="form-group">
              <label class="form-label" for="bd-name">${t('birthdays.nameLabel')}</label>
              <input class="form-input" id="bd-name" type="text" value="${esc(birthday?.name || '')}" autocomplete="name">
            </div>
            <div class="form-group">
              <label class="form-label" for="bd-birth-date">${t('birthdays.birthDateLabel')}</label>
              <input class="form-input" id="bd-birth-date" type="date" value="${esc(birthday?.birth_date || '')}">
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="bd-notes">${t('birthdays.notesLabel')}</label>
          <textarea class="form-input" id="bd-notes" rows="3" placeholder="${t('birthdays.notesPlaceholder')}">${esc(birthday?.notes || '')}</textarea>
        </div>
        ${renderBirthdayReminderSection(birthday)}
        <div class="birthday-modal__hint">${t('birthdays.calendarHint')}</div>
        <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
          ${isEdit ? `<button class="btn btn--danger" id="bd-delete">${t('common.delete')}</button>` : '<div></div>'}
          <div style="display:flex;gap:var(--space-3);">
            <button class="btn btn--secondary" type="button" id="bd-cancel">${t('common.cancel')}</button>
            <button class="btn btn--primary" type="button" id="bd-save">${isEdit ? t('common.save') : t('common.create')}</button>
          </div>
        </div>
      </div>
    `,
    size: 'md',
    onSave(panel) {
      const nameInput = panel.querySelector('#bd-name');
      const preview = panel.querySelector('#birthday-preview');
      const fileInput = panel.querySelector('#bd-photo');
      const photoEdit = panel.querySelector('#bd-photo-edit');
      const renderPreview = () => {
        preview.replaceChildren();
        preview.insertAdjacentHTML('beforeend', birthdayPreviewHtml(nameInput.value.trim(), photoData));
      };
      nameInput.addEventListener('input', renderPreview);
      preview.addEventListener('click', () => fileInput?.click());
      photoEdit?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          photoData = await readFileAsDataUrl(file);
          renderPreview();
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('#bd-remove-photo').addEventListener('click', () => {
        photoData = null;
        if (fileInput) fileInput.value = '';
        renderPreview();
      });

      const reminderOffset = panel.querySelector('#bd-reminder-offset');
      const reminderCustom = panel.querySelector('#bd-reminder-custom');
      reminderOffset?.addEventListener('change', () => {
        if (reminderCustom) reminderCustom.hidden = reminderOffset.value !== 'custom';
      });

      panel.querySelector('#bd-cancel').addEventListener('click', closeModal);
      panel.querySelector('#bd-delete')?.addEventListener('click', async () => {
        closeModal();
        await deleteBirthday(birthday.id, birthday.name);
      });
      panel.querySelector('#bd-save').addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#bd-save');
        const birthDateRaw = panel.querySelector('#bd-birth-date').value;
        const birthDate = parseDateInput(birthDateRaw);
        const body = {
          name: panel.querySelector('#bd-name').value.trim(),
          birth_date: birthDate,
          notes: panel.querySelector('#bd-notes').value.trim(),
          photo_data: photoData,
          reminder_offset: panel.querySelector('#bd-reminder-offset').value,
          reminder_custom_amount: panel.querySelector('#bd-reminder-custom-amount').value,
          reminder_custom_unit: panel.querySelector('#bd-reminder-custom-unit').value,
        };

        if (!body.name || !body.birth_date || !isDateInputValid(birthDateRaw)) {
          window.oikos?.showToast(t('birthdays.requiredFields'), 'warning');
          return;
        }

        saveBtn.disabled = true;
        try {
          if (isEdit) {
            const res = await api.put(`/birthdays/${birthday.id}`, body);
            const idx = state.birthdays.findIndex((item) => item.id === birthday.id);
            if (idx !== -1) state.birthdays[idx] = res.data;
            window.oikos?.showToast(t('birthdays.updatedToast'), 'success');
          } else {
            const res = await api.post('/birthdays', body);
            state.birthdays.push(res.data);
            window.oikos?.showToast(t('birthdays.createdToast'), 'success');
          }
          state.birthdays.sort((a, b) => a.name.localeCompare(b.name));
          const upcomingRes = await api.get('/birthdays/upcoming?limit=4');
          state.upcoming = upcomingRes.data ?? [];
          renderUpcoming();
          renderSuggestions();
          renderList();
          closeModal({ force: true });
        } catch (err) {
          window.oikos?.showToast(err.message, 'danger');
          saveBtn.disabled = false;
        }
      });
    },
  });
}

async function deleteBirthday(id, name) {
  if (!await confirmModal(t('birthdays.deleteConfirm', { name }), { danger: true, confirmLabel: t('common.delete') })) return;
  const birthday = state.birthdays.find((b) => b.id === id);
  state.birthdays = state.birthdays.filter((b) => b.id !== id).sort((a, b) => a.name.localeCompare(b.name));
  state.upcoming = state.upcoming.filter((b) => b.id !== id);
  renderUpcoming();
  renderSuggestions();
  renderList();
  await deleteWithUndo({
    onDelete: async () => { await api.delete(`/birthdays/${id}`); },
    onUndo: async () => {
      if (birthday) {
        state.birthdays = [...state.birthdays, birthday].sort((a, b) => a.name.localeCompare(b.name));
        state.upcoming = [...state.upcoming, birthday];
        renderUpcoming();
        renderSuggestions();
        renderList();
      }
    },
    toastMessage: t('birthdays.deletedToast'),
    toastType: 'success',
  });
}

export async function render(container) {
  _container = container;
  // Shell zuerst (synchron) bauen, damit das Lade-Skeleton sofort sichtbar ist
  // (der Router blendet den Wrapper bereits vor dem Daten-await ein). Danach
  // Daten laden und mit echtem Inhalt füllen.
  state.loading = true;
  renderPage();
  bindEvents();
  await loadData();
  state.loading = false;
  renderUpcoming();
  renderList();
  renderSuggestions();
}
