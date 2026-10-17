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
 * Abhaengigkeiten: server/permissions.js
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
