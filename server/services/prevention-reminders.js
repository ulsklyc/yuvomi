/**
 * Modul: Vorsorge-Erinnerungen (Health)
 * Zweck: Soll-Zustand der `health_prevention_due`-Erinnerungen herstellen - PRO
 *        FÄLLIGEM DATENSATZ eine Zeile je Empfänger (Eigentümer plus jede
 *        betreuende Person, D6), statt einer einzigen Zeile pro Termin.
 * Abhängigkeiten: server/utils/reminder-schedule.js, server/services/prevention-due.js,
 *                 server/services/cycle-reminders.js (lacksHealth - dieselbe Frage,
 *                 nicht zweimal beantwortet, DECISIONS #2).
 *
 * WARUM EIN FAN-OUT UND KEIN EINFACHER SYNC WIE PANTRY/CYCLE: die Erinnerung
 * geht nicht nur an den Eigentümer, sondern an jede Person mit einer
 * Betreuungs-Zusage (`health_care_grants`) für ihn (D6, das eine neue
 * Datenschutz-Prinzip in diesem Feature). Vorbild ist deshalb NICHT
 * cycle-reminders.js allein, sondern zusätzlich
 * server/services/event-reminder-fanout.js (#921):
 *
 *   - EINE ZEILE JE EMPFÄNGER. Die Zeile des Eigentümers trägt
 *     `assigned_from = NULL`, die einer betreuenden Person
 *     `created_by = <Betreuende>, assigned_from = <betreute Person>` - je
 *     eigenes `pushed_at`/`dismissed`, das ist der ganze Grund für getrennte
 *     Zeilen statt einer Verteilung erst beim Versand.
 *   - EINE SELBST GESETZTE ZEILE WIRD NIE ÜBERSCHRIEBEN
 *     (`assigned_from IS NULL` bei einer NICHT-Eigentümer-Zeile) - dieselbe
 *     Regel wie beim Termin-Fan-out, hier vor allem defensiv: `health_prevention_due`
 *     ist eine ABGELEITETE Herkunft (server/routes/reminders.js#DERIVED_ENTITY_TYPES),
 *     der generische Erinnerungs-Router lehnt sie für jeden ab. Trotzdem prüft
 *     der Sync das genau wie sein Vorbild, statt sich auf diese Absperrung
 *     allein zu verlassen.
 *   - NEU GESCHRIEBEN WIRD NUR, WENN SICH DER ZEITPUNKT ÄNDERT - sonst risse ein
 *     Lauf alle paar Minuten `pushed_at`/`dismissed` zurück und dieselbe Meldung
 *     ginge immer wieder raus (gleiche Regel wie cycle-reminders.js).
 *   - EIN ENTZUG DER BETREUUNG RÄUMT DIE GEERBTE ZEILE AB. Der Sync liest die
 *     Betreuungs-Liste bei jedem Lauf frisch, ein entzogener Zugriff heilt sich
 *     also binnen einer Minute selbst - UND server/routes/health/caregivers.js
 *     ruft den Sync zusätzlich sofort nach `PUT /caregivers/:subjectId` auf,
 *     dieselbe "wirkt sofort"-Erwartung wie beim Zyklus-Einstellungs-Schreiben.
 *   - GEGATET JE EMPFÄNGER, NICHT NUR JE EIGENTÜMER: eine betreuende Person ohne
 *     Health-Zugriff (`resolvePermissions(...).modules.health === 'none'`)
 *     bekommt keine Zeile.
 *   - OPT-IN DURCH DEN EIGENTÜMER (`health_prevention_notify_caregivers`,
 *     server/routes/preferences.js), Standard AUS - dasselbe Muster wie
 *     `cycle_settings.notify_partner_user_id`: eine Betreuungs-Zusage
 *     (health_care_grants) regelt Lese-/Schreibrecht auf die Daten, nicht ob
 *     eine Push-Benachrichtigung mit dem Namen der betreuten Person und der
 *     Art des faelligen Eintrags auf einem fremden Geraet landet. Ohne
 *     Opt-in bekommt niemand eine geerbte Zeile, auch bei bestehender
 *     Betreuung nicht (Review #1256).
 *   - DER TEXT NENNT DIE BETREUTE PERSON NUR AUF DER GEERBTEN ZEILE
 *     (`assigned_from IS NOT NULL`) - server/services/notifications.js#preventionDueBody.
 */

import { reminderDateBefore } from '../utils/reminder-schedule.js';
import { todayKey } from '../utils/timezone.js';
import { createLogger } from '../logger.js';
import { computeDueForUser } from './prevention-due.js';
import { lacksHealth } from './cycle-reminders.js';

const log = createLogger('PreventionReminders');
const ENTITY_TYPE = 'health_prevention_due';

/** Existierende Zeile eines Empfängers zu einem Datensatz - höchstens eine je (entity, Empfänger, Herkunft). */
function findRow(database, entityId, recipientId, assignedFrom) {
  return assignedFrom === null
    ? database.prepare(`
        SELECT id, remind_at FROM reminders
        WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND assigned_from IS NULL
      `).get(ENTITY_TYPE, entityId, recipientId)
    : database.prepare(`
        SELECT id, remind_at FROM reminders
        WHERE entity_type = ? AND entity_id = ? AND created_by = ? AND assigned_from = ?
      `).get(ENTITY_TYPE, entityId, recipientId, assignedFrom);
}

/** Legt die Zeile eines Empfängers an oder lässt sie unangetastet, wenn der Zeitpunkt gleich bleibt. */
function upsertRow(database, entityId, recipientId, remindAt, assignedFrom) {
  const existing = findRow(database, entityId, recipientId, assignedFrom);
  if (existing) {
    if (existing.remind_at === remindAt) return; // unveraendert - pushed_at/dismissed bleiben stehen
    database.prepare('DELETE FROM reminders WHERE id = ?').run(existing.id);
  }
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES (?, ?, ?, ?, ?)
  `).run(ENTITY_TYPE, entityId, remindAt, recipientId, assignedFrom);
}

function dropRow(database, entityId, recipientId, assignedFrom) {
  const existing = findRow(database, entityId, recipientId, assignedFrom);
  if (existing) database.prepare('DELETE FROM reminders WHERE id = ?').run(existing.id);
}

/** Soll-Zustand für EINEN fälligen Datensatz herstellen: Eigentümer-Zeile plus Betreuungs-Fan-out. */
function syncRecordReminder(database, item, subjectId, subjectHasHealth, caregiverIds) {
  const entityId = item.record_id;
  const remindAt = reminderDateBefore(item.due_on, item.reminder_offset_days);

  if (subjectHasHealth) {
    upsertRow(database, entityId, subjectId, remindAt, null);
  } else {
    dropRow(database, entityId, subjectId, null);
  }

  const wanted = new Set(caregiverIds);
  const currentlyInherited = database.prepare(`
    SELECT created_by FROM reminders
    WHERE entity_type = ? AND entity_id = ? AND assigned_from = ?
  `).all(ENTITY_TYPE, entityId, subjectId).map((r) => r.created_by);

  // Betreuung entzogen oder Health-Zugriff verloren: geerbte Zeile abräumen.
  for (const caregiverId of currentlyInherited) {
    if (!wanted.has(caregiverId)) dropRow(database, entityId, caregiverId, subjectId);
  }

  for (const caregiverId of caregiverIds) {
    // Eine selbst gesetzte Zeile (assigned_from IS NULL) wird nie überschrieben
    // und die Person wird für diesen Datensatz übersprungen - siehe Modulkopf.
    if (findRow(database, entityId, caregiverId, null)) continue;
    upsertRow(database, entityId, caregiverId, remindAt, subjectId);
  }
}

/**
 * Soll-Zustand für EINE Person (Eigentümer aller betroffenen Datensätze)
 * herstellen. Aufgerufen vom periodischen Voll-Sync, sofort nach dem
 * Schreiben eines Vorsorge-Datensatzes und sofort nach
 * `PUT /caregivers/:subjectId` - dieselbe "wirkt sofort"-Erwartung wie überall
 * sonst in diesem Modul.
 *
 * @param {object} database
 * @param {number} subjectId
 * @param {Date} [now]
 */
export function syncPreventionRemindersForSubject(database, subjectId, now = new Date()) {
  database.transaction(() => {
    const today = todayKey(database, now);
    const items = computeDueForUser(database, subjectId, today);
    const wantedRecordIds = new Set(items.map((i) => i.record_id));

    // Zeilen abräumen, deren Datensatz nicht mehr der "fällige" ist (ein
    // neuerer Datensatz desselben Typs ist eingetragen worden, das Intervall
    // ist entfallen, o.ä.). Der Datensatz existiert hier noch - für einen
    // GELÖSCHTEN Datensatz siehe syncAllPreventionReminders() (dort kann
    // dieses JOIN den Eigentümer nicht mehr auflösen).
    const existingRows = database.prepare(`
      SELECT r.id, r.entity_id FROM reminders r
      JOIN health_prevention_records pr ON pr.id = r.entity_id
      WHERE r.entity_type = ? AND pr.user_id = ?
    `).all(ENTITY_TYPE, subjectId);
    for (const row of existingRows) {
      if (!wantedRecordIds.has(row.entity_id)) {
        database.prepare('DELETE FROM reminders WHERE id = ?').run(row.id);
      }
    }

    const subjectHasHealth = !lacksHealth(database, subjectId);
    // Opt-in des Eigentuemers - siehe Modulkopf. Derselbe sync_config-
    // Schluessel wie server/routes/preferences.js#cfgUserSet schreibt
    // ('health_prevention_notify_caregivers:user:<id>'), hier direkt gelesen
    // statt ueber die Route (gleiches Muster wie fasting.js#clockMode).
    const notifyCaregivers = database.prepare(
      'SELECT value FROM sync_config WHERE key = ?'
    ).get(`health_prevention_notify_caregivers:user:${subjectId}`)?.value === '1';
    const caregiverIds = notifyCaregivers ? database.prepare(
      'SELECT caregiver_id FROM health_care_grants WHERE subject_id = ?'
    ).all(subjectId).map((r) => r.caregiver_id).filter((id) => !lacksHealth(database, id)) : [];

    for (const item of items) {
      syncRecordReminder(database, item, subjectId, subjectHasHealth, caregiverIds);
    }
  })();
}

/**
 * Für jede Person mit mindestens einem Vorsorge-Datensatz den Soll-Zustand
 * herstellen. Läuft periodisch, gleiche Stelle wie Vorrat/Zyklus/Geburtstag
 * (server/services/notifications.js#processDueNotifications).
 *
 * @param {object} database
 * @param {Date} [now]
 */
export function syncAllPreventionReminders(database, now = new Date()) {
  // Ein gelöschter Datensatz lässt `entity_id` ins Leere zeigen -
  // `reminders.entity_id` hat keine FK (wie bei jeder anderen abgeleiteten
  // Herkunft in dieser App) - also räumt der Voll-Sync das hier direkt ab,
  // statt sich allein auf die Teardown-Stelle im Schreibweg zu verlassen.
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = ?
      AND entity_id NOT IN (SELECT id FROM health_prevention_records)
  `).run(ENTITY_TYPE);

  const subjectIds = database.prepare(
    'SELECT DISTINCT user_id FROM health_prevention_records'
  ).all().map((r) => r.user_id);

  for (const subjectId of subjectIds) {
    try {
      syncPreventionRemindersForSubject(database, subjectId, now);
    } catch (err) {
      log.error(`Prevention reminder sync failed for user ${subjectId}:`, err?.message || err);
    }
  }
}
