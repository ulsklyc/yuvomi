/**
 * Module: documents - the document hits of the global search as one search slice
 *         (phase 2, section D)
 * Purpose: documentsSearchSlice(db, actor, query) answers the `documents` bucket
 *          of services/search.js runTableSearch. No FTS index: the rows come in
 *          the SQL order and the first SEARCH_LIMIT that match stay. The row rule
 *          comes from authorize (visibleWhere for documents, bound to
 *          `actor.userId` as `@userId`, as before).
 *
 * THE SQL IS THE SEARCH'S, WORD FOR WORD.
 *
 * Dependencies: server/authorize/index.ts (row rule), services/search-text.ts.
 * Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import { visibleWhere } from '../authorize/index.ts';
import type { SearchActor, SearchRow, TableSearchQuery } from './search-text.ts';
import { SEARCH_LIMIT, firstMatches, pick, withExcerpt } from './search-text.ts';

/** The document hits of the global search. */
export function documentsSearchSlice(db: Database, actor: SearchActor, query: TableSearchQuery): SearchRow[] {
  const { text: q, matches } = query;
  const userId = actor.userId;
  const limit = SEARCH_LIMIT;
  // Dokumente: dieselbe Sichtbarkeit wie GET /documents (eigen, Familie oder
  // ausdruecklich freigegeben) und nur der aktive Bestand, den die Liste zeigt.
  return firstMatches(db.prepare(`
      SELECT d.id, d.name AS title, d.description, d.category, d.updated_at
      FROM family_documents d
      WHERE ${visibleWhere('documents', 'd', '@userId')} AND d.status = 'active'
      ORDER BY d.updated_at DESC, d.id DESC
    `).all({ userId }) as SearchRow[], matches, (d) => [d.title, d.description], limit)
    .map((d) => withExcerpt(pick(d, ['id', 'title', 'category']), q, [d.description]));
}
