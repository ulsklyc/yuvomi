/**
 * Test: Live-Feed der Einkaufslisten
 * Zweck: Drei Stuecke, die zusammen die Zusage "ein Zettel sieht, was ein
 *        anderer abhakt" tragen:
 *        1. Migration v194 - jeder Schreibweg an shopping_items bewegt die
 *           Laufnummer der Liste, auch einer AN DER ROUTE VORBEI (Essensplan,
 *           CalDAV-Sync, MCP schreiben direkt), und eine geloeschte Liste
 *           laesst keine Zeile zurueck.
 *        2. services/shopping-feed.js - tick() meldet nur Bewegungen, der Takt
 *           laeuft nur mit Zuhoerern.
 *        3. GET /shopping/feed - der Strom beginnt mit dem Stand, traegt eine
 *           Aenderung als `change`, und die Trennung meldet den Zuhoerer ab.
 *        Ueber den echten Router wie test-shopping-routes.js, mit echtem
 *        fetch: eine Attrappe des Antwortobjekts wuesste nichts von Kopfzeilen,
 *        die ein Proxy liest.
 * Ausfuehren: node --experimental-sqlite --test test/test-shopping-feed.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const feed = await import('../server/services/shopping-feed.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = U;
  req.authRole = 'member';
  req.session = { userId: U, role: 'member' };
  next();
});
app.use('/', shoppingRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

async function newList(name = 'Liste') {
  const r = await call('POST', '/', { name });
  return r.body.data.id;
}

async function addItem(listId, name = 'Milch') {
  const r = await call('POST', `/${listId}/items`, { name });
  return r.body.data.id;
}

const versionOf = (listId) => db.prepare('SELECT version FROM shopping_list_changes WHERE list_id = ?').get(listId)?.version ?? null;

test.after(() => new Promise((r) => server.close(r)));

// --------------------------------------------------------------------------
// 1. Migration v194: die Trigger
// --------------------------------------------------------------------------
test('v194: Einfuegen, Aendern und Loeschen eines Artikels bewegen die Laufnummer der Liste', async () => {
  const list = await newList('Trigger');
  assert.equal(versionOf(list), null, 'eine Liste ohne Artikelbewegung hat noch keine Zeile');

  const item = await addItem(list);
  const afterInsert = versionOf(list);
  assert.ok(afterInsert >= 1, 'INSERT legt die Zeile an');

  await call('PATCH', `/items/${item}`, { is_checked: true });
  const afterUpdate = versionOf(list);
  assert.ok(afterUpdate > afterInsert, 'UPDATE (abhaken) bewegt die Nummer');

  await call('DELETE', `/items/${item}`);
  assert.ok(versionOf(list) > afterUpdate, 'DELETE bewegt die Nummer');
});

test('v194: ein Schreibweg an der Route vorbei zaehlt genauso (der Grund fuer den Trigger)', async () => {
  const list = await newList('Direkt');
  const item = await addItem(list);
  const before = versionOf(list);
  // So schreiben Essensplan-Import, CalDAV-Sync und MCP: direkt in die Tabelle.
  db.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(item);
  assert.ok(versionOf(list) > before, 'ein direktes UPDATE bewegt die Nummer, ohne dass jemand daran gedacht hat');
});

test('v194: Artikel zweier Listen zaehlen getrennt', async () => {
  const a = await newList('A');
  const b = await newList('B');
  await addItem(a);
  const va = versionOf(a);
  await addItem(b);
  assert.equal(versionOf(a), va, 'ein Artikel in B bewegt A nicht');
  assert.ok(versionOf(b) >= 1);
});

test('v194: eine geloeschte Liste laesst keine Zeile zurueck', async () => {
  const list = await newList('Weg');
  await addItem(list);
  assert.ok(versionOf(list) >= 1);
  const r = await call('DELETE', `/${list}`);
  assert.equal(r.status, 200);
  assert.equal(versionOf(list), null, 'die Kaskade der Artikel darf die Zeile nicht wiederbeleben');
});

// --------------------------------------------------------------------------
// 2. Der Dienst
// --------------------------------------------------------------------------
test('feed: tick() meldet nur, was sich seit dem letzten Durchgang bewegt hat - und den Takt gibt es nur mit Zuhoerern', async () => {
  const a = await newList('Tick-A');
  const b = await newList('Tick-B');
  await addItem(a);

  assert.equal(feed.__test.isTicking(), false, 'ohne Zuhoerer kein Takt');
  const heard = [];
  const unsubscribe = feed.subscribe((change) => heard.push(change));
  assert.equal(feed.__test.isTicking(), true);
  assert.equal(feed.__test.subscriberCount(), 1);

  feed.tick();
  assert.deepEqual(heard, [], 'nichts bewegt, nichts gemeldet');

  const itemB = await addItem(b);
  await call('PATCH', `/items/${itemB}`, { is_checked: true });
  feed.tick();
  assert.deepEqual(heard, [{ listId: b, version: versionOf(b) }],
    'zwei Schreibvorgaenge in einem Durchgang sind EINE Meldung mit der aktuellen Nummer');

  feed.tick();
  assert.equal(heard.length, 1, 'ein zweiter Durchgang ohne Bewegung meldet nichts');

  unsubscribe();
  assert.equal(feed.__test.subscriberCount(), 0);
  assert.equal(feed.__test.isTicking(), false, 'mit dem letzten Zuhoerer steht der Takt still');
});

test('feed: ein werfender Zuhoerer nimmt die anderen nicht mit', async () => {
  const list = await newList('Wurf');
  const heard = [];
  const off1 = feed.subscribe(() => { throw new Error('kaputt'); });
  const off2 = feed.subscribe((c) => heard.push(c));
  await addItem(list);
  assert.doesNotThrow(() => feed.tick());
  assert.equal(heard.length, 1);
  off1();
  off2();
});

// --------------------------------------------------------------------------
// 3. Die Route
// --------------------------------------------------------------------------

/** Liest den Strom und loest Ereignisse auf, bis `until` erfuellt ist. */
async function readEvents(res, until, { timeoutMs = 5000 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(events)) {
    if (Date.now() > deadline) throw new Error(`Zeit abgelaufen, gesehen: ${JSON.stringify(events)}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event.event = line.slice(7);
        if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
      }
      if (event.event) events.push(event);
    }
  }
  reader.releaseLock();
  return events;
}

test('GET /feed: Kopfzeilen fuer einen Strom, den weder gzip noch nginx sammeln', async () => {
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/feed`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-transform/);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  ac.abort();
});

test('GET /feed: beginnt mit dem Stand aller Listen, meldet eine Aenderung, und die Trennung meldet ab', async () => {
  const list = await newList('Strom');
  const item = await addItem(list);
  const before = feed.__test.subscriberCount();

  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/feed`, { signal: ac.signal });
  const [snapshot] = await readEvents(res, (evs) => evs.length >= 1);
  assert.equal(snapshot.event, 'versions');
  const mine = snapshot.data.lists.find((l) => l.listId === list);
  assert.ok(mine, 'die eigene Liste steht im Stand beim Verbinden');
  assert.equal(mine.version, versionOf(list));
  assert.equal(feed.__test.subscriberCount(), before + 1, 'die Verbindung hoert zu');

  await call('PATCH', `/items/${item}`, { is_checked: true });
  feed.tick(); // statt eine Sekunde auf den Takt zu warten
  const events = await readEvents(res, (evs) => evs.some((e) => e.event === 'change' && e.data.listId === list));
  const change = events.find((e) => e.event === 'change' && e.data.listId === list);
  assert.equal(change.data.version, versionOf(list));

  ac.abort();
  // Das Schliessen kommt ueber den Socket an, nicht sofort.
  for (let i = 0; i < 50 && feed.__test.subscriberCount() > before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(feed.__test.subscriberCount(), before, 'die Trennung meldet den Zuhoerer ab');
});
