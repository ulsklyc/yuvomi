/**
 * Modul: Erinnerungs-Kennzeichen fuer Listen
 * Zweck: Welche Termine und Aufgaben einer Liste tragen eine Erinnerung des
 *        Betrachters? Eine Abfrage fuer die ganze Liste.
 *
 * DIESELBE FRAGE WIE DIE LESEANSICHT. Die Glocken-Zeile im Termin und in der
 * Aufgabe liest `GET /reminders/all` bzw. `GET /reminders`: eigene Zeilen
 * (`created_by`), nicht verworfen. Die Glocke in der Liste muss genau dann
 * stehen, wenn die Leseansicht eine Erinnerung zeigt - sonst verspricht die
 * Zeile etwas, das der Termin beim Oeffnen nicht haelt, oder umgekehrt.
 *
 * ERINNERUNGEN GEHOEREN EINER PERSON. Zwei Mitglieder sehen denselben Termin,
 * aber nur wer eine Erinnerung gesetzt hat (oder sie als Zugewiesener geerbt
 * hat, #921), sieht die Glocke. Das Kennzeichen sagt "du wirst erinnert",
 * nicht "jemand wird erinnert".
 *
 * Den Sichtbarkeitsfilter der Erinnerungs-Routen (reminderTargetVisibleSql)
 * braucht es hier nicht: gefragt wird nur nach Zeilen, die die Liste dem
 * Betrachter ohnehin zeigt.
 */

/**
 * @param {{ prepare(sql: string): { all(...params: any[]): any[] } }} database  die Verbindung (better-sqlite3 oder node:sqlite)
 * @param {'event' | 'task'} entityType
 * @param {Iterable<number | string | null | undefined>} ids
 * @param {number | null | undefined} userId
 * @returns {Set<number>} die IDs aus `ids`, an denen eine eigene, nicht
 *   verworfene Erinnerung haengt
 */
export function ownReminderIds(database, entityType, ids, userId) {
  const wanted = [...new Set([...ids].map(Number).filter(Number.isInteger))];
  if (!database || !userId || wanted.length === 0) return new Set();
  // json_each statt einer Platzhalterliste: ein Monat mit Serien bringt
  // schnell einige hundert IDs, und die Zahl der Platzhalter ist begrenzt.
  const rows = database.prepare(`
    SELECT DISTINCT r.entity_id AS id
    FROM reminders r
    WHERE r.entity_type = ? AND r.created_by = ? AND r.dismissed = 0
      AND r.entity_id IN (SELECT value FROM json_each(?))
  `).all(entityType, userId, JSON.stringify(wanted));
  return new Set(rows.map((row) => Number(row.id)));
}
