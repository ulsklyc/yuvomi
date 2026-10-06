/**
 * Test: Welche CalDAV-Objekt-URLs erreichen den Parser (#883)
 *
 * Ein Termin auf einem Stalwart-Kalender kam nie an - kein Fehler, keine
 * Warnung, der Sync meldete Erfolg. Die Meldung vermutete den iCal-Parser
 * (`DURATION` statt `DTEND`, `TZID` ohne `VTIMEZONE`); der Parser kann beides,
 * und dieser Test hält das fest, damit die Fehlspur nicht wiederkehrt.
 *
 * Die Ursache lag eine Schicht davor: tsdav filtert die hrefs einer
 * `calendar-query`-Antwort per Default auf `.ics` im Pfad. Die Endung ist reine
 * Konvention - RFC 4791 schreibt keinen Namen für die Objekt-Ressource vor.
 * Stalwart vergibt für alles, was über JMAP angelegt wurde, einen eigenen Namen
 * ("NZtPkIOMoK"), während per CalDAV-PUT abgelegte Objekte `<uid>.ics` behalten.
 * Im selben Kalender fiel deshalb ein Teil der Termine still aus dem Sync -
 * und weil sie nie abgerufen wurden, konnte auch kein Logeintrag sie erwähnen.
 *
 * Geprüft werden deshalb drei Ebenen: der Filter selbst, dass er überhaupt an
 * `fetchCalendarObjects` ankommt (ohne das wäre er wirkungslos), und ein
 * Regel-Guard darüber, dass kein zweiter CalDAV-Client an ihm vorbei entsteht.
 * Dazu die Sichtbarkeit: was der Parser verwirft, muss er benennen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutBlockComments } from './source-text.js';
import { calendarObjectUrlFilter, withCalendarObjectUrlFilter } from '../server/utils/caldav-client.js';
import { parseICS } from '../server/services/ics-parser.js';

const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));
const OWNER = 'utils/caldav-client.js';

function jsFilesUnder(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...jsFilesUnder(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}


const COLLECTION = 'https://mail.example.org/dav/cal/haushalt/default/';

// --------------------------------------------------------
// 1. Der Filter
// --------------------------------------------------------

test('Objekt ohne .ics-Endung wird durchgelassen (der Fall aus #883)', () => {
  const keep = calendarObjectUrlFilter(COLLECTION);
  assert.ok(keep('https://mail.example.org/dav/cal/haushalt/default/NZtPkIOMoK'), 'JMAP-Objektname abgewiesen');
});

test('Objekt mit .ics-Endung wird weiterhin durchgelassen', () => {
  const keep = calendarObjectUrlFilter(COLLECTION);
  assert.ok(keep('https://mail.example.org/dav/cal/haushalt/default/9f3a-1.ics'), '.ics-Objekt abgewiesen');
});

test('Die Collection selbst wird abgewiesen - mit und ohne Schrägstrich', () => {
  const keep = calendarObjectUrlFilter(COLLECTION);
  assert.ok(!keep('https://mail.example.org/dav/cal/haushalt/default/'), 'Collection mit Schrägstrich durchgelassen');
  assert.ok(!keep('https://mail.example.org/dav/cal/haushalt/default'),  'Collection ohne Schrägstrich durchgelassen');
});

test('Collection ohne Schrägstrich angegeben: beide Schreibweisen fallen weg', () => {
  const keep = calendarObjectUrlFilter('https://mail.example.org/dav/cal/haushalt/default');
  assert.ok(!keep('https://mail.example.org/dav/cal/haushalt/default/'), 'mit Schrägstrich durchgelassen');
  assert.ok(!keep('https://mail.example.org/dav/cal/haushalt/default'),  'ohne Schrägstrich durchgelassen');
  assert.ok(keep('https://mail.example.org/dav/cal/haushalt/default/NZtPkIOMoK'), 'Objekt abgewiesen');
});

test('Unter-Collections und leere hrefs fallen weg', () => {
  const keep = calendarObjectUrlFilter(COLLECTION);
  assert.ok(!keep('https://mail.example.org/dav/cal/haushalt/default/archiv/'), 'Unter-Collection durchgelassen');
  assert.ok(!keep(''),        'leerer href durchgelassen');
  assert.ok(!keep(null),      'null durchgelassen');
  assert.ok(!keep(undefined), 'undefined durchgelassen');
});

test('Relativer href wird gegen dieselbe Regel gemessen wie ein absoluter', () => {
  const keep = calendarObjectUrlFilter(COLLECTION);
  assert.ok(keep('/dav/cal/haushalt/default/NZtPkIOMoK'), 'relatives Objekt abgewiesen');
  assert.ok(!keep('/dav/cal/haushalt/default/'),          'relative Collection durchgelassen');
});

// --------------------------------------------------------
// 2. Kommt der Filter überhaupt an?
//    Ein Filter, den niemand übergibt, ist kein Fix - tsdavs Default greift
//    genau dann, wenn `urlFilter` fehlt.
// --------------------------------------------------------

function fakeClient() {
  const calls = [];
  return {
    calls,
    fetchCalendars:       () => [],
    fetchCalendarObjects: (params) => { calls.push(params); return []; },
  };
}

test('withCalendarObjectUrlFilter hängt einen urlFilter an', async () => {
  const raw = fakeClient();
  const client = withCalendarObjectUrlFilter(raw);
  await client.fetchCalendarObjects({ calendar: { url: COLLECTION } });
  const [params] = raw.calls;
  assert.ok(typeof params.urlFilter === 'function', 'kein urlFilter übergeben - tsdavs .ics-Default greift');
  assert.ok(params.urlFilter(`${COLLECTION}NZtPkIOMoK`), 'übergebener Filter weist das Objekt ab');
});

test('Ein explizit übergebener urlFilter gewinnt', async () => {
  const raw = fakeClient();
  const client = withCalendarObjectUrlFilter(raw);
  const own = () => false;
  await client.fetchCalendarObjects({ calendar: { url: COLLECTION }, urlFilter: own });
  assert.ok(raw.calls[0].urlFilter === own, 'eigener Filter wurde überschrieben');
});

test('Auch der Outbound-Pfad mit objectUrls bekommt den Filter', async () => {
  // tsdav filtert `objectUrls` mit derselben Funktion wie die hrefs aus der
  // Abfrage: ohne Fix verschwand hier dasselbe Objekt ein zweites Mal.
  const raw = fakeClient();
  const client = withCalendarObjectUrlFilter(raw);
  await client.fetchCalendarObjects({
    calendar:   { url: COLLECTION },
    objectUrls: [`${COLLECTION}NZtPkIOMoK`],
  });
  assert.ok(raw.calls[0].urlFilter(`${COLLECTION}NZtPkIOMoK`), 'objectUrl würde weggefiltert');
});

test('Die übrigen Client-Methoden bleiben erreichbar', () => {
  const client = withCalendarObjectUrlFilter(fakeClient());
  assert.ok(typeof client.fetchCalendars === 'function', 'fetchCalendars verloren');
});

test('Auch Methoden am Prototyp überleben den Wrapper', () => {
  // Der Fake oben legt seine Methoden als EIGENE Eigenschaften an - genau wie
  // `createDAVClient` heute, das ein Objektliteral zurückgibt. Damit könnte ein
  // Wrapper per Spread durchkommen und trotzdem falsch sein: wechselt tsdav auf
  // die Klassenform, haengen die Methoden am Prototyp und ein Spread liesse sie
  // fallen - zur Laufzeit, beim ersten `fetchCalendars`. Dieser Fall wird
  // deshalb eigens gestellt.
  class DavLike {
    fetchCalendars() { return 'aus dem Prototyp'; }
    deleteCalendarObject() { return 'auch aus dem Prototyp'; }
    fetchCalendarObjects() { return []; }
  }
  const client = withCalendarObjectUrlFilter(new DavLike());
  assert.equal(client.fetchCalendars(), 'aus dem Prototyp', 'fetchCalendars vom Prototyp verloren');
  assert.equal(client.deleteCalendarObject(), 'auch aus dem Prototyp', 'deleteCalendarObject verloren');
});

test('Ein Bezeichner im Query darf auf einen Schrägstrich enden', () => {
  // Die FORM entscheidet der Pfad, nicht der Query. Zusammengezogen beantwortete
  // die Collection-Frage das Ende des Query - und ein Objekt, dessen Bezeichner
  // so endet, fiele still heraus.
  const keep = calendarObjectUrlFilter('https://mail.example.org/dav/calendar?collection=home');
  assert.ok(keep('https://mail.example.org/dav/calendar?object=folder/item/'),
    'Objekt mit Schrägstrich im Query-Bezeichner abgewiesen');
  assert.ok(keep('https://mail.example.org/dav/calendar/?object=x'),
    'Objekt hinter einem Collection-Pfad abgewiesen');
  assert.ok(!keep('https://mail.example.org/dav/cal/x/default/'),
    'echte Collection ohne Query durchgelassen');
});

test('Objekt und Collection werden über den vollen Bezeichner getrennt, nicht nur den Pfad', () => {
  // tsdav adressiert Objekte selbst als `pathname + search`; ein Server darf
  // Collection und Mitglied ueber den Query unterscheiden. Auf den blossen Pfad
  // reduziert saehen beide gleich aus, und das Objekt fiele heraus.
  const keep = calendarObjectUrlFilter('https://mail.example.org/dav/calendar?collection=home');
  assert.ok(keep('https://mail.example.org/dav/calendar?object=NZtPkIOMoK'), 'Objekt am Query abgewiesen');
  assert.ok(!keep('https://mail.example.org/dav/calendar?collection=home'), 'Collection durchgelassen');
});

test('createCalDAVClient reicht seinen Client durch den Wrapper', () => {
  // Der Wrapper ist nur so viel wert wie seine Anwendung: nimmt ihn jemand aus
  // der Factory, greift tsdavs `.ics`-Default wieder, und jeder Test oben bliebe
  // grün. Geprüft wird die QUELLE, weil `createDAVClient` beim Erzeugen schon
  // die Account-Discovery fährt - netzfrei ist das nicht nachzustellen.
  const src = withoutBlockComments(readFileSync(join(SERVER_DIR, OWNER), 'utf-8'));
  const body = src.slice(src.indexOf('export async function createCalDAVClient'));
  const end  = body.indexOf('\n}');
  assert.ok(end > 0, 'createCalDAVClient nicht auffindbar');
  assert.ok(
    /withCalendarObjectUrlFilter\(/.test(body.slice(0, end)),
    'createCalDAVClient gibt seinen Client nicht durch withCalendarObjectUrlFilter - tsdavs .ics-Default greift wieder',
  );
});

// --------------------------------------------------------
// 3. Regel-Guard: kein zweiter CalDAV-Client an der Factory vorbei
//    Der Filter sitzt bewusst am Client. Wer sich seinen eigenen baut, umgeht
//    ihn still - und genau still war der Fehler. Als Regel formuliert, nicht
//    als Allowlist: eine neue Datei fällt damit von selbst auf.
// --------------------------------------------------------

test('Nur caldav-client.js erzeugt einen CalDAV-tsdav-Client', () => {
  const offenders = jsFilesUnder(SERVER_DIR)
    .filter((rel) => rel !== OWNER)
    .filter((rel) => /defaultAccountType:\s*'caldav'/.test(readFileSync(join(SERVER_DIR, rel), 'utf-8')));
  assert.ok(
    offenders.length === 0,
    `umgeht den urlFilter aus caldav-client.js: ${offenders.join(', ')} - Client über createCalDAVClient() beziehen`,
  );
});

test('Der Guard misst überhaupt etwas', () => {
  // Ohne diese Gegenprobe bliebe er auch dann grün, wenn die Schreibweise sich
  // ändert und er ins Leere greift.
  const owner = readFileSync(join(SERVER_DIR, OWNER), 'utf-8');
  assert.ok(/defaultAccountType:\s*'caldav'/.test(owner), `${OWNER} trägt das gesuchte Muster nicht mehr`);
  assert.ok(jsFilesUnder(SERVER_DIR).length > 20, 'Dateiliste unplausibel kurz');
});

// --------------------------------------------------------
// 4. Die Fehlspur aus der Meldung: der Parser kann beides
// --------------------------------------------------------

const JMAP_VEVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Berlin:20260924T190000',
  'UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'TRANSP:OPAQUE',
  'DTSTAMP:20260826T131133Z',
  'DURATION:PT2H',
  'SUMMARY:Elternabend',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('DURATION ohne DTEND und TZID ohne VTIMEZONE werden geparst', () => {
  const [ev] = parseICS(JMAP_VEVENT);
  assert.ok(ev, 'Event wurde verworfen');
  assert.ok(ev.dtstart === '2026-09-24T17:00:00Z', `dtstart: ${ev.dtstart}`);
  assert.ok(ev.dtend   === '2026-09-24T19:00:00Z', `dtend aus DURATION: ${ev.dtend}`);
  assert.ok(ev.tzid    === 'Europe/Berlin',        `tzid: ${ev.tzid}`);
});

// --------------------------------------------------------
// 5. Sichtbarkeit: was der Parser verwirft, benennt er
// --------------------------------------------------------

test('onSkip meldet einen VEVENT ohne UID', () => {
  const skipped = [];
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Ohne UID\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.ok(parseICS(ics, { onSkip: (i) => skipped.push(i) }).length === 0, 'sollte übersprungen werden');
  assert.ok(skipped.length === 1, `erwartet 1 Meldung, bekam ${skipped.length}`);
  assert.ok(/UID/i.test(skipped[0].reason), `Grund nennt UID nicht: ${skipped[0].reason}`);
});

test('onSkip meldet einen VEVENT ohne DTSTART mitsamt seiner UID', () => {
  const skipped = [];
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:kaputt@x\r\nSUMMARY:Ohne Start\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.ok(parseICS(ics, { onSkip: (i) => skipped.push(i) }).length === 0, 'sollte übersprungen werden');
  assert.ok(skipped.length === 1, `erwartet 1 Meldung, bekam ${skipped.length}`);
  assert.ok(skipped[0].uid === 'kaputt@x', `UID fehlt in der Meldung: ${skipped[0].uid}`);
  assert.ok(/DTSTART/i.test(skipped[0].reason), `Grund nennt DTSTART nicht: ${skipped[0].reason}`);
});

test('Ein sauberer VEVENT löst keine Meldung aus', () => {
  const skipped = [];
  assert.ok(parseICS(JMAP_VEVENT, { onSkip: (i) => skipped.push(i) }).length === 1, 'sollte geparst werden');
  assert.ok(skipped.length === 0, `unerwartete Meldung: ${JSON.stringify(skipped)}`);
});

test('parseICS bleibt ohne zweites Argument aufrufbar', () => {
  assert.ok(parseICS(JMAP_VEVENT).length === 1, 'Signatur gebrochen');
});
