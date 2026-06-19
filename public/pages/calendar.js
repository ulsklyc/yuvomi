/**
 * Modul: Kalender (Calendar)
 * Zweck: Monats-/Wochen-/Tages-/Agenda-Ansicht mit vollem Termin-CRUD
 * Abhängigkeiten: /api.js, /router.js (window.oikos)
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, advancedSection } from '/components/modal.js';
import { stagger } from '/utils/ux.js';
import { t, formatDate as formatPreferredDate, formatTime, dateInputPlaceholder, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput, timeInputPlaceholder } from '/i18n.js';
import { esc, fmtLocation } from '/utils/html.js';
import { shiftEndDateKey, isEndBeforeStart } from '/utils/date.js';
import { getReadableTextColor } from '/utils/color.js';
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
const CALENDAR_VIEW_STORAGE_KEY = 'oikos:calendar:view';
const LEGACY_CALENDAR_VIEW_STORAGE_KEY = 'oikos-calendar-view';
const LAYER_HOLIDAYS_KEY = 'oikos:calendar:layer:holidays';
const LAYER_SCHOOL_KEY   = 'oikos:calendar:layer:school';

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
        <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
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
// Farbberechnung: Assignee-Farben haben Vorrang
// Hierarchie: Assignees → manuelle Event-Farbe → Kalenderfarbe → Grau
// --------------------------------------------------------

/** Neutrale Fallback-Farbe wenn weder Assignee noch manuelle Farbe gesetzt. */
const FALLBACK_COLOR = '#8E8E93';

/**
 * Gibt die primäre Einzelfarbe eines Events zurück.
 * Wird für Textkontrastberechnung und Stellen genutzt, die keine Gradienten unterstützen.
 * Priorität: 1. erster Assignee, 2. ev.color, 3. ev.cal_color, 4. Grau.
 */
function resolveEventColor(ev) {
  const assignees = ev.assigned_users ?? [];
  if (assignees.length > 0) return assignees[0].color || FALLBACK_COLOR;
  return ev.color || ev.cal_color || FALLBACK_COLOR;
}

/**
 * Gibt einen CSS-Farbwert oder einen CSS-Gradienten zurück.
 * - Kein Assignee → manuelle Event-Farbe → Kalenderfarbe → Grau (immer einfarbig)
 * - 1 Assignee → dessen Avatar-Farbe
 * - N Assignees → diagonaler Gradient aller Avatar-Farben (135°, gleichmäßig aufgeteilt)
 */
function resolveEventBackground(ev) {
  const assignees = ev.assigned_users ?? [];
  if (assignees.length === 0) return ev.color || ev.cal_color || FALLBACK_COLOR;
  if (assignees.length === 1) return assignees[0].color || FALLBACK_COLOR;
  const colors = assignees.map((u) => u.color || FALLBACK_COLOR);
  const step = 100 / colors.length;
  const stops = colors.flatMap((c, i) => [
    `${c} ${i * step}%`,
    `${c} ${(i + 1) * step}%`,
  ]);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  view:          'month',
  today:         '',
  cursor:        null,     // aktuell angezeigte Referenz-Datum (YYYY-MM-DD)
  events:        [],
  tasks:         [],       // Aufgaben mit due_date für Kalender-Anzeige
  users:         [],
  rangeFrom:     '',
  rangeTo:       '',
  holidays:      [],       // cached entries from holiday_cache
  holidayPrefs:  {},       // subset of /preferences
  documentUploadBackend: 'local',
  layerHolidays: true,     // toggle for public holiday layer
  layerSchool:   true,     // toggle for school holiday layer
};
let _container = null;

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function normalizeCalendarView(view, fallback = 'month') {
  return VIEWS.includes(view) ? view : fallback;
}

function defaultCalendarViewFromState({ savedView = null, isMobile = false } = {}) {
  return normalizeCalendarView(savedView, isMobile ? 'agenda' : 'month');
}

function defaultCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_CALENDAR_VIEW_STORAGE_KEY);
    const isMobile = window.matchMedia?.('(max-width: 767px)').matches ?? false;
    return defaultCalendarViewFromState({ savedView: saved, isMobile });
  } catch {
    return defaultCalendarViewFromState();
  }
}

function setSavedCalendarView(view) {
  if (!VIEWS.includes(view)) return;
  try {
    localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, view);
  } catch {}
}

function getRangeForView(view, cursor) {
  if (view === 'month') return getMonthRange(cursor);
  if (view === 'week') return getWeekRange(cursor);
  if (view === 'day') return { from: cursor, to: cursor };
  if (view === 'agenda') return getAgendaRange(cursor);
  return getMonthRange(cursor);
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

function calendarMetaIconHtml(icon) {
  return `<i data-lucide="${icon}" class="calendar-meta-icon icon-sm" aria-hidden="true"></i>`;
}

function calendarRepeatIconHtml() {
  return '<i data-lucide="repeat" class="calendar-repeat-icon icon-xs" aria-hidden="true"></i>';
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

function hasAttachment(event) {
  return Boolean(event?.attachment_document_id || event?.attachment_data);
}

function attachmentUrls(event) {
  const legacyUrl = attachmentDataUrl(event?.attachment_data, event?.attachment_mime);
  return {
    preview: event?.attachment_preview_url || legacyUrl,
    download: event?.attachment_download_url || legacyUrl,
  };
}

function attachmentHtml(event) {
  if (!hasAttachment(event)) return '';
  const name = esc(event.attachment_name || t('calendar.attachmentFallback'));
  const urls = attachmentUrls(event);
  if (isImageAttachment(event.attachment_mime)) {
    return `
      <div class="event-popup__attachment event-popup__attachment--image">
        <img src="${esc(urls.preview)}" alt="${name}">
      </div>`;
  }
  return `
    <a class="event-popup__attachment event-popup__attachment--file" href="${esc(urls.download)}" download="${name}">
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
  if (!hasAttachment(event)) return '';
  const name = esc(event.attachment_name || t('calendar.attachmentFallback'));
  const urls = attachmentUrls(event);
  return isImageAttachment(event.attachment_mime)
    ? `<img src="${esc(urls.preview)}" alt="${name}">`
    : `<a href="${esc(urls.download)}" download="${name}">${name}</a>`;
}

function selectedAttachmentLabel(name) {
  return t('documents.selectedFileLabel', { name: name || t('calendar.attachmentFallback') });
}

function bindDateInputs(root) {
  root.querySelectorAll('.js-date-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      if (!/[\d./\-]/.test(e.key)) e.preventDefault();
    });
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
  // Start des Monats, dann bis auf den Montag zurückgehen (Kalenderraster)
  const firstOfMonth = new Date(year, month, 1);
  let startOffset = firstOfMonth.getDay() - 1; // Montag = 0
  if (startOffset < 0) startOffset = 6;        // Sonntag → 6
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - startOffset);
  const from = isoDate(gridStart);
  // 42 Tage (6 Wochen) abdecken
  const to   = addDays(from, 41);
  return { from, to };
}

function getWeekRange(dateStr) {
  const monday = getMondayOf(dateStr);
  return { from: monday, to: addDays(monday, 6) };
}

function getAgendaRange(dateStr) {
  return { from: dateStr, to: addDays(dateStr, 30) };
}

// Per-Render-Pass Day-Buckets. Vermeidet, dass jede der 42 Monats-Zellen die
// komplette state.events/state.tasks-Liste neu filtert und pro Event ein neues
// Date parst (O(Zellen × Events) → O(Events + Zellen)).
// _dayIndex.active signalisiert, dass die Maps für die aktuelle Render-Phase
// gültig sind; ansonsten fallen die Helfer auf direktes Filtern zurück.
const _dayIndex = {
  active:  false,
  events:  new Map(), // isoDate -> Event[]
  tasks:   new Map(), // isoDate -> Task[]
};

/**
 * Baut die Tages-Buckets für Events und Tasks einmal pro Render-Durchlauf.
 * Jedes Datum wird genau einmal geparst; mehrtägige Events werden in jeden
 * Tag ihres Bereichs (geklammert auf das geladene Fenster) einsortiert.
 */
function buildDayIndex() {
  const evMap = new Map();
  // Events in Originalreihenfolge durchlaufen, damit pro Tag die Reihenfolge
  // identisch zum bisherigen .filter()-Verhalten bleibt.
  const lo = state.rangeFrom || '';
  const hi = state.rangeTo   || '';
  for (const e of state.events) {
    const start = localDate(e.start_datetime);
    const end   = e.end_datetime ? localDate(e.end_datetime) : start;
    // Auf das geladene Fenster klammern, damit mehrtägige/fehlerhafte Events
    // keinen unbegrenzten Bereich erzeugen.
    let from = lo && start < lo ? lo : start;
    const to = hi && end > hi ? hi : end;
    if (from > to) continue;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const bucket = evMap.get(day);
      if (bucket) bucket.push(e);
      else evMap.set(day, [e]);
    }
  }

  const taskMap = new Map();
  for (const t of state.tasks) {
    if (!t.due_date) continue;
    const bucket = taskMap.get(t.due_date);
    if (bucket) bucket.push(t);
    else taskMap.set(t.due_date, [t]);
  }

  _dayIndex.events = evMap;
  _dayIndex.tasks  = taskMap;
  _dayIndex.active = true;
}

function eventsOnDay(dateStr) {
  if (_dayIndex.active) return _dayIndex.events.get(dateStr) ?? [];
  return state.events.filter((e) => {
    const start = localDate(e.start_datetime);
    const end   = e.end_datetime ? localDate(e.end_datetime) : start;
    return start <= dateStr && end >= dateStr;
  });
}

/** True, wenn Start- und Enddatum auf verschiedene Kalendertage fallen. */
function isMultiDayEvent(ev) {
  if (!ev || !ev.start_datetime || !ev.end_datetime) return false;
  return localDate(ev.start_datetime) !== localDate(ev.end_datetime);
}

/**
 * Events, die in der Ganztags-Zeile statt im Zeitraster gezeigt werden:
 * echte Ganztags-Events, datums-only Events und mehrtägige Zeit-Events.
 * Mehrtägige Events erscheinen dadurch als durchgehender Balken über alle Tage,
 * statt auf jedem Tag fälschlich als identischer Zeitblock (#225).
 */
function isAllDayLike(ev) {
  return !!ev.all_day || !ev.start_datetime.includes('T') || isMultiDayEvent(ev);
}

/**
 * Einordnung eines Events für einen bestimmten Tag in der Agenda:
 *   'all-day' | 'single' | 'start' | 'middle' | 'end'.
 * Mehrtägige Events liefern je nach Tag start/middle/end, damit die Uhrzeit den
 * durchgehenden Zeitraum widerspiegelt statt auf jedem Tag start–end (#225).
 */
function agendaSegmentKind(ev, dayStr) {
  if (ev.all_day || !ev.start_datetime.includes('T')) return 'all-day';
  if (!isMultiDayEvent(ev)) return 'single';
  const startDay = localDate(ev.start_datetime);
  const endDay   = localDate(ev.end_datetime);
  if (dayStr === startDay) return 'start';
  if (dayStr === endDay)   return 'end';
  return 'middle';
}

/** Filtert Tasks: nur open/in_progress mit due_date werden angezeigt. */
function filterTasksForCalendar(tasks) {
  return tasks.filter(
    (t) => t.due_date && t.status !== 'done' && t.status !== 'archived'
  );
}

/** Tasks, die an einem bestimmten Tag fällig sind. */
function tasksOnDay(dateStr) {
  if (_dayIndex.active) return _dayIndex.tasks.get(dateStr) ?? [];
  return state.tasks.filter((t) => t.due_date === dateStr);
}

/** Holiday entries that overlap a given date (respects layer toggles). */
function holidaysOnDay(dateStr) {
  if (!state.holidays?.length) return [];
  return state.holidays.filter((h) => {
    if (h.start_date > dateStr || h.end_date < dateStr) return false;
    if (h.type === 'public' && !state.layerHolidays) return false;
    if (h.type === 'school' && !state.layerSchool)   return false;
    return true;
  });
}

/** Rendert einen read-only Task-Chip für Kalenderansichten. */
function renderTaskChip(task) {
  const priority = task.priority || 'none';
  const label    = esc(task.title);
  const ariaLbl  = t('calendar.taskChipAriaLabel', { title: task.title });
  const timeStr  = task.due_time ? ` · ${task.due_time.slice(0, 5)}` : '';
  return `<div class="cal-task-chip cal-task-chip--${priority}"
               data-task-id="${task.id}"
               role="button" tabindex="0"
               aria-label="${esc(ariaLbl)}"
               title="${label}${esc(timeStr)}">
    <i data-lucide="check-square" class="icon-xs" aria-hidden="true"></i>
    <span>${label}${esc(timeStr)}</span>
  </div>`;
}

// --------------------------------------------------------
// API
// --------------------------------------------------------

async function loadRange(from, to) {
  try {
    const [evRes, taskRes, holRes] = await Promise.all([
      api.get(`/calendar?from=${from}&to=${to}`),
      api.get('/tasks?include_future=1').catch((err) => {
        console.warn('[Calendar] Tasks-Fetch fehlgeschlagen:', err);
        return { data: [] };
      }),
      api.get(`/calendar/holidays?from=${from}&to=${to}`).catch(() => ({ data: [] })),
    ]);
    state.events   = evRes.data;
    state.tasks    = filterTasksForCalendar(taskRes.data ?? []);
    state.holidays = holRes.data ?? [];
  } catch (err) {
    console.error('[Calendar] loadRange Fehler:', err);
    state.events   = [];
    state.tasks    = [];
    state.holidays = [];
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
  state.view   = defaultCalendarView();

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="calendar-page" id="calendar-page">
      <div class="page-toolbar page-toolbar--wrap cal-toolbar" id="cal-toolbar"></div>
      <div id="cal-body" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>
      <button class="page-fab" id="fab-new-event" aria-label="${t('calendar.newEvent')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  const { from, to } = getRangeForView(state.view, state.cursor);
  const [,, prefsRes, documentOptionsRes] = await Promise.all([
    loadRange(from, to),
    loadUsers(),
    api.get('/preferences').catch(() => ({ data: {} })),
    api.get('/documents/meta/options').catch(() => ({ data: {} })),
  ]);
  state.holidayPrefs  = prefsRes.data ?? {};
  state.documentUploadBackend = documentOptionsRes.data?.active_upload_backend ?? 'local';
  state.layerHolidays = localStorage.getItem(LAYER_HOLIDAYS_KEY) !== 'false';
  state.layerSchool   = localStorage.getItem(LAYER_SCHOOL_KEY)   !== 'false';

  renderToolbar();
  renderView();

  container.querySelector('#fab-new-event')?.addEventListener('click', () => openEventModal({ mode: 'create' }));

  // Deep-Link: ?open=<id> öffnet direkt das Edit-Modal
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    try {
      const [eventRes, reminder] = await Promise.all([
        api.get(`/calendar/${openId}`),
        loadReminderForEvent(openId),
      ]);
      openEventModal({ mode: 'edit', event: eventRes.data, reminder });
    } catch { /* Event existiert nicht oder kein Zugriff */ }
  }
}

// --------------------------------------------------------
// Toolbar
// --------------------------------------------------------

function renderToolbar() {
  const bar = _container.querySelector('#cal-toolbar');
  if (!bar) return;

  const hp = state.holidayPrefs ?? {};
  const showHolidayToggle = hp.holiday_show_public;
  const showSchoolToggle  = hp.holiday_show_school;

  const holidayToggleHtml = (showHolidayToggle || showSchoolToggle) ? `
    <div class="cal-toolbar__layers">
      ${showHolidayToggle ? `
        <button class="cal-toolbar__layer-btn ${state.layerHolidays ? 'cal-toolbar__layer-btn--active' : ''}"
                id="cal-layer-holidays" data-layer="holidays"
                title="${t('calendar.toggleHolidays')}"
                style="--layer-color:${esc(hp.holiday_public_color ?? '#FF3B30')}">
          <span class="cal-toolbar__layer-dot"></span>
          <span>${t('calendar.toggleHolidays')}</span>
        </button>
      ` : ''}
      ${showSchoolToggle ? `
        <button class="cal-toolbar__layer-btn ${state.layerSchool ? 'cal-toolbar__layer-btn--active' : ''}"
                id="cal-layer-school" data-layer="school"
                title="${t('calendar.toggleSchool')}"
                style="--layer-color:${esc(hp.holiday_school_color ?? '#34C759')}">
          <span class="cal-toolbar__layer-dot"></span>
          <span>${t('calendar.toggleSchool')}</span>
        </button>
      ` : ''}
    </div>
  ` : '';

  bar.replaceChildren();
  bar.insertAdjacentHTML('beforeend', `
    <h1 class="page-toolbar__title">${t('calendar.title')}</h1>
    <div class="page-toolbar__center cal-toolbar__month">
      <button class="btn btn--icon" id="cal-prev" aria-label="${t('calendar.back')}">
        <i data-lucide="chevron-left" aria-hidden="true"></i>
      </button>
      <button class="cal-toolbar__today" id="cal-today">${t('calendar.today')}</button>
      <span class="cal-toolbar__label" id="cal-label"></span>
      <button class="btn btn--icon" id="cal-next" aria-label="${t('calendar.forward')}">
        <i data-lucide="chevron-right" aria-hidden="true"></i>
      </button>
    </div>
    <div class="page-toolbar__actions">
      ${holidayToggleHtml}
      <div class="cal-toolbar__views">
        ${VIEWS.map((v) => `
          <button class="cal-toolbar__view-btn ${v === state.view ? 'cal-toolbar__view-btn--active' : ''}"
                  data-view="${v}">${VIEW_LABELS()[v]}</button>
        `).join('')}
      </div>
      <button class="btn btn--primary btn--icon toolbar-new-btn" id="cal-add" aria-label="${t('calendar.addEvent')}">
        <i data-lucide="plus" aria-hidden="true"></i>
      </button>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: bar });

  updateLabel();

  bar.querySelector('#cal-prev').addEventListener('click', () => navigate(-1));
  bar.querySelector('#cal-next').addEventListener('click', () => navigate(1));
  bar.querySelector('#cal-today').addEventListener('click', goToday);
  bar.querySelector('#cal-add').addEventListener('click', () => openEventModal({ mode: 'create' }));

  bar.querySelectorAll('[data-layer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layer = btn.dataset.layer;
      if (layer === 'holidays') {
        state.layerHolidays = !state.layerHolidays;
        localStorage.setItem(LAYER_HOLIDAYS_KEY, state.layerHolidays);
        btn.classList.toggle('cal-toolbar__layer-btn--active', state.layerHolidays);
      } else if (layer === 'school') {
        state.layerSchool = !state.layerSchool;
        localStorage.setItem(LAYER_SCHOOL_KEY, state.layerSchool);
        btn.classList.toggle('cal-toolbar__layer-btn--active', state.layerSchool);
      }
      renderView();
    });
  });

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

async function switchToDayView(date) {
  state.cursor = date;
  state.view = 'day';
  setSavedCalendarView('day');
  _container.querySelectorAll('[data-view]').forEach((b) =>
    b.classList.toggle('cal-toolbar__view-btn--active', b.dataset.view === 'day')
  );
  await reloadForView();
  updateLabel();
  renderView();
}

async function reloadForView() {
  const { from, to } = getRangeForView(state.view, state.cursor);

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
  body.replaceChildren();

  // Tages-Buckets einmal pro Render-Pass aufbauen; danach wieder deaktivieren,
  // damit spätere State-Mutationen (Modals etc.) keinen veralteten Index lesen.
  buildDayIndex();
  try {
    if (state.view === 'month')  renderMonthView(body);
    if (state.view === 'week')   renderWeekView(body);
    if (state.view === 'day')    renderDayView(body);
    if (state.view === 'agenda') renderAgendaView(body);
  } finally {
    _dayIndex.active = false;
  }
  if (window.lucide) lucide.createIcons({ el: body });
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

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="month-view">
      <div class="month-weekdays">
        ${[t('calendar.dayShortMonday'),t('calendar.dayShortTuesday'),t('calendar.dayShortWednesday'),t('calendar.dayShortThursday'),t('calendar.dayShortFriday'),t('calendar.dayShortSaturday'),t('calendar.dayShortSunday')].map((n) => `<div class="month-weekday">${n}</div>`).join('')}
      </div>
      <div class="month-grid" id="month-grid">
        ${days.map(({ date, inMonth }) => renderMonthDay(date, inMonth)).join('')}
      </div>
    </div>
  `);

  container.querySelector('#month-grid').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      e.stopPropagation();
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.month-day__event');
    if (evEl) {
      e.stopPropagation();
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const dayEl = e.target.closest('.month-day');
    if (dayEl) {
      switchToDayView(dayEl.dataset.date);
    }
  });
}

function renderMonthDay(date, inMonth) {
  const evs      = eventsOnDay(date);
  const dayTasks = tasksOnDay(date);
  const dayHols  = holidaysOnDay(date);
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
    const bg = resolveEventBackground(ev);
    const fg = getContrastColor(resolveEventColor(ev));
    return `
    <div class="month-day__event"
         data-id="${ev.id}"
         style="background:${esc(bg)};${fg ? `color:${fg};` : ''}"
         title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}"
    >${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}</div>
  `;
  }).join('');

  const MAX_TASK_SHOW = 2;
  const taskHtml = dayTasks.slice(0, MAX_TASK_SHOW).map(renderTaskChip).join('');

  const holHtml = dayHols.map((h) => `
    <div class="month-day__holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
      <span>${esc(h.name)}</span>
    </div>
  `).join('');

  return `
    <div class="${classes}" data-date="${date}">
      <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
      ${holHtml}
      ${evHtml}
      ${extra > 0 ? `<div class="month-day__more">${t('calendar.moreEvents', { count: extra })}</div>` : ''}
      ${taskHtml}
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
    eventsOnDay(d).filter(isAllDayLike)
  );
  const timedEvs = days.map((d) =>
    eventsOnDay(d).filter((e) => !isAllDayLike(e))
  );
  const layouts = timedEvs.map((events) => layoutOverlaps(events));

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="week-view">
      <div class="week-view__header" id="week-header"
           style="display:grid;grid-template-columns:var(--space-12) repeat(${colCount},1fr);">
        <div class="week-view__time-gutter"></div>
        ${days.map((d) => {
          const dt = new Date(d + 'T00:00:00');
          return `<div class="week-view__day-header" data-date="${d}">
            <div class="week-view__day-name">${DAY_NAMES_SHORT()[dt.getDay()]}</div>
            <div class="week-view__day-num ${d === state.today ? 'week-view__day-num--today' : ''}">${dt.getDate()}</div>
          </div>`;
        }).join('')}
      </div>
      <!-- Ganztägige Ereignisse -->
      <div class="allday-row" style="display:grid;grid-template-columns:var(--space-12) repeat(${colCount},1fr);">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        ${days.map((d, i) => `
          <div class="allday-cell">
            ${holidaysOnDay(d).map((h) => `
              <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
                <span>${esc(h.name)}</span>
              </div>
            `).join('')}
            ${alldayEvs[i].map((ev) => {
              const bg = resolveEventBackground(ev);
              const fg = getContrastColor(resolveEventColor(ev));
              return `
              <div class="allday-event" data-id="${ev.id}"
                   style="background:${esc(bg)};${fg ? `color:${fg};` : ''}"
                   title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>
            `;
            }).join('')}
            ${tasksOnDay(d).map(renderTaskChip).join('')}
          </div>
        `).join('')}
      </div>
      <div class="week-view__scroll" id="week-scroll">
        <div class="week-view__body">
          <div class="week-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot" style="height:${HOUR_HEIGHT}px;">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(new Date(2000, 0, 1, h, 0, 0))}</span>
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
  `);

  // Event-Delegation
  container.querySelector('#week-header').addEventListener('click', (e) => {
    const header = e.target.closest('.week-view__day-header[data-date]');
    if (header) switchToDayView(header.dataset.date);
  });

  container.querySelector('#week-cols').addEventListener('click', (e) => {
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const col = e.target.closest('[data-date]');
    if (col) {
      const time = clickedTime(e, col);
      openEventModal({ mode: 'create', date: col.dataset.date, time });
    }
  });

  container.querySelector('.allday-row').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
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
  const bg = resolveEventBackground(ev);
  const fg = getContrastColor(resolveEventColor(ev));

  return `
    <div class="week-event" data-id="${ev.id}"
         style="top:${top}px;height:${height}px;left:${left};width:${width};background:${esc(bg)};${fg ? `color:${fg};` : ''}">
      <div class="week-event__title">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}</div>
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

/** Berechnet die geklickte Uhrzeit (auf 30-Minuten gerundet) aus einem Click-Event
 *  relativ zum übergebenen Spalten-Element. */
function clickedTime(e, colEl) {
  const rect = colEl.getBoundingClientRect();
  const yOffset = Math.max(0, e.clientY - rect.top);
  const totalMinutes = Math.round((yOffset / HOUR_HEIGHT) * 60 / 30) * 30;
  const clamped = Math.min(Math.max(totalMinutes, 0), 23 * 60 + 30);
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
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
  const allday  = dayEvs.filter(isAllDayLike);
  const timed   = dayEvs.filter((e) => !isAllDayLike(e));
  const layout = layoutOverlaps(timed);

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="day-view">
      <div class="day-view__header">
        <div class="day-view__date-label">${formatDate(state.cursor, { weekday: true, long: true })}</div>
      </div>
      ${(allday.length || tasksOnDay(state.cursor).length || holidaysOnDay(state.cursor).length) ? `
      <div class="allday-row" style="display:grid;grid-template-columns:var(--space-12) 1fr;">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        <div class="allday-cell">
          ${holidaysOnDay(state.cursor).map((h) => `
            <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
              <span>${esc(h.name)}</span>
            </div>
          `).join('')}
          ${allday.map((ev) => {
            const bg = resolveEventBackground(ev);
            const fg = getContrastColor(resolveEventColor(ev));
            return `
            <div class="allday-event" data-id="${ev.id}"
                 style="background:${esc(bg)};${fg ? `color:${fg};` : ''}"
                 title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span></div>`;
          }).join('')}
          ${tasksOnDay(state.cursor).map(renderTaskChip).join('')}
        </div>
      </div>` : ''}
      <div class="day-view__scroll" id="day-scroll">
        <div class="day-view__body">
          <div class="day-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot" style="height:${HOUR_HEIGHT}px;">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(new Date(2000, 0, 1, h, 0, 0))}</span>
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
  `);

  container.querySelector('.allday-row')?.addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });

  container.querySelector('#day-col').addEventListener('click', (e) => {
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
      return;
    }
    const time = clickedTime(e, e.currentTarget);
    openEventModal({ mode: 'create', date: state.cursor, time });
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
    .map((d) => ({ date: d, events: eventsOnDay(d), tasks: tasksOnDay(d), holidays: holidaysOnDay(d) }))
    .filter((g) => g.events.length > 0 || g.tasks.length > 0 || g.holidays.length > 0);

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="agenda-view" id="agenda-view">
      ${groups.length === 0
        ? `<div class="agenda-empty">${t('calendar.agendaEmpty')}</div>`
        : groups.map(({ date, events, tasks, holidays }) => `
          <div class="agenda-day">
            <div class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
              <span class="agenda-day__date">${formatDate(date)}</span>
              <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
            </div>
            ${holidays.length ? `<div class="agenda-holidays">${holidays.map((h) => `
              <div class="agenda-holiday" style="--holi-color:${esc(h.color)}">
                <span class="agenda-holiday__dot"></span>
                <span>${esc(h.name)}</span>
              </div>`).join('')}</div>` : ''}
            ${events.map((ev) => renderAgendaEvent(ev, date)).join('')}
            ${tasks.length ? `<div class="agenda-tasks">${tasks.map(renderTaskChip).join('')}</div>` : ''}
          </div>
        `).join('')
      }
    </div>
  `);

  stagger(container.querySelectorAll('.agenda-event'));

  container.querySelector('#agenda-view').addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      window.oikos.navigate(`/tasks?open=${taskChip.dataset.taskId}`);
      return;
    }
    const evEl = e.target.closest('.agenda-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) showEventPopup(ev, evEl);
    }
  });
}

export const __test = {
  normalizeCalendarView,
  defaultCalendarViewFromState,
  filterTasksForCalendar,
  tasksOnDay,
  isMultiDayEvent,
  isAllDayLike,
  agendaSegmentKind,
  hasAttachment,
  attachmentUrls,
  clickedTime,
  HOUR_HEIGHT,
};

function renderAgendaEvent(ev, dayStr) {
  const kind = agendaSegmentKind(ev, dayStr ?? localDate(ev.start_datetime));
  let timeStr;
  switch (kind) {
    case 'all-day':
    case 'middle':
      timeStr = t('calendar.allDay');
      break;
    case 'start':
      timeStr = t('calendar.spanFrom', { time: formatTime(ev.start_datetime) });
      break;
    case 'end':
      timeStr = t('calendar.spanUntil', { time: formatTime(ev.end_datetime) });
      break;
    default: // single
      timeStr = formatTime(ev.start_datetime)
        + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${t('calendar.timeSuffix')}`.trimEnd() : ` ${t('calendar.timeSuffix')}`.trimEnd());
  }

  const displayBg     = resolveEventBackground(ev);
  const displayColor  = resolveEventColor(ev);
  const calLabelColor = ev.cal_color || ev.color || displayColor;
  const assignedUsers = ev.assigned_users ?? [];
  return `
    <div class="agenda-event" data-id="${ev.id}">
      <div class="agenda-event__color" style="background:${esc(displayBg)};"></div>
      <div class="agenda-event__body">
        <div class="agenda-event__title">${eventIconHtml(ev.icon)}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}</div>
        <div class="agenda-event__meta">
          <span class="calendar-meta-item">${calendarMetaIconHtml('clock')}<span>${esc(timeStr)}</span></span>
          ${ev.location ? `<span class="calendar-meta-item">${calendarMetaIconHtml('map-pin')}<span>${esc(fmtLocation(ev.location))}</span></span>` : ''}
          ${ev.cal_name ? `<span class="event-cal-label" style="--cal-color:${esc(calLabelColor)}">${esc(ev.cal_name)}</span>` : ''}
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

  const displayBg     = resolveEventBackground(ev);
  const displayColor  = resolveEventColor(ev);
  const calLabelColor = ev.cal_color || ev.color || displayColor;
  popup.insertAdjacentHTML('beforeend', `
    <div class="event-popup__color-bar" style="background:${esc(displayBg)};"></div>
    <div class="event-popup__title">${eventIconHtml(ev.icon)}<span>${esc(ev.title)}</span></div>
    <div class="event-popup__meta">
      ${ev.cal_name ? `<div><span class="event-cal-label" style="--cal-color:${esc(calLabelColor)}">${esc(ev.cal_name)}</span></div>` : ''}
      <div class="calendar-meta-item">${calendarMetaIconHtml('clock')}<span>${esc(timeStr)}</span></div>
      ${ev.location ? `<div class="calendar-meta-item">${calendarMetaIconHtml('map-pin')}<span>${esc(fmtLocation(ev.location))}</span></div>` : ''}
      ${ev.description ? `<div>${esc(truncateDescription(ev.description, 500))}</div>` : ''}
      ${hasAttachment(ev) ? attachmentHtml(ev) : ''}
      ${ev.assigned_name ? `<div class="calendar-meta-item">${calendarMetaIconHtml('user')}<span>${esc(ev.assigned_name)}</span></div>` : ''}
    </div>
    <div class="event-popup__actions">
      <button class="btn btn--secondary event-popup__edit" id="popup-edit">${t('calendar.popupEdit')}</button>
      <button class="btn btn--danger"    id="popup-delete">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>
  `);

  document.body.appendChild(popup);
  if (window.lucide) lucide.createIcons({ el: popup });

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
      <div class="form-group reminder-section__group">
        <label class="form-label" for="modal-reminder-offset">${t('reminders.offsetLabel')}</label>
        <select class="form-input" id="modal-reminder-offset">
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
    input.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      if (!/[\d: apmAPM]/.test(e.key)) e.preventDefault();
    });
    input.addEventListener('blur', () => {
      const parsed = parseTimeInput(input.value);
      if (parsed) input.value = formatTimeInput(parsed);
    });
  });
}

// --------------------------------------------------------
// CalDAV Target Helpers
// --------------------------------------------------------

async function loadSyncTargets(selectElement, currentEvent = null) {
  if (!selectElement) return;

  selectElement.replaceChildren();
  const localOption = document.createElement('option');
  localOption.value = '';
  localOption.textContent = t('calendar.syncTargetLocal');
  selectElement.appendChild(localOption);

  // Google calendars (enabled only)
  try {
    const res = await api.get('/calendar/google/calendars');
    const enabled = (res.data || []).filter((c) => c.enabled && c.writable);
    if (enabled.length) {
      const group = document.createElement('optgroup');
      group.className = 'js-google-targets';
      group.label = t('calendar.syncTargetGoogleGroup');
      for (const cal of enabled) {
        const option = document.createElement('option');
        option.value = `google:${cal.id}`;
        option.textContent = cal.summary || cal.id;
        group.appendChild(option);
      }
      selectElement.appendChild(group);
    }
  } catch (err) {
    console.warn('Failed to load Google targets:', err);
  }

  // CalDAV calendars (enabled only), grouped per account
  try {
    const accountsRes = await api.get('/calendar/caldav/accounts');
    for (const account of accountsRes.data || []) {
      try {
        const calRes = await api.get(`/calendar/caldav/accounts/${account.id}/calendars`);
        const enabled = (calRes.data || []).filter((cal) => cal.enabled);
        if (!enabled.length) continue;
        const group = document.createElement('optgroup');
        group.label = `${t('calendar.syncTargetCaldavGroup')} · ${account.name}`;
        for (const cal of enabled) {
          const option = document.createElement('option');
          option.value = `caldav:${account.id}|${cal.calendarUrl}`;
          option.textContent = cal.calendarName || cal.calendarUrl;
          group.appendChild(option);
        }
        selectElement.appendChild(group);
      } catch (err) {
        console.warn(`Failed to load calendars for account ${account.id}:`, err);
      }
    }
  } catch (err) {
    console.warn('Failed to load CalDAV targets:', err);
  }

  // Pre-select the editing event's existing target
  if (currentEvent?.target_google_calendar_id) {
    const value = `google:${currentEvent.target_google_calendar_id}`;
    // Zeigt das Event auf ein (jetzt) nur-lesbares Ziel, das nicht mehr in der
    // gefilterten Liste steht: Option nachtragen, damit Speichern das Ziel nicht
    // still auf "Lokal" zurücksetzt. Der Server-Guard fängt den Outbound-Fall ab.
    if (!Array.from(selectElement.options).some((o) => o.value === value)) {
      let group = selectElement.querySelector('optgroup.js-google-targets');
      if (!group) {
        group = document.createElement('optgroup');
        group.className = 'js-google-targets';
        group.label = t('calendar.syncTargetGoogleGroup');
        selectElement.appendChild(group);
      }
      const option = document.createElement('option');
      option.value = value;
      option.textContent = currentEvent.target_google_calendar_id;
      group.appendChild(option);
    }
    selectElement.value = value;
  } else if (currentEvent?.target_caldav_account_id && currentEvent?.target_caldav_calendar_url) {
    selectElement.value = `caldav:${currentEvent.target_caldav_account_id}|${currentEvent.target_caldav_calendar_url}`;
  }
}

// --------------------------------------------------------
// Event-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

function openEventModal({ mode, event = null, date = null, reminder = null, time = null }) {
  if (mode === 'edit' && event?.housekeeping_visit_id) {
    window.oikos.navigate(`/housekeeping?editVisit=${event.housekeeping_visit_id}`);
    return;
  }
  const isEdit = mode === 'edit';
  const content = buildEventModalContent({ mode, event, date, reminder, time });

  openSharedModal({
    title: isEdit ? t('calendar.editEvent') : t('calendar.newEvent'),
    content,
    size: 'md',
    onSave(panel) {
      // RRULE-Events binden
      bindRRuleEvents(panel, 'event');
      bindUserMultiSelect(panel, 'cal_assigned');

      // Color-Picker ausgrauen wenn Assignees gesetzt sind (Avatar-Farbe hat Vorrang)
      function syncColorPickerState() {
        const hasAssignees = getSelectedUserIds(panel, 'cal_assigned').length > 0;
        const group  = panel.querySelector('.js-color-picker-group');
        const hint   = panel.querySelector('#color-picker-assignee-hint');
        const picker = panel.querySelector('#event-color-picker');
        if (group)  group.classList.toggle('color-picker--disabled', hasAssignees);
        if (hint)   hint.hidden = !hasAssignees;
        if (picker) {
          picker.setAttribute('aria-disabled', hasAssignees ? 'true' : 'false');
          picker.querySelectorAll('.color-swatch').forEach((s) => {
            if (hasAssignees) {
              s.setAttribute('tabindex', '-1');
            } else {
              s.setAttribute('tabindex', s.classList.contains('color-swatch--active') ? '0' : '-1');
            }
          });
        }
      }
      const msWidget = panel.querySelector('.user-ms[data-ms-name="cal_assigned"]');
      msWidget?.addEventListener('change', syncColorPickerState);
      syncColorPickerState();

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
        if (window.lucide) lucide.createIcons({ el: iconTrigger });
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
      const removeAttachment = panel.querySelector('#modal-remove-attachment');
      const attachmentState = {
        name: event?.attachment_name || null,
        mime: event?.attachment_mime || null,
        size: event?.attachment_size || null,
        changed: false,
        removed: false,
      };

      const syncSelectedAttachment = () => {
        if (!selectedAttachment) return;
        selectedAttachment.hidden = !attachmentState.name;
        selectedAttachment.textContent = attachmentState.name ? selectedAttachmentLabel(attachmentState.name) : '';
        if (removeAttachment) removeAttachment.hidden = !attachmentState.name;
      };

      const syncAttachmentSelection = () => {
        if (!selectedAttachment) return;
        const file = attachmentInput.files?.[0];
        if (file) {
          attachmentState.name = file.name;
          attachmentState.mime = file.type || 'application/octet-stream';
          attachmentState.size = file.size;
          attachmentState.changed = true;
          attachmentState.removed = false;
          selectedAttachment.hidden = false;
          selectedAttachment.textContent = selectedAttachmentLabel(file.name);
          if (removeAttachment) removeAttachment.hidden = false;
          if (attachmentPreview) {
            attachmentPreview.replaceChildren();
            attachmentPreview.hidden = true;
          }
          return;
        }
        syncSelectedAttachment();
      };

      attachmentInput?.addEventListener('change', syncAttachmentSelection);
      removeAttachment?.addEventListener('click', () => {
        if (attachmentInput) attachmentInput.value = '';
        attachmentState.name = null;
        attachmentState.mime = null;
        attachmentState.size = null;
        attachmentState.changed = true;
        attachmentState.removed = true;
        if (attachmentPreview) {
          attachmentPreview.replaceChildren();
          attachmentPreview.hidden = true;
        }
        syncSelectedAttachment();
      });

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

      // Load unified sync targets (Google + CalDAV)
      const syncTargetSelect = panel.querySelector('#event-sync-target');
      if (syncTargetSelect) {
        loadSyncTargets(syncTargetSelect, event);
      }

      // Enddatum dem Startdatum nachführen, damit das Verschieben des Starts
      // das Ende nicht davor zurücklässt (Dauer bleibt erhalten).
      const wireDateFollow = (startSel, endSel) => {
        const startEl = panel.querySelector(startSel);
        const endEl   = panel.querySelector(endSel);
        if (!startEl || !endEl) return;
        let prevStart = startEl.value;
        startEl.addEventListener('change', () => {
          if (isDateInputValid(startEl.value) && isDateInputValid(endEl.value)) {
            const oldKey = parseDateInput(prevStart);
            const newKey = parseDateInput(startEl.value);
            const endKey = parseDateInput(endEl.value);
            if (oldKey && newKey && endKey) {
              endEl.value = formatDateInput(shiftEndDateKey(oldKey, newKey, endKey));
            }
          }
          prevStart = startEl.value;
        });
      };
      wireDateFollow('#modal-start-date', '#modal-end-date');
      wireDateFollow('#modal-allday-start', '#modal-allday-end');

      panel.querySelector('#modal-cancel').addEventListener('click', closeModal);

      panel.querySelector('#modal-delete')?.addEventListener('click', async () => {
        closeModal({ force: true });
        await deleteEvent(event.id);
      });

      panel.querySelector('#modal-save').addEventListener('click', () => saveEvent(panel, mode, event?.id, reminder, attachmentState));
      if (window.lucide) lucide.createIcons({ el: panel });
    },
  });
}

function buildEventModalContent({ mode, event, date, reminder = null, time = null }) {
  const isEdit = mode === 'edit';
  const today  = date || state.today;

  const startDate = isEdit ? localDate(event.start_datetime) : today;
  const startTime = isEdit && event.start_datetime.length > 10
    ? localTime(event.start_datetime) : (time ?? '09:00');
  const endDate   = isEdit && event.end_datetime ? localDate(event.end_datetime) : startDate;
  const endTime   = isEdit && event.end_datetime && event.end_datetime.length > 10
    ? localTime(event.end_datetime)
    : (() => {
        if (!time) return '10:00';
        const totalMins = timeToMinutes(time) + 60;
        const clamped   = Math.min(totalMins, 24 * 60 - 1);
        return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
      })();
  const selectedIcon = eventIconName(isEdit ? event.icon : 'calendar');

  const selectedUserIds = isEdit
    ? (event.assigned_users?.map((u) => u.id) ?? (event.assigned_to ? [event.assigned_to] : []))
    : [];

  // Sekundärfelder: wandern hinter „Weitere Einstellungen". Beim Bearbeiten
  // automatisch geöffnet, falls bereits Werte gesetzt sind.
  const advancedFieldsOpen = isEdit
    && (!!event.location || !!event.description || hasAttachment(event));

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" for="modal-location">${t('calendar.locationLabel')}</label>
      <input type="text" class="form-input" id="modal-location"
             placeholder="${t('calendar.locationPlaceholder')}" value="${esc(isEdit && event.location ? event.location : '')}">
    </div>

    <div class="form-group js-color-picker-group">
      <label class="form-label" id="event-color-label">${t('calendar.colorLabel')}</label>
      <div class="color-picker" id="event-color-picker" role="radiogroup" aria-labelledby="event-color-label">
        ${EVENT_COLORS.map((c, i) => `
          <div class="color-swatch" data-color="${c}" style="background-color:${c};"
               role="radio"
               tabindex="${i === 0 ? '0' : '-1'}"
               aria-checked="false"
               aria-label="${EVENT_COLOR_NAMES()[c] ?? c}"></div>
        `).join('')}
      </div>
      <p class="form-hint color-picker__assignee-hint" id="color-picker-assignee-hint" hidden>${t('calendar.colorOverriddenByAssignee')}</p>
    </div>

    <div class="form-group">
      <label class="form-label" for="event-sync-target">${t('calendar.syncTargetLabel')}</label>
      <select class="form-input" id="event-sync-target">
        <option value="">${t('calendar.syncTargetLocal')}</option>
      </select>
      <small class="form-hint">${t('calendar.syncTargetHint')}</small>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-description">${t('calendar.descriptionLabel')}</label>
      <textarea class="form-input" id="modal-description" rows="2"
                placeholder="${t('calendar.descriptionPlaceholder')}">${esc(isEdit && event.description ? event.description : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-attachment">${t('calendar.attachmentLabel')}</label>
      <p class="document-storage-target">
        <i data-lucide="${state.documentUploadBackend === 'webdav' ? 'cloud' : 'database'}" aria-hidden="true"></i>
        <span>${t('documents.activeUploadTarget', {
          target: state.documentUploadBackend === 'webdav'
            ? t('documents.storageWebdav')
            : t('documents.storageLocal'),
        })}</span>
      </p>
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
      <div class="event-attachment-preview" id="modal-attachment-preview" ${isEdit && hasAttachment(event) ? '' : 'hidden'}>
        ${isEdit && hasAttachment(event) ? attachmentPreviewHtml(event) : ''}
      </div>
      <button class="btn btn--secondary" id="modal-remove-attachment" type="button"
              ${isEdit && hasAttachment(event) ? '' : 'hidden'}>${t('calendar.attachmentRemove')}</button>
    </div>`;

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
      ${renderUserMultiSelect(state.users, selectedUserIds, 'cal_assigned', 'calendar.assignedLabel')}
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedFieldsOpen })}

    ${renderRRuleFields('event', isEdit ? event.recurrence_rule : null)}

    ${renderCalendarReminderSection(reminder, event)}

    <div class="modal-panel__footer" style="border:none;padding:0;margin-top:var(--space-4)">
      ${isEdit ? `<button class="btn btn--danger btn--icon" id="modal-delete" aria-label="${t('calendar.deleteEvent')}">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
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
  if (isEndBeforeStart(start_datetime, end_datetime)) {
    window.oikos?.showToast(t('calendar.endBeforeStart'), 'error');
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
    const attachmentFile = overlay.querySelector('#modal-attachment')?.files?.[0];
    let attachmentPayload = null;
    if (attachmentFile) {
      if (attachmentFile.size > MAX_ATTACHMENT_BYTES) throw new Error(t('calendar.attachmentTooLarge'));
      attachmentPayload = {
        name: attachmentFile.name,
        mime: attachmentFile.type || 'application/octet-stream',
        size: attachmentFile.size,
        data: await readFileAsDataUrl(attachmentFile),
      };
    }

    // Extract sync target (unified Google + CalDAV picker)
    const syncTargetValue = overlay.querySelector('#event-sync-target')?.value || '';
    let target_google_calendar_id = null;
    let target_caldav_account_id = null;
    let target_caldav_calendar_url = null;

    if (syncTargetValue.startsWith('google:')) {
      target_google_calendar_id = syncTargetValue.slice('google:'.length);
    } else if (syncTargetValue.startsWith('caldav:')) {
      const [accountId, calendarUrl] = syncTargetValue.slice('caldav:'.length).split('|');
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
      target_google_calendar_id,
      target_caldav_account_id,
      target_caldav_calendar_url,
    };
    if (attachmentPayload) {
      Object.assign(body, {
        attachment_name: attachmentPayload.name,
        attachment_mime: attachmentPayload.mime,
        attachment_size: attachmentPayload.size,
        attachment_data: attachmentPayload.data,
        document_folder_name: t('documents.calendarItemsFolder'),
        document_name: t('calendar.attachmentDocumentName', { title, name: attachmentPayload.name }),
        document_description: t('calendar.attachmentDocumentDescription', { title }),
      });
    } else if (attachmentState?.changed && attachmentState.removed) {
      body.remove_attachment = true;
    }

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
