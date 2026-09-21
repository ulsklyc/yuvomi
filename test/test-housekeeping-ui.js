/**
 * Modul: Housekeeping-Oberflaeche - Besuchsaktionen je Recht (#1135) und
 *        Monatsnavigation im Berichte-Tab (#1137)
 * Zweck: Laedt die echte Seite (public/pages/housekeeping.js) ueber den
 *        Browser-Loader und prueft das gerenderte Markup gegen einen Container
 *        ohne DOM.
 *
 *        #1135: Bearbeiten und Loeschen haengen an den Serverfeldern `can_edit`
 *        und `can_delete`. Die Fixtures tragen die Felder so, wie der Server sie
 *        fuer Admin und Mitglied liefert (test-housekeeping-routes.js prueft die
 *        Server-Seite): ein bezahlter Besuch ist fuer das Mitglied gesperrt, fuer
 *        den Admin nicht, ein unbezahlter fuer beide offen.
 *
 *        #1137: Der gewaehlte Monat ist Seitenzustand. Geprueft wird der Schritt
 *        (Anfrage mit `?month=`, Summen, Leerzustand), dass ein Neuladen nach einer
 *        Aktion den Monat behaelt, dass eine ueberholte Antwort nichts
 *        ueberschreibt, dass ein Fehler den Monat zuruecksetzt, und dass das
 *        Monatslabel der Sprache folgt.
 *
 *        #1174: Ob Schritt oder Neuladen gilt, entscheidet der Start des
 *        Abrufs - ein gescheiterter Schritt verwirft das Neuladen nach dem
 *        Bezahlen nicht, und ein vor der Aktion gestarteter Schritt
 *        ueberschreibt es nicht. Wendet ein Neuladen seinen Bericht an, folgt
 *        der Stepper dessen Monat - ausser ein spaeter gestarteter Schritt
 *        laeuft noch.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-housekeeping-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? {};
const toasts = [];
globalThis.window.yuvomi = { showToast: (...args) => toasts.push(args) };

const { __test: hk } = await import('../public/pages/housekeeping.js');

function fakeContainer() {
  return {
    html: '',
    isConnected: true,
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, markup) { this.html += markup; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const count = (html, needle) => html.split(needle).length - 1;

// ---------------------------------------------------------------------------
// #1135: Aktionen je Besuch
// ---------------------------------------------------------------------------

// So liefert der Server die Felder (visitCapabilities in server/routes/housekeeping.js).
const asMember = (visit) => ({ ...visit, can_edit: !visit.paid_at, can_delete: !visit.paid_at, can_mark_paid: !visit.paid_at });
const asAdmin = (visit) => ({ ...visit, can_edit: true, can_delete: true, can_mark_paid: !visit.paid_at });
// Housekeeping nur zum Lesen: der Server bietet nichts an.
const asReader = (visit) => ({ ...visit, can_edit: false, can_delete: false, can_mark_paid: false });
const paidVisit = { id: 11, check_in: '2026-08-04T09:00:00.000Z', total_amount: 60, paid_at: '2026-08-05T10:00:00Z' };
const openVisit = { id: 12, check_in: '2026-08-06T09:00:00.000Z', total_amount: 40, paid_at: null };

function staffLogHtml(visits) {
  const state = hk.state();
  state.workers = [{ id: 7, display_name: 'Ana' }];
  state.selectedStaffId = '7';
  state.staffVisits = visits;
  return hk.renderStaffVisitLog();
}

test('Mitglied: bezahlter Besuch ohne Bearbeiten/Loeschen, mit Bericht und Grund; unbezahlter mit beidem', () => {
  const html = staffLogHtml([asMember(paidVisit), asMember(openVisit)]);
  const [paidRow, openRow] = html.split('<article').slice(1);

  assert.equal(count(paidRow, 'data-edit-visit='), 0, 'kein Bearbeiten am bezahlten Besuch');
  assert.equal(count(paidRow, 'data-delete-visit='), 0, 'kein Loeschen am bezahlten Besuch');
  assert.equal(count(paidRow, 'data-open-visit="11"'), 1, 'der Weg zum Bericht bleibt');
  assert.match(paidRow, /housekeeping\.settledAdminOnly/, 'die Zeile sagt, warum');

  assert.equal(count(openRow, 'data-edit-visit="12"'), 1);
  assert.equal(count(openRow, 'data-delete-visit="12"'), 1);
  assert.equal(count(openRow, 'data-open-visit='), 0);
  assert.doesNotMatch(openRow, /housekeeping\.settledAdminOnly/);
});

test('Admin: bezahlter und unbezahlter Besuch behalten Bearbeiten und Loeschen', () => {
  const html = staffLogHtml([asAdmin(paidVisit), asAdmin(openVisit)]);
  assert.equal(count(html, 'data-edit-visit='), 2);
  assert.equal(count(html, 'data-delete-visit='), 2);
  assert.equal(count(html, 'data-open-visit='), 0);
  assert.doesNotMatch(html, /housekeeping\.settledAdminOnly/);
});

test('nur lesend: der unbezahlte Besuch bietet kein Bezahlen an, auch kein gesperrtes (#1265 P6)', () => {
  // Hier stand bis #1265 ein `disabled`-Knopf mit der Beschriftung „Als bezahlt
  // markieren" - ein Versprechen fuer eine Beruehrung, die nichts tut. Ohne
  // `can_mark_paid` hat ein UNBEZAHLTER Besuch nichts, was ein Knopf sagen
  // koennte: „ausstehend" steht in der Metazeile. Die Rechte-Seite derselben
  // Regel (`housekeeping: read` im Rechte-Store, auch bei veralteten Feldern)
  // misst test-module-readonly-ui.js.
  const html = staffLogHtml([asReader(openVisit)]);
  assert.equal(count(html, 'data-pay-visit='), 0, 'kein Bezahlen, weder offen noch gesperrt');
  assert.equal(count(html, 'data-edit-visit='), 0);
  assert.equal(count(html, 'data-open-visit="12"'), 1, 'der Weg zum Bericht bleibt');
  assert.match(html, /housekeeping\.paymentPending/, 'der Zahlstatus steht in der Metazeile');
  const member = staffLogHtml([asMember(openVisit)]);
  assert.match(member, /data-pay-visit="12"/, 'mit Schreibrecht bleibt Bezahlen');
  assert.doesNotMatch(member, /data-pay-visit="12" disabled/, 'und zwar offen');
});

test('ohne Serverfelder bietet die Zeile nichts an, was scheitern koennte', () => {
  // Ein aelterer Server ohne die Felder: lieber lesen als ein 403 beim Speichern.
  const html = staffLogHtml([{ ...openVisit }]);
  assert.equal(count(html, 'data-edit-visit='), 0);
  assert.equal(count(html, 'data-delete-visit='), 0);
  assert.equal(count(html, 'data-open-visit="12"'), 1);
});

// ---------------------------------------------------------------------------
// #1137: Monatsnavigation
// ---------------------------------------------------------------------------

const REPORTS = {
  '2026-09': { month: '2026-09', visits: [{ ...openVisit, id: 21, check_in: '2026-09-02T09:00:00.000Z' }], totals: { total: 40, paid: 0, pending: 40 } },
  '2026-08': { month: '2026-08', visits: [asMember(paidVisit), asMember(openVisit)], totals: { total: 100, paid: 60, pending: 40 } },
  '2026-07': { month: '2026-07', visits: [], totals: { total: 0, paid: 0, pending: 0 } },
};

const requests = [];
function installApi({ onMonth } = {}) {
  requests.length = 0;
  globalThis.__apiStub = {
    get: async (url) => {
      requests.push(url);
      if (url === '/housekeeping/visits') return { data: REPORTS['2026-09'] };
      const month = url.match(/^\/housekeeping\/visits\?month=(\d{4}-\d{2})$/)?.[1];
      if (month) return onMonth ? onMonth(month) : { data: REPORTS[month] ?? { month, visits: [], totals: {} } };
      return { data: null };
    },
  };
}

async function freshReports() {
  installApi();
  const state = hk.state();
  state.reportMonth = null;
  state.tab = 'reports';
  await hk.loadData();
  const content = fakeContainer();
  hk.renderReports(content);
  return content;
}

test('Startzustand: laufender Monat, Reset verborgen', async () => {
  const content = await freshReports();
  assert.match(content.html, /id="housekeeping-report-month">September 2026</);
  assert.match(content.html, /id="housekeeping-report-current" hidden>/, 'Reset im laufenden Monat verborgen');
  assert.ok(content.html.indexOf('housekeeping-report-prev') < content.html.indexOf('housekeeping-report-month')
    && content.html.indexOf('housekeeping-report-month') < content.html.indexOf('housekeeping-report-next')
    && content.html.indexOf('housekeeping-report-next') < content.html.indexOf('id="housekeeping-report-current"'),
  'Reihenfolge: zurueck, Monat, vor, Reset');
  assert.equal(requests.filter((u) => u.includes('?month=')).length, 0, 'ohne Wahl kein Monatsparameter');
});

test('die Besuchs-Kachel im Berichte-Tab behauptet keinen laufenden Monat', async () => {
  const content = await freshReports();
  assert.match(content.html, /housekeeping\.reportVisitsCount/);
  assert.doesNotMatch(content.html, /housekeeping\.visitsThisMonth/);
});

test('ein Neuladen nach einer Aktion ueberschreibt einen inzwischen gewaehlten Monat nicht', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);                 // August gewaehlt
  let releaseReload;
  installApi({
    onMonth: (month) => (month === '2026-08'
      ? new Promise((resolve) => { releaseReload = () => resolve({ data: REPORTS[month] }); })
      : { data: REPORTS[month] }),
  });
  const reload = hk.loadData();                          // Aktion im August, Antwort haengt
  await new Promise((resolve) => setImmediate(resolve));
  await hk.stepReportMonth(content, -1);                 // derweil Juli
  releaseReload();
  await reload;
  assert.equal(hk.state().visitReport.month, '2026-07', 'der alte Neulade-Bericht bleibt verworfen');
  assert.equal(hk.state().reportMonth, '2026-07');
});

test('Schritt zurueck laedt den Vormonat mit seinen Summen und zeigt den Reset', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  assert.equal(requests.at(-1), '/housekeeping/visits?month=2026-08');
  assert.match(content.html, /id="housekeeping-report-month">August 2026</);
  assert.equal(count(content.html, 'housekeeping-report-item--visit'), 2, 'beide Besuche des August');
  assert.doesNotMatch(content.html, /id="housekeeping-report-current" hidden>/);
  assert.equal(hk.state().visitReport.totals.paid, 60);
});

test('leerer frueherer Monat: eigener Leerzustand mit dem Monatsnamen', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  await hk.stepReportMonth(content, -1);
  assert.equal(requests.at(-1), '/housekeeping/visits?month=2026-07');
  // esc() macht aus den Anfuehrungszeichen des i18n-Stubs &quot;.
  assert.match(content.html, /housekeeping\.noVisitReportsInMonth\{&quot;month&quot;:&quot;Juli 2026&quot;\}/);
  assert.doesNotMatch(content.html, /housekeeping\.noVisitReports</, 'nicht der Satz fuer den laufenden Monat');
});

test('Neuladen nach einer Aktion behaelt den gewaehlten Monat', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  requests.length = 0;
  // Genau das tut jede Aktion der Seite (Bezahlen, Bearbeiten): loadData(), dann rendern.
  await hk.loadData();
  hk.renderReports(content);
  assert.ok(requests.includes('/housekeeping/visits?month=2026-08'), 'loadData fragt den gewaehlten Monat an');
  assert.match(content.html, /id="housekeeping-report-month">August 2026</);
  assert.equal(hk.state().recentVisits[0].id, 21, 'die Uebersicht bleibt beim laufenden Monat');
});

test('zurueck zum laufenden Monat raeumt die Wahl', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  await hk.showReportMonth(content, '2026-09');
  assert.equal(hk.state().reportMonth, null);
  requests.length = 0;
  await hk.loadData();
  assert.equal(requests.filter((u) => u.includes('?month=')).length, 0);
});

test('eine ueberholte Antwort ueberschreibt den spaeteren Monat nicht', async () => {
  const content = await freshReports();
  const pending = {};
  installApi({ onMonth: (month) => new Promise((resolve) => { pending[month] = () => resolve({ data: REPORTS[month] }); }) });
  const first = hk.stepReportMonth(content, -1);   // August
  const second = hk.stepReportMonth(content, -1);  // Juli, vom August aus
  assert.equal(hk.state().reportMonth, '2026-07', 'zwei schnelle Schritte gehen zwei Monate');
  pending['2026-07']();
  await second;
  pending['2026-08']();
  await first;
  assert.equal(hk.state().visitReport.month, '2026-07');
  assert.match(content.html, /id="housekeeping-report-month">Juli 2026</);
});

test('ein Fehler setzt den Monat zurueck und meldet ihn', async () => {
  const content = await freshReports();
  toasts.length = 0;
  installApi({ onMonth: () => { throw new Error('offline'); } });
  await hk.stepReportMonth(content, -1);
  assert.equal(hk.state().reportMonth, null);
  assert.equal(hk.state().visitReport.month, '2026-09');
  assert.deepEqual(toasts.at(-1), ['offline', 'danger']);
});

test('scheitert der zweite von zwei schnellen Schritten, gilt wieder der angezeigte Monat', async () => {
  const content = await freshReports();
  toasts.length = 0;
  let releaseAugust;
  installApi({
    onMonth: (month) => (month === '2026-08'
      ? new Promise((resolve) => { releaseAugust = () => resolve({ data: REPORTS[month] }); })
      : Promise.reject(new Error('offline'))),
  });
  const first = hk.stepReportMonth(content, -1);   // August, haengt
  await hk.stepReportMonth(content, -1);           // Juli, scheitert
  assert.equal(hk.state().visitReport.month, '2026-09', 'angezeigt ist noch September');
  assert.equal(hk.state().reportMonth, null, 'der Stepper steht wieder auf dem angezeigten Monat, nicht auf August');
  releaseAugust();
  await first;
  assert.equal(hk.state().visitReport.month, '2026-09', 'die ueberholte August-Antwort bleibt verworfen');
  installApi();
  await hk.stepReportMonth(content, -1);
  assert.equal(requests.at(-1), '/housekeeping/visits?month=2026-08', 'der naechste Schritt geht vom angezeigten Monat aus');
});

test('ein gescheiterter Schritt verwirft das Neuladen einer Aktion nicht (#1174)', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);                 // August gewaehlt und angezeigt
  toasts.length = 0;
  const augustPaid = { ...REPORTS['2026-08'], totals: { total: 100, paid: 100, pending: 0 } };
  let releaseReload;
  installApi({
    onMonth: (month) => (month === '2026-08'
      ? new Promise((resolve) => { releaseReload = () => resolve({ data: augustPaid }); })
      : Promise.reject(new Error('offline'))),
  });
  const reload = hk.loadData();                          // Bezahlen im August, Antwort haengt
  await new Promise((resolve) => setImmediate(resolve));
  await hk.stepReportMonth(content, -1);                 // derweil Juli, scheitert
  assert.equal(hk.state().reportMonth, '2026-08', 'der Stepper steht wieder auf dem angezeigten August');
  releaseReload();
  await reload;
  assert.equal(hk.state().visitReport.month, '2026-08');
  assert.equal(hk.state().visitReport.totals.paid, 100, 'der August-Bericht traegt die Zahlung');
});

test('eine vor der Aktion gestartete Monatsantwort ueberschreibt das spaetere Neuladen nicht (#1174)', async () => {
  const content = await freshReports();
  const augustBefore = REPORTS['2026-08'];
  const augustPaid = { ...augustBefore, totals: { total: 100, paid: 100, pending: 0 } };
  let releaseStep;
  let stepStarted = false;
  installApi({
    onMonth: (month) => {
      if (month !== '2026-08') return { data: REPORTS[month] };
      if (!stepStarted) {
        stepStarted = true;
        return new Promise((resolve) => { releaseStep = () => resolve({ data: augustBefore }); });
      }
      return { data: augustPaid };
    },
  });
  const step = hk.stepReportMonth(content, -1);          // August angefragt, Antwort haengt
  await hk.loadData();                                   // eine Aktion laedt danach nach und kommt zuerst an
  assert.equal(hk.state().visitReport.totals.paid, 100);
  releaseStep();                                         // jetzt erst die aeltere Antwort
  await step;
  assert.equal(hk.state().visitReport.month, '2026-08');
  assert.equal(hk.state().visitReport.totals.paid, 100, 'der Stand von vor der Aktion bleibt verworfen');
  assert.match(content.html, /id="housekeeping-report-month">August 2026</, 'der Schritt rendert trotzdem');
});

test('kommt nach einem gescheiterten Schritt ein Neuladen mit anderem Monat an, rechnet der Stepper von dessen Monat (#1174)', async () => {
  const content = await freshReports();                  // September angezeigt
  toasts.length = 0;
  const releases = [];
  installApi({
    onMonth: (month) => (month === '2026-08'
      ? new Promise((resolve) => { releases.push(() => resolve({ data: REPORTS[month] })); })
      : Promise.reject(new Error('offline'))),
  });
  const first = hk.stepReportMonth(content, -1);         // August, haengt
  const reload = hk.loadData();                          // Bezahlen, laedt den gewaehlten August nach
  await new Promise((resolve) => setImmediate(resolve));
  await hk.stepReportMonth(content, -1);                 // derweil Juli, scheitert
  assert.equal(hk.state().reportMonth, null, 'zurueck auf den noch angezeigten September');
  releases[1]();                                         // das Neuladen kommt an
  await reload;
  assert.equal(hk.state().visitReport.month, '2026-08');
  assert.equal(hk.state().reportMonth, '2026-08', 'der Stepper folgt dem angezeigten August');
  releases[0]();                                         // der ueberholte erste Schritt
  await first;
  installApi();
  await hk.stepReportMonth(content, -1);
  assert.equal(requests.at(-1), '/housekeeping/visits?month=2026-07', 'zurueck geht es zum Juli, nicht erneut zum August');
});

test('ein Neuladen, das vor einem spaeter gestarteten Schritt ankommt, nimmt ihm den Monat nicht (#1174)', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);                 // August angezeigt
  let releaseReload;
  let releaseJuly;
  installApi({
    onMonth: (month) => new Promise((resolve) => {
      const answer = () => resolve({ data: REPORTS[month] });
      if (month === '2026-08') releaseReload = answer;
      else releaseJuly = answer;
    }),
  });
  const reload = hk.loadData();                          // Aktion im August
  await new Promise((resolve) => setImmediate(resolve));
  const step = hk.stepReportMonth(content, -1);          // danach Juli, haengt
  releaseReload();
  await reload;
  assert.equal(hk.state().reportMonth, '2026-07', 'der laufende Schritt behaelt seinen Monat');
  releaseJuly();
  await step;
  assert.equal(hk.state().visitReport.month, '2026-07');
  assert.equal(hk.state().reportMonth, '2026-07');
});

test('das Monatslabel folgt der Sprache', async () => {
  try {
    globalThis.__locale = 'fr';
    const content = await freshReports();
    await hk.stepReportMonth(content, -1);
    assert.match(content.html, /id="housekeeping-report-month">août 2026</);
    globalThis.__locale = 'ja';
    hk.renderReports(content);
    assert.match(content.html, /id="housekeeping-report-month">2026年8月</);
  } finally {
    delete globalThis.__locale;
  }
});

test('shiftMonth ueber Jahresgrenzen', () => {
  assert.equal(hk.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(hk.shiftMonth('2025-12', 1), '2026-01');
  assert.equal(hk.shiftMonth('2026-03', -14), '2025-01');
});
