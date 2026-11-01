/**
 * Test: Home Assistant als Anmeldequelle des SSO-Ablaufs
 * Zweck: Home Assistant spricht OAuth 2.0 ohne OpenID Connect. Gefahren wird
 *        die echte Strecke `/oidc/start` -> `/oidc/callback` (und der
 *        Verknuepfungs-Lauf) gegen ein nachgestelltes Home Assistant mit
 *        Token-, Revoke- und WebSocket-Endpunkt. Geprueft wird, was dort
 *        ankommt, und welches Konto danach angemeldet ist.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-homeassistant-auth.js
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'homeassistant-auth-test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.SESSION_SECURE;
delete process.env.NODE_ENV;
delete process.env.LOG_LEVEL;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;
delete process.env.OIDC_ALLOW_SIGNUP;
delete process.env.AUTH_ALLOW_PASSWORD_LOGIN;

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';

// ---------------------------------------------------------------------------
// Nachgestelltes Home Assistant: /auth/token, /auth/revoke, /api/websocket
// ---------------------------------------------------------------------------

const HA_USER = { id: 'ha-user-1', name: 'Phillip', is_owner: true, is_admin: true };
let haUser = HA_USER;
let tokenRequests = [];
let revoked = [];
let wsAuthTokens = [];
/** Code -> PKCE-Challenge, wie sie die Authorize-Anfrage trug. */
const issuedCodes = new Map();

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ha = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const form = new URLSearchParams(body);
  if (req.url === '/auth/token' && req.method === 'POST') {
    tokenRequests.push(form);
    const challenge = issuedCodes.get(form.get('code'));
    const verifier = form.get('code_verifier') || '';
    if (!challenge || b64url(createHash('sha256').update(verifier).digest()) !== challenge) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_request' }));
    }
    issuedCodes.delete(form.get('code'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' }));
  }
  if (req.url === '/auth/revoke' && req.method === 'POST') {
    revoked.push(form.get('token'));
    res.writeHead(200);
    return res.end();
  }
  res.writeHead(404);
  res.end();
});

// Minimaler WebSocket-Server (RFC 6455, nur Textframes < 64 KiB, wie HA sie hier sendet).
ha.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const header = payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    socket.write(Buffer.concat([header, payload]));
  };
  send({ type: 'auth_required', ha_version: '2026.10.0' });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      const masked = (buf[1] & 0x80) !== 0;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const data = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode !== 0x1) continue;
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') {
        wsAuthTokens.push(msg.access_token);
        send(msg.access_token === 'access-1' ? { type: 'auth_ok' } : { type: 'auth_invalid' });
      } else if (msg.type === 'auth/current_user') {
        send({ id: msg.id, type: 'result', success: true, result: haUser });
      }
    }
  });
  socket.on('error', () => {});
});

await new Promise((resolve) => ha.listen(0, '127.0.0.1', resolve));
const HA_INTERNAL = `http://127.0.0.1:${ha.address().port}`;

process.env.HOMEASSISTANT_URL = 'https://ha.example.test';
process.env.HOMEASSISTANT_INTERNAL_URL = HA_INTERNAL;
process.env.BASE_URL = 'https://family.example.test';

// ---------------------------------------------------------------------------
// Yuvomi
// ---------------------------------------------------------------------------

const dbmod = await import('../server/db.js');
const { router: authRouter, sessionMiddleware } = await import('../server/auth.js');
const { isOidcEnabled, ssoProvider } = await import('../server/services/oidc.js');
const database = dbmod.get();

const MEMBER = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('phillip', 'Phillip', 'x', 'admin')
`).run().lastInsertRowid);
const CSRF = 'cd'.repeat(32);

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.post('/__test/sign-in', (req, res) => {
  req.session.userId = MEMBER;
  req.session.role = 'admin';
  req.session.csrfToken = CSRF;
  req.session.save(() => res.json({ ok: true }));
});
app.get('/__test/whoami', (req, res) => res.json({ userId: req.session.userId ?? null }));
app.use('/api/v1/auth', authRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { server.close(); ha.close(); });

function cookiesOf(res, previous = '') {
  const jar = new Map(previous ? previous.split('; ').map((c) => c.split('=')) : []);
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function quiet(run) {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try { return await run(); } finally { console.error = error; console.warn = warn; }
}

/** Der Browser bei Home Assistant: Login klappt, HA leitet mit Code zurueck. */
function haIssuesCode(authorize) {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  issuedCodes.set(code, authorize.searchParams.get('code_challenge'));
  return code;
}

test.beforeEach(() => {
  tokenRequests = [];
  revoked = [];
  wsAuthTokens = [];
  haUser = HA_USER;
  delete process.env.OIDC_ALLOW_SIGNUP;
});

test('Home Assistant gilt als SSO-Quelle, wenn HOMEASSISTANT_URL und BASE_URL gesetzt sind', async () => {
  assert.equal(isOidcEnabled(), true);
  assert.equal(ssoProvider(), 'homeassistant');
  const cfg = await (await fetch(`${base}/api/v1/auth/oidc/config`)).json();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.provider, 'homeassistant');
});

test('Ein klassischer OIDC-Anbieter hat Vorrang vor Home Assistant', () => {
  process.env.OIDC_ISSUER = 'https://idp.test/';
  process.env.OIDC_CLIENT_ID = 'x';
  process.env.OIDC_CLIENT_SECRET = 'y';
  process.env.OIDC_REDIRECT_URI = 'https://family.example.test/api/v1/auth/oidc/callback';
  try {
    assert.equal(ssoProvider(), 'oidc');
  } finally {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
  }
});

test('/oidc/start leitet zur Home-Assistant-Anmeldung mit client_id, redirect_uri, state und PKCE', async () => {
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('location'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://ha.example.test/auth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'https://family.example.test/');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://family.example.test/api/v1/auth/oidc/callback');
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
});

test('Rueckweg: unbekannter HA-Benutzer bekommt ein Konto (Signup erlaubt), Token wird widerrufen', async () => {
  haUser = { id: 'ha-user-new', name: 'Lea', is_owner: false, is_admin: false };
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  const cookie = cookiesOf(start);
  const authorize = new URL(start.headers.get('location'));
  const code = haIssuesCode(authorize);

  const cb = await fetch(`${base}/api/v1/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie },
  });
  assert.equal(cb.headers.get('location'), '/');
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].get('client_id'), 'https://family.example.test/');
  assert.equal(tokenRequests[0].get('grant_type'), 'authorization_code');
  assert.deepEqual(wsAuthTokens, ['access-1']);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(revoked, ['refresh-1'], 'das Refresh-Token wird in Home Assistant widerrufen');

  const row = database.prepare('SELECT display_name, oidc_sub, oidc_provider, role FROM users WHERE oidc_sub = ?').get('ha-user-new');
  assert.equal(row.display_name, 'Lea');
  assert.equal(row.oidc_provider, 'https://ha.example.test');
  assert.equal(row.role, 'member', 'HA-Admin-Rechte werden nicht uebernommen');

  const who = await (await fetch(`${base}/__test/whoami`, { headers: { cookie: cookiesOf(cb, cookie) } })).json();
  assert.ok(who.userId, 'die Sitzung ist angemeldet');
});

test('Rueckweg mit falschem state wird abgewiesen, ohne Home Assistant zu fragen', async () => {
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  const cookie = cookiesOf(start);
  const code = haIssuesCode(new URL(start.headers.get('location')));
  const cb = await quiet(() => fetch(`${base}/api/v1/auth/oidc/callback?code=${code}&state=falsch`, {
    redirect: 'manual', headers: { cookie },
  }));
  assert.equal(cb.headers.get('location'), '/login?error=oidc_state_mismatch');
  assert.equal(tokenRequests.length, 0);
});

test('Ohne passenden PKCE-Verifier scheitert der Tausch', async () => {
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  const cookie = cookiesOf(start);
  const authorize = new URL(start.headers.get('location'));
  const code = 'fremder-code';
  issuedCodes.set(code, 'eine-andere-challenge');
  const cb = await quiet(() => fetch(`${base}/api/v1/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie },
  }));
  assert.equal(cb.headers.get('location'), '/login?error=oidc_failed');
});

test('OIDC_ALLOW_SIGNUP=false: unbekannter HA-Benutzer bekommt kein Konto', async () => {
  process.env.OIDC_ALLOW_SIGNUP = 'false';
  haUser = { id: 'ha-user-guest', name: 'Gast', is_owner: false, is_admin: false };
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  const cookie = cookiesOf(start);
  const authorize = new URL(start.headers.get('location'));
  const code = haIssuesCode(authorize);
  const cb = await quiet(() => fetch(`${base}/api/v1/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie },
  }));
  assert.equal(cb.headers.get('location'), '/login?error=oidc_signup_disabled');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users WHERE oidc_sub = ?').get('ha-user-guest').n, 0);
});

test('Verknuepfen: ein angemeldetes Konto bindet seinen HA-Benutzer und meldet sich danach darueber an', async () => {
  process.env.OIDC_ALLOW_SIGNUP = 'false';
  const signIn = await fetch(`${base}/__test/sign-in`, { method: 'POST' });
  let cookie = cookiesOf(signIn);
  const linkStart = await fetch(`${base}/api/v1/auth/oidc/link/start`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': CSRF },
    body: '{}',
  });
  assert.equal(linkStart.status, 200);
  cookie = cookiesOf(linkStart, cookie);
  const authorize = new URL((await linkStart.json()).url);
  const code = haIssuesCode(authorize);
  const cb = await fetch(`${base}/api/v1/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie },
  });
  assert.equal(cb.headers.get('location'), '/settings/personal/account?oidc_linked=1');
  assert.equal(database.prepare('SELECT oidc_sub FROM users WHERE id = ?').get(MEMBER).oidc_sub, 'ha-user-1');

  // Danach: frische Sitzung, Anmeldung ueber Home Assistant landet im verknuepften Konto.
  const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
  const fresh = cookiesOf(start);
  const auth2 = new URL(start.headers.get('location'));
  const code2 = haIssuesCode(auth2);
  const cb2 = await fetch(`${base}/api/v1/auth/oidc/callback?code=${code2}&state=${auth2.searchParams.get('state')}`, {
    redirect: 'manual', headers: { cookie: fresh },
  });
  assert.equal(cb2.headers.get('location'), '/');
  const who = await (await fetch(`${base}/__test/whoami`, { headers: { cookie: cookiesOf(cb2, fresh) } })).json();
  assert.equal(who.userId, MEMBER);
});
