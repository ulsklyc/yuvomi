/**
 * Modul: Medikamenten-Scheduler-Test
 * Zweck: Fälligkeits-Erzeugung von pending-Dosis-Logs (days_mask/Zeitfenster/
 *        Idempotenz) plus Reminder-Fan-out über den Notification-Channel-Layer
 *        (Web Push + Provider gemockt, kein echter Push).
 * Ausführen: node --test test/test-medication-scheduler.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

const { MIGRATIONS } = await import('../server/db.js');
const { processDueMedications } = await import('../server/services/medication-scheduler.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { removeUser } = await import('../server/services/user-removal.js');

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

function seedUser(db, username, { role = 'member', familyRole = 'other' } = {}) {
  return db.prepare(`INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', ?, ?)`).run(username, username, role, familyRole).lastInsertRowid;
}

function seedMed(db, userId, { name = 'Ibuprofen', active = 1, visibility = 'private' } = {}) {
  return db.prepare(`INSERT INTO medications (user_id, name, active, visibility)
    VALUES (?, ?, ?, ?)`).run(userId, name, active, visibility).lastInsertRowid;
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
      // `scope: 'user'`: ein Kanal der Person selbst. Ohne `scope` zaehlt er als
      // Haushaltskanal, und der bekommt nie eine Medikamenten-Erinnerung (#2598).
      listEnabledChannelsForUser() { return [{ id: 7, provider: 'gotify', name: 'Test', scope: 'user' }]; },
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
      return [{ id: 100 + userId, provider: 'gotify', name: `Kanal ${userId}`, scope: 'user' }];
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

// --------------------------------------------------------
// Health haushaltsweit abgeschaltet (#1660)
// --------------------------------------------------------
function setDisabledModules(db, modules) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(modules));
}

// Zone UND Zeitpunkt fest: der Lauf liest "heute" und "jetzt" auf der Uhr des
// Haushalts. Mittags in UTC liegt weit genug von jeder Tagesgrenze, und die
// gesetzte Zone nimmt der Maschine das Wort.
function fixZone(db) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}
const NOON = new Date('2026-06-15T12:00:00Z');
const NEXT_DAY_NOON = new Date('2026-06-16T12:00:00Z');

test('Health abgeschaltet: der Lauf legt keine Dosis an und meldet nichts, auch nicht an Betreuende', async () => {
  const db = buildTestDb();
  fixZone(db);
  const child = seedUser(db, 'kind');
  const parent = seedUser(db, 'elternteil');
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(child, parent);
  const med = seedMed(db, child);
  seedSchedule(db, med, { time: '08:00' });
  setDisabledModules(db, ['health']);
  const m = makeMocks();

  const res = await processDueMedications({
    database: db, now: NOON,
    pushService: m.pushService, channelStore: m.channelStore, providers: m.providers,
  });

  assert.deepEqual(res, { due: 0, created: 0, notified: 0, sent: 0, failed: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM medication_logs').get().n, 0, 'kein Log bei abgeschaltetem Modul');
  assert.equal(m.pushed.length, 0, 'kein Web Push');
  assert.equal(m.channelSent.length, 0, 'keine Kanal-Meldung');
});

test('Health abgeschaltet: ein anderes abgeschaltetes Modul haelt den Lauf nicht an', async () => {
  const db = buildTestDb();
  fixZone(db);
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00' });
  setDisabledModules(db, ['budget', 'inventory']);
  const m = makeMocks();

  const res = await processDueMedications({
    database: db, now: NOON,
    pushService: m.pushService, channelStore: m.channelStore, providers: m.providers,
  });

  assert.equal(res.created, 1);
  assert.equal(m.pushed.length, 1);
});

test('Health wieder eingeschaltet: nur die Dosen von HEUTE kommen, die Tage dazwischen holt niemand nach', async () => {
  const db = buildTestDb();
  fixZone(db);
  const user = seedUser(db, 'alice');
  const med = seedMed(db, user);
  seedSchedule(db, med, { time: '08:00' });
  seedSchedule(db, med, { time: '11:00' });
  seedSchedule(db, med, { time: '20:00' }); // heute noch nicht dran

  // Tag 1: abgeschaltet, beide Zeitpunkte verstreichen ohne Spur.
  setDisabledModules(db, ['health']);
  const off = makeMocks();
  await processDueMedications({
    database: db, now: NOON,
    pushService: off.pushService, channelStore: off.channelStore, providers: off.providers,
  });
  assert.equal(off.pushed.length, 0);

  // Tag 2: wieder an. Faellig sind die zwei von heute, nicht die vier seit gestern.
  setDisabledModules(db, []);
  const on = makeMocks();
  const res = await processDueMedications({
    database: db, now: NEXT_DAY_NOON,
    pushService: on.pushService, channelStore: on.channelStore, providers: on.providers,
  });

  assert.equal(res.created, 2);
  const logs = db.prepare('SELECT scheduled_at FROM medication_logs ORDER BY scheduled_at').all();
  assert.deepEqual(logs.map((l) => l.scheduled_at), ['2026-06-16T08:00', '2026-06-16T11:00']);
  assert.equal(on.pushed.length, 2, 'eine Meldung je heutigem Zeitpunkt, keine Flut');
});

// --------------------------------------------------------
// Empfaenger mit `health: none` (#2602)
// --------------------------------------------------------
// Die Zustellung der `reminders`-Zeilen fragt seit #1289 die Rechte des
// Empfaengers (`withoutModulesDeniedToRecipient()`), der Scheduler sendet aber
// selbst und fragte nur den Haushaltsschalter. Wem Health entzogen ist, bekam
// trotzdem "Ibuprofen" aufs Telefon - als Betreuer sogar die Dosis einer
// ANDEREN Person ("anna: Ibuprofen"). Push und Kanal stehen in EINER
// Zusicherung, damit die rote Zeile beide Wege nennt.

/** Ein Modul einem Subjekt entziehen bzw. setzen (sparse, wie die Admin-UI schreibt). */
function setModuleAccess(db, subjectType, subjectId, moduleKey, access) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, 'module', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(subjectType, String(subjectId), moduleKey, access);
}

/** Was rausging, je Weg: Push als [Empfaenger, Rumpf], Kanal als [Kanal-ID, Rumpf]. */
function delivered(m) {
  return {
    push: m.pushed.map((p) => [p.userId, p.payload.body]),
    channel: m.channelSent.map((c) => [c.channel.id, c.payload.body]),
  };
}

async function runCareCase(db) {
  const m = makeMocks();
  m.channelStore = makeRecordingChannelStore();
  const res = await processDueMedications({ database: db, now: MONDAY_0900, ...m });
  return { res, m };
}

test('#2602: Eigentuemer und Betreuer mit health none bekommen nichts, die Dosis entsteht trotzdem', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna');
  const parent = seedUser(db, 'dominik');
  grantCare(db, anna, parent);
  const med = seedMed(db, anna, { name: 'Ibuprofen' });
  seedSchedule(db, med, { time: '08:00' });
  setModuleAccess(db, 'user', anna, 'health', 'none');
  setModuleAccess(db, 'user', parent, 'health', 'none');

  const { res, m } = await runCareCase(db);

  assert.deepEqual(delivered(m), { push: [], channel: [] },
    'Health ist beiden entzogen und die Erinnerung ging trotzdem raus');
  assert.equal(res.created, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM medication_logs WHERE medication_id = ?').get(med).n, 1,
    'ueberspringen, nicht loeschen: der Dosis-Log entsteht weiter');
});

test('#2602: Eigentuemer mit health none, Betreuer mit read - nur der Betreuer bekommt die Erinnerung', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna');
  const parent = seedUser(db, 'dominik');
  grantCare(db, anna, parent);
  seedSchedule(db, seedMed(db, anna, { name: 'Ibuprofen' }), { time: '08:00' });
  setModuleAccess(db, 'user', anna, 'health', 'none');
  setModuleAccess(db, 'user', parent, 'health', 'read');

  const { m } = await runCareCase(db);

  assert.deepEqual(delivered(m), {
    push: [[parent, 'anna: Ibuprofen']],
    channel: [[100 + parent, 'anna: Ibuprofen']],
  }, 'none zaehlt, read nicht: wer lesen darf, hoert weiter davon');
});

test('#2602: ein Admin-Betreuer bleibt beliefert, auch mit einer Sperrzeile auf seiner ID', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna');
  const admin = seedUser(db, 'admin', { role: 'admin' });
  grantCare(db, anna, admin);
  seedSchedule(db, seedMed(db, anna, { name: 'Ibuprofen' }), { time: '08:00' });
  setModuleAccess(db, 'user', admin, 'health', 'none');

  const { m } = await runCareCase(db);

  assert.deepEqual(delivered(m), {
    push: [[anna, 'Ibuprofen'], [admin, 'anna: Ibuprofen']],
    channel: [[100 + anna, 'Ibuprofen'], [100 + admin, 'anna: Ibuprofen']],
  }, 'ein Admin faellt nie heraus');
});

test('#2602: der Entzug zaehlt auch aus dem Rollenprofil, nicht nur aus dem Mitglied-Override', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna', { familyRole: 'child' });
  const parent = seedUser(db, 'dominik', { familyRole: 'parent' });
  grantCare(db, anna, parent);
  seedSchedule(db, seedMed(db, anna, { name: 'Ibuprofen' }), { time: '08:00' });
  // Kein Mitglied-Override: die Sperre steht am Rollenprofil `child`.
  setModuleAccess(db, 'role', 'child', 'health', 'none');

  const { m } = await runCareCase(db);

  assert.deepEqual(delivered(m), {
    push: [[parent, 'anna: Ibuprofen']],
    channel: [[100 + parent, 'anna: Ibuprofen']],
  }, 'die Rolle sperrt Health und das Kind bekam die Erinnerung trotzdem - oder die Rolle des Betreuers wurde mitgesperrt');
});

// --------------------------------------------------------
// Haushaltskanaele bekommen nie eine Medikamenten-Erinnerung (#2598, E1)
// --------------------------------------------------------
// Jede Health-Herkunft ist im Haushaltskanal `'personal'`
// (HOUSEHOLD_CHANNEL_POLICY in server/authorize/rows/reminders.ts), und
// SECURITY.md sagt es zu: ein Kanal, den der Haushalt teilt, bekommt nie eine
// Health-Erinnerung. Die Sichtbarkeit des Medikaments aendert daran nichts -
// auch ein fuer die Familie sichtbares geht nur per Push und an Kanaele der
// Person selbst (`scope = 'user'`). Fall und Fixture stammen aus PR #2598,
// die Zusicherung ist umgedreht.

test('ein Haushaltskanal bekommt keine Medikamenten-Erinnerung, auch nicht fuer ein family-sichtbares', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  seedSchedule(db, seedMed(db, user, { name: 'Sertraline' }), { time: '08:00' });
  seedSchedule(db, seedMed(db, user, { name: 'Vitamin D', visibility: 'family' }), { time: '08:00' });
  createNotificationChannelStore({ db }).createChannel({
    provider: 'ntfy', name: 'Familie', enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'familie' }, secrets: {},
  });
  const { pushService, providers, channelSent, pushed } = makeMocks();

  await processDueMedications({ database: db, now: MONDAY_0900, pushService, providers: { ntfy: providers.gotify } });

  assert.deepEqual(channelSent.map((s) => s.payload.body), [], 'der Haushaltskanal hoerte von einem Medikament');
  assert.deepEqual(pushed.map((p) => p.payload.body).sort(), ['Sertraline', 'Vitamin D'], 'Push bleibt der Weg');
});

test('ein eigener Kanal (scope user) bekommt die Erinnerung, der Haushaltskanal daneben nicht', async () => {
  const db = buildTestDb();
  const user = seedUser(db, 'alice');
  const other = seedUser(db, 'ben');
  seedSchedule(db, seedMed(db, user, { name: 'Vitamin D', visibility: 'family' }), { time: '08:00' });
  const store = createNotificationChannelStore({ db });
  const config = { baseUrl: 'https://ntfy.test', topic: 't' };
  store.createChannel({ provider: 'ntfy', name: 'Familie', enabled: true, config, secrets: {} });
  const own = store.createChannel({ provider: 'ntfy', name: 'Alice', enabled: true, scope: 'user', userId: user, config, secrets: {} });
  store.createChannel({ provider: 'ntfy', name: 'Ben', enabled: true, scope: 'user', userId: other, config, secrets: {} });
  const { pushService, providers, channelSent } = makeMocks();

  await processDueMedications({ database: db, now: MONDAY_0900, pushService, providers: { ntfy: providers.gotify } });

  assert.deepEqual(channelSent.map((s) => [s.channel.name, s.payload.body]), [['Alice', 'Vitamin D']]);
  assert.equal(channelSent[0].channel.id, own.id);
});

test('ein entfernter Betreuer bekommt nichts mehr, weder per Push noch ueber einen Kanal', async () => {
  const db = buildTestDb();
  const anna = seedUser(db, 'anna');
  const parent = seedUser(db, 'dominik');
  grantCare(db, anna, parent);
  seedSchedule(db, seedMed(db, anna, { name: 'Ibuprofen' }), { time: '08:00' });
  // Eine angelegte Aufgabe ist eine Spur in geteilten Daten: das Konto wird
  // deaktiviert, nicht geloescht - der schwerere Fall, die users-Zeile bleibt.
  db.prepare("INSERT INTO tasks (title, created_by) VALUES ('Einkauf', ?)").run(parent);
  const store = createNotificationChannelStore({ db });
  const config = { baseUrl: 'https://ntfy.test', topic: 't' };
  store.createChannel({ provider: 'ntfy', name: 'Familie', enabled: true, config, secrets: {} });
  store.createChannel({ provider: 'ntfy', name: 'Dominik', enabled: true, scope: 'user', userId: parent, config, secrets: {} });
  // Die Tabelle legt sonst der Session-Store in server/auth.js an; das Entfernen beendet die Sitzungen.
  db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired_at INTEGER NOT NULL)');
  assert.equal(removeUser(db, parent).outcome, 'deactivated');
  const { pushService, providers, channelSent, pushed } = makeMocks();

  await processDueMedications({ database: db, now: MONDAY_0900, pushService, providers: { ntfy: providers.gotify } });

  assert.deepEqual({
    push: pushed.map((p) => [p.userId, p.payload.body]),
    channel: channelSent.map((c) => [c.channel.name, c.payload.body]),
  }, { push: [[anna, 'Ibuprofen']], channel: [] });
});

// --------------------------------------------------------
// The person's own channel is reached through the SSRF guard
// --------------------------------------------------------
// The person's own channel is reached through the guarded fetch that
// channel-delivery.js sets as the one default for every sender. Real providers
// and the real default here: no `fetchImpl`, no `providers`.

/**
 * @param {import('node:http').RequestListener} handler
 * @returns {Promise<{ base: string, close: () => Promise<unknown> }>}
 */
function startLocalServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
      close: () => new Promise((done) => {
        server.close(done);
        // A kept-alive socket would hold close() open.
        server.closeAllConnections();
      }),
    }));
  });
}

test('ohne fetchImpl geht die Erinnerung an den eigenen Kanal ueber den SSRF-Schutz - ein privates Ziel bleibt unerreicht', async () => {
  /** @type {string[]} */
  const hits = [];
  const { base, close } = await startLocalServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(String(req.url));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  // One fresh household per run: a dose is announced once, a second run over
  // the same database would have nothing left to send.
  const runOnce = async () => {
    const db = buildTestDb();
    const user = seedUser(db, 'alice');
    seedSchedule(db, seedMed(db, user), { time: '08:00' });
    const run = await processDueMedications({
      database: db, now: MONDAY_0900,
      // Push reaches nobody, so `sent` counts the channel alone.
      pushService: { async sendPushToUser() { return 0; } },
      channelStore: {
        listEnabledChannelsForUser() {
          return [{ id: 7, provider: 'webhook', name: 'Alice', scope: 'user', config: { baseUrl: `${base}/hook` }, secrets: {} }];
        },
      },
    });
    if (!('sent' in run)) assert.fail('the run was skipped, nothing was measured');
    return { created: run.created, sent: run.sent, failed: run.failed };
  };
  const before = process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
  try {
    delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
    const guarded = await runOnce();
    assert.deepEqual(hits, [], 'the local server must not have been reached');
    assert.deepEqual(
      guarded, { created: 1, sent: 0, failed: 1 },
      'the refused delivery counts as failed, the dose log is written all the same',
    );

    // Counter-check: the deployment switch opens the private network for this
    // path as for every other channel delivery, and the same run arrives.
    process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = 'true';
    const opened = await runOnce();
    assert.deepEqual(hits, ['/hook'], 'with the switch set exactly one request arrives');
    assert.deepEqual(opened, { created: 1, sent: 1, failed: 0 });
  } finally {
    if (before === undefined) delete process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK;
    else process.env.NOTIFICATION_ALLOW_PRIVATE_NETWORK = before;
    await close();
  }
});
