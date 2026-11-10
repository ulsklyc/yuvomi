/**
 * Fingerprint of a Yuvomi database file, shared by the restore drill
 * (scripts/restore-drill.mjs) and the rollback probe (this folder).
 *
 * Opens the file directly with the production driver, never through
 * server/db.js: that module opens and migrates DB_PATH on import, and a
 * fingerprint must not change what it measures.
 *
 * A fingerprint holds the schema version (highest row in schema_migrations),
 * a hash over the schema SQL, and per table its row count plus a hash over its
 * sorted rows. Two fingerprints compare with diffFingerprints().
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
// The driver only through its gate (Node-API check first; test:node-runtime).
import Database from '../../server/utils/sqlite-driver.js';

/**
 * @typedef {{ n: number, h: string } | { err: string }} TablePrint
 * @typedef {{
 *   journal: string, migrations: number, schema_version: number,
 *   schema_hash: string, tables: Record<string, TablePrint>
 * }} Fingerprint
 * @typedef {any} Connection a better-sqlite3-multiple-ciphers database
 */

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');

/**
 * Opens `file` with `key` the way server/db.js sets it (SQLCipher, key bytes as
 * hex). A file with a plain SQLite header opens without a key.
 * @param {string} file
 * @param {string | null} key
 * @param {{ readonly?: boolean }} [options]
 */
export function openDatabase(file, key, { readonly = false } = {}) {
  const db = new Database(file, { readonly, fileMustExist: true });
  if (key && !hasPlainHeader(file)) {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key="x'${Buffer.from(key, 'utf8').toString('hex')}'"`);
  }
  return db;
}

/** @param {string} file */
function hasPlainHeader(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, head, 0, head.length, 0);
    return head.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

/**
 * Hash over the schema SQL, in a fixed order. `sqlite_stat*` tables are left
 * out: `PRAGMA optimize` creates them on a database that has seen queries, and
 * a freshly migrated one has none, although the two schemas are the same.
 * @param {Connection} db
 */
export function schemaHash(db) {
  const rows = /** @type {{ sql: string }[]} */ (db.prepare(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_stat%' ORDER BY type, name"
  ).all());
  return createHash('sha256').update(rows.map((r) => r.sql).join('\n')).digest('hex').slice(0, 16);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function plain(value) {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'bigint') return String(value);
  return value;
}

/**
 * @param {Connection} db
 * @returns {Fingerprint}
 */
export function fingerprintOf(db) {
  const mig = /** @type {{ n: number, v: number | null }} */ (
    db.prepare('SELECT COUNT(*) AS n, MAX(version) AS v FROM schema_migrations').get()
  );
  /** @type {Record<string, TablePrint>} */
  const tables = {};
  const names = /** @type {{ name: string }[]} */ (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all());
  for (const { name } of names) {
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    } catch (err) {
      tables[name] = { err: String(/** @type {Error} */ (err).message).slice(0, 80) };
      continue;
    }
    const lines = rows.map((/** @type {unknown} */ row) => JSON.stringify(row, (_k, v) => plain(v))).sort();
    tables[name] = { n: rows.length, h: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12) };
  }
  return {
    journal: String(db.pragma('journal_mode', { simple: true })),
    migrations: mig.n,
    schema_version: mig.v ?? 0,
    schema_hash: schemaHash(db),
    tables,
  };
}

/**
 * Fingerprint of a file; the connection is closed again.
 * @param {string} file
 * @param {string | null} key
 */
export function fingerprintFile(file, key) {
  const db = openDatabase(file, key);
  try {
    return fingerprintOf(db);
  } finally {
    db.close();
  }
}

/**
 * What differs between two fingerprints, one line per finding; empty when the
 * two are the same.
 * @param {Fingerprint} a
 * @param {Fingerprint} b
 * @returns {string[]}
 */
export function diffFingerprints(a, b) {
  const diffs = [];
  for (const k of /** @type {const} */ (['schema_version', 'migrations', 'schema_hash'])) {
    if (a[k] !== b[k]) diffs.push(`${k}: ${a[k]} -> ${b[k]}`);
  }
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (!x || !y) diffs.push(`${t}: ${x ? 'only before' : 'only after'}`);
    else if ('err' in x || 'err' in y) diffs.push(`${t}: unreadable`);
    else if (x.n !== y.n || x.h !== y.h) diffs.push(`${t}: ${x.n} -> ${y.n} rows${x.n === y.n ? ' (content differs)' : ''}`);
  }
  return diffs;
}

/**
 * Tables whose row count went down (or that are gone) from `before` to `after`.
 * @param {Fingerprint} before
 * @param {Fingerprint} after
 * @returns {string[]}
 */
export function lostRows(before, after) {
  const lost = [];
  for (const [name, x] of Object.entries(before.tables)) {
    if ('err' in x) continue;
    const y = after.tables[name];
    if (!y) lost.push(`${name}: table missing`);
    else if ('err' in y) lost.push(`${name}: unreadable (${y.err})`);
    else if (y.n < x.n) lost.push(`${name}: ${x.n} -> ${y.n} rows`);
  }
  return lost;
}
