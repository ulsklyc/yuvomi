/**
 * Test: Das `Secure`-Attribut des CSRF-Cookies folgt EINER Einstellung
 *
 * Zweck: `SESSION_SECURE` entscheidet, ob Yuvomi seine Cookies als `Secure`
 *        ausstellt. Der Standard ist AUS - in `.env.example` ist die Variable
 *        auskommentiert, und eine Installation auf reinem HTTP ist bei einem
 *        selbst gehosteten Dienst der Normalfall. Ein `Secure`-Cookie wird dort
 *        vom Browser stillschweigend verworfen.
 *
 * WARUM ES DIESE SUITE GIBT. Eine einzige Stelle schrieb `!== 'false'` statt
 * `=== 'true'` (`GET /auth/me`, gefunden ueber D#1242). Bei NICHT GESETZTER
 * Variable - dem Standard - ist `undefined !== 'false'` wahr: ausgerechnet der
 * Block, der das CSRF-Cookie nach einem App-Resume wiederherstellen soll,
 * stellte es so aus, dass der Browser es wegwirft. Sichtbar war das kaum, weil
 * `public/api.js` den Token zusaetzlich im Speicher haelt und ihn aus dem
 * Antwortkopf nachliest; das Symptom war ein sporadisches 403 beim Schreiben.
 *
 * DIE DREI FAELLE SIND DER GANZE PUNKT. `'false'` und `undefined` sehen wie
 * dasselbe aus und waren es nicht: fuer `'false'` lag auch die kaputte Zeile
 * richtig. Eine Suite, die nur den gesetzten Wert prueft, haette den Fehler nie
 * gesehen - und `test/server-ready.js` setzt `SESSION_SECURE = 'false'` von
 * sich aus, also muss dieser Test die Variable ausdruecklich ENTFERNEN, um den
 * Standardfall ueberhaupt herzustellen.
 *
 * GEMESSEN WIRD DER ANTWORTKOPF, NICHT DER QUELLTEXT. Ein Textguard haette
 * dieselbe Zeile gefunden, aber nicht belegt, was beim Client ankommt. Und die
 * Gegenrichtung (`'true'` -> `Secure` steht dran) ist nicht Zierde: ohne sie
 * waere die Suite auch dann gruen, wenn `secure` ueberall fest auf `false`
 * staende, die Einstellung also gar nicht mehr wirkte.
 *
 * EIN SERVER, DREI MESSUNGEN. `server/index.js` laesst sich pro Prozess nur
 * einmal starten (Modul-Cache), zwei Server mit verschiedener Umgebung gehen
 * hier also nicht. Sie sind auch nicht noetig: die Route liest
 * `process.env.SESSION_SECURE` bei JEDEM Aufruf, was dieser Test nebenbei
 * belegt.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-cookie-secure-flag.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'cookie-secure-flag',
  env: { SESSION_SECRET: 'test-cookie-secure-flag-secret-min32' },
});

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
assert.equal(login.status, 200, 'Anmeldung');
const COOKIE = cookieHeader(login.headers.get('set-cookie'));

/** Die Set-Cookie-Zeile eines bestimmten Cookies aus einer Antwort. */
function setCookieLine(res, name) {
  return (res.headers.getSetCookie?.() ?? []).find((line) => line.startsWith(`${name}=`)) ?? null;
}

/** `/auth/me` unter einem bestimmten Wert von SESSION_SECURE. */
async function csrfCookieMit(wert) {
  if (wert === undefined) delete process.env.SESSION_SECURE;
  else process.env.SESSION_SECURE = wert;
  const res = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
  assert.equal(res.status, 200, `/auth/me bei SESSION_SECURE=${String(wert)}`);
  const line = setCookieLine(res, 'csrf-token');
  assert.ok(line, `/auth/me stellt das CSRF-Cookie aus (SESSION_SECURE=${String(wert)})`);
  return line;
}

test('ohne gesetztes SESSION_SECURE traegt das CSRF-Cookie kein Secure', async () => {
  // DER FALL, DER ROT WAR. Nicht `'false'`, sondern gar nicht gesetzt: so
  // liefert `.env.example` es aus, und so laeuft jede Installation, die die
  // Zeile nie angefasst hat.
  const line = await csrfCookieMit(undefined);
  assert.ok(!/;\s*Secure/i.test(line), `kein Secure erwartet, war: ${line}`);
});

test("SESSION_SECURE='false' verhaelt sich wie nicht gesetzt", async () => {
  // Die Kontrolle daneben: dieser Wert war auch vorher richtig behandelt, und
  // genau deshalb verdeckte er den Fehler in jeder Suite, die ihn setzte.
  const line = await csrfCookieMit('false');
  assert.ok(!/;\s*Secure/i.test(line), `kein Secure erwartet, war: ${line}`);
});

test("SESSION_SECURE='true' setzt Secure auf dem CSRF-Cookie", async () => {
  // Die Gegenrichtung: ohne sie waere diese Suite auch bei einem fest
  // verdrahteten `false` gruen.
  const line = await csrfCookieMit('true');
  assert.ok(/;\s*Secure/i.test(line), `Secure erwartet, war: ${line}`);
});

test('die Schreibweise steht nur einmal im Haus', async () => {
  // DER TEXTGUARD NEBEN DER MESSUNG, und er misst etwas anderes: die Messung
  // oben deckt `/auth/me` ab, dieser Fall deckt die sechs Geschwister. Eine
  // zweite invertierte Stelle waere sonst erst dann aufgefallen, wenn jemand
  // sie im Browser bemerkt - so wie diese.
  const { readFileSync } = await import('node:fs');
  const dateien = [
    'server/auth.js', 'server/index.js',
    'server/middleware/csrf.js', 'server/services/display-accounts.js',
  ];
  const abweichungen = [];
  for (const datei of dateien) {
    const quelle = readFileSync(new URL(`../${datei}`, import.meta.url), 'utf8');
    quelle.split('\n').forEach((zeile, i) => {
      if (!zeile.includes('SESSION_SECURE')) return;
      if (zeile.trimStart().startsWith('//')) return;
      if (!zeile.includes("=== 'true'")) abweichungen.push(`${datei}:${i + 1}: ${zeile.trim()}`);
    });
  }
  assert.deepEqual(abweichungen, [], 'jede Stelle vergleicht auf === \'true\'');
});
