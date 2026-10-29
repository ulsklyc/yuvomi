/**
 * Modul: Dashboard
 * Zweck: Startseite mit Begrüßung, Terminen, Aufgaben, Essen, Notizen und FAB
 * Abhängigkeiten: /api.js
 */

import { api, auth } from '/api.js';
import { createPageController } from '/utils/page-lifecycle.js';
import { canSeeWidget, moduleAccess, navModuleAccess, canUseFasting } from '/permissions.js';
import { todaySheetContext, collectSourceRows, composeTodaySheet, codaAllowed, speakingSourceIds } from '/utils/today-sheet.js';
import { t, formatDate, formatDayMonth, formatTime, timeSuffix, getLocale, getNumberFormat } from '/i18n.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { resolveEventColor } from '/utils/event-color.js';
import { hasEventIcon, eventIconHtml } from '/utils/event-icon.js';
import { compareMembers, sortMembers } from '/utils/member-order.js';
import { buildWeekStrip } from '/utils/week-strip.js';
import { relativeDateLabel, housekeepingSinceLabel } from '/utils/day-label.js';
import { daysFromTodayText, dateText } from '/utils/date-format.js';
import { esc, fmtLocation, renderMarkdownLight } from '/utils/html.js';
import { errorSentence } from '/utils/friendly-error.js';
import { initials } from '/utils/initials.js';
// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { parseLocalDateKey, addLocalDays, todayKey as householdToday } from '/utils/date.js';
import { nowFields, zonedUTCProxy, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { predictCycle, PHASE } from '/utils/health-cycle.js';
import { NUTRIENTS, nutrientProgress } from '/utils/health-nutrition.js';
import { startFasting, finishFasting, startFastingClock, fastingClockSwitchHtml, fastingError } from '/components/fasting-controls.js';
import { localizeBirthdayEvent } from '/utils/birthday-event.js';
import { countdownPhrase, countdownRank } from '/utils/countdown.js';
import { EXPIRY_SOON_DAYS, pantryExpiryPhrase, pantryExpiryTone } from '/utils/pantry-status.js';
import { locationLabel } from '/utils/pantry-locations.js';
import { pantryQuantityLabel } from '/utils/pantry-units.js';
import { findPageFab } from '/utils/fab.js';
import { setLeaveGuard } from '/utils/leave-guard.js';
import { openModal, closeModal, confirmModal, refocusAfterRender, lastInputWasKeyboard } from '/components/modal.js';
import { renderAvatarStack, sharedSurname } from '/components/user-multi-select.js';
import { isSoloHousehold } from '/utils/household.js';
import { toggleRegion, durationToken, easingToken, expandIn } from '/utils/ux.js';
import { swapContent, SWAP_FROM_OPACITY } from '/utils/content-swap.js';
import { brandMarkSvg } from '/utils/brand-mark.js';
import { findSettingsLeaf } from '/settings/registry.js';
import {
  WIDGET_SIZE_PRESETS, WIDGET_SIZE_OPTIONS,
  COCKPIT_COVERED_WIDGETS,
  nearestPreset, sameWidgetConfig, suggestGridHoleFill, fillGridSpans, contentSpanRows, fillRowCount, TILE_GEOMETRY,
  dashboardQuery, dashboardQueryFiltersCounts, dashboardRequest, normalizeShoppingListSelection,
  normalizeCalendarSelection,
  fetchPendingReminders, childDefaultWidgetConfig,
} from '/utils/dashboard-widgets.js';
import { EVENT_LIMIT_STEPS, EVENT_LIMIT_DEFAULT, clampEventLimit } from '/utils/dashboard-event-limit.js';
import {
  allWidgetIds,
  buildDefaultWidgetConfig,
  normalizeDashboardConfigWithExtensions,
  isExtensionWidget,
  getExtensionWidgetMeta,
} from '/utils/extension-widgets.js';
import { widgetDisplayLabel, optionFieldLabel } from '/utils/extension-i18n.js';
import { whoMark } from '/utils/seal-pair.js';
import { MODULE_ICON, moduleIconHTML } from '/nav-icons.js';
import { enterWallMode, exitWallMode, isWallActive, syncWallMode } from '/utils/wall-mode.js';
import { mountZonePrompt } from '/utils/household-zone-hint.js';
import { firstStepsActive, mountFirstSteps, startFirstSteps } from '/utils/first-steps.js';
import { renderWallTimer, wireWallTimer } from '/components/wall-timer.js';
import { rememberLayoutHint, layoutHintTiles, layoutHintQuery, rememberHeadHint, headHint } from '/utils/dashboard-layout-hint.js';
import { emptyHintHTML, cardEmptyRowHtml } from '/utils/empty-state.js';
import { quickLinkHost } from '/utils/quick-link-url.js';
import { hasIcon } from '/utils/lucide-icons.js';
import { prefersInkText } from '/utils/contrast.js';
import { fitMetricLeads } from '/utils/metric-card.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { attachOverlay, pushOverlay, dropOverlay, isOverlayOpen } from '/utils/overlay-history.js';
import { inertOutside } from '/utils/background-inert.js';
import { mealTypeList, primeMealTypeNames } from '/utils/meal-types.js';
import { recipeThumbHtml, wireRecipeThumbs } from '/utils/recipe-thumb.js';
import { wireNoteCategoryOverflow } from '/utils/note-category-overflow.js';
import { installPopoverMenus, popoverMenuHtml } from '/utils/popover-menu.js';
import { nextRewardGoal } from '/utils/reward-goal.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { shiftTypeLabel } from '/utils/shift-label.js';
import { layoutTodayTimeline, timelineScale, timelineHourCovered } from '/utils/today-timeline.js';
import { hourGutterLabel } from '/utils/time-grid.js';

// Hält den AbortController des aktuellen FAB-Listeners - wird bei jedem render() erneuert.
let _fabController = null;

/* DIE WAND HAELT DEN EINEN HISTORY-MARKER (#1559). Zurueck beendete sie nicht:
 * es gab keinen Eintrag und keinen `popstate`-Handler, in der installierten App
 * schloss die Geste die App, und beim naechsten Start stand die Wand wieder da.
 * Sie meldet sich deshalb im Overlay-Register an wie jeder Dialog - derselbe
 * EINE Marker (utils/overlay-history.js), keine zweite Buchhaltung.
 *
 * Angemeldet wird, solange die Flaeche STEHT, nicht beim Einschalten: der Modus
 * ist gemerkt und steht nach einem Neustart ohne jeden Klick wieder da. Auch
 * dann fuehrt Zurueck erst aus der Wand auf die Uebersicht und nicht aus der
 * App. Die Flaeche baut sich oft neu (Timer, Minutentakt, Laden) - der Token
 * ueberlebt das, und `_wallLeave` zeigt auf den Ausstieg des juengsten Aufbaus.
 *
 * `force` (Navigation, Sitzungsende) gibt nur den Marker frei, der Modus BLEIBT
 * gemerkt: wer per Kurzbefehl woandershin geht, hat die Wand nicht abbestellt.
 * Sie gilt ohnehin nur auf `/` (isWallRoute). */
let _wallOverlay = null;
let _wallLeave = null;

/* WOHIN DER FOKUS NACH DEM MODUSWECHSEL GEHT (R20, Re-Critique 2026-10-17 A1
 * P2-6). Start und Ausstieg bauen die ganze Seite neu (`rerender`), und danach
 * stand der Fokus auf <body>: wer per Tastatur „Wand-Modus starten" drueckte,
 * fand sich nirgends, und nach Esc wieder am Dokumentanfang. Die Absicht
 * ueberlebt den Neuaufbau hier, weil `render()` eine neue Closure baut:
 *   'enter' -> die Wandflaeche selbst (`#wall-surface`, tabindex=-1): ein
 *              ruhiger Einstieg, kein Knopf - ein Enter dort beendete sonst
 *              gleich wieder, was gerade begonnen hat;
 *   'leave' -> der Knopf, der die Wand wieder oeffnet (am Finger das Menue).
 * Einmal gelesen, dann vergessen. */
let _wallFocusIntent = null;
function takeWallFocusIntent(kind) {
  if (_wallFocusIntent !== kind) return false;
  _wallFocusIntent = null;
  return true;
}

function holdWallMarker(leave) {
  _wallLeave = leave;
  if (_wallOverlay !== null && isOverlayOpen(_wallOverlay)) return;
  _wallOverlay = pushOverlay(({ force }) => {
    _wallOverlay = null;
    if (!force) _wallLeave?.();
  });
}

function releaseWallMarker() {
  _wallLeave = null;
  if (_wallOverlay === null) return;
  const token = _wallOverlay;
  _wallOverlay = null;
  dropOverlay(token);
}

const noteCategoryName = (category) => String(category?.name || '');
const noteCategoryScope = (category) => t(
  category?.scope === 'personal' ? 'noteCategories.personal' : 'noteCategories.household',
);


// ── Onboarding ──────────────────────────────────────────────────────────────

const ONBOARDING_KEY = 'yuvomi-onboarded';
// Der Dialog benennt sich ueber seinen Schritt-Titel; die id steht hier, weil
// beide Seiten der Verknuepfung sie brauchen (Overlay und `fillStep()`).
const ONBOARDING_TITLE_ID = 'onboarding-step-title';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const CUSTOMIZE_HINT_KEY = 'yuvomi-dash-customize-hint';

// DIE RUECKKEHR IN DEN TAB LAEDT NUR, WAS ALT IST (Modern-Web-Guidance-Audit,
// Befund 13). Jeder Wechsel zurueck holte `/dashboard` samt Erinnerungen neu
// und baute die ganze Uebersicht auf, auch nach Sekunden in einem anderen Tab.
// Neu geladen wird, wenn der Stand aelter als eine Minute ist oder der
// Haushaltstag seitdem gewechselt hat ("Heute" waere sonst gestern).
const RETURN_REFRESH_MIN_MS = 60_000;

function staleOnReturn({ loadedAt, loadedDay }, { now, today }) {
  if (!loadedAt) return true;
  if (loadedDay !== today) return true;
  return now.getTime() - loadedAt.getTime() >= RETURN_REFRESH_MIN_MS;
}

/* DER RUECKWEG ZEICHNET DEN EBEN GELADENEN STAND SOFORT (Critique R21, a1 P2).
 *
 * Zurueck auf der Uebersicht stand zuerst das Skelett ohne Gruss, die Blende
 * lief hinein, und ein paar hundert Millisekunden spaeter schnitt der Inhalt
 * hart darueber - auch wenn derselbe Stand Sekunden vorher schon dagewesen
 * war. Ist der letzte volle Stand frisch (dieselbe Regel wie beim Zurueckkehren
 * in den Tab, `staleOnReturn`), dasselbe Mitglied, dieselbe Sprache, und hat
 * seitdem nichts geschrieben (api.js meldet jeden Schreibvorgang als
 * `yuvomi:write`), zeichnet die Seite ihn sofort und fragt danach still nach
 * (stale-while-revalidate). Gebaut wird nur neu, wenn die Antwort anders ist.
 * Die Wand nimmt nie einen gemerkten Stand: sie fragt als Haushalt. */
let _overviewMemo = null;
let _overviewMemoWatched = false;

function overviewMemoKey(user) {
  return `${user?.id ?? ''}|${getLocale()}`;
}

/** Der gemerkte Stand, wenn er fuer diesen Aufbau taugt - sonst null. */
function usableOverviewMemo(memo, { key, now, today }) {
  if (!memo || memo.key !== key) return null;
  if (staleOnReturn({ loadedAt: memo.at, loadedDay: memo.day }, { now, today })) return null;
  return memo;
}

/** Ein Schreibvorgang irgendwo macht den gemerkten Stand ungueltig. Einmal je Sitzung. */
function watchOverviewWrites() {
  if (_overviewMemoWatched || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _overviewMemoWatched = true;
  // Der Name steht in api.js (WRITE_EVENT) - ausgeschrieben, weil der
  // Test-Loader api.js stubt.
  window.addEventListener('yuvomi:write', () => { _overviewMemo = null; });
}

/** Vergleichbarer Abdruck eines Stands; null, wenn er sich nicht fassen laesst. */
function overviewSignature(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    // Oben nach Schluessel sortiert: die Slices haengen je nach Weg in anderer
    // Reihenfolge an (Erstaufbau vs. Nachfrage), der Inhalt ist derselbe.
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return JSON.stringify(sorted);
  } catch {
    return null;
  }
}

/* DER TAG EINES TERMINS IST DER TAG DER HAUSHALTSZONE, nicht der des Browsers.
 *
 * Hier stand `toLocalDateKey(new Date(value))`, und das las einen
 * synchronisierten Termin (`…Z` oder mit Offset) in der Zone des GERAETS:
 * `toLocalDateKey` sieht die Haushaltszone bewusst nie (CLAUDE.md, Fallen).
 * Mit Haushalt in Berlin und Telefon in Tokio stand ein Termin um 23:30 am
 * Folgetag - in der Liste, im Tagesprogramm, im Familien-Widget und im
 * Kalender-Link. Zonenlose Wanduhrzeit fiel nicht auf, weil der Umweg ueber
 * `new Date()` dieselben Ziffern zurueckgibt.
 *
 * `zonedDateKey` ist dieselbe Antwort, die der Kalender gibt (`localDate` in
 * pages/calendar.js): Wanduhrzeit wird gelesen, ein Zeitpunkt in die
 * Anzeigezone umgerechnet, ohne gesetzte Zone bleibt es beim Browser. */
function eventOccurrenceDateKey(event) {
  const value = String(event?.start_datetime || '');
  if (!value) return '';
  if (value.length <= 10) return value.slice(0, 10);
  return zonedDateKey(value) || value.slice(0, 10);
}

// All-day events store start_datetime as a date-only key ("2026-07-10"). Parsing
// that with `new Date()` yields UTC midnight, which shifts the calendar day back
// one day west of UTC. Parse date-only values as local calendar dates so all-day
// events land on the correct day in the dashboard widget (issue #466).
function eventStartDate(event) {
  const value = String(event?.start_datetime || '');
  if (!value) return null;
  if (value.length <= 10) return parseLocalDateKey(value);
  return new Date(value);
}

function calendarEventRoute(event) {
  if (!event?.id) return '/calendar';
  const params = new URLSearchParams({ open: String(event.id) });
  const occurrenceDate = eventOccurrenceDateKey(event);
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) params.set('date', occurrenceDate);
  return `/calendar?${params.toString()}`;
}

/**
 * Ein Zeitpunkt oder eine Wanduhrzeit als Stempel des Haushalts
 * ('YYYY-MM-DDTHH:MM', Anzeigezone): Wanduhrzeit wird gelesen, ein Zeitpunkt
 * umgerechnet. Leer, wenn der Wert keinen hergibt. Termin-Kachel, Heute-Blatt
 * und Familienkarte vergleichen mit DIESEM Stempel.
 */
function householdStamp(value) {
  const day = zonedDateKey(value);
  const time = zonedTimeKey(value);
  return day && time ? `${day}T${time}` : '';
}

/** Jetzt als Wanduhr-Stempel des Haushalts ('YYYY-MM-DDTHH:MM'). */
function householdNowStamp(now = new Date()) {
  return householdStamp(now);
}

/** Geburtstags-Termine tragen serverseitig einen sprachneutralen Titel (#524) -
 * in beiden Terminlisten der Antwort, der der Kachel und der der Familienkarte. */
function localizeEventLists(payload) {
  for (const key of ['upcomingEvents', 'familyEvents']) {
    if (Array.isArray(payload?.[key])) payload[key] = payload[key].map(localizeBirthdayEvent);
  }
}

/**
 * Ist dieser Termin vorbei (#1449)? „Vorbei" heisst: sein ENDE liegt hinter
 * uns, gelesen in der Wanduhr des Haushalts - dieselbe Regel wie serverseitig
 * in `getUpcomingEvents` (`keepEndedToday`). Ein laufender Termin zaehlt also
 * noch, ein ganztaegiger endet nie an seinem eigenen Tag, und ohne Ende ist
 * der Start das Ende.
 *
 * Gefragt wird hier und nicht nur beim Laden, weil ein Termin auch zwischen
 * zwei Abrufen endet: das unberuehrte Wandtablet soll um 9:31 nicht mehr den
 * Termin bis 9:30 zeigen, sondern erst in einer Viertelstunde.
 */
function eventHasEnded(event, nowStamp) {
  if (!event || event.all_day) return false;
  const end = String(event.end_datetime || event.start_datetime || '');
  if (end.length <= 10) return false;
  const endStamp = householdStamp(end);
  return endStamp !== '' && endStamp <= nowStamp;
}

/**
 * Wo die Uebersicht einen Termin HEUTE fuehrt (#1457).
 *
 * `upcomingEvents` bringt seit #1457 auch, was vor heute begann und heute
 * noch laeuft - die Reise von gestern 18:00 bis morgen 12:00. Nach ihrem
 * Beginn stuende sie auf gestern und fiele aus Kachel, Heute-Blatt, Wand und
 * Familienkarte; mit ihrer Startzeit neben den heutigen Eintraegen log sie.
 * Hier bekommt sie deshalb den Tag heute und die Form, die der Kalender fuer
 * denselben Tag waehlt (agendaSegmentKind): endet sie heute, heisst es
 * „bis 12:00" (`until`), laeuft sie weiter, steht sie wie ganztaegig da.
 *
 * `day`     der Tag der Zeile (Haushaltszone)
 * `carried` begann vor heute und reicht in heute
 * `allDay`  ganztaegig oder ueber heute hinweg
 * `until`   das Ende, wenn ein mitgetragener Termin heute endet, sonst null
 */
function overviewEventSpan(event, todayKey) {
  const raw = String(event?.start_datetime || '');
  const allDay = Boolean(event?.all_day) || raw.length <= 10;
  const day = eventOccurrenceDateKey(event);
  if (!day || !todayKey || day >= todayKey || !eventReachesInto(event, todayKey, allDay)) {
    return { day, carried: false, allDay, until: null };
  }
  const end = String(event?.end_datetime || '');
  // Ein Ende um genau 00:00 schliesst den Tag davor (#804): bis Mitternacht
  // heisst „bis heute 24:00", nicht „laeuft morgen weiter".
  const endsToday = !allDay && end.length > 10 && (zonedDateKey(end) === todayKey
    || householdStamp(end) === `${addLocalDays(todayKey, 1)}T00:00`);
  return { day: todayKey, carried: true, allDay: allDay || !endsToday, until: endsToday ? end : null };
}

/** Reicht der Termin ueber die Mitternacht vor `dayKey` hinaus? Ganztaegig inklusiv, wie im Kalender. */
function eventReachesInto(event, dayKey, allDay) {
  const raw = String(event?.start_datetime || '');
  if (allDay) {
    const startKey = raw.slice(0, 10);
    const endKey = event?.end_datetime ? String(event.end_datetime).slice(0, 10) : startKey;
    return (endKey > startKey ? endKey : startKey) >= dayKey;
  }
  const endStamp = householdStamp(String(event?.end_datetime || raw));
  return endStamp !== '' && endStamp > `${dayKey}T00:00`;
}

/** Die Zeitangabe eines Termins auf der Uebersicht: „bis 12:00", „Ganztaegig" oder der Beginn. */
function overviewEventTime(event, span) {
  if (span.until) return t('dashboard.todayUntil', { time: formatTime(span.until) });
  if (span.allDay) return t('dashboard.allDay');
  return formatTime(event.start_datetime);
}

/**
 * Der Name des Kalenders, zu dem ein Termin gehoert - oder leer (#1698).
 *
 * `source_calendar_name` VOR `cal_name`, dieselbe Reihenfolge wie im
 * Kalendermodul (calendar.js): `cal_name` kommt ueber die Verknuepfung des
 * schon synchronisierten Termins und fehlt, solange ein neu angelegter Termin
 * noch auf seinen Upload wartet; waehrend eines ausstehenden Umzugs nennt er
 * noch den alten Kalender. `source_calendar_name` nennt in beiden Faellen das
 * Ziel, das der Mensch gewaehlt hat.
 */
function eventCalendarName(event) {
  return String(event?.source_calendar_name ?? '').trim() || String(event?.cal_name ?? '').trim();
}

/**
 * Das Ende eines Termins fuer die WAND (#1698, D#988), fertig formatiert -
 * oder leer, wenn die Zeile beim Beginn allein bleibt. Die Wand schreibt es
 * hinter die Zeitangabe, die `overviewEventTime` liefert: Beginn UND Ende.
 *
 * „Frueh 6:00" sagt, wann die Schicht anfaengt; an der Wand will man wissen,
 * wann sie vorbei ist. Wo `overviewEventTime` schon etwas anderes als den
 * Beginn nennt („bis 12:00", „Ganztaegig"), bleibt es dabei - das Ende steht
 * dort schon, oder es gibt keins.
 *
 * KEINE SPANNE OHNE ECHTES ENDE: fehlt es, liegt es nicht nach dem Beginn, oder
 * liegt es einen ganzen Tag oder mehr danach, bleibt der Beginn allein. „22:00
 * - 06:00" liest jeder als die Nacht; „18:00 - 12:00" fuer eine Reise bis
 * uebermorgen laese sich wie ein Fehler.
 *
 * „EIN TAG ODER MEHR" IST EINE FRAGE AN DIE WANDUHR, NICHT AN DIE STOPPUHR.
 * Verglichen werden die Stempel des Haushalts: das Ende gegen den Beginn am
 * Folgetag zur selben Uhrzeit. Hier standen zuerst Millisekunden
 * (`new Date(end) - new Date(start) >= 24 h`), und das war zweimal falsch: in
 * der Nacht der Zeitumstellung hat der Tag 23 Stunden, Samstag 22:00 bis
 * Sonntag 22:00 las sich als „22:00 - 22:00"; und `new Date('…T22:00')` liest
 * die Ziffern in der Zone des GERAETS, die Antwort hing also am Tablett statt
 * am Haushalt (dieselbe Falle wie #1534).
 *
 * Der Bindestrich ist dieselbe Form wie bei den Schichten des Blatts
 * (utils/today-sheet.js).
 */
function wallEventEnd(event, span) {
  if (span.until || span.allDay) return '';
  const end = String(event?.end_datetime || '');
  // Ein Ende ohne Uhrzeit ('YYYY-MM-DD') ist kein Ende einer Spanne. Der
  // Riegel steht HIER und nicht im Stempel: `householdStamp('2026-09-25')`
  // liest Mitternacht, und aus „18:00 bis zum 25." wuerde „18:00 - 00:00" -
  // eine Uhrzeit, die niemand eingetragen hat.
  if (end.length <= 10) return '';
  const startStamp = householdStamp(String(event?.start_datetime || ''));
  const endStamp = householdStamp(end);
  if (!startStamp || !endStamp || endStamp <= startStamp) return '';
  const dayLater = `${addLocalDays(startStamp.slice(0, 10), 1)}${startStamp.slice(10)}`;
  if (endStamp >= dayLater) return '';
  return formatTime(end);
}

function getAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || 'Yuvomi';
}

function getOnboardingSteps() {
  const appName = getAppName();
  // Plattform-bewusste Copy (Critique P5/Paket 3): der allererste Eindruck darf
  // keine UI beschreiben, die der Nutzer nicht sieht - Desktop mit Sidebar
  // bekommt weder Bottom-Bar- noch Wischgesten-Text. Gleicher Breakpoint wie
  // der Sidebar-Umbruch (layout.css, min-width: 1024px).
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  // DIE MARKE UND DIE ECHTEN KNOEPFE (Re-Critique 2026-10-17, A1): der
  // Rundgang begann mit einem Lucide-Haus statt der Bildmarke und beschrieb
  // Leiste und Plus-Knopf nur in Worten. Schritt 1 traegt jetzt das Zeichen
  // (utils/brand-mark.js), Schritt 2 und 3 zeigen auf das Bedienelement, das
  // der Text nennt (`target`, siehe placeSpotlight in showOnboarding).
  // SCHRITT 2 ZEIGT MODULE, KEINEN KOMPASS (R22 S9, Critique a1): `navigation`
  // ist in Lucide der Ortungspfeil - er las sich als „Standort", der Text
  // spricht von Leiste und Modulen. Schritt 3 verspricht das Wischen nur dort,
  // wo es Zeilen gibt, die es koennen (Aufgaben, Einkauf, Vorrat).
  return [
    { mark: true,           title: t('onboarding.step1Title', { name: appName }), body: t('onboarding.step1Body') },
    { icon: 'layout-grid',  title: t('onboarding.step2Title'), body: t(desktop ? 'onboarding.step2BodyDesktop' : 'onboarding.step2Body'),
      target: () => document.querySelector(desktop ? '.nav-sidebar' : '.nav-bottom__items') },
    { icon: 'plus-circle',  title: t('onboarding.step3Title'), body: t(desktop ? 'onboarding.step3BodyDesktop' : 'onboarding.step3Body'),
      target: () => [...document.querySelectorAll('.page-fab')].find(isShownOnScreen) ?? null },
  ];
}

/** Steht das Element sichtbar im Fenster? (Ziel eines Rundgang-Schritts) */
function isShownOnScreen(el) {
  if (!el || !el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
    && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** Abstand des Lichtrings um das gezeigte Bedienelement, in px. */
const ONBOARDING_SPOT_PAD = 6;
/** Abstand der Karte zum Lichtring und zum Fensterrand, in px. */
const ONBOARDING_CARD_GAP = 16;

/**
 * DIE KARTE STEHT AM ERKLAERTEN ELEMENT (Critique R24, G6-Rundgang-P3-1). Sie
 * stand mittig, auch wenn der Schritt die Seitenleiste erklaerte - 306 px
 * daneben am Desktop, mobil oben, waehrend der Ring unten um die Leiste lag.
 * Jetzt an der Seite des Rings, die Platz hat: ueber oder unter einem breiten
 * oder quadratischen Ziel (Leiste, Plus-Knopf), neben einem hohen
 * (Seitenleiste); quer dazu an der Mitte des Ziels ausgerichtet, im Fenster
 * gehalten. Passt sie nirgends daneben, bleibt sie in der Mitte (null).
 *
 * Rein: Rechteck des Rings, Groesse der Karte, Fenster -> linke obere Ecke.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} spot
 * @param {{ width: number, height: number }} card
 * @param {{ width: number, height: number }} view
 * @param {number} [gap]
 * @returns {{ x: number, y: number, side: string } | null}
 */
function onboardingCardPlacement(spot, card, view, gap = ONBOARDING_CARD_GAP) {
  const spotW = spot.right - spot.left;
  const spotH = spot.bottom - spot.top;
  const clamp = (value, max) => Math.round(Math.max(gap, Math.min(value, max - gap)));
  const room = {
    above: spot.top - gap * 2 >= card.height,
    below: view.height - spot.bottom - gap * 2 >= card.height,
    right: view.width - spot.right - gap * 2 >= card.width,
    left: spot.left - gap * 2 >= card.width,
  };
  const order = spotH > spotW ? ['right', 'left', 'below', 'above'] : ['above', 'below', 'right', 'left'];
  const side = order.find((name) => room[name]);
  if (!side) return null;
  if (side === 'above' || side === 'below') {
    return {
      side,
      x: clamp(spot.left + spotW / 2 - card.width / 2, view.width - card.width),
      y: Math.round(side === 'above' ? spot.top - gap - card.height : spot.bottom + gap),
    };
  }
  return {
    side,
    x: Math.round(side === 'right' ? spot.right + gap : spot.left - gap - card.width),
    y: clamp(spot.top + spotH / 2 - card.height / 2, view.height - card.height),
  };
}

function showOnboarding(appContainer, onDone) {
  const steps = getOnboardingSteps();
  let current = 0;

  // Fokus vor dem Dialog merken, um ihn beim Schließen zurückzugeben.
  const previouslyFocused = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // EIN DIALOG OHNE NAMEN ist fuer den Screenreader nur „Dialog". Der Name
  // kommt aus dem Schritt-Titel, den `fillStep()` ohnehin baut; die id ist
  // deshalb konstant und wandert mit dem Austausch des Karteninhalts mit
  // (WCAG 4.1.2). `aria-modal` versteckt alles dahinter - was bleibt, muss
  // sich also selbst benennen.
  overlay.setAttribute('aria-labelledby', ONBOARDING_TITLE_ID);

  const onKeydown = (event) => {
    if (event.key === 'Escape') { finish(); return; }
    if (event.key !== 'Tab') return;
    // Fokus-Trap (WCAG 2.4.3/2.1.2): der Erststart-Dialog darf den Fokus nicht
    // auf die verdeckte Seite dahinter entlassen. Fokussierbare Elemente je
    // Tab-Druck neu ermitteln, da fillStep() den Karteninhalt austauscht.
    const focusables = overlay.querySelectorAll(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  /* DIE KARTE STEHT, IHR INHALT WECHSELT (R17, Bewegung). Bisher baute jeder
   * Schritt die Karte neu: sie sprang mit der Textlaenge (gemessen 327 ->
   * 353px) und die Knoepfe wanderten unter dem Zeiger weg. Jetzt bleibt die
   * Karte derselbe Knoten, `.onboarding-step` darin traegt den Schritt und
   * tauscht ueber swapContent() in Leserichtung (utils/content-swap.js) - und
   * er ist so hoch wie der hoechste der Schritte (`fitSteps()`, gemessen
   * statt geraten: die Texte sind je Sprache verschieden lang). */
  const card = document.createElement('div');
  card.className = 'onboarding-card';
  const stepEl = document.createElement('div');
  stepEl.className = 'onboarding-step';
  card.appendChild(stepEl);

  /* DER LICHTRING (Re-Critique 2026-10-17, A1 "kein Bezug auf echte
   * Bedienelemente"). Nennt ein Schritt die Leiste oder den Plus-Knopf, liegt
   * ueber genau diesem Knopf ein Ausschnitt: der Ring traegt den Abdunkler als
   * Schatten nach aussen (`box-shadow` mit 100vmax Spreizung), das Overlay
   * selbst wird dafuer klar. So steht das echte Element scharf im Bild, der
   * Rest gedimmt - ohne Maske, ohne Kopie des Elements. Klicks faengt weiter
   * das Overlay; der Ring ist reine Anzeige (aria-hidden), der Text bleibt die
   * Aussage. Findet sich das Ziel nicht (Modul ohne Plus, ausgeblendete
   * Leiste), bleibt der Schritt so, wie er vorher war: Tafel auf Unschaerfe. */
  const spot = document.createElement('div');
  spot.className = 'onboarding-spotlight';
  spot.setAttribute('aria-hidden', 'true');
  overlay.appendChild(spot);
  overlay.appendChild(card);

  function placeSpotlight() {
    const target = steps[current].target?.();
    const shown = isShownOnScreen(target);
    overlay.classList.toggle('onboarding-overlay--spot', shown);
    if (!shown) { placeCard(null); return; }
    const r = target.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    const pad = ONBOARDING_SPOT_PAD;
    spot.style.setProperty('--spot-x', `${Math.round(r.left - pad)}px`);
    spot.style.setProperty('--spot-y', `${Math.round(r.top - pad)}px`);
    spot.style.setProperty('--spot-w', `${Math.round(r.width + pad * 2)}px`);
    spot.style.setProperty('--spot-h', `${Math.round(r.height + pad * 2)}px`);
    spot.style.setProperty('--spot-r', `${Math.round(Math.min(radius + pad, (r.height + pad * 2) / 2))}px`);
    placeCard({ left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad });
  }

  /* Die Karte an den Ring (onboardingCardPlacement). Der Ortswechsel gleitet
   * wie der Ring (FLIP ueber transform, --duration-lg), unter reduzierter
   * Bewegung springt er. Ohne Ziel steht sie wieder, wie das Overlay sie
   * stellt (Mitte, mobil oben). */
  function placeCard(spotRect) {
    const before = card.getBoundingClientRect();
    const place = spotRect && onboardingCardPlacement(
      spotRect,
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    overlay.classList.toggle('onboarding-overlay--anchored', Boolean(place));
    if (place) {
      card.style.setProperty('--card-x', `${place.x}px`);
      card.style.setProperty('--card-y', `${place.y}px`);
    } else {
      card.style.removeProperty('--card-x');
      card.style.removeProperty('--card-y');
    }
    const after = card.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || !card.animate || !before.width) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: parseFloat(getComputedStyle(card).getPropertyValue('--onboarding-move-ms')) || 400,
      easing: getComputedStyle(card).getPropertyValue('--onboarding-move-ease').trim() || 'ease-out',
    });
  }
  const onResize = () => placeSpotlight();
  window.addEventListener('resize', onResize);

  function fitSteps() {
    stepEl.style.minBlockSize = '';
    const shown = current;
    let tallest = 0;
    for (current = 0; current < steps.length; current += 1) {
      fillStep();
      tallest = Math.max(tallest, stepEl.offsetHeight);
    }
    current = shown;
    fillStep();
    if (tallest > 0) stepEl.style.minBlockSize = `${tallest}px`;
  }

  /** Baut den Schritt `current` in die stehende Karte; gibt seinen Hauptknopf zurueck. */
  function fillStep() {
    const step = steps[current];
    const isLast = current === steps.length - 1;
    stepEl.replaceChildren();

    let icon;
    if (step.mark) {
      icon = document.createElement('span');
      icon.className = 'onboarding-mark';
      icon.setAttribute('aria-hidden', 'true');
      icon.insertAdjacentHTML('beforeend', brandMarkSvg());
    } else {
      icon = document.createElement('i');
      icon.dataset.lucide = step.icon;
      icon.className = 'onboarding-icon';
      icon.setAttribute('aria-hidden', 'true');
    }

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.id = ONBOARDING_TITLE_ID;
    // Fokusziel nach einem Tipp (focusStep), nicht in der Tab-Folge.
    title.tabIndex = -1;
    title.textContent = step.title;

    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = step.body;

    // Die Punkte sind reine Dekoration und fuer Screenreader unsichtbar; die
    // Fortschrittsansage traegt ein sr-only-Text daneben - vorher hoerte ein
    // Screenreader gar nicht, an welchem der drei Schritte er steht
    // (Critique 2026-08-27, Persona Sam).
    const dots = document.createElement('div');
    dots.className = 'onboarding-dots';
    dots.setAttribute('aria-hidden', 'true');
    steps.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = `onboarding-dot${i === current ? ' onboarding-dot--active' : ''}`;
      dots.appendChild(dot);
    });
    const progress = document.createElement('p');
    progress.className = 'sr-only';
    progress.textContent = t('onboarding.stepProgress', { current: current + 1, total: steps.length });

    const actions = document.createElement('div');
    actions.className = 'onboarding-actions';
    actions.dataset.dialogActions = '';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn--ghost';
    skipBtn.textContent = t('onboarding.skip');
    skipBtn.addEventListener('click', finish);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--primary';
    nextBtn.textContent = isLast ? t('onboarding.done') : t('onboarding.next');
    nextBtn.addEventListener('click', () => {
      if (isLast) { finish(); return; }
      current++;
      // Der Fokus geht an den NEUEN Hauptknopf (der alte ist mit dem Schritt
      // gegangen) - synchron nach dem Tausch, die Blende sperrt nichts.
      let next = null;
      swapContent(stepEl, () => { next = fillStep(); }, { direction: 1 });
      focusStep(next);
    });

    // EIN SCHRITT ZURUECK (R23 S10, Critique G6 P3 "Tour ohne Zurueck"): wer
    // den Text zur Leiste zu schnell weggetippt hat, kam nur durch einen
    // Neustart des Rundgangs zurueck. Ab Schritt 2 steht "Zurueck" vorn, wo
    // auf Schritt 1 "Ueberspringen" steht (Zurueck-Geste und Esc beenden ihn
    // weiterhin, attachOverlay unten).
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn--ghost';
    backBtn.textContent = t('common.back');
    backBtn.addEventListener('click', () => {
      current--;
      let next = null;
      swapContent(stepEl, () => { next = fillStep(); }, { direction: -1 });
      focusStep(next);
    });

    if (current > 0) actions.appendChild(backBtn);
    else if (!isLast) actions.appendChild(skipBtn);
    actions.appendChild(nextBtn);
    stepEl.appendChild(icon);
    stepEl.appendChild(title);
    stepEl.appendChild(body);
    stepEl.appendChild(dots);
    stepEl.appendChild(progress);
    stepEl.appendChild(actions);

    if (window.lucide) window.lucide.createIcons({ el: stepEl });
    placeSpotlight();
    return nextBtn;
  }

  /* KEIN RING AM FINGER (Critique R24, G6-Rundgang-P3-1). Der Fokus ging nach
   * jedem Schritt programmatisch an "Weiter", und der Knopf trug danach seinen
   * Fokusring auch nach einem Tipp (gemessen 390, touch: `:focus-visible` in
   * allen drei Schritten). Wie im Dialog (components/modal.js, Erstfokus):
   * nach Tastatur der Hauptknopf mit Ring, nach Zeiger oder auf einem
   * Touchgeraet ohne Eingabe der Titel des Schritts (`tabindex=-1`, ohne
   * Ring) - der Fokus bleibt in der Karte, und Tab fuehrt zu den Knoepfen. */
  function focusStep(button) {
    const touch = window.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;
    if (lastInputWasKeyboard() && !touch) { button?.focus(); return; }
    stepEl.querySelector('.onboarding-title')?.focus({ preventScroll: true });
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
    localStorage.setItem(ONBOARDING_KEY, '1');
    // Am Konto vermerken, nicht nur am Geraet: sonst zeigt ein neues Geraet
    // oder ein privates Fenster den Rundgang erneut, obwohl das Konto ihn
    // schon gesehen hat. Bewusst fire-and-forget - ein Netzwerkfehler hier
    // darf den Dialog nicht am Schliessen hindern; der lokale Merker faengt
    // den aktuellen Browser ohnehin ab.
    auth.markOnboardingSeen().catch(() => {});
    // Fokus dorthin zurückgeben, wo er vor dem Dialog lag, sonst auf den
    // Inhalt (`#main-content`, tabIndex -1 - wie nach einer Navigation).
    // `document.body.focus()` tat nichts, und der Fokus blieb im entfernten
    // Overlay haengen (Modern-Web-Guidance-Audit, Befund 10).
    releaseBackground();
    const restoreTarget = (previouslyFocused?.isConnected && previouslyFocused !== document.body)
      ? previouslyFocused
      : document.getElementById('main-content');
    overlay.classList.add('onboarding-overlay--out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    // Fallback falls animationend nicht feuert (prefers-reduced-motion):
    setTimeout(() => overlay.remove(), 300);
    restoreTarget?.focus?.();
    onDone?.();
  }

  appContainer.appendChild(overlay);
  // Messen kann erst ein Knoten im Baum; danach steht Schritt 1.
  fitSteps();
  // Die Seite hinter dem Rundgang ist gesperrt, solange er laeuft
  // (utils/background-inert.js); finish() gibt sie vor dem Fokus frei.
  const releaseBackground = inertOutside(overlay);
  setTimeout(() => focusStep(stepEl.querySelector('.btn--primary')), 50);
  // Die Zurueck-Geste beendet die Einfuehrung, statt hinter ihr zu navigieren
  // (#871). `finish()` ist der EINE Weg hinaus und merkt sich das auch.
  attachOverlay(overlay, finish);
}

// Einmaliger, zurückhaltender Hinweis auf den „Anpassen"-Einstieg: Da vier Widgets
// standardmäßig hinter dem Cockpit ausgeblendet sind, macht ein sanfter Puls beim
// Erststart sichtbar, wo sie sich wieder einblenden lassen. Danach nie wieder.
function maybeHintCustomize(container) {
  if (localStorage.getItem(CUSTOMIZE_HINT_KEY)) return;
  // Mobil steht der Einstieg im Menue (R19) - der Hinweis gehoert dem
  // sichtbaren Knopf.
  const btn = [...container.querySelectorAll('#dashboard-customize-btn, .dashboard-tools-btn')]
    .find((el) => el.getClientRects?.().length !== 0);
  if (!btn) return;
  const clear = () => {
    btn.classList.remove('dashboard-icon-btn--hint');
    localStorage.setItem(CUSTOMIZE_HINT_KEY, '1');
  };
  btn.classList.add('dashboard-icon-btn--hint');
  btn.addEventListener('click', clear, { once: true });
  setTimeout(clear, 6000);
}

// --------------------------------------------------------
// Widget-Definitionen (Reihenfolge = Standard-Layout)
// --------------------------------------------------------

// Der Standard-Satz und die reine Logik darauf liegen in
// `/utils/dashboard-widgets.js` - sie tragen eine Zusicherung über die
// Reihenfolge und mussten dafür ohne Shell testbar sein. Was hier bleibt,
// hängt an Haushaltskontext und Modul-Schaltern.

// Widget → Modul-Slug für die „Modul deaktiviert?"-Prüfung. Widgets ohne Eintrag
// haengen an keinem Modul; eigene Verfuegbarkeitsregeln (family, countdown,
// weather) stehen in `isWidgetModuleEnabled`. Modulweit, damit Grid-Filter und
// Wieder-Einblenden-Leiste dieselbe Sichtbarkeitsregel teilen.
// `split-expenses` ist kein Widget, sondern eine Kachel der Kennzahlreihe -
// steht aber hier, weil `isWidgetModuleEnabled()` auch die Kacheln filtert, und
// die geteilten Ausgaben haengen am Budget-Modul (server/scopes.js).
const MODULE_FOR_WIDGET = { tasks: 'tasks', calendar: 'calendar', shopping: 'shopping', meals: 'meals', notes: 'notes', birthdays: 'birthdays', budget: 'budget', 'split-expenses': 'budget', rewards: 'rewards', health: 'health', cycle: 'health', fasting: 'health', nutrition: 'health', housekeeping: 'housekeeping', schedule: 'schedule', waste: 'waste', pantry: 'pantry' };

const WIDGETS_WITH_OPTIONS = new Set(['calendar', 'tasks', 'notes', 'waste', 'shopping']);

const _extensionWidgetModules = new Map();

function widgetHasOptions(id) {
  if (WIDGETS_WITH_OPTIONS.has(id)) return true;
  const meta = getExtensionWidgetMeta(id);
  return Boolean(meta?.optionsSchema && Object.keys(meta.optionsSchema).length);
}

async function mountExtensionWidgets(shell, cfg, user) {
  const mounts = shell.querySelectorAll('[data-extension-widget-mount]');
  await Promise.all([...mounts].map(async (mount) => {
    const wrapper = mount.closest('[data-widget-id]');
    const id = wrapper?.dataset?.widgetId;
    if (!id) return;
    const w = cfg.find((item) => item.id === id);
    const meta = getExtensionWidgetMeta(id);
    if (!meta?.entry) return;
    try {
      let mod = _extensionWidgetModules.get(meta.entry);
      if (!mod) {
        mod = await import(/* webpackIgnore: true */ meta.entry);
        _extensionWidgetModules.set(meta.entry, mod);
      }
      mount.replaceChildren();
      if (typeof mod.renderWidget !== 'function') {
        throw new Error('renderWidget export missing');
      }
      await mod.renderWidget(mount, {
        size: w?.size,
        options: w?.options ?? {},
        user,
      });
      if (window.lucide) window.lucide.createIcons({ el: mount });
    } catch (err) {
      console.error(`[dashboard] Extension widget "${id}" konnte nicht gerendert werden`, err);
      mount.replaceChildren();
      mount.insertAdjacentHTML('afterbegin', renderWidgetError(id));
      if (window.lucide) window.lucide.createIcons({ el: mount });
    }
  }));
}

/* DER COUNTDOWN IST EIN WIDGET, DAS ES ERST GIBT, WENN JEMAND ETWAS MARKIERT
 * HAT (#647). Er hat keine eigene Seite und keinen eigenen Bestand: seine
 * Kachel zeigt Termine und Aufgaben, die jemand ausdrücklich dafür markiert
 * hat, und in einem Haushalt, der das noch nie getan hat, gibt es nichts zu
 * zeigen und nichts einzurichten.
 *
 * ER RENDERT DESHALB NICHT LEER, SONDERN IST DANN NICHT VERFUEGBAR - das ist
 * genau der Unterschied, den das Familien-Widget unten schon einmal gekostet
 * hat: ein Renderer, der '' zurückgibt, verschwindet aus dem Raster, bleibt
 * aber `visible: true` und taucht damit auch in der Ablage der versteckten
 * Widgets nicht auf. Hier fällt er aus beiden Listen, so wie ein abgeschaltetes
 * Modul auch, und kommt mit dem ersten Countdown an seiner gespeicherten
 * Position zurück.
 *
 * Der Zähler ist modulweit und nicht Teil von `data`, weil ihn zwei Aufrufer
 * brauchen, von denen einer (die Ablage der versteckten Widgets) die Daten
 * nicht sieht. Er wird bei jedem render() zurückgesetzt und nach dem Laden
 * gesetzt - ein Stand von vorhin darf keine Kachel versprechen. */
let countdownAvailable = false;

function setCountdownAvailability(items) {
  countdownAvailable = Array.isArray(items) && visibleCountdowns(items).length > 0;
}

/* DAS WETTER IST VERFUEGBAR, SOBALD ES EINGERICHTET IST - NICHT ERST, WENN DER
 * ANBIETER ANTWORTET. Bis v2.70.0 hing die Kachel an der Antwort selbst: ein
 * Fehlschlag beim Anbieter lieferte `{ data: null }`, der Renderer gab '' zurueck,
 * und die Kachel verschwand genau so, wie es die Notiz am Countdown beschreibt -
 * aus dem Raster, aus der Anpassen-Ablage (sie blieb `visible: true`) und mit
 * ihr aus der Kopfzeile, die ihr Wetter der Kachel ueberlaesst.
 *
 * Jetzt zwei Faelle:
 *   - nicht eingerichtet: die Kachel ist NICHT VERFUEGBAR wie ein abgeschaltetes
 *     Modul (dieselbe Regel wie Countdown und Familie). Ein Einrichtungshinweis
 *     waere eine Kachel, die allen Mitgliedern eine Aufgabe zeigt, die nur der
 *     Admin erledigen kann, und ab Werk im Raster jedes Haushalts ohne Wetter
 *     stuende. Der Weg dorthin sind die Einstellungen;
 *   - eingerichtet, aber gescheitert: die Kachel bleibt stehen und sagt ruhig,
 *     dass es gerade kein Wetter gibt (`renderWeatherUnavailable`).
 *
 * Woher „eingerichtet": der Grund, den der Wetter-Proxy selbst nennt
 * (`reason`). Er kennt die ganze Regel, samt Standort je Mitglied und
 * unvollstaendiger Einrichtung - `weather_source` aus /preferences beschreibt
 * nur den Haushalt. Die Praeferenzen sind der Rueckfall fuer den Fall, dass die
 * Anfrage selbst scheiterte und der Server gar nichts sagen konnte. */
let weatherAvailable = false;

function weatherAvailableFrom(res, prefs) {
  if (res?.data) return true;
  if (res?.reason === 'not_configured') return false;
  // `upstream_error` und jeder kuenftige Grund: eingerichtet. Im Zweifel bleibt
  // die Kachel erreichbar - das Gegenteil war der Fehler.
  if (res?.reason) return true;
  const household = prefs?.weather_source?.source;
  const user = prefs?.weather_user;
  return Boolean((household && household !== 'none') || (user?.lat && user?.lon));
}

function setWeatherAvailability(res, prefs) {
  weatherAvailable = weatherAvailableFrom(res, prefs);
}

// Aus welchem Modul ein Countdown stammt, entscheidet über ihn: wer den
// Kalender abgeschaltet hat, soll dessen Einträge auch hier nicht sehen. Die
// Kachel als Ganzes gehört keinem Modul (siehe PERMISSION_WIDGETS), ihre
// einzelnen Zeilen schon - dieselbe Aufteilung wie bei der Kennzahlreihe.
//
// SEIT DEM REVIEW ZU PR #793 IST DAS DIE ZWEITE INSTANZ, NICHT DIE ERSTE:
// aussortiert wird schon in services/countdowns.js, vor Schnitt und Gesamtzahl.
// Hier zu filtern allein war der Fehler - der Server schickte fünf Termine
// eines abgeschalteten Kalenders, diese Zeile warf alle fünf weg, und die
// Kachel verschwand mitsamt der Aufgabe, die dahinter gestanden hätte.
// Stehen bleibt der Filter für den Fall, dass ein Modul umgeschaltet wird,
// ohne dass das Dashboard neu lädt.
function visibleCountdowns(items) {
  return (Array.isArray(items) ? items : []).filter((c) => {
    const mod = c.source === 'task' ? 'tasks' : 'calendar';
    return !window.yuvomi?.isModuleDisabled(mod);
  });
}

function isWidgetModuleEnabled(id) {
  if (isExtensionWidget(id)) {
    const meta = getExtensionWidgetMeta(id);
    if (!meta) return false;
    if (meta.permissionModuleKey && moduleAccess(meta.permissionModuleKey) === 'none') return false;
    if (!canSeeWidget(id)) return false;
    return true;
  }
  const mod = MODULE_FOR_WIDGET[id];
  if (mod && window.yuvomi?.isModuleDisabled(mod)) return false;
  // Rollen-/Mitglied-Rechte (#467): serverseitig gesperrtes Widget (bzw. Widget
  // eines Moduls ohne Zugriff — die Modulsperre wird bereits serverseitig auf die
  // Widget-Map durchgereicht) hier nicht anbieten.
  if (!canSeeWidget(id)) return false;
  // Im Solo-Haushalt ist das Familien-Widget kein VERFUEGBARES Widget, kein
  // leer gerendertes. Der Unterschied ist die „Anpassen"-Ablage: ein Renderer,
  // der '' zurueckgibt, verschwindet aus dem Raster, bleibt aber `visible: true`
  // und taucht damit auch in der Ablage der versteckten Widgets nicht auf - es
  // waere aus der Oberflaeche heraus nicht mehr erreichbar. Hier faellt es aus
  // beiden Listen, so wie ein abgeschaltetes Modul auch.
  if (id === 'family' && isSoloHousehold()) return false;
  if (id === 'fasting' && !canUseFasting()) return false;
  if (id === 'countdown' && !countdownAvailable) return false;
  if (id === 'weather' && !weatherAvailable) return false;
  return true;
}

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

function widgetLabel(id) {
  const ext = getExtensionWidgetMeta(id);
  if (ext) return widgetDisplayLabel(ext);
  const map = {
    tasks:    () => t('nav.tasks'),
    calendar: () => t('nav.calendar'),
    shopping: () => t('nav.shopping'),
    meals:    () => t('nav.meals'),
    notes:    () => t('nav.notes'),
    weather:  () => t('dashboard.weather'),
    birthdays: () => t('nav.birthdays'),
    budget:   () => t('nav.budget'),
    rewards:  () => t('nav.rewards'),
    health:   () => t('nav.health'),
    cycle:    () => t('health.cycle.title'),
    fasting:  () => t('health.fasting.title'),
    nutrition: () => t('health.nutrition.title'),
    housekeeping: () => t('nav.housekeeping'),
    schedule: () => t('nav.schedule'),
    waste:    () => t('nav.waste'),
    pantry:   () => t('dashboard.pantryExpiringTitle'),
    family:   () => t('dashboard.familyTitle'),
    clock:    () => t('dashboard.clock'),
    metrics:  () => t('dashboard.metrics'),
    countdown: () => t('dashboard.countdownTitle'),
    quicklinks: () => t('dashboard.quickLinksTitle'),
  };
  return (map[id] ?? (() => id))();
}

/* HIER STAND DIE ZWEITE TABELLE MODUL -> ZEICHEN, und sie war von der ersten
 * abgewichen: Notizen fuehrte hier `pin`, in der Navigation `sticky-note`. Wer
 * das Widget und die Leiste nebeneinander sah, sah zwei Zeichen fuer ein Modul.
 * Die Zuordnung steht jetzt einmal in MODULE_ICON (nav-icons.js) - inklusive
 * der vier Dashboard-eigenen Karten (Wetter, Uhr, Kennzahlen, Countdown), die
 * keine Module sind, aber dieselbe Absender-Rolle im Kopf tragen. */
function widgetIcon(id) {
  const ext = getExtensionWidgetMeta(id);
  if (ext?.icon) return ext.icon;
  return MODULE_ICON[id] ?? MODULE_ICON.dashboard;
}

const BUDGET_CATEGORY_LABEL_KEYS = {
  housing: 'catHousing',
  food: 'catFood',
  transport: 'catTransport',
  personal_health: 'catPersonalHealth',
  leisure: 'catLeisure',
  shopping_clothing: 'catShoppingClothing',
  education: 'catEducation',
  financial_other: 'catFinancialOther',
  subscriptions: 'catSubscriptions',
  'Erwerbseinkommen': 'catEarnedIncome',
  'Kapitalerträge': 'catInvestmentIncome',
  'Geschenke & Transfers': 'catTransferGiftIncome',
  'Sozialleistungen': 'catGovernmentBenefits',
  'Sonstiges Einkommen': 'catOtherIncome',
};

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/**
 * DER GRUSS NENNT DEN VORNAMEN (Critique 2026-08-10).
 *
 * „Guten Abend, Linda Johnson" brach den Large Title mobil auf zwei Zeilen
 * (82px, 24 % des ersten Screens) und machte aus einem Gruss eine
 * Datenbankzeile. Apple gruesst mit dem Vornamen, und ein Haushalt von 2-6
 * Personen braucht keinen Nachnamen zur Unterscheidung.
 *
 * Das erste WORT, nicht das erste Zeichen bis zum Leerzeichen: `display_name`
 * ist ein frei gesetztes Feld und kann alles enthalten, auch einen einzelnen
 * Namen oder einen Spitznamen. Ohne Leerzeichen bleibt er, wie er ist - das
 * Kuerzen darf nie mehr wegnehmen, als es findet.
 */
function firstName(displayName) {
  return String(displayName ?? '').trim().split(/\s+/)[0] || String(displayName ?? '');
}

function greeting(displayName) {
  const h = nowFields().hour;
  const name = esc(firstName(displayName));
  if (h >= 5 && h < 12) return t('dashboard.greetingMorning', { name });
  if (h >= 12 && h < 18) return t('dashboard.greetingDay',    { name });
  return t('dashboard.greetingEvening', { name });
}

// Tageszeit-Fenster für den Begrüßungs-Gradienten (deckt sich mit greeting()).
// Nacht (0–4 Uhr) zählt zum Abend, damit 00:37 nicht als „Morgen" begrüßt wird.
function greetingPeriod() {
  const h = nowFields().hour;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'day';
  return 'evening';
}

// Masthead-Datum nach Apple-Kanon („Mittwoch, 6. August"): Wochentag + Tag +
// Monat in der aktiven App-Locale; die Versalisierung uebernimmt die CSS-Rolle
// (.dashboard-overview__date, text-transform). Bewusst lokales new Date()
// (reines Anzeige-Datum, keine ISO-Konvertierung - Zeitzonen-Falle).
function mastheadDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(zonedUTCProxy(now));
}

// `relativeDateLabel` wohnt in utils/day-label.js: das Heute-Blatt braucht
// dieselbe Stufung (#1452), und eine zweite Fassung liefe auseinander.

function formatDateTime(isoString) {
  if (!isoString) return '';
  // Der Wert geht als STRING weiter. In `start_datetime` liegen zwei Formen in
  // einer Spalte: zonenlose Wanduhrzeit ('2026-08-21T19:00') und echte Instants
  // ('...Z'). `new Date(...)` haette die erste in einen Zeitpunkt der
  // Browser-Zone verwandelt; beide Formatierer unterscheiden sie selbst.
  const dateStr = relativeDateLabel(isoString);
  const timeStr = formatTime(isoString);
  const suffix = timeSuffix();
  return `${dateStr}, ${timeStr}${suffix ? ' ' + suffix : ''}`.trim();
}

/** 'YYYY-MM-DDTHH:mm' als Millisekunden - reine Feldarithmetik, kein Zeitpunkt. */
function wallStampMs(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * Die Faelligkeit einer Aufgabe als Beschriftung.
 *
 * `due_date`/`due_time` sind zonenlose WANDUHRZEIT: wer „21:00" eingetippt hat,
 * meinte 21:00, in welcher Zone der Haushalt auch steht. Hier stand ein Umweg
 * ueber `new Date(\`${dateStr}T${timeStr}\`)`, und der machte daraus einen
 * Zeitpunkt der BROWSER-Zone, den `formatDate`/`formatTime` anschliessend in die
 * Anzeigezone umrechneten - mit Haushalt auf Honolulu und Browser in Berlin
 * wurde aus 21:00 ein 9:00. utils/timezone.js fuehrt die Regel dazu: umgerechnet
 * wird nur, was seine Zone SELBST traegt.
 *
 * Dieselbe Uhr entschied ueber „heute"/„morgen". Sie war die des Browsers, nicht
 * die des Haushalts - die siebte Uhr, die #829 Teil 3 uebersehen hat.
 */
function formatDueDate(dateStr, timeStr) {
  if (!dateStr) return null;

  const dayKey = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

  const dueTime = timeStr ? String(timeStr).slice(0, 5) : null;
  if (timeStr && !/^\d{2}:\d{2}$/.test(dueTime)) return null;
  // Ohne due_time laeuft der Tag bis zu seinem Ende. Das ist die interne
  // Sortier-Kruecke und wird unten nie als Uhrzeit angezeigt.
  const dueStamp = `${dayKey}T${dueTime ?? '23:59'}`;

  const now = nowFields();
  if (!now) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const todayKey = `${now.year}-${p2(now.month)}-${p2(now.day)}`;
  const nowStamp = `${todayKey}T${p2(now.hour)}:${p2(now.minute)}`;

  // Beide Seiten sind Wanduhrzeit DERSELBEN Zone und damit als Text vergleichbar.
  const overdue = dueStamp < nowStamp;
  const diffH = (wallStampMs(dueStamp) - wallStampMs(nowStamp)) / (1000 * 60 * 60);

  // Kalendertage, nicht Millisekunden: ueber eine Sommerzeitgrenze liegen zwei
  // aufeinanderfolgende Tage nicht 24h auseinander, ihre Keys aber immer genau
  // einen.
  const dayMs = (key) => wallStampMs(`${key}T00:00`);
  const calDayDiff = Math.round((dayMs(dayKey) - dayMs(todayKey)) / (1000 * 60 * 60 * 24));

  // Die Stempel gehen als STRING an die Formatierer, nicht als Date: nur so
  // bleibt die Wanduhrzeit, was sie ist (siehe oben).
  const fullLabel = dueTime
    ? `${dateText(dueStamp)}, ${formatTime(dueStamp)}` // beide aus i18n.js
    : dateText(dayKey);

  if (overdue) {
    return { text: `${t('dashboard.overdue')} - ${fullLabel}`, overdue: true };
  }

  if (calDayDiff === 1 && Number(dueTime?.slice(0, 2)) >= 22 && diffH < 24) {
    return { text: `${t('dashboard.dueSoon')} - ${fullLabel}`, overdue: false, soon: true };
  }

  if (calDayDiff === 0) {
    return { text: dueTime ? `${t('dashboard.dueToday')} - ${formatTime(dueStamp)}` : t('dashboard.dueToday'), overdue: false, soon: true };
  }

  if (calDayDiff === 1) {
    // Nur eine ECHTE Uhrzeit anhängen: ohne due_time ist 23:59:59 die interne
    // Sortier-Krücke - „Morgen fällig – 23:59" behauptete eine Deadline, die
    // niemand gesetzt hat (Critique P1). Der Heute-Zweig darüber macht es vor.
    return { text: dueTime ? `${t('dashboard.dueTomorrow')} - ${formatTime(dueStamp)}` : t('dashboard.dueTomorrow'), overdue: false };
  }

  // Weiter voraus dieselbe Stufung wie am Termin daneben (relativeDateLabel):
  // „Sa, 10:00" statt „26.09.2026, 10:00". Ueberfaelliges und „bald" oben
  // behalten das volle Datum - dort ist es die Auskunft.
  const dayLabel = relativeDateLabel(dayKey);
  return { text: dueTime ? `${dayLabel}, ${formatTime(dueStamp)}` : dayLabel, overdue: false };
}

const PRIORITY_LABELS = () => ({
  urgent: t('tasks.priorityUrgent'),
  high:   t('tasks.priorityHigh'),
  medium: t('tasks.priorityMedium'),
  low:    t('tasks.priorityLow'),
});

const MEAL_ORDER = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

function normalizeVisibleMealTypes(visibleMealTypes) {
  if (!Array.isArray(visibleMealTypes)) return MEAL_ORDER;
  const filtered = MEAL_ORDER.filter((type) => visibleMealTypes.includes(type));
  return filtered.length ? filtered : MEAL_ORDER;
}

// Aus utils/meal-types.js, nicht aus vier eigenen t()-Zeilen: der Haushalt darf
// die Slots umbenennen (#1058), und die Kachel nennt dieselbe Mahlzeit wie der
// Planer daneben.
const MEAL_LABELS = () => Object.fromEntries(
  mealTypeList().map(({ key, label }) => [key, label]),
);

const MEAL_ICONS = {
  breakfast: 'sunrise',
  lunch:     'sun',
  dinner:    'moon',
  snack:     'apple',
};

function budgetCategoryLabel(category) {
  const key = BUDGET_CATEGORY_LABEL_KEYS[category];
  return key ? t(`budget.${key}`) : (category || '-');
}

function formatCurrency(amount, currency = 'EUR') {
  return getNumberFormat({
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
  }).format(amount || 0);
}

function formatPoints(value) {
  return getNumberFormat().format(Number(value) || 0);
}

/**
 * Kopfzeile eines Dashboard-Widgets: Siegel, Titel, Zaehler, Sprung ins Modul.
 *
 * DER TITEL IST EINE UEBERSCHRIFT (Critique 2026-08-10). Er war ein `<span>`,
 * und damit hatte die wichtigste Seite der App drei Ueberschriften fuer sieben
 * Inhaltsbloecke: wer per H-Taste navigiert, sprang durch drei Marken und war
 * am Ende. `/health` machte es die ganze Zeit richtig (h1, sr-only h2 je Panel,
 * h3 je Abschnitt) - das Dashboard war der Ausreisser, nicht die Regel. h3,
 * weil darueber `h1 Uebersicht` (sr-only) und die beiden `h2` des Grusses und
 * von „Heute wichtig" stehen.
 *
 * UND DER SPRUNG IST EIN LINK, kein Knopf. Fuenf Knoepfe mit dem zugaenglichen
 * Namen „Alle" sind keine Zielangabe - deshalb `aria-label` mit dem Modulnamen.
 * Ein Knopf, der navigiert, nimmt dem Nutzer ausserdem Cmd-Klick, Mittelklick
 * und „Link kopieren". `wireLinks` (unten) kennt `<a>` bereits, der Router
 * faengt den Klick ueber `data-route` ab - der `href` ist der ehrliche
 * Zweitkanal, kein toter Zierat.
 *
 * DER KOMMENTAR STEHT HIER UND NICHT AM `return`, und das ist kein Geschmack:
 * der Siegel-Guard (test-frontend-audit.js) sucht die Herkunft in einem Fenster
 * von acht Zeilen um die Bau-Stelle. Ein Erklaerblock dazwischen schiebt
 * `--seal-accent` aus dem Fenster, und der Guard meldet ein Siegel ohne
 * Herkunft - gemessen, nicht vermutet.
 */
/* DIE ID, NICHT DAS ZEICHEN (2026-08-17). Hier stand ein Icon-NAME je
 * Aufrufstelle - die dritte Abschrift der Zuordnung Modul → Zeichen, und die
 * hartnaeckigste: sie ueberlebte sogar die Zusammenlegung von `widgetIcon()`,
 * weil kein Kopf ihn je fragte. Notizen trug hier weiter `pin`, waehrend die
 * Leiste daneben `sticky-note` zeichnete. Wer die Id uebergibt, kann diese
 * Abweichung gar nicht mehr schreiben. */
function widgetHeader(widgetId, title, count, linkHref, linkLabel, sealSlug = null, { action = '' } = {}) {
  const icon = widgetIcon(widgetId);
  // Ein eigenes Link-Label spricht auch im aria-Label mit eigener Stimme:
  // „Alle: Familienmitglieder" für einen „Verwalten"-Link wäre eine Lüge.
  const customLabel = linkLabel != null;
  linkLabel = linkLabel ?? t('dashboard.allLink');
  // EINE NULL IST KEINE ZAHL, DIE MAN ZEIGT. Der Kopf eines leeren Widgets
  // trug eine „0"-Badge neben seinem Titel, waehrend der Koerper darunter den
  // Leerzustand schon in Worten sagt - zwei Stimmen fuer dieselbe Aussage, und
  // die Badge ist die schlechtere. Die Regel steht HIER und nicht an den
  // Aufrufstellen: `0` kommt sowohl fest aus den Leerzustaenden als auch
  // gerechnet aus `totalOpen`/`badge`, und eine Allowlist deckt nur die
  // Stellen ab, die man beim Schreiben gesehen hat.
  //
  // DIE ZAHL STEHT NICHT IM NAMEN DER UEBERSCHRIFT (Critique 2026-09-23). Als
  // Kind der h3 las ein Screenreader „Geburtstage 5" - eine Ueberschrift, die
  // anders heisst als ihr Widget, und eine Zahl ohne Wort dazu. Die Badge ist
  // deshalb aria-hidden, und derselbe Wert steht hinter der h3 als Satz.
  const numericCount = Number(count);
  const hasCount = count != null && Number.isFinite(numericCount) && numericCount > 0;
  const badge = hasCount
    ? `<span aria-hidden="true" class="widget__badge">${count}</span>`
    : '';
  const countText = hasCount
    ? `<span class="sr-only">${esc(t('dashboard.badgeCount', { count: numericCount }))}</span>`
    : '';
  // OHNE ZIEL KEIN LINK. Jede Kachel bis #647 gehoerte genau einer Seite, und
  // „Alle" fuehrte dorthin. Der Countdown gehoert zweien: seine Zeilen kommen
  // aus dem Kalender UND aus den Aufgaben, und jede fuehrt selbst an ihren Ort.
  // Ein Kopf-Link muesste sich fuer eine der beiden entscheiden und waere fuer
  // die andere Haelfte der Liste falsch. `href="null"` waere die schlechtere
  // Antwort auf dieselbe Frage gewesen.
  const link = linkHref
    ? `<a href="${linkHref}" data-route="${linkHref}" class="widget__link"
         aria-label="${esc(customLabel ? `${linkLabel}: ${title}` : t('dashboard.allLinkFor', { module: title }))}">
        ${linkLabel}
      </a>`
    : '';
  // Herkunfts-Regel (Block 2): das Dashboard ist eine Mischstelle, also
  // traegt jeder Widget-Kopf das Markensiegel seines Moduls. Der Slug kommt
  // aus dem ersten Segment der Widget-Route; ein unbekannter Slug faellt im
  // var()-Fallback auf den App-Akzent zurueck. Wo Aktions-Link und Herkunft
  // auseinanderfallen (Familie: „Verwalten" fuehrt in die Einstellungen, die
  // Karte gehoert aber den Menschen; der Countdown hat gar keinen Link mehr),
  // benennt sealSlug die Herkunft explizit - sonst spraeche eine Karte zwei
  // Modultoene (Critique P2).
  //
  // Diese beiden Zeilen bleiben in Sichtweite ihrer Bau-Stelle unten: der
  // Guard „wer ein Markensiegel baut, benennt eine Herkunft" liest ein Fenster
  // von acht Zeilen um das `module-seal` herum, und der Link-Block dazwischen
  // hat sie beim ersten Anlauf genau daraus herausgeschoben.
  // Query und Hash gehoeren nicht zum Slug: `/budget?tab=budget` ergab
  // `var(--module-budget?tab=budget, ...)`, eine ungueltige Deklaration - das
  // Budget-Siegel stand im geerbten Violett der Uebersicht (R18).
  const slug = sealSlug ?? ((linkHref || '').split(/[?#]/)[0].split('/')[1] || '');
  const seal = slug ? ` style="--seal-accent: var(--module-${slug}, var(--color-accent))"` : '';
  // Vollton statt Toenung (Widget-Kopf-Kur 2026-08-17): das Siegel ist seit
  // dem Rueckbau des Absenderbands der EINZIGE Farbtraeger des Kopfes. Die
  // Klasse `--vivid` steht hier nicht mehr, weil es die Toenung nicht mehr
  // gibt: der Vollton ist seither das eine Gesicht des Siegels (layout.css).
  return `
    <div class="widget__header">
      <h3 class="widget__title">
        <span class="module-seal module-seal--sm"${seal} aria-hidden="true">
          ${moduleIconHTML(icon)}
        </span>
        <span class="widget__title-text">${title}</span>
        ${badge}
      </h3>
      ${countText}
      ${link}${action}
    </div>
  `;
}

/* DER LEERZUSTAND EINER KACHEL IST DIE RUHIGE ZEILE DER APP (DW-P2-11; R22
 * D12, `cardEmptyRowHtml` aus utils/empty-state.js). Bis hierher trug jede
 * leere Kachel eine Glyphe mit 60 % Deckkraft, einen Satz in Caption und einen
 * Akzent-Textknopf, der bei knapper Breite UNTER den Satz brach - Entsorgung
 * und Schnellzugriffe am Telefon, die Entsorgung auch bei 1440 und 1920. Das
 * Siegel im Kopf nennt die Kachel schon; die Zeile sagt nur noch, was fehlt,
 * und bietet am Ende den einen Weg dahin. `.widget__empty` bleibt die Klasse
 * des Traegers (Polster der Kachel, Sonden der Browser-Suiten). */
function widgetEmptyHtml(text, action = null, widgetId = '') {
  return cardEmptyRowHtml(text, { action, className: 'widget__empty', id: action && widgetId ? `widget-empty-${widgetId}` : '' });
}

// Die Aktion einer leeren Kachel fuehrt in den Modul-Flow - dasselbe
// [data-route]-System wie widget__link (wireLinks verkabelt es). Ihr Wort ist
// das VERB ("Hinzufuegen"), wo der Satz das Objekt schon nennt ("Noch keine
// Abfallarten"): "Ersten Schnellzugriff anlegen" nahm am Telefon 240px und liess
// dem Satz 80. Den Bezug fuer den Screenreader stellt `aria-describedby` her.
function emptyRouteAction(route, label) {
  return { label, attrs: { 'data-route': route } };
}

function buildTodayHighlights(data) {
  const tasks = Array.isArray(data?.tasks)
    ? data.tasks
    : Array.isArray(data?.urgentTasks)
      ? data.urgentTasks
      : [];
  const events = Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data?.upcomingEvents)
      ? data.upcomingEvents
      : [];
  const shoppingItems = Array.isArray(data?.shopping?.items) ? data.shopping.items : [];
  const shoppingLists = Array.isArray(data?.shoppingLists) ? data.shoppingLists : [];
  const meals = data?.meals ?? data?.todayMeals ?? null;

  const urgentTask = tasks.find((task) => task.priority === 'urgent') ?? tasks[0] ?? null;

  const today = householdToday();
  const todayEvents = events.filter((e) => {
    if (!e.start_datetime) return true;
    const dayKey = overviewEventSpan(e, today).day;
    return dayKey ? dayKey === today : true;
  });
  const nextEvent = todayEvents[0] ?? null;

  // DIE ZAHL DES SERVERS, wo es sie gibt (#1818): `shoppingLists` traegt
  // hoechstens drei Listen, die Summe ihrer `open_count` war bei vier Listen
  // schon zu klein (gemessen 13 gegen 14). `shoppingOpenCount` zaehlt ueber
  // alle Listen; ohne ihn (aelterer Server, Abfrage gescheitert: `null`)
  // bleibt die Summe der geladenen Listen.
  const serverOpenCount = data?.shoppingOpenCount;
  const openShoppingCount = shoppingItems.length
    ? shoppingItems.filter((item) => !item.is_checked).length
    : typeof serverOpenCount === 'number' && Number.isFinite(serverOpenCount)
    ? serverOpenCount
    : shoppingLists.reduce((sum, list) => {
        if (Number.isFinite(Number(list.open_count))) return sum + Number(list.open_count);
        if (Number.isFinite(Number(list.openCount))) return sum + Number(list.openCount);
        const items = Array.isArray(list.items) ? list.items : [];
        return sum + items.filter((item) => !item.is_checked).length;
      }, 0);
  const { meal, mealType } = selectTodayMeal(meals);

  return {
    urgentTask,
    nextEvent,
    openShoppingCount,
    meal,
    mealType,
    taskCount: tasks.length,
    eventCount: todayEvents.length,
  };
}

// Nominale Slot-Zeiten der Mahlzeiten: Mahlzeiten tragen keine Uhrzeit, brauchen
// im chronologischen Tagesprogramm aber einen Platz. Die Werte ordnen nur ein,
// sie behaupten keine Essenszeit - deshalb erscheinen sie nie als Label.
const MEAL_SORT_TIME = { breakfast: '08:00', lunch: '12:30', snack: '15:30', dinner: '18:30' };

// Die Slots im Tagesverlauf, aus denselben nominalen Zeiten: der Snack (15:30)
// liegt zwischen Mittag und Abend.
const MEAL_DAY_ORDER = Object.freeze(
  Object.keys(MEAL_SORT_TIME).sort((a, b) => MEAL_SORT_TIME[a].localeCompare(MEAL_SORT_TIME[b])),
);

// Pick the meal relevant to the current time of day (matches greeting thresholds:
// morning → breakfast, afternoon → lunch, evening → dinner). If the target meal
// is not planned, fall back to the next planned meal later today - in day order,
// snack included (#2206): seit 2.79.0 traegt `todayMeals` ihn mit an die Wand.
function selectTodayMeal(meals) {
  const order = MEAL_DAY_ORDER;
  const list = Array.isArray(meals)
    ? meals
    : meals && typeof meals === 'object'
      ? order.map((type) => (meals[type] ? { ...meals[type], meal_type: type } : null)).filter(Boolean)
      : [];

  const h = nowFields().hour;
  const targetType = h < 12 ? 'breakfast' : h < 18 ? 'lunch' : 'dinner';

  for (let i = order.indexOf(targetType); i < order.length; i++) {
    const found = list.find((m) => m.meal_type === order[i]);
    if (found) return { meal: found, mealType: order[i] };
  }
  return { meal: null, mealType: targetType };
}

/**
 * Tagesprogramm (Seele-Paket): heutige Termine, fällige Aufgaben und die nächste
 * Mahlzeit als EINE chronologische Erzählung statt drei Modul-Aggregaten.
 * Sortiert wird über einen HH:MM-Schlüssel; Zeitloses ordnet sich bewusst ein:
 * Überfälliges zuerst (00:00, es ist schon zu spät), dann Ganztägiges (00:01),
 * dann heute Fälliges ohne Uhrzeit (00:02). upcomingEvents liefert nur „ab
 * jetzt" - Vergangenes verschwindet also von selbst aus dem Programm.
 */
/**
 * Der Koch einer Mahlzeit als Person (#1679) - oder null. `todayMeals` traegt
 * ihn flach neben der Mahlzeit (`cook_user_id`, `cook_name`, `cook_color`);
 * Avatar-Stapel und Ueberlappungszeichen lesen eine Person mit `display_name`,
 * `color` und `avatar_data`.
 *
 * DAS BILD KOMMT AUS `users` DER DASHBOARD-ANTWORT, nicht aus der Mahlzeit:
 * dieselbe Liste, aus der "Wer heute dran ist" seine Gesichter nimmt - sie
 * geht mit jeder Antwort von `/dashboard` mit, auch an ein Wandtablett. Ein
 * Koch, der kein Mitglied (mehr) ist, steht dort nicht und zeigt Initialen.
 */
function mealCookPerson(meal, users) {
  if (!meal?.cook_user_id) return null;
  return {
    id: meal.cook_user_id,
    display_name: meal.cook_name ?? '',
    color: meal.cook_color ?? null,
    avatar_data: (Array.isArray(users) ? users : []).find((user) => user.id === meal.cook_user_id)?.avatar_data ?? null,
  };
}

/* WER SCHAUT (R20, Kinder-Standards). Die Seite setzt das in `render()`; die
 * Programmzeilen fragen es, damit ein Kind seine Aufgaben zuerst sieht. */
let dashboardViewer = null;

/** Ein Kinderkonto, das der Vorgabe folgt, bekommt die Kinder-Vorgabe der Kacheln. */
function childDefaultFor(config, user, followsDefault) {
  return followsDefault && user?.family_role === 'child' ? childDefaultWidgetConfig(config) : config;
}

/* Gehoert eine Aufgabe NUR anderen? Fuer ein Kind ruecken solche Zeilen ans
 * Ende des Blatts (und fallen zuerst unter „+N weitere"): eigene und
 * niemandem zugewiesene Aufgaben zuerst. Erwachsene sehen das Blatt wie
 * bisher - ihre Rolle ist es, den Ueberblick ueber alle zu haben. Nichts
 * verschwindet, die Aufgabenliste zeigt weiter alles. */
function taskForOthersOnly(task, viewer) {
  if (viewer?.family_role !== 'child' || viewer?.id == null) return false;
  const people = Array.isArray(task?.assigned_users) ? task.assigned_users : [];
  return people.length > 0 && !people.some((person) => person?.id === viewer.id);
}

/**
 * Die Zeile eines Termins im Heute-Blatt - in der Liste und als aufgeklappte
 * Zeile unter der Zeitleiste (renderTodayTimeline), damit beide dieselbe
 * Anatomie tragen.
 */
function todayEventRow(event, span) {
  // Der Platz im Tag nach der Wanduhr des HAUSHALTS: hier stand
  // `getHours()` eines Date, also die Zone des Geraets (#1457). Was schon
  // vor heute begann, steht oben bei den ganztaegigen.
  const time = !span.allDay && !span.carried ? zonedTimeKey(event.start_datetime) : '';
  return {
    kind: 'event',
    objectId: event.id,
    sortKey: time || '00:01',
    timeLabel: overviewEventTime(event, span),
    title: event.title,
    // Die Herkunft statt des Wortes „Termin" (#1698): der Name des
    // Kalenders, im Heute-Blatt wie an der Wand. „Frueh" ist erst mit
    // „Niklas Arbeitskalender" darunter eine Auskunft. Ein Termin, der nur
    // in Yuvomi lebt, hat keinen Kalendernamen - er behaelt das Wort.
    sub: eventCalendarName(event) || t('dashboard.todayEvent'),
    // Das ENDE bleibt der Wand vorbehalten (entschieden in #1698): es reist
    // neben `timeLabel` mit, und nur `renderWallRow` schreibt es dahinter.
    // Das Blatt nennt weiter den Beginn allein.
    wallTimeEnd: wallEventEnd(event, span),
    icon: 'calendar',
    tone: 'event',
    route: calendarEventRoute(event),
    who: event.assigned_users?.[0] ?? null,
    // ALLE Zugewiesenen, nicht nur das eine Gesicht der Zeile (#1828): die
    // Wand zaehlt den Termin bei jeder Person (rowPeopleIds).
    people: event.assigned_users ?? [],
    // Das am Termin gewaehlte Icon (#1829). `icon` bleibt das Zeichen des
    // Moduls; wer das eigene zeigt, fragt hasEventIcon().
    eventIcon: event.icon ?? null,
    // Beitrags-Vertrag (utils/today-sheet.js): ein Termin ist ein Rahmen
    // des Tages, kein Auftrag - er haelt die Coda nicht auf.
    priority: 40,
    open: false,
  };
}

function buildTodayProgram(data, { includeTasks = true, includeCalendar = true, includeMeals = true, now = new Date(), viewer = dashboardViewer } = {}) {
  const highlights = buildTodayHighlights(data);
  const todayKey = zonedDateKey(now);
  const nowStamp = householdNowStamp(now);
  const events = Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
  const rows = [];

  if (includeCalendar) {
    for (const event of events) {
      const span = overviewEventSpan(event, todayKey);
      if (span.day !== todayKey) continue;
      // Das Blatt verspricht, was heute NOCH ansteht (#1449): ein beendeter
      // Termin verlaesst es. Die Termin-Kachel behaelt ihn zurueckgetreten.
      if (eventHasEnded(event, nowStamp)) continue;
      rows.push(todayEventRow(event, span));
    }
  }

  if (includeTasks) {
    const tasks = Array.isArray(data?.urgentTasks) ? data.urgentTasks : Array.isArray(data?.tasks) ? data.tasks : [];
    for (const task of tasks) {
      if (!task.due_date || task.due_date > todayKey) continue;
      const overdue = task.due_date < todayKey;
      // Faelligkeit ist zonenlose Wanduhrzeit des Haushalts: Stempel, kein Date
      // (#1534). `new Date(stempel)` las die Ziffern in der Zone des GERAETS,
      // und `formatTime` rechnete den Zeitpunkt danach in die Haushaltszone -
      // auf einem Geraet in New York stand an „bis 18:00" in Berlin „bis 00:00".
      const dueTime = !overdue && task.due_time ? String(task.due_time).slice(0, 5) : null;
      const dueValid = dueTime && /^\d{2}:\d{2}$/.test(dueTime);
      const othersOnly = taskForOthersOnly(task, viewer);
      const baseKey = overdue ? '00:00' : dueValid ? dueTime : '00:02';
      rows.push({
        kind: 'task',
        objectId: task.id,
        // '~' sortiert hinter jede Uhrzeit: fremde Aufgaben eines Kindes am Ende.
        sortKey: othersOnly ? `~${baseKey}` : baseKey,
        othersOnly,
        timeLabel: overdue ? t('dashboard.overdue') : dueValid ? t('dashboard.todayUntil', { time: formatTime(`${task.due_date}T${dueTime}`) }) : '',
        overdue,
        title: task.title,
        // Begonnenes sagt es in der Unterzeile, nicht mit einem weiteren Zeichen
        // (#1251): die Zeile ist auf dem Telefon schon voll, und als Wort liest
        // es auch ein Screenreader mit.
        sub: t(task.status === 'in_progress' ? 'dashboard.todayTaskStarted' : 'dashboard.todayTask'),
        icon: 'check-square',
        tone: 'task',
        route: '/tasks',
        who: task.assigned_users?.[0] ?? null,
        people: task.assigned_users ?? [],
        priority: othersOnly ? 90 : overdue ? 10 : 30,
        open: true,
      });
    }
  }

  if (includeMeals && highlights.meal) {
    rows.push({
      kind: 'meal',
      objectId: highlights.meal.id ?? null,
      sortKey: MEAL_SORT_TIME[highlights.mealType] ?? MEAL_SORT_TIME.dinner,
      timeLabel: '',
      title: highlights.meal.title,
      sub: MEAL_LABELS()[highlights.mealType] ?? t('dashboard.todayDinner'),
      icon: MEAL_ICONS[highlights.mealType] ?? 'utensils',
      tone: 'dinner',
      // Die Mahlzeit selbst, nicht die Wurzel des Plans (R22, D3): der
      // Essensplan holt ihre Karte ins Bild und oeffnet ihr Blatt.
      route: highlights.meal.id != null ? `/meals?open=${encodeURIComponent(String(highlights.meal.id))}` : '/meals',
      // Wer kocht (#1679): dasselbe Ueberlappungszeichen wie bei Termin und
      // Aufgabe - "wen geht es an" ist bei einer Mahlzeit der Koch. Ohne Koch
      // bleibt die Zeile, wie sie war.
      who: mealCookPerson(highlights.meal, data?.users),
      priority: 80,
      open: false,
    });
  }

  rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  // Der nächste kommende Termin über heute hinaus - der beruhigende Ausblick
  // der „Heute frei"-Zeile. upcomingEvents ist „ab jetzt" sortiert, der erste
  // Eintrag eines späteren Tages ist also genau er.
  const nextUpcoming = events.find((event) => eventOccurrenceDateKey(event) > todayKey) ?? null;

  // Und die nächste fällige Aufgabe über heute hinaus: die Beruhigung darf
  // nicht um Mitternacht enden (Critique P3). urgentTasks ist nach Fälligkeit
  // sortiert - der erste Eintrag eines späteren Tages ist die nächste Frist.
  // Ohne sie verspräche die Fläche abends „nichts mehr", während der
  // Schulausflug-Zettel morgen früh abgegeben werden muss.
  const allTasks = Array.isArray(data?.urgentTasks) ? data.urgentTasks : Array.isArray(data?.tasks) ? data.tasks : [];
  const laterTasks = allTasks.filter((task) => task.due_date && task.due_date > todayKey);
  const nextDueTask = laterTasks.find((task) => !taskForOthersOnly(task, viewer)) ?? laterTasks[0] ?? null;

  return {
    rows,
    nextUpcoming,
    nextDueTask,
    openShoppingCount: highlights.openShoppingCount,
    tasksDoneToday: Number(data?.tasksDoneToday) || 0,
  };
}

/**
 * Wen eine Programmzeile angeht - JEDE zugewiesene Person, einmal (#1828).
 * Die Zeile selbst zeigt ein Gesicht (`who`); gezaehlt hat die Wand deshalb
 * nur dieses eine, und ein Termin fuer zwei stand bei einer Person. Zeilen
 * ohne Liste (das Kochen, Beitraege anderer Module) bleiben bei `who`.
 */
function rowPeopleIds(row) {
  const ids = (Array.isArray(row.people) ? row.people : [])
    .map((person) => person?.id)
    .filter((id) => id != null);
  if (ids.length) return [...new Set(ids)];
  return row.who?.id != null ? [row.who.id] : [];
}

// --------------------------------------------------------
// Skeleton
// --------------------------------------------------------

function skeletonWidget(lines = 3) {
  const lineHtml = Array.from({ length: lines }, (_, i) => `
    <div class="skeleton skeleton-line ${i % 2 === 0 ? 'skeleton-line--full' : 'skeleton-line--medium'}"></div>
  `).join('');
  return `
    <div class="widget-skeleton">
      <div class="skeleton skeleton-line skeleton-line--short"></div>
      ${lineHtml}
    </div>
  `;
}

// --------------------------------------------------------
// Widget-Renderer
// --------------------------------------------------------

const TASK_STATUS_IN_PROGRESS = () => t('tasks.statusInProgress');

/* EIN ZEILENGERUEST FUER ALLE LISTEN-KACHELN (Critique DW, DW-P1-4). Die
 * Kachel ist der EINE Traeger ihrer Zeilen (Zeilenlisten-Regel, Fall "Liste IN
 * einer Karte"): die Folge traegt nur `.row-divided`, jede Zeile ist die
 * geteilte `.list-row` mit Fuehrung (`.list-row__lead`, 32px: Avatar, Siegel
 * oder Glyphe), Textspalte (`.list-row__name` 16/500 + `.list-row__meta` 13)
 * und hoechstens einer Endzone (`.list-row__end`). Vorher standen neun
 * Zeilen-Dialekte in einem Raster (Titel 15/600 bis 17/600, Fuehrung 5 bis
 * 40px, drei Trennerformen). Was die Liste kommentiert ("+N weitere"), steht
 * ausserhalb - eine Fussnote ist kein Eintrag. */
function widgetRows(rows, { tag = 'div', className = '' } = {}) {
  return `<${tag} class="widget__rows row-divided${className ? ` ${className}` : ''}">${rows}</${tag}>`;
}


/* Die Zeilen folgen der Groesse wie bei jeder Liste (`listRowCap`, #2087):
 * der Server liefert die fuenf dringendsten fuer die hohe Fassung, eine
 * 1x1-Kachel zeigt davon drei. Ohne Groesse ist es die Vorgabe der Kachel. */
function renderUrgentTasks(allTasks, openTotal = null, size = '1x2') {
  const cap = listRowCap(size);
  const fill = fillRows(allTasks.length, cap);
  const tasks = allTasks.slice(0, cap + fill);
  const span = tileSpanAttrs((s, k = 0) => ({ items: allTasks.length, total: listTotal(openTotal, allTasks.length), cap: listRowCap(s) + k }), size, fill);
  if (!tasks.length) {
    return `<div class="widget widget--tasks"${span}>
      ${widgetHeader('tasks', t('nav.tasks'), 0, '/tasks')}
      ${widgetEmptyHtml(t('dashboard.allDone'))}
    </div>`;
  }

  const items = tasks.map((t, index) => {
    const due = formatDueDate(t.due_date, t.due_time);
    // Begonnen traegt dasselbe Zeichen wie in der Aufgabenliste (#1251), keine
    // eigene Bauart, und es steht in der Fuehrung der Zeile: dort, wo sonst der
    // Prioritaetspunkt steht (DW-P1-4 - EIN Zeichen je Fuehrung). Das Wort steht
    // als sr-only daneben, weil die Zeile role="button" ist und ihre Kinder damit
    // keine eigene Rolle mehr tragen - ein role="img" am Ring waere dort verloren.
    const started = t.status === 'in_progress';
    const lead = started
      ? '<span class="task-status-btn task-status-btn--in_progress task-status-btn--static" aria-hidden="true"></span>'
      : t.priority !== 'none'
        ? `<span class="task-item__priority task-item__priority--${t.priority}" title="${esc(PRIORITY_LABELS()[t.priority] ?? t.priority)}"></span>`
        : '';
    return `
      <div class="list-row task-item" data-task-id="${t.id}" data-task-title="${esc(t.title)}" role="button" tabindex="0"${fillRowAttr(index, cap)}>
        <span class="list-row__lead task-item__lead" aria-hidden="true">${lead}</span>
        <span class="sr-only">${PRIORITY_LABELS()[t.priority] ?? t.priority}</span>
        ${started ? `<span class="sr-only">${esc(TASK_STATUS_IN_PROGRESS())}</span>` : ''}
        <div class="list-row__main task-item__content">
          <div class="list-row__name task-item__title">${esc(t.title)}</div>
          ${due ? `<div class="list-row__meta task-item__meta${due.overdue ? ' task-item__meta--overdue' : ''}${due.soon ? ' task-item__meta--soon' : ''}">${due.text}</div>` : ''}
        </div>
        ${renderAvatarStack(t.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  // `urgentTasks` sind die fuenf dringendsten, `openTaskCount` alle offenen
  // (siehe listTotal); die Fusszeile nennt, was nicht in DIESER Groesse steht.
  const total = listTotal(openTotal, allTasks.length);
  return `<div class="widget widget--tasks"${span}>
    ${widgetHeader('tasks', t('nav.tasks'), total, '/tasks')}
    <div class="widget__body widget__body--rows">${widgetRows(items)}${listMoreLine('dashboard.tasksMore', total - Math.min(tasks.length, cap), fill)}</div>
  </div>`;
}

/* BEENDETE TERMINE TRETEN ZURUECK, UND DAS LIMIT ZAEHLT NUR KOMMENDES (#1449).
 *
 * Die Kachel las nie die Endzeit: ein Termin, der um 9:00 vorbei war, sah aus
 * wie einer um 18:00, und fuenf vorbeie fuellten das Limit, waehrend der um
 * 21:00 fehlte. Der Server liefert das Kommende jetzt ungedeckelt vom
 * Vergangenen (`keepEndedToday`); hier entscheidet die Uhr, was davon vorbei
 * ist - auch zwischen zwei Abrufen.
 *
 * Die zwei juengsten beendeten stehen zurueckgetreten UEBER dem Kommenden
 * (chronologisch sind sie frueher), der Rest faltet sich in eine Zahl: an einem
 * vollen Tag waeren sonst sechs vergangene Zeilen der Inhalt der Kachel.
 * Zurueckgetreten heisst: Farbe statt Deckung (#1230) und ein Wort im Etikett
 * statt „Heute" - der Zustand haengt nicht an der Farbe allein.
 *
 * SEIT #2087 ZAEHLEN SIE INNERHALB DER ZEILEN, aber NACH dem Kommenden. Die
 * Kachel hat so viele Zeilen, wie ihre Groesse erlaubt (`calendarRowCap`);
 * zwei beendete obendrauf machten eine 1x1-Kachel fuenf Zeilen hoch und
 * streckten die Rasterzeile ihrer Nachbarn. Das Kommende fuellt zuerst, die
 * beendeten nehmen nur, was frei bleibt (hoechstens zwei) - abends, wenn
 * nicht mehr viel kommt, stehen sie also wieder da. Den Kern von #1449 haelt
 * das: ein Vergangenes verdraengt nie ein Kommendes. */
const ENDED_EVENTS_SHOWN = 2;

/* Wie viele Kommende, steht in den Optionen der Kachel (#1680) und geht durch
 * dieselbe Klemme wie der Parameter der Route (`clampEventLimit`) - in den
 * hohen Groessen. Eine 1x1-Kachel zeigt die Zeilen ihrer Groesse wie jede
 * Liste (`calendarRowCap`, #2087). Die Kachel schneidet trotzdem selbst: im
 * Anpassen-Modus steht bis zum Speichern die alte Antwort da, und wer von
 * zwoelf auf fuenf zurueckstellt, soll fuenf sehen und nicht zwoelf bis zum
 * naechsten Abruf. */
function renderUpcomingEvents(allEvents, { now = new Date(), limit = EVENT_LIMIT_DEFAULT, rows = clampEventLimit(limit), span = '', fill = 0 } = {}) {
  const todayKey = zonedDateKey(now);
  const nowStamp = householdNowStamp(now);
  const endedToday = allEvents.filter((e) => overviewEventSpan(e, todayKey).day === todayKey && eventHasEnded(e, nowStamp));
  const aheadAll = allEvents.filter((e) => !endedToday.includes(e));
  const ahead = aheadAll.slice(0, rows);
  const endedRoom = Math.min(ENDED_EVENTS_SHOWN, rows - ahead.length);
  const ended = endedRoom > 0 ? endedToday.slice(-endedRoom) : [];
  const folded = endedToday.length - ended.length;
  // Zusatzzeilen (U14): die naechsten Kommenden, hinter der Liste. Die
  // Beendeten bleiben, wie die Groesse sie gewaehlt hat.
  const extraAhead = aheadAll.slice(ahead.length, ahead.length + Math.max(0, fill));
  const events = [...ended, ...ahead, ...extraAhead];
  const firstExtra = ended.length + ahead.length;
  if (!events.length) {
    return `<div class="widget widget--calendar"${span}>
      ${widgetHeader('calendar', t('nav.calendar'), 0, '/calendar')}
      ${widgetEmptyHtml(t('dashboard.noEvents'))}
    </div>`;
  }

  // Der Tagesvergleich ueber KEYS, nicht ueber `toDateString()`: das las die
  // Browser-Zone und machte „heute" zu einer Frage an das Geraet (#851).
  const today = todayKey;
  const items = events.map((e, index) => {
    const span = overviewEventSpan(e, today);
    const dayKey = span.day;
    const isToday = dayKey === today;
    const isEnded = ended.includes(e);
    const _suffix = timeSuffix();
    // Was gestern begann, nennt nicht seine Startzeit von gestern (#1457).
    const timeStr = span.until || span.allDay
      ? overviewEventTime(e, span)
      : `${formatTime(e.start_datetime)}${_suffix ? ' ' + _suffix : ''}`.trim();
    // EINE METAZEILE: "Heute · 17:00 · Sportplatz West" (DW-P2-10). Das Etikett
    // stand als Pille vor der Zeit und brach am Telefon in eine eigene Zeile
    // (Termin dreizeilig); der Kalendername stand immer allein darunter. Jetzt
    // ist der Tag das erste Wort der Zeile, der Zustand haengt weiter nicht an
    // der Farbe allein ("Vorbei" statt "Heute").
    const when = isEnded ? t('dashboard.eventEnded') : isToday ? t('common.today') : relativeDateLabel(dayKey);
    const rest = [timeStr, e.location ? fmtLocation(e.location) : '', e.cal_name || ''].filter(Boolean).map((part) => esc(part));
    const whenClass = isToday && !isEnded ? ' event-item__when--today' : '';
    return `
      <div class="list-row event-item${isEnded ? ' event-item--ended' : ''}" data-route="${esc(calendarEventRoute(e))}" role="button" tabindex="0"${fillRowAttr(index, firstExtra)}>
        <!-- Dieselbe Regel wie im Kalender, aus derselben Datei. Hier stand
             e.color || e.cal_color - dieselbe Frage ohne den Zweig fuer die
             zugewiesene Person, was seit #891 zwei verschiedene Antworten
             gegeben haette. -->
        <span class="list-row__lead event-item__lead" aria-hidden="true"><span class="event-item__bar" style="background-color:${esc(resolveEventColor(e))}"></span></span>
        <div class="list-row__main event-item__content">
          <div class="list-row__name event-item__title">${esc(e.title)}</div>
          <div class="list-row__meta event-item__time"><span class="event-item__when${whenClass}">${esc(when)}</span>${rest.map((part) => ` · ${part}`).join('')}</div>
        </div>
        ${renderAvatarStack(e.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  // HOECHSTENS EINE ZUSATZZEILE (Codex-Review zu PR #2117). Jede 1x1-Liste
  // traegt drei Zeilen plus „+N weitere"; Faltzeile UND Fusszeile machten die
  // volle 1x1-Kachel eine Zeile hoeher und streckten die Nachbarzeile wieder.
  // Stehen beide an, teilen sie sich die Fusszeile, das Fruehere zuerst (die
  // Zeitfolge der Kachel); sonst bleibt die Faltzeile ueber dem Kommenden.
  const moreAhead = rows < clampEventLimit(limit) && aheadAll.length > ahead.length;
  const earlierText = folded > 0 ? t('dashboard.eventsEndedMore', { count: folded }) : '';
  const earlier = earlierText && !moreAhead
    ? `<p class="event-list__earlier">${esc(earlierText)}</p>`
    : '';
  // KEINE BADGE: die Liste ist nach vorn offen und bei der gewaehlten Stufe
  // (5, 8 oder 12) geschnitten, eine Gesamtzahl gibt es nicht. „5" stuende
  // genau so lange da, wie mindestens fuenf Termine kommen - eine Zahl, die
  // nur ihre eigene Obergrenze nennt. Beendete zaehlen ohnehin nie mit (#1449).
  // Aus demselben Grund traegt die Fusszeile keine Zahl, wenn die Groesse
  // weniger zeigt, als geladen ist (#2087): „+2 weitere" hiesse „fuenf geladen,
  // drei gezeigt" und laege bei dreissig kommenden Terminen. Sie steht an der
  // Stelle und in der Form des „+N weitere" der anderen Listen.
  // Stehen alle Zusatzzeilen, ist nichts Kommendes mehr verborgen: die Zeile
  // geht, oder sie behaelt die Faltzeile (`data-more-done`).
  const more = moreAhead
    ? `<p class="widget-list-more"${fillMoreAttrs(extraAhead.length, extraAhead.length, '', earlierText)}>${esc([earlierText, t('dashboard.eventsMoreAhead')].filter(Boolean).join(' · '))}</p>`
    : '';
  return `<div class="widget widget--calendar"${span}>
    ${widgetHeader('calendar', t('nav.calendar'), null, '/calendar')}
    <div class="widget__body widget__body--rows">${earlier}${widgetRows(items)}${more}</div>
  </div>`;
}

/* „DIESE WOCHE" - DER KALENDER IN 2x1 IST EIN STREIFEN, KEINE LISTE.
 *
 * Eine GROESSE des bestehenden Widgets und kein eigenes: die Frage ist
 * dieselbe (was steht an), nur der Zuschnitt ein anderer, und die Filter
 * („nur meine", Geburtstage), die Rechte und der Kopf gehoeren schon dem
 * Kalender-Widget. Ein zweites Widget haette sie doppelt gefuehrt und im
 * Anpassen-Tray eine weitere Kachel neben den einundzwanzig gestellt. Auf 2x1
 * war die Liste ohnehin die schwaechste Form - drei Zeilen in einer Breite,
 * die sieben Tage nebeneinander traegt.
 *
 * Kein Titel je Termin im Bild: der Streifen sagt, wie voll die Woche ist und
 * wer, nicht was. Wer es wissen will, tippt den Tag und landet in dessen
 * Tagesansicht (`/calendar?date=`); die Titel stehen im Tooltip und die Zahl
 * im zugaenglichen Namen des Tages. */
const WEEKDAY_SHORT_KEYS = ['dayShortSunday', 'dayShortMonday', 'dayShortTuesday', 'dayShortWednesday', 'dayShortThursday', 'dayShortFriday', 'dayShortSaturday'];
const WEEKDAY_LONG_KEYS = ['dayLongSunday', 'dayLongMonday', 'dayLongTuesday', 'dayLongWednesday', 'dayLongThursday', 'dayLongFriday', 'dayLongSaturday'];

function renderWeekStrip(weekEvents, span = '') {
  // Geburtstage tragen serverseitig einen sprachneutralen Titel (#524) - hier
  // und nicht im Ladepfad uebersetzt, weil der Titel nur im Tagesnamen steht.
  const events = (Array.isArray(weekEvents) ? weekEvents : []).map(localizeBirthdayEvent);
  const strip = buildWeekStrip(events, householdToday());
  const lanes = strip.laneCount;
  const days = strip.days.map((day) => {
    const column = day.index + 1;
    const dateLabel = `${t(`calendar.${WEEKDAY_LONG_KEYS[day.weekday]}`)}, ${formatDayMonth(day.key)}`;
    const countLabel = day.count ? t('dashboard.weekDayEvents', { count: day.count }) : t('dashboard.noEvents');
    const label = `${dateLabel}${day.isToday ? `, ${t('common.today')}` : ''}: ${countLabel}`;
    const route = `/calendar?date=${day.key}`;
    const dots = day.dots.map((dot) => `<span class="week-strip__dot" style="--dot-color:${esc(dot.color)}"></span>`).join('');
    const more = day.more ? `<span class="week-strip__more">+${day.more}</span>` : '';
    return `
      <a href="${route}" data-route="${route}" class="week-strip__day${day.isToday ? ' week-strip__day--today' : ''}"
         style="grid-column:${column};grid-row:1 / span ${lanes + 2}" ${day.isToday ? 'aria-current="date"' : ''}
         aria-label="${esc(label)}"${day.titles.length ? ` title="${esc(day.titles.join(', '))}"` : ''}></a>
      <span class="week-strip__head${day.isToday ? ' week-strip__head--today' : ''}" style="grid-column:${column}" aria-hidden="true">
        <span class="week-strip__weekday">${esc(t(`calendar.${WEEKDAY_SHORT_KEYS[day.weekday]}`))}</span>
        <span class="week-strip__date">${day.dayOfMonth}</span>
      </span>
      <span class="week-strip__dots" style="grid-column:${column};grid-row:${lanes + 2}" aria-hidden="true">${dots}${more}</span>`;
  }).join('');
  const bands = strip.bands.map((band) => `
      <span class="week-strip__band${band.continuesBefore ? ' week-strip__band--before' : ''}${band.continuesAfter ? ' week-strip__band--after' : ''}"
            style="grid-column:${band.startIndex + 1} / ${band.endIndex + 2};grid-row:${band.lane + 2};--dot-color:${esc(band.color)}"
            aria-hidden="true"></span>`).join('');
  const empty = strip.days.every((day) => day.count === 0)
    ? `<p class="week-strip__empty">${t('dashboard.weekStripEmpty')}</p>`
    : '';
  return `<div class="widget widget--calendar widget--week"${span}>
    ${widgetHeader('calendar', t('dashboard.weekStripTitle'), null, '/calendar')}
    <div class="widget__body">
      <div class="week-strip">${days}${bands}</div>
      ${empty}
    </div>
  </div>`;
}

/** Das Kalender-Widget in seiner Groesse: 2x1 ist die Woche, alles andere die Liste.
 *  Die Stufe aus den Optionen (#1680) gilt nur der hohen Liste - die Woche
 *  zeigt sieben Tage, keine Zeilen, und 1x1 die Zeilen seiner Groesse. */
function renderCalendarWidget(data, size, options = {}) {
  const model = calendarTileModel(data, options);
  const fill = model.fillFor(size ?? '1x2');
  const span = tileSpanAttrs(model, size ?? '1x2', fill);
  return nearestPreset(size ?? '1x2') === '2x1'
    ? renderWeekStrip(data?.weekEvents, span)
    : renderUpcomingEvents(data?.upcomingEvents ?? [], { limit: options?.limit, rows: calendarRowCap(size, options?.limit), span, fill });
}

/* Die Hoehe der Kalenderkachel in jeder Groesse (U1 b) - dieselbe Rechnung wie
 * renderUpcomingEvents: wie viele Kommende, wie viele Beendete, und ob unter
 * der Liste "+N weitere" oder ueber ihr die Faltzeile steht (beide eine
 * Footnote-Zeile). 2x1 ist der Wochenstreifen: Kopfzeile, eine Spur je
 * Mehrtagesband, die Punktzeile und ggf. der Satz "keine Termine". */
function calendarTileModel(data, options = {}, now = new Date()) {
  const limit = options?.limit;
  const allEvents = data?.upcomingEvents ?? [];
  const todayKey = zonedDateKey(now);
  const nowStamp = householdNowStamp(now);
  const endedToday = allEvents.filter((e) => overviewEventSpan(e, todayKey).day === todayKey && eventHasEnded(e, nowStamp));
  const aheadAll = allEvents.length - endedToday.length;
  let week = null;
  const model = (s, k = 0) => {
    if (nearestPreset(s) === '2x1') {
      week ??= (() => {
        const strip = buildWeekStrip((Array.isArray(data?.weekEvents) ? data.weekEvents : []).map(localizeBirthdayEvent), householdToday());
        const empty = strip.days.every((day) => day.count === 0);
        return { body: TILE_PARTS.weekBase + strip.laneCount * TILE_PARTS.weekLane + (empty ? TILE_PARTS.weekEmpty : 0) };
      })();
      return week;
    }
    const cap = calendarRowCap(s, limit);
    const aheadN = Math.min(aheadAll, cap);
    const endedN = Math.min(endedToday.length, Math.max(0, Math.min(ENDED_EVENTS_SHOWN, cap - aheadN)));
    const moreAhead = cap < clampEventLimit(limit) && aheadAll > aheadN;
    // Mit k Zusatzzeilen (U14) stehen k Kommende mehr da; sind es alle, geht
    // "Weitere Termine", und die Faltzeile bleibt unten in seiner Form.
    const extra = moreAhead ? Math.min(Math.max(0, k), aheadAll - aheadN) : 0;
    const folded = endedToday.length > endedN;
    const aux = moreAhead && aheadN + extra < aheadAll ? TILE_GEOMETRY.more
      : moreAhead && extra && folded ? TILE_GEOMETRY.more
        : moreAhead && extra ? 0
          : moreAhead ? TILE_GEOMETRY.more : folded ? TILE_PARTS.earlier : 0;
    return { items: aheadN + endedN + extra, extra: aux };
  };
  // Wie viele Kommende die Groesse geladen, aber nicht gezeigt hat - ohne
  // "Weitere Termine" keine (die Liste zeigt dann schon alles).
  model.fillFor = (s) => {
    if (nearestPreset(s) === '2x1' || onPhoneStage()) return 0;
    const cap = calendarRowCap(s, limit);
    return cap < clampEventLimit(limit) ? Math.max(0, aheadAll - Math.min(aheadAll, cap)) : 0;
  };
  return model;
}

/**
 * WIE VIELE ZEILEN EINE LISTENKACHEL ZEIGT, STEHT IN IHRER HOEHE.
 *
 * Bis hierher war jede Zeilenzahl eine Konstante irgendwo zwischen Server und
 * Renderer - und damit dieselbe fuer eine Kachel, die eine Rasterzeile hoch ist,
 * und fuer eine, die zwei belegt. Die hohe Fassung lief deshalb unten leer, und
 * das war kein Layoutfehler, sondern fehlender Nachschub.
 *
 * Die Regel steht HIER und nicht an den Aufrufstellen, damit die naechste
 * Listenkachel sie erbt statt eine eigene Zahl zu erfinden. Sie liest den
 * Zeilen-Span der Groessenklasse (`<spalten>x<zeilen>`), nicht die Pixelhoehe:
 * die kennt erst der Browser, und eine Zeilenzahl, die vom Messzeitpunkt
 * abhaengt, springt beim Laden.
 *
 * DIE REGEL GILT AUCH FUER KALENDER UND AUFGABEN (#2087, D#2038). Beide waren
 * Ausnahmen: der Kalender zeigte seine Stufe (5/8/12) plus zwei beendete in
 * jeder Groesse, die Aufgaben bekamen gar keine Groesse und zeigten immer
 * fuenf. Eine 1x1-Kachel wurde so hoeher als eine Rasterzeile, und weil die
 * Zeile mit ihrer hoechsten Kachel waechst (`grid-auto-rows: minmax(132px,
 * auto)`), stand bei den Nachbarn „+N weitere" ueber leerem Raum. Jetzt:
 *   - 1x1 zeigt drei Zeilen, auch Kalender und Aufgaben, plus Fusszeile.
 *   - Hoch zeigt fuenf; beim Kalender die Stufe aus seinen Optionen. Eine
 *     laengere Liste ist eine hoehere Kachel, nicht eine hoehere Zeile der
 *     Nachbarn. Seit U1 b (DW-P1-3) ist das die Regel fuer JEDE Liste: die
 *     Zahl hier ist die Obergrenze, die Hoehe kommt aus den gezeigten Zeilen
 *     (`tileSpanAttrs` -> `contentSpanRows`). Darstellung, keine gespeicherte
 *     Groesse.
 *   - Beendete Termine zaehlen innerhalb der Zeilen, nach dem Kommenden
 *     (`ENDED_EVENTS_SHOWN`).
 *   - Die Wand hat ihren eigenen Deckel (`WALL_ROW_CAP`) und liest weder
 *     Groesse noch Stufe.
 * NICHT geloest ist die Pixelvarianz zwischen Kacheltypen: eine Notizzeile ist
 * hoeher als eine Geburtstagszeile, drei Zeilen sind also nicht ueberall
 * gleich hoch.
 */
const LIST_ROWS_SHORT = 3;
const LIST_ROWS_TALL = 5;

/* DIE TELEFON-BUEHNE (R14, A7 P2-2). Unter 640px ist das Raster eine Spalte
 * und die Uebersicht ein Scroll von 3,8 Bildschirmen (gemessen 3192px bei
 * 390x844); jede hohe Kachel trug dort fuenf Zeilen, obwohl ihre Hoehe nicht
 * neben einer Nachbarin stand, sondern unter ihr. Dieselbe Grenze wie der
 * Anpassen-Kopf (dashboard.css, 639px), damit beide dieselbe Frage gleich
 * beantworten. Ohne `matchMedia` (Node-Tests, alte Umgebungen) ist es die
 * breite Buehne - dort aendert sich nichts. */
const PHONE_STAGE_QUERY = '(max-width: 639px)';

function onPhoneStage() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(PHONE_STAGE_QUERY)?.matches);
  } catch {
    return false;
  }
}

function isTallSize(size) {
  return Number(String(size ?? '1x1').split('x')[1]) >= 2;
}

function listRowCap(size) {
  if (onPhoneStage()) return LIST_ROWS_SHORT;
  return isTallSize(size) ? LIST_ROWS_TALL : LIST_ROWS_SHORT;
}

/* Die Zeilen der Kalenderliste: hoch die Stufe aus den Optionen (#1680), sonst
 * die der Groesse. Auf der Telefon-Buehne bleibt es fuer die hohe Fassung bei
 * der Stufe: dort steht die Kachel unter, nicht neben einer Nachbarin, und
 * #1676 hat zugesagt, dass eine laengere Liste eine hoehere Kachel ist. */
function calendarRowCap(size, limit) {
  return isTallSize(size ?? '1x2') ? clampEventLimit(limit) : listRowCap(size);
}

/* DIE KACHEL SAGT AUS IHREN DATEN, WIE HOCH SIE IST (DW-P1-3, U1 b).
 *
 * Jeder Renderer beschreibt seinen Inhalt als Funktion der Groesse
 * (`model(size)` -> `contentSpanRows`, utils/dashboard-widgets.js): so viele
 * Zeilen, wie die Daten hergeben und die Groesse erlaubt, oder die Hoehe seines
 * festen Aufbaus. Daraus wird die Zahl der Rasterspuren, die er belegt -
 * `data-span-rows` an seiner Wurzel, beim Zeichnen ausgerechnet, bevor das
 * Raster ausgelegt wird. Fuer die anderen drei Groessen steht die Zahl gleich
 * daneben (`data-span-sizes`): der Lueckenhinweis probiert Groessen aus und
 * muss wissen, wie hoch die Kachel in jeder waere, ohne sie neu zu zeichnen.
 *
 * Der Rahmen (`renderWidgetWrapper`) hebt beides an sich und setzt
 * `--tile-rows`; dashboard.css macht daraus die Spanne. Die Stufe der
 * Kalenderliste (#2087, 5/8/12 Termine) war bis hierher ein eigenes Attribut
 * mit eigenen Spannen - jetzt ist sie, was sie immer war: die Obergrenze einer
 * Liste, deren Hoehe aus ihren Zeilen kommt. */
const SPAN_SIZES = WIDGET_SIZE_PRESETS.map((p) => p.value);

/* FESTE TEILE EINZELNER KACHELN in px, ab 768px (dashboard.css; gemessen
 * 2026-10-27 bei 768, 1024, 1440 und 1920px, Grundschrift 16px). Was eine
 * Liste aus Zeilen ist, rechnet TILE_GEOMETRY; hier steht, was eine Kachel
 * ausser Zeilen traegt. Aendert sich eine dieser Regeln, aendert sich hier die
 * Zahl - `test:dashboard` haelt die Liste vollstaendig. */
const TILE_PARTS = Object.freeze({
  // Kalender 2x1, der Wochenstreifen: Kopf- und Punktzeile, je Band eine Spur.
  weekBase: 100.4,
  weekLane: 10,
  weekEmpty: 27,
  // Die Faltzeile "N frueher" ueber der Terminliste (Footnote + 4px).
  earlier: 23,
  wasteWarning: 40,
  // Koerper (unter dem Kopf) der Kacheln mit eigenem Aufbau, je Groesse.
  weather: { '1x1': 102, '1x2': 234, '2x1': 125, '2x2': 142 },
  clock: { '1x1': 109, '1x2': 133, '2x1': 111, '2x2': 135 },
  // Koerper- plus Innenpolster der Kacheln Gesundheit, Zyklus, Haushaltshilfe.
  statusPad: 60,
  healthProgress: 26.5,
  statusLine: 35.5,
  statusChip: 46,
  healthNone: 23.5,
  cycleRing: 60,
  cycleInfo: 44.6,
  cycleDate: 21.1,
  housekeepingStatus: 44.6,
  // Fasten: Ring neben Satz und Knoepfen; schmal stehen die Knoepfe untereinander.
  fasting: { wide: 148, narrow: 166.2 },
  fastingActive: { wide: 243.9, narrow: 335.9 },
  nutritionPad: 60,
  nutritionRow: 22,
  nutritionGap: 8,
  nutritionCount: 31.1,
  budgetPad: 32,
  budgetHeadline: 68,
  budgetSavings: 53,
  budgetSavingsBare: 37,
  budgetGoal: 52,
  budgetFlow: 48.2,
  budgetTopOne: 34,
  budgetTopList: 46.2,
  budgetTopRow: 25,
  mealsPad: 28,
  mealSlot: 69.2,
  mealSlotTwoLines: 91.2,
  mealGap: 8,
  familyPad: 24,
  familyMore: 27.1,
  familyFooter: 28.7,
  rewardsMember: 77.4,
  rewardsMemberCompact: 54.5,
  rewardsGap: 12,
  rewardsFooter: 52,
  rewardsMore: 19.1,
  rewardsSelfPad: 28,
  rewardsSelfGoal: 67.5,
  rewardsRecentTitle: 30,
  rewardsRecentRow: 28,
  notesPad: 28,
  notesGap: 12,
  noteCard: 24,
  noteTitle: 24.1,
  noteContent: 41.5,
  noteCategories: 26,
  notesMore: 31.1,
  shoppingList: 58,
  shoppingItem: 19.5,
  shoppingItemGap: 4,
  shoppingMore: 31.1,
  shoppingNothing: 23.5,
  metricCard: 119,
  metricGap: 20,
  quickLinksPad: 12,
  quickLinkTile: 100.3,
  quickLinkGap: 8,
});

/** Die Spalten, die eine Groesse ab 768px belegt: 1 oder 2 (3x/4x auch 2+). */
function tileColumns(size) {
  return Number(String(size ?? '1x1').split('x')[0]) >= 2 ? 2 : 1;
}

/** Eine Kachel ohne Eintrag: Kopf und genau die Leerzeile, in jeder Groesse. */
function emptySpanAttrs(size) {
  return tileSpanAttrs(() => ({ items: 0 }), size ?? '1x1');
}

/* `fill` (U14): so viele Zeilen hat die Kachel ueber das hinaus geladen, was
 * ihre Groesse zeigt. `model(size, k)` beschreibt sie dann mit k Zusatzzeilen,
 * und `data-fill-steps` sagt fuer k = 1 ... fill die Spuren, die sie dafuer
 * braeuchte (`fillRowCount`, applyRowFill). Die Spanne selbst bleibt die ohne
 * Zusatzzeilen - die Packung sieht sie nie. */
function tileSpanAttrs(model, size, fill = 0) {
  // Am Telefon steht jede Kachel in ihrer eigenen Hoehe untereinander (eine
  // Spalte, kein Raster aus Spuren): dort wird nichts gerechnet. Ein Wechsel
  // zur breiten Buehne baut die Uebersicht neu (createPhoneProgramFit).
  if (onPhoneStage()) return '';
  const rowsAt = (s, k = 0) => contentSpanRows(model(s, k) ?? {}).rows;
  const sizes = [...new Set([...SPAN_SIZES, size].filter(Boolean))];
  const steps = Array.from({ length: Math.max(0, fill | 0) }, (_, i) => rowsAt(size, i + 1));
  return ` data-span-rows="${rowsAt(size)}" data-span-sizes="${sizes.map((s) => `${s}:${rowsAt(s)}`).join(',')}"`
    + (steps.length ? ` data-fill-steps="${steps.join(',')}"` : '');
}

/** Die Spanne aus dem Markup eines Renderers (erstes `data-span-rows`). */
function tileSpanOf(html) {
  const rows = /\sdata-span-rows="(\d+)"/.exec(String(html ?? ''))?.[1];
  const sizes = /\sdata-span-sizes="([0-9x:,]*)"/.exec(String(html ?? ''))?.[1];
  const steps = /\sdata-fill-steps="([0-9,]*)"/.exec(String(html ?? ''))?.[1];
  return rows ? { rows: Number(rows), sizes: sizes ?? '', steps: steps ?? '' } : null;
}

/** Die Attribute des Rahmens: Spanne und, als Wert fuer dashboard.css, `--tile-rows`. */
function tileSpanWrapperAttrs(html) {
  const span = tileSpanOf(html);
  return span
    ? ` data-span-rows="${span.rows}" data-span-sizes="${esc(span.sizes)}"${span.steps ? ` data-fill-steps="${esc(span.steps)}"` : ''} style="--tile-rows: ${span.rows}"`
    : '';
}

/* DIE ZUSATZZEILEN (U14): wie viele Zeilen eine Liste ueber ihre Groesse hinaus
 * mitbringt - die geladenen, die sie nicht zeigt, hoechstens sechs (die
 * groesste gemessene Streckung, Familie bei zwei Spalten 359px, traegt keine
 * sieben Zeilen; Entsorgung und Schichtplan liefern ungedeckelt). Am Telefon
 * keine: dort wird nicht gestreckt. */
const FILL_ROWS_MAX = 6;
function fillRows(loaded, shown) {
  return onPhoneStage() ? 0 : Math.min(FILL_ROWS_MAX, Math.max(0, (Number(loaded) || 0) - (Number(shown) || 0)));
}

/** Markiert die i-te Zeile einer Liste als Zusatzzeile, wenn sie hinter `cap` steht. */
function fillRowAttr(index, cap) {
  return index >= cap ? ' data-fill-row' : '';
}

/* "+N weitere" kennt seine Zusatzzeilen: applyRowFill zaehlt herunter
 * (`data-more-key`, `data-more-rest`) und nimmt die Zeile weg, wenn alles
 * steht - oder setzt dann `data-more-done` (der Kalender behaelt seine
 * Faltzeile). */
function fillMoreAttrs(fill, rest, key = '', done = '') {
  if (!(fill > 0)) return '';
  return ` data-fill-more data-more-rest="${rest}"${key ? ` data-more-key="${esc(key)}"` : ''}${done ? ` data-more-done="${esc(done)}"` : ''}`;
}

/* Die zuletzt gezeichnete Spanne je Kachel - fuer den Layout-Hinweis, der dem
 * Skelett beim naechsten Laden dieselben Hoehen vorhersagt (DW-P2-5, U1 b). */
const drawnSpanRows = new Map();
function drawnSpanOf(w) {
  return drawnSpanRows.get(w?.id) ?? null;
}

/** Ein neu gezeichneter Koerper bringt seine Spanne an den vorhandenen Rahmen (Geste, U1 b). */
function setTileSpan(el, html) {
  const span = tileSpanOf(html);
  if (el.dataset?.widgetId) drawnSpanRows.set(el.dataset.widgetId, span?.rows ?? 0);
  // Der neue Koerper zeigt noch keine Zusatzzeile (U14); applyRowFill setzt sie.
  delete el.dataset.fillShown;
  if (!span?.steps) delete el.dataset.fillSteps;
  else el.dataset.fillSteps = span.steps;
  if (!span) {
    el.removeAttribute('data-span-rows');
    el.removeAttribute('data-span-sizes');
    el.style.removeProperty('--tile-rows');
    return;
  }
  el.dataset.spanRows = String(span.rows);
  el.dataset.spanSizes = span.sizes;
  el.style.setProperty('--tile-rows', String(span.rows));
}

/** Spuren einer Kachel in einer anderen Groesse (aus `data-span-sizes`), sonst null. */
function spanRowsForSize(el, size) {
  const entry = String(el?.dataset?.spanSizes ?? '').split(',').find((part) => part.startsWith(`${size}:`));
  const rows = Number(entry?.slice(size.length + 1));
  return Number.isInteger(rows) && rows > 0 ? rows : null;
}

/*
 * DIE BADGE ZAEHLT DIE SACHE, NICHT DIE ZEILEN (Critique 2026-09-23).
 *
 * Bis hierher trugen Notizen, Geburtstage, Aufgaben und Einkauf die Laenge der
 * GEZEIGTEN Liste im Kopf: „Notizen 3" bei fuenf angehefteten, „Geburtstage 5"
 * bei acht, „Aufgaben 5" bei zwoelf offenen - eine Zahl, die genau bis zur
 * Obergrenze der Liste stimmt und darueber still luegt. Die Kennzahlkacheln
 * hatten dieselbe Lehre schon gezogen (`openTaskCount` statt `urgentTasks`);
 * die Kachelkoepfe daneben nicht.
 *
 * Die Gesamtzahl kommt vom Server, neben der Liste (`notesTotal`,
 * `birthdayTotal`, `openTaskCount`, `shoppingOpenCount`) - wie `countdownTotal`
 * beim Countdown. Fehlt sie (aelterer Server, Fehlerpfad), faellt die Badge auf
 * die geladene Laenge zurueck; nie unter die gezeigten Zeilen, denn eine Badge
 * kleiner als die Liste darunter waere derselbe Widerspruch andersherum.
 *
 * Was nicht in die Kachel passt, wird genannt: eine ruhige Fusszeile „+N
 * weitere", dieselbe Form wie beim Countdown und bei der Entsorgung.
 */
function listTotal(total, loaded) {
  const n = total === null || total === undefined || total === '' ? NaN : Number(total);
  return Number.isFinite(n) ? Math.max(n, loaded) : loaded;
}

function listMoreLine(key, rest, fill = 0) {
  return rest > 0 ? `<p class="widget-list-more"${fillMoreAttrs(fill, rest, key)}>${esc(t(key, { count: rest }))}</p>` : '';
}

/* DATUM UND ABSTAND IN EINER ZEILE (#1454). Das Datum folgt der Stufung der
 * Uebersicht (`relativeDateLabel`: Wochentag bis sechs Tage voraus, dann Tag
 * und Monat, das Jahr nur, wenn es ein anderes ist) - hier stand `formatDate`
 * mit Jahr, drei Tage voraus („26.09.2026 · 3 Tage"), neben einem Termin, der
 * „Sa." sagte. Heute und morgen sagen beide Haelften dasselbe Wort; dann steht
 * es einmal da. */
function dateAndCount(dateLabel, countLabel) {
  if (!dateLabel || dateLabel === countLabel) return countLabel;
  return `${esc(dateLabel)} · ${countLabel}`;
}

export function renderUpcomingBirthdays(allBirthdays, size, total = null) {
  // Der Vorrat kommt fuer die groesste Fassung vom Server (routes/dashboard.js);
  // was davon erscheint, entscheidet die Kachel. Die Badge zaehlte hier die
  // gezeigten Zeilen und sagte damit „5" bei acht anstehenden Anlaessen - jetzt
  // nennt sie `birthdayTotal`, und der Rest steht als Fusszeile da (listTotal).
  const cap = listRowCap(size);
  const fill = fillRows(allBirthdays.length, cap);
  const birthdays = allBirthdays.slice(0, cap + fill);
  const span = tileSpanAttrs((s, k = 0) => ({ items: allBirthdays.length, total: listTotal(total, allBirthdays.length), cap: listRowCap(s) + k }), size, fill);
  if (!birthdays.length) {
    return `<div class="widget widget--birthdays"${span}>
      ${widgetHeader('birthdays', t('nav.birthdays'), 0, '/birthdays')}
      ${widgetEmptyHtml(t('dashboard.noBirthdays'))}
    </div>`;
  }

  const items = birthdays.map((b, index) => {
    // "in 9 Tagen" wie im Geburtstagsmodul (R23, D11), nicht "9 Tage".
    const daysLabel = daysFromTodayText(b.days_until);
    // Familien-Geburtstage tragen die Identitaetsfarbe des Mitglieds - dieselbe
    // Farbsprache wie die Familien-Kachel daneben; vorher trug hier jede Zeile
    // die Modul-Toenung, und dieselbe Person war in einer Kachel leuchtend und
    // in der naechsten grau (Etappe 4, Critique 2026-08-17). Kontakte OHNE
    // Verknuepfung behalten die Toenung: sie haben keine Identitaetsfarbe, und
    // eine erfundene (Hash) spraeche die Farbsprache der Familie fuer Fremde.
    const avatarStyle = b.family_user_color
      ? ` style="background-color:${esc(b.family_user_color)};color:${getReadableTextColor(b.family_user_color)}"`
      : '';
    const occasionLabel = b.kind === 'name_day'
      ? t('birthdays.nameDay')
      : b.next_age != null
        ? t('birthdays.turnsAge', { age: b.next_age })
        : '';
    return `
      <div class="list-row birthday-widget-item" data-route="${esc(b.id != null ? `/birthdays?open=${encodeURIComponent(String(b.id))}` : '/birthdays')}" role="button" tabindex="0"${fillRowAttr(index, cap)}>
        <div class="list-row__lead birthday-widget-item__avatar"${avatarStyle}>
          ${b.photo_data ? `<img src="${esc(b.photo_data)}" alt="" loading="lazy">` : `<span>${esc(initials(b.name))}</span>`}
        </div>
        <div class="list-row__main birthday-widget-item__body">
          <div class="list-row__name birthday-widget-item__name">${esc(b.name)}</div>
          <div class="list-row__meta birthday-widget-item__meta">${dateAndCount(relativeDateLabel(b.next_date ?? b.next_birthday), daysLabel)}</div>
        </div>
        ${occasionLabel ? `<div class="list-row__end birthday-widget-item__age">${esc(occasionLabel)}</div>` : ''}
      </div>
    `;
  }).join('');

  const gesamt = listTotal(total, allBirthdays.length);
  return `<div class="widget widget--birthdays"${span}>
    ${widgetHeader('birthdays', t('nav.birthdays'), gesamt, '/birthdays')}
    <div class="widget__body widget__body--rows">${widgetRows(items)}${listMoreLine('dashboard.birthdaysMore', gesamt - Math.min(birthdays.length, cap), fill)}</div>
  </div>`;
}

/* DIE KACHEL AUS #647. Sie steht bewusst direkt hinter den Geburtstagen: es ist
 * dieselbe Form - eine nach Nähe sortierte Liste aus „was" und „noch so lange" -
 * und der Thread hat genau das als Auflösung vorgeschlagen, statt eines zweiten
 * Systems neben Kalender und Aufgaben (@jamespurnama1).
 *
 * ZWEI QUELLEN, EINE LISTE, UND MAN SIEHT WELCHE. Ein Termin und eine Aufgabe
 * zählen gleich herunter, führen aber woanders hin: das Icon der Zeile ist das
 * des Termins (Yuvomi-eigenes Feld) bzw. das Aufgabenzeichen, und der Klick
 * öffnet das jeweilige Modul. Ohne diesen Unterschied wäre die Liste eine
 * dritte Sorte Eintrag, und genau die sollte es nicht geben.
 *
 * Der Rang ist die Nähe, nicht die Herkunft (sortiert der Server). Was vorbei
 * ist, kommt eine Nachfrist lang weiter an und steht dann ganz oben - seine
 * Tageszahl ist negativ. Wie lange und für wen, entscheidet der Server; die
 * Kachel nimmt die Liste, wie sie kommt (siehe services/countdowns.js). */
function renderCountdowns(allItems, size, total = null) {
  const shown = visibleCountdowns(allItems);
  const cap = listRowCap(size);
  const fill = fillRows(shown.length, cap);
  const items = shown.slice(0, cap + fill);
  // Kein Leerzustand: ohne Countdown ist die Kachel nicht leer, sondern nicht
  // vorhanden (isWidgetModuleEnabled). Diese Zeile ist der Notausgang für den
  // Fall, dass die Verfügbarkeit und die Daten auseinanderlaufen.
  if (!items.length) return '';

  const rows = items.map((c, index) => {
    const phrase = countdownPhrase(c.days_until);
    const label = phrase.count === undefined ? t(phrase.key) : t(phrase.key, { count: phrase.count });
    // Sagt der Zaehler rechts schon „Heute"/„Morgen", traegt die Zeile kein
    // zweites (#1454).
    const when = relativeDateLabel(c.date);
    const meta = when && when !== label ? `<div class="list-row__meta countdown-item__meta">${esc(when)}</div>` : '';
    // Die Farbe des Termins trägt die Zeile als schmale Marke - dieselbe
    // Zuordnung, die er im Kalender hat. Eine Aufgabe hat keine, sie bekommt
    // den Modulton.
    const accent = c.color
      ? ` style="--countdown-accent:${esc(c.color)}"`
      : ` style="--countdown-accent:var(--module-${c.source === 'task' ? 'tasks' : 'calendar'}, var(--color-accent))"`;
    /* DIE ZEILE TRIFFT IHR OBJEKT, nicht sein Modul - wie jede andere Zeile des
     * Dashboards. Sie führte auf `/tasks` bzw. `/calendar`, und damit landete
     * „Führerschein verlängern, ca. 3 Jahre" in einer ungefilterten Liste, in
     * der ein Eintrag von 2029 praktisch unauffindbar ist: die Zeile versprach
     * ein Objekt und lieferte ein Modul.
     *
     * Zwei Wege, weil die beiden Quellen zwei Wege HABEN und keinen dritten
     * brauchen: die Aufgabe hängt sich an denselben Quick-Action-Griff wie die
     * Zeilen des Aufgaben-Widgets (`data-task-id`, ausgewertet in `wireLinks`),
     * der Termin an dieselbe Deep-Link-Route wie die Zeilen des
     * Kalender-Widgets. Wichtig ist dabei das Datum: `c.date` ist das NÄCHSTE
     * Vorkommen, nicht der Serienstart - ohne es öffnete eine jährliche
     * Verlängerung ihr Blatt Jahre in der Vergangenheit. */
    const anchor = c.source === 'task'
      ? ` data-task-id="${esc(String(c.id))}" data-task-title="${esc(c.title)}"`
      : ` data-route="/calendar?open=${encodeURIComponent(String(c.id))}&date=${encodeURIComponent(c.date)}"`;
    return `
      <div class="list-row countdown-item" role="button" tabindex="0"${anchor}${accent}${fillRowAttr(index, cap)}>
        <span class="list-row__lead countdown-item__icon" aria-hidden="true">
          <i data-lucide="${esc(c.icon || 'calendar')}"></i>
        </span>
        <div class="list-row__main countdown-item__body">
          <div class="list-row__name countdown-item__title">${esc(c.title)}</div>
          ${meta}
        </div>
        <div class="list-row__end countdown-item__days countdown-item__days--${countdownRank(c.days_until)}">${esc(label)}</div>
      </div>
    `;
  }).join('');

  /* SIEGEL UND KOPFBAND SPRECHEN JETZT DENSELBEN TON, und der Ton ist der der
   * Übersicht. Hier stand `'calendar'`: ein teal Kalendersiegel in einem
   * violetten Kopfband, weil `.widget--countdown` als einzige der vierzehn
   * Kacheln kein `--widget-accent` bekommen hatte und auf den App-Akzent
   * zurückfiel. Genau der Fehler, den der `sealSlug`-Parameter verhindern soll -
   * er war gesetzt, die Gegenseite im Stylesheet fehlte.
   *
   * `dashboard` und nicht `calendar`, weil die Kachel zwei Quellen hat und
   * keiner von beiden gehört; in der Messung kamen drei von fünf Zeilen aus den
   * Aufgaben. Dieselbe Antwort wie beim Wetter, das aus demselben Grund
   * `--module-dashboard` trägt: eine Kachel ohne Modul gehört der Seite. */
  /* WAS NICHT PASST, WIRD GENANNT. Die Kachel schnitt still ab - zweimal sogar:
   * der Server bei fünf, die Kachel je nach Größe bei drei. Wer sechs Dinge
   * markiert hatte, sah fünf und nichts, das auf den sechsten hinwies; die
   * Kachel sah dabei vollständig aus.
   *
   * Gezählt wird gegen die SERVER-Gesamtzahl, nicht gegen die geladene Liste:
   * sonst verschwiege die Zeile genau den Schnitt, der weiter oben passiert
   * ist. Fehlt sie (älterer Server, Fehlerpfad), fällt sie auf die geladene
   * Länge zurück - dann stimmt sie wenigstens für den Kachelschnitt. */
  const gesamt = Number.isFinite(Number(total)) ? Number(total) : shown.length;
  const rest = Math.max(0, gesamt - Math.min(items.length, cap));
  const more = rest > 0
    ? `<p class="countdown-more"${fillMoreAttrs(fill, rest, 'dashboard.countdownMore')}>${esc(t('dashboard.countdownMore', { count: rest }))}</p>`
    : '';

  const span = tileSpanAttrs((s, k = 0) => ({ items: shown.length, total: gesamt, cap: listRowCap(s) + k }), size, fill);
  return `<div class="widget widget--countdown"${span}>
    ${widgetHeader('countdown', t('dashboard.countdownTitle'), gesamt, null, null, 'dashboard')}
    <div class="widget__body widget__body--rows">${widgetRows(rows)}${more}</div>
  </div>`;
}

function renderTodayMeals(meals, visibleMealTypes = MEAL_ORDER, users = [], size = '2x1') {
  const mealLabels = MEAL_LABELS();
  const safeMeals = Array.isArray(meals) ? meals : [];
  const slots = normalizeVisibleMealTypes(visibleMealTypes).map((type) => {
    const meal = safeMeals.find((m) => m.meal_type === type);
    // WER KOCHT (#1679): der Avatar steht in der Kopfzeile des Slots, vor dem
    // Symbol der Mahlzeitenart - dort ist neben dem kurzen Typ-Label Platz,
    // waehrend der Titel darunter seine zwei Zeilen fuer das Gericht braucht.
    // Der Name geht als sr-only-Satz mit: die Scheibe traegt ihn sonst nur als
    // `title`. Ohne Koch steht nichts da, der Slot sieht aus wie bisher.
    const cook = mealCookPerson(meal, users);
    const cookMark = cook
      ? `<span class="meal-slot__cook">${renderAvatarStack([cook], { size: 20, maxVisible: 1 })}<span class="sr-only">${esc(t('meals.cookNamed', { name: cook.display_name }))}</span></span>`
      : '';
    return `
      <div class="meal-slot ${meal ? 'meal-slot--filled' : ''}" data-type="${type}" data-route="/meals" role="button" tabindex="0">
        <div class="meal-slot__header">
          <span class="meal-slot__type">${mealLabels[type]}</span>
          ${cookMark}<i data-lucide="${MEAL_ICONS[type]}" class="meal-slot__icon" aria-hidden="true"></i>
        </div>
        <div class="meal-slot__title${meal ? '' : ' meal-slot__title--empty'}">${meal
          // NUR MIT BILD, anders als im Planer (#1059). Der Slot traegt oben
          // rechts schon ein Symbol fuer seine Mahlzeitenart; ein zweites,
          // gleich aussehendes Platzhalter-Symbol daneben waere Unruhe ohne
          // Aussage. Die Hoehe der Kachel haengt nicht daran - das Bild sitzt
          // in der Titelzeile und ist so hoch wie sie.
          ? `${(meal.recipe_has_own_image || meal.recipe_has_image) ? recipeThumbHtml({
              recipeId: meal.recipe_id,
              hasImage: meal.recipe_has_image,
              hasOwnImage: meal.recipe_has_own_image,
              imageVersion: meal.recipe_image_version,
              className: 'meal-slot__thumb',
            }) : ''}<span class="meal-slot__title-text">${esc(meal.title)}</span>`
          : '-'}</div>
      </div>
    `;
  }).join('');

  // Zwei Slots je Zeile; der Gerichtname steht breit in einer, schmal in zwei
  // Zeilen (dashboard.css, "MIT SPALTEN IST DIE ZEILE EIN TAKT").
  const slotRows = Math.ceil(normalizeVisibleMealTypes(visibleMealTypes).length / 2);
  const span = tileSpanAttrs((s) => {
    const slot = tileColumns(s) >= 2 ? TILE_PARTS.mealSlot : TILE_PARTS.mealSlotTwoLines;
    return { body: TILE_PARTS.mealsPad + slotRows * slot + Math.max(0, slotRows - 1) * TILE_PARTS.mealGap };
  }, size);
  return `<div class="widget widget--meals"${span}>
    ${widgetHeader('meals', t('dashboard.todayMeals'), null, '/meals', t('dashboard.weekLink'))}
    <div class="meals-widget">
      <div class="meal-slots">${slots}</div>
    </div>
  </div>`;
}

function renderPinnedNotes(allNotes, size, total = null) {
  /* WIE VIELE ZEILEN, ENTSCHEIDET DIE KACHEL - wie bei jeder anderen
   * Listenkachel (`listRowCap`). Die Notizen waren die einzige, die ihre Groesse
   * gar nicht las: der Server schnitt bei drei, und drei war damit die
   * Obergrenze fuer jede Fassung. Ab Werk steht die Kachel auf 1x2, also hoch -
   * unter drei Zeilen blieb rund ein Drittel der Karte leer, und wer fuenf
   * Notizen angepinnt hatte, sah drei davon und keinen Hinweis auf die
   * uebrigen (#928). Dieselbe Korrektur haben die Geburtstage schon bekommen;
   * die Notizen wurden dabei uebersehen. */
  const cap = listRowCap(size);
  const fill = fillRows(allNotes.length, cap);
  const notes = allNotes.slice(0, cap + fill);
  /* Notizkarten in Reihen (U1 b): schmal eine Spalte, breit drei (dashboard.css
   * "MIT SPALTEN"), jede Reihe so hoch wie ihre hoechste Karte - Titel und
   * Kategorien sind Daten, die Vorschau steht in genau zwei Zeilen.
   * KATEGORIEN NUR, WO SIE STEHEN (Review p11): dashboard.css blendet sie in
   * jeder einspaltigen und jeder einzeiligen Groesse aus; mitgezaehlt standen
   * fuenf Notizen in 1x2 auf 177 statt 145 Spuren, rund 128px leer. */
  const notesTotal = listTotal(total, allNotes.length);
  const span = tileSpanAttrs((s, k = 0) => {
    const shown = allNotes.slice(0, listRowCap(s) + k);
    if (!shown.length) return { items: 0 };
    const cols = tileColumns(s) >= 2 ? 3 : 1;
    const categoryRow = tileColumns(s) >= 2 && isTallSize(s) ? TILE_PARTS.noteCategories : 0;
    const card = (n) => TILE_PARTS.noteCard + (n.title ? TILE_PARTS.noteTitle : 0) + TILE_PARTS.noteContent
      + ((n.categories || []).length ? categoryRow : 0);
    let body = TILE_PARTS.notesPad;
    for (let i = 0; i < shown.length; i += cols) {
      body += Math.max(...shown.slice(i, i + cols).map(card)) + (i ? TILE_PARTS.notesGap : 0);
    }
    return { body: body + (notesTotal > shown.length ? TILE_PARTS.notesMore : 0) };
  }, size, fill);
  if (!notes.length) {
    return `<div class="widget widget--notes"${span}>
      ${widgetHeader('notes', t('nav.notes'), 0, '/notes')}
      ${widgetEmptyHtml(t('dashboard.noPinnedNotes'))}
    </div>`;
  }

  // Nur der sichtbare Auszug gehört ins DOM: line-clamp kürzt rein visuell,
  // Screenreader lasen die KOMPLETTE Notiz vor - WLAN-Daten, Schulinfos
  // (Critique P5). 200 Zeichen decken die zwei sichtbaren Zeilen reichlich;
  // der Volltext wohnt auf /notes. Schnitt an der Wortgrenze, damit kein
  // halbes Wort vor der Ellipse steht.
  const excerpt = (text) => {
    const s = String(text ?? '');
    if (s.length <= 200) return s;
    const cut = s.slice(0, 200);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 120))}…`;
  };
  // EINE LEERE FARBE IST KEINE FARBE, SIE IST EIN KAPUTTES REZEPT. Der Stil
  // stand unbedingt da, also trugen farblose Notizen `--note-color:;` - ein
  // gueltiger LEERER Wert, der `var(--note-color, …)` seinen Fallback nimmt und
  // damit das ganze color-mix ungueltig macht. Uebrig blieb der nackte
  // Traegergrund: drei graubeige Kaesten, die wie deaktiviert aussahen. Ohne die
  // Deklaration greift der Fallback im Stylesheet (der Notizen-Ton).
  const items = notes.map((n, index) => `
    <div class="note-item" data-route="${esc(`/notes?open=${encodeURIComponent(String(n.id))}`)}"
         ${n.color ? `style="--note-color:${esc(n.color)};"` : ''}${fillRowAttr(index, cap)}>
      <div class="note-item__body" role="link" tabindex="0">
      ${n.title ? `<div class="note-item__title">${esc(n.title)}</div>` : ''}
      <div class="note-item__content">${renderMarkdownLight(excerpt(n.content))}</div>
      </div>
      ${(n.categories || []).length ? `<div class="note-item__categories" role="group" aria-label="${esc(t('noteCategories.categories'))}">
        ${n.categories.map((category) => `<span class="tag note-item__category">${esc(noteCategoryName(category))}<span class="sr-only"> (${esc(noteCategoryScope(category))})</span></span>`).join('')}
        <button type="button" class="tag note-item__categories-more" aria-label="${esc(t('noteCategories.categories'))}" hidden></button>
      </div>` : ''}
    </div>
  `).join('');

  // Breite kommt aus dem Größenklassen-System am .widget-wrapper (widget-size--2x1);
  // die frühere .widget--wide war in keinem CSS definiert und damit tot — entfernt,
  // damit Notizen wie jedes andere Widget genau ein Größen-Vokabular trägt (Critique P2).
  // „Notizen 3" stand hier auch bei fuenf angehefteten: die Badge zaehlte die
  // gezeigten Karten. Die Vorschau ist Angeheftetes zuerst, dann Neuestes -
  // gezaehlt wird deshalb die Menge, aus der sie schoepft (`notesTotal`, mit
  // demselben Kategoriefilter), nicht nur die angehefteten (listTotal).
  const gesamt = listTotal(total, allNotes.length);
  return `<div class="widget widget--notes"${span}>
    ${widgetHeader('notes', t('nav.notes'), gesamt, '/notes')}
    <div class="notes-grid-widget">${items}</div>
    ${listMoreLine('dashboard.notesMore', gesamt - Math.min(notes.length, cap), fill)}
  </div>`;
}

/* DIE KACHELREIHE (#469) - was sie ist und was sie bewusst nicht ist.
 *
 * Vier Melder wollten dasselbe: von der Startseite des Haushalts zu den anderen
 * Diensten im Haus, ohne zwei Klicks Umweg über eine Notiz. Die Diskussion lief
 * zweimal über die Frage, ob daraus eine Lesezeichen-Bibliothek wird (#759), und
 * ist zweimal dagegen ausgegangen. Was hier steht, ist deshalb eine ZEILE aus
 * Kacheln und kein Modul: Name, Adresse, Bild, und wer sie sieht.
 *
 * KEIN VORDEFINIERTER APP-KATALOG. radicchiodev hat den Grund geliefert: eine
 * Liste bekannter Dienste ist an dem Tag falsch, an dem jemand einen betreibt,
 * der nicht darauf steht. Was hier zählt, ist eine Adresse.
 *
 * KEIN FAVICON. Das Bild wird hochgeladen und liegt in der Zeile - ein
 * geholtes Favicon hiesse, dass die Startseite bei jedem Aufbau jeden
 * verlinkten Host anspricht. Wer keins hochlädt, bekommt den Anfangsbuchstaben
 * auf seiner Farbe, dieselbe Antwort wie ein Mitglied ohne Foto: zwölf gleiche
 * Weltkugeln unterscheiden nichts, "J" auf Violett schon.
 */
function quickLinkMonogram(name) {
  // Der erste BUCHSTABE, nicht das erste Zeichen: ein Name wie "🎬 Jellyfin"
  // ergäbe sonst eine Kachel, die auf jedem Gerät anders aussieht.
  const match = String(name ?? '').match(/\p{L}|\p{N}/u);
  return (match ? match[0] : '?').toUpperCase();
}

function renderQuickLinkTile(s) {
  const name = String(s.name ?? '');
  const host = quickLinkHost(s.url);
  // Bild, dann Symbol, dann Buchstabe - dieselbe Rangfolge wie im Verwaltungs-
  // dialog (components/quick-links-manager.js), wo auch ihre Begründung steht.
  //
  // `hasIcon()` UND NICHT NUR `s.icon_name`: ein `data-lucide` mit einem Namen,
  // den dieser Lucide-Stand nicht kennt, wird nicht ersetzt und bleibt als
  // leeres Element stehen - die Kachel hätte dann gar kein Gesicht. Gefragt,
  // ob es das Symbol gibt, fällt sie stattdessen auf ihren Buchstaben zurück.
  let face;
  if (s.icon_data) {
    face = `<img src="${esc(s.icon_data)}" alt="" loading="lazy">`;
  } else if (s.icon_name && hasIcon(s.icon_name)) {
    face = `<i data-lucide="${esc(s.icon_name)}" aria-hidden="true"></i>`;
  } else {
    face = `<span class="quick-link-tile__monogram" aria-hidden="true">${esc(quickLinkMonogram(name))}</span>`;
  }
  // WEISS AUF EINER FREI GEWAEHLTEN FARBE IST NICHT IMMER LESBAR - dieselbe
  // Messung, die die Avatar-Initialen einmal gekostet hat (utils/contrast.js).
  // CSS kann das nicht entscheiden: die Farbe kommt aus der Datenbank.
  const ink = prefersInkText(s.color) ? ' quick-link-tile__face--ink' : '';
  // Die Farbe steht nur da, wenn es eine gibt - eine leere CSS-Variable ist
  // keine Farbe, sondern ein kaputtes Rezept (dieselbe Falle wie bei den
  // Notizen, siehe renderPinnedNotes).
  const tint = s.color ? ` style="--quick-link-color:${esc(s.color)};"` : '';
  // `rel` und `referrerpolicy` sind hier keine Formalie: ein Ziel im Heimnetz
  // hat nichts davon zu erfahren, von welcher Adresse aus dieser Haushalt
  // seine Yuvomi-Instanz betreibt, und `noopener` nimmt der geöffneten Seite
  // den Griff auf das Fenster, aus dem sie kam.
  // Name und volle Adresse stehen im `title`: die Host-Zeile darunter ist
  // einzeilig und kuerzt, und eine gekuerzte Adresse darf nicht die einzige
  // Auskunft darueber sein, wohin die Kachel fuehrt.
  return `<a class="quick-link-tile" href="${esc(s.url)}" target="_blank"
             title="${esc(`${name} - ${s.url}`)}"
             rel="noopener noreferrer" referrerpolicy="no-referrer"${tint}>
    <span class="quick-link-tile__face${ink}">${face}</span>
    <span class="quick-link-tile__name">${esc(name)}</span>
    ${host ? `<span class="quick-link-tile__host">${esc(host)}</span>` : ''}
    ${s.visibility === 'private'
      ? `<i data-lucide="lock" class="quick-link-tile__private" aria-label="${esc(t('quickLinks.privateBadge'))}"></i>`
      : ''}
  </a>`;
}

function renderQuickLinks(items, size = '2x1') {
  const list = Array.isArray(items) ? items : [];
  const header = widgetHeader('quicklinks', t('dashboard.quickLinksTitle'), list.length, null, null, 'dashboard');
  // Feste Spalten je Breite ab 768px (dashboard.css): drei schmal, sechs breit;
  // dazu die Kachel "Verwalten".
  const span = tileSpanAttrs((s) => {
    if (!list.length) return { items: 0 };
    const rows = Math.ceil((list.length + 1) / (tileColumns(s) >= 2 ? 6 : 3));
    return { body: TILE_PARTS.quickLinksPad + rows * TILE_PARTS.quickLinkTile + (rows - 1) * TILE_PARTS.quickLinkGap };
  }, size);

  if (!list.length) {
    // Der Leerzustand ist hier der WICHTIGSTE Zustand: das Widget kommt
    // ausgeblendet ins Haus, wer es holt, hat noch nichts angelegt, und es gibt
    // keine zweite Seite, auf der er anfangen könnte. Deshalb nicht der stumme
    // Hinweis der anderen Kacheln, sondern der Weg selbst.
    return `<div class="widget widget--quicklinks"${span}>
      ${header}
      ${widgetEmptyHtml(t('quickLinks.emptyTitle'), { label: t('common.add'), attrs: { 'data-quick-links-manage': '' } }, 'quicklinks')}
    </div>`;
  }

  return `<div class="widget widget--quicklinks"${span}>
    ${header}
    <div class="quick-link-row">
      ${list.map(renderQuickLinkTile).join('')}
      <button type="button" class="quick-link-tile quick-link-tile--add" data-quick-links-manage>
        <span class="quick-link-tile__face"><i data-lucide="pencil" aria-hidden="true"></i></span>
        <span class="quick-link-tile__name">${esc(t('quickLinks.manage'))}</span>
      </button>
    </div>
  </div>`;
}

/*
 * DIE TAGESLAGE DER FAMILIENKARTE (#1449, Critique 2026-09-23).
 *
 * Die Karte nahm den ERSTEN Termin des Tages, den sie fuer eine Person fand,
 * und verglich ihn nie mit der Uhr: 06:30 stand dort den ganzen Nachmittag,
 * und ein ganztaegiger Eintrag gewann den Tag, weil er vorne sortiert war.
 * Release-Notes 2.4.0 und SPEC versprechen den NAECHSTEN.
 *
 * „Vorbei" ist `eventHasEnded` - DIESELBE Regel, nach der die Termin-Kachel
 * einen Termin als „Vorbei" zuruecktreten laesst und das Heute-Blatt ihn
 * entlaesst (seit /dashboard die heute beendeten mitliefert, #1449). Eine
 * eigene Rechnung hier hatte in Randfaellen (Ende nur als Datum) das Gegenteil
 * der Kachel gesagt. Verglichen wird als Stempel der Anzeigezone
 * (`householdStamp`) - das Geraet hat keine Stimme. Unter den heutigen geht
 * ein Termin mit Uhrzeit dem ganztaegigen vor.
 *
 * Die Termine kommen seit #1449 aus `familyEvents`, eigens je Mitglied
 * geladen - nicht mehr aus der Liste der Kalenderkachel (fuenf Eintraege, ihr
 * „nur meine"-Filter).
 */
function familyAgenda(events, shownIds, todayKey, now = new Date()) {
  const nowStamp = householdNowStamp(now);
  const items = events.map((event) => {
    const raw = String(event?.start_datetime || '');
    // Was vor heute begann und heute noch laeuft, ist ein Termin von HEUTE
    // (#1457) - ganztaegig, wenn es ueber heute hinausgeht, sonst „bis".
    const span = overviewEventSpan(event, todayKey);
    const { day, allDay, until } = span;
    const start = allDay ? '' : span.carried ? `${todayKey}T00:00` : householdStamp(raw);
    const people = new Set((Array.isArray(event?.assigned_users) ? event.assigned_users : [])
      .map((a) => Number(a.id))
      .filter((id) => shownIds.has(id)));
    const ended = !allDay && eventHasEnded(event, nowStamp);
    return { event, day, allDay, until, start, ended, people, shared: people.size >= 2 };
  }).filter((item) => item.day && item.day >= todayKey && item.people.size > 0);

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  items.sort((a, b) => cmp(a.day, b.day) || (Number(a.allDay) - Number(b.allDay)) || cmp(a.start, b.start));
  const ahead = items.filter((item) => !item.ended);

  const byPerson = new Map();
  for (const id of shownIds) {
    const own = ahead.filter((item) => !item.shared && item.people.has(id));
    byPerson.set(id, {
      nextToday: own.find((item) => item.day === todayKey) ?? null,
      hadToday: items.some((item) => item.day === todayKey && item.people.has(id)),
      sharedToday: ahead.some((item) => item.shared && item.day === todayKey && item.people.has(id)),
      nextLater: own.find((item) => item.day > todayKey) ?? null,
    });
  }
  return { nextShared: ahead.find((item) => item.shared) ?? null, byPerson };
}

/** „10:00 Zahnarzt" heute, „Sa. · Zahnarzt" an einem spaeteren Tag (escaped). */
function familyEventLabel(item, todayKey) {
  const title = esc(item.event.title);
  if (item.day === todayKey) {
    if (item.until) return `${esc(t('dashboard.todayUntil', { time: formatTime(item.until) }))} ${title}`;
    return item.allDay ? title : `${esc(formatTime(item.event.start_datetime))} ${title}`;
  }
  return `${esc(relativeDateLabel(item.day))} · ${title}`;
}

/** „Alex und Linda" in der Grammatik der App-Sprache. */
function familyNameList(names) {
  try {
    return new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/* „VERWALTEN" FUEHRT AN EIN FESTES BLATT, ODER NIRGENDWOHIN (Re-Critique
 * 2026-09-27, A7 P1-1). Der Link zeigte auf `/settings`, und die Wurzel stellt
 * das zuletzt besuchte Blatt wieder her (pages/settings.js): nach einem Besuch
 * der Darstellung landete „Verwalten" dort. Das Ziel ist deshalb das Blatt
 * selbst, und ob es erscheint, entscheidet DERSELBE Guard, der das Blatt
 * oeffnet (`findSettingsLeaf`) - wer es nicht oeffnen darf, bekaeme sonst einen
 * Link, der ihn auf sein Konto umleitet. */
const FAMILY_SETTINGS_LEAF = '/settings/admin/family';

function familyManageHref(user) {
  return findSettingsLeaf(FAMILY_SETTINGS_LEAF, user)?.path ?? null;
}

function renderFamilyWidget(users, data, { manageHref = null, size = '1x2' } = {}) {
  // IM SOLO-HAUSHALT GIBT ES DIESES WIDGET NICHT - entschieden in
  // `isWidgetModuleEnabled`, damit es auch aus der „Anpassen"-Ablage faellt.
  // Es war das prominenteste Widget rechts oben und zeigte einer Solo-Nutzerin
  // eine grosse 1 mit „im Haushalt", ein Zaehler, dessen einziger Inhalt ist,
  // dass sie allein ist (Critique 2026-08-10, Persona Miriam).
  //
  // „Heute dran" statt Stat-Zahl (Seele-Paket): die Karte beantwortet, was die
  // Mitglieder HEUTE angeht - naechster eigener Termin plus offene Tageslast -
  // statt einer Zahl, die sich nie aendert. Zaehlerquelle ist memberTodayTasks
  // (serverseitig aggregiert, sichtbarkeitsgefiltert); aus dem 5er-Limit von
  // urgentTasks zu zaehlen wuerde luegen, sobald mehr ansteht.
  const openByUser = new Map(
    (Array.isArray(data?.memberTodayTasks) ? data.memberTodayTasks : [])
      .map((r) => [r.user_id, Number(r.open_count) || 0])
  );
  // Eigene Termine je Mitglied (#1449): die Liste der Kachel ist bei fuenf
  // Kommenden gedeckelt und traegt deren „nur meine". Ein aelterer Server ohne
  // `familyEvents` faellt auf sie zurueck.
  const events = Array.isArray(data?.familyEvents)
    ? data.familyEvents
    : Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
  const todayKey = householdToday();
  // S-18 (UX-Audit): dieselbe Schichtplan-Kachel, direkt daneben, widersprach
  // dieser Zeile - eine Person mit einer echten Schicht heute stand hier
  // trotzdem als "Heute frei", weil dieses Widget Schichtplan nie kannte.
  // `data.schedule` existiert nur, wenn die Schichtplan-Kachel selbst sichtbar
  // ist (ensureScheduleSlice() laedt sie nicht sonst) - ohne sie bleibt diese
  // Zeile unveraendert wie zuvor.
  const scheduleEntriesToday = Array.isArray(data?.schedule?.entries) ? data.schedule.entries : [];

  const shown = users.slice(0, 6);
  const shownIds = new Set(shown.map((u) => Number(u.id)));
  const agenda = familyAgenda(events, shownIds, todayKey);

  // DER GETEILTE TERMIN STEHT EINMAL DA. Ein Termin fuer drei Personen stand in
  // drei Zeilen („26.09.2026 · Zahnarzt - Familie" bei Alex, Leo und Linda) -
  // die Karte wiederholte dieselbe Auskunft, statt zu sagen, dass es EIN
  // gemeinsamer Termin ist (Critique 2026-09-23). Geteilt heisst: zwei oder
  // mehr der gezeigten Personen sind zugewiesen. Der naechste solche Termin
  // bekommt eine eigene Zeile oben, die Personenzeilen zeigen nur Eigenes.
  const sharedNext = agenda.nextShared;
  let sharedRow = '';
  if (sharedNext) {
    const who = shown.filter((u) => sharedNext.people.has(Number(u.id)));
    const label = who.length === users.length
      ? t('dashboard.familyEveryone')
      : familyNameList(who.map((u) => u.display_name));
    sharedRow = `
      <div class="list-row family-member family-member--shared">
        <span class="list-row__lead family-widget-avatar family-widget-avatar--group" aria-hidden="true">
          <i data-lucide="users"></i>
        </span>
        <span class="list-row__main family-member__body">
          <span class="list-row__name family-member__name">${esc(label)}</span>
          <span class="list-row__meta family-member__status">${familyEventLabel(sharedNext, todayKey)}</span>
        </span>
      </div>`;
  }

  const rows = shown.map((u) => {
    const mine = agenda.byPerson.get(Number(u.id)) ?? { nextToday: null, hadToday: false, sharedToday: false, nextLater: null };
    const parts = [];
    if (mine.nextToday) parts.push(familyEventLabel(mine.nextToday, todayKey));
    const myShift = scheduleEntriesToday.find((entry) => Number(entry.user_id) === Number(u.id) && entry.shift_type);
    if (myShift) {
      const type = myShift.shift_type;
      parts.push(esc(shiftTypeLabel(type)));
    }
    const open = openByUser.get(u.id) ?? 0;
    if (open > 0) parts.push(esc(t('dashboard.memberOpenTasks', { count: open })));

    // An freien Tagen erzählt die Zeile „als Nächstes dran" statt viermal
    // dasselbe „Heute frei" zu stapeln (Critique P5: die größte Karte des
    // Boards mit einem Bit Information). Erst wer auch im Ausblick nichts
    // hat, ist wirklich frei - und das darf dann leise dastehen.
    //
    // Davor zwei Zustaende, die „frei" sonst falsch benannt haette (#1449):
    // wer heute nur noch den gemeinsamen Termin oben vor sich hat, ist nicht
    // frei; und wer heute Termine HATTE und keiner mehr kommt, ist „fuer heute
    // durch" - nicht frei und nicht mit dem Termin von 06:30 beschriftet.
    let status;
    let free = false;
    if (parts.length) {
      status = parts.join(' · ');
    } else if (mine.sharedToday) {
      status = esc(t('dashboard.familyOnlyShared'));
    } else if (mine.hadToday) {
      status = esc(t('dashboard.familyDoneToday'));
      free = true;
    } else if (mine.nextLater) {
      status = familyEventLabel(mine.nextLater, todayKey);
    } else {
      status = esc(t('dashboard.todayFree'));
      free = true;
    }
    // MOBIL EINE AVATAR-REIHE (R19, Entscheidung Ulas 2026-10-16): dort steht
    // je Person nur das Gesicht mit der Zahl offener Aufgaben und der Vorname
    // (dashboard.css, `.family-member__face` / `__short`); Name und Satz
    // bleiben im Baum und sind der Name fuer Screenreader. Zahl und Vorname
    // sind Malerei (`aria-hidden`), der Satz sagt dasselbe.
    const firstName = String(u.display_name || '').trim().split(/\s+/)[0] || '';
    return `
      <div class="list-row family-member">
        <span class="list-row__lead family-member__face">
          <span class="family-widget-avatar" style="background:${esc(u.avatar_color || AVATAR_FALLBACK_COLOR)};color:${getReadableTextColor(u.avatar_color || AVATAR_FALLBACK_COLOR)}">
            ${u.avatar_data ? `<img src="${esc(u.avatar_data)}" alt="" loading="lazy">` : esc(initials(u.display_name))}
          </span>
          ${/* DIE MARKE NENNT IHRE EINHEIT (Critique R21, clarify): eine nackte
                "1" am Gesicht las sich wie eine Benachrichtigung. Das Zeichen der
                Aufgaben (wie in der Leiste) steht davor und sagt, was gezaehlt
                ist; Name und Satz im Baum sagen es Screenreadern. */ ''}
          ${open > 0 ? `<span class="family-member__count" aria-hidden="true"><i data-lucide="${MODULE_ICON.tasks}" class="family-member__count-icon"></i>${esc(getNumberFormat().format(open))}</span>` : ''}
        </span>
        <span class="family-member__short" aria-hidden="true">${esc(firstName)}</span>
        <span class="list-row__main family-member__body">
          <span class="list-row__name family-member__name">${esc(u.display_name)}</span>
          <span class="list-row__meta family-member__status${free ? ' family-member__status--free' : ''}">${status}</span>
        </span>
      </div>`;
  }).join('');
  const moreCount = users.length - Math.min(users.length, 6);

  // DIE BILANZ DES HAUSHALTSTAGES ALS FUSSZEILE.
  //
  // Die Karte beantwortet zeilenweise „wer ist heute dran" - aber nicht, wie der
  // Tag als Ganzes steht. Genau diese Summe fehlte, und genau dort sass in der
  // 1x2-Kachel der tote Raum: der Koerper endete nach der letzten Person, und
  // die restlichen ~170px trugen nichts. Die Fusszeile schliesst die Karte ab
  // (unten verankert, siehe dashboard.css) und sagt dabei etwas, das keine
  // einzelne Zeile sagen kann.
  //
  // Beide Zahlen sind serverseitig aggregiert und sichtbarkeitsgefiltert
  // (memberTodayTasks, tasksDoneToday) - aus den fuenf gerenderten Zeilen zu
  // summieren wuerde luegen, sobald der Haushalt groesser ist als das Limit.
  // Die Platzhalter heissen bewusst NICHT `count`: „offen" und „erledigt" sind
  // im Deutschen unveraenderliche Adjektive, es gibt also keine Singularform,
  // die eine `_one`-Variante tragen koennte.
  const openToday = [...openByUser.values()].reduce((sum, n) => sum + n, 0);
  const doneToday = Number(data?.tasksDoneToday) || 0;
  const footer = openToday + doneToday > 0
    ? esc(t('dashboard.familyDayTally', { open: openToday, done: doneToday }))
    : esc(t('dashboard.familyDayCalm'));

  // Breit stehen Zeilen (am Telefon die Gesichterreihe, R19): die gemeinsame
  // Zeile, eine je Mitglied, der Rest als Fussnote, darunter die Tagesbilanz.
  const familyRows = (sharedRow ? 1 : 0) + shown.length;
  const span = tileSpanAttrs(() => ({
    body: TILE_PARTS.familyPad + familyRows * TILE_GEOMETRY.row + (moreCount > 0 ? TILE_PARTS.familyMore : 0) + TILE_PARTS.familyFooter,
  }), size);
  return `<div class="widget widget--family"${span}>
    ${/* EIN WORT FUER DEN KOPF-LINK (Critique 2026-10-16): jede Kachel fuehrt
         mit „Alle" zu ihrer Seite, nur die Familie sagte „Verwalten" - fuer
         denselben Weg, die ganze Liste. */ ''}
    ${widgetHeader('family', t('dashboard.familyTitle'), null, manageHref, null, 'contacts')}
    <div class="family-widget">
      <div class="widget__rows row-divided family-widget__list">
        ${sharedRow}
        ${rows}
        ${moreCount > 0 ? `<div class="family-member family-member--more">${esc(t('dashboard.shoppingMore', { count: moreCount }))}</div>` : ''}
      </div>
      <p class="family-widget__footer">${footer}</p>
    </div>
  </div>`;
}

// Sparziel-Fortschritt statt bloßer Sparquote, sobald ein Budgetplan-Sparziel
// gesetzt ist (#468). Ohne Ziel bleibt die bekannte Sparquoten-Zeile.
function renderBudgetSavings(budget, balance, income, savingsRate) {
  const goal = budget?.savingsGoal;
  if (goal && goal > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((balance / goal) * 100)));
    const met = balance >= goal;
    const tone = met ? 'positive' : (balance < 0 ? 'negative' : 'neutral');
    return `
      <div class="budget-widget__goal">
        <div class="budget-widget__goal-head">
          <span>${t('dashboard.savingsGoal')}</span>
          <strong class="budget-widget__goal-pct budget-widget__goal-pct--${tone}">${Math.round((balance / goal) * 100)}%</strong>
        </div>
        <div class="budget-widget__goal-track">
          <div class="budget-widget__goal-fill budget-widget__goal-fill--${tone}" style="--goal-scale:${pct / 100}"></div>
        </div>
      </div>`;
  }
  // OHNE SPARZIEL BEKOMMT DIE SPARQUOTE IHREN ZWEITEN KANAL.
  //
  // Sie stand als nackte Prozentzahl da - die einzige Kennzahl der Karte, die
  // eine Relation BEHAUPTET („45 % von was?"), ohne sie zu zeigen. Die Spur
  // zeigt den Monat als Ganzes: die Einnahmen sind die volle Breite, der
  // gefuellte Teil das Gesparte, der Rest das Ausgegebene. Damit tragen Zahl
  // und Flaeche dieselbe Aussage - und die Karte hat unter ihrer Kennzahl
  // endlich Substanz statt Luft.
  //
  // Die Spur ist `aria-hidden`: sie ist der ZWEITE Kanal fuer die Prozentzahl,
  // die unmittelbar darueber im Text steht. Ein eigenes Label wuerde dieselbe
  // Auskunft ein zweites Mal vorlesen. Ohne Einnahmen gibt es keinen Anteil,
  // den man zeigen koennte - dann bleibt die Zeile allein.
  //
  // Gefuellt wird auf die SPARQUOTE, nicht auf den Ausgabenanteil: die Flaeche
  // muss die Zahl zeigen, die neben ihr steht. Und sie wird bei 0 gekappt - eine
  // negative Quote (mehr ausgegeben als eingenommen) hat keine Balkenlaenge; das
  // sagt der rote Saldo darueber, nicht eine Spur, die rueckwaerts liefe.
  const savedShare = income > 0 ? Math.max(0, Math.min(1, balance / income)) : 0;
  return `
    <div class="budget-widget__savings">
      <span>${t('dashboard.savingsRate')}</span>
      <strong>${income > 0 ? `${savingsRate}%` : '-'}</strong>
    </div>
    ${income > 0 ? `
    <div class="budget-widget__share" aria-hidden="true">
      <span class="budget-widget__share-saved" style="--share-scale:${savedShare.toFixed(3)}"></span>
    </div>` : ''}`;
}

/* DIE HOHE BUDGET-KACHEL FUELLT IHRE HOEHE MIT INHALT (Critique 2026-09-23).
 *
 * Als 1x2 bekommt die Karte die Hoehe zweier Rasterzeilen, ihr Inhalt reichte
 * fuer gut eine: gemessen ~90px leeres Band zwischen „Einnahmen/Ausgaben" und
 * der Fusszeile, die unten verankert ist (`margin-block-start: auto`, siehe
 * „Ueberschuessige Hoehe wird Atem" in dashboard.css). Atem war das nicht mehr,
 * sondern eine Luecke mitten in der Karte. Die hohe Fassung zeigt deshalb die
 * DREI groessten Ausgabenkategorien statt einer - dieselbe Frage („wohin ging
 * das Geld?"), vollstaendiger beantwortet, und genau die Hoehe, die fehlte.
 * Die flache Kachel behaelt ihre eine Zeile; mehr trueg sie nicht. */
const BUDGET_TOP_TALL = 3;

/* Die Zusatzzeilen der hohen Budget-Kachel (U14): weitere Kategorien, soweit
 * geladen (der Server liefert fuenf). Die flache Kachel nennt eine Kategorie in
 * einer Satzzeile - eine Liste wuerde sie erst durch Streckung, das ist kein
 * Mehr an Zeilen, sondern eine andere Form. */
function budgetTopFill(topCount, size) {
  return listRowCap(size) === LIST_ROWS_TALL ? fillRows(topCount, BUDGET_TOP_TALL) : 0;
}

function renderBudgetTopExpenses(budget, currency, size, fill = 0) {
  const cap = listRowCap(size) === LIST_ROWS_TALL ? BUDGET_TOP_TALL : 1;
  const rows = (Array.isArray(budget?.topExpenses) && budget.topExpenses.length
    ? budget.topExpenses
    : budget?.topExpenseCategory ? [{ category: budget.topExpenseCategory, amount: budget.topExpenseAmount }] : [])
    .slice(0, cap + (cap > 1 ? fill : 0));
  if (!rows.length) return '';
  if (rows.length === 1) {
    return `<div class="budget-widget__footer">${t('dashboard.topExpense')}: <strong>${esc(budgetCategoryLabel(rows[0].category))}</strong> · ${formatCurrency(rows[0].amount, currency)}</div>`;
  }
  return `
    <div class="budget-widget__footer budget-widget__top">
      <p class="budget-widget__top-title">${esc(t('dashboard.topExpenses'))}</p>
      <ul class="budget-widget__top-list">
        ${rows.map((row, index) => `
        <li class="budget-widget__top-row"${fillRowAttr(index, cap)}>
          <span>${esc(budgetCategoryLabel(row.category))}</span>
          <strong>${formatCurrency(row.amount, currency)}</strong>
        </li>`).join('')}
      </ul>
    </div>`;
}

/* DIE BUDGET-KACHEL NENNT IHREN REITER (#1607). Das Budget merkt sich den
 * zuletzt offenen Reiter und zeigt ihn ohne `?tab=` wieder - richtig fuer die
 * Navigation, falsch fuer diese Kachel: wer zuletzt in der Statistik stand,
 * landete ueber „Eintrag hinzufuegen" auf einem Reiter ohne Anlegen. Kachel und
 * Kennzahl zeigen den Monat (Einnahmen, Ausgaben, Saldo), also fuehren ihre
 * Wege auf die Monatsuebersicht. */
const BUDGET_MONTH_ROUTE = '/budget?tab=budget';

function renderBudgetWidget(budget, currency, size = '1x1') {
  const income = budget?.income || 0;
  const expenses = budget?.expenses || 0;
  const balance = budget?.balance || 0;
  const savingsRate = income > 0 ? Math.round((balance / income) * 100) : 0;
  const balanceTone = balance >= 0 ? 'positive' : 'negative';
  const hasData = (budget?.entryCount || 0) > 0;
  const topCount = (Array.isArray(budget?.topExpenses) && budget.topExpenses.length
    ? budget.topExpenses.length : budget?.topExpenseCategory ? 1 : 0);
  const fill = hasData ? budgetTopFill(topCount, size) : 0;
  const span = tileSpanAttrs((s, k = 0) => {
    if (!hasData) return { items: 0 };
    const n = Math.min(topCount, listRowCap(s) === LIST_ROWS_TALL ? BUDGET_TOP_TALL + k : 1);
    const savings = budget?.savingsGoal > 0 ? TILE_PARTS.budgetGoal : income > 0 ? TILE_PARTS.budgetSavings : TILE_PARTS.budgetSavingsBare;
    const top = n === 0 ? 0 : n === 1 ? TILE_PARTS.budgetTopOne : TILE_PARTS.budgetTopList + n * TILE_PARTS.budgetTopRow - 4;
    return { body: TILE_PARTS.budgetPad + TILE_PARTS.budgetHeadline + savings + TILE_PARTS.budgetFlow + top };
  }, size, fill);

  if (!hasData) {
    return `<div class="widget widget--budget"${span}>
      ${widgetHeader('budget', t('nav.budget'), null, BUDGET_MONTH_ROUTE)}
      ${widgetEmptyHtml(t('dashboard.noBudgetData'), emptyRouteAction(BUDGET_MONTH_ROUTE, t('common.add')), 'budget')}
    </div>`;
  }

  return `<div class="widget widget--budget"${span}>
    ${widgetHeader('budget', t('nav.budget'), null, BUDGET_MONTH_ROUTE)}
    <div class="budget-widget">
      <div class="budget-widget__headline">
        <span>${t('dashboard.monthlyBalance')}</span>
        <strong class="budget-widget__balance budget-widget__balance--${balanceTone}">${formatCurrency(balance, currency)}</strong>
      </div>
      ${renderBudgetSavings(budget, balance, income, savingsRate)}
      <div class="budget-widget__flow">
        <span class="budget-widget__flow-item budget-widget__flow-item--income">
          <span>${t('dashboard.monthlyIncome')}</span>
          <strong>${formatCurrency(income, currency)}</strong>
        </span>
        <span class="budget-widget__flow-item budget-widget__flow-item--expense">
          <span>${t('dashboard.monthlyExpenses')}</span>
          <strong>${formatCurrency(expenses, currency)}</strong>
        </span>
      </div>
      ${renderBudgetTopExpenses(budget, currency, size, fill)}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Kennzahlen-Widget (2x2-Kacheln, je eine Kachel = ein Sprungziel)
// --------------------------------------------------------

/* WARUM DAS EIN WIDGET IST UND KEIN FESTER BLOCK.
 *
 * Der Handoff entwirft eine feste Folge: Gruss, „Heute", Kacheln, Familie,
 * Wetter. `dashboard_widgets` speichert aber Auswahl UND Reihenfolge, seit #585
 * je Person - als fester Block waere entweder die Einstellung tot oder das
 * Raster braeche, sobald jemand ein Modul abwaehlt. Als Widget-Typ ordnet die
 * Kachelreihe sich ein, laesst sich verschieben, ausblenden und in der Groesse
 * aendern wie jede andere Kachel, und der Server brauchte dafuer keine Zeile:
 * normalizeWidgetConfig kennt Ids generisch und '2x2' steht laengst in
 * VALID_WIDGET_SIZES.
 *
 * UND WARUM ES .metric-card IST UND KEIN NEUER BAUSTEIN.
 * Der Entwurf beschreibt Surface, Radius 16, shadow-sm, Label 13/500 sekundaer,
 * Wert 20/700 tabular, Sub 12px - das ist Zeile fuer Zeile die Kennzahlkarte,
 * die seit v2.1.0 in panel.css steht und ueber einen Guard als die EINE Bauart
 * des Hauses festgehalten ist. Neu ist hier nur die Rolle: die Karte ist ein
 * Sprungziel und traegt deshalb ein Siegel im Kopf.
 */

/* Die Reihenfolge IST die Vorauswahl. Es gibt bewusst keine eigene Einstellung
 * dafuer: das Widget-System kennt bislang nur zeigen/verbergen/Groesse/Reihe,
 * und eine erste Pro-Widget-Option waere eine neue Schema-Achse, die danach
 * jedes Widget mitschleppt. Faellt ein Modul aus (abgeschaltet, kein Zugriff,
 * keine Daten), ruecken die hinteren Kandidaten nach - vier Kacheln bleiben
 * vier Kacheln, statt eine Luecke ins Raster zu reissen.
 *
 * DIE LISTE FUEHRTE MIT DENEN, DIE OHNEHIN DASTEHEN (Critique 2026-08-13, P1).
 * Gemessen im Standard-Layout bei 1440x900 waren alle vier Kacheln Echos:
 * „2.504 EUR Saldo" stand 800px neben dem Budget-Widget mit derselben Zahl,
 * „17 Tage / Tante Claire Becker" direkt ueber dem Geburtstage-Widget mit
 * demselben Namen, „23 Artikel" und „4 ueberfaellig" in den Cockpit-Zeilen.
 * Der erklaerte Zweck der Reihe ist das Gegenteil: ein Sprungziel fuer die
 * Module, von denen sonst NICHTS auf dem Schirm steht.
 *
 * Deshalb stehen die drei spezialisierten Module jetzt mit in der Liste. Sie
 * sind es, die im Standard-Layout kein eigenes Widget zeigen
 * (DEFAULT_HIDDEN_WIDGETS) - und genau deshalb gehoeren sie hierher. Wer sie
 * nicht nutzt, hat keine Daten und bekommt keine Kachel.
 *
 * DIE GETEILTEN AUSGABEN STEHEN DIREKT HINTER DEM BUDGET (Critique 2026-09-23).
 * Das Modul hatte kein Element auf der Uebersicht, und die Critique wollte
 * ausdruecklich eine Kennzahl, kein Widget - eine offene Forderung ist genau die
 * Art Zahl, fuer die diese Reihe da ist. Vor den Opt-in-Modulen, weil eine
 * Schuld eine Handlung verlangt und ein Punktestand nicht. Ausgeglichen gibt es
 * keine Kachel (siehe metricTileFor). */
/* KEIN SALDO IN DER REIHE (R21, Critique 2026-10-21, D5). Seit das
 * Budget-Widget in der Vorgabe aus ist (DEFAULT_HIDDEN_WIDGETS), waere sein
 * Kontostand hier nachgerueckt - die Regel oben holt ja genau das, was kein
 * eigenes Widget zeigt. Ein Kontostand ist aber keine Kennzahl fuer den
 * Morgen, sondern eine Auskunft, die man sich holt: er steht im Budget-Widget,
 * wer es einblendet. Die offene Forderung der geteilten Ausgaben bleibt - sie
 * verlangt eine Handlung, wie eine ueberfaellige Aufgabe. */
const METRIC_TILE_ORDER = ['tasks', 'shopping', 'split-expenses', 'birthdays', 'meals', 'notes', 'rewards', 'health', 'housekeeping'];
const METRIC_TILE_COUNT = 4;

/**
 * Wohin eine Zeile fuehrt, die ueber ALLE Einkaufslisten zaehlt (#1821).
 *
 * Die Zahl meint mehrere Listen, also ist die Modulseite das ehrliche Ziel -
 * bis nur noch EINE Liste etwas Offenes hat: dann meint "5 offen" genau diese
 * Liste, und `/shopping` oeffnete stattdessen die aelteste (shopping.js liest
 * `?list=`, sonst die erste geladene). `shoppingOpenLists` zaehlt der Server
 * ueber alle Listen; `shoppingLists` traegt hoechstens drei, bei einer einzigen
 * also genau sie.
 */
function shoppingSoleListRoute(data) {
  const lists = Array.isArray(data?.shoppingLists) ? data.shoppingLists : [];
  if (Number(data?.shoppingOpenLists) !== 1 || lists.length !== 1 || lists[0]?.id == null) return '/shopping';
  return `/shopping?list=${encodeURIComponent(String(lists[0].id))}`;
}

function metricTileFor(id, data, currency, sheetSpeaks = new Set()) {
  const route = { tasks: '/tasks', shopping: '/shopping', birthdays: '/birthdays', meals: '/meals', notes: '/notes', rewards: '/rewards', health: '/health', housekeeping: '/housekeeping' }[id];
  switch (id) {
    case 'tasks': {
      const open = data.openTaskCount;
      if (open == null) return null;
      const overdue = data.overdueTaskCount ?? 0;
      return {
        id, route, icon: widgetIcon('tasks'), label: t('nav.tasks'),
        value: t('dashboard.metricOpen', { count: open }),
        note: overdue > 0 ? t('dashboard.metricOverdue', { count: overdue }) : t('dashboard.metricNothingOverdue'),
        noteTone: overdue > 0 ? 'danger' : null,
      };
    }
    case 'shopping': {
      const items = data.shoppingOpenCount;
      if (items == null) return null;
      const lists = data.shoppingOpenLists ?? 0;
      return {
        id, route, icon: widgetIcon('shopping'), label: t('nav.shopping'),
        value: t('dashboard.metricItems', { count: items }),
        note: items === 0 ? t('dashboard.metricAllBought') : t('dashboard.metricOnLists', { count: lists }),
      };
    }
    case 'split-expenses': {
      return splitBalanceTile(data.splitBalance);
    }
    case 'birthdays': {
      const next = (data.birthdays ?? [])[0];
      if (!next) return null;
      const days = next.days_until;
      return {
        id, route, icon: widgetIcon('birthdays'), label: t('nav.birthdays'),
        value: daysFromTodayText(days),
        note: next.kind === 'name_day' ? `${next.name} · ${t('birthdays.nameDay')}` : next.name,
      };
    }
    case 'meals': {
      const meals = data.todayMeals ?? [];
      if (!meals.length) return null;
      return {
        id, route, icon: widgetIcon('meals'), label: t('nav.meals'),
        value: t('dashboard.metricMeals', { count: meals.length }),
        note: meals[0]?.title || t('dashboard.todayMeals'),
      };
    }
    case 'notes': {
      const notes = data.pinnedNotes ?? [];
      if (!notes.length) return null;
      /* `pinnedNotes` ist die VORSCHAU (gepinnt zuerst, dann aktuellste, drei
       * Stueck), nicht die Menge der gepinnten - `notes.length` las deshalb bei
       * null Pins "3 angepinnt" und bei fuenf ebenfalls "3". Die Zahl kommt aus
       * `pinnedNotesCount`, die Vorschau bleibt die Vorschau. */
      const pinned = data.pinnedNotesCount ?? notes.filter((n) => n.pinned).length;
      if (!pinned) return null;
      return {
        id, route, icon: widgetIcon('notes'), label: t('nav.notes'),
        value: t('dashboard.metricPinned', { count: pinned }),
        note: notes[0]?.title || t('notes.titlePlaceholder'),
      };
    }
    case 'rewards': {
      // KEIN SPITZENREITER (Critique 2026-09-23). Die Kachel nannte den
      // hoechsten Stand samt Namen - dieselbe Rangliste wie das alte Widget,
      // nur kuerzer. Wer selbst sammelt, sieht den eigenen Stand und sein Ziel;
      // wer freigibt, sieht nur, ob etwas auf ihn wartet.
      const r = data.rewards ?? {};
      const standings = Array.isArray(r.standings) ? r.standings : [];
      const own = standings.find((m) => m.id === r.me);
      if (own && (r.view === 'self' || standings.length === 1)) {
        return {
          id, route, icon: widgetIcon('rewards'), label: t('nav.rewards'),
          value: t('dashboard.metricPoints', { count: Number(own.balance) || 0 }),
          note: rewardGoalLabel(own.balance, r.catalog),
        };
      }
      // Die Zahl offener Freigaben steht an GENAU EINER Stelle: im
      // Belohnungen-Widget (dann filtert `shown` diese Kachel weg), sonst im
      // Heute-Blatt, und nur wenn keines von beiden sie traegt, hier.
      const pending = r.view === 'approver' ? (Number(r.pending) || 0) + (Number(r.moneyPending) || 0) : 0;
      if (!pending || sheetSpeaks.has('approvals')) return null;
      return {
        id, route, icon: widgetIcon('rewards'), label: t('nav.rewards'),
        value: t('dashboard.rewardsPending', { count: pending }),
        note: t('rewards.pendingApprovals'),
      };
    }
    case 'health': {
      const h = data.health ?? {};
      // Ohne Medikamente hat die Kachel keine Kennzahl - und der Zyklus ist
      // bewusst NICHT ihr Ersatz: er haengt an expliziten Grants (#584), und
      // eine Kachel, die je nach Berechtigung etwas anderes zeigt, ist zwei
      // Kacheln mit einem Namen.
      if (!h.hasMeds || !(h.dosesTotal > 0)) return null;
      // Nennt das Heute-Blatt die offenen Dosen schon, waere „2 offen" hier
      // dieselbe Zahl ein zweites Mal - ausser eine Packung muss nachbestellt
      // werden, das sagt das Blatt nicht.
      if (sheetSpeaks.has('doses') && !(h.lowStockCount > 0)) return null;
      const offen = h.dosesTotal - (h.dosesTaken ?? 0) - (h.dosesSkipped ?? 0);
      return {
        id, route, icon: widgetIcon('health'), label: t('nav.health'),
        // „2 Dosen" liess offen, ob offen oder genommen (Critique 2026-09-23,
        // Persona Grosseltern) - der Wert nennt jetzt den Zustand („2 offen",
        // wie „12 offen" bei den Aufgaben; „2 Dosen offen" passte mobil nicht
        // in die nicht umbrechende Wertzeile), und die Zweitzeile nennt die
        // naechste Dosis mit Uhrzeit statt nur dem Namen.
        value: t('dashboard.metricDoses', { count: Math.max(0, offen) }),
        // Die Nachbestellung schlaegt die naechste Uhrzeit: eine leere Packung
        // ist der Zustand, der eine Handlung braucht, eine faellige Dosis der,
        // der von selbst kommt.
        note: h.lowStockCount > 0
          ? t('dashboard.healthRefill', { count: h.lowStockCount })
          : offen <= 0 || !h.nextDose?.name
            ? t('dashboard.healthAllTaken')
            : `${h.nextDose.time ? `${formatTime(h.nextDose.time)} ` : ''}${h.nextDose.name}`,
        noteTone: h.lowStockCount > 0 ? 'danger' : null,
      };
    }
    case 'housekeeping': {
      const hk = data.housekeeping ?? {};
      if (!hk.configured) return null;
      return {
        id, route, icon: widgetIcon('housekeeping'), label: t('nav.housekeeping'),
        // „9 Besuche" ohne Zeitraum - gezaehlt werden die abgeschlossenen
        // Besuche des laufenden Monats (routes/dashboard.js), und das sagt der
        // Wert jetzt. Kurz („9 im Monat"), weil der Wert nicht umbricht: die
        // Kachel ist mobil 152px breit, „9 Besuche diesen Monat" wurde dort
        // abgeschnitten (gemessen). Das Substantiv steht im Kachelnamen.
        value: t('dashboard.metricVisitsMonth', { count: hk.visitsThisMonth ?? 0 }),
        // Drei Zustaende, ein Rang: wer gerade da ist, ist die Nachricht; sonst
        // zaehlt offenes Geld; sonst der letzte Besuch. „Gerade im Haus" um
        // 21:18 las sich wie ein Fehler - mit „seit 08:00" ist es eine Auskunft
        // (und eine vergessene Abmeldung von gestern sieht man am Datum).
        note: hk.present
          ? (hk.presentSince
            ? t('dashboard.housekeepingPresentSince', { time: housekeepingSinceLabel(hk.presentSince) })
            : t('dashboard.housekeepingPresent'))
          : hk.unpaidAmount > 0
            ? t('dashboard.housekeepingUnpaid', { amount: formatCurrency(hk.unpaidAmount, currency) })
            : hk.lastVisit
              ? t('dashboard.housekeepingLastVisit', { date: earnedWhenLabel(hk.lastVisit) })
              : t('dashboard.housekeepingNoVisits'),
      };
    }
    default:
      return null;
  }
}

/**
 * Betrag aus dem Ledger in der ISO-Skala seiner Waehrung.
 *
 * Der Server liefert Geteilte-Ausgaben-Betraege als Dezimalstring in der
 * Skala aus `CURRENCY_MINOR_UNITS` (ISO 4217: JPY 0, EUR 2, KWD 3). Die Stellen
 * kommen deshalb aus dem String und nicht aus `Intl`, dessen CLDR-Konvention
 * davon abweicht (HUF zeigt dort keine Nachkommastellen, 12,50 stuende als
 * „13" da). Und anders als `formatCurrency()` bleiben die Stellen auch ab 1000:
 * ein offener Betrag ist eine Forderung, keine Groessenordnung.
 */
function formatLedgerAmount(amount, currency) {
  const digits = (String(amount).split('.')[1] ?? '').length;
  return getNumberFormat({
    style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Number(amount) || 0);
}

/**
 * Kachel „Ausgleich offen" der geteilten Ausgaben.
 *
 * WERT = NETTO, FUSSNOTE = DIE GROESSTE POSITION. Die Zahl beantwortet „wie
 * stehe ich insgesamt", die Zeile darunter „bei wem" - mit „+N" fuer die
 * uebrigen Positionen, statt eine Liste in eine Kachel zu zwaengen. Das Netto
 * gehoert zur Waehrung der genannten Position; Betraege verschiedener
 * Waehrungen addiert niemand. Das Vorzeichen sagt die Richtung (Minus nur,
 * wer schuldet); ROT TRAEGT DIE SCHULD NICHT (Critique R21, D8) - eine offene
 * Position in einer geteilten Gruppe ist kein Konto im Minus. Gruen bleibt
 * fuer das, was man bekommt, wie bei einer Einnahme.
 *
 * AUSGEGLICHEN GIBT ES KEINE KACHEL, auch wenn sich zwei Gruppen nur
 * gegenseitig aufheben. „Alles ausgeglichen" waere wahr, verlangt
 * aber nichts - und die Reihe hat vier Plaetze, die sonst eine Zahl tragen, die
 * NIRGENDS steht. Dieselbe Regel wie bei den uebrigen Kandidaten: keine offene
 * Position, keine Kennzahl.
 *
 * Die Saldenquelle ist die der Ausgleichs-Ansicht (server/services/
 * split-expenses.js, groupBalanceRows) - die Kachel zeigt, was das Modul zeigt,
 * auch dessen offenen Fehler #1445.
 */
function splitBalanceTile(balance) {
  const positions = Array.isArray(balance?.positions) ? balance.positions : [];
  // Das Netto entscheidet, nicht die Positionen: es summiert ueber alle
  // Gruppen und laesst eine Waehrung mit Summe 0 weg, die Positionen bleiben je
  // Gruppe stehen. Offen ist also nur, wo ein Netto steht - und die genannte
  // Position gehoert zu dessen Waehrung.
  const net = (balance?.net ?? []).find((n) => Number(n.netMinor) !== 0);
  if (!net) return null;
  const top = positions.find((p) => p.currency === net.currency);
  if (!top) return null;
  const netMinor = Number(net.netMinor);
  const who = top.direction === 'owe'
    ? t('dashboard.splitYouOwe', { name: top.name })
    : t('dashboard.splitOwesYou', { name: top.name });
  const more = positions.length - 1;
  // „+2" als Zahl der Format-Locale, nicht als Textbaustein: Vorzeichen und
  // Ziffern gehoeren dem Zahlformat (RTL, arabische Ziffern).
  const note = more > 0 ? `${who} · ${getNumberFormat({ signDisplay: 'always' }).format(more)}` : who;
  return {
    id: 'split-expenses',
    // Die Ausgleichs-Ansicht liegt im Budget, Reiter „Aufteilung", in der
    // Gruppe der genannten Position.
    route: `/budget?tab=split-expenses&group=${encodeURIComponent(String(top.groupId))}`,
    icon: widgetIcon('split-expenses'),
    label: t('splitExpenses.title'),
    value: formatLedgerAmount(net.amount, net.currency),
    note,
    tone: netMinor > 0 ? 'balance-positive' : 'balance-neutral',
  };
}

function renderMetricTile(tile) {
  const noteClass = tile.noteTone === 'danger' ? ' metric-card__note--danger' : '';
  const toneClass = tile.tone ? ` metric-card--${tile.tone}` : '';
  return `
    <a class="metric-card metric-card--tile${toneClass}" href="${tile.route}" data-route="${tile.route}">
      <span class="metric-card__tile-head">
        <!-- Der Ton gehoert AUF das Siegel, nicht auf die Karte darum: .module-seal
             deklariert --seal-accent in seiner eigenen Regel, und eine Deklaration
             am Element schlaegt jeden geerbten Wert. Von der Karte aus gesetzt
             trugen alle vier Kacheln denselben violetten App-Akzent.
             Zwei Siegel-Gesichter auf einem Board waeren zwei Wahrheiten -
             der Satz galt erst fuer dieses Board und seit 2026-08-17 fuer die
             ganze App: es gibt nur noch das Vollton-Gesicht, also braucht es
             auch keine Klasse mehr, die es auswaehlt. -->
        <span class="module-seal module-seal--sm" aria-hidden="true"
              style="--seal-accent: var(--module-${tile.id}, var(--color-accent))">${moduleIconHTML(tile.icon)}</span>
        <span class="metric-card__label">${esc(tile.label)}</span>
      </span>
      <span class="metric-card__value">${esc(tile.value)}</span>
      <span class="metric-card__note${noteClass}">${esc(tile.note)}</span>
    </a>
  `;
}

/**
 * Die Kachelreihe zeigt, was sonst NIRGENDS auf dem Schirm steht.
 *
 * @param {Set<string>} shown  die Modul-Ids, die in diesem Layout ein eigenes
 *                             sichtbares Widget haben.
 *
 * DER FILTER IST DIE GANZE AUSSAGE (Critique 2026-08-13, P1). Ohne ihn fuehrte
 * die Reihe mit `tasks` und `shopping` - beide in COCKPIT_COVERED_WIDGETS -,
 * und daneben mit `budget` und `birthdays`, die im Standard-Layout ihr eigenes
 * Widget haben. Gemessen waren alle vier Kacheln Echos von etwas, das im selben
 * Viewport schon stand. PRODUCT.md fuehrt das „ueberlastete Feature-Dashboard"
 * als Anti-Referenz, und eine Zahl zweimal auf einem Schirm ist deren reine
 * Form.
 *
 * Zwei Quellen der Doppelung, zwei Bedingungen:
 *   - das Cockpit fasst vier Domaenen schon zusammen (COCKPIT_COVERED_WIDGETS);
 *   - ein sichtbares Widget sagt seine Zahl selbst, ausfuehrlicher als eine
 *     Kachel es koennte.
 *
 * ES IST EIN FILTER, KEINE ZWEITE LISTE. Wer ein Widget ausblendet, bekommt
 * dessen Kachel - und wer es wieder einblendet, verliert sie. Die Reihe folgt
 * dem Layout, statt eine eigene Vorstellung davon zu pflegen.
 */
function selectMetricTiles(data, currency, shown = new Set(), sheetSpeaks = new Set()) {
  const tiles = METRIC_TILE_ORDER
    .filter((id) => isWidgetModuleEnabled(id))
    .filter((id) => !COCKPIT_COVERED_WIDGETS.has(id))
    .filter((id) => !shown.has(id))
    .map((id) => metricTileFor(id, data, currency, sheetSpeaks))
    .filter(Boolean)
    .slice(0, METRIC_TILE_COUNT);

  // Weniger als zwei Kacheln sind keine Kachelreihe, sondern eine einsame
  // Karte - dann traegt das Modul-Widget die Zahl besser.
  return tiles.length < 2 ? [] : tiles;
}

/* Die AUSWAHL steht getrennt von der DARSTELLUNG, damit die Zusage pruefbar ist,
 * ohne ein Dokument zu bauen: was die Reihe zeigt, ist die Aussage - dass sie es
 * in einem <a> zeigt, ist ihre Form. */
function renderMetricTiles(data, currency, shown = new Set(), sheetSpeaks = new Set(), size = '2x1') {
  const tiles = selectMetricTiles(data, currency, shown, sheetSpeaks);
  if (!tiles.length) return '';
  /* Keine Karte, kein Kopf: vier Kacheln je Reihe breit, zwei schmal (U1 b).
   * SPALTEN UND HOEHE AUS EINER REGEL (U15, Review p11): das Stylesheet legte
   * Spalten nach Breite an (auto-fit, 160px) - eine 684px breite Reihe stand
   * in drei Spalten und zwei Kachelreihen, 308 statt 120px, im Anpassen-Modus
   * abgeschnitten. Jetzt bekommt es die Spaltenzahl von hier (`--metric-cols`,
   * dashboard.css ab 768px), und Name und Notiz stehen dort in einer Zeile:
   * die Kachel ist 119px hoch, wie breit sie auch ist. */
  const metricColumns = (s) => Math.min(tiles.length, tileColumns(s) >= 2 ? 4 : 2);
  const span = tileSpanAttrs((s) => {
    const rows = Math.ceil(tiles.length / metricColumns(s));
    return { bare: true, body: rows * TILE_PARTS.metricCard + (rows - 1) * TILE_PARTS.metricGap };
  }, size);
  // Die Reihe war das einzige Widget ohne Ueberschrift: per H-Taste sprang man
  // an ihr vorbei, und ihre vier Zahlen hingen unter der vorigen Kachel. Die
  // Ueberschrift ist sr-only, weil jede Kachel ihr Modul schon sichtbar nennt -
  // ein Etikett „Kennzahlen" ueber einer Reihe, die sich selbst erklaert, waere
  // nur Kopfhoehe. Sie steht VOR der Reihe, nicht in ihr: `.metric-tiles` ist
  // selbst das Raster der Kacheln.
  return `<h3 class="sr-only">${esc(t('dashboard.metrics'))}</h3>
    <div class="metric-tiles"${span} style="--metric-cols: ${metricColumns(size)}">${tiles.map(renderMetricTile).join('')}</div>`;
}

// --------------------------------------------------------
// Belohnungen-Widget: der eigene Weg zur Praemie, kein Wettbewerb
// --------------------------------------------------------

/* HIER STAND EINE RANGLISTE, UND SIE WAR FUER JEDEN DIESELBE (Critique
 * 2026-09-23, Persona Emma, 9). "1 Leo 60 / 2 Emma 30" las ein Kind als
 * Wettbewerb unter Geschwistern - PRODUCT.md verspricht jedem
 * Familienmitglied den eigenen Blick. Seitdem gibt es keinen Platz und keinen
 * hervorgehobenen Spitzenreiter mehr, und die Sicht folgt der Rolle, die das
 * Modul selbst fuer "darf freigeben" fragt (der Server liefert sie als
 * `view`, siehe routes/dashboard.js):
 *
 *   self     - das Kind sieht NUR sich: Stand, einen ruhigen Balken zur
 *              naechsten Praemie, die zuletzt verdienten Punkte;
 *   approver - Eltern sehen jedes Kind nebeneinander (nach Namen), je Kind
 *              Stand und Ziel, dazu die offenen Freigaben als Sprung;
 *   family   - Wandtablett und Mitglieder ohne eigene Punkte: wie die Eltern,
 *              ohne Freigaben.
 *
 * Das Ziel waehlt /utils/reward-goal.js, dieselbe Regel wie der Balken auf der
 * Belohnungen-Seite - zwei Balken mit zwei Zielen waeren zwei Wahrheiten. */

/** So viele Mitglieder zeigt die Eltern-Sicht je Kachelhoehe; der Rest spricht als Zahl. */
const REWARD_MEMBERS_SHORT = 2;
const REWARD_MEMBERS_TALL = 5;

function sizeSpans(size) {
  const [cols, rows] = String(size ?? '1x2').split('x').map(Number);
  return { cols: cols || 1, rows: rows || 1 };
}

/** Der Satz zur naechsten Praemie - fuer Balken und Kennzahlkachel derselbe. */
function rewardGoalLabel(balance, catalog, goal = nextRewardGoal(balance, catalog)) {
  // Ein Minus steht nie ohne Satz da (#1607) - derselbe Satz und dieselbe
  // Reihenfolge wie nextRewardHint() auf der Belohnungsseite.
  if (Number(balance) < 0) return t('rewards.balanceBelowZero');
  if (!goal) return t('rewards.noRewardsYet');
  if (goal.reached) return t('rewards.canRedeemNow');
  return t('rewards.remainingToReward', { points: formatPoints(goal.missing), reward: goal.target.name });
}

/**
 * Balken plus Satz zur naechsten Praemie. Die Ansage traegt den Satz
 * (`aria-valuetext`), nicht die Prozentzahl - "noch 15 bis Kinoabend" ist die
 * Aussage, 75 % ist nur ihre Ableitung. Ohne einloesbare Praemie gibt es
 * keinen Balken: er behauptete einen Weg, den niemand angelegt hat.
 *
 * `compact` laesst den sichtbaren Satz weg und behaelt die Ansage: auf einer
 * Kachel, die eine Rasterzeile hoch ist, trug die Eltern-Sicht mit Satz 259px
 * gegen 183px der Nachbarkachel und dehnte deren Zeile mit (gemessen 1440px).
 * Wer den Satz lesen will, zieht die Kachel auf 1x2 - dort steht er.
 *
 * AUSNAHME: DAS MINUS (#1623). Eine negative Zahl neben einem leeren Balken
 * erklaert sich nicht, und der Satz stand nur in der Ansage. Kompakt steht
 * deshalb eine Kurzform (`.rewards-goal__label--compact`, hoechstens zwei
 * Zeilen), und sie steht AN STELLE des Balkens: der ist bei null leer und
 * sagt sichtbar nichts, kostete mit der Zeile zusammen aber 23px je Mitglied
 * (so 9px). Er bleibt per `.sr-only` im DOM - die Ansage behaelt Rolle, Wert
 * und den ganzen Satz. Ueber null und auf der hohen Kachel aendert sich nichts.
 */
function rewardGoalHTML(balance, catalog, who = '', { compact = false } = {}) {
  const goal = nextRewardGoal(balance, catalog);
  const label = rewardGoalLabel(balance, catalog, goal);
  if (!goal) return `<p class="rewards-goal__label rewards-goal__label--muted">${esc(label)}</p>`;
  const name = who ? `${t('rewards.progressLabel')}: ${who}` : t('rewards.progressLabel');
  const compactHint = compact && Number(balance) < 0
    ? `<p class="rewards-goal__label rewards-goal__label--compact" aria-hidden="true">${esc(t('rewards.balanceBelowZeroShort'))}</p>`
    : '';
  return `
    <div class="rewards-goal__track${compactHint ? ' sr-only' : ''}" role="progressbar" aria-label="${esc(name)}"
         aria-valuenow="${goal.pct}" aria-valuemin="0" aria-valuemax="100"
         aria-valuetext="${esc(label)}"><span class="rewards-goal__fill" style="--rewards-progress:${goal.pct / 100}"></span></div>
    ${compact ? compactHint : `<p class="rewards-goal__label" aria-hidden="true">${esc(label)}</p>`}`;
}

function rewardAvatarHTML(m) {
  const color = m.avatar_color || AVATAR_FALLBACK_COLOR;
  const inner = m.avatar_data
    ? `<img src="${esc(m.avatar_data)}" alt="" loading="lazy">`
    : esc(initials(m.display_name));
  return `<span class="list-row__lead rewards-member__avatar" aria-hidden="true" style="background:${esc(color)};color:${getReadableTextColor(color)}">${inner}</span>`;
}

/* DIE FREIGABE IST EINE ZEILE, KEINE KAPSEL (DW-P3-6). "2 zu bestaetigen"
 * stand als 44px-Mulde ueber die volle Breite und las sich wie ein
 * abgeschalteter Knopf; DESIGN.md sagt seit R10: ein getoentes Well ist die
 * Form der Handlungsaufforderung, nicht der Auskunft - und ein Knopf, der wie
 * ausgegraut aussieht, ist keins von beidem. Jetzt steht sie im Zeilengeruest
 * der Kachel: Zeichen vorn, der Satz als Titel, der Druck auf der ganzen
 * Zeile, der Pfeil sagt "fuehrt weiter". */
function rewardsFooterHTML(text) {
  return `<a class="list-row rewards-widget__footer" href="/rewards" data-route="/rewards">
      <span class="list-row__lead rewards-widget__footer-icon" aria-hidden="true"><i data-lucide="clock"></i></span>
      <span class="list-row__main"><span class="list-row__name">${esc(text)}</span></span>
      <i data-lucide="chevron-right" class="rewards-widget__footer-chevron" aria-hidden="true"></i>
    </a>`;
}

/**
 * Wann eine Gutschrift kam - rueckwaerts gelesen. `relativeDateLabel` schaut
 * nach vorn (heute, morgen) und schrieb fuer vorgestern "21.09.2026": in einer
 * Zeile, die ohnehin nur die letzten Tage traegt, ist das Jahr Laerm. Es steht
 * nur, wenn es ein anderes ist.
 */
function earnedWhenLabel(value) {
  const day = zonedDateKey(value);
  if (!day) return '';
  const today = householdToday();
  if (day === today) return t('common.today');
  if (day === addLocalDays(today, -1)) return t('common.yesterday');
  return dateText(value);
}

/* Wie viele juengste Punkte die eigene Sicht in ihrer Groesse zeigt: die kleine
 * Kachel traegt nur den Weg zum Ziel - mit einer Verlaufszeile und dem
 * Anfrage-Chip stand sie bei 275px gegen 183px der Nachbarn (gemessen 1440px).
 * Breit steht der Verlauf daneben, hoch darunter. */
function rewardsRecentCap(spans) {
  return spans.rows >= 2 ? 3 : spans.cols >= 2 ? 2 : 0;
}

/* Die Zusatzzeilen der Belohnungskachel (U14): die juengsten Punkte, die die
 * eigene Sicht geladen, aber in ihrer Groesse nicht zeigt, bzw. die Mitglieder
 * hinter dem Deckel der Familiensicht. */
function rewardsFillRows(r, own, members, spans) {
  if (!members.length) return 0;
  if (own && members.length === 1) return fillRows((Array.isArray(r.recent) ? r.recent : []).length, rewardsRecentCap(spans));
  return fillRows(members.length, spans.rows >= 2 ? REWARD_MEMBERS_TALL : REWARD_MEMBERS_SHORT);
}

function renderRewardsSelf(me, rewards, spans, fill = 0) {
  // HOEHE WIRD INHALT (U14, vorher R22 S10 als eigene CSS-Fuell-Liste): was
  // die Packung der Kachel an Hoehe zuteilt, fuellen weitere juengste Punkte -
  // in der kleinen Kachel samt Ueberschrift, die dann mit der ersten Zeile kommt.
  const recentCap = rewardsRecentCap(spans);
  const recent = (Array.isArray(rewards.recent) ? rewards.recent : []).slice(0, recentCap + fill);
  const recentHTML = recent.length ? `
      <div class="rewards-self__recent"${recentCap === 0 ? ' data-fill-group' : ''}>
        <p class="rewards-self__recent-title" aria-hidden="true">${esc(t('dashboard.rewardsRecent'))}</p>
        <ul class="rewards-recent" aria-label="${esc(t('dashboard.rewardsRecent'))}">
          ${recent.map((row, index) => `
            <li class="rewards-recent__row"${fillRowAttr(index, recentCap)}>
              <span class="rewards-recent__delta">+${esc(formatPoints(row.delta))}</span>
              <span class="rewards-recent__reason">${esc(row.reason || t(`rewards.ledgerType.${row.type}`))}</span>
              <span class="rewards-recent__when">${esc(earnedWhenLabel(row.created_at))}</span>
            </li>`).join('')}
        </ul>
      </div>` : '';
  // Praemien- und Geld-Anfragen (#1734) zusammen: der Server fuehrt sie
  // getrennt, die Kachel sagt, wie viele warten.
  const pending = (Number(rewards.pending) || 0) + (Number(rewards.moneyPending) || 0);
  return `
    <div class="widget__body rewards-widget rewards-widget--self">
      <div class="rewards-self">
        <div class="rewards-self__goal">
          <p class="rewards-self__points">${esc(t('dashboard.metricPoints', { count: Number(me.balance) || 0 }))}</p>
          ${rewardGoalHTML(me.balance, rewards.catalog)}
        </div>
        ${recentHTML}
      </div>
      ${pending > 0 ? rewardsFooterHTML(t('dashboard.rewardsOwnPending', { count: pending })) : ''}
    </div>`;
}

function renderRewardsFamily(members, rewards, spans, fill = 0) {
  // In der Haushaltsreihenfolge (#1644), nicht nach Punkten: eine Reihenfolge
  // nach Stand WAERE die Rangliste, nur ohne Ziffern. Der Server liefert die
  // Liste schon so; sortiert wird hier trotzdem, weil die Zusage dieser Kachel
  // ("nie nach Stand") nicht an der Abfrage einer anderen Datei haengen soll.
  const sorted = sortMembers(members);
  const cap = spans.rows >= 2 ? REWARD_MEMBERS_TALL : REWARD_MEMBERS_SHORT;
  const shown = sorted.slice(0, cap + fill);
  const rows = shown.map((m, index) => `
      <li class="list-row rewards-member"${fillRowAttr(index, cap)}>
        ${rewardAvatarHTML(m)}
        <span class="list-row__main rewards-member__body">
          <span class="list-row__name rewards-member__name">${esc(m.display_name)}</span>
          ${rewardGoalHTML(m.balance, rewards.catalog, m.display_name, { compact: spans.rows < 2 })}
        </span>
        <span class="list-row__end rewards-member__points">${esc(t('dashboard.metricPoints', { count: Number(m.balance) || 0 }))}</span>
      </li>`).join('');
  const more = sorted.length - Math.min(shown.length, cap);
  const pending = rewards.view === 'approver' ? (Number(rewards.pending) || 0) + (Number(rewards.moneyPending) || 0) : 0;
  return `
    <div class="widget__body widget__body--rows rewards-widget">
      ${widgetRows(rows, { tag: 'ul', className: 'rewards-widget__members' })}
      ${more > 0 ? `<p class="rewards-widget__more"${fillMoreAttrs(fill, more, 'dashboard.shoppingMore')}>${esc(t('dashboard.shoppingMore', { count: more }))}</p>` : ''}
      ${pending > 0 ? rewardsFooterHTML(t('dashboard.rewardsPending', { count: pending })) : ''}
    </div>`;
}

function renderRewardsWidget(rewards, size) {
  const r = rewards ?? {};
  const standings = Array.isArray(r.standings) ? r.standings : [];
  const own = standings.find((m) => m.id === r.me);
  // Das Kind sieht NUR sich, auch wenn eine Antwort mehr mitbraechte.
  const members = r.view === 'self' ? (own ? [own] : []) : standings;
  const header = widgetHeader('rewards', t('nav.rewards'), null, '/rewards');
  const fill = rewardsFillRows(r, own, members, sizeSpans(size));
  const span = tileSpanAttrs((sz, k = 0) => rewardsTileModel(r, own, members, sizeSpans(sz), k), size, fill);

  if (!members.length) {
    // Praemien anlegen ist Elternsache: einem Kind einen Knopf zu zeigen, der
    // in eine Seite fuehrt, auf der es nichts anlegen darf, waere die leere
    // Zusage aus #700.
    const cta = r.view === 'approver' && navModuleAccess('rewards') === 'write'
      ? emptyRouteAction('/rewards', t('common.add')) : null;
    return `<div class="widget widget--rewards"${span}>
      ${header}
      ${widgetEmptyHtml(t('dashboard.noRewards'), cta, 'rewards')}
    </div>`;
  }

  const spans = sizeSpans(size);
  // WER ALLEIN SAMMELT, SIEHT SEINEN WEG - auch als Elternteil im
  // Ein-Personen-Haushalt. Eine Uebersicht "je Kind" mit genau einer Zeile,
  // die man selbst ist, waere die Eltern-Sicht ohne Kinder.
  const body = own && members.length === 1
    ? renderRewardsSelf(own, r, spans, fill)
    : renderRewardsFamily(members, r, spans, fill);
  return `<div class="widget widget--rewards"${span}>
    ${header}
    ${body}
  </div>`;
}

/* Die Hoehe der Belohnungskachel aus denselben Zahlen wie ihre zwei Fassungen
 * (U1 b): die eigene (Stand, Ziel, juengste Punkte, offene Freigaben) oder die
 * der Familie (eine Zeile mit Balken je Mitglied, flach in 1x1). */
function rewardsTileModel(r, own, members, spans, k = 0) {
  if (!members.length) return { items: 0 };
  const pendingAll = (Number(r.pending) || 0) + (Number(r.moneyPending) || 0);
  const recentAll = Array.isArray(r.recent) ? r.recent : [];
  if (own && members.length === 1) {
    // Mit k Zusatzzeilen (U14) k juengste Punkte mehr - in der kleinen
    // Kachel kommt mit der ersten auch die Ueberschrift.
    const recent = recentAll.slice(0, rewardsRecentCap(spans) + Math.max(0, k)).length;
    return {
      body: TILE_PARTS.rewardsSelfPad + TILE_PARTS.rewardsSelfGoal
        + (recent ? TILE_PARTS.rewardsGap + TILE_PARTS.rewardsRecentTitle + recent * TILE_PARTS.rewardsRecentRow : 0)
        + (pendingAll > 0 ? TILE_PARTS.rewardsGap + TILE_PARTS.rewardsFooter : 0),
    };
  }
  const cap = (spans.rows >= 2 ? REWARD_MEMBERS_TALL : REWARD_MEMBERS_SHORT) + Math.max(0, k);
  const shown = Math.min(members.length, cap);
  const pending = r.view === 'approver' ? pendingAll : 0;
  const more = members.length > shown;
  return {
    items: shown,
    row: spans.rows < 2 ? TILE_PARTS.rewardsMemberCompact : TILE_PARTS.rewardsMember,
    more: false,
    extra: (more ? TILE_PARTS.rewardsGap + TILE_PARTS.rewardsMore : 0) + (pending > 0 ? TILE_PARTS.rewardsGap + TILE_PARTS.rewardsFooter : 0),
  };
}

// --------------------------------------------------------
// Gesundheit-Widget (heutige Medikamenten-Dosen)
// --------------------------------------------------------

function renderHealthWidget(health, size = '2x1') {
  if (!health?.hasMeds) {
    return `<div class="widget widget--health"${emptySpanAttrs(size)}>
      ${widgetHeader('health', t('nav.health'), null, '/health')}
      ${widgetEmptyHtml(t('dashboard.healthNoMeds'), emptyRouteAction('/health', t('common.add')), 'health')}
    </div>`;
  }

  const total = Number(health?.dosesTotal) || 0;
  const taken = Number(health?.dosesTaken) || 0;
  const lowStock = Number(health?.lowStockCount) || 0;
  const pct = total > 0 ? Math.max(0, Math.min(1, taken / total)) : 0;
  const allTaken = total > 0 && taken >= total;

  const lowChip = lowStock > 0
    ? `<div class="health-widget__refill"><i data-lucide="package" aria-hidden="true"></i><span>${t('dashboard.healthRefill', { count: lowStock })}</span></div>`
    : '';

  let main;
  if (total === 0) {
    main = `<div class="health-widget__none">
      <i data-lucide="coffee" class="health-widget__none-icon" aria-hidden="true"></i>
      <span>${t('dashboard.healthNoDosesToday')}</span>
    </div>`;
  } else {
    const status = allTaken
      ? `<div class="health-widget__status health-widget__status--done"><i data-lucide="check" aria-hidden="true"></i>${t('dashboard.healthAllTaken')}</div>`
      : health?.nextDose
        ? `<div class="health-widget__next">
            <span class="health-widget__next-time">${esc(health.nextDose.time)}</span>
            <span class="health-widget__next-name">${esc(health.nextDose.name)}</span>
          </div>`
        : '';
    main = `
      <div class="health-widget__progress">
        <div class="health-widget__bar" role="img" aria-label="${t('dashboard.healthDosesProgress', { taken, total })}">
          <div class="health-widget__bar-fill${allTaken ? ' health-widget__bar-fill--done' : ''}" style="--dose-scale:${pct}"></div>
        </div>
        <div class="health-widget__count"><strong>${taken}</strong>/${total}</div>
      </div>
      ${status}
    `;
  }

  // Fortschritt und Satz darunter, oder "heute nichts"; dazu ggf. der Chip.
  const span = tileSpanAttrs(() => ({
    body: TILE_PARTS.statusPad
      + (total === 0 ? TILE_PARTS.healthNone : TILE_PARTS.healthProgress + (allTaken || health?.nextDose ? TILE_PARTS.statusLine : 0))
      + (lowStock > 0 ? TILE_PARTS.statusChip : 0),
  }), size);
  return `<div class="widget widget--health"${span}>
    ${widgetHeader('health', t('nav.health'), null, '/health')}
    <div class="widget__body">
      <div class="health-widget">${main}${lowChip}</div>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Zyklus-Widget (owner-only, opt-in)
// --------------------------------------------------------
// Strikt privat: Die Vorhersage wird client-seitig aus den nutzer-eigenen
// /health/cycle/*-Endpunkten berechnet (siehe render()) und fließt NIE in den
// familienweiten /dashboard-Payload. Zeigt Phase + Zyklustag (Mini-Ring) und die
// nächste Periode als Countdown — die eine glanceable Zahl für den Alltag.

const CYCLE_WIDGET_PHASE_KEYS = {
  [PHASE.MENSTRUATION]: 'health.cycle.phase.menstruation',
  [PHASE.FOLLICULAR]:   'health.cycle.phase.follicular',
  [PHASE.FERTILE]:      'health.cycle.phase.fertile',
  [PHASE.OVULATION]:    'health.cycle.phase.ovulation',
  [PHASE.LUTEAL]:       'health.cycle.phase.luteal',
};

// Phasenfarbe für den Ring-Bogen; Follikel-/Lutealphase tragen den Modul-Akzent.
const CYCLE_WIDGET_PHASE_COLOR = {
  [PHASE.MENSTRUATION]: 'var(--cycle-period)',
  [PHASE.FERTILE]:      'var(--cycle-fertile)',
  [PHASE.OVULATION]:    'var(--cycle-ovulation)',
};

function cycleWidgetCountdown(prediction) {
  const d = prediction.daysUntilNext;
  if (d === 0) return t('health.cycle.status.today');
  if (d < 0) return t('health.cycle.status.overdue', { count: Math.abs(d) });
  return t('health.cycle.status.inDays', { count: d });
}

function renderCycleWidget(cycle, size = '2x1') {
  // cycle: { periods, settings } (owner-only) | null (Ladefehler) | undefined (Kachel versteckt)
  const prediction = cycle
    ? predictCycle(cycle.periods || [], cycle.settings || {})
    : { hasData: false };

  // Ohne Historie: Onboarding-Empty statt Fehlerkachel — führt in den Zyklus-Flow.
  if (!prediction.hasData) {
    return `<div class="widget widget--cycle"${emptySpanAttrs(size)}>
      ${widgetHeader('cycle', t('health.cycle.title'), null, '/health/cycle')}
      ${widgetEmptyHtml(t('health.cycle.emptyTitle'), emptyRouteAction('/health/cycle', t('health.cycle.add')), 'cycle')}
    </div>`;
  }

  const phaseLabel = t(CYCLE_WIDGET_PHASE_KEYS[prediction.phase] || CYCLE_WIDGET_PHASE_KEYS[PHASE.FOLLICULAR]);
  const dayText = t('health.cycle.ring.cycleDay', { day: prediction.cycleDay });
  const countdown = cycleWidgetCountdown(prediction);
  // Dieselbe Stufung wie jedes kommende Datum der Uebersicht (#1454); sagt der
  // Zaehler schon „heute", steht das Wort nicht zweimal da.
  const nextLabel = relativeDateLabel(prediction.nextStart);
  const cycleDate = nextLabel && nextLabel.toLowerCase() !== countdown.toLowerCase()
    ? `<span class="cycle-widget__date">${esc(nextLabel)}</span>`
    : '';
  const phaseColor = CYCLE_WIDGET_PHASE_COLOR[prediction.phase] || 'var(--module-health)';

  // Mini-Fortschrittsring: Zyklustag / Ø-Zyklus als einzelner Bogen in Phasenfarbe.
  const R = 26;
  const C = 2 * Math.PI * R;
  const frac = Math.min(1, Math.max(0, prediction.cycleDay / Math.max(1, prediction.avgCycle)));
  const lit = (frac * C).toFixed(2);
  const gap = (C - frac * C).toFixed(2);

  const ring = `
    <svg class="cycle-widget__ring" viewBox="0 0 64 64" role="img" aria-label="${esc(`${phaseLabel} · ${dayText}`)}">
      <circle class="cycle-widget__ring-track" cx="32" cy="32" r="${R}" fill="none" stroke-width="6" />
      <circle class="cycle-widget__ring-arc" cx="32" cy="32" r="${R}" fill="none" stroke="${phaseColor}"
        stroke-width="6" stroke-linecap="round" stroke-dasharray="${lit} ${gap}" transform="rotate(-90 32 32)" />
      <text class="cycle-widget__ring-num" x="32" y="32" text-anchor="middle" dominant-baseline="central">${esc(prediction.cycleDay)}</text>
    </svg>`;

  // Ring neben Phase, Countdown und ggf. Datum - die hoehere der beiden Spalten.
  const span = tileSpanAttrs(() => ({
    body: TILE_PARTS.statusPad + Math.max(TILE_PARTS.cycleRing, TILE_PARTS.cycleInfo + (cycleDate ? TILE_PARTS.cycleDate : 0)),
  }), size);
  return `<div class="widget widget--cycle"${span}>
    ${widgetHeader('cycle', t('health.cycle.title'), null, '/health/cycle')}
    <div class="widget__body">
      <div class="cycle-widget" data-phase="${esc(prediction.phase)}">
        ${ring}
        <div class="cycle-widget__info">
          <span class="cycle-widget__phase">${esc(phaseLabel)}</span>
          <span class="cycle-widget__next">
            <span class="cycle-widget__next-label">${esc(t('health.cycle.status.nextPeriod'))}</span>
            <span class="cycle-widget__countdown">${esc(countdown)}</span>
          </span>
          ${cycleDate}
        </div>
      </div>
    </div>
  </div>`;
}

/* DAS ZIFFERBLATT BEGLEITET DEN SATZ, ES TRAEGT IHN NICHT (DW-P3-5). Der Ring
 * der Gesundheitsseite stand hier in ganzer Groesse (224px) und trug Satz und
 * Uhr in seiner Mitte - am Telefon 374px Kachel fuer "Bereit fuer deinen
 * naechsten Fastenstart", und daneben ein zweiter GEFUELLTER Primaerknopf
 * neben "+ Neu". Jetzt ein kleiner Ring (hoechstens 120px, ohne Stundenmarken)
 * NEBEN dem Satz, wie ein Ring in den Health-Widgets; Uhr und Tag stehen als
 * Text daneben, und "Fasten starten/beenden" ist sekundaer: der eine gefuellte
 * Knopf des Schirms ist das Anlegen. Die Selektoren der Uhr (`data-fasting-*`)
 * gelten fuer die ganze Kachel, nicht nur fuer den Ring. */
function renderFastingWidget(fasting, size = '2x1') {
  if (!fasting) throw new Error('fasting widget slice failed to load');
  const active = fasting.active;
  const writable = moduleAccess('health') === 'write';
  const span = tileSpanAttrs((s) => ({
    body: (active ? TILE_PARTS.fastingActive : TILE_PARTS.fasting)[tileColumns(s) >= 2 ? 'wide' : 'narrow'],
  }), size);
  return `<div class="widget widget--fasting"${span}>${widgetHeader('fasting', t('health.fasting.title'), null, null, null, 'health')}
    <div class="fasting-widget">
      <div class="fasting-dial fasting-dial--segmented" data-fasting-progress><div data-fasting-segments></div></div>
      <div class="fasting-widget__controls">
        <div class="fasting-widget__status">
          <span class="fasting-widget__meta" data-fasting-clock-label></span>
          <strong class="fasting-widget__timer" data-fasting-timer>00:00:00</strong>
          <span class="fasting-widget__meta" data-fasting-days></span>
        </div>
        ${fastingClockSwitchHtml()}
        ${active ? '<span class="fasting-widget__remaining" data-fasting-remaining></span>' : ''}
        <p class="sr-only" role="status" aria-live="polite" data-fasting-announcement></p>
        <div class="fasting-widget__actions">${writable ? `<button type="button" class="btn btn--secondary btn--sm" data-fasting-widget-action>${esc(t(active ? 'health.fasting.finish' : 'health.fasting.start'))}</button>` : `<p class="form-hint">${esc(t('health.fasting.readOnly'))}</p>`}<a href="/health/fasting#history" class="btn btn--ghost btn--sm">${esc(t('health.fasting.history'))}</a></div>
      </div>
      <p class="form-hint fasting-widget__error" role="alert" data-fasting-widget-error></p>
    </div></div>`;
}

// `refresh` ist der stille Abgleich der Seite: Starten und Beenden lassen die
// Uebersicht stehen (DW-P1-2), statt sie ueber das Skelett neu aufzubauen.
//
// IM ANPASSEN-MODUS STARTET UND BEENDET DIE KACHEL NICHTS (Review p11, B5) -
// wie jeder andere Kachelinhalt dort (wireLinks: "dort zieht man Kacheln, man
// bearbeitet ihren Inhalt nicht"). Der Knopf war der eine, der weiter schrieb:
// der Server fastete, aber der stille Abgleich schweigt waehrend des
// Anpassens, und die Kachel bot nach "Starten" weiter "Fasten starten" an -
// auch nach "Abbrechen", das aus den alten Daten neu baut. Er steht dort
// gesperrt; die Uhr laeuft weiter.
function wireFastingWidget(container, refresh, fasting, signal, { editing = false } = {}) {
  const root = container.querySelector('.fasting-widget');
  if (!root || !fasting) return () => {};
  const action = root.querySelector('[data-fasting-widget-action]');
  if (editing && action) action.disabled = true;
  if (!editing) action?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (fasting.active) await finishFasting(fasting.active, refresh, () => !signal.aborted);
      else if (await startFasting()) { await refresh(); refocusAfterRender(); }
    } catch (error) {
      if (root.isConnected) root.querySelector('[data-fasting-widget-error]').textContent = fastingError(error);
    } finally { button.disabled = false; }
  }, { signal });
  return startFastingClock(root, fasting.active, fasting.lastCompleted, fasting.settings, { refresh });
}

// --------------------------------------------------------
// Naehrwerte-Widget (opt-in, #1326)
// --------------------------------------------------------

/**
 * `nutrition` kommt fertig gerechnet aus `/dashboard` - dieselbe Bilanz, die
 * auch `/health/nutrition/summary` liefert (services/health-nutrition.js). Hier
 * wird nichts zusammengezaehlt: eine zweite Rechnung waere eine zweite Zahl,
 * und die Kachel wuerde dem Tab widersprechen.
 *
 * DREI ZUSTAENDE, NICHT ZWEI, und der mittlere ist der, der sonst verloren geht:
 *   - kein Ziel gesetzt (`target === null`) -> die Kachel sagt das und bietet
 *     an, eines zu setzen. NICHT "0 von 0", was wie ein erreichtes Ziel
 *     aussaehe.
 *   - ein Ziel gesetzt, aber noch nichts erfasst -> Balken bei 0. Das ist eine
 *     Aussage ueber den Tag, keine ueber das Ziel.
 *   - ein Ziel von 0 (etwa Zucker) -> ein echtes Ziel, gegen das gemessen wird.
 *     `nutrientProgress()` haelt diesen Fall von "kein Ziel" getrennt.
 */
function renderNutritionWidget(nutrition, size = '2x1') {
  if (nutrition === null || nutrition === undefined) throw new Error('nutrition widget slice failed to load');
  const target = nutrition.target;
  const writable = moduleAccess('health') === 'write';

  if (!target) {
    return `<div class="widget widget--nutrition"${emptySpanAttrs(size)}>
      ${widgetHeader('nutrition', t('health.nutrition.title'), null, '/health/nutrition')}
      ${widgetEmptyHtml(t('dashboard.nutritionNoTarget'), writable ? emptyRouteAction('/health/nutrition', t('health.nutrition.targetSet')) : null, 'nutrition')}
    </div>`;
  }

  // Nur die Naehrwerte mit Ziel: eine Zeile "- von -" waere eine Zeile, die
  // nichts sagt und doch Platz nimmt. Wer nur Energie und Eiweiss verfolgt,
  // bekommt zwei Balken, nicht acht.
  const rows = NUTRIENTS
    .filter((n) => target[n.key] !== null && target[n.key] !== undefined)
    .map((n) => {
      const value = Number(nutrition.totals?.[n.key] ?? 0);
      const progress = nutrientProgress(value, target[n.key]);
      const text = t('health.nutrition.ofTarget', {
        value: fmtDashNum(value), target: fmtDashNum(target[n.key]), unit: t(n.unitKey),
      });
      return `<li class="nutrition-widget__row">
        <span class="nutrition-widget__label">${esc(t(n.labelKey))}</span>
        <span class="nutrition-widget__bar${progress.over ? ' nutrition-widget__bar--over' : ''}"
              role="img" aria-label="${esc(`${t(n.labelKey)}: ${text}`)}">
          <span class="nutrition-widget__fill" style="--nutrition-scale:${progress.ratio}"></span>
        </span>
        <span class="nutrition-widget__value">${esc(text)}</span>
      </li>`;
    });

  const body = rows.length
    ? `<ul class="nutrition-widget__rows">${rows.join('')}</ul>`
    : cardEmptyRowHtml(t('dashboard.nutritionNoTarget'));

  // Eine Zeile je Naehrwert mit Ziel (Wort, Zahl, Balken darunter), dann die Zaehlzeile.
  const span = tileSpanAttrs(() => ({
    body: TILE_PARTS.nutritionPad + (rows.length
      ? rows.length * TILE_PARTS.nutritionRow + (rows.length - 1) * TILE_PARTS.nutritionGap
      : TILE_GEOMETRY.empty) + TILE_PARTS.nutritionCount,
  }), size);
  return `<div class="widget widget--nutrition"${span}>
    ${widgetHeader('nutrition', t('health.nutrition.title'), null, '/health/nutrition')}
    <div class="widget__body">
      <div class="nutrition-widget">
        ${body}
        <p class="nutrition-widget__count">${esc(t('dashboard.nutritionEntries', { count: Number(nutrition.entryCount) || 0 }))}</p>
      </div>
    </div>
  </div>`;
}

/** Eine Naehrwert-Zahl auf der Kachel: hoechstens eine Nachkommastelle. */
function fmtDashNum(value) {
  return getNumberFormat({ maximumFractionDigits: 1 }).format(Number(value) || 0);
}

// --------------------------------------------------------
// Schedule-Widget (wer heute im Dienst oder frei ist)
// --------------------------------------------------------

/**
 * schedule: { entries, hasTypes } (haushaltsweit, kein Owner-Filter noetig -
 * das Modul liest schon fuer den ganzen Haushalt) | null (Ladefehler,
 * rendert die geteilte Fehlerkachel ueber den bestehenden try/catch in
 * renderDashboardLayout, siehe renderWasteWidget) | undefined (Kachel
 * versteckt, kein Request gelaufen).
 *
 * `entries`, nicht `users`: `resolveEntries()` (services/schedule.js) liefert
 * fuer ein Mitglied ohne jedes Muster und ohne Ausnahme heute gar keinen
 * Eintrag - genau die Regel, nach der auch die Schedule-Seite ihre eigene
 * „Heute"-Karte fuellt (renderToday() in schedule.js). Alle Mitglieder
 * aufzulisten wuerde hier etwas zeigen, das die Seite selbst nicht zeigt.
 */
function renderScheduleWidget(schedule, users, size) {
  // M-6b: ein Ladefehler ist kein leerer Tag - ohne diesen Wurf faellt `null`
  // (Fehler) auf denselben Zweig wie `hasTypes === false` (echtes Onboarding)
  // und zeigt die "Schicht-Typ anlegen"-CTA statt der Fehlerkachel, und bleibt
  // wegen der `data.schedule !== undefined`-Merkung in ensureScheduleSlice
  // auch nie neu versucht. Wie renderWasteWidget: der Wurf laesst
  // renderDashboardLayout die geteilte Fehlerkachel (renderWidgetError) mit
  // ihrem Retry rendern.
  if (schedule === null) throw new Error('schedule widget slice failed to load');
  const entries = schedule?.entries ?? [];
  const hasTypes = Boolean(schedule?.hasTypes);
  // Kein "+N weitere": die Kachel nennt die Zahl der Schichten im Kopf.
  const cap = listRowCap(size);
  const fill = hasTypes ? fillRows(entries.length, cap) : 0;
  const span = tileSpanAttrs((s, k = 0) => ({ items: hasTypes ? entries.length : 0, cap: listRowCap(s) + k, more: false }), size, fill);

  if (!hasTypes) {
    return `<div class="widget widget--schedule"${span}>
      ${widgetHeader('schedule', t('nav.schedule'), null, '/schedule')}
      ${widgetEmptyHtml(t('dashboard.scheduleEmpty'), emptyRouteAction('/schedule', t('common.add')), 'schedule')}
    </div>`;
  }

  if (!entries.length) {
    return `<div class="widget widget--schedule"${span}>
      ${widgetHeader('schedule', t('nav.schedule'), null, '/schedule/patterns')}
      ${widgetEmptyHtml(t('schedule.empty'))}
    </div>`;
  }

  // Der Header zaehlt ueber ALLE Eintraege (die ehrliche Zahl), das Raster
  // darunter nur so viele Zeilen, wie die Kachelgroesse traegt - wie jede
  // andere Listenkachel (`listRowCap`, PR #930 review). Ohne den Deckel waere
  // 1x2 nur der Punkt, an dem der Ueberlauf von fuenf Mitgliedern auf sechs
  // verschoben wird, nicht behoben - genau der Fehler, den #928 bei den
  // Notizen schon hatte (renderPinnedNotes ist das Vorbild hier).
  //
  // Zaehlt PERSONEN, nicht Schicht-Eintraege: eine Person mit einer regulaeren
  // Schicht UND einem Extra (Bereitschaft daneben, server/routes/schedule-extras.js)
  // hat zwei Eintraege am selben Tag, aber die Ueberschrift beantwortet "wie
  // viele arbeiten heute", nicht "wie viele Schicht-Zeilen gibt es".
  const onShift = new Set(entries.filter((entry) => entry.shift_type).map((entry) => Number(entry.user_id))).size;
  // Der Deckel allein reicht nicht: `entries` kommt in `users ORDER BY id`,
  // nicht "im Dienst zuerst" - ohne Sortierung koennte der Header "2" zaehlen,
  // waehrend die abgeschnittenen Zeilen zufaellig beide "Freier Tag" zeigen
  // (Review #930: sechs Mitglieder, die zwei im Dienst mit den hoechsten ids).
  // Im-Dienst-Eintraege zuerst, stabil sortiert, dann erst der Deckel.
  const sorted = [...entries].sort((a, b) => (a.shift_type ? 0 : 1) - (b.shift_type ? 0 : 1));
  // Namen aus dem Verzeichnis des Ausschnitts (loadScheduleSlice): auch ein
  // bestehender Plan von Hauspersonal traegt so einen Namen. Ohne Verzeichnis
  // bleibt es bei data.users.
  const directory = schedule?.people?.length ? schedule.people : users;
  const rows = sorted.slice(0, cap + fill).map((entry, index) => {
    const user = directory.find((item) => Number(item.id) === Number(entry.user_id));
    const type = entry.shift_type;
    const accent = user?.avatar_color || AVATAR_FALLBACK_COLOR;
    const avatarInner = user?.avatar_data
      ? `<img src="${esc(user.avatar_data)}" alt="" loading="lazy">`
      : esc(initials(user?.display_name ?? ''));
    const shiftLabel = type
      ? esc(shiftTypeLabel(type))
      : esc(t('schedule.freeDay'));
    const swatchColor = type ? type.color : 'var(--color-border)';
    // Eigene Punkt-Klasse statt `.schedule-swatch` (schedule.css): router.js
    // laedt pro Route nur das CSS des eigenen Moduls nach - auf `/` liegt
    // dashboard.css, schedule.css nie. Ein geteilter Klassenname waere eine
    // unsichtbare Abhaengigkeit zwischen zwei Stylesheets, die nie gemeinsam
    // laufen wuerden.
    const icon = type?.icon ? `<i data-lucide="${esc(type.icon)}" class="schedule-widget-row__icon" aria-hidden="true"></i>` : '';
    const badge = entry.source === 'extra' ? `<i data-lucide="layers" class="schedule-widget-row__extra-badge" aria-label="${esc(t('schedule.extraBadgeLabel'))}"></i>` : '';
    return `
      <div class="list-row schedule-widget-row" data-route="/schedule/patterns" role="button" tabindex="0"${fillRowAttr(index, cap)}>
        <span class="list-row__lead schedule-widget-row__avatar" style="background:${esc(accent)};color:${getReadableTextColor(accent)}">${avatarInner}</span>
        <span class="list-row__main">
          <span class="list-row__name schedule-widget-row__name">${esc(user?.display_name ?? '')}</span>
          <span class="list-row__meta schedule-widget-row__shift"><span class="schedule-widget-row__dot" style="--schedule-color:${esc(swatchColor)}"></span>${icon}${shiftLabel}${badge}</span>
        </span>
      </div>`;
  }).join('');

  return `<div class="widget widget--schedule"${span}>
    ${widgetHeader('schedule', t('nav.schedule'), onShift, '/schedule/patterns')}
    <div class="widget__body widget__body--rows">${widgetRows(rows, { className: 'schedule-widget' })}</div>
  </div>`;
}

// --------------------------------------------------------
// Vorrat-Widget „Laeuft bald ab" (Critique 2026-09-23)
// --------------------------------------------------------

/** Menge knapp: 2 bleibt "2", 2,5 wird lokalisiert - wie auf der Vorratsseite,
 *  und ueber denselben Helfer, damit die Einheit mitflektiert („6 Dosen"). */
function pantryQuantityText(item) {
  const nf = getNumberFormat({ maximumFractionDigits: 2 });
  return pantryQuantityLabel(item.quantity, item.unit, { t, formatNumber: (n) => nf.format(n) });
}

/**
 * pantryExpiring: { items, todayItems, total, expiredCount, todayCount } aus
 * GET /dashboard (services/pantry-expiring.js) | null (Ladefehler, rendert die
 * geteilte Fehlerkachel ueber den try/catch in renderDashboardLayout).
 *
 * EINE ZEILE IST EINE CHARGE, nicht ein Produkt: zwei Packungen Milch mit zwei
 * Daten sind zwei Zeilen, wie auf der Vorratsseite. Das Haushalts-Produkt ueber
 * der Charge (#1448) steht noch aus, und eine Gruppierung nach Namen waere
 * hier eine zweite, eigene Vorstellung davon.
 *
 * DIE RESTTAGE KOMMEN VOM SERVER (`days_left`), gerechnet am Haushaltstag
 * derselben Antwort, aus der auch Badge und Zaehler stammen. Eine zweite
 * Rechnung hier kippte kurz nach Mitternacht gegen die Badge daneben.
 *
 * Der Ton spricht nur in der Resttage-Zeile, und nur, wo es etwas zu tun gibt:
 * abgelaufen im Gefahrenton, heute und morgen im Warnton, alles Weitere im
 * Sekundaerton. Eine Liste, die jede Zeile rot faerbt, sagt nichts mehr.
 *
 * Reine Anzeige - kein Knopf, der schreibt. Wer nur lesen darf, sieht dieselbe
 * Kachel; die Zeilen fuehren in den passend gefilterten Vorrat.
 */
function renderPantryWidget(pantry, size) {
  if (pantry === null || pantry === undefined) throw new Error('pantry widget slice failed to load');
  const title = t('dashboard.pantryExpiringTitle');
  const items = Array.isArray(pantry.items) ? pantry.items : [];
  const pantryTotal = Number.isFinite(Number(pantry.total)) ? Number(pantry.total) : items.length;
  const cap = listRowCap(size);
  const fill = fillRows(items.length, cap);
  const span = tileSpanAttrs((s, k = 0) => ({ items: items.length, total: pantryTotal, cap: listRowCap(s) + k }), size, fill);

  if (!items.length) {
    return `<div class="widget widget--pantry"${span}>
      ${widgetHeader('pantry', title, null, '/pantry')}
      ${widgetEmptyHtml(t('dashboard.pantryExpiringEmpty', { count: EXPIRY_SOON_DAYS }))}
    </div>`;
  }

  const shown = items.slice(0, cap + fill);
  const rows = shown.map((item, index) => {
    const days = Number(item.days_left);
    const tone = pantryExpiryTone(days);
    const phrase = pantryExpiryPhrase(days);
    const label = phrase.count === undefined ? t(phrase.key) : t(phrase.key, { count: phrase.count });
    const icon = item.location_icon && hasIcon(item.location_icon) ? item.location_icon : 'package';
    const meta = [pantryQuantityText(item), item.location_name ? locationLabel(item.location_name) : '']
      .filter(Boolean).join(' · ');
    const filter = tone === 'expired' ? 'expired' : 'soon';
    return `
      <div class="list-row pantry-widget-row" data-route="/pantry?filter=${filter}" role="button" tabindex="0"${fillRowAttr(index, cap)}>
        <span class="list-row__lead pantry-widget-row__icon" aria-hidden="true"><i data-lucide="${esc(icon)}"></i></span>
        <div class="list-row__main pantry-widget-row__body">
          <div class="list-row__name pantry-widget-row__name">${esc(item.name)}</div>
          <div class="list-row__meta pantry-widget-row__meta">${esc(meta)}</div>
        </div>
        <div class="list-row__end pantry-widget-row__days pantry-widget-row__days--${tone}">${esc(label)}</div>
      </div>`;
  }).join('');

  // Gezaehlt gegen die SERVER-Gesamtzahl: der Server deckelt die Liste selbst,
  // und eine Fussnote aus der geladenen Laenge verschwiege genau diesen Schnitt
  // (dieselbe Lehre wie beim Countdown, #647).
  const total = Number.isFinite(Number(pantry.total)) ? Number(pantry.total) : items.length;
  const rest = Math.max(0, total - Math.min(shown.length, cap));
  const more = rest > 0
    ? `<p class="pantry-widget-more"${fillMoreAttrs(fill, rest, 'dashboard.pantryExpiringMore')}>${esc(t('dashboard.pantryExpiringMore', { count: rest }))}</p>`
    : '';

  return `<div class="widget widget--pantry"${span}>
    ${widgetHeader('pantry', title, total, '/pantry')}
    <div class="widget__body widget__body--rows">${widgetRows(rows)}${more}</div>
  </div>`;
}

// --------------------------------------------------------
// Waste-Widget (naechste Abholung je aktivem Typ)
// --------------------------------------------------------

/**
 * waste: { items: WasteNextPerTypeEntry[], needsRefresh } (haushaltsweit,
 * /waste/occurrences/next liefert schon ein Eintrag je aktivem Typ, sortiert
 * nach Typ-Reihenfolge - die Kachel sortiert selbst nach Datum um, das ist
 * eine Praesentationsfrage, keine API-Vertragsfrage) | null (Ladefehler,
 * rendert die geteilte Fehlerkachel ueber den bestehenden try/catch in
 * renderDashboardLayout) | undefined (Kachel versteckt, kein Request gelaufen).
 */
function renderWasteWidget(waste, size) {
  if (waste === null) throw new Error('waste widget slice failed to load');
  const items = waste?.items ?? [];
  const cap = listRowCap(size);
  const fill = fillRows(items.length, cap);
  const span = tileSpanAttrs((s, k = 0) => ({ items: items.length, cap: listRowCap(s) + k, extra: waste?.needsRefresh ? TILE_PARTS.wasteWarning : 0 }), size, fill);

  if (!items.length) {
    return `<div class="widget widget--waste"${span}>
      ${widgetHeader('waste', t('nav.waste'), null, '/waste')}
      ${widgetEmptyHtml(t('waste.emptyTypesTitle'), emptyRouteAction('/waste', t('common.add')), 'waste')}
    </div>`;
  }

  // Datum zuerst, Typ-Reihenfolge nur als Tie-Breaker - anders als die
  // API-Grundsortierung (Typ-Reihenfolge), die fuer andere Aufrufer (Token/MCP)
  // die richtige Vorgabe bleibt.
  const sorted = [...items].sort((a, b) => {
    const ad = a.next?.date_key ?? null;
    const bd = b.next?.date_key ?? null;
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    return (a.type.sort_order - b.type.sort_order) || (a.type.id - b.type.id);
  });
  const earliestDate = sorted.find((e) => e.next)?.next.date_key ?? null;
  const upcomingCount = items.filter((e) => e.next).length;

  const capped = sorted.slice(0, cap + fill);
  const rows = capped.map((entry, index) => {
    const type = entry.type;
    const next = entry.next;
    const accent = type.color || 'var(--color-border)';
    const icon = type.icon ? `<i data-lucide="${esc(type.icon)}" class="waste-widget-row__icon" aria-hidden="true"></i>` : '';

    if (!next) {
      return `
        <div class="list-row waste-widget-row" data-route="${esc(`/waste?type=${encodeURIComponent(String(type.id))}`)}" role="button" tabindex="0"${fillRowAttr(index, cap)}>
          <span class="list-row__lead" aria-hidden="true"><span class="waste-widget-row__dot" style="--waste-color:${esc(accent)}"></span></span>
          <span class="list-row__main"><span class="list-row__name waste-widget-row__name">${icon}${esc(type.name)}</span></span>
          <span class="list-row__end waste-widget-row__date waste-widget-row__date--none">${esc(t('waste.noUpcomingPickup'))}</span>
        </div>`;
    }

    // Dieselbe Herkunfts-Extraktion wie originBadges() (pages/waste.js): der
    // Beleg fuer "verschoben" ist der Ursprungstermin des Schedule-Origins, nicht
    // ein eigenes Feld auf der Occurrence.
    const movedOriginal = next.moved
      ? next.origins.find((o) => o.kind === 'schedule' && o.original_date)?.original_date
      : null;
    const moved = next.moved
      ? `<i data-lucide="move" class="waste-widget-row__flag" aria-label="${esc(t('waste.movedFromBadge', { date: movedOriginal ? dateText(movedOriginal) : '' }))}"></i>`
      : '';
    const coalesced = next.coalesced
      ? `<i data-lucide="layers" class="waste-widget-row__flag" aria-label="${esc(t('waste.coalescedHint'))}"></i>`
      : '';
    const emphasize = next.date_key === earliestDate ? ' waste-widget-row__date--next' : '';

    return `
      <div class="list-row waste-widget-row" data-route="${esc(`/waste${next.deep_link}`)}" role="button" tabindex="0"${fillRowAttr(index, cap)}>
        <span class="list-row__lead" aria-hidden="true"><span class="waste-widget-row__dot" style="--waste-color:${esc(accent)}"></span></span>
        <span class="list-row__main"><span class="list-row__name waste-widget-row__name">${icon}${esc(type.name)}${moved}${coalesced}</span></span>
        <span class="list-row__end waste-widget-row__date${emphasize}">${esc(relativeDateLabel(next.date_key))}</span>
      </div>`;
  }).join('');

  const rest = Math.max(0, sorted.length - Math.min(capped.length, cap));
  const more = rest > 0
    ? `<p class="waste-widget-more"${fillMoreAttrs(fill, rest, 'dashboard.wasteMore')}>${esc(t('dashboard.wasteMore', { count: rest }))}</p>`
    : '';
  // Quelle-braucht-Auffrischung (invariant #6) ist ein Source-, kein
  // Occurrence-Feld - eigener Fetch auf /waste/sources in ensureWasteSlice(),
  // dieselbe Badge-Bedeutung wie auf der Waste-Seite selbst (sourceHealthBadgeInfo).
  const refreshWarning = waste?.needsRefresh
    ? `<div class="waste-widget__refresh-warning">
        <i data-lucide="alert-triangle" aria-hidden="true"></i>
        <span>${esc(t('waste.sourceNeedsRefreshBadge'))}</span>
      </div>`
    : '';

  return `<div class="widget widget--waste"${span}>
    ${widgetHeader('waste', t('nav.waste'), upcomingCount, '/waste')}
    <div class="widget__body widget__body--rows">
      ${widgetRows(rows, { className: 'waste-widget' })}${more}
      ${refreshWarning}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Haushaltshilfe-Widget (Anwesenheit + offene Zahlung)
// --------------------------------------------------------

function renderHousekeepingWidget(hk, currency, size = '1x1') {
  if (!hk?.configured) {
    return `<div class="widget widget--housekeeping"${emptySpanAttrs(size)}>
      ${widgetHeader('housekeeping', t('nav.housekeeping'), null, '/housekeeping')}
      ${widgetEmptyHtml(t('dashboard.housekeepingNone'), emptyRouteAction('/housekeeping', t('common.add')), 'housekeeping')}
    </div>`;
  }

  const unpaid = Number(hk.unpaidAmount) || 0;
  const visits = Number(hk.visitsThisMonth) || 0;
  const present = Boolean(hk.present);

  const statusBlock = present
    ? `<div class="housekeeping-widget__status housekeeping-widget__status--present">
        <span class="housekeeping-widget__dot" aria-hidden="true"></span>
        <div class="housekeeping-widget__lines">
          <div class="housekeeping-widget__state">${t('dashboard.housekeepingPresent')}</div>
          <div class="housekeeping-widget__sub">${hk.workerName ? `${esc(hk.workerName)} · ` : ''}${hk.presentSince ? t('dashboard.housekeepingSince', { time: housekeepingSinceLabel(hk.presentSince) }) : ''}</div>
        </div>
      </div>`
    : `<div class="housekeeping-widget__status">
        <span class="housekeeping-widget__dot housekeeping-widget__dot--idle" aria-hidden="true"></span>
        <div class="housekeeping-widget__lines">
          <div class="housekeeping-widget__state">${hk.lastVisit ? t('dashboard.housekeepingLastVisit', { date: earnedWhenLabel(hk.lastVisit) }) : t('dashboard.housekeepingNoVisits')}</div>
          <div class="housekeeping-widget__sub">${t('dashboard.housekeepingVisitsMonth', { count: visits })}</div>
        </div>
      </div>`;

  const unpaidChip = unpaid > 0
    ? `<div class="housekeeping-widget__unpaid"><i data-lucide="banknote" aria-hidden="true"></i><span>${t('dashboard.housekeepingUnpaid', { amount: formatCurrency(unpaid, currency) })}</span></div>`
    : '';

  const span = tileSpanAttrs(() => ({
    body: TILE_PARTS.statusPad + TILE_PARTS.housekeepingStatus + (unpaid > 0 ? TILE_PARTS.statusChip : 0),
  }), size);
  return `<div class="widget widget--housekeeping"${span}>
    ${widgetHeader('housekeeping', t('nav.housekeeping'), null, '/housekeeping')}
    <div class="widget__body">
      <div class="housekeeping-widget">${statusBlock}${unpaidChip}</div>
    </div>
  </div>`;
}

/**
 * Das Zeichen im Siegel einer Programmzeile - fuer "Heute wichtig" und fuer die
 * Wand, die dieselben Zeilen lesen. Ein Termin zeigt das Icon, das jemand fuer
 * ihn gewaehlt hat (#1829) - auf demselben Weg wie der Kalender
 * (utils/event-icon.js): dieselbe Liste, derselbe Rueckfall. Ohne eigene Wahl
 * und fuer jeden unbekannten Namen bleibt das Zeichen des Moduls, sonst stuende
 * dort ein leeres Siegel. Die Herkunft traegt weiter die Farbe des Siegels.
 * `module-glyph` ist die Marke aus nav-icons.js, an der die Strichstaerke haengt.
 * Sammelzeile und Zustandszeile sprechen fuer kein einzelnes Objekt und fragen
 * hier nicht.
 */
function programRowGlyph(row) {
  return row.kind === 'event' && hasEventIcon(row.eventIcon)
    ? eventIconHtml(row.eventIcon, 'module-glyph')
    : moduleIconHTML(row.icon);
}

/* DAS UEBERLAPPUNGSZEICHEN (Block-2-Brief, utils/seal-pair.js): „Heute
 * wichtig" ist die Mischstelle des Dashboards - hier stehen Aufgabe, Termin,
 * Einkauf und Essen nebeneinander, und das Siegel sagt bereits, aus welchem
 * Raum jede Zeile kommt. Traegt die Zeile ausserdem eine Person, sagt der
 * ueberlappende Avatar, wen sie angeht.
 *
 * Es erscheint NUR dann - nicht am Einkauf, nicht am Essen, und im
 * Solo-Haushalt an keiner Zeile (`whoMark` entscheidet das selbst). Ein
 * Zeichen, das immer da ist, sagt nichts. */
function renderTodayRow(row, extraClass = '') {
  const mark = whoMark(row.who);
  // Trailing-Detail ist die ZEIT, kein Zähler mehr: die Programm-Zeile
  // beantwortet „wann", und dieselbe Badge-Form für drei Bedeutungen
  // (Anzahl/offen/Alter) war ein Critique-Befund (H6).
  // „in 25 Min" spricht im Ton seines Moduls (Entwurf „Heute wichtig"), alles
  // Spaetere sekundaer; die Einkaufszeile hat keine Zeit und zeigt ihren Weg.
  const time = row.timeLabel
    ? `<span class="today-cockpit-card__time${row.overdue ? ' today-cockpit-card__time--overdue' : ''}${row.soon ? ' today-cockpit-card__time--soon' : ''}">${esc(row.timeLabel)}</span>`
    : row.chevron ? '<i data-lucide="chevron-right" class="icon-sm today-cockpit-card__chevron" aria-hidden="true"></i>' : '';
  // Objekt-Anker für die Objekt-Deep-Links (Paket 2): die Zeile weiß bereits,
  // WOVON sie spricht - nur das Ziel bleibt vorerst die Modul-Route.
  const objectAttrs = row.objectId != null
    ? ` data-object-kind="${esc(row.kind)}" data-object-id="${esc(String(row.objectId))}"`
    : '';
  // DAS ELEMENT SAGT, WAS ES TUT (Re-Critique A5). Eine Zeile, die an einen Ort
  // fuehrt, ist ein `<a href>` - dann oeffnen Cmd- und Mittelklick sie in einem
  // neuen Tab, und „Link kopieren" gibt einen Link her, so wie es die
  // Widget-Kopf-Links laengst tun. Die AUFGABEN-Zeile bleibt ein `<button>`:
  // sie navigiert nicht, sie oeffnet das Quick-Action-Modal auf ihrem Objekt.
  // Ein href waere dort ein Versprechen, das der Handler bricht - Cmd-Klick
  // landete in der Aufgabenliste statt bei der Aufgabe.
  //
  // Die Bedingung ist dieselbe, die `wireLinks` liest (Objektart „task" plus
  // Objekt-Id), und sie steht bewusst als eine Zeile hier: laufen Markup und
  // Verdrahtung auseinander, bekommt eine Zeile einen href und trotzdem das
  // Modal.
  const opensModal = row.kind === 'task' && row.objectId != null;
  // Inset-Grouped-Zeile (Apple-Systemapp-Muster): das Markensiegel traegt
  // die Modulzugehoerigkeit (Herkunfts-Regel, Block 2), der Inhalt steht als
  // Titel in Textfarbe, das Modul-Label lebt als ruhiger Untertitel weiter
  // (nie versal, nie ueber dem Titel).
  // DER TITEL ZUERST, DANN DIE PERSON (Re-Critique 2026-09-27, A7 Sam). Das
  // Zeichen steht vor dem Text, und sein Name sprach deshalb als Erstes: „Linda
  // Johnson Einverstaendnis fuer ...". Das Paar ist hier nur Bild; der Name
  // folgt als eigener Text hinter Titel und Modul - dieselbe Auskunft, in der
  // Reihenfolge, in der man eine Zeile liest.
  const whoName = mark && !row.namesInSub ? `<span class="sr-only">, ${esc(row.who?.display_name ?? '')}</span>` : '';
  const inner = `
      <span class="${mark ? 'seal-pair' : ''}"${mark ? ' aria-hidden="true"' : ''}><span class="module-seal today-cockpit-card__icon">${programRowGlyph(row)}</span>${mark}</span>
      <span class="today-cockpit-card__body">
        <strong class="today-cockpit-card__value">${esc(row.title)}</strong>
        <span class="today-cockpit-card__sub">${esc(row.sub)}</span>${whoName}
      </span>
      ${time}
  `;
  const attrs = `class="today-cockpit-card today-cockpit-card--${esc(row.tone)}${extraClass}" data-route="${esc(row.route)}"${objectAttrs}`;
  return opensModal
    ? `<button type="button" ${attrs}>${inner}</button>`
    : `<a href="${esc(row.route)}" ${attrs}>${inner}</a>`;
}

// Zustands-Zeile des Tagesprogramms: „Heute frei" / „Alles für heute erledigt".
// Gleiche Zeilen-Anatomie wie das Programm; mit Ausblick (nächster Termin) ist
// sie ein Link dorthin, ohne bleibt sie ein ruhiges <div> ohne Interaktion.
function renderTodayStateRow({ title, sub, icon, route }) {
  const inner = `
      <span class="module-seal today-cockpit-card__icon">${moduleIconHTML(icon)}</span>
      <span class="today-cockpit-card__body">
        <strong class="today-cockpit-card__value">${esc(title)}</strong>
        ${sub ? `<span class="today-cockpit-card__sub">${esc(sub)}</span>` : ''}
      </span>
  `;
  if (route) {
    return `<a href="${esc(route)}" class="today-cockpit-card today-cockpit-card--state" data-route="${esc(route)}">${inner}</a>`;
  }
  return `<div class="today-cockpit-card today-cockpit-card--state">${inner}</div>`;
}

// Deckel des Tagesprogramms: mehr Zeilen wären keine Orientierung mehr,
// sondern eine zweite Aufgabenliste. Der Überlauf spricht als stille Fußzeile.
const PROGRAM_ROW_CAP = 6;

/* AUF DEM TELEFON SO VIELE ZEILEN, WIE IN DEN ERSTEN SCHIRM PASSEN (R21,
 * Critique 2026-10-21, D5 "Uebersicht als Briefing").
 *
 * Hier stand ein fester Deckel von ZWEI Zeilen (R14, A7 P2-2): sechs Zeilen
 * plus Einkauf schoben damals das erste Widget hinter die Kapsel, und das
 * Widget galt als das, was man sehen muss. Die Critique hat die Rangfolge
 * umgedreht: die Uebersicht ist ein Briefing, das Programm des Tages ist ihr
 * Inhalt, die Kacheln stehen darunter. Gemessen bei 390x844 zeigte das Blatt
 * 2 von 9 Punkten, darunter 370px Familie und Budget im ersten Schirm.
 *
 * Wie viele Zeilen passen, weiss erst das Layout: Gruss und Wetterzeile
 * brechen je nach Sprache und Name um. Der erste Aufbau rechnet deshalb mit
 * dem letzten gemessenen Wert (sonst mit dem Mindestwert), `fitPhoneProgram`
 * misst danach im selben Task - vor dem naechsten Bild - und zeichnet nur das
 * Blatt neu, wenn die Zahl nicht stimmt. Der Rest steht wie bisher hinter
 * "+N weitere" (mit der Einkaufszeile); zuerst bleibt, was offen ist
 * (composeTodaySheet), und die Sammelzeile der Ueberfaelligen ist EINE Zeile.
 * Zwei Zeilen bleiben die Untergrenze, auch auf einem sehr kleinen Schirm. */
const PROGRAM_ROW_CAP_PHONE = 2;

/** Zuletzt gemessene Zeilenzahl je Fensterhoehe (fitPhoneProgram). */
let phoneProgramFit = null;
/** Zuletzt gemessene Hoehe der Ueberschrift „Ausserdem heute" (D6). */
let phoneDividerHeight = null;

function phoneProgramCap() {
  const height = globalThis.window?.innerHeight;
  return phoneProgramFit && phoneProgramFit.height === height ? phoneProgramFit.cap : PROGRAM_ROW_CAP_PHONE;
}

/**
 * Wie viele Programmzeilen in den ersten Schirm passen - rein, ohne DOM.
 * @param {{ fold: number, rowsTop: number, rowHeight: number, trailing: number, total: number }} geometry
 *   fold      Oberkante dessen, was den Schirm unten abdeckt (Kapsel), in Inhaltskoordinaten
 *   rowsTop   Oberkante der ersten Zeile, in denselben Koordinaten
 *   rowHeight Hoehe einer Zeile
 *   trailing  was unter den Zeilen steht, solange es einen Ueberlauf gibt ("+N weitere")
 *   total     Zeilen des ganzen Tages (nach der Sammelzeile)
 *   rest      was unter den Zeilen steht, wenn ALLE stehen (Einkaufszeile, Coda)
 * @returns {number}
 */
/* ALLES PASST NUR, WENN AUCH DER REST PASST (R21 S7, Handoff 5). Die Rechnung
 * verglich nur die Zeilen mit dem Platz: bei 390x844 passten alle acht (Unterkante
 * 744 von 764), und die Einkaufszeile darunter stand bei 744-809 halb hinter der
 * Kapsel. Was ohne Ueberlauf unter den Zeilen bleibt, zaehlt jetzt mit; passt es
 * nicht, faltet die Einkaufszeile mit der letzten Zeile in "+N weitere". */
/* DIE UEBERSCHRIFT ZWISCHEN DEN TEILEN ZAEHLT MIT (D6). Steht nach den `lead`
 * Zeilen der Leiste noch eine des Rests, traegt die Liste „Ausserdem heute"
 * (`divider` hoch) - die Rechnung nimmt sie nur dann mit, wenn der Deckel
 * ueber `lead` hinausreicht. */
function programRowsThatFit({ fold, rowsTop, rowHeight, trailing, total, rest = 0, lead = 0, divider = 0 }) {
  if (!(rowHeight > 0) || !(total > 0)) return PROGRAM_ROW_CAP_PHONE;
  const room = fold - rowsTop;
  const dividerFor = (cap) => (lead > 0 && cap > lead ? divider : 0);
  if (total * rowHeight + dividerFor(total) + rest <= room) return total;
  let fit = Math.floor((room - trailing) / rowHeight);
  if (dividerFor(fit)) fit = Math.max(lead, Math.floor((room - trailing - divider) / rowHeight));
  return Math.max(PROGRAM_ROW_CAP_PHONE, Math.min(total - 1, fit));
}

/**
 * Misst das gezeichnete Blatt auf dem Telefon und meldet die passende
 * Zeilenzahl, wenn sie von der gezeichneten abweicht - sonst `null`.
 * `shrinkOnly`: der zweite Blick nach einem Neuzeichnen meldet nur ein
 * Weniger. Der Rest unter den Zeilen wechselt mit dem Deckel (Einkaufszeile
 * gegen "+N weitere"); ein Mehr an dieser Stelle hiesse Pendeln.
 * @param {Element} shell
 * @param {{ shrinkOnly?: boolean }} [opts]
 * @returns {number|null}
 */
function measurePhoneProgram(shell, { shrinkOnly = false } = {}) {
  const section = shell?.querySelector?.('.today-cockpit[data-program-cap]');
  if (!section || !onPhoneStage()) return null;
  const rows = section.querySelector('.today-cockpit__rows:not(.today-cockpit__rows--more)');
  const first = rows?.querySelector(':scope > .today-cockpit-card');
  if (!rows || !first) return null;
  const scroller = section.closest('.app-content');
  const scrollTop = scroller?.scrollTop ?? 0;
  const capsule = document.querySelector('.nav-bottom__items');
  const capsuleTop = capsule?.getBoundingClientRect().top;
  // Ohne sichtbare Kapsel (Anzeige, Querformat ohne Leiste) ist der Falz die Fensterkante.
  const foldViewport = capsuleTop > 0 ? capsuleTop : window.innerHeight;
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-2')) || 8;
  const rowsRect = rows.getBoundingClientRect();
  const sectionRect = section.getBoundingClientRect();
  const rowHeight = first.getBoundingClientRect().height;
  const trailing = Math.max(0, sectionRect.bottom - rowsRect.bottom);
  const shown = Number(section.dataset.programCap) || 0;
  const total = Number(section.dataset.programTotal) || 0;
  // Was unter den Zeilen bleibt, wenn alle stehen: gezeichnet ohne Ueberlauf
  // ist es gemessen, sonst steckt die Einkaufszeile im Ueberlauf und zaehlt
  // als eine Zeile (gleiche Karte), die Coda mit ihrer Hoehe.
  const coda = section.querySelector('.today-cockpit__coda')?.getBoundingClientRect().height ?? 0;
  // Die Ueberschrift „Ausserdem heute" (D6): gezeichnet ist sie gemessen,
  // sonst gilt der zuletzt gemessene Wert, beim ersten Mal eine halbe Zeile.
  const lead = Number(section.dataset.programLead) || 0;
  const drawnAlso = section.querySelector('.today-cockpit__also--row:not(.today-cockpit__rows--more *)');
  if (drawnAlso) phoneDividerHeight = drawnAlso.getBoundingClientRect().height;
  const divider = lead ? phoneDividerHeight ?? rowHeight / 2 : 0;
  // Bildet die Einkaufszeile den Rest allein, steht die Ueberschrift vor ihr.
  const shoppingDivider = section.dataset.programShopping === '1' && lead >= total ? divider : 0;
  const rest = shown >= total
    ? trailing
    : (section.dataset.programShopping === '1' ? rowHeight + shoppingDivider : 0) + coda;
  const geometry = {
    fold: foldViewport + scrollTop - gap,
    rowsTop: rowsRect.top + scrollTop,
    rowHeight,
    trailing,
    total,
    rest,
    lead,
    divider,
  };
  // Ein leerer Tag hat eine Zustandszeile und nichts zu deckeln.
  if (!geometry.total) return null;
  const height = window.innerHeight;
  const fit = programRowsThatFit(geometry);
  // Musste der zweite Blick zuruecknehmen (mit einer Zeile weniger im Ueberlauf
  // fuehrt "+N weitere" in eine Ansicht, und die Einkaufszeile bleibt stehen),
  // gilt das als Decke fuer diese Fensterhoehe - sonst zeichnete jeder
  // Neuaufbau erst die hoehere Zahl und nahm sie dann zurueck.
  if (shrinkOnly) {
    if (fit >= shown) return null;
    phoneProgramFit = { height, cap: fit, ceiling: fit };
    return fit;
  }
  const ceiling = phoneProgramFit?.height === height ? phoneProgramFit.ceiling ?? Infinity : Infinity;
  const cap = Math.min(fit, ceiling);
  phoneProgramFit = { height, cap, ceiling };
  return cap === shown ? null : cap;
}

/**
 * Die erste Schaetzung der Buehne (todayStage) kannte das Blatt noch nicht:
 * jetzt steht es, und ist es schmaler oder breiter als geschaetzt, zeichnet es
 * sich im selben Task neu - bevor der Browser ein Bild davon malt.
 */
function refitTodayStage(shell, render) {
  const drawn = shell?.querySelector?.('.today-cockpit')?.dataset.todayStage;
  if (drawn && drawn !== todayStage()) replaceProgramSheet(shell, render());
}

/**
 * Ersetzt nur die Zeichen, die noch Platzhalter sind. `createIcons` auf der
 * ganzen Flaeche ersetzte jedes fertige SVG ein zweites Mal - `data-lucide`
 * bleibt am SVG (lucide-scope.js) -, und jeder Ersatz legte die Flaeche neu
 * aus (DW-P2-4).
 */
function createPendingIcons(root) {
  const lucide = globalThis.window?.lucide;
  if (!lucide || !root?.querySelectorAll) return;
  // Frisch gezeichnet (noch kein fertiges Zeichen darin): ein Lauf ueber alles.
  if (!root.querySelector('svg[data-lucide]')) {
    lucide.createIcons({ el: root });
    return;
  }
  for (const node of root.querySelectorAll('[data-lucide]:not(svg)')) lucide.createIcons({ el: node });
}

/* DIE HOEHE JEDER KACHEL AUS DEM LETZTEN BILD (DW-P2-4, PLAN H9). Kacheln
 * ausser Sicht rechnet der Browser erst, wenn sie kommen (`content-visibility`,
 * dashboard.css), und bis dahin steht ihr Platzhalter. `auto` merkt sich die
 * echte Hoehe nur am selben Knoten - jeder Neuaufbau zeichnet neue. Darum
 * merkt sich die Seite die Hoehen selbst (je Fensterbreite und Kachel) und
 * gibt sie dem naechsten Aufbau mit, bevor er zum ersten Mal ausgelegt wird.
 * Gelesen wird nur, was der ResizeObserver nach dem Layout ohnehin meldet. */
const tileBlockSizes = new Map();
// Die Fensterbreite wird gelesen, solange das Layout sauber ist (vor dem
// Zeichnen bzw. im Rueckruf nach dem Layout) - `innerWidth` mitten im Aufbau
// verlangte ein Layout der halbfertigen Flaeche.
const tileSizeKey = (width, id) => `${width}:${id}`;

/**
 * DAS SKELETT SAGT DAS RASTER VORAUS, DAS GEZEICHNET WURDE (DW-P2-5). Gemerkt
 * wurden die sichtbaren Kacheln der Anordnung - auch die, die das Raster gar
 * nicht zeichnet (Modul abgeschaltet oder ohne Recht, Renderer ohne Inhalt).
 * Jede davon stand im Skelett als Kachel und verschob beim Laden alles
 * dahinter. Jetzt lernt der Hinweis aus derselben Liste, die das Raster
 * gezeichnet hat (`drawn` in renderDashboardLayout).
 */
function rememberGridHint(drawn, cfg) {
  rememberLayoutHint(drawn, dashboardQuery(cfg), drawnSpanOf);
}

/** Der Schluessel der Kopfhoehe (headHint): die Fenstergroesse. */
function viewportKey() {
  const win = globalThis.window;
  return win ? `${win.innerWidth}x${win.innerHeight}` : '';
}

/** Merkt die gezeichnete Hoehe des Kopfbands fuer das naechste Skelett. */
function watchHeadSize(shell) {
  const band = shell?.querySelector?.(':scope > .dashboard-masthead');
  if (!band || typeof ResizeObserver !== 'function') return null;
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const px = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height ?? 0;
    if (px > 0 && band.isConnected) rememberHeadHint(viewportKey(), px, Boolean(band.querySelector('.today-cockpit')));
  });
  observer.observe(band);
  return observer;
}

function carryTileSizes(shell, width) {
  for (const el of shell.querySelectorAll('#dashboard-widget-grid > .widget-wrapper[data-widget-id]')) {
    const px = tileBlockSizes.get(tileSizeKey(width, el.dataset.widgetId));
    if (px) el.style.setProperty('--tile-block-size', `${px}px`);
  }
}

function watchTileSizes(grid) {
  if (!grid || typeof ResizeObserver !== 'function') return null;
  const observer = new ResizeObserver((entries) => {
    const width = globalThis.window?.innerWidth ?? 0;
    for (const entry of entries) {
      const id = entry.target.dataset?.widgetId;
      const px = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height ?? 0);
      if (id && px > 0 && entry.target.isConnected) tileBlockSizes.set(tileSizeKey(width, id), px);
    }
  });
  for (const el of grid.querySelectorAll(':scope > .widget-wrapper[data-widget-id]')) observer.observe(el);
  return observer;
}

/** Tauscht das Heute-Blatt gegen eine neu gezeichnete Fassung (gleicher Platz). */
function replaceProgramSheet(shell, html) {
  shell.querySelector('.today-cockpit')?.insertAdjacentHTML('afterend', html);
  shell.querySelector('.today-cockpit')?.remove();
}

/* DAS BLATT PASST SICH DEM SCHIRM AN, NICHT NUR DEM AUFBAU (R21 S7, Handoff 5).
 * `measurePhoneProgram` lief nur beim Neuaufbau: nach einer Drehung oder wenn
 * die Browserleiste die Fensterhoehe aendert, blieb die Zeilenzahl der alten
 * Hoehe stehen - gemessen 390x844 -> 390x664: acht Zeilen, die letzten fuenf
 * hinter der Kapsel. Hier wird bei jeder Groessenaenderung (ein Bild spaeter,
 * gebuendelt) nachgemessen, und nur wenn die Zahl nicht mehr stimmt oder die
 * Buehne zwischen Telefon und breit wechselt, baut die Uebersicht neu. */
function createPhoneProgramFit(win, signal, rebuild) {
  let frame = 0;
  win.addEventListener('resize', () => {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      // Die Buehne, fuer die das Blatt gezeichnet ist, gegen die gemessene:
      // Telefon, schmal oder breit (todayStage).
      const drawn = win.document?.querySelector?.('.today-cockpit')?.dataset?.todayStage;
      /* UND DIE DER KACHELN, OHNE DAS BLATT (Review p11, B6). Das Blatt ist
       * abwaehlbar; ohne es sah das Drehen vom Telefon zur breiten Buehne
       * keinen Wechsel, und die Kacheln blieben ohne Spannen (tileSpanAttrs
       * rechnet am Telefon nichts) - gemessen 390 -> 800px: Notizen 1x2
       * 546px hoch, nach Daten 612, und die Listen kurz wie am Telefon. */
      const tiles = win.document?.querySelector?.('#dashboard-widget-grid')?.dataset?.tileStage;
      const tilesCrossed = Boolean(tiles) && tiles !== (onPhoneStage() ? 'phone' : 'wide');
      rebuild((Boolean(drawn) && drawn !== todayStage()) || tilesCrossed);
    });
  }, { signal, passive: true });
  signal.addEventListener('abort', () => win.cancelAnimationFrame(frame), { once: true });
}

/* AB ZWEI UEBERFAELLIGEN EINE SAMMELZEILE (R14, A7 P2-2). Fuenfmal rotes
 * „Ueberfaellig" untereinander ist am Morgen kein Programm, sondern ein
 * Vorwurf - und es schob alles andere unter den Deckel. Die Sammelzeile sagt
 * die Zahl einmal, zeigt mit gestapelten Avataren, wen es angeht, und klappt
 * die Zeilen an Ort und Stelle auf. Nur auf dem Telefon: breit stehen die
 * Zeilen in zwei Spalten neben dem Rest des Tages und kosten keinen Scroll. */
const OVERDUE_GROUP_MIN = 2;

function groupOverdueRows(rows) {
  // Fremde Aufgaben eines Kindes (`othersOnly`) gehen nicht in die Gruppe, die
  // oben steht - sie bleiben einzeln am Ende des Blatts.
  const overdue = rows.filter((row) => row.kind === 'task' && row.overdue && !row.othersOnly);
  if (overdue.length < OVERDUE_GROUP_MIN) return rows;
  const seen = new Set();
  const people = [];
  for (const row of overdue) {
    // JEDE zugewiesene Person, nicht nur das eine Gesicht der Zeile (#1828):
    // eine Aufgabe fuer zwei geht beide an.
    const assigned = Array.isArray(row.people) && row.people.length ? row.people : [row.who];
    for (const person of assigned) {
      const id = person?.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      // renderAvatarStack liest `color`, die Zeilen tragen `avatar_color`.
      people.push({ ...person, color: person.color ?? person.avatar_color });
    }
  }
  const group = {
    kind: 'overdue',
    objectId: null,
    members: overdue,
    people,
    sortKey: '00:00',
    timeLabel: '',
    overdue: true,
    title: t('dashboard.todayOverdueCount', { count: overdue.length }),
    sub: t('nav.tasks'),
    icon: 'check-square',
    tone: 'task',
    route: '/tasks?due=today',
    who: null,
    priority: 10,
    open: true,
  };
  return [group, ...rows.filter((row) => !overdue.includes(row))];
}

/**
 * DAS TAGESPROGRAMM ALS MODELL, EINMAL FUER ZWEI FLAECHEN.
 *
 * Es gibt zwei Darstellungen desselben Tages: das Cockpit im normalen
 * Dashboard (Arm-Laenge, bedienbar) und die Wand (zwei Meter, reine Anzeige).
 * Was auf beiden STEHT, ist dieselbe Frage - Deckel, Ausblick, Einkaufszeile,
 * Coda. Zwei Renderer, die diese Regeln je eigenstaendig noch einmal
 * formulieren, waeren die zweite Wahrheit, gegen die der Wand-Modus als
 * Zustand statt als Route gebaut ist. Deshalb steht die Antwort hier und die
 * Form dort.
 *
 * @returns {{rows: object[], overflow: number, state: object|null,
 *            shopping: object|null, coda: string|null}}
 */
/** Der Blatt-Kontext - Cockpit, Wand und Kennzahlreihe fragen denselben. */
function todaySheetContextFor(cfg, now, existing = [], { isDisplay = false } = {}) {
  const todayKey = zonedDateKey(now);
  return todaySheetContext({
    todayKey,
    tomorrowKey: addLocalDays(todayKey, 1),
    nowTime: zonedTimeKey(now),
    cfg,
    isModuleDisabled: (module) => Boolean(window.yuvomi?.isModuleDisabled(module)),
    existing,
    isDisplay,
  });
}

/** Die Quellen, die im Heute-Blatt gerade eine Zeile tragen (siehe speakingSourceIds). */
function todaySheetSpeaks(data, cfg, now = new Date()) {
  return speakingSourceIds(data, todaySheetContextFor(cfg, now));
}

/**
 * Spricht eine Domaene im Heute-Blatt? Kein Echo: ist das Modul-Widget einer
 * Domaene sichtbar, entfallen ihre Programm-Zeilen - jede Domaene hat genau
 * eine Repraesentation (Cockpit ODER Widget), statt dieselbe Aufgabe/Termin
 * doppelt zu zeigen. Die Zeitleiste fragt dieselbe Regel, bevor es das Modell
 * gibt.
 */
function todayDomainSpeaks(cfg, module) {
  const widgetShown = Array.isArray(cfg) && cfg.some((w) => w.id === module && w.visible);
  return !window.yuvomi?.isModuleDisabled(module) && !widgetShown;
}

/**
 * DIE WAND RECHNET WIE DAS COCKPIT UNTER DER BREITEN BUEHNE (R24, Uebergabe
 * aus S1 zu Critique G1-Uebersicht-P2-1). Ohne Leiste deckelte die Wand
 * „offen zuerst": dieselben Daten zeigten bei 1440 das Sportfest, bei 1024
 * nicht - offene Aufgaben drueckten es hinter „+N weitere", und Filmabend
 * fehlte in beiden. Jetzt fuehren die Eintraege der Zeitleiste (Termine und
 * Mahlzeiten; Ganztaegiges vorn, dann chronologisch), der Rest folgt - der
 * Deckel kuerzt zuerst den Rest. Dieselben Riegel wie im Cockpit, nur ohne
 * Kachel-Konfiguration. Eine eigene Schicht kennt die Wand nicht: sie fragt
 * die Haushaltsfassung der Daten, ein Wandtablet ist keine Person.
 */
function wallTimelineOptions(data, now = new Date()) {
  if (!todayDomainSpeaks([], 'calendar')) return {};
  return {
    timeline: buildTodayTimeline(data, { now, includeMeals: todayDomainSpeaks([], 'meals'), includeShifts: todayDomainSpeaks([], 'schedule') }),
    timelineRows: true,
  };
}

function buildTodayCockpitModel(data, cfg = [], {
  cap = onPhoneStage() ? phoneProgramCap() : PROGRAM_ROW_CAP,
  now = new Date(),
  groupOverdue = onPhoneStage(),
  isDisplay = false,
  timeline = null,
  // Breit (false) verlassen die Eintraege der Leiste die Liste; darunter
  // (true) SIND ihre kommenden Eintraege die Zeilen (timelineSheetRows).
  timelineRows = false,
  viewer = dashboardViewer,
} = {}) {
  const widgetShown = (id) => Array.isArray(cfg) && cfg.some((w) => w.id === id && w.visible);
  const domainInCockpit = (module) => todayDomainSpeaks(cfg, module);

  const includeTasks = domainInCockpit('tasks');
  const includeCalendar = domainInCockpit('calendar');
  const includeMeals = domainInCockpit('meals');
  const includeShopping = domainInCockpit('shopping');

  const program = buildTodayProgram(data, { includeTasks, includeCalendar, includeMeals, now, viewer });
  // Unter der breiten Buehne kommen Termine, Mahlzeiten und die eigene
  // Schicht aus der Leiste (timelineSheetRows), nicht aus `upcomingEvents`
  // und der einen Mahlzeit des Programms. Ohne Kalender im Blatt gibt es
  // keine Leiste und keinen Tausch.
  const rowsFromTimeline = timelineRows && includeCalendar;
  if (rowsFromTimeline) {
    program.rows = [
      ...program.rows.filter((row) => !TIMELINE_PROGRAM_KINDS.has(row.kind)),
      ...timelineSheetRows(data, timeline, now),
    ];
  }

  // Die uebrigen Quellen des Blatts (Dosen, Freigaben, Abfuhr, Geburtstag,
  // Schicht, Erinnerungen, Haushaltshilfe) sprechen ueber den Beitrags-Vertrag
  // in utils/today-sheet.js - mit denselben drei Riegeln wie oben
  // (Modulschalter, Recht, Kein-Echo) und derselben Zeilenform. Cockpit und
  // Wand fragen beide hier; die Wand reicht nur keine Kachel-Konfiguration mit.
  const sheetContext = todaySheetContextFor(cfg, now, program.rows, { isDisplay });
  const contributed = collectSourceRows(data, sheetContext);
  // DER TERMIN STEHT EINMAL (Ulas, 2026-10-26). Traegt die Zeitleiste einen
  // Termin als Block, verlaesst seine Zeile die Liste: der Block klappt sie
  // unter der Leiste auf (renderTodayTimeline). Ganztaegiges hat keinen Block
  // und bleibt. `existing` oben sieht weiter alle Zeilen - eine Erinnerung an
  // einen Termin der Leiste bleibt so dessen Echo und keine eigene Zeile.
  // Seit der Critique (Befund 3) gilt das fuer alles, was die Leiste traegt:
  // Termin, ganztaegiger Termin, Mahlzeit, die eigene Schicht.
  // Unter der breiten Buehne stehen die Eintraege der Leiste schon in
  // `program.rows`; die Beitraege verlieren nur ihre Doppel (die Schicht).
  const inTimeline = timelineRowKeys(timeline);
  const notInTimeline = (row) => !inTimeline.has(`${row.kind}:${row.objectId}`);
  const listed = inTimeline.size && !rowsFromTimeline ? program.rows.filter(notInTimeline) : program.rows;
  // ZWEI TEILE (D6, composeTodaySheet): unter der breiten Buehne fuehren die
  // Eintraege der Leiste, der Rest steht unter „Ausserdem heute". Der erste
  // Eintrag mit Uhrzeit - was gerade laeuft, sonst das Naechste - bleibt
  // unter jedem Deckel sichtbar, auch wenn Ganztaegiges ihn fuellt.
  const lead = rowsFromTimeline ? listed.filter((row) => row.timelineKey) : null;
  const own = lead ? listed.filter((row) => !row.timelineKey) : listed;
  const programRows = groupOverdue ? groupOverdueRows(own) : own;
  const anchor = (lead ?? []).reduce((best, row) => (/^\d{2}:\d{2}$/.test(String(row.sortKey)) && row.sortKey > '00:02'
    && (!best || row.sortKey < best.sortKey) ? row : best), null);
  const sheet = composeTodaySheet([...programRows, ...(inTimeline.size ? contributed.rows.filter(notInTimeline) : contributed.rows)], { cap, lead, anchor });
  const visibleRows = sheet.rows;
  const overflow = sheet.overflow;

  // Ausblick über heute hinaus: das chronologisch Nächste aus Termin UND
  // fälliger Aufgabe - die Beruhigung darf nicht um Mitternacht enden
  // (Critique P3: „nichts mehr" bei morgen früh fälligem Zettel wäre eine
  // falsche Entwarnung). Jede Quelle spricht nur, wenn ihre Domäne im
  // Cockpit spricht.
  const outlookEvent = includeCalendar ? program.nextUpcoming : null;
  const outlookTask = includeTasks ? program.nextDueTask : null;
  let outlook = null;
  if (outlookEvent || outlookTask) {
    const eventStart = outlookEvent ? eventStartDate(outlookEvent) : null;
    const eventTimed = outlookEvent && !outlookEvent.all_day && eventStart && String(outlookEvent.start_datetime).length > 10;
    // Die Uhrzeit ueber die Anzeigezone, nicht ueber die Browser-Getter des
    // Dates: in `start_datetime` liegen zonenlose Wanduhrzeit und echte Instants
    // in einer Spalte, und fuer die zweite Sorte kippte der Vergleich mit
    // `taskKey` um den Zonenoffset (#851).
    const eventKey = outlookEvent
      ? `${eventOccurrenceDateKey(outlookEvent)}T${eventTimed ? zonedTimeKey(outlookEvent.start_datetime) : '00:00'}`
      : null;
    const taskKey = outlookTask
      ? `${outlookTask.due_date}T${outlookTask.due_time ? String(outlookTask.due_time).slice(0, 5) : '23:59'}`
      : null;
    if (eventKey && (!taskKey || eventKey <= taskKey)) {
      const when = eventTimed
        ? formatDateTime(outlookEvent.start_datetime)
        : relativeDateLabel(eventOccurrenceDateKey(outlookEvent));
      outlook = {
        sub: t('dashboard.todayNextUp', { event: `${when} · ${outlookEvent.title}` }),
        route: calendarEventRoute(outlookEvent),
      };
    } else {
      // Faelligkeit ist zonenlose Wanduhrzeit: Key und Stempel, kein Date.
      const dueDay = String(outlookTask.due_date).slice(0, 10);
      const dueTime = outlookTask.due_time ? String(outlookTask.due_time).slice(0, 5) : null;
      const when = dueTime
        ? `${relativeDateLabel(dueDay)}, ${formatTime(`${dueDay}T${dueTime}`)}`
        : relativeDateLabel(dueDay);
      outlook = {
        sub: t('dashboard.todayNextUp', { event: `${when} · ${outlookTask.title}` }),
        route: '/tasks',
      };
    }
  }

  // Ein leerer Tag spricht, statt zu verschwinden (Critique P2): „Alles
  // erledigt", wenn heute Fälliges bereits geschafft ist, sonst „Heute frei" -
  // mit dem Ausblick als beruhigendem Untertitel. Beides nur, wenn die
  // tragende Domäne überhaupt im Cockpit spricht: neben einem sichtbaren
  // Kalender-Widget wäre „Heute frei" eine fremde Behauptung.
  //
  // S-18 (UX-Audit): dieselbe Regel gilt fuer eine sichtbare Schichtplan-
  // Kachel. "Heute frei"/"Fuer heute alles erledigt" pruefte bisher nur
  // Aufgaben/Kalender - eine Person mit einer echten Schicht heute sah
  // trotzdem eine dieser Behauptungen direkt neben der eigenen Kachel, die
  // etwas anderes zeigte. Beide Zweige (nicht nur "frei") entfallen deshalb,
  // sobald die Kachel selbst fuer Schichtplan spricht - kein neuer Programm-
  // Zeilen-Import noetig, das widerspraeche dem "genau eine Repraesentation
  // je Domaene" oben.
  // isModuleDisabled() zusaetzlich zu widgetShown() (Review zu #1099, wie
  // domainInCockpit() oben): eine abgeschaltete Schedule-Kachel kann in einem
  // stehengebliebenen Layout weiterhin `visible: true` tragen, obwohl sie
  // nichts mehr zeigt - ohne den Modul-Check wuerde das "Heute frei"/"Fuer
  // heute alles erledigt" faelschlich unterdrueckt, obwohl gar keine
  // Schichtplan-Kachel mehr etwas behauptet.
  const scheduleWidgetVisible = !window.yuvomi?.isModuleDisabled('schedule') && widgetShown('schedule');
  let state = null;
  // Steht in der Leiste noch etwas aus, ist der Tag weder frei noch durch.
  const timelineAhead = (timeline?.lanes ?? []).some((lane) => lane.items.some((item) => item.state !== 'past'));
  if (!sheet.allRows.length && !scheduleWidgetVisible && !timelineAhead) {
    // „Alles erledigt" sagt auch eine Quelle, deren Offenes heute geschafft
    // ist (alle Dosen genommen) - sonst hiesse derselbe Tag „Heute frei".
    const sayAllDone = (includeTasks && program.tasksDoneToday > 0) || contributed.settled;
    // EIN NEUER HAUSHALT IST NICHT FREI, SONDERN LEER (R24, Critique G6 P2-2).
    // Nach der Einrichtung stand "Heute frei" ueber einer Uebersicht ohne einen
    // einzigen Eintrag. Solange die Erste-Schritte-Karte laeuft und nichts
    // kommt, sagt die Zeile das: noch nichts geplant, und was hier erscheint.
    const fresh = !sayAllDone && !outlook && firstStepsActive();
    if (sayAllDone || includeCalendar) {
      state = {
        title: sayAllDone ? t('dashboard.todayAllDone') : t(fresh ? 'dashboard.todayNothingPlanned' : 'dashboard.todayFree'),
        sub: fresh ? t('dashboard.todayNothingPlannedSub') : (outlook?.sub ?? ''),
        icon: sayAllDone ? 'check-circle' : fresh ? 'calendar-plus' : 'sparkles',
        route: outlook?.route ?? null,
      };
    }
  }

  // Einkauf bleibt die zeitlose Schlusszeile - nur wenn etwas offen ist.
  const shopping = includeShopping && program.openShoppingCount > 0
    ? {
        kind: 'shopping',
        objectId: null,
        timeLabel: '',
        title: t('dashboard.todayShoppingCount', { count: program.openShoppingCount }),
        sub: t('dashboard.todayShopping'),
        icon: 'shopping-cart',
        tone: 'shopping',
        route: shoppingSoleListRoute(data),
        who: null,
      }
    : null;

  // Abschluss-Zeile (Peak-End): das beruhigende „danach nichts mehr" - aber nur,
  // wenn das Programm wirklich vollständig ist. Neben „+N weitere" wäre sie
  // gelogen, und unter der Zustands-Zeile wäre sie eine Doppelung. Ist MORGEN
  // eine Aufgabe fällig, sagt die Coda es dazu - sonst wäre „nichts mehr" um
  // 21 Uhr eine falsche Entwarnung (Critique P3). Nur morgen, nicht später:
  // eine Frist in drei Tagen ist keine Falle.
  //
  // Seit dem Beitrags-Vertrag ausserdem nur, wenn keine Zeile mehr OFFEN ist
  // (`codaAllowed`): unter einer offenen Dosis, einer wartenden Freigabe oder
  // der Tonne am Morgen ist „nichts mehr" keine Entwarnung, sondern ein
  // Widerspruch zur Zeile darueber.
  // Die Coda schliesst auch eine Leiste ab, deren Termine noch ausstehen und
  // deren Zeilen deshalb nicht in der Liste stehen - sonst fiele unter einem
  // Tag nur aus Terminen die Warnung vor der Morgen-Frist weg (Critique P3).
  let coda = null;
  if (codaAllowed(sheet) || (timelineAhead && !sheet.allRows.length)) {
    const tomorrowKey = sheetContext.tomorrowKey;
    const tomorrowTask = includeTasks && program.nextDueTask?.due_date === tomorrowKey ? program.nextDueTask : null;
    coda = tomorrowTask
      ? t('dashboard.todayNothingElseTomorrow', { title: tomorrowTask.title })
      : t('dashboard.todayNothingElse');
  }

  // `allRows` ist NICHT dasselbe wie `rows`: der Deckel entscheidet, was zu
  // SEHEN ist, nicht, was heute ansteht. „Wer heute dran ist" zaehlt ueber den
  // ganzen Tag - sonst verschwaende jemand aus der Antwort, nur weil seine
  // Zeilen hinter dem Deckel liegen.
  const hidden = sheet.allRows.filter((row) => !visibleRows.includes(row));
  const moreRoute = overflow > 0 ? todayMoreRoute(hidden, sheetContext.todayKey) : null;
  // `lead`: wie viele Zeilen der Leiste es gibt und wie viele davon stehen
  // (D6) - die verdeckten folgen in `hiddenRows` derselben Gliederung.
  const leadPart = lead ? { shown: sheet.leadShown, total: lead.length } : null;
  return { rows: visibleRows, allRows: sheet.allRows, hiddenRows: hidden, overflow, moreRoute, state, shopping, coda, includeCalendar, includeTasks, lead: leadPart };
}

/* „+N WEITERE HEUTE" FUEHRT DORTHIN, WO DIE VERSTECKTEN ZEILEN STEHEN
 * (Re-Critique 2026-09-27, A7 P2-9). Die Fusszeile war ein `<div>`: sie sagte,
 * dass es mehr gibt, und liess keinen Weg dorthin.
 *
 * EIN LINK NUR, WENN DIE ZIELANSICHT ALLE VERDECKTEN ZEILEN ZEIGT (Codex an
 * #1485). Die erste Fassung waehlte bei gemischten Quellen „das Naechstbeste":
 * Aufgabe plus Dosis fuehrte in die Aufgabenliste, Termin plus Abfuhr an den
 * Kalendertag - der Link versprach „+2 weitere" und zeigte eine davon. Jetzt:
 *   - nur Aufgaben: die Aufgabenliste mit `?due=today` (offen und bis heute
 *     faellig, Ueberfaelliges eingeschlossen - genau die Zeilen dieses Blatts),
 *   - Termine und heute faellige Aufgaben: der Kalendertag, der beides zeigt
 *     (eine UEBERFAELLIGE Aufgabe steht dort nicht),
 *   - ein anderes Modul allein, alle Zeilen mit demselben Ziel: dieses Ziel
 *     samt Filter,
 *   - sonst `null`: die Fusszeile wird ein Knopf, der die verdeckten Zeilen an
 *     Ort und Stelle aufklappt (renderTodayCockpit, wireTodayMore).
 * Ein Termin nennt in seiner Zeile genau EIN Vorkommen (`open=`); fuer mehrere
 * ist der Tag das ehrliche Ziel. */
function todayMoreRoute(hiddenRows, todayKey) {
  if (!hiddenRows.length || hiddenRows.some((row) => !row?.route)) return null;
  const routes = hiddenRows.map((row) => String(row.route));
  const base = (route) => route.split('?')[0];
  const bases = new Set(routes.map(base));
  if (bases.size === 1 && bases.has('/tasks')) return '/tasks?due=today';
  const calendarShowsAll = [...bases].every((b) => b === '/calendar' || b === '/tasks')
    && hiddenRows.every((row) => base(String(row.route)) !== '/tasks' || !row.overdue);
  if (calendarShowsAll) return `/calendar?date=${encodeURIComponent(todayKey)}`;
  return new Set(routes).size === 1 ? routes[0] : null;
}

/** Aufgeklappt bleibt aufgeklappt, auch wenn ein Refresh das Blatt neu zeichnet. */
let todayMoreOpen = false;
let todayOverdueOpen = false;

/**
 * Die Sammelzeile der Ueberfaelligen (groupOverdueRows): dieselbe Anatomie wie
 * jede Heute-Zeile - Siegel, Titel, Untertitel, Detail am Ende -, aber ein
 * Aufklapp-Knopf statt eines Wegs. Das Detail am Ende ist, wen es angeht
 * (gestapelte Avatare, im Solo-Haushalt nichts), und ein Chevron, das sich
 * wie beim „+N weitere"-Knopf dreht. Die aufgeklappten Zeilen tragen kein
 * zweites „Ueberfaellig": die Sammelzeile hat es einmal gesagt.
 */
function renderTodayOverdueGroup(row, open) {
  const who = isSoloHousehold() ? [] : (row.people ?? []);
  const people = who.length ? renderAvatarStack(who, { size: 24, maxVisible: 3 }) : '';
  // Die Avatare sind Bild; wen die Zeile angeht, spricht der Name dahinter.
  const names = who.length ? `<span class="sr-only">, ${esc(who.map((p) => p.display_name ?? '').join(', '))}</span>` : '';
  const button = `<button type="button" class="today-cockpit-card today-cockpit-card--${esc(row.tone)} today-cockpit-card--group" data-today-overdue
          aria-expanded="${open ? 'true' : 'false'}" aria-controls="today-cockpit-overdue">
      <span class="module-seal today-cockpit-card__icon">${moduleIconHTML(row.icon)}</span>
      <span class="today-cockpit-card__body">
        <strong class="today-cockpit-card__value">${esc(row.title)}</strong>
        <span class="today-cockpit-card__sub">${esc(row.sub)}</span>${names}
      </span>
      <span class="today-cockpit-card__trail" aria-hidden="true">${people}<i data-lucide="chevron-down" class="icon-sm today-cockpit__more-icon"></i></span>
    </button>`;
  const members = (row.members ?? []).map((member) => renderTodayRow({ ...member, timeLabel: '' })).join('');
  return `${button}<div class="today-cockpit__rows today-cockpit__rows--more today-cockpit__rows--group" id="today-cockpit-overdue"${open ? '' : ' hidden'}>${members}</div>`;
}

/** Die Sammelzeile klappt an Ort und Stelle, wie der „+N weitere"-Knopf. */
function wireTodayOverdue(root) {
  root.querySelectorAll('[data-today-overdue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      const region = root.querySelector(`#${btn.getAttribute('aria-controls')}`);
      toggleRegion(region, open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      todayOverdueOpen = open;
    });
  });
}

/**
 * Der Aufklapp-Knopf des Ueberlaufs: schaltet die verdeckten Zeilen an Ort und
 * Stelle, ohne das Blatt neu zu zeichnen - so bleibt der Fokus auf dem Knopf,
 * und ein zweiter Tipp klappt wieder zu.
 *
 * Unter der breiten Buehne steuert auch das Bild ueber den Zeilen dieselbe
 * Region (renderTodayPeek, `data-today-peek`): beide Knoepfe sagen
 * denselben Zustand, und nur der Tipp aufs Bild fuehrt danach zur ersten
 * kommenden Zeile. `+N weitere` behaelt den Fokus: das Aufgeklappte steht
 * direkt ueber ihm, das Bild dagegen liegt ueber allen Zeilen.
 */
function wireTodayMore(root) {
  const toggles = [...root.querySelectorAll('[data-today-more]')];
  toggles.forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      const controls = btn.getAttribute('aria-controls');
      const region = root.querySelector(`#${controls}`);
      toggleRegion(region, open);
      for (const toggle of toggles) {
        if (toggle !== btn && toggle.getAttribute('aria-controls') !== controls) continue;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        const label = toggle.dataset.lessLabel ? toggle.querySelector('span') : null;
        if (label) label.textContent = open ? toggle.dataset.lessLabel : toggle.dataset.moreLabel;
      }
      todayMoreOpen = open;
      if (open && btn.dataset.todayPeek != null) revealTodayPeekTarget(region, btn.dataset.peekTarget);
    });
  });
}

/** Minute des Tages (0-1439) aus einem Wert, gelesen in der Wanduhr des Haushalts. */
function householdMinuteOf(value) {
  const [hour, minute] = String(zonedTimeKey(value) || '').split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

/** Minute des Tages aus einer Wanduhrzeit 'HH:MM' (Schicht, Nennzeit einer Mahlzeit). */
function clockMinute(time) {
  const match = /^(\d{2}):(\d{2})/.exec(String(time ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Wann etwas dran ist, relativ zu jetzt (Critique 2026-10-26, Befund 5):
 * unter einer Stunde „in 25 Min" - im Ton des Moduls -, spaeter mit der Uhrzeit
 * davor („15:00 · in 2 Std."), denn eine gerundete Stunde allein verlangt
 * Kopfrechnen. Ueber Intl.RelativeTimeFormat, damit jede Sprache ihre Kurzform
 * hat. `null`, wenn es schon begonnen hat.
 */
function relativeWhen(minuteOfDay, now, clock = '') {
  const nowMinute = householdMinuteOf(now);
  if (nowMinute == null || minuteOfDay == null || minuteOfDay <= nowMinute) return null;
  const delta = minuteOfDay - nowMinute;
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'short' });
  if (delta < 60) return { label: format.format(delta, 'minute'), soon: true };
  const relative = format.format(Math.round(delta / 60), 'hour');
  return { label: clock ? `${clock} · ${relative}` : relative, soon: false };
}

/**
 * DIE TERMINE VON HEUTE, EINMAL (Entwurf „Heute wichtig", 2026-10-26).
 *
 * Aus BEIDEN Terminlisten der Antwort: `upcomingEvents` haelt die Kachel-
 * Liste samt ihrem Deckel von fuenf Kommenden, `familyEvents` je Mitglied die
 * heute beendeten und die naechsten (#1449). Erst zusammen tragen sie einen
 * vollen Tag. Doppelte fallen ueber denselben Schluessel wie serverseitig
 * (`id@start`). Beendete bleiben hier stehen: die Leiste zeigt den Tag, die
 * Liste darunter nur, was noch kommt.
 *
 * @returns {{ timed: object[], allDay: object[] }}  `timed` fuer die Achse
 *   (Minuten in der Haushaltszone), `allDay` fuer das Band ueber ihr
 */
function todayEventsForTimeline(data, now = new Date()) {
  const todayKey = zonedDateKey(now);
  const memberIds = (Array.isArray(data?.users) ? data.users : []).map((user) => user.id);
  const seen = new Set();
  const timed = [];
  const allDay = [];
  for (const key of ['upcomingEvents', 'familyEvents']) {
    for (const event of Array.isArray(data?.[key]) ? data[key] : []) {
      const id = `${event.id}@${event.start_datetime}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const span = overviewEventSpan(event, todayKey);
      if (span.day !== todayKey) continue;
      const peopleIds = (event.assigned_users ?? []).map((user) => user.id);
      const base = {
        id: event.id,
        peopleIds,
        title: event.title,
        kind: 'event',
        tone: 'calendar',
        key: id,
        sheetRow: timelineEventRow(event, span, memberIds),
      };
      if (span.allDay) {
        allDay.push(base);
        continue;
      }
      const start = span.carried ? 0 : householdMinuteOf(event.start_datetime);
      if (start == null) continue;
      const endRaw = String(event.end_datetime || '');
      const endsToday = endRaw.length > 10 && zonedDateKey(endRaw) <= todayKey;
      // Was ueber Mitternacht reicht, endet auf der Achse am Tagesende.
      const end = endRaw.length > 10 ? (endsToday ? householdMinuteOf(endRaw) : 24 * 60) : start;
      const timeLabel = overviewEventTime(event, span);
      const endLabel = endsToday && end > start ? formatTime(endRaw) : '';
      timed.push({
        ...base,
        start,
        end: end ?? start,
        // Sichtbar der Beginn allein, wie in der Terminzeile (#1698); das Ende
        // traegt die Breite des Blocks und der zugaengliche Name (Befund 4).
        timeLabel,
        endLabel,
        // Die aufgeklappte Zeile nennt Beginn UND Ende (timelineDetailRow) -
        // ausser beim Uebertrag von gestern, der schon „bis 10:00" sagt.
        rangeLabel: endLabel && !span.carried ? `${timeLabel} - ${endLabel}` : '',
      });
    }
  }
  return { timed, allDay };
}

/**
 * Die Zeile, die ein Block unter der Leiste aufklappt: dieselbe wie in der
 * Liste, mit der Zuweisung. Das Siegel-Paar zeigt EIN Gesicht (whoMark); geht
 * der Termin mehrere an, nennt die Unterzeile alle (#1828) - im Solo-Haushalt
 * niemanden. Gehoert er dem ganzen Haushalt (alle Mitglieder zugewiesen),
 * steht kein einzelnes Gesicht am Siegel, sondern „Alle" in der Unterzeile:
 * er steht in der Spur „Alle", und Alex' Avatar daran sagte etwas anderes
 * (Critique 2026-10-26).
 */
function timelineEventRow(event, span, memberIds = []) {
  const row = todayEventRow(event, span);
  const people = isSoloHousehold() ? [] : (event.assigned_users ?? []);
  const everyone = memberIds.length >= 2 && memberIds.every((id) => people.some((person) => person.id === id));
  if (everyone) {
    row.who = null;
    row.sub = `${row.sub} · ${t('dashboard.todayTimelineEveryone')}`;
  } else if (people.length > 1) {
    // Bei geteiltem Nachnamen die Vornamen (R19), wie in den Spuren.
    const surname = sharedSurname(people);
    const given = (name) => (surname && name.endsWith(` ${surname}`) ? name.slice(0, -(surname.length + 1)) : name);
    row.sub = `${row.sub} · ${people.map((person) => given(String(person.display_name ?? ''))).join(', ')}`;
    // Die Unterzeile nennt schon alle - der Name hinter dem Avatar entfaellt,
    // sonst hoerte der Screenreader die erste Person zweimal.
    row.namesInSub = true;
  }
  return row;
}

/**
 * DIE MAHLZEITEN ALS PUNKT, NICHT ALS BLOCK (Critique 2026-10-26, Befund 3,
 * Ulas: „nur Echtes"). Ihr Platz ist die Nennzeit des Typs (MEAL_SORT_TIME),
 * nach der das Blatt sie ohnehin sortiert - eine Uhrzeit, die niemand
 * eingetragen hat. Eine erfundene Stunde Dauer und ein „laeuft gerade"
 * behaupteten mehr; der Punkt sagt nur „um diese Zeit, ungefaehr". Er klappt
 * die Zeile der Mahlzeit auf; in der Liste steht sie dann nicht noch einmal.
 */
function todayMealsForTimeline(data) {
  const labels = MEAL_LABELS();
  return (Array.isArray(data?.todayMeals) ? data.todayMeals : [])
    .filter((meal) => MEAL_SORT_TIME[meal?.meal_type])
    .map((meal) => {
      const time = MEAL_SORT_TIME[meal.meal_type];
      const start = clockMinute(time);
      const label = labels[meal.meal_type] ?? t('dashboard.todayDinner');
      return {
        id: meal.id,
        start,
        end: start,
        point: true,
        peopleIds: [],
        title: label,
        timeLabel: formatTime(time),
        endLabel: '',
        kind: 'meal',
        tone: 'meals',
        key: `meal-${meal.id}`,
        sheetRow: {
          kind: 'meal',
          objectId: meal.id ?? null,
          sortKey: time,
          timeLabel: '',
          title: meal.title,
          sub: `${label} · ${formatTime(time)}`,
          icon: MEAL_ICONS[meal.meal_type] ?? 'utensils',
          tone: 'dinner',
          route: meal.id != null ? `/meals?open=${encodeURIComponent(String(meal.id))}` : '/meals',
          who: mealCookPerson(meal, data?.users),
          // Dieselbe Stelle im Deckel wie die Mahlzeit des Programms
          // (buildTodayProgram): eine Auskunft, die zuletzt weicht.
          priority: 80,
          open: false,
        },
      };
    });
}

/**
 * DIE EIGENE SCHICHT IN DER EIGENEN SPUR (Critique 2026-10-26, Befund 3). Die
 * Schicht hat Beginn und Ende - echte Zeit, die bisher unter „+N weitere"
 * steckte. Die Antwort traegt nur die EIGENE (`myShiftsToday`); die der
 * anderen zeigt die Schichtplan-Kachel. Ohne Uhrzeit hat sie keinen Platz.
 */
function todayShiftsForTimeline(data, viewer) {
  if (viewer?.id == null) return [];
  return (Array.isArray(data?.myShiftsToday) ? data.myShiftsToday : []).flatMap((entry) => {
    const type = entry.shift_type ?? {};
    const start = clockMinute(type.start_time);
    const endClock = clockMinute(type.end_time);
    if (start == null || endClock == null) return [];
    const end = entry.crosses_midnight || endClock <= start ? 24 * 60 : endClock;
    const startTime = String(type.start_time).slice(0, 5);
    const endTime = String(type.end_time).slice(0, 5);
    return [{
      id: type.id,
      start,
      end,
      peopleIds: [viewer.id],
      title: shiftTypeLabel(type),
      timeLabel: formatTime(startTime),
      endLabel: end < 24 * 60 ? formatTime(endTime) : '',
      kind: 'shift',
      tone: 'schedule',
      key: `shift-${type.id}`,
      sheetRow: {
        kind: 'shift',
        objectId: type.id ?? null,
        sortKey: startTime,
        timeLabel: `${formatTime(startTime)} - ${formatTime(endTime)}`,
        title: shiftTypeLabel(type),
        sub: t('nav.schedule'),
        icon: MODULE_ICON.schedule,
        tone: 'schedule',
        route: '/schedule',
        who: viewer,
        // Wie die Schicht des Beitrags-Vertrags (utils/today-sheet.js): ein
        // Rahmen des Tages, kein Auftrag.
        priority: 50,
        open: false,
      },
    }];
  });
}

/**
 * Die Leiste als Modell - null, wenn heute nichts eine Uhrzeit hat. Traegt
 * dazu das Band der ganztaegigen Termine (`allDay`) und den Schluessel des
 * naechsten kommenden Eintrags (`nextKey`, Befund 2: „Als Naechstes" spricht
 * in der Leiste, nicht als zweite Zeile daneben).
 */
function buildTodayTimeline(data, { now = new Date(), includeMeals = false, includeShifts = false, viewer = dashboardViewer } = {}) {
  const { timed, allDay } = todayEventsForTimeline(data, now);
  if (includeMeals) timed.push(...todayMealsForTimeline(data));
  if (includeShifts) timed.push(...todayShiftsForTimeline(data, viewer));
  const members = (Array.isArray(data?.users) ? data.users : []).map((user) => ({
    ...user,
    // renderAvatarStack liest `color`, die Mitgliederliste traegt `avatar_color`.
    color: user.color ?? user.avatar_color,
  }));
  const layout = layoutTodayTimeline(timed, {
    nowMinute: householdMinuteOf(now),
    members,
    solo: isSoloHousehold(),
  });
  if (!layout) return null;
  const upcoming = layout.lanes.flatMap((lane) => lane.items).filter((item) => item.state === 'next');
  const next = upcoming.reduce((best, item) => (!best || item.start < best.start ? item : best), null);
  return { ...layout, allDay, members, nextKey: next?.key ?? null };
}

/** Alles, was die Leiste traegt, als `art:id` - diese Zeilen verlassen die Liste. */
function timelineRowKeys(timeline) {
  if (!timeline) return new Set();
  const items = [...timeline.lanes.flatMap((lane) => lane.items), ...(timeline.allDay ?? [])];
  return new Set(items.map((item) => `${item.kind}:${item.id}`));
}

/* Die Arten, die das Programm selbst baut und die die Leiste ebenfalls traegt. */
const TIMELINE_PROGRAM_KINDS = new Set(['event', 'meal']);

/**
 * DAS BILD UND DER TEXT ERZAEHLEN DENSELBEN TAG (Critique 2026-10-26, Lauf 2,
 * D1). Unter der breiten Buehne ist die Leiste eine stumme Kurzfassung, und
 * ihre Zeilen kamen aus `upcomingEvents` (Server-Deckel fuenf) plus EINER
 * Mahlzeit: der Filmabend um 20:00 stand im Bild und nie als Text, das
 * vergangene Mittagessen und die beendete Fruehschicht standen als Text, aber
 * nicht mehr im Bild. Jetzt kommen die Zeilen aus demselben Modell wie die
 * Balken: was dort nicht vorbei ist (`state !== 'past'`, eine Mahlzeit ist es,
 * sobald ihre Zeit da war), ueber die Zeile, die auch der Block aufklappt.
 * Ein Termin fuer zwei steht in zwei Spuren und EINMAL als Zeile. Das
 * Ganztaegige bleibt Zeile - es hat keinen Balken, aber dieselbe Quelle.
 */
function timelineSheetRows(data, timeline, now = new Date()) {
  const rows = [];
  const seen = new Set();
  const allDay = timeline?.allDay ?? todayEventsForTimeline(data, now).allDay;
  for (const item of allDay) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    rows.push({ ...item.sheetRow, timelineKey: item.key });
  }
  for (const item of (timeline?.lanes ?? []).flatMap((lane) => lane.items)) {
    if (item.state === 'past' || seen.has(item.key)) continue;
    seen.add(item.key);
    const row = item.kind === 'meal' ? timelineMealRow(item) : { ...item.sheetRow };
    rows.push({ ...(item.state === 'now' ? runningRow(row) : row), timelineKey: item.key });
  }
  return rows;
}

/* WAS LAEUFT, SAGT ES (Critique 2026-10-26, Lauf 2, D6). Ein laufender Termin
 * stand mit seinem Beginn da („16:00") - um 16:30 eine Uhrzeit von gestern,
 * neben „in 25 Min" darunter. Jetzt steht dort „laeuft gerade" im Ton des
 * Moduls; Beginn und Ende nennt der Block und die Zeile dahinter. Der
 * Uebertrag von gestern behaelt sein „bis 10:00" (kein Beginn heute), die
 * Schicht ihre Spanne. */
function runningRow(row) {
  if (row.kind !== 'event' || !/^\d{2}:\d{2}$/.test(String(row.sortKey)) || row.sortKey <= '00:02') return row;
  return { ...row, timeLabel: t('dashboard.todayTimelineRunning'), soon: true };
}

/**
 * DER KOPF ZAEHLT, WAS NOCH KOMMT - AUF JEDER BUEHNE (Ulas, 2026-10-26, D5).
 * Breit zaehlte er den ganzen Tag samt Vergangenem („11 Termine"), darunter
 * nur die kommenden Zeilen („6 Termine"): dieselbe Familie, derselbe Moment,
 * zwei Zahlen. Jetzt zaehlt jede Buehne aus derselben Quelle wie die Zeilen
 * unter der Kurzfassung (timelineSheetRows) - laufende, kommende und
 * ganztaegige Termine, einmal je Termin - und sagt es: „noch 6 Termine". Ist
 * keiner mehr uebrig, entfaellt der Teil. Der Minutentakt baut neu, sobald ein
 * Termin endet (todayFingerprint, `ended`).
 */
function todayEventsAhead(data, timeline, now = new Date()) {
  return timelineSheetRows(data, timeline, now).filter((row) => row.kind === 'event').length;
}

/* Die Mahlzeit nennt ihre Zeit rechts (withRelativeWhen); die Unterzeile
 * traegt nur ihre Art, wie die Mahlzeit des Programms. */
const timelineMealRow = (item) => ({ ...item.sheetRow, sub: item.title, timeLabel: item.timeLabel });

/**
 * DIE AUFGEKLAPPTE ZEILE NENNT DIE SPANNE (Critique 2026-10-26, Lauf 2). Der
 * Block zeigt seine Dauer nur als Breite, die Zeile darunter jetzt in Worten:
 * „15:00 - 16:00" und den vollen Titel, den ein schmaler Block abschneidet.
 * Die Liste bleibt beim Beginn allein (#1698); ein Punkt (Mahlzeit) hat keine
 * Dauer und nennt seinen Beginn, die Schicht traegt ihre Spanne schon.
 */
function timelineDetailRow(item) {
  if (item.kind === 'meal') return timelineMealRow(item);
  return item.rangeLabel ? { ...item.sheetRow, timeLabel: item.rangeLabel } : item.sheetRow;
}

/* DIE SUMME IM KOPF: der Tag in einem Satz, bevor man eine Zeile liest
 * („noch 6 Termine · 1 Aufgabe ueberfaellig"). Nur, was das Blatt selbst
 * spricht: Termine, wenn der Kalender im Blatt spricht (Kein-Echo-Regel),
 * Ueberfaelliges, wenn die Aufgaben es tun. Ohne beides steht keine Summe da -
 * „0 Termine" waere ein Satz ueber nichts. */
function todaySummary(data, model, timeline = null, now = new Date()) {
  const parts = [];
  const events = model.includeCalendar ? todayEventsAhead(data, timeline, now) : 0;
  if (events > 0) parts.push(t('dashboard.todaySummaryEventsAhead', { count: events }));
  if (model.includeTasks) {
    const overdue = model.allRows
      .flatMap((row) => (row.kind === 'overdue' ? row.members ?? [] : [row]))
      .filter((row) => row.kind === 'task' && row.overdue).length;
    if (overdue > 0) parts.push(t('dashboard.todaySummaryOverdue', { count: overdue }));
  }
  return parts.join(' · ');
}

/** Der Ton eines Eintrags der Leiste: das Modul, aus dem er kommt. */
const TIMELINE_TONES = { calendar: 'calendar', meals: 'meals', schedule: 'schedule' };
const timelineTone = (item) => `var(--module-${TIMELINE_TONES[item.tone] ?? 'calendar'})`;

/**
 * DIE ZEITLEISTE DES TAGES (Entwurf „Heute wichtig", 2026-10-26; Modell in
 * utils/today-timeline.js). Eine Spur fuer den Haushalt, eine je Person mit
 * etwas Gezeitetem heute; Vergangenes tritt zurueck, ein Strich sagt „jetzt",
 * das Ganztaegige steht als Band ueber der Achse.
 *
 * NUR AUF DER BREITEN BUEHNE (ab 900px Containerbreite, todayStage). Darunter
 * - Telefon, Tablet hochkant, schmale Spalte - steht die Kurzfassung, und die
 * Termine bleiben Zeilen: eine Stunde waere dort schmaler als ihr Titel
 * (Critique 2026-10-26, Befund 1).
 *
 * DER BLOCK KLAPPT SEINEN EINTRAG AUF (Ulas, 2026-10-26): seine Zeile -
 * Siegel, Zuweisung, Kalender - steht unter der Leiste, ein zweiter Klick
 * klappt sie zu, Esc auch. Die Zeile oeffnet das Objekt wie jede Zeile des
 * Blatts. Die Leiste ist EIN Tab-Stopp (roving tabindex), Pfeiltasten wandern
 * zwischen den Bloecken, Tab fuehrt weiter zur aufgeklappten Zeile (Befund 4).
 * Der zugaengliche Name eines Blocks nennt Person, Titel, Beginn und Ende und
 * den Zustand: „Emma: Schule, 08:00 bis 13:00, laeuft gerade".
 */
function renderTodayTimeline(timeline, now = new Date(), openKey = null) {
  if (!timeline) return '';
  const nowMinute = householdMinuteOf(now);
  // Stunden, Gitter, Bloecke, Strich und Fahne stehen auf DERSELBEN gewichteten
  // Achse (timelineScale, D7); im gestauchten Teil spricht nur jede k-te Stunde.
  const hours = timeline.marks.map((mark) => {
    const classes = ['today-timeline__hour'];
    if (mark.odd) classes.push('today-timeline__hour--odd');
    if (mark.sparse) classes.push('today-timeline__hour--sparse');
    if (timeline.now != null && timelineHourCovered(timeline.scale, mark.minute, nowMinute)) classes.push('today-timeline__hour--covered');
    return `<span class="${classes.join(' ')}" data-minute="${mark.minute}" style="--tl-at:${mark.at}">${esc(axisHourLabel(mark.minute))}</span>`;
  }).join('');
  const grid = `<div class="today-timeline__grid" aria-hidden="true">${timeline.marks.map((mark) => `<span style="--tl-at:${mark.at}"></span>`).join('')}</div>`;
  const stateLabel = { past: t('dashboard.todayTimelinePast'), now: t('dashboard.todayTimelineRunning') };
  const solo = timeline.lanes.length === 1 && timeline.lanes[0].key === 'all' && isSoloHousehold();
  // Der geteilte Nachname steht nicht in jeder Spur (R19): „Johnson" viermal
  // unterscheidet niemanden. Der volle Name bleibt der zugaengliche Name.
  const surname = sharedSurname(timeline.lanes.map((lane) => lane.member).filter(Boolean));
  const shortName = (full) => (surname && full.endsWith(` ${surname}`) ? full.slice(0, -(surname.length + 1)) : full);
  const everyone = t('dashboard.todayTimelineEveryone');
  // EIN Tab-Stopp: der aufgeklappte Eintrag, sonst der naechste, sonst der erste.
  const allKeys = [...(timeline.allDay ?? []).map((item) => item.key), ...timeline.lanes.flatMap((lane) => lane.items.map((item) => item.key))];
  const focusKey = [openKey, timeline.nextKey, allKeys[0]].find((key) => key && allKeys.includes(key));
  let focusTaken = false;
  const tabindex = (key) => {
    if (focusTaken || key !== focusKey) return ' tabindex="-1"';
    focusTaken = true;
    return '';
  };
  const button = (item, laneName, { allDay = false } = {}) => {
    const next = item.key === timeline.nextKey;
    const when = next ? relativeWhen(item.start, now, item.timeLabel) : null;
    // EINE QUELLE FUER „WANN" (Critique 2026-10-26, Lauf 2, D2): das Naechste
    // nennt seine Zeit in der Fahne ueber der Achse, nicht im Block - auch wo
    // der Block breit genug waere. Zweimal „15:00 · in 2 Std." uebereinander
    // waere dieselbe Auskunft doppelt, und nur die Fahne fuehrt der
    // Minutentakt nach (updateTodayTimelineNow). Der Block traegt den Titel;
    // der zugaengliche Name behaelt die Zeit (data-timeline-when, ebenfalls
    // nachgefuehrt).
    const visibleTime = allDay || when ? '' : item.timeLabel;
    // Nach „in 2 Std." setzt ein Komma ab, sonst laese es sich „in 2 Std. bis 16:00".
    const until = item.endLabel ? `${next && when ? ',' : ''} ${t('dashboard.todayUntil', { time: item.endLabel })}` : '';
    const state = next ? t('dashboard.todayTimelineNext') : stateLabel[item.state] ?? '';
    const classes = ['today-timeline__event', `today-timeline__event--${item.state ?? 'next'}`];
    if (next) classes.push('today-timeline__event--upnext');
    if (item.point) classes.push('today-timeline__event--point');
    // DER VOLLE TITEL ALS TOOLTIP (D7): wo der Block ihn kuerzt, zeigt ihn der
    // Zeiger samt Beginn - nur der Beginn, wie ueberall im Blatt (#1698); die
    // Spanne nennt die aufgeklappte Zeile. Der zugaengliche Name bleibt der
    // Inhalt des Knopfs.
    const clock = allDay ? '' : item.timeLabel || '';
    const tooltip = clock ? `${item.title} · ${clock}` : item.title;
    return `<button type="button" class="${classes.join(' ')}" data-timeline-event="${esc(item.key)}"${tabindex(item.key)}
                    aria-expanded="${item.key === openKey ? 'true' : 'false'}" aria-controls="today-timeline-detail" title="${esc(tooltip)}">
              <span class="sr-only">${esc(laneName)}: </span><span class="today-timeline__title">${esc(item.title)}</span>${
      visibleTime ? `<span class="today-timeline__time"><span class="sr-only">, </span>${esc(visibleTime)}</span>` : ''}${
      when ? `<span class="sr-only" data-timeline-when>, ${esc(spokenWhen(when, item.timeLabel))}</span>` : ''}${
      until ? `<span class="sr-only">${esc(until)}</span>` : ''}${state ? `<span class="sr-only">, ${esc(state)}</span>` : ''}
            </button>`;
  };
  const band = (timeline.allDay ?? []).length ? `
      <div class="today-timeline__allday">
        <span class="today-timeline__allday-label">${esc(t('dashboard.allDay'))}</span>
        <ul class="today-timeline__allday-list" aria-label="${esc(t('dashboard.allDay'))}">${
      timeline.allDay.map((item) => `<li style="--c:${timelineTone(item)}">${button({ ...item, state: 'next' }, laneNameFor(item, timeline, everyone), { allDay: true })}</li>`).join('')
    }</ul>
      </div>` : '';
  const lanes = timeline.lanes.map((lane) => {
    const name = lane.member ? lane.member.display_name ?? '' : everyone;
    const face = lane.member
      ? renderAvatarStack([lane.member], { size: 28, maxVisible: 1 })
      : `<span class="today-timeline__everyone" aria-hidden="true"><i data-lucide="users" class="icon-sm"></i></span>`;
    const label = solo ? '' : `<span class="today-timeline__who" aria-hidden="true">${face}<span class="today-timeline__name">${esc(shortName(name))}</span></span>`;
    const items = lane.items.map((item) => `
          <li class="today-timeline__slot${item.point ? ' today-timeline__slot--point' : ''}" data-timeline-at="${item.start}" style="--tl-left:${item.left};--tl-width:${item.width};--tl-row:${item.row};--c:${timelineTone(item)}">
            ${button(item, shortName(name))}
          </li>`).join('');
    return `
        <div class="today-timeline__lane" style="--tl-rows:${lane.rows}">
          ${label}
          <ul class="today-timeline__track" aria-label="${esc(name)}">${items}</ul>
        </div>`;
  }).join('');
  const nowMarker = timeline.now == null ? '' : `
      <div class="today-timeline__past" aria-hidden="true"></div>
      <div class="today-timeline__now" aria-hidden="true"><span class="today-timeline__now-time">${esc(formatTime(now))}</span></div>`;
  // Je Eintrag EINE Zeile, auch wenn er in zwei Spuren steht.
  const details = new Map();
  for (const item of [...(timeline.allDay ?? []), ...timeline.lanes.flatMap((lane) => lane.items)]) {
    if (!details.has(item.key)) details.set(item.key, timelineDetailRow(item));
  }
  const open = details.has(openKey) ? openKey : null;
  const detail = `
    <div class="today-timeline__detail" id="today-timeline-detail"${open ? '' : ' hidden'}>${
      [...details].map(([key, row]) => `<div class="today-timeline__detail-row" data-timeline-detail="${esc(key)}"${key === open ? '' : ' hidden'}>${renderTodayRow(row)}</div>`).join('')
    }</div>`;
  return `${band}
    <div class="today-timeline${solo ? ' today-timeline--solo' : ''}" role="group" aria-label="${esc(t('dashboard.todayTimelineLabel'))}"
         data-timeline-start="${timeline.start}" data-timeline-end="${timeline.end}"${timeline.knee == null ? '' : ` data-timeline-knee="${timeline.knee}"`}${timeline.now == null ? '' : ` style="--tl-now:${timeline.now}"`}>
      <div class="today-timeline__axis" aria-hidden="true">${hours}${renderTimelineFlag(timeline, now)}</div>
      ${grid}
      ${lanes}
      ${nowMarker}
    </div>${detail}`;
}

/** Wessen ein ganztaegiger Termin ist - fuer den zugaenglichen Namen seines Bands. */
function laneNameFor(item, timeline, everyone) {
  const people = (timeline.members ?? []).filter((member) => item.peopleIds.includes(member.id));
  if (!people.length || people.length === (timeline.members ?? []).length) return everyone;
  return people.map((person) => person.display_name ?? '').join(', ');
}

/**
 * Die Stunde an der Achse, kurz wie im Entwurf: „07" statt „07:00", im
 * 12-Stunden-Format „7 AM" (hourGutterLabel). Die Schreibweise der Locale
 * bleibt (Punkt in `id`, persische Ziffern in `fa`) - gekuerzt wird nur ein
 * „:00"/„.00" am Ende.
 */
function axisHourLabel(minute) {
  const full = hourGutterLabel(minute / 60);
  return full.replace(/^(\S+?)[:.]\D?[0０۰٠]{2}$/u, '$1');
}

/** Was der zugaengliche Name des Naechsten sagt: „in 25 Min, 15:00" - unter einer Stunde mit der Uhrzeit dahinter. */
const spokenWhen = (when, clock) => (when.soon && clock ? `${when.label}, ${clock}` : when.label);

/**
 * DAS NAECHSTE SPRICHT, AUCH WENN SEIN BLOCK SCHMAL IST (Critique 2026-10-26,
 * Lauf 2, D2). Bei 1440 war eine Stunde 59px breit - unter der Schwelle des
 * Blocks (5rem) faellt seine Uhrzeit weg, und ausgerechnet beim Naechsten
 * fehlte „15:00 · in 1 Std.". Die Fahne steht in der Achse ueber dem
 * Blockanfang, geformt wie die Jetzt-Pille, aber im Ton des Moduls (--c):
 * die Pille sagt „jetzt", die Fahne „das kommt". Sie ist Bild (aria-hidden),
 * den Satz traegt der Block selbst („..., als Naechstes").
 *
 * Wo sie genau steht, entscheidet das Stylesheet (`.today-timeline__flag`):
 * am Blockanfang, aber nie unter der Jetzt-Pille - die hat Vorrang und die
 * Fahne weicht nach hinten aus - und nie ueber das Achsenende hinaus. Die
 * Breiten dafuer misst placeTodayTimelineFlag.
 */
function renderTimelineFlag(timeline, now) {
  const item = timeline.lanes.flatMap((lane) => lane.items).find((entry) => entry.key === timeline.nextKey);
  const when = item ? relativeWhen(item.start, now, item.timeLabel) : null;
  if (!when) return '';
  return `<span class="today-timeline__flag" data-timeline-flag aria-hidden="true" data-flag-at="${item.start}" data-flag-clock="${esc(item.timeLabel)}" style="--tl-at:${item.left};--c:${timelineTone(item)}">${esc(when.label)}</span>`;
}

/* Abstand zwischen Fahne und dem, dem sie ausweicht (Jetzt-Pille, Stunde). */
const TIMELINE_FLAG_GAP = 4;

/**
 * Misst, was das Stylesheet fuer die Lage der Fahne braucht: die halbe Breite
 * der Jetzt-Pille (`--tl-now-half`, die Fahne beginnt erst dahinter) und die
 * eigene Breite (`--tl-flag-w`, sie endet spaetestens am Achsenende). Die
 * Stunden, die danach unter ihr liegen, schweigen wie die unter der Pille.
 * Laeuft beim Verdrahten, im Minutentakt und wenn die Leiste ihre Breite
 * aendert (ResizeObserver in wireTodayTimeline).
 */
function placeTodayTimelineFlag(timeline) {
  const flag = timeline?.querySelector?.('[data-timeline-flag]');
  if (!flag) return;
  const pill = timeline.querySelector('.today-timeline__now-time');
  const half = pill ? pill.getBoundingClientRect().width / 2 + TIMELINE_FLAG_GAP : 0;
  flag.style.setProperty('--tl-now-half', `${half}px`);
  flag.style.setProperty('--tl-flag-w', `${flag.getBoundingClientRect().width}px`);
  const box = flag.getBoundingClientRect();
  for (const hour of timeline.querySelectorAll('.today-timeline__hour[data-minute]')) {
    const rect = hour.getBoundingClientRect();
    const under = !flag.hidden && rect.right > box.left - TIMELINE_FLAG_GAP && rect.left < box.right + TIMELINE_FLAG_GAP;
    hour.classList.toggle('today-timeline__hour--flagged', under);
  }
}

/**
 * DIE KURZFASSUNG (Entwurf, mobil): je Spur ein 6px-Balken, ein 20px-Gesicht
 * statt des Namens, die Stunden in GLEICHEN Schritten (Critique 2026-10-26:
 * 07/11/15/19/22 las sich ungleich), der Jetzt-Strich. Sie ist Bild
 * (aria-hidden) - die Termine stehen darunter als Zeilen, denn ein Balken
 * traegt weder Text noch ein eigenes Tippziel. Gilt auf dem Telefon und unter
 * 900px Containerbreite.
 *
 * MOBIL VERSCHENKT DAS BILD KEINEN PLATZ (Critique 2026-10-26, Lauf 2, D3).
 * Gemessen 390x844: 148px hoch, gut ein Viertel der Karte, fuer fuenf Spuren,
 * von denen einige nur noch Vergangenes trugen. Jetzt:
 *   - NUR SPUREN MIT KOMMENDEM. Eine Spur, deren Tag durch ist, sagt nichts,
 *     was die Zeilen darunter brauchen; in einer Spur mit Kommendem bleiben
 *     die vergangenen Balken grau stehen - sie zeigen die Form des Tages.
 *     Hat keine Spur mehr etwas vor sich, entfaellt das Bild ganz: dann
 *     sprechen die Zeilen und die Coda.
 *   - PACKREIHEN ALS TEILSPUREN. Die Kurzfassung las `item.row` aus packLane
 *     nicht: Zahnarzt 11-12 und Team-Call 11:30-12:30 verschmolzen zu einem
 *     Balken, der Elternsprechtag 09-11 lag unsichtbar im Schichtbalken.
 *     Eine Fuge (2px Flaeche um den spaeteren Balken) haette nur die Kante
 *     gezeigt - ein Termin, der ganz in einem anderen liegt, bliebe verdeckt.
 *     Eine duenne Zeile je Reihe zeigt jeden Termin ganz; bis drei Reihen
 *     passen neben das 20px-Gesicht, ohne die Spur zu erhoehen.
 */
function renderTodayMiniTimeline(timeline, now = new Date()) {
  if (!timeline) return '';
  const ahead = timeline.lanes.filter((lane) => lane.items.some((item) => item.state !== 'past'));
  if (!ahead.length) return '';
  const span = timeline.end - timeline.start;
  // LINEAR, NICHT GEWICHTET (D7): die Kurzfassung zeigt die Form des ganzen
  // Tages in gleichen Schritten; die gestauchte Vergangenheit gilt nur der
  // breiten Leiste, deren Bloecke Titel tragen.
  const linear = timelineScale({ start: timeline.start, end: timeline.end });
  const step = Math.ceil(span / 60 / 5) * 60;
  const marks = [];
  for (let minute = timeline.start; minute <= timeline.end; minute += step) marks.push(minute);
  // Die Marke unter der Jetzt-Pille schweigt; schmal deckt die Pille mehr Zeit.
  const nowMinute = householdMinuteOf(now);
  const covered = (minute) => timeline.now != null && nowMinute != null && Math.abs(minute - nowMinute) < span / 12;
  const axis = marks.map((minute) => `<span${covered(minute) ? ' class="today-timeline__hour--covered"' : ''} style="--tl-at:${linear.x(minute)}">${esc(axisHourLabel(minute))}</span>`).join('');
  const solo = timeline.lanes.length === 1 && timeline.lanes[0].key === 'all' && isSoloHousehold();
  const lanes = ahead.map((lane) => {
    const face = lane.member
      ? renderAvatarStack([lane.member], { size: 20, maxVisible: 1 })
      : '<span class="today-timeline__everyone today-timeline__everyone--sm"><i data-lucide="users" class="icon-sm"></i></span>';
    const rows = Math.max(1, lane.rows ?? 1);
    const bars = lane.items.map((item) => `<i class="today-timeline__bar${item.state === 'past' ? ' today-timeline__bar--past' : ''}${item.point ? ' today-timeline__bar--point' : ''}" style="--tl-left:${linear.x(item.start)};--tl-width:${linear.width(item.start, item.end)};--tl-row:${item.row ?? 0};--c:${timelineTone(item)}"></i>`).join('');
    return `${solo ? '' : `<span class="today-timeline__face">${face}</span>`}<div class="today-timeline__bars" style="--tl-rows:${rows}">${bars}</div>`;
  }).join('');
  const nowMarker = timeline.now == null ? '' : `<div class="today-timeline__now"><span class="today-timeline__now-time">${esc(formatTime(now))}</span></div>`;
  return `
    <div class="today-timeline today-timeline--mini${solo ? ' today-timeline--solo' : ''}" aria-hidden="true"
         data-timeline-start="${timeline.start}" data-timeline-end="${timeline.end}" style="--tl-span:${span}${timeline.now == null ? '' : `;--tl-now:${linear.x(nowMinute)}`}">
      <div class="today-timeline__axis">${axis}</div>
      ${lanes}
      ${nowMarker}
    </div>`;
}

/**
 * DAS GANZE BILD IST EIN TIPPZIEL (Critique 2026-10-26, Lauf 2, D3): die
 * Kurzfassung hatte null Tippziele, und wer den Tag darin sah, musste den
 * kleinen Link `+N weitere` darunter suchen. Gibt es Verdecktes, liegt
 * ueber dem Bild EIN Knopf (oder Link, wenn `+N weitere` in eine Ansicht
 * fuehrt) mit demselben Ziel wie `+N weitere`: dieselbe Region, dasselbe
 * aria-expanded. Das Bild bleibt aria-hidden, der Knopf hat einen eigenen
 * Namen (`Ganzen Tag zeigen`), den Inhalt tragen die Zeilen. Ohne
 * Ueberlauf gibt es nichts zu oeffnen - dann ist das Bild nur Bild, ohne
 * Fokusstopp.
 *
 * Als Geschwister ueber dem Bild und nicht als Huelle: ein <button> darf
 * keine <div> enthalten, und ein Knopf in einer aria-hidden-Huelle waere ein
 * Fokusstopp ohne Namen.
 * @param {string} picture  renderTodayMiniTimeline
 * @param {{ route?: string|null, open?: boolean, target?: string }} [peek]
 *   route: Ziel von `+N weitere`; sonst klappt der Knopf die Region auf
 */
function renderTodayPeek(picture, peek = null) {
  if (!picture) return '';
  const label = esc(t('dashboard.todayShowDay'));
  let hit = '';
  if (peek?.route) {
    hit = `<a href="${esc(peek.route)}" class="today-timeline-peek__hit" data-route="${esc(peek.route)}" aria-label="${label}"></a>`;
  } else if (peek) {
    hit = `<button type="button" class="today-timeline-peek__hit" id="today-cockpit-peek" data-today-more data-today-peek
          aria-expanded="${peek.open ? 'true' : 'false'}" aria-controls="today-cockpit-more"${peek.target ? ` data-peek-target="${esc(peek.target)}"` : ''} aria-label="${label}"></button>`;
  }
  return `<div class="today-timeline-peek${hit ? ' today-timeline-peek--action' : ''}">${picture}${hit}</div>`;
}

/**
 * Wohin der Knopf ueber dem Bild nach dem Aufklappen fuehrt: zur ersten
 * kommenden Zeile unter den bisher verdeckten (Termin, Mahlzeit, Schicht mit
 * Uhrzeit nach jetzt) - das, wonach man gefragt hat, als man den ganzen Tag
 * sehen wollte. Sonst die erste verdeckte Zeile mit Objekt. `kind:id`.
 */
function todayPeekTarget(hidden, now) {
  const nowKey = zonedTimeKey(now);
  const upcoming = (row) => ['event', 'meal', 'shift'].includes(row?.kind)
    && /^\d{2}:\d{2}$/.test(String(row.sortKey)) && row.sortKey > '00:02' && row.sortKey > nowKey;
  const row = hidden.find((r) => upcoming(r) && r.objectId != null) ?? hidden.find((r) => r?.objectId != null);
  return row ? `${row.kind}:${row.objectId}` : '';
}

/**
 * Nach dem Aufklappen ueber das Bild: Fokus und Blick auf die Zielzeile
 * (todayPeekTarget), sonst auf die erste Zeile der Region. `block: 'nearest'`
 * mit dem scroll-padding des Scrollports (layout.css, --nav-tail): die Zeile
 * landet ueber der Kapsel, nicht dahinter.
 */
function revealTodayPeekTarget(region, target) {
  if (!region?.querySelector) return;
  const [kind, id] = String(target ?? '').split(':');
  const quote = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
  const row = (kind && id ? region.querySelector(`[data-object-kind="${quote(kind)}"][data-object-id="${quote(id)}"]`) : null)
    ?? region.querySelector('a[href], button');
  if (!row) return;
  row.focus?.({ preventScroll: true });
  const still = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  row.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
}

/** Aufgeklappt bleibt aufgeklappt, auch wenn der Minutentakt das Blatt neu zeichnet. */
let todayTimelineOpen = null;

/* Welcher Block die Zeile aufgeklappt hat, als Schluessel und Stelle unter den
 * Bloecken mit diesem Schluessel: ein Termin fuer zwei steht in zwei Spuren,
 * und Esc gibt den Fokus dem zurueck, der ihn geoeffnet hat - auch nach einem
 * Neuaufbau im Minutentakt. */
let todayTimelineOwner = null;

/* Misst die Fahne nach, wenn die Leiste ihre Breite aendert; einer je Aufbau. */
let todayFlagObserver = null;

/**
 * Ein Block klappt seine Zeile unter der Leiste auf, ein zweiter Klick auf
 * denselben klappt sie zu, ein Klick auf einen anderen wechselt; Esc klappt zu
 * und gibt den Fokus an DEN Block zurueck, der sie geoeffnet hat. Die Leiste
 * ist ein Tab-Stopp (roving tabindex): links/rechts, Pos1 und Ende wandern in
 * der Lesereihenfolge, hoch/runter wechseln die Spur - zum Block der
 * Nachbarspur, dessen Beginn dem eigenen am naechsten liegt (Critique
 * 2026-10-26, Lauf 2: hoch/runter liefen wie links/rechts).
 *
 * DIE ZEILE GLEITET AUF WIE „+N WEITERE" (Critique 2026-10-26, Lauf 2): bis
 * hierher schaltete nur `hidden`, und das Raster darunter sprang um 81px,
 * waehrend „+N weitere" daneben 250ms glitt. Jetzt dieselbe Regel
 * (toggleRegion: Hoehe per FLIP der Nachbarn, unter reduzierter Bewegung nur
 * eine Blende). Wechselt die Auswahl bei offener Zeile, bleibt die Hoehe
 * stehen und nur der Inhalt blendet ueber - mit dem Inhaltswechsel der App
 * (swapContent), nicht mit einer eigenen Kurve.
 */
function wireTodayTimeline(root) {
  const region = root?.querySelector?.('#today-timeline-detail');
  if (!region) return;
  const buttons = [...root.querySelectorAll('[data-timeline-event]')];
  const keyOf = (btn) => btn.dataset.timelineEvent;
  const sameKey = (key) => buttons.filter((btn) => keyOf(btn) === key);
  // Die Spuren in Lesereihenfolge: das Band des Ganztaegigen, dann je Person.
  const laneOf = (btn) => btn.closest('ul');
  const lanes = [...new Set(buttons.map(laneOf))];
  let owner = todayTimelineOwner?.key === todayTimelineOpen
    ? sameKey(todayTimelineOpen)[todayTimelineOwner.nth] ?? null
    : null;
  const setOpen = (next, from = null) => {
    const switching = todayTimelineOpen != null && next != null && !region.hidden;
    todayTimelineOpen = next;
    owner = next == null ? null : from;
    todayTimelineOwner = owner ? { key: next, nth: sameKey(next).indexOf(owner) } : null;
    for (const other of buttons) other.setAttribute('aria-expanded', keyOf(other) === next ? 'true' : 'false');
    if (next == null) {
      toggleRegion(region, false);
      return;
    }
    const rows = [...region.querySelectorAll('[data-timeline-detail]')];
    const showRow = () => {
      for (const row of rows) row.hidden = row.dataset.timelineDetail !== next;
    };
    if (switching) swapContent(rows.find((row) => row.dataset.timelineDetail === next) ?? null, showRow);
    else showRow();
    // Auch beim Wechsel: ein Zuklappen, das gerade laeuft, haelt hier an.
    toggleRegion(region, true);
  };
  const focusButton = (btn) => {
    if (!btn) return;
    for (const other of buttons) other.setAttribute('tabindex', other === btn ? '0' : '-1');
    btn.focus();
  };
  // Der Block der Nachbarspur, dessen Beginn dem eigenen am naechsten liegt;
  // im Band (ohne Beginn) der erste. Gleich nah gewinnt der fruehere.
  const across = (btn, step) => {
    const lane = lanes[lanes.indexOf(laneOf(btn)) + step];
    if (!lane) return null;
    const startOf = (other) => Number(other.closest('[data-timeline-at]')?.dataset.timelineAt ?? NaN);
    const at = startOf(btn);
    const distance = (other) => (Number.isFinite(at) && Number.isFinite(startOf(other)) ? Math.abs(startOf(other) - at) : 0);
    return buttons.filter((other) => laneOf(other) === lane)
      .reduce((best, other) => (!best || distance(other) < distance(best) ? other : best), null);
  };
  buttons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      const key = keyOf(btn);
      setOpen(todayTimelineOpen === key ? null : key, btn);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        focusButton(across(btn, e.key === 'ArrowUp' ? -1 : 1));
        return;
      }
      const move = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (move != null) {
        e.preventDefault();
        focusButton(buttons[Math.max(0, Math.min(buttons.length - 1, move))]);
      }
    });
  });
  const close = (e) => {
    if (e.key !== 'Escape' || todayTimelineOpen == null) return;
    const back = owner ?? sameKey(todayTimelineOpen)[0];
    e.preventDefault();
    setOpen(null);
    focusButton(back);
  };
  region.addEventListener('keydown', close);
  for (const btn of buttons) btn.addEventListener('keydown', close);
  const timeline = root.querySelector('.today-timeline:not(.today-timeline--mini)');
  todayFlagObserver?.disconnect();
  todayFlagObserver = null;
  if (timeline?.querySelector('[data-timeline-flag]')) {
    placeTodayTimelineFlag(timeline);
    if (typeof ResizeObserver === 'function') {
      todayFlagObserver = new ResizeObserver(() => placeTodayTimelineFlag(timeline));
      todayFlagObserver.observe(timeline);
    }
  }
}

/**
 * Der Jetzt-Strich wandert mit dem Minutentakt, ohne das Blatt neu zu bauen:
 * der Fingerabdruck des Tages (todayFingerprint) aendert sich erst, wenn ein
 * Eintrag beginnt oder endet - dann baut die Uebersicht ohnehin neu.
 * Dazwischen setzt diese Funktion nur die Lage und die Uhrzeit, und die Fahne
 * des Naechsten zaehlt herunter („in 25 Min" -> „in 24 Min"), samt dem
 * zugaenglichen Namen ihres Blocks. Hat er begonnen, schweigt sie, bis der
 * Neuaufbau den naechsten nennt.
 */
function updateTodayTimelineNow(root, now = new Date()) {
  const timeline = root?.querySelector?.('.today-timeline');
  if (!timeline) return;
  const flag = timeline.querySelector('[data-timeline-flag]');
  if (flag) {
    const clock = flag.dataset.flagClock ?? '';
    const when = relativeWhen(Number(flag.dataset.flagAt), now, clock);
    flag.hidden = !when;
    if (when) {
      flag.textContent = when.label;
      for (const spoken of timeline.querySelectorAll('[data-timeline-when]')) spoken.textContent = `, ${spokenWhen(when, clock)}`;
    }
  }
  const start = Number(timeline.dataset.timelineStart);
  const end = Number(timeline.dataset.timelineEnd);
  const minute = householdMinuteOf(now);
  if (!(end > start) || minute == null || minute < start || minute > end) {
    placeTodayTimelineFlag(timeline);
    return;
  }
  // Dasselbe Knie, mit dem die Leiste gezeichnet ist (data-timeline-knee):
  // springt es zur vollen Stunde, baut der Fingerabdruck ohnehin neu. Die
  // Kurzfassung traegt keins und bleibt linear.
  const kneeAttr = timeline.dataset.timelineKnee;
  const scale = timelineScale({ start, end, knee: kneeAttr == null || kneeAttr === '' ? null : Number(kneeAttr) });
  timeline.style.setProperty('--tl-now', String(scale.x(minute)));
  for (const hour of timeline.querySelectorAll('.today-timeline__hour[data-minute]')) {
    hour.classList.toggle('today-timeline__hour--covered', timelineHourCovered(scale, Number(hour.dataset.minute), minute));
  }
  const label = timeline.querySelector('.today-timeline__now-time');
  if (label) label.textContent = formatTime(now);
  placeTodayTimelineFlag(timeline);
}

/* „ALS NAECHSTES" (Entwurf „Heute wichtig", 2026-10-26): auf der breiten
 * Buehne drei Zellen nebeneinander - das Naechste, das Ueberfaellige, der
 * Einkauf zuletzt. Was nicht passt, zaehlt „+N weitere" in der Fussleiste.
 * Die Termine stehen dort in der Zeitleiste, nicht in der Liste. */
const PROGRAM_STRIP_CAP = 3;

/* Unter der breiten Buehne (Tablet, schmale Spalte) stehen die Zeilen
 * untereinander, so viele wie der Entwurf mobil zeigt. */
const PROGRAM_COMPACT_CAP = 4;

/* DIE DREI BUEHNEN DES BLATTS (Critique 2026-10-26, Befund 1): `phone` (die
 * Telefon-Buehne, dynamischer Deckel), `compact` (unter 900px Containerbreite:
 * Kurzfassung plus Zeilen - dort waere eine Stunde schmaler als ihr Titel und
 * ein Block auf Touch 35px breit) und `wide` (Leiste mit Bloecken). Gemessen
 * wird das Blatt selbst, beim ersten Aufbau der Inhaltsbereich; ohne DOM
 * (Tests) gilt `wide`. Wechselt die Buehne beim Groessenziehen, baut die
 * Uebersicht neu (createPhoneProgramFit). */
const TODAY_COMPACT_WIDTH = 900;
let todayLastWidth = null;

function todayStage() {
  if (onPhoneStage()) return 'phone';
  const doc = globalThis.document;
  const sheet = doc?.querySelector?.('.today-cockpit');
  const content = doc?.querySelector?.('.app-content');
  const width = sheet?.clientWidth || (content?.clientWidth ? content.clientWidth - 2 * PAGE_PAD_ESTIMATE : 0) || todayLastWidth;
  if (width) todayLastWidth = width;
  return width && width < TODAY_COMPACT_WIDTH ? 'compact' : 'wide';
}

/* Das Seitenpolster des Inhaltsbereichs, nur fuer die erste Schaetzung, bevor
 * es das Blatt gibt; danach misst todayStage das Blatt selbst. */
const PAGE_PAD_ESTIMATE = 32;

/**
 * Wann ein Termin oder eine Mahlzeit dran ist, relativ zu jetzt: „in 25 Min"
 * im Ton des Moduls (unter einer Stunde), spaeter „15:00 · in 2 Std." (relativeWhen). Ueber
 * Intl.RelativeTimeFormat, damit jede Sprache ihre eigene Kurzform hat.
 * Aufgaben behalten ihr „bis 18:00" - eine Frist ist kein Beginn.
 */
function withRelativeWhen(row, now) {
  if (!row || !['event', 'meal'].includes(row.kind)) return row;
  const time = String(row.sortKey ?? '');
  if (!/^\d{2}:\d{2}$/.test(time) || time <= '00:02') return row;
  const when = relativeWhen(clockMinute(time), now, formatTime(time));
  return when ? { ...row, timeLabel: when.label, soon: when.soon } : row;
}

/**
 * DAS NAECHSTE ZUERST (Entwurf: „naechster Termin/Mahlzeit, Ueberfaelliges,
 * Einkauf zuletzt"). Der Deckel haelt Offenes vorn (composeTodaySheet), und so
 * rutschte das Abendessen um 18:30 hinter „+N weitere". Hier rueckt der
 * frueheste kommende Termin oder die Mahlzeit an die erste Stelle - steht er
 * hinter dem Deckel, tauscht er mit der letzten sichtbaren Zeile. Die Zahl
 * hinter „+N weitere" bleibt dieselbe; ihr Ziel rechnet neu.
 */
function nextFirst(model, now) {
  // In zwei Teilen (D6) steht die Leiste schon chronologisch vorn, und der
  // Deckel haelt ihr Naechstes (composeTodaySheet, anchor) - ein Vorziehen
  // stellte es vor das Ganztaegige und das Laufende.
  if (model.lead) return model;
  const nowKey = zonedTimeKey(now);
  const upcoming = (row) => ['event', 'meal'].includes(row?.kind)
    && /^\d{2}:\d{2}$/.test(String(row.sortKey)) && row.sortKey > '00:02' && row.sortKey > nowKey;
  const soonest = (list) => list.reduce((best, row, index) => (upcoming(row) && (best < 0 || row.sortKey < list[best].sortKey) ? index : best), -1);
  const visible = soonest(model.rows);
  const hiddenIndex = soonest(model.hiddenRows);
  if (hiddenIndex >= 0 && model.rows.length && model.rows.at(-1).kind !== 'overdue' && (visible < 0 || model.hiddenRows[hiddenIndex].sortKey < model.rows[visible].sortKey)) {
    const promoted = model.hiddenRows[hiddenIndex];
    const demoted = model.rows.at(-1);
    const hiddenRows = [demoted, ...model.hiddenRows.filter((_, i) => i !== hiddenIndex)];
    return {
      ...model,
      rows: [promoted, ...model.rows.slice(0, -1)],
      hiddenRows,
      moreRoute: todayMoreRoute(hiddenRows, zonedDateKey(now)),
    };
  }
  if (visible <= 0) return model;
  return { ...model, rows: [model.rows[visible], ...model.rows.slice(0, visible), ...model.rows.slice(visible + 1)] };
}

function renderTodayCockpit(data, cfg = [], editing = false, { now = new Date(), moreOpen = todayMoreOpen, overdueOpen = todayOverdueOpen, timelineOpen = todayTimelineOpen, cap, stage = todayStage(), viewer = dashboardViewer } = {}) {
  const phone = stage === 'phone';
  const wide = stage === 'wide';
  // Die Leiste nur, wenn der Kalender im Blatt spricht: neben einer sichtbaren
  // Termin-Kachel waere sie deren Echo. Unter der breiten Buehne ist sie die
  // stumme Kurzfassung (6px-Balken, kein Text); dort bleiben die Termine Zeilen.
  const timeline = todayDomainSpeaks(cfg, 'calendar')
    ? buildTodayTimeline(data, { now, viewer, includeMeals: todayDomainSpeaks(cfg, 'meals'), includeShifts: todayDomainSpeaks(cfg, 'schedule') })
    : null;
  // Breit nimmt die Leiste ihre Eintraege aus der Liste; darunter speist sie
  // die Zeilen (timelineSheetRows) - Bild und Text aus einem Modell.
  const timelineOptions = { timeline, timelineRows: !wide };
  const stageCap = cap ? { cap } : phone ? {} : { cap: wide ? PROGRAM_STRIP_CAP : PROGRAM_COMPACT_CAP };
  let model = buildTodayCockpitModel(data, cfg, { now, ...timelineOptions, ...stageCap });
  // Breit ist der Einkauf eine der drei Zellen - die letzte.
  if (wide && !cap && model.shopping && model.rows.length >= PROGRAM_STRIP_CAP) {
    model = buildTodayCockpitModel(data, cfg, { now, ...timelineOptions, cap: PROGRAM_STRIP_CAP - 1 });
  }

  // „Heute frei" unter einer Leiste voller beendeter Termine widerspraeche ihr:
  // der Tag war nicht frei, er ist durch.
  const state = model.state && timeline && model.state.icon === 'sparkles'
    ? { ...model.state, title: t('dashboard.todayNothingElse') }
    : model.state;
  model = nextFirst(model, now);
  const rows = model.rows.map((row) => withRelativeWhen(row, now));
  const shopping = model.shopping ? { ...model.shopping, chevron: true } : null;

  const parts = [];
  // Die Kurzfassung steht vorn, ihr Knopf kennt aber erst unten das Ziel von
  // „+N weitere" (renderTodayPeek) - sie wird dort eingesetzt.
  const picture = timeline && !wide ? renderTodayMiniTimeline(timeline, now) : '';
  if (timeline && wide) parts.push(renderTodayTimeline(timeline, now, timelineOpen));

  const listRows = [];
  if (state) listRows.push(renderTodayStateRow(state));
  listRows.push(...rows.map((row) => (row.kind === 'overdue'
    ? renderTodayOverdueGroup(row, overdueOpen)
    : renderTodayRow(row))));
  const foldShopping = Boolean(shopping) && model.overflow > 0 && !model.moreRoute && !wide;
  // „AUSSERDEM HEUTE" AUCH UNTER DER BREITEN BUEHNE (D6): zwischen den
  // Eintraegen der Leiste und dem Rest, nur wenn beide Teile stehen - in der
  // Liste, vor der Einkaufszeile (wenn sie allein den Rest bildet) oder in den
  // aufgeklappten Zeilen, je nachdem, wo der Rest beginnt. Eine Ueberschrift,
  // damit der Screenreader die Gliederung hoert und anspringen kann.
  const lead = model.lead;
  const leadShown = lead?.shown ?? 0;
  const also = `<h3 class="today-cockpit__also today-cockpit__also--row">${esc(t('dashboard.todayAlsoTitle'))}</h3>`;
  const alsoInRows = leadShown > 0 && rows.length > leadShown;
  const alsoBeforeShopping = !alsoInRows && leadShown > 0 && Boolean(shopping) && !foldShopping;
  if (alsoInRows) listRows.splice((state ? 1 : 0) + leadShown, 0, also);
  // Breit steht der Einkauf als letzte Zelle in der Leiste; darunter bleibt er
  // die Schlusszeile unter den Zeilen und klappt mit (R14).
  if (wide && shopping) listRows.push(renderTodayRow(shopping));
  if (listRows.length) {
    const cols = Math.min(PROGRAM_STRIP_CAP, Math.max(1, listRows.length));
    // „AUSSERDEM HEUTE" (Critique 2026-10-26, Befund 2): breit nennt die Leiste
    // das Naechste selbst, der Streifen traegt den Rest des Tages - und sagt es.
    if (wide && timeline && rows.length) parts.push(`<p class="today-cockpit__also">${esc(t('dashboard.todayAlsoTitle'))}</p>`);
    parts.push(wide
      ? `<div class="today-cockpit__rows today-cockpit__rows--next" style="--today-next-cols:${cols}">${listRows.join('')}</div>`
      : `<div class="today-cockpit__rows">${listRows.join('')}</div>`);
  }
  if (!wide && shopping && !foldShopping) parts.push(`${alsoBeforeShopping ? also : ''}${renderTodayRow(shopping)}`);

  // DIE FUSSLEISTE: links die Coda, rechts „+N weitere" (Entwurf). Beide
  // zugleich gibt es nicht - neben verdeckten Zeilen waere „nichts mehr"
  // gelogen (codaAllowed).
  //
  // UNTER DER BREITEN BUEHNE IST „+N WEITERE" DIE LETZTE ZEILE (Critique
  // 2026-10-26, Lauf 2, D3): gemessen 390x844 trug ein 71-75px hohes Fussband
  // nur diesen einen Link. Jetzt steht er als schlanke Zeile im Raster der
  // Zeilen (44px, Text an der Titelkante); die Coda behaelt ihren Fuss. Breit
  // bleibt der Fuss, wie er ist: dort steht der Link rechts unter drei Zellen
  // nebeneinander, eine Zeile im Raster gibt es nicht.
  const moreRow = wide ? '' : ' today-cockpit__more--row';
  let more = '';
  let peek = null;
  if (model.overflow > 0 && model.moreRoute) {
    peek = { route: model.moreRoute };
    more = `<a href="${esc(model.moreRoute)}" class="today-cockpit__more today-cockpit__more--link${moreRow}" data-route="${esc(model.moreRoute)}">
          <span>${esc(t('dashboard.todayMore', { count: model.overflow }))}</span><i data-lucide="chevron-right" class="icon-sm" aria-hidden="true"></i>
        </a>`;
  } else if (model.overflow > 0) {
    // Keine Ansicht zeigt alle verdeckten Zeilen (todayMoreRoute): sie stehen
    // hier, zugeklappt, und der Knopf darunter klappt sie auf. Auf dem Telefon
    // klappt die Einkaufszeile mit (R14).
    const hidden = (foldShopping ? [...model.hiddenRows, shopping] : model.hiddenRows).map((row) => withRelativeWhen(row, now));
    // Die verdeckten Zeilen der Leiste stehen vorn (composeTodaySheet); folgt
    // ihnen der Rest und hat ihn oben noch keine Ueberschrift eingeleitet,
    // beginnt er hier.
    const hiddenLead = lead ? lead.total - lead.shown : 0;
    const alsoInMore = Boolean(lead?.total) && !alsoInRows && !alsoBeforeShopping && hidden.length > hiddenLead;
    const hiddenRowsHtml = (list) => list.map((row, index) => `${alsoInMore && index === hiddenLead ? also : ''}${renderTodayRow(row)}`).join('');
    const moreText = t('dashboard.todayMore', { count: hidden.length });
    const lessText = t('dashboard.todayLess');
    peek = { open: moreOpen, target: todayPeekTarget(hidden, now) };
    parts.push(`<div class="today-cockpit__rows today-cockpit__rows--more${wide ? ' today-cockpit__rows--next' : ''}" id="today-cockpit-more"${wide ? ` style="--today-next-cols:${Math.min(PROGRAM_STRIP_CAP, hidden.length)}"` : ''}${moreOpen ? '' : ' hidden'}>${
      hiddenRowsHtml(hidden)}</div>`);
    more = `<button type="button" class="today-cockpit__more today-cockpit__more--link${moreRow}" data-today-more
          aria-expanded="${moreOpen ? 'true' : 'false'}" aria-controls="today-cockpit-more"
          data-more-label="${esc(moreText)}" data-less-label="${esc(lessText)}">
          <span>${esc(moreOpen ? lessText : moreText)}</span><i data-lucide="chevron-down" class="icon-sm today-cockpit__more-icon" aria-hidden="true"></i>
        </button>`;
  }
  if (!wide && more) parts.push(more);
  const footMore = wide ? more : '';
  if (model.coda || footMore) {
    parts.push(`<div class="today-cockpit__foot">${model.coda ? `<span class="today-cockpit__coda">${esc(model.coda)}</span>` : ''}${footMore}</div>`);
  }
  if (picture) parts.unshift(renderTodayPeek(picture, peek));

  // Deckt der Nutzer alle vier Domänen über Widgets ab, wäre das Cockpit leer —
  // dann entfällt der ganze Abschnitt statt einer leeren Kopfzeile. Im
  // Bearbeiten-Modus bleibt er stehen, auch ohne Inhalt: sonst wäre der
  // Schalter, mit dem man ihn abstellt, nur sichtbar solange er etwas zu sagen
  // hat (#740).
  if (!parts.length && !editing) return '';

  // Derselbe Ausblenden-Knopf wie an jeder Kachel, damit das Kopfband im
  // Bearbeiten-Modus keine Sonderbedienung braucht.
  const hideBtn = editing ? `
    <button type="button" class="widget-edit-controls__hide" data-glance-hide
            aria-label="${t('dashboard.customizeHide', { widget: t('dashboard.todayTitle') })}">
      <i data-lucide="eye-off" aria-hidden="true"></i>
    </button>` : '';

  const summary = todaySummary(data, model, timeline, now);

  /* DER KOPF STEHT IN DER KARTE (Entwurf): Siegel der Uebersicht, Titel, die
   * Summe des Tages - auf jeder Buehne. Im Anpassen-Modus steht er ueber der
   * Karte: mobil klappt das Band dort auf diese Kopfzeile zusammen
   * (dashboard.css, `.today-cockpit--editing`), und der Ausblenden-Knopf
   * muss sichtbar bleiben. */
  const header = `
      <div class="today-cockpit__header">
        <span class="module-seal today-cockpit__seal" aria-hidden="true">${moduleIconHTML('sun-moon')}</span>
        <div class="today-cockpit__heading">
          <h2 id="today-cockpit-title" tabindex="-1">${esc(t('dashboard.todayTitle'))}</h2>
          ${summary ? `<p class="today-cockpit__summary">${esc(summary)}</p>` : ''}
        </div>
        ${hideBtn}
      </div>`;

  // Zeilenzahl und Tagesumfang stehen am Blatt, damit `measurePhoneProgram`
  // nach dem Zeichnen nachrechnen kann, ohne das Modell ein zweites Mal zu bauen.
  const fit = phone && !editing
    ? ` data-program-cap="${model.rows.length}" data-program-total="${model.allRows.length}"${model.shopping ? ' data-program-shopping="1"' : ''}${lead?.total ? ` data-program-lead="${lead.total}"` : ''}`
    : '';
  return `
    <section class="today-cockpit${editing ? ' today-cockpit--editing' : ''}" aria-labelledby="today-cockpit-title" data-today-stage="${stage}"${fit}>
      ${editing ? header : ''}
      <div class="today-cockpit__grid">
        ${editing ? '' : header}
        ${parts.join('')}
      </div>
    </section>
  `;
}


/* Vorgabe setzen und Zuruecksetzen - die zwei Knoepfe, die die REICHWEITE
 * einer Anordnung aendern. Sie stehen am Desktop in der Anpassen-Leiste und
 * mobil in der Fussnote (R9 M7); beide Stellen verdrahtet derselbe
 * Datenattribut-Handler (`[data-customize-publish]`/`[data-customize-reset]`).
 * Die Ids tragen nur die Knoepfe der Leiste - eine Id gibt es einmal. */
function renderCustomizeScopeActions({ followsDefault = true, canPublish = false, id = false } = {}) {
  return `${canPublish ? `
            <button class="btn btn--ghost dashboard-customize-scope-action" data-customize-publish${id ? ' id="dashboard-customize-publish"' : ''}>
              <i data-lucide="users" class="icon-sm" aria-hidden="true"></i>
              ${t('dashboard.customizeSetDefault')}
            </button>` : ''}${followsDefault ? '' : `
            <button class="btn btn--ghost dashboard-customize-scope-action" data-customize-reset${id ? ' id="dashboard-customize-reset"' : ''}>
              <i data-lucide="rotate-ccw" class="icon-sm" aria-hidden="true"></i>
              ${t('dashboard.customizeReset')}
            </button>`}`;
}

/* DER REICHWEITEN-SATZ ALS FUSSNOTE (R9 M7, A7 P1-2). Mobil stand er mit
 * Vorgabe, Zuruecksetzen, Abbrechen und Speichern ueber dem Gruss und brach in
 * drei Zeilen um (y 180-340); das erste Widget begann erst bei y 946 von 844.
 * Unter dem Raster beantwortet er dieselbe Frage ("gilt das fuer alle?") vor
 * dem Tipp auf "Fertig", ohne das Bearbeitete wegzuschieben. Sichtbar nur auf
 * schmaler Buehne (dashboard.css) - breit steht er im Kopf. */
function renderCustomizeFootnote({ followsDefault = true, canPublish = false } = {}) {
  const actions = renderCustomizeScopeActions({ followsDefault, canPublish });
  return `
    <section class="dashboard-customize-footnote" aria-label="${esc(t('dashboard.customizeTitle'))}">
      ${renderCustomizeScopeHint(followsDefault)}
      ${actions.trim() ? `<div class="dashboard-customize-footnote__actions">${actions}</div>` : ''}
    </section>`;
}

/* DIE REICHWEITE IN EINER ZEILE, DER HINTERGRUND DAHINTER (DW-P2-9).
 * Im Kopf standen zwei Saetze rechtsbuendig uebereinander, neben vier
 * Knoepfen - der Kopf las sich wie eine Fussnote. Die Frage im Moment ist
 * "trifft das die anderen?", und die beantwortet der erste Satz; woher der
 * aktuelle Stand kommt (die Vorgabe des Haushalts), steht hinter "Mehr dazu" -
 * dasselbe native `<details>` wie die Erklaerungen der Einstellungen
 * (hintFoldHtml, R22 D13). Ohne Vorgabe gibt es nichts aufzuklappen. */
function renderCustomizeScopeHint(followsDefault) {
  const more = followsDefault ? `
      <details class="dashboard-customize-scope__more">
        <summary class="dashboard-customize-scope__summary">${esc(t('settings.hintMore'))}<i data-lucide="chevron-down" class="dashboard-customize-scope__icon" aria-hidden="true"></i></summary>
        <p class="dashboard-customize-scope__state">${t('dashboard.customizeFollowsDefault')}</p>
      </details>` : '';
  return `<p class="dashboard-customize-scope__lead">${t('dashboard.customizeScopeHint')}</p>${more}`;
}

/* DER KOPF DER UEBERSICHT: Datumszeile mit Werkzeugen, darunter der Large
 * Title ueber die volle Breite (Critique 2026-09-23, P1).
 *
 * Die Werkzeuge standen als eigene Spalte NEBEN dem Grusstapel, und unter
 * ihnen der Stand-Anker mit `flex: 0 0 100%`. Der blaehte die Spalte mobil auf
 * 187px auf; dem Gruss blieben bei 390px 171px, er brach dreizeilig um
 * („Guten / Abend, / Linda"), und der erste Inhalt stand bei 274 von 844px.
 * Jetzt teilen sich Datum und Knoepfe EINE Zeile - dieselbe Bauart wie eine
 * Large-Title-Leiste, deren Knoepfe ueber dem Titel sitzen -, und der Titel
 * hat die ganze Breite. Das Raster dafuer steht in dashboard.css.
 *
 * DER STAND-ANKER („Stand 14:32", Critique R2, A8) gehoert der Wand. Dort
 * beweist er, dass der stille Refresh laeuft, und dort steht er weiter
 * (`.wall__updated`, renderWallSurface). Auf dem Telefon und am Schreibtisch
 * kostete er eine Zeile Kopf fuer eine Frage, die dort niemand stellt: wer die
 * Seite in der Hand hat, laedt sie im Zweifel selbst neu. */
function renderDashboardOverview(user, editing = false, weather = null, scope = {}) {
  // Wer der Vorgabe des Haushalts folgt, hat nichts zurueckzusetzen; wer sie
  // setzen darf, ist Admin (#827).
  // `offerNew: false` im Fehlerzustand: wie der Speed-Dial dort (#634-Kommentar
  // bei initFab) kein Anlegen in Module, deren Daten nicht geladen sind.
  const { followsDefault = true, canPublish = false, offerNew = true, weatherCard = false } = scope;
  const dateLabel = mastheadDateLabel();
  // EIN WANDTABLETT BEKOMMT ZWEI KNOEPFE NICHT, WEIL BEIDE NUR SCHEITERN
  // KOENNEN (#1808). "Anpassen" endet in `PUT /preferences`, und ein Display
  // schreibt genau zwei Routen (`DISPLAY_WRITE_ROUTES`, server/display-scopes.js)
  // - die gehoert nicht dazu, mit Absicht: wer an der Kuechenwand vorbeigeht,
  // hat das Geraet bedient, und "aendert keine Einstellungen" ist seit #1209
  // zugesagt. Der Melder ordnete sein Brett um, tippte "Fertig" und bekam eine
  // 403 - die Oberflaeche bot eine Handlung an, die der Server zu Recht
  // verweigert. Die Suche daneben ist derselbe Fall (`search` steht nicht in
  // DISPLAY_SCOPES); die Seitenleiste laesst sie am Display schon weg
  // (router.js), dieser Kopf tat es nicht. Das Brett eines Tabletts ordnet ein
  // Administrator ueber die Haushaltsvorgabe: ein Display speichert nie etwas
  // Eigenes und folgt ihr deshalb immer.
  const onDisplay = user?.access_scope === 'display';

  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header${editing ? ' dashboard-overview__header--editing' : ''}">
        <span class="dashboard-overview__date">${dateLabel}</span>
        <h2 class="dashboard-overview__title dashboard-overview__title--${greetingPeriod()}">${greeting(user.display_name)}</h2>
        ${mastheadWeatherHtml(weather, { card: weatherCard })}
        <div class="dashboard-overview__tools">
          ${editing ? `
          <!-- Die Beruhigung stand nur im Toast NACH dem Speichern, die
               Unsicherheit sitzt aber DAVOR: während man eine Kachel wegzieht
               und nicht weiß, ob man sie gerade den Kindern wegnimmt (Critique
               2026-08-16). Ein Satz im Anpassen-Modus beantwortet sie im
               richtigen Moment. -->
          <div class="dashboard-customize-scope">
            ${renderCustomizeScopeHint(followsDefault)}
          </div>
          <!-- MOBIL EINE ZEILE: [Abbrechen] Titel [Fertig] (R9 M7, iOS-Muster).
               Der Titel ist nur dort sichtbar (dashboard.css); am Desktop steht
               die Leiste wie bisher neben dem Gruss. Vorgabe und Zuruecksetzen
               stehen mobil mit dem Reichweiten-Satz als Fussnote unter dem
               Raster (renderCustomizeFootnote) - hier bleiben sie fuer die
               breite Buehne. -->
          <div class="dashboard-customize-toolbar" role="toolbar" aria-label="${t('dashboard.customizeTitle')}">
            ${renderCustomizeScopeActions({ followsDefault, canPublish, id: true })}
            <span class="dashboard-customize-toolbar__title" aria-hidden="true">${esc(t('dashboard.customizeTitle'))}</span>
            <button class="btn btn--secondary" id="dashboard-customize-cancel">${t('common.cancel')}</button>
            <button class="btn btn--primary" id="dashboard-customize-save">${esc(t('dashboard.customizeDone'))}</button>
          </div>` : ''}
          <!-- DER EINSTIEG SITZT DA, WO DER AUSSTIEG SITZT (#915). Der Wandmodus
               liess sich nur unter Einstellungen -> Persoenlich -> Darstellung
               einschalten, verlassen aber hier auf der Uebersicht - man ging
               dort hinaus, wo man nicht hineinkam.

               Kein eigener Schalter dafuer, ob dieser Knopf erscheint: er
               laege in denselben Einstellungen, in denen der Modus selbst
               schon steht, und waere ein zweiter Schalter fuer eine Sache.
               Auch keine Regel nach Geraeteform - ein falsch versteckter
               Einstieg ist wieder unauffindbar und verschoebe das Problem nur.
               Er ist ein Icon-Knopf wie der daneben und traegt sich so leise
               wie der.

               Im Anpassen-Modus faellt er weg: dort geht es um die Anordnung
               der Kacheln, und ein Moduswechsel mittendrin wuerfe eine
               ungespeicherte Bearbeitung weg. -->
          <!-- IM ANPASSEN-MODUS GIBT ES KEIN X (Re-Critique 2026-09-27, A7 P2-5).
               Es hiess „Anpassung beenden" und verwarf still - neben
               „Abbrechen" ein zweiter Ausgang mit derselben Folge, aber einem
               Wort, das „fertig" verspricht. Die Leiste hat jetzt genau zwei
               Wege hinaus: Speichern, und Abbrechen mit Rueckfrage, sobald
               etwas zu verlieren ist. -->
          ${editing ? '' : `
          <!-- DIE SUCHE MIT EINEM TIPP VON DER UEBERSICHT (Re-Critique
               2026-09-27, A1 P2-6). Mobil lag die globale Suche nur im
               Mehr-Blatt, zwei Tipps tief. Die Kapsel hat keinen Platz fuer
               ein sechstes Ziel (gemessen: 52px je Slot, "Übersicht" und
               "Aufgaben" brechen), also steht sie hier, wo man ankommt - ein
               Icon-Knopf wie die zwei daneben. -->
          ${onDisplay ? '' : `<button class="btn btn--secondary btn--icon dashboard-icon-btn" id="dashboard-search"
                  aria-label="${t('nav.search')}"
                  title="${t('nav.search')}" aria-haspopup="dialog">
            <i data-lucide="search" aria-hidden="true"></i>
          </button>`}
          <button class="btn btn--secondary btn--icon dashboard-icon-btn" id="dashboard-wall-enter"
                  aria-label="${t('dashboard.wallEnter')}"
                  title="${t('dashboard.wallEnter')}">
            <i data-lucide="maximize-2" aria-hidden="true"></i>
          </button>
          ${onDisplay ? '' : `<button class="btn btn--secondary btn--icon dashboard-icon-btn" id="dashboard-customize-btn"
                  aria-label="${t('dashboard.customize')}"
                  title="${t('dashboard.customize')}">
            <i data-lucide="settings-2" aria-hidden="true"></i>
          </button>`}
          ${/* MOBIL IST DAS EIN MENUE (R19, Entscheidung Ulas 2026-10-16): der
               Wand-Modus wandert ins Anpassen-Menue. Drei Icon-Knoepfe ueber dem
               Gruss waren zwei zu viel fuer eine Handlung, die man auf dem
               Telefon fast nie braucht. Unter 768px steht dieses Menue statt
               der beiden Knoepfe davor (dashboard.css), seine Eintraege klicken
               sie - ein Handler je Handlung, je Breite ein Weg. */ ''}
          ${onDisplay ? '' : popoverMenuHtml({
            id: 'dashboard-tools-menu',
            label: t('dashboard.customize'),
            icon: 'settings-2',
            triggerClass: 'btn btn--secondary btn--icon dashboard-icon-btn dashboard-tools-btn',
            items: [
              { action: 'dashboard-customize', icon: 'layout-grid', label: t('dashboard.customizeTitle') },
              { action: 'dashboard-wall', icon: 'maximize-2', label: t('dashboard.wallEnter') },
            ],
          })}
          ${offerNew && onDesktopStage() ? renderNewPill() : ''}`}
        </div>
      </div>
    </section>
  `;
}

/** Hat der Anpassen-Modus etwas, das „Abbrechen" wegwerfen wuerde? */
/**
 * DER ANPASSEN-MODUS VERLIERT NICHTS STILL (Re-Critique 2026-09-28, A7 P2-1).
 *
 * Abbrechen fragte seit 2026-09-27 nach, sobald es etwas zu verlieren gab -
 * aber ein Tipp auf "Kalender" in der Tab-Leiste, die Seitenleiste, die
 * Befehlspalette oder Zurueck warfen dieselbe Anordnung wortlos weg. Diese
 * Rueckfrage haengt als Verlassen-Schutz am Router (utils/leave-guard.js) und
 * ist DIESELBE wie beim Abbrechen: ohne Aenderung kein Dialog, mit Aenderung
 * "Verwerfen?" - und ein Nein bleibt auf der Seite.
 *
 * Rein und mit gereichten Abhaengigkeiten, damit ein Test sie fahren kann.
 * @returns {Promise<boolean>} ob der Wechsel weitergehen darf
 */
async function customizeLeaveAllowed({ customizing, changed, askDiscard, discard }) {
  if (!customizing()) return true;
  if (changed()) {
    const confirmed = await askDiscard();
    // Im Dialog kann der Modus schon beendet worden sein (gespeichert):
    // dann gibt es nichts mehr zu verlieren, und der Wechsel darf.
    if (!confirmed && customizing()) return false;
  }
  discard();
  return true;
}

function customizeHasChanges({ widgetConfig, savedWidgetConfig, glanceVisible, savedGlanceVisible }) {
  return !sameWidgetConfig(savedWidgetConfig, widgetConfig)
    || Boolean(glanceVisible) !== Boolean(savedGlanceVisible);
}

/**
 * Ein Selektor, der „dasselbe" Element nach einem Neuaufbau wiederfindet.
 *
 * Die Flaeche wird bei jeder Anpassen-Geste per setHtml neu gebaut; Elemente
 * ueberleben das nicht, ihre IDENTITAET schon: eine Id, oder eines der
 * data-Attribute, mit denen die Bearbeiten-Knoepfe ihre Kachel nennen. Wo das
 * Attribut die Kachel nicht selbst nennt (Groesse, Verschieben, Griff), grenzt
 * die umgebende Kachel es ein.
 */
const FOCUS_IDENTITY_ATTRS = [
  'data-widget-size-preset', 'data-widget-size-menu', 'data-widget-move', 'data-widget-drag-handle',
  'data-widget-hide', 'data-widget-show', 'data-widget-options',
  'data-glance-hide', 'data-glance-show',
];

function focusKeyOf(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.hasAttribute('data-timeline-event')) return timelineFocusKeyOf(el);
  const attr = FOCUS_IDENTITY_ATTRS.find((a) => el.hasAttribute(a));
  if (!attr) return rowFocusKeyOf(el);
  const value = el.getAttribute(attr);
  const own = value ? `[${attr}="${CSS.escape(value)}"]` : `[${attr}]`;
  const tile = el.closest('.widget-wrapper[data-widget-id]')?.dataset.widgetId;
  return tile ? `.widget-wrapper[data-widget-id="${CSS.escape(tile)}"] ${own}` : own;
}

/**
 * Dasselbe fuer eine INHALTSZEILE (#1821): Termin, Notiz, Liste, Aufgabe.
 *
 * Die Flaeche baut nicht nur im Anpassen-Modus neu, sondern auch still - bei
 * der Rueckkehr in den Tab, im Viertelstundentakt, an einer Tagesgrenze, nach
 * dem Wetter. Wer mit der Tastatur auf einer Zeile stand, stand danach auf
 * <body>, und Enter tat nichts mehr. Eine Zeile hat keine Id; ihre Identitaet
 * ist, wohin sie fuehrt (`data-route`, bei Aufgaben `data-task-id`), in welcher
 * Kachel sie steht und - wo mehrere Zeilen dasselbe Ziel haben (Schichtplan,
 * Mahlzeiten) - die wievielte sie ist. Der Fokus kann auch auf einem Kind
 * liegen (der Notizkoerper traegt den Tabstopp, die Karte den Weg).
 *
 * `preventScroll`: der stille Neuaufbau darf niemanden zu einer Zeile
 * zurueckholen, von der er weggescrollt hat.
 */
function rowFocusKeyOf(el) {
  const row = el.closest?.('[data-route], [data-task-id]');
  if (!row) return null;
  const quoted = (name, value) => `[${name}="${CSS.escape(value)}"]`;
  let own = row.hasAttribute('data-task-id')
    ? quoted('data-task-id', row.getAttribute('data-task-id'))
    : quoted('data-route', row.getAttribute('data-route'));
  if (row.dataset.objectKind && row.dataset.objectId) {
    own += quoted('data-object-kind', row.dataset.objectKind) + quoted('data-object-id', row.dataset.objectId);
  }
  if (el !== row) {
    const cls = el.classList?.[0];
    if (!cls) return null;
    own += ` .${CSS.escape(cls)}`;
  }
  const tile = row.closest('.widget-wrapper[data-widget-id]')?.dataset.widgetId;
  const selector = tile ? `.widget-wrapper[data-widget-id="${CSS.escape(tile)}"] ${own}` : own;
  const root = row.closest('#dashboard-shell') ?? row.ownerDocument;
  const index = Math.max(0, [...root.querySelectorAll(selector)].indexOf(el));
  return { selector, index, preventScroll: true };
}

/** Zeilen, die EIN Objekt nennen: Aufgabe, Termin, Notiz, Geburtstag. */
const OBJECT_ROW_SELECTOR = '[data-task-id], [data-object-id], [data-route*="?open="]';

/** Die sichtbaren Objektzeilen der Flaeche, je die aeusserste. */
function shownObjectRows(shell) {
  const hits = [...(shell?.querySelectorAll?.(OBJECT_ROW_SELECTOR) ?? [])];
  return hits
    .filter((el) => !hits.some((other) => other !== el && other.contains(el)))
    .filter((el) => !el.hidden && el.getClientRects?.().length !== 0);
}

/**
 * Die sichtbaren Objektzeilen der Kacheln, ohne das Heute-Blatt: das passt
 * seine Zeilen nach jedem Aufbau neu ein (am Telefon auf den ersten Schirm,
 * breit als Zeitleiste) - was dort nach dem Abgleich neu steht, ist meist
 * nur nachgerueckt, nicht angekommen.
 */
function shownTileRows(shell) {
  return shownObjectRows(shell).filter((row) => row.closest('.widget-wrapper[data-widget-id]'));
}

/** Die Schluessel (rowFocusKeyOf) der sichtbaren Kachelzeilen - fuer rowsArriving. */
function shownRowKeys(shell) {
  return new Set(shownTileRows(shell).map((row) => rowFocusKeyOf(row)?.selector).filter(Boolean));
}

/**
 * Welche Kachelzeilen nach einem stillen Neuaufbau neu dazukamen (U2): die
 * eben ueber der Uebersicht angelegte Aufgabe, der Termin, die angepinnte
 * Notiz. Sie ziehen ein wie im Modul (`expandIn`, list-motion: "die
 * eingefuegte klappt ein") - das Gegenstueck zu rowsLeaving. Hoechstens drei:
 * mehr ist kein Ankommen, sondern ein neuer Stand (ein neuer Tag, ein anderes
 * Geraet), und der steht still da wie bisher.
 *
 * @param {Element} shell      die Flaeche nach dem Neuaufbau
 * @param {Set<string>} known  shownRowKeys(shell) davor
 * @returns {Element[]}
 */
function rowsArriving(shell, known) {
  if (!known?.size) return [];
  const fresh = shownTileRows(shell).filter((row) => {
    const key = rowFocusKeyOf(row)?.selector;
    return Boolean(key) && !known.has(key);
  });
  return fresh.length <= ROWS_ARRIVING_MAX ? fresh : [];
}
const ROWS_ARRIVING_MAX = 3;

/**
 * Welche sichtbaren Objektzeilen der Flaeche das naechste Markup nicht mehr
 * nennt (DW-P1-2) - die schliessen per `collapseRow`, bevor neu gezeichnet
 * wird. Wiedererkannt wird eine Zeile am Schluessel, mit dem auch der Fokus
 * den Neuaufbau ueberlebt (rowFocusKeyOf: Ziel, Objekt, Kachel). Gelesen wird
 * das naechste Markup in einem traegen Dokument: dort laedt kein Bild und
 * laeuft kein Skript. Schon ausgeblendete Zeilen (das Rueckgaengig-Fenster
 * eines Loeschens) haben nichts mehr zu schliessen.
 *
 * @param {Element} shell     die Flaeche vor dem Neuaufbau
 * @param {string} nextHtml   ihr Markup aus dem neuen Stand
 * @returns {Element[]}
 */
function rowsLeaving(shell, nextHtml, doc = typeof document === 'undefined' ? null : document) {
  if (!shell?.querySelectorAll || typeof doc?.implementation?.createHTMLDocument !== 'function') return [];
  const rows = shownObjectRows(shell);
  if (!rows.length) return [];
  const next = doc.implementation.createHTMLDocument('');
  next.body.insertAdjacentHTML('afterbegin', nextHtml);
  return rows.filter((row) => {
    const key = rowFocusKeyOf(row);
    return Boolean(key) && !next.querySelector(key.selector);
  });
}

/**
 * EIN BLOCK DER ZEITLEISTE (Critique 2026-10-26, Lauf 2). Er hat weder Id noch
 * Ziel, und nach jedem stillen Neuaufbau (Minutentakt, Beginn eines Termins)
 * stand der Fokus auf <body>. Sein Schluessel ist der Eintrag und die Stelle
 * unter den Bloecken desselben Eintrags - ein Termin fuer zwei steht in zwei
 * Spuren, und der Fokus bleibt in der eigenen.
 */
function timelineFocusKeyOf(el) {
  const selector = `[data-timeline-event="${CSS.escape(el.getAttribute('data-timeline-event'))}"]`;
  const root = el.closest('#dashboard-shell') ?? el.ownerDocument;
  const index = Math.max(0, [...(root?.querySelectorAll?.(selector) ?? [])].indexOf(el));
  return { selector, index, preventScroll: true };
}

/**
 * DER FOKUS UEBERLEBT DEN WECHSEL DER BUEHNE (Critique 2026-10-26, Lauf 2).
 * Zieht man das Fenster ueber 900px Blattbreite, baut die Uebersicht neu
 * (createPhoneProgramFit), und was eben fokussiert war, gibt es auf der neuen
 * Buehne nicht: breit steht ein Termin als Block, schmal als Zeile. Danach
 * stand der Fokus auf <body>. Die Ersatzkandidaten, wenn das Element selbst
 * nicht wiederkommt: zum Block die Zeile mit demselben Ziel (die aufgeklappte
 * Zeile des Blocks nennt es), dann der Tab-Stopp der Leiste, zuletzt der Kopf
 * des Blatts.
 * @returns {Array<string|object>} Kandidaten fuer restoreFocusAfterRebuild
 */
function todayFocusFallbacks(active) {
  const sheet = active?.closest?.('.today-cockpit');
  if (!sheet) return [];
  const key = active.getAttribute?.('data-timeline-event');
  const detail = key == null ? null : [...sheet.querySelectorAll('[data-timeline-detail]')].find((row) => row.dataset.timelineDetail === key);
  const route = detail?.querySelector('[data-route]')?.getAttribute('data-route');
  return [
    ...(route ? [{ selector: `.today-cockpit__rows [data-route="${CSS.escape(route)}"]`, index: 0, preventScroll: true }] : []),
    '.today-timeline [data-timeline-event]:not([tabindex="-1"])',
    '#today-cockpit-title',
  ];
}

/**
 * VOR dem Neuaufbau: wer hat den Fokus, und unter welchem Schluessel findet
 * man ihn danach wieder? Nur ein Element IN der Flaeche zaehlt - ein Dialog
 * oder die Navigation behalten ihren Fokus ohnehin.
 *
 * @returns {{key: (string|object|null), had: boolean}}
 */
function captureRebuildFocus(shell, active, body) {
  const had = Boolean(active) && active !== body && Boolean(shell?.contains(active));
  return { key: had ? focusKeyOf(active) : null, had };
}

/**
 * NACH dem Neuaufbau: der erste Kandidat, den es gibt und der bedienbar ist,
 * bekommt den Fokus. Ein Kandidat ist ein Selektor (erster Treffer gilt: Ids,
 * Bearbeiten-Knoepfe, der Nachfolger, den eine Geste nennt) oder der Schluessel
 * einer Inhaltszeile mit Selektor UND Stelle (rowFocusKeyOf) - der kommt ohne
 * Scrollen zurueck, weil der stille Neuaufbau niemanden zu einer Zeile holen
 * darf, von der er weggescrollt hat.
 *
 * @returns {Element|null} das fokussierte Element
 */
function restoreFocusAfterRebuild(container, candidates) {
  for (const candidate of (candidates ?? []).filter(Boolean)) {
    const isRow = typeof candidate !== 'string';
    const el = isRow
      ? container.querySelectorAll(candidate.selector)[candidate.index]
      : container.querySelector(candidate);
    // Ein Knopf, der bei dieser Breite nicht gerendert ist (Anpassen mobil im
    // Menue, R19), nimmt keinen Fokus - weiter zum naechsten Kandidaten.
    if (el && !el.disabled && el.getClientRects?.().length !== 0) {
      if (isRow) el.focus({ preventScroll: candidate.preventScroll });
      else el.focus();
      return el;
    }
  }
  return null;
}

/* EINE ANSAGE-REGION, DIE DEN NEUAUFBAU UEBERLEBT.
 *
 * Eine Live-Region wird nur gehoert, wenn es sie schon gab, bevor ihr Text sich
 * aendert - eine, die mit dem Neuaufbau selbst entsteht, schweigt in der Regel.
 * Die Seite baut aber bei jeder Anpassen-Geste und bei jedem Timer-Wechsel neu.
 * Gesprochen wird deshalb ueber den Ansager der Shell (`#route-announcer`,
 * router.js): hoeflich, atomar, sr-only und fuer die ganze Sitzung da. Er meldet
 * sonst Seitenwechsel - eine Zustandsaenderung dieser Seite ist dieselbe Sorte
 * Nachricht. Leeren und verzoegert setzen ist sein eigenes Muster: derselbe Text
 * zweimal hintereinander waere sonst keine Aenderung. */
let announceTimer = null;
function announceDashboard(message) {
  const region = typeof document === 'undefined' ? null : document.getElementById('route-announcer');
  if (!region || !message) return;
  clearTimeout(announceTimer);
  region.textContent = '';
  announceTimer = setTimeout(() => { region.textContent = message; }, 50);
}

/* DIE KACHELN GLEITEN, STATT ZU SPRINGEN (FLIP, Critique 2026-09-26).
 *
 * Eine Anpassen-Geste aendert die Lage von Kacheln; bis hierher sprang das
 * Raster dabei in einem Frame auf den neuen Stand - wer eine Kachel eine Stelle
 * hoch schob oder breiter machte, musste sie danach suchen. Jetzt: vor der
 * Aenderung die Lage jeder Kachel merken (First), danach die neue messen (Last),
 * die Kachel per transform auf die alte Stelle zuruecksetzen (Invert) und per
 * Web Animations nach Hause laufen lassen (Play). Die Identitaet traegt die
 * Widget-Id; seit DW-P2-1 ueberleben die Knoten die Geste ohnehin
 * (patchCustomize), aber ein Neuaufbau ersetzt sie weiter.
 *
 * Eine Kachel, die waechst, deckt ihre neue Flaeche per clip-path von der alten
 * Groesse aus auf; eine, die schrumpft, kann nicht ueber ihren Rand hinaus
 * zeigen und blendet ihren umgebrochenen Inhalt kurz auf. Eine wieder
 * eingeblendete Kachel kommt ohne Vorlage und blendet ein.
 *
 * DIE KURVE IST `--ease-out`, NICHT DIE GLASFEDER (DW-P2-2). Die Kachel lief
 * auf `--ease-glass` und schoss dabei 9 % ueber ihr Ziel (gemessen 35 px beim
 * Verschieben, 53 px beim Aus-/Einblenden) - eine Feder gehoert dem Glas, das
 * man greift (Blatt-Eintritt, Schalter), nicht dem Inhalt, der sich ordnet.
 * Dauer `--duration-lg` wie das Raster beim Betreten (playGridShift).
 *
 * UNTER REDUZIERTER BEWEGUNG BLENDET, WAS SICH BEWEGT HAETTE (DW-P3-9): kein
 * Weg, aber auch kein stummer Sprung - 0,4 -> 1 in `--duration-sm`, das Muster
 * von swapContent. So sieht man, WELCHE Kacheln die Geste getroffen hat.
 *
 * Gemessen wird in Viewport-Koordinaten: scrollt der Fokus-Nachfolger die Seite
 * mit, ist genau das der Weg, den das Auge gesehen hat. Laeuft noch eine
 * Animation, liefert die Vorher-Messung ihre momentane Lage - die naechste
 * Geste setzt dort an, wo die Kachel gerade IST; die laufende wird vor der
 * Nachher-Messung beendet, sonst laege ihr Versatz im Ziel. Erst alles lesen,
 * dann alles schreiben: eine Auslegung fuer das ganze Raster. */
const DASHBOARD_TILE_SELECTOR = '#dashboard-widget-grid > .widget-wrapper[data-widget-id]';

function captureTileRects(root) {
  const rects = new Map();
  root.querySelectorAll(DASHBOARD_TILE_SELECTOR).forEach((tile) => {
    rects.set(tile.dataset.widgetId, tile.getBoundingClientRect());
  });
  return rects;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Das Raster gleitet von seiner alten Oberkante an die neue - beim Betreten und
 * Verlassen des Anpassen-Modus. Nur `transform`, Dauer und Kurve aus den Tokens,
 * ohne Feder (ein Versatz ueber hunderte Pixel wuerfe sie sichtbar ueber das
 * Ziel); unter reduzierter Bewegung und ohne messbaren Versatz geschieht nichts.
 * Der Endzustand steht vor dem Aufruf: die Animation hat kein `fill`.
 */
function playGridShift(root, topBefore, options = {}) {
  const reduced = options.reduced ?? prefersReducedMotion();
  if (topBefore == null || reduced) return null;
  const grid = root.querySelector('#dashboard-widget-grid');
  if (!grid || typeof grid.animate !== 'function') return null;
  const dy = topBefore - grid.getBoundingClientRect().top;
  if (Math.abs(dy) < 1) return null;
  return grid.animate([
    { transform: `translateY(${dy}px)` },
    { transform: 'none' },
  ], { duration: durationToken('--duration-lg', 250), easing: easingToken('--ease-out', 'ease-out') });
}

// Die laufende Gleitbewegung je Kachel - die naechste Geste beendet sie.
const tileFlips = new WeakMap();

function playTileFlip(root, before, options = {}) {
  return startTileFlip(measureTileFlip(root, before, options));
}

/**
 * Der lesende Teil des Gleitens: alte gegen neue Lage je Kachel. Getrennt vom
 * Abspielen, damit ein Aufrufer (patchCustomize) weitere Lesungen an DIESELBE
 * Auslegung haengen kann, bevor die Animationen den Stil wieder anfassen.
 */
function measureTileFlip(root, before, options = {}) {
  const reduced = options.reduced ?? prefersReducedMotion();
  if (!before) return null;
  const tiles = [...root.querySelectorAll(DASHBOARD_TILE_SELECTOR)].filter((tile) => typeof tile.animate === 'function');
  // Nur eine LAUFENDE beenden: ein cancel() auf einer fertigen verlangte
  // trotzdem eine neue Stilrechnung, bevor gemessen werden kann.
  for (const tile of tiles) {
    const running = tileFlips.get(tile);
    if (running && running.playState !== 'finished' && running.playState !== 'idle') running.cancel?.();
  }
  const plans = [];
  for (const tile of tiles) {
    const from = before.get(tile.dataset.widgetId);
    if (!from) {
      plans.push({ tile, enter: true });
      continue;
    }
    const to = tile.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const dw = to.width - from.width;
    const dh = to.height - from.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dw) < 1 && Math.abs(dh) < 1) continue;
    const radius = !reduced && (dw >= 1 || dh >= 1) && typeof getComputedStyle === 'function'
      ? getComputedStyle(tile).borderTopLeftRadius || '0px' : '0px';
    plans.push({ tile, dx, dy, dw, dh, radius });
  }
  return { reduced, plans };
}

/** Der schreibende Teil: jede Kachel laeuft von der gemessenen Lage nach Hause. */
function startTileFlip(measured) {
  if (!measured) return [];
  const { reduced, plans } = measured;
  const timing = {
    duration: reduced ? durationToken('--duration-sm', 150) : durationToken('--duration-lg', 250),
    easing: easingToken('--ease-out', 'ease-out'),
  };
  return plans.map(({ tile, enter, dx, dy, dw, dh, radius }) => {
    let keyframes;
    if (reduced) {
      keyframes = [{ opacity: SWAP_FROM_OPACITY }, { opacity: 1 }];
    } else if (enter) {
      keyframes = [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }];
    } else {
      const first = { transform: `translate(${dx}px, ${dy}px)` };
      const last = { transform: 'none' };
      if (dw >= 1 || dh >= 1) {
        first.clipPath = `inset(0px ${Math.max(0, dw)}px ${Math.max(0, dh)}px 0px round ${radius})`;
        last.clipPath = `inset(0px 0px 0px 0px round ${radius})`;
      } else if (dw <= -1 || dh <= -1) {
        first.opacity = 0.6;
        last.opacity = 1;
      }
      keyframes = [first, last];
    }
    const anim = tile.animate(keyframes, timing);
    tileFlips.set(tile, anim);
    return anim;
  });
}

/* EINE GESTE HAENGT KNOTEN UM, STATT SIE NEU ZU BAUEN (DW-P2-1).
 *
 * `moveBefore()` verschiebt einen Knoten, ohne ihn aus dem Baum zu nehmen:
 * Fokus, laufende Animationen und offene Popover bleiben. Ohne die Methode
 * (Safari) bleibt das klassische Entfernen-und-Einfuegen - den Fokus holt
 * patchCustomize danach zurueck. Ein Knoten, der noch nicht im Dokument
 * haengt (eine neu eingeblendete Kachel), geht immer den klassischen Weg:
 * moveBefore nimmt ihn nicht an. */
function placeBefore(parent, node, ref) {
  if (node.isConnected && typeof parent.moveBefore === 'function') {
    try {
      parent.moveBefore(node, ref);
      return;
    } catch { /* anderer Wurzelbaum - dann der klassische Weg */ }
  }
  parent.insertBefore(node, ref);
}

/**
 * Bringt die Kinder von `parent` in die Folge `nodes`: was fehlt, geht; was
 * schon an seinem Platz steht, wird nicht angefasst. Ein Tausch zweier
 * Nachbarn ist so EINE Bewegung, keine zweiundzwanzig.
 */
function arrangeChildren(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const at = parent.children[index] ?? null;
    if (at !== node) placeBefore(parent, node, at);
  });
}

/** Der erste bedienbare Kandidat (Selektoren in Reihenfolge) - nur gelesen, nicht fokussiert. */
function focusTarget(root, candidates) {
  for (const selector of candidates ?? []) {
    const el = selector ? root.querySelector(selector) : null;
    if (el && !el.disabled && el.getClientRects?.().length !== 0) return el;
  }
  return null;
}

/** Wie weit `scrollIntoView({ block: 'nearest' })` die Ansicht schoebe - ohne zu schieben. */
function nearestScrollDelta(rect, view) {
  if (rect.top < view.top) return rect.top - view.top;
  if (rect.bottom > view.bottom) return Math.min(rect.bottom - view.bottom, rect.top - view.top);
  return 0;
}

/** Elemente aus Markup, im Dokument der Seite geparst (nicht im Dokument eines <template>). */
function elementsFromHtml(html) {
  const holder = document.createElement('div');
  holder.insertAdjacentHTML('afterbegin', html);
  return [...holder.children];
}

/** Was eine Kachel neu zeichnen laesst: Groesse und Optionen. */
function tileDrawKey(w) {
  return `${w?.size}|${JSON.stringify(w?.options ?? null)}`;
}

/* EINE ERWEITERUNG ZEICHNET IHRE KACHEL SELBST (Review p11, B4). Ihr Koerper
 * ist bei jeder Groesse und jeder Option derselbe Platzhalter, den erst
 * mountExtensionWidgets mit { size, options } fuellt - der Vergleich des
 * Markups sah darum nie eine Aenderung, und die Kachel zeigte nach einer
 * Geste im Anpassen-Modus den alten Inhalt in der neuen Groesse. Gerufen nur,
 * wenn sich Groesse oder Optionen geaendert haben (`tileDrawKey`). */
function tileBodyChanged(w, body, drawn) {
  return body !== drawn || isExtensionWidget(w?.id);
}

/**
 * Was das Heute-Blatt und die Kennzahlreihe neu rechnen laesst: welche Kacheln
 * sichtbar sind, ihre Optionen und das Kopfband - nicht Reihenfolge oder
 * Groesse. Ein Verschieben rechnet so keines von beiden (Kein-Echo-Regel).
 */
function visibilityKey(cfg, glanceVisible) {
  return [...cfg].map((w) => `${w.id}:${w.visible ? 1 : 0}:${JSON.stringify(w.options ?? null)}`).sort().join('|') + `|${glanceVisible ? 1 : 0}`;
}

/**
 * Die Leiste einer Kachel folgt der Geste AN ORT UND STELLE: Hoch/Runter am
 * Rand gesperrt, die aktive Groesse gedrueckt. Neu gezeichnet waere der
 * Knopf, den man gerade gedrueckt hat, ein anderer - und der Fokus fort.
 * Nur das mobile Groessen-Menue wechselt ganz, wenn sich die Breite geaendert
 * hat (es bietet die Hoehen bei gleicher Breite an, renderWidgetSizeMenu) -
 * die Breite waehlt man am Desktop, wo dieses Menue nicht steht.
 * @returns {Element|null} das neu gezeichnete Menue (fuer seine Zeichen)
 */
function syncCustomizeControls(wrapper, w, index, total) {
  const controls = wrapper.querySelector(':scope > [data-widget-controls]');
  if (!controls) return null;
  const moves = [
    ...controls.querySelectorAll('[data-widget-move]'),
    ...[...controls.querySelectorAll('.popover-menu > template')].flatMap((tpl) => [...tpl.content.querySelectorAll('[data-widget-move]')]),
  ];
  for (const btn of moves) {
    const off = btn.dataset.widgetMove === 'up' ? index === 0 : index === total - 1;
    if (btn.disabled !== off) btn.disabled = off;
  }
  const active = nearestPreset(w.size);
  for (const btn of controls.querySelectorAll('.widget-edit-controls__size > [data-widget-size-preset]')) {
    const on = btn.dataset.widgetSizePreset === active;
    btn.classList.toggle('is-active', on);
    if (btn.getAttribute('aria-pressed') !== String(on)) btn.setAttribute('aria-pressed', String(on));
  }
  const menu = controls.querySelector('.widget-edit-controls__size-menu');
  if (!menu) return null;
  const items = [...menu.querySelectorAll('[data-widget-size-preset]')];
  if (!items.some((item) => item.dataset.widgetSizePreset === active)) {
    const [next] = elementsFromHtml(renderWidgetSizeMenu(w.id, active));
    menu.replaceWith(next);
    return next;
  }
  for (const item of items) {
    const on = item.dataset.widgetSizePreset === active;
    if (item.getAttribute('aria-checked') === String(on)) continue;
    item.setAttribute('aria-checked', String(on));
    item.querySelector('.popover-menu__item-check')?.classList.toggle('popover-menu__item-check--hidden', !on);
  }
  const mini = menu.querySelector('.widget-edit-controls__size-trigger > .widget-size-mini');
  if (mini && mini.dataset.size !== active) {
    mini.replaceChildren();
    mini.insertAdjacentHTML('afterbegin', renderSizeMiniGridCells(active));
    mini.dataset.size = active;
  }
  return null;
}

function widgetSizeClass(size) {
  return WIDGET_SIZE_OPTIONS.includes(size) ? `widget-size--${size}` : 'widget-size--1x1';
}

function renderSizeMiniGrid(size) {
  // `data-size`: woran syncCustomizeControls erkennt, ob die Form noch stimmt.
  return `<span class="widget-size-mini" aria-hidden="true" data-size="${esc(size)}">${renderSizeMiniGridCells(size)}</span>`;
}

function renderSizeMiniGridCells(size) {
  // 2x2-Basisraster statt 4x4: die vier Presets unterscheiden sich nur in
  // Breite/Höhe 1 vs. 2 - auf 16 winzigen Zellen war das kaum ablesbar und
  // die Buttons wirkten identisch (Audit A1-17).
  const [cols, rows] = size.split('x').map(Number);
  return Array.from({ length: 4 }, (_, i) => {
    const col = (i % 2) + 1;
    const row = Math.floor(i / 2) + 1;
    return `<span class="${col <= Math.min(cols, 2) && row <= Math.min(rows, 2) ? 'is-active' : ''}"></span>`;
  }).join('');
}

/* WIDGET-OPTIONEN (#814) - was ein Widget zeigt, nicht nur ob und wie gross.
 *
 * DIE OPTIONEN GEHOEREN DEM FRONTEND, wie die Widget-Ids seit jeher: der Server
 * speichert `options` als Form und weiss nicht, was drinsteht (preferences.js,
 * `normalizeWidgetOptions`). Eine serverseitige Registry „welches Widget kennt
 * welche Option" waere der billige Anfang und danach der Preis jedes weiteren
 * Widgets. Was der Browser daraus macht, sind Query-Parameter, die die Route
 * ohnehin versteht - kein zweiter Filterweg.
 *
 * WARUM EIN EIGENER DIALOG statt eines weiteren Steuerelements in der Leiste:
 * die Kachelleiste traegt Griff, Reihenfolge, vier Groessen und Ausblenden; eine
 * Kategorienauswahl daneben kippt sie auf 1x1-Kacheln ins Ueberlaufen (die
 * Lehre aus dem alten Groessen-Select, Critique P1). Der Knopf oeffnet, was
 * Platz braucht.
 */

/* Das Etikett einer Kategorie - dieselbe Regel wie im Aufgabenmodul
 * (`catLabel` in pages/tasks.js): die mitgelieferten Kategorien tragen einen
 * i18n-Schluessel, die selbst angelegten ihren Namen. Wer hier `key` anzeigt,
 * stellt „household" neben „Einkaufen" in dieselbe Liste. */
function taskCategoryLabel(category) {
  if (!category) return '';
  return category.label_key ? t(category.label_key) : (category.name || category.key);
}

/** Kategorien der Aufgaben - nur wenn der Dialog sie braucht, und nur einmal. */
let taskCategoriesCache = null;
async function loadTaskCategories() {
  if (taskCategoriesCache) return taskCategoriesCache;
  try {
    const res = await api.get('/tasks/categories');
    taskCategoriesCache = Array.isArray(res?.data) ? res.data : [];
  } catch {
    taskCategoriesCache = [];
  }
  return taskCategoriesCache;
}

/** Waste-Typen fuer den Optionen-Dialog - nur wenn er sie braucht, und nur einmal. Wie loadTaskCategories(). */
let wasteTypesCache = null;
async function loadWasteTypes() {
  if (wasteTypesCache) return wasteTypesCache;
  try {
    const res = await api.get('/waste/types');
    wasteTypesCache = Array.isArray(res?.data) ? res.data : [];
  } catch {
    wasteTypesCache = [];
  }
  return wasteTypesCache;
}

/**
 * Die Einkaufslisten fuer den Optionen-Dialog (#1818). Bewusst OHNE Cache und
 * mit `null` im Fehlerfall, wie bei den Notiz-Kategorien: eine eben angelegte
 * Liste muss waehlbar sein, und ein Dialog ohne Katalog darf eine bestehende
 * Auswahl nicht als "nichts gewaehlt" speichern.
 */
async function loadShoppingLists(getLists = (path) => api.get(path)) {
  try {
    const res = await getLists('/shopping');
    return Array.isArray(res?.data) ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * Die waehlbaren Kalender fuer den Optionen-Dialog der Kalender-Kachel (#2062):
 * eigene, synchronisierte und Abos, unter dem Schluessel des Kalendermoduls.
 * Sie stehen als `sources` neben den eigenen Kalendern von
 * `/calendar/calendars`. Ohne Cache und mit `null` im Fehlerfall, wie die
 * Einkaufslisten: ein Dialog ohne Katalog darf eine bestehende Auswahl nicht
 * als "nichts gewaehlt" speichern.
 */
async function loadCalendarSources(getSources = (path) => api.get(path)) {
  try {
    const res = await getSources('/calendar/calendars');
    return Array.isArray(res?.sources) ? res.sources : null;
  } catch {
    return null;
  }
}

async function loadNoteCategories(getCategories = (path) => api.get(path)) {
  try {
    const res = await getCategories('/notes/categories');
    return Array.isArray(res?.data) ? res.data : null;
  } catch {
    return null;
  }
}

/** Generic options dialog for extension widgets (optionsSchema from module.json). */
async function openExtensionWidgetOptions(id, meta, current = {}) {
  const schema = meta.optionsSchema || {};
  const moduleId = meta.moduleId || String(id).split(':')[0];
  const fields = Object.entries(schema).map(([key, field]) => {
    const val = current[key] ?? field.default ?? '';
    const title = esc(optionFieldLabel(moduleId, field, key));
    if (field.type === 'boolean') {
      return `<label class="widget-options__choice">
        <input type="checkbox" name="opt-${esc(key)}" ${val ? 'checked' : ''}>
        <span>${title}</span>
      </label>`;
    }
    if (field.type === 'number') {
      return `<label class="form-group"><span class="form-label">${title}</span>
        <input class="form-input" type="number" name="opt-${esc(key)}" value="${esc(String(val))}"></label>`;
    }
    if (Array.isArray(field.enum) && field.enum.length) {
      return `<label class="form-group"><span class="form-label">${title}</span>
        <select class="form-input" name="opt-${esc(key)}">
          ${field.enum.map((opt) => `<option value="${esc(opt)}" ${String(val) === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        </select></label>`;
    }
    return `<label class="form-group"><span class="form-label">${title}</span>
      <input class="form-input" type="text" name="opt-${esc(key)}" value="${esc(String(val ?? ''))}"></label>`;
  }).join('');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title: t('dashboard.optionsFor', { widget: widgetLabel(id) }),
      size: 'sm',
      content: `
        <form id="widget-options-form" class="widget-options">
          ${fields || `<p class="widget-options__hint">${t('dashboard.optionExtensionEmpty')}</p>`}
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" data-action="cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
        panel.querySelector('#widget-options-form')?.addEventListener('submit', (event) => {
          event.preventDefault();
          const next = {};
          for (const [key, field] of Object.entries(schema)) {
            const el = panel.querySelector(`[name="opt-${CSS.escape(key)}"]`);
            if (!el) continue;
            if (field.type === 'boolean') {
              if (el.checked) next[key] = true;
            } else if (field.type === 'number') {
              const num = Number(el.value);
              if (Number.isFinite(num)) next[key] = num;
            } else {
              const text = el.value.trim();
              if (text) next[key] = text;
            }
          }
          finish(Object.keys(next).length ? next : {});
          closeModal({ force: true });
        });
      },
    });
  });
}

/** Der Optionen-Dialog eines Widgets. Aufloesen mit den neuen Optionen oder null. */
async function openWidgetOptions(id, current = {}, {
  loadNotes = loadNoteCategories, loadLists = loadShoppingLists, loadCalendars = loadCalendarSources,
} = {}) {
  const extMeta = getExtensionWidgetMeta(id);
  if (extMeta?.optionsSchema) return openExtensionWidgetOptions(id, extMeta, current);

  const options = { ...current };
  const categories = id === 'tasks'
    ? await loadTaskCategories()
    : id === 'notes' ? await loadNotes() : [];
  const wasteTypes = id === 'waste' ? await loadWasteTypes() : [];
  // A missing catalog is different from a valid empty catalog. Closing with
  // null makes the caller preserve current options instead of saving `{}` and
  // silently erasing an existing category filter after a transient failure.
  if (id === 'notes' && categories === null) {
    window.yuvomi?.showToast(t('dashboard.loadError'), 'danger');
    return null;
  }
  const shoppingLists = id === 'shopping' ? await loadLists() : [];
  if (shoppingLists === null) {
    window.yuvomi?.showToast(t('dashboard.loadError'), 'danger');
    return null;
  }
  // Angehakt ist, was gespeichert UND noch da ist: eine geloeschte Liste hat
  // keine Zeile mehr und faellt mit dem naechsten Speichern aus der Auswahl.
  const pickedLists = new Set(normalizeShoppingListSelection(options.lists));
  // Dieselbe Regel fuer die Kalender (#2062): angehakt ist, was gespeichert UND
  // noch im Katalog ist; ein entfernter Kalender faellt mit dem Speichern weg.
  const calendarChoices = id === 'calendar' ? await loadCalendars() : [];
  if (calendarChoices === null) {
    window.yuvomi?.showToast(t('dashboard.loadError'), 'danger');
    return null;
  }
  const pickedCalendars = new Set(normalizeCalendarSelection(options.calendars));

  const body = id === 'calendar'
    ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionCalendarScope')}</legend>
        <label class="widget-options__choice">
          <input type="radio" name="cal-scope" value="all" ${options.scope === 'mine' ? '' : 'checked'}>
          <span>${t('dashboard.optionCalendarAll')}</span>
        </label>
        <label class="widget-options__choice">
          <input type="radio" name="cal-scope" value="mine" ${options.scope === 'mine' ? 'checked' : ''}>
          <span>${t('calendar.assignedToMe')}</span>
        </label>
      </fieldset>
      ${/* Erst ab zwei Kalendern eine Wahl: mit einem gaebe es nichts zu
            waehlen, und die Gruppe waere eine Zeile, die nichts aendert. */ ''}
      ${calendarChoices.length > 1 ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${esc(t('dashboard.optionCalendarCalendars'))}</legend>
        <p class="widget-options__hint">${esc(t('dashboard.optionCalendarCalendarsHint'))}</p>
        ${calendarChoices.map((source) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="cal-calendar" value="${esc(String(source.key))}"
                 ${pickedCalendars.has(source.key) ? 'checked' : ''}>
          <span>${esc(source.name)}</span>
        </label>`).join('')}
      </fieldset>` : ''}
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('calendar.filtersLayers')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionCalendarBirthdaysHint')}</p>
        <label class="widget-options__choice">
          <input type="checkbox" name="cal-birthdays" ${options.birthdays === 'hide' ? '' : 'checked'}>
          <span>${t('calendar.toggleBirthdays')}</span>
        </label>
      </fieldset>
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionCalendarLimit')}</legend>
        <p class="widget-options__hint">${esc(t('dashboard.optionCalendarLimitHint', { size: t('dashboard.widgetSizeWide'), small: t('dashboard.widgetSizeTiny') }))}</p>
        ${EVENT_LIMIT_STEPS.map((step) => `
        <label class="widget-options__choice">
          <input type="radio" name="cal-limit" value="${step}" ${clampEventLimit(options.limit) === step ? 'checked' : ''}>
          <span>${esc(getNumberFormat().format(step))}</span>
        </label>`).join('')}
      </fieldset>`
    : id === 'waste'
    ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionWasteTypes')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionWasteTypesHint')}</p>
        ${wasteTypes.length ? wasteTypes.map((wt) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="waste-type" value="${wt.id}"
                 ${(options.types ?? []).includes(wt.id) ? 'checked' : ''}>
          <span>${esc(wt.name)}</span>
        </label>`).join('') : `<p class="widget-options__hint">${t('dashboard.optionWasteTypesEmpty')}</p>`}
      </fieldset>`
    : id === 'shopping' ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionShoppingLists')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionShoppingListsHint')}</p>
        ${shoppingLists.length ? shoppingLists.map((list) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="shopping-list" value="${esc(String(list.id))}"
                 ${pickedLists.has(Number(list.id)) ? 'checked' : ''}>
          <span>${esc(list.name)}</span>
        </label>`).join('') : `<p class="widget-options__hint">${t('dashboard.noShoppingLists')}</p>`}
      </fieldset>`
    : id === 'tasks' ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionTaskCategories')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionTaskCategoriesHint')}</p>
        ${categories.length ? categories.map((c) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="task-category" value="${esc(c.key)}"
                 ${(options.categories ?? []).includes(c.key) ? 'checked' : ''}>
          <span>${esc(taskCategoryLabel(c))}</span>
        </label>`).join('') : `<p class="widget-options__hint">${t('dashboard.optionTaskCategoriesEmpty')}</p>`}
      </fieldset>`
    : `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('noteCategories.categories')}</legend>
        <p class="widget-options__hint">${t('noteCategories.widgetHint')}</p>
        ${categories.length ? categories.map((category) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="note-category" value="${category.id}"
                 ${(options.categories ?? []).map(Number).includes(Number(category.id)) ? 'checked' : ''}>
          <span><i data-lucide="${category.scope === 'personal' ? 'user' : 'home'}" aria-hidden="true"></i>${esc(noteCategoryName(category))}<span class="sr-only"> (${esc(noteCategoryScope(category))})</span></span>
        </label>`).join('') : `<p class="widget-options__hint">${t('noteCategories.empty')}</p>`}
      </fieldset>`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title: t('dashboard.optionsFor', { widget: widgetLabel(id) }),
      size: 'sm',
      content: `
        <form id="widget-options-form" class="widget-options">
          ${body}
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" data-action="cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        panel.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal({ force: true }));
        panel.querySelector('#widget-options-form').addEventListener('submit', (event) => {
          event.preventDefault();
          const next = {};
          if (id === 'calendar') {
            const scope = panel.querySelector('input[name="cal-scope"]:checked')?.value;
            // „Alles" ist die Abwesenheit einer Einschraenkung und wird deshalb
            // nicht gespeichert - sonst stuende in jedem Layout ein Feld, das
            // den Auslieferungszustand wiederholt.
            if (scope === 'mine') next.scope = 'mine';
            // Dasselbe eine Zeile tiefer, nur andersherum notiert: gespeichert
            // wird das ABWAEHLEN, nicht das Haekchen (#927).
            if (!panel.querySelector('input[name="cal-birthdays"]')?.checked) next.birthdays = 'hide';
            // Und die Stufe (#1680): gespeichert wird nur, was von der Vorgabe
            // abweicht, als Zahl und durch die Klemme - ein Wert, den es im
            // Dialog nicht gibt, kommt so auch nicht ins Layout.
            const limit = clampEventLimit(panel.querySelector('input[name="cal-limit"]:checked')?.value);
            if (limit !== EVENT_LIMIT_DEFAULT) next.limit = limit;
            // Keine Auswahl heisst „alle Kalender" und wird nicht gespeichert (#2062).
            const calendars = normalizeCalendarSelection(
              [...panel.querySelectorAll('input[name="cal-calendar"]:checked')].map((el) => el.value),
            );
            if (calendars.length) next.calendars = calendars;
          } else if (id === 'waste') {
            const picked = [...panel.querySelectorAll('input[name="waste-type"]:checked')].map((el) => Number(el.value));
            // Dieselbe Regel wie bei den Aufgaben-Kategorien: keine Auswahl
            // heisst „alle" - eine seltene Abholung darf nie stillschweigend
            // verschwinden, nur weil niemand den Dialog geoeffnet hat.
            if (picked.length) next.types = picked;
          } else if (id === 'shopping') {
            // Keine Auswahl heisst „alle Listen" und wird nicht gespeichert -
            // das Verhalten von vor der Option (#1818).
            const picked = normalizeShoppingListSelection(
              [...panel.querySelectorAll('input[name="shopping-list"]:checked')].map((el) => el.value),
            );
            if (picked.length) next.lists = picked;
          } else if (id === 'tasks') {
            const picked = [...panel.querySelectorAll('input[name="task-category"]:checked')].map((el) => el.value);
            // Keine Auswahl heisst „alle" - eine leere Liste als Filter waere
            // ein leeres Dashboard fuer jemanden, der nur den Dialog geoeffnet hat.
            if (picked.length) next.categories = picked;
          } else {
            const picked = [...panel.querySelectorAll('input[name="note-category"]:checked')]
              .map((el) => el.value);
            if (picked.length) next.categories = picked;
          }
          finish(next);
          closeModal({ force: true });
        });
      },
    });
  });
}

/* DIE GROESSE GLEITET WIE JEDES SEGMENT (Kanon D1, utils/segment-indicator.js).
 * Die Kapsel misst ihren Eintrag; je Kachel einmal Layout lesen, darum erst
 * nach dem naechsten Bild - der Moduswechsel und die Geste stehen dann schon,
 * und bis dahin traegt das aktive Segment seine eigene Flaeche (`.is-active`).
 * Unter 768px ist das Segment aus (dort waehlt das Menue), also auch keine
 * Kapsel. Eine Leiste, die mit ihrer Kachel geht, raeumt sich selbst ab. */
function attachSizeIndicators(root, signal) {
  if (!root || typeof requestAnimationFrame !== 'function') return;
  if (!globalThis.matchMedia?.('(min-width: 768px)').matches) return;
  requestAnimationFrame(() => setTimeout(() => {
    if (signal?.aborted || !root.isConnected) return;
    for (const bar of root.querySelectorAll('.widget-edit-controls__size:not(.has-seg-indicator)')) {
      attachSegmentIndicator(bar);
    }
  }, 0));
}

/** Name und Massangabe einer Groesse: „Breit (2×1)" -> „Breit" + „(2×1)".
 *  Jede Sprache fuehrt ihre Groessen so (test:dashboard-clarity haelt das
 *  Format); ohne Klammer bleibt der ganze Text der Name. */
function sizeLabelParts(label) {
  const match = /^(.*\S)\s*(\([^()]*\))$/u.exec(label);
  return match ? { name: match[1], dims: match[2] } : { name: label, dims: '' };
}

function renderWidgetCustomizeControls(w, index = 0, total = 1) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const activeSize = nearestPreset(w.size);

  /* DIE GROESSE IST EIN BESCHRIFTETES SEGMENT (DW-P2-9). Vier Mini-Raster ohne
   * Text verlangten, die Form zu deuten; man las die Wahl erst am Tooltip.
   * Jetzt traegt jedes Segment den Namen der Groesse („Klein", „Breit",
   * „Hoch", „Quadrat"), die Massangabe liest nur der Screenreader mit - der
   * Name des Knopfs ist damit derselbe wie im Menue und in der Ansage, und
   * der sichtbare Text steht an seinem Anfang (WCAG 2.5.3). Die Wahl zeigt
   * die Kachel selbst; das Segment sagt nur, welche es ist. */
  const sizeButtons = WIDGET_SIZE_PRESETS.map((p) => {
    const active = p.value === activeSize;
    const { name, dims } = sizeLabelParts(t(p.labelKey));
    return `<button type="button" class="segmented__item${active ? ' is-active' : ''}"
              data-widget-size-preset="${p.value}" data-widget-id="${esc(w.id)}"
              aria-pressed="${active ? 'true' : 'false'}">${esc(name)}${dims ? `<span class="sr-only"> ${esc(dims)}</span>` : ''}</button>`;
  }).join('');

  // Die Leiste steht VOR der Ueberschrift der Kachel. Ohne eigenen Namen hoerte
  // man per Tab je Kachel denselben Griff und dieselben Groessen - welche Kachel
  // man anfasst, sagt erst die Gruppe.
  //
  // DER GRIFF STEHT AM ENDE (DW-P2-3), wie in jeder sortierbaren Zeile der App
  // (Schnellzugriffe #2152, Mitglieder, Navigation): erst was die Kachel IST
  // (Groesse, Optionen, Auge), dann woran man sie zieht. Er ist der Griff fuer
  // SortableJS (makeSortable in wireDashboardEditMode) - per Maus und per
  // Finger - und der Tastaturweg (Pfeil hoch/runter). Die Handlungen stehen
  // als EINE Gruppe hinter dem Segment: reicht die Breite nicht, bricht die
  // Gruppe als Ganzes in die zweite Zeile, statt den Griff allein zu lassen.
  return `
    <div class="widget-edit-controls" role="group" aria-label="${esc(widgetLabel(w.id))}" data-widget-controls>
      <span class="widget-edit-controls__caption" aria-hidden="true">${esc(widgetLabel(w.id))}</span>
      <div class="widget-edit-controls__size segmented" role="group" aria-label="${esc(t('dashboard.customizeSizeFor', { widget: widgetLabel(w.id) }))}">
        ${sizeButtons}
      </div>
      <div class="widget-edit-controls__actions">
        <div class="widget-edit-controls__move">
          <button type="button" class="widget-edit-controls__move-btn" data-widget-move="up" data-widget-id="${esc(w.id)}"
                  ${isFirst ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveUp')}">
            <i data-lucide="chevron-up" aria-hidden="true"></i>
          </button>
          <button type="button" class="widget-edit-controls__move-btn" data-widget-move="down" data-widget-id="${esc(w.id)}"
                  ${isLast ? 'disabled' : ''} aria-label="${t('dashboard.customizeMoveDown')}">
            <i data-lucide="chevron-down" aria-hidden="true"></i>
          </button>
        </div>
        ${renderWidgetSizeMenu(w.id, activeSize)}
        ${renderWidgetOptionsButton(w)}
        ${renderWidgetTileMenu(w, index, total)}
        <button type="button" class="widget-edit-controls__hide" data-widget-hide="${esc(w.id)}" aria-label="${esc(t('dashboard.customizeHide', { widget: widgetLabel(w.id) }))}">
          <i data-lucide="eye-off" aria-hidden="true"></i>
        </button>
        <button type="button" class="widget-edit-controls__handle" data-widget-drag-handle
                aria-label="${t('dashboard.customizeReorderHandle')}" aria-keyshortcuts="ArrowUp ArrowDown">
          <i data-lucide="grip-vertical" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;
}

/* DAS OPTIONEN-MENUE DER KACHEL, AN JEDER KACHEL (U7, WCAG 2.5.7). Am Zeiger
 * ordnete man eine Kachel nur per Ziehen am Griff oder per Pfeiltaste um -
 * Hoch und Runter stehen nur am Finger (DW-P2-3). Wer die Maus fuehrt, aber
 * nicht ziehen kann, hatte keinen Weg. Jetzt steht an jeder Kachel EIN Menue
 * mit "Nach vorn" und "Nach hinten" (ein Platz in der Lesereihenfolge, wie
 * Hoch/Runter) und, wo die Kachel welche hat, ihren Optionen - der Regler-Knopf,
 * der dafuer allein stand, ist sein Ausloeser (dieselbe Form wie das Menue am
 * Chip der Ablage, R22 D16). Am Rand ist der Eintrag gesperrt, nicht weg (Kanon
 * des Menues, layout.css: "nach oben" an der ersten Kategorie). Die Eintraege
 * entstehen erst beim Oeffnen (`defer`); `syncCustomizeControls` haelt ihre
 * Sperre auch im ungeoeffneten Menue richtig. */
/* AM FINGER IST DER OPTIONEN-KNOPF WIEDER EIN TIPP (U10, Ulas 2026-10-27).
 * Mit U7 oeffnete der Regler-Knopf ein Menue, und die Optionen standen dort
 * als dritter Eintrag: am Telefon zwei Tipps fuer die haeufigere Handlung,
 * damit am Zeiger "Nach vorn"/"Nach hinten" einen Ort haben. Am Finger
 * brauchen sie ihn nicht - dort stehen Hoch und Runter in der Leiste. Darum
 * zwei Ausloeser, und die Zeigerart entscheidet, welcher steht (dashboard.css):
 * am Finger dieser Knopf (nur an Kacheln mit Optionen), am Zeiger das Menue.
 * Derselbe Handler (`[data-widget-options]`), dieselbe Form, derselbe Name
 * wie der Eintrag im Menue. */
function renderWidgetOptionsButton(w) {
  if (!widgetHasOptions(w.id)) return '';
  return `<button type="button" class="widget-edit-controls__options widget-edit-controls__options--direct" data-widget-options="${esc(w.id)}"
            aria-label="${esc(t('dashboard.optionsFor', { widget: widgetLabel(w.id) }))}">
      <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
    </button>`;
}

function renderWidgetTileMenu(w, index = 0, total = 1) {
  const label = widgetLabel(w.id);
  const hasOptions = widgetHasOptions(w.id);
  const items = [
    { action: 'widget-move', icon: 'chevron-up', label: t('dashboard.customizeMoveForward'), disabled: index === 0,
      attrs: { 'data-widget-move': 'up', 'data-widget-id': w.id } },
    { action: 'widget-move', icon: 'chevron-down', label: t('dashboard.customizeMoveBack'), disabled: index === total - 1,
      attrs: { 'data-widget-move': 'down', 'data-widget-id': w.id } },
    ...(hasOptions ? [
      { separator: true },
      { action: 'widget-options', icon: 'sliders-horizontal', label: t('dashboard.optionsFor', { widget: label }), attrs: { 'data-widget-options': w.id } },
    ] : []),
  ];
  return `<div class="widget-edit-controls__menu">${popoverMenuHtml({
    id: `widget-tile-menu-${w.id}`,
    label: t('common.moreActionsNamed', { name: label }),
    icon: 'ellipsis',
    triggerClass: 'widget-edit-controls__options',
    defer: true,
    items,
  })}</div>`;
}

/* EIN GROESSEN-MENUE MIT NUR WIRKSAMEN GROESSEN (R9 M7, A7 P1-2).
 *
 * Unter 768px ist das Raster EINE Spalte (dashboard.css, `.dashboard__grid`),
 * und dort aendert die Breite einer Kachel nichts: 1x1 und 2x1 sehen gleich
 * aus, 1x2 und 2x2 auch. Die vier Groessenknoepfe boten mobil also zwei
 * Wahlen doppelt an und kosteten dafuer eine zweite Zeile je Kachel (114px
 * Bedienleiste). Dort steht deshalb dieses Menue: ein Knopf mit der aktuellen
 * Form, darin die zwei Hoehen bei gleicher Breite - die Breite bleibt, wie sie
 * am Desktop gewaehlt wurde, weil sie nur dort wirkt. Welche der beiden Formen
 * sichtbar ist, entscheidet dieselbe Grenze wie das Raster (dashboard.css).
 * Die Eintraege tragen `data-widget-size-preset` wie die Knoepfe und laufen
 * durch denselben Handler. */
function renderWidgetSizeMenu(id, activeSize) {
  const width = activeSize.split('x')[0] === '2' ? '2' : '1';
  const panelId = `widget-size-menu-${id}`;
  const label = t('dashboard.customizeSizeFor', { widget: widgetLabel(id) });
  const items = WIDGET_SIZE_PRESETS.filter((p) => p.value.startsWith(`${width}x`)).map((p) => {
    const checked = p.value === activeSize;
    return `
        <button type="button" role="menuitemradio" aria-checked="${checked}" class="popover-menu__item widget-size-menu__item"
                data-widget-size-preset="${p.value}" data-widget-id="${esc(id)}">
          ${renderSizeMiniGrid(p.value)}
          <span>${esc(t(p.labelKey))}</span>
          <i data-lucide="check" class="icon-md popover-menu__item-trail popover-menu__item-check${checked ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
        </button>`;
  }).join('');
  return `
      <div class="widget-edit-controls__size-menu">
        <button type="button" class="widget-edit-controls__size-trigger popover-menu__trigger" data-widget-size-menu="${esc(id)}"
                popovertarget="${esc(panelId)}" aria-haspopup="menu" aria-expanded="false"
                aria-label="${esc(label)}" title="${esc(label)}">
          ${renderSizeMiniGrid(activeSize)}
        </button>
        <div class="popover-menu" id="${esc(panelId)}" popover role="menu">${items}
        </div>
      </div>`;
}

// Wieder-Einblenden-Leiste: schließt die Einbahnstraße des Inline-Modus. Ein im
// Edit-Modus ausgeblendetes Widget landet als Chip hier und lässt sich mit einem
// Klick zurückholen — so ist der Inline-Editor allein vollständig (Zeigen +
// Verstecken + Größe + Reihenfolge) und das frühere zweite Editor-Modal entfällt.
function renderHiddenWidgetsTray(cfg, glanceHidden = false) {
  const hidden = cfg.filter((w) => !w.visible && allWidgetIds().includes(w.id) && isWidgetModuleEnabled(w.id));
  if (!hidden.length && !glanceHidden) return '';
  // Das Kopfband steht mit in dieser Leiste, obwohl es keine Rasterkachel ist:
  // ausgeblendet waere es sonst nur ueber „Zuruecksetzen" zurueckzuholen.
  const glanceChip = glanceHidden ? `
    <button type="button" class="widget-restore-chip" data-glance-show
            aria-label="${t('dashboard.customizeShow', { widget: t('dashboard.todayTitle') })}">
      <i data-lucide="sun" class="widget-restore-chip__icon" aria-hidden="true"></i>
      <span class="widget-restore-chip__label">${t('dashboard.todayTitle')}</span>
      <i data-lucide="plus" class="widget-restore-chip__add" aria-hidden="true"></i>
    </button>` : '';
  /* DIE OPTIONEN MUESSEN AUCH AM AUSGEBLENDETEN WIDGET ERREICHBAR SEIN (#814).
   * Aufgaben und Kalender sind ab Werk ausgeblendet - das Cockpit deckt ihre
   * vier Domaenen bereits ab -, und ihre Optionen wirken trotzdem auf die ganze
   * Seite: das Cockpit und das Kopfband sprechen ueber dieselben Aufgaben.
   * Ohne diesen Knopf muesste man die Kachel erst einblenden, um einzustellen,
   * was die Kachel gar nicht zeigt. Deshalb eine Gruppe statt eines Chips: ein
   * Knopf im Knopf waere kein gueltiges Markup.
   *
   * DIE OPTIONEN STEHEN AM CHIP, IN EINEM MENUE MIT WORT (R22 D16). Bis R21
   * stand neben vier der Chips ein freier Regler-Kreis ohne Wort - 17 Chips
   * und vier unbeschriftete Knoepfe, die keiner einem Chip zuordnete. Jetzt
   * ist der Chip ein geteilter Knopf: links „einblenden" mit einem Tipp wie
   * bisher, rechts am selben Pill ein Pfeil mit dem Menue „<Kachel>
   * einblenden" und „Optionen fuer <Kachel>". */
  const chips = glanceChip + hidden.map((w) => {
    const label = widgetLabel(w.id);
    const menu = widgetHasOptions(w.id) ? popoverMenuHtml({
      id: `widget-restore-menu-${w.id}`,
      label: t('common.moreActionsNamed', { name: label }),
      icon: 'chevron-down',
      triggerClass: 'widget-restore-chip__more',
      items: [
        { action: 'widget-show', icon: 'plus', label: t('dashboard.customizeShow', { widget: label }), attrs: { 'data-widget-show': w.id } },
        { action: 'widget-options', icon: 'sliders-horizontal', label: t('dashboard.optionsFor', { widget: label }), attrs: { 'data-widget-options': w.id } },
      ],
    }) : '';
    return `
    <div class="widget-restore-chip-group${menu ? ' widget-restore-chip-group--split' : ''}">
      <button type="button" class="widget-restore-chip" data-widget-show="${esc(w.id)}"
              aria-label="${esc(t('dashboard.customizeShow', { widget: label }))}">
        <i data-lucide="${widgetIcon(w.id)}" class="widget-restore-chip__icon" aria-hidden="true"></i>
        <span class="widget-restore-chip__label">${esc(label)}</span>
        <i data-lucide="plus" class="widget-restore-chip__add" aria-hidden="true"></i>
      </button>${menu}
    </div>`;
  }).join('');
  return `
    <section class="widget-restore" aria-label="${t('dashboard.customizeHiddenTitle')}">
      <h3 class="widget-restore__title">${t('dashboard.customizeHiddenTitle')}</h3>
      <div class="widget-restore__chips">${chips}</div>
    </section>
  `;
}

/* DIE KACHELN EINZELN ZEICHENBAR (DW-P2-1). Das Raster zeichnet sie alle, eine
 * Anpassen-Geste nur die, die sie aendert (patchCustomize in render()) - aus
 * DENSELBEN drei Teilen, damit Geste und Aufbau nie zwei Fassungen einer Kachel
 * zeichnen: die Renderer je Widget, der Koerper einer Kachel, ihr Rahmen. */
function dashboardTileRenderers(cfg, data, weather, currency, { visibleMealTypes = MEAL_ORDER, glanceHidden = false, familyManage = null } = {}) {
  return {
    tasks: (size) => renderUrgentTasks(data.urgentTasks ?? [], data.openTaskCount, size),
    calendar: (size, options) => renderCalendarWidget(data, size, options),
    birthdays: (size) => renderUpcomingBirthdays(data.birthdays ?? [], size, data.birthdayTotal),
    countdown: (size) => renderCountdowns(data.countdowns ?? [], size, data.countdownTotal),
    budget: (size) => renderBudgetWidget(data.budget ?? {}, currency, size),
    rewards: (size) => renderRewardsWidget(data.rewards ?? {}, size),
    health: (size) => renderHealthWidget(data.health ?? {}, size),
    cycle: (size) => renderCycleWidget(data.cycle, size),
    fasting: (size) => renderFastingWidget(data.fasting, size),
    nutrition: (size) => renderNutritionWidget(data.nutrition, size),
    housekeeping: (size) => renderHousekeepingWidget(data.housekeeping ?? {}, currency, size),
    schedule: (size) => renderScheduleWidget(data.schedule, data.users ?? [], size),
    waste: (size) => renderWasteWidget(data.waste, size),
    pantry: (size) => renderPantryWidget(data.pantryExpiring, size),
    family: (size) => renderFamilyWidget(data.users ?? [], data, { manageHref: familyManage, size }),
    meals: (size) => renderTodayMeals(data.todayMeals ?? [], visibleMealTypes, data.users, size),
    notes: (size) => renderPinnedNotes(data.pinnedNotes ?? [], size, data.notesTotal),
    shopping: (size) => renderShoppingTile(data, size),
    // Hier ankommen heisst eingerichtet (`isWidgetModuleEnabled`); fehlt das
    // Wetter trotzdem, sagt die Kachel es, statt zu verschwinden.
    weather: (size) => (weather ? renderWeatherWidget(weather, size) : renderWeatherUnavailable(size)),
    clock: (size) => renderClockWidget({ size }),
    quicklinks: (size) => renderQuickLinks(data.quicklinks ?? [], size),
    // Die Kachelreihe braucht als einziges Widget zu wissen, wer sonst noch
    // dasteht - sie ist die einzige, die fremde Zahlen zeigt. Gerechnet aus
    // DERSELBEN Bedingung, nach der die Kacheln gleich gefiltert werden, damit
    // die beiden nicht auseinanderlaufen; `metrics` selbst ist ausgenommen, es
    // waere sonst sein eigener Grund zu schweigen.
    // Dazu, welche Zahl das Heute-Blatt schon nennt (offene Freigaben): die
    // Kein-Echo-Regel gilt auch zwischen Blatt und Kachel. Ein ausgeblendetes
    // Blatt nennt nichts.
    metrics: (size) => renderMetricTiles(data, currency, new Set(
      cfg.filter((w) => w.visible && w.id !== 'metrics' && isWidgetModuleEnabled(w.id)).map((w) => w.id),
    ), glanceHidden ? new Set() : todaySheetSpeaks(data, cfg), size),
  };
}

/** Steht die Kachel im Raster? (Sichtbar, Modul an, ein Renderer da.) */
function dashboardTileListed(w, renderers) {
  return Boolean(w.visible && isWidgetModuleEnabled(w.id) && (renderers[w.id] || isExtensionWidget(w.id)));
}

/** Der Koerper einer Kachel; leer heisst: keine Kachel (der Renderer hat nichts). */
function renderWidgetBody(w, renderers) {
  try {
    if (isExtensionWidget(w.id)) {
      return `<div class="widget extension-widget-mount" data-extension-widget-mount="1">
            ${widgetEmptyHtml(t('common.loading'))}
          </div>`;
    }
    return renderers[w.id](w.size, w.options);
  } catch (err) {
    console.error(`[dashboard] Widget "${w.id}" konnte nicht gerendert werden`, err);
    return renderWidgetError(w.id);
  }
}

/** Der Rahmen um den Koerper: Groesse, Id, im Anpassen-Modus die Leiste.
 *  Kein `draggable="true"` (DW-P2-3): gezogen wird ueber SortableJS am Griff,
 *  und das DOM-Attribut schaltete natives Ziehen ein, das ihm die Geste nimmt. */
function renderWidgetWrapper(w, html, { editing = false, index = 0, total = 1 } = {}) {
  return `<div class="widget-wrapper ${widgetSizeClass(w.size)} ${editing ? 'widget-wrapper--editing' : ''}"
                   data-widget-id="${esc(w.id)}"${tileSpanWrapperAttrs(html)}>
        ${editing ? renderWidgetCustomizeControls(w, index, total) : ''}
        ${html}
      </div>`;
}

function renderDashboardLayout(cfg, data, weather, currency, { editing = false, visibleMealTypes = MEAL_ORDER, glanceHidden = false, familyManage = null, drawn = null, bodies = null } = {}) {
  const widgetById = dashboardTileRenderers(cfg, data, weather, currency, { visibleMealTypes, glanceHidden, familyManage });

  const tiles = cfg
    .filter((w) => dashboardTileListed(w, widgetById))
    .map((w, index, arr) => {
      const html = renderWidgetBody(w, widgetById);
      if (!html) return '';
      // Was wirklich im Raster steht - die Vorhersage des Skeletts (rememberGridHint),
      // samt der Hoehe aus den Daten (U1 b).
      drawn?.push(w);
      drawnSpanRows.set(w.id, tileSpanOf(html)?.rows ?? 0);
      // Und was die naechste Geste nicht neu zeichnen muss (patchCustomize).
      bodies?.set(w.id, html);
      return renderWidgetWrapper(w, html, { editing, index, total: arr.length });
    })
    .join('');

  // Alle Widgets ausgeblendet: kein toter Screen, sondern ein Hinweis zurück
  // in die Anpassung (das Cockpit oben bleibt als Orientierung erhalten).
  const gridInner = tiles
    || emptyHintHTML(t('dashboard.allWidgetsHidden'), { icon: 'layout-dashboard' });
  // Dicht gepackt in jedem Zustand (dashboard.css, `.dashboard__grid`): die
  // Reihenfolge ist die Rangfolge, kein Schalter mehr fuer umsortierte Layouts.
  /* DAS RASTER HAT SEINE EIGENE UEBERSCHRIFT (Critique 2026-09-23). Ohne sie
   * hingen alle Widget-h3 unter der h2 „Heute wichtig" - wer per Ueberschriften
   * navigiert, hielt Budget, Wetter und Notizen fuer Teile des Kopfbands, und
   * wer das Kopfband ausblendet, hatte gar keine h2 mehr ueber ihnen. Sichtbar
   * waere sie ein drittes Etikett ueber Kacheln, die ihre eigenen Koepfe tragen;
   * gebraucht wird sie nur als Gliederungsebene. Das Wort ist dasselbe, das die
   * Anpassen-Leiste benutzt („Widgets anpassen", „Ausgeblendete Widgets"). */
  const heading = `<h2 class="sr-only" id="dashboard-widgets-title">${esc(t('dashboard.widgetsHeading'))}</h2>`;
  // Fuer welche Buehne die Kacheln gezeichnet sind (createPhoneProgramFit):
  // am Telefon ohne Spannen und mit kurzen Listen, breit mit beidem.
  const grid = `<div class="dashboard__grid ${editing ? 'dashboard__grid--editing' : ''}" id="dashboard-widget-grid"
                    data-tile-stage="${onPhoneStage() ? 'phone' : 'wide'}"
                    role="region" aria-labelledby="dashboard-widgets-title">${gridInner}</div>`;
  // Im Bearbeiten-Modus steht die Wieder-Einblenden-Leiste UEBER dem Raster
  // (R14, A7 P2-2), wie die Widget-Galerie in iOS: mobil lag der Vorrat mit 14
  // Chips unter 3924px Raster, und wer eine Kachel zurueckholen wollte, musste
  // an allen anderen vorbei. Sie bleibt der Ausweg aus der Sackgasse
  // „ausgeblendet", nur jetzt am Anfang des Wegs.
  return `${heading}${editing ? `${renderHiddenWidgetsTray(cfg, glanceHidden)}${grid}` : grid}`;
}

/* DAS SKELETT VERSPRICHT DAS LAYOUT, DAS GLEICH KOMMT (Critique R1, A10).
 * Es zeichnete das Standard-Raster, waehrend die eigene Anordnung erst mit
 * `/preferences` eintrifft - wer sein Dashboard umgebaut hatte, sah beim Laden
 * jedes Mal fremde Kacheln aufblitzen und dann umspringen. Ein Ladezustand,
 * der etwas anderes zeigt als das Ergebnis, ist kein Platzhalter, sondern ein
 * kurzer falscher Bildschirm.
 *
 * Der Cache ist bewusst duenn: nur Sichtbarkeit und Groesse, also genau das,
 * was die Kachelform bestimmt. Er ist eine VORHERSAGE, keine Quelle - die
 * Wahrheit bleibt die Serverantwort, und ein veralteter oder kaputter Eintrag
 * faellt still auf den Standard zurueck.
 *
 * Er liegt in utils/dashboard-layout-hint.js, weil er seit #585 auch beim
 * Abmelden verworfen werden muss - die Begruendung steht dort. */

function renderDashboardSkeleton(user = null, { head = null } = {}) {
  // Mit den Hoehen aus den Daten (U1 b): jede Kachel steht schon im Skelett so
  // hoch, wie sie beim letzten Zeichnen war - auch die Kalenderliste mit acht
  // oder zwoelf Terminen (#2087).
  const defaults = buildDefaultWidgetConfig().filter((w) => w.visible && isWidgetModuleEnabled(w.id));
  const hint = layoutHintTiles(defaults.map((w) => w.size));
  const tiles = hint.sizes
    .map((size, i) => `<div class="widget-wrapper ${widgetSizeClass(size)}"${hint.spans[i] ? ` style="--tile-rows: ${hint.spans[i]}"` : ''}>${skeletonWidget(3)}</div>`)
    .join('');
  return `
    ${renderMastheadSkeleton(user, head)}
    <div class="dashboard__grid">${tiles}</div>
  `;
}

/* DAS SKELETT HAT DIE FORM DER SEITE, NICHT NUR DIE DER KACHELN (DW-P2-5,
 * R22 D4 "Skelette in Zielform"). Es zeichnete zwei Balken und darunter
 * gleich das Raster: kein Gruss, kein Heute-Blatt. Am Telefon stand das
 * Raster bei y 80 und der Inhalt bei y 720, am Desktop 72 gegen 572 - die
 * ganze Seite sprang beim Laden um, und die Rangordnung (Blatt, dann
 * Kacheln) stand im Skelett auf dem Kopf.
 *
 * Jetzt traegt es dieselben Klassen wie der echte Kopf: Datumszeile,
 * Gruss und Werkzeuge in ihren Zeilenboxen (Platzhaltertext in
 * `.skeleton-text`, die Hoehe kommt aus Schrift und Zeilenhoehe), darunter
 * das Blatt mit Kopf und Zeilen - so viele, wie zuletzt in den ersten Schirm
 * passten. Wie hoch das Band zuletzt WIRKLICH war (das Blatt haengt am Tag),
 * weiss `headHint` je Fenstergroesse; mit dem Wert steht das Raster dort, wo
 * es gleich steht. Ohne Wert gilt die Form allein. */
function renderMastheadSkeleton(user, head) {
  // Platzhaltertext, schon maskiert: der Gruss kommt aus greeting() (maskiert den Namen).
  const bar = (html) => `<span class="skeleton skeleton-text">${html}</span>`;
  const sheet = head ? head.sheet : true;
  // Am Telefon so viele Zeilen, wie das Blatt hoechstens zeigt: das Band
  // endet an der gemerkten Hoehe bzw. am Falz (dashboard.css), und was
  // darueber hinausgeht, schneidet die Karte ab - wie das echte Blatt fuellt
  // es den ersten Schirm. Breit: Kopf, Zeitleiste und die naechsten Zeilen,
  // gemessen im Seed etwa fuenf Zeilenhoehen.
  const rows = onPhoneStage() ? PROGRAM_ROW_CAP + 2 : 5;
  const row = `
        <div class="today-cockpit-card today-cockpit-card--skeleton">
          <span class="module-seal today-cockpit-card__icon skeleton"></span>
          <span class="today-cockpit-card__body">
            <strong class="today-cockpit-card__value">${bar(esc(t('dashboard.todayTitle')))}</strong>
            <span class="today-cockpit-card__sub">${bar(esc(t('common.loading')))}</span>
          </span>
        </div>`;
  const sheetHtml = sheet ? `
      <div class="today-cockpit today-cockpit--skeleton">
        <div class="today-cockpit__grid">
          <div class="today-cockpit__header">
            <span class="module-seal today-cockpit__seal skeleton"></span>
            <div class="today-cockpit__heading"><h2>${bar(esc(t('dashboard.todayTitle')))}</h2></div>
          </div>
          <div class="today-cockpit__rows">${row.repeat(Math.max(1, rows))}</div>
        </div>
      </div>` : '';
  const size = head ? ` style="--skeleton-head-size: ${head.px}px"` : '';
  return `
    <section class="dashboard-masthead dashboard-masthead--skeleton${sheet ? '' : ' dashboard-masthead--slim'}" aria-hidden="true"${size}>
      <div class="dashboard-overview">
        <div class="dashboard-overview__header">
          <span class="dashboard-overview__date">${bar(esc(mastheadDateLabel()))}</span>
          <div class="dashboard-overview__title">${bar(greeting(user?.display_name ?? ''))}</div>
          <div class="dashboard-overview__tools">
            <span class="skeleton dashboard-skeleton-tool"></span>
            <span class="skeleton dashboard-skeleton-tool"></span>
            <span class="skeleton dashboard-skeleton-tool dashboard-skeleton-tool--wide"></span>
            ${onDesktopStage() ? '<span class="skeleton dashboard-skeleton-tool dashboard-skeleton-tool--pill"></span>' : ''}
          </div>
        </div>
      </div>${sheetHtml}
    </section>`;
}

// Distinkter Fehlerzustand: verhindert, dass ein Ladefehler wie ein ruhiger,
// leerer Tag aussieht (falsch beruhigend). Bietet einen Retry, der neu lädt.
// Die Meldung unterscheidet Sitzungsablauf (401/403) und Serverfehler (5xx)
// von einem generischen Verbindungsproblem — Retry hilft nicht überall gleich.
function renderDashboardError(status = null) {
  const messageKey = status === 401 || status === 403
    ? 'dashboard.loadErrorSession'
    : (typeof status === 'number' && status >= 500)
      ? 'dashboard.loadErrorServer'
      : 'dashboard.loadError';
  return `
    <div class="dashboard-error" role="alert">
      <i data-lucide="cloud-off" class="dashboard-error__icon" aria-hidden="true"></i>
      <p class="dashboard-error__text">${t(messageKey)}</p>
      <button type="button" class="btn btn--secondary" id="dashboard-retry">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  `;
}

/* DIE FEHLERKACHEL SPRICHT DEN KOPF DER ANDEREN (DW-P3-2). Sie baute ihren
 * eigenen: ein `<span>` als Titel und eine nackte Glyphe - kein Siegel, keine
 * Ueberschrift. Der dritte Kopf-Dialekt der Uebersicht, und am Screenreader
 * fehlte genau diese Kachel in der Ueberschriften-Navigation. Jetzt derselbe
 * `widgetHeader` (h3, Vollton-Siegel ihres Moduls, ohne Link: wohin sie
 * fuehrt, weiss sie im Fehlerfall nicht sicher), darunter die ruhige Zeile mit
 * dem Wiederholen am Ende. Der Rand in Danger-Toenung bleibt das Zeichen
 * "kaputt, nicht leer" (siehe Fehler-Isolation in renderDashboardLayout). */
function widgetErrorSeal(id) {
  return MODULE_FOR_WIDGET[id] ?? (id === 'family' ? 'contacts' : 'dashboard');
}

function renderWidgetError(id) {
  const title = esc(widgetLabel(id));
  return `<div class="widget widget--error" role="alert"${emptySpanAttrs('1x1')}>
    ${widgetHeader(id, title, null, null, null, widgetErrorSeal(id))}
    ${widgetEmptyHtml(t('dashboard.widgetError'), { label: t('common.retry'), icon: 'refresh-cw', attrs: { 'data-widget-retry': id } }, id)}
  </div>`;
}

// --------------------------------------------------------
// Shopping-Widget
// --------------------------------------------------------

/**
 * Was die Einkaufs-Kachel aus der Antwort liest (#1818). Mit einer Auswahl
 * liefert die Route `shoppingTile` - die gewaehlten Listen, die offenen Artikel
 * darin und wie viele gewaehlte Listen es gibt. Ohne Auswahl (oder wenn das
 * Feld fehlt) gelten die Felder, die auch das Heute-Blatt und die Wand lesen.
 * Die Kachel ist der EINZIGE Leser von `shoppingTile`.
 */
function renderShoppingTile(data, size = '2x1') {
  const tile = data?.shoppingTile;
  if (tile && Array.isArray(tile.lists)) {
    return renderShoppingLists(tile.lists, tile.openCount, tile.listCount, size);
  }
  return renderShoppingLists(data?.shoppingLists ?? [], data?.shoppingOpenCount, data?.shoppingOpenLists, size);
}

function renderShoppingLists(lists, openTotal = null, listTotalCount = null, size = '2x1') {
  if (!lists.length) {
    return `<div class="widget widget--shopping"${emptySpanAttrs(size)}>
      ${widgetHeader('shopping', t('nav.shopping'), 0, '/shopping')}
      ${widgetEmptyHtml(t('dashboard.noShoppingLists'), emptyRouteAction('/shopping', t('common.add')), 'shopping')}
    </div>`;
  }

  // Der Server liefert hoechstens drei Listen und zaehlt daneben, woraus sie
  // geschnitten sind (listTotal): ohne Auswahl ueber alle Listen mit Offenem
  // (`shoppingOpenCount`, `shoppingOpenLists`), mit Auswahl ueber die
  // gewaehlten (`shoppingTile.openCount`, `.listCount`). Ohne die Zahlen
  // bleibt es bei der Summe der geladenen Listen.
  const totalOpen = listTotal(openTotal, lists.reduce((sum, l) => sum + l.open_count, 0));
  // "+n weitere Listen" nennt, was der Deckel abschneidet. OHNE Auswahl sind
  // das Listen mit Offenem, und jede gezeigte hat welches. MIT Auswahl (#1818)
  // ist es JEDE gewaehlte Liste, auch eine fertig gekaufte: "eine gewaehlte
  // Liste bleibt stehen" haelt nur, wenn die abgeschnittene als "+1" da ist.
  const moreLists = listTotal(listTotalCount, lists.length) - lists.length;

  const listsHtml = lists.map((list) => {
    const progress = list.total_count > 0
      ? Math.round(((list.total_count - list.open_count) / list.total_count) * 100)
      : 0;

    const itemsHtml = list.items.map((item) => `
      <div class="shopping-widget-item">
        <span class="shopping-widget-item__name">${esc(item.name)}</span>
        ${item.quantity ? `<span class="shopping-widget-item__qty">${esc(item.quantity)}</span>` : ''}
      </div>
    `).join('');

    const moreCount = list.open_count - list.items.length;

    // JEDE ZEILE MEINT EINE LISTE, also fuehrt sie auch dorthin. Ein blankes
    // `/shopping` oeffnet die erste Liste der Einkaufsseite (die aelteste),
    // waehrend die Kachel die zuletzt geaenderte zuerst zeigt - der Tipp auf
    // "Drogerie" landete im Wocheneinkauf. Der Kachelkopf bleibt beim blanken
    // Pfad: er zaehlt ueber mehrere Listen (alle, oder die gewaehlten) und ist
    // der Sammelverweis. Eine inzwischen geloeschte id faellt
    // auf der Einkaufsseite auf die erste Liste zurueck.
    const listRoute = `/shopping?list=${encodeURIComponent(String(list.id))}`;

    return `
      <div class="list-row shopping-widget-list" data-route="${esc(listRoute)}" role="button" tabindex="0">
        <span class="list-row__lead shopping-widget-list__icon" aria-hidden="true"><i data-lucide="${MODULE_ICON.shopping}"></i></span>
        <div class="list-row__main">
        <div class="shopping-widget-list__header">
          <span class="list-row__name shopping-widget-list__name">${esc(list.name)}</span>
          <span class="list-row__end shopping-widget-list__count">${list.total_count - list.open_count}/${list.total_count}</span>
        </div>
        <div class="shopping-widget-list__progress">
          <div class="shopping-widget-list__bar" style="--progress-scale:${progress / 100}"></div>
        </div>
        <div class="shopping-widget-list__items">
          ${itemsHtml}
          ${listMoreLine('dashboard.shoppingMore', moreCount)}
          ${/* Eine AUSGEWAEHLTE Liste steht auch ohne Offenes da (#1818): die
                Zeile bleibt der Weg zu ihr und sagt, warum sie leer ist. */ ''}
          ${list.open_count === 0 ? `<div class="shopping-widget-item shopping-widget-item--more">${esc(t('dashboard.shoppingListNothingOpen'))}</div>` : ''}
        </div>
        </div>
      </div>
    `;
  }).join('');

  /* Je Liste eine zusammengesetzte Zeile (U11): Name und Zahl, Balken, die
   * Artikel in je einer Zeile, ggf. "+N weitere" bzw. "nichts offen". */
  const listPx = (list) => {
    const n = list.items.length;
    return TILE_PARTS.shoppingList + n * TILE_PARTS.shoppingItem + Math.max(0, n - 1) * TILE_PARTS.shoppingItemGap
      + (list.open_count - n > 0 ? TILE_PARTS.shoppingMore : 0) + (list.open_count === 0 ? TILE_PARTS.shoppingNothing : 0);
  };
  const listsPx = lists.reduce((sum, list, i) => sum + listPx(list) + (i ? 1 : 0), 0);
  const span = tileSpanAttrs(() => ({
    body: TILE_GEOMETRY.rowsPad + listsPx + (moreLists > 0 ? TILE_GEOMETRY.more : 0),
  }), size);
  return `<div class="widget widget--shopping"${span}>
    ${widgetHeader('shopping', t('nav.shopping'), totalOpen, '/shopping')}
    <div class="widget__body widget__body--rows">${widgetRows(listsHtml)}${listMoreLine('dashboard.shoppingMoreLists', moreLists)}</div>
  </div>`;
}

// --------------------------------------------------------
// Wetter-Widget
// --------------------------------------------------------

const WEATHER_ICON_BASE = '/api/v1/weather/icon/';

// Geteilte Wetter-Bausteine für Karte UND Masthead-Zeile: Open-Meteo liefert
// Lucide-Icon-Namen + wmo.*-i18n-Keys; OWM (Legacy) liefert OWM-Icon-Codes
// (via /icon-Proxy) + bereits lokalisierten Beschreibungstext. OWM-Legacy kann
// zudem 'standard' (Kelvin) liefern; Open-Meteo nur metric/imperial.
function weatherUnitSymbol(units) {
  return units === 'imperial' ? '°F' : units === 'standard' ? 'K' : '°C';
}

function weatherDescText(weather, desc) {
  return weather?.provider === 'open-meteo' ? t(desc) : desc;
}

function weatherIconHtml(weather, icon, cls, size, desc) {
  if (weather?.provider === 'open-meteo') {
    return `<i data-lucide="${esc(icon)}" class="${cls}" aria-hidden="true"></i>`;
  }
  return `<img class="${cls}" src="${WEATHER_ICON_BASE}${esc(icon)}"
           alt="${esc(desc)}" width="${size}" height="${size}" loading="lazy">`;
}

/**
 * Die Wetterlage als Ton (tokens.css 5b) - sechs Werte, aus dem Icon-Namen
 * abgeleitet und NICHT aus dem Beschreibungstext: der ist lokalisiert und in
 * der OWM-Fassung sogar frei formuliert, das Icon dagegen ist beim selben
 * Provider immer derselbe Schlüssel.
 *
 * BEIDE PROVIDER LAUFEN DURCH DIESELBE FUNKTION, weil sie zwei Schreibweisen
 * für dieselbe Sache liefern: Open-Meteo Lucide-Namen (`cloud-rain`), OWM
 * Legacy dreistellige Codes mit Tag/Nacht-Suffix (`10d`). Zwei Funktionen
 * hätten sich beim nächsten neuen Zustand getrennt.
 *
 * Ein unbekannter Schlüssel liefert bewusst `null`: das Widget fällt dann auf
 * seinen bisherigen Modulton zurück, statt eine falsche Lage zu behaupten.
 */
function weatherToneKey(icon) {
  const key = String(icon || '');
  if (/^\d{2}[dn]$/.test(key)) {
    const code = key.slice(0, 2);
    const night = key.endsWith('n');
    if (code === '01') return night ? 'night' : 'clear';
    if (code === '02') return night ? 'night' : 'clear';
    if (code === '09' || code === '10') return 'rain';
    if (code === '11') return 'storm';
    if (code === '13') return 'snow';
    return 'cloud';                      // 03, 04, 50 (Nebel/Dunst)
  }
  if (key === 'sun') return 'clear';
  if (key === 'cloud-sun') return 'clear';
  if (key === 'moon' || key === 'cloud-moon') return 'night';
  if (key === 'cloud-lightning') return 'storm';
  if (key === 'cloud-snow') return 'snow';
  if (key === 'cloud-rain' || key === 'cloud-drizzle') return 'rain';
  if (key === 'cloud') return 'cloud';
  return null;
}

function weatherToneAttr(icon) {
  const tone = weatherToneKey(icon);
  return tone ? ` data-weather-tone="${tone}"` : '';
}

/**
 * Die Gangart der Glyphe - vier Bewegungen, und jede sagt, was sie zeigt:
 * `rays` dreht die Sonnenstrahlen um ihre Scheibe, `drift` lässt die Wolke
 * ziehen, `fall` schickt Tropfen und Flocken nach unten, `flash` lässt den
 * Blitz aufleuchten. Klare Nacht bekommt keine - ein Mond zieht nicht.
 *
 * WARUM DAS NICHT AM TON HÄNGT: `sun` und `cloud-sun` tragen denselben Ton
 * (Bernstein), bewegen sich aber gegensätzlich. Bei `sun` sind alle `<path>`
 * die Strahlen und dürfen rotieren; bei `cloud-sun` ist die Wolke selbst ein
 * `<path>` und würde mitdrehen. Ein gemeinsames Attribut hätte die beiden
 * genau einmal verwechselt, und zwar sichtbar.
 *
 * Die Bewegung sitzt in Kindknoten der Lucide-SVGs (Strahlen, Tropfen, Blitz),
 * die dort eine feste Reihenfolge haben (v0.469.0: Wolke zuerst, Niederschlag
 * danach). Ändert Lucide seinen Aufbau, greift die Regel nicht mehr und die
 * Glyphe steht still - der schlechtestmögliche Ausgang ist kein Defekt.
 */
function weatherMotionAttr(icon) {
  const key = String(icon || '');
  const owm = /^(\d{2})([dn])$/.exec(key);
  const code = owm?.[1];
  // HIER STAND `key.endsWith('n')` FÜR BEIDE ZWEIGE, und „sun" endet auf n:
  // die Sonne hat ihre Strahlen nie gedreht. Das Tag/Nacht-Suffix ist eine
  // Eigenheit der OWM-Codes und wird deshalb auch nur dort gelesen - aus dem
  // Lucide-Namen kommt es nie.
  if (key === 'sun') return ' data-weather-motion="rays"';
  if (key === 'moon') return '';
  if (code === '01') return owm[2] === 'n' ? '' : ' data-weather-motion="rays"';
  if (key === 'cloud-rain' || key === 'cloud-drizzle' || key === 'cloud-snow'
      || code === '09' || code === '10' || code === '13') {
    return ' data-weather-motion="fall"';
  }
  if (key === 'cloud-lightning' || code === '11') return ' data-weather-motion="flash"';
  if (key === 'cloud' || key === 'cloud-sun' || key === 'cloud-moon'
      || code === '02' || code === '03' || code === '04' || code === '50') {
    return ' data-weather-motion="drift"';
  }
  return '';
}

/**
 * Fünf Temperaturbänder für die Verlaufszeile (tokens.css 5b).
 *
 * DIE SCHWELLEN STEHEN IN DER JEWEILIGEN EINHEIT, nicht als Umrechnung einer
 * Celsius-Zahl: „unter null" ist im Fahrenheit-Haushalt 32 °F und nicht
 * 31,999. Die drei Leitern sind dieselben Grenzen, dreimal ausgeschrieben -
 * eine Umrechnung im Code hätte an den Rundungsstellen andere Bänder ergeben
 * als die Zahl daneben.
 */
const WEATHER_BANDS = ['icy', 'cold', 'mild', 'warm', 'hot'];
const WEATHER_BAND_EDGES = {
  metric:   [0, 10, 20, 28],
  imperial: [32, 50, 68, 82],
  standard: [273, 283, 293, 301],
};

/**
 * `Number(null)` ist 0 und `Number('')` auch - beides sind gueltige
 * Temperaturen, und ein fehlender Wert waere damit stillschweigend zu
 * „0 Grad, also kalt" geworden. Ein Test hat genau das gefunden. Die 0 selbst
 * muss durch: sie ist der haeufigste Winterwert.
 */
function weatherNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function weatherTempBand(temp, units) {
  const value = weatherNumber(temp);
  if (value === null) return null;
  const edges = WEATHER_BAND_EDGES[units] || WEATHER_BAND_EDGES.metric;
  let i = 0;
  while (i < edges.length && value >= edges[i]) i += 1;
  return WEATHER_BANDS[i];
}

// Wetter als Masthead-Zeile (Seele-Paket): beiläufiger Kontext unterm Gruß
// (Apple-Today-Muster) statt einer eigenen Karte - die Karte bleibt als Opt-in
// für Wandtablets im Anpassen-Tray. Kein Echo: ist die Karte sichtbar, reicht
// der Aufrufer kein weather herein und die Zeile entfällt.
function mastheadWeatherHtml(weather, { card = false } = {}) {
  if (!weather?.current) return '';
  const desc = weatherDescText(weather, weather.current.desc);
  // AUCH NEBEN DER KARTE (R19 mobil, seit R24 E7 in jeder Breite): die
  // Kurzzeile unterm Gruss sagt das Jetzt sofort, die Karte weiter unten
  // behaelt die Vorhersage. `--card` markiert nur noch, dass die Karte steht.
  return `
    <p class="dashboard-overview__weather${card ? ' dashboard-overview__weather--card' : ''}"${weatherToneAttr(weather.current.icon)}>
      ${weatherIconHtml(weather, weather.current.icon, 'dashboard-overview__weather-icon', 18, desc)}
      <span>${esc(String(weather.current.temp))}${weatherUnitSymbol(weather.units)} · ${esc(desc)}</span>
    </p>`;
}

/**
 * Wie heisst dieser Vorhersagetag?
 *
 * Aus dem DATUM, nie aus der Position. Die Position war die Falle (#851): der
 * Server trennt den laufenden Tag aus `forecast` heraus, `forecast[0]` ist also
 * morgen - hart als „Heute" beschriftet las sich die Reihe, als fehle ein Tag.
 *
 * Bezugsgroesse ist `weather.today.date`, der Kalendertag AM WETTERORT. Weder die
 * Browser- noch die Haushaltszone taugt dafuer: ein Wetterort darf in einer
 * dritten Zone liegen, und welcher Tag dort gerade laeuft, weiss nur der
 * Provider. Fehlt die Angabe, bleibt es beim Wochentag - lieber kein „Heute" als
 * ein falsches.
 */
function weatherIsToday(weather, dateKey) {
  const ref = weather?.today?.date;
  return Boolean(ref) && dateKey === ref;
}

function weatherDayLabel(weather, dateKey) {
  if (weatherIsToday(weather, dateKey)) return t('common.today');
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short' })
    .format(new Date(`${dateKey}T12:00:00`));
}

/**
 * Hoch und Tief des laufenden Tages, in demselben Vokabular wie die Reihe
 * darunter (semibold Hoch, gedaempftes Tief). Sie stehen im Hauptblock, weil der
 * Hauptblock heute IST - ohne sie trug die Karte fuer jeden Folgetag eine
 * Spanne, fuer heute aber nur den Momentanwert (#851).
 */
function weatherTodayRange(weather, cls) {
  const hi = weatherNumber(weather?.today?.temp_max);
  const lo = weatherNumber(weather?.today?.temp_min);
  if (hi === null || lo === null) return '';
  // Zwei nackte Zahlen nebeneinander sagen vorgelesen nichts - die Auszeichnung
  // traegt die Bedeutung, die das Schriftbild optisch schon hat.
  const aria = esc(t('dashboard.weatherHighLow', { max: hi, min: lo }));
  // `role="img"` und nicht nur `aria-label`: auf einem rollenlosen <span> mit
  // ausschliesslich aria-hidden-Kindern haengt die Auszeichnung an nichts und
  // wird stellenweise gar nicht angesagt (dasselbe Paar wie beim Dosen-Balken
  // und beim Zyklus-Ring weiter oben).
  return `<span class="${cls}" role="img" aria-label="${aria}">
      <span class="${cls}-high" aria-hidden="true">${esc(String(hi))}°</span>
      <span class="${cls}-low" aria-hidden="true">${esc(String(lo))}°</span>
    </span>`;
}

/**
 * Die Tagesspanne der Verlaufszeile, normiert auf die Spanne der GANZEN
 * Vorhersage. Erst dadurch sagt der Balken etwas: eine Zeile aus fünf gleich
 * langen Balken wäre Dekoration, eine Zeile, in der der Mittwoch nach oben
 * rutscht, ist eine Auskunft.
 *
 * Zwei Randfälle, beide gemessen und nicht gedacht: eine flache Woche (alle
 * Tage gleich) ergäbe 0/0 und damit einen unsichtbaren Balken, ein einzelner
 * warmer Tag einen Strich von einem Pixel. Deshalb die Mindestlänge - der
 * Balken bleibt auch dann ein Balken, wenn die Woche nichts zu erzählen hat.
 */
const WEATHER_SPAN_MIN = 0.14;

function weatherSpanModel(forecast) {
  const days = Array.isArray(forecast) ? forecast : [];
  const values = days.flatMap((d) => [weatherNumber(d.temp_min), weatherNumber(d.temp_max)])
    .filter((v) => v !== null);
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return (d) => {
    const min = weatherNumber(d.temp_min);
    const max = weatherNumber(d.temp_max);
    if (min === null || max === null) return null;
    let from = span > 0 ? (min - lo) / span : 0;
    let to   = span > 0 ? (max - lo) / span : 1;
    if (to - from < WEATHER_SPAN_MIN) {
      const mid = (from + to) / 2;
      from = Math.max(0, Math.min(1 - WEATHER_SPAN_MIN, mid - WEATHER_SPAN_MIN / 2));
      to = from + WEATHER_SPAN_MIN;
    }
    return { from, to };
  };
}

/* DER AKTUALISIEREN-KNOPF STEHT IN DER ENDZONE DES KOPFES (DW-P3-3), wo jede
 * andere Kachel ihren "Alle"-Link traegt - als Kopf-Icon-Knopf der Shell
 * (`btn btn--secondary btn--icon`: Ring, Druckbild, Zeiger 40/Finger 48), nicht
 * mehr als grauer Eigenbau-Kreis, der absolut ueber der Karte schwebte und dafuer
 * dem Kopf per z-index das Treffen abringen musste. */
function weatherRefreshButton() {
  return `<button type="button" class="btn btn--secondary btn--icon weather-widget__refresh" id="weather-refresh-btn"
            aria-label="${esc(t('dashboard.weatherRefresh'))}" title="${esc(t('dashboard.weatherRefreshTitle'))}">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
      </button>`;
}

function renderWeatherWidget(weather, size = '2x1') {
  if (!weather) return '';
  // Jetzt-Block mit oder ohne Vorhersage daneben/darunter - eine Hoehe je Groesse.
  const span = tileSpanAttrs((s) => ({ body: TILE_PARTS.weather[nearestPreset(s)] ?? TILE_PARTS.weather['2x1'] }), size);

  const { city, current, forecast, units } = weather;

  const unitSymbol = weatherUnitSymbol(units);
  const windUnit   = units === 'imperial' ? 'mph' : 'km/h';

  const descText = (desc) => weatherDescText(weather, desc);
  const iconHtml = (icon, cls, size, desc) => weatherIconHtml(weather, icon, cls, size, desc);

  const spanOf = weatherSpanModel(forecast);

  const forecastHtml = forecast.map((d, i) => {
    const label = weatherDayLabel(weather, d.date);
    const extraCls = i >= 3 ? ' weather-forecast__day--extended' : '';
    // Der Balken trägt das Band der HÖCHSTtemperatur: sie ist die Zahl, nach
    // der ein Tag eingeschätzt wird ("wird es warm?"), und sie steht daneben.
    const band = weatherTempBand(d.temp_max, units);
    const span = spanOf?.(d);
    const spanHtml = span
      ? `<div class="weather-forecast__span"${band ? ` data-weather-band="${band}"` : ''}
              style="--span-from:${span.from.toFixed(4)};--span-to:${span.to.toFixed(4)}" aria-hidden="true"></div>`
      : '';
    return `
      <div class="weather-forecast__day${extraCls}">
        <div class="weather-forecast__label${weatherIsToday(weather, d.date) ? ' weather-forecast__label--today' : ''}">${esc(label)}</div>
        ${iconHtml(d.icon, 'weather-forecast__icon', 32, descText(d.desc))}
        <div class="weather-forecast__temps">
          <span class="weather-forecast__high">${d.temp_max}°</span>
          <span class="weather-forecast__low">${d.temp_min}°</span>
        </div>
        ${spanHtml}
      </div>`;
  }).join('');

  return `
    <div class="widget widget--weather weather-widget" id="weather-widget"${span}${weatherToneAttr(current.icon)}${weatherMotionAttr(current.icon)}>
      ${widgetHeader('weather', t('dashboard.weather'), null, null, null, 'dashboard', { action: weatherRefreshButton() })}
      <div class="weather-widget__inner">
        <div class="weather-widget__main">
          <div class="weather-widget__left">
            <div class="weather-widget__temp">${esc(current.temp)}${unitSymbol}</div>
            ${weatherTodayRange(weather, 'weather-widget__range')}
            <div class="weather-widget__desc">${esc(descText(current.desc))}</div>
            <div class="weather-widget__city">${esc(city)}</div>
            <div class="weather-widget__meta">
              ${t('dashboard.weatherFeelsLike', { temp: current.feels_like, humidity: current.humidity, wind: current.wind_speed, windUnit })}
            </div>
          </div>
          <span class="weather-widget__glyph">${iconHtml(current.icon, 'weather-widget__icon', 80, descText(current.desc))}</span>
        </div>
        ${forecast.length ? `<div class="weather-forecast">${forecastHtml}</div>` : ''}
      </div>
    </div>`;
}

// Eingerichtet, aber gerade kein Wetter (Anbieter aus, Netz weg). Dieselbe
// Leerzustand-Grammatik wie die uebrigen Kacheln, aber kein `role="alert"` wie
// die Fehlerkachel: das hier ist ein Zustand, den der Nutzer nicht verschuldet
// und nicht beheben muss, und er soll nicht bei jedem Aufbau vorgelesen werden.
// Der Aktualisieren-Knopf bleibt - er ist der Weg zurueck, und
// `wireWeatherRefresh` tauscht die Kachel bei Erfolg aus.
function renderWeatherUnavailable(size = '2x1') {
  return `
    <div class="widget widget--weather weather-widget weather-widget--unavailable" id="weather-widget"${emptySpanAttrs(size)}>
      ${widgetHeader('weather', t('dashboard.weather'), null, null, null, 'dashboard', { action: weatherRefreshButton() })}
      ${widgetEmptyHtml(t('dashboard.weatherUnavailable'))}
    </div>`;
}

// --------------------------------------------------------
// Uhr-Widget (#651)
// --------------------------------------------------------

/**
 * Zeit und Datum für die Uhr. Beides folgt den Formatpräferenzen des Nutzers
 * (12h/24h über formatTime, Datumsreihenfolge über formatDate); der Wochentag
 * kommt aus der Locale davor, weil er auf einem Wandbildschirm die eigentliche
 * Auskunft ist - „welcher Tag ist heute" fragt niemand nach der Ziffernfolge.
 */
function clockWidgetParts(now = new Date()) {
  // Alle drei Teile lesen dieselbe Uhr. Vorher folgten Zeit und Datum bereits
  // der Haushaltszone (ueber formatTime/formatDate), Wochentag und Maschinenzeit
  // aber noch dem Browser - auf einem Wandbildschirm in einer anderen Zone
  // haette dieselbe Kachel zwei Tage gezeigt.
  const f = nowFields(now);
  const weekday = new Intl.DateTimeFormat(getLocale(), {
    weekday: 'long', timeZone: 'UTC',
  }).format(zonedUTCProxy(now));
  return {
    time: formatTime(now),
    date: `${weekday}, ${formatDate(now)}`,
    machineTime: `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`,
  };
}

/**
 * @param {{wall?: boolean}} [options] `wall` nimmt der Uhr die Kachel: im
 *   Wand-Modus ist sie keine Kachel im Raster, sondern der Anker der Flaeche.
 *   Ihre IDs bleiben dieselben - der Minutentakt (`updateClockWidget`) findet
 *   sie so in beiden Zustaenden, statt ein zweites Mal geschrieben zu werden.
 */
function renderClockWidget({ wall = false, size = '2x1' } = {}) {
  const { time, date, machineTime } = clockWidgetParts();
  const cls = wall ? 'clock-widget clock-widget--wall' : 'widget widget--clock clock-widget';
  // SPERRZONE FUER MELDUNGEN, NUR AN DER WAND (#1917): dort steht der Stapel
  // oben (#1559) und lag bis rund 834px Breite auf Uhrzeit und Datum. Das
  // Attribut liest utils/toast-placement.js; ausgezeichnet sind die beiden
  // Zeilen selbst, nicht ihr Rahmen - der ist so breit wie die Flaeche, und
  // der Hinweis wiche ihm auch dort, wo er neben der Uhr Platz hat.
  const keepout = wall ? ' data-toast-keepout' : '';
  const body = `
    <time class="clock-widget__time" id="clock-widget-time" datetime="${esc(machineTime)}"${keepout}>${esc(time)}</time>
    <p class="clock-widget__date" id="clock-widget-date"${keepout}>${esc(date)}</p>`;
  // Kachel-Form bekommt seit dem Polish-Batch (PLAN.md #7) denselben
  // Siegel+Titel-Kopf wie ihre 15 Geschwister-Widgets - vorher eines von zwei
  // Widgets ganz ohne Kopf (das andere war das Wetter). Die Wand-Form bleibt
  // unveraendert kopflos: dort ist die Uhr der Anker der Flaeche, keine
  // Kachel unter anderen, und ihre Kinder bleiben deshalb ungewrappt.
  if (wall) {
    return `<div class="${cls}" id="clock-widget">${body}</div>`;
  }
  // Die Ziffern wachsen mit der Hoehe der Groesse (dashboard.css, --clock-time-max).
  const span = tileSpanAttrs((s) => ({ body: TILE_PARTS.clock[nearestPreset(s)] ?? TILE_PARTS.clock['2x1'] }), size);
  return `
    <div class="${cls}" id="clock-widget"${span}>
      ${widgetHeader('clock', t('dashboard.clock'), null, null, null, 'dashboard')}
      <div class="widget__body clock-widget__body">${body}</div>
    </div>`;
}

/**
 * Hält die Uhr aktuell. Minutentakt statt Sekunden: die Anzeige kennt keine
 * Sekunden, ein Sekundentimer wäre 60-fache Arbeit für dasselbe Bild. Der
 * Timeout zielt auf die nächste volle Minute, damit der Wechsel dann passiert,
 * wenn er auch auf jeder anderen Uhr im Raum passiert.
 *
 * Der Ticker läuft unabhängig davon, ob das Widget gerade sichtbar ist: das
 * Raster wird beim Anpassen neu aufgebaut, und ein Tick, der die Elemente nicht
 * findet, kostet nichts - eine Anmeldung an jeden Umbau dagegen schon.
 */
function updateClockWidget(container) {
  const timeEl = container.querySelector('#clock-widget-time');
  if (!timeEl) return;
  const { time, date, machineTime } = clockWidgetParts();
  timeEl.textContent = time;
  timeEl.setAttribute('datetime', machineTime);
  const dateEl = container.querySelector('#clock-widget-date');
  if (dateEl) dateEl.textContent = date;
}

function startClockTicker(container, signal, onTick = null) {
  let timerId = null;

  const tick = () => {
    updateClockWidget(container);
    onTick?.();
    schedule();
  };

  const schedule = () => {
    const now = new Date();
    const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    timerId = setTimeout(tick, msToNextMinute);
  };

  schedule();
  signal.addEventListener('abort', () => clearTimeout(timerId));
}

// --------------------------------------------------------
// Wand-Modus (Block D)
// --------------------------------------------------------

/* DER WACHE ZUSTAND.
 *
 * Was hier gebaut wird, ist eine ANZEIGE, kein Werkzeug: ein Familienmitglied
 * geht am Flurtablet vorbei und will in zwei bis drei Sekunden aus zwei Metern
 * wissen, was heute noch ansteht - ohne das Geraet zu beruehren. Der Nachweis
 * ist Lesbarkeit auf Distanz, nicht Funktionsumfang.
 *
 * DESHALB SIND DIE ZEILEN KEINE LINKS. Der Modus ist ein Read-Zustand: waeren
 * die Zeilen beruehrbar, braeuchten sie Distanz-Zielgroessen weit ueber 44px
 * und fuehrten in Ansichten, die auf Arm-Laenge gebaut sind. Wer wirklich etwas
 * tun will, ist einen Tap vom normalen Dashboard entfernt. Der einzige
 * Bedienpunkt der ganzen Flaeche ist der Ausstieg.
 *
 * DIE VIER DINGE, IN DIESER RANGFOLGE: Uhrzeit gross (der Anker, aus dem die
 * 48/72px-Display-Stufen aus tokens.css endlich ihre Rolle bekommen - laut
 * docs/SPEC.md existieren sie ausdruecklich nur dafuer), das Tagesprogramm, wer
 * heute dran ist, das Wetter. Die Anti-Referenz ist die
 * „Smart-Home-Dashboard"-Optik: Kacheln voller Messwerte, Ringdiagramme,
 * Sensorwerte ohne Anlass - das waere das ueberlastete Feature-Dashboard aus
 * PRODUCT.md, nur in gross. */

/** Nach diesem Takt versucht die Wand einen Ladefehler von selbst zu heilen. */
const WALL_HEAL_MS = 60_000;
/** So lange bleibt der Ausstieg nach einer Beruehrung hell. */
const WALL_AWAKE_MS = 6000;
/** So viele Gesichter zeigt „Wer heute dran ist", der Rest spricht als Zahl. */
const WALL_WHO_CAP = 6;

/* DER DECKEL DER WAND IST KLEINER ALS DER DES COCKPITS - GEMESSEN, NICHT GERATEN.
 *
 * Das Cockpit zeigt sechs Zeilen auf Arm-Laenge. In Distanzgroesse ist eine
 * Zeile rund 88px hoch; mit Uhr, Abschnittskopf, Fusszeile und der zeitlosen
 * Einkaufszeile ergaben sechs davon 892px - auf dem kleinsten realistischen
 * Wandtablet (1280x800) lief die Flaeche unten aus dem Bild, samt Ausstieg.
 * Eine Wand kann nicht scrollen, also muss das Bild passen.
 *
 * Vier ist deshalb kein zweiter Deckel neben `PROGRAM_ROW_CAP`, sondern
 * derselbe Mechanismus mit dem Wert, der auf DIESE Flaeche passt - und der
 * Ueberlauf luegt nicht: „+N weitere heute" steht darunter und zaehlt aus
 * demselben Modell. Wer aus zwei Metern mehr als vier Zeilen liest, liest
 * ohnehin nicht mehr im Vorbeigehen, sondern arbeitet eine Liste ab - und
 * dafuer gibt es das Dashboard. */
const WALL_ROW_CAP = 4;

/** Eine Programmzeile als reiner Text - kein href, kein data-route, kein Modal. */
function renderWallRow(row) {
  // Der Termin nennt an der Wand, hinter dem Beginn, sein Ende (#1698). Es
  // steht in einem eigenen Element, weil es auf einer Flaeche unter
  // Tablettbreite weicht (dashboard.css): dort naehme „9:30 PM - 11:30 PM" dem
  // Titel mehr als die halbe Zeile.
  const sub = row.sub;
  const end = row.timeLabel && row.wallTimeEnd
    ? `<span class="wall-row__time-end"> - ${esc(row.wallTimeEnd)}</span>`
    : '';
  const time = row.timeLabel
    ? `<span class="wall-row__time${row.overdue ? ' wall-row__time--overdue' : ''}">${esc(row.timeLabel)}${end}</span>`
    : '';
  return `
    <li class="wall-row wall-row--${esc(row.tone)}">
      <span class="module-seal wall-row__seal">${programRowGlyph(row)}</span>
      <span class="wall-row__body">
        <span class="wall-row__title">${esc(row.title)}</span>
        <span class="wall-row__sub">${esc(sub)}</span>
      </span>
      ${time}
    </li>`;
}

/**
 * Das Tagesprogramm in Distanzgroesse. Dieselben Zeilen, derselbe Deckel,
 * dieselbe Coda wie im Cockpit - nur ohne Bedienung.
 */
function renderWallProgram(model) {
  const parts = [];
  if (model.state) {
    // Ein leerer Tag muss auf Distanz sprechen: eine leere Flaeche liest sich
    // aus zwei Metern wie ein Defekt, nicht wie Ruhe.
    parts.push(`
      <li class="wall-row wall-row--state">
        <span class="module-seal wall-row__seal">${moduleIconHTML(model.state.icon)}</span>
        <span class="wall-row__body">
          <span class="wall-row__title">${esc(model.state.title)}</span>
          ${model.state.sub ? `<span class="wall-row__sub">${esc(model.state.sub)}</span>` : ''}
        </span>
      </li>`);
  }
  parts.push(...model.rows.map(renderWallRow));
  if (model.shopping) parts.push(renderWallRow(model.shopping));

  const foot = model.overflow > 0
    ? t('dashboard.todayMore', { count: model.overflow })
    : model.coda;

  return `
    <section class="wall__program" aria-labelledby="wall-program-title">
      <h2 class="wall__section-title" id="wall-program-title">${esc(t('dashboard.todayTitle'))}</h2>
      <ol class="wall-program__list">${parts.join('')}</ol>
      ${foot ? `<p class="wall-program__foot">${esc(foot)}</p>` : ''}
    </section>`;
}

/* DIE AUFGABEN UNTER DEM GESICHT (#1817, D#1604).
 *
 * Bis dahin stand unter jeder Person eine Zahl. Die Zahl sagt, DASS etwas offen
 * ist; ein Elternteil, das an der Wand vorbeigeht, will wissen WAS - und was
 * davon schon erledigt ist. Deshalb stehen dort jetzt Titel: zuerst die
 * offenen, darunter gedaempft und mit Haken, was heute erledigt wurde.
 *
 * DIE WAND SCROLLT NICHT, ALSO FOLGT DIE ZEILENZAHL DEM PLATZ. Wie viele Zeilen
 * passen, haengt an Tablet, Haushaltsgroesse, Wetter und Kuechentimer - das
 * laesst sich nicht als eine Zahl festschreiben wie `WALL_ROW_CAP`. Es gibt
 * darum eine LEITER von Budgets (`WALL_WHO_LADDER`), die von oben nach unten
 * weniger zeigt, und `fitWallWho` steigt sie im Browser so weit hinab, bis die
 * Flaeche ins Bild passt. Was die Leiter auf einer Stufe zeigt, entscheidet
 * `planWallWhoLines` - eine reine Funktion, die ohne Layout pruefbar ist.
 *
 * ERLEDIGTES WEICHT ZUERST. Die Leiter nimmt erst den Haken ihre Zeilen (auf
 * der ganzen Flaeche, nicht je Person: sonst behielte Anna zwei Haken, waehrend
 * Ben eine offene Aufgabe verliert) und kuerzt danach die offenen. Die letzte
 * Stufe zeigt keine Titel mehr - Gesichter mit Zahl, wie vor #1817.
 *
 * EINE AUSNAHME: wer heute ALLES erledigt hat, behaelt einen Haken, solange
 * ueberhaupt Titel stehen. Die Spalte zeigt dann, was geschafft wurde, statt
 * leer zu sein - bis zum Tageswechsel, mit dem der Server sie nicht mehr
 * liefert. */

/** So viele Zeilen stehen hoechstens unter einem Gesicht, die Zaehlzeile eingerechnet. */
const WALL_WHO_ROWS_MAX = 5;

/** Die Stufen von „alles" bis „nur Gesichter": erst weichen die Haken, dann die offenen. */
const WALL_WHO_LADDER = Object.freeze([
  ...Array.from({ length: WALL_WHO_ROWS_MAX }, (_, i) => ({ rows: WALL_WHO_ROWS_MAX, doneRows: WALL_WHO_ROWS_MAX - 1 - i })),
  ...Array.from({ length: WALL_WHO_ROWS_MAX }, (_, i) => ({ rows: WALL_WHO_ROWS_MAX - 1 - i, doneRows: 0 })),
].map(Object.freeze));

/**
 * Was unter EINER Person steht, bei gegebenem Budget.
 *
 * `rows` ist die Zahl der Zeilen einschliesslich der Zaehlzeile, `doneRows` die
 * Obergrenze fuer Haken darin. Die Zaehlzeile nennt, was nicht passt: offene
 * als „+N weitere"; sind nur Haken uebrig, „+N erledigt" - eine gemischte Zahl
 * laese sich als „noch N zu tun". Bei genau einer Zeile gewinnt der Titel, die
 * Zahl am Gesicht nennt den Rest.
 *
 * @param {{open?: object[], done?: object[], open_count?: number, done_count?: number}|null} entry
 * @param {{rows: number, doneRows: number}} budget
 */
function planWallWhoLines(entry, { rows, doneRows }) {
  const open = Array.isArray(entry?.open) ? entry.open : [];
  const done = Array.isArray(entry?.done) ? entry.done : [];
  const openTotal = Math.max(Number(entry?.open_count) || 0, open.length);
  const doneTotal = Math.max(Number(entry?.done_count) || 0, done.length);
  const plan = { open: [], done: [], moreOpen: 0, moreDone: 0, openTotal, doneTotal };
  if (rows <= 0) return plan;

  // Wer nichts Offenes mehr hat, behaelt einen Haken (siehe oben).
  const doneAllowed = openTotal === 0 ? Math.max(doneRows, 1) : doneRows;
  let showOpen = Math.min(open.length, rows);
  let showDone = Math.min(done.length, rows - showOpen, doneAllowed);
  const hidden = () => (openTotal - showOpen) + (doneTotal - showDone);

  // Die Zaehlzeile braucht selbst eine Zeile: sie verdraengt zuerst einen
  // Haken, dann eine offene Aufgabe - nie die letzte verbliebene Zeile. Und
  // ein offener Titel weicht nur fuer die Zahl der OFFENEN: „+2 erledigt" an
  // der Stelle einer Aufgabe, die noch ansteht, waere der Tausch, den die
  // Leiter gerade verhindern soll.
  if (hidden() > 0 && showOpen + showDone >= rows && rows >= 2) {
    if (showDone > 0) showDone -= 1;
    else if (openTotal > showOpen) showOpen -= 1;
  }
  plan.open = open.slice(0, showOpen);
  plan.done = done.slice(0, showDone);
  if (hidden() > 0 && showOpen + showDone < rows) {
    plan.moreOpen = openTotal - showOpen;
    plan.moreDone = doneTotal - showDone;
  }
  return plan;
}

/**
 * „Wer heute dran ist" - ein Gesicht je Person, darunter ihre Aufgaben von
 * heute beim Namen (#1817).
 *
 * WER DRAN IST: wer eine Zeile im Programm traegt (Termin, Aufgabe, Kochen)
 * ODER heute eine haushaltssichtbare Aufgabe hat, offen oder erledigt. Das
 * zweite schliesst eine Luecke: das Programm liest `urgentTasks`, haushaltsweit
 * auf fuenf gekappt - wessen Aufgabe die sechste war, stand hier gar nicht.
 *
 * DIE ZAHL AM GESICHT IST, WAS HEUTE NOCH VOR JEMANDEM LIEGT: die offenen
 * Aufgaben aus `wallTasks` (ungekappt) und dazu, was das Programm sonst fuer
 * die Person fuehrt - ihr Termin, das Kochen (#1679). Die Aufgabenzeilen des
 * Programms zaehlen NICHT mit: sie kommen aus `urgentTasks`, das bei fuenf
 * abschneidet, nur die erste zugewiesene Person kennt und nach der Sicht der
 * angemeldeten Person filtert - unter Titeln, die jede Aufgabe nennen, stuende
 * sonst eine Zahl, die ihnen widerspricht. Ist nichts mehr offen und etwas
 * erledigt, steht dort ein Haken.
 *
 * DIE TITEL KOMMEN AUS `wallTasks`, nicht aus dem Programm: der Server liefert
 * dort nur, was der GANZE Haushalt sehen darf. Ein Wandtablett ist keine
 * Person; „nur Zugewiesene" steht auf keiner Wand, wer immer angemeldet ist.
 *
 * Im Solo-Haushalt entfaellt der Abschnitt still - dieselbe Regel wie beim
 * Ueberlappungszeichen und beim Familien-Widget: was nur eine sinnvolle
 * Belegung hat, wird nicht gezeigt.
 *
 * NUR DER VORNAME am Gesicht: „Linda Johnson" passt in keine Spalte dieser
 * Breite und stand als „Linda Jo…" da - ein abgeschnittener Name ist auf zwei
 * Metern schlechter als gar keiner. Im eigenen Haushalt ist der Vorname
 * ohnehin die Antwort.
 *
 * @param {{rows: number, doneRows: number}} [budget] eine Stufe der Leiter;
 *   ohne Angabe die oberste. `fitWallWho` steigt von dort hinab.
 */
function renderWallWho(data, model, budget = WALL_WHO_LADDER[0]) {
  if (isSoloHousehold()) return '';
  const users = Array.isArray(data?.users) ? data.users : [];
  if (!users.length) return '';

  const inProgram = new Set();
  const otherRows = new Map();
  for (const row of model.allRows) {
    // ALLE Personen der Zeile (#1828), nicht nur ihr eines Gesicht. Die
    // Aufgabenzeilen des Programms zaehlen hier nicht mit: die Zahl der
    // Aufgaben kommt ungekappt aus `wallTasks` (#1817).
    for (const id of rowPeopleIds(row)) {
      inProgram.add(id);
      if (row.kind !== 'task') otherRows.set(id, [...(otherRows.get(id) ?? []), { title: row.title }]);
    }
  }
  // DIE ZAHL IST DIE LISTE (R23, Critique G1 P2). Die Zahl am Gesicht zaehlt,
  // was heute vor der Person liegt - Aufgaben UND ihr Termin, ihr Kochen
  // (#1679) -, die Titel darunter nannten aber nur Aufgaben: Leo trug „3"
  // ueber „Klavier ueben", Emma „1" ueber nichts. Die Programmzeilen der Person
  // stehen deshalb als offene Zeilen VOR ihren Aufgaben, mit derselben Leiter
  // und derselben Zaehlzeile - was an Titeln steht plus „+N weitere" ist die
  // Zahl. Die Aufgabenzeilen des Programms bleiben draussen (siehe oben).
  const tasksOf = new Map();
  for (const entry of Array.isArray(data?.wallTasks) ? data.wallTasks : []) {
    if (entry?.user_id != null) tasksOf.set(entry.user_id, entry);
  }
  const entryOf = (id) => {
    const entry = tasksOf.get(id);
    const others = otherRows.get(id) ?? [];
    if (!others.length) return entry;
    const open = Array.isArray(entry?.open) ? entry.open : [];
    const openTotal = Math.max(Number(entry?.open_count) || 0, open.length);
    return { ...entry, open: [...others, ...open], open_count: openTotal + others.length };
  };
  // Der Plan auf der OBERSTEN Stufe sagt, wer ueberhaupt etwas hat - die
  // Rangfolge darf sich nicht aendern, waehrend die Leiter hinabsteigt.
  const totals = new Map(users.map((u) => [u.id, planWallWhoLines(entryOf(u.id), WALL_WHO_LADDER[0])]));
  // Die Aufgabenbilanz fuer Screenreader bleibt eine Aufgabenbilanz.
  const taskTotals = new Map(users.map((u) => [u.id, planWallWhoLines(tasksOf.get(u.id), WALL_WHO_LADDER[0])]));

  const ahead = (u) => totals.get(u.id).openTotal;

  const onDuty = users
    .filter((u) => inProgram.has(u.id) || totals.get(u.id).openTotal > 0 || totals.get(u.id).doneTotal > 0)
    // Wer am meisten vor sich hat, zuerst; bei Gleichstand die Haushaltsreihenfolge (#1644).
    .sort((a, b) => (ahead(b) - ahead(a)) || compareMembers(a, b));

  const shown = onDuty.slice(0, WALL_WHO_CAP);
  const plans = new Map(shown.map((u) => [u.id, planWallWhoLines(entryOf(u.id), budget)]));
  const withTitles = shown.some((u) => {
    const plan = plans.get(u.id);
    return plan.open.length || plan.done.length || plan.moreOpen || plan.moreDone;
  });

  const body = shown.length
    ? `<ul class="wall-who__list${withTitles ? ' wall-who__list--tasks' : ''}">${shown.map((u) => {
        const color = u.avatar_color || AVATAR_FALLBACK_COLOR;
        const plan = plans.get(u.id);
        const { doneTotal } = plan;
        const { openTotal } = taskTotals.get(u.id);
        const count = ahead(u);
        const mark = count > 0
          ? `<span class="wall-who__count">
                <span aria-hidden="true">${esc(String(count))}</span>
                <span class="sr-only">${esc(t('dashboard.wallWhoCount', { count }))}</span>
              </span>`
          : doneTotal > 0
            ? '<span class="wall-who__count wall-who__count--done"><i data-lucide="check" aria-hidden="true"></i></span>'
            : '';
        const tally = openTotal > 0 || doneTotal > 0
          ? `<span class="sr-only">${esc(t('dashboard.familyDayTally', { open: openTotal, done: doneTotal }))}</span>`
          : '';
        const more = plan.moreOpen > 0
          ? t('dashboard.shoppingMore', { count: plan.moreOpen })
          : plan.moreDone > 0
            ? t('dashboard.wallWhoDoneMore', { count: plan.moreDone })
            : '';
        const lines = [
          ...plan.open.map((task) => `<li class="wall-who__task"><span class="wall-who__task-title">${esc(task.title)}</span></li>`),
          ...plan.done.map((task) => `
            <li class="wall-who__task wall-who__task--done">
              <i data-lucide="check" class="wall-who__task-check" aria-hidden="true"></i>
              <span class="sr-only">${esc(t('tasks.statusDone'))}: </span><span class="wall-who__task-title">${esc(task.title)}</span>
            </li>`),
          ...(more ? [`<li class="wall-who__task wall-who__task--more">${esc(more)}</li>`] : []),
        ];
        return `
          <li class="wall-who__member">
            <span class="wall-who__mark">
              <span class="wall-who__avatar" style="background:${esc(color)};color:${getReadableTextColor(color)}">
                ${u.avatar_data ? `<img src="${esc(u.avatar_data)}" alt="" loading="lazy">` : esc(initials(u.display_name))}
              </span>
              ${mark}
            </span>
            <span class="wall-who__name">${esc(firstName(u.display_name))}</span>${tally}
            ${lines.length ? `<ul class="wall-who__tasks">${lines.join('')}</ul>` : ''}
          </li>`;
      }).join('')}</ul>${onDuty.length > shown.length
        ? `<p class="wall-who__more">${esc(t('dashboard.shoppingMore', { count: onDuty.length - shown.length }))}</p>`
        : ''}`
    : `<p class="wall-who__none">${esc(t('dashboard.wallWhoNone'))}</p>`;

  return `
    <section class="wall__who" aria-labelledby="wall-who-title">
      <h2 class="wall__section-title" id="wall-who-title">${esc(t('dashboard.wallWho'))}</h2>
      ${body}
    </section>`;
}

/**
 * Steigt die Leiter hinab, bis die Wand ins Bild passt.
 *
 * GEMESSEN, NICHT GERECHNET. Die Hoehe einer Titelzeile haengt an `vmin`, die
 * Breite der Spalten am Container, der Platz an Wetter, Timer und der Zahl der
 * Programmzeilen - eine Formel dafuer waere eine zweite, driftende Fassung des
 * Stylesheets. Die Wand ist mindestens so hoch wie das Fenster; ist sie
 * hoeher, laeuft sie unten aus dem Bild, und genau das wird gefragt.
 *
 * Jeder Neuaufbau beginnt wieder oben: die Leiter kennt nur „weniger", das
 * „wieder mehr" (groesseres Fenster, Timer beendet) ergibt sich aus dem
 * Neubeginn. Alles geschieht synchron vor dem naechsten Bild - niemand sieht
 * die Zwischenstufen.
 *
 * @returns {number} die Stufe, auf der die Flaeche steht (-1: nichts zu tun)
 */
function fitWallWho(root, data, { now = new Date(), reset = false, isDisplay = false } = {}) {
  const wall = root?.querySelector?.('.wall');
  const overflows = () => wall.scrollHeight > (globalThis.window?.innerHeight ?? 0) + 1;
  if (!wall?.querySelector('.wall__who')) {
    if (wall && overflows() && !wallIsStacked(wall)) shedWallProgram(wall, data, overflows, { now, isDisplay });
    return -1;
  }
  if (!reset && !overflows()) return 0;

  // `allRows` haengt nicht am Deckel, der Timer spielt hier also keine Rolle.
  const model = buildTodayCockpitModel(data, [], { cap: WALL_ROW_CAP, now, groupOverdue: false, ...wallTimelineOptions(data, now) });
  const place = (step) => {
    const section = wall.querySelector('.wall__who');
    if (!section) return false;
    section.insertAdjacentHTML('afterend', renderWallWho(data, model, WALL_WHO_LADDER[step]));
    section.remove();
    if (globalThis.window?.lucide) globalThis.window.lucide.createIcons({ el: wall.querySelector('.wall__who') });
    return true;
  };
  let step = 0;
  if (reset && !place(0)) return -1;
  const heights = [wall.scrollHeight];
  while (step < WALL_WHO_LADDER.length - 1 && overflows()) {
    step += 1;
    if (!place(step)) break;
    heights[step] = wall.scrollHeight;
  }
  if (!overflows()) return step;

  // AUCH OHNE TITEL ZU HOCH: dann sind nicht die Titel der Grund, und die
  // Leiter darf nicht blind auf ihrer letzten Stufe stehen bleiben.
  //
  // Auf dem TELEFON (alles gestapelt) scrollt die Wand ohnehin, der Fuss klebt
  // (#1559) - dort nimmt das Kuerzen nur Auskunft weg, also steht alles da.
  //
  // UEBERALL SONST gilt: so viele Titel, wie NICHTS KOSTEN. Auf einem Tablett,
  // das dem Programm links nicht reicht (1024x768: 45px zu hoch, mit oder ohne
  // Titel), oder im Hochformat, wo das Wetter neben den Gesichtern die Hoehe
  // bestimmt, ist die Flaeche auf mehreren Stufen gleich hoch. Gewaehlt wird
  // die reichste davon - die Flaeche wird dadurch nicht hoeher, als sie ohne
  // Titel waere. Hier stand zuerst „laeuft auf der letzten Stufe noch ueber,
  // also alles zurueck": das holte auf solchen Tabletts die volle Liste und
  // schob Fuss und Ausgang weit aus dem Bild.
  if (wallIsStacked(wall)) {
    place(0);
    return 0;
  }
  const lowest = Math.min(...heights);
  const free = heights.findIndex((height) => height <= lowest + 1);
  if (free !== step) place(free);
  // Und laeuft sie dann noch ueber, ist das Programm der Grund (R23). Hat es
  // Zeilen abgegeben, duerfen unter den Gesichtern wieder Titel stehen, die
  // jetzt nichts mehr kosten - von der stehenden Stufe aufwaerts, eine nach
  // der anderen, bis die naechste nicht mehr passt (jede Probe ist ein
  // Layout; meist reicht der Platz fuer keine oder eine Stufe).
  if (overflows() && shedWallProgram(wall, data, overflows, { now, isDisplay }) > 0) {
    let kept = free;
    let current = free;
    for (let richer = free - 1; richer >= 0; richer -= 1) {
      place(richer);
      current = richer;
      if (overflows()) break;
      kept = richer;
    }
    if (current !== kept) place(kept);
    return kept;
  }
  return free;
}

/**
 * DAS PROGRAMM GIBT ZEILEN AB, WENN DAS TABLETT NICHT REICHT (R23, Critique
 * G1 P2). `WALL_ROW_CAP` ist fuer 1280x800 gerechnet; auf 768x1024 (hochkant
 * an der Wand) lief die Flaeche 25px, auf 1024x768 45px aus dem Bild - und
 * genau dort, wo „Wer heute dran ist" schon auf der letzten Stufe stand, also
 * nichts mehr hergab. Eine Wand scrollt nicht. Dieselbe Regel wie die Leiter:
 * gemessen, nicht gerechnet - eine Zeile nach der anderen weicht in
 * „+N weitere heute", das aus demselben Modell zaehlt, bis die Flaeche passt;
 * zwei Zeilen bleiben immer. Jeder Neuaufbau beginnt wieder beim vollen
 * Deckel. Das Telefon scrollt ohnehin und gibt nichts ab.
 *
 * @returns {number} wie viele Zeilen gewichen sind
 */
function shedWallProgram(wall, data, overflows, { now = new Date(), isDisplay = false } = {}) {
  let section = wall.querySelector?.('.wall__program');
  if (!section) return 0;
  let rows = section.querySelectorAll('.wall-program__list > .wall-row:not(.wall-row--shopping):not(.wall-row--state)').length;
  let shed = 0;
  while (rows > 2 && overflows()) {
    rows -= 1;
    const model = buildTodayCockpitModel(data, [], { cap: rows, now, groupOverdue: false, isDisplay, ...wallTimelineOptions(data, now) });
    section.insertAdjacentHTML('afterend', renderWallProgram(model));
    const next = section.nextElementSibling;
    section.remove();
    section = next;
    if (globalThis.window?.lucide && section) globalThis.window.lucide.createIcons({ el: section });
    shed += 1;
  }
  return shed;
}

/**
 * Ist die Wand ganz gestapelt - Buehne UND Nebenraum je eine Spalte? Das ist
 * das Telefon. Ein Hochformat-Tablett stapelt nur die Buehne und stellt „Wer"
 * und Wetter nebeneinander; es ist keine Flaeche, die scrollen soll.
 */
function wallIsStacked(wall) {
  const single = (selector) => {
    const element = wall?.querySelector?.(selector);
    const columns = element ? globalThis.getComputedStyle?.(element)?.gridTemplateColumns : null;
    // Ohne Antwort (kein Layout) gilt nichts als gestapelt: der vorsichtige
    // Irrtum ist die kuerzere Liste, nicht die volle.
    return typeof columns === 'string' && columns.trim() !== '' && columns.trim().split(/\s+/).length < 2;
  };
  return single('.wall__stage') && single('.wall__aside');
}

/**
 * Das Einpassen der Wand an EINER Stelle verdrahtet (#1817).
 *
 * `show` passt die frisch gebaute Flaeche ein und merkt sie sich; der
 * `resize`-Hoerer passt die gemerkte Flaeche neu ein - von der obersten Stufe
 * aus, damit ein groesseres Fenster auch wieder MEHR zeigt (Drehen des
 * Tabletts, Tastatur, Vollbild). Er haengt am Signal der Seite und faellt mit
 * ihr; pro Bild laeuft er hoechstens einmal.
 */
function createWallFit(win, signal) {
  let shown = null;
  let frame = 0;
  win.addEventListener('resize', () => {
    if (!shown || frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (shown) fitWallWho(shown.shell, shown.data, { reset: true, isDisplay: shown.isDisplay });
    });
  }, { signal, passive: true });
  signal.addEventListener('abort', () => {
    win.cancelAnimationFrame(frame);
    shown = null;
  }, { once: true });
  return {
    show(shell, data, { isDisplay = false } = {}) {
      shown = { shell, data, isDisplay };
      return fitWallWho(shell, data, { isDisplay });
    },
  };
}

/**
 * Baut die Wand in die Schale: Flaeche, Zeichen, Bedienung, Einpassen. EINE
 * Funktion, damit kein Schritt davon am Aufrufer vergessen werden kann - das
 * Einpassen stand zuerst als lose Zeile in `rebuildDashboard`, und kein Test
 * merkte, wenn sie fehlte.
 */
function rebuildWall(container, shell, { data, weather, failed, updatedAt, rerender, signal, fit, screensaverEnabled = false, isDisplay = false }) {
  // Der stille Neuaufbau (Minutentakt, Timer) nimmt den Fokus mit, statt ihn
  // auf <body> fallen zu lassen - dasselbe Paar wie in rebuildDashboard.
  const doc = globalThis.document;
  const { key: keepFocus } = captureRebuildFocus(shell, doc?.activeElement, doc?.body);
  setHtml(shell, renderWallSurface(data, weather, { failed, updatedAt, screensaverEnabled, isDisplay }));
  if (globalThis.window?.lucide) globalThis.window.lucide.createIcons({ el: shell });
  wireWallSurface(container, rerender, signal);
  restoreFocusAfterRebuild(container, [keepFocus, takeWallFocusIntent('enter') ? '#wall-surface' : null]);
  // Die Titel unter den Gesichtern folgen dem Platz: nach jedem Aufbau von der
  // obersten Stufe hinab.
  return fit.show(shell, data, { isDisplay });
}

/**
 * Wetter mit Vorhersage - dieselben Bausteine wie Karte und Masthead-Zeile,
 * ohne den Aktualisieren-Knopf: den drueckt am Wandtablet niemand, und ein
 * Bedienelement in einer reinen Anzeige waere ein falsches Versprechen.
 */
function renderWallWeather(weather) {
  if (!weather?.current) return '';
  const { city, current, forecast, units } = weather;
  const desc = weatherDescText(weather, current.desc);
  const days = (Array.isArray(forecast) ? forecast : []).slice(0, 4).map((d) => {
    const label = weatherDayLabel(weather, d.date);
    return `
      <li class="wall-weather__day"${weatherToneAttr(d.icon)}>
        <span class="wall-weather__day-label">${esc(label)}</span>
        ${weatherIconHtml(weather, d.icon, 'wall-weather__day-icon', 32, weatherDescText(weather, d.desc))}
        <span class="wall-weather__day-temps">
          <span class="wall-weather__day-high">${esc(String(d.temp_max))}°</span>
          <span class="wall-weather__day-low">${esc(String(d.temp_min))}°</span>
        </span>
      </li>`;
  }).join('');

  return `
    <section class="wall__weather" aria-labelledby="wall-weather-title"${weatherToneAttr(current.icon)}${weatherMotionAttr(current.icon)}>
      <h2 class="wall__section-title" id="wall-weather-title">${esc(t('dashboard.weather'))}</h2>
      <div class="wall-weather__now">
        ${weatherIconHtml(weather, current.icon, 'wall-weather__icon', 64, desc)}
        <span class="wall-weather__body">
          <span class="wall-weather__temp">${esc(String(current.temp))}${weatherUnitSymbol(units)}</span>
          ${weatherTodayRange(weather, 'wall-weather__range')}
          <span class="wall-weather__desc">${esc(desc)}${city ? ` · ${esc(city)}` : ''}</span>
        </span>
      </div>
      ${days ? `<ol class="wall-weather__forecast">${days}</ol>` : ''}
    </section>`;
}

/**
 * Der Ladefehler in Wand-Fassung.
 *
 * Der bestehende Fehlerzustand ist auf Arm-Laenge gebaut und traegt einen
 * Retry-Knopf - am Wandtablet drueckt den niemand. Hier steht deshalb ein Satz,
 * den man aus zwei Metern als Fehler erkennt, plus die Zusage, dass die Flaeche
 * es von selbst weiter versucht (der Takt dazu steht in `render`). Die Uhr
 * bleibt daneben stehen: sie braucht kein Netz und ist der Beweis, dass das
 * Geraet lebt und nur die Daten fehlen.
 */
function renderWallError() {
  return `
    <section class="wall__error" role="status">
      <i data-lucide="cloud-off" class="wall__error-icon" aria-hidden="true"></i>
      <p class="wall__error-title">${esc(t('dashboard.wallOffline'))}</p>
      <p class="wall__error-sub">${esc(t('dashboard.wallOfflineHint'))}</p>
    </section>`;
}

/**
 * Die ganze Flaeche.
 *
 * DER AUSSTIEG IST LEISE DA, NICHT VERSTECKT. Ein voller Knopf widerspraeche
 * der ruhigen Flaeche, ein unsichtbarer waere eine Falle - also steht er immer
 * im DOM, immer im Bild (der Fuss klebt an der Unterkante, #1559) und immer mit
 * seinem Wort, in Sekundaerfarbe ohne Kapsel. Bis #1559 trug er in Ruhe nur
 * sein Zeichen, und genau daran fand jemand nicht mehr hinaus (D#1494). Jede
 * Beruehrung hebt ihn fuer ein paar Sekunden auf die volle Kapsel
 * (`data-wall-awake`, siehe `wireWallSurface`). Seit dem Kuechentimer (#844)
 * ist der Ausstieg nicht mehr das Einzige, was man beruehren kann - dessen
 * Startknoepfe stehen daneben und ruhen genauso leise, aber sichtbar. Damit
 * ein Tipp, der die Wand nur wecken
 * sollte, keinen Timer startet, weckt der erste Zeiger auf eine schlafende
 * Wand dort nur (wall-timer.js).
 */
function renderWallSurface(data, weather, { failed = false, loading = false, updatedAt = null, now = new Date(), screensaverEnabled = false, isDisplay = false } = {}) {
  // Der Kuechentimer (#844). Er wird auch im Lade- und Fehlerzustand gebaut: er
  // haengt an nichts, was geladen werden koennte, und ein laufender Timer, der
  // beim naechsten Netzfehler verschwaende, waere schlimmer als gar keiner.
  const timer = renderWallTimer();
  // Seine Anzeige kostet eine Programmzeile Hoehe (64px plus Abstand, gemessen
  // bei 1280x800). WALL_ROW_CAP ist fuer die Flaeche OHNE sie gerechnet: an
  // einem vollen Tag schob sie den Fuss samt „Timer abbrechen" und Ausstieg
  // unter den Bildrand. Solange sie steht, nimmt das Programm eine Zeile
  // weniger, und „+N weitere" zaehlt sie mit. Der Start und das Ende rufen
  // ohnehin `rerender()` (wall-timer.js), der Deckel folgt also von selbst.
  const cap = timer.display ? WALL_ROW_CAP - 1 : WALL_ROW_CAP;
  const model = failed || loading ? null : buildTodayCockpitModel(data, [], { cap, now, groupOverdue: false, isDisplay, ...wallTimelineOptions(data, now) });

  let main;
  if (failed) {
    main = renderWallError();
  } else if (loading) {
    main = '<div class="wall__loading" aria-hidden="true"></div>';
  } else {
    const aside = `${renderWallWho(data, model)}${renderWallWeather(weather)}`;
    main = `
      ${renderWallProgram(model)}
      ${aside ? `<div class="wall__aside">${aside}</div>` : ''}`;
  }

  const stamp = updatedAt
    ? `<p class="wall__updated">${esc(t('dashboard.updatedAt', { time: formatTime(updatedAt) }))}</p>`
    : '<p class="wall__updated"></p>';

  return `
    <div class="wall" id="wall-surface" tabindex="-1" aria-label="${esc(t('settings.wallModeLabel'))}" role="region">
      ${renderClockWidget({ wall: true })}
      <div class="wall__stage${failed || loading ? ' wall__stage--single' : ''}">${main}</div>
      ${timer.display}
      <div class="wall__foot" data-toast-keepout>
        ${stamp}
        ${timer.controls}
        <div class="wall__foot-end">${screensaverEnabled && !timer.display ? `
          <button type="button" class="wall__foot-btn wall__foot-btn--icon" id="wall-screensaver-start"
                  aria-label="${esc(t('dashboard.wallScreensaverStart'))}"
                  title="${esc(t('dashboard.wallScreensaverStart'))}">
            <i data-lucide="image" aria-hidden="true"></i>
          </button>` : ''}
          <button type="button" class="wall__foot-btn" id="wall-exit" aria-label="${esc(t('dashboard.wallExit'))}">
            <i data-lucide="minimize-2" aria-hidden="true"></i>
            <span class="wall__foot-btn-label" aria-hidden="true">${esc(t('dashboard.wallExit'))}</span>
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Verdrahtet die einzige Interaktion der Flaeche: den Ausstieg.
 *
 * Drei Wege hinaus, und alle sind derselbe: der Knopf, die Escape-Taste und
 * seit #1559 Zurueck (`wireWallExit`).
 * Das Wecken haengt an den Ereignissen, die auch der Screensaver hoert - es
 * verbraucht sie aber nicht, sondern setzt nur ein Attribut.
 */
function wireWallSurface(container, rerender, signal) {
  const wall = container.querySelector('.wall');
  if (!wall) return;

  let awakeTimer = null;
  const wake = () => {
    wall.setAttribute('data-wall-awake', '');
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => wall.removeAttribute('data-wall-awake'), WALL_AWAKE_MS);
  };
  for (const type of ['pointerdown', 'pointermove', 'keydown']) {
    window.addEventListener(type, wake, { passive: true, signal });
  }
  signal.addEventListener('abort', () => clearTimeout(awakeTimer));

  wireWallTimer(wall, rerender, signal, { announce: announceDashboard });

  wall.querySelector('#wall-screensaver-start')?.addEventListener('click', async () => {
    const { preview } = await import('/components/photo-screensaver.js');
    if (!await preview()) window.yuvomi?.showToast(t('dashboard.wallScreensaverNone'), 'info');
  }, { signal });
}

/**
 * Der Ausstieg - datenunabhaengig, und deshalb getrennt vom Rest.
 *
 * Er stand bis zum Review in `wireWallSurface` und wurde damit erst verdrahtet,
 * wenn die Dashboard-Daten da waren. Auf der Ladeflaeche ist der Knopf sichtbar,
 * aber tot; haengt die Anfrage, kommt niemand mehr aus dem Wandmodus heraus -
 * in der installierten PWA ohne Browserleiste heisst das: gar nicht mehr.
 *
 * Er haengt am CONTAINER, nicht am Knopf: `setHtml` tauscht dessen Inhalt aus,
 * der Container selbst bleibt. So ueberlebt die eine Verdrahtung beide Renders,
 * und es braucht keinen zweiten Aufruf, der Escape ein zweites Mal registrierte.
 */
function wireWallExit(container, rerender, signal) {
  const leave = () => {
    releaseWallMarker();
    exitWallMode();
    _wallFocusIntent = 'leave';
    // Der Toast sagt, WO der Weg zurueck liegt - wer versehentlich aussteigt,
    // soll nicht suchen muessen. Der Name kommt aus dem Schluessel des Knopfes
    // statt aus dem Satz: sonst driftet die Wegbeschreibung, sobald der Knopf
    // umbenannt wird.
    //
    // Er zeigte bis #915 in die Einstellungen, weil der Modus dort als einziges
    // eingeschaltet werden konnte. Das war nie falsch, aber seit der Einstieg in
    // der Werkzeugzeile steht, waere es der Umweg - und ein Hinweis, der den
    // Umweg nennt, waehrend der kurze Weg sichtbar danebenliegt, ist eine
    // schlechtere Auskunft als gar keiner.
    window.yuvomi?.showToast(t('dashboard.wallExited', {
      action: t('dashboard.wallEnter'),
    }), 'success', 6000);
    rerender();
  };

  container.addEventListener('click', (event) => {
    if (event.target.closest('#wall-exit')) leave();
  }, { signal });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') leave();
  }, { signal });
  // Der dritte Weg hinaus: Zurueck (#1559). Er schliesst die Wand wie ein
  // Dialog - `handleBackNavigation` ruft `leave`, der Router navigiert nicht.
  holdWallMarker(leave);
}

// --------------------------------------------------------
// FAB Speed-Dial
// --------------------------------------------------------

/**
 * Der Speed-Dial bietet nur an, was der Betrachter auch ANLEGEN darf.
 *
 * Die Liste stand bis #1208 ungefiltert da: wer Notizen auf `none` hatte, bekam
 * trotzdem „Notiz anlegen" angeboten und lief in ein 403. Aufgefallen ist es am
 * Wandtablett, wo ALLE vier Eintraege ins Leere fuehren - dessen Module stehen
 * samt und sonders auf `read`. Der Filter ist deshalb nicht am Display
 * aufgehaengt, sondern an der Frage, um die es geht: darf diese Route beschrieben
 * werden? Damit verschwindet derselbe tote Knopf auch fuer ein eingeschraenktes
 * Mitglied.
 *
 * `navModuleAccess` und nicht `moduleAccess`: die Schluessel hier sind
 * NAVIGATIONS-Routen, und die Zuordnung auf den Rechte-Schluessel steht in
 * permissions.js (`/shopping` haengt etwa am Kuechen-Modul). Eine eigene
 * Uebersetzung hier waere die zweite Tabelle dafuer.
 */
const FAB_ACTIONS = () => [
  { route: '/tasks',    label: t('dashboard.fabTask'),     icon: 'check-square'   },
  { route: '/calendar', label: t('dashboard.fabCalendar'), icon: 'calendar-plus'  },
  { route: '/shopping', label: t('dashboard.fabShopping'), icon: 'shopping-cart'  },
  { route: '/notes',    label: t('dashboard.fabNote'),     icon: 'sticky-note'    },
].filter((a) => navModuleAccess(a.route.slice(1)) === 'write');

/* AM DESKTOP IST ANLEGEN EINE ANGEDOCKTE PILLE (R14, A8 P3-2). Die Uebersicht
 * war der einzige schwebende FAB am Desktop - 48x48 unten rechts, nur
 * "Schnellaktionen" als Name -, waehrend jedes andere Modul "+ Nomen" im Kopf
 * traegt. Dieselbe Grenze wie das Andocken der Shell (router.js,
 * isDesktopViewport); dieselbe Form (`page-fab--docked`, schon so gerendert,
 * damit ein Neuaufbau des Kopfs nicht auf das Andocken warten muss), dasselbe
 * Menue als Popover. Der Kurzbefehl `n` klickt den `.page-fab` und oeffnet es. */
const DESKTOP_STAGE_QUERY = '(min-width: 1024px)';

function onDesktopStage() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(DESKTOP_STAGE_QUERY)?.matches);
  } catch {
    return false;
  }
}

function renderNewPill() {
  const actions = FAB_ACTIONS();
  if (!actions.length) return '';
  const items = actions.map((a) => `
          <button type="button" role="menuitem" class="popover-menu__item" data-new-route="${esc(a.route)}">
            <i data-lucide="${esc(a.icon)}" class="icon-md" aria-hidden="true"></i>
            <span>${esc(a.label)}</span>
          </button>`).join('');
  const label = t('dashboard.fabNew');
  return `
        <div class="page-toolbar__actions dashboard-overview__new">
          <button type="button" class="page-fab btn btn--primary page-fab--docked popover-menu__trigger" id="fab-main"
                  data-dock-label="${esc(label)}" aria-label="${esc(t('nav.quickActions'))}" title="${esc(t('nav.quickActions'))} (n)"
                  aria-keyshortcuts="n" aria-haspopup="menu" aria-expanded="false" popovertarget="dashboard-new-menu">
            <i data-lucide="plus" aria-hidden="true"></i><span class="toolbar-new-btn__label">${esc(label)}</span>
          </button>
          <div class="popover-menu" id="dashboard-new-menu" popover role="menu">${items}
          </div>
        </div>`;
}

/** Die Menuepunkte der Pille: dieselben Wege wie der Speed-Dial (openNewTarget). */
function wireNewMenu(container, signal, host = {}) {
  installPopoverMenus(container);
  container.addEventListener('click', async (event) => {
    const item = event.target.closest?.('[data-new-route]');
    if (!item) return;
    item.closest('[popover]')?.hidePopover?.();
    await openNewTarget(item.dataset.newRoute, { ...host, signal });
  }, { signal });
}

/**
 * DAS ANLEGEN-BLATT DES MODULS UEBER DER UEBERSICHT (DW, Ulas U2), wie das
 * Lesen seit R22 D3 (openTaskFromOverview, openEventFromOverview). Pille und
 * Speed-Dial wechselten ins Modul und klickten dort dessen FAB: die
 * Uebersicht war weg, und nach dem Speichern stand man in der Liste statt
 * dort, wo man angefangen hatte. Jetzt geht dasselbe Formular wie am FAB des
 * Moduls ueber ihr auf, und nach dem Speichern gleicht sie still ab
 * (`refresh` = refreshDashboardData, DW-P1-2): die neue Zeile steht in ihrer
 * Kachel, ohne Skelett und ohne Sprung.
 *
 * Nachgeladen beim Tipp, nicht mitgeladen: jedes Modul zieht sein Formular mit
 * sich, und dessen Gewicht gehoert nicht in den Start der Startseite
 * (test:startup-preload).
 *
 * EINKAUF BLEIBT DER WEG INS MODUL. Sein FAB oeffnet kein Formular, sondern
 * die Eingabezeile ueber der Liste, in die sie schreibt (shopping.js,
 * syncQuickAddDisclosure: "KEIN BOTTOM-SHEET"); ein Blatt dafuer gibt es nicht.
 */
const NEW_SHEETS = {
  '/tasks':    async (opts) => (await import('/pages/tasks.js')).openNewTask(opts),
  '/calendar': async (opts) => (await import('/pages/calendar.js')).openNewEvent(opts),
  '/notes':    async (opts) => (await import('/pages/notes.js')).openNewNote(opts),
};

/**
 * DER ANLEGEN-KNOPF DER ZIELSEITE, ALS ID - fuer Einkauf, und fuer jedes
 * andere Ziel der Weg, wenn sein Blatt nicht laedt: ein Fehler soll das
 * Anlegen nicht verschliessen (wie openEventFromOverview). Bis DW-P1-1 stand
 * hier ein Selektor je Ziel, und `'#btn-new-task'` ueberlebte die Umbenennung
 * in `fab-new-task` (#1483): "+ Neu > Aufgabe" landete wortlos in der Liste.
 * Eine Id fuer `findPageFab()` statt eines Selektors - der FAB lebt nach
 * `adoptPageFab()` in der Shell-Layer, und dort sucht ihn nur diese eine
 * Stelle. Dass jede Id im Markup ihrer Zielseite steht, haelt
 * `test:dashboard-clarity`.
 */
const FAB_NEW_BTN = {
  '/tasks':    'fab-new-task',
  '/calendar': 'fab-new-event',
  '/shopping': 'fab-new-item',
  '/notes':    'fab-new-note',
};

/**
 * Das Anlegen-Blatt eines Ziels oeffnen - der eine Weg fuer Pille und
 * Speed-Dial. Ueber der Uebersicht, wo das Modul eins hat (NEW_SHEETS), sonst
 * im Modul.
 *
 * DER FOKUS STEHT VORHER AUF "+ NEU". Das Blatt gibt ihn beim Schliessen an
 * das Element zurueck, das ihn beim Oeffnen hielt - das waere der Menuepunkt,
 * den Popover bzw. Speed-Dial gerade versteckt haben, und der Fokus fiele auf
 * das Dokument. Abbrechen fuehrt so an den Knopf zurueck, von dem man kam.
 * @param {string} route
 * @param {{ user?: object|null, refresh?: () => Promise<void>, signal?: AbortSignal|null }} [host]
 */
async function openNewTarget(route, { user = null, refresh = null, signal = null } = {}) {
  const sheet = NEW_SHEETS[route];
  if (sheet) {
    findPageFab('fab-main')?.focus({ preventScroll: true });
    try {
      await sheet({ user, onChanged: refresh ?? (() => {}), signal });
      return;
    } catch (err) {
      console.error('[Dashboard] Anlegen-Blatt konnte nicht geöffnet werden:', err);
    }
    // Wer die Uebersicht inzwischen verlassen hat, steht schon woanders: der
    // Weg ins Modul risse ihn von dort weg (Review p11). Das Blatt selbst
    // prueft dasselbe Signal, bevor es aufgeht.
    if (signal?.aborted) return;
  }
  await window.yuvomi.navigate(route);
  const id = FAB_NEW_BTN[route];
  if (id) findPageFab(id)?.click();
}

function renderFab() {
  // Am Desktop steht Anlegen als Pille im Kopf (renderNewPill).
  if (onDesktopStage()) return '';
  const actions = FAB_ACTIONS();
  // Kein Eintrag, kein Knopf. Ein Speed-Dial, der sich auf eine leere Liste
  // oeffnet, waere die schlechtere Haelfte des Fehlers, den der Filter behebt.
  if (!actions.length) return '';
  const actionsHtml = actions.map((a) => `
    <button type="button" class="fab-action" data-route="${a.route}" tabindex="-1"
            aria-label="${a.label}">
      <span class="fab-action__label">${a.label}</span>
      <span class="fab-action__btn" aria-hidden="true">
        <i data-lucide="${a.icon}" aria-hidden="true"></i>
      </span>
    </button>
  `).join('');

  // Der Knopf ist ein `.page-fab` und die Gruppe eine `.page-fab-group`: nur so
  // hebt `adoptPageFab()` den Speed-Dial nach dem Rendern aus dem Scrollport in
  // die Shell-Layer (#634). Backdrop und Aktionsliste liegen deshalb IN der
  // Gruppe - sie sind beide `position: fixed`/`absolute` und müssen den Umzug
  // mitmachen, sonst bleibt die halbe Mechanik im Scroller zurück.
  return `
    <div class="page-fab-group" id="fab-group">
      <div class="fab-backdrop" id="fab-backdrop"></div>
      <button type="button" class="page-fab" id="fab-main" aria-label="${t('nav.quickActions')}" title="${t('nav.quickActions')} (n)" aria-keyshortcuts="n" aria-expanded="false">
        <i data-lucide="plus" aria-hidden="true"></i>
      </button>
      <div class="fab-actions" id="fab-actions" aria-hidden="true">
        ${actionsHtml}
      </div>
    </div>
  `;
}

/**
 * Speed-Dial verdrahten - dokumentweit gesucht, nicht im Seiten-Container.
 *
 * Der Router zieht die Gruppe direkt nach dem Rendern in die Shell-Layer
 * (adoptPageFab, #634). Ein `container.querySelector('#fab-main')` fände sie
 * danach still nicht mehr, und die Verdrahtung entfiele lautlos: der Knopf wäre
 * sichtbar und täte nichts - genau der Bug hinter #634. `findPageFab()` ist die
 * eine Stelle, an der der Ort steht.
 */
/**
 * Den Speed-Dial im Anpassen-Modus ausblenden (A7 P2-1). Ausgeblendet wird der
 * KNOPF, nicht die Gruppe: `.page-fab[hidden]` (layout.css) nimmt ihn aus der
 * Anzeige, und nur an `.page-fab:not([hidden])` haengen Kapselreserve und
 * `--fab-safe-zone` - eine versteckte Gruppe liesse beide stehen und die Seite
 * einen Nachlauf fuer einen Knopf freihalten, den es nicht gibt.
 */
function setCustomizeFabHidden(hidden) {
  const fab = findPageFab('fab-main');
  if (!fab) return;
  fab.hidden = hidden;
}

function initFab(signal, host = {}) {
  const fabMain     = findPageFab('fab-main');
  const fabGroup    = fabMain?.closest('.page-fab-group');
  const fabActions  = fabGroup?.querySelector('#fab-actions');
  const fabBackdrop = fabGroup?.querySelector('#fab-backdrop');
  if (!fabMain || !fabActions) return;

  let open = false;

  function toggleFab(force) {
    open = force !== undefined ? force : !open;
    // Kein zweiter Zustandsträger neben `aria-expanded`: die Drehung zum X
    // hängt in dashboard.css direkt am Attribut.
    fabMain.setAttribute('aria-expanded', String(open));
    fabActions.classList.toggle('fab-actions--visible', open);
    fabActions.setAttribute('aria-hidden', String(!open));
    fabBackdrop?.classList.toggle('fab-backdrop--visible', open);
    fabActions.querySelectorAll('.fab-action').forEach((el) => {
      el.tabIndex = open ? 0 : -1;
    });
    if (window.lucide) window.lucide.createIcons({ el: fabGroup });
  }

  fabMain.addEventListener('click', (e) => {
    e.stopPropagation();
    // Der Kurzbefehl `n` klickt den Knopf auch, wenn er ausgeblendet ist
    // (triggerPageFab) - im Anpassen-Modus oeffnet er nichts.
    if (fabMain.hidden) return;
    toggleFab();
  });

  fabActions.querySelectorAll('[data-route]').forEach((el) => {
    const go = async () => {
      toggleFab(false);
      await openNewTarget(el.dataset.route, { ...host, signal });
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  document.addEventListener('click', () => { if (open) toggleFab(false); }, { signal });

  // ESCAPE SCHLIESST DEN DIAL, und der Fokus geht zurueck an den Knopf.
  // Vorher schloss ihn nur ein Klick irgendwohin - wer ihn mit der Tastatur
  // geoeffnet hatte, konnte ihn ohne Maus nicht mehr zumachen und stand in
  // einer Liste von vier Zielen, die er nicht angesteuert hatte (WCAG 2.1.2).
  // Der Fokus muss mitgehen: `tabIndex = -1` nimmt den Aktionen beim Schliessen
  // die Fokussierbarkeit, ein Fokus darauf faellt sonst an den Body.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    toggleFab(false);
    fabMain.focus();
  }, { signal });
}

// --------------------------------------------------------
// Eine Aufgabe aus der Übersicht öffnen (#918)
// --------------------------------------------------------

/**
 * Dieselbe Leseansicht, die das Aufgabenmodul öffnet.
 *
 * Hier stand ein eigenes Kärtchen mit zwei Knöpfen: „Bearbeiten" schickte den
 * Nutzer ins Aufgabenmodul, „Erledigt" hakte ab. Alles andere, was an einer
 * Aufgabe hängt - Teilaufgaben, Kommentare, Dokumente, die abhakbaren Zeilen
 * in der Beschreibung, die Fälligkeit, die Zuweisung - war von hier aus nicht
 * zu sehen und nicht zu erreichen.
 *
 * Das wog schwerer, als die zwei fehlenden Knöpfe klingen: Die Übersicht ist
 * die Ansicht, in der die App im Alltag steht. Das Aufgabenmodul ist die, in
 * der Aufgaben angelegt und aufgeräumt werden. Die eine bot weniger an als die
 * andere, obwohl sie öfter offen ist.
 *
 * Das Modul wird nachgeladen statt mitgeladen: Es zieht das Aufgabenformular
 * mit sich, und dessen Gewicht gehört nicht in den Start der Startseite.
 *
 * `refresh` gleicht die Uebersicht still ab (refreshDashboardData, DW-P1-2):
 * der Nutzer bleibt, wo er war - kein Skelett, kein Sprung nach oben, und
 * keine Reise ins Aufgabenmodul. `user` reist mit,
 * weil an ihm haengt, wem seine eigenen Kommentare gehoeren und wer eine
 * gesperrte Aufgabe umschreiben darf.
 */
async function openTaskFromOverview(taskId, container, refresh, user) {
  try {
    const { openTaskById } = await import('/pages/tasks.js');
    await openTaskById(taskId, { user, container, onChanged: refresh });
  } catch (err) {
    console.error('[Dashboard] Aufgabe konnte nicht geöffnet werden:', err);
    window.yuvomi?.showToast(errorSentence(err, 'tasks.loadError'), 'danger');
  }
}

/**
 * Der Termin hinter einer Kalender-Adresse (`/calendar?open=<id>&date=..`) -
 * oder null. Heute-Blatt, Termin-Kachel und Countdown nennen ihren Termin so.
 */
export function eventLinkOf(route) {
  if (typeof route !== 'string' || !route.startsWith('/calendar?')) return null;
  const params = new URLSearchParams(route.slice('/calendar?'.length));
  const id = params.get('open');
  if (!id || !/^\d+$/.test(id)) return null;
  return { id, date: params.get('date') };
}

/**
 * Ob eine Zeile der Uebersicht zu einem Termin gehoert, den das Blatt gerade
 * loescht (R22-F). `scope` ist die Angabe des Kalenders
 * (scheduleCalendarDeleteWithUndo): ein Einzeltermin oder die ganze Serie
 * nimmt alle seine Zeilen mit, "nur dieser" den einen Tag, "dieser und
 * folgende" alle Tage ab dem Vorkommen.
 */
export function eventRowRemovedBy(link, scope) {
  if (!link || !scope) return false;
  const ids = [scope.eventId, scope.seriesId].filter((id) => id != null).map(String);
  if (!ids.includes(String(link.id))) return false;
  if (scope.scope === 'this') return !link.date || link.date === scope.occurrenceDate;
  if (scope.scope === 'following') {
    const from = String(scope.recurrenceId ?? '').slice(0, 10);
    return !link.date || !from || link.date >= from;
  }
  return true;
}

/**
 * DER TERMIN OEFFNET UEBER DER UEBERSICHT (Critique R22, D3), wie die
 * Aufgabe daneben (openTaskFromOverview): das Blatt des Kalenders, die
 * Uebersicht bleibt stehen. Seit R22-F wird dort auch bearbeitet und
 * geloescht: danach gleicht die Uebersicht still ab (`refresh`), und
 * waehrend der Rueckgaengig-Frist sind die Zeilen des Termins ausgeblendet.
 * Scheitert das Laden, fuehrt die Zeile wie bisher in den Kalender - ein
 * Fehler soll den Weg nicht verschliessen.
 */
async function openEventFromOverview(link, anchor, { container = null, refresh = null, user = null, signal = null } = {}) {
  const onRemoving = (scope, removing) => {
    container?.querySelectorAll('[data-route]').forEach((row) => {
      if (eventRowRemovedBy(eventLinkOf(row.dataset.route), scope)) row.hidden = removing;
    });
  };
  try {
    const { openEventById } = await import('/pages/calendar.js');
    // `signal` ist die Lebenszeit der Uebersicht: so lange leiht das Blatt
    // calendar.css fuer sein Formular (Farbwahl, Erinnerungszeilen).
    await openEventById(link.id, { date: link.date, anchor, user, onChanged: refresh, onRemoving, signal });
  } catch (err) {
    console.error('[Dashboard] Termin konnte nicht geöffnet werden:', err);
    const params = new URLSearchParams({ open: link.id });
    if (link.date) params.set('date', link.date);
    window.yuvomi.navigate(`/calendar?${params.toString()}`);
  }
}

// --------------------------------------------------------
// Navigations-Links verdrahten
// --------------------------------------------------------

function wireLinks(container, refresh, { editing = false, user = null, signal = null } = {}) {
  wireTodayMore(container);
  wireTodayOverdue(container);
  wireTodayTimeline(container);
  container.querySelectorAll('[data-route]').forEach((el) => {
    if (el.id === 'fab-main' || el.closest('#fab-actions')) return;
    if (editing && el.closest('.widget-wrapper--editing')) return;
    // Objekt-Deep-Link (Paket 2): die Cockpit-Aufgabenzeile nennt EIN Objekt,
    // also trifft der Klick auch dieses Objekt - die Leseansicht der Aufgabe
    // wie bei den Zeilen des Tasks-Widgets, statt den Nutzer in der
    // Aufgabenliste erneut suchen zu lassen (Critique P3).
    // Essen-Zeile bewusst ohne Sonderweg: /meals öffnet die aktuelle Woche und
    // scrollt den Heute-Slot selbst in den Blick (meals.js, day-header--today).
    if (!editing && el.dataset.objectKind === 'task' && el.dataset.objectId) {
      const show = () => openTaskFromOverview(el.dataset.objectId, container, refresh, user);
      el.addEventListener('click', show);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
      });
      return;
    }
    // Ein Termin oeffnet sein Blatt ueber der Uebersicht (R22, D3); Cmd- und
    // Mittelklick auf einen Link behalten unten ihren neuen Tab.
    const eventLink = editing ? null : eventLinkOf(el.dataset.route);
    const go = eventLink
      ? () => openEventFromOverview(eventLink, el, { container, refresh, user, signal })
      : () => window.yuvomi.navigate(el.dataset.route);
    if (el.tagName === 'A') {
      el.addEventListener('click', (e) => {
        // DER BROWSER BEHÄLT SEINEN KLICK. Ein bedingungsloses
        // `preventDefault()` nimmt dem `<a href>` genau das wieder weg, wofür
        // der Widget-Kopf von `<button>` auf Link umgestellt wurde: Cmd- und
        // Mittelklick öffnen einen neuen Tab, Shift ein Fenster. Ohne diese
        // Zeile wäre der href ein Versprechen, das der Handler bricht.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        go();
      });
    } else {
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
  });

  // Der Weg zur Pflege der Schnellzugriffe geht von der Kachel aus (#469): die
  // Reihe hat keine Seite, weil sie kein Modul ist. Im Anpassen-Modus nicht -
  // dort zieht man Kacheln, man bearbeitet ihren Inhalt nicht.
  if (!editing) {
    container.querySelectorAll('[data-quick-links-manage]').forEach((el) => {
      // Erst beim Tipp geladen (Critique R19): der Verwalter samt Sortierung
      // lag sonst in der Startkette jeder Uebersicht, geoeffnet wird er selten.
      el.addEventListener('click', async () => {
        const { openQuickLinksManager } = await import('/components/quick-links-manager.js');
        openQuickLinksManager({ onChange: refresh });
      });
    });
  }

  // Task-Items öffnen die Leseansicht statt zu navigieren (#918)
  if (editing) return;
  // Die Countdown-Zeile einer Aufgabe hängt an demselben Griff (#647): sie
  // nennt ein Objekt, also trifft der Klick dieses Objekt. Ein eigener Handler
  // daneben wäre ein zweiter Weg zur selben Handlung.
  container.querySelectorAll('.task-item[data-task-id], .countdown-item[data-task-id]').forEach((el) => {
    const show = () => openTaskFromOverview(el.dataset.taskId, container, refresh, user);
    el.addEventListener('click', show);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
    });
  });
}

function reorderWidgetConfig(config, fromId, toId, placement = 'before') {
  const fromIdx = config.findIndex((w) => w.id === fromId);
  let toIdx = config.findIndex((w) => w.id === toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return config;
  const next = config.map((w) => ({ ...w }));
  const [moved] = next.splice(fromIdx, 1);
  if (fromIdx < toIdx) toIdx -= 1;
  if (placement === 'after') toIdx += 1;
  next.splice(toIdx, 0, moved);
  return next.map((w, i) => ({ ...w, order: i }));
}

/* DER LOCH-HINWEIS IM BEARBEITEN-MODUS (Critique 2026-09-23).
 *
 * Das Raster packt immer dicht; was dann noch leer bleibt, liegt an den
 * GROESSEN - drei Breitkacheln in drei Spalten lassen rechts je eine Zelle
 * frei, weil keine spaetere Kachel hineinpasst. Das loest keine Reihenfolge,
 * nur eine andere Groesse, und die schlaegt der Bearbeiten-Modus vor: EINE
 * Aenderung, nach der kein Loch bleibt und das Raster nicht hoeher wird. Gibt
 * es keine, schweigt er - ein Hinweis ohne Ausweg waere Laerm.
 *
 * Die Spans kommen aus dem Stylesheet, nicht aus einer zweiten Tabelle: welche
 * Groesse in welcher Breite wie viele Spalten und Zeilen belegt, steht nur in
 * dashboard.css. Fuer eine Kandidaten-Groesse wird die Klasse kurz getauscht
 * und der berechnete Stil gelesen - ein Stil-Recalc, kein Layout, und der
 * Tausch ist zurueckgenommen, bevor der Browser das naechste Bild malt. */
function gridSpans(el) {
  const cs = getComputedStyle(el);
  const span = (start, end) => Number(/span (\d+)/.exec(`${start} ${end}`)?.[1] || 1);
  return { cols: span(cs.gridColumnStart, cs.gridColumnEnd), rows: span(cs.gridRowStart, cs.gridRowEnd) };
}

/* Die Spuren einer Groesse: die Breite aus dem Stylesheet (Klasse kurz
 * tauschen, lesen, zurueck), die Hoehe aus den Daten der Kachel
 * (`data-span-sizes`, U1 b) - plus der Abstand, den der Rahmen traegt
 * (`--tile-gap-rows`, steckt in der gelesenen Spanne).
 *
 * GELESEN WIRD DIE GEWAEHLTE SPANNE, NICHT DIE GEFUELLTE. Seit der
 * Anpassen-Modus fuellt wie die Ansicht (DW-P2-9), traegt eine Kachel dort
 * schon die Spanne, mit der sie ein Loch schliesst (`data-col-fill`,
 * `data-row-fill`, `data-col-lock`). Gelesen mit ihr, sah der Hinweis das Loch
 * nie, das er beseitigen soll: gemessen 1440px, die Uhr zwischen Geburtstagen
 * und Aufgaben stand mit 202px Geist ueber den Notizen, und kein Hinweis. Die
 * Fuellung geht fuer die Probe mit der Klasse weg und kommt mit ihr zurueck. */
const FILL_ATTRIBUTES = ['data-col-fill', 'data-row-fill', 'data-col-lock'];

function spansForSize(el, size) {
  const current = [...el.classList].find((c) => c.startsWith('widget-size--'));
  const probe = widgetSizeClass(size);
  const own = Number(el.dataset?.spanRows);
  const content = spanRowsForSize(el, size);
  const withContent = (spans) => (content && own ? { ...spans, rows: spans.rows - own + content } : spans);
  const fills = FILL_ATTRIBUTES.filter((name) => el.hasAttribute(name));
  const swap = current && current !== probe;
  if (!swap && !fills.length) return withContent(gridSpans(el));
  for (const name of fills) el.removeAttribute(name);
  if (swap) el.classList.replace(current, probe);
  try {
    return withContent(gridSpans(el));
  } finally {
    if (swap) el.classList.replace(probe, current);
    for (const name of fills) el.setAttribute(name, '');
  }
}

function gridColumnCount(grid) {
  return getComputedStyle(grid).gridTemplateColumns.split(' ').filter((v) => v && v !== 'none').length;
}

/* DIE SPANNEN EINER GROESSE STEHEN IM STYLESHEET, NICHT IN DER KACHEL (DW-P2-1).
 * Um zu wissen, welche Groesse ein Loch schliesst, probiert der Hinweis jede
 * Groesse an jeder Kachel aus (spansForSize: Klasse tauschen, lesen, zurueck) -
 * bei 22 Kacheln 66 Proben, und jede legte das Raster zur Auslegung frei: nach
 * jeder Anpassen-Geste ein zweites volles Layout (gemessen 4x CPU ~25 ms).
 * Was eine Probe misst, haengt nur an der Groessenklasse, den Spuren, die die
 * Kachel in jeder Groesse belegt (`data-span-sizes`, U1 b), und den Spuren des
 * Rasters - darum gilt sie je Spurbild, und nach der ersten Runde misst eine
 * Geste nichts mehr nach. */
const tileSpanMemo = new Map();
function memoSpans(el, size, tracks) {
  const key = `${tracks}|${size}|${el.dataset?.spanRows ?? ''}|${el.dataset?.spanSizes ?? ''}`;
  let spans = tileSpanMemo.get(key);
  if (!spans) {
    spans = spansForSize(el, size);
    if (tileSpanMemo.size > 200) tileSpanMemo.clear();
    tileSpanMemo.set(key, spans);
  }
  return spans;
}

function gridHoleSuggestion(grid) {
  const tracks = getComputedStyle(grid).gridTemplateColumns;
  const columns = tracks.split(' ').filter((v) => v && v !== 'none').length;
  if (columns < 2) return null;
  const items = [...grid.querySelectorAll(':scope > .widget-wrapper[data-widget-id]')].map((el) => {
    const size = [...el.classList].find((c) => c.startsWith('widget-size--'))?.slice('widget-size--'.length) ?? '1x1';
    return { id: el.dataset.widgetId, el, size, ...memoSpans(el, size, tracks) };
  });
  return suggestGridHoleFill(items, columns,
    (item) => WIDGET_SIZE_PRESETS.map((p) => ({ size: p.value, ...memoSpans(item.el, p.value, tracks) })));
}

/* WAS BREITE IN INHALT UMSETZT (DW-P2-6, U1 b): das Wetter zeigt in der
 * Breite mehr Tage (4 ab 640px Kachelbreite, 5 ab 860px), in derselben Hoehe.
 * Jede andere Kachel zeigte breiter nur dasselbe groesser. */
const FILL_WIDE_WIDGETS = new Set(['weather']);

/**
 * DAS RASTER HAT KEIN LOCH - UND KEINE KACHEL HOEHE OHNE INHALT (R10 L9,
 * R21 D5, neu gefasst mit U1 b). Nach der dichten Packung sind die Kacheln so
 * hoch wie ihre Daten (`--tile-rows`); was dann noch frei ist:
 *   - rechts neben dem Wetter waechst das Wetter hinein (`rowFillSpans`,
 *     nur `wide`) und zeigt dort mehr Tage;
 *   - ein Loch, unter dem noch eine Kachel steht, fuellt die Kachel darueber
 *     (`columnFillSpans`);
 *   - ein Spaltenende, laenger als ein Kachelabstand, ist auch ein Loch (F9):
 *     eine Kachel daneben waechst in die Breite, sonst die letzte der Spalte
 *     in die Hoehe. Ein kuerzeres laeuft ruhig aus.
 * Beides ist Darstellung (`data-row-fill`/`data-col-fill`), gespeichert bleibt
 * die gewaehlte Groesse.
 *
 * DER ANPASSEN-MODUS ZEIGT DASSELBE RASTER (DW-P2-9, WYSIWYG): er fuellte nicht,
 * und der Lueckenhinweis schlug dann eine Korrektur fuer eine Luecke vor, die
 * ausserhalb nie stand. Jetzt fuellt er wie der Normalmodus; die Hoehe, die
 * eine Kachel nur zum Fuellen bekommt, steht dort als Geist
 * (`--tile-ghost-rows`, dashboard.css) - man sieht, was Inhalt ist und was
 * Platz.
 *
 * Gemessen wird mit abgenommenem Wachstum - die Spans kommen aus Groessenklasse
 * und Daten, nicht aus der letzten Runde dieser Funktion.
 */
const seenGridColumns = new WeakMap();

function applyRowFill(grid, { editing = false, columns: knownColumns = null } = {}) {
  // Nur, was im Raster steht: ein verborgenes Kind belegt keine Zelle.
  const tiles = [...grid.children].filter((el) => getComputedStyle(el).display !== 'none');
  /* ERST LESEN, DANN SCHREIBEN (DW-P2-4). Die Kacheln sind Container
   * (`container: dashboard-widget`); ein `getComputedStyle` nach dem ersten
   * gesetzten Fuell-Attribut verlangte darum Stil UND Layout der ganzen
   * Flaeche noch einmal - gemessen 8 ms bei 4x CPU, mitten im Seitenwechsel.
   * Ein frisch gezeichnetes Raster traegt noch keine Fuellung: dort wird
   * alles vorab gelesen. Nur ein Raster, das schon gefuellt war (neue
   * Spaltenzahl, eine Geste), muss erst zuruecksetzen, damit die Spannen die
   * gewaehlten sind und nicht die gefuellten. */
  const filled = tiles.some((el) => 'rowFill' in el.dataset || 'colFill' in el.dataset);
  const read = () => {
    const columns = knownColumns ?? gridColumnCount(grid);
    seenGridColumns.set(grid, columns);
    if (columns < 2) return { columns, items: [] };
    return {
      columns,
      items: tiles.map((el, index) => {
        const spans = gridSpans(el);
        return {
          id: el.dataset.widgetId || `#${index}`,
          el,
          ...spans,
          wide: FILL_WIDE_WIDGETS.has(el.dataset.widgetId) && spans.cols >= 2,
          // Die Kennzahlreihe waechst nicht (so hoch wie ihre Kacheln, `align-self: start`).
          grow: !el.querySelector(':scope > .metric-tiles'),
        };
      }),
    };
  };
  const early = filled ? null : read();
  for (const el of grid.children) {
    if ('colLock' in el.dataset) {
      delete el.dataset.colLock;
      el.style.removeProperty('--tile-col');
      el.style.removeProperty('--tile-span-cols');
    }
    if ('rowFill' in el.dataset) {
      delete el.dataset.rowFill;
      el.style.removeProperty('--widget-fill-span');
    }
    if ('colFill' in el.dataset) {
      delete el.dataset.colFill;
      el.style.removeProperty('--widget-fill-rows');
      el.style.removeProperty('--tile-ghost-rows');
      delete el.dataset.ghostBlock;
    }
  }
  const { columns, items: read0 } = early ?? read();
  if (columns < 2) {
    // Einspaltig wird nichts gestreckt, also steht auch keine Zusatzzeile (U14).
    for (const el of grid.children) if (el.dataset?.fillShown) showFillRows(el, 0);
    return;
  }
  // Packen und Fuellen: eine reine Rechnung (fillGridSpans, utils/dashboard-widgets.js).
  const items = read0;
  const spans = fillGridSpans(items, columns);
  // Die Spalte breiter und gewachsener Kacheln steht fest: gleich frueh,
  // weniger Loch (packGrid), und wer nach links waechst, beginnt dort (F9).
  spans.forEach((item, i) => {
    if (item.col === undefined) return;
    items[i].el.dataset.colLock = '';
    items[i].el.style.setProperty('--tile-col', String(item.col + 1));
    items[i].el.style.setProperty('--tile-span-cols', String(Math.min(items[i].cols, columns)));
  });
  spans.forEach((item, i) => {
    const own = items[i];
    if (item.cols !== own.cols) {
      item.el.dataset.rowFill = '';
      item.el.style.setProperty('--widget-fill-span', String(item.cols));
      // Kein Geist fuer Breite (F9): der Inhalt laeuft ueber die ganze Breite,
      // ein Schlitz am Rand laege ueber ihm.
    }
    // HOEHE WIRD INHALT (U14): was die Packung einer Liste an Hoehe zuteilt,
    // fuellen ihre geladenen Zeilen, soweit sie ganz hineinpassen. Gelesen
    // wird nur, was der Renderer ausgerechnet hat (`data-fill-steps`).
    const base = Number(item.el.dataset?.spanRows) || 0;
    const steps = String(item.el.dataset?.fillSteps ?? '').split(',').map(Number).filter((n) => n > 0);
    const extra = steps.length && base ? fillRowCount(steps, base + item.rows - own.rows) : 0;
    if (steps.length || item.el.dataset?.fillShown) showFillRows(item.el, extra);
    if (item.rows !== own.rows) {
      item.el.dataset.colFill = '';
      item.el.style.setProperty('--widget-fill-rows', String(item.rows));
      // Im Anpassen-Modus steht als Geist nur, was danach noch Platz ist.
      const ghost = item.rows - own.rows - (extra ? steps[extra - 1] - base : 0);
      if (editing && ghost > 0) {
        item.el.dataset.ghostBlock = '';
        item.el.style.setProperty('--tile-ghost-rows', String(ghost));
      }
    }
  });
}

/* Zeigt die ersten `k` Zusatzzeilen einer Kachel (U14) und zaehlt "+N weitere"
 * herunter. Schreibt nur, was sich aendert; liest kein Layout. */
function showFillRows(el, k) {
  if ((Number(el.dataset.fillShown) || 0) === k) return;
  if (k) el.dataset.fillShown = String(k);
  else delete el.dataset.fillShown;
  el.querySelectorAll('[data-fill-row]').forEach((row, i) => row.toggleAttribute('data-fill-on', i < k));
  el.querySelectorAll('[data-fill-group]').forEach((group) => group.toggleAttribute('data-fill-on', k > 0));
  for (const more of el.querySelectorAll('[data-fill-more]')) {
    more.dataset.moreBase ??= more.textContent;
    const rest = (Number(more.dataset.moreRest) || 0) - k;
    const done = rest <= 0 ? more.dataset.moreDone ?? '' : '';
    more.toggleAttribute('data-fill-gone', rest <= 0 && !done);
    more.textContent = done || (rest > 0 && more.dataset.moreKey ? t(more.dataset.moreKey, { count: rest }) : more.dataset.moreBase);
  }
}

function renderGridHint(suggestion) {
  const preset = WIDGET_SIZE_PRESETS.find((p) => p.value === suggestion.size);
  const text = t('dashboard.gridHoleHint', {
    widget: widgetLabel(suggestion.id),
    size: preset ? t(preset.labelKey) : suggestion.size,
  });
  return `
    <div class="dashboard-grid-hint" role="status">
      <p class="dashboard-grid-hint__text">${esc(text)}</p>
      <button type="button" class="btn btn--ghost" data-grid-hint-apply
              data-widget-id="${esc(suggestion.id)}" data-size="${esc(suggestion.size)}">${esc(t('dashboard.gridHoleApply'))}</button>
    </div>`;
}

function updateWidgetConfig(config, id, patch) {
  return config.map((w) => w.id === id ? { ...w, ...patch } : w)
    .map((w, i) => ({ ...w, order: i }));
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

// Dependencies injiziert, damit die Funktion ohne DOM/`navigator`-Globals testbar ist.
export async function maybeUpdateAutoLocation({ autoLocateEnabled, geolocation, putPreferences }) {
  if (!autoLocateEnabled || !geolocation) return false;
  try {
    const position = await new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 });
    });
    await putPreferences({
      weather_user: {
        lat: position.coords.latitude.toFixed(4),
        lon: position.coords.longitude.toFixed(4),
        // Stadt-Label gehört zu den alten Koordinaten — Override löschen, damit das Widget
        // auf die "lat, lon"-Anzeige zurückfällt statt einen veralteten Namen zu zeigen.
        city: null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function render(container, { user, signal: routeSignal = null } = {}) {
  _fabController?.abort();
  // Zwei Achsen, ein Controller (#976/#977): das Router-Signal faellt beim
  // Verlassen der Seite, der eigene Controller beim naechsten eigenen Aufbau.
  // Alles, was dieser Aufbau verdrahtet, haengt an `signal` - nicht am
  // Modul-Feld, sonst registrierte ein ueberholter Aufbau seine Timer am
  // Controller des neueren. Ein verspaeteter Neuaufbau nach dem Verlassen
  // zeichnet gar nichts mehr.
  if (routeSignal?.aborted) return;
  const controller = createPageController(routeSignal);
  _fabController = controller;
  const { signal } = controller;
  dashboardViewer = user ?? null;

  // Der Wand-Modus ist ein Zustand DIESER Seite, kein zweiter Ort: die Route,
  // die Daten, der stille Refresh und die Echo-Regel bleiben dieselben - nur
  // Massstab, Dichte und Bedienbarkeit aendern sich. Ob er laeuft, hat der
  // Router bereits an der Wurzel vermerkt (utils/wall-mode.js).
  const wallMode = isWallActive();

  // Ein frischer Stand von eben zeichnet sofort (`_overviewMemo`, oben) - dann
  // gibt es kein Skelett: der Inhalt steht, bevor der Browser ein Bild malt.
  watchOverviewWrites();
  const memo = wallMode ? null : usableOverviewMemo(_overviewMemo, {
    key: overviewMemoKey(user),
    now: new Date(),
    today: householdToday(),
  });

  // Die zuletzt gezeichnete Hoehe des Kopfbands bei dieser Fenstergroesse.
  const head = wallMode || memo ? null : headHint(viewportKey());
  setHtml(container, `
    <div class="dashboard app-page app-page--dashboard${wallMode ? ' dashboard--wall' : ''}" data-composition="dashboard">
      <h1 class="sr-only">${t('dashboard.title')}</h1>
      <div class="dashboard-shell" id="dashboard-shell">
        ${wallMode ? renderWallSurface(null, null, { loading: true }) : memo ? '' : renderDashboardSkeleton(user, { head })}
      </div>
    </div>
    ${wallMode ? '' : renderFab()}
  `);
  if (!wallMode && !memo && globalThis.window?.matchMedia?.('(min-width: 768px)').matches) {
    // Das Skelett-Raster packt wie das echte (applyRowFill): gleiche Spalten,
    // gleiche Spannen. Erst ab zwei Spalten - einspaltig gibt es nichts zu
    // fuellen, und das Lesen kostete am Telefon ein Layout der ganzen Shell
    // vor dem ersten Bild (gemessen rund 50 ms bei 4x CPU).
    const skeletonGrid = container.querySelector('#dashboard-shell > .dashboard__grid');
    if (skeletonGrid) applyRowFill(skeletonGrid);
  }
  // Das Plus des Speed-Dials steht im ERSTEN Bild, nicht erst mit den Daten
  // (DW-P2-5: eine violette Scheibe ohne Zeichen, solange das Skelett stand).
  createPendingIcons(container.querySelector('#fab-group'));

  // Der Zonen-Hinweis fuer Bestandshaushalte (#1607): ein Admin, dessen Browser
  // in einer anderen Zone steht, als der Haushalt ohne eigene Einstellung
  // rechnet, wird hier einmal gefragt. HIER und nicht nach den Daten: der Stand
  // dazu liegt seit dem Anmelden vor (router.js), die Zeile steht also schon
  // neben dem Skelett. Sie haengt neben `.dashboard-shell`, nicht darin - die
  // Shell wird mit den Daten neu gefuellt.
  mountZonePrompt(container.querySelector('.dashboard'), {
    user, t, api, wall: wallMode,
    before: container.querySelector('#dashboard-shell'),
    toast: (message, type) => window.yuvomi?.showToast(message, type),
    sentence: (error) => errorSentence(error, 'settings.preferenceSaveFailed'),
  });
  // ERSTE SCHRITTE (R23 D14): nach dem Rundgang drei Wege - Familie, Module,
  // Region - an derselben Stelle wie der Zonen-Hinweis, vom ersten Bild an
  // (utils/first-steps.js). Den Haken der Mitglieder setzt das Laden.
  const mountSteps = () => mountFirstSteps(container.querySelector('.dashboard'), {
    user, t, wall: wallMode,
    before: container.querySelector('#dashboard-shell'),
    navigate: (path) => window.yuvomi?.navigate(path),
  });
  let firstSteps = mountSteps();

  // Ein Neuaufbau AUS DER SEITE HERAUS laeuft nicht durch renderPage() im
  // Router, und damit an dessen FAB-Wechsel vorbei (#634): den alten Knopf aus
  // der Shell-Ebene raeumen, den neuen aus dem Container dorthin heben. Der
  // synchrone Teil von render() hat den Speed-Dial schon gelegt - oder, auf der
  // Wand, keinen. Ohne diesen Schritt stand beim Betreten der alte Knopf auf der
  // Wand und nach dem Verlassen der neue ohne Plus im Scrollport (#1588).
  const rerender = () => {
    const done = render(container, { user, signal: routeSignal });
    window.yuvomi?.replacePageFab?.();
    return done;
  };
  // Steht keine Wand mehr (Ausstieg, Einstellungen), gehoert der Marker nicht
  // mehr ihr - sonst kostete die naechste Zurueck-Geste einen Tipp ins Leere.
  if (!wallMode) releaseWallMarker();

  // DER TIMER HAENGT NICHT AN DEN DATEN (Review zu #844). Die Wandflaeche wird
  // erst verdrahtet, wenn das Dashboard geladen hat - der Timer aber ist von
  // diesen Daten unabhaengig, und ein Neuzeichnen bricht den vorigen Controller
  // sofort ab. Startete jemand einen Timer, waehrend die Anfrage haengt, waeren
  // Takt und `data-wall-timer` weg, bis die Antwort kommt: die Anzeige stuende
  // still, es laeutete nicht, und der Screensaver duerfte sich darueberlegen.
  //
  // Er wird deshalb verdrahtet, sobald die Flaeche im DOM steht. Der Aufruf
  // nach dem Laden bleibt und ersetzt diesen hier - `wireWallTimer` raeumt
  // seinen vorigen Takt selbst ab.
  if (wallMode) {
    wireWallTimer(container.querySelector('.wall'), rerender, signal, { announce: announceDashboard });
    // Der Ausstieg gehoert zur selben Sorte: er haengt an nichts, was geladen
    // wird. Einmal verdrahtet, ueber den Container - er ueberlebt das zweite
    // Rendern und braucht keinen zweiten Aufruf.
    wireWallExit(container, rerender, signal);
  }

  let data         = { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], shoppingLists: [], birthdays: [], countdowns: [], users: [], budget: {}, rewards: {}, health: {}, housekeeping: {} };
  // Ein Stand von vorhin darf keine Kachel versprechen: erst nach dem Laden
  // wieder wahr (siehe die Notiz an `countdownAvailable`).
  setCountdownAvailability([]);
  setWeatherAvailability(null, null);
  let weather      = null;
  let weatherPrefs = null;
  let weatherAutoLocate = false;
  let widgetConfig = buildDefaultWidgetConfig();
  let savedWidgetConfig = buildDefaultWidgetConfig();
  // Das Kopfband „Heute auf einen Blick" ist kein Rasterkachel, folgt aber
  // derselben Anpassen-Grammatik wie die Widgets: ausblenden am Block, zurueck
  // ueber die Chip-Leiste, und es faehrt in denselben Speicher-, Abbruch- und
  // Ruecknahme-Zyklus mit (#740). Persoenlich wie `dashboard_widgets` (#585):
  // beide liegen im selben PUT, und ein haushaltweites Kopfband neben einer
  // persoenlichen Anordnung hiesse, dass ein Ausblenden je nach Element mal
  // mich und mal alle traefe.
  let glanceVisible = true;
  let savedGlanceVisible = true;
  // Folge ich der Vorgabe des Haushalts, habe ich nichts Eigenes gespeichert -
  // dann gibt es auch nichts zurueckzusetzen (#827).
  let followsDefault = true;
  const canPublish = user?.role === 'admin';
  // Die Wand fragt die Haushaltsfassung der Uebersicht ab (#1817,
  // `dashboardRequest`). JEDER Abruf dieser Seite geht hier durch - auch der
  // stille Refresh, sonst stuende nach einer Viertelstunde wieder die
  // persoenliche Fassung an der Wand. Die faelligen Erinnerungen ebenso
  // (`loadPendingReminders`): sie sind die zweite Antwort, die davon abhaengt,
  // wer fragt.
  const overviewRequest = (query) => dashboardRequest(query, { wall: wallMode });
  let isCustomizing = false;
  let screensaverEnabled = false;
  let currency     = 'EUR';
  let visibleMealTypes = MEAL_ORDER;
  let loadFailed   = false;
  let loadErrorStatus = null;
  // Zeitpunkt des letzten geglueckten Datenstands - der Anker im Masthead (A8).
  // Bleibt `null`, solange nichts geladen wurde: eine Uhrzeit ohne Daten
  // dahinter waere die falscheste aller Angaben.
  let lastLoadedAt = null;
  // Zeit und Haushaltstag des letzten VOLLEN Stands - die Rueckkehr in den
  // Tab vergleicht sie. Gemerkt wird der Tag VOR der Anfrage: der Server legt
  // ihn beim Eingang fest, und eine Antwort, die erst nach Mitternacht
  // ankommt, zeigt noch den alten Tag. Ein Teilstand (`partial`, der
  // Filterwechsel) reicht Erinnerungen und Dienstplan vom alten Stand weiter
  // und zaehlt deshalb nicht als frisch.
  let freshAt = null;
  let freshDay = null;
  const markLoaded = (day, { partial = false } = {}) => { lastLoadedAt = new Date(); if (!partial) { freshAt = lastLoadedAt; freshDay = day; } };
  try {
    const requestDay = householdToday();
    // Aus dem gemerkten Stand dieselben vier Antworten - samt der Slices, die
    // er schon traegt (die ensure*-Aufrufe unten fragen dann nichts; die
    // stille Nachfrage danach holt sie neu, siehe refreshDashboardData).
    const [dashRes, weatherRes, prefsRes, remindersRes] = memo
      ? [memo.data, memo.weatherRes, { data: memo.prefs }, memo.data.pendingReminders]
      : await Promise.all([
        api.get(overviewRequest(layoutHintQuery('/dashboard'))),
        api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null })),
        // Beim Start hat der Router dieselbe Antwort schon unterwegs und reicht
        // sie herein (utils/start-handoff.js) - sonst zwei `/preferences` je
        // Kaltstart. Danach gibt es nichts mehr abzuholen, und die Seite fragt selbst.
        (window.yuvomi?.takeStartPreferences?.() ?? api.get('/preferences')).catch(() => ({ data: {} })),
        loadPendingReminders(overviewRequest),
      ]);
    // Ueberholt oder verlassen, waehrend die Antworten unterwegs waren (#977):
    // dieser Aufbau gehoert niemandem mehr und faesst die Flaeche nicht an.
    if (signal.aborted) return;
    primeMealTypeNames(prefsRes?.data);
    data         = dashRes;
    firstSteps.update(Array.isArray(data?.users) ? data.users.length : null);
    /* Die Zahlen an den Nav-Zielen und Modulkacheln kommen aus derselben
     * Antwort (#868). Sie hier hereinzureichen spart die zweite Aggregation,
     * die der Shell-Aufbau sonst beim Anmelden anstiess - `layoutHintQuery`
     * schraenkt sie allerdings ein, und eine eingeschraenkte Zahl ist eine
     * andere Zahl, also nimmt der Speicher sie nur ungefiltert an. Die Stufe
     * der Kalender-Kachel (`events_limit`, #1680) ist kein Filter: sie aendert
     * keine Zahl, und mit ihr als „gefiltert" holte der Router die Antwort bei
     * jedem Kaltstart ein zweites Mal (`dashboardQueryFiltersCounts`). */
    if (!memo) window.yuvomi?.primeModuleCountsFrom?.(dashRes, {
      filtered: dashboardQueryFiltersCounts(overviewRequest(layoutHintQuery('/dashboard'))),
    });
    // Geburtstags-Termine tragen serverseitig einen sprachneutralen Titel
    // („Birthday: <Name>"); anhand von birthday_name in die aktive Sprache
    // übersetzen (Issue #524). Ein gemerkter Stand ist schon uebersetzt.
    if (!memo) localizeEventLists(data);
    setCountdownAvailability(data?.countdowns);
    weather      = weatherRes.data ?? null;
    weatherPrefs = prefsRes.data ?? null;
    setWeatherAvailability(weatherRes, weatherPrefs);
    weatherAutoLocate = Boolean(prefsRes.data?.weather_user?.auto_locate ?? prefsRes.data?.weather_auto_locate);
    widgetConfig = childDefaultFor(
      normalizeDashboardConfigWithExtensions(prefsRes.data?.dashboard_widgets ?? buildDefaultWidgetConfig()),
      user,
      prefsRes.data?.dashboard_follows_default !== false,
    );
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    /* WIDGET-OPTIONEN KOMMEN EINEN SCHRITT ZU SPAET (#814): die Uebersicht und
     * die Praeferenzen laufen absichtlich parallel los, aber welche Filter
     * gelten, steht erst in der Antwort der zweiten. Die erste Abfrage nimmt
     * deshalb den Pfad, den dieses Geraet zuletzt gebraucht hat
     * (`layoutHintQuery`, dieselbe Vorhersage wie beim Skelett) - im
     * Regelfall stimmt er, und es bleibt bei einer Abfrage.
     *
     * Stimmt er nicht, wird nachgeholt, und zwar VOR dem ersten Zeichnen: sonst
     * saehe man kurz Termine, die man ausgeblendet hat. Die Alternative - erst
     * Praeferenzen, dann Uebersicht - kostete JEDEN Aufruf eine Rundreise, auch
     * die ohne Optionen. */
    if (!memo && dashboardQuery(widgetConfig) !== layoutHintQuery('/dashboard')) {
      try {
        const filtered = await api.get(overviewRequest(dashboardQuery(widgetConfig)));
        if (signal.aborted) return;
        localizeEventLists(filtered);
        data = filtered;
        setCountdownAvailability(data?.countdowns);
      } catch { /* die ungefilterte Antwort steht bereits - lieber mehr als nichts */ }
    }
    data.pendingReminders = remindersRes;
    glanceVisible = prefsRes.data?.dashboard_today_glance !== false;
    savedGlanceVisible = glanceVisible;
    followsDefault = prefsRes.data?.dashboard_follows_default !== false;
    // Das Skelett des NAECHSTEN Aufrufs lernt hier seine Kachelform.
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
    screensaverEnabled = Boolean(prefsRes.data?.screensaver_enabled);
    currency     = prefsRes.data?.currency ?? 'EUR';
    visibleMealTypes = normalizeVisibleMealTypes(prefsRes.data?.visible_meal_types);
    // Ein gemerkter Stand behaelt seine Zeit: er ist nicht frischer, weil er
    // noch einmal gezeichnet wird.
    if (memo) {
      lastLoadedAt = memo.lastLoadedAt;
      freshAt = memo.at;
      freshDay = memo.day;
    } else {
      markLoaded(requestDay);
    }
  } catch (err) {
    console.error('[Dashboard] Ladefehler:', err, 'Status:', err.status ?? 'network');
    loadFailed = true;
    loadErrorStatus = Number.isFinite(err?.status) ? err.status : null;
  }

  // Zyklus-Slice strikt owner-only nachladen: Zyklusdaten sind privat und dürfen
  // nicht in den familienweiten /dashboard-Payload. Einmal je Stand (data.cycle
  // bleibt sonst undefined = „noch nie geladen"; der stille Refresh setzt ihn
  // zurueck und holt neu). Ein Fehler lässt die Kachel auf ihren
  // Onboarding-Empty fallen, statt das Dashboard zu kippen.
  async function ensureCycleSlice() {
    if (data.cycle !== undefined) return;
    if (window.yuvomi?.isModuleDisabled('health')) return;
    try {
      const [periodsRes, settingsRes] = await Promise.all([
        api.get('/health/cycle/periods'),
        api.get('/health/cycle/settings').catch(() => ({ data: {} })),
      ]);
      data.cycle = { periods: periodsRes.data || [], settings: settingsRes.data || {} };
    } catch (err) {
      console.error('[Dashboard] Zyklus-Slice Ladefehler:', err);
      data.cycle = null;
    }
  }

  // Eigener Slice wie Zyklus, aber aus einem anderen Grund: nicht Privatsphaere,
  // sondern weil /dashboard das Modul schlicht nicht mitfuehrt. `/schedule/entries`
  // ohne user_id liefert schon den ganzen Haushalt (dieselbe Abfrage, die die
  // Schedule-Seite fuer ihre eigene „Heute"-Karte nutzt); die Typenliste daneben
  // unterscheidet „niemand hat heute Dienst" von „das Modul ist noch leer".
  async function ensureScheduleSlice() {
    if (data.schedule !== undefined) return;
    if (window.yuvomi?.isModuleDisabled('schedule')) return;
    try {
      data.schedule = await loadScheduleSlice(householdToday());
    } catch (err) {
      console.error('[Dashboard] Schedule-Slice Ladefehler:', err);
      data.schedule = null;
    }
  }

  // Eigener Slice aus demselben Grund wie Schedule: /dashboard fuehrt Waste
  // nicht mit. Zwei parallele Aufrufe wie beim Schedule-Slice (Entries + Typen) -
  // hier "naechste Abholung je Typ" UND die Quellen-Liste, weil "braucht
  // Auffrischung" (invariant #6) ein Source-Feld ist, kein Feld der Occurrence
  // selbst (siehe Kommentar an renderWasteWidget).
  async function ensureWasteSlice() {
    if (data.waste !== undefined) return;
    if (window.yuvomi?.isModuleDisabled('waste')) return;
    try {
      const [nextRes, sourcesRes] = await Promise.all([
        api.get('/waste/occurrences/next'),
        api.get('/waste/sources'),
      ]);
      // Per-type widget option (#1063 Phase 10), same shape as tasks' own
      // category filter: no selection (or every type selected) means "all" -
      // an empty picked list would otherwise be an empty widget for anyone
      // who only ever opened the options dialog.
      const selectedTypes = widgetConfig.find((w) => w.id === 'waste')?.options?.types;
      const items = nextRes.data ?? [];
      data.waste = {
        items: (selectedTypes?.length ? items.filter((i) => selectedTypes.includes(i.type.id)) : items),
        needsRefresh: (sourcesRes.data ?? []).some((s) => s.needs_refresh),
      };
    } catch (err) {
      console.error('[Dashboard] Waste-Slice Ladefehler:', err);
      data.waste = null;
    }
  }

  // Nur wenn die opt-in-Kachel sichtbar ist — die Mehrheit ohne aktivierte Kachel
  // löst keinen Request aus.
  if (!loadFailed && widgetConfig.some((w) => w.id === 'cycle' && w.visible)) {
    await ensureCycleSlice();
  }
  if (!loadFailed && widgetConfig.some((w) => w.id === 'schedule' && w.visible)) {
    await ensureScheduleSlice();
  }
  if (!loadFailed && widgetConfig.some((w) => w.id === 'waste' && w.visible)) {
    await ensureWasteSlice();
  }
  // Auch die Nachlade-Runden koennen von einem Verlassen oder Neuaufbau
  // ueberholt worden sein (#977).
  if (signal.aborted) return;

  // Den vollen Stand fuer den Rueckweg merken (`_overviewMemo`, oben): mit den
  // Slices, damit ein Aufbau daraus nichts mehr fragen muss.
  const rememberOverview = () => {
    if (wallMode || loadFailed || !freshAt) return;
    _overviewMemo = {
      key: overviewMemoKey(user),
      at: freshAt,
      day: freshDay,
      lastLoadedAt,
      data,
      weatherRes: { data: weather },
      prefs: weatherPrefs,
    };
  };
  rememberOverview();


  // Einziger Persist-Pfad für Inline- UND Modal-Speichern. Legt vor dem Schreiben
  // einen Schnappschuss an und bietet — wenn sich etwas geändert hat — im Toast ein
  // „Rückgängig" an, das den vorherigen Stand wiederherstellt (inkl. Server).
  /** Die Uebersicht neu holen, wenn sich die Filter geaendert haben (#814). */
  async function reloadIfQueryChanged(previousQuery) {
    if (dashboardQuery(widgetConfig) === previousQuery) return;
    try {
      const requestDay = householdToday();
      const fresh = await api.get(overviewRequest(dashboardQuery(widgetConfig)));
      localizeEventLists(fresh);
      fresh.cycle = data.cycle;
      fresh.schedule = data.schedule;
      fresh.waste = data.waste;
      fresh.pendingReminders = data.pendingReminders;
      data = fresh;
      setCountdownAvailability(data?.countdowns);
      markLoaded(requestDay, { partial: true });
    } catch { /* der alte Stand bleibt stehen, statt die Seite zu leeren */ }
  }

  async function persistWidgetConfig(nextConfig) {
    const previousConfig = savedWidgetConfig.map((w) => ({ ...w }));
    const previousQuery = dashboardQuery(savedWidgetConfig);
    widgetConfig = nextConfig.map((w) => ({ ...w }));
    const previousGlance = savedGlanceVisible;
    await api.put('/preferences', { dashboard_widgets: widgetConfig, dashboard_today_glance: glanceVisible });
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    // Ab jetzt liegt ein eigener Stand vor - die Vorgabe des Haushalts erreicht
    // mich erst wieder, wenn ich ihn loesche.
    followsDefault = false;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
    isCustomizing = false;
    // Wird die Zyklus-Kachel gerade erst eingeblendet, ihren owner-only Slice
    // nachladen — sonst zeigte sie fälschlich den Empty-State bis zum Reload.
    if (widgetConfig.some((w) => w.id === 'cycle' && w.visible)) await ensureCycleSlice();
    if (widgetConfig.some((w) => w.id === 'schedule' && w.visible)) await ensureScheduleSlice();
    // Waste's Typ-Option (#1063 Phase 10) reist nicht in dashboardQuery() mit
    // (der Slice ist ein eigenstaendiger Client-Fetch, siehe ensureWasteSlice) -
    // reloadIfQueryChanged() wuerde den alten, ungefilterten Stand also
    // stillschweigend behalten. Ein geaenderter Typ-Filter verwirft ihn
    // deshalb hier gezielt, statt bis zum naechsten vollen Seitenaufbau zu
    // warten (dieselbe Sofort-Zusage wie bei Kalender/Aufgaben-Optionen).
    const wasteOptionsChanged = JSON.stringify(previousConfig.find((w) => w.id === 'waste')?.options ?? null)
      !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null);
    if (wasteOptionsChanged) data.waste = undefined;
    if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
    await reloadIfQueryChanged(previousQuery);
    rebuildDashboard(widgetConfig);

    const changed = !sameWidgetConfig(previousConfig, widgetConfig) || previousGlance !== glanceVisible;
    const onUndo = changed
      ? async () => {
          const queryBeforeUndo = dashboardQuery(widgetConfig);
          const wasteOptionsBeforeUndo = JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null);
          try {
            widgetConfig = previousConfig.map((w) => ({ ...w }));
            glanceVisible = previousGlance;
            await api.put('/preferences', { dashboard_widgets: widgetConfig, dashboard_today_glance: glanceVisible });
            savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
            savedGlanceVisible = glanceVisible;
            rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
            if (wasteOptionsBeforeUndo !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null)) data.waste = undefined;
            if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
            await reloadAfterSave(() => reloadIfQueryChanged(queryBeforeUndo));
          } catch {
            window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
          }
          isCustomizing = false;
          rebuildDashboard(widgetConfig);
        }
      : null;
    window.yuvomi?.showToast(t('dashboard.customizeSaved'), 'success', onUndo ? 6000 : 1500, onUndo);
  }

  async function saveDashboardConfig() {
    try {
      await persistWidgetConfig(widgetConfig);
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
    }
  }

  function cancelDashboardConfig() {
    widgetConfig = savedWidgetConfig.map((w) => ({ ...w }));
    glanceVisible = savedGlanceVisible;
    isCustomizing = false;
    rebuildDashboard(widgetConfig);
  }

  /* ABBRECHEN FRAGT, SOBALD ES ETWAS ZU VERLIEREN GIBT (Re-Critique
   * 2026-09-27, A7 P2-5). Ein Fehlgriff neben „Speichern" warf die ganze
   * Anordnung wortlos weg. Ohne Aenderung bleibt der Ausgang ein Tipp - eine
   * Rueckfrage ohne Folge waere nur Reibung. Nach dem Verwerfen steht der Fokus
   * wieder auf „Anpassen", wie nach jedem Moduswechsel. */
  // Die eine Rueckfrage fuer Abbrechen UND Verlassen.
  const confirmDiscardCustomize = () => confirmModal(t('modal.unsavedChanges'), {
    danger: true,
    confirmLabel: t('modal.discardChanges'),
    detail: t('dashboard.customizeDiscardDetail'),
  });

  async function requestCancelDashboardConfig() {
    if (customizeHasChanges({ widgetConfig, savedWidgetConfig, glanceVisible, savedGlanceVisible })) {
      const confirmed = await confirmDiscardCustomize();
      if (!confirmed || !isCustomizing) return;
    }
    focusAfterRebuild = ['#dashboard-customize-btn'];
    cancelDashboardConfig();
  }

  // Verlassen-Schutz, solange angepasst wird (siehe customizeLeaveAllowed).
  // Beim Verlassen wird nicht neu gezeichnet - die Seite geht ohnehin; nur der
  // Modus endet, damit ein spaeter Neuaufbau nicht im Anpassen landet.
  let releaseLeaveGuard = null;
  const syncLeaveGuard = () => {
    if (isCustomizing && !releaseLeaveGuard) {
      releaseLeaveGuard = setLeaveGuard(() => customizeLeaveAllowed({
        customizing: () => isCustomizing,
        changed: () => customizeHasChanges({ widgetConfig, savedWidgetConfig, glanceVisible, savedGlanceVisible }),
        askDiscard: confirmDiscardCustomize,
        discard: () => {
          widgetConfig = savedWidgetConfig.map((w) => ({ ...w }));
          glanceVisible = savedGlanceVisible;
          isCustomizing = false;
          syncLeaveGuard();
        },
      }));
    } else if (!isCustomizing && releaseLeaveGuard) {
      releaseLeaveGuard();
      releaseLeaveGuard = null;
    }
  };
  signal.addEventListener('abort', () => { releaseLeaveGuard?.(); releaseLeaveGuard = null; }, { once: true });

  /* „ZURÜCKSETZEN" HATTE SEIT #585 ZWEI PLAUSIBLE BEDEUTUNGEN und lieferte eine
   * dritte (Critique 2026-08-16). Solange die Anordnung dem Haushalt gehörte,
   * war „auf Standard" eindeutig. Seit sie der Person gehört, kann der Satz auch
   * „zurück zu dem, was die Familie hatte" oder „zurück zu meinem letzten Stand"
   * heißen - und keine der beiden trifft zu.
   *
   * SEIT #827 IST ES DER RÜCKWEG ZUR VORGABE, und zwar durch LÖSCHEN des
   * eigenen Standes, nicht durch Hineinladen der Vorgabe in den Editor. Der
   * Unterschied zeigt sich erst später: ein hineingeladenes und gespeichertes
   * Layout friert die heutige Vorgabe auf dem Konto ein, und die nächste
   * Änderung des Admins erreicht mich nie wieder. Deshalb schreibt diese
   * Funktion `null` und wartet nicht auf „Speichern" - sie IST das Speichern. */
  async function resetDashboardConfig() {
    const confirmed = await confirmModal(t('dashboard.customizeResetConfirm'), {
      confirmLabel: t('dashboard.customizeReset'),
      detail: t('dashboard.customizeResetDetail'),
    });
    if (!confirmed) return;
    const previousConfig = savedWidgetConfig.map((w) => ({ ...w }));
    const previousGlance = savedGlanceVisible;
    const previousQuery = dashboardQuery(savedWidgetConfig);
    try {
      const res = await api.put('/preferences', { dashboard_widgets: null, dashboard_today_glance: null });
      widgetConfig = childDefaultFor(
        normalizeDashboardConfigWithExtensions(res.data?.dashboard_widgets ?? buildDefaultWidgetConfig()),
        user,
        true,
      );
      glanceVisible = res.data?.dashboard_today_glance !== false;
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      return;
    }
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    followsDefault = true;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
    isCustomizing = false;
    if (widgetConfig.some((w) => w.id === 'cycle' && w.visible)) await ensureCycleSlice();
    if (widgetConfig.some((w) => w.id === 'schedule' && w.visible)) await ensureScheduleSlice();
    // Siehe die Notiz an derselben Zeile in persistWidgetConfig() - der Reset
    // kann eine eigene Typ-Auswahl verwerfen, und dashboardQuery() traegt sie
    // nicht mit.
    const wasteOptionsChanged = JSON.stringify(previousConfig.find((w) => w.id === 'waste')?.options ?? null)
      !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null);
    if (wasteOptionsChanged) data.waste = undefined;
    if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
    // Die Vorgabe kann andere Filter tragen als mein geloeschter Stand (#814).
    await reloadIfQueryChanged(previousQuery);
    rebuildDashboard(widgetConfig);
    // Ein Zurücksetzen ist so umkehrbar wie jedes andere Speichern (#821):
    // der vorherige eigene Stand wird zurückgeschrieben, nicht nachgebaut.
    window.yuvomi?.showToast(t('dashboard.customizeResetDone'), 'success', 6000, async () => {
      // Der Stand, fuer den die aktuell angezeigten Daten geholt wurden.
      const queryBeforeUndo = dashboardQuery(widgetConfig);
      const wasteOptionsBeforeUndo = JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null);
      try {
        widgetConfig = previousConfig.map((w) => ({ ...w }));
        glanceVisible = previousGlance;
        await api.put('/preferences', { dashboard_widgets: widgetConfig, dashboard_today_glance: glanceVisible });
        savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
        savedGlanceVisible = glanceVisible;
        followsDefault = false;
        rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
        if (wasteOptionsBeforeUndo !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null)) data.waste = undefined;
        if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
        await reloadAfterSave(() => reloadIfQueryChanged(queryBeforeUndo));
      } catch {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      }
      isCustomizing = false;
      rebuildDashboard(widgetConfig);
    });
  }

  /* DIE VORGABE DES HAUSHALTS (#827) entsteht dort, wo man eine Übersicht
   * ohnehin einrichtet - im Anpassen-Modus. Ein zweites Arrangier-Werkzeug in
   * den Einstellungen wäre eine zweite Fassung derselben Oberfläche, und die
   * beiden liefen auseinander.
   *
   * WER DER VORGABE FOLGT, HÄNGT SICH MIT DEM VERÖFFENTLICHEN NICHT AB: für ihn
   * wird nichts Persönliches geschrieben. Ein Admin, der die Vorgabe setzt und
   * damit stillschweigend einen eigenen Stand bekäme, verlöre jede spätere
   * Änderung eines zweiten Admins - und würde es nicht merken. */
  async function publishHouseholdDefault() {
    const confirmed = await confirmModal(t('dashboard.customizeSetDefaultConfirm'), {
      confirmLabel: t('dashboard.customizeSetDefault'),
      detail: t('dashboard.customizeSetDefaultDetail'),
    });
    if (!confirmed) return;
    const previousQuery = dashboardQuery(savedWidgetConfig);
    const payload = {
      dashboard_widgets_default: widgetConfig,
      dashboard_today_glance_default: glanceVisible,
    };
    if (!followsDefault) {
      payload.dashboard_widgets = widgetConfig;
      payload.dashboard_today_glance = glanceVisible;
    }
    try {
      await api.put('/preferences', payload);
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      return;
    }
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig), drawnSpanOf);
    isCustomizing = false;
    // Wie beim Speichern: haben sich mit den Optionen die Parameter der Abfrage
    // geaendert, steht noch die alte Antwort da. Ohne den Abruf zeigte die
    // Kachel nach „Als Vorgabe fuer alle" weiter fuenf Termine, obwohl gerade
    // zwoelf veroeffentlicht wurden (#1680) - und „nur meine" weiter alle.
    await reloadIfQueryChanged(previousQuery);
    rebuildDashboard(widgetConfig);
    window.yuvomi?.showToast(t('dashboard.customizeSetDefaultDone'), 'success');
  }

  // Beobachtet im Bearbeiten-Modus die Spaltenzahl des Rasters: ein Loch, das
  // bei drei Spalten bleibt, gibt es bei zwei vielleicht nicht - und umgekehrt.
  let gridHintObserver = null;
  signal.addEventListener('abort', () => gridHintObserver?.disconnect(), { once: true });
  // Und im Normalmodus dieselbe Beobachtung fuer das Wachstum in den
  // Zeilenrest: Spaltenzahl und Kachelzahl (Erweiterungs-Widgets haengen sich
  // spaeter ein) entscheiden, wer waechst. Die Hoehe allein nicht - sonst
  // loeste das eigene Wachstum die naechste Runde aus.
  let rowFillObserver = null;
  signal.addEventListener('abort', () => rowFillObserver?.disconnect(), { once: true });

  let tileSizeObserver = null;
  let headSizeObserver = null;
  signal.addEventListener('abort', () => { tileSizeObserver?.disconnect(); headSizeObserver?.disconnect(); }, { once: true });

  function wireRowFill() {
    rowFillObserver?.disconnect();
    rowFillObserver = null;
    tileSizeObserver?.disconnect();
    tileSizeObserver = null;
    headSizeObserver?.disconnect();
    headSizeObserver = null;
    const grid = container.querySelector('#dashboard-widget-grid');
    if (!grid) return;
    if (!isCustomizing) {
      rememberGridHint(drawnTiles, widgetConfig);
      tileSizeObserver = watchTileSizes(grid);
      headSizeObserver = watchHeadSize(container.querySelector('#dashboard-shell'));
    }
    applyRowFill(grid, { editing: isCustomizing });
    // Nach der Packung stehen die Breiten fest: eine Kennzahlkachel, deren Wert
    // auch auf der Stufe ihrer Reihe nicht passt, tritt eine Stufe zurueck
    // (DW-P2-7). Der ResizeObserver darin misst bei jeder Breitenaenderung neu.
    fitMetricLeads(grid);
    if (typeof ResizeObserver !== 'function') return;
    let shape = `${gridColumnCount(grid)}:${grid.childElementCount}`;
    rowFillObserver = new ResizeObserver(() => {
      const next = `${gridColumnCount(grid)}:${grid.childElementCount}`;
      if (next === shape) return;
      shape = next;
      applyRowFill(grid, { editing: isCustomizing });
    });
    rowFillObserver.observe(grid);
  }

  /* DER LUECKENHINWEIS IN ZWEI SCHRITTEN (DW-P2-1): erst lesen, ob sich der
   * Vorschlag aendert (planGridHint - liest nur, was das Gleiten ohnehin
   * auslegen liess), dann schreiben (applyGridHint). Eine Geste schreibt ihn
   * erst nach dem naechsten Bild: ein neuer oder anderer Hinweis veraendert
   * die Hoehe ueber dem Raster, und im selben Task kostete das eine zweite
   * Auslegung der ganzen Flaeche (gemessen 4x CPU ~20 ms je Geste). Das
   * Raster gleitet dann an seine neue Oberkante (playGridShift). */
  function planGridHint(grid) {
    const suggestion = gridHoleSuggestion(grid);
    const apply = container.querySelector('.dashboard-grid-hint [data-grid-hint-apply]');
    if (!suggestion) return apply ? { suggestion: null } : null;
    if (apply?.dataset.widgetId === suggestion.id && apply.dataset.size === suggestion.size) return null;
    return { suggestion };
  }

  function applyGridHint(grid, plan) {
    if (!plan) return;
    const { suggestion } = plan;
    const shown = container.querySelector('.dashboard-grid-hint');
    if (!suggestion) {
      shown?.remove();
      return;
    }
    const apply = shown?.querySelector('[data-grid-hint-apply]');
    if (apply) {
      // Ein anderer Vorschlag wechselt nur seine Worte im selben Knoten.
      const [next] = elementsFromHtml(renderGridHint(suggestion));
      const text = shown.querySelector('.dashboard-grid-hint__text');
      if (text) text.textContent = next.querySelector('.dashboard-grid-hint__text')?.textContent ?? '';
      apply.dataset.widgetId = suggestion.id;
      apply.dataset.size = suggestion.size;
      return;
    }
    // VOR dem Raster, nicht dahinter: das Loch steht oft oben, und ein Hinweis
    // unter zwanzig Kacheln waere einer, den man erst nach dem Scrollen findet.
    grid.insertAdjacentHTML('beforebegin', renderGridHint(suggestion));
    container.querySelector('.dashboard-grid-hint [data-grid-hint-apply]')?.addEventListener('click', (event) => {
      // Der Vorschlag steht am Knopf: er wechselt mit den Gesten (oben).
      const { widgetId: id, size } = event.currentTarget.dataset;
      widgetConfig = updateWidgetConfig(widgetConfig, id, { size });
      patchCustomize();
      // Der Hinweis geht nach dem naechsten Bild; der Fokus geht schon jetzt
      // zur Groesse, die er gesetzt hat.
      const tile = `.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`;
      restoreFocusAfterRebuild(container, [`${tile} [data-widget-size-preset="${CSS.escape(size)}"]`, `${tile} [data-widget-hide]`]);
    });
  }

  function syncGridHint(grid) {
    applyGridHint(grid, planGridHint(grid));
  }

  // Der juengste nachgereichte Hinweis gewinnt - eine schnelle zweite Geste
  // ueberholt den der ersten.
  let pendingHint = 0;
  function applyGridHintAfterPaint(grid, plan) {
    const token = ++pendingHint;
    if (!plan) return;
    requestAnimationFrame(() => setTimeout(() => {
      if (token !== pendingHint || signal.aborted || !isCustomizing || !grid.isConnected) return;
      const shell = container.querySelector('#dashboard-shell');
      const top = grid.getBoundingClientRect().top;
      // Der Vorschlag kann inzwischen ein anderer sein (Spalten, Fenster).
      applyGridHint(grid, planGridHint(grid));
      if (shell) playGridShift(shell, top);
    }, 0));
  }

  /* DIE GESTE AENDERT, WAS SIE AENDERT (DW-P2-1).
   *
   * Bis hierher baute jede Anpassen-Geste die ganze Uebersicht neu: Kopf,
   * Heute-Blatt, zweiundzwanzig Kacheln, alle Zeichen, alle Messungen - fuer
   * EINE geaenderte Kachel. Gemessen bei 4x CPU 120-240 ms je Tipp, davon bis
   * 170 ms erzwungenes Layout. Jetzt folgt die Flaeche dem neuen Stand an Ort
   * und Stelle:
   *   - Verschieben haengt die vorhandenen Kacheln um (arrangeChildren,
   *     `moveBefore` wo vorhanden - der gedrueckte Knopf behaelt den Fokus);
   *   - Groesse und Optionen tauschen die Klasse und zeichnen nur den Koerper
   *     dieser einen Kachel, wenn sein Markup sich ueberhaupt aendert;
   *   - Aus nimmt die Kachel heraus, Ein setzt sie an ihren Platz, und die
   *     Ablage bekommt bzw. verliert genau ihren Chip;
   *   - was von der Sichtbarkeit abhaengt, faellt mit: die Kennzahlreihe
   *     (sie schweigt fuer sichtbare Domaenen), das Heute-Blatt (Kein-Echo) und
   *     die Wetterzeile im Kopf - jeweils nur, wenn das neue Markup ein anderes ist.
   * Die Leisten folgen per syncCustomizeControls, die Nachbarn gleiten
   * (playTileFlip). Im Anpassen-Modus waechst nichts in den Zeilenrest
   * (applyRowFill), und der Layout-Hinweis lernt erst beim Speichern - dort
   * baut die Seite ohnehin neu, im Normalmodus.
   * `focus`: wohin der Fokus geht, wenn sein Knopf mit der Geste gegangen ist. */
  function patchCustomize({ focus = [] } = {}) {
    if (signal.aborted || !isCustomizing || wallMode || loadFailed) return;
    const shell = container.querySelector('#dashboard-shell');
    const grid = shell?.querySelector('#dashboard-widget-grid');
    if (!grid) return;
    const before = captureTileRects(shell);
    // Geht der gedrueckte Knopf mit der Geste (Aus, Ein), wechselt der Fokus
    // VOR dem Umbau zum Nachfolger, wenn es ihn schon gibt (der Nachbar): ein
    // fokussiertes Element zu entfernen zwang den Browser mitten im Umbau zu
    // einer Stilrechnung der ganzen Flaeche (gemessen 4x CPU ~24 ms). Der
    // Nachbar ruecht an den Platz des gegangenen - die Ansicht bleibt stehen.
    const early = focus.length ? focusTarget(container, focus) : null;
    if (early && early !== document.activeElement) early.focus({ preventScroll: true });
    const active = document.activeElement;
    const cfg = widgetConfig;
    // Kein Echo: das Heute-Blatt spricht fuer die Domaenen ohne Kachel - und
    // nur eine geaenderte Sichtbarkeit (oder Option) aendert, was es sagt.
    // Gezeichnet VOR dem ersten Schreiben: es liest die Breite seiner Buehne
    // (todayStage), und mitten im Umbau verlangte das eine Auslegung der
    // halbfertigen Flaeche.
    const visibility = visibilityKey(cfg, glanceVisible);
    const visibilityChanged = visibility !== drawnVisibility;
    drawnVisibility = visibility;
    const cockpitHtml = visibilityChanged ? renderTodayCockpit(data, cfg, true) : drawnCockpit;
    const renderers = dashboardTileRenderers(cfg, data, weather, currency, {
      visibleMealTypes, glanceHidden: !glanceVisible, familyManage: familyManageHref(user),
    });
    const previous = new Map(drawnTiles.map((w) => [w.id, w]));
    const present = new Map([...grid.querySelectorAll(':scope > .widget-wrapper[data-widget-id]')]
      .map((el) => [el.dataset.widgetId, el]));
    const listed = [];
    const nodes = [];
    // Was neues Markup bekam - es braucht Zeichen und seine Verdrahtung.
    const fresh = [];
    for (const w of cfg) {
      if (!dashboardTileListed(w, renderers)) continue;
      const old = present.get(w.id);
      // Die Kennzahlreihe liest die Sichtbarkeit der anderen (renderMetricTiles).
      const redraw = !old || tileDrawKey(previous.get(w.id)) !== tileDrawKey(w) || (w.id === 'metrics' && visibilityChanged);
      const body = redraw ? renderWidgetBody(w, renderers) : drawnBodies.get(w.id);
      if (!body) continue;
      listed.push(w);
      if (!old) {
        const [el] = elementsFromHtml(renderWidgetWrapper(w, body, { editing: true }));
        nodes.push(el);
        fresh.push(el);
      } else {
        if (redraw) {
          old.classList.remove(...[...old.classList].filter((name) => name.startsWith('widget-size--')));
          old.classList.add(widgetSizeClass(w.size));
          if (tileBodyChanged(w, body, drawnBodies.get(w.id))) {
            // Der Koerper bringt seine Hoehe mit (U1 b): andere Groesse, andere Zeilenzahl.
            setTileSpan(old, body);
            for (const child of [...old.children]) if (!child.matches('[data-widget-controls]')) child.remove();
            old.append(...elementsFromHtml(body));
            fresh.push(old);
          }
        }
        nodes.push(old);
      }
      drawnBodies.set(w.id, body);
    }
    drawnTiles = listed;
    arrangeChildren(grid, nodes);
    if (!nodes.length) grid.insertAdjacentHTML('afterbegin', emptyHintHTML(t('dashboard.allWidgetsHidden'), { icon: 'layout-dashboard' }));
    nodes.forEach((el, index) => {
      const menu = syncCustomizeControls(el, listed[index], index, nodes.length);
      if (menu) fresh.push(menu);
    });

    // Die Ablage: genau der Chip, der kommt oder geht.
    const trayHtml = renderHiddenWidgetsTray(cfg, !glanceVisible);
    const tray = shell.querySelector('.widget-restore');
    if (!trayHtml) {
      tray?.remove();
    } else if (!tray) {
      const [el] = elementsFromHtml(trayHtml);
      grid.before(el);
      fresh.push(el);
    } else {
      const chipKey = (el) => (el.matches('[data-glance-show]') ? '' : el.querySelector(':scope > [data-widget-show]')?.dataset.widgetShow);
      const list = tray.querySelector('.widget-restore__chips');
      const have = new Map([...list.children].map((el) => [chipKey(el), el]));
      const [next] = elementsFromHtml(trayHtml);
      arrangeChildren(list, [...next.querySelector('.widget-restore__chips').children].map((el) => {
        const kept = have.get(chipKey(el));
        if (kept) return kept;
        fresh.push(el);
        return el;
      }));
    }

    // Ohne Nachmessen: die Buehne las das Blatt oben am sauberen Layout, und
    // eine Kachel aendert sie nicht; die Zeilenzahl am Telefon (measurePhoneProgram)
    // zaehlt im Anpassen-Modus nicht - dort ist das Blatt auf seinen Kopf
    // zusammengeklappt. Das Speichern baut ohnehin neu und misst.
    let sheet = null;
    if (cockpitHtml !== drawnCockpit) {
      drawnCockpit = cockpitHtml;
      replaceProgramSheet(shell, cockpitHtml);
      sheet = shell.querySelector('.today-cockpit');
      createPendingIcons(sheet);
    }
    // Die Wetterzeile im Kopf schweigt, solange die Karte im Raster steht.
    const weatherCardShown = cfg.some((w) => w.id === 'weather' && w.visible) && isWidgetModuleEnabled('weather');
    shell.querySelector('.dashboard-overview__weather')?.classList.toggle('dashboard-overview__weather--card', weatherCardShown);

    for (const el of fresh) createPendingIcons(el);
    wireFreshTiles(shell, fresh.filter((el) => el.matches('.widget-wrapper')));
    // DASSELBE RASTER WIE AUSSERHALB (DW-P2-9, WYSIWYG): neu gefuellt nach den
    // Spannen, die die Geste gesetzt hat - ohne Neuaufbau, und ohne Auslegung:
    // die Spaltenzahl ist die der letzten (sie aendert keine Geste).
    applyRowFill(grid, { editing: true, columns: seenGridColumns.get(grid) });
    // Ab hier wird gelesen, alles an EINER Auslegung des neuen Stands, und erst
    // danach geschrieben. Jede Animation und jeder Fokuswechsel vor einer
    // Lesung verlangte eine neue Stilrechnung der ganzen Flaeche (gemessen
    // 4x CPU 15-18 ms je Runde, bis zu drei Runden je Geste).
    // Das neue Blatt zuerst: seine Zeitleiste setzt ihre Fahne nach gemessener
    // Lage (placeTodayTimelineFlag) und schreibt nur an der Fahne.
    if (sheet) wireLinks(sheet, refreshAfterSheet, { editing: true, user, signal });
    // Ging der Knopf mit der Geste, geht der Fokus zum Nachfolger (`focus`).
    const successor = active?.isConnected ? null : focusTarget(container, focus);
    const flip = measureTileFlip(shell, before);
    // Der Lueckenhinweis wird hier nur gelesen; geschrieben nach dem naechsten Bild.
    const hintPlan = planGridHint(grid);
    // Der Nachfolger steht meist daneben: nur so weit scrollen, wie er es
    // braucht (wie `block: 'nearest'`) - `focus()` allein holte ihn in die
    // Mitte, und die ganze Seite sprang unter dem Finger weg.
    const scroller = successor ? shell.closest('.app-content') : null;
    const scrollBy = scroller ? nearestScrollDelta(successor.getBoundingClientRect(), scroller.getBoundingClientRect()) : 0;
    // Schreiben. Blieb der Knopf, bleibt der Fokus dort (ohne moveBefore nahm
    // das Umhaengen ihn mit).
    if (active?.isConnected) {
      if (document.activeElement !== active && active !== document.body) active.focus({ preventScroll: true });
    } else {
      successor?.focus({ preventScroll: true });
      if (scrollBy) scroller.scrollTop += scrollBy;
    }
    startTileFlip(flip);
    applyGridHintAfterPaint(grid, hintPlan);
  }

  /** Was eine neu gezeichnete Kachel ausser Markup braucht (wie im Neuaufbau). */
  function wireFreshTiles(shell, wrappers) {
    if (!wrappers.length) return;
    const ids = new Set(wrappers.map((el) => el.dataset.widgetId));
    if (isCustomizing) attachSizeIndicators(shell.querySelector('#dashboard-widget-grid'), editWiring?.signal);
    for (const el of wrappers) {
      wireRecipeThumbs(el);
      fitMetricLeads(el);
      if (isExtensionWidget(el.dataset.widgetId)) void mountExtensionWidgets(el, widgetConfig, user);
    }
    if (ids.has('fasting')) {
      disposeFastingClock();
      disposeFastingClock = wireFastingWidget(container, refreshAfterSheet, data.fasting, signal, { editing: isCustomizing });
    }
    if (ids.has('notes')) {
      disposeNoteCategories();
      disposeNoteCategories = wireNoteCategoryOverflow(
        shell,
        (count) => getNumberFormat().format(count),
        (count) => t('noteCategories.moreAction', { count }),
      );
    }
    if (ids.has('weather')) {
      wireWeatherRefresh(container, (updatedWeather) => {
        weather = updatedWeather;
        rebuildDashboard(widgetConfig);
      }, signal);
    }
  }

  // Die Verdrahtung des Anpassen-Modus haengt an Raster und Flaeche, die eine
  // Geste ueberleben (patchCustomize): einmal je Aufbau, nicht je Knopf.
  let editWiring = null;
  signal.addEventListener('abort', () => editWiring?.abort(), { once: true });

  function wireDashboardEditMode() {
    gridHintObserver?.disconnect();
    gridHintObserver = null;
    editWiring?.abort();
    editWiring = null;
    if (!isCustomizing) return;
    const shell = container.querySelector('#dashboard-shell');
    const grid = container.querySelector('#dashboard-widget-grid');
    if (!shell || !grid) return;
    editWiring = new AbortController();
    const wired = { signal: editWiring.signal };
    // Groessen-Menue (R9 M7): Position, Pfeiltasten, Schliessen - einmal an der
    // stabilen Seitenwurzel, idempotent ueber sein data-Attribut.
    installPopoverMenus(container);

    syncGridHint(grid);
    attachSizeIndicators(grid, editWiring.signal);
    if (typeof ResizeObserver === 'function') {
      let columns = gridColumnCount(grid);
      gridHintObserver = new ResizeObserver(() => {
        const next = gridColumnCount(grid);
        if (next === columns) return;
        columns = next;
        syncGridHint(grid);
      });
      gridHintObserver.observe(grid);
    }

    const resize = (btn) => {
      const size = btn.dataset.widgetSizePreset;
      if (!WIDGET_SIZE_OPTIONS.includes(size)) return;
      // Aus dem Groessen-Menue (R9 M7): der Fokus gehoert danach dem Knopf,
      // der das Menue oeffnete - der Eintrag steht in einem geschlossenen
      // Panel und naehme ihn nicht an.
      const menu = btn.closest('.popover-menu');
      if (menu) {
        menu.hidePopover?.();
        grid.querySelector(`[popovertarget="${CSS.escape(menu.id)}"]`)?.focus();
      }
      widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetId, { size });
      // Der Fokus bleibt auf demselben Knopf (die Leiste wird nicht neu
      // gezeichnet), und der traegt jetzt aria-pressed - gesagt wird trotzdem,
      // was sich geaendert hat: die Kachel ist gewachsen, nicht der Knopf.
      patchCustomize();
      const preset = WIDGET_SIZE_PRESETS.find((p) => p.value === size);
      announceDashboard(t('dashboard.customizeSizeDone', {
        widget: widgetLabel(btn.dataset.widgetId),
        size: preset ? t(preset.labelKey) : size,
      }));
    };

    const editOptions = async (btn) => {
      const id = btn.dataset.widgetOptions;
      // Aus einem Menue (Kachel, Chip der Ablage): der Dialog gibt den Fokus
      // dem zurueck, der ihn beim Oeffnen hielt - das soll der Ausloeser sein,
      // nicht der Eintrag im geschlossenen Menue.
      const menu = btn.closest('.popover-menu');
      if (menu) {
        menu.hidePopover?.();
        shell.querySelector(`[popovertarget="${CSS.escape(menu.id)}"]`)?.focus({ preventScroll: true });
      }
      const current = widgetConfig.find((w) => w.id === id)?.options ?? {};
      const next = await openWidgetOptions(id, current);
      if (next === null || signal.aborted || !isCustomizing) return;
      // Ein leeres Optionsobjekt wird zu „keine Optionen": so bleibt der
      // gespeicherte Stand identisch mit dem eines Layouts, das den Dialog
      // nie gesehen hat.
      widgetConfig = updateWidgetConfig(widgetConfig, id,
        Object.keys(next).length ? { options: next } : { options: undefined });
      patchCustomize();
    };

    /* WER AUSBLENDET, VERLIERT SEINEN KNOPF - UND DARF DESHALB NICHT DEN FOKUS
     * VERLIEREN. Die Kachel geht samt Knopf, und der Fokus fiel bis hierher auf
     * <body> zurueck: wer per Tastatur drei Kacheln ausblenden wollte, stand
     * nach der ersten wieder am Seitenanfang. Er geht deshalb zum gleichen
     * Knopf der Nachbarkachel (so laesst sich eine Reihe nacheinander
     * abraeumen), und wo es keine gibt, zum Chip, der sie zurueckholt. Beim
     * Einblenden spiegelbildlich. */
    const neighbourIds = (el, selector, attr) => {
      const next = el?.nextElementSibling?.closest(selector) ? el.nextElementSibling : null;
      const prev = el?.previousElementSibling?.closest(selector) ? el.previousElementSibling : null;
      return [next, prev].map((n) => n?.getAttribute(attr) ?? n?.querySelector(`[${attr}]`)?.getAttribute(attr))
        .filter(Boolean);
    };

    const hide = (btn) => {
      const id = btn.dataset.widgetHide;
      const wrapper = btn.closest('.widget-wrapper');
      const focus = [
        ...neighbourIds(wrapper, '.widget-wrapper', 'data-widget-id')
          .map((n) => `.widget-wrapper[data-widget-id="${CSS.escape(n)}"] [data-widget-hide]`),
        `[data-widget-show="${CSS.escape(id)}"]`,
      ];
      widgetConfig = updateWidgetConfig(widgetConfig, id, { visible: false });
      patchCustomize({ focus });
      announceDashboard(t('dashboard.customizeHiddenDone', { widget: widgetLabel(id) }));
    };

    // Wieder-Einblenden aus der Ablage (ausserhalb des Rasters): der Gegenpart
    // zum Ausblenden, macht den Inline-Editor komplett.
    const show = (btn) => {
      const id = btn.dataset.widgetShow;
      const focus = [
        ...neighbourIds(btn.closest('.widget-restore-chip-group') ?? btn, '.widget-restore-chip-group, [data-glance-show]', 'data-widget-show')
          .map((n) => `[data-widget-show="${CSS.escape(n)}"]`),
        `.widget-wrapper[data-widget-id="${CSS.escape(id)}"] [data-widget-hide]`,
      ];
      widgetConfig = updateWidgetConfig(widgetConfig, id, { visible: true });
      patchCustomize({ focus });
      announceDashboard(t('dashboard.customizeShownDone', { widget: widgetLabel(id) }));
    };

    // Kopfband: beide Knoepfe sitzen ausserhalb des Rasters (der eine im
    // Heute-Blatt, der andere in der Ablage).
    const glance = (visible) => {
      glanceVisible = visible;
      patchCustomize({ focus: [visible ? '[data-glance-hide]' : '[data-glance-show]'] });
      announceDashboard(t(visible ? 'dashboard.customizeShownDone' : 'dashboard.customizeHiddenDone', { widget: t('dashboard.todayTitle') }));
    };

    /* EIN WEG FUER JEDES UMORDNEN. Hoch/Runter (Finger, Screenreader), die
     * Pfeiltasten am Griff und das Ziehen (SortableJS, unten) legen eine Kachel
     * neben eine andere - ueber dasselbe reorderWidgetConfig und denselben
     * Patch (patchCustomize), nie ueber einen Neuaufbau. Gesagt wird der neue
     * Platz: wohin sie gerutscht ist, sieht nur, wer hinsieht. */
    const placeWidget = (id, targetId, placement) => {
      widgetConfig = reorderWidgetConfig(widgetConfig, id, targetId, placement);
      patchCustomize();
      const order = [...grid.querySelectorAll(':scope > .widget-wrapper[data-widget-id]')]
        .map((w) => w.dataset.widgetId);
      announceDashboard(t('dashboard.customizeMovedTo', {
        widget: widgetLabel(id), position: order.indexOf(id) + 1, total: order.length,
      }));
    };

    const moveWidget = (id, dir) => {
      const wrapper = grid.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
      const sibling = dir === 'up' ? wrapper?.previousElementSibling : wrapper?.nextElementSibling;
      const siblingId = sibling?.dataset?.widgetId;
      if (!id || !siblingId) return false;
      placeWidget(id, siblingId, dir === 'up' ? 'before' : 'after');
      return true;
    };

    // Nach dem Ablegen steht die Kachel schon an ihrem Platz (SortableJS haengt
    // sie selbst um); der Stand folgt dem Platz, den sie im Raster hat.
    const dropWidget = (item) => {
      const id = item?.dataset?.widgetId;
      const nextId = item?.nextElementSibling?.dataset?.widgetId;
      const prevId = item?.previousElementSibling?.dataset?.widgetId;
      if (!id || !(nextId || prevId)) return;
      placeWidget(id, nextId || prevId, nextId ? 'before' : 'after');
    };

    const move = (btn) => {
      const id = btn.dataset.widgetId;
      const dir = btn.dataset.widgetMove;
      if (!moveWidget(id, dir)) return;
      // Am Rand ist der gedrueckte Knopf jetzt gesperrt: der Fokus geht zur
      // Gegenrichtung derselben Kachel (Tastatur-Kontinuitaet).
      if (!btn.disabled && document.activeElement === btn) return;
      const movedWrapper = grid.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
      const sameDir = movedWrapper?.querySelector(`[data-widget-move="${dir}"]:not([disabled])`);
      const anyMove = movedWrapper?.querySelector('[data-widget-move]:not([disabled])');
      (sameDir ?? anyMove)?.focus();
    };

    // AUS DEM MENUE DER KACHEL (U7): das Menue schliesst, der Fokus bleibt an
    // seinem Ausloeser - der wandert mit der Kachel (arrangeChildren haengt
    // sie um und gibt den Fokus zurueck), wie der Griff bei den Pfeiltasten.
    // Gesagt wird der neue Platz wie bei Hoch/Runter (placeWidget).
    const moveFromMenu = (item) => {
      const menu = item.closest('.popover-menu');
      menu?.hidePopover?.();
      const trigger = menu ? shell.querySelector(`[popovertarget="${CSS.escape(menu.id)}"]`) : null;
      trigger?.focus({ preventScroll: true });
      if (moveWidget(item.dataset.widgetId, item.dataset.widgetMove) && trigger && document.activeElement !== trigger) {
        trigger.focus({ preventScroll: true });
      }
    };

    // EIN Zuhoerer fuer alle Knoepfe der Leisten und der Ablage: die Knoepfe
    // kommen und gehen mit den Gesten, die Flaeche bleibt.
    shell.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('[data-widget-move], [data-widget-size-preset], [data-widget-options], [data-widget-hide], [data-widget-show], [data-glance-hide], [data-glance-show]');
      if (!btn || !shell.contains(btn) || btn.disabled) return;
      if (btn.matches('.popover-menu [data-widget-move]')) moveFromMenu(btn);
      else if (btn.matches('[data-widget-move]')) move(btn);
      else if (btn.matches('[data-widget-size-preset]')) resize(btn);
      else if (btn.matches('[data-widget-options]')) void editOptions(btn);
      else if (btn.matches('[data-widget-hide]')) hide(btn);
      else if (btn.matches('[data-widget-show]')) show(btn);
      else glance(btn.matches('[data-glance-show]'));
    }, wired);

    // Tastatur: der Griff ist ein fokussierbarer Button - Pfeil hoch/runter
    // ordnet um. Schliesst die Inline-Reorder-Luecke fuer Tastatur-Nutzer, ohne die
    // schmale Edit-Leiste mit zusaetzlichen Buttons zu ueberladen.
    grid.addEventListener('keydown', (event) => {
      const handle = event.target?.closest?.('[data-widget-drag-handle]');
      if (!handle) return;
      const dir = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
      if (!dir) return;
      event.preventDefault();
      const id = handle.closest('.widget-wrapper[data-widget-id]')?.dataset.widgetId;
      if (moveWidget(id, dir) && document.activeElement !== handle) handle.focus({ preventScroll: true });
    }, wired);

    /* ZIEHEN NACH N3 (DW-P2-3). Bis hier zog die Uebersicht als einzige Stelle
     * der App per HTML5-Drag-and-Drop: die Quelle blieb als 45-%-Abbild stehen,
     * der Browser malte sein eigenes durchscheinendes Ziehbild, das Ziel war
     * eine 4-px-Linie, die Nachbarn standen still bis zum Loslassen - und per
     * Finger ging es gar nicht. Jetzt derselbe Baustein wie jede Liste
     * (utils/sortable.js): Ziehen am Griff, per Maus und per Finger (Halten
     * 120 ms), der Platz ist der leere Schlitz `.sortable-ghost`, das Ziehbild
     * die Kachel selbst, deckend, und die Nachbarn weichen in --duration-sm.
     * Geladen erst hier: der Anpassen-Modus ist selten, der Startgraph der
     * Uebersicht bleibt ohne sortable.js. Scheitert das Laden, bleiben Hoch,
     * Runter und die Pfeiltasten. */
    const ownWiring = editWiring;
    void import('/utils/sortable.js')
      .then(({ makeSortable }) => (ownWiring.signal.aborted ? null : makeSortable(grid, {
        handle: '[data-widget-drag-handle]',
        draggable: '.widget-wrapper[data-widget-id]',
        onEnd: (evt) => dropWidget(evt.item),
      })))
      .then((sortable) => {
        if (!sortable) return;
        if (ownWiring.signal.aborted || !grid.isConnected) { sortable.destroy(); return; }
        ownWiring.signal.addEventListener('abort', () => sortable.destroy(), { once: true });
      })
      .catch(() => { /* ohne SortableJS bleiben Hoch/Runter und die Pfeiltasten */ });
  }

  let disposeNoteCategories = () => {};
  let disposeFastingClock = () => {};
  // Fokus-Nachfolger, den eine Geste fuer den naechsten Neuaufbau vormerkt
  // (Selektoren, der erste Treffer gewinnt), und der Modus des letzten Aufbaus -
  // null, solange noch keiner lief.
  let focusAfterRebuild = null;
  let renderedCustomizing = null;
  signal.addEventListener('abort', () => disposeFastingClock(), { once: true });
  signal.addEventListener('abort', () => disposeNoteCategories(), { once: true });
  // Das Einpassen der Wand auf Aufbau und Fenstergroesse (#1817).
  const wallFit = createWallFit(window, signal);
  // Das Heute-Blatt folgt Drehung und Fensterhoehe (createPhoneProgramFit).
  createPhoneProgramFit(window, signal, (crossed) => {
    if (signal.aborted || wallMode || loadFailed || isCustomizing) return;
    if (crossed || measurePhoneProgram(container.querySelector('#dashboard-shell'))) rebuildDashboard(widgetConfig);
  });
  const refreshAfterSheet = () => refreshDashboardData();
  // Die Lage vor dem Ausklappen gehender Zeilen, fuer den naechsten Aufbau.
  let quietScrollTop = null;
  /** Das Markup der Flaeche aus dem aktuellen Stand - fuer den Aufbau und fuer
   *  den Blick voraus, welche Zeilen der stille Abgleich mitnimmt. */
  // Die Kacheln des letzten Aufbaus, so wie sie im Raster stehen.
  let drawnTiles = [];
  // Und ihr Markup samt dem des Heute-Blatts: was eine Anpassen-Geste davon
  // unveraendert laesst, zeichnet sie nicht neu (patchCustomize).
  let drawnBodies = new Map();
  let drawnCockpit = '';
  let drawnVisibility = '';
  function dashboardShellHtml(cfg) {
    // Signature-„Heute"-Masthead: Begrüßung und Glance-Cockpit teilen sich EIN
    // erhöhtes Material-Band (statt zweier gestapelter gerahmter Kästen). Die
    // inneren Sections sind entrahmt; das Band trägt Rahmen/Schatten/Tönung.
    // Fehlt das Cockpit (alle Domänen als Widgets sichtbar → kein Glance-Inhalt),
    // kollabiert das Band per --slim auf eine schlanke Gruß-Leiste statt ein
    // großes leeres Rechteck zu zeigen (Critique R3 P1).
    const cockpitHtml = (glanceVisible || isCustomizing) ? renderTodayCockpit(data, cfg, isCustomizing) : '';
    drawnCockpit = cockpitHtml;
    drawnVisibility = visibilityKey(cfg, glanceVisible);
    const mastheadSlim = cockpitHtml ? '' : ' dashboard-masthead--slim';
    // Kein Wetter-Echo: die Masthead-Zeile spricht nur, wenn die Wetter-Karte
    // nicht ohnehin im Raster sichtbar ist (Opt-in fürs Wandtablet).
    // Eine nicht verfuegbare Karte steht nicht im Raster, spricht also auch
    // nicht fuer die Zeile.
    const weatherCardShown = cfg.some((w) => w.id === 'weather' && w.visible) && isWidgetModuleEnabled('weather');
    return `
      <section class="dashboard-masthead dashboard-masthead--${greetingPeriod()}${mastheadSlim}">
        ${renderDashboardOverview(user, isCustomizing, weather, { followsDefault, canPublish, weatherCard: weatherCardShown })}
        ${cockpitHtml}
      </section>
      ${renderDashboardLayout(cfg, data, weather, currency, { editing: isCustomizing, visibleMealTypes, glanceHidden: !glanceVisible, familyManage: familyManageHref(user), drawn: (drawnTiles = []), bodies: (drawnBodies = new Map()) })}
      ${isCustomizing ? renderCustomizeFootnote({ followsDefault, canPublish }) : ''}
    `;
  }
  function rebuildDashboard(cfg) {
    // Der eine Engpass fuer jeden verspaeteten Neuaufbau (#977): eine Antwort,
    // die nach dem Verlassen der Seite oder nach dem naechsten render()
    // eintrifft, darf die Flaeche nicht mehr anfassen - sonst ueberschreibt der
    // aeltere Stand den neueren.
    if (signal.aborted) return;
    disposeNoteCategories();
    disposeFastingClock();
    const shell = container.querySelector('#dashboard-shell');
    if (!shell) return;
    if (wallMode) {
      rebuildWall(container, shell, {
        data, weather, failed: loadFailed, updatedAt: lastLoadedAt, rerender, signal, fit: wallFit, screensaverEnabled,
        isDisplay: user?.access_scope === 'display',
      });
      return;
    }
    if (loadFailed) {
      setHtml(shell, `
        ${renderDashboardOverview(user, false, null, { offerNew: false })}
        ${renderDashboardError(loadErrorStatus)}
      `);
      if (window.lucide) window.lucide.createIcons({ el: shell });
      container.querySelector('#dashboard-retry')?.addEventListener('click', rerender, { signal: signal });
      return;
    }
    const html = dashboardShellHtml(cfg);
    // Vor dem Zeichnen, solange nichts Neues auszulegen ist (carryTileSizes).
    const viewportWidth = window.innerWidth;
    // Wer hatte den Fokus? Nach dem setHtml gibt es sein Element nicht mehr
    // (captureRebuildFocus / restoreFocusAfterRebuild).
    const { key: keepFocus, had: hadFocus } = captureRebuildFocus(shell, document.activeElement, document.body);
    const todayFallback = hadFocus ? todayFocusFallbacks(document.activeElement) : [];
    const modeChanged = renderedCustomizing !== null && renderedCustomizing !== isCustomizing;
    // Nur ein Neuaufbau IM Anpassen-Modus gleitet (playTileFlip; die Gesten
    // selbst patchen, patchCustomize): beim Betreten und Verlassen wachsen und
    // schwinden die Bearbeiten-Leisten aller Kacheln, da waere jede Bewegung
    // nur Unruhe.
    /* UND EIN STILLER ABGLEICH GLEITET (U1 b): seit die Kachel so hoch ist wie
     * ihre Daten, aendert ein Erledigen, ein neuer Termin oder ein neuer
     * Wetterbericht ihre Spanne - und alles darunter rueckte von einem Bild
     * aufs naechste. Jetzt gleiten die Kacheln von ihrer alten Lage an die
     * neue (FLIP, `--ease-out`, unter reduzierter Bewegung blenden sie). Nicht
     * aus dem Skelett und nicht beim ersten Bild einer Rueckkehr (dort steht
     * noch keine Kachel). */
    const quietRebuild = !isCustomizing && !modeChanged && !shell.querySelector('.widget-skeleton');
    const tileRectsBefore = (isCustomizing && renderedCustomizing === true) || quietRebuild ? captureTileRects(shell) : null;
    // BETRETEN UND VERLASSEN: das Raster gleitet ALS GANZES an seine neue Lage
    // (R16, Bewegung). Der Gruss bricht um, die Ablage schiebt sich davor - das
    // Raster sprang beim Betreten um mehrere hundert Pixel (gemessen 486 ->
    // 868). Die Kacheln selbst bleiben ruhig (Satz oben): EIN Versatz fuer das
    // Raster, keine zweiundzwanzig einzelnen.
    const gridTopBefore = modeChanged
      ? shell.querySelector('#dashboard-widget-grid')?.getBoundingClientRect?.().top ?? null
      : null;
    renderedCustomizing = isCustomizing;
    syncLeaveGuard();
    // Im Anpassen-Modus ist die Seite ein Editor: der Speed-Dial ("Neue
    // Aufgabe", "Neuer Termin" ...) fuehrte mitten aus der Anordnung hinaus
    // und stand ueber den Bearbeiten-Leisten der unteren Kacheln (A7 P2-1).
    setCustomizeFabHidden(isCustomizing);
    // VOM SKELETT ZUM INHALT BLENDET ES (Critique R19): vorher ein harter
    // Schnitt, die Kacheln standen von einem Frame auf den anderen da. Nur
    // dieser eine Uebergang - ein Neuaufbau ueber vorhandenem Inhalt bleibt
    // still, und unter der Seitenblende ist die Blende schon das Einblenden.
    const fromSkeleton = Boolean(shell.querySelector('.widget-skeleton'))
      && !document.documentElement.classList.contains('page-swapping');
    // DER SCROLL BLEIBT (DW-P1-2). Ein stiller Neuaufbau tauscht die ganze
    // Flaeche, und die Scroll-Verankerung des Browsers hat danach keinen
    // Anker mehr: gemessen 390x844 nach dem Erledigen 400 -> 384 (die Zeile,
    // die oberhalb der Sicht ausklappt, zog die Lage mit). Gemerkt wird die
    // Lage vor dem Ausklappen (`quietScrollTop`, refreshDashboardData) bzw. hier,
    // und am Ende des Aufbaus - nach Icons und Messungen - wiederhergestellt.
    // Nicht beim Anpassen (dort gleitet das Raster selbst, playGridShift) und
    // nicht nach dem Skelett, das keine Lage hatte.
    const scroller = fromSkeleton || isCustomizing || modeChanged ? null : shell.closest?.('.app-content') ?? null;
    const keptScroll = scroller ? (quietScrollTop ?? scroller.scrollTop) : 0;
    quietScrollTop = null;
    swapContent(shell, () => {
      setHtml(shell, html);
      carryTileSizes(shell, viewportWidth);
      // DIE ZEICHEN VOR DEM ERSTEN MESSEN (DW-P2-4): kamen sie erst nach den
      // Messungen, legte der Browser die Flaeche zweimal aus - einmal ohne,
      // einmal mit rund 600 Zeichen-Knoten (gemessen 19 ms bei 4x CPU im
      // Seitenwechsel). Und das Blatt misst so die Zeilen, die man sieht.
      createPendingIcons(shell);
      // Telefon: das Blatt fuellt den ersten Schirm (D5). Gemessen im selben
      // Task wie das Zeichnen, also bevor der Browser ein Bild davon malt.
      const fitted = measurePhoneProgram(shell);
      if (fitted) {
        replaceProgramSheet(shell, renderTodayCockpit(data, cfg, isCustomizing, { cap: fitted }));
        createPendingIcons(shell);
        // Zweiter Blick, nur nach unten: der Rest unter den Zeilen hat gewechselt.
        const tighter = measurePhoneProgram(shell, { shrinkOnly: true });
        if (tighter) replaceProgramSheet(shell, renderTodayCockpit(data, cfg, isCustomizing, { cap: tighter }));
      }
      refitTodayStage(shell, () => renderTodayCockpit(data, cfg, isCustomizing));
    }, { animate: fromSkeleton });
    // Die Packung liest, solange das Layout vom Zeichnen noch sauber ist -
    // nach den Verdrahtungen darunter (Kategorie-Ueberlauf der Notizen)
    // verlangte ihr Lesen ein zweites Layout des Rasters (DW-P2-4).
    wireRowFill();
    // Was ein Blatt UEBER der Uebersicht aendert (Erledigen, Bearbeiten,
    // Loeschen, Fasten), gleicht still ab: kein Skelett, Scroll und Fokus
    // bleiben (refreshDashboardData). Das volle render() gehoert dem Aufbau.
    // Ohne Argumente: was ein Blatt seinem `onChanged` mitgibt, ist keine Option.
    wireLinks(container, refreshAfterSheet, { editing: isCustomizing, user, signal });
    disposeFastingClock = wireFastingWidget(container, refreshAfterSheet, data.fasting, signal, { editing: isCustomizing });
    // Retry einer isolierten Widget-Fehlerkachel: da /dashboard aggregiert lädt,
    // ist „erneut versuchen" ein voller Neuaufbau (wie der Page-Level-Retry).
    container.querySelectorAll('[data-widget-retry]').forEach((btn) =>
      btn.addEventListener('click', rerender, { signal: signal }));
    // Nur, was seit dem Zeichnen neu ist (ein neu gezeichnetes Blatt).
    createPendingIcons(shell);
    // Vorschaubilder der Mahlzeitenkachel: Ruecksturz auf den Platzhalter per
    // Listener, weil ein `onerror` im Markup gegen die CSP liefe (#1059).
    wireRecipeThumbs(shell);
    disposeNoteCategories = wireNoteCategoryOverflow(
      shell,
      (count) => getNumberFormat().format(count),
      (count) => t('noteCategories.moreAction', { count }),
    );
    wireWeatherRefresh(container, (updatedWeather) => {
      weather = updatedWeather;
      rebuildDashboard(cfg);
    }, signal);
    container.querySelector('#dashboard-search')?.addEventListener('click', () => {
      window.yuvomi?.openSearch?.();
    }, { signal: signal });
    container.querySelector('#dashboard-wall-enter')?.addEventListener('click', () => {
      enterWallMode();
      _wallFocusIntent = 'enter';
      // EIN KNOPF OHNE WORT SCHALTET DIE GANZE SHELL AB (#1559, D#1494): wer
      // ihn aus Neugier antippt, steht ohne Seitenleiste und Tab-Leiste da.
      // Eine Zeile sagt, was das ist und wie man herauskommt - der Name des
      // Ausstiegs kommt aus dessen Schluessel, wie beim Gegenstueck
      // `wallExited`, damit die Wegbeschreibung nicht vom Knopf wegdriftet.
      window.yuvomi?.showToast(t('dashboard.wallEntered', {
        action: t('dashboard.wallExit'),
      }), 'default', 8000);
      rerender();
    }, { signal: signal });
    container.querySelector('#dashboard-customize-btn')?.addEventListener('click', () => {
      // Nur noch der Einstieg: im Anpassen-Modus gibt es diesen Knopf nicht.
      // Der Fokus geht in die Leiste, die ihn abloest.
      isCustomizing = true;
      focusAfterRebuild = ['#dashboard-customize-cancel'];
      rebuildDashboard(widgetConfig);
    }, { signal: signal });
    // Die Eintraege des mobilen Anpassen-Menues loesen die Knoepfe aus, die sie
    // dort ersetzen - derselbe Weg, dieselbe Rueckmeldung.
    container.querySelector('#dashboard-tools-menu')?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'dashboard-customize') container.querySelector('#dashboard-customize-btn')?.click();
      if (action === 'dashboard-wall') container.querySelector('#dashboard-wall-enter')?.click();
    }, { signal: signal });
    container.querySelector('#dashboard-customize-save')?.addEventListener('click', saveDashboardConfig, { signal: signal });
    container.querySelector('#dashboard-customize-cancel')?.addEventListener('click', requestCancelDashboardConfig, { signal: signal });
    // ESC BEENDET DAS ANPASSEN (R20, Re-Critique 2026-10-17 A1 P3), wie
    // "Abbrechen": mit Rueckfrage, wenn etwas geaendert ist. Nicht, solange
    // ein Dialog oder Menue offen ist - deren Esc gehoert ihnen.
    if (isCustomizing) {
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !isCustomizing) return;
        if (document.querySelector('dialog[open], .modal-overlay, [popover].is-open, .popover-menu.is-open')) return;
        try { if (document.querySelector(':popover-open')) return; } catch { /* ohne Popover-API gibt es keins */ }
        event.preventDefault();
        requestCancelDashboardConfig();
      }, { signal: signal });
    }
    // Zwei Orte je Knopf (Leiste breit, Fussnote schmal), ein Handler.
    container.querySelectorAll('[data-customize-reset]').forEach((btn) => btn.addEventListener('click', resetDashboardConfig, { signal: signal }));
    container.querySelectorAll('[data-customize-publish]').forEach((btn) => btn.addEventListener('click', publishHouseholdDefault, { signal: signal }));
    wireDashboardEditMode();
    void mountExtensionWidgets(shell, cfg, user);

    /* DER FOKUS UEBERLEBT DEN NEUAUFBAU. Ein Moduswechsel baut die Flaeche neu
     * (die Gesten darin patchen seit DW-P2-1 und behalten ihre Knoten) - und
     * bis hierher fiel der Fokus danach auf <body>: wer per Tastatur
     * „Anpassen" drueckte oder speicherte, stand wieder am Seitenanfang. Reihenfolge der Kandidaten: dasselbe Element
     * (gleiche Id bzw. gleiches data-Attribut), dann das, was die Geste selbst
     * als Nachfolger nennt (Ausblenden -> Nachbarkachel), und wenn die Geste den
     * Modus gewechselt hat (Speichern, Abbrechen), der Anpassen-Knopf, der ihn
     * wieder oeffnet. */
    restoreFocusAfterRebuild(container, [
      keepFocus,
      ...(focusAfterRebuild ?? []),
      ...(hadFocus && modeChanged ? ['#dashboard-customize-btn', '.dashboard-tools-btn'] : []),
      ...(takeWallFocusIntent('leave') ? ['#dashboard-wall-enter', '.dashboard-tools-btn'] : []),
      ...todayFallback,
    ]);
    focusAfterRebuild = null;
    // Erst die Lage zurueck, dann gleiten: sonst stuende der Scroll-Versatz der
    // Verankerung mit in der Bewegung.
    if (scroller && scroller.scrollTop !== keptScroll) scroller.scrollTop = keptScroll;
    if (tileRectsBefore?.size) playTileFlip(shell, tileRectsBefore);
    playGridShift(shell, gridTopBefore);
  }

  rebuildDashboard(widgetConfig);

  if (wallMode || loadFailed) {
    // Kein FAB im Fehler-Zustand: seine Schnellaktionen würden in Module
    // navigieren, deren Daten gerade nicht geladen werden konnten — das würde
    // dem Fehler-Banner widersprechen. Retry stellt bei Erfolg alles her.
    // Dokumentweit, nicht im Container: die Gruppe kann zu diesem Zeitpunkt
    // schon in der Shell-Layer hängen (adoptPageFab, #634). Das Backdrop reist
    // als ihr Kind mit und braucht keine zweite Zeile.
    //
    // Und keiner im Wand-Modus: eine Anlege-Affordance in einer reinen Anzeige
    // waere ein Versprechen, das die Flaeche nicht einloest. Er wird dort gar
    // nicht erst gerendert; diese Zeile raeumt nur einen mit, den die Vorseite
    // in der Shell-Layer zurueckgelassen haben koennte. Bewusst hier und nicht
    // per CSS: eine Regel, die `.page-fab` auf `opacity: 0` oder
    // `pointer-events: none` setzt, ist seit #634 verboten (Guard in
    // test-frontend-audit.js).
    findPageFab('fab-main')?.closest('.page-fab-group')?.remove();
  } else {
    // "+ Neu" legt ueber der Uebersicht an und gleicht danach still ab (U2).
    initFab(signal, { user, refresh: refreshAfterSheet });
    wireNewMenu(container, signal, { user, refresh: refreshAfterSheet });
  }

  // SELBSTHEILUNG STATT RETRY-KNOPF. Am Wandtablet drueckt niemand auf
  // „erneut versuchen" - die Flaeche muss sich selbst wieder einfangen. Der
  // Takt ist kuerzer als der stille Refresh: 15 Minuten Fehlerbild waeren an
  // der Wand eine Viertelstunde Falschauskunft.
  if (wallMode && loadFailed) {
    const healTimerId = setTimeout(rerender, WALL_HEAL_MS);
    signal.addEventListener('abort', () => clearTimeout(healTimerId));
  }

  // Stiller Daten-Refresh (Paket 2, Critique P4): Inhaltsdaten veralteten sonst
  // in offenen Tabs - PRODUCT.md nennt Wandtablet und PWA-Dauernutzung als
  // Kernszene, dort zeigte „Heute wichtig" abends noch den Morgenstand. EIN
  // Pfad für beide Auslöser (Tab-Reaktivierung + 15-Min-Takt im sichtbaren
  // Tab), bewusst ohne Skeleton (das gehört dem Erstaufbau) und still bei
  // Fehlern, wie der Wetter-Timer. Während „Anpassen" wird nicht neu gebaut -
  // ein Rebuild würde den Bearbeitungszustand wegwerfen.
  //
  // SEIT DW-P1-2 (Critique 26.10.) auch der Weg nach einer Aktion in einem
  // Blatt ueber der Uebersicht. Dort stand `render()`: Skelett ueber dem
  // Inhalt, die Seite schrumpfte auf Bildschirmhoehe und der Scroll fiel auf
  // 0 (gemessen 1596 -> 900 px, 400 -> 0, 120-250 ms Skelett) - genau dort,
  // wo das Blatt versprach, die Uebersicht bleibe stehen (R22 D3). Die
  // Zeile, die mit dem neuen Stand geht, schliesst vorher sichtbar
  // (closeLeavingRows).
  //
  // Laeuft schon eine Nachfrage, kann ihre Antwort aelter sein als der
  // Schreibvorgang, der die naechste ausloest: dann faehrt sie danach ein
  // zweites Mal, statt den Aufruf zu verschlucken.
  let refreshInFlight = null;
  let refreshAgain = false;
  // Was der neue Stand nicht mehr nennt, klappt aus, bevor die Flaeche ohne
  // es neu entsteht (utils/list-motion.js: collapseRow VOR dem Neuzeichnen).
  // Nachgeladen, nicht im Startgraphen: gebraucht wird es erst nach einem
  // Schreibvorgang (test:startup-preload).
  async function closeLeavingRows(cfg) {
    const shell = container.querySelector('#dashboard-shell');
    if (!shell || wallMode) return;
    const leaving = rowsLeaving(shell, dashboardShellHtml(cfg));
    if (!leaving.length) return;
    const { collapseRow } = await import('/utils/list-motion.js');
    await Promise.all(leaving.map((row) => collapseRow(row)));
  }
  // `onlyIfChanged`: die stille Nachfrage nach einem Aufbau aus dem gemerkten
  // Stand (`_overviewMemo`) - gleiche Antwort, kein Neuaufbau.
  async function refreshDashboardData({ onlyIfChanged = false } = {}) {
    if (isCustomizing || loadFailed) return;
    if (refreshInFlight) { refreshAgain = true; return refreshInFlight; }
    let settled;
    refreshInFlight = new Promise((resolve) => { settled = resolve; });
    const before = onlyIfChanged ? overviewSignature(data) : null;
    try {
      const requestDay = householdToday();
      // Die Erinnerungen haengen an nichts davon: sie laufen neben der
      // Uebersicht, nicht danach - nach einer Blatt-Aktion wartet die Flaeche
      // sonst eine Runde laenger auf ihren neuen Stand.
      const [fresh, pendingReminders] = await Promise.all([
        api.get(overviewRequest(dashboardQuery(widgetConfig))),
        loadPendingReminders(overviewRequest),
      ]);
      if (signal.aborted) return;
      localizeEventLists(fresh);
      // DIE EIGENEN SLICES WERDEN NEU GEHOLT, NICHT WEITERGEREICHT. /dashboard
      // liefert Zyklus (owner-only), Dienstplan und Abfuhr nie mit, und ein
      // Refresh darf sie nicht auf „nie geladen" zurueckwerfen - nur
      // mitschleppen darf er sie auch nicht: "wer heute Dienst hat" blieb sonst
      // bis zu 15 Minuten stehen und ueberlebte sogar einen Mitternachts-
      // Wechsel auf dem Wandtablet (M-6a). Seit dem gemerkten Stand (R21,
      // `_overviewMemo`) fragt ein Aufbau daraus die Slices gar nicht, und
      // diese Nachfrage stempelt ihn neu - ein Weiterreichen hielte einen alten
      // Abholtermin oder einen auf einem anderen Geraet geaenderten Zyklus
      // unbegrenzt, solange man unter einer Minute wiederkommt (Review zu
      // R21). Also vor der Uebernahme zuruecksetzen und neu laden - derselbe
      // Weg, den ein frisch eingeblendetes Widget in persistWidgetConfig()
      // schon nimmt. Das heilt nebenbei auch einen zuvor gescheiterten Slice
      // (M-6b) beim naechsten stillen Takt, statt auf den Retry-Knopf zu warten.
      if (widgetConfig.some((w) => w.id === 'cycle' && w.visible)) {
        data.cycle = undefined;
        await ensureCycleSlice();
        if (signal.aborted) return;
      }
      fresh.cycle = data.cycle;
      if (widgetConfig.some((w) => w.id === 'schedule' && w.visible)) {
        data.schedule = undefined;
        await ensureScheduleSlice();
        if (signal.aborted) return;
      }
      fresh.schedule = data.schedule;
      if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) {
        data.waste = undefined;
        await ensureWasteSlice();
        if (signal.aborted) return;
      }
      fresh.waste = data.waste;
      fresh.pendingReminders = pendingReminders;
      const unchanged = before !== null && overviewSignature(fresh) === before;
      data = fresh;
      // Wie der Aufbau: ob die Countdown-Kachel steht, sagt der neue Stand -
      // ein im Blatt angelegter Countdown bringt sie mit (Review zu #2314).
      setCountdownAvailability(data?.countdowns);
      markLoaded(requestDay);
      rememberOverview();
      if (unchanged) return;
      const scrollTop = container.querySelector('#dashboard-shell')?.closest?.('.app-content')?.scrollTop ?? null;
      await closeLeavingRows(widgetConfig);
      // Waehrenddessen verlassen oder ins Anpassen gewechselt: dort hat der
      // eigene Aufbau den neuen Stand schon gezeichnet.
      if (signal.aborted || isCustomizing) return;
      quietScrollTop = scrollTop;
      const known = shownRowKeys(container.querySelector('#dashboard-shell'));
      rebuildDashboard(widgetConfig);
      rowsArriving(container.querySelector('#dashboard-shell'), known).forEach((row) => expandIn(row));
    } catch { /* Hintergrund-Refresh: bewusst still */ }
    finally {
      refreshInFlight = null;
      // Wer waehrenddessen fragte, wartet auf den Nachlauf mit.
      if (refreshAgain && !signal.aborted) {
        refreshAgain = false;
        await refreshDashboardData();
      }
      settled();
    }
  }
  const refreshTimerId = setInterval(() => {
    if (!document.hidden) refreshDashboardData();
  }, 15 * 60 * 1000);
  signal.addEventListener('abort', () => clearInterval(refreshTimerId));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const titleEl = container.querySelector('.dashboard-overview__title');
    if (titleEl) {
      titleEl.replaceChildren();
      titleEl.insertAdjacentHTML('afterbegin', greeting(user.display_name));
      // Gradient-Periode mit-resyncen: sonst aktualisieren sich über Mittag/18 Uhr
      // die Worte, aber der Tageszeit-Gradient bliebe auf dem alten Fenster stehen.
      titleEl.classList.remove(
        'dashboard-overview__title--morning',
        'dashboard-overview__title--day',
        'dashboard-overview__title--evening',
      );
      titleEl.classList.add(`dashboard-overview__title--${greetingPeriod()}`);
    }
    const dateEl  = container.querySelector('.dashboard-overview__date');
    if (dateEl)  dateEl.textContent = mastheadDateLabel();
    // Hintergrund-Tabs bekommen gedrosselte Timer: die Uhr könnte beim
    // Zurückkehren Minuten nachhängen und muss sofort nachziehen (#651).
    updateClockWidget(container);
    // Inhalte ziehen nach, nicht nur Gruß/Datum/Uhr (Paket 2) - aber nur ein
    // alter Stand (staleOnReturn, oben).
    if (staleOnReturn({ loadedAt: freshAt, loadedDay: freshDay }, { now: new Date(), today: householdToday() })) refreshDashboardData();
  }, { signal: signal });

  // Aus dem gemerkten Stand gezeichnet: still nachfragen, und nur neu bauen,
  // wenn sich etwas geaendert hat (ein anderes Geraet, ein anderes Mitglied).
  if (memo) refreshDashboardData({ onlyIfChanged: true });

  // Der Minutentakt der Uhr traegt die Nachtabsenkung mit: um 22:00 und um
  // 06:00 muss die Flaeche umschalten, wenn es so weit ist - nicht erst beim
  // naechsten Laden. Ein zweiter Timer nur dafuer waere ein zweiter Takt fuer
  // dieselbe Minute.
  //
  // Derselbe Takt traegt die Grenzen des Tages (#1449): endet ein Termin, wird
  // eine Dosis faellig oder ist die Tonne mittags abgeholt, aendert sich das
  // Blatt - ohne Neuladen, denn das unberuehrte Wandtablet wartet sonst bis zum
  // stillen Refresh. Gebaut wird nur, wenn sich der Stand WIRKLICH geaendert
  // hat: der Fingerabdruck ist billig, ein Neuaufbau je Minute waere es nicht.
  let dayFingerprint = todayFingerprint(data, widgetConfig);
  const followDayBoundaries = () => {
    if (loadFailed || isCustomizing) return;
    const next = todayFingerprint(data, widgetConfig);
    if (next === dayFingerprint) return;
    dayFingerprint = next;
    rebuildDashboard(widgetConfig);
  };
  startClockTicker(container, signal, () => {
    if (wallMode) syncWallMode(location.pathname);
    followDayBoundaries();
    updateTodayTimelineNow(container);
  });

  // 30-Minuten Auto-Refresh für Wetter (inkl. optionaler Standort-Aktualisierung).
  // Anker ist der Datensatz, nicht der Karten-Button: seit dem Masthead-Umzug
  // kann Wetter sichtbar sein (Zeile), ohne dass die Karte samt Refresh-Button
  // im Raster steht - auch die Zeile darf nicht den ganzen Tag alt werden.
  // Eingerichtet reicht: eine Kachel, die gerade kein Wetter hat, soll es
  // nachholen, sobald der Anbieter wieder antwortet.
  if (weatherAvailable) {
    const doAutoRefresh = async () => {
      try {
        await maybeUpdateAutoLocation({
          autoLocateEnabled: weatherAutoLocate,
          geolocation: navigator.geolocation,
          putPreferences: (body) => api.put('/preferences', body),
        });
        const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
        if (signal.aborted) return;
        // GLEICHE ANTWORT, KEIN NEUAUFBAU (DW-P3-13): der Takt baute alle 30
        // Minuten die ganze Flaeche neu, auch wenn der Anbieter dasselbe
        // sagte - anders als der stille Abgleich mit `onlyIfChanged`. Der Tag
        // gehoert zum Abdruck: um Mitternacht rueckt die Heute-Marke der Vorschau.
        const shown = overviewSignature({ weather, available: weatherAvailable, day: householdToday() });
        weather = res.data ?? null;
        setWeatherAvailability(res, weatherPrefs);
        if (overviewSignature({ weather, available: weatherAvailable, day: householdToday() }) === shown) return;
        rebuildDashboard(widgetConfig);
      } catch { /* Hintergrund-Timer: bewusst still — der Nutzer hat nichts
                   angestoßen, ein Toast alle 30 Min wäre reiner Lärm. */ }
    };
    const timerId = setInterval(doAutoRefresh, 30 * 60 * 1000);
    signal.addEventListener('abort', () => clearInterval(timerId));
    if (weatherAutoLocate) doAutoRefresh();
  }

  // Weder Onboarding noch Anpassen-Hinweis im Wand-Modus: beide sprechen auf
  // Arm-Laenge ueber Bedienung, die es dort nicht gibt. Der Onboarding-Merker
  // bleibt bewusst ungesetzt - wer die Wand wieder verlaesst, bekommt seine
  // Einfuehrung dann, wenn sie ihm etwas nuetzt.
  if (wallMode) return;

  // Das Konto entscheidet (onboarding_pending aus /auth/me), nicht mehr allein
  // das Geraet - sonst zeigt ein neues Geraet oder ein privates Fenster den
  // Rundgang erneut, obwohl das Konto ihn schon gesehen hat. Der lokale
  // Schluessel bleibt eine ZUSAETZLICHE Bedingung statt zu entfallen: er ist
  // der Weg, mit dem Test-Faelle (document-guards-harness.js) den Dialog
  // gezielt unterdruecken, ohne einen Testnutzer am Server zu markieren.
  // Aus der Hilfe gewuenscht (router.js, "Rundgang ansehen", R23 S10): einmal,
  // unabhaengig vom Merker am Konto.
  let replayTour = false;
  try { replayTour = sessionStorage.getItem('yuvomi-replay-tour') === '1'; sessionStorage.removeItem('yuvomi-replay-tour'); } catch { /* ohne Speicher kein Rundgang */ }
  if (replayTour || (user?.onboarding_pending && !localStorage.getItem(ONBOARDING_KEY))) {
    setTimeout(() => showOnboarding(container, () => {
      // Nach dem Rundgang keine Sackgasse (R23 D14): die Karte beginnt jetzt -
      // nicht nach einer Wiederholung aus der Hilfe (der Haushalt laeuft schon).
      if (!replayTour) startFirstSteps();
      firstSteps = mountSteps();
      firstSteps.update(Array.isArray(data?.users) ? data.users.length : null);
      maybeHintCustomize(container);
    }), 400);
  } else {
    maybeHintCustomize(container);
  }
}

/**
 * Was sich am Tag allein durch die Uhr aendert: welche Zeilen im Blatt stehen
 * (samt offen/ueberfaellig) und welche Termine vorbei sind. Ein Stempel, kein
 * Markup - verglichen wird nur, ob ein Neuaufbau etwas anderes zeigen wuerde.
 */
function todayFingerprint(data, cfg, now = new Date()) {
  if (!data) return '';
  const model = buildTodayCockpitModel(data, cfg, { now });
  const nowStamp = householdNowStamp(now);
  // Beide Terminlisten: auch die Familienkarte wechselt am Ende eines Termins
  // auf den naechsten oder auf „fuer heute durch" (#1449).
  const ended = ['upcomingEvents', 'familyEvents']
    .flatMap((key) => (Array.isArray(data[key]) ? data[key] : []))
    .filter((event) => eventHasEnded(event, nowStamp))
    .map((event) => `${event.id}@${event.start_datetime}`);
  // Und die Mahlzeit, deren Zeit da war, und die beendete eigene Schicht: unter
  // der breiten Buehne verlassen sie die Zeilen (timelineSheetRows), ohne dass
  // ein Termin endet.
  const timeline = buildTodayTimeline(data, { now, includeMeals: true, includeShifts: true });
  const items = (timeline?.lanes ?? []).flatMap((lane) => lane.items);
  const passed = items
    .filter((item) => item.kind !== 'event' && item.state === 'past')
    .map((item) => item.key);
  // UND WAS BEGONNEN HAT (Critique 2026-10-26, Lauf 2): breit stehen die
  // Termine in keiner Zeile, und ein Beginn aenderte nichts am Stempel - der
  // Block hiess weiter „als Naechstes", seine Fahne zaehlte ins Leere, und der
  // naechste kam erst dran, wenn irgendwo etwas endete.
  const running = items.filter((item) => item.state === 'now').map((item) => item.key);
  return JSON.stringify([
    model.rows.map((row) => [row.kind, row.objectId ?? row.members?.map((m) => m.objectId), row.title, row.open, Boolean(row.overdue)]),
    model.overflow, Boolean(model.coda), Boolean(model.state), ended, [...new Set(passed)],
    timeline?.nextKey ?? null, [...new Set(running)],
    // DAS KNIE DER ACHSE (D7): es springt zur vollen Stunde, und mit ihm jede
    // Lage der Leiste - dann baut die Uebersicht neu; dazwischen wandert nur
    // der Strich (updateTodayTimelineNow).
    timeline?.knee ?? null,
  ]);
}

/**
 * Die faelligen Erinnerungen fuer das Heute-Blatt (utils/today-sheet.js).
 *
 * Derselbe Endpunkt, den die Glocke pollt - er filtert Herkuenfte schon nach
 * Modulrecht und Token-Scope (`mayTouchOrigin`), das Blatt waehlt daraus nur
 * noch, welche Herkunft eine Zeile ist. Ein Fehler kostet die Zeilen, nicht
 * die Uebersicht: die Erinnerung spricht weiter ueber Toast und Glocke.
 *
 * `request` IST DIE EINE REGEL DER SEITE (`overviewRequest`): die Wand fragt
 * auch hier die Haushaltsfassung ab, und die ist leer - eine Erinnerung gilt
 * der Person, die um sie gebeten hat, nicht der Kueche (#1817).
 */
async function loadPendingReminders(request = (path) => path, get = (path) => fetchPendingReminders(path, { get: (p) => api.get(p) })) {
  try {
    const res = await get(request('/reminders/pending'));
    return Array.isArray(res?.data) ? res.data : [];
  } catch {
    return [];
  }
}

/**
 * Der Schichtplan eines Tages fuer die Kachel: Eintraege, ob es ueberhaupt
 * Typen gibt, und die Namen der Plan-Besitzer. data.users kommt aus der
 * Mitgliederliste (#1207); auch Hauspersonal kann einen Plan haben, und seine
 * Zeile traegt wie auf der Dienstplan- und der Kalenderseite einen Namen.
 * Faellt nur das Verzeichnis aus, bleibt die Kachel stehen und nennt die
 * Mitglieder wie zuvor.
 */
async function loadScheduleSlice(day) {
  const [entriesRes, typesRes, peopleRes] = await Promise.all([
    api.get(`/schedule/entries?from=${day}&to=${day}`),
    api.get('/schedule/shift-types'),
    api.get('/auth/users').catch(() => ({ data: [] })),
  ]);
  return {
    entries: entriesRes.data?.entries ?? [],
    hasTypes: (typesRes.data ?? []).length > 0,
    people: peopleRes.data ?? [],
  };
}

export const __test = {
  onboardingCardPlacement,
  usableOverviewMemo, overviewMemoKey, overviewSignature, watchOverviewWrites,
  getOverviewMemo: () => _overviewMemo,
  setOverviewMemo: (memo) => { _overviewMemo = memo; },
  childDefaultFor, taskForOthersOnly, customizeLeaveAllowed, setCustomizeFabHidden, renderCalendarWidget, renderRewardsWidget, loadScheduleSlice, renderUrgentTasks, renderUpcomingEvents, buildTodayHighlights, buildTodayProgram, buildTodayCockpitModel, renderTodayCockpit, renderPinnedNotes, renderScheduleWidget, renderWasteWidget, renderPantryWidget, renderFamilyWidget, formatDueDate, normalizeVisibleMealTypes, renderTodayMeals, calendarEventRoute, eventOccurrenceDateKey, eventStartDate, renderWallSurface, renderWallWho, planWallWhoLines, fitWallWho, createWallFit, rebuildWall, shedWallProgram, WALL_WHO_LADDER, renderDashboardOverview, selectMetricTiles, METRIC_TILE_ORDER, PROGRAM_ROW_CAP, WALL_ROW_CAP, weatherToneKey, weatherMotionAttr, weatherTempBand, weatherSpanModel, weatherDayLabel, weatherTodayRange, renderWeatherWidget, renderWeatherUnavailable, weatherAvailableFrom, renderWallWeather, relativeDateLabel, listRowCap, calendarRowCap, calendarTileModel, tileSpanOf, renderDashboardSkeleton, rememberGridHint, carryTileSizes, watchTileSizes, createPendingIcons, openWidgetOptions, renderFab, widgetHeader, renderDashboardLayout, renderMetricTiles, renderGridHint, captureTileRects, playTileFlip, measureTileFlip, startTileFlip, playGridShift, arrangeChildren, placeBefore, focusTarget, nearestScrollDelta, tileDrawKey, dashboardTileRenderers, dashboardTileListed, renderWidgetBody, renderWidgetWrapper, familyManageHref, customizeHasChanges, focusKeyOf, captureRebuildFocus, restoreFocusAfterRebuild, shoppingSoleListRoute, todayMoreRoute, wireTodayMore, wireTodayOverdue, renderWidgetSizeMenu, renderNewPill, FAB_ACTIONS, FAB_NEW_BTN, NEW_SHEETS, wireNewMenu, initFab, rowsArriving, shownRowKeys, renderCustomizeFootnote, applyRowFill, gridHoleSuggestion, programRowsThatFit, PROGRAM_ROW_CAP_PHONE, createPhoneProgramFit, renderWidgetError, renderWidgetCustomizeControls, renderWidgetTileMenu, syncCustomizeControls, wireLinks, renderFastingWidget, renderNutritionWidget, renderWasteWidget, renderQuickLinks, renderShoppingLists };

// `signal` ist der Controller des Aufbaus, der die Wetterkarte gezeichnet hat
// (#976/#977). Vorher las diese Funktion das Modul-Feld `_fabController` -
// ein ueberholter Aufbau haengte seinen Klick damit an den Controller des
// neueren, und der Rauchtest im Browser fand den Zugriff als ReferenceError,
// nachdem das Feld aus render() verschwunden war. Der Aufrufer reicht es herein.
function wireWeatherRefresh(container, onUpdated = null, signal) {
  const refreshBtn = container.querySelector('#weather-refresh-btn');
  if (!refreshBtn) return;
  const doWeatherRefresh = async () => {
    refreshBtn.disabled = true;
    // Die Statusdrehung der Knoepfe (`.btn--loading`, layout.css): die Klasse
    // `--spinning`, die hier stand, hatte keine einzige Regel - der Kringel
    // drehte nie (DW-P3-3, mit dem Knopf aus der Shell).
    refreshBtn.classList.add('btn--loading');
    try {
      const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
      if (signal.aborted) return;
      // Manuelle Aktion: ein Fehlschlag darf nicht still als Erfolg quittiert
      // werden (sonst wirkt der Button tot). Kein Datensatz → Fehler-Toast.
      if (!res.data) {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
        return;
      }
      const wWidget = container.querySelector('#weather-widget');
      if (wWidget) {
        const wrapper = wWidget.closest('.widget-wrapper');
        if (wrapper) {
          wrapper.querySelector('.widget')?.remove();
          wrapper.insertAdjacentHTML('beforeend', renderWeatherWidget(res.data));
        }
        const newWidget = container.querySelector('#weather-widget');
        if (newWidget && window.lucide) window.lucide.createIcons({ el: newWidget });
        onUpdated?.(res.data);
        window.yuvomi?.showToast(t('dashboard.weatherUpdated'), 'success', 1500);
      }
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
    } finally {
      // Immer aufräumen, damit der Button nach jedem Ausgang wieder bedienbar
      // ist (bei Erfolg wird das Widget ohnehin frisch gerendert).
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('btn--loading');
    }
  };
  refreshBtn.addEventListener('click', doWeatherRefresh, { signal: signal });
}

// HIER STAND `wireFabAutoHide()` - der Speed-Dial wich beim Runterscrollen nach
// unten aus, damit er die „Alle"-Header-Links der Widgets nicht überdeckte
// (Critique P2). Diese Begründung ist entfallen, bevor der Mechanismus fiel:
// `--fab-safe-zone` verkürzt den Scrollport, sodass bei JEDEM Scrollstand nichts
// Bedienbares mehr unter dem FAB liegt - und seit der Speed-Dial ein `.page-fab`
// ist, gilt das auch hier.
//
// Übrig blieb dieselbe Mechanik, die `.page-fab--retracted` schon einmal gekostet
// hat (#634): ein Zustand an einer Klasse, den nur ein weiteres Scroll-Ereignis
// wieder abnahm. Ein einziges Abwärts-Delta ohne Nutzergeste - die iOS-
// Adressleiste, Scroll-Anchoring beim Nachladen eines Widgets - machte die
// Primäraktion unerreichbar.
//
// Die CSS-Seite davon hält test-frontend-audit.js als Regel fest: keine Regel,
// die `.page-fab` trifft, darf `opacity: 0` oder `pointer-events: none`
// schreiben - und seit der Dial eine `.page-fab-group` ist, trifft das auch ihn.

// Test-Tor fuer die Klarheits-Runde (test/test-dashboard-clarity.js): eigene
// Zeile statt Verlaengerung der langen `__test`-Liste oben, damit parallele
// Aenderungen an beiden nicht in derselben Zeile kollidieren.
Object.assign(__test, { renderUpcomingEvents, renderShoppingLists, renderShoppingTile, loadShoppingLists, loadPendingReminders, renderDashboardLayout, wireLinks });

// Test-Tor fuer die Uebersichts-Bugs vom 2026-09-29 (#1449, #1451-#1457).
Object.assign(__test, { renderBudgetWidget });
// Review p11: der Weg zum Anlegen-Blatt, wenn die Seite waehrenddessen geht.
Object.assign(__test, { openNewTarget });
// Review p11 (B4): wann eine Kachel im Anpassen-Modus neu gezeichnet und verdrahtet wird.
Object.assign(__test, { tileBodyChanged });
// Review p11 (B5): die Fasten-Kachel im Anpassen-Modus.
Object.assign(__test, { wireFastingWidget });

// Test-Tor fuer die Kalender-Auswahl der Kalender-Kachel (#2062).
Object.assign(__test, { loadCalendarSources });
Object.assign(__test, { renderCountdowns, renderHousekeepingWidget, renderCycleWidget, todayFingerprint });

// Test-Tor fuer die Zeitleiste (Critique 2026-10-26, Lauf 2): Verdrahtung,
// Minutentakt, Fahne und der Fokus ueber den Buehnenwechsel.
Object.assign(__test, { wireTodayTimeline, updateTodayTimelineNow, placeTodayTimelineFlag, todayFocusFallbacks });
// D3 (Lauf 2): das Bild als Tippziel auf dem Telefon.
Object.assign(__test, { renderTodayMiniTimeline, renderTodayPeek, todayPeekTarget, revealTodayPeekTarget });
// D6 (Lauf 2): die Gliederung unter der breiten Buehne gegen das Modell der Leiste.
Object.assign(__test, { buildTodayTimeline });
