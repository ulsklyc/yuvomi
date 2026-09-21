/**
 * Test: Verlauf einer Split-Gruppe seitenweise (#1309)
 * Zweck: Der Verlauf lud nur die letzten 12 Eintraege; aeltere Zahlungen waren
 *        in der Oberflaeche nicht stornierbar. Jetzt blaettert ein Cursor
 *        (`before_at` + `before_id`, aus `pagination.next_cursor`) durch JEDEN
 *        Eintrag, am selben Endpunkt.
 *
 *        Gemessen ueber den ECHTEN Server (test/server-ready.js): Modul-Gate
 *        und Gruppenzugriff sitzen davor, und eine Suite am nackten Router
 *        saehe sie nie. Die Eintraege selbst werden mit festen Zeitstempeln in
 *        `expense_activity` gesaet - nur so lassen sich viele Eintraege in
 *        DERSELBEN Sekunde erzeugen, und genau dort bricht ein Cursor, der nur
 *        den Zeitstempel kennt.
 *
 *        Die zentralen Zusicherungen:
 *        - Blaettern liefert jeden Eintrag genau einmal, auch wenn Seitengrenzen
 *          mitten in einer Sekunde liegen.
 *        - Ein Eintrag, der zwischen zwei Seiten dazukommt, verschiebt nichts.
 *        - Ohne Cursor liefert der Endpunkt dieselbe Liste wie vorher - gegen
 *          die ALTE Abfrage gemessen, nicht gegen die neue.
 * Ausfuehren: npm run test:split-activity-pagination
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'split-activity-pagination',
  env: { SESSION_SECRET: 'test-split-activity-pagination-secret-32', RATE_LIMIT_MAX_ATTEMPTS: '50' },
});
const db = (await import('../server/db.js')).get();

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
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, body: json };
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

const OWN = await member('owner', 'Olivia');
const CR = await member('creator', 'Clara');
const RD = await member('reader', 'Rita');
const OUT = await member('outsider', 'Otto');
assert.equal((await adminCall('PUT', `/permissions/user/${RD.id}`, { modules: { budget: 'read' } })).status, 200);

async function newGroup(name) {
  const r = await OWN.call('POST', '/split-expenses/groups', { name, type: 'household', default_currency: 'EUR' });
  assert.equal(r.status, 201);
  const id = r.body.data.id;
  for (const u of [CR, RD]) {
    assert.equal((await OWN.call('POST', `/split-expenses/groups/${id}/members`, { user_id: u.id, role: 'guest' })).status, 201);
  }
  return id;
}

const seedStmt = db.prepare(`
  INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata, created_at)
  VALUES (?, ?, 'comment_added', 'expense', NULL, '{}', ?)
`);
const seed = (groupId, createdAt) => Number(seedStmt.run(groupId, OWN.id, createdAt).lastInsertRowid);

/** Alle Eintraege der Gruppe in der zugesagten Reihenfolge: neueste Sekunde zuerst, darin nach id. */
const allIds = (groupId) => db.prepare('SELECT id, created_at FROM expense_activity WHERE group_id = ?').all(groupId)
  .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : (a.created_at < b.created_at ? 1 : -1)))
  .map((row) => row.id);

/** Die Abfrage, wie sie VOR dem Cursor im Router stand - die Referenz fuer "wie bisher". */
const legacyIds = (groupId, limit, offset) => db.prepare(`
  SELECT a.id
  FROM expense_activity a
  LEFT JOIN users u ON u.id = a.actor_id
  WHERE a.group_id = ?
  ORDER BY a.created_at DESC
  LIMIT ? OFFSET ?
`).all(groupId, limit, offset).map((row) => row.id);

const feed = (who, groupId, query) => who.call('GET', `/split-expenses/groups/${groupId}/activity?${new URLSearchParams(query)}`);
const cursorQuery = (cursor) => ({ before_at: cursor.before_at, before_id: String(cursor.before_id) });

/** Blaettert per Cursor bis zum Ende und gibt alle IDs in Seitenreihenfolge zurueck. */
async function pageThrough(who, groupId, limit, { between = null } = {}) {
  const ids = [];
  const pages = [];
  let r = await feed(who, groupId, { limit: String(limit) });
  for (let guard = 0; guard < 100; guard += 1) {
    assert.equal(r.status, 200);
    pages.push(r.body.data.map((a) => a.id));
    ids.push(...r.body.data.map((a) => a.id));
    const { has_more: hasMore, next_cursor: next } = r.body.pagination;
    if (!hasMore) {
      assert.equal(next, null, 'ohne weitere Seite kein Cursor');
      return { ids, pages };
    }
    assert.ok(next, 'weitere Seite braucht einen Cursor');
    if (between && pages.length === 1) between();
    // eslint-disable-next-line no-await-in-loop
    r = await feed(who, groupId, { limit: String(limit), ...cursorQuery(next) });
  }
  throw new Error('Blaettern endet nicht');
}

// Gruppe A: 23 Eintraege, zehn in derselben Sekunde, fuenf in einer anderen -
// bei Seitengroesse 4 liegen die Grenzen mitten in beiden Gruppen.
const A = await newGroup('WG-Kasse');
for (let i = 0; i < 10; i += 1) seed(A, '2026-03-01T10:00:00Z');
for (let i = 0; i < 5; i += 1) seed(A, '2026-03-01T09:00:00Z');
for (let i = 0; i < 8; i += 1) seed(A, `2026-02-0${i + 1}T12:00:00Z`);

test('Cursor: jede Seite schliesst an, kein Eintrag doppelt oder verloren - auch bei gleicher Sekunde', async () => {
  const expected = allIds(A);
  assert.ok(expected.length >= 25, 'Saat plus Anlage-Eintraege');
  const { ids, pages } = await pageThrough(OWN, A, 4);
  assert.deepEqual(ids, expected, 'Reihenfolge und Vollstaendigkeit');
  assert.equal(new Set(ids).size, ids.length, 'keine Dubletten');
  assert.ok(pages.slice(0, -1).every((p) => p.length === 4), 'volle Seiten bis auf die letzte');
});

test('Cursor: jede Seitengroesse ergibt dieselbe Liste', async () => {
  const expected = allIds(A);
  for (const size of [1, 3, 7, 10, 100]) {
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual((await pageThrough(OWN, A, size)).ids, expected, `limit ${size}`);
  }
});

test('Einfuegen zwischen zwei Seiten verschiebt nichts - anders als offset', async () => {
  const before = allIds(A);
  const added = [];
  const { ids } = await pageThrough(OWN, A, 4, {
    between: () => {
      // Einer ganz vorn (neueste Sekunde), einer in der Sekunde der Seitengrenze.
      added.push(seed(A, '2026-12-31T23:59:59Z'));
      added.push(seed(A, '2026-03-01T10:00:00Z'));
    },
  });
  assert.equal(new Set(ids).size, ids.length, 'keine Dubletten');
  assert.deepEqual(ids.filter((id) => before.includes(id)), before, 'jeder alte Eintrag genau einmal, in Reihenfolge');
  assert.ok(!ids.includes(added[0]), 'der neueste gehoert vor Seite 1 und erscheint erst beim Neuladen');

  // Gegenueberstellung: dieselbe Lage mit offset liefert einen Eintrag doppelt.
  const p1 = await feed(OWN, A, { limit: '4', offset: '0' });
  seed(A, '2027-01-01T00:00:00Z');
  const p2 = await feed(OWN, A, { limit: '4', offset: '4' });
  const both = [...p1.body.data, ...p2.body.data].map((a) => a.id);
  assert.notEqual(new Set(both).size, both.length, 'offset verschiebt - genau das vermeidet der Cursor');
});

test('Ohne Cursor: dieselbe Liste wie die alte Abfrage, offset wirkt wie bisher', async () => {
  for (const [limit, offset] of [[12, 0], [4, 0], [4, 4], [5, 7], [30, 0], [100, 3]]) {
    const query = offset ? { limit: String(limit), offset: String(offset) } : { limit: String(limit) };
    // eslint-disable-next-line no-await-in-loop
    const r = await feed(OWN, A, query);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((a) => a.id), legacyIds(A, limit, offset), `limit ${limit} offset ${offset}`);
    assert.deepEqual(Object.keys(r.body.pagination).sort(), ['has_more', 'limit', 'next_cursor', 'offset']);
    assert.equal(r.body.pagination.limit, limit);
    assert.equal(r.body.pagination.offset, offset);
  }
  // Ganz ohne Parameter: Standardgroesse 30 wie bisher.
  const plain = await feed(OWN, A, {});
  assert.deepEqual(plain.body.data.map((a) => a.id), legacyIds(A, 30, 0));
  assert.equal(plain.body.pagination.limit, 30);
});

test('Ohne Cursor: next_cursor der ersten Seite fuehrt nahtlos weiter', async () => {
  const first = await feed(OWN, A, { limit: '12' });
  const second = await feed(OWN, A, { limit: '12', ...cursorQuery(first.body.pagination.next_cursor) });
  assert.equal(second.status, 200);
  assert.deepEqual([...first.body.data, ...second.body.data].map((a) => a.id), allIds(A).slice(0, 24));
  assert.deepEqual(Object.keys(second.body.pagination).sort(), ['has_more', 'limit', 'next_cursor'], 'kein offset im Cursor-Modus');
});

test('has_more ist genau: bei exakt limit Eintraegen false', async () => {
  const E = await newGroup('Genau');
  const n = allIds(E).length;
  const r = await feed(OWN, E, { limit: String(n) });
  assert.equal(r.body.data.length, n);
  assert.equal(r.body.pagination.has_more, false);
  assert.equal(r.body.pagination.next_cursor, null);
  seed(E, '2026-01-01T00:00:00Z');
  const more = await feed(OWN, E, { limit: String(n) });
  assert.equal(more.body.pagination.has_more, true);
});

test('Obergrenze: limit ueber 100 liefert 100 je Seite, auch mit Cursor', async () => {
  const C = await newGroup('Viele');
  for (let i = 0; i < 130; i += 1) seed(C, '2026-04-01T08:00:00Z');
  const expected = allIds(C);
  const first = await feed(OWN, C, { limit: '500' });
  assert.equal(first.body.data.length, 100);
  assert.equal(first.body.pagination.limit, 100);
  assert.equal(first.body.pagination.has_more, true);
  const rest = await feed(OWN, C, { limit: '500', ...cursorQuery(first.body.pagination.next_cursor) });
  assert.equal(rest.body.pagination.limit, 100);
  assert.equal(rest.body.pagination.has_more, false);
  assert.deepEqual([...first.body.data, ...rest.body.data].map((a) => a.id), expected);
});

test('Ungueltiger Cursor -> 400, Cursor und offset zusammen -> 400', async () => {
  const at = '2026-03-01T10:00:00Z';
  for (const query of [{ before_at: at }, { before_id: '5' }, { before_at: at, before_id: '0' }, { before_at: at, before_id: 'x' }, { before_at: 'x'.repeat(65), before_id: '5' }]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await feed(OWN, A, query);
    assert.equal(r.status, 400, JSON.stringify(query));
    assert.match(r.body.error, /before_at and before_id/);
  }
  const both = await feed(OWN, A, { before_at: at, before_id: '5', offset: '3' });
  assert.equal(both.status, 400);
  assert.equal(both.body.error, 'Use either a cursor or offset, not both.');
});

test('Rechte unveraendert: Aussenstehender 404, budget: read blaettert mit', async () => {
  const first = await feed(OWN, A, { limit: '4' });
  const next = cursorQuery(first.body.pagination.next_cursor);
  const out = await feed(OUT, A, { limit: '4', ...next });
  assert.equal(out.status, 404);
  const rd = await feed(RD, A, { limit: '4', ...next });
  assert.equal(rd.status, 200, 'Lesen ist bei budget: read erlaubt');
  assert.deepEqual(rd.body.data.map((a) => a.id), allIds(A).slice(4, 8));
});

test('Eine Zahlung auf einer spaeteren Seite traegt ihren Stand und ist stornierbar', async () => {
  const B = await newGroup('Reise');
  const exp = await OWN.call('POST', `/split-expenses/groups/${B}/expenses`, {
    title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OWN.id,
    participants: [OWN.id, CR.id], expense_date: '2026-09-01',
  });
  assert.equal(exp.status, 201);
  const pay = await CR.call('POST', `/split-expenses/groups/${B}/settlements`, { payer_id: CR.id, payee_id: OWN.id, amount: '15.00', currency: 'EUR' });
  assert.equal(pay.status, 201);
  const sid = pay.body.data.id;
  // Zwoelf neuere Eintraege fuellen die erste Seite, die Zahlung rutscht auf die zweite.
  for (let i = 0; i < 12; i += 1) seed(B, '2099-01-01T00:00:00Z');

  const first = await feed(CR, B, { limit: '12' });
  assert.ok(!first.body.data.some((a) => a.entity_id === sid && a.type === 'payment_registered'), 'nicht auf Seite 1');
  const second = await feed(CR, B, { limit: '12', ...cursorQuery(first.body.pagination.next_cursor) });
  const entry = second.body.data.find((a) => a.type === 'payment_registered' && a.entity_id === sid);
  assert.ok(entry, 'auf Seite 2');
  assert.equal(entry.settlement.can_reverse, true);
  assert.equal(entry.settlement.reversed_at, null);

  const reversed = await CR.call('POST', `/split-expenses/groups/${B}/settlements/${sid}/reverse`);
  assert.equal(reversed.status, 200);
  const again = await feed(CR, B, { limit: '12', ...cursorQuery(first.body.pagination.next_cursor) });
  const after = again.body.data.find((a) => a.type === 'payment_registered' && a.entity_id === sid);
  assert.match(after.settlement.reversed_at, /^\d{4}-\d{2}-\d{2}T/);
});
