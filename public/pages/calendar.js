/**
 * Modul: Kalender (Calendar)
 * Zweck: Monats-/Wochen-/Tages-/Agenda-Ansicht mit vollem Termin-CRUD
 * Abhängigkeiten: /api.js, /router.js (window.oikos)
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal } from '/components/modal.js';
import { stagger } from '/utils/ux.js';
import { t, formatDate as formatPreferredDate, formatTime, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput, timeInputPlaceholder } from '/i18n.js';
import { esc, fmtLocation } from '/utils/html.js';
import { refresh as refreshReminders } from '/reminders.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VIEWS      = ['month', 'week', 'day', 'agenda'];
const VIEW_LABELS = () => ({
  month: t('calendar.viewMonth'),
  week:  t('calendar.viewWeek'),
  day:   t('calendar.viewDay'),
  agenda: t('calendar.viewAgenda'),
});
const DAY_NAMES_SHORT = () => [
  t('calendar.dayShortSunday'), t('calendar.dayShortMonday'), t('calendar.dayShortTuesday'),
  t('calendar.dayShortWednesday'), t('calendar.dayShortThursday'), t('calendar.dayShortFriday'),
  t('calendar.dayShortSaturday'),
];
const DAY_NAMES_LONG  = () => [
  t('calendar.dayLongSunday'), t('calendar.dayLongMonday'), t('calendar.dayLongTuesday'),
  t('calendar.dayLongWednesday'), t('calendar.dayLongThursday'), t('calendar.dayLongFriday'),
  t('calendar.dayLongSaturday'),
];
const MONTH_NAMES     = () => [
  t('calendar.monthJanuary'), t('calendar.monthFebruary'), t('calendar.monthMarch'),
  t('calendar.monthApril'), t('calendar.monthMay'), t('calendar.monthJune'),
  t('calendar.monthJuly'), t('calendar.monthAugust'), t('calendar.monthSeptember'),
  t('calendar.monthOctober'), t('calendar.monthNovember'), t('calendar.monthDecember'),
];

const EVENT_COLORS = [
  '#007AFF', '#34C759', '#FF9500', '#FF3B30',
  '#AF52DE', '#FF6B35', '#5AC8FA', '#FFCC00',
  '#8E8E93', '#30B0C7',
];

const EVENT_COLOR_NAMES = () => ({
  '#007AFF': t('calendar.colorBlue'),
  '#34C759': t('calendar.colorGreen'),
  '#FF9500': t('calendar.colorOrange'),
  '#FF3B30': t('calendar.colorRed'),
  '#AF52DE': t('calendar.colorPurple'),
  '#FF6B35': t('calendar.colorCoral'),
  '#5AC8FA': t('calendar.colorSkyBlue'),
  '#FFCC00': t('calendar.colorYellow'),
  '#8E8E93': t('calendar.colorGray'),
  '#30B0C7': t('calendar.colorCyan'),
});

const EVENT_ICON_ALIASES = {
  drill: 'tooth',
};

const EVENT_ICON_CATEGORIES = () => [
  {
    key: 'general',
    label: t('calendar.iconCategoryGeneral'),
    icons: [
      { value: 'calendar', label: t('calendar.iconCalendar') },
      { value: 'alarm-clock', label: t('calendar.iconAlarm') },
      { value: 'clock', label: t('calendar.iconClock') },
      { value: 'bell', label: t('calendar.iconBell') },
      { value: 'map-pin', label: t('calendar.iconLocation') },
      { value: 'star', label: t('calendar.iconStar') },
      { value: 'flag', label: t('calendar.iconFlag') },
      { value: 'target', label: t('calendar.iconTarget') },
      { value: 'flame', label: t('calendar.iconFlame') },
    ],
  },
  {
    key: 'health',
    label: t('calendar.iconCategoryHealth'),
    icons: [
      { value: 'tooth', label: t('calendar.iconTooth') },
      { value: 'hospital', label: t('calendar.iconHospital') },
      { value: 'stethoscope', label: t('calendar.iconDoctor') },
      { value: 'syringe', label: t('calendar.iconVaccine') },
      { value: 'pill', label: t('calendar.iconMedicine') },
      { value: 'bandage', label: t('calendar.iconBandage') },
      { value: 'heart-pulse', label: t('calendar.iconHealth') },
      { value: 'activity', label: t('calendar.iconActivity') },
      { value: 'scissors', label: t('calendar.iconHaircut') },
      { value: 'dumbbell', label: t('calendar.iconSports') },
      { value: 'trophy', label: t('calendar.iconTrophy') },
    ],
  },
  {
    key: 'transport',
    label: t('calendar.iconCategoryTransport'),
    icons: [
      { value: 'car', label: t('calendar.iconCar') },
      { value: 'bus', label: t('calendar.iconBus') },
      { value: 'train', label: t('calendar.iconTrain') },
      { value: 'plane', label: t('calendar.iconPlane') },
      { value: 'plane-takeoff', label: t('calendar.iconFlight') },
      { value: 'fuel', label: t('calendar.iconFuel') },
      { value: 'navigation', label: t('calendar.iconNavigation') },
      { value: 'bike', label: t('calendar.iconBike') },
    ],
  },
  {
    key: 'work',
    label: t('calendar.iconCategoryWork'),
    icons: [
      { value: 'briefcase', label: t('calendar.iconWork') },
      { value: 'laptop', label: t('calendar.iconLaptop') },
      { value: 'presentation', label: t('calendar.iconPresentation') },
      { value: 'school', label: t('calendar.iconSchool') },
      { value: 'graduation-cap', label: t('calendar.iconEducation') },
      { value: 'book-open', label: t('calendar.iconReading') },
      { value: 'pencil', label: t('calendar.iconStudy') },
      { value: 'calculator', label: t('calendar.iconCalculator') },
    ],
  },
  {
    key: 'food',
    label: t('calendar.iconCategoryFood'),
    icons: [
      { value: 'utensils', label: t('calendar.iconMeal') },
      { value: 'cooking-pot', label: t('calendar.iconCooking') },
      { value: 'coffee', label: t('calendar.iconCoffee') },
      { value: 'cake', label: t('calendar.iconCake') },
      { value: 'pizza', label: t('calendar.iconPizza') },
      { value: 'wine', label: t('calendar.iconWine') },
      { value: 'beer', label: t('calendar.iconBeer') },
    ],
  },
  {
    key: 'shopping',
    label: t('calendar.iconCategoryShopping'),
    icons: [
      { value: 'shopping-bag', label: t('calendar.iconShopping') },
      { value: 'shopping-cart', label: t('calendar.iconGroceries') },
      { value: 'gift', label: t('calendar.iconGift') },
      { value: 'credit-card', label: t('calendar.iconCard') },
      { value: 'wallet', label: t('calendar.iconWallet') },
      { value: 'piggy-bank', label: t('calendar.iconSavings') },
      { value: 'landmark', label: t('calendar.iconBank') },
    ],
  },
  {
    key: 'leisure',
    label: t('calendar.iconCategoryLeisure'),
    icons: [
      { value: 'music', label: t('calendar.iconMusic') },
      { value: 'film', label: t('calendar.iconMovie') },
      { value: 'ticket', label: t('calendar.iconTicket') },
      { value: 'gamepad-2', label: t('calendar.iconGame') },
      { value: 'camera', label: t('calendar.iconPhoto') },
      { value: 'party-popper', label: t('calendar.iconParty') },
    ],
  },
  {
    key: 'family',
    label: t('calendar.iconCategoryFamily'),
    icons: [
      { value: 'users', label: t('calendar.iconFamily') },
      { value: 'baby', label: t('calendar.iconBaby') },
      { value: 'dog', label: t('calendar.iconDog') },
      { value: 'cat', label: t('calendar.iconCat') },
      { value: 'paw-print', label: t('calendar.iconPet') },
    ],
  },
  {
    key: 'home',
    label: t('calendar.iconCategoryHome'),
    icons: [
      { value: 'home', label: t('calendar.iconHome') },
      { value: 'building', label: t('calendar.iconBuilding') },
      { value: 'wrench', label: t('calendar.iconRepair') },
      { value: 'hammer', label: t('calendar.iconMaintenance') },
      { value: 'paintbrush', label: t('calendar.iconCleaning') },
      { value: 'sofa', label: t('calendar.iconFurniture') },
      { value: 'washing-machine', label: t('calendar.iconLaundry') },
    ],
  },
  {
    key: 'nature',
    label: t('calendar.iconCategoryNature'),
    icons: [
      { value: 'leaf', label: t('calendar.iconLeaf') },
      { value: 'tree-pine', label: t('calendar.iconTree') },
      { value: 'flower', label: t('calendar.iconFlower') },
      { value: 'sun', label: t('calendar.iconSun') },
      { value: 'moon', label: t('calendar.iconMoon') },
      { value: 'cloud-sun', label: t('calendar.iconWeather') },
    ],
  },
];

// Flache Liste aller Icons für Kompatibilität (z.B. eventIconName-Validierung)
const EVENT_ICONS = EVENT_ICON_CATEGORIES().flatMap((cat) => cat.icons);

const CUSTOM_EVENT_ICONS = new Set(['tooth']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CALENDAR_VIEW_STORAGE_KEY = 'oikos-calendar-view';

const HOUR_HEIGHT = 56; // px pro Stunde in Wochen-/Tagesansicht

function renderIconPickerResults(selectedIcon, query = '') {
  const q = query.trim().toLowerCase();
  if (q) {
    const filtered = EVENT_ICON_CATEGORIES()
      .flatMap((c) => c.icons)
      .filter((icon) => icon.label.toLowerCase().includes(q) || icon.value.includes(q));
    if (filtered.length === 0) {
      return `<div class="event-icon-picker__no-results">${esc(t('calendar.iconSearchEmpty'))}</div>`;
    }
    return `
      <div class="event-icon-picker__category-icons">
        ${filtered.map((icon) => iconPickerOptionHtml(icon, selectedIcon)).join('')}
      </div>`;
  }
  return EVENT_ICON_CATEGORIES().map((cat) => `
    <div class="event-icon-picker__category">
      <div class="event-icon-picker__category-label">${esc(cat.label)}</div>
      <div class="event-icon-picker__category-icons">
        ${cat.icons.map((icon) => iconPickerOptionHtml(icon, selectedIcon)).join('')}
      </div>
    </div>`).join('');
}

function iconPickerOptionHtml(icon, selectedIcon) {
  return `
    <button type="button"
            class="event-icon-picker__option ${selectedIcon === icon.value ? 'event-icon-picker__option--active' : ''}"
            data-icon="${icon.value}"
            role="radio"
            aria-checked="${selectedIcon === icon.value ? 'true' : 'false'}"
            aria-label="${esc(icon.label)}"
            title="${esc(icon.label)}">
      ${eventIconHtml(icon.value, 'event-icon-picker__option-icon')}
    </button>`;
}

function openIconPickerDialog(selectedIcon, onSelect, onClose = () => {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay event-icon-dialog';
  overlay.setAttribute('aria-modal', 'true');

  const panel = document.createElement('div');
  panel.className = 'modal-panel modal-panel--md event-icon-dialog__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('calendar.iconLabel'));
  panel.insertAdjacentHTML('beforeend', `
    <div class="modal-panel__header">
      <span class="modal-panel__title">${esc(t('calendar.iconLabel'))}</span>
      <button class="modal-panel__close btn--ghost" type="button" aria-label="${esc(t('common.close'))}">
        <i data-lucide="x" style="width:16px;height:16px;" aria-hidden="true"></i>
      </button>
    </div>
    <div class="modal-panel__body event-icon-dialog__body">
      <input type="search" class="form-input event-icon-picker__search" id="event-icon-dialog-search"
             placeholder="${esc(t('calendar.iconSearchPlaceholder'))}" autocomplete="off" aria-label="${esc(t('calendar.iconSearchPlaceholder'))}">
      <div class="event-icon-dialog__results" id="event-icon-dialog-results" role="radiogroup" aria-label="${esc(t('calendar.iconLabel'))}">
        ${renderIconPickerResults(selectedIcon)}
      </div>
    </div>
  `);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    onClose();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  panel.querySelector('.modal-panel__close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  panel.querySelector('#event-icon-dialog-search')?.addEventListener('input', (e) => {
    const results = panel.querySelector('#event-icon-dialog-results');
    results?.replaceChildren();
    results?.insertAdjacentHTML('beforeend', renderIconPickerResults(selectedIcon, e.target.value));
    if (window.lucide) lucide.createIcons({ el: results });
  });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.event-icon-picker__option');
    if (!btn) return;
    onSelect(btn.dataset.icon);
    close();
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKeydown);
  panel.querySelector('#event-icon-dialog-search')?.focus();
  if (window.lucide) lucide.createIcons({ el: panel });
}

/**
 * Gibt eine lesbare Textfarbe für eine Hintergrundfarbe zurück.
 * Helle Hintergründe (z.B. Hellgelb, Hellgrün) → dunkles Grau statt Weiß.
 */
function getContrastColor(hex) {
  if (!hex || hex.length < 7) return null;
  try {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.30 ? '#3D3D3D' : null; // null → CSS-Standard (weiß) bleibt
  } catch { return null; }
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  view:        'month',
  today:       '',
  cursor:      null,     // aktuell angezeigte Referenz-Datum (YYYY-MM-DD)
  events:      [],
  users:       [],
  rangeFrom:   '',
  rangeTo:     '',
};
let _container = null;

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function getSavedCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY);
    return VIEWS.includes(saved) ? saved : 'month';
  } catch {
    return 'month';
  }
}

function setSavedCalendarView(view) {
  if (!VIEWS.includes(view)) return;
  try {
    localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, view);
  } catch {}
}

// Extract YYYY-MM-DD in the browser's local timezone from any datetime string.
// For date-only strings (≤10 chars) slicing is safe; for datetime strings with an
// explicit UTC offset or 'Z' suffix, new Date() converts to local before extraction.
function localDate(str) {
  if (!str || str.length <= 10) return (str || '').slice(0, 10);
  const d = new Date(str);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Extract HH:MM in the browser's local timezone from a datetime string.
function localTime(str) {
  if (!str || str.length <= 10) return '00:00';
  const d = new Date(str);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return isoDate(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function getMondayOf(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return isoDate(d);
}

function formatDate(dateStr, { long = false, weekday = false } = {}) {
  if (weekday) {
    const d = new Date(dateStr + 'T00:00:00');
    const wd = long ? DAY_NAMES_LONG()[d.getDay()] : DAY_NAMES_SHORT()[d.getDay()];
    return `${wd}, ${formatPreferredDate(dateStr)}`;
  }
  return formatPreferredDate(dateStr);
}

function formatDateTime(datetimeStr) {
  if (!datetimeStr) return '';
  const date    = localDate(datetimeStr);
  const hasTime = datetimeStr.length > 10;
  const time    = hasTime ? formatTime(datetimeStr) : '';
  return time ? `${formatDate(date)} ${time} ${t('calendar.timeSuffix')}`.trimEnd() : formatDate(date);
}

function eventIconName(icon) {
  const normalized = EVENT_ICON_ALIASES[icon] || icon;
  return EVENT_ICONS.some((item) => item.value === normalized) ? normalized : 'calendar';
}

function customEventIconHtml(icon, className) {
  if (icon !== 'tooth') return '';
  return `<svg class="${className} event-icon--custom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8.5 3.5c1.2 0 2.1.5 3.5.5s2.3-.5 3.5-.5c2.4 0 4 1.8 4 4.4 0 2.2-1 4.2-1.7 5.7-.7 1.6-.8 3.1-1.1 4.7-.3 1.7-1.1 3.2-2.4 3.2-1.1 0-1.5-1.1-1.8-2.7-.2-1.2-.4-2.1-.5-2.1s-.3.9-.5 2.1c-.3 1.6-.7 2.7-1.8 2.7-1.3 0-2.1-1.5-2.4-3.2-.3-1.6-.4-3.1-1.1-4.7C5.5 12.1 4.5 10.1 4.5 7.9c0-2.6 1.6-4.4 4-4.4Z"/>
    <path d="M10 6.2c.7.3 1.3.5 2 .5s1.3-.2 2-.5"/>
  </svg>`;
}

function eventIconHtml(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  if (CUSTOM_EVENT_ICONS.has(name)) return customEventIconHtml(name, className);
  return `<i class="${className}" data-lucide="${name}" aria-hidden="true"></i>`;
}

function eventIconElement(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  if (name === 'tooth') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `${className} event-icon--custom`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.setAttribute('d', 'M8.5 3.5c1.2 0 2.1.5 3.5.5s2.3-.5 3.5-.5c2.4 0 4 1.8 4 4.4 0 2.2-1 4.2-1.7 5.7-.7 1.6-.8 3.1-1.1 4.7-.3 1.7-1.1 3.2-2.4 3.2-1.1 0-1.5-1.1-1.8-2.7-.2-1.2-.4-2.1-.5-2.1s-.3.9-.5 2.1c-.3 1.6-.7 2.7-1.8 2.7-1.3 0-2.1-1.5-2.4-3.2-.3-1.6-.4-3.1-1.1-4.7C5.5 12.1 4.5 10.1 4.5 7.9c0-2.6 1.6-4.4 4-4.4Z');

    const ridge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ridge.setAttribute('d', 'M10 6.2c.7.3 1.3.5 2 .5s1.3-.2 2-.5');

    svg.append(outline, ridge);
    return svg;
  }

  const el = document.createElement('i');
  el.className = className;
  el.dataset.lucide = name;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function isImageAttachment(mime) {
  return ATTACHMENT_IMAGE_MIME.has(String(mime || '').toLowerCase());
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('calendar.attachmentReadError')));
    reader.readAsDataURL(file);
  });
}

function attachmentDataUrl(data, mime) {
  const raw = String(data || '');
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  return mime ? `data:${mime};base64,${raw}` : raw;
}

function attachmentHtml(event) {
  if (!event?.attachment_data) return '';
  const name = esc(event.attachment_name || t('calendar.attachmentFallback'));
  const src = esc(attachmentDataUrl(event.attachment_data, event.attachment_mime));
  if (isImageAttachment(event.attachment_mime)) {
    return `
      <div class="event-popup__attachment event-popup__attachment--image">
        <img src="${src}" alt="${name}">
      </div>`;
  }
  return `
    <a class="event-popup__attachment event-popup__attachment--file" href="${src}" download="${name}">
      <i data-lucide="paperclip" aria-hidden="true"></i>
      <span>${name}</span>
    </a>`;
}

function truncateDescription(description, maxLength = 500) {
  const text = String(description || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)} (...)`;
}

function attachmentPreviewHtml(event) {
  if (!event?.attachment_data) return '';
  const name = esc(event.attachment_name || t('calendar.attachmentFallback'));
  const src = esc(attachmentDataUrl(event.attachment_data, event.attachment_mime));
  return isImageAttachment(event.attachment_mime)
    ? `<img src="${src}" alt="${name}">`
    : `<a href="${src}" download="${name}">${name}</a>`;
}

function selectedAttachmentLabel(name) {
  return t('documents.selectedFileLabel', { name: name || t('calendar.attachmentFallback') });
}

function bindDateInputs(root) {
  root.querySelectorAll('.js-date-input').forEach((input) => {
    input.addEventListener('blur', () => {
      const parsed = parseDateInput(input.value);
      if (parsed) input.value = formatDateInput(parsed);
    });
  });
}

function readDateInput(root, selector) {
  return parseDateInput(root.querySelector(selector)?.value || '');
}

function getMonthRange(dateStr) {
  const d     = new Date(dateStr + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth();
  const from  = `${year}-${pad(month + 1)}-01`;
  // Extra Tage für Kalenderraster (6 Wochen × 7 = 42 Tage)
  const to    = addDays(from, 41);
  return { from, to };
}

function getWeekRange(dateStr) {
  const monday = getMondayOf(dateStr);
  return { from: monday, to: addDays(monday, 6) };
}

function getAgendaRange(dateStr) {
  return { from: dateStr, to: addDays(dateStr, 30) };
}

function eventsOnDay(dateStr) {
  return state.events.filter((e) => {
    const start = localDate(e.start_datetime);
    const end   = e.end_datetime ? localDate(e.end_datetime) : start;
    return start <= dateStr && end >= dateStr;
  });
}

// --------------------------------------------------------
// API
// --------------------------------------------------------

async function loadRange(from, to) {
  try {
    const res      = await api.get(`/calendar?from=${from}&to=${to}`);
    state.events   = res.data;
  } catch (err) {
    console.error('[Calendar] loadRange Fehler:', err);
    state.events = [];
    window.oikos?.showToast(t('calendar.loadError'), 'danger');
  }
  state.rangeFrom = from;
  state.rangeTo   = to;
}

async function loadUsers() {
  try {
    const res   = await api.get('/auth/users');
    state.users = res.data;
  } catch {
    state.users = [];
  }
}

// --------------------------------------------------------
// Entry Point
// --------------------------------------------------------

export async function render(container, { user }) {
  _container = container;
  state.today  = isoDate(new Date());
  state.cursor = state.today;
  state.view   = getSavedCalendarView();

  container.innerHTML = `
    <div class="calendar-page" id="calendar-page">
      <div class="cal-toolbar" id="cal-toolbar"></div>
      <div id="cal-body" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>
      <button class="page-fab" id="fab-new-event" aria-label="${t('calendar.newEvent')}">
        <i data-lucide="plus" style="width:24px;height:24px" aria-hidden="true"></i>
      </button>
    </div>
  `;

  const { from, to } = getMonthRange(state.cursor);
  await Promise.all([loadRange(from, to), loadUsers()]);

  renderToolbar();
  renderView();

  container.querySelector('#fab-new-event')?.addEventListener('click', () => openEventModal({ mode: 'create' }));
}

// --------------------------------------------------------
// Toolbar
// --------------------------------------------------------

function renderToolbar() {
  const bar = _container.querySelector('#cal-toolbar');
  if (!bar) return;

  bar.innerHTML = `
    <h1 class="sr-only">${t('calendar.title')}</h1>
    <div class="cal-toolbar__nav">
      <button class="btn btn--icon" id="cal-prev" aria-label="${t('calendar.back')}">
        <i data-lucide="chevron-left" aria-hidden="true"></i>
      </button>
    </div>
    <button class="cal-toolbar__today" id="cal-today">${t('calendar.today')}</button>
    <span class="cal-toolbar__label" id="cal-label"></span>
    <div class="cal-toolbar__views">
      ${VIEWS.map((v) => `
        <button class="cal-toolbar__view-btn ${v === state.view ? 'cal-toolbar__view-btn--active' : ''}"
                data-view="${v}">${VIEW_LABELS()[v]}</button>
      `).join('')}
    </div>
    <button class="btn btn--primary btn--icon" id="cal-add" aria-label="${t('calendar.addEvent')}"
            style="margin-left:auto;">
      <i data-lucide="plus" aria-hidden="true"></i>
    </button>
    <div class="cal-toolbar__nav">
      <button class="btn btn--icon" id="cal-next" aria-label="${t('calendar.forward')}">
        <i data-lucide="chevron-right" aria-hidden="true"></i>
      </button>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  updateLabel();

  bar.querySelector('#cal-prev').addEventListener('click', () => navigate(-1));
  bar.querySelector('#cal-next').addEventListener('click', () => navigate(1));
  bar.querySelector('#cal-today').addEventListener('click', goToday);
  bar.querySelector('#cal-add').addEventListener('click', () => openEventModal({ mode: 'create' }));

  bar.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.view === state.view) return;
      state.view = btn.dataset.view;
      setSavedCalendarView(state.view);
      bar.querySelectorAll('[data-view]').forEach((b) =>
        b.classList.toggle('cal-toolbar__view-btn--active', b.dataset.view === state.view)
      );
      await reloadForView();
      renderView();
    });
  });
}

function updateLabel() {
  const lbl = _container.querySelector('#cal-label');
  if (!lbl) return;
  const d    = new Date(state.cursor + 'T00:00:00');
  const year = d.getFullYear();
  const mon  = MONTH_NAMES()[d.getMonth()];

  if (state.view === 'month')  lbl.textContent = `${mon} ${year}`;
  if (state.view === 'week')   lbl.textContent = t('calendar.weekNumberLabel', { week: getWeekNumber(state.cursor), month: mon, year });
  if (state.view === 'day')    lbl.textContent = formatDate(state.cursor, { weekday: true, long: true });
  if (state.view === 'agenda') lbl.textContent = t('calendar.agendaFrom', { date: formatDate(state.cursor) });
}

function getWeekNumber(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00');
  const jan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7);
}

async function navigate(dir) {
  if (state.view === 'month') {
    state.cursor = addMonths(state.cursor, dir);
  } else if (state.view === 'week') {
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    state.cursor = addDays(state.cursor, dir * (isMobile ? 3 : 7));
  } else if (state.view === 'day') {
    state.cursor = addDays(state.cursor, dir);
  } else if (state.view === 'agenda') {
    state.cursor = addDays(state.cursor, dir * 30);
  }
  await reloadForView();
  updateLabel();
  renderView();
}

async function goToday() {
  state.cursor = state.today;
  await reloadForView();
  updateLabel();
  renderView();
}

async function reloadForView() {
  let from, to;
  if (state.view === 'month')  ({ from, to } = getMonthRange(state.cursor));
  if (state.view === 'week')   ({ from, to } = getWeekRange(state.cursor));
  if (state.view === 'day')    { from = state.cursor; to = state.cursor; }
  if (state.view === 'agenda') ({ from, to } = getAgendaRange(state.cursor));

  if (from !== state.rangeFrom || to !== state.rangeTo) {
    await loadRange(from, to);
  }
}

// --------------------------------------------------------
// Ansicht-Dispatcher
// --------------------------------------------------------

function renderView() {
  const body = _container.querySelector('#cal-body');
  if (!body) return;
  body.innerHTML = '';

  if (state.view === 'month')  renderMonthView(body);
  if (state.view === 'week')   renderWeekView(body);
  if (state.view === 'day')    renderDayView(body);
  if (state.view === 'agenda') renderAgendaView(body);
  if (window.lucide) lucide.createIcons();
}

// --------------------------------------------------------
// Monatsansicht
// --------------------------------------------------------

function renderMonthView(container) {
  const d      = new Date(state.cursor + 'T00:00:00');
  const year   = d.getFullYear();
  const month  = d.getMonth();

  // Erster Tag des Monats
  const firstDay  = new Date(year, month, 1);
  // Montag-basiert: 0=Mo … 6=So
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  // 42 Tage anzeigen (6 Wochen)
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startOffset);

  const days = Array.from({ length: 42 }, (_, i) => {
    const dt = new Date(startDate);
    dt.setDate(startDate.getDate() + i);
    return { date: isoDate(dt), inMonth: dt.getMonth() === month };
  });

  container.innerHTML = `
    <div class="month-view">
      <div class="month-weekdays">
        ${[t('calendar.dayShortMonday'),t('calendar.dayShortTuesday'),t('calendar.dayShortWednesday'),t('calendar.dayShortThursday'),t('calendar.dayShortFriday'),t('calendar.dayShortSaturday'),t('calendar.dayShortSunday')].map((n) => `<div class="month-weekday">${n}</div>`).join('')}
      </div>
      <div class="month-grid" id="month-grid">
        ${days.map(({ date, inMonth }) => renderMonthDay(date, inMonth)).join('')}
      </div>
    </div>
  `;

  container.querySelector('#month-grid').addEventListener('click', (e) => {
    const evEl = e.target.closest('.month-day__event');
    if (evEl) {
      e.stopPropagation();
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const dayEl = e.target.closest('.month-day');
    if (dayEl) {
      openEventModal({ mode: 'create', date: dayEl.dataset.date });
    }
  });
}

function renderMonthDay(date, inMonth) {
  const evs      = eventsOnDay(date);
  const isToday  = date === state.today;
  const classes  = [
    'month-day',
    !inMonth ? 'month-day--outside' : '',
    isToday  ? 'month-day--today' : '',
  ].filter(Boolean).join(' ');

  const MAX_SHOW = 3;
  const shown    = evs.slice(0, MAX_SHOW);
  const extra    = evs.length - MAX_SHOW;

  const evHtml = shown.map((ev) => {
    const bg = ev.cal_color || ev.color;
    const fg = getContrastColor(bg);
    return `
    <div class="month-day__event"
         data-id="${ev.id}"
         style="background-color:${esc(bg)};${fg ? `color:${fg};` : ''}"
         title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}"
    >${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? '<i data-lucide="repeat" style="width:9px;height:9px;flex-shrink:0;opacity:0.7;margin-left:2px" aria-hidden="true"></i>' : ''}</div>
  `;
  }).join('');

  return `
    <div class="${classes}" data-date="${date}">
      <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
      ${evHtml}
      ${extra > 0 ? `<div class="month-day__more">${t('calendar.moreEvents', { count: extra })}</div>` : ''}
    </div>
  `;
}

// --------------------------------------------------------
// Wochenansicht
// --------------------------------------------------------

function renderWeekView(container) {
  const isMobile = window.matchMedia('(max-width: 639px)').matches;
  // Auf Mobile: 3-Tage-Fenster zentriert um state.cursor statt vollem Mo–So
  const days = isMobile
    ? Array.from({ length: 3 }, (_, i) => addDays(state.cursor, i - 1))
    : (() => {
        const monday = getMondayOf(state.cursor);
        return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
      })();
  const colCount = days.length;

  const alldayEvs = days.map((d) =>
    eventsOnDay(d).filter((e) => e.all_day || !e.start_datetime.includes('T'))
  );
  const timedEvs = days.map((d) =>
    eventsOnDay(d).filter((e) => !e.all_day && e.start_datetime.includes('T'))
  );
  const layouts = timedEvs.map((events) => layoutOverlaps(events));

  container.innerHTML = `
    <div class="week-view">
      <div class="week-view__header" id="week-header"
           style="display:grid;grid-template-columns:48px repeat(${colCount},1fr);">
        <div class="week-view__time-gutter"></div>
        ${days.map((d) => {
          const dt = new Date(d + 'T00:00:00');
          return `<div class="week-view__day-header">
            <div class="week-view__day-name">${DAY_NAMES_SHORT()[dt.getDay()]}</div>
            <div class="week-view__day-num ${d === state.today ? 'week-view__day-num--today' : ''}">${dt.getDate()}</div>
          </div>`;
        }).join('')}
      </div>
      <!-- Ganztägige Ereignisse -->
      <div class="allday-row" style="display:grid;grid-template-columns:48px repeat(${colCount},1fr);">
        <div style="width:48px;padding:2px;font-size:10px;color:var(--color-text-disabled);text-align:right;padding-right:4px;line-height:24px;">${t('calendar.allDayShort')}</div>
        ${days.map((d, i) => `
          <div class="allday-cell">
            ${alldayEvs[i].map((ev) => `
              <div class="allday-event" data-id="${ev.id}"
                   style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
                   title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <div class="week-view__scroll" id="week-scroll">
        <div class="week-view__body">
          <div class="week-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot" style="height:${HOUR_HEIGHT}px;">
                <span class="week-view__time-label">${h === 0 ? '' : `${pad(h)}:00`}</span>
              </div>
            `).join('')}
          </div>
          <div class="week-view__columns" id="week-cols"
               style="display:grid;grid-template-columns:repeat(${colCount},1fr);">
            ${days.map((d, i) => `
              <div class="week-view__col" data-date="${d}">
                ${Array.from({ length: 24 }, (_, h) => `
                  <div class="week-view__hour-line" style="top:${h * HOUR_HEIGHT}px;"></div>
                `).join('')}
                ${timedEvs[i].map((ev) => renderWeekEvent(ev, layouts[i].get(ev.id))).join('')}
                ${d === state.today ? `<div class="week-view__now-line" id="now-line" style="top:${nowTop()}px;"></div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  // Event-Delegation
  container.querySelector('#week-cols').addEventListener('click', (e) => {
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const col = e.target.closest('[data-date]');
    if (col) openEventModal({ mode: 'create', date: col.dataset.date });
  });

  container.querySelector('.allday-row').addEventListener('click', (e) => {
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });

  // Scrollen zu aktueller Zeit
  const scroll = container.querySelector('#week-scroll');
  if (scroll) {
    const h = new Date().getHours();
    scroll.scrollTop = Math.max(0, h * HOUR_HEIGHT - 80);
  }
}

function renderWeekEvent(ev, layout = null) {
  const { start, end } = timeRangeForEvent(ev);
  const duration = Math.max(end - start, 30);

  const top    = (start / 60) * HOUR_HEIGHT;
  const height = (duration / 60) * HOUR_HEIGHT - 2;
  const left = layout ? `calc(${(layout.colIndex / layout.totalCols) * 100}% + 2px)` : '2px';
  const width = layout ? `calc(${100 / layout.totalCols}% - 4px)` : 'auto';

  return `
    <div class="week-event" data-id="${ev.id}"
         style="top:${top}px;height:${height}px;left:${left};width:${width};${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}">
      <div class="week-event__title">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? '<i data-lucide="repeat" style="width:9px;height:9px;flex-shrink:0;opacity:0.7;margin-left:2px" aria-hidden="true"></i>' : ''}</div>
      <div class="week-event__time">${formatTime(ev.start_datetime)}${ev.end_datetime ? '–' + formatTime(ev.end_datetime) : ''}</div>
    </div>
  `;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

function nowTop() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (minutes / 60) * HOUR_HEIGHT;
}

function timeRangeForEvent(ev) {
  const start = timeToMinutes(localTime(ev.start_datetime));
  const end = ev.end_datetime
    ? timeToMinutes(localTime(ev.end_datetime))
    : start + 60;
  return {
    start,
    end: Math.max(end, start + 30),
  };
}

function layoutOverlaps(events) {
  const groups = [];
  const sorted = [...events].sort((a, b) => {
    const aRange = timeRangeForEvent(a);
    const bRange = timeRangeForEvent(b);
    return aRange.start - bRange.start || aRange.end - bRange.end;
  });

  let current = [];
  let currentEnd = -1;
  for (const ev of sorted) {
    const range = timeRangeForEvent(ev);
    if (!current.length || range.start < currentEnd) {
      current.push(ev);
      currentEnd = current.length === 1 ? range.end : Math.max(currentEnd, range.end);
    } else {
      groups.push(current);
      current = [ev];
      currentEnd = range.end;
    }
  }
  if (current.length) groups.push(current);

  const layout = new Map();
  for (const group of groups) {
    const columns = [];
    const placements = [];
    for (const ev of group) {
      const range = timeRangeForEvent(ev);
      let colIndex = columns.findIndex((end) => end <= range.start);
      if (colIndex === -1) {
        colIndex = columns.length;
        columns.push(range.end);
      } else {
        columns[colIndex] = range.end;
      }
      placements.push({ ev, colIndex });
    }
    const totalCols = Math.max(columns.length, 1);
    for (const placement of placements) {
      layout.set(placement.ev.id, {
        colIndex: placement.colIndex,
        totalCols,
      });
    }
  }
  return layout;
}

// --------------------------------------------------------
// Tagesansicht
// --------------------------------------------------------

function renderDayView(container) {
  const dt      = new Date(state.cursor + 'T00:00:00');
  const dayEvs  = eventsOnDay(state.cursor);
  const allday  = dayEvs.filter((e) => e.all_day || !e.start_datetime.includes('T'));
  const timed   = dayEvs.filter((e) => !e.all_day && e.start_datetime.includes('T'));
  const layout = layoutOverlaps(timed);

  container.innerHTML = `
    <div class="day-view">
      <div class="day-view__header">
        <div class="day-view__date-label">${formatDate(state.cursor, { weekday: true, long: true })}</div>
      </div>
      ${allday.length ? `
      <div class="allday-row" style="display:grid;grid-template-columns:48px 1fr;">
        <div style="padding:2px 4px 2px 0;font-size:10px;color:var(--color-text-disabled);text-align:right;line-height:24px;">${t('calendar.allDayShort')}</div>
        <div class="allday-cell">
          ${allday.map((ev) => `
            <div class="allday-event" data-id="${ev.id}"
                 style="${ev.cal_color || ev.color ? `background-color:${esc(ev.cal_color || ev.color)};` : ''}${getContrastColor(ev.cal_color || ev.color) ? `color:${getContrastColor(ev.cal_color || ev.color)};` : ''}"
                 title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>`).join('')}
        </div>
      </div>` : ''}
      <div class="day-view__scroll" id="day-scroll">
        <div class="day-view__body">
          <div class="day-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot" style="height:${HOUR_HEIGHT}px;">
                <span class="week-view__time-label">${h === 0 ? '' : `${pad(h)}:00`}</span>
              </div>
            `).join('')}
          </div>
          <div class="day-view__col" data-date="${state.cursor}" id="day-col">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__hour-line" style="top:${h * HOUR_HEIGHT}px;"></div>
            `).join('')}
            ${timed.map((ev) => renderWeekEvent(ev, layout.get(ev.id))).join('')}
            ${state.cursor === state.today ? `<div class="week-view__now-line" style="top:${nowTop()}px;"></div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#day-col').addEventListener('click', (e) => {
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    openEventModal({ mode: 'create', date: state.cursor });
  });

  const scroll = container.querySelector('#day-scroll');
  if (scroll) {
    const h = new Date().getHours();
    scroll.scrollTop = Math.max(0, h * HOUR_HEIGHT - 80);
  }
}

// --------------------------------------------------------
// Agenda-Ansicht
// --------------------------------------------------------

function renderAgendaView(container) {
  const { from, to } = getAgendaRange(state.cursor);
  const days = Array.from({ length: 31 }, (_, i) => addDays(from, i));

  const groups = days
    .map((d) => ({ date: d, events: eventsOnDay(d) }))
    .filter((g) => g.events.length > 0);

  container.innerHTML = `
    <div class="agenda-view" id="agenda-view">
      ${groups.length === 0
        ? `<div class="agenda-empty">${t('calendar.noEvents')}</div>`
        : groups.map(({ date, events }) => `
          <div class="agenda-day">
            <div class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
              <span class="agenda-day__date">${formatDate(date)}</span>
              <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
            </div>
            ${events.map((ev) => renderAgendaEvent(ev)).join('')}
          </div>
        `).join('')
      }
    </div>
  `;

  stagger(container.querySelectorAll('.agenda-event'));

  container.querySelector('#agenda-view').addEventListener('click', (e) => {
    const evEl = e.target.closest('.agenda-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });
}

function renderAgendaEvent(ev) {
  const timeStr = ev.all_day
    ? t('calendar.allDay')
    : formatTime(ev.start_datetime)
      + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${t('calendar.timeSuffix')}`.trimEnd() : ` ${t('calendar.timeSuffix')}`.trimEnd());

  const displayColor = ev.cal_color || ev.color;
  const assignedUsers = ev.assigned_users ?? [];
  return `
    <div class="agenda-event" data-id="${ev.id}">
      <div class="agenda-event__color" style="background-color:${esc(displayColor)};"></div>
      <div class="agenda-event__body">
        <div class="agenda-event__title">${eventIconHtml(ev.icon)}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? ' <i data-lucide="repeat" style="width:12px;height:12px;display:inline;vertical-align:middle;opacity:0.5" aria-hidden="true"></i>' : ''}</div>
        <div class="agenda-event__meta">
          <span>${timeStr}</span>
          ${ev.location ? `<span>📍 ${esc(fmtLocation(ev.location))}</span>` : ''}
          ${ev.cal_name ? `<span class="event-cal-label" style="--cal-color:${esc(displayColor)}">${esc(ev.cal_name)}</span>` : ''}
          ${assignedUsers.length ? `<span class="agenda-event__assigned">${renderAvatarStack(assignedUsers, { size: 20, maxVisible: 3 })}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

// --------------------------------------------------------
// Event-Popup (Detail-Ansicht bei Klick auf Termin)
// --------------------------------------------------------

function showEventPopup(ev, anchor) {
  document.querySelector('#event-popup')?.remove();

  const popup = document.createElement('div');
  popup.id        = 'event-popup';
  popup.className = 'event-popup';

  const timeStr = ev.all_day
    ? t('calendar.allDay')
    : formatDateTime(ev.start_datetime)
      + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)}${t('calendar.timeSuffix') ? ' ' + t('calendar.timeSuffix') : ''}`.trim() : '');

  const displayColor = ev.cal_color || ev.color;
  popup.insertAdjacentHTML('beforeend', `
    <div class="event-popup__color-bar" style="background-color:${esc(displayColor)};"></div>
    <div class="event-popup__title">${eventIconHtml(ev.icon)}<span>${esc(ev.title)}</span></div>
    <div class="event-popup__meta">
      ${ev.cal_name ? `<div><span class="event-cal-label" style="--cal-color:${esc(displayColor)}">${esc(ev.cal_name)}</span></div>` : ''}
      <div>${timeStr}</div>
      ${ev.location ? `<div>📍 ${esc(fmtLocation(ev.location))}</div>` : ''}
      ${ev.description ? `<div>${esc(truncateDescription(ev.description, 500))}</div>` : ''}
      ${ev.attachment_data ? attachmentHtml(ev) : ''}
      ${ev.assigned_name ? `<div>👤 ${esc(ev.assigned_name)}</div>` : ''}
    </div>
    <div class="event-popup__actions">
      <button class="btn btn--secondary" style="flex:1;" id="popup-edit">${t('calendar.popupEdit')}</button>
      <button class="btn btn--danger"    id="popup-delete">
        <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
      </button>
    </div>
  `);

  document.body.appendChild(popup);
  if (window.lucide) lucide.createIcons();

  if (ev.external_source === 'ics' && ev.user_modified === 1) {
    const resetLink = document.createElement('a');
    resetLink.href = '#';
    resetLink.className = 'event-popup__reset-link';
    resetLink.textContent = t('calendar.ics.reset');
    resetLink.style.cssText = 'display:block;text-align:center;font-size:var(--text-xs);color:var(--color-text-secondary);margin-top:var(--space-2);cursor:pointer;text-decoration:underline;';
    resetLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await api.post(`/calendar/${ev.id}/reset`, {});
        popup.remove();
        await reloadForView();
        window.oikos?.showToast(t('calendar.ics.resetToast'), 'success');
      } catch (err) {
        window.oikos?.showToast(err.message, 'danger');
      }
    });
    popup.querySelector('.event-popup__actions').before(resetLink);
  }

  // Positionierung: erst messen, dann im Viewport halten.
  const rect = anchor.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  const popupRect = popup.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const fitsBelow = rect.bottom + gap + popupRect.height <= viewportHeight - margin;
  const top = fitsBelow
    ? rect.bottom + gap
    : Math.max(margin, rect.top - gap - popupRect.height);
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, viewportWidth - popupRect.width - margin)
  );
  const maxTop = Math.max(margin, viewportHeight - popupRect.height - margin);
  popup.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`;
  popup.style.left = `${left}px`;

  popup.querySelector('#popup-edit').addEventListener('click', async () => {
    popup.remove();
    const reminder = await loadReminderForEvent(ev.id);
    openEventModal({ mode: 'edit', event: ev, reminder });
  });

  popup.querySelector('#popup-delete').addEventListener('click', async () => {
    popup.remove();
    await deleteEvent(ev.id);
  });

  // Schließen bei Klick außerhalb
  setTimeout(() => {
    document.addEventListener('click', function closePopup(e) {
      if (!popup.isConnected || !popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closePopup);
      }
    });
  }, 0);
}

// --------------------------------------------------------
// Reminder-Helfer für Kalender-Events
// --------------------------------------------------------

async function loadReminderForEvent(eventId) {
  try {
    const data = await api.get(`/reminders?entity_type=event&entity_id=${eventId}`);
    return data.data;
  } catch {
    return null;
  }
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

function reminderOffsetFromEvent(event, reminder) {
  if (!reminder || !event?.start_datetime) return '';
  const remindMs = new Date(reminder.remind_at).getTime();
  const startMs  = new Date(reminderStartValue(event.start_datetime)).getTime();
  const diffMin  = Math.round((startMs - remindMs) / 60000);
  const opts = [0, 15, 60, 1440, 2880, 10080, 20160];
  const match = opts.find((o) => o === diffMin);
  return match !== undefined ? String(match) : 'custom';
}

function customReminderFromEvent(event, reminder) {
  const fallback = { amount: 1, unit: 'days' };
  if (!reminder || !event?.start_datetime) return fallback;
  const diffMin = Math.max(0, Math.round(
    (new Date(reminderStartValue(event.start_datetime)).getTime() - new Date(reminder.remind_at).getTime()) / 60000
  ));
  if (diffMin % 10080 === 0 && diffMin >= 10080) return { amount: diffMin / 10080, unit: 'weeks' };
  if (diffMin % 1440 === 0 && diffMin >= 1440) return { amount: diffMin / 1440, unit: 'days' };
  if (diffMin % 60 === 0 && diffMin >= 60) return { amount: diffMin / 60, unit: 'hours' };
  return { amount: Math.max(diffMin, 1), unit: 'minutes' };
}

function customReminderMinutes(amount, unit) {
  const value = Math.max(parseInt(amount, 10) || 1, 1);
  if (unit === 'weeks') return value * 10080;
  if (unit === 'days') return value * 1440;
  if (unit === 'hours') return value * 60;
  return value;
}

function reminderStartValue(startDatetime) {
  return startDatetime?.includes('T') ? startDatetime : `${startDatetime}T09:00`;
}

function toLocalDateTimeString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderCalendarReminderSection(reminder = null, event = null) {
  const currentOffset = event ? reminderOffsetFromEvent(event, reminder) : '';
  const custom = customReminderFromEvent(event, reminder);
  return `
    <div class="reminder-section">
      <div class="form-group" style="margin:0">
        <label class="form-label" for="modal-reminder-offset">${t('reminders.offsetLabel')}</label>
        <select class="form-input" id="modal-reminder-offset" style="min-height:44px">
          ${REMINDER_OFFSETS().map((o) =>
            `<option value="${o.value}" ${currentOffset === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="modal-grid modal-grid--2 reminder-custom" id="modal-reminder-custom" ${currentOffset === 'custom' ? '' : 'hidden'}>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="modal-reminder-custom-amount">${t('reminders.customAmountLabel')}</label>
          <input class="form-input" type="number" id="modal-reminder-custom-amount" min="1" max="999" value="${custom.amount}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="modal-reminder-custom-unit">${t('reminders.customUnitLabel')}</label>
          <select class="form-input" id="modal-reminder-custom-unit">
            <option value="minutes" ${custom.unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
            <option value="hours" ${custom.unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
            <option value="days" ${custom.unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
            <option value="weeks" ${custom.unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
          </select>
        </div>
      </div>
    </div>`;
}

function bindTimeInputs(root) {
  root.querySelectorAll('.js-time-input').forEach((input) => {
    input.addEventListener('blur', () => {
      const parsed = parseTimeInput(input.value);
      if (parsed) input.value = formatTimeInput(parsed);
    });
  });
}

// --------------------------------------------------------
// CalDAV Target Helpers
// --------------------------------------------------------

async function loadCalDAVTargets(selectElement, currentEvent = null) {
  if (!selectElement) return;

  try {
    const accountsRes = await api.get('/calendar/caldav/accounts');
    const accounts = accountsRes.data || [];

    // Keep only the "local" option
    selectElement.replaceChildren();
    const localOption = document.createElement('option');
    localOption.value = '';
    localOption.textContent = t('calendar.caldavTargetLocal');
    selectElement.appendChild(localOption);

    // Load calendars for each account and build options
    for (const account of accounts) {
      try {
        const calendarsRes = await api.get(`/calendar/caldav/accounts/${account.id}/calendars`);
        const calendars = calendarsRes.data || [];
        const enabledCalendars = calendars.filter((cal) => cal.enabled);

        if (enabledCalendars.length === 0) continue;

        const optgroup = document.createElement('optgroup');
        optgroup.label = account.name;

        for (const calendar of enabledCalendars) {
          const option = document.createElement('option');
          option.value = `${account.id}|${calendar.url}`;
          option.textContent = calendar.display_name || calendar.url;
          optgroup.appendChild(option);
        }

        selectElement.appendChild(optgroup);
      } catch (err) {
        console.warn(`Failed to load calendars for account ${account.id}:`, err);
      }
    }

    // Pre-select current event's target if editing
    if (currentEvent?.target_caldav_account_id && currentEvent?.target_caldav_calendar_url) {
      const targetValue = `${currentEvent.target_caldav_account_id}|${currentEvent.target_caldav_calendar_url}`;
      selectElement.value = targetValue;
    }
  } catch (err) {
    console.warn('Failed to load CalDAV targets:', err);
  }
}

// --------------------------------------------------------
// Event-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

function openEventModal({ mode, event = null, date = null, reminder = null }) {
  const isEdit = mode === 'edit';
  const content = buildEventModalContent({ mode, event, date, reminder });

  openSharedModal({
    title: isEdit ? t('calendar.editEvent') : t('calendar.newEvent'),
    content,
    size: 'md',
    onSave(panel) {
      // RRULE-Events binden
      bindRRuleEvents(panel, 'event');
      bindUserMultiSelect(panel, 'cal_assigned');

      const selectedColor = isEdit ? (event?.color || EVENT_COLORS[0]) : EVENT_COLORS[0];

      // Farb-Auswahl: Auswahl + ARIA + Keyboard (Roving Tabindex)
      function selectSwatch(target) {
        panel.querySelectorAll('.color-swatch').forEach((s) => {
          s.classList.remove('color-swatch--active');
          s.setAttribute('aria-checked', 'false');
          s.setAttribute('tabindex', '-1');
        });
        target.classList.add('color-swatch--active');
        target.setAttribute('aria-checked', 'true');
        target.setAttribute('tabindex', '0');
      }
      panel.querySelectorAll('.color-swatch').forEach((sw) => {
        if (sw.dataset.color === selectedColor) selectSwatch(sw);
        sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
        sw.addEventListener('keydown', (e) => {
          const swatches = [...panel.querySelectorAll('.color-swatch')];
          const idx = swatches.indexOf(sw);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = swatches[(idx + 1) % swatches.length];
            selectSwatch(next); next.focus();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
            selectSwatch(prev); prev.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSwatch(sw);
          }
        });
      });

      // Ganztägig-Toggle
      const alldayCheck = panel.querySelector('#modal-allday');
      const timeFields  = panel.querySelector('#time-fields');
      const alldayFields = panel.querySelector('#allday-fields');
      alldayCheck.addEventListener('change', () => {
        if (alldayCheck.checked) { timeFields.style.display = 'none'; alldayFields.style.display = ''; }
        else                      { timeFields.style.display = '';     alldayFields.style.display = 'none'; }
      });
      if (isEdit && event?.all_day) { timeFields.style.display = 'none'; alldayFields.style.display = ''; }

      bindDateInputs(panel);
      bindTimeInputs(panel);

      const iconInput = panel.querySelector('#modal-icon');
      const iconTrigger = panel.querySelector('#modal-icon-trigger');
      const selectIcon = (icon) => {
        const nextIcon = eventIconName(icon);
        if (iconInput) iconInput.value = nextIcon;
        if (iconTrigger) {
          iconTrigger.dataset.icon = nextIcon;
          iconTrigger.replaceChildren(eventIconElement(nextIcon, 'event-icon-picker__trigger-icon'));
        }
        if (window.lucide) lucide.createIcons();
      };

      iconTrigger?.addEventListener('click', () => {
        iconTrigger.setAttribute('aria-expanded', 'true');
        openIconPickerDialog(iconInput?.value || 'calendar', (icon) => {
          selectIcon(icon);
          iconTrigger?.setAttribute('aria-expanded', 'false');
          iconTrigger?.focus();
        }, () => {
          iconTrigger?.setAttribute('aria-expanded', 'false');
          iconTrigger?.focus();
        });
      });

      const reminderOffset = panel.querySelector('#modal-reminder-offset');
      const reminderCustom = panel.querySelector('#modal-reminder-custom');
      const attachmentInput = panel.querySelector('#modal-attachment');
      const selectedAttachment = panel.querySelector('#modal-selected-attachment');
      const attachmentPreview = panel.querySelector('#modal-attachment-preview');
      const attachmentState = {
        name: event?.attachment_name || null,
        mime: event?.attachment_mime || null,
        size: event?.attachment_size || null,
        data: event?.attachment_data || null,
      };

      const syncSelectedAttachment = () => {
        if (!selectedAttachment) return;
        selectedAttachment.hidden = !attachmentState.name;
        selectedAttachment.textContent = attachmentState.name ? selectedAttachmentLabel(attachmentState.name) : '';
      };

      const syncAttachmentSelection = () => {
        if (!selectedAttachment) return;
        const file = attachmentInput.files?.[0];
        if (file) {
          selectedAttachment.hidden = false;
          selectedAttachment.textContent = selectedAttachmentLabel(file.name);
          if (attachmentPreview) {
            attachmentPreview.replaceChildren();
            attachmentPreview.hidden = true;
          }
          return;
        }
        syncSelectedAttachment();
      };

      attachmentInput?.addEventListener('change', syncAttachmentSelection);

      const attachmentDropzone = panel.querySelector('#modal-attachment-dropzone');
      if (attachmentDropzone && attachmentInput) {
        ['dragenter', 'dragover'].forEach((eventName) => {
          attachmentDropzone.addEventListener(eventName, (dropEvent) => {
            dropEvent.preventDefault();
            attachmentDropzone.classList.add('document-dropzone--active');
          });
        });
        ['dragleave', 'drop'].forEach((eventName) => {
          attachmentDropzone.addEventListener(eventName, (dropEvent) => {
            dropEvent.preventDefault();
            attachmentDropzone.classList.remove('document-dropzone--active');
          });
        });
        attachmentDropzone.addEventListener('drop', (dropEvent) => {
          const file = dropEvent.dataTransfer?.files?.[0];
          if (!file) return;
          const transfer = new DataTransfer();
          transfer.items.add(file);
          attachmentInput.files = transfer.files;
          syncAttachmentSelection();
        });
      }

      syncSelectedAttachment();
      reminderOffset?.addEventListener('change', () => {
        if (reminderCustom) reminderCustom.hidden = reminderOffset.value !== 'custom';
      });

      // Load CalDAV targets
      const caldavTargetSelect = panel.querySelector('#event-caldav-target');
      if (caldavTargetSelect) {
        loadCalDAVTargets(caldavTargetSelect, event);
      }

      panel.querySelector('#modal-cancel').addEventListener('click', closeModal);

      panel.querySelector('#modal-delete')?.addEventListener('click', async () => {
        closeModal({ force: true });
        await deleteEvent(event.id);
      });

      panel.querySelector('#modal-save').addEventListener('click', () => saveEvent(panel, mode, event?.id, reminder, attachmentState));
      if (window.lucide) lucide.createIcons();
    },
  });
}

function buildEventModalContent({ mode, event, date, reminder = null }) {
  const isEdit = mode === 'edit';
  const today  = date || state.today;

  const startDate = isEdit ? localDate(event.start_datetime) : today;
  const startTime = isEdit && event.start_datetime.length > 10
    ? localTime(event.start_datetime) : '09:00';
  const endDate   = isEdit && event.end_datetime ? localDate(event.end_datetime) : startDate;
  const endTime   = isEdit && event.end_datetime && event.end_datetime.length > 10
    ? localTime(event.end_datetime) : '10:00';
  const selectedIcon = eventIconName(isEdit ? event.icon : 'calendar');

  const selectedUserIds = isEdit
    ? (event.assigned_users?.map((u) => u.id) ?? (event.assigned_to ? [event.assigned_to] : []))
    : [];

  return `
    <div class="event-title-picker">
      <div class="form-group event-icon-picker">
        <label class="form-label" for="modal-icon-trigger">${t('calendar.iconLabel')}</label>
        <input type="hidden" id="modal-icon" value="${selectedIcon}">
        <button type="button"
                class="event-icon-picker__trigger"
                id="modal-icon-trigger"
                data-icon="${selectedIcon}"
                aria-haspopup="true"
                aria-expanded="false"
                aria-label="${t('calendar.iconLabel')}">
          ${eventIconHtml(selectedIcon, 'event-icon-picker__trigger-icon')}
        </button>
      </div>
      <div class="form-group event-title-picker__title">
        <label class="form-label" for="modal-title">${t('calendar.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
        <input type="text" class="form-input" id="modal-title"
               placeholder="${t('calendar.titlePlaceholder')}" value="${esc(isEdit ? event.title : '')}">
      </div>
    </div>
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" id="modal-allday" ${isEdit && event.all_day ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('calendar.allDayToggle')}</span>
      </label>
    </div>

    <div id="time-fields">
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-start-date">${t('calendar.startDateLabel')}</label>
          <input type="date" class="form-input" id="modal-start-date" value="${startDate}">
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-start-time">${t('calendar.startTimeLabel')}</label>
          <input type="text" class="form-input js-time-input" id="modal-start-time" value="${formatTimeInput(startTime)}" placeholder="${timeInputPlaceholder()}">
        </div>
      </div>
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-end-date">${t('calendar.endDateLabel')}</label>
          <input type="date" class="form-input" id="modal-end-date" value="${endDate}">
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-end-time">${t('calendar.endTimeLabel')}</label>
          <input type="text" class="form-input js-time-input" id="modal-end-time" value="${formatTimeInput(endTime)}" placeholder="${timeInputPlaceholder()}">
        </div>
      </div>
    </div>

    <div id="allday-fields" style="display:none;">
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-allday-start">${t('calendar.fromLabel')}</label>
          <input type="date" class="form-input" id="modal-allday-start" value="${startDate}">
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-allday-end">${t('calendar.toLabel')}</label>
          <input type="date" class="form-input" id="modal-allday-end" value="${endDate}">
        </div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-location">${t('calendar.locationLabel')}</label>
      <input type="text" class="form-input" id="modal-location"
             placeholder="${t('calendar.locationPlaceholder')}" value="${esc(isEdit && event.location ? event.location : '')}">
    </div>

    <div class="form-group">
      ${renderUserMultiSelect(state.users, selectedUserIds, 'cal_assigned', 'calendar.assignedLabel')}
    </div>

    <div class="form-group">
      <label class="form-label" id="event-color-label">${t('calendar.colorLabel')}</label>
      <div class="color-picker" role="radiogroup" aria-labelledby="event-color-label">
        ${EVENT_COLORS.map((c, i) => `
          <div class="color-swatch" data-color="${c}" style="background-color:${c};"
               role="radio"
               tabindex="${i === 0 ? '0' : '-1'}"
               aria-checked="false"
               aria-label="${EVENT_COLOR_NAMES()[c] ?? c}"></div>
        `).join('')}
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="event-caldav-target">${t('calendar.caldavTargetLabel')}</label>
      <select class="form-input" id="event-caldav-target">
        <option value="">${t('calendar.caldavTargetLocal')}</option>
      </select>
      <small class="form-hint">${t('calendar.caldavTargetHint')}</small>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-description">${t('calendar.descriptionLabel')}</label>
      <textarea class="form-input" id="modal-description" rows="2"
                placeholder="${t('calendar.descriptionPlaceholder')}">${esc(isEdit && event.description ? event.description : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-attachment">${t('calendar.attachmentLabel')}</label>
      <label class="document-dropzone" id="modal-attachment-dropzone" for="modal-attachment">
        <input class="sr-only" id="modal-attachment" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <span class="document-dropzone__icon">
          <i data-lucide="file-up" aria-hidden="true"></i>
        </span>
        <span class="document-dropzone__title">${t('documents.dropzoneTitle')}</span>
        <span class="document-dropzone__hint">${t('documents.dropzoneHint')}</span>
        <span class="document-dropzone__file" id="modal-selected-attachment" ${isEdit && event.attachment_name ? '' : 'hidden'}>
          ${isEdit && event.attachment_name ? esc(selectedAttachmentLabel(event.attachment_name)) : ''}
        </span>
      </label>
      <div class="form-help">${t('calendar.attachmentHint')}</div>
      <div class="event-attachment-preview" id="modal-attachment-preview" ${isEdit && event.attachment_data ? '' : 'hidden'}>
        ${isEdit && event.attachment_data ? attachmentPreviewHtml(event) : ''}
      </div>
    </div>

    ${renderRRuleFields('event', isEdit ? event.recurrence_rule : null)}

    ${renderCalendarReminderSection(reminder, event)}

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      ${isEdit ? `<button class="btn btn--danger btn--icon" id="modal-delete" aria-label="${t('calendar.deleteEvent')}">
        <i data-lucide="trash-2" style="width:16px;height:16px;" aria-hidden="true"></i>
      </button>` : '<div></div>'}
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="modal-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;
}

async function saveEvent(overlay, mode, eventId, existingReminder = null, attachmentState = null) {
  const saveBtn = overlay.querySelector('#modal-save');
  const title   = overlay.querySelector('#modal-title').value.trim();

  if (!title) {
    window.oikos?.showToast(t('calendar.titleRequired'), 'error');
    return;
  }

  const allday  = overlay.querySelector('#modal-allday').checked;
  const color   = overlay.querySelector('.color-swatch--active')?.dataset.color || EVENT_COLORS[0];
  const icon    = eventIconName(overlay.querySelector('#modal-icon')?.value);
  const location    = overlay.querySelector('#modal-location').value.trim() || null;
  const assigned_to = getSelectedUserIds(overlay, 'cal_assigned');
  const description = overlay.querySelector('#modal-description').value.trim() || null;

  let start_datetime, end_datetime;

  if (allday) {
    start_datetime = readDateInput(overlay, '#modal-allday-start')
                   || readDateInput(overlay, '#modal-start-date');
    end_datetime   = readDateInput(overlay, '#modal-allday-end')
                   || readDateInput(overlay, '#modal-end-date');
    end_datetime   = end_datetime || null;
  } else {
    const sd = readDateInput(overlay, '#modal-start-date');
    const stRaw = overlay.querySelector('#modal-start-time').value;
    const st = parseTimeInput(stRaw);
    const ed = readDateInput(overlay, '#modal-end-date');
    const etRaw = overlay.querySelector('#modal-end-time').value;
    const et = parseTimeInput(etRaw);
    if ((stRaw && !st) || (etRaw && !et)) {
      window.oikos?.showToast(t('calendar.invalidDate'), 'error');
      return;
    }
    start_datetime = st ? `${sd}T${st}` : sd;
    end_datetime   = ed ? (et ? `${ed}T${et}` : ed) : null;
  }

  const visibleDateFields = allday
    ? ['#modal-allday-start', '#modal-allday-end']
    : ['#modal-start-date', '#modal-end-date'];
  const hasInvalidDate = visibleDateFields.some((selector) => !isDateInputValid(overlay.querySelector(selector)?.value));
  if (!start_datetime || hasInvalidDate) {
    window.oikos?.showToast(t('calendar.invalidDate'), 'error');
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const rrule = getRRuleValues(overlay, 'event');
    if (!rrule.valid_until) {
      window.oikos?.showToast(t('calendar.invalidDate'), 'error');
      saveBtn.disabled    = false;
      saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
      return;
    }
    const attachmentPayload = {
      name: attachmentState?.name || null,
      mime: attachmentState?.mime || null,
      size: attachmentState?.size || null,
      data: attachmentState?.data || null,
    };
    const attachmentFile = overlay.querySelector('#modal-attachment')?.files?.[0];
    if (attachmentFile) {
      if (attachmentFile.size > MAX_ATTACHMENT_BYTES) throw new Error(t('calendar.attachmentTooLarge'));
      attachmentPayload.name = attachmentFile.name;
      attachmentPayload.mime = attachmentFile.type || 'application/octet-stream';
      attachmentPayload.size = attachmentFile.size;
      attachmentPayload.data = await readFileAsDataUrl(attachmentFile);
    }

    // Extract CalDAV target
    const caldavTargetValue = overlay.querySelector('#event-caldav-target')?.value || '';
    let target_caldav_account_id = null;
    let target_caldav_calendar_url = null;

    if (caldavTargetValue) {
      const [accountId, calendarUrl] = caldavTargetValue.split('|');
      if (accountId && calendarUrl) {
        target_caldav_account_id = parseInt(accountId, 10);
        target_caldav_calendar_url = calendarUrl;
      }
    }

    const body = {
      title, description, start_datetime, end_datetime,
      all_day: allday ? 1 : 0,
      location, color, icon, assigned_to,
      recurrence_rule: rrule.recurrence_rule,
      attachment_name: attachmentPayload.name,
      attachment_mime: attachmentPayload.mime,
      attachment_size: attachmentPayload.size,
      attachment_data: attachmentPayload.data,
      document_folder_name: t('documents.calendarItemsFolder'),
      document_name: attachmentPayload.name
        ? t('calendar.attachmentDocumentName', { title, name: attachmentPayload.name })
        : null,
      document_description: attachmentPayload.name
        ? t('calendar.attachmentDocumentDescription', { title })
        : null,
      target_caldav_account_id,
      target_caldav_calendar_url,
    };

    let savedEventId = eventId;
    if (mode === 'create') {
      const res = await api.post('/calendar', body);
      state.events.push(res.data);
      savedEventId = res.data?.id;
    } else {
      const res = await api.put(`/calendar/${eventId}`, body);
      const idx = state.events.findIndex((e) => e.id === eventId);
      if (idx !== -1) state.events[idx] = res.data;
    }

    // Erinnerung speichern oder löschen
    if (savedEventId) {
      const offsetSel = overlay.querySelector('#modal-reminder-offset');
      const offsetVal = offsetSel?.value;

      if (offsetVal !== '' && offsetVal !== undefined) {
        // Remind-Zeitpunkt = start_datetime - offset (in Minuten)
        const startMs  = new Date(reminderStartValue(start_datetime)).getTime();
        const offsetMinutes = offsetVal === 'custom'
          ? customReminderMinutes(
              overlay.querySelector('#modal-reminder-custom-amount')?.value,
              overlay.querySelector('#modal-reminder-custom-unit')?.value
            )
          : parseInt(offsetVal, 10);
        const remindAt = toLocalDateTimeString(new Date(startMs - offsetMinutes * 60000));
        await api.post('/reminders', { entity_type: 'event', entity_id: savedEventId, remind_at: remindAt });
        refreshReminders();
      } else {
        api.delete(`/reminders?entity_type=event&entity_id=${savedEventId}`).catch(() => {});
        refreshReminders();
      }
    }

    closeModal({ force: true });
    renderView();
    window.oikos?.showToast(mode === 'create' ? t('calendar.createdToast') : t('calendar.savedToast'), 'success');
  } catch (err) {
    window.oikos?.showToast(err.data?.error ?? err.message ?? t('calendar.saveError'), 'error');
    saveBtn.disabled    = false;
    saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
  }
}

async function deleteEvent(id) {
  const event = state.events.find((e) => e.id === id);
  state.events = state.events.filter((e) => e.id !== id);
  renderView();

  let undone = false;
  window.oikos?.showToast(t('calendar.deletedToast'), 'default', 5000, () => {
    undone = true;
    if (event) {
      state.events = [...state.events, event];
      renderView();
    }
  });

  setTimeout(async () => {
    if (undone) return;
    try {
      await api.delete(`/calendar/${id}`);
      api.delete(`/reminders?entity_type=event&entity_id=${id}`).catch(() => {});
      refreshReminders();
    } catch (err) {
      if (event) {
        state.events = [...state.events, event];
        renderView();
      }
      window.oikos?.showToast(err.data?.error ?? t('calendar.deleteError'), 'danger');
    }
  }, 5000);
}
