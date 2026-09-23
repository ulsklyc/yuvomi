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

/*
 * STUECKZAHL JE PRAEMIE, UND VERBRAUCHT IST SIE BEI DER ERFUELLUNG (#1310).
 *
 * `quantity` gehoert dem HAUSHALT, nicht einem Kind: der Katalog ist
 * haushaltsweit und kennt keine Zuordnung Praemie-zu-Kind. NULL heisst
 * unbegrenzt, und das ist der Stand jeder Praemie von vor dieser Aenderung.
 *
 * GEZAEHLT WERDEN ERFUELLTE EINLOESUNGEN, KEINE OFFENEN ANFRAGEN. Eine Anfrage
 * reserviert die Punkte (die `redeem`-Buchung faellt beim Stellen), aber keine
 * Einheit - sonst waere die zuerst gestellte Anfrage schon die Entscheidung,
 * und die Eltern haetten keine mehr zu treffen. Die Folge ist gewollt: es
 * duerfen mehr Anfragen offen stehen als es Einheiten gibt, und die uebrig
 * gebliebene wird bei der Entscheidung mit Grund abgelehnt (PATCH
 * /redemptions/:id in server/routes/rewards.js), wobei die bestehende Gegenbuchung die Punkte zurueckgibt.
 *
 * `remaining` ist deshalb abgeleitet und nirgends gespeichert - wie der
 * Punktestand, den auch niemand fuehrt. Eine zurueckgezogene oder abgelehnte
 * Einloesung gibt ihre Einheit damit von selbst wieder frei.
 */
export const CATALOG_SELECT = `
  SELECT c.id, c.name, c.cost, c.icon, c.description, c.is_active, c.sort_order, c.quantity,
         CASE WHEN c.quantity IS NULL THEN NULL
              ELSE MAX(0, c.quantity - (SELECT COUNT(*) FROM reward_redemptions r
                                         WHERE r.catalog_id = c.id AND r.status = 'fulfilled'))
         END AS remaining
  FROM reward_catalog c`;

/** Aktive Praemien, wie die Uebersicht sie ordnet - vergriffene inklusive (`remaining: 0`). */
export function activeCatalog(d) {
  return d.prepare(`
    ${CATALOG_SELECT}
    WHERE c.is_active = 1
    ORDER BY c.sort_order ASC, c.cost ASC, c.name COLLATE NOCASE ASC
  `).all();
}

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
 *
 * EINE BENANNTE ERLEDIGENDE PERSON SCHLÄGT BEIDES (#1205). Wer als "hat es
 * getan" benannt wurde, ist die Antwort auf genau die Frage, die diese Funktion
 * stellt - die Zuweisung ist nur die Vermutung darüber, und die handelnde
 * Person ist nur, wer das Tablett in der Hand hielt. Ohne Benennung ändert sich
 * nichts: `doneByUserId` ist dann null und die alte Reihenfolge greift
 * unverändert.
 *
 * IST DIE BENANNTE PERSON NICHT DABEI, GIBT ES KEINE PUNKTE - kein Rückfall auf
 * die Zuweisung. Das ist Absicht und der ganze Sinn der Benennung: die Punkte
 * für eine Aufgabe, die nachweislich jemand anderes erledigt hat, an die
 * zugewiesene Person zu buchen, wäre die falscheste der drei möglichen
 * Antworten. Ein leeres Ergebnis ist hier die richtige.
 */
export function rewardTargets(d, taskId, actingUserId, doneByUserId = null) {
  const enrolled = enrolledIds(d);
  if (doneByUserId) return enrolled.has(doneByUserId) ? [doneByUserId] : [];
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
export function awardForCompletion(d, taskId, actingUserId, doneByUserId = null) {
  const task = d.prepare('SELECT id, points, title FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId, doneByUserId);
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
  // OHNE PERSONENFILTER, UND DAS BLEIBT SO (#1205). Seit eine benannte
  // erledigende Person die Punkte bekommen kann, ist der Empfänger einer
  // earn-Zeile nicht mehr aus der Zuweisung ableitbar - ein Filter auf
  // "Zuständige" oder "handelnde Person" ließe genau die Buchung stehen, die
  // das Zurücknehmen auflösen soll. `task_id` + `type` trifft sie alle,
  // unabhängig davon, wer sie erhalten hat.
  d.prepare("DELETE FROM reward_ledger WHERE task_id = ? AND type = 'earn'").run(taskId);
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und storniert beim Verlassen von 'done'. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId, doneByUserId = null) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId, doneByUserId);
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
