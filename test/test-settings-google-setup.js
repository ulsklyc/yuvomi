/**
 * Tests: die Google-Karte fuehrt durch die Einrichtung, solange die
 *        OAuth-Zugangsdaten fehlen (#2221)
 * Modul: /public/settings/pages/sync-calendar.js  (buildGoogleProvider,
 *        buildGoogleSetupGuide, googleAcceptsRedirect)
 *
 * DIE LAGE: Ohne GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET und GOOGLE_REDIRECT_URI
 * stand auf der Karte nur "Nicht konfiguriert (fehlende .env-Variablen)" - in
 * der Statuszeile und darunter ein zweites Mal. Ein Leser unter Caschys Artikel
 * (24.10.2026) blieb genau dort stehen. Jetzt nennt die Karte dem Admin die
 * fehlenden Namen, die Rueckrufadresse fuer Google zum Kopieren, die Schritte
 * und die Wege ganz ohne Google-Einrichtung.
 *
 * Gemessen wird die echte Karte unter test/mini-dom.js; t() liefert im
 * Test-Loader den Schluessel selbst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement } from './mini-dom.js';

installMiniDom();
globalThis.window.yuvomi = { showToast() {} };
globalThis.window.location = { origin: 'https://family.example.org' };
// Die Aktionszeile haengt nur, wenn sie Kinder hat.
Object.defineProperty(MiniElement.prototype, 'childElementCount', {
  get() { return this.childNodes.filter((n) => n instanceof MiniElement).length; },
});

const { __test } = await import('../public/settings/pages/sync-calendar.js');

const admin = { id: 1, role: 'admin' };
const member = { id: 2, role: 'member' };
const notConfigured = { configured: false, connected: false, lastSync: null, mirroredEvents: 0 };

/** Alle Elemente unter `root`, die `pred` erfuellen. */
function findAll(root, pred, out = []) {
  for (const node of root.childNodes ?? []) {
    if (!(node instanceof MiniElement)) continue;
    if (pred(node)) out.push(node);
    findAll(node, pred, out);
  }
  return out;
}

test('#2221: fehlt eine Variable, nennt die Karte genau deren Namen und die eingetragene Rueckrufadresse', () => {
  const card = __test.buildGoogleProvider({
    ...notConfigured,
    missingEnv: ['GOOGLE_CLIENT_SECRET'],
    redirectUri: 'https://home.example.net/api/v1/calendar/google/callback',
  }, admin);
  const html = card.outerHTML;
  assert.match(html, /settings\.googleSetupMissing/);
  const missingNote = findAll(card, (n) => n.className.includes('settings-provider-note--hint'))[0];
  const named = findAll(missingNote, (n) => n.tagName === 'code').map((n) => n.textContent);
  assert.deepEqual(named, ['GOOGLE_CLIENT_SECRET'], 'nur die fehlende Variable wird genannt');

  const input = findAll(card, (n) => n.tagName === 'input')[0];
  assert.ok(input, 'die Rueckrufadresse steht in einem Feld');
  assert.equal(input.value, 'https://home.example.net/api/v1/calendar/google/callback', 'die eingetragene Adresse gewinnt');
  assert.equal(input.readOnly, true);
  assert.equal(findAll(card, (n) => n.tagName === 'ol').length, 1, 'die Schritte stehen als nummerierte Liste');
  assert.match(html, /settings\.googleSetupCopy/);
  assert.doesNotMatch(html, /settings\.googleSetupRedirectHttps/, 'eine HTTPS-Adresse mit Hostnamen braucht keine Warnung');
  assert.equal(html.match(/settings\.notConfigured/g)?.length, 1, 'der Satz der Statuszeile steht nicht ein zweites Mal da');
});

test('#2221: ohne eingetragene Adresse schlaegt die Karte die eigene vor, und daneben stehen die Wege ohne Google', () => {
  const card = __test.buildGoogleProvider(notConfigured, admin);
  const input = findAll(card, (n) => n.tagName === 'input')[0];
  assert.equal(input.value, 'https://family.example.org/api/v1/calendar/google/callback');
  const missingNote = findAll(card, (n) => n.className.includes('settings-provider-note--hint'))[0];
  assert.equal(findAll(missingNote, (n) => n.tagName === 'code').length, 3, 'ohne Angabe vom Server: alle drei Namen');

  const alt = findAll(card, (n) => n.tagName === 'a' && n.textContent === 'settings.googleSetupWithoutAction')[0];
  assert.ok(alt, 'der Weg ohne Google-Einrichtung ist ein Knopf');
  assert.equal(alt.href, '/settings/modules/calendar?section=personal-calendar-subscriptions');
  const guide = findAll(card, (n) => n.tagName === 'a' && n.textContent === 'settings.googleSetupGuideLink')[0];
  assert.match(guide.href, /docs\/installation\.md#google-calendar-sync-optional$/);
});

test('#2221: unter einer IP-Adresse warnt die Karte, bevor Google die Adresse ablehnt', () => {
  const card = __test.buildGoogleProvider({ ...notConfigured, redirectUri: 'http://192.168.1.20:3000/api/v1/calendar/google/callback' }, admin);
  assert.match(card.outerHTML, /settings\.googleSetupRedirectHttps/);
});

test('#2221: ein Mitglied sieht keine Einrichtung, nur den Zustand', () => {
  const card = __test.buildGoogleProvider(notConfigured, member);
  assert.match(card.outerHTML, /settings\.notConfigured/);
  assert.doesNotMatch(card.outerHTML, /settings\.googleSetup/);
});

test('#2221: welche Rueckrufadresse Google annimmt', () => {
  const ok = __test.googleAcceptsRedirect;
  assert.equal(ok('https://family.example.org/api/v1/calendar/google/callback'), true);
  assert.equal(ok('http://localhost:3000/api/v1/calendar/google/callback'), true, 'localhost ist ausgenommen');
  assert.equal(ok('http://family.example.org/api/v1/calendar/google/callback'), false, 'kein HTTPS');
  assert.equal(ok('https://192.168.1.20/api/v1/calendar/google/callback'), false, 'IPv4');
  assert.equal(ok('https://[fd00::1]/api/v1/calendar/google/callback'), false, 'IPv6');
  assert.equal(ok('kein url'), false);
});

test('#2221: Kopieren meldet nur Erfolg, wenn wirklich kopiert wurde (http ohne Zwischenablage)', async () => {
  const copy = __test.copyFieldValue;
  const field = () => ({ value: 'http://192.168.1.20:3000/api/v1/calendar/google/callback', focus() {}, select() { this.selected = true; } });
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  const savedNavigator = globalThis.navigator;
  const savedExec = globalThis.document.execCommand;
  try {
    // http im Heimnetz: keine Clipboard-API, und auch der Auswahl-Weg scheitert.
    setNavigator({});
    globalThis.document.execCommand = () => false;
    const f1 = field();
    assert.equal(await copy(f1), false, 'kein "kopiert", wenn nichts kopiert wurde');
    assert.equal(f1.selected, true, 'das Feld steht markiert, damit man von Hand kopieren kann');

    // Ohne Clipboard-API, aber der Auswahl-Weg klappt.
    globalThis.document.execCommand = (cmd) => cmd === 'copy';
    assert.equal(await copy(field()), true);

    // Mit Clipboard-API.
    let written = null;
    setNavigator({ clipboard: { writeText: async (v) => { written = v; } } });
    globalThis.document.execCommand = () => { throw new Error('nicht gebraucht'); };
    assert.equal(await copy(field()), true);
    assert.match(written, /google\/callback$/);
  } finally {
    setNavigator(savedNavigator);
    globalThis.document.execCommand = savedExec;
  }
});
