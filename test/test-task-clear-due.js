/**
 * Modul: Faelligkeit einer Aufgabe mit EINER Aktion entfernen
 * Zweck: Wer eine Aufgabe ohne Faelligkeit haben wollte, leerte im Formular
 *        Datum und Uhrzeit einzeln und schaltete die Erinnerung ab - vergass er
 *        sie, verweigerte das Speichern mit einer Meldung ganz unten im Dialog,
 *        unter der Falz. Gemessen wird hier an den echten Nahten:
 *          - der Baustein (utils/task-due.js): welche Schreibwege er geht, in
 *            welcher Reihenfolge, was er mitnimmt und was „Rueckgaengig" damit
 *            wiederherstellt;
 *          - die Leseansicht: wann sie den Knopf im Kopf anbietet (nicht bei
 *            Serien, nicht ohne Faelligkeit, nicht wenn eine Erinnerung
 *            mitgehen muesste, die nicht gehen darf), und dass sie nach dem
 *            Entfernen offen bleibt und dem Formular den neuen Stand reicht;
 *          - das Formular: der Knopf unter Datum und Uhrzeit leert beide, nimmt
 *            die Erinnerung mit und sagt das, und die Meldungen zur Faelligkeit
 *            stehen am Feld statt unten.
 * Ausfuehren: npm run test:task-clear-due
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Ein Fenster ohne Browser: die Globals werden ueber `g` gesetzt, damit der
// Typpruefer sie nicht gegen die echten DOM-Typen haelt.
const g = /** @type {any} */ (globalThis);
g.HTMLElement = g.HTMLElement ?? class {};
g.customElements = g.customElements ?? { define() {}, get() {} };
/** @type {Map<string, string>} */
const store = new Map();
g.localStorage = {
  getItem: (/** @type {string} */ k) => (store.has(k) ? store.get(k) : null),
  setItem: (/** @type {string} */ k, /** @type {unknown} */ v) => { store.set(k, String(v)); },
  removeItem: (/** @type {string} */ k) => { store.delete(k); },
  clear: () => store.clear(),
};
import { installMiniDom } from './mini-dom.js';

installMiniDom();
g.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};

const { dueClearBody, ownRemindAts, clearTaskDue } = await import('../public/utils/task-due.js');
const { openTaskDetail, __test: detail } = await import('../public/components/task-detail.js');
const { __test: tasks } = await import('../public/pages/tasks.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

const TASK = { id: 7, title: 'Stromrechnung bezahlen', status: 'open', visibility: 'all', created_by: 2, subtasks: [],
  due_date: '2026-11-13', due_time: '18:00', countdown: 1 };
const REMINDER = { id: 3, entity_type: 'task', entity_id: 7, remind_at: '2026-11-13T16:00:00' };

/**
 * Ein API-Doppel, das jeden Aufruf mitschreibt und auf Wunsch scheitert.
 *
 * @param {{failOn?: ((method: string, url: string) => boolean) | null}} [options]
 */
function apiLog({ failOn = null } = {}) {
  /** @type {Array<[string, string, unknown]>} */
  const calls = [];
  const record = (/** @type {string} */ method) => async (/** @type {string} */ url, /** @type {unknown} */ body) => {
    calls.push([method, url, body]);
    if (failOn && failOn(method, url)) throw Object.assign(new Error('boom'), { status: 500 });
    return { data: {} };
  };
  return { calls, put: record('PUT'), delete: record('DELETE'), post: record('POST'), patch: record('PATCH'), get: record('GET') };
}

// --------------------------------------------------------
// Der Baustein
// --------------------------------------------------------

test('der Koerper leert Datum und Uhrzeit und nimmt einen gesetzten Countdown mit', () => {
  assert.deepEqual(dueClearBody({ countdown: 1 }), { due_date: null, due_time: null, countdown: 0 });
  // Nicht mitgeschickt heisst am Server „nicht angefasst" (#647) - ein
  // ungesetzter Countdown reist nicht mit.
  assert.deepEqual(dueClearBody({ countdown: 0 }), { due_date: null, due_time: null });
  assert.deepEqual(dueClearBody(null), { due_date: null, due_time: null });
});

test('die eigenen Erinnerungen kommen als Objekt, Liste oder gar nicht', () => {
  assert.deepEqual(ownRemindAts(REMINDER), ['2026-11-13T16:00:00']);
  assert.deepEqual(ownRemindAts([REMINDER, { remind_at: '' }, null]), ['2026-11-13T16:00:00']);
  assert.deepEqual(ownRemindAts(null), []);
  assert.deepEqual(ownRemindAts([]), []);
});

test('erst die Aufgabe, dann die eigene Erinnerung - und „Rueckgaengig" stellt beides wieder her', async () => {
  const api = apiLog();
  const result = await clearTaskDue(api, { ...TASK }, REMINDER);
  assert.deepEqual(api.calls, [
    ['PUT', '/tasks/7', { due_date: null, due_time: null, countdown: 0 }],
    ['DELETE', '/reminders?entity_type=task&entity_id=7', undefined],
  ]);
  assert.equal(result.reminderGone, true);
  assert.equal(result.reminderError, null);

  api.calls.length = 0;
  await result.restore();
  assert.deepEqual(api.calls, [
    ['PUT', '/tasks/7', { due_date: '2026-11-13', due_time: '18:00', countdown: 1 }],
    // PUT ersetzt die Menge in einem Zug, auch bei mehr als einer.
    ['PUT', '/reminders?entity_type=task&entity_id=7', { remind_ats: ['2026-11-13T16:00:00'] }],
  ]);
});

test('ohne Erinnerung fragt der Baustein keine Loeschung an, und „Rueckgaengig" legt keine an', async () => {
  const api = apiLog();
  const result = await clearTaskDue(api, { ...TASK, countdown: 0 }, null);
  assert.deepEqual(api.calls, [['PUT', '/tasks/7', { due_date: null, due_time: null }]]);
  assert.equal(result.reminderGone, false);
  api.calls.length = 0;
  await result.restore();
  assert.deepEqual(api.calls, [['PUT', '/tasks/7', { due_date: '2026-11-13', due_time: '18:00' }]]);
});

test('scheitert die Aufgabe, ist nichts passiert; scheitert danach die Erinnerung, sagt das Ergebnis es', async () => {
  const failTask = apiLog({ failOn: (m, url) => m === 'PUT' && url.startsWith('/tasks/') });
  await assert.rejects(() => clearTaskDue(failTask, { ...TASK }, REMINDER));
  assert.equal(failTask.calls.length, 1, 'nach der gescheiterten Aufgabe geht keine Loeschung mehr raus');

  const failReminder = apiLog({ failOn: (m) => m === 'DELETE' });
  const result = await clearTaskDue(failReminder, { ...TASK }, REMINDER);
  assert.equal(result.reminderGone, false);
  assert.ok(result.reminderError, 'der halbe Erfolg wird nicht verschwiegen');
});

// --------------------------------------------------------
// Die Leseansicht
// --------------------------------------------------------

/**
 * Die Ansicht oeffnen und die Optionen einsammeln, die sie an openDetailView gibt.
 *
 * @param {any} task
 * @param {{reminder?: object|null, edit?: any}} [options]
 * @returns {any}
 */
function viewOptions(task, { reminder = null, edit = null } = {}) {
  /** @type {any} */
  let seen = null;
  g.__openDetailView = (/** @type {any} */ options) => { seen = options; };
  try {
    openTaskDetail({ task, reminder, currentUserId: 2, edit });
  } finally {
    delete g.__openDetailView;
  }
  assert.ok(seen, 'die Leseansicht wurde gar nicht geoeffnet');
  return seen;
}

/**
 * @param {Record<string, string>} modules
 * @param {() => unknown} fn
 */
function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return fn(); } finally { clearPermissions(); }
}

test('der Knopf steht im Kopf hinter der Faelligkeit', () => {
  const head = viewOptions({ ...TASK }).head;
  assert.ok(head.subtitle, 'die Faelligkeit steht im Kopf');
  assert.equal(head.subtitleAction?.id, detail.CLEAR_DUE_BUTTON_ID);
  assert.equal(head.subtitleAction.label, 'tasks.clearDue');
  assert.equal(head.subtitleAction.icon, 'calendar-x');
  assert.equal(typeof head.subtitleAction.onClick, 'function');
});

test('kein Knopf, wo es nichts zu entfernen gibt oder das Entfernen nicht hierher gehoert', () => {
  const cases = {
    'ohne Faelligkeit': { ...TASK, due_date: null, due_time: null },
    'Serie (die naechste Instanz rechnet von der Faelligkeit)': { ...TASK, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY' },
    'in der Ablage': { ...TASK, archived_at: '2026-11-10T10:00:00Z' },
    'gesperrt und nicht die eigene (#830)': { ...TASK, locked: 1, created_by: 9 },
  };
  for (const [name, task] of Object.entries(cases)) {
    assert.equal(viewOptions(task).head.subtitleAction, null, name);
  }
  assert.ok(viewOptions({ ...TASK, due_date: null, due_time: '18:00' }).head.subtitleAction,
    'eine Uhrzeit allein ist auch eine Faelligkeit, die man loswerden will');
});

test('kein Knopf ohne Schreibrecht auf Aufgaben - und keiner, wenn die Erinnerung nicht mitgehen darf', () => {
  withAccess({ tasks: 'read' }, () => {
    assert.equal(viewOptions({ ...TASK }).head.subtitleAction, null, 'tasks: read');
  });
  withAccess({ calendar: 'read' }, () => {
    assert.equal(viewOptions({ ...TASK }, { reminder: REMINDER }).head.subtitleAction, null,
      'calendar: read mit eigener Erinnerung - das Formular verweigert genau diesen Uebergang');
    assert.ok(viewOptions({ ...TASK }).head.subtitleAction,
      'ohne Erinnerung haengt nichts am Kalenderrecht');
  });
});

test('nach dem Entfernen bleibt die Ansicht offen, zeichnet sich neu und bietet „Rueckgaengig" an', async () => {
  const api = apiLog();
  g.__apiStub = api;
  /** @type {any[]} */
  const toasts = [];
  const saved = g.window.yuvomi;
  g.window.yuvomi = { showToast: (/** @type {string} */ msg, /** @type {string} */ type, /** @type {number} */ duration, /** @type {any} */ action) => { toasts.push({ msg, type, action }); return true; } };
  let changed = 0;
  /** @type {any[]} */
  const renders = [];
  const task = { ...TASK };
  /** @type {any} */
  const live = { reminders: REMINDER, render: () => renders.push(live.reminders) };
  try {
    await detail.clearDueFromDetail(task, live, {}, { onChanged: async () => { changed += 1; } });
    assert.deepEqual(api.calls.map(([m, url]) => `${m} ${url}`), ['PUT /tasks/7', 'DELETE /reminders?entity_type=task&entity_id=7']);
    assert.equal(task.due_date, null);
    assert.equal(task.due_time, null);
    assert.equal(task.countdown, 0);
    // null, nicht []: das Formular fragt `!!reminder`, und eine leere Liste
    // schaltete dort den Erinnerungs-Schalter wieder ein (im Browser gesehen).
    assert.deepEqual(renders, [null], 'Kopf und Zeilen zeichnen sich mit dem neuen Stand neu');
    assert.equal(changed, 1, 'die Umgebung zieht nach');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].msg, 'tasks.dueAndReminderCleared');
    assert.equal(typeof toasts[0].action, 'function', 'der Toast traegt „Rueckgaengig"');

    api.calls.length = 0;
    await toasts[0].action();
    assert.deepEqual(api.calls.map(([m, url]) => `${m} ${url}`), ['PUT /tasks/7', 'PUT /reminders?entity_type=task&entity_id=7']);
    assert.equal(task.due_date, '2026-11-13');
    assert.equal(task.due_time, '18:00');
    assert.equal(live.reminders, REMINDER, 'die Erinnerung ist wieder da - auch fuer das Formular');
    assert.equal(renders.length, 2);
  } finally {
    delete g.__apiStub;
    g.window.yuvomi = saved;
  }
});

test('ohne Erinnerung sagt der Toast nur die Faelligkeit', async () => {
  g.__apiStub = apiLog();
  /** @type {any[]} */
  const toasts = [];
  const saved = g.window.yuvomi;
  g.window.yuvomi = { showToast: (/** @type {string} */ msg) => { toasts.push(msg); return true; } };
  try {
    /** @type {any} */
    const live = { reminders: null, render() {} };
    await detail.clearDueFromDetail({ ...TASK, countdown: 0 }, live, {}, { onChanged: async () => {} });
    assert.deepEqual(toasts, ['tasks.dueCleared']);
  } finally {
    delete g.__apiStub;
    g.window.yuvomi = saved;
  }
});

test('das Formular aus der Leseansicht bekommt den aktuellen Erinnerungsstand mit', () => {
  /** @type {any[]} */
  const mounts = [];
  const options = viewOptions({ ...TASK }, {
    reminder: REMINDER,
    edit: { mount: (/** @type {any[]} */ ...args) => mounts.push(args), standalone: (/** @type {any} */ live) => mounts.push(['standalone', live]) },
  });
  options.edit.mount('panel', 'pane');
  options.edit.standalone();
  assert.deepEqual(mounts[0], ['panel', 'pane', { reminder: REMINDER }]);
  assert.deepEqual(mounts[1], ['standalone', { reminder: REMINDER }]);
});

// --------------------------------------------------------
// Das Formular
// --------------------------------------------------------

test('der Knopf unter Datum und Uhrzeit steht nur, wenn es eine Faelligkeit gibt', () => {
  const withDue = tasks.renderDueClear({ ...TASK }, null);
  assert.match(withDue, /id="task-due-clear"/);
  assert.match(withDue, /tasks\.clearDue/);
  assert.doesNotMatch(withDue, /id="task-due-clear-row" hidden/);
  assert.doesNotMatch(withDue, /id="task-due-clear" hidden/);
  assert.match(withDue, /id="task-due-clear-hint"[^>]*\shidden/, 'der Hinweis wartet auf den Klick');

  const without = tasks.renderDueClear({ ...TASK, due_date: null, due_time: null }, null);
  assert.match(without, /id="task-due-clear-row" hidden/, 'eine neue Aufgabe ohne Datum zeigt ihn nicht');

  // Der Abschnitt steht im echten Dialog direkt unter dem Paar aus Datum und Uhrzeit.
  const html = tasks.renderModalContent(/** @type {any} */ ({ task: { ...TASK }, users: [], reminder: null }));
  const pair = html.indexOf('id="task-due-time"');
  const clear = html.indexOf('id="task-due-clear-row"');
  assert.ok(pair > 0 && clear > pair, 'unter Datum und Uhrzeit');
  assert.ok(clear < html.indexOf('id="task-priority"'), 'vor Prioritaet und Kategorie');
});

test('kein Knopf, wenn eine gesperrte Erinnerung haengt - das Speichern verweigerte genau das', () => {
  withAccess({ calendar: 'read' }, () => {
    assert.equal(tasks.renderDueClear({ ...TASK }, REMINDER), '');
    assert.notEqual(tasks.renderDueClear({ ...TASK }, null), '', 'ohne Erinnerung schon');
  });
});

/** Ein Feld-Doppel: Wert, Ereignisse, Fokus - mehr fasst wireDueClear nicht an. */
class Field extends EventTarget {
  constructor(value = '') {
    super();
    this.value = value;
    /** @type {string[]} */
    this.events = [];
    this.inner = { focus: () => { focused = this; } };
  }
  /** @param {Event} event */
  dispatchEvent(event) { this.events.push(event.type); return super.dispatchEvent(event); }
  /** @param {string} sel */
  querySelector(sel) { return sel === 'input' ? this.inner : null; }
}
class Toggle extends EventTarget {
  /** @param {boolean} checked */
  constructor(checked) { super(); this.checked = checked; this.disabled = false; }
}
/** @type {Field|null} */
let focused = null;

/**
 * @param {{date?: string, time?: string, toggle?: boolean|null, stored?: string|null}} [options]
 */
function panelWith({ date = '2026-11-13', time = '18:00', toggle = true, stored = '2026-11-13T16:00:00' } = {}) {
  /** @type {Record<string, any>} */
  const els = {
    '#task-due-clear-row': { hidden: false },
    '#task-due-clear': Object.assign(new EventTarget(), { hidden: false }),
    '#task-due-clear-hint': { hidden: true },
    '#task-due-date': new Field(date),
    '#task-due-time': new Field(time),
    '#reminder-toggle': toggle === null ? null : new Toggle(toggle),
    '#reminder-stored-at': stored === null ? null : { value: stored },
  };
  return { els, panel: { querySelector: (/** @type {string} */ sel) => els[sel] ?? null } };
}

test('ein Klick leert Datum und Uhrzeit, schaltet die Erinnerung ab und sagt, dass sie beim Speichern geht', () => {
  const { els, panel } = panelWith();
  let toggleChanged = 0;
  els['#reminder-toggle'].addEventListener('change', () => { toggleChanged += 1; });
  tasks.wireDueClear(panel);
  focused = null;
  els['#task-due-clear'].dispatchEvent(new Event('click'));

  assert.equal(els['#task-due-date'].value, '');
  assert.equal(els['#task-due-time'].value, '');
  // Beide Ereignisse an beiden Feldern: der Countdown-Riegel und die
  // Erinnerungs-Anzeige hoeren auf genau diese (wireCountdownGate,
  // wireReminderAfterDue) - ohne sie hinge der Countdown-Schalter.
  assert.deepEqual(els['#task-due-date'].events, ['input', 'change']);
  assert.deepEqual(els['#task-due-time'].events, ['input', 'change']);
  assert.equal(els['#reminder-toggle'].checked, false);
  assert.equal(toggleChanged, 1, 'der Schalter meldet sich, damit die Felder darunter zuklappen');
  assert.equal(els['#task-due-clear-hint'].hidden, false, 'der Hinweis steht da');
  assert.equal(els['#task-due-clear'].hidden, true, 'nichts mehr zu entfernen');
  assert.equal(els['#task-due-clear-row'].hidden, false, 'die Zeile bleibt fuer den Hinweis');
  assert.equal(focused, els['#task-due-date'], 'der Fokus geht ins Datumsfeld, nicht verloren');

  // Wer die Erinnerung wieder einschaltet, hat entschieden: der Hinweis geht.
  els['#reminder-toggle'].checked = true;
  els['#reminder-toggle'].dispatchEvent(new Event('change'));
  assert.equal(els['#task-due-clear-hint'].hidden, true);
  assert.equal(els['#task-due-clear-row'].hidden, true);

  // Ein neues Datum bringt den Knopf zurueck.
  els['#task-due-date'].value = '2026-11-20';
  els['#task-due-date'].dispatchEvent(new Event('input'));
  assert.equal(els['#task-due-clear'].hidden, false);
  assert.equal(els['#task-due-clear-row'].hidden, false);
});

test('ohne gespeicherte Erinnerung kein Hinweis - es wird ja nichts geloescht', () => {
  const { els, panel } = panelWith({ stored: '' });
  tasks.wireDueClear(panel);
  els['#task-due-clear'].dispatchEvent(new Event('click'));
  assert.equal(els['#reminder-toggle'].checked, false, 'der Schalter geht trotzdem aus');
  assert.equal(els['#task-due-clear-hint'].hidden, true);
  assert.equal(els['#task-due-clear-row'].hidden, true);
});

test('ein gesperrter Schalter wird nicht angefasst, und ohne Abschnitt geht es auch', () => {
  const locked = panelWith();
  locked.els['#reminder-toggle'].disabled = true;
  tasks.wireDueClear(locked.panel);
  locked.els['#task-due-clear'].dispatchEvent(new Event('click'));
  assert.equal(locked.els['#reminder-toggle'].checked, true);

  const none = panelWith({ toggle: null, stored: null });
  tasks.wireDueClear(none.panel);
  none.els['#task-due-clear'].dispatchEvent(new Event('click'));
  assert.equal(none.els['#task-due-date'].value, '');
  assert.equal(none.els['#task-due-clear-row'].hidden, true);
});

// --------------------------------------------------------
// Der gefahrene Absende-Pfad: wo die Meldungen zur Faelligkeit landen
// --------------------------------------------------------

/**
 * Faehrt handleFormSubmit gegen einen Attrappen-Dialog (dasselbe Muster wie
 * test:module-readonly-ui) und gibt zurueck, was am Feld gemeldet wurde, was
 * unten in der Fehlerzeile steht, ob sie ins Bild gerollt wurde und was an den
 * Server ging.
 *
 * @param {{dueDate?: string, dueTime?: string, reminderChecked?: boolean, modules?: Record<string, string>,
 *          dueDateWhenOpened?: string, offset?: string}} options
 */
async function submitWith({ dueDate = '', dueTime = '', reminderChecked = true, modules = {}, dueDateWhenOpened = '', offset = 'offset_1d' }) {
  /** @type {any[]} */
  const calls = [];
  const record = (/** @type {string} */ method) => async (/** @type {string} */ path, /** @type {unknown} */ body) => {
    calls.push({ method, path, body });
    return { data: null };
  };
  g.__apiStub = { get: record('get'), post: record('post'), put: record('put'), patch: record('patch'), delete: record('delete') };
  g.__rruleValues = { is_recurring: 0, recurrence_rule: null, recurrence_from_completion: 0, valid_until: true };
  /** @type {any[]} */
  const fieldErrors = [];
  g.__reportFieldError = (/** @type {any} */ field, /** @type {string} */ msg) => { fieldErrors.push({ field, msg }); };
  let scrolled = 0;
  const errorNode = { hidden: true, textContent: '', scrollIntoView: () => { scrolled += 1; } };
  /** @type {Record<string, any>} */
  const nodes = {
    'task-form-error': errorNode,
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': { value: '7' },
  };
  const realDocument = g.document;
  g.document = {
    getElementById: (/** @type {string} */ id) => nodes[id] ?? null,
    documentElement: { lang: 'de', classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
    addEventListener() {},
  };
  const savedYuvomi = g.window.yuvomi;
  g.window.yuvomi = { showToast() {} };
  const dateField = { id: 'task-due-date', value: dueDate };
  const timeField = { id: 'task-due-time', value: dueTime };
  /** @type {Record<string, any>} */
  const byId = {
    '#task-due-date': dateField,
    '#task-due-time': timeField,
    '#reminder-toggle': { checked: reminderChecked },
    '#reminder-offset': { value: offset },
    '#task-visibility': { value: 'all' },
    '.reminder-section[data-locked-due]': dueDateWhenOpened ? { dataset: { lockedDue: dueDateWhenOpened } } : null,
  };
  /** @type {Record<string, any>} */
  const form = { querySelector: (/** @type {string} */ sel) => byId[sel] ?? null };
  for (const [name, value] of Object.entries({
    title: 'Stromrechnung bezahlen', description: '', priority: 'none', category: 'household',
    start_date: '', due_date: dueDate, due_time: dueTime, points: '0',
  })) form[name] = { value };
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    await tasks.handleFormSubmit({ preventDefault() {}, target: form }, { container: null, onChanged: async () => {} });
  } finally {
    clearPermissions();
    delete g.__apiStub;
    delete g.__rruleValues;
    delete g.__reportFieldError;
    g.document = realDocument;
    g.window.yuvomi = savedYuvomi;
  }
  return { calls, fieldErrors, dateField, timeField, bottom: errorNode.hidden ? null : errorNode.textContent, scrolled,
    button: nodes['task-submit-btn'] };
}

test('Erinnerung an, Datum leer: die Meldung steht am Datumsfeld, nicht unten - und nichts geht raus', async () => {
  const r = await submitWith({ dueDate: '', dueTime: '18:00' });
  assert.deepEqual(r.fieldErrors.map((e) => [e.field.id, e.msg]), [['task-due-date', 'tasks.reminderNeedsDueDate']]);
  assert.equal(r.bottom, null, 'die Zeile ganz unten bleibt leer - dort sah sie keiner');
  assert.equal(r.calls.length, 0, 'nichts gespeichert');
  assert.equal(r.button.disabled, false, 'der Knopf ist wieder bedienbar');
  assert.equal(r.button.textContent, 'common.save');
});

test('die gesperrte Erinnerung meldet sich ebenfalls am Datumsfeld', async () => {
  const r = await submitWith({ dueDate: '', modules: { calendar: 'read' }, dueDateWhenOpened: '2026-11-13' });
  assert.deepEqual(r.fieldErrors.map((e) => [e.field.id, e.msg]), [['task-due-date', 'tasks.reminderLockedNeedsDueDate']]);
});

test('Meldungen, die kein Feld haben, bleiben unten - und rollen ins Bild', async () => {
  // Erinnerung an, Vorlauf „Keine": die Meldung ist (noch) dieselbe wie ohne
  // Datum, obwohl eins da ist - Frage an den Maintainer, hier nur der Ort.
  const r = await submitWith({ dueDate: '2026-11-13', offset: 'offset_none' });
  assert.equal(r.fieldErrors.length, 0);
  assert.equal(r.bottom, 'tasks.reminderNeedsDueDate');
  assert.equal(r.scrolled, 1, 'die Zeile unten rollt ins Bild, statt unter der Falz zu warten');
});

test('ohne Faelligkeit und ohne Erinnerung speichert der Dialog beide Felder als leer', async () => {
  const r = await submitWith({ dueDate: '', dueTime: '', reminderChecked: false });
  assert.equal(r.fieldErrors.length, 0);
  const put = r.calls.find((c) => c.method === 'put' && c.path === '/tasks/7');
  assert.ok(put, 'die Aufgabe geht raus');
  assert.equal(put.body.due_date, null);
  assert.equal(put.body.due_time, null);
});
