/**
 * Modul: Test-Infrastruktur - der Exit-Code der Server-Suiten
 * Zweck: Drei Suiten importieren `server/index.js` als PROGRAMM. Sie endeten
 *        mit `process.exit(0)` im `after()`-Hook, weil der Serversocket und
 *        die Scheduler-Timer den Prozess sonst offen hielten. Genau das
 *        ueberschrieb den Exit-Code, den node:test erst beim natuerlichen
 *        Prozessende setzt: gemessen am 09.09.2026 meldete ein Klon von
 *        test-admin-password-reset.js mit falscher Assertion `exit=0`, obwohl
 *        zwei `✖`-Zeilen im Log standen. In der `npm test`-Kette konnten diese
 *        Suiten damit nur ueber einen Top-Level-Fehler rot werden.
 * Ausführen: node --test test/test-suite-exit-code.js
 *
 * WARUM DIESE SUITE EIN PROGRAMM FAEHRT UND NICHT NUR TEXT LIEST.
 *
 * Ein Textguard gegen `process.exit(` haette den alten Zustand gefunden - und
 * nichts davon, ob der Ausweg traegt. Der Ausweg ist kein besserer Exit-Code,
 * sondern das AUFRAEUMEN der Handles: Serversocket geschlossen, Sync-Timer
 * `unref()`, Backup-Cron aus. Faellt eines davon weg, endet der Prozess nicht
 * mehr von selbst - und ein Textguard bliebe gruen, waehrend die Suite haengt.
 * Deshalb laeuft `exit-code-fixture.js` hier zweimal wirklich: gruen muss 0
 * bleiben, rot muss 1 werden, und beide Male muss der Prozess von SELBST
 * enden (kein Signal, kein Timeout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('../test', import.meta.url));

/** Zeitlimit je Fixture-Lauf. Ein Treffer heisst: der Prozess endet nicht. */
const LIMIT_MS = 90_000;

function runFixture(env) {
  const result = spawnSync(process.execPath, ['test/exit-code-fixture.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: LIMIT_MS,
    env: { ...process.env, ...env },
  });

  // Die Fixture raeumt ihre Datei-Datenbank selbst weg - aber nur, wenn sie zu
  // ihrem `exit`-Handler kommt. Schlaegt der Guard an, killt `timeout` sie per
  // SIGTERM, und die Datei bliebe liegen; genau daran hatte das Repo schon
  // einmal 182 verwaiste Dateien (test/tmp-db.js). Der Name steht fest, die
  // PID kennen wir hier.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { unlinkSync(join(tmpdir(), `yuvomi-exit-code-fixture-${result.pid}.db${suffix}`)); }
    catch { /* sauber beendet, also schon weg */ }
  }
  return result;
}

test('eine gruene Server-Suite endet von selbst mit Code 0', () => {
  const run = runFixture({});
  assert.equal(run.signal, null,
    `Die Fixture endete nicht von selbst (Signal ${run.signal}) - ein Handle haelt den Prozess offen.\n${run.stderr}`);
  assert.equal(run.status, 0, `Erwartet 0, erhalten ${run.status}.\n${run.stdout}\n${run.stderr}`);
});

test('eine fehlgeschlagene Assertion macht die Server-Suite rot', () => {
  const run = runFixture({ FIXTURE_EXPECT_STATUS: '999' });
  assert.equal(run.signal, null,
    `Die Fixture endete nicht von selbst (Signal ${run.signal}) - ein Handle haelt den Prozess offen.\n${run.stderr}`);

  // Die Zusicherung MUSS gefallen sein - sonst misst der Exit-Code unten etwas
  // anderes als den fehlgeschlagenen Testblock (z.B. einen Startfehler).
  assert.match(run.stdout, /fail 1/,
    `Die Fixture meldet keinen fehlgeschlagenen Testblock.\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 1,
    `Ein fehlgeschlagener test()-Block muss Code 1 liefern, erhalten ${run.status}. `
    + `Genau so sah der Fehler aus, den diese Suite verhindert.\n${run.stdout}`);
});

/**
 * Der Textguard daneben - er fasst die Regel, nicht den Beweis.
 *
 * Geprueft wird die IMPORT-KANTE, nicht ein Textvorkommen: eine Suite, die
 * `server/index.js` nur als Datei LIEST (rund zwanzig tun das, um Mounts oder
 * Routen nachzuschlagen), startet keinen Server und darf enden, wie sie will.
 */
function startsTheServer(src) {
  const specs = [
    ...src.matchAll(/^\s*import[^;]*from\s*'([^']+)'/gm),
    ...src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
  ].map((m) => m[1]);
  return specs.some((spec) => spec.endsWith('server/index.js') || spec.endsWith('server-ready.js'));
}

test('keine Suite, die den Server startet, beendet den Prozess selbst', () => {
  const offenders = readdirSync(TEST_DIR)
    .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
    .filter((f) => {
      const src = readFileSync(`${TEST_DIR}/${f}`, 'utf8');
      // Der Kommentar in den drei Suiten NENNT `process.exit(0)` als das, was
      // dort nicht mehr steht. Gesucht ist der Aufruf, nicht das Wort.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return startsTheServer(code) && /(?<!\.)\bprocess\.exit\s*\(/.test(code);
    });
  assert.deepEqual(offenders, [],
    'Diese Suiten starten server/index.js und rufen process.exit() - das ueberschreibt den '
    + `Exit-Code von node:test: ${offenders.join(', ')}`);
});

test('die Fixture haengt an dieser Suite und an keiner Kette', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const scripts = Object.values(pkg.scripts).join(' ');
  assert.ok(!scripts.includes('exit-code-fixture'),
    'Die Fixture darf keine eigene Suite sein - sie ist absichtlich zeitweise rot.');

  // Sie muss aber erreichbar bleiben: verschiebt jemand die Datei, laufen die
  // beiden Programmlaeufe oben ins Leere und meldeten trotzdem etwas.
  const src = readFileSync(new URL('./test-suite-exit-code.js', import.meta.url), 'utf8');
  const referenced = src.match(/'test\/(exit-code-fixture\.js)'/)?.[1];
  assert.ok(referenced && readdirSync(TEST_DIR).includes(referenced),
    'test/exit-code-fixture.js fehlt - die Programmlaeufe oben pruefen nichts mehr.');
});

// R23 S11: in test-meals.js stand ein Fall HINTER `if (failed > 0)
// process.exit(1);` - er lief und druckte sein ✗, aber die Suite endete
// trotzdem mit 0. Eigene Zaehl-Harnische (`let failed`, `finish()`) werten
// nur aus, was VOR dieser Zeile registriert ist.
test('kein Fall steht hinter der Auswertung einer Suite mit eigenem Zaehler', () => {
  const offenders = [];
  for (const name of readdirSync(TEST_DIR).filter((n) => /^test-.*\.js$/.test(n))) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8');
    // node:test zaehlt selbst; dort steht die Zeile hoechstens in einer Vorlage.
    if (/from 'node:test'/.test(source)) continue;
    const lines = source.split('\n');
    // Nur die Auswertung auf oberster Ebene (Zeilenanfang), nicht die
    // Programm-Vorlagen in Strings (test-plain-harness.js).
    const last = lines.findLastIndex((line) => /^if \(failed( > 0)?\) process\.exit\(1\);/.test(line));
    if (last < 0) continue;
    const late = lines.slice(last + 1).findIndex((line) => /^(test|run)\(['`]/.test(line));
    if (late >= 0) offenders.push(`${name}:${last + 2 + late}`);
  }
  assert.deepEqual(offenders, []);
});
