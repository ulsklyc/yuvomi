/**
 * Modul: Dashboard
 * Zweck: Startseite mit Begrüßung, Terminen, Aufgaben, Essen, Notizen und FAB
 * Abhängigkeiten: /api.js
 */

import { api, auth } from '/api.js';
import { createPageController } from '/utils/page-lifecycle.js';
import { canSeeWidget, moduleAccess } from '/permissions.js';
import { t, formatDate, formatTime, timeSuffix, getLocale, getNumberFormat } from '/i18n.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { resolveEventColor } from '/utils/event-color.js';
import { esc, fmtLocation, renderMarkdownLight } from '/utils/html.js';
// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { toLocalDateKey, parseLocalDateKey, addLocalDays, todayKey as householdToday } from '/utils/date.js';
import { nowFields, zonedUTCProxy, zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { predictCycle, PHASE } from '/utils/health-cycle.js';
import { localizeBirthdayEvent } from '/utils/birthday-event.js';
import { countdownPhrase, countdownRank } from '/utils/countdown.js';
import { findPageFab } from '/utils/fab.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { renderAvatarStack } from '/components/user-multi-select.js';
import { isSoloHousehold } from '/utils/household.js';
import {
  WIDGET_SIZE_PRESETS, WIDGET_SIZE_OPTIONS,
  COCKPIT_COVERED_WIDGETS,
  nearestPreset, isUserOrderedConfig, sameWidgetConfig,
  dashboardQuery,
} from '/utils/dashboard-widgets.js';
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
import { renderWallTimer, wireWallTimer } from '/components/wall-timer.js';
import { rememberLayoutHint, layoutHintSizes, layoutHintQuery } from '/utils/dashboard-layout-hint.js';
import { emptyHintHTML } from '/utils/empty-state.js';
import { quickLinkHost } from '/utils/quick-link-url.js';
import { hasIcon } from '/utils/lucide-icons.js';
import { prefersInkText } from '/utils/contrast.js';
import { openQuickLinksManager } from '/components/quick-links-manager.js';
import { attachOverlay } from '/utils/overlay-history.js';
import { mealTypeList, primeMealTypeNames } from '/utils/meal-types.js';
import { recipeThumbHtml, wireRecipeThumbs } from '/utils/recipe-thumb.js';

// Hält den AbortController des aktuellen FAB-Listeners - wird bei jedem render() erneuert.
let _fabController = null;


// ── Onboarding ──────────────────────────────────────────────────────────────

const ONBOARDING_KEY = 'yuvomi-onboarded';
// Der Dialog benennt sich ueber seinen Schritt-Titel; die id steht hier, weil
// beide Seiten der Verknuepfung sie brauchen (Overlay und `renderStep()`).
const ONBOARDING_TITLE_ID = 'onboarding-step-title';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';
const CUSTOMIZE_HINT_KEY = 'yuvomi-dash-customize-hint';

function eventOccurrenceDateKey(event) {
  const value = String(event?.start_datetime || '');
  if (!value) return '';
  if (value.length <= 10) return value.slice(0, 10);

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : toLocalDateKey(date);
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
  return [
    { icon: 'home',         title: t('onboarding.step1Title', { name: appName }), body: t('onboarding.step1Body') },
    { icon: 'navigation',   title: t('onboarding.step2Title'), body: t(desktop ? 'onboarding.step2BodyDesktop' : 'onboarding.step2Body') },
    { icon: 'plus-circle',  title: t('onboarding.step3Title'), body: t(desktop ? 'onboarding.step3BodyDesktop' : 'onboarding.step3Body') },
  ];
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
  // kommt aus dem Schritt-Titel, den `renderStep()` ohnehin baut; die id ist
  // deshalb konstant und wandert mit dem Austausch des Karteninhalts mit
  // (WCAG 4.1.2). `aria-modal` versteckt alles dahinter - was bleibt, muss
  // sich also selbst benennen.
  overlay.setAttribute('aria-labelledby', ONBOARDING_TITLE_ID);

  const onKeydown = (event) => {
    if (event.key === 'Escape') { finish(); return; }
    if (event.key !== 'Tab') return;
    // Fokus-Trap (WCAG 2.4.3/2.1.2): der Erststart-Dialog darf den Fokus nicht
    // auf die verdeckte Seite dahinter entlassen. Fokussierbare Elemente je
    // Tab-Druck neu ermitteln, da renderStep() den Karteninhalt austauscht.
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

  function renderStep() {
    const step = steps[current];
    const isLast = current === steps.length - 1;
    overlay.replaceChildren();

    const card = document.createElement('div');
    card.className = 'onboarding-card';

    const icon = document.createElement('i');
    icon.dataset.lucide = step.icon;
    icon.className = 'onboarding-icon';
    icon.setAttribute('aria-hidden', 'true');

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.id = ONBOARDING_TITLE_ID;
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
      renderStep();
      if (window.lucide) window.lucide.createIcons({ el: overlay });
      nextBtn.focus();
    });

    if (!isLast) actions.appendChild(skipBtn);
    actions.appendChild(nextBtn);
    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(dots);
    card.appendChild(progress);
    card.appendChild(actions);
    overlay.appendChild(card);

    if (window.lucide) window.lucide.createIcons({ el: overlay });
    setTimeout(() => nextBtn.focus(), 50);
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeydown);
    localStorage.setItem(ONBOARDING_KEY, '1');
    // Am Konto vermerken, nicht nur am Geraet: sonst zeigt ein neues Geraet
    // oder ein privates Fenster den Rundgang erneut, obwohl das Konto ihn
    // schon gesehen hat. Bewusst fire-and-forget - ein Netzwerkfehler hier
    // darf den Dialog nicht am Schliessen hindern; der lokale Merker faengt
    // den aktuellen Browser ohnehin ab.
    auth.markOnboardingSeen().catch(() => {});
    // Fokus dorthin zurückgeben, wo er vor dem Dialog lag (sonst neutral auf
    // den Body), damit Tastatur-/SR-Nutzer nicht im entfernten Overlay hängen.
    const restoreTarget = (previouslyFocused && document.contains(previouslyFocused))
      ? previouslyFocused
      : document.body;
    overlay.classList.add('onboarding-overlay--out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    // Fallback falls animationend nicht feuert (prefers-reduced-motion):
    setTimeout(() => overlay.remove(), 300);
    restoreTarget?.focus?.();
    onDone?.();
  }

  renderStep();
  appContainer.appendChild(overlay);
  // Die Zurueck-Geste beendet die Einfuehrung, statt hinter ihr zu navigieren
  // (#871). `finish()` ist der EINE Weg hinaus und merkt sich das auch.
  attachOverlay(overlay, finish);
}

// Einmaliger, zurückhaltender Hinweis auf den „Anpassen"-Einstieg: Da vier Widgets
// standardmäßig hinter dem Cockpit ausgeblendet sind, macht ein sanfter Puls beim
// Erststart sichtbar, wo sie sich wieder einblenden lassen. Danach nie wieder.
function maybeHintCustomize(container) {
  if (localStorage.getItem(CUSTOMIZE_HINT_KEY)) return;
  const btn = container.querySelector('#dashboard-customize-btn');
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
// (family, weather) sind immer verfügbar. Modulweit, damit Grid-Filter und
// Wieder-Einblenden-Leiste dieselbe Sichtbarkeitsregel teilen.
const MODULE_FOR_WIDGET = { tasks: 'tasks', calendar: 'calendar', shopping: 'shopping', meals: 'meals', notes: 'notes', birthdays: 'birthdays', budget: 'budget', rewards: 'rewards', health: 'health', cycle: 'health', housekeeping: 'housekeeping', schedule: 'schedule', waste: 'waste' };

const WIDGETS_WITH_OPTIONS = new Set(['calendar', 'tasks', 'waste']);

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
  if (id === 'countdown' && !countdownAvailable) return false;
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
    housekeeping: () => t('nav.housekeeping'),
    schedule: () => t('nav.schedule'),
    waste:    () => t('nav.waste'),
    family:   () => t('dashboard.familyMembers'),
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

// Relatives Datumslabel: „Heute"/„Morgen", sonst das locale-formatierte Datum.
// Eigene Funktion, damit Aufrufer nur den Datumsteil brauchen, ohne ein
// zusammengesetztes „Datum, Zeit" per Komma zu zerschneiden (locale-fragil:
// manche Locales setzen selbst ein Komma ins Datum).
/**
 * „Heute"/„Morgen", sonst das Datum in Locale-Schreibweise.
 *
 * NIMMT EINEN DATUMS-KEY ODER EINEN ZEITPUNKT, und der Unterschied ist genau
 * der, den utils/timezone.js fuehrt: ein Key ('2026-08-25') ist zonenlos und
 * wird GELESEN, ein Zeitpunkt traegt seine Zone und wird UMGERECHNET.
 *
 * DIE PFLICHT LIEGT BEIM AUFRUFER. Ein `Date`, das jemand aus einem Key gebaut
 * hat, ist die gefaehrliche Mitte: `parseLocalDateKey('2026-08-25')` ist
 * Mitternacht der BROWSER-Zone und sieht damit aus wie ein Zeitpunkt, meint aber
 * einen Kalendertag. Durch die Anzeigezone gerechnet ist es einen Tag daneben -
 * derselbe Fehler, gegen den dieser Fix angetreten ist, nur ueber einen anderen
 * Weg. Wer einen Key hat, gibt den KEY her und baut kein Date daraus (#851).
 *
 * `zonedDateKey` unterscheidet die beiden Formen selbst: einen zonenlosen String
 * liest es, einen Zeitpunkt rechnet es um. Ein zweiter Zweig hier waere ein
 * Duplikat dieser Regel und wuerde beim naechsten Mal auseinanderlaufen.
 *
 * Vorher stand hier `d.toDateString() === new Date().toDateString()` - beide
 * Seiten in der Browser-Zone, also fuer jeden Betrachter ein anderes „heute".
 */
function relativeDateLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const day = zonedDateKey(value);
  if (!day) return formatDate(value);
  const today = householdToday();
  if (day === today) return t('common.today');
  if (day === addLocalDays(today, 1)) return t('common.tomorrow');
  return formatDate(value);
}

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
    ? `${formatDate(dueStamp)}, ${formatTime(dueStamp)}` // beide aus i18n.js
    : formatDate(dayKey);

  if (overdue) {
    return { text: `${t('dashboard.overdue')} – ${fullLabel}`, overdue: true };
  }

  if (calDayDiff === 1 && Number(dueTime?.slice(0, 2)) >= 22 && diffH < 24) {
    return { text: `${t('dashboard.dueSoon')} – ${fullLabel}`, overdue: false, soon: true };
  }

  if (calDayDiff === 0) {
    return { text: dueTime ? `${t('dashboard.dueToday')} – ${formatTime(dueStamp)}` : t('dashboard.dueToday'), overdue: false, soon: true };
  }

  if (calDayDiff === 1) {
    // Nur eine ECHTE Uhrzeit anhängen: ohne due_time ist 23:59:59 die interne
    // Sortier-Krücke - „Morgen fällig – 23:59" behauptete eine Deadline, die
    // niemand gesetzt hat (Critique P1). Der Heute-Zweig darüber macht es vor.
    return { text: dueTime ? `${t('dashboard.dueTomorrow')} – ${formatTime(dueStamp)}` : t('dashboard.dueTomorrow'), overdue: false };
  }

  return { text: fullLabel, overdue: false };
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

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

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
function widgetHeader(widgetId, title, count, linkHref, linkLabel, sealSlug = null) {
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
  const numericCount = Number(count);
  const badge = count != null && Number.isFinite(numericCount) && numericCount > 0
    ? `<span class="widget__badge">${count}</span>`
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
  const slug = sealSlug ?? ((linkHref || '').split('/')[1] || '');
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
      ${link}
    </div>
  `;
}

// Dezente Aktivierungs-Affordance für Empty-States: verlinkt in den Modul-Flow,
// damit ein Erststart-Nutzer nicht in einer beschreibenden Sackgasse landet.
// Nutzt dasselbe [data-route]-System wie widget__link (wireLinks verkabelt es).
function emptyStateCta(route, label) {
  return `<button type="button" class="widget__empty-cta" data-route="${route}">
    <i data-lucide="plus" aria-hidden="true"></i>
    <span>${label}</span>
  </button>`;
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
    const dayKey = eventOccurrenceDateKey(e);
    return dayKey ? dayKey === today : true;
  });
  const nextEvent = todayEvents[0] ?? null;

  const openShoppingCount = shoppingItems.length
    ? shoppingItems.filter((item) => !item.is_checked).length
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

// Pick the meal relevant to the current time of day (matches greeting thresholds:
// morning → breakfast, afternoon → lunch, evening → dinner). If the target meal
// is not planned, fall back to the next planned meal later today.
function selectTodayMeal(meals) {
  const order = ['breakfast', 'lunch', 'dinner'];
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

// Nominale Slot-Zeiten der Mahlzeiten: Mahlzeiten tragen keine Uhrzeit, brauchen
// im chronologischen Tagesprogramm aber einen Platz. Die Werte ordnen nur ein,
// sie behaupten keine Essenszeit - deshalb erscheinen sie nie als Label.
const MEAL_SORT_TIME = { breakfast: '08:00', lunch: '12:30', snack: '15:30', dinner: '18:30' };

/**
 * Tagesprogramm (Seele-Paket): heutige Termine, fällige Aufgaben und die nächste
 * Mahlzeit als EINE chronologische Erzählung statt drei Modul-Aggregaten.
 * Sortiert wird über einen HH:MM-Schlüssel; Zeitloses ordnet sich bewusst ein:
 * Überfälliges zuerst (00:00, es ist schon zu spät), dann Ganztägiges (00:01),
 * dann heute Fälliges ohne Uhrzeit (00:02). upcomingEvents liefert nur „ab
 * jetzt" - Vergangenes verschwindet also von selbst aus dem Programm.
 */
function buildTodayProgram(data, { includeTasks = true, includeCalendar = true, includeMeals = true } = {}) {
  const highlights = buildTodayHighlights(data);
  const todayKey = householdToday();
  const events = Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
  const rows = [];

  if (includeCalendar) {
    for (const event of events) {
      if (eventOccurrenceDateKey(event) !== todayKey) continue;
      const start = eventStartDate(event);
      const timed = !event.all_day && start && String(event.start_datetime).length > 10;
      rows.push({
        kind: 'event',
        objectId: event.id,
        sortKey: timed ? `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}` : '00:01',
        timeLabel: timed ? formatTime(start) : t('dashboard.allDay'),
        title: event.title,
        sub: t('dashboard.todayEvent'),
        icon: 'calendar',
        tone: 'event',
        route: calendarEventRoute(event),
        who: event.assigned_users?.[0] ?? null,
      });
    }
  }

  if (includeTasks) {
    const tasks = Array.isArray(data?.urgentTasks) ? data.urgentTasks : Array.isArray(data?.tasks) ? data.tasks : [];
    for (const task of tasks) {
      if (!task.due_date || task.due_date > todayKey) continue;
      const overdue = task.due_date < todayKey;
      const due = !overdue && task.due_time ? new Date(`${task.due_date}T${task.due_time}`) : null;
      const dueValid = due && !Number.isNaN(due.getTime());
      rows.push({
        kind: 'task',
        objectId: task.id,
        sortKey: overdue ? '00:00' : dueValid ? `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}` : '00:02',
        timeLabel: overdue ? t('dashboard.overdue') : dueValid ? t('dashboard.todayUntil', { time: formatTime(due) }) : '',
        overdue,
        title: task.title,
        sub: t('dashboard.todayTask'),
        icon: 'check-square',
        tone: 'task',
        route: '/tasks',
        who: task.assigned_users?.[0] ?? null,
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
      route: '/meals',
      who: null,
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
  const nextDueTask = allTasks.find((task) => task.due_date && task.due_date > todayKey) ?? null;

  return {
    rows,
    nextUpcoming,
    nextDueTask,
    openShoppingCount: highlights.openShoppingCount,
    tasksDoneToday: Number(data?.tasksDoneToday) || 0,
  };
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

function renderUrgentTasks(tasks) {
  if (!tasks.length) {
    return `<div class="widget widget--tasks">
      ${widgetHeader('tasks', t('nav.tasks'), 0, '/tasks')}
      <div class="widget__empty">
        <i data-lucide="check-circle" class="empty-state__icon" style="color:var(--color-success)" aria-hidden="true"></i>
        <div>${t('dashboard.allDone')}</div>
      </div>
    </div>`;
  }

  const items = tasks.map((t) => {
    const due = formatDueDate(t.due_date, t.due_time);
    return `
      <div class="task-item" data-task-id="${t.id}" data-task-title="${esc(t.title)}" role="button" tabindex="0">
        ${t.priority !== 'none' ? `<div class="task-item__priority task-item__priority--${t.priority}" title="${esc(PRIORITY_LABELS()[t.priority] ?? t.priority)}" aria-hidden="true"></div>` : ''}
        <span class="sr-only">${PRIORITY_LABELS()[t.priority] ?? t.priority}</span>
        <div class="task-item__content">
          <div class="task-item__title">${esc(t.title)}</div>
          ${due ? `<div class="task-item__meta ${due.overdue ? 'task-item__meta--overdue' : ''} ${due.soon ? 'task-item__meta--soon' : ''}">${due.text}</div>` : ''}
        </div>
        ${renderAvatarStack(t.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  return `<div class="widget widget--tasks">
    ${widgetHeader('tasks', t('nav.tasks'), tasks.length, '/tasks')}
    <div class="widget__body">${items}</div>
  </div>`;
}

function renderUpcomingEvents(events) {
  if (!events.length) {
    return `<div class="widget widget--calendar">
      ${widgetHeader('calendar', t('nav.calendar'), 0, '/calendar')}
      <div class="widget__empty">
        <i data-lucide="calendar-check" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noEvents')}</div>
      </div>
    </div>`;
  }

  // Der Tagesvergleich ueber KEYS, nicht ueber `toDateString()`: das las die
  // Browser-Zone und machte „heute" zu einer Frage an das Geraet (#851).
  const today = householdToday();
  const items = events.map((e) => {
    const d = eventStartDate(e) ?? new Date(e.start_datetime);
    const dayKey = eventOccurrenceDateKey(e);
    const isToday = dayKey === today;
    const _suffix = timeSuffix();
    const timeStr = e.all_day ? t('dashboard.allDay') : `${formatTime(d)}${_suffix ? ' ' + _suffix : ''}`.trim();
    return `
      <div class="event-item" data-route="${esc(calendarEventRoute(e))}" role="button" tabindex="0">
        <!-- Dieselbe Regel wie im Kalender, aus derselben Datei. Hier stand
             e.color || e.cal_color - dieselbe Frage ohne den Zweig fuer die
             zugewiesene Person, was seit #891 zwei verschiedene Antworten
             gegeben haette. -->
        <div class="event-item__bar" style="background-color:${esc(resolveEventColor(e))}"></div>
        <div class="event-item__content">
          <div class="event-item__title">${esc(e.title)}</div>
          <div class="event-item__time">
            <span class="event-time-badge ${isToday ? 'event-time-badge--today' : ''}">${isToday ? t('common.today') : relativeDateLabel(dayKey)}</span>
            ${timeStr}
            ${e.location ? ` · ${esc(fmtLocation(e.location))}` : ''}
            ${e.cal_name ? `<span class="event-item__cal">${esc(e.cal_name)}</span>` : ''}
          </div>
        </div>
        ${renderAvatarStack(e.assigned_users ?? [], { size: 28 })}
      </div>
    `;
  }).join('');

  return `<div class="widget widget--calendar">
    ${widgetHeader('calendar', t('nav.calendar'), events.length, '/calendar')}
    <div class="widget__body">${items}</div>
  </div>`;
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
 */
const LIST_ROWS_SHORT = 3;
const LIST_ROWS_TALL = 5;

function listRowCap(size) {
  return Number(String(size ?? '1x1').split('x')[1]) >= 2 ? LIST_ROWS_TALL : LIST_ROWS_SHORT;
}

export function renderUpcomingBirthdays(allBirthdays, size) {
  // Der Vorrat kommt fuer die groesste Fassung vom Server (routes/dashboard.js);
  // was davon erscheint, entscheidet die Kachel. Die Badge zaehlt weiter die
  // gezeigten Zeilen - sie sagt „so viele stehen hier", nicht „so viele hat der
  // Haushalt", und das war schon vor dem Nachschub ihre Bedeutung.
  const birthdays = allBirthdays.slice(0, listRowCap(size));
  if (!birthdays.length) {
    return `<div class="widget widget--birthdays">
      ${widgetHeader('birthdays', t('nav.birthdays'), 0, '/birthdays')}
      <div class="widget__empty">
        <i data-lucide="cake" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noBirthdays')}</div>
      </div>
    </div>`;
  }

  const items = birthdays.map((b) => {
    const daysLabel = b.days_until === 0
      ? t('common.today')
      : b.days_until === 1
        ? t('common.tomorrow')
        : t('dashboard.daysLeft', { count: b.days_until });
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
      <div class="birthday-widget-item" data-route="/birthdays" role="button" tabindex="0">
        <div class="birthday-widget-item__avatar"${avatarStyle}>
          ${b.photo_data ? `<img src="${esc(b.photo_data)}" alt="" loading="lazy">` : `<span>${esc(initials(b.name))}</span>`}
        </div>
        <div class="birthday-widget-item__body">
          <div class="birthday-widget-item__name">${esc(b.name)}</div>
          <div class="birthday-widget-item__meta">${formatDate(b.next_date ?? b.next_birthday)} · ${daysLabel}</div>
        </div>
        ${occasionLabel ? `<div class="birthday-widget-item__age">${esc(occasionLabel)}</div>` : ''}
      </div>
    `;
  }).join('');

  return `<div class="widget widget--birthdays">
    ${widgetHeader('birthdays', t('nav.birthdays'), birthdays.length, '/birthdays')}
    <div class="widget__body">${items}</div>
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
  const items = shown.slice(0, listRowCap(size));
  // Kein Leerzustand: ohne Countdown ist die Kachel nicht leer, sondern nicht
  // vorhanden (isWidgetModuleEnabled). Diese Zeile ist der Notausgang für den
  // Fall, dass die Verfügbarkeit und die Daten auseinanderlaufen.
  if (!items.length) return '';

  const rows = items.map((c) => {
    const phrase = countdownPhrase(c.days_until);
    const label = phrase.count === undefined ? t(phrase.key) : t(phrase.key, { count: phrase.count });
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
      <div class="countdown-item" role="button" tabindex="0"${anchor}${accent}>
        <span class="countdown-item__icon" aria-hidden="true">
          <i data-lucide="${esc(c.icon || 'calendar')}"></i>
        </span>
        <div class="countdown-item__body">
          <div class="countdown-item__title">${esc(c.title)}</div>
          <div class="countdown-item__meta">${formatDate(c.date)}</div>
        </div>
        <div class="countdown-item__days countdown-item__days--${countdownRank(c.days_until)}">${esc(label)}</div>
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
  const rest = Math.max(0, gesamt - items.length);
  const more = rest > 0
    ? `<p class="countdown-more">${esc(t('dashboard.countdownMore', { count: rest }))}</p>`
    : '';

  return `<div class="widget widget--countdown">
    ${widgetHeader('countdown', t('dashboard.countdownTitle'), gesamt, null, null, 'dashboard')}
    <div class="widget__body">${rows}${more}</div>
  </div>`;
}

function renderTodayMeals(meals, visibleMealTypes = MEAL_ORDER) {
  const mealLabels = MEAL_LABELS();
  const safeMeals = Array.isArray(meals) ? meals : [];
  const slots = normalizeVisibleMealTypes(visibleMealTypes).map((type) => {
    const meal = safeMeals.find((m) => m.meal_type === type);
    return `
      <div class="meal-slot ${meal ? 'meal-slot--filled' : ''}" data-type="${type}" data-route="/meals" role="button" tabindex="0">
        <div class="meal-slot__header">
          <span class="meal-slot__type">${mealLabels[type]}</span>
          <i data-lucide="${MEAL_ICONS[type]}" class="meal-slot__icon" aria-hidden="true"></i>
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
              className: 'meal-slot__thumb',
            }) : ''}<span class="meal-slot__title-text">${esc(meal.title)}</span>`
          : '—'}</div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--meals">
    ${widgetHeader('meals', t('dashboard.todayMeals'), null, '/meals', t('dashboard.weekLink'))}
    <div class="meals-widget">
      <div class="meal-slots">${slots}</div>
    </div>
  </div>`;
}

function renderPinnedNotes(allNotes, size) {
  /* WIE VIELE ZEILEN, ENTSCHEIDET DIE KACHEL - wie bei jeder anderen
   * Listenkachel (`listRowCap`). Die Notizen waren die einzige, die ihre Groesse
   * gar nicht las: der Server schnitt bei drei, und drei war damit die
   * Obergrenze fuer jede Fassung. Ab Werk steht die Kachel auf 1x2, also hoch -
   * unter drei Zeilen blieb rund ein Drittel der Karte leer, und wer fuenf
   * Notizen angepinnt hatte, sah drei davon und keinen Hinweis auf die
   * uebrigen (#928). Dieselbe Korrektur haben die Geburtstage schon bekommen;
   * die Notizen wurden dabei uebersehen. */
  const notes = allNotes.slice(0, listRowCap(size));
  if (!notes.length) {
    return `<div class="widget widget--notes">
      ${widgetHeader('notes', t('nav.notes'), 0, '/notes')}
      <div class="widget__empty">
        <i data-lucide="sticky-note" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noPinnedNotes')}</div>
      </div>
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
  const items = notes.map((n) => `
    <div class="note-item" data-route="/notes" role="button" tabindex="0"
         ${n.color ? `style="--note-color:${esc(n.color)};"` : ''}>
      ${n.title ? `<div class="note-item__title">${esc(n.title)}</div>` : ''}
      <div class="note-item__content">${renderMarkdownLight(excerpt(n.content))}</div>
    </div>
  `).join('');

  // Breite kommt aus dem Größenklassen-System am .widget-wrapper (widget-size--2x1);
  // die frühere .widget--wide war in keinem CSS definiert und damit tot — entfernt,
  // damit Notizen wie jedes andere Widget genau ein Größen-Vokabular trägt (Critique P2).
  return `<div class="widget widget--notes">
    ${widgetHeader('notes', t('nav.notes'), notes.length, '/notes')}
    <div class="notes-grid-widget">${items}</div>
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

function renderQuickLinks(items) {
  const list = Array.isArray(items) ? items : [];
  const header = widgetHeader('quicklinks', t('dashboard.quickLinksTitle'), list.length, null, null, 'dashboard');

  if (!list.length) {
    // Der Leerzustand ist hier der WICHTIGSTE Zustand: das Widget kommt
    // ausgeblendet ins Haus, wer es holt, hat noch nichts angelegt, und es gibt
    // keine zweite Seite, auf der er anfangen könnte. Deshalb nicht der stumme
    // Hinweis der anderen Kacheln, sondern der Weg selbst.
    return `<div class="widget widget--quicklinks">
      ${header}
      <div class="widget__empty">
        <i data-lucide="compass" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('quickLinks.emptyTitle')}</div>
        <button type="button" class="widget__empty-cta" data-quick-links-manage>
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>${esc(t('quickLinks.addFirst'))}</span>
        </button>
      </div>
    </div>`;
  }

  return `<div class="widget widget--quicklinks">
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

function renderFamilyWidget(users, data) {
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
  const events = Array.isArray(data?.upcomingEvents) ? data.upcomingEvents : [];
  const todayKey = householdToday();
  // S-18 (UX-Audit): dieselbe Schichtplan-Kachel, direkt daneben, widersprach
  // dieser Zeile - eine Person mit einer echten Schicht heute stand hier
  // trotzdem als "Heute frei", weil dieses Widget Schichtplan nie kannte.
  // `data.schedule` existiert nur, wenn die Schichtplan-Kachel selbst sichtbar
  // ist (ensureScheduleSlice() laedt sie nicht sonst) - ohne sie bleibt diese
  // Zeile unveraendert wie zuvor.
  const scheduleEntriesToday = Array.isArray(data?.schedule?.entries) ? data.schedule.entries : [];

  const rows = users.slice(0, 6).map((u) => {
    const assignedTo = (e) => (Array.isArray(e.assigned_users) ? e.assigned_users : []).some((a) => a.id === u.id);
    const nextEvent = events.find((e) => eventOccurrenceDateKey(e) === todayKey && assignedTo(e));
    const parts = [];
    if (nextEvent) {
      const start = eventStartDate(nextEvent);
      const timed = !nextEvent.all_day && start && String(nextEvent.start_datetime).length > 10;
      parts.push(timed ? `${esc(formatTime(start))} ${esc(nextEvent.title)}` : esc(nextEvent.title));
    }
    const myShift = scheduleEntriesToday.find((entry) => Number(entry.user_id) === Number(u.id) && entry.shift_type);
    if (myShift) {
      const type = myShift.shift_type;
      parts.push(esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name));
    }
    const open = openByUser.get(u.id) ?? 0;
    if (open > 0) parts.push(esc(t('dashboard.memberOpenTasks', { count: open })));

    // An freien Tagen erzählt die Zeile „als Nächstes dran" statt viermal
    // dasselbe „Heute frei" zu stapeln (Critique P5: die größte Karte des
    // Boards mit einem Bit Information). Erst wer auch im Ausblick nichts
    // hat, ist wirklich frei - und das darf dann leise dastehen.
    let status;
    let free = false;
    if (parts.length) {
      status = parts.join(' · ');
    } else {
      const upcoming = events.find((e) => eventOccurrenceDateKey(e) > todayKey && assignedTo(e));
      if (upcoming) {
        status = `${esc(relativeDateLabel(eventOccurrenceDateKey(upcoming)))} · ${esc(upcoming.title)}`;
      } else {
        status = esc(t('dashboard.todayFree'));
        free = true;
      }
    }
    return `
      <div class="family-member">
        <span class="family-widget-avatar" style="background:${esc(u.avatar_color || AVATAR_FALLBACK_COLOR)};color:${getReadableTextColor(u.avatar_color || AVATAR_FALLBACK_COLOR)}">
          ${u.avatar_data ? `<img src="${esc(u.avatar_data)}" alt="" loading="lazy">` : esc(initials(u.display_name))}
        </span>
        <span class="family-member__body">
          <span class="family-member__name">${esc(u.display_name)}</span>
          <span class="family-member__status${free ? ' family-member__status--free' : ''}">${status}</span>
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

  return `<div class="widget widget--family">
    ${widgetHeader('family', t('dashboard.familyMembers'), null, '/settings', t('dashboard.manage'), 'contacts')}
    <div class="family-widget">
      <div class="family-widget__list">
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
      <strong>${income > 0 ? `${savingsRate}%` : '–'}</strong>
    </div>
    ${income > 0 ? `
    <div class="budget-widget__share" aria-hidden="true">
      <span class="budget-widget__share-saved" style="--share-scale:${savedShare.toFixed(3)}"></span>
    </div>` : ''}`;
}

function renderBudgetWidget(budget, currency) {
  const income = budget?.income || 0;
  const expenses = budget?.expenses || 0;
  const balance = budget?.balance || 0;
  const savingsRate = income > 0 ? Math.round((balance / income) * 100) : 0;
  const balanceTone = balance >= 0 ? 'positive' : 'negative';
  const hasData = (budget?.entryCount || 0) > 0;

  if (!hasData) {
    return `<div class="widget widget--budget">
      ${widgetHeader('budget', t('dashboard.budgetOverview'), null, '/budget')}
      <div class="widget__empty">
        <i data-lucide="wallet" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noBudgetData')}</div>
        ${emptyStateCta('/budget', t('budget.addEntryLabel'))}
      </div>
    </div>`;
  }

  return `<div class="widget widget--budget">
    ${widgetHeader('budget', t('dashboard.budgetOverview'), null, '/budget')}
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
      ${budget?.topExpenseCategory
        ? `<div class="budget-widget__footer">${t('dashboard.topExpense')}: <strong>${esc(budgetCategoryLabel(budget.topExpenseCategory))}</strong> · ${formatCurrency(budget.topExpenseAmount, currency)}</div>`
        : ''}
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
 * nicht nutzt, hat keine Daten und bekommt keine Kachel. */
const METRIC_TILE_ORDER = ['tasks', 'shopping', 'budget', 'birthdays', 'meals', 'notes', 'rewards', 'health', 'housekeeping'];
const METRIC_TILE_COUNT = 4;

function metricTileFor(id, data, currency) {
  const route = { tasks: '/tasks', shopping: '/shopping', budget: '/budget', birthdays: '/birthdays', meals: '/meals', notes: '/notes', rewards: '/rewards', health: '/health', housekeeping: '/housekeeping' }[id];
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
    case 'budget': {
      const budget = data.budget ?? {};
      if (!(budget.entryCount > 0)) return null;
      const balance = budget.balance || 0;
      // DIE VORZEICHENREGEL IST NICHT NEU - sie ist die des Budget-Widgets,
      // Zeichen fuer Zeichen. Ein Minus allein wird bei 20px auf dem Handy
      // ueberlesen, deshalb traegt die Farbe den zweiten Kanal; und der
      // Sonderfall aus #504 kommt mit: wer nur Ausgaben erfasst, hat einen
      // rechnerisch negativen Saldo, der nichts ueber seine Lage sagt, und
      // bekommt Label-Farbe statt Rot.
      const neutral = (budget.income || 0) === 0 && balance < 0;
      return {
        id, route, icon: widgetIcon('budget'), label: t('nav.budget'),
        value: formatCurrency(balance, currency),
        note: t('dashboard.monthlyBalance'),
        tone: neutral ? 'balance-neutral' : balance >= 0 ? 'balance-positive' : 'balance-negative',
      };
    }
    case 'birthdays': {
      const next = (data.birthdays ?? [])[0];
      if (!next) return null;
      const days = next.days_until;
      return {
        id, route, icon: widgetIcon('birthdays'), label: t('nav.birthdays'),
        value: days === 0 ? t('common.today') : days === 1 ? t('common.tomorrow') : t('dashboard.daysLeft', { count: days }),
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
      const leader = (data.rewards?.standings ?? [])[0];
      if (!leader) return null;
      return {
        id, route, icon: widgetIcon('rewards'), label: t('nav.rewards'),
        value: t('dashboard.metricPoints', { count: leader.balance ?? 0 }),
        note: leader.display_name,
      };
    }
    case 'health': {
      const h = data.health ?? {};
      // Ohne Medikamente hat die Kachel keine Kennzahl - und der Zyklus ist
      // bewusst NICHT ihr Ersatz: er haengt an expliziten Grants (#584), und
      // eine Kachel, die je nach Berechtigung etwas anderes zeigt, ist zwei
      // Kacheln mit einem Namen.
      if (!h.hasMeds || !(h.dosesTotal > 0)) return null;
      const offen = h.dosesTotal - (h.dosesTaken ?? 0) - (h.dosesSkipped ?? 0);
      return {
        id, route, icon: widgetIcon('health'), label: t('nav.health'),
        value: t('dashboard.metricDoses', { count: Math.max(0, offen) }),
        // Die Nachbestellung schlaegt die naechste Uhrzeit: eine leere Packung
        // ist der Zustand, der eine Handlung braucht, eine faellige Dosis der,
        // der von selbst kommt.
        note: h.lowStockCount > 0
          ? t('dashboard.healthRefill', { count: h.lowStockCount })
          : offen <= 0 ? t('dashboard.healthAllTaken') : (h.nextDose?.name || t('dashboard.healthAllTaken')),
        noteTone: h.lowStockCount > 0 ? 'danger' : null,
      };
    }
    case 'housekeeping': {
      const hk = data.housekeeping ?? {};
      if (!hk.configured) return null;
      return {
        id, route, icon: widgetIcon('housekeeping'), label: t('nav.housekeeping'),
        value: t('dashboard.metricVisits', { count: hk.visitsThisMonth ?? 0 }),
        // Drei Zustaende, ein Rang: wer gerade da ist, ist die Nachricht; sonst
        // zaehlt offenes Geld; sonst der letzte Besuch.
        note: hk.present
          ? t('dashboard.housekeepingPresent')
          : hk.unpaidAmount > 0
            ? t('dashboard.housekeepingUnpaid', { amount: formatCurrency(hk.unpaidAmount, currency) })
            : hk.lastVisit
              ? t('dashboard.housekeepingLastVisit', { date: formatDate(hk.lastVisit) })
              : t('dashboard.housekeepingNoVisits'),
      };
    }
    default:
      return null;
  }
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
function selectMetricTiles(data, currency, shown = new Set()) {
  const tiles = METRIC_TILE_ORDER
    .filter((id) => isWidgetModuleEnabled(id))
    .filter((id) => !COCKPIT_COVERED_WIDGETS.has(id))
    .filter((id) => !shown.has(id))
    .map((id) => metricTileFor(id, data, currency))
    .filter(Boolean)
    .slice(0, METRIC_TILE_COUNT);

  // Weniger als zwei Kacheln sind keine Kachelreihe, sondern eine einsame
  // Karte - dann traegt das Modul-Widget die Zahl besser.
  return tiles.length < 2 ? [] : tiles;
}

/* Die AUSWAHL steht getrennt von der DARSTELLUNG, damit die Zusage pruefbar ist,
 * ohne ein Dokument zu bauen: was die Reihe zeigt, ist die Aussage - dass sie es
 * in einem <a> zeigt, ist ihre Form. */
function renderMetricTiles(data, currency, shown = new Set()) {
  const tiles = selectMetricTiles(data, currency, shown);
  if (!tiles.length) return '';
  return `<div class="metric-tiles">${tiles.map(renderMetricTile).join('')}</div>`;
}

// --------------------------------------------------------
// Belohnungen-Widget (Familien-Punktestand)
// --------------------------------------------------------

function renderRewardsWidget(rewards) {
  const standings = Array.isArray(rewards?.standings) ? rewards.standings : [];
  if (!standings.length) {
    return `<div class="widget widget--rewards">
      ${widgetHeader('rewards', t('nav.rewards'), 0, '/rewards')}
      <div class="widget__empty">
        <i data-lucide="award" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noRewards')}</div>
        ${emptyStateCta('/rewards', t('rewards.addReward'))}
      </div>
    </div>`;
  }

  const rows = standings.map((m, i) => {
    const color = m.avatar_color || AVATAR_FALLBACK_COLOR;
    const avatarInner = m.avatar_data
      ? `<img src="${esc(m.avatar_data)}" alt="" loading="lazy">`
      : esc(initials(m.display_name));
    return `
      <div class="rewards-widget-row${i === 0 ? ' rewards-widget-row--leader' : ''}" data-route="/rewards" role="button" tabindex="0">
        <span class="rewards-widget-row__rank" aria-hidden="true">${i + 1}</span>
        <span class="rewards-widget-row__avatar" style="background:${esc(color)};color:${getReadableTextColor(color)}">${avatarInner}</span>
        <span class="rewards-widget-row__name">${esc(m.display_name)}</span>
        <span class="rewards-widget-row__points"><strong>${esc(formatPoints(m.balance))}</strong> ${esc(t('rewards.pointsUnit'))}</span>
      </div>
    `;
  }).join('');

  const pending = Number(rewards?.pending) || 0;
  const footer = pending > 0
    ? `<div class="rewards-widget__footer" data-route="/rewards" role="button" tabindex="0">
        <i data-lucide="clock" aria-hidden="true"></i>
        <span>${t('dashboard.rewardsPending', { count: pending })}</span>
      </div>`
    : '';

  const badge = Number(rewards?.participantCount) || standings.length;
  return `<div class="widget widget--rewards">
    ${widgetHeader('rewards', t('nav.rewards'), badge, '/rewards')}
    <div class="widget__body">
      <div class="rewards-widget">${rows}</div>
      ${footer}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Gesundheit-Widget (heutige Medikamenten-Dosen)
// --------------------------------------------------------

function renderHealthWidget(health) {
  if (!health?.hasMeds) {
    return `<div class="widget widget--health">
      ${widgetHeader('health', t('nav.health'), null, '/health')}
      <div class="widget__empty">
        <i data-lucide="heart-pulse" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.healthNoMeds')}</div>
        ${emptyStateCta('/health', t('health.meds.add'))}
      </div>
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

  return `<div class="widget widget--health">
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

function renderCycleWidget(cycle) {
  // cycle: { periods, settings } (owner-only) | null (Ladefehler) | undefined (Kachel versteckt)
  const prediction = cycle
    ? predictCycle(cycle.periods || [], cycle.settings || {})
    : { hasData: false };

  // Ohne Historie: Onboarding-Empty statt Fehlerkachel — führt in den Zyklus-Flow.
  if (!prediction.hasData) {
    return `<div class="widget widget--cycle">
      ${widgetHeader('cycle', t('health.cycle.title'), null, '/health/cycle')}
      <div class="widget__empty">
        <i data-lucide="calendar-heart" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('health.cycle.emptyTitle')}</div>
        ${emptyStateCta('/health/cycle', t('health.cycle.add'))}
      </div>
    </div>`;
  }

  const phaseLabel = t(CYCLE_WIDGET_PHASE_KEYS[prediction.phase] || CYCLE_WIDGET_PHASE_KEYS[PHASE.FOLLICULAR]);
  const dayText = t('health.cycle.ring.cycleDay', { day: prediction.cycleDay });
  const countdown = cycleWidgetCountdown(prediction);
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

  return `<div class="widget widget--cycle">
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
          <span class="cycle-widget__date">${esc(formatDate(prediction.nextStart))}</span>
        </div>
      </div>
    </div>
  </div>`;
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

  if (!hasTypes) {
    return `<div class="widget widget--schedule">
      ${widgetHeader('schedule', t('nav.schedule'), null, '/schedule')}
      <div class="widget__empty">
        <i data-lucide="calendar-clock" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.scheduleEmpty')}</div>
        ${emptyStateCta('/schedule', t('schedule.createShiftType'))}
      </div>
    </div>`;
  }

  if (!entries.length) {
    return `<div class="widget widget--schedule">
      ${widgetHeader('schedule', t('nav.schedule'), null, '/schedule/patterns')}
      <div class="widget__body"><p class="u-meta schedule-widget-empty">${esc(t('schedule.empty'))}</p></div>
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
  const rows = sorted.slice(0, listRowCap(size)).map((entry) => {
    const user = users.find((item) => Number(item.id) === Number(entry.user_id));
    const type = entry.shift_type;
    const accent = user?.avatar_color || AVATAR_FALLBACK_COLOR;
    const avatarInner = user?.avatar_data
      ? `<img src="${esc(user.avatar_data)}" alt="" loading="lazy">`
      : esc(initials(user?.display_name ?? ''));
    const shiftLabel = type
      ? esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name)
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
      <div class="schedule-widget-row" data-route="/schedule/patterns" role="button" tabindex="0">
        <span class="schedule-widget-row__avatar" style="background:${esc(accent)};color:${getReadableTextColor(accent)}">${avatarInner}</span>
        <span class="schedule-widget-row__name">${esc(user?.display_name ?? '')}</span>
        <span class="schedule-widget-row__shift">${icon}<span class="schedule-widget-row__dot" style="--schedule-color:${esc(swatchColor)}"></span>${shiftLabel}${badge}</span>
      </div>`;
  }).join('');

  return `<div class="widget widget--schedule">
    ${widgetHeader('schedule', t('nav.schedule'), onShift, '/schedule/patterns')}
    <div class="widget__body">
      <div class="schedule-widget">${rows}</div>
    </div>
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

  if (!items.length) {
    return `<div class="widget widget--waste">
      ${widgetHeader('waste', t('nav.waste'), null, '/waste')}
      <div class="widget__empty">
        <i data-lucide="trash-2" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('waste.emptyTypesTitle')}</div>
        ${emptyStateCta('/waste', t('waste.addType'))}
      </div>
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

  const capped = sorted.slice(0, listRowCap(size));
  const rows = capped.map((entry) => {
    const type = entry.type;
    const next = entry.next;
    const accent = type.color || 'var(--color-border)';
    const icon = type.icon ? `<i data-lucide="${esc(type.icon)}" class="waste-widget-row__icon" aria-hidden="true"></i>` : '';

    if (!next) {
      return `
        <div class="waste-widget-row" data-route="/waste" role="button" tabindex="0">
          <span class="waste-widget-row__dot" style="--waste-color:${esc(accent)}"></span>
          <span class="waste-widget-row__name">${icon}${esc(type.name)}</span>
          <span class="waste-widget-row__date waste-widget-row__date--none">${esc(t('waste.noUpcomingPickup'))}</span>
        </div>`;
    }

    // Dieselbe Herkunfts-Extraktion wie originBadges() (pages/waste.js): der
    // Beleg fuer "verschoben" ist der Ursprungstermin des Schedule-Origins, nicht
    // ein eigenes Feld auf der Occurrence.
    const movedOriginal = next.moved
      ? next.origins.find((o) => o.kind === 'schedule' && o.original_date)?.original_date
      : null;
    const moved = next.moved
      ? `<i data-lucide="move" class="waste-widget-row__flag" aria-label="${esc(t('waste.movedFromBadge', { date: movedOriginal ? formatDate(movedOriginal) : '' }))}"></i>`
      : '';
    const coalesced = next.coalesced
      ? `<i data-lucide="layers" class="waste-widget-row__flag" aria-label="${esc(t('waste.coalescedHint'))}"></i>`
      : '';
    const emphasize = next.date_key === earliestDate ? ' waste-widget-row__date--next' : '';

    return `
      <div class="waste-widget-row" data-route="${esc(`/waste${next.deep_link}`)}" role="button" tabindex="0">
        <span class="waste-widget-row__dot" style="--waste-color:${esc(accent)}"></span>
        <span class="waste-widget-row__name">${icon}${esc(type.name)}${moved}${coalesced}</span>
        <span class="waste-widget-row__date${emphasize}">${esc(relativeDateLabel(next.date_key))}</span>
      </div>`;
  }).join('');

  const rest = Math.max(0, sorted.length - capped.length);
  const more = rest > 0
    ? `<p class="waste-widget-more">${esc(t('dashboard.countdownMore', { count: rest }))}</p>`
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

  return `<div class="widget widget--waste">
    ${widgetHeader('waste', t('nav.waste'), upcomingCount, '/waste')}
    <div class="widget__body">
      <div class="waste-widget">${rows}${more}</div>
      ${refreshWarning}
    </div>
  </div>`;
}

// --------------------------------------------------------
// Haushaltshilfe-Widget (Anwesenheit + offene Zahlung)
// --------------------------------------------------------

function renderHousekeepingWidget(hk, currency) {
  if (!hk?.configured) {
    return `<div class="widget widget--housekeeping">
      ${widgetHeader('housekeeping', t('nav.housekeeping'), null, '/housekeeping')}
      <div class="widget__empty">
        <i data-lucide="paintbrush" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.housekeepingNone')}</div>
        ${emptyStateCta('/housekeeping', t('housekeeping.addTask'))}
      </div>
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
          <div class="housekeeping-widget__sub">${hk.workerName ? `${esc(hk.workerName)} · ` : ''}${hk.presentSince ? t('dashboard.housekeepingSince', { time: formatTime(new Date(hk.presentSince)) }) : ''}</div>
        </div>
      </div>`
    : `<div class="housekeeping-widget__status">
        <span class="housekeeping-widget__dot housekeeping-widget__dot--idle" aria-hidden="true"></span>
        <div class="housekeeping-widget__lines">
          <div class="housekeeping-widget__state">${hk.lastVisit ? t('dashboard.housekeepingLastVisit', { date: formatDate(hk.lastVisit) }) : t('dashboard.housekeepingNoVisits')}</div>
          <div class="housekeeping-widget__sub">${t('dashboard.housekeepingVisitsMonth', { count: visits })}</div>
        </div>
      </div>`;

  const unpaidChip = unpaid > 0
    ? `<div class="housekeeping-widget__unpaid"><i data-lucide="banknote" aria-hidden="true"></i><span>${t('dashboard.housekeepingUnpaid', { amount: formatCurrency(unpaid, currency) })}</span></div>`
    : '';

  return `<div class="widget widget--housekeeping">
    ${widgetHeader('housekeeping', t('nav.housekeeping'), null, '/housekeeping')}
    <div class="widget__body">
      <div class="housekeeping-widget">${statusBlock}${unpaidChip}</div>
    </div>
  </div>`;
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
function renderTodayRow(row) {
  const mark = whoMark(row.who);
  // Trailing-Detail ist die ZEIT, kein Zähler mehr: die Programm-Zeile
  // beantwortet „wann", und dieselbe Badge-Form für drei Bedeutungen
  // (Anzahl/offen/Alter) war ein Critique-Befund (H6).
  const time = row.timeLabel
    ? `<span class="today-cockpit-card__time${row.overdue ? ' today-cockpit-card__time--overdue' : ''}">${esc(row.timeLabel)}</span>`
    : '';
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
  const inner = `
      <span class="${mark ? 'seal-pair' : ''}"><span class="module-seal today-cockpit-card__icon">${moduleIconHTML(row.icon)}</span>${mark}</span>
      <span class="today-cockpit-card__body">
        <strong class="today-cockpit-card__value">${esc(row.title)}</strong>
        <span class="today-cockpit-card__sub">${esc(row.sub)}</span>
      </span>
      ${time}
  `;
  const attrs = `class="today-cockpit-card today-cockpit-card--${row.tone}" data-route="${esc(row.route)}"${objectAttrs}`;
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
function buildTodayCockpitModel(data, cfg = [], { cap = PROGRAM_ROW_CAP } = {}) {
  // Kein Echo: ist das Modul-Widget einer Domäne sichtbar, entfallen ihre
  // Programm-Zeilen — jede Domäne hat genau eine Repräsentation (Cockpit ODER
  // Widget), statt dieselbe Aufgabe/Termin doppelt zu zeigen.
  const widgetShown = (id) => Array.isArray(cfg) && cfg.some((w) => w.id === id && w.visible);
  const domainInCockpit = (module) => !window.yuvomi?.isModuleDisabled(module) && !widgetShown(module);

  const includeTasks = domainInCockpit('tasks');
  const includeCalendar = domainInCockpit('calendar');
  const includeMeals = domainInCockpit('meals');
  const includeShopping = domainInCockpit('shopping');

  const program = buildTodayProgram(data, { includeTasks, includeCalendar, includeMeals });
  const visibleRows = program.rows.slice(0, cap);
  const overflow = program.rows.length - visibleRows.length;

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
  const scheduleWidgetVisible = widgetShown('schedule');
  let state = null;
  if (!program.rows.length && !scheduleWidgetVisible) {
    const sayAllDone = includeTasks && program.tasksDoneToday > 0;
    if (sayAllDone || includeCalendar) {
      state = {
        title: sayAllDone ? t('dashboard.todayAllDone') : t('dashboard.todayFree'),
        sub: outlook?.sub ?? '',
        icon: sayAllDone ? 'check-circle' : 'sparkles',
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
        route: '/shopping',
        who: null,
      }
    : null;

  // Abschluss-Zeile (Peak-End): das beruhigende „danach nichts mehr" - aber nur,
  // wenn das Programm wirklich vollständig ist. Neben „+N weitere" wäre sie
  // gelogen, und unter der Zustands-Zeile wäre sie eine Doppelung. Ist MORGEN
  // eine Aufgabe fällig, sagt die Coda es dazu - sonst wäre „nichts mehr" um
  // 21 Uhr eine falsche Entwarnung (Critique P3). Nur morgen, nicht später:
  // eine Frist in drei Tagen ist keine Falle.
  let coda = null;
  if (program.rows.length > 0 && overflow === 0) {
    const tomorrowKey = addLocalDays(householdToday(), 1);
    const tomorrowTask = includeTasks && program.nextDueTask?.due_date === tomorrowKey ? program.nextDueTask : null;
    coda = tomorrowTask
      ? t('dashboard.todayNothingElseTomorrow', { title: tomorrowTask.title })
      : t('dashboard.todayNothingElse');
  }

  // `allRows` ist NICHT dasselbe wie `rows`: der Deckel entscheidet, was zu
  // SEHEN ist, nicht, was heute ansteht. „Wer heute dran ist" zaehlt ueber den
  // ganzen Tag - sonst verschwaende jemand aus der Antwort, nur weil seine
  // Zeilen hinter dem Deckel liegen.
  return { rows: visibleRows, allRows: program.rows, overflow, state, shopping, coda };
}

function renderTodayCockpit(data, cfg = [], editing = false) {
  const model = buildTodayCockpitModel(data, cfg);

  const parts = [];
  if (model.state) parts.push(renderTodayStateRow(model.state));
  parts.push(...model.rows.map(renderTodayRow));
  if (model.overflow > 0) {
    parts.push(`<div class="today-cockpit__more">${esc(t('dashboard.todayMore', { count: model.overflow }))}</div>`);
  }
  if (model.shopping) parts.push(renderTodayRow(model.shopping));
  if (model.coda) parts.push(`<div class="today-cockpit__coda">${esc(model.coda)}</div>`);

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

  return `
    <section class="today-cockpit" aria-labelledby="today-cockpit-title">
      <div class="today-cockpit__header">
        <h2 id="today-cockpit-title">${esc(t('dashboard.todayTitle'))}</h2>
        ${hideBtn}
      </div>
      <div class="today-cockpit__grid">
        ${parts.join('')}
      </div>
    </section>
  `;
}


/* WOHER MAN WEISS, DASS DIE FLAECHE LEBT (Critique R2, A8). Der stille Refresh
 * (15-Min-Takt plus Tab-Reaktivierung) tut seine Arbeit unsichtbar - und genau
 * das ist am Wandtablet das Problem: eine Flaeche, die sich nie erkennbar
 * bewegt, ist von einer eingefrorenen nicht zu unterscheiden. Wer daran
 * vorbeigeht, kann „heute nichts mehr" nicht glauben, ohne neu zu laden.
 *
 * Der Anker ist deshalb absichtlich klein und absolut: eine Uhrzeit, keine
 * „vor 3 Minuten"-Angabe, die einen zweiten Timer braeuchte, nur um sich
 * selbst zu widerlegen. Er steht in der Werkzeugspalte, nicht im Gruss-Stapel
 * - der Masthead soll weiter mit Datum, Gruss und Wetter sprechen, nicht mit
 * Betriebszustand. Im Bearbeiten-Modus entfaellt er: dort wird nicht
 * aktualisiert, und die Werkzeugleiste braucht ihren Platz. */
function renderDashboardOverview(user, editing = false, weather = null, updatedAt = null, scope = {}) {
  // Wer der Vorgabe des Haushalts folgt, hat nichts zurueckzusetzen; wer sie
  // setzen darf, ist Admin (#827).
  const { followsDefault = true, canPublish = false } = scope;
  const dateLabel = mastheadDateLabel();
  const updated = !editing && updatedAt
    ? `<p class="dashboard-overview__updated">${esc(t('dashboard.updatedAt', { time: formatTime(updatedAt) }))}</p>`
    : '';

  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header${editing ? ' dashboard-overview__header--editing' : ''}">
        <div class="dashboard-overview__heading">
          <span class="dashboard-overview__date">${dateLabel}</span>
          <h2 class="dashboard-overview__title dashboard-overview__title--${greetingPeriod()}">${greeting(user.display_name)}</h2>
          ${mastheadWeatherHtml(weather)}
        </div>
        <div class="dashboard-overview__tools">
          ${editing ? `
          <!-- Die Beruhigung stand nur im Toast NACH dem Speichern, die
               Unsicherheit sitzt aber DAVOR: während man eine Kachel wegzieht
               und nicht weiß, ob man sie gerade den Kindern wegnimmt (Critique
               2026-08-16). Ein Satz im Anpassen-Modus beantwortet sie im
               richtigen Moment. -->
          <div class="dashboard-customize-scope">
            <p>${t('dashboard.customizeScopeHint')}</p>
            ${followsDefault ? `<p class="dashboard-customize-scope__state">${t('dashboard.customizeFollowsDefault')}</p>` : ''}
          </div>
          <div class="dashboard-customize-toolbar" role="toolbar" aria-label="${t('dashboard.customizeTitle')}">
            ${canPublish ? `
            <button class="btn btn--ghost" id="dashboard-customize-publish">
              <i data-lucide="users" class="icon-sm" aria-hidden="true"></i>
              ${t('dashboard.customizeSetDefault')}
            </button>` : ''}
            ${followsDefault ? '' : `
            <button class="btn btn--ghost" id="dashboard-customize-reset">
              <i data-lucide="rotate-ccw" class="icon-sm" aria-hidden="true"></i>
              ${t('dashboard.customizeReset')}
            </button>`}
            <button class="btn btn--secondary" id="dashboard-customize-cancel">${t('common.cancel')}</button>
            <button class="btn btn--primary" id="dashboard-customize-save">${t('common.save')}</button>
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
          ${editing ? '' : `
          <button class="dashboard-icon-btn" id="dashboard-wall-enter"
                  aria-label="${t('dashboard.wallEnter')}"
                  title="${t('dashboard.wallEnter')}">
            <i data-lucide="maximize-2" aria-hidden="true"></i>
          </button>`}
          <button class="dashboard-icon-btn" id="dashboard-customize-btn"
                  aria-label="${editing ? t('dashboard.customizeExit') : t('dashboard.customize')}"
                  title="${editing ? t('dashboard.customizeExit') : t('dashboard.customize')}"
                  aria-pressed="${editing ? 'true' : 'false'}">
            <i data-lucide="${editing ? 'x' : 'settings-2'}" aria-hidden="true"></i>
          </button>
          ${updated}
        </div>
      </div>
    </section>
  `;
}

function widgetSizeClass(size) {
  return WIDGET_SIZE_OPTIONS.includes(size) ? `widget-size--${size}` : 'widget-size--1x1';
}

function renderSizeMiniGrid(size) {
  return `<span class="widget-size-mini" aria-hidden="true">${renderSizeMiniGridCells(size)}</span>`;
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
          <div class="modal-actions">
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
async function openWidgetOptions(id, current = {}) {
  const extMeta = getExtensionWidgetMeta(id);
  if (extMeta?.optionsSchema) return openExtensionWidgetOptions(id, extMeta, current);

  const options = { ...current };
  const categories = id === 'tasks' ? await loadTaskCategories() : [];
  const wasteTypes = id === 'waste' ? await loadWasteTypes() : [];

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
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('calendar.filtersLayers')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionCalendarBirthdaysHint')}</p>
        <label class="widget-options__choice">
          <input type="checkbox" name="cal-birthdays" ${options.birthdays === 'hide' ? '' : 'checked'}>
          <span>${t('calendar.toggleBirthdays')}</span>
        </label>
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
    : `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionTaskCategories')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionTaskCategoriesHint')}</p>
        ${categories.length ? categories.map((c) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="task-category" value="${esc(c.key)}"
                 ${(options.categories ?? []).includes(c.key) ? 'checked' : ''}>
          <span>${esc(taskCategoryLabel(c))}</span>
        </label>`).join('') : `<p class="widget-options__hint">${t('dashboard.optionTaskCategoriesEmpty')}</p>`}
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
          <div class="modal-actions">
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
          } else if (id === 'waste') {
            const picked = [...panel.querySelectorAll('input[name="waste-type"]:checked')].map((el) => Number(el.value));
            // Dieselbe Regel wie bei den Aufgaben-Kategorien: keine Auswahl
            // heisst „alle" (PLAN.md: eine seltene Abholung darf nie
            // stillschweigend verschwinden, nur weil niemand den Dialog
            // geoeffnet hat).
            if (picked.length) next.types = picked;
          } else {
            const picked = [...panel.querySelectorAll('input[name="task-category"]:checked')].map((el) => el.value);
            // Keine Auswahl heisst „alle" - eine leere Liste als Filter waere
            // ein leeres Dashboard fuer jemanden, der nur den Dialog geoeffnet hat.
            if (picked.length) next.categories = picked;
          }
          finish(next);
          closeModal({ force: true });
        });
      },
    });
  });
}

function renderWidgetCustomizeControls(w, index = 0, total = 1) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const activeSize = nearestPreset(w.size);

  // Segmentiertes Größen-Steuerelement: vier klickbare Mini-Grid-Presets ersetzen
  // die frühere Kombination aus dekorativem Mini-Grid + „Größe"-Label + 132px-
  // <select> (Critique P1: doppelte Kontrolle + Overflow auf 1×1-Kacheln). Jeder
  // Button zeigt seine Form direkt und markiert die aktive Größe.
  const sizeButtons = WIDGET_SIZE_PRESETS.map((p) => {
    const active = p.value === activeSize;
    return `<button type="button" class="widget-size-btn${active ? ' widget-size-btn--active' : ''}"
              data-widget-size-preset="${p.value}" data-widget-id="${esc(w.id)}"
              aria-pressed="${active ? 'true' : 'false'}" aria-label="${esc(t(p.labelKey))}" title="${esc(t(p.labelKey))}">
        ${renderSizeMiniGrid(p.value)}
      </button>`;
  }).join('');

  return `
    <div class="widget-edit-controls" data-widget-controls>
      <button type="button" class="widget-edit-controls__handle" data-widget-drag-handle
              aria-label="${t('dashboard.customizeReorderHandle')}" aria-keyshortcuts="ArrowUp ArrowDown">
        <i data-lucide="grip-vertical" aria-hidden="true"></i>
      </button>
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
      <div class="widget-edit-controls__size" role="group" aria-label="${t('dashboard.customizeSizeFor', { widget: widgetLabel(w.id) })}">
        ${sizeButtons}
      </div>
      ${widgetHasOptions(w.id) ? `
      <button type="button" class="widget-edit-controls__options" data-widget-options="${esc(w.id)}"
              aria-label="${esc(t('dashboard.optionsFor', { widget: widgetLabel(w.id) }))}"
              title="${esc(t('dashboard.optionsFor', { widget: widgetLabel(w.id) }))}">
        <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
      </button>` : ''}
      <button type="button" class="widget-edit-controls__hide" data-widget-hide="${esc(w.id)}" aria-label="${t('dashboard.customizeHide', { widget: widgetLabel(w.id) })}">
        <i data-lucide="eye-off" aria-hidden="true"></i>
      </button>
    </div>
  `;
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
   * Knopf im Knopf waere kein gueltiges Markup. */
  const chips = glanceChip + hidden.map((w) => `
    <div class="widget-restore-chip-group">
      <button type="button" class="widget-restore-chip" data-widget-show="${esc(w.id)}"
              aria-label="${t('dashboard.customizeShow', { widget: widgetLabel(w.id) })}">
        <i data-lucide="${widgetIcon(w.id)}" class="widget-restore-chip__icon" aria-hidden="true"></i>
        <span class="widget-restore-chip__label">${widgetLabel(w.id)}</span>
        <i data-lucide="plus" class="widget-restore-chip__add" aria-hidden="true"></i>
      </button>
      ${widgetHasOptions(w.id) ? `
      <button type="button" class="widget-restore-chip__options" data-widget-options="${esc(w.id)}"
              aria-label="${esc(t('dashboard.optionsFor', { widget: widgetLabel(w.id) }))}"
              title="${esc(t('dashboard.optionsFor', { widget: widgetLabel(w.id) }))}">
        <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
      </button>` : ''}
    </div>`).join('');
  return `
    <section class="widget-restore" aria-label="${t('dashboard.customizeHiddenTitle')}">
      <h3 class="widget-restore__title">${t('dashboard.customizeHiddenTitle')}</h3>
      <div class="widget-restore__chips">${chips}</div>
    </section>
  `;
}

function renderDashboardLayout(cfg, data, weather, currency, { editing = false, visibleMealTypes = MEAL_ORDER, glanceHidden = false } = {}) {
  const widgetById = {
    tasks: () => renderUrgentTasks(data.urgentTasks ?? []),
    calendar: () => renderUpcomingEvents(data.upcomingEvents ?? []),
    birthdays: (size) => renderUpcomingBirthdays(data.birthdays ?? [], size),
    countdown: (size) => renderCountdowns(data.countdowns ?? [], size, data.countdownTotal),
    budget: () => renderBudgetWidget(data.budget ?? {}, currency),
    rewards: () => renderRewardsWidget(data.rewards ?? {}),
    health: () => renderHealthWidget(data.health ?? {}),
    cycle: () => renderCycleWidget(data.cycle),
    housekeeping: () => renderHousekeepingWidget(data.housekeeping ?? {}, currency),
    schedule: (size) => renderScheduleWidget(data.schedule, data.users ?? [], size),
    waste: (size) => renderWasteWidget(data.waste, size),
    family: () => renderFamilyWidget(data.users ?? [], data),
    meals: () => renderTodayMeals(data.todayMeals ?? [], visibleMealTypes),
    notes: (size) => renderPinnedNotes(data.pinnedNotes ?? [], size),
    shopping: () => renderShoppingLists(data.shoppingLists ?? []),
    weather: () => (weather ? renderWeatherWidget(weather) : ''),
    clock: () => renderClockWidget(),
    quicklinks: () => renderQuickLinks(data.quicklinks ?? []),
    // Die Kachelreihe braucht als einziges Widget zu wissen, wer sonst noch
    // dasteht - sie ist die einzige, die fremde Zahlen zeigt. Gerechnet aus
    // DERSELBEN Bedingung, nach der die Kacheln gleich gefiltert werden, damit
    // die beiden nicht auseinanderlaufen; `metrics` selbst ist ausgenommen, es
    // waere sonst sein eigener Grund zu schweigen.
    metrics: () => renderMetricTiles(data, currency, new Set(
      cfg.filter((w) => w.visible && w.id !== 'metrics' && isWidgetModuleEnabled(w.id)).map((w) => w.id),
    )),
  };

  const tiles = cfg
    .filter((w) => w.visible && isWidgetModuleEnabled(w.id) && (widgetById[w.id] || isExtensionWidget(w.id)))
    .map((w, index, arr) => {
      let html;
      try {
        if (isExtensionWidget(w.id)) {
          html = `<div class="widget extension-widget-mount" data-extension-widget-mount="1">
            <div class="widget__empty">${esc(t('common.loading'))}</div>
          </div>`;
        } else {
          html = widgetById[w.id](w.size);
        }
      } catch (err) {
        console.error(`[dashboard] Widget "${w.id}" konnte nicht gerendert werden`, err);
        html = renderWidgetError(w.id);
      }
      if (!html) return '';
      return `<div class="widget-wrapper ${widgetSizeClass(w.size)} ${editing ? 'widget-wrapper--editing' : ''}"
                   data-widget-id="${esc(w.id)}" ${editing ? 'draggable="true"' : ''}>
        ${editing ? renderWidgetCustomizeControls(w, index, arr.length) : ''}
        ${html}
      </div>`;
    })
    .join('');

  // Alle Widgets ausgeblendet: kein toter Screen, sondern ein Hinweis zurück
  // in die Anpassung (das Cockpit oben bleibt als Orientierung erhalten).
  const gridInner = tiles
    || emptyHintHTML(t('dashboard.allWidgetsHidden'), { icon: 'layout-dashboard' });
  // Beim Bearbeiten und bei bewusst umsortierten Layouts die Quellordnung bewahren
  // (kein dense-Umpacken); der Autor-Default darf dicht packen.
  const preserveOrder = (editing || isUserOrderedConfig(cfg)) ? ' dashboard__grid--preserve-order' : '';
  const grid = `<div class="dashboard__grid ${editing ? 'dashboard__grid--editing' : ''}${preserveOrder}" id="dashboard-widget-grid">${gridInner}</div>`;
  // Im Bearbeiten-Modus folgt die Wieder-Einblenden-Leiste dem Grid, damit
  // ausgeblendete Widgets nicht in einer Sackgasse verschwinden.
  return editing ? `${grid}${renderHiddenWidgetsTray(cfg, glanceHidden)}` : grid;
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

function renderDashboardSkeleton() {
  const tiles = layoutHintSizes(buildDefaultWidgetConfig().filter((w) => w.visible).map((w) => w.size))
    .map((size) => `<div class="widget-wrapper ${widgetSizeClass(size)}">${skeletonWidget(3)}</div>`)
    .join('');
  return `
    <section class="dashboard-overview">
      <div class="dashboard-overview__header">
        <div class="dashboard-overview__heading">
          <div class="skeleton skeleton-line skeleton-line--short"></div>
          <div class="skeleton skeleton-line skeleton-line--medium"></div>
        </div>
      </div>
    </section>
    <div class="dashboard__grid">${tiles}</div>
  `;
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

// Inline-Fehlerkachel für ein einzelnes Widget (siehe Fehler-Isolation in
// renderDashboardLayout). Nutzt die vorhandene .widget/.widget__empty-Grammatik,
// damit sie sich ruhig einreiht statt wie ein Systemfehler zu schreien.
function renderWidgetError(id) {
  return `<div class="widget widget--error" role="alert">
    <div class="widget__header">
      <span class="widget__title">
        <i data-lucide="${widgetIcon(id)}" class="widget__title-icon" aria-hidden="true"></i>
        ${widgetLabel(id)}
      </span>
    </div>
    <div class="widget__empty">
      <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
      <div>${t('dashboard.widgetError')}</div>
      <button type="button" class="btn btn--secondary widget__retry" data-widget-retry="${esc(id)}">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Shopping-Widget
// --------------------------------------------------------

function renderShoppingLists(lists) {
  if (!lists.length) {
    return `<div class="widget widget--shopping">
      ${widgetHeader('shopping', t('nav.shopping'), 0, '/shopping')}
      <div class="widget__empty">
        <i data-lucide="shopping-cart" class="empty-state__icon" aria-hidden="true"></i>
        <div>${t('dashboard.noShoppingLists')}</div>
        ${emptyStateCta('/shopping', t('shopping.newListButton'))}
      </div>
    </div>`;
  }

  const totalOpen = lists.reduce((sum, l) => sum + l.open_count, 0);

  const listsHtml = lists.map((list) => {
    const progress = list.total_count > 0
      ? Math.round(((list.total_count - list.open_count) / list.total_count) * 100)
      : 0;

    const itemsHtml = list.items.map((item) => `
      <div class="shopping-widget-item">
        <span class="shopping-widget-item__dot"></span>
        <span class="shopping-widget-item__name">${esc(item.name)}</span>
        ${item.quantity ? `<span class="shopping-widget-item__qty">${esc(item.quantity)}</span>` : ''}
      </div>
    `).join('');

    const moreCount = list.open_count - list.items.length;

    return `
      <div class="shopping-widget-list" data-route="/shopping" role="button" tabindex="0">
        <div class="shopping-widget-list__header">
          <span class="shopping-widget-list__name">${esc(list.name)}</span>
          <span class="shopping-widget-list__count">${list.total_count - list.open_count}/${list.total_count}</span>
        </div>
        <div class="shopping-widget-list__progress">
          <div class="shopping-widget-list__bar" style="--progress-scale:${progress / 100}"></div>
        </div>
        <div class="shopping-widget-list__items">
          ${itemsHtml}
          ${moreCount > 0 ? `<div class="shopping-widget-item shopping-widget-item--more">${t('dashboard.shoppingMore', { count: moreCount })}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `<div class="widget widget--shopping">
    ${widgetHeader('shopping', t('nav.shopping'), totalOpen, '/shopping')}
    <div class="widget__body">${listsHtml}</div>
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
function mastheadWeatherHtml(weather) {
  if (!weather?.current) return '';
  const desc = weatherDescText(weather, weather.current.desc);
  return `
    <p class="dashboard-overview__weather"${weatherToneAttr(weather.current.icon)}>
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

function renderWeatherWidget(weather) {
  if (!weather) return '';

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
    <div class="widget widget--weather weather-widget" id="weather-widget"${weatherToneAttr(current.icon)}${weatherMotionAttr(current.icon)}>
      <h3 class="sr-only">${esc(t('dashboard.weather'))}</h3>
      <button class="weather-widget__refresh" id="weather-refresh-btn" aria-label="${t('dashboard.weatherRefresh')}" title="${t('dashboard.weatherRefreshTitle')}">
        <i data-lucide="refresh-cw" class="icon-md" aria-hidden="true"></i>
      </button>
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
function renderClockWidget({ wall = false } = {}) {
  const { time, date, machineTime } = clockWidgetParts();
  const cls = wall ? 'clock-widget clock-widget--wall' : 'widget widget--clock clock-widget';
  return `
    <div class="${cls}" id="clock-widget">
      <time class="clock-widget__time" id="clock-widget-time" datetime="${esc(machineTime)}">${esc(time)}</time>
      <p class="clock-widget__date" id="clock-widget-date">${esc(date)}</p>
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
  const time = row.timeLabel
    ? `<span class="wall-row__time${row.overdue ? ' wall-row__time--overdue' : ''}">${esc(row.timeLabel)}</span>`
    : '';
  return `
    <li class="wall-row wall-row--${esc(row.tone)}">
      <span class="module-seal wall-row__seal">${moduleIconHTML(row.icon)}</span>
      <span class="wall-row__body">
        <span class="wall-row__title">${esc(row.title)}</span>
        <span class="wall-row__sub">${esc(row.sub)}</span>
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

/**
 * „Wer heute dran ist" - Gesichter statt Namenszeilen: aus zwei Metern erkennt
 * man ein Gesicht schneller als eine Textzeile.
 *
 * DIE ZAHL IST DIE GANZE AUSKUNFT, und zwar bewusst. Die Zeile daneben stuende
 * schon im Programm links; sie hier zu wiederholen waere ein Echo derselben
 * Tatsache. Das Programm sagt WAS, dieser Abschnitt sagt WER und WIE VIEL.
 *
 * Im Solo-Haushalt entfaellt er still - dieselbe Regel wie beim
 * Ueberlappungszeichen und beim Familien-Widget: was nur eine sinnvolle
 * Belegung hat, wird nicht gezeigt.
 *
 * NUR DER VORNAME unter dem Gesicht: „Linda Johnson" passt in keine Spalte
 * dieser Breite und stand als „Linda Jo…" da - ein abgeschnittener Name ist
 * auf zwei Metern schlechter als gar keiner. Im eigenen Haushalt ist der
 * Vorname ohnehin die Antwort.
 */
function renderWallWho(data, model) {
  if (isSoloHousehold()) return '';
  const users = Array.isArray(data?.users) ? data.users : [];
  if (!users.length) return '';

  const counts = new Map();
  for (const row of model.allRows) {
    const id = row.who?.id;
    if (id == null) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const onDuty = users
    .filter((u) => counts.has(u.id))
    .sort((a, b) => (counts.get(b.id) - counts.get(a.id)) || String(a.display_name).localeCompare(String(b.display_name)));

  const shown = onDuty.slice(0, WALL_WHO_CAP);
  const body = shown.length
    ? `<ul class="wall-who__list">${shown.map((u) => {
        const color = u.avatar_color || AVATAR_FALLBACK_COLOR;
        const count = counts.get(u.id);
        return `
          <li class="wall-who__member">
            <span class="wall-who__mark">
              <span class="wall-who__avatar" style="background:${esc(color)};color:${getReadableTextColor(color)}">
                ${u.avatar_data ? `<img src="${esc(u.avatar_data)}" alt="" loading="lazy">` : esc(initials(u.display_name))}
              </span>
              <span class="wall-who__count">
                <span aria-hidden="true">${esc(String(count))}</span>
                <span class="sr-only">${esc(t('dashboard.wallWhoCount', { count }))}</span>
              </span>
            </span>
            <span class="wall-who__name">${esc(firstName(u.display_name))}</span>
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
 * DER AUSSTIEG IST LEISE DA, NICHT VERSTECKT. Ein sichtbarer Knopf
 * widerspraeche der ruhigen Flaeche, ein unsichtbarer waere eine Falle - also
 * steht er immer im DOM und ist immer per Tastatur erreichbar, traegt aber im
 * Ruhezustand nur sein Zeichen. Jede Beruehrung hebt ihn fuer ein paar Sekunden
 * auf die volle Kapsel samt Beschriftung (`data-wall-awake`, siehe
 * `wireWallSurface`). Weil sonst nichts auf der Flaeche beruehrbar ist,
 * kollidiert dieses Wecken mit nichts.
 */
function renderWallSurface(data, weather, { failed = false, loading = false, updatedAt = null } = {}) {
  const model = failed || loading ? null : buildTodayCockpitModel(data, [], { cap: WALL_ROW_CAP });

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

  // Der Kuechentimer (#844). Er wird auch im Lade- und Fehlerzustand gebaut: er
  // haengt an nichts, was geladen werden koennte, und ein laufender Timer, der
  // beim naechsten Netzfehler verschwaende, waere schlimmer als gar keiner.
  const timer = renderWallTimer();

  return `
    <div class="wall">
      ${renderClockWidget({ wall: true })}
      <div class="wall__stage${failed || loading ? ' wall__stage--single' : ''}">${main}</div>
      ${timer.display}
      <div class="wall__foot">
        ${stamp}
        ${timer.controls}
        <button type="button" class="wall__foot-btn" id="wall-exit" aria-label="${esc(t('dashboard.wallExit'))}">
          <i data-lucide="minimize-2" aria-hidden="true"></i>
          <span class="wall__foot-btn-label" aria-hidden="true">${esc(t('dashboard.wallExit'))}</span>
        </button>
      </div>
    </div>`;
}

/**
 * Verdrahtet die einzige Interaktion der Flaeche: den Ausstieg.
 *
 * Zwei Wege hinaus, und beide sind derselbe: der Knopf und die Escape-Taste.
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

  wireWallTimer(wall, rerender, signal);
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
    exitWallMode();
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
}

// --------------------------------------------------------
// FAB Speed-Dial
// --------------------------------------------------------

const FAB_ACTIONS = () => [
  { route: '/tasks',    label: t('dashboard.fabTask'),     icon: 'check-square'   },
  { route: '/calendar', label: t('dashboard.fabCalendar'), icon: 'calendar-plus'  },
  { route: '/shopping', label: t('dashboard.fabShopping'), icon: 'shopping-cart'  },
  { route: '/notes',    label: t('dashboard.fabNote'),     icon: 'sticky-note'    },
];

function renderFab() {
  const actionsHtml = FAB_ACTIONS().map((a) => `
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
function initFab(signal) {
  const fabMain     = findPageFab('fab-main');
  const fabGroup    = fabMain?.closest('.page-fab-group');
  const fabActions  = fabGroup?.querySelector('#fab-actions');
  const fabBackdrop = fabGroup?.querySelector('#fab-backdrop');
  if (!fabMain || !fabActions) return;

  // "Neu"-Button-Selector auf der jeweiligen Zielseite
  const FAB_NEW_BTN = {
    '/tasks':    '#btn-new-task',
    '/calendar': '#fab-new-event',
    '/shopping': '#fab-new-item',
    '/notes':    '#fab-new-note',
  };

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

  fabMain.addEventListener('click', (e) => { e.stopPropagation(); toggleFab(); });

  fabActions.querySelectorAll('[data-route]').forEach((el) => {
    const go = async () => {
      toggleFab(false);
      await window.yuvomi.navigate(el.dataset.route);
      const btnSelector = FAB_NEW_BTN[el.dataset.route];
      if (btnSelector) document.querySelector(btnSelector)?.click();
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
 * `rerender` frischt die Kachel auf, aus der geöffnet wurde - der Nutzer
 * bleibt, wo er war, statt im Aufgabenmodul zu landen. `user` reist mit,
 * weil an ihm haengt, wem seine eigenen Kommentare gehoeren und wer eine
 * gesperrte Aufgabe umschreiben darf.
 */
async function openTaskFromOverview(taskId, container, rerender, user) {
  try {
    const { openTaskById } = await import('/pages/tasks.js');
    await openTaskById(taskId, { user, container, onChanged: rerender });
  } catch (err) {
    console.error('[Dashboard] Aufgabe konnte nicht geöffnet werden:', err);
    window.yuvomi?.showToast(err.message ?? t('tasks.loadError'), 'danger');
  }
}

// --------------------------------------------------------
// Navigations-Links verdrahten
// --------------------------------------------------------

function wireLinks(container, rerender, { editing = false, user = null } = {}) {
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
      const show = () => openTaskFromOverview(el.dataset.objectId, container, rerender, user);
      el.addEventListener('click', show);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
      });
      return;
    }
    const go = () => window.yuvomi.navigate(el.dataset.route);
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
      el.addEventListener('click', () => openQuickLinksManager({ onChange: rerender }));
    });
  }

  // Task-Items öffnen die Leseansicht statt zu navigieren (#918)
  if (editing) return;
  // Die Countdown-Zeile einer Aufgabe hängt an demselben Griff (#647): sie
  // nennt ein Objekt, also trifft der Klick dieses Objekt. Ein eigener Handler
  // daneben wäre ein zweiter Weg zur selben Handlung.
  container.querySelectorAll('.task-item[data-task-id], .countdown-item[data-task-id]').forEach((el) => {
    const show = () => openTaskFromOverview(el.dataset.taskId, container, rerender, user);
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

function closestWidgetDrop(grid, event, draggedId) {
  const candidates = [...grid.querySelectorAll('.widget-wrapper[data-widget-id]')]
    .filter((item) => item.dataset.widgetId !== draggedId);
  if (!candidates.length) return null;

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const item of candidates) {
    const rect = item.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const distance = (dy * dy * 1.7) + (dx * dx);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { item, rect };
    }
  }
  if (!nearest) return null;

  const sameRow = event.clientY >= nearest.rect.top && event.clientY <= nearest.rect.bottom;
  const placement = sameRow
    ? (event.clientX > nearest.rect.left + nearest.rect.width / 2 ? 'after' : 'before')
    : (event.clientY > nearest.rect.top + nearest.rect.height / 2 ? 'after' : 'before');

  return { id: nearest.item.dataset.widgetId, placement, item: nearest.item };
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

  // Der Wand-Modus ist ein Zustand DIESER Seite, kein zweiter Ort: die Route,
  // die Daten, der stille Refresh und die Echo-Regel bleiben dieselben - nur
  // Massstab, Dichte und Bedienbarkeit aendern sich. Ob er laeuft, hat der
  // Router bereits an der Wurzel vermerkt (utils/wall-mode.js).
  const wallMode = isWallActive();

  setHtml(container, `
    <div class="dashboard app-page app-page--dashboard${wallMode ? ' dashboard--wall' : ''}" data-composition="dashboard">
      <h1 class="sr-only">${t('dashboard.title')}</h1>
      <div class="dashboard-shell" id="dashboard-shell">
        ${wallMode ? renderWallSurface(null, null, { loading: true }) : renderDashboardSkeleton()}
      </div>
    </div>
    ${wallMode ? '' : renderFab()}
  `);

  const rerender = () => render(container, { user, signal: routeSignal });

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
    wireWallTimer(container.querySelector('.wall'), rerender, signal);
    // Der Ausstieg gehoert zur selben Sorte: er haengt an nichts, was geladen
    // wird. Einmal verdrahtet, ueber den Container - er ueberlebt das zweite
    // Rendern und braucht keinen zweiten Aufruf.
    wireWallExit(container, rerender, signal);
  }

  let data         = { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], shoppingLists: [], birthdays: [], countdowns: [], users: [], budget: {}, rewards: {}, health: {}, housekeeping: {} };
  // Ein Stand von vorhin darf keine Kachel versprechen: erst nach dem Laden
  // wieder wahr (siehe die Notiz an `countdownAvailable`).
  setCountdownAvailability([]);
  let weather      = null;
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
  let isCustomizing = false;
  let currency     = 'EUR';
  let visibleMealTypes = MEAL_ORDER;
  let loadFailed   = false;
  let loadErrorStatus = null;
  // Zeitpunkt des letzten geglueckten Datenstands - der Anker im Masthead (A8).
  // Bleibt `null`, solange nichts geladen wurde: eine Uhrzeit ohne Daten
  // dahinter waere die falscheste aller Angaben.
  let lastLoadedAt = null;
  try {
    const [dashRes, weatherRes, prefsRes] = await Promise.all([
      api.get(layoutHintQuery('/dashboard')),
      api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null })),
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
    // Ueberholt oder verlassen, waehrend die Antworten unterwegs waren (#977):
    // dieser Aufbau gehoert niemandem mehr und faesst die Flaeche nicht an.
    if (signal.aborted) return;
    primeMealTypeNames(prefsRes?.data);
    data         = dashRes;
    /* Die Zahlen an den Nav-Zielen und Modulkacheln kommen aus derselben
     * Antwort (#868). Sie hier hereinzureichen spart die zweite Aggregation,
     * die der Shell-Aufbau sonst beim Anmelden anstiess - `layoutHintQuery`
     * schraenkt sie allerdings ein, und eine eingeschraenkte Zahl ist eine
     * andere Zahl, also nimmt der Speicher sie nur ungefiltert an. */
    window.yuvomi?.primeModuleCountsFrom?.(dashRes, {
      filtered: layoutHintQuery('/dashboard') !== '/dashboard',
    });
    // Geburtstags-Termine tragen serverseitig einen sprachneutralen Titel
    // („Birthday: <Name>"); anhand von birthday_name in die aktive Sprache
    // übersetzen (Issue #524).
    if (Array.isArray(data?.upcomingEvents)) {
      data.upcomingEvents = data.upcomingEvents.map(localizeBirthdayEvent);
    }
    setCountdownAvailability(data?.countdowns);
    weather      = weatherRes.data ?? null;
    weatherAutoLocate = Boolean(prefsRes.data?.weather_user?.auto_locate ?? prefsRes.data?.weather_auto_locate);
    widgetConfig = normalizeDashboardConfigWithExtensions(prefsRes.data?.dashboard_widgets ?? buildDefaultWidgetConfig());
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
    if (dashboardQuery(widgetConfig) !== layoutHintQuery('/dashboard')) {
      try {
        const filtered = await api.get(dashboardQuery(widgetConfig));
        if (signal.aborted) return;
        if (Array.isArray(filtered?.upcomingEvents)) {
          filtered.upcomingEvents = filtered.upcomingEvents.map(localizeBirthdayEvent);
        }
        data = filtered;
        setCountdownAvailability(data?.countdowns);
      } catch { /* die ungefilterte Antwort steht bereits - lieber mehr als nichts */ }
    }
    glanceVisible = prefsRes.data?.dashboard_today_glance !== false;
    savedGlanceVisible = glanceVisible;
    followsDefault = prefsRes.data?.dashboard_follows_default !== false;
    // Das Skelett des NAECHSTEN Aufrufs lernt hier seine Kachelform.
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
    currency     = prefsRes.data?.currency ?? 'EUR';
    visibleMealTypes = normalizeVisibleMealTypes(prefsRes.data?.visible_meal_types);
    lastLoadedAt = new Date();
  } catch (err) {
    console.error('[Dashboard] Ladefehler:', err.message, 'Status:', err.status ?? 'network');
    loadFailed = true;
    loadErrorStatus = Number.isFinite(err?.status) ? err.status : null;
  }

  // Zyklus-Slice strikt owner-only nachladen: Zyklusdaten sind privat und dürfen
  // nicht in den familienweiten /dashboard-Payload. Genau einmal (data.cycle bleibt
  // sonst undefined = „noch nie geladen"). Ein Fehler lässt die Kachel auf ihren
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
      console.error('[Dashboard] Zyklus-Slice Ladefehler:', err?.message);
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
      const day = householdToday();
      const [entriesRes, typesRes] = await Promise.all([
        api.get(`/schedule/entries?from=${day}&to=${day}`),
        api.get('/schedule/shift-types'),
      ]);
      data.schedule = { entries: entriesRes.data?.entries ?? [], hasTypes: (typesRes.data ?? []).length > 0 };
    } catch (err) {
      console.error('[Dashboard] Schedule-Slice Ladefehler:', err?.message);
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
      console.error('[Dashboard] Waste-Slice Ladefehler:', err?.message);
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


  // Einziger Persist-Pfad für Inline- UND Modal-Speichern. Legt vor dem Schreiben
  // einen Schnappschuss an und bietet — wenn sich etwas geändert hat — im Toast ein
  // „Rückgängig" an, das den vorherigen Stand wiederherstellt (inkl. Server).
  /** Die Uebersicht neu holen, wenn sich die Filter geaendert haben (#814). */
  async function reloadIfQueryChanged(previousQuery) {
    if (dashboardQuery(widgetConfig) === previousQuery) return;
    try {
      const fresh = await api.get(dashboardQuery(widgetConfig));
      if (Array.isArray(fresh?.upcomingEvents)) {
        fresh.upcomingEvents = fresh.upcomingEvents.map(localizeBirthdayEvent);
      }
      fresh.cycle = data.cycle;
      fresh.schedule = data.schedule;
      fresh.waste = data.waste;
      data = fresh;
      setCountdownAvailability(data?.countdowns);
      lastLoadedAt = new Date();
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
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
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
            rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
            if (wasteOptionsBeforeUndo !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null)) data.waste = undefined;
            if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
            await reloadIfQueryChanged(queryBeforeUndo);
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
      widgetConfig = normalizeDashboardConfigWithExtensions(res.data?.dashboard_widgets ?? buildDefaultWidgetConfig());
      glanceVisible = res.data?.dashboard_today_glance !== false;
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      return;
    }
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    followsDefault = true;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
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
        rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
        if (wasteOptionsBeforeUndo !== JSON.stringify(widgetConfig.find((w) => w.id === 'waste')?.options ?? null)) data.waste = undefined;
        if (widgetConfig.some((w) => w.id === 'waste' && w.visible)) await ensureWasteSlice();
        await reloadIfQueryChanged(queryBeforeUndo);
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
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
    isCustomizing = false;
    rebuildDashboard(widgetConfig);
    window.yuvomi?.showToast(t('dashboard.customizeSetDefaultDone'), 'success');
  }

  function wireDashboardEditMode() {
    if (!isCustomizing) return;
    const grid = container.querySelector('#dashboard-widget-grid');
    if (!grid) return;
    let draggedId = '';
    let currentDrop = null;

    const clearDropHint = () => {
      grid.querySelectorAll('.widget-wrapper--drop-before, .widget-wrapper--drop-after').forEach((el) => {
        el.classList.remove('widget-wrapper--drop-before', 'widget-wrapper--drop-after');
      });
    };

    const updateDropHint = (event) => {
      if (!draggedId) return null;
      clearDropHint();
      currentDrop = closestWidgetDrop(grid, event, draggedId);
      if (currentDrop) {
        currentDrop.item.classList.add(currentDrop.placement === 'after' ? 'widget-wrapper--drop-after' : 'widget-wrapper--drop-before');
      }
      return currentDrop;
    };

    grid.querySelectorAll('.widget-wrapper[data-widget-id]').forEach((wrapper) => {
      wrapper.addEventListener('dragstart', (event) => {
        draggedId = wrapper.dataset.widgetId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedId);
        wrapper.classList.add('widget-wrapper--dragging');
      });
      wrapper.addEventListener('dragend', () => {
        draggedId = '';
        wrapper.classList.remove('widget-wrapper--dragging');
        currentDrop = null;
        clearDropHint();
      });
    });

    grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      updateDropHint(event);
    });

    grid.addEventListener('dragleave', (event) => {
      if (!grid.contains(event.relatedTarget)) {
        currentDrop = null;
        clearDropHint();
      }
    });

    grid.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData('text/plain') || draggedId;
      const drop = currentDrop || updateDropHint(event);
      if (fromId && drop) {
        widgetConfig = reorderWidgetConfig(widgetConfig, fromId, drop.id, drop.placement);
        rebuildDashboard(widgetConfig);
      }
    });

    grid.querySelectorAll('[data-widget-size-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.widgetSizePreset;
        if (!WIDGET_SIZE_OPTIONS.includes(size)) return;
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetId, { size });
        rebuildDashboard(widgetConfig);
      });
    });

    container.querySelectorAll('[data-widget-options]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.widgetOptions;
        const current = widgetConfig.find((w) => w.id === id)?.options ?? {};
        const next = await openWidgetOptions(id, current);
        if (next === null) return;
        // Ein leeres Optionsobjekt wird zu „keine Optionen": so bleibt der
        // gespeicherte Stand identisch mit dem eines Layouts, das den Dialog
        // nie gesehen hat.
        widgetConfig = updateWidgetConfig(widgetConfig, id,
          Object.keys(next).length ? { options: next } : { options: undefined });
        rebuildDashboard(widgetConfig);
      });
    });

    grid.querySelectorAll('[data-widget-hide]').forEach((btn) => {
      btn.addEventListener('click', () => {
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetHide, { visible: false });
        rebuildDashboard(widgetConfig);
      });
    });

    // Wieder-Einblenden aus der Tray-Leiste (außerhalb des Grids, daher container-
    // weit gesucht): der Gegenpart zum Ausblenden, macht den Inline-Editor komplett.
    container.querySelectorAll('[data-widget-show]').forEach((btn) => {
      btn.addEventListener('click', () => {
        widgetConfig = updateWidgetConfig(widgetConfig, btn.dataset.widgetShow, { visible: true });
        rebuildDashboard(widgetConfig);
      });
    });

    // Kopfband: beide Knoepfe sitzen ausserhalb des Grids (der eine im Masthead,
    // der andere in der Tray-Leiste), deshalb container-weit gesucht.
    container.querySelector('[data-glance-hide]')?.addEventListener('click', () => {
      glanceVisible = false;
      rebuildDashboard(widgetConfig);
    });
    container.querySelector('[data-glance-show]')?.addEventListener('click', () => {
      glanceVisible = true;
      rebuildDashboard(widgetConfig);
    });

    // Reorder ohne HTML5-DnD (das feuert nicht per Finger und ist nicht per
    // Tastatur bedienbar). Ein Pfad für drei Auslöser: Touch-Up/Down-Buttons,
    // Desktop-Grip-Pfeiltasten und (indirekt) das Modal — alle über den Nachbarn
    // aus der gerenderten Grid-Reihenfolge und dasselbe reorderWidgetConfig.
    const moveWidget = (id, dir) => {
      const wrapper = grid.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
      const sibling = dir === 'up' ? wrapper?.previousElementSibling : wrapper?.nextElementSibling;
      const siblingId = sibling?.dataset?.widgetId;
      if (!id || !siblingId) return false;
      widgetConfig = reorderWidgetConfig(widgetConfig, id, siblingId, dir === 'up' ? 'before' : 'after');
      rebuildDashboard(widgetConfig);
      return true;
    };

    grid.querySelectorAll('[data-widget-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.widgetId;
        const dir = btn.dataset.widgetMove;
        if (!moveWidget(id, dir)) return;
        // Fokus dem bewegten Widget nachführen (Tastatur-Kontinuität): gleiche
        // Richtung, sonst die noch aktive Gegenrichtung.
        const movedWrapper = container.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"]`);
        const sameDir = movedWrapper?.querySelector(`[data-widget-move="${dir}"]:not([disabled])`);
        const anyMove = movedWrapper?.querySelector('[data-widget-move]:not([disabled])');
        (sameDir ?? anyMove)?.focus();
      });
    });

    // Desktop-Tastatur: der Grip ist ein fokussierbarer Button — Pfeil hoch/runter
    // ordnet um. Schließt die Inline-Reorder-Lücke für Tastatur-Nutzer, ohne die
    // schmale Edit-Leiste mit zusätzlichen Buttons zu überladen (Drag bleibt Maus).
    grid.querySelectorAll('[data-widget-drag-handle]').forEach((handle) => {
      handle.addEventListener('keydown', (event) => {
        const dir = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
        if (!dir) return;
        event.preventDefault();
        const id = handle.closest('.widget-wrapper[data-widget-id]')?.dataset.widgetId;
        if (moveWidget(id, dir)) {
          container.querySelector(`.widget-wrapper[data-widget-id="${CSS.escape(id)}"] [data-widget-drag-handle]`)?.focus();
        }
      });
    });
  }

  function rebuildDashboard(cfg) {
    // Der eine Engpass fuer jeden verspaeteten Neuaufbau (#977): eine Antwort,
    // die nach dem Verlassen der Seite oder nach dem naechsten render()
    // eintrifft, darf die Flaeche nicht mehr anfassen - sonst ueberschreibt der
    // aeltere Stand den neueren.
    if (signal.aborted) return;
    const shell = container.querySelector('#dashboard-shell');
    if (!shell) return;
    if (wallMode) {
      setHtml(shell, renderWallSurface(data, weather, { failed: loadFailed, updatedAt: lastLoadedAt }));
      if (window.lucide) window.lucide.createIcons({ el: shell });
      wireWallSurface(container, rerender, signal);
      return;
    }
    if (loadFailed) {
      setHtml(shell, `
        ${renderDashboardOverview(user, false)}
        ${renderDashboardError(loadErrorStatus)}
      `);
      if (window.lucide) window.lucide.createIcons({ el: shell });
      container.querySelector('#dashboard-retry')?.addEventListener('click', rerender, { signal: signal });
      return;
    }
    // Signature-„Heute"-Masthead: Begrüßung und Glance-Cockpit teilen sich EIN
    // erhöhtes Material-Band (statt zweier gestapelter gerahmter Kästen). Die
    // inneren Sections sind entrahmt; das Band trägt Rahmen/Schatten/Tönung.
    // Fehlt das Cockpit (alle Domänen als Widgets sichtbar → kein Glance-Inhalt),
    // kollabiert das Band per --slim auf eine schlanke Gruß-Leiste statt ein
    // großes leeres Rechteck zu zeigen (Critique R3 P1).
    const cockpitHtml = (glanceVisible || isCustomizing) ? renderTodayCockpit(data, cfg, isCustomizing) : '';
    const mastheadSlim = cockpitHtml ? '' : ' dashboard-masthead--slim';
    // Kein Wetter-Echo: die Masthead-Zeile spricht nur, wenn die Wetter-Karte
    // nicht ohnehin im Raster sichtbar ist (Opt-in fürs Wandtablet).
    const weatherCardShown = cfg.some((w) => w.id === 'weather' && w.visible);
    setHtml(shell, `
      <section class="dashboard-masthead dashboard-masthead--${greetingPeriod()}${mastheadSlim}">
        ${renderDashboardOverview(user, isCustomizing, weatherCardShown ? null : weather, lastLoadedAt, { followsDefault, canPublish })}
        ${cockpitHtml}
      </section>
      ${renderDashboardLayout(cfg, data, weather, currency, { editing: isCustomizing, visibleMealTypes, glanceHidden: !glanceVisible })}
    `);
    wireLinks(container, rerender, { editing: isCustomizing, user });
    // Retry einer isolierten Widget-Fehlerkachel: da /dashboard aggregiert lädt,
    // ist „erneut versuchen" ein voller Neuaufbau (wie der Page-Level-Retry).
    container.querySelectorAll('[data-widget-retry]').forEach((btn) =>
      btn.addEventListener('click', rerender, { signal: signal }));
    if (window.lucide) window.lucide.createIcons({ el: shell });
    // Vorschaubilder der Mahlzeitenkachel: Ruecksturz auf den Platzhalter per
    // Listener, weil ein `onerror` im Markup gegen die CSP liefe (#1059).
    wireRecipeThumbs(shell);
    wireWeatherRefresh(container, (updatedWeather) => {
      weather = updatedWeather;
      rebuildDashboard(cfg);
    }, signal);
    container.querySelector('#dashboard-wall-enter')?.addEventListener('click', () => {
      enterWallMode();
      rerender();
    }, { signal: signal });
    container.querySelector('#dashboard-customize-btn')?.addEventListener('click', () => {
      isCustomizing = !isCustomizing;
      if (!isCustomizing) {
        cancelDashboardConfig();
        return;
      }
      rebuildDashboard(widgetConfig);
    }, { signal: signal });
    container.querySelector('#dashboard-customize-save')?.addEventListener('click', saveDashboardConfig, { signal: signal });
    container.querySelector('#dashboard-customize-cancel')?.addEventListener('click', cancelDashboardConfig, { signal: signal });
    container.querySelector('#dashboard-customize-reset')?.addEventListener('click', resetDashboardConfig, { signal: signal });
    container.querySelector('#dashboard-customize-publish')?.addEventListener('click', publishHouseholdDefault, { signal: signal });
    wireDashboardEditMode();
    void mountExtensionWidgets(shell, cfg, user);
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
    initFab(signal);
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
  let refreshInFlight = false;
  async function refreshDashboardData() {
    if (isCustomizing || loadFailed || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const fresh = await api.get(dashboardQuery(widgetConfig));
      if (signal.aborted) return;
      if (Array.isArray(fresh?.upcomingEvents)) {
        fresh.upcomingEvents = fresh.upcomingEvents.map(localizeBirthdayEvent);
      }
      // Der owner-only Zyklus-Slice reist unveraendert mit: /dashboard
      // liefert ihn nie, ein Refresh darf ihn nicht auf „nie geladen"
      // zurückwerfen.
      fresh.cycle = data.cycle;
      // Schedule hat anders als Cycle keinen Privatsphaere-Grund, den alten
      // Stand einfach mitzuschleppen (M-6a): "wer heute Dienst hat" blieb
      // sonst bis zu 15 Minuten stehen und ueberlebte sogar einen
      // Mitternachts-Wechsel auf dem Wandtablet. Vor der Uebernahme
      // zuruecksetzen und mit frisch berechnetem Tag neu laden - derselbe
      // Weg, den ein frisch eingeblendetes Widget in persistWidgetConfig()
      // schon nimmt. Das heilt nebenbei auch einen zuvor gescheiterten Slice
      // (M-6b) beim naechsten stillen Takt, statt auf den Retry-Knopf zu warten.
      if (widgetConfig.some((w) => w.id === 'schedule' && w.visible)) {
        data.schedule = undefined;
        await ensureScheduleSlice();
        if (signal.aborted) return;
      }
      fresh.schedule = data.schedule;
      fresh.waste = data.waste;
      data = fresh;
      lastLoadedAt = new Date();
      rebuildDashboard(widgetConfig);
    } catch { /* Hintergrund-Refresh: bewusst still */ }
    finally { refreshInFlight = false; }
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
    // Inhalte ziehen nach, nicht nur Gruß/Datum/Uhr (Paket 2).
    refreshDashboardData();
  }, { signal: signal });

  // Der Minutentakt der Uhr traegt die Nachtabsenkung mit: um 22:00 und um
  // 06:00 muss die Flaeche umschalten, wenn es so weit ist - nicht erst beim
  // naechsten Laden. Ein zweiter Timer nur dafuer waere ein zweiter Takt fuer
  // dieselbe Minute.
  startClockTicker(container, signal, wallMode ? () => syncWallMode(location.pathname) : null);

  // 30-Minuten Auto-Refresh für Wetter (inkl. optionaler Standort-Aktualisierung).
  // Anker ist der Datensatz, nicht der Karten-Button: seit dem Masthead-Umzug
  // kann Wetter sichtbar sein (Zeile), ohne dass die Karte samt Refresh-Button
  // im Raster steht - auch die Zeile darf nicht den ganzen Tag alt werden.
  if (weather) {
    const doAutoRefresh = async () => {
      try {
        await maybeUpdateAutoLocation({
          autoLocateEnabled: weatherAutoLocate,
          geolocation: navigator.geolocation,
          putPreferences: (body) => api.put('/preferences', body),
        });
        const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
        if (signal.aborted) return;
        weather = res.data ?? null;
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
  if (user?.onboarding_pending && !localStorage.getItem(ONBOARDING_KEY)) {
    setTimeout(() => showOnboarding(container, () => maybeHintCustomize(container)), 400);
  } else {
    maybeHintCustomize(container);
  }
}

export const __test = { buildTodayHighlights, buildTodayProgram, buildTodayCockpitModel, renderTodayCockpit, renderPinnedNotes, renderScheduleWidget, renderWasteWidget, renderFamilyWidget, formatDueDate, normalizeVisibleMealTypes, renderTodayMeals, calendarEventRoute, eventOccurrenceDateKey, eventStartDate, renderWallSurface, renderWallWho, renderDashboardOverview, selectMetricTiles, METRIC_TILE_ORDER, PROGRAM_ROW_CAP, WALL_ROW_CAP, weatherToneKey, weatherMotionAttr, weatherTempBand, weatherSpanModel, weatherDayLabel, weatherTodayRange, renderWeatherWidget, renderWallWeather, relativeDateLabel, listRowCap };

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
    refreshBtn.classList.add('weather-widget__refresh--spinning');
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
      refreshBtn.classList.remove('weather-widget__refresh--spinning');
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
