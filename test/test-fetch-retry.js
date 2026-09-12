/**
 * Modul: Test-Infrastruktur - der Wiederholer um `fetch`
 * Zweck: Beweist, dass `fetchRetry()` genau die Ressourcenfehler des Hosts
 *        uebersteht und alles andere unveraendert durchreicht.
 * Ausführen: node --test test/test-fetch-retry.js
 *
 * Der Wert dieser Suite liegt in den NEGATIVEN Faellen. Ein Wiederholer, der
 * zu viel schluckt, macht aus einem echten Fehlschlag einen gruenen Lauf -
 * teurer als die Flakiness, die er beheben soll. Deshalb steht hier neben dem
 * geheilten Fall auch: `ECONNREFUSED` (kein Server) fliegt sofort, ein 500er
 * wird nicht wiederholt, und ein unbekannter Code wird nicht stillschweigend
 * als "voruebergehend" gedeutet.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchRetry } from './fetch-retry.js';

/** Fehler bauen, wie ihn `fetch` liefert: Ursache steckt in `cause`. */
function fetchFehler(code) {
  const cause = new Error(`connect ${code} 127.0.0.1:1`);
  cause.code = code;
  const err = new TypeError('fetch failed');
  err.cause = cause;
  return err;
}

/** `globalThis.fetch` um einen Aufruf herum ersetzen und exakt zuruecklegen. */
async function mitFetch(attrappe, fn) {
  const echt = globalThis.fetch;
  globalThis.fetch = attrappe;
  try { return await fn(); } finally { globalThis.fetch = echt; }
}

test('wiederholt bei EADDRNOTAVAIL und liefert die spaetere Antwort', async () => {
  let aufrufe = 0;
  const antwort = await mitFetch(async () => {
    aufrufe += 1;
    if (aufrufe < 3) throw fetchFehler('EADDRNOTAVAIL');
    return new Response('ok', { status: 200 });
  }, () => fetchRetry('http://127.0.0.1:1/x'));

  assert.equal(aufrufe, 3);
  assert.equal(antwort.status, 200);
});

test('gibt auf, wenn die Portknappheit anhaelt - und meldet den echten Fehler', async () => {
  let aufrufe = 0;
  await assert.rejects(
    () => mitFetch(async () => { aufrufe += 1; throw fetchFehler('EADDRNOTAVAIL'); },
      () => fetchRetry('http://127.0.0.1:1/x', undefined, { versuche: 3 })),
    (err) => err instanceof TypeError && err.cause?.code === 'EADDRNOTAVAIL',
  );
  // Kein endloses Wiederholen: die Zahl der Versuche ist die Zahl der Aufrufe.
  assert.equal(aufrufe, 3);
});

test('ECONNREFUSED wird NICHT wiederholt - das ist ein fehlender Server', async () => {
  let aufrufe = 0;
  await assert.rejects(
    () => mitFetch(async () => { aufrufe += 1; throw fetchFehler('ECONNREFUSED'); },
      () => fetchRetry('http://127.0.0.1:1/x')),
    (err) => err.cause?.code === 'ECONNREFUSED',
  );
  assert.equal(aufrufe, 1);
});

test('ein unbekannter Fehlercode gilt nicht als voruebergehend', async () => {
  let aufrufe = 0;
  await assert.rejects(
    () => mitFetch(async () => { aufrufe += 1; throw fetchFehler('EIRGENDWAS'); },
      () => fetchRetry('http://127.0.0.1:1/x')),
    (err) => err.cause?.code === 'EIRGENDWAS',
  );
  assert.equal(aufrufe, 1);
});

test('eine HTTP-Antwort wird nie wiederholt, auch kein 500er', async () => {
  let aufrufe = 0;
  const antwort = await mitFetch(async () => {
    aufrufe += 1;
    return new Response('kaputt', { status: 500 });
  }, () => fetchRetry('http://127.0.0.1:1/x'));

  assert.equal(aufrufe, 1);
  assert.equal(antwort.status, 500);
});

test('spricht gegen einen echten Server wie fetch - Methode, Kopf und Rumpf kommen an', async () => {
  const empfangen = [];
  const server = http.createServer((req, res) => {
    let rumpf = '';
    req.on('data', (d) => { rumpf += d; });
    req.on('end', () => {
      empfangen.push({ methode: req.method, typ: req.headers['content-type'], rumpf });
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { ok: true } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const res = await fetchRetry(`http://127.0.0.1:${server.address().port}/x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titel: 'T' }),
  });

  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { data: { ok: true } });
  assert.deepEqual(empfangen, [{ methode: 'POST', typ: 'application/json', rumpf: '{"titel":"T"}' }]);
});
