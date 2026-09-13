/**
 * Modul: Housekeeping - `?editVisit=<id>` Deep-Link-Fehlerbehandlung (#1139)
 * Zweck: Vorher verschwand jeder Fehler beim Nachladen der Ziel-Besuchsanfrage
 *        in einem leeren `catch` - eine geloeschte, ungueltige oder fremde ID
 *        sah fuer die Person genauso aus wie ein erfolgreicher Link. Dieser
 *        Test deckt die Fehler-Klassifizierung ab - jeder 4xx ausser 429 (404
 *        fehlt, 403 kein Zugriff, 400 z.B. eine verstuemmelte ID) ist ein
 *        Endzustand ohne Retry; 429 (geteilter Rate-Limiter pro IP) darf es
 *        wie ein Server-/Netzwerkfehler erneut versuchen - und das Verhalten
 *        des Deep-Link-Handlers: Toast-Ton, Retry-Angebot, dass ein 4xx nie
 *        die rohe unlokalisierte Servermeldung durchreicht, dass nur der
 *        `editVisit`-Parameter aus der URL entfernt wird (uebrige Parameter,
 *        Hash und `history.state` bleiben), damit ein erneutes Rendern
 *        (Reload, Zurueck-Navigation) den Aufruf nicht wiederholt, und dass
 *        ein vom Router abgebrochenes Signal (Seitenwechsel) URL-Bereinigung,
 *        Toast und Retry stilllegt.
 *
 *        Die 403-/404-Meldungstexte kommen aus dem lokalen `friendlyError`-
 *        Stub unten - die echte Zuordnung im Router (`common.errorForbidden`/
 *        `common.errorNotFound`/`common.errorServer`) wird hier NICHT
 *        mitgeprueft.
 *
 *        Der Erfolgsfall verzweigt seit #1170 nach `visit.can_edit` zwischen
 *        Bearbeiten- und Berichtsmodal (#1135: wer einen abgerechneten Besuch
 *        nicht aendern darf, bekommt kein Formular, das erst beim Speichern
 *        scheitert). `test-browser-loader.mjs`s `openModal`-Stub reicht seine
 *        Argumente an `globalThis.__openModal` durch (dasselbe Muster wie
 *        `promptModal`/`confirmOverModal`), deshalb laesst sich die Verzweigung
 *        hier direkt pruefen, ohne dass ein echtes DOM noetig waere.
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

const openModalCalls = [];
globalThis.__openModal = (...args) => openModalCalls.push(args);
// `openVisitEditModal` liest `document.querySelector('.modal-panel')` direkt
// nach dem (gestubbten) `openModal()`-Aufruf, um Nebenverdrahtung anzuschliessen
// (Stundenrechner, Beleg-Datei-Input) - ohne echtes Panel bleibt das `null`.
globalThis.document = globalThis.document ?? { querySelector: () => null };

const replaceStateCalls = [];
// Die URL traegt absichtlich MEHR als den Deep-Link (einen weiteren Parameter,
// einen Hash) und `history.state` ist gesetzt: die Bereinigung darf nur
// `editVisit` entfernen und muss alles andere stehen lassen.
const historyState = { path: '/housekeeping' };
globalThis.history = { state: historyState, replaceState: (...args) => replaceStateCalls.push(args) };
globalThis.location = {
  pathname: '/housekeeping',
  search: '?tab=staff&editVisit=42',
  hash: '#reports',
  href: 'https://yuvomi.test/housekeeping?tab=staff&editVisit=42#reports',
};

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

test('describeDeepLinkError: 429 (Rate-Limit) darf erneut versucht werden - generische Meldung', () => {
  // Der apiLimiter zaehlt pro IP, ein Haushalt hinter einem NAT teilt sich
  // eine - ein 429 ist kein Endzustand fuer diese ID, ein Retry kann gelingen.
  const err = apiError(429, 'Too many requests');
  err.data = { error: 'Too many requests', code: 429 };
  const { message, offerRetry } = describeDeepLinkError(err);
  assert.equal(offerRetry, true);
  assert.equal(message, 'common.errorGeneric');
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
  // Chirurgisch, nicht alles: nur `editVisit` faellt weg, der andere Parameter,
  // der Hash und der Router-State (`history.state`) ueberleben die Bereinigung.
  assert.deepEqual(replaceStateCalls[0], [historyState, '', '/housekeeping?tab=staff#reports']);
  assert.equal(replaceStateCalls[0][0], historyState);
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

test('openVisitFromDeepLink: 429 (Rate-Limit) bietet ein Retry an, das dieselbe ID erneut abruft', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  let getCalls = 0;
  globalThis.__apiStub = {
    get: async () => {
      getCalls += 1;
      const err = apiError(429, 'Too many requests');
      err.data = { error: 'Too many requests', code: 429 };
      throw err;
    },
  };

  await openVisitFromDeepLink('13', { querySelector: () => null });

  assert.equal(replaceStateCalls.length, 1);
  assert.equal(toastCalls.length, 1);
  const [message, type, duration, action] = toastCalls[0];
  assert.equal(message, 'common.errorGeneric', 'keine rohe Servermeldung, kein friendlyError-Fallback');
  assert.equal(type, 'danger');
  assert.equal(duration, 6000);
  assert.equal(typeof action?.onClick, 'function', '429 ist voruebergehend und muss ein Retry anbieten');

  await action.onClick();
  assert.equal(getCalls, 2);
});

test('openVisitFromDeepLink: Fehler nach Seitenwechsel (Signal abgebrochen) - keine URL-Bereinigung, kein Toast', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  const signal = { aborted: false };
  globalThis.__apiStub = {
    get: async () => {
      // Der Router bricht das Signal ab, WAEHREND der Abruf noch laeuft - die
      // Antwort kommt erst danach. `location`/`history` gehoeren dann schon
      // der naechsten Seite.
      signal.aborted = true;
      throw apiError(500);
    },
  };

  await openVisitFromDeepLink('13', { querySelector: () => null }, signal);

  assert.equal(replaceStateCalls.length, 0, 'kein replaceState gegen die URL der naechsten Seite');
  assert.equal(toastCalls.length, 0, 'kein Toast ueber der falschen Seite');
});

test('openVisitFromDeepLink: Retry-Klick nach Seitenwechsel (Signal abgebrochen) ruft nichts mehr ab', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  let getCalls = 0;
  const signal = { aborted: false };
  globalThis.__apiStub = {
    get: async () => {
      getCalls += 1;
      throw apiError(500);
    },
  };

  await openVisitFromDeepLink('13', { querySelector: () => null }, signal);
  assert.equal(toastCalls.length, 1);
  const [, , , action] = toastCalls[0];

  // Der Retry-Toast lebt bis zu 6 s - laenger als mancher Seitenwechsel.
  signal.aborted = true;
  await action.onClick();
  assert.equal(getCalls, 1, 'nach dem Abbruch darf der Klick keinen zweiten Abruf starten');
  assert.equal(toastCalls.length, 1, 'und keinen weiteren Toast ausloesen');
});

test('openVisitFromDeepLink: Antwort nach Seitenwechsel (Signal abgebrochen) oeffnet kein Modal', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  let modalLookup = false;
  const signal = { aborted: false };
  globalThis.__apiStub = {
    get: async () => {
      signal.aborted = true;
      return { data: { id: 21 } };
    },
  };
  const container = { querySelector: () => { modalLookup = true; return null; } };

  await openVisitFromDeepLink('21', container, signal);

  assert.equal(modalLookup, false, 'das Bearbeiten-Modal darf nicht ueber einer fremden Seite aufgehen');
  assert.equal(toastCalls.length, 0);
});

test('openVisitFromDeepLink: leere Antwort (kein Visit-Payload) zeigt keinen Toast und raeumt die URL nicht auf', async () => {
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

test('openVisitFromDeepLink: can_edit=true oeffnet das Bearbeiten-Modal', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  openModalCalls.length = 0;
  hk.state().workers = [{ id: 7, display_name: 'Maria' }];
  globalThis.__apiStub = {
    get: async () => ({
      data: {
        id: 21, worker_id: 7, can_edit: true, rate_type: 'daily',
        check_in: '2026-09-12T10:00:00Z', daily_rate: 50, extras: 0,
      },
    }),
  };

  await openVisitFromDeepLink('21', { querySelector: () => null });

  assert.equal(openModalCalls.length, 1);
  assert.equal(openModalCalls[0][0].title, 'housekeeping.editVisit');
  assert.equal(toastCalls.length, 0);
});

test('openVisitFromDeepLink: can_edit=false oeffnet den Berichtsmodal statt eines scheiternden Formulars (#1135)', async () => {
  toastCalls.length = 0;
  replaceStateCalls.length = 0;
  openModalCalls.length = 0;
  globalThis.__apiStub = {
    get: async () => ({
      data: {
        id: 22, worker_id: 7, can_edit: false, paid_at: '2026-09-12T10:00:00Z',
        check_in: '2026-09-12T10:00:00Z', daily_rate: 50, extras: 0, total_amount: 50,
        can_mark_paid: false, can_mark_unpaid: false,
      },
    }),
  };

  await openVisitFromDeepLink('22', { querySelector: () => null });

  assert.equal(openModalCalls.length, 1);
  assert.equal(openModalCalls[0][0].title, 'housekeeping.visitReportDetails');
  assert.equal(toastCalls.length, 0);
});
