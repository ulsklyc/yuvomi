/**
 * Module: readiness of this instance
 * Purpose: one answer to "can this instance serve right now?" for `GET /readyz`
 *          (Phase 1b section F, decision E11). `/health` says the process
 *          answers and stays 200 during a restore; readiness says no then.
 *
 *          The process only listens after the database is open and migrated,
 *          and it exits on a wrong key or a newer schema. "Not ready" with a
 *          running process therefore means one of four things, checked in this
 *          order (the first one that holds is the reason):
 *
 *            restore_in_progress    a restore is running
 *            database_closed        no connection (what a failed restore leaves)
 *            schema_behind          the highest applied migration is below the
 *                                   one this build knows
 *            data_dir_not_writable  the directory of the database file refuses
 *                                   writes (SQLite needs it for -wal and -shm)
 *
 *          Nothing here writes to the database: a prober asks every few
 *          seconds. The result carries the reason only - no version, no path,
 *          no timestamp - because the endpoint is unauthenticated.
 * Dependencies: server/db.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db.js';

const LATEST_KNOWN_VERSION = Math.max(0, ...db.MIGRATIONS.map((m) => m.version));

/**
 * The closed set of reasons; the OpenAPI schema `NotReadyResponse` lists the same four.
 * @typedef {'restore_in_progress' | 'database_closed' | 'schema_behind' | 'data_dir_not_writable'} NotReadyReason
 */

/**
 * The result is the body of the answer; every reason is written out where it is decided.
 * @returns {Promise<{ status: 'ready' } | { status: 'not_ready', reason: NotReadyReason }>}
 */
async function checkReadiness() {
  if (db.isRestoreRunning()) return { status: 'not_ready', reason: 'restore_in_progress' };
  if (!db.isDatabaseOpen()) return { status: 'not_ready', reason: 'database_closed' };
  if (db.currentVersion() < LATEST_KNOWN_VERSION) return { status: 'not_ready', reason: 'schema_behind' };
  const dbPath = db.getPath();
  if (dbPath !== ':memory:') {
    try {
      await fs.access(path.dirname(path.resolve(dbPath)), fs.constants.W_OK);
    } catch {
      return { status: 'not_ready', reason: 'data_dir_not_writable' };
    }
    // The only await is behind us: a restore may have begun meanwhile.
    if (db.isRestoreRunning()) return { status: 'not_ready', reason: 'restore_in_progress' };
  }
  return { status: 'ready' };
}

/**
 * `GET /readyz`: 200 `{ status: 'ready' }` or 503 `{ status: 'not_ready', reason }`.
 * A schema read that fails (`currentVersion()` answers 0 then) counts as
 * `schema_behind`: the instance cannot serve, and the cause is in the log of
 * whatever request hit the database next.
 * @param {unknown} _req
 * @param {{ setHeader(name: string, value: string): unknown, status(code: number): { json(body: unknown): unknown }, json(body: unknown): unknown }} res
 */
export async function readinessHandler(_req, res) {
  const state = await checkReadiness();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(state.status === 'ready' ? 200 : 503).json(state);
}
