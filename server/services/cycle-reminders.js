/**
 * Modul: Zyklus-Erinnerungen (Health)
 * Zweck: Soll-Zustand der `cycle_period`/`cycle_log_nudge`-Erinnerungen für
 *        EINEN Nutzer herstellen - höchstens eine Zeile je Art, nicht ein
 *        rollierendes Fenster wie beim Schichtplan: der Zyklus hat je Nutzer
 *        immer nur EINEN nächsten vorhergesagten Periodenbeginn und EIN
 *        "heute", nicht viele Tage mit je eigenem Inhalt. Dazu gehört auch
 *        eine optionale VIERTE Zeilen-Art ('partner_period', teilt
 *        sich `entity_type` mit 'period_predicted' - siehe
 *        syncPartnerReminder()): eine Benachrichtigung für eine andere Person
 *        (`cycle_settings.notify_partner_user_id`), die der Eigentümer
 *        veröffentlicht, ohne dass die Partnerperson selbst etwas einräumt.
 * Abhängigkeiten: server/utils/reminder-schedule.js, public/utils/health-cycle.js
 *                 (dieselbe Vorhersage-Mathematik wie der Zyklus-Tab selbst -
 *                 ein zweites Rechenmodell hier wäre eine zweite Wahrheit).
 *
 * WARUM EIN ANKER NÖTIG IST: weder der vorhergesagte nächste Periodenbeginn
 * (predictCycle(), rein berechnet) noch "heute noch nicht geloggt" (die
 * Abwesenheit einer cycle_day_logs-Zeile) ist eine gespeicherte Zeile mit
 * eigener Id. `cycle_reminder_anchors` (Migration 177, `kind` seit Migration
 * 213 auch 'partner_period') gibt beiden einen stabilen Ankerpunkt je
 * (Nutzer, Datum, Art), an den reminders.entity_id zeigen kann - gleicher
 * Grund wie schedule_reminder_entries für Musterzyklus-Tage (Schedule v3).
 *
 * GLEICHE GRUNDFORM WIE server/services/pantry-reminders.js: löschen, was
 * gegenstandslos wurde, ergänzen, was fehlt, bestehende Zeilen mit gleichem
 * Zeitpunkt unangetastet lassen (kein Zurücksetzen von pushed_at/dismissed
 * bei jedem Lauf). remind_at nutzt reminder-schedule.js (09:00, dieselbe
 * Tageszeit wie jede andere datumsbasierte Erinnerung in dieser App) und
 * denselben "Datums-, nicht Uhrzeit-Schnitt" wie Pantrys Voll-Sync: ein
 * Zieltag, der heute noch nicht vorbei ist, bekommt seine Erinnerung auch
 * dann, wenn 09:00 UTC schon verstrichen ist - sie geht dann in diesem
 * Durchgang sofort raus, statt bis morgen zu warten.
 */

import { reminderDateBefore } from '../utils/reminder-schedule.js';
import { todayKey } from '../utils/timezone.js';
import { resolvePermissions } from '../permissions.js';
import { createLogger } from '../logger.js';
import { predictCycle } from '../../public/utils/health-cycle.js';
import { healthCycleViews } from '../routes/preferences.js';
import { isHouseholdMember } from './household-members.js';
import { listHouseholdMembers } from './member-email.js';

// Einzige Familienrolle, die als Kind gilt (server/auth.js FAMILY_ROLES:
// dad/mom/parent/child/grandparent/relative/other) - eine Konstante statt
// eines String-Literals an jeder Vergleichsstelle, falls das je mehr als eine
// Rolle wird.
const CHILD_FAMILY_ROLE = 'child';

const log = createLogger('CycleReminders');

/**
 * Zyklus-Tab freigeschaltet? Die Regel (Haushalts-Default, persönliches
 * Opt-out, UND statt Override, #760) lebt in EINER exportierten Funktion,
 * healthCycleViews() in server/routes/preferences.js - dieselbe Fassung, die
 * auch die Präferenzen-Routen beantworten, statt einer zweiten Abschrift
 * derselben Regel hier.
 */
function cycleTabEnabled(database, userId) {
  return healthCycleViews(userId).health_cycle_effective;
}

/** Fehlt diesem Nutzer der Zugriff auf das Health-Modul überhaupt? */
function lacksHealth(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return true;
  return resolvePermissions(database, user).modules.health === 'none';
}

/**
 * Ist `candidateId` ein zulässiges Ziel für die Partner-Benachrichtigung?
 * Echtes Haushaltsmitglied MIT Zugriff auf das Health-Modul, kein Kind
 * (`family_role = 'child'` - die einzige kindliche Rolle in `FAMILY_ROLES`,
 * server/auth.js). Der EIGENE Zyklus-Tab-Status der Partnerperson zählt
 * bewusst NICHT mehr dazu: die typische Empfängerin hat selbst
 * keinen Zyklus und den Tab darum abgeschaltet - genau das darf sie nicht von
 * der Meldung ausschließen. `cycleTabEnabled()` bleibt trotzdem oben stehen,
 * für das EIGENE Gate der Eigentümer-Erinnerungen (syncCycleRemindersForUser).
 *
 * EINE Funktion für den Sync (unten) UND die Auswahlliste in GET /cycle/settings
 * (server/routes/health/cycle.js) - dieselbe Regel an beiden Stellen, statt
 * einer zweiten Abschrift, die auseinanderlaufen könnte (siehe DECISIONS.md
 * "eine Regel lebt an einem Ort").
 */
export function isEligibleCyclePartner(database, candidateId) {
  const row = database.prepare('SELECT family_role FROM users WHERE id = ?').get(candidateId);
  if (!row || row.family_role === CHILD_FAMILY_ROLE) return false;
  return isHouseholdMember(candidateId, { db: database }) && !lacksHealth(database, candidateId);
}

/**
 * Andere Haushaltsmitglieder, die als Partner-Ziel taugen würden (nicht die
 * anfragende Person selbst) - für die Auswahlliste, exakt gefiltert mit
 * `isEligibleCyclePartner()` oben.
 */
export function eligibleCyclePartners(database, viewerId) {
  return listHouseholdMembers({ db: database })
    .filter((m) => m.id !== viewerId && isEligibleCyclePartner(database, m.id))
    .map((m) => ({ id: m.id, display_name: m.display_name }));
}

/** Anker + zugehörige Erinnerung einer Art abräumen, falls vorhanden. */
function dropAnchorAndReminder(database, userId, kind, entityType) {
  const anchor = database.prepare('SELECT id FROM cycle_reminder_anchors WHERE user_id = ? AND kind = ?').get(userId, kind);
  if (!anchor) return;
  database.prepare('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ?').run(entityType, anchor.id);
  database.prepare('DELETE FROM cycle_reminder_anchors WHERE id = ?').run(anchor.id);
}

/**
 * Soll-Zustand für EINE Erinnerungsart herstellen: Anker auf `targetDate`
 * bringen (alten abräumen, wenn sich das Zieldatum verschoben hat) und die
 * `reminders`-Zeile nachziehen.
 *
 * `recipientUserId` (Standard: `userId`) ist, wer die Meldung EMPFAENGT
 * (reminders.created_by - siehe notifications.js#processDueNotifications,
 * das darüber Push-Ziel/Kanäle auflöst). Der Anker selbst bleibt immer bei
 * `userId` verankert, weil `anchor_date` dessen Datum ist (Partner-Erinnerung:
 * der Anker gehört weiter dem Eigentümer, empfangen tut sie die Partnerperson).
 */
function upsertCycleReminder(database, userId, kind, entityType, targetDate, offsetDays, today, recipientUserId = userId) {
  const remindAt = reminderDateBefore(targetDate, offsetDays);

  const existingAnchor = database.prepare(
    'SELECT id, anchor_date FROM cycle_reminder_anchors WHERE user_id = ? AND kind = ?'
  ).get(userId, kind);
  if (existingAnchor && existingAnchor.anchor_date !== targetDate) {
    database.prepare('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ?').run(entityType, existingAnchor.id);
    database.prepare('DELETE FROM cycle_reminder_anchors WHERE id = ?').run(existingAnchor.id);
  }

  // DATUMS-, NICHT UHRZEIT-SCHNITT (siehe Modulkommentar): ein Zieltag vor
  // heute ist wirklich vorbei, ein Zieltag von heute bekommt seine Erinnerung
  // auch nach 09:00 noch, nur eben sofort in diesem Durchgang.
  if (targetDate < today) return;

  const anchorId = database.prepare(`
    INSERT INTO cycle_reminder_anchors (user_id, anchor_date, kind) VALUES (?, ?, ?)
    ON CONFLICT(user_id, anchor_date, kind) DO UPDATE SET anchor_date = excluded.anchor_date
    RETURNING id
  `).get(userId, targetDate, kind).id;

  const existingReminder = database.prepare(
    'SELECT id, remind_at, created_by FROM reminders WHERE entity_type = ? AND entity_id = ?'
  ).get(entityType, anchorId);
  if (existingReminder) {
    // UNANGETASTET, wenn Zeitpunkt UND Empfänger gleich bleiben - sonst risse
    // ein Lauf alle paar Minuten pushed_at/dismissed zurück und dieselbe
    // Meldung ginge immer wieder raus. Ein Empfängerwechsel (notify_partner_
    // user_id wechselt von A zu B bei unverändertem Vorlauf, oder umgekehrt)
    // ist dabei KEIN unveränderter Lauf: der Anker bleibt derselbe, also griffe
    // kein Abräum-Pfad - ohne diesen Vergleich bliebe die Zeile bei A stehen,
    // A bekäme die fremde Meldung weiter, und B nie eine.
    if (existingReminder.remind_at === remindAt && existingReminder.created_by === recipientUserId) return;
    database.prepare('DELETE FROM reminders WHERE id = ?').run(existingReminder.id);
  }
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)
  `).run(entityType, anchorId, remindAt, recipientUserId);
}

/**
 * Vorhergesagter nächster Periodenbeginn, `remind_period_days_before` Tage
 * vorher. Rechnet mit derselben predictCycle()-Mathematik wie der Zyklus-Tab
 * selbst (inklusive der Vertrauensschwelle aus Phase 0 -
 * MIN_HISTORY_GAPS - und dem Schwangerschafts-Stopp).
 *
 * `prediction` kommt fertig vom Aufrufer (syncCycleRemindersForUser) - dieselbe
 * Vorhersage, mit der auch syncPartnerReminder() rechnet: EIN Periods-Query,
 * EIN predictCycle()-Aufruf je Sync-Durchlauf statt zweier identischer.
 */
function syncPeriodReminder(database, userId, settings, today, prediction) {
  const daysBefore = settings?.remind_period_days_before;
  if (daysBefore == null) {
    dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
    return;
  }

  if (!prediction.hasData || prediction.isPregnant || !prediction.nextStart) {
    dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
    return;
  }

  upsertCycleReminder(database, userId, 'period_predicted', 'cycle_period', prediction.nextStart, daysBefore, today);
}

/**
 * Partner-Benachrichtigung (Eigentümer-Opt-in): EINE zusätzliche
 * Erinnerungs-Zeile FÜR DIE PARTNERPERSON (`notify_partner_user_id`), sofern
 * der Eigentümer sie in den eigenen cycle_settings eingetragen hat. Rechnet
 * mit derselben predictCycle()-Basis wie die eigene Perioden-Erinnerung oben -
 * kein zweites Vorhersagemodell für dieselbe Frage.
 *
 * EIGENE ANKER-ART ('partner_period', Migration 213): der Anker gehört
 * weiterhin dem EIGENTÜMER (anchor_date ist dessen vorhergesagter
 * Periodenbeginn) - anders waeren zwei verschiedene reminders-Zeilen (die
 * eigene und die der Partnerperson) nicht sauber auseinanderzuhalten, wenn
 * beide auf denselben Anker zeigen wuerden. `recipientUserId` an
 * upsertCycleReminder() sorgt dafuer, dass `reminders.created_by` - und damit
 * das Push-Ziel, siehe notifications.js - die Partnerperson ist, nicht der
 * Eigentümer. `entity_type` bleibt bewusst 'cycle_period': eine Erinnerung
 * für einen fremden Periodenbeginn ist inhaltlich dieselbe Herkunft wie die
 * eigene, und die Wiederverwendung braucht keinen dritten Eintrag in den drei
 * Herkunfts-Registern (server/routes/reminders.js, public/reminders.js,
 * server/services/notifications.js).
 *
 * `prediction` kommt fertig vom Aufrufer (syncCycleRemindersForUser) - dieselbe
 * Vorhersage wie syncPeriodReminder() oben, EIN Periods-Query/predictCycle()-
 * Aufruf je Durchlauf statt zweier identischer.
 *
 * ABRAEUM-REGEL: die Partnerperson muss weiterhin ein echtes
 * Haushaltsmitglied mit Zugriff auf das Health-Modul sein und darf kein Kind
 * sein (`isEligibleCyclePartner()` oben) - verliert SIE das (nicht nur der
 * Eigentuemer), faellt die Meldung weg, auch wenn die Einstellung des
 * Eigentuemers selbst unangetastet blieb. Der EIGENE Zyklus-Tab-Status der
 * Partnerperson zaehlt bewusst NICHT mehr dazu: die typische Empfaengerin hat
 * selbst keinen Zyklus und den Tab darum abgeschaltet, und genau das darf sie
 * nicht von der Meldung ausschliessen. Ein voller periodischer Durchlauf
 * (syncAllCycleReminders) faengt eine Aenderung auf der Partnerseite auf,
 * genau wie er das fuer jede andere entzogene Berechtigung schon tut.
 *
 * PRIVATSPHAERE: `entity_title` (siehe notifications.js/reminders.js) ist bei
 * dieser Art wie bei der eigenen dasselbe rohe `anchor_date` - nie Flow,
 * Symptome oder sonstiger Log-Inhalt. Die Partnerperson bekommt dadurch kein
 * Lese-Recht auf die Zyklus-Daten des Eigentuemers: keine Route aendert sich,
 * es entsteht nur diese eine datumsscharfe Meldung.
 */
function syncPartnerReminder(database, userId, settings, today, prediction) {
  const partnerId = settings?.notify_partner_user_id;
  const daysBefore = settings?.notify_partner_days_before;
  if (!partnerId || daysBefore == null) {
    dropAnchorAndReminder(database, userId, 'partner_period', 'cycle_period');
    return;
  }

  if (!isEligibleCyclePartner(database, partnerId)) {
    dropAnchorAndReminder(database, userId, 'partner_period', 'cycle_period');
    return;
  }

  if (!prediction.hasData || prediction.isPregnant || !prediction.nextStart) {
    dropAnchorAndReminder(database, userId, 'partner_period', 'cycle_period');
    return;
  }

  upsertCycleReminder(database, userId, 'partner_period', 'cycle_period', prediction.nextStart, daysBefore, today, partnerId);
}

/**
 * Täglicher Hinweis, den heutigen Tag einzutragen - entfällt, sobald für
 * heute schon ein Log vorliegt (gleich, ob mit oder ohne Inhalt: die Zeile
 * existiert, die Frage ist beantwortet).
 */
function syncLogNudgeReminder(database, userId, settings, today) {
  if (!settings?.remind_log_daily) {
    dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
    return;
  }

  const hasLogToday = database.prepare('SELECT 1 FROM cycle_day_logs WHERE user_id = ? AND log_date = ?').get(userId, today);
  if (hasLogToday) {
    dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
    return;
  }

  upsertCycleReminder(database, userId, 'log_nudge', 'cycle_log_nudge', today, 0, today);
}

/**
 * Soll-Zustand für EINEN Nutzer herstellen. Aufgerufen sowohl vom
 * periodischen Voll-Sync als auch sofort nach einer Einstellungsänderung
 * (server/routes/health/cycle.js), gleiche Erwartung wie überall sonst: eine
 * Änderung wirkt sofort, nicht erst beim nächsten Durchgang.
 *
 * @param {object} database
 * @param {number} userId
 * @param {Date} [now]
 */
export function syncCycleRemindersForUser(database, userId, now = new Date()) {
  // TRANSAKTIONAL, weil upsertCycleReminder() "den einen" Anker je (Nutzer,
  // Art) per .get() liest und dann loescht/einfuegt: das Schema erzwingt nur
  // UNIQUE(user_id, anchor_date, kind), nicht UNIQUE(user_id, kind). Ein
  // Abbruch zwischen Lesen und Schreiben liesse sonst einen zweiten Anker
  // zurueck, den kein spaeterer Lauf mehr sieht (er sucht ja nur "den einen").
  database.transaction(() => {
    if (lacksHealth(database, userId) || !cycleTabEnabled(database, userId)) {
      dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
      dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
      dropAnchorAndReminder(database, userId, 'partner_period', 'cycle_period');
      return;
    }

    const today = todayKey(database, now);
    const settings = database.prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(userId) || {};
    // EIN Query, EINE Vorhersage fuer beide Perioden-Erinnerungsarten (eigene
    // und Partner) - syncPeriodReminder() und syncPartnerReminder() rechneten
    // vorher je einmal identisch mit denselben cycle_periods und derselben
    // predictCycle()-Basis nach.
    const periods = database.prepare('SELECT * FROM cycle_periods WHERE user_id = ? ORDER BY start_date ASC').all(userId);
    const prediction = predictCycle(periods, settings, today);
    syncPeriodReminder(database, userId, settings, today, prediction);
    syncLogNudgeReminder(database, userId, settings, today);
    syncPartnerReminder(database, userId, settings, today, prediction);
  })();
}

/**
 * Räumt verwaiste Zyklus-Erinnerungen weg: eine `reminders`-Zeile, deren
 * Anker (`entity_id` → `cycle_reminder_anchors.id`) nicht mehr existiert.
 *
 * Der Normalfall räumt das selbst ab (dropAnchorAndReminder() löscht immer
 * beides zusammen) - aber ein ADMIN KANN DEN EIGENTÜMER EINES ANKERS LÖSCHEN.
 * `cycle_reminder_anchors.user_id` hat ON DELETE CASCADE, die Anker-Zeile
 * verschwindet also mit. Die zugehörige `reminders`-Zeile aber gehört
 * (`created_by`) bei einer Partner-Erinnerung NICHT dem Eigentümer, sondern
 * der Partnerperson - und `reminders.entity_id` trägt keinen Fremdschlüssel
 * (dasselbe polymorphe Muster wie jede andere Erinnerungs-Herkunft), die
 * Kaskade erreicht sie also nicht. Ohne dieses Aufräumen behielte die
 * Partnerperson für immer eine Erinnerung auf ein Datum, das es nicht mehr
 * gibt ("Nächste Periode" mit leerem Titel). Läuft vor jedem vollen
 * Sync-Durchlauf, nicht nur bei Bedarf - billig (ein Index-Scan über zwei
 * kleine Tabellen) und macht eine künftige zweite Löschstelle für Anker
 * überflüssig, an die dieses Aufräumen sonst erneut angehängt werden müsste.
 */
function cleanupOrphanedCycleReminders(database) {
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type IN ('cycle_period', 'cycle_log_nudge')
      AND entity_id NOT IN (SELECT id FROM cycle_reminder_anchors)
  `).run();
}

/**
 * Für jeden Nutzer mit einer aktivierten Zyklus-Erinnerung (oder noch
 * bestehenden Ankern einer inzwischen abgeschalteten) den Soll-Zustand
 * herstellen. Läuft periodisch, gleiche Stelle wie der Vorrats- und
 * Geburtstags-Sync (server/services/notifications.js#processDueNotifications).
 *
 * @param {object} database
 * @param {Date} [now]
 */
export function syncAllCycleReminders(database, now = new Date()) {
  cleanupOrphanedCycleReminders(database);

  const withSettings = database.prepare(`
    SELECT user_id FROM cycle_settings
    WHERE remind_period_days_before IS NOT NULL OR remind_log_daily = 1 OR notify_partner_user_id IS NOT NULL
  `).all();
  // Bereits abgeschaltete Konten können trotzdem noch Anker/Erinnerungen von
  // einer früheren Einstellung tragen (Zyklus-Tab zwischenzeitlich gesperrt,
  // Berechtigung entzogen) - die Gates in syncCycleRemindersForUser() räumen
  // sie ab, auch wenn diese Auswahl sie nicht träfe.
  const withAnchors = database.prepare('SELECT user_id FROM cycle_reminder_anchors GROUP BY user_id').all();
  const candidateIds = new Set([...withSettings.map((r) => r.user_id), ...withAnchors.map((r) => r.user_id)]);
  for (const userId of candidateIds) {
    try {
      syncCycleRemindersForUser(database, userId, now);
    } catch (err) {
      log.error(`Cycle reminder sync failed for user ${userId}:`, err?.message || err);
    }
  }
}
