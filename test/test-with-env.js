/**
 * Modul: Test-Infrastruktur - Umgebungsvariablen ohne Shell-Praefix
 * Zweck: Die test:-Scripts starten auch dort, wo npm sie durch `cmd.exe`
 *        faehrt (Windows). `cmd.exe` kennt keine Praefixe wie
 *        `DB_PATH=:memory: node ...`; rund fuenfzig Scripts brachen deshalb ab,
 *        bevor ein Test lief. Sie setzen ihre Variablen jetzt ueber
 *        scripts/with-env.mjs. Zwei Proben:
 *          1. Kein Schritt eines test-Scripts beginnt mit einer nackten
 *             Zuweisung - sonst ist der Bruch unter Windows wieder da.
 *          2. Der Starter wirkt wie der Praefix: er ersetzt einen schon
 *             gesetzten Wert, gibt den Exit-Code des Kindes weiter (unter
 *             POSIX auch dessen Signal) und lehnt alles ausser `node` ab.
 * Ausfuehren: node --test test/test-with-env.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../scripts/with-env.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const launch = (args, env = {}) => spawnSync(process.execPath, [LAUNCHER, ...args], {
  env: { ...process.env, ...env },
  encoding: 'utf8',
});

test('kein Schritt eines test-Scripts beginnt mit NAME=wert', () => {
  const bare = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name !== 'test' && !name.startsWith('test:')) continue;
    for (const step of command.split('&&').map((s) => s.trim())) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(step)) bare.push(`${name}: ${step}`);
    }
  }
  assert.deepEqual(bare, [],
    'cmd.exe (npm unter Windows) kennt keine Env-Praefixe. Statt `DB_PATH=:memory: node ...` '
    + `schreiben: \`node scripts/with-env.mjs DB_PATH=:memory: node ...\`\n  ${bare.join('\n  ')}`);
  // Reichweite: die Kette nutzt den Starter wirklich, sonst prueft die Probe darueber nichts.
  assert.match(pkg.scripts['test:ncb'], /^node scripts\/with-env\.mjs DB_PATH=:memory: node /);
});

test('der Starter ersetzt einen gesetzten Wert, wie der Praefix in der Shell', () => {
  const run = launch(
    ['YUVOMI_WITH_ENV_PROBE=neu', 'TZ=America/Chicago', 'node', '-e',
      'process.stdout.write(process.env.YUVOMI_WITH_ENV_PROBE + " " + Intl.DateTimeFormat().resolvedOptions().timeZone)'],
    { YUVOMI_WITH_ENV_PROBE: 'alt', TZ: 'UTC' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'neu America/Chicago');
});

test('der Starter gibt den Exit-Code des Kindes weiter', () => {
  assert.equal(launch(['A=1', 'node', '-e', 'process.exit(7)']).status, 7);
  assert.equal(launch(['A=1', 'node', '-e', '']).status, 0);
});

test('der Starter stirbt am Signal des Kindes', { skip: process.platform === 'win32' && 'POSIX-Signale' }, () => {
  const run = launch(['A=1', 'node', '-e', 'process.kill(process.pid, "SIGTERM")']);
  assert.equal(run.signal, 'SIGTERM');
  assert.equal(run.status, null);
});

test('der Starter lehnt einen falschen Aufruf mit Exit 2 ab', () => {
  for (const [args, message] of [
    [['A=1', 'sh', '-c', 'true'], /nur 'node'/],
    [['node', '-e', ''], /mindestens eine Zuweisung/],
    [['A=1'], /Kommando fehlt/],
    [['a-b=1', 'node', '-e', ''], /ungueltiger Name/],
  ]) {
    const run = launch(args);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.match(run.stderr, message, JSON.stringify(args));
  }
});
