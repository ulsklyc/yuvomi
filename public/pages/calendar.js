/**
 * Modul: Kalender (Calendar)
 * Zweck: Monats-/Wochen-/Tages-/Agenda-Ansicht mit vollem Termin-CRUD
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues, recurrenceRow } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, confirmModal, advancedSection, wireBlurValidation, reportFieldError } from '/components/modal.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { openDetailView, visibilityRow, assignedRow } from '/components/detail-view.js';
import { stagger, wireScrollFade, scheduleUndoableDelete } from '/utils/ux.js';
import { t, formatDate as formatPreferredDate, formatDayMonth, formatTime, timeSuffix, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc, fmtLocation } from '/utils/html.js';
import { shiftEndDateKey, isEndBeforeStart, weekStartIndex, weekdayOrder,
         monthPeriodKeys, startOfLocalWeekKey, addLocalDays, defaultDateInPeriod,
         isWeekendKey } from '/utils/date.js';
import { truncateRuleBefore, shiftSeriesStart, shiftEndForStart, followingMeansWholeSeries,
         isLocalRecurringSeries, isExternalRecurringSeries } from '/utils/recurrence-scope.js';
import { getReadableTextColor } from '/utils/color.js';
import { resolveEventColor } from '/utils/event-color.js';
import { refresh as refreshReminders } from '/reminders.js';
import { parseRemindAtAsUtc } from '/utils/reminder-offset.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { wireTablist } from '/utils/tablist.js';
// EINE Schalterform, auch hier. Das Primitiv liegt unter `/settings/`, weil
// dort sein Anlass lag (vier Schalterformen nebeneinander, Critique
// 2026-07-27) - die Funktion selbst ist geteiltes UI-Vokabular und kein
// Einstellungs-Bauteil. Eine Kopie im Kalender waeren zwei Wahrheiten ueber
// dieselbe Form; der Umzug nach `/utils/` beruehrt zehn Blaetter und gehoert
// in eine eigene Runde. Der Import benennt die Schuld, statt sie zu umgehen.
import { toggleRowHtml } from '/settings/components.js';
import { localizeBirthdayEvent } from '/utils/birthday-event.js';
import { googleTargetValue, caldavTargetValue, outlookTargetValue } from '/utils/sync-target.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { findPageFab } from '/utils/fab.js';
import { nowFields, todayKey, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';
import { emptyStateHTML, emptyHintHTML, mountLoadError } from '/utils/empty-state.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VIEWS      = ['month', 'week', 'day', 'agenda'];
let viewTabs = null; // wireTablist-Controller der View-Umschaltung (Sync aus switchToDayView)
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

// Kuratierte OKLCH-Palette (gedämpfte Jewel-Töne, verankert auf dem Violett der
// App-Identität statt der geliehenen iOS-System-Farben). Gleichmäßiger Chroma-/
// Hue-Abstand; jede Farbe ergibt sowohl eine ruhige getönte Fläche als auch eine
// WCAG-AA-lesbare dunkle Tinte (siehe eventSurfaceStyle + calendar.css). Konkreter
// Hex, weil Events die Farbe als Hex in der DB speichern und color.js Luminanz rechnet.
const EVENT_COLORS = [
  '#587DCE', '#3CA368', '#E0843E', '#CE5053',
  '#8156C0', '#DB684C', '#3E9DCA', '#D8B349',
  '#85868B', '#279EA4',
];

const EVENT_COLOR_NAMES = () => ({
  '#587DCE': t('calendar.colorBlue'),
  '#3CA368': t('calendar.colorGreen'),
  '#E0843E': t('calendar.colorOrange'),
  '#CE5053': t('calendar.colorRed'),
  '#8156C0': t('calendar.colorPurple'),
  '#DB684C': t('calendar.colorCoral'),
  '#3E9DCA': t('calendar.colorSkyBlue'),
  '#D8B349': t('calendar.colorYellow'),
  '#85868B': t('calendar.colorGray'),
  '#279EA4': t('calendar.colorCyan'),
});

/**
 * Hex-Vergleich ohne Ruecksicht auf Gross-/Kleinschreibung. Die Palette steht
 * hier in Grossbuchstaben, ein CalDAV-Server schickt `#34c759` genauso gern -
 * derselbe Farbwert, und ein `===` haelt die beiden fuer verschieden.
 */
const sameColor = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Die Farben, die der Picker eines Termins zeigt.
 *
 * Ein Termin traegt nicht zwangslaeufig eine Farbe AUS DIESER PALETTE. Sie kann
 * als RFC-7986-`COLOR` von einem CalDAV-Server kommen, sie kann die Avatar-Farbe
 * einer Person sein (deren Palette teilt mit dieser hier keinen einzigen Wert)
 * oder schlicht das alte `#007AFF` aus der Zeit vor der OKLCH-Palette.
 *
 * Ohne einen eigenen Swatch dafuer stand der Picker leer da, obwohl der Termin
 * eine Farbe trug - und weil der Speicherpfad auf die erste Palettenfarbe
 * zurueckfiel, schrieb der naechste Klick auf "Speichern" sie darueber. Die
 * Farbe wechselte also genau beim Bearbeiten, ohne dass jemand sie angefasst
 * hatte (#856).
 */
// Spiegelt COLOR_RE aus server/middleware/validate.js. Die Route prueft das
// bereits, aber die Sync-Dienste schreiben ihre Farben direkt in die Tabelle -
// was von dort kommt, hat diese Pruefung nie gesehen. Und der Wert landet gleich
// in einem style-Attribut, wo esc() zwar das Ausbrechen verhindert, nicht aber
// eine zweite CSS-Deklaration dahinter.
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function pickerColors(event) {
  const own = event?.color;
  if (!own || !HEX_COLOR_RE.test(own)) return EVENT_COLORS;
  if (EVENT_COLORS.some((c) => sameColor(c, own))) return EVENT_COLORS;
  return [own, ...EVENT_COLORS];
}

/**
 * Der Wert des Erben-Swatch: "dieser Termin hat keine eigene Farbe".
 *
 * Der Leerstring, nicht `null`, weil er aus `dataset.color` kommt - ein
 * data-Attribut kennt keinen Nullwert, und ein fehlendes Attribut waere
 * `undefined` und damit nicht mehr von "gar kein Swatch aktiv" zu
 * unterscheiden. Genau diese Unterscheidung traegt die Regel unten.
 */
const COLOR_INHERIT = '';

/**
 * Welche Farbe ein Speichern schreibt.
 *
 * Zwei Regeln, und die Reihenfolge ist der ganze Punkt:
 *
 * 1. Steht der Erben-Swatch auf aktiv, schreibt das Speichern `null` - der
 *    Termin bekommt KEINE eigene Farbe und leiht sich die der zugewiesenen
 *    Person (#891). Das ist eine ausdrueckliche Wahl und deshalb ein Wert, den
 *    das Backend annehmen muss; `crud.js` unterscheidet sie am mitgeschickten
 *    Feld von "nicht angefasst".
 * 2. Steht gar kein Swatch auf aktiv, darf ein Speichern die Farbe nicht
 *    veraendern - es gilt, was der Termin schon traegt. Fehlt auch die, bleibt
 *    es bei `null`: ein neuer Termin faengt ohne eigene Farbe an. Bis v2.48.0
 *    stand hier `EVENT_COLORS[0]`, und weil dieser Palettenerste ununterscheidbar
 *    von einer bewussten Wahl war, hat er die Personenfarbe verdraengt, ohne dass
 *    sie je jemand abgewaehlt haette.
 */
function colorToSave(activeSwatchColor, event) {
  if (activeSwatchColor === COLOR_INHERIT) return null;
  if (activeSwatchColor) return activeSwatchColor;
  return event?.color ?? null;
}

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

// `balloon` was added to Lucide after the app's vendored v0.469.0 bundle. Keep
// this single glyph local instead of turning name-day polish into a full icon
// library upgrade. Its SVG paths come from Lucide v0.557.0 and are covered by
// public/vendor/lucide/LICENSE.balloon-v0.557.0.
const CUSTOM_EVENT_ICON_PATHS = Object.freeze({
  tooth: [
    'M8.5 3.5c1.2 0 2.1.5 3.5.5s2.3-.5 3.5-.5c2.4 0 4 1.8 4 4.4 0 2.2-1 4.2-1.7 5.7-.7 1.6-.8 3.1-1.1 4.7-.3 1.7-1.1 3.2-2.4 3.2-1.1 0-1.5-1.1-1.8-2.7-.2-1.2-.4-2.1-.5-2.1s-.3.9-.5 2.1c-.3 1.6-.7 2.7-1.8 2.7-1.3 0-2.1-1.5-2.4-3.2-.3-1.6-.4-3.1-1.1-4.7C5.5 12.1 4.5 10.1 4.5 7.9c0-2.6 1.6-4.4 4-4.4Z',
    'M10 6.2c.7.3 1.3.5 2 .5s1.3-.2 2-.5',
  ],
  balloon: [
    'M12 16v1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v1',
    'M12 6a2 2 0 0 1 2 2',
    'M18 8c0 4-3.5 8-6 8s-6-4-6-8a6 6 0 0 1 12 0',
  ],
});
const CUSTOM_EVENT_ICONS = new Set(Object.keys(CUSTOM_EVENT_ICON_PATHS));

const ATTACHMENT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CALENDAR_VIEW_STORAGE_KEY = 'yuvomi:calendar:view';
const LEGACY_CALENDAR_VIEW_STORAGE_KEY = 'yuvomi-calendar-view';
const LAYER_HOLIDAYS_KEY = 'yuvomi:calendar:layer:holidays';
const LAYER_SCHOOL_KEY    = 'yuvomi:calendar:layer:school';
const LAYER_BIRTHDAYS_KEY = 'yuvomi:calendar:layer:birthdays';
const LAYER_SCHEDULE_KEY = 'yuvomi:calendar:layer:schedule';
const SCHEDULE_DISPLAY_KEY = 'yuvomi:calendar:schedule-display';
const ASSIGNED_TO_ME_KEY  = 'yuvomi:calendar:assignedToMe';
const PEOPLE_FILTER_KEY   = 'yuvomi:calendar:people';

/* DIE FEIERTAGSFARBEN, WENN DER HAUSHALT KEINE GEWAEHLT HAT.
 *
 * Sie standen zweimal als nacktes Hex im Markup dieser Datei und viermal im
 * Server (routes/preferences.js, services/holidays.js). Hier stehen sie
 * einmal - der Client erfindet keinen eigenen Wert, er nennt denselben wie
 * die Quelle.
 *
 * DIE WERTE SELBST SIND EIN OFFENER PUNKT, kein Versehen: `#FF3B30` und
 * `#34C759` sind iOS System Red und System Green, also genau die
 * Apple-Rohpalette, die der Direction Contract am 2026-08-10 ausdruecklich
 * verlassen hat. Sie zu aendern faerbt jeden Haushalt um, der nie eine Farbe
 * gewaehlt hat - das ist eine Entscheidung des Betreibers, keine Reparatur,
 * und sie muesste den Server mitnehmen. Bis dahin steht der Wert wenigstens
 * an einer Stelle statt an dreien. */
/* DIE MOBIL-GRENZE STEHT EINMAL, UND SIE FOLGT DEM CSS.
 *
 * Sie stand viermal als `(max-width: 639px)` im JS, waehrend calendar.css an
 * drei Stellen bei `max-width: 640px` schaltete. Bei GENAU 640px war die App
 * deshalb in zwei Zustaenden zugleich: das CSS hatte die Termin-Chips schon
 * auf Punkte reduziert, das JS hielt noch die Desktop-Klicklogik - ein Tap
 * musste einen 10px-Punkt treffen, statt die ganze Zelle als Ziel zu haben.
 * Verifiziert bei 640px: `cssMobile: true`, `jsMobile: false`.
 *
 * Der Wert ist seither ZWEIMAL gewandert, und beide Male wanderte nur eine
 * Seite: erst zog das JS auf die CSS-Zahl 640, dann zog der Breakpoint-Sweep
 * das CSS auf die Paarung 639 - und liess das JS wieder allein bei 640 stehen,
 * mit demselben Zwei-Zustaende-Bild bei genau 640px, nur seitenverkehrt. Ein
 * Guard, der Zahlen ohne ihre Richtung vergleicht, sah beide Male nichts:
 * `min-width: 640px` in layout.css deckte die JS-640 scheinbar ab.
 *
 * Der Guard vergleicht deshalb nicht mehr Zahlen, sondern SCHWELLEN (`test:
 * frontend-audit`): `max-width: 639px` und `min-width: 640px` sind dieselbe
 * Schwelle 640, `max-width: 640px` ist die Schwelle 641 - und die kennt kein
 * Stylesheet. Zwei Zahlen fuer dieselbe Schwelle sind genau die Bauart, an der
 * dieser Fehler zweimal entstanden ist. */
const MOBILE_MEDIA_QUERY = '(max-width: 639px)';

const HOLIDAY_PUBLIC_FALLBACK = '#FF3B30';
const HOLIDAY_SCHOOL_FALLBACK = '#34C759';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* DIE STUNDENHOEHE STEHT IN tokens.css UND NUR DORT.
 *
 * Sie stand hier als `HOUR_HEIGHT = 56` und dort als `--cal-hour-height: 56px`:
 * zwei Schreibweisen desselben Werts, von denen eine still veralten kann - wer
 * das Token anfasst, verschiebt die Stundenlinien und laesst die Termine
 * stehen, ohne dass ein Test das sieht. Positionen werden deshalb als calc()
 * gegen den Token-Namen ausgedrueckt; wer die Hoehe wirklich in Pixeln braucht
 * (Klick auf eine Uhrzeit, Scroll zur aktuellen Stunde), misst sie am Element.
 *
 * Es bleibt EIN Variablenname. Die Tagesansicht ist dichter (40px statt 56px),
 * aber sie sagt das in ihrem eigenen CSS - `.day-view` ueberschreibt
 * --cal-hour-height mit --cal-hour-height-day, und alles darin (Zeitspalte,
 * Stundenlinien, Termine, Now-Linie) folgt automatisch. JS kennt die Dichte
 * gar nicht, es kennt nur den Bezug. */
const HOUR_VAR = '--cal-hour-height';

/** Vertikaler Versatz einer Minutenzahl als calc() gegen die Stundenhoehe. */
function hourOffset(minutes) {
  return `calc(var(${HOUR_VAR}) * ${Math.round((minutes / 60) * 1e4) / 1e4})`;
}

/** Gemessene Stundenhoehe einer 24-Stunden-Spalte (Klick- und Scroll-Mathematik). */
function measuredHourHeight(colEl) {
  return (colEl?.getBoundingClientRect?.().height || 0) / 24;
}

function renderIconPickerResults(selectedIcon, query = '') {
  const q = query.trim().toLowerCase();
  if (q) {
    const filtered = EVENT_ICON_CATEGORIES()
      .flatMap((c) => c.icons)
      .filter((icon) => icon.label.toLowerCase().includes(q) || icon.value.includes(q));
    if (filtered.length === 0) {
      return emptyHintHTML(t('calendar.iconSearchEmpty'));
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
  // Die Zurueck-Geste schliesst zuerst diesen Picker, nicht das Formular
  // darunter (#871).
  attachOverlay(overlay, close);
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

// --------------------------------------------------------
// Farbberechnung: die spezifischste Angabe gewinnt
// Hierarchie: eigene Terminfarbe → erster Assignee → Kalenderfarbe → Grau
// --------------------------------------------------------

/** Neutrale Fallback-Farbe wenn weder Assignee noch manuelle Farbe gesetzt. */
// Die Rangfolge selbst steht in utils/event-color.js, weil das Dashboard
// dieselbe Frage stellt und vor #891 eine eigene, kuerzere Antwort hatte.

/**
 * Gibt eine einzelne CSS-Füllfarbe zurück (nie ein Gradient).
 * Eine Farbachse: 1. eigene Terminfarbe, 2. erster Assignee, 3. Kalenderfarbe, 4. Grau.
 * Mehrere Zugewiesene werden über den Avatar-Stack kommuniziert, nicht über eine
 * diagonal geteilte Füllung — die wirkte wie ein Render-Artefakt und blieb bei der
 * zweiten Farbe ungeprüft im Kontrast.
 */
function resolveEventBackground(ev) {
  return resolveEventColor(ev);
}

/**
 * Inline-Style für eine getönte Event-Fläche (Monat/Woche/Tag/Ganztägig).
 * Setzt nur `--ev-color`; Tönung, lesbare Tinte und Kante leitet calendar.css per
 * color-mix ab (theme-korrekt in Light & Dark, WCAG-AA für die gesamte Palette).
 * Ersetzt die frühere vollgesättigte Füllung + getContrastColor-Textfarbe.
 */
function eventSurfaceStyle(ev) {
  return `--ev-color:${esc(resolveEventColor(ev))};`;
}

/**
 * Rendert den Avatar-Stack der Zugewiesenen für einen Termin-Chip in den
 * Gitter-Ansichten (Monat/Woche/Tag). Die Chip-Farbe trägt bereits den ersten
 * Assignee; der Stack liefert die Identität (Foto/Initialen), die Farbe allein
 * nicht kommunizieren kann. Leerstring, wenn niemand zugewiesen ist.
 */
function chipAssigneeStack(ev, { size, maxVisible }) {
  const users = ev.assigned_users ?? [];
  if (!users.length) return '';
  return `<span class="cal-chip__assigned">${renderAvatarStack(users, { size, maxVisible })}</span>`;
}

/**
 * Textalternative der Zuweisung, z. B. „Zugewiesen an: Linda, Marco". Trägt die
 * „Wer"-Information, die der Avatar-Stack nur visuell kommuniziert, in title-/
 * aria-label-Attribute — damit Screenreader sie im Gitter mitbekommen.
 * Leerstring, wenn niemand zugewiesen ist.
 */
function chipAssigneeLabel(ev) {
  const names = (ev.assigned_users ?? []).map((u) => u.display_name).filter(Boolean);
  return names.length ? `${t('calendar.assignedLabel')}: ${names.join(', ')}` : '';
}

/** Escapte ` · Zugewiesen an: …`-Ergänzung zum Anhängen an ein title-Attribut. */
function chipAssigneeTitleSuffix(ev) {
  const label = chipAssigneeLabel(ev);
  return label ? ` · ${esc(label)}` : '';
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  view:          'month',
  // Fehlerobjekt des letzten Bereichs-Ladeversuchs, oder null. Nicht `true`:
  // `mountLoadError` liest daraus den Statuscode.
  loadError:     null,
  today:         '',
  cursor:        null,     // aktuell angezeigte Referenz-Datum (YYYY-MM-DD)
  events:        [],
  tasks:         [],       // Aufgaben mit due_date für Kalender-Anzeige
  scheduleEntries: [],
  scheduleWarnings: [],
  users:         [],
  rangeFrom:     '',
  rangeTo:       '',
  holidays:      [],       // cached entries from holiday_cache
  holidayPrefs:  {},       // subset of /preferences
  weekStart:     1,        // getDay()-Index des Wochenstarts (0=So,1=Mo,6=Sa)
  documentUploadBackend: 'local',
  layerHolidays: true,     // toggle for public holiday layer
  layerSchool:   true,     // toggle for school holiday layer
  layerBirthdays: true,    // toggle for the birthday layer (#778)
  layerSchedule: true,     // computed schedule overlay
  scheduleDisplay: 'compact',
  offlineSince:  null,     // Date des letzten Cache-Stands, wenn offline bedient
  defaultDuration: 60,     // Standard-Termindauer (Minuten) aus den Präferenzen
  currentUserId: null,     // eigene User-ID für „Mir zugewiesen"-Filter
  // Der angemeldete Mensch, wie der Router ihn hereingibt. Gehalten fuer die
  // Aufgaben-Leseansicht (#918): an ihm haengt, wem seine eigenen Kommentare
  // gehoeren und wer eine gesperrte Aufgabe umschreiben darf. `currentUserId`
  // allein reichte dafuer nicht - die Rolle steht nicht darin.
  user: null,
  assignedToMe:  false,    // nur Termine/Aufgaben zeigen, die mir zugewiesen sind
  // Gewaehlte Personen als Set von User-IDs; LEER heisst ALLE, nicht KEINE.
  //
  // DIE ACHSE IST DIE PERSON, NICHT DER KALENDER - und das ist eine gemessene
  // Entscheidung, keine Auslegung. Die Critique vom 2026-08-28 verlangte einen
  // „Kalenderfilter mit Legende" nach Apples Muster. Eine FARBLEGENDE ist hier
  // aber nicht konstruierbar: `resolveEventColor()` (utils/event-color.js)
  // beantwortet die Farbe aus DREI Quellen in Rangfolge - eigene Terminfarbe,
  // Farbe der primaeren zugewiesenen Person, Kalenderfarbe. Eine Legende, die
  // „diese Farbe = jener Kalender" behauptet, waere bei jedem Termin falsch,
  // der eine eigene Farbe traegt oder von einer Person erbt - also bei der
  // Mehrheit. Die Person dagegen ist eindeutig: sie steht in
  // `assigned_users`, ihre Farbe gehoert ihr, und in einem FAMILIENplaner ist
  // „wessen Termin ist das" die Frage, die der Filter beantworten soll.
  people:        new Set(),
};
let _container = null;

// Termin-Suche (#471): datumsunabhängiges Finden über den FTS-Index. Der
// Suchmodus blendet eine Leiste unter der Toolbar ein und ersetzt den Ansichts-
// Body durch eine chronologische Trefferliste; Schließen stellt die Ansicht her.
let searchActive  = false;
let searchQuery   = '';
let searchResults = [];
let searchTotal   = 0;

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

// Der Kalendertag eines gespeicherten Termin-Zeitpunkts in der Anzeigezone
// (#829 Teil 3). Vorher stand hier die Zone des Browsers; ein extern
// synchronisierter Termin sprang damit auf einem Gerät in einer anderen Zone auf
// den Nachbartag, während ein von Hand angelegter (zonenlose Wanduhrzeit)
// stehenblieb - zwei Termine derselben Uhrzeit an zwei Tagen.
function localDate(str) {
  if (!str || str.length <= 10) return (str || '').slice(0, 10);
  return zonedDateKey(str);
}

function validDateParam(value) {
  return DATE_KEY_RE.test(String(value || '')) ? String(value) : '';
}

function deepLinkTargetDate(initialEvent, dateParam) {
  return validDateParam(dateParam) || localDate(initialEvent?.start_datetime);
}

function findDeepLinkedOccurrence(events, initialEvent, targetDate) {
  if (!initialEvent) return null;
  return events.find(
    (ev) => ev.id === initialEvent.id && localDate(ev.start_datetime) === targetDate
  ) || initialEvent;
}

// Die Uhrzeit eines gespeicherten Termin-Zeitpunkts in der Anzeigezone (#829).
function localTime(str) {
  if (!str || str.length <= 10) return '00:00';
  return zonedTimeKey(str);
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

// Erster Tag der Woche, die `dateStr` enthält, gemäß haushaltweitem Wochenstart
// (state.weekStart als getDay()-Index). Standard Montag – wie zuvor getMondayOf.
function startOfWeekOf(dateStr, weekStart = state.weekStart) {
  const d = new Date(dateStr + 'T00:00:00');
  const diff = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - diff);
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
  return time ? `${formatDate(date)} ${time} ${timeSuffix()}`.trimEnd() : formatDate(date);
}

function eventIconName(icon) {
  const normalized = EVENT_ICON_ALIASES[icon] || icon;
  return CUSTOM_EVENT_ICONS.has(normalized) || EVENT_ICONS.some((item) => item.value === normalized)
    ? normalized
    : 'calendar';
}

/**
 * Hat dieser Termin ein EIGENES Icon - also eines, das etwas hinzufuegt?
 *
 * 'calendar' ist der Datenbank-Default der Spalte und zugleich der Rueckfall
 * von eventIconName() fuer alles Unbekannte: ein Termin, an dem nie jemand ein
 * Icon gewaehlt hat, traegt es trotzdem. Im Monat und in der Woche stoert das
 * nicht, dort steht der Chip in einem Raster voller Fremdherkunft. Im
 * Tagesraster waere es ein generisches Kalender-Glyph an jeder Zeile INNERHALB
 * des Kalenders - es sagt nichts (Herkunfts-Regel: im eigenen Raum ist die
 * Herkunft selbstverstaendlich) und kostet die Titelspalte 20px, die bei 16px
 * hohen Balken fehlen. Die Zugehoerigkeit traegt dort der Spine.
 */
function hasEventIcon(icon) {
  return eventIconName(icon) !== 'calendar';
}

function customEventIconHtml(icon, className) {
  const paths = CUSTOM_EVENT_ICON_PATHS[icon];
  if (!paths) return '';
  return `<svg class="${className} event-icon--custom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${paths.map((path) => `<path d="${path}"/>`).join('\n    ')}
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
  return '<i data-lucide="repeat" class="calendar-repeat-icon icon-sm" aria-hidden="true"></i>';
}

function eventIconElement(icon, className = 'event-icon') {
  const name = eventIconName(icon);
  const customPaths = CUSTOM_EVENT_ICON_PATHS[name];
  if (customPaths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `${className} event-icon--custom`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    for (const pathData of customPaths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      svg.append(path);
    }
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

function readDateInput(root, selector) {
  return parseDateInput(root.querySelector(selector)?.value || '');
}

function getMonthRange(dateStr) {
  const d     = new Date(dateStr + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth();
  // Start des Monats, dann bis auf den Montag zurückgehen (Kalenderraster)
  const firstOfMonth = new Date(year, month, 1);
  // Bis zum gewählten Wochenstart zurückgehen (Kalenderraster).
  const startOffset = (firstOfMonth.getDay() - state.weekStart + 7) % 7;
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - startOffset);
  const from = isoDate(gridStart);
  // 42 Tage (6 Wochen) abdecken
  const to   = addDays(from, 41);
  return { from, to };
}

function getWeekRange(dateStr) {
  const weekStart = startOfWeekOf(dateStr);
  return { from: weekStart, to: addDays(weekStart, 6) };
}

function getAgendaRange(dateStr) {
  return { from: dateStr, to: addDays(dateStr, 30) };
}

/**
 * Der Zeitraum, den eine Ansicht gerade zeigt - als Zeitraum für einen neuen
 * Termin, nicht als Ladespanne. Deshalb nicht getRangeForView(): dessen
 * Monatsspanne ist das 42-Tage-Raster und begänne im Vormonat.
 */
function visibleDayRange(view, cursor, weekStart = 1) {
  if (view === 'month')  return monthPeriodKeys(cursor);
  if (view === 'week')   {
    const from = startOfLocalWeekKey(cursor, weekStart);
    return { from, to: addLocalDays(from, 6) };
  }
  if (view === 'agenda') return { from: cursor, to: addLocalDays(cursor, 30) };
  return { from: cursor, to: cursor };                  // day: der Cursor ist der Tag
}

/**
 * Vorbelegtes Datum für einen neuen Termin, bei dem niemand einen Tag angeklickt
 * hat: Toolbar-„+", FAB, Leerzustand der Agenda (#737). Die Entscheidung selbst
 * trifft defaultDateInPeriod() - sie gilt hausweit und nicht nur hier.
 */
function newEventDefaultDate(view, cursor, today, weekStart = 1) {
  if (!cursor) return today;
  const { from, to } = visibleDayRange(view, cursor, weekStart);
  return defaultDateInPeriod(from, to, today);
}

/** newEventDefaultDate() für den aktuellen State - der Normalfall an den Aufrufstellen. */
function newEventDate() {
  return newEventDefaultDate(state.view, state.cursor, state.today, state.weekStart);
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
    const end   = eventEndDate(e);
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

/**
 * True, wenn der „Mir zugewiesen"-Filter aus ist oder das Element der eigenen
 * User-ID zugewiesen ist. Wird auf Termine und Kalender-Aufgaben angewandt.
 */
function belongsToMe(item) {
  if (!state.assignedToMe || state.currentUserId == null) return true;
  return (item.assigned_users ?? []).some((u) => u.id === state.currentUserId);
}

/**
 * True, solange der Personenfilter aus ist oder eine der gewaehlten Personen
 * zugewiesen ist.
 *
 * EIN LEERES SET HEISST „ALLE", NICHT „KEINE" - und das ist die einzige
 * Lesart, die einen Ruecknahmeweg hat. Die Umkehrung (leer = nichts zeigen)
 * haette einen Zustand erzeugt, aus dem der leere Kalender selbst nicht mehr
 * herausfuehrt: wer alle Haekchen entfernt, saehe nichts mehr und haette
 * ausserhalb des Blatts keinen Hinweis darauf, warum.
 *
 * Termine OHNE Zuweisung fallen bei aktivem Filter heraus. Das ist Absicht:
 * der Filter beantwortet „wessen Termin", und ein Termin ohne Person ist
 * keine Antwort darauf. Der Rueckweg steht im Blatt.
 */
function matchesPeopleFilter(item) {
  if (state.people.size === 0) return true;
  return (item.assigned_users ?? []).some((u) => state.people.has(u.id));
}

/** Beide Personen-Achsen in einem Praedikat - „mir" und die Auswahl. */
function passesPersonFilters(item) {
  return belongsToMe(item) && matchesPeopleFilter(item);
}

/** Wie viele Filter gerade etwas wegnehmen - die Zahl am Filterknopf. */
function activeFilterCount() {
  let n = 0;
  if (state.assignedToMe) n += 1;
  if (state.people.size > 0) n += 1;
  const hp = state.holidayPrefs ?? {};
  if (hp.holiday_show_public && !state.layerHolidays) n += 1;
  if (hp.holiday_show_school && !state.layerSchool) n += 1;
  if (!state.layerBirthdays) n += 1;
  if (scheduleEnabled() && !state.layerSchedule) n += 1;
  return n;
}

/**
 * True, solange die Ebene sichtbar ist, zu der ein Termin gehoert (#778).
 *
 * Geburtstage kommen aus den Kontakten und fuellen bei einem grossen Adressbuch
 * den Kalender mit Terminen, die niemand als Termin plant. Sie einzeln zu
 * loeschen half nicht: der naechste Abgleich legt sie wieder an - was der
 * Melder als "keeps coming back" beschrieb. Sie sind deshalb eine Ebene wie die
 * Feiertage, keine Sammlung loeschbarer Eintraege.
 *
 * `birthday_name` ist der Marker: die Leseroute haengt ihn nur an Termine, die
 * an einem Geburtstag haengen (siehe localizeBirthdayEvent).
 */
function isVisibleLayer(ev, showBirthdays = state.layerBirthdays) {
  return showBirthdays || !ev.birthday_name;
}

/** True, wenn im geladenen Bereich ueberhaupt Geburtstage liegen. */
function hasBirthdayEvents() {
  return state.events.some((e) => e.birthday_name);
}

function eventsOnDay(dateStr) {
  const list = _dayIndex.active
    ? (_dayIndex.events.get(dateStr) ?? [])
    : state.events.filter((e) => {
        const start = localDate(e.start_datetime);
        const end   = eventEndDate(e);
        return start <= dateStr && end >= dateStr;
      });
  const layered = state.layerBirthdays ? list : list.filter(isVisibleLayer);
  return layered.filter(passesPersonFilters);
}

/**
 * Letzter Kalendertag, auf dem ein Event erscheint.
 *
 * Ein Zeit-Event, das exakt um Mitternacht endet, belegt den Folgetag nicht:
 * 21:00-24:00 ist ein Freitagstermin, kein Freitag-und-Samstag-Termin (#804).
 * Ohne diese Korrektur galt das Ende als inklusiv, das Event landete im
 * Tages-Bucket des Folgetags und wurde zusaetzlich als mehrtaegig eingestuft -
 * dadurch rutschte es ueber isAllDayLike() faelschlich in die Ganztags-Zeile.
 *
 * Ganztags-Events sind bewusst ausgenommen: sie speichern ihr Ende als
 * T00:00 und meinen es INKLUSIV (eine Reise 07.-09.09. endet auf
 * '2026-09-09T00:00'). Die Regel gilt daher nur fuer Zeit-Events.
 */
function eventEndDate(ev) {
  const start = localDate(ev.start_datetime);
  if (!ev.end_datetime) return start;
  const end = localDate(ev.end_datetime);
  if (end <= start) return start;
  if (ev.all_day || !ev.end_datetime.includes('T')) return end;
  return localTime(ev.end_datetime) === '00:00' ? addDays(end, -1) : end;
}

/** True, wenn Start- und Enddatum auf verschiedene Kalendertage fallen. */
function isMultiDayEvent(ev) {
  if (!ev || !ev.start_datetime || !ev.end_datetime) return false;
  return localDate(ev.start_datetime) !== eventEndDate(ev);
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
  const endDay   = eventEndDate(ev);
  if (dayStr === startDay) return 'start';
  if (dayStr === endDay)   return 'end';
  return 'middle';
}

/**
 * Filtert Tasks: nur open/in_progress mit due_date werden angezeigt.
 * Abgelegte bleiben draußen - der Server liefert sie hier ohnehin nicht mehr mit
 * (#688), die Prüfung steht als Rückfalllinie für vorgefüllte Listen.
 */
function filterTasksForCalendar(tasks) {
  return tasks.filter(
    (t) => t.due_date && t.status !== 'done' && !t.archived_at
  );
}

/** Tasks, die an einem bestimmten Tag fällig sind. */
function tasksOnDay(dateStr) {
  const list = _dayIndex.active
    ? (_dayIndex.tasks.get(dateStr) ?? [])
    : state.tasks.filter((t) => t.due_date === dateStr);
  return list.filter(passesPersonFilters);
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

/** Rendert einen read-only Task-Chip für Kalenderansichten. In der Monatsansicht
 *  (interactive:false) ist die Tageszelle selbst der Drill-in-Button; die Chips
 *  sind dort nur visuelles Signal und dürfen kein eigenes role/tabindex tragen -
 *  sonst entsteht ein fokussierbarer Button im Zellen-Button (Audit P1).
 *  icon:false lässt das check-square-Icon weg: die Monats-Bars sind nach Kanon
 *  icon-frei, Woche/Tag/Agenda behalten es als Termin/Aufgabe-Unterscheidung. */
function renderTaskChip(task, { interactive = true, icon = true } = {}) {
  const priority = task.priority || 'none';
  const label    = esc(task.title);
  const timeStr  = task.due_time ? ` · ${task.due_time.slice(0, 5)}` : '';
  const button   = interactive
    ? ` role="button" tabindex="0" aria-label="${esc(t('calendar.taskChipAriaLabel', { title: task.title }))}"`
    : '';
  // Die Prioritaet steht als Rangmarke im Punkt (list-row.css), nicht mehr als
  // getoentes Feld mit getoenter Schrift: dieselbe Stufe, die die Aufgabenliste
  // seit v2.23.0 so zeigt. „Ohne" bekommt keinen Punkt - eine Marke fuer eine
  // Abwesenheit waere eine fuenfte Stufe.
  const dot = priority !== 'none'
    ? `<span class="priority-dot priority-dot--${priority}" aria-hidden="true"></span>`
    : '';
  return `<div class="cal-task-chip cal-task-chip--${priority}"
               data-task-id="${task.id}"${button}
               title="${label}${esc(timeStr)}">
    ${icon ? '<i data-lucide="check-square" class="icon-sm" aria-hidden="true"></i>' : ''}
    ${dot}
    <span>${label}${esc(timeStr)}</span>
  </div>`;
}

// --------------------------------------------------------
// API
// --------------------------------------------------------

/**
 * Ladefenster mit einem Tag Rand an beiden Seiten.
 *
 * Extern synchronisierte Termine liegen als UTC in der Datenbank
 * (`2035-03-13T02:00:00Z`), der Serverfilter vergleicht deren UTC-Kalendertag
 * gegen die lokalen Tagesschluessel dieser Ansicht. Westlich von UTC faellt ein
 * Abendtermin dadurch auf den UTC-Folgetag und aus einem Fenster heraus, das
 * genau die angezeigten Tage umfasst: in der Tagesansicht (Fenster = ein Tag)
 * fehlte er komplett, in Woche und Monat nur am Rand (#824).
 *
 * Der Rand deckt jeden realen Zeitzonenversatz (UTC-12..UTC+14) ab. Welche
 * Termine wirklich auf einen Tag gehoeren, entscheidet ohnehin erst
 * buildDayIndex() lokal - dort klammert state.rangeFrom/rangeTo auf das
 * Anzeigefenster, weshalb die Randtage nichts Fremdes einblenden.
 */
function fetchWindow(from, to) {
  return { from: addLocalDays(from, -1), to: addLocalDays(to, 1) };
}

async function loadRange(from, to) {
  const win     = fetchWindow(from, to);
  const calPath = `/calendar?from=${win.from}&to=${win.to}`;
  try {
    const [evRes, taskRes, holRes, scheduleRes] = await Promise.all([
      api.get(calPath),
      api.get("/tasks?include_future=1").catch((err) => { console.warn("[Calendar] Tasks fetch failed:", err); return { data: [] }; }),
      api.get(`/calendar/holidays?from=${from}&to=${to}`).catch(() => ({ data: [] })),
      scheduleEnabled()
        ? api.get(`/schedule/entries?from=${from}&to=${to}`).catch(() => ({ data: { entries: [] } }))
        : Promise.resolve({ data: { entries: [] } }),
    ]);
    state.loadError = null;
    state.events = (evRes.data ?? []).map(localizeBirthdayEvent);
    state.tasks = filterTasksForCalendar(taskRes.data ?? []);
    state.holidays = holRes.data ?? [];
    state.scheduleEntries = scheduleRes.data?.entries ?? [];
    state.scheduleWarnings = scheduleRes.data?.warnings ?? [];
    state.offlineSince = navigator.onLine ? null : await getCachedAt(calPath);
  } catch (err) {
    console.error('[Calendar] loadRange Fehler:', err);
    // Der Toast allein liess ein leeres Monatsgitter stehen - nicht zu
    // unterscheiden von einem Monat ohne Termine - und in der Agenda den
    // Leerzustand „Keine Termine" samt „Neuer Termin". Dieselbe Verwechslung,
    // die Einkauf und Essensplan 2026-07-30 hatten (Critique P0). `renderView`
    // prueft das Feld jetzt vor allen vier Ansichten.
    state.loadError = err;
    state.events   = [];
    state.tasks    = [];
    state.holidays = [];
    state.scheduleEntries = [];
    state.offlineSince = null;
  }
  state.rangeFrom = from;
  state.rangeTo   = to;
}

/**
 * Eine Aufgabe aus dem Kalender öffnen (#918).
 *
 * Bis dahin sprang ein Klick auf einen Aufgaben-Chip ins Aufgabenmodul: Der
 * Kalender war weg, der Monat, den man gerade las, auch, und der Weg zurück
 * ging über die Navigation. Für das Abhaken einer Aufgabe, die man auf ihrem
 * Tag stehen sieht, war das der ganze Vorgang.
 *
 * Jetzt öffnet dieselbe Leseansicht, die das Aufgabenmodul öffnet - über den
 * einen Einstieg dort, nicht über eine zweite, kleinere Fassung hier. Das
 * Modul wird dafür nachgeladen und nicht mit importiert: Es zieht das
 * Aufgabenformular mit sich, und dessen Gewicht gehört nicht in den Start des
 * Kalenders.
 *
 * Nach einer Änderung wird der sichtbare Bereich neu geholt statt nur neu
 * gezeichnet: Abhaken, Ablegen und Löschen ändern, WELCHE Aufgaben auf einem
 * Tag stehen, nicht nur wie sie aussehen.
 */
async function openTaskFromCalendar(taskId) {
  try {
    const { openTaskById } = await import('/pages/tasks.js');
    await openTaskById(taskId, {
      user: state.user,
      container: _container,
      onChanged: async () => {
        await loadRange(state.rangeFrom, state.rangeTo);
        renderView();
      },
    });
  } catch (err) {
    console.error('[Calendar] Aufgabe konnte nicht geöffnet werden:', err);
    window.yuvomi?.showToast(err.message ?? t('tasks.loadError'), 'danger');
  }
}

/**
 * Nur die Kalender-Events des aktuellen Bereichs neu laden (ohne Tasks/Feiertage).
 * Für serienweite Bearbeitungen (#532), bei denen sich lediglich die Expansion
 * ändert - vermeidet das Überholen unveränderter Tasks/Feiertage aus loadRange.
 */
async function reloadCalendarEventsOnly() {
  if (!state.rangeFrom || !state.rangeTo) return;
  try {
    const win = fetchWindow(state.rangeFrom, state.rangeTo);
    const res = await api.get(`/calendar?from=${win.from}&to=${win.to}`);
    state.events = (res.data ?? []).map(localizeBirthdayEvent);
  } catch (err) {
    console.error('[Calendar] reloadCalendarEventsOnly Fehler:', err);
  }
}

/**
 * Liest den x-cached-at-Zeitstempel einer offline bedienten API-Antwort aus dem
 * Service-Worker-API-Cache. Findet den Cache versionsunabhängig per Prefix.
 * @returns {Promise<Date|null>}
 */
async function getCachedAt(path) {
  if (typeof caches === 'undefined') return null;
  try {
    const names    = await caches.keys();
    const apiCache = names.find((n) => n.startsWith('yuvomi-api-'));
    if (!apiCache) return null;
    const cache = await caches.open(apiCache);
    const res   = await cache.match(`/api/v1${path}`);
    const ts    = res?.headers.get('x-cached-at');
    const ms    = ts ? Number(ts) : NaN;
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
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
  // Die Uhr des Haushalts: state.today markiert die Heute-Zelle, die Jetzt-Linie
  // und den Vorschlag fuer einen neuen Termin - alle drei muessen denselben Tag
  // meinen wie die Termine daneben (#829 Teil 3).
  state.today  = todayKey();
  state.cursor = state.today;
  state.view   = defaultCalendarView();

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="calendar-page app-page app-page--full" id="calendar-page" data-composition="full">
      <div class="page-toolbar page-toolbar--wrap cal-toolbar" id="cal-toolbar"></div>
      <div id="cal-body" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>
      <button class="page-fab" id="fab-new-event" aria-label="${t('calendar.newEvent')}" data-dock-label="${t('newLabel.calendar')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  // Lade-Skeleton sofort einblenden, damit der erste Frame nicht leer bleibt,
  // während Termine/Präferenzen laden (Sichtbarkeit des Systemstatus). Wird von
  // renderView() beim ersten Render ersetzt; aria-busy quittiert den Ladezustand.
  const bodyEl = container.querySelector('#cal-body');
  bodyEl.setAttribute('aria-busy', 'true');
  bodyEl.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));

  const params    = new URLSearchParams(window.location.search);
  const openId    = params.get('open');
  const dateParam = validDateParam(params.get('date'));
  let initialEvent = null;
  if (openId && /^\d+$/.test(openId)) {
    try {
      const eventRes = await api.get(`/calendar/${openId}`);
      if (eventRes?.data) {
        initialEvent = localizeBirthdayEvent(eventRes.data);
        state.cursor = deepLinkTargetDate(initialEvent, dateParam);
      } else {
        console.warn('[Calendar] Deep-link event not found:', openId);
      }
    } catch (err) {
      console.warn('[Calendar] Deep-link event load failed:', err);
    }
  }

  const { from, to } = getRangeForView(state.view, state.cursor);
  const [,, prefsRes, documentOptionsRes] = await Promise.all([
    loadRange(from, to),
    loadUsers(),
    api.get('/preferences').catch(() => ({ data: {} })),
    api.get('/documents/meta/options').catch(() => ({ data: {} })),
  ]);
  state.holidayPrefs  = prefsRes.data ?? {};
  state.weekStart     = weekStartIndex(prefsRes.data?.week_start);
  state.defaultDuration = Number(prefsRes.data?.calendar_default_duration) || 60;
  // Standardwerte für neue Termine (#497/#498).
  state.defaultReminders = Array.isArray(prefsRes.data?.calendar_default_reminders)
    ? prefsRes.data.calendar_default_reminders.map(Number)
    : [];
  state.defaultAssignMe  = !!prefsRes.data?.calendar_default_assign_me;
  // Standard-Sync-Ziel für eigene neue Termine (#620).
  state.defaultSyncTarget = prefsRes.data?.calendar_default_target || '';
  state.documentUploadBackend = documentOptionsRes.data?.active_upload_backend ?? 'local';
  state.layerHolidays = localStorage.getItem(LAYER_HOLIDAYS_KEY) !== 'false';
  state.layerSchool   = localStorage.getItem(LAYER_SCHOOL_KEY)   !== 'false';
  state.layerBirthdays = localStorage.getItem(LAYER_BIRTHDAYS_KEY) !== 'false';
  state.layerSchedule = localStorage.getItem(LAYER_SCHEDULE_KEY) !== 'false';
  state.scheduleDisplay = localStorage.getItem(SCHEDULE_DISPLAY_KEY) === 'blocks' ? 'blocks' : 'compact';
  state.currentUserId = user?.id ?? null;
  state.user          = user ?? null;
  state.assignedToMe  = localStorage.getItem(ASSIGNED_TO_ME_KEY) === '1';
  state.people = restorePeopleFilter(state.users);

  renderToolbar();
  renderView();
  bodyEl.removeAttribute('aria-busy');

  findPageFab('fab-new-event')?.addEventListener('click', () => openEventModal({ mode: 'create', date: newEventDate() }));

  if (initialEvent) {
    const targetDate = deepLinkTargetDate(initialEvent, dateParam);
    const occurrence = findDeepLinkedOccurrence(state.events, initialEvent, targetDate);

    const chip =
      container.querySelector(`[data-date="${CSS.escape(targetDate)}"] [data-id="${CSS.escape(openId)}"]`)
      ?? container.querySelector(`[data-id="${CSS.escape(openId)}"]`);

    if (chip) {
      chip.scrollIntoView({ block: 'center', behavior: 'instant' });
      openEventDetail(occurrence, chip);
    } else {
      // Kein sichtbarer Chip (Termin außerhalb der aktuellen Ansicht): Der
      // Deep-Link landet trotzdem in der Leseansicht, nur ohne Verankerung.
      openEventDetail(occurrence);
    }
  }
}

// --------------------------------------------------------
// Toolbar
// --------------------------------------------------------

function renderToolbar() {
  const bar = _container.querySelector('#cal-toolbar');
  if (!bar) return;

  // DIE EBENEN WOHNEN IM BLATT, NICHT IM KOPF (2026-08-28).
  //
  // Hier standen bis zu fuenf Chips plus den „Mir zugewiesen"-Schalter und
  // belegten damit eine eigene Kopfzeile - gemessen 56px auf 390px, also
  // 6,6% der Viewporthoehe, fuer Bedienelemente, die unter 640px ihr Label
  // verloren und deren An/Aus-Zustand eine Flaeche von 1,085:1 war. Was hier
  // bleibt, ist ein Knopf mit der ZAHL der aktiven Filter: er beantwortet die
  // einzige Frage, die der Kopf beantworten muss („nehme ich gerade etwas
  // weg?"), und der Rest steht beschriftet im Blatt (openCalendarFilters).
  const filterCount = activeFilterCount();

  // DIE UEBERLAPPUNGSWARNUNG BLEIBT IM KOPF. Sie ist eine Meldung mit
  // `role="status"`, kein Filter - im Blatt waere sie hinter einem Klick
  // versteckt, und eine Warnung, die man erst oeffnen muss, ist keine.
  const scheduleWarningHtml = (scheduleEnabled() && state.scheduleWarnings.length) ? `
    <span class="cal-toolbar__schedule-warning" role="status"
          title="${esc(t('schedule.overlapWarning', { date: state.scheduleWarnings[0].date_key, user: scheduleOwnerName(state.scheduleWarnings[0]) }))}">
      <i data-lucide="triangle-alert" class="icon-sm" aria-hidden="true"></i>
      <span>${t('schedule.overlapWarningShort')}</span>
    </span>
  ` : '';

  const filterBtnHtml = `
    ${scheduleWarningHtml}
    <button class="btn btn--icon cal-toolbar__filter-btn ${filterCount ? 'cal-toolbar__filter-btn--active' : ''}"
            id="cal-filters" aria-label="${filterCount ? esc(t('calendar.filtersActive', { count: filterCount })) : t('calendar.filtersOpen')}"
            title="${t('calendar.filters')}" aria-haspopup="dialog">
      <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
      ${filterCount ? `<span class="cal-toolbar__filter-count" aria-hidden="true">${filterCount}</span>` : ''}
    </button>
  `;

  bar.replaceChildren();
  bar.insertAdjacentHTML('beforeend', `
    <h1 class="page-toolbar__title">${t('calendar.title')}</h1>
    <div class="page-toolbar__center cal-toolbar__month">
      <button class="btn btn--secondary cal-toolbar__today" id="cal-today">${t('calendar.today')}</button>
      <button class="btn btn--icon" id="cal-prev" aria-label="${t('calendar.back')}">
        <i data-lucide="chevron-left" aria-hidden="true"></i>
      </button>
      <span class="cal-toolbar__label" id="cal-label"></span>
      <button class="btn btn--icon" id="cal-next" aria-label="${t('calendar.forward')}">
        <i data-lucide="chevron-right" aria-hidden="true"></i>
      </button>
    </div>
    <div class="page-toolbar__actions">
      ${filterBtnHtml}
      <!-- KEIN aria-controls im geschlossenen Zustand: die Suchleiste entsteht
           erst beim Öffnen (openCalendarSearch), und ein Verweis auf eine ID, die
           es noch nicht gibt, kündigt einem Screenreader ein Ziel an, das nicht
           existiert. Gesetzt wird es dort, wo die Leiste entsteht, und beim
           Schließen wieder entfernt - dieselbe Regel wie in utils/sub-tabs.js:
           ohne aufgelöstes Ziel bleibt das Attribut weg. -->
      <button class="btn btn--icon cal-toolbar__search-btn" id="cal-search"
              aria-label="${t('calendar.searchOpen')}" title="${t('calendar.searchOpen')}"
              aria-expanded="false">
        <i data-lucide="search" aria-hidden="true"></i>
      </button>
      <button class="btn btn--primary toolbar-new-btn" id="cal-add" aria-label="${t('calendar.addEvent')}">
        <i data-lucide="plus" aria-hidden="true"></i>
        <span class="toolbar-new-btn__label">${t('newLabel.calendar')}</span>
      </button>
    </div>
    <!-- Bar-Zeile des Kopfs (Werkzeugzeilen-Regel, layout.css): das Ansichts-
         Segment hatte im Actions-Slot bei 1280px 212px fuer 245px Inhalt -
         "Agenda" lag hinter dem Fade und das Monatslabel daneben ellipsierte
         auf seine 7ch-Untergrenze. Der neutrale Wrapper haelt das Well des
         Segments auf intrinsischer Breite; die Zeile gehoert trotzdem ihm. -->
    <div class="page-toolbar__bar">
      <div class="cal-toolbar__views" role="tablist" aria-label="${t('nav.calendar')}">
        ${VIEWS.map((v) => `
          <button class="cal-toolbar__view-btn ${v === state.view ? 'cal-toolbar__view-btn--active' : ''}"
                  role="tab" id="cal-view-tab-${v}" data-tab-id="${v}"
                  aria-selected="${v === state.view ? 'true' : 'false'}"
                  ${v === state.view ? 'aria-controls="cal-body"' : ''}
                  tabindex="${v === state.view ? '0' : '-1'}">${VIEW_LABELS()[v]}</button>
        `).join('')}
      </div>
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: bar });

  updateLabel();

  bar.querySelector('#cal-prev').addEventListener('click', () => navigate(-1));
  bar.querySelector('#cal-next').addEventListener('click', () => navigate(1));
  bar.querySelector('#cal-today').addEventListener('click', goToday);
  bar.querySelector('#cal-add').addEventListener('click', () => openEventModal({ mode: 'create', date: newEventDate() }));
  bar.querySelector('#cal-search').addEventListener('click', openCalendarSearch);
  bar.querySelector('#cal-filters').addEventListener('click', openCalendarFilters);

  // EIN wireScrollFade auf diesem Element, nicht zwei.
  //
  // Es stand hier oben UND unten am Tablist-Block - beide Male auf
  // `.cal-toolbar__views`, beide Rueckgabewerte verworfen. Der Helfer ist
  // nicht idempotent (utils/ux.js): jeder Aufruf haengt einen Scroll-Listener,
  // einen ResizeObserver und einen MutationObserver mit `subtree: true` an.
  // `renderToolbar()` laeuft bei jedem Filterwechsel erneut, also wuchs die
  // Zahl der Beobachter mit der Benutzung. Der Aufruf gehoert an den Ort, an
  // dem auch die Tablist verdrahtet wird - dort steht er jetzt, einmal.
  wireScrollFade(bar.querySelector('.cal-toolbar__views'));
  viewTabs = wireTablist(bar.querySelector('.cal-toolbar__views'), {
    activeId: state.view,
    activeClass: 'cal-toolbar__view-btn--active',
    onChange: async (view) => {
      if (searchActive) closeCalendarSearch({ restoreView: false });
      state.view = view;
      setSavedCalendarView(view);
      await reloadForView();
      updateLabel();
      renderView();
    },
  });
}

function updateLabel() {
  const lbl = _container.querySelector('#cal-label');
  if (!lbl) return;
  const d    = new Date(state.cursor + 'T00:00:00');
  const year = d.getFullYear();
  const mon  = MONTH_NAMES()[d.getMonth()];

  if (state.view === 'month')  lbl.textContent = `${mon} ${year}`;
  if (state.view === 'week') {
    // Mobil zeigt die "Woche" ein 3-Tage-Fenster um den Cursor (renderWeekView);
    // ein "KW 30"-Label würde dann einen Bereich behaupten, der nicht zu sehen
    // ist (Audit A1-19). Das Label nennt stattdessen den sichtbaren Bereich.
    lbl.textContent = window.matchMedia(MOBILE_MEDIA_QUERY).matches
      ? t('calendar.dayRangeLabel', { from: formatDayMonth(addDays(state.cursor, -1)), to: formatPreferredDate(addDays(state.cursor, 1)) })
      : t('calendar.weekNumberLabel', { week: getWeekNumber(state.cursor), month: mon, year });
  }
  if (state.view === 'day')    lbl.textContent = formatDate(state.cursor, { weekday: true, long: true });
  if (state.view === 'agenda') lbl.textContent = t('calendar.agendaFrom', { date: formatDate(state.cursor) });

  syncTodayButton();
  syncViewPanel();
}

/**
 * DER KOERPER IST DAS PANEL DER TABLEISTE - EINES, NICHT VIER.
 *
 * Die Leiste trug `role="tablist"` mit vier `role="tab"`, aber es gab kein
 * `role="tabpanel"` im Dokument und kein `aria-controls`: fuer einen
 * Screenreader endete die Beziehung beim Tab, und was er umschaltet, stand
 * nirgends.
 *
 * Der geteilte Helfer `syncTabPanels` (utils/sub-tabs.js) passt hier nicht,
 * und das ist kein Versehen: er verwaltet N Panels und versteckt die
 * inaktiven per `hidden`. Der Kalender hat EIN `#cal-body`, dessen INHALT bei
 * jedem Wechsel ersetzt wird - es gibt kein zweites Panel zum Verstecken. Die
 * Beziehung ist deshalb umgekehrt gerichtet: das Panel nennt den Tab, der es
 * gerade beschriftet, und nur der aktive Tab traegt `aria-controls`. Ein
 * inaktiver Tab, der auf dasselbe Panel zeigt, waere die Zusage, dass es
 * SEINEN Inhalt enthaelt - und die ist falsch.
 */
function syncViewPanel() {
  const body = _container?.querySelector('#cal-body');
  if (!body) return;
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', `cal-view-tab-${state.view}`);

  for (const btn of _container.querySelectorAll('.cal-toolbar__view-btn')) {
    if (btn.dataset.tabId === state.view) btn.setAttribute('aria-controls', 'cal-body');
    else btn.removeAttribute('aria-controls');
  }
}

/**
 * „HEUTE" ERSCHEINT NUR, WENN HEUTE NICHT ZU SEHEN IST.
 *
 * Ein Knopf, der an den aktuellen Zeitraum zurueckfuehrt, ist sinnlos, solange
 * man dort steht - Apple Kalender und Fantastical blenden ihn genau dann aus.
 * Hier ist er ausserdem die Gegenmassnahme zu `flex-basis: 0` am Center-Slot
 * (layout.css): der engere Slot kappt das Zeitraum-Label sonst auf seine
 * 7ch-Untergrenze, und die 66px dieses Knopfes sind genau die, die fehlen.
 *
 * `hidden` STATT ENTFERNEN, und das ist der Punkt: der Slot behaelt seine
 * Basis 0 und bleibt in der Titelzeile, egal ob der Knopf da ist. Die
 * KOPFHOEHE springt beim Navigieren damit nicht - nur die Labelbreite aendert
 * sich. Ein Kopf, der beim Blaettern seine Hoehe wechselt, waere derselbe
 * Fehler, den die kollabierende Leiste mit ihrem negativen `top` vermeidet.
 *
 * Die Frage „ist heute zu sehen" beantwortet der ANGEZEIGTE BEREICH, nicht
 * eine Fallunterscheidung je Ansicht: `getRangeForView` kennt ihn fuer alle
 * vier, und eine zweite Rechnung daneben waere die naechste Stelle, an der
 * Monat und Agenda auseinanderlaufen.
 */
function syncTodayButton() {
  const btn = _container.querySelector('#cal-today');
  if (!btn) return;
  const { from, to } = getRangeForView(state.view, state.cursor);
  btn.hidden = state.today >= from && state.today <= to;
}

function getWeekNumber(dateStr) {
  // ISO-8601: Woche 1 enthält den ersten Donnerstag des Jahres; Wochen beginnen
  // montags. Verhindert die Off-by-one-Abweichung des naiven Jan-1-Ansatzes an
  // Jahresgrenzen.
  const d = new Date(dateStr + 'T00:00:00');
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mo=0 … So=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Donnerstag dieser Woche
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

async function navigate(dir) {
  if (searchActive) closeCalendarSearch({ restoreView: false });
  if (state.view === 'month') {
    state.cursor = addMonths(state.cursor, dir);
  } else if (state.view === 'week') {
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
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
  if (searchActive) closeCalendarSearch({ restoreView: false });
  state.cursor = state.today;
  await reloadForView();
  updateLabel();
  renderView();
}

/**
 * Drill-in aus einer Tageszelle - EINE NAVIGATION, KEINE EINSTELLUNG.
 *
 * Hier stand `setSavedCalendarView('day')`. Eine Geste, die „zeig mir diesen
 * Tag" meint, schrieb damit still die STANDARDANSICHT des Kalenders um: wer
 * dreimal auf eine Monatszelle tippte, oeffnete den Kalender fortan in der
 * Tagesansicht und bekam dafuer weder eine Rueckmeldung noch einen Rueckweg -
 * verifiziert, `yuvomi:calendar:view` stand nach einem Tap auf `"day"` und
 * ueberlebte den Reload.
 *
 * `state.view` und `viewTabs.sync` wechseln die Ansicht fuer die Sitzung, und
 * genau das ist gemeint. Gespeichert wird die Ansicht nur dort, wo der Nutzer
 * sie WAEHLT: im `onChange` der Tablist.
 */
async function switchToDayView(date) {
  state.cursor = date;
  state.view = 'day';
  viewTabs?.sync('day');
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

// Dezenter Offline-Hinweis oberhalb der Toolbar: zeigt den letzten Cache-Stand,
// wenn der Kalender offline aus dem Service-Worker-Cache bedient wurde.
function updateOfflineNotice() {
  const page = _container?.querySelector('#calendar-page');
  if (!page) return;
  const existing = page.querySelector('#cal-offline-notice');

  if (!state.offlineSince) {
    existing?.remove();
    return;
  }

  const stamp = `${formatPreferredDate(state.offlineSince)} ${formatTime(state.offlineSince)}`.trim();
  const label = t('offline.staleData', { time: stamp });

  if (existing) {
    const span = existing.querySelector('.cal-offline-notice__text');
    if (span) span.textContent = label;
    return;
  }

  const toolbar = page.querySelector('#cal-toolbar');
  const html = `
    <div class="cal-offline-notice" id="cal-offline-notice" role="status">
      <i data-lucide="cloud-off" class="icon-sm" aria-hidden="true"></i>
      <span class="cal-offline-notice__text">${esc(label)}</span>
    </div>`;
  if (toolbar) toolbar.insertAdjacentHTML('beforebegin', html);
  else page.insertAdjacentHTML('afterbegin', html);
  if (window.lucide) lucide.createIcons({ el: page.querySelector('#cal-offline-notice') });
}

// --------------------------------------------------------
// Monatszellen-Kapazität (Audit P2)
// --------------------------------------------------------

// Render-Puffer je Zelle; wie viele Chips sichtbar bleiben, entscheidet
// fitMonthDayCells aus der realen Zellhöhe. Der Deckel begrenzt nur das DOM an
// extrem vollen Tagen (>14 Items) - "+N" zählt via data-total trotzdem korrekt.
const MONTH_DAY_MAX_CHIPS = 14;

let _monthGridResizeObserver = null;
let _monthFitRaf = 0;

// Sichtbare Chip-Zahl je Monatszelle aus der REALEN Zellhöhe ableiten. Weil
// grid-auto-rows:1fr die Zellhöhe inhaltsunabhängig macht (per Grid verteilt,
// variiert mit dem Viewport), ist die Messung stabil: Chips zu verstecken ändert
// die Zellhöhe nicht. Der letzte Platz bleibt immer für die "+N"-Zeile reserviert,
// damit nie ein Chip mittig abschneidet (vorher: festes Budget=3 clippte still).
function fitMonthDayCells(grid) {
  if (!grid) return;

  // DREI PHASEN STATT EINER SCHLEIFE MIT LESE-/SCHREIB-WECHSEL. Vorher lief je
  // Zelle Schreiben → Messen → Schreiben → Messen, über bis zu 42 Zellen also
  // mehrere erzwungene Reflows pro Durchlauf (Audit 2026-08-31, der eine
  // Thrash-Kandidat der Codebase). Jetzt schreiben alle Zellen zuerst ihren
  // Messzustand, dann misst EIN Layoutlauf alles, dann fallen die
  // Entscheidungen. Die "+N"-Zeile darf dafür vorab sichtbar sein: sie steht
  // NACH den Chips und verschiebt deren Unterkanten nicht, und ihre Höhe ist
  // einzeilig textunabhängig - die Endzustände sind mit der alten Fassung
  // identisch (leer/fitsAll → Zeile versteckt und geleert).
  const cells = [];
  for (const cell of grid.querySelectorAll('.month-day')) {
    const chips   = [...cell.querySelectorAll('.month-day__holiday, .month-day__event, .cal-task-chip')];
    const moreRow = cell.querySelector('.month-day__more');
    if (!moreRow) continue;
    const total = Number(cell.dataset.total) || chips.length;

    // Reset auf vollständig sichtbar für eine stabile Messung.
    chips.forEach((c) => c.classList.remove('is-clipped'));
    moreRow.hidden = !chips.length;
    moreRow.textContent = chips.length ? t('calendar.moreEvents', { count: total }) : '';
    if (chips.length) cells.push({ cell, chips, moreRow, total });
  }

  // Messphase: der erste Zugriff erzwingt EINEN Reflow, der Rest liest mit.
  for (const item of cells) {
    const cs        = getComputedStyle(item.cell);
    item.cellBottom = item.cell.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom);
    item.reserved   = item.cellBottom - item.moreRow.getBoundingClientRect().height;
    item.bottoms    = item.chips.map((c) => c.getBoundingClientRect().bottom);
  }

  for (const { chips, moreRow, total, bottoms, cellBottom, reserved } of cells) {
    // Passt alles rein (inkl. evtl. nicht gerenderter Überzähliger)? Dann fertig.
    const fitsAll = total <= chips.length && bottoms[bottoms.length - 1] <= cellBottom;
    if (fitsAll) {
      moreRow.hidden = true;
      moreRow.textContent = '';
      continue;
    }

    // Platz für die "+N"-Zeile freihalten (einzeilig, Höhe unabhängig von N).
    let visible = 0;
    for (const bottom of bottoms) {
      if (bottom <= reserved) visible += 1;
      else break;
    }
    visible = Math.max(1, visible); // nie ganz leer wirken lassen

    chips.forEach((chip, i) => chip.classList.toggle('is-clipped', i >= visible));
    const hiddenCount = total - visible;
    if (hiddenCount > 0) {
      moreRow.textContent = t('calendar.moreEvents', { count: hiddenCount });
    } else {
      moreRow.hidden = true;
      moreRow.textContent = '';
    }
  }
}

// Neurechnung per rAF drosseln: der ResizeObserver kann beim Fensterziehen
// mehrfach pro Frame feuern; ein fit pro Frame reicht.
function scheduleMonthFit(grid) {
  if (_monthFitRaf) return;
  _monthFitRaf = requestAnimationFrame(() => {
    _monthFitRaf = 0;
    fitMonthDayCells(grid);
  });
}

function renderView() {
  const body = _container.querySelector('#cal-body');
  if (!body) return;
  /* Das Lesemass der Seite folgt der ANSICHT, denn hier wechselt der Koerper
   * seine Natur: die Agenda ist eine Zeilenliste und will die Lesebahn, das
   * Monatsgitter ist eine Flaeche und will die ganze Content-Spalte. Ein
   * fester Modifier stimmte in genau einer der vier Ansichten - dieselbe
   * Kopplung wie auf /tasks (Liste gegen Kanban), und derselbe Guard prueft
   * sie (Critique 2026-08-13, zweite Runde).
   *
   * DER KOPF TOGGELT NICHT MEHR MIT (2026-08-27): er steht ueber vier
   * Koerpern, drei davon full-bleed, und seit die Ansichts-Umschalter in der
   * Bar-Zeile wohnen (Werkzeugzeilen-Regel) kann seine volle Titelzeile im
   * 720er-Deckel der Agenda nicht einzeilig wohnen (Sonde 19: zwei Zeilen
   * bei 1280px). EIN Kopf, EINE Breite - er haelt die Kante seines
   * breitesten Koerpers; die Agenda-LISTE behaelt ihre Lesebahn. Der
   * Kanten-Guard kennt diese Bauart (test-frontend-audit: Lesemass-Toggle
   * am Koerper ohne Kopf-Toggle). */
  _container.querySelector('#calendar-page')
    ?.classList.toggle('is-reading-measure', state.view === 'agenda');
  // Monats-Resize-Observer lösen, bevor das alte #month-grid detached wird;
  // nur die Monatsansicht setzt ihn danach wieder auf.
  _monthGridResizeObserver?.disconnect();
  _monthGridResizeObserver = null;
  body.replaceChildren();

  // Vor allen vier Ansichten: nach einem Ladefehler sind Termine, Aufgaben und
  // Feiertage ebenfalls leer. Das Gitter waere dann von einem leeren Monat
  // nicht zu unterscheiden, die Agenda zeigte ihren Leerzustand.
  if (state.loadError) {
    mountLoadError(body, {
      title: t('calendar.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => { await loadRange(state.rangeFrom, state.rangeTo); renderView(); },
    });
    updateOfflineNotice();
    return;
  }

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
  updateOfflineNotice();
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
  // Bis zum gewählten Wochenstart zurückgehen.
  const startOffset = (firstDay.getDay() - state.weekStart + 7) % 7;

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
        ${weekdayOrder(state.weekStart).map((idx) => `<div class="month-weekday">${DAY_NAMES_SHORT()[idx]}</div>`).join('')}
      </div>
      <div class="month-grid page-scrollport" id="month-grid">
        ${days.map(({ date, inMonth }) => renderMonthDay(date, inMonth)).join('')}
      </div>
    </div>
  `);

  const grid = container.querySelector('#month-grid');
  grid.addEventListener('click', (e) => {
    const dayEl = e.target.closest('.month-day');
    if (!dayEl) return;

    // Mobil ist die ganze Zelle EIN Drill-in-Ziel: die Chips sind dort zu
    // Punkten reduziert (reines "etwas ist los"-Signal), ein Tap darf nie in
    // einem Event-Popup enden statt in der handlungsfähigen Tagesansicht (P1).
    // Desktop behält die feinere Interaktion: Chip -> Ziel, Zelle -> Tag.
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    if (!isMobile) {
      const taskChip = e.target.closest('.cal-task-chip');
      if (taskChip) {
        e.stopPropagation();
        openTaskFromCalendar(taskChip.dataset.taskId);
        return;
      }
      const evEl = e.target.closest('.month-day__event');
      if (evEl) {
        e.stopPropagation();
        const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
        if (ev) openEventDetail(ev, evEl);
        return;
      }
    }
    switchToDayView(dayEl.dataset.date);
  });

  // Tastatur-Aktivierung der Tageszelle (role="button"): Enter/Space -> Tag.
  // Nur wenn der Fokus auf der Zelle selbst liegt; innere Chips tragen desktop
  // ihre eigene Semantik und werden hier nicht abgefangen (Audit P1).
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const dayEl = e.target.closest('.month-day');
    if (!dayEl || e.target !== dayEl) return;
    e.preventDefault();
    switchToDayView(dayEl.dataset.date);
  });

  // Sichtbare Kapazität je Zelle aus der realen Höhe ableiten und bei Viewport-
  // Änderungen (Fenster-Resize, Sidebar-Toggle) neu rechnen (Audit P2). Der
  // ResizeObserver feuert nach observe() initial einmal -> erster fit nach Paint.
  _monthGridResizeObserver?.disconnect();
  _monthGridResizeObserver = new ResizeObserver(() => scheduleMonthFit(grid));
  _monthGridResizeObserver.observe(grid);
}

/**
 * Klassen einer Monatszelle - eigene Funktion, weil hier der Wochentag über den
 * Tag selbst entschieden wird und nicht über seine Spalte im Raster. Die
 * Wochenend-Tönung hing früher an `:nth-child(7n)`/`7n-1` im CSS, was nur bei
 * Wochenstart Montag Sa/So traf: bei Sonntag-Start färbte sie Fr/Sa (#780).
 */
function monthDayClasses(date, inMonth, todayKey = state.today) {
  return [
    'month-day',
    !inMonth            ? 'month-day--outside' : '',
    date === todayKey   ? 'month-day--today'   : '',
    isWeekendKey(date)  ? 'month-day--weekend' : '',
  ].filter(Boolean).join(' ');
}

function renderMonthDay(date, inMonth) {
  const evs      = eventsOnDay(date);
  const dayTasks = tasksOnDay(date);
  const dayHols  = holidaysOnDay(date);
  const daySchedule = state.layerSchedule ? scheduleDayGroups(state.scheduleEntries.filter((entry) => entry.date_key === date && entry.shift_type)) : [];
  const isToday  = date === state.today;
  const classes  = monthDayClasses(date, inMonth);

  // Alle Chips (Feiertagsband, Termine, Aufgaben) bis zu einem großzügigen Puffer
  // ins DOM rendern; welche sichtbar bleiben, entscheidet fitMonthDayCells aus der
  // REALEN Zellhöhe (grid-auto-rows:1fr -> variiert mit dem Viewport). Zuvor kappte
  // ein festes Budget=3 blind: bei niedriger Zellhöhe schnitt die Zelle den letzten
  // Chip mittig ab, ohne "+N" (Audit A1-04 / P2). data-total trägt die Gesamtzahl,
  // damit "+N" auch die nicht gerenderten Überzähligen mitzählt. Reihenfolge
  // Feiertag -> Termin -> Aufgabe.
  const total     = dayHols.length + daySchedule.length + evs.length + dayTasks.length;
  const holShown  = dayHols.slice(0, MONTH_DAY_MAX_CHIPS);
  const evShown   = evs.slice(0, Math.max(0, MONTH_DAY_MAX_CHIPS - holShown.length));
  const taskShown = dayTasks.slice(0, Math.max(0, MONTH_DAY_MAX_CHIPS - holShown.length - evShown.length));

  const holHtml = holShown.map((h) => `
    <div class="month-day__holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
      <span>${esc(h.name)}</span>
    </div>
  `).join('');

  const scheduleHtml = daySchedule.map((entry) => `<div class="month-day__holiday schedule-entry" style="--holi-color:${esc(entry.shift_type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span>${esc(scheduleEntryLabel(entry))}</span></div>`).join("");

  // Monatsgrid-Kanon (Apple Kalender / Fantastical): flache getönte Bar mit nur
  // dem Titel. Icon und Avatar-Stack leben in der Tages-/Detailansicht; die
  // "Wer"-Information bleibt für Tooltip/Screenreader im title-Attribut erhalten.
  const evHtml = evShown.map((ev) => `
    <div class="month-day__event"
         data-id="${ev.id}"
         style="${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${ev.cal_name ? ' · ' + esc(ev.cal_name) : ''}${chipAssigneeTitleSuffix(ev)}"
    ><span>${esc(ev.title)}</span></div>
  `).join('');

  const taskHtml = taskShown.map((tk) => renderTaskChip(tk, { interactive: false, icon: false })).join('');

  return `
    <div class="${classes}" data-date="${date}" data-total="${total}"
         role="button" tabindex="0"
         aria-label="${esc(monthDayAriaLabel(date, total))}"${isToday ? ' aria-current="date"' : ''}>
      <div class="month-day__number">${new Date(date + 'T00:00:00').getDate()}</div>
      ${holHtml}
      ${scheduleHtml}
      ${evHtml}
      ${taskHtml}
      <div class="month-day__more" hidden></div>
    </div>
  `;
}

// aria-label der Tageszelle: lokalisiertes Datum + (falls vorhanden) Zahl der
// Einträge, damit Tastatur/Screenreader den Tag vor dem Drill-in einordnen
// können. Leere Tage tragen nur das Datum (die role sagt "Schaltfläche"). P1.
function scheduleEntriesOnDay(date) {
  return state.layerSchedule
    ? scheduleDayGroups(state.scheduleEntries.filter((entry) => entry.date_key === date && entry.shift_type))
    : [];
}

function scheduleDayGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.date_key}:${entry.user_id}`;
    if (!groups.has(key)) groups.set(key, entry);
  }
  return [...groups.values()];
}

/**
 * Ist der Schichtplan im Haushalt ueberhaupt eingeschaltet?
 *
 * `disabled_modules` heisst "dieses Modul gibt es hier nicht". Der Routen-Guard
 * schuetzt `/schedule` - der Kalender ist aber eine MISCHSTELLE: sein Pfad nennt
 * ein Modul, sein Inhalt kommt aus mehreren. Ohne diese Frage laedt und zeigt er
 * die Schichten eines abgeschalteten Moduls weiter, samt Ebenen-Knopf. Dasselbe
 * Muster wie in dashboard.js und recipes.js.
 */
function scheduleEnabled() { return !window.yuvomi?.isModuleDisabled?.('schedule'); }

function scheduleHasTimes(entry) { return Boolean(entry.shift_type?.start_time && entry.shift_type?.end_time); }

function scheduleOwnerName(entry) {
  const owner = state.users.find((user) => Number(user.id) === Number(entry.user_id));
  return owner?.display_name || owner?.username || "";
}

function scheduleEntryLabel(entry) {
  const shift = entry.shift_type.short_code || entry.shift_type.name;
  const owner = scheduleOwnerName(entry);
  return owner ? shift + " · " + owner : shift;
}

function scheduleEntryTitle(entry) {
  const owner = scheduleOwnerName(entry);
  const time = scheduleTimeLabel(entry.shift_type);
  return entry.shift_type.name + (owner ? " · " + owner : "") + (time ? " · " + time : "");
}

function scheduleIsFullDayShift(entry) {
  const type = entry.shift_type;
  return Boolean(type?.start_time && type?.end_time && type.start_time === type.end_time);
}

function scheduleTimeLabel(type) {
  if (!type.start_time || !type.end_time) return "";
  const crossesDay = type.end_time <= type.start_time;
  const fullDay = type.end_time === type.start_time;
  return type.start_time + "–" + type.end_time + (crossesDay ? " +1" : "") + (fullDay ? " · 24 h" : "");
}

function renderScheduleChip(entry, className = 'allday-holiday') {
  const type = entry.shift_type;
  const label = scheduleEntryLabel(entry);
  const start = type.start_time ? '<small class="schedule-entry__start">' + esc(type.start_time) + '</small>' : '';
  return `<div class="${className} schedule-entry" style="--holi-color:${esc(type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span>${esc(label)}</span>${start}</div>`;
}
function renderScheduleTimeBlock(entry, className) {
  const type = entry.shift_type;
  const start = timeToMinutes(type.start_time);
  const end = timeToMinutes(type.end_time);
  const duration = Math.max((end > start ? end : 24 * 60) - start, 30);
  const bounds = className === 'week-event' ? 'left:2px;width:calc(100% - 4px);' : 'left:calc(4px);width:calc(100% - 14px);';
  return `<div class="${className} schedule-time-block" style="top:${hourOffset(start)};height:calc(${hourOffset(duration)} - 4px);${bounds}--ev-color:${esc(type.color)}" title="${esc(scheduleEntryTitle(entry))}"><span>${esc(scheduleEntryLabel(entry))}</span><small>${esc(scheduleTimeLabel(type))}</small></div>`;
}

function monthDayAriaLabel(date, total) {
  const d = formatPreferredDate(date);
  return total > 0 ? `${d}, ${t('calendar.monthDayEntries', { count: total })}` : d;
}

// --------------------------------------------------------
// Wochenansicht
// --------------------------------------------------------

function renderWeekView(container) {
  const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  // Auf Mobile: 3-Tage-Fenster zentriert um state.cursor statt vollem Mo–So
  const days = isMobile
    ? Array.from({ length: 3 }, (_, i) => addDays(state.cursor, i - 1))
    : (() => {
        const weekStart = startOfWeekOf(state.cursor);
        return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      })();
  const colCount = days.length;

  const alldayEvs = days.map((d) =>
    eventsOnDay(d).filter(isAllDayLike)
  );
  const timedEvs = days.map((d) =>
    eventsOnDay(d).filter((e) => !isAllDayLike(e))
  );
  const layouts = timedEvs.map((events) => layoutOverlaps(events));
  const schedule = days.map((d) => scheduleEntriesOnDay(d));
  const scheduleChips = schedule.map((items) => state.scheduleDisplay === 'compact' ? items : items.filter((entry) => !scheduleHasTimes(entry) || scheduleIsFullDayShift(entry)));
  const scheduleBlocks = schedule.map((items) => state.scheduleDisplay === 'blocks' ? items.filter((entry) => scheduleHasTimes(entry) && !scheduleIsFullDayShift(entry)) : []);

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="week-view">
      <div class="week-view__header" id="week-header"
           style="display:grid;grid-template-columns:var(--cal-gutter-width) repeat(${colCount},1fr);">
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
      <div class="allday-row" style="display:grid;grid-template-columns:var(--cal-gutter-width) repeat(${colCount},1fr);">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        ${days.map((d, i) => `
          <div class="allday-cell">
            ${holidaysOnDay(d).map((h) => `
              <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
                <span>${esc(h.name)}</span>
              </div>
            `).join('')}
            ${scheduleChips[i].map((entry) => renderScheduleChip(entry)).join('')}
            ${alldayEvs[i].map((ev) => `
              <div class="allday-event" data-id="${ev.id}"
                   style="${eventSurfaceStyle(ev)}"
                   title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}${chipAssigneeTitleSuffix(ev)}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${chipAssigneeStack(ev, { size: 16, maxVisible: 3 })}</div>
            `).join('')}
            ${tasksOnDay(d).map(renderTaskChip).join('')}
          </div>
        `).join('')}
      </div>
      <div class="week-view__scroll page-scrollport" id="week-scroll">
        <div class="week-view__body">
          <div class="week-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(`${pad(h)}:00`)}</span>
              </div>
            `).join('')}
          </div>
          <div class="week-view__columns" id="week-cols"
               style="display:grid;grid-template-columns:repeat(${colCount},1fr);">
            ${days.map((d, i) => `
              <div class="week-view__col" data-date="${d}">
                ${Array.from({ length: 24 }, (_, h) => `
                  <div class="week-view__hour-line" style="top:${hourOffset(h * 60)};"></div>
                `).join('')}
                ${scheduleBlocks[i].map((entry) => renderScheduleTimeBlock(entry, 'week-event')).join('')}
                ${timedEvs[i].map((ev) => renderWeekEvent(ev, layouts[i].get(ev.id))).join('')}
                ${d === state.today ? `<div class="week-view__now-line" id="now-line" style="top:${hourOffset(nowMinutes())};"></div>` : ''}
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
    if (e.target.closest('.schedule-time-block')) return;
    const evEl = e.target.closest('.week-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
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
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  // Scrollen zu aktueller Zeit
  scrollToHour(container.querySelector('#week-scroll'), container.querySelector('.week-view__body'));
}

/**
 * Setzt einen Zeitraster-Scroller auf die aktuelle Stunde, gemessen an der
 * Gesamthoehe des 24-Stunden-Koerpers statt an einer zweiten Stundenzahl in JS.
 */
function scrollToHour(scroll, body) {
  if (!scroll || !body) return;
  const hourHeight = body.getBoundingClientRect().height / 24;
  scroll.scrollTop = Math.max(0, nowFields().hour * hourHeight - 80);
}

function renderWeekEvent(ev, layout = null) {
  const { start, end } = timeRangeForEvent(ev);
  const duration = Math.max(end - start, 30);

  const top    = hourOffset(start);
  const height = `calc(${hourOffset(duration)} - 2px)`;
  const left = layout ? `calc(${(layout.colIndex / layout.totalCols) * 100}% + 2px)` : '2px';
  const width = layout ? `calc(${100 / layout.totalCols}% - 4px)` : 'auto';

  return `
    <div class="week-event" data-id="${ev.id}"
         style="top:${top};height:${height};left:${left};width:${width};${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${chipAssigneeTitleSuffix(ev)}">
      <div class="week-event__title">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}${chipAssigneeStack(ev, { size: 14, maxVisible: 2 })}</div>
      <div class="week-event__time">${formatTime(ev.start_datetime)}${ev.end_datetime ? '–' + formatTime(ev.end_datetime) : ''}</div>
    </div>
  `;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Addiert eine Minutendauer auf eine Datum/Zeit-Kombination und trägt den
 * Überlauf über Mitternacht auf das Datum über.
 * @returns {{ date: string, time: string }} lokaler Datums-Key (YYYY-MM-DD) + HH:MM
 */
function addDurationToDateTime(dateKey, timeStr, minutes) {
  const total    = timeToMinutes(timeStr) + Math.max(0, minutes);
  const dayShift = Math.floor(total / (24 * 60));
  const dayMins  = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    date: dayShift ? addDays(dateKey, dayShift) : dateKey,
    time: `${pad(Math.floor(dayMins / 60))}:${pad(dayMins % 60)}`,
  };
}

/** Minuten seit Mitternacht - der Bezug jeder Now-Linie. */
function nowMinutes() {
  // Die Uhr des Haushalts (#829 Teil 3): sonst steht die Jetzt-Linie auf einem
  // Geraet in einer anderen Zone um deren Offset daneben - im selben Raster, in
  // dem die Termine bereits der Haushaltszone folgen.
  const { hour, minute } = nowFields();
  return hour * 60 + minute;
}

/** Berechnet die geklickte Uhrzeit (auf 30-Minuten gerundet) aus einem Click-Event
 *  relativ zum übergebenen Spalten-Element. Die Stundenhöhe wird an der Spalte
 *  gemessen (sie ist immer 24 Stunden hoch), nicht aus einer Zahl in dieser Datei
 *  gelesen - so stimmt der Treffer auch in der dichteren Tagesansicht. */
function clickedTime(e, colEl) {
  const rect = colEl.getBoundingClientRect();
  const hourHeight = measuredHourHeight(colEl);
  if (!hourHeight) return '09:00';
  const yOffset = Math.max(0, e.clientY - rect.top);
  const totalMinutes = Math.round((yOffset / hourHeight) * 60 / 30) * 30;
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
  const schedule = scheduleEntriesOnDay(state.cursor);
  const scheduleChips = state.scheduleDisplay === 'compact' ? schedule : schedule.filter((entry) => !scheduleHasTimes(entry) || scheduleIsFullDayShift(entry));
  const scheduleBlocks = state.scheduleDisplay === 'blocks' ? schedule.filter((entry) => scheduleHasTimes(entry) && !scheduleIsFullDayShift(entry)) : [];

  container.replaceChildren();
  // Kein eigener Datums-Header mehr: die Toolbar zeigt exakt dasselbe Datum
  // bereits als Ansichts-Label (Audit A1-18).
  container.insertAdjacentHTML('beforeend', `
    <div class="day-view">
      ${(allday.length || scheduleChips.length || tasksOnDay(state.cursor).length || holidaysOnDay(state.cursor).length) ? `
      <div class="allday-row" style="display:grid;grid-template-columns:var(--cal-gutter-width) 1fr;">
        <div class="calendar-all-day-label">${t('calendar.allDayShort')}</div>
        <div class="allday-cell">
          ${holidaysOnDay(state.cursor).map((h) => `
            <div class="allday-holiday" style="--holi-color:${esc(h.color)};--holi-ink:${esc(getReadableTextColor(h.color))}" title="${esc(h.name)}">
              <span>${esc(h.name)}</span>
            </div>
          `).join('')}
          ${scheduleChips.map((entry) => renderScheduleChip(entry)).join('')}
          ${allday.map((ev) => `
            <div class="allday-event" data-id="${ev.id}"
                 style="${eventSurfaceStyle(ev)}"
                 title="${esc(ev.title)}${ev.cal_name ? ' · ' + ev.cal_name : ''}${chipAssigneeTitleSuffix(ev)}">${eventIconHtml(ev.icon, 'event-icon event-icon--compact')}<span>${esc(ev.title)}</span>${chipAssigneeStack(ev, { size: 16, maxVisible: 3 })}</div>`).join('')}
          ${tasksOnDay(state.cursor).map(renderTaskChip).join('')}
        </div>
      </div>` : ''}
      <div class="day-view__scroll page-scrollport" id="day-scroll">
        <div class="day-view__body">
          <div class="day-view__times">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__time-slot">
                <span class="week-view__time-label">${h === 0 ? '' : formatTime(`${pad(h)}:00`)}</span>
              </div>
            `).join('')}
          </div>
          <div class="day-view__col" data-date="${state.cursor}" id="day-col">
            ${Array.from({ length: 24 }, (_, h) => `
              <div class="week-view__hour-line" style="top:${hourOffset(h * 60)};"></div>
            `).join('')}
            ${scheduleBlocks.map((entry) => renderScheduleTimeBlock(entry, 'day-event')).join('')}
            ${timed.map((ev) => renderDayEvent(ev, layout.get(ev.id))).join('')}
            ${dayEvs.length === 0 && schedule.length === 0 ? `<div class="day-view__empty-hint" style="top:calc(${hourOffset(state.cursor === state.today ? nowMinutes() : 9 * 60)} + 16px)">${t('calendar.dayEmptyHint')}</div>` : ''}
          </div>
          ${state.cursor === state.today ? `
            <div class="day-view__now-line" aria-hidden="true" style="top:${hourOffset(nowMinutes())};"></div>
            <div class="day-view__now-dot" aria-hidden="true" style="top:${hourOffset(nowMinutes())};"></div>
          ` : ''}
        </div>
      </div>
    </div>
  `);

  container.querySelector('.allday-row')?.addEventListener('click', (e) => {
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.allday-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  container.querySelector('#day-col').addEventListener('click', (e) => {
    if (e.target.closest('.schedule-time-block')) return;
    const evEl = e.target.closest('.day-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
      return;
    }
    const time = clickedTime(e, e.currentTarget);
    openEventModal({ mode: 'create', date: state.cursor, time });
  });

  scrollToHour(container.querySelector('#day-scroll'), container.querySelector('.day-view__body'));
}

/**
 * Ein Termin im Tagesraster: flacher Tint-Balken mit Farbspine.
 *
 * DIE GRAMMATIK GILT FUER JEDEN TERMIN ODER FUER KEINEN. Im Mockup trug genau
 * ein Event weder Spine noch Toenung (Screenshot 05) - hier kann das nicht
 * passieren, weil beide aus derselben `--ev-color` fallen, die
 * `resolveEventColor()` immer beantwortet (Ebene, Kalender oder App-Akzent).
 *
 * Die Zeit-/Ortszeile erscheint erst ab einer Stunde Dauer: darunter bleibt im
 * 40px-Raster nur Platz fuer den Titel, und eine angeschnittene zweite Zeile
 * ist schlechter als keine.
 */
function renderDayEvent(ev, layout = null) {
  const { start, end } = timeRangeForEvent(ev);
  const duration = Math.max(end - start, 30);
  const roomy = duration >= 60;

  const top    = hourOffset(start);
  const height = `calc(${hourOffset(duration)} - 4px)`;
  const cols   = layout?.totalCols ?? 1;
  const idx    = layout?.colIndex ?? 0;
  // Links 4px, rechts 10px: der Balken laesst die Zeitachse an beiden Raendern
  // stehen, damit Stunden- und Now-Linie sichtbar hinter ihm weiterlaufen.
  const left  = `calc(${(idx / cols) * 100}% + 4px)`;
  const width = `calc(${100 / cols}% - 14px)`;

  const place = ev.location ? ` · ${esc(fmtLocation(ev.location))}` : '';
  const timeText = `${formatTime(ev.start_datetime)}${ev.end_datetime ? '–' + formatTime(ev.end_datetime) : ''}`;

  return `
    <div class="day-event${roomy ? '' : ' day-event--tight'}" data-id="${ev.id}"
         style="top:${top};height:${height};left:${left};width:${width};${eventSurfaceStyle(ev)}"
         title="${esc(ev.title)}${ev.location ? ' · ' + esc(fmtLocation(ev.location)) : ''}${chipAssigneeTitleSuffix(ev)}">
      <span class="day-event__spine" aria-hidden="true"></span>
      <span class="day-event__text">
        <span class="day-event__title">${hasEventIcon(ev.icon) ? eventIconHtml(ev.icon, 'event-icon event-icon--compact') : ''}<span class="day-event__name">${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}</span>
        ${roomy ? `<span class="day-event__meta">${timeText}${place}</span>` : ''}
      </span>
      ${roomy ? chipAssigneeStack(ev, { size: 20, maxVisible: 2 }) : ''}
    </div>
  `;
}

// --------------------------------------------------------
// Agenda-Ansicht
// --------------------------------------------------------

function renderAgendaView(container) {
  const { from, to } = getAgendaRange(state.cursor);
  const days = Array.from({ length: 31 }, (_, i) => addDays(from, i));

  /* HEUTE WIRD NICHT STILL UEBERSPRUNGEN.
   *
   * Die Agenda listet nur Tage, an denen etwas steht - richtig fuer die
   * naechsten Wochen, falsch fuer den ersten. Der Kopf kuendigt „Ab
   * 28.08.2026" an, und die erste Zeile war der 29.: der Tag, nach dem
   * gefragt wird, fehlte genau dann, wenn die Antwort „nichts" lautet - und
   * ein fehlender Tag sieht aus wie ein Ladefehler, nicht wie ein freier Tag.
   * Die CSS-Regel `agenda-day__header--today` gab es laengst, sie konnte nur
   * nie feuern.
   *
   * NUR HEUTE, und nur wenn heute im Bereich liegt. Jeder leere Tag als Zeile
   * waere eine Liste aus Leere; „heute" ist der eine Tag, dessen Abwesenheit
   * eine Frage offen laesst. */
  const todayInRange = state.today >= from && state.today <= to;

  const groups = days
    .map((d) => ({ date: d, events: eventsOnDay(d), tasks: tasksOnDay(d), holidays: holidaysOnDay(d), schedule: scheduleEntriesOnDay(d) }))
    .filter((g) => g.events.length > 0 || g.tasks.length > 0 || g.holidays.length > 0 || g.schedule.length > 0
      || (todayInRange && g.date === state.today));

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="agenda-view page-scrollport" id="agenda-view">
      ${groups.length === 0
        ? emptyStateHTML({
          icon: 'calendar-plus',
          title: t('calendar.agendaEmpty'),
          action: { label: t('calendar.newEvent'), attrs: { id: 'agenda-empty-cta' } },
        })
        : groups.map(({ date, events, tasks, holidays, schedule }) => `
          <div class="agenda-day">
            <!-- Tageskopf als echte Ueberschrift (Critique 2026-08-10):
                 /calendar hatte genau EIN h-Element im ganzen Dokument. -->
            <h2 class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
              <span class="agenda-day__date">${formatDate(date)}</span>
              <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
            </h2>
            ${holidays.length ? `<div class="agenda-holidays">${holidays.map((h) => `
              <div class="agenda-holiday" style="--holi-color:${esc(h.color)}">
                <span class="agenda-holiday__dot"></span>
                <span>${esc(h.name)}</span>
              </div>`).join('')}</div>` : ''}
            ${schedule.length ? `<div class="agenda-holidays">${schedule.map((entry) => renderScheduleChip(entry, 'agenda-holiday')).join('')}</div>` : ''}
            ${events.length ? `<div class="list-rows">${events.map((ev) => renderAgendaEvent(ev, date)).join('')}</div>` : ''}
            ${tasks.length ? `<div class="agenda-tasks">${tasks.map(renderTaskChip).join('')}</div>` : ''}
            ${(!events.length && !tasks.length && !holidays.length && !schedule.length)
              ? `<p class="agenda-day__empty">${t('calendar.agendaDayEmpty')}</p>` : ''}
          </div>
        `).join('')
      }
    </div>
  `);

  stagger(container.querySelectorAll('.agenda-event'));

  container.querySelector('#agenda-view').addEventListener('click', (e) => {
    if (e.target.closest('#agenda-empty-cta')) {
      openEventModal({ mode: 'create', date: newEventDate() });
      return;
    }
    const taskChip = e.target.closest('.cal-task-chip');
    if (taskChip) {
      openTaskFromCalendar(taskChip.dataset.taskId);
      return;
    }
    const evEl = e.target.closest('.agenda-event');
    if (evEl) {
      const ev = state.events.find((ev) => ev.id === parseInt(evEl.dataset.id, 10));
      if (ev) openEventDetail(ev, evEl);
    }
  });

  // Tastaturaktivierung der als role="button" ausgezeichneten Zeilen (Enter/Space).
  container.querySelector('#agenda-view').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const evEl = e.target.closest('.agenda-event');
    if (!evEl) return;
    e.preventDefault();
    const ev = state.events.find((x) => x.id === parseInt(evEl.dataset.id, 10));
    if (ev) openEventDetail(ev, evEl);
  });
}

// --------------------------------------------------------
// Termin-Suche (#471)
// Datumsunabhängiges Finden über den FTS-Index (Titel/Beschreibung/Ort).
// Eine Leiste unter der Toolbar; der Body zeigt eine chronologische Trefferliste
// (Vergangenheit + Zukunft) mit „Heute"-Anker. Klick öffnet den Termin im Kontext.
// --------------------------------------------------------

// --------------------------------------------------------
// Filter-Blatt
//
// DER ORT, AN DEM DIE EBENEN WOHNEN - und der Grund, warum sie umgezogen sind.
//
// Bis 2026-08-28 standen bis zu fuenf Ebenen-Schalter als Chips im Modulkopf.
// Gemessen kostete das eine eigene Kopfzeile (56px = 6,6% der Viewporthoehe
// auf 390px), und unter 640px verloren die Chips ihr Label: uebrig blieben
// 48px-Kreise, von denen einer nur einen 8px-Punkt enthielt. Ihr An/Aus-
// Zustand war eine Flaeche von 1,085:1 in Light - die `--active`-Regel, die
// ihn tragen sollte, setzte dieselbe Kante wie der Ruhezustand und war damit
// ein No-op. Vier der fuenf hatten kein `aria-pressed`; fuer einen
// Screenreader war die Ebene zustandslos.
//
// Ein Blatt loest alle drei Befunde mit einem Bauteil: die Schalter bekommen
// ihre Beschriftung zurueck, ihr Zustand ist eine echte Checkbox statt einer
// Waschung, und der Kopf gibt eine Zeile her.
//
// WAS ES NICHT IST: eine FARBLEGENDE. Die Farbe eines Termins kommt aus drei
// Quellen in Rangfolge (`resolveEventColor`, utils/event-color.js) - eigene
// Farbe, primaere zugewiesene Person, Kalender. Eine Legende „diese Farbe =
// jener Kalender" waere bei jedem Termin falsch, der eine der ersten beiden
// Quellen nutzt. Die Person ist die einzige Achse, die eindeutig ist, und in
// einem Familienplaner ist sie auch die gefragte.
// --------------------------------------------------------

/** Die Ebenen, die es im aktuellen Zustand ueberhaupt gibt. */
function availableLayers() {
  const hp = state.holidayPrefs ?? {};
  const rows = [];
  if (hp.holiday_show_public) {
    rows.push({
      key: 'holidays', label: t('calendar.toggleHolidays'),
      checked: state.layerHolidays, color: hp.holiday_public_color ?? HOLIDAY_PUBLIC_FALLBACK,
    });
  }
  if (hp.holiday_show_school) {
    rows.push({
      key: 'school', label: t('calendar.toggleSchool'),
      checked: state.layerSchool, color: hp.holiday_school_color ?? HOLIDAY_SCHOOL_FALLBACK,
    });
  }
  if (scheduleEnabled()) {
    rows.push({
      key: 'schedule', label: t('schedule.overlay'),
      checked: state.layerSchedule, color: null,
    });
  }
  // Der Geburtstags-Schalter braucht hier keine „gibt es welche?"-Bedingung
  // mehr: im Blatt kostet eine Zeile keine Kopfzeile, und ein Schalter, der
  // je nach Datenlage verschwindet, ist im Blatt schwerer zu finden als eine
  // Zeile, die immer an derselben Stelle steht.
  rows.push({
    key: 'birthdays', label: t('calendar.toggleBirthdays'),
    checked: state.layerBirthdays, color: null,
  });
  return rows;
}

/** Initialen einer Person - dieselbe Bildung wie im Avatar-Stack. */
function personInitials(name) {
  return String(name ?? '')
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function openCalendarFilters() {
  const layers = availableLayers();
  const people = state.users ?? [];

  const layerRows = layers.map((row) => toggleRowHtml({
    label: row.label,
    checked: row.checked,
    swatchColor: row.color,
    attrs: { 'data-filter-layer': row.key },
  })).join('');

  // Der Anzeigemodus des Schichtplans ist KEIN Filter - er nimmt nichts weg,
  // er zeigt dasselbe anders. Er steht trotzdem hier, weil er im Kopf als
  // Text-Chip neben den Ebenen hing und dort dieselbe Zeile kostete; im Blatt
  // hat er als beschrifteter Schalter zum ersten Mal einen Zustand, den man
  // ablesen kann statt ihn aus der Knopfbeschriftung zu erschliessen (der
  // Chip hiess „Volle Bloecke", wenn er sie NICHT zeigte).
  const scheduleDisplayRow = scheduleEnabled() ? toggleRowHtml({
    label: t('schedule.fullBlocks'),
    checked: state.scheduleDisplay === 'blocks',
    attrs: { 'data-filter-schedule-display': 'true' },
  }) : '';

  const meRow = (people.length > 1 && state.currentUserId != null)
    ? toggleRowHtml({
      label: t('calendar.assignedToMe'),
      checked: state.assignedToMe,
      attrs: { 'data-filter-mine': 'true' },
    })
    : '';

  const personRows = people.map((u) => toggleRowHtml({
    label: u.display_name ?? '',
    // Leeres Set heisst ALLE - die Haekchen stehen dann auf „an", weil genau
    // das der sichtbare Zustand ist. Wer das erste abwaehlt, waehlt damit die
    // uebrigen aus; das ist die Lesart, die Apple in derselben Liste hat.
    checked: state.people.size === 0 || state.people.has(u.id),
    // ZWEI NAMEN FUER DIESELBE FARBE, und das ist kein Tippfehler in einer
    // der beiden Quellen: `/auth/users` liefert die Spalte roh als
    // `avatar_color`, waehrend `assigned_users` sie im JSON auf `color`
    // umbenennt (services/calendar-events.js:17). Wer nur einen der beiden
    // Namen liest, bekommt an einer der beiden Stellen `undefined` - hier
    // stand zuerst `u.color` und die Scheiben blieben in jeder Zeile leer.
    swatchColor: u.avatar_color ?? u.color ?? null,
    swatchLabel: personInitials(u.display_name),
    attrs: { 'data-filter-person': String(u.id) },
  })).join('');

  const content = `
    <div class="cal-filters">
      ${layerRows ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersLayers')}</h3>
          ${layerRows}
        </section>
      ` : ''}
      ${(meRow || personRows) ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersPeople')}</h3>
          ${meRow}
          ${personRows}
        </section>
      ` : ''}
      ${scheduleDisplayRow ? `
        <section class="cal-filters__group">
          <h3 class="cal-filters__heading">${t('calendar.filtersDisplay')}</h3>
          ${scheduleDisplayRow}
        </section>
      ` : ''}
      <button type="button" class="btn btn--secondary cal-filters__reset" id="cal-filters-reset">
        ${t('calendar.filtersReset')}
      </button>
    </div>
  `;

  openSharedModal({ title: t('calendar.filters'), content, size: 'sm', initialFocus: 'none' });

  const panel = document.querySelector('#shared-modal-overlay .modal-panel');
  if (!panel) return;

  const LAYER_STATE = {
    holidays:  ['layerHolidays',  LAYER_HOLIDAYS_KEY],
    school:    ['layerSchool',    LAYER_SCHOOL_KEY],
    schedule:  ['layerSchedule',  LAYER_SCHEDULE_KEY],
    birthdays: ['layerBirthdays', LAYER_BIRTHDAYS_KEY],
  };

  panel.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;

    const layerKey = input.dataset.filterLayer;
    if (layerKey && LAYER_STATE[layerKey]) {
      const [field, storageKey] = LAYER_STATE[layerKey];
      state[field] = input.checked;
      try { localStorage.setItem(storageKey, input.checked ? 'true' : 'false'); } catch {}
    } else if (input.dataset.filterScheduleDisplay) {
      state.scheduleDisplay = input.checked ? 'blocks' : 'compact';
      try { localStorage.setItem(SCHEDULE_DISPLAY_KEY, state.scheduleDisplay); } catch {}
    } else if (input.dataset.filterMine) {
      state.assignedToMe = input.checked;
      try { localStorage.setItem(ASSIGNED_TO_ME_KEY, input.checked ? '1' : '0'); } catch {}
    } else if (input.dataset.filterPerson) {
      const id = Number(input.dataset.filterPerson);
      // Der Sprung aus „alle" heraus: das erste Abwaehlen macht aus dem leeren
      // Set die Menge der UEBRIGEN. Ohne diesen Schritt haette ein Klick auf
      // ein Haekchen, das „alle" bedeutet, gar nichts getan.
      if (state.people.size === 0) {
        for (const u of state.users ?? []) state.people.add(u.id);
      }
      if (input.checked) state.people.add(id);
      else state.people.delete(id);
      // Wieder ALLE gewaehlt heisst wieder „kein Filter" - sonst bliebe ein
      // Filter aktiv, der nichts wegnimmt, und der Zaehler am Knopf loege.
      if (state.people.size === (state.users ?? []).length) state.people.clear();
      persistPeopleFilter();
    } else {
      return;
    }

    renderToolbar();
    renderView();
  });

  panel.querySelector('#cal-filters-reset')?.addEventListener('click', () => {
    state.layerHolidays = true;
    state.layerSchool = true;
    state.layerSchedule = true;
    state.layerBirthdays = true;
    state.assignedToMe = false;
    state.people.clear();
    try {
      localStorage.setItem(LAYER_HOLIDAYS_KEY, 'true');
      localStorage.setItem(LAYER_SCHOOL_KEY, 'true');
      localStorage.setItem(LAYER_SCHEDULE_KEY, 'true');
      localStorage.setItem(LAYER_BIRTHDAYS_KEY, 'true');
      localStorage.setItem(ASSIGNED_TO_ME_KEY, '0');
    } catch {}
    persistPeopleFilter();
    closeModal({ force: true });
    renderToolbar();
    renderView();
  });
}

/**
 * Der gespeicherte Personenfilter, GEGEN DEN HAUSHALT GEPRUEFT.
 *
 * Eine gespeicherte ID, die es nicht mehr gibt (Mitglied entfernt), waere ein
 * Filter, den kein Haekchen im Blatt mehr zurueckstellen kann: der Kalender
 * bliebe leer, das Blatt zeigte lauter aktive Haekchen, und der Zaehler am
 * Knopf naennte einen Filter ohne sichtbare Ursache. Deshalb faellt jede
 * unbekannte ID beim Laden weg - und wenn danach alle oder keine uebrig sind,
 * ist es wieder „alle", also gar kein Filter.
 */
function restorePeopleFilter(users) {
  const known = new Set((users ?? []).map((u) => u.id));
  let stored;
  try { stored = JSON.parse(localStorage.getItem(PEOPLE_FILTER_KEY) ?? '[]'); } catch { stored = []; }
  if (!Array.isArray(stored)) return new Set();
  const valid = stored.map(Number).filter((id) => known.has(id));
  if (valid.length === 0 || valid.length === known.size) return new Set();
  return new Set(valid);
}

function persistPeopleFilter() {
  try {
    if (state.people.size === 0) localStorage.removeItem(PEOPLE_FILTER_KEY);
    else localStorage.setItem(PEOPLE_FILTER_KEY, JSON.stringify([...state.people]));
  } catch {}
}

function openCalendarSearch() {
  if (searchActive) {
    _container.querySelector('#cal-search-input')?.focus();
    return;
  }
  const toolbar = _container.querySelector('#cal-toolbar');
  if (!toolbar) return;
  searchActive  = true;
  searchQuery   = '';
  searchResults = [];

  const toggle = _container.querySelector('#cal-search');
  toggle?.setAttribute('aria-expanded', 'true');
  // Erst jetzt gibt es ein Ziel, also erst jetzt der Verweis darauf.
  toggle?.setAttribute('aria-controls', 'cal-search-bar');
  toggle?.classList.add('cal-toolbar__search-btn--active');

  toolbar.insertAdjacentHTML('afterend', `
    <div class="cal-search" id="cal-search-bar" role="search">
      <i data-lucide="search" class="cal-search__icon" aria-hidden="true"></i>
      <input type="search" class="cal-search__input" id="cal-search-input"
             placeholder="${esc(t('calendar.searchPlaceholder'))}"
             aria-label="${esc(t('calendar.searchPlaceholder'))}"
             autocomplete="off" enterkeyhint="search" spellcheck="false">
      <button class="btn btn--icon cal-search__close" id="cal-search-close"
              aria-label="${esc(t('calendar.searchClose'))}" title="${esc(t('calendar.searchClose'))}">
        <i data-lucide="x" aria-hidden="true"></i>
      </button>
      <span id="cal-search-live" class="sr-only" role="status" aria-live="polite"></span>
    </div>
  `);

  const bar   = _container.querySelector('#cal-search-bar');
  const input = bar.querySelector('#cal-search-input');
  if (window.lucide) lucide.createIcons({ el: bar });

  renderCalendarSearchState('hint');

  let timer = null;
  input.addEventListener('input', () => {
    const q = input.value;
    clearTimeout(timer);
    timer = setTimeout(() => runCalendarSearch(q), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCalendarSearch(); }
  });
  bar.querySelector('#cal-search-close').addEventListener('click', () => closeCalendarSearch());

  input.focus();
}

function closeCalendarSearch({ restoreView = true } = {}) {
  if (!searchActive) return;
  searchActive  = false;
  searchQuery   = '';
  searchResults = [];
  _container.querySelector('#cal-search-bar')?.remove();

  const toggle = _container.querySelector('#cal-search');
  toggle?.setAttribute('aria-expanded', 'false');
  // Die Leiste ist gerade entfernt worden - der Verweis geht mit ihr.
  toggle?.removeAttribute('aria-controls');
  toggle?.classList.remove('cal-toolbar__search-btn--active');

  if (restoreView) renderView();
  toggle?.focus();
}

async function runCalendarSearch(raw) {
  if (!searchActive) return;
  const q = String(raw ?? '').trim();
  searchQuery = q;

  if (q.length < 2) {
    searchResults = [];
    searchTotal = 0;
    renderCalendarSearchState('hint');
    return;
  }

  renderCalendarSearchState('loading');
  try {
    const res = await api.get(`/calendar/search?q=${encodeURIComponent(q)}`);
    // Verworfen, wenn die Suche zwischenzeitlich geschlossen oder weitergetippt wurde.
    if (!searchActive || searchQuery !== q) return;
    searchResults = (res.data ?? []).map(localizeBirthdayEvent);
    searchTotal = Number.isFinite(res.total) ? res.total : searchResults.length;
    renderCalendarSearchState(searchResults.length ? 'results' : 'empty');
  } catch (err) {
    if (!searchActive || searchQuery !== q) return;
    console.warn('[Calendar] Suche fehlgeschlagen:', err);
    renderCalendarSearchState('error');
  }
}

// Aktualisiert die persistente sr-only-Live-Region in der Suchleiste. Bewusst
// getrennt von der sichtbaren Trefferliste, damit Screenreader Statuswechsel
// zuverlässig ansagen (ein bei jedem Render neu erzeugtes role=status wird oft
// nicht vorgelesen).
function setSearchLive(message) {
  const live = _container.querySelector('#cal-search-live');
  if (live) live.textContent = message;
}

function calendarSearchCountLabel() {
  return searchTotal > searchResults.length
    ? t('calendar.searchCountCapped', { shown: searchResults.length, total: searchTotal })
    : t('calendar.searchCount', { count: searchResults.length });
}

function renderCalendarSearchState(kind) {
  const body = _container.querySelector('#cal-body');
  if (!body) return;
  body.replaceChildren();

  if (kind === 'hint') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="search" class="cal-search-status__icon" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchHint'))}</p>
      </div>`);
    setSearchLive(t('calendar.searchHint'));
  } else if (kind === 'loading') {
    body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
    setSearchLive(t('common.loading'));
  } else if (kind === 'empty') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="calendar-search" class="cal-search-status__icon" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchEmpty', { query: searchQuery }))}</p>
        <button class="btn btn--secondary" id="cal-search-empty-cta">${esc(t('calendar.newEvent'))}</button>
      </div>`);
    // Bewusst ohne newEventDate(): die Trefferliste ersetzt die Ansicht, es steht
    // gerade kein Zeitraum auf dem Schirm, auf den ein Vorschlag sich beziehen könnte.
    body.querySelector('#cal-search-empty-cta')?.addEventListener('click', () => openEventModal({ mode: 'create' }));
    setSearchLive(t('calendar.searchEmpty', { query: searchQuery }));
  } else if (kind === 'error') {
    body.insertAdjacentHTML('beforeend', `
      <div class="cal-search-status">
        <i data-lucide="alert-triangle" class="cal-search-status__icon cal-search-status__icon--error" aria-hidden="true"></i>
        <p class="cal-search-status__text">${esc(t('calendar.searchError'))}</p>
        <button class="btn btn--secondary" id="cal-search-retry">${esc(t('common.retry'))}</button>
      </div>`);
    body.querySelector('#cal-search-retry')?.addEventListener('click', () => runCalendarSearch(searchQuery));
    setSearchLive(t('calendar.searchError'));
  } else if (kind === 'results') {
    renderCalendarSearchResults(body);
    setSearchLive(calendarSearchCountLabel());
  }

  if (window.lucide) lucide.createIcons({ el: body });
}

function renderCalendarSearchResults(body) {
  // Treffer nach Tag gruppieren; der Endpoint liefert bereits chronologisch sortiert.
  const groups = [];
  const byDate = new Map();
  for (const ev of searchResults) {
    const d = localDate(ev.start_datetime);
    if (!byDate.has(d)) {
      const g = { date: d, events: [] };
      byDate.set(d, g);
      groups.push(g);
    }
    byDate.get(d).events.push(ev);
  }

  body.insertAdjacentHTML('beforeend', `
    <div class="agenda-view page-scrollport cal-search-results" id="cal-search-results">
      <p class="cal-search-results__count" aria-hidden="true">${esc(calendarSearchCountLabel())}</p>
      ${groups.map(({ date, events }) => `
        <div class="agenda-day" data-date="${esc(date)}">
          <h2 class="agenda-day__header ${date === state.today ? 'agenda-day__header--today' : ''}">
            <span class="agenda-day__date">${formatDate(date, { long: true })}</span>
            <span class="agenda-day__weekday">${DAY_NAMES_LONG()[new Date(date + 'T00:00:00').getDay()]}</span>
          </h2>
          <div class="list-rows">${events.map((ev) => renderAgendaEvent(ev, date)).join('')}</div>
        </div>
      `).join('')}
    </div>
  `);

  const results = body.querySelector('#cal-search-results');
  stagger(results.querySelectorAll('.agenda-event'));

  const activateResult = (evEl) => {
    const ev = searchResults.find((x) => String(x.id) === evEl.dataset.id);
    if (ev) openFoundEvent(ev);
  };
  results.addEventListener('click', (e) => {
    const evEl = e.target.closest('.agenda-event');
    if (evEl) activateResult(evEl);
  });
  results.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const evEl = e.target.closest('.agenda-event');
    if (!evEl) return;
    e.preventDefault();
    activateResult(evEl);
  });

  // Auf den nächsten kommenden Treffer scrollen — Vergangenes bleibt darüber
  // erreichbar, aber der Blick startet beim relevantesten (heute/zukünftig).
  const upcoming = groups.find((g) => g.date >= state.today);
  if (upcoming) {
    results.querySelector(`.agenda-day[data-date="${CSS.escape(upcoming.date)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

// Öffnet einen gefundenen Termin im Kontext: springt in die Tagesansicht des
// Termindatums und zeigt das Detail-Popup (Fallback: Bearbeiten-Modal).
async function openFoundEvent(ev) {
  const date = localDate(ev.start_datetime);
  closeCalendarSearch({ restoreView: false });
  await switchToDayView(date);

  const full = state.events.find((e) => e.id === ev.id) || ev;
  const chip = _container.querySelector(`[data-id="${CSS.escape(String(ev.id))}"]`);
  if (chip) {
    chip.scrollIntoView({ block: 'center', behavior: 'instant' });
    openEventDetail(full, chip);
  } else {
    openEventDetail(full);
  }
}

export const __test = {
  fetchWindow,
  resolveEventColor,
  isVisibleLayer,
  normalizeCalendarView,
  defaultCalendarViewFromState,
  newEventDefaultDate,
  filterTasksForCalendar,
  tasksOnDay,
  eventEndDate,
  isMultiDayEvent,
  isAllDayLike,
  agendaSegmentKind,
  deepLinkTargetDate,
  findDeepLinkedOccurrence,
  validDateParam,
  hasAttachment,
  attachmentUrls,
  clickedTime,
  hourOffset,
  monthDayClasses,
  pickerColors,
  colorToSave,
  eventIconName,
  eventIconHtml,
  sameColor,
  EVENT_COLORS,
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
        + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${timeSuffix()}`.trimEnd() : ` ${timeSuffix()}`.trimEnd());
  }

  const displayBg     = resolveEventBackground(ev);
  const assignedUsers = ev.assigned_users ?? [];
  return `
    <div class="list-row agenda-event" data-id="${ev.id}" role="button" tabindex="0"
         aria-label="${esc(ev.title)}, ${esc(timeStr)}${ev.cal_name ? ', ' + esc(ev.cal_name) : ''}${chipAssigneeLabel(ev) ? ', ' + esc(chipAssigneeLabel(ev)) : ''}">
      <div class="agenda-event__color" style="background:${esc(displayBg)};"></div>
      <div class="agenda-event__body">
        <div class="agenda-event__title">${eventIconHtml(ev.icon)}<span>${esc(ev.title)}</span>${(ev.recurrence_rule || ev.is_recurring_instance) ? calendarRepeatIconHtml() : ''}</div>
        <div class="agenda-event__meta">
          <span class="calendar-meta-item calendar-meta-item--time">${calendarMetaIconHtml('clock')}<span>${esc(timeStr)}</span></span>
          ${ev.location ? `<span class="calendar-meta-item calendar-meta-item--place">${calendarMetaIconHtml('map-pin')}<span>${esc(fmtLocation(ev.location))}</span></span>` : ''}
          ${ev.cal_name ? `<span class="calendar-meta-item calendar-meta-item--cal">${calendarMetaIconHtml('calendar-days')}<span>${esc(ev.cal_name)}</span></span>` : ''}
          ${eventVisibilityMeta(ev.visibility)}
          ${assignedUsers.length ? `<span class="agenda-event__assigned">${renderAvatarStack(assignedUsers, { size: 20, maxVisible: 3 })}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

// Sichtbarkeits-Indikator (#474): nur bei eingeschränkten Terminen ein dezentes
// Icon mit Label — „Alle" bleibt icon-los.
function eventVisibilityMeta(visibility) {
  if (!visibility || visibility === 'all') return '';
  const icon  = visibility === 'private' ? 'lock' : 'users';
  const label = visibility === 'private'
    ? t('common.visibility.private')
    : t('common.visibility.assignees');
  return `<span class="calendar-meta-item" title="${esc(label)}">${calendarMetaIconHtml(icon)}<span>${esc(label)}</span></span>`;
}

// --------------------------------------------------------
// Termin-Detailansicht (beim Antippen eines Termins)
// --------------------------------------------------------

/** Anhang als Bildvorschau oder Download-Link - beides als DOM, nie als Markup. */
function attachmentNode(ev) {
  if (!hasAttachment(ev)) return null;
  const name = ev.attachment_name || t('calendar.attachmentFallback');
  const urls = attachmentUrls(ev);

  if (isImageAttachment(ev.attachment_mime)) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-attachment detail-attachment--image';
    const img = document.createElement('img');
    img.src = urls.preview;
    img.alt = name;
    wrap.appendChild(img);
    return wrap;
  }

  const link = document.createElement('a');
  link.className = 'detail-attachment detail-attachment--file';
  link.href = urls.download;
  link.download = name;
  const icon = document.createElement('i');
  icon.dataset.lucide = 'paperclip';
  icon.className = 'icon-md';
  icon.setAttribute('aria-hidden', 'true');
  link.append(icon, document.createTextNode(name));
  return link;
}

/* Kalendername als farbiger Chip - in der DETAILFLÄCHE, seit die Agendazeile
 * ihn abgegeben hat: dort sagte er dasselbe wie die Farbspur an ihrer linken
 * Kante, und er tat es als drittes Element einer Metazeile, die deswegen
 * umbrach. Hier ist er die einzige Stelle, an der der Kalendername ausdrücklich
 * steht. */
function calendarChipNode(ev) {
  if (!ev.cal_name) return null;
  const chip = document.createElement('span');
  chip.className = 'event-cal-label';
  chip.style.setProperty('--cal-color', ev.cal_color || ev.color || resolveEventColor(ev));
  chip.textContent = ev.cal_name;
  return chip;
}

/** Erinnerungen im Klartext („1 Tag vorher"), statt sie ganz zu verschweigen. */
function reminderSummary(ev, reminders) {
  const list = Array.isArray(reminders) ? reminders : [];
  if (!list.length) return '';
  const labels = REMINDER_OFFSETS();
  return list
    .map((r) => {
      const value = reminderOffsetFromEvent(ev, r);
      const match = labels.find((o) => o.value === value && o.value !== '');
      // „Benutzerdefiniert…" ist als Auswahl-Label gedacht, nicht als Aussage -
      // in der Leseansicht steht stattdessen der tatsächliche Zeitpunkt.
      return value === 'custom' || !match
        ? formatDateTime(parseRemindAtAsUtc(r.remind_at))
        : match.label;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Die Leseinformationen eines Termins.
 *
 * Wiederholung, Erinnerungen und Sichtbarkeit standen bisher nur im
 * Bearbeitungsformular - wer wissen wollte, ob ein Termin wöchentlich
 * wiederkehrt, musste ihn zum Bearbeiten öffnen.
 */
function renderEventDetail(ev, reminders = []) {
  const timeStr = ev.all_day
    ? `${formatPreferredDate(localDate(ev.start_datetime))} · ${t('calendar.allDay')}`
    : formatDateTime(ev.start_datetime)
      + (ev.end_datetime ? ` – ${formatTime(ev.end_datetime)} ${timeSuffix()}`.trimEnd() : '');

  return [
    { icon: 'calendar', label: t('calendar.detailCalendar'), node: calendarChipNode(ev) },
    { icon: 'clock', label: t('calendar.detailWhen'), value: timeStr },
    recurrenceRow(ev.recurrence_rule),
    { icon: 'map-pin', label: t('calendar.locationLabel'), value: ev.location ? fmtLocation(ev.location) : '' },
    assignedRow(ev.assigned_users, t('calendar.assignedLabel'), ev.assigned_name || ''),
    {
      icon: 'bell',
      label: reminders.length > 1 ? t('reminders.sectionTitlePlural') : t('reminders.sectionTitle'),
      value: reminderSummary(ev, reminders),
    },
    visibilityRow(ev.visibility),
    // Nur wenn markiert (#647): eine Zeile „Countdown: nein" an jedem Termin
    // wäre ein Feld, das die Leseansicht erklärt statt sie zu beantworten. Die
    // Detailansicht lässt leere Werte ohnehin weg.
    { icon: 'hourglass', label: t('dashboard.countdownTitle'), value: ev.countdown ? t('calendar.countdownDetail') : '' },
    {
      icon: 'align-left',
      label: t('calendar.descriptionLabel'),
      value: ev.description ? truncateDescription(ev.description, 500) : '',
      multiline: true,
    },
    { icon: 'paperclip', label: t('calendar.attachmentLabel'), node: attachmentNode(ev) },
  ];
}

/**
 * Der einzige Einstieg in einen bestehenden Termin. Ohne Anker (Deep-Link,
 * Suchtreffer) wird daraus ein Sheet, mit Anker am Desktop ein Popover.
 */
async function openEventDetail(ev, anchor = null) {
  // Haushaltshilfe-Besuche werden in ihrem eigenen Modul bearbeitet; der Umweg
  // über eine Detailansicht führte sonst ins Leere.
  if (ev?.housekeeping_visit_id) {
    window.yuvomi.navigate(`/housekeeping?editVisit=${ev.housekeeping_visit_id}`);
    return;
  }

  // Die Erinnerungen kosten einen eigenen Serveraufruf; alles andere steckt
  // schon im Termin. Früher wurde davor gewartet, und der Antipp-Moment - der
  // einzige, dessen ganzer Zweck Leichtigkeit ist - blieb einen Roundtrip lang
  // stumm. Jetzt läuft der Aufruf neben dem Öffnen her und die Zeile kommt
  // nach. Die Sync-Ziele braucht nur das Formular, die lädt erst dessen mount().
  let reminders = [];
  const remindersReady = loadReminderForEvent(ev.id).then((r) => { reminders = r; });

  const actions = [{
    id: 'detail-delete',
    label: t('common.delete'),
    variant: 'danger-ghost',
    icon: 'trash-2',
    align: 'start',
    // force + await: Löschen entscheidet über die Eingaben mit, eine
    // Verwerfen-Frage davor wäre die zweite Rückfrage für dieselbe
    // Entscheidung. Der await hält das Löschen zurück, bis der Overlay-Slot
    // wirklich frei ist - requestDeleteEvent öffnet bei Serien selbst einen
    // Dialog, und das Shared-Modal kennt kein Stacking.
    onClick: async ({ close }) => { await close({ force: true }); await requestDeleteEvent(ev); },
  }];

  // ICS-Abos: Ein lokal geänderter Termin lässt sich auf das Original
  // zurücksetzen. Die Aktion gehört zum Objekt, also in die Fußzeile.
  if (ev.external_source === 'ics' && ev.user_modified === 1) {
    actions.push({
      id: 'detail-ics-reset',
      label: t('calendar.ics.reset'),
      variant: 'ghost',
      icon: 'rotate-ccw',
      onClick: async ({ close }) => {
        try {
          await api.post(`/calendar/${ev.id}/reset`, {});
          // Der Schreibvorgang ist durch - ohne force fragte der Dirty-Guard
          // nach dem Verwerfen von Änderungen, die der Reset ohnehin
          // zurückgenommen hat (#625).
          await close({ force: true });
          await reloadForView();
          window.yuvomi?.showToast(t('calendar.ics.resetToast'), 'success');
        } catch (err) {
          // Server-Meldung bevorzugen (nutzerorientiert), sonst lokalisierter
          // Fallback — nie den rohen JS-/Netzwerk-Fehlertext zeigen.
          window.yuvomi?.showToast(err.data?.error ?? t('calendar.saveError'), 'danger');
        }
      },
    });
  }

  const view = openDetailView({
    title: ev.title,
    accentColor: resolveEventBackground(ev),
    anchor,
    sections: renderEventDetail(ev, reminders),
    actions,
    edit: {
      label: t('common.edit'),
      title: t('calendar.editEvent'),
      // Das Formular wartet auf die Erinnerungen, die Leseansicht nicht. Ohne
      // diese Sperre baute ein sofortiger Klick auf „Bearbeiten" das Formular
      // ohne Erinnerungszeilen auf - und saveEvent löscht die Erinnerungen des
      // Termins, wenn es keine Zeile findet.
      ready: remindersReady,
      mount: (panel, pane) => {
        pane.insertAdjacentHTML('beforeend', buildEventModalContent({ mode: 'edit', event: ev, reminder: reminders }));
        wireEventForm(panel, { mode: 'edit', event: ev, reminder: reminders });
      },
      // Am Desktop bleibt der gewohnte Weg: Popover zu, Formular auf.
      standalone: async () => {
        await remindersReady;
        openEventModal({ mode: 'edit', event: ev, reminder: reminders });
      },
    },
  });

  // Die Erinnerungszeile nachtragen. Zeilen ohne Inhalt fallen ohnehin weg, ein
  // Termin ohne Erinnerung bewegt sich also gar nicht. `update` verwirft sich
  // selbst, wenn der Nutzer inzwischen etwas anderes geöffnet hat.
  await remindersReady;
  if (reminders.length) view.update(renderEventDetail(ev, reminders));
}

// --------------------------------------------------------
// Reminder-Helfer für Kalender-Events
// --------------------------------------------------------

async function loadReminderForEvent(eventId) {
  try {
    const data = await api.get(`/reminders/all?entity_type=event&entity_id=${eventId}`);
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

// Obergrenze für mehrere Erinnerungen je Termin — muss mit dem Server-Cap
// (MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js) übereinstimmen.
const MAX_CALENDAR_REMINDERS = 5;

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
  const remindMs = parseRemindAtAsUtc(reminder.remind_at).getTime();
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
    (new Date(reminderStartValue(event.start_datetime)).getTime() - parseRemindAtAsUtc(reminder.remind_at).getTime()) / 60000
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

/**
 * Rendert eine einzelne Erinnerungs-Zeile (Offset-Select + Custom-Felder +
 * Entfernen-Button). Ohne Argument entsteht eine leere Standardzeile (#436).
 */
function reminderRowHtml({ offset = '0', amount = 1, unit = 'days' } = {}) {
  const isCustom = offset === 'custom';
  return `
    <div class="reminder-row" data-reminder-row>
      <div class="reminder-row__main">
        <select class="form-input js-reminder-offset" aria-label="${esc(t('reminders.offsetLabel'))}">
          ${REMINDER_OFFSETS().filter((o) => o.value !== '').map((o) =>
            `<option value="${o.value}" ${offset === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
          ).join('')}
        </select>
        <button type="button" class="btn btn--ghost btn--icon js-reminder-remove" aria-label="${esc(t('reminders.removeReminder'))}">
          <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
      <div class="modal-grid modal-grid--2 reminder-custom js-reminder-custom" ${isCustom ? '' : 'hidden'}>
        <div class="form-group" style="margin:0">
          <label class="form-label">${t('reminders.customAmountLabel')}</label>
          <input class="form-input js-reminder-custom-amount" type="number" min="1" max="999" value="${amount}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">${t('reminders.customUnitLabel')}</label>
          <select class="form-input js-reminder-custom-unit">
            <option value="minutes" ${unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
            <option value="hours" ${unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
            <option value="days" ${unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
            <option value="weeks" ${unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
          </select>
        </div>
      </div>
    </div>`;
}

function renderCalendarReminderSection(reminders = [], event = null, defaultOffsets = []) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  let rows = list.map((rem) => ({
    offset: reminderOffsetFromEvent(event, rem) || '0',
    ...customReminderFromEvent(event, rem),
  }));
  // Neue Termine ohne bestehende Erinnerung: Standard-Erinnerungen vorbelegen (#497).
  // Die Default-Offsets decken sich mit den Preset-Werten des Offset-Selects.
  if (rows.length === 0 && Array.isArray(defaultOffsets) && defaultOffsets.length) {
    rows = defaultOffsets.map((min) => ({ offset: String(min), amount: 1, unit: 'days' }));
  }
  const enabled = rows.length > 0;
  const rowsHtml = (enabled ? rows : [{ offset: '0', amount: 1, unit: 'days' }])
    .map((r) => reminderRowHtml(r)).join('');
  /* NUR WER DEN TERMIN ANGELEGT HAT, TEILT SEINE ERINNERUNG (#921) - und nur
   * der bekommt den Hinweis. Fuer alle anderen waere er unwahr: wer sich an
   * einem fremden Termin einen Merker setzt, setzt ihn fuer sich, damit nicht
   * der halbe Haushalt eine Meldung bekommt, weil ein Einzelner sich etwas
   * notiert hat. Ein neuer Termin gehoert dem, der ihn gerade anlegt. */
  const sharesReminder = !event || event.created_by === state.currentUserId;
  return `
    <div class="reminder-section">
      <div class="reminder-section__header">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="modal-reminder-toggle" ${enabled ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span class="reminder-section__title">${t('reminders.enableLabel')}</span>
        </label>
      </div>
      <div id="modal-reminder-fields" class="reminder-fields" ${enabled ? '' : 'style="display:none"'}>
        <div class="reminder-rows" id="modal-reminder-rows">
          ${rowsHtml}
        </div>
        <button type="button" class="btn btn--secondary btn--sm" id="modal-reminder-add">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>
          ${t('reminders.addReminder')}
        </button>
        ${sharesReminder ? `<p class="form-hint">${t('reminders.sharedWithAssignees')}</p>` : ''}
      </div>
    </div>`;
}

/**
 * Verdrahtet die Mehrfach-Erinnerungs-Liste im Event-Modal (#436):
 * Toggle, „Hinzufügen"/„Entfernen" und die Custom-Feld-Umschaltung je Zeile.
 */
function wireReminderRows(panel) {
  const toggle = panel.querySelector('#modal-reminder-toggle');
  const fields = panel.querySelector('#modal-reminder-fields');
  const rowsEl = panel.querySelector('#modal-reminder-rows');
  const addBtn = panel.querySelector('#modal-reminder-add');
  if (!rowsEl) return;

  const rowCount = () => rowsEl.querySelectorAll('[data-reminder-row]').length;
  const syncAddState = () => {
    if (addBtn) addBtn.disabled = rowCount() >= MAX_CALENDAR_REMINDERS;
  };

  const appendRow = () => {
    rowsEl.insertAdjacentHTML('beforeend', reminderRowHtml());
    const newRow = rowsEl.lastElementChild;
    if (window.lucide && newRow) lucide.createIcons({ el: newRow });
    syncAddState();
  };

  // Custom-Felder je Zeile ein-/ausblenden.
  rowsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.js-reminder-offset');
    if (!sel) return;
    const custom = sel.closest('[data-reminder-row]')?.querySelector('.js-reminder-custom');
    if (custom) custom.hidden = sel.value !== 'custom';
  });

  // Zeile entfernen.
  rowsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('.js-reminder-remove');
    if (!rm) return;
    rm.closest('[data-reminder-row]')?.remove();
    syncAddState();
  });

  addBtn?.addEventListener('click', () => {
    if (rowCount() >= MAX_CALENDAR_REMINDERS) return;
    appendRow();
  });

  toggle?.addEventListener('change', () => {
    const on = toggle.checked;
    if (fields) fields.style.display = on ? '' : 'none';
    if (on && rowCount() === 0) appendRow();
  });

  syncAddState();
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

  // Ziele über die gemeinsame Lese-Route holen (#618): die Verwaltungsrouten
  // sind admin-only und lieferten Familienmitgliedern nur 403 - übrig blieb
  // "Lokal speichern". /sync-targets liefert bereits gefiltert (aktiviert +
  // beschreibbar) und ohne Zugangsdaten.
  let targets = { google: [], caldav: [], outlook: [] };
  try {
    const res = await api.get('/calendar/sync-targets');
    targets = {
      google: res.data?.google || [],
      caldav: res.data?.caldav || [],
      outlook: res.data?.outlook || [],
    };
  } catch (err) {
    console.warn('Failed to load sync targets:', err);
  }

  if (targets.google.length) {
    const group = document.createElement('optgroup');
    group.className = 'js-google-targets';
    group.label = t('calendar.syncTargetGoogleGroup');
    for (const cal of targets.google) {
      const option = document.createElement('option');
      option.value = googleTargetValue(cal.id);
      option.textContent = cal.summary || cal.id;
      group.appendChild(option);
    }
    selectElement.appendChild(group);
  }

  // CalDAV-Kalender nach Konto gruppieren - die Route liefert sie kontoweise
  // sortiert, ein Wechsel der accountId beginnt die nächste optgroup.
  let caldavGroup = null;
  let caldavGroupAccountId = null;
  for (const cal of targets.caldav) {
    if (caldavGroupAccountId !== cal.accountId) {
      caldavGroup = document.createElement('optgroup');
      caldavGroup.label = `${t('calendar.syncTargetCaldavGroup')} · ${cal.accountName}`;
      caldavGroupAccountId = cal.accountId;
      selectElement.appendChild(caldavGroup);
    }
    const option = document.createElement('option');
    option.value = caldavTargetValue(cal.accountId, cal.calendarUrl);
    option.textContent = cal.calendarName || cal.calendarUrl;
    caldavGroup.appendChild(option);
  }

  // Outlook-Kalender nach Konto gruppieren (gleiche Grammatik wie CalDAV).
  let outlookGroup = null;
  let outlookGroupAccountId = null;
  for (const cal of targets.outlook) {
    if (outlookGroupAccountId !== cal.accountId) {
      outlookGroup = document.createElement('optgroup');
      outlookGroup.label = `${t('calendar.syncTargetOutlookGroup')} · ${cal.accountName}`;
      outlookGroupAccountId = cal.accountId;
      selectElement.appendChild(outlookGroup);
    }
    const option = document.createElement('option');
    option.value = outlookTargetValue(cal.accountId, cal.calendarId);
    option.textContent = cal.calendarName || cal.calendarId;
    outlookGroup.appendChild(option);
  }

  // Pre-select the editing event's existing target
  if (currentEvent?.target_google_calendar_id) {
    const value = googleTargetValue(currentEvent.target_google_calendar_id);
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
    selectElement.value = caldavTargetValue(currentEvent.target_caldav_account_id, currentEvent.target_caldav_calendar_url);
  } else if (currentEvent?.target_outlook_account_id && currentEvent?.target_outlook_calendar_id) {
    selectElement.value = outlookTargetValue(currentEvent.target_outlook_account_id, currentEvent.target_outlook_calendar_id);
  } else if (!currentEvent) {
    // Nur für NEUE Termine (#620). Ein bestehender Termin behält sein Ziel, auch
    // wenn es "Lokal" ist - sonst würde das Öffnen und Speichern eines lokalen
    // Termins ihn stillschweigend in einen Kalender schieben.
    applyDefaultSyncTarget(selectElement);
  }
}

/**
 * Setzt das persönliche Standard-Sync-Ziel (#620) als Vorauswahl.
 *
 * Steht das gespeicherte Ziel nicht (mehr) in der Liste - Kalender deaktiviert,
 * gelöscht, auf nur-lesend gestellt oder Konto entfernt - bleibt es bei "Lokal
 * speichern". Die Alternative, die Option nachzutragen wie beim Bearbeiten eines
 * Termins, wäre hier falsch: dort rettet sie ein bereits gesetztes Ziel, hier
 * würde sie einen neuen Termin auf einen Kalender richten, der ihn nicht
 * annehmen kann.
 */
function applyDefaultSyncTarget(selectElement) {
  const target = state.defaultSyncTarget;
  if (!target) return;
  const available = Array.from(selectElement.options).some((o) => o.value === target);
  if (available) selectElement.value = target;
}

// --------------------------------------------------------
// Event-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

// Blendet einen Hinweis ein, wenn „Nur Zugewiesene" gewählt ist, aber niemand
// zugewiesen wurde — dann sieht faktisch nur der Ersteller den Termin (#474 Guard).
function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const update = () => {
    const count = getSelectedUserIds(panel, msName).length;
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  update();
}

function openEventModal({ mode, event = null, date = null, reminder = null, time = null }) {
  if (mode === 'edit' && event?.housekeeping_visit_id) {
    window.yuvomi.navigate(`/housekeeping?editVisit=${event.housekeeping_visit_id}`);
    return;
  }
  const isEdit = mode === 'edit';
  const content = buildEventModalContent({ mode, event, date, reminder, time });

  openSharedModal({
    title: isEdit ? t('calendar.editEvent') : t('calendar.newEvent'),
    content,
    size: 'md',
    // Ein neuer Termin startet weiterhin mit dem Fokus im Titelfeld: Hier ist
    // Tippen die Absicht, hier ist der Autofokus richtig.
    onSave(panel) { wireEventForm(panel, { mode, event, reminder }); },
  });
}

/**
 * Verdrahtet das Termin-Formular. Eigene Funktion, weil das Formular an zwei
 * Orten entsteht: als eigenes Modal (neuer Termin, Desktop-Bearbeiten) und als
 * zweites Pane der Detailansicht, das erst beim Wechsel gemountet wird.
 */
function wireEventForm(panel, { mode, event = null, reminder = null }) {
  const isEdit = mode === 'edit';
  // RRULE-Events binden
  bindRRuleEvents(panel, 'event');
  bindRecurringScopeChooser(panel, 'modal-edit');
  bindUserMultiSelect(panel, 'cal_assigned');
  wireVisibilityWarning(panel, '#modal-visibility', 'cal_assigned', '#modal-visibility-warning');

  // Der Farbwaehler war bis v2.35.0 ausgegraut, sobald jemand zugewiesen war,
  // mit dem Hinweis, die Farbe der Person schlage sie ohnehin. Seit #815 steht
  // die Terminfarbe in resolveEventColor VORN, womit der Hinweis unwahr wurde -
  // die Sperre nahm dem Nutzer eine Wahl ab, um ein Versprechen zu halten, das
  // der Code nicht mehr gab (#856). Sie ist deshalb weg und bleibt weg.
  //
  // Seit #891 ist die Aussage von damals wieder erreichbar, nur als WAHL statt
  // als Sperre: der Erben-Swatch traegt sie, und wer stattdessen eine Farbe
  // waehlt, behaelt sie. Wer der Termin ist, sagt weiterhin der Avatar-Stack.

  // Leerstring = der Erben-Swatch. Ein neuer Termin startet dort, und ein
  // bestehender ohne eigene Farbe steht dort ebenfalls - beides ist seit #891
  // ein ausdrueckbarer Zustand und nicht mehr der Palettenerste als Notloesung.
  const selectedColor = isEdit ? (event?.color || COLOR_INHERIT) : COLOR_INHERIT;

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
    if (sameColor(sw.dataset.color, selectedColor)) selectSwatch(sw);
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

  // Erinnerungen: Toggle blendet die Zeilenliste ein/aus; „Hinzufügen" und
  // „Entfernen" verwalten mehrere Erinnerungen je Termin (#436).
  wireReminderRows(panel);

  // Load unified sync targets (Google + CalDAV)
  const syncTargetSelect = panel.querySelector('#event-sync-target');
  if (syncTargetSelect) {
    // Outlook ist der einzige One-way-Push: Aenderungen in Outlook werden beim
    // naechsten Sync ueberschrieben. Der Hinweis gehoert an die Stelle der
    // Zielwahl, nicht nur in die Sync-Einstellungen. Erst nach loadSyncTargets
    // pruefen - die Vorauswahl eines bestehenden Outlook-Ziels setzt das select
    // asynchron.
    const outlookHint = panel.querySelector('#event-sync-target-outlook-hint');
    const syncOutlookHint = () => {
      if (outlookHint) outlookHint.hidden = !syncTargetSelect.value.startsWith('outlook:');
    };
    syncTargetSelect.addEventListener('change', syncOutlookHint);
    loadSyncTargets(syncTargetSelect, event).then(syncOutlookHint);
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

  // Dynamische Termindauer (#441): das Ende folgt dem Start um die gemerkte
  // Dauer. Ändert der Nutzer das Ende, wird die neue Dauer übernommen und bei
  // der nächsten Start-Änderung angewendet. Nur für Zeit-Termine.
  wireDurationMemory(panel);

  panel.querySelector('#modal-cancel').addEventListener('click', closeModal);

  panel.querySelector('#modal-delete')?.addEventListener('click', async () => {
    closeModal({ force: true });
    await requestDeleteEvent(event);
  });

  panel.querySelector('#modal-save').addEventListener('click', () => saveEvent(panel, mode, event, reminder, attachmentState));
  // Pflichtfelder melden sich beim Verlassen inline statt erst beim
  // Speichern als ortloser Toast (Critique P1).
  wireBlurValidation(panel);
  if (window.lucide) lucide.createIcons({ el: panel });
}

/**
 * Verdrahtet die dynamische Termindauer (#441) im Event-Modal.
 * - Start-Zeit ändern → Ende = Start + gemerkte Dauer (mit Datums-Übertrag).
 * - Ende-Zeit ändern → gemerkte Dauer = Ende − Start (nur wenn positiv).
 * Wirkt nur auf die Zeit-Felder; „Ganztägig" bleibt unberührt.
 */
function wireDurationMemory(panel) {
  const startDateEl = panel.querySelector('#modal-start-date');
  const startTimeEl = panel.querySelector('#modal-start-time');
  const endDateEl   = panel.querySelector('#modal-end-date');
  const endTimeEl   = panel.querySelector('#modal-end-time');
  if (!startDateEl || !startTimeEl || !endDateEl || !endTimeEl) return;

  const daysBetween = (fromKey, toKey) =>
    Math.round((new Date(toKey + 'T00:00:00') - new Date(fromKey + 'T00:00:00')) / 86400000);

  const readDuration = () => {
    const sd = parseDateInput(startDateEl.value);
    const st = parseTimeInput(startTimeEl.value);
    const ed = parseDateInput(endDateEl.value);
    const et = parseTimeInput(endTimeEl.value);
    if (!sd || !st || !ed || !et) return null;
    const diff = daysBetween(sd, ed) * 1440 + (timeToMinutes(et) - timeToMinutes(st));
    return diff > 0 ? diff : null;
  };

  // Init: bereits gesetzte Dauer übernehmen, sonst Präferenz-Default.
  let durationMin = readDuration() ?? (state.defaultDuration || 60);

  startTimeEl.addEventListener('change', () => {
    const sd = parseDateInput(startDateEl.value);
    const st = parseTimeInput(startTimeEl.value);
    if (!sd || !st) return;
    const next = addDurationToDateTime(sd, st, durationMin);
    endTimeEl.value = formatTimeInput(next.time);
    if (isDateInputValid(endDateEl.value)) endDateEl.value = formatDateInput(next.date);
  });

  endTimeEl.addEventListener('change', () => {
    const dur = readDuration();
    if (dur) durationMin = dur;
  });
}

// Neue Termine ohne explizite Uhrzeit starten heute zur nächsten halben
// Stunde: der starre 09:00-Default legte den Start nachmittags in die
// Vergangenheit (Audit A1-18). Andere Tage behalten 09:00 als neutralen
// Start; kippt die Rundung über Mitternacht, ebenfalls.
function defaultNewEventTime(dateStr) {
  if (dateStr !== state.today) return '09:00';
  // Auf die naechste halbe Stunde aufrunden - auf den Feldern der Haushaltszone
  // statt auf einem Date, damit der Vorschlag zu der Uhr passt, die daneben im
  // Raster steht. Kippt die Rundung ueber Mitternacht, bleibt es bei 09:00.
  const { hour, minute } = nowFields();
  const rounded = minute <= 30 ? { hour, minute: 30 } : { hour: hour + 1, minute: 0 };
  if (rounded.hour > 23) return '09:00';
  return `${pad(rounded.hour)}:${pad(rounded.minute)}`;
}

function buildEventModalContent({ mode, event, date, reminder = null, time = null }) {
  const isEdit = mode === 'edit';
  const today  = date || state.today;

  const startDate = isEdit ? localDate(event.start_datetime) : today;
  const startTime = isEdit && event.start_datetime.length > 10
    ? localTime(event.start_datetime) : (time ?? defaultNewEventTime(today));
  // Standard-Termindauer aus den Präferenzen: neue Termine erhalten ein Ende,
  // das um die konfigurierte Dauer nach dem Start liegt (#441).
  const durationMin = state.defaultDuration || 60;
  const derivedEnd  = addDurationToDateTime(startDate, startTime, durationMin);
  const endDate   = isEdit && event.end_datetime ? localDate(event.end_datetime) : derivedEnd.date;
  const endTime   = isEdit && event.end_datetime && event.end_datetime.length > 10
    ? localTime(event.end_datetime)
    : derivedEnd.time;
  const selectedIcon = eventIconName(isEdit ? event.icon : 'calendar');

  // Neue Termine: optional den aktuellen Nutzer vorbelegen (#498).
  const selectedUserIds = isEdit
    ? (event.assigned_users?.map((u) => u.id) ?? (event.assigned_to ? [event.assigned_to] : []))
    : (state.defaultAssignMe && state.currentUserId != null ? [state.currentUserId] : []);
  const visibility = (isEdit ? event.visibility : null) || 'all';

  // Sekundärfelder: wandern hinter „Weitere Einstellungen". Beim Bearbeiten
  // automatisch geöffnet, falls bereits Werte gesetzt sind. Der Ort steht als
  // Alltagsfeld im Hauptbereich (Audit A1-11), nicht mehr hier.
  const advancedFieldsOpen = isEdit
    && (!!event.description || hasAttachment(event));

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" id="event-color-label">${t('calendar.colorLabel')}</label>
      <div class="color-picker" id="event-color-picker" role="radiogroup" aria-labelledby="event-color-label">
        <!-- Steht vorn, weil er der Standard ist: ein Termin, fuer den niemand
             eine Farbe gewaehlt hat, traegt die der zugewiesenen Person (#891).
             Traegt bewusst KEIN Inline-background - seine Optik kommt aus
             calendar.css, weil sie eine Designentscheidung ist und keine
             Nutzereinstellung. -->
        <div class="color-swatch color-swatch--inherit" data-color=""
             role="radio"
             tabindex="0"
             aria-checked="false"
             aria-label="${esc(t('calendar.colorInherit'))}"
             title="${esc(t('calendar.colorInheritHint'))}"></div>
        ${pickerColors(isEdit ? event : null).map((c) => `
          <div class="color-swatch" data-color="${esc(c)}" style="background-color:${esc(c)};"
               role="radio"
               tabindex="-1"
               aria-checked="false"
               aria-label="${esc(EVENT_COLOR_NAMES()[c] ?? t('calendar.colorCurrent'))}"></div>
        `).join('')}
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="event-sync-target">${t('calendar.syncTargetLabel')}</label>
      <select class="form-input" id="event-sync-target">
        <option value="">${t('calendar.syncTargetLocal')}</option>
      </select>
      <small class="form-hint">${t('calendar.syncTargetHint')}</small>
      <small class="form-hint" id="event-sync-target-outlook-hint" hidden>${t('settings.outlookPushHint')}</small>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-description">${t('calendar.descriptionLabel')}</label>
      <textarea class="form-input" id="modal-description" rows="2"
                placeholder="${t('calendar.descriptionPlaceholder')}">${esc(isEdit && event.description ? event.description : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-attachment">${t('calendar.attachmentLabel')}</label>
      <p class="document-storage-target">
        <i data-lucide="${state.documentUploadBackend === 'webdav' ? 'cloud' : state.documentUploadBackend === 'local_folder' ? 'folder' : 'database'}" aria-hidden="true"></i>
        <span>${t('documents.activeUploadTarget', {
          target: state.documentUploadBackend === 'webdav'
            ? t('documents.storageWebdav')
            : state.documentUploadBackend === 'local_folder'
              ? t('documents.storageLocalFolder')
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
        <input type="text" class="form-input" id="modal-title" required
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
          <yuvomi-datepicker type="date" id="modal-start-date" value="${esc(formatDateInput(startDate))}" label="${esc(t('calendar.startDateLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-start-time">${t('calendar.startTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="modal-start-time" value="${esc(formatTimeInput(startTime))}" label="${esc(t('calendar.startTimeLabel'))}"></yuvomi-datepicker>
        </div>
      </div>
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-end-date">${t('calendar.endDateLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-end-date" value="${esc(formatDateInput(endDate))}" label="${esc(t('calendar.endDateLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-end-time">${t('calendar.endTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="modal-end-time" value="${esc(formatTimeInput(endTime))}" label="${esc(t('calendar.endTimeLabel'))}"></yuvomi-datepicker>
        </div>
      </div>
    </div>

    <div id="allday-fields" style="display:none;">
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="form-label" for="modal-allday-start">${t('calendar.fromLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-allday-start" value="${esc(formatDateInput(startDate))}" label="${esc(t('calendar.fromLabel'))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="modal-allday-end">${t('calendar.toLabel')}</label>
          <yuvomi-datepicker type="date" id="modal-allday-end" value="${esc(formatDateInput(endDate))}" label="${esc(t('calendar.toLabel'))}"></yuvomi-datepicker>
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

    ${state.users.length > 1 ? `
    <div class="form-group">
      <label class="form-label" for="modal-visibility">${t('common.visibility.label')}</label>
      <select class="input" id="modal-visibility" name="visibility">
        <option value="all"       ${visibility === 'all'       ? 'selected' : ''}>${t('common.visibility.all')}</option>
        <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${t('common.visibility.assignees')}</option>
        <option value="private"   ${visibility === 'private'   ? 'selected' : ''}>${t('common.visibility.private')}</option>
      </select>
      <p class="form-hint">${t('common.visibility.hint')}</p>
      <p class="form-hint field-hint--warn" id="modal-visibility-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('common.visibility.assigneesNobodyHint')}</span></p>
    </div>` : ''}

    <!-- #647: der Schalter, den @Kyrodan beschrieben hat - „einen Termin als
         Countdown markieren" statt eines zweiten Systems daneben. Er steht im
         Hauptbereich und nicht hinter „Weitere Einstellungen", weil er der
         einzige Weg zu diesem Feature ist: hinter dem Aufklapper gaebe es die
         Kachel fuer niemanden, der nicht danach sucht. -->
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" id="modal-countdown" aria-describedby="modal-countdown-hint"
               ${isEdit && event.countdown ? 'checked' : ''}>
        <span class="toggle__track"></span>
        <span>${t('calendar.countdownToggle')}</span>
      </label>
      <!-- cal-field-hint UND NICHT form-hint: die Regel fuer form-hint steht in
           settings.css, und der Router laedt genau ein Page-CSS pro Seite - auf
           /calendar ist sie schlicht nicht geladen. Der Hinweis rendert dort in
           16px voller Primaertinte und war damit lauter als der Schalter, zu dem
           er gehoert (gemessen 4 Zeilen / 94px).
           Die uebrigen fuenf form-hint dieses Dialogs haben dasselbe Problem und
           app-weit noch 34 weitere in elf Modulen - das ist ein eigener Umzug
           und keine Beifang-Aenderung dieses Features. -->
      <p class="cal-field-hint" id="modal-countdown-hint">${t('calendar.countdownHint')}</p>
    </div>

    ${advancedSection(advancedFieldsHtml, { open: advancedFieldsOpen })}

    ${renderRRuleFields('event', isEdit ? event.recurrence_rule : null, { allowCount: true, expandsFromStart: true })}

    ${isEdit && isLocalRecurringSeries(event) ? renderRecurringScopeChooser('modal-edit', event.start_datetime.slice(0, 10)) : ''}

    ${renderCalendarReminderSection(reminder, event, isEdit ? [] : state.defaultReminders)}

    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button class="btn btn--danger-outline" id="modal-delete">
        <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}
      </button>` : '<div></div>'}
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--ghost" id="modal-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="modal-save">${isEdit ? t('common.save') : t('common.create')}</button>
      </div>
    </div>`;
}

async function saveEvent(overlay, mode, event, existingReminder = null, attachmentState = null) {
  const eventId = event?.id;
  const saveBtn = overlay.querySelector('#modal-save');
  const title   = overlay.querySelector('#modal-title').value.trim();

  if (!title) {
    // Fehler am Ort des Geschehens statt als Toast unten links (Critique P1):
    // Meldung unterm Feld, Fehler-Rahmen, Fokus + Scroll aufs Feld.
    reportFieldError(overlay.querySelector('#modal-title'), t('calendar.titleRequired'));
    return;
  }

  const allday  = overlay.querySelector('#modal-allday').checked;
  const color   = colorToSave(overlay.querySelector('.color-swatch--active')?.dataset.color, event);
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
      reportFieldError(
        overlay.querySelector(stRaw && !st ? '#modal-start-time' : '#modal-end-time'),
        t('calendar.invalidDate')
      );
      return;
    }
    start_datetime = st ? `${sd}T${st}` : sd;
    end_datetime   = ed ? (et ? `${ed}T${et}` : ed) : null;
  }

  const visibleDateFields = allday
    ? ['#modal-allday-start', '#modal-allday-end']
    : ['#modal-start-date', '#modal-end-date'];
  const invalidDateField = visibleDateFields.find((selector) => !isDateInputValid(overlay.querySelector(selector)?.value));
  if (!start_datetime || invalidDateField) {
    reportFieldError(
      overlay.querySelector(invalidDateField ?? visibleDateFields[0]),
      t('calendar.invalidDate')
    );
    return;
  }
  if (isEndBeforeStart(start_datetime, end_datetime)) {
    // Der Fehler klebt am Feld, das ihn verursacht: liegt schon das Enddatum
    // vor dem Startdatum, am Datums-Feld; sonst (gleicher Tag, Zeit davor)
    // an der Endzeit.
    const endsOnEarlierDay = String(end_datetime).slice(0, 10) < String(start_datetime).slice(0, 10);
    const endField = (allday ? overlay.querySelector('#modal-allday-end') : null)
      ?? (endsOnEarlierDay ? overlay.querySelector('#modal-end-date') : null)
      ?? (overlay.querySelector('#modal-end-time')?.value ? overlay.querySelector('#modal-end-time') : null)
      ?? overlay.querySelector('#modal-end-date');
    reportFieldError(endField, t('calendar.endBeforeStart'));
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const rrule = getRRuleValues(overlay, 'event');
    if (!rrule.valid_until) {
      reportFieldError(overlay.querySelector('#event-rrule-until'), t('calendar.invalidDate'));
      saveBtn.disabled    = false;
      saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
      return;
    }
    const attachmentFile = overlay.querySelector('#modal-attachment')?.files?.[0];
    let attachmentPayload = null;
    if (attachmentFile) {
      if (attachmentFile.size > maxUploadBytes()) throw new Error(t('calendar.attachmentTooLarge', { size: maxUploadMb() }));
      attachmentPayload = {
        name: attachmentFile.name,
        mime: attachmentFile.type || 'application/octet-stream',
        size: attachmentFile.size,
        data: await readFileAsDataUrl(attachmentFile),
      };
    }

    // Extract sync target (unified Google + CalDAV + Outlook picker)
    const syncTargetValue = overlay.querySelector('#event-sync-target')?.value || '';
    let target_google_calendar_id = null;
    let target_caldav_account_id = null;
    let target_caldav_calendar_url = null;
    let target_outlook_account_id = null;
    let target_outlook_calendar_id = null;

    if (syncTargetValue.startsWith('google:')) {
      target_google_calendar_id = syncTargetValue.slice('google:'.length);
    } else if (syncTargetValue.startsWith('caldav:')) {
      const [accountId, calendarUrl] = syncTargetValue.slice('caldav:'.length).split('|');
      if (accountId && calendarUrl) {
        target_caldav_account_id = parseInt(accountId, 10);
        target_caldav_calendar_url = calendarUrl;
      }
    } else if (syncTargetValue.startsWith('outlook:')) {
      const [accountId, calendarId] = syncTargetValue.slice('outlook:'.length).split('|');
      if (accountId && calendarId) {
        target_outlook_account_id = parseInt(accountId, 10);
        target_outlook_calendar_id = calendarId;
      }
    }

    const body = {
      title, description, start_datetime, end_datetime,
      all_day: allday ? 1 : 0,
      location, color, icon, assigned_to,
      visibility: overlay.querySelector('#modal-visibility')?.value || 'all',
      countdown: overlay.querySelector('#modal-countdown')?.checked ? 1 : 0,
      recurrence_rule: rrule.recurrence_rule,
      target_google_calendar_id,
      target_caldav_account_id,
      target_caldav_calendar_url,
      target_outlook_account_id,
      target_outlook_calendar_id,
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
    // Start, an dem die Erinnerungs-Offsets ausgerichtet werden. Für „ganze Serie"
    // wird das auf den (evtl. verschobenen) Master-Start umgestellt (#532).
    let reminderBaseStart = start_datetime;
    // Serien-Scopes ändern die Expansion (Split/EXDATE): danach den sichtbaren
    // Bereich neu laden, damit der Server korrekt expandiert (#532).
    let reloadAfter = false;

    if (mode === 'create') {
      const res = await api.post('/calendar', body);
      state.events.push(res.data);
      savedEventId = res.data?.id;
    } else {
      // Scope-Auswahl greift nur für rein lokale Serien (#532); sonst normaler
      // Master-Update wie bisher (Einzeltermine, externe Serien).
      const scope = isLocalRecurringSeries(event)
        ? getRecurringScope(overlay, 'modal-edit')
        : 'series';
      const occDate = event?.start_datetime?.slice(0, 10);
      // Am Anfang der Serie wird der Master aktualisiert statt geschnitten -
      // warum das nicht an `is_recurring_instance` allein haengt, steht bei der
      // Funktion.
      const truncated = scope === 'following' && !followingMeansWholeSeries(event)
        ? truncateRuleBefore(event.recurrence_rule, occDate)
        : null;

      if (scope === 'this') {
        // Nur dieses Vorkommen: losgelösten Einzeltermin anlegen + Master-EXDATE.
        const res = await api.post('/calendar', { ...body, recurrence_rule: null });
        await api.post(`/calendar/${eventId}/exceptions`, { date: occDate });
        savedEventId = res.data?.id;
        reloadAfter = true;
      } else if (truncated) {
        // Dieser und folgende: Master per UNTIL kürzen, neue Serie ab hier anlegen.
        // body trägt die (ggf. bearbeitete) recurrence_rule als Fortsetzungsregel.
        await api.put(`/calendar/${eventId}`, { recurrence_rule: truncated });
        const res = await api.post('/calendar', body);
        savedEventId = res.data?.id;
        reloadAfter = true;
      } else {
        // Ganze Serie (auch „folgende" beim ersten Vorkommen): Master aktualisieren.
        // Bei lokalen Serien den DTSTART erhalten, indem die im Modal sichtbare
        // Instanz-Verschiebung auf den Master-Start übertragen wird.
        let seriesBody = body;
        if (isLocalRecurringSeries(event)) {
          const master  = (await api.get(`/calendar/${eventId}`)).data;
          const allDay  = !!body.all_day;
          const newStart = shiftSeriesStart(master.start_datetime, event.start_datetime, start_datetime, allDay);
          const newEnd   = shiftEndForStart(newStart, start_datetime, end_datetime, allDay);
          seriesBody = { ...body, start_datetime: newStart, end_datetime: newEnd };
          reminderBaseStart = newStart;
          reloadAfter = true;
        }
        const res = await api.put(`/calendar/${eventId}`, seriesBody);
        const idx = state.events.findIndex((e) => e.id === eventId);
        if (idx !== -1) state.events[idx] = res.data;
      }
    }

    // Erinnerungen speichern oder löschen (mehrere je Termin möglich, #436).
    if (savedEventId) {
      const reminderOn = overlay.querySelector('#modal-reminder-toggle')?.checked;
      const rowsEl     = overlay.querySelector('#modal-reminder-rows');
      const startMs    = new Date(reminderStartValue(reminderBaseStart)).getTime();
      let remindAts = [];

      if (reminderOn && rowsEl) {
        for (const row of rowsEl.querySelectorAll('[data-reminder-row]')) {
          const offsetVal = row.querySelector('.js-reminder-offset')?.value;
          if (offsetVal == null || offsetVal === '') continue;
          const offsetMinutes = offsetVal === 'custom'
            ? customReminderMinutes(
                row.querySelector('.js-reminder-custom-amount')?.value,
                row.querySelector('.js-reminder-custom-unit')?.value
              )
            : parseInt(offsetVal, 10);
          remindAts.push(new Date(startMs - offsetMinutes * 60000).toISOString().slice(0, 19));
        }
        remindAts = [...new Set(remindAts)].slice(0, MAX_CALENDAR_REMINDERS);
      }

      if (remindAts.length) {
        await api.put(`/reminders?entity_type=event&entity_id=${savedEventId}`, { remind_ats: remindAts });
      } else {
        await api.delete(`/reminders?entity_type=event&entity_id=${savedEventId}`).catch(() => {});
      }
      refreshReminders();
    }

    if (reloadAfter) {
      await reloadCalendarEventsOnly();
    }

    closeModal({ force: true });
    renderView();
    window.yuvomi?.showToast(mode === 'create' ? t('calendar.createdToast') : t('calendar.savedToast'), 'success');
  } catch (err) {
    // Server-Validierungsmeldung bevorzugen, sonst lokalisierter Fallback; der
    // rohe err.message-Text (Netzwerk/JS) wird nie gezeigt. Das Modal bleibt offen
    // und der Button reaktiviert — die Eingaben des Nutzers bleiben erhalten.
    window.yuvomi?.showToast(err.data?.error ?? t('calendar.saveError'), 'danger');
    saveBtn.disabled    = false;
    saveBtn.textContent = mode === 'edit' ? t('common.save') : t('common.create');
  }
}

async function deleteEvent(id) {
  const event = state.events.find((e) => e.id === id);
  state.events = state.events.filter((e) => e.id !== id);
  renderView();

  scheduleUndoableDelete({
    message: t('calendar.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/calendar/${id}`, { keepalive });
      api.delete(`/reminders?entity_type=event&entity_id=${id}`, { keepalive }).catch(() => {});
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
    },
    restore: (err) => {
      if (event) {
        state.events = [...state.events, event];
        renderView();
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('calendar.deleteError'), 'danger');
    },
  });
}

/**
 * Gemeinsame Scope-Auswahl für Serientermine (#532): identisches Control für
 * „Bearbeiten" und „Löschen". Select (App-weites Formular-Vokabular) mit Default
 * „Nur diesen Termin" (least-destructive) plus dynamischem Reichweiten-Hinweis,
 * der das konkrete Vorkommensdatum nennt. `prefix` → Element-ID `${prefix}-scope`.
 */
function renderRecurringScopeChooser(prefix, occDateKey) {
  return `
    <div class="form-group">
      <label class="form-label" for="${prefix}-scope">${t('calendar.recurringScopeLabel')}</label>
      <select class="input" id="${prefix}-scope" name="${prefix}-scope" data-occ-date="${esc(occDateKey)}">
        <option value="this" selected>${t('calendar.recurringScopeThis')}</option>
        <option value="following">${t('calendar.recurringScopeFollowing')}</option>
        <option value="series">${t('calendar.recurringScopeSeries')}</option>
      </select>
      <p class="form-hint" id="${prefix}-scope-hint" role="status"></p>
    </div>`;
}

/** Reichweiten-Hinweistext für den gewählten Scope (mit formatiertem Datum). */
function recurringScopeHint(value, occDateKey) {
  if (value === 'series') return t('calendar.recurringScopeHintSeries');
  const date = formatPreferredDate(occDateKey);
  return value === 'following'
    ? t('calendar.recurringScopeHintFollowing', { date })
    : t('calendar.recurringScopeHintThis', { date });
}

/** Verdrahtet den dynamischen Hinweis der Scope-Auswahl. No-op ohne Chooser. */
function bindRecurringScopeChooser(root, prefix) {
  const sel  = root.querySelector(`#${prefix}-scope`);
  const hint = root.querySelector(`#${prefix}-scope-hint`);
  if (!sel || !hint) return;
  const update = () => { hint.textContent = recurringScopeHint(sel.value, sel.dataset.occDate); };
  sel.addEventListener('change', update);
  update();
}

/** Liest den gewählten Scope; Default „this" (least-destructive). */
function getRecurringScope(root, prefix) {
  return root.querySelector(`#${prefix}-scope`)?.value || 'this';
}

/**
 * Einstiegspunkt für das Löschen (#489/#532). Lokale Serien fragen „nur dieser
 * Termin" / „dieser und folgende" / „ganze Serie"; Einzeltermine werden direkt
 * gelöscht (der Undo-Toast trägt die Rücknahme).
 *
 * Externe Serien können die Auswahl nicht anbieten: Yuvomi kann eine Serie, die
 * einem anderen Kalender gehört, nicht lokal aufteilen - ein ausgenommenes
 * Vorkommen käme beim nächsten Sync zurück. Gelöscht wird deshalb die ganze
 * Serie. Das ist richtig, aber es wortlos zu tun war es nicht: wer im Monat auf
 * einen Termin tippt und löscht, sieht ohne Vorwarnung alle Vorkommen
 * verschwinden (#880). Die Rückfrage benennt die Reichweite, statt sie
 * anzubieten - ein Dialog mit nur einer wählbaren Antwort wäre eine Attrappe.
 */
/**
 * Die Rückfrage für eine Serie, die einem anderen Kalender gehört (#880).
 *
 * Drei Fälle, drei verschiedene Wahrheiten - und eine Zusage, die nicht hält,
 * ist schlimmer als gar keine, denn sie ist der einzige Grund, überhaupt zu
 * fragen:
 *
 * - Ein Geburtstagstermin ist das Abbild seines Geburtstags, nicht sein
 *   Original: `syncBirthdayCalendarEvent` legt ihn beim nächsten Abgleich neu
 *   an und lädt ihn wieder hoch (server/services/birthdays.js).
 * - Ein Termin aus einem ICS-Abo ist doppelt unlöschbar: `OUTBOUND_SOURCES`
 *   kennt kein `ics`, es wird also nichts an der Quelle gelöscht, und der
 *   nächste Aboabruf legt ihn wieder an (kein Tombstone in ics-subscription.js).
 * - Bei Google, CalDAV und Apple greift die Löschung meistens bis zur Quelle
 *   durch - aber eben nur meistens: `acceptsOutbound` verlangt eine schreibende
 *   Verbindung, und ein Google-Konto im Nur-Lesen-Modus oder ein entferntes
 *   CalDAV-Konto hat keine. Der Dialog sagt deshalb NICHT mehr, dass die Serie
 *   auch im Quellkalender fällt; er sagt, was Yuvomi garantieren kann - dass
 *   alle Vorkommen fallen, nicht nur das angetippte. Das ist die Warnung, um
 *   die es hier geht. Alles Weitere wüsste erst der Server, und dafür eine
 *   Auskunft durch die Leseroute zu ziehen, wäre für eine Textnuance ein zu
 *   hoher Preis (heisser Pfad, expandierte Serien).
 *
 * Die drei Aufrufe stehen ausgeschrieben statt über einen zusammengesetzten
 * Schlüssel: `jeder als gefaehrlich markierte Dialog nennt seine Folgen`
 * (test-frontend-audit.js) liest den Schlüssel aus dem Aufruf und wäre an einem
 * `t(`${prefix}Detail`)` erblindet - bei einem Dialog, dessen ganzer Zweck es
 * ist, seine Folgen zu benennen, ist das der falsche Handel.
 *
 * `birthday_name` ist der etablierte Marker; die Leseroute hängt ihn nur an
 * Termine, die zu einem Geburtstag gehören.
 */
function confirmExternalSeriesDelete(event) {
  const title = event.title;
  if (event.birthday_name && event.birthday_event_kind === 'name_day') {
    return confirmModal(t('calendar.deleteNameDayEventTitle'), {
      detail:       t('calendar.deleteNameDayEventDetail', { title }),
      confirmLabel: t('calendar.deleteNameDayEventConfirm'),
      danger:       true,
    });
  }
  if (event.birthday_name) {
    return confirmModal(t('calendar.deleteBirthdayEventTitle'), {
      detail:       t('calendar.deleteBirthdayEventDetail', { title }),
      confirmLabel: t('calendar.deleteBirthdayEventConfirm'),
      danger:       true,
    });
  }
  if (event.subscription_id) {
    return confirmModal(t('calendar.deleteSubscribedSeriesTitle'), {
      detail:       t('calendar.deleteSubscribedSeriesDetail', { title }),
      confirmLabel: t('calendar.deleteSubscribedSeriesConfirm'),
      danger:       true,
    });
  }
  return confirmModal(t('calendar.deleteExternalSeriesTitle'), {
    detail:       t('calendar.deleteExternalSeriesDetail', { title }),
    confirmLabel: t('calendar.deleteExternalSeriesConfirm'),
    danger:       true,
  });
}

async function requestDeleteEvent(event) {
  if (isExternalRecurringSeries(event)) {
    if (await confirmExternalSeriesDelete(event)) await deleteEvent(event.id);
    return;
  }
  if (!isLocalRecurringSeries(event)) {
    await deleteEvent(event.id);
    return;
  }
  const choice = await recurringDeleteChoice(event);
  if (choice === 'series') await deleteEvent(event.id);
  else if (choice === 'following') await deleteThisAndFollowing(event);
  else if (choice === 'this') await deleteSingleOccurrence(event);
  // null → abgebrochen, nichts tun
}

/**
 * Auswahl-Dialog für das Löschen wiederkehrender Termine (#532). Nutzt dieselbe
 * Scope-Komponente wie das Bearbeiten-Modal (Konsistenz) plus einen destruktiven
 * „Löschen"-Bestätiger. Löst zu 'this' | 'following' | 'series' | null.
 */
function recurringDeleteChoice(event) {
  const occDateKey = event.start_datetime.slice(0, 10);
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    };
    openSharedModal({
      title: t('calendar.deleteRecurringTitle'),
      size: 'sm',
      content: `
        ${renderRecurringScopeChooser('rds', occDateKey)}
        <div class="modal-actions modal-actions--stack">
          <button type="button" class="btn btn--danger" id="rds-confirm">${t('common.delete')}</button>
          <button type="button" class="btn btn--ghost" id="rds-cancel">${t('common.cancel')}</button>
        </div>`,
      onClose: () => finish(null),
      onSave(panel) {
        bindRecurringScopeChooser(panel, 'rds');
        panel.querySelector('#rds-confirm')?.addEventListener('click', () => finish(getRecurringScope(panel, 'rds')));
        panel.querySelector('#rds-cancel')?.addEventListener('click', () => finish(null));
      },
    });
  });
}

/**
 * Löscht dieses und alle folgenden Vorkommen einer lokalen Serie (#532), indem die
 * RRULE per UNTIL auf den Vortag gekürzt wird. Ist das geöffnete Vorkommen bereits
 * das erste der Serie, verschwindet sie ganz. Optimistisch + Undo.
 */
async function deleteThisAndFollowing(event) {
  // Am Anfang der Serie ist "dieser und folgende" die ganze Serie - warum das
  // nicht an `is_recurring_instance` allein haengt, steht bei der Funktion.
  if (followingMeansWholeSeries(event)) {
    await deleteEvent(event.id);
    return;
  }
  const fromKey = event.start_datetime.slice(0, 10);
  const newRule = truncateRuleBefore(event.recurrence_rule, fromKey);
  if (!newRule) { await deleteEvent(event.id); return; }

  const affects = (e) => e.id === event.id && e.start_datetime.slice(0, 10) >= fromKey;
  const removed = state.events.filter(affects);
  state.events  = state.events.filter((e) => !affects(e));
  renderView();

  scheduleUndoableDelete({
    message: t('calendar.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.put(`/calendar/${event.id}`, { recurrence_rule: newRule }, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      // Verbleibende Instanzen tragen künftig die gekürzte Regel.
      for (const e of state.events) if (e.id === event.id) e.recurrence_rule = newRule;
    },
    restore: (err) => {
      state.events = [...state.events, ...removed];
      renderView();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('calendar.deleteError'), 'danger');
    },
  });
}

/**
 * Nimmt genau ein Vorkommen einer lokalen Serie aus (#489), mit optimistischer
 * Entfernung und Undo-Toast wie beim regulären Löschen.
 */
async function deleteSingleOccurrence(event) {
  const date       = event.start_datetime.slice(0, 10);
  const matches    = (e) => e.id === event.id && e.start_datetime.slice(0, 10) === date;
  const removed    = state.events.filter(matches);
  state.events     = state.events.filter((e) => !matches(e));
  renderView();

  scheduleUndoableDelete({
    message: t('calendar.deletedToast'),
    commit: ({ keepalive }) => api.post(`/calendar/${event.id}/exceptions`, { date }, { keepalive }),
    restore: (err) => {
      state.events = [...state.events, ...removed];
      renderView();
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('calendar.deleteError'), 'danger');
    },
  });
}
