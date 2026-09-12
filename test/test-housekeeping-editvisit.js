/**
 * Modul: Housekeeping - `?editVisit=<id>` Deep-Link-Fehlerbehandlung (#1139)
 * Zweck: Vorher verschwand jeder Fehler beim Nachladen der Ziel-Besuchsanfrage
 *        in einem leeren `catch` - eine geloeschte, ungueltige oder fremde ID
 *        sah fuer die Person genauso aus wie ein erfolgreicher Link. Dieser
 *        Test deckt die Fehler-Klassifizierung ab - jeder 4xx (404 fehlt, 403
 *        kein Zugriff, 400 z.B. eine verstuemmelte ID) ist ein Endzustand ohne
 *        Retry, nur ein Server-/Netzwerkfehler darf es erneut versuchen - und
 *        das Verhalten des Deep-Link-Handlers: Toast-Ton, Retry-Angebot, dass
 *        ein 4xx nie die rohe unlokalisierte Servermeldung durchreicht, und
 *        dass die gescheiterte ID sofort aus der URL entfernt wird, damit ein
 *        erneutes Rendern (Reload, Zurueck-Navigation) den Aufruf nicht
 *        wiederholt.
 *
 *        Der Erfolgsfall (`openVisitEditModal`) haengt am geteilten
 *        Modal-System (`openModal`), das ein echtes DOM braucht - wie schon
 *        bei anderen Modal-Fluessen in diesem Repo (siehe `test-modal-utils.js`)
 *        ist das kein Ziel fuer einen DOM-losen Unit-Test, sondern Sache der
 *        Browser-Verifikation.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-housekeeping-editvisit.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? {};
const toastCalls = [];
globalThis.window.yuvomi = {
  showToast: (...args) => toastCalls.push(args),
  friendlyError: (err) => {
    if (err?.status === 404) return 'Der Eintrag wurde nicht gefunden.';
    if (err?.status === 403) return 'Zugriff verweigert.';
    return 'Es ist ein Fehler aufgetreten.';
  },
};

const replaceStateCalls = [];
globalThis.history = { replaceState: (...args) => replaceStateCalls.push(args) };
globalThis.location = { pathname: '/housekeeping', search: '?editVisit=42' };

const { __test: hk } = await import('../public/pages/housekeeping.js');
const { describeDeepLinkError, openVisitFromDeepLink } = hk;

function apiError(status, message = `HTTP ${status}`) {
  const err = new Error(message);
  err.name = 'ApiError';
  err.status = status;
  return err;
}

test('describeDeepLinkError: 404 ist ein Endzustand - kein Retry', () => {
  const { message, offerRetry } = describeDeepLinkError(apiError(404));
  assert.equal(message, 'Der Eintrag wurde nicht gefunden.');
  assert.equal(offerRetry, false);
});

test('describeDeepLinkError: 403 ist ein Endzustand - kein Retry, keine Besuchsdetails', () => {
  const { message, offerRetry } = describeDeepLinkError(apiError(403));
  assert.equal(message, 'Zugriff verweigert.');
  assert.equal(offerRetry, false);
  assert.ok(!message.includes('42'), 'die ID darf nicht in der Meldung auftauchen');
});

test('describeDeepLinkError: eine ungueltige ID (400) ist ein Endzustand - kein Retry, keine rohe Servermeldung', () => {
  const err = apiError(400, 'id must be a positive integer');
  err.data = { error: 'id must be a positive integer', code: 400 };
  const { message, offerRetry } = describeDeepLinkError(err);
  assert.equal(offerRetry, false);
  assert.equal(message, 'common.errorGeneric');
  assert.ok(!message.includes('positive integer'), 'die rohe, unlokalisierte Servermeldung darf nicht durchgereicht werden');
});

test('describeDeepLinkError: Serverfehler darf erneut versucht werden', () => {
  const { offerRetry } = describeDeepLinkError(apiError(500));
  assert.equal(offerRetry, true);
});

test('describeDeepLinkError: Netzwerkfehler (kein status) darf erneut versucht werden', () => {
  const { offerRetry } = describeDeepLinkError(new Error('Failed to fetch'));
  assert.equal(offerRetry, true);
});

test('openVisitFromDeepLink: fehlende Besuchs-ID (404) zeigt Meldung ohne Retry und raeumt die URL', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  globalThis.__apiStub = { get: async () => { throw apiError(404); } };

  await openVisitFromDeepLink('999', { querySelector: () => null });

  assert.equal(replaceStateCalls.length, 1);
  assert.deepEqual(replaceStateCalls[0], [null, '', '/housekeeping']);
  assert.equal(toastCalls.length, 1);
  const [message, type, duration, action] = toastCalls[0];
  assert.equal(message, 'Der Eintrag wurde nicht gefunden.');
  assert.equal(type, 'danger');
  assert.equal(duration, undefined);
  assert.equal(action, undefined);
});

test('openVisitFromDeepLink: fremder Besuch (403) zeigt Meldung ohne Retry, keine Besuchsdetails im Toast', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  globalThis.__apiStub = { get: async () => { throw apiError(403); } };

  await openVisitFromDeepLink('7', { querySelector: () => null });

  assert.equal(replaceStateCalls.length, 1);
  assert.equal(toastCalls.length, 1);
  const [message, , , action] = toastCalls[0];
  assert.equal(message, 'Zugriff verweigert.');
  assert.equal(action, undefined);
});

test('openVisitFromDeepLink: eine ungueltige ID (400) zeigt eine generische Meldung ohne Retry und raeumt die URL', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  globalThis.__apiStub = {
    get: async () => {
      const err = apiError(400, 'id must be a positive integer');
      err.data = { error: 'id must be a positive integer', code: 400 };
      throw err;
    },
  };

  await openVisitFromDeepLink('not-a-number', { querySelector: () => null });

  assert.equal(replaceStateCalls.length, 1);
  assert.equal(toastCalls.length, 1);
  const [message, type, duration, action] = toastCalls[0];
  assert.equal(message, 'common.errorGeneric');
  assert.equal(type, 'danger');
  assert.equal(duration, undefined);
  assert.equal(action, undefined);
});

test('openVisitFromDeepLink: anderer Fehler bietet ein Retry an, das dieselbe ID erneut abruft', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  let getCalls = 0;
  let lastPath = null;
  globalThis.__apiStub = {
    get: async (path) => {
      getCalls += 1;
      lastPath = path;
      throw apiError(500);
    },
  };

  await openVisitFromDeepLink('13', { querySelector: () => null });

  assert.equal(getCalls, 1);
  assert.equal(lastPath, '/housekeeping/visits/13');
  assert.equal(toastCalls.length, 1);
  const [message, type, duration, action] = toastCalls[0];
  assert.equal(message, 'Es ist ein Fehler aufgetreten.');
  assert.equal(type, 'danger');
  assert.equal(duration, 6000);
  assert.equal(typeof action.onClick, 'function');

  // Der Retry-Klick fasst dieselbe ID an, ohne dass sie noch aus der URL
  // kommen muss (die URL wurde beim ersten Fehlschlag schon bereinigt).
  await action.onClick();
  assert.equal(getCalls, 2);
  assert.equal(lastPath, '/housekeeping/visits/13');
});

test('openVisitFromDeepLink: erfolgreiche Antwort zeigt keinen Toast und raeumt die URL nicht auf', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  let modalOpened = false;
  globalThis.__apiStub = {
    get: async () => ({ data: null }), // keine Visit-Nutzlast -> kein Modal-Aufruf, kein echtes DOM noetig
  };
  const container = { querySelector: () => { modalOpened = true; return null; } };

  await openVisitFromDeepLink('21', container);

  assert.equal(modalOpened, false, 'ohne Visit-Daten wird kein Modal-Inhalt gesucht');
  assert.equal(replaceStateCalls.length, 0);
  assert.equal(toastCalls.length, 0);
});
