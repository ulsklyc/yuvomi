/**
 * Test: Schreibrouten ohne Rumpf antworten 4xx, nicht 500 (#2209)
 * Zweck: Express 5 laesst `req.body` undefined, wenn eine Anfrage keinen Rumpf
 *        traegt. Die meisten Schreibrouten destrukturieren `req.body` direkt;
 *        ein POST/PUT/PATCH ohne Rumpf endete als TypeError und 500. Der Fix
 *        sitzt EINMAL in server/index.js (`defaultEmptyBody` hinter den
 *        Body-Parsern), deshalb laeuft die Probe durch den ECHTEN Server
 *        (test/server-ready.js): ein nackt eingehaengter Router saehe die
 *        Middleware nie. Dazu die beiden Leser, die "kein Rumpf" weiter
 *        erkennen muessen: der MCP-Endpunkt (Parse-Error statt leerer Methode)
 *        und - in test/test-idempotency.js - der Idempotenz-Fingerabdruck.
 * Ausfuehren: npm run test:bodyless-writes
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'bodyless-writes',
  env: { SESSION_SECRET: 'test-bodyless-writes-secret-min-32-chars' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();

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
assert.equal(loginRes.status, 200, 'login');
const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
const { csrfToken } = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();

/** Anfrage OHNE Rumpf und ohne Content-Type - genau der Fall aus dem Issue. */
async function bodiless(method, path) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// Stichprobe aus zehn Modulen. Jede dieser Routen destrukturierte `req.body`
// oder las ein Feld daraus ohne `?.` - gegen main antworteten sie 500.
// PUT /preferences ist ein Teil-Update: ohne Felder aendert es nichts und
// antwortet mit den Einstellungen - das ist seine eigene Antwort, kein Fehler.
const ACCEPTS_EMPTY = new Set(['PUT /api/v1/preferences']);
const ROUTES = [
  ['POST', '/api/v1/meals'],
  ['POST', '/api/v1/tasks'],
  ['POST', '/api/v1/shopping/categories'],
  ['POST', '/api/v1/notes'],
  ['POST', '/api/v1/calendar'],
  ['POST', '/api/v1/budget'],
  ['POST', '/api/v1/reminders'],
  ['POST', '/api/v1/pantry'],
  ['POST', '/api/v1/pantry/locations'],
  ['PUT', '/api/v1/preferences'],
  ['POST', '/api/v1/contacts'],
  ['POST', '/api/v1/contacts/categories'],
];

for (const [method, path] of ROUTES) {
  test(`${method} ${path} ohne Rumpf: Validierungsantwort der Route, kein 500`, async () => {
    const r = await bodiless(method, path);
    assert.notEqual(r.status, 500, `${method} ${path} -> 500 ${JSON.stringify(r.body)}`);
    const expected = ACCEPTS_EMPTY.has(`${method} ${path}`) ? [200, 299] : [400, 499];
    assert.ok(r.status >= expected[0] && r.status <= expected[1], `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  });
}

test('ohne Rumpf entsteht nichts: keine Notiz, keine Aufgabe', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

// /mcp liest `req.body` selbst. Mit dem zentralen `{}` darf ein Aufruf ohne
// Rumpf nicht zur JSON-RPC-Anfrage ohne Methode werden: er bleibt der
// Parse-Error mit HTTP 400 wie vor #2209.
const MCP_TOKEN = `yuvomi_test_bodyless_${crypto.randomBytes(8).toString('hex')}`;
db.prepare(`
  INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes)
  VALUES ('mcp', ?, 'yuvomi_test', 1, NULL)
`).run(crypto.createHash('sha256').update(MCP_TOKEN).digest('hex'));

async function mcp(init) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    ...init,
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('POST /mcp ohne Rumpf bleibt ein JSON-RPC-Parse-Error mit 400', async () => {
  const r = await mcp({});
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body?.jsonrpc, '2.0');
  assert.equal(r.body?.error?.code, -32700, 'Parse error, nicht Invalid Request');
});

test('POST /mcp mit ausdruecklich leerem Objekt ist Invalid Request, kein Parse-Error', async () => {
  const r = await mcp({ headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.body?.error?.code, -32600, JSON.stringify(r.body));
});

test('POST /mcp mit gueltiger Anfrage arbeitet wie vorher', async () => {
  const r = await mcp({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.id, 1);
  assert.ok(!r.body?.error, JSON.stringify(r.body));
});
