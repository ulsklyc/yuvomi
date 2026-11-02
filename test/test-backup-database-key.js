/**
 * Test: Anzeige des selbst erzeugten Datenbankschluessels (Admin -> Backups)
 *
 * Zweck: Yuvomi erzeugt den DB_ENCRYPTION_KEY einer Neuinstallation selbst und
 *        legt ihn neben die Datenbank (server/utils/auto-secrets.js). Ohne eine
 *        Kopie davon oeffnet sich nach dem Verlust des Volumes kein Backup mehr,
 *        also zeigt `GET /api/v1/backup/database-key` ihn dem Admin. Das ist der
 *        eine Weg, auf dem der Schluessel das Haus verlaesst - darum misst diese
 *        Suite vor allem, wann er es NICHT tut.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Ein Admin mit Sitzung bekommt den Wert, wenn Yuvomi ihn erzeugt
 *      ('generated') oder aus `.secrets/` gelesen hat ('stored') - und es ist
 *      der Wert aus der Datei.
 *   2. Kein Wert fuer ein Mitglied (403) und fuer das GERAET eines Admins
 *      (`api_tokens.kind = 'device'`, 403 `device_credential`): ein verlorenes
 *      Telefon reicht nicht an den Schluessel.
 *   3. Kein Wert bei 'env', 'file', ohne Verschluesselung und bei unbekannter
 *      Herkunft (`null`: der Handschlag lief nicht).
 *   4. `Cache-Control: no-store` auf jeder Antwort, der Status nennt nur die
 *      Herkunft, das Log nennt den Admin und nie den Wert, das Rate-Limit greift.
 *
 * Laeuft gegen den echten server/index.js samt Handschlag, mit eigenem TMPDIR:
 * der Schluessel landet unter `<Verzeichnis der DB>/.secrets/`, und die Test-DBs
 * aller anderen Suiten liegen in os.tmpdir() - ein Schluessel dort galte fuer
 * jede von ihnen.
 *
 * Ausfuehren: npm run test:backup-database-key
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './tmp-dir.js';
// Statisch, nicht per await import(): test:db-isolation erkennt den Helfer, der
// DB_PATH setzt, nur als statischen Import. server-ready.js laedt selbst nichts
// beim Import, der Server startet erst im Aufruf unten - nach dem Mitschreiben.
import { startTestServer, cookieHeader } from './server-ready.js';

const PRIVATE_TMP = tempDir('yuvomi-backup-database-key-');
process.env.TMPDIR = PRIVATE_TMP;
delete process.env.DB_ENCRYPTION_KEY;
delete process.env.DB_ENCRYPTION_KEY_FILE;

// Alles mitschreiben, was der Prozess loggt - auch den Handschlag beim Import.
const logged = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); original(...args); };
}
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };

const { baseUrl, dbPath } = await startTestServer({
  name: 'backup-database-key',
  env: { SESSION_SECRET: 'test-backup-database-key-secret-32chars', DB_ENCRYPTION_AUTO_KEY: 'true' },
});
const { applyAutoSecrets, _resetAutoSecretState } = await import('../server/utils/auto-secrets.js');

const API = `${baseUrl}/api/v1`;
const json = { 'Content-Type': 'application/json' };
const KEY_FILE = path.join(path.dirname(dbPath), '.secrets', 'DB_ENCRYPTION_KEY');
const GENERATED_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();

async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `Anmeldung ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken, id: me.user?.id ?? me.data?.id };
}
const sessionHeaders = (s) => ({ ...json, Cookie: s.cookie, 'X-CSRF-Token': s.csrfToken });

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: json,
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const admin = await login('admin', 'adminpass123');

const getKey = (headers = sessionHeaders(admin)) => fetch(`${API}/backup/database-key`, { headers });

/** Herkunft so setzen, wie der Handschlag sie mit `env` gemerkt haette. */
function handshake(env, fromFile = []) {
  _resetAutoSecretState();
  const dir = tempDir('handshake-');
  applyAutoSecrets({
    env: { SESSION_SECRET: 'x'.repeat(32), DB_PATH: path.join(dir, 'yuvomi.db'), ...env },
    fromFile,
    log: { info() {}, warn() {} },
  });
  return dir;
}

test('Neuinstallation: der Admin sieht den erzeugten Schluessel, und es ist der aus der Datei', async () => {
  assert.match(GENERATED_KEY, /^[0-9a-f]{64}$/, 'der Handschlag hat einen Schluessel erzeugt');
  const res = await getKey();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { data } = await res.json();
  assert.equal(data.origin, 'generated');
  assert.equal(data.encrypted, true);
  assert.equal(data.key, GENERATED_KEY);
  assert.equal(data.path, KEY_FILE);
});

test('das Log nennt den Admin, der den Schluessel gesehen hat - und nie den Wert', async () => {
  const before = logged.length;
  assert.equal((await getKey()).status, 200);
  const lines = logged.slice(before);
  assert.ok(lines.some((l) => l.includes(`admin ${admin.id} viewed the database key`)), lines.join('\n'));
  assert.ok(!logged.some((l) => l.includes(GENERATED_KEY)), 'der Wert steht in keiner Logzeile, auch nicht beim Erzeugen');
});

test('der Status nennt die Herkunft, aber nie den Wert', async () => {
  const res = await fetch(`${API}/backup/status`, { headers: sessionHeaders(admin) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(GENERATED_KEY));
  assert.deepEqual(JSON.parse(raw).data.database_key, { origin: 'generated', encrypted: true });
});

test('ein Mitglied bekommt 403', async () => {
  const res = await fetch(`${API}/auth/users`, {
    method: 'POST', headers: sessionHeaders(admin),
    body: JSON.stringify({ username: 'member1', display_name: 'member1', password: 'member1pass1234' }),
  });
  assert.equal(res.status, 201);
  const member = await login('member1', 'member1pass1234');
  const refused = await getKey(sessionHeaders(member));
  assert.equal(refused.status, 403);
  assert.ok(!(await refused.text()).includes(GENERATED_KEY));
});

test('das Geraet eines Admins erreicht die Route nicht (device_credential)', async () => {
  const reg = await fetch(`${API}/auth/devices`, {
    method: 'POST', headers: sessionHeaders(admin),
    body: JSON.stringify({ name: 'Telefon', platform: 'ios', device_id: `device-${crypto.randomUUID()}` }),
  });
  assert.equal(reg.status, 201);
  const { credential } = await reg.json();
  const refused = await getKey({ Authorization: `Bearer ${credential}` });
  assert.equal(refused.status, 403);
  const raw = await refused.text();
  assert.ok(!raw.includes(GENERATED_KEY));
  assert.equal(JSON.parse(raw).reason, 'device_credential');
});

test('gespeichert (stored): der Wert aus .secrets/ wird gezeigt', async () => {
  const stored = crypto.randomBytes(32).toString('hex');
  const dir = tempDir('stored-');
  fs.mkdirSync(path.join(dir, '.secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.secrets', 'DB_ENCRYPTION_KEY'), `${stored}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.secrets', 'SESSION_SECRET'), `${'s'.repeat(32)}\n`, { mode: 0o600 });
  const env = { DB_PATH: path.join(dir, 'yuvomi.db') };
  _resetAutoSecretState();
  applyAutoSecrets({ env, log: { info() {}, warn() {} } });
  process.env.DB_ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY;
  try {
    const { data } = await (await getKey()).json();
    assert.equal(data.origin, 'stored');
    assert.equal(data.key, stored);
    assert.equal(data.path, path.join(dir, '.secrets', 'DB_ENCRYPTION_KEY'));
  } finally {
    process.env.DB_ENCRYPTION_KEY = GENERATED_KEY;
  }
});

for (const [label, setup, origin] of [
  ['aus der Umgebung (env)', () => handshake({ DB_ENCRYPTION_KEY: GENERATED_KEY }), 'env'],
  ['aus DB_ENCRYPTION_KEY_FILE (file)', () => handshake({ DB_ENCRYPTION_KEY: GENERATED_KEY }, ['DB_ENCRYPTION_KEY']), 'file'],
  ['Herkunft unbekannt (Handschlag lief nicht)', () => _resetAutoSecretState(), null],
]) {
  test(`${label}: Herkunft ja, Wert nein`, async () => {
    setup();
    const res = await getKey();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const raw = await res.text();
    assert.ok(!raw.includes(GENERATED_KEY), raw);
    assert.deepEqual(JSON.parse(raw).data, { origin, encrypted: true });
  });
}

test('ohne Verschluesselung: kein Wert, encrypted false', async () => {
  handshake({ DB_ENCRYPTION_AUTO_KEY: 'false' });
  delete process.env.DB_ENCRYPTION_KEY;
  try {
    const res = await getKey();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json()).data, { origin: null, encrypted: false });
  } finally {
    process.env.DB_ENCRYPTION_KEY = GENERATED_KEY;
  }
});

// server/index.js setzt `no-store` fuer ganz /api - die Route haelt es selbst,
// auch wenn sie einmal anders eingehaengt wird. Das sieht nur der nackte Router.
test('die Route setzt no-store selbst, nicht erst der /api-Rahmen', async () => {
  handshake({});
  process.env.DB_ENCRYPTION_KEY = GENERATED_KEY;
  const { default: express } = await import('express');
  const { default: backupRouter } = await import('../server/routes/backup.js');
  const bare = express();
  bare.use((req, _res, next) => { req.authUserId = 99; req.authRole = 'admin'; next(); });
  bare.use('/', backupRouter);
  const server = bare.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/database-key`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).data.origin, 'generated');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// Zuletzt: verbraucht das Budget des Admins.
test('Rate-Limit: nach zehn Abrufen in zehn Minuten kommt 429, ohne Wert', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await getKey();
    statuses.push(res.status);
    if (res.status === 429) assert.ok(!(await res.text()).includes(GENERATED_KEY));
    else await res.arrayBuffer();
  }
  const first = statuses.indexOf(429);
  assert.ok(first > 0, `429 erwartet: ${statuses.join(',')}`);
  assert.ok(statuses.slice(first).every((s) => s === 429), statuses.join(','));
  // Die Fehlversuche anderer zaehlen nicht mit: das Mitglied oben bekam 403 vor dem Limiter.
  assert.ok(statuses.filter((s) => s === 200).length <= 10, statuses.join(','));
});
