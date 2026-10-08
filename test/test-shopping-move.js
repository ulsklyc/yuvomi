/**
 * Test: einen Einkaufsartikel auf eine andere Liste umziehen (#1700)
 * Zweck: `PATCH /api/v1/shopping/items/:itemId` nimmt `list_id`. Zugesagt in
 *        Discussion #998: der Umzug ist ein echter Umzug auf beiden Seiten -
 *        dieselbe Zeile mit Name, Menge, Kategorie, Notiz und Link, der Rang
 *        gegen die ZIEL-Liste gesetzt, und bei gespiegelten Listen der Eintrag
 *        in der alten CalDAV-Collection entfernt und in der neuen angelegt.
 *        Kein Waise auf jemandes Telefon.
 *
 *        Gefahren wird der echte Router gegen die echte Datenbank und danach
 *        der echte Outbound-Lauf gegen eine Client-Attrappe: was die Route
 *        vormerkt, ist erst dann ein Umzug, wenn daraus ein DELETE in der alten
 *        und ein Anlegen in der neuen Collection wird.
 *
 *        Das Konto zeigt auf 127.0.0.1: der Sofortversuch, den die Route nach
 *        ihrer Antwort anstoesst, scheitert damit lokal und laesst die
 *        Vormerkung liegen - der Lauf mit der Attrappe holt sie ab.
 * Ausführen: npm run test:shopping-move
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const {
  flushOutbound, pendingDeletions, processPendingShoppingCreations, todoUidFor,
} = await import('../server/services/caldav-todo-outbound.js');
const { sync } = await import('../server/services/caldav-reminders-sync.js');
const { loadItemTags, setItemTags } = await import('../server/utils/task-tags.js');
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
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

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

const URL_A = 'https://dav.example/dav/u/alt/';
const URL_B = 'https://dav.example/dav/u/neu/';

function reset() {
  db.prepare('DELETE FROM caldav_todo_pending_deletions').run();
  db.prepare('DELETE FROM shopping_items').run();
  db.prepare('DELETE FROM shopping_lists').run();
  db.prepare('DELETE FROM caldav_reminder_selection').run();
  db.prepare('DELETE FROM caldav_accounts').run();
}

function account() {
  return Number(db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Radicale', 'http://127.0.0.1:9/', 'u', 'p')`).run().lastInsertRowid);
}

function list(name) {
  return Number(db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, U).lastInsertRowid);
}

function mirror(accountId, listUrl, listId) {
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Einkauf', 'shopping', 1, ?)
  `).run(accountId, listUrl, listId);
}

const row = (id) => db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);
const version = (listId) => db.prepare('SELECT version FROM shopping_list_changes WHERE list_id = ?').get(listId).version;

function localItem(listId, fields = {}) {
  const f = { name: 'Brot', quantity: null, category: 'Sonstiges', notes: null, url: null, sort_order: 1, is_checked: 0, ...fields };
  const r = db.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, category, notes, url, sort_order, is_checked)
    VALUES (@listId, @name, @quantity, @category, @notes, @url, @sort_order, @is_checked)
  `).run({ ...f, listId });
  // Der Einfuege-Trigger ordnet ein; der Test will den Rang selbst bestimmen.
  db.prepare('UPDATE shopping_items SET sort_order = ? WHERE id = ?').run(f.sort_order, r.lastInsertRowid);
  return row(r.lastInsertRowid);
}

function mirroredItem(listId, accountId, { uid = 'todo-1@test', listUrl = URL_A, ...fields } = {}) {
  const item = localItem(listId, fields);
  db.prepare(`
    UPDATE shopping_items
       SET external_source = 'caldav', external_uid = ?, external_account_id = ?, external_object_url = ?
     WHERE id = ?
  `).run(uid, accountId, `${listUrl}todo-1.ics`, item.id);
  return row(item.id);
}

/** Attrappe: zwei Collections, sammelt Loeschungen und Uploads. */
function fakeClient({ objects = [], onCreate = null } = {}) {
  const calls = { deleted: [], created: [], updated: [] };
  return {
    calls,
    fetchCalendars: async () => [
      { url: URL_A, displayName: 'Alt', components: ['VTODO'] },
      { url: URL_B, displayName: 'Neu', components: ['VTODO'] },
    ],
    fetchCalendarObjects: async () => objects,
    updateCalendarObject: async (args) => { calls.updated.push(args.calendarObject); return {}; },
    deleteCalendarObject: async (args) => { calls.deleted.push(args.calendarObject); return {}; },
    createCalendarObject: async (args) => {
      calls.created.push(args);
      if (onCreate) await onCreate(args);
      return {};
    },
  };
}

// --------------------------------------------------------------------------
// Der Umzug selbst
// --------------------------------------------------------------------------

test('Umzug: dieselbe Zeile, mit Name, Menge, Kategorie, Notiz, Link, Preis und Haken', async () => {
  reset();
  const a = list('Wocheneinkauf');
  const b = list('Baumarkt');
  const item = localItem(a, { name: 'Dübel', quantity: '20 Stk', notes: '8 mm', url: 'https://example.org/duebel', is_checked: 1 });
  db.prepare('UPDATE shopping_items SET price_cents = 499 WHERE id = ?').run(item.id);

  const r = await call('PATCH', `/items/${item.id}`, { list_id: b });

  assert.equal(r.status, 200);
  assert.equal(r.body.data.id, item.id, 'kein neuer Artikel: die Zeile ist dieselbe');
  assert.equal(r.body.data.list_id, b);
  const now = row(item.id);
  assert.deepEqual(
    [now.name, now.quantity, now.category, now.notes, now.url, now.price_cents, now.is_checked],
    ['Dübel', '20 Stk', 'Sonstiges', '8 mm', 'https://example.org/duebel', 499, 1],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE list_id = ?').get(a).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, 1);
});

test('Umzug: der Rang wird gegen die ZIEL-Liste gesetzt, ans Ende der Kategorie dort', async () => {
  reset();
  const a = list('A');
  const b = list('B');
  // In A steht der Artikel auf Rang 1 - derselbe Rang, den in B schon einer hat.
  const item = localItem(a, { name: 'Milch', sort_order: 1 });
  localItem(a, { name: 'Quark', sort_order: 9 });
  const b1 = localItem(b, { name: 'Brot', sort_order: 1 });
  const b2 = localItem(b, { name: 'Salz', sort_order: 2 });

  const r = await call('PATCH', `/items/${item.id}`, { list_id: b });
  assert.equal(r.status, 200);
  assert.equal(row(item.id).sort_order, 3, 'hinter dem letzten der Zielliste, nicht hinter dem der alten (10)');

  const items = (await call('GET', `/${b}/items`)).body.data.map((i) => i.id);
  assert.deepEqual(items, [b1.id, b2.id, item.id]);
});

test('Umzug mit Kategoriewechsel in einem Zug: gezaehlt wird die neue Kategorie der Zielliste', async () => {
  reset();
  const a = list('A');
  const b = list('B');
  const cats = (await call('GET', '/categories')).body.data.map((c) => c.name);
  const other = cats.find((c) => c !== 'Sonstiges');
  const item = localItem(a, { name: 'Milch', sort_order: 4 });
  localItem(b, { name: 'Brot', category: other, sort_order: 6 });
  localItem(b, { name: 'Salz', sort_order: 2 });

  const r = await call('PATCH', `/items/${item.id}`, { list_id: b, category: other, name: 'Hafermilch' });
  assert.equal(r.status, 200);
  const now = row(item.id);
  assert.deepEqual([now.list_id, now.category, now.name, now.sort_order], [b, other, 'Hafermilch', 7]);
});

test('Umzug: beide Listen bewegen ihre Laufnummer, die Quittung nennt die Herkunft', async () => {
  reset();
  const a = list('A');
  const b = list('B');
  const item = localItem(a);
  const [va, vb] = [version(a), version(b)];

  const r = await call('PATCH', `/items/${item.id}`, { list_id: b });
  assert.equal(r.body.list_change.list_id, a);
  assert.equal(r.body.list_change.before, va);
  assert.ok(r.body.list_change.after > va, 'der Zettel, von dem der Artikel verschwindet, hat sich bewegt');
  assert.equal(r.body.list_change.after, version(a));
  assert.ok(version(b) > vb, 'und der, auf dem er auftaucht, auch');
});

// --------------------------------------------------------------------------
// Absagen
// --------------------------------------------------------------------------

test('Unbekannte Liste: 400, und der Artikel bleibt, wo und wie er ist', async () => {
  reset();
  const a = list('A');
  const item = localItem(a, { name: 'Milch', sort_order: 3 });

  const r = await call('PATCH', `/items/${item.id}`, { list_id: 999999, name: 'Umbenannt' });
  assert.equal(r.status, 400);
  assert.deepEqual(row(item.id), item, 'auch der mitgeschickte Name ist nicht geschrieben');
});

test('Keine Listen-ID: 400 statt eines stillen Nicht-Umzugs', async () => {
  reset();
  const a = list('A');
  const item = localItem(a);
  for (const wert of ['abc', 0, -3, 1.5, true, {}, []]) {
    const r = await call('PATCH', `/items/${item.id}`, { list_id: wert });
    assert.equal(r.status, 400, `list_id ${JSON.stringify(wert)}`);
  }
  assert.equal(row(item.id).list_id, a);
});

test('Nur eine echte Id zieht um: was Number() als die Zielliste LESEN wuerde, ist keine', async () => {
  reset();
  const a = list('A');
  const b = list('B');
  const item = localItem(a);
  // Jeder dieser Werte ergibt unter Number() genau die Id der Zielliste - ein
  // Test mit Werten, die ohnehin NaN sind, misst den Riegel nicht. Das Array
  // und (bei Liste 1) `true` treffen die Typfrage, die uebrigen die Schreibweise.
  const verkleidet = [` ${b} `, `${b}.0`, `${b}e0`, `0x${b.toString(16)}`, `+${b}`, `0${b}`, [b], [String(b)]];
  for (const wert of verkleidet) {
    assert.equal(Number(wert), b, `die Probe taugt nur, wenn Number(${JSON.stringify(wert)}) die Liste trifft`);
    const r = await call('PATCH', `/items/${item.id}`, { list_id: wert });
    assert.equal(r.status, 400, `list_id ${JSON.stringify(wert)}`);
    assert.equal(row(item.id).list_id, a, `list_id ${JSON.stringify(wert)} hat den Artikel bewegt`);
  }
  // Gegenfall: Zahl und reine Ziffernfolge gelten.
  assert.equal((await call('PATCH', `/items/${item.id}`, { list_id: String(b) })).status, 200);
  assert.equal(row(item.id).list_id, b);
  assert.equal((await call('PATCH', `/items/${item.id}`, { list_id: a })).status, 200);
  assert.equal(row(item.id).list_id, a);
});

test('`true` ist keine Liste, auch wenn es die Liste 1 gibt', async () => {
  reset();
  // Number(true) ist 1: die Typfrage ist nur dort messbar, wo es Liste 1 gibt.
  db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run('shopping_lists');
  const eins = list('Eins');
  assert.equal(eins, 1, 'die Probe braucht eine Liste mit der Id 1');
  const a = list('A');
  const item = localItem(a);
  const r = await call('PATCH', `/items/${item.id}`, { list_id: true });
  assert.equal(r.status, 400);
  assert.equal(row(item.id).list_id, a);
});

test('Der Laden nimmt dieselbe Pruefung: eine verkleidete Id ist kein Laden', async () => {
  reset();
  const a = list('A');
  const item = localItem(a);
  const store = Number(db.prepare('INSERT INTO shopping_stores (name, created_by) VALUES (?, ?)').run(`Markt ${Date.now()}`, U).lastInsertRowid);
  for (const wert of [` ${store} `, `${store}.0`, `0x${store.toString(16)}`, [store]]) {
    assert.equal(Number(wert), store);
    const r = await call('PATCH', `/items/${item.id}`, { store_id: wert });
    assert.equal(r.status, 400, `store_id ${JSON.stringify(wert)}`);
  }
  assert.equal(row(item.id).store_id, null);
  assert.equal((await call('PATCH', `/items/${item.id}`, { store_id: String(store) })).status, 200);
  assert.equal(row(item.id).store_id, store);
});

test('Die eigene Liste oder gar keine: kein Umzug, der Rang bleibt', async () => {
  reset();
  const a = list('A');
  const acc = account();
  mirror(acc, URL_A, a);
  const item = mirroredItem(a, acc, { sort_order: 2 });
  localItem(a, { name: 'Salz', sort_order: 5 });

  for (const body of [{ list_id: a }, { list_id: String(a) }, { list_id: null }, { quantity: '2' }]) {
    const r = await call('PATCH', `/items/${item.id}`, body);
    assert.equal(r.status, 200, JSON.stringify(body));
  }
  const now = row(item.id);
  assert.equal(now.sort_order, 2);
  assert.equal(now.external_source, 'caldav', 'der Spiegel bleibt ein Spiegel');
  assert.equal(now.external_uid, 'todo-1@test');
  assert.equal(pendingDeletions(acc, 'shopping').length, 0);
});

// --------------------------------------------------------------------------
// Gespiegelte Listen
// --------------------------------------------------------------------------

test('Gespiegelt -> gespiegelt: in der alten Collection entfernt, in der neuen angelegt', async () => {
  reset();
  const acc = account();
  const a = list('Alt');
  const b = list('Neu');
  mirror(acc, URL_A, a);
  mirror(acc, URL_B, b);
  const item = mirroredItem(a, acc, { name: 'Milch', notes: 'fettarm' });
  setItemTags(db, item.id, ['Bio']);
  // Eine Bearbeitung wartete noch auf ihren Push, zweimal gescheitert: beides
  // gehoert dem alten Objekt und darf nicht mit auf die neue Liste.
  db.prepare('UPDATE shopping_items SET outbound_dirty = 1, outbound_attempts = 2 WHERE id = ?').run(item.id);

  const r = await call('PATCH', `/items/${item.id}`, { list_id: b });
  assert.equal(r.status, 200);

  // Was die Route hinterlaesst: ein Tombstone fuer das alte Objekt, und eine
  // Zeile, die wie hier angelegt aussieht.
  const tombstones = pendingDeletions(acc, 'shopping');
  assert.deepEqual(tombstones.map((t) => [t.uid, t.object_url]), [['todo-1@test', `${URL_A}todo-1.ics`]]);
  const moved = row(item.id);
  assert.deepEqual(
    [moved.list_id, moved.external_source, moved.external_uid, moved.external_account_id, moved.external_object_url,
      moved.outbound_dirty, moved.outbound_attempts],
    [b, 'local', null, null, null, 0, 0],
  );
  assert.equal(moved.notes, 'fettarm');
  assert.deepEqual(loadItemTags(db, item.id), [], 'die Etiketten des alten Objekts gehen mit ihm');

  // Und was daraus auf dem Server wird.
  const client = fakeClient();
  const result = await flushOutbound({ createClient: async () => client });
  assert.deepEqual(client.calls.deleted.map((o) => o.url), [`${URL_A}todo-1.ics`], 'kein Waise in der alten Liste');
  assert.equal(client.calls.created.length, 1);
  assert.equal(client.calls.created[0].calendar.url, URL_B, 'angelegt in der Collection der ZIEL-Liste');
  assert.match(client.calls.created[0].iCalString, /SUMMARY:Milch/);
  assert.deepEqual([result.deleted, result.created], [1, 1]);

  const after = row(item.id);
  assert.equal(after.external_source, 'caldav');
  assert.equal(after.external_object_url, `${URL_B}${todoUidFor('shopping', item.id)}.ics`);
  assert.equal(pendingDeletions(acc, 'shopping').length, 0);
});

test('Gespiegelt -> lokal: remote entfernt, lokal behalten, nichts neu angelegt', async () => {
  reset();
  const acc = account();
  const a = list('Alt');
  const c = list('Nur hier');
  mirror(acc, URL_A, a);
  const item = mirroredItem(a, acc, { name: 'Milch' });

  await call('PATCH', `/items/${item.id}`, { list_id: c });

  const client = fakeClient();
  await flushOutbound({ createClient: async () => client });
  assert.deepEqual(client.calls.deleted.map((o) => o.url), [`${URL_A}todo-1.ics`]);
  assert.equal(client.calls.created.length, 0);
  const after = row(item.id);
  assert.deepEqual([after.list_id, after.name, after.external_source], [c, 'Milch', 'local'], 'lokal nicht geloescht');
});

test('Lokal -> gespiegelt: der Artikel entsteht in der Collection der Zielliste', async () => {
  reset();
  const acc = account();
  const c = list('Nur hier');
  const b = list('Neu');
  mirror(acc, URL_B, b);
  const item = localItem(c, { name: 'Salz' });

  await call('PATCH', `/items/${item.id}`, { list_id: b });

  const client = fakeClient();
  await flushOutbound({ createClient: async () => client });
  assert.equal(client.calls.deleted.length, 0);
  assert.deepEqual(client.calls.created.map((c2) => c2.calendar.url), [URL_B]);
  assert.equal(row(item.id).external_source, 'caldav');
});

test('Der Inbound holt den umgezogenen Artikel nicht in die alte Liste zurueck', async () => {
  reset();
  const acc = account();
  const a = list('Alt');
  const c = list('Nur hier');
  mirror(acc, URL_A, a);
  const item = mirroredItem(a, acc, { name: 'Milch' });

  await call('PATCH', `/items/${item.id}`, { list_id: c });

  // Der Server fuehrt das Objekt noch - das DELETE ist ja noch nicht raus.
  const serverObject = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', 'UID:todo-1@test',
    'DTSTAMP:20260601T000000Z', 'SUMMARY:Milch', 'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  const client = fakeClient({ objects: [{ url: `${URL_A}todo-1.ics`, etag: 'e1', data: serverObject }] });
  await sync({ createClient: async () => client });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, 1, 'kein Wiedergaenger in der alten Liste');
  assert.equal(row(item.id).list_id, c);
  assert.equal(client.calls.deleted.length, 1, 'stattdessen geht die Loeschung raus');
});

test('Umzug waehrend eines laufenden Uploads: das eben angelegte Objekt bleibt kein Waise', async () => {
  reset();
  const acc = account();
  const a = list('Alt');
  const c = list('Nur hier');
  mirror(acc, URL_A, a);
  const item = localItem(a, { name: 'Brot' });

  // Der Upload in die Collection von A wartet auf den Server - und in genau
  // dieser Zeit zieht der Artikel um.
  let status = null;
  const client = fakeClient({
    onCreate: async () => { status = (await call('PATCH', `/items/${item.id}`, { list_id: c })).status; },
  });
  await processPendingShoppingCreations(
    client, acc, [{ listUrl: URL_A, targetListId: a }], new Map([[URL_A, { url: URL_A }]]),
  );
  assert.equal(status, 200);

  const uid = todoUidFor('shopping', item.id);
  const after = row(item.id);
  assert.deepEqual([after.list_id, after.external_source, after.external_uid], [c, 'local', null],
    'die Zeile zeigt von der neuen Liste nicht auf ein Objekt der alten');
  assert.deepEqual(pendingDeletions(acc, 'shopping').map((t) => [t.uid, t.object_url]), [[uid, `${URL_A}${uid}.ics`]],
    'und das Objekt, das es jetzt in der alten Collection gibt, ist zur Loeschung vorgemerkt');
});

// --------------------------------------------------------------------------
// Alles oder nichts, und der Anstoss danach
// --------------------------------------------------------------------------

test('Scheitert der Umzug, ist auch das Loesen vom Server nicht geschehen', async () => {
  reset();
  const acc = account();
  const a = list('Alt');
  const b = list('Neu');
  mirror(acc, URL_A, a);
  const item = mirroredItem(a, acc, { name: 'Milch' });
  setItemTags(db, item.id, ['Bio']);

  // Der Umzug selbst scheitert in der Datenbank - NACH dem Loesen.
  db.exec(`CREATE TEMP TRIGGER probe_move_fails BEFORE UPDATE OF list_id ON shopping_items
           WHEN NEW.list_id = ${b} BEGIN SELECT RAISE(ABORT, 'probe'); END`);
  let status;
  try {
    status = (await call('PATCH', `/items/${item.id}`, { list_id: b })).status;
  } finally {
    db.exec('DROP TRIGGER probe_move_fails');
  }
  assert.equal(status, 500);

  const after = row(item.id);
  assert.deepEqual(
    [after.list_id, after.external_source, after.external_uid, after.external_object_url],
    [a, 'caldav', 'todo-1@test', `${URL_A}todo-1.ics`],
    'der Artikel steht unveraendert als Spiegel auf seiner Liste',
  );
  assert.equal(pendingDeletions(acc, 'shopping').length, 0, 'kein Tombstone fuer ein Objekt, das bleiben soll');
  assert.deepEqual(loadItemTags(db, item.id), ['Bio'], 'und seine Etiketten sind noch da');
});

/** Liest mit, was der Sofortversuch der Route ueber sich sagt. */
async function sofortversuch(fn) {
  const zeilen = [];
  const zuvor = console.warn;
  console.warn = (...args) => { zeilen.push(args.map(String).join(' ')); };
  try {
    await fn();
    // Der Versuch laeuft NACH der Antwort und ohne await.
    for (let i = 0; i < 40 && !zeilen.some((z) => z.includes('Immediate outbound attempt failed')); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    console.warn = zuvor;
  }
  return zeilen.filter((z) => z.includes('Immediate outbound attempt failed'));
}

test('Nach einem Umzug auf eine gespiegelte Liste stoesst die Route den Upload selbst an', async () => {
  reset();
  const acc = account();
  const c = list('Nur hier');
  const b = list('Neu');
  mirror(acc, URL_B, b);
  const item = localItem(c, { name: 'Salz' });

  // Kein gespiegeltes Feld aendert sich, es gibt keinen Tombstone: ohne den
  // eigenen Anstoss wartete der Artikel bis zum naechsten Sync-Lauf. Das Konto
  // zeigt auf 127.0.0.1, der Versuch scheitert also - und sagt es.
  const versuche = await sofortversuch(() => call('PATCH', `/items/${item.id}`, { list_id: b }));
  assert.equal(versuche.length, 1, 'genau ein Sofortversuch');
  assert.match(versuche[0], new RegExp(`Account ${acc}`));
});

test('Gegenfall: ein Speichern ohne Umzug stoesst nichts an', async () => {
  reset();
  const acc = account();
  const c = list('Nur hier');
  const b = list('Neu');
  mirror(acc, URL_B, b);
  const item = localItem(c, { name: 'Salz' });
  const versuche = await sofortversuch(() => call('PATCH', `/items/${item.id}`, { quantity: '2' }));
  assert.deepEqual(versuche, []);
});
