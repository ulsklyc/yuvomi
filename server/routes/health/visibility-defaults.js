/**
 * Modul: Gesundheit (Health) - persoenliche Sichtbarkeits-Voreinstellungen
 * Zweck: Was neue Eintraege eines Bereichs standardmaessig sind (privat oder
 *        familiensichtbar), pro Person gewaehlt - plus das Nachziehen der
 *        bereits vorhandenen Eintraege (#958).
 *
 * WARUM ES DAS GIBT: gemeldet war, den ausgelieferten Standard fuer Blutdruck
 * auf `family` zu drehen. Das waere eine Oeffnung gewesen, die niemand
 * ausgeloest hat - wer gelernt hat, dass Gesundheitswerte privat sind, haette
 * nach dem Update geteilt, ohne etwas zu tun. Der Zyklus-Tab hatte die richtige
 * Antwort schon (`cycle_settings.default_visibility` plus
 * `PATCH /cycle/visibility`): die PERSON entscheidet, und der ausgelieferte Wert
 * bleibt der engere. Diese Routen tragen dasselbe in die vier uebrigen Bereiche.
 *
 * SPARSE: gespeichert wird nur, was von `private` abweicht. Ein Konto ohne jede
 * Zeile verhaelt sich exakt wie vor Migration 172.
 *
 * Der Zyklus bleibt bewusst aussen vor - er hat seinen eigenen Schalter an
 * seinen eigenen Einstellungen, und zwei Orte fuer dieselbe Wahl waeren einer
 * zu viel.
 */

import express from 'express';
import * as db from '../../db.js';
import { FastingError, requireFastingCapability } from '../../services/fasting.js';
import { log, VISIBILITIES, viewerId, badRequest } from './helpers.js';

const router = express.Router();

// Die Bereiche ausserhalb der Vitalwerte. Je EINE Voreinstellung, weil jeder
// von ihnen eine Sorte Eintrag ist.
const FLAT_SCOPES = Object.freeze({
  meds:       { table: 'medications',        column: 'user_id' },
  labs:       { table: 'health_lab_reports', column: 'user_id' },
  activities: { table: 'health_activities',  column: 'user_id' },
  fasting:    { table: 'health_fasts',       column: 'user_id' },
  prevention: { table: 'health_prevention_records', column: 'user_id' },
});

// Vitalwerte tragen ihre Voreinstellung JE METRIK: wer den Blutdruck teilen
// will, teilt damit nicht die Stimmung. Der Metrikname wird nicht gegen eine
// Liste geprueft - der Server kennt sie nicht (`VITAL_METRICS` liegt in
// public/utils/health-vitals.js und importiert Browser-Pfade), und er prueft
// auch `health_vitals.type` beim Anlegen nicht gegen eine Liste. Ein
// unbekannter Name ergibt hier eine Zeile, die nie greift, und das ist der
// harmlose Ausgang.
const VITAL_PREFIX = 'vital:';
const VITAL_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Ist das ein Schluessel, den diese Tabelle fuehren darf? */
export function isValidScopeKey(key) {
  const s = String(key || '');
  if (s.startsWith(VITAL_PREFIX)) return VITAL_TYPE_PATTERN.test(s.slice(VITAL_PREFIX.length));
  return Object.prototype.hasOwnProperty.call(FLAT_SCOPES, s);
}

/**
 * Die Voreinstellung einer Person fuer einen Bereich.
 *
 * DER AUFRUFER IST DIE SCHREIBENDE ROUTE, und `userId` ist der EIGENTUEMER der
 * Zeile, nicht der Erfassende: traegt eine betreuende Person (#584) einen Wert
 * fuer jemanden ein, gilt die Wahl dessen, dem die Zeile gehoert.
 *
 * @returns {'private'|'family'}
 */
export function defaultVisibilityFor(database, userId, scopeKey) {
  if (!userId || !scopeKey) return 'private';
  try {
    const row = database.prepare(
      'SELECT visibility FROM health_visibility_defaults WHERE user_id = ? AND scope_key = ?'
    ).get(userId, scopeKey);
    return row?.visibility === 'family' ? 'family' : 'private';
  } catch (err) {
    // Ein Lesefehler darf das Anlegen nicht kosten, aber auch nicht still zu
    // 'family' werden: der engere Wert ist der sichere Ausgang.
    log.error('Reading the visibility default failed:', err.message);
    return 'private';
  }
}

/** Scope-Schluessel einer Vitalmetrik. Eine Schreibweise, ein Ort. */
export function vitalScopeKey(type) {
  return `${VITAL_PREFIX}${String(type || '')}`;
}

function allowFastingMutation(database, viewer, res, scopes) {
  if (!scopes.includes('fasting')) return true;
  try {
    requireFastingCapability(database, { id: viewer });
    return true;
  } catch (error) {
    if (!(error instanceof FastingError)) throw error;
    res.status(error.status).json({ error: error.message, code: error.status, reason: error.reason });
    return false;
  }
}

/**
 * GET /visibility-defaults
 * Response: { data: { defaults: { 'vital:bp': 'family', ... } } }
 * Nur die Abweichungen - was fehlt, ist 'private'.
 */
router.get('/visibility-defaults', (req, res) => {
  try {
    const rows = db.get().prepare(
      'SELECT scope_key, visibility FROM health_visibility_defaults WHERE user_id = ?'
    ).all(viewerId(req));
    const defaults = {};
    for (const r of rows) defaults[r.scope_key] = r.visibility;
    res.json({ data: { defaults } });
  } catch (err) {
    log.error('Error loading visibility defaults:', err.message);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PUT /visibility-defaults
 * Body: { defaults: { 'vital:bp': 'family', meds: 'private', ... } }
 *
 * Ersetzt die genannten Schluessel; ungenannte bleiben stehen. 'private'
 * loescht die Zeile, statt sie zu schreiben - so bleibt "keine Zeile" die
 * einzige Schreibweise fuer den Standard, und die Tabelle waechst nicht mit
 * Eintraegen, die nichts aussagen.
 */
router.put('/visibility-defaults', (req, res) => {
  try {
    const viewer = viewerId(req);
    const input = req.body?.defaults;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return badRequest(res, ['defaults must be an object.']);
    }
    const entries = Object.entries(input);
    for (const [key, visibility] of entries) {
      if (!isValidScopeKey(key)) return badRequest(res, [`Unknown scope: ${key}`]);
      if (!VISIBILITIES.includes(visibility)) return badRequest(res, [`Invalid visibility: ${visibility}`]);
    }
    const database = db.get();
    if (!allowFastingMutation(database, viewer, res, entries.map(([key]) => key))) return;
    const del = database.prepare('DELETE FROM health_visibility_defaults WHERE user_id = ? AND scope_key = ?');
    const set = database.prepare(`
      INSERT INTO health_visibility_defaults (user_id, scope_key, visibility)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, scope_key) DO UPDATE SET
        visibility = excluded.visibility,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);
    database.transaction(() => {
      for (const [key, visibility] of entries) {
        if (visibility === 'family') set.run(viewer, key, visibility);
        else del.run(viewer, key);
      }
    })();
    const rows = database.prepare(
      'SELECT scope_key, visibility FROM health_visibility_defaults WHERE user_id = ?'
    ).all(viewer);
    const defaults = {};
    for (const r of rows) defaults[r.scope_key] = r.visibility;
    res.json({ data: { defaults } });
  } catch (err) {
    log.error('Error saving visibility defaults:', err.message);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /visibility-defaults/apply
 * Body: { scope: 'vital:bp' | 'meds' | 'labs' | 'activities', visibility }
 * Response: { data: { updated: n } }
 *
 * Zieht die BEREITS vorhandenen eigenen Eintraege eines Bereichs nach. Das
 * Vorbild ist `PATCH /cycle/visibility`, und der Zielwert kommt wie dort aus
 * dem Request statt aus der gespeicherten Voreinstellung: 'private' wird sparse
 * gar nicht gespeichert, ein Nachziehen auf 'private' waere sonst unmoeglich.
 *
 * NUR EIGENE ZEILEN. Eine betreuende Person darf einzelne Werte pflegen, aber
 * nicht in einem Zug die Sichtbarkeit fremder Bestandsdaten umlegen - das ist
 * eine Entscheidung ueber die eigene Privatsphaere, keine Pflegehandlung.
 */
router.patch('/visibility-defaults/apply', (req, res) => {
  try {
    const viewer = viewerId(req);
    const scope = String(req.body?.scope || '');
    const visibility = req.body?.visibility;
    if (!isValidScopeKey(scope)) return badRequest(res, [`Unknown scope: ${scope}`]);
    if (!VISIBILITIES.includes(visibility)) return badRequest(res, ['visibility is required.']);

    const database = db.get();
    if (!allowFastingMutation(database, viewer, res, [scope])) return;
    let updated = 0;
    if (scope.startsWith(VITAL_PREFIX)) {
      updated = database.prepare(
        'UPDATE health_vitals SET visibility = ? WHERE user_id = ? AND type = ?'
      ).run(visibility, viewer, scope.slice(VITAL_PREFIX.length)).changes;
    } else if (scope === 'fasting') {
      // Privacy changes must invalidate an already-open fasting editor too.
      updated = database.prepare(
        'UPDATE health_fasts SET visibility = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE user_id = ?'
      ).run(visibility, viewer, new Date().toISOString(), viewer).changes;
    } else {
      const target = FLAT_SCOPES[scope];
      updated = database.prepare(
        `UPDATE ${target.table} SET visibility = ? WHERE ${target.column} = ?`
      ).run(visibility, viewer).changes;
    }
    res.json({ data: { updated: Number(updated) } });
  } catch (err) {
    log.error('Error applying visibility to existing entries:', err.message);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
