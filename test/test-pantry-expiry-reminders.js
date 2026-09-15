/**
 * Test: Vorrat-Ablauferinnerungen (#811)
 * Zweck: End-to-End über den echten Pantry-Router - Erinnerungs-Lebenszyklus
 *        (löschen+neu anlegen bei jedem Schreibvorgang, wie
 *        server/routes/inventory/items.js#syncReminder):
 *          - genau eine Erinnerung, Ersteller = created_by, wenn ein MHD
 *            gesetzt ist und der Termin noch nicht fällig wäre
 *          - der Vorlauf ist EXPIRY_SOON_DAYS, dieselbe Zahl, die den Chip
 *            "läuft bald ab" auslöst
 *          - kein MHD -> keine Erinnerung (das Datum ist der Schalter)
 *          - Menge 0 -> keine Erinnerung: verbraucht ist nichts mehr zu retten,
 *            und der ±-Stepper (PATCH) räumt sie deshalb ab und legt sie beim
 *            Auffüllen wieder an
 *          - Termin in der Vergangenheit -> keine Erinnerung (kein Nachtrags-
 *            Nagging bei kurz vor dem Ablauf nachgetragenem Bestand)
 *          - PUT/PATCH ersetzen die Erinnerung vollständig
 *          - DELETE /:itemId räumt sie explizit ab (reminders hat keinen FK)
 *          - der Import aus der Einkaufsliste legt sie für beide Wege an
 *            (neue Zeile UND aufgefüllte Charge)
 *          - GET /reminders/pending löst den Titel über den Join auf
 * Ausführen: node --experimental-sqlite --test test/test-pantry-expiry-reminders.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { syncAllPantryExpiryReminders, syncPantryExpiryReminder } = await import('../server/services/pantry-reminders.js');
const { todayKey: householdToday } = await import('../server/utils/timezone.js');
const db = dbmod.get();

/* DIE HAUSHALTSZONE IST EINE EINSTELLUNG, KEIN UMGEBUNGSZUFALL.
 *
 * Mehrere Tests hier arbeiten mit festen Zeitpunkten ("28.08. um 11:00Z") und
 * festen Ablaufdaten. Ohne diese Zeile faellt `todayKey()` auf die Zone der
 * Maschine zurueck, und unter Pacific/Kiritimati (UTC+14) ist der 26.08. um
 * 11:00Z schon der 27. - dieselbe Eingabe ergibt einen anderen Kalendertag,
 * und die Zusicherungen kippen. Zweimal in diesem Branch passiert.
 *
 * Auf UTC gesetzt, weil die Erinnerungstermine ohnehin naiv-UTC sind; die
 * Zonen-Empfindlichkeit des Codes pruefen die Tests, die ihren Bezugstag
 * ausdruecklich aus `householdToday()` holen. */
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** `days` Tage nach einem Datumsschluessel, reine Kalenderarithmetik in UTC. */
function addDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Der Vorlauf steht hier als Zahl, nicht als Import: public/utils/pantry-status.js
 * importiert `/utils/date.js` als Browser-Wurzelpfad und laesst sich in Node
 * nicht laden. Diese Suite prueft deshalb den konkreten Wert; dass Client und
 * Server DIESELBE Zahl meinen, haelt der Guard in test/test-frontend-audit.js
 * ("der Vorlauf der Ablauferinnerung ist die Schwelle des Chips") zusammen.
 */
const EXPIRY_SOON_DAYS = 7;

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.session = { userId: actor.id }; next(); });
app.use('/pantry', pantryRouter);
app.use('/reminders', remindersRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = { id: A }, body } = {}) {
  actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

function reminderFor(itemId) {
  return db.prepare(
    "SELECT * FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = ?"
  ).get(itemId);
}

/** Liegt ein naiv-UTC-Termin hinter uns? Gleiche Lesart wie der Service. */
function reminderIsPast(remindAt) {
  return new Date(`${remindAt}Z`).getTime() <= Date.now();
}

function countReminders(itemId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = ?"
  ).get(itemId).c;
}

/**
 * Bezugstag EINMAL festhalten, nicht je Aufruf neu: ein Lauf, der ueber
 * Mitternacht UTC faellt, bekaeme sonst zwei verschiedene "heute" und die
 * Terminzusage waere um einen Tag daneben.
 *
 * Und bewusst in UTC: `reminderDateBefore()` rechnet rein arithmetisch auf dem
 * Datumsschluessel, ohne je nach "heute" zu fragen - der Test spiegelt genau
 * diese Rechnung. Der einzige zeitabhaengige Teil ist "liegt der Termin schon
 * hinter uns", und dafuer sind die Abstaende hier weit genug gewaehlt, dass
 * keine Zeitzone sie kippen kann.
 */
const TODAY_UTC = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })();

/** Tagesschlüssel `days` Tage nach dem Bezugstag. */
function dateKeyInDays(days) {
  const d = new Date(TODAY_UTC);
  d.setUTCDate(d.getUTCDate() + days);
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-');
}

// Weit genug in der Zukunft, dass der Erinnerungstermin (MHD minus Vorlauf)
// sicher noch bevorsteht.
const FUTURE_EXPIRY = dateKeyInDays(EXPIRY_SOON_DAYS + 30);

test('POST mit MHD legt genau eine Erinnerung an, mit dem Vorlauf des Chips', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Joghurt', quantity: 2, expires_on: FUTURE_EXPIRY } });
  assert.equal(res.status, 201);

  const reminder = reminderFor(res.body.data.id);
  assert.ok(reminder, 'ohne Erinnerung meldet das MHD nie etwas');
  assert.equal(reminder.created_by, A, 'die Meldung gehört dem, der den Artikel eingetragen hat');
  assert.equal(countReminders(res.body.data.id), 1);

  // Der Vorlauf ist die Zahl aus public/utils/pantry-status.js, nicht irgendeine.
  assert.equal(reminder.remind_at, `${dateKeyInDays(30)}T09:00`,
    `der Termin muss ${EXPIRY_SOON_DAYS} Tage vor dem MHD liegen`);
  // Naiv-UTC, kein Zeitzonen-Suffix - sonst rechnet public/utils/reminder-offset.js
  // einen zweiten Offset obendrauf.
  assert.doesNotMatch(reminder.remind_at, /[zZ]|[+-]\d{2}:?\d{2}$/);
});

test('POST ohne MHD legt keine Erinnerung an - das Datum ist der Schalter', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Salz', quantity: 1 } });
  assert.equal(res.status, 201);
  assert.equal(countReminders(res.body.data.id), 0);
});

test('frisch gekaufte Ware mit kurzem MHD meldet am naechsten Morgen', async () => {
  // Der HAUPTFALL dieses Moduls: Milch, Joghurt, Salat haben beim Einkauf fast
  // immer weniger als sieben Tage MHD, ihr Vorlauf liegt also schon hinter uns.
  // Die Inventar-Regel haette sie ersatzlos verworfen - der Chip faerbte sich
  // gelb und die Meldung kam fuer genau diese Artikel nie.
  const res = await call('POST', '/pantry', { body: { name: 'Milch', quantity: 1, expires_on: dateKeyInDays(3) } });
  assert.equal(res.status, 201);

  const reminder = reminderFor(res.body.data.id);
  assert.ok(reminder, 'ohne die Klemmung bliebe Frischware dauerhaft stumm');

  // Geklemmt auf den naechsten 09:00, nicht auf "sofort": eine Ablaufwarnung
  // ist eine Morgenfrage, kein Alarm eine Minute nach dem Eintippen.
  assert.match(reminder.remind_at, /T09:00$/);
  assert.ok(!reminderIsPast(reminder.remind_at), 'ein geklemmter Termin steht bevor');
  assert.ok(reminder.remind_at <= `${dateKeyInDays(1)}T09:00`, 'hoechstens der morgige Morgen');
});

test('ein bereits abgelaufener Artikel bekommt keine Vorwarnung mehr', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Alte Milch', quantity: 1, expires_on: dateKeyInDays(-2) } });
  assert.equal(res.status, 201);
  assert.equal(countReminders(res.body.data.id), 0,
    'eine Vorwarnung auf etwas, das die Frist gerissen hat, ist keine Warnung - das sagt der Chip "abgelaufen"');
});

test('der Voll-Sync holt einen verstrichenen Vorlauf NICHT nach', () => {
  // Die Gegenseite der Klemmung: der Lauf weiss nicht, dass jemand gehandelt
  // hat. Holte er nach, bekaeme ein Haushalt am ersten Morgen nach dem Update
  // jede bald ablaufende Zeile seines Bestands auf einmal.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Feta', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(dateKeyInDays(3), A).lastInsertRowid;

  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0);
});

test('ohne die Handlungs-Option klemmt gar nichts', () => {
  // ZWEI SCHICHTEN, EINZELN GEPRUEFT. Der Test darueber faellt schon am
  // SQL-Grobschnitt der missing-Abfrage - er wuerde gruen bleiben, wenn die
  // Regel selbst verschwaende. Dieser Aufruf geht direkt an die Funktion und
  // trifft deshalb die Zeile, um die es geht: ohne `clampToNextMorning` bleibt
  // ein verstrichener Vorlauf ersatzlos, so wie im Inventar.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Halloumi', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(dateKeyInDays(3), A).lastInsertRowid;

  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id));
  assert.equal(countReminders(id), 0);

  // Und mit der Option entsteht sie - dieselbe Zeile, dieselbe Lage.
  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id),
    new Date(), null, { clampToNextMorning: true });
  assert.equal(countReminders(id), 1);
});

test('Menge 0 bekommt keine Erinnerung, das Auffüllen holt sie zurück', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Butter', quantity: 0, expires_on: FUTURE_EXPIRY } });
  assert.equal(res.status, 201);
  const id = res.body.data.id;
  assert.equal(countReminders(id), 0, 'eine leere Packung hat nichts mehr zu retten');

  const refilled = await call('PATCH', `/pantry/${id}`, { body: { quantity: 3 } });
  assert.equal(refilled.status, 200);
  assert.equal(countReminders(id), 1, 'aufgefüllt ist das MHD wieder relevant');
});

test('der ±-Stepper auf 0 räumt die Erinnerung ab', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Sahne', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = res.body.data.id;
  assert.equal(countReminders(id), 1);

  await call('PATCH', `/pantry/${id}`, { body: { quantity: 0 } });
  assert.equal(countReminders(id), 0);
});

test('PUT ersetzt die Erinnerung vollständig statt sie zu verdoppeln', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Käse', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = res.body.data.id;
  const before = reminderFor(id);

  const later = dateKeyInDays(EXPIRY_SOON_DAYS + 60);
  const put = await call('PUT', `/pantry/${id}`, { body: { name: 'Käse', quantity: 1, expires_on: later } });
  assert.equal(put.status, 200);

  assert.equal(countReminders(id), 1, 'kein Diffing, kein Duplikat');
  const after = reminderFor(id);
  assert.notEqual(after.remind_at, before.remind_at);
  assert.equal(after.remind_at, `${dateKeyInDays(60)}T09:00`);
});

test('PUT das das MHD entfernt räumt die Erinnerung ab', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Quark', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = res.body.data.id;
  assert.equal(countReminders(id), 1);

  await call('PUT', `/pantry/${id}`, { body: { name: 'Quark', quantity: 1, expires_on: null } });
  assert.equal(countReminders(id), 0);
});

test('DELETE /:itemId räumt die Erinnerung mit ab', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Skyr', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = res.body.data.id;
  assert.equal(countReminders(id), 1);

  const del = await call('DELETE', `/pantry/${id}`);
  assert.equal(del.status, 204);
  // reminders hat keinen FK auf pantry_items (entity_id ist polymorph) - ohne
  // das explizite Aufräumen bliebe eine Meldung ohne Artikel zurück.
  assert.equal(countReminders(id), 0);
});

test('der Import aus der Einkaufsliste legt für beide Wege eine Erinnerung an', async () => {
  const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Woche', ?)").run(A).lastInsertRowid;
  const mkChecked = (name) => db.prepare(
    "INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, ?, 'Sonstiges', 1)"
  ).run(listId, name).lastInsertRowid;

  // Weg 1: neue Zeile.
  const fresh = mkChecked('Frischkäse');
  const first = await call('POST', '/pantry/import-shopping', {
    body: { list_id: listId, items: [{ shopping_item_id: fresh, quantity: 1, expires_on: FUTURE_EXPIRY }] },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.added, 1);
  const created = db.prepare('SELECT id FROM pantry_items WHERE name = ?').get('Frischkäse');
  assert.equal(countReminders(created.id), 1, 'ein importierter Artikel meldet wie ein von Hand angelegter');

  // Weg 2: dieselbe Charge auffüllen, nachdem sie ausgebucht wurde.
  await call('PATCH', `/pantry/${created.id}`, { body: { quantity: 0 } });
  assert.equal(countReminders(created.id), 0);

  const again = mkChecked('Frischkäse');
  const second = await call('POST', '/pantry/import-shopping', {
    body: { list_id: listId, items: [{ shopping_item_id: again, quantity: 2, expires_on: FUTURE_EXPIRY }] },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.merged, 1, 'gleiches MHD = dieselbe Charge');
  assert.equal(countReminders(created.id), 1, 'die aufgefüllte Charge meldet wieder');
});

test('GET /reminders/pending löst den Titel für pantry_item über den Join auf', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Hafermilch', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = res.body.data.id;
  // Fällig stellen, ohne auf die Uhr zu warten.
  db.prepare("UPDATE reminders SET remind_at = '2000-01-01T09:00' WHERE entity_type = 'pantry_item' AND entity_id = ?").run(id);

  const pending = await call('GET', '/reminders/pending');
  assert.equal(pending.status, 200);
  const match = pending.body.data.find((r) => r.entity_type === 'pantry_item' && r.entity_id === id);
  assert.ok(match, 'die fällige Erinnerung fehlt in /pending');
  assert.equal(match.entity_title, 'Hafermilch',
    'ohne den pantry_item-Zweig im CASE käme entity_title als NULL an und der Toast zeigte den Ersatztext');
});

test('POST /reminders lehnt pantry_item ab - die Meldung leitet sich aus dem Artikel ab', async () => {
  const item = await call('POST', '/pantry', { body: { name: 'Pesto', quantity: 1 } });
  const res = await call('POST', '/reminders', {
    body: { entity_type: 'pantry_item', entity_id: item.body.data.id, remind_at: '2099-01-01T09:00' },
  });
  // Eine von Hand gesetzte Erinnerung raeumt der naechste Voll-Sync binnen einer
  // Minute ab, weil der Artikel die Bedingungen nicht erfuellt. Sie anzunehmen
  // waere eine Zusage, die niemand haelt - und ihr Verschwinden waere spurlos.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /derived from the item itself/);
  assert.equal(countReminders(item.body.data.id), 0);
});

test('die Leseweg-Liste kennt pantry_item weiterhin - der Toast muss wegwischen koennen', async () => {
  const item = await call('POST', '/pantry', { body: { name: 'Ajvar', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = item.body.data.id;
  const res = await call('GET', `/reminders?entity_type=pantry_item&entity_id=${id}`);
  assert.equal(res.status, 200, 'ohne den Typ in VALID_ENTITY_TYPES antwortete der Lesepfad 400');
  assert.equal(res.body.data.entity_id, id);
});

// --------------------------------------------------------------------------
// DER BESTAND, DEN NIEMAND MEHR ANFASST
//
// Der Router legt die Erinnerung beim Speichern an. Ein Vorrat, der schon vor
// diesem Feature im Regal stand, wird nie gespeichert - ohne den Voll-Sync
// haette genau das unberuehrte Glas hinten im Regal nie gemeldet, also der
// Fall, fuer den #811 ueberhaupt gestellt wurde.
// --------------------------------------------------------------------------
test('der Voll-Sync holt Bestandsartikel nach, die nie durch den Router liefen', () => {
  // Direkt in die Tabelle geschrieben - genau die Lage nach einem Update.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Marmelade', 2, 'jar', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  assert.equal(countReminders(id), 0, 'ein direkter INSERT laeuft an syncReminder vorbei - das ist der Ausgangspunkt');

  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1, 'nach dem Lauf meldet auch der Altbestand');
  assert.equal(reminderFor(id).remind_at, `${dateKeyInDays(30)}T09:00`);
});

test('der Voll-Sync fasst eine bereits zugestellte Erinnerung nicht an', () => {
  // DER FEHLER, DEN DIESER TEST FESTHAELT: der erste Wurf des Voll-Syncs loeschte
  // und legte neu an, wie es der Router tut. Damit fiel bei JEDEM Durchgang
  // `pushed_at` auf NULL zurueck - dieselbe Meldung waere im Minutentakt wieder
  // rausgegangen, und ein Wegwischen haette bis zum naechsten Lauf gehalten.
  //
  // Der Router darf ersetzen, weil er weiss, dass sich der Artikel geaendert
  // hat. Dieser Lauf weiss das nicht und ergaenzt deshalb nur.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Reis', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);

  const before = reminderFor(id);
  db.prepare("UPDATE reminders SET pushed_at = '2026-08-01T09:00:00Z', dismissed = 1 WHERE id = ?").run(before.id);

  syncAllPantryExpiryReminders(db);

  const after = reminderFor(id);
  assert.equal(after.id, before.id, 'die Zeile wurde ersetzt statt in Ruhe gelassen');
  assert.equal(after.pushed_at, '2026-08-01T09:00:00Z', 'zurueckgesetztes pushed_at = dieselbe Meldung nochmal');
  assert.equal(after.dismissed, 1, 'zurueckgesetztes dismissed = das Wegwischen haelt nicht');
});

test('der Voll-Sync ist idempotent - zweimal laufen heisst nicht zwei Meldungen', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Honig', 1, 'jar', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;

  syncAllPantryExpiryReminders(db);
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1);
});

test('der Voll-Sync raeumt ab, was die Bedingungen nicht mehr erfuellt', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Senf', 1, 'jar', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1);

  // Menge am Router vorbei auf 0 gesetzt: die Erinnerung muss trotzdem gehen.
  db.prepare('UPDATE pantry_items SET quantity = 0 WHERE id = ?').run(id);
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0);
});

test('ein Artikel ohne Ersteller bekommt keine Erinnerung - es gaebe keinen Empfaenger', () => {
  // created_by ist seit Migration v109 nullable: wer ein Mitglied loescht,
  // verliert nicht den Haushaltsvorrat. reminders.created_by ist NOT NULL.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Kapern', 1, 'jar', 'Sonstiges', ?, NULL)"
  ).run(FUTURE_EXPIRY).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0);
});

// --------------------------------------------------------------------------
// EIN KAPUTTES DATUM DARF DEN SPEICHERVORGANG NICHT SPRENGEN
// --------------------------------------------------------------------------
test('ein kalendarisch unmoegliches MHD verhindert nur die Meldung, nicht das Speichern', async () => {
  // '2027-02-30' passiert die Form, nicht den Kalender. Bestandszeilen aus der
  // Zeit vor der kalendarischen Pruefung im Import koennen so aussehen.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Altbestand', 1, 'pcs', 'Sonstiges', '2027-02-30', ?)"
  ).run(A).lastInsertRowid;

  // Ohne den Auffangzweig wirft die Rechnung mitten in der Transaktion: der
  // Artikel bliebe dauerhaft unbearbeitbar.
  const res = await call('PATCH', `/pantry/${id}`, { body: { quantity: 5 } });
  assert.equal(res.status, 200, 'ein alter Datensatz darf nicht unbearbeitbar werden');
  assert.equal(res.body.data.quantity, 5);
  assert.equal(countReminders(id), 0);

  // Und der Voll-Sync stirbt nicht an dieser Zeile.
  assert.doesNotThrow(() => syncAllPantryExpiryReminders(db));
});

test('der Import uebernimmt einen Artikel mit unmoeglichem MHD ohne Datum, statt alles zurueckzurollen', async () => {
  const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Import', ?)").run(A).lastInsertRowid;
  const mk = (name) => db.prepare(
    "INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, ?, 'Sonstiges', 1)"
  ).run(listId, name).lastInsertRowid;

  const bad = mk('Schlechtes Datum');
  const good = mk('Gutes Datum');
  const res = await call('POST', '/pantry/import-shopping', {
    body: {
      list_id: listId,
      items: [
        { shopping_item_id: bad, quantity: 1, expires_on: '2027-02-30' },
        { shopping_item_id: good, quantity: 1, expires_on: FUTURE_EXPIRY },
      ],
    },
  });

  // Vor der kalendarischen Pruefung riss die erste Zeile die zweite mit: 500,
  // Transaktion zurueckgerollt, auch der gueltige Artikel weg.
  assert.equal(res.status, 200);
  assert.equal(res.body.data.added, 2, 'beide Artikel landen im Vorrat');

  const badRow = db.prepare('SELECT * FROM pantry_items WHERE name = ?').get('Schlechtes Datum');
  assert.equal(badRow.expires_on, null,
    'das unmoegliche Datum faellt weg - der Artikel selbst ist in Ordnung und kommt an');
  assert.equal(countReminders(badRow.id), 0);

  const goodRow = db.prepare('SELECT * FROM pantry_items WHERE name = ?').get('Gutes Datum');
  assert.equal(goodRow.expires_on, FUTURE_EXPIRY);
  assert.equal(countReminders(goodRow.id), 1);
});

test('der Voll-Sync zieht einen veralteten Termin gerade, solange er nichts getan hat', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Oliven', 1, 'jar', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);

  // MHD am Router vorbei verschoben - so sieht es nach einem Restore aus.
  const later = dateKeyInDays(EXPIRY_SOON_DAYS + 90);
  db.prepare('UPDATE pantry_items SET expires_on = ? WHERE id = ?').run(later, id);

  syncAllPantryExpiryReminders(db);
  assert.equal(reminderFor(id).remind_at, `${dateKeyInDays(90)}T09:00`,
    'sonst meldet die Zeile zu einem Zeitpunkt, den ihr eigener Text nicht mehr traegt');
});

test('einen bereits zugestellten Termin zieht der Voll-Sync NICHT gerade', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Kichererbsen', 1, 'can', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  const before = reminderFor(id);
  db.prepare("UPDATE reminders SET pushed_at = '2026-08-01T09:00:00Z' WHERE id = ?").run(before.id);

  db.prepare('UPDATE pantry_items SET expires_on = ? WHERE id = ?').run(dateKeyInDays(EXPIRY_SOON_DAYS + 90), id);
  syncAllPantryExpiryReminders(db);

  // Ein neuer Termin auf einer zugestellten Zeile hiesse: dieselbe Meldung
  // noch einmal. Der Router ersetzt sie, sobald jemand den Artikel anfasst.
  assert.equal(reminderFor(id).remind_at, before.remind_at);
});

test('eine Bestandszeile mit unmoeglichem Datum kommt gar nicht erst in die Rechnung', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Sardellen', 1, 'can', 'Sonstiges', '2027-02-30', ?)"
  ).run(A).lastInsertRowid;

  // Ohne den kalendarischen SQL-Filter landete die Zeile in JEDEM Lauf in der
  // Rechnung und schriebe dieselbe Warnung - bei einem Lauf je Minute rund
  // 1440 Zeilen am Tag fuer einen Artikel, an dem sich nichts aendert.
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0);
});

test('PUT /reminders lehnt pantry_item ebenso ab wie POST', async () => {
  const item = await call('POST', '/pantry', { body: { name: 'Tahini', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = item.body.data.id;
  assert.equal(countReminders(id), 1);

  const res = await call('PUT', `/reminders?entity_type=pantry_item&entity_id=${id}`, {
    body: { remind_ats: ['2099-01-01T09:00', '2099-01-02T09:00', '2099-01-03T09:00'] },
  });

  // PUT ersetzt die GANZE Menge und darf bis zu fuenf Termine schreiben. Ohne
  // den Riegel loeschte es die abgeleitete Zeile, schriebe drei eigene - und der
  // naechste Voll-Sync zoege alle drei auf denselben Zeitpunkt: drei identische
  // Meldungen fuer einen Joghurt.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /derived from the item itself/);
  assert.equal(countReminders(id), 1, 'die abgeleitete Erinnerung bleibt unangetastet');
});

test('der Voll-Sync zieht eine ueberholte Zeile nach vorne, nie in die Vergangenheit', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Linsen', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(dateKeyInDays(EXPIRY_SOON_DAYS + 60), A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  const before = reminderFor(id);

  // MHD am Router vorbei nach vorne gezogen - der Restore-Fall.
  db.prepare('UPDATE pantry_items SET expires_on = ? WHERE id = ?').run(dateKeyInDays(2), id);
  syncAllPantryExpiryReminders(db);

  const after = reminderFor(id);
  // STEHENLASSEN WAERE FALSCH GEWESEN, und das war der Fehler: die alte Zeile
  // meldete Wochen NACH dem neuen Ablauf. Sie ist nicht zufaellig anders, sie
  // ist nachweislich ueberholt.
  assert.notEqual(after.remind_at, before.remind_at);
  // Und trotzdem nie zurueckdatiert: die due-Abfrage kommt im selben Durchgang
  // direkt danach, ein verstrichener Termin ginge sofort raus.
  assert.ok(!reminderIsPast(after.remind_at));
  assert.match(after.remind_at, /T09:00$/);
  assert.ok(after.remind_at.slice(0, 10) <= dateKeyInDays(2), 'und nie nach dem Ablauf');
});

test('der Voll-Sync raeumt eine Zeile ab, deren Artikel inzwischen abgelaufen ist', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Bohnen', 1, 'can', 'Sonstiges', ?, ?)"
  ).run(dateKeyInDays(EXPIRY_SOON_DAYS + 60), A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1);

  db.prepare('UPDATE pantry_items SET expires_on = ? WHERE id = ?').run(dateKeyInDays(-3), id);
  syncAllPantryExpiryReminders(db);

  assert.equal(countReminders(id), 0,
    'eine Vorwarnung, die erst nach dem Ablauf kaeme, ist keine - sie gehoert weg');
});

// --------------------------------------------------------------------------
// RECHTE GELTEN AUCH FUER EINEN LAUF, DER KEINEN REQUEST HAT
//
// Der Router braucht die Pruefung nicht: wer den Vorrat nicht speichern darf,
// loest keinen Sync aus. Dieser Lauf umgeht den Pfad-Guard und muss sie selbst
// stellen - sonst bekommt ein Haushalt Push-Meldungen fuer ein Modul, das es
// dort nicht gibt.
// --------------------------------------------------------------------------
test('ein haushaltweit abgeschalteter Vorrat meldet nichts', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Kokosmilch', 1, 'can', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1);

  db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(['pantry']));
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0, 'ein abgeschaltetes Modul darf nicht per Push zurueckkommen');

  db.prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1, 'und beim Wiedereinschalten kommt sie zurueck');
});

test('einem Mitglied ohne Vorrats-Zugriff legt der Lauf nichts an', () => {
  const noAccess = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('gast','Gast','x','member','child')"
  ).run().lastInsertRowid;
  // `subject_id` ist TEXT, und loadSubjectRows() bindet `String(subjectId)`:
  // eine als Zahl geschriebene ID findet die Abfrage nicht (SQLite vergleicht
  // Typen). Genau so schreibt es replaceSubjectPermissions().
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'pantry', 'none')")
    .run(String(noAccess));

  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Reiswaffeln', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, noAccess).lastInsertRowid;

  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 0,
    'access_permissions ist die zweite Achse - eine Meldung ist eine Auskunft ueber einen Bestand');
});

test('ein Schreibvorgang ohne Terminwirkung laesst eine offene Meldung stehen', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Passata', 3, 'jar', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, A).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  const before = reminderFor(id);
  db.prepare("UPDATE reminders SET pushed_at = '2026-08-01T09:00:00Z' WHERE id = ?").run(before.id);

  // Der haeufigste Schreibweg dieses Moduls: ein Tap auf "einen weniger".
  db.prepare('UPDATE pantry_items SET quantity = 2 WHERE id = ?').run(id);
  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id));

  const after = reminderFor(id);
  assert.ok(after, 'bedingungsloses Ersetzen loeschte hier eine zugestellte, noch offene Meldung');
  assert.equal(after.id, before.id);
  assert.equal(after.pushed_at, '2026-08-01T09:00:00Z');
});

test('ein Rechteentzug raeumt die bestehende Meldung ab, nicht nur die kuenftige', () => {
  const user = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('entzug','Entzug','x','member','child')"
  ).run().lastInsertRowid;
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Couscous', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, user).lastInsertRowid;
  syncAllPantryExpiryReminders(db);
  assert.equal(countReminders(id), 1);

  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'pantry', 'none')")
    .run(String(user));
  syncAllPantryExpiryReminders(db);

  // Der Entzug filterte zuerst nur, was NEU entsteht - die bestehende Zeile
  // ueberlebte ihn und meldete weiter fuer ein Modul, das dieses Mitglied nicht
  // mehr oeffnen kann. Der haushaltweite Zweig raeumt ab; diese Achse muss
  // dasselbe tun, sonst verhalten sich zwei Formen derselben Sperre verschieden.
  assert.equal(countReminders(id), 0);
});

test('wer fuer ein anderes Mitglied speichert, legt ihm keine gesperrte Meldung an', () => {
  const user = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('fremd','Fremd','x','member','child')"
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'pantry', 'none')")
    .run(String(user));

  // Der Vorrat kennt kein Eigentuemer-Gate: jeder darf jede Zeile aendern.
  // created_by bleibt aber der urspruengliche Eintragende - und ihm gehoerte
  // die Erinnerung, an der Rechtepruefung des Voll-Syncs vorbei.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Bulgur', 1, 'pkg', 'Sonstiges', ?, ?)"
  ).run(FUTURE_EXPIRY, user).lastInsertRowid;

  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id));
  assert.equal(countReminders(id), 0, 'beide Ausloeser muessen dieselbe Rechtefrage stellen');
});

test('DELETE /reminders lehnt pantry_item ab - verwerfen ist der Weg, der haelt', async () => {
  const item = await call('POST', '/pantry', { body: { name: 'Zaatar', quantity: 1, expires_on: FUTURE_EXPIRY } });
  const id = item.body.data.id;
  assert.equal(countReminders(id), 1);

  const byFilter = await call('DELETE', `/reminders?entity_type=pantry_item&entity_id=${id}`);
  assert.equal(byFilter.status, 400);
  assert.equal(countReminders(id), 1);

  // Und die Hintertuer ueber die ID hat dieselbe folgenlose Wirkung.
  const byId = await call('DELETE', `/reminders/${reminderFor(id).id}`);
  assert.equal(byId.status, 400);
  assert.equal(countReminders(id), 1);

  // Verwerfen dagegen haelt: die Zeile bleibt stehen, der Voll-Sync sieht sie
  // und legt nichts nach.
  const dismissed = await call('PATCH', `/reminders/${reminderFor(id).id}/dismiss`);
  assert.equal(dismissed.status, 200);
  syncAllPantryExpiryReminders(db);
  assert.equal(reminderFor(id).dismissed, 1);
});

test('auch der Einkaufs-Import respektiert den Rechteentzug', async () => {
  const user = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('importer','Importer','x','member','child')"
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'pantry', 'none')")
    .run(String(user));

  const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Gesperrt', ?)").run(A).lastInsertRowid;
  const sid = db.prepare(
    "INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, 'Datteln', 'Sonstiges', 1)"
  ).run(listId).lastInsertRowid;

  const res = await call('POST', '/pantry/import-shopping', {
    as: { id: user },
    body: { list_id: listId, items: [{ shopping_item_id: sid, quantity: 1, expires_on: FUTURE_EXPIRY }] },
  });
  assert.equal(res.status, 200);

  // Das Set wird EINMAL fuer den ganzen Import aufgeloest und durchgereicht -
  // die Regel gilt trotzdem fuer jede Zeile.
  const row = db.prepare('SELECT id FROM pantry_items WHERE name = ?').get('Datteln');
  assert.equal(countReminders(row.id), 0);
});

// --------------------------------------------------------------------------
// DER RIEGEL MUSS AUCH FUER GEKLEMMTE TERMINE GREIFEN
//
// Der Guard "ein Schreibvorgang ohne Terminwirkung laesst eine offene Meldung
// stehen" benutzt FUTURE_EXPIRY - also den Fall, in dem gar nicht geklemmt
// wird. Er war gruen, waehrend genau die Ware, fuer die die Klemmung gebaut
// ist, bei JEDEM Stepper-Tap eine neue Zeile bekam.
// --------------------------------------------------------------------------
test('geklemmte Frischware bekommt bei jedem Tap NICHT eine neue Meldung', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Skyr Natur', quantity: 3, expires_on: dateKeyInDays(5) } });
  const id = res.body.data.id;
  const first = reminderFor(id);
  assert.ok(first, 'Frischware wird geklemmt, es muss eine Zeile geben');

  // Zugestellt und weggewischt - beides muss den Tap ueberleben.
  db.prepare("UPDATE reminders SET pushed_at = '2026-08-01T09:00:00Z', dismissed = 1 WHERE id = ?").run(first.id);

  for (const quantity of [2, 1]) {
    const tap = await call('PATCH', `/pantry/${id}`, { body: { quantity } });
    assert.equal(tap.status, 200);
  }

  const after = reminderFor(id);
  assert.equal(after.id, first.id, 'jeder Tap legte eine neue Zeile an - dieselbe Meldung jeden Morgen');
  assert.equal(after.remind_at, first.remind_at);
  assert.equal(after.pushed_at, '2026-08-01T09:00:00Z');
  assert.equal(after.dismissed, 1, 'ein zurueckgesetztes dismissed macht das Wegwischen wertlos');
  assert.equal(countReminders(id), 1);
});

test('ein vorgezogenes MHD holt auch eine geklemmte Meldung nach vorne', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Ricotta', quantity: 1, expires_on: dateKeyInDays(40) } });
  const id = res.body.data.id;
  const before = reminderFor(id);
  assert.equal(before.remind_at, `${dateKeyInDays(33)}T09:00`);

  // Falsch eingetragen, korrigiert: das Glas laeuft schon in vier Tagen ab.
  const fix = await call('PUT', `/pantry/${id}`, { body: { name: 'Ricotta', quantity: 1, expires_on: dateKeyInDays(4) } });
  assert.equal(fix.status, 200);

  const after = reminderFor(id);
  // Die alte Zeile meldete SPAETER als der Artikel ueberhaupt haelt - sie war
  // falsch, nicht bloss unveraendert. `<=` unterscheidet die beiden Faelle.
  assert.notEqual(after.remind_at, before.remind_at);
  assert.ok(!reminderIsPast(after.remind_at));
  assert.ok(after.remind_at <= `${dateKeyInDays(1)}T09:00`);
});

test('ein nachtraeglich abgelaufenes MHD raeumt die offene Meldung ab', async () => {
  const res = await call('POST', '/pantry', { body: { name: 'Mozzarella', quantity: 1, expires_on: dateKeyInDays(20) } });
  const id = res.body.data.id;
  assert.equal(countReminders(id), 1);

  await call('PUT', `/pantry/${id}`, { body: { name: 'Mozzarella', quantity: 1, expires_on: dateKeyInDays(-1) } });
  assert.equal(countReminders(id), 0,
    'eine Vorwarnung auf etwas, das die Frist gerissen hat, gehoert weg statt stehenzubleiben');
});

// --------------------------------------------------------------------------
// DER TAG, AN DEM ES ZAEHLT - mit FESTER Uhr geprueft
//
// `if (reminder) { ... }` machte diesen Test frueher leer, sobald die Zeile
// fehlte: er lief je nach Tageszeit in den einen oder anderen Zweig und konnte
// deshalb genau den Fehler nicht sehen, den er finden sollte. Beide Uhrzeiten
// stehen jetzt explizit da.
// --------------------------------------------------------------------------
test('vor 09:00 eingetragen meldet ein heute ablaufender Artikel noch heute', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Tagesware', 1, 'pcs', 'Sonstiges', ?, ?)"
  ).run('2026-08-26', A).lastInsertRowid;

  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id),
    new Date('2026-08-26T07:00:00Z'), null, { clampToNextMorning: true });

  assert.equal(reminderFor(id).remind_at, '2026-08-26T09:00');
});

test('nach 09:00 eingetragen meldet ein heute ablaufender Artikel gleich, nicht morgen', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Tagesware spaet', 1, 'pcs', 'Sonstiges', ?, ?)"
  ).run('2026-08-26', A).lastInsertRowid;

  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id),
    new Date('2026-08-26T11:00:00Z'), null, { clampToNextMorning: true });

  // Morgen waere einen Tag NACH dem Ablauf - das ist keine Vorwarnung. Also
  // faellt die Klemmung auf den heutigen Termin zurueck, obwohl er zurueckliegt:
  // die Meldung geht im naechsten Durchgang raus. Fuer die letzte Packung Milch
  // ist "gleich" besser als "gar nicht" - und westlich von UTC war "gar nicht"
  // vorher der Regelfall, weil 09:00 UTC dort mitten in der Nacht liegt.
  assert.equal(reminderFor(id).remind_at, '2026-08-26T09:00');
});

test('ein Tap nach 09:00 loescht die faellige Meldung eines heute ablaufenden Artikels NICHT', () => {
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Heute weg', 3, 'pcs', 'Sonstiges', ?, ?)"
  ).run('2026-08-26', A).lastInsertRowid;
  const load = () => db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id);

  syncPantryExpiryReminder(db, load(), new Date('2026-08-26T07:00:00Z'), null, { clampToNextMorning: true });
  assert.equal(reminderFor(id).remind_at, '2026-08-26T09:00');

  // DER GEMESSENE FEHLER: nach 09:00 klappt `nextMorning` auf morgen um, und
  // die Ablauffrage stand VOR der Frage nach der bestehenden Zeile. Ein ±-Tap
  // um 09:30 loeschte damit die faellige, noch nicht zugestellte Meldung -
  // /reminders/pending filtert nicht auf `pushed_at`, der Toast verschwand
  // ungesehen. Genau der "was muss heute weg"-Fall.
  db.prepare('UPDATE pantry_items SET quantity = 2 WHERE id = ?').run(id);
  syncPantryExpiryReminder(db, load(), new Date('2026-08-26T09:30:00Z'), null, { clampToNextMorning: true });

  assert.equal(reminderFor(id)?.remind_at, '2026-08-26T09:00');
});

test('der Voll-Sync schneidet nach Tagen, nicht nach der Uhrzeit', () => {
  // Vorwarntag = heute: der SQL-Grobschnitt laesst die Zeile durch, der
  // JS-Riegel warf sie ab 09:00 wieder weg, und am naechsten Tag siebte der
  // Grobschnitt sie aus. Ein Bestandsartikel, dessen Vorwarntag auf den Tag des
  // ersten Laufs fiel, bekam damit NIE eine Erinnerung.
  //
  // FESTE UHR, UND DER BEZUGSTAG KOMMT AUS DERSELBEN QUELLE WIE DER SERVICE:
  // `todayKey()` folgt der Haushaltszone, `dateKeyInDays()` rechnet in UTC. Wer
  // beides mischt, misst unter Pacific/Kiritimati einen anderen Tag als der
  // Code - der Test war dort rot, obwohl der Vergleich im Service genau richtig
  // ist.
  const at = new Date('2026-08-26T11:00:00Z');
  const household = householdToday(db, at);
  const expires = addDays(household, EXPIRY_SOON_DAYS);

  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Grenztag', 1, 'pcs', 'Sonstiges', ?, ?)"
  ).run(expires, A).lastInsertRowid;

  syncAllPantryExpiryReminders(db, at);

  assert.equal(countReminders(id), 1, 'sonst haengt die Erinnerung daran, ob der Lauf vor oder nach neun faellt');
  assert.equal(reminderFor(id).remind_at, `${household}T09:00`);
});

test('der Voll-Sync loescht die faellige Meldung eines heute ablaufenden Artikels nicht', () => {
  // DIESELBE REIHENFOLGE-FALLE wie im Router, nur im stale-Block: der Termin
  // steht auf heute 09:00, der Soll-Termin (MHD minus sieben Tage) liegt
  // zurueck, und `nextMorning` ist nach neun Uhr auf morgen umgeklappt. Wer
  // dann zuerst gegen `expires_on` prueft, wirft genau die Zeile weg, die
  // dieser Durchgang zustellen soll.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Stale heute', 1, 'pcs', 'Sonstiges', ?, ?)"
  ).run('2026-08-26', A).lastInsertRowid;
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', ?, '2026-08-26T09:00', ?)")
    .run(id, A);

  syncAllPantryExpiryReminders(db, new Date('2026-08-26T09:30:00Z'));

  assert.equal(reminderFor(id)?.remind_at, '2026-08-26T09:00',
    'die faellige Zeile darf der Lauf nicht abraeumen, bevor sie zugestellt ist');
});

test('eine offene Meldung eines LAENGST abgelaufenen Artikels geht nicht doch noch raus', () => {
  // Der stale-Block hatte die Ablauf-Frage nicht: eine nie zugestellte Meldung
  // eines vor drei Tagen abgelaufenen Artikels ueberlebte den Lauf, weil sie
  // "schon so frueh wie moeglich" stand - und ging im selben Durchgang raus.
  // Die Regel steht jetzt in der gemeinsamen Bedingung, wo beide Zweige sie
  // sehen.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Vergessen', 1, 'pcs', 'Sonstiges', '2026-08-23', ?)"
  ).run(A).lastInsertRowid;
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', ?, '2026-08-16T09:00', ?)")
    .run(id, A);

  syncAllPantryExpiryReminders(db, new Date('2026-08-26T10:00:00Z'));
  assert.equal(countReminders(id), 0);
});

test('der Grobschnitt misst denselben Tag wie der Riegel', () => {
  // ZWEI RASTER, EIN TAG. Der SQL-Grobschnitt band den UTC-Tag, der JS-Riegel
  // prueft gegen die Haushaltszone. Westlich von UTC fiel ein Artikel, dessen
  // Vorwarntag genau der heutige Haushaltstag ist, im einen Lauf am SQL-Schnitt
  // und im naechsten am JS-Riegel durch - nie eine Erinnerung.
  const at = new Date('2026-08-26T03:00:00Z');
  const household = householdToday(db, at);
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Rasterfall', 1, 'pcs', 'Sonstiges', ?, ?)"
  ).run(addDays(household, EXPIRY_SOON_DAYS), A).lastInsertRowid;

  syncAllPantryExpiryReminders(db, at);
  assert.equal(countReminders(id), 1);
  assert.equal(reminderFor(id).remind_at, `${household}T09:00`);
});

test('ein korrigiertes MHD raeumt auch eine geklemmte Meldung ab, die dahinter laege', () => {
  // GEMESSEN: Artikel am 28.08. um 10:00Z mit MHD 30.08. gespeichert -> Termin
  // auf 29.08.T09:00 geklemmt. MHD dann auf den 28.08. korrigiert: der
  // Kurzschluss "bestehende Zeile ist frueh genug" sprang ueber die
  // Ablauf-Frage hinweg, die Zeile blieb auf dem 29. - einen Tag NACH dem MHD.
  // Dass daraus keine Meldung wurde, lag allein am DELETE des Voll-Syncs.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Korrektur', 1, 'pcs', 'Sonstiges', '2026-08-30', ?)"
  ).run(A).lastInsertRowid;
  const load = () => db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id);

  syncPantryExpiryReminder(db, load(), new Date('2026-08-28T10:00:00Z'), null, { clampToNextMorning: true });
  assert.equal(reminderFor(id).remind_at, '2026-08-29T09:00');

  db.prepare("UPDATE pantry_items SET expires_on = '2026-08-28' WHERE id = ?").run(id);
  syncPantryExpiryReminder(db, load(), new Date('2026-08-28T11:00:00Z'), null, { clampToNextMorning: true });

  // Die Zeile bleibt nicht hinter dem Ablauf stehen - sie wird auf den letzten
  // Tag gezogen, an dem die Meldung noch etwas taugt. Dass daraus vorher keine
  // Meldung nach dem Ablauf wurde, lag allein am DELETE des Voll-Syncs; eine
  // Zusicherung, die eine Funktion ausspricht und eine andere einhaelt, ist keine.
  assert.equal(reminderFor(id).remind_at, '2026-08-28T09:00');
});

test('dasselbe im Voll-Sync: eine Zeile hinter dem Ablauf bleibt nicht stehen', () => {
  // DER FALL MUSS GENAU DAZWISCHEN LIEGEN: die Zeile ist nicht spaeter als der
  // fruehestmoegliche Termin (der Kurzschluss greift also), aber SPAETER als
  // das MHD. Eine Zeile weiter hinten liefe ohnehin in die Terminkorrektur -
  // deshalb war die erste Fassung dieses Tests gruen, egal wie der Code lief.
  //
  // Artikel laeuft HEUTE ab, Meldung steht auf morgen, und morgen 09:00 ist
  // wegen der Uhrzeit auch der fruehestmoegliche Termin.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Korrektur Lauf', 1, 'pcs', 'Sonstiges', '2026-08-28', ?)"
  ).run(A).lastInsertRowid;
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', ?, '2026-08-29T09:00', ?)")
    .run(id, A);

  syncAllPantryExpiryReminders(db, new Date('2026-08-28T11:00:00Z'));

  const after = reminderFor(id);
  assert.ok(!after || after.remind_at.slice(0, 10) <= '2026-08-28',
    'eine Meldung nach dem Ablaufdatum ist keine Meldung');
});

test('ohne Vorratsartikel mit Datum fragt der Lauf keine Rechte ab', () => {
  const fresh = new (db.constructor)(':memory:');
  fresh.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, family_role TEXT);
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE access_permissions (subject_type TEXT, subject_id TEXT, resource_type TEXT, resource_key TEXT, access TEXT);
    CREATE TABLE pantry_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, quantity REAL DEFAULT 1, expires_on TEXT, created_by INTEGER);
    CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id INTEGER, remind_at TEXT, dismissed INTEGER DEFAULT 0, pushed_at TEXT, created_by INTEGER);
    INSERT INTO users (role) VALUES ('member'), ('member'), ('member'), ('member'), ('member');
    INSERT INTO pantry_items (name, quantity) VALUES ('Salz', 1), ('Reis', 2);
  `);

  let permissionQueries = 0;
  const orig = fresh.prepare.bind(fresh);
  fresh.prepare = (sql) => { if (String(sql).includes('access_permissions')) permissionQueries += 1; return orig(sql); };

  syncAllPantryExpiryReminders(fresh, new Date('2026-08-26T10:00:00Z'));

  // Zwei Abfragen je Mitglied, einmal je Minute, fuer einen Vorrat ohne ein
  // einziges Mindesthaltbarkeitsdatum - rund 16.000 Statements am Tag.
  assert.equal(permissionQueries, 0);
  fresh.close();
});

test('eine geklemmte Zeile laeuft nicht in jedem Durchgang durch die Terminkorrektur', () => {
  // GEMESSEN: der remind_at einer geklemmten Zeile kann dem gerechneten Vorlauf
  // NIE entsprechen - die SQL-Bedingung traf sie damit minuetlich, bis zur
  // Zustellung. Genau die Leerarbeit, gegen die der Kommentar daneben den
  // SQL-Schnitt begruendet, und ausgerechnet fuer Frischware.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Geklemmt', 1, 'pcs', 'Sonstiges', '2026-08-29', ?)"
  ).run(A).lastInsertRowid;
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', ?, '2026-08-27T09:00', ?)")
    .run(id, A);

  const at = new Date('2026-08-26T11:00:00Z');
  const staleCount = () => db.prepare(`
    SELECT COUNT(*) AS c
    FROM reminders r JOIN pantry_items p ON p.id = r.entity_id
    WHERE r.entity_type = 'pantry_item' AND r.pushed_at IS NULL AND r.dismissed = 0
      AND (
        (date(p.expires_on, '-7 days') >= ? AND date(p.expires_on, '-7 days') || 'T09:00' <> r.remind_at)
        OR substr(r.remind_at, 1, 10) > p.expires_on
      )
  `).get(householdToday(db, at)).c;

  syncAllPantryExpiryReminders(db, at);
  assert.equal(staleCount(), 0, 'die geklemmte Zeile darf nach dem Lauf nicht wieder Kandidat sein');
  assert.equal(reminderFor(id).remind_at, '2026-08-27T09:00', 'und unveraendert bleiben');
});

test('ein Artikel mit verwaistem created_by qualifiziert gar nicht erst', () => {
  // Ohne `created_by IN (SELECT id FROM users)` beantwortete
  // creatorLacksPantry() dieselbe Frage je nach Weg verschieden: mit
  // denied-Set galt eine unbekannte ID als berechtigt, ohne Set als gesperrt -
  // und der Voll-Sync brach dann am Fremdschluessel ab, inklusive der
  // Terminkorrektur darunter.
  //
  // Der Fremdschluessel verhindert die Zeile im Normalbetrieb - erzeugbar ist
  // sie nur mit abgeschalteten Fremdschluesseln, also genau in der Lage, in der
  // eine Migration oder ein Restore laeuft (`foreignKeysOff`). Deshalb wird sie
  // hier auch so erzeugt und nicht per Umweg.
  db.exec('PRAGMA foreign_keys = OFF');
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Waise', 1, 'pcs', 'Sonstiges', ?, 999999)"
  ).run(FUTURE_EXPIRY).lastInsertRowid;
  db.exec('PRAGMA foreign_keys = ON');

  assert.doesNotThrow(() => syncAllPantryExpiryReminders(db));
  assert.equal(countReminders(id), 0);

  db.prepare('DELETE FROM pantry_items WHERE id = ?').run(id);
});

// --------------------------------------------------------------------------
// DIE ZONE, DIE DIE SUITE SONST FESTNAGELT
//
// Oben steht `household_timezone = UTC`, damit die festen Zeitpunkte stabil
// sind. Genau deshalb koennte diese Suite den Befund, der die Klemmung von der
// UTC-Wanduhr auf Kalendertage gebracht hat, nicht mehr sehen. Dieser Test
// verschiebt die Zone bewusst und stellt sie danach zurueck.
// --------------------------------------------------------------------------
test('westlich von UTC bekommt ein heute ablaufender Artikel morgens eine Meldung', () => {
  const setZone = (zone) => db.prepare(
    "INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(zone);

  setZone('America/Los_Angeles');
  try {
    // 08:00 Ortszeit in Los Angeles.
    const at = new Date('2026-08-25T15:00:00Z');
    const today = householdToday(db, at);
    assert.equal(today, '2026-08-25', 'Bezugstag der Haushaltszone');

    const id = db.prepare(
      "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Milch LA', 1, 'l', 'Sonstiges', ?, ?)"
    ).run(today, A).lastInsertRowid;

    syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id),
      at, null, { clampToNextMorning: true });

    // GEMESSEN VOR DEM FIX: gar keine Erinnerung. Die Klemmung rechnete den
    // "naechsten Morgen" ueber setUTCHours(9) aus - in LA ist das 02:00 nachts,
    // also um 08:00 Ortszeit laengst vorbei -, sprang auf morgen und damit
    // hinter das MHD. Unter UTC war derselbe Fall korrekt. Genau der "was muss
    // heute weg"-Fall, fuer den die Klemmung gebaut ist.
    assert.equal(reminderFor(id)?.remind_at, '2026-08-25T09:00');
  } finally {
    setZone('UTC');
  }
});

test('ohne Handlung raeumt ein verstrichener Vorlauf eine bestehende Zeile ab', () => {
  // Der Voll-Sync reicht solche Artikel heute nicht herein (die missing-Abfrage
  // schliesst Zeilen mit Erinnerung aus). Ein `return` ohne Abraeumen waere
  // trotzdem eine Falle fuer den naechsten, der die Funktion anders aufruft:
  // die Zeile bliebe auf einem Termin stehen, den niemand mehr fuer richtig
  // haelt.
  const id = db.prepare(
    "INSERT INTO pantry_items (name, quantity, unit, category, expires_on, created_by) VALUES ('Direktaufruf', 1, 'pcs', 'Sonstiges', '2026-08-29', ?)"
  ).run(A).lastInsertRowid;
  db.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('pantry_item', ?, '2026-08-27T09:00', ?)")
    .run(id, A);

  // MHD 29.08. -> Vorlauf 22.08., am 26.08. also verstrichen. Ohne
  // clampToNextMorning gibt es keinen Ersatztermin.
  syncPantryExpiryReminder(db, db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id),
    new Date('2026-08-26T11:00:00Z'));

  assert.equal(countReminders(id), 0);
});
