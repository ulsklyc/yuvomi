/**
 * Modul: Haushaltszone (#829)
 * Zweck: Die eine Zone, in der dieser Haushalt lebt, und alles, was daran haengt.
 *
 *        Bis v2.27.0 gab es fuenf Antworten auf die Frage "welche Uhr gilt hier":
 *        die Zone des Browsers (Anzeige), `TZ` ueber `serverTimeZone()` (Feed,
 *        VTODO, Google-Outbound), UTC ueber `toISOString().slice(0,10)`
 *        (Uebersicht, Scheduler, Budget), die Lokalzeit des Containers ueber die
 *        JS-Getter, und ein fest verdrahtetes 'Europe/Berlin' im Outlook-Push.
 *        Serverseitig sind daraus jetzt EINE geworden: `householdTimeZone()`.
 *
 *        Deckt ab:
 *          - die Kette Einstellung -> TZ -> Systemzone -> UTC, jede Stufe einzeln
 *          - eine ungueltige oder unbekannte Zone faellt zurueck statt zu werfen
 *          - `todayKey` liefert den Kalendertag DIESER Zone, nicht den UTC-Tag
 *            (Gegenprobe: mit UTC waere die Zusicherung falsch)
 *          - `storedToInstantMs` liest die zwei Speicherformen, die in
 *            `calendar_events.start_datetime` nebeneinander liegen
 *          - der Guard: kein Server-Modul ausser timezone.js ruft direkt
 *            `serverTimeZone()`, und keines leitet "heute" aus `toISOString()` ab
 *
 *        Die Zeitzone wird explizit gesetzt. In der UTC-CI faellt kein
 *        Kalendertag um, ein Test ohne Vorgabe waere gruen und blind - dieselbe
 *        Falle wie bei test-calendar-timezone-window.js (#824).
 * Ausfuehren: node --experimental-sqlite --test test/test-household-timezone.js
 */
process.env.TZ = 'America/Toronto';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  householdTimeZone, isValidTimeZone, serverTimeZone, shiftDateKey,
  storedToInstantMs, todayKey,
} = await import('../server/utils/timezone.js');

const dbmod = await import('../server/db.js');
const db = dbmod.get();

const setZone = (value) => {
  if (value === null) db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  else db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
};

// --------------------------------------------------------
// Die Kette
// --------------------------------------------------------

test('householdTimeZone: die Einstellung schlaegt TZ', () => {
  setZone('Asia/Tokyo');
  assert.equal(householdTimeZone(db), 'Asia/Tokyo');
  // Gegenprobe: ohne die Einstellung gilt wieder TZ. Ohne diese Haelfte koennte
  // der Test auch dann gruen sein, wenn die Funktion IMMER Asia/Tokyo lieferte.
  setZone(null);
  assert.equal(householdTimeZone(db), 'America/Toronto');
});

test('householdTimeZone: ohne Verbindung bleibt es bei der Umgebung', () => {
  setZone('Asia/Tokyo');
  // `null` ist der dokumentierte Fall "keine Verbindung in Reichweite" - er darf
  // nicht werfen und muss beim Rueckfall landen, nicht bei der Einstellung.
  assert.equal(householdTimeZone(null), 'America/Toronto');
  assert.equal(householdTimeZone(undefined), 'America/Toronto');
  setZone(null);
});

test('householdTimeZone: eine unbekannte Zone in der DB faellt zurueck, statt zu werfen', () => {
  // Kann entstehen, wenn eine Zone in einer neueren ICU-Version gewaehlt und die
  // Datenbank spaeter auf einem aelteren Node gelesen wird. Ein Wurf hier legte
  // die Uebersicht lahm; der Rueckfall kostet nur die Genauigkeit.
  setZone('Mars/Olympus_Mons');
  assert.equal(householdTimeZone(db), 'America/Toronto');
  setZone(null);
});

test('serverTimeZone: ein ungueltiges TZ faellt auf die Systemzone', () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = 'Nicht/EineZone';
    const zone = serverTimeZone();
    assert.ok(isValidTimeZone(zone), `Rueckfall muss eine gueltige Zone sein, war "${zone}"`);
  } finally { process.env.TZ = prev; }
});

test('isValidTimeZone: kennt Aliase, weist Unsinn ab', () => {
  assert.ok(isValidTimeZone('Europe/Berlin'));
  assert.ok(isValidTimeZone('UTC'));
  // Alias statt kanonischem Namen: `Intl.supportedValuesOf` fuehrt ihn NICHT,
  // ICU akzeptiert ihn. Genau deshalb prueft die Route nicht gegen die Liste.
  assert.ok(isValidTimeZone('Europe/Kiev'));
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(42), false);
});

// --------------------------------------------------------
// todayKey
// --------------------------------------------------------

test('todayKey: der Kalendertag der Haushaltszone, nicht der UTC-Tag', () => {
  // 22:00 in Toronto am 21.08. ist bereits der 22.08. in UTC. Genau diese
  // Stunden liessen die Uebersicht die Abendtermine des laufenden Tages
  // verlieren und den Scheduler eine wiederkehrende Ausgabe zu frueh buchen.
  const now = new Date('2026-08-22T02:00:00Z');
  setZone('America/Toronto');
  assert.equal(todayKey(db, now), '2026-08-21');
  // Die Gegenprobe, ohne die die Zusicherung nichts aussagt:
  assert.equal(now.toISOString().slice(0, 10), '2026-08-22');

  // Oestlich von UTC kippt es in die andere Richtung.
  setZone('Asia/Tokyo');
  assert.equal(todayKey(db, new Date('2026-08-21T20:00:00Z')), '2026-08-22');
  setZone(null);
});

test('shiftDateKey: verschiebt Kalendertage, nicht 24-Stunden-Bloecke', () => {
  assert.equal(shiftDateKey('2026-08-21', 1), '2026-08-22');
  assert.equal(shiftDateKey('2026-08-21', -1), '2026-08-20');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  // Ueber die Zeitumstellung: der 29.03.2026 hat in Europa 23 Stunden. Waere
  // hier lokale Arithmetik am Werk, laege das Ergebnis auf demselben Tag.
  assert.equal(shiftDateKey('2026-03-29', 1), '2026-03-30');
  assert.equal(shiftDateKey('kaputt', 1), 'kaputt');
});

// --------------------------------------------------------
// Die zwei Speicherformen in einer Spalte
// --------------------------------------------------------

test('storedToInstantMs: zonenlose Wanduhrzeit wird in der Haushaltszone gelesen', () => {
  // 19:00 in Toronto ist 23:00Z - so hat es der Nutzer gemeint, als er "19:00"
  // eintippte, und nur so ist es mit einem synchronisierten Termin vergleichbar.
  assert.equal(
    storedToInstantMs('2026-08-21T19:00', 'America/Toronto'),
    Date.parse('2026-08-21T23:00:00Z'),
  );
  assert.equal(
    storedToInstantMs('2026-08-21T19:00:00', 'America/Toronto'),
    Date.parse('2026-08-21T23:00:00Z'),
  );
});

test('storedToInstantMs: ein Wert mit eigener Zone bleibt sein Zeitpunkt', () => {
  const expected = Date.parse('2026-08-21T23:00:00Z');
  assert.equal(storedToInstantMs('2026-08-21T19:00:00-04:00', 'Asia/Tokyo'), expected);
  assert.equal(storedToInstantMs('2026-08-21T23:00:00Z', 'Asia/Tokyo'), expected);
});

test('storedToInstantMs: ein reines Datum beginnt um Mitternacht der Zone', () => {
  assert.equal(
    storedToInstantMs('2026-08-21', 'America/Toronto'),
    Date.parse('2026-08-21T04:00:00Z'),
  );
  assert.equal(storedToInstantMs('', 'UTC'), null);
  assert.equal(storedToInstantMs(null, 'UTC'), null);
});

test('storedToInstantMs: der Stringvergleich, den er ersetzt, war falsch', () => {
  // Die eigentliche Aussage dieses Fixes. Lexikografisch liegt der lokale
  // 21:00-Termin VOR dem UTC-Jetzt, obwohl er noch eine Stunde vor uns liegt -
  // so verschwanden die Abendtermine aus dem Uebersichts-Widget.
  const local = '2026-08-21T21:00';
  const nowIso = '2026-08-22T00:00:00.000Z';
  assert.ok(local < nowIso, 'Voraussetzung: der Stringvergleich sortiert ihn nach hinten');
  assert.ok(
    storedToInstantMs(local, 'America/Toronto') > Date.parse(nowIso),
    'Der Zeitpunktvergleich stellt ihn richtig',
  );
});

// --------------------------------------------------------
// Der Fehler, der das ausgeloest hat: Abendtermine im Uebersichts-Widget
// --------------------------------------------------------

const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');

db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
            VALUES ('admin','Admin','x','admin')`).run();

test('getUpcomingEvents: der Abendtermin von heute bleibt drin, wenn UTC schon morgen ist', () => {
  setZone('America/Toronto');
  // 20:30 Ortszeit am 21.08. = 00:30Z am 22.08. Das Widget lief zu diesem
  // Zeitpunkt gegen den UTC-Tag und lieferte damit schon den 22. - der Termin um
  // 21:00, eine halbe Stunde spaeter, fiel heraus. Beide Speicherformen sind
  // vertreten, weil der Stringvergleich genau zwischen ihnen brach.
  const rows = [
    ['Lokal 21:00', '2026-08-21T21:00', 0],              // zonenlose Wanduhrzeit
    ['Google 22:00', '2026-08-21T22:00:00-04:00', 0],    // Instant mit Offset
    ['Ganztags heute', '2026-08-21', 1],                 // reines Datum
  ];
  for (const [title, start, allDay] of rows) {
    db.prepare(`INSERT INTO calendar_events (title, start_datetime, all_day, created_by)
                VALUES (?, ?, ?, 1)`).run(title, start, allDay);
  }

  // `fromToday` ist der Modus des Uebersichts-Widgets: ab Tagesbeginn, damit
  // heutige Termine den ganzen Tag sichtbar bleiben. Der Zeitpunkt ist fest -
  // die Tagesgrenze ist genau das, was hier schiefgeht, und mit `new Date()`
  // liefe der Test nur an einem einzigen Abend im Jahr durch die kritische Stelle.
  const now = new Date('2026-08-22T00:30:00Z'); // 20:30 Ortszeit in Toronto
  const titles = getUpcomingEvents(db, { userId: 1, limit: 10, fromToday: true, now })
    .map((e) => e.title);

  assert.deepEqual(titles.sort(), ['Ganztags heute', 'Google 22:00', 'Lokal 21:00'],
    'alle drei Formen muessen im Fenster bleiben');

  // Die Gegenprobe: mit dem UTC-Tag als Grenze verschwinden genau diese drei.
  // Ohne sie waere die Zusicherung oben auch dann gruen, wenn `fromToday` gar
  // nichts filterte.
  assert.equal(new Date('2026-08-22T00:30:00Z').toISOString().slice(0, 10), '2026-08-22');
  assert.ok(
    ['2026-08-21T21:00', '2026-08-21T22:00:00-04:00', '2026-08-21'].every(
      (start) => start < '2026-08-22T00:00:00'
    ),
    'alle drei lagen unter der UTC-Tagesgrenze und fielen deshalb heraus',
  );

  db.prepare("DELETE FROM calendar_events").run();
  setZone(null);
});

// --------------------------------------------------------
// Guard: eine Zone, nicht fuenf
// --------------------------------------------------------

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER_DIR = path.join(ROOT, 'server');

function serverFiles(dir = SERVER_DIR) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...serverFiles(full));
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file);

test('Guard: nur timezone.js ruft serverTimeZone() direkt', () => {
  // `serverTimeZone()` ist der Rueckfall, nicht die Antwort - es liest `TZ` und
  // sieht die Einstellung nicht. Ein Aufruf woanders hiesse: diese eine Stelle
  // ignoriert, was der Haushalt eingestellt hat, und zwar lautlos.
  const offenders = serverFiles()
    .filter((file) => !file.endsWith(path.join('utils', 'timezone.js')))
    .filter((file) => /\bserverTimeZone\s*\(/.test(readFileSync(file, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, [],
    `Diese Dateien muessen householdTimeZone(<db>) nehmen: ${offenders.join(', ')}`);
});

test('Guard: kein Server-Modul leitet "heute" aus toISOString() ab', () => {
  // `toISOString()` ist IMMER UTC - `TZ` aendert daran nichts, was die Falle so
  // zaeh macht. Erlaubt bleibt Arithmetik auf einem bereits gebildeten Key
  // (`new Date(Date.UTC(...))`); verboten ist der Sprung von JETZT auf einen
  // Kalendertag, denn der ist westlich von UTC abends und oestlich davon
  // morgens der falsche. Die Antwort heisst todayKey(<db>).
  const NOW_TO_DAY = /new Date\(\s*\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;
  const offenders = serverFiles()
    .filter((file) => !file.endsWith(path.join('utils', 'timezone.js')))
    .filter((file) => NOW_TO_DAY.test(readFileSync(file, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, [],
    `Diese Dateien bilden "heute" aus dem UTC-Tag: ${offenders.join(', ')}`);
});

test('Guard: der null-Rueckfall steht nur als Default-Parameter', () => {
  // `householdTimeZone(null)` / `todayKey(null)` ueberspringen die Einstellung
  // und landen bei `TZ`. Als DEFAULT ist das richtig - eine exportierte reine
  // Funktion wie `dueField()` soll ohne Verbindung aufrufbar bleiben, und der
  // Produktivpfad reicht die echte Zone durch. In einem Funktionsrumpf ist es
  // dagegen genau der Fehler, den dieses Vorhaben beseitigt hat: eine Stelle,
  // die lautlos ignoriert, was der Haushalt eingestellt hat. Der Unterschied
  // ist sichtbar: ein Default steht in einer Parameterliste, ein Rumpf-Aufruf
  // in einer Anweisung.
  //
  // Geprueft wird "die Zeile deklariert eine Funktion" und nicht "hinter dem
  // Wert steht ein =". Das war der erste Versuch, und er war blind: in
  // `const tz = householdTimeZone(null);` steht auch ein '='. Die Grenze dieser
  // Fassung ist eine Signatur ueber mehrere Zeilen - dann steht der Default
  // nicht neben dem `function`. Alle neun heutigen Vorkommen stehen einzeilig;
  // wer das aendert, bekommt hier einen Fehlalarm und keinen blinden Fleck,
  // und das ist die richtige Richtung fuer einen Irrtum.
  //
  // Das `[,)]` am Ende ist nachgetragen: die erste Fassung endete auf `\)` und
  // verlangte damit `null` DIREKT vor der Klammer. Sie fing `todayKey(null)`
  // und liess `todayKey(null, from)` durch - dieselbe uebersprungene
  // Einstellung, nur mit einem zweiten Argument dahinter. Gemessen am
  // 2026-09-09: `todayKey(database, from)` -> `todayKey(null, from)` an
  // server/services/birthdays.js:318 liess diese Suite gruen, waehrend die
  // einargumentige Schwester eine Zeile darunter sie rot machte. Betroffen ist
  // nur `todayKey`: `householdTimeZone` nimmt genau ein Argument, die
  // zweiargumentige Schreibweise gibt es dort nicht. In server/ stehen acht
  // solche Aufrufstellen (schedule-reminders, cycle-reminders, cycle-ics,
  // calendar-events, pantry-reminders zweimal, birthdays zweimal) - gezaehlt,
  // nicht geschaetzt.
  const CALL = /(?:householdTimeZone|todayKey)\s*\(\s*null\s*[,)]/;
  const DECLARES_FN = /\bfunction\b|=>/;
  const offenders = [];
  for (const file of serverFiles()) {
    if (file.endsWith(path.join('utils', 'timezone.js'))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (CALL.test(line) && !DECLARES_FN.test(line)) offenders.push(`${rel(file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    `Diese Stellen umgehen die Einstellung: ${offenders.join(', ')}`);

  // Gegenprobe, sonst waere die Regel oben nur eine Behauptung ueber ein Regex.
  const bad = 'const tz = householdTimeZone(null);';
  assert.ok(CALL.test(bad) && !DECLARES_FN.test(bad), 'ein Rumpf-Aufruf muss auffallen');
  const good = 'function dueField(date, time, tz = householdTimeZone(null)) {';
  assert.ok(CALL.test(good) && DECLARES_FN.test(good), 'ein Default darf durchgehen');

  // Und die zweiargumentige Form, ohne die das `[,)]` oben nur eine Behauptung
  // waere: die beiden Zeilen darueber matchen auch die alte, auf `\)` endende
  // Fassung, die Schaerfung selbst bliebe also ungeprueft. Gemessen: mit dieser
  // Zeile faellt das Zurueckdrehen auf `\)` auf, ohne sie nicht.
  const badTwoArg = 'const key = todayKey(null, from);';
  assert.ok(CALL.test(badTwoArg) && !DECLARES_FN.test(badTwoArg),
    'auch zweiargumentig muss ein Rumpf-Aufruf auffallen');
});

test('Guard: der Outlook-Push traegt keine fest verdrahtete Zone mehr', () => {
  // Der Festwert war als "Paritaet mit dem Google-Outbound" begruendet, obwohl
  // Google schon damals die Zone des Zielkalenders nahm. Als Literal im Code
  // laesst er sich von keiner Einstellung erreichen.
  const source = readFileSync(path.join(SERVER_DIR, 'services', 'outlook-calendar.js'), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/'Europe\/Berlin'|"Europe\/Berlin"/.test(code), false,
    'outlook-calendar.js enthaelt wieder eine feste Zone');
});

test('Guard: der Guard erkennt den Schaden, gegen den er gebaut ist', () => {
  // Ohne diese Gegenprobe koennte ein kaputtes Regex beide Guards oben still
  // gruen halten - der wiederkehrende Fehler aus reference-guard-blindness.
  const NOW_TO_DAY = /new Date\(\s*\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;
  assert.ok(NOW_TO_DAY.test('const today = new Date().toISOString().slice(0, 10);'));
  assert.ok(NOW_TO_DAY.test('x = new Date().toISOString().slice(0,10)'));
  // Erlaubt: Arithmetik auf einem Datums-Key, kein Sprung von JETZT auf den Tag.
  assert.equal(NOW_TO_DAY.test('new Date(ms + days * 86400000).toISOString().slice(0, 10)'), false);
  assert.ok(/\bserverTimeZone\s*\(/.test('const tz = serverTimeZone();'));
  assert.equal(/\bserverTimeZone\s*\(/.test('import { householdTimeZone } from "x";'), false);
});
