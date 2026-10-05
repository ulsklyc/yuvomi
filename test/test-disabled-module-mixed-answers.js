/**
 * Test: Mischstellen folgen dem Haushaltsschalter (#1660, docs/DECISIONS.md 11)
 *
 * Zweck: `disabled_modules` heisst "der Haushalt nutzt dieses Modul nicht". Es
 *        ist keine Sperre - die eigenen Routen eines Moduls bleiben offen -,
 *        aber was der Server UNGEFRAGT in eine gemischte Antwort legt, folgt dem
 *        Schalter. Gemessen gegen main lieferte die Uebersicht bei zehn
 *        abgeschalteten Modulen weiter Termine, Aufgaben, Buchungen und
 *        Medikamente, und die Geburtstage standen im Kalender, in der Uebersicht
 *        und im Kalender-Feed, obwohl der Haushalt sie abgeschaltet hatte.
 *
 *        Diese Suite misst die Geburtstags-Einblendung ueber die echten Router
 *        (Geburtstag anlegen -> sein Kalendertermin entsteht ueber den echten
 *        Schreibweg) und haelt beide Haelften der Regel fest: die Mischstelle
 *        laesst aus, die eigene Route antwortet weiter. Die Uebersicht je Modul
 *        steht in test-dashboard-permissions.js, neben der Rechte-Achse.
 *
 * Zeit: die Zone ist auf UTC gesetzt und "heute" kommt aus `todayKey()` des
 *       Servers, nie aus `toISOString()`; der Geburtstag liegt fuenf Tage voraus
 *       und damit weit genug von jeder Tagesgrenze.
 *
 * Ausfuehren: npm run test:disabled-module-mixed-answers
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'disabled-module-mixed-answers-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { buildFeed } = await import('../server/services/ics-export.js');
const { getCountdowns } = await import('../server/services/countdowns.js');
const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');
const { searchEverything } = await import('../server/services/search.js');
const householdModules = await import('../server/services/household-modules.js');
const { todayKey } = await import('../server/utils/timezone.js');

const moduleDatabase = get();
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const m of MIGRATIONS) {
  if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
  if (typeof m.afterUp === 'function') m.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
}
_setTestDatabase(db);
moduleDatabase.close();

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

function setDisabled(modules) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(modules));
}
// Migrationen schalten Module ab Werk ab (Inventar, Schichtplan, Entsorgung);
// jeder Test stellt seinen Zustand selbst her und raeumt ihn wieder weg.
setDisabled([]);

const ADMIN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES ('admin', 'Admin', 'hash', '#007AFF', 'admin', 'parent')
`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.session = { userId: ADMIN, role: 'admin' };
  req.sessionModuleAccess = null;
  req.authScopes = null;
  next();
});
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/birthdays', birthdaysRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); db.close(); });

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

const TODAY = todayKey(db);
const FROM = shiftKey(TODAY, -1);
const TO = shiftKey(TODAY, 30);
const BIRTHDAY_NAME = 'Zebrafink Tante';
const EVENT_TITLE = 'Zebrafink Zahnarzt';

// Die Saat ueber die ECHTEN Schreibwege: der Geburtstag legt seinen
// Kalendertermin selbst an (syncBirthdayArtifacts), niemand schreibt die
// Verknuepfung hier von Hand nach.
const createdBirthday = await call('POST', '/birthdays', {
  name: BIRTHDAY_NAME, birth_date: `1980-${shiftKey(TODAY, 5).slice(5)}`,
});
const createdEvent = await call('POST', '/calendar', {
  title: EVENT_TITLE, start_datetime: `${shiftKey(TODAY, 3)}T10:00:00`, countdown: true,
});

const isBirthday = (event) => Boolean(event.birthday_name);
const titles = (events) => events.map((e) => e.title);

async function snapshot() {
  const calendar = (await call('GET', `/calendar?from=${FROM}&to=${TO}`)).body.data;
  const upcoming = (await call('GET', '/calendar/upcoming?limit=20')).body.data;
  const search = (await call('GET', '/calendar/search?q=Zebrafink')).body;
  const dashboard = (await call('GET', '/dashboard')).body;
  const feed = buildFeed(db, ADMIN);
  return { calendar, upcoming, search, dashboard, feed };
}

test('Vorbedingung: mit eingeschalteten Modulen steht der Geburtstag an jeder Mischstelle', async () => {
  assert.equal(createdBirthday.status, 201);
  assert.equal(createdEvent.status, 201);
  setDisabled([]);
  const s = await snapshot();

  assert.equal(s.calendar.filter(isBirthday).length, 1, 'GET /calendar traegt den Geburtstagstermin');
  assert.ok(titles(s.calendar).includes(EVENT_TITLE));
  assert.equal(s.upcoming.filter(isBirthday).length, 1, 'GET /calendar/upcoming ebenso');
  assert.equal(s.search.data.filter(isBirthday).length, 1, 'die Terminsuche ebenso');
  assert.equal(s.search.total, 2);
  assert.equal(s.dashboard.upcomingEvents.filter(isBirthday).length, 1, 'die Termine der Uebersicht ebenso');
  assert.equal(s.dashboard.weekEvents.filter(isBirthday).length, 1, 'der Wochenstreifen ebenso');
  assert.equal(s.dashboard.birthdays[0]?.name, BIRTHDAY_NAME, 'die Geburtstags-Kachel');
  assert.equal(s.dashboard.birthdayCount, 1);
  assert.ok(s.feed.includes(BIRTHDAY_NAME), 'der Kalender-Feed traegt den Geburtstag');
  assert.ok(s.feed.includes(EVENT_TITLE));
});

test('Geburtstage abgeschaltet: Kalender, Uebersicht und Feed liefern sie nicht mehr mit, der Kalender selbst bleibt', async () => {
  try {
    setDisabled(['birthdays']);
    const s = await snapshot();
    const wire = JSON.stringify([s.calendar, s.upcoming, s.search, s.dashboard]);

    assert.deepEqual(s.calendar.filter(isBirthday), [], 'GET /calendar ohne Geburtstagstermin');
    assert.deepEqual(s.upcoming.filter(isBirthday), [], 'GET /calendar/upcoming ohne');
    assert.deepEqual(s.search.data.filter(isBirthday), [], 'die Terminsuche ohne');
    assert.equal(s.search.total, 1, 'und die Trefferzahl zaehlt ihn nicht mit');
    assert.deepEqual(s.dashboard.upcomingEvents.filter(isBirthday), []);
    assert.deepEqual(s.dashboard.weekEvents.filter(isBirthday), []);
    assert.deepEqual(s.dashboard.familyEvents.filter(isBirthday), []);
    assert.deepEqual(s.dashboard.birthdays, [], 'die Kachel ist leer');
    assert.equal(s.dashboard.birthdayCount, 0);
    assert.equal(s.dashboard.birthdayTotal, 0);
    assert.equal(s.dashboard.birthdaySoonCount, 0);
    assert.ok(!wire.includes(BIRTHDAY_NAME), 'der Name steht nirgends mehr in einer der Antworten');
    assert.ok(!s.feed.includes(BIRTHDAY_NAME), 'und nicht im Feed');

    // Die andere Haelfte: der Kalender verliert nichts Eigenes.
    assert.ok(titles(s.calendar).includes(EVENT_TITLE), 'der Termin des Kalenders bleibt');
    assert.ok(titles(s.upcoming).includes(EVENT_TITLE));
    assert.ok(titles(s.dashboard.upcomingEvents).includes(EVENT_TITLE));
    assert.ok(s.feed.includes(EVENT_TITLE));
  } finally {
    setDisabled([]);
  }

  const back = await snapshot();
  assert.equal(back.calendar.filter(isBirthday).length, 1, 'wieder an: der Termin ist wieder da');
  assert.equal(back.dashboard.birthdays[0]?.name, BIRTHDAY_NAME);
  assert.ok(back.feed.includes(BIRTHDAY_NAME));
});

test('Geburtstage abgeschaltet ist keine Sperre: die eigenen Routen des Moduls antworten weiter', async () => {
  try {
    setDisabled(['birthdays']);
    const list = await call('GET', '/birthdays');
    assert.equal(list.status, 200);
    assert.equal(list.body.data[0]?.name, BIRTHDAY_NAME);
    const upcoming = await call('GET', '/birthdays/upcoming');
    assert.equal(upcoming.status, 200);
    assert.equal(upcoming.body.data.length, 1);

    // Auch der einzelne Termin bleibt ueber seine Adresse erreichbar.
    const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE name = ?').get(BIRTHDAY_NAME).id;
    const single = await call('GET', `/calendar/${eventId}`);
    assert.equal(single.status, 200);
  } finally {
    setDisabled([]);
  }
});

test('Kalender abgeschaltet, Geburtstage an: die Uebersicht laesst die Termine aus und behaelt die Geburtstags-Kachel', async () => {
  try {
    setDisabled(['calendar']);
    const s = await snapshot();

    assert.deepEqual(s.dashboard.upcomingEvents, []);
    assert.deepEqual(s.dashboard.weekEvents, []);
    assert.deepEqual(s.dashboard.familyEvents, []);
    assert.equal(s.dashboard.birthdays[0]?.name, BIRTHDAY_NAME, 'Geburtstage folgen ihrem eigenen Schalter');
    assert.equal(s.dashboard.birthdayCount, 1);

    // Keine Sperre: die Route des Kalenders und sein Feed antworten wie zuvor.
    assert.ok(titles(s.calendar).includes(EVENT_TITLE), 'GET /calendar bleibt offen');
    assert.equal(s.calendar.filter(isBirthday).length, 1);
    assert.ok(s.feed.includes(EVENT_TITLE), 'der Feed ist die eigene Ausgabe des Kalenders');
  } finally {
    setDisabled([]);
  }
});

test('Beide abgeschaltet: die Uebersicht traegt weder Termin noch Geburtstag', async () => {
  try {
    setDisabled(['calendar', 'birthdays']);
    const { dashboard } = await snapshot();
    assert.deepEqual(dashboard.upcomingEvents, []);
    assert.deepEqual(dashboard.birthdays, []);
    assert.equal(dashboard.birthdayCount, 0);
    assert.ok(!JSON.stringify(dashboard).includes('Zebrafink'));
  } finally {
    setDisabled([]);
  }
});

test('Die abgeloeste Einzelinstanz einer Geburtstagsserie laeuft bei abgeschalteten Geburtstagen nicht mit', async () => {
  // Eine Serieninstanz, die jemand einzeln geaendert hat, ist eine eigene Zeile
  // mit `recurrence_parent_id`; auf sie zeigt `birthdays` nicht. Wuerde nur die
  // Stammzeile erkannt, bliebe sie als einziger Geburtstag im Kalender stehen.
  const master = db.prepare(`
    SELECT e.* FROM calendar_events e JOIN birthdays b ON b.calendar_event_id = e.id WHERE b.name = ?
  `).get(BIRTHDAY_NAME);
  const day = shiftKey(TODAY, 5);
  const childId = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, created_by, recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run('Zebrafink verschobene Feier', `${day}T00:00:00`, ADMIN, master.id, day, '["title"]').lastInsertRowid;

  try {
    const open = (await call('GET', `/calendar?from=${FROM}&to=${TO}`)).body.data;
    assert.ok(titles(open).includes('Zebrafink verschobene Feier'), 'Vorbedingung: eingeschaltet steht die Instanz im Kalender');

    setDisabled(['birthdays']);
    const off = (await call('GET', `/calendar?from=${FROM}&to=${TO}`)).body.data;
    assert.ok(!titles(off).includes('Zebrafink verschobene Feier'));
    assert.ok(!buildFeed(db, ADMIN).includes('Zebrafink verschobene Feier'));
    assert.ok(titles(off).includes(EVENT_TITLE));

    // Dieselbe Zeile ueber den GETEILTEN Leser (Codex-Befund in #1664): er
    // erkannte Geburtstage nur am Join der Stammzeile, die Instanz kam durch.
    const s = await snapshot();
    const everywhere = JSON.stringify([s.upcoming, s.search, s.dashboard]);
    assert.ok(!everywhere.includes('Zebrafink verschobene Feier'),
      'auch nicht in /calendar/upcoming, der Terminsuche und der Uebersicht');
  } finally {
    setDisabled([]);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(childId);
  }
});

test('modulesLeftOut(): beide Achsen in einem Set, und die Countdowns lesen genau dieses', () => {
  try {
    setDisabled(['budget', 'birthdays']);
    assert.deepEqual(
      [...householdModules.modulesLeftOut(db, new Set(['tasks']))].sort(),
      ['birthdays', 'budget', 'tasks'],
    );
    assert.deepEqual([...householdModules.modulesLeftOut(db)].sort(), ['birthdays', 'budget']);
    assert.equal(householdModules.birthdaysSwitchedOff(db), true);

    setDisabled(['calendar']);
    assert.equal(householdModules.birthdaysSwitchedOff(db), false, 'der Kalender-Schalter ist nicht der Geburtstags-Schalter');
    const countdowns = getCountdowns(db, { userId: ADMIN, todayKey: TODAY, hiddenModules: new Set() });
    assert.deepEqual(countdowns.items.filter((c) => c.title === EVENT_TITLE), [], 'der Termin-Countdown faellt mit dem Kalender');
  } finally {
    setDisabled([]);
  }
  const countdowns = getCountdowns(db, { userId: ADMIN, todayKey: TODAY, hiddenModules: new Set() });
  assert.equal(countdowns.items.filter((c) => c.title === EVENT_TITLE).length, 1);
});

test('Der geteilte Leser kennt den Schalter selbst: ein Aufrufer, der nicht fragt, bekommt trotzdem keine Geburtstage', () => {
  // Genau der Aufruf des MCP-Werkzeugs `list_upcoming_events` (server/mcp/tools.js):
  // ohne `includeBirthdays`. Stuende der Schalter nur bei den Aufrufern, lieferte
  // jeder weiter aus, der die Frage vergisst (Codex-Befund in #1664).
  const asMcp = () => getUpcomingEvents(db, { userId: ADMIN, limit: 20, windowDays: null, fromToday: true });
  assert.ok(asMcp().some(isBirthday), 'Vorbedingung: eingeschaltet liefert der Leser den Geburtstag');
  try {
    setDisabled(['birthdays']);
    const events = asMcp();
    assert.deepEqual(events.filter(isBirthday), []);
    assert.ok(titles(events).includes(EVENT_TITLE), 'der Termin des Kalenders bleibt');
  } finally {
    setDisabled([]);
  }
});

test('Globale Suche: Geburtstage abgeschaltet, Kalender an - der Geburtstagstermin steht nicht unter den Terminen', () => {
  const search = () => searchEverything(db, 'Zebrafink', ADMIN, {
    hiddenModules: new Set(), disabledNav: householdModules.householdDisabledModules(db),
  });
  const open = search();
  assert.equal(open.events.length, 2, 'Vorbedingung: Termin und Geburtstagstermin');
  assert.equal(open.birthdays.length, 1);
  try {
    setDisabled(['birthdays']);
    const off = search();
    assert.deepEqual(off.events.map((e) => e.title), [EVENT_TITLE], 'nur der Termin des Kalenders');
    assert.deepEqual(off.birthdays, []);
  } finally {
    setDisabled([]);
  }
});

test('Countdown: ein als Countdown markierter Geburtstagstermin folgt dem Schalter `birthdays`', async () => {
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE name = ?').get(BIRTHDAY_NAME).id;
  db.prepare('UPDATE calendar_events SET countdown = 1 WHERE id = ?').run(eventId);
  // Termin- und Aufgaben-Ids teilen sich keinen Nummernkreis: nur mit der Quelle eindeutig.
  const carries = (body) => body.countdowns.some((c) => c.source === 'event' && c.id === eventId);
  try {
    assert.ok(carries((await call('GET', '/dashboard')).body), 'Vorbedingung: eingeschaltet zaehlt er herunter');
    setDisabled(['birthdays']);
    const body = (await call('GET', '/dashboard')).body;
    assert.ok(!carries(body), 'abgeschaltet nicht mehr');
    assert.equal(body.countdownTotal, 1, 'und die Gesamtzahl zaehlt ihn nicht mit - der Termin-Countdown bleibt');
  } finally {
    setDisabled([]);
    db.prepare('UPDATE calendar_events SET countdown = 0 WHERE id = ?').run(eventId);
  }
});

test('birthdaysSwitchedOff(): ohne Einstellungstabelle gibt es keinen Schalter, jeder andere Fehler bleibt laut', () => {
  // Der geteilte Termin-Leser stellt die Frage bei jedem Aufruf. Suiten mit
  // handgebautem Schema (test-dashboard.js, test-ics-export.js) haben die
  // Tabelle nicht - genau daran fiel die CI in #1664.
  const bare = new Database(':memory:');
  assert.equal(householdModules.birthdaysSwitchedOff(bare), false);
  bare.close();
  assert.throws(() => householdModules.birthdaysSwitchedOff(bare), 'eine geschlossene Verbindung ist kein "nicht abgeschaltet"');
});
