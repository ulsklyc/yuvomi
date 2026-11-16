/**
 * Visibility matrix helper: the event reads a paired display reaches with its
 * `calendar:read` and `dashboard:read` scopes, which a display reads under the wall
 * rule (rowReader in server/authorize) and people under the event row rule - the
 * calendar range, the upcoming list, the event search, the detail, the event count of
 * a local calendar and the event parts of the personal dashboard.
 *
 * Kept out of test-visibility-matrix.js, which stands at its max-lines limit; the
 * caller hands in its own measuring tools, so the cells classify and flag exactly
 * like the rest of the row_rules/series block.
 *
 * The events and their local calendar are written right before the calls and deleted
 * right after them, so the row state check of the suite (ruleRowState) sees the rows
 * unchanged.
 */

/** The search word every seeded title carries. */
const WORD = 'mxwallprobe';

/**
 * @param {{
 *   db: any, where: string, day: string, ids: Record<string, number>,
 *   call: (method: string, path: string, body?: unknown) => Promise<{ status: number, body: any }>,
 *   readRefusal: (res: { status: number, body: any }, where: string) => { status: number, reason: string } | null,
 *   listField: (container: any, key: string, where: string) => { list: any[] } | { value: { status: number, reason: string } },
 *   WriteCell: new (where: string, ok: { status: number }, hidden: string) => { add: Function, value: () => unknown },
 * }} tools
 * @returns {Promise<Record<string, unknown>>}
 */
export async function measureWallEventReads({ db, where, day, ids, call, readRefusal, listField, WriteCell }) {
  const calendarId = Number(db.prepare(
    "INSERT INTO local_calendars (name, color, is_default, sort_order, created_by) VALUES ('mx-wall-events', '#123456', 0, 99, ?) RETURNING id",
  ).get(ids.admin).id);
  const insert = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, local_calendar_id, countdown)
    VALUES (?, ?, 1, ?, ?, 'local', ?, 1) RETURNING id
  `);
  const assign = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  // wevent.admin.<level> by the admin, all and assignees assigned to the member;
  // wevent.admin.assignees.display assigned to the display and the member (not a
  // realistic state: the app never offers a display as an assignee).
  const rows = [
    ['wevent.admin.all', 'all', [ids.member]],
    ['wevent.admin.assignees', 'assignees', [ids.member]],
    ['wevent.admin.assignees.display', 'assignees', [ids.display, ids.member]],
    ['wevent.admin.private', 'private', []],
  ].map(([name, level, assignees]) => {
    const id = Number(insert.get(`${name} ${WORD}`, day, level, ids.admin, calendarId).id);
    for (const userId of /** @type {number[]} */ (assignees)) assign.run(id, userId);
    return { id, name: /** @type {string} */ (name) };
  });
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  /** @type {Record<string, unknown>} */
  const out = {};
  try {
    /** @param {string} key @param {{ status: number, body: any }} res @param {string} field @param {(row: any) => boolean} [keep] */
    const names = (key, res, field, keep = () => true) => {
      const refusal = readRefusal(res, `${where} / ${key}`);
      if (refusal) return refusal;
      const found = listField(res.body, field, `${where} / ${key}`);
      if (!('list' in found)) return found.value;
      return [...new Set(found.list.filter(keep).map((e) => nameOf.get(e.id)).filter(Boolean))].sort();
    };
    out.wall_list = names('wall_list', await call('GET', `/calendar?from=${day}&to=${day}`), 'data');
    out.wall_upcoming = names('wall_upcoming', await call('GET', '/calendar/upcoming?limit=20'), 'data');
    out.wall_search = names('wall_search', await call('GET', `/calendar/search?q=${WORD}`), 'data');
    const detail = new WriteCell(`${where} / wall_detail`, { status: 200 }, 'calendar_event_not_found');
    for (const r of rows) detail.add(r.name, await call('GET', `/calendar/${r.id}`));
    out.wall_detail = detail.value();
    const calendars = await call('GET', '/calendar/calendars');
    out.wall_calendar_count = readRefusal(calendars, `${where} / wall_calendar_count`)
      ?? (calendars.body?.data ?? []).find((/** @type {any} */ c) => c.id === calendarId)?.event_count ?? null;
    const overview = await call('GET', `/dashboard?events_calendar=local:${calendarId}&events_limit=12`);
    out.wall_overview_upcoming = names('wall_overview_upcoming', overview, 'upcomingEvents');
    out.wall_overview_week = names('wall_overview_week', overview, 'weekEvents');
    out.wall_overview_family = names('wall_overview_family', overview, 'familyEvents');
    out.wall_overview_countdowns = names('wall_overview_countdowns', overview, 'countdowns', (c) => c.source === 'event');
  } finally {
    for (const r of rows) db.prepare('DELETE FROM calendar_events WHERE id = ?').run(r.id);
    db.prepare('DELETE FROM local_calendars WHERE id = ?').run(calendarId);
  }
  return out;
}
