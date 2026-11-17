/**
 * Module: pantry - the pantry hits of the global search as one search slice
 *         (phase 2, section D)
 * Purpose: pantrySearchSlice(db, actor, query) answers the `pantry` bucket of
 *          services/search.js runTableSearch. No FTS index: the rows come in the
 *          SQL order and the first SEARCH_LIMIT that match stay. Household
 *          property: no row rule, the actor is unused; module rights and the
 *          household switch are checked by the orchestration before the call.
 *          (The pantry block of GET /dashboard lives in services/pantry-expiring.js.)
 *
 * THE SQL IS THE SEARCH'S, WORD FOR WORD.
 *
 * Dependencies: services/search-text.ts. Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import type { SearchActor, SearchRow, TableSearchQuery } from './search-text.ts';
import { SEARCH_LIMIT, firstMatches, pick, withExcerpt } from './search-text.ts';

/** The pantry hits of the global search. */
export function pantrySearchSlice(db: Database, _actor: SearchActor, query: TableSearchQuery): SearchRow[] {
  const { text: q, matches } = query;
  const limit = SEARCH_LIMIT;
  return firstMatches(db.prepare(`
      SELECT p.id, p.name AS title, p.quantity, p.unit, p.expires_on, p.notes
      FROM pantry_items p
      ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `).all() as SearchRow[], matches, (p) => [p.title, p.notes], limit)
    .map((p) => withExcerpt(pick(p, ['id', 'title', 'quantity', 'unit', 'expires_on']), q, [p.notes]));
}
