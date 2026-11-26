/**
 * Test: Benachrichtigungs-Badge (Statusleiste von Android)
 * Zweck: Android behaelt vom `badge` einer Benachrichtigung nur den Alphakanal
 *        und faerbt ihn einfarbig. Das App-Icon (bunte Kachel mit runden Ecken,
 *        fast ueberall deckend) wurde dort zum weissen Quadrat. Das Badge ist
 *        deshalb ein eigenes Bild: nur die drei Kreise der Marke, weiss auf
 *        transparentem Grund, 96x96. Dieser Test haelt fest, dass der
 *        Service Worker dieses Bild als Badge nimmt (und nicht wieder das
 *        App-Icon) und dass das Bild die Form behaelt, die Android braucht.
 * Ausführen: node --test test/test-notification-badge.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'public', 'icons');
const BADGE_URL = '/icons/badge-96.png';
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

/**
 * Laesst einen Push durch den ECHTEN Service Worker laufen (node:vm, die
 * Browser-APIs als Attrappen) und liefert die Optionen, mit denen er
 * `showNotification` aufruft.
 */
async function shownOptions() {
  /** @type {any[]} */
  const shown = [];
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  const self = {
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) { (listeners[type] ||= []).push(fn); },
    skipWaiting() { return Promise.resolve(); },
    clients: { claim() { return Promise.resolve(); }, matchAll() { return Promise.resolve([]); } },
    registration: {
      showNotification(/** @type {string} */ title, /** @type {any} */ options) {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    location: { origin: 'https://app.test' },
  };
  const sandbox = {
    self, caches: {}, fetch: async () => ({}), URL, Date, Promise, JSON, Number, String, Object, Array,
    Math, Map, Set, parseInt, console, Symbol, setTimeout, clearTimeout,
  };
  /** @type {any} */ (sandbox).globalThis = sandbox;
  runInContext(swSource, createContext(sandbox));
  /** @type {Promise<unknown>[]} */
  const waits = [];
  const data = { json: () => ({ title: 'Tasks', body: 'Take out the bins' }), text: () => '' };
  for (const fn of listeners.push) fn({ data, waitUntil: (/** @type {Promise<unknown>} */ p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(shown.length, 1, 'ein Push zeigt genau eine Benachrichtigung');
  return shown[0].options;
}

/**
 * Rohe RGBA-Pixel eines Bildes aus public/icons/.
 * @param {string} name
 */
async function pixels(name) {
  const { data, info } = await sharp(path.join(ICONS, name)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

test('der Push-Handler nimmt das eigene Badge, nicht das App-Icon', async () => {
  const options = await shownOptions();
  assert.equal(options.badge, BADGE_URL);
  assert.notEqual(options.badge, options.icon, 'badge und icon sind dasselbe Bild');
  assert.equal(options.icon, '/icons/icon-192.png', 'das bunte Icon bleibt am Icon');
});

test('das Bild liegt unter public/icons/ (der Build precacht den ganzen Ordner)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'public', BADGE_URL)), `${BADGE_URL} fehlt`);
});

test('das Badge ist 96x96 mit Alphakanal', async () => {
  const meta = await sharp(path.join(ICONS, 'badge-96.png')).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 96);
  assert.equal(meta.height, 96);
  assert.equal(meta.hasAlpha, true);
});

test('das Badge ist weiss auf transparentem Grund, die Ecken sind leer', async () => {
  const { data, width, height } = await pixels('badge-96.png');
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    // Jeder sichtbare Pixel ist Weiss (nur der Alphakanal darf variieren):
    // ein Farbverlauf oder eine Kachel wuerde in der Maske zum Klotz.
    assert.deepEqual([data[i], data[i + 1], data[i + 2]], [255, 255, 255], `Pixel ${i / 4} ist nicht weiss`);
    if (alpha === 255) opaque += 1;
  }
  const px = (/** @type {number} */ x, /** @type {number} */ y) => data[(y * width + x) * 4 + 3];
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    assert.equal(px(x, y), 0, `Ecke ${x},${y} ist nicht transparent`);
  }
  // Das App-Icon ist zu rund 95 % deckend, das Zeichen allein zu einem
  // Drittel bis gut der Haelfte der Flaeche: dazwischen liegt die Grenze.
  const share = opaque / (width * height);
  assert.ok(share > 0.2 && share < 0.6, `deckender Anteil ${share.toFixed(2)} liegt nicht beim Zeichen`);
});

test('die Kreise sind voll deckend (keine halbtransparenten Ueberlappungen) und haben Rand', async () => {
  const { data, width, height } = await pixels('badge-96.png');
  // Mitte der Ueberlappung der drei Kreise (160er-Raster -> 96er-Bild des
  // Ausschnitts 28,5/35/105): voll deckend, sonst wuerde die Maske Grau zeigen.
  const scale = 96 / 105;
  const at = (/** @type {number} */ cx, /** @type {number} */ cy) => data[(Math.round((cy - 35) * scale) * width + Math.round((cx - 28.5) * scale)) * 4 + 3];
  assert.equal(at(80, 82), 255, 'Ueberlappung der Kreise ist nicht voll deckend');
  assert.equal(at(64, 72), 255, 'Mitte des ersten Kreises ist nicht voll deckend');
  // Rand: die aeusserste Zeile und Spalte bleiben leer, die Statusleiste
  // zeichnet das Badge klein und schneidet sonst die Kanten ab.
  for (let i = 0; i < width; i += 1) {
    assert.equal(data[i * 4 + 3], 0, `obere Zeile, Spalte ${i}`);
    assert.equal(data[((height - 1) * width + i) * 4 + 3], 0, `untere Zeile, Spalte ${i}`);
    assert.equal(data[(i * width) * 4 + 3], 0, `linke Spalte, Zeile ${i}`);
    assert.equal(data[(i * width + width - 1) * 4 + 3], 0, `rechte Spalte, Zeile ${i}`);
  }
});

test('das App-Icon taugt nicht als Badge (der Anlass des Bildes)', async () => {
  // Haelt fest, warum es das eigene Bild gibt: die Kachel ist ueberall deckend,
  // Android faerbt sie als Ganzes.
  const { data } = await pixels('icon-192.png');
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque += 1;
  assert.ok(opaque / (data.length / 4) > 0.85, 'das App-Icon ist keine fast ganz deckende Kachel mehr');
});
