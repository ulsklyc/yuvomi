/**
 * Modul: Angemeldete Geraete im Konto-Blatt (Refs #255)
 * Zweck: Der PWA-Teil der Kopplung. Hier stehen die Telefone, die mit dem
 *        eigenen Konto angemeldet sind, und hier entsteht der Code, mit dem ein
 *        Telefon ohne Passwort hineinkommt. Geprueft werden die zwei Seams, die
 *        ohne Browser messbar sind:
 *        (1) die reinen Helfer: der Code in Fuenfergruppen wie in der App, und
 *            wie lange er noch gilt;
 *        (2) das Markup der Liste: Name, Plattform, "Zuletzt benutzt", das
 *            aktuelle Geraet, und Namen laufen durch `esc()`.
 *        Klickpfade (Widerruf, neuer Code) prueft der Lauf im Browser.
 * Ausfuehren: npm run test:signed-in-devices-ui
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const devices = await import('../public/settings/signed-in-devices.js');

test('der Code steht in Fuenfergruppen, wie die App ihn zeigt', () => {
  assert.equal(devices.groupPairingCode('ACDEFGHJK3'), 'ACDEF GHJK3');
});

test('das Ende des Codes zaehlt ab Empfang, nicht nach der Uhr dieses Geraets', () => {
  // Geht die Uhr hier zehn Minuten vor, laege `expires_at` schon in der
  // Vergangenheit, und der frische Code staende als abgelaufen da.
  const receivedAt = Date.parse('2026-11-03T12:10:00Z');
  assert.equal(devices.pairingDeadline(receivedAt), Date.parse('2026-11-03T12:15:00Z'));
});

test('neu ist ein Geraet, das vorher nicht in der Liste stand', () => {
  const before = [{ id: 1, name: 'Alt' }];
  const after = [{ id: 2, name: 'Neu' }, { id: 1, name: 'Alt' }];
  assert.deepEqual(devices.newDevices(before, after).map((d) => d.id), [2]);
  assert.deepEqual(devices.newDevices(after, after), []);
});

const when = (date) => `[${date.toISOString()}]`;

test('eine Zeile nennt Name, Plattform und wann das Geraet zuletzt lief', () => {
  const html = devices.devicesListHtml([
    { id: 7, name: 'KlyPhone', platform: 'ios', last_used_at: '2026-11-03T10:00:00Z', current: false },
  ], { when });
  assert.match(html, /KlyPhone/);
  assert.match(html, /iOS/);
  assert.match(html, /settings\.devicesLastUsed/);
  assert.match(html, /\[2026-11-03T10:00:00.000Z\]/);
  assert.match(html, /data-revoke-device="7"/);
  assert.doesNotMatch(html, /settings\.devicesCurrent/);
});

test('ein nie benutztes Geraet sagt das, statt ein leeres Datum zu zeigen', () => {
  const html = devices.devicesListHtml([
    { id: 8, name: 'iPad', platform: 'ios', last_used_at: null, current: false },
  ], { when });
  assert.match(html, /settings\.devicesNeverUsed/);
  assert.doesNotMatch(html, /\[null\]/);
});

test('das aktuelle Geraet ist gekennzeichnet', () => {
  const html = devices.devicesListHtml([
    { id: 9, name: 'Telefon', platform: 'ios', last_used_at: null, current: true },
  ], { when });
  assert.match(html, /settings\.devicesCurrent/);
});

test('Name und unbekannte Plattform laufen durch esc()', () => {
  const html = devices.devicesListHtml([
    { id: 10, name: '<img src=x onerror=alert(1)>', platform: 'web-<b>', last_used_at: null, current: false },
  ], { when });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;img src=x/);
});

test('eine leere Liste sagt, dass noch kein Geraet angemeldet ist', () => {
  assert.match(devices.devicesListHtml([], { when }), /settings\.devicesEmpty/);
});
