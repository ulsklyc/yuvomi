/**
 * Test: Vorsorge-Erinnerungen (Health)
 * Zweck: server/services/prevention-reminders.js gegen eine echte (migrierte)
 *        In-Memory-DB - Fälligkeit über einen Monatswechsel (geteilter
 *        interval-date-Helfer), Idempotenz (kein Zurücksetzen von
 *        pushed_at/dismissed bei unverändertem remind_at), und die D6-
 *        Betreuungs-Fan-out-Regeln je einzeln: eine betreuende Person bekommt
 *        eine eigene Zeile, eine selbst gesetzte Zeile wird nie überschrieben,
 *        ein Entzug der Betreuung räumt die geerbte Zeile sofort ab, eine
 *        betreuende Person ohne Health-Zugriff bekommt keine Zeile, und nur
 *        die geerbte Zeile nennt die betreute Person.
 * Ausführen: npm run test:prevention-reminders
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const { syncPreventionRemindersForSubject, syncAllPreventionReminders } = await import('../server/services/prevention-reminders.js');
const db = dbmod.get();

// Feste Zone wie test-cycle-reminders.js/test-pantry-expiry-reminders.js:
// remind_at ist naiv-UTC, ohne diese Zeile faellt todayKey() auf die
// Maschinen-Zone zurueck.
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

let nextUserId = 1;
function makeUser() {
  const username = `u${nextUserId++}`;
  return db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')")
    .run(username, username).lastInsertRowid;
}

function makeType(fields = {}) {
  const name = fields.name ?? `type${nextUserId++}`;
  const intervalMonths = 'default_interval_months' in fields ? fields.default_interval_months : 12;
  return db.prepare(`
    INSERT INTO health_prevention_types (name, kind, default_interval_months, icon)
    VALUES (?, ?, ?, 'syringe')
  `).run(name, fields.kind ?? 'vaccination', intervalMonths).lastInsertRowid;
}

function makeRecord(userId, typeId, fields = {}) {
  return db.prepare(`
    INSERT INTO health_prevention_records (user_id, type_id, given_on, interval_months, next_due_on, reminder_offset_days, visibility, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, typeId, fields.given_on, fields.interval_months ?? null, fields.next_due_on ?? null,
    fields.reminder_offset_days ?? null, fields.visibility ?? 'private', fields.created_by ?? userId,
  ).lastInsertRowid;
}

function grantCare(subjectId, caregiverId) {
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(subjectId, caregiverId);
}

function revokeCare(subjectId, caregiverId) {
  db.prepare('DELETE FROM health_care_grants WHERE subject_id = ? AND caregiver_id = ?').run(subjectId, caregiverId);
}

// Opt-in wie cycle_settings.notify_partner_user_id - Standard aus (Review
// #1256). Ohne diese Zeile bekaeme selbst eine bestehende Betreuungs-Zusage
// keine geerbte Erinnerung.
function enableNotifyCaregivers(subjectId) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`health_prevention_notify_caregivers:user:${subjectId}`);
}

function remindersFor(recordId) {
  return db.prepare(`
    SELECT * FROM reminders WHERE entity_type = 'health_prevention_due' AND entity_id = ?
    ORDER BY created_by
  `).all(recordId);
}

const NOW = new Date('2026-06-15T12:00:00Z'); // heute (Haushaltszone) = 2026-06-15

// ── Grundfall: Faelligkeit, Idempotenz ──────────────────────────────────────

test('ein Typ ohne Intervall (einmalig) und ohne next_due_on erzeugt keine Erinnerung', () => {
  const u = makeUser();
  const t = makeType({ default_interval_months: null });
  const recordId = makeRecord(u, t, { given_on: '2026-01-01' });
  syncPreventionRemindersForSubject(db, u, NOW);
  assert.deepEqual(remindersFor(recordId), []);
});

test('Faelligkeit ueber einen Monatswechsel: 31. Jan + 1 Monat -> 28./29. Feb', () => {
  const u = makeUser();
  const t = makeType({ default_interval_months: 1 });
  const recordId = makeRecord(u, t, { given_on: '2026-01-31', reminder_offset_days: 0 });
  syncPreventionRemindersForSubject(db, u, NOW);
  const [reminder] = remindersFor(recordId);
  assert.ok(reminder, 'die Erinnerung wurde angelegt');
  assert.equal(reminder.remind_at, '2026-02-28T09:00', '28. Feb 2026 (kein Schaltjahr)');
});

test('Erinnerung wird verschoben, wenn ein neuerer Datensatz eintrifft', () => {
  const u = makeUser();
  const t = makeType({ default_interval_months: 12 });
  const first = makeRecord(u, t, { given_on: '2026-01-01' });
  syncPreventionRemindersForSubject(db, u, NOW);
  const before = remindersFor(first)[0];
  assert.ok(before);

  const second = makeRecord(u, t, { given_on: '2026-06-01' });
  syncPreventionRemindersForSubject(db, u, NOW);
  assert.deepEqual(remindersFor(first), [], 'die alte Zeile ist abgeraeumt - der neue Datensatz ist jetzt der juengste');
  const after = remindersFor(second)[0];
  assert.ok(after);
  assert.equal(after.remind_at, '2027-05-02T09:00'); // 1. Juni 2027 minus 30 Tage Standard-Vorlauf
});

test('ein unveraenderter remind_at laesst pushed_at/dismissed unangetastet', () => {
  const u = makeUser();
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(u, t, { given_on: '2026-01-01' });
  syncPreventionRemindersForSubject(db, u, NOW);
  const reminderId = remindersFor(recordId)[0].id;
  db.prepare("UPDATE reminders SET pushed_at = '2026-06-01T09:00:00Z', dismissed = 1 WHERE id = ?").run(reminderId);

  // Erneuter Lauf ohne jede Aenderung am Datensatz - derselbe remind_at.
  syncPreventionRemindersForSubject(db, u, NOW);
  const after = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
  assert.ok(after, 'dieselbe Zeile besteht fort (kein Loeschen+Neuanlegen)');
  assert.equal(after.pushed_at, '2026-06-01T09:00:00Z');
  assert.equal(after.dismissed, 1);
});

test('der Voll-Sync raeumt eine Erinnerung ab, deren Datensatz geloescht wurde', () => {
  const u = makeUser();
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(u, t, { given_on: '2026-01-01' });
  syncPreventionRemindersForSubject(db, u, NOW);
  assert.ok(remindersFor(recordId).length > 0);

  db.prepare('DELETE FROM health_prevention_records WHERE id = ?').run(recordId);
  syncAllPreventionReminders(db, NOW);
  assert.deepEqual(remindersFor(recordId), [], 'die verwaiste Zeile (entity_id zeigt ins Leere) ist weg');
});

// ── D6: Betreuungs-Fan-out ──────────────────────────────────────────────────

test('D6: ohne Opt-in bekommt eine betreuende Person KEINE Zeile, trotz bestehender Betreuungs-Zusage', () => {
  // Der Kern von Review #1256: health_care_grants regelt Lese-/Schreibrecht,
  // nicht ob eine Push-Benachrichtigung mit Namen auf einem fremden Geraet
  // landet. Ohne die ausdrueckliche Zustimmung des Eigentuemers bleibt es bei
  // dessen eigener Zeile - dieselbe Grundhaltung wie cycle_settings.notify_partner_user_id.
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });

  syncPreventionRemindersForSubject(db, subject, NOW);
  const rows = remindersFor(recordId);
  assert.ok(rows.some((r) => r.created_by === subject), 'die Eigentuemer-Zeile existiert weiterhin');
  assert.ok(!rows.some((r) => r.created_by === caregiver), 'keine geerbte Zeile ohne Opt-in');
});

test('D6: das Opt-in auszuschalten raeumt eine bereits geerbte Zeile sofort ab', () => {
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });

  syncPreventionRemindersForSubject(db, subject, NOW);
  assert.ok(remindersFor(recordId).some((r) => r.created_by === caregiver), 'Vorbedingung: die Betreuer-Zeile existiert');

  db.prepare("UPDATE sync_config SET value = '0' WHERE key = ?").run(`health_prevention_notify_caregivers:user:${subject}`);
  syncPreventionRemindersForSubject(db, subject, NOW);
  assert.ok(!remindersFor(recordId).some((r) => r.created_by === caregiver), 'die geerbte Zeile ist weg, sobald das Opt-in zurueckgenommen wird');
  assert.ok(remindersFor(recordId).some((r) => r.created_by === subject), 'die Eigentuemer-Zeile bleibt bestehen');
});

test('D6: eine betreuende Person bekommt eine eigene Zeile (assigned_from = Subjekt)', () => {
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });

  syncPreventionRemindersForSubject(db, subject, NOW);
  const rows = remindersFor(recordId);
  const ownerRow = rows.find((r) => r.created_by === subject);
  const caregiverRow = rows.find((r) => r.created_by === caregiver);
  assert.ok(ownerRow, 'die Eigentuemer-Zeile existiert');
  assert.equal(ownerRow.assigned_from, null);
  assert.ok(caregiverRow, 'die Betreuer-Zeile existiert');
  assert.equal(caregiverRow.assigned_from, subject);
  assert.equal(caregiverRow.remind_at, ownerRow.remind_at, 'derselbe Zeitpunkt fuer beide');
});

test('D6: eine selbst gesetzte Zeile (assigned_from IS NULL) einer Betreuungsperson wird nie ueberschrieben', () => {
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });

  // Die Betreuungsperson traegt VORAB eine eigene Zeile fuer genau diesen
  // Datensatz ein (assigned_from IS NULL) - simuliert den defensiven Pfad aus
  // server/services/event-reminder-fanout.js, auch wenn `health_prevention_due`
  // eine abgeleitete Herkunft ist und der generische Router sie normalerweise
  // ablehnt (server/routes/reminders.js#DERIVED_ENTITY_TYPES).
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('health_prevention_due', ?, '2026-01-01T09:00', ?, NULL)
  `).run(recordId, caregiver);

  syncPreventionRemindersForSubject(db, subject, NOW);
  const selfSet = db.prepare(`
    SELECT * FROM reminders WHERE entity_type = 'health_prevention_due' AND entity_id = ?
      AND created_by = ? AND assigned_from IS NULL
  `).get(recordId, caregiver);
  assert.ok(selfSet, 'die selbst gesetzte Zeile besteht unveraendert fort');
  assert.equal(selfSet.remind_at, '2026-01-01T09:00');

  const inherited = db.prepare(`
    SELECT * FROM reminders WHERE entity_type = 'health_prevention_due' AND entity_id = ?
      AND created_by = ? AND assigned_from = ?
  `).get(recordId, caregiver, subject);
  assert.equal(inherited, undefined, 'keine zusaetzliche geerbte Zeile fuer dieselbe Person');
});

test('D6: ein Entzug der Betreuung raeumt die geerbte Zeile sofort ab', () => {
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);
  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });

  syncPreventionRemindersForSubject(db, subject, NOW);
  assert.ok(remindersFor(recordId).some((r) => r.created_by === caregiver), 'Vorbedingung: die Betreuer-Zeile existiert');

  revokeCare(subject, caregiver);
  syncPreventionRemindersForSubject(db, subject, NOW);
  assert.ok(!remindersFor(recordId).some((r) => r.created_by === caregiver), 'die geerbte Zeile ist weg');
  assert.ok(remindersFor(recordId).some((r) => r.created_by === subject), 'die Eigentuemer-Zeile bleibt bestehen');
});

test('D6: eine betreuende Person ohne Health-Zugriff bekommt keine Zeile', () => {
  const subject = makeUser();
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'health', 'none')
  `).run(String(caregiver));

  const t = makeType({ default_interval_months: 12 });
  const recordId = makeRecord(subject, t, { given_on: '2026-01-01' });
  syncPreventionRemindersForSubject(db, subject, NOW);

  assert.ok(!remindersFor(recordId).some((r) => r.created_by === caregiver), 'keine Zeile ohne Health-Zugriff');
  assert.ok(remindersFor(recordId).some((r) => r.created_by === subject), 'die Eigentuemer-Zeile bleibt unberuehrt');
});

test('D6: der Voll-Sync erreicht auch Betreuungspersonen ueber mehrere Subjekte', () => {
  const subjectOne = makeUser();
  const subjectTwo = makeUser();
  const caregiver = makeUser();
  grantCare(subjectOne, caregiver);
  grantCare(subjectTwo, caregiver);
  enableNotifyCaregivers(subjectOne);
  enableNotifyCaregivers(subjectTwo);
  const t = makeType({ default_interval_months: 12 });
  const recordOne = makeRecord(subjectOne, t, { given_on: '2026-01-01' });
  const recordTwo = makeRecord(subjectTwo, t, { given_on: '2026-02-01' });

  syncAllPreventionReminders(db, NOW);
  assert.ok(remindersFor(recordOne).some((r) => r.created_by === caregiver));
  assert.ok(remindersFor(recordTwo).some((r) => r.created_by === caregiver));
});

// ── D6: nur die geerbte Zeile nennt die betreute Person ─────────────────────

test('D6: der Push-Text nennt die betreute Person nur auf der geerbten Zeile', async () => {
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');

  const subject = makeUser();
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Mara', subject);
  const caregiver = makeUser();
  grantCare(subject, caregiver);
  enableNotifyCaregivers(subject);

  const t = makeType({ name: 'Tetanus', default_interval_months: 1 });
  makeRecord(subject, t, { given_on: '2026-01-01', reminder_offset_days: 0 });
  syncPreventionRemindersForSubject(db, subject, NOW);

  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(subject, `https://push/${subject}`, 'p', 'a');
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(caregiver, `https://push/${caregiver}`, 'p', 'a');

  const bodies = {};
  const pushService = {
    sendPushToUser: async (userId, payload) => { bodies[userId] = payload.body; return 1; },
  };
  const store = createNotificationChannelStore({ db });

  // Faellig ab 2026-02-01T09:00 (31. Jan + 1 Monat -> 28. Feb? nein: given_on
  // 2026-01-01 + 1 Monat = 2026-02-01, Vorlauf 0). "now" liegt danach.
  await processDueNotifications({
    database: db, channelStore: store, pushService, providers: {},
    now: new Date('2026-02-02T10:00:00Z'),
  });

  assert.equal(bodies[caregiver], 'Tetanus - Mara', 'die geerbte Zeile nennt die betreute Person');
  assert.equal(bodies[subject], 'Tetanus', 'die eigene Zeile bleibt ohne Namenszusatz');
});

test('teardown: keine Server-Ressourcen zu schliessen', () => {
  assert.ok(true);
});
