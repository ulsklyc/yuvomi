/**
 * Test: Inventar-Gegenstaende-Routen (Stufe 1)
 * Zweck: CRUD, volles Replace (kein Feld behaelt den Altwert), Kategorie muss in
 *        inventory_categories existieren (Ablehnung, keine Normalisierung - anders
 *        als in der ersten, einfacheren Version dieses Projekts, weil Kategorien
 *        hier eine echte verwaltbare Tabelle sind, kein fester Code-Vorrat), Ort muss
 *        existieren, Waehrung faellt auf die Haushaltswaehrung zurueck, Filter,
 *        Volltextsuche, Ortspfad-Anzeige.
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-items-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const db = dbmod.get();

const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
// Gleiches Limit wie server/index.js: der Oversized-photo_data-Test muss den
// Validator (400) erreichen, nicht schon an body-parsers Default-Limit (100kb)
// mit 413 scheitern.
app.use(express.json({ limit: '7mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.session = { userId: USER };
  next();
});
app.use('/items', itemsRouter);
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
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

function makeLocation(name, parentId = null) {
  return db.prepare('INSERT INTO inventory_locations (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid;
}

test('POST /items: minimaler Body bekommt Defaults', async () => {
  const r = await call('POST', '/items', { name: 'Laptop' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.category, 'other');
  assert.equal(r.body.data.condition, 'good');
  assert.equal(r.body.data.status, 'active');
  assert.equal(r.body.data.currency, 'EUR');
  assert.equal(r.body.data.location_path, null);
});

test('POST /items: unbekannte Kategorie -> 400 (abgelehnt, nicht normalisiert)', async () => {
  const r = await call('POST', '/items', { name: 'X', category: 'not-a-real-category' });
  assert.equal(r.status, 400);
});

test('POST /items: gueltige Kategorie wird uebernommen und aufgeloest (Seed-Kategorie -> label_key, Migration 142)', async () => {
  const r = await call('POST', '/items', { name: 'Router', category: 'electronics' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.category, 'electronics');
  // 'electronics' ist eine Seed-Kategorie (label_key statt name) - category_name
  // faellt serverseitig bewusst auf den Key zurueck, die Uebersetzung passiert
  // clientseitig ueber category_label_key (siehe public/pages/inventory.js#itemCategoryLabel).
  assert.equal(r.body.data.category_name, 'electronics');
  assert.equal(r.body.data.category_label_key, 'inventory.categoryElectronics');
});

test('POST /items: nicht existenter Ort -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', location_id: 999999 });
  assert.equal(r.status, 400);
});

test('POST /items: gueltiger Ort wird uebernommen, Ortspfad fuer einen Unterort zeigt beide Ebenen', async () => {
  const parent = makeLocation('Keller');
  const child = makeLocation('Regal 2', parent);
  const r = await call('POST', '/items', { name: 'Werkzeugkiste', location_id: child });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.location_path, 'Keller · Regal 2');
});

test('POST /items: negativer Kaufpreis -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', purchase_price: -5 });
  assert.equal(r.status, 400);
});

test('POST /items: Garantiemonate ausserhalb 0-600 -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', warranty_months: 700 });
  assert.equal(r.status, 400);
});

test('POST /items: ungueltige Waehrung -> 400, gueltige wird gross geschrieben uebernommen', async () => {
  assert.equal((await call('POST', '/items', { name: 'X', currency: 'eur1' })).status, 400);
  const r = await call('POST', '/items', { name: 'Y', currency: 'chf' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.currency, 'CHF');
});

test('PUT /items/:id: volles Replace - weggelassene Felder werden NICHT beibehalten', async () => {
  const created = await call('POST', '/items', {
    name: 'Espressomaschine', category: 'household', vendor: 'DeLonghi',
  });
  const r = await call('PUT', `/items/${created.body.data.id}`, { name: 'Espressomaschine' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.category, 'other'); // nicht mehr 'household'
  assert.equal(r.body.data.vendor, null);
});

test('PUT /items/:id: laufende Dokumentlöschung lässt Gegenstand und Termine unverändert', async () => {
  const created = await call('POST', '/items', { name: 'Vorher' });
  const itemId = created.body.data.id;
  const documentId = db.prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES ('Beleg', 'beleg.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?)
  `).run(Buffer.from('x'), USER).lastInsertRowid;

  lockDocumentDeletes([documentId]);
  try {
    const r = await call('PUT', `/items/${itemId}`, {
      name: 'Nachher',
      tracked_dates: [{ label: 'Service', date: '2035-06-01', reminder_offset_days: 14 }],
      attachment_document_ids: [documentId],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(db.prepare('SELECT name FROM inventory_items WHERE id = ?').get(itemId).name, 'Vorher');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_item_dates WHERE item_id = ?').get(itemId).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type IN ('inventory_item', 'inventory_tracked_date') AND entity_id = ?").get(itemId).n, 0);
  } finally {
    unlockDocumentDeletes([documentId]);
  }
});

test('DELETE /items/:id: 204, danach 404', async () => {
  const created = await call('POST', '/items', { name: 'Temp' });
  const del = await call('DELETE', `/items/${created.body.data.id}`);
  assert.equal(del.status, 204);
  assert.equal((await call('GET', `/items/${created.body.data.id}`)).status, 404);
});

test('GET /items: Filter nach category, location_id, status', async () => {
  const loc = makeLocation('Filterort');
  await call('POST', '/items', { name: 'Gefiltert 1', category: 'sports', location_id: loc, status: 'sold' });
  await call('POST', '/items', { name: 'Gefiltert 2', category: 'sports' });

  const byCategory = await call('GET', '/items?category=sports');
  assert.ok(byCategory.body.data.length >= 2);
  assert.ok(byCategory.body.data.every((i) => i.category === 'sports'));

  const byLocation = await call('GET', `/items?location_id=${loc}`);
  assert.ok(byLocation.body.data.some((i) => i.name === 'Gefiltert 1'));

  const byStatus = await call('GET', '/items?status=sold');
  assert.ok(byStatus.body.data.some((i) => i.name === 'Gefiltert 1'));
});

test('GET /items: Volltextsuche ueber Name/Marke/Modell/Seriennummer', async () => {
  await call('POST', '/items', { name: 'Kaffeemuehle', brand: 'Eureka', model: 'Mignon', serial_number: 'ABC123' });
  assert.ok((await call('GET', '/items?q=Eureka')).body.data.some((i) => i.name === 'Kaffeemuehle'));
  assert.ok((await call('GET', '/items?q=ABC123')).body.data.some((i) => i.name === 'Kaffeemuehle'));
  assert.equal((await call('GET', '/items?q=NichtsPasstHier')).body.data.length, 0);
});

// --------------------------------------------------------
// account_username (#1004) - die Kontoangabe OHNE das Geheimnis
// --------------------------------------------------------
test('POST /items: account_username wird gespeichert und zurueckgegeben', async () => {
  const r = await call('POST', '/items', { name: 'Smart-Steckdose', account_username: 'haushalt@example.org' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.account_username, 'haushalt@example.org');
  assert.equal((await call('GET', `/items/${r.body.data.id}`)).body.data.account_username, 'haushalt@example.org');
});

test('PUT /items: account_username laesst sich aendern und wieder leeren', async () => {
  const created = await call('POST', '/items', { name: 'Router', account_username: 'alt@example.org' });
  const id = created.body.data.id;
  const changed = await call('PUT', `/items/${id}`, { name: 'Router', account_username: 'neu@example.org' });
  assert.equal(changed.body.data.account_username, 'neu@example.org');
  // Leer heisst "nicht gesetzt", nicht die leere Zeichenkette - sonst stuende in
  // der Detailzeile ein leerer Wert statt gar keiner.
  const cleared = await call('PUT', `/items/${id}`, { name: 'Router', account_username: '' });
  assert.equal(cleared.body.data.account_username, null);
});

test('GET /items: die Volltextsuche findet auch ueber account_username', async () => {
  // Der eigentliche Zweck des Feldes: "unter welcher Adresse laeuft das Ding".
  // Waere die Spalte nur gespeichert und nicht gesucht, muesste man sie an jedem
  // Gegenstand einzeln aufklappen.
  await call('POST', '/items', { name: 'Heizungssteuerung', account_username: 'technik@example.org' });
  const hits = (await call('GET', '/items?q=technik@example')).body.data;
  assert.ok(hits.some((i) => i.name === 'Heizungssteuerung'));
});

test('POST /items: gueltiges photo_data wird uebernommen und zurueckgegeben', async () => {
  const validPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const r = await call('POST', '/items', { name: 'Item With Photo', photo_data: validPhoto });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.photo_data, validPhoto);
});

test('POST /items: zu grosses photo_data -> 400', async () => {
  const oversized = `data:image/png;base64,${'A'.repeat(7_000_000)}`;
  const r = await call('POST', '/items', { name: 'Item With Oversized Photo', photo_data: oversized });
  assert.equal(r.status, 400);
});

test('POST /items: photo_data ohne gueltigen Bild-MIME-Typ -> 400', async () => {
  const r = await call('POST', '/items', { name: 'Item With Bad Photo', photo_data: 'data:text/plain;base64,aGVsbG8=' });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------
// odometer / odometer_unit / odometer_on
// --------------------------------------------------------
test('POST /items: odometer wird mit Einheit und Ablesedatum gespeichert', async () => {
  const r = await call('POST', '/items', {
    name: 'Auto', category: 'vehicles', odometer: 50000, odometer_unit: 'mi', odometer_on: '2026-09-01',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.odometer, 50000);
  assert.equal(r.body.data.odometer_unit, 'mi');
  assert.equal(r.body.data.odometer_on, '2026-09-01');
});

test('POST /items: odometer ohne explizite Einheit faellt auf km zurueck', async () => {
  const r = await call('POST', '/items', { name: 'Auto', category: 'vehicles', odometer: 120 });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.odometer_unit, 'km');
});

test('POST /items: negativer odometer -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', category: 'vehicles', odometer: -1 });
  assert.equal(r.status, 400);
});

test('POST /items: ungueltige odometer_unit -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', category: 'vehicles', odometer: 10, odometer_unit: 'furlongs' });
  assert.equal(r.status, 400);
});

test('PUT /items/:id: odometer ist volles Replace - weglassen loescht es (deliberate, wie photo_data)', async () => {
  const created = await call('POST', '/items', { name: 'Auto', category: 'vehicles', odometer: 1000, odometer_unit: 'km', odometer_on: '2026-01-01' });
  const id = created.body.data.id;
  const withoutOdometer = await call('PUT', `/items/${id}`, { name: 'Auto', category: 'vehicles' });
  assert.equal(withoutOdometer.status, 200);
  assert.equal(withoutOdometer.body.data.odometer, null);
  assert.equal(withoutOdometer.body.data.odometer_unit, null);
  assert.equal(withoutOdometer.body.data.odometer_on, null);
});

// --------------------------------------------------------
// Kilometerstand ist auf Fahrzeuge begrenzt (Nutzer-Entscheidung 2026-09-17) -
// keine Ausweitung auf andere Kategorien.
// --------------------------------------------------------
test('POST /items: odometer bei einer Nicht-Fahrzeug-Kategorie wird still auf NULL genullt, kein 400', async () => {
  const r = await call('POST', '/items', {
    name: 'Rasenmaeher', category: 'household', odometer: 500, odometer_unit: 'km', odometer_on: '2026-01-01',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.odometer, null);
  assert.equal(r.body.data.odometer_unit, null);
  assert.equal(r.body.data.odometer_on, null);
});

test('PUT /items/:id: ein Kategoriewechsel weg von Fahrzeugen raeumt einen gesetzten odometer automatisch ab', async () => {
  const created = await call('POST', '/items', { name: 'Auto', category: 'vehicles', odometer: 42000, odometer_unit: 'km', odometer_on: '2026-01-01' });
  const id = created.body.data.id;
  const recategorized = await call('PUT', `/items/${id}`, {
    name: 'Auto', category: 'other', odometer: 42000, odometer_unit: 'km', odometer_on: '2026-01-01',
  });
  assert.equal(recategorized.status, 200);
  assert.equal(recategorized.body.data.odometer, null);
  assert.equal(recategorized.body.data.odometer_unit, null);
  assert.equal(recategorized.body.data.odometer_on, null);
});

test('POST /items: eine selbst angelegte Kategorie mit tracks_odometer traegt den Kilometerstand ebenso', () => {
  // Der Mechanismus ist eine Eigenschaft der Kategorie-Zeile
  // (inventory_categories.tracks_odometer), kein Vergleich gegen den festen
  // String 'vehicles' - ein Haushalt, der z.B. "Wohnmobil" als eigene
  // Kategorie anlegt, kann sie ebenso markieren (Review #1257).
  db.prepare("INSERT INTO inventory_categories (key, name, tracks_odometer) VALUES ('camper', 'Wohnmobil', 1)").run();
});

test('POST /items: eine Kategorie mit tracks_odometer=1 nimmt den Kilometerstand', async () => {
  const r = await call('POST', '/items', { name: 'Womo', category: 'camper', odometer: 8000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.odometer, 8000);
});

test('PUT /items/:id: das Loeschen der Fahrzeuge-Kategorie verhaelt sich wie jede andere Kategorieloeschung', async () => {
  // Kein Sonderfall mehr, seit die Grenze an der Kategorie-Zeile haengt statt
  // an einem hartcodierten Namen: Items fallen wie ueberall sonst auf 'other'
  // zurueck, und der odometer raeumt sich wie jedes andere kategoriespezifische
  // Feld beim naechsten Speichern ab (dieselbe Regel wie oben, "Kategoriewechsel
  // raeumt ab") - keine stille Extra-Ueberraschung.
  const created = await call('POST', '/items', { name: 'Zweitauto', category: 'vehicles', odometer: 15000 });
  // Direkt wie server/routes/inventory/categories.js#DELETE /:key - dieser
  // Test haengt nur den items-Router ein, nicht den categories-Router.
  db.prepare("UPDATE inventory_items SET category = 'other' WHERE category = 'vehicles'").run();
  db.prepare("DELETE FROM inventory_categories WHERE key = 'vehicles'").run();
  const reloaded = await call('GET', `/items/${created.body.data.id}`);
  assert.equal(reloaded.body.data.category, 'other', 'Fallback wie bei jeder geloeschten Kategorie');
  assert.equal(reloaded.body.data.odometer, 15000, 'die Ablesung selbst bleibt bis zum naechsten Speichern stehen');
  // seed die Kategorie fuer nachfolgende Tests wieder
  db.prepare("INSERT INTO inventory_categories (key, name, icon, sort_order, tracks_odometer) VALUES ('vehicles', 'Fahrzeuge', 'car', 1, 1)").run();
});

test('PUT /items/:id: photo_data ist volles Replace - weglassen loescht es', async () => {
  const validPhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  const created = await call('POST', '/items', { name: 'Item To Update', photo_data: validPhoto });
  const id = created.body.data.id;

  const withoutPhoto = await call('PUT', `/items/${id}`, { name: 'Item To Update' });
  assert.equal(withoutPhoto.status, 200);
  assert.equal(withoutPhoto.body.data.photo_data, null);
});
