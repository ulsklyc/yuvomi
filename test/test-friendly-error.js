/**
 * Tests: Fehler -> Satz (#1640)
 *
 * `friendlyError` ist der Satz fuer einen Fehler, den keine Seite selbst
 * behandelt: Fehlerbildschirm, unbehandelte Rejection, window.yuvomi.friendlyError.
 * Fuer eine Absage (403) hatte er einen eigenen Wortlaut - "Zugriff verweigert.
 * Bitte erneut anmelden." - neben dem aus api.js (`common.errorNoPermission`,
 * #1638). Zwei Saetze fuer denselben Fall, und der hier riet zur Anmeldung, wo
 * die Sitzung in Ordnung war. Jetzt gibt es einen.
 *
 * Die Funktion lebte in router.js und war dort nicht importierbar; sie steht
 * seitdem in public/utils/friendly-error.js und laeuft hier als Programm.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-friendly-error.js
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const load = () => import('../public/utils/friendly-error.js');

// Der Test-Loader liefert fuer t(key) den Schluessel selbst.
function setOnline(onLine) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
}
beforeEach(() => setOnline(true));

test('eine Absage (403) bekommt den einen Satz der App', async () => {
  const { friendlyError } = await load();
  assert.equal(friendlyError({ status: 403, message: 'Admin access required.' }), 'common.errorNoPermission');
  assert.equal(friendlyError({ status: 403, data: { error: 'Not authorized.' } }), 'common.errorNoPermission');
  // Ein Fehler, der die Antwort selbst traegt statt des Status.
  assert.equal(friendlyError({ response: { status: 403 } }), 'common.errorNoPermission');
});

// #1640: api.js setzt anhand von `reason` den genaueren Satz - friendlyError hat
// ihn bis dahin mit dem allgemeinen ueberschrieben.
test('eine Absage mit bekanntem Grund behaelt ihren genaueren Satz', async () => {
  const { friendlyError, REFUSAL_MESSAGES } = await load();
  for (const [reason, key] of [
    ['module_read_only', 'settings.permReadOnlyBanner'],
    ['module_access_denied', 'common.errorModuleNoAccess'],
    ['task_locked', 'tasks.errorLocked'],
    ['recipe_mirrored', 'recipes.errorMirrored'],
    ['csrf_invalid', 'common.errorFormExpired'],
  ]) {
    assert.equal(REFUSAL_MESSAGES.get(reason), key);
    // So kommt der Fehler aus api.js: message und data.error tragen schon den Satz.
    assert.equal(friendlyError({ status: 403, message: key, data: { error: key, code: 403, reason } }), key, reason);
    // Und so von einem Aufrufer, der den Rumpf des Servers unveraendert weiterreicht.
    assert.equal(friendlyError({ status: 403, message: 'Server sentence.', data: { error: 'Server sentence.', reason } }), key, reason);
  }
});

test('ein unbekannter Grund reicht nie den Satz des Servers durch', async () => {
  const { friendlyError } = await load();
  for (const reason of ['some_future_reason', 'cross_module_access', '__proto__', 'constructor', 'toString', '', 7, null]) {
    const text = 'A sentence this client has never seen.';
    assert.equal(
      friendlyError({ status: 403, message: text, data: { error: text, code: 403, reason } }),
      'common.errorNoPermission', String(reason),
    );
  }
  // Der Grund zaehlt nur an einer Absage: derselbe an einem anderen Status aendert nichts.
  assert.equal(friendlyError({ status: 404, data: { reason: 'task_locked' } }), 'common.errorNotFound');
  assert.equal(friendlyError({ status: 500, data: { reason: 'module_read_only' } }), 'common.errorServer');
});

test('den zweiten Wortlaut gibt es in keiner Sprache mehr, den einen in jeder', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26, `zu wenige Sprachdateien gelesen (${files.length})`);
  for (const name of files) {
    const { common } = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(common.errorForbidden, undefined, `${name}: common.errorForbidden steht noch da`);
    assert.equal(typeof common.errorNoPermission, 'string', `${name}: common.errorNoPermission fehlt`);
    // Der alte Satz riet zur Anmeldung - der eine tut es nicht.
    if (name === 'de.json') assert.doesNotMatch(common.errorNoPermission, /anmelden/i);
    if (name === 'en.json') assert.doesNotMatch(common.errorNoPermission, /sign in/i);
  }
});

test('die uebrigen Zuordnungen bleiben, wie sie waren', async () => {
  const { friendlyError } = await load();
  assert.equal(friendlyError({ status: 0 }), 'common.errorOfflineMutation');
  assert.equal(friendlyError({ status: 503, data: { reason: 'restore_in_progress' } }), 'common.errorRestoreInProgress');
  assert.equal(friendlyError({ status: 404 }), 'common.errorNotFound');
  assert.equal(friendlyError({ status: 500 }), 'common.errorServer');
  assert.equal(friendlyError({ status: 503 }), 'common.errorServer');
  assert.equal(friendlyError({ name: 'AbortError' }), 'common.errorTimeout');
  assert.equal(friendlyError({ name: 'TimeoutError' }), 'common.errorTimeout');
  assert.equal(friendlyError(new TypeError('Failed to fetch')), 'common.errorServer');
  assert.equal(friendlyError(new TypeError('x is not a function')), 'common.unexpectedError');
  // Ein anderer 4xx reicht den Text des Servers durch.
  assert.equal(friendlyError({ status: 409, data: { error: 'Name is taken.' }, message: 'x' }), 'Name is taken.');
  assert.equal(friendlyError(new Error('Boom')), 'Boom');
  assert.equal(friendlyError(undefined), 'common.errorGeneric');
});

test('offline geht vor: ohne Netz ist auch eine 403 keine Absage', async () => {
  const { friendlyError } = await load();
  setOnline(false);
  assert.equal(friendlyError({ status: 403 }), 'common.errorOffline');
  assert.equal(friendlyError({ status: 0 }), 'common.errorOfflineMutation');
});

test('der Router reicht genau diese Funktion weiter und hat keine eigene', () => {
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{ friendlyError \} from '\/utils\/friendly-error\.js';/);
  assert.doesNotMatch(router, /function friendlyError\(/, 'router.js hat wieder eine eigene Zuordnung');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'/utils/friendly-error.js'"), 'das Modul fehlt in der Shell-Liste des Service Workers');
});
