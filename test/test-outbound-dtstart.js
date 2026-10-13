/**
 * Test: DTSTART fuer ausgehende Kalender (#986)
 * Zweck: Eine Serie "am letzten Tag des Monats", die aus einem Datum in der
 *        Monatsmitte angelegt wurde, darf nach draussen kein unsynchronisiertes
 *        DTSTART tragen - RFC 5545 3.8.5.3 nennt die Wiederholungsmenge dann
 *        ausdruecklich "undefined", und ein fremder Client darf daraus ein
 *        Vorkommen MEHR machen, als Yuvomi zeigt.
 * Ausfuehren: node --experimental-sqlite --test test/test-outbound-dtstart.js
 *
 * Geprueft werden die reine Umformung UND der Feed, weil beides schiefgehen
 * kann: der Helfer koennte richtig rechnen und trotzdem nirgends angewendet
 * sein. Die Gegenrichtung steht mit: eine IMPORTIERTE Serie geht Wort fuer Wort
 * zurueck (#756), und eine BYDAY-Regel bleibt unangetastet (#549).
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

// Das Speicherformat ist ISO mit `T` und ohne Sekunden ('2026-01-15T09:00') -
// an der Datenbank nachgesehen, nicht geraten. Ein Testwert mit Leerzeichen
// ('2026-01-15 09:00:00') laeuft durch `toICSDatetime` zu Unsinn und laesst die
// Pruefung aus dem falschen Grund scheitern.
const {
  outboundStartDatetime, outboundDateRange, outboundEvent, startOrRuleChanged, authoredAfterInbound,
} = await import('../server/services/outbound-dtstart.js');

const MONATSLETZTER = 'FREQ=MONTHLY;BYMONTHDAY=-1';

// --------------------------------------------------------
// Die Umformung selbst
// --------------------------------------------------------

test('eine eigene Monatsletzten-Serie startet nach draussen am Monatsletzten', () => {
  const ev = { start_datetime: '2026-01-15T09:00', recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1 };
  assert.equal(outboundStartDatetime(ev), '2026-01-31T09:00');
});

// WER DEN START VERFASST HAT, SAGT `series_authored` - NICHT `external_source`
// (#1935). Der Test hier fuetterte bis dahin Zeilen mit `external_source:
// 'google'` und erwartete sie unveraendert: er konnte eine hochgeladene eigene
// Serie nicht von einer eingelesenen unterscheiden und nagelte fuer beide
// dasselbe fest - also genau den Fehler. Jetzt stehen die beiden Faelle
// getrennt, je Quelle, und die Quelle entscheidet in keinem von beiden.
const QUELLEN = ['local', 'ics', 'caldav', 'google', 'apple'];

test('eine importierte Serie geht Wort fuer Wort zurueck (#756)', () => {
  // Fremde Kalender duerfen ein unsynchronisiertes DTSTART absichtlich fuehren;
  // beim Round-Trip ist Yuvomi darueber nicht der Schiedsrichter.
  for (const quelle of QUELLEN) {
    const ev = {
      start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00',
      recurrence_rule: MONATSLETZTER, external_source: quelle, series_authored: 0,
    };
    assert.deepEqual(outboundDateRange(ev),
      { start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00' }, `Quelle ${quelle}`);
  }
});

test('eine hier verfasste Serie wird ausgerichtet, gleich wo sie gespiegelt liegt (#1935)', () => {
  // Das Buchen des Uploads schreibt `external_source` um. Die Serie bleibt
  // trotzdem die eigene: derselbe Start wie beim ersten Upload, bei jedem Push.
  for (const quelle of QUELLEN) {
    const ev = {
      start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00',
      recurrence_rule: MONATSLETZTER, external_source: quelle, series_authored: 1,
    };
    assert.deepEqual(outboundDateRange(ev),
      { start_datetime: '2026-01-31T09:00', end_datetime: '2026-01-31T10:00' }, `Quelle ${quelle}`);
  }
});

test('ohne die Marke wird nichts ausgerichtet: unbekannt heisst wie eingelesen', () => {
  // Ein Objekt ohne die Spalte (von Hand gebaut, Schema von vor Migration 246)
  // ist nicht "eigen", auch nicht mit `external_source: 'local'`.
  for (const marke of [undefined, null, 0, '0']) {
    const ev = { start_datetime: '2026-01-15T09:00', recurrence_rule: MONATSLETZTER, external_source: 'local' };
    if (marke !== undefined) ev.series_authored = marke;
    assert.equal(outboundStartDatetime(ev), '2026-01-15T09:00', `Marke ${String(marke)}`);
  }
});

test('eine BYDAY-Regel bleibt unangetastet (#549)', () => {
  // Apple serialisiert "jeden Werktag" als Serie, deren Start auf ein Wochenende
  // fallen darf; diese Entscheidung ist aelter und gilt weiter.
  const ev = { start_datetime: '2026-01-17T09:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', external_source: 'local', series_authored: 1 };
  assert.equal(outboundStartDatetime(ev), '2026-01-17T09:00');
});

test('ohne Regel und bei schon passendem Start aendert sich nichts', () => {
  assert.equal(outboundStartDatetime({ start_datetime: '2026-01-15T09:00', external_source: 'local', series_authored: 1 }), '2026-01-15T09:00');
  const passend = { start_datetime: '2026-01-31T09:00', recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1 };
  assert.equal(outboundStartDatetime(passend), '2026-01-31T09:00');
});

test('das Ende wandert mit und behaelt die Dauer', () => {
  // end_datetime ist ein absoluter Zeitstempel, kein Abstand: bliebe es stehen,
  // endete der Termin drueben vor seinem Beginn.
  const kurz = outboundDateRange({
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:30',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  });
  assert.deepEqual(kurz, { start_datetime: '2026-01-31T09:00', end_datetime: '2026-01-31T10:30' });

  const mehrtaegig = outboundDateRange({
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-17T10:30',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  });
  assert.equal(mehrtaegig.end_datetime, '2026-02-02T10:30', 'zwei Tage Spanne bleiben zwei Tage');

  const ohneEnde = outboundDateRange({
    start_datetime: '2026-01-15T09:00', end_datetime: null,
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  });
  assert.equal(ohneEnde.end_datetime, null);
});

test('das gespeicherte Zeitformat bleibt, wie es war', () => {
  // Naiv, `Z` und Offset stehen nebeneinander in der Spalte; die Umformung
  // tauscht nur den Datumsteil und darf keines davon umschreiben.
  const z = outboundDateRange({
    start_datetime: '2026-01-15T09:00:00Z', end_datetime: '2026-01-15T10:30:00Z',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  });
  assert.deepEqual(z, { start_datetime: '2026-01-31T09:00:00Z', end_datetime: '2026-01-31T10:30:00Z' });
});

test('outboundEvent laesst alle uebrigen Felder unberuehrt', () => {
  const ev = {
    id: 7, title: 'Miete', description: 'x', location: 'y', all_day: 0,
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1, tzid: null,
  };
  const out = outboundEvent(ev);
  assert.equal(out.start_datetime, '2026-01-31T09:00');
  assert.equal(out.title, 'Miete');
  assert.equal(out.id, 7);
  assert.equal(ev.start_datetime, '2026-01-15T09:00', 'das Original bleibt unveraendert');
});

// --------------------------------------------------------
// Und wirklich angewendet: der ausgehende ICS-Pfad
// --------------------------------------------------------
//
// `icsFieldsForEvent` ist die Stelle, die CalDAV, Apple und der CalDAV-Sync
// gemeinsam benutzen (ueber `eventDateTimeFields`). Sie ist rein und braucht
// keine Datenbank - genau deshalb wird hier geprueft und nicht am Feed: ein
// Helfer, der richtig rechnet und nirgends angewendet ist, bestuende sonst.

test('der ausgehende CalDAV/Apple-Pfad schreibt den begradigten DTSTART', async () => {
  const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
  const { fields } = icsFieldsForEvent({
    id: 1, title: 'Miete', all_day: 0,
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  }, 'Europe/Berlin');
  assert.match(fields.DTSTART.value, /^20260131T/, `DTSTART war ${fields.DTSTART.value}`);
  assert.match(fields.DTEND.value, /^20260131T/, `DTEND war ${fields.DTEND.value}`);
});

test('der ausgehende Pfad laesst ein importiertes DTSTART stehen (#756)', async () => {
  const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
  const { fields } = icsFieldsForEvent({
    id: 2, title: 'Fremd', all_day: 0,
    start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00',
    recurrence_rule: MONATSLETZTER, external_source: 'ics', series_authored: 0,
  }, 'Europe/Berlin');
  assert.match(fields.DTSTART.value, /^20260115T/, `DTSTART war ${fields.DTSTART.value}`);
});

test('ein ganztaegiger Termin wandert ebenfalls, mit exklusivem DTEND', async () => {
  const { icsFieldsForEvent } = await import('../server/services/caldav-outbound.js');
  const { fields } = icsFieldsForEvent({
    id: 3, title: 'Ganztags', all_day: 1,
    start_datetime: '2026-01-15', end_datetime: '2026-01-15',
    recurrence_rule: MONATSLETZTER, external_source: 'local', series_authored: 1,
  }, 'Europe/Berlin');
  assert.equal(fields.DTSTART.value, '20260131');
  // DTEND ist bei VALUE=DATE exklusiv: der Tag nach dem letzten sichtbaren.
  assert.equal(fields.DTEND.value, '20260201');
});

// --------------------------------------------------------
// Ein Zeitpunkt mit eigener Zone (#1935)
// --------------------------------------------------------
//
// So liegt eine eingelesene Serie in der Zeile, deren REGEL in Yuvomi geaendert
// wurde: der Start steht noch in der Form des Anbieters, die Marke ist gesetzt.

test('ein Zeitpunkt mit Zone wird auf der Wanduhr ausgerichtet, nicht am Text', () => {
  // 15. Januar 14:00 in Berlin, als Zeitpunkt mit Versatz und in UTC.
  for (const [start, ende] of [
    ['2035-01-15T14:00:00+01:00', '2035-01-15T15:00:00+01:00'],
    ['2035-01-15T13:00:00Z', '2035-01-15T14:00:00Z'],
  ]) {
    const out = outboundDateRange({
      start_datetime: start, end_datetime: ende, tzid: 'Europe/Berlin',
      recurrence_rule: MONATSLETZTER, external_source: 'google', series_authored: 1,
    });
    assert.deepEqual(out, { start_datetime: '2035-01-31T13:00:00Z', end_datetime: '2035-01-31T14:00:00Z' }, start);
  }
});

test('ueber die Zeitumstellung bleibt die Wanduhrzeit, nicht der Versatz', () => {
  // 15. Maerz 14:00 Berlin ist 13:00Z, 31. Maerz 14:00 Berlin ist 12:00Z. Den
  // Datumsteil im Text zu tauschen liesse den Termin eine Stunde spaeter beginnen.
  const out = outboundDateRange({
    start_datetime: '2035-03-15T13:00:00Z', end_datetime: '2035-03-15T14:30:00Z', tzid: 'Europe/Berlin',
    recurrence_rule: MONATSLETZTER, external_source: 'caldav', series_authored: 1,
  });
  assert.deepEqual(out, { start_datetime: '2035-03-31T12:00:00Z', end_datetime: '2035-03-31T13:30:00Z' });
});

test('der Ortstag zaehlt, wo er neben dem UTC-Tag liegt', () => {
  // 31. Januar 00:30 Berlin ist der 30. Januar 23:30Z: am Ort schon der
  // Monatsletzte, also nichts zu tun. Am Text gemessen wanderte der Termin
  // auf den 31. Januar 23:30Z, das ist der 1. Februar in Berlin.
  const amOrtPassend = {
    start_datetime: '2035-01-30T23:30:00Z', end_datetime: '2035-01-31T00:30:00Z', tzid: 'Europe/Berlin',
    recurrence_rule: MONATSLETZTER, external_source: 'caldav', series_authored: 1,
  };
  assert.deepEqual(outboundDateRange(amOrtPassend),
    { start_datetime: amOrtPassend.start_datetime, end_datetime: amOrtPassend.end_datetime });

  // Umgekehrt: 15. Januar 23:30 Berlin (22:30Z) wandert auf den 31. 23:30 Berlin.
  const spaet = outboundDateRange({
    start_datetime: '2035-01-15T22:30:00Z', end_datetime: null, tzid: 'Europe/Berlin',
    recurrence_rule: MONATSLETZTER, external_source: 'caldav', series_authored: 1,
  });
  assert.deepEqual(spaet, { start_datetime: '2035-01-31T22:30:00Z', end_datetime: null });
});

test('ausgerichtet wird in der Zone, in der der Empfaenger die Serie rechnet', () => {
  // 15. Januar 23:30 in New York = 16. Januar 04:30Z = 05:30 in Berlin.
  const ev = {
    start_datetime: '2035-01-16T04:30:00Z', end_datetime: '2035-01-16T04:45:00Z', tzid: 'America/New_York',
    recurrence_rule: MONATSLETZTER, external_source: 'google', series_authored: 1,
  };
  // CalDAV, iCloud und der Feed geben `TZID=America/New_York` hinaus: der 31. dort.
  assert.deepEqual(outboundDateRange(ev),
    { start_datetime: '2035-02-01T04:30:00Z', end_datetime: '2035-02-01T04:45:00Z' });
  // Google rechnet in der `timeZone`, die es mitbekommt. Der in New York
  // ausgerichtete Zeitpunkt waere in Berlin der 1. Februar - neben der Regel.
  assert.deepEqual(outboundDateRange(ev, { zone: 'Europe/Berlin' }),
    { start_datetime: '2035-01-31T04:30:00Z', end_datetime: '2035-01-31T04:45:00Z' });
  assert.equal(outboundEvent(ev, { zone: 'Europe/Berlin' }).start_datetime, '2035-01-31T04:30:00Z');
  // Eine zonenlose Wanduhrzeit meint ihren Tag selbst; die Angabe aendert nichts.
  const naiv = { start_datetime: '2035-01-15T23:30', recurrence_rule: MONATSLETZTER, series_authored: 1 };
  assert.equal(outboundDateRange(naiv, { zone: 'America/New_York' }).start_datetime, '2035-01-31T23:30');
});

test('ein Zeitpunkt mit Zone bleibt ohne die Marke stehen (#756)', () => {
  const ev = {
    start_datetime: '2035-01-15T13:00:00Z', end_datetime: '2035-01-15T14:00:00Z', tzid: 'Europe/Berlin',
    recurrence_rule: MONATSLETZTER, external_source: 'caldav', series_authored: 0,
  };
  assert.deepEqual(outboundDateRange(ev), { start_datetime: ev.start_datetime, end_datetime: ev.end_datetime });
});

// --------------------------------------------------------
// Wer die Marke setzt: eine Bearbeitung von Start oder Regel in Yuvomi
// --------------------------------------------------------

const BERLIN = 'Europe/Berlin';

test('eine Bearbeitung ohne Start und Regel setzt die Marke nicht', () => {
  const zeile = { start_datetime: '2035-01-15T14:00', all_day: 0, recurrence_rule: MONATSLETZTER };
  assert.equal(startOrRuleChanged(zeile, { ...zeile }, BERLIN), false);
});

test('derselbe Beginn in anderer Schreibweise ist keine Startaenderung', () => {
  // Das Formular schickt die Wanduhrzeit des Haushalts zurueck, in der Zeile
  // eines eingelesenen Termins steht der Zeitpunkt. Am Text verglichen setzte
  // jede Titelaenderung die Marke, und die Serie ginge mit anderem DTSTART zurueck.
  for (const gespeichert of ['2035-01-15T14:00:00+01:00', '2035-01-15T13:00:00Z', '2035-01-15T14:00:00', '2035-01-15T14:00']) {
    const zeile = { start_datetime: gespeichert, all_day: 0, recurrence_rule: `RRULE:${MONATSLETZTER}` };
    const danach = { start_datetime: '2035-01-15T14:00', all_day: 0, recurrence_rule: `RRULE:${MONATSLETZTER}` };
    assert.equal(startOrRuleChanged(zeile, danach, BERLIN), false, gespeichert);
  }
  const ganztags = { start_datetime: '2035-01-15', all_day: 1, recurrence_rule: MONATSLETZTER };
  assert.equal(startOrRuleChanged(ganztags, { ...ganztags }, BERLIN), false);
});

test('Sekunden, die das Formular nicht halten kann, sind keine Startaenderung', () => {
  // Der Dialog schickt HH:MM. Ein eingelesener Start mit Sekunden oder
  // Bruchteilen kommt bei jeder Bearbeitung ohne sie zurueck.
  for (const gespeichert of ['2035-01-15T13:00:30Z', '2035-01-15T14:00:59.999+01:00', '2035-01-15T14:00:30']) {
    const zeile = { start_datetime: gespeichert, all_day: 0, recurrence_rule: MONATSLETZTER };
    assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-01-15T14:00' }, BERLIN), false, gespeichert);
    // Die Minute davor und danach bleiben eine Aenderung.
    assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-01-15T14:01' }, BERLIN), true, gespeichert);
    assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-01-15T13:59' }, BERLIN), true, gespeichert);
  }
});

test('dieselbe Regel in anderer Schreibweise ist keine Regelaenderung', () => {
  const zeile = { start_datetime: '2035-01-15T14:00', all_day: 0, recurrence_rule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1' };
  const danach = { ...zeile, recurrence_rule: 'bymonthday=-1;FREQ=MONTHLY' };
  assert.equal(startOrRuleChanged(zeile, danach, BERLIN), false);
});

test('ein anderer Start, eine andere Regel oder der Wechsel auf ganztaegig setzen die Marke', () => {
  const zeile = { start_datetime: '2035-01-15T13:00:00Z', all_day: 0, recurrence_rule: 'FREQ=MONTHLY' };
  assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-02-10T14:00' }, BERLIN), true, 'anderer Tag');
  assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-01-15T14:30' }, BERLIN), true, 'andere Uhrzeit');
  assert.equal(startOrRuleChanged(zeile, { ...zeile, recurrence_rule: MONATSLETZTER }, BERLIN), true, 'andere Regel');
  assert.equal(startOrRuleChanged(zeile, { ...zeile, recurrence_rule: null }, BERLIN), true, 'Regel entfernt');
  assert.equal(startOrRuleChanged(zeile, { ...zeile, start_datetime: '2035-01-15', all_day: 1 }, BERLIN), true, 'ganztaegig');
});

// --------------------------------------------------------
// Wer die Marke nimmt: der Abruf
// --------------------------------------------------------
//
// Ohne Echo-Erkennung (die ist #1956): die Marke faellt genau dann, wenn ein
// anderer Start oder eine andere Regel in die Zeile kommt, als dort stand.

const eigene = (felder = {}) => ({
  start_datetime: '2035-01-15T14:00', end_datetime: '2035-01-15T15:00', all_day: 0,
  recurrence_rule: MONATSLETZTER, tzid: null, series_authored: 1, ...felder,
});

test('derselbe Start und dieselbe Regel lassen die Marke stehen', () => {
  assert.equal(authoredAfterInbound(eigene(), { start_datetime: '2035-01-15T14:00', recurrence_rule: MONATSLETZTER }), 1);
  // Ein Einzeltermin: keine Regel auf beiden Seiten, gleich ob null oder leer.
  const einzeln = eigene({ start_datetime: '2035-01-31', all_day: 1, recurrence_rule: null });
  assert.equal(authoredAfterInbound(einzeln, { start_datetime: '2035-01-31', recurrence_rule: null }), 1);
  assert.equal(authoredAfterInbound(einzeln, { start_datetime: '2035-01-31', recurrence_rule: undefined }), 1);
  assert.equal(authoredAfterInbound(einzeln, { start_datetime: '2035-01-31', recurrence_rule: '' }), 1);
});

test('ein anderer Start oder eine andere Regel vom Anbieter nimmt die Marke', () => {
  const gleich = { start_datetime: '2035-01-15T14:00', recurrence_rule: MONATSLETZTER };
  assert.equal(authoredAfterInbound(eigene(), { ...gleich, start_datetime: '2035-01-20T16:00' }), 0, 'anderer Tag');
  assert.equal(authoredAfterInbound(eigene(), { ...gleich, start_datetime: '2035-01-15T14:30' }), 0, 'andere Uhrzeit');
  assert.equal(authoredAfterInbound(eigene(), { ...gleich, recurrence_rule: 'FREQ=MONTHLY' }), 0, 'andere Regel');
  assert.equal(authoredAfterInbound(eigene(), { ...gleich, recurrence_rule: null }), 0, 'Regel entfernt');
  assert.equal(authoredAfterInbound(eigene(), { ...gleich, start_datetime: '2035-01-15' }), 0, 'ganztaegig geworden');
});

test('das Echo des eigenen Uploads ist ein anderer Start und nimmt die Marke ebenfalls', () => {
  // Der Anbieter liefert den 31. Januar - genau das, was hinausging. Geurteilt
  // wird darueber nicht: in die Zeile kommt ein anderer Start, als dort stand.
  for (const start of ['2035-01-31T14:00:00+01:00', '2035-01-31T13:00:00Z', '2035-01-31T14:00']) {
    assert.equal(authoredAfterInbound(eigene(), { start_datetime: start, recurrence_rule: MONATSLETZTER }), 0, start);
  }
  assert.equal(
    authoredAfterInbound(eigene({ start_datetime: '2035-01-15', all_day: 1 }), { start_datetime: '2035-01-31', recurrence_rule: MONATSLETZTER }),
    0,
  );
});

test('verglichen wird der Text, der in die Spalte kommt', () => {
  // Derselbe Beginn als Zeitpunkt des Anbieters, dieselbe Regel mit `RRULE:`
  // davor: beides ist die Form des Anbieters und steht danach in der Zeile.
  // Eine passend liegende Serie verliert die Marke damit auch - an ihr ist
  // nichts auszurichten, und die naechste Aenderung in Yuvomi setzt sie wieder.
  const passend = eigene({ start_datetime: '2035-01-31T14:00' });
  assert.equal(authoredAfterInbound(passend, { start_datetime: '2035-01-31T13:00:00Z', recurrence_rule: MONATSLETZTER }), 0);
  assert.equal(authoredAfterInbound(passend, { start_datetime: '2035-01-31T14:00', recurrence_rule: `RRULE:${MONATSLETZTER}` }), 0);
});

test('eine Zeile ohne Marke bekommt durch den Abruf keine', () => {
  const gleich = { start_datetime: '2035-01-15T14:00', recurrence_rule: MONATSLETZTER };
  assert.equal(authoredAfterInbound(eigene({ series_authored: 0 }), gleich), 0);
  assert.equal(authoredAfterInbound(eigene({ series_authored: undefined }), gleich), 0, 'unbekannt heisst wie eingelesen');
  assert.equal(authoredAfterInbound(null, gleich), 0);
});
