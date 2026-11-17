/**
 * Module: contacts - the contact hits of the global search as one search slice
 *         (phase 2, section D)
 * Purpose: contactsSearchSlice(db, actor, query) answers the `contacts` bucket of
 *          services/search.js runSearch. Contacts are household property: no row
 *          rule, every member finds every contact (#471); only the module rights
 *          and the household switch decide, and the orchestration in
 *          services/search.js checks those before it calls the slice.
 *
 * THE SQL IS THE SEARCH'S, WORD FOR WORD.
 *
 * Dependencies: services/search-text.ts. Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import type { IndexSearchQuery, SearchActor, SearchRow } from './search-text.ts';
import { SEARCH_LIMIT, withExcerpt } from './search-text.ts';

/** The contact hits of the global search; the actor is unused (household property). */
export function contactsSearchSlice(db: Database, _actor: SearchActor, query: IndexSearchQuery): SearchRow[] {
  const { text: q, match } = query;
  const limit = SEARCH_LIMIT;
  return (db.prepare(`
    SELECT c.id, c.name AS title, s.body AS _body
    FROM search_index s
    JOIN contacts c ON c.id = s.entity_id
    WHERE s.entity = 'contact' AND s.search_index MATCH @match
    ORDER BY c.name ASC
    LIMIT @limit
  `).all({ match, limit }) as SearchRow[]).map((row) => withExcerpt(row, q, [row._body]));
}
