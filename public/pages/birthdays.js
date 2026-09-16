import { api } from '/api.js';
import { openModal as openSharedModal, closeModal, advancedSection } from '/components/modal.js';
import { stagger, scheduleUndoableDelete } from '/utils/ux.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { t, formatDate, parseDateInput, isDateInputValid, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { todayKey } from '/utils/date.js';
import { setNavBadge, BIRTHDAY_BADGE_DAYS } from '/utils/nav-badges.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { moduleAccess } from '/permissions.js';
import { findPageFab } from '/utils/fab.js';
// Alias: dieses Modul fuehrt selbst eine `emptyStateHtml()`, die den Renderer
// mit den Geburtstags-Texten fuellt. Zwei Namen, die sich nur in der
// Gross-Schreibung unterscheiden, waeren im Modul nicht auseinanderzuhalten.
import { emptyStateHTML as sharedEmptyStateHTML, emptyHintHTML } from '/utils/empty-state.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import {
  renderAppPage,
  renderPageHeader,
  renderPageTitle,
  renderPageBody,
  renderPageActions,
  renderPageSection,
  renderListSection,
} from '/utils/page-layout.js';

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

export function daysInNameDayMonth(month) {
  const numeric = Number(month);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 12) return 0;
  return new Date(Date.UTC(2000, numeric, 0)).getUTCDate();
}

export function normalizeNameDaySelection(month, day) {
  const rawMonth = String(month ?? '').trim();
  const rawDay = String(day ?? '').trim();
  if (!rawMonth && !rawDay) return { value: null, complete: true };
  if (!rawMonth || !rawDay) return { value: null, complete: false };
  const monthNumber = Number(rawMonth);
  const dayNumber = Number(rawDay);
  if (!Number.isInteger(monthNumber) || !Number.isInteger(dayNumber)
      || dayNumber < 1 || dayNumber > daysInNameDayMonth(monthNumber)) {
    return { value: null, complete: false };
  }
  return {
    value: `${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`,
    complete: true,
  };
}

function nameDayDayOptions(month, selectedDay = '') {
  const count = daysInNameDayMonth(month);
  const options = [`<option value="">${esc(t('birthdays.nameDayDayPlaceholder'))}</option>`];
  for (let day = 1; day <= count; day++) {
    const value = String(day).padStart(2, '0');
    options.push(`<option value="${value}"${value === selectedDay ? ' selected' : ''}>${day}</option>`);
  }
  return options.join('');
}

export function renderNameDayField(birthday = null) {
  const [selectedMonth = '', selectedDay = ''] = String(birthday?.name_day || '').split('-');
  const monthFormatter = new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' });
  const months = Array.from({ length: 12 }, (_, index) => {
    const value = String(index + 1).padStart(2, '0');
    const label = monthFormatter.format(new Date(Date.UTC(2000, index, 1)));
    return `<option value="${value}"${value === selectedMonth ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  return `
    <div class="form-group birthday-name-day">
      <span class="form-label" id="bd-name-day-label">${t('birthdays.nameDayLabel')}</span>
      <div class="birthday-name-day__controls" role="group" aria-labelledby="bd-name-day-label">
        <select class="form-input birthday-modal__select" id="bd-name-day-month" aria-label="${t('birthdays.nameDayMonthLabel')}">
          <option value="">${t('birthdays.nameDayMonthPlaceholder')}</option>
          ${months}
        </select>
        <select class="form-input birthday-modal__select" id="bd-name-day-day" aria-label="${t('birthdays.nameDayDayLabel')}"${selectedMonth ? '' : ' disabled'}>
          ${nameDayDayOptions(selectedMonth, selectedDay)}
        </select>
        <button class="btn btn--secondary birthday-name-day__clear" type="button" id="bd-name-day-clear" aria-label="${t('birthdays.nameDayClear')}" title="${t('birthdays.nameDayClear')}">
          <i data-lucide="x" aria-hidden="true"></i><span>${t('birthdays.nameDayClear')}</span>
        </button>
      </div>
      <div class="birthday-name-day__hint">${t('birthdays.nameDayHint')}</div>
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

/**
 * DIE PERSON SCHLAEGT DIE LISTE, IN DER SIE STEHT.
 *
 * `.birthday-avatar--fallback` verspricht seit 2026-08-18 „wer verknuepft ist,
 * traegt seine Mitgliedsfarbe" - eingeloest war das nur auf der Uebersichts-
 * kachel. Auf der Modulseite sass jedes Haushaltsmitglied auf derselben
 * neutralen Scheibe wie eine Tante ohne Zugang (Identitaetsfarben-Regel,
 * DESIGN.md).
 *
 * Reihenfolge: ein Bild, das FUER DIESEN EINTRAG hinterlegt wurde, ist die
 * genaueste Auskunft und gewinnt; danach kommt das Profilbild des Mitglieds,
 * danach seine Farbe mit den Initialen. Wer zu niemandem im Haushalt gehoert,
 * bleibt neutral - er hat keine Identitaetsfarbe, und genau das soll die
 * Scheibe sagen.
 *
 * Die Tinte kommt aus `getReadableTextColor`: eine Avatarfarbe ist frei
 * gewaehlt, ihre Helligkeit damit unbestimmt - dieselbe Rechnung wie in den
 * Kontakten.
 */
function photoAvatar(birthday, extraClass = '') {
  if (birthday.photo_data) {
    return `<img class="birthday-avatar ${extraClass}" src="${birthday.photo_data}" alt="${esc(birthday.name)}">`;
  }
  if (birthday.family_user_id && birthday.family_avatar_data) {
    return `<img class="birthday-avatar ${extraClass}" src="${esc(birthday.family_avatar_data)}" alt="${esc(birthday.name)}">`;
  }
  if (birthday.family_user_id) {
    const color = birthday.family_avatar_color || AVATAR_FALLBACK_COLOR;
    const name = birthday.family_display_name || birthday.name;
    return `<span class="birthday-avatar birthday-avatar--fallback ${extraClass}"
      style="background-color:${esc(color)};color:${getReadableTextColor(color)}">${esc(initials(name))}</span>`;
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

/**
 * How many birthday or name-day occurrences are imminent?
 * The server computes both distances (`hydrateBirthday`); this function only
 * applies the cutoff, so `/dashboard` uses the same rule for its initial count.
 * One person may count twice because the badge describes occurrences, not people.
 */
export function countBirthdaysSoon(birthdays) {
  return birthdays.reduce((count, birthday) => count
    + ((birthday.days_until ?? 9999) <= BIRTHDAY_BADGE_DAYS ? 1 : 0)
    + ((birthday.name_day_days_until ?? 9999) <= BIRTHDAY_BADGE_DAYS ? 1 : 0), 0);
}

function updateBirthdayBadge() {
  // Nachricht, kein Alarm (Valenz siehe nav-badges.js).
  setNavBadge('/birthdays', countBirthdaysSoon(state.birthdays), undefined, 'accent');
}

export function birthdayItemHtml(birthday) {
  const chip = countdownChip(birthday);
  const isToday = chip.mod === 'today';
  const hasNameDay = birthday.next_name_day && Number.isInteger(birthday.name_day_days_until);
  const nameDayMeta = hasNameDay
    ? `<span class="birthday-item__name-day">`
      + `${esc(t('birthdays.inDays', { days: birthday.name_day_days_until }))} · `
      + `${esc(formatDate(birthday.next_name_day))} · ${esc(t('birthdays.celebratesNameDay'))}`
      + '</span>'
    : '';
  // Wischbedienung (Redesign Runde 4, C-2): auf Touch tragen die beiden
  // Richtungen, was bis dahin zwei Icon-Knoepfe in jeder Zeile trugen - in
  // einer Grouped-Liste die lauteste Stelle des Bildschirms. Auf
  // Zeigergeraeten bleiben die Knoepfe, dort gibt es keine Geste.
  return `
    <div class="swipe-row" data-swipe-id="${birthday.id}">
      <div class="swipe-reveal swipe-reveal--edit swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="pencil" class="icon-md"></i>
        <span>${t('common.edit')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="trash-2" class="icon-md"></i>
        <span>${t('common.delete')}</span>
      </div>
    <article class="list-row birthday-item ${isToday ? 'birthday-item--today' : ''}" data-id="${birthday.id}">
      <div class="birthday-item__media">${photoAvatar(birthday)}</div>
      <div class="list-row__main">
        <strong class="list-row__name birthday-item__name">
          ${esc(birthday.name)}${isToday ? CAKE_SVG : ''}
        </strong>
        <div class="list-row__meta birthday-item__meta${hasNameDay ? ' birthday-item__meta--with-name-day' : ''}">
          <span class="birthday-chip birthday-chip--${chip.mod}">${esc(chip.label)}</span>
          <span class="birthday-item__when">${esc(ageMeta(birthday))}</span>
          ${nameDayMeta}
          ${birthday.notes ? `<span class="birthday-item__notes">${esc(birthday.notes)}</span>` : ''}
        </div>
      </div>
      <div class="row-actions birthday-item__actions">
        <button class="row-action" type="button" data-action="edit" data-id="${birthday.id}" aria-label="${t('common.edit')}">
          <i data-lucide="pencil" aria-hidden="true"></i>
        </button>
        <button class="row-action row-action--danger" type="button" data-action="delete" data-id="${birthday.id}" aria-label="${t('common.delete')}">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>
      </div>
    </article>
    </div>`;
}

function emptyStateHtml() {
  // `cake` ist dasselbe Zeichen wie CAKE_SVG - das Inline-SVG oben ist die
  // Lucide-Torte, von Hand kopiert, damit sie neben einem Namen stehen kann.
  // Im Leerzustand nimmt der Renderer den Lucide-Namen direkt.
  if (state.query.trim()) {
    return sharedEmptyStateHTML({
      variant: 'no-results',
      icon: 'cake',
      title: t('search.noResults'),
    });
  }
  return sharedEmptyStateHTML({
    icon: 'cake',
    title: t('birthdays.emptyTitle'),
    description: t('birthdays.emptyDescription'),
    hint: t('emptyHint.birthdays'),
    action: { label: t('birthdays.addButton'), attrs: { id: 'birthdays-empty-cta' } },
  });
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
  wireBirthdaySwipe(host);
  maybeShowSwipeHint(host);
}

/**
 * Wischbedienung der Liste (Redesign Runde 4, C-2). Dieselben zwei Aktionen,
 * die auf Zeigergeräten als Knöpfe in der Zeile stehen - zum Zeilenanfang hin
 * wischen bearbeitet, zum Zeilenende hin löscht.
 *
 * Beide federn zurück, statt hinauszufliegen: das Bearbeiten öffnet nur einen
 * Dialog und die Zeile bleibt, und das Löschen ist über den geteilten
 * Rückgängig-Weg (`scheduleUndoableDelete`) fünf Sekunden lang widerrufbar -
 * eine hinausgeflogene Karte hätte behauptet, die Sache sei erledigt.
 */
function wireBirthdaySwipe(host) {
  wireSwipeRows(host, {
    card: '.birthday-item',
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => deleteBirthday(Number(row.dataset.swipeId)),
    },
    leading: {
      reveal: '.swipe-reveal--edit',
      run: (row) => {
        const birthday = state.birthdays.find((item) => item.id === Number(row.dataset.swipeId));
        if (birthday) openBirthdayModal({ mode: 'edit', birthday });
      },
    },
  });
}

function renderPage() {
  // Reference page for PAGE-COMPOSITION.md: geometry only via page-layout helpers.
  // Header and body sections share --layout-reading (PAGE-002).
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', renderAppPage({
    mode: 'reading',
    className: 'birthdays-page',
    legacyAlias: false,
    header: renderPageHeader({
      wrap: true,
      narrow: true,
      className: 'birthdays-toolbar',
      title: renderPageTitle(t('birthdays.title')),
      center: renderPageSearch({
        id: 'birthdays-search',
        label: t('birthdays.searchPlaceholder'),
        placeholder: t('birthdays.searchPlaceholder'),
        value: state.query,
        clearLabel: t('common.searchClear'),
        className: 'birthdays-toolbar__search page-toolbar__center',
      }),
      // Actions slot: Import + desktop-docked primary (dockFabIntoToolbar).
      // DER KNOPF LIEST AUS KONTAKTEN, NICHT AUS GEBURTSTAGEN. Wer `contacts`
      // nicht sehen darf, bekommt seit #1241 vom Server ein 403 - ohne diese
      // Zeile bliebe ein Knopf stehen, der nur noch eine Fehlermeldung
      // aufmacht. Die Durchsetzung bleibt serverseitig, das hier ist die
      // Anzeige dazu.
      actions: renderPageActions(moduleAccess('contacts') === 'none' ? '' : `
          <button class="btn btn--secondary birthdays-toolbar__import" id="birthdays-import-btn" type="button" aria-label="${t('birthdays.importButton')}">
            <i data-lucide="download" aria-hidden="true"></i><span>${t('birthdays.importButton')}</span>
          </button>`),
    }),
    body: renderPageBody({
      content: [
        renderPageSection({
          className: 'birthdays-hint-section',
          content: `<p class="birthdays-hint">${t('birthdays.calendarHint')}</p>`,
        }),
        renderListSection({
          className: 'birthdays-list-section',
          content: `<div class="row-carrier birthdays-list" id="birthdays-list"></div>`,
        }),
      ].join('\n'),
    }),
    trailing: `
      <button class="page-fab" id="fab-new-birthday" aria-label="${t('birthdays.addButton')}" data-dock-label="${t('newLabel.birthdays')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>`,
  }));

  renderList();
  if (window.lucide) window.lucide.createIcons({ el: _container });
}

function bindEvents() {
  findPageFab('fab-new-birthday').addEventListener('click', () => openBirthdayModal({ mode: 'create' }));
  _container.querySelector('#birthdays-import-btn')?.addEventListener('click', () => openImportModal());

  // Deep-Link aus dem Kontakt-Import („Zu Geburtstagen"): Kandidaten-Modal direkt
  // öffnen, statt den Nutzer den Import-Button selbst suchen zu lassen.
  try {
    if (sessionStorage.getItem('yuvomi:birthdays:autoImport')) {
      sessionStorage.removeItem('yuvomi:birthdays:autoImport');
      openImportModal();
    }
  } catch { /* sessionStorage evtl. nicht verfügbar */ }

  wirePageSearch(_container, {
    id: 'birthdays-search',
    delay: 0,
    onQuery: (value) => {
      state.query = value;
      renderList();
    },
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
      deleteBirthday(id);
    }
  });
}

function birthdayPreviewHtml(name, photoData) {
  if (photoData) return `<img class="birthday-preview__image" src="${photoData}" alt="${esc(name || '')}">`;
  return `<span class="birthday-preview__fallback">${esc(initials(name))}</span>`;
}

function openBirthdayModal({ mode, birthday = null }) {
  const isEdit = mode === 'edit';
  let photoData = birthday?.photo_data || null;
  const today = todayKey();

  openSharedModal({
    title: isEdit ? t('birthdays.editTitle') : t('birthdays.newTitle'),
    content: `
      <div class="birthday-modal">
        <div class="birthday-modal__identity">
          <div class="birthday-modal__photo-wrap">
            <button type="button" class="birthday-avatar-editor" id="birthday-preview" aria-label="${t('birthdays.photoLabel')}">
              ${birthdayPreviewHtml(birthday?.name || '', photoData)}
            </button>
            <input class="sr-only" id="bd-photo" type="file" accept="image/png,image/jpeg,image/webp">
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
              <yuvomi-datepicker id="bd-birth-date" type="date" max="${today}" value="${esc(birthday?.birth_date || '')}"></yuvomi-datepicker>
            </div>
          </div>
        </div>
        ${advancedSection(`
          ${renderNameDayField(birthday)}
          <div class="form-group">
            <label class="form-label" for="bd-notes">${t('birthdays.notesLabel')}</label>
            <textarea class="form-input" id="bd-notes" rows="3" placeholder="${t('birthdays.notesPlaceholder')}">${esc(birthday?.notes || '')}</textarea>
          </div>
          ${renderBirthdayReminderSection(birthday)}`,
          { open: isEdit && (!!birthday?.name_day || !!birthday?.notes || (!!birthday?.reminder_offset && birthday.reminder_offset !== '1440')) })}
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
        // Das Feld ist ein Transportmittel, kein Zustand - sofort leeren, wie
        // beim Kachelbild (`quick-links-manager.js`). Bleibt der Dateiname
        // stehen, feuert `change` beim nächsten Griff zu DERSELBEN Datei nicht
        // mehr, und „nochmal anders zuschneiden" täte gar nichts.
        e.target.value = '';
        try {
          const { pickCroppedImage } = await import('/utils/avatar-crop.js');
          const cropped = await pickCroppedImage(file);
          // Abgebrochener Zuschnitt: das bisherige Bild bleibt stehen.
          if (cropped === undefined) return;
          photoData = cropped;
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

      const nameDayMonth = panel.querySelector('#bd-name-day-month');
      const nameDayDay = panel.querySelector('#bd-name-day-day');
      const refreshNameDayDays = (preferredDay = '') => {
        if (!nameDayDay) return;
        const option = (value, label) => {
          const node = document.createElement('option');
          node.value = value;
          node.textContent = label;
          node.selected = value === preferredDay;
          return node;
        };
        const options = [option('', t('birthdays.nameDayDayPlaceholder'))];
        const dayCount = daysInNameDayMonth(nameDayMonth?.value);
        for (let day = 1; day <= dayCount; day++) {
          const value = String(day).padStart(2, '0');
          options.push(option(value, String(day)));
        }
        nameDayDay.replaceChildren(...options);
        nameDayDay.disabled = !nameDayMonth?.value;
      };
      nameDayMonth?.addEventListener('change', () => refreshNameDayDays(nameDayDay?.value));
      panel.querySelector('#bd-name-day-clear')?.addEventListener('click', () => {
        if (nameDayMonth) nameDayMonth.value = '';
        refreshNameDayDays();
        nameDayMonth?.focus();
      });

      panel.querySelector('#bd-cancel').addEventListener('click', closeModal);
      // Löschen verwirft die Eingaben ohnehin mit dem Datensatz: der Dirty-Guard
      // hätte hier erst nach dem Verwerfen von Feldern gefragt, die gleich mit
      // weggehen - zwei Rückfragen für eine Entscheidung (#625-Muster). Der
      // await hält das Löschen zurück, bis der Overlay-Slot wirklich frei ist;
      // das Shared-Modal kennt kein Stacking (siehe _suspendActiveModal).
      panel.querySelector('#bd-delete')?.addEventListener('click', async () => {
        await closeModal({ force: true });
        deleteBirthday(birthday.id);
      });
      panel.querySelector('#bd-save').addEventListener('click', async () => {
        const saveBtn = panel.querySelector('#bd-save');
        const birthDateRaw = panel.querySelector('#bd-birth-date').value;
        const birthDate = parseDateInput(birthDateRaw);
        const nameDay = normalizeNameDaySelection(nameDayMonth?.value, nameDayDay?.value);
        if (!nameDay.complete) {
          window.yuvomi?.showToast(t('birthdays.nameDayIncomplete'), 'warning');
          return;
        }
        const body = {
          name: panel.querySelector('#bd-name').value.trim(),
          birth_date: birthDate,
          name_day: nameDay.value,
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

function importCandidateRowHtml(c) {
  if (c.already_imported) {
    return `
      <div class="bd-import-row bd-import-row--done">
        <span class="bd-import-row__check" aria-hidden="true"><i data-lucide="check"></i></span>
        <span class="bd-import-row__name">${esc(c.name)}</span>
        <span class="bd-import-row__date">${esc(formatDate(c.birthday))}</span>
        <span class="bd-import-row__badge">${t('birthdays.importAlreadyAdded')}</span>
      </div>`;
  }
  return `
    <label class="bd-import-row">
      <input type="checkbox" value="${c.id}">
      <span class="bd-import-row__name">${esc(c.name)}</span>
      <span class="bd-import-row__date">${esc(formatDate(c.birthday))}</span>
    </label>`;
}

async function openImportModal() {
  let candidates;
  try {
    const res = await api.get('/birthdays/import/candidates');
    candidates = res.data;
  } catch (err) {
    window.yuvomi?.showToast(err.message, 'danger');
    return;
  }

  const withBirthday = candidates.withBirthday ?? [];
  const withoutBirthday = candidates.withoutBirthday ?? [];
  const hasCandidates = withBirthday.length > 0;

  const listHtml = hasCandidates
    ? `<div class="bd-import__list">${withBirthday.map(importCandidateRowHtml).join('')}</div>`
    : emptyHintHTML(t('birthdays.importEmpty'));

  const withoutHtml = withoutBirthday.length
    ? `<details class="bd-import__without">
         <summary>${t('birthdays.importNoBirthdaySection')} (${withoutBirthday.length})</summary>
         <p class="bd-import__without-hint">${t('birthdays.importNoBirthdayHint')}</p>
         <div class="bd-import__without-list">
           ${withoutBirthday.map((c) => `<span class="bd-import__without-name">${esc(c.name)}</span>`).join('')}
         </div>
       </details>`
    : '';

  openSharedModal({
    title: t('birthdays.importTitle'),
    size: 'md',
    content: `
      <div class="bd-import">
        <p class="bd-import__intro">${t('birthdays.importIntro')}</p>
        <span class="sr-only" role="status" aria-live="polite" id="bd-import-status"></span>
        ${listHtml}
        ${withoutHtml}
        <div class="bd-import__footer">
          <button class="btn btn--secondary" type="button" id="bd-import-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" type="button" id="bd-import-submit" disabled>${t('birthdays.importSubmit', { count: 0 })}</button>
        </div>
      </div>
    `,
    onSave(panel) {
      const submitBtn = panel.querySelector('#bd-import-submit');
      const status = panel.querySelector('#bd-import-status');
      const selectable = [...panel.querySelectorAll('.bd-import__list input:not(:disabled)')];

      const selectedIds = () =>
        selectable.filter((cb) => cb.checked).map((cb) => Number(cb.value));

      const refresh = (announce = false) => {
        const n = selectedIds().length;
        submitBtn.textContent = t('birthdays.importSubmit', { count: n });
        submitBtn.disabled = n === 0;
        // Nur bei echter Interaktion ansagen, nicht beim initialen Öffnen.
        if (announce && status) status.textContent = t('birthdays.importSelected', { count: n });
      };
      selectable.forEach((cb) => cb.addEventListener('change', () => refresh(true)));
      refresh();

      panel.querySelector('#bd-import-cancel').addEventListener('click', closeModal);

      submitBtn.addEventListener('click', async () => {
        const ids = selectedIds();
        if (ids.length === 0) {
          window.yuvomi?.showToast(t('birthdays.importNothingSelected'), 'warning');
          return;
        }
        submitBtn.disabled = true;
        try {
          const res = await api.post('/birthdays/import', { contact_ids: ids });
          window.yuvomi?.showToast(t('birthdays.importSuccess', { count: res.data.imported }), 'success');
          await loadData();
          renderList();
          closeModal({ force: true });
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
          submitBtn.disabled = false;
        }
      });
    },
  });
}

// Löschen mit Undo statt Bestätigungsdialog: ein Geburtstag ist ein Datum ohne
// Verlauf und hängt an nichts, was mitgelöscht würde. Damit folgt das Modul
// demselben Modell wie Notizen, Kontakte und Rezepte; die Vorab-Bestätigung
// bleibt nur, wo Löschen kaskadiert.
//
// scheduleUndoableDelete hält den Server-Delete bis zum Ablauf des Undo-
// Fensters zurück. Das frühere deleteWithUndo löschte sofort und stellte bei
// Undo nur den lokalen State wieder her — der Eintrag war serverseitig weg und
// verschwand beim nächsten Reload still.
function deleteBirthday(id) {
  const index = state.birthdays.findIndex((b) => b.id === id);
  if (index === -1) return;
  const birthday = state.birthdays[index];

  state.birthdays = state.birthdays.filter((b) => b.id !== id);
  updateBirthdayBadge();
  renderList();

  scheduleUndoableDelete({
    message: t('birthdays.deletedToast'),
    commit: ({ keepalive }) => api.delete(`/birthdays/${id}`, { keepalive }),
    restore: (err) => {
      state.birthdays = [
        ...state.birthdays.slice(0, index),
        birthday,
        ...state.birthdays.slice(index),
      ];
      updateBirthdayBadge();
      renderList();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
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
