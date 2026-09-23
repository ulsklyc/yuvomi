/**
 * Modul: Schreibsperre waehrend eines Restores (#1431)
 * Zweck: Solange `restoreFromFile()` laeuft, beantwortet der Server jeden
 *        schreibenden Request mit 503 und `reason: 'restore_in_progress'` -
 *        einen zweiten Restore mit 409, bevor sein Upload gelesen wird.
 *
 * Der Restore kopiert das Backup, waehrend die bisherige Verbindung noch offen
 * ist. Ein Schreibzugriff in dieser Zeit meldete Erfolg, den das Schliessen
 * und der Tausch danach verwarfen (Codex-Befund in #1431). Die eigentliche
 * Sperre sitzt in server/db.js (`query_only` auf der Verbindung, faengt auch
 * Hintergrundjobs); diese Middleware sorgt dafuer, dass ein Request eine
 * verstaendliche Antwort bekommt statt eines Datenbankfehlers.
 *
 * Der zweite Restore wird HIER beantwortet und nicht erst in der Route: dort
 * kaeme er erst nach Sitzung (deren Verbindung in der Tauschphase fehlt - 500
 * statt 409) und nach `express.raw()`, das das ganze Backup hochlaedt, nur um
 * es abzulehnen (Codex-Befund in #1431). Deshalb haengt die Middleware in
 * server/index.js vor Body-Parsern und Sitzung.
 *
 * Frei von Seiteneffekten: der Zustand kommt als Funktion herein, damit der
 * Test das Modul ohne Datenbank laden kann.
 */

import {
  RESTORE_IN_PROGRESS_MESSAGE, RESTORE_IN_PROGRESS_REASON, RESTORE_WRITE_REFUSED_MESSAGE,
} from '../utils/restore-messages.js';
import { isRestoreRunning as restoreStateRunning, trackWriteRequest } from '../utils/restore-state.js';


const READING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const RESTORE_PATH = '/api/v1/backup/restore';

/**
 * Der Restore-Pfad so, wie Express ihn annimmt: ohne Beachtung von Gross- und
 * Kleinschreibung und mit oder ohne Schraegstrich am Ende (Review #1431).
 */
function isRestorePath(pathOnly) {
  return pathOnly.replace(/\/+$/, '').toLowerCase() === RESTORE_PATH;
}

/** Pfade, deren Antworten die Datenbank brauchen. Statische Dateien gehoeren nicht dazu. */
function needsDatabase(pathOnly) {
  return pathOnly.startsWith('/api/') || pathOnly === '/mcp' || pathOnly.startsWith('/mcp/')
    // ICS-Abos lesen Termine, das OpenAPI-Dokument prueft die Sitzung (Review #1431).
    || pathOnly.startsWith('/feed/') || pathOnly === '/openapi.json';
}

function refuse(res, status, error) {
  res.setHeader('Retry-After', '30');
  // Die Verbindung schliessen: der Rest eines Uploads soll nicht mehr kommen.
  res.setHeader('Connection', 'close');
  return res.status(status).json({ error, code: status, reason: RESTORE_IN_PROGRESS_REASON });
}

/**
 * @param {() => boolean} isRestoreRunning
 * @param {() => boolean} [isDatabaseOpen] waehrend eines Restores ist die
 *   Verbindung vom Schliessen bis zum Wiederoeffnen zu. Dann beantwortet das
 *   Gate auch LESENDE API-Anfragen mit 503, statt sie an einer fehlenden
 *   Verbindung mit 500 scheitern zu lassen (Review #1431).
 * @returns {import('express').RequestHandler}
 */
export function createRestoreWriteGate(isRestoreRunning, isDatabaseOpen = () => true) {
  return function restoreWriteGate(req, res, next) {
    if (!isRestoreRunning()) return next();
    const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
    // Ein zweiter Restore bekommt immer 409, auch bei geschlossener Verbindung:
    // die Antwort betrifft den laufenden Restore, nicht die Datenbank (Review #1431).
    if (isRestorePath(pathOnly) && !READING_METHODS.has(req.method)) {
      return refuse(res, 409, RESTORE_IN_PROGRESS_MESSAGE);
    }
    if (!isDatabaseOpen() && needsDatabase(pathOnly)) {
      return refuse(res, 503, RESTORE_WRITE_REFUSED_MESSAGE);
    }
    if (READING_METHODS.has(req.method)) return next();
    return refuse(res, 503, RESTORE_WRITE_REFUSED_MESSAGE);
  };
}

/**
 * Fuer lesende Routen, die trotzdem etwas in die Sitzung schreiben (OAuth- und
 * OIDC-Start legen dort ihren `state` ab): waehrend eines Restores kann der
 * Store nichts speichern, und ein Redirect ohne gespeicherten `state` endet
 * erst beim Anbieter-Callback - deshalb vorher 503 (Codex-Befund in #1431).
 * @type {import('express').RequestHandler}
 */
export function refuseWhileRestoring(_req, res, next) {
  if (!restoreStateRunning()) return next();
  return refuse(res, 503, RESTORE_WRITE_REFUSED_MESSAGE);
}

/**
 * Hinter `requireAuth`: eine zugelassene schreibende Anfrage mit fester
 * Identitaet festhalten, bis sie endet - ein Restore, der danach beginnt,
 * wartet sie ab (Codex-Befund in #1431). Erst hier und nicht im Gate: eine
 * unangemeldete Anfrage mit langsamem Koerper hielte sonst jeden Restore auf
 * (Review #1431). Hat ein Restore inzwischen begonnen - die Anfrage war vor ihm
 * am Gate, hat aber noch ihren Koerper gelesen -, wird sie abgewiesen: sie
 * schriebe sonst an ihm vorbei.
 * @type {import('express').RequestHandler}
 */
export function trackAdmittedWrite(req, res, next) {
  if (READING_METHODS.has(req.method)) return next();
  if (restoreStateRunning()) return refuse(res, 503, RESTORE_WRITE_REFUSED_MESSAGE);
  trackWriteRequest(res);
  return next();
}
