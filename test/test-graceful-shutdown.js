/**
 * Test-Suite: Der Server endet auf SIGTERM und SIGINT von selbst und sauber.
 *
 * Im Container laeuft `node server/index.js` als PID 1 (der Entrypoint
 * `exec`t direkt). Fuer PID 1 ignoriert Linux jedes Signal ohne Handler - und
 * es gab keinen. `docker stop` und `podman stop` warteten deshalb jedes Mal
 * ihre zehn Sekunden ab und schickten dann SIGKILL ("StopSignal SIGTERM failed
 * to stop container ... resorting to SIGKILL"). Laufende Anfragen, Syncs und
 * Backups wurden hart abgebrochen, und das Write-Ahead-Log blieb liegen.
 *
 * Gemessen an einem echten Prozess (server/index.js als Kind):
 *   - Er endet nach dem Signal von SELBST mit Code 0, nicht durch das Signal
 *     und nicht erst nach einer Frist - auch mit einer offenen
 *     Keep-alive-Verbindung, wie sie jeder Browser haelt.
 *   - Danach liegt kein `-wal` neben der Datenbank: die Verbindung wurde
 *     geschlossen, das Journal ist in der Hauptdatei.
 *
 * Ausserhalb eines Containers ist der Prozess nicht PID 1; dort beendete das
 * Signal ihn bisher sofort - als Signaltod, ohne Schliessen. Genau das sieht
 * dieser Test gegen den alten Stand: `signal = SIGTERM` statt Code 0, und das
 * Journal liegt noch da.
 *
 * Nur POSIX: unter Windows beendet `child.kill()` den Prozess hart, ein
 * Handler kommt nie zum Zug.
 *
 * Lauf: npm run test:graceful-shutdown
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-dir.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'server', 'index.js');
const NUR_POSIX = process.platform === 'win32' && 'nur POSIX: unter Windows gibt es kein SIGTERM, das ein Handler faengt';

/** Weit unter den zehn Sekunden, nach denen Docker und Podman SIGKILL schicken. */
const EXIT_LIMIT_MS = 5_000;

const children = new Set();
after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function startServer(dbPath) {
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-graceful-shutdown-secret-min-32-chars',
    SESSION_SECURE: 'false',
    PORT: '0',
    BIND_ADDRESS: '127.0.0.1',
    BACKUP_ENABLED: 'false',
  };
  delete env.DB_ENCRYPTION_KEY;
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const listening = new Promise((resolve, reject) => {
    const check = () => {
      const port = output.match(/Server running on port (\d+)/)?.[1];
      if (port) resolve(Number(port));
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    exited.then(({ code, signal }) => reject(
      new Error(`Server endete vor dem Start (code ${code}, signal ${signal}):\n${output}`)
    ));
  });
  return { child, exited, listening, get output() { return output; } };
}

/** Eine Anfrage ueber eine Keep-alive-Verbindung, die danach offen bleibt. */
function getKeptAlive(port, agent) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal}: der Server schliesst die Datenbank und endet von selbst mit Code 0`, { skip: NUR_POSIX }, async () => {
    const dbPath = join(tempDir('yuvomi-test-shutdown-'), 'yuvomi.db');
    const server = startServer(dbPath);
    const port = await server.listening;

    const agent = new http.Agent({ keepAlive: true });
    try {
      assert.equal(await getKeptAlive(port, agent), 200);
      assert.ok(existsSync(`${dbPath}-wal`), 'Vorbedingung: die laufende Datenbank fuehrt ein Journal');

      const sentAt = Date.now();
      server.child.kill(signal);
      let timer;
      const result = await Promise.race([
        server.exited,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), EXIT_LIMIT_MS); }),
      ]);
      clearTimeout(timer);

      assert.ok(result, `Der Server lief ${EXIT_LIMIT_MS} ms nach ${signal} noch.\n${server.output}`);
      assert.deepEqual(result, { code: 0, signal: null },
        `Erwartet: Ende von selbst mit Code 0, nicht durch ${signal}.\n${server.output}`);
      assert.match(server.output, new RegExp(`${signal} received`));
      assert.ok(Date.now() - sentAt < EXIT_LIMIT_MS);
      assert.ok(!existsSync(`${dbPath}-wal`),
        `Nach dem Ende liegt noch ${dbPath}-wal - die Verbindung wurde nicht geschlossen.\n${server.output}`);
    } finally {
      agent.destroy();
    }
  });
}
