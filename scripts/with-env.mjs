#!/usr/bin/env node
/**
 * Modul: Test-Infrastruktur - Umgebungsvariablen ohne Shell-Praefix
 * Zweck: Startet `node` mit gesetzten Umgebungsvariablen, so wie es ein
 *        Praefix in der Shell tut:
 *          node scripts/with-env.mjs DB_PATH=:memory: node --test test/x.js
 *        wirkt wie `DB_PATH=:memory: node --test test/x.js`. Grund: npm faehrt
 *        Scripts unter Windows durch `cmd.exe`, und `cmd.exe` kennt keine
 *        Praefixe - rund fuenfzig test:-Scripts brachen dort mit
 *        "'DB_PATH' is not recognized as an internal or external command" ab,
 *        bevor ein einziger Test lief. Keine Abhaengigkeit, nur Node selbst.
 * Abhaengigkeiten: node:child_process, node:os
 *
 * DIESELBE WIRKUNG WIE DER PRAEFIX. Ein Wert hier ersetzt einen schon
 * gesetzten (wie in der Shell; `--env-file` taete das nicht). Das Kind ist
 * dasselbe Node-Binary (`process.execPath`), mit denselben Argumenten, demselben
 * Arbeitsverzeichnis und geerbtem stdin/stdout/stderr. Sein Exit-Code wird zum
 * eigenen; stirbt es an einem Signal, stirbt dieses Skript am selben, damit npm
 * und `scripts/run-tests-parallel.mjs` dasselbe sehen wie vorher. SIGINT,
 * SIGTERM und SIGHUP reicht es an das Kind weiter (nicht unter Windows, siehe
 * unten). Das Kind bleibt in der
 * Prozessgruppe, ein Abbruch der Gruppe trifft beide.
 * Der Preis: ein Node-Prozess mehr je Suite, rund 50 ms.
 *
 * NUR `node`. Ein anderes Kommando lehnt das Skript ab, statt es ueber PATH zu
 * suchen - mehr braucht die Kette nicht, und unter Windows hiesse PATH-Suche
 * wieder `cmd.exe`-Regeln. Namen nur in Grossbuchstaben, Ziffern und `_`.
 *
 * Aufruf:  node scripts/with-env.mjs NAME=wert [NAME=wert ...] node [Argumente ...]
 * Exit 2 = Aufruffehler, sonst der Exit-Code des Kindes.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const USAGE = 'Aufruf: node scripts/with-env.mjs NAME=wert [NAME=wert ...] node [Argumente ...]';
const ASSIGNMENT = /^([^=]*)=(.*)$/s;
const NAME = /^[A-Z_][A-Z0-9_]*$/;
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'].filter((signal) => signal in os.constants.signals);

function usage(message) {
  console.error(`with-env: ${message}\n${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const env = {};
let i = 0;
for (; i < argv.length; i += 1) {
  const match = ASSIGNMENT.exec(argv[i]);
  if (!match) break;
  if (!NAME.test(match[1])) usage(`ungueltiger Name '${match[1]}' in '${argv[i]}'`);
  env[match[1]] = match[2];
}
if (i === 0) usage('mindestens eine Zuweisung NAME=wert vor dem Kommando');
if (i === argv.length) usage('Kommando fehlt');
if (argv[i] !== 'node') usage(`nur 'node' als Kommando, nicht '${argv[i]}'`);

Object.assign(process.env, env);
const child = spawn(process.execPath, argv.slice(i + 1), { stdio: 'inherit', env: process.env });

// Unter Windows erreicht Strg+C das Kind ueber die Konsole ohnehin, und
// `child.kill` hiesse dort TerminateProcess - das schnitte die Zusammenfassung
// von `node --test` ab. Dort wartet das Skript nur auf das Kind.
const forward = process.platform === 'win32' ? () => {} : (signal) => { child.kill(signal); };
for (const signal of FORWARDED) process.on(signal, forward);

child.once('error', (err) => {
  console.error(`with-env: ${err.message}`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) {
    for (const s of FORWARDED) process.off(s, forward);
    process.kill(process.pid, signal);
    // Nur falls das Signal hier nicht toetet: der Code, den eine Shell dafuer meldet.
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 1);
});
