/**
 * Test: Standard-Sync-Ziel für neue Termine in der Preferences-API (#620)
 * Zweck: GET liefert calendar_default_target (Default ''); PUT nimmt die
 *        Kennungen des Event-Modals an ('' | google:<id> | caldav:<id>|<url>),
 *        weist Unfug mit 400 ab und speichert PRO NUTZER, nicht haushaltweit.
 *        Der Wert muss auch in der PUT-Antwort stehen, sonst verliert der
 *        Frontend-Cache ihn nach dem ersten Speichern eines anderen Feldes.
 * Ausführen: node --experimental-sqlite --test test/test-preferences-calendar-target.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentUserId = 1;
let currentRole = 'member';

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = currentUserId; req.authRole = currentRole; next(); });
  app.use('/', preferencesRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

const get = async (baseUrl) => (await (await fetch(`${baseUrl}/`)).json()).data;
const put = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('GET: Default ist leer (= lokal speichern)', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await get(baseUrl)).calendar_default_target, '');
  } finally { await close(); }
});

test('PUT: Google-Ziel wird gespeichert und zurückgeliefert', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const res = await put(baseUrl, { calendar_default_target: 'google:family@group.calendar.google.com' });
    assert.equal(res.status, 200);
    // Auch in der PUT-Antwort, nicht nur beim nächsten GET.
    assert.equal(res.body.data.calendar_default_target, 'google:family@group.calendar.google.com');
    assert.equal((await get(baseUrl)).calendar_default_target, 'google:family@group.calendar.google.com');
  } finally { await close(); }
});

test('PUT: CalDAV-Ziel mit Konto-ID und URL', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const target = 'caldav:3|https://dav.example.org/cal/family/';
    assert.equal((await put(baseUrl, { calendar_default_target: target })).status, 200);
    assert.equal((await get(baseUrl)).calendar_default_target, target);
  } finally { await close(); }
});

test('PUT: leerer Wert wählt ein gesetztes Ziel wieder ab', async () => {
  const { baseUrl, close } = await startApp();
  try {
    await put(baseUrl, { calendar_default_target: 'google:x@example.com' });
    assert.equal((await put(baseUrl, { calendar_default_target: '' })).status, 200);
    assert.equal((await get(baseUrl)).calendar_default_target, '');
  } finally { await close(); }
});

test('PUT: unbekanntes Präfix -> 400', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const res = await put(baseUrl, { calendar_default_target: 'exchange:foo' });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

test('PUT: caldav ohne numerische Konto-ID -> 400', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await put(baseUrl, { calendar_default_target: 'caldav:abc|https://x/' })).status, 400);
    assert.equal((await put(baseUrl, { calendar_default_target: 'caldav:7' })).status, 400);
  } finally { await close(); }
});

test('PUT: Nicht-String -> 400', async () => {
  const { baseUrl, close } = await startApp();
  try {
    assert.equal((await put(baseUrl, { calendar_default_target: 42 })).status, 400);
  } finally { await close(); }
});

test('PUT: überlanger Wert -> 400', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const long = 'google:' + 'a'.repeat(600);
    assert.equal((await put(baseUrl, { calendar_default_target: long })).status, 400);
  } finally { await close(); }
});

test('Ziel gilt pro Nutzer, nicht haushaltweit', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentUserId = 1;
    await put(baseUrl, { calendar_default_target: 'google:eins@example.com' });
    currentUserId = 2;
    assert.equal((await get(baseUrl)).calendar_default_target, '', 'Nutzer 2 erbt nichts');
    await put(baseUrl, { calendar_default_target: 'google:zwei@example.com' });
    currentUserId = 1;
    assert.equal((await get(baseUrl)).calendar_default_target, 'google:eins@example.com',
      'Nutzer 1 bleibt unberührt');
  } finally { currentUserId = 1; await close(); }
});

test('kein Admin-Gate: ein Mitglied darf sein eigenes Ziel setzen', async () => {
  const { baseUrl, close } = await startApp();
  try {
    currentRole = 'member';
    assert.equal((await put(baseUrl, { calendar_default_target: 'google:m@example.com' })).status, 200);
  } finally { currentRole = 'member'; await close(); }
});
