/**
 * Modul: Test-Infrastruktur - Paritaet des Parallel-Runners
 * Zweck: `scripts/run-tests-parallel.mjs` liest seine Schritte aus der
 *        `test`-Kette in package.json, statt eine zweite Liste zu fuehren. Das
 *        traegt nur, wenn er dieselben Schritte findet, die `sh` beim seriellen
 *        Lauf ausfuehrt - keinen weniger, keinen mehr, keinen zerschnittenen.
 *        Diese Suite nimmt die Shell selbst als Gegenueber: sie faehrt die
 *        ganze Kette und jeden geparsten Schritt einzeln gegen Attrappen von
 *        `node` und `npm`, die nur ihre Aufrufe mitschreiben, und vergleicht
 *        beide Mitschriften (Anzahl, Reihenfolge, Argumente, Env-Praefixe).
 * Ausführen: node --test test/test-parallel-runner.js
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { SERIAL, loadSteps, parseChain, runSteps } from '../scripts/run-tests-parallel.mjs';

const RUNNER = fileURLToPath(new URL('../scripts/run-tests-parallel.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/*
 * Die Attrappe schreibt je Aufruf einen Datensatz: Programmname, jedes Argument
 * einzeln und die exportierte Umgebung - so zaehlt ein verlorenes
 * `DB_PATH=:memory:` genauso wie ein verlorener Schritt. `export -p` ist ein
 * Builtin; `env | sort` kostete je Aufruf drei Prozesse, bei rund 650
 * Aufrufen spuerbar.
 */
const STUB = [
  '#!/bin/sh',
  '{',
  '  printf \'%s\' "${0##*/}"',
  '  for arg in "$@"; do printf \'\\037%s\' "$arg"; done',
  '  printf \'\\037%s\' "$(export -p)"',
  '  printf \'\\036\'',
  '} >> "$RECORD"',
  '',
].join('\n');

/* Was die Shell je Aufruf selbst setzt und die Steuerwerte der Probe zaehlen nicht. */
const SHELL_OWN = /^(?:export |declare -x )?(?:PWD|OLDPWD|SHLVL|_|RECORD|PATH)(?:=|$)/;

const shellDir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-parity-'));
after(() => rmSync(shellDir, { recursive: true, force: true }));
for (const name of ['node', 'npm']) {
  writeFileSync(join(shellDir, name), STUB);
  chmodSync(join(shellDir, name), 0o755);
}
const recordFile = join(shellDir, 'record');
const recorded = new Map();

/** `script` in einer Shell, deren `node` und `npm` nur mitschreiben - je Skripttext einmal. */
function sh(script) {
  if (recorded.has(script)) return recorded.get(script);
  writeFileSync(recordFile, '');
  const run = spawnSync('/bin/sh', ['-c', script], {
    env: { PATH: `${shellDir}:/usr/bin:/bin`, RECORD: recordFile },
    encoding: 'utf8',
  });
  const calls = readFileSync(recordFile, 'utf8').split('\x1e').filter(Boolean).map((call) => {
    const fields = call.split('\x1f');
    const env = fields.pop().split('\n').filter((line) => line && !SHELL_OWN.test(line));
    return [...fields, ...env].join('\x1f');
  });
  const result = { status: run.status, calls };
  recorded.set(script, result);
  return result;
}

/**
 * Die Mitschrift der ganzen Kette gegen die der einzeln gefahrenen Schritte.
 * `broken` sind Schritte, die fuer sich nicht genau EINEN Aufruf ergeben: ein
 * zerschnittener Schritt ist meist ein Syntaxfehler, ein verschmolzener
 * ergibt zwei.
 */
function compare(chain, steps) {
  const whole = sh(chain);
  const single = steps.map((step) => ({ step, ...sh(step) }));
  return {
    wholeStatus: whole.status,
    whole: whole.calls,
    split: single.flatMap((s) => s.calls),
    broken: single.filter((s) => s.status !== 0 || s.calls.length !== 1).map((s) => s.step),
  };
}

const agrees = (result) => result.wholeStatus === 0
  && result.broken.length === 0
  && isDeepStrictEqual(result.split, result.whole);

test('der Runner findet jeden Schritt der test-Kette, so wie sh ihn ausfuehrt', () => {
  const { steps } = loadSteps();
  const result = compare(pkg.scripts.test, steps);

  assert.equal(result.wholeStatus, 0, 'die Kette laeuft gegen die Attrappen nicht durch');
  // Anzahl zuerst, mit lesbarer Meldung; danach Menge und Reihenfolge.
  assert.equal(steps.length, result.whole.length,
    `Runner: ${steps.length} Schritte, sh: ${result.whole.length} Aufrufe`);
  assert.deepEqual(result.broken, [], 'Schritte, die fuer sich nicht genau einen Aufruf ergeben');
  assert.deepEqual(result.split, result.whole);
  // Die Kette haengt jede Suite genau einmal ein; doppelt liefe sie im
  // Parallel-Lauf neben sich selbst.
  assert.equal(new Set(steps).size, steps.length, 'ein Schritt steht zweimal in der Kette');
});

/*
 * GEGENPROBE. Die echte Kette ist heute naiv trennbar - sie enthaelt kein `&&`
 * in Anfuehrungszeichen. Der Vergleich oben waere deshalb auch mit
 * `split(' && ')` gruen und saehe fuer sich nichts. Was er kann, zeigt erst eine
 * Kette mit den Formen, an denen ein Parser bricht, plus die realen
 * Sonderformen (Direktaufruf mit Flag, Env-Praefix, `npm run`).
 */
const TRICKY_STEPS = [
  'node --experimental-sqlite test/test-db.js',
  'npm run test:schema-reconcile',
  'DB_PATH=:memory: node --experimental-sqlite test/test-notes-contacts-budget.js',
  'TZ=Europe/Berlin DB_PATH=:memory: node --experimental-sqlite test/test-caldav-reminders.js',
  'node -e "console.log(\'a && b\')"',
  'node -e \'process.exit(0) && 1\'',
  'node --test "test/with space.js"',
  'node -e "say \\"x && y\\""',
  'node test/x.js 2>&1',
];
const TRICKY = TRICKY_STEPS.join(' && ');

test('Gegenprobe: der Vergleich wird rot, wenn das Parsen einen Schritt verliert', () => {
  assert.deepEqual(parseChain(TRICKY), TRICKY_STEPS);
  assert.ok(agrees(compare(TRICKY, parseChain(TRICKY))), 'der Parser muss die schwierige Kette halten');

  const naive = compare(TRICKY, TRICKY.split(' && '));
  assert.equal(agrees(naive), false, 'naives Trennen an && muss auffallen');
  assert.ok(naive.broken.length > 0, 'die zerschnittenen Schritte muessen benannt werden');

  const lost = compare(pkg.scripts.test, loadSteps().steps.slice(0, -1));
  assert.equal(agrees(lost), false, 'ein fehlender letzter Schritt muss auffallen');

  const glued = loadSteps().steps;
  glued.splice(0, 2, `${glued[0]} && ${glued[1]}`);
  assert.equal(agrees(compare(pkg.scripts.test, glued)), false, 'zwei verschmolzene Schritte muessen auffallen');
});

test('andere Operatoren brechen ab, statt still in einen Schritt zu rutschen', () => {
  for (const chain of [
    'a || b',
    'a; b',
    'a | b',
    'a & b',
    'a && && b',
    'a &&',
    '&& a',
    '(a) && b',
    'echo $(a) && b',
    'echo `a` && b',
    'a\nb',
    'node -e "offen && b',
  ]) assert.throws(() => parseChain(chain), undefined, JSON.stringify(chain));
});

test('SERIAL nennt nur Schritte der Kette, jeden mit Grund', () => {
  const { steps } = loadSteps();
  for (const [step, reason] of SERIAL) {
    assert.ok(steps.includes(step), `SERIAL-Eintrag steht nicht in der Kette: ${step}`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 20, `SERIAL-Eintrag ohne Grund: ${step}`);
  }
});

/* Die Schleife darueber laeuft ueber eine LEERE Liste und prueft heute nichts.
 * Was die Liste traegt, steht in `runSteps`: ein veralteter Eintrag bricht ab,
 * ein gueltiger laeuft allein nach dem parallelen Teil. Beides hier mit einer
 * eigenen Liste, damit es nicht erst mit dem ersten echten Eintrag auffaellt. */
test('SERIAL: ein veralteter Eintrag bricht ab, ein gueltiger laeuft allein danach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-serial-'));
  try {
    const opts = { cwd: dir, logDir: dir, jobs: 2, timeoutMs: 0 };
    await assert.rejects(
      runSteps(['node -e "1"'], { ...opts, serial: new Map([['npm run test:gibt-es-nicht', 'veralteter Eintrag']]) }),
      /SERIAL nennt Schritte, die nicht in der Kette stehen: npm run test:gibt-es-nicht/,
    );

    const alone = 'node -e "require(\'node:fs\').appendFileSync(\'order.txt\', \'serial\\n\')"';
    const results = await runSteps([
      alone,
      'node -e "setTimeout(() => require(\'node:fs\').appendFileSync(\'order.txt\', \'parallel\\n\'), 300)"',
    ], { ...opts, serial: new Map([[alone, 'laeuft allein, weil der Test es so will']]) });
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    // Der serielle Schritt steht in der Kette ZUERST und laeuft trotzdem nach dem parallelen.
    assert.equal(readFileSync(join(dir, 'order.txt'), 'utf8'), 'parallel\nserial\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Faehrt den Runner als Programm gegen eine eigene package.json. */
function runRunner(chainSteps, args = [], { runner = RUNNER, logs = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-run-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: chainSteps.join(' && ') } }));
  const logDir = join(dir, 'logs');
  const run = spawnSync(process.execPath, [
    runner, '--package', join(dir, 'package.json'), ...(logs ? ['--logs', logDir] : []), ...args,
  ], { encoding: 'utf8' });
  const summaryPath = join(logDir, 'summary.json');
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
  return { dir, run, summary, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* Der Einstieg darf nie still nichts tun. Die erste Fassung verglich
 * `import.meta.url` (vom Loader aufgeloest) mit `path.resolve(argv[1])` (nicht
 * aufgeloest): ueber einen Symlink gestartet - unter macOS schon `/tmp` statt
 * `/private/tmp` - endete der Runner mit Exit 0 und ohne ein Byte Ausgabe,
 * auch bei roter Kette (Review auf #1229). */
test('ueber einen Symlink gestartet laeuft der Runner trotzdem, rot bleibt rot', () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-link-'));
  const link = join(linkDir, 'runner-link.mjs');
  symlinkSync(RUNNER, link);
  const r = runRunner(['node -e "process.exit(1)"'], [], { runner: link });
  try {
    assert.equal(r.run.status, 1, `Exit ${r.run.status}, Ausgabe: ${JSON.stringify(r.run.stdout + r.run.stderr)}`);
    assert.match(r.run.stdout, /1 Schritte, 0 gruen, 1 rot/);
  } finally {
    r.cleanup();
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test('ein roter Schritt haelt den Lauf nicht an, der Exit-Code kommt aus dem Kind', () => {
  // --jobs 1: der dritte Schritt startet erst NACH dem roten - laeuft er, lief der Runner weiter.
  const r = runRunner([
    'node -e "process.exit(0)"',
    'node -e "process.stdout.write(\'x\'.repeat(200000)); process.exitCode = 3"',
    'node -e "require(\'node:fs\').writeFileSync(\'after.txt\', \'ok\')"',
  ], ['--jobs', '1']);
  try {
    const out = r.run.stdout + r.run.stderr;
    assert.equal(r.run.status, 1, out);
    assert.ok(existsSync(join(r.dir, 'after.txt')), 'der Schritt nach dem roten ist nicht gelaufen');
    assert.deepEqual(r.summary.steps.map((s) => [s.ok, s.code]), [[true, 0], [false, 3], [true, 0]]);
    const redLog = r.summary.steps[1].log;
    assert.equal(readFileSync(redLog, 'utf8').length, 200000, 'das Log traegt die ganze Ausgabe');
    assert.ok(out.includes(redLog), 'die Zusammenfassung nennt den Logpfad des roten Schritts');
    assert.match(out, /exit 3/);
  } finally {
    r.cleanup();
  }
});

test('alle gruen ergibt Exit 0', () => {
  const green = runRunner(['node -e "1"', 'node -e "2"', 'node -e "3"'], ['--jobs', '3']);
  try {
    assert.equal(green.run.status, 0, green.run.stdout + green.run.stderr);
    assert.equal(green.summary.steps.length, 3);
  } finally {
    green.cleanup();
  }

});

/** Lebt `pid` noch? Wartet bis zu `ms`, weil ein getoeteter Waise erst vom Init-Prozess abgeraeumt wird. */
function aliveAfter(pid, ms) {
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + ms; ; Atomics.wait(tick, 0, 0, 25)) {
    try { process.kill(pid, 0); } catch { return false; }
    if (Date.now() > deadline) return true;
  }
}

/* DER TIMEOUT MUSS DIE GANZE GRUPPE TREFFEN, NICHT NUR DIE SHELL.
 *
 * Ein Schritt ist `sh -c <schritt>`, und `npm run x` darunter ist npm -> sh ->
 * node. Die erste Fassung dieses Tests hing mit einem direkten `node -e`: `sh`
 * ersetzt sich dann durch `node`, der Kill auf die Shell traf also zufaellig den
 * Prozess, der haengt, und `process.kill(child.pid)` statt `-child.pid` blieb
 * gruen (Review auf #1229). Hier haengt ein ENKEL - das `; :` hinter dem Aufruf
 * zwingt die innere Shell zu forken statt sich zu ersetzen -, und geprueft wird,
 * dass er nach dem Lauf nicht mehr lebt. */
test('ein haengender Schritt faellt ueber den Timeout, samt seiner Enkelprozesse', () => {
  const grandchild = 'node -e "require(\\"node:fs\\").writeFileSync(\\"hang.pid\\", String(process.pid)); setTimeout(() => {}, 60000)"';
  const hung = runRunner([`sh -c '${grandchild}; :'`, 'node -e "1"'], ['--jobs', '2', '--timeout', '2']);
  let pid = null;
  try {
    assert.equal(hung.run.status, 1, hung.run.stdout + hung.run.stderr);
    assert.deepEqual(hung.summary.steps.map((s) => [s.ok, s.timedOut]), [[false, true], [true, false]]);
    const pidFile = join(hung.dir, 'hang.pid');
    assert.ok(existsSync(pidFile), 'der Enkelprozess ist nie gestartet - der Test prueft so nichts');
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(aliveAfter(pid, 2000), false, `Enkelprozess ${pid} lebt nach dem Timeout weiter - der Kill traf nur die Shell`);
    pid = null;
  } finally {
    // Kein Waise aus einem roten Lauf: der Test raeumt ihn selbst ab.
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
    hung.cleanup();
  }
});

/* Ohne `--logs` schreibt jeder Lauf in DENSELBEN Ordner je Checkout und leert
 * ihn vorher. Die erste Fassung legte je Lauf ein neues Verzeichnis mit rund
 * 326 Dateien in den Temp-Ordner und raeumte nie auf. Ein fester Ordner je
 * Checkout statt Aufraeumen nach Praefix: das Praefix trifft auch den
 * laufenden Runner eines anderen Arbeitsbaums. */
test('ohne --logs ueberschreibt ein Lauf den Logordner seines Checkouts', () => {
  const first = runRunner(['node -e "1"'], [], { logs: false });
  try {
    const dirOf = (out) => out.match(/^Logs: (.+)$/m)?.[1];
    const logDir = dirOf(first.run.stdout);
    assert.ok(logDir && existsSync(join(logDir, '001-node_-e_1.log')), first.run.stdout);
    writeFileSync(join(logDir, 'alt.log'), 'vom vorigen Lauf');

    const again = spawnSync(process.execPath, [RUNNER, '--package', join(first.dir, 'package.json')], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(dirOf(again.stdout), logDir, 'derselbe Checkout bekommt denselben Logordner');
    assert.equal(existsSync(join(logDir, 'alt.log')), false, 'der Rest des vorigen Laufs liegt noch da');
    assert.ok(existsSync(join(logDir, 'summary.json')));
    rmSync(logDir, { recursive: true, force: true });
  } finally {
    first.cleanup();
  }
});

test('ein falscher Aufruf endet mit Exit 2, nicht mit einem Lauf', () => {
  const r = runRunner(['node -e "1"'], ['--jobs', '0']);
  try {
    assert.equal(r.run.status, 2, r.run.stdout + r.run.stderr);
    assert.equal(r.summary, null);
  } finally {
    r.cleanup();
  }
});
