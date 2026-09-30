/**
 * Modul: Medikamenten-Scheduler-Test
 * Zweck: Fälligkeits-Erzeugung von pending-Dosis-Logs (days_mask/Zeitfenster/
 *        Idempotenz) plus Reminder-Fan-out über den Notification-Channel-Layer
 *        (Web Push + Provider gemockt, kein echter Push).
 * Ausführen: node --test test/test-medication-scheduler.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

const { MIGRATIONS } = await import('../server/db.js');
const { processDueMedications } = await import('../server/services/medication-scheduler.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

function seedUser(db, username) {
  return db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '$2b$12$x', 'member')`).run(username, username).lastInsertRowid;
}

function seedMed(db, userId, { name = 'Ibuprofen', active = 1 } = {}) {
  return db.prepare(`INSERT INTO medications (user_id, name, active, visibility)
    VALUES (?, ?, ?, 'private')`).run(userId, name, active).lastInsertRowid;
}

function seedSchedule(db, medId, { time = '08:00', daysMask = null, dose = 1, active = 1, startDate = null, endDate = null } = {}) {
  return db.prepare(`INSERT INTO medication_schedules
    (medication_id, time_of_day, days_mask, dose_qty, start_date, end_date, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(medId, time, daysMask, dose, startDate, endDate, active).lastInsertRowid;
}

function makeMocks() {
  const pushed = [];
  const channelSent = [];
  return {
    pushed,
    channelSent,
    pushService: {
      async sendPushToUser(userId, payload) { pushed.push({ userId, payload }); return 1; },
    },
    channelStore: {
      listEnabledChannelsForUser() { return [{ id: 7, provider: 'gotify', name: 'Test' }]; },
    },
    providers: {
      gotify: { async send({ channel, payload }) { channelSent.push({ channel, payload }); } },
    },
  };
}

// 2026-06-15 ist ein Montag (Wochentag-Index 0).
const MONDAY_0900 = new Date(2026, 5, 15, 9, 0, 0);

test('erzeugt pending-Log für fällige Dose und fan-outet Web Push + Kanal', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00' }); // 08:00 <= 09:00 → fällig
  const m = makeMocks();

  const res = await processDueMedications({
    database: db, now: MONDAY_0900,
    pushService: m.pushService, channelStore: m.channelStore, providers: m.providers,
  });

  assert.equal(res.due, 1);
  assert.equal(res.created, 1);
  assert.equal(res.notified, 1);

  const logs = db.prepare('SELECT * FROM medication_logs WHERE medication_id = ?').all(med);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'pending');
  assert.equal(logs[0].scheduled_at, '2026-06-15T08:00');
  assert.equal(logs[0].dose_qty, 1);

  assert.equal(m.pushed.length, 1);
  assert.equal(m.pushed[0].userId, user);
  assert.equal(m.pushed[0].payload.url, '/health/meds');
  assert.equal(m.channelSent.length, 1);
  assert.equal(m.channelSent[0].channel.id, 7);
});

test('ist idempotent: zweiter Lauf erzeugt keinen zweiten Log, kein erneuter Fan-out', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00' });
  const m1 = makeMocks();
  await processDueMedications({ database: db, now: MONDAY_0900, ...m1 });

  const m2 = makeMocks();
  const res2 = await processDueMedications({ database: db, now: MONDAY_0900, ...m2 });

  assert.equal(res2.due, 1);
  assert.equal(res2.created, 0);
  assert.equal(res2.notified, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs WHERE medication_id = ?').get(med).c, 1);
  assert.equal(m2.pushed.length, 0);
  assert.equal(m2.channelSent.length, 0);
});

test('noch nicht fällige Zeitfenster (später am Tag) werden übersprungen', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '22:00' }); // 22:00 > 09:00 → nicht fällig
  const m = makeMocks();

  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });
  assert.equal(res.due, 0);
  assert.equal(res.created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs').get().c, 0);
});

test('days_mask filtert Wochentage (Dienstag-Plan an einem Montag)', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00', daysMask: 1 << 1 }); // nur Dienstag
  const m = makeMocks();

  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });
  assert.equal(res.due, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs').get().c, 0);
});

test('inaktive Medikamente/Pläne und Start-/End-Grenzen', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const inactiveMed = seedMed(db, user, { name: 'Alt', active: 0 });
  seedSchedule(db, inactiveMed, { time: '08:00' });
  const med = seedMed(db, user, { name: 'Neu' });
  seedSchedule(db, med, { time: '08:00', active: 0 });                 // Plan inaktiv
  seedSchedule(db, med, { time: '08:00', startDate: '2026-06-20' });   // startet später
  seedSchedule(db, med, { time: '08:00', endDate: '2026-06-10' });     // schon beendet
  const m = makeMocks();

  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });
  assert.equal(res.created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM medication_logs').get().c, 0);
});

test('kein Push-Abo: Fan-out zählt nur zugestellte Kanäle', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00' });
  const m = makeMocks();
  m.pushService = { async sendPushToUser() { return 0; } }; // kein aktives Abo

  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });
  assert.equal(res.notified, 1);
  assert.equal(res.sent, 1); // nur der Gotify-Kanal
});

// Betreuung (#584) bestimmt den Empfaengerkreis (D#1041): die betroffene Person
// und jeder eingetragene Betreuer, letzterer mit dem Namen der Person im Rumpf.
function grantCare(db, subjectId, caregiverId) {
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(subjectId, caregiverId);
}

function makeRecordingChannelStore() {
  const asked = [];
  return {
    asked,
    listEnabledChannelsForUser(userId) {
      asked.push(userId);
      return [{ id: 100 + userId, provider: 'gotify', name: `Kanal ${userId}` }];
    },
  };
}

test('Betreuer bekommen die Erinnerung mit dem Namen der betreuten Person, die Person selbst ohne', async () => {
  const db = buildTestDb();
  const child = seedUser(db, 'anna');
  const parent = seedUser(db, 'dominik');
  grantCare(db, child, parent);
  const med = seedMed(db, child, { name: 'Ibuprofen' });
  seedSchedule(db, med, { time: '08:00' });
  const m = makeMocks();
  m.channelStore = makeRecordingChannelStore();

  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });

  assert.equal(res.created, 1);
  assert.equal(res.notified, 1, 'notified zaehlt Dosen, nicht Empfaenger');
  assert.equal(res.sent, 4, 'zwei Empfaenger x (Web Push + ein Kanal)');

  assert.deepEqual(
    m.pushed.map((p) => [p.userId, p.payload.body]),
    [[child, 'Ibuprofen'], [parent, 'anna: Ibuprofen']],
  );
  // Titel, Ziel und Tag sind fuer beide gleich - nur der Rumpf traegt den Namen.
  assert.equal(m.pushed[0].payload.title, m.pushed[1].payload.title);
  assert.equal(m.pushed[1].payload.url, '/health/meds');
  assert.equal(m.pushed[0].payload.tag, m.pushed[1].payload.tag);

  assert.deepEqual(m.channelStore.asked, [child, parent], 'Kanaele je Empfaenger, nicht nur des Eigentuemers');
  assert.deepEqual(
    m.channelSent.map((c) => [c.channel.id, c.payload.body]),
    [[100 + child, 'Ibuprofen'], [100 + parent, 'anna: Ibuprofen']],
  );
});

test('eine Betreuung fuer eine ANDERE Person loest keine Erinnerung aus', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna');
  const ben = seedUser(db, 'ben');
  const parent = seedUser(db, 'dominik');
  grantCare(db, ben, parent); // Betreuung gilt Ben, faellig ist Annas Medikament
  const med = seedMed(db, anna);
  seedSchedule(db, med, { time: '08:00' });
  const m = makeMocks();

  await processDueMedications({ database: db, now: MONDAY_0900, ...m });

  assert.deepEqual(m.pushed.map((p) => p.userId), [anna]);
});

test('ohne Medikamentennamen traegt die Betreuer-Erinnerung Name und Fallback-Rumpf', async () => {
  const db = buildTestDb();
  const child = seedUser(db, 'anna');
  const parent = seedUser(db, 'dominik');
  grantCare(db, child, parent);
  const med = seedMed(db, child, { name: '' });
  seedSchedule(db, med, { time: '08:00' });
  const m = makeMocks();

  await processDueMedications({ database: db, now: MONDAY_0900, ...m });

  assert.equal(m.pushed[0].payload.body, 'Medication reminder');
  assert.equal(m.pushed[1].payload.body, 'anna: Medication reminder');
});

// --------------------------------------------------------
// Faellig nach der Uhr des HAUSHALTS, nicht des Servers (#1539)
// --------------------------------------------------------
// `time_of_day` und `scheduled_at` sind Wanduhrzeit des Haushalts. Der
// Scheduler las Tag und Uhrzeit mit getDate()/getHours() - der Zone des
// Server-PROZESSES. Mit `TZ=UTC` im Container und einem Haushalt in Berlin kam
// die Erinnerung fuer 08:00 um 10:00. Der Prozess laeuft hier deshalb in einer
// anderen Zone als der Haushalt; der letzte Fall haelt beide gleich.

function inProcessZone(zone, fn) {
  return async () => {
    const prev = process.env.TZ;
    process.env.TZ = zone;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  };
}

function setHouseholdZone(db, zone) {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
}

async function runAt(db, iso) {
  const m = makeMocks();
  const res = await processDueMedications({ database: db, now: new Date(iso), ...m });
  const logs = db.prepare('SELECT scheduled_at FROM medication_logs ORDER BY id').all().map((r) => r.scheduled_at);
  return { res, logs };
}

function berlinSchedule(time, opts = {}) {
  const db = buildTestDb();
  setHouseholdZone(db, opts.zone ?? 'Europe/Berlin');
  const user = seedUser(db, 'alice');
  seedSchedule(db, seedMed(db, user), { time, daysMask: opts.daysMask ?? null });
  return db;
}

test('#1539: Prozess UTC, Haushalt Berlin - 08:00 ist um 08:00 Berliner Zeit faellig', inProcessZone('UTC', async () => {
  assert.equal(new Date('2026-06-15T12:00').getTimezoneOffset(), 0, 'Prozess muss in UTC laufen');
  const db = berlinSchedule('08:00');
  // 07:30 in Berlin (05:30Z): noch nicht.
  assert.deepEqual((await runAt(db, '2026-06-15T05:30:00Z')).logs, []);
  // 08:30 in Berlin (06:30Z): faellig, als Wanduhrzeit des Haushalts gespeichert.
  const { res, logs } = await runAt(db, '2026-06-15T06:30:00Z');
  assert.equal(res.created, 1);
  assert.deepEqual(logs, ['2026-06-15T08:00']);
}));

test('#1539: der Kalendertag und der Wochentag sind die des Haushalts', inProcessZone('UTC', async () => {
  // Montag 21:00 in New York ist Dienstag 01:00 UTC. Ein Plan nur fuer Montag
  // (Bit 0) um 20:00 ist faellig - fuer Montag, nicht fuer Dienstag.
  const db = berlinSchedule('20:00', { zone: 'America/New_York', daysMask: 1 });
  const { res, logs } = await runAt(db, '2026-06-16T01:00:00Z');
  assert.equal(res.created, 1);
  assert.deepEqual(logs, ['2026-06-15T20:00']);
}));

test('#1539: an beiden Zeitumstellungen folgt die Faelligkeit der Uhr des Haushalts', inProcessZone('UTC', async () => {
  // 29.03.2026: Berlin springt auf CEST, 08:00 ist 06:00Z.
  const spring = berlinSchedule('08:00');
  assert.deepEqual((await runAt(spring, '2026-03-29T05:59:00Z')).logs, [], '07:59 CEST');
  assert.deepEqual((await runAt(spring, '2026-03-29T06:00:00Z')).logs, ['2026-03-29T08:00'], '08:00 CEST');
  // 25.10.2026: zurueck auf CET, 08:00 ist 07:00Z.
  const autumn = berlinSchedule('08:00');
  assert.deepEqual((await runAt(autumn, '2026-10-25T06:59:00Z')).logs, [], '07:59 CET');
  assert.deepEqual((await runAt(autumn, '2026-10-25T07:00:00Z')).logs, ['2026-10-25T08:00'], '08:00 CET');
  // Die doppelte Stunde 02:00-03:00 erzeugt keinen zweiten Log.
  const fold = berlinSchedule('02:30');
  assert.deepEqual((await runAt(fold, '2026-10-25T00:45:00Z')).logs, ['2026-10-25T02:30'], 'erste 02:45 (CEST)');
  assert.deepEqual((await runAt(fold, '2026-10-25T01:45:00Z')).logs, ['2026-10-25T02:30'], 'zweite 02:45 (CET)');
}));

test('#1539: Prozess und Haushalt in derselben Zone - unveraendert', inProcessZone('Europe/Berlin', async () => {
  const db = berlinSchedule('08:00');
  assert.deepEqual((await runAt(db, '2026-06-15T05:30:00Z')).logs, []);
  assert.deepEqual((await runAt(db, '2026-06-15T06:30:00Z')).logs, ['2026-06-15T08:00']);
}));
