import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, confirmModal, advancedSection } from '/components/modal.js';
import { stagger, deleteWithUndo } from '/utils/ux.js';
import { t, formatDate, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { toLocalDateKey } from '/utils/date.js';

let state = {
  birthdays: [],
  query: '',
  loading: true,
};
let _container = null;

// Inline-SVG (Lucide-Stil) – das self-hostete Icon-Subset lässt sich nicht
// grep-verifizieren, darum die Torte als eingebettetes SVG für den „Heute"-Höhepunkt.
const CAKE_SVG = `<svg class="birthday-cake" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3M12 8v3M17 8v3"/><path d="M7 4h.01M12 4h.01M17 4h.01"/></svg>`;

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';
}

const REMINDER_OFFSETS = () => [
  { value: '',      label: t('reminders.offsetNone')  },
  { value: '1440',  label: t('reminders.offset1day')  },
  { value: '2880',  label: t('reminders.offset2days') },
  { value: '10080', label: t('reminders.offset1week') },
  { value: 'custom', label: t('reminders.offsetCustom') },
];

function renderBirthdayReminderSection(birthday = null) {
  const currentOffset = birthday?.reminder_offset ?? '1440';
  const customAmount = birthday?.reminder_custom_amount || 1;
  const customUnit = birthday?.reminder_custom_unit || 'days';
  return `
    <div class="reminder-section">
      <div class="form-group" style="margin:0">
        <label class="form-label" for="bd-reminder-offset">${t('reminders.offsetLabel')}</label>
        <select class="form-input birthday-modal__select" id="bd-reminder-offset">
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

// Datum + Alter in einer Zeile: „12.08.2026 · wird 30". Der Countdown lebt
// getrennt im Chip, damit keine Zahl doppelt erscheint.
function ageMeta(birthday) {
  const date = formatDate(birthday.next_birthday);
  return `${date} · ${t('birthdays.turnsAge', { age: birthday.next_age })}`;
}

// Countdown-Chip mit einheitlichem Wort-Register (kein „5d"-Kürzel):
// Heute / Morgen / in N Tagen. `mod` steuert die visuelle Stufe.
function countdownChip(birthday) {
  if (birthday.days_until === 0) return { label: t('common.today'), mod: 'today' };
  if (birthday.days_until === 1) return { label: t('common.tomorrow'), mod: 'soon' };
  const mod = birthday.days_until <= 7 ? 'soon' : 'default';
  return { label: t('birthdays.inDays', { days: birthday.days_until }), mod };
}

function photoAvatar(birthday, extraClass = '') {
  if (birthday.photo_data) {
    return `<img class="birthday-avatar ${extraClass}" src="${birthday.photo_data}" alt="${esc(birthday.name)}">`;
  }
  return `<span class="birthday-avatar birthday-avatar--fallback ${extraClass}">${esc(initials(birthday.name))}</span>`;
}

function sortByProximity(list) {
  return [...list].sort((a, b) =>
    (a.days_until ?? 9999) - (b.days_until ?? 9999) || a.name.localeCompare(b.name));
}

function filteredBirthdays() {
  const q = state.query.trim().toLowerCase();
  const list = !q ? state.birthdays : state.birthdays.filter((birthday) =>
    birthday.name.toLowerCase().includes(q) ||
    (birthday.notes || '').toLowerCase().includes(q)
  );
  return sortByProximity(list);
}

async function loadData() {
  const res = await api.get('/birthdays');
  state.birthdays = res.data ?? [];
  updateBirthdayBadge();
}

function updateBirthdayBadge() {
  const soon = state.birthdays.filter((b) => (b.days_until ?? 9999) <= 3).length;
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

function birthdayItemHtml(birthday) {
  const chip = countdownChip(birthday);
  const isToday = chip.mod === 'today';
  return `
    <article class="birthday-item ${isToday ? 'birthday-item--today' : ''}" data-id="${birthday.id}">
      <div class="birthday-item__media">${photoAvatar(birthday)}</div>
      <div class="birthday-item__body">
        <div class="birthday-item__row">
          <strong class="birthday-item__name">
            ${esc(birthday.name)}${isToday ? CAKE_SVG : ''}
          </strong>
          <span class="birthday-chip birthday-chip--${chip.mod}">${esc(chip.label)}</span>
        </div>
        <div class="birthday-item__meta">${esc(ageMeta(birthday))}</div>
        ${birthday.notes ? `<div class="birthday-item__notes">${esc(birthday.notes)}</div>` : ''}
      </div>
      <div class="birthday-item__actions">
        <button class="birthday-action-btn" type="button" data-action="edit" data-id="${birthday.id}" aria-label="${t('common.edit')}">
          <i data-lucide="pencil" style="width:18px;height:18px;" aria-hidden="true"></i>
        </button>
        <button class="birthday-action-btn" type="button" data-action="delete" data-id="${birthday.id}" aria-label="${t('common.delete')}">
          <i data-lucide="trash-2" style="width:18px;height:18px;" aria-hidden="true"></i>
        </button>
      </div>
    </article>`;
}

function emptyStateHtml() {
  if (state.query.trim()) {
    return `<div class="empty-state empty-state--compact">
      ${CAKE_SVG.replace('birthday-cake', 'empty-state__icon')}
      <div class="empty-state__title">${t('search.noResults')}</div>
    </div>`;
  }
  return `<div class="empty-state">
    ${CAKE_SVG.replace('birthday-cake', 'empty-state__icon')}
    <div class="empty-state__title">${t('birthdays.emptyTitle')}</div>
    <div class="empty-state__description">${t('birthdays.emptyDescription')}</div>
    <p class="empty-state__hint">${t('emptyHint.birthdays')}</p>
    <button class="btn btn--primary empty-state__cta" type="button" id="birthdays-empty-cta">
      ${t('birthdays.addButton')}
    </button>
  </div>`;
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
    host.insertAdjacentHTML('beforeend', emptyStateHtml());
    host.querySelector('#birthdays-empty-cta')?.addEventListener('click', () => openBirthdayModal({ mode: 'create' }));
    if (window.lucide) window.lucide.createIcons({ el: host });
    return;
  }

  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', list.map(birthdayItemHtml).join(''));

  if (window.lucide) window.lucide.createIcons({ el: host });
  stagger(host.querySelectorAll('.birthday-item'));
}

function renderPage() {
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', `
    <div class="birthdays-page">
      <div class="page-toolbar page-toolbar--wrap birthdays-toolbar">
        <h1 class="page-toolbar__title">${t('birthdays.title')}</h1>
        <label class="birthdays-toolbar__search page-toolbar__center" for="birthdays-search">
          <span class="sr-only">${t('birthdays.searchPlaceholder')}</span>
          <span class="birthdays-toolbar__search-control">
            <i data-lucide="search" class="birthdays-toolbar__search-icon" aria-hidden="true"></i>
            <input type="search" class="birthdays-toolbar__search-input" id="birthdays-search"
                   placeholder="${t('birthdays.searchPlaceholder')}" autocomplete="off" value="${esc(state.query)}">
          </span>
        </label>
      </div>

      <p class="birthdays-hint">${t('birthdays.calendarHint')}</p>

      <div class="birthdays-list" id="birthdays-list"></div>

      <button class="page-fab" id="fab-new-birthday" aria-label="${t('birthdays.addButton')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `);

  renderList();
  if (window.lucide) window.lucide.createIcons({ el: _container });
}

function bindEvents() {
  _container.querySelector('#fab-new-birthday').addEventListener('click', () => openBirthdayModal({ mode: 'create' }));

  const search = _container.querySelector('#birthdays-search');
  search.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
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
  const today = toLocalDateKey(new Date());

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
              <input class="form-input" id="bd-birth-date" type="date" max="${today}" value="${esc(birthday?.birth_date || '')}">
            </div>
          </div>
        </div>
        ${advancedSection(`
          <div class="form-group">
            <label class="form-label" for="bd-notes">${t('birthdays.notesLabel')}</label>
            <textarea class="form-input" id="bd-notes" rows="3" placeholder="${t('birthdays.notesPlaceholder')}">${esc(birthday?.notes || '')}</textarea>
          </div>
          ${renderBirthdayReminderSection(birthday)}`,
          { open: isEdit && (!!birthday?.notes || (!!birthday?.reminder_offset && birthday.reminder_offset !== '1440')) })}
        <div class="birthday-modal__hint">${t('birthdays.calendarHint')}</div>
        <div class="birthday-modal__footer">
          ${isEdit ? `<button class="btn btn--danger" id="bd-delete">${t('common.delete')}</button>` : '<div></div>'}
          <div class="birthday-modal__footer-actions">
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
          window.yuvomi?.showToast(err.message, 'danger');
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
          window.yuvomi?.showToast(t('birthdays.requiredFields'), 'warning');
          return;
        }

        saveBtn.disabled = true;
        try {
          if (isEdit) {
            await api.put(`/birthdays/${birthday.id}`, body);
            window.yuvomi?.showToast(t('birthdays.updatedToast'), 'success');
          } else {
            await api.post('/birthdays', body);
            window.yuvomi?.showToast(t('birthdays.createdToast'), 'success');
          }
          await loadData();
          renderList();
          closeModal({ force: true });
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
          saveBtn.disabled = false;
        }
      });
    },
  });
}

async function deleteBirthday(id, name) {
  if (!await confirmModal(t('birthdays.deleteConfirm', { name }), { danger: true, confirmLabel: t('common.delete') })) return;
  const birthday = state.birthdays.find((b) => b.id === id);
  state.birthdays = state.birthdays.filter((b) => b.id !== id);
  updateBirthdayBadge();
  renderList();
  await deleteWithUndo({
    onDelete: async () => { await api.delete(`/birthdays/${id}`); },
    onUndo: async () => {
      if (birthday) {
        state.birthdays = [...state.birthdays, birthday];
        updateBirthdayBadge();
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
  renderList();
}
