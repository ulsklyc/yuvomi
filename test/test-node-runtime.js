/**
 * Test-Suite: Laufzeitpruefung vor dem Datenbanktreiber
 *
 * Gemessen am 2026-10-08: package.json versprach `node >=22.0.0`, aber die
 * Prebuilds von better-sqlite3-multiple-ciphers 13.0.3 brauchen Node-API 10.
 * Unter Node 22.12.0 bis 22.13.1 (Node-API 9) starb der Prozess beim ersten
 * `new Database()` mit Segfault (Exit 139) und ohne eine Zeile Ausgabe.
 *
 * Was hier haelt:
 *   - die Pruefung als reine Funktion (server/utils/node-runtime.js);
 *   - die Meldung nennt die Spanne aus package.json `engines.node`, und
 *     package-lock.json spiegelt sie - es gibt keine zweite Zahl im Code;
 *   - ausserhalb von test/ importiert nur server/utils/sqlite-driver.js den
 *     Treiber, also kommt niemand an der Pruefung vorbei;
 *   - als PROGRAMM: server/index.js und scripts/seed-demo.js brechen mit einer
 *     vorgetaeuschten Node-API 9 ab, BEVOR eine Datei neben DB_PATH entsteht.
 *     Die echte alte Laufzeit faehrt die Suite nicht (dort stuerzt der Treiber
 *     ab); der Handlauf mit `npx node@22.12.0` steht im PR.
 *
 * Lauf: npm run test:node-runtime
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';
import { REQUIRED_NAPI, declaredNodeRange, runtimeProblem } from '../server/utils/node-runtime.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

const DRIVER = 'better-sqlite3-multiple-ciphers';
const GATE = 'server/utils/sqlite-driver.js';

// ---------------------------------------------------------------------------
// Reine Funktion
// ---------------------------------------------------------------------------

test('a runtime below the required Node-API gets one line that names what runs, what is needed and what helps', () => {
  const message = runtimeProblem({ node: '22.12.0', napi: '9', range: '>=22.14.0' });
  assert.equal(typeof message, 'string');
  assert.ok(!message.includes('\n'), 'the message is a single line');
  assert.match(message, /Node\.js 22\.12\.0/);
  assert.match(message, /Node-API 9\b/);
  assert.match(message, new RegExp(`Node-API ${REQUIRED_NAPI}\\b`));
  assert.match(message, />=22\.14\.0/);
  assert.match(message, /Update Node\.js/);
});

test('a runtime with the required Node-API or newer passes', () => {
  assert.equal(runtimeProblem({ node: '22.14.0', napi: '10' }), null);
  assert.equal(runtimeProblem({ node: '24.21.0', napi: 10 }), null);
  assert.equal(runtimeProblem({ node: '99.0.0', napi: String(REQUIRED_NAPI + 1) }), null);
});

test('the check hangs on the capability, not on the version number', () => {
  // Node 23.0 bis 23.5 liegen ueber jeder 22er-Grenze und haben Node-API 9.
  assert.match(runtimeProblem({ node: '23.5.0', napi: '9' }), /Node\.js 23\.5\.0/);
  // Und eine Versionsnummer allein rettet nichts.
  assert.equal(typeof runtimeProblem({ node: '22.14.0', napi: '9' }), 'string');
});

test('a runtime that reports no Node-API version is refused, with or without a known range', () => {
  for (const napi of [undefined, null, '', 'abc']) {
    const message = runtimeProblem({ node: '22.0.0', napi });
    assert.equal(typeof message, 'string', `napi=${String(napi)}`);
    assert.ok(!message.includes('\n'));
    assert.ok(!/undefined|null|NaN/.test(message), message);
  }
});

// ---------------------------------------------------------------------------
// Eine Zahl, eine Stelle
// ---------------------------------------------------------------------------

test('the message quotes engines.node from package.json, and package-lock.json mirrors it', () => {
  assert.match(pkg.engines.node, /^>=\d+\.\d+\.\d+$/);
  assert.equal(declaredNodeRange(), pkg.engines.node);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  const message = runtimeProblem({ node: '22.12.0', napi: '9', range: declaredNodeRange() });
  assert.ok(message.includes(pkg.engines.node), message);
});

test('the runtime check carries no Node version of its own', () => {
  for (const file of ['server/utils/node-runtime.js', GATE]) {
    const code = codeLines(readFileSync(join(ROOT, file), 'utf8')).join('\n');
    assert.ok(!/\b\d+\.\d+\.\d+\b/.test(code), `${file} must not spell out a Node version`);
  }
});

test('the runtime this suite runs on passes the check', () => {
  assert.equal(runtimeProblem({ node: process.versions.node, napi: process.versions.napi }), null);
});

// ---------------------------------------------------------------------------
// Niemand kommt an der Pruefung vorbei
// ---------------------------------------------------------------------------

/** Zeilen ohne Kommentarzeilen: JSDoc nennt den Treiber als Typ, das zaehlt nicht. */
function codeLines(source) {
  return source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (entry.isDirectory()) {
      if (rel === 'test' || rel === join('public', 'vendor')) continue;
      sourceFiles(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(rel.split('\\').join('/'));
    }
  }
  return out;
}

function driverImporters() {
  const quoted = new RegExp(`['"\`]${DRIVER}['"\`]`);
  return sourceFiles(ROOT).filter((file) =>
    codeLines(readFileSync(join(ROOT, file), 'utf8')).some((line) => quoted.test(line)));
}

test('outside test/, only the gate module loads the database driver', () => {
  assert.deepEqual(driverImporters(), [GATE]);
});

test('the gate module runs the check in its own body', () => {
  const code = codeLines(readFileSync(join(ROOT, GATE), 'utf8')).join('\n');
  assert.match(code, /^assertSupportedRuntime\(\);$/m);
});

// ---------------------------------------------------------------------------
// Als Programm
// ---------------------------------------------------------------------------

// Ein Preload, der dem Kindprozess eine alte Node-API vortaeuscht. Die echte
// alte Laufzeit kann die Suite nicht fahren: sie laeuft auf der Version, die
// die CI stellt.
const fakeNapi = (value) => 'data:text/javascript,' + encodeURIComponent(
  `Object.defineProperty(process.versions, 'napi', { value: ${JSON.stringify(value)}, enumerable: true, configurable: true });`,
);

function runProgram(args, { napi, dbPath }) {
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-node-runtime-secret-min-32-chars-long',
    SESSION_SECURE: 'false',
    PORT: '0',
    BIND_ADDRESS: '127.0.0.1',
    BACKUP_ENABLED: 'false',
  };
  delete env.DB_ENCRYPTION_KEY;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--import', fakeNapi(napi), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    // Ohne die Pruefung startet server/index.js und laeuft weiter: die Frist
    // macht daraus ein rotes Ergebnis statt einer haengenden Suite.
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

function assertRefused(run, dbPath) {
  assert.equal(run.signal, null, `the process must exit on its own\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.equal(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  const expected = runtimeProblem({ node: process.versions.node, napi: '9', range: pkg.engines.node });
  assert.equal(run.stderr, `${expected}\n`, 'stderr carries exactly the one line');
  assert.equal(existsSync(dbPath), false, 'no database file was created');
  assert.equal(existsSync(`${dbPath}.lock`), false, 'no lock file was created');
}

test('server/index.js refuses an old Node-API before it touches a database file', () => {
  const dbPath = join(tempDir('yuvomi-node-runtime-'), 'server.db');
  assertRefused(runProgram(['server/index.js'], { napi: '9', dbPath }), dbPath);
});

test('scripts/seed-demo.js refuses an old Node-API without going through server/db.js', () => {
  const dbPath = join(tempDir('yuvomi-node-runtime-'), 'seed.db');
  assertRefused(runProgram(['scripts/seed-demo.js', '--db', dbPath], { napi: '9', dbPath }), dbPath);
});

test('the same preload with the real Node-API opens a database through the gate', () => {
  // Gegenstueck: nicht der Preload beendet den Prozess, sondern die Pruefung.
  const dbPath = join(tempDir('yuvomi-node-runtime-'), 'unused.db');
  const code = `
    const { default: Database } = await import(${JSON.stringify(new URL(`../${GATE}`, import.meta.url).href)});
    const db = new Database(':memory:');
    console.log(db.prepare('SELECT 41 + 1 AS n').get().n);
    db.close();
  `;
  const run = runProgram(['--input-type=module', '-e', code], { napi: process.versions.napi, dbPath });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
});
