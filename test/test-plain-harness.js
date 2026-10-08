/**
 * Modul: Der handgeschriebene test()-Lauf wartet einen async-Rumpf ab (#1783)
 * Zweck: `test/test-calendar.js` rief `fn()` und wartete nicht. Ein Test mit
 *        `async`-Rumpf zaehlte als bestanden, sobald er sein Promise
 *        zurueckgab. Gemessen am alten Lauf: scheitert der Rumpf nach dem
 *        ersten `await`, steht "✓" und "1 bestanden, 0 fehlgeschlagen" da und
 *        der Prozess stirbt danach an der unbehandelten Rejection (rot, aber
 *        als Absturz mit falschem Bericht); wird der Rumpf nie fertig, ist der
 *        Lauf GRUEN mit Exit 0. Geprueft wird der Lauf selbst (test/plain-harness.js), einmal
 *        als Programm mit Exit-Code, und dass test-calendar.js ihn benutzt.
 *        Dazu die Sperre fuer die uebrigen Suiten derselben Bauart: wer sein
 *        eigenes, nicht wartendes `test(name, fn)` mitbringt, uebergibt ihm
 *        keinen async-Rumpf.
 * Ausfuehren: npm run test:plain-harness
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from './plain-harness.js';
import { tempDir } from './tmp-dir.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function quietHarness() {
  const lines = [];
  const harness = createHarness('Probe', { log: (line) => lines.push(line), error: (line) => lines.push(line) });
  return { ...harness, lines };
}

const later = (fn) => new Promise((resolve, reject) => {
  setImmediate(() => { try { resolve(fn()); } catch (err) { reject(err); } });
});

test('ein async-Rumpf, der nach dem ersten await scheitert, zaehlt als fehlgeschlagen', async () => {
  const { test: run, finish, lines } = quietHarness();
  run('scheitert spaet', async () => {
    await later(() => {});
    throw new Error('zu spaet gemerkt');
  });
  // Vor dem Abwarten ist nichts entschieden - genau hier stand frueher schon ein Haken.
  assert.deepEqual(lines, [], 'der Test darf nicht zaehlen, bevor sein Rumpf durch ist');
  assert.deepEqual(await finish(), { passed: 0, failed: 1 });
  assert.ok(lines.includes('  ✗ scheitert spaet: zu spaet gemerkt'), lines.join('|'));
});

test('ein async-Rumpf, der durchlaeuft, zaehlt erst danach als bestanden', async () => {
  const { test: run, finish, lines } = quietHarness();
  let done = false;
  const waiting = run('laeuft durch', async () => { await later(() => {}); done = true; });
  assert.equal(typeof waiting?.then, 'function', 'test() gibt das Warten zurueck');
  assert.deepEqual(lines, []);
  await waiting;
  assert.equal(done, true);
  assert.deepEqual(lines, ['  ✓ laeuft durch']);
  assert.deepEqual(await finish(), { passed: 1, failed: 0 });
});

test('ein synchroner Rumpf laeuft sofort und an seiner Stelle', async () => {
  const { test: run, finish, lines } = quietHarness();
  const order = [];
  assert.equal(run('eins', () => { order.push(1); }), undefined);
  order.push('dazwischen');
  run('zwei', () => { order.push(2); throw new Error('kaputt'); });
  run('drei', () => { order.push(3); });
  assert.deepEqual(order, [1, 'dazwischen', 2, 3]);
  assert.deepEqual(lines, ['  ✓ eins', '  ✗ zwei: kaputt', '  ✓ drei']);
  assert.deepEqual(await finish(), { passed: 2, failed: 1 });
});

test('finish() wartet auf alles, was noch laeuft - auch auf nachgemeldete Tests', async () => {
  const { test: run, finish } = quietHarness();
  run('meldet einen zweiten an', async () => {
    await later(() => {});
    run('der zweite', async () => { await later(() => {}); throw new Error('auch der zaehlt'); });
  });
  run('ein Thenable genuegt', () => ({ then: (_ok, no) => no(new Error('abgelehnt')) }));
  assert.deepEqual(await finish(), { passed: 1, failed: 2 });
});

test('als Programm: ein spaet scheiternder async-Test macht den Lauf rot (Exit 1)', () => {
  // tempDir() raeumt beim Prozessende weg (test/tmp-dir.js, test:tmp-clean).
  const dir = tempDir('yuvomi-plain-harness-');
  {
    const harnessUrl = pathToFileURL(join(TEST_DIR, 'plain-harness.js')).href;
    // Derselbe Fuss wie in test-calendar.js.
    const program = (body) => `import { createHarness } from ${JSON.stringify(harnessUrl)};
const { test, finish } = createHarness('Probe');
test('synchron gruen', () => {});
${body}
const { failed } = await finish();
if (failed > 0) process.exit(1);
`;
    const run = (name, body) => {
      const file = join(dir, name);
      writeFileSync(file, program(body));
      return spawnSync(process.execPath, [file], { encoding: 'utf8' });
    };
    const red = run('red.mjs', "test('scheitert spaet', async () => { await new Promise((r) => setImmediate(r)); throw new Error('zu spaet'); });");
    assert.equal(red.status, 1, `stdout: ${red.stdout}\nstderr: ${red.stderr}`);
    assert.match(red.stderr, /✗ scheitert spaet: zu spaet/);
    assert.match(red.stdout, /1 bestanden, 1 fehlgeschlagen/);
    assert.doesNotMatch(red.stderr, /unhandled/i, 'die Rejection ist behandelt, nicht nur zufaellig toedlich');

    // Gegenprobe: derselbe Lauf mit einem async-Test, der haelt, ist gruen.
    const green = run('green.mjs', "test('laeuft durch', async () => { await new Promise((r) => setImmediate(r)); });");
    assert.equal(green.status, 0, `stdout: ${green.stdout}\nstderr: ${green.stderr}`);
    assert.match(green.stdout, /2 bestanden, 0 fehlgeschlagen/);

    // Ein Rumpf, der NIE fertig wird, war der gruene Fall des alten Laufs
    // ("✓", Exit 0). Jetzt wartet finish() auf ihn; Node beendet einen Lauf
    // mit offenem Top-Level-await mit Exit 13, und eine Ergebniszeile, die
    // "bestanden" behauptet, gibt es nicht.
    const hang = run('hang.mjs', "test('wird nie fertig', async () => { await new Promise(() => {}); });");
    assert.notEqual(hang.status, 0, `stdout: ${hang.stdout}\nstderr: ${hang.stderr}`);
    assert.doesNotMatch(hang.stdout, /wird nie fertig|bestanden/);
    assert.match(hang.stderr, /✗ wird nie fertig: der async-Rumpf ist nie fertig geworden/, 'der Lauf nennt den Test, der haengt');
  }
});

test('test-calendar.js benutzt den geteilten Lauf und wartet am Ende auf ihn', () => {
  const source = readFileSync(join(TEST_DIR, 'test-calendar.js'), 'utf8');
  assert.doesNotMatch(source, /^(?:async )?function test\(/m, 'kein eigenes test() mehr');
  assert.match(source, /^import \{ createHarness \} from '\.\/plain-harness\.js';$/m);
  assert.match(source, /^const \{ test, finish \} = createHarness\('Calendar-Test'\);$/m);
  assert.match(source, /\nconst \{ failed \} = await finish\(\);\nif \(failed > 0\) process\.exit\(1\);\s*$/, 'das Ergebnis wartet auf laufende Tests');
});

/* DIE UEBRIGEN SUITEN DERSELBEN BAUART. Wer sein eigenes `function test(name,
 * fn)` mitbringt und darin nicht wartet, darf ihm keinen async-Rumpf geben -
 * der waere gruen, ohne zu messen. Ein Lauf, der wartet (`await fn()` oder
 * `.then(fn)`, wie in test-dashboard.js), ist ausgenommen. */
const NAME = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\]|\\\\.)*`' + String.raw`|[\w.$]+)`;
const ASYNC_BODY = new RegExp(String.raw`(?<![.\w$])test\(\s*${NAME}\s*,\s*async\b`, 'g');
const HARNESS = /^(async )?function test\(name, fn\) \{\n([\s\S]*?)\n\}/m;

function handWrittenHarness(source) {
  const match = HARNESS.exec(source);
  if (!match) return null;
  return { waits: /await fn\(\)|\.then\(fn\)/.test(match[2]) };
}

test('die Sperre erkennt, was sie sucht', () => {
  const sync = "function test(name, fn) {\n  try { fn(); passed++; }\n  catch (err) { failed++; }\n}\n";
  assert.deepEqual(handWrittenHarness(sync), { waits: false });
  assert.deepEqual(handWrittenHarness("async function test(name, fn) {\n  try { await fn(); } catch {}\n}\n"), { waits: true });
  assert.deepEqual(handWrittenHarness("function test(name, fn) {\n  pending.push(Promise.resolve().then(fn));\n}\n"), { waits: true });
  assert.equal(handWrittenHarness("import test from 'node:test';\n"), null);
  const hits = (text) => (text.match(ASYNC_BODY) ?? []).length;
  assert.equal(hits("test('a', async () => {});"), 1);
  assert.equal(hits("test(\n  `b ${x}`,\n  async function () {});"), 1);
  assert.equal(hits('test(name, async () => {});'), 1);
  // Kein Treffer: synchroner Rumpf, "async" nur im Namen, Methodenaufruf.
  assert.equal(hits("test('laedt, async gemeint', () => {});"), 0);
  assert.equal(hits("regex.test('x', async () => {});"), 0);
  assert.equal(hits("test('c', () => { run(async () => {}); });"), 0);
});

test('keine Suite mit eigenem, nicht wartendem test() uebergibt ihm einen async-Rumpf', () => {
  const offenders = [];
  let syncHarnesses = 0;
  for (const name of readdirSync(TEST_DIR).filter((file) => /^test-.*\.js$/.test(file)).sort()) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8');
    const harness = handWrittenHarness(source);
    if (!harness || harness.waits) continue;
    syncHarnesses += 1;
    const count = (source.match(ASYNC_BODY) ?? []).length;
    if (count) offenders.push(`${name}: ${count}`);
  }
  // Die Sperre hat etwas zu pruefen, solange es solche Suiten gibt; faellt die
  // letzte weg, faellt auch diese Zeile.
  assert.ok(syncHarnesses > 0, 'keine Suite mit eigenem test() gefunden - sucht die Sperre noch das Richtige?');
  assert.deepEqual(offenders, [], 'async-Rumpf an einem test(), das nicht wartet: auf test/plain-harness.js umstellen');
});
