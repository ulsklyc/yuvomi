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
import { router as authRouter, sessionMiddleware, requireAuth, requireAdmin } from './auth.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { buildOpenApiSpec } from './openapi.js';
import * as googleCalendar from './services/google-calendar.js';
import * as appleCalendar from './services/apple-calendar.js';
import * as icsSubscription from './services/ics-subscription.js';
import * as caldavReminders from './services/caldav-reminders-sync.js';
import * as holidays from './services/holidays.js';
import { startScheduler as startBackupScheduler } from './services/backup-scheduler.js';
import { startScheduler as startSplitExpenseScheduler } from './services/split-expenses-scheduler.js';
import dashboardRouter from './routes/dashboard.js';
import tasksRouter from './routes/tasks.js';
import shoppingRouter from './routes/shopping.js';
import mealsRouter from './routes/meals.js';
import recipesRouter from './routes/recipes.js';
import calendarRouter from './routes/calendar.js';
import notesRouter from './routes/notes.js';
import contactsRouter from './routes/contacts.js';
import cardavRouter from './routes/cardav.js';
import birthdaysRouter from './routes/birthdays.js';
import budgetRouter from './routes/budget.js';
import documentsRouter from './routes/documents.js';
import splitExpensesRouter from './routes/split-expenses.js';
import weatherRouter from './routes/weather.js';
import preferencesRouter from './routes/preferences.js';
import remindersRouter from './routes/reminders.js';
import searchRouter from './routes/search.js';
import familyRouter from './routes/family.js';
import backupRouter from './routes/backup.js';
import housekeepingRouter from './routes/housekeeping.js';
import modulesRouter from './routes/modules.js';

const log     = createLogger('Server');
const logSync = createLogger('Sync');
const logYuvomi = createLogger('Yuvomi');

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);
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
app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: true, limit: '7mb' }));

// JSON-Parse-Fehler abfangen (gibt sonst HTML zurück)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body.', code: 400 });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large (max. 7 MB).', code: 413 });
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
// manifest.json + sw.js: no-cache (PWA-Updates sollen sofort greifen).
// --------------------------------------------------------
app.use(express.static(path.join(import.meta.dirname, '..', 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const isPwaIcon = /\/icons\/(icon-|apple-touch-icon|favicon)/.test(filePath);
    if (isPwaIcon) {
      // PWA-Icons müssen bei Deployments sofort aktualisiert werden
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (['.png', '.jpg', '.jpeg', '.ico', '.svg', '.webp', '.woff2', '.woff'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 Tage
    } else {
      // HTML, JS, CSS, JSON, manifest, sw - immer revalidieren
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // manifest.json: korrekter MIME-Type für PWA-Erkennung durch Chrome/Android
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
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
  return {
    ...(includeVersion ? { version: APP_VERSION } : {}),
    app_name: appName,
    setup_required: setupRequired,
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
    orientation: 'portrait-primary',
    theme_color: '#007AFF',
    background_color: '#F5F5F7',
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

// Alle weiteren API-Routen erfordern Authentifizierung + CSRF-Schutz
app.use('/api/v1', requireAuth);
app.use('/api/v1', (req, res, next) => {
  try {
    const guest = db.get().prepare('SELECT 1 FROM split_expense_guest_users WHERE user_id = ?').get(req.authUserId);
    if (!guest) return next();
    const allowed = req.path.startsWith('/split-expenses')
      || req.path === '/auth/me'
      || req.path === '/auth/logout'
      || req.path === '/version';
    if (allowed) return next();
    return res.status(403).json({ error: 'This account can only access Split expenses.', code: 403 });
  } catch {
    return res.status(403).json({ error: 'This account can only access Split expenses.', code: 403 });
  }
});
app.use('/api/v1', csrfMiddleware);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/shopping', shoppingRouter);
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/contacts/cardav', cardavRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
app.use('/api/v1/budget', budgetRouter);
app.use('/api/v1/documents', documentsRouter);
app.use('/api/v1/split-expenses', splitExpensesRouter);
app.use('/api/v1/weather', weatherRouter);
app.use('/api/v1/preferences', preferencesRouter);
app.use('/api/v1/reminders', remindersRouter);
app.use('/api/v1/search', searchRouter);
app.use('/api/v1/family', familyRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/housekeeping', housekeepingRouter);
app.use('/api/v1/modules', modulesRouter);

// --------------------------------------------------------
// Health-Check (für Docker)
// --------------------------------------------------------
app.get('/health', (req, res) => {
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
  res.sendFile(path.join(import.meta.dirname, '..', 'public', 'index.html'));
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

  // CalDAV Reminders (VTODO → Tasks/Shopping): kein Guard nötig — sync() kehrt sofort
  // zurück, wenn keine aktivierten Reminder-Listen konfiguriert sind.
  caldavReminders.sync().catch((e) => logSync.error('CalDAV reminders error:', e.message));

  // Holidays: kein Guard nötig — sync() kehrt sofort zurück, wenn kein Land konfiguriert ist.
  holidays.sync().catch((e) => logSync.error('Holidays error:', e.message));
}

// --------------------------------------------------------
// Server starten
// --------------------------------------------------------
app.listen(PORT, () => {
  logYuvomi.info(`Server running on port ${PORT} | Version ${APP_VERSION}`);
  logYuvomi.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Erster Sync nach 10 Sekunden (warten bis DB vollständig initialisiert)
  setTimeout(() => {
    runSync();
    setInterval(runSync, SYNC_INTERVAL_MS);
    logSync.info(`Auto-sync active every ${SYNC_INTERVAL_MS / 60_000} minutes.`);
  }, 10_000);

  // Backup-Scheduler starten
  startBackupScheduler();
  startSplitExpenseScheduler();
});

export default app;
