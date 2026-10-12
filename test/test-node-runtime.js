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
 *     Treiber (auch nicht ueber einen Unterpfad des Pakets), also kommt niemand
 *     an der Pruefung vorbei. Grenze: ein zur Laufzeit zusammengesetzter
 *     Spezifizierer entgeht dem Textvergleich;
 *   - die Pruefung laeuft VOR dem Laden des Treibers, nicht nur vor dem ersten
 *     Konstruktor: gemessen an einem Treiber, dessen Laden selbst scheitert;
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
const CHECK = 'server/utils/require-supported-runtime.js';

// ---------------------------------------------------------------------------
// Reine Funktion
// ---------------------------------------------------------------------------

test('a runtime below the required Node-API gets one line that names what runs, what is needed and what helps', () => {
  const message = runtimeProblem({ node: '22.12.0', napi: '9', range: '^22.14.0 || >=23.6.0' });
  assert.equal(typeof message, 'string');
  assert.ok(!message.includes('\n'), 'the message is a single line');
  assert.match(message, /Node\.js 22\.12\.0/);
  assert.match(message, /Node-API 9\b/);
  assert.match(message, new RegExp(`Node-API ${REQUIRED_NAPI}\\b`));
  assert.ok(message.includes('"^22.14.0 || >=23.6.0"'), message);
  assert.match(message, /Update Node\.js/);
});

test('a runtime with the required Node-API or newer passes', () => {
  assert.equal(runtimeProblem({ node: '22.14.0', napi: '10' }), null);
  assert.equal(runtimeProblem({ node: '24.21.0', napi: 10 }), null);
  assert.equal(runtimeProblem({ node: '99.0.0', napi: String(REQUIRED_NAPI + 1) }), null);
});

test('the check hangs on the capability, not on the version number', () => {
  // Node 23.0 bis 23.5 liegen ueber jeder 22er-Grenze und haben Node-API 9.
  const odd = runtimeProblem({ node: '23.5.0', napi: '9', range: pkg.engines.node });
  assert.match(odd, /Node\.js 23\.5\.0/);
  // Die Meldung darf dort nicht behaupten, 23.5.0 sei zu alt fuer eine 22er-Grenze.
  assert.ok(odd.includes(`matches "${pkg.engines.node}"`), odd);
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
  assert.equal(declaredNodeRange(), pkg.engines.node);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  const message = runtimeProblem({ node: '22.12.0', napi: '9', range: declaredNodeRange() });
  assert.ok(message.includes(pkg.engines.node), message);
});

test('the runtime check carries no Node version of its own', () => {
  for (const file of ['server/utils/node-runtime.js', GATE, CHECK]) {
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

/**
 * Zeilen ohne Kommentarzeilen: JSDoc nennt den Treiber als Typ, das zaehlt nicht.
 * Ein Blockkommentar am Zeilenanfang wird HERAUSGESCHNITTEN, nicht die Zeile
 * verworfen: hinter `/* x *\/` kann ein Import stehen.
 */
function codeLines(source) {
  return source.split('\n')
    .map((line) => line.replace(/^(\s*\/\*.*?\*\/)+/, ''))
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
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
  // Mit Unterpfad: das Paket exportiert `<name>/darwin-arm64` usw., und jeder
  // davon liefert eine funktionierende Database.
  const quoted = new RegExp(`['"\`]${DRIVER}(/[^'"\`]*)?['"\`]`);
  return sourceFiles(ROOT).filter((file) =>
    codeLines(readFileSync(join(ROOT, file), 'utf8')).some((line) => quoted.test(line)));
}

test('outside test/, only the gate module loads the database driver', () => {
  assert.deepEqual(driverImporters(), [GATE]);
});

test('the gate module imports the check on the line above the driver', () => {
  // ES-Module werten Importe in Quellreihenfolge aus. Steht die Pruefung
  // darueber, ist sie gelaufen, bevor der Treiber ueberhaupt geladen wird -
  // und haengt nicht daran, dass er sein Binary erst im Konstruktor laedt.
  const imports = codeLines(readFileSync(join(ROOT, GATE), 'utf8')).filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(imports, [
    `import './${CHECK.split('/').pop()}';`,
    `import Database from '${DRIVER}';`,
  ]);
});

test('the check module runs the check in its own body and imports nothing else', () => {
  const lines = codeLines(readFileSync(join(ROOT, CHECK), 'utf8'));
  assert.deepEqual(lines.filter((line) => /^\s*import\b/.test(line)), [
    "import { assertSupportedRuntime } from './node-runtime.js';",
  ]);
  assert.match(lines.join('\n'), /^assertSupportedRuntime\(\);$/m);
});

// ---------------------------------------------------------------------------
// Als Programm
// ---------------------------------------------------------------------------

// Ein Preload, der dem Kindprozess eine alte Node-API vortaeuscht. Die echte
// alte Laufzeit kann die Suite nicht fahren: sie laeuft auf der Version, die
// die CI stellt.
const FAKE_NAPI = 'data:text/javascript,' + encodeURIComponent(
  "Object.defineProperty(process.versions, 'napi', { value: process.env.YUVOMI_TEST_FAKE_NAPI, enumerable: true, configurable: true });",
);

// Ein Preload, der das Laden des Treibers selbst scheitern laesst: der
// Spezifizierer wird auf ein Modul umgebogen, das beim Auswerten wirft. So
// zeigt sich, ob die Pruefung VOR dem Treiber laeuft. (Ein Fehler schon beim
// Aufloesen taugte dafuer nicht: aufgeloest wird vor jeder Auswertung.)
const DRIVER_BROKEN = 'the database driver module was evaluated';
// Die Preloads sind FESTE Texte: was sie brauchen (Spezifizierer, Ziel-URL,
// Fehlertext), lesen sie aus der Umgebung des Kindprozesses, statt dass es in
// den Quelltext geklebt wird (CodeQL js/bad-code-sanitization, Alert 130).
const dataModule = (source) => 'data:text/javascript,' + encodeURIComponent(source);
const BROKEN_DRIVER_URL = dataModule(
  // Der Default-Export muss da sein: sonst scheitert schon das Verknuepfen,
  // und das laeuft vor jeder Auswertung.
  'export default null; throw new Error(process.env.YUVOMI_TEST_DRIVER_BROKEN);',
);
const REDIRECT = 'if (specifier === process.env.YUVOMI_TEST_DRIVER) return { url: process.env.YUVOMI_TEST_BROKEN_URL, shortCircuit: true };';
const ASYNC_HOOKS_URL = dataModule(
  'export async function resolve(specifier, context, next) { ' + REDIRECT + ' return next(specifier, context); }',
);
// registerHooks, wo es das gibt; module.register sonst (Node 22.14).
const brokenDriver = dataModule(
  "import module from 'node:module';"
  + " if (typeof module.registerHooks === 'function') {"
  + ' module.registerHooks({ resolve(specifier, context, next) { ' + REDIRECT + ' return next(specifier, context); } });'
  + ' } else { module.register(process.env.YUVOMI_TEST_ASYNC_HOOKS); }',
);

function runProgram(args, { napi, dbPath, preloads = [] }) {
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-node-runtime-secret-min-32-chars-long',
    SESSION_SECURE: 'false',
    PORT: '0',
    BIND_ADDRESS: '127.0.0.1',
    BACKUP_ENABLED: 'false',
    YUVOMI_TEST_FAKE_NAPI: String(napi),
    YUVOMI_TEST_DRIVER: DRIVER,
    YUVOMI_TEST_DRIVER_BROKEN: DRIVER_BROKEN,
    YUVOMI_TEST_BROKEN_URL: BROKEN_DRIVER_URL,
    YUVOMI_TEST_ASYNC_HOOKS: ASYNC_HOOKS_URL,
  };
  delete env.DB_ENCRYPTION_KEY;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--import', FAKE_NAPI, ...preloads.flatMap((url) => ['--import', url]), ...args], {
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
  assert.equal(run.stdout, '', 'nothing on stdout');
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

const importGate = `await import(${JSON.stringify(new URL(`../${GATE}`, import.meta.url).href)});`;

test('the check answers before the driver is loaded, even when loading the driver itself fails', () => {
  const dbPath = join(tempDir('yuvomi-node-runtime-'), 'unused.db');
  const run = runProgram(['--input-type=module', '-e', importGate], { napi: '9', dbPath, preloads: [brokenDriver] });
  assertRefused(run, dbPath);
});

test('the broken-driver preload does break the driver when the check passes', () => {
  // Gegenstueck: ohne das waere der Test darueber auch gruen, wenn der Preload
  // gar nicht griffe.
  const dbPath = join(tempDir('yuvomi-node-runtime-'), 'unused.db');
  const run = runProgram(['--input-type=module', '-e', importGate], { napi: process.versions.napi, dbPath, preloads: [brokenDriver] });
  assert.notEqual(run.status, 0);
  assert.ok(run.stderr.includes(DRIVER_BROKEN), run.stderr);
});
