/**
 * Test: Bildabrufe haben einen eigenen Rate-Limit-Topf (#2048)
 * Zweck: Eine Rezeptliste mit 500 gespiegelten Rezepten war ein Bildabruf je
 *        Zeile. Alle zaehlten in den apiLimiter (300 je Minute und Adresse),
 *        und sobald der Topf leer war, antwortete JEDE Route 429 - die App
 *        stand, obwohl nur Vorschaubilder luden. Gemessen am echten
 *        server/index.js:
 *
 *        1. Bildabrufe (Rezeptbild, Providerbild, Profilbild) verbrauchen das
 *           allgemeine Budget nicht.
 *        2. Sie sind trotzdem gedeckelt (imageLimiter), weil jeder ungecachte
 *           Providerbild-Abruf einen Abruf beim Provider ausloest.
 *        3. Das allgemeine Budget greift unveraendert bei 300.
 *
 *        Die Anfragen kommen ohne Sitzung (401): beide Limiter haengen vor der
 *        Anmeldung und zaehlen sie trotzdem, wie im Betrieb.
 *
 * Ausfuehren: npm run test:image-rate-limit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server-ready.js';

const { baseUrl } = await startTestServer({
  name: 'image-rate-limit',
  env: { SESSION_SECRET: 'test-image-rate-limit-secret-min-32-chars' },
});

const IMAGE_PATHS = [
  '/api/v1/recipes/1/provider-thumbnail?v=2026-10-01',
  '/api/v1/recipes/1/image',
  '/api/v1/people/1/avatar?v=0123456789abcdef0123456789abcdef',
];

/** `count` Abrufe in Wellen zu 50, Statuscodes in Reihenfolge. */
async function hit(pathFor, count) {
  const statuses = [];
  for (let i = 0; i < count; i += 50) {
    const wave = [];
    for (let j = i; j < Math.min(count, i + 50); j += 1) {
      wave.push(fetch(`${baseUrl}${pathFor(j)}`).then(async (r) => { await r.arrayBuffer(); return r.status; }));
    }
    statuses.push(...await Promise.all(wave));
  }
  return statuses;
}

// EIN Ablauf, weil beide Toepfe je Prozess und Adresse zaehlen: jeder Schritt
// baut auf dem Zaehlerstand des vorigen auf.
test('#2048 Bildabrufe leeren das allgemeine Budget nicht, sind aber selbst gedeckelt', async () => {
  const image = (i) => IMAGE_PATHS[i % IMAGE_PATHS.length];

  // 1. Ein Schwall Bilder vorweg - vor #2048 waren damit 250 der 300 weg.
  const first = await hit(image, 250);
  assert.equal(first.filter((s) => s === 429).length, 0);

  // 2. Danach hat die App ihr volles Budget, und es ist nicht weicher geworden.
  const api = await hit(() => '/api/v1/meals', 301);
  assert.equal(api.slice(0, 300).filter((s) => s === 429).length, 0,
    'nach dem Bilderschwall antworten die normalen Routen weiter');
  assert.equal(api[300], 429, 'der 301. Abruf einer normalen Route ist wie bisher 429');

  // 3. Nur GET und HEAD zaehlen als Bildabruf: ein Schreibversuch auf einen
  //    Bildpfad bleibt im allgemeinen Topf, der jetzt leer ist.
  const post = await fetch(`${baseUrl}/api/v1/recipes/1/image`, { method: 'POST' });
  assert.equal(post.status, 429, 'POST auf einen Bildpfad zaehlt im allgemeinen Topf');

  // 4. Der Bildtopf ist davon unberuehrt und hat einen Deckel: 1200 je Minute.
  const rest = await hit(image, 960);
  assert.equal(rest.slice(0, 950).filter((s) => s === 429).length, 0, 'die ersten 1200 Bildabrufe kommen durch');
  assert.equal(rest.slice(950).filter((s) => s === 429).length, 10, 'ueber 1200 je Minute greift der imageLimiter');
});
