/**
 * Modul: Wem eine Zahlungsaufgabe der Haushaltshilfe gehoert (R20)
 * Zweck: EINE Regel fuer die Laufzeit - den Check-in, der die Aufgabe anlegt,
 *        und das Bearbeiten, Auschecken, Bezahlen eines Besuchs, das eine alte
 *        Aufgabe nachzieht. Migration 250 (server/db.js) zog den offenen
 *        Altbestand mit einer EINGEFRORENEN Kopie dieser Regel nach; eine
 *        Migration importiert nie Laufzeit-Code (test:migrations-append-only).
 *        Aenderst du die Regel hier, bleibt 250, wie sie ist; der
 *        Aequivalenztest in test/test-payment-task-backfill.js zeigt dann
 *        die Abweichung und wird mit Begruendung angepasst.
 * Abhaengigkeiten: server/permissions.js, server/services/household-members.js
 *
 * WER DIE ZAHLUNGSAUFGABE SIEHT (Ulas 2026-10-17).
 *
 * Titel und Beschreibung nennen den Betrag, und die Aufgabe reist in jede
 * Flaeche, die Aufgaben ausliefert: Liste, Detail, Uebersicht, Suche, MCP, API
 * v1. Stand sie auf `all`, las ein Konto ohne `housekeeping_view_amounts` den
 * Lohn dort, wo die Haushaltshilfe ihn verbarg. Statt fuenf Filtern EINE
 * Stelle: die Aufgabe steht auf `assignees` und gehoert den Erwachsenen, die
 * bezahlen - der Person, die eincheckt (bzw. sie angelegt hat), wenn sie
 * Betraege sehen darf, und den aktiven Admins. Die Sichtbarkeitsregel
 * (services/visibility.js) haelt sie damit in jedem Lesepfad zurueck, ohne dass
 * einer davon sie kennt.
 *
 * Ein Konto OHNE Betraege steht nicht als Ersteller drin: die Regel laesst die
 * Erstellerin IMMER durch, die Aufgabe laege sonst genau bei dem Kind, vor dem
 * sie verborgen sein soll. Erstellerin wird dann die erste Admin-Person.
 *
 * DIE REGEL SCHLIESST, SIE OEFFNET NIE (security-guidance, R20). Admins sind
 * zuerst die Admins unter den Haushaltsmitgliedern. Die App laesst keinen
 * Haushalt ohne einen solchen zu (assertAdminWouldRemain in server/auth.js
 * fragt householdMemberSql() bei jedem Herabstufen und Entfernen); fehlt er
 * trotzdem (Datenbank von Hand bearbeitet), springt das erste aktive
 * Admin-Konto ein. Gibt es gar keinen Admin, entsteht beim Check-in keine
 * Zahlungsaufgabe, und eine alte wird `private` fuer ihre Erstellerin - ohne
 * Zuweisungen und ohne Beschreibung (die nennt den Lohn, und die Erstellerin
 * darf ihn dann nicht sehen). Auf `all` bleibt keine.
 */

import { userHasCapability } from '../permissions.js';
import { activeAccountSql, householdMemberSql } from './household-members.js';

export const AMOUNTS_CAPABILITY = 'housekeeping_view_amounts';

/**
 * Erstellerin und Zugewiesene einer Zahlungsaufgabe, oder `null`, wenn es
 * niemanden gibt, dem sie gehoeren darf.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number|null} actorId          eincheckende Person bzw. bisherige Erstellerin
 * @param {boolean} actorSeesAmounts     darf sie Betraege sehen?
 * @returns {{ createdBy: number, assignees: number[] } | null}
 */
export function paymentTaskAudience(database, actorId, actorSeesAmounts) {
  // Die Admins als HAUSHALTSMITGLIEDER (#1207): ein Admin-Konto, das
  // Hauspersonal, Gast oder Wandtablett ist, bezahlt niemanden.
  const admins = database.prepare(`
    SELECT u.id FROM users u
    WHERE u.role = 'admin' AND ${householdMemberSql('u')}
    ORDER BY u.id ASC
  `).all().map((row) => row.id);
  if (!admins.length) {
    const anyAdmin = database.prepare(`
      SELECT u.id FROM users u WHERE u.role = 'admin' AND ${activeAccountSql('u')} ORDER BY u.id ASC LIMIT 1
    `).get();
    if (anyAdmin) admins.push(anyAdmin.id);
  }
  const owners = actorSeesAmounts && actorId != null
    ? [actorId, ...admins.filter((id) => id !== actorId)]
    : admins;
  if (!owners.length) return null;
  return { createdBy: owners[0], assignees: owners };
}

/**
 * Zieht eine Zahlungsaufgabe, die noch auf `all` steht, auf die Regel oben
 * nach: `assignees`, Erstellerin und Zuweisungen aus `paymentTaskAudience()`
 * mit der bisherigen Erstellerin als Ausgangsperson. Zuweisungen, die die
 * Regel nicht nennt, fallen weg - ein zugewiesenes Kind saehe den Betrag sonst
 * weiter. Eine Aufgabe auf `assignees` oder `private` bleibt unberuehrt (sie
 * ist schon eine bewusste Wahl) - ausser mit `reapply`: dann verliert jemand,
 * der darin steht, gerade das Betragsrecht, und die Regel gilt neu
 * (`revokePaymentTasksForUsers()` unten).
 *
 * Die Aufrufer sorgen fuer die Transaktion.
 *
 * @param {{ reapply?: boolean }} [options]
 * @returns {boolean} ob die Aufgabe geaendert wurde
 */
export function normalizePaymentTaskAudience(database, taskId, { reapply = false } = {}) {
  if (taskId == null) return false;
  const task = database.prepare('SELECT id, created_by, visibility FROM tasks WHERE id = ?').get(taskId);
  if (!task || (!reapply && task.visibility !== 'all')) return false;
  // Ein ehemaliges Konto zahlt nicht mehr: es faellt hier heraus, und die
  // Aufgabe geht an die Admins (activeAccountSql, #1381).
  const creator = task.created_by == null
    ? null
    : database.prepare(`SELECT u.id FROM users u WHERE u.id = ? AND ${activeAccountSql('u')}`).get(task.created_by);
  const creatorSees = Boolean(creator && userHasCapability(database, creator.id, AMOUNTS_CAPABILITY));
  const audience = paymentTaskAudience(database, creator?.id ?? null, creatorSees);
  if (!audience) {
    // Niemand, dem sie gehoeren darf: schliessen statt offen lassen (Kopf).
    // Hier sieht die Erstellerin nie Betraege - saehe sie welche, gehoerte die
    // Aufgabe ihr -, also faellt die Beschreibung mit dem Lohn weg.
    database.prepare(`
      UPDATE tasks SET visibility = 'private', assigned_to = NULL, description = NULL WHERE id = ?
    `).run(task.id);
    database.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(task.id);
    return true;
  }
  database.prepare(`
    UPDATE tasks SET visibility = 'assignees', created_by = ?, assigned_to = ? WHERE id = ?
  `).run(audience.createdBy, audience.assignees[0], task.id);
  database.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(task.id);
  const assign = database.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const id of audience.assignees) assign.run(task.id, id);
  return true;
}

/**
 * DAS RECHT ZU ENTZIEHEN ENTZIEHT AUCH DIE AUFGABE (Codex zu R20).
 *
 * Eine Zahlungsaufgabe steht ab dem Check-in auf `assignees`, und die
 * Sichtbarkeitsregel laesst Erstellerin und Zugewiesene durch, ohne nach
 * `housekeeping_view_amounts` zu fragen. Verliert eine dieser Personen das
 * Recht spaeter (Mitglied-Zeile, Rollenprofil, Herabstufung vom Admin), laese
 * sie den Lohn sonst weiter in Titel und Beschreibung. Darum ruft jeder Weg,
 * der Rechte, Rolle oder Familienrolle schreibt, diese Funktion fuer die
 * betroffenen Konten auf (server/routes/permissions.js, PUT /auth/users/:id),
 * in derselben Transaktion. Fuer jede verknuepfte Zahlungsaufgabe, in der ein
 * Konto OHNE das Recht steht, gilt die Regel oben neu - egal welcher Status.
 * Sie schliesst nur: ein Konto, das das Recht behaelt oder neu bekommt, aendert
 * nichts.
 *
 * Ohne `userIds` (Rollenprofil) gilt die Frage fuer jedes Konto, das in einer
 * Zahlungsaufgabe steht: das Profil trifft auch Konten, die keine
 * Haushaltsmitglieder sind, und die Aufgabe fragt nach dem Recht, nicht nach
 * der Mitgliedschaft.
 *
 * @param {number[]} [userIds]
 * @returns {number} Anzahl nachgezogener Aufgaben
 */
export function revokePaymentTasksForUsers(database, userIds = null) {
  if (userIds == null) {
    userIds = database.prepare(`
      SELECT t.created_by AS id FROM tasks t JOIN housekeeping_work_sessions hws ON hws.payment_task_id = t.id
      UNION SELECT t.assigned_to FROM tasks t JOIN housekeeping_work_sessions hws ON hws.payment_task_id = t.id
      UNION SELECT ta.user_id FROM task_assignments ta JOIN housekeeping_work_sessions hws ON hws.payment_task_id = ta.task_id
    `).all().map((row) => row.id);
  }
  const tasksOf = database.prepare(`
    SELECT DISTINCT t.id FROM tasks t
    JOIN housekeeping_work_sessions hws ON hws.payment_task_id = t.id
    WHERE t.created_by = ? OR t.assigned_to = ?
       OR EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)
  `);
  let changed = 0;
  for (const userId of new Set(userIds)) {
    if (userId == null || userHasCapability(database, userId, AMOUNTS_CAPABILITY)) continue;
    for (const { id } of tasksOf.all(userId, userId, userId)) {
      if (normalizePaymentTaskAudience(database, id, { reapply: true })) changed += 1;
    }
  }
  return changed;
}
