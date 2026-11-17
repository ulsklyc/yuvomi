/**
 * Module: recipes - the recipe hits of the global search as one search slice
 *         (phase 2, section D)
 * Purpose: recipesSearchSlice(db, actor, query) answers the `recipes` bucket of
 *          services/search.js runTableSearch (rights module `meals`, nav entry
 *          `recipes`). No FTS index: the rows come in the SQL order and the first
 *          SEARCH_LIMIT that match stay. Household property: no row rule, the
 *          actor is unused; module rights and the household switch are checked by
 *          the orchestration before the call.
 *
 * ITS OWN FILE, NOT meals-slices.ts: that one reaches server/db.js through
 * services/meal-cook.js, and services/search.js must not - suites load it without
 * DB_PATH (test:db-isolation). Named after the nav entry, as birthdays-slices.ts is.
 *
 * THE SQL IS THE SEARCH'S, WORD FOR WORD.
 *
 * Dependencies: services/search-text.ts. Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import type { SearchActor, SearchRow, TableSearchQuery } from './search-text.ts';
import { SEARCH_LIMIT, firstMatches, pick, withExcerpt } from './search-text.ts';

/** The recipe hits of the global search. */
export function recipesSearchSlice(db: Database, _actor: SearchActor, query: TableSearchQuery): SearchRow[] {
  const { text: q, matches } = query;
  const limit = SEARCH_LIMIT;
  // Rezepte: Haushaltsbesitz wie die Liste (GET /recipes filtert nicht),
  // gespiegelte Mealie/Tandoor-Rezepte eingeschlossen.
  return firstMatches(db.prepare(`
      SELECT r.id, r.title, r.notes FROM recipes r
      ORDER BY r.title COLLATE NOCASE ASC, r.id DESC
    `).all() as SearchRow[], matches, (r) => [r.title, r.notes], limit)
    .map((r) => withExcerpt(pick(r, ['id', 'title']), q, [r.notes]));
}
