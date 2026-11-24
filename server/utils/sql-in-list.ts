/**
 * Module: a list of values as ONE SQLite parameter (Refs #2810, follow-up 5a)
 * Purpose: `x IN (?, ?, ...)` with one placeholder per value breaks at SQLite's host
 *          parameter limit (SQLITE_MAX_VARIABLE_NUMBER, 32766 since 3.32.0) with
 *          "too many SQL variables", and every list length is a new statement text.
 *          Here the list goes in as one JSON array and SQLite unpacks it with json_each
 *          (JSON1 core, always built in since 3.38):
 *
 *            const list = sqlInList(ids);
 *            db.prepare(`SELECT * FROM tasks WHERE id IN (${list.sql})`).all(list.param);
 *
 *          One statement, one parameter, the same text for every length. How long a list
 *          may be is the schema's decision (maxItems), not the driver's.
 * Affinity: json_each hands a JSON number out as INTEGER or REAL and a JSON string as
 *          TEXT. Measured against one bound parameter per value (test:sql-in-list): the same
 *          rows for numbers and numeric strings against an INTEGER column and for strings
 *          against a TEXT column; a number against a TEXT column finds its text form in
 *          neither form. A TEXT column takes strings.
 * Empty:   an empty list is `[]`; `x IN (SELECT value FROM json_each('[]'))` is false, the
 *          same as SQLite's `x IN ()`. NOT IN on it is true.
 * Named:   `sqlInList(values, 'folders')` gives `json_each(@folders)` for statements that
 *          bind by name; the caller passes `{ folders: list.param }`.
 */

type InListValue = number | bigint | string | null;

export interface SqlInList {
  /** The subquery for the right-hand side of IN, without parentheses around it. */
  sql: string;
  /** The JSON array to bind to the one parameter in `sql`. */
  param: string;
}

function jsonValue(value: InListValue): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`sqlInList: ${value} is no SQL value`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  throw new TypeError(`sqlInList: a ${typeof value} is no SQL value`);
}

export function sqlInList(values: Iterable<InListValue>, name?: string): SqlInList {
  if (name !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`sqlInList: ${name} is no parameter name`);
  }
  const param = `[${Array.from(values, jsonValue).join(',')}]`;
  return { sql: `SELECT value FROM json_each(${name === undefined ? '?' : `@${name}`})`, param };
}
