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
 */

import { createLogger } from '../../logger.js';
import * as db from '../../db.js';

export const log = createLogger('Health');

export const VISIBILITIES = ['private', 'family'];

/**
 * Der OFFENE Wert eines Bereichs - das Gegenstueck zu 'private'.
 *
 * Die Gesundheit schreibt seit jeher 'family'. Ein Bereich, der nach
 * docs/DECISIONS.md Abschnitt 5 neu dazukommt, nimmt den kanonischen Satz von
 * Anfang an und schreibt dort 'all'; Abschnitt 5 nennt das Lesen als die
 * Stelle, an der beide Schreibweisen zusammenkommen ("der Lesepfad bildet
 * `family` und `shared` auf `all` ab"), und genau das ist dieser Parameter.
 *
 * Er steht als Vorgabewert auf 'family', damit jede bestehende Aufrufstelle
 * unveraendert dasselbe SQL bekommt wie vorher - ein neuer Bereich muss den
 * Wert nennen, ein alter merkt nichts.
 */
export const OPEN_FAMILY = 'family';
export const OPEN_ALL    = 'all';
export const NUTRITION_VISIBILITIES = ['private', OPEN_ALL];

export const LOG_STATUS   = ['taken', 'skipped', 'pending'];
export const FLOW_LEVELS  = ['spotting', 'light', 'medium', 'heavy'];
export const MAX_UNIT     = 30;

export function viewerId(req) {
  return req.authUserId || req.session.userId;
}

// Betreute Personen als Subquery statt als aufgelöste ID-Liste: die Zahl der
// Platzhalter bliebe sonst von den Daten abhängig, und jede aufrufende Route
// müsste die Liste selbst beschaffen.
const CARED_FOR_SUBQUERY = 'SELECT subject_id FROM health_care_grants WHERE caregiver_id = ?';

/**
 * Baut eine WHERE-Teilbedingung für Sichtbarkeit/Personen-Filter: Eigentümer
 * oder `visibility = 'family'`. Betreuung spielt hier bewusst KEINE Rolle -
 * dafür gibt es `careAwareClause()`.
 *
 * Warum zwei Funktionen statt eines Flags: so steht an jeder Aufrufstelle
 * lesbar, welches Modell gilt, und wer die Wahl vergisst, landet auf der
 * engeren Variante statt versehentlich fremde Daten zu öffnen.
 *
 * @param {string} alias         - Tabellen-Alias mit user_id + visibility
 * @param {number} viewer        - eingeloggter Nutzer
 * @param {number|null} personId  - optionaler Personen-Filter (?user_id=)
 * @param {string} open          - der offene Wert dieses Bereichs (siehe OPEN_FAMILY)
 * @returns {{ sql: string, params: any[] }}
 */
export function visibilityClause(alias, viewer, personId, open = OPEN_FAMILY) {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    return { sql: `${alias}.user_id = ? AND ${alias}.visibility = ?`, params: [personId, open] };
  }
  return { sql: `(${alias}.user_id = ? OR ${alias}.visibility = ?)`, params: [viewer, open] };
}

/**
 * Wie `visibilityClause()`, zusätzlich mit den Daten betreuter Personen - auch
 * deren privaten (#584). Gilt für Vitalwerte, Medikamente, Laborbefunde,
 * Aktivitäten, Vorsorge und die Naehrwerte (#1326).
 *
 * `open` ist der Wert, den DIESE Tabelle fuer "der Haushalt darf mitlesen"
 * schreibt. Er wandert als Bind-Parameter ins SQL statt als eingebautes
 * 'family', weil die Naehrwert-Tabelle den kanonischen Satz fuehrt und dort
 * 'all' steht - ein fest verdrahtetes 'family' haette dort NIE getroffen, und
 * zwar lautlos: die Abfrage bliebe gueltig und lieferte einfach nichts.
 */
export function careAwareClause(alias, viewer, personId, open = OPEN_FAMILY) {
  if (personId) {
    if (personId === viewer) return { sql: `${alias}.user_id = ?`, params: [viewer] };
    // Betreute Person: volle Sicht wie der Eigentümer. Für alle anderen bleibt
    // es beim Familien-Filter.
    return {
      sql: `${alias}.user_id = ? AND (${alias}.visibility = ? OR ? IN (${CARED_FOR_SUBQUERY}))`,
      params: [personId, open, personId, viewer],
    };
  }
  return {
    sql: `(${alias}.user_id = ? OR ${alias}.visibility = ? OR ${alias}.user_id IN (${CARED_FOR_SUBQUERY}))`,
    params: [viewer, open, viewer],
  };
}

// --------------------------------------------------------
// Betreuung (#584)
// --------------------------------------------------------

/** IDs der Personen, für die `viewer` eintragen darf. Ohne Betreuung: []. */
export function caredForIds(viewer) {
  if (!viewer) return [];
  return db.get().prepare(CARED_FOR_SUBQUERY).all(viewer).map((r) => r.subject_id);
}

/**
 * Darf `viewer` Daten schreiben, die `ownerId` gehören? Wahr für die eigenen
 * Daten und für jede Person, deren Betreuung eingeräumt wurde.
 */
export function canWriteFor(viewer, ownerId) {
  if (!viewer || !ownerId) return false;
  if (viewer === ownerId) return true;
  return !!db.get().prepare(
    'SELECT 1 FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?'
  ).get(ownerId, viewer);
}

/**
 * WHERE-Fragment für Zeilen, die `viewer` ändern oder löschen darf: die eigenen
 * plus die jeder betreuten Person. Ersetzt das frühere `user_id = ?`.
 * @param {string} alias - Tabellen-Alias oder '' für unqualifizierte Spalten
 */
export function writableClause(alias, viewer) {
  const col = `${alias ? `${alias}.` : ''}user_id`;
  return {
    sql: `(${col} = ? OR ${col} IN (${CARED_FOR_SUBQUERY}))`,
    params: [viewer, viewer],
  };
}

/**
 * Lädt einen abhängigen Datensatz, wenn `viewer` dessen Eltern-Zeile ändern
 * darf; sonst null.
 *
 * Zeitpläne und Dosis-Einträge hängen am Medikament, Analyte am Befund: sie
 * haben keine eigene `user_id`, ihr Scoping ist immer das des Elternteils. Wer
 * das von Hand als `m.user_id = ?` schreibt, schneidet die Betreuung (#584)
 * still wieder weg - genau das war #884: anlegen ging, wegräumen nicht. Die
 * Regel steht deshalb hier und nicht in jeder Route erneut.
 *
 * @param {string} sql         - SELECT … JOIN … WHERE <kind>.id = ?  (ohne Scope)
 * @param {string} parentAlias - Alias der Eltern-Tabelle mit `user_id`
 * @param {number} id          - ID des abhängigen Datensatzes
 * @param {number} viewer      - eingeloggter Nutzer
 */
export function writableChild(sql, parentAlias, id, viewer) {
  const w = writableClause(parentAlias, viewer);
  return db.get().prepare(`${sql} AND ${w.sql}`).get(id, ...w.params) ?? null;
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
  if (!ownerId) return { error: 'Ungültige Person.', status: 400 };
  if (!canWriteFor(viewer, ownerId)) {
    // Bewusst 403 und nicht 404: dass es die Person gibt, weiß der Aufrufer aus
    // der Mitgliederliste ohnehin - verschleiert würde hier nichts, nur die
    // Ursache unklar gemacht.
    return { error: 'Keine Berechtigung, für diese Person einzutragen.', status: 403 };
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
