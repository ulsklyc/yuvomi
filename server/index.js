/**
 * Modul: Server Entry Point
 * Zweck: Express-App initialisieren, Middleware einbinden, Routen registrieren
 * Abhängigkeiten: express, helmet, server/db.js, server/auth.js, server/routes/*
 */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { readFileSync } from 'node:fs';
import { createLogger } from './logger.js';
import * as db from './db.js';
import { router as authRouter, sessionMiddleware, requireAuth, requireAdmin, isPasswordLoginEnabled } from './auth.js';
import { csrfMiddleware } from './middleware/csrf.js';
import idempotencyMiddleware from './middleware/idempotency.js';
import { buildOpenApiSpec } from './openapi.js';
import * as googleCalendar from './services/google-calendar.js';
import * as appleCalendar from './services/apple-calendar.js';
import * as icsSubscription from './services/ics-subscription.js';
import * as icsExport from './services/ics-export.js';
import * as inventoryDeadlinesIcs from './services/inventory-deadlines-ics.js';
import * as cycleIcs from './services/cycle-ics.js';
import * as scheduleIcs from './services/schedule-ics.js';
import * as wasteIcs from './services/waste-ics.js';
import * as caldavReminders from './services/caldav-reminders-sync.js';
import * as caldavSync from './services/caldav-sync.js';
import * as outlookCalendar from './services/outlook-calendar.js';
import * as carddavSync from './services/cardav-sync.js';
import * as holidays from './services/holidays.js';
import { startScheduler as startBackupScheduler } from './services/backup-scheduler.js';
import { startScheduler as startSplitExpenseScheduler } from './services/split-expenses-scheduler.js';
import { startScheduler as startPushScheduler } from './services/push-scheduler.js';
import { startScheduler as startMedicationScheduler } from './services/medication-scheduler.js';
import { startScheduler as startRecipeProviderScheduler } from './services/recipe-provider-sync.js';
import { startWasteSourceScheduler } from './services/waste-source-scheduler.js';
import { emailService } from './services/email.js';
import { passwordLoginWarning, OIDC_PASSWORD_SENTINEL } from './services/oidc.js';
import dashboardRouter from './routes/dashboard.js';
import tasksRouter from './routes/tasks.js';
import shoppingRouter from './routes/shopping.js';
import mealsRouter from './routes/meals.js';
import recipesRouter from './routes/recipes.js';
import pantryRouter from './routes/pantry.js';
import inventoryRouter from './routes/inventory/index.js';
import kitchenRouter from './routes/kitchen.js';
import calendarRouter from './routes/calendar.js';
import notesRouter from './routes/notes.js';
import quickLinksRouter from './routes/quick-links.js';
import contactsRouter from './routes/contacts.js';
import cardavRouter from './routes/cardav.js';
import birthdaysRouter from './routes/birthdays.js';
import budgetRouter from './routes/budget.js';
import subscriptionsRouter from './routes/subscriptions.js';
import documentsRouter from './routes/documents.js';
import googleDriveStorageRouter from './routes/document-storage-google-drive.js';
import { checkLocalStorageMount } from './services/document-storage.js';
import dmsRouter from './routes/dms.js';
import recipeProvidersRouter from './routes/recipe-providers.js';
import splitExpensesRouter from './routes/split-expenses.js';
import weatherRouter from './routes/weather.js';
import preferencesRouter from './routes/preferences.js';
import screensaverRouter from './routes/screensaver.js';
import remindersRouter from './routes/reminders.js';
import searchRouter from './routes/search.js';
import familyRouter from './routes/family.js';
import backupRouter from './routes/backup.js';
import housekeepingRouter from './routes/housekeeping.js';
import wasteRouter from './routes/waste/index.js';
import modulesRouter from './routes/modules.js';
import { listModules } from './services/modules.js';
import pushRouter from './routes/push.js';
import emailRouter from './routes/email.js';
import notificationsRouter from './routes/notifications.js';
import healthRouter from './routes/health.js';
import rewardsRouter from './routes/rewards.js';
import permissionsRouter from './routes/permissions.js';
import changelogRouter from './routes/changelog.js';
import mcpRouter from './mcp/server.js';
import scheduleRouter from './routes/schedule.js';
import scheduleFeedRouter from './routes/schedule-feed.js';
import schedulePreferencesRouter from './routes/schedule-preferences.js';
import scheduleExtrasRouter from './routes/schedule-extras.js';
import { moduleForPath, requiredAccess, tokenAllows } from './scopes.js';
import { moduleAccessVerdict, MODULE_ACCESS_DENIED, MODULE_ACCESS_READ_ONLY } from './permissions.js';
import { BODY_LIMIT, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from './utils/upload-limit.js';
import { createServiceWorkerResponseLoader } from './utils/service-worker.js';

const log     = createLogger('Server');
const logSync = createLogger('Sync');
const logYuvomi = createLogger('Yuvomi');

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);
const SERVICE_WORKER_PATH = new URL('../public/sw.js', import.meta.url);
const SERVICE_WORKER_OPTIONS = {
  appVersion: APP_VERSION,
  buildRevision: process.env.APP_BUILD_REVISION,
};
const getServiceWorkerResponse = createServiceWorkerResponseLoader(
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_OPTIONS,
);

// Das prüft die Build-Revision schon beim Start und liefert in der Entwicklung
// nach einer sw.js-Änderung dennoch die neue Quelle ohne manuellen Neustart.
getServiceWorkerResponse();
const DEFAULT_APP_NAME = 'Yuvomi';

const app  = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// Security-Middleware
// --------------------------------------------------------
const isSecure = process.env.SESSION_SECURE === 'true';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'"],
      // upgrade-insecure-requests nur mit HTTPS aktivieren
      upgradeInsecureRequests: isSecure ? [] : null,
    },
  },
  // HSTS nur mit HTTPS aktivieren
  hsts: isSecure ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,
}));

// Trust Proxy: Default 1 = trust one proxy hop (correct for Caddy/nginx/Traefik in Docker).
// Env vars are always strings, so numeric values like "1" must be parsed as integers —
// Express treats a numeric hop count differently from an IP/subnet string.
// TRUST_PROXY=1            → trust 1 hop (default; reads X-Forwarded-For correctly)
// TRUST_PROXY=172.16.0.0/12 → trust only requests from that subnet
// TRUST_PROXY=loopback     → trust loopback only (direct, no proxy)
const _rawTrustProxy = process.env.TRUST_PROXY;
const _trustProxy = _rawTrustProxy === undefined
  ? 1
  : /^\d+$/.test(_rawTrustProxy) ? parseInt(_rawTrustProxy, 10) : _rawTrustProxy;
app.set('trust proxy', _trustProxy);

// --------------------------------------------------------
// Kompression (gzip/deflate)
// --------------------------------------------------------
app.use(compression());

// --------------------------------------------------------
// Request-Parsing
// --------------------------------------------------------
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// JSON-Parse-Fehler abfangen (gibt sonst HTML zurück)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body.', code: 400 });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Request body too large (max. ${MAX_UPLOAD_MB} MB per file).`, code: 413 });
  }
  next(err);
});

// --------------------------------------------------------
// Sessions
// --------------------------------------------------------
app.use(sessionMiddleware);

// --------------------------------------------------------
// API-Antworten: kein Browser-Caching (Sicherheit + Aktualität)
// --------------------------------------------------------
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// --------------------------------------------------------
// Globaler API-Rate-Limiter (Schritt 29)
// Verhindert Brute-Force und DoS auf allen API-Endpunkten.
// Login hat einen eigenen, strengeren Limiter (auth.js).
// Früh definiert, damit auch die nicht unter /api/ liegenden Admin-Routen
// (/docs, /openapi.json) ihn als Route-Middleware nutzen können.
// --------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60_000,         // 1 Minute
  max: 300,                 // 300 Requests/Minute pro IP (großzügig für Familien-App)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.', code: 429 },
  skip: (req) => req.path === '/health', // Health-Check ausgenommen
});

if (process.env.NODE_ENV === 'production' && process.env.ENABLE_API_DOCS !== 'true') {
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.status(404).json({ error: 'Not found.', code: 404 });
  });
} else {
  app.get(['/docs', '/docs/'], apiLimiter, requireAuth, requireAdmin, (_req, res) => {
    res.type('text/plain').send('OpenAPI JSON is available to admins at /api/v1/openapi.json');
  });
}

// --------------------------------------------------------
// Statische Dateien (Frontend) - differenzierte Caching-Strategie
//
// HTML + JS + CSS: no-cache (Browser revalidiert via ETag/304, kein stale Content
//   nach Deployment). Bei unverändertem File → 304 Not Modified ohne Übertragung.
// Bilder + Icons + Fonts: 30 Tage immutable (ändern sich praktisch nie).
// manifest.json: no-cache (PWA-Updates sollen sofort greifen).
// /sw.js wird direkt darunter als no-store-Antwort gerendert.
// --------------------------------------------------------
app.get('/sw.js', (_req, res) => {
  const response = getServiceWorkerResponse();
  res.type(response.contentType);
  res.setHeader('Cache-Control', response.cacheControl);
  res.setHeader('CDN-Cache-Control', response.cdnCacheControl);
  res.setHeader('Cloudflare-CDN-Cache-Control', response.cloudflareCdnCacheControl);
  res.send(response.body);
});

app.use(express.static(path.join(import.meta.dirname, '..', 'public'), {
  etag: true,
  lastModified: true,
  // Kein automatischer Trailing-Slash-Redirect für Verzeichnisse (z. B. /settings →
  // /settings/), sonst kollidiert das public/settings/-Verzeichnis mit der SPA-Route
  // /settings und der Client-Router landet beim Hard-Load auf dem Dashboard.
  redirect: false,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const isPwaIcon = /\/icons\/(icon-|apple-touch-icon|favicon)/.test(filePath);
    if (isPwaIcon) {
      // PWA-Icons müssen bei Deployments sofort aktualisiert werden
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (['.png', '.jpg', '.jpeg', '.ico', '.svg', '.webp', '.woff2', '.woff'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 Tage
    } else {
      // HTML, JS, CSS, JSON und manifest immer revalidieren.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // manifest.json: korrekter MIME-Type für PWA-Erkennung durch Chrome/Android
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
    // .mjs (z. B. gevendorte pdf.js-Module + Worker) müssen als JS-Modul ausgeliefert
    // werden; nicht jede `send`-Version mappt die Endung, sonst schlägt der Modul-Import fehl.
    if (ext === '.mjs') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    }
  },
}));

// Globaler API-Rate-Limiter auf alle /api/-Endpunkte (Definition siehe oben).
app.use('/api/', apiLimiter);

// --------------------------------------------------------
// API-Routen
// --------------------------------------------------------
app.use('/api/v1/auth', authRouter);

function buildVersionPayload(includeVersion = false) {
  let appName = DEFAULT_APP_NAME;
  let setupRequired = false;
  try {
    const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get('app_name');
    if (row?.value) appName = row.value;
  } catch {
    // fall back to default
  }
  try {
    const { count } = db.get().prepare('SELECT COUNT(*) AS count FROM users').get();
    setupRequired = count === 0;
  } catch {
    // Fail-safe: bei DB-Fehler kein Setup erzwingen
    setupRequired = false;
  }
  // Password reset can only deliver when SMTP is configured AND an explicit
  // BASE_URL origin is set (the request Host is deliberately not trusted, to
  // prevent reset poisoning). Expose the capability so the login page can gate
  // the "forgot password" affordance instead of offering a dead end.
  // Mit abgeschalteter eingebauter Anmeldung fuehrt der Reset ins Leere: es gibt
  // kein Passwort mehr, das er zuruecksetzen koennte (#847). Der Link darf dann
  // gar nicht erst erscheinen - die Routen weisen ihn ohnehin ab.
  let passwordResetEnabled = false;
  try {
    // Drei Bedingungen, und die dritte ist neu: sind ALLE Konten auf SSO
    // umgestellt, gibt es kein Passwort mehr, das ein Reset zuruecksetzen
    // koennte - der Link waere eine Sackgasse, obwohl SMTP steht. Die Abfrage
    // haelt bei der ersten Zeile an.
    const hasResettable = !!db.get()
      .prepare('SELECT 1 FROM users WHERE password_hash != ? LIMIT 1').get(OIDC_PASSWORD_SENTINEL);
    passwordResetEnabled = isPasswordLoginEnabled()
      && hasResettable
      && emailService.isConfigured()
      && Boolean(String(process.env.BASE_URL || '').trim());
  } catch {
    passwordResetEnabled = false;
  }
  return {
    ...(includeVersion ? { version: APP_VERSION } : {}),
    app_name: appName,
    setup_required: setupRequired,
    password_reset_enabled: passwordResetEnabled,
    // Nur für Angemeldete: die Oberfläche muss dieselbe Obergrenze nennen und
    // prüfen, die der Server annimmt (#806). Vor der Anmeldung gibt es nichts
    // hochzuladen, also auch keinen Grund, die Konfiguration zu verraten.
    ...(includeVersion ? { max_upload_bytes: MAX_UPLOAD_BYTES } : {}),
  };
}

// Public bootstrap metadata for login/setup. The exact app version is returned only
// when a valid session or API token is present.
app.get('/api/v1/version', (req, res) => {
  const hasAuthCredential = Boolean(
    req.session?.userId
      || req.headers.authorization
      || req.headers['x-api-key']
  );
  if (!hasAuthCredential) {
    return res.json(buildVersionPayload(false));
  }
  return requireAuth(req, res, () => res.json(buildVersionPayload(true)));
});

app.get('/manifest.webmanifest', apiLimiter, (req, res) => {
  let appName = DEFAULT_APP_NAME;
  try {
    const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get('app_name');
    if (row?.value) appName = row.value;
  } catch {
    // fall back to default
  }

  res.type('application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.json({
    name: `${appName} Familienplaner`,
    short_name: appName,
    description: 'Selbstgehosteter Familienplaner',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    // Kein `orientation`: der Schluessel ist eine Sperre, keine Bevorzugung.
    // Auf einem Tablet zwang `portrait-primary` die installierte App in den
    // schmalen Hochkant-Streifen, obwohl das Layout bis 1024px+ reicht (#890).
    // Ohne den Schluessel folgt die App der Geraeteorientierung - und der
    // Systemsperre, die der Nutzer gesetzt hat. Ein ausdrueckliches 'any' waere
    // wieder eine Ansage und nicht dasselbe.
    // theme_color/background_color muessen mit public/manifest.json und den
    // theme-color-Metas in index.html zusammenbleiben: der App-Grund
    // (#F5F3ED = --neutral-100, warmes Papier).
    theme_color: '#F5F3ED',
    background_color: '#F5F3ED',
    lang: 'de-DE',
    categories: ['productivity', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    screenshots: [],
  });
});

function sendOpenApi(req, res) {
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="openapi.json"');
  }
  res.json(buildOpenApiSpec(req, APP_VERSION));
}

app.get('/api/v1/openapi.json', requireAuth, requireAdmin, sendOpenApi);
// /openapi.json liegt außerhalb von /api/, daher Rate-Limiter explizit als Route-Middleware.
app.get('/openapi.json', apiLimiter, requireAuth, requireAdmin, sendOpenApi);

// --------------------------------------------------------
// Öffentlicher read-only ICS-Feed (Discussion #387)
// Außerhalb /api/v1: keine Session/CSRF — Token in URL ist das Geheimnis.
// --------------------------------------------------------
const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/feed/calendar/:token.ics', feedLimiter, (req, res) => {
  try {
    const userId = icsExport.findUserIdByFeedToken(db.get(), req.params.token);
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const ics = icsExport.buildFeed(db.get(), userId);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="yuvomi.ics"');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    log.error('', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// Eigenständiger Feed für Inventar-Garantiefristen (Stufe 4) - getrennt vom
// Haushaltskalender-Feed oben, siehe server/services/inventory-deadlines-ics.js.
app.get('/feed/inventory-deadlines/:token.ics', feedLimiter, (req, res) => {
  try {
    // Auflösen statt nur prüfen, wie beim Kalender-Feed oben: das Token gehört
    // einem Nutzer, damit es einzeln zurückziehbar ist. In den Feed-Inhalt geht
    // die Id nicht ein - Inventar ist Haushaltseigentum ohne Sichtbarkeitsachse.
    const userId = inventoryDeadlinesIcs.findUserIdByFeedToken(db.get(), req.params.token);
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const ics = inventoryDeadlinesIcs.buildInventoryDeadlinesFeed(db.get());
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="yuvomi-inventory-deadlines.ics"');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    log.error('', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// Vorhergesagter Zyklus-Feed (Phase 5, Health) - anders als der Inventar-Feed
// oben ist der INHALT hier schon personengebunden (cycle_periods.user_id),
// nicht nur das Token; siehe server/services/cycle-ics.js.
//
// BEWUSST UNGEGATET GEGEN DEN ZYKLUS-TAB/HEALTH-MODUL: server/services/
// cycle-reminders.js stellt den Erinnerungs-Sync ein, sobald das Health-Modul
// 'none' ist oder der Zyklus-Tab gesperrt wurde (Haushalt oder persönlich,
// healthCycleViews()) - dieser Feed lässt sich davon nicht abschalten. Kein
// Leck: der Inhalt bleibt der des Token-Besitzers selbst, kein Dritter sieht
// je etwas Fremdes. Gleiche Lücke wie beim Inventar-Feed oben, dieselbe
// Antwort - ein bestehendes Abo (Kalender-App auf einem anderen Gerät) soll
// nicht stillschweigend leerlaufen, nur weil die Ansicht in der App gerade
// gesperrt ist; Abschalten bleibt "Feed deaktivieren" in den Einstellungen.
app.get('/feed/cycle/:token.ics', feedLimiter, (req, res) => {
  try {
    const userId = cycleIcs.findUserIdByFeedToken(db.get(), req.params.token);
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const ics = cycleIcs.buildCycleFeed(db.get(), userId);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="yuvomi-cycle.ics"');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    log.error('', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// Eigenständiger Feed für den persönlichen Schichtplan (Schedule v3) - anders
// als beim Inventar-Feed steckt hier die Nutzer-Id auch im Inhalt: gefeedet
// werden NUR die eigenen aufgelösten Einträge dieses Tokens, siehe
// server/services/schedule-ics.js.
app.get('/feed/schedule/:token.ics', feedLimiter, (req, res) => {
  try {
    const userId = scheduleIcs.findUserIdByFeedToken(db.get(), req.params.token);
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const ics = scheduleIcs.buildScheduleFeed(db.get(), userId);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="yuvomi-schedule.ics"');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    log.error('', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// Eigenständiger Feed für Abfuhrtermine (Waste, Stufe 10) - anders als beim
// Schichtplan-Feed oben steckt hier keine Nutzer-Id im INHALT (Abfuhrtermine
// sind Haushaltseigentum ohne Sichtbarkeitsachse, wie beim Inventar-Feed);
// nur das optionale Typ-Filter je Nutzer, siehe server/services/waste-ics.js.
app.get('/feed/waste/:token.ics', feedLimiter, (req, res) => {
  try {
    const userId = wasteIcs.findUserIdByFeedToken(db.get(), req.params.token);
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const ics = wasteIcs.buildWasteFeed(db.get(), userId);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="yuvomi-waste.ics"');
    res.type('text/calendar; charset=utf-8').send(ics);
  } catch (err) {
    log.error('', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// MCP-Endpoint (Streamable HTTP, stateless): Auth über bestehende Bearer-API-Tokens.
// Eigener Namespace außerhalb von /api/v1 → kein CSRF, kein Guest-Guard.
app.use('/mcp', apiLimiter, requireAuth, mcpRouter);

// Alle weiteren API-Routen erfordern Authentifizierung + CSRF-Schutz
app.use('/api/v1', requireAuth);
// System-Metadaten: authentifiziert, aber bewusst vor Guest-/Token-Scope-Gates
// wie /version behandelt. Keine Haushaltsdaten, nur upstream Release Notes.
app.use('/api/v1/changelog', changelogRouter);
app.use('/api/v1', (req, res, next) => {
  try {
    const guest = db.get().prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(req.authUserId);
    if (!guest) return next();
    const allowed = req.path.startsWith('/split-expenses')
      || req.path === '/auth/me'
      || req.path === '/auth/logout'
      || req.path === '/version';
    if (allowed) return next();
    return res.status(403).json({ error: 'This account can only access Shared expenses.', code: 403 });
  } catch {
    return res.status(403).json({ error: 'This account can only access Shared expenses.', code: 403 });
  }
});
// Token-Scopes: Nur für Token-Auth relevant. Ein gescoptes Token (scopes !== null)
// darf ein Modul nur in der gewährten Zugriffsart (read/write) erreichen; jeder
// nicht abgedeckte /api/v1-Pfad wird verweigert (Least Privilege). Deckt damit
// zugleich die MCP-OpenAPI-Brücke ab, da diese per Loopback mit demselben Token
// hier durchläuft.
app.use('/api/v1', (req, res, next) => {
  if (req.authMethod !== 'api_token' || req.authScopes == null) return next();
  const moduleKey = moduleForPath(req.path);
  const access = requiredAccess(req.method);
  if (tokenAllows(req.authScopes, moduleKey, access)) return next();
  return res.status(403).json({ error: 'Token scope does not permit this operation.', code: 403 });
});
// Rollen-/Mitglied-Rechte: Für eingeschränkte Mitglieds-Sessions (#467). Anders
// als Token-Scopes ist dies eine DENY-Liste — nur konfigurierte Module werden
// gesperrt, jeder unbekannte Pfad (/auth, /preferences, /settings-Daten …) bleibt
// erreichbar, damit die App bedienbar bleibt. Admins haben sessionModuleAccess
// === null (Bypass), ebenso unbeschränkte Mitglieder (Fast-Path).
app.use('/api/v1', (req, res, next) => {
  // Die Regel selbst steht in permissions.js — dieselbe Funktion prüft den
  // MCP-Endpoint (#823), damit beide Oberflächen nicht auseinanderlaufen.
  //
  // AUSNAHME /schedule/preferences (S-12, UX-Audit): der Vorlauf/die
  // Wochenstunden hängen an der EIGENEN users-Zeile (siehe
  // routes/schedule-preferences.js' eigener Kommentar, "keine Admin-Gate") -
  // ein Mitglied mit `schedule: read` darf nur FREMDE Schichtplan-Daten nicht
  // schreiben, seine eigene Erinnerungsvorlaufzeit ist keine davon. `null`
  // statt des sonstigen Modulschlüssels zwingt moduleAccessVerdict() auf
  // "erlaubt" (dieselbe Deny-Listen-Regel, unter der jeder NICHT gelistete
  // Pfad ohnehin durchgeht) - ausdrücklich nur für diesen Session-Pfad, die
  // API-Token-Scope-Prüfung oben bleibt unveraendert an `schedule:write`
  // gebunden.
  const scopedModuleKey = req.path.startsWith('/schedule/preferences') ? null : moduleForPath(req.path);
  const verdict = moduleAccessVerdict(
    req.sessionModuleAccess,
    scopedModuleKey,
    requiredAccess(req.method),
  );
  if (verdict === MODULE_ACCESS_DENIED) {
    return res.status(403).json({ error: 'You do not have access to this module.', code: 403 });
  }
  if (verdict === MODULE_ACCESS_READ_ONLY) {
    return res.status(403).json({ error: 'You have read-only access to this module.', code: 403 });
  }
  return next();
});
app.use('/api/v1', csrfMiddleware);
// Retry-Sicherheit für schreibende Aufrufer (#822): greift nur, wenn ein
// `Idempotency-Key` mitkommt, und liegt hinter Auth, Scopes und CSRF - ein
// abgewiesener Aufruf darf keinen Schlüssel verbrauchen.
app.use('/api/v1', idempotencyMiddleware);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/shopping', shoppingRouter);
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/recipe-providers', recipeProvidersRouter);
app.use('/api/v1/pantry', pantryRouter);
app.use('/api/v1/inventory', inventoryRouter);
// Kreislauf-Zustand der vier Küchen-Tabs in einer Abfrage (utils/kitchen-tabs.js).
app.use('/api/v1/kitchen', kitchenRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/quick-links', quickLinksRouter);
app.use('/api/v1/contacts/cardav', cardavRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
app.use('/api/v1/budget/subscriptions', subscriptionsRouter);
app.use('/api/v1/budget', budgetRouter);
app.use('/api/v1/documents/storage/google-drive', googleDriveStorageRouter);
app.use('/api/v1/documents/dms', dmsRouter);
app.use('/api/v1/documents', documentsRouter);
app.use('/api/v1/split-expenses', splitExpensesRouter);
app.use('/api/v1/weather', weatherRouter);
app.use('/api/v1/preferences', preferencesRouter);
app.use('/api/v1/screensaver', screensaverRouter);
app.use('/api/v1/reminders', remindersRouter);
app.use('/api/v1/search', searchRouter);
app.use('/api/v1/family', familyRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/housekeeping', housekeepingRouter);
app.use('/api/v1/waste', wasteRouter);
app.use('/api/v1/modules', modulesRouter);
app.use('/api/v1/push', pushRouter);
app.use('/api/v1/email', emailRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/rewards', rewardsRouter);
// The specific /schedule/* prefixes must mount before the general /schedule
// router: schedule.js has no first-segment param route today, so a request
// like /schedule/feed still falls through to the right router either way -
// but that only holds by accident, and breaks silently (no error, just a 404)
// the day someone adds a router.get('/:id') to schedule.js.
app.use('/api/v1/schedule/feed', scheduleFeedRouter);
app.use('/api/v1/schedule/preferences', schedulePreferencesRouter);
app.use('/api/v1/schedule/extras', scheduleExtrasRouter);
app.use('/api/v1/schedule', scheduleRouter);
app.use('/api/v1/permissions', permissionsRouter);

// --------------------------------------------------------
// Health-Check (für Docker)
// --------------------------------------------------------
app.get('/health', (req, res, next) => {
  // Browser-Navigation (Deep-Link/Reload/Bookmark auf den Gesundheit-Übersicht-Tab,
  // Client-Route ebenfalls /health) erwartet die SPA, nicht den JSON-Healthcheck.
  // Docker/Monitoring senden Accept: */* (ohne text/html) und bekommen weiter JSON,
  // damit der Container-Healthcheck nicht mit der SPA-Wurzelroute kollidiert.
  if (req.headers.accept && req.headers.accept.includes('text/html')) return next();
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --------------------------------------------------------
// Rate-Limiter für SPA-Fallback (verhindert Dateisystem-Hammering)
// --------------------------------------------------------
const spaLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.', code: 429 },
});

// --------------------------------------------------------
// SPA Fallback: Alle nicht-API-Routen → index.html
// --------------------------------------------------------
app.get('/{*path}', spaLimiter, (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found.', code: 404 });
  }
  // root-Option statt absolutem Pfad: sendFile ohne root laesst `send` JEDES
  // Segment des absoluten Pfads auf Dotfiles pruefen - liegt der Checkout unter
  // einem Dot-Verzeichnis (z. B. ~/.claude/...), liefert jede Deep-URL 500.
  // Mit root prueft `send` nur den relativen Teil ('index.html').
  res.sendFile('index.html', { root: path.join(import.meta.dirname, '..', 'public') });
});

// --------------------------------------------------------
// Globaler Error-Handler
// --------------------------------------------------------
app.use((err, req, res, _next) => {
  log.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.', code: 500 });
});

// --------------------------------------------------------
// Auto-Sync Scheduler (Google + Apple Calendar)
// --------------------------------------------------------

const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 15) * 60_000;

async function runSync() {
  const { connected: googleConnected } = googleCalendar.getStatus();
  if (googleConnected) {
    googleCalendar.sync().catch((e) => logSync.error('Google error:', e.message));
  }

  const { configured: appleConfigured } = appleCalendar.getStatus();
  if (appleConfigured) {
    appleCalendar.sync().catch((e) => logSync.error('Apple error:', e.message));
  }

  // ICS: kein Guard nötig — sync() fragt die DB ab und kehrt sofort zurück wenn keine Abonnements existieren
  icsSubscription.sync().catch((e) => logSync.error('ICS error:', e.message));

  // CalDAV Kalender (VEVENT): kein Guard nötig — sync() kehrt sofort zurück, wenn
  // keine Accounts konfiguriert sind.
  caldavSync.sync().catch((e) => logSync.error('CalDAV error:', e.message));

  // CalDAV Reminders (VTODO → Tasks/Shopping): kein Guard nötig — sync() kehrt sofort
  // zurück, wenn keine aktivierten Reminder-Listen konfiguriert sind.
  caldavReminders.sync().catch((e) => logSync.error('CalDAV reminders error:', e.message));

  // Outlook-Push (Microsoft Graph, one-way): kein Guard nötig — sync() kehrt sofort
  // zurück, wenn keine Konten verbunden sind.
  outlookCalendar.sync().catch((e) => logSync.error('Outlook error:', e.message));

  // CardDAV Kontakte: kein Guard nötig — sync() kehrt sofort zurück, wenn keine
  // Accounts konfiguriert sind.
  carddavSync.sync().catch((e) => logSync.error('CardDAV error:', e.message));

  // Holidays: kein Guard nötig — sync() kehrt sofort zurück, wenn kein Land konfiguriert ist.
  holidays.sync().catch((e) => logSync.error('Holidays error:', e.message));
}

// --------------------------------------------------------
// Server starten
// --------------------------------------------------------
// Scan the extension catalog before the socket accepts requests. resolvePermissions
// drops unknown ext:* rows, and moduleAccessVerdict is a deny-list — a missing
// key means allow. Starting the scan inside the listen callback left that window
// open until the first GET /api/v1/modules (or /permissions/catalog).
try {
  await listModules({ admin: true });
} catch (err) {
  log.warn('Initial module registry scan failed:', err.message);
}

const server = app.listen(PORT, () => {
  // Der gebundene Port statt der Wunschangabe: mit PORT=0 vergibt der Kernel
  // einen freien Port, und genau der gehoert ins Log. Fuer den Regelfall
  // (PORT=3000) steht dort weiterhin wortgleich dieselbe Zeile.
  logYuvomi.info(`Server running on port ${server.address()?.port ?? PORT} | Version ${APP_VERSION}`);
  logYuvomi.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Ein Sicherheitsschalter, der still nicht greift, ist schlimmer als keiner:
  // der Betreiber glaubt, das Anmeldeformular sei zu (#847). Beide Fail-open-
  // Zustaende melden sich, auch der erwartete einer frischen Installation.
  let linkedSso = true;
  try {
    linkedSso = !!db.get()
      .prepare("SELECT 1 FROM users WHERE oidc_sub IS NOT NULL AND role = 'admin' LIMIT 1").get();
  } catch { /* ohne Antwort lieber keine falsche Entwarnung */ }
  const loginWarning = passwordLoginWarning({ hasLinkedSsoAccount: linkedSso });
  if (loginWarning) logYuvomi.warn(loginWarning);

  // Erster Sync nach 10 Sekunden (warten bis DB vollständig initialisiert)
  //
  // `unref()` wie bei den uebrigen Schedulern (push, medication,
  // recipe-provider, split-expenses): den Prozess am Leben haelt der
  // Server-Socket, nicht der Sync-Takt. Ohne das blieben nach `server.close()`
  // zwei Timer offen - und Suiten, die server/index.js als Programm
  // importieren, muessten den Prozess mit `process.exit(0)` erschlagen, was
  // den Exit-Code von node:test ueberschreibt (siehe test/server-ready.js).
  setTimeout(() => {
    runSync();
    setInterval(runSync, SYNC_INTERVAL_MS).unref();
    logSync.info(`Auto-sync active every ${SYNC_INTERVAL_MS / 60_000} minutes.`);
  }, 10_000).unref();

  // Ein fehlender Mount fuer die lokale Dokumentablage faellt sonst erst auf,
  // wenn die Dateien nach einem Update verschwunden sind (#751).
  checkLocalStorageMount(createLogger('DocumentStorage'))
    .catch((err) => log.error('Document storage check failed:', err.message));

  // Backup-Scheduler starten
  startBackupScheduler();
  startSplitExpenseScheduler();
  startPushScheduler();
  startMedicationScheduler();
  startRecipeProviderScheduler();
  startWasteSourceScheduler();
});

export default app;

// Der laufende HTTP-Server. Tests, die diese Datei als Programm importieren,
// brauchen ein Handle zum Schliessen - sonst haelt der Socket den Prozess
// offen und node:test kommt nie zu seinem Exit-Code.
export { server };
