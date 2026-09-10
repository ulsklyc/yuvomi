/**
 * Page: Waste collection (#1063)
 * Purpose: manage waste types and their weekly/monthly pickup schedules, move
 *          or skip a single calculated occurrence, record one-off pickups,
 *          and show upcoming pickups. Import/URL sources, the Dashboard
 *          widget, and the Calendar layer are later phases - this page only
 *          talks to the manual-domain endpoints (/waste/types, /schedules,
 *          .../overrides, /pickups, /occurrences).
 */

import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { todayKey, addLocalDays } from '/utils/date.js';
import { openModal, closeModal, confirmModal, confirmOverModal, btnLoading, refocusAfterRender } from '/components/modal.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import {
  renderAppPage, renderPageHeader, renderPageTitle, renderPageBody,
  renderPageActions, renderListSection,
} from '/utils/page-layout.js';
import { findPageFab } from '/utils/fab.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { createPageController } from '/utils/page-lifecycle.js';

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

/** Same nth/last-weekday-of-month math as recurrence.js's own nthWeekdayOfMonth, for anchor pre-fill only. */
function nthWeekdayOfMonthUTC(year, month, weekday, ordinal) {
  if (ordinal === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const diff = (last.getUTCDay() - weekday + 7) % 7;
    return new Date(Date.UTC(year, month, last.getUTCDate() - diff));
  }
  const first = new Date(Date.UTC(year, month, 1));
  const diff = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + diff + (ordinal - 1) * 7));
}
const TYPE_PRESETS = [
  { key: 'general', icon: 'trash-2', color: '#64748B' },
  { key: 'recycling', icon: 'recycle', color: '#2563EB' },
  { key: 'organic', icon: 'leaf', color: '#16A34A' },
  { key: 'paper', icon: 'newspaper', color: '#D97706' },
  { key: 'glass', icon: 'wine', color: '#059669' },
  { key: 'bulky', icon: 'armchair', color: '#7C3AED' },
];

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
    parts.push(`<span class="waste-badge waste-badge--moved">${esc(t('waste.movedFromBadge', { date: original ? formatDate(original) : '' }))}</span>`);
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
  const actions = (readOnly() || !menuItems) ? '' : `
      <div class="row-actions">
        <button type="button" class="row-action" popovertarget="${menuId}" aria-label="${esc(t('waste.moreActions'))}">
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

  return `
    <div class="list-row waste-occurrence-row" data-key="${esc(occurrence.key)}" data-type-id="${occurrence.type_id}" data-date="${esc(occurrence.date_key)}">
      <div class="list-row__main">
        <i data-lucide="${esc(occurrence.type_icon || 'trash-2')}" class="waste-occurrence-row__icon" style="color:${esc(occurrence.type_color || '')}" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(occurrence.type_name ?? '')}</span>
          <span class="list-row__meta">${esc(formatDate(occurrence.date_key))} ${originBadges(occurrence)}</span>
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

function renderUpcoming() {
  const host = _container.querySelector('#waste-upcoming-list');
  if (!host) return;
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
      <div class="list-rows" id="waste-upcoming-rest"${expanded ? '' : ' hidden'}>
        ${rest.map(occurrenceRowHtml).join('')}
      </div>
    `);
  }
  if (window.lucide) window.lucide.createIcons({ el: host });
}

// -------------------------------------------------------------------------
// Types & schedules
// -------------------------------------------------------------------------

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
  const next = nextOccurrenceForSchedule(schedule.id);
  // Nur-lesen: die Zeile bleibt LESBAR, verliert aber jede Schreib-Affordanz -
  // auch die des Haupt-Feldes, das sonst als role="button" den Bearbeiten-Dialog
  // oeffnet. Eine Zeile, die aussieht wie ein Knopf, ist ein Versprechen.
  const ro = readOnly();
  return `
    <div class="list-row waste-schedule-row${schedule.active ? '' : ' waste-schedule-row--paused'}" data-id="${schedule.id}">
      <div class="${ro ? 'list-row__main' : 'list-row__main--interactive'}"${ro ? '' : ` data-action="edit-schedule" data-id="${schedule.id}" role="button" tabindex="0"`}>
        <i data-lucide="repeat" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(recurrenceSummary(schedule))}</span>
          <span class="list-row__meta">
            ${schedule.active ? '' : `<span class="waste-badge waste-badge--paused">${esc(t('waste.pausedBadge'))}</span>`}
            ${next ? esc(t('waste.nextPickupLabel')) + ': ' + esc(formatDate(next.date_key)) : esc(t('waste.noUpcomingPickup'))}
          </span>
        </span>
      </div>
      ${ro ? '' : `
        <div class="row-actions">
          <button type="button" class="row-action" data-action="delete-schedule" data-id="${schedule.id}" aria-label="${esc(t('common.delete'))}">
            <i data-lucide="trash-2" aria-hidden="true"></i>
          </button>
        </div>`}
    </div>`;
}

function typeCardHtml(type, index, total) {
  const schedules = schedulesForType(type.id);
  const ro = readOnly();
  return `
    <div class="waste-type-card${type.archived ? ' waste-type-card--archived' : ''}" data-type-id="${type.id}">
      <div class="list-row waste-type-row">
        <div class="${ro ? 'list-row__main' : 'list-row__main--interactive'}"${ro ? '' : ` data-action="edit-type" data-id="${type.id}" role="button" tabindex="0"`}>
          <i data-lucide="${esc(type.icon || 'trash-2')}" style="color:${esc(type.color)}" aria-hidden="true"></i>
          <span class="list-row__body">
            <span class="list-row__name">${esc(type.name)}${type.archived ? ` <span class="waste-badge">${esc(t('waste.archived'))}</span>` : ''}</span>
          </span>
        </div>
        ${ro ? '' : `
          <div class="row-actions">
            <button type="button" class="row-action" data-action="move-type-up" data-id="${type.id}" aria-label="${esc(t('waste.moveTypeUp'))}"${index === 0 ? ' disabled' : ''}>
              <i data-lucide="chevron-up" aria-hidden="true"></i>
            </button>
            <button type="button" class="row-action" data-action="move-type-down" data-id="${type.id}" aria-label="${esc(t('waste.moveTypeDown'))}"${index === total - 1 ? ' disabled' : ''}>
              <i data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <button type="button" class="row-action" data-action="add-schedule" data-type-id="${type.id}" aria-label="${esc(t('waste.addSchedule'))}">
              <i data-lucide="plus" aria-hidden="true"></i>
            </button>
          </div>`}
      </div>
      <div class="waste-schedule-list">
        ${schedules.length ? schedules.map(scheduleRowHtml).join('') : `<p class="waste-schedule-list__empty">${esc(t('waste.noSchedulesYet'))}</p>`}
      </div>
    </div>`;
}

function renderTypes() {
  const host = _container.querySelector('#waste-types-list');
  if (!host) return;
  if (state.loading) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3, lines: 2 }));
    return;
  }
  if (!state.types.length) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', emptyStateHTML({
      title: t('waste.emptyTypesTitle'),
      description: t('waste.emptyTypesDescription'),
      // Auch der Leerzustand darf einem Nur-lesen-Nutzer keinen Anlege-Knopf
      // anbieten - er ist derselbe Weg wie der Kopfknopf, nur an anderer Stelle.
      action: readOnly() ? null : { label: t('waste.addType'), icon: 'plus', attrs: { id: 'waste-empty-add-type' } },
    }));
    host.querySelector('#waste-empty-add-type')?.addEventListener('click', () => openTypeModal());
    if (window.lucide) window.lucide.createIcons({ el: host });
    return;
  }
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', state.types.map((type, index) => typeCardHtml(type, index, state.types.length)).join(''));
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
    ? `${esc(formatDate(source.coverage_start))} – ${esc(formatDate(source.coverage_end))}`
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
  return `
    <div class="list-row waste-source-row" data-source-id="${source.id}">
      <div class="list-row__main--interactive" data-action="open-source" data-id="${source.id}" role="button" tabindex="0">
        <i data-lucide="${isUrl ? 'link' : 'file-text'}" aria-hidden="true"></i>
        <span class="list-row__body">
          <span class="list-row__name">${esc(source.name)} ${badge ? `<span class="waste-badge waste-badge--${badge.code}">${esc(t(badge.labelKey))}</span>` : ''}</span>
          <span class="list-row__meta">${coverage}</span>
        </span>
      </div>
      ${readOnly() ? '' : `
        <div class="row-actions">
          <button type="button" class="row-action" data-action="${rowAction.action}" data-id="${source.id}" aria-label="${esc(t(rowAction.labelKey))}">
            <i data-lucide="${rowAction.icon}" aria-hidden="true"></i>
          </button>
        </div>`}
    </div>`;
}

function renderSources() {
  const host = _container.querySelector('#waste-sources-list');
  if (!host) return;
  if (state.loading) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 2, lines: 2 }));
    return;
  }
  if (!state.sources.length) {
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', emptyStateHTML({
      title: t('waste.emptySourcesTitle'),
      description: t('waste.emptySourcesDescription'),
    }));
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
}

/**
 * Reorders by swapping sort_order with the adjacent type - no drag library
 * needed, and this is never the only path to reordering (up/down buttons are
 * themselves the keyboard-operable path, matching category-manager.js's
 * "drag is never the only way" convention).
 */
async function moveType(id, direction) {
  const index = state.types.findIndex((t2) => t2.id === id);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= state.types.length) return;
  const a = state.types[index];
  const b = state.types[swapWith];
  try {
    await api.put(`/waste/types/${a.id}`, { sort_order: b.sort_order });
    await api.put(`/waste/types/${b.id}`, { sort_order: a.sort_order });
    await reloadAndRender();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
  const chosen = await openIconPicker(hidden.value || null, { suggestions: TYPE_ICON_SUGGESTIONS });
  if (chosen === undefined) return;
  hidden.value = chosen ?? '';
  setTypeIconButtonIcon(button, chosen);
}

function openTypeModal(type = null) {
  const isEdit = !!type;
  const presetOptions = TYPE_PRESETS.map((p) => `<option value="${p.key}">${esc(t(`waste.preset${p.key.charAt(0).toUpperCase()}${p.key.slice(1)}`))}</option>`).join('');

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
      <label class="form-label" for="wtm-name">${t('waste.typeNameLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
      <input type="text" class="form-input" id="wtm-name" maxlength="100" value="${esc(isEdit ? type.name : '')}">
    </div>
    <div class="form-group">
      <label class="form-label">${t('waste.typeIconLabel')}</label>
      <div id="wtm-icon-wrap">${iconButtonHtml(isEdit ? type.icon : 'trash-2')}</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="wtm-color">${t('waste.typeColorLabel')}</label>
      <input type="color" class="form-input form-input--color" id="wtm-color" value="${esc(isEdit ? type.color : '#22C55E')}">
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div style="display:flex;gap:var(--space-2)">
        ${isEdit ? `
          <button class="btn btn--danger btn--icon" id="wtm-delete" aria-label="${esc(t('common.delete'))}"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i></button>
          <button class="btn btn--secondary btn--icon" id="wtm-archive" aria-label="${esc(type.archived ? t('waste.restoreAction') : t('waste.archiveAction'))}"><i data-lucide="${type.archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i></button>
        ` : '<div></div>'}
      </div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="wtm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wtm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    title: isEdit ? t('waste.editType') : t('waste.newType'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wtm-cancel').addEventListener('click', () => closeModal());
      panel.querySelector('[data-action="pick-type-icon"]').addEventListener('click', (e) => pickTypeIcon(e.currentTarget));

      panel.querySelector('#wtm-preset')?.addEventListener('change', (e) => {
        const preset = TYPE_PRESETS.find((p) => p.key === e.target.value);
        if (!preset) return;
        panel.querySelector('#wtm-name').value = t(`waste.preset${preset.key.charAt(0).toUpperCase()}${preset.key.slice(1)}`);
        panel.querySelector('#wtm-color').value = preset.color;
        const hidden = panel.querySelector('input[name="icon"]');
        hidden.value = preset.icon;
        setTypeIconButtonIcon(panel.querySelector('[data-action="pick-type-icon"]'), preset.icon);
      });

      panel.querySelector('#wtm-archive')?.addEventListener('click', async () => {
        try {
          await api.put(`/waste/types/${type.id}`, { archived: !type.archived });
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(type.archived ? t('waste.typeRestoredToast') : t('waste.typeArchivedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      panel.querySelector('#wtm-delete')?.addEventListener('click', async () => {
        const ok = await confirmOverModal(t('waste.typeDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.typeDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await api.delete(`/waste/types/${type.id}`);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.typeDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.status === 409 ? t('waste.typeDeleteRefused') : (err.data?.error ?? t('common.unknownError')), 'danger');
        }
      });

      panel.querySelector('#wtm-save').addEventListener('click', async () => {
        const name = panel.querySelector('#wtm-name').value.trim();
        if (!name) { panel.querySelector('#wtm-name').focus(); return; }
        const body = {
          name,
          icon: panel.querySelector('input[name="icon"]').value || 'trash-2',
          color: panel.querySelector('#wtm-color').value,
        };
        try {
          if (isEdit) await api.put(`/waste/types/${type.id}`, body);
          else await api.post('/waste/types', body);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.typeSavedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// Schedule modal
// -------------------------------------------------------------------------

function weekdayPickerHtml(selected) {
  const set = new Set(String(selected ?? '').split(',').filter(Boolean));
  return `<div class="waste-weekday-picker">${WEEKDAY_CODES.map((code) => `
    <label class="waste-weekday-option">
      <input type="checkbox" name="weekday" value="${code}"${set.has(code) ? ' checked' : ''}>
      <span>${esc(t(WEEKDAY_LABEL_KEYS[code]))}</span>
    </label>`).join('')}</div>`;
}

function openScheduleModal(type, schedule = null) {
  const isEdit = !!schedule;
  const kind = schedule?.recurrence_kind ?? 'weekly';
  const isOrdinal = kind === 'monthly_ordinal_weekday';

  const content = `
    <div class="form-group">
      <label class="form-label" for="wsm-kind">${t('waste.recurrenceKindLabel')}</label>
      <select class="form-input" id="wsm-kind">
        <option value="weekly"${kind === 'weekly' ? ' selected' : ''}>${t('waste.recurrenceWeekly')}</option>
        <option value="monthly_fixed_day"${kind === 'monthly_fixed_day' ? ' selected' : ''}>${t('waste.recurrenceMonthly')}</option>
        <option value="monthly_ordinal_weekday"${isOrdinal ? ' selected' : ''}>${t('waste.recurrenceMonthlyOrdinal')}</option>
      </select>
    </div>
    <div class="form-group" id="wsm-weekly-fields" ${kind === 'weekly' ? '' : 'hidden'}>
      <label class="form-label">${t('waste.weekdaysLabel')}</label>
      ${weekdayPickerHtml(schedule?.weekdays)}
    </div>
    <div class="form-group" id="wsm-monthly-fields" ${kind === 'monthly_fixed_day' ? '' : 'hidden'}>
      <label class="form-label" for="wsm-month-day">${t('waste.monthDayLabel')}</label>
      <input type="number" class="form-input" id="wsm-month-day" min="1" max="31" value="${esc(String((schedule?.month_day ?? -1) === -1 ? 1 : schedule.month_day))}">
      <label class="form-check">
        <input type="checkbox" id="wsm-last-day"${schedule?.month_day === -1 ? ' checked' : ''}>
        <span>${t('waste.monthDayLastDay')}</span>
      </label>
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
      <label class="form-label" for="wsm-interval">${t('waste.intervalLabelWeekly')}</label>
      <input type="number" class="form-input" id="wsm-interval" min="1" max="52" value="${esc(String(schedule?.interval ?? 1))}">
    </div>
    <div class="form-group">
      <label class="form-label" for="wsm-anchor">${t('waste.anchorDateLabel')}</label>
      <yuvomi-datepicker required id="wsm-anchor" name="anchor_date" type="date" value="${esc(schedule?.anchor_date ?? todayKey())}"></yuvomi-datepicker>
    </div>
    <div class="form-group">
      <label class="form-label" for="wsm-valid-until">${t('waste.validUntilLabel')}</label>
      <yuvomi-datepicker id="wsm-valid-until" name="valid_until" type="date" value="${esc(schedule?.valid_until ?? '')}"></yuvomi-datepicker>
    </div>
    <div class="form-group">
      <label class="form-check">
        <input type="checkbox" id="wsm-active"${schedule?.active === 0 ? '' : ' checked'}>
        <span>${t('waste.activeLabel')}</span>
      </label>
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div>${isEdit ? `<button class="btn btn--danger btn--icon" id="wsm-delete" aria-label="${esc(t('common.delete'))}"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i></button>` : ''}</div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="wsm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wsm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    title: isEdit ? t('waste.editSchedule') : t('waste.newSchedule'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wsm-cancel').addEventListener('click', () => closeModal());

      const kindSelect = panel.querySelector('#wsm-kind');
      const weeklyFields = panel.querySelector('#wsm-weekly-fields');
      const monthlyFields = panel.querySelector('#wsm-monthly-fields');
      const ordinalFields = panel.querySelector('#wsm-ordinal-fields');
      const ordinalPositionSelect = panel.querySelector('#wsm-ordinal-position');
      const ordinalWeekdaySelect = panel.querySelector('#wsm-ordinal-weekday');
      const anchorInput = panel.querySelector('#wsm-anchor');

      // The anchor must itself BE the chosen ordinal occurrence (server-side
      // invariant, mirrors monthly_fixed_day's own anchor-consistency rule) -
      // recompute it whenever the user changes ordinal/weekday, rather than
      // asking them to find a matching date by hand in a plain datepicker.
      // The nearest such date at or after today, same reasoning as any other
      // "start now" default.
      function nearestOrdinalAnchor(ordinal, weekdayCode) {
        const weekday = DAY_INDEX[weekdayCode];
        const today = new Date(`${todayKey()}T00:00:00Z`);
        const candidateInThisMonth = nthWeekdayOfMonthUTC(today.getUTCFullYear(), today.getUTCMonth(), weekday, ordinal);
        const target = candidateInThisMonth >= today
          ? candidateInThisMonth
          : nthWeekdayOfMonthUTC(today.getUTCFullYear(), today.getUTCMonth() + 1, weekday, ordinal);
        return target.toISOString().slice(0, 10);
      }
      function refreshOrdinalAnchor() {
        if (kindSelect.value !== 'monthly_ordinal_weekday') return;
        anchorInput.value = nearestOrdinalAnchor(Number(ordinalPositionSelect.value), ordinalWeekdaySelect.value);
      }
      ordinalPositionSelect.addEventListener('change', refreshOrdinalAnchor);
      ordinalWeekdaySelect.addEventListener('change', refreshOrdinalAnchor);

      kindSelect.addEventListener('change', () => {
        weeklyFields.hidden = kindSelect.value !== 'weekly';
        monthlyFields.hidden = kindSelect.value !== 'monthly_fixed_day';
        ordinalFields.hidden = kindSelect.value !== 'monthly_ordinal_weekday';
        if (kindSelect.value === 'monthly_ordinal_weekday') refreshOrdinalAnchor();
      });

      panel.querySelector('#wsm-delete')?.addEventListener('click', async () => {
        const ok = await confirmOverModal(t('waste.scheduleDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.scheduleDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await api.delete(`/waste/schedules/${schedule.id}`);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.scheduleDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      panel.querySelector('#wsm-save').addEventListener('click', async () => {
        const kindValue = kindSelect.value;
        const anchor = panel.querySelector('#wsm-anchor').value;
        const validUntil = panel.querySelector('#wsm-valid-until').value || null;
        const interval = Number(panel.querySelector('#wsm-interval').value) || 1;
        const active = panel.querySelector('#wsm-active').checked;

        const body = { type_id: type.id, recurrence_kind: kindValue, anchor_date: anchor, interval, valid_until: validUntil, active };
        if (kindValue === 'weekly') {
          body.weekdays = [...panel.querySelectorAll('input[name="weekday"]:checked')].map((el) => el.value);
        } else if (kindValue === 'monthly_ordinal_weekday') {
          body.month_day = Number(ordinalPositionSelect.value);
          body.weekdays = ordinalWeekdaySelect.value;
        } else {
          const lastDay = panel.querySelector('#wsm-last-day').checked;
          body.month_day = lastDay ? -1 : Number(panel.querySelector('#wsm-month-day').value);
        }

        try {
          if (isEdit) await api.put(`/waste/schedules/${schedule.id}`, body);
          else await api.post('/waste/schedules', body);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.scheduleSavedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
  const typeOptions = state.types.filter((t2) => !t2.archived || (isEdit && t2.id === pickup.type_id))
    .map((t2) => `<option value="${t2.id}"${isEdit && pickup.type_id === t2.id ? ' selected' : ''}>${esc(t2.name)}</option>`).join('');

  const content = `
    <div class="form-group">
      <label class="form-label" for="wpm-type">${t('waste.typeSelectLabel')}</label>
      <select class="form-input" id="wpm-type">${typeOptions}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="wpm-date">${t('waste.pickupDateLabel')}</label>
      <yuvomi-datepicker required id="wpm-date" name="date" type="date" value="${esc(pickup?.date ?? todayKey())}"></yuvomi-datepicker>
    </div>
    <div class="form-group">
      <label class="form-label" for="wpm-note">${t('waste.pickupNoteLabel')}</label>
      <textarea class="form-input" id="wpm-note" maxlength="500">${esc(pickup?.note ?? '')}</textarea>
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div>${isEdit ? `<button class="btn btn--danger btn--icon" id="wpm-delete" aria-label="${esc(t('common.delete'))}"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i></button>` : ''}</div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="wpm-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wpm-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>
    </div>`;

  openModal({
    title: isEdit ? t('waste.editPickup') : t('waste.newPickup'),
    content,
    size: 'sm',
    onSave(panel) {
      panel.querySelector('#wpm-cancel').addEventListener('click', () => closeModal());

      panel.querySelector('#wpm-delete')?.addEventListener('click', async () => {
        const ok = await confirmOverModal(t('waste.pickupDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.pickupDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await api.delete(`/waste/pickups/${pickup.id}`);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.pickupDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
        try {
          if (isEdit) await api.put(`/waste/pickups/${pickup.id}`, body);
          else await api.post('/waste/pickups', body);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.pickupSavedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.status === 409 ? t('waste.pickupDuplicateError') : (err.data?.error ?? t('common.unknownError')), 'danger');
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// ICS import wizard and source management (#1063 Phase 3)
// -------------------------------------------------------------------------

/** Pure: a sensible starting decision for a label - remembered beats suggested beats "create a new type". */
function defaultLabelDecision(label) {
  if (label.remembered_ignored) return '';
  if (label.remembered_type_id) return String(label.remembered_type_id);
  if (label.suggested_type_id) return String(label.suggested_type_id);
  return '__new__';
}

/** Pure: blocking diagnostics not yet covered by an explicit skip. */
function unresolvedBlockingDiagnostics(diagnostics, skippedEventKeys) {
  const skipSet = new Set(skippedEventKeys);
  return diagnostics.filter((d) => d.severity === 'blocking' && !skipSet.has(d.event_key));
}

/**
 * Pure: builds the commit body's `mappings` array from each label row's chosen
 * decision (`'' | '__new__' | '<type id>'`). Returns `{ error, label }` instead
 * of throwing, so the DOM-facing caller can show a field-level message.
 */
function buildMappingDecisions(rows) {
  const mappings = [];
  for (const row of rows) {
    if (row.decision === '__new__') {
      const name = (row.newTypeName || '').trim();
      if (!name) return { error: 'missing_new_type_name', label: row.normalized_label };
      mappings.push({ normalized_label: row.normalized_label, new_type: { name } });
    } else if (row.decision === '') {
      mappings.push({ normalized_label: row.normalized_label, ignored: true });
    } else {
      mappings.push({ normalized_label: row.normalized_label, type_id: Number(row.decision) });
    }
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

/** `diag.message` is the fallback for a code this client doesn't (yet) know - never a blank row. */
function importDiagnosticText(diag) {
  const key = IMPORT_DIAGNOSTIC_LABEL_KEYS[diag.code];
  if (!key) return diag.message;
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

function importLabelRowHtml(label) {
  const decision = defaultLabelDecision(label);
  // Include an archived type only when it's the remembered/suggested decision
  // itself, so a since-archived mapping still renders as a real selected
  // option instead of silently falling back to "ignore" in the live DOM.
  const typeOptions = state.types.filter((t2) => !t2.archived || decision === String(t2.id))
    .map((t2) => `<option value="${t2.id}"${decision === String(t2.id) ? ' selected' : ''}>${esc(t2.name)}</option>`).join('');
  return `
    <div class="waste-import-label-row" data-label="${esc(label.normalized_label)}">
      <span class="waste-import-label-row__name">${esc(label.original_label)} <span class="waste-import-label-row__count">(${label.count})</span></span>
      <select class="form-input" data-role="label-decision-type">
        <option value=""${decision === '' ? ' selected' : ''}>${esc(t('waste.importIgnoreLabel'))}</option>
        ${typeOptions}
        <option value="__new__"${decision === '__new__' ? ' selected' : ''}>${esc(t('waste.importCreateNewType'))}</option>
      </select>
      <input type="text" class="form-input waste-import-new-type-name" data-role="label-new-type-name"
        placeholder="${esc(t('waste.typeNameLabel'))}" value="${esc(label.original_label)}"${decision === '__new__' ? '' : ' hidden'}>
    </div>`;
}

function importPreviewStepHtml(preview) {
  return `
    <p class="waste-import-summary">${esc(t('waste.importSummary', { events: preview.counts.events, candidates: preview.counts.candidates }))}</p>
    ${preview.diagnostics.length ? `<div class="waste-import-diagnostics">${preview.diagnostics.map(importDiagnosticRowHtml).join('')}</div>` : ''}
    ${preview.labels.length
    ? `<div class="waste-import-labels">${preview.labels.map(importLabelRowHtml).join('')}</div>`
    : `<p>${esc(t('waste.importNoLabels'))}</p>`}`;
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
      <div style="display:flex;gap:var(--space-3)">
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

      panel.addEventListener('change', (e) => {
        const select = e.target.closest('[data-role="label-decision-type"]');
        if (!select) return;
        const row = select.closest('.waste-import-label-row');
        row.querySelector('[data-role="label-new-type-name"]').hidden = select.value !== '__new__';
      });

      panel.querySelector('#wiz-preview').addEventListener('click', async () => {
        errorEl.hidden = true;
        let icsText = null;
        if (!isUrlSource) {
          const file = panel.querySelector('#wiz-file').files?.[0];
          if (!file) { showError(t('waste.importNoFileError')); return; }
          try { icsText = await file.text(); } catch { showError(t('waste.importReadError')); return; }
        }

        try {
          const endpoint = isReimport ? `/waste/sources/${source.id}/reimport/preview` : '/waste/import/preview';
          const res = await api.post(endpoint, isUrlSource ? {} : { ics: icsText });
          if (res.data.unchanged) {
            closeModal({ force: true });
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
          showError(err.data?.error ?? t('common.unknownError'));
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
          decision: row.querySelector('[data-role="label-decision-type"]').value,
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

        try {
          const endpoint = isReimport ? `/waste/sources/${source.id}/reimport/commit` : '/waste/import/commit';
          const res = await api.post(endpoint, body);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          const { added, changed, removed } = res.data.diff;
          window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
        } catch (err) {
          showError(err.data?.error ?? t('common.unknownError'));
        }
      });
    },
  });
}

function sourceMappingRowHtml(mapping) {
  const typeOptions = state.types.filter((t2) => !t2.archived || t2.id === mapping.type_id)
    .map((t2) => `<option value="${t2.id}"${t2.id === mapping.type_id ? ' selected' : ''}>${esc(t2.name)}</option>`).join('');
  return `
    <div class="waste-source-mapping-row" data-mapping-id="${mapping.id}">
      <span class="waste-source-mapping-row__label">${esc(mapping.original_label)}</span>
      <select class="form-input" data-role="mapping-type">
        <option value=""${mapping.ignored ? ' selected' : ''}>${esc(t('waste.importIgnoreLabel'))}</option>
        ${typeOptions}
      </select>
    </div>`;
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
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
      window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      return;
    }

    const content = `
      <p>${esc(t('waste.mappingProfileApplicableCount', { count: preview.applicable_count }))}</p>
      <div id="wmp-entries">${preview.entries.map(mappingProfileEntryRowHtml).join('')}</div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <div></div>
        <div style="display:flex;gap:var(--space-3)">
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
          try {
            await api.post(`/waste/sources/${source.id}/mapping-profile/import/commit`, {
              profile, profile_digest: preview.profile_digest,
            });
            closeModal({ force: true });
            await loadSourceAndOpen(source.id);
            refocusAfterRender();
            window.yuvomi?.showToast(t('waste.mappingProfileAppliedToast'), 'success');
          } catch (err) {
            stopLoading();
            window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
      ${source.coverage_start ? `<p>${esc(t('waste.sourceCoverageLabel'))}: ${esc(formatDate(source.coverage_start))} – ${esc(formatDate(source.coverage_end))}</p>` : ''}
      ${source.last_success_at ? `<p>${esc(t('waste.sourceLastImportedLabel'))}: ${esc(formatDate(source.last_success_at.slice(0, 10)))}</p>` : ''}
      ${source.last_error ? `<p class="waste-source-detail__error">${esc(source.last_error)}</p>` : ''}
      ${badge ? `<span class="waste-badge waste-badge--${badge.code}">${esc(t(badge.labelKey))}</span>` : ''}
    </div>
    <h3 class="waste-section-title">
      ${t('waste.sourceMappingsTitle')}
      <span class="waste-section-title__actions">
        <button type="button" class="btn btn--secondary btn--sm" id="wsrc-mapping-profile-export">${t('waste.mappingProfileExportAction')}</button>
        <button type="button" class="btn btn--secondary btn--sm" id="wsrc-mapping-profile-import">${t('waste.mappingProfileImportAction')}</button>
      </span>
    </h3>
    <div id="wsrc-mappings">${source.mappings.map(sourceMappingRowHtml).join('')}</div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <div><button class="btn btn--danger btn--icon" id="wsrc-delete" aria-label="${esc(t('common.delete'))}"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i></button></div>
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="wsrc-reimport">${t(primaryActionKey)}</button>
        <button class="btn btn--secondary" id="wsrc-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wsrc-save">${t('common.save')}</button>
      </div>
    </div>`;

  openModal({
    title: source.name,
    content,
    size: 'md',
    onSave(panel) {
      panel.querySelector('#wsrc-cancel').addEventListener('click', () => closeModal());

      panel.querySelector('#wsrc-mapping-profile-export').addEventListener('click', () => exportMappingProfileFile(source));
      panel.querySelector('#wsrc-mapping-profile-import').addEventListener('click', () => openMappingProfileImportModal(source));

      panel.querySelector('#wsrc-reimport').addEventListener('click', () => {
        closeModal({ force: true });
        if (isUrl && !source.needs_mapping) triggerManualRefresh(source.id);
        else openImportWizard(source);
      });

      panel.querySelector('#wsrc-delete').addEventListener('click', async () => {
        const ok = await confirmOverModal(t('waste.sourceDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.sourceDeleteConfirmDetail') });
        if (!ok) return;
        try {
          await api.delete(`/waste/sources/${source.id}`);
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.sourceDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      panel.querySelector('#wsrc-save').addEventListener('click', async () => {
        const name = panel.querySelector('#wsrc-name').value.trim();
        try {
          if (name && name !== source.name) await api.put(`/waste/sources/${source.id}`, { name });
          for (const row of panel.querySelectorAll('.waste-source-mapping-row')) {
            const mappingId = Number(row.dataset.mappingId);
            const mapping = source.mappings.find((m) => m.id === mappingId);
            const value = row.querySelector('[data-role="mapping-type"]').value;
            const ignored = value === '';
            const typeId = ignored ? null : Number(value);
            if (!!mapping.ignored === ignored && mapping.type_id === typeId) continue;
            await api.put(`/waste/sources/${source.id}/mappings/${mappingId}`, { type_id: typeId, ignored });
          }
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.sourceSavedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    },
  });
}

async function loadSourceAndOpen(id) {
  try {
    const res = await api.get(`/waste/sources/${id}`);
    openSourceModal(res.data);
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
    await reloadAndRender();
    if (res.data.outcome === 'committed') {
      const { added, changed, removed } = res.data.diff;
      window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
    } else if (res.data.outcome === 'needs_mapping') {
      window.yuvomi?.showToast(t('waste.sourceNeedsMappingToast'), 'default');
    } else if (res.data.outcome === 'error') {
      window.yuvomi?.showToast(res.data.source.last_error ?? t('common.unknownError'), 'danger');
    } else {
      window.yuvomi?.showToast(t('waste.sourceUnchangedToast'), 'default');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

/** The refresh-interval field is minutes; keep it inside waste-url-source.js's own bounds so an obviously-wrong value fails client-side with the same message the server would give. */
const URL_SOURCE_MIN_INTERVAL_MINUTES = 60;
const URL_SOURCE_MAX_INTERVAL_MINUTES = 43_200;
const URL_SOURCE_DEFAULT_INTERVAL_MINUTES = 1440;

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
      <div style="display:flex;gap:var(--space-3)">
        <button class="btn btn--secondary" id="wurl-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="wurl-save">${t('common.save')}</button>
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
        try {
          const res = await api.post('/waste/sources', { name, url, refresh_interval_minutes: refreshIntervalMinutes });
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          if (res.data.outcome === 'committed') {
            const { added, changed, removed } = res.data.diff;
            window.yuvomi?.showToast(t('waste.importCommittedToast', { added, changed, removed }), 'success');
          } else if (res.data.outcome === 'needs_mapping') {
            window.yuvomi?.showToast(t('waste.sourceNeedsMappingToast'), 'default');
          } else if (res.data.outcome === 'error') {
            window.yuvomi?.showToast(res.data.source.last_error ?? t('common.unknownError'), 'danger');
          }
        } catch (err) {
          stopLoading();
          showError(err.data?.error ?? t('common.unknownError'));
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
      <label class="waste-reminder-setting-row__enable">
        <input type="checkbox" data-role="reminder-enabled" ${setting.enabled ? 'checked' : ''}>
        <span>${esc(setting.type_name)}</span>
      </label>
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
  let settings;
  try {
    settings = (await api.get('/waste/reminder-settings')).data;
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    return;
  }

  const content = settings.length
    ? `<div id="rem-rows">${settings.map(reminderSettingRowHtml).join('')}</div>`
    : `<p>${esc(t('waste.emptyTypesTitle'))}</p>`;

  openModal({
    title: t('waste.reminderSettingsModalTitle'),
    content: `${content}
      <div class="modal-panel__footer modal-panel__footer--plain">
        <div></div>
        <div style="display:flex;gap:var(--space-3)">
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
          closeModal({ force: true });
          window.yuvomi?.showToast(t('waste.reminderSettingsSavedToast'), 'success');
        } catch (err) {
          stopLoading();
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    },
  });
}

// -------------------------------------------------------------------------
// Occurrence move / skip / restore
// -------------------------------------------------------------------------

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
      <div style="display:flex;gap:var(--space-3)">
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
        try {
          await api.put(`/waste/schedules/${found.scheduleId}/overrides/${found.originalDate}`, { replacement_date: newDate });
          closeModal({ force: true });
          await reloadAndRender();
          refocusAfterRender();
          window.yuvomi?.showToast(t('waste.scheduleSavedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
    await reloadAndRender();
    window.yuvomi?.showToast(t('waste.scheduleSavedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function restoreOccurrence(occurrenceKey) {
  const found = findScheduleOrigin(occurrenceKey);
  if (!found) return;
  try {
    await api.delete(`/waste/schedules/${found.scheduleId}/overrides/${found.originalDate}`);
    await reloadAndRender();
    window.yuvomi?.showToast(t('waste.scheduleSavedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

// -------------------------------------------------------------------------
// Page shell
// -------------------------------------------------------------------------

function renderPage() {
  _container.replaceChildren();
  _container.insertAdjacentHTML('beforeend', renderAppPage({
    mode: 'reading',
    className: 'waste-page',
    legacyAlias: false,
    header: renderPageHeader({
      narrow: true,
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
      // Die primaere Aktion („Abholung") liegt weiter im FAB, und eine leere
      // Seite fuehrt ueber ihren eigenen Empty-State-CTA zur ersten Abfallart.
      actions: readOnly() ? '' : renderPageActions(popoverMenuHtml({
        id: 'waste-page-menu',
        label: t('waste.moreActions'),
        items: [
          { action: 'open-import', label: t('waste.importFileAction'), icon: 'upload' },
          { action: 'open-url-source', label: t('waste.addUrlSourceAction'), icon: 'link' },
          { action: 'open-reminder-settings', label: t('waste.reminderSettingsAction'), icon: 'bell' },
          { action: 'add-type', label: t('waste.addType'), icon: 'plus' },
        ],
      })),
    }),
    body: renderPageBody({
      content: [
        renderListSection({
          className: 'waste-upcoming-section',
          content: `<h2 class="waste-section-title">${t('waste.upcomingSectionTitle')}</h2><div class="list-rows" id="waste-upcoming-list"></div>`,
        }),
        renderListSection({
          className: 'waste-types-section',
          content: `<h2 class="waste-section-title">${t('waste.typesSectionTitle')}</h2><div id="waste-types-list"></div>`,
        }),
        renderListSection({
          className: 'waste-sources-section',
          content: `<h2 class="waste-section-title">${t('waste.sourcesSectionTitle')}</h2><div class="list-rows" id="waste-sources-list"></div>`,
        }),
      ].join('\n'),
    }),
    trailing: `
      <button class="page-fab" id="waste-fab-new-pickup" aria-label="${esc(t('waste.addPickup'))}" data-dock-label="${t('newLabel.waste')}">
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
  findPageFab('waste-fab-new-pickup').addEventListener('click', () => {
    if (readOnly()) return;
    if (!state.types.filter((t2) => !t2.archived).length) {
      window.yuvomi?.showToast(t('waste.addTypeFirstHint'), 'default');
      return;
    }
    openPickupModal();
  });

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
      const type = typeById(Number(action.dataset.typeId));
      if (type) openScheduleModal(type);
    } else if (kind === 'edit-schedule') {
      const schedule = state.schedules.find((s) => s.id === Number(action.dataset.id));
      const type = schedule && typeById(schedule.type_id);
      if (schedule && type) openScheduleModal(type, schedule);
    } else if (kind === 'delete-schedule') {
      const schedule = state.schedules.find((s) => s.id === Number(action.dataset.id));
      if (!schedule) return;
      confirmModal(t('waste.scheduleDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.scheduleDeleteConfirmDetail') }).then(async (ok) => {
        if (!ok) return;
        try {
          await api.delete(`/waste/schedules/${schedule.id}`);
          await reloadAndRender();
          window.yuvomi?.showToast(t('waste.scheduleDeletedToast'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });
    } else if (kind === 'move-occurrence') {
      moveOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'skip-occurrence') {
      skipOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'restore-occurrence') {
      restoreOccurrence(action.closest('.waste-occurrence-row')?.dataset.key);
    } else if (kind === 'edit-pickup') {
      loadPickupAndEdit(Number(action.dataset.id));
    } else if (kind === 'delete-pickup') {
      deletePickup(Number(action.dataset.id));
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
    }
  });
}

async function loadPickupAndEdit(id) {
  try {
    const res = await api.get(`/waste/pickups/${id}`);
    openPickupModal(res.data);
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
  }
}

async function deletePickup(id) {
  const ok = await confirmModal(t('waste.pickupDeleteConfirm'), { danger: true, confirmLabel: t('common.delete'), detail: t('waste.pickupDeleteConfirmDetail') });
  if (!ok) return;
  try {
    await api.delete(`/waste/pickups/${id}`);
    await reloadAndRender();
    window.yuvomi?.showToast(t('waste.pickupDeletedToast'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
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
  applyDeepLink();
}

export const __test = {
  findScheduleOrigin, parseDeepLinkParams, deepLinkSelectors, recurrenceSummary, originBadges,
  defaultLabelDecision, unresolvedBlockingDiagnostics, buildMappingDecisions, sourceHealthBadgeInfo,
  splitUpcomingByType, deepLinkNeedsExpand,
};
