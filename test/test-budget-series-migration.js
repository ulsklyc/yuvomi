/**
 * Test: Serien-Definition als eigene Tabelle (Migration v228, #1035)
 * Zweck: Bis v227 war die erste Zeile einer Budget-Serie zweierlei - Vorlage
 *        fuer jedes kuenftige Vorkommen UND die erste, von Hand erfasste
 *        Buchung. v228 legt die Vorlage in `budget_series` (plus
 *        `budget_series_responsibles`) ab und fuellt sie aus dem Bestand.
 *        Geprueft wird an einer Datenbank, die die ECHTE Migrationskette bis
 *        v227 gefahren hat:
 *          - jede laufende Serie bekommt genau eine Definition mit den Werten,
 *            die bisher am Original standen - dieselben Vorkommen wie vorher;
 *          - keine Buchung aendert sich (Vorher/Nachher ueber alle Zeilen);
 *          - beendete Serien, Instanzen und Einzelbuchungen bekommen keine;
 *          - Zustaendige wandern mit, die des Originals bleiben stehen;
 *          - ein zweiter Lauf ueberschreibt nichts, auch keine inzwischen
 *            abweichende Definition;
 *          - die Trigger legen die Definition fuer jeden Schreiber an, der am
 *            Router vorbei einfuegt (Demo-Seed, Tests), und raeumen sie beim
 *            Beenden der Serie wieder ab; das Loeschen der ersten Buchung nimmt
 *            sie per CASCADE mit.
 *        v229 (#1545) gibt der Definition ihren eigenen Starttag, gefuellt aus
 *        dem Datum der ersten Buchung; geprueft an der echten Kette bis v228.
 * Ausfuehren: node --test test/test-budget-series-migration.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

// DB_PATH vor dem Import auf eine Wegwerf-Datei: db.js migriert beim Modul-Load.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(tempDir('yuvomi-seriesmig-'), 'unused.db');
const { MIGRATIONS, migrate } = await import('../server/db.js');
const { generateRecurringInstances, occurrenceDatesInMonth } = await import('../server/routes/budget/helpers.js');

const V = MIGRATIONS.find((m) => m.description === 'Budget: a series keeps its own definition, the first booking is an ordinary entry (#1035)');

/** Eine Datenbank im Stand direkt vor der Migration, mit typischem Bestand. */
function legacyDb() {
  const db = new Database(join(tempDir('yuvomi-seriesmig-'), 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS.filter((m) => m.version < V.version));

  const user = (name) => db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')"
  ).run(name, name).lastInsertRowid;
  const a = user('anna');
  const b = user('ben');
  const giro = db.prepare("INSERT INTO budget_accounts (name, created_by) VALUES ('Giro', ?)").run(a).lastInsertRowid;

  const add = db.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring, recurrence_interval,
       recurrence_interval_count, recurrence_virtual, recurrence_full_amount,
       recurrence_parent_id, account_id, created_by, owner_id, visibility)
    VALUES (@title, @amount, @category, @subcategory, @date, @is_recurring, @interval,
       @count, @virtual, @full, @parent, @account, @by, @by, @visibility)
  `);
  const row = (o) => add.run({
    category: 'housing', subcategory: 'utilities', is_recurring: 0, interval: 'monthly',
    count: 1, virtual: 0, full: null, parent: null, account: null, by: a, visibility: 'shared', ...o,
  }).lastInsertRowid;

  const ids = {};
  ids.rent = row({ title: 'Miete', amount: -900, subcategory: 'rent_mortgage', date: '2020-01-05', is_recurring: 1, account: giro });
  ids.rentFeb = row({ title: 'Miete', amount: -900, subcategory: 'rent_mortgage', date: '2020-02-05', parent: ids.rent, account: giro });
  ids.policy = row({ title: 'Police', amount: -100, date: '2020-01-09', is_recurring: 1, interval: 'yearly', virtual: 1, full: -1200, visibility: 'private' });
  ids.gym = row({ title: 'Fitness', amount: -39, date: '2020-01-12', is_recurring: 1, interval: 'weekly', count: 2, visibility: 'shared_amount' });
  // Beendete Serie: das Original steht noch, zeugt aber nichts mehr.
  ids.ended = row({ title: 'Zeitung', amount: -20, date: '2019-01-03' });
  ids.endedInst = row({ title: 'Zeitung', amount: -20, date: '2019-02-03', parent: ids.ended });
  ids.plain = row({ title: 'Kaffee', amount: -4, date: '2020-01-20' });

  db.prepare('INSERT INTO budget_entry_responsibles (entry_id, user_id) VALUES (?, ?), (?, ?), (?, ?)')
    .run(ids.rent, a, ids.rent, b, ids.rentFeb, a);
  return { db, ids, users: { a, b }, giro };
}

const everyEntry = (db) => db.prepare('SELECT * FROM budget_entries ORDER BY id').all();
const definition = (db, id) => db.prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(id);
const seriesPeople = (db, id) => db.prepare(
  'SELECT user_id FROM budget_series_responsibles WHERE anchor_id = ? ORDER BY user_id'
).all(id).map((r) => r.user_id);

test('Vorbedingung: die Migration ist gefunden und kommt nach dem Bestand', () => {
  assert.ok(V, 'Migration fuer #1035 fehlt');
  assert.ok(V.version > 227, `v${V.version} muss angehaengt sein, nicht eingefuegt`);
});

test('jede laufende Serie bekommt genau eine Definition mit den Werten ihres Originals', () => {
  const { db, ids, giro } = legacyDb();
  migrate(db, MIGRATIONS);

  const count = db.prepare('SELECT COUNT(*) AS c FROM budget_series').get().c;
  assert.equal(count, 3, 'Miete, Police, Fitness - sonst nichts');
  const { created_at: _c, updated_at: _u, ...rent } = definition(db, ids.rent);
  assert.deepEqual(rent, {
    anchor_id: ids.rent, title: 'Miete', amount: -900, full_amount: null,
    category: 'housing', subcategory: 'rent_mortgage', account_id: giro, visibility: 'shared',
    start_date: '2020-01-05', // v229 (#1545), aus dem Datum des Originals
    grid_from: null, // v229: keine Rasteraenderung, keine Grenze
  });
  const policy = definition(db, ids.policy);
  assert.equal(policy.amount, -100, 'virtuell: der geglaettete Monatsanteil, wie am Original');
  assert.equal(policy.full_amount, -1200, 'und der eingegebene Periodenbetrag');
  assert.equal(policy.visibility, 'private');
  assert.equal(definition(db, ids.gym).visibility, 'shared_amount');
  for (const none of ['rentFeb', 'ended', 'endedInst', 'plain']) {
    assert.equal(definition(db, ids[none]), undefined, `${none} ist keine laufende Serie`);
  }
  db.close();
});

test('eine Definition traegt created_at und updated_at (ISO 8601), wie jede Entitaetstabelle', () => {
  // CONTRIBUTING.md, Backend: neue Entitaetstabellen fuehren beide Zeitstempel.
  // budget_series ist keine Join-Tabelle - sie traegt Werte und wird geaendert.
  const { db, ids, users } = legacyDb();
  migrate(db, MIGRATIONS);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const backfilled = definition(db, ids.rent);
  assert.match(String(backfilled.created_at), iso, 'aus dem Backfill');
  assert.match(String(backfilled.updated_at), iso);
  const id = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
    VALUES ('Seed', -5, 'housing', 'utilities', '2024-01-01', 1, ?)
  `).run(users.a).lastInsertRowid;
  assert.match(String(definition(db, id).created_at), iso, 'aus dem Trigger');
  db.close();
});

test('keine Buchung aendert sich', () => {
  const { db } = legacyDb();
  const before = everyEntry(db);
  migrate(db, MIGRATIONS);
  assert.deepEqual(everyEntry(db), before);
  db.close();
});

test('Zustaendige wandern in die Definition, die der Buchungen bleiben stehen', () => {
  const { db, ids, users } = legacyDb();
  migrate(db, MIGRATIONS);
  assert.deepEqual(seriesPeople(db, ids.rent), [users.a, users.b]);
  assert.deepEqual(seriesPeople(db, ids.policy), []);
  const onEntries = db.prepare('SELECT COUNT(*) AS c FROM budget_entry_responsibles').get().c;
  assert.equal(onEntries, 3, 'die Buchungen behalten ihre drei Zeilen');
  db.close();
});

test('nach der Migration entstehen dieselben Vorkommen wie vorher', () => {
  // Die Erwartung sind die Werte, die bis v227 am Original standen und die der
  // alte Leser von dort kopiert haette - der neue liest sie aus der Definition.
  const { db, ids, giro } = legacyDb();
  migrate(db, MIGRATIONS);
  generateRecurringInstances(db, '2031-03');
  const got = db.prepare(`
    SELECT recurrence_parent_id AS p, title, amount, category, subcategory, account_id, visibility, date
    FROM budget_entries WHERE date BETWEEN '2031-03-01' AND '2031-03-31' ORDER BY p, date
  `).all();
  const rent = got.filter((r) => r.p === ids.rent);
  assert.deepEqual(rent, [{
    p: ids.rent, title: 'Miete', amount: -900, category: 'housing', subcategory: 'rent_mortgage',
    account_id: giro, visibility: 'shared', date: '2031-03-05',
  }]);
  const policy = got.filter((r) => r.p === ids.policy);
  assert.equal(policy.length, 1, 'virtuell: einmal je Monat');
  assert.equal(policy[0].amount, -100);
  assert.equal(policy[0].account_id, null, 'virtuell: kein Konto');
  assert.equal(policy[0].visibility, 'private');
  assert.ok(got.filter((r) => r.p === ids.gym).length >= 2, 'alle zwei Wochen: zwei oder drei im Monat');
  assert.equal(got.filter((r) => r.p === ids.ended).length, 0, 'die beendete Serie bleibt beendet');
  const march = db.prepare(
    "SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date = '2031-03-05'"
  ).get(ids.rent).id;
  const who = db.prepare('SELECT COUNT(*) AS c FROM budget_entry_responsibles WHERE entry_id = ?').get(march).c;
  assert.equal(who, 2, 'die neue Instanz erbt die Zustaendigen der Serie');
  db.close();
});

test('ein zweiter Lauf ueberschreibt nichts, auch keine inzwischen abweichende Definition', () => {
  const { db, ids } = legacyDb();
  migrate(db, MIGRATIONS);
  db.prepare("UPDATE budget_series SET title = 'Miete 2031', amount = -1000 WHERE anchor_id = ?").run(ids.rent);
  db.prepare('DELETE FROM budget_series_responsibles WHERE anchor_id = ?').run(ids.rent);
  db.exec(V.up);
  const rent = definition(db, ids.rent);
  assert.equal(rent.title, 'Miete 2031');
  assert.equal(rent.amount, -1000);
  assert.deepEqual(seriesPeople(db, ids.rent), [], 'geleerte Zustaendigkeit bleibt leer');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_series').get().c, 3);
  db.close();
});

test('Trigger: wer am Router vorbei eine Serie einfuegt, bekommt die Definition dazu', () => {
  const { db, users } = legacyDb();
  migrate(db, MIGRATIONS);
  const id = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
    VALUES ('Seed', -5, 'housing', 'utilities', '2024-01-01', 1, ?)
  `).run(users.a).lastInsertRowid;
  assert.equal(definition(db, id).title, 'Seed');
  const inst = db.prepare(`
    INSERT INTO budget_entries (title, amount, date, is_recurring, recurrence_parent_id, created_by)
    VALUES ('Seed', -5, '2024-02-01', 1, ?, ?)
  `).run(id, users.a).lastInsertRowid;
  assert.equal(definition(db, inst), undefined, 'eine Instanz ist nie selbst eine Serie');
  db.close();
});

test('Trigger: Beenden raeumt die Definition ab, Wiederbeginnen legt sie aus der Buchung neu an', () => {
  const { db, ids } = legacyDb();
  migrate(db, MIGRATIONS);
  db.prepare("UPDATE budget_series SET title = 'Miete 2031' WHERE anchor_id = ?").run(ids.rent);
  db.prepare('UPDATE budget_entries SET is_recurring = 0 WHERE id = ?').run(ids.rent);
  assert.equal(definition(db, ids.rent), undefined);
  assert.deepEqual(seriesPeople(db, ids.rent), [], 'Zustaendige der Definition fallen mit');
  db.prepare("UPDATE budget_entries SET is_recurring = 1, title = 'Miete neu' WHERE id = ?").run(ids.rent);
  assert.equal(definition(db, ids.rent).title, 'Miete neu');
  // Ein Update, das is_recurring nicht anfasst, legt nichts an und aendert nichts.
  db.prepare("UPDATE budget_entries SET title = 'nur die Buchung' WHERE id = ?").run(ids.rent);
  assert.equal(definition(db, ids.rent).title, 'Miete neu');
  db.close();
});

test('das Loeschen der ersten Buchung nimmt Definition und Zustaendige mit', () => {
  const { db, ids } = legacyDb();
  migrate(db, MIGRATIONS);
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(ids.rent);
  assert.equal(definition(db, ids.rent), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_series_responsibles').get().c, 0);
  db.close();
});

// ── v229 (#1545): die Definition bekommt ihren eigenen Starttag ─────────────
//
// Bis v228 war der Starttag das Datum der ersten Buchung. v229 legt ihn in die
// Definition. Geprueft an einer Datenbank, die die echte Kette bis v228
// gefahren hat - mit einer Serie, deren Definition der v228-Trigger (ohne
// Starttag) nach der Migration angelegt hat, wie es jede laufende
// Installation zwischen v228 und v229 tut.

const V229 = MIGRATIONS.find((m) => m.description === 'Budget: a series keeps its own start date (#1545)');

/** Stand direkt vor v229: echte Kette bis v228, Bestand aus legacyDb() plus Nachzuegler. */
function v228Db() {
  const fixture = legacyDb();
  const { db, users } = fixture;
  migrate(db, MIGRATIONS.filter((m) => m.version < V229.version));
  // Nach v228 angelegt: die Definition kommt aus dem v228-Trigger.
  fixture.ids.late = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring,
      recurrence_interval, recurrence_interval_count, created_by)
    VALUES ('Kurs', -25, 'housing', 'utilities', '2024-03-13', 1, 'weekly', 3, ?)
  `).run(users.a).lastInsertRowid;
  return fixture;
}

test('v229: Vorbedingung - angehaengt nach v228', () => {
  assert.ok(V229, 'Migration fuer #1545 fehlt');
  assert.ok(V229.version > V.version, `v${V229.version} muss nach v${V.version} kommen`);
});

test('v229: jede laufende Serie bekommt als Starttag das Datum ihrer ersten Buchung', () => {
  const { db, ids } = v228Db();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('budget_series') WHERE name = 'start_date'").get().c,
    0, 'vor v229 gibt es die Spalte nicht',
  );
  migrate(db, MIGRATIONS);
  assert.equal(definition(db, ids.rent).start_date, '2020-01-05');
  assert.equal(definition(db, ids.policy).start_date, '2020-01-09');
  assert.equal(definition(db, ids.gym).start_date, '2020-01-12');
  assert.equal(definition(db, ids.late).start_date, '2024-03-13', 'auch die Definition aus dem v228-Trigger');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_series WHERE start_date IS NULL').get().c, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM budget_series WHERE grid_from IS NOT NULL').get().c,
    0, 'grid_from bleibt leer: das Raster des Bestands galt schon immer, vergangene Monate entstehen wie bisher',
  );
  db.close();
});

test('v229: keine Buchung aendert sich, und es entstehen dieselben Vorkommen wie vorher', () => {
  // "Vorher" ist das Raster aus dem Datum der ersten Buchung - genau das, was
  // der Leser bis v228 an occurrenceDatesInMonth() gab.
  const { db, ids } = v228Db();
  const entriesBefore = everyEntry(db);
  const anchorDate = (id) => db.prepare('SELECT date FROM budget_entries WHERE id = ?').get(id).date;
  const expected = [
    ...occurrenceDatesInMonth(anchorDate(ids.rent), 'monthly', 1, '2031-03').map((date) => [ids.rent, date]),
    [ids.policy, '2031-03-09'], // virtuell: jeden Monat am Tag des Starts
    ...occurrenceDatesInMonth(anchorDate(ids.gym), 'weekly', 2, '2031-03').map((date) => [ids.gym, date]),
    ...occurrenceDatesInMonth(anchorDate(ids.late), 'weekly', 3, '2031-03').map((date) => [ids.late, date]),
  ].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  assert.ok(expected.length >= 5, 'Miete, Police und zwei Wochenserien');

  migrate(db, MIGRATIONS);
  assert.deepEqual(everyEntry(db), entriesBefore);
  generateRecurringInstances(db, '2031-03');
  const got = db.prepare(`
    SELECT recurrence_parent_id AS p, date FROM budget_entries
    WHERE date BETWEEN '2031-03-01' AND '2031-03-31' ORDER BY p, date
  `).all().map((r) => [r.p, r.date]);
  assert.deepEqual(got, expected);
  db.close();
});

test('v229: ein zweiter Lauf ueberschreibt keinen inzwischen verlegten Starttag', () => {
  const { db, ids } = v228Db();
  migrate(db, MIGRATIONS);
  db.prepare("UPDATE budget_series SET start_date = '2020-01-06' WHERE anchor_id = ?").run(ids.rent);
  V229.up(db);
  assert.equal(definition(db, ids.rent).start_date, '2020-01-06');
  assert.equal(definition(db, ids.gym).start_date, '2020-01-12');
  db.close();
});

test('v229: die Trigger nehmen den Starttag aus der Buchung mit', () => {
  const { db, ids, users } = v228Db();
  migrate(db, MIGRATIONS);
  const id = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
    VALUES ('Seed', -5, 'housing', 'utilities', '2025-04-17', 1, ?)
  `).run(users.a).lastInsertRowid;
  assert.equal(definition(db, id).start_date, '2025-04-17', 'neue Serie');
  // Beenden und mit anderem Datum neu beginnen: der Neubeginn ist der Starttag.
  db.prepare('UPDATE budget_entries SET is_recurring = 0 WHERE id = ?').run(ids.rent);
  db.prepare("UPDATE budget_entries SET is_recurring = 1, date = '2026-02-03' WHERE id = ?").run(ids.rent);
  assert.equal(definition(db, ids.rent).start_date, '2026-02-03', 'Neubeginn');
  // Ein Update nur des Datums fasst den Starttag nicht an (#1545).
  db.prepare("UPDATE budget_entries SET date = '2026-02-04' WHERE id = ?").run(ids.rent);
  assert.equal(definition(db, ids.rent).start_date, '2026-02-03');
  db.close();
});
