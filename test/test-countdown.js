/**
 * Modul: Countdowns (#647)
 * Zweck: Die drei Zusicherungen, an denen dieses Feature hängt:
 *        1. die Formulierung schaltet an der richtigen Stelle von exakt auf grob
 *           (public/utils/countdown.js),
 *        2. das Einsammeln nimmt beide Quellen, hält die Sichtbarkeit ein und
 *           lässt Vergangenes weg (server/services/countdowns.js),
 *        3. die Markierung überlebt das, was sie überleben muss: den Sync-
 *           Rückweg beim Termin und das Zurücksetzen bei der Aufgabe.
 * Ausführen: npm run test:countdown
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'countdown-test-secret';
// Feste Zone, sonst haengt der Termin-mit-Uhrzeit-Fall unten am Rechner, auf dem
// die Suite laeuft. `serverTimeZone()` liest genau diese Variable.
process.env.TZ = 'Europe/Berlin';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { getCountdowns, nextEventDate, daysBetween } = await import('../server/services/countdowns.js');
const { nextOccurrence } = await import('../server/services/recurrence.js');
const { MIRRORED_FIELDS } = await import('../server/services/calendar-outbound.js');
const { countdownPhrase, countdownRank, daysBetweenDateKeys } = await import('../public/utils/countdown.js');

// Die meisten Faelle interessiert nur die Liste; `total` hat seine eigenen
// Tests weiter unten.
const cd = (opts) => getCountdowns(get(), opts).items;

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');
const BOB = seedUser('bob', 'member');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function seedEvent({
  title = `Event-${randomUUID()}`, start, rule = null, countdown = 1,
  createdBy = ALICE, visibility = 'all', color = null, assignedTo = null,
} = {}) {
  return get().prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, recurrence_rule, created_by, visibility, countdown,
       color, assigned_to)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(title, start, rule, createdBy, visibility, countdown, color, assignedTo).lastInsertRowid;
}

function seedTask({
  title = `Task-${randomUUID()}`, due, countdown = 1, status = 'open',
  createdBy = ALICE, visibility = 'all', archivedAt = null,
} = {}) {
  return get().prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, created_by, visibility, countdown, archived_at)
    VALUES (?, 'misc', 'none', ?, ?, ?, ?, ?, ?)
  `).run(title, status, due, createdBy, visibility, countdown, archivedAt).lastInsertRowid;
}

function reset() {
  get().prepare('DELETE FROM calendar_events').run();
  get().prepare('DELETE FROM tasks').run();
  get().prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
  get().prepare("DELETE FROM sync_config WHERE key = 'countdown_grace_days'").run();
}

/** Schaltet Module haushaltweit ab - wie die Admin-Seite es schreibt. */
function disableModules(...names) {
  get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', ?)")
    .run(JSON.stringify(names));
}

/** Setzt die Nachfrist (#969) - wie routes/preferences.js sie schreibt. */
function setGraceDays(days) {
  get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('countdown_grace_days', ?)")
    .run(String(days));
}

// --------------------------------------------------------
// 1. Die Formulierung
// --------------------------------------------------------

test('exakt bis 30 Tage - der Fall, den der Thread ausdrücklich benannt hat', () => {
  // „10 Tage bis der Führerschein abläuft" MUSS zehn Tage bleiben und darf nicht
  // zu „ca. 2 Wochen" werden. Das ist die Grenze, an der das Feature hängt.
  assert.deepEqual(countdownPhrase(10), { key: 'dashboard.daysLeft', count: 10 });
  assert.deepEqual(countdownPhrase(30), { key: 'dashboard.daysLeft', count: 30 });
  assert.deepEqual(countdownPhrase(2), { key: 'dashboard.daysLeft', count: 2 });
});

test('heute und morgen bekommen Wörter, keine Zahl', () => {
  // „in 0 Tagen" ist keine Formulierung; beide Schlüssel tragen deshalb auch
  // kein `count` - der Aufrufer darf t() ohne Zählform rufen.
  assert.deepEqual(countdownPhrase(0), { key: 'common.today' });
  assert.deepEqual(countdownPhrase(1), { key: 'common.tomorrow' });
});

test('ab 31 Tagen wird gerundet - Wochen, Monate, Jahre', () => {
  assert.deepEqual(countdownPhrase(31), { key: 'dashboard.countdownWeeks', count: 4 });
  assert.deepEqual(countdownPhrase(60), { key: 'dashboard.countdownWeeks', count: 9 });
  assert.deepEqual(countdownPhrase(61), { key: 'dashboard.countdownMonths', count: 2 });
  assert.deepEqual(countdownPhrase(364), { key: 'dashboard.countdownMonths', count: 12 });
  assert.deepEqual(countdownPhrase(365), { key: 'dashboard.countdownYears', count: 1 });
  // Der Fall aus dem Thread: 1.247 Tage bis zum Ablauf des Führerscheins.
  assert.deepEqual(countdownPhrase(1247), { key: 'dashboard.countdownYears', count: 3 });
});

test('jede Bandgrenze ist lückenlos und monoton - keine Zahl fällt heraus', () => {
  // GEGENPROBE ZUR REGEL OBEN, und sie ist der eigentliche Guard: drei
  // einzelne Beispiele halten auch dann, wenn eine Schwelle um einen Tag
  // danebenliegt. Über den ganzen Bereich geprüft fällt eine Lücke auf.
  const ORDER = ['common.today', 'common.tomorrow', 'dashboard.daysLeft',
    'dashboard.countdownWeeks', 'dashboard.countdownMonths', 'dashboard.countdownYears'];
  let last = -1;
  const falsch = [];
  for (let d = 0; d <= 4000; d++) {
    const rang = ORDER.indexOf(countdownPhrase(d).key);
    if (rang === -1) falsch.push(`${d}: unbekannter Schluessel`);
    else if (rang < last) falsch.push(`${d}: springt zurueck auf ${ORDER[rang]}`);
    else last = rang;
  }
  assert.deepEqual(falsch, [], `Bandgrenzen nicht monoton: ${falsch.slice(0, 5).join('; ')}`);
  // Und keine Zählform darf 0 sein - „ca. 0 Jahre" wäre der Randfall bei 365.
  const nullen = [];
  for (let d = 2; d <= 4000; d++) {
    const p = countdownPhrase(d);
    if (p.count !== undefined && p.count < 1) nullen.push(d);
  }
  assert.deepEqual(nullen, [], `Zählform 0 bei: ${nullen.slice(0, 5).join(', ')}`);
});

test('Tagesdifferenz über Date.UTC - eine Zeitumstellung im Zeitraum verschiebt nichts', () => {
  // Der Anlass: die Differenz zweier LOKALER Mitternachten ist über eine
  // Sommerzeitgrenze 23 bzw. 25 Stunden lang. Beide Rechnungen (Server wie
  // Browser) müssen dieselbe ganze Zahl liefern.
  const faelle = [
    ['2026-03-28', '2026-03-30', 2],   // Umstellung auf Sommerzeit dazwischen
    ['2026-10-24', '2026-10-26', 2],   // Umstellung auf Winterzeit dazwischen
    ['2026-01-01', '2026-01-01', 0],
    ['2026-01-02', '2026-01-01', -1],
    ['2026-01-01', '2027-01-01', 365],
  ];
  for (const [from, to, erwartet] of faelle) {
    assert.equal(daysBetweenDateKeys(from, to), erwartet, `Browser: ${from} → ${to}`);
    assert.equal(daysBetween(from, to), erwartet, `Server: ${from} → ${to}`);
  }
});

// --------------------------------------------------------
// 2. Das Einsammeln
// --------------------------------------------------------

test('sammelt aus beiden Quellen und sortiert nach Nähe, nicht nach Herkunft', () => {
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Führerschein', due: '2026-08-25' });
  seedEvent({ title: 'Disney+ verlängern', start: '2026-08-20' });

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Disney+ verlängern', 'Führerschein', 'Urlaub']);
  assert.deepEqual(items.map((c) => c.source), ['event', 'task', 'event']);
  assert.deepEqual(items.map((c) => c.days_until), [3, 8, 15]);
});

test('nur Markiertes kommt an - ein gewöhnlicher Termin und eine gewöhnliche Aufgabe bleiben weg', () => {
  reset();
  seedEvent({ title: 'Zahnarzt', start: '2026-08-20', countdown: 0 });
  seedTask({ title: 'Müll rausbringen', due: '2026-08-18', countdown: 0 });
  assert.deepEqual(cd({ userId: ALICE, todayKey: '2026-08-17' }), []);
});

test('was vorbei ist, bleibt eine Nachfrist lang stehen - und faellt danach heraus', () => {
  // DIE REGEL HAT SICH UMGEDREHT (Critique 2026-08-17). Hier stand „was vorbei
  // ist, zaehlt nicht mehr" mit dem Argument, „ueberfaellig" gebe es fuer
  // Aufgaben schon dreimal. Fuer TERMINE gibt es das nirgends, und der
  // Anlassfall des Threads ist ein Ablaufdatum - der Countdown verschwand genau
  // in dem Moment, in dem die Konsequenz beginnt.
  reset();
  seedEvent({ title: 'Vorgestern', start: '2026-08-15' });
  seedEvent({ title: 'Heute', start: '2026-08-17' });
  seedEvent({ title: 'Genau raus', start: '2026-08-09' });   // 8 Tage her
  seedEvent({ title: 'Gerade drin', start: '2026-08-10' });  // 7 Tage her

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  // Ueberfaelliges zuerst, weil seine Tageszahl negativ ist - das ist die
  // Rangfolge, die die Kachel braucht, ohne eine zweite Sortierregel.
  assert.deepEqual(items.map((c) => c.title), ['Gerade drin', 'Vorgestern', 'Heute']);
  assert.deepEqual(items.map((c) => c.days_until), [-7, -2, 0]);
  assert.ok(!items.some((c) => c.title === 'Genau raus'),
    'Tag 8 liegt ausserhalb der Nachfrist und darf nicht mehr erscheinen');
});

test('die Nachfrist ist haushaltweit einstellbar (#969) - kuerzer als der Standard', () => {
  reset();
  setGraceDays(3);
  seedEvent({ title: 'Vor 2 Tagen', start: '2026-08-15' });
  seedEvent({ title: 'Vor 4 Tagen', start: '2026-08-13' });
  seedTask({ title: 'Aufgabe vor 2 Tagen', due: '2026-08-15' });
  seedTask({ title: 'Aufgabe vor 4 Tagen', due: '2026-08-13' });

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(
    items.map((c) => c.title).sort(),
    ['Aufgabe vor 2 Tagen', 'Vor 2 Tagen'].sort(),
    'mit auf 3 Tage verkuerzter Nachfrist faellt heraus, was der Standard (7) noch zeigen wuerde',
  );
});

test('0 Tage Nachfrist ist ein gueltiger, bewusst gesetzter Wert - keine sofortige Rueckfrage auf den Standard', () => {
  reset();
  setGraceDays(0);
  seedEvent({ title: 'Heute', start: '2026-08-17' });
  seedEvent({ title: 'Gestern', start: '2026-08-16' });

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Heute'],
    '0 heisst keine Nachfrist, nicht "Einstellung ignorieren und bei 7 bleiben"');
});

test('eine SERIE laeuft nicht ab - sie hat ein naechstes Mal', () => {
  // Die Nachfrist gilt nur fuer Einmaliges. Wer sie einer jaehrlichen
  // Verlaengerung gaebe, schriebe „seit 3 Tagen abgelaufen" an einen Termin,
  // der in 362 Tagen wieder ansteht.
  reset();
  seedEvent({ title: 'Jaehrlich', start: '2023-08-14', rule: 'FREQ=YEARLY;INTERVAL=1' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2027-08-14', 'die Serie zeigt nach vorn, nicht auf das letzte Vorkommen');
  assert.ok(items[0].days_until > 0);
});

test('eine ueberfaellige Aufgabe bleibt, eine ueberfaellige WIEDERKEHRENDE nicht', () => {
  reset();
  seedTask({ title: 'Einmalig ueberfaellig', due: '2026-08-15' });
  const wdh = seedTask({ title: 'Wiederkehrend ueberfaellig', due: '2026-08-15' });
  get().prepare('UPDATE tasks SET is_recurring = 1, recurrence_rule = ? WHERE id = ?')
    .run('FREQ=WEEKLY;INTERVAL=1', wdh);
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Einmalig ueberfaellig']);
});

test('countdownRank benennt vier Raenge, und seine Grenze ist die der Formulierung', () => {
  assert.equal(countdownRank(-1), 'overdue');
  assert.equal(countdownRank(0), 'now');
  assert.equal(countdownRank(1), 'now');
  assert.equal(countdownRank(2), 'soon');
  assert.equal(countdownRank(30), 'soon');
  assert.equal(countdownRank(31), 'later');
  // DIE EIGENTLICHE ZUSICHERUNG: Rang und Formulierung duerfen nicht zwei
  // Vorstellungen von „nah" haben. Ueberall dort, wo der Text exakt zaehlt,
  // muss der Rang `now` oder `soon` sein - und umgekehrt.
  const falsch = [];
  for (let d = 0; d <= 400; d++) {
    const exakt = ['common.today', 'common.tomorrow', 'dashboard.daysLeft']
      .includes(countdownPhrase(d).key);
    const nah = ['now', 'soon'].includes(countdownRank(d));
    if (exakt !== nah) falsch.push(d);
  }
  assert.deepEqual(falsch, [], `Rang und Formulierung laufen auseinander bei: ${falsch.slice(0, 5).join(', ')}`);
});

test('ein ueberfaelliger Countdown bekommt seine eigene Formulierung', () => {
  assert.deepEqual(countdownPhrase(-1), { key: 'dashboard.countdownOverdue', count: 1 });
  assert.deepEqual(countdownPhrase(-7), { key: 'dashboard.countdownOverdue', count: 7 });
});

test('die Gesamtzahl zaehlt ueber den Schnitt hinaus', () => {
  // Der Server deckelte bei fuenf und sagte es niemandem: bei sechs markierten
  // Eintraegen war der sechste unsichtbar UND unauffindbar, und die Kachel sah
  // dabei vollstaendig aus.
  reset();
  for (let i = 1; i <= 8; i++) seedTask({ title: `Aufgabe ${i}`, due: `2026-09-0${i}` });
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(res.items.length, 5, 'die Liste bleibt der Vorrat fuer die groesste Kachel');
  assert.equal(res.total, 8, 'die Gesamtzahl kennt auch, was nicht mitgeliefert wurde');
});

/* Die drei folgenden Zusicherungen kommen aus dem Review zu PR #793. Der Filter
 * für abgeschaltete Module sass allein im Browser und griff erst NACH dem
 * Schnitt auf fünf - das konnte die ganze Kachel kosten. */
test('ein abgeschaltetes Modul verdraengt die andere Quelle nicht aus dem Schnitt', () => {
  // Der gemeldete Fall, Zahl fuer Zahl: Kalender abgeschaltet, die fuenf
  // naechsten Countdowns sind Termine, dahinter steht eine markierte Aufgabe.
  // Vorher schickte der Server die fuenf Termine, der Browser warf sie weg, und
  // die Kachel verschwand aus Raster UND Anpassen-Ablage - wegen Eintraegen,
  // die der Haushalt gar nicht sehen darf.
  reset();
  for (let i = 1; i <= 5; i++) seedEvent({ title: `Termin ${i}`, start: `2026-08-2${i}` });
  seedTask({ title: 'Führerschein', due: '2029-04-01' });
  disableModules('calendar');
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(res.items.map((c) => c.title), ['Führerschein'],
    'die Aufgabe hinter den fuenf Terminen muss ankommen');
  assert.equal(res.total, 1, 'die Gesamtzahl zaehlt nur, was gezeigt werden darf');
});

test('sind beide Module abgeschaltet, gibt es keinen Countdown', () => {
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Luftfilter', due: '2026-09-02' });
  disableModules('calendar', 'tasks');
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(res.items, []);
  assert.equal(res.total, 0);
});

test('ein unlesbarer Wert schaltet nichts ab, statt alles auszublenden', () => {
  // Die einzige sichere Auslegung: die andere Richtung liesse ein kaputtes JSON
  // stumm die halbe Kachel schlucken.
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Luftfilter', due: '2026-09-02' });
  for (const broken of ['{kaputt', '"kalender"', 'null']) {
    get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', ?)")
      .run(broken);
    assert.equal(getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' }).total, 2,
      `unlesbarer Wert ${broken} darf nichts ausblenden`);
  }
});

test('eine Serie zeigt auf ihr nächstes Vorkommen, nicht auf den Start in der Vergangenheit', () => {
  // @Kyrodans Fall: „Disney+ verlängern" liegt als jährlicher Termin im
  // Kalender, sein Master-Start ist Jahre alt. Ohne Aufholen zeigte der
  // Countdown auf ein Datum in der Vergangenheit - also auf gar nichts.
  reset();
  seedEvent({ title: 'Disney+ verlängern', start: '2023-11-04', rule: 'FREQ=YEARLY;INTERVAL=1' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-11-04');
  assert.equal(items[0].recurring, true);
});

test('ein ausgenommenes Vorkommen (EXDATE) wird übersprungen, nicht gezeigt', () => {
  reset();
  const id = seedEvent({ title: 'Monatlich', start: '2026-01-05', rule: 'FREQ=MONTHLY;INTERVAL=1' });
  get().prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(id, '2026-09-05');
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items[0].date, '2026-10-05', 'die ausgenommene Instanz wurde als Ziel genommen');
});

test('ein verschobener linked override zählt am neuen Tag mit Originalidentität herunter', () => {
  reset();
  const masterId = seedEvent({
    title: 'Countdown master',
    start: '2026-08-18',
    rule: 'FREQ=DAILY;COUNT=5',
  });
  const childId = seedEvent({
    title: 'Countdown moved override',
    start: '2026-08-22',
    rule: null,
    createdBy: ALICE,
  });
  get().prepare(`
    UPDATE calendar_events
    SET recurrence_parent_id = ?, recurrence_id = '2026-08-19',
        overridden_fields = '["title","start_datetime"]'
    WHERE id = ?
  `).run(masterId, childId);
  get().prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, '2026-08-19')
  `).run(masterId);

  const items = getCountdowns(get(), {
    userId: ALICE,
    todayKey: '2026-08-17',
    limit: 20,
  }).items;
  const linked = items.find((item) => Number(item.id) === Number(childId));

  assert.ok(linked, 'moved linked countdown missing');
  assert.equal(linked.date, '2026-08-22');
  assert.equal(linked.days_until, 5);
  assert.equal(linked.series_id, Number(masterId));
  assert.equal(linked.recurrence_id, '2026-08-19');
  assert.equal(linked.is_occurrence_override, true);
  assert.equal(linked.recurring, true);
  assert.equal(items.some((item) => Number(item.id) === Number(masterId)
    && item.date === '2026-08-19'), false, 'original EXDATE slot must stay suppressed');
});

test('Countdown-Abfragen laden keine großen attachment_data-Bodies', () => {
  reset();
  const masterId = seedEvent({
    title: 'Countdown attachment master',
    start: '2026-08-18',
    rule: 'FREQ=DAILY;COUNT=3',
  });
  const childId = seedEvent({
    title: 'Countdown attachment moved',
    start: '2026-08-22',
  });
  const largeAttachment = 'A'.repeat(1024 * 1024);
  get().prepare(`
    UPDATE calendar_events
    SET attachment_data = ?, recurrence_parent_id = ?, recurrence_id = '2026-08-19',
        overridden_fields = '["title","start_datetime"]'
    WHERE id = ?
  `).run(largeAttachment, masterId, childId);
  get().prepare('UPDATE calendar_events SET attachment_data = ? WHERE id = ?')
    .run(largeAttachment, masterId);
  get().prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, '2026-08-19')
  `).run(masterId);

  const database = get();
  const originalPrepare = database.prepare.bind(database);
  const statements = [];
  database.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let items;
  try {
    items = getCountdowns(database, {
      userId: ALICE,
      todayKey: '2026-08-17',
      limit: 20,
    }).items;
  } finally {
    delete database.prepare;
  }

  assert.ok(items.some((item) => Number(item.id) === Number(childId)), 'linked Countdown fehlt');
  const calendarReads = statements.filter((sql) => /FROM\s+calendar_events/i.test(sql));
  assert.ok(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert.ok(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
});

test('Sichtbarkeit gilt auch hier: fremde private Einträge zählen für niemanden sonst herunter', () => {
  reset();
  seedEvent({ title: 'Alices Termin', start: '2026-08-20', createdBy: ALICE, visibility: 'private' });
  seedTask({ title: 'Alices Aufgabe', due: '2026-08-21', createdBy: ALICE, visibility: 'private' });
  seedEvent({ title: 'Gemeinsam', start: '2026-08-22', createdBy: ALICE, visibility: 'all' });

  const fuerAlice = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(fuerAlice.length, 3);
  const fuerBob = cd({ userId: BOB, todayKey: '2026-08-17' });
  assert.deepEqual(fuerBob.map((c) => c.title), ['Gemeinsam']);
});

test('erledigte und abgelegte Aufgaben zählen nicht mehr herunter', () => {
  reset();
  seedTask({ title: 'Erledigt', due: '2026-08-20', status: 'done' });
  seedTask({ title: 'Abgelegt', due: '2026-08-21', archivedAt: '2026-08-16T10:00:00Z' });
  seedTask({ title: 'Offen', due: '2026-08-22' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Offen']);
});

test('eine markierte Aufgabe ohne Fälligkeit hat nichts, worauf sie zeigen könnte', () => {
  reset();
  seedTask({ title: 'Ohne Datum', due: null });
  assert.deepEqual(cd({ userId: ALICE, todayKey: '2026-08-17' }), []);
});

test('ein Termin mit Uhrzeit zählt auf SEINEN Kalendertag, nicht auf den UTC-Tag', () => {
  // 20.09. 23:00Z ist in Europe/Berlin der 21.09. um 01:00 - der Kalender zeigt
  // den 21., und der Countdown muss denselben Tag meinen. Der rohe Datumsanteil
  // (`slice(0,10)`) hätte hier einen Tag zu wenig gezählt.
  assert.equal(
    nextEventDate({ start_datetime: '2026-09-20T23:00:00Z', all_day: 0 }, '2026-08-17'),
    '2026-09-21',
  );
  // Ein ganztägiger Termin trägt sein Datum ohne Zeitanteil - da gibt es nichts
  // umzurechnen, und wer es täte, verschöbe ihn.
  assert.equal(
    nextEventDate({ start_datetime: '2026-09-20', all_day: 1 }, '2026-08-17'),
    '2026-09-20',
  );
  // Und die Serie erbt den lokalen Tag als Anker, sonst läge jedes Vorkommen
  // um denselben einen Tag daneben.
  assert.equal(
    nextEventDate(
      { start_datetime: '2023-09-20T23:00:00Z', all_day: 0, recurrence_rule: 'FREQ=YEARLY;INTERVAL=1' },
      '2026-08-17',
    ),
    '2026-09-21',
  );
});

test('eine Serie mit eigener Zone wird nicht verschwiegen', () => {
  // 31. Januar 20:00 in New York liegt in UTC schon am 1. Februar. Fuer "am
  // letzten Tag des Monats" zaehlt der Ortstag, also der 31. - die Serie ist
  // gueltig, und der Kalender zeigt sie. Die Kachel fragte dagegen ohne
  // Zonenhinweis, sah den Ersten, fand kein Vorkommen und gab null zurueck:
  // ein Termin, den eine Stelle anzeigt und die andere verschweigt.
  const ev = {
    id: 1, title: 'NY', all_day: 0, tzid: 'America/New_York',
    start_datetime: '2026-02-01T01:00:00Z',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260220',
  };
  assert.equal(nextEventDate(ev, '2026-01-15'), '2026-02-01');

  // GEGENPROBE IN DIE ANDERE RICHTUNG: ohne eigene Zone bleibt die Pruefung
  // scharf. Sonst waere der Fix eine Abschaltung mit Umweg - dieselbe Regel
  // haette dann gar keine Wirkung mehr.
  const ohneZone = { ...ev, tzid: null };
  assert.equal(nextEventDate(ohneZone, '2026-01-15'), null,
    'ohne Zonenhinweis ist der 1. Februar kein Monatsletzter');
});

test('nextEventDate gibt für einen vergangenen Einzeltermin nichts zurück', () => {
  assert.equal(nextEventDate({ start_datetime: '2026-08-16' }, '2026-08-17'), null);
  assert.equal(nextEventDate({ start_datetime: '2026-08-17' }, '2026-08-17'), '2026-08-17');
  assert.equal(nextEventDate({ start_datetime: 'kaputt' }, '2026-08-17'), null);
});

// --------------------------------------------------------
// 3. Was die Markierung überleben muss
// --------------------------------------------------------

test('die Markierung ist kein gespiegeltes Feld - sie löst keinen Push zum Anbieter aus', () => {
  // Der Thread hat genau das zugesagt: die Markierung bleibt hier und taucht
  // weder in Google noch in der Kalender-App des Telefons auf. Sie darf deshalb
  // nicht in MIRRORED_FIELDS stehen - stünde sie dort, würde ein Setzen als
  // Änderung am Termin gelesen und hochgeladen.
  assert.ok(!MIRRORED_FIELDS.includes('countdown'),
    'countdown steht in MIRRORED_FIELDS - dann wandert eine reine Anzeigeeinstellung zum Anbieter');
});

test('das Zurücksetzen einer Serie nimmt die Markierung mit (#647 + #658)', async () => {
  // DER FALL, DER DAS FEATURE FUER @jamespurnama1 TRAEGT: „immer wieder N Jahre"
  // ist eine Aufgabe, die ab ihrer Erledigung neu rechnet. Verlöre die
  // Folgeinstanz die Markierung, wäre der Countdown nach dem ersten
  // Zurücksetzen weg - und zwar lautlos, weil die Folgeaufgabe sonst
  // vollständig aussieht (dieselbe Falle wie bei Tags und
  // recurrence_from_completion).
  reset();
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ALICE;
    req.authRole = 'admin';
    req.session = { userId: ALICE, role: 'admin' };
    next();
  });
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

  try {
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Luftfilter reinigen',
        due_date: '2026-08-25',
        is_recurring: 1,
        recurrence_rule: 'FREQ=DAILY;INTERVAL=90',
        recurrence_from_completion: 1,
        countdown: 1,
      }),
    });
    const { data: task } = await created.json();
    assert.equal(task.countdown, 1, 'die Markierung kam beim Anlegen nicht an');

    const done = await fetch(`${base}/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(done.status, 200);

    const followup = get().prepare(
      'SELECT countdown, due_date FROM tasks WHERE recurrence_origin_id = ?'
    ).get(task.id);
    assert.ok(followup, 'keine Folgeinstanz angelegt');
    assert.equal(followup.countdown, 1,
      'die Folgeinstanz hat die Countdown-Markierung verloren - der Countdown wäre nach dem ersten Zurücksetzen still weg');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ein PUT ohne das Feld löscht eine gesetzte Markierung nicht', async () => {
  // Ein Modul oder eine ältere App, die `countdown` nicht kennt, schickt beim
  // Speichern alles andere mit. Nicht mitgeschickt heisst „nicht angefasst" -
  // sonst räumte ein fremder Client die Markierung stillschweigend ab.
  reset();
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ALICE;
    req.authRole = 'admin';
    req.session = { userId: ALICE, role: 'admin' };
    next();
  });
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

  try {
    const id = seedTask({ title: 'Versicherung', due: '2026-12-01', countdown: 1 });
    const res = await fetch(`${base}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Versicherung', due_date: '2026-12-01' }),
    });
    assert.equal(res.status, 200);
    const row = get().prepare('SELECT countdown FROM tasks WHERE id = ?').get(id);
    assert.equal(row.countdown, 1, 'ein PUT ohne das Feld hat die Markierung gelöscht');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --------------------------------------------------------
// Was abgelaufen ist, verschwindet - und was laeuft, bleibt (#877)
// --------------------------------------------------------

/** Ein Termin, wie ihn `nextEventDate` erwartet. */
const ev = (start, rule = null) => ({ start_datetime: start, all_day: 1, recurrence_rule: rule });

const HEUTE = '2026-08-26';
const GRACE = { graceDays: 7, tz: 'UTC' };

test('eine Serie mit COUNT ist nach ihrem letzten Mal vorbei (#877)', () => {
  // GEMELDET WAR: "past/expired appointments continue to be displayed
  // indefinitely". Der Weg dorthin ist COUNT.
  //
  // `nextOccurrence()` ist zustandslos und kann COUNT nicht durchsetzen - das
  // steht so in recurrence.js und stimmt auch. Was fehlte, ist die Stelle, die
  // es KANN: `nextEventDate` kennt den Serienstart, also kann sie zaehlen.
  // Ohne sie lief eine dreimalige Serie aus dem Januar 2025 im August 2026
  // immer noch weiter und zeigte einen Termin in der ZUKUNFT an - der
  // Countdown war also nicht nur zu langlebig, sondern schlicht falsch.
  const dreimalAbJanuar = ev('2025-01-01', 'FREQ=MONTHLY;COUNT=3');
  assert.equal(nextEventDate(dreimalAbJanuar, HEUTE, null, GRACE), null,
    'die Serie hatte ihre drei Termine im Januar, Februar und Maerz 2025');

  // Die Gegenrichtung: eine Serie, deren Vorkommen noch nicht aufgebraucht
  // sind, zaehlt normal weiter.
  const nochNichtAufgebraucht = ev('2026-01-01', 'FREQ=MONTHLY;COUNT=24');
  assert.equal(nextEventDate(nochNichtAufgebraucht, HEUTE, null, GRACE), '2026-09-01');
});

test('COUNT zaehlt ab dem Serienstart, nicht ab heute (#877)', () => {
  // Der Randfall, an dem eine Zaehlung "ab dem naechsten Vorkommen" gruen
  // waere und trotzdem falsch: die Serie hat genau noch ein Mal vor sich.
  const nochEinmal = ev('2026-06-01', 'FREQ=MONTHLY;COUNT=4');
  assert.equal(nextEventDate(nochEinmal, HEUTE, null, GRACE), '2026-09-01',
    'Juni, Juli, August, September - das vierte Mal steht noch aus');

  const geradeVorbei = ev('2026-06-01', 'FREQ=MONTHLY;COUNT=3');
  assert.equal(nextEventDate(geradeVorbei, HEUTE, null, GRACE), null,
    'Juni, Juli, August - das dritte Mal war der 1. August, also vorbei');
});

test('eine alte Serie verschwindet nicht, nur weil sie alt ist (#877)', () => {
  // DIE ANDERE HAELFTE DESSELBEN BERICHTS. `nextOccurrenceAfter` holte die
  // Serie Schritt fuer Schritt ein und gab nach 1000 Schritten auf; ein Datum
  // in der Vergangenheit wird dann zu `null`, und der Countdown verschwindet.
  //
  // Gemessen: eine TAEGLICHE Serie ab 2023 und eine WOECHENTLICHE ab 2005
  // fielen heraus - beides voellig gewoehnliche Eintraege, keine Randfaelle.
  // Ein wiederkehrender Termin, der heute stattfindet, muss heute anzeigen.
  assert.equal(nextEventDate(ev('2023-01-01', 'FREQ=DAILY'), HEUTE, null, GRACE), HEUTE,
    'eine taegliche Serie findet auch heute statt');
  assert.equal(nextEventDate(ev('2015-01-01', 'FREQ=DAILY'), HEUTE, null, GRACE), HEUTE);

  // Woechentlich ab einem Donnerstag im Jahr 2005: der naechste Donnerstag.
  const woechentlich = nextEventDate(ev('2005-01-06', 'FREQ=WEEKLY'), HEUTE, null, GRACE);
  assert.ok(woechentlich && woechentlich >= HEUTE,
    `eine woechentliche Serie seit 2005 darf nicht verschwinden (war: ${woechentlich})`);
  assert.equal(new Date(`${woechentlich}T00:00:00Z`).getUTCDay(), 4, 'sie bleibt auf ihrem Donnerstag');
});

test('einmalige Termine folgen weiter der Nachfrist (#877)', () => {
  // Die Zusicherung aus #647, unveraendert - der Fix darf sie nicht mitnehmen.
  assert.equal(nextEventDate(ev('2026-08-23'), HEUTE, null, GRACE), '2026-08-23', '3 Tage her: bleibt');
  assert.equal(nextEventDate(ev('2026-08-18'), HEUTE, null, GRACE), null, '8 Tage her: weg');
  assert.equal(nextEventDate(ev('2024-08-26'), HEUTE, null, GRACE), null, '2 Jahre her: weg');
});

test('eine Serie mit UNTIL bleibt vorbei (#877)', () => {
  // Sie war schon richtig - der Fix darf sie nicht kaputt machen.
  assert.equal(nextEventDate(ev('2025-01-01', 'FREQ=MONTHLY;UNTIL=20250601T000000Z'), HEUTE, null, GRACE), null);
});

test('der Sprung beim Aufholen liefert dasselbe wie das Zaehlen (#877)', () => {
  // DIE ABKUERZUNG DARF DAS ERGEBNIS NICHT AENDERN, nur seinen Preis. Genau
  // hier liegt das Risiko dieser Sorte Optimierung: ein Sprung, der ein Stueck
  // zu weit geht, ueberspringt das gesuchte Vorkommen - und das Ergebnis sieht
  // trotzdem plausibel aus, weil es ein gueltiges Datum der Serie ist.
  //
  // Also gegengerechnet: Schritt fuer Schritt vom Serienstart aus, ohne jede
  // Abkuerzung, und das Ergebnis muss gleich sein.
  //
  // DER ANKER GEHOERT IN BEIDE RECHNUNGEN (#978). `nextEventDate` kennt den
  // Serienstart und reicht ihn durch, damit eine Klemmung in einem kurzen Monat
  // den gemeinten Tag nicht dauerhaft umschreibt. Zaehlte die Gegenrechnung
  // ohne ihn, verglichen wir zwei verschiedene Serien und der Test meldete einen
  // Sprungfehler, wo nur die Referenz eine andere Frage beantwortet - `startKey`
  // IST der Serienstart, also derselbe Anker.
  const langsam = (startKey, rule, todayKey) => {
    let current = startKey;
    for (let i = 0; i < 20000 && current < todayKey; i += 1) {
      const next = nextOccurrence(current, rule, { anchor: startKey });
      if (!next || next <= current) return null;
      current = next;
    }
    return current >= todayKey ? current : null;
  };

  // Breit ausgelegt, weil ein Sprung genau dort danebengeht, wo das Raster
  // nicht gleichmaessig ist: Monatsenden, Schaltjahre, ungerade Intervalle.
  // Der 31.03. mit Intervall 5 stand beim ersten Wurf drin und hat den Fehler
  // gefunden - die Serie driftet an jedem kurzen Monat, und der Sprung landete
  // vier Monate zu weit.
  const faelle = [];
  for (const iv of [1, 2, 3, 5, 7]) {
    faelle.push(['2015-01-01', `FREQ=DAILY;INTERVAL=${iv}`]);
    faelle.push(['2005-01-06', `FREQ=WEEKLY;INTERVAL=${iv}`]);
    for (const tag of ['01-15', '01-28', '01-29', '01-30', '01-31', '03-31', '05-31']) {
      faelle.push([`1990-${tag}`, `FREQ=MONTHLY;INTERVAL=${iv}`]);
    }
    faelle.push([`2000-02-29`, `FREQ=YEARLY;INTERVAL=${iv}`]);
    faelle.push([`1990-12-31`, `FREQ=YEARLY;INTERVAL=${iv}`]);
  }
  // Und die kurzen Abstaende, bei denen gar nicht gesprungen wird - der
  // haeufige Fall darf durch die Abkuerzung nicht anders werden.
  faelle.push(['2026-08-20', 'FREQ=DAILY'], ['2026-08-26', 'FREQ=MONTHLY'],
    ['2026-08-01', 'FREQ=WEEKLY'], ['2026-07-15', 'FREQ=MONTHLY;INTERVAL=2']);

  for (const [start, rule] of faelle) {
    const mitSprung = nextEventDate(ev(start, rule), HEUTE, null, GRACE);
    assert.equal(mitSprung, langsam(start, rule, HEUTE),
      `${rule} ab ${start}: der Sprung weicht vom Zaehlen ab`);
  }
});


// --------------------------------------------------------
// Die geliehene Farbe (#891)
// --------------------------------------------------------

test('ein Countdown ohne eigene Farbe leiht sich die der zugewiesenen Person', () => {
  // Die Kachel loeste die Farbe bis v2.48.0 selbst auf - `row.color || null` -,
  // was folgenlos war, solange die Spalte NOT NULL war. Mit einer Farbe, die
  // fehlen DARF, saehe derselbe Termin hier farblos aus (Modulton) und im
  // Kalender daneben in der Farbe der Person. Dritte Stelle desselben Musters.
  reset();
  const heute = '2026-08-27';
  const bunt = seedUser('bunt', 'member');
  get().prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('#EC4899', bunt);

  const id = seedEvent({ title: 'Geliehen', start: '2026-09-10', color: null, assignedTo: bunt });
  get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, bunt);

  const zeile = getCountdowns(get(), { userId: ALICE, todayKey: heute }).items.find((c) => c.title === 'Geliehen');
  assert.ok(zeile, 'der Countdown muss ueberhaupt erscheinen');
  assert.equal(zeile.color, '#EC4899',
    'ohne eigene Farbe gilt die der zugewiesenen Person, nicht der Modulton');
});

test('eine eigene Farbe schlaegt die geliehene weiterhin', () => {
  // Die Gegenprobe: ohne sie waere der Test oben auch dann gruen, wenn die
  // Kachel IMMER die Personenfarbe naehme und eine bewusste Wahl wegwuerfe.
  reset();
  const heute = '2026-08-27';
  const bunt = seedUser('bunt2', 'member');
  get().prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('#EC4899', bunt);

  const id = seedEvent({ title: 'Eigen', start: '2026-09-10', color: '#3CA368', assignedTo: bunt });
  get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, bunt);

  const zeile = getCountdowns(get(), { userId: ALICE, todayKey: heute }).items.find((c) => c.title === 'Eigen');
  assert.equal(zeile.color, '#3CA368', 'eine ausdrueckliche Farbe bleibt');
});

test('ohne jede Quelle bleibt die Farbe null, damit der Modulton greift', () => {
  // Bewusst NICHT das neutrale Grau aus `resolveEventColor()`: die Kachel hat
  // mit dem Ton ihres Moduls einen besseren Notnagel, und ein Grau sieht aus
  // wie eine Angabe. Deshalb `resolveEventColorOrNull()`.
  reset();
  const zeile = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-27' }).items.find((c) => c.title === 'Nackt');
  assert.equal(zeile, undefined, 'Vorbedingung: noch nichts angelegt');

  seedEvent({ title: 'Nackt', start: '2026-09-10', color: null, assignedTo: null });
  const nackt = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-27' }).items.find((c) => c.title === 'Nackt');
  assert.equal(nackt.color, null, 'keine Quelle heisst null, nicht Grau');
});

test('ein geloeschtes primaeres Mitglied laesst die Kachel nicht farblos zurueck', () => {
  // Der Fremdschluessel setzt `assigned_to` auf NULL und nimmt die Zuweisungs-
  // zeile des Geloeschten mit; die uebrigen Zugewiesenen bleiben. Der Kalender
  // faellt dann auf den ersten verbliebenen zurueck. Ohne dieselbe Ruecknahme
  // waere die Kachel die EINZIGE Stelle, die hier den Modulton zeigt - genau
  // die Art Abweichung, die #891 an drei Stellen aufgeraeumt hat.
  reset();
  const geht  = seedUser('geht', 'member');
  const bleibt = seedUser('bleibt', 'member');
  get().prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('#587DCE', geht);
  get().prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('#D8B349', bleibt);

  const id = seedEvent({ title: 'Verwaist', start: '2026-09-10', color: null, assignedTo: geht });
  get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, geht);
  get().prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, bleibt);

  get().prepare('DELETE FROM users WHERE id = ?').run(geht);

  // Vorbedingung, sonst prueft der Test etwas anderes als er behauptet.
  const nachher = get().prepare('SELECT assigned_to FROM calendar_events WHERE id = ?').get(id);
  assert.equal(nachher.assigned_to, null, 'das Loeschen muss assigned_to geleert haben');
  const rest = get().prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(id);
  assert.deepEqual(rest.map((r) => r.user_id), [bleibt], 'und nur die Zeile des Geloeschten mitnehmen');

  const zeile = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-27' })
    .items.find((c) => c.title === 'Verwaist');
  assert.equal(zeile.color, '#D8B349',
    'die Kachel faellt auf den verbliebenen Zugewiesenen zurueck, nicht auf den Modulton');
});

test('der Countdown zeigt kein Datum, an dem die Serie kein Vorkommen hat (#960)', () => {
  // Ein Termin am 15. mit "am letzten Tag des Monats" hat am 15. kein
  // Vorkommen. Dieser Zweig reichte das Startdatum ungeprueft durch, sobald es
  // in der Zukunft lag - der Countdown kuendigte einen Termin an, den die
  // Kalenderansicht nicht zeigte. Das gespeicherte Datum bleibt dabei stehen;
  // gefragt wird nur, welcher Tag der erste ist.
  const ev = { start_datetime: '2026-01-15', recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1' };
  assert.equal(nextEventDate(ev, '2026-01-01', null, GRACE), '2026-01-31');

  // Ohne die Angabe bleibt der Start der naechste Termin.
  assert.equal(nextEventDate({ ...ev, recurrence_rule: 'FREQ=MONTHLY' }, '2026-01-01', null, GRACE),
    '2026-01-15');
});

test('eine Serie ohne jedes Vorkommen liefert kein Countdown-Datum (#960)', () => {
  // `seriesStartFor` gibt ohne Treffer das Datum zurueck, das es bekommen hat -
  // "nicht bewegt" und "nichts gefunden" sehen am Rueckgabewert gleich aus. Bei
  // BYMONTHDAY=-1 mit einem UNTIL vor dem ersten Monatsletzten waere der
  // unveraenderte Start als naechster Termin durchgegangen, obwohl die
  // Kalenderansicht nichts zeigt.
  const leer = { start_datetime: '2026-01-15', recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120' };
  assert.equal(nextEventDate(leer, '2026-01-01', null, GRACE), null);

  // Dieselbe Regel mit Luft nach hinten hat ein Vorkommen und liefert es.
  const voll = { ...leer, recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260215' };
  assert.equal(nextEventDate(voll, '2026-01-01', null, GRACE), '2026-01-31');
});
