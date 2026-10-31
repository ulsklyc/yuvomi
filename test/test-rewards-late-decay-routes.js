/*
 * Spaetabzug: die Route, nicht nur der Dienst (Review #2413, Punkte 3 und 4).
 *
 * Der Dienst-Test haelt den Schalter selbst in der DB - hier zaehlt der Weg
 * drueber: GET /preferences muss den Schalter als echtes Bool zurueckgeben
 * (nie als '1'-String), PUT ist Admin-only und lehnt Nicht-Bool ab, und eine
 * echte Erledigung ueber PATCH /tasks/:id/status muss den Abzug durch die
 * komplette Route ins Ledger schreiben. Ein nackter Router sieht von alledem
 * nichts.
 *
 * Ausfuehren: npm run test:rewards-late-decay-routes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'rewards-late-decay-routes',
  env: { SESSION_SECRET: 'test-rewards-late-decay-routes-secret-min32' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();

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
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = as(await login('admin', 'adminpass123'));

async function member(username) {
  const created = await admin('POST', '/auth/users', { username, display_name: username, password: `${username}-pass-123` });
  assert.equal(created.status, 201, `Konto ${username}`);
  return { id: created.body.user.id, call: as(await login(username, `${username}-pass-123`)) };
}

const kid = await member('kid');

test('GET /preferences: der Schalter kommt als echtes Bool, nicht als String', async () => {
  const res = await admin('GET', '/preferences');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.tasks_late_decay_enabled, false,
    'Aus ist die Erwartung - und zwar als bool, damit die UI nicht auf "1" prueft');
});

test('PUT /preferences: Mitglied darf nicht schalten, Nicht-Bool ist 400', async () => {
  // Der Schalter entscheidet, wem Punkte abgezogen werden - dieselbe Klasse wie
  // der Genehmigungs-Schalter, deshalb Admin-only.
  assert.equal((await kid.call('PUT', '/preferences', { tasks_late_decay_enabled: true })).status, 403,
    'ein Mitglied stellt den Abzug nicht fuer den ganzen Haushalt an');
  assert.equal((await admin('PUT', '/preferences', { tasks_late_decay_enabled: 'ja' })).status, 400,
    'ein String ist kein Schalter');
  assert.equal((await admin('PUT', '/preferences', { tasks_late_decay_enabled: 1 })).status, 400,
    'eine Zahl ist kein Schalter');
  const set = await admin('PUT', '/preferences', { tasks_late_decay_enabled: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.tasks_late_decay_enabled, true);
  const back = await admin('GET', '/preferences');
  assert.equal(back.body.data.tasks_late_decay_enabled, true,
    'in der DB steht 1, die Antwort bleibt bool true');
});

test('echte Erledigung durch die Route: das Ledger traegt den Abzug', async () => {
  assert.equal((await admin('PUT', `/rewards/participants/${kid.id}`, { enabled: true })).status, 200);
  const created = await admin('POST', '/tasks', {
    title: 'Route spaeter erledigt',
    points: 5,
    due_date: '2026-01-01',
    assigned_to: [kid.id],
  });
  assert.equal(created.status, 201);
  const ticked = await kid.call('PATCH', `/tasks/${created.body.data.id}/status`, { status: 'done' });
  assert.equal(ticked.status, 200);

  const row = db.prepare("SELECT * FROM reward_ledger WHERE task_id = ? AND type = 'earn'").get(created.body.data.id);
  assert.ok(row, 'die Route muss die Gutschrift buchen');
  assert.ok(row.decay_days >= 1, 'und den Abzug dazuschreiben, nicht nur der Dienst-Test');
  assert.equal(row.base_points, 5);
  assert.equal(row.delta, Math.max(1, 5 - row.decay_days));

  const seen = await kid.call('GET', '/rewards/ledger');
  assert.equal(seen.status, 200);
  const visible = seen.body.data.find((r) => r.task_id === created.body.data.id);
  assert.ok(visible, 'die eigene Zeile ist im Ledger lesbar');
  assert.equal(visible.base_points, 5, 'Grundwert und Tage gehen an die Person, der die Zeile gehoert');
});
