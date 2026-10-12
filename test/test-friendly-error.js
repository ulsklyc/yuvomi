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
  // Ein anderer 4xx reicht den Text des Servers durch (Uebergang, siehe unten).
  assert.equal(friendlyError({ status: 409, data: { error: 'Name is taken.' }, message: 'x' }), 'Name is taken.');
  // Ein Wurf der App selbst (kein Status, kein Rumpf) behaelt seinen Text.
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

// ---------------------------------------------------------------------------
// #1909: der Server benennt den Fall, die App besitzt den Satz - auch jenseits
// der 403. Bis dahin endete friendlyError bei `err.data.error`, und die Seiten
// zeigten `err.data?.error ?? t(...)`: "Unbekannte Liste." in jeder Sprache.
// ---------------------------------------------------------------------------

// Wie der Fehler aus api.js kommt: `message` und `data.error` tragen den Text des Servers.
const answer = (status, error, reason) => Object.assign(new Error(error), {
  name: 'ApiError', status, data: { error, code: status, ...(reason === undefined ? {} : { reason }) },
});
const SERVER_TEXT = 'Ein Satz des Servers, den kein Nutzer lesen soll.';

test('errorSentence: ein bekannter Fall bekommt seinen Satz, an jedem Status', async () => {
  const { errorSentence, CASE_MESSAGES } = await load();
  assert.ok(CASE_MESSAGES.size >= 7, `nur ${CASE_MESSAGES.size} Faelle gelesen`);
  for (const [reason, key] of CASE_MESSAGES) {
    for (const status of [400, 404, 409]) {
      assert.equal(errorSentence(answer(status, SERVER_TEXT, reason)), key, `${reason} @${status}`);
      // Der Satz der Stelle gilt nur fuer das Unbekannte.
      assert.equal(errorSentence(answer(status, SERVER_TEXT, reason), 'shopping.duplicateError'), key, reason);
    }
  }
  // Der Fall aus dem Issue, ausgeschrieben.
  assert.equal(errorSentence(answer(400, 'Unknown list.', 'shopping_list_not_found')), 'shopping.errorListGone');
  assert.equal(errorSentence(answer(409, 'Category already exists.', 'category_exists')), 'category.errorExists');
});

test('errorSentence: unbekannter oder fehlender Grund ergibt den allgemeinen Satz, nie den des Servers', async () => {
  const { errorSentence } = await load();
  for (const status of [400, 404, 409, 422, 429, 500, 502]) {
    for (const reason of [undefined, 'some_future_reason', '__proto__', 'constructor', 'toString', '', 7, null, {}]) {
      const err = answer(status, SERVER_TEXT, reason);
      assert.equal(errorSentence(err), 'common.errorGeneric', `${status} ${String(reason)}`);
      assert.equal(errorSentence(err, 'shopping.sendListError'), 'shopping.sendListError', `${status} ${String(reason)}`);
    }
  }
  // Auch ohne Rumpf, ohne Status und bei einem Wurf der App: nie dessen Text.
  assert.equal(errorSentence(new Error(SERVER_TEXT)), 'common.errorGeneric');
  assert.equal(errorSentence({ data: { error: SERVER_TEXT } }), 'common.errorGeneric');
  assert.equal(errorSentence(undefined), 'common.errorGeneric');
  assert.equal(errorSentence(null, 'common.unknownError'), 'common.unknownError');
});

test('errorSentence: Absage, Offline und Restore sagen dasselbe wie friendlyError', async () => {
  const { errorSentence, friendlyError, REFUSAL_MESSAGES } = await load();
  for (const [reason, key] of REFUSAL_MESSAGES) {
    assert.equal(errorSentence(answer(403, SERVER_TEXT, reason)), key, reason);
  }
  // Eine Absage ohne Satz zu ihrem Grund: der eine allgemeine Satz der Absage.
  assert.equal(errorSentence(answer(403, SERVER_TEXT, 'cross_module_access'), 'shopping.duplicateError'), 'common.errorNoPermission');
  assert.equal(errorSentence(answer(403, SERVER_TEXT)), 'common.errorNoPermission');
  assert.equal(errorSentence({ status: 0 }), 'common.errorOfflineMutation');
  assert.equal(errorSentence(answer(503, SERVER_TEXT, 'restore_in_progress')), 'common.errorRestoreInProgress');
  // Der Grund einer Absage zaehlt nur an einer Absage, der eines Falls nicht an ihr.
  assert.equal(errorSentence(answer(404, SERVER_TEXT, 'task_locked')), 'common.errorGeneric');
  assert.equal(errorSentence(answer(403, SERVER_TEXT, 'shopping_list_not_found')), 'common.errorNoPermission');
  for (const err of [answer(403, SERVER_TEXT, 'task_locked'), answer(400, SERVER_TEXT, 'shopping_store_exists'), { status: 0 }]) {
    assert.equal(friendlyError(err), errorSentence(err));
  }
});

// UEBERGANG: #1916 hatte den letzten Rueckfall von friendlyError fuer ALLE
// Aufrufer auf den allgemeinen Satz verengt - auch fuer die, die noch nicht
// umgestellt sind (Kontakt-Import, Essensplan, Fehlerbildschirm, unbehandelte
// Rejection). Dort stand dann "Ein Fehler ist aufgetreten" statt der Ursache.
// Bis ein Modul umgestellt ist, sagt es nicht weniger als vorher: der strenge
// Weg ist errorSentence, friendlyError behaelt den Text des Servers.
test('friendlyError: ein Status ohne eigenen Satz behaelt den Text des Servers, errorSentence nie', async () => {
  const { friendlyError, errorSentence } = await load();
  for (const status of [400, 401, 409, 422, 429]) {
    for (const reason of [undefined, 'some_future_reason', '__proto__']) {
      const err = answer(status, SERVER_TEXT, reason);
      assert.equal(friendlyError(err), SERVER_TEXT, `friendlyError ${status} ${String(reason)}`);
      assert.equal(errorSentence(err), 'common.errorGeneric', `errorSentence ${status} ${String(reason)}`);
    }
  }
  // Die Ursachen, die der Kontakt-Import nennt (server/routes/contacts.js).
  const invalid = answer(400, 'Name is required. Telefon must not exceed 50 characters.');
  assert.equal(friendlyError(invalid), 'Name is required. Telefon must not exceed 50 characters.');
  assert.equal(errorSentence(invalid), 'common.errorGeneric');
  const taken = answer(409, 'This email address already belongs to another account.', 'email_in_use');
  assert.equal(friendlyError(taken), 'This email address already belongs to another account.');
  assert.equal(errorSentence(taken), 'common.errorGeneric');
  // `data.error` geht vor `message`; ohne Rumpf bleibt `message`, ohne beides der allgemeine Satz.
  assert.equal(friendlyError({ status: 409, data: { error: 'Name is taken.' }, message: 'x' }), 'Name is taken.');
  assert.equal(friendlyError({ status: 409, message: 'HTTP 409' }), 'HTTP 409');
  assert.equal(friendlyError({ data: { error: SERVER_TEXT } }), SERVER_TEXT);
  assert.equal(friendlyError({ status: 409, data: {} }), 'common.errorGeneric');
});

test('friendlyError und errorSentence: ein bekannter Fall bekommt ueber beide denselben Satz', async () => {
  const { friendlyError, errorSentence, CASE_MESSAGES, REFUSAL_MESSAGES } = await load();
  for (const [reason, key] of CASE_MESSAGES) {
    for (const status of [400, 404, 409]) {
      const err = answer(status, SERVER_TEXT, reason);
      assert.equal(friendlyError(err), key, `friendlyError ${reason} @${status}`);
      assert.equal(errorSentence(err), key, `errorSentence ${reason} @${status}`);
    }
  }
  for (const [reason, key] of REFUSAL_MESSAGES) {
    const err = answer(403, SERVER_TEXT, reason);
    assert.equal(friendlyError(err), key, reason);
    assert.equal(errorSentence(err), key, reason);
  }
  // Die Zuordnungen am Status gehen dem Text des Servers weiter vor.
  assert.equal(friendlyError(answer(403, SERVER_TEXT)), 'common.errorNoPermission');
  assert.equal(friendlyError(answer(403, SERVER_TEXT, 'some_future_reason')), 'common.errorNoPermission');
  assert.equal(friendlyError(answer(404, SERVER_TEXT)), 'common.errorNotFound');
  assert.equal(friendlyError(answer(500, SERVER_TEXT)), 'common.errorServer');
  assert.equal(friendlyError(answer(503, SERVER_TEXT, 'restore_in_progress')), 'common.errorRestoreInProgress');
});

test('jeder Fall hat seinen Satz in jeder Sprache, und der Server nennt ihn', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const routes = readFileSync(new URL('../server/routes/shopping.js', import.meta.url), 'utf8');
  return load().then(({ CASE_MESSAGES, REFUSAL_MESSAGES }) => {
    for (const [reason, key] of CASE_MESSAGES) {
      assert.equal(REFUSAL_MESSAGES.has(reason), false, `${reason} steht in beiden Listen`);
      assert.ok(routes.includes(`reason: '${reason}'`), `${reason}: kein Server nennt diesen Fall`);
      const [section, leaf] = key.split('.');
      for (const name of files) {
        const text = JSON.parse(readFileSync(new URL(name, dir), 'utf8'))[section]?.[leaf];
        assert.equal(typeof text, 'string', `${name}: ${key} fehlt`);
        assert.doesNotMatch(text, /[\u2013\u2014]/, `${name}: ${key} traegt einen Gedankenstrich`);
      }
    }
  });
});

// #1909: die Gruende, bei denen die Seite selbst nachlaedt. Eine Allowlist -
// und sie haelt mit CASE_MESSAGES Schritt, in beide Richtungen.
test('isGone: nur die bekannten "gibt es nicht mehr"-Gruende, nie der blanke Status', async () => {
  const { isGone, GONE_REASONS, CASE_MESSAGES } = await load();
  assert.deepEqual([...GONE_REASONS].sort(), [
    'shopping_category_not_found', 'shopping_item_not_found', 'shopping_list_not_found', 'shopping_store_not_found',
  ]);
  for (const reason of GONE_REASONS) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: ohne Satz`);
    for (const status of [400, 404]) assert.equal(isGone(answer(status, SERVER_TEXT, reason)), true, `${reason} @${status}`);
    // Der Grund einer Absage zaehlt nur an einer Absage.
    assert.equal(isGone(answer(403, SERVER_TEXT, reason)), false, `${reason} @403`);
    assert.equal(isGone({ response: { status: 403 }, data: { reason } }), false);
  }
  // Jeder Fall, der "nicht gefunden" heisst, laedt nach - ein neuer, der hier
  // fehlt, liesse den Nutzer mit einem veralteten Stand und ohne Rat zurueck.
  for (const reason of CASE_MESSAGES.keys()) {
    assert.equal(GONE_REASONS.has(reason), reason.endsWith('_not_found'), reason);
  }
  for (const err of [
    answer(404, SERVER_TEXT), answer(404, SERVER_TEXT, 'some_future_not_found'), answer(404, SERVER_TEXT, '__proto__'),
    answer(409, SERVER_TEXT, 'shopping_store_exists'), answer(500, SERVER_TEXT), { status: 0 },
    new Error('shopping_item_not_found'), undefined, null,
  ]) {
    assert.equal(isGone(err), false);
  }
});

// EIN RAT IN EINER FEHLERMELDUNG IST CODE (#1909): wo die Seite selbst
// nachlaedt, darf der Satz nicht mehr dazu raten. Gemessen wird die Regel,
// nicht eine Schreibweise von "neu laden" in 26 Sprachen: der Satz ist EINE
// Aussage - ein Satzende, und es steht am Schluss, kein angehaengter Teilsatz.
// Die alte Fassung war in jeder Sprache "Aussage. Rat." (zh: "Aussage, Rat.").
test('ein Fall, bei dem die Seite selbst nachlaedt, sagt in jeder Sprache nur, was passiert ist', async () => {
  const { GONE_REASONS, CASE_MESSAGES } = await load();
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26);
  let checked = 0;
  for (const reason of GONE_REASONS) {
    const [section, leaf] = CASE_MESSAGES.get(reason).split('.');
    for (const name of files) {
      const text = JSON.parse(readFileSync(new URL(name, dir), 'utf8'))[section][leaf];
      const ends = text.match(/[.!?\u3002\u0964\u061F\uFF01\uFF1F]/g) ?? [];
      assert.equal(ends.length, 1, `${name}: ${section}.${leaf} ist mehr als ein Satz: ${text}`);
      assert.match(text, /[.\u3002\u0964]$/, `${name}: ${section}.${leaf} endet nicht mit seinem Satzende`);
      assert.doesNotMatch(text, /[,;:\u3001\uFF0C\uFF1B\uFF1A\u060C\u061B]/, `${name}: ${section}.${leaf} haengt einen Teilsatz an: ${text}`);
      checked += 1;
    }
  }
  assert.equal(checked, GONE_REASONS.size * files.length);
});
