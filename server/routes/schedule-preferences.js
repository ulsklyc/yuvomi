/**
 * Modul: Schichtplan — persönliche Einstellungen
 * Zweck: Drei Werte je Nutzer, die alle "wie rechnet die Statistik ueber
 *        MICH" beantworten: der Schicht-Erinnerungs-Vorlauf (Minuten vor
 *        Schichtbeginn), die Wochenstunden, gegen die die Ueberstundenkarte
 *        misst, und ob diese Karte ueberhaupt rechnet (S-24, UX-Audit).
 *        Eigene Datei statt in routes/schedule.js: server/services/
 *        schedule-reminders.js importiert scheduleData aus routes/schedule.js
 *        für den Sync - ein Rückimport hier hätte einen Zyklus ergeben
 *        (gleicher Grund wie routes/schedule-feed.js).
 *        Ein unerwarteter Fehler geht an den zentralen Fehlerhandler (#2810).
 *
 * PERSONENBEZOGEN, NICHT HAUSHALTWEIT: ein Teilzeit- und ein
 * Vollzeit-Mitglied im selben Haushalt haben unterschiedliche Sollstunden,
 * und wessen Schicht wann anfaengt, betrifft auch nur die eine Person.
 *
 * Keine Admin-Gate: alle drei Werte haengen an der eigenen users-Zeile, jeder
 * angemeldete Nutzer stellt nur seine eigenen ein.
 *
 * EIN EIGENER SCHALTER STATT weeklyHours: 0 ALS "AUS" (S-24, PLAN.md
 * Entscheidung D-C): 0 Wochenstunden ist ohnehin keine gueltige Angabe
 * (das Schema weist sie ab), und ein wiederverwendeter Sonderwert zwingt
 * jede lesende Stelle, sich zu merken, dass 0 hier etwas anderes bedeutet als
 * ueberall sonst eine Zahl. `overtimeEnabled` beantwortet die Frage direkt.
 */

import express from 'express';
import { validateRequest } from '../api/validate-request.ts';
import * as db from '../db.js';
import { syncScheduleRemindersForUser } from '../services/schedule-reminders.js';

const router = express.Router();

function getUserId(req) {
  const candidates = [req.authUserId, req.user?.id, req.session?.userId];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

// GET /api/v1/schedule/preferences → eigener Vorlauf + eigene Wochenstunden +
// ob Ueberstunden ueberhaupt verfolgt werden (alle drei null/1 = Voreinstellung:
// Erinnerung aus, 40 Stunden, Verfolgung an)
router.get('/', validateRequest(), (req, res) => {
  const row = db.get().prepare(
    'SELECT schedule_reminder_offset_minutes AS m, schedule_weekly_hours AS h, schedule_overtime_enabled AS o FROM users WHERE id = ?'
  ).get(getUserId(req));
  res.json({ data: { reminderOffsetMinutes: row?.m ?? null, weeklyHours: row?.h ?? null, overtimeEnabled: row?.o !== 0 } });
});

// PUT /api/v1/schedule/preferences { reminderOffsetMinutes?, weeklyHours?, overtimeEnabled? }
// Nur mitgeschickte Felder aendern sich - ein Aufrufer, der nur die
// Wochenstunden speichert, darf den Erinnerungs-Vorlauf nicht anfassen.
// Das Schema (server/openapi/paths/schedule.js) weist vor dem Handler ab, was
// keine ganze Zahl in den Grenzen aus services/schedule-fields.js oder `null`
// ist (Vorlauf 0 bis MAX_REMINDER_OFFSET_MINUTES, Wochenstunden
// MIN_WEEKLY_HOURS bis MAX_WEEKLY_HOURS), und einen Schalter, der kein
// Boolean ist (#2810).
router.put('/', validateRequest(), (req, res) => {
  const userId = getUserId(req);
  const body = req.body ?? {};
  const current = db.get().prepare(
    'SELECT schedule_reminder_offset_minutes AS m, schedule_weekly_hours AS h, schedule_overtime_enabled AS o FROM users WHERE id = ?'
  ).get(userId);

  const offsetMinutes = 'reminderOffsetMinutes' in body ? body.reminderOffsetMinutes : (current?.m ?? null);
  const weeklyHours = 'weeklyHours' in body ? body.weeklyHours : (current?.h ?? null);
  // S-24: kein null-Zustand wie bei den beiden Feldern oben - ein Schalter
  // ist immer eindeutig an oder aus, "noch nicht entschieden" gibt es hier
  // nicht (die GET-Antwort liest ein ungesetztes `null` bereits als "an").
  const overtimeEnabled = 'overtimeEnabled' in body ? body.overtimeEnabled : current?.o !== 0;

  db.get().prepare('UPDATE users SET schedule_reminder_offset_minutes = ?, schedule_weekly_hours = ?, schedule_overtime_enabled = ? WHERE id = ?')
    .run(offsetMinutes, weeklyHours, overtimeEnabled ? 1 : 0, userId);
  // Sofort wirksam statt erst beim naechsten periodischen Lauf - gleiche
  // Erwartung wie beim Vorrat (server/routes/pantry.js ruft die Ein-
  // Artikel-Fassung direkt nach dem Speichern).
  syncScheduleRemindersForUser(db.get(), userId);
  res.json({ data: { reminderOffsetMinutes: offsetMinutes, weeklyHours, overtimeEnabled } });
});

export default router;
