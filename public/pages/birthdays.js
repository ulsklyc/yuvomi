import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal } from '/components/modal.js';
import { stagger, deleteWithUndo } from '/utils/ux.js';
import { t, formatDate, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';

let state = {
  birthdays: [],
  upcoming: [],
  query: '',
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

  if (window.lucide) window.lucide.createIcons();
  stagger(host.querySelectorAll('.birthday-item'));
}

function renderPage() {
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', `
    <div class="birthdays-page">
      <h1 class="sr-only">${t('birthdays.title')}</h1>
      <div class="birthdays-toolbar">
        <div class="birthdays-toolbar__title">
          <i data-lucide="cake" class="birthdays-toolbar__title-icon" aria-hidden="true"></i>
          <span>${t('birthdays.title')}</span>
        </div>
        <button class="btn btn--primary birthdays-header__action" id="birthdays-add-btn">
          <i data-lucide="plus" style="width:16px;height:16px;margin-right:4px;" aria-hidden="true"></i>
          ${t('birthdays.addButton')}
        </button>
      </div>
      <p class="birthdays-toolbar__subtitle">${t('birthdays.calendarHint')}</p>

      <div class="birthdays-grid">
        <aside class="birthdays-panel birthdays-panel--upcoming">
          <div class="birthdays-section__header">
            <h3>${t('birthdays.upcomingTitle')}</h3>
            <p>${t('birthdays.upcomingHint')}</p>
          </div>
          <div class="birthday-cards" id="birthdays-upcoming"></div>
        </aside>

        <section class="birthdays-panel birthdays-panel--list">
          <div class="birthdays-toolbar birthdays-toolbar--embedded">
            <div class="birthdays-toolbar__search">
              <i data-lucide="search" class="birthdays-toolbar__search-icon" aria-hidden="true"></i>
              <input type="search" class="birthdays-toolbar__search-input" id="birthdays-search"
                     placeholder="${t('birthdays.searchPlaceholder')}" autocomplete="off" value="${esc(state.query)}">
              <div class="autocomplete-dropdown birthdays-autocomplete" id="birthdays-autocomplete" hidden></div>
            </div>
          </div>
          <div class="birthdays-section__header birthdays-section__header--spaced">
            <h3>${t('birthdays.peopleTitle')}</h3>
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
  if (window.lucide) window.lucide.createIcons();
}

function bindEvents() {
  const openCreate = () => openBirthdayModal({ mode: 'create' });
  _container.querySelector('#birthdays-add-btn').addEventListener('click', openCreate);
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
        <div class="birthday-preview" id="birthday-preview">${birthdayPreviewHtml(birthday?.name || '', photoData)}</div>
        <div class="form-group">
          <label class="form-label" for="bd-name">${t('birthdays.nameLabel')}</label>
          <input class="form-input" id="bd-name" type="text" value="${esc(birthday?.name || '')}" autocomplete="name">
        </div>
        <div class="form-group">
          <label class="form-label" for="bd-birth-date">${t('birthdays.birthDateLabel')}</label>
          <input class="form-input" id="bd-birth-date" type="date" value="${esc(birthday?.birth_date || '')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="bd-photo">${t('birthdays.photoLabel')}</label>
          <input class="form-input" id="bd-photo" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          <div class="form-help">${t('birthdays.photoOptional')}</div>
          <div class="birthday-modal__photo-actions">
            <button type="button" class="btn btn--secondary" id="bd-remove-photo">${t('birthdays.removePhoto')}</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="bd-notes">${t('birthdays.notesLabel')}</label>
          <textarea class="form-input" id="bd-notes" rows="3" placeholder="${t('birthdays.notesPlaceholder')}">${esc(birthday?.notes || '')}</textarea>
        </div>
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
      const renderPreview = () => {
        preview.replaceChildren();
        preview.insertAdjacentHTML('beforeend', birthdayPreviewHtml(nameInput.value.trim(), photoData));
      };
      nameInput.addEventListener('input', renderPreview);
      panel.querySelectorAll('.js-date-input').forEach((input) => {
        input.addEventListener('blur', () => {
          const parsed = parseDateInput(input.value);
          if (parsed) input.value = formatDateInput(parsed);
        });
      });
      panel.querySelector('#bd-photo').addEventListener('change', async (e) => {
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
        panel.querySelector('#bd-photo').value = '';
        renderPreview();
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
  await loadData();
  renderPage();
  bindEvents();
}
