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

globalThis.HTMLElement = globalThis.HTMLElement ?? class HTMLElement extends EventTarget {};
globalThis.customElements = { define() {}, get() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.document.getElementById = () => null;

const { __test: waste } = await import('../public/pages/waste.js');

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason) => Object.assign(new Error(SERVER_TEXT), {
  status, data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}) },
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
async function mit({ liest = null, ...schreiben }, lauf) {
  const calls = [];
  const closed = [];
  const lese = async (path) => {
    calls.push(['GET', path.replace(/\?from=.*$/, '')]);
    if (liest) await liest(path);
    if (path.startsWith('/waste/types')) return { data: FRISCH.types };
    if (path === '/waste/schedules') return { data: FRISCH.schedules };
    if (path.startsWith('/waste/occurrences')) return { data: FRISCH.occurrences };
    if (path === '/waste/sources') return { data: FRISCH.sources };
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
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '', checked: false, hidden: false, disabled: false, dataset: {}, files: [],
        addEventListener(type, fn) { handlers.set(`${selector}:${type}`, fn); },
        focus() {}, click() {}, setAttribute() {}, getAttribute: () => null,
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

test('Termin speichern, die Abfallart wurde inzwischen geloescht: Satz ohne Rat, der Dialog geht zu, die Seite holt den frischen Stand', async () => {
  zustand();
  const d = await terminDialog();
  const { closed, gets } = await mit({
    put: async () => { throw fehler(400, 'waste_type_not_found'); },
  }, () => d.klick('#wsm-save'));

  assert.deepEqual(toasts, [['waste.errorTypeGone', 'danger']]);
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
    const wirft = async () => { throw fehler(reason.endsWith('occurrence_not_found') || reason === 'waste_type_not_found' ? 400 : 404, reason); };
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

test('reportError: jeder Abfuhr-Grund ergibt seinen Satz, und genau die "gibt es nicht mehr" laden nach', async () => {
  const { CASE_MESSAGES, GONE_REASONS } = await import('../public/utils/friendly-error.js');
  const gruende = [...CASE_MESSAGES.keys()].filter((reason) => reason.startsWith('waste_'));
  assert.ok(gruende.length >= 20);
  for (const reason of gruende) {
    zustand();
    const { gets } = await mit({}, () => waste.reportError(fehler(400, reason)));
    assert.deepEqual(toasts, [[CASE_MESSAGES.get(reason), 'danger']], reason);
    assert.match(toasts[0][0], /^waste\./, reason);
    assert.deepEqual(gets, GONE_REASONS.has(reason) ? NACHLADEN : [], reason);
  }
});
