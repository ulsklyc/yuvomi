/**
 * Modul: Rewards (Belohnungen)
 * Zweck: Punkte-Vergabe bei Aufgaben-Erledigung und Salden-Berechnung aus dem
 *        Ledger. Der Punktestand eines Mitglieds ist immer SUM(delta) über
 *        reward_ledger — es gibt keinen separat gepflegten Saldo, der driften
 *        könnte.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben.
 */

import { householdMemberSql } from './household-members.js';

const REWARD_TX = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by)
  VALUES (@user_id, @delta, @type, @reason, @task_id, @redemption_id, @created_by)
`;

/** Aktueller Punktestand eines Mitglieds (Summe aller Ledger-Buchungen). */
export function getBalance(d, userId) {
  const row = d.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ?').get(userId);
  return row?.bal ?? 0;
}

/*
 * NUR HAUSHALTSMITGLIEDER NEHMEN AKTIV TEIL (#1207). Eine alte Einschreibung
 * von Hauspersonal oder einem Gast bleibt in reward_participants stehen, samt
 * ihrem Ledger - aber sie verdient keine Punkte mehr, loest nichts ein und
 * bekommt keinen Bonus. Sonst sammelte ein Konto, das keine Liste mehr zeigt,
 * unsichtbar weiter.
 */

/** IDs aller aktiv teilnehmenden Mitglieder. */
function enrolledIds(d) {
  return new Set(
    d.prepare(`
      SELECT p.user_id FROM reward_participants p
      JOIN users u ON u.id = p.user_id
      WHERE p.enabled = 1 AND ${householdMemberSql('u')}
    `).all().map((r) => r.user_id),
  );
}

/** Nimmt ein Mitglied aktiv am Punkte-System teil? */
export function isEnrolled(d, userId) {
  if (!userId) return false;
  const row = d.prepare(`
    SELECT p.enabled FROM reward_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? AND ${householdMemberSql('u')}
  `).get(userId);
  return !!row && row.enabled === 1;
}

/**
 * Wer verdient die Punkte einer Aufgabe? Zugewiesene, teilnehmende Mitglieder;
 * ist niemand zugewiesen (Kiosk-Tablet mit einem Account), die handelnde Person
 * — sofern selbst teilnehmend. Jedes zuständige Mitglied erhält den vollen Wert.
 */
export function rewardTargets(d, taskId, actingUserId) {
  const enrolled = enrolledIds(d);
  const assignees = d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
    .all(taskId).map((r) => r.user_id);
  const targets = assignees.filter((id) => enrolled.has(id));
  if (targets.length) return targets;
  if (actingUserId && enrolled.has(actingUserId)) return [actingUserId];
  return [];
}

/**
 * Punkte für eine erledigte Aufgabe gutschreiben. Idempotent: der partielle
 * UNIQUE-Index (task_id, user_id) WHERE type='earn' verhindert Doppelvergabe,
 * falls der Statuswechsel mehrfach eintrifft.
 */
export function awardForCompletion(d, taskId, actingUserId) {
  const task = d.prepare('SELECT id, points, title FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId);
  if (!targets.length) return;
  const ins = d.prepare(`INSERT OR IGNORE INTO ${'reward_ledger'} (user_id, delta, type, reason, task_id, created_by)
    VALUES (?, ?, 'earn', ?, ?, ?)`);
  for (const uid of targets) {
    ins.run(uid, task.points, task.title || null, taskId, actingUserId || null);
  }
}

/**
 * Vergabe zurücknehmen, wenn eine Aufgabe von 'done' zurückgesetzt wird. Die
 * earn-Buchungen werden entfernt (nicht per Gegenbuchung), damit ein erneutes
 * Erledigen sauber neu vergibt und der Ledger nicht mit Toggle-Rauschen wächst.
 */
export function reverseTaskEarnings(d, taskId) {
  d.prepare("DELETE FROM reward_ledger WHERE task_id = ? AND type = 'earn'").run(taskId);
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und storniert beim Verlassen von 'done'. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId);
  else if (wasDone && !isDone) reverseTaskEarnings(d, taskId);
}

/** Freie Buchung (Bonus/Korrektur/Reversal) — vom Route-Handler genutzt. */
export function postLedger(d, { userId, delta, type, reason = null, taskId = null, redemptionId = null, createdBy = null }) {
  return d.prepare(REWARD_TX).run({
    user_id: userId,
    delta,
    type,
    reason,
    task_id: taskId,
    redemption_id: redemptionId,
    created_by: createdBy,
  });
}
