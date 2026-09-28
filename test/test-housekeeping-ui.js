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

function fakeNode() {
  return {
    html: '',
    hidden: true,
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, markup) { this.html += markup; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/**
 * Der Inhalt eines Tabs samt dem Zeitraum-Slot im Kopf seiner Seite
 * (`#housekeeping-period`, Critique 2026-09-26): der Monats-Stepper steht
 * dort, nicht mehr im Inhalt. `content.period.html` ist, was im Kopf steht.
 */
function fakeContainer() {
  const period = fakeNode();
  const page = { querySelector: (sel) => (sel === '#housekeeping-period' ? period : null) };
  return {
    ...fakeNode(),
    isConnected: true,
    period,
    closest: (sel) => (sel === '.housekeeping-page' ? page : null),
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
  const head = content.period.html;
  assert.match(head, /id="housekeeping-report-month">September 2026</);
  // `.is-current` + `inert` wie Budget und Kalender (#1200), nicht `hidden`:
  // der Reset behaelt seinen Platz, und der Weiter-Pfeil ruckt nicht.
  assert.match(head, /class="btn btn--secondary housekeeping-month-nav__current is-current" type="button"\s+id="housekeeping-report-current" inert>/,
    'Reset im laufenden Monat verborgen, sein Platz bleibt');
  assert.ok(head.indexOf('housekeeping-report-prev') < head.indexOf('housekeeping-report-month')
    && head.indexOf('housekeeping-report-month') < head.indexOf('housekeeping-report-next')
    && head.indexOf('housekeeping-report-next') < head.indexOf('id="housekeeping-report-current"'),
  'Reihenfolge: zurueck, Monat, vor, Reset');
  assert.equal(requests.filter((u) => u.includes('?month=')).length, 0, 'ohne Wahl kein Monatsparameter');
});

test('der Monats-Stepper steht im Kopf, nicht im Inhalt (Critique 2026-09-26)', async () => {
  const content = await freshReports();
  assert.equal(content.period.hidden, false, 'im Berichte-Tab ist der Zeitraum-Slot sichtbar');
  assert.match(content.period.html, /id="housekeeping-report-prev"/);
  assert.doesNotMatch(content.html, /housekeeping-report-(prev|next|month|current)/,
    'in der Karte scrollte der Monat mit der Kennzahl-Zeile weg');
  hk.state().tab = 'tasks';
  hk.syncReportPeriod(content);
  assert.equal(content.period.hidden, true, 'auf anderen Tabs ist der Slot verborgen');
  assert.equal(content.period.html, '', 'und leer');
  hk.state().tab = 'reports';
});

test('die Besuchszeile ist eine list-row mit Bezahlen als row-action - kein beschrifteter Knopf in eigener Zeile', async () => {
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  const rows = content.html.split('<article').slice(1).filter((row) => row.includes('housekeeping-report-item'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row, /^ class="list-row /, 'Zeile in der Listengrammatik');
  const offen = rows.find((row) => row.includes('data-pay-report'));
  assert.ok(offen, 'der offene Besuch bietet Bezahlen an');
  assert.match(offen, /<button class="row-action" type="button" data-pay-report="12"\s+aria-label="housekeeping\.markPaid: /);
  assert.doesNotMatch(offen, /btn--secondary/, 'kein beschrifteter Knopf mehr in der Zeile');
  assert.match(content.html, /class="housekeeping-reports row-carrier"/);
  assert.doesNotMatch(content.html, /metric-card--inset/, 'dieselben Kennzahlkarten wie die Uebersicht');
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
  assert.match(content.period.html, /id="housekeeping-report-month">August 2026</);
  assert.equal(count(content.html, 'housekeeping-report-item--visit'), 2, 'beide Besuche des August');
  assert.doesNotMatch(content.period.html, /is-current|inert/, 'der Reset ist da, sobald ein anderer Monat steht');
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
  assert.match(content.period.html, /id="housekeeping-report-month">August 2026</);
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
  assert.match(content.period.html, /id="housekeeping-report-month">Juli 2026</);
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
  assert.match(content.period.html, /id="housekeeping-report-month">August 2026</, 'der Schritt rendert trotzdem');
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
    assert.match(content.period.html, /id="housekeeping-report-month">août 2026</);
    globalThis.__locale = 'ja';
    hk.renderReports(content);
    assert.match(content.period.html, /id="housekeeping-report-month">2026年8月</);
  } finally {
    delete globalThis.__locale;
  }
});

test('shiftMonth ueber Jahresgrenzen', () => {
  assert.equal(hk.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(hk.shiftMonth('2025-12', 1), '2026-01');
  assert.equal(hk.shiftMonth('2026-03', -14), '2025-01');
});

// Desktop-Kopf auf dem Referenzmass (Critique 2026-09-26, R1-Folge): die
// Reiterleiste trug am Desktop die Kuechenhoehe (56px) um 44px-Reiter, der
// Kopf stand bei 133px statt wie Budget (gleiche Bauart: Titelzeile + Reiter)
// bei 121. Am Desktop baut die Leiste so hoch wie ihre Reiter; mobil bleibt sie.
test('die Reiterleiste der Haushaltshilfe baut am Desktop nicht die Kuechenhoehe', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/housekeeping.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)].filter((r) => r.selector.trim() === '.housekeeping-tabs' && /(^|[\s;])height:/.test(r.body));
  const heightOf = (r) => r.body.match(/(?:^|[\s;])height:\s*([^;]+);/)?.[1].trim();
  const base = rules.find((r) => r.at.length === 0);
  assert.match(heightOf(base) ?? '', /--kitchen-tabs-height/, 'mobil bleibt die Leiste auf der Touch-Hoehe');
  const desktop = rules.filter((r) => r.at.some((a) => /min-width:\s*1024px/.test(a)));
  assert.equal(desktop.length, 1, 'genau eine Desktop-Regel (min-width: 1024px) setzt die Hoehe der Leiste');
  assert.equal(heightOf(desktop[0]), 'auto', 'am Desktop baut die Leiste so hoch wie ihre Reiter');
});

// ---------------------------------------------------------------------------
// Review zu #1475: Rueckgaengig waehrend das Neuladen nach dem Erledigen laeuft
// ---------------------------------------------------------------------------

test('eine vor dem Rueckgaengig gestartete Neulade-Antwort ueberschreibt den zurueckgenommenen Stand nicht', async () => {
  const task = { id: 5, name: 'Bad', area: 'Bad', frequency_days: 7, last_completed: '2026-09-01T08:00:00Z' };
  const done = { ...task, last_completed: '2026-09-26T09:00:00Z' };
  const writes = [];
  let taskReads = 0;
  let releaseStale;
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/housekeeping/visits') return { data: REPORTS['2026-09'] };
      if (url === '/housekeeping/decay-tasks') {
        taskReads += 1;
        // Das Neuladen nach dem Erledigen haengt und liefert spaeter den
        // erledigten Stand; das Neuladen nach dem Rueckgaengig kommt sofort.
        if (taskReads === 1) return new Promise((resolve) => { releaseStale = () => resolve({ data: [done] }); });
        return { data: [task] };
      }
      return { data: null };
    },
    post: async (url) => { writes.push(['post', url]); return { data: null }; },
    patch: async (url, body) => { writes.push(['patch', url, body]); return { data: null }; },
  };
  toasts.length = 0;
  const state = hk.state();
  state.tab = 'tasks';
  state.tasks = [task];
  const content = fakeContainer();
  const completing = hk.completeTask(task, content, null);
  while (!releaseStale) await new Promise((resolve) => setImmediate(resolve));
  const undo = toasts.find((args) => typeof args[3] === 'function')?.[3];
  assert.ok(undo, 'der Erledigt-Toast traegt Rueckgaengig');
  await undo();
  assert.deepEqual(writes.at(-1), ['patch', '/housekeeping/decay-tasks/5', { last_completed: task.last_completed }]);
  assert.equal(state.tasks[0].last_completed, task.last_completed, 'nach dem Rueckgaengig steht der alte Zeitpunkt');
  releaseStale();                                        // jetzt erst die aeltere Antwort
  await completing;
  assert.equal(state.tasks[0].last_completed, task.last_completed,
    'die vor dem Rueckgaengig gestartete Antwort ist ueberholt und darf state.tasks nicht schreiben');
  delete globalThis.__apiStub;
});

test('scheitert das Neuladen nach dem Rueckgaengig, schreibt die davor gestartete Antwort trotzdem nicht', async () => {
  // Codex an #1476: bis hierhin galt eine aeltere Antwort, solange keine
  // juengere ANGEWANDT war. Scheitert die juengere, gewann die aeltere und
  // zeigte den erledigten Stand ueber dem erfolgreich zurueckgenommenen.
  const task = { id: 6, name: 'Kueche', area: 'Kueche', frequency_days: 7, last_completed: '2026-09-01T08:00:00Z' };
  const done = { ...task, last_completed: '2026-09-26T09:00:00Z' };
  let taskReads = 0;
  let releaseStale;
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/housekeeping/visits') return { data: REPORTS['2026-09'] };
      if (url === '/housekeeping/decay-tasks') {
        taskReads += 1;
        if (taskReads === 1) return new Promise((resolve) => { releaseStale = () => resolve({ data: [done] }); });
        throw new Error('offline');                      // das Neuladen nach dem Rueckgaengig scheitert
      }
      return { data: null };
    },
    post: async () => ({ data: null }),
    patch: async () => ({ data: null }),
  };
  toasts.length = 0;
  const state = hk.state();
  state.tab = 'tasks';
  state.tasks = [task];
  const content = fakeContainer();
  const completing = hk.completeTask(task, content, null);
  while (!releaseStale) await new Promise((resolve) => setImmediate(resolve));
  const undo = toasts.find((args) => typeof args[3] === 'function')?.[3];
  assert.ok(undo, 'der Erledigt-Toast traegt Rueckgaengig');
  await undo();
  assert.equal(state.tasks[0].last_completed, task.last_completed, 'Vorbedingung: der alte Zeitpunkt steht');
  releaseStale();
  await completing;
  assert.equal(state.tasks[0].last_completed, task.last_completed,
    'die vor dem Rueckgaengig gestartete Antwort ist ueberholt, auch wenn das juengere Neuladen scheitert');
  delete globalThis.__apiStub;
});

// ---------------------------------------------------------------------------
// R10 L10 (Re-Critique 2026-09-27, A3 P2-3, P2-4, P2-10): eine Besuchszeile,
// eine Faelligkeits-Grammatik, mobil Kennzahlen in einer Zeile und die Liste
// vor dem Diagramm.
// ---------------------------------------------------------------------------

const { readFileSync } = await import('node:fs');
const { eachRule } = await import('./css-rules.js');
const HK_STYLES = readFileSync(new URL('../public/styles/housekeeping.css', import.meta.url), 'utf8');

/** Name und Meta jeder Besuchszeile im Markup. */
function visitRows(html) {
  return html.split('<article').slice(1).filter((row) => /housekeeping-visit-row/.test(row)).map((row) => ({
    row,
    name: /list-row__name">([^<]*)</.exec(row)?.[1],
    meta: /list-row__meta">([^<]*)</.exec(row)?.[1],
  }));
}

function dashboardHtml({ lastVisit } = {}) {
  const state = hk.state();
  state.tab = 'dashboard';
  state.workers = [{ id: 7, display_name: 'Maria Silva', rate_type: 'daily', daily_rate: 45, payment_schedule: 'weekly' }];
  state.dashboard = { visits_this_month: 3, last_visit: lastVisit ? { check_in: lastVisit } : null, pending_tasks: 1, finished_tasks_this_month: 2, monthly_payments: [{ month: '2026-09', total: 90 }], pending_payments: 45 };
  state.recentVisits = [asAdmin({ ...openVisit, worker_name: 'Maria Silva' })];
  const content = fakeContainer();
  hk.renderDashboard(content);
  return content.html;
}

test('ein Besuch, eine Zeile: das Datum fuehrt, die Person steht im Meta - in Uebersicht, Berichten und Protokoll', async () => {
  const uebersicht = visitRows(dashboardHtml());
  assert.equal(uebersicht.length, 1, 'die Uebersicht zeigt ihren Besuch als Besuchszeile');
  assert.equal(uebersicht[0].name, openVisit.check_in, 'Uebersicht: das Datum ist der Name');
  assert.match(uebersicht[0].meta, /^Maria Silva · /, 'Uebersicht: die Person steht im Meta');

  installApi();
  const content = await freshReports();
  await hk.stepReportMonth(content, -1);
  const berichte = visitRows(content.html);
  assert.equal(berichte.length, 2, 'die Berichte bauen dieselbe Zeile');
  for (const { row, name, meta } of berichte) {
    assert.doesNotMatch(row, /housekeeping-avatar/, 'kein Avatar - zehnmal dasselbe Gesicht sagte nichts');
    assert.doesNotMatch(name, /Ana|Maria|housekeeping\.staff/, `Berichte: der Name ist das Datum, nicht die Person (${name})`);
    assert.match(meta, / · /, 'Berichte: Person, Betrag und Status im Meta');
    assert.match(row, /housekeeping-report-item--visit/, 'die Berichte-Klasse bleibt (Aktionsabstand, Zaehlung)');
  }

  const protokoll = visitRows(staffLogHtml([asAdmin(openVisit)]));
  assert.equal(protokoll.length, 1, 'das Personal-Protokoll baut dieselbe Zeile');
  assert.equal(protokoll[0].name, openVisit.check_in);
  assert.doesNotMatch(protokoll[0].meta, /Ana/, 'im Protokoll einer Person steht ihr Name nicht in jeder Zeile');
});

test('Uebersicht: die letzten Besuche stehen vor dem Zahlungsdiagramm', () => {
  const html = dashboardHtml();
  const liste = html.indexOf('housekeeping-staff-log-list');
  const diagramm = html.indexOf('class="housekeeping-chart"');
  assert.ok(liste > 0 && diagramm > 0, 'beide Abschnitte stehen da');
  assert.ok(liste < diagramm, 'mobil begannen die Besuche bei y760 hinter dem 252px-Diagramm');
});

test('Uebersicht: der letzte Besuch nennt im laufenden Jahr kein Jahr, in einem anderen schon', () => {
  const jahr = new Date().getFullYear();
  const vorher = globalThis.__formatDayMonth;
  globalThis.__formatDayMonth = (d) => `KURZ(${d})`;
  try {
    const wert = (html) => /metric-card__label">housekeeping\.lastVisit<\/div>\s*<div class="metric-card__value">([^<]*)</.exec(html)?.[1];
    assert.equal(wert(dashboardHtml({ lastVisit: `${jahr}-01-15T08:30:00Z` })), `KURZ(${jahr}-01-15T08:30:00Z)`,
      'im laufenden Jahr die Kurzform - sie passt in die Viertelzeile');
    assert.equal(wert(dashboardHtml({ lastVisit: `${jahr - 1}-12-20T08:30:00Z` })), `${jahr - 1}-12-20T08:30:00Z`,
      'aus einem anderen Jahr bleibt das volle Datum - dann ist das Jahr die Auskunft');
  } finally {
    globalThis.__formatDayMonth = vorher;
  }
});

// Codex P2 zu R10 L10: die Anzeige rechnet in die Haushaltszone, der
// Jahresvergleich nahm das Jahr des rohen UTC-Strings und das der Geraetezone.
// `<Jahr>-01-01T00:30Z` steht in New York am 31.12. des Vorjahrs - und verlor
// trotzdem sein Jahr; umgekehrt in Tokio.
test('Uebersicht: ob der letzte Besuch sein Jahr nennt, entscheidet die Haushaltszone wie die Anzeige', async () => {
  const { setDisplayTimeZone, _resetDisplayTimeZoneCache } = await import('../public/utils/timezone.js');
  const { todayKey } = await import('../public/utils/date.js');
  const vorher = globalThis.__formatDayMonth;
  globalThis.__formatDayMonth = (d) => `KURZ(${d})`;
  const wert = (html) => /metric-card__label">housekeeping\.lastVisit<\/div>\s*<div class="metric-card__value">([^<]*)</.exec(html)?.[1];
  try {
    setDisplayTimeZone('America/New_York');
    let jahr = Number(todayKey().slice(0, 4));
    const silvester = `${jahr}-01-01T00:30:00Z`;
    assert.equal(wert(dashboardHtml({ lastVisit: silvester })), silvester,
      'New York: der Besuch liegt am 31.12. des Vorjahrs - das Jahr bleibt stehen');

    setDisplayTimeZone('Asia/Tokyo');
    jahr = Number(todayKey().slice(0, 4));
    const neujahr = `${jahr - 1}-12-31T20:00:00Z`;
    assert.equal(wert(dashboardHtml({ lastVisit: neujahr })), `KURZ(${neujahr})`,
      'Tokio: derselbe Zeitpunkt ist dort schon der 1.1. des laufenden Jahres - Kurzform');
  } finally {
    globalThis.__formatDayMonth = vorher;
    setDisplayTimeZone(null);
    _resetDisplayTimeZoneCache();
  }
});

test('Faelligkeit spricht als Tinte am Wort, nicht als Waesche der Zeile (wie die Aufgaben)', () => {
  const rules = [...eachRule(HK_STYLES)];
  const waesche = rules.filter((r) => /housekeeping-task--(?:today|overdue)/.test(r.selector)
    && /background(?:-color)?\s*:/.test(r.body));
  assert.deepEqual(waesche.map((r) => r.selector.trim()), [], 'keine Zeilentoenung fuer heute/ueberfaellig');
  for (const [zustand, farbe] of [['overdue', 'danger'], ['today', 'warning']]) {
    const tinte = rules.find((r) => r.selector.trim() === `.housekeeping-task--${zustand} .housekeeping-task__status`);
    assert.match(tinte?.body ?? '', new RegExp(`color:\\s*var\\(--color-${farbe}\\)`), `${zustand}: das Wort traegt die Farbe`);
  }
});

test('die vier Kennzahlen stehen auf jeder Breite in einer Zeile, schmal mit Labels an Wortgrenzen', () => {
  const rules = [...eachRule(HK_STYLES)];
  const quad = rules.filter((r) => /metric-grid--quad/.test(r.selector));
  const zeile = quad.find((r) => !r.at.length && r.selector.trim() === '.housekeeping-content .metric-grid--quad');
  assert.match(zeile?.body ?? '', /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    'vier Spalten, unbedingt - und spezifischer als die Telefonstufe in panel.css');
  assert.deepEqual(quad.filter((r) => /--summary-cards:\s*2/.test(r.body)).map((r) => r.at.join(' ')), [],
    'keine Zwei-mal-zwei-Stufe mehr (189px mobil)');
  const label = rules.find((r) => r.selector.trim() === '.metric-grid--quad .metric-card__label'
    && r.at.includes('@container housekeeping-page (max-width: 479px)'));
  assert.match(label?.body ?? '', /text-transform:\s*none/, 'Versal brach in der Viertelzeile mitten im Wort');
  assert.match(label?.body ?? '', /hyphens:\s*auto/);
});

// Re-Critique 2026-09-28 (P5, A3 P2-3 / A8 P2-3): die Uebersicht mit
// Kennzahlen, Besuchen und Zahlungen stand im 720px-Lesemass einer Textseite
// und liess bei 1440 rund 470px leer - Besuche und Zahlungen untereinander.
test('Uebersicht am Desktop: Besuche | Zahlungen nebeneinander, sobald die Spalte reicht, ausserhalb des Lesemasses', () => {
  const html = dashboardHtml({ lastVisit: '2026-09-20T08:30:00Z' });
  const cols = /<div class="housekeeping-dashboard-columns">([\s\S]*)<\/div>\s*$/.exec(html.trim());
  assert.ok(cols, 'die beiden Karten stehen in EINEM Spaltentraeger');
  assert.match(cols[1], /housekeeping\.recentVisits[\s\S]*housekeeping\.payments/, 'Besuche links, Zahlungen rechts');
  const rules = [...eachRule(HK_STYLES)];
  const wide = rules.find((r) => r.selector.trim() === '.housekeeping-page[data-tab="dashboard"]' && !r.at.length);
  assert.match(wide?.body ?? '', /--page-measure:\s*var\(--layout-wide\)/, 'die Uebersicht bekommt das breite Mass');
  // Zwei Spalten am Container der Seite, nicht am Viewport (PAGE-005).
  const grid = rules.find((r) => r.selector.trim() === '.housekeeping-dashboard-columns'
    && r.at.some((a) => /@container housekeeping-page \(min-width:\s*60rem\)/.test(a)));
  assert.match(grid?.body ?? '', /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  const HK_SRC = readFileSync(new URL('../public/pages/housekeeping.js', import.meta.url), 'utf8');
  assert.match(HK_SRC, /page\.dataset\.tab = state\.tab/, 'der Reiter steht an der Seite, damit das Mass ihm folgt');
});

test('Haushaltshilfe spricht EINEN Namen: Reiter "Uebersicht", Kennzahlen mit Zeitbezug, Geldschein statt Dollar', () => {
  const HK_SRC = readFileSync(new URL('../public/pages/housekeeping.js', import.meta.url), 'utf8');
  assert.doesNotMatch(HK_SRC, /badge-dollar-sign/, 'Dollar-Icon bei Euro-Betraegen');
  assert.match(HK_SRC, /data-lucide="banknote"/);
  const localeDir = new URL('../public/locales/', import.meta.url);
  const { readdirSync } = globalThis.process.getBuiltinModule('node:fs');
  for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
    const loc = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'));
    assert.equal(loc.housekeeping.dashboard, loc.rewards.tabOverview, `${file}: der Reiter heisst wie jede Uebersicht der App`);
  }
  const de = JSON.parse(readFileSync(new URL('de.json', localeDir), 'utf8')).housekeeping;
  assert.equal(de.pendingChores, 'Fällig');
  assert.equal(de.finishedChores, 'Erledigt im Monat');
  assert.deepEqual(Object.entries(de).filter(([, v]) => typeof v === 'string' && /Hauspflege/.test(v)).map(([k]) => k), [],
    'kein zweiter Name neben "Haushaltshilfe"');
});
