/**
 * Module: inventory - the inventory hits of the global search as one search slice
 *         (phase 2, section D)
 * Purpose: inventorySearchSlice(db, actor, query) answers the `inventory` bucket of
 *          services/search.js runTableSearch. No FTS index: the rows come in the
 *          SQL order and the first SEARCH_LIMIT that match stay. Household
 *          property: no row rule, the actor is unused; module rights and the
 *          household switch are checked by the orchestration before the call.
 *
 * THE SQL IS THE SEARCH'S, WORD FOR WORD.
 *
 * Dependencies: services/search-text.ts. Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import type { SearchActor, SearchRow, TableSearchQuery } from './search-text.ts';
import { SEARCH_LIMIT, firstMatches, pick, withExcerpt } from './search-text.ts';

/** The inventory hits of the global search. */
export function inventorySearchSlice(db: Database, _actor: SearchActor, query: TableSearchQuery): SearchRow[] {
  const { text: q, matches } = query;
  const limit = SEARCH_LIMIT;
  // Inventar: aktive Gegenstaende zuerst, verkaufte/entsorgte bleiben
  // auffindbar (die Liste zeigt sie ueber den Statusfilter).
  return firstMatches(db.prepare(`
      SELECT i.id, i.name AS title, i.brand, i.model, i.status, i.notes
      FROM inventory_items i
      ORDER BY CASE i.status WHEN 'active' THEN 0 ELSE 1 END, i.name COLLATE NOCASE ASC
    `).all() as SearchRow[], matches, (i) => [i.title, i.brand, i.model, i.notes], limit)
    .map((i) => withExcerpt(pick(i, ['id', 'title', 'brand', 'model', 'status']), q, [i.brand, i.model, i.notes]));
}
