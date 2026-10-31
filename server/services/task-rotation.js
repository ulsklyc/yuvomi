/**
 * Modul: Rotation für wiederkehrende Aufgaben
 * Zweck: Eine Serie wie "Müll rausbringen" haengt sonst fuer immer an einer
 *        Person. Rotation ist eine reine Zustellungs-Entscheidung an der
 *        Folgeinstanz: spawnRecurrenceFollowup() fragt hier nach, WEM die
 *        naechste Instanz gehoert. Die RRULE-Engine (services/recurrence.js)
 *        bleibt unangetastet - Rotation aendert nie ein Datum, nur den Inhaber.
 *
 *        Nur die feste Reihenfolge (upstream #1763: "An order, not a set").
 *        Verteilung nach Last oder Gerechtigkeit ist dort ausdruecklich
 *        ausserhalb des Rahmens - und jede dieser Strategien waere ein
 *        zweiter Weg, den Zeiger zu verlieren.
 *
 *        DER ZEIGER IST EINE POSITION. Die Serie merkt sich, welche
 *        Pool-Position zuletzt dran war (rotation_last_position) - nicht
 *        welche Person. Ein Mitglied, das den Pool verlaesst, verschiebt den
 *        Platz des Zeigers nicht; die sichtbare Reihenfolge laeuft dort
 *        weiter, wo sie war (Kevin, Max, Kevin - nie ein stiller Neustart
 *        vorn). rotation_last_user wandert weiter mit: der Zeiger sagt, WOHIN
 *        die Reihe zeigt, der Kopf sagt, WEN die letzte Runde bekommen hat -
 *        und die Wahl ueberspringt genau diesen Kopf (siehe nextRotationEntry).
 *
 *        Die offenen Fragen aus #1763, beantwortet in nextRotationEntry:
 *        - Erledigt eine ANDERE Person die Aufgabe, rueckt der Zeiger
 *          trotzdem weiter. Rotation folgt der Serie, nicht der Person, die
 *          abhakt.
 *        - Wird die Reihenfolge mitten in der Serie geaendert, bleibt der
 *          Zeiger stehen; niemand bekommt die naechste Instanz zweimal
 *          hintereinander (Kevin war dran, die neue Ordnung nennt Kevin vorn -
 *          die Wahl geht trotzdem weiter).
 *        - Die erste Abloesung startet an der Position der laufenden Instanz:
 *          haelt Kevin die Aufgabe, ist der Naechste nicht Kevin.
 *        - Ein Pool mit einem einzigen AKTIVEN Kopf verteilt an diesen einen
 *          (der Rest ist deaktiviert) - null hiesse: die Instanz bliebe beim
 *          Deaktivierten, den hier niemand erreichen kann.
 *
 *        Wer den Pool editiert, sieht nur die aktiven Koepfe. Dass ein
 *        normaler Speichervorgang (Titel, Intervall) dabei Positionen und
 *        deaktivierte Mitglieder nicht verschiebt, haelt mergeRotationPool
 *        fest - der Bestand gewinnt fuer alles, was schon drin steht.
 *
 *        Alles daran ist DETERMINISTISCH (kein Zufall): die Oberflaeche kann
 *        daraus "als naechstes: Leon" ableiten (rotation_next_user), ohne
 *        dass ein Blick in die Zukunft die Zuordnung veraendert.
 * Abhängigkeiten: account-state.js (reine SQL-Texte, keine Verbindung)
 */
import { activeAccountSql } from './account-state.js';

const MODES = ['round_robin'];

export function isRotationMode(value) {
  return value === null || value === undefined || MODES.includes(value);
}

/**
 * Die Pool-Zeilen einer Serie, in Ablieferungsreihenfolge, mit active-Flag:
 * ein deaktiviertes Konto (#1381) ist nur auf dem Papier dabei - die Aufgabe
 * an jemanden zu haengen, der sich nicht anmelden kann, ist der stille tote
 * Zweig, den #1763 schlimmer nennt als keine Rotation. Die Zeilen selbst
 * bleiben, wie sie sind (ein deaktiviertes Mitglied kann zurueckkommen); nur
 * die Wahl ueberspringt sie.
 */
function poolRows(d, task) {
  return d.prepare(`
    SELECT p.user_id, p.position, ${activeAccountSql('u')} AS active
    FROM task_rotation_pool p
    JOIN users u ON u.id = p.user_id
    WHERE p.task_id = ?
    ORDER BY p.position ASC, p.user_id ASC
  `).all(task.id);
}

/** Die Pool-Zeilen einer Aufgabe von aussen (Routen: Bestand, Merge, Sperre). */
export function rotationPoolRows(d, taskId) {
  return poolRows(d, { id: taskId });
}

/**
 * Die Wahl als reine Funktion ueber geladene Zeilen (die Routes laden den
 * Pool fuer eine ganze Liste auf einmal, siehe attachRotation in
 * routes/tasks.js):
 *
 *   rows     - Pool-Zeilen {user_id, position, active} in Reihenfolge
 *   pointer  - rotation_last_position der Serie (null = noch keine Ablösung)
 *   assignee - assigned_to der laufenden Instanz (Regel fuer die erste Ablösung)
 *   lastUser - rotation_last_user: der Kopf der letzten Runde (niemand
 *              bekommt zwei Instanzen hintereinander)
 *
 * Die nächste Position ist die erste AKTIVE Zeile mit einer Position ueber
 * dem Zeiger; ist keine uebrig, schliesst die Runde in die erste aktive
 * Zeile. Ein Zeiger ueber dem Pool (sein Mitglied ist raus, der Pool ist
 * kleiner) faellt ebenso zurueck, statt "wieder vorn" zweimal hintereinander
 * zu zeigen - die sichtbare Reihenfolge ist es, die der Zeiger schuetzt.
 *
 * NIEMAND ZWEIMAL HINTEREINANDER. Wie auch immer die neue Ordnung aussieht:
 * der Kopf der letzten Runde (lastUser, hilfsweise die Zeile auf dem Zeiger)
 * bekommt die naechste Instanz nicht. Genau das war der Fehler nach einem
 * Umsortieren - Kevin war dran, die neue Liste stellt ihn nach vorn, und die
 * reine Positionswahl tippte zurueck auf Kevin.
 *
 * Noch kein Zeiger: die Rotation hat nie abgelöst - die Zahlung beginnt an
 * der Position der laufenden Instanz (haelt Kevin die Aufgabe, ist der
 * Naechste nicht Kevin; die alte "sonst beginnt die Runde vorn"-Regel gab der
 * mittleren Person doppelt: Anna, Kevin, Anna, Max). Ist die laufende Instanz
 * nicht im Pool, beginnt die Runde vorn.
 *
 * Zurueck: null, wenn der Pool weniger als zwei Zeilen hat oder keinen
 * aktiven Kopf. Ein aktiver Restkopf in einem echten Pool bekommt die
 * Instanz - die Wahl hat keine bessere Antwort.
 */
export function nextRotationEntry(rows, { pointer = null, assignee = null, lastUser = null } = {}) {
  const active = rows.filter((r) => r.active);
  // Unter zwei Zeilen ist der Pool keine Rotation (dieselbe Person in
  // anderem Kostuem); ab zwei Zeilen verteilt ein einzelner aktiver Restkopf
  // weiter - die bessere Antwort gibt es nicht (SF zur zweiten Review).
  if (!active.length || rows.length < 2) return null;
  let from = pointer;
  let exclude = lastUser;
  if (from === null || from === undefined) {
    const running = rows.find((r) => r.user_id === assignee);
    from = running ? running.position : -1;
    exclude = assignee;
  } else if (exclude === null || exclude === undefined) {
    const row = rows.find((r) => r.position === from);
    exclude = row ? row.user_id : null;
  }
  const candidate = active.find((r) => r.position > from) ?? active[0];
  if (exclude !== null && candidate.user_id === exclude) {
    // Ein aktiver Restkopf ist besser als null: lieber dieselbe Person als
    // eine Instanz beim Deaktivierten, den niemand erreichen kann.
    return active.find((r) => r.user_id !== exclude) ?? candidate;
  }
  return candidate;
}

/**
 * Wer bekommt die naechste Folgeinstanz? Zurueck: { userId, position } oder
 * null (Rotation aus / leerer Pool). Der Zeiger ist die Position des letzten
 * Empfaengers - wer die Aufgabe abhakt, zaehlt nicht: Rotation folgt der
 * Serie, nicht der Person (#1763, offene Frage eins).
 */
export function pickRotationTarget(d, task) {
  if (!task.rotation_mode) return null;
  const entry = nextRotationEntry(poolRows(d, task), {
    pointer: task.rotation_last_position ?? null,
    assignee: task.assigned_to ?? null,
    lastUser: task.rotation_last_user ?? null,
  });
  return entry ? { userId: entry.user_id, position: entry.position } : null;
}

/** Nur die user_id der Wahl, fuer Aufrufer, denen der Platz egal ist. */
export function pickRotationUser(d, task) {
  return pickRotationTarget(d, task)?.userId ?? null;
}

/**
 * Den gesendeten Pool mit dem Bestand zusammenfuehren (#1763: "ein normaler
 * Speichervorgang verschiebt die Positionen nicht").
 *
 * DER BESTAND GEWINNT FUER ALLES, WAS SCHON DRIN STEHT. Der Dialog zeigt nur
 * die AKTIVEN Koepfe und sendet den Pool bei jedem Speichern mit - auch beim
 * reinen Titel-Editieren. Waere der Request die ganze Wahrheit, wuerde ein
 * solches Speichern die Positionen neu austeilen und jedes deaktivierte
 * Mitglied still aus dem Pool werfen. Also gilt:
 *
 *   - die Reihenfolge des Requests ist ausdruecklich gemeint: sie setzt die
 *     Reihenfolge der gesehenen Koepfe (Hoch/Runter-Zeilen im Dialog),
 *   - ein AKTIVES Mitglied ohne Haerkchen im Request ist ausdruecklich
 *     abgewaehlt - es geht raus,
 *   - ein DEAKTIVIERTES Mitglied ohne Haerkchen ist keine Aussage (es ist im
 *     Dialog gar nicht zu sehen) - es bleibt und bekommt seinen gespeicherten
 *     Rang zurueck,
 *   - neue Koepfe kommen in der Request-Reihenfolge dazu.
 *
 * Ein Request, der nur die aktive Sicht in Bestandsreihenfolge enthaelt,
 * kommt deshalb exakt als Bestand zurueck: Positionen und Zeiger bleiben
 * unbewegt. Zurueck: Liste der user_ids in neuer Reihenfolge.
 */
export function mergeRotationPool(rows, requestedIds) {
  const req = [...new Set((requestedIds ?? []).map(Number))];
  const reqSet = new Set(req);
  const kept = req.slice();
  for (const r of rows) {
    if (r.active || reqSet.has(r.user_id)) continue;
    kept.splice(Math.min(r.position, kept.length), 0, r.user_id);
  }
  return kept;
}

/**
 * Modus + Pool + Zeiger als Wert auf eine Aufgabe schreiben (POST/PUT/
 * Anlegen der Folgeinstanz). `null`-Werte loeschen die Rotation. Der Pool
 * ist eine Liste von user_ids (Positionen 0..n-1) oder eine Liste
 * {user_id, position}-Zeilen wie sie sind - die Folgeinstanz traegt den
 * Pool samt seiner Luecken weiter, sonst wuerde der mitgenommene Zeiger auf
 * einmal eine andere Person meinen. Der Zeiger (lastPosition) ist der
 * Bestell-Zustand, lastUser sagt nur, welchen Kopf er nennt - beide wandern
 * zusammen.
 */
export function setRotation(d, taskId, { mode = null, pool = null, lastUser = null, lastPosition = null } = {}) {
  d.prepare('UPDATE tasks SET rotation_mode = ?, rotation_last_user = ?, rotation_last_position = ? WHERE id = ?')
    .run(mode ?? null, lastUser ?? null, lastPosition ?? null, taskId);
  if (pool === null) {
    if (mode === null) d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
  } else {
    d.prepare('DELETE FROM task_rotation_pool WHERE task_id = ?').run(taskId);
    const ins = d.prepare('INSERT INTO task_rotation_pool (task_id, user_id, position) VALUES (?, ?, ?)');
    pool.forEach((entry, i) => {
      if (typeof entry === 'number') ins.run(taskId, entry, i);
      else ins.run(taskId, entry.user_id, entry.position);
    });
  }
}

/**
 * Rotation auf eine Folgeinstanz kopieren (Modus, Pool und Zeiger reisen als
 * Wert mit, #1603-Prinzip). Der Pool wandert samt Positionen - der Zeiger
 * der eben erledigten Instanz zeigt auf eine davon, und er zeigt richtig,
 * nur wenn die Zeilen unveraendert dastehen. Der frische Zeiger ist der
 * gewaehlte Platz; den setzt der Aufrufer unmittelbar danach.
 */
export function carryRotation(d, originTask, newTaskId) {
  if (!originTask?.rotation_mode) return;
  setRotation(d, newTaskId, {
    mode: originTask.rotation_mode,
    pool: poolRows(d, originTask).map((r) => ({ user_id: r.user_id, position: r.position })),
    lastUser: originTask.rotation_last_user,
    lastPosition: originTask.rotation_last_position,
  });
}
