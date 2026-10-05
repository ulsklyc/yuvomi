/**
 * Test: Modul-Gate und Token-Scopes gegen die Schreibweise des Pfads
 * Zweck: Express routet ohne Beachtung der Gross-/Kleinschreibung - `/Notes`
 *        landet im Notiz-Router wie `/notes`. `moduleForPath()` verglich
 *        dagegen woertlich, fand fuer `/Notes` kein Modul und gab `null`
 *        zurueck; die Modul-Deny-Liste fuer Mitglieder (server/index.js) laesst
 *        `null` durch. Ein Mitglied mit `notes: none` las so jede sichtbare
 *        Notiz, eines mit `tasks: read` legte Aufgaben an. Das laeuft hier
 *        durch den ECHTEN Server (test/server-ready.js): ein nackt
 *        eingehaengter Router sieht das globale Gate nie.
 *        Die Token-Seite war nie offen (unbekanntes Modul = verweigert), bekam
 *        aber das Spiegelbild: ein Token mit `notes:read` scheiterte an `/Notes`.
 * Ausfuehren: node --experimental-sqlite --test test/test-module-gate-path-case.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'module-gate-path-case',
  env: { SESSION_SECRET: 'test-module-gate-path-case-secret-min32' },
});
const { default: dbmod } = await import('../server/db.js').then((m) => ({ default: m }));
const db = dbmod.get();
const { moduleForPath } = await import('../server/scopes.js');

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
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = as(await login('admin', 'adminpass123'));
const note = await admin('POST', '/notes', { title: 'Nur fuer Berechtigte', content: 'x', visibility: 'family' });
assert.equal(note.status, 201, 'Notiz des Admins');

const created = await admin('POST', '/auth/users', { username: 'member1', display_name: 'Member', password: 'memberpass123' });
assert.equal(created.status, 201);
const gate = await admin('PUT', `/permissions/user/${created.body.user.id}`, {
  modules: { notes: 'none', tasks: 'read', documents: 'none' },
});
assert.equal(gate.status, 200, 'Modul-Zugriff des Mitglieds');
const member = as(await login('member1', 'memberpass123'));

const NOTES_TOKEN = 'yuvomi_test_path_case_notes_token';
db.prepare(`
  INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes)
  VALUES ('notes-read', ?, 'yuvomi_test', 1, ?)
`).run(crypto.createHash('sha256').update(NOTES_TOKEN).digest('hex'), JSON.stringify(['notes:read']));
const withToken = (method, path) => fetch(`${BASE}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${NOTES_TOKEN}` } });

test('moduleForPath: jede Schreibweise loest auf dasselbe Modul auf', () => {
  assert.equal(moduleForPath('/Notes'), 'notes');
  assert.equal(moduleForPath('/NOTES/5'), 'notes');
  assert.equal(moduleForPath('/Split-Expenses/3'), 'budget');
  assert.equal(moduleForPath('/Schedule/Preferences'), 'schedule');
});

test('notes: none - die Sperre gilt fuer /notes, /Notes und /NOTES', async () => {
  for (const path of ['/notes', '/Notes', '/NOTES']) {
    const r = await member('GET', path);
    assert.equal(r.status, 403, `GET ${path}`);
  }
});

test('documents: none - auch /Documents bleibt gesperrt', async () => {
  const r = await member('GET', '/Documents');
  assert.equal(r.status, 403);
});

test('tasks: read - /Tasks nimmt keinen Schreibzugriff an', async () => {
  const r = await member('POST', '/Tasks', { title: 'darf nicht entstehen' });
  assert.equal(r.status, 403);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'darf nicht entstehen'").get();
  assert.equal(rows.n, 0, 'die Aufgabe wurde nicht angelegt');
});

// #1607: das Gate sagt in einem maschinenlesbaren Feld, WARUM es ablehnt. Der
// englische Satz in `error` stand sonst in jeder Oberflaechensprache im Toast;
// die App uebersetzt ueber `reason` (public/api.js).
test('das Gate nennt seinen Grund: module_access_denied und module_read_only', async () => {
  const denied = await member('GET', '/notes');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'module_access_denied');
  assert.equal(typeof denied.body.error, 'string', 'der Satz bleibt fuer API-Nutzer stehen');

  const readOnly = await member('POST', '/tasks', { title: 'darf nicht entstehen' });
  assert.equal(readOnly.status, 403);
  assert.equal(readOnly.body.reason, 'module_read_only');
});

test('tasks: read - Lesen bleibt unter jeder Schreibweise erlaubt', async () => {
  for (const path of ['/tasks', '/Tasks']) {
    const r = await member('GET', path);
    assert.equal(r.status, 200, `GET ${path}`);
  }
});

test('Token mit notes:read: /Notes ist dasselbe Modul wie /notes', async () => {
  for (const path of ['/notes', '/Notes']) {
    const res = await withToken('GET', path);
    assert.equal(res.status, 200, `GET ${path}`);
  }
  const other = await withToken('GET', '/Tasks');
  assert.equal(other.status, 403, 'ein fremdes Modul bleibt verweigert');
});
