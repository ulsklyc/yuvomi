/**
 * Modul: Wem eine Zahlungsaufgabe der Haushaltshilfe gehoert (R20)
 * Zweck: EINE Regel fuer drei Wege - den Check-in, der die Aufgabe anlegt, das
 *        Bearbeiten eines Besuchs, das eine alte Aufgabe nachzieht, und die
 *        Migration, die den offenen Altbestand nachzieht (server/db.js).
 * Abhaengigkeiten: server/permissions.js (ohne db.js, nutzbar in Migrationen)
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
 * sie verborgen sein soll. Erstellerin wird dann die erste Admin-Person; gibt
 * es keine, entsteht keine Zahlungsaufgabe, und eine alte bleibt, wie sie ist
 * (niemand sonst koennte sie danach noch sehen).
 */

import { userHasCapability } from '../permissions.js';

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
  const admins = database.prepare(`
    SELECT id FROM users
    WHERE role = 'admin' AND deactivated_at IS NULL
    ORDER BY id ASC
  `).all().map((row) => row.id);
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
 * ist schon eine bewusste Wahl), ebenso eine ohne moegliche Eigentuemerin.
 *
 * Die Aufrufer sorgen fuer die Transaktion.
 *
 * @returns {boolean} ob die Aufgabe geaendert wurde
 */
export function normalizePaymentTaskAudience(database, taskId) {
  if (taskId == null) return false;
  const task = database.prepare('SELECT id, created_by, visibility FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.visibility !== 'all') return false;
  const creator = task.created_by == null
    ? null
    : database.prepare('SELECT id, deactivated_at FROM users WHERE id = ?').get(task.created_by);
  const creatorSees = Boolean(creator && creator.deactivated_at == null
    && userHasCapability(database, creator.id, AMOUNTS_CAPABILITY));
  const audience = paymentTaskAudience(database, creator?.id ?? null, creatorSees);
  if (!audience) return false;
  database.prepare(`
    UPDATE tasks SET visibility = 'assignees', created_by = ?, assigned_to = ? WHERE id = ?
  `).run(audience.createdBy, audience.assignees[0], task.id);
  database.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(task.id);
  const assign = database.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const id of audience.assignees) assign.run(task.id, id);
  return true;
}

/**
 * Der Nachtrag der Migration: jede OFFENE Zahlungsaufgabe (verknuepft ueber
 * `housekeeping_work_sessions.payment_task_id`, nicht erledigt, nicht
 * archiviert), die noch auf `all` steht. Erledigte bleiben stehen (Ulas
 * 2026-10-17); sie zieht erst das naechste Bearbeiten ihres Besuchs nach.
 *
 * @returns {number} Anzahl nachgezogener Aufgaben
 */
export function normalizeOpenPaymentTasks(database) {
  const ids = database.prepare(`
    SELECT DISTINCT t.id FROM housekeeping_work_sessions s
    JOIN tasks t ON t.id = s.payment_task_id
    WHERE t.visibility = 'all' AND t.status <> 'done' AND t.archived_at IS NULL
    ORDER BY t.id
  `).all().map((row) => row.id);
  let changed = 0;
  for (const id of ids) if (normalizePaymentTaskAudience(database, id)) changed += 1;
  return changed;
}
