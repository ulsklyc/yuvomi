/**
 * Modul: Gravatar-Import des Profilbilds
 * Zweck: EIN Abruf auf Klick, gespeichert wie ein Upload (server/services/
 *        gravatar.js, POST /auth/me/avatar/gravatar in server/auth.js).
 *        Geprueft wird ohne Netz: der Transport wird in den Dienst injiziert,
 *        der SSRF-Guard laeuft mit einem gefaelschten Resolver.
 *
 *        Deckt ab:
 *          - der Hash ist SHA-256 des getrimmten, ASCII-klein geschriebenen
 *            Schluessels (bekannter Hex-Wert fuer eine feste Adresse)
 *          - die URL: Basis + Hash, `s=256`, `d=404`; Basis-URL geprueft
 *            (https, kein interner Host, Schraegstrich ergaenzt)
 *          - 200 png -> data-URL in users.avatar_data, in GET /auth/me, und im
 *            Geburtstagsfoto gespiegelt
 *          - 404 -> gravatar_not_found, Bild unangetastet
 *          - text/html und ein falsch deklariertes Bild -> 415
 *          - Body ueber 512 KiB, gestreamt ohne Content-Length -> 413
 *          - vom Guard abgewiesene (private) Adresse, Timeout -> 502
 *          - AUS, solange GRAVATAR_BASE_URL nicht gesetzt ist: 404
 *            gravatar_disabled ohne Abruf, und GET /auth/me meldet
 *            gravatarAvailable: false
 *          - keine Adresse, mehrere Adressen -> 400; Basis leer -> 404
 *            gravatar_disabled; elfter Aufruf -> 429; Wandtablett -> 403
 *          - Split-Gast -> 403 not_a_household_member, ohne Abruf
 *          - aendert sich waehrend des Abrufs das Bild, die Adresse oder das
 *            Konto, wird nichts geschrieben (409 gravatar_stale); eine reine
 *            Gross-/Kleinschreibungs-Aenderung der Adresse ist keine Aenderung
 *          - Reihenfolge: Upload nach Import ueberschreibt, zweiter Import den
 *            Upload (es gewinnt, was zuletzt gespeichert wurde)
 *          - Fehlerantworten tragen weder Hash noch Basis-URL
 * Ausführen: npm run test:gravatar
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
// Der Import ist ab Werk AUS. Die Suite schaltet ihn ein, wie ein Betreiber es
// taete; die Tests fuer "aus" nehmen die Variable je Aufruf wieder weg.
const GRAVATAR_BASE = 'https://gravatar.com/avatar/';
process.env.GRAVATAR_BASE_URL = GRAVATAR_BASE;

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const {
  GravatarError, MAX_GRAVATAR_BYTES, fetchGravatar, gravatarBaseUrl, gravatarEnabled, gravatarHash, gravatarUrl,
} = await import('../server/services/gravatar.js');
const { createGuardedLookup } = await import('../server/utils/ssrf.js');
const { safeRequest, resolveRedirect } = await import('../server/utils/http.js');
const { router: authRouter, sessionMiddleware, buildGravatarRoute } = await import('../server/auth.js');
const { DISPLAY_COOKIE, issuePairingCode, redeemPairingCode } = await import('../server/services/display-accounts.js');

// --------------------------------------------------------------------------
// Fixtures: Bilder, deren Kopf die Signaturpruefung bestehen muss.
// --------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<!doctype html><html><body>not an image</body></html>');

/** Eine Antwort, wie safeRequest() sie liefert: status, ok, headers.get, body als Readable. */
function response(status, headers, chunks) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    get ok() { return status >= 200 && status < 300; },
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    body: Readable.from(Array.isArray(chunks) ? chunks : [chunks]),
  };
}

/** Transport, der eine feste Antwort gibt und den Aufruf festhaelt. */
function fakeRequest(reply) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return typeof reply === 'function' ? reply(url, options) : reply;
  };
  request.calls = calls;
  return request;
}

function fakeLookup(table) {
  return (hostname, _options, callback) => {
    const addresses = table[hostname];
    if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return callback(null, addresses);
  };
}

const EMAIL = 'foo@example.com';
// sha256('foo@example.com'), unabhaengig berechnet - damit der Test nicht die
// Implementierung mit sich selbst vergleicht.
const EMAIL_HASH = '321ba197033e81286fedb719d60d4ed5cecaed170733cb4a92013811afc0e3b6';

// --------------------------------------------------------------------------
// Hash und URL
// --------------------------------------------------------------------------

test('der Hash ist SHA-256 des getrimmten, ASCII-klein geschriebenen Schluessels', () => {
  assert.equal(gravatarHash(EMAIL), EMAIL_HASH);
  assert.equal(gravatarHash(' Foo@Example.COM '), EMAIL_HASH, 'Leerraum und Grossschreibung aendern den Hash nicht');
  assert.equal(gravatarHash('\tFoo@Example.COM\r\n'), EMAIL_HASH);
  assert.equal(gravatarHash(EMAIL), crypto.createHash('sha256').update(EMAIL).digest('hex'));
  assert.notEqual(gravatarHash('bar@example.com'), EMAIL_HASH);
});

test('die URL: Basis + Hash, s=256 und d=404 - kein Platzhalterbild wird je gespeichert', () => {
  assert.equal(gravatarUrl(EMAIL), `https://gravatar.com/avatar/${EMAIL_HASH}?s=256&d=404`);
  assert.equal(gravatarUrl(EMAIL, { size: 80 }), `https://gravatar.com/avatar/${EMAIL_HASH}?s=80&d=404`);
  assert.equal(gravatarUrl(EMAIL, { size: -1 }), `https://gravatar.com/avatar/${EMAIL_HASH}?s=256&d=404`, 'Unsinn faellt auf 256');
  // Ein Spiegel ohne Schraegstrich bekommt ihn: sonst klebte der Hash am
  // letzten Segment des Betreibers.
  assert.equal(gravatarUrl(EMAIL, { base: 'https://seccdn.libravatar.org/avatar' }), `https://seccdn.libravatar.org/avatar/${EMAIL_HASH}?s=256&d=404`);
});

test('die Basis-URL: leer heisst abgeschaltet, http/intern/Query heisst falsch gesetzt', () => {
  assert.throws(() => gravatarUrl(EMAIL, { base: '' }), (err) => err instanceof GravatarError && err.reason === 'gravatar_disabled');
  assert.throws(() => gravatarUrl(EMAIL, { base: '   ' }), (err) => err.reason === 'gravatar_disabled');
  for (const base of ['http://gravatar.com/avatar/', 'https://localhost/avatar/', 'https://avatars.internal/', 'https://gravatar.com/avatar/?x=1', 'not a url', 'ftp://gravatar.com/']) {
    assert.throws(() => gravatarUrl(EMAIL, { base }), (err) => err.reason === 'gravatar_bad_base_url', base);
  }
});

test('ab Werk AUS: ungesetzt oder leer heisst abgeschaltet, kein eingebauter Dienst', () => {
  assert.equal(gravatarBaseUrl({}), '', 'kein Default auf gravatar.com');
  assert.equal(gravatarBaseUrl({ GRAVATAR_BASE_URL: '' }), '');
  assert.equal(gravatarBaseUrl({ GRAVATAR_BASE_URL: '  ' }), '');
  assert.equal(gravatarBaseUrl({ GRAVATAR_BASE_URL: ' https://seccdn.libravatar.org/avatar/ ' }), 'https://seccdn.libravatar.org/avatar/');
  assert.equal(gravatarEnabled({}), false);
  assert.equal(gravatarEnabled({ GRAVATAR_BASE_URL: '' }), false);
  assert.equal(gravatarEnabled({ GRAVATAR_BASE_URL: '   ' }), false);
  assert.equal(gravatarEnabled({ GRAVATAR_BASE_URL: GRAVATAR_BASE }), true);
  // Ein gesetzter, aber falscher Wert ist EIN: der Betreiber wollte die
  // Funktion, und der Fehler soll laut werden (500), nicht als "aus" verschwinden.
  assert.equal(gravatarEnabled({ GRAVATAR_BASE_URL: 'http://gravatar.com/avatar/' }), true);
  assert.throws(() => gravatarUrl(EMAIL, { base: gravatarBaseUrl({}) }), (err) => err.reason === 'gravatar_disabled');
});

// --------------------------------------------------------------------------
// fetchGravatar(): der Dienst mit injiziertem Transport
// --------------------------------------------------------------------------

test('200 image/png -> data-URL; der Transport bekommt Timeout-Signal und Guard-Lookup', async () => {
  const request = fakeRequest(response(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }, PNG));
  const lookup = createGuardedLookup({ lookup: fakeLookup({}) });
  const result = await fetchGravatar(EMAIL, { request, lookup });
  assert.equal(result.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.bytes, PNG.length);
  assert.equal(request.calls.length, 1);
  assert.equal(request.calls[0].url, `https://gravatar.com/avatar/${EMAIL_HASH}?s=256&d=404`);
  assert.equal(request.calls[0].options.lookup, lookup, 'der Anti-Rebinding-Lookup reist mit (auch durch jeden Redirect)');
  assert.ok(request.calls[0].options.signal instanceof AbortSignal, 'ein Timeout-Signal ist gesetzt');
  assert.match(request.calls[0].options.headers.Accept, /image\/png/);
});

test('Content-Type mit Parametern und JPEG/WebP passieren; der Typ steht in der data-URL', async () => {
  const jpeg = await fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/jpeg; charset=binary' }, JPEG)) });
  assert.equal(jpeg.dataUrl.slice(0, 'data:image/jpeg;base64,'.length), 'data:image/jpeg;base64,');
  const webpBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);
  const webp = await fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'IMAGE/WEBP' }, webpBytes)) });
  assert.equal(webp.contentType, 'image/webp');
});

test('404 heisst "kein Gravatar": null, kein Fehler', async () => {
  const result = await fetchGravatar(EMAIL, { request: fakeRequest(response(404, { 'Content-Type': 'image/png' }, PNG)) });
  assert.equal(result, null);
});

test('200 text/html -> gravatar_not_image; PNG-Typ mit HTML-Bytes ebenso (Signatur widerlegt den Typ)', async () => {
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'text/html; charset=utf-8' }, HTML)) }),
    (err) => err instanceof GravatarError && err.reason === 'gravatar_not_image',
  );
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/png' }, HTML)) }),
    (err) => err.reason === 'gravatar_not_image',
  );
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/svg+xml' }, Buffer.from('<svg/>'))) }),
    (err) => err.reason === 'gravatar_not_image',
    'SVG ist beim Profilbild nicht zugelassen - wie beim Upload',
  );
});

test('Body ueber 512 KiB -> gravatar_too_large: angekuendigt UND gestreamt ohne Content-Length', async () => {
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/png', 'Content-Length': MAX_GRAVATAR_BYTES + 1 }, PNG)) }),
    (err) => err.reason === 'gravatar_too_large',
  );
  // Kein Content-Length, 16 KiB je Chunk, insgesamt 600 KiB: die Grenze muss
  // im Stream greifen, nicht erst am Ende.
  let served = 0;
  const chunks = [];
  const head = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(16 * 1024 - 8, 7)]);
  chunks.push(head);
  for (let i = 1; i < 600 / 16; i += 1) chunks.push(Buffer.alloc(16 * 1024, 7));
  const body = new Readable({
    read() {
      const next = chunks.shift();
      if (next) served += next.length;
      this.push(next ?? null);
    },
  });
  const res = { status: 200, ok: true, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) }, body };
  await assert.rejects(fetchGravatar(EMAIL, { request: fakeRequest(res) }), (err) => err.reason === 'gravatar_too_large');
  assert.ok(served <= MAX_GRAVATAR_BYTES + 2 * 16 * 1024, `abgebrochen nach ${served} Bytes, nicht erst nach 600 KiB`);
  assert.ok(body.destroyed, 'der Stream wird zerstoert, die Verbindung haengt nicht');
});

test('exakt 512 KiB passieren noch', async () => {
  const exact = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_GRAVATAR_BYTES - 8, 9)]);
  const result = await fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/png' }, exact)) });
  assert.equal(result.bytes, MAX_GRAVATAR_BYTES);
});

test('andere Nicht-2xx-Antworten und Transportfehler -> gravatar_unreachable, mit dem Netzfehler als cause', async () => {
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(500, {}, Buffer.alloc(0))) }),
    (err) => err.reason === 'gravatar_unreachable',
  );
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(response(301, { Location: 'https://elsewhere.example/' }, Buffer.alloc(0))) }),
    (err) => err.reason === 'gravatar_unreachable',
    'ein Redirect, den safeRequest nicht mehr folgen durfte, ist kein Bild',
  );
  const boom = new Error('getaddrinfo ENOTFOUND gravatar.com');
  await assert.rejects(
    fetchGravatar(EMAIL, { request: async () => { throw boom; } }),
    (err) => err.reason === 'gravatar_unreachable' && err.cause === boom,
  );
  // Reisst die Verbindung erst im Koerper (Timeout mitten im Stream, Socket zu
  // vor dem Ende der Content-Length), ist das derselbe Grund - und kein 500.
  const cut = new Error('aborted');
  cut.code = 'ECONNRESET';
  async function* cutStream() { yield PNG.subarray(0, 8); throw cut; }
  const res = response(200, { 'Content-Type': 'image/png' }, Buffer.alloc(0));
  res.body = Readable.from(cutStream());
  await assert.rejects(
    fetchGravatar(EMAIL, { request: fakeRequest(res) }),
    (err) => err.reason === 'gravatar_unreachable' && err.cause === cut,
    'ein Abbruch beim Lesen des Koerpers ist unreachable, kein nackter Error',
  );
});

test('Timeout: das Signal bricht ab -> gravatar_unreachable', async () => {
  const request = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(fetchGravatar(EMAIL, { request, timeoutMs: 20 }), (err) => err.reason === 'gravatar_unreachable' && err.cause?.name === 'TimeoutError');
});

test('der echte Transport mit dem Guard: eine Basis, die auf eine private Adresse zeigt, wird vor dem Verbinden abgewiesen', async () => {
  // Kein Netz: der gefaelschte Resolver antwortet, der Guard lehnt ab, und
  // https.request bricht ab, bevor ein Socket entsteht.
  const lookup = createGuardedLookup({ lookup: fakeLookup({ 'avatars.example': [{ address: '10.0.0.5', family: 4 }] }) });
  await assert.rejects(
    fetchGravatar(EMAIL, { request: safeRequest, lookup, base: 'https://avatars.example/avatar/' }),
    (err) => err.reason === 'gravatar_unreachable' && /private IP address/.test(err.cause?.message),
  );
  // dns.lookup gibt ein Literal unveraendert zurueck; der Fake tut dasselbe.
  const literal = createGuardedLookup({ lookup: fakeLookup({ '169.254.169.254': [{ address: '169.254.169.254', family: 4 }] }) });
  await assert.rejects(
    fetchGravatar(EMAIL, { request: safeRequest, lookup: literal, base: 'https://169.254.169.254/avatar/' }),
    (err) => err.reason === 'gravatar_unreachable' && /private IP address/.test(err.cause?.message),
    'ein IP-Literal fragt der Transport selbst beim Guard nach (GHSA-9jh6-phj9-m6qr)',
  );
});

test('ohne Angabe ist der Lookup der Anti-Rebinding-Guard: ein privates Literal wird abgewiesen, ohne Netz', async () => {
  // Kein `lookup` injiziert - der Dienst muss selbst den Guard mitgeben. Ein
  // IP-Literal loest dns.lookup lokal auf, es geht keine Anfrage hinaus.
  const request = fakeRequest(response(200, { 'Content-Type': 'image/png' }, PNG));
  await fetchGravatar(EMAIL, { request });
  const { lookup } = request.calls[0].options;
  assert.equal(typeof lookup, 'function', 'ein Lookup reist mit');
  await assert.rejects(
    new Promise((resolve, reject) => lookup('10.0.0.5', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))),
    /private IP address/,
  );
  await assert.rejects(
    new Promise((resolve, reject) => lookup('::ffff:169.254.169.254', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))),
    /private IP address/,
    'IPv4-mapped-IPv6 wird wie die eingebettete IPv4 geprueft',
  );
});

test('ein Redirect des Spiegels darf TLS nicht abstreifen - die Regel von safeRequest, am Gravatar-Ziel', () => {
  const from = new URL(gravatarUrl(EMAIL));
  assert.throws(() => resolveRedirect(from, 'http://gravatar.com/avatar/x'), /downgrades https to http/);
  assert.throws(() => resolveRedirect(from, 'file:///etc/passwd'), /unsupported protocol/);
  assert.equal(resolveRedirect(from, 'https://cdn.gravatar.example/x').href, 'https://cdn.gravatar.example/x');
});

test('keine oder keine eindeutige Adresse -> no_email, bevor irgendetwas abgerufen wird', async () => {
  const request = fakeRequest(response(200, { 'Content-Type': 'image/png' }, PNG));
  for (const email of [null, undefined, '', '   ']) {
    await assert.rejects(fetchGravatar(email, { request }), (err) => err.reason === 'no_email', String(email));
  }
  assert.equal(request.calls.length, 0);
});

test('Fehlermeldungen tragen weder Hash noch Basis-URL', async () => {
  const seen = [];
  const collect = (p) => p.catch((err) => seen.push(err.message));
  await collect(fetchGravatar(EMAIL, { request: fakeRequest(response(500, {}, Buffer.alloc(0))) }));
  await collect(fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'text/html' }, HTML)) }));
  await collect(fetchGravatar(EMAIL, { request: fakeRequest(response(200, { 'Content-Type': 'image/png', 'Content-Length': 10 ** 7 }, PNG)) }));
  await collect(fetchGravatar(EMAIL, { base: '', request: fakeRequest(response(200, {}, PNG)) }));
  await collect(fetchGravatar(EMAIL, { base: 'https://seccdn.libravatar.org/avatar/?q', request: fakeRequest(response(200, {}, PNG)) }));
  assert.equal(seen.length, 5);
  for (const message of seen) {
    assert.ok(!message.includes(EMAIL_HASH), message);
    assert.ok(!/https?:\/\//.test(message), message);
    assert.ok(!message.includes(EMAIL), message);
  }
});

// --------------------------------------------------------------------------
// Die Route, gegen den echten Handler. Aufbau wie test-changelog-seen.js:
// requireAuth loest seine Session selbst auf. Der Handler kommt aus dem
// Builder mit injiziertem Abruf und haengt unter /t; /me, /me/profile und der
// Riegel fuer Wandtabletts kommen vom unveraenderten Auth-Router darunter.
// --------------------------------------------------------------------------

const transport = { reply: null };
const testRouter = express.Router();
buildGravatarRoute(testRouter, {
  fetch: (email) => fetchGravatar(email, { request: (url, options) => transport.reply(url, options) }),
});

const actor = { userId: 0 };
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware);
app.use((req, _res, next) => {
  if (actor.userId) { req.session.userId = actor.userId; req.session.role = 'member'; }
  next();
});
app.use('/t', testRouter);
app.use('/', authRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function cookieHeader(res) {
  return res.headers.getSetCookie().map((raw) => raw.split(';')[0]).join('; ');
}

async function signIn(userId) {
  actor.userId = userId;
  const res = await fetch(`${base}/me`);
  actor.userId = 0;
  const body = await res.json();
  assert.equal(res.status, 200, `sign in ${userId}`);
  return { cookies: cookieHeader(res), csrfToken: body.csrfToken };
}

async function call(method, path, session, payload) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: session.cookies, 'X-CSRF-Token': session.csrfToken || '' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const importGravatar = (session, payload = {}) => call('POST', '/t/me/avatar/gravatar', session, payload);
const gravatarFlag = async (session) => (await call('GET', '/me', session)).body.gravatarAvailable;

/** Fuehrt fn mit GRAVATAR_BASE_URL = value aus (undefined = Variable entfernt). */
async function withBase(value, fn) {
  const previous = process.env.GRAVATAR_BASE_URL;
  if (value === undefined) delete process.env.GRAVATAR_BASE_URL;
  else process.env.GRAVATAR_BASE_URL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GRAVATAR_BASE_URL;
    else process.env.GRAVATAR_BASE_URL = previous;
  }
}

function addUser(id, username, { email, birthDate } = {}) {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, 'x', 'member')").run(id, username, username);
  if (email !== undefined) {
    db.prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES (?, 'misc', ?, ?)").run(username, email, id);
  }
  if (birthDate) {
    db.prepare('INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES (?, ?, ?, ?)').run(username, birthDate, id, id);
  }
}

const avatarOf = (id) => db.prepare('SELECT avatar_data FROM users WHERE id = ?').get(id).avatar_data;
const birthdayPhotoOf = (id) => db.prepare('SELECT photo_data FROM birthdays WHERE family_user_id = ?').get(id)?.photo_data;

addUser(301, 'anna', { email: ' Foo@Example.COM ', birthDate: '1990-04-01' });
addUser(302, 'bert');
addUser(303, 'carla', { email: 'a@x.de, b@y.de' });
addUser(304, 'dora', { email: 'dora@example.com' });
addUser(305, 'erik', { email: 'erik@example.com' });
addUser(307, 'gast', { email: 'gast@example.com' });
// Ein Split-Gast, wie ihn die Gast-Suiten anlegen (test-household-members.js).
db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, NULL, ?)').run(307, 301);
addUser(308, 'fiona', { email: 'fiona@example.com' });
addUser(309, 'gerd', { email: 'gerd@example.com' });
addUser(310, 'hanna', { email: 'hanna@example.com' });
addUser(311, 'ines', { email: 'ines@example.com' });

test('200 png: gespeichert wie ein Upload - users.avatar_data, GET /auth/me, Geburtstagsfoto', async () => {
  transport.reply = (url) => {
    assert.equal(url, `https://gravatar.com/avatar/${EMAIL_HASH}?s=256&d=404`, 'die gespeicherte Adresse wird normalisiert gehasht');
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const session = await signIn(301);
  const res = await importGravatar(session);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const expected = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.equal(res.body.data.avatar_data, expected, 'die Antwort traegt den Nutzer wie PATCH /me/profile');
  assert.equal(res.body.data.id, 301);
  assert.equal(avatarOf(301), expected);
  assert.equal(birthdayPhotoOf(301), expected, 'das Geburtstagsfoto spiegelt mit');
  const me = await call('GET', '/me', session);
  assert.equal(me.body.user.avatar_data, expected);
});

test('404 vom Dienst -> 404 gravatar_not_found, das Bild bleibt unangetastet', async () => {
  transport.reply = () => response(404, { 'Content-Type': 'image/png' }, PNG);
  const before = avatarOf(301);
  const res = await importGravatar(await signIn(301));
  assert.equal(res.status, 404);
  assert.equal(res.body.reason, 'gravatar_not_found');
  assert.equal(res.body.code, 404);
  assert.equal(avatarOf(301), before);
});

test('text/html -> 415 gravatar_not_image; zu gross -> 413 gravatar_too_large; Timeout -> 502 gravatar_unreachable', async () => {
  const session = await signIn(301);
  const before = avatarOf(301);

  transport.reply = () => response(200, { 'Content-Type': 'text/html' }, HTML);
  let res = await importGravatar(session);
  assert.equal(res.status, 415);
  assert.equal(res.body.reason, 'gravatar_not_image');

  transport.reply = () => response(200, { 'Content-Type': 'image/png', 'Content-Length': MAX_GRAVATAR_BYTES + 1 }, PNG);
  res = await importGravatar(session);
  assert.equal(res.status, 413);
  assert.equal(res.body.reason, 'gravatar_too_large');

  transport.reply = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  res = await importGravatar(session);
  assert.equal(res.status, 502);
  assert.equal(res.body.reason, 'gravatar_unreachable');

  assert.equal(avatarOf(301), before, 'kein Fehlerfall schreibt');
  for (const body of [res.body]) {
    assert.ok(!JSON.stringify(body).includes(EMAIL_HASH));
    assert.ok(!/https?:\/\//.test(JSON.stringify(body)));
  }
});

test('ohne Adresse und mit einer Adressliste -> 400 no_email, ohne Abruf', async () => {
  let calls = 0;
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/png' }, PNG); };
  const none = await importGravatar(await signIn(302));
  assert.equal(none.status, 400);
  assert.equal(none.body.reason, 'no_email');
  const many = await importGravatar(await signIn(303));
  assert.equal(many.status, 400);
  assert.equal(many.body.reason, 'no_email');
  // Die Seite schickt noch die alte Adresse, gespeichert ist keine mehr: der
  // eigentliche Grund (keine Adresse) gewinnt, nicht ein 409.
  const cleared = await importGravatar(await signIn(302), { email: 'alt@example.com' });
  assert.equal(cleared.status, 400, JSON.stringify(cleared.body));
  assert.equal(cleared.body.reason, 'no_email');
  assert.equal(calls, 0);
  assert.equal(avatarOf(302), null);
  assert.equal(avatarOf(303), null);
});

test('GRAVATAR_BASE_URL leer -> 404 gravatar_disabled, ohne Abruf', async () => {
  let calls = 0;
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/png' }, PNG); };
  const previous = process.env.GRAVATAR_BASE_URL;
  process.env.GRAVATAR_BASE_URL = '';
  try {
    const res = await importGravatar(await signIn(301));
    assert.equal(res.status, 404);
    assert.equal(res.body.reason, 'gravatar_disabled');
  } finally {
    if (previous === undefined) delete process.env.GRAVATAR_BASE_URL;
    else process.env.GRAVATAR_BASE_URL = previous;
  }
  assert.equal(calls, 0);
});

test('eine falsch gesetzte Basis-URL ist ein Betreiberfehler: 500 mit Grund, nicht "abgeschaltet"', async () => {
  const previous = process.env.GRAVATAR_BASE_URL;
  process.env.GRAVATAR_BASE_URL = 'http://gravatar.com/avatar/';
  try {
    const res = await importGravatar(await signIn(301));
    assert.equal(res.status, 500);
    assert.equal(res.body.reason, 'gravatar_bad_base_url');
    assert.ok(!res.body.error.includes('http://'), 'die Antwort nennt den Wert nicht');
    assert.ok(!res.body.error.includes('GRAVATAR_BASE_URL'), 'der Betreiberhinweis steht im Log, nicht beim Mitglied');
  } finally {
    if (previous === undefined) delete process.env.GRAVATAR_BASE_URL;
    else process.env.GRAVATAR_BASE_URL = previous;
  }
});

test('ein Upload danach ueberschreibt den Import, ein zweiter Import den Upload - es gewinnt, was zuletzt kam', async () => {
  const session = await signIn(304);
  transport.reply = () => response(200, { 'Content-Type': 'image/png' }, PNG);
  const imported = await importGravatar(session);
  assert.equal(imported.status, 200);
  const fromGravatar = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.equal(avatarOf(304), fromGravatar);

  const upload = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  const patched = await call('PATCH', '/me/profile', session, { avatar_data: upload });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(avatarOf(304), upload, 'der Upload gewinnt');

  const again = await importGravatar(session);
  assert.equal(again.status, 200);
  assert.equal(avatarOf(304), fromGravatar, 'der zweite Import gewinnt');

  // Entfernen bleibt der bestehende Weg: avatar_data null ueber PATCH.
  const removed = await call('PATCH', '/me/profile', session, { avatar_data: null });
  assert.equal(removed.status, 200);
  assert.equal(avatarOf(304), null);
});

test('zehn Aufrufe in zehn Minuten je Mitglied; der elfte -> 429 gravatar_rate_limited', async () => {
  transport.reply = () => response(404, {}, Buffer.alloc(0));
  const session = await signIn(305);
  for (let i = 0; i < 10; i += 1) {
    const res = await importGravatar(session);
    assert.equal(res.status, 404, `Aufruf ${i + 1} zaehlt, auch ohne Treffer`);
  }
  const eleventh = await importGravatar(session);
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.body.reason, 'gravatar_rate_limited');
  assert.equal(eleventh.body.code, 429);
  // Je Mitglied, nicht je Adresse: ein anderes Konto von derselben IP darf noch.
  const other = await importGravatar(await signIn(304));
  assert.equal(other.status, 404);
});

test('ohne Sitzung -> 401; ein Wandtablett -> 403 display_account am echten Router', async () => {
  const anonymous = await fetch(`${base}/t/me/avatar/gravatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401);

  addUser(306, 'kueche', { email: 'kueche@example.com' });
  db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(306, 301);
  const { code } = issuePairingCode(306, 301);
  const paired = redeemPairingCode(code);
  assert.ok(paired?.token, 'das Tablett ist gekoppelt');

  // Der echte Router haengt am echten Transport. Damit ein Riegel, der je
  // nachgibt, hier keinen Netzaufruf ausloest, ist die Basis-URL fuer diesen
  // einen Aufruf leer: dann antwortete die Route 404 gravatar_disabled - und
  // der Test wuerde daran rot, statt still nach draussen zu gehen.
  const previousBase = process.env.GRAVATAR_BASE_URL;
  process.env.GRAVATAR_BASE_URL = '';
  let res;
  try {
    res = await fetch(`${base}/me/avatar/gravatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=${encodeURIComponent(paired.token)}` },
      body: '{}',
    });
  } finally {
    if (previousBase === undefined) delete process.env.GRAVATAR_BASE_URL;
    else process.env.GRAVATAR_BASE_URL = previousBase;
  }
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.reason, 'display_account');
  assert.equal(avatarOf(306), null);
});

test('ab Werk AUS: GRAVATAR_BASE_URL ungesetzt -> 404 gravatar_disabled ohne Abruf, und /auth/me meldet false', async () => {
  let calls = 0;
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/png' }, PNG); };
  const session = await signIn(308);
  await withBase(undefined, async () => {
    const res = await importGravatar(session);
    assert.equal(res.status, 404);
    assert.equal(res.body.reason, 'gravatar_disabled');
    assert.equal(await gravatarFlag(session), false, 'kein Knopf, solange der Betreiber nichts gesetzt hat');
    // Der Aus-Riegel steht VOR der Mitgliedspruefung: auch ein Split-Gast
    // hoert "abgeschaltet" und nicht "kein Mitglied".
    const guest = await importGravatar(await signIn(307));
    assert.equal(guest.status, 404, JSON.stringify(guest.body));
    assert.equal(guest.body.reason, 'gravatar_disabled');
  });
  await withBase('', async () => {
    assert.equal(await gravatarFlag(session), false, 'leer ist dasselbe wie ungesetzt');
  });
  assert.equal(calls, 0, 'nichts geht hinaus, solange die Variable fehlt');
  assert.equal(avatarOf(308), null);
  assert.equal(await gravatarFlag(session), true, 'eingeschaltet und Mitglied: der Knopf darf erscheinen');
  const me = await call('GET', '/me', session);
  assert.ok(!JSON.stringify(me.body).includes('gravatar.com'), '/auth/me nennt die Basis-URL nie');
});

test('ein Split-Gast -> 403 not_a_household_member, bevor irgendetwas abgerufen wird', async () => {
  let calls = 0;
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/png' }, PNG); };
  const session = await signIn(307);
  const res = await importGravatar(session);
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'not_a_household_member');
  assert.equal(res.body.code, 403);
  assert.equal(calls, 0, 'die Adresse eines Gasts tippt, wer die Gruppe verwaltet - sie wird nicht gehasht');
  assert.equal(avatarOf(307), null);
  assert.equal(await gravatarFlag(session), false, 'der Gast bekommt den Knopf gar nicht erst');
});

test('waehrend des Abrufs entfernt: 409 gravatar_stale, das Bild bleibt entfernt', async () => {
  const session = await signIn(309);
  const upload = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  assert.equal((await call('PATCH', '/me/profile', session, { avatar_data: upload })).status, 200);
  transport.reply = async () => {
    const removed = await call('PATCH', '/me/profile', session, { avatar_data: null });
    assert.equal(removed.status, 200);
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const res = await importGravatar(session);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'gravatar_stale');
  assert.equal(avatarOf(309), null, 'die spaetere Handlung gewinnt');
});

test('waehrend des Abrufs eine andere Adresse: 409, nichts geschrieben - auch nicht das Geburtstagsfoto', async () => {
  db.prepare("INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('hanna', '1991-02-03', 310, 310)").run();
  const session = await signIn(310);
  transport.reply = () => {
    db.prepare('UPDATE contacts SET email = ? WHERE family_user_id = ?').run('neu@example.com', 310);
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const res = await importGravatar(session);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'gravatar_stale');
  assert.equal(avatarOf(310), null, 'das Bild der alten Adresse wird nicht gespeichert');
  assert.equal(birthdayPhotoOf(310) ?? null, null);
});

test('waehrend des Abrufs deaktiviert: 409, das fruehere Konto bleibt unangetastet', async () => {
  db.prepare("INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('ines', '1992-03-04', 311, 311)").run();
  const session = await signIn(311);
  transport.reply = () => {
    // Wie user-removal.js ein Konto stilllegt.
    db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(new Date().toISOString(), 311);
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const res = await importGravatar(session);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'gravatar_stale');
  assert.equal(avatarOf(311), null);
  assert.equal(birthdayPhotoOf(311) ?? null, null, 'auch das Geburtstagsfoto bleibt leer');
});

test('waehrend des Abrufs kein Mitglied mehr, Adresse unveraendert: 409 - die Mitgliedschaft wird selbst nachgeprueft', async () => {
  // Deaktivieren nimmt auch die Adresse weg (memberEmail() kennt nur aktive
  // Konten), dort faengt also schon der Adressvergleich. Hier bleibt die
  // Adresse gleich und das Konto aktiv; nur die Mitgliedschaft endet - so
  // greift allein der zweite Blick auf isHouseholdMember().
  addUser(312, 'jonas', { email: 'jonas@example.com' });
  const session = await signIn(312);
  transport.reply = () => {
    db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, NULL, ?)').run(312, 301);
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const res = await importGravatar(session);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'gravatar_stale');
  assert.equal(avatarOf(312), null);
});

test('Gegenprobe: dasselbe Bild und nur die Grossschreibung der Adresse geaendert -> 200, kein falsches 409', async () => {
  const session = await signIn(308);
  transport.reply = () => {
    db.prepare('UPDATE contacts SET email = ? WHERE family_user_id = ?').run('FIONA@Example.COM', 308);
    return response(200, { 'Content-Type': 'image/png' }, PNG);
  };
  const res = await importGravatar(session);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(avatarOf(308), `data:image/png;base64,${PNG.toString('base64')}`);
  // Und ein zweiter Import ueber einem vorhandenen Bild, das sich nicht
  // aendert, ist ebenfalls kein Konflikt.
  transport.reply = () => response(200, { 'Content-Type': 'image/jpeg' }, JPEG);
  const again = await importGravatar(session);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(avatarOf(308), `data:image/jpeg;base64,${JPEG.toString('base64')}`);
});

test('die Seite schickt die Adresse ihres Hinweises: weicht die gespeicherte ab -> 409 vor dem Abruf', async () => {
  addUser(313, 'karl', { email: 'karl@example.com' });
  let calls = 0;
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/png' }, PNG); };
  const session = await signIn(313);
  // Ein anderes Mitglied hat den Kontakt geaendert, nachdem die Seite gerendert war.
  const stale = await importGravatar(session, { email: 'alt@example.com' });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.reason, 'gravatar_stale');
  assert.equal(calls, 0, 'es geht nichts hinaus: die Adresse, die das Mitglied nie gesehen hat, wird nicht gehasht');
  assert.equal(avatarOf(313), null);

  // Dieselbe Adresse, nur anders geschrieben: kein Konflikt (derselbe Schluessel wie der Hash).
  const sameKey = await importGravatar(session, { email: '  KARL@Example.com ' });
  assert.equal(sameKey.status, 200, JSON.stringify(sameKey.body));
  assert.equal(calls, 1);
  assert.equal(avatarOf(313), `data:image/png;base64,${PNG.toString('base64')}`);

  // Ohne das Feld (API-Aufrufer) gilt die gespeicherte Adresse wie bisher.
  transport.reply = () => { calls += 1; return response(200, { 'Content-Type': 'image/jpeg' }, JPEG); };
  const noField = await importGravatar(session);
  assert.equal(noField.status, 200, JSON.stringify(noField.body));
  assert.equal(calls, 2);
  assert.equal(avatarOf(313), `data:image/jpeg;base64,${JPEG.toString('base64')}`);
});
