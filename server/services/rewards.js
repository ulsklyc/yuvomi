/**
 * Modul: Rewards (Belohnungen)
 * Zweck: Punkte-Vergabe bei Aufgaben-Erledigung und Salden-Berechnung aus dem
 *        Ledger. Der Punktestand eines Mitglieds ist immer SUM(delta) über
 *        reward_ledger — es gibt keinen separat gepflegten Saldo, der driften
 *        könnte.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben.
 */

import { householdMemberSql } from './household-members.js';
import { seriesRootOf } from './task-completions.js';
import { householdTimeZone, todayKey, utcToWall } from '../utils/timezone.js';

const REWARD_TX = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by, unit, currency)
  VALUES (@user_id, @delta, @type, @reason, @task_id, @redemption_id, @created_by, @unit, @currency)
`;

/*
 * WAS EINE LEDGER-ZEILE ZAEHLT (#1734).
 *
 * Seit es Taschengeld gibt, liegen im selben Ledger zwei Zahlen, die sich nie
 * begegnen duerfen: Punkte und Geld (ganze kleinste Einheiten der
 * Haushaltswaehrung). Ein Kind mit beidem hat ZWEI Salden, und es gibt keinen
 * Umtausch zwischen ihnen.
 *
 * DIE SUMME STEHT DESHALB NUR HIER, UND SIE GEHT NICHT OHNE EINHEIT. Bis #1734
 * schrieb jede Route ihr eigenes `SUM(delta)` - vier Stellen, von denen keine
 * eine Einheit kannte. Eine einzige, die den Filter vergisst, zaehlt Cent als
 * Punkte. `ledgerBalanceSql()` und `ledgerBalance()` werfen ohne gueltige
 * Einheit, statt still alles zu summieren: der Fehler soll beim ersten Aufruf
 * auffallen und nicht in einem Kontostand.
 */
export const LEDGER_UNITS = Object.freeze(['points', 'money']);

function checkedUnit(unit) {
  if (!LEDGER_UNITS.includes(unit)) {
    throw new Error(`ledger unit must be one of ${LEDGER_UNITS.join(', ')}.`);
  }
  return unit;
}

/**
 * Der Saldo einer Person als SQL-Ausdruck, fuer Listen mit einer Zeile je
 * Person. `userExpr` ist ein Spaltenausdruck aus dem Code (`u.id`), nie eine
 * Eingabe.
 *
 * @param {'points'|'money'} unit
 * @param {string} userExpr
 */
export function ledgerBalanceSql(unit, userExpr) {
  const u = checkedUnit(unit);
  if (!/^[a-z_]+\.[a-z_]+$/.test(String(userExpr))) throw new Error('userExpr must be a qualified column.');
  return `COALESCE((SELECT SUM(bal.delta) FROM reward_ledger bal WHERE bal.user_id = ${userExpr} AND bal.unit = '${u}'), 0)`;
}

/**
 * Der Saldo einer Person in EINER Einheit (Summe ihrer Ledger-Buchungen).
 *
 * @param {object} d
 * @param {number} userId
 * @param {'points'|'money'} unit
 */
export function ledgerBalance(d, userId, unit) {
  const row = d.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ? AND unit = ?')
    .get(userId, checkedUnit(unit));
  return row?.bal ?? 0;
}

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

/** Aktueller PUNKTEstand eines Mitglieds. Geld zaehlt nicht mit (`ledgerBalance`). */
export function getBalance(d, userId) {
  return ledgerBalance(d, userId, 'points');
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
  WHERE task_id = ? AND user_id = ? AND type IN ('earn', 'reversal') AND unit = 'points'
`;

/*
 * EINE SERIE ZAHLT JE PERSON EINMAL AM TAG (#1603).
 *
 * Eine wiederkehrende Aufgabe legt beim Abhaken sofort ihre nächste Instanz an
 * (spawnRecurrenceFollowup in routes/tasks.js) - eine neue Zeile mit neuer
 * task_id, die sich im selben Atemzug wieder abhaken lässt. Die Idempotenz
 * oben gilt je task_id und sah darin jedes Mal eine neue Aufgabe: "Zähne
 * putzen", fällig morgen, brachte mit zehn Klicks zehnmal Punkte.
 *
 * Das Abhaken bleibt erlaubt und rollt die Serie weiter - wer zwei Tage
 * nachholt, soll das können. Nur die GUTSCHRIFT gibt es je Serie, Person und
 * Haushaltstag höchstens einmal. Die Kehrseite ist benannt: wer an einem Tag
 * zwei liegengebliebene Vorkommen derselben Serie nachholt, bekommt eine.
 *
 * WAS "HEUTE SCHON VERGÜTET" HEISST: es gibt eine earn-Zeile dieser Person für
 * eine ANDERE Aufgabe derselben Serie, die noch gilt (keine spätere
 * Gegenbuchung, #1607) und deren Zeitpunkt in der Haushaltszone auf den
 * heutigen Tag fällt. Die eigene Aufgabe zählt nicht mit: ihre zurückgenommene
 * Gutschrift darf das erneute Erledigen am selben Tag nicht sperren, und ihre
 * noch geltende fängt schon der Netto-Stand ab.
 *
 * DIE SERIE STEHT AN DER GUTSCHRIFT SELBST (`reward_ledger.series_id`), und
 * der Deckel fragt den Ledger direkt nach Serie, Person und Tag. Er
 * rekonstruiert nichts: jede Kette über recurrence_origin_id reißt, sobald ein
 * erledigtes Vorkommen gelöscht wird (ON DELETE SET NULL nimmt der
 * Folgeinstanz den Verweis und der Gutschrift die task_id), und
 * task_completions verliert die Zeile gleich mit. "Erledigen, löschen,
 * erledigen" wäre derselbe Punktehahn gewesen, nur mit einem Klick mehr.
 *
 * WOHER DIE KENNUNG KOMMT: `tasks.recurrence_series_id`, beim ANLEGEN der
 * Folgeinstanz von der Vorgängerin übernommen (spawnRecurrenceFollowup in
 * routes/tasks.js) - für die Aufgabe und für jede kopierte Teilaufgabe, die
 * eigene Punkte trägt und im Verlauf bewusst nicht steht. Der Wert ist die ID
 * des ersten Vorkommens und bleibt es, auch wenn es dieses längst nicht mehr
 * gibt. Eine Aufgabe ohne Kennung ist ihr eigenes erstes Vorkommen; trägt sie
 * aus der Zeit vor v230 noch einen Vorgänger-Verweis, gilt die Wurzel ihrer
 * Kette (seriesOfTask) - derselbe Wert, den ihre nächste Folgeinstanz erbt.
 *
 * BESTAND: Gutschriften von vor v230 tragen keine Kennung und zählen für den
 * Deckel nicht. Es gibt ihn erst seit v230 - gesperrt hat davor nichts.
 *
 * Eine wieder geöffnete Aufgabe hat eine Gegenbuchung, die auf ihre
 * Gutschrift zeigt (`reverses_id`); die fällt damit heraus.
 *
 * DER TAG ist der Haushaltstag (todayKey), nie der UTC-Tag: östlich von UTC
 * beginnt der Morgen sonst am Vortag, und die Gutschrift von gestern Abend
 * sperrte die von heute früh. Die Abfrage holt deshalb großzügig die letzten
 * 50 Stunden (weiter liegt kein "heute" einer Zone vom Jetzt entfernt) und
 * entscheidet den Tag je Zeile über die Wanduhr der Zone.
 */
const SERIES_EARNS_SINCE = `
  SELECT l.created_at FROM reward_ledger l
  WHERE l.series_id = @series AND l.user_id = @user AND l.type = 'earn'
    AND l.created_at >= @since
    AND (l.task_id IS NULL OR l.task_id != @task)
    AND NOT EXISTS (SELECT 1 FROM reward_ledger r WHERE r.reverses_id = l.id)
`;
const SERIES_LOOKBACK_MS = 50 * 60 * 60 * 1000;

/** Zeitpunkt in der Form, die der Ledger schreibt: Sekunden, UTC, mit Z. */
function ledgerTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Die Serie, unter der eine Gutschrift für diese Aufgabe gebucht wird.
 * @param {object} d
 * @param {{ id: number, recurrence_series_id: number|null }} task
 * @returns {number}
 */
export function seriesOfTask(d, task) {
  return task.recurrence_series_id ?? seriesRootOf(d, task.id);
}

/**
 * Punkte für eine erledigte Aufgabe gutschreiben. Idempotent über den
 * Netto-Stand: wer für diese Aufgabe schon vergütet ist, bekommt keine zweite
 * Buchung, falls der Statuswechsel mehrfach eintrifft. Und je Serie, Person
 * und Haushaltstag höchstens eine (#1603, siehe oben).
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now]  Ersetzbar für Tests - Zeitpunkt der Buchung UND
 *                             der Tag, an dem der Serien-Deckel misst.
 */
export function awardForCompletion(d, taskId, actingUserId, doneByUserId = null, { now = new Date() } = {}) {
  const task = d.prepare('SELECT id, points, title, recurrence_series_id FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId, doneByUserId);
  if (!targets.length) return;
  d.transaction(() => {
    const net = d.prepare(TASK_NET);
    const seriesEarns = d.prepare(SERIES_EARNS_SINCE);
    const ins = d.prepare(`INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by, created_at, series_id)
      VALUES (?, ?, 'earn', ?, ?, ?, ?, ?)`);
    const series = seriesOfTask(d, task);
    const zone = householdTimeZone(d);
    const today = todayKey(d, now);
    const since = ledgerTimestamp(new Date(now.getTime() - SERIES_LOOKBACK_MS));
    for (const uid of new Set(targets)) {
      if (net.get(taskId, uid).net > 0) continue;
      const paidToday = seriesEarns.all({ series, user: uid, task: taskId, since })
        .some((row) => utcToWall(row.created_at, zone)?.date === today);
      if (paidToday) continue;
      ins.run(uid, task.points, task.title || null, taskId, actingUserId || null, ledgerTimestamp(now), series);
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
    // Die Gegenbuchung ZEIGT AUF IHRE GUTSCHRIFT (`reverses_id`). Über die
    // Aufgabe ließen sich die beiden nur finden, solange es sie gibt: wird sie
    // gelöscht, verlieren beide Zeilen ihre task_id, und niemand wüsste mehr,
    // dass diese Gutschrift zurückgenommen ist - weder die Liste "zuletzt
    // verdient" noch der Serien-Deckel. Offen ist je Person höchstens eine
    // Gutschrift (der Netto-Stand lässt keine zweite zu), also die jüngste.
    const open = d.prepare(`
      SELECT user_id, SUM(delta) AS net, MAX(CASE WHEN type = 'earn' THEN id END) AS earn_id
      FROM reward_ledger
      WHERE task_id = ? AND type IN ('earn', 'reversal') AND unit = 'points'
      GROUP BY user_id
      HAVING SUM(delta) > 0
    `).all(taskId);
    const reason = d.prepare('SELECT reason FROM reward_ledger WHERE id = ?');
    const ins = d.prepare(`INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by, reverses_id)
      VALUES (?, ?, 'reversal', ?, ?, ?, ?)`);
    for (const row of open) {
      ins.run(row.user_id, -row.net, reason.get(row.earn_id)?.reason ?? null, taskId, actingUserId || null, row.earn_id);
    }
  })();
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und bucht beim Verlassen von 'done' gegen. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId, doneByUserId = null, opts = {}) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId, doneByUserId, opts);
  else if (wasDone && !isDone) reverseTaskEarnings(d, taskId, actingUserId);
}

/**
 * Freie Buchung (Bonus/Korrektur/Reversal) - vom Route-Handler genutzt.
 * Ohne `unit` sind es Punkte, wie jede Buchung von vor #1734.
 */
export function postLedger(d, { userId, delta, type, reason = null, taskId = null, redemptionId = null, createdBy = null, unit = 'points', currency = null }) {
  // Eine Geldzeile traegt ihren Waehrungscode, eine Punktezeile keinen - das
  // Schema lehnt beides andere ab. Geld bucht `postMoney()` in
  // server/services/reward-money.js: dort steht die Regel, dass ein Konto bei
  // seiner EINEN Waehrung bleibt.
  if ((checkedUnit(unit) === 'money') !== (currency != null)) {
    throw new Error('a money entry carries a currency, a points entry none.');
  }
  return d.prepare(REWARD_TX).run({
    unit,
    currency,
    user_id: userId,
    delta,
    type,
    reason,
    task_id: taskId,
    redemption_id: redemptionId,
    created_by: createdBy,
  });
}
