/**
 * Module: notes - the note block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the notes module: the
 *          preview list (pinned first, then newest, with categories), the real
 *          pinned count and the total the preview draws from.
 *
 * THE CONTRACT. notesOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock (no read here needs a day). The row rule comes from authorize
 * (visibleWhere for notes and note categories, bound to the reader's own id - a
 * note answers to the person rule, also on a display; the wall itself leaves the
 * notes module out before the slice is called). The category selection comes in
 * `options`, never from a request.
 *
 * ONE FAILURE, AS BEFORE: the three reads used to share one try/catch in the
 * route; `guard` (the route's runSlice()) carries that under the old name
 * `pinnedNotes` and with the old failure value (NOTES_BLOCK_FAILED): one failing
 * read empties all three. Without a guard a failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD (the golden master test:overview-golden
 * holds the answers, not the ties of an ordering).
 *
 * Dependencies: server/authorize/index.ts (row rule), services/note-categories.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import { visibleWhere } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { hydrateNotesWithCategories } from './note-categories.js';

/** Query options of the overview that act on the note block. */
export type NotesOverviewOptions = Readonly<{
  /** Normalized `notes_category` ids (normalizeNoteCategoryFilter); empty = all. */
  categories?: readonly number[];
}>;

type NoteRow = Record<string, unknown>;

export type NotesOverview = {
  pinnedNotes: NoteRow[];
  pinnedNotesCount: number;
  notesTotal: number;
};

/**
 * The empty form: a denied or switched-off notes module (DENIED_PAYLOAD in the
 * route). The key order is the order the route has always written them in.
 */
export function emptyNotesOverview(): NotesOverview {
  return { pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 };
}

/** What the block answers when one of its reads fails. Kept as the route wrote it. */
export const NOTES_BLOCK_FAILED: Readonly<NotesOverview> = Object.freeze({
  pinnedNotes: [],
  pinnedNotesCount: 0,
  notesTotal: 0,
});

const passThrough: SliceGuard = (_name, read) => read();

/**
 * `?notes_category=` as a list of category ids: given once or several times, only
 * positive integers, without duplicates, at most 50 - the same shape and cap as
 * `shopping_list` and the stored options (preferences.js). Anything else drops
 * out, never an error.
 */
export function normalizeNoteCategoryFilter(raw: unknown): number[] {
  return [...new Set(
    (Array.isArray(raw) ? raw : [raw])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )].slice(0, 50);
}

/**
 * The note block of the overview.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request (its `userId` is the viewer)
 * @param _ctx    today, zone and now of the request (no read here needs them)
 * @param options the note options of the request (category selection)
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function notesOverviewSlice(
  db: Database,
  actor: RowReader,
  _ctx: OverviewContext,
  options: NotesOverviewOptions = {},
  guard: SliceGuard = passThrough,
): NotesOverview {
  const userId = actor.userId;
  const noteCategories = [...(options.categories ?? [])];
  const noteCategoryBinds = Object.fromEntries(noteCategories.map((id, index) => [`note_category_${index}`, id]));
  // One EXISTS per selected category, deliberately AND. The visibility condition
  // in the subselect keeps guessed ids of someone else's personal categories from
  // telling which shared notes they are attached to.
  const noteCategoryAnd = noteCategories.map((_id, index) => `
    AND EXISTS (
      SELECT 1
      FROM note_category_assignments nca
      JOIN note_categories nc ON nc.id = nca.category_id
      WHERE nca.note_id = n.id
        AND nc.id = @note_category_${index}
        AND ${visibleWhere('note_categories', 'nc', '@me')}
    )
  `).join('');

  // Newest notes (pinned first, then most recent).
  return guard('pinnedNotes', (): NotesOverview => {
    const listed = db.prepare(`
      SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
      FROM notes n
      LEFT JOIN users u ON n.created_by = u.id
      WHERE ${visibleWhere('notes', 'n', '@me')} ${noteCategoryAnd}
      ORDER BY n.pinned DESC, n.updated_at DESC
      -- FUENF, WEIL DIE KACHEL ZWEI HOCH SEIN DARF - dieselbe Korrektur, die
      -- die Geburtstage oben schon bekommen haben und bei der die Notizen
      -- uebersehen wurden. Der Schnitt stand auf drei und war damit die
      -- Obergrenze fuer JEDE Kachelgroesse; die Notizkachel startet ab Werk auf
      -- 1x2, hat also Platz fuer fuenf Zeilen und bekam trotzdem nur drei
      -- geliefert. Wie viele wirklich erscheinen, entscheidet die Kachel
      -- (listRowCap in public/pages/dashboard.js) - der Server liefert nur
      -- den Vorrat fuer die groesste Fassung.
      LIMIT 5
    `).all({ me: userId, ...noteCategoryBinds }) as NoteRow[];
    const pinnedNotes = hydrateNotesWithCategories(db, listed, userId) as NoteRow[];
    /* `pinnedNotes` IS CALLED THAT BUT IS NOT: the list sorts pinned notes to the
     * front and cuts off - it does not filter. Right for the preview (it shows
     * what lies on top), twice wrong as a NUMBER: a household without a single pin
     * read "3 pinned", one with five pins "3" as well (Codex review on PR #754).
     * The metric tile therefore needs its own, real count. */
    const pinnedNotesCount = (db.prepare(`
      SELECT COUNT(*) AS n FROM notes n
      WHERE n.pinned = 1 AND ${visibleWhere('notes', 'n', '@me')} ${noteCategoryAnd}
    `).get({ me: userId, ...noteCategoryBinds }) as { n: number }).n;
    /* AND THE SET THE PREVIEW DRAWS FROM - for the badge and the tile's "+N more".
     * `pinnedNotesCount` is the wrong number for that: the preview fills up with
     * the newest after the pinned ones, a badge "1" over three cards would be the
     * same contradiction as the "3" with five pinned before. The same category
     * filter as list and pin count (#814: filter before the cut AND the count). */
    const notesTotal = (db.prepare(`
      SELECT COUNT(*) AS n FROM notes n
      WHERE ${visibleWhere('notes', 'n', '@me')} ${noteCategoryAnd}
    `).get({ me: userId, ...noteCategoryBinds }) as { n: number }).n;
    return { pinnedNotes, pinnedNotesCount, notesTotal };
  }, { ...NOTES_BLOCK_FAILED, pinnedNotes: [] });
}
