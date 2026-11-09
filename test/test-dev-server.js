/**
 * Modul: `npm run dev` (Phase 1a, Abschnitt D8)
 * Zweck: Vite liefert unter `npm run dev` die Quellen aus public/ und reicht,
 *        was der Express-Server selbst beantwortet, an ihn durch. Zwei Fehler
 *        aus dem Review von #2631:
 *   1. Ein Proxy-Schluessel ist bei Vite ein PRAEFIX: `/api` traf auch die
 *      Fassade `/api.js`, die index.html direkt laedt - Express antwortet im
 *      Dev-Modus mit 404, und die App startete nicht. Jeder Schluessel muss an
 *      einer Pfadgrenze enden und darf keine Datei unter public/ treffen
 *      (Ausnahme mit Grund: /sw.js, die ungebaute Quelle soll nicht ausgeliefert werden).
 *   2. PORT aus .env kam nur beim Server an (`--import dotenv/config`), nicht
 *      bei Vite - der Proxy zielte auf 3000, der Server lief woanders.
 * Ausfuehren: node --test test/test-dev-server.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devProxy } from '../scripts/build/dev-proxy.ts';
import { devEnvironment } from '../scripts/dev.mjs';
import { sourceFiles } from '../scripts/build/vite-plugins.ts';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Wie Vite einen Proxy-Schluessel liest (vite/src/node/server/middlewares/proxy.ts):
 * beginnt er mit `^`, ist er ein regulaerer Ausdruck gegen die URL, sonst ein Praefix.
 * @param {string} key
 * @param {string} url
 */
const viteMatches = (key, url) => (key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key));

test('jeder Proxy-Schluessel trifft die Server-Pfade und keine Datei unter public/', () => {
  const keys = Object.keys(devProxy(3000));
  assert.ok(keys.length >= 9, `nur ${keys.length} Schluessel`);
  const proxied = (/** @type {string} */ url) => keys.some((key) => viteMatches(key, url));
  for (const url of ['/api', '/api/v1/version', '/api/v1/modules/assets/x/index.js?v=1', '/auth/oidc/callback', '/sw.js', '/sw.js?v=2',
    '/openapi.json', '/docs', '/docs/', '/modules/x', '/feed/calendar/abc.ics', '/mcp', '/manifest.webmanifest']) {
    assert.ok(proxied(url), `${url} geht nicht an den Server`);
  }
  // Seiten der App liefert Vite (appType spa), auch /health mit HTML-Accept.
  for (const url of ['/', '/calendar', '/health', '/settings', '/m/beispiel', '/apix', '/feeds', '/documents']) {
    assert.ok(!proxied(url), `${url} ginge an den Server statt an Vite`);
  }
  const DELIBERATE = new Set(['/sw.js']);
  const hits = sourceFiles(PUBLIC).map((rel) => `/${rel}`).filter((url) => !DELIBERATE.has(url) && proxied(url));
  assert.deepEqual(hits, [], 'diese Dateien aus public/ (Fassaden, Startskripte) gingen an den Server, der unter npm run dev 404 antwortet');
  for (const facade of ['/api.js', '/i18n.js', '/utils/html.js']) assert.ok(!proxied(facade), facade);
});

test('der Proxy zielt auf den PORT des Servers', () => {
  for (const [, rule] of Object.entries(devProxy(4321))) assert.equal(/** @type {{ target: string }} */ (rule).target, 'http://localhost:4321');
});

test('PORT aus .env erreicht beide Prozesse, eine gesetzte Umgebung gewinnt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yuvomi-dev-env-'));
  try {
    writeFileSync(path.join(dir, '.env'), 'PORT=4321\nOTHER=x\n');
    assert.equal(devEnvironment(dir, {}).PORT, '4321');
    assert.equal(devEnvironment(dir, { PORT: '5000' }).PORT, '5000', 'die Shell ueberstimmt .env wie bei dotenv');
    rmSync(path.join(dir, '.env'));
    assert.equal(devEnvironment(dir, {}).PORT, '3000', 'ohne .env der Standard des Servers');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
