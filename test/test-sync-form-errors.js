/**
 * Modul: Sync-Einstellungen - die Formularfehler nennen ihren Fall (#1909)
 * Zweck: Die Seiten Kalender-Sync und Kalender-Abos zeigten beim Verbinden
 *        eines CalDAV- oder Apple-Kontos, beim Anlegen eines Abos und beim
 *        einmaligen Import den englischen Text des Servers. Die Seite sagt
 *        jetzt den Satz der App - dafuer muss die Antwort den Fall als
 *        `reason` nennen. Was der FREMDE Server antwortet (falsches Passwort,
 *        nicht erreichbar), bleibt bewusst ohne Grund: die Seite zeigt es dem
 *        Admin im Rahmen "Verbindung fehlgeschlagen: ..." (TECHNICAL_DETAIL_SITES
 *        in test:frontend-audit).
 *
 *        Gefahren gegen den ECHTEN Server (test/server-ready.js) und, fuer
 *        CalDAV und Apple, das echte tsdav gegen test/caldav-fake-server.js:
 *        ob "keine Kalender" ein eigener Fall ist, entscheidet die Antwort des
 *        Servers auf PROPFIND, keine Attrappe am Client.
 * Ausfuehren: node --experimental-sqlite --test test/test-sync-form-errors.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startTestServer, cookieHeader } from './server-ready.js';
import { startFakeDavServer } from './caldav-fake-server.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'sync-form-errors',
  env: { SESSION_SECRET: 'test-sync-form-errors-secret-32-chars' },
});
const db = (await import('../server/db.js')).get();

const dav = await startFakeDavServer();
after(() => dav.close());

// Ein Feed-Host, der mit einem Status oder einer Ueberlaenge antwortet.
const feed = http.createServer((req, res) => {
  if (req.url === '/huge.ics') {
    res.writeHead(200, { 'Content-Type': 'text/calendar', 'Content-Length': String(11 * 1024 * 1024) });
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('nope');
});
await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve));
const FEED = `http://127.0.0.1:${feed.address().port}`;
after(() => new Promise((resolve) => { feed.closeAllConnections?.(); feed.close(resolve); }));

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
assert.equal(loginRes.status, 200, 'login admin');
const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
const AUTH = { Cookie: cookie, 'X-CSRF-Token': me.csrfToken };

async function admin(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Privates Netz fuer die Dauer von `fn` erlauben (der Feed-Host liegt auf 127.0.0.1). */
async function withPrivateNetwork(fn) {
  const before = process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK;
  process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK;
    else process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = before;
  }
}

const caldav = (body) => admin('POST', '/calendar/caldav/accounts', { name: 'Fake', username: 'u', password: 'p', ...body });

test('CalDAV: ein Konto ohne Kalender nennt seinen Fall', async () => {
  dav.reset();
  const res = await caldav({ caldavUrl: dav.url });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'caldav_no_calendars');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caldav_accounts').get().n, 0, 'nichts gespeichert');
});

test('CalDAV: dasselbe Konto ein zweites Mal ist ein eigener Fall', async () => {
  dav.reset();
  dav.addCollection('home', { name: 'Zuhause' });
  assert.equal((await caldav({ caldavUrl: dav.url })).status, 200);
  const res = await caldav({ caldavUrl: dav.url });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'caldav_account_exists');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM caldav_accounts').get().n, 1);
});

test('CalDAV: eine Absage des fremden Servers bleibt seine Angabe, ohne Grund', async () => {
  dav.reset();
  dav.refuse({ method: 'PROPFIND', status: 401 });
  try {
    const res = await caldav({ caldavUrl: dav.url, username: 'other' });
    assert.equal(res.status, 500);
    assert.equal(res.body.reason, undefined, 'die Seite zeigt den Text des fremden Servers');
    assert.match(res.body.error, /^CalDAV connection failed/);
  } finally { dav.allowAll(); }
});

test('Apple: eine Adresse ohne http(s) und ein Konto ohne Kalender nennen ihren Fall', async () => {
  const bad = await admin('POST', '/calendar/apple/connect', { url: 'ftp://caldav.icloud.com', username: 'a@b.c', password: 'p' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'apple_url_invalid');

  dav.reset();
  const empty = await admin('POST', '/calendar/apple/connect', { url: dav.url, username: 'a@b.c', password: 'p' });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.reason, 'apple_no_calendars');
});

test('Abo anlegen: Name, Adresse und privates Netz nennen ihren Fall', async () => {
  const base = { name: 'Feiertage', url: 'https://example.com/a.ics', color: '#112233' };
  for (const [body, reason] of [
    [{ ...base, name: '   ' }, 'calendar_subscription_name_invalid'],
    [{ ...base, name: 'x'.repeat(101) }, 'calendar_subscription_name_invalid'],
    [{ ...base, url: 'ftp://example.com/a.ics' }, 'calendar_ics_url_scheme'],
    [{ ...base, url: 'not a url' }, 'calendar_ics_url_invalid'],
    [{ ...base, url: 'https://127.0.0.1/a.ics' }, 'calendar_ics_private_address'],
  ]) {
    const res = await admin('POST', '/calendar/subscriptions', body);
    assert.equal(res.status, 400, `${reason}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, reason, JSON.stringify(body));
  }
});

test('Abo bearbeiten: ein leerer oder zu langer Name nennt seinen Fall', async () => {
  const userId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const subId = db.prepare(`INSERT INTO ics_subscriptions (name, url, color, shared, created_by)
    VALUES ('Alt', 'https://example.com/b.ics', '#112233', 0, ?)`).run(userId).lastInsertRowid;
  for (const name of ['  ', 'y'.repeat(101)]) {
    const res = await admin('PATCH', `/calendar/subscriptions/${subId}`, { name });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'calendar_subscription_name_invalid');
  }
});

test('Import: Adresse, privates Netz und geloeschter Zielkalender nennen ihren Fall', async () => {
  for (const [body, reason] of [
    [{ url: 'ftp://example.com/a.ics' }, 'calendar_ics_url_scheme'],
    [{ url: 'not a url' }, 'calendar_ics_url_invalid'],
    [{ url: 'https://127.0.0.1/a.ics' }, 'calendar_ics_private_address'],
    [{ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', local_calendar_id: 987654 }, 'calendar_selected_calendar_not_found'],
  ]) {
    const res = await admin('POST', '/calendar/import', body);
    assert.equal(res.status, 400, `${reason}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, reason, JSON.stringify(body));
  }
});

test('Import: Status und Groesse des Feeds kommen als Zahl, nicht als Text', async () => {
  await withPrivateNetwork(async () => {
    const status = await admin('POST', '/calendar/import', { url: `${FEED}/missing.ics` });
    assert.equal(status.status, 400, JSON.stringify(status.body));
    assert.equal(status.body.reason, 'calendar_ics_http_status');
    assert.deepEqual(status.body.params, { status: 404 });

    const huge = await admin('POST', '/calendar/import', { url: `${FEED}/huge.ics` });
    assert.equal(huge.status, 400, JSON.stringify(huge.body));
    assert.equal(huge.body.reason, 'calendar_ics_too_large');
    assert.deepEqual(huge.body.params, { limit_mb: 10 });
  });
});
