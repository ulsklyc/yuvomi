/**
 * Modul: Profilbilder als Adresse statt als Data-URL in jeder Zeile
 * Zweck: Listen (Aufgaben, Termine, Notizen, Uebersicht, Erledigt-Verlauf,
 *        Housekeeping-Besuche) tragen fuer das Bild einer Person die Adresse
 *        `/api/v1/people/:id/avatar?v=...` statt der Data-URL selbst, und die
 *        Route liefert das Bild mit ETag.
 *
 *        ANLASS, GEMESSEN (18.10.2026): 200 Aufgaben bei fuenf Profilbildern zu
 *        je rund 40 KB machten `GET /tasks` 17 MB gross - 430 Data-URLs, weil
 *        jede Zeile das Bild des Zustaendigen zweimal trug (`assigned_avatar`
 *        und `assigned_users[].avatar_data`). gzip kann ein 40-KB-Bild in seinem
 *        32-KB-Fenster nicht entdoppeln: ueber HTTP im Heimnetz gingen 12,9 MB
 *        ueber die Leitung, und der Service Worker legte die 17 MB in seinen
 *        API-Cache.
 *
 *        WER DAS BILD LESEN DARF: wer die Adresse bekommt - eine Sitzung und ein
 *        Wanddisplay. Ein API-Token bekommt die Data-URL und mit Scopes keinen
 *        Zugang zur Route; ein Ausgaben-Gast keinen.
 * Ausfuehren: npm run test:person-avatars
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'person-avatars',
  env: { SESSION_SECRET: 'test-person-avatars-secret-min32chars' },
});
const db = (await import('../server/db.js')).get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, body: json, text };
  };
}

const adminSession = await login('admin', 'adminpass123');
const admin = as(adminSession);

// Ein Bild in der Form, die avatar-crop.js erzeugt und normalizeAvatarData annimmt.
const JPEG_BYTES = randomBytes(3000);
const AVATAR = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

const created = await admin('POST', '/auth/users', {
  username: 'bob', display_name: 'Bob', password: 'bobpass12345', avatar_data: AVATAR,
});
assert.equal(created.status, 201, `Mitglied anlegen: ${created.text}`);
const BOB = created.body.data?.id ?? created.body.user?.id ?? created.body.id;
assert.ok(BOB, `id des neuen Mitglieds: ${created.text}`);
const ADMIN = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(AVATAR, ADMIN);
const NO_AVATAR = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('ohnebild', 'Ohne Bild', 'x', '#007AFF')
`).run().lastInsertRowid;

const avatarPath = (id) => new RegExp(`^/api/v1/people/${id}/avatar\\?v=[0-9a-f]{32}$`);
// Die Adresse, wie sie in einer Zeile steht: mit dem Schluessel der Person.
const keyedUrl = (id) => `/api/v1/people/${id}/avatar?v=${db.prepare('SELECT avatar_key FROM users WHERE id = ?').get(id)?.avatar_key}`;
const keyedPath = (id) => keyedUrl(id).slice('/api/v1'.length);

// --------------------------------------------------------
// Die Zeilen tragen die Adresse, nicht das Bild
// --------------------------------------------------------

test('Aufgaben: der Zustaendige traegt die Bildadresse, nicht die Data-URL', async () => {
  const task = await admin('POST', '/tasks', { title: 'Muell rausbringen', assigned_to: [BOB] });
  assert.equal(task.status, 201, task.text);
  const list = await admin('GET', '/tasks');
  assert.equal(list.status, 200);
  assert.doesNotMatch(list.text, /data:image\//, 'GET /tasks traegt eine Data-URL');
  const row = list.body.data.find((t) => t.title === 'Muell rausbringen');
  assert.ok(row, 'Aufgabe in der Liste');
  assert.match(String(row.assigned_avatar), avatarPath(BOB), 'assigned_avatar');
  assert.match(String(row.assigned_users[0].avatar_data), avatarPath(BOB), 'assigned_users[].avatar_data');
});

test('Aufgaben: Einzelabruf und Erledigt-Verlauf tragen die Adresse', async () => {
  const task = await admin('POST', '/tasks', { title: 'Blumen giessen', assigned_to: [BOB] });
  const id = task.body.data.id;
  const one = await admin('GET', `/tasks/${id}`);
  assert.equal(one.status, 200, one.text);
  assert.doesNotMatch(one.text, /data:image\//, 'GET /tasks/:id traegt eine Data-URL');
  const done = await admin('PATCH', `/tasks/${id}/status`, { status: 'done' });
  assert.ok(done.status < 300, done.text);
  const feed = await admin('GET', '/tasks/completions');
  assert.equal(feed.status, 200, feed.text);
  assert.doesNotMatch(feed.text, /data:image\//, 'GET /tasks/completions traegt eine Data-URL');
});

test('Termine: zugewiesene Personen tragen die Bildadresse', async () => {
  const event = await admin('POST', '/calendar', {
    title: 'Elternabend', start_datetime: '2026-10-20T19:00', end_datetime: '2026-10-20T20:00', assigned_to: [BOB],
  });
  assert.equal(event.status, 201, event.text);
  const list = await admin('GET', '/calendar?from=2026-10-01&to=2026-10-31');
  assert.equal(list.status, 200, list.text);
  assert.doesNotMatch(list.text, /data:image\//, 'GET /calendar traegt eine Data-URL');
  const row = list.body.data.find((e) => e.title === 'Elternabend');
  assert.ok(row, 'Termin in der Liste');
  assert.match(String(row.assigned_users[0].avatar_data), avatarPath(BOB));
});

test('Notizen: die Verfasserin traegt die Bildadresse', async () => {
  const note = await admin('POST', '/notes', { title: 'Einkauf', content: 'Milch' });
  assert.equal(note.status, 201, note.text);
  const list = await admin('GET', '/notes');
  assert.equal(list.status, 200);
  assert.doesNotMatch(list.text, /data:image\//, 'GET /notes traegt eine Data-URL');
  const row = list.body.data.find((n) => n.title === 'Einkauf');
  assert.match(String(row.creator_avatar), avatarPath(ADMIN));
});

test('Uebersicht: Aufgaben und Termine tragen die Bildadresse', async () => {
  const dash = await admin('GET', '/dashboard');
  assert.equal(dash.status, 200, dash.text);
  // Die Mitgliederliste (`users`) behaelt ihr Bild als Data-URL: sie traegt
  // jede Person EINMAL, und die Bearbeitungsmasken schicken den Wert zurueck.
  // Die Antwort hat keine `data`-Huelle; ohne diesen Rueckfall pruefte der Test
  // ein leeres Objekt und war gruen, bevor es die Adresse gab.
  const body = dash.body.data ?? dash.body;
  assert.ok(Array.isArray(body.urgentTasks) && body.urgentTasks.length, 'die Uebersicht zeigt offene Aufgaben');
  const withoutMembers = JSON.stringify({ ...body, users: undefined });
  assert.doesNotMatch(withoutMembers, /data:image\//, 'Zeilen der Uebersicht tragen eine Data-URL');
  assert.match(withoutMembers, /\/api\/v1\/people\/\d+\/avatar/, 'die Zeilen tragen die Bildadresse');
});

test('Personen ohne Bild bekommen keine Adresse', async () => {
  const task = await admin('POST', '/tasks', { title: 'Ohne Bild', assigned_to: [NO_AVATAR] });
  assert.equal(task.status, 201, task.text);
  const row = (await admin('GET', '/tasks')).body.data.find((t) => t.title === 'Ohne Bild');
  assert.equal(row.assigned_avatar, null);
  assert.equal(row.assigned_users[0].avatar_data, null);
});

// --------------------------------------------------------
// Die Route liefert das Bild
// --------------------------------------------------------

test('GET /people/:id/avatar liefert die Bild-Bytes mit ETag, revalidierbar statt immutable', async () => {
  const res = await fetch(`${BASE}${keyedUrl(BOB)}`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  // `private, no-cache`, NIE `max-age`/`immutable`: ein Jahr im HTTP-Cache liess
  // das Bild nach dem Abmelden oder einem Kontowechsel im selben Browser ohne
  // requireAuth und Rechtepruefung kommen - das Abmelden leert nur den Cache
  // des Service Workers. Mit `no-cache` fragt der Browser jedes Mal nach.
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  const etag = res.headers.get('etag');
  assert.match(etag ?? '', /^"[0-9a-f]{32}"$/, 'starkes ETag gesetzt');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG_BYTES, 'dieselben Bytes wie hochgeladen');

  const again = await fetch(`${BASE}${keyedUrl(BOB)}`, {
    headers: { Cookie: adminSession.cookie, 'If-None-Match': etag },
  });
  assert.equal(again.status, 304, 'unveraendertes Bild: 304 ohne Rumpf');
  assert.equal(again.headers.get('cache-control'), 'private, no-cache', 'auch das 304 erlaubt kein Liegenbleiben');
  assert.equal(again.headers.get('etag'), etag);

  // Die Nachfrage laeuft durch die Gates: abgemeldet kein 304, sondern 401.
  const anon = await fetch(`${BASE}${keyedUrl(BOB)}`, { headers: { 'If-None-Match': etag } });
  assert.equal(anon.status, 401, 'ohne Sitzung bestaetigt die Route kein gecachtes Bild');
  assert.match(String(anon.headers.get('cache-control')), /no-store/);
});

test('Fehlerantworten der Bildroute behalten no-store und tragen kein Versions-ETag', async () => {
  const wrongKey = await fetch(`${BASE}/api/v1/people/${BOB}/avatar?v=${'0'.repeat(32)}`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(wrongKey.status, 404);
  assert.match(String(wrongKey.headers.get('cache-control')), /no-store/);
  assert.doesNotMatch(wrongKey.headers.get('etag') ?? '', /^"[0-9a-f]{32}"$/);
  const bad = await fetch(`${BASE}/api/v1/people/abc/avatar`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.headers.get('cache-control')), /no-store/);
});

test('ein neues Bild bekommt eine neue Adresse und ein neues ETag', async () => {
  const before = (await admin('GET', '/tasks')).body.data.find((t) => t.title === 'Muell rausbringen').assigned_avatar;
  const urlBefore = keyedUrl(BOB);
  const etagBefore = (await fetch(`${BASE}${urlBefore}`, { headers: { Cookie: adminSession.cookie } })).headers.get('etag');
  // GLEICH LANG wie das alte Bild (Codex-Review zu #2056): Base64-Laengen kommen
  // in Stufen, und zugeschnittene Bilder sind aehnlich gross. Eine Version aus
  // der Laenge bliebe hier stehen, und der Offline-Cache des Service Workers
  // zeigte unter derselben Adresse das alte Bild.
  const nextBytes = randomBytes(JPEG_BYTES.length);
  const next = `data:image/jpeg;base64,${nextBytes.toString('base64')}`;
  assert.equal(next.length, AVATAR.length, 'Voraussetzung: gleich lange Data-URL');
  const put = await admin('PATCH', `/auth/users/${BOB}`, { avatar_data: next });
  assert.ok(put.status < 300, put.text);
  const after = (await admin('GET', '/tasks')).body.data.find((t) => t.title === 'Muell rausbringen').assigned_avatar;
  assert.notEqual(after, before, 'die Adresse wechselt mit dem Bild, sonst zeigt der Browser das alte');
  const stale = await fetch(`${BASE}${urlBefore}`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(stale.status, 404, 'die alte Adresse gilt mit dem alten Bild nicht mehr');
  const res = await fetch(`${BASE}${keyedUrl(BOB)}`, { headers: { Cookie: adminSession.cookie } });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), nextBytes, 'die Route liefert das neue Bild');
  assert.notEqual(res.headers.get('etag'), etagBefore);
});

test('ohne Bild 404, ungueltige id 400, ohne Anmeldung 401', async () => {
  const none = await fetch(`${BASE}/api/v1/people/${NO_AVATAR}/avatar`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(none.status, 404);
  const bad = await fetch(`${BASE}/api/v1/people/abc/avatar`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(bad.status, 400);
  const anon = await fetch(`${BASE}${keyedUrl(BOB)}`);
  assert.equal(anon.status, 401);
});

// --------------------------------------------------------
// Wer das Bild lesen darf
// --------------------------------------------------------

test('ein Mitglied, dem das Aufgabenmodul gesperrt ist, sieht trotzdem Bilder (kein Modul)', async () => {
  const bob = as(await login('bob', 'bobpass12345'));
  const res = await bob('GET', keyedPath(ADMIN));
  assert.equal(res.status, 200);
});

test('ein gekoppeltes Wanddisplay darf Bilder lesen', async () => {
  const display = await admin('POST', '/displays', { display_name: 'Kueche' });
  assert.equal(display.status, 201, display.text);
  const issued = await admin('POST', `/displays/${display.body.data.id}/pairing-code`, {});
  const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: issued.body.data.code }),
  });
  const token = decodeURIComponent(String(paired.headers.get('set-cookie')).match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1]);
  const res = await fetch(`${BASE}${keyedUrl(BOB)}`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(res.status, 200, 'die Wand zeigt Aufgaben und Termine samt Personen');
});

test('ein gescoptes API-Token bekommt Data-URLs und liest die Bildroute nicht', async () => {
  const spoof = `/api/v1/people/${BOB}/avatar?v=${'0'.repeat(32)}`;
  assert.equal((await admin('POST', '/tasks', { title: spoof })).status, 201);
  const created = await admin('POST', '/auth/api-tokens', { name: 'Nur Aufgaben', scopes: ['tasks:read'] });
  assert.equal(created.status, 201, created.text);
  // KEIN ZUGRIFF AUF DIE ROUTE (Codex-Review zu #2056): ein Token bekommt die
  // Bilder als Data-URL in den Zeilen, die es lesen darf, und braucht die Route
  // nicht. Liesse das Scope-Gate sie fuer jedes Token durch, holte eines mit
  // `weather:read` per Durchzaehlen der ids jedes Profilbild.
  const res = await fetch(`${BASE}${keyedUrl(BOB)}`, { headers: { Authorization: `Bearer ${created.body.token}` } });
  assert.equal(res.status, 403, 'ein Token mit Scopes liest die Bildroute nicht');
  const tasks = await fetch(`${BASE}/api/v1/tasks`, { headers: { Authorization: `Bearer ${created.body.token}` } });
  assert.equal(tasks.status, 200, 'Gegenprobe: das Token liest Aufgaben');
  // EIN TOKEN BEKOMMT DIE DATA-URL WIE BISHER (Codex-Review zu #2056): ein
  // Client, der mit Bearer-Token liest und den Wert in ein <img src> setzt,
  // schickt beim Bildabruf keinen Authorization-Header mit - die Adresse
  // ergaebe dort 401. Nur die App selbst (Cookie-Sitzung, Wanddisplay) bekommt
  // die Adresse.
  const body = await tasks.json();
  const row = body.data.find((t) => t.title === 'Muell rausbringen');
  assert.match(String(row.assigned_avatar), /^data:image\/jpeg;base64,/, 'assigned_avatar fuer ein Token');
  assert.match(String(row.assigned_users[0].avatar_data), /^data:image\/jpeg;base64,/, 'assigned_users[].avatar_data fuer ein Token');
  assert.doesNotMatch(JSON.stringify(body.data.filter((t) => t.title !== spoof)), /\/api\/v1\/people\//, 'keine Bildadresse in der Token-Antwort');
  // Ersetzt wird nur in den Bildfeldern, nie in Text, den jemand eintippt:
  // ein Titel, der wie eine Bildadresse aussieht, bleibt Text (Security-Review
  // zu #2056 - sonst blaehte jeder solche Titel die Antwort um ein Bild auf).
  const spoofed = body.data.find((t) => t.title === spoof);
  assert.equal(spoofed?.title, spoof, 'der Titel bleibt, wie er eingegeben wurde');
  const write = await fetch(`${BASE}/api/v1/people/${BOB}/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${created.body.token}` } });
  assert.notEqual(write.status, 200, 'nur Lesen');
});

test('ein Ausgaben-Gast liest keine Bilder des Haushalts', async () => {
  const guest = await admin('POST', '/auth/users', { username: 'gast', display_name: 'Gast', password: 'gastpass12345' });
  assert.equal(guest.status, 201, guest.text);
  const guestId = guest.body.data?.id ?? guest.body.user?.id ?? guest.body.id;
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guestId);
  const res = await as(await login('gast', 'gastpass12345'))('GET', keyedPath(BOB));
  assert.equal(res.status, 403);
});

// Codex-Review zu #2056: mit einer durchzaehlbaren Adresse holte jede Sitzung
// und jedes Wanddisplay per Raten der ids auch Bilder von Personen, die es nie
// in einer Zeile sieht - Hauspersonal, Ausgaben-Gaeste, deaktivierte Konten.
// Die Adresse traegt deshalb einen Zufallsschluessel je Bild; ohne ihn gibt es
// kein Bild, und Raten hilft nicht.
test('ohne den Schluessel aus der Zeile gibt die Route kein Bild heraus', async () => {
  const hidden = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('personal', 'Personal', 'x', '#007AFF')
  `).run().lastInsertRowid;
  db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(AVATAR, hidden);
  const headers = { Cookie: adminSession.cookie };
  assert.equal((await fetch(`${BASE}/api/v1/people/${hidden}/avatar`, { headers })).status, 404, 'ohne Schluessel');
  assert.equal((await fetch(`${BASE}/api/v1/people/${hidden}/avatar?v=1`, { headers })).status, 404, 'geratene Version');
  assert.equal((await fetch(`${BASE}/api/v1/people/${hidden}/avatar?v=${'a'.repeat(32)}`, { headers })).status, 404, 'falscher Schluessel');
  assert.equal((await fetch(`${BASE}${keyedUrl(hidden)}`, { headers })).status, 200, 'mit dem Schluessel aus der Zeile');
});

// Die Route gibt ohne `v` nie ein Bild heraus; ein Client aus der OpenAPI-
// Beschreibung muss den Parameter deshalb dort finden (Codex-Review zu #2056).
test('OpenAPI: `v` ist ein Pflicht-Query-Parameter im Format des Schluessels', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const params = buildOpenApiSpec().paths['/api/v1/people/{id}/avatar'].get.parameters ?? [];
  const v = params.find((p) => p.name === 'v' && p.in === 'query');
  assert.ok(v, 'v ist deklariert');
  assert.equal(v.required, true);
  const pattern = new RegExp(v.schema.pattern);
  assert.match(new URL(keyedUrl(BOB), BASE).searchParams.get('v'), pattern, 'der Schluessel aus der Zeile passt');
  assert.doesNotMatch('1', pattern);
});

// Codex-Review zu #2056: eine Wiederholung mit demselben `Idempotency-Key`
// muss genau die erste Antwort zurueckgeben. Lag die Umschreibung fuer Tokens
// vor der Idempotenz, speicherte diese die Adresse und setzte beim Wiederholen
// das Bild von JETZT ein - nach einem Bildwechsel eine andere Antwort.
test('ein Token bekommt bei einer Wiederholung (Idempotency-Key) die erste Antwort', async () => {
  const carol = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('carol', 'Carol', 'x', '#007AFF')
  `).run().lastInsertRowid;
  db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(AVATAR, carol);
  const token = await admin('POST', '/auth/api-tokens', { name: 'Schreiben', scopes: ['tasks:write'] });
  assert.equal(token.status, 201, token.text);
  const post = () => fetch(`${BASE}/api/v1/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.body.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'avatar-replay-1' },
    body: JSON.stringify({ title: 'Wiederholt', assigned_to: [carol] }),
  });
  const first = await post();
  assert.equal(first.status, 201);
  const firstBody = await first.text();
  assert.match(firstBody, /data:image\/jpeg;base64,/, 'die erste Antwort traegt die Data-URL');
  db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?')
    .run(`data:image/jpeg;base64,${randomBytes(3000).toString('base64')}`, carol);
  const replay = await post();
  assert.equal(replay.status, 201);
  assert.equal(await replay.text(), firstBody, 'die Wiederholung ist die erste Antwort');
});
