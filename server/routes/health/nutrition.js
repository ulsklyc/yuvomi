/**
 * Modul: Gesundheit (Health) - Naehrwerte: Tagesziel und erfasste Mahlzeiten
 * Zweck: REST-API fuer das Tagesziel je Person (health_nutrition_targets),
 *        das Tagebuch (health_nutrition_entries) und die Tagesbilanz daraus.
 *
 * ENTGEGENGENOMMEN, NICHT GERECHNET (docs/DECISIONS.md Abschnitt 8). Was eine
 * Person ueber ihre eigene Mahlzeit angibt, sind ihre Daten; aus Zutaten
 * abgeleitete Naehrwerte bleiben abgelehnt (#714), weil die dazu noetige
 * Tabelle von Produkt-Fakten nur so lange etwas taugt, wie sie jemand pflegt.
 * Diese Routen nehmen deshalb acht Zahlen entgegen und rechnen nur eines: die
 * Summe dessen, was schon dasteht.
 *
 * Sichtbarkeit/Betreuung folgen dem Muster von prevention.js - `helpers.js` ist
 * die einzige Stelle, an der die Klausel gebaut werden darf (#884). Der
 * Unterschied zu allen aelteren Bereichen ist das Vokabular: diese Tabelle
 * fuehrt `private` und `all`, den kanonischen Satz aus Abschnitt 5, und nicht
 * das Paar private/family der uebrigen Gesundheit.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { todayKey } from '../../utils/timezone.js';
import { defaultVisibilityFor } from './visibility-defaults.js';
import {
  NUTRIENT_KEYS, MEAL_TYPES, nutritionTargetFor, nutritionSummaryFor,
} from '../../services/health-nutrition.js';
import {
  log, NUTRITION_VISIBILITIES, OPEN_ALL,
  viewerId, careAwareClause, applyUpdate, badRequest,
  resolveOwner, writableClause, canWriteFor, wallClockInput,
} from './helpers.js';

const router = express.Router();

// Eine Obergrenze je Wert, damit ein Tippfehler nicht als Zahl durchgeht, die
// jede Fortschrittsanzeige sprengt. 100000 kcal und 100000 g sind fuer eine
// EINZELNE Mahlzeit so weit jenseits, dass niemand sie versehentlich trifft -
// die Grenze ist gegen den verrutschten Dezimalpunkt gerichtet, nicht gegen
// eine ungewoehnliche Ernaehrung.
const MAX_NUTRIENT = 100000;

/**
 * Ein Naehrwert: Zahl >= 0, oder ausdruecklich NULL ("nicht angegeben").
 *
 * `null` und `0` bleiben hier zwei verschiedene Antworten, und das ist die
 * ganze Pointe dieser Funktion: wer die Zutat weglaesst, sagt "weiss ich
 * nicht"; wer 0 eintraegt, sagt "keines". Ein `if (!value)` haette beides zu
 * derselben Zeile gemacht.
 */
function vNutrient(value, field) {
  if (value === undefined) return { value: undefined, error: null };
  if (value === null || value === '') return { value: null, error: null };
  const parsed = v.num(value, field);
  if (parsed.error) return parsed;
  if (parsed.value < 0 || parsed.value > MAX_NUTRIENT) {
    return { value: null, error: `${field} must be between 0 and ${MAX_NUTRIENT}.` };
  }
  return { value: parsed.value, error: null };
}

/** Die acht Werte aus einem Request-Body, je als Validierungsergebnis. */
function readNutrients(body) {
  const out = {};
  for (const key of NUTRIENT_KEYS) out[key] = vNutrient(body[key], key);
  return out;
}

/** Darf `viewer` das Ziel von `ownerId` sehen? Eigenes plus jedes betreute. */
function mayReadTarget(viewer, ownerId) {
  return canWriteFor(viewer, ownerId);
}

// --------------------------------------------------------
// Tagesziel (health_nutrition_targets) - sparse
// --------------------------------------------------------

/**
 * GET /nutrition/targets?user_id=
 * Response: { data: { user_id, target: {…}|null } }
 *
 * `target: null` heisst "kein Ziel gesetzt" und ist etwas anderes als ein Ziel,
 * in dem Nullen stehen. Die Oberflaeche zeigt im ersten Fall "kein Ziel", im
 * zweiten einen Fortschritt gegen 0 - beides ist eine Aussage, und sie sind
 * nicht dieselbe.
 */
router.get('/nutrition/targets', (req, res) => {
  try {
    const viewer = viewerId(req);
    const ownerId = req.query.user_id ? parseInt(req.query.user_id, 10) : viewer;
    if (!ownerId) return badRequest(res, ['user_id is invalid.']);
    // Ein Ziel ist keine Zeile mit Sichtbarkeit - es gibt nichts zu oeffnen.
    // Deshalb die Betreuungsfrage statt einer Sichtbarkeits-Klausel: wer fuer
    // jemanden eintraegt, muss dessen Ziel kennen, alle anderen nicht.
    if (!mayReadTarget(viewer, ownerId)) {
      return res.status(403).json({ error: 'Keine Berechtigung fuer dieses Ziel.', code: 403 });
    }
    res.json({ data: { user_id: ownerId, target: nutritionTargetFor(db.get(), ownerId) } });
  } catch (err) {
    log.error('Error loading nutrition target:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

/**
 * PUT /nutrition/targets
 * Body: { user_id?, energy_kcal?, …, fiber_g? }
 *
 * SPARSE WIE health_fasting_settings: sind alle acht Werte NULL, wird die Zeile
 * GELOESCHT statt mit Nullen geschrieben. So bleibt "keine Zeile" die einzige
 * Schreibweise fuer "kein Ziel" - dieselbe Regel, nach der eine
 * Sichtbarkeits-Voreinstellung 'private' gar nicht erst gespeichert wird.
 */
router.put('/nutrition/targets', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const checks = readNutrients(b);
    const errors = v.collectErrors(Object.values(checks));
    if (errors.length) return badRequest(res, errors);

    // `undefined` (Feld gar nicht geschickt) und `null` (ausdruecklich
    // geleert) laufen hier zusammen: ein PUT ersetzt das ganze Ziel, ein nicht
    // genanntes Feld ist danach nicht gesetzt. Das PATCH-Verhalten waere die
    // andere Wahl - sie haette aber keine Schreibweise fuer "dieses eine Ziel
    // wieder loeschen" uebrig gelassen.
    const values = NUTRIENT_KEYS.map((key) => checks[key].value ?? null);
    const database = db.get();
    if (values.every((value) => value === null)) {
      database.prepare('DELETE FROM health_nutrition_targets WHERE user_id = ?').run(owner.ownerId);
      return res.json({ data: { user_id: owner.ownerId, target: null } });
    }

    database.prepare(`
      INSERT INTO health_nutrition_targets (user_id, ${NUTRIENT_KEYS.join(', ')})
      VALUES (?, ${NUTRIENT_KEYS.map(() => '?').join(', ')})
      ON CONFLICT(user_id) DO UPDATE SET
        ${NUTRIENT_KEYS.map((key) => `${key} = excluded.${key}`).join(', ')}
    `).run(owner.ownerId, ...values);

    res.json({ data: { user_id: owner.ownerId, target: nutritionTargetFor(database, owner.ownerId) } });
  } catch (err) {
    log.error('Error saving nutrition target:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// Tagebuch (health_nutrition_entries)
// --------------------------------------------------------

// GET /nutrition/entries?user_id=&from=&to=&meal_type=
router.get('/nutrition/entries', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = careAwareClause('e', viewer, personId, OPEN_ALL);
    const params   = [...clause.params];
    let sql = `SELECT e.* FROM health_nutrition_entries e WHERE ${clause.sql}`;

    // Gefiltert wird auf den DATUMSTEIL von consumed_at: der Wert ist
    // Wanduhrzeit des Haushalts, und ein Tag ist ein Tag, keine 24 Stunden.
    if (req.query.from) { sql += ' AND substr(e.consumed_at, 1, 10) >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND substr(e.consumed_at, 1, 10) <= ?'; params.push(String(req.query.to)); }
    if (req.query.meal_type) { sql += ' AND e.meal_type = ?'; params.push(String(req.query.meal_type)); }

    sql += ' ORDER BY e.consumed_at DESC, e.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing nutrition entries:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /nutrition/entries
router.post('/nutrition/entries', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};

    const title      = v.str(b.title, 'title', { max: v.MAX_TITLE });
    const consumedAt = v.datetime(b.consumed_at, 'consumed_at', true, wallClockInput());
    const mealType   = v.oneOf(b.meal_type, MEAL_TYPES, 'meal_type');
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, NUTRITION_VISIBILITIES, 'visibility');
    const nutrients  = readNutrients(b);

    const errors = v.collectErrors([title, consumedAt, mealType, note, visibility, ...Object.values(nutrients)]);
    if (errors.length) return badRequest(res, errors);

    // Optionales user_id: eine betreuende Person traegt fuer die betreute ein (#584).
    const owner = resolveOwner(req, viewer);
    if (owner.error) return res.status(owner.status).json({ error: owner.error, code: owner.status });

    const result = db.get().prepare(`
      INSERT INTO health_nutrition_entries (
        user_id, consumed_at, meal_type, title, ${NUTRIENT_KEYS.join(', ')}, note, visibility, created_by
      ) VALUES (?, ?, ?, ?, ${NUTRIENT_KEYS.map(() => '?').join(', ')}, ?, ?, ?)
    `).run(
      owner.ownerId, consumedAt.value, mealType.value, title.value,
      ...NUTRIENT_KEYS.map((key) => nutrients[key].value ?? null),
      note.value,
      // Fehlt das Feld, gilt die Wahl des EIGENTUEMERS (#958) - nicht die der
      // erfassenden Person: die Zeile gehoert ihm. defaultVisibilityFor()
      // liefert fuer diesen Bereich bereits 'all' statt 'family', weil die
      // Tabelle den kanonischen Satz fuehrt (siehe visibility-defaults.js).
      visibility.value || defaultVisibilityFor(db.get(), owner.ownerId, 'nutrition'),
      viewer,
    );

    const row = db.get().prepare('SELECT * FROM health_nutrition_entries WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('Error creating nutrition entry:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /nutrition/entries/:id
router.patch('/nutrition/entries/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT id FROM health_nutrition_entries WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Entry not found.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.title !== undefined) { const r = v.str(b.title, 'title', { max: v.MAX_TITLE }); checks.push(r); if (!r.error) fields.title = r.value; }
    if (b.consumed_at !== undefined) { const r = v.datetime(b.consumed_at, 'consumed_at', true, wallClockInput()); checks.push(r); if (!r.error) fields.consumed_at = r.value; }
    if (b.meal_type !== undefined) {
      if (b.meal_type === null || b.meal_type === '') fields.meal_type = null;
      else { const r = v.oneOf(b.meal_type, MEAL_TYPES, 'meal_type'); checks.push(r.value ? r : { value: null, error: 'meal_type is invalid.' }); if (r.value) fields.meal_type = r.value; }
    }
    if (b.note !== undefined) { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined) { const r = v.oneOf(b.visibility, NUTRITION_VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }
    for (const key of NUTRIENT_KEYS) {
      if (b[key] === undefined) continue;
      const r = vNutrient(b[key], key);
      checks.push(r);
      // `?? null` und nicht `|| null`: eine ausdrueckliche 0 muss als 0
      // ankommen. Genau hier waere sie sonst wieder zu "nicht angegeben"
      // geworden, nachdem vNutrient() sie eben erst davon unterschieden hat.
      if (!r.error) fields[key] = r.value ?? null;
    }

    const errors = v.collectErrors(checks);
    if (errors.length) return badRequest(res, errors);

    applyUpdate('health_nutrition_entries', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM health_nutrition_entries WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating nutrition entry:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /nutrition/entries/:id
router.delete('/nutrition/entries/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.', code: 400 });

    const w = writableClause('', viewer);
    const existing = db.get().prepare(`SELECT id FROM health_nutrition_entries WHERE id = ? AND ${w.sql}`).get(id, ...w.params);
    if (!existing) return res.status(404).json({ error: 'Entry not found.', code: 404 });

    db.get().prepare('DELETE FROM health_nutrition_entries WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting nutrition entry:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /nutrition/summary?user_id=&date= - heute gegen das Ziel
// --------------------------------------------------------

/**
 * Die eine Zahl, fuer die dieser Tab gebaut ist. Ohne `date` gilt `todayKey()`,
 * also der Kalendertag der HAUSHALTSZONE - `toISOString().slice(0, 10)` waere
 * der UTC-Tag und lieferte je nach Zone und Uhrzeit die Bilanz des Nachbartags.
 *
 * Gerechnet wird in services/health-nutrition.js, weil /dashboard dieselbe
 * Antwort braucht: zwei Rechnungen waeren zwei Zahlen, und die Kachel wuerde
 * dem Tab widersprechen.
 */
router.get('/nutrition/summary', (req, res) => {
  try {
    const viewer  = viewerId(req);
    const ownerId = req.query.user_id ? parseInt(req.query.user_id, 10) : viewer;
    if (!ownerId) return badRequest(res, ['user_id is invalid.']);

    const dateCheck = v.date(req.query.date, 'date', false);
    if (dateCheck.error) return badRequest(res, [dateCheck.error]);
    const dayKey = dateCheck.value || todayKey(db.get());

    res.json({ data: nutritionSummaryFor(db.get(), viewer, ownerId, dayKey) });
  } catch (err) {
    log.error('Error computing nutrition summary:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
