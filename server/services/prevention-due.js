/**
 * Modul: Vorsorge (Health) - Fälligkeits-Berechnung
 * Zweck: "wann ist die nächste Auffrischung fällig" als EINE Rechnung, die
 *        sowohl `GET /prevention/due` (server/routes/health/prevention.js) als
 *        auch der Erinnerungs-Sync (server/services/prevention-reminders.js)
 *        lesen - eine zweite Abschrift der Fälligkeits-Mathematik im Sync
 *        wäre eine zweite Wahrheit (DECISIONS #2).
 * Abhängigkeiten: server/utils/interval-date.js
 */

import { addMonthsClamped } from '../utils/interval-date.js';

/** Vorlauf in Tagen, wenn ein Datensatz keinen eigenen trägt. */
export const DEFAULT_REMINDER_OFFSET_DAYS = 30;

/**
 * Fällige/anstehende Einträge EINER Person: je Typ mit mindestens einem
 * Datensatz der jüngste Eintrag, daraus das nächste Fälligkeitsdatum (D5 -
 * "die Erinnerung hängt am jüngsten Datensatz, nicht an einem neuen Anker").
 *
 * Ein Typ ohne Intervall (`default_interval_months IS NULL`, "einmalig") und
 * ein Datensatz ohne ableitbares nächstes Datum (kein `next_due_on`-Override,
 * kein Intervall) liefern nichts - es gibt nichts, worauf zu warten wäre.
 *
 * Datensätze, deren Typ inzwischen gelöscht wurde (`type_id IS NULL`, die
 * `name`-Momentaufnahme bleibt), tragen bewusst keine Fälligkeit mehr: ohne
 * Typ gibt es kein `default_interval_months`, an dem sich "als nächstes fällig"
 * festmachen ließe, und das Löschen des Typs war die bewusste Entscheidung des
 * Haushalts, diese Sorte Eintrag nicht mehr zu verfolgen.
 *
 * @param {object} database
 * @param {number} userId
 * @param {string} todayKeyValue - YYYY-MM-DD, nur für `days_left`
 */
export function computeDueForUser(database, userId, todayKeyValue) {
  const types = database.prepare(
    'SELECT * FROM health_prevention_types ORDER BY sort_order ASC, id ASC'
  ).all();

  const items = [];
  for (const type of types) {
    const record = database.prepare(`
      SELECT * FROM health_prevention_records
      WHERE user_id = ? AND type_id = ?
      ORDER BY given_on DESC, id DESC LIMIT 1
    `).get(userId, type.id);
    if (!record) continue;

    const intervalMonths = record.interval_months ?? type.default_interval_months;
    const dueOn = record.next_due_on
      || (intervalMonths != null ? addMonthsClamped(record.given_on, intervalMonths) : null);
    if (!dueOn) continue;

    const offsetDays = record.reminder_offset_days ?? DEFAULT_REMINDER_OFFSET_DAYS;
    const daysLeft = Math.round(
      (Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${todayKeyValue}T00:00:00Z`)) / 86_400_000
    );

    items.push({
      type_id: type.id,
      type_name: type.name,
      kind: type.kind,
      icon: type.icon,
      record_id: record.id,
      visibility: record.visibility,
      last_given_on: record.given_on,
      interval_months: intervalMonths,
      due_on: dueOn,
      reminder_offset_days: offsetDays,
      days_left: daysLeft,
    });
  }
  return items;
}
