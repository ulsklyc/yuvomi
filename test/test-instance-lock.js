/**
 * Test-Suite: Instanzsperre - der CLI-Restore verweigert neben einem laufenden
 * Server (#1530).
 *
 * `scripts/restore-backup.js` tauschte die Datenbank aus, ohne zu wissen, ob ein
 * Server auf ihr arbeitet: die Datei wechselte unter dessen offener Verbindung,
 * und der Server schrieb in die alte weiter. Server und CLI halten jetzt eine
 * vom Betriebssystem gehaltene Sperre auf `<DB_PATH>.lock`
 * (server/utils/instance-lock.js).
 *
 * Gemessen an echten Prozessen:
 *   - Dieser Prozess ist ein Server (server/index.js als Programm). Das CLI
 *     daneben verweigert, und die Datenbank ist per Hash unveraendert. Nach
 *     dem Restore aus der Einstellungsseite (im selben Prozess) haelt der
 *     Server die Sperre weiter - er sperrt sich weder aus, noch laesst er sie fallen.
 *   - Ein Server als Kindprozess stirbt per SIGKILL: das CLI laeuft danach ohne
 *     Aufraeumen durch, es gibt nichts Veraltetes.
 *   - Ein zweiter Server und ein Server neben einem CLI-Restore warten, statt
 *     zu starten, und starten, sobald der Halter weg ist.
 *   - Kann das Dateisystem die Sperre nicht nehmen (hier: ein Verzeichnis an
 *     ihrer Stelle), blockiert nichts - Warnung, Verhalten wie vor #1530.
 *   - Der Server meldet sich beim Warten wiederholt (im Test mit kurzer Frist).
 *
 * Lauf: npm run test:instance-lock
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './server-ready.js';
import { tempDir } from './tmp-dir.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESTORE_CLI = join(ROOT, 'scripts', 'restore-backup.js');
const SERVER = join(ROOT, 'server', 'index.js');
const DB_MODULE = new URL('../server/db.js', import.meta.url).href;
const SECRET = 'test-instance-lock-secret-min-32-chars-long';

const { dbPath: SERVER_DB } = await startTestServer({
  name: 'instance-lock',
  env: { SESSION_SECRET: SECRET },
});
const dbmod = await import('../server/db.js');

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function childEnv(dbPath) {
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    SESSION_SECRET: SECRET,
    SESSION_SECURE: 'false',
    PORT: '0',
    BIND_ADDRESS: '127.0.0.1',
    BACKUP_ENABLED: 'false',
  };
  delete env.DB_ENCRYPTION_KEY;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runCli(dbPath, backupPath) {
  const run = spawnSync(process.execPath, [RESTORE_CLI, backupPath], {
    cwd: ROOT, env: childEnv(dbPath), encoding: 'utf8', timeout: 60_000,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/**
 * Einen Kindprozess starten und seine Ausgabe mitlesen. `waitFor(re)` wartet,
 * bis sie passt; `stop(signal)` beendet ihn und wartet auf sein Ende.
 */
/**
 * Jeder Kindprozess, der noch lebt, haelt den Testprozess offen - auch nach
 * einer Assertion, die vor seinem `stop()` scheitert. Am Ende alle beenden
 * (gemessen: ohne das hing die Suite gegen den Stand vor #1530).
 */
const children = new Set();
after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function startChild(args, dbPath) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv(dbPath) });
  children.add(child);
  let output = '';
  const listeners = new Set();
  const onData = (chunk) => {
    output += chunk;
    for (const fn of listeners) fn();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    get output() { return output; },
    waitFor(re, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (re.test(output)) { cleanup(); resolve(); }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`${re} kam nicht innerhalb von ${timeoutMs} ms. Ausgabe:\n${output}`));
        }, timeoutMs);
        exited.then(({ code, signal }) => {
          if (re.test(output)) return;
          cleanup();
          reject(new Error(`Prozess endete (code ${code}, signal ${signal}) vor ${re}. Ausgabe:\n${output}`));
        });
        function cleanup() { clearTimeout(timer); listeners.delete(check); }
        listeners.add(check);
        check();
      });
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
  };
}

const SERVER_RUNNING = /Server running on port/;
const WAITING = /Waiting for .*\.lock/;

function startServerChild(dbPath) {
  return startChild([SERVER], dbPath);
}

/**
 * Ein Prozess, der die Sperre haelt wie ein laufender CLI-Restore: derselbe
 * Handschlag (`'refuse'`), dann haelt er still, bis er beendet wird.
 */
function startCliLikeHolder(dbPath, { lifetimeMs = 0 } = {}) {
  const code = `
    globalThis[Symbol.for('yuvomi.db.instanceLock')] = 'refuse';
    await import(${JSON.stringify(DB_MODULE)});
    console.log('HOLDING');
    // Mit Lebensdauer endet er von selbst, sonst haelt er, bis er beendet wird.
    // Kein process.exit hier: test:suite-exit-code sucht den Aufruf im Text.
    setTimeout(() => {}, ${lifetimeMs} > 0 ? ${lifetimeMs} : 2 ** 31 - 1);
  `;
  return startChild(['--input-type=module', '-e', code], dbPath);
}

/** Frische Datenbank samt Backup in einem eigenen Verzeichnis. */
async function freshDatabaseWithBackup() {
  const dir = tempDir('yuvomi-test-instance-lock-');
  const dbPath = join(dir, 'yuvomi.db');
  const backupPath = join(dir, 'backup.db');
  const code = `
    const db = await import(${JSON.stringify(DB_MODULE)});
    await db.backupToFile(${JSON.stringify(backupPath)});
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: childEnv(dbPath), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(run.status, 0, `Vorbedingung: Backup ${run.stdout}${run.stderr}`);
  return { dir, dbPath, backupPath };
}

test('#1530 das CLI verweigert neben einem laufenden Server und laesst die Datenbank unveraendert', async () => {
  const backupPath = join(tempDir('yuvomi-test-instance-lock-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  dbmod.get().pragma('wal_checkpoint(TRUNCATE)');
  const before = sha(SERVER_DB);

  const run = runCli(SERVER_DB, backupPath);

  assert.equal(run.status, 1, `das CLI lief neben dem Server durch:\n${run.output}`);
  assert.match(run.output, /Restore refused: A Yuvomi server is using/);
  assert.match(run.output, /Stop Yuvomi first/);
  assert.equal(sha(SERVER_DB), before, 'die Datenbank wurde angefasst');
  assert.deepEqual(
    readdirSync(join(SERVER_DB, '..')).filter((n) => n.startsWith(`${SERVER_DB.split('/').pop()}.restore-tmp`)),
    [], 'keine Arbeitsdatei des CLI');
});

test('#1530 der Restore aus der Einstellungsseite sperrt sich nicht aus und behaelt die Sperre', async () => {
  const backupPath = join(tempDir('yuvomi-test-instance-lock-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const result = await dbmod.restoreFromFile(backupPath);
  assert.ok(result.schemaVersion > 0, 'der Restore im Server-Prozess laeuft');
  assert.equal(dbmod.get().prepare('SELECT 1 AS one').get().one, 1, 'Verbindung danach offen');

  // Danach haelt der Server die Sperre weiter: das CLI verweigert noch immer.
  const run = runCli(SERVER_DB, backupPath);
  assert.equal(run.status, 1, `nach dem Server-Restore lief das CLI durch:\n${run.output}`);
  assert.match(run.output, /Restore refused/);
});

test('#1530 nach SIGKILL des Servers laeuft das CLI ohne Aufraeumen durch', async () => {
  const { dbPath, backupPath } = await freshDatabaseWithBackup();
  const server = startServerChild(dbPath);
  try {
    await server.waitFor(SERVER_RUNNING);
    const refused = runCli(dbPath, backupPath);
    assert.equal(refused.status, 1, `Vorbedingung: neben dem Server verweigert:\n${refused.output}`);
  } finally {
    await server.stop('SIGKILL');
  }
  assert.ok(existsSync(`${dbPath}.lock`), 'die Sperrdatei bleibt liegen - sie ist harmlos');

  const run = runCli(dbPath, backupPath);
  assert.equal(run.status, 0, `nach SIGKILL verweigert:\n${run.output}`);
  assert.match(run.output, /Restored /);
  assert.equal(existsSync(`${dbPath}.lock-journal`), false, 'kein Journal neben der Sperrdatei');
});

test('#1530 ein zweiter Server wartet und startet, sobald der erste weg ist', async () => {
  const { dbPath } = await freshDatabaseWithBackup();
  const first = startServerChild(dbPath);
  await first.waitFor(SERVER_RUNNING);
  const second = startServerChild(dbPath);
  try {
    await second.waitFor(WAITING);
    // Er wartet wirklich: eine Weile spaeter laeuft er noch nicht.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.doesNotMatch(second.output, SERVER_RUNNING, 'der zweite Server startete trotz Sperre');
    assert.equal(second.child.exitCode, null, `der zweite Server brach ab statt zu warten:\n${second.output}`);

    await first.stop('SIGKILL');
    await second.waitFor(SERVER_RUNNING);
    assert.match(second.output, /is free again - starting/);
  } finally {
    await first.stop('SIGKILL');
    await second.stop('SIGKILL');
  }
});

test('#1530 ein Server wartet, solange ein CLI-Restore die Sperre haelt', async () => {
  const { dbPath } = await freshDatabaseWithBackup();
  const holder = startCliLikeHolder(dbPath);
  await holder.waitFor(/HOLDING/);
  const server = startServerChild(dbPath);
  try {
    await server.waitFor(WAITING);
    assert.match(server.output, /usually a restore from the command line/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.doesNotMatch(server.output, SERVER_RUNNING, 'der Server startete waehrend des CLI-Restores');
    await holder.stop('SIGTERM');
    await server.waitFor(SERVER_RUNNING);
  } finally {
    await holder.stop('SIGKILL');
    await server.stop('SIGKILL');
  }
});

test('#1530 laesst das Dateisystem keine Sperre zu, blockiert nichts', async () => {
  const { dbPath, backupPath } = await freshDatabaseWithBackup();
  // Ein Verzeichnis an der Stelle der Sperrdatei: SQLite kann sie nicht
  // oeffnen (kein BUSY) - wie ein Mount, der keine Locks kann.
  mkdirSync(`${dbPath}.lock`);

  const server = startServerChild(dbPath);
  try {
    await server.waitFor(SERVER_RUNNING);
    assert.match(server.output, /Could not lock .*\.lock/);
  } finally {
    await server.stop('SIGKILL');
  }

  const run = runCli(dbPath, backupPath);
  assert.equal(run.status, 0, `das CLI brach ohne Sperre ab:\n${run.output}`);
  assert.match(run.output, /Could not lock/);
});

test('#1530 der wartende Server meldet sich wiederholt', async () => {
  // Eine eigene Modulinstanz: die gewoehnliche haelt schon die Sperre des
  // Servers dieser Suite (`held` ist modulweit) und kaeme sofort zurueck.
  const { acquireInstanceLock, instanceLockPath } = await import('../server/utils/instance-lock.js?waiting-log');
  const dbPath = join(tempDir('yuvomi-test-instance-lock-'), 'yuvomi.db');
  // Der Halter endet von selbst nach gut einer Sekunde - das Warten ist
  // synchron, ein Timer in diesem Prozess kaeme nicht dran. Bis dahin laufen
  // bei 300 ms Frist mehrere Warteversuche, jeder mit eigener Zeile.
  const holder = startCliLikeHolder(dbPath, { lifetimeMs: 1500 });
  await holder.waitFor(/HOLDING/);
  const lines = [];
  const log = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
  const lock = acquireInstanceLock(dbPath, { onBusy: 'wait', log, waitLogIntervalMs: 300 });
  try {
    assert.equal(lock?.path, instanceLockPath(dbPath));
    lock.release();
    const waits = lines.filter((l) => l.startsWith('warn Waiting for'));
    assert.ok(waits.length >= 3, `erwartet mehrere Wartezeilen, bekam:\n${lines.join('\n')}`);
    assert.match(lines.at(-1), /is free again - starting/);
  } finally {
    await holder.stop('SIGKILL');
  }
});
