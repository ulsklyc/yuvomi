/**
 * Tests: die Fehler-Toasts der Abfuhr-Seite (#1909)
 * Modul: /public/pages/waste.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt, schliesst die Seite den offenen Dialog und holt ihren Stand selbst neu.
 * Wer etwas LOESCHT, das schon weg ist, hat sein Ziel erreicht: Erfolgsweg,
 * kein Fehler-Toast.
 *
 * Gefahren werden die ECHTEN Handler der Seite bis in ihr catch: die
 * Funktionen auf Modulebene direkt, die in den Dialogen ueber den Modal-Stub
 * des Loaders (`__openModal` faengt die Optionen, `onSave(panel)` verdrahtet
 * die echten Zuhoerer an einem Attrappen-Panel, der Test loest den Klick aus).
 * Der api-Stub schreibt mit, was die Seite danach holt.
 *
 * NICHT gefahren: der delegierte Klick-Handler der Seite (`bindEvents`, darin
 * das Loeschen eines Termins aus der Zeile) und alles, was der Loader ersetzt -
 * `closeModal`, `confirmModal`/`confirmOverModal` (antworten "ja") und
 * `refocusAfterRender`. Dass der Dialog wirklich zugeht und das Neuzeichnen
 * stimmt, misst nur der Browser.
 *
 * Ausfuehren: npm run test:waste-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class HTMLElement extends EventTarget {};
globalThis.customElements = { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.document.getElementById = () => null;

const { __test: waste } = await import('../public/pages/waste.js');

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason, params) => Object.assign(new Error(SERVER_TEXT), {
  status, data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}), ...(params ? { params } : {}) },
});

const TYPE = () => ({ id: 1, name: 'Restmuell', icon: 'trash-2', color: '#555555', archived: 0, sort_order: 0 });
const TYPE_B = () => ({ id: 2, name: 'Papier', icon: 'newspaper', color: '#0055AA', archived: 0, sort_order: 1 });
const SCHEDULE = () => ({ id: 7, type_id: 1, recurrence_kind: 'weekly', anchor_date: '2026-01-05', interval: 1, weekdays: 'MO', month_day: null, valid_until: null, active: 1 });
const OCCURRENCE = () => ({
  key: '1:2026-01-12', type_id: 1, date_key: '2026-01-12', moved: true,
  origins: [{ kind: 'schedule', schedule_id: 7, original_date: '2026-01-05', moved: true }],
});
const SOURCE = () => ({
  id: 4, kind: 'file', name: 'Kalender', version: 1, needs_mapping: 0,
  mappings: [{ id: 30, original_label: 'Bio', normalized_label: 'bio', type_id: 1, ignored: 0 }],
});

function zustand() {
  toasts.length = 0;
  waste.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
  waste.setStateForTest({
    types: [TYPE(), TYPE_B()], schedules: [SCHEDULE()], occurrences: [OCCURRENCE()], sources: [SOURCE()],
    loading: false, error: null,
  });
}

/** Der Server NACH der fremden Aenderung: was die Seite beim Nachladen liest. */
const FRISCH = { types: [TYPE_B()], schedules: [], occurrences: [], sources: [] };
const NACHLADEN = ['/waste/occurrences', '/waste/schedules', '/waste/sources', '/waste/types?include_archived=1'];

/**
 * Mit einem api-Stub laufen lassen. `calls` schreibt jede Anfrage mit,
 * `closed` jedes Schliessen eines Dialogs. Lesen liefert den frischen Stand,
 * ausser `liest` wirft; die Schreibwege (`post`, `put`, `delete`) nennt der Test.
 */
async function mit({ liest = null, quelle = null, ...schreiben }, lauf) {
  const calls = [];
  const closed = [];
  const lese = async (path) => {
    calls.push(['GET', path.replace(/\?from=.*$/, '')]);
    if (liest) await liest(path);
    if (path.startsWith('/waste/types')) return { data: FRISCH.types };
    if (path === '/waste/schedules') return { data: FRISCH.schedules };
    if (path.startsWith('/waste/occurrences')) return { data: FRISCH.occurrences };
    if (path === '/waste/sources') return { data: FRISCH.sources };
    // Die frisch gelesene Quelle, wenn ein Dialog sie nachholt.
    if (quelle && path === `/waste/sources/${quelle.id}`) return { data: quelle };
    throw new Error(`kein Stub fuer GET ${path}`);
  };
  const stub = { get: lese };
  for (const verb of ['post', 'put', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!schreiben[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return schreiben[verb](path, body);
    };
  }
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  try {
    await lauf();
    // Das Nachladen nach "gibt es nicht mehr" laeuft unverkettet im catch an.
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__closeModal;
  }
  const gets = calls.filter(([verb]) => verb === 'GET').map(([, path]) => path).sort();
  return { calls, closed, gets };
}

/**
 * Oeffnet einen Dialog der Seite ueber den Modal-Stub und verdrahtet seine
 * echten Zuhoerer an einem Attrappen-Panel. `werte` belegt Felder
 * (`#id` -> { value | checked }), `listen` die Antworten auf querySelectorAll.
 * Liefert `klick(selector)`: der echte Handler des Knopfs.
 */
async function dialog(oeffne, { werte = {}, listen = {} } = {}) {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    await oeffne();
  } finally {
    delete globalThis.__openModal;
  }
  assert.ok(opts, 'der Dialog wurde geoeffnet');
  const handlers = new Map();
  const elements = new Map();
  const fokus = [];
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '', checked: false, hidden: false, disabled: false, dataset: {}, files: [], textContent: '',
        attrs: {}, html: null,
        addEventListener(type, fn) { handlers.set(`${selector}:${type}`, fn); },
        focus() { fokus.push(selector); }, click() {},
        setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
        getAttribute: () => null,
        // Neu gebautes Markup: `html` ist, was nach replaceChildren() eingefuegt wurde.
        replaceChildren() { this.html = ''; },
        insertAdjacentHTML(_position, html) { this.html = (this.html ?? '') + html; },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => null, querySelectorAll: () => [],
        ...werte[selector],
      });
    }
    return elements.get(selector);
  };
  const panel = {
    querySelector: (selector) => (selector in werte && werte[selector] === null ? null : element(selector)),
    querySelectorAll: (selector) => listen[selector] ?? [],
    addEventListener(type, fn) { handlers.set(`panel:${type}`, fn); },
  };
  opts.onSave(panel);
  return {
    element, fokus,
    klick: (selector) => {
      const fn = handlers.get(`${selector}:click`);
      assert.equal(typeof fn, 'function', `${selector} hat einen Klick-Handler`);
      return fn({ preventDefault() {} });
    },
  };
}

const terminDialog = (werte = {}) => dialog(() => waste.openScheduleModal(TYPE(), SCHEDULE()), {
  werte: {
    '#wsm-kind': { value: 'monthly_fixed_day' }, '#wsm-anchor': { value: '2026-01-05' },
    '#wsm-valid-until': { value: '' }, '#wsm-interval': { value: '1' }, '#wsm-active': { checked: true },
    '#wsm-type': null, '#wsm-last-day': { checked: false }, '#wsm-month-day': { value: '15' },
    '.waste-weekday-picker': null, ...werte,
  },
});

// -------------------------------------------------------------------------
// Der Satz der App, nie der des Servers
// -------------------------------------------------------------------------

test('Termin speichern mit einer Eingabe, die erst der Server prueft: der eigene Satz, der Dialog bleibt, nichts wird nachgeladen', async () => {
  zustand();
  const d = await terminDialog();
  const { calls, closed, gets } = await mit({
    put: async () => { throw fehler(400, 'waste_schedule_anchor_not_month_day'); },
  }, () => d.klick('#wsm-save'));

  assert.deepEqual(calls[0], ['PUT', '/waste/schedules/7']);
  assert.deepEqual(toasts, [['waste.errorScheduleAnchorNotMonthDay', 'danger']]);
  assert.deepEqual(closed, [], 'der Dialog bleibt mit der Eingabe offen');
  assert.deepEqual(gets, []);
});

for (const [name, err, key] of [
  ['400 ohne Grund', fehler(400), 'common.errorGeneric'],
  ['400 mit unbekanntem Grund', fehler(400, 'waste_future_case'), 'common.errorGeneric'],
  ['blanke 404', fehler(404), 'common.errorGeneric'],
  ['500', fehler(500), 'common.errorGeneric'],
  ['eine Absage (403), auch mit einem Abfuhr-Grund', fehler(403, 'waste_schedule_not_found'), 'common.errorNoPermission'],
  ['offline', Object.assign(new Error('offline'), { status: 0 }), 'common.errorOfflineMutation'],
]) {
  test(`Ohne bekannten Fall der allgemeine Satz, nie der Text des Servers, und kein Nachladen: ${name}`, async () => {
    zustand();
    const d = await terminDialog();
    const { closed, gets } = await mit({ put: async () => { throw err; } }, () => d.klick('#wsm-save'));

    assert.deepEqual(toasts, [[key, 'danger']]);
    assert.ok(!toasts.some(([text]) => text.includes(SERVER_TEXT)));
    assert.deepEqual(closed, []);
    assert.deepEqual(gets, []);
    assert.equal(waste.state().schedules.length, 1, 'der Stand der Seite bleibt');
  });
}

test('Die beiden Konflikte tragen ihren Satz am Grund, nicht mehr am Status 409', async () => {
  zustand();
  const typ = await dialog(() => waste.openTypeModal(TYPE()));
  await mit({ delete: async () => { throw fehler(409, 'waste_type_in_use'); } }, () => typ.klick('#wtm-delete'));
  assert.deepEqual(toasts, [['waste.typeDeleteRefused', 'danger']]);

  zustand();
  const abholung = await dialog(() => waste.openPickupModal(), { werte: { '#wpm-type': { value: '1' }, '#wpm-date': { value: '2026-03-01' } } });
  await mit({ post: async () => { throw fehler(409, 'waste_pickup_exists'); } }, () => abholung.klick('#wpm-save'));
  assert.deepEqual(toasts, [['waste.pickupDuplicateError', 'danger']]);

  // Ein 409 OHNE diesen Grund ist nicht mehr automatisch "Abholung gibt es schon".
  zustand();
  const andere = await dialog(() => waste.openPickupModal(), { werte: { '#wpm-type': { value: '1' }, '#wpm-date': { value: '2026-03-01' } } });
  await mit({ post: async () => { throw fehler(409); } }, () => andere.klick('#wpm-save'));
  assert.deepEqual(toasts, [['common.errorGeneric', 'danger']]);
});

test('Erinnerung speichern: der Satz zum Feld, der Dialog bleibt', async () => {
  zustand();
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  globalThis.__apiStub = { get: async () => ({ data: [{ type_id: 1, type_name: 'Restmuell', enabled: false, offset_days: 1, delivery_time: '08:00' }] }) };
  try { await waste.openReminderSettingsModal(); } finally { delete globalThis.__openModal; delete globalThis.__apiStub; }
  const row = {
    dataset: { typeId: '1' },
    querySelector: (sel) => ({
      '[data-role="reminder-enabled"]': { checked: true },
      '[data-role="reminder-offset"]': { value: '99' },
      '[data-role="reminder-time"]': { value: '08:00' },
    })[sel],
  };
  const handlers = {};
  const knopf = { addEventListener(type, fn) { handlers[type] = fn; }, disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} };
  opts.onSave({
    querySelector: (sel) => (sel === '#rem-save' ? knopf : { addEventListener() {} }),
    querySelectorAll: (sel) => (sel === '.waste-reminder-setting-row' ? [row] : []),
    addEventListener() {},
  });
  const { calls, closed, gets } = await mit({
    put: async () => { throw fehler(400, 'waste_reminder_offset_invalid'); },
  }, () => handlers.click());

  assert.deepEqual(calls[0], ['PUT', '/waste/reminder-settings/1']);
  assert.deepEqual(toasts, [['waste.errorReminderOffset', 'danger']]);
  assert.deepEqual(closed, []);
  assert.deepEqual(gets, []);
});

// -------------------------------------------------------------------------
// "Gibt es nicht mehr": die Seite laedt selbst nach
// -------------------------------------------------------------------------

test('Termin aus der Zeile SEINER Abfallart speichern, die inzwischen geloescht wurde: der Dialog hat keine Auswahl, er geht zu, die Seite holt den frischen Stand', async () => {
  zustand();
  const d = await terminDialog();
  const { closed, gets } = await mit({
    put: async () => { throw fehler(400, 'waste_selected_type_not_found'); },
  }, () => d.klick('#wsm-save'));

  assert.deepEqual(toasts, [['waste.errorSelectedTypeGone', 'danger']]);
  assert.deepEqual(closed, [{ force: true }]);
  assert.deepEqual(gets, NACHLADEN, 'Abfallarten, Termine, Abholungen und Quellen - je einmal');
  assert.deepEqual(waste.state().types.map((type) => type.id), [2], 'die geloeschte Abfallart ist aus dem Bestand');
  assert.deepEqual(waste.state().schedules, []);
});

for (const [name, reason, key, lauf] of [
  ['eine Abfallart verschieben, die es nicht mehr gibt', 'waste_type_not_found', 'waste.errorTypeGone',
    () => waste.moveType(1, 'down')],
  ['eine Abholung aussetzen, deren Termin geloescht wurde', 'waste_schedule_not_found', 'waste.errorScheduleGone',
    () => waste.skipOccurrence('1:2026-01-12')],
  ['eine Abholung aussetzen, die nach einer Aenderung des Termins nicht mehr im Plan steht', 'waste_occurrence_not_found', 'waste.errorOccurrenceGone',
    () => waste.skipOccurrence('1:2026-01-12')],
  ['eine Einzelabholung oeffnen, die es nicht mehr gibt', 'waste_pickup_not_found', 'waste.errorPickupGone',
    () => waste.loadPickupAndEdit(55)],
  ['eine Quelle oeffnen, die es nicht mehr gibt', 'waste_source_not_found', 'waste.errorSourceGone',
    () => waste.loadSourceAndOpen(4)],
  ['das Zuordnungsprofil einer geloeschten Quelle exportieren', 'waste_source_not_found', 'waste.errorSourceGone',
    () => waste.exportMappingProfileFile(SOURCE())],
]) {
  test(`Nachladen bei "gibt es nicht mehr": ${name}`, async () => {
    zustand();
    const wirft = async () => { throw fehler(reason.endsWith('occurrence_not_found') ? 400 : 404, reason); };
    let geworfen = false;
    const { gets, calls } = await mit({
      put: wirft,
      // Die Lesewege dieser Faelle (GET /pickups/55, /sources/4, .../export)
      // scheitern beim ERSTEN Lesen; das Nachladen danach liest normal.
      liest: async (path) => {
        if (/^\/waste\/(pickups|sources)\/\d+/.test(path) && !geworfen) { geworfen = true; throw fehler(404, reason); }
      },
    }, lauf);

    assert.deepEqual(toasts, [[key, 'danger']]);
    assert.deepEqual(gets.filter((path) => NACHLADEN.includes(path)), NACHLADEN);
    assert.equal(calls.filter(([verb]) => verb === 'GET').length - (geworfen ? 1 : 0), 4, 'genau ein Nachladen');
    assert.deepEqual(waste.state().types.map((type) => type.id), [2]);
  });
}

test('Quelle speichern, eine Zuordnung wurde inzwischen entfernt: Satz, Dialog zu, nachladen', async () => {
  zustand();
  const row = { dataset: { mappingId: '30' }, querySelector: () => ({ value: '2' }) };
  const d = await dialog(() => waste.openSourceModal(SOURCE()), {
    werte: { '#wsrc-name': { value: 'Kalender' } },
    listen: { '.waste-source-mapping-row': [row] },
  });
  const { calls, closed, gets } = await mit({
    put: async () => { throw fehler(404, 'waste_mapping_not_found'); },
  }, () => d.klick('#wsrc-save'));

  assert.deepEqual(calls[0], ['PUT', '/waste/sources/4/mappings/30']);
  assert.deepEqual(toasts, [['waste.errorMappingGone', 'danger']]);
  assert.deepEqual(closed, [{ force: true }]);
  assert.deepEqual(gets, NACHLADEN);
});

test('Ein scheiterndes Nachladen meldet sich nicht und loest kein weiteres aus', async () => {
  zustand();
  const { gets } = await mit({
    put: async () => { throw fehler(404, 'waste_schedule_not_found'); },
    // Auch das Nachladen bekommt "gibt es nicht mehr" - es darf nicht noch einmal anlaufen.
    liest: async () => { throw fehler(404, 'waste_type_not_found'); },
  }, () => waste.skipOccurrence('1:2026-01-12'));

  assert.deepEqual(toasts, [['waste.errorScheduleGone', 'danger']], 'ein Toast, keiner fuer das Nachladen');
  assert.equal(gets.length, 4, 'ein Nachlade-Lauf (vier Anfragen), kein zweiter');
  assert.deepEqual(waste.state().types.map((type) => type.id), [1, 2], 'der alte Stand bleibt stehen, statt leer zu werden');
});

// -------------------------------------------------------------------------
// Loeschen, was schon geloescht ist, ist erledigt
// -------------------------------------------------------------------------

for (const [name, reason, erfolg, pfad, oeffne] of [
  ['Abfallart (Dialog)', 'waste_type_not_found', 'waste.typeDeletedToast', '/waste/types/1',
    async () => (await dialog(() => waste.openTypeModal(TYPE()))).klick('#wtm-delete')],
  ['Termin (Dialog)', 'waste_schedule_not_found', 'waste.scheduleDeletedToast', '/waste/schedules/7',
    async () => (await terminDialog()).klick('#wsm-delete')],
  ['Einzelabholung (Dialog)', 'waste_pickup_not_found', 'waste.pickupDeletedToast', '/waste/pickups/55',
    async () => (await dialog(() => waste.openPickupModal({ id: 55, type_id: 1, date: '2026-03-01', note: null }))).klick('#wpm-delete')],
  ['Einzelabholung (Zeile)', 'waste_pickup_not_found', 'waste.pickupDeletedToast', '/waste/pickups/55',
    () => waste.deletePickup(55)],
  ['Quelle (Dialog)', 'waste_source_not_found', 'waste.sourceDeletedToast', '/waste/sources/4',
    async () => (await dialog(() => waste.openSourceModal(SOURCE()))).klick('#wsrc-delete')],
  ['verschobene Abholung zuruecksetzen', 'waste_override_not_found', 'waste.scheduleSavedToast', '/waste/schedules/7/overrides/2026-01-05',
    () => waste.restoreOccurrence('1:2026-01-12')],
]) {
  test(`Schon geloescht ist erledigt: ${name}`, async () => {
    zustand();
    const { calls, gets } = await mit({ delete: async () => { throw fehler(404, reason); } }, oeffne);

    assert.deepEqual(calls[0], ['DELETE', pfad]);
    assert.deepEqual(toasts, [[erfolg, 'success']], 'der Erfolgs-Toast, kein Fehler');
    assert.deepEqual(gets, NACHLADEN, 'die Seite laedt einmal nach, wie nach jedem Loeschen');
  });

  for (const [welcher, err, key, laedt] of [
    ['500', fehler(500), 'common.errorGeneric', false],
    ['blanke 404 ohne Grund', fehler(404), 'common.errorGeneric', false],
    ['404 mit unbekanntem Grund', fehler(404, 'waste_future_not_found'), 'common.errorGeneric', false],
    ['eine Absage (403) mit genau diesem Grund', fehler(403, reason), 'common.errorNoPermission', false],
    // Etwas ANDERES ist weg: ein Fehler mit Satz, und die Seite laedt nach.
    ['der Grund eines anderen Dings', fehler(404, reason === 'waste_mapping_not_found' ? 'waste_type_not_found' : 'waste_mapping_not_found'),
      reason === 'waste_mapping_not_found' ? 'waste.errorTypeGone' : 'waste.errorMappingGone', true],
  ]) {
    test(`Loeschen scheitert an etwas anderem und bleibt ein Fehler: ${name}, ${welcher}`, async () => {
      zustand();
      const { gets } = await mit({ delete: async () => { throw err; } }, oeffne);

      assert.deepEqual(toasts, [[key, 'danger']]);
      assert.deepEqual(gets, laedt ? NACHLADEN : []);
    });
  }
}

// -------------------------------------------------------------------------
// Jeder Grund, den die Seite erreichen kann, kommt am Toast als sein Satz an
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Nur die GEWAEHLTE Abfallart fehlt: der Dialog bleibt offen (#1909)
// -------------------------------------------------------------------------

const GEWAEHLT_WEG = () => fehler(400, 'waste_selected_type_not_found');

/** Die Optionen, die eine neu gebaute Auswahl traegt: [value, selected, disabled]. */
const optionen = (html) => [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)]
  .map(([, value, attrs]) => [value, / selected/.test(attrs), / disabled/.test(attrs)]);

for (const [name, oeffne, select, werte, erster] of [
  ['Termin (Primaerknopf, mit Auswahl)', () => waste.openScheduleModal(null), '#wsm-type', {
    '#wsm-kind': { value: 'monthly_fixed_day' }, '#wsm-anchor': { value: '2026-01-05' }, '#wsm-valid-until': { value: '' },
    '#wsm-interval': { value: '3' }, '#wsm-active': { checked: true }, '#wsm-last-day': { checked: false },
    '#wsm-month-day': { value: '5' }, '.waste-weekday-picker': null,
  }, ['POST', '/waste/schedules']],
  ['Einzelabholung', () => waste.openPickupModal(), '#wpm-type', {
    '#wpm-date': { value: '2026-03-01' }, '#wpm-note': { value: 'Sperrmuell vor die Tuer' },
  }, ['POST', '/waste/pickups']],
]) {
  test(`${name}: die gewaehlte Abfallart wurde geloescht - der Dialog bleibt, die Eingaben bleiben, die Auswahl zeigt den frischen Stand`, async () => {
    zustand();
    const d = await dialog(oeffne, { werte: { ...werte, [select]: { value: '1' } } });
    const { calls, closed, gets } = await mit({ post: async () => { throw GEWAEHLT_WEG(); } }, () => d.klick(select.replace('type', 'save')));

    assert.deepEqual(calls[0], erster);
    assert.deepEqual(toasts, [['waste.errorSelectedTypeGone', 'danger']], 'der Satz sagt, dass die Art fehlt');
    assert.deepEqual(closed, [], 'der Dialog bleibt offen');
    assert.deepEqual(gets, NACHLADEN, 'die Seite holt den frischen Stand, einmal');
    assert.deepEqual(waste.state().types.map((type) => type.id), [2]);

    const auswahl = d.element(select);
    assert.deepEqual(optionen(auswahl.html), [['', true, true], ['2', false, false]],
      'die geloeschte Art ist weg, die verbliebene steht da, und KEINE ist an ihrer Stelle gewaehlt');
    assert.match(auswahl.html, /^<option value="" disabled selected>waste\.typeSelectPlaceholder<\/option>/);
    assert.equal(auswahl.attrs['aria-invalid'], 'true');
    assert.deepEqual(d.fokus, [select], 'der Fokus steht auf der Auswahl');
    // Die uebrigen Eingaben fasst niemand an.
    for (const [feld, wert] of Object.entries(werte)) {
      if (wert) assert.deepEqual({ value: d.element(feld).value, checked: d.element(feld).checked }, { value: '', checked: false, ...wert }, feld);
    }

    // Ein zweiter Druck auf Speichern mit der leeren Aufforderung schickt nichts.
    auswahl.value = '';
    const zweiter = await mit({ post: async () => { throw new Error('darf nicht senden'); } }, () => d.klick(select.replace('type', 'save')));
    assert.deepEqual(zweiter.calls, []);
  });

  test(`${name}: die gewaehlte Abfallart gibt es nach dem Nachladen doch - sie bleibt gewaehlt, ohne Aufforderung`, async () => {
    zustand();
    const d = await dialog(oeffne, { werte: { ...werte, [select]: { value: '2' } } });
    const { closed } = await mit({ post: async () => { throw GEWAEHLT_WEG(); } }, () => d.klick(select.replace('type', 'save')));

    assert.deepEqual(closed, []);
    assert.deepEqual(optionen(d.element(select).html), [['2', true, false]]);
    assert.equal('aria-invalid' in d.element(select).attrs, false);
  });

  test(`${name}: jeder ANDERE Grund "gibt es nicht mehr" schliesst den Dialog weiter`, async () => {
    for (const reason of ['waste_type_not_found', 'waste_schedule_not_found', 'waste_pickup_not_found']) {
      zustand();
      const d = await dialog(oeffne, { werte: { ...werte, [select]: { value: '1' } } });
      const { closed, gets } = await mit({ post: async () => { throw fehler(404, reason); } }, () => d.klick(select.replace('type', 'save')));
      assert.deepEqual(closed, [{ force: true }], reason);
      assert.deepEqual(gets, NACHLADEN, reason);
      assert.equal(d.element(select).html, null, `${reason}: die Auswahl wird nicht angefasst`);
    }
  });
}

test('Einzelabholung bearbeiten: die eigene, archivierte Abfallart bleibt nach dem Auffrischen waehlbar', async () => {
  zustand();
  const archiviert = { ...TYPE_B(), id: 3, name: 'Altglas', archived: 1 };
  const d = await dialog(() => waste.openPickupModal({ id: 55, type_id: 3, date: '2026-03-01', note: null }), {
    werte: { '#wpm-type': { value: '1' }, '#wpm-date': { value: '2026-03-01' }, '#wpm-note': { value: '' } },
  });
  FRISCH.types = [TYPE_B(), archiviert];
  try {
    await mit({ put: async () => { throw GEWAEHLT_WEG(); } }, () => d.klick('#wpm-save'));
  } finally {
    FRISCH.types = [TYPE_B()];
  }
  assert.deepEqual(optionen(d.element('#wpm-type').html), [['', true, true], ['2', false, false], ['3', false, false]]);
});

test('Quelle speichern, eine Zuordnung zeigt auf eine geloeschte Abfallart: der Dialog bleibt, die Zeilen kommen frisch vom Server, der Fokus steht auf der gescheiterten', async () => {
  zustand();
  const quelle = { ...SOURCE(), mappings: [
    { id: 30, original_label: 'Bio', normalized_label: 'bio', type_id: 2, ignored: 0 },
    { id: 31, original_label: 'Papier', normalized_label: 'papier', type_id: null, ignored: 1 },
  ] };
  const zeile = (id, value) => ({ dataset: { mappingId: String(id) }, querySelector: () => ({ value }) });
  const fokus = [];
  const attrs = {};
  const d = await dialog(() => waste.openSourceModal(quelle), {
    werte: {
      '#wsrc-name': { value: 'Mein Kalender' },
      '#wsrc-mappings': {
        html: null,
        replaceChildren() { this.html = ''; },
        insertAdjacentHTML(_position, html) { this.html += html; },
        querySelector: (selector) => ({ focus() { fokus.push(selector); }, setAttribute(name, value) { attrs[name] = value; } }),
      },
    },
    // Zeile 30 wird gespeichert (auf Art 2), Zeile 31 zeigt auf die geloeschte Art 1.
    listen: { '.waste-source-mapping-row': [zeile(30, '2'), zeile(31, '1')] },
  });
  // Der Server nach dem Teil-Speichern: Name und Zeile 30 stehen, Zeile 31 unveraendert.
  const frisch = { ...quelle, name: 'Mein Kalender', mappings: [
    { id: 30, original_label: 'Bio', normalized_label: 'bio', type_id: 2, ignored: 0 },
    { id: 31, original_label: 'Papier', normalized_label: 'papier', type_id: null, ignored: 1 },
  ] };
  const { calls, closed, gets } = await mit({
    quelle: frisch,
    put: async (path) => { if (path.endsWith('/mappings/31')) throw GEWAEHLT_WEG(); return { data: {} }; },
  }, () => d.klick('#wsrc-save'));

  assert.deepEqual(calls.filter(([verb]) => verb === 'PUT').map(([, path]) => path), ['/waste/sources/4', '/waste/sources/4/mappings/31']);
  assert.deepEqual(toasts, [['waste.errorSelectedTypeGone', 'danger']]);
  assert.deepEqual(closed, [], 'der Dialog bleibt offen');
  assert.deepEqual(gets, [...NACHLADEN, '/waste/sources/4'].sort(), 'der Stand der Seite und die Quelle selbst, je einmal');
  const host = d.element('#wsrc-mappings');
  assert.equal([...host.html.matchAll(/data-mapping-id="(\d+)"/g)].map((m) => m[1]).join(), '30,31', 'beide Zeilen neu gebaut');
  assert.doesNotMatch(host.html, /<option value="1"/, 'die geloeschte Abfallart steht nicht mehr zur Wahl');
  assert.deepEqual(fokus, ['[data-mapping-id="31"] [data-role="mapping-type"]'], 'der Fokus steht auf der gescheiterten Zeile');
  assert.equal(attrs['aria-invalid'], 'true');
  assert.equal(d.element('#wsrc-name').value, 'Mein Kalender', 'der Name im Feld bleibt');
  assert.equal(quelle.mappings, frisch.mappings, 'der Dialog vergleicht ab jetzt gegen den frischen Stand');
  assert.equal(quelle.name, 'Mein Kalender', 'auch der Name: ein zweites Speichern schickt ihn nicht noch einmal');
});

test('Quelle speichern, die Zuordnung zeigt auf eine geloeschte Art UND die Quelle ist inzwischen auch weg: der gewohnte Weg, Dialog zu', async () => {
  zustand();
  const d = await dialog(() => waste.openSourceModal(SOURCE()), {
    werte: { '#wsrc-name': { value: 'Kalender' } },
    listen: { '.waste-source-mapping-row': [{ dataset: { mappingId: '30' }, querySelector: () => ({ value: '2' }) }] },
  });
  const { closed } = await mit({
    put: async () => { throw GEWAEHLT_WEG(); },
    liest: async (path) => { if (path === '/waste/sources/4') throw fehler(404, 'waste_source_not_found'); },
  }, () => d.klick('#wsrc-save'));

  assert.deepEqual(toasts, [['waste.errorSelectedTypeGone', 'danger'], ['waste.errorSourceGone', 'danger']]);
  assert.deepEqual(closed, [{ force: true }]);
});

// -------------------------------------------------------------------------
// Import-Assistent: der Satz steht im Dialog, mit der Zahl der Ursache
// -------------------------------------------------------------------------

const VORSCHAU = () => ({
  digest: 'd1', expected_version: 1, source_id: null, diagnostics: [], counts: { events: 2, candidates: 2 },
  labels: [
    { normalized_label: 'bio', original_label: 'Bio', count: 1, suggested_type_id: 1 },
    { normalized_label: 'papier', original_label: 'Papier', count: 1, suggested_type_id: 2 },
  ],
});

const datei = (size = 100) => ({ size, text: async () => 'BEGIN:VCALENDAR' });

async function assistent(quelle = null, werte = {}, listen = {}) {
  return dialog(() => waste.openImportWizard(quelle), {
    werte: { '#wiz-file': { files: [datei()] }, '#wiz-name': { value: 'Kalender' }, ...werte },
    listen,
  });
}

for (const [name, err, satz] of [
  ['Datei ueber der Grenze, die der Server nennt', fehler(400, 'waste_import_file_too_large', { limit_mb: 12 }), 'waste.errorImportTooLarge{"limit_mb":12}'],
  ['zu viele Kalendereintraege', fehler(400, 'waste_import_event_cap_exceeded', { limit: 5000 }), 'waste.errorImportTooManyEvents{"limit":5000}'],
  ['zu viele Abholungen', fehler(400, 'waste_import_instance_cap_exceeded', { limit: 5000 }), 'waste.errorImportTooManyPickups{"limit":5000}'],
  ['zu viele Bezeichnungen', fehler(400, 'waste_import_label_cap_exceeded', { limit: 200 }), 'waste.errorImportTooManyLabels{"limit":200}'],
  ['leere Datei', fehler(400, 'waste_import_empty_file'), 'waste.errorImportEmpty'],
  ['Datei ohne einen Kalendereintrag (#1938)', fehler(400, 'waste_import_no_events'), 'waste.errorImportNoEvents'],
  ['die Zahl fehlt in der Antwort', fehler(400, 'waste_import_file_too_large'), 'common.unknownError'],
  ['400 ohne Grund', fehler(400), 'common.unknownError'],
  ['500', fehler(500), 'common.unknownError'],
]) {
  test(`Import-Vorschau scheitert: der Satz der App steht im Dialog, nie der des Servers - ${name}`, async () => {
    zustand();
    const d = await assistent();
    const { calls, closed, gets } = await mit({ post: async () => { throw err; } }, () => d.klick('#wiz-preview'));

    assert.deepEqual(calls, [['POST', '/waste/import/preview']]);
    assert.equal(d.element('#wiz-error').textContent, satz);
    assert.equal(d.element('#wiz-error').hidden, false);
    assert.deepEqual(toasts, [], 'kein Toast neben dem Satz im Dialog');
    assert.deepEqual(closed, []);
    assert.deepEqual(gets, []);
  });
}

test('Import-Vorschau: eine Datei ueber der Grenze geht gar nicht erst an den Server, der Satz nennt die Grenze', async () => {
  zustand();
  const { maxUploadBytes, maxUploadMb } = await import('../public/utils/upload-limit.js');
  const d = await assistent(null, { '#wiz-file': { files: [datei(maxUploadBytes() + 1)] } });
  const { calls } = await mit({ post: async () => { throw new Error('darf nicht senden'); } }, () => d.klick('#wiz-preview'));
  assert.deepEqual(calls, []);
  assert.equal(d.element('#wiz-error').textContent, `waste.errorImportTooLarge{"limit_mb":${maxUploadMb()}}`);

  // Genau an der Grenze geht sie durch.
  const genau = await assistent(null, { '#wiz-file': { files: [datei(maxUploadBytes())] } });
  const zweiter = await mit({ post: async () => { throw fehler(500); } }, () => genau.klick('#wiz-preview'));
  assert.deepEqual(zweiter.calls, [['POST', '/waste/import/preview']]);
});

for (const [name, err, satz] of [
  ['die Gegenstelle antwortet mit einem Fehler', fehler(502, 'waste_source_fetch_http_status', { status: 404 }), 'waste.errorSourceFetchStatus{"status":404}'],
  ['die Antwort ist zu gross', fehler(502, 'waste_source_fetch_too_large', { limit_mb: 5 }), 'waste.errorSourceFetchTooLarge{"limit_mb":5}'],
  ['eine gesperrte Adresse', fehler(502, 'waste_source_fetch_blocked'), 'waste.errorSourceFetchBlocked'],
  ['nicht erreichbar', fehler(502, 'waste_source_fetch_unreachable'), 'waste.errorSourceFetchUnreachable'],
  ['die Adresse antwortet ohne einen Kalendereintrag (#1938)', fehler(502, 'waste_source_fetch_no_events'), 'waste.errorSourceFetchNoEvents'],
  ['die gespeicherte Adresse ist nicht mehr https', fehler(502, 'waste_source_url_not_https'), 'waste.errorSourceUrlNotHttps'],
  ['502 ohne Grund', fehler(502), 'common.unknownError'],
]) {
  test(`Quelle mit Adresse erneut pruefen, der Abruf scheitert: je Klasse ein eigener Satz - ${name}`, async () => {
    zustand();
    const d = await assistent({ ...SOURCE(), kind: 'url', needs_mapping: 1 });
    const { calls } = await mit({ post: async () => { throw err; } }, () => d.klick('#wiz-preview'));
    assert.deepEqual(calls, [['POST', '/waste/sources/4/reimport/preview']]);
    assert.equal(d.element('#wiz-error').textContent, satz);
    assert.deepEqual(toasts, []);
  });
}

test('Import-Vorschau einer Quelle, die es nicht mehr gibt: Satz im Toast, der Assistent geht zu, die Seite laedt nach', async () => {
  zustand();
  const d = await assistent(SOURCE());
  const { closed, gets } = await mit({ post: async () => { throw fehler(404, 'waste_source_not_found'); } }, () => d.klick('#wiz-preview'));
  assert.deepEqual(toasts, [['waste.errorSourceGone', 'danger']]);
  assert.deepEqual(closed, [{ force: true }]);
  assert.deepEqual(gets, NACHLADEN);
});

/** Der Assistent nach einer gelungenen Vorschau: die Zeilen der Bezeichnungen als Attrappen. */
async function assistentMitVorschau(entscheidungen) {
  const fokus = [];
  const zeilen = entscheidungen.map(([label, value]) => {
    const select = {
      value, html: null,
      replaceChildren() { this.html = ''; },
      insertAdjacentHTML(_position, html) { this.html += html; this.value = html.match(/<option value="([^"]*)" selected>/)?.[1] ?? ''; },
      focus() { fokus.push(label); },
    };
    const name = { value: label, hidden: value !== '__new__' };
    return {
      dataset: { label }, select, name,
      querySelector: (selector) => (selector.includes('decision-type') ? select : name),
    };
  });
  const d = await assistent(null, {
    '#wiz-step2': { replaceChildren() {}, insertAdjacentHTML() {} },
  }, { '.waste-import-label-row': zeilen, '#wiz-step1 input': [] });
  await mit({ post: async () => ({ data: VORSCHAU() }) }, () => d.klick('#wiz-preview'));
  return { d, zeilen, fokus };
}

test('Import uebernehmen, eine Bezeichnung zeigt auf eine geloeschte Abfallart: der Assistent bleibt, jede Entscheidung bleibt, die Auswahl zeigt den frischen Stand', async () => {
  zustand();
  // Bio -> Art 1 (wird geloescht), Papier -> Art 2 (bleibt), Glas -> ignorieren, Metall -> neu.
  const { d, zeilen, fokus } = await assistentMitVorschau([['bio', '1'], ['papier', '2'], ['glas', ''], ['metall', '__new__']]);
  toasts.length = 0;
  const { calls, closed, gets } = await mit({ post: async () => { throw GEWAEHLT_WEG(); } }, () => d.klick('#wiz-commit'));

  assert.deepEqual(calls[0], ['POST', '/waste/import/commit']);
  assert.equal(d.element('#wiz-error').textContent, 'waste.errorSelectedTypeGone', 'der Satz steht im Dialog');
  assert.deepEqual(toasts, []);
  assert.deepEqual(closed, [], 'der Assistent bleibt offen');
  assert.deepEqual(gets, NACHLADEN);
  assert.deepEqual(zeilen.map((zeile) => zeile.select.value), ['__new__', '2', '', '__new__'],
    'nur die Zeile der geloeschten Art faellt auf "neue Abfallart anlegen", jede andere Entscheidung bleibt');
  assert.deepEqual(zeilen.map((zeile) => zeile.name.hidden), [false, true, true, false], 'das Namensfeld der betroffenen Zeile ist sichtbar');
  for (const zeile of zeilen) assert.doesNotMatch(zeile.select.html, /<option value="1"/, 'die geloeschte Art steht in keiner Auswahl mehr');
  assert.deepEqual(fokus, ['bio'], 'der Fokus steht auf der betroffenen Auswahl');
});

for (const [name, err, satz] of [
  ['der Kalender hat sich seit der Vorschau geaendert', fehler(409, 'preview_changed'), 'waste.importPreviewChangedError'],
  ['die Quelle wurde inzwischen geaendert', fehler(409, 'source_changed'), 'waste.importSourceChangedError'],
  ['eine Grenze, erst bei der Uebernahme', fehler(400, 'waste_import_instance_cap_exceeded', { limit: 5000 }), 'waste.errorImportTooManyPickups{"limit":5000}'],
  ['400 ohne Grund', fehler(400), 'common.unknownError'],
]) {
  test(`Import uebernehmen scheitert: der Satz im Dialog, der Assistent bleibt, nichts wird nachgeladen - ${name}`, async () => {
    zustand();
    const { d, zeilen } = await assistentMitVorschau([['bio', '1'], ['papier', '2']]);
    const { closed, gets } = await mit({ post: async () => { throw err; } }, () => d.klick('#wiz-commit'));
    assert.equal(d.element('#wiz-error').textContent, satz);
    assert.deepEqual(closed, []);
    assert.deepEqual(gets, []);
    assert.equal(zeilen[0].select.html, null, 'die Auswahl wird nicht angefasst');
  });
}

// -------------------------------------------------------------------------
// Zuordnungsprofil
// -------------------------------------------------------------------------

/** Faehrt die Dateiwahl des Zuordnungsprofils: liefert, was nach `change` passiert. */
async function profilWaehlen(inhalt) {
  const original = globalThis.document.createElement;
  let input = null;
  globalThis.document.createElement = (tag) => {
    if (tag !== 'input') return original(tag);
    input = { files: [{ text: async () => inhalt }], addEventListener(type, fn) { this[type] = fn; }, click() {} };
    return input;
  };
  try {
    waste.openMappingProfileImportModal(SOURCE());
  } finally {
    globalThis.document.createElement = original;
  }
  return () => input.change();
}

test('Zuordnungsprofil, die Datei ist keines: der Satz der App, kein Dialog', async () => {
  zustand();
  const wechsel = await profilWaehlen('{"something":"else"}');
  let geoeffnet = false;
  globalThis.__openModal = () => { geoeffnet = true; };
  try {
    const { calls } = await mit({ post: async () => { throw fehler(400, 'waste_profile_invalid'); } }, wechsel);
    assert.deepEqual(calls, [['POST', '/waste/sources/4/mapping-profile/import/preview']]);
  } finally {
    delete globalThis.__openModal;
  }
  assert.deepEqual(toasts, [['waste.mappingProfileInvalidFile', 'danger']]);
  assert.equal(geoeffnet, false);
});

test('Zuordnungsprofil uebernehmen, es wurde seit der Vorschau geaendert (409): eigener Satz, der Dialog bleibt', async () => {
  zustand();
  const wechsel = await profilWaehlen('{"mappings":[]}');
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    await mit({ post: async () => ({ data: { applicable_count: 1, entries: [], profile_digest: 'p1' } }) }, wechsel);
  } finally {
    delete globalThis.__openModal;
  }
  assert.ok(opts, 'die Vorschau oeffnet den Dialog');
  let anwenden = null;
  opts.onSave({ querySelector: (selector) => ({ addEventListener(_type, fn) { if (selector === '#wmp-apply') anwenden = fn; } }) });
  const { closed, gets } = await mit({ post: async () => { throw fehler(409, 'waste_profile_changed'); } }, () => anwenden());
  assert.deepEqual(toasts, [['waste.errorProfileChanged', 'danger']]);
  assert.deepEqual(closed, []);
  assert.deepEqual(gets, []);

  // Die Quelle ist inzwischen weg: der gewohnte Weg.
  toasts.length = 0;
  const weg = await mit({ post: async () => { throw fehler(404, 'waste_source_not_found'); } }, () => anwenden());
  assert.deepEqual(toasts, [['waste.errorSourceGone', 'danger']]);
  assert.deepEqual(weg.closed, [{ force: true }]);
});

// -------------------------------------------------------------------------
// Quelle mit Adresse: anlegen und von Hand abrufen
// -------------------------------------------------------------------------

const urlDialog = () => dialog(() => waste.openUrlSourceWizard(), {
  werte: { '#wurl-name': { value: 'Stadt' }, '#wurl-url': { value: 'https://example.org/a.ics' }, '#wurl-interval': { value: '1440' } },
});

for (const [name, err, satz, feld] of [
  ['keine Adresse', fehler(400, 'waste_source_url_invalid'), 'waste.errorSourceUrlInvalid', '#wurl-url'],
  ['ohne https', fehler(400, 'waste_source_url_not_https'), 'waste.errorSourceUrlNotHttps', '#wurl-url'],
  ['Abstand ausserhalb der Grenzen', fehler(400, 'waste_source_interval_invalid', { min: 60, max: 43200 }), 'waste.errorSourceInterval{"min":60,"max":43200}', '#wurl-interval'],
  ['die erste Auswertung trifft eine Importgrenze', fehler(400, 'waste_import_label_cap_exceeded', { limit: 200 }), 'waste.errorImportTooManyLabels{"limit":200}', null],
  ['400 ohne Grund', fehler(400), 'common.unknownError', null],
]) {
  test(`Quelle mit Adresse anlegen scheitert: der Satz im Dialog, der Fokus am gemeinten Feld - ${name}`, async () => {
    zustand();
    const d = await urlDialog();
    const { calls, closed } = await mit({ post: async () => { throw err; } }, () => d.klick('#wurl-save'));
    assert.deepEqual(calls, [['POST', '/waste/sources']]);
    assert.equal(d.element('#wurl-error').textContent, satz);
    assert.equal(d.element('#wurl-error').hidden, false);
    assert.deepEqual(toasts, []);
    assert.deepEqual(closed, []);
    assert.deepEqual(d.fokus, feld ? [feld] : []);
  });
}

const LETZTER_FEHLER = 'URL resolves to a private IP address: 10.0.0.5';
const abruf = (extra) => ({ data: { outcome: 'error', source: { id: 4, last_error: LETZTER_FEHLER }, ...extra } });

for (const [name, antwort, satz] of [
  ['gesperrte Adresse', abruf({ reason: 'waste_source_fetch_blocked' }), 'waste.errorSourceFetchBlocked'],
  ['Status der Gegenstelle', abruf({ reason: 'waste_source_fetch_http_status', params: { status: 404 } }), 'waste.errorSourceFetchStatus{"status":404}'],
  ['zu gross', abruf({ reason: 'waste_source_fetch_too_large', params: { limit_mb: 5 } }), 'waste.errorSourceFetchTooLarge{"limit_mb":5}'],
  ['nicht erreichbar', abruf({ reason: 'waste_source_fetch_unreachable' }), 'waste.errorSourceFetchUnreachable'],
  ['die Adresse antwortet ohne einen Kalendereintrag (#1938)', abruf({ reason: 'waste_source_fetch_no_events' }), 'waste.errorSourceFetchNoEvents'],
  ['ohne Grund (ein aelterer Server)', abruf({}), 'waste.errorSourceFetch'],
  ['ein Grund, den die App nicht kennt', abruf({ reason: 'waste_source_fetch_future' }), 'waste.errorSourceFetch'],
  ['die Zahl fehlt', abruf({ reason: 'waste_source_fetch_http_status' }), 'waste.errorSourceFetch'],
]) {
  test(`Der Abruf endet mit einem Fehler: der Toast sagt die Klasse, nie den gespeicherten Text - ${name}`, async () => {
    // Von Hand abrufen ...
    zustand();
    await mit({ post: async () => antwort }, () => waste.triggerManualRefresh(4));
    assert.deepEqual(toasts, [[satz, 'danger']]);
    assert.ok(!toasts.some(([text]) => text.includes('private IP')));

    // ... und beim Anlegen: die Quelle entsteht trotzdem, der Dialog geht zu.
    zustand();
    const d = await urlDialog();
    const { closed } = await mit({ post: async () => antwort }, () => d.klick('#wurl-save'));
    assert.deepEqual(toasts, [[satz, 'danger']]);
    assert.deepEqual(closed, [{ force: true, context: 'test-modal-context' }]);
  });
}

for (const [name, err, satz, laedt] of [
  ['die Quelle wird gerade aktualisiert', fehler(409, 'refresh_in_progress'), 'waste.errorSourceRefreshRunning', false],
  ['die Quelle stammt aus einer Datei', fehler(400, 'waste_source_not_url'), 'waste.errorSourceNotUrl', false],
  ['die Auswertung trifft eine Importgrenze', fehler(400, 'waste_import_event_cap_exceeded', { limit: 5000 }), 'waste.errorImportTooManyEvents{"limit":5000}', false],
  ['die Quelle gibt es nicht mehr', fehler(404, 'waste_source_not_found'), 'waste.errorSourceGone', true],
  ['500', fehler(500), 'common.errorGeneric', false],
]) {
  test(`Von Hand abrufen scheitert: der Satz der App - ${name}`, async () => {
    zustand();
    const { gets } = await mit({ post: async () => { throw err; } }, () => waste.triggerManualRefresh(4));
    assert.deepEqual(toasts, [[satz, 'danger']]);
    assert.deepEqual(gets, laedt ? NACHLADEN : []);
  });
}

// -------------------------------------------------------------------------
// Jeder Grund, den die Seite erreichen kann, kommt am Toast als sein Satz an
// -------------------------------------------------------------------------

test('reportError: jeder Abfuhr-Grund ergibt seinen Satz, und genau die "gibt es nicht mehr" laden nach', async () => {
  const { CASE_MESSAGES, CASE_PARAMS, GONE_REASONS } = await import('../public/utils/friendly-error.js');
  // Jeder Grund, dessen Satz ein Abfuhr-Satz ist - auch die drei ohne Praefix.
  const gruende = [...CASE_MESSAGES].filter(([, key]) => key.startsWith('waste.')).map(([reason]) => reason);
  assert.ok(gruende.length >= 40, `nur ${gruende.length} Gruende gelesen`);
  for (const reason of gruende) {
    zustand();
    const params = CASE_PARAMS.has(reason) ? Object.fromEntries(CASE_PARAMS.get(reason).map((name, i) => [name, 7 + i])) : undefined;
    const { gets } = await mit({}, () => waste.reportError(fehler(400, reason, params)));
    const satz = CASE_MESSAGES.get(reason) + (params ? JSON.stringify(params) : '');
    assert.deepEqual(toasts, [[satz, 'danger']], reason);
    assert.match(toasts[0][0], /^waste\./, reason);
    assert.deepEqual(gets, GONE_REASONS.has(reason) ? NACHLADEN : [], reason);
  }
});

// -------------------------------------------------------------------------
// Dritte Scheibe (#1909): der letzte Fehlschlag im Quellen-Dialog ist der Satz
// seines Falls, nie der gespeicherte Text des Servers (`last_error`)
// -------------------------------------------------------------------------

async function quellenDialogText(quelle) {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    await waste.openSourceModal(quelle);
  } finally {
    delete globalThis.__openModal;
  }
  assert.ok(opts, 'der Dialog wurde geoeffnet');
  return String(opts.content);
}

for (const [name, fall, satz] of [
  ['eine Antwort ohne Kalendereintrag', { last_error_reason: 'waste_source_fetch_no_events', last_error_params: null }, 'waste.errorSourceFetchNoEvents'],
  ['ein Status, der kein Erfolg ist', { last_error_reason: 'waste_source_fetch_http_status', last_error_params: { status: 503 } }, 'waste.errorSourceFetchStatus{"status":503}'],
  ['eine Quelle von vor der Migration, ohne gespeicherten Fall', { last_error_reason: null, last_error_params: null }, 'waste.errorSourceFetch'],
  ['ein Fall mit Zahl, deren Zahl fehlt', { last_error_reason: 'waste_source_fetch_http_status', last_error_params: null }, 'waste.errorSourceFetch'],
]) {
  test(`Quellen-Dialog: der letzte Fehlschlag in der Sprache der App - ${name}`, async () => {
    zustand();
    const text = await quellenDialogText({
      ...SOURCE(), kind: 'url', url: 'https://example.com/cal.ics',
      last_error: 'No calendar entries in the response', ...fall,
    });
    assert.ok(text.includes(`<p class="waste-source-detail__error">${satz.replace(/"/g, '&quot;')}</p>`), text.slice(0, 2000));
    assert.doesNotMatch(text, /No calendar entries in the response/);
  });
}

test('Quellen-Dialog: ohne Fehlschlag steht keine Fehlerzeile da', async () => {
  zustand();
  const text = await quellenDialogText({ ...SOURCE(), last_error: null, last_error_reason: null, last_error_params: null });
  assert.doesNotMatch(text, /waste-source-detail__error/);
});

// Re-Critique 2026-10-17: "mindestens ein Wochentag" kam als Toast - ortlos,
// mobil unten am Bildschirm, waehrend die Tage oben im Dialog standen.
test('Woechentlich ohne Tag: die Meldung steht an der Tagesgruppe, der Fokus auf dem ersten Tag, nichts geht raus', async () => {
  zustand();
  const chipFokus = [];
  const chip = { focus: () => chipFokus.push('chip') };
  let gescrollt = 0;
  const d = await terminDialog({
    '#wsm-kind': { value: 'weekly' },
    '.waste-weekday-picker': { querySelector: (sel) => (sel === '[data-weekday]' ? chip : null), scrollIntoView: () => { gescrollt += 1; } },
  });
  const gemeldet = [];
  globalThis.__reportFieldError = (feld, text, opts) => gemeldet.push([feld, text, opts]);
  let calls;
  try {
    ({ calls } = await mit({ put: async () => ({ data: {} }) }, () => d.klick('#wsm-save')));
  } finally {
    delete globalThis.__reportFieldError;
  }
  assert.deepEqual(calls, [], 'ohne Tag geht nichts an den Server');
  assert.deepEqual(toasts, [], 'kein Toast');
  assert.equal(gemeldet.length, 1);
  assert.equal(gemeldet[0][0], d.element('.waste-weekday-picker'), 'an der Tagesgruppe');
  assert.equal(gemeldet[0][1], 'waste.errorScheduleWeekdaysRequired');
  assert.deepEqual(chipFokus, ['chip'], 'der Fokus geht auf den ersten Tag');
  assert.equal(gescrollt, 1);
  const src = readFileSync(new URL('../public/pages/waste.js', import.meta.url), 'utf8');
  assert.match(src, /err\?\.data\?\.reason === 'waste_schedule_weekdays_required' && kindValue === 'weekly'\) \{\s*reportWeekdaysMissing\(panel\);/,
    'dieselbe Absage vom Server geht ebenfalls ans Feld');
  assert.match(src, /<div class="form-group form-field" id="wsm-weekly-fields"/, 'die Gruppe traegt den Feldfehler');
});

// -------------------------------------------------------------------------
// #1997: eine spaete Erfolgsantwort schliesst nur ihren EIGENEN Dialog
// -------------------------------------------------------------------------

// Kommt die Antwort erst, nachdem der Nutzer den Dialog geschlossen und einen
// anderen geoeffnet hat, darf das force-Schliessen nur den eigenen treffen. Ob
// der Slot noch denselben Dialog haelt, entscheidet closeModal({ context }) in
// components/modal.js (am echten Modul gemessen in test-modal-dead-time.js);
// hier zaehlt die Verdrahtung: jeder Erfolgsweg der Seite reicht den VOR der
// Anfrage (bei einer Rueckfrage: vor der Rueckfrage) gemerkten Kontext hinein.
// Gefahren wird je Weg der echte Handler; die Antwort auf die schreibende
// Anfrage wechselt den Kontext, wie es ein inzwischen geoeffneter Dialog tut.

/** Der Dialog der Erinnerungen, mit einer geaenderten Zeile; liefert seinen Speichern-Handler. */
async function erinnerungsDialog() {
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  globalThis.__apiStub = { get: async () => ({ data: [{ type_id: 1, type_name: 'Restmuell', enabled: false, offset_days: 1, delivery_time: '08:00' }] }) };
  try { await waste.openReminderSettingsModal(); } finally { delete globalThis.__openModal; delete globalThis.__apiStub; }
  const row = {
    dataset: { typeId: '1' },
    querySelector: (sel) => ({
      '[data-role="reminder-enabled"]': { checked: true },
      '[data-role="reminder-offset"]': { value: '2' },
      '[data-role="reminder-time"]': { value: '08:00' },
    })[sel],
  };
  const handlers = {};
  const knopf = { addEventListener(type, fn) { handlers[type] = fn; }, disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} };
  opts.onSave({
    querySelector: (sel) => (sel === '#rem-save' ? knopf : { addEventListener() {} }),
    querySelectorAll: (sel) => (sel === '.waste-reminder-setting-row' ? [row] : []),
    addEventListener() {},
  });
  return () => handlers.click();
}

/** Der Dialog des Zuordnungsprofils nach der Vorschau; liefert sein "Anwenden". */
async function profilDialog() {
  const wechsel = await profilWaehlen('{"mappings":[]}');
  let opts = null;
  globalThis.__openModal = (o) => { opts = o; };
  try {
    await mit({ post: async () => ({ data: { applicable_count: 1, entries: [], profile_digest: 'p1' } }) }, wechsel);
  } finally {
    delete globalThis.__openModal;
  }
  let anwenden = null;
  opts.onSave({
    querySelector: (selector) => ({
      disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {},
      addEventListener(_type, fn) { if (selector === '#wmp-apply') anwenden = fn; },
    }),
  });
  return () => anwenden();
}

const PICKUP = () => ({ id: 55, type_id: 1, date: '2026-03-01', note: null });
const pickupWerte = { werte: { '#wpm-type': { value: '1' }, '#wpm-date': { value: '2026-03-01' } } };

/** [Name, Vorbereitung (liefert den Ausloeser)]: jeder Weg, der nach seiner Anfrage schliesst. */
const WASTE_ERFOLGSWEGE = [
  ['Abfallart archivieren', async () => { const d = await dialog(() => waste.openTypeModal(TYPE())); return () => d.klick('#wtm-archive'); }],
  ['Abfallart loeschen', async () => { const d = await dialog(() => waste.openTypeModal(TYPE())); return () => d.klick('#wtm-delete'); }],
  ['Abfallart speichern', async () => {
    const d = await dialog(() => waste.openTypeModal(TYPE()), { werte: { '#wtm-name': { value: 'Restmuell' }, '.waste-color-swatch--active': null } });
    return () => d.klick('#wtm-save');
  }],
  ['Termin loeschen', async () => { const d = await terminDialog(); return () => d.klick('#wsm-delete'); }],
  ['Termin speichern', async () => { const d = await terminDialog(); return () => d.klick('#wsm-save'); }],
  ['Abholung loeschen', async () => { const d = await dialog(() => waste.openPickupModal(PICKUP()), pickupWerte); return () => d.klick('#wpm-delete'); }],
  ['Abholung speichern', async () => { const d = await dialog(() => waste.openPickupModal(PICKUP()), pickupWerte); return () => d.klick('#wpm-save'); }],
  ['Import-Vorschau: der Kalender ist unveraendert', async () => {
    const d = await assistent(SOURCE());
    return () => d.klick('#wiz-preview');
  }],
  ['Import uebernehmen', async () => {
    const { d } = await assistentMitVorschau([['bio', '1'], ['papier', '2']]);
    return () => d.klick('#wiz-commit');
  }],
  ['Zuordnungsprofil anwenden', profilDialog],
  ['Quelle loeschen', async () => { const d = await dialog(() => waste.openSourceModal(SOURCE())); return () => d.klick('#wsrc-delete'); }],
  ['Quelle speichern', async () => {
    const row = { dataset: { mappingId: '30' }, querySelector: () => ({ value: '2' }) };
    const d = await dialog(() => waste.openSourceModal(SOURCE()), {
      werte: { '#wsrc-name': { value: 'Kalender neu' } }, listen: { '.waste-source-mapping-row': [row] },
    });
    return () => d.klick('#wsrc-save');
  }],
  ['Quelle mit Adresse anlegen', async () => { const d = await urlDialog(); return () => d.klick('#wurl-save'); }],
  ['Erinnerungen speichern', erinnerungsDialog],
  ['Abholung verschieben', async () => {
    const d = await dialog(() => waste.moveOccurrence('1:2026-01-12'), { werte: { '#wmm-date': { value: '2026-01-13' } } });
    return () => d.klick('#wmm-save');
  }],
];

test('Erfolg nach Dialogwechsel - jeder Erfolgsweg schliesst nur mit dem Kontext von VOR der Anfrage (#1997)', async () => {
  for (const [name, vorbereiten] of WASTE_ERFOLGSWEGE) {
    zustand();
    const ausloesen = await vorbereiten();
    toasts.length = 0;
    let kontext = 'eigener-dialog';
    globalThis.__modalContextId = () => kontext;
    const wechsel = (antwort) => { kontext = 'ein-anderer-dialog'; return antwort; };
    try {
      const { calls, closed } = await mit({
        quelle: SOURCE(),
        post: async () => wechsel({ data: { unchanged: true, diff: { added: 1, changed: 0, removed: 0 }, outcome: 'committed' } }),
        put: async () => wechsel({ data: {} }),
        delete: async () => wechsel({}),
      }, ausloesen);
      assert.ok(calls.some(([verb]) => verb !== 'GET'), `${name}: der Weg schreibt (${JSON.stringify(calls)})`);
      assert.equal(toasts.some(([, art]) => art === 'danger'), false, `${name}: der Erfolg ist kein Fehler (${JSON.stringify(toasts)})`);
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen (${JSON.stringify(closed)})`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});
