/**
 * Test: Kopplung eines angemeldeten Geraets (Vorbereitung des nativen Clients, Refs #255)
 *
 * Zweck: Ein Haushalt nur mit SSO hat kein Passwort, das jemand in eine App tippen
 *        koennte. Eine Browser-Sitzung stellt deshalb einen kurzen Code aus, und die
 *        App tauscht ihn gegen ein Device Credential.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Ausstellen geht nur aus einer Sitzung und nur fuer Haushaltsmitglieder.
 *   2. Ein Code gilt einmal und fuenf Minuten, ein neuer entwertet den alten.
 *   3. "Unbekannt", "abgelaufen" und "benutzt" antworten gleich.
 *   4. Personen-Codes und Display-Codes taugen nie fuer den anderen Weg.
 *   5. Was ein Konto beendet oder seine Sitzungen abraeumt, entwertet offene Codes.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-device-pairing.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'device-pairing',
  env: {
    SESSION_SECRET: 'test-device-pairing-secret-min32chars',
    RATE_LIMIT_MAX_ATTEMPTS: 60,
  },
});

const API = `${BASE}/api/v1`;
const json = { 'Content-Type': 'application/json' };
const ORIGIN = 'https://yuvomi.example.org';

async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: json, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `Anmeldung ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

const sessionHeaders = (s) => ({ ...json, Cookie: s.cookie, 'X-CSRF-Token': s.csrfToken });
const bearer = (credential) => ({ ...json, Authorization: `Bearer ${credential}` });

await fetch(`${API}/auth/setup`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');

let memberCounter = 0;
async function member() {
  memberCounter += 1;
  const username = `member${memberCounter}`;
  const password = `${username}pass1234`;
  const res = await fetch(`${API}/auth/users`, {
    method: 'POST',
    headers: sessionHeaders(admin),
    body: JSON.stringify({ username, display_name: username, password }),
  });
  assert.equal(res.status, 201, `Mitglied ${username} angelegt`);
  const created = await res.json();
  const id = created.user?.id ?? created.data?.id;
  return { id, username, password, session: await login(username, password) };
}

const db = (await import('../server/db.js')).get();

function pair(session, body = { server: ORIGIN }) {
  return fetch(`${API}/auth/devices/pair`, {
    method: 'POST', headers: sessionHeaders(session), body: JSON.stringify(body),
  });
}

async function issue(session) {
  const res = await pair(session);
  assert.equal(res.status, 201, 'Code ausgestellt');
  return (await res.json()).data;
}

let deviceCounter = 0;
function redeem(code, overrides = {}) {
  deviceCounter += 1;
  return fetch(`${API}/auth/devices/pair/redeem`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      code, name: `Telefon ${deviceCounter}`, platform: 'ios', device_id: `paired-${deviceCounter}-device`, ...overrides,
    }),
  });
}

async function assertInvalidCode(res, message) {
  assert.equal(res.status, 400, message);
  const body = await res.json();
  assert.equal(body.reason, 'invalid_pairing_code', message);
  assert.equal(body.credential, undefined, message);
  return body;
}

test('ein Mitglied koppelt ein Geraet, ohne dass die App je ein Passwort sieht', async () => {
  const { id, session } = await member();
  const issued = await issue(session);
  assert.match(issued.code, /^[ACDEFGHJKMNPQRTUVWXY34679]{10}$/);
  assert.ok(issued.qr.startsWith('data:image/svg+xml;base64,'), 'QR als Data-URL');
  assert.equal(issued.link, `yuvomi://pair?server=${encodeURIComponent(ORIGIN)}&code=${issued.code}`);

  const res = await redeem(issued.code, { name: 'Mein iPhone', device_id: 'my-iphone-install' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.name, 'Mein iPhone');
  assert.equal(body.data.platform, 'ios');

  const me = await fetch(`${API}/auth/me`, { headers: bearer(body.credential) });
  assert.equal(me.status, 200, 'das Credential taugt');
  assert.equal((await me.json()).user.id, id, 'und gehoert der Person, die den Code ausgestellt hat');

  const row = db.prepare("SELECT kind, subject_user_id, created_by, device_id FROM api_tokens WHERE id = ?").get(body.data.id);
  assert.deepEqual({ ...row }, { kind: 'device', subject_user_id: id, created_by: id, device_id: 'my-iphone-install' });
});

test('der Code steht nur gehasht in der Datenbank', async () => {
  const { id, session } = await member();
  const { code } = await issue(session);
  const row = db.prepare('SELECT code_hash FROM device_pairing_codes WHERE user_id = ?').get(id);
  assert.notEqual(row.code_hash, code);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
});

test('Laufzeit: fuenf Minuten, knapp davor gilt der Code, danach nicht mehr', async () => {
  const { id, session } = await member();
  const before = Date.now();
  const first = await issue(session);
  const ttl = Date.parse(first.expires_at) - before;
  assert.ok(ttl > 4 * 60_000 && ttl <= 5 * 60_000 + 1000, `Laufzeit ${ttl} ms`);

  const setExpiry = (offsetMs) => db.prepare(`
    UPDATE device_pairing_codes SET expires_at = ? WHERE user_id = ? AND used_at IS NULL
  `).run(new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), id);

  setExpiry(-1000);
  const expired = await assertInvalidCode(await redeem(first.code), 'abgelaufen');
  assert.deepEqual(expired, await assertInvalidCode(await redeem('AAAAACCCCC'), 'unbekannt'), 'dieselbe Antwort');

  const second = await issue(session);
  setExpiry(5000);
  assert.equal((await redeem(second.code)).status, 201, 'kurz vor Ablauf gilt er noch');
});

test('ein Code gilt einmal, und die Absage klingt wie bei einem unbekannten', async () => {
  const { session } = await member();
  const { code } = await issue(session);
  assert.equal((await redeem(code)).status, 201);

  const spent = await assertInvalidCode(await redeem(code), 'benutzt');
  const unknown = await assertInvalidCode(await redeem('AAAAACCCCC'), 'unbekannt');
  assert.deepEqual(spent, unknown, 'dieselbe Antwort fuer beide Faelle');
});

test('ein neuer Code entwertet den alten', async () => {
  const { session } = await member();
  const older = await issue(session);
  const newer = await issue(session);
  await assertInvalidCode(await redeem(older.code), 'alter Code');
  assert.equal((await redeem(newer.code)).status, 201);
});

test('getippt zaehlt nur der Code: Kleinschreibung und Trennzeichen schaden nicht', async () => {
  const { session } = await member();
  const { code } = await issue(session);
  const typed = `${code.slice(0, 5)}-${code.slice(5)} `.toLowerCase();
  assert.equal((await redeem(typed)).status, 201);
});

test('ein ungueltiger Rumpf verbraucht den Code nicht', async () => {
  const { session } = await member();
  const { code } = await issue(session);
  for (const overrides of [{ name: '' }, { platform: 'iOS!' }, { device_id: 'x' }]) {
    const res = await redeem(code, overrides);
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.equal((await res.json()).reason, undefined, 'das ist kein Urteil ueber den Code');
  }
  assert.equal((await redeem(code)).status, 201, 'der Code gilt noch');
});

test('dieselbe device_id ersetzt, auch beim Koppeln', async () => {
  const { id, session } = await member();
  const first = await (await redeem((await issue(session)).code, { device_id: 'same-install' })).json();
  const second = await (await redeem((await issue(session)).code, { device_id: 'same-install' })).json();

  assert.equal((await fetch(`${API}/auth/me`, { headers: bearer(first.credential) })).status, 401);
  assert.equal((await fetch(`${API}/auth/me`, { headers: bearer(second.credential) })).status, 200);
  const active = db.prepare(`
    SELECT COUNT(*) AS n FROM api_tokens WHERE subject_user_id = ? AND kind = 'device' AND revoked_at IS NULL
  `).get(id);
  assert.equal(active.n, 1);
});

test('Ausstellen geht nur aus einer Sitzung', async () => {
  const { session } = await member();
  const { credential } = await (await redeem((await issue(session)).code)).json();

  const byDevice = await fetch(`${API}/auth/devices/pair`, {
    method: 'POST', headers: bearer(credential), body: JSON.stringify({ server: ORIGIN }),
  });
  assert.equal(byDevice.status, 403, 'ein Geraet stellt keinen Code aus');
  assert.equal((await byDevice.json()).reason, 'device_credential');

  const anonymous = await fetch(`${API}/auth/devices/pair`, {
    method: 'POST', headers: json, body: JSON.stringify({ server: ORIGIN }),
  });
  assert.equal(anonymous.status, 401);

  const token = `yuvomi_integration_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id)
    VALUES ('Integration', ?, 'yuvomi_integ', 1, 1)
  `).run(crypto.createHash('sha256').update(token).digest('hex'));
  const byToken = await fetch(`${API}/auth/devices/pair`, {
    method: 'POST', headers: bearer(token), body: JSON.stringify({ server: ORIGIN }),
  });
  assert.equal(byToken.status, 403, 'ein Integrations-Token auch nicht');
  assert.equal((await byToken.json()).reason, 'session_required');
});

test('die CSRF-Pruefung gilt beim Ausstellen', async () => {
  const { session } = await member();
  const res = await fetch(`${API}/auth/devices/pair`, {
    method: 'POST', headers: { ...json, Cookie: session.cookie }, body: JSON.stringify({ server: ORIGIN }),
  });
  assert.equal(res.status, 403);
});

test('Personal und Gaeste bekommen keinen Code', async () => {
  const worker = await member();
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(worker.id);
  const byWorker = await pair(worker.session);
  assert.equal(byWorker.status, 403, 'Personal');
  assert.equal((await byWorker.json()).reason, 'not_a_household_member');

  const guest = await member();
  db.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guest.id);
  const byGuest = await pair(guest.session);
  assert.equal(byGuest.status, 403, 'Gast');
  assert.equal((await byGuest.json()).reason, 'not_a_household_member');
});

test('wer zwischen Ausstellen und Einloesen die Mitgliedschaft verliert, bekommt kein Credential', async () => {
  const worker = await member();
  const { code } = await issue(worker.session);
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(worker.id);
  await assertInvalidCode(await redeem(code), 'Personal beim Einloesen');
  const rows = db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE subject_user_id = ?").get(worker.id);
  assert.equal(rows.n, 0);
});

test('ein gueltiges Credential loest keinen Code ein', async () => {
  const { session } = await member();
  const { credential } = await (await redeem((await issue(session)).code)).json();
  const { code } = await issue(session);
  const res = await fetch(`${API}/auth/devices/pair/redeem`, {
    method: 'POST',
    headers: bearer(credential),
    body: JSON.stringify({ code, name: 'Zweites', platform: 'ios', device_id: 'second-device' }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'device_credential');
  assert.equal((await redeem(code)).status, 201, 'der Code gilt weiter');
});

test('ein Code, der keine Zeichenkette ist, bekommt dieselbe Absage', async () => {
  for (const code of [undefined, null, 42, { toString: null }, ['AAAAACCCCC']]) {
    await assertInvalidCode(await redeem(code), JSON.stringify(code));
  }
});

test('die OpenAPI fuehrt das Einloesen als oeffentlich', async () => {
  const { authPaths } = await import('../server/openapi/paths/auth.js');
  const paths = authPaths();
  assert.equal(paths['/api/v1/auth/devices/pair/redeem'].post.security, undefined);
  assert.ok(paths['/api/v1/auth/devices/pair'].post.security.length > 0);
});

test('die Herkunft muss eine blosse http(s)-Adresse sein', async () => {
  const { session } = await member();
  for (const server of [
    undefined, '', 42, 'javascript:alert(1)', 'yuvomi://pair', 'ftp://example.org',
    'https://example.org/pfad', 'https://example.org/', 'https://user:pw@example.org',
    `https://${'a'.repeat(400)}.example.org`, `https://${'$'.repeat(60)}.example.org`,
  ]) {
    const res = await pair(session, { server });
    assert.equal(res.status, 400, `abgewiesen: ${String(server).slice(0, 40)}`);
  }
  for (const server of ['http://192.168.1.20:3000', 'https://yuvomi.example.org:8443', 'http://[::1]:3000']) {
    assert.equal((await pair(session, { server })).status, 201, server);
  }
});

test('auch die laengste zugelassene Herkunft passt in den QR-Code', async () => {
  const { session } = await member();
  const label = 'a'.repeat(60);
  const longest = `https://${label}.${label}.${'a'.repeat(12)}.example.org:65535`;
  assert.equal(longest.length, 160);
  assert.equal((await pair(session, { server: longest })).status, 201);
});

test('Gegenprobe: ein Personen-Code oeffnet kein Wandtablett', async () => {
  const { session } = await member();
  const { code } = await issue(session);

  const res = await fetch(`${API}/displays/pair`, {
    method: 'POST', headers: json, body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 400, '/displays/pair kennt den Code nicht');
  assert.doesNotMatch(res.headers.get('set-cookie') ?? '', /yuvomi\.display/, 'kein Display-Cookie');
  assert.equal((await redeem(code)).status, 201, 'und er gilt danach weiter');
});

test('Gegenprobe: ein Display-Code meldet kein Geraet an', async () => {
  const display = await fetch(`${API}/displays`, {
    method: 'POST', headers: sessionHeaders(admin), body: JSON.stringify({ display_name: 'Kueche' }),
  });
  assert.equal(display.status, 201);
  const { id } = (await display.json()).data;
  const issued = await fetch(`${API}/displays/${id}/pairing-code`, { method: 'POST', headers: sessionHeaders(admin) });
  assert.equal(issued.status, 201);
  const { code } = (await issued.json()).data;
  await assertInvalidCode(await redeem(code), 'Display-Code');
});

test('was alle Sitzungen beendet, entwertet auch den offenen Code', async () => {
  const { session } = await member();
  const { code } = await issue(session);
  const res = await fetch(`${API}/auth/logout-others`, { method: 'POST', headers: sessionHeaders(session) });
  assert.equal(res.status, 200);
  await assertInvalidCode(await redeem(code), 'nach "Auf anderen Geraeten abmelden"');
});

test('Abmelden entwertet den offenen Code', async () => {
  const { session } = await member();
  const { code } = await issue(session);
  const res = await fetch(`${API}/auth/logout`, { method: 'POST', headers: sessionHeaders(session) });
  assert.equal(res.status, 200);
  await assertInvalidCode(await redeem(code), 'nach dem Abmelden');
});

test('Deaktivieren entwertet offene Codes, nicht erst die Pruefung beim Einloesen', async () => {
  const { id, session } = await member();
  // Wer Spuren im Haushalt hinterlassen hat, wird deaktiviert statt geloescht.
  const task = await fetch(`${API}/tasks`, {
    method: 'POST', headers: sessionHeaders(session), body: JSON.stringify({ title: 'Spur' }),
  });
  assert.equal(task.status, 201);
  const { code } = await issue(session);
  const res = await fetch(`${API}/auth/users/${id}`, { method: 'DELETE', headers: sessionHeaders(admin) });
  assert.equal(res.status, 200);
  assert.ok(db.prepare('SELECT deactivated_at FROM users WHERE id = ?').get(id)?.deactivated_at, 'das Konto ist deaktiviert');
  const row = db.prepare('SELECT used_at FROM device_pairing_codes WHERE user_id = ?').get(id);
  assert.ok(row.used_at, 'die Zeile ist verbraucht');
  await assertInvalidCode(await redeem(code), 'Ehemalige');
});

test('Loeschen nimmt die Zeilen mit', async () => {
  const { id, session } = await member();
  await issue(session);
  const res = await fetch(`${API}/auth/users/${id}`, { method: 'DELETE', headers: sessionHeaders(admin) });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT COUNT(*) AS n FROM device_pairing_codes WHERE user_id = ?').get(id);
  assert.equal(row.n, 0);
});

test('das Einloesen ist begrenzt, jeder Versuch zaehlt', async () => {
  // Eine eigene Grenze ohne zweiten Server: die Suite laeuft mit 60 Versuchen,
  // alle vorherigen Faelle zaehlen mit, und der Limiter schliesst spaetestens hier.
  // Doppelt so viele Runden, weil das Fenster mitten in der Schleife enden kann.
  let limited = null;
  for (let i = 0; i < 125 && !limited; i += 1) {
    const res = await redeem('AAAAACCCCC');
    if (res.status === 429) limited = res;
    else assert.equal(res.status, 400);
  }
  assert.ok(limited, 'nach 60 Versuchen kommt 429');
  assert.equal((await limited.json()).code, 429);
});
