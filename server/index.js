/**
 * Modul: Server Entry Point
 * Zweck: Express-App initialisieren, Middleware einbinden, Routen registrieren
 * Abhängigkeiten: express, helmet, server/db.js, server/auth.js, server/routes/*
 */

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { readFileSync } from 'node:fs';
import { createLogger } from './logger.js';
import * as db from './db.js';
import { router as authRouter, sessionMiddleware, requireAuth } from './auth.js';
import { csrfMiddleware } from './middleware/csrf.js';
import * as googleCalendar from './services/google-calendar.js';
import * as appleCalendar from './services/apple-calendar.js';
import * as icsSubscription from './services/ics-subscription.js';
import dashboardRouter from './routes/dashboard.js';
import tasksRouter from './routes/tasks.js';
import shoppingRouter from './routes/shopping.js';
import mealsRouter from './routes/meals.js';
import recipesRouter from './routes/recipes.js';
import calendarRouter from './routes/calendar.js';
import notesRouter from './routes/notes.js';
import contactsRouter from './routes/contacts.js';
import budgetRouter from './routes/budget.js';
import weatherRouter from './routes/weather.js';
import preferencesRouter from './routes/preferences.js';
import remindersRouter from './routes/reminders.js';
import searchRouter from './routes/search.js';

const log     = createLogger('Server');
const logSync = createLogger('Sync');
const logOikos = createLogger('Oikos');

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

const app  = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// Security-Middleware
// --------------------------------------------------------
const isSecure = process.env.SESSION_SECURE !== 'false';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        // Inline-Script: Theme-Detection (Flash-Prevention)
        "'sha256-vqqBNo1oitnzIntwkG83UaYqkUAnV/oZ/RkvcA41Y6A='",
        // Alpine.js CDN (optional, falls verwendet)
        'https://cdn.jsdelivr.net',
      ],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
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

// Trust Proxy: Default 1 = ersten Proxy-Hop vertrauen (korrekt für Caddy/nginx in Docker).
// Wird auf 'loopback' gesetzt wenn der Server direkt ohne Reverse-Proxy betrieben wird.
// Hintergrund: Bei Docker + Caddy/nginx kommt der Request von einer Bridge-IP (z.B. 172.x.x.x),
// nicht von loopback. Mit 'loopback' ignoriert Express das X-Forwarded-Proto-Header von Caddy,
// req.secure bleibt false, und express-session setzt keinen Session-Cookie (Login schlägt fehl).
app.set('trust proxy', process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : 1);

// --------------------------------------------------------
// Request-Parsing
// --------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// JSON-Parse-Fehler abfangen (gibt sonst HTML zurück)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Ungültiges JSON im Request-Body.', code: 400 });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request-Body zu groß (max. 1 MB).', code: 413 });
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

// --------------------------------------------------------
// Globaler API-Rate-Limiter (Schritt 29)
// Verhindert Brute-Force und DoS auf allen API-Endpunkten.
// Login hat einen eigenen, strengeren Limiter (auth.js).
// --------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60_000,         // 1 Minute
  max: 300,                 // 300 Requests/Minute pro IP (großzügig für Familien-App)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte kurz.', code: 429 },
  skip: (req) => req.path === '/health', // Health-Check ausgenommen
});
app.use('/api/', apiLimiter);

// --------------------------------------------------------
// API-Routen
// --------------------------------------------------------
app.use('/api/v1/auth', authRouter);

// Versionsinformation - keine Authentifizierung erforderlich (Login-Seite benötigt diese)
app.get('/api/v1/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// Alle weiteren API-Routen erfordern Authentifizierung + CSRF-Schutz
app.use('/api/v1', requireAuth);
app.use('/api/v1', csrfMiddleware);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/shopping', shoppingRouter);
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/budget', budgetRouter);
app.use('/api/v1/weather', weatherRouter);
app.use('/api/v1/preferences', preferencesRouter);
app.use('/api/v1/reminders', remindersRouter);
app.use('/api/v1/search', searchRouter);

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
  message: { error: 'Zu viele Anfragen. Bitte warte kurz.', code: 429 },
});

// --------------------------------------------------------
// SPA Fallback: Alle nicht-API-Routen → index.html
// --------------------------------------------------------
app.get('/{*path}', spaLimiter, (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Nicht gefunden.', code: 404 });
  }
  res.sendFile(path.join(import.meta.dirname, '..', 'public', 'index.html'));
});

// --------------------------------------------------------
// Globaler Error-Handler
// --------------------------------------------------------
app.use((err, req, res, _next) => {
  log.error('Unbehandelter Fehler:', err);
  res.status(500).json({ error: 'Interner Serverfehler.', code: 500 });
});

// --------------------------------------------------------
// Auto-Sync Scheduler (Google + Apple Calendar)
// --------------------------------------------------------

const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 15) * 60_000;

async function runSync() {
  const { connected: googleConnected } = googleCalendar.getStatus();
  if (googleConnected) {
    googleCalendar.sync().catch((e) => logSync.error('Google Fehler:', e.message));
  }

  const { configured: appleConfigured } = appleCalendar.getStatus();
  if (appleConfigured) {
    appleCalendar.sync().catch((e) => logSync.error('Apple Fehler:', e.message));
  }

  // ICS: kein Guard nötig — sync() fragt die DB ab und kehrt sofort zurück wenn keine Abonnements existieren
  icsSubscription.sync().catch((e) => logSync.error('ICS Fehler:', e.message));
}

// --------------------------------------------------------
// Server starten
// --------------------------------------------------------
app.listen(PORT, () => {
  logOikos.info(`Server laeuft auf Port ${PORT}`);
  logOikos.info(`Umgebung: ${process.env.NODE_ENV || 'development'}`);

  // Erster Sync nach 10 Sekunden (warten bis DB vollständig initialisiert)
  setTimeout(() => {
    runSync();
    setInterval(runSync, SYNC_INTERVAL_MS);
    logSync.info(`Auto-Sync alle ${SYNC_INTERVAL_MS / 60_000} Minuten aktiv.`);
  }, 10_000);
});

export default app;
