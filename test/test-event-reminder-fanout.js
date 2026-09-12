/**
 * Test: Erinnerungen an geteilten Terminen (Discussion #921)
 *
 * Gemeldet war: eine Frau legt einen Termin an, weist ihn beiden zu und setzt
 * eine Erinnerung. Sie bekommt sie, ihr Mann bekommt nichts, und wenn er
 * denselben Termin oeffnet, steht das Feld LEER da. Der Termin wurde verpasst.
 *
 * Geprueft wird deshalb nicht nur, DASS verteilt wird, sondern vor allem, was
 * dabei NICHT passieren darf:
 *  - eine selbst gesetzte Erinnerung wird nie ueberschrieben
 *  - eine verworfene kommt nicht wieder
 *  - wer nicht mehr zugewiesen ist, behaelt keine geerbte Meldung
 *  - wer NICHT der Ersteller ist, verteilt beim Setzen gar nichts
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-event-reminder-fanout.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { setEventAssignments } = await import('../server/routes/calendar/helpers.js');
const { fanOutEventReminders } = await import('../server/services/event-reminder-fanout.js');
const database = dbmod.get();

const mkUser = (name) => database
  .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')")
  .run(name, name).lastInsertRowid;

const ANNA = mkUser('anna');   // legt Termine an
const BEN  = mkUser('ben');    // wird zugewiesen
const CLEO = mkUser('cleo');   // ebenfalls

let actingUser = ANNA;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actingUser;
  req.authRole   = 'member';
  req.session    = { userId: actingUser, role: 'member' };
  next();
});
app.use('/', remindersRouter);
const server  = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

/** Ein Termin von ANNA, zugewiesen an die genannten Personen. */
function newEvent(assignees = []) {
  const id = database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, visibility)
    VALUES ('Zahnarzt', '2026-09-01T10:00:00', '2026-09-01T11:00:00', ?, 'all')
  `).run(ANNA).lastInsertRowid;
  if (assignees.length) setEventAssignments(database, id, assignees);
  return id;
}

const remindersOf = (eventId, userId) => database.prepare(`
  SELECT remind_at, assigned_from, dismissed FROM reminders
  WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  ORDER BY remind_at ASC
`).all(eventId, userId);

const setReminders = (eventId, remindAts) =>
  call('PUT', `/?entity_type=event&entity_id=${eventId}`, { remind_ats: remindAts });

// --------------------------------------------------------------------------
// Der gemeldete Fall
// --------------------------------------------------------------------------

test('die Erinnerung der Erstellerin erreicht die Zugewiesenen', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  assert.equal(remindersOf(id, ANNA).length, 1, 'die Erstellerin behaelt ihre eigene');
  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'der Zugewiesene bekommt eine - genau das fehlte');
  assert.equal(bens[0].remind_at, '2026-08-31T10:00:00');
  assert.equal(bens[0].assigned_from, ANNA, 'sie ist als geerbt gekennzeichnet');
});

test('der Zugewiesene SIEHT sie auch - das leere Feld war der halbe Schaden', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  actingUser = BEN;
  const r = await call('GET', `/all?entity_type=event&entity_id=${id}`);
  actingUser = ANNA;
  assert.equal(r.body.data.length, 1,
    'GET /all filtert auf created_by - ohne eigene Zeile blieb das Feld leer und las sich als "keine gesetzt"');
});

test('mehrere Zugewiesene bekommen alle Zeitpunkte', async () => {
  const id = newEvent([ANNA, BEN, CLEO]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00', '2026-09-01T09:00:00']);

  assert.equal(remindersOf(id, BEN).length, 2);
  assert.equal(remindersOf(id, CLEO).length, 2);
});

// --------------------------------------------------------------------------
// Was NICHT passieren darf
// --------------------------------------------------------------------------

test('eine selbst gesetzte Erinnerung wird nicht ueberschrieben', async () => {
  const id = newEvent([ANNA, BEN]);
  // Ben stellt sich seine eigene - er faehrt weiter und braucht mehr Vorlauf.
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);

  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'seine bleibt die einzige');
  assert.equal(bens[0].remind_at, '2026-08-30T06:00:00', 'und behaelt seine Uhrzeit');
  assert.equal(bens[0].assigned_from, null, 'sie ist seine, nicht geerbt');
});

test('allgemeiner fan-out lässt alte geerbte Zeilen neben einer eigenen unangetastet', () => {
  const id = newEvent([ANNA, BEN]);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, '2026-08-31T10:00:00', ?, NULL)
  `).run(id, ANNA);
  fanOutEventReminders(database, id, ANNA);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, '2026-08-30T06:00:00', ?, NULL)
  `).run(id, BEN);

  fanOutEventReminders(database, id, ANNA);
  assert.equal(remindersOf(id, BEN).length, 2, 'obecný caller nesmí měnit historické chování');

  fanOutEventReminders(database, id, ANNA, { dropDerivedWhenOwn: true });
  const scoped = remindersOf(id, BEN);
  assert.equal(scoped.length, 1, 'occurrence reconciliation smí odstranit odvozenou duplicitu');
  assert.equal(scoped[0].assigned_from, null);
});

test('eine verworfene Erinnerung kommt nicht zurueck', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  // Ben hat sie gesehen und weggewischt.
  const bensId = database.prepare(
    "SELECT id FROM reminders WHERE entity_type='event' AND entity_id=? AND created_by=?"
  ).get(id, BEN).id;
  database.prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(bensId);

  // Anna speichert den Termin erneut mit derselben Erinnerung.
  await setReminders(id, ['2026-08-31T10:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'keine zweite Meldung fuer dasselbe');
  assert.equal(bens[0].dismissed, 1, 'die verworfene bleibt verworfen');
});

test('eine GEAENDERTE Uhrzeit erreicht ihn auch nach dem Verwerfen', async () => {
  // Die Gegenprobe zum Test darueber: verworfen heisst "diese Meldung habe ich
  // gesehen", nicht "fuer diesen Termin will ich nichts mehr wissen". Eine
  // andere Uhrzeit ist eine andere Auskunft.
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  database.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type='event' AND entity_id=? AND created_by=?
  `).run(id, BEN);

  await setReminders(id, ['2026-08-31T08:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1);
  assert.equal(bens[0].remind_at, '2026-08-31T08:00:00', 'die neue Zeit kommt an');
  assert.equal(bens[0].dismissed, 0, 'und zwar als frische, ungesehene Meldung');
});

test('wer NICHT der Ersteller ist, verteilt beim Setzen nichts', async () => {
  const id = newEvent([ANNA, BEN, CLEO]);
  // Ben setzt sich einen Merker. Das ist seine Sache und geht Cleo nichts an -
  // sonst bekaeme der halbe Haushalt eine Meldung, weil ein Einzelner sich
  // etwas notiert hat.
  actingUser = BEN;
  await setReminders(id, ['2026-08-31T10:00:00']);
  actingUser = ANNA;

  assert.equal(remindersOf(id, CLEO).length, 0);
  assert.equal(remindersOf(id, ANNA).length, 0);
});

test('loescht die Erstellerin ihre Erinnerung, verschwinden die geerbten mit', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 1);

  await setReminders(id, []);
  assert.equal(remindersOf(id, BEN).length, 0,
    'eine Meldung stehen zu lassen, die die Erstellerin gerade abgeschafft hat, waere eine Zusage ohne Deckung');
});

test('eine selbst gesetzte ueberlebt das Loeschen durch die Erstellerin', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  await setReminders(id, []);

  assert.equal(remindersOf(id, BEN).length, 1, 'Bens eigene geht Anna nichts an');
});

// --------------------------------------------------------------------------
// Die andere Richtung: die Zuweisung aendert sich
// --------------------------------------------------------------------------

test('wer nachtraeglich zugewiesen wird, bekommt die Erinnerung mit', async () => {
  const id = newEvent([ANNA]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 0, 'noch nicht zugewiesen, also nichts');

  setEventAssignments(database, id, [ANNA, BEN]);
  assert.equal(remindersOf(id, BEN).length, 1,
    'eine Zuweisung, die die Erinnerung nicht mitbringt, aeussert sich als verpasster Termin');
});

test('wer nicht mehr zugewiesen ist, behaelt keine geerbte Meldung', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 1);

  setEventAssignments(database, id, [ANNA]);
  assert.equal(remindersOf(id, BEN).length, 0,
    'eine Erinnerung an einen Termin, mit dem man nichts mehr zu tun hat, ist eine Meldung ohne Anlass');
});

test('eine selbst gesetzte ueberlebt auch das Entfernen der Zuweisung', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);
  actingUser = ANNA;

  setEventAssignments(database, id, [ANNA]);
  assert.equal(remindersOf(id, BEN).length, 1,
    'wer sich selbst eine gestellt hat, hat einen eigenen Grund - den kennt der Termin nicht');
});

test('ein Termin ohne weitere Zugewiesene aendert nichts', async () => {
  const id = newEvent([ANNA]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, ANNA).length, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) n FROM reminders WHERE entity_type='event' AND entity_id=?").get(id).n,
    1, 'genau eine Zeile - kein Fanout ins Leere');
});

// --------------------------------------------------------------------------
// Die Herkunft anderer Module bleibt unberuehrt
// --------------------------------------------------------------------------

test('Aufgaben-Erinnerungen werden nicht verteilt', async () => {
  const taskId = database
    .prepare("INSERT INTO tasks (title, created_by, visibility) VALUES ('T', ?, 'all')")
    .run(ANNA).lastInsertRowid;
  actingUser = ANNA;
  await call('PUT', `/?entity_type=task&entity_id=${taskId}`, { remind_ats: ['2026-08-31T10:00:00'] });

  const all = database.prepare(
    "SELECT created_by FROM reminders WHERE entity_type='task' AND entity_id=?"
  ).all(taskId);
  assert.equal(all.length, 1, 'die Regel gilt Terminen - Aufgaben haben ihre eigene Zuweisungslogik');
  assert.equal(all[0].created_by, ANNA);
});

test('assigned_from steht auf NULL, wo niemand geerbt hat', () => {
  const rows = database.prepare(
    "SELECT assigned_from FROM reminders WHERE entity_type='task'"
  ).all();
  for (const r of rows) assert.equal(r.assigned_from, null);
});
