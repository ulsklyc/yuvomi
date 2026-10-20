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

// Ein Fall mit Zahlen (CASE_PARAMS) bekommt sie in der Antwort mit; der
// Test-Loader haengt sie als JSON an den Schluessel. `withParams` baut die
// Antwort so, wie der Server sie schickt, `sentenceOf` den erwarteten Satz.
const SAMPLE = { limit_mb: 5, limit_kb: 100, limit: 5000, min: 60, max: 43200, status: 404 };
const paramsFor = (names) => Object.fromEntries(names.map((name) => [name, SAMPLE[name]]));
function withParams(err, CASE_PARAMS) {
  const names = CASE_PARAMS.get(err.data.reason);
  if (names) err.data.params = paramsFor(names);
  return err;
}
const sentenceOf = (reason, key, CASE_PARAMS) => (
  CASE_PARAMS.has(reason) ? `${key}${JSON.stringify(paramsFor(CASE_PARAMS.get(reason)))}` : key
);

test('errorSentence: ein bekannter Fall bekommt seinen Satz, an jedem Status', async () => {
  const { errorSentence, CASE_MESSAGES, CASE_PARAMS } = await load();
  assert.ok(CASE_MESSAGES.size >= 7, `nur ${CASE_MESSAGES.size} Faelle gelesen`);
  for (const [reason, key] of CASE_MESSAGES) {
    const sentence = sentenceOf(reason, key, CASE_PARAMS);
    for (const status of [400, 404, 409, 502]) {
      assert.equal(errorSentence(withParams(answer(status, SERVER_TEXT, reason), CASE_PARAMS)), sentence, `${reason} @${status}`);
      // Der Satz der Stelle gilt nur fuer das Unbekannte.
      assert.equal(errorSentence(withParams(answer(status, SERVER_TEXT, reason), CASE_PARAMS), 'shopping.duplicateError'), sentence, reason);
    }
  }
  // Der Fall aus dem Issue, ausgeschrieben.
  assert.equal(errorSentence(answer(400, 'Unknown list.', 'shopping_list_not_found')), 'shopping.errorListGone');
  assert.equal(errorSentence(answer(409, 'Category already exists.', 'category_exists')), 'category.errorExists');
});

test('errorSentence: unbekannter oder fehlender Grund ergibt den allgemeinen Satz, nie den des Servers', async () => {
  const { errorSentence } = await load();
  for (const status of [400, 404, 409, 422, 500, 502]) {
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

// 429 HAT EINEN EIGENEN SATZ (Critique 2026-10-16, Schritt 6). Vorher reichte
// friendlyError den Text der Bremse durch - "Too many requests. Please wait a
// moment." mitten in der deutschen Oberflaeche -, und errorSentence sagte den
// allgemeinen Satz, der verschweigt, dass Warten hilft. Ein Grund mit eigenem
// Satz (etwa install_rate_limited) bleibt bei diesem.
test('429: friendlyError und errorSentence sagen common.errorRateLimited, nie den Text des Servers', async () => {
  const { friendlyError, errorSentence, CASE_MESSAGES } = await load();
  for (const reason of [undefined, 'some_future_reason', '__proto__', 'constructor', '', 7, null, {}]) {
    const err = answer(429, 'Too many requests. Please wait a moment.', reason);
    assert.equal(friendlyError(err), 'common.errorRateLimited', String(reason));
    assert.equal(errorSentence(err), 'common.errorRateLimited', String(reason));
    assert.equal(errorSentence(err, 'shopping.sendListError'), 'common.errorRateLimited', String(reason));
  }
  for (const [reason, key] of CASE_MESSAGES) {
    if (reason !== 'install_rate_limited' && reason !== 'gravatar_rate_limited') continue;
    assert.equal(errorSentence(answer(429, SERVER_TEXT, reason)), key, reason);
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
  for (const status of [400, 401, 409, 422]) {
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
  const { friendlyError, errorSentence, CASE_MESSAGES, CASE_PARAMS, REFUSAL_MESSAGES } = await load();
  for (const [reason, key] of CASE_MESSAGES) {
    const sentence = sentenceOf(reason, key, CASE_PARAMS);
    for (const status of [400, 404, 409]) {
      const err = withParams(answer(status, SERVER_TEXT, reason), CASE_PARAMS);
      assert.equal(friendlyError(err), sentence, `friendlyError ${reason} @${status}`);
      assert.equal(errorSentence(err), sentence, `errorSentence ${reason} @${status}`);
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
  // Wer den Fall nennt: die Einkaufs-Routen, und fuer die Abfuhr Routen und
  // Dienste (die getypten Fehler und die Pruefungen der Domaene tragen den Grund
  // dort als letztes Argument). Dass eine ECHTE Antwort ihn traegt, misst
  // test:waste-routes je Grund.
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const wasteServer = [
    ...readdirSync(new URL('../server/routes/waste/', import.meta.url)).map((name) => `../server/routes/waste/${name}`),
    ...readdirSync(new URL('../server/services/', import.meta.url)).filter((name) => name.startsWith('waste-')).map((name) => `../server/services/${name}`),
  ].map(read).join('\n');
  // Ein Grund steht dort als `reason: '...'` oder als Argument eines getypten
  // Fehlers (danach `)` oder die Zahlen des Falls). Die Importgrenzen nennen
  // ihn ueber ihren eigenen Code: der Store baut `waste_import_<code>` daraus.
  const importCodes = [...read('../server/services/waste-import.js').matchAll(/new WasteImportError\([^\n]*?,\s*'([a-z_]+)'\s*[,)]/g)]
    .map((m) => `reason: 'waste_import_${m[1]}'`).join('\n');
  // Die Gesundheit nennt ihre Faelle in den Routen selbst; dass eine ECHTE
  // Antwort sie traegt, misst test:health-errors.
  const healthServer = readdirSync(new URL('../server/routes/health/', import.meta.url))
    .map((name) => read(`../server/routes/health/${name}`)).join('\n');
  // Die Dokumente ebenso, dazu Verknuepfen und Senden an ein DMS; dass eine
  // ECHTE Antwort sie traegt, misst test:documents-errors.
  const documentsServer = ['../server/routes/documents.js', '../server/routes/dms.js'].map(read).join('\n');
  // Die Rezepte ebenso, dazu das Einplanen eines Rezepts in den Essensplan;
  // dass eine ECHTE Antwort sie traegt, misst test:recipes-errors.
  const recipesServer = ['../server/routes/recipes.js', '../server/routes/meals.js'].map(read).join('\n');
  // Die Abos ebenso; dass eine ECHTE Antwort sie traegt, misst
  // test:subscriptions-errors.
  const subscriptionsServer = read('../server/routes/subscriptions.js');
  // Inventar, Notizen, Kontakte und Geburtstage ebenso (dazu die Dienste, die
  // den Grund an ihre Route zurueckgeben); dass eine ECHTE Antwort ihn traegt,
  // misst test:inventory-notes-errors.
  const restServer = [
    ...readdirSync(new URL('../server/routes/inventory/', import.meta.url)).map((name) => `../server/routes/inventory/${name}`),
    '../server/routes/notes.js', '../server/services/note-categories.js',
    '../server/routes/contacts.js', '../server/routes/birthdays.js',
    // Aufgaben (#1909); die echte Antwort misst test:tasks-errors, Teilaufgabe
    // und Kommentar test:task-detail-errors.
    '../server/routes/tasks.js',
    // Dienstplan (#1909); die echte Antwort misst test:task-detail-errors.
    '../server/routes/schedule.js', '../server/routes/schedule-extras.js',
    // Haushaltshilfe und Belohnungen (#1909); die echte Antwort messen
    // test:housekeeping-routes und test:rewards-routes.
    '../server/routes/housekeeping.js', '../server/routes/rewards.js',
    // Schnellzugriffe (#1909); die echte Antwort misst test:quick-links.
    '../server/routes/quick-links.js',
    // Rezeptdienste in den Kuechen-Einstellungen (#1909); die echte Antwort
    // misst test:recipe-provider-routes.
    '../server/routes/recipe-providers.js',
    // Der Fall eines gescheiterten Abgleichs (#1909, Migration 255); gespeichert
    // und ausgeliefert misst ihn test:recipe-provider-routes, je Klasse
    // test:recipe-provider-adapter am echten Server.
    '../server/services/recipe-providers/failure.js',
  ].map(read).join('\n').replace(/NoteCategoryInputError\([^)]*?,\s*\d+,\s*'([a-z_]+)'\)/g, "reason: '$1'");
  const routes = `${read('../server/routes/shopping.js')}\n${healthServer}\n${documentsServer}\n${recipesServer}\n${subscriptionsServer}\n${restServer}\n${wasteServer.replace(/,\s*'([a-z_]+)'\s*[),]/g, ", reason: '$1')")}\n${importCodes}`;
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
    'waste_mapping_not_found', 'waste_occurrence_not_found', 'waste_override_not_found', 'waste_pickup_not_found',
    'waste_schedule_not_found', 'waste_selected_type_not_found', 'waste_source_not_found', 'waste_type_not_found',
    'health_vital_not_found', 'health_medication_not_found', 'health_schedule_not_found', 'health_dose_not_found',
    'health_lab_report_not_found', 'health_lab_result_not_found', 'health_activity_not_found',
    'health_prevention_type_not_found', 'health_prevention_selected_type_not_found', 'health_prevention_record_not_found',
    'health_nutrition_entry_not_found', 'health_cycle_period_not_found', 'health_cycle_log_not_found',
    'documents_folder_not_found', 'documents_selected_folder_not_found', 'documents_document_not_found',
    'dms_account_not_found', 'dms_document_not_found',
    'recipes_recipe_not_found', 'recipes_ingredient_not_found', 'recipes_selected_pantry_item_not_found',
    'meals_selected_recipe_not_found',
    'subscriptions_subscription_not_found', 'subscriptions_category_not_found', 'subscriptions_payment_method_not_found',
    'subscriptions_selected_category_not_found', 'subscriptions_selected_payment_method_not_found',
    'inventory_item_not_found', 'inventory_tracked_date_not_found', 'inventory_selected_location_not_found',
    'inventory_booking_not_found', 'notes_note_not_found', 'notes_selected_category_not_found',
    'contacts_contact_not_found', 'birthdays_birthday_not_found',
    'contacts_selected_category_not_found', 'inventory_location_not_found', 'inventory_category_not_found',
    'tasks_task_not_found', 'tasks_parent_not_found', 'tasks_comment_not_found',
    'schedule_shift_type_not_found', 'schedule_custom_field_not_found', 'schedule_pattern_not_found',
    'schedule_override_not_found', 'schedule_extra_shift_not_found',
    'schedule_selected_shift_type_not_found', 'schedule_selected_custom_field_not_found',
    'housekeeping_worker_not_found', 'housekeeping_visit_not_found', 'housekeeping_task_not_found',
    'housekeeping_open_session_not_found',
    'rewards_reward_not_found', 'rewards_redemption_not_found',
    'rewards_money_account_not_found', 'rewards_money_plan_not_found',
    'quick_links_link_not_found',
    'recipe_providers_account_not_found',
  ].sort());
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

// #1909: loeschen, was schon geloescht ist, ist erledigt - aber nur mit dem
// Grund des Dings selbst.
test('isAlreadyDeleted: nur der genannte Grund, nie ein anderer, nie der blanke Status, nie eine Absage', async () => {
  const { isAlreadyDeleted, GONE_REASONS } = await load();
  for (const reason of GONE_REASONS) {
    assert.equal(isAlreadyDeleted(answer(404, SERVER_TEXT, reason), reason), true, reason);
    assert.equal(isAlreadyDeleted(answer(403, SERVER_TEXT, reason), reason), false, `${reason} @403`);
    for (const other of GONE_REASONS) {
      if (other !== reason) assert.equal(isAlreadyDeleted(answer(404, SERVER_TEXT, other), reason), false, `${other} ist nicht ${reason}`);
    }
  }
  // Ein Grund ausserhalb der Allowlist zaehlt auch dann nicht, wenn der Aufrufer ihn nennt.
  assert.equal(isAlreadyDeleted(answer(404, SERVER_TEXT, 'some_future_not_found'), 'some_future_not_found'), false);
  for (const err of [
    answer(404, SERVER_TEXT), answer(500, SERVER_TEXT), { status: 0 }, new Error('shopping_item_not_found'), undefined, null,
  ]) {
    assert.equal(isAlreadyDeleted(err, 'shopping_item_not_found'), false);
  }
  assert.equal(isAlreadyDeleted(answer(404, SERVER_TEXT), undefined), false, 'ohne Grund auf beiden Seiten');
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

// #1909, Abfuhr: zwei Saetze nennen eine Grenze als Zahl, weil der Fehler sie
// nicht strukturiert mitgibt. Die Zahl im Satz ist damit eine zweite Fassung
// der Grenze am Server - sie steht hier gegen dessen Konstanten, in jeder
// Sprache und in westlichen Ziffern.
test('die Grenzen in den Abfuhr-Saetzen sind die des Servers', async () => {
  const { WEEKLY_INTERVAL_MAX, MONTHLY_INTERVAL_MAX } = await import('../server/services/waste-domain.js');
  const reminders = readFileSync(new URL('../server/services/waste-reminders.js', import.meta.url), 'utf8');
  const bound = (name) => Number(reminders.match(new RegExp(`export const ${name} = (\\d+);`))[1]);
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26);
  const numbers = (text) => (text.match(/\d+/g) ?? []).map(Number);
  for (const name of files) {
    const waste = JSON.parse(readFileSync(new URL(name, dir), 'utf8')).waste;
    assert.deepEqual(numbers(waste.errorScheduleInterval), [1, WEEKLY_INTERVAL_MAX, 1, MONTHLY_INTERVAL_MAX], `${name}: errorScheduleInterval`);
    assert.deepEqual(numbers(waste.errorScheduleMonthDay), [1, 31], `${name}: errorScheduleMonthDay`);
    assert.deepEqual(numbers(waste.errorReminderOffset), [bound('MIN_OFFSET_DAYS'), bound('MAX_OFFSET_DAYS')], `${name}: errorReminderOffset`);
  }
});

// ---------------------------------------------------------------------------
// #1909, Zahlen im Satz: wo die Ursache eine Zahl traegt (Grenze in MB, Anzahl,
// Status der Gegenstelle), gibt der Server sie strukturiert mit (`params`), und
// der Satz setzt sie ein. Aus der Antwort kommt NUR, was CASE_PARAMS fuer den
// Fall freigibt, und nur als ganze Zahl.
// ---------------------------------------------------------------------------

const withData = (reason, params, extra = {}) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status: 400, data: { error: SERVER_TEXT, code: 400, reason, ...(params === undefined ? {} : { params }), ...extra },
});

test('errorSentence: die Zahl der Ursache kommt in den Satz, und nur die freigegebene', async () => {
  const { errorSentence, friendlyError } = await load();
  assert.equal(errorSentence(withData('waste_import_file_too_large', { limit_mb: 12 })), 'waste.errorImportTooLarge{"limit_mb":12}');
  assert.equal(errorSentence(withData('waste_source_interval_invalid', { min: 60, max: 43200 })), 'waste.errorSourceInterval{"min":60,"max":43200}');
  assert.equal(errorSentence(withData('waste_source_fetch_http_status', { status: 404 })), 'waste.errorSourceFetchStatus{"status":404}');
  assert.equal(errorSentence(withData('waste_import_event_cap_exceeded', { limit: 0 })), 'waste.errorImportTooManyEvents{"limit":0}', 'die Null ist eine Zahl');

  // Was der Server sonst mitschickt, kommt nicht in den Satz: weder ein
  // weiteres Feld in `params` noch eines daneben, auch nicht unter dem Namen
  // eines Platzhalters.
  const noisy = withData('waste_import_file_too_large',
    { limit_mb: 5, limit: 99, name: '<img src=x>', error: SERVER_TEXT, __proto__: { status: 1 } }, { limit_mb: 77, status: 500 });
  assert.equal(errorSentence(noisy), 'waste.errorImportTooLarge{"limit_mb":5}');
  assert.equal(friendlyError(noisy), 'waste.errorImportTooLarge{"limit_mb":5}', 'der Uebergangsweg sagt dasselbe');

  // Ein Fall OHNE Zahlen setzt nie etwas ein, auch wenn die Antwort welche traegt.
  assert.equal(errorSentence(withData('waste_source_fetch_blocked', { status: 404, limit_mb: 5 })), 'waste.errorSourceFetchBlocked');
  assert.equal(errorSentence(withData('shopping_list_not_found', { name: 'x' })), 'shopping.errorListGone');
});

test('errorSentence: fehlt die Zahl oder ist sie keine, gilt der allgemeine Satz der Stelle - nie ein Satz mit Luecke, nie der Text des Servers', async () => {
  const { errorSentence, friendlyError } = await load();
  const inherited = Object.create({ limit_mb: 5 });
  for (const params of [
    undefined, null, {}, [], [5], 'limit_mb', 5, { limit: 5 }, inherited,
    { limit_mb: '5' }, { limit_mb: '<b>5</b>' }, { limit_mb: 5.5 }, { limit_mb: -1 }, { limit_mb: NaN }, { limit_mb: Infinity },
    { limit_mb: 1e12 }, { limit_mb: null }, { limit_mb: true }, { limit_mb: { valueOf: () => 5 } }, { limit_mb: [5] },
  ]) {
    const err = withData('waste_import_file_too_large', params);
    assert.equal(errorSentence(err), 'common.errorGeneric', JSON.stringify(params));
    assert.equal(errorSentence(err, 'common.unknownError'), 'common.unknownError', JSON.stringify(params));
  }
  // Von zwei Zahlen fehlt eine: kein halber Satz.
  assert.equal(errorSentence(withData('waste_source_interval_invalid', { min: 60 })), 'common.errorGeneric');
  assert.equal(errorSentence(withData('waste_source_interval_invalid', { min: 60, max: 'viel' })), 'common.errorGeneric');
  // friendlyError (Uebergang) faellt dann auf seinen eigenen Rest, den Text des
  // Servers - wie vor #1909 und wie fuer jeden unbekannten Grund.
  assert.equal(friendlyError(withData('waste_import_file_too_large', {})), SERVER_TEXT);
});

test('errorSentence: eine Absage und Offline setzen keine Zahlen ein, auch mit einem Grund aus CASE_PARAMS', async () => {
  const { errorSentence } = await load();
  const refused = withData('waste_import_file_too_large', { limit_mb: 5 });
  refused.status = 403;
  assert.equal(errorSentence(refused), 'common.errorNoPermission');
  const offline = withData('waste_import_file_too_large', { limit_mb: 5 });
  offline.status = 0;
  assert.equal(errorSentence(offline), 'common.errorOfflineMutation');
});

test('CASE_PARAMS: jeder Eintrag gehoert zu einem Fall, kein Name waehlt die Pluralform, und der Server schickt genau diese Namen', async () => {
  const { CASE_PARAMS, CASE_MESSAGES } = await load();
  assert.ok(CASE_PARAMS.size >= 7);
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const server = ['../server/services/waste-import.js', '../server/services/waste-url-source.js', '../server/routes/waste/sources.js',
    '../server/routes/health/cycle.js', '../server/routes/documents.js', '../server/routes/contacts.js'].map(read).join('\n');
  for (const [reason, names] of CASE_PARAMS) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: Zahlen ohne Satz`);
    assert.ok(Array.isArray(names) && names.length > 0, reason);
    for (const name of names) {
      assert.match(name, /^[a-z_]+$/, `${reason}: ${name}`);
      assert.notEqual(name, 'count', `${reason}: \`count\` waehlt in t() die Pluralform`);
      // Der Name steht am Server als Feld eines `params`-Objekts (`{ limit_mb: ...`,
      // `{ status: ...`, `{ min: ..., max: ...`). Dass eine ECHTE Antwort ihn
      // traegt, misst test:waste-routes und test:health-errors je Grund.
      assert.match(server, new RegExp(`[{,]\\s*${name}:`), `${reason}: kein Server schickt ${name}`);
    }
  }
});

// Der Satz und die Liste muessen dieselben Namen tragen, in JEDER Sprache: ein
// Platzhalter, den CASE_PARAMS nicht freigibt, bliebe als `{{name}}` stehen;
// ein freigegebener, den der Satz nicht nennt, verschwiege die Zahl.
test('die Platzhalter jedes Satzes sind in jeder Sprache genau die freigegebenen Zahlen', async () => {
  const { CASE_PARAMS, CASE_MESSAGES } = await load();
  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 26);
  let checked = 0;
  for (const name of files) {
    const locale = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    for (const [reason, key] of CASE_MESSAGES) {
      const [section, leaf] = key.split('.');
      const text = locale[section][leaf];
      const used = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(used, [...(CASE_PARAMS.get(reason) ?? [])].sort(), `${name}: ${key} (${reason})`);
      // Die Zahl kommt vom Server, nie ein zweites Mal als Ziffern im Satz -
      // ausser in den Saetzen aus Scheibe A, die test 'die Grenzen in den
      // Abfuhr-Saetzen' gegen die Konstanten haelt.
      if (CASE_PARAMS.has(reason)) assert.doesNotMatch(text.replace(/\{\{\w+\}\}/g, ''), /\d/, `${name}: ${key} nennt eine Zahl neben dem Platzhalter`);
      checked += 1;
    }
  }
  assert.equal(checked, files.length * CASE_MESSAGES.size);
});
