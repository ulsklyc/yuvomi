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

import {
  SYNC_TARGET_LOCAL,
  googleTargetValue,
  caldavTargetValue,
  outlookTargetValue,
  parseSyncTargetValue,
  buildSyncTargetOptions,
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
