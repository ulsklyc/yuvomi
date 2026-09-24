/**
 * Modul: Dashboard-API-Test
 * Zweck: Validiert die Dashboard-Aggregationsabfragen mit node:sqlite
 * Ausführen: node --experimental-sqlite test-dashboard.js
 */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as nodeAssert from 'node:assert/strict';
import express from 'express';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { addLocalDays, toLocalDateKey } from '../public/utils/date.js';
import { withoutBlockComments } from './source-text.js';
import { eachRule } from './css-rules.js';

// Dynamisch geladen, weil beide Module inzwischen server/db.js in ihren
// Import-Graphen ziehen: statische Imports laufen vor der DB_PATH-Zuweisung
// oben, sodass db.js eine echte yuvomi.db im Repo anlegen würde
// (`test:db-isolation` wacht darüber).
const { hydrateBirthday, syncBirthdayArtifacts } = await import('../server/services/birthdays.js');
const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

register('./test-browser-loader.mjs', import.meta.url);

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  pendingTests.push(Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }));
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion fehlgeschlagen');
}

// --------------------------------------------------------
// DB aufbauen
// --------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);
db.exec(MIGRATIONS_SQL[1]);
db.exec(MIGRATIONS_SQL[2]);  // sync_config - traegt die Haushaltszone (siehe unten)
db.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions (EXDATE, #489)

// Testdaten einfügen
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('admin', 'Anna Admin', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max Muster', 'x', '#34C759')`).run();

const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;

// Lokale Kalendertage, nicht UTC: die Route liest Mahlzeitendatum, due_date und
// Geburtstage als lokale Kalenderwerte. Seedete der Test dagegen den UTC-Tag,
// fielen beide oestlich von UTC in den fruehen Morgenstunden auseinander und die
// Suite war zwischen 00:00 und 02:00 CEST rot - in UTC (CI) dagegen immer gruen.
// `inOneHour` bleibt ein echter Instant und damit korrekt in UTC.
const today = toLocalDateKey();
const tomorrow = addLocalDays(today, 1);

// DIE HAUSHALTSZONE MUSS DIESELBE SEIN, AUS DER DIE SAAT IHREN TAG NIMMT.
// Serverseitig beantwortet `todayKey()` die Frage "welcher Tag ist heute" aus
// `sync_config.household_timezone`; fehlt der Eintrag, faellt es still auf die
// Zone des RECHNERS zurueck. Genau dieser stille Rueckfall hat hier zweimal
// zugeschlagen (siehe den Kommentar oben zu 00:00-02:00 CEST, und #1076). Er
// stimmte bisher nur zufaellig mit `toLocalDateKey()` ueberein - jetzt steht es
// da, und der Waechter darunter faellt, wenn es jemand auseinanderzieht.
db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)')
  .run('household_timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
const currentMonth = today.slice(0, 7);
const inOneHour = new Date(Date.now() + 3600000).toISOString();
const in30h = toLocalDateKey(new Date(Date.now() + 30 * 3600000));
const in72h = toLocalDateKey(new Date(Date.now() + 72 * 3600000));

// Aufgaben
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by, assigned_to)
  VALUES ('Urgent Task', 'urgent', 'open', ?, ?, ?)`).run(today, uid1, uid2);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task morgen', 'high', 'open', ?, ?)`).run(tomorrow, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task in 3 Tagen', 'high', 'open', ?, ?)`).run(in72h, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('Done Task', 'urgent', 'done', ?, ?)`).run(today, uid1);

// Kalender-Events
const evMeeting = db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, assigned_to, color)
  VALUES ('Morgen-Meeting', ?, ?, ?, '#007AFF')`).run(inOneHour, uid1, uid2);
db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
  VALUES ('Event in 3 Tagen', ?, ?)`).run(in72h + 'T10:00:00Z', uid1);

// Multi-Assignments für Morgen-Meeting (uid1 + uid2 sind zugewiesen)
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid1);
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid2);

// Mahlzeiten
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'breakfast', 'Haferbrei', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'dinner', 'Pasta', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'lunch', 'Salat morgen', ?)`).run(tomorrow, uid1);

// Notizen
db.prepare(`INSERT INTO notes (content, title, pinned, color, created_by)
  VALUES ('Wichtige Info', 'Pinnwand-Notiz', 1, '#FFEB3B', ?)`).run(uid1);
db.prepare(`INSERT INTO notes (content, pinned, color, created_by)
  VALUES ('Nicht angepinnt', 0, '#E3F2FF', ?)`).run(uid1);

// Geburtstage
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Heute Geburtstag', ?, ?)`).run(`2012-${today.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Morgen Geburtstag', ?, ?)`).run(`2010-${tomorrow.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Anderer Nutzer', ?, ?)`).run(`2011-${today.slice(5)}`, uid2);

// Budget
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Salary', 3000, 'Erwerbseinkommen', '', ?, ?)`).run(`${currentMonth}-05`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Rent', -1200, 'housing', 'rent_mortgage', ?, ?)`).run(`${currentMonth}-06`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Groceries', -450, 'food', 'supermarket', ?, ?)`).run(`${currentMonth}-07`, uid1);

console.log('\n[Dashboard-Test] API-Abfragen\n');

test('Der Speed-Dial bietet nur an, was der Betrachter anlegen darf (#1208)', async () => {
  // Die Liste stand ungefiltert da: wer Notizen auf `none` hatte, bekam trotzdem
  // „Notiz anlegen" angeboten und lief in ein 403. Aufgefallen ist es am
  // Wandtablett, wo ALLE vier Eintraege ins Leere fuehren - dessen Module stehen
  // samt und sonders auf `read`.
  const { __test } = await import('../public/pages/dashboard.js');
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');

  setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {} });
  const voll = __test.renderFab();
  assert(voll.includes('data-route="/tasks"'), 'ohne Einschraenkung stehen alle vier da');
  assert(voll.includes('data-route="/notes"'));

  // Ein eingeschraenktes Mitglied: Notizen weg, der Rest bleibt.
  setPermissions({ admin: false, modules: { notes: 'none' }, widgets: {}, capabilities: {} });
  const teilweise = __test.renderFab();
  assert(!teilweise.includes('data-route="/notes"'), 'ein gesperrtes Modul wird nicht angeboten');
  assert(teilweise.includes('data-route="/tasks"'), 'die uebrigen bleiben');

  // Ein Wandtablett: alles nur lesend, also kein Knopf. Ein Speed-Dial, der
  // sich auf eine leere Liste oeffnet, waere die schlechtere Haelfte des
  // Fehlers, den der Filter behebt.
  setPermissions({
    admin: false,
    modules: { tasks: 'read', calendar: 'read', shopping: 'none', notes: 'none' },
    widgets: {}, capabilities: {},
  });
  assert(__test.renderFab() === '', 'nur Lesezugriff heisst kein Anlege-Knopf');

  clearPermissions();
});

test('Notes widget options stay unchanged when the category catalog cannot load', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const current = { categories: [7, 8] };

  const result = await __test.openWidgetOptions('notes', current, {
    loadNotes: async () => null,
  });

  assert(result === null, 'ein Katalogfehler muss den Dialog abbrechen statt den gespeicherten Filter zu leeren');
});

test('Today-Highlights priorisieren dringende Aufgaben und nächsten Termin', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const result = __test.buildTodayHighlights({
    tasks: [
      { id: 1, title: 'Low task', priority: 'low' },
      { id: 2, title: 'Pay bill', priority: 'urgent' },
    ],
    events: [{ id: 3, title: 'Dentist' }],
    shopping: { items: [{ is_checked: false }, { is_checked: true }] },
    meals: { dinner: { title: 'Soup' } },
  });

  assert(result.urgentTask.title === 'Pay bill', 'Urgent Task sollte priorisiert werden');
  assert(result.nextEvent.title === 'Dentist', 'Nächster Termin sollte übernommen werden');
  assert(result.openShoppingCount === 1, 'Offene Einkaufsartikel sollten gezählt werden');
  assert(result.meal.title === 'Soup', 'Geplante Mahlzeit sollte übernommen werden');
});

test('Today-Highlights wählt die Mahlzeit passend zur Tageszeit', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const RealDate = Date;
  const withHour = (hour, fn) => {
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) { super('2026-07-03T00:00:00'); this.setHours(hour); return; }
        super(...args);
      }
    }
    globalThis.Date = FakeDate;
    try { return fn(); } finally { globalThis.Date = RealDate; }
  };
  const meals = [
    { meal_type: 'breakfast', title: 'Eier' },
    { meal_type: 'lunch', title: 'Salat' },
    { meal_type: 'dinner', title: 'Suppe' },
  ];

  const morning = withHour(8, () => __test.buildTodayHighlights({ meals }));
  assert(morning.mealType === 'breakfast' && morning.meal.title === 'Eier', 'Morgens sollte Frühstück gezeigt werden');

  const noon = withHour(13, () => __test.buildTodayHighlights({ meals }));
  assert(noon.mealType === 'lunch' && noon.meal.title === 'Salat', 'Mittags sollte Mittagessen gezeigt werden');

  const evening = withHour(20, () => __test.buildTodayHighlights({ meals }));
  assert(evening.mealType === 'dinner' && evening.meal.title === 'Suppe', 'Abends sollte Abendessen gezeigt werden');

  // Frühstück nicht geplant → nächste geplante Mahlzeit des Tages
  const onlyDinner = withHour(8, () => __test.buildTodayHighlights({ meals: [{ meal_type: 'dinner', title: 'Suppe' }] }));
  assert(onlyDinner.meal.title === 'Suppe', 'Ohne Frühstück sollte die nächste geplante Mahlzeit gezeigt werden');
});

test('Today-Highlights filtert Termine auf den heutigen Tag', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const tomorrowStr = addLocalDays(todayStr, 1);

  const result = __test.buildTodayHighlights({
    events: [
      { id: 1, title: 'Termin Morgen', start_datetime: `${tomorrowStr}T10:00:00` },
      { id: 2, title: 'Termin Heute', start_datetime: `${todayStr}T14:30:00` },
    ],
  });

  assert(result.eventCount === 1, `Erwartet 1 Termin für heute, erhalten ${result.eventCount}`);
  assert(result.nextEvent.title === 'Termin Heute', 'Erwartet "Termin Heute" als nächsten Termin');
});

test('Tagesprogramm: Termin, Aufgabe und Mahlzeit mischen sich chronologisch', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());

  const result = __test.buildTodayProgram({
    upcomingEvents: [{ id: 11, title: 'Zahnarzt', start_datetime: `${todayStr}T14:00:00` }],
    urgentTasks: [{ id: 22, title: 'Zettel abgeben', due_date: todayStr, due_time: '09:30:00', status: 'open' }],
    // Nur dinner geplant: selectTodayMeal fällt zu jeder Tageszeit auf dinner
    // vor (deterministisch, kein withHour nötig).
    todayMeals: [{ id: 33, meal_type: 'dinner', title: 'Pasta' }],
  // Feste Uhr: seit #1449 verlaesst ein beendeter Termin das Programm, und
  // der um 14:00 waere am Nachmittag sonst schon vorbei.
  }, { now: todayAt(8) });

  const kinds = result.rows.map((r) => r.kind);
  nodeAssert.deepEqual(kinds, ['task', 'event', 'meal'], 'Aufgabe 09:30 → Termin 14:00 → Abendessen (nominal 18:30)');
  nodeAssert.deepEqual(result.rows.map((r) => r.objectId), [22, 11, 33], 'jede Zeile trägt ihre Objekt-ID (Deep-Link-Anker, Paket 2)');
  const sorted = [...result.rows.map((r) => r.sortKey)].sort();
  nodeAssert.deepEqual(result.rows.map((r) => r.sortKey), sorted, 'Sortierschlüssel sind aufsteigend');
  nodeAssert.equal(result.nextUpcoming, null, 'kein Termin über heute hinaus');
});

test('Tagesprogramm: Überfälliges zuerst, Ganztägiges vor zeitlosen Aufgaben', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const yesterdayStr = addLocalDays(todayStr, -1);

  const result = __test.buildTodayProgram({
    upcomingEvents: [{ id: 1, title: 'Ferienbeginn', start_datetime: todayStr, all_day: 1 }],
    urgentTasks: [
      { id: 2, title: 'Ohne Uhrzeit', due_date: todayStr, status: 'open' },
      { id: 3, title: 'Längst fällig', due_date: yesterdayStr, status: 'open' },
    ],
  });

  nodeAssert.deepEqual(
    result.rows.map((r) => r.title),
    ['Längst fällig', 'Ferienbeginn', 'Ohne Uhrzeit'],
    'Reihenfolge: überfällig (00:00) → ganztägig (00:01) → heute ohne Uhrzeit (00:02)',
  );
  nodeAssert.equal(result.rows[0].overdue, true, 'überfällige Zeile ist markiert');
});

test('formatDueDate: „Morgen fällig" erfindet ohne due_time keine Uhrzeit', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const tomorrowStr = addLocalDays(toLocalDateKey(new Date()), 1);
  // Ohne due_time ist 23:59:59 nur die interne Sortier-Krücke - sie darf nie
  // als „Morgen fällig – 23:59" im UI landen.
  const noTime = __test.formatDueDate(tomorrowStr, null);
  nodeAssert.ok(!/\d{1,2}:\d{2}/.test(noTime.text), `keine erfundene Uhrzeit, erhalten: ${noTime.text}`);
  const withTime = __test.formatDueDate(tomorrowStr, '09:30:00');
  nodeAssert.match(withTime.text, /09:30/, 'eine echte Uhrzeit bleibt sichtbar');
});

/* Die Faelligkeit folgt der ANZEIGEZONE, nicht dem Browser (#829 Teil 3, Nachlese
 * aus #851).
 *
 * `due_date`/`due_time` sind zonenlose Wanduhrzeit. Hier stand ein Umweg ueber
 * `new Date(`${date}T${time}`)`, und der machte daraus einen Zeitpunkt der
 * BROWSER-Zone - den formatDate/formatTime anschliessend in die Anzeigezone
 * umrechneten. Mit Haushalt auf Honolulu und Browser in Berlin wurde aus einer
 * fuer 21:00 eingetragenen Aufgabe eine fuer 9:00, und dieselbe Uhr entschied
 * ueber "heute"/"morgen".
 *
 * Der Test setzt die Zone ueber DENSELBEN Spezifizierer, den dashboard.js
 * benutzt (`/utils/timezone.js`) - ueber den Repo-Pfad importiert waere es eine
 * zweite Modulinstanz mit eigenem Zonen-Cache, und der Test liefe an seinem
 * eigenen Gegenstand vorbei. */
test('formatDueDate liest due_date/due_time in der Anzeigezone, nicht im Browser', async () => {
  const tz = await import('/utils/timezone.js');
  const { __test } = await import('../public/pages/dashboard.js');
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (f) => `${f.year}-${p2(f.month)}-${p2(f.day)}`;

  const ZONES = ['Pacific/Honolulu', 'Pacific/Kiritimati'];
  try {
    for (const zone of ZONES) {
      tz.setDisplayTimeZone(zone);
      const today = stamp(tz.nowFields());

      // Die eingetippte Uhrzeit bleibt die eingetippte Uhrzeit.
      //
      // Geprueft wird der STEMPEL, nicht die fertige Schreibweise: `/i18n.js` ist
      // in diesem Kontext ein Stub, der `String(d)` zurueckgibt und deshalb gar
      // nicht umrechnet - eine Assertion auf "steht 21:00 drin" waere hier gruen,
      // egal was uebergeben wird. Die Eigenschaft, an der es haengt, ist, dass
      // die zonenlose Wanduhrzeit als Stempel weitergereicht wird statt als Date
      // der Browser-Zone; nur die kann dieser Kontext sehen.
      const withTime = __test.formatDueDate(today, '21:00:00');
      nodeAssert.match(withTime.text, /\d{4}-\d{2}-\d{2}T21:00/,
        `${zone}: die Wanduhrzeit muss als Stempel an den Formatierer gehen, erhalten: ${withTime.text}`);
      nodeAssert.ok(!/GMT/.test(withTime.text),
        `${zone}: ein Date-Umweg wuerde die Zeit in der Browser-Zone einfrieren, erhalten: ${withTime.text}`);

      // Und "heute" ist der Tag der Anzeigezone, nicht der des Browsers.
      nodeAssert.match(withTime.text, /dashboard\.(dueToday|overdue)/,
        `${zone}: der heutige Tag der Anzeigezone muss als heute gelten, erhalten: ${withTime.text}`);

      const shiftDay = (key, days) => {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
      };
      nodeAssert.match(__test.formatDueDate(shiftDay(today, 1), null).text, /dashboard\.dueTomorrow/,
        `${zone}: der Folgetag der Anzeigezone ist morgen`);

      // JEDER Ausgabepfad, der eine Uhrzeit zeigt - nicht nur der heutige. Der
      // ueberfaellige und der Bald-Zweig bauen ihre Beschriftung ueber eine eigene
      // Zeile (`fullLabel`), und die blieb bei einer ersten Fassung dieses Tests
      // ungeprueft: sie kommt bei "heute faellig" gar nicht vor.
      const paths = [
        [shiftDay(today, -1), '21:00:00', /dashboard\.overdue/, 'gestern 21:00 ist ueberfaellig'],
        [shiftDay(today, 1), '23:30:00', /dashboard\.(dueSoon|dueTomorrow)/, 'morgen spaet'],
        [shiftDay(today, 1), '09:30:00', /dashboard\.dueTomorrow/, 'morgen frueh'],
        [shiftDay(today, 4), '14:00:00', /\d/, 'in vier Tagen'],
      ];
      for (const [day, time, expect, what] of paths) {
        const res = __test.formatDueDate(day, time);
        nodeAssert.match(res.text, expect, `${zone}: ${what}, erhalten: ${res.text}`);
        nodeAssert.match(res.text, new RegExp(`${day}T${time.slice(0, 5)}`),
          `${zone}: ${what} - die Wanduhrzeit muss als Stempel weitergereicht werden, erhalten: ${res.text}`);
        nodeAssert.ok(!/GMT/.test(res.text),
          `${zone}: ${what} - ein Date-Umweg friert die Zeit in der Browser-Zone ein, erhalten: ${res.text}`);
      }
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

/* Die Grenze zwischen „gleich faellig" und „schon vorbei" - an JEDER Minute des
 * Tages, nicht an der, die gerade zufaellig ist.
 *
 * Diese Probe erbte ihre Eingabe von der echten Uhr: sie las `nowFields()`,
 * rechnete `Date.UTC(...) + 60000` und reichte nur STUNDE UND MINUTE des
 * Ergebnisses weiter, den Tag aber unveraendert aus dem Vorher. Um 23:59 der
 * Anzeigezone faellt die eine Minute auf den naechsten Tag: die Uhrzeit sprang
 * auf 00:00, der Tag blieb stehen, und die angebliche „Minute in der Zukunft"
 * war in Wahrheit 23 Stunden und 59 Minuten VERGANGENHEIT. `formatDueDate`
 * antwortete voellig richtig „ueberfaellig", der Test nannte das einen Fehler.
 *
 * Ein Tageswechsel ist nicht die Zeitzone des RECHNERS - der spielt hier keine
 * Rolle, weil `zonedFields()` mit gesetzter Anzeigezone ueber
 * `Intl.DateTimeFormat` liest und `Date.UTC`/`getUTC*` reine Feldarithmetik
 * sind. Gemessen: unter TZ=UTC, TZ=Europe/Berlin und TZ=America/Los_Angeles
 * faellt exakt dieselbe eine Minute (2026-09-09T09:59Z = 23:59 in Honolulu).
 * Die Suite war deshalb 1439 Minuten am Tag gruen und blind, und der eine rote
 * Lauf sah aus wie eine Zonenabhaengigkeit, weil er nur dem einen Rechner
 * begegnete, der gerade lief.
 *
 * Deshalb steht hier BEIDES still: die Anzeigezone (wie in den Proben darueber)
 * und die Uhr. Zwischen dem Stellen und dem Zuruecksetzen liegt kein `await` -
 * die Tests dieser Datei laufen verschraenkt, und ein `await` mitten drin
 * uebergaebe einer anderen Probe eine gestellte Uhr und eine fremde Zone.
 */
test('formatDueDate: die Faelligkeitsgrenze haelt an jeder Minute des Tages', async () => {
  const tz = await import('/utils/timezone.js');
  const { __test } = await import('../public/pages/dashboard.js');

  // Ab hier synchron.
  const RealDate = Date;
  let fixedMs = RealDate.UTC(2026, 8, 9);
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedMs])); }
    static now() { return fixedMs; }
  }

  const p2 = (n) => String(n).padStart(2, '0');
  const dayOf = (f) => `${f.year}-${p2(f.month)}-${p2(f.day)}`;
  // Wanduhr-Felder plus/minus Minuten - dieselbe Feldarithmetik, die
  // `formatDueDate` intern fuehrt, und diesmal MIT dem Tagesuebertrag.
  const shiftWallMinutes = (f, minutes) => {
    const d = new RealDate(RealDate.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) + minutes * 60000);
    return {
      day: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
      time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    };
  };

  try {
    globalThis.Date = FrozenDate;
    // Eine westlich von UTC (-10), eine knapp oestlich (+2) und eine am
    // aeussersten Ostrand (+14): der Tageswechsel der Anzeigezone faellt in
    // jeder auf eine andere UTC-Minute, und in Kiritimati liegt er sogar auf
    // einem anderen UTC-Datum.
    for (const zone of ['Pacific/Honolulu', 'Europe/Berlin', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      let sawLastMinuteOfDay = 0;

      // Ein voller Tag im Minutenraster - damit ist die 23:59 der Zone
      // zwangslaeufig dabei, in welcher Zone auch immer.
      for (let i = 0; i < 1440; i++) {
        fixedMs = RealDate.UTC(2026, 8, 9) + i * 60000;
        const now = tz.nowFields();
        const when = `${zone} @ ${dayOf(now)} ${p2(now.hour)}:${p2(now.minute)}`;
        if (now.hour === 23 && now.minute === 59) sawLastMinuteOfDay += 1;

        // Eine Minute spaeter ist noch nicht vorbei - auch wenn sie ueber
        // Mitternacht faellt.
        const future = shiftWallMinutes(now, 1);
        const ahead = __test.formatDueDate(future.day, future.time);
        nodeAssert.equal(ahead.overdue, false,
          `${when}: eine Minute spaeter (${future.day} ${future.time}) ist nicht ueberfaellig, erhalten: ${ahead.text}`);

        // Und eine Minute frueher ist es. Ohne diese Haelfte bestuende die Probe
        // auch dann, wenn `formatDueDate` gar nichts mehr ueberfaellig nennt.
        const past = shiftWallMinutes(now, -1);
        const behind = __test.formatDueDate(past.day, past.time);
        nodeAssert.equal(behind.overdue, true,
          `${when}: eine Minute frueher (${past.day} ${past.time}) ist ueberfaellig, erhalten: ${behind.text}`);

        // Die Grenze selbst: genau jetzt faellig ist noch nicht vorbei. Ohne
        // diesen Fall bliebe ein `<=` statt `<` in `formatDueDate` unbemerkt -
        // gemessen: die Probe war mit dieser Aenderung gruen.
        const same = shiftWallMinutes(now, 0);
        const onTime = __test.formatDueDate(same.day, same.time);
        nodeAssert.equal(onTime.overdue, false,
          `${when}: genau jetzt faellig (${same.day} ${same.time}) ist noch nicht ueberfaellig, erhalten: ${onTime.text}`);
      }

      // Sonst haette das Raster die Stelle, um die es geht, gar nicht getroffen.
      nodeAssert.equal(sawLastMinuteOfDay, 1,
        `${zone}: das Raster muss den Tageswechsel genau einmal enthalten, gezaehlt: ${sawLastMinuteOfDay}`);
    }
  } finally {
    globalThis.Date = RealDate;
    tz.setDisplayTimeZone(null);
  }
});

/* „Heute"/„Morgen" an einem echten ZEITPUNKT (#829, Nachlese #851).
 *
 * Hier stand `d.toDateString() === new Date().toDateString()` - beide Seiten in
 * der Browser-Zone. `d` ist an dieser Stelle oft ein synchronisierter Termin,
 * also ein Instant mit eigener Zone: ein Geraet in einer anderen Zone nannte
 * denselben Termin „Heute", waehrend er im Haushalt morgen liegt. Anders als bei
 * `formatDueDate` wird hier wirklich UMGERECHNET, denn ein Instant traegt seine
 * Zone selbst - das ist der Unterschied, den utils/timezone.js fuehrt.
 *
 * Geprueft wird die EIGENSCHAFT ueber ein Raster, nicht ein konstruierter
 * Einzelfall: „das Label heisst genau dann heute, wenn der Tag des Zeitpunkts in
 * der Anzeigezone der heutige ist". Eine erste Fassung setzte einen einzelnen
 * Zeitpunkt und war gruen und blind - er fiel zufaellig in BEIDEN Zonen auf
 * heute, also unterschied er die Fassungen nicht. Ein Raster ueber zwei Tage
 * trifft die Abweichung zwangslaeufig, sobald die Zonen auseinanderliegen. */
test('relativeDateLabel benennt einen Zeitpunkt in der Anzeigezone', async () => {
  const tz = await import('/utils/timezone.js');
  const { __test } = await import('../public/pages/dashboard.js');
  const shiftDay = (key, days) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
  };

  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      const n = tz.nowFields();
      const p2 = (x) => String(x).padStart(2, '0');
      const today = `${n.year}-${p2(n.month)}-${p2(n.day)}`;

      let sawToday = 0;
      let sawTomorrow = 0;
      // Alle zwei Stunden ueber zwei Tage, ab jetzt.
      for (let h = 0; h < 48; h += 2) {
        const d = new Date(Date.now() + h * 3600000);
        const dayInZone = tz.zonedDateKey(d);
        const label = __test.relativeDateLabel(d);

        if (dayInZone === today) {
          nodeAssert.equal(label, 'common.today',
            `${zone}: +${h}h faellt in der Anzeigezone auf heute (${dayInZone}), heisst aber "${label}"`);
          sawToday += 1;
        } else if (dayInZone === shiftDay(today, 1)) {
          nodeAssert.equal(label, 'common.tomorrow',
            `${zone}: +${h}h faellt auf morgen (${dayInZone}), heisst aber "${label}"`);
          sawTomorrow += 1;
        } else {
          nodeAssert.ok(label !== 'common.today' && label !== 'common.tomorrow',
            `${zone}: +${h}h faellt auf ${dayInZone}, traegt aber "${label}"`);
        }
      }
      // Sonst haette das Raster nichts geprueft.
      nodeAssert.ok(sawToday > 0 && sawTomorrow > 0,
        `${zone}: das Raster traf weder heute noch morgen - es prueft nichts`);
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

/* Ein DATUMS-KEY wird gelesen, ein ZEITPUNKT umgerechnet - und ein Date, das aus
 * einem Key gebaut wurde, ist die gefaehrliche Mitte.
 *
 * Die erste Fassung dieses Fixes schickte alles durch `zonedDateKey()`. Fuer
 * einen echten Instant und fuer einen Key-STRING ist das richtig - `zonedFields`
 * liest zonenlose Strings, statt sie zu rechnen. Fuer
 * `parseLocalDateKey('2026-08-25')` aber, also Mitternacht der BROWSER-Zone, ist
 * es einen Tag daneben: damit war derselbe Fehler wieder da, gegen den dieser PR
 * angetreten ist, nur ueber einen anderen Weg.
 *
 * Die Pflicht liegt deshalb beim AUFRUFER, und genau dort setzt dieser Test an:
 * nicht an `relativeDateLabel` (das war nie kaputt, wenn man ihm einen String
 * gab), sondern an den Stellen, die vorher ein Date daraus bauten. Ein Test auf
 * die Funktion allein waere gruen und blind gewesen - gemessen, nicht vermutet. */
test('die Termin-Auswahl "heute" folgt der Anzeigezone, nicht dem Browser', async () => {
  const tz = await import('/utils/timezone.js');
  const { __test } = await import('../public/pages/dashboard.js');
  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      const n = tz.nowFields();
      const p2 = (x) => String(x).padStart(2, '0');
      const today = `${n.year}-${p2(n.month)}-${p2(n.day)}`;
      const shift = (days) => {
        const [y, m, d] = today.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
      };

      const res = __test.buildTodayHighlights({
        events: [
          { id: 1, title: 'Heute', start_datetime: `${today}T10:00` },
          { id: 2, title: 'Morgen', start_datetime: `${shift(1)}T10:00` },
          { id: 3, title: 'Gestern', start_datetime: `${shift(-1)}T10:00` },
        ],
      });
      nodeAssert.equal(res.nextEvent?.title, 'Heute',
        `${zone}: nur der Termin am heutigen Tag DER ANZEIGEZONE zaehlt, bekam: ${res.nextEvent?.title}`);
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

test('relativeDateLabel benennt einen Datums-Key ohne ihn umzurechnen', async () => {
  const tz = await import('/utils/timezone.js');
  const { __test } = await import('../public/pages/dashboard.js');
  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      const n = tz.nowFields();
      const p2 = (x) => String(x).padStart(2, '0');
      const today = `${n.year}-${p2(n.month)}-${p2(n.day)}`;
      const shift = (days) => {
        const [y, m, d] = today.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
      };
      nodeAssert.equal(__test.relativeDateLabel(today), 'common.today', zone);
      nodeAssert.equal(__test.relativeDateLabel(shift(1)), 'common.tomorrow', zone);
      nodeAssert.ok(!['common.today', 'common.tomorrow'].includes(__test.relativeDateLabel(shift(3))), zone);
      nodeAssert.equal(__test.relativeDateLabel(null), '', 'kein Wert, kein Label');
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

test('Tagesprogramm: Ausblick kennt die nächste fällige Aufgabe über heute hinaus', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const tomorrowStr = addLocalDays(todayStr, 1);
  const result = __test.buildTodayProgram({
    urgentTasks: [{ id: 5, title: 'Zettel abgeben', due_date: tomorrowStr, status: 'open' }],
  });
  nodeAssert.equal(result.rows.length, 0, 'morgen Fälliges erzeugt keine Heute-Zeile');
  nodeAssert.equal(result.nextDueTask?.id, 5, 'die nächste Frist steht als Ausblick bereit');
});

test('Cockpit-Coda nennt die morgen fällige Aufgabe statt falscher Entwarnung', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const tomorrowStr = addLocalDays(todayStr, 1);
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    // Programm hat eine Heute-Zeile UND morgen ist etwas fällig → Coda-Variante.
    const withTomorrow = __test.renderTodayCockpit({
      upcomingEvents: [{ id: 1, title: 'Heute Abend', start_datetime: `${todayStr}T20:00:00` }],
      urgentTasks: [{ id: 5, title: 'Zettel abgeben', due_date: tomorrowStr, status: 'open' }],
    // Feste Uhr (#1449): nach 20 Uhr waere der Termin vorbei und die Zeile weg.
    }, [], false, { now: todayAt(9) });
    nodeAssert.match(withTomorrow, /todayNothingElseTomorrow/, 'Coda warnt vor der Morgen-Frist');
    // Leerer Tag, nur die Morgen-Aufgabe → Zustandszeile trägt sie als Ausblick.
    const stateRow = __test.renderTodayCockpit({
      urgentTasks: [{ id: 5, title: 'Zettel abgeben', due_date: tomorrowStr, status: 'open' }],
    }, []);
    nodeAssert.match(stateRow, /todayFree/, 'leerer Tag zeigt die Zustandszeile');
    nodeAssert.match(stateRow, /todayNextUp/, 'der Ausblick nennt die Morgen-Aufgabe');
  } finally {
    global.window = prevWindow;
  }
});

test('"Heute frei"/"Fuer heute alles erledigt" entfaellt neben einer sichtbaren Schichtplan-Kachel (S-18)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    // Ohne Schedule-Kachel (Vorgabe): der leere Tag darf "Heute frei" sagen.
    const withoutWidget = __test.renderTodayCockpit({}, []);
    nodeAssert.match(withoutWidget, /todayFree/, 'ohne sichtbare Schichtplan-Kachel bleibt die alte Zustandszeile');
    // Mit sichtbarer Schedule-Kachel: dieselbe leere Aufgaben/Termin-Lage darf
    // NICHT mehr "Heute frei" behaupten - die Kachel daneben koennte etwas
    // ganz anderes zeigen (der urspruengliche Befund: eine echte Schicht).
    const withWidget = __test.renderTodayCockpit({}, [{ id: 'schedule', visible: true }]);
    nodeAssert.ok(!/todayFree/.test(withWidget), 'eine sichtbare Schichtplan-Kachel darf nicht neben "Heute frei" widersprochen werden');
    // Dieselbe Regel fuer die "alles erledigt"-Variante (erledigte Aufgaben,
    // sonst nichts): auch sie ist neben der Kachel eine unvollstaendige Story.
    const allDoneWithWidget = __test.renderTodayCockpit(
      { urgentTasks: [{ id: 1, title: 'x', due_date: toLocalDateKey(new Date()), status: 'done' }] },
      [{ id: 'schedule', visible: true }],
    );
    nodeAssert.ok(!/todayAllDone/.test(allDoneWithWidget), '"alles erledigt" entfaellt ebenso neben einer sichtbaren Schichtplan-Kachel');
  } finally {
    global.window = prevWindow;
  }
});

// Review of #1099, finding 11: scheduleWidgetVisible read only widgetShown('schedule')
// (the layout config's `visible` flag), never isModuleDisabled('schedule') -
// unlike domainInCockpit() above it, which checks both. A household that
// disables the Schedule module can be left with a stale layout entry still
// carrying `visible: true` (nothing prunes it on disable), which would
// silently suppress "Heute frei"/"Fuer heute alles erledigt" forever, even
// though no Schedule tile is actually rendering anything anymore.
test('a disabled Schedule module cannot suppress "Heute frei" via a stale widget-layout entry (#1099 finding 11)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const prevWindow = global.window;
  try {
    // Modul aktiv + Kachel sichtbar (Ausgangslage von S-18 oben): weiterhin
    // unterdrueckt.
    global.window = { yuvomi: { isModuleDisabled: () => false } };
    const enabledWithWidget = __test.renderTodayCockpit({}, [{ id: 'schedule', visible: true }]);
    nodeAssert.ok(!/todayFree/.test(enabledWithWidget), 'bei aktivem Modul mit sichtbarer Kachel bleibt die Unterdrueckung');

    // Modul deaktiviert, Layout traegt aber noch die alte `visible: true`-Zeile:
    // die Kachel zeigt nichts mehr, "Heute frei" darf wieder erscheinen.
    global.window = { yuvomi: { isModuleDisabled: (m) => m === 'schedule' } };
    const disabledWithStaleWidget = __test.renderTodayCockpit({}, [{ id: 'schedule', visible: true }]);
    nodeAssert.match(disabledWithStaleWidget, /todayFree/, 'ein abgeschaltetes Modul darf "Heute frei" nicht ueber eine stehengebliebene Layout-Zeile unterdruecken');
  } finally {
    global.window = prevWindow;
  }
});

/* DAS HEUTE-BLATT KENNT JEDE QUELLE, DIE ETWAS OFFEN HAT (Critique 23.09.2026,
 * P1). Gemessen an Linda: zwei offene Dosen um 08:00 und eine wartende
 * Freigabe lagen in derselben Antwort, und das Blatt schloss mit „Danach steht
 * heute nichts mehr an". Die Faelle unten laufen alle ueber das MODELL, das
 * Cockpit und Wand gemeinsam lesen - und mit fester Uhr: offen oder nicht
 * haengt an der Tageszeit (Dosis faellig, Tonne vor Mittag). */
function todayAt(hour, minute = 0) {
  const now = new Date();
  now.setHours(hour, minute, 0, 0);
  return now;
}

async function withSheetEnv({ perms = { admin: true }, disabled = [] } = {}, fn) {
  const { __test } = await import('../public/pages/dashboard.js');
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: (m) => disabled.includes(m) } };
  setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {}, ...perms });
  try {
    return fn(__test);
  } finally {
    clearPermissions();
    global.window = prevWindow;
  }
}

const sheetKinds = (model) => model.rows.map((row) => row.kind);
const eveningEvent = () => ({ id: 1, title: 'Elternabend', start_datetime: `${toLocalDateKey(new Date())}T20:00:00` });
const openDoses = () => ({ hasMeds: true, dosesTotal: 2, dosesTaken: 0, dosesSkipped: 0, nextDose: { name: 'Eisen', time: '08:00' } });

test('Heute-Blatt: eine offene Dosis steht im Blatt und haelt die Coda auf', () => withSheetEnv({}, (__test) => {
  const model = __test.buildTodayCockpitModel(
    { upcomingEvents: [eveningEvent()], health: openDoses() }, [], { now: todayAt(9) },
  );
  nodeAssert.ok(sheetKinds(model).includes('dose'), `die Dosis ist eine Zeile, erhalten: ${sheetKinds(model)}`);
  nodeAssert.equal(model.coda, null, 'keine Entwarnung, solange eine Dosis offen ist');

  const taken = __test.buildTodayCockpitModel(
    { upcomingEvents: [eveningEvent()], health: { ...openDoses(), dosesTaken: 2, nextDose: null } }, [], { now: todayAt(9) },
  );
  nodeAssert.ok(!sheetKinds(taken).includes('dose'), 'genommene Dosen sind keine offene Zeile');
  nodeAssert.match(String(taken.coda), /todayNothingElse/, 'sind alle genommen, faellt die Coda wieder');
}));

test('Heute-Blatt: die wartende Freigabe spricht nur zu Admins', async () => {
  const data = { upcomingEvents: [eveningEvent()], rewards: { view: 'approver', standings: [], participantCount: 0, pending: 2 } };
  await withSheetEnv({ perms: { admin: true } }, (__test) => {
    const model = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
    nodeAssert.ok(sheetKinds(model).includes('approval'), 'der Admin sieht die Freigabe');
    nodeAssert.equal(model.coda, null, 'und keine Entwarnung daneben');
  });
  // Das Kind bekommt vom Server die Sicht `self`; `pending` zaehlt dort seine
  // eigenen Bitten (siehe den Test "(a2 x a8)" darunter).
  const kid = { ...data, rewards: { view: 'self', me: 7, standings: [], participantCount: 0, pending: 1 } };
  await withSheetEnv({ perms: { admin: false } }, (__test) => {
    const model = __test.buildTodayCockpitModel(kid, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('approval'), 'ein Kind entscheidet keine Freigaben');
    nodeAssert.match(String(model.coda), /todayNothingElse/, 'fuer das Kind ist der Tag ohne sie vollstaendig');
  });
});

/* DIE SICHT KOMMT VOM SERVER (Integration 2026-09-23, a2 x a8). Seit der
 * Belohnungs-Umbau liefert /dashboard `rewards.pending` je Sicht: `approver`
 * zaehlt alle offenen Anfragen, `self` nur die EIGENEN des Kindes. Die
 * Blatt-Quelle fragte nur das Client-Recht `isAdmin` - wer die Anfrage-Zahl
 * eines Kindes mit gesetztem Admin-Flag (veralteter Rechte-Stand, anderes
 * Konto im selben Speicher) bekam, las die eigene Bitte als "Freigabe". Die
 * Antwort traegt die Entscheidung schon; das Blatt folgt ihr. */
test('Heute-Blatt: Freigaben sprechen nur in der Sicht "approver" (a2 x a8)', async () => {
  const self = { upcomingEvents: [eveningEvent()], rewards: { view: 'self', me: 7, standings: [], pending: 1 } };
  await withSheetEnv({ perms: { admin: true } }, (__test) => {
    const model = __test.buildTodayCockpitModel(self, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('approval'),
      `die eigene Anfrage eines Kindes ist keine Freigabe, erhalten: ${sheetKinds(model)}`);
  });
  const family = { upcomingEvents: [eveningEvent()], rewards: { view: 'family', standings: [], pending: 0 } };
  await withSheetEnv({ perms: { admin: true } }, (__test) => {
    const model = __test.buildTodayCockpitModel(family, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('approval'), 'die Familien-Sicht kennt keine Freigaben');
  });
});

/* DIE ZAHL OFFENER FREIGABEN STEHT GENAU EINMAL: Belohnungen-Widget vor
 * Heute-Blatt vor Eltern-Kennzahlkachel. Widget sichtbar -> Blatt und Kachel
 * schweigen (Kein-Echo, `shown`); Widget aus, Blatt da -> nur das Blatt; Blatt
 * ausgeblendet -> die Kachel. Geprueft am AUFRUFER (`renderDashboardLayout`),
 * weil die Kachel nur dort erfaehrt, ob das Blatt die Zahl schon traegt. */
test('Freigaben: die Zahl steht an genau einer Stelle - Widget > Heute-Blatt > Kennzahlkachel', async () => {
  const data = {
    upcomingEvents: [eveningEvent()],
    // Budget und Geburtstag halten die Reihe bei mindestens zwei Kacheln.
    budget: { entryCount: 3, balance: 100, income: 200 },
    birthdays: [{ name: 'Oma', days_until: 5, kind: 'birthday' }],
    rewards: { view: 'approver', me: 1, standings: [], participantCount: 2, pending: 2, catalog: [] },
  };
  const metricsOnly = [{ id: 'metrics', visible: true, size: '2x1' }];
  const pendingTile = (html) => /metric-card[^]*?rewardsPending/.test(html);
  await withSheetEnv({ perms: { admin: true } }, (__test) => {
    const sheet = __test.buildTodayCockpitModel(data, metricsOnly, { now: todayAt(9) });
    nodeAssert.ok(sheetKinds(sheet).includes('approval'), 'ohne Belohnungen-Widget traegt das Blatt die Freigabe');
    const withSheet = __test.renderDashboardLayout(metricsOnly, data, null, 'EUR', { glanceHidden: false });
    nodeAssert.ok(!pendingTile(withSheet), 'neben dem Blatt nennt die Kennzahlkachel die Freigaben nicht noch einmal');
    const withoutSheet = __test.renderDashboardLayout(metricsOnly, data, null, 'EUR', { glanceHidden: true });
    nodeAssert.ok(pendingTile(withoutSheet), 'ist das Blatt ausgeblendet, traegt die Kachel die Zahl');
    const withWidget = [...metricsOnly, { id: 'rewards', visible: true, size: '1x2' }];
    const sheetBesideWidget = __test.buildTodayCockpitModel(data, withWidget, { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(sheetBesideWidget).includes('approval'), 'neben dem Widget schweigt das Blatt');
    const layout = __test.renderDashboardLayout(withWidget, data, null, 'EUR', { glanceHidden: false });
    nodeAssert.ok(!pendingTile(layout.replace(/<div class="widget widget--rewards[^]*$/, '')),
      'neben dem Widget schweigt die Kachel');
  });
});

/* Dieselbe Regel fuer die Dosen (Browser-Abnahme der Integration: „2 Dosen
 * offen" im Blatt, „2 offen" in der Gesundheits-Kachel darunter). Die Kachel
 * tritt zurueck, solange das Blatt die offenen Dosen nennt - ausser eine
 * Packung muss nachbestellt werden: das sagt das Blatt nicht. */
test('Dosen: die Zahl offener Dosen steht nicht in Blatt UND Kennzahlkachel', async () => {
  const data = {
    budget: { entryCount: 3, balance: 100, income: 200 },
    birthdays: [{ name: 'Oma', days_until: 5, kind: 'birthday' }],
    health: { ...openDoses(), lowStockCount: 0 },
  };
  const metricsOnly = [{ id: 'metrics', visible: true, size: '2x1' }];
  const healthTile = (html) => /metric-card[^]*?metricDoses/.test(html);
  await withSheetEnv({ perms: { admin: true } }, (__test) => {
    nodeAssert.ok(sheetKinds(__test.buildTodayCockpitModel(data, metricsOnly, { now: todayAt(7) })).includes('dose'),
      'Vorbedingung: das Blatt nennt die Dosen');
    nodeAssert.ok(!healthTile(__test.renderDashboardLayout(metricsOnly, data, null, 'EUR', { glanceHidden: false })),
      'neben dem Blatt keine zweite Dosen-Zahl');
    nodeAssert.ok(healthTile(__test.renderDashboardLayout(metricsOnly, data, null, 'EUR', { glanceHidden: true })),
      'ohne Blatt traegt die Kachel sie');
    const refill = { ...data, health: { ...data.health, lowStockCount: 1 } };
    nodeAssert.match(__test.renderDashboardLayout(metricsOnly, refill, null, 'EUR', { glanceHidden: false }), /healthRefill/,
      'eine Nachbestellung sagt das Blatt nicht - die Kachel bleibt');
  });
});

test('Heute-Blatt: die Tonne von heute und die von morgen (heute Abend rausstellen)', () => withSheetEnv({}, (__test) => {
  const today = toLocalDateKey(new Date());
  const tomorrow = addLocalDays(today, 1);
  const morning = __test.buildTodayCockpitModel({
    upcomingEvents: [eveningEvent()],
    wastePickups: [
      { date_key: today, type_name: 'Restmuell', deep_link: '?type=1' },
      { date_key: today, type_name: 'Papier', deep_link: '?type=2' },
    ],
  }, [], { now: todayAt(7) });
  const wasteRows = morning.rows.filter((row) => row.kind === 'waste');
  nodeAssert.equal(wasteRows.length, 1, 'zwei Tonnen eines Tages sind eine Zeile');
  nodeAssert.match(wasteRows[0].title, /Restmuell.*Papier/);
  nodeAssert.equal(morning.coda, null, 'am Morgen muss die Tonne noch raus - keine Entwarnung');

  const afternoon = __test.buildTodayCockpitModel({
    upcomingEvents: [eveningEvent()],
    wastePickups: [{ date_key: today, type_name: 'Restmuell' }],
  }, [], { now: todayAt(15) });
  nodeAssert.ok(sheetKinds(afternoon).includes('waste'), 'am Nachmittag bleibt die Auskunft stehen');
  nodeAssert.match(String(afternoon.coda), /todayNothingElse/, 'die abgeholte Tonne haelt die Coda nicht auf');

  const eve = __test.buildTodayCockpitModel({ wastePickups: [{ date_key: tomorrow, type_name: 'Bio' }] }, [], { now: todayAt(9) });
  const tonight = eve.rows.find((row) => row.kind === 'waste');
  nodeAssert.match(String(tonight?.sub), /todayWasteTonight/, 'die Abholung von morgen heisst: heute Abend rausstellen');
  nodeAssert.equal(eve.coda, null);
  nodeAssert.equal(eve.state, null, 'ein Tag mit offener Tonne ist nicht „heute frei"');
}));

test('Heute-Blatt: die Coda faellt, wenn alles Offene erledigt ist', () => withSheetEnv({}, (__test) => {
  const model = __test.buildTodayCockpitModel({
    upcomingEvents: [eveningEvent()],
    health: { ...openDoses(), dosesTaken: 1, dosesSkipped: 1, nextDose: null },
    rewards: { pending: 0 },
    wastePickups: [],
    housekeeping: { present: true, presentSince: `${toLocalDateKey(new Date())}T08:30:00`, workerName: 'Maria' },
  }, [], { now: todayAt(9) });
  nodeAssert.deepEqual(sheetKinds(model).sort(), ['event', 'housekeeping'], 'Termin und Auskunft, nichts Offenes');
  nodeAssert.match(String(model.coda), /todayNothingElse/, 'nichts mehr offen - jetzt stimmt die Entwarnung');
}));

/* Gefunden in der Browser-Verifikation: der Check-in der Haushaltshilfe ist ein
 * Instant ('...Z'), und die Zeile las ihren Platz im Tag per Regex aus dem
 * String - also in UTC, waehrend die Beschriftung daneben die Haushaltszone
 * zeigte. „seit 08:30" stand deshalb HINTER einer Dosis um 08:00 nicht,
 * sondern davor. Die Zone ist hier fest auf Honolulu gestellt, damit der Fall
 * auch in einer CI in UTC rot werden kann. */
test('Heute-Blatt: die Haushaltshilfe sortiert nach der Haushaltsuhr, nicht nach UTC', async () => {
  const tz = await import('/utils/timezone.js');
  await withSheetEnv({}, (__test) => {
    tz.setDisplayTimeZone('Pacific/Honolulu');
    try {
      const now = new Date();
      const today = tz.zonedDateKey(now);
      const model = __test.buildTodayCockpitModel({
        housekeeping: { present: true, presentSince: `${today}T18:30:00Z`, workerName: 'Maria' },
      }, [], { now });
      const row = model.rows.find((r) => r.kind === 'housekeeping');
      nodeAssert.equal(row?.sortKey, tz.zonedTimeKey(`${today}T18:30:00Z`), 'der Platz im Tag ist die Wanduhr des Haushalts');
      nodeAssert.equal(row.sortKey, '08:30');
    } finally {
      tz.setDisplayTimeZone(null);
    }
  });
});

test('Heute-Blatt: Kein-Echo gilt auch fuer die neuen Quellen', () => withSheetEnv({}, (__test) => {
  const today = toLocalDateKey(new Date());
  const data = {
    health: openDoses(),
    rewards: { view: 'approver', pending: 1 },
    wastePickups: [{ date_key: today, type_name: 'Restmuell' }],
    myShiftsToday: [{ shift_type: { id: 3, name: 'Fruehdienst', start_time: '06:00', end_time: '14:00' } }],
    housekeeping: { present: true, presentSince: `${today}T08:30:00`, workerName: 'Maria' },
    birthdays: [{ id: 4, name: 'Oma Erna', days_until: 0, kind: 'birthday' }],
  };
  const all = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
  nodeAssert.deepEqual(
    [...new Set(sheetKinds(all))].sort(),
    ['approval', 'birthday', 'dose', 'housekeeping', 'shift', 'waste'],
    'Vorbedingung: ohne Kacheln spricht jede Quelle',
  );
  for (const [widget, kind] of [['health', 'dose'], ['rewards', 'approval'], ['waste', 'waste'],
    ['schedule', 'shift'], ['housekeeping', 'housekeeping'], ['birthdays', 'birthday']]) {
    const model = __test.buildTodayCockpitModel(data, [{ id: widget, visible: true }], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes(kind), `sichtbare ${widget}-Kachel: keine ${kind}-Zeile im Blatt`);
    nodeAssert.ok(sheetKinds(model).length > 0, 'die uebrigen Quellen sprechen weiter');
  }
}));

test('Heute-Blatt: ohne Gesundheitsrecht keine Dosen, abgeschaltetes Modul spricht nicht', async () => {
  const data = { upcomingEvents: [eveningEvent()], health: openDoses() };
  // Die Gegenprobe zuerst: ein Mitglied mit vollen Rechten sieht die Dosis.
  // Ohne sie waere jede Abwesenheit unten auch beim Nichtstun gruen.
  await withSheetEnv({ perms: { admin: false } }, (__test) => {
    const model = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
    nodeAssert.ok(sheetKinds(model).includes('dose'), 'Vorbedingung: mit Recht steht die Dosis im Blatt');
  });
  await withSheetEnv({ perms: { admin: false, widgets: { health: 'none' } } }, (__test) => {
    const model = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('dose'), 'ein gesperrtes Gesundheits-Widget heisst: keine Dosen im Blatt');
  });
  await withSheetEnv({ perms: { admin: false, modules: { health: 'none' } } }, (__test) => {
    const model = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('dose'), 'ein gesperrtes Gesundheitsmodul ebenso');
  });
  await withSheetEnv({ disabled: ['health'] }, (__test) => {
    const model = __test.buildTodayCockpitModel(data, [], { now: todayAt(9) });
    nodeAssert.ok(!sheetKinds(model).includes('dose'), 'ein abgeschaltetes Modul spricht nicht');
  });
});

/* Review #1450: die Erinnerungs-Quelle hat keine eigene Kachel und lief deshalb
 * am Widget-Riegel von sourceSpeaks() vorbei. Ein gesperrtes Gesundheits-Widget
 * hielt die Dosen stumm, eine faellige Vorsorge-Erinnerung stand trotzdem
 * mit ihrem Titel im Blatt; ebenso Abo (budget), Aufgabe und Termin. */
test('Heute-Blatt: eine Erinnerung folgt dem Widget-Recht ihres Moduls', async () => {
  const reminders = [
    { id: 1, entity_type: 'health_prevention_due', entity_id: 7, entity_title: 'Darmkrebs-Vorsorge' },
    { id: 2, entity_type: 'subscription', entity_id: 8, entity_title: 'Streaming-Abo' },
    { id: 3, entity_type: 'task', entity_id: 9, entity_title: 'Steuer abgeben' },
    { id: 4, entity_type: 'event', entity_id: 10, entity_title: 'Zahnarzt' },
    { id: 5, entity_type: 'document_expiry', entity_id: 11, entity_title: 'Reisepass' },
  ];
  const titles = (model) => model.rows.filter((r) => r.kind === 'reminder').map((r) => r.title).sort();
  await withSheetEnv({ perms: { admin: false } }, (__test) => {
    const model = __test.buildTodayCockpitModel({ pendingReminders: reminders }, [], { now: todayAt(9) });
    nodeAssert.deepEqual(titles(model), ['Darmkrebs-Vorsorge', 'Reisepass', 'Steuer abgeben', 'Streaming-Abo', 'Zahnarzt'],
      'Vorbedingung: mit allen Rechten spricht jede Erinnerung');
  });
  await withSheetEnv({ perms: { admin: false, widgets: { health: 'none', budget: 'none', tasks: 'none', calendar: 'none' } } }, (__test) => {
    const model = __test.buildTodayCockpitModel({ pendingReminders: reminders }, [], { now: todayAt(9) });
    nodeAssert.deepEqual(titles(model), ['Reisepass'],
      'gesperrte Widgets heissen: keine Erinnerung aus ihrem Modul; ohne eigene Kachel (Dokumente) bleibt nur das Modulrecht');
  });
});

test('Heute-Blatt: unter dem Deckel bleibt, was offen ist', () => withSheetEnv({}, (__test) => {
  const today = toLocalDateKey(new Date());
  const events = Array.from({ length: 7 }, (_, i) => ({
    id: 100 + i, title: `Termin ${i}`, start_datetime: `${today}T${String(10 + i).padStart(2, '0')}:00:00`,
  }));
  const model = __test.buildTodayCockpitModel(
    { upcomingEvents: events, health: { ...openDoses(), nextDose: { name: 'Eisen', time: '23:00' } } },
    [], { now: todayAt(9) },
  );
  nodeAssert.ok(sheetKinds(model).includes('dose'), 'die offene Dosis spaet am Abend faellt nicht unter den Deckel');
  nodeAssert.equal(model.rows.length, __test.PROGRAM_ROW_CAP);
  nodeAssert.equal(model.overflow, 2);
  nodeAssert.equal(model.coda, null);
}));

test('Wand: dieselben Quellen, dieselbe Coda-Regel wie das Cockpit', () => withSheetEnv({}, (__test) => {
  const data = { upcomingEvents: [eveningEvent()], health: openDoses(), users: [] };
  const html = __test.renderWallSurface(data, null, { now: todayAt(9) });
  nodeAssert.match(html, /wall-row--health/, 'die Dosis steht auch an der Wand');
  nodeAssert.ok(!/todayNothingElse/.test(html), 'und die Wand gibt keine falsche Entwarnung');
  const done = __test.renderWallSurface(
    { upcomingEvents: [eveningEvent()], health: { ...openDoses(), dosesTaken: 2, nextDose: null }, users: [] },
    null, { now: todayAt(9) },
  );
  nodeAssert.match(done, /todayNothingElse/, 'alles genommen: die Wand schliesst mit der Coda');
}));

/* #1449: BEENDETE TERMINE TRETEN ZURUECK. Das Blatt verspricht, was heute NOCH
 * ansteht; ein Termin, dessen Ende hinter uns liegt, verlaesst es. Die
 * Termin-Kachel behaelt ihn, aber zurueckgetreten und oberhalb des Kommenden -
 * und ihr Fuenfer-Limit zaehlt nur das Kommende. */
test('Heute-Blatt: ein beendeter Termin verlaesst das Blatt (#1449)', () => withSheetEnv({}, (__test) => {
  const today = toLocalDateKey(new Date());
  const model = __test.buildTodayCockpitModel({
    upcomingEvents: [
      { id: 1, title: 'Fruehsport', start_datetime: `${today}T06:30:00`, end_datetime: `${today}T07:30:00` },
      { id: 2, title: 'Laeuft noch', start_datetime: `${today}T08:30:00`, end_datetime: `${today}T10:00:00` },
      { id: 3, title: 'Ganztags', start_datetime: today, all_day: 1 },
      eveningEvent(),
    ],
  }, [], { now: todayAt(9) });
  const titles = model.rows.map((row) => row.title);
  nodeAssert.ok(!titles.includes('Fruehsport'), `der beendete Termin ist weg, erhalten: ${titles}`);
  nodeAssert.ok(titles.includes('Laeuft noch'), 'ein laufender Termin bleibt');
  nodeAssert.ok(titles.includes('Ganztags'), 'ein Ganztagstermin endet nicht an seinem Tag');
}));

test('Termin-Kachel: beendete Termine treten zurueck, das Limit zaehlt nur Kommendes (#1449)', () => withSheetEnv({}, (__test) => {
  const today = toLocalDateKey(new Date());
  const ended = Array.from({ length: 5 }, (_, i) => ({
    id: 10 + i, title: `Vorbei ${i}`,
    start_datetime: `${today}T0${i + 1}:00:00`, end_datetime: `${today}T0${i + 1}:30:00`,
  }));
  const html = __test.renderUpcomingEvents([...ended, eveningEvent()], { now: todayAt(19, 28) });
  nodeAssert.match(html, /Elternabend/, 'der kommende Abendtermin steht in der Kachel');
  const endedRows = html.match(/event-item--ended/g) ?? [];
  nodeAssert.equal(endedRows.length, 2, 'die zwei juengsten beendeten stehen zurueckgetreten darueber');
  nodeAssert.match(html, /eventsEndedMore/, 'der Rest faltet sich in eine Zahl');
  nodeAssert.ok(html.indexOf('Vorbei 4') < html.indexOf('Elternabend'), 'Beendetes oberhalb des Kommenden');
  nodeAssert.ok(!html.includes('Vorbei 0'), 'aeltere beendete stehen nicht einzeln da');
}));

test('Notiz-Widget: nur der Auszug landet im DOM, nie der Volltext (Paket 3)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  // line-clamp kürzt rein visuell - Screenreader lasen die komplette Notiz vor.
  const secret = 'GEHEIMES-WLAN-PASSWORT-AM-ENDE';
  const long = `${'Wort '.repeat(60)}${secret}`;
  const html = __test.renderPinnedNotes([{ title: 'WLAN', content: long, color: '#FFEB3B', pinned: 1 }]);
  nodeAssert.ok(!html.includes(secret), 'der Volltext (inkl. Ende) steht nicht im DOM');
  nodeAssert.match(html, /…/, 'der Auszug endet mit einer Ellipse');
});

test('Notiz-Widget: die Zeilenzahl kommt aus der Kachelgroesse, nicht aus einer festen Drei (#928)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  // Fuenf angepinnte Notizen - der Vorrat, den die Route seit #928 liefert.
  const notes = ['A', 'B', 'C', 'D', 'E'].map((titel, i) => ({
    id: i + 1, title: `Notiz ${titel}`, content: titel, pinned: 1,
  }));
  const zeilen = (html) => (html.match(/class="note-item"/g) || []).length;

  // Die Standardgroesse der Kachel ist 1x2, also hoch: dort passen fuenf.
  // Genau hier stand der Fehler - die Kachel hatte den Platz und bekam drei.
  nodeAssert.equal(zeilen(__test.renderPinnedNotes(notes, '1x2')), 5,
    'die hohe Kachel zeigt nicht alle fuenf');
  nodeAssert.equal(zeilen(__test.renderPinnedNotes(notes, '2x2')), 5,
    'die grosse Kachel zeigt nicht alle fuenf');
  // Gegenprobe: die flache Kachel deckelt weiterhin, sonst quillt sie ueber.
  nodeAssert.equal(zeilen(__test.renderPinnedNotes(notes, '1x1')), 3,
    'die flache Kachel deckelt nicht mehr');
  nodeAssert.equal(zeilen(__test.renderPinnedNotes(notes, '2x1')), 3,
    'die breite flache Kachel deckelt nicht mehr');
  // Ohne Groesse (aeltere Aufrufer, __test-Tor) bleibt es beim flachen Wert -
  // die Kachel darf nicht ins Unbegrenzte kippen, nur weil niemand fragt.
  nodeAssert.equal(zeilen(__test.renderPinnedNotes(notes)), 3,
    'ohne Groesse wird nicht gedeckelt');
});

test('Tagesprogramm: Aufgaben-Zeile trägt den Quick-Action-Anker (Paket 2)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    const html = __test.renderTodayCockpit({
      urgentTasks: [{ id: 7, title: 'Zettel abgeben', due_date: todayStr, status: 'open' }],
    }, []);
    nodeAssert.match(html, /data-object-kind="task"/, 'Zeile deklariert ihre Objektart');
    nodeAssert.match(html, /data-object-id="7"/, 'Zeile trägt die Aufgaben-ID für das Quick-Action-Modal');
  } finally {
    global.window = prevWindow;
  }
});

test('Tagesprogramm: leerer Tag liefert Ausblick (nextUpcoming) und Erledigt-Zähler', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const tomorrowStr = addLocalDays(todayStr, 1);

  const result = __test.buildTodayProgram({
    upcomingEvents: [{ id: 9, title: 'Elternabend', start_datetime: `${tomorrowStr}T19:00:00` }],
    urgentTasks: [{ id: 4, title: 'Erst übermorgen', due_date: addLocalDays(todayStr, 2), status: 'open' }],
    tasksDoneToday: 2,
  });

  nodeAssert.equal(result.rows.length, 0, 'keine Programmzeilen an einem leeren Tag');
  nodeAssert.equal(result.nextUpcoming?.id, 9, 'der nächste kommende Termin ist der Ausblick');
  nodeAssert.equal(result.tasksDoneToday, 2, 'der Erledigt-Zähler wird durchgereicht');
});

test('Tagesprogramm: eine begonnene Aufgabe sagt es in der Unterzeile (#1251)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const result = __test.buildTodayProgram({
    urgentTasks: [
      { id: 1, title: 'Offen', due_date: todayStr, due_time: '09:00:00', status: 'open' },
      { id: 2, title: 'Angefangen', due_date: todayStr, due_time: '10:00:00', status: 'in_progress' },
    ],
  });
  const sub = Object.fromEntries(result.rows.map((r) => [r.title, r.sub]));
  nodeAssert.equal(sub.Offen, 'dashboard.todayTask', 'eine offene Aufgabe bleibt bei "Aufgabe"');
  nodeAssert.equal(sub.Angefangen, 'dashboard.todayTaskStarted', 'eine begonnene Aufgabe heisst "Aufgabe · begonnen"');

  // Als sichtbarer Text in der Karte, nicht als Symbol: so liest ihn auch ein Screenreader.
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    const html = __test.renderTodayCockpit({ urgentTasks: [{ id: 2, title: 'Angefangen', due_date: todayStr, status: 'in_progress' }] }, []);
    nodeAssert.match(html, /<span class="today-cockpit-card__sub">dashboard\.todayTaskStarted<\/span>/,
      'die Unterzeile traegt das Wort als Text');
  } finally {
    global.window = prevWindow;
  }
});

test('Aufgaben-Kachel: begonnene Aufgabe traegt das Zeichen der Aufgabenliste, samt Wort (#1251)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());
  const html = __test.renderUrgentTasks([
    { id: 1, title: 'Offen', priority: 'none', due_date: todayStr, status: 'open' },
    { id: 2, title: 'Angefangen', priority: 'none', due_date: todayStr, status: 'in_progress' },
  ]);
  const rows = html.split('class="task-item"').slice(1);
  nodeAssert.equal(rows.length, 2);
  const [offen, angefangen] = rows;
  nodeAssert.match(angefangen, /class="task-status-btn task-status-btn--in_progress task-status-btn--static"[^>]*aria-hidden="true"/,
    'dasselbe Zeichen wie in der Aufgabenliste, als Dekoration');
  nodeAssert.match(angefangen, /<span class="sr-only">tasks\.statusInProgress<\/span>/,
    'der Status steht fuer Screenreader als Wort in der Zeile');
  nodeAssert.doesNotMatch(offen, /task-status-btn|tasks\.statusInProgress/,
    'eine offene Aufgabe bekommt kein viertes Zeichen');

  // Die Kachel laeuft auf `/`, wo tasks.css nicht geladen ist: ohne eigene Regel
  // in dashboard.css waere das Zeichen dort unsichtbar.
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  nodeAssert.match(css, /\.task-item \.task-status-btn--in_progress::after\s*\{[^}]*--color-warning/,
    'dashboard.css zeichnet den Ring in der Farbe der Aufgabenliste');

  // Oeffnet man eine Aufgabe aus der Kachel, haengt `ensureTaskStyles()` tasks.css
  // fuer den Rest der Sitzung an - und dessen `.task-status-btn` hat die
  // Trefflaeche (44px) samt negativem Rand. Die Regel hier muss die Masse selbst
  // festlegen, sonst waechst der Ring in der Kachel mit (Review zu #1400).
  const ringBox = [...eachRule(css)].find((rule) => rule.at.length === 0
    && rule.selector.trim() === '.task-item .task-status-btn--in_progress');
  nodeAssert.ok(ringBox, 'die Kachel hat eine eigene Regel fuer das Zeichen');
  const declarations = new Map(ringBox.body.split(';')
    .map((decl) => decl.split(':').map((part) => part.trim()))
    .filter(([prop, value]) => prop && value !== undefined));
  for (const [prop, value] of [['width', 'var(--space-5)'], ['height', 'var(--space-5)'], ['margin-top', '0']]) {
    nodeAssert.equal(declarations.get(prop), value,
      `${prop}: ${value} - sonst uebernimmt tasks.css die Trefflaeche, sobald es geladen ist`);
  }
});

test('eventStartDate: ganztägige Termine (date-only) landen auf dem lokalen Kalendertag (Issue #466)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  // Google speichert ganztägige Termine als reines Datum "2026-07-10". `new Date()`
  // parst das als UTC-Mitternacht und verschiebt den Tag westlich von UTC um einen
  // Tag zurück. eventStartDate muss stattdessen den lokalen Kalendertag liefern.
  const d = __test.eventStartDate({ start_datetime: '2026-07-10', all_day: 1 });
  assert(d.getFullYear() === 2026, `Erwartet Jahr 2026, erhalten ${d.getFullYear()}`);
  assert(d.getMonth() === 6, `Erwartet Monat Juli (6), erhalten ${d.getMonth()}`);
  assert(d.getDate() === 10, `Erwartet Tag 10, erhalten ${d.getDate()}`);
  assert(d.getHours() === 0, `Erwartet lokale Mitternacht, erhalten ${d.getHours()}h`);
});

test('Today-Highlights zählt ganztägigen Termin von heute (date-only, Issue #466)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = toLocalDateKey(new Date());

  const result = __test.buildTodayHighlights({
    events: [
      { id: 1, title: 'Ganztägig Heute', start_datetime: todayStr, all_day: 1 },
    ],
  });

  assert(result.eventCount === 1, `Erwartet 1 ganztägigen Termin für heute, erhalten ${result.eventCount}`);
  assert(result.nextEvent.title === 'Ganztägig Heute', 'Erwartet "Ganztägig Heute" als nächsten Termin');
});

test('Today-Meals-Widget rendert nur sichtbare Mahlzeit-Typen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const html = __test.renderTodayMeals([
    { meal_type: 'breakfast', title: 'Haferbrei' },
    { meal_type: 'dinner', title: 'Pasta' },
    { meal_type: 'snack', title: 'Apfel' },
  ], ['dinner', 'snack']);

  nodeAssert.ok(html.includes('data-type="dinner"'));
  nodeAssert.ok(html.includes('data-type="snack"'));
  nodeAssert.ok(!html.includes('data-type="breakfast"'));
  nodeAssert.ok(!html.includes('data-type="lunch"'));
});

// --------------------------------------------------------
// Tests: Dringende Aufgaben
// --------------------------------------------------------
const deadline48h = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);

test('Dringende Aufgaben: nur high/urgent mit Fälligkeit ≤ 48h und nicht done', () => {
  const tasks = db.prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.priority IN ('high', 'urgent')
      AND t.status != 'done'
      AND (t.due_date IS NULL OR t.due_date <= ?)
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.due_date ASC
    LIMIT 10
  `).all(deadline48h);

  assert(tasks.length === 2, `Erwartet 2 Aufgaben, erhalten ${tasks.length}`);
  assert(tasks[0].priority === 'urgent', 'Urgent zuerst');
  assert(tasks[0].assigned_name === 'Max Muster', 'assigned_name korrekt');
  assert(tasks[0].assigned_color === '#34C759', 'assigned_color korrekt');
});

test('Dringende Aufgaben: erledigte Aufgaben werden nicht angezeigt', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const doneTask = tasks.find((t) => t.title === 'Done Task');
  assert(!doneTask, 'Erledigte Aufgaben sollten gefiltert sein');
});

test('Dringende Aufgaben: Task mit Fälligkeit in 3 Tagen wird ausgeschlossen', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const farTask = tasks.find((t) => t.title === 'High Task in 3 Tagen');
  assert(!farTask, 'Aufgabe in 72h sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Anstehende Termine
// --------------------------------------------------------
test('Anstehende Termine: zukünftige Events, sortiert, max 5', () => {
  const now = new Date().toISOString();
  const events = db.prepare(`
    SELECT ce.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM calendar_events ce
    LEFT JOIN users u ON ce.assigned_to = u.id
    WHERE ce.start_datetime >= ?
    ORDER BY ce.start_datetime ASC
    LIMIT 5
  `).all(now);

  assert(events.length === 2, `Erwartet 2 Events, erhalten ${events.length}`);
  assert(events[0].title === 'Morgen-Meeting', 'Erstes Event ist das nächste');
  assert(events[0].assigned_color === '#34C759', 'assigned_color vom Join');
});

test('Anstehende Termine: Dashboard-Mapping erzeugt assigned_users Array (Issue #284)', () => {
  const raw = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const mapped = raw.map(({ assigned_users_json, ...event }) => {
    event.assigned_users = assigned_users_json ? JSON.parse(assigned_users_json) : [];
    return event;
  });

  const soccer = mapped.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss im Ergebnis sein');
  assert(!('assigned_users_json' in soccer), 'assigned_users_json darf nicht im Ergebnis sein');
  assert(Array.isArray(soccer.assigned_users), 'assigned_users muss ein Array sein');
  assert(soccer.assigned_users.length === 2, `Erwartet 2 Einträge, erhalten ${soccer.assigned_users.length}`);
  assert('avatar_data' in soccer.assigned_users[0], 'avatar_data muss im User-Objekt enthalten sein');

  const fieldTrip = mapped.find((e) => e.title === 'Sofia Field Trip');
  assert(fieldTrip, 'Sofia Field Trip muss erscheinen');
  assert(Array.isArray(fieldTrip.assigned_users) && fieldTrip.assigned_users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users Array');
});

// --------------------------------------------------------
// Tests: Heutige Mahlzeiten
// --------------------------------------------------------
test('Heutige Mahlzeiten: nur heute, in korrekter Reihenfolge', () => {
  const meals = db.prepare(`
    SELECT * FROM meals WHERE date = ?
    ORDER BY CASE meal_type
      WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1
      WHEN 'dinner' THEN 2 WHEN 'snack' THEN 3 END
  `).all(today);

  assert(meals.length === 2, `Erwartet 2 Mahlzeiten, erhalten ${meals.length}`);
  assert(meals[0].meal_type === 'breakfast', 'Frühstück zuerst');
  assert(meals[1].meal_type === 'dinner', 'Abendessen danach');
});

test('Heutige Mahlzeiten: morgige Mahlzeit nicht enthalten', () => {
  const meals = db.prepare(`SELECT * FROM meals WHERE date = ?`).all(today);
  const wrongMeal = meals.find((m) => m.title === 'Salat morgen');
  assert(!wrongMeal, 'Morgige Mahlzeit sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Angepinnte Notizen
// --------------------------------------------------------
test('Angepinnte Notizen: nur pinned=1, max 3', () => {
  const notes = db.prepare(`
    SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
    FROM notes n
    LEFT JOIN users u ON n.created_by = u.id
    WHERE n.pinned = 1
    ORDER BY n.updated_at DESC
    LIMIT 3
  `).all();

  assert(notes.length === 1, `Erwartet 1 Notiz, erhalten ${notes.length}`);
  assert(notes[0].title === 'Pinnwand-Notiz', 'Korrekte Notiz');
  assert(notes[0].author_name === 'Anna Admin', 'author_name vom Join');
});

test('Angepinnte Notizen: nicht angepinnte werden ausgeschlossen', () => {
  const notes = db.prepare(`SELECT * FROM notes WHERE pinned = 1`).all();
  const unpinned = notes.find((n) => n.content === 'Nicht angepinnt');
  assert(!unpinned, 'Nicht angepinnte Notiz sollte gefiltert sein');
});

// --------------------------------------------------------
// Tests: Geburtstage
// --------------------------------------------------------
test('Saattag und Haushaltstag sind derselbe Tag', async () => {
  // Der Nagel, auf dem die halbe Datei haengt: 36 Stellen saeen ihre Daten mit
  // `toLocalDateKey()`, und der Server liest sie ueber die Haushaltszone zurueck.
  // Laufen die beiden auseinander, faellt nicht dieser Test, sondern irgendein
  // anderer, ein paar Stunden am Tag, und die Ursache steht nirgends. Deshalb
  // hier, mit Namen, und zwar an BEIDEN Enden des Tages.
  const { todayKey } = await import('../server/utils/timezone.js');
  for (const stunde of ['00:00:01', '12:00:00', '23:59:59']) {
    nodeAssert.equal(
      todayKey(db, new Date(`${today}T${stunde}`)),
      today,
      `Haushaltszone und Saatzone driften auseinander (${stunde}): ` +
      `sync_config sagt ${db.prepare("SELECT value FROM sync_config WHERE key='household_timezone'").get()?.value}`
    );
  }
});

/* Nachgesehen, weil ein Testfehler ueber Kalendertage sonst leicht einen
 * Produktfehler versteckt: hier ist keiner dahinter. Alle Aufrufer von
 * `hydrateBirthday` (server/routes/birthdays.js dreimal, server/routes/
 * dashboard.js ueber `hydrateBirthdayOccurrences`) uebergeben gar kein `from`
 * und bekommen `new Date()` - einen echten Zeitpunkt, den `todayKey` korrekt
 * in den Haushaltstag umrechnet. Nur der Test baute sich einen Zeitpunkt, der
 * nicht der Tag war, den er meinte.
 */
test('Geburtstage: haushaltsweit, sortiert nach nächstem Geburtstag', () => {
  const rows = db.prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE ASC').all();
  const birthdays = rows
    // Mittag des gesaeten Tages in der HAUSHALTSZONE, nicht 12:00 UTC. Mit dem
    // `Z` stand hier ein Instant, der ab einem Zonenversatz von +12 schon auf dem
    // FOLGETAG liegt: unter Pacific/Kiritimati (+14) hielt `hydrateBirthday` den
    // 11. fuer heute, waehrend die Saat auf dem 10. lag, und "Morgen Geburtstag"
    // bekam `days_until: 0`. Ohne das `Z` liest `new Date` lokal, also in
    // derselben Zone, aus der `toLocalDateKey()` den Saattag genommen hat.
    .map((row) => hydrateBirthday(db, row, new Date(`${today}T12:00:00`)))
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
    .slice(0, 3);

  assert(rows.length === 3, `Erwartet 3 Geburtstage, erhalten ${rows.length}`);
  assert(birthdays[0].days_until === 0, 'Ein heutiger Geburtstag steht zuerst');
  assert(birthdays.some((birthday) => birthday.name === 'Heute Geburtstag' && birthday.days_until === 0),
    'Eigener heutiger Geburtstag muss enthalten sein');
  assert(birthdays.some((birthday) => birthday.name === 'Anderer Nutzer'), 'Geburtstag eines anderen Nutzers muss enthalten sein');
});

/* Und die Zone einmal WEG von der des Rechners.
 *
 * Die geteilte Datenbank oben setzt `household_timezone` bewusst auf die Zone
 * der Maschine, damit Saattag und Haushaltstag zusammenfallen. Der Preis dafuer
 * ist, dass in dieser Datenbank beide Uhren dasselbe sagen: ob `hydrateBirthday`
 * den Stichtag aus der HAUSHALTSZONE nimmt oder einfach aus der des Servers,
 * ist dort nicht zu unterscheiden. Der Waechter `Saattag und Haushaltstag sind
 * derselbe Tag` bliebe gruen, wenn jemand die Haushaltszone ganz herausnaehme.
 *
 * Diese Probe stellt deshalb eine eigene Datenbank hin, in der die
 * Haushaltszone NICHT die der Maschine ist, und liest EINEN Zeitpunkt zweimal,
 * in zwei Zonen beiderseits der Datumsgrenze. Weil beide Antworten aus
 * demselben Zeitpunkt kommen und sich unterscheiden MUESSEN, kann keine
 * Fassung sie erfuellen, die stattdessen die Zone der Maschine liest - die ist
 * innerhalb eines Laufs konstant.
 */
test('Geburtstage: der Stichtag folgt der Haushaltszone, nicht der des Servers', () => {
  const zdb = new DatabaseSync(':memory:');
  zdb.exec('PRAGMA foreign_keys = ON;');
  zdb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  zdb.exec(MIGRATIONS_SQL[1]);
  zdb.exec(MIGRATIONS_SQL[2]); // sync_config - traegt die Haushaltszone, hier bewusst eine fremde

  const zoneUser = zdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
    VALUES ('zonen-test', 'Zonen Test', 'x', '#FF9500')`).run().lastInsertRowid;
  zdb.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
    VALUES ('Zonenkind', '2012-06-16', ?)`).run(zoneUser);
  const row = zdb.prepare('SELECT * FROM birthdays').get();

  const setZone = (zone) => zdb.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);

  // EIN Zeitpunkt, der die Zonen trennt: 2026-06-15T12:00:00Z ist in Kiritimati
  // (+14) bereits der 16. um 02:00, in Los Angeles (-7) noch der 15. um 05:00.
  const at = new Date('2026-06-15T12:00:00Z');

  setZone('Pacific/Kiritimati');
  const east = hydrateBirthday(zdb, row, at);
  assert(east.days_until === 0,
    `Haushalt auf Kiritimati: am 16. ist der Geburtstag heute, erhalten days_until=${east.days_until} (next_birthday ${east.next_birthday})`);

  setZone('America/Los_Angeles');
  const west = hydrateBirthday(zdb, row, at);
  assert(west.days_until === 1,
    `Haushalt auf Los Angeles: derselbe Zeitpunkt ist noch der 15., der Geburtstag also morgen, erhalten days_until=${west.days_until} (next_birthday ${west.next_birthday})`);

  // Und die beiden muessen sich unterscheiden - sonst hat die Zone gar nichts
  // entschieden und beide Zweige lasen dieselbe (Server-)Uhr.
  assert(east.days_until !== west.days_until,
    'derselbe Zeitpunkt muss in beiden Haushaltszonen einen anderen Stichtag ergeben');
});

test('Dashboard-Geburtstagswidget lädt Geburtstage haushaltsweit (Issue #406)', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM reminders WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM calendar_events WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM birthdays WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-birthday-%'").run();

  const routeUser1 = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-birthday-owner', 'Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const routeUser2 = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-birthday-other', 'Other', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;

  routeDb.prepare('INSERT INTO birthdays (name, birth_date, name_day, created_by) VALUES (?, ?, ?, ?)')
    .run('Widget Owner Today', `2012-${today.slice(5)}`, today.slice(5), routeUser1);
  routeDb.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)')
    .run('Widget Other Today', `2011-${today.slice(5)}`, routeUser2);

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = routeUser1;
    req.session = { userId: routeUser1 };
    next();
  });
  app.use('/', dashboardRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const body = await response.json();
    const names = body.birthdays.map((birthday) => birthday.name);

    nodeAssert.equal(response.status, 200);
    nodeAssert.equal(body.birthdayCount, 2);
    // Die Kachel-Badge zaehlt Anlaesse, nicht Personen: zwei Menschen, einer
    // davon mit Namenstag, sind drei Zeilen (Critique 2026-09-23).
    nodeAssert.equal(body.birthdayTotal, 3);
    nodeAssert.ok(names.includes('Widget Other Today'), 'Dashboard widget must include birthdays created by other users');
    const ownerRows = body.birthdays.filter((item) => item.name === 'Widget Owner Today');
    nodeAssert.deepEqual(
      ownerRows.map((item) => item.kind).sort(),
      ['birthday', 'name_day'],
      'the same person appears as separate birthday and name-day occurrences',
    );
    const nameDay = ownerRows.find((item) => item.kind === 'name_day');
    nodeAssert.equal(nameDay.days_until, 0);
    nodeAssert.equal(nameDay.next_date, today);
    nodeAssert.equal(nameDay.next_age, null);
    nodeAssert.equal(body.birthdaySoonCount, 3, 'the three-day badge counts both occurrence kinds exactly once');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Dashboard-Endpoint filtert heutige Mahlzeiten nach sichtbaren Typen', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();
  const previousMealTypes = routeDb.prepare('SELECT value FROM sync_config WHERE key = ?').get('visible_meal_types')?.value ?? null;

  routeDb.prepare("DELETE FROM meals WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-meals-%')").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-meals-%'").run();

  const routeUser = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-meals-owner', 'Meal Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;

  routeDb.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES (?, ?, ?, ?)
  `).run(today, 'breakfast', 'Hidden Breakfast', routeUser);
  routeDb.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES (?, ?, ?, ?)
  `).run(today, 'dinner', 'Visible Dinner', routeUser);
  routeDb.prepare(`
    INSERT INTO sync_config (key, value)
    VALUES ('visible_meal_types', 'dinner')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = routeUser;
    req.session = { userId: routeUser };
    next();
  });
  app.use('/', dashboardRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const body = await response.json();

    nodeAssert.equal(response.status, 200);
    nodeAssert.deepEqual(body.todayMeals.map((meal) => meal.meal_type), ['dinner']);
    nodeAssert.equal(body.todayMeals[0].title, 'Visible Dinner');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousMealTypes === null) {
      routeDb.prepare('DELETE FROM sync_config WHERE key = ?').run('visible_meal_types');
    } else {
      routeDb.prepare(`
        INSERT INTO sync_config (key, value)
        VALUES ('visible_meal_types', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(previousMealTypes);
    }
    routeDb.prepare("DELETE FROM meals WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-meals-%')").run();
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-meals-%'").run();
  }
});

// Die Rangfolge nach Punkten ist mit der Critique 2026-09-23 entfallen: wer
// freigibt, sieht die Kinder nach NAMEN, und die Sicht haengt an der Rolle
// (authRole). Die Sichten einzeln prueft test/test-dashboard-rewards.js.
test('Dashboard-Endpoint: Belohnungen liefert Punktestand, Teilnehmerzahl und offene Freigaben', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-rewards-%'").run();

  const parent = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-parent', 'Rewards Parent', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const kidA = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-kid-a', 'Kid A', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;
  const kidB = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-kid-b', 'Kid B', 'x', '#FF9500', 'member')
  `).run().lastInsertRowid;

  for (const uid of [kidA, kidB]) {
    routeDb.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid);
  }
  routeDb.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 30, 'earn')").run(kidA);
  routeDb.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 80, 'earn')").run(kidB);
  routeDb.prepare(`INSERT INTO reward_redemptions (user_id, reward_name, cost, status)
    VALUES (?, 'Kino', 50, 'pending')`).run(kidB);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = parent; req.authRole = 'admin'; req.session = { userId: parent }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    const names = body.rewards.standings.map((s) => s.display_name);
    nodeAssert.equal(body.rewards.view, 'approver');
    nodeAssert.equal(names[0], 'Kid A', 'nach Namen, nicht nach Saldo - Kid B hat mehr und steht nicht vorn');
    nodeAssert.ok(names.includes('Kid A'), 'zweiter Teilnehmer ist enthalten');
    nodeAssert.ok(!names.includes('Rewards Parent'), 'Nicht-Teilnehmer erscheinen nicht');
    nodeAssert.equal(body.rewards.standings.find((s) => s.display_name === 'Kid B').balance, 80);
    nodeAssert.equal(body.rewards.participantCount, 2);
    nodeAssert.equal(body.rewards.pending, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-rewards-%'").run();
  }
});

test('Dashboard-Endpoint: Gesundheit zählt heute fällige eigene Dosen und Nachbestellungen', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-health-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-health-owner', 'Health Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const other = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-health-other', 'Health Other', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;

  // Familiensichtbares Medikament mit täglichem Plan (days_mask NULL) → heute fällig.
  const famMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Vitamin D', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '08:00', NULL, 1)
  `).run(famMed);
  // Familiensichtbar, niedriger Bestand, ohne Plan → zählt als Nachbestellung, nicht als Dosis.
  routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold)
    VALUES (?, 'Ibuprofen', 1, 'family', 2, 5)
  `).run(owner);
  // Eigenes privates Medikament mit Plan → zählt auf dem persönlichen Dashboard mit.
  const privMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Privat-Med', 1, 'private')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '09:00', NULL, 1)
  `).run(privMed);
  // Fremdes Medikament, familiensichtbar, früheste Zeit + niedriger Bestand → darf weder
  // als Dosis noch als nextDose noch als Nachbestellung erscheinen (Issue #592).
  const foreignMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold)
    VALUES (?, 'Fremd-Med', 1, 'family', 0, 5)
  `).run(other).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '05:00', NULL, 1)
  `).run(foreignMed);

  // Lokaler Tagesschlüssel wie im Handler (lokales Kalenderdatum), damit die
  // medication_logs-Zuordnung (substr(scheduled_at,1,10)) auch westlich von UTC greift.
  const localKey = toLocalDateKey(new Date());

  // Zusätzlicher familiensichtbarer Med mit gesetzter days_mask=127 (jeder Wochentag) →
  // deckt den Nicht-NULL-Maskenzweig ab und ist mit 07:00 die früheste offene Dosis.
  const dailyMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Tagesmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '07:00', 127, 1)
  `).run(dailyMed);
  // Plan startet erst in ferner Zukunft → heute nicht fällig (start_date-Zweig).
  const futureMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Zukunftsmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, start_date, active) VALUES (?, '06:00', NULL, '2099-12-31', 1)
  `).run(futureMed);
  // Plan bereits abgelaufen → heute nicht fällig (end_date-Zweig).
  const endedMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Abgelaufenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, end_date, active) VALUES (?, '06:30', NULL, '2000-01-01', 1)
  `).run(endedMed);
  // Fällig + heute bereits genommen → zählt als dosesTaken, nicht als nextDose.
  const takenMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Genommenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '10:00', NULL, 1)
  `).run(takenMed);
  routeDb.prepare(`
    INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, ?, 'taken')
  `).run(takenMed, `${localKey}T10:00:00`);
  // Fällig + heute ausgelassen → zählt als dosesSkipped.
  const skippedMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Ausgelassenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '11:00', NULL, 1)
  `).run(skippedMed);
  routeDb.prepare(`
    INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, ?, 'skipped')
  `).run(skippedMed, `${localKey}T11:00:00`);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    nodeAssert.equal(body.health.hasMeds, true);
    // Fällig heute: Tagesmed (07:00), Vitamin D (08:00), Privat-Med (09:00),
    // Genommenmed (10:00), Ausgelassenmed (11:00). Zukunfts-/Abgelaufen-Plan zählen
    // nicht; das fremde Med (05:00) ist trotz visibility='family' ausgeschlossen.
    nodeAssert.equal(body.health.dosesTotal, 5, 'fünf eigene, heute fällige Dosen (zukunft/abgelaufen/fremd ausgeschlossen)');
    nodeAssert.equal(body.health.dosesTaken, 1, 'die geloggte Einnahme zählt als genommen');
    nodeAssert.equal(body.health.dosesSkipped, 1, 'die geloggte Auslassung zählt als ausgelassen');
    nodeAssert.equal(body.health.nextDose.name, 'Tagesmed', 'früheste eigene offene Dosis (07:00) ist die nächste');
    nodeAssert.equal(body.health.lowStockCount, 1, 'nur der eigene niedrige Bestand wird gezählt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-health-%'").run();
  }
});

test('Dashboard-Endpoint: Haushaltshilfe meldet Anwesenheit, Monatsbesuche und offenen Betrag', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-hk-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-hk-owner', 'HK Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const helperUser = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-hk-helper', 'Maria', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;
  const workerId = routeDb.prepare(`
    INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)
  `).run(helperUser).lastInsertRowid;

  // Offene Sitzung heute → Anwesenheit. check_in mit lokalem Monat.
  routeDb.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by)
    VALUES (?, NULL, 40, 0, ?, ?)
  `).run(`${today}T09:00:00`, workerId, owner);
  // Abgeschlossene, unbezahlte Sitzung diesen Monat.
  routeDb.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, paid_at, worker_id, created_by)
    VALUES (?, ?, 40, 10, NULL, ?, ?)
  `).run(`${currentMonth}-01T09:00:00`, `${currentMonth}-01T13:00:00`, workerId, owner);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    nodeAssert.equal(body.housekeeping.configured, true);
    nodeAssert.equal(body.housekeeping.present, true);
    nodeAssert.equal(body.housekeeping.workerName, 'Maria');
    nodeAssert.equal(body.housekeeping.visitsThisMonth, 1, 'nur abgeschlossene Sitzungen zählen als Besuch');
    nodeAssert.equal(body.housekeeping.unpaidAmount, 50, 'daily_rate 40 + extras 10, unbezahlt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-hk-%'").run();
  }
});

test('Dashboard-Endpoint: dringende Aufgaben, anstehende Termine, Einkaufslisten und Sparziel', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM budget_plans WHERE category = '__savings__'").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-widgets-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-widgets-owner', 'Widget Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;

  // Offene, dringende Aufgabe mit Zuweisung → deckt die urgentTasks-Map + addAssignedUsers.
  const taskId = routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to)
    VALUES ('Widget Urgent', 'urgent', 'open', ?, 'all', ?, ?)
  `).run(today, owner, owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, owner);

  // Abgelegte Aufgabe (#688): steht weiter auf 'open' und wäre damit vor dem Fix
  // in "Heute auf einen Blick" gelandet - dort ließ sie sich aber nicht öffnen,
  // weil die Liste sie ausblendet.
  routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to, archived_at)
    VALUES ('Widget Abgelegt', 'urgent', 'open', ?, 'all', ?, ?, '2026-08-01T10:00:00Z')
  `).run(today, owner, owner);

  // Anstehender Termin mit Zuweisung → deckt die upcomingEvents-Map (assigned_users).
  const eventId = routeDb.prepare(`
    INSERT INTO calendar_events (title, start_datetime, visibility, created_by, assigned_to)
    VALUES ('Widget Termin', ?, 'all', ?, ?)
  `).run(`${in72h}T09:00:00`, owner, owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId, owner);

  // Einkaufsliste mit offenen Artikeln → deckt die innere Items-Schleife.
  const listId = routeDb.prepare(`
    INSERT INTO shopping_lists (name, created_by) VALUES ('Widget Einkauf', ?)
  `).run(owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Milch');
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Brot');
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 1)').run(listId, 'Butter (erledigt)');

  // Heute fällige, bereits erledigte Aufgabe → deckt tasksDoneToday („Alles
  // erledigt"-Zustand des Tagesprogramms). Lokaler Datumsschlüssel, nicht UTC:
  // der Server vergleicht mit todayLocalKey (exakte Gleichheit).
  routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to)
    VALUES ('Widget Erledigt', 'medium', 'done', ?, 'all', ?, ?)
  `).run(toLocalDateKey(new Date()), owner, owner);

  // Monats-Sparziel (Budgetplan) → deckt den savingsGoal-Zweig.
  routeDb.prepare("INSERT INTO budget_plans (category, amount) VALUES ('__savings__', 500)").run();

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();

    const urgent = body.urgentTasks.find((t) => t.title === 'Widget Urgent');
    nodeAssert.ok(urgent, 'dringende Aufgabe erscheint im Widget');
    nodeAssert.ok(Array.isArray(urgent.assigned_users), 'assigned_users ist ein Array (addAssignedUsers lief)');
    nodeAssert.equal(urgent.assigned_users.length, 1, 'die eine Zuweisung ist enthalten');
    nodeAssert.equal(urgent.assigned_users_json, undefined, 'das rohe JSON-Feld wird entfernt');
    // Die Uebersicht zeigt "begonnen" aus diesem Feld (#1251) - faellt es aus
    // der Abfrage, sieht jede Aufgabe wieder offen aus.
    nodeAssert.equal(urgent.status, 'open', 'der Status wird mitgeliefert (#1251)');
    nodeAssert.equal(
      body.urgentTasks.find((t) => t.title === 'Widget Abgelegt'),
      undefined,
      'abgelegte Aufgaben bleiben aus "Heute auf einen Blick" (#688)',
    );

    const upcoming = body.upcomingEvents.find((e) => e.title === 'Widget Termin');
    nodeAssert.ok(upcoming, 'anstehender Termin erscheint im Widget');
    nodeAssert.ok(Array.isArray(upcoming.assigned_users), 'assigned_users am Termin ist ein Array');

    const list = body.shoppingLists.find((l) => l.name === 'Widget Einkauf');
    nodeAssert.ok(list, 'Einkaufsliste mit offenen Artikeln erscheint');
    nodeAssert.equal(list.open_count, 2, 'nur die zwei offenen Artikel zählen');
    nodeAssert.equal(list.items.length, 2, 'die innere Items-Liste enthält nur offene Artikel');
    nodeAssert.ok(list.items.every((i) => i.is_checked === 0), 'kein erledigter Artikel in der Items-Liste');

    nodeAssert.equal(body.budget.savingsGoal, 500, 'Sparziel wird aus dem Budgetplan gelesen');

    // „Heute dran"-Karte: die Pro-Mitglied-Last kommt serverseitig aggregiert,
    // nicht aus dem 5er-Limit von urgentTasks.
    const memberLoad = body.memberTodayTasks.find((m) => m.user_id === owner);
    nodeAssert.ok(memberLoad, 'Pro-Mitglied-Zeile für den Owner vorhanden');
    nodeAssert.equal(memberLoad.open_count, 1, 'genau die eine offene, heute fällige Aufgabe zählt (Abgelegtes zählt nicht)');

    nodeAssert.equal(body.tasksDoneToday, 1, 'heute fällige erledigte Aufgabe wird gezählt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM budget_plans WHERE category = '__savings__'").run();
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-widgets-%'").run();
  }
});

test('Dashboard-Endpoint: fehlender Auth-Kontext führt zu 500 (kritischer Fehlerpfad)', async () => {
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

  const app = express();
  // Middleware setzt weder authUserId noch session → der Handler wirft beim Lesen von
  // req.session.userId und der äußere try/catch liefert die 500-Antwort.
  app.use((req, _res, next) => { next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    nodeAssert.equal(response.status, 500);
    const body = await response.json();
    nodeAssert.equal(body.code, 500);
    nodeAssert.equal(body.error, 'Dashboard could not be loaded.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --------------------------------------------------------
// Tests: Budget
// --------------------------------------------------------
test('Budget: Monatswerte für Einnahmen, Ausgaben, Saldo und Top-Ausgabe', () => {
  const from = `${currentMonth}-01`;
  const to = `${currentMonth}-31`;
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
      SUM(amount) AS balance,
      COUNT(*) AS entry_count
    FROM budget_entries
    WHERE date BETWEEN ? AND ?
  `).get(from, to);

  const topExpense = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM budget_entries
    WHERE amount < 0 AND date BETWEEN ? AND ?
    GROUP BY category
    ORDER BY ABS(SUM(amount)) DESC
    LIMIT 1
  `).get(from, to);

  assert(totals.income === 3000, `Einnahmen sollten 3000 sein, erhalten ${totals.income}`);
  assert(Math.abs(totals.expenses) === 1650, `Ausgaben sollten 1650 sein, erhalten ${totals.expenses}`);
  assert(totals.balance === 1350, `Saldo sollte 1350 sein, erhalten ${totals.balance}`);
  assert(totals.entry_count === 3, `Erwartet 3 Einträge, erhalten ${totals.entry_count}`);
  assert(topExpense.category === 'housing', 'Wohnen sollte Top-Ausgabenkategorie sein');
});

// --------------------------------------------------------
// Tests: getUpcomingEvents (geteilte Dashboard/Kalender-Logik)
// Regression für Issue #224: wiederkehrende Termine, deren Master-Start in
// der Vergangenheit liegt, müssen auf der Übersicht erscheinen.
// --------------------------------------------------------

// Eigene DB mit vollständigem Kalender-Schema (subscription_id, calendar_ref_id).
const cdb = new DatabaseSync(':memory:');
cdb.exec('PRAGMA foreign_keys = ON;');
cdb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
    avatar_data TEXT
  );
  CREATE TABLE external_calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'google', external_id TEXT,
    name TEXT NOT NULL, color TEXT
  );
  -- color gehoert dazu: sie ist die GEERBTE Farbe eines Abos und wird seit #891
  -- als cal_color mitgelesen, weil ein Abo-Termin keinen external_calendars-
  -- Eintrag hat. Fehlt sie hier, misst dieses verkuerzte Schema an der echten
  -- Abfrage vorbei. Dasselbe gilt fuer source/external_id und die beiden
  -- target_*-Spalten unten: SOURCE_CALENDAR_JOIN loest darueber die Quelle
  -- eines noch nicht hochgeladenen Termins auf (#1064).
  CREATE TABLE ics_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, color TEXT, shared INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT,
    start_datetime TEXT NOT NULL, end_datetime TEXT,
    all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
    color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    external_source TEXT NOT NULL DEFAULT 'local',
    recurrence_rule TEXT,
    subscription_id INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
    calendar_ref_id INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL,
    target_google_calendar_id TEXT, target_caldav_calendar_url TEXT, outbound_move_to TEXT,
    visibility TEXT NOT NULL DEFAULT 'all',
    recurrence_parent_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,
    recurrence_id TEXT,
    overridden_fields TEXT,
    attachment_data TEXT
  );
  CREATE TABLE event_assignments (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE calendar_event_exceptions (
    event_id       INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    exception_date TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (event_id, exception_date)
  );
  -- Für den LEFT JOIN in getUpcomingEvents (Geburtstags-Lokalisierung, Issue #524).
  CREATE TABLE birthdays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, birth_date TEXT NOT NULL,
    calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
    name_day TEXT,
    name_day_calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
`);

const cu1 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('theodore', 'Theodore', 'x', '#34C759')`).run();
const cu2 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('sofia', 'Sofia', 'x', '#AF52DE')`).run();
const cuTheo = cu1.lastInsertRowid;
const cuSofia = cu2.lastInsertRowid;

function insertEvent(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map(() => '?').join(', ');
  const r = cdb.prepare(`INSERT INTO calendar_events (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => fields[c]));
  return r.lastInsertRowid;
}

const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19);
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Kalendertag in der LOKALEN Zone, als YYYY-MM-DD.
//
// Diese Datei prueft ab Zeile ~1950 selbst, dass die Dashboard-ROUTE ihren
// Kalendertag nicht aus `toISOString()` zieht - und benutzte fuer ihre eigenen
// Testdaten genau dieses Muster. `getUpcomingEvents` vergleicht gegen den
// lokalen Tag, `insertEvent` speichert Wanduhrzeit ohne Zone: ein aus UTC
// gebildetes Datum liegt oestlich von UTC zwischen lokaler und UTC-Mitternacht
// einen Tag zu frueh. Zwischen 00:00 und 02:00 MESZ fielen drei Tests um und
// rissen die gesamte npm-test-Kette mit, waehrend die CI in UTC laeuft und
// davon nie etwas sah. Das ist die Falle aus CLAUDE.md, nur spiegelverkehrt:
// dort kippt der Tag westlich von UTC, hier oestlich.
const localDateKey = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// Tagesbeginn heute: immer "heute" und nie in der Zukunft, anders als now-Nh.
const todayStartIso = () => `${localDateKey()}T00:00:00`;

// Wiederkehrender Wochentermin, dessen Master-Start 14 Tage in der Vergangenheit liegt.
// Die nächste Instanz liegt in 7 Tagen relativ zum Master, also innerhalb des Fensters.
const recurStart = isoIn(-14 * DAY + 5 * HOUR);
const recurId = insertEvent({
  title: "Sofia Field Trip",
  start_datetime: recurStart,
  recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
  created_by: cuSofia,
  assigned_to: cuSofia,
});

// Nicht-wiederkehrender Termin in der Vergangenheit -> darf NICHT erscheinen.
insertEvent({ title: 'Past one-off', start_datetime: isoIn(-2 * DAY), created_by: cuTheo });

// Termin von heute Morgen (Vergangenheit, aber noch heute) -> bei fromToday erscheinen.
insertEvent({ title: 'Morning Meeting Today', start_datetime: todayStartIso(), created_by: cuTheo });

// Nicht-wiederkehrender Termin in der Zukunft -> erscheint.
// Beiden Nutzern (Theo + Sofia) zugewiesen – für Issue #284 (assigned_users im Dashboard).
const soccerId = insertEvent({ title: 'Theodore Soccer Game', start_datetime: isoIn(3 * DAY), created_by: cuTheo });
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuTheo);
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuSofia);

test('upcoming expansion stops after eligible occurrences, without counting EXDATE or expired slots', () => {
  const events = expandRecurringEvents([{
    id: 1, start_datetime: '2090-01-01T09:00:00Z', recurrence_rule: 'FREQ=DAILY',
  }], '2090-01-01', '9999-12-31', new Map([[1, new Set(['2090-01-03'])]]), {
    maxOccurrencesPerSeries: 2,
    occurrenceFilter: (event) => event.start_datetime >= '2090-01-02T12:00:00Z',
  });
  nodeAssert.deepEqual(events.map((event) => event.start_datetime), [
    '2090-01-04T09:00:00Z', '2090-01-05T09:00:00Z',
  ]);
});

test('getUpcomingEvents reaches an old daily series and fills the limit after expired slots', () => {
  cdb.exec('SAVEPOINT old_upcoming');
  try {
    const id = insertEvent({
      title: 'Old daily series', start_datetime: '2080-01-01T09:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, cuTheo);
    cdb.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
      .run(id, '2090-01-02');
    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, assignedTo: cuTheo, limit: 2, windowDays: null,
      now: new Date('2090-01-01T12:00:00Z'),
    });
    nodeAssert.deepEqual(events.map((event) => event.start_datetime), [
      '2090-01-03T09:00:00Z', '2090-01-04T09:00:00Z',
    ]);
  } finally {
    cdb.exec('ROLLBACK TO old_upcoming; RELEASE old_upcoming');
  }
});

test('getUpcomingEvents limits by effective instant after merging moved occurrences and filters', () => {
  cdb.exec('SAVEPOINT limited_upcoming');
  try {
    const series = insertEvent({
      title: 'Late UTC series', start_datetime: '2090-01-01T11:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    const moved = insertEvent({
      title: 'Moved earlier', start_datetime: '2090-01-01T12:00:00+02:00',
      recurrence_parent_id: series, recurrence_id: '2090-01-03',
      overridden_fields: '["title","start_datetime"]', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(series, cuTheo);
    const birthday = insertEvent({
      title: 'Birthday before everything', start_datetime: '2090-01-01T08:00:00Z',
      recurrence_rule: 'FREQ=YEARLY', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(birthday, cuTheo);
    cdb.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id) VALUES (?, ?, ?)')
      .run('Birthday fixture', '2000-01-01', birthday);
    insertEvent({
      title: 'Unassigned before everything', start_datetime: '2090-01-01T07:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, assignedTo: cuTheo, includeBirthdays: false,
      limit: 2, now: new Date('2090-01-01T06:00:00Z'),
    });
    nodeAssert.deepEqual(events.map((event) => Number(event.id)), [Number(moved), Number(series)]);
  } finally {
    cdb.exec('ROLLBACK TO limited_upcoming; RELEASE limited_upcoming');
  }
});

test('getUpcomingEvents: wiederkehrender Termin mit Vergangenheits-Start erscheint (Issue #224)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const sofia = events.find((e) => e.title === 'Sofia Field Trip');
  assert(sofia, 'Wiederkehrender "Sofia Field Trip" muss in den anstehenden Terminen erscheinen');
  assert(sofia.start_datetime >= new Date().toISOString(), 'Die expandierte Instanz liegt in der Zukunft');
  assert(sofia.id === recurId, 'Behält die Original-Event-ID der Serie');
});

test('calendarEventRoute: Dashboard-Link enthält die expandierte Instanz-Datumskomponente', async () => {
  const { __test: dashboardHelpers } = await import('../public/pages/dashboard.js');
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const sofia = events.find((e) => e.title === 'Sofia Field Trip');
  const route = dashboardHelpers.calendarEventRoute(sofia);
  const params = new URLSearchParams(route.split('?')[1]);
  assert(route.startsWith('/calendar?'), `Unerwartete Route: ${route}`);
  assert(params.get('open') === String(recurId), 'Route muss die Serien-ID öffnen');
  assert(params.get('date') === sofia.start_datetime.slice(0, 10),
    'Route muss auf die expandierte Dashboard-Instanz zeigen');
});

test('calendarEventRoute: ungültige oder fehlende Startdaten erzeugen keinen kaputten date-Parameter', async () => {
  const { __test: dashboardHelpers } = await import('../public/pages/dashboard.js');
  const route = dashboardHelpers.calendarEventRoute({ id: 123, start_datetime: 'not-a-date' });
  const params = new URLSearchParams(route.split('?')[1]);
  assert(params.get('open') === '123', 'Event-ID bleibt erhalten');
  assert(params.has('date') === false, 'Ungültiges Datum darf nicht in die Kalender-Query');
  assert(dashboardHelpers.calendarEventRoute(null) === '/calendar', 'Ohne Event geht es zur Kalenderübersicht');
});

test('getUpcomingEvents: vergangene Einzeltermine erscheinen nicht', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(!events.find((e) => e.title === 'Past one-off'), 'Vergangener Einzeltermin darf nicht erscheinen');
  assert(!events.find((e) => e.title === 'Morning Meeting Today'), 'Vergangener Heute-Termin ohne fromToday nicht erscheinen');
});

test('getUpcomingEvents: fromToday=true zeigt heutige vergangene Termine (Issue #230)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  assert(events.find((e) => e.title === 'Morning Meeting Today'),
    'Heute-Morgen-Termin muss mit fromToday=true erscheinen');
  assert(!events.find((e) => e.title === 'Past one-off'),
    'Termin von gestern darf auch mit fromToday nicht erscheinen');
});

/* #1449: DAS FUENFER-LIMIT ZAEHLT NUR, WAS NOCH KOMMT. Gemessen im Issue: um
 * 19:28 lieferte die Abfrage fuenf laengst vorbeie Termine und liess den um
 * 21:00 fallen. Beendete Termine von heute kommen weiter mit (die Kachel zeigt
 * sie zurueckgetreten), aber AUSSERHALB des Deckels. Wanduhrzeit ohne Zone plus
 * ein `now` aus derselben lokalen Uhr: die Haushaltszone faellt hier auf die
 * Serverzone zurueck (keine sync_config), beide Seiten lesen also dieselbe. */
test('getUpcomingEvents: das Limit zaehlt nur Kommendes, Beendetes von heute kommt ausserhalb mit (#1449)', () => {
  cdb.exec('SAVEPOINT ended_today');
  try {
    const day = '2091-03-10';
    const ended = ['06:00', '07:00', '08:00', '09:00', '10:00'].map((time, index) => insertEvent({
      title: `Vorbei ${index + 1}`, start_datetime: `${day}T${time}:00`,
      end_datetime: `${day}T${time.slice(0, 2)}:30:00`, created_by: cuTheo,
    }));
    const running = insertEvent({
      title: 'Laeuft noch', start_datetime: `${day}T19:00:00`, end_datetime: `${day}T20:00:00`, created_by: cuTheo,
    });
    const evening = insertEvent({ title: 'Abendtermin', start_datetime: `${day}T21:00:00`, created_by: cuTheo });
    const allDay = insertEvent({ title: 'Ganztags', start_datetime: day, all_day: 1, created_by: cuTheo });
    const now = new Date(2091, 2, 10, 19, 28);

    const plain = getUpcomingEvents(cdb, { userId: cuTheo, limit: 5, fromToday: true, windowDays: 1, now });
    nodeAssert.ok(!plain.some((e) => Number(e.id) === Number(evening)),
      'Vorbedingung: ohne die Option verdraengen die beendeten Termine den Abendtermin');

    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, limit: 2, fromToday: true, windowDays: 1, now, keepEndedToday: 20,
    });
    const ids = events.map((e) => Number(e.id));
    for (const id of ended) nodeAssert.ok(ids.includes(Number(id)), 'beendete Termine von heute bleiben dabei');
    // Der Deckel von 2 gilt dem, was noch kommt: der laufende Termin zaehlt
    // als kommend, der ganztaegige endet nie am eigenen Tag - beide passen,
    // der Abendtermin ist der dritte und faellt heraus.
    nodeAssert.ok(ids.includes(Number(running)), 'ein laufender Termin zaehlt als kommend');
    nodeAssert.ok(ids.includes(Number(allDay)), 'ein Ganztagstermin endet nicht an seinem eigenen Tag');
    nodeAssert.equal(events.length, ended.length + 2, 'das Limit zaehlt nur die zwei kommenden');
    nodeAssert.ok(!ids.includes(Number(evening)), 'der dritte kommende faellt unter den Deckel');

    const five = getUpcomingEvents(cdb, {
      userId: cuTheo, limit: 5, fromToday: true, windowDays: 1, now, keepEndedToday: 20,
    });
    nodeAssert.ok(five.some((e) => Number(e.id) === Number(evening)),
      'mit Fuenfer-Deckel steht der Abendtermin wieder drin (Abnahme aus #1449)');
  } finally {
    cdb.exec('ROLLBACK TO ended_today; RELEASE ended_today');
  }
});

test('getUpcomingEvents: zukünftige Termine sortiert und auf limit begrenzt', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(events.find((e) => e.title === 'Theodore Soccer Game'), 'Zukünftiger Einzeltermin erscheint');
  for (let i = 1; i < events.length; i++) {
    assert(events[i - 1].start_datetime <= events[i].start_datetime, 'Aufsteigend nach Startzeit sortiert');
  }
  const limited = getUpcomingEvents(cdb, { userId: cuTheo, limit: 1 });
  assert(limited.length === 1, `limit=1 liefert genau 1 Event, erhalten ${limited.length}`);
});

test('getUpcomingEvents: assigned_users_json enthält avatar_data (Issue #284)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const soccer = events.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss erscheinen');
  assert('assigned_users_json' in soccer, 'assigned_users_json muss im rohen Event enthalten sein');
  const users = JSON.parse(soccer.assigned_users_json);
  assert(Array.isArray(users) && users.length === 2,
    `Erwartet 2 zugewiesene User, erhalten ${users.length}`);
  assert(users.every((u) => 'avatar_data' in u),
    'Jeder User im assigned_users_json muss avatar_data enthalten');
  const theo  = users.find((u) => u.display_name === 'Theodore');
  const sofia = users.find((u) => u.display_name === 'Sofia');
  assert(theo,  'Theodore muss in assigned_users sein');
  assert(sofia, 'Sofia muss in assigned_users sein');
});

test('getUpcomingEvents: Event ohne Assignments hat leeres assigned_users_json Array (Issue #284)', () => {
  // Morning Meeting Today wurde ohne event_assignments eingefügt.
  const mornEvents = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  const mm = mornEvents.find((e) => e.title === 'Morning Meeting Today');
  assert(mm, 'Morning Meeting Today mit fromToday=true vorhanden');
  const users = JSON.parse(mm.assigned_users_json ?? '[]');
  assert(Array.isArray(users) && users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users_json Array');
});

test('getUpcomingEvents resolves a moved linked occurrence with inherited projections and owners', () => {
  const dateKey = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localDateKey(date);
  };
  const originalDate = dateKey(4);
  const movedDate = dateKey(7);
  const masterId = Number(insertEvent({
    title: 'Upcoming master',
    description: 'Current upcoming description',
    start_datetime: `${originalDate}T09:00:00`,
    end_datetime: `${originalDate}T10:00:00`,
    recurrence_rule: 'FREQ=DAILY;COUNT=4',
    assigned_to: cuTheo,
    created_by: cuTheo,
  }));
  cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(masterId, cuTheo);
  const childId = Number(insertEvent({
    title: 'Upcoming linked override',
    description: 'Stale upcoming description',
    start_datetime: `${movedDate}T11:00:00`,
    end_datetime: `${movedDate}T12:00:00`,
    assigned_to: cuSofia,
    created_by: cuTheo,
    visibility: 'assignees',
    recurrence_parent_id: masterId,
    recurrence_id: originalDate,
    overridden_fields: '["title","start_datetime","end_datetime","assignments","visibility","attachment","reminders"]',
  }));
  cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(childId, cuSofia);
  cdb.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, ?)
  `).run(masterId, originalDate);

  const events = getUpcomingEvents(cdb, {
    userId: cuSofia,
    limit: 20,
    fromToday: true,
  });
  const linked = events.find((event) => Number(event.id) === childId);

  assert(linked, 'the moved linked occurrence must be loaded by displayed date');
  assert(linked.description === 'Current upcoming description', 'unmarked description must inherit');
  assert(linked.start_datetime === `${movedDate}T11:00:00`, 'moved start must stay resolved');
  assert(linked.series_id === masterId, 'series identity must point to the master');
  assert(linked.recurrence_id === originalDate, 'recurrence identity must stay on the original slot');
  assert(linked.assignment_owner_id === childId, 'assignment owner must stay on the child');
  assert(linked.attachment_owner_id === childId, 'attachment owner must stay on the child');
  assert(linked.reminder_owner_id === childId, 'reminder owner must stay on the child');
  assert(!events.some((event) => Number(event.id) === masterId
    && event.recurrence_identity === originalDate), 'the original EXDATE slot must stay suppressed');
});

test('getUpcomingEvents liest keine großen attachment_data-Bodies', () => {
  const eventId = insertEvent({
    title: 'Upcoming large attachment',
    start_datetime: isoIn(5 * DAY),
    created_by: cuTheo,
    attachment_data: 'A'.repeat(1024 * 1024),
  });
  const originalPrepare = cdb.prepare.bind(cdb);
  const statements = [];
  cdb.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let events;
  try {
    events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 100 });
  } finally {
    delete cdb.prepare;
  }

  assert(events.some((event) => Number(event.id) === Number(eventId)), 'Termin fehlt');
  const calendarReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+calendar_events\b/i.test(sql));
  assert(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
});

test('getUpcomingEvents: private ICS-Termine fremder User werden ausgeblendet', () => {
  const sub = cdb.prepare(`INSERT INTO ics_subscriptions (name, shared, created_by) VALUES ('Privat', 0, ?)`)
    .run(cuSofia).lastInsertRowid;
  insertEvent({
    title: 'Sofias privater ICS-Termin',
    start_datetime: isoIn(2 * DAY),
    external_source: 'ics',
    subscription_id: sub,
    created_by: cuSofia,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20 });
  assert(!events.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Privates ICS-Abo eines anderen Users darf nicht erscheinen');
  const ownerEvents = getUpcomingEvents(cdb, { userId: cuSofia, limit: 20 });
  assert(ownerEvents.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Eigentümer sieht seinen privaten ICS-Termin');
});

// --------------------------------------------------------
// Bug #360: Geburtstag mit reminder_offset='' darf nicht als Kalender-Event existieren
// --------------------------------------------------------
{
  const bdb = new DatabaseSync(':memory:');
  bdb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
      avatar_data TEXT
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT,
      start_datetime TEXT NOT NULL, end_datetime TEXT,
      all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
      color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL DEFAULT 'local',
      recurrence_rule TEXT,
      subscription_id INTEGER,
      calendar_ref_id INTEGER,
      visibility TEXT NOT NULL DEFAULT 'all'
    );
    CREATE TABLE birthdays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, birth_date TEXT NOT NULL, notes TEXT,
      photo_data TEXT, created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      name_day TEXT,
      name_day_calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      reminder_offset TEXT, reminder_custom_amount TEXT, reminder_custom_unit TEXT,
      updated_at TEXT
    );
    CREATE TABLE event_assignments (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE ics_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, color TEXT, shared INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  const bUserId = bdb.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('bert', 'Bert', 'x', '#ff0')`
  ).run().lastInsertRowid;

  test('syncBirthdayArtifacts: reminder_offset="" → kein calendar_event_id (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Max', '1990-05-10', ?, '')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'Geburtstag ohne Benachrichtigung darf kein Kalender-Event haben');
    const evCount = bdb.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
    assert(evCount === 0, 'Keine Kalender-Events in der DB erwartet');
  });

  test('syncBirthdayArtifacts: vorhandenes Event wird bei reminder_offset="" gelöscht (Issue #360)', () => {
    const evId = bdb.prepare(
      `INSERT INTO calendar_events (title, start_datetime, all_day, created_by) VALUES ('Geburtstag Hans', '1985-03-15', 1, ?)`
    ).run(bUserId).lastInsertRowid;
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, calendar_event_id, reminder_offset) VALUES ('Hans', '1985-03-15', ?, ?, '')`
    ).run(bUserId, evId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(evId);
    assert(!ev, 'Vorhandenes Kalender-Event muss gelöscht worden sein');
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'calendar_event_id in birthdays muss NULL sein');
  });

  test('syncBirthdayArtifacts: reminder_offset gesetzt → Kalender-Event wird angelegt (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Lisa', '1992-07-20', ?, '1440')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id !== null, 'Geburtstag mit Erinnerung muss ein Kalender-Event haben');
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(updated.calendar_event_id);
    assert(ev, 'Kalender-Event muss existieren');
    assert(ev.all_day === 1, 'Geburtstags-Event muss ganztägig sein');
  });
}

// --------------------------------------------------------
// Bug-Fixes: ganztägige Termine + Geburtstags-Filterung
// --------------------------------------------------------
test('getUpcomingEvents: ganztägiger Termin heute erscheint mit fromToday=true (Issue #360)', () => {
  const todayDate = localDateKey();
  insertEvent({
    title: 'Ganztägiger Termin heute',
    start_datetime: todayDate, // kein T-Teil – genau das war das Problem
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Termin heute'),
    'Heutiger ganztägiger Termin muss im Dashboard erscheinen (start_datetime ohne Zeit-Teil)');
});

test('getUpcomingEvents: ganztägiger Termin in der Zukunft erscheint (Issue #360)', () => {
  const futureDate = localDateKey(new Date(Date.now() + 3 * DAY));
  insertEvent({
    title: 'Ganztägiger Zukunfts-Termin',
    start_datetime: futureDate,
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Zukunfts-Termin'),
    'Zukünftiger ganztägiger Termin muss im Dashboard erscheinen');
});

// --------------------------------------------------------
// Tests: maybeUpdateAutoLocation (Per-User-Wetter-Standort)
// --------------------------------------------------------
test('maybeUpdateAutoLocation writes weather_user and ignores role', async () => {
  const { maybeUpdateAutoLocation } = await import('../public/pages/dashboard.js');
  const calls = [];
  const geolocation = {
    getCurrentPosition: (resolve) => resolve({ coords: { latitude: 52.5200, longitude: 13.4100 } }),
  };
  const ok = await maybeUpdateAutoLocation({
    autoLocateEnabled: true,
    geolocation,
    putPreferences: (body) => { calls.push(body); return Promise.resolve(); },
  });
  nodeAssert.equal(ok, true);
  nodeAssert.equal(calls.length, 1);
  nodeAssert.deepEqual(calls[0], { weather_user: { lat: '52.5200', lon: '13.4100', city: null } });
});

test('maybeUpdateAutoLocation skips when disabled', async () => {
  const { maybeUpdateAutoLocation } = await import('../public/pages/dashboard.js');
  const ok = await maybeUpdateAutoLocation({
    autoLocateEnabled: false,
    geolocation: { getCurrentPosition: () => { throw new Error('should not be called'); } },
    putPreferences: () => { throw new Error('should not be called'); },
  });
  nodeAssert.equal(ok, false);
});

// --------------------------------------------------------
// Wand-Modus (Block D)
// --------------------------------------------------------

/** Programmzeilen für einen vollen Tag: N fällige Aufgaben mit Uhrzeit. */
function wallTasks(count, { assignTo = null, from = 8 } = {}) {
  const todayStr = toLocalDateKey(new Date());
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Aufgabe ${i + 1}`,
    due_date: todayStr,
    due_time: `${String(from + i).padStart(2, '0')}:00`,
    status: 'open',
    assigned_users: assignTo?.(i) ? [assignTo(i)] : [],
  }));
}

/** Der Wand-Modus rendert ohne DOM; `window.yuvomi` fragt er nur nach Modulen. */
async function withWallWindow(fn) {
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    return await fn();
  } finally {
    global.window = prevWindow;
  }
}

test('Wand-Modus: die Programmzeilen sind reine Anzeige - kein Link, kein Button', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface({ urgentTasks: wallTasks(3), users: [] }, null, {});
    const list = html.slice(html.indexOf('wall-program__list'), html.indexOf('</ol>'));
    // Reichweite zuerst: ein Selektor, der nichts findet, meldet sonst
    // fehlerfrei „keine Verstöße".
    const rows = list.match(/class="wall-row /g) ?? [];
    nodeAssert.equal(rows.length, 3, 'drei Programmzeilen gelesen');
    nodeAssert.ok(!/<a\b|href=|data-route=|<button/.test(list),
      'eine Zeile im Wand-Modus navigiert nicht und öffnet kein Modal');
    // Der EINE Bedienpunkt der Fläche liegt außerhalb der Liste.
    nodeAssert.match(html, /id="wall-exit"/, 'der Ausstieg ist da');
  });
});

test('Wand-Modus: der Ausstieg steht in JEDEM Zustand im DOM', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const states = {
      laden:  __test.renderWallSurface(null, null, { loading: true }),
      fehler: __test.renderWallSurface(null, null, { failed: true }),
      normal: __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, {}),
      leer:   __test.renderWallSurface({ urgentTasks: [], upcomingEvents: [], users: [] }, null, {}),
    };
    const ohne = Object.entries(states).filter(([, html]) => !/id="wall-exit"/.test(html)).map(([k]) => k);
    nodeAssert.equal(Object.keys(states).length, 4, 'vier Zustände geprüft');
    nodeAssert.deepEqual(ohne, [], 'ein unsichtbarer Ausstieg wäre eine Falle');
  });
});

test('Wand-Modus: Einstieg und Ausstieg sind Gegenstücke auf derselben Seite (#915)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    // Der Modus wurde nur unter Einstellungen -> Persönlich -> Darstellung
    // eingeschaltet und hier verlassen: man ging dort hinaus, wo man nicht
    // hineinkam. Geprüft wird deshalb das PAAR, nicht der neue Knopf allein -
    // verschwindet eine der beiden Hälften, ist die Einbahnstraße zurück.
    const uebersicht = __test.renderDashboardOverview({ display_name: 'Ulas' }, false);
    const wand = __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, {});

    nodeAssert.match(uebersicht, /id="dashboard-wall-enter"/, 'die Übersicht trägt den Einstieg');
    nodeAssert.match(wand, /id="wall-exit"/, 'die Wand trägt den Ausstieg');

    // Und er sitzt in der Werkzeugzeile, nicht irgendwo: ein Knopf ausserhalb
    // wäre nicht das Gegenstück zum Ausstieg, sondern ein zweiter Ort.
    const tools = uebersicht.slice(uebersicht.indexOf('dashboard-overview__tools'));
    nodeAssert.match(tools, /id="dashboard-wall-enter"/, 'in der Werkzeugzeile der Übersicht');
  });
});

test('Wand-Modus: der Einstieg fällt im Anpassen-Modus weg', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    // Dort geht es um die Anordnung der Kacheln; ein Moduswechsel mittendrin
    // würfe eine ungespeicherte Bearbeitung weg.
    const editing = __test.renderDashboardOverview({ display_name: 'Ulas' }, true);
    nodeAssert.ok(!/id="dashboard-wall-enter"/.test(editing), 'kein Einstieg im Anpassen-Modus');
    nodeAssert.match(editing, /id="dashboard-customize-save"/, 'Reichweite: es IST der Anpassen-Modus');
  });
});

test('Wand-Modus: der Fehlerzustand trägt keinen Retry-Knopf, aber die Uhr', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface(null, null, { failed: true });
    nodeAssert.match(html, /wall__error-title/, 'der Fehler spricht als eigener Zustand');
    // Am Wandtablet drückt niemand „erneut versuchen" - geheilt wird von selbst.
    nodeAssert.ok(!/dashboard-retry|widget-retry/.test(html), 'kein Retry-Knopf auf zwei Metern');
    nodeAssert.match(html, /clock-widget--wall/, 'die Uhr bleibt: sie braucht kein Netz');
  });
});

/* EIN LAUFENDER TIMER NIMMT EINE ZEILE (Integration 2026-09-23, Browser-Abnahme
 * bei 1280x800). Der Deckel von vier Zeilen ist fuer eine Flaeche OHNE die
 * Timer-Anzeige gerechnet; die Anzeige kostet 64px plus Abstand, und an einem
 * vollen Tag schob sie Fuss samt „Timer abbrechen" und Ausstieg auf 808-856px -
 * unter den Bildrand einer Flaeche, die nicht scrollt. Solange der Timer steht,
 * zeigt das Programm eine Zeile weniger, und „+N weitere" zaehlt sie mit. */
test('Wand-Modus: ein laufender Timer nimmt dem Programm eine Zeile', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const { startWallTimer, clearWallTimer } = await import('../public/components/wall-timer.js');
  const store = new Map();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  });
  try {
    await withWallWindow(() => {
      const data = { urgentTasks: wallTasks(9), users: [] };
      const rows = (html) => (html.match(/class="wall-row /g) ?? []).length;
      nodeAssert.equal(rows(__test.renderWallSurface(data, null, {})), __test.WALL_ROW_CAP, 'Vorbedingung: ohne Timer der volle Deckel');
      startWallTimer(5);
      const running = __test.renderWallSurface(data, null, {});
      nodeAssert.match(running, /wall__timer-value/, 'Vorbedingung: die Timer-Anzeige steht');
      nodeAssert.equal(rows(running), __test.WALL_ROW_CAP - 1, 'mit laufendem Timer eine Zeile weniger');
      clearWallTimer();
      nodeAssert.equal(rows(__test.renderWallSurface(data, null, {})), __test.WALL_ROW_CAP, 'nach dem Timer wieder der volle Deckel');
    });
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
});

test('Wand-Modus: der Deckel greift, und der Überlauf sagt die Wahrheit', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const data = { urgentTasks: wallTasks(9), users: [] };
    const html = __test.renderWallSurface(data, null, {});
    const rows = html.match(/class="wall-row /g) ?? [];
    nodeAssert.ok(rows.length > 0, 'Reichweite: Zeilen wurden überhaupt gelesen');
    nodeAssert.equal(rows.length, __test.WALL_ROW_CAP, 'der Wand-Deckel greift');
    nodeAssert.ok(__test.WALL_ROW_CAP < __test.PROGRAM_ROW_CAP,
      'die Wand zeigt weniger Zeilen als das Cockpit - sie muss ohne Scrollen passen');
    nodeAssert.match(html, /wall-program__foot/, 'der Überlauf spricht als Fußzeile');

    // Die Zahl zählt gegen ALLE Zeilen des Tages, nicht gegen die gezeigten.
    // Am Modell geprüft und nicht am Text: `t()` ist in dieser Suite nicht
    // initialisiert und gäbe den Schlüssel zurück - eine Zusicherung über den
    // gerenderten Satz wäre eine über den Schlüsselnamen.
    const model = __test.buildTodayCockpitModel(data, [], { cap: __test.WALL_ROW_CAP });
    nodeAssert.equal(model.allRows.length, 9, 'das Modell kennt den ganzen Tag');
    nodeAssert.equal(model.overflow, 9 - __test.WALL_ROW_CAP, 'der Überlauf nennt die echte Restzahl');
  });
});

test('Wand-Modus: „Wer heute dran ist" zählt den ganzen Tag, nicht nur die sichtbaren Zeilen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    // Mia hat GENAU EINE Aufgabe, und die liegt hinter dem Deckel. Zählte der
    // Abschnitt nur die gezeigten Zeilen, verschwände sie aus der Antwort.
    const spaet = { id: 42, display_name: 'Mia Muster', avatar_color: '#CE2A63' };
    const tasks = wallTasks(8, { assignTo: (i) => (i === 7 ? spaet : null) });
    const html = __test.renderWallSurface({ urgentTasks: tasks, users: [spaet] }, null, {});
    nodeAssert.match(html, /wall-who__member/, 'Reichweite: der Abschnitt wurde gebaut');
    nodeAssert.match(html, /Mia/, 'wer hinter dem Deckel steht, steht trotzdem in der Antwort');
    nodeAssert.match(html, /wall-who__count/, 'die Zahl beantwortet „wie viel"');
  });
});

test('Wand-Modus: „Wer heute dran ist" entfällt im Solo-Haushalt', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const { setHouseholdSize, clearHouseholdSize } = await import('../public/utils/household.js');
  const prevDocument = global.document;
  global.document = { documentElement: { classList: { toggle() {}, add() {}, remove() {} } } };
  try {
    await withWallWindow(() => {
      const alleine = { id: 1, display_name: 'Miriam Solo', avatar_color: '#6C3AED' };
      const data = { urgentTasks: wallTasks(2, { assignTo: () => alleine }), users: [alleine] };

      setHouseholdSize(2);
      nodeAssert.match(__test.renderWallSurface(data, null, {}), /wall-who__member/,
        'Reichweite: im Mehrpersonen-Haushalt steht der Abschnitt da');

      setHouseholdSize(1);
      nodeAssert.ok(!/wall__who/.test(__test.renderWallSurface(data, null, {})),
        'was nur eine sinnvolle Belegung hat, wird nicht gezeigt');
    });
  } finally {
    clearHouseholdSize();
    global.document = prevDocument;
  }
});

test('Wand-Modus: leerer Tag spricht, statt zu verschwinden', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface({ urgentTasks: [], upcomingEvents: [], users: [] }, null, {});
    // Eine leere Fläche liest sich aus zwei Metern wie ein Defekt.
    nodeAssert.match(html, /wall-row--state/, 'der leere Tag bekommt seine eigene Zeile');
  });
});

test('Wand-Modus und Cockpit erzählen denselben Tag (ein Modell, zwei Formen)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const data = { urgentTasks: wallTasks(3), users: [] };
    const titles = (html) => (html.match(/Aufgabe \d+/g) ?? []);
    const wand = titles(__test.renderWallSurface(data, null, {}));
    const cockpit = titles(__test.renderTodayCockpit(data, []));
    nodeAssert.equal(wand.length, 3, 'Reichweite: die Wand hat drei Zeilen gelesen');
    nodeAssert.deepEqual(wand, cockpit.slice(0, wand.length),
      'dieselben Zeilen in derselben Reihenfolge - keine zweite Wahrheit');
  });
});

test('Wand-Modus: das Nachtfenster läuft über Mitternacht (22:00 bis 06:00)', async () => {
  const { isWallNight, isWallRoute, WALL_NIGHT_FROM, WALL_NIGHT_TO } = await import('../public/utils/wall-mode.js');
  const at = (h, m = 0) => new Date(2026, 7, 11, h, m);
  const probe = [
    [21, 59, false], [22, 0, true], [23, 30, true],
    [0, 15, true], [3, 0, true], [5, 59, true], [6, 0, false], [12, 0, false],
  ];
  const falsch = probe.filter(([h, m, soll]) => isWallNight(at(h, m)) !== soll)
    .map(([h, m]) => `${h}:${String(m).padStart(2, '0')}`);
  nodeAssert.equal(probe.length, 8, 'acht Uhrzeiten geprüft');
  nodeAssert.deepEqual(falsch, [], 'ODER statt UND - sonst reißt das Fenster um Mitternacht');
  nodeAssert.equal(WALL_NIGHT_FROM, 22);
  nodeAssert.equal(WALL_NIGHT_TO, 6);

  // Der Modus ist ein Zustand DES DASHBOARDS, keine eigene Route.
  nodeAssert.equal(isWallRoute('/'), true);
  nodeAssert.deepEqual(['/tasks', '/settings', '/calendar'].filter(isWallRoute), []);
});

// --------------------------------------------------------
// Widget-Konfiguration (public/utils/dashboard-widgets.js)
//
// ANLASS: `normalizeDashboardConfig` sortiert eine inzwischen neu bekannte
// Widget-Id an ihrer Default-Position ein, nicht hinten. Bis 2026-09-23 hing
// daran zusaetzlich die Packung des Rasters (`isUserOrderedConfig` schaltete
// umsortierte Layouts auf die Quellordnung); das Raster packt seitdem immer
// dicht, die Einsortierung bleibt der Ort, an dem ein Neuzugang erscheint.
// --------------------------------------------------------

const widgets = await import('../public/utils/dashboard-widgets.js');

// Ein Bestandslayout, dem genau `missing` fehlt - sonst der unveraenderte
// Default, so wie es ein Haushalt gespeichert hat, bevor es diese Id gab.
function layoutOhne(missing) {
  return widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== missing)
    .map((w, i) => ({ ...w, order: i }));
}

// DIE LISTE STEHT HIER FEST, NICHT IHRE LAENGE, und der Unterschied ist die
// Lehre aus der Zahl, die vorher hier stand.
//
// Fest sein muss sie: ein Selektor, der aus `WIDGET_IDS` abgeleitet waere,
// koennte nie melden, dass sich `WIDGET_IDS` geaendert hat - er waere
// tautologisch und der Guard damit wertlos. Das war die Begruendung der Zahl,
// und sie gilt unveraendert.
//
// Eine ZAHL war trotzdem die falsche Form, und zwar genau am Merge: zwei
// Zweige, die je ein Widget ergaenzen, schreiben BEIDE `20` -> `21`. Git sieht
// zweimal dieselbe Aenderung und fuehrt sie konfliktfrei zusammen; danach hat
// `WIDGET_IDS` 22 Eintraege, hier steht 21, und die Suite ist auf main rot,
// obwohl jeder Zweig fuer sich gruen war.
//
// Die Liste loest beides auf einmal: sie meldet weiterhin JEDE Aenderung an
// WIDGET_IDS (ihr eigentlicher Zweck), und zwei Zweige, die je eine ANDERE Id
// ergaenzen, aendern dieselbe Zeile unterschiedlich - das ist ein Konflikt, den
// git meldet, statt ihn stillschweigend zu verschmelzen.
const ERWARTETE_WIDGET_IDS = [
  'tasks', 'calendar', 'meals', 'shopping', 'pantry', 'birthdays', 'countdown', 'budget',
  'rewards', 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule',
  'waste', 'family', 'notes', 'weather', 'clock', 'metrics', 'quicklinks',
];

test('Widget-Merge: eine fehlende Id landet an ihrer Default-Position, nicht hinten', () => {
  assert(widgets.WIDGET_IDS.join(',') === ERWARTETE_WIDGET_IDS.join(','),
    `Reichweite: WIDGET_IDS ist ${widgets.WIDGET_IDS.join(',')}, erwartet ${ERWARTETE_WIDGET_IDS.join(',')}`);
  const falsch = widgets.WIDGET_IDS.filter((id) => {
    const merged = widgets.normalizeDashboardConfig(layoutOhne(id));
    return merged.map((w) => w.id).join(',') !== widgets.WIDGET_IDS.join(',');
  });
  assert(falsch.length === 0,
    `An die falsche Stelle einsortiert: ${falsch.join(', ')} - erwartet ist die Default-Position`);
});

test('Widget-Merge: zwei fehlende Ids behalten ihre Reihenfolge zueinander', () => {
  const zwei = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => !['meals', 'shopping'].includes(w.id))
    .map((w, i) => ({ ...w, order: i }));
  const merged = widgets.normalizeDashboardConfig(zwei).map((w) => w.id);
  assert(merged.join(',') === widgets.WIDGET_IDS.join(','),
    `Zwei benachbarte Neuzugaenge kamen durcheinander: ${merged.join(',')}`);
});

test('Widget-Merge: eine fehlende Id am Anfang der Liste landet vorn, nicht hinten', () => {
  // Der Fall ohne Vorgaenger - `tasks` ist WIDGET_IDS[0]. Die Rueckwaertssuche
  // findet nichts und muss auf Position 0 fallen.
  const merged = widgets.normalizeDashboardConfig(layoutOhne('tasks'));
  assert(merged[0].id === 'tasks', `Erste Id landete auf Position ${merged.findIndex((w) => w.id === 'tasks')}`);
});

test('Widget-Merge: ein umsortiertes Layout laesst den Neuzugang seinem Vorgaenger folgen', () => {
  // Der Anlassfall ist der Demo-Haushalt (gemessen 2026-08-13): `weather` steht
  // dort ganz vorn, `clock` und `metrics` fehlen. Ein umsortiertes Layout hat
  // keine Default-Position mehr, nur noch Nachbarn - der Neuzugang haengt sich
  // an seinen Vorgaenger, nicht ans Ende. Das ist die Entscheidung, und sie
  // steht hier, weil sie sonst niemandem auffaellt.
  const demo = ['weather', 'family', 'budget', 'birthdays', 'rewards', 'notes',
    'tasks', 'calendar', 'shopping', 'meals', 'housekeeping', 'health', 'cycle']
    .map((id, i) => ({ id, order: i, visible: i < 6, size: '1x1' }));
  const merged = widgets.normalizeDashboardConfig(demo);
  const sichtbar = merged.filter((w) => w.visible).map((w) => w.id);
  // `countdown` ist der zweite Neuzugang in diesem Layout (#647) und belegt
  // dieselbe Zusicherung ein zweites Mal: sein Vorgaenger in WIDGET_IDS ist
  // `birthdays`, und dorthin gehoert er - nicht ans Ende.
  assert(sichtbar.join(',') === 'weather,metrics,family,budget,birthdays,countdown,rewards,notes',
    `Neuzugang an unerwarteter Stelle: ${sichtbar.join(',')}`);
});

test('Widget-Optionen reisen durch die Normalisierung, ohne dass sie jemand kennt (#814)', () => {
  const gespeichert = widgets.DEFAULT_WIDGET_CONFIG.map((w) => (
    w.id === 'tasks' ? { ...w, options: { categories: ['household'], erfunden: true } } : { ...w }
  ));
  const merged = widgets.normalizeDashboardConfig(gespeichert);
  const tasks = merged.find((w) => w.id === 'tasks');
  assert(tasks.options?.categories?.[0] === 'household', 'die Auswahl ist unterwegs verlorengegangen');
  assert(tasks.options?.erfunden === true,
    'eine unbekannte Option muss durchgehen - sonst steht hier eine zweite Registry');
  // Und ein Widget ohne Optionen bekommt keine leere Klammer angehaengt.
  assert(!('options' in merged.find((w) => w.id === 'weather')),
    'ein leeres Optionsobjekt waere in jedem Layout dieselbe leere Klammer');
});

test('sameWidgetConfig sieht eine geaenderte Option (#814)', () => {
  // Sonst bietet der Toast nach einer reinen Optionsaenderung kein
  // „Rueckgaengig" an - genau der Fall, in dem die Aenderung am wenigsten
  // sichtbar ist.
  const a = widgets.DEFAULT_WIDGET_CONFIG.map((w) => ({ ...w }));
  const b = a.map((w) => (w.id === 'calendar' ? { ...w, options: { scope: 'mine' } } : { ...w }));
  assert(widgets.sameWidgetConfig(a, a.map((w) => ({ ...w }))), 'identische Layouts gelten als verschieden');
  assert(!widgets.sameWidgetConfig(a, b), 'eine geaenderte Option faellt nicht auf');
});

test('dashboardQuery uebersetzt Optionen in Parameter, die die Route versteht (#814)', () => {
  const mit = (id, options) => widgets.DEFAULT_WIDGET_CONFIG
    .map((w) => (w.id === id ? { ...w, options } : { ...w }));

  assert(widgets.dashboardQuery(widgets.DEFAULT_WIDGET_CONFIG) === '/dashboard',
    'ohne Optionen darf kein Parameter entstehen - sonst zahlt jeder Aufruf eine zweite Abfrage');
  assert(widgets.dashboardQuery(mit('calendar', { scope: 'mine' })) === '/dashboard?events_scope=mine',
    `Kalender-Parameter falsch: ${widgets.dashboardQuery(mit('calendar', { scope: 'mine' }))}`);
  assert(widgets.dashboardQuery(mit('calendar', { scope: 'all' })) === '/dashboard',
    '„alle" ist die Abwesenheit einer Einschraenkung, kein Parameter');
  // Die Geburtstags-Abwahl (#927) folgt derselben Regel, nur andersherum
  // notiert: gespeichert und geschickt wird das Wegnehmen, nicht das Haekchen.
  assert(widgets.dashboardQuery(mit('calendar', { birthdays: 'hide' })) === '/dashboard?events_birthdays=hide',
    `Geburtstags-Parameter falsch: ${widgets.dashboardQuery(mit('calendar', { birthdays: 'hide' }))}`);
  assert(widgets.dashboardQuery(mit('calendar', { birthdays: 'show' })) === '/dashboard',
    'die Zustimmung ist der Auslieferungszustand und braucht keinen Parameter');
  const beide = widgets.dashboardQuery(mit('calendar', { scope: 'mine', birthdays: 'hide' }));
  assert(beide === '/dashboard?events_scope=mine&events_birthdays=hide',
    `beide Kalender-Optionen zusammen falsch: ${beide}`);
  const zwei = widgets.dashboardQuery(mit('tasks', { categories: ['household', 'school'] }));
  assert(zwei === '/dashboard?tasks_category=household&tasks_category=school',
    `Kategorien falsch: ${zwei}`);
  assert(widgets.dashboardQuery(mit('tasks', { categories: [] })) === '/dashboard',
    'eine leere Auswahl ist keine Einschraenkung');
  const notes = widgets.dashboardQuery(mit('notes', { categories: [12, 34] }));
  assert(notes === '/dashboard?notes_category=12&notes_category=34',
    `Notiz-Kategorien falsch: ${notes}`);
  // Ein Layout, in dem es das Widget gar nicht gibt, darf nicht werfen.
  assert(widgets.dashboardQuery([]) === '/dashboard');
  assert(widgets.dashboardQuery(null) === '/dashboard');
});

// --------------------------------------------------------
// Das dichte Raster, nachgerechnet (Critique 2026-09-23)
//
// `packGrid` rechnet `grid-auto-flow: row dense` fuer Kacheln mit reinen Spans
// nach; der Loch-Hinweis im Bearbeiten-Modus schlaegt darauf eine Groesse vor.
// Ob der Browser genauso packt, misst test:dashboard-surface-browser am
// gerenderten Raster - hier steht die Rechnung selbst.
// --------------------------------------------------------

const kachel = (id, cols, rows, size = `${cols}x${rows}`) => ({ id, cols, rows, size });

test('packGrid: dicht heisst, eine spaetere kleine Kachel fuellt das fruehere Loch', () => {
  // calendar 2x1 laesst rechts eine Zelle frei, tasks 2x1 passt nicht hinein,
  // notes 1x1 schon - `dense` setzt den Cursor fuer jede Kachel zurueck.
  const cells = widgets.packGrid([kachel('calendar', 2, 1), kachel('tasks', 2, 1), kachel('notes', 1, 1)], 3);
  assert(cells.map((r) => r.map((v) => v ?? '.').join(' ')).join(' / ')
    === 'calendar calendar notes / tasks tasks .', `Belegung: ${JSON.stringify(cells)}`);
  assert(widgets.gridHoleCount(cells) === 0, 'die letzte Zeile darf auslaufen, sie ist kein Loch');
});

test('packGrid: eine hohe Kachel belegt beide Zeilen, eine zu breite wird an der Kante gekappt', () => {
  const cells = widgets.packGrid([kachel('family', 1, 2), kachel('weather', 3, 1), kachel('notes', 2, 1)], 2);
  // weather ist breiter als das Raster: gerechnet wird mit zwei Spalten.
  assert(cells[0][0] === 'family' && cells[1][0] === 'family', `family: ${JSON.stringify(cells)}`);
  assert(cells[2].every((v) => v === 'weather'), `weather: ${JSON.stringify(cells)}`);
  assert(cells[0][1] === null && cells[1][1] === null && cells[3].every((v) => v === 'notes'),
    `notes passt nicht neben family und landet unten: ${JSON.stringify(cells)}`);
  assert(widgets.gridHoleCount(cells) === 2);
});

test('suggestGridHoleFill: schlaegt die billigste Aenderung am Nachbarn des Lochs vor', () => {
  // Drei Breitkacheln in drei Spalten: rechts bleibt je eine Zelle frei.
  // Billigste Loesung ist dieselbe Flaeche in anderer Form, und zwar an der
  // Kachel links neben dem ersten Loch.
  const items = [kachel('calendar', 2, 1), kachel('tasks', 2, 1), kachel('notes', 2, 1)];
  const presets = (item) => [['1x1', 1, 1], ['2x1', 2, 1], ['1x2', 1, 2], ['2x2', 2, 2]]
    .map(([size, cols, rows]) => ({ size, cols, rows, id: item.id }));
  const vorschlag = widgets.suggestGridHoleFill(items, 3, presets);
  nodeAssert.deepEqual(vorschlag, { id: 'calendar', size: '1x2' });
  const danach = widgets.packGrid(items.map((it) => (it.id === 'calendar' ? { ...it, cols: 1, rows: 2 } : it)), 3);
  assert(widgets.gridHoleCount(danach) === 0, 'der Vorschlag schliesst das Loch nicht');
});

test('suggestGridHoleFill: waechst lieber, als Inhalt wegzunehmen', () => {
  // Der Demo-Haushalt bei 1440px, in seiner gespeicherten Rangfolge: unter
  // „Belohnungen" (1x1, dicht nach vorn gerueckt) bleibt ein Loch neben den
  // Kennzahlen (2x1). Kennzahlen als 1x1 schloesse es auch - und naehme einer
  // Kachel die Haelfte. Belohnungen als 1x2 waechst in das Loch hinein.
  const items = [
    kachel('family', 1, 2), kachel('budget', 1, 2), kachel('birthdays', 1, 2),
    kachel('weather', 2, 1), kachel('metrics', 2, 1), kachel('rewards', 1, 1), kachel('notes', 2, 1),
  ];
  const presets = (item) => [['1x1', 1, 1], ['2x1', 2, 1], ['1x2', 1, 2], ['2x2', 2, 2]]
    .map(([size, cols, rows]) => ({ size, cols, rows, id: item.id }));
  assert(widgets.gridHoleCount(widgets.packGrid(items, 3)) === 1, 'Reichweite: das Ausgangsraster hat genau ein Loch');
  nodeAssert.deepEqual(widgets.suggestGridHoleFill(items, 3, presets), { id: 'rewards', size: '1x2' });
});

test('suggestGridHoleFill: ohne Loch und ohne Ausweg schweigt er', () => {
  const presets = (item) => [{ size: item.size, cols: item.cols, rows: item.rows }];
  assert(widgets.suggestGridHoleFill([kachel('a', 1, 1), kachel('b', 1, 1)], 2, presets) === null,
    'eine volle Zeile hat kein Loch');
  // Nur die eigene Groesse im Angebot: es gibt nichts vorzuschlagen.
  assert(widgets.suggestGridHoleFill([kachel('a', 2, 1), kachel('b', 2, 1), kachel('c', 1, 1)], 3, presets) === null,
    'ohne Kandidaten darf kein Vorschlag entstehen');
});

test('isUserOrderedConfig gibt es nicht mehr - das Raster schaltet nach keiner Reihenfolge um', () => {
  // Gegenprobe zur Entscheidung vom 2026-09-23 (immer dicht): ein Aufrufer,
  // der die Unterscheidung zurueckholen wollte, faende sie hier nicht mehr.
  assert(!('isUserOrderedConfig' in widgets), 'isUserOrderedConfig ist zurueck');
});

test('Widget-Merge: gespeicherte Reihenfolge gewinnt ueber die Array-Position', () => {
  // `order` und Array-Position koennen auseinanderlaufen; eingefuegt wird an
  // einer Position, also muss vorher sortiert sein.
  const gemischt = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'notes')
    .map((w, i) => ({ ...w, order: i }))
    .reverse();
  const merged = widgets.normalizeDashboardConfig(gemischt).map((w) => w.id);
  assert(merged.join(',') === widgets.WIDGET_IDS.join(','),
    `Array-Position statt order gelesen: ${merged.join(',')}`);
});

test('Widget-Merge: Groesse und Sichtbarkeit eines Bestandseintrags bleiben unberuehrt', () => {
  const gespeichert = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'metrics')
    .map((w) => ({ ...w, visible: w.id === 'tasks' ? true : w.visible, size: w.id === 'tasks' ? '2x2' : w.size }));
  const merged = widgets.normalizeDashboardConfig(gespeichert);
  const tasks = merged.find((w) => w.id === 'tasks');
  assert(tasks.size === '2x2' && tasks.visible === true, 'gespeicherte Groesse/Sichtbarkeit ueberschrieben');
  // Der Neuzugang erbt dagegen seinen Default - Opt-in-Module erscheinen nicht ungefragt.
  const health = widgets.normalizeDashboardConfig(layoutOhne('health')).find((w) => w.id === 'health');
  assert(health.visible === false, 'ein neu ergaenztes Opt-in-Widget kam sichtbar herein');
});

// --------------------------------------------------------
// Kennzahlreihe: sie zeigt, was sonst NIRGENDS steht
//
// Anlass (Critique 2026-08-13, P1): im Standard-Layout waren alle vier Kacheln
// Echos. „2.504 EUR Saldo" stand 800px neben dem Budget-Widget mit derselben
// Zahl, „17 Tage / Tante Claire Becker" ueber dem Geburtstage-Widget mit
// demselben Namen, „23 Artikel" und „4 ueberfaellig" in den Cockpit-Zeilen.
// PRODUCT.md fuehrt das „ueberlastete Feature-Dashboard" als Anti-Referenz.
//
// GEPRUEFT WIRD DIE AUSWAHL, NICHT DAS MARKUP: was die Reihe zeigt, ist die
// Zusage - dass sie es in einem <a> zeigt, ist ihre Form.
// --------------------------------------------------------

const METRIC_DATA = {
  openTaskCount: 5, overdueTaskCount: 2,
  shoppingOpenCount: 23, shoppingOpenLists: 2,
  budget: { entryCount: 9, balance: 2504, income: 3000 },
  birthdays: [{ name: 'Tante Claire', days_until: 17 }],
  todayMeals: [{ title: 'Suppe' }],
  // `pinnedNotes` ist die VORSCHAU (gepinnt zuerst, dann aktuellste, drei
  // Stueck) - die Zahl der gepinnten steht daneben, weil die Liste nicht
  // filtert. Die Vorlage fuehrt beides, sonst prueft sie eine Nutzlast, die es
  // so nicht gibt (Codex-Review zu PR #754).
  pinnedNotes: [{ title: 'Urlaub', pinned: 1 }],
  pinnedNotesCount: 1,
  rewards: { view: 'self', me: 1, standings: [{ id: 1, display_name: 'Leo', balance: 60 }], catalog: [] },
  health: { hasMeds: true, dosesTotal: 3, dosesTaken: 1, dosesSkipped: 0, nextDose: { name: 'Vitamin D3' }, lowStockCount: 0 },
  housekeeping: { configured: true, visitsThisMonth: 4, present: true },
};

test('Kennzahlreihe wiederholt nicht, was das Cockpit schon sagt', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const ids = __test.selectMetricTiles(METRIC_DATA, 'EUR', new Set()).map((t) => t.id);
  for (const covered of ['tasks', 'calendar', 'shopping', 'meals']) {
    assert(!ids.includes(covered),
      `„${covered}" wird vom Cockpit schon zusammengefasst und gehoert nicht zusaetzlich in die Reihe`);
  }
  assert(ids.length >= 2, 'ohne sichtbare Widgets muss die Reihe etwas zu zeigen haben');
});

test('Kennzahlreihe wiederholt nicht, was ein sichtbares Widget schon sagt', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const ohne = __test.selectMetricTiles(METRIC_DATA, 'EUR', new Set()).map((t) => t.id);
  assert(ohne.includes('budget'), 'ohne Budget-Widget gehoert die Budget-Kachel in die Reihe');

  const mit = __test.selectMetricTiles(METRIC_DATA, 'EUR', new Set(['budget', 'birthdays'])).map((t) => t.id);
  assert(!mit.includes('budget'), 'neben einem sichtbaren Budget-Widget ist die Budget-Kachel dessen Echo');
  assert(!mit.includes('birthdays'), 'dasselbe gilt fuer die Geburtstage');

  // ES IST EIN FILTER, KEINE ZWEITE LISTE: wer ein Widget ausblendet, bekommt
  // dessen Kachel zurueck. Ohne diese Gegenrichtung waere ein Guard gruen, der
  // die Reihe schlicht leert.
  //
  // NICHT UEBER DIE LAENGE - das war die erste Fassung und die falsche Frage:
  // `slice(0, METRIC_TILE_COUNT)` deckelt beide Mengen auf vier, also sind sie
  // gleich lang, obwohl sich ihr Inhalt unterscheidet. Die Zusage ist, dass der
  // Filter AUSTAUSCHT statt zu leeren.
  assert(mit.length === ohne.length,
    'faellt ein Kandidat weg, rueckt der naechste nach - die Reihe wird nicht kuerzer');
  assert(mit.some((id) => !ohne.includes(id)),
    'und der Nachrueckende ist einer, der vorher nicht dran war');
});

// --------------------------------------------------------
// Schedule-Widget: Verdrahtung (Schedule v2)
// ANLASS: der Zyklus-Slice hat zwei Stellen, an denen `data` bei einem
// Refresh ersetzt wird (reloadIfQueryChanged, refreshDashboardData), und BEIDE
// muessen den eigenen Slice mitnehmen - sonst blitzt die Kachel bei jedem
// stillen 15-Minuten-Refresh kurz auf ihren Leerzustand zurueck. Der
// Schedule-Slice teilt sich denselben Mechanismus (ein eigener Slice, den
// /dashboard nie mitliefert, weil er - anders als bei cycle - keine
// Owner-Beschraenkung braucht) und denselben Zweiteiler.
// --------------------------------------------------------

// M-6a/M-6b: a plain `fresh.schedule = data.schedule;` carry-over is still
// present TWICE in the file (once per refresh site) - a bare count-of-two
// guard stays green even if refreshDashboardData() regressed back to pure
// carry-over, since the literal line still exists there too, just preceded by
// nothing. This guard instead pins WHICH mechanism each site uses:
// reloadIfQueryChanged() (fires only on a filter change) still carries the
// slice over unchanged like cycle, but refreshDashboardData() (the 15-minute
// silent/background tick) must reset-and-reload it first - "who's on duty
// today" is a moving target across both a 15-minute tick and a midnight
// rollover on a wall-mounted tablet, unlike the owner-only, privacy-gated
// cycle slice.
test('das Schedule-Widget wird an der periodischen Refresh-Stelle zurueckgesetzt und neu geladen, nicht nur uebernommen wie an der query-getriebenen Stelle', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert(/schedule:\s*'schedule'/.test(src), 'MODULE_FOR_WIDGET kennt das Modul hinter dem Widget nicht');
  assert(/schedule:\s*\(size\)\s*=>\s*renderScheduleWidget/.test(src), 'widgetById hat keinen Eintrag fuer schedule, oder er reicht die Groesse nicht durch (PR #930 review)');

  // reloadIfQueryChanged(): only fires on a filter change, no staleness
  // concern - the slice still just rides along, exactly like cycle.
  const reloadFn = src.slice(src.indexOf('async function reloadIfQueryChanged'), src.indexOf('async function persistWidgetConfig'));
  nodeAssert.match(reloadFn, /fresh\.cycle = data\.cycle;/);
  nodeAssert.match(reloadFn, /fresh\.schedule = data\.schedule;/, 'reloadIfQueryChanged must still carry the old slice over unchanged - it has no reason to refetch on every filter change');

  // refreshDashboardData(): the 15-minute silent/background refresh. Must
  // reset the memoized slice to undefined (so ensureScheduleSlice()'s own
  // `if (data.schedule !== undefined) return;` early-out does not skip the
  // refetch) and re-await it with a freshly computed "today" BEFORE folding
  // it into `fresh` - in that order, or a stale/failed slice survives another
  // 15 minutes.
  const refreshFn = src.slice(src.indexOf('async function refreshDashboardData'), src.indexOf('const refreshTimerId'));
  nodeAssert.match(refreshFn, /data\.schedule = undefined;/, 'must reset the memoized slice, or ensureScheduleSlice() short-circuits on its own "already loaded" memo and nothing is refetched');
  nodeAssert.match(refreshFn, /await ensureScheduleSlice\(\);/, 'must re-await the slice, not just remember the previous result');
  const resetIndex = refreshFn.indexOf('data.schedule = undefined;');
  const reEnsureIndex = refreshFn.indexOf('await ensureScheduleSlice();');
  const carryOverIndex = refreshFn.indexOf('fresh.schedule = data.schedule;');
  assert(
    resetIndex > -1 && reEnsureIndex > resetIndex && carryOverIndex > reEnsureIndex,
    'the reset must precede the re-fetch, which must precede folding the (now newly loaded) slice into `fresh` - '
    + 'a regression back to a bare carry-over would still satisfy a loose "the line appears twice in the file" '
    + 'grep but fails this ordering check',
  );
});

test('das Schedule-Widget ist in der Anpassen-Standardliste als Opt-in eingetragen', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  assert(widgets.WIDGET_IDS.includes('schedule'), 'WIDGET_IDS fehlt schedule');
  assert(widgets.DEFAULT_HIDDEN_WIDGETS.has('schedule'),
    'schedule muss wie rewards/health/housekeeping erst im Anpassen-Tray auftauchen, nicht ab Werk sichtbar sein');
});

// --------------------------------------------------------
// Schedule-Widget: Groessenklasse und Zeilendeckel (PR #930 review)
// ANLASS: `schedule` fiel durch defaultWidgetSize() auf 1x1, obwohl die
// Kachel eine Mitglieder-Liste ist (Avatar, Name, Schicht) wie `family` -
// gemessen rendert 1x1 218px, die Kachel selbst 318px, und zieht eine
// benachbarte Kachel in derselben Rasterzeile mit hoch. Zweiter Teil: der
// Renderer kannte gar keinen Zeilendeckel, `listRowCap` war die einzige
// Listenkachel ohne ihn - dieselbe Luecke, die #928 bei den Notizen schon
// hatte (renderPinnedNotes ist hier das Vorbild).
// --------------------------------------------------------

test('die Schedule-Kachel defaultet auf 1x2 wie family, nicht auf 1x1', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  nodeAssert.equal(widgets.defaultWidgetSize('schedule'), '1x2',
    'eine Mitglieder-Liste braucht Hoehe, nicht Breite (PR #930 review)');
});

test('Schedule-Widget: die Zeilenzahl kommt aus der Kachelgroesse, nicht aus der vollen Eintragsliste', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const users = ['Anna', 'Ben', 'Cara', 'Dax', 'Emi', 'Finn'].map((name, i) => ({ id: i + 1, display_name: name }));
  const type = { id: 1, name: 'Früh', short_code: 'F', color: '#6C3AED' };
  const schedule = {
    hasTypes: true,
    entries: users.map((u) => ({ user_id: u.id, shift_type: type })),
  };
  const zeilen = (html) => (html.match(/class="schedule-widget-row"/g) || []).length;

  // Die hohe Kachel (1x2, ihr eigener Standard) zeigt fuenf von sechs Zeilen -
  // genau hier stand der Fehler: ohne Deckel waeren es alle sechs gewesen.
  nodeAssert.equal(zeilen(__test.renderScheduleWidget(schedule, users, '1x2')), 5,
    'die hohe Kachel muss bei fuenf Zeilen deckeln, nicht alle sechs zeigen');
  // Gegenprobe: die flache Kachel deckelt enger.
  nodeAssert.equal(zeilen(__test.renderScheduleWidget(schedule, users, '1x1')), 3,
    'die flache Kachel muss bei drei Zeilen deckeln');

  // Der Header zaehlt trotzdem ueber ALLE sechs - die ehrliche Zahl, unabhaengig
  // vom Zeilendeckel darunter (die Review nannte das ausdruecklich als
  // Bedingung: der Header darf nicht mitschneiden).
  const html = __test.renderScheduleWidget(schedule, users, '1x1');
  nodeAssert.match(html, /class="widget__badge">6</, 'der Header muss die volle Anzahl "on shift" zeigen, nicht die gedeckelte Zeilenzahl');
});

test('Schedule-Widget: der Zeilendeckel zeigt die Im-Dienst-Eintraege zuerst, nicht die ersten in API-Reihenfolge', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  // Sechs Mitglieder, `users ORDER BY id` - die zwei im Dienst (Emi, Finn)
  // haben bewusst die hoechsten ids, damit ein ungefilterter `slice(0, N)`
  // sie abschneiden wuerde (Review #930: Header zaehlt "2", jede sichtbare
  // Zeile zeigt "Freier Tag").
  const users = ['Anna', 'Ben', 'Cara', 'Dax', 'Emi', 'Finn'].map((name, i) => ({ id: i + 1, display_name: name }));
  const type = { id: 1, name: 'Früh', short_code: 'F', color: '#6C3AED' };
  const schedule = {
    hasTypes: true,
    entries: users.map((u) => ({ user_id: u.id, shift_type: ['Emi', 'Finn'].includes(u.display_name) ? type : null })),
  };

  const html = __test.renderScheduleWidget(schedule, users, '1x1'); // deckelt bei 3 von 6
  nodeAssert.match(html, /class="widget__badge">2</, 'der Header muss 2 im Dienst zeigen');
  nodeAssert.match(html, /Emi/, 'Emi ist im Dienst und muss trotz Deckel sichtbar sein');
  nodeAssert.match(html, /Finn/, 'Finn ist im Dienst und muss trotz Deckel sichtbar sein');
});

// Eine Person mit einem Extra (Bereitschaft NEBEN einer regulaeren Schicht,
// server/routes/schedule-extras.js) traegt zwei Eintraege am selben Tag - die
// Ueberschrift zaehlt trotzdem PERSONEN ("wer arbeitet heute"), nicht
// Schicht-Zeilen, sonst wuerde genau diese Person doppelt gezaehlt.
test('renderScheduleWidget() zaehlt Personen, nicht Schicht-Eintraege, und begrenzt nur die sichtbaren Zeilen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const users = [
    { id: 1, display_name: 'Alice' },
    { id: 2, display_name: 'Bob' },
    { id: 3, display_name: 'Carol' },
  ];
  const shiftType = { id: 1, name: 'Frueh', short_code: 'F', color: '#6C3AED' };
  const entries = [
    { user_id: 1, source: 'override', shift_type: shiftType },
    { user_id: 1, source: 'extra', shift_type: shiftType }, // dieselbe Person, zweiter Eintrag
    { user_id: 2, source: 'override', shift_type: shiftType },
    { user_id: 3, source: 'override', shift_type: shiftType },
  ];

  const wide = __test.renderScheduleWidget({ entries, hasTypes: true }, users, '1x2');
  nodeAssert.match(wide, /widget__badge">3</, 'drei verschiedene Personen sind im Dienst, nicht vier Zeilen');
  nodeAssert.equal((wide.match(/schedule-widget-row"/g) || []).length, 4, 'auf 1x2 (Deckel 5) passen alle vier Zeilen');

  const narrow = __test.renderScheduleWidget({ entries, hasTypes: true }, users, '1x1');
  nodeAssert.match(narrow, /widget__badge">3</, 'die Kopfzahl bleibt der wahre Bestand, unabhaengig von der Kachelgroesse');
  nodeAssert.equal((narrow.match(/schedule-widget-row"/g) || []).length, 3, 'auf 1x1 (Deckel 3) werden nur drei der vier Zeilen gezeigt');
});

test('Kennzahlreihe fuehrt mit den Modulen, die sonst kein Widget zeigen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  // Die drei Opt-in-Module sind im Werks-Layout unsichtbar (DEFAULT_HIDDEN_WIDGETS)
  // - genau deshalb sind sie die eigentlichen Kandidaten der Reihe.
  for (const id of ['rewards', 'health', 'housekeeping']) {
    assert(__test.METRIC_TILE_ORDER.includes(id),
      `„${id}" zeigt im Standard-Layout kein Widget und gehoert damit in die Kandidaten`);
  }
  // Und ohne Daten gibt es keine Kachel - eine leere Zahl ist keine Kennzahl.
  const leer = __test.selectMetricTiles(
    { ...METRIC_DATA, health: { hasMeds: false }, housekeeping: { configured: false }, rewards: { standings: [] } },
    'EUR', new Set(['budget', 'birthdays', 'notes']),
  );
  assert(leer.length === 0, 'ohne Daten und ohne Kandidaten bleibt die Reihe weg, statt leer dazustehen');
});

test('Kennzahlreihe ist eine Zeile, kein Block', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  // 671px hoch fuer vier Zahlen war der Anlass; die Mitteilung zum Bau sagte
  // „in der Hoehe, die ein Widget-Kopf kostet".
  assert(widgets.defaultWidgetSize('metrics') === '2x1',
    'die Reihe startet als Zeile - 2x2 war der Block, der 671px fuer 80px Inhalt nahm');
});

test('Kennzahlreihe bezieht ihre Hoehe aus ihrem Inhalt, nicht von aussen', () => {
  // ZWEITER ANLAUF (Critique 2026-08-13). Nach dem ersten Fix stand die Reihe
  // mobil bei 105px - und auf dem Desktop weiter bei 361px je Kachel, fuer 71px
  // Inhalt. Die Zahl `2x1` oben war dabei die ganze Zeit gruen: sie prueft das
  // Raster-Kaestchen, nicht die gerenderte Hoehe. Ein Zielwert, der an dem
  // Viewport gruen ist, an dem der Defekt nicht lebt, ist keine Zusicherung.
  //
  // Statisch pruefbar ist die URSACHE, und die sind genau zwei Deklarationen,
  // die Hoehe von aussen beziehen: `flex: 1` laesst die Reihe die Hoehe ihres
  // Wrappers erben (und der ist so hoch wie die hoechste Karte SEINER
  // Rasterzeile), `align-content: stretch` verteilt den Ueberschuss auf die
  // einzige Rasterzeile. Beides zusammen war der Faktor 4,5.
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const block = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('\n}', at));
  };

  const wrapper = block('.widget-wrapper > .metric-tiles');
  assert(wrapper, '.widget-wrapper > .metric-tiles muss es geben - sonst prueft dieser Guard nichts');
  assert(!/flex:\s*1\b/.test(wrapper),
    'die Kennzahlreihe darf ihre Hoehe nicht vom Wrapper erben (flex: 1) - gemessen wurden daraus 361px je Kachel fuer 71px Inhalt');

  const tiles = block('.metric-tiles');
  assert(tiles, '.metric-tiles muss es geben');
  assert(!/align-content:\s*stretch/.test(tiles),
    'align-content: stretch gibt der einzigen Rasterzeile allen Ueberschuss - die Reihe waechst auf ihren Inhalt, nicht auf ihren Platz');

  // UND DIE ZELLE, NICHT NUR DIE REIHE (Critique 2026-08-13, zweite Runde).
  //
  // Die zwei Zusicherungen darueber haben die Reihe repariert und die Zelle
  // stehen lassen: `.widget-wrapper { align-self: stretch }` liess sie weiter
  // die Hoehe der hoechsten Karte ihrer Rasterzeile beanspruchen, gemessen
  // 753x360,5px fuer eine 105px hohe Reihe. Die Leere war nicht verschwunden,
  // sie war aus der getoenten Kachel auf den Grund gewandert - und dieser
  // Guard hat es nicht gesehen, weil er dieselbe Ebene prueft wie der Fix,
  // den er begleitet. Das ist das Muster, das diese Runde dreimal gefunden
  // hat: die Sonde steht dort, wo repariert wurde, nicht dort, wo es weh tat.
  assert(/\.widget-wrapper:has\(>\s*\.metric-tiles\)\s*\{[^}]*align-self:\s*start/.test(css),
    'die ZELLE der Kennzahlreihe muss auf ihren Inhalt schrumpfen - sonst steht die Reihe richtig und die Buehne darunter ist leer');
});

// --------------------------------------------------------
// Wetterlage, Gangart und Temperaturband (#Wetter-Kur 2026-08-17)
// --------------------------------------------------------

/**
 * DIE ICON-LISTE KOMMT VOM SERVER, NICHT AUS DIESER DATEI. `wmoIcon()` in
 * server/routes/weather.js ist die einzige Stelle, die entscheidet, welche
 * Lucide-Namen je aus Open-Meteo herausfallen koennen - eine Liste hier waere
 * die zweite Wahrheit und liefe beim naechsten WMO-Code auseinander, ohne rot
 * zu werden. Der Guard liest deshalb die Rueckgabewerte der Funktion.
 *
 * DIESER GUARD KOMMT AUS EINEM GEMESSENEN FEHLER, nicht aus Vorsicht: die
 * Sonne bekam ihre Rotation nie, weil `'sun'.endsWith('n')` wahr ist und die
 * Tag/Nacht-Pruefung der OWM-Codes auf den Lucide-Zweig durchschlug. Ein
 * Struktur-Guard ueber die CSS-Regeln sah das nicht - die Regel existierte,
 * das Attribut kam nur nie an. Die Ebene muss die AUSGABE sein.
 */
test('jedes Wetter-Icon des Servers findet eine Lage, und die Sonne dreht sich', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const routeSrc = readFileSync(new URL('../server/routes/weather.js', import.meta.url), 'utf8');
  const wmoFn = routeSrc.match(/function wmoIcon\([\s\S]*?\n}/);
  assert(wmoFn, 'wmoIcon() nicht gefunden - die Quelle der Icon-Namen ist weg');
  const icons = [...new Set([...wmoFn[0].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))];
  assert(icons.length >= 8, `Nur ${icons.length} Icon-Namen gelesen - die Signatur greift nicht mehr`);

  const untoned = icons.filter((icon) => !__test.weatherToneKey(icon));
  assert(untoned.length === 0, `Ohne Wetterton: ${untoned.join(', ')}`);

  // Und der OWM-Legacy-Zweig, der dieselbe Funktion benutzt.
  const owm = ['01d', '01n', '02d', '02n', '03d', '04d', '09d', '10d', '11d', '13d', '50d'];
  const untonedOwm = owm.filter((code) => !__test.weatherToneKey(code));
  assert(untonedOwm.length === 0, `OWM-Code ohne Wetterton: ${untonedOwm.join(', ')}`);

  assert(__test.weatherMotionAttr('sun').includes('rays'), 'die Sonne muss ihre Strahlen drehen');
  assert(__test.weatherMotionAttr('01d').includes('rays'), 'OWM-Tagsonne muss ihre Strahlen drehen');
  assert(__test.weatherMotionAttr('01n') === '', 'die klare Nacht bewegt sich nicht');
  assert(__test.weatherMotionAttr('moon') === '', 'der Mond zieht nicht');
  assert(__test.weatherMotionAttr('cloud-rain').includes('fall'), 'Regen faellt');
  assert(__test.weatherMotionAttr('cloud-lightning').includes('flash'), 'das Gewitter leuchtet');
  assert(__test.weatherMotionAttr('cloud').includes('drift'), 'die Wolke zieht');
});

/**
 * Der Wand-Modus rendert das Wetter aus denselben Bausteinen, aber in einer
 * eigenen Komposition - und genau dort geht so etwas verloren. Aus zwei Metern
 * ist der Ton die schnellere Auskunft als die Form, deshalb traegt hier JEDER
 * Vorhersagetag seinen eigenen (anders als auf der Karte, wo der Balken das
 * uebernimmt).
 */
test('der Wand-Modus faerbt jeden Wettertag, nicht nur den aktuellen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const weather = {
      provider: 'open-meteo', city: 'Dortmund', units: 'metric',
      current: { temp: 21, icon: 'cloud-lightning', desc: 'wmo.95', feels_like: 20, humidity: 70, wind_speed: 9 },
      forecast: [
        { date: '2026-08-17', icon: 'cloud-lightning', desc: 'wmo.95', temp_min: 16, temp_max: 21 },
        { date: '2026-08-18', icon: 'sun', desc: 'wmo.0', temp_min: 14, temp_max: 26 },
        { date: '2026-08-19', icon: 'cloud-snow', desc: 'wmo.71', temp_min: -2, temp_max: 1 },
      ],
    };
    const html = __test.renderWallSurface({ urgentTasks: [], upcomingEvents: [], users: [] }, weather, {});
    const section = html.slice(html.indexOf('wall__weather'));
    const tones = [...section.matchAll(/data-weather-tone="([a-z]+)"/g)].map((m) => m[1]);
    // Die Sektion selbst + drei Tage. Ohne die Reichweitenpruefung meldete ein
    // leerer Treffer fehlerfrei „alles gut".
    nodeAssert.equal(tones.length, 4, `vier Toene erwartet, gelesen: ${tones.join(', ')}`);
    nodeAssert.deepEqual(tones, ['storm', 'storm', 'clear', 'snow'],
      'die Sektion traegt die aktuelle Lage, jeder Tag seine eigene');
    nodeAssert.match(section, /data-weather-motion="flash"/, 'die Wand kennt die Gangart der aktuellen Lage');
  });
});

test('die Temperaturbaender liegen in jeder Einheit auf denselben Grenzen', async () => {
  const { __test: { weatherTempBand } } = await import('../public/pages/dashboard.js');
  // Dieselbe Wetterlage, drei Einheiten: -1 °C ist 30,2 °F ist 272,15 K, und
  // alle drei muessen „eisig" heissen. Genau diese Kette bricht, wenn jemand
  // eine Celsius-Schwelle im Code umrechnet statt sie auszuschreiben.
  for (const [units, freezing, mild, hot] of [
    ['metric', -1, 15, 30],
    ['imperial', 30, 59, 86],
    ['standard', 272, 288, 303],
  ]) {
    assert(weatherTempBand(freezing, units) === 'icy', `${units}: ${freezing} muss eisig sein`);
    assert(weatherTempBand(mild, units) === 'mild', `${units}: ${mild} muss mild sein`);
    assert(weatherTempBand(hot, units) === 'hot', `${units}: ${hot} muss heiss sein`);
  }
  assert(weatherTempBand(null, 'metric') === null, 'ohne Zahl kein Band');
  assert(weatherTempBand('x', 'metric') === null, 'ohne Zahl kein Band');
  // Eine unbekannte Einheit faellt auf metrisch zurueck statt auf undefined.
  assert(weatherTempBand(25, 'kelvinish') === 'warm', 'unbekannte Einheit faellt auf metrisch');
});

test('die Spanne der Vorhersage bleibt ein Balken, auch wenn die Woche flach ist', async () => {
  const { __test: { weatherSpanModel } } = await import('../public/pages/dashboard.js');
  const flat = weatherSpanModel([
    { temp_min: 10, temp_max: 10 }, { temp_min: 10, temp_max: 10 },
  ]);
  const one = flat({ temp_min: 10, temp_max: 10 });
  assert(one.to - one.from >= 0.13, 'eine flache Woche darf keinen unsichtbaren Balken ergeben');
  assert(one.from >= 0 && one.to <= 1, 'der Balken bleibt in seiner Spur');

  const week = weatherSpanModel([
    { temp_min: 0, temp_max: 10 }, { temp_min: 10, temp_max: 20 }, { temp_min: 5, temp_max: 15 },
  ]);
  const cold = week({ temp_min: 0, temp_max: 10 });
  const warm = week({ temp_min: 10, temp_max: 20 });
  assert(cold.from === 0 && warm.to === 1, 'die Woche spannt von ihrem Minimum bis zu ihrem Maximum');
  assert(warm.from > cold.from, 'der waermere Tag liegt weiter rechts');

  assert(weatherSpanModel([]) === null, 'ohne Vorhersage kein Modell');
  assert(weatherSpanModel([{ temp_min: 'x', temp_max: 'y' }]) === null, 'ohne Zahlen kein Modell');
});

// --------------------------------------------------------
// Kalendertag der Route: lokal, nie UTC
// --------------------------------------------------------

/* Die Dashboard-Route darf einen KALENDERTAG nicht aus `toISOString()` ziehen.
 *
 * CLAUDE.md fuehrt diese Falle: `.toISOString().slice(0,10)` liefert den
 * UTC-Tag, verglichen wird aber gegen Werte, die der Nutzer als lokalen
 * Kalendertag eingegeben hat (Mahlzeitendatum, due_date, Budget-Monat).
 * Oestlich von UTC lieferte das Dashboard dadurch in den fruehen Morgenstunden
 * die Mahlzeiten des VORTAGS, westlich davon am spaeten Abend die von morgen.
 *
 * Warum dieser Guard und nicht der Verhaltenstest daneben: der faellt nur auf,
 * wenn die Testmaschine gerade in einer Zone UND zu einer Stunde laeuft, in der
 * die beiden Tage auseinanderfallen. Die CI laeuft in UTC, wo sie IMMER gleich
 * sind - der Fehler war dort per Konstruktion unsichtbar und stand ueber
 * mehrere Releases gruen im Build.
 *
 * `.toISOString()` ohne den Datums-Schnitt bleibt erlaubt: ein echter Instant
 * (z.B. eine 48h-Grenze) ist in UTC korrekt aufgehoben. */
test('die Route zieht ihren Kalendertag lokal, nicht aus toISOString()', () => {
  const src = readFileSync(new URL('../server/routes/dashboard.js', import.meta.url), 'utf8');
  // Kommentare raus, sonst findet der Guard die Beschreibung der Falle im
  // Quelltext, die dort absichtlich steht.
  const code = withoutBlockComments(src)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  const treffer = [...code.matchAll(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g)];
  assert(
    treffer.length === 0,
    `server/routes/dashboard.js zieht an ${treffer.length} Stelle(n) einen Kalendertag aus `
    + 'toISOString() - das ist der UTC-Tag. Fuer alles, was der Nutzer als Kalendertag '
    + 'eingegeben hat, gilt todayLocalKey.',
  );
});

// --------------------------------------------------------
// Wetter: welcher Tag heisst "Heute" (#851)
// --------------------------------------------------------
/* Ein Vorhersagetag wird an seinem DATUM benannt, nie an seiner Position.
 *
 * Die Position war die Falle: der Server trennt den laufenden Tag aus
 * `forecast` heraus, `forecast[0]` ist also morgen - hart als „Heute"
 * beschriftet las sich die Reihe, als fehle ein Tag. Auf einem Wandtablet und
 * auf dem Handy stand derselbe Fehler zweimal, weil beide Fassungen dieselbe
 * Zeile kopiert hatten.
 *
 * Bezugsgroesse ist `weather.today.date`, der Kalendertag AM WETTERORT. Fehlt
 * er, gibt es kein „Heute" - lieber kein Label als ein falsches. */

const WEATHER_FIXTURE = {
  units: 'metric',
  city: 'Honolulu',
  current: { temp: 26, feels_like: 27, humidity: 70, icon: 'sun', desc: 'wmo.0', wind_speed: 8 },
  today: { date: '2026-08-24', temp_min: 22, temp_max: 29, icon: 'sun', desc: 'wmo.0' },
  forecast: [
    { date: '2026-08-25', temp_min: 21, temp_max: 28, icon: 'cloud', desc: 'wmo.3' },
    { date: '2026-08-26', temp_min: 20, temp_max: 27, icon: 'cloud-rain', desc: 'wmo.61' },
    { date: '2026-08-27', temp_min: 22, temp_max: 30, icon: 'sun', desc: 'wmo.0' },
  ],
};

test('Wetter: der erste Vorhersagetag heisst nicht "Heute"', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const label = __test.weatherDayLabel(WEATHER_FIXTURE, WEATHER_FIXTURE.forecast[0].date);
  assert(label !== 'common.today', 'forecast[0] ist morgen und darf nicht "Heute" heissen');
  assert(label === 'Di', `Wochentag erwartet, bekam: ${label}`);
});

test('Wetter: ein Tag, der wirklich heute ist, heisst "Heute"', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  assert(
    __test.weatherDayLabel(WEATHER_FIXTURE, WEATHER_FIXTURE.today.date) === 'common.today',
    'der laufende Tag traegt das Heute-Label',
  );
});

test('Wetter: ohne Bezugstag gibt es kein "Heute"', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const blind = { ...WEATHER_FIXTURE, today: null };
  for (const d of WEATHER_FIXTURE.forecast) {
    assert(
      __test.weatherDayLabel(blind, d.date) !== 'common.today',
      'ohne today.date darf kein Tag geraten werden',
    );
  }
});

test('Wetter-Karte: die Reihe beginnt beschriftet mit morgen, nicht mit "Heute"', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const html = __test.renderWeatherWidget(WEATHER_FIXTURE);
  const labels = [...html.matchAll(/class="weather-forecast__label[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert(labels.length === 3, `drei Vorhersagetage erwartet, bekam ${labels.length}`);
  assert(labels[0] !== 'common.today', 'die Karte beschriftet morgen als "Heute"');
  assert(!html.includes('weather-forecast__label--today'), 'kein Tag der Reihe ist heute');
});

test('Wetter-Wand: dieselbe Regel, nicht nur auf der Karte', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const html = __test.renderWallWeather(WEATHER_FIXTURE);
  const labels = [...html.matchAll(/class="wall-weather__day-label">([^<]*)</g)].map((m) => m[1]);
  assert(labels.length === 3, `drei Vorhersagetage erwartet, bekam ${labels.length}`);
  assert(labels[0] !== 'common.today', 'die Wand beschriftet morgen als "Heute"');
});

/* Hoch und Tief des laufenden Tages: die Karte trug fuer jeden Folgetag eine
 * Spanne, fuer heute aber nur den Momentanwert - genau die Luecke aus #851. */
test('Wetter: der Hauptblock traegt Hoch und Tief des laufenden Tages', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const html = __test.renderWeatherWidget(WEATHER_FIXTURE);
  assert(html.includes('weather-widget__range-high'), 'Hoechstwert fehlt im Hauptblock');
  assert(/weather-widget__range-high"[^>]*>29°/.test(html), 'falscher Hoechstwert');
  assert(/weather-widget__range-low"[^>]*>22°/.test(html), 'falscher Tiefstwert');
  assert(html.includes('dashboard.weatherHighLow'), 'die Zahlenpaarung braucht eine Vorlesehilfe');
  assert(/class="weather-widget__range" role="img"/.test(html),
    'die Vorlesehilfe braucht eine Rolle - auf einem rollenlosen span mit aria-hidden-Kindern haengt sie an nichts');
});

test('Wetter: ohne Tageswerte bleibt die Hoch/Tief-Zeile weg statt leer zu stehen', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const ohne = { ...WEATHER_FIXTURE, today: { date: '2026-08-24', temp_min: null, temp_max: null } };
  assert(
    !__test.renderWeatherWidget(ohne).includes('weather-widget__range'),
    'ohne Zahlen darf die Zeile nicht erscheinen',
  );
  assert(
    !__test.renderWeatherWidget({ ...WEATHER_FIXTURE, today: null }).includes('weather-widget__range'),
    'ohne today darf die Zeile nicht erscheinen',
  );
});

test('Dashboard serialisiert linked occurrences ohne rohe Persistenzfelder', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-occurrence-review', 'Occurrence Reviewer', 'x', '#007AFF', 'member')
  `).run().lastInsertRowid;
  const slot = addLocalDays(today, 1);
  const moved = addLocalDays(today, 2);
  const masterId = routeDb.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, created_by, visibility)
    VALUES ('Dashboard review master', ?, ?, 'FREQ=DAILY;COUNT=3', ?, 'all')
  `).run(`${slot}T09:00:00`, `${slot}T10:00:00`, owner).lastInsertRowid;
  const childId = routeDb.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, created_by, visibility,
       recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES ('Dashboard review child', ?, ?, ?, 'all', ?, ?,
            '["title","start_datetime","end_datetime","assignments"]')
  `).run(`${moved}T11:00:00`, `${moved}T12:00:00`, owner, masterId, slot).lastInsertRowid;
  routeDb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(childId, owner);
  routeDb.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(masterId, slot);

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = owner;
    req.session = { userId: owner, role: 'member' };
    next();
  });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/?events_scope=mine`)).json();
    const child = body.upcomingEvents.find((event) => Number(event.id) === Number(childId));
    nodeAssert.ok(child, 'linked occurrence musí být v dashboard odpovědi');
    nodeAssert.equal(child.series_id, Number(masterId));
    nodeAssert.equal(child.recurrence_id, slot);
    nodeAssert.equal(child.is_occurrence_override, true);
    nodeAssert.equal(child.can_override_occurrence, true);
    for (const key of ['recurrence_parent_id', 'recurrence_identity', 'overridden_fields']) {
      nodeAssert.equal(Object.hasOwn(child, key), false, `${key} nesmí uniknout z API`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare('DELETE FROM users WHERE id = ?').run(owner);
  }
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
test('das Familienmitglieder-Widget kennt die eigene Schicht statt "Heute frei" zu behaupten (S-18)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const users = [{ id: 1, display_name: 'Anna', avatar_color: '#6C3AED' }];
  // Ohne data.schedule (Schedule-Kachel nicht sichtbar): unveraendertes Verhalten.
  const withoutSchedule = __test.renderFamilyWidget(users, {});
  nodeAssert.match(withoutSchedule, /todayFree/, 'ohne geladene Schichtplan-Daten bleibt die alte "Heute frei"-Zeile');
  // Mit einer echten Schicht heute: die Zeile nennt die Schicht, nicht "frei".
  const withShift = __test.renderFamilyWidget(users, {
    schedule: { entries: [{ user_id: 1, shift_type: { short_code: 'E', name: 'Early shift' } }] },
  });
  nodeAssert.match(withShift, /E · Early shift/, 'die eigene Schicht ersetzt die "frei"-Behauptung');
  nodeAssert.ok(!/todayFree/.test(withShift), 'kein Widerspruch zur Schedule-Kachel mehr');
  // Ein freier Tag (Schedule geladen, aber kein Eintrag fuer diese Person) sagt weiterhin "frei".
  const stillFree = __test.renderFamilyWidget(users, { schedule: { entries: [] } });
  nodeAssert.match(stillFree, /todayFree/, 'ein wirklich freier Tag darf weiterhin "Heute frei" sagen');
});

await Promise.all(pendingTests);

console.log(`\n[Dashboard-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
