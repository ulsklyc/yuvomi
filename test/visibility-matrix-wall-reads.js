/**
 * Visibility matrix helper: the task reads outside GET /tasks that a paired display
 * reads under the wall rule (taskReader in server/authorize) and people under the
 * task row rule - the tag lists, the linked documents of a task, the task parts of
 * the personal dashboard and the task reference of a points ledger row.
 *
 * Kept out of test-visibility-matrix.js, which stands at its max-lines limit; the
 * caller hands in its own measuring tools, so the cells classify and flag exactly
 * like the rest of the row_rules/task_writes block.
 *
 * Every seeded state (a tag, a temporary category/due date/countdown flag, a ledger
 * row) is written right before its call and taken back right after it, so the row
 * state check of the suite (ruleRowState) sees the rows unchanged.
 */

/** Temporary task category that isolates one seeded task in the dashboard. */
const WALL_CATEGORY = 'mx-wall-read';

/**
 * @param {{
 *   db: any, where: string, today: string, ledgerOwner: number,
 *   tasks: { id: number, name: string }[],
 *   call: (method: string, path: string, body?: unknown) => Promise<{ status: number, body: any }>,
 *   readRefusal: (res: { status: number, body: any }, where: string) => { status: number, reason: string } | null,
 *   listField: (container: any, key: string, where: string) => { list: any[] } | { value: { status: number, reason: string } },
 *   flag: (where: string, what: string) => void,
 *   WriteCell: new (where: string, ok: { status: number }, hidden: string) => { add: Function, value: () => unknown },
 * }} tools
 * @returns {Promise<Record<string, unknown>>}
 */
export async function measureWallReads({ db, where, today, ledgerOwner, tasks, call, readRefusal, listField, flag, WriteCell }) {
  const nameOf = new Map(tasks.map((t) => [t.id, t.name]));
  /** @type {Record<string, unknown>} */
  const out = {};

  /**
   * The seeded names a list answer carries, or the refusal.
   * @param {string} key @param {{ status: number, body: any }} res @param {string} field
   * @param {(row: any) => string | undefined} nameOfRow
   */
  const names = (key, res, field, nameOfRow) => {
    const refusal = readRefusal(res, `${where} / ${key}`);
    if (refusal) return refusal;
    const found = listField(res.body, field, `${where} / ${key}`);
    return 'list' in found ? found.list.map(nameOfRow).filter(Boolean).sort() : found.value;
  };

  // tags / options_tags: one tag per seeded task (the tag is `mx-<name>`), listed by
  // GET /tasks/tags and in the tags of GET /tasks/meta/options.
  const tagOf = new Map(tasks.map((t) => [`mx-${t.name}`, t.name]));
  const insertTag = db.prepare('INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)');
  for (const t of tasks) insertTag.run(t.id, `mx-${t.name}`, `mx-${t.name}`.toLowerCase());
  const tagName = (/** @type {any} */ row) => tagOf.get(row?.tag);
  out.tags = names('tags', await call('GET', '/tasks/tags'), 'data', tagName);
  out.options_tags = names('options_tags', await call('GET', '/tasks/meta/options'), 'tags', tagName);
  for (const t of tasks) db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_key = ?').run(t.id, `mx-${t.name}`.toLowerCase());

  // documents: GET /tasks/:id/documents per seeded task. A task the reader does not
  // see answers 404 like an unknown id; without the documents module the route
  // answers 403 cross_module_access after that check.
  const documents = new WriteCell(`${where} / documents`, { status: 200 }, 'tasks_task_not_found');
  for (const t of tasks) documents.add(t.name, await call('GET', `/tasks/${t.id}/documents`));
  out.documents = documents.value();

  // overview / overview_countdowns: GET /dashboard (personal, no audience) with one
  // seeded task at a time made due today, flagged as a countdown and put into a
  // category of its own, which the request filters on; overview names the tasks in
  // urgentTasks (openTaskCount has to agree), overview_countdowns the task countdowns.
  const row = db.prepare('SELECT category, due_date, countdown FROM tasks WHERE id = ?');
  const setRow = db.prepare('UPDATE tasks SET category = @category, due_date = @due_date, countdown = @countdown WHERE id = @id');
  /** @type {string[]} */ const urgent = [];
  /** @type {string[]} */ const countdowns = [];
  /** @type {{ status: number, reason: string } | null} */ let overviewRefusal = null;
  for (const t of tasks) {
    const before = row.get(t.id);
    setRow.run({ id: t.id, category: WALL_CATEGORY, due_date: today, countdown: 1 });
    const res = await call('GET', `/dashboard?tasks_category=${WALL_CATEGORY}`);
    setRow.run({ id: t.id, ...before });
    const refusal = readRefusal(res, `${where} / overview`);
    if (refusal) { overviewRefusal = refusal; continue; }
    const listed = (res.body?.urgentTasks ?? []).some((/** @type {any} */ x) => x.id === t.id);
    if (listed) urgent.push(t.name);
    if (res.body?.openTaskCount !== (listed ? 1 : 0)) {
      flag(`${where} / overview / ${t.name}`, `openTaskCount ${res.body?.openTaskCount} beside urgentTasks ${listed}`);
    }
    if ((res.body?.countdowns ?? []).some((/** @type {any} */ c) => c.source === 'task' && c.id === t.id)) countdowns.push(t.name);
  }
  out.overview = overviewRefusal ?? urgent.sort();
  out.overview_countdowns = overviewRefusal ?? countdowns.sort();

  // ledger: one points row per seeded task for ledgerOwner; the cell names the rows
  // whose task reference (task_id, reason) GET /rewards/ledger hands out unmasked.
  const insertLedger = db.prepare(
    "INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, unit, created_by) VALUES (?, 1, 'earn', ?, ?, 'points', ?) RETURNING id",
  );
  const ledgerIds = tasks.map((t) => insertLedger.get(ledgerOwner, t.name, t.id, ledgerOwner).id);
  const ledger = await call('GET', '/rewards/ledger?limit=500');
  for (const id of ledgerIds) db.prepare('DELETE FROM reward_ledger WHERE id = ?').run(id);
  const ownIds = new Set(ledgerIds);
  // The rule masks the task reference only: every row stays listed with its points.
  const kept = Array.isArray(ledger.body?.data) ? ledger.body.data.filter((/** @type {any} */ e) => ownIds.has(e.id)) : null;
  if (kept && (kept.length !== tasks.length || kept.some((/** @type {any} */ e) => e.delta !== 1))) {
    flag(`${where} / ledger`, `${kept.length} of ${tasks.length} rows listed with their points`);
  }
  out.ledger = names('ledger', ledger, 'data', (/** @type {any} */ entry) => {
    if (!ownIds.has(entry.id)) return undefined;
    if (entry.task_id == null) return undefined;
    if (entry.reason !== nameOf.get(entry.task_id)) flag(`${where} / ledger`, `reason ${entry.reason} beside task ${entry.task_id}`);
    return nameOf.get(entry.task_id);
  });
  return out;
}
