/**
 * Modul: Service Worker
 * Zweck: Offline-Fähigkeit, differenzierte Caching-Strategien, Update-Notification
 * Abhängigkeiten: keine
 *
 * Caching-Strategien (der Dispatcher unten ist die Wahrheit; dieser Kopf
 * behauptete bis 2026-08-31 "Cache-First" für Shell und Seitenmodule):
 *   Navigation + APP_SHELL + PAGE_MODULES + Locales: Network-First mit dem
 *        Precache (install) als Offline-Fallback - frisch, solange Netz da ist.
 *        Antwortet das Netz nicht binnen NETWORK_FIRST_DEADLINE_MS, kommt der
 *        Cache-Treffer; die Netzantwort fuellt den Cache trotzdem nach.
 *   ASSETS (Bilder, Icons) und der Rest-Fallback: Cache-First, lazily gecacht,
 *        bei SW-Update geleert
 *   API: Network-First für eine Read-only-GET-Whitelist (Kalender, Tasks, …)
 *        → offline letzter Stand sichtbar; Mutationen/Auth immer direkt ans Netz.
 *        Ausnahme: reduzierte Abzuege von /auth/me und /preferences fuer den
 *        Kaltstart ohne Verbindung (API_SNAPSHOTS, #2293).
 *        Cache wird bei Logout/Session-Ende geleert (CLEAR_API_CACHE-Message).
 *
 * Nach SW-Update: alle Requests gehen einmalig cache-bypassed ans Netz
 *   → bypassCacheUntil (in-memory + Cache API für SW-Restart-Robustheit)
 */

const APP_RELEASE        = '2.82.0';
const APP_BUILD_REVISION = '__YUVOMI_BUILD_REVISION__';
const CACHE_RELEASE      = `${APP_RELEASE}-${APP_BUILD_REVISION}`;
const SHELL_CACHE        = `yuvomi-shell-${CACHE_RELEASE}`;
const PAGES_CACHE        = `yuvomi-pages-${CACHE_RELEASE}`;
const LOCALES_CACHE      = `yuvomi-locales-${CACHE_RELEASE}`;
const ASSETS_CACHE       = `yuvomi-assets-${CACHE_RELEASE}`;
// API-Cache bewusst NICHT in ALL_CACHES: er wird bei jedem SW-Update neu benannt
// (Version im Namen) und bei Logout/Session-Ende gezielt geleert.
const API_CACHE     = `yuvomi-api-${CACHE_RELEASE}`;
const BYPASS_CACHE  = 'yuvomi-bypass-flag';
const ALL_CACHES    = [SHELL_CACHE, PAGES_CACHE, LOCALES_CACHE, ASSETS_CACHE];

// GET-API-Pfade (nach /api/v1), die für Read-only-Offline gecacht werden dürfen.
// NUR Lese-Endpunkte — niemals /auth/* oder Mutationen. Prefix-Match.
// `/people` sind die Profilbilder (server/routes/people.js): Aufgaben, Termine
// und Uebersicht tragen ihre Adresse statt der Data-URL, offline braucht die
// Zeile ihr Bild aus demselben Cache.
const API_CACHE_WHITELIST = ['/calendar', '/tasks', '/shopping', '/contacts', '/dashboard', '/people'];
// Pfade UNTER einem Whitelist-Prefix, die trotzdem nie gecacht werden.
const API_CACHE_EXCLUDE = ['/shopping/versions'];

// KALTSTART OHNE VERBINDUNG (#2293). Ohne Sitzung zeigt der Router keine
// Seite, und `/auth/me` stand nie im Cache: eine geschlossene App, offline
// geoeffnet, landete deshalb beim "Server nicht erreichbar" statt auf den
// gespeicherten Listen. Zwei Antworten liegen deshalb als ABZUG im API-Cache,
// genau gleich lang wie die Listen (ein Loeschpfad: Abmelden, Sitzungsende,
// Update) und nur mit dem, was die Shell zum Zeichnen braucht:
//   /auth/me      Konto ohne Kontaktdaten, Rechte, Haushalt - NIE das
//                 CSRF-Token und keine Kopfzeile der Antwort (kein Set-Cookie).
//                 Fuer normale Sitzungen; ein Wanddisplay bekommt einen
//                 eigenen, noch engeren Abzug (DISPLAY_SNAPSHOT_*), ein
//                 Split-Gast keinen, ein vorhandener wird geloescht.
//   /preferences  Modulreihenfolge, abgeschaltete Module, Zone, Formate und
//                 die Anordnung der Uebersicht.
// Der Abzug traegt `offlineSnapshot: true`. Er wird nur bei einem Netzfehler
// ausgeliefert (Network-First), und der Router liest daran, dass die Sitzung
// NICHT geprueft ist. Eine 401 loescht ihn.
//
// DER ABZUG ENDET MIT DER SITZUNG. `/auth/me` nennt `sessionExpiresAt`, den
// Ablauf des Session-Cookies (server/auth.js); der Worker legt ihn neben die
// Antworten (SESSION_EXPIRY_KEY). Ist er vorbei, liefert ein Netzfehler weder
// den Abzug noch die Listen, und der API-Cache wird geloescht - ein Geraet mit
// abgelaufener oder widerrufener Sitzung zeigt den Haushalt nicht beliebig
// lange. Ohne Ablauf vom Server gibt es keinen Abzug.
const SESSION_SNAPSHOT_SCOPES = ['family', 'display'];
const SESSION_SNAPSHOT_USER_FIELDS = [
  'id', 'username', 'display_name', 'avatar_color', 'avatar_data', 'role', 'family_role',
  'access_scope', 'onboarding_version', 'changelog_seen_version', 'changelog_seen_latest',
  'sort_order', 'is_household_member',
];
const SESSION_SNAPSHOT_FIELDS = ['permissions', 'householdSize', 'initialsRoster', 'othersCanRead'];
const PREFERENCES_SNAPSHOT_FIELDS = [
  'disabled_modules', 'hidden_modules', 'module_order', 'mobile_nav_order',
  'timezone', 'date_format', 'time_format', 'region', 'currency', 'app_name',
  // Die Uebersicht baut aus ihnen ihre Abfrage; ohne sie fragte sie offline
  // die Standardansicht an, die nie im Cache lag.
  'dashboard_widgets', 'dashboard_widgets_default', 'dashboard_follows_default',
  'dashboard_today_glance', 'dashboard_today_glance_default',
];

function pickFields(source, fields) {
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

function sessionExpiryOf(body) {
  const value = body && body.sessionExpiresAt;
  return Number.isFinite(value) ? value : null;
}

// WANDDISPLAY: EIN EIGENER ABZUG FUER DEN KALTSTART (Folge von #2342). Ohne ihn
// startete ein Tablett, das ohne Netz neu hochfaehrt, bei "Server nicht
// erreichbar", obwohl seine Listen im Cache lagen. Die Allowlist ist am Code
// gemessen, nicht geraten: die Shell liest Name, Farbe und Bild fuer die
// Kontozeile (router.js `syncSidebarAccount`), der Router `id`, `role` und
// `access_scope`, `permissions` steuern Leiste und Kacheln, `householdSize`
// die Avatar-Marken. Das Bild bleibt weg (die Kontozeile faellt auf die
// Initialen zurueck), ebenso der Anmeldename, `initialsRoster` (die Namen des
// Haushalts) und `othersCanRead` (nur fuer Formulare, ein Display hat keine).
// Zone, Formate und App-Name kommen aus dem `/preferences`-Abzug. Die Frist ist
// dieselbe gleitende wie fuer die Listen (72 h, server/services/display-accounts.js).
const DISPLAY_SNAPSHOT_USER_FIELDS = ['id', 'display_name', 'avatar_color', 'role', 'access_scope'];
const DISPLAY_SNAPSHOT_FIELDS = ['permissions', 'householdSize'];

const SNAPSHOT_ALLOWLISTS = {
  family: [SESSION_SNAPSHOT_USER_FIELDS, SESSION_SNAPSHOT_FIELDS],
  display: [DISPLAY_SNAPSHOT_USER_FIELDS, DISPLAY_SNAPSHOT_FIELDS],
};

function reduceSessionSnapshot(body) {
  const user = body && typeof body.user === 'object' ? body.user : null;
  if (!user || !SESSION_SNAPSHOT_SCOPES.includes(user.access_scope)) return null;
  const expiresAt = sessionExpiryOf(body);
  if (expiresAt === null || expiresAt <= Date.now()) return null;
  const [userFields, fields] = SNAPSHOT_ALLOWLISTS[user.access_scope];
  return {
    user: pickFields(user, userFields),
    ...pickFields(body, fields),
    expiresAt,
    offlineSnapshot: true,
  };
}

function reducePreferencesSnapshot(body) {
  const data = body && typeof body.data === 'object' && body.data ? body.data : null;
  if (!data) return null;
  return { data: pickFields(data, PREFERENCES_SNAPSHOT_FIELDS), offlineSnapshot: true };
}

const API_SNAPSHOTS = {
  '/auth/me': reduceSessionSnapshot,
  '/preferences': reducePreferencesSnapshot,
};

// Ablauf der Sitzung, deren Antworten im API-Cache liegen. Eigener Eintrag,
// weil er fuer jede Sitzung gilt, auch die ohne Abzug (Display, Split-Gast).
const SESSION_EXPIRY_KEY = `${self.location.origin}/api/v1/__offline/session-expires-at`;

// WANDDISPLAY: DIE FRIST GLEITET (Folge von #2293). Ein Display hat keine
// Anmeldesitzung; der Server nennt ihm jetzt + 72 Stunden - in `/auth/me` als
// `sessionExpiresAt` und an JEDER Antwort in dieser Kopfzeile
// (server/services/display-accounts.js, DISPLAY_OFFLINE_GRACE_MS). Eine Liste,
// die mit ihr ankommt, rueckt den Marker vor, sonst liefe die Frist ab dem
// letzten `/auth/me` statt ab dem letzten Kontakt. Familiensitzungen bekommen
// die Kopfzeile nie; fuer sie bleibt es beim Ablauf aus `/auth/me`.
const OFFLINE_EXPIRES_HEADER = 'x-offline-expires-at';

// GENERATION DES API-CACHES (#2293, Sicherheitsbefund). Jedes Loeschen zaehlt
// hoch. Ein Schreibpfad merkt sich die Generation VOR seinem fetch() und
// schreibt nur, wenn sie unmittelbar vor `cache.put` noch dieselbe ist: eine
// Antwort, die noch unter Person A unterwegs war, als abgemeldet wurde, landet
// sonst im frischen Cache von Person B - mit Bs gueltigem Sitzungsablauf daneben.
let _cacheGeneration = 0;

function deleteApiCache() {
  _cacheGeneration += 1;
  return caches.delete(API_CACHE);
}

async function rememberSessionExpiry(cache, body, generation) {
  if (generation !== _cacheGeneration) return false;
  const expiresAt = sessionExpiryOf(body);
  // Kein Ablauf vom Server: keine Grenze, also kein gespeicherter Stand -
  // der ganze API-Cache geht, nicht nur der Marker (fail-closed).
  if (expiresAt === null || expiresAt <= Date.now()) {
    await deleteApiCache();
    return false;
  }
  if (generation !== _cacheGeneration) return false;
  await cache.put(SESSION_EXPIRY_KEY, new Response(JSON.stringify({ expiresAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));
  return true;
}

/**
 * Rueckt den Marker auf die Frist aus der Kopfzeile einer Netzantwort vor.
 * Nur neben einem schon gueltigen Marker (der Aufrufer hat
 * `ensureSessionExpiry` bestanden) und nur mit einer Zahl in der Zukunft:
 * fehlt die Kopfzeile oder taugt sie nicht, bleibt der Marker, wie er ist.
 */
async function extendSessionExpiry(response, generation) {
  const raw = response.headers.get(OFFLINE_EXPIRES_HEADER);
  if (raw === null || !/^\d+$/.test(raw)) return;
  const expiresAt = Number(raw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  if (generation !== _cacheGeneration) return;
  await rememberSessionExpiry(await caches.open(API_CACHE), { sessionExpiresAt: expiresAt }, generation);
}

/** Steht im API-Cache ein lesbarer, noch nicht abgelaufener Sitzungsablauf? */
async function hasValidSessionExpiry() {
  try {
    if (!(await caches.has(API_CACHE))) return false;
    const marker = await (await caches.open(API_CACHE)).match(SESSION_EXPIRY_KEY);
    if (!marker) return false;
    const { expiresAt } = await marker.json();
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  } catch {
    return false;
  }
}

/**
 * FAIL-CLOSED: der API-Cache wird nur ausgeliefert, solange ein lesbarer
 * Sitzungsablauf in ihm steht und noch nicht erreicht ist. Fehlt der Marker
 * (Listen von vor diesem Update), ist er unlesbar, ungueltig oder vorbei, ist
 * der Cache jetzt geloescht, und der Aufrufer liefert nichts aus ihm. Folge
 * fuer Bestandsgeraete: einmal kein Offline-Stand bis zum naechsten Abruf mit
 * Verbindung.
 */
async function dropApiCacheIfSessionExpired() {
  if (await hasValidSessionExpiry()) return false;
  await deleteApiCache().catch(() => false);
  return true;
}

/** Der gespeicherte Stand zu einem Abruf - ohne den Cache dafuer neu anzulegen. */
async function cachedApiResponse(request) {
  try {
    if (!(await caches.has(API_CACHE))) return null;
    return (await (await caches.open(API_CACHE)).match(request)) || null;
  } catch {
    return null;
  }
}

function offlineResponse() {
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Der Abzug-Reduzierer zu einem API-Pfad (exakter Pfad, keine Unterpfade), sonst null. */
function apiSnapshotReducer(pathname) {
  if (!pathname.startsWith('/api/v1/')) return null;
  const rest = pathname.slice('/api/v1'.length);
  return Object.prototype.hasOwnProperty.call(API_SNAPSHOTS, rest) ? API_SNAPSHOTS[rest] : null;
}

// App-Shell: sofort benötigt für ersten Render
const APP_SHELL = [
  '/',
  '/index.html',
  '/api.js',
  '/lang-init.js',
  '/boot-fetch.js',
  '/router.js',
  '/i18n.js',
  '/rrule-ui.js',
  '/reminders.js',
  '/push.js',
  '/sw-register.js',
  '/lucide.min.js',
  '/lucide-scope.js',
  // Alles, was `index.html` als `<link rel="stylesheet">` eager lädt, gehört
  // hierher - sonst rendert der allererste Offline-Start ungestylt. Die Regel
  // hält `test:sw-precache`; sie ist keine Liste, die man von Hand nachträgt.
  '/styles/tokens.css',
  '/styles/reset.css',
  '/styles/pwa.css',
  '/styles/layout.css',
  '/styles/glass.css',
  '/styles/typography.css',
  '/styles/filter-chip.css',
  '/styles/sub-tabs.css',
  '/styles/page-search.css',
  '/styles/kitchen-tabs.css',
  '/styles/list-row.css',
  '/styles/panel.css',
  '/styles/user-multi-select.css',
  '/styles/datepicker.css',
  '/styles/category-manager.css',
  '/styles/icon-picker.css',
  '/styles/document-attach.css',
  '/styles/auth.css',
  '/styles/reminders.css',
  '/styles/dashboard.css',
  '/styles/tasks.css',
  '/styles/shopping.css',
  '/styles/meals.css',
  '/styles/calendar.css',
  '/styles/schedule.css',
  '/styles/time-grid.css',
  '/styles/markdown-toolbar.css',
  '/styles/notes.css',
  '/styles/contacts.css',
  '/styles/birthdays.css',
  '/styles/budget.css',
  '/styles/documents.css',
  '/styles/settings.css',
  '/styles/recipes.css',
  '/styles/pantry.css',
  '/styles/inventory.css',
  '/styles/detail-view.css',
  '/styles/screensaver.css',
  '/components/yuvomi-install-prompt.js',
  // Geteilte Module. Sie werden von Shell UND Seitenmodulen importiert und
  // müssen deshalb zusammen mit der Shell erneuert werden: der Browser bindet
  // ein einmal geladenes Modul für die Lebensdauer des Dokuments, ein neues
  // Seitenmodul träfe sonst auf die alte Fassung (#616). Sortierung wie im
  // Dateisystem; Fetch-Routing für diese Pfade → SHELL_CACHE (isMutableAppResource).
  '/nav-icons.js',
  '/utils/app-update.js',
  '/permissions.js',
  // Der Router laedt ihn als Seiteneffekt (`import '/components/datepicker.js'`),
  // also gehoert er in die Shell, nicht zu den Seitenmodulen. Der
  // Precache-Guard sah diese Import-Form bis #944 nicht.
  '/components/budget-recurrence-fields.js',
  '/components/datepicker.js',
  '/components/detail-view.js',
  '/components/document-attach.js',
  '/components/health-fasting-insights.js',
  '/components/modal.js',
  '/components/photo-screensaver.js',
  '/components/quick-links-manager.js',
  '/components/task-detail.js',
  '/components/user-multi-select.js',
  '/components/wall-timer.js',
  '/utils/birth-date.js',
  '/utils/birthday-event.js',
  '/utils/budget-chart-category.js',
  '/utils/budget-recurrence.js',
  '/utils/budget-category-colors.js',
  '/utils/bulk-pill.js',
  '/utils/category-labels.js',
  '/utils/chart.js',
  '/utils/color.js',
  '/utils/contact-limits.js',
  '/utils/contact-name.js',
  '/utils/contrast.js',
  '/utils/countdown.js',
  '/utils/dashboard-event-limit.js',
  '/utils/dashboard-layout-hint.js',
  '/utils/dashboard-widgets.js',
  '/utils/date-status.js',
  '/utils/date.js',
  '/utils/digits.js',
  '/utils/day-label.js',
  '/utils/date-format.js',
  '/utils/interval-date.js',
  '/utils/currency-codes.js',
  '/utils/calendar-delete.js',
  '/utils/document-expiry.js',
  '/utils/document-facets.js',
  '/utils/document-thumbs.js',
  '/utils/document-folder-delete.js',
  '/utils/document-preview.js',
  '/utils/event-color.js',
  '/utils/event-icon.js',
  '/utils/empty-state.js',
  '/utils/extension-i18n.js',
  '/utils/extension-widgets.js',
  '/utils/fab.js',
  '/utils/flip.js',
  '/utils/list-motion.js',
  '/utils/component-style.js',
  '/utils/content-swap.js',
  '/utils/color-picker.js',
  '/utils/interval-sentence.js',
  '/utils/hint-fold.js',
  '/utils/media-picker.js',
  '/utils/filter-sheet.js',
  '/utils/folder-upload.js',
  '/utils/folder-tree.js',
  '/utils/form-row.js',
  '/utils/friendly-error.js',
  '/utils/health-activity.js',
  '/utils/health-cycle.js',
  '/utils/health-fasting.js',
  '/components/fasting-controls.js',
  '/components/fasting-dial.js',
  '/components/fasting-help.js',
  '/styles/fasting-controls.css',
  '/utils/health-hoist.js',
  '/utils/health-labs.js',
  '/utils/health-meds.js',
  '/utils/health-nutrition.js',
  '/utils/health-overview.js',
  '/utils/health-person-switcher.js',
  '/utils/health-person.js',
  '/utils/health-prevention.js',
  '/utils/health-tabs.js',
  '/utils/health-vitals.js',
  '/utils/help.js',
  '/utils/household-zone-hint.js',
  '/utils/first-steps.js',
  '/utils/household.js',
  '/utils/html-escape.js',
  '/utils/html.js',
  '/utils/ingredient-match-key.js',
  '/utils/ingredient-row.js',
  '/utils/initials.js',
  '/utils/inventory-warranty.js',
  '/utils/kitchen-tabs.js',
  '/utils/kitchen-transfer.js',
  '/utils/korean-particles.js',
  '/utils/leave-guard.js',
  '/utils/live-feed.js',
  '/utils/loan-order.js',
  '/utils/ledger-order.js',
  '/utils/markdown-checklist.js',
  '/utils/markdown-toolbar.js',
  '/utils/master-detail.js',
  '/utils/meal-types.js',
  '/utils/member-order.js',
  '/utils/mentions.js',
  '/utils/module-accent.js',
  '/utils/module-access.js',
  '/utils/metric-card.js',
  '/utils/metric-glance.js',
  '/utils/money.js',
  '/utils/amount-field.js',
  '/utils/nav-badges.js',
  '/utils/note-access.js',
  '/utils/note-category-filter.js',
  '/utils/note-category-name.js',
  '/utils/note-category-overflow.js',
  '/utils/note-category-picker.js',
  '/utils/offline-session.js',
  '/utils/overlay-history.js',
  '/utils/overlay-host.js',
  '/utils/dialog-surface.js',
  '/utils/page-layout.js',
  '/utils/page-lifecycle.js',
  '/utils/page-search.js',
  '/utils/search-sections.js',
  '/utils/palette-combobox.js',
  '/utils/period-stepper.js',
  '/utils/pantry-locations.js',
  '/utils/pantry-status.js',
  '/utils/pantry-units.js',
  '/utils/people-picker.js',
  '/utils/period-swipe.js',
  '/utils/permission-group.js',
  '/utils/phone.js',
  '/utils/popover-menu.js',
  '/utils/quick-link-url.js',
  '/utils/pwa-install.js',
  '/utils/recipe-meal-types.js',
  '/utils/read-row.js',
  '/utils/recipe-thumb.js',
  '/utils/recipe-to-meal.js',
  '/utils/recurrence-scope.js',
  '/utils/reminder-offset.js',
  '/utils/reward-goal.js',
  '/utils/router-navigate.js',
  '/utils/roving-toolbar.js',
  '/utils/row-action.js',
  '/utils/row-fill.js',
  '/utils/scale-quantity.js',
  '/utils/schedule-tabs.js',
  '/utils/schedule-reminder-offset.js',
  '/utils/servings-stepper.js',
  '/utils/screensaver-idle.js',
  '/utils/scroll-restore.js',
  '/utils/seal-pair.js',
  '/utils/session-unreachable.js',
  '/utils/segment-indicator.js',
  '/utils/sheet-drag.js',
  '/utils/shopping-categories.js',
  '/utils/skeleton.js',
  '/utils/start-handoff.js',
  '/utils/sub-tabs.js',
  '/utils/swipe-row.js',
  '/utils/sync-target.js',
  '/utils/tablist.js',
  '/utils/task-fields.js',
  '/utils/timezone.js',
  '/utils/toast-placement.js',
  '/utils/toast-show.js',
  '/utils/toast-surface.js',
  '/utils/reload-after-save.js',
  '/utils/background-inert.js',
  '/utils/today-sheet.js',
  '/utils/today-timeline.js',
  '/utils/shift-label.js',
  '/utils/time-grid.js',
  '/utils/unknown-route.js',
  '/utils/page-mount.js',
  '/utils/ux.js',
  '/utils/sidebar-glide.js',
  '/utils/vcard.js',
  '/utils/view-transition.js',
  '/utils/version.js',
  '/utils/upload-limit.js',
  '/utils/wall-mode.js',
  '/utils/night-hours.js',
  '/utils/web-share.js',
  '/utils/week-strip.js',
  '/utils/overlap-lanes.js',
  '/offline.html',
  // offline.html laedt theme-init.js, damit die Huelle dieselbe Farbwelt
  // trifft wie die App (gespeicherter Wunsch schlaegt Systemeinstellung).
  // Ohne Precache waere die Wahl genau dann wirkungslos, wenn die Seite
  // gebraucht wird - offline.
  '/theme-init.js',
  // theme-init.js fragt die Nachtstunden aus dieser Datei (#2234).
  '/night-hours.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

// Jede Sprache, die die App kennt. NICHT die Precache-Liste: vorab gecacht
// wird nur PRECACHED_LOCALES, der Rest kommt beim ersten Abruf in denselben
// Cache (LOCALES_CACHE). Die Liste hier ist die Zulassung dafuer - der Worker
// cacht auf Zuruf (CACHE_LOCALE) nur, was in ihr steht. Jede Datei unter
// public/locales/ gehoert hinein (`test:sw-precache`).
const APP_LOCALES = [
  '/locales/ar.json',
  '/locales/cs.json',
  '/locales/de.json',
  '/locales/el.json',
  '/locales/en.json',
  '/locales/es.json',
  '/locales/fa.json',
  '/locales/fil.json',
  '/locales/fr.json',
  '/locales/hi.json',
  '/locales/hu.json',
  '/locales/id.json',
  '/locales/it.json',
  '/locales/ja.json',
  '/locales/ko.json',
  '/locales/nb.json',
  '/locales/nl.json',
  '/locales/pl.json',
  '/locales/pt-BR.json',
  '/locales/pt.json',
  '/locales/ru.json',
  '/locales/sv.json',
  '/locales/tr.json',
  '/locales/uk.json',
  '/locales/vi.json',
  '/locales/zh.json',
  '/locales/zh-Hant.json',
];
const APP_LOCALE_SET = new Set(APP_LOCALES);

// VORAB NUR DIE RUECKFALLSPRACHE (Entscheidung 2026-10-07, Critique R18). Bis
// dahin holte jedes Release alle 26 Sprachdateien, von denen ein Geraet eine
// benutzt. `de` ist die Sprache, auf die i18n.js zurueckfaellt, und muss
// offline immer da sein. Die Sprache DIESES Geraets kennt der Worker nicht von
// selbst - die Seite nennt sie ihm (CACHE_LOCALE, gesendet von i18n.js beim
// Start, beim Sprachwechsel und wenn ein neuer Worker uebernimmt), und jeder
// gewoehnliche Abruf legt sie ohnehin ab (networkFirst).
const PRECACHED_LOCALES = ['/locales/de.json'];

// Seiten-Module: lazy geladen, aber vorab gecacht für Offline.
// waste.js fehlt hier BEWUSST (Round-3-Review, #1063): wie housekeeping.js
// und schedule.js ist es ein Opt-in-Modul, das die meisten Installationen
// nie laden - vorab gecacht würde es jede Installation Bytes kosten, und
// die Seite selbst ist ohne Netz ohnehin nur eingeschränkt nützlich (die
// Termine kommen aus /occurrences). Wer die drei offline will, hebt sie
// zusammen hierher, nicht einzeln.
const PAGE_MODULES = [
  '/pages/dashboard.js',
  '/pages/tasks.js',
  '/pages/shopping.js',
  '/pages/meals.js',
  '/pages/calendar.js',
  '/pages/notes.js',
  '/pages/contacts.js',
  '/pages/birthdays.js',
  '/pages/budget.js',
  '/pages/documents.js',
  '/pages/rewards.js',
  '/pages/health.js',
  '/pages/health-fasting.js',
  '/pages/settings.js',
  '/pages/login.js',
  '/pages/pair-display.js',
  '/pages/recipes.js',
  '/pages/pantry.js',
  '/pages/inventory.js',
  '/pages/budget-plans.js',
  '/pages/budget-stats.js',
  '/pages/split-expenses.js',
  '/pages/subscriptions.js',
  '/components/budget-transfer-dialog.js',
  '/components/category-manager.js',
  '/components/icon-picker.js',
  '/components/tag-manager.js',
  // Der Bildzuschnitt kommt per dynamischem import() aus mehreren Modulen
  // (Avatare, Geburtstage, Vorrat, Rezepte, Haushaltshilfe, Schnellzugriff).
  // Der Precache-Guard las dynamische Importe bis dahin nicht.
  '/utils/auth-ui.js',
  '/utils/brand-mark.js',
  '/utils/avatar-crop.js',
  '/utils/lucide-icons.js',
  '/utils/sortable.js',
  '/vendor/sortablejs/sortable.esm.min.js',
  // libphonenumber-js: lazy im Kontaktmodul, aber vorab gecacht → Telefon-
  // Formatierung funktioniert auch offline (Kernmodul). Versions-gecacht.
  '/vendor/libphonenumber/core.min.mjs',
  '/vendor/libphonenumber/metadata.min.json',
  '/settings/registry.js',
  '/settings/shell.js',
  // Die Shell importiert ihn beim Laden. Fehlte er hier, brach die
  // Einstellungsseite offline komplett - der Precache-Guard sah relative
  // Specifier bis dahin nicht und blieb dabei gruen.
  '/settings/dirty-guard.js',
  '/settings/components.js',
  '/settings/module-order.js',
  '/settings/cron-label.js',
  '/settings/backup-key.js',
  '/settings/currency.js',
  '/settings/preferences-cache.js',
  '/settings/region-presets.js',
  '/settings/weather-location.js',
  '/settings/family-users.js',
  '/settings/assignee-menu.js',
  '/settings/module-install-errors.js',
  '/settings/pages/personal-account.js',
  '/settings/pages/personal-schedule.js',
  '/settings/pages/admin-email.js',
  '/settings/pages/admin-permissions.js',
  '/settings/pages/personal-calendar-subscriptions.js',
  '/settings/pages/personal-feeds.js',
  '/settings/pages/personal-health.js',
  '/settings/pages/personal-weather.js',
  '/settings/pages/personal-appearance.js',
  '/settings/pages/personal-device.js',
  '/settings/pages/personal-calendar.js',
  '/settings/pages/personal-tasks.js',
  '/settings/pages/modules-active.js',
  '/settings/pages/modules-install.js',
  '/settings/pages/modules-navigation.js',
  '/settings/pages/modules-kitchen.js',
  '/settings/pages/modules-calendar.js',
  '/settings/pages/modules-options.js',
  '/settings/pages/modules-rewards.js',
  '/settings/pages/modules-health.js',
  '/settings/pages/modules-countdowns.js',
  '/settings/pages/sync-calendar.js',
  '/settings/pages/sync-contacts.js',
  '/settings/pages/sync-reminders.js',
  '/settings/pages/notifications.js',
  '/settings/pages/documents-storage.js',
  '/settings/pages/documents-dms.js',
  '/settings/pages/admin-family.js',
  '/settings/pages/admin-api.js',
  '/settings/pages/admin-displays.js',
  '/settings/pages/admin-backup.js',
  '/settings/pages/admin-weather.js',
  '/settings/pages/admin-immich.js',
  '/settings/pages/admin-system.js',
];

// Routing-Nachschlag für den fetch-Handler: hält Precache-Liste und
// Cache-Zuordnung an einer Quelle (siehe Kommentar im PAGES_CACHE-Zweig).
const PAGE_MODULE_SET = new Set(PAGE_MODULES);

// --------------------------------------------------------
// Bypass-Flag: nach SW-Update einmalig alles frisch vom Netz laden.
// In-Memory-Variable (schnell) + Cache API (SW-Restart-sicher).
// --------------------------------------------------------
let bypassCacheUntil = 0;

// Beim SW-Prozess-Start: Flag aus Cache API wiederherstellen.
// Nötig falls Chrome den SW zwischen activate und erstem Fetch terminiert hat.
let _bypassInitDone = false;
const _bypassInit = (async () => {
  try {
    const c = await caches.open(BYPASS_CACHE);
    const r = await c.match('/active');
    if (r) {
      const until = parseInt(r.headers.get('x-until') || '0');
      if (Date.now() < until) {
        bypassCacheUntil = until;
      } else {
        await c.delete('/active'); // abgelaufen, aufräumen
      }
    }
  } catch { /* Fehler ignorieren */ }
  _bypassInitDone = true;
})();

// --------------------------------------------------------
// Install: App-Shell + Seiten-Module vorab cachen
//
// `no-cache` HEISST REVALIDIEREN, NICHT "OHNE CACHE" (Entscheidung 2026-10-07,
// Critique R18). Bis dahin stand hier `cache: 'reload'`: jedes Release holte
// alle rund 300 Dateien neu, auch die, die sich nicht geaendert hatten. Mit
// `no-cache` fragt der Browser fuer jede Datei mit ihrem ETag nach, und der
// Server antwortet fuer eine unveraenderte mit 304 ohne Rumpf.
//
// DAS IST NUR SICHER, WEIL DER ETAG AUS DEM INHALT KOMMT
// (server/utils/static-assets.js). Ein ETag aus Groesse und Aenderungszeit, wie
// express.static ihn sonst bildet, bliebe bei einer gleich langen Aenderung mit
// gleicher Zeit stehen - und der neue Cache bekaeme die alte Datei. Eine
// geaenderte Datei MUSS neu kommen; `test:static-assets` haelt genau das.
// --------------------------------------------------------
self.addEventListener('install', (event) => {
  const freshShell   = APP_SHELL.map((url)    => new Request(url, { cache: 'no-cache' }));
  const freshModules = PAGE_MODULES.map((url) => new Request(url, { cache: 'no-cache' }));
  const freshLocales = PRECACHED_LOCALES.map((url) => new Request(url, { cache: 'no-cache' }));
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((c) => c.addAll(freshShell)),
      caches.open(PAGES_CACHE).then((c) => c.addAll(freshModules)),
      caches.open(LOCALES_CACHE).then((c) => c.addAll(freshLocales)),
    ]).then(() => self.skipWaiting())
  );
});

// --------------------------------------------------------
// Activate: Alte Cache-Versionen löschen + Bypass setzen + Clients informieren
// --------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Versions-Caches der laufenden Release behalten; alles andere entfernen —
          // inklusive alter Vorversions-Caches UND der Legacy-`oikos-*`-Caches aus der
          // Zeit vor dem Yuvomi-Rename (Cache-Invalidierung, kein User-Eingriff nötig).
          .filter((key) => !ALL_CACHES.includes(key) && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    )
    // Assets-Cache leeren: lazily gecachte Bilder/Icons werden sonst nie erneuert.
    .then(() => caches.delete(ASSETS_CACHE))
    .then(async () => {
      // Bypass-Fenster setzen: nach SW-Update lädt die nächste Seite alles frisch.
      // KEIN künstliches waitUntil-Delay hier — Chrome würde clients.claim()
      // / controllerchange erst nach Ablauf der waitUntil-Promise feuern,
      // was dazu führt dass bypassCacheUntil gerade abläuft wenn der Reload kommt.
      const bypassUntil = Date.now() + 30000;
      bypassCacheUntil = bypassUntil;

      // Cache API: überlebt SW-Prozess-Terminierung zwischen activate und Reload
      try {
        const c = await caches.open(BYPASS_CACHE);
        await c.put('/active', new Response('1', {
          headers: { 'x-until': String(bypassUntil) },
        }));
      } catch { /* Fehler ignorieren */ }

      self.clients.claim();
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

// --------------------------------------------------------
// Fetch: Strategie je nach Request-Typ
// --------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (!url.protocol.startsWith('http')) return;

  // API-Requests: nur GET-Whitelist read-only offline-cachen. Alles andere
  // (Mutationen, /auth/*, Nicht-Whitelist) unangetastet ans Netz durchreichen.
  if (url.pathname.startsWith('/api/')) {
    const snapshotReducer = request.method === 'GET' ? apiSnapshotReducer(url.pathname) : null;
    if (request.method === 'GET' && (snapshotReducer || isCacheableApiGet(url.pathname))) {
      // Die Generation des API-Caches beim EINGANG des Abrufs (#2293): bis die
      // Strategie unten laeuft, kann schon abgemeldet worden sein.
      const generation = _cacheGeneration;
      event.respondWith(
        (_bypassInitDone ? Promise.resolve() : _bypassInit).then(() => {
          // Im Bypass-Fenster (nach SW-Update) API-Requests nicht anfassen:
          // frisch ans Netz, weder aus Cache bedienen noch hineinschreiben.
          if (Date.now() < bypassCacheUntil) return fetch(request);
          return snapshotReducer
            ? networkFirstSnapshot(request, snapshotReducer, generation)
            : networkFirstApi(request, event, generation);
        })
      );
    }
    return;
  }

  if (request.method !== 'GET') return;

  // Erste Fetch-Events nach SW-Start: auf Cache-API-Initialisierung warten,
  // damit bypassCacheUntil korrekt gesetzt ist bevor wir entscheiden.
  if (!_bypassInitDone) {
    event.respondWith(
      _bypassInit.then(() => dispatchFetch(request, url, event))
    );
    return;
  }

  event.respondWith(dispatchFetch(request, url, event));
});

function dispatchFetch(request, url, event) {
  // Nach SW-Update: direkt vom Netz, kein SW-Cache, kein HTTP-Cache.
  // Gilt für ALLE Requests (JS, CSS, Images, HTML) im Bypass-Fenster.
  if (Date.now() < bypassCacheUntil) {
    return fetch(new Request(request, { cache: 'no-cache' })).catch(async () => {
      const cached = await caches.match(request)
        || await caches.match('/index.html')
        || await caches.match('/offline.html');
      return cached || new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    });
  }

  // Bypass abgelaufen: Cache API Flag aufräumen (lazy, beim ersten Request danach)
  if (bypassCacheUntil !== 0) {
    bypassCacheUntil = 0;
    caches.open(BYPASS_CACHE).then(c => c.delete('/active')).catch(() => {});
  }

  if (request.mode === 'navigate') {
    return networkFirst(request, SHELL_CACHE, event);
  }

  if (url.pathname.startsWith('/locales/')) {
    return networkFirst(request, LOCALES_CACHE, event);
  }

  // Lazy geladene Seiten-Module liegen in PAGES_CACHE. Neben /pages/ gehören dazu
  // die Settings-Leaves unter /settings/ sowie einzelne lazy nachgeladene Module
  // (Kategorie-Manager, Sortable-Wrapper samt Vendor-Bundle, libphonenumber) -
  // ohne diesen Zweig würden sie via SHELL_CACHE bedient und offline (vor dem
  // ersten Online-Besuch) als index.html statt als JS-Modul ausgeliefert.
  // Die Einzelfälle kommen aus PAGE_MODULES selbst statt aus einer zweiten,
  // von Hand gepflegten Aufzählung: sonst driftet das Routing vom Precache ab
  // und ein neu aufgenommenes Modul liegt im falschen Cache.
  if (
    url.pathname.startsWith('/pages/') ||
    url.pathname.startsWith('/settings/') ||
    PAGE_MODULE_SET.has(url.pathname)
  ) {
    return networkFirst(request, PAGES_CACHE, event);
  }

  if (url.origin === self.location.origin && isMutableAppResource(url.pathname)) {
    return networkFirst(request, SHELL_CACHE, event);
  }

  if (isAsset(url.pathname) && url.origin === self.location.origin) {
    return cacheFirst(request, ASSETS_CACHE);
  }

  return cacheFirst(request, SHELL_CACHE);
}

// --------------------------------------------------------
// Strategie: Network-First mit Frist (Navigation, Shell, Seitenmodule,
// Stylesheets, Locales)
//
// EIN NETZ, DAS NICHT "OFFLINE" MELDET, ABER NICHT ANTWORTET (Critique R18).
// Bis dahin wartete jede dieser Anfragen, bis `fetch` von selbst aufgab - im
// Zug, im Aufzug, am Rand des WLAN haengt der Start dann minutenlang, obwohl
// alles im Cache liegt. Jetzt laeuft das Netz gegen eine Frist:
//
//   - antwortet es rechtzeitig, gilt seine Antwort (Network-First bleibt die
//     Strategie, siehe Dateikopf);
//   - laeuft die Frist ab und es gibt einen Cache-Treffer fuer GENAU diese
//     Anfrage, kommt der. Das Netz laeuft weiter und legt seine Antwort in den
//     Cache - der naechste Abruf hat sie;
//   - ohne Treffer wird weiter aufs Netz gewartet, wie vorher.
//
// DIE FRIST KOSTET EINMAL, NICHT JE DATEI. Die Shell ist ein Modulgraph: der
// Browser erfaehrt die naechste Ebene erst aus der vorigen, und mit einer Frist
// je Anfrage wartete ein Start an jeder Ebene erneut 1,5 s (gemessen mit
// angehaltenem Server: nach 9 s noch kein Router). Reisst eine Anfrage die
// Frist, gilt das Netz deshalb fuer SLOW_NETWORK_WINDOW_MS als langsam: wer in
// dieser Zeit einen Cache-Treffer hat, bekommt ihn sofort, und das Netz fuellt
// im Hintergrund nach. Danach wird wieder gemessen. Das haelt auch zusammen,
// was zusammengehoert: nach dem ersten Treffer aus dem Cache kommt der Rest
// des Starts aus demselben Cache statt halb vom Netz.
//
// DER TREFFER IST DIE ANFRAGE SELBST - mit einer Ausnahme: eine Navigation auf
// eine Route der App. Der Server beantwortet jede davon mit `index.html`
// (SPA-Fallback in server/index.js), im Cache liegt aber nur, was schon einmal
// als Dokument geladen wurde; ein Neuladen auf `/tasks` wartete sonst weiter
// aufs Netz (gemessen). Was KEINE Route der App ist, bekommt den Ersatz nur
// beim Ausfall (catch unten), nie nach der Frist: eine Navigation auf einen
// Feed oder eine Datei bekaeme sonst nach 1,5 s die App-Shell statt ihrer
// Antwort. Die Grenze zieht isAppRouteNavigation().
//
// DAS BYPASS-FENSTER NACH EINEM SW-UPDATE LAEUFT NICHT HIER DURCH
// (dispatchFetch): dort gilt keine Frist, alles kommt frisch vom Netz. Und der
// Mischzustand aus #616 bleibt, was er war: zwischen einem Server-Update und
// der Uebernahme durch den neuen Worker kann eine Seite alte und neue Dateien
// sehen - vorher, wenn einzelne Abrufe ausfielen, jetzt auch, wenn einzelne die
// Frist reissen. Dafuer gibt es den Reload in importPage() (router.js) und, fuer
// eine Shell, die gar nicht erst startet, den in sw-register.js.
// --------------------------------------------------------
const NETWORK_FIRST_DEADLINE_MS = 1500;
const SLOW_NETWORK_WINDOW_MS = 10000;
const DEADLINE_PASSED = Symbol('deadline');
let slowNetworkUntil = 0;

async function networkFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);

  // Das Ablegen haelt die Antwort nicht auf, wird aber gemerkt: nach der Frist
  // muss der Worker so lange leben, bis es durch ist.
  let stored = Promise.resolve();
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      stored = Promise.resolve(cache.put(request, response.clone())).catch(() => {});
    }
    return response;
  });

  // Das Netz laeuft weiter und fuellt den Cache nach. `waitUntil` haelt den
  // Worker dafuer am Leben; ein spaeter Fehler ist dann keiner mehr.
  const serveCached = (cached) => {
    const refill = network.then(() => stored, () => {});
    if (event && typeof event.waitUntil === 'function') event.waitUntil(refill);
    return cached;
  };

  const cachedCopy = async () => (
    await cache.match(request)
      || (isAppRouteNavigation(request) ? cache.match('/index.html') : undefined)
  );

  let timer;
  try {
    if (Date.now() < slowNetworkUntil) {
      const cached = await cachedCopy();
      if (cached) return serveCached(cached);
    }

    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE_PASSED), NETWORK_FIRST_DEADLINE_MS);
    });
    const first = await Promise.race([network, deadline]);
    if (first !== DEADLINE_PASSED) return first;

    const cached = await cachedCopy();
    if (!cached) return await network;

    slowNetworkUntil = Date.now() + SLOW_NETWORK_WINDOW_MS;
    return serveCached(cached);
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    const shell = await cache.match('/index.html');
    if (shell) return shell;

    const offline = await caches.match('/offline.html');
    if (offline) return offline;

    return new Response('Keine Verbindung', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------
// Profilbilder einer gecachten Liste (server/routes/people.js)
// --------------------------------------------------------
const AVATAR_PATH_RE = /^\/api\/v1\/people\/\d+\/avatar$/;
const AVATAR_URL_RE = /^\/api\/v1\/people\/\d+\/avatar\?v=[0-9a-f]{32}$/;
// NUR DIESE FELDER, dieselben wie AVATAR_FIELDS in
// server/services/person-avatar.js (test:sw-api-cache haelt beide gleich). Ein
// Titel oder eine Beschreibung mit eingetippten Bildpfaden loeste sonst je
// Treffer einen Abruf aus, bei jedem Laden wieder (Codex-Review zu #2056).
const AVATAR_FIELDS = new Set([
  'assigned_avatar', 'avatar_data', 'creator_avatar', 'worker_avatar_data', 'user_avatar', 'person_avatar',
]);

/** Die Bildadressen aus den Bildfeldern einer Antwort, jede einmal. */
function avatarPathsIn(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) avatarPathsIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (AVATAR_FIELDS.has(key)) {
        if (typeof inner === 'string' && AVATAR_URL_RE.test(inner)) found.add(inner);
      } else {
        avatarPathsIn(inner, found);
      }
    }
  }
  return found;
}

/**
 * Legt die Profilbilder, deren Adresse in einer Listen-Antwort steht, in den
 * API-Cache - nur aus den Bildfeldern, jede Adresse einmal, auch wenn sie in
 * hundert Zeilen steht, und nur, wenn sie noch nicht dort liegt (die Adresse
 * wechselt mit dem Bild).
 * @param {string} baseUrl Adresse der Liste, gegen die die Pfade aufgeloest werden
 * @param {string} text Rumpf der Liste
 */
async function precacheAvatars(baseUrl, text, generation) {
  let body;
  try { body = JSON.parse(text); } catch { return; }
  const paths = [...avatarPathsIn(body)];
  if (!paths.length || !(await ensureSessionExpiry(generation))) return;
  const cache = await caches.open(API_CACHE);
  await Promise.all(paths.map(async (path) => {
    const url = new URL(path, baseUrl).href;
    if (await cache.match(url)) return;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.ok && res.type === 'basic' && generation === _cacheGeneration) await cache.put(url, res);
    } catch {
      // Offline oder abgewiesen: beim naechsten Laden der Liste wieder.
    }
  }));
}

// --------------------------------------------------------
// Strategie: Network-First für GET-API (Read-only-Offline)
// Erfolg → Antwort klonen, x-cached-at-Header ergänzen, in API_CACHE legen.
// Netzfehler → Cache-Fallback, sonst 503-JSON {error:'offline'}; nach dem
//          Sitzungsablauf (#2293) kein Fallback, der API-Cache geht weg.
// --------------------------------------------------------
async function networkFirstApi(request, event, generation = _cacheGeneration) {
  try {
    const response = await fetch(request);
    // Nur erfolgreiche, gleichoriginäre (basic) Antworten cachen - und nur
    // neben einem gueltigen Sitzungsablauf (#2293): ohne ihn entstuende ein
    // Eintrag, den der Offline-Pfad ohnehin nie mehr ausliefert.
    if (response.ok && response.type === 'basic' && await ensureSessionExpiry(generation)) {
      await extendSessionExpiry(response, generation);
      const cloned  = response.clone();
      const headers = new Headers(cloned.headers);
      headers.set('x-cached-at', String(Date.now()));
      const body = await cloned.blob();
      // Unmittelbar vor dem Schreiben: noch dieselbe Generation?
      if (generation !== _cacheGeneration) return response;
      const cache = await caches.open(API_CACHE);
      await cache.put(request, new Response(body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers,
      }));
      // Bilder, deren Adresse in der Liste steht, gleich mitnehmen - sonst
      // fehlt offline jedes, dessen Zeile nie auf dem Schirm war
      // (loading="lazy"). Die Liste wartet nicht darauf, das fetch-Event
      // schon: `waitUntil` haelt den Worker am Leben, bis die Bilder im Cache
      // liegen - sonst darf der Browser ihn nach der Antwort beenden.
      if (!AVATAR_PATH_RE.test(new URL(request.url).pathname)) {
        const prefetch = response.clone().text().then((text) => precacheAvatars(request.url, text, generation)).catch(() => {});
        if (event && typeof event.waitUntil === 'function') event.waitUntil(prefetch);
      }
    }
    return response;
  } catch {
    if (await dropApiCacheIfSessionExpired()) return offlineResponse();
    return (await cachedApiResponse(request)) || offlineResponse();
  }
}

// --------------------------------------------------------
// Strategie: Cache-First (für Shell, Pages, Assets)
// --------------------------------------------------------
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 408 });
  }
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------
function isAsset(pathname) {
  return /\.(png|jpg|jpeg|ico|svg|webp|woff2?|gif)$/i.test(pathname);
}

/**
 * Ist das eine Navigation auf eine Route der App - also eine, die der Server
 * mit `index.html` beantwortet? Die App-Routen kennt der Worker nicht, wohl
 * aber, was KEINE ist: alles mit Dateiendung, die Feeds, der MCP-Endpunkt und
 * die API-Dokumentation `/docs` (eigene Server-Route, server/index.js; ein
 * langsamer Server gaebe dem Admin sonst die Shell statt der Dokumentation).
 * `/api/` erreicht diese Stelle gar nicht erst.
 */
function isAppRouteNavigation(request) {
  if (request.mode !== 'navigate') return false;
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/feed/') || pathname === '/mcp' || pathname.startsWith('/mcp/')) return false;
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return false;
  return !/\.[a-z0-9]+$/i.test(pathname);
}

function isMutableAppResource(pathname) {
  return pathname === '/'
    || pathname === '/index.html'
    || pathname === '/manifest.json'
    || /\.(css|js|json|html)$/i.test(pathname);
}

// --------------------------------------------------------
// Strategie: Network-First fuer die Abzuege (#2293, API_SNAPSHOTS oben)
// Erfolg → nur der reduzierte Abzug in API_CACHE, die Netzantwort unveraendert
//          an die Seite. Kein Abzug (Display, Split-Gast) oder 401 → Eintrag weg.
// Netzfehler → Abzug, sonst 503-JSON {error:'offline'} wie networkFirstApi;
//          nach dem Sitzungsablauf keins von beiden (dropApiCacheIfSessionExpired).
// --------------------------------------------------------
async function networkFirstSnapshot(request, reduce, generation = _cacheGeneration) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    if (await dropApiCacheIfSessionExpired()) return offlineResponse();
    return (await cachedApiResponse(request)) || offlineResponse();
  }
  await storeSnapshot(request, response, reduce, generation);
  return response;
}

/**
 * Legt den Abzug einer Netzantwort ab (oder raeumt ihn weg). Wirft nie.
 * `generation` ist die des API-Caches vor dem fetch(); hat er sich seitdem
 * geaendert, wird nichts geschrieben.
 */
async function storeSnapshot(request, response, reduce, generation) {
  try {
    if (generation !== _cacheGeneration) return;
    if (response.ok && response.type === 'basic') {
      const body = await response.clone().json();
      // `/auth/me` schreibt den Ablauf; jeder andere Abzug nur neben einem gueltigen.
      const allowed = reduce === reduceSessionSnapshot
        ? await rememberSessionExpiry(await caches.open(API_CACHE), body, generation)
        : await ensureSessionExpiry(generation);
      if (allowed && reduce !== reduceSessionSnapshot) await extendSessionExpiry(response, generation);
      const snapshot = allowed ? reduce(body) : null;
      if (snapshot && generation === _cacheGeneration) {
        await (await caches.open(API_CACHE)).put(request, new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-cached-at': String(Date.now()) },
        }));
      } else if (!snapshot && await caches.has(API_CACHE)) {
        await (await caches.open(API_CACHE)).delete(request);
      }
    } else if (response.status === 401 && await caches.has(API_CACHE)) {
      await (await caches.open(API_CACHE)).delete(request);
    }
  } catch { /* Speicher voll oder kein JSON: die Antwort geht trotzdem raus */ }
}

/**
 * DER WORKER HOLT DEN SITZUNGSABLAUF SELBST, wenn er fehlt (Codex, #2293).
 * Ohne ihn legt er keine Liste ab - und die Seite fragt `/auth/me` nicht
 * zuverlaessig vorher: nach einem Update geht die Startabfrage im
 * Bypass-Fenster am Cache vorbei, beim Start kann `/preferences` vor
 * `/auth/me` ankommen. Eine Abfrage zur Zeit; schlaegt sie fehl, bleibt es
 * beim fail-closed.
 */
let _sessionProbe = null;
async function ensureSessionExpiry(generation) {
  // Eine Antwort aus einer frueheren Generation fragt gar nicht erst nach:
  // die neue Sitzung gehoert jemand anderem.
  if (generation !== _cacheGeneration) return false;
  if (await hasValidSessionExpiry()) return generation === _cacheGeneration;
  if (!_sessionProbe) {
    // Die Probe merkt sich IHRE Generation: wird waehrenddessen geleert,
    // schreibt sie keinen Ablauf in den Cache der naechsten Sitzung.
    const probeGeneration = _cacheGeneration;
    _sessionProbe = (async () => {
      try {
        const request = new Request(`${self.location.origin}/api/v1/auth/me`, { credentials: 'same-origin' });
        await storeSnapshot(request, await fetch(request), reduceSessionSnapshot, probeGeneration);
      } catch { /* offline oder abgewiesen: kein Ablauf, also nichts ablegen */ }
    })().finally(() => { _sessionProbe = null; });
  }
  await _sessionProbe;
  return generation === _cacheGeneration && hasValidSessionExpiry();
}

// Prüft, ob ein API-Pfad (inkl. /api/v1-Prefix) zur Read-only-Offline-Whitelist
// gehört. Query-Strings sind nicht Teil von pathname → reiner Pfad-Prefix-Match.
function isCacheableApiGet(pathname) {
  if (!pathname.startsWith('/api/v1')) return false;
  const rest = pathname.slice('/api/v1'.length);
  // Die Laufnummern-Abfrage der Einkaufslisten faellt unter das Prefix
  // /shopping, gehoert aber nicht in den Cache: sie kommt alle 10 s je offenem
  // Tab, und offline hat ein alter Stand der Nummern keinen Wert - die Seite
  // bekaeme ihn als normale 200 zurueck und hielte ihn fuer frisch.
  if (API_CACHE_EXCLUDE.includes(rest)) return false;
  return API_CACHE_WHITELIST.some((p) => rest === p || rest.startsWith(`${p}/`));
}

// --------------------------------------------------------
// Nachrichten vom Client: API-Cache leeren (Logout/Session-Ende)
// --------------------------------------------------------
self.addEventListener('message', (event) => {
  // Die Seite nennt die Sprache dieses Geraets (i18n.js), damit sie offline da
  // ist, auch wenn ihr Abruf am Worker vorbeiging: beim Erstbesuch (noch kein
  // Controller) und im Bypass-Fenster nach einem Update (dort wird nichts
  // abgelegt). Nur zugelassene Dateien, und nur, wenn sie noch fehlt.
  if (event.data && event.data.type === 'CACHE_LOCALE') {
    const path = `/locales/${event.data.locale}.json`;
    if (!APP_LOCALE_SET.has(path)) return;
    event.waitUntil(
      caches.open(LOCALES_CACHE)
        .then(async (cache) => {
          if (await cache.match(path)) return;
          await cache.add(new Request(path, { cache: 'no-cache' }));
        })
        .catch(() => { /* offline oder Speicher voll: beim naechsten Abruf */ }),
    );
    return;
  }
  if (event.data && event.data.type === 'CLEAR_API_CACHE') {
    // QUITTIEREN, WENN DER ABSENDER EINEN PORT MITSCHICKT. Ohne Rueckmeldung
    // weiss die Seite nie, wann der Cache wirklich weg ist, und ein sofortiges
    // Neuladen kann noch aus ihm bedient werden - beim Koppeln waeren das die
    // privaten Antworten der vorherigen Person. Ein Absender ohne Port (die
    // aelteren Aufrufer) bekommt wie bisher nichts zurueck.
    const port = event.ports && event.ports[0];
    event.waitUntil(
      deleteApiCache()
        .catch(() => false)
        .then(() => { if (port) port.postMessage({ ok: true }); }),
    );
  }
});

// --------------------------------------------------------
// Web Push
// --------------------------------------------------------
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Yuvomi', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Yuvomi';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'yuvomi-push',
    // `/` UND NICHT `/reminders`: diese Route hat es nie gegeben (Critique
    // 2026-08-10). Der Router kannte sie nicht und fiel still auf die
    // Uebersicht zurueck - ein Fallback, der wie ein Ziel aussah. Die Uebersicht
    // ist jetzt der ausgesprochene Fallback; das echte Ziel kommt aus
    // `payload.url`, das der Server je Herkunft setzt (services/notifications.js).
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        client.focus();
        if ('navigate' in client) {
          try { await client.navigate(targetUrl); } catch { /* cross-origin/navigation guard */ }
        }
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(targetUrl);
  })());
});
