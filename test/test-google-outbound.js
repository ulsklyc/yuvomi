/**
 * Test: ausgehender Google-Sync für Löschungen, Änderungen und Umzüge (#593)
 * Zweck: Der Outbound-Zweig kannte nur `events.insert` für neue lokale Termine.
 *        Wer einen bereits gespiegelten Termin in Yuvomi löschte, bearbeitete oder
 *        in einen anderen Kalender legte, änderte damit nichts mehr in Google (die
 *        Inbound-Richtung funktionierte). Diese Suite deckt alle nachgerüsteten
 *        Richtungen ab:
 *          - Löschen: Tombstone-Anlage (queueEventDeletion) inkl. aller Ausschlüsse,
 *            Abarbeitung (processPendingDeletions) inkl. 404/410, Retry, Aufgabe,
 *            disconnect()-Aufräumen
 *          - Ändern:  Vormerkung (markEventOutbound) nur für gespiegelte Felder,
 *            Push (processPendingUpdates) inkl. Zielkalender-Zeitzone, fehlender
 *            Schreibrechte, 404/410, Retry, Aufgabe
 *          - Umziehen: events.move vor dem Patch, Schreibrecht auf beiden Kalendern,
 *            Nachziehen der lokalen Zuordnung, kein Umzug aus Bestandsdaten
 *          - Inbound darf weder einen gelöschten Termin wiederbeleben noch eine
 *            noch nicht gepushte lokale Änderung überschreiben, und ein cancelled
 *            aus Kalender A darf keine Zeile treffen, die inzwischen zu B gehört
 *          - Serien: Google liefert seit der Umstellung auf singleEvents:false
 *            einen Master mit Wiederholungsregel; Abweichungen werden zu eigenen
 *            Terminen mit EXDATE, und der Altbestand aus der Zeit der
 *            Einzelvorkommen geht beim ersten vollen Abgleich in seiner Serie auf
 *          - DELETE /:id und PUT /:id über den echten Router
 *
 *        Netz-frei: der Google-Client wird als Fake injiziert; GOOGLE_CLIENT_ID &
 *        Co. bleiben ungesetzt, damit der Sofortversuch der Routen beim Client-Bau
 *        abbricht statt zu funken.
 * Ausführen: node --experimental-sqlite --test test/test-google-outbound.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { __test, disconnect } = await import('../server/services/google-calendar.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

// ── Fixtures ────────────────────────────────────────────────────────────────────
function connect() {
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_access_token','a')").run();
  db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('google_refresh_token','r')").run();
}

function reset() {
  db.prepare('DELETE FROM calendar_pending_deletions').run();
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM external_calendars').run();
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'google_%'").run();
  connect();
}

let seq = 0;
/** Legt ein aus Google stammendes (bzw. dorthin gespiegeltes) Event an. */
function insertGoogleEvent({ calRefId = null, googleId = `gev-${++seq}`, target = null, ...fields } = {}) {
  const f = {
    title: 'Termin', start_datetime: '2035-03-10T09:00', end_datetime: '2035-03-10T10:00',
    all_day: 0, description: null, location: null, color: '#4285F4', recurrence_rule: null,
    ...fields,
  };
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, color,
       recurrence_rule, external_calendar_id, external_source,
       calendar_ref_id, target_google_calendar_id, created_by)
    VALUES (@title, @description, @start_datetime, @end_datetime, @all_day, @location, @color,
       @recurrence_rule, @googleId, 'google', @calRefId, @target, 1)
  `).run({ ...f, googleId, calRefId, target });
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(r.lastInsertRowid);
}

function reload(id) {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}

function tombstones() {
  return db.prepare('SELECT * FROM calendar_pending_deletions ORDER BY id').all();
}

/**
 * Google-Client-Attrappe: zeichnet Aufrufe auf, wirft optional.
 * onDelete/onPatch/onMove bestimmen das Verhalten je Endpunkt, calendars die
 * Antwort von calendarList.get (fehlender Eintrag = 404, also unzugänglich).
 */
function fakeCalendar({ onDelete, onPatch, onMove, calendars } = {}) {
  const deletes = [];
  const patches = [];
  const moves = [];
  const metaCalls = [];
  return {
    deletes,
    patches,
    moves,
    metaCalls,
    events: {
      delete: async (params) => { deletes.push(params); return onDelete?.(params); },
      patch:  async (params) => { patches.push(params); return onPatch?.(params); },
      move:   async (params) => {
        moves.push(params);
        // Google liefert das verschobene Event zurück; die ID bleibt in der Regel
        // gleich, wird hier aber trotzdem aus der Antwort übernommen.
        return onMove ? onMove(params) : { data: { id: params.eventId } };
      },
    },
    calendarList: {
      get: async ({ calendarId }) => {
        metaCalls.push(calendarId);
        const data = (calendars || {})[calendarId];
        if (!data) throw apiError(404);
        return { data };
      },
    },
  };
}

/** Standard-Metadaten: schreibbarer Kalender in einer festen Zone. */
function writableCalendars(ids = ['primary'], extra = {}) {
  return Object.fromEntries(ids.map((id) => [id, {
    accessRole: 'owner', timeZone: 'Europe/Berlin', summary: id, backgroundColor: '#4285F4', ...extra,
  }]));
}

function apiError(code) {
  const err = new Error(`HTTP ${code}`);
  err.code = code;
  return err;
}

// ── Schema ──────────────────────────────────────────────────────────────────────

test('Migration 103 legt calendar_pending_deletions an', () => {
  const cols = db.prepare('PRAGMA table_info(calendar_pending_deletions)').all().map((c) => c.name);
  for (const c of ['source', 'calendar_external_id', 'event_external_id', 'attempts', 'last_error', 'created_at']) {
    assert.ok(cols.includes(c), `Spalte ${c} fehlt`);
  }
});

test('Migration 104 ergänzt die Outbound-Marker auf calendar_events', () => {
  const cols = db.prepare('PRAGMA table_info(calendar_events)').all();
  for (const name of ['outbound_dirty', 'outbound_attempts']) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `Spalte ${name} fehlt`);
    assert.equal(col.dflt_value, '0', `${name} muss auf 0 defaulten`);
  }
});

test('Migration 105 ergänzt outbound_move_to als NULL-Spalte', () => {
  const col = db.prepare('PRAGMA table_info(calendar_events)').all().find((c) => c.name === 'outbound_move_to');
  assert.ok(col, 'Spalte outbound_move_to fehlt');
  assert.equal(col.notnull, 0, 'muss NULL erlauben (NULL = kein Umzug vorgemerkt)');
  assert.equal(col.dflt_value, null);
});

// ── queueEventDeletion ──────────────────────────────────────────────────────────

test('merkt ein gespiegeltes Event mit der Kalender-ID aus calendar_ref_id vor', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'fam@group.calendar.google.com', 'Familie', '#34A853');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-ref' });

  assert.equal(__test.queueEventDeletion(event), true);

  const rows = tombstones();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'google');
  assert.equal(rows[0].calendar_external_id, 'fam@group.calendar.google.com');
  assert.equal(rows[0].event_external_id, 'gev-ref');
  assert.equal(rows[0].attempts, 0);
});

test('fällt ohne calendar_ref_id auf target_google_calendar_id zurück', () => {
  reset();
  const event = insertGoogleEvent({ googleId: 'gev-target', target: 'primary' });

  assert.equal(__test.queueEventDeletion(event), true);
  assert.equal(tombstones()[0].calendar_external_id, 'primary');
});

test('ohne bekannte Kalender-ID entsteht kein Tombstone', () => {
  reset();
  const event = insertGoogleEvent({ googleId: 'gev-orphan' });

  assert.equal(__test.queueEventDeletion(event), false);
  assert.equal(tombstones().length, 0);
});

test('rein lokale Termine lösen keine Google-Löschung aus', () => {
  reset();
  const r = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, external_source, created_by)
    VALUES ('Lokal', '2035-03-10T09:00', 'local', 1)
  `).run();
  const event = reload(r.lastInsertRowid);

  assert.equal(__test.queueEventDeletion(event), false);
  assert.equal(tombstones().length, 0);
});

test('ohne verbundenes Google-Konto entsteht kein Tombstone', () => {
  reset();
  db.prepare("DELETE FROM sync_config WHERE key = 'google_refresh_token'").run();
  const event = insertGoogleEvent({ googleId: 'gev-off', target: 'primary' });

  assert.equal(__test.queueEventDeletion(event), false);
  assert.equal(tombstones().length, 0);
});

test('im Nur-Lesen-Modus entsteht kein Tombstone', () => {
  reset();
  __test.setReadonly(true);
  const event = insertGoogleEvent({ googleId: 'gev-ro', target: 'primary' });

  assert.equal(__test.queueEventDeletion(event), false);
  assert.equal(tombstones().length, 0);
  __test.setReadonly(false);
});

test('doppeltes Vormerken bleibt bei einem Tombstone (UNIQUE)', () => {
  reset();
  const event = insertGoogleEvent({ googleId: 'gev-dup', target: 'primary' });

  __test.queueEventDeletion(event);
  __test.queueEventDeletion(event);

  assert.equal(tombstones().length, 1);
  assert.equal(__test.pendingDeletionCount(), 1);
});

// ── processPendingDeletions ─────────────────────────────────────────────────────

test('löscht bei Google und entfernt den Tombstone', async () => {
  reset();
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'gev-ok', target: 'primary' }));

  const calendar = fakeCalendar();
  assert.equal(await __test.processPendingDeletions(calendar), 1);

  assert.deepEqual(calendar.deletes, [{ calendarId: 'primary', eventId: 'gev-ok' }]);
  assert.equal(tombstones().length, 0);
});

for (const status of [404, 410]) {
  test(`Löschung: ${status} (bei Google bereits weg) zählt als Erfolg`, async () => {
    reset();
    __test.queueEventDeletion(insertGoogleEvent({ googleId: `gev-${status}`, target: 'primary' }));

    const calendar = fakeCalendar({ onDelete: () => { throw apiError(status); } });
    assert.equal(await __test.processPendingDeletions(calendar), 1);
    assert.equal(tombstones().length, 0);
  });
}

test('zählt einen echten Fehler hoch und lässt den Tombstone liegen', async () => {
  reset();
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'gev-500', target: 'primary' }));

  const calendar = fakeCalendar({ onDelete: () => { throw apiError(500); } });
  assert.equal(await __test.processPendingDeletions(calendar), 0);

  const rows = tombstones();
  assert.equal(rows.length, 1, 'Tombstone muss für den nächsten Sync liegen bleiben');
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /500/);
});

test('gibt eine Löschung nach MAX_OUTBOUND_ATTEMPTS auf', async () => {
  reset();
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'gev-hopeless', target: 'primary' }));

  const calendar = fakeCalendar({ onDelete: () => { throw apiError(403); } });
  for (let i = 0; i < __test.MAX_OUTBOUND_ATTEMPTS; i++) {
    await __test.processPendingDeletions(calendar);
  }

  assert.equal(calendar.deletes.length, __test.MAX_OUTBOUND_ATTEMPTS);
  assert.equal(tombstones().length, 0, 'Tombstone muss nach dem Limit verworfen sein');
});

test('arbeitet mehrere Tombstones über verschiedene Kalender ab', async () => {
  reset();
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'a1', target: 'primary' }));
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'b1', target: 'fam@g' }));

  const calendar = fakeCalendar();
  assert.equal(await __test.processPendingDeletions(calendar), 2);
  assert.deepEqual(calendar.deletes.map((c) => c.calendarId), ['primary', 'fam@g']);
  assert.equal(tombstones().length, 0);
});

test('ohne Tombstones wird der Google-Client gar nicht erst angefasst', async () => {
  reset();
  const calendar = fakeCalendar();
  assert.equal(await __test.processPendingDeletions(calendar), 0);
  assert.equal(calendar.deletes.length, 0);
});

// ── markEventOutbound ──────────────────────────────────────────────────────────────

test('markiert ein gespiegeltes Event, wenn ein gespiegeltes Feld sich ändert', () => {
  reset();
  const before = insertGoogleEvent({ googleId: 'gev-edit', target: 'primary' });
  db.prepare("UPDATE calendar_events SET title = 'Neuer Titel' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(before, reload(before.id)), true);
  assert.equal(reload(before.id).outbound_dirty, 1);
  assert.equal(__test.pendingUpdateCount(), 1);
});

test('jedes gespiegelte Feld löst für sich einen Push aus', () => {
  const changes = {
    title: 'Anders', description: 'Text', location: 'Küche', color: '#FF0000',
    all_day: 1, start_datetime: '2035-04-01T08:00', end_datetime: '2035-04-01T09:00',
    recurrence_rule: 'FREQ=WEEKLY',
  };
  assert.deepEqual(Object.keys(changes).sort(), [...__test.MIRRORED_FIELDS].sort(),
    'Testabdeckung und MIRRORED_FIELDS müssen deckungsgleich bleiben');

  for (const [field, value] of Object.entries(changes)) {
    reset();
    const before = insertGoogleEvent({ googleId: `gev-${field}`, target: 'primary' });
    db.prepare(`UPDATE calendar_events SET ${field} = ? WHERE id = ?`).run(value, before.id);

    assert.equal(__test.markEventOutbound(before, reload(before.id)), true, `${field} muss einen Push auslösen`);
  }
});

test('rein lokale Felder (Sichtbarkeit, Icon) lösen keinen Push aus', () => {
  reset();
  const before = insertGoogleEvent({ googleId: 'gev-internal', target: 'primary' });
  db.prepare("UPDATE calendar_events SET visibility = 'private', icon = 'cake' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);
  assert.equal(reload(before.id).outbound_dirty, 0);
});

test('ein rein lokaler Termin wird nie für Google markiert', () => {
  reset();
  const r = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, external_source, created_by)
    VALUES ('Lokal', '2035-03-10T09:00', 'local', 1)
  `).run();
  const before = reload(r.lastInsertRowid);
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);
});

test('ohne Verbindung oder im Nur-Lesen-Modus wird nicht markiert', () => {
  reset();
  const before = insertGoogleEvent({ googleId: 'gev-noconn', target: 'primary' });
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);

  db.prepare("DELETE FROM sync_config WHERE key = 'google_refresh_token'").run();
  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);

  connect();
  __test.setReadonly(true);
  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);
  __test.setReadonly(false);
});

test('erneutes Markieren setzt den Fehlversuchszähler zurück', () => {
  reset();
  const before = insertGoogleEvent({ googleId: 'gev-retry', target: 'primary' });
  db.prepare('UPDATE calendar_events SET outbound_attempts = 3 WHERE id = ?').run(before.id);
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);

  __test.markEventOutbound(before, reload(before.id));
  assert.equal(reload(before.id).outbound_attempts, 0);
});

// ── processPendingUpdates ───────────────────────────────────────────────────────

/** Legt ein gespiegeltes Event an, ändert Felder und markiert es für den Push. */
function seedDirty(fields = {}, googleId = 'gev-push') {
  const before = insertGoogleEvent({ googleId, target: 'primary' });
  const sets = Object.keys(fields).map((f) => `${f} = @${f}`).join(', ');
  if (sets) db.prepare(`UPDATE calendar_events SET ${sets} WHERE id = @id`).run({ ...fields, id: before.id });
  __test.markEventOutbound(before, reload(before.id));
  return reload(before.id);
}

test('pusht die lokale Änderung als events.patch in den richtigen Kalender', async () => {
  reset();
  const event = seedDirty({ title: 'Zahnarzt' });

  const calendar = fakeCalendar({ calendars: writableCalendars() });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 1);

  assert.equal(calendar.patches.length, 1);
  const [patch] = calendar.patches;
  assert.equal(patch.calendarId, 'primary');
  assert.equal(patch.eventId, 'gev-push');
  assert.equal(patch.requestBody.summary, 'Zahnarzt');
  // Zeitzone des Zielkalenders, nicht die des Servers (#572).
  assert.equal(patch.requestBody.start.timeZone, 'Europe/Berlin');
  assert.equal(reload(event.id).outbound_dirty, 0, 'Marker muss nach dem Push weg sein');
});

test('ohne Änderungen wird weder gepatcht noch nach Metadaten gefragt', async () => {
  reset();
  insertGoogleEvent({ googleId: 'gev-clean', target: 'primary' });

  const calendar = fakeCalendar({ calendars: writableCalendars() });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);
  assert.equal(calendar.patches.length, 0);
  assert.equal(calendar.metaCalls.length, 0);
});

test('holt die Kalender-Metadaten je Lauf nur einmal', async () => {
  reset();
  seedDirty({ title: 'A' }, 'gev-m1');
  seedDirty({ title: 'B' }, 'gev-m2');

  const calendar = fakeCalendar({ calendars: writableCalendars() });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 2);
  assert.deepEqual(calendar.metaCalls, ['primary']);
});

test('überspringt Kalender ohne Schreibrecht, ohne den Marker liegen zu lassen', async () => {
  reset();
  const event = seedDirty({ title: 'Nur lesbar' }, 'gev-reader');

  const calendar = fakeCalendar({ calendars: writableCalendars(['primary'], { accessRole: 'reader' }) });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);

  assert.equal(calendar.patches.length, 0);
  assert.equal(reload(event.id).outbound_dirty, 0, 'ein unschreibbares Ziel darf nicht ewig nachlaufen');
});

test('unzugängliche Kalender-Metadaten gelten als nicht schreibbar', async () => {
  reset();
  const event = seedDirty({ title: 'Weg' }, 'gev-nometa');

  const calendar = fakeCalendar({ calendars: {} }); // calendarList.get wirft 404
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);
  assert.equal(calendar.patches.length, 0);
  assert.equal(reload(event.id).outbound_dirty, 0);
});

for (const status of [404, 410]) {
  test(`Änderung: ${status} (Event bei Google gelöscht) verwirft den Marker`, async () => {
    reset();
    const event = seedDirty({ title: 'Weg' }, `gev-u${status}`);

    const calendar = fakeCalendar({
      calendars: writableCalendars(),
      onPatch: () => { throw apiError(status); },
    });
    assert.equal(await __test.processPendingUpdates(calendar, {}), 0);
    assert.equal(reload(event.id).outbound_dirty, 0);
  });
}

test('ein echter Fehler zählt hoch und lässt den Marker stehen', async () => {
  reset();
  const event = seedDirty({ title: 'Fehler' }, 'gev-u500');

  const calendar = fakeCalendar({
    calendars: writableCalendars(),
    onPatch: () => { throw apiError(500); },
  });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);

  const row = reload(event.id);
  assert.equal(row.outbound_dirty, 1, 'der nächste Sync muss es erneut versuchen');
  assert.equal(row.outbound_attempts, 1);
});

test('pusht den Stand zum Zeitpunkt des Aufrufs, nicht den der Auswahl', async () => {
  reset();
  const event = seedDirty({ title: 'Alt' }, 'gev-race');

  // Eine Bearbeitung, die eintrifft, während der Lauf schon auf Google wartet.
  const calendar = fakeCalendar({ calendars: writableCalendars() });
  const originalGet = calendar.calendarList.get;
  calendar.calendarList.get = async (params) => {
    db.prepare("UPDATE calendar_events SET title = 'Ganz neu' WHERE id = ?").run(event.id);
    return originalGet(params);
  };

  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.patches[0].requestBody.summary, 'Ganz neu');
});

test('gibt einen Push nach MAX_OUTBOUND_ATTEMPTS auf', async () => {
  reset();
  const event = seedDirty({ title: 'Aussichtslos' }, 'gev-udead');

  const calendar = fakeCalendar({
    calendars: writableCalendars(),
    onPatch: () => { throw apiError(500); },
  });
  for (let i = 0; i < __test.MAX_OUTBOUND_ATTEMPTS; i++) {
    await __test.processPendingUpdates(calendar, {});
  }

  assert.equal(calendar.patches.length, __test.MAX_OUTBOUND_ATTEMPTS);
  assert.equal(reload(event.id).outbound_dirty, 0);
});

// ── Kalenderwechsel (events.move) ───────────────────────────────────────────────

/** Gespiegeltes Event in Kalender `from`, dessen Ziel per PUT auf `to` wechselt. */
function seedMove(from = 'primary', to = 'fam@g', googleId = 'gev-move') {
  const fromRef = __test.upsertExternalCalendar('google', from, from, '#34A853');
  const before  = insertGoogleEvent({ calRefId: fromRef, googleId, target: from });
  db.prepare('UPDATE calendar_events SET target_google_calendar_id = ? WHERE id = ?').run(to, before.id);
  __test.markEventOutbound(before, reload(before.id));
  return { before, fromRef };
}

test('merkt einen gewechselten Zielkalender als Umzug vor', () => {
  reset();
  const { before } = seedMove();

  const row = reload(before.id);
  assert.equal(row.outbound_move_to, 'fam@g');
  assert.equal(row.outbound_dirty, 0, 'ein reiner Zielwechsel ändert kein gespiegeltes Feld');
  assert.equal(__test.pendingUpdateCount(), 1);
});

test('verschiebt das Event bei Google und zieht die lokale Zuordnung nach', async () => {
  reset();
  const { before } = seedMove();

  const calendar = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g']) });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 1);

  assert.deepEqual(calendar.moves, [{
    calendarId: 'primary', eventId: 'gev-move', destination: 'fam@g',
  }]);
  assert.equal(calendar.patches.length, 0, 'ohne Feldänderung kein zusätzlicher Patch');

  const row = reload(before.id);
  assert.equal(row.outbound_move_to, null);
  // Die lokale Zuordnung muss dem Umzug folgen, sonst ginge ein späteres Löschen
  // an den alten Kalender und der Termin bliebe in Google stehen.
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
});

test('übernimmt eine vom Umzug zurückgegebene neue Event-ID', async () => {
  reset();
  const { before } = seedMove();

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: () => ({ data: { id: 'gev-move-neu' } }),
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(reload(before.id).external_calendar_id, 'gev-move-neu');
});

test('verschiebt zuerst und patcht danach im Zielkalender', async () => {
  reset();
  const { before } = seedMove('primary', 'fam@g', 'gev-move-edit');
  db.prepare("UPDATE calendar_events SET title = 'Umgezogen und umbenannt' WHERE id = ?").run(before.id);
  __test.markEventOutbound(before, reload(before.id));

  const calendar = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g']) });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 1);

  assert.equal(calendar.moves.length, 1);
  assert.equal(calendar.patches.length, 1);
  assert.equal(calendar.patches[0].calendarId, 'fam@g', 'der Patch muss im Zielkalender landen');
  assert.equal(calendar.patches[0].requestBody.summary, 'Umgezogen und umbenannt');
  assert.equal(reload(before.id).outbound_dirty, 0);
});

test('lässt den Termin liegen, wenn der Zielkalender nicht schreibbar ist', async () => {
  reset();
  const { before } = seedMove();

  const calendar = fakeCalendar({
    calendars: {
      ...writableCalendars(['primary']),
      ...writableCalendars(['fam@g'], { accessRole: 'reader' }),
    },
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 0);
  const row = reload(before.id);
  assert.equal(row.outbound_move_to, null, 'die Vormerkung darf nicht ewig nachlaufen');
  assert.equal(__test.currentGoogleCalendarId(row), 'primary', 'der Termin bleibt, wo er ist');
});

test('patcht nicht im alten Kalender, wenn der Umzug scheitert', async () => {
  reset();
  const { before } = seedMove('primary', 'fam@g', 'gev-move-fail');
  db.prepare("UPDATE calendar_events SET title = 'Neu' WHERE id = ?").run(before.id);
  __test.markEventOutbound(before, reload(before.id));

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: () => { throw apiError(500); },
  });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);

  assert.equal(calendar.patches.length, 0, 'sonst stünde die Änderung im falschen Kalender');
  const row = reload(before.id);
  assert.equal(row.outbound_move_to, 'fam@g', 'der nächste Sync versucht es erneut');
  assert.equal(row.outbound_attempts, 1);
});

test('gibt einen von Google abgelehnten Umzug sofort auf (400)', async () => {
  reset();
  const { before } = seedMove('primary', 'fam@g', 'gev-move-400');

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: () => { throw apiError(400); },
  });
  // Ein 400 (z. B. Serieninstanz verschieben) wiederholt sich garantiert.
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);

  assert.equal(calendar.moves.length, 1, 'kein zweiter Versuch');
  assert.equal(reload(before.id).outbound_move_to, null);
});

test('ein aufgegebener Umzug nimmt die Feldänderung nicht mit', async () => {
  reset();
  const { before } = seedMove('primary', 'fam@g', 'gev-move-keep');
  db.prepare("UPDATE calendar_events SET title = 'Trotzdem umbenannt' WHERE id = ?").run(before.id);
  __test.markEventOutbound(before, reload(before.id));

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: () => { throw apiError(400); },
  });
  await __test.processPendingUpdates(calendar, {});

  const row = reload(before.id);
  assert.equal(row.outbound_move_to, null, 'der Umzug ist aufgegeben');
  assert.equal(row.outbound_dirty, 1, 'die Umbenennung muss weiter auf ihren Push warten');

  // Der nächste Lauf schickt sie in den bisherigen Kalender.
  const next = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g']) });
  assert.equal(await __test.processPendingUpdates(next, {}), 1);
  assert.equal(next.moves.length, 0);
  assert.equal(next.patches[0].calendarId, 'primary');
  assert.equal(next.patches[0].requestBody.summary, 'Trotzdem umbenannt');
});

test('Bestandsdaten: ein von Anfang an abweichendes Ziel löst keinen Umzug aus', () => {
  reset();
  // Altbestand: target_google_calendar_id zeigt woanders hin als calendar_ref_id,
  // weil das Feld für gespiegelte Termine bisher folgenlos gesetzt werden konnte.
  const fromRef = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const before  = insertGoogleEvent({ calRefId: fromRef, googleId: 'gev-legacy', target: 'fam@g' });

  // Eine Bearbeitung, die das Ziel NICHT anfasst, darf keinen Umzug erzeugen.
  db.prepare("UPDATE calendar_events SET title = 'Nur umbenannt' WHERE id = ?").run(before.id);
  assert.equal(__test.markEventOutbound(before, reload(before.id)), true);

  const row = reload(before.id);
  assert.equal(row.outbound_move_to, null, 'Altdaten dürfen nicht als Umzugswunsch gelesen werden');
  assert.equal(row.outbound_dirty, 1);
});

test('ein Zielwechsel auf den Kalender, in dem der Termin liegt, ist kein Umzug', () => {
  reset();
  const fromRef = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const before  = insertGoogleEvent({ calRefId: fromRef, googleId: 'gev-same', target: null });
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'primary' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);
  assert.equal(reload(before.id).outbound_move_to, null);
});

// ── Ein widerrufener Umzug ──────────────────────────────────────────────────────
//
// Zwischen Vormerkung und Ausführung liegt mindestens ein Sync-Lauf, und der kann
// scheitern (Google nicht erreichbar, Ziel gerade entzogen). In diesem Fenster darf
// der Nutzer seine Wahl zurücknehmen: markOutbound schreibt das Ziel über COALESCE,
// damit eine Feldänderung einen wartenden Umzug nicht verschluckt - ohne
// ausdrückliches Zurücknehmen kam deshalb keine spätere Wahl mehr dagegen an.

test('nach einem gescheiterten Umzug nimmt die Rückkehr zum aktuellen Kalender ihn zurück', async () => {
  reset();
  const { before } = seedMove();
  const calendars = writableCalendars(['primary', 'fam@g']);
  await __test.processPendingUpdates(
    fakeCalendar({ calendars, onMove: () => { throw apiError(503); } }), {},
  );
  assert.equal(reload(before.id).outbound_move_to, 'fam@g', 'Vorbedingung: der Umzug steht weiter an');

  const current = reload(before.id);
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'primary' WHERE id = ?").run(before.id);
  assert.equal(__test.markEventOutbound(current, reload(before.id)), false, 'es bleibt nichts auszuführen');
  assert.equal(reload(before.id).outbound_move_to, null);

  const calendar = fakeCalendar({ calendars });
  assert.equal(await __test.processPendingUpdates(calendar, {}), 0);
  assert.equal(calendar.moves.length, 0, 'der Termin bleibt in dem Kalender, der gewählt ist');
});

test('ein drittes Ziel ersetzt den wartenden Umzug', () => {
  reset();
  const { before } = seedMove();
  const current = reload(before.id);
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'work@g' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(current, reload(before.id)), true);
  assert.equal(reload(before.id).outbound_move_to, 'work@g', 'der letzte Wunsch gilt');
});

test('eine Feldänderung ohne Zielwechsel lässt den wartenden Umzug stehen', () => {
  // Die Gegenprobe zum Zurücknehmen: nur ein Zielwechsel IM REQUEST darf einen
  // Umzug beenden. Der Zustand allein sagt nichts - sonst verlöre jede andere
  // Bearbeitung den wartenden Umzug.
  reset();
  const { before } = seedMove();
  const current = reload(before.id);
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(current, reload(before.id)), true);
  const row = reload(before.id);
  assert.equal(row.outbound_move_to, 'fam@g');
  assert.equal(row.outbound_dirty, 1);
});

test('ein noch offener Push macht die Rücknahme zum Sofortversuch wert', () => {
  // Der Rückgabewert steuert den Sofortversuch der Route. Er muss den Zustand
  // NACH dem Aufruf melden, nicht nur die Arbeit dieses Aufrufs: bleibt aus einem
  // gescheiterten Versuch ein Push offen, wartete er sonst auf den nächsten Sync.
  reset();
  const { before } = seedMove();
  const renamed = reload(before.id);
  db.prepare("UPDATE calendar_events SET title = 'Anders' WHERE id = ?").run(before.id);
  __test.markEventOutbound(renamed, reload(before.id));
  assert.equal(reload(before.id).outbound_dirty, 1, 'Vorbedingung: ein Push steht an');

  const current = reload(before.id);
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'primary' WHERE id = ?").run(before.id);

  assert.equal(__test.markEventOutbound(current, reload(before.id)), true);
  const row = reload(before.id);
  assert.equal(row.outbound_move_to, null);
  assert.equal(row.outbound_dirty, 1, 'der Push bleibt, nur der Umzug fällt');
});

test('auch im Nur-Lesen-Modus wird ein wartender Umzug zurückgenommen', () => {
  // Zurücknehmen ist eine lokale Buchung und braucht keinen Schreibzugriff. Bliebe
  // der Umzug hier stehen, liefe er nach dem Abschalten des Nur-Lesen-Modus los.
  reset();
  const { before } = seedMove();
  const current = reload(before.id);
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'primary' WHERE id = ?").run(before.id);

  __test.setReadonly(true);
  assert.equal(__test.markEventOutbound(current, reload(before.id)), false, 'kein Sofortversuch, es geht nichts hinaus');
  __test.setReadonly(false);

  assert.equal(reload(before.id).outbound_move_to, null);
});

test('im Nur-Lesen-Modus entsteht dagegen kein neuer Umzug', () => {
  // Die Gegenprobe: der Guard fällt nur für das Zurücknehmen, nicht fürs Vormerken.
  reset();
  const fromRef = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const before  = insertGoogleEvent({ calRefId: fromRef, googleId: 'gev-ro-move', target: 'primary' });
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'fam@g' WHERE id = ?").run(before.id);

  __test.setReadonly(true);
  assert.equal(__test.markEventOutbound(before, reload(before.id)), false);
  __test.setReadonly(false);

  assert.equal(reload(before.id).outbound_move_to, null);
});

// ── Inbound-Schutz ──────────────────────────────────────────────────────────────

function inboundItem(id, summary = 'Termin aus Google') {
  return {
    id, summary, status: 'confirmed',
    start: { dateTime: '2035-03-10T09:00:00Z' },
    end:   { dateTime: '2035-03-10T10:00:00Z' },
  };
}

test('Inbound legt ein Event mit offenem Tombstone nicht wieder an', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-zombie' });
  __test.queueEventDeletion(event);
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(event.id);

  // Full-Resync-Situation: Google liefert das Event noch als aktiv.
  __test.upsertGoogleEvents([inboundItem('gev-zombie')], calRefId);

  const rows = db.prepare("SELECT id FROM calendar_events WHERE external_calendar_id = 'gev-zombie'").all();
  assert.equal(rows.length, 0, 'gelöschter Termin darf nicht zurückkehren');
});

test('Inbound überschreibt eine noch nicht gepushte lokale Änderung nicht', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const before = insertGoogleEvent({ calRefId, googleId: 'gev-conflict' });
  db.prepare("UPDATE calendar_events SET title = 'Lokal geändert' WHERE id = ?").run(before.id);
  __test.markEventOutbound(before, reload(before.id));

  __test.upsertGoogleEvents([inboundItem('gev-conflict', 'Alter Google-Titel')], calRefId);

  assert.equal(reload(before.id).title, 'Lokal geändert');
  assert.equal(reload(before.id).outbound_dirty, 1, 'der Push steht weiter aus');
});

test('Inbound aktualisiert ein Event ohne offene Änderung normal', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-normal' });

  __test.upsertGoogleEvents([inboundItem('gev-normal', 'Neuer Google-Titel')], calRefId);

  assert.equal(reload(event.id).title, 'Neuer Google-Titel');
});

test('ein cancelled aus dem Quellkalender löscht kein Event, das inzwischen woanders liegt', () => {
  reset();
  const aRef = __test.upsertExternalCalendar('google', 'kalender-a', 'A', '#34A853');
  const bRef = __test.upsertExternalCalendar('google', 'kalender-b', 'B', '#4285F4');
  // In Google von A nach B verschoben: B führt das Event bereits, A meldet es
  // im selben Lauf als cancelled - mit derselben Event-ID.
  const event = insertGoogleEvent({ calRefId: bRef, googleId: 'gev-moved' });

  __test.upsertGoogleEvents([{ id: 'gev-moved', status: 'cancelled' }], aRef);

  assert.ok(reload(event.id), 'der Termin darf nicht durch das cancelled aus A verschwinden');
});

test('ein cancelled aus dem eigenen Kalender löscht weiterhin', () => {
  reset();
  const aRef = __test.upsertExternalCalendar('google', 'kalender-a', 'A', '#34A853');
  const event = insertGoogleEvent({ calRefId: aRef, googleId: 'gev-gone' });

  __test.upsertGoogleEvents([{ id: 'gev-gone', status: 'cancelled' }], aRef);

  assert.equal(reload(event.id), undefined);
});

test('Altzeilen ohne calendar_ref_id werden von einem cancelled weiterhin gelöscht', () => {
  reset();
  const aRef = __test.upsertExternalCalendar('google', 'kalender-a', 'A', '#34A853');
  // Bestandsdaten aus der Zeit vor external_calendars: kein calendar_ref_id.
  const event = insertGoogleEvent({ googleId: 'gev-legacy-cancel' });

  __test.upsertGoogleEvents([{ id: 'gev-legacy-cancel', status: 'cancelled' }], aRef);

  assert.equal(reload(event.id), undefined, 'sonst kämen echte Löschungen bei Altdaten nie an');
});

// ── Serien: Google liefert Master statt Einzelvorkommen ─────────────────────────
//
// Der Abruf läuft mit singleEvents:false. Eine Serie kommt damit als EIN Master
// mit ihrer Wiederholungsregel, ihre Abweichungen als eigene Items, die auf den
// Master zeigen. Yuvomi expandiert die Serie lokal - so wie bei CalDAV und ICS.

function seriesMaster(id, extra = {}) {
  return {
    id, summary: 'Yoga', status: 'confirmed',
    recurrence: ['RRULE:FREQ=WEEKLY'],
    start: { dateTime: '2035-03-03T18:00:00Z' },
    end:   { dateTime: '2035-03-03T19:00:00Z' },
    ...extra,
  };
}

/** Ein von der Serie abweichendes Vorkommen (verschoben oder abgesagt). */
function occurrence(masterId, originalStamp, extra = {}) {
  const d = `${originalStamp.slice(0, 4)}-${originalStamp.slice(4, 6)}-${originalStamp.slice(6, 8)}`;
  return {
    id: `${masterId}_${originalStamp}`,
    recurringEventId: masterId,
    originalStartTime: { dateTime: `${d}T18:00:00Z` },
    status: 'confirmed',
    summary: 'Yoga',
    start: { dateTime: `${d}T18:00:00Z` },
    end:   { dateTime: `${d}T19:00:00Z` },
    ...extra,
  };
}

function exceptionDates(eventId) {
  return db.prepare('SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ? ORDER BY exception_date')
    .all(eventId).map((r) => r.exception_date);
}

function googleRows() {
  return db.prepare("SELECT * FROM calendar_events WHERE external_source = 'google' ORDER BY id").all();
}

test('eine Serie kommt als ein Termin mit Wiederholungsregel an, nicht als viele', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  __test.upsertGoogleEvents([seriesMaster('yoga')], calRefId);

  const rows = googleRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recurrence_rule, 'RRULE:FREQ=WEEKLY');
});

test('die Wiederholungsregel wird gezielt gegriffen, auch wenn ein EXDATE davor steht', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  // Googles recurrence-Liste führt neben der Regel auch EXDATE/RDATE; ihre
  // Reihenfolge ist nicht zugesichert.
  __test.upsertGoogleEvents([seriesMaster('yoga', {
    recurrence: ['EXDATE;TZID=Europe/Berlin:20350310T190000', 'RRULE:FREQ=WEEKLY'],
  })], calRefId);

  const [row] = googleRows();
  assert.equal(row.recurrence_rule, 'RRULE:FREQ=WEEKLY', 'sonst stünde ein EXDATE als Regel in der DB');
  assert.deepEqual(exceptionDates(row.id), ['2035-03-10'], 'das EXDATE wird zur Ausnahme');
});

test('ein verschobenes Vorkommen wird eigener Termin, sein alter Slot fällt weg', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  __test.upsertGoogleEvents([
    seriesMaster('yoga'),
    occurrence('yoga', '20350310T180000Z', {
      summary: 'Yoga (später)',
      start: { dateTime: '2035-03-10T20:00:00Z' },
      end:   { dateTime: '2035-03-10T21:00:00Z' },
    }),
  ], calRefId);

  const rows = googleRows();
  assert.equal(rows.length, 2);
  const master = rows.find((r) => r.external_calendar_id === 'yoga');
  const moved  = rows.find((r) => r.external_calendar_id === 'yoga_20350310T180000Z');
  assert.equal(moved.title, 'Yoga (später)');
  assert.equal(moved.recurrence_rule, null, 'ein Einzelvorkommen ist keine Serie');
  assert.deepEqual(exceptionDates(master.id), ['2035-03-10'],
    'ohne die Ausnahme stünde der 10.03. zweimal: aus der Serie und als verschobener Termin');
});

test('ein abgesagtes Vorkommen nimmt sein Datum aus der Serie, ohne sie zu löschen', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  __test.upsertGoogleEvents([
    seriesMaster('yoga'),
    occurrence('yoga', '20350317T180000Z', { status: 'cancelled' }),
  ], calRefId);

  const rows = googleRows();
  assert.equal(rows.length, 1, 'die Serie selbst bleibt bestehen');
  assert.deepEqual(exceptionDates(rows[0].id), ['2035-03-17']);
});

test('die Reihenfolge in Googles Antwort spielt keine Rolle', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  // Abweichung VOR dem Master - ohne Sortierung fände sie ihren Master nicht.
  __test.upsertGoogleEvents([
    occurrence('yoga', '20350317T180000Z', { status: 'cancelled' }),
    seriesMaster('yoga'),
  ], calRefId);

  const master = googleRows().find((r) => r.external_calendar_id === 'yoga');
  assert.deepEqual(exceptionDates(master.id), ['2035-03-17']);
});

test('ein Einzeltermin bleibt ein Einzeltermin', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  __test.upsertGoogleEvents([inboundItem('solo', 'Zahnarzt')], calRefId);

  const [row] = googleRows();
  assert.equal(row.recurrence_rule, null);
  assert.equal(exceptionDates(row.id).length, 0);
});

// ── Umstellung: Altbestand aus der Zeit der Einzelvorkommen ─────────────────────

/** Wie eine Serie vor der Umstellung gespeichert war: als ihre Vorkommen. */
function seedLegacyOccurrences(masterId, calRefId, stamps) {
  const ins = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, external_calendar_id, external_source,
       calendar_ref_id, created_by, user_modified)
    VALUES ('Yoga', ?, ?, ?, 'google', ?, 1, ?) RETURNING id
  `);
  return stamps.map(({ stamp, userModified = 0 }) => {
    const d = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    return ins.get(`${d}T18:00:00Z`, `${d}T19:00:00Z`, `${masterId}_${stamp}`, calRefId, userModified).id;
  });
}

test('beim ersten vollen Abgleich gehen die alten Einzelvorkommen in ihrer Serie auf', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  seedLegacyOccurrences('yoga', calRefId, [
    { stamp: '20350303T180000Z' }, { stamp: '20350310T180000Z' }, { stamp: '20350317T180000Z' },
  ]);

  __test.upsertGoogleEvents([seriesMaster('yoga')], calRefId, '#4285F4', {}, { fullResync: true });

  const rows = googleRows();
  assert.equal(rows.length, 1, 'nur noch die Serie selbst');
  assert.equal(rows[0].external_calendar_id, 'yoga');
});

test('ein angefasstes Vorkommen überlebt als eigener Termin statt gelöscht zu werden', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const [, assignedId] = seedLegacyOccurrences('yoga', calRefId, [
    { stamp: '20350303T180000Z' }, { stamp: '20350310T180000Z' },
  ]);
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1)').run(assignedId);

  __test.upsertGoogleEvents([seriesMaster('yoga')], calRefId, '#4285F4', {}, { fullResync: true });

  const kept = reload(assignedId);
  assert.ok(kept, 'eine Zuweisung ist Nutzerarbeit');
  assert.equal(kept.external_source, 'local', 'losgelöst von Google, damit kein Sync sie wieder einsammelt');
  assert.equal(kept.external_calendar_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM event_assignments WHERE event_id = ?').get(assignedId).c, 1);

  const master = googleRows().find((r) => r.external_calendar_id === 'yoga');
  assert.deepEqual(exceptionDates(master.id), ['2035-03-10'],
    'sonst stünde der Termin doppelt: als eigener Eintrag und aus der Serie');
});

test('ein umgefärbtes Vorkommen überlebt genauso', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const [, recolouredId] = seedLegacyOccurrences('yoga', calRefId, [
    { stamp: '20350303T180000Z' }, { stamp: '20350310T180000Z', userModified: 1 },
  ]);

  __test.upsertGoogleEvents([seriesMaster('yoga')], calRefId, '#4285F4', {}, { fullResync: true });

  assert.equal(reload(recolouredId)?.external_source, 'local');
});

test('ohne vollen Abgleich wird kein Altbestand angefasst', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const ids = seedLegacyOccurrences('yoga', calRefId, [{ stamp: '20350303T180000Z' }]);

  // Delta-Lauf: er enthält nur den geänderten Master, nicht die Abweichungen der
  // Serie. Würde hier aufgeräumt, verschwänden echte Ausnahmen aus früheren Läufen.
  __test.upsertGoogleEvents([seriesMaster('yoga')], calRefId);

  assert.ok(reload(ids[0]), 'ein Delta erlaubt keine Unterscheidung von Altbestand und Ausnahme');
});

test('eine echte Ausnahme wird beim vollen Abgleich nicht für Altbestand gehalten', () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');

  __test.upsertGoogleEvents([
    seriesMaster('yoga'),
    occurrence('yoga', '20350310T180000Z', {
      summary: 'Yoga (später)',
      start: { dateTime: '2035-03-10T20:00:00Z' },
      end:   { dateTime: '2035-03-10T21:00:00Z' },
    }),
  ], calRefId, '#4285F4', {}, { fullResync: true });

  const moved = googleRows().find((r) => r.external_calendar_id === 'yoga_20350310T180000Z');
  assert.ok(moved, 'sie steht in derselben Antwort und ist damit als echt erkennbar');
  assert.equal(moved.external_source, 'google');
});

// ── disconnect ──────────────────────────────────────────────────────────────────

test('disconnect() verwirft offene Tombstones', () => {
  reset();
  __test.queueEventDeletion(insertGoogleEvent({ googleId: 'gev-bye', target: 'primary' }));
  assert.equal(tombstones().length, 1);

  disconnect();

  assert.equal(tombstones().length, 0);
});

// ── Routen ──────────────────────────────────────────────────────────────────────

const app = express();
app.use((req, _res, next) => {
  req.authUserId = 1;
  req.authRole = 'admin';
  req.session = { userId: 1, role: 'admin' };
  next();
});
app.use(express.json());
app.use('/', calendarRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

function callRoute(method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('DELETE /:id merkt ein gespiegeltes Event für Google vor', async () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'fam@g', 'Familie', '#34A853');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-route' });

  const res = await callRoute('DELETE', `/${event.id}`);
  assert.equal(res.status, 204);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM calendar_events WHERE id = ?').get(event.id).c, 0);
  const rows = tombstones();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calendar_external_id, 'fam@g');
  assert.equal(rows[0].event_external_id, 'gev-route');
});

test('DELETE /:id merkt einen lokalen Termin nicht vor', async () => {
  reset();
  const r = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, external_source, created_by)
    VALUES ('Lokal', '2035-03-10T09:00', 'local', 1)
  `).run();

  const res = await callRoute('DELETE', `/${r.lastInsertRowid}`);
  assert.equal(res.status, 204);
  assert.equal(tombstones().length, 0);
});

test('DELETE /:id auf unbekannte ID bleibt 404 ohne Tombstone', async () => {
  reset();
  const res = await callRoute('DELETE', '/999999');
  assert.equal(res.status, 404);
  assert.equal(tombstones().length, 0);
});

test('PUT /:id markiert ein gespiegeltes Event für den Push', async () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'fam@g', 'Familie', '#34A853');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-put' });

  const res = await callRoute('PUT', `/${event.id}`, { title: 'Verschoben' });
  assert.equal(res.status, 200);

  const row = reload(event.id);
  assert.equal(row.title, 'Verschoben');
  assert.equal(row.outbound_dirty, 1);
});

test('PUT /:id markiert nicht, wenn sich kein gespiegeltes Feld ändert', async () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'fam@g', 'Familie', '#34A853');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-put-noop' });

  const res = await callRoute('PUT', `/${event.id}`, { visibility: 'private' });
  assert.equal(res.status, 200);

  const row = reload(event.id);
  assert.equal(row.visibility, 'private');
  assert.equal(row.outbound_dirty, 0);
});

test('PUT /:id merkt einen gewechselten Zielkalender als Umzug vor', async () => {
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-put-move', target: 'primary' });

  const res = await callRoute('PUT', `/${event.id}`, { target_google_calendar_id: 'fam@g' });
  assert.equal(res.status, 200);

  const row = reload(event.id);
  assert.equal(row.outbound_move_to, 'fam@g');
  assert.equal(row.target_google_calendar_id, 'fam@g');
});

test('PUT /:id nimmt einen wartenden Umzug zurück, wenn wieder der eigene Kalender kommt', async () => {
  // Der ganze Weg über die Route: nur wenn sie das gewählte Ziel mitschreibt und
  // den Stand davor übergibt, kann die Rücknahme überhaupt erkannt werden.
  reset();
  const calRefId = __test.upsertExternalCalendar('google', 'primary', 'Primär', '#4285F4');
  const event = insertGoogleEvent({ calRefId, googleId: 'gev-put-undo', target: 'primary' });

  await callRoute('PUT', `/${event.id}`, { target_google_calendar_id: 'fam@g' });
  assert.equal(reload(event.id).outbound_move_to, 'fam@g', 'Vorbedingung: der Umzug ist vorgemerkt');

  const res = await callRoute('PUT', `/${event.id}`, { target_google_calendar_id: 'primary' });
  assert.equal(res.status, 200);

  const row = reload(event.id);
  assert.equal(row.outbound_move_to, null);
  assert.equal(row.target_google_calendar_id, 'primary');
  assert.equal(__test.pendingUpdateCount(), 0, 'der Sync findet keine Arbeit mehr');
});

test('PUT /:id markiert einen rein lokalen Termin nicht', async () => {
  reset();
  const r = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, external_source, created_by)
    VALUES ('Lokal', '2035-03-10T09:00', 'local', 1)
  `).run();

  const res = await callRoute('PUT', `/${r.lastInsertRowid}`, { title: 'Anders' });
  assert.equal(res.status, 200);
  assert.equal(reload(r.lastInsertRowid).outbound_dirty, 0);
});

// ── Bearbeitung während des Google-Aufrufs ──────────────────────────────────────
// Zwischen dem Nachladen und dem Abschluss liegt der await auf Google. Eine
// Bearbeitung, die in dieser Zeit eintrifft, setzt ihre Vormerkung neu, und der
// Abschluss darf nur löschen, was tatsächlich hinausging - sonst hielte Google den
// älteren Stand, und der nächste Inbound überschriebe die neuere lokale Änderung.
// Die Bearbeitung läuft über den echten PUT, damit die Route die Vormerkung so
// setzt wie im Betrieb (ihr Sofortversuch bricht ohne GOOGLE_CLIENT_ID ab).

/** Gespiegeltes Event mit Kalenderzuordnung - ohne sie erkennt die Route keinen Umzug. */
function seedMirrored(googleId, from = 'primary') {
  const calRefId = __test.upsertExternalCalendar('google', from, from, '#4285F4');
  return insertGoogleEvent({ calRefId, googleId, target: from });
}

async function put(id, body) {
  const res = await callRoute('PUT', `/${id}`, body);
  assert.equal(res.status, 200);
}

test('eine Bearbeitung während des Patches bleibt für den nächsten Push vorgemerkt', async () => {
  reset();
  const event = seedMirrored('gev-edit-in-patch');
  await put(event.id, { title: 'Erste' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(),
    onPatch: () => put(event.id, { title: 'Zweite' }),
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.patches[0].requestBody.summary, 'Erste');
  const row = reload(event.id);
  assert.equal(row.outbound_dirty, 1, 'die zweite Bearbeitung hat Google noch nicht erreicht');

  // Genau davor schützt der Marker: Google liefert noch den gepatchten Stand.
  __test.upsertGoogleEvents([inboundItem('gev-edit-in-patch', 'Erste')], row.calendar_ref_id);
  assert.equal(reload(event.id).title, 'Zweite');

  const next = fakeCalendar({ calendars: writableCalendars() });
  assert.equal(await __test.processPendingUpdates(next, {}), 1);
  assert.equal(next.patches[0].requestBody.summary, 'Zweite');
  assert.equal(reload(event.id).outbound_dirty, 0);
});

test('eine Bearbeitung während des Umzugs geht im selben Lauf in den Zielkalender', async () => {
  reset();
  const event = seedMirrored('gev-edit-in-move');
  await put(event.id, { target_google_calendar_id: 'fam@g' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: async (params) => {
      await put(event.id, { title: 'Unterwegs umbenannt' });
      return { data: { id: params.eventId } };
    },
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 1);
  assert.equal(calendar.patches.length, 1, 'die Auswahl kannte die Umbenennung noch nicht');
  assert.equal(calendar.patches[0].calendarId, 'fam@g');
  assert.equal(calendar.patches[0].requestBody.summary, 'Unterwegs umbenannt');
  const row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
  assert.equal(row.outbound_dirty, 0);
  assert.equal(row.outbound_move_to, null);
});

test('ein Umzug, der während des Patches vorgemerkt wird, bleibt stehen', async () => {
  reset();
  const event = seedMirrored('gev-move-in-patch');
  await put(event.id, { title: 'Umbenannt' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onPatch: () => put(event.id, { target_google_calendar_id: 'fam@g' }),
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 0);
  let row = reload(event.id);
  assert.equal(row.outbound_move_to, 'fam@g', 'der Umzug hat Google noch nicht erreicht');
  assert.equal(row.outbound_dirty, 0, 'die Umbenennung ist mit dem Patch draussen');

  const next = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g']) });
  assert.equal(await __test.processPendingUpdates(next, {}), 1);
  assert.deepEqual(next.moves, [{ calendarId: 'primary', eventId: 'gev-move-in-patch', destination: 'fam@g' }]);
  row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
  assert.equal(row.outbound_move_to, null);
});

test('ein weiterer Umzug während des Umzugs bleibt vorgemerkt', async () => {
  reset();
  const event = seedMirrored('gev-move-in-move');
  await put(event.id, { target_google_calendar_id: 'fam@g' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g', 'work@g']),
    onMove: async (params) => {
      await put(event.id, { target_google_calendar_id: 'work@g' });
      return { data: { id: params.eventId } };
    },
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 1);
  let row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
  assert.equal(row.outbound_move_to, 'work@g', 'der zweite Umzug hat Google noch nicht erreicht');

  const next = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g', 'work@g']) });
  assert.equal(await __test.processPendingUpdates(next, {}), 1);
  assert.deepEqual(next.moves, [{ calendarId: 'fam@g', eventId: 'gev-move-in-move', destination: 'work@g' }]);
  row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'work@g');
  assert.equal(row.outbound_move_to, null);
});

test('ein Rückweg in die Quelle während des Umzugs wird als neuer Umzug vorgemerkt', async () => {
  // Während events.move läuft, steht calendar_ref_id noch auf der Quelle. Die Route
  // sieht im Rückweg dorthin deshalb keinen Umzug und lässt die alte Vormerkung
  // stehen - nach dem Umzug läge der Termin im Ziel, gewählt ist die Quelle.
  reset();
  const event = seedMirrored('gev-move-back');
  await put(event.id, { target_google_calendar_id: 'fam@g' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: async (params) => {
      await put(event.id, { target_google_calendar_id: 'primary' });
      return { data: { id: params.eventId } };
    },
  });
  await __test.processPendingUpdates(calendar, {});

  let row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g', 'Vorbedingung: der Umzug ins Ziel ist ausgeführt');
  assert.equal(row.outbound_move_to, 'primary', 'der Rückweg läuft im nächsten Durchgang');

  const next = fakeCalendar({ calendars: writableCalendars(['primary', 'fam@g']) });
  assert.equal(await __test.processPendingUpdates(next, {}), 1);
  assert.deepEqual(next.moves, [{ calendarId: 'fam@g', eventId: 'gev-move-back', destination: 'primary' }]);
  row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'primary');
  assert.equal(row.outbound_move_to, null);
});

test('ein Zielwechsel während des Umzugs zurück auf das Umzugsziel merkt nichts vor', async () => {
  // Das Gegenstück: liegt das Ziel der Anfrage am Ende dort, wohin der Umzug gerade
  // ging, gibt es nichts mehr zu tun - kein zweiter Umzug an denselben Ort.
  reset();
  const event = seedMirrored('gev-move-same');
  await put(event.id, { target_google_calendar_id: 'fam@g' });
  db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'school@g' WHERE id = ?").run(event.id);

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g', 'school@g']),
    onMove: (params) => {
      db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'fam@g' WHERE id = ?").run(event.id);
      return { data: { id: params.eventId } };
    },
  });
  await __test.processPendingUpdates(calendar, {});

  const row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
  assert.equal(row.outbound_move_to, null);
});

test('ein nach dem Umzug scheiternder Patch gibt nach MAX_OUTBOUND_ATTEMPTS auf', async () => {
  // Der Umzug ist erledigt, der Patch im Zielkalender scheitert wiederholt. Bliebe
  // die Umzugs-Vormerkung stehen, setzte jeder Lauf über clearOutboundMove den
  // Zähler zurück, und der Patch ginge bei jedem Sync für immer erneut hinaus.
  reset();
  const { before } = seedMove('primary', 'fam@g', 'gev-move-patch-dead');
  db.prepare("UPDATE calendar_events SET title = 'Umgezogen, Patch scheitert' WHERE id = ?").run(before.id);
  __test.markEventOutbound(before, reload(before.id));

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onPatch: () => { throw apiError(500); },
  });
  await __test.processPendingUpdates(calendar, {});
  let row = reload(before.id);
  assert.equal(row.outbound_move_to, null, 'der Umzug selbst ist erledigt');
  assert.equal(row.outbound_attempts, 1);

  for (let i = 1; i < __test.MAX_OUTBOUND_ATTEMPTS; i++) {
    await __test.processPendingUpdates(calendar, {});
  }
  assert.equal(calendar.moves.length, 1);
  assert.equal(calendar.patches.length, __test.MAX_OUTBOUND_ATTEMPTS);
  row = reload(before.id);
  assert.equal(row.outbound_dirty, 0, 'der Push ist aufgegeben');
});

test('ein Zwischenziel während des Umzugs verfällt, wenn der Patch wieder aufs Umzugsziel wechselt', async () => {
  // Während events.move wird work@g gewählt (vorgemerkt, der Termin liegt noch in der
  // Quelle), während des Patches wieder fam@g. Dort liegt der Termin inzwischen, die
  // Route merkt nichts vor und kann work@g nicht zurücknehmen.
  reset();
  const event = seedMirrored('gev-move-detour');
  await put(event.id, { title: 'Umbenannt', target_google_calendar_id: 'fam@g' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g', 'work@g']),
    onMove: async (params) => {
      await put(event.id, { target_google_calendar_id: 'work@g' });
      return { data: { id: params.eventId } };
    },
    onPatch: () => put(event.id, { target_google_calendar_id: 'fam@g' }),
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 1);
  assert.equal(calendar.patches.length, 1);
  const row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'fam@g');
  assert.equal(row.outbound_move_to, null, 'gewählt ist der Kalender, in dem der Termin liegt');
});

test('eine Bearbeitung während des Umzugs bekommt beim scheiternden Patch ihre eigenen Versuche', async () => {
  // Der Umzug stand auf seinem letzten Versuch; die Bearbeitung setzt den Zähler zurück.
  reset();
  const event = seedMirrored('gev-move-budget');
  await put(event.id, { target_google_calendar_id: 'fam@g' });
  db.prepare('UPDATE calendar_events SET outbound_attempts = ? WHERE id = ?')
    .run(__test.MAX_OUTBOUND_ATTEMPTS - 1, event.id);

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'fam@g']),
    onMove: async (params) => {
      await put(event.id, { title: 'Unterwegs umbenannt' });
      return { data: { id: params.eventId } };
    },
    onPatch: () => { throw apiError(500); },
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.patches.length, 1);
  const row = reload(event.id);
  assert.equal(row.outbound_dirty, 1, 'die Bearbeitung darf nach einem Fehlversuch nicht verworfen sein');
  assert.equal(row.outbound_attempts, 1);
});

test('ein während des Patches gewählter und wieder verworfener Umzug verfällt', async () => {
  // Ohne Umzug in diesem Lauf: work@g wird vorgemerkt, dann wieder der Kalender
  // gewählt, in dem der Termin liegt. Die Route kann die Vormerkung nicht zurücknehmen.
  reset();
  const event = seedMirrored('gev-patch-detour');
  await put(event.id, { title: 'Umbenannt' });

  const calendar = fakeCalendar({
    calendars: writableCalendars(['primary', 'work@g']),
    onPatch: async () => {
      await put(event.id, { target_google_calendar_id: 'work@g' });
      await put(event.id, { target_google_calendar_id: 'primary' });
    },
  });
  await __test.processPendingUpdates(calendar, {});

  assert.equal(calendar.moves.length, 0);
  assert.equal(calendar.patches.length, 1);
  const row = reload(event.id);
  assert.equal(__test.currentGoogleCalendarId(row), 'primary');
  assert.equal(row.outbound_move_to, null, 'gewählt ist der Kalender, in dem der Termin liegt');
  assert.equal(row.outbound_dirty, 0);
});
