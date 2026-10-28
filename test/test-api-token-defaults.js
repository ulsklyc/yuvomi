/**
 * Tests: ein neues API-Token startet mit Ablauf und Modulgrenze
 * Modul: /public/settings/pages/admin-api.js  (renderPage, resolveTokenExpiry,
 *        validityExpiresAt)
 *
 * DIE LAGE: Wer im Formular nur einen Namen eintrug, bekam ein Token, das nie
 * ablief und alles durfte, was die gewaehlte Person darf - leeres Datumsfeld
 * hiess "kein Ablauf", ausgeschalteter Schalter hiess "voller Zugriff". Eine
 * oeffentliche Code-Lesung (greenlitbooks.com, 26.09.2026) hat genau das
 * angemerkt. Jetzt ist die Gueltigkeit eine Auswahl mit 90 Tagen vorn, die
 * Modulgrenze ist eingeschaltet, und beides abzuwaehlen ist eine bewusste Wahl.
 * Die API bleibt wie zugesagt: `expires_at` und `scopes` sind dort optional.
 *
 * Gemessen wird das echte Markup unter test/mini-dom.js; t() liefert im
 * Test-Loader den Schluessel selbst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement } from './mini-dom.js';

installMiniDom();

const { __test, resolveTokenExpiry, validityExpiresAt, TOKEN_VALIDITY_DEFAULT, scopesFromLevels } = await import('../public/settings/pages/admin-api.js');

const NOW = Date.parse('2026-10-25T12:00:00Z');
/** Dieselbe Uhrzeit `days` Kalendertage spaeter, in der Zone des Laufs. */
function plusDays(days) {
  const date = new Date(NOW);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function renderedForm() {
  const container = new MiniElement('div');
  __test.renderPage(container, ['tasks', 'shopping']);
  return container.innerHTML;
}

/** Das oeffnende Tag des Elements mit dieser id. */
function tagWithId(html, id) {
  const match = html.match(new RegExp(`<[a-z-]+\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `#${id} steht im Formular`);
  return match[0];
}

test('die Gueltigkeit steht auf 90 Tagen, nicht auf "kein Ablauf"', () => {
  const html = renderedForm();
  assert.equal(TOKEN_VALIDITY_DEFAULT, '90');
  assert.match(html, /<option value="90" selected>settings\.apiTokenValidity90<\/option>/);
  assert.equal((html.match(/<option[^>]*\bselected\b/g) ?? []).length, 1, 'genau eine Vorgabe');
  assert.match(html, /<option value="never">settings\.apiTokenValidityNever<\/option>/, '"Kein Ablauf" bleibt waehlbar');
  assert.match(tagWithId(html, 'api-token-expires-row'), /\bhidden\b/, 'das Datumsfeld steht nur beim eigenen Datum da');
  assert.doesNotMatch(html, /apiTokenExpiresHint/, 'kein Hinweis mehr, das Feld fuer "kein Ablauf" leer zu lassen');
  assert.match(tagWithId(html, 'api-token-validity-hint'), /api-token-validity-hint/);
  assert.match(tagWithId(html, 'api-token-validity'), /aria-describedby="api-token-validity-hint"/);
});

test('die Modulgrenze ist eingeschaltet und die Rechtetabelle sichtbar', () => {
  const html = renderedForm();
  assert.match(tagWithId(html, 'api-token-scope-limit'), /\bchecked\b/);
  assert.doesNotMatch(tagWithId(html, 'api-token-scope-grid'), /\bhidden\b/);
});

// R24 (E11, Critique G6-Einst-P3-1): je Modul EINE Optionszeile mit der Stufe
// als Auswahl, wie Name/Person/Gueltigkeit darueber - statt einer grauen
// Tabelle mit 2 x 15 nativen 13px-Kaestchen. Die Grenze bleibt eingeschaltet
// (bewusste Vorgabe, Test darueber). Schreiben schliesst Lesen ein.
test('R24 E11: je Modul eine Optionszeile "Kein Zugriff / Lesen / Schreiben", keine Kaestchen', () => {
  const html = renderedForm();
  const rows = [...html.matchAll(/<select class="form-input" id="api-token-scope-([\w-]+)" data-scope-module="([\w:-]+)">/g)].map((m) => m[2]);
  assert.deepEqual(rows, ['tasks', 'shopping'], 'eine Zeile je Modul');
  assert.doesNotMatch(html, /type="checkbox"[^>]*data-scope=/, 'keine Lesen/Schreiben-Kaestchen mehr');
  assert.doesNotMatch(html, /api-token-scopes__head|api-token-scopes__cell/, 'keine Tabelle');
  assert.match(html, /<option value="none">settings\.permAccessNone<\/option><option value="read">settings\.apiTokenScopeRead<\/option><option value="write">settings\.apiTokenScopeWrite<\/option>/);
  assert.deepEqual(scopesFromLevels([['tasks', 'write'], ['shopping', 'none'], ['notes', 'read']]), ['tasks:read', 'tasks:write', 'notes:read']);
});

test('jede Vorgabe ergibt ein Ablaufdatum, nur "Kein Ablauf" ergibt keins', () => {
  assert.equal(resolveTokenExpiry('30', '', NOW).expires_at, plusDays(30));
  assert.equal(resolveTokenExpiry('90', '', NOW).expires_at, plusDays(90));
  assert.equal(resolveTokenExpiry('365', '', NOW).expires_at, plusDays(365));
  assert.deepEqual(resolveTokenExpiry('never', '', NOW), { expires_at: null });
  assert.equal(validityExpiresAt('never', NOW), null);
});

test('eine Vorgabe zaehlt Kalendertage: ueber die Zeitumstellung bleibt die Uhrzeit', () => {
  // 25.10.2026 endet in Berlin die Sommerzeit. 90 x 24 h ab dem Vortag 12:00
  // landeten am 22.01.2027 um 11:00 Ortszeit; Kalendertage halten 12:00. Ein
  // ganzes Jahr waere hier blind: Winter- und Sommerzeit heben sich darin auf.
  const before = new Date(2026, 9, 24, 12, 0).getTime();
  for (const choice of ['30', '90']) {
    const until = new Date(validityExpiresAt(choice, before));
    assert.equal(until.getHours(), 12, `${choice} Tage`);
    assert.equal(until.getMinutes(), 0, `${choice} Tage`);
  }
});

test('ein eigenes Datum ohne Wert ist ein Fehler, nie stillschweigend "kein Ablauf"', () => {
  assert.deepEqual(resolveTokenExpiry('custom', '', NOW), { error: 'settings.apiTokenInvalidExpiration' });
  assert.deepEqual(resolveTokenExpiry('custom', 'kein Datum', NOW), { error: 'settings.apiTokenInvalidExpiration' });
  assert.equal(resolveTokenExpiry('custom', '2027-01-31T08:00', NOW).expires_at, new Date('2027-01-31T08:00').toISOString());
  assert.deepEqual(resolveTokenExpiry('unbekannt', '', NOW), { error: 'settings.apiTokenInvalidExpiration' });
});

// Nach dem Anlegen setzt form.reset() das Formular auf seine Vorgaben zurueck.
// Die Person unter "Handelt als" war nur `selected`, nicht `defaultSelected` -
// also sprang die Auswahl auf die erste Person der Liste, und das naechste Token
// handelte still als jemand anderes (im Browser gemessen, 25.10.2026). Die
// mini-dom kennt kein form.reset(); der Guard prueft deshalb die Zuweisung im
// Aufbau der Liste, und die Messung im Browser steht im PR.
test('"Handelt als" bleibt nach dem Anlegen bei der vorgewaehlten Person', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/settings/pages/admin-api.js', import.meta.url), 'utf8');
  const loop = source.match(/for \(const member of users\) \{[\s\S]*?subject\.appendChild\(option\);/);
  assert.ok(loop, 'der Aufbau der Personenliste steht in admin-api.js');
  assert.match(loop[0], /option\.defaultSelected = Number\(member\.id\) === Number\(currentUserId\)/);
});

// Die Rechtetabelle zeigte "pantry" statt "Vorrat": das Modul stand in
// CORE_SCOPE_MODULE_KEYS, sein Name fehlte unter settings.apiTokenScopeModules,
// und t() gab den Schluessel zurueck. Der Guard in test:i18n vergleicht nur
// Namen, die es gibt; dieser hier verlangt fuer jedes Kernmodul einen.
test('jedes Kernmodul der Rechtetabelle hat einen Namen in jeder Sprache', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/settings/pages/admin-api.js', import.meta.url), 'utf8');
  const list = source.match(/const CORE_SCOPE_MODULE_KEYS = \[([\s\S]*?)\];/);
  assert.ok(list, 'CORE_SCOPE_MODULE_KEYS steht in admin-api.js');
  const keys = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15, `nur ${keys.length} Kernmodule gelesen`);
  const dir = new URL('../public/locales/', import.meta.url);
  const missing = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const names = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).settings.apiTokenScopeModules ?? {};
    for (const key of keys) if (!names[key]) missing.push(`${file}: ${key}`);
  }
  assert.deepEqual(missing, []);
});
