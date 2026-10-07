/**
 * Test: Wiederkehrende geteilte Ausgaben hinter den Gates des echten Servers (#1647)
 * Zweck: `PUT` und `DELETE /split-expenses/recurring/:id` sind neu, der
 *        Pause-Umschalter alt, und keine der drei Routen fragt selbst nach dem
 *        Modulrecht: `budget: read`, der Token-Scope und das Display-Konto
 *        werden in server/index.js abgewiesen, VOR dem Router. Die Suite am
 *        eingehaengten Router (test:split-expenses-routes) sieht diese Gates
 *        nie - eine Route, die an ihnen vorbei montiert waere, bliebe dort gruen.
 *
 *        Deshalb der ECHTE Server (test/server-ready.js), nach dem Vorbild von
 *        test:split-settlement-reversal. Wer hier abgewiesen wird, ist jeweils
 *        Verwalter der Gruppe oder handelt fuer einen: die Gruppenregel liesse
 *        ihn durch, nur das Gate haelt ihn auf. Jede Ablehnung prueft, dass die
 *        Serie danach unveraendert dasteht, und die Gegenprobe am Ende, dass
 *        dieselben Aufrufe mit Schreibrecht durchgehen.
 * Ausfuehren: npm run test:split-recurring-gates
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-recurring-gates',
  env: { SESSION_SECRET: 'test-split-recurring-gates-secret-32chars', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const db = (await import('../server/db.js')).get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

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
  const headers = session.token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }
    : { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

/**
 * Ein Wand-Tablett: nur das Display-Cookie, die Sitzung samt CSRF-Token faellt
 * beim ersten GET hinter den Gates an (wie in test:display-actions) - sonst
 * waere die 403 die des fehlenden Tokens und nicht die des Display-Kontos.
 */
function asDisplay(token) {
  const jar = new Map([[DISPLAY_COOKIE, token]]);
  let csrf = null;
  const send = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) csrf = fresh;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return async (method, path, body) => {
    if (!csrf && method !== 'GET') await send('GET', '/preferences');
    return send(method, path, body);
  };
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const adminCall = as(await login('admin', 'adminpass123'));

async function member(username, displayName) {
  const r = await adminCall('POST', '/auth/users', { username, display_name: displayName, password: `${username}pass123` });
  assert.equal(r.status, 201, `create ${username}`);
  return { id: r.body.user.id, call: as(await login(username, `${username}pass123`)) };
}

// OWN legt Gruppe und Serie an. RD verwaltet die Gruppe mit, hat aber nur
// `budget: read`. MGR verwaltet sie auch - fuer ihn handelt das Token.
const OWN = await member('owner', 'Olivia');
const RD = await member('reader', 'Rita');
const MGR = await member('manager', 'Max');
assert.equal((await adminCall('PUT', `/permissions/user/${RD.id}`, { modules: { budget: 'read' } })).status, 200);

const group = await OWN.call('POST', '/split-expenses/groups', { name: 'WG-Kasse', type: 'household', default_currency: 'EUR' });
assert.equal(group.status, 201);
const GROUP = group.body.data.id;
for (const u of [RD, MGR]) {
  assert.equal((await OWN.call('POST', `/split-expenses/groups/${GROUP}/members`, { user_id: u.id, role: 'admin' })).status, 201);
}
const created = await OWN.call('POST', `/split-expenses/groups/${GROUP}/recurring`, {
  title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'monthly', next_run_date: '2030-01-01', payer_id: OWN.id, participants: [OWN.id, RD.id, MGR.id],
});
assert.equal(created.status, 201, JSON.stringify(created.body));
const SERIE = created.body.data.id;

const zeile = () => db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(SERIE);
const schreibwege = [
  ['PUT', `/split-expenses/recurring/${SERIE}`, { title: 'Geaendert' }],
  ['DELETE', `/split-expenses/recurring/${SERIE}`, undefined],
  ['POST', `/split-expenses/recurring/${SERIE}/pause`, {}],
];

/** Alle drei Schreibwege: 403 mit diesem Text, und die Serie steht danach wie zuvor. */
async function abgewiesen(call, name, text) {
  const vorher = zeile();
  for (const [method, path, body] of schreibwege) {
    const r = await call(method, path, body);
    assert.equal(r.status, 403, `${name}: ${method} ${path} -> ${JSON.stringify(r.body)}`);
    if (text) assert.equal(r.body.error, text, `${name}: ${method} ${path}`);
    assert.deepEqual(zeile(), vorher, `${name}: ${method} hat nichts geschrieben`);
  }
}

test('`budget: read`: die Liste lesen geht, PUT, DELETE und Pause sind 403 am Modul-Gate', async () => {
  const liste = await RD.call('GET', `/split-expenses/groups/${GROUP}/recurring`);
  assert.equal(liste.status, 200);
  assert.equal(liste.body.data[0].title, 'Miete');
  // Die Gruppenregel liesse Rita durch - `can_edit` sagt es -, das Modulrecht nicht.
  assert.equal(liste.body.data[0].can_edit, true);
  await abgewiesen(RD.call, 'budget: read', 'You have read-only access to this module.');
});

test('Token mit Scope budget:read: lesen geht, die drei Schreibwege sind 403 am Scope-Gate', async () => {
  const token = await adminCall('POST', '/auth/api-tokens', { name: 'nur lesen', subject_user_id: MGR.id, scopes: ['budget:read'] });
  assert.equal(token.status, 201);
  const call = as({ token: token.body.token });
  assert.equal((await call('GET', `/split-expenses/groups/${GROUP}/recurring`)).status, 200);
  await abgewiesen(call, 'Token budget:read', 'Token scope does not permit this operation.');
});

test('Token ohne budget-Scope: weder lesen noch schreiben', async () => {
  const token = await adminCall('POST', '/auth/api-tokens', { name: 'nur aufgaben', subject_user_id: MGR.id, scopes: ['tasks:write'] });
  assert.equal(token.status, 201);
  const call = as({ token: token.body.token });
  assert.equal((await call('GET', `/split-expenses/groups/${GROUP}/recurring`)).status, 403);
  await abgewiesen(call, 'Token tasks:write', 'Token scope does not permit this operation.');
});

test('Display-Konto: die drei Schreibwege sind 403', async () => {
  const display = await adminCall('POST', '/displays', { display_name: 'Kueche' });
  const issued = await adminCall('POST', `/displays/${display.body.data.id}/pairing-code`, {});
  const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: issued.body.data.code }),
  });
  const token = decodeURIComponent(String(paired.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1]);
  await abgewiesen(asDisplay(token), 'Display', null);
});

test('Gegenprobe: mit Schreibrecht gehen dieselben drei Aufrufe durch', async () => {
  const put = await MGR.call(...schreibwege[0]);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(zeile().title, 'Geaendert');
  const pause = await MGR.call(...schreibwege[2]);
  assert.equal(pause.status, 200);
  assert.ok(zeile().paused_at);
  assert.equal((await MGR.call(...schreibwege[1])).status, 200);
  assert.equal(zeile(), undefined);
});
