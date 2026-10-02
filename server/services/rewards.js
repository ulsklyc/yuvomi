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

/*
 * DER VERLAUF IST GESCHICHTE: WIEDERÖFFNEN BUCHT GEGEN, ES LÖSCHT NICHT (#1607).
 *
 * Bis v230 nahm das Zurücksetzen einer erledigten Aufgabe die earn-Zeile aus
 * dem Ledger. Das hielt den Verlauf frei von Hin-und-her, aber es schrieb ihn
 * um: wer mit den Punkten schon eine Prämie angefragt hatte, stand danach im
 * Minus, und der Verlauf zeigte nur noch die Einlösung - weder die Gutschrift
 * noch ihre Rücknahme. Ein Saldo, den seine eigene Geschichte nicht erklärt.
 *
 * Jetzt bleibt die earn-Zeile stehen, und die Rücknahme ist eine zweite Zeile:
 * Typ `reversal`, negatives Delta, dieselbe `task_id`. Der Saldo darf dabei
 * negativ werden und gleicht sich mit den nächsten Gutschriften aus; eine
 * offene Anfrage bleibt offen, die Entscheidung darüber gehört den Eltern.
 *
 * OB EINE AUFGABE GERADE VERGÜTET IST, sagt der NETTO-Stand ihrer Buchungen je
 * Person (earn plus reversal mit dieser task_id): größer 0 heißt vergütet, 0
 * heißt offen. Das ersetzt den partiellen UNIQUE-Index `uniq_reward_earn`, der
 * mit einer stehenbleibenden earn-Zeile die Neuvergabe nach dem Wiederöffnen
 * verschluckt hätte (Migration 230). Die Idempotenz steht damit im Code - das
 * trägt, weil der Treiber synchron ist und Lesen und Schreiben in EINER
 * Transaktion liegen: zwischen "Netto ist 0" und der Buchung kommt kein
 * anderer Request dazwischen. Ein `await` in diesem Pfad wäre genau die Lücke.
 *
 * Eine Einlöse-Rückbuchung ist ebenfalls `reversal`, trägt aber
 * `redemption_id` statt `task_id` und ein positives Delta; die beiden kommen
 * sich in dieser Summe nicht in die Quere.
 */
const TASK_NET = `
  SELECT COALESCE(SUM(delta), 0) AS net FROM reward_ledger
  WHERE task_id = ? AND user_id = ? AND type IN ('earn', 'reversal')
`;

/**
 * Punkte für eine erledigte Aufgabe gutschreiben. Idempotent über den
 * Netto-Stand: wer für diese Aufgabe schon vergütet ist, bekommt keine zweite
 * Buchung, falls der Statuswechsel mehrfach eintrifft.
 */
export function awardForCompletion(d, taskId, actingUserId, doneByUserId = null) {
  const task = d.prepare('SELECT id, points, title FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId, doneByUserId);
  if (!targets.length) return;
  d.transaction(() => {
    const net = d.prepare(TASK_NET);
    const ins = d.prepare(`INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by)
      VALUES (?, ?, 'earn', ?, ?, ?)`);
    for (const uid of new Set(targets)) {
      if (net.get(taskId, uid).net > 0) continue;
      ins.run(uid, task.points, task.title || null, taskId, actingUserId || null);
    }
  })();
}

/**
 * Vergabe zurücknehmen, wenn eine Aufgabe von 'done' zurückgesetzt wird: je
 * Person, die für die Aufgabe gerade vergütet ist, eine Gegenbuchung über
 * genau den gebuchten Betrag. Gebucht wird der Netto-Stand, nicht der heutige
 * Punktwert der Aufgabe - der kann seit dem Erledigen geändert worden sein.
 * Idempotent: nach der Gegenbuchung ist das Netto 0, ein zweiter Aufruf findet
 * nichts mehr.
 */
export function reverseTaskEarnings(d, taskId, actingUserId = null) {
  // OHNE PERSONENFILTER, UND DAS BLEIBT SO (#1205). Seit eine benannte
  // erledigende Person die Punkte bekommen kann, ist der Empfänger einer
  // earn-Zeile nicht mehr aus der Zuweisung ableitbar - ein Filter auf
  // "Zuständige" oder "handelnde Person" ließe genau die Buchung stehen, die
  // das Zurücknehmen auflösen soll. `task_id` trifft sie alle, unabhängig
  // davon, wer sie erhalten hat.
  d.transaction(() => {
    const open = d.prepare(`
      SELECT user_id, SUM(delta) AS net,
             (SELECT e.reason FROM reward_ledger e
               WHERE e.task_id = l.task_id AND e.user_id = l.user_id AND e.type = 'earn'
               ORDER BY e.id DESC LIMIT 1) AS reason
      FROM reward_ledger l
      WHERE task_id = ? AND type IN ('earn', 'reversal')
      GROUP BY user_id
      HAVING SUM(delta) > 0
    `).all(taskId);
    for (const row of open) {
      postLedger(d, {
        userId: row.user_id, delta: -row.net, type: 'reversal',
        reason: row.reason, taskId, createdBy: actingUserId || null,
      });
    }
  })();
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und bucht beim Verlassen von 'done' gegen. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId, doneByUserId = null) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId, doneByUserId);
  else if (wasDone && !isDone) reverseTaskEarnings(d, taskId, actingUserId);
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
