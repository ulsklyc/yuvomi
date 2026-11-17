/**
 * Module: the shared text side of the mixed search (phase 2, section D)
 * Purpose: what every search slice and the orchestration in services/search.js
 *          share: the cap per hit type, the folding of search text, the words of a
 *          query, the excerpt of a hit outside its title, and the first matches of
 *          a table hit type. Its own file so the slices (services/<module>-slices.ts)
 *          and services/search.js, which calls them, import it without a cycle;
 *          services/search.js re-exports every name it used to export.
 *
 * THE SEARCH CONTRACT. `<module>SearchSlice(db, actor, query, options?)` is
 * synchronous and answers the rows of its hit type, at most SEARCH_LIMIT. The
 * search knows the viewer only by id (`actor.userId`, a SearchActor): it has no
 * wall reader and no display branch, so the actor carries nothing else a slice
 * could read a rule from.
 *
 * Dependencies: none. Erasable TS syntax only.
 */

export const SEARCH_LIMIT = 5;

/** The viewer of a search: only its id, bound where the old query bound `userId`. */
export type SearchActor = Readonly<{ userId: unknown }>;

/** The query of a hit type with an FTS index: the input and its MATCH expression. */
export type IndexSearchQuery = Readonly<{ text: string; match: string }>;

/** Does the input match these fields? Every word must stand somewhere (AND). */
export type SearchMatcher = (...fields: unknown[]) => boolean;

/** The query of a hit type without an FTS index: the input and its matcher. */
export type TableSearchQuery = Readonly<{ text: string; matches: SearchMatcher }>;

export type SearchRow = Record<string, unknown>;

/**
 * Die Faltung, die der FTS-Tokenizer (unicode61 remove_diacritics 2) an jedem
 * Wort vornimmt, fuer JS nachgebaut: klein, ohne Akzente. Das Eszett bleibt -
 * der Tokenizer faltet es auch nicht (siehe eszettVariants).
 */
export function foldLikeIndex(text: unknown): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Dieselbe Faltung plus ß->ss: der Vergleichsschluessel fuer Trefferarten ohne
 * FTS-Index (runTableSearch). Beide Seiten laufen hindurch, deshalb findet
 * "strasse" die "Straße" und "muller" den "Müller" wie im Index.
 */
export function foldSearchText(text: unknown): string {
  return foldLikeIndex(text).replace(/ß/g, 'ss');
}

/** Die Woerter der Eingabe, wie buildMatchQuery sie sieht - ohne Satzzeichen. */
export function queryTokens(q: unknown): string[] {
  return String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
    .filter(Boolean);
}

/* AUSSCHNITT FUER TREFFER AUSSERHALB DES TITELS (Re-Critique 2026-09-28, A1
 * P2-2). "sch" fand "Klavier ueben" ohne jeden Grund im Bild: das Wort stand in
 * der Beschreibung, und die Palette zeigte nur Titel und Datum. Steht die
 * Eingabe nicht vollstaendig im Titel, bekommt der Treffer `excerpt` - ein
 * Stueck des ersten Felds, das ein Suchwort enthaelt, um die Fundstelle herum.
 * Nur Felder, die der Betrachter auf der Zielseite ohnehin sieht; die Zeilen
 * sind zu diesem Zeitpunkt schon durch ihre Sichtbarkeitsfilter gelaufen. */
const EXCERPT_RADIUS = 36;

/** Faltung je Zeichen samt Rueckweg: folded[i] stammt aus original[map[i]]. */
function foldWithMap(text: unknown): { folded: string; map: number[] } {
  const chars = [...String(text ?? '')];
  let folded = '';
  const map: number[] = [];
  let offset = 0;
  for (const ch of chars) {
    const f = foldSearchText(ch);
    for (let i = 0; i < f.length; i += 1) map.push(offset);
    folded += f;
    offset += ch.length;
  }
  map.push(offset);
  return { folded, map };
}

/**
 * @param q        die Eingabe
 * @param title    was die Palette als Titel zeigt
 * @param texts    weitere sichtbare Felder, in Vorrang
 */
export function searchExcerpt(q: unknown, title: unknown, texts: readonly unknown[]): string | null {
  const tokens = queryTokens(q).map(foldSearchText).filter(Boolean);
  if (!tokens.length) return null;
  const inTitle = foldSearchText(title);
  const missing = tokens.filter((tok) => !inTitle.includes(tok));
  if (!missing.length) return null;
  for (const raw of texts) {
    if (raw == null || raw === '') continue;
    const text = String(raw).replace(/\s+/g, ' ').trim();
    const { folded, map } = foldWithMap(text);
    const at = missing.map((tok) => ({ i: folded.indexOf(tok), len: tok.length })).filter((m) => m.i >= 0)
      .sort((a, b) => a.i - b.i)[0];
    if (!at) continue;
    const from = map[at.i];
    const to = map[at.i + at.len];
    let start = Math.max(0, from - EXCERPT_RADIUS);
    let end = Math.min(text.length, to + EXCERPT_RADIUS);
    // An Wortgrenzen schneiden, nicht mitten im Wort.
    if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < from) start = sp + 1; }
    if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > to) end = sp; }
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  }
  return null;
}

/** Zeile mit Ausschnitt (falls einer faellt), ohne interne Hilfsfelder (`_body`). */
export function withExcerpt(row: SearchRow, q: unknown, texts: readonly unknown[]): SearchRow {
  const { _body, ...rest } = row;
  const excerpt = searchExcerpt(q, rest.title, texts);
  return excerpt ? { ...rest, excerpt } : rest;
}

/** Die ersten `limit` Zeilen, deren Felder passen - Reihenfolge aus dem SQL. */
export function firstMatches<T>(rows: readonly T[], matches: SearchMatcher, fieldsOf: (row: T) => unknown[], limit: number): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (matches(...fieldsOf(row))) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export const pick = (row: SearchRow, keys: readonly string[]): SearchRow => Object.fromEntries(keys.map((k) => [k, row[k]]));
