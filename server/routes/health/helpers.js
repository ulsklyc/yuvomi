/**
 * Modul: Gesundheit (Health) - geteilte Helfer
 * Zweck: Sichtbarkeits-/Scoping-Bausteine, Validierungs-/Update-Helfer sowie die
 *        CSV-Export-Bausteine, die von mehreren Cluster-Routern (vitals,
 *        medications, labs, activities, export, cycle) gemeinsam genutzt werden.
 *
 * Scoping/Visibility-Modell:
 *   - Jede Zeile gehört einem Nutzer (`user_id`, "Eigentümer").
 *   - Lesen: erlaubt für den Eigentümer ODER wenn `visibility = 'family'`.
 *   - Schreiben/Ändern/Löschen: der Eigentümer - oder eine Person, der ein Admin
 *     die Betreuung dieses Eigentümers eingeräumt hat (`health_care_grants`, #584).
 *     Betreuung schließt das Lesen der betreuten Person mit ein, auch der als
 *     `private` markierten Zeilen; ohne das wäre der eben eingetragene Fieberwert
 *     für die eintragende Person sofort unsichtbar.
 *   - Verschachtelte Entitäten (Schedules/Logs, Lab-Results) erben Scoping/Visibility
 *     von ihrem Eltern-Datensatz (Medikament bzw. Befund).
 *   - Der Zyklus-Tab ist von der Betreuung ausgenommen (siehe `cycle.js`).
 *
 * The rules themselves (visibility, care grants, writable rows) live in
 * server/authorize/care.ts since phase 2 B4; this file keeps the route helpers.
 */

import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { householdTimeZone, utcToWall } from '../../utils/timezone.js';
import { OPEN_ALL, canWriteFor } from '../../authorize/index.ts';

export const log = createLogger('Health');

// Value lists for input validation; the open values themselves are rules and come
// from server/authorize/care.ts.
export const VISIBILITIES = ['private', 'family'];
export const NUTRITION_VISIBILITIES = ['private', OPEN_ALL];

/**
 * Wie die Zeitstempel der Gesundheit geprueft werden (`measured_at`,
 * `performed_at`, `consumed_at`, `scheduled_at`, `taken_at`): sie sind
 * Wanduhrzeit des Haushalts. Ein Wert mit `Z` oder Offset wird dorthin
 * umgerechnet statt abgeschnitten (#1364) - `utcnow()` aus einer
 * Home-Assistant-Automation landete sonst um den Offset verschoben.
 * @returns {{ to: 'wall', zone: string }} Optionen fuer `datetime()`
 */
export function wallClockInput() {
  return { to: 'wall', zone: householdTimeZone(db.get()) };
}

/**
 * "Jetzt" in derselben Form: Wanduhrzeit des Haushalts, `YYYY-MM-DDTHH:MM`.
 * Fuer den Fall, dass eine Route den Zeitstempel selbst setzt - dort stand
 * `new Date().toISOString()`, der einzige UTC-Instant in einer Spalte, die
 * sonst nur Wanduhrzeit fuehrt (Export, Tagesschluessel).
 * @returns {string}
 */
export function wallClockNow() {
  const nowIso = new Date().toISOString();
  const wall = utcToWall(nowIso, householdTimeZone(db.get()));
  return wall ? `${wall.date}T${wall.time.slice(0, 5)}` : nowIso;
}

export const LOG_STATUS   = ['taken', 'skipped', 'pending'];
export const FLOW_LEVELS  = ['spotting', 'light', 'medium', 'heavy'];
export const MAX_UNIT     = 30;

export function viewerId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Eigentümer eines zu schreibenden Datensatzes aus dem Request.
 * Ohne `user_id` im Body bleibt es der eingeloggte Nutzer - die Route verhält
 * sich für alle Bestandsaufrufe also unverändert.
 *
 * @returns {{ ownerId: number }|{ error: string, status: number }}
 */
export function resolveOwner(req, viewer) {
  const raw = req.body?.user_id;
  if (raw === undefined || raw === null || raw === '') return { ownerId: viewer };

  const ownerId = parseInt(raw, 10);
  if (!ownerId) return { error: 'Invalid user_id.', status: 400 };
  if (!canWriteFor(db.get(), viewer, ownerId)) {
    // Bewusst 403 und nicht 404: dass es die Person gibt, weiß der Aufrufer aus
    // der Mitgliederliste ohnehin - verschleiert würde hier nichts, nur die
    // Ursache unklar gemacht.
    return { error: 'You cannot record entries for this person.', status: 403 };
  }
  return { ownerId };
}

/** Koerziert einen Boolean/0/1-Wert zu 0|1 oder undefined (= nicht gesetzt). */
export function toBit(val) {
  if (val === undefined || val === null || val === '') return undefined;
  if (val === true  || val === 1 || val === '1' || val === 'true')  return 1;
  if (val === false || val === 0 || val === '0' || val === 'false') return 0;
  return undefined;
}

/** Führt ein partielles UPDATE mit einer Whitelist bereits validierter Felder aus. */
export function applyUpdate(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.get().prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

/** Leitet ein Referenz-Flag (low/normal/high) ab, sofern nicht explizit gesetzt. */
export function deriveFlag(value, refLow, refHigh, provided) {
  if (provided) return provided;
  if (value === null || value === undefined) return null;
  if (refLow !== null && refLow !== undefined && value < refLow)  return 'low';
  if (refHigh !== null && refHigh !== undefined && value > refHigh) return 'high';
  if ((refLow !== null && refLow !== undefined) || (refHigh !== null && refHigh !== undefined)) return 'normal';
  return null;
}

export function badRequest(res, errors) {
  return res.status(400).json({ error: errors.join(' '), code: 400 });
}

/** Hängt die Analyt-Zeilen an einen Laborbefund an (geteilt von labs + export). */
export function attachResults(report) {
  if (!report) return report;
  report.results = db.get().prepare(
    'SELECT * FROM health_lab_results WHERE report_id = ? ORDER BY analyte COLLATE NOCASE ASC, id ASC'
  ).all(report.id);
  return report;
}

// --------------------------------------------------------
// CSV-Export-Bausteine (geteilt von export + cycle)
// --------------------------------------------------------

/** Baut den Dateinamen aus Bereich + optionalem Zeitraum. */
export function exportFilename(area, from, to) {
  const range = from && to ? `-${from}_${to}` : '';
  return `health-${area}${range}.csv`;
}

/** Sendet eine CSV-Nutzlast als Download (BOM für Excel). */
export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
}

/** Liest optionale from/to-Query als YYYY-MM-DD (nur wenn plausibel). */
export function exportRange(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
  return { from, to };
}
