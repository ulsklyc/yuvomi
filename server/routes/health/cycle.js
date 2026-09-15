/**
 * Modul: Gesundheit (Health) - Zyklus (Menstruation)
 * Zweck: Drei Ressourcen, alle mit dem üblichen Visibility-Scoping (Eigentümer +
 *        optional 'family' für den Personen-Umschalter): Perioden-Episoden
 *        (cycle_periods), Tages-Logs (cycle_day_logs, genau ein Eintrag je
 *        Person/Tag → Upsert) und die per-Person-Einstellungen (cycle_settings,
 *        nur der Eigentümer selbst) plus der Perioden-CSV-Export/-Import
 *        (POST /cycle/import - Alles-oder-nichts, siehe dortiger Kommentar).
 *        Die
 *        Vorhersage-Logik (nächste Periode, Eisprung, fruchtbares Fenster) liegt
 *        bewusst in EINER Datei, public/utils/health-cycle.js, absichtlich
 *        DOM-frei geschrieben, damit sie auch außerhalb des Browsers läuft.
 *        Dieser Router speichert nur - aber server/services/cycle-reminders.js
 *        importiert dieselbe Datei für die Erinnerungs-Zeitpunkte, statt eine
 *        zweite Rechnung zu führen; zwei Kopien derselben Mathematik wären
 *        zwei Wahrheiten, die auseinanderlaufen können.
 *
 *        BEWUSSTE AUSNAHME von der Betreuung (#584): Wo Vitalwerte, Medikamente,
 *        Laborbefunde und Aktivitäten `careAwareClause()` verwenden, bleibt es
 *        hier bei `visibilityClause()`. Fieber messen und Medikamente geben ist
 *        Fürsorge; das Zyklus-Tagebuch einer anderen Person mitzulesen ist es
 *        nicht - und der Fall aus der Meldung (ein Elternteil trägt für ein Kind
 *        ein) verlangt es an keiner Stelle. Wer den Zyklus teilen will, hat dafür
 *        `visibility = 'family'`.
 */

import express from 'express';
import * as db from '../../db.js';
import * as v from '../../middleware/validate.js';
import { cycleToCsv } from '../../services/health-export.js';
import { syncCycleRemindersForUser, isEligibleCyclePartner, eligibleCyclePartners } from '../../services/cycle-reminders.js';
// Die vier geschlossenen Wertelisten kommen aus health-cycle.js (dasselbe
// Muster wie der bestehende MOOD_VALUES-Import) - EIN Zuhause statt mehrerer
// Kopien (CERVIX_MUCUS_VALUES/TEST_RESULT_VALUES/INTIMACY_VALUES,
// CONTRACEPTION_VALUES), die sonst auseinanderlaufen koennten.
import {
  normalizeSymptomEntries, MOOD_VALUES,
  CERVIX_MUCUS_VALUES, TEST_RESULT_VALUES, INTIMACY_VALUES, CONTRACEPTION_VALUES,
} from '../../../public/utils/health-cycle.js';
import {
  log, VISIBILITIES, FLOW_LEVELS,
  viewerId, visibilityClause, toBit, applyUpdate, badRequest,
  exportFilename, sendCsv, exportRange,
} from './helpers.js';

const router = express.Router();

// Deckel auf die ANZAHL Symptome je Tag, nicht mehr auf die Zeichenlaenge der
// (seit Migration 178 nur noch historischen) Komma-Spalte - die Symptom-Liste
// waechst mit SYMPTOM_TYPES (aktuell 20), 40 laesst reichlich Raum, auch fuer
// spaeter erweiterte Presets, ohne eine Endlos-Liste durchzulassen.
const MAX_SYMPTOMS_COUNT = 40;

// Anders als health_vitals.unit (freier Text, viele Metriken) macht fuer eine
// Basaltemperatur nur eine von zwei Einheiten Sinn - und detectTemperatureShift()
// muss beide zuverlaessig in Celsius umrechnen koennen, ein freies Textfeld
// waere dafuer die falsche Grundlage. Plausibilitaets-Grenzen sind grosszuegige
// Koerpertemperatur-Baender, keine medizinische Norm.
const BASAL_TEMP_RANGE = { c: [34, 42], f: [93, 108] };

/** Validiert (basal_temp, basal_temp_unit) zusammen - beide oder keins. */
function validateBasalTemp(rawTemp, rawUnit) {
  if (rawTemp === undefined || rawTemp === null || rawTemp === '') return { temp: null, unit: null, error: null };
  const unit = String(rawUnit || '').toLowerCase();
  const range = BASAL_TEMP_RANGE[unit];
  if (!range) return { temp: null, unit: null, error: 'basal_temp_unit must be "c" or "f" when basal_temp is set.' };
  const n = Number(rawTemp);
  if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
    return { temp: null, unit: null, error: `basal_temp must be a number between ${range[0]} and ${range[1]} for unit "${unit}".` };
  }
  return { temp: n, unit, error: null };
}

/** Symptom-Zeilen eines Tages-Logs, in Einfuegereihenfolge. */
function symptomsForLog(database, dayLogId) {
  return database.prepare(
    'SELECT symptom_key AS key, intensity FROM cycle_day_log_symptoms WHERE day_log_id = ? ORDER BY id'
  ).all(dayLogId);
}

/**
 * Batch-Fassung von symptomsForLog() für eine Liste von Tages-Logs - EIN
 * `WHERE day_log_id IN (...)` statt einer Abfrage je Zeile, für GET
 * /cycle/logs (das potenziell viele Zeilen zurückgibt).
 * @returns {Map<number, Array<{key: string, intensity: number|null}>>}
 */
function symptomsForLogs(database, dayLogIds) {
  const byLog = new Map(dayLogIds.map((id) => [id, []]));
  if (dayLogIds.length === 0) return byLog;
  const placeholders = dayLogIds.map(() => '?').join(', ');
  const rows = database.prepare(
    `SELECT day_log_id, symptom_key AS key, intensity FROM cycle_day_log_symptoms WHERE day_log_id IN (${placeholders}) ORDER BY id`
  ).all(...dayLogIds);
  for (const { day_log_id, key, intensity } of rows) byLog.get(day_log_id).push({ key, intensity });
  return byLog;
}

/** Ersetzt die Symptom-Zeilen eines Tages-Logs vollstaendig (loeschen + neu anlegen). */
function replaceSymptoms(database, dayLogId, entries) {
  database.prepare('DELETE FROM cycle_day_log_symptoms WHERE day_log_id = ?').run(dayLogId);
  const insert = database.prepare(
    'INSERT INTO cycle_day_log_symptoms (day_log_id, symptom_key, intensity) VALUES (?, ?, ?)'
  );
  for (const entry of entries) insert.run(dayLogId, entry.key, entry.intensity);
}

// Geschlossene Werte-Listen fuer die seit Migration 210 nullbaren Spalten
// (kein CHECK auf der Spalte selbst, siehe dortiger Kommentar) - kommen als
// Import von oben (health-cycle.js, EIN Zuhause statt dreier Kopien), nicht
// mehr als lokale Konstanten hier.
// intimacy, cervix_mucus, lh_test und pregnancy_test sind hart privat (siehe
// GET /cycle/logs unten und docs/SPEC.md): INTIMACY_VALUES/CERVIX_MUCUS_VALUES/
// TEST_RESULT_VALUES.

/**
 * Gefuehle eines Tages (Mehrfachauswahl, seit Migration 211) validieren +
 * normalisieren. Anders als normalizeSymptomEntries() (offenes Schema, nur
 * eine Format-Regex) ist dies ein GESCHLOSSENES Set - MOOD_VALUES aus
 * health-cycle.js, dieselbe Quelle wie das Frontend-Preset - und ein
 * unbekannter Wert ist ein Fehler (400), kein still verworfener Eintrag:
 * Gefuehle sind keine erweiterbare Presets-Liste wie Symptome, sondern eine
 * feste kleine Auswahl.
 *
 * Nimmt `feelings` (Array) entgegen, oder - fehlt es - das alte Einzelfeld
 * `mood` als Ein-Element-Liste (Abwaertskompatibilitaet, siehe POST-Handler).
 * @returns {{ keys: string[]|null, error: string|null }}
 */
function normalizeFeelings(rawFeelings, rawMood) {
  const list = rawFeelings !== undefined && rawFeelings !== null
    ? rawFeelings
    : (rawMood !== undefined && rawMood !== null && rawMood !== '' ? [rawMood] : []);
  if (!Array.isArray(list)) return { keys: null, error: 'feelings must be an array.' };

  const keys = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item).trim().toLowerCase();
    if (!MOOD_VALUES.includes(key)) {
      return { keys: null, error: `feelings must contain only: ${MOOD_VALUES.join(', ')}.` };
    }
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  }
  return { keys, error: null };
}

/** Gefuehls-Schluessel eines Tages-Logs, in Einfuegereihenfolge. */
function feelingsForLog(database, dayLogId) {
  return database.prepare(
    'SELECT feeling_key FROM cycle_day_log_feelings WHERE day_log_id = ? ORDER BY id'
  ).all(dayLogId).map((r) => r.feeling_key);
}

/** Batch-Fassung von feelingsForLog() fuer GET /cycle/logs - EIN `IN (...)` statt einer Abfrage je Zeile. */
function feelingsForLogs(database, dayLogIds) {
  const byLog = new Map(dayLogIds.map((id) => [id, []]));
  if (dayLogIds.length === 0) return byLog;
  const placeholders = dayLogIds.map(() => '?').join(', ');
  const rows = database.prepare(
    `SELECT day_log_id, feeling_key FROM cycle_day_log_feelings WHERE day_log_id IN (${placeholders}) ORDER BY id`
  ).all(...dayLogIds);
  for (const { day_log_id, feeling_key } of rows) byLog.get(day_log_id).push(feeling_key);
  return byLog;
}

/** Ersetzt die Gefuehls-Zeilen eines Tages-Logs vollstaendig (loeschen + neu anlegen). */
function replaceFeelings(database, dayLogId, keys) {
  database.prepare('DELETE FROM cycle_day_log_feelings WHERE day_log_id = ?').run(dayLogId);
  const insert = database.prepare(
    'INSERT INTO cycle_day_log_feelings (day_log_id, feeling_key) VALUES (?, ?)'
  );
  for (const key of keys) insert.run(dayLogId, key);
}

// ---- Perioden-Episoden ----

// GET /cycle/periods?user_id=&from=&to=
router.get('/cycle/periods', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('p', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT p.* FROM cycle_periods p WHERE ${clause.sql}`;
    if (req.query.from) { sql += ' AND p.start_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND p.start_date <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY p.start_date DESC, p.id DESC';
    res.json({ data: db.get().prepare(sql).all(...params) });
  } catch (err) {
    log.error('Error listing cycle periods:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /cycle/periods
router.post('/cycle/periods', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const startDate  = v.date(b.start_date, 'start_date', true);
    const endDate    = v.date(b.end_date, 'end_date');
    const note       = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility = v.oneOf(b.visibility, VISIBILITIES, 'visibility');

    const errors = v.collectErrors([startDate, endDate, note, visibility]);
    if (endDate.value && startDate.value && endDate.value < startDate.value) {
      errors.push('end_date must not be before start_date.');
    }
    if (errors.length) return badRequest(res, errors);

    const result = db.get().prepare(`
      INSERT INTO cycle_periods (user_id, start_date, end_date, note, visibility)
      VALUES (?, ?, ?, ?, ?)
    `).run(viewer, startDate.value, endDate.value, note.value, visibility.value || 'private');

    // Sofort wirksam statt erst beim naechsten periodischen Lauf: ein neu
    // geloggter Zyklus verschiebt sofort predictCycle()s naechsten
    // Periodenbeginn, die Erinnerung soll dem nicht hinterherhinken.
    try {
      syncCycleRemindersForUser(db.get(), viewer);
    } catch (err) {
      log.error('Error syncing cycle reminders after period change:', err.message);
    }

    res.status(201).json({ data: db.get().prepare('SELECT * FROM cycle_periods WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    log.error('Error creating cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /cycle/periods/:id
router.patch('/cycle/periods/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT * FROM cycle_periods WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Periode nicht gefunden.', code: 404 });

    const b = req.body || {};
    const fields = {};
    const checks = [];

    if (b.start_date !== undefined) { const r = v.date(b.start_date, 'start_date', true); checks.push(r); if (!r.error) fields.start_date = r.value; }
    if (b.end_date !== undefined)   { const r = v.date(b.end_date, 'end_date');           checks.push(r); if (!r.error) fields.end_date = r.value; }
    if (b.note !== undefined)       { const r = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false }); checks.push(r); if (!r.error) fields.note = r.value; }
    if (b.visibility !== undefined) { const r = v.oneOf(b.visibility, VISIBILITIES, 'visibility'); checks.push(r); if (!r.error && r.value) fields.visibility = r.value; }

    const errors = v.collectErrors(checks);
    const nextStart = fields.start_date !== undefined ? fields.start_date : existing.start_date;
    const nextEnd   = fields.end_date   !== undefined ? fields.end_date   : existing.end_date;
    if (nextEnd && nextStart && nextEnd < nextStart) errors.push('end_date must not be before start_date.');
    if (errors.length) return badRequest(res, errors);

    applyUpdate('cycle_periods', id, fields);
    res.json({ data: db.get().prepare('SELECT * FROM cycle_periods WHERE id = ?').get(id) });
  } catch (err) {
    log.error('Error updating cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /cycle/periods/:id
router.delete('/cycle/periods/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT id FROM cycle_periods WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Periode nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM cycle_periods WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting cycle period:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Tages-Logs (Upsert je Person/Tag) ----

// GET /cycle/logs?user_id=&from=&to=
router.get('/cycle/logs', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('l', viewer, personId);
    const params   = [...clause.params];
    let sql = `SELECT l.* FROM cycle_day_logs l WHERE ${clause.sql}`;
    if (req.query.from) { sql += ' AND l.log_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to)   { sql += ' AND l.log_date <= ?'; params.push(String(req.query.to)); }
    sql += ' ORDER BY l.log_date DESC, l.id DESC';
    const database = db.get();
    const rows = database.prepare(sql).all(...params);
    // `symptoms`/`feelings` kommen aus je einer eigenen Tabelle (Migration 178
    // bzw. 211), nicht mehr aus den (nur noch historischen) Skalar-Spalten -
    // `SELECT l.*` liefert die alten Spalten zwar mit, der Überschreib unten
    // ersetzt `symptoms` in der Antwort und ergänzt `feelings`; `mood` bleibt
    // als reiner Altlast-Lesewert stehen (siehe Migration 211). Batch statt
    // einer Abfrage je Zeile (symptomsForLogs()/feelingsForLogs(), je ein
    // `IN (...)`).
    const symptomsByLog = symptomsForLogs(database, rows.map((row) => row.id));
    const feelingsByLog = feelingsForLogs(database, rows.map((row) => row.id));
    res.json({ data: rows.map((row) => {
      // Vier Felder sind hart privat: unabhängig von `visibility` nur für den
      // Eigentümer selbst sichtbar, auch wenn diese Zeile familienweit geteilt
      // ist - siehe Migration 210's Kommentar und docs/SPEC.md. Sex-Leben
      // (intimacy), Zyklusmonitor-Testergebnisse (lh_test, pregnancy_test) und
      // Zervixschleim (cervix_mucus) sind Dinge, die man teilt, indem man sie
      // ausdruecklich TEILT - nicht als Nebenwirkung davon, dass der restliche
      // Tag family-sichtbar ist.
      const { intimacy, cervix_mucus, lh_test, pregnancy_test, ...rest } = row;
      return {
        ...rest,
        symptoms: symptomsByLog.get(row.id),
        feelings: feelingsByLog.get(row.id),
        ...(row.user_id === viewer ? { intimacy, cervix_mucus, lh_test, pregnancy_test } : {}),
      };
    }) });
  } catch (err) {
    log.error('Error listing cycle logs:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// POST /cycle/logs  (Upsert: ein Eintrag je user_id + log_date)
router.post('/cycle/logs', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};
    const logDate       = v.date(b.log_date, 'log_date', true);
    const flow          = v.oneOf(b.flow, FLOW_LEVELS, 'flow');
    const note          = v.str(b.note, 'note', { max: v.MAX_TEXT, required: false });
    const visibility    = v.oneOf(b.visibility, VISIBILITIES, 'visibility');
    const symptoms      = normalizeSymptomEntries(b.symptoms);
    const basalTemp     = validateBasalTemp(b.basal_temp, b.basal_temp_unit);
    const cervixMucus   = v.oneOf(b.cervix_mucus, CERVIX_MUCUS_VALUES, 'cervix_mucus');
    const lhTest        = v.oneOf(b.lh_test, TEST_RESULT_VALUES, 'lh_test');
    const pregnancyTest = v.oneOf(b.pregnancy_test, TEST_RESULT_VALUES, 'pregnancy_test');
    const intimacy      = v.oneOf(b.intimacy, INTIMACY_VALUES, 'intimacy');
    // Legacy `mood` (Einzelwert) wird, wenn `feelings` fehlt, als
    // Ein-Element-Liste behandelt - siehe normalizeFeelings(). Die
    // `mood`-Spalte selbst wird nur dann aktiv auf NULL gesetzt (und die
    // Gefuehls-Zeilen nur dann ersetzt), wenn der Request `feelings` oder das
    // alte Einzelfeld `mood` ueberhaupt als Schluessel enthaelt - also einen
    // dieser beiden Werte tatsaechlich ersetzen will. Ein Save, der nur Flow,
    // Notiz oder Temperatur aendert und keinen der beiden Schluessel mitschickt,
    // darf einen eingefrorenen Altwert in `mood` nicht zerstoeren (siehe
    // Review: sonst loescht JEDE unbeteiligte Aenderung an einem Tag mit
    // vor-migriertem Freitext-Mood diesen dauerhaft). `feelings: []` bleibt
    // dabei weiterhin massgeblich zum Leeren - der Schluessel ist ja vorhanden,
    // nur sein Wert ist leer (siehe normalizeFeelings()).
    const feelingsProvided = Object.prototype.hasOwnProperty.call(b, 'feelings')
      || Object.prototype.hasOwnProperty.call(b, 'mood');
    const feelings = feelingsProvided
      ? normalizeFeelings(b.feelings, b.mood)
      : { keys: null, error: null };

    const errors = v.collectErrors([logDate, flow, note, visibility, cervixMucus, lhTest, pregnancyTest, intimacy]);
    if (symptoms.length > MAX_SYMPTOMS_COUNT) errors.push(`symptoms may include at most ${MAX_SYMPTOMS_COUNT} entries.`);
    if (basalTemp.error) errors.push(basalTemp.error);
    if (feelings.error) errors.push(feelings.error);
    if (errors.length) return badRequest(res, errors);

    const database = db.get();
    // Log-Zeile, ihre Symptome und ihre Gefühle zusammen, sonst könnte ein
    // Absturz dazwischen eine Teilmenge ohne die andere zurücklassen.
    const dayLogId = database.transaction(() => {
      database.prepare(`
        INSERT INTO cycle_day_logs (
          user_id, log_date, flow, note, visibility, basal_temp, basal_temp_unit,
          cervix_mucus, lh_test, pregnancy_test, intimacy, mood
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(user_id, log_date) DO UPDATE SET
          flow = excluded.flow, note = excluded.note, visibility = excluded.visibility,
          basal_temp = excluded.basal_temp, basal_temp_unit = excluded.basal_temp_unit,
          cervix_mucus = excluded.cervix_mucus, lh_test = excluded.lh_test,
          pregnancy_test = excluded.pregnancy_test, intimacy = excluded.intimacy
          ${feelingsProvided ? ', mood = NULL' : ''}
      `).run(
        viewer, logDate.value, flow.value, note.value, visibility.value || 'private',
        basalTemp.temp, basalTemp.unit,
        cervixMucus.value, lhTest.value, pregnancyTest.value, intimacy.value,
      );
      const id = database.prepare('SELECT id FROM cycle_day_logs WHERE user_id = ? AND log_date = ?').get(viewer, logDate.value).id;
      replaceSymptoms(database, id, symptoms);
      if (feelingsProvided) replaceFeelings(database, id, feelings.keys);
      return id;
    })();

    // Sofort wirksam statt erst beim naechsten periodischen Lauf: der
    // taegliche Eintrags-Hinweis (syncLogNudgeReminder) faellt weg, sobald
    // fuer heute ein Log existiert - ohne diesen Aufruf bliebe er bis zum
    // naechsten Sync-Durchgang stehen, obwohl die Frage schon beantwortet ist.
    try {
      syncCycleRemindersForUser(database, viewer);
    } catch (err) {
      log.error('Error syncing cycle reminders after log change:', err.message);
    }

    const row = database.prepare('SELECT * FROM cycle_day_logs WHERE id = ?').get(dayLogId);
    // POST ist immer der eigene Eintrag des Aufrufers (der Zyklus-Tab kennt
    // keine Betreuung, siehe Datei-Kopfkommentar) - `intimacy` braucht hier
    // deshalb keinen Eigentümer-Check wie bei GET.
    res.status(201).json({
      data: { ...row, symptoms: symptomsForLog(database, dayLogId), feelings: feelingsForLog(database, dayLogId) },
    });
  } catch (err) {
    log.error('Error saving cycle log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// DELETE /cycle/logs/:id
router.delete('/cycle/logs/:id', (req, res) => {
  try {
    const viewer = viewerId(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.', code: 400 });

    const existing = db.get().prepare('SELECT id FROM cycle_day_logs WHERE id = ? AND user_id = ?').get(id, viewer);
    if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden.', code: 404 });

    db.get().prepare('DELETE FROM cycle_day_logs WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('Error deleting cycle log:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Einstellungen (nur eigene) ----

// Verhuetungsmethode: geschlossene Auswahl, NULL = nicht angegeben.
// Kein CHECK auf der Spalte (siehe Migration 212) - dieselbe Aufteilung wie
// ueberall sonst in diesem Modul. Die *hormonelle* Teilmenge (pill,
// hormonal_iud, implant, injection, patch, ring) schaltet clientseitig die
// Eisprung-/Fruchtbarkeitsvorhersage ab; Kupferspirale/Kondom/keine aendern
// daran nichts - das entscheidet public/utils/health-cycle.js, nicht diese
// Route. CONTRACEPTION_VALUES kommt als Import von oben (aus
// CONTRACEPTION_TYPES abgeleitet), nicht mehr als lokale Kopie hier.

/** Voreinstellungen, falls die Person noch keine Zeile hat. */
function defaultCycleSettings(userId) {
  return {
    user_id: userId, cycle_length_avg: null, period_length_avg: null, luteal_length: 14, track_fertility: 1,
    pregnancy_mode: 0, pregnancy_due_date: null, default_visibility: 'private',
    remind_period_days_before: null, remind_log_daily: 0,
    contraception: null, perimenopause_mode: 0, show_pms: 1,
    notify_partner_user_id: null, notify_partner_days_before: null,
  };
}

// GET /cycle/settings  (immer die eigenen; Vorhersagen sind persönlich)
// `eligible_partners`: andere Haushaltsmitglieder, die die
// Partner-Auswahl unten tatsaechlich anzeigen darf - derselbe Praedikat wie der
// Sync (isEligibleCyclePartner()/eligibleCyclePartners() in cycle-reminders.js,
// EINE Regel statt einer zweiten Abschrift). Ohne dieses Feld muesste das
// Frontend raten, wer eine Meldung tatsaechlich bekaeme.
router.get('/cycle/settings', (req, res) => {
  try {
    const viewer = viewerId(req);
    const database = db.get();
    const row = database.prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(viewer);
    res.json({ data: { ...(row || defaultCycleSettings(viewer)), eligible_partners: eligibleCyclePartners(database, viewer) } });
  } catch (err) {
    log.error('Error loading cycle settings:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PUT /cycle/settings
router.put('/cycle/settings', (req, res) => {
  try {
    const viewer = viewerId(req);
    const b = req.body || {};

    const intInRange = (val, field, lo, hi) => {
      if (val === undefined || val === null || val === '') return { value: null, error: null };
      const n = Number(val);
      if (!Number.isInteger(n) || n < lo || n > hi) return { value: null, error: `${field} must be an integer between ${lo} and ${hi}.` };
      return { value: n, error: null };
    };
    const cycleLen  = intInRange(b.cycle_length_avg, 'cycle_length_avg', 15, 60);
    const periodLen = intInRange(b.period_length_avg, 'period_length_avg', 1, 15);
    const luteal    = intInRange(b.luteal_length, 'luteal_length', 8, 18);
    const track     = toBit(b.track_fertility);
    const pregnancy = toBit(b.pregnancy_mode);
    const dueDate   = v.date(b.pregnancy_due_date, 'pregnancy_due_date');
    const defVis    = v.oneOf(b.default_visibility, VISIBILITIES, 'default_visibility');
    // NULL = aus (Standard); sonst der Vorlauf in Tagen vor dem vorhergesagten
    // Periodenbeginn. Obergrenze wie luteal_length: mehr Vorlauf als eine
    // typische Lutealphase waere keine Vorwarnung mehr, sondern Dauerlaerm.
    const remindDaysBefore = intInRange(b.remind_period_days_before, 'remind_period_days_before', 0, 14);
    const remindLogDaily   = toBit(b.remind_log_daily);
    const contraception    = v.oneOf(b.contraception, CONTRACEPTION_VALUES, 'contraception');
    const perimenopause    = toBit(b.perimenopause_mode);
    const showPms          = toBit(b.show_pms);
    const partnerDaysBefore = intInRange(b.notify_partner_days_before, 'notify_partner_days_before', 0, 14);

    // notify_partner_user_id: muss in der eligible_partners-Menge stehen, die
    // GET /cycle/settings dem Frontend liefert - derselbe Praedikat
    // (isEligibleCyclePartner(), cycle-reminders.js), damit die Route niemanden
    // annimmt, den die Auswahlliste gar nicht erst zeigt. Darf ausserdem nicht
    // die aufrufende Person selbst sein: der Eigentuemer veroeffentlicht, eine
    // Benachrichtigung an sich selbst waere sinnlos. Leer/undefined loescht -
    // gleiche Voll-Ersetzen-Semantik wie jedes andere Feld dieser Route.
    let notifyPartnerUserId = null;
    let notifyPartnerError = null;
    if (b.notify_partner_user_id !== undefined && b.notify_partner_user_id !== null && b.notify_partner_user_id !== '') {
      // Striktes Parsen wie intInRange() oben statt parseInt(): parseInt('12abc', 10)
      // liest still den führenden Ziffernteil und liefert 12 zurück, statt den
      // Wert als Ganzes abzulehnen - ein vertipptes/manipuliertes Feld würde so
      // stillschweigend auf eine andere, zufällig gültige Person zeigen.
      const n = Number(b.notify_partner_user_id);
      const candidate = Number.isInteger(n) ? n : NaN;
      if (!candidate) {
        notifyPartnerError = 'notify_partner_user_id must be a valid user id.';
      } else if (candidate === viewer) {
        notifyPartnerError = 'notify_partner_user_id must not be the caller themselves.';
      } else if (!isEligibleCyclePartner(db.get(), candidate)) {
        notifyPartnerError = 'notify_partner_user_id must be an eligible household member (health module access, not a child).';
      } else {
        notifyPartnerUserId = candidate;
      }
    }

    const errors = v.collectErrors([
      cycleLen, periodLen, luteal, dueDate, defVis, remindDaysBefore, contraception, partnerDaysBefore,
    ]);
    if (b.track_fertility !== undefined && track === undefined) errors.push('track_fertility must be a boolean.');
    if (b.pregnancy_mode !== undefined && pregnancy === undefined) errors.push('pregnancy_mode must be a boolean.');
    if (b.remind_log_daily !== undefined && remindLogDaily === undefined) errors.push('remind_log_daily must be a boolean.');
    if (b.perimenopause_mode !== undefined && perimenopause === undefined) errors.push('perimenopause_mode must be a boolean.');
    if (b.show_pms !== undefined && showPms === undefined) errors.push('show_pms must be a boolean.');
    if (notifyPartnerError) errors.push(notifyPartnerError);
    if (errors.length) return badRequest(res, errors);

    db.get().prepare(`
      INSERT INTO cycle_settings (
        user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility, pregnancy_mode,
        pregnancy_due_date, default_visibility, remind_period_days_before, remind_log_daily,
        contraception, perimenopause_mode, show_pms, notify_partner_user_id, notify_partner_days_before
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cycle_length_avg = excluded.cycle_length_avg,
        period_length_avg = excluded.period_length_avg,
        luteal_length = excluded.luteal_length,
        track_fertility = excluded.track_fertility,
        pregnancy_mode = excluded.pregnancy_mode,
        pregnancy_due_date = excluded.pregnancy_due_date,
        default_visibility = excluded.default_visibility,
        remind_period_days_before = excluded.remind_period_days_before,
        remind_log_daily = excluded.remind_log_daily,
        contraception = excluded.contraception,
        perimenopause_mode = excluded.perimenopause_mode,
        show_pms = excluded.show_pms,
        notify_partner_user_id = excluded.notify_partner_user_id,
        notify_partner_days_before = excluded.notify_partner_days_before
    `).run(viewer, cycleLen.value, periodLen.value, luteal.value === null ? 14 : luteal.value,
           track === undefined ? 1 : track,
           pregnancy === undefined ? 0 : pregnancy,
           dueDate.value,
           defVis.value || 'private',
           remindDaysBefore.value,
           remindLogDaily === undefined ? 0 : remindLogDaily,
           contraception.value,
           perimenopause === undefined ? 0 : perimenopause,
           showPms === undefined ? 1 : showPms,
           notifyPartnerUserId,
           partnerDaysBefore.value);

    // Sofort wirksam statt erst beim naechsten periodischen Lauf - gleiche
    // Erwartung wie ueberall sonst (server/routes/schedule-preferences.js).
    try {
      syncCycleRemindersForUser(db.get(), viewer);
    } catch (err) {
      log.error('Error syncing cycle reminders after settings change:', err.message);
    }

    // eligible_partners auch hier mitschicken (gleiche Hilfsfunktion wie GET) -
    // sonst baut das Frontend nach diesem Save die Partner-Auswahl aus einer
    // leeren Liste neu auf und der naechste Save wuerde einen echten Partner
    // stillschweigend loeschen.
    const database = db.get();
    res.json({
      data: {
        ...database.prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(viewer),
        eligible_partners: eligibleCyclePartners(database, viewer),
      },
    });
  } catch (err) {
    log.error('Error saving cycle settings:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// PATCH /cycle/visibility  — Bulk: setzt ALLE eigenen Zyklus-Einträge (Perioden +
// Tageslogs) auf eine Sichtbarkeit. Betrifft ausschließlich user_id = viewer;
// fremde Einträge bleiben unberührt. Ein Transaktions-Wrapper hält Perioden und
// Logs konsistent (entweder beide oder keine).
router.patch('/cycle/visibility', (req, res) => {
  try {
    const viewer = viewerId(req);
    const vis = v.oneOf(req.body?.visibility, VISIBILITIES, 'visibility');
    if (vis.error || !vis.value) return badRequest(res, [vis.error || 'visibility is required.']);

    const database = db.get();
    const applyBulk = database.transaction((value) => {
      const p = database.prepare('UPDATE cycle_periods  SET visibility = ? WHERE user_id = ?').run(value, viewer);
      const l = database.prepare('UPDATE cycle_day_logs SET visibility = ? WHERE user_id = ?').run(value, viewer);
      return { periods: p.changes, logs: l.changes };
    });
    res.json({ data: applyBulk(vis.value) });
  } catch (err) {
    log.error('Error bulk-updating cycle visibility:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// GET /export/cycle?user_id=&from=&to=  (Perioden-Historie als CSV, chronologisch)
router.get('/export/cycle', (req, res) => {
  try {
    const viewer   = viewerId(req);
    const personId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const clause   = visibilityClause('p', viewer, personId);
    const { from, to } = exportRange(req);
    const params = [...clause.params];
    let sql = `SELECT p.* FROM cycle_periods p WHERE ${clause.sql}`;
    if (from) { sql += ' AND p.start_date >= ?'; params.push(from); }
    if (to)   { sql += ' AND p.start_date <= ?'; params.push(to); }
    sql += ' ORDER BY p.start_date ASC, p.id ASC';

    const rows = db.get().prepare(sql).all(...params);
    sendCsv(res, exportFilename('cycle', from, to), cycleToCsv(rows));
  } catch (err) {
    log.error('Error exporting cycle:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

// ---- Perioden-Historie-Import ----
// Wer von Flo/Clue/Papier umzieht, hat seine Historie meist als CSV - dieselbe
// Spaltenreihenfolge wie der eigene Export (CYCLE_HEADER, health-export.js:
// start_date zuerst, end_date zweitens), damit ein Export dieser App selbst
// klaglos re-importierbar ist. Zusaetzliche Spalten (period_length_days,
// cycle_length_days, note, visibility) werden absichtlich ignoriert - sie
// sind beim Export abgeleitet bzw. gehoeren zu einer einzelnen Periode, nicht
// zu diesem Massenimport.

const IMPORT_MAX_BYTES = 100 * 1024; // 100 KB
const IMPORT_MAX_ROWS = 500; // Datenzeilen, ohne Kopfzeile
const IMPORT_MAX_ERRORS = 10; // nur die ersten zehn Fehler in der Antwort, nicht alle

/**
 * Trennzeichen erkennen: ein deutscher Excel-Export trennt mit Semikolon
 * (das Komma ist dort das Dezimaltrennzeichen), ein Export dieser App selbst
 * (health-export.js#toCsv) mit Komma. Ausgezaehlt an der ersten Zeile statt
 * fest auf eines der beiden gesetzt, sonst waere die Haelfte der beiden
 * angekuendigten Formate gar nicht lesbar.
 */
function detectCsvDelimiter(firstLine) {
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

/**
 * Zerlegt eine CSV-Zeile in Zellen - schlanke RFC4180-Untermenge (Anfuehrungs-
 * zeichen quoten, doppelte Anfuehrungszeichen escapen), reicht fuer die zwei
 * schlichten Datumsspalten, die dieser Import wirklich liest.
 */
function splitCsvLine(line, delimiter) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Datum eines Import-Feldes normalisieren: YYYY-MM-DD bleibt, wie es ist;
 * DD.MM.YYYY (deutscher Excel-Export, wie schon beim Trennzeichen) wird
 * umgestellt. Alles andere ist kein Datum, das dieser Import kennt.
 * @returns {string|null}
 */
function normalizeImportDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// POST /cycle/import  (Perioden-Historie aus CSV)
// Body: { csv: string }. Alles-oder-nichts: eine einzige ungueltige Zeile
// verwirft den gesamten Import (Transaktion), mit einer Fehlerliste (max.
// IMPORT_MAX_ERRORS Eintraege) statt eines pauschalen Fehlertexts - passend
// zum bestehenden Import-Grundsatz dieser App (siehe z. B. den ICS-Import,
// calendar/subscriptions.js): entweder der Nutzer bekommt genau das, was die
// Datei versprach, oder gar nichts, nie eine stille Teilmenge.
router.post('/cycle/import', (req, res) => {
  try {
    const viewer = viewerId(req);
    const csv = req.body?.csv;
    if (typeof csv !== 'string' || !csv.trim()) {
      return badRequest(res, ['csv is required.']);
    }
    if (Buffer.byteLength(csv, 'utf8') > IMPORT_MAX_BYTES) {
      return badRequest(res, [`csv must be at most ${IMPORT_MAX_BYTES} bytes.`]);
    }

    const lines = csv.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
    if (!lines.length) return badRequest(res, ['csv contains no rows.']);

    const delimiter = detectCsvDelimiter(lines[0]);
    // Kopfzeilen-tolerant: eine erste Zelle "start_date" (Gross-/Kleinschreibung
    // egal) wird als Kopfzeile erkannt und uebersprungen - der eigene Export
    // (CYCLE_HEADER) traegt genau diesen Namen an erster Stelle.
    const firstCells = splitCsvLine(lines[0], delimiter);
    const hasHeader = String(firstCells[0] || '').toLowerCase() === 'start_date';
    const dataLines = hasHeader ? lines.slice(1) : lines;

    if (!dataLines.length) return badRequest(res, ['csv contains no data rows.']);
    if (dataLines.length > IMPORT_MAX_ROWS) {
      return badRequest(res, [`csv may contain at most ${IMPORT_MAX_ROWS} data rows.`]);
    }

    const parsedRows = [];
    const rowErrors = [];
    dataLines.forEach((line, i) => {
      const rowNum = i + 1;
      const cells = splitCsvLine(line, delimiter);
      const rawStart = cells[0];
      const rawEnd = cells[1];

      const startDate = normalizeImportDate(rawStart);
      if (!startDate) {
        rowErrors.push(`Row ${rowNum}: start_date "${rawStart || ''}" is not a valid date (expected YYYY-MM-DD or DD.MM.YYYY).`);
        return;
      }
      // v.date() prueft zusaetzlich Kalendergueltigkeit (kein 2026-02-30) -
      // dieselbe Pruefung wie POST /cycle/periods, kein zweiter Massstab hier.
      if (v.date(startDate, 'start_date', true).error) {
        rowErrors.push(`Row ${rowNum}: start_date "${rawStart}" is not a valid calendar date.`);
        return;
      }

      let endDate = null;
      if (rawEnd && String(rawEnd).trim()) {
        endDate = normalizeImportDate(rawEnd);
        if (!endDate || v.date(endDate, 'end_date').error) {
          rowErrors.push(`Row ${rowNum}: end_date "${rawEnd}" is not a valid date (expected YYYY-MM-DD or DD.MM.YYYY).`);
          return;
        }
        if (endDate < startDate) {
          rowErrors.push(`Row ${rowNum}: end_date must not be before start_date.`);
          return;
        }
      }

      parsedRows.push({ startDate, endDate });
    });

    if (rowErrors.length) {
      return res.status(400).json({
        error: 'CSV contains invalid rows; nothing was imported.',
        code: 400,
        errors: rowErrors.slice(0, IMPORT_MAX_ERRORS),
      });
    }

    const database = db.get();
    const cycleSettingsRow = database.prepare('SELECT default_visibility FROM cycle_settings WHERE user_id = ?').get(viewer);
    const visibility = cycleSettingsRow?.default_visibility || 'private';

    // Duplikat-Regel: eine Zeile, deren start_date einer bereits vorhandenen
    // Periode DIESES Nutzers entspricht, wird ÜBERSPRUNGEN (gezählt), nicht
    // als Fehler behandelt - Ueberlappungen darueber hinaus sind erlaubt
    // (weiche Warnung, keine Ablehnung; dieselbe Haltung wie beim manuellen
    // Eintragen, das Ueberlappungen ebenfalls nicht prueft). Zwei Zeilen der
    // Importdatei mit demselben start_date treffen dieselbe Regel: die erste
    // zaehlt, jede weitere gilt als "schon vorhanden" und wird ebenfalls
    // uebersprungen.
    const { imported, skipped } = database.transaction(() => {
      const existingStarts = new Set(
        database.prepare('SELECT start_date FROM cycle_periods WHERE user_id = ?').all(viewer).map((r) => r.start_date)
      );
      const insert = database.prepare(
        'INSERT INTO cycle_periods (user_id, start_date, end_date, visibility) VALUES (?, ?, ?, ?)'
      );
      let importedCount = 0;
      let skippedCount = 0;
      for (const row of parsedRows) {
        if (existingStarts.has(row.startDate)) { skippedCount++; continue; }
        insert.run(viewer, row.startDate, row.endDate, visibility);
        existingStarts.add(row.startDate);
        importedCount++;
      }
      return { imported: importedCount, skipped: skippedCount };
    })();

    // Sofort wirksam statt erst beim naechsten periodischen Lauf - gleiche
    // Erwartung wie nach jeder anderen Aenderung an cycle_periods in dieser
    // Datei (POST/PATCH/DELETE oben): ein Import verschiebt predictCycle()s
    // naechsten Periodenbeginn sofort.
    try {
      syncCycleRemindersForUser(database, viewer);
    } catch (err) {
      log.error('Error syncing cycle reminders after import:', err.message);
    }

    res.status(201).json({ data: { imported, skipped, errors: [] } });
  } catch (err) {
    log.error('Error importing cycle history:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
