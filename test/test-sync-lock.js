/**
 * Test: ein Durchgang je Provider (#593)
 * Zweck: Der Sofortversuch hinter jeder Schreibroute und der Sync-Lauf des
 *        Schedulers führen dieselbe ausgehende Buchhaltung und laufen beide über
 *        Netzaufrufe. Vor dieser Sperre konnten sie einander zwischen zwei awaits
 *        den Zustand abräumen - ein zweiter Flush verwarf den Tombstone, an dem
 *        ein laufender Umzug erkennt, dass der Nutzer gelöscht hat.
 *
 *        Geprüft wird die Regel selbst, nicht ihre Anwendung: dass unter einem
 *        Schlüssel nie zwei Durchgänge gleichzeitig laufen, dass Wartende zu
 *        EINEM Nachlauf je Art zusammenfallen (sonst stapelt jede Bearbeitung
 *        während eines langsamen Laufs einen eigenen), dass die Vormerkung mit
 *        dem Beginn des Nachlaufs fällt und dass ein Fehler den Schlüssel wieder
 *        freigibt.
 *
 *        Netz-frei und ohne Datenbank: die Durchgänge sind steuerbare Promises.
 * Ausführen: node --test test/test-sync-lock.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runSerialized, __test as lock } from '../server/utils/sync-lock.js';

/** Ein Promise, dessen Ende der Test bestimmt - der Ersatz für den Netzaufruf. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Dem Event-Loop Luft geben, damit angestoßene Durchgänge wirklich starten. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => lock.reset());

test('zwei Durchgänge unter demselben Schlüssel überlappen nicht', async () => {
  const first = deferred();
  const order = [];

  const a = runSerialized('caldav', 'flush', async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
    return 'a';
  });
  const b = runSerialized('caldav', 'sync', async () => {
    order.push('b:start');
    return 'b';
  });

  await tick();
  assert.deepEqual(order, ['a:start'], 'der zweite wartet, solange der erste hängt');

  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
});

test('mehrere Sofortversuche während eines Laufs ergeben EINEN Nachlauf', async () => {
  const first = deferred();
  let runs = 0;

  const running = runSerialized('caldav', 'flush', async () => {
    runs++;
    await first.promise;
    return 'erster';
  });
  await tick();

  // Drei Bearbeitungen während des laufenden Durchgangs.
  const waiting = [
    runSerialized('caldav', 'flush', async () => { runs++; return 'nachlauf'; }),
    runSerialized('caldav', 'flush', async () => { runs++; return 'nie'; }),
    runSerialized('caldav', 'flush', async () => { runs++; return 'nie'; }),
  ];

  first.resolve();
  assert.equal(await running, 'erster');
  assert.deepEqual(await Promise.all(waiting), ['nachlauf', 'nachlauf', 'nachlauf'],
    'alle drei bekommen das Ergebnis desselben Nachlaufs');
  assert.equal(runs, 2, 'ein laufender und genau ein nachlaufender Durchgang');
});

test('die Vormerkung fällt, sobald der Nachlauf beginnt', async () => {
  const first  = deferred();
  const second = deferred();
  let runs = 0;

  const running = runSerialized('caldav', 'flush', async () => {
    runs++;
    await first.promise;
  });
  await tick();

  const queued = runSerialized('caldav', 'flush', async () => {
    runs++;
    await second.promise;
  });
  first.resolve();
  await tick();

  // Jetzt läuft der Nachlauf. Eine Bearbeitung, die JETZT eintrifft, meint Arbeit,
  // die er schon gelesen haben kann - sie braucht einen eigenen Durchgang.
  const third = runSerialized('caldav', 'flush', async () => { runs++; });
  second.resolve();
  await Promise.all([running, queued, third]);

  assert.equal(runs, 3);
});

test('Sync und Sofortversuch merken getrennt vor', async () => {
  const first = deferred();

  const running = runSerialized('caldav', 'flush', async () => {
    await first.promise;
    return 'laufend';
  });
  await tick();

  const flush = runSerialized('caldav', 'flush', async () => ({ deleted: 1, updated: 0 }));
  const sync  = runSerialized('caldav', 'sync',  async () => ({ success: true, syncedEvents: 7 }));

  first.resolve();
  await running;
  // Ohne getrennte Vormerkung bekäme der Knopf "Jetzt synchronisieren" das
  // Ergebnis eines Sofortversuchs zurück.
  assert.deepEqual(await flush, { deleted: 1, updated: 0 });
  assert.deepEqual(await sync,  { success: true, syncedEvents: 7 });
});

test('verschiedene Schlüssel laufen nebeneinander', async () => {
  const caldav = deferred();
  let appleRan = false;

  const a = runSerialized('caldav', 'sync', async () => { await caldav.promise; });
  const b = runSerialized('apple',  'sync', async () => { appleRan = true; });

  await tick();
  assert.equal(appleRan, true, 'ein hängendes CalDAV-Konto blockiert Apple nicht');

  caldav.resolve();
  await Promise.all([a, b]);
});

test('ein gescheiterter Durchgang gibt den Schlüssel frei', async () => {
  const failing = runSerialized('caldav', 'sync', async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(failing, /ECONNREFUSED/);

  assert.equal(await runSerialized('caldav', 'sync', async () => 'danach'), 'danach');
});

test('der Fehler eines Nachlaufs erreicht alle seine Wartenden', async () => {
  const first = deferred();
  const running = runSerialized('caldav', 'flush', async () => { await first.promise; });
  await tick();

  const waiting = [
    runSerialized('caldav', 'flush', async () => { throw new Error('kaputt'); }),
    runSerialized('caldav', 'flush', async () => 'nie'),
  ];

  first.resolve();
  await running;
  for (const p of waiting) await assert.rejects(p, /kaputt/);
});

test('nach dem letzten Durchgang bleibt kein Schlüssel stehen', async () => {
  await runSerialized('caldav', 'sync', async () => 'fertig');
  await assert.rejects(runSerialized('apple', 'flush', async () => { throw new Error('x'); }), /x/);

  // Ohne das Aufräumen wüchse die Map mit jedem je benutzten Schlüssel - hier
  // wenige, in einem Prozess mit Konten- und Artenkombinationen mehr.
  assert.equal(lock.size(), 0);
});
