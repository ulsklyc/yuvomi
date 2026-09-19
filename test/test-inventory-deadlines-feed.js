/**
 * Test: Inventar-Garantiefristen-Feed (Stufe 4)
 * Zweck: (1) Reine ICS-Erzeugung aus server/services/inventory-deadlines-ics.js -
 *        nur Gegenstände mit vollständigen Garantiedaten, ein VEVENT je
 *        Gegenstand, RFC-5545-Escaping über den bestehenden ics-export.js-Helfer.
 *        (2) Token-Lebenszyklus (get/regenerate/clear) gegen die per-Nutzer-
 *        Spalte users.inventory_deadlines_feed_token (Migration 144), inklusive
 *        der Isolation, für die es sie gibt: ein Rückzug trifft ein Abo.
 *        (3) Der Verwaltungs-Router (/inventory/deadlines-feed) end-to-end.
 * Ausführen: node --experimental-sqlite --test test/test-inventory-deadlines-feed.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const deadlinesIcs = await import('../server/services/inventory-deadlines-ics.js');
const { default: deadlinesFeedRouter } = await import('../server/routes/inventory/deadlines-feed.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const db = dbmod.get();

// Der ICS-Text folgt der Datensprache des Haushalts (sync_config.language),
// genau wie die Geburtstags-Termine - nicht mehr fest Deutsch.
function setHouseholdLanguage(language) {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(language);
}

function insertItem(fields = {}) {
  const f = { name: 'Espressomaschine', purchase_date: null, warranty_months: null, ...fields };
  return db.prepare(`
    INSERT INTO inventory_items (name, purchase_date, warranty_months)
    VALUES (@name, @purchase_date, @warranty_months)
  `).run(f).lastInsertRowid;
}

// --------------------------------------------------------
// buildInventoryDeadlinesFeed
// --------------------------------------------------------

test('buildInventoryDeadlinesFeed enthält nur Gegenstände mit vollständigen Garantiedaten', () => {
  insertItem({ name: 'Mit Garantie', purchase_date: '2026-01-01', warranty_months: 12 });
  insertItem({ name: 'Ohne Kaufdatum', warranty_months: 12 });
  insertItem({ name: 'Ohne Garantiemonate', purchase_date: '2026-01-01' });

  setHouseholdLanguage('de');
  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(veventCount, 1);
  assert.match(ics, /SUMMARY:Garantie endet: Mit Garantie/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270101/);
});

test('buildInventoryDeadlinesFeed escaped Sonderzeichen im Namen', () => {
  db.exec('DELETE FROM inventory_items');
  insertItem({ name: 'Kaffee; Maschine, Pro', purchase_date: '2026-06-15', warranty_months: 6 });

  setHouseholdLanguage('de');
  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  assert.match(ics, /SUMMARY:Garantie endet: Kaffee\\; Maschine\\, Pro/);
});

test('buildInventoryDeadlinesFeed überspringt unparsbare Kaufdaten statt den Feed zu sprengen', () => {
  db.exec('DELETE FROM inventory_items');
  // Kalendarisch unmögliches Datum - so etwas kam frueher durch die reine
  // Formatpruefung in server/middleware/validate.js#date. Eine einzige solche
  // Zeile darf den Feed nicht fuer alle Abonnenten stilllegen.
  insertItem({ name: 'Kaputtes Datum', purchase_date: '2026-02-30', warranty_months: 12 });
  insertItem({ name: 'Heiles Datum', purchase_date: '2026-01-01', warranty_months: 12 });

  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /Heiles Datum/);
  assert.doesNotMatch(ics, /Kaputtes Datum/);
});

test('buildInventoryDeadlinesFeed liefert ein valides VCALENDAR-Gerüst auch ohne Gegenstände', () => {
  db.exec('DELETE FROM inventory_items');
  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('buildInventoryDeadlinesFeed enthält ein VEVENT je getrackter Frist zusätzlich zu Garantien', () => {
  db.exec('DELETE FROM inventory_items');
  const itemId = insertItem({ name: 'Auto', purchase_date: '2026-01-01', warranty_months: 12 });
  db.prepare("INSERT INTO inventory_item_dates (item_id, label, date) VALUES (?, 'TÜV', '2027-03-01')").run(itemId);

  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(veventCount, 2, 'ein Garantie- und ein Fristen-VEVENT');
  assert.match(ics, /SUMMARY:Garantie endet: Auto/);
  assert.match(ics, /SUMMARY:TÜV: Auto/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270301/);
});

test('buildInventoryDeadlinesFeed erzeugt für einen Gegenstand ohne Garantie nur die Fristen-VEVENTs', () => {
  db.exec('DELETE FROM inventory_items');
  const itemId = insertItem({ name: 'Fahrrad' });
  db.prepare("INSERT INTO inventory_item_dates (item_id, label, date) VALUES (?, 'Wartung', '2027-05-01')").run(itemId);

  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(veventCount, 1);
  assert.match(ics, /SUMMARY:Wartung: Fahrrad/);
});

test('ein vorgerolltes Datum ("Erledigt" mit interval_months) behaelt seine UID und bewegt nur sein DTSTART', async () => {
  db.exec('DELETE FROM inventory_items');
  const owner = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('c','C','x','member')").run().lastInsertRowid;

  const itemsApp = express();
  itemsApp.use(express.json());
  itemsApp.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  itemsApp.use('/items', itemsRouter);
  const itemsServer = itemsApp.listen(0, '127.0.0.1');
  const itemsBaseUrl = await new Promise((r) => itemsServer.on('listening', () => r(`http://127.0.0.1:${itemsServer.address().port}`)));

  try {
    const created = await (await fetch(`${itemsBaseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Auto', category: 'vehicles',
        tracked_dates: [{ label: 'HU/TÜV', date: '2027-03-01', interval_months: 24 }],
      }),
    })).json();
    const itemId = created.data.id;
    const dateId = created.data.tracked_dates[0].id;

    const before = deadlinesIcs.buildInventoryDeadlinesFeed(db);
    assert.match(before, new RegExp(`UID:inventory-tracked-date-${dateId}@yuvomi`));
    assert.match(before, /DTSTART;VALUE=DATE:20270301/);

    await fetch(`${itemsBaseUrl}/items/${itemId}/dates/${dateId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ performed_on: '2027-02-28' }),
    });

    const after = deadlinesIcs.buildInventoryDeadlinesFeed(db);
    assert.match(after, new RegExp(`UID:inventory-tracked-date-${dateId}@yuvomi`), 'gleiche UID wie vorher');
    assert.match(after, /DTSTART;VALUE=DATE:20290301/, '24 Monate nach dem 2027-03-01');
    assert.equal((after.match(new RegExp(`UID:inventory-tracked-date-${dateId}@yuvomi`, 'g')) || []).length, 1, 'kein zweites VEVENT fuer dieselbe Frist');
  } finally {
    itemsServer.close();
  }
});

// --------------------------------------------------------
// Migration 144: Token-Spalte auf users
// --------------------------------------------------------

function insertUser(username, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', ?)
  `).run(username, username, role).lastInsertRowid;
}

const alice = insertUser('alice', 'admin');
const bob = insertUser('bob', 'member');

test('Migration 144 legt die Token-Spalte samt partiellem UNIQUE-Index an', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('inventory_deadlines_feed_token'));

  // Zwei Nutzer ohne Token muessen koexistieren duerfen - deshalb ist der
  // UNIQUE-Index partiell (WHERE ... IS NOT NULL), genau wie bei Migration 61.
  assert.equal(deadlinesIcs.getFeedToken(db, alice), null);
  assert.equal(deadlinesIcs.getFeedToken(db, bob), null);

  const token = deadlinesIcs.regenerateFeedToken(db, alice);
  assert.throws(
    () => db.prepare('UPDATE users SET inventory_deadlines_feed_token = ? WHERE id = ?').run(token, bob),
    /UNIQUE/i,
    'dasselbe Token darf nicht zweimal vergeben werden',
  );
  deadlinesIcs.clearFeedToken(db, alice);
});

// --------------------------------------------------------
// Token-Lebenszyklus (pro Nutzer)
// --------------------------------------------------------

test('Token-Lebenszyklus: null ohne Token, regenerate erzeugt, clear entfernt', () => {
  assert.equal(deadlinesIcs.getFeedToken(db, alice), null);

  const token = deadlinesIcs.regenerateFeedToken(db, alice);
  assert.ok(token && token.length > 20);
  assert.equal(deadlinesIcs.getFeedToken(db, alice), token);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, token), alice);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, 'wrong-token'), null);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, null), null);

  const token2 = deadlinesIcs.regenerateFeedToken(db, alice);
  assert.notEqual(token2, token);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, token), null, 'alter Token muss ungültig werden');

  deadlinesIcs.clearFeedToken(db, alice);
  assert.equal(deadlinesIcs.getFeedToken(db, alice), null);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, token2), null);
});

test('Ein Rückzug trifft genau ein Abo, nicht alle', () => {
  // Der ganze Grund für das personengebundene Token (statt sync_config): Alice
  // abschalten darf Bobs Abo nicht mitreißen - und umgekehrt.
  const aliceToken = deadlinesIcs.regenerateFeedToken(db, alice);
  const bobToken = deadlinesIcs.regenerateFeedToken(db, bob);
  assert.notEqual(aliceToken, bobToken);

  deadlinesIcs.clearFeedToken(db, alice);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, aliceToken), null);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, bobToken), bob, 'Bobs Abo muss weiterlaufen');

  // Rotation ist genauso isoliert.
  const bobToken2 = deadlinesIcs.regenerateFeedToken(db, bob);
  assert.equal(deadlinesIcs.getFeedToken(db, alice), null);
  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, bobToken2), bob);

  deadlinesIcs.clearFeedToken(db, bob);
});

test('Kalender- und Inventar-Token sind getrennte Instanzen desselben Musters', async () => {
  // Gemeinsam ist das Muster, nicht der Token-Raum: eigene Spalte, eigener
  // Index, eigene Funktionen. Ein Kalender-Token darf den Inventar-Feed nicht
  // oeffnen und umgekehrt - sonst waere aus "zwei Modelle fuer einen Begriff"
  // ein gemeinsamer Schluessel fuer zwei Feeds geworden.
  const icsExport = await import('../server/services/ics-export.js');

  const calendarToken = icsExport.regenerateFeedToken(db, alice);
  const inventoryToken = deadlinesIcs.regenerateFeedToken(db, alice);
  assert.notEqual(calendarToken, inventoryToken);

  assert.equal(deadlinesIcs.findUserIdByFeedToken(db, calendarToken), null,
    'Kalender-Token darf den Inventar-Feed nicht oeffnen');
  assert.equal(icsExport.findUserIdByFeedToken(db, inventoryToken), null,
    'Inventar-Token darf den Kalender-Feed nicht oeffnen');

  // Und ein Rueckzug auf der einen Seite laesst die andere in Ruhe.
  deadlinesIcs.clearFeedToken(db, alice);
  assert.equal(icsExport.findUserIdByFeedToken(db, calendarToken), alice,
    'Inventar-Abo abschalten darf das Kalender-Abo nicht mitnehmen');

  icsExport.clearFeedToken(db, alice);
});

// --------------------------------------------------------
// Verwaltungs-Router
// --------------------------------------------------------

let actorId = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actorId; next(); });
app.use('/inventory/deadlines-feed', deadlinesFeedRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = alice } = {}) {
  actorId = as;
  const res = await fetch(`${baseUrl}${path}`, { method });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

test('GET /deadlines-feed liefert null ohne aktiven Feed', async () => {
  deadlinesIcs.clearFeedToken(db, alice);
  const r = await call('GET', '/inventory/deadlines-feed');
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('POST /deadlines-feed/regenerate aktiviert den Feed, GET liefert ihn danach', async () => {
  const r = await call('POST', '/inventory/deadlines-feed/regenerate');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
  assert.match(r.body.data.url, /\/feed\/inventory-deadlines\/.+\.ics$/);

  const get = await call('GET', '/inventory/deadlines-feed');
  assert.equal(get.body.data.token, r.body.data.token);
});

test('DELETE /deadlines-feed deaktiviert den Feed', async () => {
  await call('POST', '/inventory/deadlines-feed/regenerate');
  const del = await call('DELETE', '/inventory/deadlines-feed');
  assert.equal(del.status, 200);
  assert.equal(del.body.data.token, null);

  const get = await call('GET', '/inventory/deadlines-feed');
  assert.equal(get.body.data, null);
});

test('Jeder Angemeldete verwaltet sein eigenes Token - auch Nicht-Admins', async () => {
  // Kein Admin-Gate mehr (wie server/routes/calendar/feed.js): das Token haengt
  // an der eigenen users-Zeile. Bob ist member und muss trotzdem abonnieren
  // koennen - sonst waere "pro Nutzer zurueckziehbar" nur die halbe Miete.
  const bobRes = await call('POST', '/inventory/deadlines-feed/regenerate', { as: bob });
  assert.equal(bobRes.status, 200);
  assert.ok(bobRes.body.data.token);

  const aliceRes = await call('POST', '/inventory/deadlines-feed/regenerate', { as: alice });
  assert.notEqual(aliceRes.body.data.token, bobRes.body.data.token);

  // Niemand sieht das Token des anderen.
  const bobGet = await call('GET', '/inventory/deadlines-feed', { as: bob });
  assert.equal(bobGet.body.data.token, bobRes.body.data.token);

  // Und niemand schaltet das Abo des anderen ab.
  await call('DELETE', '/inventory/deadlines-feed', { as: alice });
  const bobStill = await call('GET', '/inventory/deadlines-feed', { as: bob });
  assert.equal(bobStill.body.data.token, bobRes.body.data.token, 'Bobs Abo muss Alices DELETE ueberleben');

  await call('DELETE', '/inventory/deadlines-feed', { as: bob });
});

test('Feed-Texte folgen der Haushaltssprache statt fest deutsch zu sein', () => {
  db.exec('DELETE FROM inventory_items');
  insertItem({ name: 'Espressomaschine', purchase_date: '2026-01-01', warranty_months: 12 });

  setHouseholdLanguage('de');
  const de = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  assert.match(de, /X-WR-CALNAME:Yuvomi Inventar/);
  assert.match(de, /SUMMARY:Garantie endet: Espressomaschine/);

  setHouseholdLanguage('en');
  const en = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  assert.match(en, /X-WR-CALNAME:Yuvomi Inventory/);
  assert.match(en, /SUMMARY:Warranty ends: Espressomaschine/);
});
