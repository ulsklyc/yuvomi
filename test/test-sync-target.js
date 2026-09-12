/**
 * Test: Kennungen der Kalender-Sync-Ziele (#620)
 * Zweck: Das Format, mit dem Event-Modal und Einstellungen dasselbe Ziel
 *        benennen. Weichen sie voneinander ab, zeigt die Einstellungsseite
 *        "Lokal speichern", obwohl ein Ziel gespeichert ist - und der neue
 *        Termin landet im falschen Kalender. Deckt zusätzlich ab, dass ein
 *        nicht mehr angebotenes Ziel sichtbar bleibt statt still zu verschwinden.
 * Ausführen: node --test test/test-sync-target.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SYNC_TARGET_LOCAL,
  googleTargetValue,
  caldavTargetValue,
  outlookTargetValue,
  parseSyncTargetValue,
  buildSyncTargetOptions,
  assigneeSyncTarget,
} from '../public/utils/sync-target.js';

const LABELS = { local: 'Lokal', google: 'Google', caldav: 'CalDAV', outlook: 'Outlook', unavailable: 'Nicht verfügbar' };

test('bauen und zerlegen sind zueinander invers', () => {
  const google = googleTargetValue('family@group.calendar.google.com');
  assert.deepEqual(parseSyncTargetValue(google),
    { kind: 'google', calendarId: 'family@group.calendar.google.com' });

  const caldav = caldavTargetValue(4, 'https://dav.example.org/cal/family/');
  assert.deepEqual(parseSyncTargetValue(caldav),
    { kind: 'caldav', accountId: 4, calendarUrl: 'https://dav.example.org/cal/family/' });

  const outlook = outlookTargetValue(2, 'AQMkADAwATZiZmYAZC00Zg==');
  assert.deepEqual(parseSyncTargetValue(outlook),
    { kind: 'outlook', accountId: 2, calendarId: 'AQMkADAwATZiZmYAZC00Zg==' });
});

test('leerer Wert ist "lokal speichern", kein Fehler', () => {
  assert.deepEqual(parseSyncTargetValue(SYNC_TARGET_LOCAL), { kind: 'local' });
  assert.deepEqual(parseSyncTargetValue(''), { kind: 'local' });
  assert.deepEqual(parseSyncTargetValue(null), { kind: 'local' });
  assert.deepEqual(parseSyncTargetValue(undefined), { kind: 'local' });
});

test('CalDAV-URL mit Pipe-Zeichen bleibt vollständig', () => {
  // Ein Split über ALLE '|' würde die URL hier abschneiden.
  const url = 'https://dav.example.org/cal/a|b/';
  const parsed = parseSyncTargetValue(caldavTargetValue(2, url));
  assert.equal(parsed.calendarUrl, url);
});

test('kaputte Kennungen ergeben null statt eines halben Ziels', () => {
  for (const bad of ['exchange:foo', 'google:', 'caldav:', 'caldav:abc|https://x/', 'caldav:|https://x/', 'caldav:3', 'caldav:0|https://x/', 'caldav:3|', 'outlook:', 'outlook:abc|id', 'outlook:2', 'outlook:2|', 'outlook:0|id']) {
    assert.equal(parseSyncTargetValue(bad), null, `"${bad}" muss null ergeben`);
  }
});

test('Optionsliste beginnt mit "lokal" und gruppiert nach Quelle', () => {
  const options = buildSyncTargetOptions({
    google: [{ id: 'g1', summary: 'Familie' }],
    caldav: [{ accountId: 1, accountName: 'Nextcloud', calendarUrl: 'https://x/c1', calendarName: 'Privat' }],
    outlook: [{ accountId: 2, accountName: 'Papa', calendarId: 'ol1', calendarName: 'Yuvomi' }],
  }, LABELS);

  assert.equal(options[0].value, SYNC_TARGET_LOCAL);
  assert.equal(options[0].group, null);
  assert.deepEqual(options[1], { value: 'google:g1', label: 'Familie', group: 'Google' });
  assert.deepEqual(options[2], {
    value: 'caldav:1|https://x/c1', label: 'Privat', group: 'CalDAV · Nextcloud',
  });
  assert.deepEqual(options[3], {
    value: 'outlook:2|ol1', label: 'Yuvomi', group: 'Outlook · Papa',
  });
});

test('fehlende Anzeigenamen fallen auf die Kennung zurück', () => {
  const options = buildSyncTargetOptions({
    google: [{ id: 'g1' }],
    caldav: [{ accountId: 1, accountName: 'N', calendarUrl: 'https://x/c1' }],
  }, LABELS);
  assert.equal(options[1].label, 'g1');
  assert.equal(options[2].label, 'https://x/c1');
});

test('gespeichertes, nicht mehr angebotenes Ziel bleibt als Option erhalten', () => {
  const options = buildSyncTargetOptions({ google: [], caldav: [] }, LABELS, 'google:weg@example.com');
  const kept = options.find((o) => o.value === 'google:weg@example.com');
  assert.ok(kept, 'Ziel darf nicht stillschweigend verschwinden');
  assert.equal(kept.label, LABELS.unavailable);
});

test('noch angebotenes Ziel wird nicht doppelt einsortiert', () => {
  const options = buildSyncTargetOptions(
    { google: [{ id: 'g1', summary: 'Familie' }] }, LABELS, 'google:g1',
  );
  assert.equal(options.filter((o) => o.value === 'google:g1').length, 1);
});

test('leere oder fehlende Zielantwort ergibt genau die lokale Option', () => {
  assert.equal(buildSyncTargetOptions({}, LABELS).length, 1);
  assert.equal(buildSyncTargetOptions(null, LABELS).length, 1);
});

// --------------------------------------------------------
// #1060: Ziel aus der Zuweisung
// --------------------------------------------------------

const ZIELE = {
  google: [
    { id: 'emma@group.calendar.google.com', summary: 'Emma', defaultAssigneeUserId: 3 },
    { id: 'familie@group.calendar.google.com', summary: 'Familie', defaultAssigneeUserId: null },
  ],
  caldav: [
    { accountId: 4, accountName: 'Nextcloud', calendarUrl: 'https://dav.example.org/cal/leo/', calendarName: 'Leo', defaultAssigneeUserId: 4 },
  ],
  outlook: [
    { accountId: 2, accountName: 'Papa', calendarId: 'ol1', calendarName: 'Papa', defaultAssigneeUserId: 1 },
  ],
};

test('#1060: genau eine Person, genau ein Kalender - das ist das Ziel', () => {
  assert.deepEqual(assigneeSyncTarget(ZIELE, [3]), { value: 'google:emma@group.calendar.google.com', ambiguous: false });
  assert.deepEqual(assigneeSyncTarget(ZIELE, ['4']), { value: 'caldav:4|https://dav.example.org/cal/leo/', ambiguous: false },
    'IDs aus dem Formular kommen als Text');
  assert.deepEqual(assigneeSyncTarget(ZIELE, [3, 3]), { value: 'google:emma@group.calendar.google.com', ambiguous: false },
    'dieselbe Person doppelt ist eine Person');
});

test('#1060: kein Ziel ohne eindeutige Person oder ohne Kalender, der sie nennt', () => {
  assert.deepEqual(assigneeSyncTarget(ZIELE, []), { value: null, ambiguous: false });
  assert.deepEqual(assigneeSyncTarget(ZIELE, [3, 4]), { value: null, ambiguous: false },
    'zwei Zugewiesene bekommen kein automatisches Ziel');
  assert.deepEqual(assigneeSyncTarget(ZIELE, [2]), { value: null, ambiguous: false },
    'eine Person ohne Kalender faellt auf den eigenen Standard des Autors zurueck');
  assert.deepEqual(assigneeSyncTarget(ZIELE, [1]), { value: null, ambiguous: false },
    'Outlook traegt keine Standard-Zuweisung und wird nie ueber sie gewaehlt');
  assert.deepEqual(assigneeSyncTarget(null, [3]), { value: null, ambiguous: false });
  assert.deepEqual(assigneeSyncTarget(ZIELE, [0]), { value: null, ambiguous: false },
    'null aus einem leeren Feld ist keine Person');
});

test('#1060: das Terminformular ruft die Regel auf - nur beim Anlegen, und die eigene Wahl gewinnt', () => {
  // Der Helfer oben kann stimmen und trotzdem nie laufen. Die Verdrahtung ist
  // DOM-Code; hier steht, woran sie haengt.
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const laden = src.slice(src.indexOf('async function loadSyncTargets'), src.indexOf('function applyDefaultSyncTarget'));
  assert.match(laden, /\n  return targets;\n\}/, 'loadSyncTargets gibt die Ziele samt Standard-Zuweisung zurueck');

  const form = src.slice(src.indexOf("const syncTargetSelect = panel.querySelector('#event-sync-target');"));
  assert.match(form, /if \(mode !== 'create' \|\| zielVonHand \|\| !ziele\) return;/,
    'ein bestehender Termin zieht nie von selbst um, und eine Wahl von Hand bleibt stehen');
  assert.match(form, /assigneeSyncTarget\(ziele, getSelectedUserIds\(panel, 'cal_assigned'\)\)/);
  assert.match(form, /syncTargetSelect\.value = '';\s*applyDefaultSyncTarget\(syncTargetSelect\);/,
    'ohne Treffer gilt wieder der eigene Standard des Autors (#620)');
  assert.match(form, /addEventListener\('change', \(\) => \{\s*\/\/[^\n]*\n\s*zielVonHand = true;/,
    'jede Aenderung von Hand beendet die Automatik');
  assert.match(form, /\.user-ms\[data-ms-name="cal_assigned"\]'\)\s*\?\.addEventListener\('change'/,
    'eine geaenderte Zuweisung rechnet das Ziel neu');
  assert.match(src, /id="event-sync-target-assignee-hint" hidden>\$\{t\('calendar\.syncTargetAssigneeAmbiguous'\)\}/,
    'bei zwei Kalendern fuer dieselbe Person sagt das Formular, warum nichts gewaehlt ist');
  // Der Hinweis steht mit der Zielwahl unter „Weitere Einstellungen", und das
  // ist beim Anlegen zu - ohne Aufklappen sagte das Formular es niemandem
  // (Review zu #1125).
  assert.match(form, /if \(ambiguous\) mehrdeutigHint\.closest\('details'\)\?\.setAttribute\('open', ''\);/,
    'ein mehrdeutiges Ziel klappt die Einstellungen auf, in denen der Hinweis steht');
});

test('#1060: nennen zwei Kalender dieselbe Person, wird nicht geraten', () => {
  const doppelt = {
    ...ZIELE,
    caldav: [...ZIELE.caldav, { accountId: 5, accountName: 'Mailbox', calendarUrl: 'https://dav.example.org/cal/emma/', calendarName: 'Emma Sport', defaultAssigneeUserId: 3 }],
  };
  assert.deepEqual(assigneeSyncTarget(doppelt, [3]), { value: null, ambiguous: true });
});
