/**
 * Module: shopping - the shopping blocks of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the shopping module: the
 *          open count over all lists, the lists with open items (with their item
 *          preview) and, only for a list selection, the tile of its own
 *          (`shoppingTile`, #1818).
 *
 * THE CONTRACT. shoppingOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous and reads no clock (no block here needs a day). Shopping lists have
 * no row visibility: the module is visible as a whole or not at all, which the
 * route decides before it calls the slice. The list selection of the tile comes in
 * `options`, never from a request.
 *
 * ONE FAILURE PER BLOCK, AS BEFORE. Each read used to have its own try/catch in
 * the route; `guard` (the route's runSlice()) carries that under the old names and
 * with the old failure values (SHOPPING_BLOCK_FAILED). A failed selection read
 * logs `shopping selection error:` and answers "no selection"; a failed tile read
 * logs `shoppingTile error:` and leaves the field out, so the tile shows all lists.
 * Without a guard a failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD (the golden master test:overview-golden
 * holds the answers, not the ties of an ordering).
 *
 * Dependencies: server/authorize/index.ts (types only). Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';

/** Query options of the overview that act on the shopping blocks. */
export type ShoppingOverviewOptions = Readonly<{
  /** Normalized `shopping_list` ids (normalizeShoppingListFilter); empty = no selection. */
  listSelection?: readonly number[];
  /** Whether the answer carries `shoppingTile` at all (false: the wall leaves it out). */
  withTile?: boolean;
}>;

type ShoppingItem = { id: number; name: string; quantity: string | null; is_checked: number };
type ShoppingList = {
  id: number;
  name: string;
  open_count: number;
  total_count: number;
  items?: ShoppingItem[];
};
type ShoppingTile = { lists: ShoppingList[]; openCount: number; listCount: number };

export type ShoppingOverview = {
  shoppingLists: ShoppingList[];
  shoppingOpenCount: number | null;
  shoppingOpenLists: number;
  /** Only with a list selection that still names an existing list. */
  shoppingTile?: ShoppingTile;
};

/**
 * The empty form: a denied or switched-off shopping module (DENIED_PAYLOAD in the
 * route). `shoppingTile` is missing on purpose: its empty form is the missing
 * field. The key order is the order the route has always written them in.
 */
export function emptyShoppingOverview(): ShoppingOverview {
  return { shoppingLists: [], shoppingOpenCount: 0, shoppingOpenLists: 0 };
}

/**
 * What each block answers when its own read fails. A failed open count is `null`
 * (the tile says "try again" instead of a plausible 0), its list count 0. A failed
 * tile has no value: the field stays out. Kept as the route wrote it.
 */
export const SHOPPING_BLOCK_FAILED: Readonly<ShoppingOverview> = Object.freeze({
  shoppingLists: [],
  shoppingOpenCount: null,
  shoppingOpenLists: 0,
});

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The shopping blocks of the overview.
 *
 * @param db      the connection of the request
 * @param _actor  the row reader of the request (shopping has no row rule)
 * @param _ctx    today, zone and now of the request (no block needs them)
 * @param options the shopping options of the request (list selection of the tile)
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function shoppingOverviewSlice(
  db: Database,
  _actor: RowReader,
  _ctx: OverviewContext,
  options: ShoppingOverviewOptions = {},
  guard: SliceGuard = passThrough,
): ShoppingOverview {
  const wanted = [...(options.listSelection ?? [])];

  // The selection is checked against the table, not only its shape: a list that
  // is gone drops out, and if none is left the request counts as unfiltered.
  const shoppingSelection = guard('shopping selection', () => {
    if (!wanted.length) return null;
    const existing = (db.prepare(
      `SELECT id FROM shopping_lists WHERE id IN (${wanted.map(() => '?').join(', ')})`,
    ).all(...wanted) as { id: number }[]).map((row) => row.id);
    return existing.length ? existing : null;
  }, null);
  const shoppingMarks = shoppingSelection ? shoppingSelection.map(() => '?').join(', ') : '';
  const shoppingBinds = shoppingSelection ?? [];

  const openCounts = guard('shoppingOpenCount', () => {
    const row = db.prepare(`
      SELECT COUNT(*) AS items, COUNT(DISTINCT si.list_id) AS lists
      FROM shopping_items si WHERE si.is_checked = 0
    `).get() as { items: number; lists: number };
    return { shoppingOpenCount: row.items as number | null, shoppingOpenLists: row.lists };
  }, {
    shoppingOpenCount: SHOPPING_BLOCK_FAILED.shoppingOpenCount,
    shoppingOpenLists: SHOPPING_BLOCK_FAILED.shoppingOpenLists,
  });

  // Up to six open items per list, oldest first.
  const shoppingItemsOf = (listId: number): ShoppingItem[] => db.prepare(`
    SELECT id, name, quantity, is_checked
    FROM shopping_items
    WHERE list_id = ? AND is_checked = 0
    ORDER BY id ASC
    LIMIT 6
  `).all(listId) as ShoppingItem[];

  // Lists with open items (at most 3, up to 6 open items each). Always over ALL
  // lists - whatever speaks of shopping outside the tile reads this field and the
  // two counts above.
  const shoppingLists = guard('shoppingLists', () => {
    const lists = db.prepare(`
      SELECT sl.id, sl.name,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) AS open_count,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id) AS total_count
      FROM shopping_lists sl
      WHERE (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) > 0
      ORDER BY sl.updated_at DESC
      LIMIT 3
    `).all() as ShoppingList[];
    for (const list of lists) list.items = shoppingItemsOf(list.id);
    return lists;
  }, SHOPPING_BLOCK_FAILED.shoppingLists);

  // THE TILE'S OWN VERSION (#1818), only for a selection. The chosen lists stand
  // there EVEN WITHOUT open items; lists with open items first, so the cap of three
  // hides no full list behind an empty one. `listCount` counts EVERY chosen list
  // that exists, for the tile's "+n more lists".
  const shoppingTile = shoppingSelection && options.withTile !== false
    ? guard('shoppingTile', (): ShoppingTile => {
      const lists = db.prepare(`
      SELECT sl.id, sl.name,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) AS open_count,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id) AS total_count
      FROM shopping_lists sl
      WHERE sl.id IN (${shoppingMarks})
      ORDER BY (open_count > 0) DESC, sl.updated_at DESC
      LIMIT 3
    `).all(...shoppingBinds) as ShoppingList[];
      for (const list of lists) list.items = shoppingItemsOf(list.id);
      const openCount = (db.prepare(`
      SELECT COUNT(*) AS items FROM shopping_items si
      WHERE si.is_checked = 0 AND si.list_id IN (${shoppingMarks})
    `).get(...shoppingBinds) as { items: number }).items;
      return { lists, openCount, listCount: shoppingSelection.length };
    }, null)
    : null;

  return {
    shoppingLists,
    ...openCounts,
    ...(shoppingTile ? { shoppingTile } : {}),
  };
}
