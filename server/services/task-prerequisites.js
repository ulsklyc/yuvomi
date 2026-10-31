/**
 * Modul: Vorheraufgaben (blockierende Voraussetzungen)
 * Zweck: Welche Aufgabe blockiert welche. Eine Aufgabe ist erst abhakbar, wenn
 *        alle ihre Vorheraufgaben erledigt sind. Eigene Beziehung - weder
 *        Unterstruktur (parent_task_id) noch Serie (recurrence_origin_id).
 *
 * Regeln:
 * - Selbstreferenz und Zyklen sind beim Setzen verboten (400 im Router).
 * - Geloeschte Aufgaben fallen per CASCADE aus der Tabelle - eine Bedingung,
 *   die nicht mehr existiert, blockiert nichts mehr.
 * - geprueft wird beim Abhaken (Status -> done), nicht beim Zuruecknehmen:
 *   eine wieder offene Vorheraufgabe macht die Folgeaufgabe nur erneut
 *   nicht abhakbar, sie oeffnet nichts von selbst.
 */

/** Vorheraufgaben einer Aufgabe, mit Status fuer die Anzeige. */
export function prerequisitesOf(d, taskId) {
  return d.prepare(`
    SELECT t.id, t.title, t.status, t.archived_at,
           u.display_name AS assigned_name
    FROM task_prerequisites p
    JOIN tasks t ON t.id = p.prerequisite_task_id
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE p.task_id = ?
    ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.title
  `).all(taskId).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    done: r.status === 'done' && !r.archived_at,
    assigned_name: r.assigned_name,
  }));
}

/** Noch offene Vorheraufgaben (ohne archivierte); leere Liste = nichts blockiert. */
export function unmetPrerequisites(d, taskId) {
  return prerequisitesOf(d, taskId).filter((p) => !p.done);
}

/** Zahl der offenen Vorheraufgaben - fuer das Abzeichen in der Liste. */
export function openPrerequisiteCountSql(taskAlias) {
  return `(SELECT COUNT(*) FROM task_prerequisites p
     JOIN tasks pt ON pt.id = p.prerequisite_task_id
    WHERE p.task_id = ${taskAlias}.id AND pt.status != 'done' AND pt.archived_at IS NULL) AS open_prerequisite_count`;
}

/**
 * Setzt die Vorheraufgaben-Liste einer Aufgabe (Ersetz-Semantik).
 * Warft Fehler mit .code, damit der Router in die Antwort uebersetzen kann:
 *   prerequisite_self      - die Aufgabe soll ihre eigene Voraussetzung sein
 *   prerequisite_not_found - eine uebergebene id existiert nicht (oder ist archiviert)
 *   prerequisite_cycle     - die Kante schliesst einen Kreis (A blockiert B blockiert A)
 */
export function setPrerequisites(d, taskId, ids) {
  const wanted = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (wanted.includes(Number(taskId))) {
    const err = new Error('a task cannot be its own prerequisite');
    err.code = 'prerequisite_self';
    throw err;
  }
  for (const id of wanted) {
    const row = d.prepare('SELECT 1 AS ok FROM tasks WHERE id = ? AND archived_at IS NULL').get(id);
    if (!row) {
      const err = new Error(`prerequisite task ${id} not found`);
      err.code = 'prerequisite_not_found';
      throw err;
    }
  }
  if (findsCycle(d, Number(taskId), wanted)) {
    const err = new Error('prerequisite cycle');
    err.code = 'prerequisite_cycle';
    throw err;
  }
  d.transaction(() => {
    d.prepare('DELETE FROM task_prerequisites WHERE task_id = ?').run(taskId);
    const insert = d.prepare('INSERT INTO task_prerequisites (task_id, prerequisite_task_id) VALUES (?, ?)');
    for (const id of wanted) insert.run(taskId, id);
  })();
}

/**
 * Zykluspruefung gegen den ENDZUSTAND: eigene Kanten von taskId aussen vor,
 * die vorgeschlagenen dazu. Ein Kreis existiert, wenn von taskId ueber
 * Vorgaenger-Kanten zurueck zu taskId gelangt wird. Der Bestand ist
 * haeuslich klein (einige hundert Aufgaben) - die Kanten in den Speicher zu
 * lesen ist einfacher als ein rekursiver CTE mit ausgeschlossener Teilmenge.
 */
function findsCycle(d, taskId, proposed) {
  const edges = new Map();
  for (const row of d.prepare('SELECT task_id, prerequisite_task_id FROM task_prerequisites').all()) {
    if (row.task_id === taskId) continue; // wird gerade ersetzt
    if (!edges.has(row.task_id)) edges.set(row.task_id, new Set());
    edges.get(row.task_id).add(row.prerequisite_task_id);
  }
  edges.set(taskId, new Set(proposed));
  // Von taskId aus den Vorgaenger-Baum hinab: taucht taskId wieder auf, schliesst
  // eine vorgeschlagene Kante (alt oder neu) einen Kreis.
  const seen = new Set();
  const stack = [...proposed];
  while (stack.length) {
    const node = stack.pop();
    if (node === taskId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edges.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Vorheraufgaben einer Folgeinstanz mitsamt denen ihrer kopierten
 * Unteraufgaben uebernehmen (spawnRecurrenceFollowup ruft das in seiner
 * Transaktion auf). Ohne das Mitnehmen waere die Folgeinstanz plotzlich
 * unblockiert - dieselbe stille Verhaltensaenderung, die bei `locked` und
 * `countdown` schon Pflicht war.
 */
export function copyPrerequisites(d, fromTaskId, toTaskId) {
  const rows = d.prepare('SELECT prerequisite_task_id FROM task_prerequisites WHERE task_id = ?').all(fromTaskId);
  if (!rows.length) return;
  const insert = d.prepare('INSERT OR IGNORE INTO task_prerequisites (task_id, prerequisite_task_id) VALUES (?, ?)');
  for (const r of rows) insert.run(toTaskId, r.prerequisite_task_id);
}
