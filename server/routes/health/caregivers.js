/**
 * Modul: Gesundheit (Health) - Betreuung (#584)
 * Zweck: Pflege und Auskunft der Betreuungs-Beziehungen (health_care_grants):
 *        wer darf für wen Gesundheitsdaten eintragen und sie dabei sehen.
 *
 * Gepflegt wird ausschließlich von Admins (Einstellungen → Familie); jedes
 * Mitglied darf abfragen, für wen es selbst eintragen darf, denn das Health-UI
 * braucht diese Auskunft, um den Erfassen-Knopf zu zeigen.
 */

import express from 'express';
import * as db from '../../db.js';
import { requireAdmin } from '../../middleware/require-admin.js';
import { log, viewerId, caredForIds } from './helpers.js';
import { syncPreventionRemindersForSubject } from '../../services/prevention-reminders.js';

const router = express.Router();

/**
 * GET /caregivers/me
 * IDs der Personen, für die der eingeloggte Nutzer eintragen darf.
 * Für jedes Mitglied zugänglich - es ist die Auskunft über die eigenen Rechte.
 */
router.get('/caregivers/me', (req, res) => {
  try {
    res.json({ data: caredForIds(viewerId(req)) });
  } catch (err) {
    log.error('Error listing own care grants:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

/**
 * GET /caregivers
 * Alle Beziehungen als { subject_id: [caregiver_id, ...] } für die Admin-UI.
 */
router.get('/caregivers', requireAdmin, (req, res) => {
  try {
    const rows = db.get().prepare(
      'SELECT subject_id, caregiver_id FROM health_care_grants ORDER BY subject_id, caregiver_id'
    ).all();
    const bySubject = {};
    for (const row of rows) {
      (bySubject[row.subject_id] ||= []).push(row.caregiver_id);
    }
    res.json({ data: bySubject });
  } catch (err) {
    log.error('Error listing care grants:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

/**
 * PUT /caregivers/:subjectId
 * Setzt die Betreuenden einer Person auf genau die übergebene Liste. Ein leeres
 * Array entzieht die Betreuung - Löschen ist damit derselbe Weg wie Ändern und
 * braucht keine eigene Route.
 */
router.put('/caregivers/:subjectId', requireAdmin, (req, res) => {
  try {
    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ error: 'Ungültige Person.', code: 400 });

    const subject = db.get().prepare('SELECT id FROM users WHERE id = ?').get(subjectId);
    if (!subject) return res.status(404).json({ error: 'Person nicht gefunden.', code: 404 });

    const raw = req.body?.caregiver_ids;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'caregiver_ids muss eine Liste sein.', code: 400 });
    }

    // Doppelte Einträge und die Person selbst fallen still heraus: beides wäre
    // kein Fehler des Aufrufers, sondern eine Liste, die dasselbe zweimal oder
    // etwas Wirkungsloses sagt.
    const ids = [...new Set(raw.map((x) => parseInt(x, 10)).filter(Boolean))]
      .filter((id) => id !== subjectId);

    if (ids.length) {
      const placeholders = ids.map(() => '?').join(', ');
      const found = db.get().prepare(
        `SELECT id FROM users WHERE id IN (${placeholders})`
      ).all(...ids);
      if (found.length !== ids.length) {
        return res.status(400).json({ error: 'Unbekannte Person in caregiver_ids.', code: 400 });
      }
    }

    const insert = db.get().prepare(
      'INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)'
    );
    const tx = db.get().transaction(() => {
      db.get().prepare('DELETE FROM health_care_grants WHERE subject_id = ?').run(subjectId);
      for (const id of ids) insert.run(subjectId, id);
    });
    tx();

    // Wirkt sofort: eine entzogene Betreuung darf nicht bis zum naechsten
    // periodischen Lauf weiter eine Vorsorge-Erinnerung an die betroffene
    // Person schicken (D6) - dieselbe Erwartung wie beim Zyklus-
    // Einstellungs-Schreiben.
    try { syncPreventionRemindersForSubject(db.get(), subjectId); } catch (err) {
      log.error('Error re-syncing prevention reminders after care grant change:', err.message);
    }

    res.json({ data: { subject_id: subjectId, caregiver_ids: ids } });
  } catch (err) {
    log.error('Error saving care grants:', err.message);
    res.status(500).json({ error: 'Internal error.', code: 500 });
  }
});

export default router;
