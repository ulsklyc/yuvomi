/**
 * Test: Inventar-Service-Log und Verlaufs-Ansicht
 * Zweck: End-to-End ueber den echten Items-Router.
 *          - "Erledigt" mit Intervall rollt das Datum vor (Monats-Klemmung
 *            ueber den geteilten Helfer) und die Erinnerung zieht mit um,
 *            OHNE die id der getrackten Frist zu aendern (ICS-UID-Stabilitaet)
 *          - "Erledigt" ohne Intervall schreibt die Historie und raeumt die
 *            Frist (samt Erinnerung) ab
 *          - eine neue Erinnerung, deren Termin schon in der Vergangenheit
 *            liegt, wird nicht angelegt
 *          - die Historie uebersteht ein nachfolgendes Item-Speichern, auch
 *            wenn item_date_id dabei auf NULL faellt (voller Replace)
 *          - die Verlaufs-Ansicht versteckt eine Buchung/ein Dokument, das
 *            die betrachtende Person nicht sehen darf (beide Budget-Modi,
 *            kein Admin-Bypass)
 *          - ein Distanz-Intervall erzeugt keine zusaetzliche Erinnerung
 *          - ein rueckdatierter Kilometerstand auf einer Log-Zeile rollt
 *            inventory_items.odometer nicht zurueck
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-service-log.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const deadlinesIcs = await import('../server/services/inventory-deadlines-ics.js');
const db = dbmod.get();

const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;
const B = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')").run().lastInsertRowid;
const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;

function setBudgetMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}
setBudgetMode('shared');

let actor = { id: A };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = actor.id; req.session = { userId: actor.id }; next(); });
app.use('/items', itemsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());
test.afterEach(() => setBudgetMode('shared'));

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

function trackedDateReminders(trackedDateId) {
  return db.prepare("SELECT * FROM reminders WHERE entity_type = 'inventory_tracked_date' AND entity_id = ?").all(trackedDateId);
}

function insertEntry(fields = {}) {
  const f = {
    title: 'x', amount: -50, category: 'food', date: '2030-01-10',
    is_recurring: 0, recurrence_rule: null, recurrence_parent_id: null,
    is_pending: 0, created_by: A, owner_id: A, visibility: 'shared', ...fields,
  };
  return db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, date, is_recurring, recurrence_rule, recurrence_parent_id,
       is_pending, created_by, owner_id, visibility)
    VALUES (@title,@amount,@category,@date,@is_recurring,@recurrence_rule,@recurrence_parent_id,
       @is_pending,@created_by,@owner_id,@visibility)
  `).run(f).lastInsertRowid;
}

function insertDocument(fields = {}) {
  const f = {
    name: 'Beleg', original_name: 'beleg.pdf', mime_type: 'application/pdf', file_size: 1,
    category: 'other', visibility: 'family', status: 'active', created_by: A, ...fields,
  };
  return db.prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES (@name, @original_name, @mime_type, @file_size, ?, @category, @visibility, @status, @created_by)
  `).run(Buffer.from('x'), f).lastInsertRowid;
}

const FUTURE_DATE = '2099-06-01';

// --------------------------------------------------------
// Rollen-Intervall (Monate)
// --------------------------------------------------------

test('POST .../dates/:dateId/complete mit interval_months rollt das Datum vor (Monats-Klemmung) und die Erinnerung zieht mit - gleiche id', async () => {
  const created = await call('POST', '/items', {
    body: {
      name: 'Auto', category: 'vehicles',
      tracked_dates: [{ label: 'HU/TÜV', date: '2027-01-31', reminder_offset_days: 30, interval_months: 1 }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dateId = created.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(dateId).length, 1);
  const firstRemindAt = trackedDateReminders(dateId)[0].remind_at;

  const completed = await call('POST', `/items/${created.body.data.id}/dates/${dateId}/complete`, {
    body: { performed_on: '2027-01-30', odometer: 42000, vendor: 'Werkstatt Meier', note: 'alles ok' },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));

  const rolled = completed.body.data.tracked_dates.find((d) => d.id === dateId);
  assert.ok(rolled, 'die Frist behaelt ihre id (ICS-UID-Stabilitaet)');
  // 31. Januar + 1 Monat -> 28. Februar (2027 ist kein Schaltjahr) - Klemmung
  // ueber den geteilten Helfer server/utils/interval-date.js#addMonthsClamped.
  assert.equal(rolled.date, '2027-02-28');

  const reminders = trackedDateReminders(dateId);
  assert.equal(reminders.length, 1, 'genau eine Erinnerung, nicht zwei');
  assert.notEqual(reminders[0].remind_at, firstRemindAt, 'die Erinnerung muss mit umziehen');
  assert.equal(reminders[0].remind_at, '2027-01-29T09:00', '30 Tage vor dem neuen Datum');

  const logRows = db.prepare('SELECT * FROM inventory_item_service_log WHERE item_id = ?').all(created.body.data.id);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].item_date_id, dateId);
  assert.equal(logRows[0].label, 'HU/TÜV');
  assert.equal(logRows[0].performed_on, '2027-01-30');
  assert.equal(logRows[0].vendor, 'Werkstatt Meier');
});

test('29. Februar (Schaltjahr) + 1 Monat -> 28. Februar im Folgejahr (kein Schaltjahr)', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Heizung', tracked_dates: [{ label: 'Wartung', date: '2028-01-29', interval_months: 1 }] },
  });
  const dateId = created.body.data.tracked_dates[0].id;
  const completed = await call('POST', `/items/${created.body.data.id}/dates/${dateId}/complete`, {
    body: { performed_on: '2028-01-29' },
  });
  assert.equal(completed.status, 201);
  const rolled = completed.body.data.tracked_dates.find((d) => d.id === dateId);
  assert.equal(rolled.date, '2028-02-29', '2028 ist ein Schaltjahr');
});

// --------------------------------------------------------
// Ohne Intervall: Frist wird abgeraeumt, Historie bleibt
// --------------------------------------------------------

test('"Erledigt" ohne interval_months schreibt die Historie und raeumt die Frist samt Erinnerung ab', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Feuerloescher', tracked_dates: [{ label: 'Pruefung', date: FUTURE_DATE }] },
  });
  const dateId = created.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(dateId).length, 1);

  const completed = await call('POST', `/items/${created.body.data.id}/dates/${dateId}/complete`, {
    body: { performed_on: '2026-09-16', note: 'neu plombiert' },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  assert.deepEqual(completed.body.data.tracked_dates, [], 'die Einmal-Frist ist weg');
  assert.equal(trackedDateReminders(dateId).length, 0);

  const logRows = db.prepare('SELECT * FROM inventory_item_service_log WHERE item_id = ?').all(created.body.data.id);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].label, 'Pruefung');
  assert.equal(logRows[0].performed_on, '2026-09-16');
  assert.equal(logRows[0].note, 'neu plombiert');
});

// --------------------------------------------------------
// Kein Nachtrags-Nagging
// --------------------------------------------------------

test('eine neue Erinnerung, deren Termin schon vergangen ist, wird nicht angelegt', async () => {
  const created = await call('POST', '/items', {
    body: {
      name: 'Altgeraet',
      tracked_dates: [{ label: 'Wartung', date: '2000-01-15', reminder_offset_days: 0, interval_months: 1 }],
    },
  });
  const dateId = created.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(dateId).length, 0, 'das Ausgangsdatum liegt schon in der Vergangenheit');

  const completed = await call('POST', `/items/${created.body.data.id}/dates/${dateId}/complete`, {
    body: { performed_on: '2000-01-15' },
  });
  assert.equal(completed.status, 201);
  const rolled = completed.body.data.tracked_dates.find((d) => d.id === dateId);
  assert.equal(rolled.date, '2000-02-15');
  assert.equal(trackedDateReminders(dateId).length, 0, 'auch das vorgerollte Datum liegt in der Vergangenheit');
});

test('eine mehrere Intervalle ueberfaellige Frist rollt weit genug vor, nicht nur um ein Intervall', async () => {
  // Faelligkeit 2000-01-15, monatliches Intervall, aber erst am 2000-04-20
  // erledigt (mehr als drei Intervalle spaeter). Ein einzelnes Vorrollen
  // (addMonthsClamped von der Faelligkeit statt vom Erledigungsdatum) laege
  // bei 2000-02-15 und damit erneut in der Vergangenheit - die Zeile bliebe
  // ueberfaellig, obwohl "Erledigt" gerade geklickt wurde.
  const created = await call('POST', '/items', {
    body: {
      name: 'Lang ueberfaellig',
      tracked_dates: [{ label: 'Wartung', date: '2000-01-15', reminder_offset_days: 0, interval_months: 1 }],
    },
  });
  const dateId = created.body.data.tracked_dates[0].id;

  const completed = await call('POST', `/items/${created.body.data.id}/dates/${dateId}/complete`, {
    body: { performed_on: '2000-04-20' },
  });
  assert.equal(completed.status, 201);
  const rolled = completed.body.data.tracked_dates.find((d) => d.id === dateId);
  // 01-15 -> 02-15 -> 03-15 -> 04-15 -> 05-15: die erste Monatsmarke NACH
  // dem Erledigungsdatum (04-20), nicht die naechste nach der Faelligkeit.
  assert.equal(rolled.date, '2000-05-15', 'rollt so oft vor, bis das Ergebnis nach dem Erledigungsdatum liegt');
});

// --------------------------------------------------------
// Die Historie uebersteht ein nachfolgendes Item-Speichern
// --------------------------------------------------------

test('die Historie liest sich korrekt weiter, nachdem ein Item-Speichern item_date_id auf NULL setzt', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Kessel', tracked_dates: [{ label: 'Wartung', date: FUTURE_DATE, interval_months: 6 }] },
  });
  const itemId = created.body.data.id;
  const dateId = created.body.data.tracked_dates[0].id;

  const completed = await call('POST', `/items/${itemId}/dates/${dateId}/complete`, {
    body: { performed_on: '2026-09-16', vendor: 'Heizungsbauer Schmidt' },
  });
  assert.equal(completed.status, 201);
  const logRow = db.prepare('SELECT * FROM inventory_item_service_log WHERE item_id = ?').get(itemId);
  assert.equal(logRow.item_date_id, dateId);

  // Ein voller Item-Speichervorgang (PUT mit tracked_dates) ist ein Replace:
  // die geraden erst vorgerollte Frist bekommt eine NEUE id, die alte
  // verschwindet - item_date_id der Log-Zeile faellt per ON DELETE SET NULL
  // auf NULL (die Gefahr, die diese Test-Datei absichern soll).
  await call('PUT', `/items/${itemId}`, {
    body: { name: 'Kessel', tracked_dates: [{ label: 'Andere Frist', date: FUTURE_DATE }] },
  });
  const logRowAfter = db.prepare('SELECT * FROM inventory_item_service_log WHERE item_id = ?').get(itemId);
  assert.equal(logRowAfter.item_date_id, null, 'item_date_id faellt auf NULL');

  const history = await call('GET', `/items/${itemId}/history`);
  assert.equal(history.status, 200);
  const entry = history.body.data.timeline.find((e) => e.type === 'service_log');
  assert.ok(entry, 'die Historie liest sich weiter, OHNE ueber item_date_id zu joinen');
  assert.equal(entry.date, '2026-09-16');
  assert.equal(entry.label, 'Wartung', 'Momentaufnahme aus der Log-Zeile, nicht aus der (verschwundenen) Frist');
  assert.equal(entry.vendor, 'Heizungsbauer Schmidt');
});

// --------------------------------------------------------
// Verlaufs-Ansicht: beide Sichtbarkeitsfilter, kein Admin-Bypass
// --------------------------------------------------------

test('die Verlaufs-Ansicht versteckt eine private Buchung im personal-Modus, auch fuer einen Admin (kein Bypass)', async () => {
  setBudgetMode('personal');
  const item = (await call('POST', '/items', { body: { name: 'Rasenmaeher' } })).body.data;
  const privateEntry = insertEntry({ title: 'Privatreparatur', owner_id: B, visibility: 'private' });
  db.prepare(`
    INSERT INTO inventory_item_entries (item_id, entry_id, role, created_by) VALUES (?, ?, 'maintenance', ?)
  `).run(item.id, privateEntry, B);

  const asAdmin = await call('GET', `/items/${item.id}/history`, { as: { id: ADMIN } });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.body.data.timeline.filter((e) => e.type === 'budget_entry').length, 0, 'kein Admin-Bypass');
  assert.equal(asAdmin.body.data.total, 0);

  const asOwner = await call('GET', `/items/${item.id}/history`, { as: { id: B } });
  assert.equal(asOwner.body.data.timeline.filter((e) => e.type === 'budget_entry').length, 1);
  assert.equal(asOwner.body.data.total, -50);
});

test('die Verlaufs-Ansicht zeigt eine geteilte Buchung allen, im shared-Modus auch ohne owner-Match', async () => {
  const item = (await call('POST', '/items', { body: { name: 'Kuehlschrank' } })).body.data;
  const entry = insertEntry({ title: 'Reparatur', owner_id: B, visibility: 'shared', amount: -120 });
  db.prepare(`
    INSERT INTO inventory_item_entries (item_id, entry_id, role, created_by) VALUES (?, ?, 'maintenance', ?)
  `).run(item.id, entry, B);

  const asA = await call('GET', `/items/${item.id}/history`, { as: { id: A } });
  assert.equal(asA.body.data.timeline.filter((e) => e.type === 'budget_entry').length, 1);
  assert.equal(asA.body.data.total, -120);
});

test('die Verlaufs-Ansicht versteckt ein privates Dokument, das die betrachtende Person nicht sehen darf', async () => {
  const item = (await call('POST', '/items', { body: { name: 'Kamera' } })).body.data;
  const doc = insertDocument({ name: 'Rechnung', visibility: 'private', created_by: B });
  db.prepare('INSERT INTO inventory_item_documents (item_id, document_id, created_by) VALUES (?, ?, ?)').run(item.id, doc, B);

  const asA = await call('GET', `/items/${item.id}/history`, { as: { id: A } });
  assert.equal(asA.body.data.timeline.filter((e) => e.type === 'document').length, 0);

  const asB = await call('GET', `/items/${item.id}/history`, { as: { id: B } });
  assert.equal(asB.body.data.timeline.filter((e) => e.type === 'document').length, 1);
});

// --------------------------------------------------------
// Distanz-Intervall: nie eine Erinnerung/VEVENT
// --------------------------------------------------------

test('ein Distanz-Intervall erzeugt keine zusaetzliche Erinnerung und kein zusaetzliches VEVENT', async () => {
  const withoutDistance = await call('POST', '/items', {
    body: { name: 'Auto ohne Distanz', category: 'vehicles', tracked_dates: [{ label: 'Service', date: FUTURE_DATE }] },
  });
  const withDistance = await call('POST', '/items', {
    body: {
      name: 'Auto mit Distanz', category: 'vehicles',
      tracked_dates: [{ label: 'Service', date: FUTURE_DATE, interval_distance: 15000 }],
    },
  });
  assert.equal(withDistance.status, 201, JSON.stringify(withDistance.body));

  const idNoDistance = withoutDistance.body.data.tracked_dates[0].id;
  const idWithDistance = withDistance.body.data.tracked_dates[0].id;
  assert.equal(trackedDateReminders(idNoDistance).length, 1);
  assert.equal(trackedDateReminders(idWithDistance).length, 1, 'genau eine Erinnerung wie ohne Distanz-Intervall - keine zweite fuers Distanz-Feld');

  const ics = deadlinesIcs.buildInventoryDeadlinesFeed(db);
  const veventsForDistanceItem = (ics.match(/UID:inventory-tracked-date-\d+@yuvomi/g) || [])
    .filter((uid) => uid === `UID:inventory-tracked-date-${idWithDistance}@yuvomi`);
  assert.equal(veventsForDistanceItem.length, 1, 'genau ein VEVENT fuer die Frist, kein zweites fuer die Distanz');
});

// --------------------------------------------------------
// Odometer: ein rueckdatierter Log-Eintrag rollt ihn nicht zurueck
// --------------------------------------------------------

test('ein rueckdatierter Service-Log-Kilometerstand rollt inventory_items.odometer nicht zurueck', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Auto', category: 'vehicles', odometer: 50000, odometer_unit: 'km', odometer_on: '2026-09-01' },
  });
  const itemId = created.body.data.id;
  assert.equal(created.body.data.odometer, 50000);

  // Aeltere Ablesung nachgetragen (z. B. ein Werkstattbeleg von vor Wochen) -
  // darf den AKTUELLEN Kilometerstand nicht zuruecksetzen.
  const backdated = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Oelwechsel', performed_on: '2026-08-01', odometer: 45000 },
  });
  assert.equal(backdated.status, 201, JSON.stringify(backdated.body));

  const afterBackdated = await call('GET', `/items/${itemId}`);
  assert.equal(afterBackdated.body.data.odometer, 50000, 'die rueckdatierte Ablesung darf nicht zurueckrollen');
  assert.equal(afterBackdated.body.data.odometer_on, '2026-09-01');

  // Eine NEUERE Ablesung darf durchaus fortschreiben.
  const newer = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Reifenwechsel', performed_on: '2026-09-10', odometer: 51200 },
  });
  assert.equal(newer.status, 201);
  const afterNewer = await call('GET', `/items/${itemId}`);
  assert.equal(afterNewer.body.data.odometer, 51200);
  assert.equal(afterNewer.body.data.odometer_on, '2026-09-10');
});

test('ein NIEDRIGERER Kilometerstand an einem neueren Datum wird abgelehnt (Tippfehler-Schutz, Review #1257)', async () => {
  // Nur das Datum zu pruefen reicht nicht: "5120" statt "51200" getippt an
  // einem spaeteren Datum wuerde sonst den aktuellen Stand des Gegenstands
  // stillschweigend zuruecksetzen (und odometerChartPoints() zeichnete den
  // Rueckgang als echten Trend). Ein Fahrzeug faehrt nicht rueckwaerts.
  const created = await call('POST', '/items', {
    body: { name: 'Auto2', category: 'vehicles', odometer: 51200, odometer_unit: 'km', odometer_on: '2026-09-10' },
  });
  const itemId = created.body.data.id;

  const typo = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Inspektion', performed_on: '2026-10-01', odometer: 5120 },
  });
  assert.equal(typo.status, 400, JSON.stringify(typo.body));

  const afterTypo = await call('GET', `/items/${itemId}`);
  assert.equal(afterTypo.body.data.odometer, 51200, 'der Tippfehler darf den Gegenstand nicht zuruecksetzen');

  // Dieselbe Pruefung gilt fuer die "Erledigt"-Aktion einer getrackten Frist.
  const withDate = await call('PUT', `/items/${itemId}`, {
    body: {
      name: 'Auto2', category: 'vehicles', odometer: 51200, odometer_unit: 'km', odometer_on: '2026-09-10',
      tracked_dates: [{ label: 'TUEV', date: '2026-11-01', reminder_offset_days: 0 }],
    },
  });
  const dateId = withDate.body.data.tracked_dates[0].id;
  const completedTypo = await call('POST', `/items/${itemId}/dates/${dateId}/complete`, {
    body: { performed_on: '2026-11-01', odometer: 5120 },
  });
  assert.equal(completedTypo.status, 400, JSON.stringify(completedTypo.body));
});

test('das Loeschen der Log-Zeile, die den aktuellen Kilometerstand gesetzt hat, rechnet ihn aus den verbleibenden Zeilen neu', async () => {
  const created = await call('POST', '/items', {
    body: { name: 'Auto3', category: 'vehicles' },
  });
  const itemId = created.body.data.id;

  const first = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Erste Wartung', performed_on: '2026-01-01', odometer: 10000 },
  });
  const second = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Zweite Wartung', performed_on: '2026-06-01', odometer: 20000 },
  });
  assert.equal((await call('GET', `/items/${itemId}`)).body.data.odometer, 20000);

  // Die NEUESTE Log-Zeile loeschen: der Gegenstand muss auf die verbleibende
  // (aeltere) Ablesung zurueckfallen, nicht auf dem geloeschten Stand stehen
  // bleiben - das fehlende Gegenstueck zu maybeAdvanceItemOdometer.
  const del = await call('DELETE', `/items/${itemId}/service-log/${second.body.data.id}`);
  assert.equal(del.status, 204);
  const afterDelete = await call('GET', `/items/${itemId}`);
  assert.equal(afterDelete.body.data.odometer, 10000);
  assert.equal(afterDelete.body.data.odometer_on, '2026-01-01');

  // Auch die letzte verbleibende Zeile loeschen: kein Log-Eintrag mehr traegt
  // eine Ablesung, der Gegenstand faellt auf NULL zurueck.
  await call('DELETE', `/items/${itemId}/service-log/${first.body.data.id}`);
  const afterAllDeleted = await call('GET', `/items/${itemId}`);
  assert.equal(afterAllDeleted.body.data.odometer, null);
  assert.equal(afterAllDeleted.body.data.odometer_on, null);
});

test('das Loeschen einer Log-Zeile, die NIE den aktuellen Kilometerstand gesetzt hat, laesst das Item unangetastet (Review #1257)', async () => {
  // Ein im Formular gesetzter Stand ist durch keine Log-Zeile gedeckt - das
  // Loeschen einer UNBETEILIGTEN (rueckdatierten) Log-Zeile darf ihn trotzdem
  // nicht mitreissen, nur weil recomputeItemOdometer() bislang jede Loeschung
  // pauschal neu berechnet hat.
  const created = await call('POST', '/items', {
    body: { name: 'Auto4', category: 'vehicles', odometer: 50000, odometer_unit: 'km', odometer_on: '2026-09-01' },
  });
  const itemId = created.body.data.id;

  const backdated = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Oelwechsel', performed_on: '2026-08-01', odometer: 45000 },
  });
  assert.equal(backdated.status, 201);
  // Die rueckdatierte Zeile hat den zwischengespeicherten Stand nie gesetzt.
  assert.equal((await call('GET', `/items/${itemId}`)).body.data.odometer, 50000);

  const del = await call('DELETE', `/items/${itemId}/service-log/${backdated.body.data.id}`);
  assert.equal(del.status, 204);

  const after = await call('GET', `/items/${itemId}`);
  assert.equal(after.body.data.odometer, 50000, 'der unabhaengig gesetzte Stand bleibt unangetastet');
  assert.equal(after.body.data.odometer_on, '2026-09-01');
});

test('a reading without a date still arms the typo guard (Review #1257)', async () => {
  const created = await call('POST', '/items', { body: { name: 'Auto5', category: 'vehicles', odometer: 51200 } });
  const { id, odometer_on: readOn } = created.body.data;
  assert.ok(readOn, 'a reading without a date gets one');
  const typo = await call('POST', `/items/${id}/service-log`, { body: { label: 'Inspektion', performed_on: readOn, odometer: 5120 } });
  assert.equal(typo.status, 400);
  assert.equal((await call('GET', `/items/${id}`)).body.data.odometer, 51200);
});

test('PUT einer Log-Zeile prueft den Tippfehler-Schutz nicht gegen ihren eigenen alten Wert (Review #1257)', async () => {
  const created = await call('POST', '/items', { body: { name: 'Auto6', category: 'vehicles' } });
  const itemId = created.body.data.id;

  const logged = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Inspektion', performed_on: '2026-09-10', odometer: 520000 },
  });
  assert.equal(logged.status, 201);
  assert.equal((await call('GET', `/items/${itemId}`)).body.data.odometer, 520000);

  // Denselben Tippfehler an der Zeile selbst richtigstellen - die Zeile
  // konkurriert nicht gegen ihren eigenen alten (falschen) Wert.
  const fixed = await call('PUT', `/items/${itemId}/service-log/${logged.body.data.id}`, {
    body: { label: 'Inspektion', performed_on: '2026-09-10', odometer: 52000 },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal((await call('GET', `/items/${itemId}`)).body.data.odometer, 52000);
});

test('ein Kilometerstand auf einer Log-Zeile setzt inventory_items.odometer nur bei odometer-tragender Kategorie (Review #1257)', async () => {
  const created = await call('POST', '/items', { body: { name: 'Sonstiges Ding', category: 'other' } });
  const itemId = created.body.data.id;

  const logged = await call('POST', `/items/${itemId}/service-log`, {
    body: { label: 'Reparatur', performed_on: '2026-09-10', odometer: 777 },
  });
  assert.equal(logged.status, 201);
  assert.equal((await call('GET', `/items/${itemId}`)).body.data.odometer, null,
    'eine Kategorie ohne tracks_odometer darf inventory_items.odometer nicht setzen');
});
