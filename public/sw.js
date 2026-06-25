/**
 * Modul: Service Worker
 * Zweck: Offline-Fähigkeit, differenzierte Caching-Strategien, Update-Notification
 * Abhängigkeiten: keine
 *
 * Caching-Strategien:
 *   APP_SHELL (HTML + kritische JS/CSS): Cache-First (frisch vorgeladen via install)
 *   PAGE_MODULES (Seiten-JS): Cache-First (frisch vorgeladen via install)
 *   ASSETS (Bilder, Icons): Cache-First, lazily gecacht, bei SW-Update geleert
 *   API: Immer Netzwerk (kein Caching von Nutzerdaten)
 *
 * Nach SW-Update: alle Requests gehen einmalig cache-bypassed ans Netz
 *   → bypassCacheUntil (in-memory + Cache API für SW-Restart-Robustheit)
 */

const APP_RELEASE   = '0.77.3';
const SHELL_CACHE   = `oikos-shell-${APP_RELEASE}`;
const PAGES_CACHE   = `oikos-pages-${APP_RELEASE}`;
const LOCALES_CACHE = `oikos-locales-${APP_RELEASE}`;
const ASSETS_CACHE  = `oikos-assets-${APP_RELEASE}`;
const BYPASS_CACHE  = 'oikos-bypass-flag';
const ALL_CACHES    = [SHELL_CACHE, PAGES_CACHE, LOCALES_CACHE, ASSETS_CACHE];

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
  '/styles/tokens.css',
  '/styles/reset.css',
  '/styles/pwa.css',
  '/styles/layout.css',
  '/styles/glass.css',
  '/styles/login.css',
  '/styles/reminders.css',
  '/styles/dashboard.css',
  '/styles/tasks.css',
  '/styles/shopping.css',
  '/styles/meals.css',
  '/styles/calendar.css',
  '/styles/notes.css',
  '/styles/contacts.css',
  '/styles/birthdays.css',
  '/styles/budget.css',
  '/styles/documents.css',
  '/styles/settings.css',
  '/styles/recipes.css',
  '/components/oikos-install-prompt.js',
  '/offline.html',
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
  '/locales/fr.json',
  '/locales/hi.json',
  '/locales/hu.json',
  '/locales/it.json',
  '/locales/ja.json',
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
  '/pages/notes.js',
  '/pages/contacts.js',
  '/pages/birthdays.js',
  '/pages/budget.js',
  '/pages/documents.js',
  '/pages/settings.js',
  '/pages/login.js',
  '/pages/recipes.js',
  '/components/shopping-category-manager.js',
  '/components/category-manager.js',
  '/settings/registry.js',
  '/settings/shell.js',
  '/settings/components.js',
  '/settings/module-order.js',
  '/settings/pages/personal-account.js',
  '/settings/pages/personal-appearance.js',
  '/settings/pages/personal-device.js',
  '/settings/pages/modules-navigation.js',
  '/settings/pages/modules-kitchen.js',
  '/settings/pages/modules-calendar.js',
  '/settings/pages/modules-budget.js',
  '/settings/pages/modules-housekeeping.js',
  '/settings/pages/modules-dashboard.js',
  '/settings/pages/sync-calendar.js',
  '/settings/pages/sync-contacts.js',
  '/settings/pages/sync-reminders.js',
  '/settings/pages/notifications.js',
  '/settings/pages/documents-storage.js',
  '/settings/pages/documents-dms.js',
  '/settings/pages/admin-family.js',
  '/settings/pages/admin-api.js',
  '/settings/pages/admin-backup.js',
  '/settings/pages/admin-system.js',
];

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
          .filter((key) => !ALL_CACHES.includes(key))
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
  if (url.pathname.startsWith('/api/')) return;
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
  // die Settings-Leaves unter /settings/ und die Kategorie-Manager-Komponenten —
  // ohne diesen Zweig würden sie via SHELL_CACHE bedient und offline (vor dem
  // ersten Online-Besuch) als index.html statt als JS-Modul ausgeliefert.
  if (
    url.pathname.startsWith('/pages/') ||
    url.pathname.startsWith('/settings/') ||
    url.pathname === '/components/shopping-category-manager.js' ||
    url.pathname === '/components/category-manager.js'
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
    data: { url: payload.url || '/reminders' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/reminders';
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
