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
 * Logs ohne `--logs`: `<tmpdir>/yuvomi-test-parallel/<checkout>-<hash>/run-*`,
 * je Lauf neu, 0700; Laufordner ueber 24 h raeumt der naechste Lauf weg.
 * `--timeout` gilt je Schritt, Default 900 s. `--grace`: so lange wartet ein
 * Abbruch nach SIGTERM, bevor er SIGKILL schickt, Default 5 s.
 * Exit 0 = alle Schritte gruen, 1 = mindestens einer rot, 2 = Aufruf- oder
 * Parserfehler.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
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

const fmt = (ms) => {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

const slug = (step) => step.replace(/^npm run /, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

/** Laufende Prozessgruppen, damit ein Abbruch sie mitnimmt. */
const running = new Set();

/** Nach einem Abbruch startet kein Schritt mehr. */
let interrupted = false;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const RUN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Legt `dir` mit 0700 an und zieht einen vorhandenen eigenen Ordner auf 0700.
 * Die Logs tragen Testausgaben, und unter Linux liegt `/tmp` fuer alle Nutzer
 * offen; mit der umask 022 entstanden Ordner 0755 und Dateien 0644.
 */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  const own = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (own && (stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * Der Logordner eines Laufs ohne `--logs`: `<tmpdir>/yuvomi-test-parallel/
 * <checkout>-<hash>/run-XXXXXX`, je Lauf neu.
 *
 * JE LAUF, NICHT JE CHECKOUT. Die Fassung davor leerte einen festen Ordner je
 * Checkout: ein zweiter Lauf daneben loeschte die Logs des ersten, und beide
 * schrieben ihre summary.json an dieselbe Stelle (Review auf #1229).
 * Aufgeraeumt werden nur Geschwister ueber 24 h - ein laufender Lauf ist
 * frisch, denn jedes neue Log setzt die mtime seines Ordners.
 */
function defaultLogDir(cwd) {
  const checkout = realpathSync(cwd);
  const key = createHash('sha256').update(checkout).digest('hex').slice(0, 8);
  const root = path.join(os.tmpdir(), 'yuvomi-test-parallel');
  const base = path.join(root, `${path.basename(checkout)}-${key}`);
  privateDir(root);
  privateDir(base);
  const now = Date.now();
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const dir = path.join(base, entry.name);
    try {
      if (now - statSync(dir).mtimeMs > RUN_DIR_MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* raeumt gerade ein anderer Lauf weg */ }
  }
  return mkdtempSync(path.join(base, 'run-')); // mkdtemp legt mit 0700 an
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

  const logDir = opts.logs ?? defaultLogDir(cwd);
  if (opts.logs) mkdirSync(logDir, { recursive: true });

  /*
   * EIN ABBRUCH RAEUMT AUF, BEVOR ER ENDET. Die Fassung davor schickte einmal
   * SIGTERM und beendete sich sofort: ein Schritt mit eigenem SIGTERM-Handler
   * lief als Waise weiter (Review auf #1229). Jetzt: kein neuer Schritt,
   * SIGTERM an die Gruppen, warten, nach `--grace` SIGKILL an alles, was noch
   * laeuft, erst dann Exit 130 (SIGINT) bzw. 143 (SIGTERM). Ein zweites Signal
   * wartet nicht mehr. Ob etwas laeuft, entscheidet der Prozesszustand, nicht
   * `kill(pid, 0)` - ein Zombie laeuft nicht (scripts/process-state.mjs).
   */
  const exitCodes = { SIGINT: 130, SIGTERM: 143 };
  let groups = [];
  let stopping = null;
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
      signalGroups('SIGKILL');
      process.exit(exitCodes[signal] ?? 130);
    }
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
