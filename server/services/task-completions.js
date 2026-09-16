/**
 * Modul: Aufgaben-Erledigungen (Verlauf)
 * Zweck: Den Übergang einer Aufgabe nach 'done' als Ereignis festhalten und
 *        wieder abräumen, wenn er zurückgenommen wird - plus die beiden
 *        Lesepfade, die daraus einen Verlauf machen (#791).
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben;
 *        visibilityWhere aus services/visibility.js.
 *
 * WARUM DAS NEBEN rewards.js STEHT UND NICHT DARIN. Beide hängen am selben
 * Statuswechsel und sehen sich deshalb ähnlich, aber sie beantworten
 * verschiedene Fragen. Der Ledger bucht einen VERDIENST: er geht an die
 * Zuständigen, kann sich auf mehrere teilen, und er existiert nur, wenn die
 * Aufgabe Punkte trägt und das Modul an ist. Ein Verlaufseintrag hält einen
 * VORGANG fest: er passiert einmal, durch genau einen Klick, und er gilt für
 * jede Aufgabe. Eine gemeinsame Funktion müsste diese Unterschiede in Flags
 * ausdrücken, und das wäre die schlechtere Beschreibung von beidem.
 *
 * WAS HIER BEWUSST NICHT AUFGEZEICHNET WIRD: Teilaufgaben. Eine Unteraufgabe
 * ist ein Checklistenpunkt derselben Anweisung (siehe lockingTask in
 * routes/tasks.js) - "Zelt einpacken" neben "Bad geputzt" im selben Verlauf
 * würde die Frage aus #791 schlechter beantworten, nicht besser. Das Ereignis
 * der Serie ist das Abhaken der Hauptaufgabe.
 */

import { visibilityWhere } from './visibility.js';

/**
 * Die Wurzel der Wiederholungskette, in der diese Aufgabe steht - oder ihre
 * eigene ID, wenn sie keiner angehört.
 *
 * Eine wiederkehrende Aufgabe legt beim Abhaken eine Folgeinstanz an, die per
 * `recurrence_origin_id` auf ihren direkten Vorgänger zeigt (spawnRecurrenceFollowup
 * in routes/tasks.js). Die Kette wird also von hinten nach vorn gelesen. Sie
 * kann brechen: `recurrence_origin_id` ist ON DELETE SET NULL, ein gelöschtes
 * Zwischenglied macht seinen Nachfolger zum Anfang einer neuen Serie. Das ist
 * hingenommen und der Grund, warum das Ergebnis beim Schreiben festgehalten
 * wird statt bei jedem Lesen neu zu entstehen: schon geschriebene Einträge
 * bleiben zusammen, auch wenn die Kette später reißt.
 *
 * @param {object} d       better-sqlite3-Connection
 * @param {number} taskId
 * @returns {number} ID der Wurzel (= taskId, wenn die Aufgabe allein steht)
 */
const CHAIN_CTE = `
  WITH RECURSIVE chain(id, origin, depth) AS (
    SELECT id, recurrence_origin_id, 0 FROM tasks WHERE id = @task
    UNION ALL
    SELECT t.id, t.recurrence_origin_id, c.depth + 1
      FROM tasks t JOIN chain c ON t.id = c.origin
     WHERE c.depth < 1000
  )
`;

export function seriesRootOf(d, taskId) {
  const row = d.prepare(`${CHAIN_CTE} SELECT id FROM chain ORDER BY depth DESC LIMIT 1`)
    .get({ task: taskId });
  return row?.id ?? taskId;
}

/**
 * Erledigung festhalten. Idempotent über den UNIQUE-Index auf `task_id`: trifft
 * derselbe Statuswechsel zweimal ein, bleibt es bei einem Eintrag mit dem
 * ersten Zeitpunkt.
 *
 * ZWEI PERSONEN, WEIL ES ZWEI FRAGEN SIND (#1205). `user_id` ist weiter, wer
 * abgehakt hat; `done_by_user_id` ist, wer es getan hat, und ist NULL, wenn
 * niemand danach gefragt wurde. Der Normalfall bleibt damit unberührt: ohne
 * Angabe verhält sich der Eintrag exakt wie vorher.
 *
 * DIE IDEMPOTENZ GILT FÜR BEIDE SPALTEN. `INSERT OR IGNORE` lässt eine schon
 * vorhandene Zeile in Ruhe, also überschreibt ein zweiter Statuswechsel die
 * benannte Person nicht - genauso wenig, wie er den Zeitpunkt verschiebt. Wer
 * die Angabe korrigieren will, nimmt das Abhaken zurück und hakt neu ab; das
 * ist derselbe Weg, den auch die Punkte gehen (reverseTaskEarnings).
 *
 * @param {object}      d             better-sqlite3-Connection
 * @param {number}      taskId
 * @param {number|null} actingUserId  wer abgehakt hat
 * @param {number|null} [doneByUserId] wer es getan hat, falls benannt
 */
export function recordCompletion(d, taskId, actingUserId, doneByUserId = null) {
  const task = d.prepare('SELECT id, parent_task_id, recurrence_origin_id FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.parent_task_id) return;

  // Die Serie wird vom direkten Vorgänger GEERBT, wenn der schon einen Eintrag
  // hat - ein Index-Zugriff statt eines Kettenlaufs. Das ist der Normalfall
  // (eine laufende Serie hakt einen Nachfolger nach dem anderen ab), und er
  // darf nicht mit der Länge der Serie teurer werden: die rekursive Abfrage
  // deckelt bei 1000 Gliedern, und eine tägliche Aufgabe erreicht das nach gut
  // zweieinhalb Jahren. Ohne das Erben bekäme sie ab da eine andere series_id
  // und die Serie zerfiele still in zwei.
  const inherited = task.recurrence_origin_id
    ? d.prepare('SELECT series_id FROM task_completions WHERE task_id = ?').get(task.recurrence_origin_id)
    : null;

  d.prepare(`
    INSERT OR IGNORE INTO task_completions (task_id, series_id, user_id, done_by_user_id)
    VALUES (?, ?, ?, ?)
  `).run(
    taskId,
    inherited?.series_id ?? seriesRootOf(d, taskId),
    actingUserId || null,
    doneByUserId || null,
  );
}

/**
 * Erledigung zurücknehmen. Löscht statt gegenzubuchen - ein Haken, der dreimal
 * hin und her geht, ist kein Verlauf, sondern Rauschen (dieselbe Entscheidung
 * wie reverseTaskEarnings).
 */
export function revokeCompletion(d, taskId) {
  d.prepare('DELETE FROM task_completions WHERE task_id = ?').run(taskId);
}

/**
 * Kopplung an den Aufgaben-Statuswechsel. Hält beim Übergang nach 'done' fest
 * und räumt beim Verlassen von 'done' ab; alles andere ist ein No-op.
 *
 * Aufzurufen an genau den Stellen, an denen auch `syncTaskRewards` steht - die
 * beiden Wege, auf denen eine Person eine Aufgabe abhakt (PUT /:id über das
 * Formular, PATCH /:id/status über Checkbox, Swipe und Sammelaktion). Das
 * Ablegen ist keiner davon: es ist kein Statuswechsel (#688). Und die
 * Zahlungsaufgabe der Haushaltshilfe, die routes/housekeeping.js direkt auf
 * 'done' setzt, ist es ebenso wenig - sie spiegelt einen Zahlungsstand, es hakt
 * dort niemand etwas ab.
 *
 * BEKANNTE GRENZE, ausdrücklich und nicht geerbt: der eingehende CalDAV-Sync
 * (services/caldav-reminders-sync.js) schreibt `status` direkt in die Zeile und
 * kommt hier nicht vorbei. Wer eine gespiegelte Aufgabe in Apple Erinnerungen
 * abhakt, taucht also nicht im Verlauf auf. Dieselbe Lücke hat der
 * reward_ledger schon heute, und der Grund ist derselbe: dieser Lauf hat keine
 * handelnde Person - er läuft mit den Zugangsdaten des Haushalts, nicht denen
 * eines Mitglieds. Ein Eintrag ohne Person wäre möglich (die Spalte lässt NULL
 * zu), braucht aber eine eigene Darstellung: "Nicht mehr im Haushalt" wäre für
 * einen Sync die falsche Auskunft. Das ist eine eigene Entscheidung, keine
 * Nebenwirkung dieser hier.
 */
export function syncTaskCompletion(d, taskId, oldStatus, newStatus, actingUserId, doneByUserId = null) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) recordCompletion(d, taskId, actingUserId, doneByUserId);
  else if (wasDone && !isDone) revokeCompletion(d, taskId);
}

/**
 * Die Sichtbarkeitsregel für den Verlauf - dieselbe, die jede Aufgabenliste
 * anwendet, und deshalb dieselbe Funktion.
 *
 * Sie kommt LIVE aus der Aufgabe, nicht aus dem Eintrag: wer eine Aufgabe
 * nachträglich auf privat stellt, hat sie versteckt, und der Verlauf darf sie
 * danach nicht weiter zeigen. Genau dafür trägt `task_completions` keine eigene
 * Kopie der Stufe.
 */
const VISIBLE_SQL = visibilityWhere('t', 'task_assignments', 'task_id', '@me');

/**
 * Spalten, die beide Lesepfade teilen.
 *
 * `person_user_id` IST DIE EINE AUTORITÄT DAFÜR, WEN DER VERLAUF ZEIGT (#1205).
 * Sie ist die benannte erledigende Person, und ohne Angabe die abhakende - die
 * Rückfallregel steht damit genau einmal, im SQL, statt in jedem Renderer
 * einzeln. `user_id` daneben behält seine alte Bedeutung unverändert: wer
 * abgehakt hat. Beide Spalten gehen mit, weil die Oberfläche beides
 * unterscheiden können muss ("A hat für B abgehakt").
 */
const SELECT_SQL = `
  SELECT c.id, c.task_id, c.series_id, c.completed_at,
         c.user_id,
         u.display_name  AS user_name,
         u.avatar_color  AS user_color,
         u.avatar_data   AS user_avatar,
         c.done_by_user_id,
         COALESCE(c.done_by_user_id, c.user_id) AS person_user_id,
         p.display_name  AS person_name,
         p.avatar_color  AS person_color,
         p.avatar_data   AS person_avatar,
         t.title, t.category, t.points, t.is_recurring, t.visibility
    FROM task_completions c
    JOIN tasks t ON t.id = c.task_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN users p ON p.id = COALESCE(c.done_by_user_id, c.user_id)
`;

/**
 * Der Haushaltsverlauf, neueste zuerst.
 *
 * Geblättert wird über einen Zeit-Cursor statt über OFFSET: während jemand
 * blättert, kann vorn ein Eintrag dazukommen, und ein OFFSET würde dann eine
 * Zeile überspringen, die er nie gesehen hat. `(completed_at, id)` als Paar,
 * weil mehrere Erledigungen in derselben Sekunde landen können - eine
 * Sammelaktion tut genau das.
 *
 * Kein Datumsbereich: die Gruppierung nach Kalendertagen gehört in die
 * Anzeigezone (public/utils/timezone.js), und ein Server, der hier einen
 * `from`-Tag entgegennähme, müsste eine zweite Uhr dafür führen.
 *
 * @param {object} d
 * @param {object} opts
 * @param {number} opts.me       betrachtende Person (Sichtbarkeit)
 * @param {number} [opts.limit]  1..200
 * @param {number} [opts.userId] nur Erledigungen dieser Person
 * @param {string} [opts.beforeAt]  Cursor: `completed_at` des letzten Eintrags
 * @param {number} [opts.beforeId]  Cursor: `id` des letzten Eintrags
 */
export function completionFeed(d, { me, limit = 50, userId = null, beforeAt = null, beforeId = null }) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [VISIBLE_SQL];
  const params = { me, size };

  // DER FILTER FOLGT DER ANZEIGE, NICHT DER SPALTE. Gefiltert wird über
  // dieselbe Rückfallregel, die auch `person_user_id` bildet: wer auf den Chip
  // einer Person tippt, erwartet die Einträge, die ihren Namen tragen. Würde
  // hier weiter `c.user_id` stehen, zeigte der Verlauf nach dem Filtern Namen,
  // die nicht der gefilterten Person gehören - dieselbe Art Widerspruch wie
  // zwischen einem Diagramm und der Liste darunter.
  if (userId != null) {
    where.push('COALESCE(c.done_by_user_id, c.user_id) = @user_id');
    params.user_id = userId;
  }
  if (beforeAt) {
    where.push('(c.completed_at < @before_at OR (c.completed_at = @before_at AND c.id < @before_id))');
    params.before_at = beforeAt;
    params.before_id = Number(beforeId) || 0;
  }

  // Eine Zeile mehr als angefragt: sie beantwortet "gibt es noch mehr", ohne
  // dafür ein zweites COUNT über dieselbe Bedingung zu fahren.
  const rows = d.prepare(`
    ${SELECT_SQL}
    WHERE ${where.join(' AND ')}
    ORDER BY c.completed_at DESC, c.id DESC
    LIMIT @size + 1
  `).all(params);

  const hasMore = rows.length > size;
  return { entries: hasMore ? rows.slice(0, size) : rows, hasMore };
}

/**
 * Die Erledigungen einer Serie, neueste zuerst - "wann war das zuletzt dran"
 * für eine wiederkehrende Aufgabe.
 *
 * GEFRAGT WIRD ÜBER DIE KETTE, NICHT ÜBER EINEN NEU BERECHNETEN WURZELWERT.
 * Der Unterschied ist der ganze Punkt: `series_id` wird beim SCHREIBEN
 * eingefroren, eine Neuberechnung beim LESEN wären zwei Wahrheiten. Wird ein
 * altes Kettenglied gelöscht, verliert sein Nachfolger `recurrence_origin_id`
 * (SET NULL) - eine frisch berechnete Wurzel wäre ab dann eine andere als die,
 * die in den bereits geschriebenen Einträgen steht, und die Serienansicht fände
 * gar nichts mehr. Genau dieser Fall trat auf: zweimal erledigt, erste Instanz
 * gelöscht, "Zuletzt erledigt" antwortete "noch nie".
 *
 * Die Bedingung nimmt deshalb drei Wege auf dieselbe Serie:
 *   1. Einträge der Kettenglieder selbst (`task_id`),
 *   2. Einträge, deren Serie auf ein Kettenglied zeigt (`series_id`),
 *   3. Einträge, die dieselbe Serie tragen wie ein Kettenglied - das holt die
 *      Instanzen VOR einem Riss zurück, deren eigene Glieder nicht mehr in der
 *      Kette stehen.
 */
export function seriesHistory(d, { me, taskId, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return d.prepare(`
    ${CHAIN_CTE}
    ${SELECT_SQL}
    WHERE (
      c.task_id   IN (SELECT id FROM chain)
      OR c.series_id IN (SELECT id FROM chain)
      OR c.series_id IN (SELECT series_id FROM task_completions WHERE task_id IN (SELECT id FROM chain))
    ) AND ${VISIBLE_SQL}
    ORDER BY c.completed_at DESC, c.id DESC
    LIMIT @size
  `).all({ me, task: taskId, size });
}
