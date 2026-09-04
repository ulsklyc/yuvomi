/**
 * Modul: Service Worker
 * Zweck: Offline-Fähigkeit, differenzierte Caching-Strategien, Update-Notification
 * Abhängigkeiten: keine
 *
 * Caching-Strategien (der Dispatcher unten ist die Wahrheit; dieser Kopf
 * behauptete bis 2026-08-31 "Cache-First" für Shell und Seitenmodule):
 *   Navigation + APP_SHELL + PAGE_MODULES + Locales: Network-First mit dem
 *        Precache (install) als Offline-Fallback - frisch, solange Netz da ist.
 *   ASSETS (Bilder, Icons) und der Rest-Fallback: Cache-First, lazily gecacht,
 *        bei SW-Update geleert
 *   API: Network-First für eine Read-only-GET-Whitelist (Kalender, Tasks, …)
 *        → offline letzter Stand sichtbar; Mutationen/Auth immer direkt ans Netz.
 *        Cache wird bei Logout/Session-Ende geleert (CLEAR_API_CACHE-Message).
 *
 * Nach SW-Update: alle Requests gehen einmalig cache-bypassed ans Netz
 *   → bypassCacheUntil (in-memory + Cache API für SW-Restart-Robustheit)
 */

const APP_RELEASE        = '2.64.0';
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
const API_CACHE_WHITELIST = ['/calendar', '/tasks', '/shopping', '/contacts', '/dashboard'];

// App-Shell: sofort benötigt für ersten Render
const APP_SHELL = [
  '/',
  '/index.html',
  '/api.js',
  '/lang-init.js',
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
  '/permissions.js',
  // Der Router laedt ihn als Seiteneffekt (`import '/components/datepicker.js'`),
  // also gehoert er in die Shell, nicht zu den Seitenmodulen. Der
  // Precache-Guard sah diese Import-Form bis #944 nicht.
  '/components/datepicker.js',
  '/components/detail-view.js',
  '/components/document-attach.js',
  '/components/modal.js',
  '/components/photo-screensaver.js',
  '/components/quick-links-manager.js',
  '/components/task-detail.js',
  '/components/user-multi-select.js',
  '/components/wall-timer.js',
  '/utils/birthday-event.js',
  '/utils/bulk-pill.js',
  '/utils/category-labels.js',
  '/utils/chart.js',
  '/utils/color.js',
  '/utils/contact-name.js',
  '/utils/contrast.js',
  '/utils/countdown.js',
  '/utils/dashboard-layout-hint.js',
  '/utils/dashboard-widgets.js',
  '/utils/date.js',
  '/utils/day-label.js',
  '/utils/currency-codes.js',
  '/utils/document-preview.js',
  '/utils/event-color.js',
  '/utils/empty-state.js',
  '/utils/extension-i18n.js',
  '/utils/extension-widgets.js',
  '/utils/fab.js',
  '/utils/folder-upload.js',
  '/utils/folder-tree.js',
  '/utils/health-activity.js',
  '/utils/health-cycle.js',
  '/utils/health-labs.js',
  '/utils/health-meds.js',
  '/utils/health-overview.js',
  '/utils/health-tabs.js',
  '/utils/health-vitals.js',
  '/utils/help.js',
  '/utils/household.js',
  '/utils/html-escape.js',
  '/utils/html.js',
  '/utils/ingredient-row.js',
  '/utils/inventory-warranty.js',
  '/utils/kitchen-tabs.js',
  '/utils/kitchen-transfer.js',
  '/utils/markdown-checklist.js',
  '/utils/markdown-toolbar.js',
  '/utils/mentions.js',
  '/utils/module-accent.js',
  '/utils/metric-card.js',
  '/utils/money.js',
  '/utils/nav-badges.js',
  '/utils/overlay-history.js',
  '/utils/page-layout.js',
  '/utils/page-search.js',
  '/utils/pantry-locations.js',
  '/utils/pantry-status.js',
  '/utils/pantry-units.js',
  '/utils/permission-group.js',
  '/utils/phone.js',
  '/utils/popover-menu.js',
  '/utils/quick-link-url.js',
  '/utils/pwa-install.js',
  '/utils/recipe-meal-types.js',
  '/utils/recipe-to-meal.js',
  '/utils/recurrence-scope.js',
  '/utils/reminder-offset.js',
  '/utils/scroll-restore.js',
  '/utils/seal-pair.js',
  '/utils/shopping-categories.js',
  '/utils/skeleton.js',
  '/utils/sub-tabs.js',
  '/utils/swipe-row.js',
  '/utils/sync-target.js',
  '/utils/tablist.js',
  '/utils/task-fields.js',
  '/utils/timezone.js',
  '/utils/toast-surface.js',
  '/utils/ux.js',
  '/utils/vcard.js',
  '/utils/version.js',
  '/utils/upload-limit.js',
  '/utils/wall-mode.js',
  '/utils/web-share.js',
  '/offline.html',
  // offline.html laedt theme-init.js, damit die Huelle dieselbe Farbwelt
  // trifft wie die App (gespeicherter Wunsch schlaegt Systemeinstellung).
  // Ohne Precache waere die Wahl genau dann wirkungslos, wenn die Seite
  // gebraucht wird - offline.
  '/theme-init.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

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
  '/locales/nl.json',
  '/locales/pl.json',
  '/locales/pt.json',
  '/locales/ru.json',
  '/locales/sv.json',
  '/locales/tr.json',
  '/locales/uk.json',
  '/locales/vi.json',
  '/locales/zh.json',
];

// Seiten-Module: lazy geladen, aber vorab gecacht für Offline
const PAGE_MODULES = [
  '/pages/dashboard.js',
  '/pages/tasks.js',
  '/pages/shopping.js',
  '/pages/meals.js',
  '/pages/calendar.js',
  '/pages/schedule.js',
  '/pages/notes.js',
  '/pages/contacts.js',
  '/pages/birthdays.js',
  '/pages/budget.js',
  '/pages/documents.js',
  '/pages/rewards.js',
  '/pages/health.js',
  '/pages/settings.js',
  '/pages/login.js',
  '/pages/recipes.js',
  '/pages/pantry.js',
  '/pages/inventory.js',
  '/pages/budget-plans.js',
  '/pages/budget-stats.js',
  '/pages/split-expenses.js',
  '/pages/subscriptions.js',
  '/components/category-manager.js',
  '/components/icon-picker.js',
  '/components/tag-manager.js',
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
  '/settings/currency.js',
  '/settings/preferences-cache.js',
  '/settings/region-presets.js',
  '/settings/weather-location.js',
  '/settings/family-users.js',
  '/settings/pages/personal-account.js',
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
  '/settings/pages/modules-navigation.js',
  '/settings/pages/modules-kitchen.js',
  '/settings/pages/modules-calendar.js',
  '/settings/pages/modules-options.js',
  '/settings/pages/modules-rewards.js',
  '/settings/pages/sync-calendar.js',
  '/settings/pages/sync-contacts.js',
  '/settings/pages/sync-reminders.js',
  '/settings/pages/notifications.js',
  '/settings/pages/documents-storage.js',
  '/settings/pages/documents-dms.js',
  '/settings/pages/admin-family.js',
  '/settings/pages/admin-api.js',
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
// cache: 'reload' umgeht den HTTP-Cache → immer frische Dateien
// --------------------------------------------------------
self.addEventListener('install', (event) => {
  const freshShell   = APP_SHELL.map((url)    => new Request(url, { cache: 'reload' }));
  const freshModules = PAGE_MODULES.map((url) => new Request(url, { cache: 'reload' }));
  const freshLocales = APP_LOCALES.map((url) => new Request(url, { cache: 'reload' }));
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
    if (request.method === 'GET' && isCacheableApiGet(url.pathname)) {
      event.respondWith(
        (_bypassInitDone ? Promise.resolve() : _bypassInit).then(() => {
          // Im Bypass-Fenster (nach SW-Update) API-Requests nicht anfassen:
          // frisch ans Netz, weder aus Cache bedienen noch hineinschreiben.
          if (Date.now() < bypassCacheUntil) return fetch(request);
          return networkFirstApi(request);
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
      _bypassInit.then(() => dispatchFetch(request, url))
    );
    return;
  }

  event.respondWith(dispatchFetch(request, url));
});

function dispatchFetch(request, url) {
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
    return networkFirst(request, SHELL_CACHE);
  }

  if (url.pathname.startsWith('/locales/')) {
    return networkFirst(request, LOCALES_CACHE);
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
    return networkFirst(request, PAGES_CACHE);
  }

  if (url.origin === self.location.origin && isMutableAppResource(url.pathname)) {
    return networkFirst(request, SHELL_CACHE);
  }

  if (isAsset(url.pathname) && url.origin === self.location.origin) {
    return cacheFirst(request, ASSETS_CACHE);
  }

  return cacheFirst(request, SHELL_CACHE);
}

// --------------------------------------------------------
// Strategie: Network-First (für Navigation Requests)
// --------------------------------------------------------
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
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
  }
}

// --------------------------------------------------------
// Strategie: Network-First für GET-API (Read-only-Offline)
// Erfolg → Antwort klonen, x-cached-at-Header ergänzen, in API_CACHE legen.
// Netzfehler → Cache-Fallback, sonst 503-JSON {error:'offline'}.
// --------------------------------------------------------
async function networkFirstApi(request) {
  try {
    const response = await fetch(request);
    // Nur erfolgreiche, gleichoriginäre (basic) Antworten cachen.
    if (response.ok && response.type === 'basic') {
      const cache   = await caches.open(API_CACHE);
      const cloned  = response.clone();
      const headers = new Headers(cloned.headers);
      headers.set('x-cached-at', String(Date.now()));
      const body = await cloned.blob();
      await cache.put(request, new Response(body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers,
      }));
    }
    return response;
  } catch {
    const cache  = await caches.open(API_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
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

function isMutableAppResource(pathname) {
  return pathname === '/'
    || pathname === '/index.html'
    || pathname === '/manifest.json'
    || /\.(css|js|json|html)$/i.test(pathname);
}

// Prüft, ob ein API-Pfad (inkl. /api/v1-Prefix) zur Read-only-Offline-Whitelist
// gehört. Query-Strings sind nicht Teil von pathname → reiner Pfad-Prefix-Match.
function isCacheableApiGet(pathname) {
  if (!pathname.startsWith('/api/v1')) return false;
  const rest = pathname.slice('/api/v1'.length);
  return API_CACHE_WHITELIST.some((p) => rest === p || rest.startsWith(`${p}/`));
}

// --------------------------------------------------------
// Nachrichten vom Client: API-Cache leeren (Logout/Session-Ende)
// --------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_API_CACHE') {
    event.waitUntil(caches.delete(API_CACHE));
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
