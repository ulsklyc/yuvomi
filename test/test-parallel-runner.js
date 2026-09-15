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
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { SERIAL, loadSteps, parseChain, runSteps } from '../scripts/run-tests-parallel.mjs';
// Namensraum statt benanntem Import fuer Helfer, die spaeter dazukamen: fehlt
// einer, wird nur sein Test rot und nicht die ganze Datei beim Laden.
import * as runnerModule from '../scripts/run-tests-parallel.mjs';
import { isRunning, parseProcStat, processState, runningGroupMembers } from '../scripts/process-state.mjs';

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

/* KEINE ERSETZUNG, AUCH NICHT IN ANFUEHRUNGSZEICHEN.
 *
 * In `"$(printf "%s && %s" a b)"` oeffnet das innere `"` in der Shell ein
 * NEUES Quote-Paar innerhalb der Befehlsersetzung. Der Parser kennt nur eine
 * Quote-Ebene, hielt die inneren Quotes fuer das Ende der aeusseren und
 * zerlegte die Kette in drei Teile (Review auf #1229). Nachgebaut wird das
 * nicht: die echte Kette enthaelt weder `$(`, Backticks noch `${`, und ein
 * Parser fuer verschachtelte Ersetzungen waere ein Shell-Nachbau. Der Runner
 * lehnt sie IRGENDWO in der Kette laut ab, auch in einfachen Quotes, wo sie
 * harmlos waeren - eine Regel ohne Ausnahme bleibt pruefbar. */
test('Befehlsersetzung und ${...} lehnt der Runner ab, auch in Anfuehrungszeichen', () => {
  for (const chain of [
    'echo "$(printf "%s && %s" a b)" && echo c',
    'echo "`printf "%s && %s" a b`" && echo c',
    'echo \'$(a)\' && echo c',
    'echo "${HOME}" && echo c',
    'echo "$((1 + 1))" && echo c',
  ]) assert.throws(() => parseChain(chain), /Ersetzung/, JSON.stringify(chain));

  const r = runRunner(['echo "$(printf "%s && %s" a b)"', 'echo c']);
  try {
    assert.equal(r.run.status, 2, r.run.stdout + r.run.stderr);
    assert.match(r.run.stderr, /Ersetzung/);
    assert.equal(r.summary, null, 'bei einer abgelehnten Kette darf nichts laufen');
  } finally {
    r.cleanup();
  }
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

/**
 * Laeuft `pid` nach bis zu `ms` noch? Ein Zombie laeuft nicht: ein getoeteter
 * Waise bleibt als `Z` in der Tabelle, bis der Init-Prozess ihn erntet, und in
 * manchem Container tut der das nie (scripts/process-state.mjs).
 */
function runningAfter(pid, ms) {
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + ms; ; Atomics.wait(tick, 0, 0, 25)) {
    if (!isRunning(pid)) return false;
    if (Date.now() > deadline) return true;
  }
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Wartet, bis `file` existiert, oder wirft nach `ms`. */
async function waitForFile(file, ms, what) {
  for (const deadline = Date.now() + ms; !existsSync(file); await pause(25)) {
    if (Date.now() > deadline) throw new Error(`${what} ist nach ${ms} ms nicht da - der Test prueft so nichts`);
  }
}

/* EIN ECHTER ZOMBIE, auf jeder Plattform: die Shell startet ein Kind im
 * Hintergrund und ersetzt sich dann durch `sleep`, das nie `wait()` ruft. Das
 * Kind endet und bleibt als `Z` stehen, bis `sleep` endet. `process.kill(pid,
 * 0)` gelingt darauf - genau das hielt die erste Fassung fuer "lebt noch". */
test('ein Zombie zaehlt als beendet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-zombie-'));
  const parent = spawn('/bin/sh', ['-c', 'sleep 0.3 & echo $! > z.pid; exec sleep 5'], { cwd: dir, stdio: 'ignore' });
  try {
    await waitForFile(join(dir, 'z.pid'), 5000, 'z.pid');
    const pid = Number(readFileSync(join(dir, 'z.pid'), 'utf8'));
    for (const deadline = Date.now() + 5000; processState(pid) !== 'zombie'; await pause(25)) {
      assert.ok(Date.now() < deadline, `Prozess ${pid} wurde nie zum Zombie: ${processState(pid)}`);
    }
    assert.doesNotThrow(() => process.kill(pid, 0), 'der Zombie steht noch in der Prozesstabelle');
    assert.equal(isRunning(pid), false);
    assert.equal(runningAfter(pid, 0), false);
  } finally {
    parent.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Beide Leser auf jeder Plattform: den `/proc`-Zweig unter macOS und den
 * `ps`-Zweig unter Linux sieht nur, wer das Lesen ersetzt. */
test('Prozesszustand aus /proc und aus ps, mit Zombie in der Gruppe', () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const files = {
    '/proc/10/stat': '10 (node) S 1 10 10 0 -1 4194560',
    '/proc/11/stat': '11 (a (b) c) Z 10 10 10 0 -1 4194572',
    '/proc/12/stat': '12 (sh) R 1 12 12 0 -1 4194560',
  };
  const linux = {
    platform: 'linux',
    readFile: (file) => { if (file in files) return files[file]; throw enoent(); },
    listProc: () => ['self', ...Object.keys(files).map((file) => file.split('/')[2])],
  };
  assert.deepEqual(parseProcStat(files['/proc/11/stat']), { state: 'Z', pgid: 10 });
  assert.deepEqual([10, 11, 99].map((pid) => processState(pid, linux)), ['alive', 'zombie', 'gone']);
  assert.deepEqual(runningGroupMembers([10], linux), [10]);
  assert.deepEqual(runningGroupMembers([10, 12], linux), [10, 12]);

  const table = [[10, 10, 'Ss'], [11, 10, 'Z'], [12, 12, 'R+']];
  const mac = {
    platform: 'darwin',
    ps: (args) => {
      if (args[0] === '-A') return `${table.map((row) => `  ${row.join('  ')}`).join('\n')}\n`;
      const row = table.find(([pid]) => String(pid) === args.at(-1));
      if (!row) throw Object.assign(new Error('ps: exit 1'), { status: 1 });
      return `${row[2]}\n`;
    },
  };
  assert.deepEqual([10, 11, 99].map((pid) => processState(pid, mac)), ['alive', 'zombie', 'gone']);
  assert.deepEqual(runningGroupMembers([10], mac), [10]);
  assert.deepEqual(runningGroupMembers([10, 12], mac), [10, 12]);
});

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
    assert.equal(runningAfter(pid, 2000), false, `Enkelprozess ${pid} lebt nach dem Timeout weiter - der Kill traf nur die Shell`);
    pid = null;
  } finally {
    // Kein Waise aus einem roten Lauf: der Test raeumt ihn selbst ab.
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
    hung.cleanup();
  }
});

/** Startet den Runner als Programm, ohne auf ihn zu warten. */
function startRunner(args, env = process.env) {
  const child = spawn(process.execPath, [RUNNER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, out }));
  return { child, done };
}

const logsLine = (out) => out.match(/^Logs: (.+)$/m)?.[1];

/* JEDER LAUF SEIN EIGENER ORDNER, NUR FUER DEN EIGENEN NUTZER.
 *
 * Die Fassung davor schrieb ohne `--logs` in EINEN Ordner je Checkout und
 * leerte ihn beim Start: ein zweiter Lauf im selben Checkout loeschte die Logs
 * des laufenden ersten, und beide schrieben ihre `summary.json` an dieselbe
 * Stelle. Angelegt wurde der Ordner mit 0755, die Logs mit 0644 - unter Linux
 * liegt `/tmp` fuer alle Nutzer offen (Review auf #1229). */
test('ohne --logs bekommt jeder Lauf einen eigenen Ordner mit 0700, auch gleichzeitig', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-logs-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "setTimeout(() => console.log(process.env.RUN_MARK), 400)"' },
  }));
  const created = [];
  try {
    const [a, b] = await Promise.all(['a', 'b'].map((mark) => startRunner(
      ['--package', join(dir, 'package.json')],
      { ...process.env, RUN_MARK: mark },
    ).done));
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const runs = [[logsLine(a.out), 'a'], [logsLine(b.out), 'b']];
    created.push(...runs.map(([runDir]) => runDir).filter(Boolean));
    assert.notEqual(runs[0][0], runs[1][0], 'zwei gleichzeitige Laeufe teilen sich einen Logordner');
    // Direkt unter tmpdir, per mkdtemp - keine feste Wurzel dazwischen (siehe Symlink-Test unten).
    for (const [runDir] of runs) {
      assert.equal(dirname(runDir), tmpdir(), `${runDir} liegt nicht direkt unter tmpdir`);
      assert.match(basename(runDir), /^yuvomi-test-parallel-.+/);
    }
    for (const [runDir, mark] of runs) {
      const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
      assert.equal(dirname(summary.steps[0].log), runDir, 'die Zusammenfassung zeigt auf fremde Logs');
      assert.equal(readFileSync(summary.steps[0].log, 'utf8').trim(), mark, 'das Log gehoert zum anderen Lauf');
    }
    if (process.platform !== 'win32') {
      for (const [runDir] of runs) {
        assert.equal((statSync(runDir).mode & 0o777).toString(8), '700', `${runDir} ist fuer andere Nutzer offen`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const runDir of created) rmSync(runDir, { recursive: true, force: true });
  }
});

/* KEINE FESTE WURZEL.
 *
 * Die Fassung davor schrieb unter `<tmpdir>/yuvomi-test-parallel`, einem
 * vorhersagbaren Namen. Unter einem `/tmp`, das alle beschreiben duerfen, legt
 * ein anderer Nutzer dort vorab einen Symlink auf ein Verzeichnis des Opfers
 * an: `mkdirSync(recursive)` wirft nicht, `statSync`/`chmodSync` folgen dem
 * Link, der Runner setzt das fremde Ziel auf 0700, schreibt seine Logs hinein
 * und raeumt darin auf (Review auf #1229). Dieselbe feste Wurzel brachte davor
 * schon geteilte Ordner, 0755 und EACCES fuer zweite Nutzer. Jetzt legt jeder
 * Lauf seinen Ordner per `mkdtemp` direkt unter tmpdir an: atomar, 0700,
 * unvorhersagbarer Name. Ohne zweiten Nutzer nachgestellt: der Symlink liegt
 * unter dem alten Namen in einem untergeschobenen Temp-Ordner. */
test('ein Symlink unter dem alten Wurzelnamen lenkt den Runner nicht um', (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlinks auf Ordner brauchen unter Windows Sonderrechte');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'yuvomi-runner-tmp-'));
  const victim = mkdtempSync(join(tmpdir(), 'yuvomi-runner-opfer-'));
  const pkgDir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-run-'));
  try {
    chmodSync(victim, 0o755);
    writeFileSync(join(victim, 'wichtig.txt'), 'gehoert dem Opfer');
    symlinkSync(victim, join(tmp, 'yuvomi-test-parallel'));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "1"' } }));
    const run = spawnSync(process.execPath, [RUNNER, '--package', join(pkgDir, 'package.json')], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal((statSync(victim).mode & 0o777).toString(8), '755', 'der Runner hat das Ziel des Symlinks umgerechtet');
    assert.deepEqual(readdirSync(victim), ['wichtig.txt'], 'der Runner hat in das Ziel des Symlinks geschrieben');
    const runDir = logsLine(run.stdout);
    assert.equal(dirname(runDir), tmp, `der Laufordner ${runDir} liegt nicht direkt unter tmpdir`);
    assert.match(basename(runDir), /^yuvomi-test-parallel-.+/);
    assert.equal((statSync(runDir).mode & 0o777).toString(8), '700', 'der Laufordner ist fuer andere offen');
  } finally {
    for (const d of [tmp, victim, pkgDir]) rmSync(d, { recursive: true, force: true });
  }
});

/* ALTE LAEUFE WEGRAEUMEN NUR, WENN ES SICHER GEHT. Lieber etwas liegen lassen
 * als Fremdes loeschen: kein Symlink, ein echtes Verzeichnis, die eigene UID
 * (wo es UIDs gibt), aelter als 24 h. Wurzel, Uhr und UID sind hier
 * untergeschoben, damit jeder Zweig ohne zweiten Nutzer und ohne Warten
 * sichtbar wird. */
test('das Aufraeumen loescht nur eigene, echte Laufordner ueber 24 h', () => {
  const { cleanupOldRuns } = runnerModule;
  assert.equal(typeof cleanupOldRuns, 'function', 'cleanupOldRuns fehlt im Runner');
  const tmp = mkdtempSync(join(tmpdir(), 'yuvomi-runner-cleanup-'));
  const victim = mkdtempSync(join(tmpdir(), 'yuvomi-runner-opfer-'));
  const day = 24 * 3600 * 1000;
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  const posix = typeof process.getuid === 'function';
  const own = posix ? process.getuid() : undefined;
  try {
    for (const name of ['yuvomi-test-parallel-alt', 'yuvomi-test-parallel-jung', 'anderer-ordner-alt']) mkdirSync(join(tmp, name));
    writeFileSync(join(tmp, 'yuvomi-test-parallel-datei'), 'keine Logs');
    writeFileSync(join(victim, 'wichtig.txt'), 'gehoert dem Opfer');
    for (const name of ['yuvomi-test-parallel-alt', 'anderer-ordner-alt', 'yuvomi-test-parallel-datei']) {
      utimesSync(join(tmp, name), old, old);
    }
    utimesSync(victim, old, old);
    if (process.platform !== 'win32') symlinkSync(victim, join(tmp, 'yuvomi-test-parallel-link'));

    if (posix) {
      // Einem anderen Nutzer gehoert nichts davon: selbst mit vorgestellter Uhr bleibt alles.
      assert.deepEqual(cleanupOldRuns({ tmpdir: tmp, now: Date.now() + 2 * day, uid: own + 1 }), []);
    }
    // Echte Uhr: nur der alte eigene Ordner.
    assert.deepEqual(cleanupOldRuns({ tmpdir: tmp, now: Date.now(), uid: own }), ['yuvomi-test-parallel-alt']);
    // Uhr zwei Tage vor: jetzt ist auch der junge alt - Symlink, Datei und fremder Name bleiben trotzdem.
    assert.deepEqual(cleanupOldRuns({ tmpdir: tmp, now: Date.now() + 2 * day, uid: own }), ['yuvomi-test-parallel-jung']);
    const expected = ['anderer-ordner-alt', 'yuvomi-test-parallel-datei'];
    if (process.platform !== 'win32') expected.push('yuvomi-test-parallel-link');
    assert.deepEqual(readdirSync(tmp).sort(), expected.sort());
    assert.deepEqual(readdirSync(victim), ['wichtig.txt'], 'das Ziel des Symlinks wurde angefasst');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  }
});

/* EIN ABBRUCH RAEUMT AUF, BEVOR ER ENDET.
 *
 * Die Fassung davor schickte bei SIGINT/SIGTERM einmal SIGTERM an die Gruppen
 * und beendete sich sofort. Ein Schritt, der SIGTERM ignoriert, lief als Waise
 * weiter, und ein wartender Schritt konnte noch starten (Review auf #1229).
 * Hier ignorieren Schritt UND Enkel SIGTERM; nach dem Abbruch darf keiner mehr
 * laufen, und der zweite Schritt darf nie gestartet sein. */
const STUBBORN = [
  'const { spawn } = require(\'node:child_process\');',
  'const { writeFileSync } = require(\'node:fs\');',
  'process.on(\'SIGTERM\', () => {});',
  'if (process.argv[2] === \'enkel\') {',
  '  writeFileSync(\'grand.pid\', String(process.pid));',
  '} else {',
  '  writeFileSync(\'lead.pid\', String(process.pid));',
  '  spawn(process.execPath, [__filename, \'enkel\'], { stdio: \'ignore\' });',
  '}',
  'setInterval(() => {}, 1000);',
  '',
].join('\n');
const GRACE_ARGS = ['--grace', '1'];

test('ein Abbruch wartet auf die Gruppen und toetet, was SIGTERM ignoriert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-stop-'));
  writeFileSync(join(dir, 'stur.cjs'), STUBBORN);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'node stur.cjs && node -e "require(\'node:fs\').writeFileSync(\'danach.txt\', \'x\')"' },
  }));
  const pids = [];
  try {
    const run = startRunner(['--package', join(dir, 'package.json'), '--logs', join(dir, 'logs'), '--jobs', '1', ...GRACE_ARGS]);
    await waitForFile(join(dir, 'grand.pid'), 10000, 'der Enkelprozess');
    pids.push(Number(readFileSync(join(dir, 'lead.pid'), 'utf8')), Number(readFileSync(join(dir, 'grand.pid'), 'utf8')));
    run.child.kill('SIGTERM');
    const result = await run.done;
    assert.equal(result.code, 143, `Exit ${result.code}/${result.signal}: ${result.out}`);
    for (const pid of pids) assert.equal(isRunning(pid), false, `Prozess ${pid} laeuft nach dem Abbruch weiter`);
    assert.equal(existsSync(join(dir, 'danach.txt')), false, 'nach dem Abbruch ist noch ein Schritt gestartet');
  } finally {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Startet den Runner mit einem Schritt, der samt Enkel SIGTERM ignoriert, und wartet, bis beide stehen. */
async function startStubborn(args) {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-runner-signal-'));
  writeFileSync(join(dir, 'stur.cjs'), STUBBORN);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node stur.cjs' } }));
  const run = startRunner(['--package', join(dir, 'package.json'), '--logs', join(dir, 'logs'), ...args]);
  const pids = [];
  const cleanup = () => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* schon weg */ }
    try { run.child.kill('SIGKILL'); } catch { /* schon weg */ }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitForFile(join(dir, 'grand.pid'), 10000, 'der Enkelprozess');
  } catch (err) {
    cleanup();
    throw err;
  }
  pids.push(Number(readFileSync(join(dir, 'lead.pid'), 'utf8')), Number(readFileSync(join(dir, 'grand.pid'), 'utf8')));
  return { run, pids, cleanup };
}

/* ZWEI SIGNALE AUS EINEM CTRL+C. Unter `npm run test-parallel` kommt SIGINT
 * zweimal an, vom Terminal und von npm weitergereicht. Die Fassung davor nahm
 * das zweite als "nicht mehr warten" und toetete sofort: Exit 130 nach 53 ms
 * (Review auf #1229). Nachgestellt mit zwei SIGINT im Abstand von 5 ms. */
test('zwei Signale kurz nacheinander behalten die Karenz', async () => {
  const s = await startStubborn(['--grace', '2']);
  try {
    const t0 = Date.now();
    s.run.child.kill('SIGINT');
    await pause(5);
    s.run.child.kill('SIGINT');
    await pause(700);
    for (const pid of s.pids) {
      assert.equal(isRunning(pid), true, `Prozess ${pid} ist ${Date.now() - t0} ms nach Ctrl+C tot - die Karenz fiel weg`);
    }
    const result = await s.run.done;
    const elapsed = Date.now() - t0;
    assert.equal(result.code, 130, result.out);
    assert.ok(elapsed >= 1900, `Exit nach ${elapsed} ms, vor Ablauf von --grace 2`);
    for (const pid of s.pids) assert.equal(runningAfter(pid, 2000), false, `Prozess ${pid} laeuft nach dem Abbruch weiter`);
  } finally {
    s.cleanup();
  }
});

test('ein zweites Signal mehr als eine Sekunde spaeter toetet sofort', async () => {
  const s = await startStubborn(['--grace', '30']);
  try {
    s.run.child.kill('SIGINT');
    await pause(1300);
    for (const pid of s.pids) assert.equal(isRunning(pid), true, `Prozess ${pid} ist vor dem zweiten Signal tot`);
    const t1 = Date.now();
    s.run.child.kill('SIGINT');
    const result = await s.run.done;
    const elapsed = Date.now() - t1;
    assert.equal(result.code, 130, result.out);
    assert.ok(elapsed < 5000, `Exit erst ${elapsed} ms nach dem zweiten Signal - es hat nicht eskaliert`);
    for (const pid of s.pids) assert.equal(runningAfter(pid, 2000), false, `Prozess ${pid} laeuft nach dem zweiten Signal weiter`);
  } finally {
    s.cleanup();
  }
});

test('Dauern werden vor der Zerlegung gerundet: kein "1m60s"', () => {
  const { fmt } = runnerModule;
  assert.equal(typeof fmt, 'function', 'fmt fehlt im Runner');
  assert.deepEqual(
    [0, 59940, 59960, 61000, 119600, 3599500].map(fmt),
    ['0.0s', '59.9s', '1m00s', '1m01s', '2m00s', '60m00s'],
  );
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
