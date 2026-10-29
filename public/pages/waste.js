/**
 * Page: Waste collection (#1063)
 * Purpose: manage waste types and their pickup schedules (weekly, monthly on a
 *          fixed day or on the n-th weekday), move or skip a single calculated
 *          occurrence, record one-off pickups, show upcoming pickups, import
 *          an ICS file once or subscribe to an ICS URL, and set the personal
 *          pickup reminders. Endpoints: /waste/types, /schedules (with
 *          .../overrides), /pickups, /occurrences, /import/preview and
 *          /import/commit, /sources, /reminder-settings. The Dashboard widget
 *          lives in utils/dashboard-widgets.js, the Calendar layer in
 *          pages/calendar.js.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { dateText, dateRangeText, dateWithDistanceText } from '/utils/date-format.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { formSwitchRowHtml } from '/settings/components.js';
import { todayKey, addLocalDays, parseLocalDateKey, toLocalDateKey } from '/utils/date.js';
import { openModal, closeModal, captureModalContext, captureOpenContext, isModalContextCurrent, confirmModal, confirmOverModal, btnLoading, refocusAfterRender, reportFieldError, dialogInitialFocus } from '/components/modal.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import {
  renderAppPage, renderPageHeader, renderPageTitle, renderPageBody,
  renderPageActions, renderListSection, renderPageColumns,
} from '/utils/page-layout.js';
import { findPageFab, setPageFabAction } from '/utils/fab.js';
import { pageToolsMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { createPageController } from '/utils/page-lifecycle.js';
import { colorPickerHtml, setColorPickerValue, wireColorPicker } from '/utils/color-picker.js';
import { intervalSentenceHtml, setIntervalSentenceKey } from '/utils/interval-sentence.js';
import { USER_COLORS } from '/utils/color.js';
import { redrawList } from '/utils/list-motion.js';
import { errorSentence, isGone, isAlreadyDeleted } from '/utils/friendly-error.js';
import { maxUploadBytes, maxUploadMb } from '/utils/upload-limit.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';

const UPCOMING_WINDOW_DAYS = 90;
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_LABEL_KEYS = {
  MO: 'waste.weekdayMon', TU: 'waste.weekdayTue', WE: 'waste.weekdayWed', TH: 'waste.weekdayThu',
  FR: 'waste.weekdayFri', SA: 'waste.weekdaySat', SU: 'waste.weekdaySun',
};
// -1 (last) or 1-4 (nth) - the same bound server/services/waste-domain.js's
// own ORDINAL_WEEKDAY_VALUES accepts (#1063 Phase 9).
const ORDINAL_WEEKDAY_VALUES = [1, 2, 3, 4, -1];
const ORDINAL_LABEL_KEYS = {
  1: 'waste.ordinalFirst', 2: 'waste.ordinalSecond', 3: 'waste.ordinalThird',
  4: 'waste.ordinalFourth', '-1': 'waste.ordinalLast',
};
// Sunday=0..Saturday=6, matching server/services/recurrence.js's own DAY_MAP -
// needed here only to pre-fill a valid anchor_date, never to compute an
// actual occurrence (the server remains the one place recurrence math lives).
const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Same nth/last-weekday-of-month math as recurrence.js's own nthWeekdayOfMonth, for anchor pre-fill only.
 *  Rechnet auf LOKALEN Date-Feldern, damit das Ergebnis ohne Umweg ueber die
 *  UTC-Getter durch toLocalDateKey() zurueck zum Datums-Key darf - ein per
 *  Date.UTC gebautes Date liest toLocalDateKey westlich von UTC einen Tag
 *  frueher. Der Eingabe-Key kommt aus todayKey(), der Ausgabe-Key ist ein
 *  Kalendertag; Zonen kommen in dieser Rechnung nirgends vor. */
function nthWeekdayOfMonthLocal(year, month, weekday, ordinal) {
  if (ordinal === -1) {
    const last = new Date(year, month + 1, 0);
    const diff = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - diff);
  }
  const first = new Date(year, month, 1);
  const diff = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + diff + (ordinal - 1) * 7);
}

/** Naechster Kalendertag am/nach "heute", der selbst das gewaehlte
 *  Ordinal-Vorkommen ist (n-ter/letzter Wochentag des Monats), als Datums-Key.
 *  Der Anker muss serverseitig selbst auf der Regel liegen (dieselbe
 *  Konsistenz-Invariante wie bei monthly_fixed_day), deshalb rechnet das
 *  Schedule-Modal ihn vor, statt den Nutzer ein passendes Datum von Hand
 *  suchen zu lassen. todayKeyValue ist injizierbar, damit der Test einen
 *  festen Tag unter einer fremden Zone anlegen kann; der Default bleibt
 *  todayKey(). */
function nearestOrdinalAnchorDateKey(ordinal, weekdayCode, todayKeyValue = todayKey()) {
  const weekday = DAY_INDEX[weekdayCode];
  const today = parseLocalDateKey(todayKeyValue);
  const candidateInThisMonth = nthWeekdayOfMonthLocal(today.getFullYear(), today.getMonth(), weekday, ordinal);
  const target = candidateInThisMonth >= today
    ? candidateInThisMonth
    : nthWeekdayOfMonthLocal(today.getFullYear(), today.getMonth() + 1, weekday, ordinal);
  return toLocalDateKey(target);
}
// Die Vorlagen ziehen ihre Farbe aus der geteilten Startpalette
// (utils/color.js, Re-Critique 2026-09-28): Sperrmuell trug vorher #7C3AED -
// im Dark exakt die Flaeche des Primaerknopfs -, Restmuell und Wertstoff
// lagen auf der gehobenen Dark-Karte unter 3:1. Bestehende Abfallarten
// behalten ihre Farbe; das Raster zeigt sie dann als „Aktuelle Farbe".
const TYPE_PRESETS = [
  { key: 'general', icon: 'trash-2', color: '#78808C' },
  { key: 'recycling', icon: 'recycle', color: '#3B82F6' },
  { key: 'organic', icon: 'leaf', color: '#16A34A' },
  { key: 'paper', icon: 'newspaper', color: '#D97706' },
  { key: 'glass', icon: 'wine', color: '#059669' },
  { key: 'bulky', icon: 'armchair', color: '#D946EF' },
];

/**
 * DIE KURATIERTE PALETTE ERSETZT DEN FREIEN FARBWAEHLER (Audit UX,
 * 2026-09-12). Der Dialog bot vorher ein nacktes `<input type="color">` an -
 * also 16,7 Millionen Farben ohne jede Untergrenze. Wer dort Weiss, Hellgelb
 * oder Schwarz waehlte, bekam ein Abfallart-Symbol, das auf der Karte
 * praktisch verschwand (hell auf hellem Grund) bzw. im dunklen Thema
 * unsichtbar wurde - und nichts im Dialog hielt ihn davon ab.
 *
 * Dieselbe Antwort, die Notizen, Kalender, Budget und der
 * Kategorie-Verwalter auf dieselbe Frage schon geben: eine kleine feste
 * Auswahl statt eines Regenbogens. Seit der Re-Critique 2026-09-28 ist es die
 * geteilte Startpalette `USER_COLORS` (utils/color.js): jede Farbe dort haelt
 * >= 3:1 auf `--color-surface` und `--color-surface-raised` in BEIDEN Themes
 * - der fruehere Kommentar versprach das, #7C3AED (2.57) und #2563EB (2.84)
 * hielten es auf dem dunklen Kartengrund nicht.
 *
 * Jede Preset-Farbe steht im Raster: nur so kann die Preset-Auswahl im
 * Dialog ihre Farbe als aktiven Swatch zeigen, statt einen Wert zu setzen,
 * den das Raster gar nicht kennt.
 *
 * KEIN `getReadableTextColor()`. Diese Farbe wird nirgends als TEXTfarbe auf
 * einem freien Grund gesetzt - waste.js faerbt damit ausschliesslich das
 * `aria-hidden` SVG-Symbol der Zeile (Typkarte und Abholzeile). Sie ist damit
 * eine Schmuckfarbe im Sinne der User-Farben-Regel, kein Schriftzug, und
 * braucht keine gerechnete Tinte - wohl aber die Untergrenze, die diese
 * Palette ist.
 */
const WASTE_TYPE_COLORS = USER_COLORS;

let _container = null;
let state = { types: [], schedules: [], occurrences: [], sources: [], loading: true, error: null, upcomingExpanded: false };
// Router-bridged controller (#976/#977, see /utils/page-lifecycle.js) for the
// currently active render(): a stale response applied after the page has
// been navigated away from - or superseded by a newer render() before the
// first one's fetch resolved - checks `.signal.aborted` and draws nothing.
let _pageController = null;

function schedulesForType(typeId) {
  return state.schedules.filter((s) => s.type_id === typeId);
}

function typeById(id) {
  return state.types.find((t2) => t2.id === id) || null;
}

async function loadData() {
  state.error = null;
  try {
    const from = todayKey();
    const to = addLocalDays(from, UPCOMING_WINDOW_DAYS);
    const [typesRes, schedulesRes, occRes, sourcesRes] = await Promise.all([
      api.get('/waste/types?include_archived=1'),
      api.get('/waste/schedules'),
      api.get(`/waste/occurrences?from=${from}&to=${to}`),
      api.get('/waste/sources'),
    ]);
    state.types = typesRes.data;
    state.schedules = schedulesRes.data;
    state.occurrences = occRes.data;
    state.sources = sourcesRes.data;
  } catch (err) {
    state.error = err;
  }
}

// -------------------------------------------------------------------------
// Upcoming pickups
// -------------------------------------------------------------------------

function originBadges(occurrence) {
  const parts = [];
  if (occurrence.moved) {
    const original = occurrence.origins.find((o) => o.kind === 'schedule' && o.original_date)?.original_date;
    parts.push(`<span class="waste-badge waste-badge--moved">${esc(t('waste.movedFromBadge', { date: original ? dateText(original) : '' }))}</span>`);
  }
  if (occurrence.coalesced) {
    parts.push(`<span class="waste-badge waste-badge--coalesced" title="${esc(t('waste.coalescedHint'))}">${esc(t('waste.coalescedHint'))}</span>`);
  }
  return parts.join('');
}

/**
 * Darf dieser Nutzer im Abfuhr-Modul schreiben?
 *
 * Die VERBINDLICHE Sperre liegt am Server - das zentrale Gate an /api/v1
 * (server/index.js) beantwortet jedes POST/PUT/DELETE unter /waste mit 403,
 * sobald das Modul auf „Nur lesen" steht. Diese Abfrage hier ist die ehrliche
 * UI-Entsprechung dazu, nicht die Sperre selbst: ohne sie trug die Seite fuer
 * einen Nur-lesen-Nutzer vier Kopfknoepfe, jedes Zeilenmenue und jeden
 * Typ-Knopf voll bedienbar, und JEDER dieser Wege endete erst im ausgefuellten
 * Formular an einem 403. Zum Vergleich: components/task-detail.js.
 *
 * Als Funktion und nicht als Konstante, weil ein Rechtewechsel (Admin passt
 * Modulrechte an) ohne Reload ankommt und jedes Re-Render neu fragen soll.
 */
function readOnly() {
  return isNavModuleReadOnly('waste');
}

// Jede `data-action` dieser Seite, die NICHT schreibt. Der delegierte Handler
// laesst im Nur-lesen-Modus genau diese durch und blockt den Rest. Eine
// Positivliste, damit eine spaeter ergaenzte Schreib-Aktion standardmaessig
// gesperrt ist statt standardmaessig offen - die Markup-Unterdrueckung unten
// ist die erste Verteidigungslinie, das hier die zweite (eine veraltete oder
// per Devtools wiederbelebte Schaltflaeche findet denselben Riegel).
const READ_SAFE_ACTIONS = new Set(['open-source', 'toggle-upcoming-rest']);

/**
 * Pure: wann eine Abholung ist, so wie man danach fragt (Critique R17, E2):
 * Wochentag, Datum und der Abstand - "Fr., 30.10. · in 6 Tagen". Bis R17 stand
 * dort nur "09.10.2026": ob das diese oder naechste Woche ist und an welchem
 * Tag die Tonne raus muss, rechnete man selbst.
 *
 * Seit R23 (D11) die Regel von utils/date-format.js: "in 6 Tagen" statt
 * "6 Tage" (las sich wie eine Dauer), das Jahr nur ausserhalb des laufenden,
 * heute und morgen als Wort allein. Gerechnet auf den KEYS der Haushaltszone;
 * ein vergangener Tag traegt keinen Abstand.
 */
function pickupWhenLabel(dateKey, today = todayKey()) {
  return dateWithDistanceText(dateKey, { today, past: false });
}

function occurrenceRowHtml(occurrence) {
  const hasScheduleOrigin = occurrence.origins.some((o) => o.kind === 'schedule');
  const oneOff = occurrence.origins.find((o) => o.kind === 'one_off');
  const menuId = `waste-occ-menu-${esc(occurrence.key.replace(/[^a-z0-9]/gi, '-'))}`;
  // WAS EINE ZEILE ANBIETET, HAENGT AN IHRER HERKUNFT.
  //
  // Verschieben, ueberspringen und zuruecksetzen haengen an einer Serie: der
  // Server legt die Ausnahme unter der Serie ab (PUT /waste/schedules/:id/
  // overrides/:date) und weist ein Datum zurueck, das die Serie gar nicht
  // berechnet. Bearbeiten und loeschen wiederum gibt es nur fuer den einzelnen
  // Termin, der eine eigene Zeile in der Datenbank hat.
  //
  // Eine EINGELESENE Abholung (kind: 'import') hat beides nicht: sie gehoert
  // keiner Serie und keinem Einzeltermin, sondern ihrer Quelle, und wird beim
  // naechsten Abgleich aus ihr erneuert. Fuer sie bleibt die Liste leer - das
  // ist kein Versehen, sondern der ehrliche Stand: an ihr laesst sich hier
  // nichts aendern.
  const menuItems = [
    ...(hasScheduleOrigin ? [
      `<button type="button" role="menuitem" class="popover-menu__item" data-action="move-occurrence"><i data-lucide="calendar-clock" aria-hidden="true"></i>${esc(t('waste.moveAction'))}</button>`,
      `<button type="button" role="menuitem" class="popover-menu__item" data-action="skip-occurrence"><i data-lucide="skip-forward" aria-hidden="true"></i>${esc(t('waste.skipAction'))}</button>`,
      ...(occurrence.moved ? [`<button type="button" role="menuitem" class="popover-menu__item" data-action="restore-occurrence"><i data-lucide="rotate-ccw" aria-hidden="true"></i>${esc(t('waste.restoreOccurrenceAction'))}</button>`] : []),
    ] : []),
    ...(oneOff ? [
      `<button type="button" role="menuitem" class="popover-menu__item" data-action="edit-pickup" data-id="${oneOff.one_off_id}"><i data-lucide="pencil" aria-hidden="true"></i>${esc(t('common.edit'))}</button>`,
      `<button type="button" role="menuitem" class="popover-menu__item popover-menu__item--danger" data-action="delete-pickup" data-id="${oneOff.one_off_id}"><i data-lucide="trash-2" aria-hidden="true"></i>${esc(t('common.delete'))}</button>`,
    ] : []),
  ].join('\n            ');

  // Jeder Eintrag dieses Menues schreibt (verschieben, ueberspringen,
  // zuruecksetzen, bearbeiten, loeschen) - im Nur-lesen-Modus faellt es
  // deshalb ganz weg statt als leeres Menue stehenzubleiben.
  //
  // UND KEIN KNOPF OHNE INHALT: der Drei-Punkte-Knopf stand vorher an JEDER
  // Zeile, auch an den eingelesenen. Dort zog er ein zehn Pixel hohes, leeres
  // Kaestchen auf - gemessen an „Gelbe Tonne" und „Bioabfall" aus einer
  // URL-Quelle. Die Zeile versprach damit Aktionen, die es fuer sie nicht gibt,
  // und der Nutzer suchte den Fehler bei sich („ich kann die Optionen nicht
  // sehen"). Dieselbe Bedingung traegt deshalb jetzt beides: Knopf und Menue.
  // Der Name des Menueknopfs nennt Art UND Tag: dieselbe Abfallart steht in
  // der aufgeklappten Liste mehrfach.
  const occurrenceName = `${occurrence.type_name ?? ''}, ${dateText(occurrence.date_key)}`;
  const actions = (readOnly() || !menuItems) ? '' : `
      <div class="row-actions">
        <button type="button" class="row-action" popovertarget="${menuId}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('common.moreActionsNamed', { name: occurrenceName }))}">
          <i data-lucide="more-horizontal" aria-hidden="true"></i>
        </button>
        <!-- Das geteilte .popover-menu (utils/popover-menu.js + layout.css), nicht
             eine vierte Lokalkopie: die Position im Top-Layer MUSS gerechnet
             werden, und eine eigene display-Regel ohne :popover-open schlaegt
             das UA-Blatt. Genau daran stand dieses Menue vorher bei (0,0) ueber
             der linken oberen Ecke und fing die Klicks fremder Zeilen ab. -->
        <div class="popover-menu" id="${menuId}" popover role="menu">
            ${menuItems}
        </div>
      </div>`;

  // ZWEI KLASSENNOTIZEN, die fuer ALLE vier Zeilentypen dieses Moduls gelten
  // (Abholung, Abfallart, Serie, Quelle) - deshalb stehen sie hier, an der
  // ersten Zeile, und nicht viermal:
  //
  // 1. `waste-row` ist die gemeinsame Marke. Dieses Modul steckt das Symbol MIT
  //    IN `.list-row__main` und buendelt Name und Meta darunter in
  //    `.list-row__body` - eine Struktur, die list-row.css nicht kennt und die
  //    waste.css deshalb selbst bedienen muss (Symbol | Textspalte als
  //    Flex-Zeile). Die Marke sagt genau: „diese Zeile hat den Symbol-Slot".
  //
  // 2. `list-row__main` steht IMMER, `--interactive` nur zusaetzlich. Der
  //    Modifikator traegt ausschliesslich die Knopf-Zuruecksetzung (Rand,
  //    Polsterung, Cursor); `flex: 1 1 auto` und `min-width: 0` kommen aus der
  //    Basisklasse. Wo er allein stand, loeste die Textspalte auf ihre
  //    Inhaltsbreite auf und zog die Bedienzone mit: gemessen 372px Luft rechts
  //    neben dem „..."-Knopf der Abfallart. Vorrat und Inventar schreiben
  //    darum beide Klassen nebeneinander - hier fehlte die Basis.
  return `
    <div class="list-row waste-row waste-occurrence-row" data-key="${esc(occurrence.key)}" data-type-id="${occurrence.type_id}" data-date="${esc(occurrence.date_key)}">
      <div class="list-row__main">
        <i data-lucide="${esc(occurrence.type_icon || 'trash-2')}" style="color:${esc(occurrence.type_color || '')}" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(occurrence.type_name ?? '')}</span>
          <span class="list-row__meta">${occurrence.date_key === todayKey()
    // HEUTE IST DIE WICHTIGSTE ZEILE DER SEITE (Critique R24,
    // G2-Entsorgung-P3-2): sie stand als "Heute" in derselben Metafarbe wie
    // "in 2 Tagen". Jetzt ein Etikett im Modulton, das sagt, was zu tun ist.
    ? `<span class="tag waste-today-tag">${esc(t('waste.putOutToday'))}</span>`
    : esc(pickupWhenLabel(occurrence.date_key))} ${originBadges(occurrence)}</span>
        </span>
      </div>
      ${actions}
    </div>`;
}

/**
 * Pure: `occurrences` (already date-sorted, per-type-order tie-broken - the
 * store's own sort) split into one row per type ("primary", its earliest/
 * next occurrence) and everything after that ("rest"). A full year's import
 * turns "Upcoming pickups" into dozens of rows per type; the page shows only
 * what the Dashboard widget already shows by default, and folds the rest
 * behind a collapsed-by-default disclosure instead of flooding the page.
 */
function splitUpcomingByType(occurrences) {
  const seenTypes = new Set();
  const primary = [];
  const rest = [];
  for (const occ of occurrences) {
    if (!seenTypes.has(occ.type_id)) {
      seenTypes.add(occ.type_id);
      primary.push(occ);
    } else {
      rest.push(occ);
    }
  }
  return { primary, rest };
}

/** Pure: does the deep-linked occurrence live in the collapsed "rest" section, not a type's own visible primary row? */
function deepLinkNeedsExpand(occurrences, { typeId, date }) {
  if (!typeId || !date) return false;
  return splitUpcomingByType(occurrences).rest.some((occ) => occ.type_id === typeId && occ.date_key === date);
}

/* DIE DREI LISTEN DER SEITE BAUEN SICH BEI JEDER AENDERUNG NEU (R16, Bewegung).
 * Jede hat ihren eigenen Traeger, der das Neuzeichnen ueberlebt - redrawList()
 * (utils/list-motion.js) haelt davor die Lage fest und bewegt danach, was sich
 * geaendert hat: der erste Aufbau nach dem Skelett blendet gestaffelt ein, eine
 * neue Abholung, Abfallart oder Quelle zieht auf, und was nachrueckt oder die
 * Reihenfolge wechselt (Abfallart hoch/runter), gleitet an seine Stelle. */
function renderUpcoming() {
  const host = _container.querySelector('#waste-upcoming-list');
  if (!host) return;
  redrawList(host, () => drawUpcoming(host), { selector: '.waste-occurrence-row[data-key]', keyAttr: 'data-key' });
}

function drawUpcoming(host) {
  if (state.loading) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 4, lines: 2 }));
    return;
  }
  if (!state.occurrences.length) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', emptyStateHTML({
      title: t('waste.emptyUpcomingTitle'),
      description: t('waste.emptyUpcomingDescription'),
    }));
    if (window.lucide) window.lucide.createIcons({ el: host });
    return;
  }
  host.replaceChildren();
  const { primary, rest } = splitUpcomingByType(state.occurrences);
  host.insertAdjacentHTML('beforeend', primary.map(occurrenceRowHtml).join(''));
  if (rest.length) {
    const expanded = state.upcomingExpanded === true;
    host.insertAdjacentHTML('beforeend', `
      <button type="button" class="waste-upcoming-toggle" data-action="toggle-upcoming-rest"
              aria-expanded="${expanded}" aria-controls="waste-upcoming-rest">
        <i data-lucide="chevron-down" class="waste-upcoming-toggle__icon" aria-hidden="true"></i>
        <span>${esc(expanded ? t('waste.upcomingShowLess') : t('waste.upcomingShowMore', { count: rest.length }))}</span>
      </button>
      <div class="row-divided" id="waste-upcoming-rest"${expanded ? '' : ' hidden'}>
        ${rest.map(occurrenceRowHtml).join('')}
      </div>
    `);
  }
  if (window.lucide) window.lucide.createIcons({ el: host });
}

// -------------------------------------------------------------------------
// Types & schedules
// -------------------------------------------------------------------------

// Der Screenreader-Name der Serienzeile: Abfallart UND Rhythmus. Der Rhythmus
// allein („Jeden Montag") steht unter jeder Abfallart gleich da; erst die Art
// macht die Zeile unterscheidbar.
function scheduleRowName(schedule) {
  const summary = recurrenceSummary(schedule);
  const typeName = typeById(schedule.type_id)?.name;
  return typeName ? `${typeName}, ${summary}` : summary;
}

function recurrenceSummary(schedule) {
  if (schedule.recurrence_kind === 'weekly') {
    const days = String(schedule.weekdays ?? '').split(',').filter(Boolean).map((code) => t(WEEKDAY_LABEL_KEYS[code]) || code).join(', ');
    return schedule.interval > 1
      ? t('waste.summaryWeeklyInterval', { interval: schedule.interval, days })
      : t('waste.summaryWeekly', { days });
  }
  if (schedule.recurrence_kind === 'monthly_ordinal_weekday') {
    const ordinal = t(ORDINAL_LABEL_KEYS[schedule.month_day]) || schedule.month_day;
    const weekday = t(WEEKDAY_LABEL_KEYS[schedule.weekdays]) || schedule.weekdays;
    return schedule.interval > 1
      ? t('waste.summaryOrdinalWeekdayInterval', { interval: schedule.interval, ordinal, weekday })
      : t('waste.summaryOrdinalWeekday', { ordinal, weekday });
  }
  const day = schedule.month_day === -1 ? t('waste.monthDayLastDay') : t('waste.summaryMonthDayN', { day: schedule.month_day });
  return schedule.interval > 1
    ? t('waste.summaryMonthlyInterval', { interval: schedule.interval, day })
    : t('waste.summaryMonthly', { day });
}

function nextOccurrenceForSchedule(scheduleId) {
  return state.occurrences.find((occ) => occ.origins.some((o) => o.kind === 'schedule' && o.schedule_id === scheduleId)) ?? null;
}

function scheduleRowHtml(schedule) {
  // DIE KARTE NENNT DIE REGEL, NICHT DEN TERMIN (R23 D14, Critique G2 P2).
  // „Naechste Abholung: Mo, 26.10. · in 2 Tagen" stand hier UND zwei Spalten
  // daneben in „Naechste Abholungen" - dieselbe Zeile zweimal. Die Karte sagt
  // jetzt nur noch, wie oft; eine Zeile darunter nur, wenn sie etwas anderes
  // weiss als die Liste: pausiert, oder keine Abholung mehr in Sicht.
  const next = nextOccurrenceForSchedule(schedule.id);
  // Nur-lesen: die Zeile bleibt LESBAR, verliert aber jede Schreib-Affordanz -
  // auch die des Haupt-Feldes, das sonst als role="button" den Bearbeiten-Dialog
  // oeffnet. Eine Zeile, die aussieht wie ein Knopf, ist ein Versprechen.
  const ro = readOnly();
  // EINE ZEILENGRAMMATIK FUER DAS GANZE MODUL (Audit UX, 2026-09-12). Diese
  // Zeile trug ihre einzige - und zerstoerende - Aktion als nacktes
  // Muelltonnen-Icon direkt in der Zeile, waehrend die Abholzeile darueber
  // dieselbe Loeschung hinter „..." fuehrt. Zwei Zeilentypen, zwei Regeln, und
  // ausgerechnet der gefaehrlichere Weg war der kuerzere: ein Fehlgriff neben
  // dem Zeilenkoerper loeschte hier sofort eine ganze Serie.
  // Ein Menue mit einem Eintrag ist bewusst in Kauf genommen - die Alternative
  // waere, die Ausnahme zur Regel zu machen.
  // EINE ELLIPSE JE KARTE (Critique R24, G2-Entsorgung-P3-2): die Terminzeile
  // trug ein eigenes "..." mit genau einem Eintrag (Loeschen) unter dem "..."
  // ihrer Abfallart - zwei Menues in einer Karte. Loeschen steht im Dialog,
  // den die Zeile oeffnet (Fuss: Loeschen mit Wort), die Zeile selbst ist
  // nur noch der Weg dorthin.
  return `
    <div class="list-row waste-row waste-schedule-row${schedule.active ? '' : ' waste-schedule-row--paused'}" data-id="${schedule.id}">
      <div class="list-row__main${ro ? '' : ' list-row__main--interactive'}"${ro ? '' : ` data-action="edit-schedule" data-id="${schedule.id}" role="button" tabindex="0" aria-label="${esc(t('common.editNamed', { name: scheduleRowName(schedule) }))}"`}>
        <i data-lucide="repeat" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(recurrenceSummary(schedule))}</span>
          ${(schedule.active && next) ? '' : `<span class="list-row__meta">
            ${schedule.active ? '' : `<span class="waste-badge waste-badge--paused">${esc(t('waste.pausedBadge'))}</span>`}
            ${next ? '' : esc(t('waste.noUpcomingPickup'))}
          </span>`}
        </span>
      </div>
    </div>`;
}

/**
 * Pure: was unter einer Abfallart OHNE wiederkehrenden Termin steht. "Noch
 * kein Termin" stimmt nur, wenn auch keine Abholung dieser Art ansteht - eine
 * Einzelabholung oder eine eingelesene stand bis R17 zwei Zeilen daneben in
 * "Naechste Abholungen", und die Karte widersprach ihr. Dann nennt die Zeile
 * diese Abholung.
 */
function typeWithoutScheduleLine(typeId, occurrences = state.occurrences) {
  const next = occurrences.find((occ) => occ.type_id === typeId);
  return next ? `${t('waste.nextPickupLabel')}: ${pickupWhenLabel(next.date_key)}` : t('waste.noSchedulesYet');
}

/**
 * "Noch kein Termin" MIT DEM WEG DORTHIN (R20, Re-Critique 2026-10-17 a2
 * P2-5). Die Zeile sagte, was fehlt, und der Weg lag im "..." der Karte. Jetzt
 * steht "Termin hinzufuegen" daneben - derselbe `add-schedule` wie im Menue.
 * Nicht bei einer archivierten Abfallart (sie nimmt keine Termine an) und nicht
 * bei `read`; und nicht, wenn eine Einzelabholung schon die naechste nennt.
 */
function typeWithoutScheduleHtml(type, ro = readOnly()) {
  const line = typeWithoutScheduleLine(type.id);
  const offer = !ro && !type.archived && !state.occurrences.some((occ) => occ.type_id === type.id);
  if (!offer) return `<p class="waste-schedule-list__empty">${esc(line)}</p>`;
  return `<div class="waste-schedule-list__empty waste-schedule-list__empty--action"><span>${esc(line)}</span>`
    + `<button type="button" class="btn btn--secondary btn--sm" data-action="add-schedule" data-type-id="${type.id}"><i data-lucide="plus" aria-hidden="true"></i>${esc(t('waste.addSchedule'))}</button></div>`;
}

/**
 * Die Vorlagen, die der Haushalt noch nicht hat (R20). Im Onboarding standen
 * sechs Chips, nach der ersten Abfallart keiner mehr - wer Bio und Papier
 * auch braucht, musste in den Dialog. Jetzt bleiben die uebrigen als leise
 * Zeile unter den Karten.
 *
 * VORHANDEN HEISST: gleicher Name in der eigenen Sprache (ohne Gross/klein)
 * ODER Symbol und Farbe der Vorlage. Der Name allein reicht nicht, weil die
 * Vorlage ihn in der Sprache dessen anlegt, der getippt hat: legt ein
 * Mitglied auf Deutsch "Bioabfall" an, bot die Zeile einem englischen
 * Mitglied "Organic" erneut an, und ein Tipp legte die Dublette an
 * (Codex-Review PR #2053). Symbol und Farbe schreibt die Vorlage in jeder
 * Sprache gleich, und jede Vorlage traegt ein eigenes Symbol. Eine eigene
 * Art trifft das Paar nur, wenn sie Symbol UND Farbe der Vorlage waehlt - dann
 * ist sie diese Vorlage; ein Import landet auf `DEFAULT_TYPE_COLOR` (#22C55E),
 * keiner Vorlagenfarbe. Ohne Schemaaenderung, ohne alle Sprachdateien zu laden.
 */
function remainingTypePresets(types = state.types) {
  const names = new Set(types.map((type) => String(type.name ?? '').trim().toLowerCase()));
  const looks = new Set(types.map((type) => `${type.icon ?? ''}|${String(type.color ?? '').toUpperCase()}`));
  return TYPE_PRESETS.filter((preset) => !names.has(presetLabel(preset).trim().toLowerCase())
    && !looks.has(`${preset.icon}|${preset.color.toUpperCase()}`));
}

/**
 * EINE VORLAGE IST EINE ANLEGEN-HANDLUNG, KEIN FILTER (R24, G2-Entsorgung-P3-1).
 * Sie stand als `.filter-chip` da - Filter-Optik fuer einen Knopf, der sofort
 * eine Abfallart anlegt, und darum 48px am Desktop, wo jeder Filterchip `--sm`
 * traegt. Jetzt der kleine Sekundaerknopf mit der Glyphe der Art; ihre Farbe
 * kommt als Variable (`--waste-type-color`, waste.css), nicht als Farbe am
 * Zeichen.
 */
function presetButtonHtml(preset) {
  return `
      <button type="button" class="btn btn--secondary btn--sm waste-onboarding__preset" data-action="create-preset-type" data-preset="${preset.key}" style="--waste-type-color:${esc(preset.color)}">
        <i data-lucide="${esc(preset.icon)}" class="icon-md" aria-hidden="true"></i>
        <span>${esc(presetLabel(preset))}</span>
      </button>`;
}

function remainingPresetsHtml() {
  if (readOnly()) return '';
  const presets = remainingTypePresets();
  if (!presets.length) return '';
  return `<div class="waste-type-presets-more" role="group" aria-label="${esc(t('waste.typePresetLabel'))}">`
    + presets.map(presetButtonHtml).join('')
    + '</div>';
}

/**
 * LEERE ARTEN IN EINER ZEILE (Critique R24, G2-Entsorgung-P3-2). Vier Karten
 * wiederholten "Noch kein Termin fuer diese Abfallart." und "+ Termin
 * hinzufuegen" - die Seite bestand zur Haelfte aus derselben Aussage. Arten
 * ohne Termin und ohne anstehende Abholung (und nicht archiviert) stehen jetzt
 * gesammelt in EINER Karte: "Ohne Termin", ihre Namen (jeder oeffnet seine
 * Art) und EINE Handlung, die nach der Art fragt.
 */
function isUnscheduledType(type, schedules = state.schedules, occurrences = state.occurrences) {
  return !type.archived
    && !schedules.some((schedule) => schedule.type_id === type.id)
    && !occurrences.some((occ) => occ.type_id === type.id);
}

function unscheduledTypesHtml(types, ro = readOnly()) {
  if (!types.length) return '';
  const names = types.map((type) => {
    const icon = `<i data-lucide="${esc(type.icon || 'trash-2')}" style="color:${esc(type.color)}" aria-hidden="true"></i>`;
    return ro
      ? `<span class="waste-unscheduled__name">${icon}<span>${esc(type.name)}</span></span>`
      : `<button type="button" class="waste-unscheduled__name" data-action="edit-type" data-id="${type.id}" aria-label="${esc(t('common.editNamed', { name: type.name }))}">${icon}<span>${esc(type.name)}</span></button>`;
  }).join('');
  return `
    <div class="waste-type-card waste-type-card--unscheduled">
      <div class="waste-unscheduled">
        <div class="waste-unscheduled__text">
          <span class="waste-unscheduled__label">${esc(t('waste.typesWithoutSchedule'))}</span>
          <span class="waste-unscheduled__names">${names}</span>
        </div>
        ${ro ? '' : `<button type="button" class="btn btn--secondary btn--sm" data-action="add-schedule"><i data-lucide="plus" aria-hidden="true"></i>${esc(t('waste.addSchedule'))}</button>`}
      </div>
    </div>`;
}

function typeCardHtml(type, index, total) {
  const schedules = schedulesForType(type.id);
  const ro = readOnly();
  const menuId = `waste-type-menu-${type.id}`;
  // Drei nackte Icon-Knoepfe (hoch, runter, plus) standen hier nebeneinander -
  // dieselbe Zeilenbreite, die sich die Abholzeile mit EINEM „..." nimmt. Bei
  // langen Abfallart-Namen („Gelber Sack / Leichtverpackungen") drueckten sie
  // den Namen auf zwei Zeilen, und keiner der drei trug eine Beschriftung.
  //
  // GRENZEN WERDEN WEGGELASSEN, NICHT AUSGEGRAUT: vorher trugen die
  // Pfeil-Knoepfe an der ersten/letzten Position `disabled` - ein toter Knopf,
  // der Platz und Aufmerksamkeit kostet und nichts erklaert. Das Menue der
  // Abholzeile fuehrt es schon anders vor: was nicht geht, steht nicht drin.
  // Bei genau EINER Abfallart verschwinden damit beide Pfeile, und das ist die
  // ehrliche Auskunft - Sortieren gibt es dann nicht.
  const menuItems = [
    ...(index > 0 ? [`<button type="button" role="menuitem" class="popover-menu__item" data-action="move-type-up" data-id="${type.id}"><i data-lucide="chevron-up" aria-hidden="true"></i>${esc(t('waste.moveTypeUp'))}</button>`] : []),
    ...(index < total - 1 ? [`<button type="button" role="menuitem" class="popover-menu__item" data-action="move-type-down" data-id="${type.id}"><i data-lucide="chevron-down" aria-hidden="true"></i>${esc(t('waste.moveTypeDown'))}</button>`] : []),
    `<button type="button" role="menuitem" class="popover-menu__item" data-action="add-schedule" data-type-id="${type.id}"><i data-lucide="plus" aria-hidden="true"></i>${esc(t('waste.addSchedule'))}</button>`,
  ].join('\n            ');
  return `
    <div class="waste-type-card${type.archived ? ' waste-type-card--archived' : ''}" data-type-id="${type.id}">
      <div class="list-row waste-row waste-type-row">
        <div class="list-row__main${ro ? '' : ' list-row__main--interactive'}"${ro ? '' : ` data-action="edit-type" data-id="${type.id}" role="button" tabindex="0"`}>
          <i data-lucide="${esc(type.icon || 'trash-2')}" style="color:${esc(type.color)}" aria-hidden="true"></i>
          <span class="list-row__body">
            <span class="list-row__name">${esc(type.name)}${type.archived ? ` <span class="waste-badge">${esc(t('waste.archived'))}</span>` : ''}</span>
          </span>
        </div>
        ${ro ? '' : `
          <div class="row-actions">
            <button type="button" class="row-action" popovertarget="${menuId}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('common.moreActionsNamed', { name: type.name }))}">
              <i data-lucide="more-horizontal" aria-hidden="true"></i>
            </button>
            <div class="popover-menu" id="${menuId}" popover role="menu">
            ${menuItems}
            </div>
          </div>`}
      </div>
      <div class="waste-schedule-list">
        ${schedules.length ? schedules.map(scheduleRowHtml).join('') : typeWithoutScheduleHtml(type, ro)}
      </div>
    </div>`;
}

// -------------------------------------------------------------------------
// EIN Leerzustand statt drei (Re-Critique 2026-09-28, P4)
// -------------------------------------------------------------------------

/**
 * Pure: steht die Seite im Onboarding? Nur ohne JEDE Abfallart - eine nur
 * archivierte muss wiederherstellbar bleiben, und das geht nur in der vollen
 * Ansicht mit ihrer Karte. Beim Laden steht das Skelett, bei einem Ladefehler
 * der Fehler; beides ist kein "noch nichts".
 */
function isOnboarding(s) {
  return !s.loading && !s.error && s.types.length === 0;
}

/**
 * Pure: was die Seite im jeweiligen Zustand zeigt. Ohne Abfallart standen
 * drei "Noch nichts"-Bloecke untereinander (Abholungen, Abfallarten,
 * Quellen), der erste Weg lag mobil bei y683 unter dem Erinnerungs-Toast.
 * Abholungen und Quellen haben ohne Abfallart nichts zu sagen - sie kommen
 * mit den Daten. Einen Kopfknopf "Abfallart hinzufuegen" gibt es seit R23
 * nicht mehr (D14): nach der ersten steht sie im Menue, davor im FAB.
 */
function sectionVisibility(s) {
  const onboarding = isOnboarding(s);
  return { upcoming: !onboarding, sources: !onboarding };
}

/**
 * Pure: was der FAB anlegt. Ohne aktive Abfallart laesst sich kein Termin
 * eintragen - der FAB hiess trotzdem "Abholung" und leitete per Toast in den
 * Abfallart-Dialog um (der Toast legte sich dabei ueber dessen Namensfeld).
 * Jetzt nennt er, was er tut.
 *
 * MIT ABFALLART LEGT ER DEN WIEDERKEHRENDEN TERMIN AN (Entscheidung R17, E2).
 * Bis R17 die Einzelabholung - die seltenste Handlung des Moduls als
 * Primaerknopf, waehrend der Termin, um den es geht ("jeden zweiten Freitag"),
 * nur im Drei-Punkte-Menue einer Abfallart stand. Die Einzelabholung steht
 * jetzt im Werkzeugmenue des Kopfs (renderPage()).
 */
function fabIntent(s) {
  const hasActiveType = s.types.some((type) => !type.archived);
  return hasActiveType
    ? { creates: 'schedule', labelKey: 'waste.addSchedule', dockLabelKey: 'newLabel.wasteSchedule' }
    : { creates: 'type', labelKey: 'waste.addType', dockLabelKey: 'newLabel.wasteType' };
}

/**
 * Pure: welche Abfallart der Termin-Dialog vorschlaegt, wenn er vom
 * Primaerknopf kommt: die erste aktive OHNE Termin (dort fehlt er), sonst die
 * erste aktive.
 */
function defaultScheduleType(types = state.types, schedules = state.schedules) {
  const active = types.filter((type) => !type.archived);
  return active.find((type) => !schedules.some((schedule) => schedule.type_id === type.id)) ?? active[0] ?? null;
}

function presetLabel(preset) {
  return t(`waste.preset${preset.key.charAt(0).toUpperCase()}${preset.key.slice(1)}`);
}

/**
 * Pure: der EINE Onboarding-Block. Die Vorlagen stehen als Chips da und legen
 * mit einem Tipp an (Name, Symbol und Farbe der Vorlage) - vorher lagen sie
 * zwei Schritte tief im Dialog hinter "Mit einer Vorlage starten". Darunter
 * der zweite Weg, den viele Kommunen anbieten: der ICS-Import, der Arten
 * gleich mitbringt. Nur-lesen bekommt denselben Leerzustand ohne Schreibweg.
 */
function onboardingHtml({ readOnly: ro, emptyHtml = null }) {
  // `emptyHtml` nur fuer den Test (die DOM-Attrappe dort baut keinen
  // Leerzustand); die Seite laesst ihn weg.
  // Der Satz beschreibt, was darunter steht (R23 S10, Critique G2 P3: er
  // nannte "Restmuell, Bio, Papier" ueber Chips, die anders heissen, und
  // keinen Import). Nur-lesen hat weder Vorlagen noch Import - dort der Titel allein.
  const empty = emptyHtml ?? emptyStateHTML({
    icon: 'trash-2',
    title: t('waste.emptyTypesTitle'),
    description: ro ? '' : t('waste.emptyTypesDescription'),
  });
  if (ro) return `<div class="waste-onboarding">${empty}</div>`;
  const chips = TYPE_PRESETS.map(presetButtonHtml).join('');
  return `
    <div class="waste-onboarding">
      ${empty}
      <div class="waste-onboarding__presets" role="group" aria-label="${esc(t('waste.typePresetLabel'))}">${chips}
      </div>
      <button type="button" class="btn btn--ghost waste-onboarding__import" data-action="open-import">
        <i data-lucide="upload" class="icon-md" aria-hidden="true"></i>
        <span>${esc(t('waste.importFileAction'))}</span>
      </button>
    </div>`;
}

/** Legt eine Abfallart aus einer Vorlage an - derselbe POST wie der Dialog. */
async function createPresetType(key, button) {
  const preset = TYPE_PRESETS.find((p) => p.key === key);
  if (!preset) return;
  if (button) button.disabled = true;
  try {
    await api.post('/waste/types', { name: presetLabel(preset), icon: preset.icon, color: preset.color });
    await reloadAfterSave(() => reloadAndRender());
    // "Restmuell angelegt." statt dreimal "Abfallart gespeichert" mit
    // Zaehler (Critique R24, G2-Quer-P2-2): jede Vorlage ist ein anderer Satz.
    window.yuvomi?.showToast(t('common.createdNamed', { name: presetLabel(preset) }), 'success');
  } catch (err) {
    if (button) button.disabled = false;
    reportError(err);
  }
}

/**
 * Pure: die Zustandsklassen der Seite. `--no-active-type` gilt, sobald der
 * Primaerknopf eine Abfallart anlegt statt eines Termins (fabIntent) - also
 * auch, wenn es Abfallarten gibt und ALLE archiviert sind. Das ist kein
 * Onboarding (die Karten muessen wiederherstellbar bleiben), aber eine
 * Einzelabholung hat auch dann nichts zu waehlen: der Menueeintrag "Abholung
 * hinzufuegen" oeffnete in dem Zustand den Abfallart-Dialog (#1775). waste.css
 * nimmt ihn unter dieser Klasse heraus.
 */
function pageModeClasses(s) {
  return {
    // WAEHREND DES LADENS STEHT DIE SEITENSPALTE NICHT DA (R20, Re-Critique
    // 2026-10-17 a2 P2-3: CLS mobil 0,24-0,42). Ihr Skelett stand unter dem
    // der Abholungen und sprang nach dem Laden nach oben (Onboarding: die
    // Abholungen fallen weg) oder schrumpfte (mit Daten). Sie erscheint jetzt
    // mit ihrem Inhalt - Erscheinen verschiebt nichts (waste.css).
    'waste-page--loading': Boolean(s.loading),
    'waste-page--onboarding': isOnboarding(s),
    'waste-page--no-active-type': fabIntent(s).creates === 'type',
  };
}

/** Zieht Abschnitte, Kopfknopf und FAB auf den Zustand nach. */
function applyPageMode() {
  const page = _container.querySelector('.waste-page');
  for (const [name, on] of Object.entries(pageModeClasses(state))) page?.classList.toggle(name, on);
  const intent = fabIntent(state);
  const fab = findPageFab('waste-fab-new-pickup');
  if (fab) {
    setPageFabAction(fab, {
      label: t(intent.labelKey),
      dockLabel: t(intent.dockLabelKey),
      onClick: () => {
        if (readOnly()) return;
        if (fabIntent(state).creates === 'type') openTypeModal();
        else openScheduleModal(null);
      },
    });
  }
}

function renderTypes() {
  const host = _container.querySelector('#waste-types-list');
  if (!host) return;
  redrawList(host, () => drawTypes(host), { selector: '.waste-type-card[data-type-id]', keyAttr: 'data-type-id' });
}

function drawTypes(host) {
  if (state.loading) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3, lines: 2 }));
    return;
  }
  if (!state.types.length) {
    // Der EINE Onboarding-Block (onboardingHtml) - auch der Leerzustand
    // bietet einem Nur-lesen-Nutzer keinen Anlegeweg an.
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', onboardingHtml({ readOnly: readOnly() }));
    if (window.lucide) window.lucide.createIcons({ el: host });
    return;
  }
  host.replaceChildren();
  const unscheduled = state.types.filter((type) => isUnscheduledType(type));
  // Position und Grenzen des Hoch/Runter-Menues zaehlen nur die Karten, die
  // stehen (R24 S13) - die leeren Arten haben in der Zeile "Ohne Termin" keine
  // Lage, und ein Tausch mit ihnen waere unsichtbar (moveType).
  const listed = state.types.filter((type) => !unscheduled.includes(type));
  host.insertAdjacentHTML('beforeend', listed.map((type, index) => typeCardHtml(type, index, listed.length)).join('')
    + unscheduledTypesHtml(unscheduled)
    + remainingPresetsHtml());
  if (window.lucide) window.lucide.createIcons({ el: host });
}

// -------------------------------------------------------------------------
// Import sources (#1063 Phase 3)
// -------------------------------------------------------------------------

/**
 * Pure: which health badge (if any) a source shows. needs_mapping takes
 * priority over error, which takes priority over needs-refresh (invariant
 * #6) - a URL source paused for a reviewed refresh is its own distinct
 * state, not merely "erroring" (the fetch itself succeeded).
 */
function sourceHealthBadgeInfo(source) {
  if (source.needs_mapping) return { code: 'needs-mapping', labelKey: 'waste.sourceNeedsMappingBadge' };
  if (source.last_error) return { code: 'error', labelKey: 'waste.sourceErrorBadge' };
  if (source.needs_refresh) return { code: 'needs-refresh', labelKey: 'waste.sourceNeedsRefreshBadge' };
  return null;
}

function sourceRowHtml(source) {
  const badge = sourceHealthBadgeInfo(source);
  const isUrl = source.kind === 'url';
  const coverage = source.coverage_start
    ? esc(dateRangeText(source.coverage_start, source.coverage_end))
    : esc(t('waste.sourceNoCoverage'));
  // A URL source's own row action is a manual refresh (fetch now) or, once
  // needs_mapping is set, a review action that opens the same mapping wizard
  // a file re-import uses - never the plain "re-import" action, which
  // implies picking a new file and has nothing to do with a subscription.
  const rowAction = isUrl
    ? (source.needs_mapping
      ? { action: 'review-source-mapping', icon: 'list-checks', labelKey: 'waste.reviewMappingAction' }
      : { action: 'refresh-source', icon: 'refresh-cw', labelKey: 'waste.refreshNowAction' })
    : { action: 'reimport-source', icon: 'refresh-cw', labelKey: 'waste.reimportAction' };
  // Diese Zeile hatte das staerkste Argument fuer das Menue: ihre eine Aktion
  // WECHSELT die Bedeutung (manuell abrufen / Zuordnung pruefen / neu
  // einlesen), und zwei der drei Faelle trugen dasselbe `refresh-cw`. Das
  // Icon allein konnte also gar nicht sagen, was passieren wird - die
  // Unterscheidung stand ausschliesslich im aria-label und war damit fuer
  // sehende Nutzer unsichtbar. Im Menue traegt jeder Fall seinen Satz.
  const menuId = `waste-source-menu-${source.id}`;
  return `
    <div class="list-row waste-row waste-source-row" data-source-id="${source.id}">
      <div class="list-row__main list-row__main--interactive" data-action="open-source" data-id="${source.id}" role="button" tabindex="0">
        <i data-lucide="${isUrl ? 'link' : 'file-text'}" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(source.name)} ${badge ? `<span class="waste-badge waste-badge--${badge.code}">${esc(t(badge.labelKey))}</span>` : ''}</span>
          <span class="list-row__meta">${coverage}</span>
        </span>
      </div>
      ${readOnly() ? '' : `
        <div class="row-actions">
          <button type="button" class="row-action" popovertarget="${menuId}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('common.moreActionsNamed', { name: source.name }))}">
            <i data-lucide="more-horizontal" aria-hidden="true"></i>
          </button>
          <div class="popover-menu" id="${menuId}" popover role="menu">
            <button type="button" role="menuitem" class="popover-menu__item" data-action="${rowAction.action}" data-id="${source.id}"><i data-lucide="${rowAction.icon}" aria-hidden="true"></i>${esc(t(rowAction.labelKey))}</button>
          </div>
        </div>`}
    </div>`;
}

function renderSources() {
  const host = _container.querySelector('#waste-sources-list');
  if (!host) return;
  redrawList(host, () => drawSources(host), { selector: '.waste-source-row[data-source-id]', keyAttr: 'data-source-id' });
}

function drawSources(host) {
  if (state.loading) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 2, lines: 2 }));
    return;
  }
  if (!state.sources.length) {
    host.replaceChildren();
    // EIN VOLLER LEERZUSTAND JE SEITE (R18, 2026-10-07): die Seite fuehrt ihn
    // oben ("Noch nichts geplant" bzw. das Onboarding der Abfallarten). Die
    // Importquellen sind ein Nebenabschnitt mit eigenem Kopf und sagen es in
    // einem Satz - der Knopf darunter bleibt der Weg, den der Satz nennt.
    host.insertAdjacentHTML('beforeend', emptyStateHTML({
      compact: true,
      description: t('waste.emptySourcesDescription'),
      // Der Leerzustand NANNTE den Weg schon, ohne ihn anzubieten: seine
      // Beschreibung lautet woertlich „Importiere eine ICS-Datei deiner
      // Kommune..." - und liess den Leser dann allein damit, diese Datei
      // hinter dem unbeschrifteten „..." im Seitenkopf zu suchen. Der CTA
      // nimmt deshalb genau die Aktion, die der Satz darueber beschreibt
      // (`open-import`), nicht die URL-Quelle: ein Leerzustand, dessen Knopf
      // etwas anderes tut als sein eigener Text ankuendigt, ist schlimmer als
      // gar keiner.
      // Nur-lesen: derselbe Riegel wie beim Abfallart-Leerzustand darueber.
      // Sekundaer: der Primaerknopf der Seite ist der FAB ("Termin").
      action: readOnly() ? null : { label: t('waste.importFileAction'), icon: 'upload', tone: 'secondary', attrs: { id: 'waste-empty-add-source' } },
    }));
    host.querySelector('#waste-empty-add-source')?.addEventListener('click', () => openImportWizard());
    if (window.lucide) window.lucide.createIcons({ el: host });
    return;
  }
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', state.sources.map(sourceRowHtml).join(''));
  if (window.lucide) window.lucide.createIcons({ el: host });
}

async function reloadAndRender() {
  const { signal } = _pageController ?? {};
  await loadData();
  if (signal?.aborted) return;
  renderUpcoming();
  renderTypes();
  renderSources();
  applyPageMode();
}

/**
 * EIN WEG FUER DIE FEHLER-TOASTS DER SEITE (#1909).
 *
 * Der Toast sagt den Satz der App (`errorSentence`): den des Falls, den der
 * Server mit `reason` nennt, sonst den allgemeinen. Der Text des Servers kommt
 * hier nie an. Sagt der Grund, dass es das Ziel der Handlung nicht mehr gibt
 * (jemand anderes im Haushalt hat die Abfallart, den Termin, die Abholung oder
 * die Quelle geloescht oder den Termin geaendert), ist der Stand der Seite
 * veraltet - sie holt ihn dann selbst neu, statt dazu zu raten.
 *
 * Die Assistenten (Import, Quelle mit Adresse) zeigen ihren Fehler im Dialog
 * statt im Toast und fragen `errorSentence` dafuer selbst; "gibt es nicht mehr"
 * geben auch sie hierher. Wo nur die GEWAEHLTE Abfallart fehlt, bleibt der
 * Dialog offen: `keepDialogForMissingType` und seine beiden Geschwister.
 *
 * @param {unknown} err
 * @param {string} [fallbackKey] - der allgemeine Satz der Stelle
 */
function reportError(err, fallbackKey) {
  window.yuvomi?.showToast(errorSentence(err, fallbackKey), 'danger');
  if (isGone(err)) reloadAfterGone();
}

/**
 * Nachladen nach "gibt es nicht mehr". Ein offener Dialog geht zu: er
 * bearbeitet etwas, das es nicht mehr gibt, oder bietet eine Abfallart zur
 * Wahl an, die fehlt. Der Weg ist derselbe `reloadAndRender()` wie nach jedem
 * Speichern; er meldet seine eigenen Fehler nirgends, ein scheiterndes
 * Nachladen kann also kein weiteres ausloesen.
 */
async function reloadAfterGone() {
  await closeModal({ force: true });
  await reloadAndRender();
  refocusAfterRender();
}

/** Der Grund "die im Formular gewaehlte Abfallart gibt es nicht mehr". */
const SELECTED_TYPE_GONE = 'waste_selected_type_not_found';

function isSelectedTypeGone(err) {
  return isGone(err) && err.data.reason === SELECTED_TYPE_GONE;
}

/** Die Optionen einer Abfallart-Auswahl: die aktiven, dazu `keepArchivedId`, wenn die Auswahl eine archivierte schon traegt. */
function typeOptionsHtml(selectedId = null, keepArchivedId = null) {
  return state.types.filter((t2) => !t2.archived || t2.id === keepArchivedId)
    .map((t2) => `<option value="${t2.id}"${selectedId === t2.id ? ' selected' : ''}>${esc(t2.name)}</option>`).join('');
}

/**
 * Baut eine Abfallart-Auswahl aus dem frischen Bestand neu. Gibt es die
 * gewaehlte Art nicht mehr, steht danach KEINE andere an ihrer Stelle: eine
 * leere Aufforderung ("Abfallart waehlen"), an der Speichern haelt - sonst
 * laege der Termin nach einem zweiten Druck auf Speichern still bei der Art,
 * die zufaellig als erste in der Liste steht.
 */
function refillTypeSelect(select, keepArchivedId = null) {
  const chosen = Number(select.value);
  const stillThere = state.types.some((t2) => t2.id === chosen && (!t2.archived || t2.id === keepArchivedId));
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend',
    (stillThere ? '' : `<option value="" disabled selected>${esc(t('waste.typeSelectPlaceholder'))}</option>`)
    + typeOptionsHtml(stillThere ? chosen : null, keepArchivedId));
  if (stillThere) select.removeAttribute('aria-invalid');
  else select.setAttribute('aria-invalid', 'true');
}

/**
 * SPEICHERN SCHEITERT NUR AN DER GEWAEHLTEN ABFALLART (#1909): jemand anderes
 * im Haushalt hat sie geloescht, waehrend der Dialog offen war. Der Dialog
 * bleibt, die Eingaben bleiben; die Seite holt den frischen Stand, die Auswahl
 * zeigt ihn, und der Fokus steht auf ihr. Der Satz sagt, was los ist.
 *
 * Ohne Auswahl im Dialog (ein Termin, der aus der Zeile SEINER Abfallart
 * angelegt wird) ist das kein Fall fuer hier: dann fehlt, worum der Dialog
 * geht, und `reportError` schliesst ihn wie bisher.
 *
 * @returns {Promise<boolean>} true: behandelt, der Aufrufer meldet nichts mehr
 */
async function keepDialogForMissingType(err, select, keepArchivedId = null) {
  if (!select || !isSelectedTypeGone(err)) return false;
  window.yuvomi?.showToast(errorSentence(err), 'danger');
  await reloadAndRender();
  refillTypeSelect(select, keepArchivedId);
  select.focus();
  return true;
}

/**
 * LOESCHEN, auch wenn es schon erledigt ist (#1909): wer etwas loescht, das
 * ein anderes Haushaltsmitglied schon geloescht hat, bekommt "gibt es nicht
 * mehr" - und hat damit, was er wollte. Der Aufrufer laeuft dann seinen
 * Erfolgsweg (Dialog zu, nachladen, Erfolgs-Toast). Nur der Grund des Dings
 * selbst zaehlt (`isAlreadyDeleted`); alles andere bleibt ein Fehler.
 */
async function deleteOrAlreadyGone(path, goneReason) {
  try {
    await api.delete(path);
  } catch (err) {
    if (!isAlreadyDeleted(err, goneReason)) throw err;
  }
}

/**
 * Reorders by swapping sort_order with the adjacent type - no drag library
 * needed, and this is never the only path to reordering (up/down buttons are
 * themselves the keyboard-operable path, matching category-manager.js's
 * "drag is never the only way" convention).
 */
async function moveType(id, direction) {
  // NUR UNTER DEN KARTEN, DIE STEHEN (R24 S13). Seit die leeren Arten in EINER
  // Zeile "Ohne Termin" stehen (G2-Entsorgung-P3-2), tauschte eine Karte vor
  // einer leeren Art mit ihr - unsichtbar, die Liste stand danach wie vorher.
  const listed = state.types.filter((type) => !isUnscheduledType(type));
  const index = listed.findIndex((t2) => t2.id === id);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= listed.length) return;
  const a = listed[index];
  const b = listed[swapWith];
  try {
    await api.put(`/waste/types/${a.id}`, { sort_order: b.sort_order });
    await api.put(`/waste/types/${b.id}`, { sort_order: a.sort_order });
    await reloadAfterSave(() => reloadAndRender());
  } catch (err) {
    reportError(err);
  }
}

// -------------------------------------------------------------------------
// Type modal
// -------------------------------------------------------------------------

function iconButtonHtml(icon) {
  return `<button type="button" class="btn btn--secondary waste-icon-picker" data-action="pick-type-icon">`
    + (icon ? `<i data-lucide="${esc(icon)}" aria-hidden="true"></i>` : '<i data-lucide="image-off" aria-hidden="true"></i>')
    + `<span>${esc(t('schedule.chooseIcon'))}</span></button>`
    + `<input type="hidden" name="icon" value="${esc(icon ?? '')}">`;
}

/** Swaps only the leading <i data-lucide> node, same pattern as schedule.js's setShiftIconButtonIcon(). */
function setTypeIconButtonIcon(button, iconName) {
  button.querySelectorAll('i[data-lucide], svg.lucide').forEach((el) => el.remove());
  button.insertAdjacentHTML('afterbegin', `<i data-lucide="${esc(iconName || 'image-off')}" aria-hidden="true"></i>`);
  window.lucide?.createIcons({ el: button });
}

/**
 * Was ohne Suchbegriff im Symbolraster steht, wenn es um eine ABFALLART geht.
 *
 * Die allgemeine Reihe des Dialogs (components/icon-picker.js, SUGGESTIONS)
 * stammt vom ersten Aufrufer, den Schnellzugriffen, und zeigt Symbole fuer
 * selbstgehostete Dienste: Filmklappe, Fernseher, Kopfhoerer, Server. Wer hier
 * ein Symbol fuer „Biotonne" sucht, bekam davon keine einzige brauchbare
 * Kachel zu sehen und musste erst wissen, dass es ein Suchfeld gibt - und
 * darin auf ENGLISCH raten.
 *
 * Die Reihe folgt deshalb den ueblichen Tonnen in dieser Reihenfolge: Rest-,
 * Bio-, Papier-, Verpackungs- und Glasabfall, dann Elektro-, Sonder-, Sperr-
 * und Gartenabfall. Gesucht wird weiterhin im ganzen Lucide-Vorrat; das hier
 * ist nur die Starthilfe.
 *
 * Jeder Name ist gegen den gemessenen Vorrat geprueft - ein unbekannter faellt
 * im Dialog stillschweigend weg (searchIcons filtert gegen `iconNames()`) und
 * hinterliesse eine Luecke, die niemand als Tippfehler erkennt.
 *
 * ACHTUNG BEI ZIFFERN AM ENDE: die Schreibweise heisst hier `trash2`, NICHT
 * `trash-2`. `iconNames()` bildet die Namen aus Lucides PascalCase-Schluesseln
 * (utils/lucide-icons.js, kebab()), und dessen Trennregel setzt nur zwischen
 * Buchstaben einen Bindestrich - aus `Trash2` wird `trash2`. Mit `trash-2`
 * blieben genau zwei der vierzig Kacheln unsichtbar (gemessen: 38 statt 40).
 * Fuer `data-lucide=` sind beide Schreibweisen gleichwertig, deshalb faellt
 * der Unterschied nur hier auf.
 */
const TYPE_ICON_SUGGESTIONS = [
  'trash2', 'trash', 'container', 'recycle', 'box',
  'leaf', 'sprout', 'apple', 'carrot', 'egg',
  'newspaper', 'archive', 'package', 'boxes', 'shopping-bag',
  'wine', 'glass-water', 'milk', 'beer', 'droplet',
  'battery', 'cpu', 'monitor', 'smartphone', 'lightbulb',
  'biohazard', 'flame', 'pill', 'paint-bucket', 'cigarette',
  'sofa', 'construction', 'hammer', 'truck', 'shirt',
  'tree-deciduous', 'trees', 'flower2', 'wheat', 'bone',
];

async function pickTypeIcon(button) {
  const form = button.closest('form') || button.closest('.modal-panel');
  const hidden = form?.querySelector('input[name="icon"]');
  if (!hidden) return;
  const { openIconPicker } = await import('/components/icon-picker.js');
  const chosen = await openIconPicker(hidden.value || null, { suggestions: TYPE_ICON_SUGGESTIONS, owner: button });
  if (chosen === undefined) return;
  hidden.value = chosen ?? '';
  setTypeIconButtonIcon(button, chosen);
}

function openTypeModal(type = null) {
  const isEdit = !!type;
  const presetOptions = TYPE_PRESETS.map((p) => `<option value="${p.key}">${esc(t(`waste.preset${p.key.charAt(0).toUpperCase()}${p.key.slice(1)}`))}</option>`).join('');
  // Die Vorgabe fuer eine NEUE Abfallart ist jetzt ein Mitglied der Palette
  // (vorher `#22C55E`, das in keinem Raster auftauchte und den Dialog damit
  // ohne aktiven Swatch geoeffnet haette).
  const selColor = isEdit ? (type.color || WASTE_TYPE_COLORS[0]) : WASTE_TYPE_COLORS[2];

  const content = `
    ${isEdit ? '' : `
    <div class="form-group">
      <label class="form-label" for="wtm-preset">${t('waste.typePresetLabel')}</label>
      <select class="form-input" id="wtm-preset">
        <option value="">${t('waste.presetNone')}</option>
        ${presetOptions}
      </select>
    </div>`}
    <div class="form-group">
      <label class="form-label" for="wtm-name">${t('waste.typeNameLabel')}${REQUIRED_MARK}</label>
      <input type="text" class="form-input" id="wtm-name" maxlength="100" value="${esc(isEdit ? type.name : '')}" required>
    </div>
    <div class="form-group">
      <label class="form-label">${t('waste.typeIconLabel')}</label>
      <div id="wtm-icon-wrap">${iconButtonHtml(isEdit ? type.icon : 'trash-2')}</div>
    </div>
    <div class="form-group">
      <span class="form-label" id="wtm-color-label">${t('waste.typeColorLabel')}</span>
      ${colorPickerHtml({ id: 'wtm-color', value: selColor, labelledBy: 'wtm-color-label' })}
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `
      <div class="modal-panel__footer-group modal-panel__footer-group--tight">
          <button type="button" class="btn btn--danger-outline" id="wtm-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}</button>
          <button type="button" class="btn btn--secondary btn--icon" id="wtm-archive" aria-label="${esc(type.archived ? t('waste.restoreAction') : t('waste.archiveAction'))}"><i data-lucide="${type.archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i></button>
      </div>` : ''}
      <div class="modal-panel__footer-group">
        <button type="button" class="btn btn--secondary" id="wtm-cancel">${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="wtm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    staged: !isEdit, // Buehne zuerst, Felder nach dem ersten Bild (modal.js, R21 a6)
    title: isEdit ? t('waste.editType') : t('waste.newType'),
    initialFocus: dialogInitialFocus(isEdit),
    content,
    // 520 statt 400: Loeschen, Archivieren, Abbrechen und Speichern brauchen
    // 395px, das 400er-Blatt hat innen 366 - der Fuss brach in zwei Zeilen.
    size: 'md',
    onSave(panel) {
      panel.querySelector('#wtm-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('[data-action="pick-type-icon"]').addEventListener('click', (e) => pickTypeIcon(e.currentTarget));

      // Die Farbe ist der geteilte Waehler (utils/color-picker.js, Critique
      // R24 E6) - Familientoene, "Eigene" dahinter, eine Bestandsfarbe
      // ausserhalb der Reihe bleibt als eigener Swatch gewaehlt.
      wireColorPicker(panel);

      panel.querySelector('#wtm-preset')?.addEventListener('change', (e) => {
        const preset = TYPE_PRESETS.find((p) => p.key === e.target.value);
        if (!preset) return;
        panel.querySelector('#wtm-name').value = t(`waste.preset${preset.key.charAt(0).toUpperCase()}${preset.key.slice(1)}`);
        // Die Preset-Farbe steht garantiert im Raster (die ersten sechs
        // Eintraege von WASTE_TYPE_COLORS SIND die Preset-Farben), also
        // markiert die Vorlage jetzt einen Swatch, statt ein Eingabefeld zu
        // fuellen. Das Raster bleibt danach frei bedienbar - eine Vorlage ist
        // ein Startpunkt, keine Festlegung.
        setColorPickerValue(panel.querySelector('[data-color-picker]'), preset.color);
        const hidden = panel.querySelector('input[name="icon"]');
        hidden.value = preset.icon;
        setTypeIconButtonIcon(panel.querySelector('[data-action="pick-type-icon"]'), preset.icon);
      });

      panel.querySelector('#wtm-archive')?.addEventListener('click', async () => {
        const modalContext = captureModalContext();
        try {
          await api.put(`/waste/types/${type.id}`, { archived: !type.archived });
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(t(type.archived ? 'waste.typeRestoredNamed' : 'waste.typeArchivedNamed', { name: type.name }), 'success');
        } catch (err) {
          reportError(err);
        }
      });

      panel.querySelector('#wtm-delete')?.addEventListener('click', async () => {
        const modalContext = captureModalContext();
        const ok = await confirmOverModal(t('waste.typeDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.typeDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await deleteOrAlreadyGone(`/waste/types/${type.id}`, 'waste_type_not_found');
          closeModal({ force: true, context: modalContext });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('common.deletedNamed', { name: type.name }), 'success');
        } catch (err) {
          reportError(err);
        }
      });

      panel.querySelector('#wtm-save').addEventListener('click', async () => {
        const name = panel.querySelector('#wtm-name').value.trim();
        if (!name) { panel.querySelector('#wtm-name').focus(); return; }
        const body = {
          name,
          icon: panel.querySelector('input[name="icon"]').value || 'trash-2',
          // Der Rueckfall greift nur bei leerem Wertfeld - dann gilt der
          // Stand, mit dem der Dialog geoeffnet wurde, nicht etwa eine leere Farbe.
          color: panel.querySelector('#wtm-color')?.value || selColor,
        };
        const modalContext = captureModalContext();
        try {
          if (isEdit) await api.put(`/waste/types/${type.id}`, body);
          else await api.post('/waste/types', body);
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(t(isEdit ? 'common.savedNamed' : 'common.createdNamed', { name: body.name }), 'success');
        } catch (err) {
          reportError(err);
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// Schedule modal
// -------------------------------------------------------------------------

/* Wochentage als Chips (R17, E6): bis dahin sieben rohe 13x13-Checkboxen in
 * 31px hohen Labels. Jetzt der Chip des Kanons (`.filter-chip`, `aria-pressed`)
 * in einer benannten Gruppe; der gewaehlte Stand steht zusaetzlich in einem
 * versteckten Feld, damit der Verwerfen-Schutz des Dialogs die Aenderung sieht.
 * `weekdayPickerValue()` liest die Chips, `wireWeekdayPicker()` schaltet sie. */
/**
 * "ALLE N WOCHEN" ALS STEPPER (R20, Re-Critique 2026-10-17 a2 P3). Ein nacktes
 * Zahlenfeld verlangte fuer "alle 2 Wochen" die Tastatur; die Werte sind fast
 * immer 1, 2 oder 4. Das Feld bleibt das native `<input type="number">` (sein
 * `<label for>`, Tastatur und Pfeiltasten wie gehabt), links und rechts ein
 * Knopf, der um eins schreibt und `input` meldet - der Dialog liest weiter
 * `#wsm-interval`. An den Grenzen (1, 52) ist der Knopf `disabled`: hier ist
 * das die Auskunft "weiter geht es nicht", kein toter Weg.
 */
function intervalStepperHtml(value) {
  const v = Math.min(52, Math.max(1, Number(value) || 1));
  return `<div class="waste-interval-stepper">`
    + `<button type="button" class="btn btn--secondary btn--icon" data-interval-step="-1" aria-controls="wsm-interval" aria-label="${esc(t('waste.intervalDecrease'))}"${v <= 1 ? ' disabled' : ''}><i data-lucide="minus" class="icon-md" aria-hidden="true"></i></button>`
    + `<input type="number" class="form-input waste-interval-stepper__input" id="wsm-interval" min="1" max="52" step="1" inputmode="numeric" value="${esc(String(v))}" aria-labelledby="wsm-interval-label">`
    + `<button type="button" class="btn btn--secondary btn--icon" data-interval-step="1" aria-controls="wsm-interval" aria-label="${esc(t('waste.intervalIncrease'))}"${v >= 52 ? ' disabled' : ''}><i data-lucide="plus" class="icon-md" aria-hidden="true"></i></button>`
    + `</div>`;
}

/** Verdrahtet den Stepper: Knopf schreibt den Wert, das Feld haelt die Knoepfe nach. */
function wireIntervalStepper(root) {
  const input = root.querySelector('#wsm-interval');
  if (!input) return;
  const buttons = [...root.querySelectorAll('[data-interval-step]')];
  const sync = () => {
    const v = Number(input.value) || 1;
    for (const btn of buttons) btn.disabled = Number(btn.dataset.intervalStep) < 0 ? v <= 1 : v >= 52;
  };
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const next = Math.min(52, Math.max(1, (Number(input.value) || 1) + Number(btn.dataset.intervalStep)));
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sync();
      // An der Grenze wird der Knopf disabled und verloere den Fokus - dann zum Feld.
      if (btn.disabled) input.focus();
    });
  }
  input.addEventListener('input', sync);
}

function weekdayPickerHtml(selected) {
  const set = new Set(String(selected ?? '').split(',').filter(Boolean));
  const chosen = WEEKDAY_CODES.filter((code) => set.has(code));
  return `<div class="waste-weekday-picker" role="group" aria-labelledby="wsm-weekdays-label">${WEEKDAY_CODES.map((code) => `
    <button type="button" class="filter-chip${set.has(code) ? ' filter-chip--active' : ''}" data-weekday="${code}"
            aria-pressed="${set.has(code) ? 'true' : 'false'}">${esc(t(WEEKDAY_LABEL_KEYS[code]))}</button>`).join('')}
    <input type="hidden" name="weekdays" value="${chosen.join(',')}"></div>`;
}

/**
 * DER WOCHENTAG FOLGT DER ERSTEN ABHOLUNG (Critique R24, G2-Entsorgung-P2-1).
 * Ein neuer Termin stand auf "Woechentlich" ohne gewaehlten Tag, waehrend
 * "Erste Abholung" schon heute trug - erst das Absenden sagte "Waehle
 * mindestens einen Wochentag". Jetzt ist der Tag der ersten Abholung
 * vorgewaehlt und zieht mit, wenn man sie aendert - bis man selbst einen Tag
 * waehlt; dann gehoert die Auswahl einem selbst.
 */
function weekdayCodeOf(dateKey) {
  const date = parseLocalDateKey(dateKey);
  if (!date || Number.isNaN(date.getTime?.())) return null;
  const day = date.getDay();
  return WEEKDAY_CODES.find((code) => DAY_INDEX[code] === day) ?? null;
}

function setWeekdayPickerValue(root, codes) {
  const picker = root.querySelector('.waste-weekday-picker');
  if (!picker) return;
  const set = new Set(codes);
  picker.querySelectorAll('[data-weekday]').forEach((chip) => {
    const on = set.has(chip.dataset.weekday);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('filter-chip--active', on);
  });
  const hidden = picker.querySelector('input[name="weekdays"]');
  if (hidden) hidden.value = WEEKDAY_CODES.filter((code) => set.has(code)).join(',');
}

function weekdayPickerValue(root) {
  return [...root.querySelectorAll('.waste-weekday-picker [data-weekday][aria-pressed="true"]')]
    .map((el) => el.dataset.weekday);
}

/**
 * "Mindestens ein Wochentag" an der Tagesgruppe statt im Toast (Re-Critique
 * 2026-10-17). Die Meldung steht unter den Chips, die Gruppe beschreibt sie
 * (aria-describedby), der Fokus geht auf den ersten Tag - der Baustein selbst
 * faende nur das versteckte Feld. Die naechste Wahl raeumt die Meldung weg:
 * das versteckte Feld meldet `input`, und das blubbert zur Gruppe.
 */
function reportWeekdaysMissing(root) {
  const picker = root.querySelector('.waste-weekday-picker');
  if (!picker) return false;
  reportFieldError(picker, t('waste.errorScheduleWeekdaysRequired'), { focus: false });
  picker.querySelector('[data-weekday]')?.focus({ preventScroll: true });
  picker.scrollIntoView?.({ block: 'center' });
  return false;
}

function wireWeekdayPicker(root) {
  const picker = root.querySelector('.waste-weekday-picker');
  picker?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-weekday]');
    if (!chip) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('filter-chip--active', on);
    const hidden = picker.querySelector('input[name="weekdays"]');
    if (hidden) {
      hidden.value = weekdayPickerValue(root).join(',');
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

/* `type` ist die Abfallart der Zeile, aus der der Dialog kommt. Vom
 * Primaerknopf kommt er OHNE (null): dann waehlt man die Abfallart im Dialog,
 * vorbelegt ueber defaultScheduleType(). */
function openScheduleModal(type, schedule = null) {
  const isEdit = !!schedule;
  const pickType = !type;
  const suggested = pickType ? defaultScheduleType() : null;
  const typeField = pickType ? `
    <div class="form-group">
      <label class="form-label" for="wsm-type">${t('waste.typeSelectLabel')}</label>
      <select class="form-input" id="wsm-type">${typeOptionsHtml(suggested?.id ?? null)}</select>
    </div>` : '';
  const kind = schedule?.recurrence_kind ?? 'weekly';
  const isOrdinal = kind === 'monthly_ordinal_weekday';

  const content = `${typeField}
    <div class="form-group">
      <label class="form-label" for="wsm-kind">${t('waste.recurrenceKindLabel')}</label>
      <select class="form-input" id="wsm-kind">
        <option value="weekly"${kind === 'weekly' ? ' selected' : ''}>${t('waste.recurrenceWeekly')}</option>
        <option value="monthly_fixed_day"${kind === 'monthly_fixed_day' ? ' selected' : ''}>${t('waste.recurrenceMonthly')}</option>
        <option value="monthly_ordinal_weekday"${isOrdinal ? ' selected' : ''}>${t('waste.recurrenceMonthlyOrdinal')}</option>
      </select>
    </div>
    <div class="form-group form-field" id="wsm-weekly-fields" ${kind === 'weekly' ? '' : 'hidden'}>
      <span class="form-label" id="wsm-weekdays-label">${t('waste.weekdaysLabel')}</span>
      ${weekdayPickerHtml(schedule?.weekdays ?? weekdayCodeOf(schedule?.anchor_date ?? todayKey()))}
    </div>
    <div class="form-group" id="wsm-monthly-fields" ${kind === 'monthly_fixed_day' ? '' : 'hidden'}>
      <label class="form-label" for="wsm-month-day">${t('waste.monthDayLabel')}</label>
      <input type="number" class="form-input" id="wsm-month-day" min="1" max="31" value="${esc(String((schedule?.month_day ?? -1) === -1 ? 1 : schedule.month_day))}">
      ${formSwitchRowHtml({ label: t('waste.monthDayLastDay'), checked: schedule?.month_day === -1, attrs: { id: 'wsm-last-day' } })}
    </div>
    <div class="form-group" id="wsm-ordinal-fields" ${isOrdinal ? '' : 'hidden'}>
      <label class="form-label" for="wsm-ordinal-position">${t('waste.ordinalPositionLabel')}</label>
      <select class="form-input" id="wsm-ordinal-position">
        ${ORDINAL_WEEKDAY_VALUES.map((v) => `<option value="${v}"${isOrdinal && schedule.month_day === v ? ' selected' : ''}>${esc(t(ORDINAL_LABEL_KEYS[v]))}</option>`).join('')}
      </select>
      <label class="form-label" for="wsm-ordinal-weekday">${t('waste.ordinalWeekdayLabel')}</label>
      <select class="form-input" id="wsm-ordinal-weekday">
        ${WEEKDAY_CODES.map((code) => `<option value="${code}"${isOrdinal && schedule.weekdays === code ? ' selected' : ''}>${esc(t(WEEKDAY_LABEL_KEYS[code]))}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <span class="form-label" id="wsm-interval-label">${t('waste.intervalLabel')}</span>
      ${intervalSentenceHtml({
        key: kind === 'weekly' ? 'common.everyNWeeks' : 'common.everyNMonths',
        count: schedule?.interval ?? 1,
        countHtml: intervalStepperHtml(schedule?.interval ?? 1),
        labelledBy: 'wsm-interval-label', className: 'wsm-interval-sentence',
      })}
    </div>
    <div class="form-group">
      <label class="form-label" for="wsm-anchor">${t('waste.anchorDateLabel')}${REQUIRED_MARK}</label>
      <yuvomi-datepicker required id="wsm-anchor" name="anchor_date" type="date" value="${esc(schedule?.anchor_date ?? todayKey())}"></yuvomi-datepicker>
    </div>
    <div class="form-group">
      <label class="form-label" for="wsm-valid-until">${t('waste.validUntilLabel')}</label>
      <yuvomi-datepicker id="wsm-valid-until" name="valid_until" type="date" value="${esc(schedule?.valid_until ?? '')}"></yuvomi-datepicker>
    </div>
    ${/* "AKTIV" NUR BEIM BEARBEITEN (R24, G2-Entsorgung-P2-1): ein neuer Termin
          ist aktiv - der Schalter beim Anlegen fragte nach etwas, das niemand
          anders will. Pausieren ist eine Frage an einen bestehenden Termin. */ ''}
    ${isEdit ? `<div class="form-group">
      ${formSwitchRowHtml({ label: t('waste.activeLabel'), checked: schedule?.active !== 0, attrs: { id: 'wsm-active' } })}
    </div>` : ''}
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="wsm-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}</button>` : ''}
      <div class="modal-panel__footer-group">
        <button type="button" class="btn btn--secondary" id="wsm-cancel">${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="wsm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    staged: !isEdit, // Buehne zuerst, Felder nach dem ersten Bild (modal.js, R21 a6)
    title: isEdit ? t('waste.editSchedule') : t('waste.newSchedule'),
    initialFocus: dialogInitialFocus(isEdit),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wsm-cancel').addEventListener('click', () => closeModal());

      wireWeekdayPicker(panel);
      wireIntervalStepper(panel);
      if (!isEdit) {
        let ownWeekdays = false;
        panel.querySelector('.waste-weekday-picker')?.addEventListener('click', (event) => {
          if (event.target.closest?.('[data-weekday]')) ownWeekdays = true;
        });
        panel.querySelector('#wsm-anchor')?.addEventListener('change', (event) => {
          if (ownWeekdays || panel.querySelector('#wsm-kind')?.value !== 'weekly') return;
          const code = weekdayCodeOf(event.target.value);
          if (code) setWeekdayPickerValue(panel, [code]);
        });
      }
      const kindSelect = panel.querySelector('#wsm-kind');
      const weeklyFields = panel.querySelector('#wsm-weekly-fields');
      const monthlyFields = panel.querySelector('#wsm-monthly-fields');
      const ordinalFields = panel.querySelector('#wsm-ordinal-fields');
      const ordinalPositionSelect = panel.querySelector('#wsm-ordinal-position');
      const ordinalWeekdaySelect = panel.querySelector('#wsm-ordinal-weekday');
      const anchorInput = panel.querySelector('#wsm-anchor');
      panel.querySelector('#wsm-type')?.addEventListener('change', (e) => e.target.removeAttribute('aria-invalid'));

      // Der Anker wird bei jeder Ordinal-/Wochentags-Aenderung neu berechnet
      // (naechstes passendes Datum ab heute, wie jeder andere "ab jetzt"-
      // Default) - die Rechnung selbst lebt in nearestOrdinalAnchorDateKey()
      // auf Modulebene, wo der Test sie unter einer fremden Zone binden kann.
      function refreshOrdinalAnchor() {
        if (kindSelect.value !== 'monthly_ordinal_weekday') return;
        anchorInput.value = nearestOrdinalAnchorDateKey(Number(ordinalPositionSelect.value), ordinalWeekdaySelect.value);
      }
      ordinalPositionSelect.addEventListener('change', refreshOrdinalAnchor);
      ordinalWeekdaySelect.addEventListener('change', refreshOrdinalAnchor);

      kindSelect.addEventListener('change', () => {
        weeklyFields.hidden = kindSelect.value !== 'weekly';
        monthlyFields.hidden = kindSelect.value !== 'monthly_fixed_day';
        ordinalFields.hidden = kindSelect.value !== 'monthly_ordinal_weekday';
        // "Alle [2] Wochen" / "Alle [2] Monate" - der Satz folgt der Wiederholung, das Feld behaelt den Wert.
        setIntervalSentenceKey(panel.querySelector('.wsm-interval-sentence'), kindSelect.value === 'weekly' ? 'common.everyNWeeks' : 'common.everyNMonths');
        if (kindSelect.value === 'monthly_ordinal_weekday') refreshOrdinalAnchor();
      });

      panel.querySelector('#wsm-delete')?.addEventListener('click', async () => {
        const modalContext = captureModalContext();
        const ok = await confirmOverModal(t('waste.scheduleDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.scheduleDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await deleteOrAlreadyGone(`/waste/schedules/${schedule.id}`, 'waste_schedule_not_found');
          closeModal({ force: true, context: modalContext });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.scheduleDeletedNamed', { name: typeById(schedule.type_id)?.name ?? type?.name ?? '' }), 'success');
        } catch (err) {
          reportError(err);
        }
      });

      panel.querySelector('#wsm-save').addEventListener('click', async () => {
        const kindValue = kindSelect.value;
        const anchor = panel.querySelector('#wsm-anchor').value;
        const validUntil = panel.querySelector('#wsm-valid-until').value || null;
        const interval = Number(panel.querySelector('#wsm-interval').value) || 1;
        const active = panel.querySelector('#wsm-active')?.checked ?? true;

        const typeSelect = panel.querySelector('#wsm-type');
        if (typeSelect && !typeSelect.value) { typeSelect.focus(); return; }
        const typeId = typeSelect ? Number(typeSelect.value) : type.id;
        const body = { type_id: typeId, recurrence_kind: kindValue, anchor_date: anchor, interval, valid_until: validUntil, active };
        if (kindValue === 'weekly') {
          body.weekdays = weekdayPickerValue(panel);
          if (!body.weekdays.length) return reportWeekdaysMissing(panel);
        } else if (kindValue === 'monthly_ordinal_weekday') {
          body.month_day = Number(ordinalPositionSelect.value);
          body.weekdays = ordinalWeekdaySelect.value;
        } else {
          const lastDay = panel.querySelector('#wsm-last-day').checked;
          body.month_day = lastDay ? -1 : Number(panel.querySelector('#wsm-month-day').value);
        }

        const modalContext = captureModalContext();
        try {
          if (isEdit) await api.put(`/waste/schedules/${schedule.id}`, body);
          else await api.post('/waste/schedules', body);
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(scheduleSavedSentence(typeById(body.type_id)?.name), 'success');
        } catch (err) {
          if (await keepDialogForMissingType(err, typeSelect)) return;
          // Dieselbe Absage vom Server (z. B. eine aeltere Seite): ans Feld.
          if (err?.data?.reason === 'waste_schedule_weekdays_required' && kindValue === 'weekly') {
            reportWeekdaysMissing(panel);
            return;
          }
          reportError(err);
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// One-off pickup modal
// -------------------------------------------------------------------------

function openPickupModal(pickup = null) {
  const isEdit = !!pickup;
  // Die eigene Abfallart einer Abholung bleibt waehlbar, auch wenn sie archiviert ist.
  const ownTypeId = isEdit ? pickup.type_id : null;
  const typeOptions = typeOptionsHtml(ownTypeId, ownTypeId);

  const content = `
    <div class="form-group">
      <label class="form-label" for="wpm-type">${t('waste.typeSelectLabel')}</label>
      <select class="form-input" id="wpm-type">${typeOptions}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="wpm-date">${t('waste.pickupDateLabel')}${REQUIRED_MARK}</label>
      <yuvomi-datepicker required id="wpm-date" name="date" type="date" value="${esc(pickup?.date ?? todayKey())}"></yuvomi-datepicker>
    </div>
    <div class="form-group">
      <label class="form-label" for="wpm-note">${t('waste.pickupNoteLabel')}</label>
      <textarea class="form-input" id="wpm-note" maxlength="500">${esc(pickup?.note ?? '')}</textarea>
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="wpm-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}</button>` : ''}
      <div class="modal-panel__footer-group">
        <button type="button" class="btn btn--secondary" id="wpm-cancel">${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="wpm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    title: isEdit ? t('waste.editPickup') : t('waste.newPickup'),
    initialFocus: dialogInitialFocus(isEdit),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wpm-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#wpm-type').addEventListener('change', (e) => e.target.removeAttribute('aria-invalid'));

      panel.querySelector('#wpm-delete')?.addEventListener('click', async () => {
        const modalContext = captureModalContext();
        // Der Name VOR dem Nachladen: danach kann die Art schon fehlen.
        const name = typeById(pickup.type_id)?.name ?? '';
        const ok = await confirmOverModal(t('waste.pickupDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.pickupDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await deleteOrAlreadyGone(`/waste/pickups/${pickup.id}`, 'waste_pickup_not_found');
          closeModal({ force: true, context: modalContext });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.pickupDeletedNamed', { name }), 'success');
        } catch (err) {
          reportError(err);
        }
      });

      panel.querySelector('#wpm-save').addEventListener('click', async () => {
        const typeSelect = panel.querySelector('#wpm-type');
        if (!typeSelect.value) { typeSelect.focus(); return; }
        const body = {
          type_id: Number(typeSelect.value),
          date: panel.querySelector('#wpm-date').value,
          note: panel.querySelector('#wpm-note').value.trim() || null,
        };
        const modalContext = captureModalContext();
        try {
          if (isEdit) await api.put(`/waste/pickups/${pickup.id}`, body);
          else await api.post('/waste/pickups', body);
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(typeById(body.type_id)?.name
            ? t('waste.pickupSavedNamed', { name: typeById(body.type_id).name })
            : t('waste.pickupSavedToast'), 'success');
        } catch (err) {
          if (await keepDialogForMissingType(err, typeSelect, ownTypeId)) return;
          reportError(err);
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// ICS import wizard and source management (#1063 Phase 3)
// -------------------------------------------------------------------------

/**
 * Pure: a sensible starting selection for a label - remembered beats suggested
 * beats "create a new type". A label can name several bins (#2273), so the
 * selection is a set of types plus, at most, one new type; nothing selected
 * means the label is ignored.
 * @returns {{ typeIds: number[], createNew: boolean }}
 */
function defaultLabelSelection(label) {
  if (label.remembered_ignored) return { typeIds: [], createNew: false };
  if (label.remembered_type_ids?.length) return { typeIds: [...label.remembered_type_ids], createNew: false };
  if (label.suggested_type_id) return { typeIds: [label.suggested_type_id], createNew: false };
  return { typeIds: [], createNew: true };
}

/** Pure: blocking diagnostics not yet covered by an explicit skip. */
function unresolvedBlockingDiagnostics(diagnostics, skippedEventKeys) {
  const skipSet = new Set(skippedEventKeys);
  return diagnostics.filter((d) => d.severity === 'blocking' && !skipSet.has(d.event_key));
}

/**
 * Pure: builds the commit body's `mappings` array from each label row's
 * selection (`{ typeIds, createNew, newTypeName }`). No type and no new type
 * is "ignored"; otherwise every chosen type and the new one together (#2273).
 * Returns `{ error, label }` instead of throwing, so the DOM-facing caller can
 * show a field-level message.
 */
function buildMappingDecisions(rows) {
  const mappings = [];
  for (const row of rows) {
    const typeIds = [...new Set(row.typeIds ?? [])];
    if (!typeIds.length && !row.createNew) {
      mappings.push({ normalized_label: row.normalized_label, ignored: true });
      continue;
    }
    const decision = { normalized_label: row.normalized_label };
    if (typeIds.length) decision.type_ids = typeIds;
    if (row.createNew) {
      const name = (row.newTypeName || '').trim();
      if (!name) return { error: 'missing_new_type_name', label: row.normalized_label };
      decision.new_type = { name };
    }
    mappings.push(decision);
  }
  return { mappings };
}

// Maps server/services/waste-import.js's `diag.code` onto a translated
// sentence, mirroring MAPPING_PROFILE_STATUS_LABEL_KEYS just above it in this
// file (same shape - a fixed vocabulary of server-computed codes, one i18n
// key each). Previously the English `diag.message` from the server printed
// verbatim next to a translated `waste.importSkipEventLabel` - the two
// sentences of the same row spoke different languages in 23 of 24 locales.
const IMPORT_DIAGNOSTIC_LABEL_KEYS = {
  unsupported_rdate: 'waste.importDiagnosticUnsupportedRdate',
  unbounded_recurrence: 'waste.importDiagnosticUnboundedRecurrence',
  skipped_unparsable: 'waste.importDiagnosticSkippedUnparsable',
  cancelled_excluded: 'waste.importDiagnosticCancelledExcluded',
  missing_uid_fallback: 'waste.importDiagnosticMissingUidFallback',
  duplicate_instance: 'waste.importDiagnosticDuplicateInstance',
};

/** A code this client doesn't (yet) know gets the app's general sentence - never a blank row, and never the server's English `message` (#1909). */
function importDiagnosticText(diag) {
  const key = Object.hasOwn(IMPORT_DIAGNOSTIC_LABEL_KEYS, diag.code) ? IMPORT_DIAGNOSTIC_LABEL_KEYS[diag.code] : null;
  if (!key) return t('waste.importDiagnosticOther');
  return t(key, { name: diag.name ?? '', count: diag.count ?? 0 });
}

function importDiagnosticRowHtml(diag) {
  if (diag.severity === 'blocking') {
    return `
      <label class="waste-import-diagnostic waste-import-diagnostic--blocking">
        <input type="checkbox" data-role="skip-event" value="${esc(diag.event_key)}">
        <span>${esc(importDiagnosticText(diag))} ${esc(t('waste.importSkipEventLabel'))}</span>
      </label>`;
  }
  return `<p class="waste-import-diagnostic waste-import-diagnostic--info">${esc(importDiagnosticText(diag))}</p>`;
}

/**
 * EIN EINTRAG, MEHRERE TONNEN (#2273): die Abfallarten eines Labels als Chips
 * des Kanons (`.filter-chip`, `aria-pressed`) in einer benannten Gruppe, wie
 * die Wochentage im Termin-Dialog. Dresden nennt Bio- und Blaue Tonne in einem
 * Eintrag; beide Chips an heisst ein Termin je Art. Kein Chip an heisst: das
 * Label wird nicht uebernommen - das sagt die Zeile darunter, statt dass
 * "Ignorieren" wie eine weitere Abfallart zwischen den Arten steht.
 *
 * Eine archivierte Art steht nur da, wenn sie schon gewaehlt ist, damit eine
 * inzwischen archivierte Zuordnung als gewaehlt erscheint, statt still
 * wegzufallen. `createNew` ist `null`, wo es keinen "Neue Abfallart"-Chip gibt
 * (die Zuordnungen einer Quelle legen keine Art an).
 */
function labelTypeChipsHtml({ labelId, typeIds, createNew = null }) {
  const chosen = new Set(typeIds);
  const types = state.types.filter((t2) => !t2.archived || chosen.has(t2.id));
  const chip = (attrs, on, icon, color, text) => `
        <button type="button" class="filter-chip${on ? ' filter-chip--active' : ''}" ${attrs} aria-pressed="${on ? 'true' : 'false'}">`
    + `<i data-lucide="${esc(icon)}"${color ? ` style="color:${esc(color)}"` : ''} aria-hidden="true"></i><span>${esc(text)}</span></button>`;
  const none = !chosen.size && !createNew;
  // Die Wahl steht zusaetzlich in einem versteckten Feld (wie bei den
  // Wochentagen): nur Felder sieht der Verwerfen-Schutz des Dialogs, und ohne
  // es ginge eine Aenderung nur an den Chips beim Schliessen still verloren.
  return `
      <div class="waste-label-types" role="group" aria-labelledby="${esc(labelId)}" data-role="label-types">
        ${types.map((t2) => chip(`data-type-chip="${t2.id}"`, chosen.has(t2.id), t2.icon || 'trash-2', t2.color, t2.name)).join('')}
        ${createNew === null ? '' : chip('data-new-type-chip', !!createNew, 'plus', null, t('waste.importCreateNewType'))}
        <input type="hidden" name="${esc(labelId)}-types" data-role="label-types-value" value="${esc(labelTypesValue([...chosen], createNew))}">
      </div>
      <p class="waste-label-types__ignored" data-role="label-ignored"${none ? '' : ' hidden'}>${esc(t('waste.importLabelIgnoredHint'))}</p>`;
}

/** Pure: the hidden field's value for one row's choice - what the dialog's discard guard compares. */
function labelTypesValue(typeIds, createNew) {
  return [...[...typeIds].sort((a, b) => a - b), ...(createNew ? ['new'] : [])].join(',');
}

/** Reads one row's chips back: the pressed types and whether "new type" is on. */
function labelTypeSelection(row) {
  return {
    typeIds: [...row.querySelectorAll('[data-type-chip][aria-pressed="true"]')].map((el) => Number(el.dataset.typeChip)),
    createNew: row.querySelector('[data-new-type-chip]')?.getAttribute('aria-pressed') === 'true',
  };
}

/**
 * Schaltet einen Chip und haelt die Zeile nach: der Satz "wird nicht
 * uebernommen", sobald nichts mehr gewaehlt ist, und das Namensfeld der neuen
 * Art, solange ihr Chip an ist. Gibt die Zeile zurueck, oder null, wenn der
 * Klick keinen Chip traf.
 */
function toggleLabelTypeChip(event, rowSelector) {
  const chip = event.target.closest('[data-type-chip], [data-new-type-chip]');
  const row = chip?.closest(rowSelector);
  if (!row) return null;
  const on = chip.getAttribute('aria-pressed') !== 'true';
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  chip.classList.toggle('filter-chip--active', on);
  syncLabelRow(row);
  row.querySelector('[data-role="label-types-value"]')?.dispatchEvent(new Event('input', { bubbles: true }));
  if (on && chip.hasAttribute('data-new-type-chip')) row.querySelector('[data-role="label-new-type-name"]')?.focus();
  return row;
}

function syncLabelRow(row) {
  const { typeIds, createNew } = labelTypeSelection(row);
  const ignored = row.querySelector('[data-role="label-ignored"]');
  if (ignored) ignored.hidden = typeIds.length > 0 || createNew;
  const name = row.querySelector('[data-role="label-new-type-name"]');
  if (name) name.hidden = !createNew;
  const value = row.querySelector('[data-role="label-types-value"]');
  if (value) value.value = labelTypesValue(typeIds, createNew);
}

function importLabelRowHtml(label, index) {
  const { typeIds, createNew } = defaultLabelSelection(label);
  const labelId = `wiz-label-${index}`;
  return `
    <div class="waste-import-label-row" data-label="${esc(label.normalized_label)}">
      <span class="waste-import-label-row__name" id="${labelId}">${esc(label.original_label)} <span class="waste-import-label-row__count">(${label.count})</span></span>
      ${labelTypeChipsHtml({ labelId, typeIds, createNew })}
      <input type="text" class="form-input waste-import-new-type-name" data-role="label-new-type-name"
        aria-label="${esc(t('waste.typeNameLabel'))}"
        placeholder="${esc(t('waste.typeNameLabel'))}" value="${esc(label.original_label)}"${createNew ? '' : ' hidden'}>
    </div>`;
}

function importPreviewStepHtml(preview) {
  return `
    <p class="waste-import-summary">${esc(t('waste.importSummary', { events: preview.counts.events, candidates: preview.counts.candidates }))}</p>
    ${preview.diagnostics.length ? `<div class="waste-import-diagnostics">${preview.diagnostics.map(importDiagnosticRowHtml).join('')}</div>` : ''}
    ${preview.labels.length
    ? `<p class="waste-import-labels-hint">${esc(t('waste.importLabelsHint'))}</p>
      <div class="waste-import-labels">${preview.labels.map(importLabelRowHtml).join('')}</div>`
    : `<p>${esc(t('waste.importNoLabels'))}</p>`}`;
}

/**
 * The sentence an assistant shows inside its own dialog (#1909): the app's
 * sentence for the case the server names by `reason` - a limit with its number,
 * a calendar that changed since the preview, a failed fetch by its class - and
 * the general one for everything else. Never the server's text.
 */
function importErrorText(err) {
  return errorSentence(err, 'common.unknownError');
}

/**
 * The import commit failed only because a label was mapped to a type somebody
 * deleted in the meantime: the assistant stays, every decision stays, and the
 * chips are rebuilt from the fresh types. A row that loses its last type to
 * the deletion falls back to "create a new type" - the same default the
 * assistant gives a label it knows no type for - and its first chip gets the
 * focus.
 */
async function refreshImportTypeChoices(panel) {
  await reloadAndRender();
  let first = null;
  for (const row of panel.querySelectorAll('.waste-import-label-row')) {
    const { typeIds, createNew } = labelTypeSelection(row);
    const kept = typeIds.filter((id) => state.types.some((t2) => t2.id === id));
    const lostAll = typeIds.length > 0 && kept.length === 0;
    const group = row.querySelector('[data-role="label-types"]');
    const labelId = group.getAttribute('aria-labelledby');
    group.nextElementSibling?.remove();
    group.insertAdjacentHTML('afterend', labelTypeChipsHtml({ labelId, typeIds: kept, createNew: createNew || lostAll }));
    group.remove();
    syncLabelRow(row);
    if (kept.length < typeIds.length && !first) first = row.querySelector('[data-role="label-types"] .filter-chip');
  }
  if (window.lucide) window.lucide.createIcons({ el: panel });
  first?.focus();
}

function openImportWizard(source = null) {
  const isReimport = !!source;
  // A URL source has no file to pick - the server re-fetches its own stored
  // URL (routes/waste/sources.js#icsTextForReimport), so step 1 skips the
  // file input entirely and step 2 is reached directly from a single fetch.
  const isUrlSource = isReimport && source.kind === 'url';
  let previewData = null;

  const content = `
    <div id="wiz-step1">
      ${isReimport ? '' : `
      <div class="form-group">
        <label class="form-label" for="wiz-name">${t('waste.importNameLabel')}</label>
        <input type="text" class="form-input" id="wiz-name" maxlength="150" placeholder="${esc(t('waste.importNamePlaceholder'))}">
      </div>`}
      ${isUrlSource ? '' : `
      <div class="form-group">
        <label class="form-label" for="wiz-file">${t('waste.importFileLabel')}</label>
        <input type="file" class="form-input" id="wiz-file" accept=".ics,text/calendar">
      </div>`}
    </div>
    <div id="wiz-step2" hidden></div>
    <div class="form-error" id="wiz-error" role="alert" hidden></div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div></div>
      <div class="modal-panel__footer-group">
        <button class="btn btn--secondary" id="wiz-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wiz-preview">${t('waste.importPreviewAction')}</button>
        <button class="btn btn--primary" id="wiz-commit" hidden>${t('waste.importCommitAction')}</button>
      </div>
    </div>`;

  openModal({
    title: isReimport ? t('waste.reimportModalTitle', { name: source.name }) : t('waste.importModalTitle'),
    content,
    size: 'md',
    onSave(panel) {
      const errorEl = panel.querySelector('#wiz-error');
      const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };

      panel.querySelector('#wiz-cancel').addEventListener('click', () => closeModal());

      panel.addEventListener('click', (e) => { toggleLabelTypeChip(e, '.waste-import-label-row'); });

      panel.querySelector('#wiz-preview').addEventListener('click', async () => {
        errorEl.hidden = true;
        let icsText = null;
        if (!isUrlSource) {
          const file = panel.querySelector('#wiz-file').files?.[0];
          if (!file) { showError(t('waste.importNoFileError')); return; }
          // Die Grenze kennt die Seite vom Server (/version). Ohne diese Probe
          // scheitert eine deutlich zu grosse Datei schon am Rumpf der Anfrage
          // (413), bevor die Route ihren Grund nennen kann.
          if (file.size > maxUploadBytes()) { showError(t('waste.errorImportTooLarge', { limit_mb: maxUploadMb() })); return; }
          try { icsText = await file.text(); } catch { showError(t('waste.importReadError')); return; }
        }

        const modalContext = captureModalContext();
        try {
          const endpoint = isReimport ? `/waste/sources/${source.id}/reimport/preview` : '/waste/import/preview';
          const res = await api.post(endpoint, isUrlSource ? {} : { ics: icsText });
          if (res.data.unchanged) {
            closeModal({ force: true, context: modalContext });
            window.yuvomi?.showToast(t('waste.sourceUnchangedToast'), 'default');
            return;
          }
          previewData = { ...res.data, icsText };
          const step2 = panel.querySelector('#wiz-step2');
          step2.replaceChildren();
          step2.insertAdjacentHTML('beforeend', importPreviewStepHtml(previewData));
          step2.hidden = false;
          panel.querySelectorAll('#wiz-step1 input').forEach((el) => { el.disabled = true; });
          panel.querySelector('#wiz-preview').hidden = true;
          panel.querySelector('#wiz-commit').hidden = false;
          if (window.lucide) window.lucide.createIcons({ el: step2 });
        } catch (err) {
          // Die Quelle selbst ist weg: der Assistent hat nichts mehr zu tun.
          if (isGone(err)) { reportError(err); return; }
          showError(importErrorText(err));
        }
      });

      panel.querySelector('#wiz-commit').addEventListener('click', async () => {
        if (!previewData) return;
        errorEl.hidden = true;

        const skipEventKeys = [...panel.querySelectorAll('[data-role="skip-event"]:checked')].map((cb) => cb.value);
        const unresolved = unresolvedBlockingDiagnostics(previewData.diagnostics, skipEventKeys);
        if (unresolved.length) { showError(t('waste.importUnresolvedBlockingError')); return; }

        const rows = [...panel.querySelectorAll('.waste-import-label-row')].map((row) => ({
          normalized_label: row.dataset.label,
          ...labelTypeSelection(row),
          newTypeName: row.querySelector('[data-role="label-new-type-name"]').value,
        }));
        const built = buildMappingDecisions(rows);
        if (built.error) { showError(t('waste.importNewTypeNameRequiredError')); return; }

        const body = {
          mappings: built.mappings,
          skip_event_keys: skipEventKeys, preview_digest: previewData.digest,
        };
        if (!isUrlSource) body.ics = previewData.icsText;
        if (isReimport) body.expected_version = previewData.expected_version;
        else body.name = panel.querySelector('#wiz-name')?.value.trim() || t('waste.importDefaultSourceName');

        const modalContext = captureModalContext();
        try {
          const endpoint = isReimport ? `/waste/sources/${source.id}/reimport/commit` : '/waste/import/commit';
          const res = await api.post(endpoint, body);
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          const { added, changed, removed } = res.data.diff;
          window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
        } catch (err) {
          if (isSelectedTypeGone(err)) {
            showError(importErrorText(err));
            await refreshImportTypeChoices(panel);
            return;
          }
          if (isGone(err)) { reportError(err); return; }
          showError(importErrorText(err));
        }
      });
    },
  });
}

function sourceMappingRowHtml(mapping) {
  const labelId = `wsrc-mapping-${mapping.id}`;
  return `
    <div class="waste-source-mapping-row" data-mapping-id="${mapping.id}">
      <span class="waste-source-mapping-row__label" id="${labelId}">${esc(mapping.original_label)}</span>
      ${labelTypeChipsHtml({ labelId, typeIds: mapping.type_ids ?? [] })}
    </div>`;
}

/** Pure: whether a row's chosen types differ from the mapping as the server has it. */
function mappingTypesChanged(mapping, typeIds) {
  const before = [...(mapping.type_ids ?? [])].sort((a, b) => a - b);
  const after = [...typeIds].sort((a, b) => a - b);
  return before.length !== after.length || before.some((id, i) => id !== after[i]);
}

// -------------------------------------------------------------------------
// Mapping profile export/import (#1063 Phase 10)
// -------------------------------------------------------------------------

/** Downloads this source's resolved mappings as a portable {pattern, type_name} JSON file - no municipal/provider catalog ships with the app, so the only thing to export is a household's OWN prior decisions. */
async function exportMappingProfileFile(source) {
  try {
    const res = await api.get(`/waste/sources/${source.id}/mapping-profile/export`);
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `waste-mapping-profile-${source.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'source'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    reportError(err);
  }
}

const MAPPING_PROFILE_STATUS_LABEL_KEYS = {
  applicable: 'waste.mappingProfileStatusApplicable',
  unchanged: 'waste.mappingProfileStatusUnchanged',
  unmatched_pattern: 'waste.mappingProfileStatusUnmatchedPattern',
  unmatched_type: 'waste.mappingProfileStatusUnmatchedType',
  ambiguous_type: 'waste.mappingProfileStatusAmbiguousType',
};

function mappingProfileEntryRowHtml(entry) {
  return `
    <div class="waste-mapping-profile-row waste-mapping-profile-row--${esc(entry.status)}">
      <span class="waste-mapping-profile-row__pattern">${esc(entry.original_label ?? entry.pattern)}</span>
      <i data-lucide="arrow-right" class="icon-sm" aria-hidden="true"></i>
      <span class="waste-mapping-profile-row__type">${esc(entry.type_name)}</span>
      <span class="waste-badge waste-badge--${esc(entry.status)}">${esc(t(MAPPING_PROFILE_STATUS_LABEL_KEYS[entry.status] ?? entry.status))}</span>
    </div>`;
}

/**
 * File picker -> stateless preview -> reviewed commit, mirroring the ICS
 * import wizard's own preview/commit shape (openImportWizard) but much
 * smaller: no per-label decisions to make here, only a read-only preview of
 * what a resolved profile entry WOULD do, since previewMappingProfileImport
 * already resolves everything it can (server/services/waste-store.js).
 */
function openMappingProfileImportModal(source) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    // Kommt die Vorschau erst, nachdem der Nutzer einen anderen Dialog
    // geoeffnet oder die Seite verlassen hat, geht sie nicht mehr auf (#1997).
    const context = captureOpenContext();
    let profile;
    try {
      profile = JSON.parse(await file.text());
    } catch {
      window.yuvomi?.showToast(t('waste.mappingProfileInvalidFile'), 'danger');
      return;
    }

    let preview;
    try {
      preview = (await api.post(`/waste/sources/${source.id}/mapping-profile/import/preview`, { profile })).data;
    } catch (err) {
      reportError(err);
      return;
    }
    if (!isModalContextCurrent(context)) return;

    const content = `
      <p>${esc(t('waste.mappingProfileApplicableCount', { count: preview.applicable_count }))}</p>
      <div id="wmp-entries">${preview.entries.map(mappingProfileEntryRowHtml).join('')}</div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <div></div>
        <div class="modal-panel__footer-group">
          <button class="btn btn--secondary" id="wmp-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="wmp-apply"${preview.applicable_count ? '' : ' disabled'}>${t('waste.mappingProfileApplyAction')}</button>
        </div>
      </div>`;

    openModal({
      title: t('waste.mappingProfileImportModalTitle'),
      content,
      size: 'md',
      onSave(panel) {
        if (window.lucide) window.lucide.createIcons({ el: panel });
        panel.querySelector('#wmp-cancel').addEventListener('click', () => closeModal());
        panel.querySelector('#wmp-apply')?.addEventListener('click', async () => {
          const btn = panel.querySelector('#wmp-apply');
          const stopLoading = btnLoading(btn);
          const modalContext = captureModalContext();
          try {
            await api.post(`/waste/sources/${source.id}/mapping-profile/import/commit`, {
              profile, profile_digest: preview.profile_digest,
            });
            closeModal({ force: true, context: modalContext });
            await reloadAfterSave(() => loadSourceAndOpen(source.id));
            refocusAfterRender();
            window.yuvomi?.showToast(t('waste.mappingProfileAppliedToast'), 'success');
          } catch (err) {
            stopLoading();
            reportError(err);
          }
        });
      },
    });
  });
  input.click();
}

function openSourceModal(source) {
  const badge = sourceHealthBadgeInfo(source);
  const isUrl = source.kind === 'url';
  // reimportAction re-opens the file-picker wizard - meaningless for a URL
  // source. needs_mapping there means "review", otherwise "refresh now"
  // (both drive the same manual-refresh path as the source row's own action).
  const primaryActionKey = isUrl
    ? (source.needs_mapping ? 'waste.reviewMappingAction' : 'waste.refreshNowAction')
    : 'waste.reimportAction';
  const content = `
    <div class="form-group">
      <label class="form-label" for="wsrc-name">${t('waste.sourceNameLabel')}</label>
      <input type="text" class="form-input" id="wsrc-name" maxlength="150" value="${esc(source.name)}">
    </div>
    <div class="waste-source-detail__meta">
      ${isUrl && source.url ? `<p>${esc(t('waste.sourceUrlLabel'))}: ${esc(source.url)}</p>` : ''}
      ${source.coverage_start ? `<p>${esc(t('waste.sourceCoverageLabel'))}: ${esc(dateRangeText(source.coverage_start, source.coverage_end))}</p>` : ''}
      ${source.last_success_at ? `<p>${esc(t('waste.sourceLastImportedLabel'))}: ${esc(dateText(source.last_success_at))}</p>` : ''}
      ${source.last_error ? `<p class="waste-source-detail__error">${esc(lastFailureSentence(source))}</p>` : ''}
      ${badge ? `<span class="waste-badge waste-badge--${badge.code}">${esc(t(badge.labelKey))}</span>` : ''}
    </div>
    <h3 class="waste-section-title u-section-title u-compact">
      ${t('waste.sourceMappingsTitle')}
      <span class="waste-section-title__actions">
        <button type="button" class="btn btn--secondary btn--sm" id="wsrc-mapping-profile-export">${t('waste.mappingProfileExportAction')}</button>
        <button type="button" class="btn btn--secondary btn--sm" id="wsrc-mapping-profile-import">${t('waste.mappingProfileImportAction')}</button>
      </span>
    </h3>
    <div id="wsrc-mappings">${source.mappings.map(sourceMappingRowHtml).join('')}</div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button type="button" class="btn btn--danger-outline" id="wsrc-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${t('common.delete')}</button>
      <div class="modal-panel__footer-group">
        <button type="button" class="btn btn--secondary" id="wsrc-reimport">${t(primaryActionKey)}</button>
        <button type="button" class="btn btn--secondary" id="wsrc-cancel">${t('common.cancel')}</button>
        <button type="button" class="btn btn--primary" id="wsrc-save">${t('common.save')}</button>
      </div>
    </div>`;

  openModal({
    title: source.name,
    content,
    size: 'md',
    onSave(panel) {
      panel.querySelector('#wsrc-cancel').addEventListener('click', () => closeModal());
      panel.addEventListener('click', (e) => { toggleLabelTypeChip(e, '.waste-source-mapping-row'); });

      panel.querySelector('#wsrc-mapping-profile-export').addEventListener('click', () => exportMappingProfileFile(source));
      panel.querySelector('#wsrc-mapping-profile-import').addEventListener('click', () => openMappingProfileImportModal(source));

      panel.querySelector('#wsrc-reimport').addEventListener('click', () => {
        closeModal({ force: true });
        if (isUrl && !source.needs_mapping) triggerManualRefresh(source.id);
        else openImportWizard(source);
      });

      panel.querySelector('#wsrc-delete').addEventListener('click', async () => {
        const modalContext = captureModalContext();
        const ok = await confirmOverModal(t('waste.sourceDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.sourceDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await deleteOrAlreadyGone(`/waste/sources/${source.id}`, 'waste_source_not_found');
          closeModal({ force: true, context: modalContext });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.sourceDeletedToast'), 'success');
        } catch (err) {
          reportError(err);
        }
      });

      panel.querySelector('#wsrc-save').addEventListener('click', async () => {
        const name = panel.querySelector('#wsrc-name').value.trim();
        let failedMappingId = null;
        const modalContext = captureModalContext();
        try {
          if (name && name !== source.name) await api.put(`/waste/sources/${source.id}`, { name });
          for (const row of panel.querySelectorAll('.waste-source-mapping-row')) {
            const mappingId = Number(row.dataset.mappingId);
            failedMappingId = mappingId;
            const mapping = source.mappings.find((m) => m.id === mappingId);
            const { typeIds } = labelTypeSelection(row);
            if (!mappingTypesChanged(mapping, typeIds)) continue;
            await api.put(`/waste/sources/${source.id}/mappings/${mappingId}`, typeIds.length ? { type_ids: typeIds } : { ignored: true });
          }
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.sourceSavedToast'), 'success');
        } catch (err) {
          if (failedMappingId !== null && await keepSourceDialogForMissingType(err, panel, source, failedMappingId)) return;
          reportError(err);
        }
      });
    },
  });
}

/**
 * Wie `keepDialogForMissingType`, fuer die Zuordnungen einer Quelle: eine Zeile
 * zeigt auf eine Abfallart, die inzwischen geloescht wurde. Der Dialog bleibt,
 * der Name im Feld bleibt. Die Zeilen werden aus der frisch gelesenen Quelle neu
 * gebaut - was vor der gescheiterten Zeile schon gespeichert wurde, steht damit
 * als gespeichert da, und die gescheiterte zeigt wieder ihren Stand am Server
 * statt still auf "nicht uebernommen" zu fallen. Die Gruppe ihrer Abfallarten
 * ist als ungueltig markiert, der Fokus steht auf ihrem ersten Chip.
 *
 * @returns {Promise<boolean>} true: behandelt
 */
async function keepSourceDialogForMissingType(err, panel, source, mappingId) {
  if (!isSelectedTypeGone(err)) return false;
  window.yuvomi?.showToast(errorSentence(err), 'danger');
  await reloadAndRender();
  let fresh;
  try {
    fresh = (await api.get(`/waste/sources/${source.id}`)).data;
  } catch (reloadErr) {
    // Auch die Quelle ist weg (oder nicht lesbar): dann der gewohnte Weg.
    reportError(reloadErr);
    return true;
  }
  // Der Dialog vergleicht beim naechsten Speichern gegen diesen Stand.
  source.name = fresh.name;
  source.mappings = fresh.mappings;
  const host = panel.querySelector('#wsrc-mappings');
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', fresh.mappings.map(sourceMappingRowHtml).join(''));
  if (window.lucide) window.lucide.createIcons({ el: host });
  host.querySelector(`[data-mapping-id="${mappingId}"] [data-role="label-types"]`)?.setAttribute('aria-invalid', 'true');
  host.querySelector(`[data-mapping-id="${mappingId}"] [data-role="label-types"] .filter-chip`)?.focus();
  return true;
}

/**
 * Der Satz zu einem Abruf, der mit `outcome: 'error'` endete (#1909): der
 * Server nennt die Klasse des Fehlschlags in derselben Antwort (`reason`, dazu
 * `params`), die Seite sagt ihren Satz dafuer. Der gespeicherte Text der Quelle
 * (`last_error`) kommt nicht in den Toast.
 */
function fetchFailureSentence(data) {
  return errorSentence({ data: { reason: data?.reason, params: data?.params } }, 'waste.errorSourceFetch');
}

/**
 * Der Satz zum letzten gescheiterten Abruf einer Quelle (#1909): derselbe Fall,
 * den der Handabruf in seiner Antwort nennt, steht seit Migration 247 an der
 * Quelle (`last_error_reason`, `last_error_params`). `last_error` selbst ist der
 * englische Text des Servers und kommt nie in den Dialog; eine Quelle ohne
 * gespeicherten Fall (aelter als die Migration, oder ein Fehlschlag ohne
 * getypten Grund) bekommt den allgemeinen Satz.
 */
function lastFailureSentence(source) {
  return fetchFailureSentence({ reason: source.last_error_reason, params: source.last_error_params });
}

async function loadSourceAndOpen(id) {
  try {
    const res = await api.get(`/waste/sources/${id}`);
    openSourceModal(res.data);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Triggers a manual, on-demand refresh of a URL source (row action and the
 * source-modal's own primary button both call this). One request, then a
 * toast matching whichever of the four outcomes server/services/waste-url-
 * source.js#refreshUrlSource produced - reusing the existing import-commit
 * toast copy for `committed` rather than adding a parallel one.
 */
async function triggerManualRefresh(id) {
  try {
    const res = await api.post(`/waste/sources/${id}/refresh`, {});
    await reloadAfterSave(() => reloadAndRender());
    if (res.data.outcome === 'committed') {
      const { added, changed, removed } = res.data.diff;
      window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
    } else if (res.data.outcome === 'needs_mapping') {
      window.yuvomi?.showToast(t('waste.sourceNeedsMappingToast'), 'default');
    } else if (res.data.outcome === 'error') {
      window.yuvomi?.showToast(fetchFailureSentence(res.data), 'danger');
    } else {
      window.yuvomi?.showToast(t('waste.sourceUnchangedToast'), 'default');
    }
  } catch (err) {
    reportError(err);
  }
}

/** The refresh-interval field is minutes; keep it inside waste-url-source.js's own bounds so an obviously-wrong value fails client-side with the same message the server would give. */
const URL_SOURCE_MIN_INTERVAL_MINUTES = 60;
const URL_SOURCE_MAX_INTERVAL_MINUTES = 43_200;
const URL_SOURCE_DEFAULT_INTERVAL_MINUTES = 1440;

/** Welches Feld des Dialogs ein Grund meint - dorthin geht nach dem Fehler der Fokus. */
const URL_SOURCE_ERROR_FIELDS = new Map([
  ['waste_source_url_invalid', '#wurl-url'],
  ['waste_source_url_not_https', '#wurl-url'],
  ['waste_source_interval_invalid', '#wurl-interval'],
]);

function openUrlSourceWizard() {
  const content = `
    <div class="form-group">
      <label class="form-label" for="wurl-name">${t('waste.importNameLabel')}</label>
      <input type="text" class="form-input" id="wurl-name" maxlength="150" placeholder="${esc(t('waste.importNamePlaceholder'))}">
    </div>
    <div class="form-group">
      <label class="form-label" for="wurl-url">${t('waste.sourceUrlLabel')}</label>
      <input type="url" class="form-input" id="wurl-url" placeholder="https://" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label" for="wurl-interval">${t('waste.refreshIntervalMinutesLabel')}</label>
      <input type="number" class="form-input" id="wurl-interval" min="${URL_SOURCE_MIN_INTERVAL_MINUTES}"
        max="${URL_SOURCE_MAX_INTERVAL_MINUTES}" step="1" value="${URL_SOURCE_DEFAULT_INTERVAL_MINUTES}">
    </div>
    <div class="form-error" id="wurl-error" role="alert" hidden></div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div></div>
      <div class="modal-panel__footer-group">
        <button class="btn btn--secondary" id="wurl-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wurl-save">${t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    title: t('waste.urlSourceModalTitle'),
    content,
    size: 'md',
    onSave(panel) {
      const errorEl = panel.querySelector('#wurl-error');
      const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };

      panel.querySelector('#wurl-cancel').addEventListener('click', () => closeModal());

      panel.querySelector('#wurl-save').addEventListener('click', async () => {
        errorEl.hidden = true;
        const name = panel.querySelector('#wurl-name').value.trim() || t('waste.importDefaultSourceName');
        const url = panel.querySelector('#wurl-url').value.trim();
        const refreshIntervalMinutes = Number(panel.querySelector('#wurl-interval').value);
        if (!url) { showError(t('waste.importNoFileError')); return; }

        const btn = panel.querySelector('#wurl-save');
        const stopLoading = btnLoading(btn);
        const modalContext = captureModalContext();
        try {
          const res = await api.post('/waste/sources', { name, url, refresh_interval_minutes: refreshIntervalMinutes });
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          if (res.data.outcome === 'committed') {
            const { added, changed, removed } = res.data.diff;
            window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
          } else if (res.data.outcome === 'needs_mapping') {
            window.yuvomi?.showToast(t('waste.sourceNeedsMappingToast'), 'default');
          } else if (res.data.outcome === 'error') {
            window.yuvomi?.showToast(fetchFailureSentence(res.data), 'danger');
          }
        } catch (err) {
          stopLoading();
          showError(errorSentence(err, 'common.unknownError'));
          // Der Fokus geht an das Feld, das der Satz meint.
          const field = URL_SOURCE_ERROR_FIELDS.get(err?.data?.reason);
          if (field) panel.querySelector(field).focus();
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// Reminder settings (#1063 Phase 8) - personal, per-type
// -------------------------------------------------------------------------

function reminderSettingRowHtml(setting) {
  return `
    <div class="waste-reminder-setting-row" data-type-id="${setting.type_id}">
      ${formSwitchRowHtml({ label: setting.type_name, checked: Boolean(setting.enabled), attrs: { 'data-role': 'reminder-enabled' } })}
      <div class="waste-reminder-setting-row__fields"${setting.enabled ? '' : ' hidden'}>
        <label class="form-label" for="rem-offset-${setting.type_id}">${t('waste.reminderOffsetDaysLabel')}</label>
        <input type="number" class="form-input" id="rem-offset-${setting.type_id}" data-role="reminder-offset"
          min="0" max="14" step="1" value="${setting.offset_days}">
        <label class="form-label" for="rem-time-${setting.type_id}">${t('waste.reminderDeliveryTimeLabel')}</label>
        <input type="time" class="form-input" id="rem-time-${setting.type_id}" data-role="reminder-time" value="${esc(setting.delivery_time)}">
      </div>
    </div>`;
}

async function openReminderSettingsModal() {
  // Kommen die Einstellungen erst, nachdem der Nutzer einen anderen Dialog
  // geoeffnet oder die Seite verlassen hat, geht dieser Dialog nicht mehr auf (#1997).
  const context = captureOpenContext();
  let settings;
  try {
    settings = (await api.get('/waste/reminder-settings')).data;
  } catch (err) {
    reportError(err);
    return;
  }
  if (!isModalContextCurrent(context)) return;

  const content = settings.length
    ? `<div id="rem-rows">${settings.map(reminderSettingRowHtml).join('')}</div>`
    : `<p>${esc(t('waste.emptyTypesTitle'))}</p>`;

  openModal({
    title: t('waste.reminderSettingsModalTitle'),
    content: `${content}
      <div class="modal-panel__footer modal-panel__footer--plain">
        <div></div>
        <div class="modal-panel__footer-group">
          <button class="btn btn--secondary" id="rem-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="rem-save">${t('common.save')}</button>
        </div>
      </div>`,
    size: 'md',
    onSave(panel) {
      panel.querySelector('#rem-cancel')?.addEventListener('click', () => closeModal());

      panel.addEventListener('change', (e) => {
        if (e.target.dataset.role !== 'reminder-enabled') return;
        const row = e.target.closest('.waste-reminder-setting-row');
        row.querySelector('.waste-reminder-setting-row__fields').hidden = !e.target.checked;
      });

      panel.querySelector('#rem-save')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#rem-save');
        const stopLoading = btnLoading(btn);
        const modalContext = captureModalContext();
        try {
          for (const row of panel.querySelectorAll('.waste-reminder-setting-row')) {
            const typeId = Number(row.dataset.typeId);
            const original = settings.find((s) => s.type_id === typeId);
            const enabled = row.querySelector('[data-role="reminder-enabled"]').checked;
            const offsetDays = Number(row.querySelector('[data-role="reminder-offset"]').value);
            const deliveryTime = row.querySelector('[data-role="reminder-time"]').value;
            if (original.enabled === enabled && original.offset_days === offsetDays && original.delivery_time === deliveryTime) continue;
            await api.put(`/waste/reminder-settings/${typeId}`, { enabled, offset_days: offsetDays, delivery_time: deliveryTime });
          }
          closeModal({ force: true, context: modalContext });
          window.yuvomi?.showToast(t('waste.reminderSettingsSavedToast'), 'success');
        } catch (err) {
          stopLoading();
          reportError(err);
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// Occurrence move / skip / restore
// -------------------------------------------------------------------------

/**
 * "Termin fuer „Restmuell“ gespeichert." (Critique R24, G2-Quer-P2-2): der Satz
 * nennt die Abfallart, um deren Termin es ging - "Termin gespeichert" sagte
 * nach Anlegen, Verschieben und Auslassen dasselbe. Ohne Namen bleibt er kurz.
 * @param {string|null|undefined} name
 */
function scheduleSavedSentence(name) {
  return name ? t('waste.scheduleSavedNamed', { name }) : t('waste.scheduleSavedToast');
}

function findScheduleOrigin(occurrenceKey, occurrences = state.occurrences) {
  const occ = occurrences.find((o) => o.key === occurrenceKey);
  const origin = occ?.origins.find((o) => o.kind === 'schedule');
  if (!occ || !origin) return null;
  return { occ, scheduleId: origin.schedule_id, originalDate: origin.original_date ?? occ.date_key };
}

async function moveOccurrence(occurrenceKey) {
  const found = findScheduleOrigin(occurrenceKey);
  if (!found) return;

  const content = `
    <div class="form-group">
      <label class="form-label" for="wmm-date">${t('waste.moveNewDateLabel')}</label>
      <yuvomi-datepicker required id="wmm-date" name="date" type="date" value="${esc(found.occ.date_key)}"></yuvomi-datepicker>
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div></div>
      <div class="modal-panel__footer-group">
        <button class="btn btn--secondary" id="wmm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wmm-save">${t('common.save')}</button>
      </div>
    </div>`;

  openModal({
    title: t('waste.moveModalTitle'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wmm-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('#wmm-save').addEventListener('click', async () => {
        const newDate = panel.querySelector('#wmm-date').value;
        const modalContext = captureModalContext();
        try {
          await api.put(`/waste/schedules/${found.scheduleId}/overrides/${found.originalDate}`, { replacement_date: newDate });
          closeModal({ force: true, context: modalContext });
          await reloadAfterSave(() => reloadAndRender());
          refocusAfterRender();
          window.yuvomi?.showToast(scheduleSavedSentence(found.occ.type_name), 'success');
        } catch (err) {
          reportError(err);
        }
      });
    },
  });
}

async function skipOccurrence(occurrenceKey) {
  const found = findScheduleOrigin(occurrenceKey);
  if (!found) return;
  const ok = await confirmModal(t('waste.skipConfirm'), { confirmLabel: t('waste.skipAction') });
  if (!ok) return;
  try {
    await api.put(`/waste/schedules/${found.scheduleId}/overrides/${found.originalDate}`, { replacement_date: null });
    await reloadAfterSave(() => reloadAndRender());
    refocusAfterRender();
    window.yuvomi?.showToast(scheduleSavedSentence(found.occ.type_name), 'success');
  } catch (err) {
    reportError(err);
  }
}

async function restoreOccurrence(occurrenceKey) {
  const found = findScheduleOrigin(occurrenceKey);
  if (!found) return;
  try {
    await deleteOrAlreadyGone(`/waste/schedules/${found.scheduleId}/overrides/${found.originalDate}`, 'waste_override_not_found');
    await reloadAndRender();
    window.yuvomi?.showToast(scheduleSavedSentence(found.occ.type_name), 'success');
  } catch (err) {
    reportError(err);
  }
}

// -------------------------------------------------------------------------
// Page shell
// -------------------------------------------------------------------------

function renderPage() {
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', renderAppPage({
    // Flaeche mit Spalten (DESIGN.md, Breitenregel, R16): der Kopf endet an
    // der Modulkante, die Abholungen stehen links auf dem Lesemass, Abfallarten
    // und Quellen ab der Split-Schwelle rechts daneben.
    mode: 'dashboard',
    className: 'waste-page app-page--columns',
    legacyAlias: false,
    header: renderPageHeader({
      narrow: true,
      // Mobil stehen die Werkzeuge am Ende der Titelzeile (Kopfregel mobil 1a):
      // dort traegt der Kopf nur das „..." - siehe den Menue-Eintrag unten.
      titleTools: true,
      title: renderPageTitle(t('waste.title')),
      // ALLE VIER schreiben, auch die Erinnerungen: das zentrale Gate an
      // /api/v1 entscheidet nach METHODE, und `PUT /waste/reminder-settings/:id`
      // endet fuer einen Nur-lesen-Nutzer genauso im 403 wie ein neuer Typ.
      // Ohne diese Bedingung stand hier eine voll bedienbare Werkzeugleiste,
      // deren vier Dialoge sich oeffnen und ausfuellen liessen, bevor der
      // Server sie abwies.
      //
      // UEBERLAUFMENUE STATT VIER KNOEPFE: die vier beschrifteten Knoepfe
      // passten in KEINE Breite. Bei 390px zeigte der Kopf nur die ersten
      // zwei („Datei importieren", „URL-Quelle hinzufuegen"); die anderen
      // beiden lagen hinter der Viewport-Kante, die `main.app-content`
      // wegschneidet - unsichtbar, nicht harmlos, und nur durch Drehen des
      // Geraets erreichbar (Nutzerbefund 2026-09-09). Und selbst bei 1440px
      // blieb vom Titel „Ents..." uebrig, weil `page-toolbar--narrow` die
      // Zeile auf --page-measure deckelt, nicht auf die Fensterbreite: die
      // vier Knoepfe brauchen mehr als das Lesemass hergibt.
      // Genau dieser Fall ist der dokumentierte Daseinsgrund von
      // utils/popover-menu.js („eine Zeile Chrome statt drei, und jeder
      // Eintrag traegt sein Label"), das die Einkaufsliste schon benutzt.
      // Die Eintraege tragen `data-action`, also faengt sie der delegierte
      // Klick-Handler unten mit - keine zweite Verdrahtung, keine eigenen IDs.
      //
      // EIN SICHTBARER, BESCHRIFTETER WEG ZUR ERSTEN ABFALLART (Audit UX,
      // 2026-09-12). Vorher lagen ALLE vier Aktionen hinter dem unbeschrifteten
      // „...", und der einzige beschriftete Weg ins Modul war der FAB - der
      // aber „Abholung" anlegt, die SELTENSTE der vier. Eine frische
      // Installation zeigte damit keinen einzigen sichtbaren Weg zur ersten
      // Abfallart, ohne die man auch keine Abholung eintragen kann.
      // „Abfallart hinzufuegen" steht deshalb beschriftet im Kopf; im
      // Ueberlaufmenue ist der Eintrag dafuer ENTFALLEN - zweimal derselbe Weg
      // macht die Wahl schwerer, nicht leichter.
      //
      // SEKUNDAER, NICHT PRIMAER - und das ist keine Abschwaechung, sondern die
      // Folge davon, wo dieser Knopf landet. Ab 1024px dockt der FAB in
      // DIESELBE Werkzeugleiste (dockFabIntoToolbar in router.js) und rendert
      // dort als gefuellte Primaerpille „Abholung". Als `btn--primary` standen
      // hier also zwei gefuellte Violettknoepfe Kante an Kante, und die Seite
      // sagte nicht mehr, welcher der Hauptweg ist (Browser-Pruefung am
      // gebauten Stand). Die Eine-Stimme-Regel (DESIGN.md) laesst pro Ansicht
      // genau eine Primaeraktion zu; der angedockte FAB ist sie. Sichtbarkeit
      // und Beschriftung - worum es dem Befund ging - kosten das nichts:
      // `btn--secondary` ist ein voll sichtbarer Knopf mit Rahmen und Text,
      // kein verstecktes Menue. Keine automatische Pruefung hat das gefangen,
      // weil beide Knoepfe je fuer sich regelkonform sind - erst ihre
      // Nachbarschaft ist der Fehler.
      //
      // BEWUSST OHNE `toolbar-new-btn`. Diese Klasse ist NICHT „ein Knopf im
      // Kopf", sondern die Zeigergeraet-Fassung DESSELBEN Wegs, den der FAB am
      // Finger anbietet: layout.css blendet unter ihr ab 1024px per
      // `body:has(.toolbar-new-btn:not([hidden])) #fab-layer .page-fab` den FAB
      // aus, und der Audit erzwingt die Beschriftung aus `newLabel.*` - dem
      // Register, mit dem der FAB andockt. Hier sind es aber ZWEI verschiedene
      // Aktionen: der FAB legt eine Abholung an, dieser Knopf eine Abfallart.
      // Mit der Klasse waere „Abholung" am Desktop ersatzlos verschwunden -
      // ein groesserer Schaden als der, den dieser Knopf behebt.
      actions: readOnly() ? '' : renderPageActions([
        // DAS WERKZEUGMENUE DES KOPFS (R24, G0 Inv-3): `pageToolsMenuHtml`
        // wie jedes Modul, nicht der nackte Menue-Ausloeser - so traegt der
        // Knopf die Kennklasse `page-tools-btn`, an der Shell und Guards das
        // eine „..." eines Kopfs erkennen.
        pageToolsMenuHtml({
          id: 'waste-page-menu',
          label: t('waste.moreActions'),
          items: [
            // DIE ABFALLART STEHT NACH DER ERSTEN IM MENUE (R23 D14, Critique
            // G2 Frage 3). Bis R23 stand ab 768px ein beschrifteter Kopfknopf
            // „Abfallart hinzufuegen" neben dem Primaerknopf „Termin" - zwei
            // Anlegewege im Kopf, und der seltenere war der breitere. Eine
            // Abfallart legt ein Haushalt drei-, viermal an; danach ist sie
            // ein Werkzeug. Im Onboarding traegt der FAB den Weg (waste.css).
            { action: 'add-type', label: t('waste.addType'), icon: 'plus' },
            // Die Einzelabholung ist die Ausnahme zum Termin, den der
            // Primaerknopf anlegt (Entscheidung R17, E2) - ein Werkzeug, kein
            // Hauptweg. Der Kopf entsteht VOR dem Laden und wird danach nicht
            // neu gebaut: der Eintrag steht deshalb immer im Markup, und
            // waste.css nimmt ihn heraus, solange keine Abfallart aktiv ist
            // (pageModeClasses(): keine oder nur archivierte).
            { action: 'add-pickup', label: t('waste.addPickup'), icon: 'calendar-plus' },
            { action: 'open-import', label: t('waste.importFileAction'), icon: 'upload' },
            { action: 'open-url-source', label: t('waste.addUrlSourceAction'), icon: 'link' },
            { action: 'open-reminder-settings', label: t('waste.reminderSettingsAction'), icon: 'bell' },
          ],
        }),
      ].join('\n')),
    }),
    body: renderPageBody({
      content: renderPageColumns({
        main: renderListSection({
          className: 'waste-upcoming-section',
          content: `<h2 class="waste-section-title u-section-title">${t('waste.upcomingSectionTitle')}</h2><div class="row-carrier" id="waste-upcoming-list"></div>`,
        }),
        rail: [
          renderListSection({
            className: 'waste-types-section',
            content: `<h2 class="waste-section-title u-section-title">${t('waste.typesSectionTitle')}</h2><div id="waste-types-list"></div>`,
          }),
          renderListSection({
            className: 'waste-sources-section',
            content: `<h2 class="waste-section-title u-section-title">${t('waste.sourcesSectionTitle')}</h2><div class="row-carrier" id="waste-sources-list"></div>`,
          }),
        ].join('\n'),
      }),
    }),
    trailing: `
      <button class="page-fab" id="waste-fab-new-pickup" aria-label="${esc(t('waste.addSchedule'))}" data-dock-label="${t('newLabel.wasteSchedule')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>`,
  }));

  renderUpcoming();
  renderTypes();
  renderSources();
  if (window.lucide) window.lucide.createIcons({ el: _container });
}

function bindEvents() {
  // Positionierung, Esc/Light-Dismiss-Nachpflege und Menue-Tastatur der
  // Zeilenmenues. `_container` ueberlebt jedes Re-Render, und die Funktion ist
  // ueber ein data-Attribut idempotent - dieselbe Verdrahtung wie in
  // shopping.js/recipes.js/health.js.
  installPopoverMenus(_container);
  // Die vier Kopf-Aktionen brauchen hier KEINE eigene Verdrahtung mehr: sie
  // stehen als `data-action`-Eintraege im Ueberlaufmenue und laufen durch
  // denselben delegierten Handler wie die Zeilen-Aktionen - inklusive des
  // Nur-lesen-Riegels, den dieser Handler ohnehin zieht.
  // Der FAB liegt in der Shell-Layer, nicht in `_container`; CSS blendet ihn
  // ueber html[data-module-readonly] aus (layout.css). Der Handler bleibt
  // trotzdem gesperrt - ausgeblendet ist nicht dasselbe wie unerreichbar.
  // Die Aktion des FAB haengt am Zustand (fabIntent) und wird deshalb nach
  // jedem Laden in applyPageMode() gesetzt - ueber setPageFabAction(), damit
  // der am Desktop angedockte Knopf sein Nomen mitzieht. Bis dahin (Skelett)
  // legt er an, was der Stand hergibt. SACKGASSE BEHOBEN (Audit UX,
  // 2026-09-12), jetzt ohne Umleitungs-Toast (Re-Critique 2026-09-28): ohne
  // Abfallart heisst der FAB "Abfallart" und oeffnet genau diesen Dialog;
  // vorher hiess er "Abholung", und der erklaerende Toast legte sich ueber das
  // Namensfeld des Dialogs.
  applyPageMode();

  // The three `role="button" tabindex="0"` rows (edit-type, edit-schedule,
  // open-source) are a div, not a real <button> - unlike the app's own
  // convention elsewhere, they carried no keyboard activation of their own.
  // Enter/Space now trigger the SAME click the row's own data-action would,
  // rather than duplicating the dispatch logic below a second time.
  _container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[role="button"]');
    if (!row) return;
    e.preventDefault();
    row.click();
  });

  _container.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (!action) return;
    const kind = action.dataset.action;
    // Der eine Riegel fuer alle Zeilen-Aktionen (siehe READ_SAFE_ACTIONS): die
    // Markup-Unterdrueckung oben nimmt die Affordanz weg, das hier nimmt auch
    // dem uebrig gebliebenen Knoten die Wirkung.
    if (readOnly() && !READ_SAFE_ACTIONS.has(kind)) return;

    if (kind === 'edit-type') {
      const type = typeById(Number(action.dataset.id));
      if (type) openTypeModal(type);
    } else if (kind === 'move-type-up') {
      moveType(Number(action.dataset.id), 'up');
    } else if (kind === 'move-type-down') {
      moveType(Number(action.dataset.id), 'down');
    } else if (kind === 'add-schedule') {
      // Ohne Art (die Zeile "Ohne Termin" fuer mehrere Arten): der Dialog
      // fragt nach der Art, vorbelegt mit der ersten ohne Termin.
      if (!action.dataset.typeId) { openScheduleModal(null); return; }
      const type = typeById(Number(action.dataset.typeId));
      if (type) openScheduleModal(type);
    } else if (kind === 'edit-schedule') {
      const schedule = state.schedules.find((s) => s.id === Number(action.dataset.id));
      const type = schedule && typeById(schedule.type_id);
      if (schedule && type) openScheduleModal(type, schedule);
    } else if (kind === 'move-occurrence') {
      moveOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'skip-occurrence') {
      skipOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'restore-occurrence') {
      restoreOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'edit-pickup') {
      loadPickupAndEdit(Number(action.dataset.id));
    } else if (kind === 'delete-pickup') {
      deletePickup(Number(action.dataset.id), typeById(Number(action.closest('.waste-occurrence-row')?.dataset.typeId))?.name ?? null);
    } else if (kind === 'open-source') {
      loadSourceAndOpen(Number(action.dataset.id));
    } else if (kind === 'reimport-source') {
      const source = state.sources.find((s) => s.id === Number(action.dataset.id));
      if (source) openImportWizard(source);
    } else if (kind === 'refresh-source') {
      triggerManualRefresh(Number(action.dataset.id));
    } else if (kind === 'review-source-mapping') {
      const source = state.sources.find((s) => s.id === Number(action.dataset.id));
      if (source) openImportWizard(source);
    } else if (kind === 'toggle-upcoming-rest') {
      state.upcomingExpanded = !state.upcomingExpanded;
      renderUpcoming();
    } else if (kind === 'open-import') {
      openImportWizard();
    } else if (kind === 'open-url-source') {
      openUrlSourceWizard();
    } else if (kind === 'open-reminder-settings') {
      openReminderSettingsModal();
    } else if (kind === 'add-type') {
      openTypeModal();
    } else if (kind === 'add-pickup') {
      // Nur archivierte Abfallarten: der Dialog haette nichts zu waehlen.
      // Der Eintrag ist in dem Zustand ausgeblendet (pageModeClasses()); das
      // hier bleibt die Linie dahinter fuer einen Aufruf ohne Menue.
      if (fabIntent(state).creates === 'type') openTypeModal();
      else openPickupModal();
    } else if (kind === 'create-preset-type') {
      createPresetType(action.dataset.preset, action);
    }
  });
}

async function loadPickupAndEdit(id) {
  try {
    const res = await api.get(`/waste/pickups/${id}`);
    openPickupModal(res.data);
  } catch (err) {
    reportError(err);
  }
}

async function deletePickup(id, typeName = null) {
  // Der Name VOR dem Loeschen: danach steht die Abholung nicht mehr in der Liste.
  // Die Zeile reicht ihre Art mit; sonst die Abholung im Stand.
  const occ = state.occurrences.find((o) => o.origins?.some((x) => x.kind === 'one_off' && x.one_off_id === id));
  const name = typeName ?? occ?.type_name ?? typeById(occ?.type_id)?.name ?? '';
  const ok = await confirmModal(t('waste.pickupDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.pickupDeleteConfirmDetail') });
  if (!ok) return;
  try {
    await deleteOrAlreadyGone(`/waste/pickups/${id}`, 'waste_pickup_not_found');
    await reloadAndRender();
    refocusAfterRender();
    window.yuvomi?.showToast(t('waste.pickupDeletedNamed', { name }), 'success');
  } catch (err) {
    reportError(err);
  }
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure parse of the `?type=<id>&date=<YYYY-MM-DD>` deep-link contract (Phase 0). */
function parseDeepLinkParams(search) {
  const params = new URLSearchParams(search);
  const typeId = Number(params.get('type'));
  const rawDate = params.get('date');
  const date = rawDate && DATE_KEY_RE.test(rawDate) ? rawDate : null;
  return { typeId: Number.isInteger(typeId) && typeId > 0 ? typeId : null, date };
}

/** Pure selector-building for the deep-link target: an occurrence row if a date is given, else the type's card. */
function deepLinkSelectors({ typeId, date }) {
  if (!typeId) return null;
  return {
    rowSelector: date ? `.waste-occurrence-row[data-type-id="${typeId}"][data-date="${date}"]` : null,
    cardSelector: `.waste-type-card[data-type-id="${typeId}"]`,
  };
}

/**
 * Highlights the matching upcoming row when it's within the loaded window;
 * otherwise falls back to highlighting the type's own card, since the
 * occurrence may be outside the 90-day upcoming window this page loads by
 * default.
 */
function applyDeepLink() {
  const selectors = deepLinkSelectors(parseDeepLinkParams(window.location.search));
  if (!selectors) return;

  const row = selectors.rowSelector ? _container.querySelector(selectors.rowSelector) : null;
  const target = row || _container.querySelector(selectors.cardSelector);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('waste-deep-link-highlight');
    setTimeout(() => target.classList.remove('waste-deep-link-highlight'), 2000);
  }
}

export async function render(container, { signal: routeSignal = null } = {}) {
  // Two axes, one controller (#976/#977, same idiom as dashboard.js): the
  // router's own signal falls when this page is left; this page's own
  // controller falls on its NEXT render() (a rapid back-and-forth navigation
  // before the first load() resolves). Everything this render wires hangs off
  // `signal`, not the module field - a superseded render must never register
  // against a newer one's controller.
  if (routeSignal?.aborted) return;
  _pageController?.abort();
  const controller = createPageController(routeSignal);
  _pageController = controller;
  const { signal } = controller;

  _container = container;
  state = { types: [], schedules: [], occurrences: [], sources: [], loading: true, error: null, upcomingExpanded: false };
  renderPage();
  _container.querySelector('.waste-page')?.classList.add('waste-page--loading');
  bindEvents();

  await loadData();
  // A stale load: the page was left, or a second render() already started,
  // while this one's requests were in flight (M-13 der Auditrunde -
  // `waste.js` ignorierte bisher als einzige Seite ausser dashboard.js den
  // Lebenszyklus-Vertrag aus router.js; ein spaetes Zurueckkommen liess die
  // AELTERE Antwort die FRISCHERE ueberschreiben). Draw nothing for it.
  if (signal.aborted) return;
  state.loading = false;

  if (state.error) {
    _container.querySelector('.waste-page')?.classList.remove('waste-page--loading');
    const host = _container.querySelector('#waste-upcoming-list');
    if (host) mountLoadError(host, { title: t('waste.loadErrorTitle'), error: state.error, onRetry: () => reloadAndRender() });
    return;
  }

  // A deep link into a date beyond each type's own visible row must not land
  // on a hidden one - expand the "rest" disclosure first if it lives there.
  if (deepLinkNeedsExpand(state.occurrences, parseDeepLinkParams(window.location.search))) {
    state.upcomingExpanded = true;
  }
  renderUpcoming();
  renderTypes();
  renderSources();
  applyPageMode();
  applyDeepLink();
}

export const __test = {
  // R17/E2: wann eine Abholung ist, was unter einer Abfallart ohne Termin
  // steht, und welche Abfallart der Termin-Dialog des Primaerknopfs vorschlaegt.
  pickupWhenLabel, typeWithoutScheduleLine, defaultScheduleType, occurrenceRowHtml,
  // R17/E6: die Wochentage des Termin-Dialogs als Chips.
  weekdayPickerHtml, weekdayPickerValue, intervalStepperHtml, wireIntervalStepper,
  findScheduleOrigin, parseDeepLinkParams, deepLinkSelectors, recurrenceSummary, originBadges,
  defaultLabelSelection, unresolvedBlockingDiagnostics, buildMappingDecisions, sourceHealthBadgeInfo,
  // #2273: die Abfallarten eines Labels als Chips.
  labelTypeChipsHtml, labelTypesValue, mappingTypesChanged, importLabelRowHtml, sourceMappingRowHtml,
  splitUpcomingByType, deepLinkNeedsExpand, nearestOrdinalAnchorDateKey,
  // Die drei Zeilenbauer und die Palette: seit der Vereinheitlichung der
  // Zeilengrammatik (Audit UX 2026-09-12) tragen sie Bedingungen, die man
  // nicht mehr am Markup ablesen kann - welcher Eintrag bei welcher Position
  // im Menue steht, und dass die Preset-Farben allesamt im Raster liegen.
  typeCardHtml, scheduleRowHtml, sourceRowHtml, TYPE_PRESETS, typeWithoutScheduleHtml, remainingTypePresets, remainingPresetsHtml, WASTE_TYPE_COLORS,
  // R24 (G2-Entsorgung-P2-1/P3-2): Wochentag aus der ersten Abholung, leere Arten in einer Zeile.
  weekdayCodeOf, isUnscheduledType, unscheduledTypesHtml,
  isOnboarding, onboardingHtml, sectionVisibility, fabIntent, pageModeClasses,
  importErrorText,
  // #1909: die echten Aufrufer hinter den Fehler-Toasts, fuer test:waste-errors.
  state: () => state,
  setStateForTest(patch) { Object.assign(state, patch); },
  setContainerForTest(container) { _container = container; },
  reportError, reloadAndRender, deleteOrAlreadyGone,
  moveType, createPresetType, openTypeModal, openScheduleModal, openPickupModal, openSourceModal,
  loadSourceAndOpen, loadPickupAndEdit, deletePickup, openReminderSettingsModal,
  moveOccurrence, skipOccurrence, restoreOccurrence, exportMappingProfileFile,
  openImportWizard, openUrlSourceWizard, openMappingProfileImportModal, triggerManualRefresh,
};
