/**
 * Test: Tote API-Tokens und widerrufene Geraete lassen sich entfernen (D#1672)
 *
 * Zweck: `DELETE /auth/api-tokens/:id` widerruft nur, und die Liste zeigte jede
 *        Zeile fuer immer - mit einem gesperrten Knopf daneben. Dasselbe bei den
 *        Wandtabletts: jede neue Kopplung widerruft das Geraet davor, und dessen
 *        Zeile blieb. Gemessen wird die Regel, nicht die Route:
 *          - was NICHT mehr gilt (widerrufen, abgelaufen), geht endgueltig;
 *          - was noch gilt, bleibt stehen, die Absage nennt ihren Grund, und
 *            das Credential funktioniert danach weiter;
 *          - wer nicht widerrufen darf, darf auch nicht entfernen;
 *          - `DELETE` heisst weiterhin "widerrufen" und loescht nichts.
 *        Und an der Oberflaeche: zwei Abschnitte, der Knopf "Entfernen" nur an
 *        toten Zeilen, "Widerrufen" nur an lebenden.
 *
 * Der echte Server (test/server-ready.js), weil Rechte, CSRF und der Riegel
 * des Auth-Routers Teil der Zusage sind - ein selbst eingehaengter Router
 * waere eine Kopie der Kette.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --experimental-sqlite --test test/test-api-token-remove.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { startTestServer, cookieHeader } from './server-ready.js';
import { installMiniDom, MiniElement } from './mini-dom.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'api-token-remove',
  env: {
    SESSION_SECRET: 'test-api-token-remove-secret-min32chars',
    RATE_LIMIT_MAX_ATTEMPTS: '40',
    RATE_LIMIT_WINDOW_MS: '60000',
  },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');

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

async function send(headers, method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const as = (session) => (method, path, body) => send(
  { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }, method, path, body,
);
const withToken = (token) => (method, path, body) => send({ Authorization: `Bearer ${token}` }, method, path, body);

const adminSession = await login('admin', 'adminpass123');
const admin = as(adminSession);
{
  const created = await admin('POST', '/auth/users', { username: 'mitglied', display_name: 'Mitglied', password: 'memberpass123' });
  assert.equal(created.status, 201, 'das Mitglied fuer die Rechteprobe entsteht');
}
const member = as(await login('mitglied', 'memberpass123'));

const tokenRow = (id) => db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);

async function mint(name, extra = {}) {
  const res = await admin('POST', '/auth/api-tokens', { name, ...extra });
  assert.equal(res.status, 201, `Token ${name} entsteht`);
  return { id: res.body.data.id, token: res.body.token };
}
/** Ablauf in die Vergangenheit: die Route selbst nimmt nur ein kuenftiges Datum an. */
function expire(id) {
  db.prepare("UPDATE api_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
}

// --------------------------------------------------------
// API-Tokens
// --------------------------------------------------------
test('ein AKTIVES Token wird nicht entfernt: 409 mit Grund, die Zeile bleibt, das Token gilt weiter', async () => {
  const { id, token } = await mint('Lebt noch');
  const res = await admin('POST', `/auth/api-tokens/${id}/remove`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'api_token_active');
  assert.equal(res.body.code, 409);
  assert.ok(tokenRow(id), 'die Zeile steht noch');
  assert.equal(tokenRow(id).revoked_at, null, 'und sie ist nicht nebenbei widerrufen worden');
  assert.equal((await withToken(token)('GET', '/auth/api-tokens')).status, 200, 'das Credential gilt weiter');
});

test('die Liste nennt je Token das Urteil des Servers, und genau die mit active:false lassen sich entfernen', async () => {
  const live = await mint('Urteil lebt');
  const revoked = await mint('Urteil widerrufen');
  const expired = await mint('Urteil abgelaufen', { expires_at: '2999-01-01T00:00:00.000Z' });
  assert.equal((await admin('POST', '/auth/api-tokens', { name: 'Urteil neu' })).body.data.active, true, 'schon die Antwort des Anlegens traegt es');
  await admin('DELETE', `/auth/api-tokens/${revoked.id}`);
  expire(expired.id);

  const { data } = (await admin('GET', '/auth/api-tokens')).body;
  const verdict = (id) => data.find((row) => row.id === id).active;
  assert.equal(verdict(live.id), true);
  assert.equal(verdict(revoked.id), false);
  assert.equal(verdict(expired.id), false);
  for (const row of data) assert.equal(typeof row.active, 'boolean', `Token ${row.id}`);

  // Feld und Route urteilen gleich: active:true -> 409, active:false -> weg.
  assert.equal((await admin('POST', `/auth/api-tokens/${live.id}/remove`, {})).status, 409);
  assert.equal((await admin('POST', `/auth/api-tokens/${revoked.id}/remove`, {})).status, 200);
  assert.equal((await admin('POST', `/auth/api-tokens/${expired.id}/remove`, {})).status, 200);
});

test('ein Token mit KUENFTIGEM Ablauf gilt als aktiv', async () => {
  const { id } = await mint('Laeuft erst ab', { expires_at: '2999-01-01T00:00:00.000Z' });
  const res = await admin('POST', `/auth/api-tokens/${id}/remove`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'api_token_active');
  assert.ok(tokenRow(id));
});

test('ein WIDERRUFENES Token wird entfernt - und nur dieses', async () => {
  const keep = await mint('Nachbar');
  const { id, token } = await mint('Widerrufen');
  assert.equal((await admin('DELETE', `/auth/api-tokens/${id}`)).status, 200);
  assert.ok(tokenRow(id).revoked_at, 'DELETE widerruft und laesst die Zeile stehen');

  const res = await admin('POST', `/auth/api-tokens/${id}/remove`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(tokenRow(id), undefined, 'die Zeile ist weg');
  assert.ok(tokenRow(keep.id), 'der Nachbar steht noch');
  assert.equal((await withToken(token)('GET', '/auth/api-tokens')).status, 401, 'das entfernte Token meldet niemanden an');

  const listed = await admin('GET', '/auth/api-tokens');
  assert.ok(!listed.body.data.some((row) => row.id === id), 'und es steht nicht mehr in der Liste');
});

test('ein ABGELAUFENES Token wird entfernt, ohne je widerrufen worden zu sein', async () => {
  const { id } = await mint('Abgelaufen', { expires_at: '2999-01-01T00:00:00.000Z' });
  expire(id);
  assert.equal(tokenRow(id).revoked_at, null);
  const res = await admin('POST', `/auth/api-tokens/${id}/remove`, {});
  assert.equal(res.status, 200);
  assert.equal(tokenRow(id), undefined);
});

test('zweimal entfernen: beim zweiten Mal gibt es die Zeile nicht mehr', async () => {
  const { id } = await mint('Doppelt');
  await admin('DELETE', `/auth/api-tokens/${id}`);
  assert.equal((await admin('POST', `/auth/api-tokens/${id}/remove`, {})).status, 200);
  assert.equal((await admin('POST', `/auth/api-tokens/${id}/remove`, {})).status, 404);
});

test('eine unbekannte Id ist 404, eine Id, die keine Zahl ist, 400 - und nichts verschwindet', async () => {
  const { id } = await mint('Zeuge');
  await admin('DELETE', `/auth/api-tokens/${id}`);
  const before = db.prepare('SELECT count(*) AS n FROM api_tokens').get().n;
  assert.equal((await admin('POST', '/auth/api-tokens/987654/remove', {})).status, 404);
  // `parseInt` laese hier die Id des Zeugen heraus und loeschte ihn.
  assert.equal((await admin('POST', `/auth/api-tokens/${id}abc/remove`, {})).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_tokens').get().n, before);
});

test('wer nicht widerrufen darf, entfernt auch nicht', async () => {
  const { id } = await mint('Fremdes');
  await admin('DELETE', `/auth/api-tokens/${id}`);

  // Die Gegenstuecke zuerst: dieselben Aufrufer scheitern auch am Widerruf.
  assert.equal((await member('DELETE', `/auth/api-tokens/${id}`)).status, 403);
  assert.equal((await member('POST', `/auth/api-tokens/${id}/remove`, {})).status, 403, 'Mitglied');
  assert.equal((await send({}, 'POST', `/auth/api-tokens/${id}/remove`, {})).status, 401, 'ohne Anmeldung');
  assert.equal(
    (await send({ Cookie: adminSession.cookie }, 'POST', `/auth/api-tokens/${id}/remove`, {})).status, 403,
    'Administrator ohne CSRF-Token',
  );
  // Ein gescoptes Token erreicht den Auth-Router gar nicht (GHSA-xcv5-6w6x-x5q2).
  const scoped = await mint('Nur Notizen', { scopes: ['notes:read'] });
  assert.equal((await withToken(scoped.token)('POST', `/auth/api-tokens/${id}/remove`, {})).status, 403, 'gescoptes Token');
  assert.ok(tokenRow(id), 'nach vier Absagen steht die Zeile noch');

  // Ein ungescoptes Administrator-Token darf widerrufen, also auch entfernen.
  const full = await mint('Voller Zugriff');
  assert.equal((await withToken(full.token)('POST', `/auth/api-tokens/${id}/remove`, {})).status, 200);
  assert.equal(tokenRow(id), undefined);
});

test('DELETE heisst weiterhin widerrufen: die Zeile bleibt, auch beim zweiten Aufruf', async () => {
  const { id } = await mint('Zusage');
  assert.equal((await admin('DELETE', `/auth/api-tokens/${id}`)).status, 200);
  const first = tokenRow(id).revoked_at;
  assert.ok(first);
  assert.equal((await admin('DELETE', `/auth/api-tokens/${id}`)).status, 200);
  assert.equal(tokenRow(id).revoked_at, first, 'der Zeitpunkt verschiebt sich nicht');
});

// --------------------------------------------------------
// Geraete eines Wandtabletts
// --------------------------------------------------------
async function pairedDisplay(name) {
  const created = await admin('POST', '/displays', { display_name: name });
  assert.equal(created.status, 201);
  const displayId = created.body.data.id;
  const pair = async () => {
    const issued = await admin('POST', `/displays/${displayId}/pairing-code`, {});
    const res = await fetch(`${BASE}/api/v1/displays/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: issued.body.data.code }),
    });
    assert.equal(res.status, 201, 'Kopplung');
    const match = String(res.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`));
    return decodeURIComponent(match[1]);
  };
  const devices = async () => (await admin('GET', '/displays')).body.data.find((d) => d.id === displayId).devices;
  return { displayId, pair, devices };
}
const deviceRow = (id) => db.prepare('SELECT * FROM display_devices WHERE id = ?').get(id);

test('ein GEKOPPELTES Geraet wird nicht entfernt: 409 mit Grund, und das Tablett laeuft weiter', async () => {
  const { displayId, pair, devices } = await pairedDisplay('Kueche');
  const cookie = await pair();
  const [device] = await devices();

  const res = await admin('POST', `/displays/${displayId}/devices/${device.id}/remove`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'display_device_active');
  assert.ok(deviceRow(device.id));
  assert.equal(deviceRow(device.id).revoked_at, null);
  assert.equal((await send({ Cookie: `${DISPLAY_COOKIE}=${cookie}` }, 'GET', '/tasks')).status, 200, 'das Tablett liest weiter');
});

test('das von einer neuen Kopplung widerrufene Geraet wird entfernt, das neue bleibt', async () => {
  const { displayId, pair, devices } = await pairedDisplay('Flur');
  await pair();
  await pair();
  const list = await devices();
  assert.equal(list.length, 2, 'zwei Zeilen: genau die Luecke aus der Discussion');
  const dead = list.find((d) => d.revoked_at);
  const alive = list.find((d) => !d.revoked_at);

  const res = await admin('POST', `/displays/${displayId}/devices/${dead.id}/remove`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { id: dead.id, removed: true });
  assert.equal(deviceRow(dead.id), undefined);
  assert.ok(deviceRow(alive.id), 'das gekoppelte Geraet steht noch');
  assert.deepEqual((await devices()).map((d) => d.id), [alive.id]);
  assert.equal((await admin('POST', `/displays/${displayId}/devices/${dead.id}/remove`, {})).status, 404, 'zweimal: weg ist weg');
});

test('das Geraet muss zu DIESEM Display gehoeren, und nur ein Administrator entfernt', async () => {
  const one = await pairedDisplay('Eins');
  const two = await pairedDisplay('Zwei');
  await one.pair();
  const [device] = await one.devices();
  assert.equal((await admin('POST', `/displays/${one.displayId}/devices/${device.id}/revoke`, {})).status, 200);

  assert.equal((await admin('POST', `/displays/${two.displayId}/devices/${device.id}/remove`, {})).status, 404, 'falsches Display');
  assert.equal((await admin('POST', `/displays/${one.displayId}/devices/987654/remove`, {})).status, 404, 'unbekanntes Geraet');
  assert.equal((await member('POST', `/displays/${one.displayId}/devices/${device.id}/remove`, {})).status, 403, 'Mitglied');
  assert.equal(
    (await send({ Cookie: adminSession.cookie }, 'POST', `/displays/${one.displayId}/devices/${device.id}/remove`, {})).status, 403,
    'Administrator ohne CSRF-Token',
  );
  assert.ok(deviceRow(device.id), 'nach vier Absagen steht die Zeile noch');
  assert.equal((await admin('POST', `/displays/${one.displayId}/devices/${device.id}/remove`, {})).status, 200);
});

// --------------------------------------------------------
// Katalog
// --------------------------------------------------------
test('der Katalog nennt beide Routen mit ihrer Absage, und DELETE bleibt der Widerruf', () => {
  const { paths } = buildOpenApiSpec({}, 'test');
  const token = paths['/api/v1/auth/api-tokens/{id}/remove']?.post;
  assert.ok(token, 'Token-Route fehlt im Katalog');
  assert.match(token.responses[409].description, /api_token_active/);
  assert.ok(token.responses[403] && token.responses[404]);
  assert.deepEqual(token.parameters.filter((p) => p.in === 'path').map((p) => p.name), ['id']);

  const device = paths['/api/v1/displays/{id}/devices/{deviceId}/remove']?.post;
  assert.ok(device, 'Geraete-Route fehlt im Katalog');
  assert.match(device.responses[409].description, /display_device_active/);
  assert.deepEqual(device.parameters.filter((p) => p.in === 'path').map((p) => p.name), ['id', 'deviceId']);

  assert.equal(paths['/api/v1/auth/api-tokens/{id}'].delete.summary, 'Revoke API token');
  assert.equal(buildOpenApiSpec({}, 'test').components.schemas.ApiToken.properties.active.type, 'boolean');
});

// --------------------------------------------------------
// Oberflaeche: API-Zugang
// --------------------------------------------------------
const restoreDom = installMiniDom();
test.after(restoreDom);
const page = await import('../public/settings/pages/admin-api.js');

const NOW = Date.parse('2026-10-06T12:00:00Z');
const TOKENS = [
  { id: 1, name: 'Aktiv', token_prefix: 'yuvomi_aaaa', scopes: null, expires_at: null, revoked_at: null, last_used_at: null },
  { id: 2, name: 'Laeuft noch', token_prefix: 'yuvomi_bbbb', scopes: null, expires_at: '2026-10-07T12:00:00Z', revoked_at: null, last_used_at: null },
  { id: 3, name: 'Widerrufen', token_prefix: 'yuvomi_cccc', scopes: null, expires_at: null, revoked_at: '2026-10-01T08:00:00Z', last_used_at: null },
  { id: 4, name: 'Abgelaufen', token_prefix: 'yuvomi_dddd', scopes: null, expires_at: '2026-10-05T12:00:00Z', revoked_at: null, last_used_at: null },
  // Widerrufen UND noch nicht abgelaufen: der Widerruf entscheidet.
  { id: 5, name: 'Beides', token_prefix: 'yuvomi_eeee', scopes: null, expires_at: '2999-01-01T00:00:00Z', revoked_at: '2026-10-01T08:00:00Z', last_used_at: null },
];

/** Ein Container, der genau die Knoten kennt, die der Renderer anfasst. */
function fakeContainer({ withInactive = true } = {}) {
  const nodes = {
    '#api-token-list': new MiniElement('ul'),
    ...(withInactive ? {
      '#api-token-inactive-section': Object.assign(new MiniElement('section'), { hidden: true }),
      '#api-token-inactive-list': new MiniElement('ul'),
    } : {}),
  };
  return { nodes, querySelector: (selector) => nodes[selector] ?? null };
}
const ids = (html, attr) => [...html.matchAll(new RegExp(`${attr}="(\\d+)"`, 'g'))].map((m) => Number(m[1]));

test('isApiTokenActive: widerrufen und abgelaufen gelten nicht mehr, der Rest schon', () => {
  assert.deepEqual(TOKENS.map((token) => page.isApiTokenActive(token, NOW)), [true, true, false, false, false]);
  // Genau am Ablaufzeitpunkt ist es vorbei - wie am Server (`expires_at > jetzt`).
  assert.equal(page.isApiTokenActive({ expires_at: '2026-10-06T12:00:00Z', revoked_at: null }, NOW), false);
});

test('die Liste teilt sich: aktive oben mit Widerrufen, tote im zweiten Abschnitt mit Entfernen', () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const container = fakeContainer();
    page.renderApiTokenList(container, TOKENS);
    const active = container.nodes['#api-token-list'].innerHTML;
    const inactive = container.nodes['#api-token-inactive-list'].innerHTML;

    assert.deepEqual(ids(active, 'data-api-token-id'), [1, 2]);
    assert.deepEqual(ids(inactive, 'data-api-token-id'), [3, 4, 5]);
    assert.equal(container.nodes['#api-token-inactive-section'].hidden, false, 'der zweite Abschnitt steht da');

    // Der Knopf folgt dem Zustand - in BEIDE Richtungen.
    assert.deepEqual(ids(active, 'data-revoke-api-token'), [1, 2]);
    assert.deepEqual(ids(active, 'data-remove-api-token'), [], 'kein Entfernen an einem aktiven Token');
    assert.deepEqual(ids(inactive, 'data-remove-api-token'), [3, 4, 5]);
    assert.deepEqual(ids(inactive, 'data-revoke-api-token'), [], 'kein Widerrufen an einem toten Token');
    assert.doesNotMatch(active + inactive, /<button[^>]*\sdisabled/, 'kein gesperrter Knopf mehr als Platzhalter');

    // Der Kanon der Zeilenaktion (utils/row-action.js), und der Name nennt das Token.
    assert.match(inactive, /<button type="button" class="row-action row-action--danger" aria-label="common\.removeNamed\{&quot;name&quot;:&quot;Widerrufen&quot;\}" data-remove-api-token="3"/);
    assert.match(active, /aria-label="settings\.apiTokenRevoke"/);
    // Der Zustand steht weiter in der Zeile: der Abschnitt sagt "nicht mehr", die Zeile sagt warum.
    assert.match(inactive, /settings\.apiTokenRevoked/);
    assert.match(inactive, /settings\.apiTokenExpired/);
    assert.doesNotMatch(inactive, /settings\.apiTokenActive/);
  } finally {
    Date.now = realNow;
  }
});

test('das Urteil des Servers schlaegt die Uhr des Geraets - in beide Richtungen', () => {
  // Die Uhr des Browsers geht vor: fuer sie ist das Token abgelaufen, der Server
  // meldet es noch an. Es muss unter "Widerrufen" stehen, sonst kaeme niemand
  // mehr heran - Entfernen antwortet 409, und Widerrufen stuende nirgends.
  const stillValid = { ...TOKENS[3], id: 7, active: true };
  // Und umgekehrt: fuer die nachgehende Uhr laeuft es noch, am Server ist es vorbei.
  const alreadyOver = { ...TOKENS[1], id: 8, active: false };
  assert.equal(page.isApiTokenActive(stillValid, NOW), true);
  assert.equal(page.isApiTokenActive(alreadyOver, NOW), false);
  // Ein Widerruf, den die Seite selbst gerade eingetragen hat, schlaegt ein altes `active`.
  assert.equal(page.isApiTokenActive({ ...TOKENS[0], active: true, revoked_at: '2026-10-06T11:00:00Z' }, NOW), false);

  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const container = fakeContainer();
    page.renderApiTokenList(container, [stillValid, alreadyOver]);
    assert.deepEqual(ids(container.nodes['#api-token-list'].innerHTML, 'data-revoke-api-token'), [7]);
    assert.deepEqual(ids(container.nodes['#api-token-inactive-list'].innerHTML, 'data-remove-api-token'), [8]);
    assert.match(container.nodes['#api-token-list'].innerHTML, /settings\.apiTokenActive/);
    assert.match(container.nodes['#api-token-inactive-list'].innerHTML, /settings\.apiTokenExpired/);
  } finally {
    Date.now = realNow;
  }
});

test('ohne tote Tokens gibt es keinen zweiten Abschnitt, ohne aktive einen Satz dafuer', () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const onlyActive = fakeContainer();
    page.renderApiTokenList(onlyActive, TOKENS.slice(0, 2));
    assert.equal(onlyActive.nodes['#api-token-inactive-section'].hidden, true);
    assert.equal(onlyActive.nodes['#api-token-inactive-list'].innerHTML, '');

    const onlyDead = fakeContainer();
    page.renderApiTokenList(onlyDead, TOKENS.slice(2));
    assert.match(onlyDead.nodes['#api-token-list'].innerHTML, /settings\.apiTokensNoneActive/);
    assert.doesNotMatch(onlyDead.nodes['#api-token-list'].innerHTML, /settings\.apiTokensEmpty/,
      '"noch keine Tokens" waere falsch: es gibt welche, nur keine aktiven');
    assert.equal(onlyDead.nodes['#api-token-inactive-section'].hidden, false);

    const none = fakeContainer();
    page.renderApiTokenList(none, []);
    assert.match(none.nodes['#api-token-list'].innerHTML, /settings\.apiTokensEmpty/);
    assert.equal(none.nodes['#api-token-inactive-section'].hidden, true);

    // Nach dem Entfernen des letzten toten Tokens verschwindet der Abschnitt wieder.
    const shrinking = fakeContainer();
    page.renderApiTokenList(shrinking, TOKENS);
    page.renderApiTokenList(shrinking, TOKENS.slice(0, 2));
    assert.equal(shrinking.nodes['#api-token-inactive-section'].hidden, true);
  } finally {
    Date.now = realNow;
  }
});

test('ein Tokenname mit Markup bleibt Text, auch am Entfernen-Knopf', () => {
  const container = fakeContainer();
  page.renderApiTokenList(container, [{ ...TOKENS[2], name: '"><img src=x onerror=alert(1)>' }]);
  const html = container.nodes['#api-token-inactive-list'].innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-remove-api-token="3"/);
});

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('die Seite: zwei Abschnitte mit Titel, Entfernen fragt vorher und liest den Grund der Absage', () => {
  const source = read('../public/settings/pages/admin-api.js');
  const section = source.slice(source.indexOf('id="api-token-inactive-section"'));
  assert.match(section, /^id="api-token-inactive-section" hidden>\s*<h2 class="settings-section__title">\$\{t\('settings\.apiTokensInactiveTitle'\)\}<\/h2>/,
    'der zweite Abschnitt traegt den Abschnittstitel der Einstellungsseiten und startet verborgen');
  assert.equal(source.match(/<section class="settings-section"/g).length, 2);

  const handler = source.slice(source.indexOf("closest('[data-remove-api-token]')"));
  const call = handler.slice(handler.indexOf('confirmModal('), handler.indexOf('api.post('));
  assert.match(call, /settings\.apiTokenRemoveConfirm/);
  assert.match(call, /danger: true/);
  assert.match(call, /detail: t\('settings\.apiTokenRemoveDetail'\)/);
  assert.match(handler, /api\.post\(`\/auth\/api-tokens\/\$\{id\}\/remove`/);
  assert.match(handler, /reason === 'api_token_active'/);
  assert.match(handler, /settings\.apiTokenRemoveActive/);
  // Kein Rueckgaengig: die Zeile samt Hash ist weg.
  assert.doesNotMatch(handler, /scheduleUndoableDelete|undo/i);
});

test('die Wandtablett-Seite: Entfernen nur an der widerrufenen Zeile, mit Rueckfrage und Grund', () => {
  const source = read('../public/settings/pages/admin-displays.js');
  const row = source.slice(source.indexOf('function renderDevice'), source.indexOf('function renderDisplay('));
  const [whenRevoked, whenPaired] = row.slice(row.indexOf('${revoked ? `')).split('` : `');
  assert.match(whenRevoked, /data-display-remove-device=/);
  assert.doesNotMatch(whenRevoked, /data-display-revoke=/);
  assert.match(whenPaired, /data-display-revoke=/);
  assert.doesNotMatch(whenPaired, /data-display-remove-device=/);

  const handler = source.slice(source.indexOf("closest('[data-display-remove-device]')"), source.indexOf("closest('[data-display-delete]')"));
  const call = handler.slice(handler.indexOf('confirmModal('), handler.indexOf('api.post('));
  assert.match(call, /danger: true/);
  assert.match(call, /detail: t\('settings\.displayRemoveDeviceDetail'\)/);
  assert.match(handler, /\/devices\/\$\{remove\.dataset\.device\}\/remove`/);
  assert.match(handler, /reason === 'display_device_active'/);
  assert.match(handler, /settings\.displayRemoveDeviceActive/);
});

test('jeder neue Satz steht in jeder Sprache, uebersetzt und ohne Gedankenstrich', () => {
  const KEYS = [
    'apiTokensInactiveTitle', 'apiTokensInactiveHint', 'apiTokensNoneActive', 'apiTokenRemove',
    'apiTokenRemoveConfirm', 'apiTokenRemoveDetail', 'apiTokenRemovedToast', 'apiTokenRemoveActive',
    'displayRemoveDevice', 'displayRemoveDeviceConfirm', 'displayRemoveDeviceDetail', 'displayRemoveDeviceActive',
  ];
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26, `zu wenige Sprachdateien gelesen (${files.length})`);
  const settings = Object.fromEntries(files.map((name) => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8')).settings]));
  for (const key of KEYS) {
    for (const name of files) {
      const text = settings[name][key];
      assert.ok(typeof text === 'string' && text.trim(), `${name}: settings.${key} fehlt`);
      assert.doesNotMatch(text, /[–—]|\[de:/, `${name}: settings.${key}`);
      if (name === 'de.json' || name === 'en.json') continue;
      assert.notEqual(text, settings['de.json'][key], `${name}: settings.${key} ist der deutsche Satz`);
      assert.notEqual(text, settings['en.json'][key], `${name}: settings.${key} ist der englische Satz`);
    }
    // Die Rueckfrage nennt das Token beim Namen - in jeder Sprache.
    if (key === 'apiTokenRemoveConfirm') {
      for (const name of files) assert.match(settings[name][key], /\{\{name\}\}/, `${name}: {{name}} fehlt`);
    }
  }
});
