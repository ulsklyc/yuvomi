/**
 * Modul: Image-Entrypoint - User-Wechsel (#2380)
 * Zweck: Der Entrypoint wechselt mit setpriv zum node-User, nicht mit gosu.
 *        gosu 1.14 hing unter no-new-privileges (Podman Quadlet
 *        `NoNewPrivileges=true`, crun) als root bei 100 % CPU und kam nie beim
 *        exec an - gehaertete Installationen starteten den Server nie.
 *        setpriv aus util-linux wechselt auch dann, laesst aber HOME stehen.
 *        Drei Proben:
 *          1. Als root gestartet: Volumes werden gechownt, dann laeuft der
 *             Befehl ueber setpriv als node mit dessen HOME - gosu wird nicht
 *             aufgerufen.
 *          2. Als non-root gestartet: kein chown, kein User-Wechsel, der
 *             Befehl laeuft direkt.
 *          3. Die Runtime-Stage des Dockerfiles installiert kein gosu mehr
 *             und prueft beim Build, dass setpriv da ist.
 *        Proben 1 und 2 fahren das echte entrypoint.sh mit Attrappen fuer id,
 *        chown, getent, setpriv und gosu im PATH - root wird dafuer nicht
 *        gebraucht. Ob setpriv unter no-new-privileges wirklich wechselt,
 *        zeigt nur ein Container-Lauf (siehe #2380), nicht diese Suite.
 * Ausfuehren: node --test test/test-entrypoint.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRYPOINT = join(ROOT, 'entrypoint.sh');

/**
 * Faehrt entrypoint.sh mit Attrappen. `uid` ist, was `id -u` meldet. Jede
 * Attrappe schreibt ihren Aufruf in log.txt; setpriv fuehrt den Befehl hinter
 * `--` danach wirklich aus, gosu bricht ab.
 */
function runEntrypoint(uid) {
  const dir = tempDir('yuvomi-entrypoint-');
  const bin = join(dir, 'bin');
  const docs = join(dir, 'documents');
  const log = join(dir, 'log.txt');
  mkdirSync(bin);
  mkdirSync(docs);
  writeFileSync(log, '');

  const stub = (name, body) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('id', `[ "$1" = "-u" ] && echo ${uid} && exit 0\nexit 1`);
  stub('chown', `echo "chown $*" >> "${log}"`);
  stub('getent', `[ "$1 $2" = "passwd node" ] && echo 'node:x:1000:1000::/home/node:/bin/bash'`);
  stub('setpriv', [
    `echo "setpriv $*" >> "${log}"`,
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    'shift',
    'exec "$@"',
  ].join('\n'));
  stub('gosu', `echo "gosu $*" >> "${log}"\nexit 99`);

  const result = spawnSync('sh', [ENTRYPOINT, 'sh', '-c', 'echo "cmd HOME=$HOME" >> "$LOG"'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: '/root',
      LOG: log,
      DOCUMENT_STORAGE_LOCAL_PATH: docs,
    },
  });
  return { result, docs, lines: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('started as root, the entrypoint chowns the volumes and drops to node with setpriv', () => {
  const { result, docs, lines } = runEntrypoint(0);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!lines.some((l) => l.startsWith('gosu ')), 'gosu must not be called');
  assert.deepEqual(lines, [
    'chown -R node:node /data /backups /app/modules',
    `chown -R node:node ${docs}`,
    'setpriv --reuid=node --regid=node --init-groups -- sh -c echo "cmd HOME=$HOME" >> "$LOG"',
    // gosu setzte HOME auf das Home des Ziel-Users, setpriv nicht - der
    // Entrypoint muss es selbst tun, sonst saehe der Server /root.
    'cmd HOME=/home/node',
  ]);
});

test('started as non-root, the entrypoint runs the command directly', () => {
  const { result, lines } = runEntrypoint(1000);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines, ['cmd HOME=/root']);
});

test('the runtime image does not install gosu and checks for setpriv at build time', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1)
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(runtimeStage, /\bgosu\b/, 'the runtime stage must not install gosu');
  assert.match(runtimeStage, /^RUN setpriv --version$/m, 'the build must fail if setpriv is missing');
});
