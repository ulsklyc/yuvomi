/**
 * Test: Zyklus-Erinnerungen (Health, Phase 1)
 * Zweck: server/services/cycle-reminders.js gegen eine echte (migrierte)
 *        In-Memory-DB - Anker-Lebenszyklus für beide Arten
 *        (`cycle_period`/`cycle_log_nudge`), Idempotenz (kein Zurücksetzen
 *        von pushed_at/dismissed), Anker-Aufräumen bei einer verschobenen
 *        Vorhersage, und die drei Abschalt-Wege (keine Einstellung, Zyklus-
 *        Tab gesperrt, Health-Modul entzogen).
 * Ausführen: node --experimental-sqlite --test test/test-cycle-reminders.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const { syncCycleRemindersForUser, syncAllCycleReminders } = await import('../server/services/cycle-reminders.js');
const db = dbmod.get();

// Feste Zone wie in test-pantry-expiry-reminders.js: remind_at ist naiv-UTC,
// und ohne diese Zeile faellt todayKey() auf die Zone der Maschine zurueck.
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

let nextUserId = 1;
function makeUser() {
  const username = `u${nextUserId++}`;
  return db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')")
    .run(username, username).lastInsertRowid;
}

function addPeriod(userId, startDate, periodLen = 5) {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + periodLen - 1);
  const endDate = d.toISOString().slice(0, 10);
  db.prepare('INSERT INTO cycle_periods (user_id, start_date, end_date, visibility) VALUES (?, ?, ?, ?)')
    .run(userId, startDate, endDate, 'private');
}

function upsertSettings(userId, fields) {
  const existing = db.prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(userId);
  const merged = { ...existing, ...fields };
  db.prepare(`
    INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility, pregnancy_mode, pregnancy_due_date, default_visibility, remind_period_days_before, remind_log_daily, notify_partner_user_id, notify_partner_days_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      cycle_length_avg = excluded.cycle_length_avg, period_length_avg = excluded.period_length_avg,
      luteal_length = excluded.luteal_length, track_fertility = excluded.track_fertility,
      pregnancy_mode = excluded.pregnancy_mode, pregnancy_due_date = excluded.pregnancy_due_date,
      default_visibility = excluded.default_visibility,
      remind_period_days_before = excluded.remind_period_days_before, remind_log_daily = excluded.remind_log_daily,
      notify_partner_user_id = excluded.notify_partner_user_id, notify_partner_days_before = excluded.notify_partner_days_before
  `).run(
    userId, merged.cycle_length_avg ?? null, merged.period_length_avg ?? null, merged.luteal_length ?? 14,
    merged.track_fertility ?? 1, merged.pregnancy_mode ?? 0, merged.pregnancy_due_date ?? null,
    merged.default_visibility ?? 'private', merged.remind_period_days_before ?? null, merged.remind_log_daily ?? 0,
    merged.notify_partner_user_id ?? null, merged.notify_partner_days_before ?? null,
  );
}

function anchorsFor(userId) {
  return db.prepare('SELECT * FROM cycle_reminder_anchors WHERE user_id = ? ORDER BY kind').all(userId);
}
function remindersFor(userId, entityType) {
  return db.prepare('SELECT * FROM reminders WHERE created_by = ? AND entity_type = ?').all(userId, entityType);
}

// Vier Perioden, 30-Tage-Abstaende, erreicht MIN_HISTORY_GAPS (3 Luecken) aus
// Phase 0 - sonst bliebe avgCycle beim 28-Tage-Default statt der 30 hier.
function seedFourPeriods(userId) {
  addPeriod(userId, '2026-03-01');
  addPeriod(userId, '2026-03-31');
  addPeriod(userId, '2026-04-30');
  addPeriod(userId, '2026-05-30'); // naechster vorhergesagter Beginn: 2026-06-29
}

const NOW = new Date('2026-06-15T12:00:00Z'); // heute (Haushaltszone) = 2026-06-15

test('keine Einstellung -> keine Anker, keine Erinnerungen', () => {
  const u = makeUser();
  seedFourPeriods(u);
  syncCycleRemindersForUser(db, u, NOW);
  assert.deepEqual(anchorsFor(u), []);
  assert.deepEqual(remindersFor(u, 'cycle_period'), []);
  assert.deepEqual(remindersFor(u, 'cycle_log_nudge'), []);
});

test('Periode-Erinnerung: Anker + Erinnerung zum vorhergesagten Beginn minus Vorlauf', () => {
  const u = makeUser();
  seedFourPeriods(u);
  upsertSettings(u, { remind_period_days_before: 3 });

  syncCycleRemindersForUser(db, u, NOW);

  const anchors = anchorsFor(u);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].kind, 'period_predicted');
  assert.equal(anchors[0].anchor_date, '2026-06-29');

  const reminders = remindersFor(u, 'cycle_period');
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].remind_at, '2026-06-26T09:00');
  assert.equal(reminders[0].entity_id, anchors[0].id);
});

test('idempotent: ein zweiter Lauf ohne Aenderung laesst die Zeile unangetastet (pushed_at/dismissed bleiben)', () => {
  const u = makeUser();
  seedFourPeriods(u);
  upsertSettings(u, { remind_period_days_before: 3 });
  syncCycleRemindersForUser(db, u, NOW);

  const before = remindersFor(u, 'cycle_period')[0];
  db.prepare('UPDATE reminders SET pushed_at = ?, dismissed = 1 WHERE id = ?').run('2026-06-26T09:05:00Z', before.id);

  syncCycleRemindersForUser(db, u, NOW);

  const after = remindersFor(u, 'cycle_period')[0];
  assert.equal(after.id, before.id, 'die Zeile wurde ersetzt statt unangetastet zu bleiben');
  assert.equal(after.pushed_at, '2026-06-26T09:05:00Z');
  assert.equal(after.dismissed, 1);
});

test('verschobene Vorhersage: alter Anker + alte Erinnerung gehen, neue entstehen', () => {
  const u = makeUser();
  seedFourPeriods(u);
  upsertSettings(u, { remind_period_days_before: 3 });
  syncCycleRemindersForUser(db, u, NOW);
  const oldAnchorId = anchorsFor(u)[0].id;

  // Eine fuenfte, verspaetete Periode verschiebt den Durchschnitt und damit
  // den naechsten vorhergesagten Beginn.
  addPeriod(u, '2026-06-04'); // Abstand 35 statt 30 -> avgCycle steigt
  syncCycleRemindersForUser(db, u, NOW);

  const anchors = anchorsFor(u);
  assert.equal(anchors.length, 1, 'es darf nur ein aktueller Anker je Art existieren');
  assert.notEqual(anchors[0].id, oldAnchorId, 'der alte Anker haette abgeraeumt werden muessen');
  assert.notEqual(anchors[0].anchor_date, '2026-06-29');

  // Die alte Erinnerung darf nicht als Leiche stehen bleiben.
  const oldReminder = db.prepare('SELECT * FROM reminders WHERE entity_type = ? AND entity_id = ?').get('cycle_period', oldAnchorId);
  assert.equal(oldReminder, undefined);
});

test('Vorlauf abschalten (NULL) raeumt Anker + Erinnerung ab', () => {
  const u = makeUser();
  seedFourPeriods(u);
  upsertSettings(u, { remind_period_days_before: 3 });
  syncCycleRemindersForUser(db, u, NOW);
  assert.equal(anchorsFor(u).length, 1);

  upsertSettings(u, { remind_period_days_before: null });
  syncCycleRemindersForUser(db, u, NOW);

  assert.deepEqual(anchorsFor(u), []);
  assert.deepEqual(remindersFor(u, 'cycle_period'), []);
});

test('taeglicher Log-Hinweis: entsteht ohne heutigen Log, entfaellt sobald einer existiert', () => {
  const u = makeUser();
  upsertSettings(u, { remind_log_daily: 1 });

  syncCycleRemindersForUser(db, u, NOW);
  let anchors = anchorsFor(u);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].kind, 'log_nudge');
  assert.equal(anchors[0].anchor_date, '2026-06-15');
  assert.equal(remindersFor(u, 'cycle_log_nudge')[0].remind_at, '2026-06-15T09:00');

  db.prepare("INSERT INTO cycle_day_logs (user_id, log_date, visibility) VALUES (?, '2026-06-15', 'private')").run(u);
  syncCycleRemindersForUser(db, u, NOW);

  assert.deepEqual(anchorsFor(u), []);
  assert.deepEqual(remindersFor(u, 'cycle_log_nudge'), []);
});

test('Zyklus-Tab haushaltweit gesperrt raeumt beide Arten ab, auch mit aktiven Einstellungen', () => {
  const u = makeUser();
  seedFourPeriods(u);
  upsertSettings(u, { remind_period_days_before: 3, remind_log_daily: 1 });
  syncCycleRemindersForUser(db, u, NOW);
  assert.equal(anchorsFor(u).length, 2);

  db.prepare("INSERT INTO sync_config (key, value) VALUES ('health_cycle_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  syncCycleRemindersForUser(db, u, NOW);
  assert.deepEqual(anchorsFor(u), []);

  db.prepare("DELETE FROM sync_config WHERE key = 'health_cycle_enabled'").run();
});

test('syncAllCycleReminders erreicht auch Nutzer, die nur noch Anker tragen (abgeschaltete Berechtigung)', () => {
  const u = makeUser();
  upsertSettings(u, { remind_log_daily: 1 });
  syncCycleRemindersForUser(db, u, NOW);
  assert.equal(anchorsFor(u).length, 1);

  // Berechtigung entziehen, ohne die Einstellungszeile zu aendern - der
  // Voll-Sync muss den Nutzer trotzdem finden, weil er noch einen Anker traegt.
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', ?, 'module', 'health', 'none')").run(String(u));

  syncAllCycleReminders(db, NOW);
  assert.deepEqual(anchorsFor(u), []);
});

// --------------------------------------------------------------------------
// Partner-Benachrichtigung (Eigentümer-Opt-in)
// --------------------------------------------------------------------------

test('Partner-Erinnerung: eigene Anker-Art, aber die Erinnerung geht an die Partnerperson', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });

  syncCycleRemindersForUser(db, owner, NOW);

  // Der Anker gehört weiterhin dem Eigentümer (anchor_date ist sein
  // vorhergesagter Beginn) - eigene Art 'partner_period', nicht 'period_predicted'.
  const anchors = anchorsFor(owner);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].kind, 'partner_period');
  assert.equal(anchors[0].anchor_date, '2026-06-29');

  // Die Erinnerungs-ZEILE liegt bei der Partnerperson (created_by), nicht beim
  // Eigentümer - sie ist der Empfänger des Pushs (siehe notifications.js).
  assert.deepEqual(remindersFor(owner, 'cycle_period'), []);
  const partnerReminders = remindersFor(partner, 'cycle_period');
  assert.equal(partnerReminders.length, 1);
  assert.equal(partnerReminders[0].remind_at, '2026-06-27T09:00');
  assert.equal(partnerReminders[0].entity_id, anchors[0].id);
});

test('Partner-Erinnerung entsteht nicht ohne Opt-in (kein notify_partner_user_id/-days_before)', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);

  syncCycleRemindersForUser(db, owner, NOW);
  assert.deepEqual(anchorsFor(owner).filter((a) => a.kind === 'partner_period'), []);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), []);

  // Nur der Empfänger gesetzt, aber kein Vorlauf - genauso kein Opt-in.
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: null });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.deepEqual(anchorsFor(owner).filter((a) => a.kind === 'partner_period'), []);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), []);
});

test('Partner-Erinnerung raeumt ab, wenn der Partner-Verweis geloescht wird', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1);

  upsertSettings(owner, { notify_partner_user_id: null, notify_partner_days_before: null });
  syncCycleRemindersForUser(db, owner, NOW);

  assert.deepEqual(anchorsFor(owner).filter((a) => a.kind === 'partner_period'), []);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), []);
});

test('Partner-Erinnerung raeumt ab, sobald der Eigentuemer in den Schwangerschaftsmodus wechselt', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1);

  upsertSettings(owner, { pregnancy_mode: 1 });
  syncCycleRemindersForUser(db, owner, NOW);

  assert.deepEqual(anchorsFor(owner).filter((a) => a.kind === 'partner_period'), []);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), []);
});

test('Partner-Erinnerung bleibt bestehen, wenn die Partnerperson selbst den Zyklus-Tab abgeschaltet hat - Health-Zugriff allein entscheidet', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1);

  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, '0')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`health_cycle_enabled:user:${partner}`);

  // Anders als vorher: die Partnerperson hat selbst keinen Zyklus und darum
  // ihren eigenen Zyklus-Tab abgeschaltet - genau das ist der haeufigste Fall
  // und darf sie nicht von der Meldung ausschliessen. Health-Zugriff allein
  // entscheidet (isEligibleCyclePartner()).
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1, 'die Erinnerung bleibt trotz abgeschaltetem eigenen Zyklus-Tab bestehen');

  db.prepare("DELETE FROM sync_config WHERE key = ?").run(`health_cycle_enabled:user:${partner}`);
});

test('Partner-Erinnerung raeumt ab, wenn der Partnerperson das Health-Modul entzogen wird', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1);

  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'health', 'none')
  `).run(String(partner));

  syncCycleRemindersForUser(db, owner, NOW);
  assert.deepEqual(anchorsFor(owner).filter((a) => a.kind === 'partner_period'), []);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), []);
});

test('Verwaiste Partner-Erinnerung wird beim Voll-Sync geloescht, wenn der Eigentuemer geloescht wurde', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);
  assert.equal(remindersFor(partner, 'cycle_period').length, 1);

  // Ein Admin loescht den Eigentuemer direkt (kein API-Aufruf noetig fuer
  // diesen Test) - die Anker-Zeile faellt per ON DELETE CASCADE mit weg, die
  // reminders-Zeile (gehoert der Partnerperson, kein Fremdschluessel auf
  // entity_id) aber nicht: genau der verwaiste Zustand, den syncAllCycleReminders
  // abraeumen muss.
  db.prepare('DELETE FROM users WHERE id = ?').run(owner);
  assert.deepEqual(anchorsFor(owner), [], 'die Anker-Zeile ist per CASCADE weg');
  assert.equal(remindersFor(partner, 'cycle_period').length, 1, 'die reminders-Zeile ist noch da - verwaist');

  syncAllCycleReminders(db, NOW);
  assert.deepEqual(remindersFor(partner, 'cycle_period'), [], 'der Voll-Sync raeumt die verwaiste Erinnerung weg');
});

test('Partner-Erinnerung: der Anker traegt nur ein Datum, keinen Log-Inhalt (Datumsschaerfe)', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);

  const anchor = anchorsFor(owner).find((a) => a.kind === 'partner_period');
  assert.deepEqual(Object.keys(anchor).sort(), ['anchor_date', 'created_at', 'id', 'kind', 'user_id'].sort());
  assert.match(anchor.anchor_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('Partner-Erinnerung ist idempotent: ein zweiter Lauf ohne Aenderung laesst die Zeile unangetastet', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);

  const before = remindersFor(partner, 'cycle_period')[0];
  db.prepare('UPDATE reminders SET pushed_at = ?, dismissed = 1 WHERE id = ?').run('2026-06-27T09:05:00Z', before.id);

  syncCycleRemindersForUser(db, owner, NOW);

  const after = remindersFor(partner, 'cycle_period')[0];
  assert.equal(after.id, before.id, 'die Zeile wurde ersetzt statt unangetastet zu bleiben');
  assert.equal(after.pushed_at, '2026-06-27T09:05:00Z');
  assert.equal(after.dismissed, 1);
});

test('Partner-Wechsel bei gleichem Vorlauf: die Erinnerung geht auf den NEUEN Empfaenger ueber (Privatsphaere, Befund 1)', () => {
  const owner = makeUser();
  const partnerA = makeUser();
  const partnerB = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partnerA, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);

  // Ausgangslage: A traegt die Zeile.
  const beforeA = remindersFor(partnerA, 'cycle_period');
  assert.equal(beforeA.length, 1);
  assert.equal(beforeA[0].created_by, partnerA);

  // Wechsel auf B, Vorlauf bleibt UNVERAENDERT (2 Tage) - genau der Fall, in
  // dem die alte Fassung von upsertCycleReminder() nur remind_at verglich und
  // deshalb frueh zurueckkehrte, ohne created_by je anzusehen: die Zeile blieb
  // bei A stehen, B bekam nie eine.
  upsertSettings(owner, { notify_partner_user_id: partnerB, notify_partner_days_before: 2 });
  syncCycleRemindersForUser(db, owner, NOW);

  // Nur GENAU EINE Zeile insgesamt, und die gehoert B - A darf nichts mehr
  // tragen (sonst bekaeme eine Ex-Partnerperson weiter den Perioden-Push).
  assert.deepEqual(remindersFor(partnerA, 'cycle_period'), [], 'die alte Empfaengerin A traegt keine Zeile mehr');
  const afterB = remindersFor(partnerB, 'cycle_period');
  assert.equal(afterB.length, 1, 'genau eine Zeile fuer die neue Empfaengerin B');
  assert.equal(afterB[0].created_by, partnerB);

  // Derselbe Anker (Eigentuemer-Datum unveraendert) - nur der Empfaenger der
  // reminders-Zeile hat sich geaendert, kein zweiter Anker ist entstanden.
  const anchors = anchorsFor(owner).filter((a) => a.kind === 'partner_period');
  assert.equal(anchors.length, 1);
  assert.equal(afterB[0].entity_id, anchors[0].id);
});

test('syncAllCycleReminders erreicht einen Eigentuemer, der nur eine Partner-Einstellung traegt (kein eigener Vorlauf)', () => {
  const owner = makeUser();
  const partner = makeUser();
  seedFourPeriods(owner);
  upsertSettings(owner, { notify_partner_user_id: partner, notify_partner_days_before: 1 });

  syncAllCycleReminders(db, NOW);

  assert.equal(remindersFor(partner, 'cycle_period').length, 1);
});
