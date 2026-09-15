#!/usr/bin/env node
/**
 * Modul: Paralleler Lauf der npm-test-Kette
 * Zweck: Faehrt jeden Schritt der `test`-Kette aus package.json als eigenen
 *        Prozess, mit begrenzter Parallelitaet, und laeuft bei Rot weiter
 * Abhaengigkeiten: /bin/sh, node:child_process
 *
 * Die `test`-Kette ist eine `&&`-Kette aus rund 320 Schritten und die EINE
 * Registry der Suiten (`test:suite-chain` haelt das). Seriell hat sie zwei
 * Kosten: sie dauert, und der erste rote Schritt verdeckt jeden folgenden. Wer
 * drei Suiten gebrochen hat, erfaehrt es in drei Laeufen.
 *
 * KEINE ZWEITE LISTE. Die Schritte kommen aus `scripts.test`, so wie `sh` sie
 * liest: getrennt wird nur an einem `&&` ausserhalb von Anfuehrungszeichen. Ein
 * anderer Operator (`||`, `;`, `|`, `&`, Klammern, Backticks) bricht mit einer
 * Meldung ab, statt still in einen Nachbarschritt zu rutschen. Dass der Parser
 * dieselben Schritte findet wie die Shell, belegt `test:parallel-runner` gegen
 * `sh` selbst.
 *
 * KEINE SUITE, DESHALB KEIN `test:`-NAME. `test:suite-chain` verlangt, dass
 * jedes `test:*`-Script in einer Kette haengt; den Einstieg der Browser-Kette
 * nennt es einmal beim Namen, weil eine Kette nicht in sich selbst haengen
 * kann, und will diese Stelle nicht zur Liste wachsen lassen. Dieser Runner ist
 * ein zweiter Einstieg in DIESELBE Kette - er heisst deshalb wie `coverage`,
 * das die Kette ebenfalls nur faehrt: ausserhalb von `test:` (`test-parallel`).
 *
 * Exit-Code je Schritt kommt aus dem Kindprozess selbst. Ausgabe geht per
 * Datei-Deskriptor ins Log, nicht durch eine Pipe: `cmd | tee` meldet den Code
 * von `tee`.
 *
 * Aufruf:  node scripts/run-tests-parallel.mjs [--jobs N] [--logs DIR]
 *          [--timeout SEKUNDEN] [--grace SEKUNDEN] [--list] [--package DATEI]
 * Logs ohne `--logs`: `<tmpdir>/yuvomi-test-parallel-*`, je Lauf per `mkdtemp`
 * neu (0700); eigene Laufordner ueber 24 h raeumt der naechste Lauf weg.
 * Nur POSIX: `/bin/sh`, Prozessgruppen - wie die `test`-Kette selbst.
 * `--timeout` gilt je Schritt, Default 900 s. `--grace`: so lange wartet ein
 * Abbruch nach SIGTERM, bevor er SIGKILL schickt, Default 5 s.
 * Exit 0 = alle Schritte gruen, 1 = mindestens einer rot, 2 = Aufruf- oder
 * Parserfehler.
 */

import { spawn } from 'node:child_process';
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { runningGroupMembers } from './process-state.mjs';

const REPO_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * Schritte, die nicht neben anderen laufen duerfen - Schritt -> Grund.
 *
 * Eine ALLOWLIST mit Grund je Eintrag, keine Heuristik. Eine Kollision wird an
 * der Quelle behoben (Port 0, `freshTestDbPath()`, `mkdtemp`); hierher gehoert
 * nur, was sich dort nicht beheben laesst. Laufen die Eintraege, dann nach dem
 * parallelen Teil, einzeln. Ein Eintrag, der in der Kette nicht (mehr) steht,
 * bricht den Lauf ab - sonst veraltet die Liste lautlos.
 */
export const SERIAL = new Map([]);

const UNSUPPORTED = new Map([
  ['|', 'Pipe'],
  [';', 'Semikolon'],
  ['\n', 'Zeilenumbruch'],
  ['(', 'Klammer'],
  [')', 'Klammer'],
]);

/*
 * `$(`, Backticks und `${` - UEBERALL in der Kette, auch in Anfuehrungszeichen.
 * In `"$(printf "%s && %s" a b)"` beginnt das innere `"` in der Shell ein neues
 * Quote-Paar; der Parser kennt nur eine Ebene und zerlegte die Kette in drei
 * Teile (Review auf #1229). Nachgebaut wird das nicht - die echte Kette enthaelt
 * nichts davon, und verschachtelte Ersetzungen richtig zu lesen hiesse, die
 * Shell nachzubauen. Auch in einfachen Quotes, wo sie harmlos waeren: eine
 * Regel ohne Ausnahme bleibt pruefbar.
 */
const SUBSTITUTION = /\$\(|\$\{|`/;

/**
 * Zerlegt eine `&&`-Kette in ihre Schritte, so wie `sh` sie trennt.
 *
 * Getrennt wird nur an `&&` ausserhalb von Anfuehrungszeichen; einfache Quotes
 * kennen kein Escape, doppelte und ungequotete den Backslash. Jeder Schritt
 * bleibt woertlich stehen und geht unveraendert an `sh -c`.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function parseChain(script) {
  const substitution = script.match(SUBSTITUTION);
  if (substitution) {
    throw new Error(`Nicht unterstuetzte Ersetzung '${substitution[0]}' bei Zeichen ${substitution.index}: `
      + '$(...), Backticks und ${...} lehnt der Runner ueberall in der Kette ab, auch in Anfuehrungszeichen');
  }
  const steps = [];
  let current = '';
  let quote = null;
  const push = (at) => {
    const step = current.trim();
    if (!step) throw new Error(`Leerer Schritt in der Kette bei Zeichen ${at}`);
    steps.push(step);
    current = '';
  };

  for (let i = 0; i < script.length; i += 1) {
    const c = script[i];
    if (quote === '\'') {
      current += c;
      if (c === '\'') quote = null;
    } else if (quote === '"') {
      current += c;
      if (c === '\\' && i + 1 < script.length) current += script[++i];
      else if (c === '"') quote = null;
    } else if (c === '\\') {
      current += c;
      if (i + 1 < script.length) current += script[++i];
    } else if (c === '\'' || c === '"') {
      current += c;
      quote = c;
    } else if (c === '&') {
      if (script[i + 1] === '&') {
        push(i);
        i += 1;
      } else if (/[<>]$/.test(current)) {
        current += c; // Umleitung wie `2>&1`
      } else {
        throw new Error(`Nicht unterstuetzter Operator '&' bei Zeichen ${i}`);
      }
    } else if (UNSUPPORTED.has(c)) {
      throw new Error(`Nicht unterstuetzter Operator (${UNSUPPORTED.get(c)}) bei Zeichen ${i}`);
    } else {
      current += c;
    }
  }
  if (quote) throw new Error(`Offenes Anfuehrungszeichen ${quote} in der Kette`);
  push(script.length);
  return steps;
}

/** Die Schritte der `test`-Kette einer package.json, samt Arbeitsverzeichnis. */
export function loadSteps(packagePath = REPO_PACKAGE) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (typeof pkg.scripts?.test !== 'string') throw new Error(`${packagePath} hat kein scripts.test`);
  return { steps: parseChain(pkg.scripts.test), cwd: path.dirname(path.resolve(packagePath)) };
}

function parseArgs(argv) {
  const opts = {
    jobs: Math.max(1, os.availableParallelism() - 1),
    logs: null,
    timeout: 900,
    grace: 5,
    list: false,
    packagePath: REPO_PACKAGE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} braucht einen Wert`);
      return argv[++i];
    };
    const count = (raw, min) => {
      if (!/^\d+$/.test(raw) || Number(raw) < min) throw new Error(`${arg} erwartet eine ganze Zahl >= ${min}, nicht '${raw}'`);
      return Number(raw);
    };
    if (arg === '--jobs' || arg === '-j') opts.jobs = count(value(), 1);
    else if (arg === '--logs') opts.logs = path.resolve(value());
    else if (arg === '--timeout') opts.timeout = count(value(), 0);
    else if (arg === '--grace') opts.grace = count(value(), 0);
    else if (arg === '--package') opts.packagePath = path.resolve(value());
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unbekanntes Argument: ${arg}`);
  }
  return opts;
}

/**
 * Dauer fuer die Ausgabe. Gerundet wird VOR der Zerlegung in Minuten und
 * Sekunden - sonst wird aus 119,6 s "1m60s" und aus 59,96 s "60.0s" (Review
 * auf #1229).
 */
export const fmt = (ms) => {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

const slug = (step) => step.replace(/^npm run /, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

/** Laufende Prozessgruppen, damit ein Abbruch sie mitnimmt. */
const running = new Set();

/** Nach einem Abbruch startet kein Schritt mehr. */
let interrupted = false;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/*
 * DER LOGORDNER EINES LAUFS OHNE `--logs`: `mkdtemp` DIREKT UNTER TMPDIR.
 *
 * Keine feste Wurzel. Die Fassungen davor schrieben unter
 * `<tmpdir>/yuvomi-test-parallel`, und jeder Befund auf #1229 kam von diesem
 * einen vorhersagbaren Namen: zwei Laeufe teilten einen Ordner, er entstand mit
 * 0755, ein zweiter Nutzer bekam EACCES - und unter einem `/tmp`, das alle
 * beschreiben duerfen, lenkte ein vorab gelegter Symlink den Runner in ein
 * fremdes Verzeichnis: `mkdirSync(recursive)` wirft dort nicht, `statSync` und
 * `chmodSync` folgen dem Link, der Runner setzte das Ziel auf 0700, schrieb
 * hinein und raeumte darin auf. Eine UID im Namen aendert daran nichts, der
 * Name bliebe vorhersagbar. `mkdtemp` legt atomar an, mit 0700 und einem Namen,
 * den niemand vorher kennt - kein `chmod` auf einen vorgefundenen Pfad.
 */
const RUN_PREFIX = 'yuvomi-test-parallel-';
const RUN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Raeumt alte Laufordner weg - nur, wenn es sicher geht. Lieber etwas liegen
 * lassen als Fremdes loeschen: ein Eintrag `yuvomi-test-parallel-*` direkt in
 * tmpdir, per `lstat` gelesen (kein Symlink, ein echtes Verzeichnis), mit der
 * eigenen UID (wo es UIDs gibt; unter Windows zaehlen nur Art und Alter) und
 * aelter als 24 h. Ein laufender Lauf ist frisch: jedes neue Log setzt die
 * mtime seines Ordners.
 *
 * Wurzel, Uhr und UID lassen sich unterschieben, damit der Test jeden Zweig
 * ohne zweiten Nutzer und ohne Warten sieht.
 *
 * @returns {string[]} die Namen der geloeschten Ordner
 */
export function cleanupOldRuns({
  tmpdir = os.tmpdir(), now = Date.now(), uid = process.getuid?.(), maxAgeMs = RUN_DIR_MAX_AGE_MS,
} = {}) {
  const removed = [];
  let names;
  try { names = readdirSync(tmpdir); } catch { return removed; }
  for (const name of names.sort()) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = path.join(tmpdir, name);
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (typeof uid === 'number' && stat.uid !== uid) continue;
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch { /* inzwischen weg oder nicht lesbar - liegen lassen */ }
  }
  return removed;
}

function defaultLogDir() {
  cleanupOldRuns();
  return mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX));
}

function runStep({ step, index }, { cwd, logDir, timeoutMs }) {
  const logPath = path.join(logDir, `${String(index + 1).padStart(3, '0')}-${slug(step)}.log`);
  const fd = openSync(logPath, 'w');
  const started = performance.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let timer = null;
    // Eigene Prozessgruppe: ein Timeout oder Abbruch trifft auch npm -> sh -> node.
    const child = spawn('/bin/sh', ['-c', step], { cwd, stdio: ['ignore', fd, fd], detached: true });
    closeSync(fd);
    running.add(child);
    const finish = (code, signal, error) => {
      if (timer) clearTimeout(timer);
      running.delete(child);
      resolve({
        step, index, logPath, code, signal, error, timedOut,
        ok: !error && !timedOut && code === 0,
        ms: performance.now() - started,
      });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* schon weg */ }
      }, timeoutMs);
    }
    child.once('error', (err) => finish(null, null, err.message));
    child.once('exit', (code, signal) => finish(code, signal, null));
  });
}

function verdict(r) {
  if (r.error) return `Startfehler: ${r.error}`;
  if (r.timedOut) return 'Timeout';
  if (r.signal) return `Signal ${r.signal}`;
  return `exit ${r.code}`;
}

/**
 * Faehrt die Schritte: der parallele Teil mit `jobs` Plaetzen, danach die
 * SERIAL-Eintraege einzeln. Liefert die Ergebnisse in Kettenreihenfolge.
 */
export async function runSteps(steps, { cwd, logDir, jobs, timeoutMs, serial = SERIAL, onResult = () => {} }) {
  const stale = [...serial.keys()].filter((s) => !steps.includes(s));
  if (stale.length) throw new Error(`SERIAL nennt Schritte, die nicht in der Kette stehen: ${stale.join(', ')}`);

  const items = steps.map((step, index) => ({ step, index }));
  const parallel = items.filter((item) => !serial.has(item.step));
  const alone = items.filter((item) => serial.has(item.step));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (!interrupted && next < parallel.length) {
      const result = await runStep(parallel[next++], { cwd, logDir, timeoutMs });
      results.push(result);
      onResult(result, results.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, worker));
  for (const item of alone) {
    if (interrupted) break;
    const result = await runStep(item, { cwd, logDir, timeoutMs });
    results.push(result);
    onResult(result, results.length);
  }
  return results.sort((a, b) => a.index - b.index);
}

async function main(argv) {
  let opts;
  let loaded;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      console.log('node scripts/run-tests-parallel.mjs [--jobs N] [--logs DIR] [--timeout SEKUNDEN] [--grace SEKUNDEN] [--list] [--package DATEI]');
      return 0;
    }
    loaded = loadSteps(opts.packagePath);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const { steps, cwd } = loaded;
  if (opts.list) {
    for (const step of steps) console.log(step);
    return 0;
  }

  const logDir = opts.logs ?? defaultLogDir();
  if (opts.logs) mkdirSync(logDir, { recursive: true });

  /*
   * EIN ABBRUCH RAEUMT AUF, BEVOR ER ENDET. Die Fassung davor schickte einmal
   * SIGTERM und beendete sich sofort: ein Schritt mit eigenem SIGTERM-Handler
   * lief als Waise weiter (Review auf #1229). Jetzt: kein neuer Schritt,
   * SIGTERM an die Gruppen, warten, nach `--grace` SIGKILL an alles, was noch
   * laeuft, erst dann Exit 130 (SIGINT) bzw. 143 (SIGTERM). Ob etwas laeuft,
   * entscheidet der Prozesszustand, nicht `kill(pid, 0)` - ein Zombie laeuft
   * nicht (scripts/process-state.mjs).
   *
   * EIN ZWEITES SIGNAL ESKALIERT NUR MIT ABSTAND. Ctrl+C unter `npm run
   * test-parallel` kommt zweimal an: vom Terminal an die ganze
   * Vordergrund-Prozessgruppe und noch einmal von npm weitergereicht. Die
   * Fassung davor nahm schon das zweite als "nicht mehr warten": Exit 130 nach
   * 53 ms, der Schritt ohne Karenz getoetet (Review auf #1229). Wer wirklich
   * nicht warten will, drueckt spaeter noch einmal - erst ein Signal mehr als
   * SECOND_SIGNAL_GAP_MS nach dem ersten schickt sofort SIGKILL.
   */
  const SECOND_SIGNAL_GAP_MS = 1000;
  const exitCodes = { SIGINT: 130, SIGTERM: 143 };
  let groups = [];
  let stopping = null;
  let firstSignalAt = 0;
  const signalGroups = (sig) => {
    for (const pgid of groups) {
      try { process.kill(-pgid, sig); } catch { /* Gruppe schon leer */ }
    }
  };
  const waitForGroups = async (ms, step) => {
    for (const deadline = Date.now() + ms; runningGroupMembers(groups).length && Date.now() < deadline;) await pause(step);
    return runningGroupMembers(groups).length;
  };
  const stop = (signal) => {
    if (stopping) {
      if (Date.now() - firstSignalAt <= SECOND_SIGNAL_GAP_MS) return; // dasselbe Ctrl+C, von npm weitergereicht
      console.error('Zweites Signal - SIGKILL an die Gruppen, ohne Karenz');
      signalGroups('SIGKILL');
      process.exit(exitCodes[signal] ?? 130);
    }
    firstSignalAt = Date.now();
    interrupted = true;
    groups = [...running].map((child) => child.pid);
    stopping = (async () => {
      console.error(`\nAbbruch (${signal}) - SIGTERM an ${groups.length} Prozessgruppe(n), Logs in ${logDir}`);
      signalGroups('SIGTERM');
      if (await waitForGroups(opts.grace * 1000, 100)) {
        console.error(`Nach ${opts.grace} s laeuft noch etwas - SIGKILL an die Gruppen`);
        signalGroups('SIGKILL');
        await waitForGroups(2000, 50);
      }
      process.exit(exitCodes[signal] ?? 130);
    })();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(`${steps.length} Schritte, ${opts.jobs} Jobs, Logs in ${logDir}`);
  const width = String(steps.length).length;
  const started = performance.now();
  let results;
  try {
    results = await runSteps(steps, {
      cwd,
      logDir,
      jobs: opts.jobs,
      timeoutMs: opts.timeout * 1000,
      onResult: (r, done) => {
        const mark = r.ok ? 'ok  ' : 'ROT ';
        console.log(`[${String(done).padStart(width)}/${steps.length}] ${mark} ${fmt(r.ms).padStart(7)}  ${r.step}${r.ok ? '' : `  (${verdict(r)})`}`);
      },
    });
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  // Nach einem Abbruch endet der Prozess in `stop`, nicht mit einer Zusammenfassung ueber halbe Ergebnisse.
  if (stopping) await stopping;
  const wall = performance.now() - started;

  const red = results.filter((r) => !r.ok);
  const sum = results.reduce((acc, r) => acc + r.ms, 0);
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
  writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify({
    jobs: opts.jobs,
    wallMs: Math.round(wall),
    sumMs: Math.round(sum),
    steps: results.map((r) => ({ step: r.step, ok: r.ok, code: r.code, signal: r.signal, timedOut: r.timedOut, ms: Math.round(r.ms), log: r.logPath })),
  }, null, 2)}\n`);

  console.log('');
  console.log(`Langsamste ${slowest.length}:`);
  for (const r of slowest) console.log(`  ${fmt(r.ms).padStart(7)}  ${r.step}`);
  if (red.length) {
    console.log('');
    console.log(`Rot (${red.length}):`);
    for (const r of red) console.log(`  ${r.step}  (${verdict(r)})\n    ${r.logPath}`);
  }
  console.log('');
  console.log(`${results.length} Schritte, ${results.length - red.length} gruen, ${red.length} rot - ${opts.jobs} Jobs, Dauer ${fmt(wall)} (Summe der Schritte ${fmt(sum)})`);
  console.log(`Logs: ${logDir}`);
  return red.length ? 1 : 0;
}

/**
 * Als Programm gestartet oder nur importiert (von test:parallel-runner)?
 *
 * Beide Seiten ueber `realpathSync`. Der Loader loest `import.meta.url` ueber
 * Symlinks auf, `process.argv[1]` bleibt, wie getippt. Die erste Fassung
 * verglich nur `path.resolve(argv[1])`: ueber einen Symlink gestartet - unter
 * macOS reicht `/tmp` statt `/private/tmp` - endete der Runner mit Exit 0 und
 * ohne Ausgabe, auch bei roter Kette (Review auf #1229).
 */
function startedAsProgram() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsProgram()) {
  process.exitCode = await main(process.argv.slice(2));
}
