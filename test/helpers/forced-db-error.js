/**
 * Module: forced database errors for route suites
 * Purpose: a route suite breaks the real SQLite database under a route and
 *          checks what the client and the log get (Phase 1b section E, the
 *          pilot of the central error handler). No fake of the route or of
 *          the driver: a table is renamed away, so every statement on it
 *          fails with SQLite's "no such table", or a trigger aborts one kind
 *          of write.
 *
 *          The answer has to be the same whether the route answers its own
 *          500 or leaves the error to server/middleware/error-handler.js:
 *          status 500, the fixed sentence, nothing of SQLite in the body, and
 *          exactly one error line in the log that carries the raw text. An
 *          error line can come from two places, and both are read: the
 *          recording log handed to the error handler, and `console.error`,
 *          where a route's own logger writes outside production.
 *
 *          The suite mounts the real handler behind its router, as
 *          server/index.js does: `app.use(createErrorHandler(log))`.
 */

import assert from 'node:assert/strict';

export const FIXED_500 = Object.freeze({ error: 'Internal server error.', code: 500 });

/** The text a refused write carries; it says neither "Unknown" nor "Invalid". */
export const REFUSED_WRITE_TEXT = 'forced write failure';

/** @typedef {{ exec: (sql: string) => unknown }} Db */
/** @typedef {{ lines: string[], warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} RecordingLog */
/** @typedef {{ status: number, text: string, body: any, errorLines: string[] }} Answer */

/**
 * One log call as one string. A route logger hands the error on as a plain
 * object (name, message, stack), the error handler as the Error itself.
 * @param {unknown[]} args
 */
function asLine(args) {
  return args.map((arg) => {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
  }).join(' ');
}

/**
 * A log for `createErrorHandler` that keeps every line.
 * @returns {RecordingLog}
 */
export function recordingLog() {
  /** @type {string[]} */
  const lines = [];
  return {
    lines,
    warn: (...args) => { lines.push(`warn ${asLine(args)}`); },
    error: (...args) => { lines.push(`error ${asLine(args)}`); },
  };
}

/**
 * Runs `run` while `table` is renamed away: a read or a write on it fails
 * with "no such table: <table>". The name comes back afterwards, also when
 * `run` throws.
 * @template T
 * @param {Db} db
 * @param {string} table
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTableGone(db, table, run) {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
  try {
    return await run();
  } finally {
    db.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
  }
}

/**
 * Runs `run` while a trigger aborts every `event` on `table` with
 * REFUSED_WRITE_TEXT; `when` narrows it to some rows (`NEW.id = 7`). The
 * statements before the refused one have already run, so this is the way to
 * see a transaction roll back.
 * @template T
 * @param {Db} db
 * @param {string} table
 * @param {'INSERT' | 'UPDATE' | 'DELETE'} event
 * @param {() => Promise<T>} run
 * @param {string} [when]
 * @returns {Promise<T>}
 */
export async function withWriteRefused(db, table, event, run, when) {
  const trigger = `forced_${event.toLowerCase()}_failure_on_${table}`;
  db.exec(`CREATE TRIGGER ${trigger} BEFORE ${event} ON ${table}${when ? ` WHEN ${when}` : ''}
    BEGIN SELECT RAISE(ABORT, '${REFUSED_WRITE_TEXT}'); END`);
  try {
    return await run();
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

/**
 * One request, with the error lines the process logged while it ran.
 * @param {string} baseUrl
 * @param {RecordingLog} log the log the suite gave to `createErrorHandler`
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body] sent as JSON
 * @returns {Promise<Answer>}
 */
export async function requestLogged(baseUrl, log, method, path, body) {
  const seen = log.lines.length;
  /** @type {string[]} */
  const consoleLines = [];
  const original = console.error;
  console.error = (...args) => { consoleLines.push(`error ${asLine(args)}`); };
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON: Express' own error page */ }
    const handlerLines = log.lines.slice(seen).filter((line) => line.startsWith('error '));
    return { status: res.status, text, body: parsed, errorLines: [...consoleLines, ...handlerLines] };
  } finally {
    console.error = original;
  }
}

/**
 * The answer to a database error: a 500 with the fixed sentence, no SQLite
 * text in the body, and one error line in the log that names the cause.
 * @param {Answer} answer
 * @param {string} rawText what SQLite said, e.g. `no such table: users`
 * @param {string} label the route, for the failure message
 */
export function assertFixed500(answer, rawText, label) {
  assert.equal(answer.status, 500, `${label}: status, body ${answer.text.slice(0, 200)}`);
  assert.deepEqual(answer.body, FIXED_500, `${label}: the body is the fixed sentence, got ${answer.text.slice(0, 200)}`);
  assert.ok(
    !answer.text.includes(rawText) && !/SQLITE|no such table/i.test(answer.text),
    `${label}: no SQLite text in the body, got ${answer.text.slice(0, 200)}`,
  );
  assert.equal(answer.errorLines.length, 1, `${label}: one error line in the log, got ${JSON.stringify(answer.errorLines)}`);
  assert.ok(String(answer.errorLines[0]).includes(rawText), `${label}: the log keeps the raw text, got ${answer.errorLines[0]}`);
}
