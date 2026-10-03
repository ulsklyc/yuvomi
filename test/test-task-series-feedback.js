/**
 * Test: Rueckmeldung nach dem Abhaken einer Serie (#1603)
 *
 * Wer eine wiederkehrende Aufgabe abhakt, sah „nichts passieren": der Server
 * legt im selben Schreibvorgang die Folgeinstanz an, die Ansicht laedt neu und
 * zeigt eine offene Zeile, die aussieht wie die eben erledigte - bei „ab
 * Erledigung wiederholen" sogar mit demselben Datum. Der Haken war gebucht,
 * nur sagte es niemand.
 *
 * Die Antwort von PATCH /tasks/:id/status traegt deshalb `next_due_date`
 * (test:tasks-recurrence haelt die Route), und JEDER Abhak-Weg sagt es:
 *
 *   - Detailansicht: Erledigen-Knopf und „Wer hat es erledigt?"
 *   - Liste: Haken, Wisch, Personenwahl (auch am Wandtablett)
 *   - Brett: Spaltenwechsel nach „Erledigt" (Zug und Weiterschalt-Knopf)
 *
 * Gemessen wird am laufenden Aufruf, nicht am Quelltext: ein Helfer, den
 * niemand ruft, ist derselbe Ausfall wie keiner. `t()` ist im Loader ein Stub
 * (Schluessel + Werte) - WELCHER Text und WELCHES Datum, steht damit fest; dass
 * die Schluessel in jeder Sprache existieren und ihre Platzhalter tragen, haelt
 * test:i18n.
 *
 * Ausfuehren: npm run test:task-series-feedback
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom } from './mini-dom.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
globalThis.window = globalThis.window ?? {};
const toasts = [];
globalThis.window.yuvomi = {
  showToast: (message, type = 'default', duration = 3000, onUndo = null) => {
    toasts.push({ message, type, duration, onUndo });
  },
};

const { seriesDoneText } = await import('../public/utils/task-fields.js');
const { nowFields } = await import('../public/utils/timezone.js');
const { openTaskDetail, __test: detail } = await import('../public/components/task-detail.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

// Ein Tag im LAUFENDEN Jahr der Haushaltszone und einer im naechsten: der
// Helfer laesst das Jahr weg, wo es nichts unterscheidet (formatDueDate).
const YEAR = nowFields().year;
const THIS_YEAR = `${YEAR}-06-15`;
const NEXT_YEAR = `${YEAR + 1}-01-03`;
const answer = (next) => ({ data: { id: 7, status: 'done', archived_at: null, next_due_date: next } });
const SERIES = `tasks.seriesDoneToast${JSON.stringify({ date: `kurz:${THIS_YEAR}` })}`;
const SERIES_BY = (name) => `tasks.seriesDoneByToast${JSON.stringify({ name, date: `kurz:${THIS_YEAR}` })}`;

test.beforeEach(() => {
  toasts.length = 0;
  globalThis.__formatDayMonth = (d) => `kurz:${d}`;
});
test.afterEach(() => {
  delete globalThis.__apiStub;
  delete globalThis.__openDetailView;
  delete globalThis.__formatDayMonth;
  tasks.state.user = null;
  tasks.state.users = [];
  tasks.state.displayPeople = [];
  tasks.state.tasks = [];
});

// ── Der Helfer ────────────────────────────────────────────────────────────

test('seriesDoneText: ohne Folgeinstanz gibt es keinen Text', () => {
  assert.equal(seriesDoneText(answer(null)), null);
  assert.equal(seriesDoneText({ data: { id: 7, status: 'done' } }), null, 'ein aelterer Server ohne das Feld');
  assert.equal(seriesDoneText({ data: null }), null);
  assert.equal(seriesDoneText(undefined), null);
  assert.equal(seriesDoneText(answer('kein Datum')), null, 'Unlesbares wird nicht als Datum ausgegeben');
});

test('seriesDoneText: nennt das Datum ueber die Formatierer der App, mit Jahr nur, wo es etwas sagt', () => {
  assert.equal(seriesDoneText(answer(THIS_YEAR)), SERIES);
  // Naechstes Jahr: formatDate (im Stub der unveraenderte Key), nicht Tag+Monat.
  assert.equal(
    seriesDoneText(answer(NEXT_YEAR)),
    `tasks.seriesDoneToast${JSON.stringify({ date: NEXT_YEAR })}`,
  );
});

test('seriesDoneText: mit benannter Person EIN Text, der beides sagt', () => {
  assert.equal(seriesDoneText(answer(THIS_YEAR), { name: 'Mia' }), SERIES_BY('Mia'));
  assert.equal(seriesDoneText(answer(null), { name: 'Mia' }), null);
});

test('beide Texte stehen in der Referenzsprache und tragen ihre Platzhalter', () => {
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  assert.match(de.tasks.seriesDoneToast ?? '', /\{\{date\}\}/);
  assert.match(de.tasks.seriesDoneByToast ?? '', /\{\{date\}\}/);
  assert.match(de.tasks.seriesDoneByToast ?? '', /\{\{name\}\}/);
  // Hyphen statt Gedankenstrich (CONTRIBUTING, "Hyphens, not dashes").
  assert.doesNotMatch(`${de.tasks.seriesDoneToast}${de.tasks.seriesDoneByToast}`, /[–—]/);
});

// ── Detailansicht ─────────────────────────────────────────────────────────

const BASIS = { id: 7, title: 'Blumen giessen', visibility: 'all', created_by: 2, subtasks: [] };

async function finishInDetail(response, action = 'task-detail-finish', status = 'open') {
  let options = null;
  globalThis.__openDetailView = (o) => { options = o; };
  globalThis.__apiStub = { patch: async () => response };
  const task = { ...BASIS, status };
  openTaskDetail({ task, currentUserId: 2, categories: [{ key: 'household' }], onChanged: async () => {} });
  const step = options.actions.find((a) => a.id === action);
  assert.ok(step, `die Ansicht bietet ${action} nicht an`);
  await step.onClick({ button: { id: action }, close: async () => {} });
  return task;
}

test('Detailansicht: Erledigen einer Serie sagt, wann es weitergeht', async () => {
  const task = await finishInDetail(answer(THIS_YEAR));
  assert.equal(task.status, 'done');
  assert.deepEqual(toasts.map((x) => x.message), [SERIES]);
  assert.notEqual(toasts[0].type, 'danger');
});

test('Detailansicht: ohne Serie bleibt es still wie bisher, und Starten sagt nichts', async () => {
  await finishInDetail(answer(null));
  assert.deepEqual(toasts, []);
  // Starten ist kein Erledigen. Der Server liefert dort null - und selbst wenn
  // nicht, haengt der Hinweis am Uebergang nach „erledigt".
  await finishInDetail({ data: { id: 7, status: 'in_progress', next_due_date: THIS_YEAR } }, 'task-detail-start');
  assert.deepEqual(toasts, []);
});

test('Detailansicht: scheitert das Erledigen, steht nur der Fehler da', async () => {
  let options = null;
  globalThis.__openDetailView = (o) => { options = o; };
  globalThis.__apiStub = { patch: async () => { throw new Error('Serverfehler'); } };
  openTaskDetail({ task: { ...BASIS, status: 'open' }, currentUserId: 2, categories: [{ key: 'household' }] });
  await options.actions.find((a) => a.id === 'task-detail-finish').onClick({ button: {}, close: async () => {} });
  assert.deepEqual(toasts.map((x) => [x.message, x.type]), [['Serverfehler', 'danger']]);
});

test('Detailansicht, Personenwahl: genau EIN Toast - mit Serie der kombinierte, ohne der bisherige', async () => {
  const ctx = { onChanged: async () => {} };
  const person = { id: 3, display_name: 'Mia' };
  let body = null;
  globalThis.__apiStub = { patch: async (_path, sent) => { body = sent; return answer(THIS_YEAR); } };
  await detail.completeFor({ ...BASIS, status: 'open' }, person, { id: 'task-detail-done-by' }, ctx, async () => {});
  assert.deepEqual(body, { status: 'done', done_by_user_id: 3 });
  assert.deepEqual(toasts.map((x) => x.message), [SERIES_BY('Mia')]);

  toasts.length = 0;
  globalThis.__apiStub = { patch: async () => answer(null) };
  await detail.completeFor({ ...BASIS, status: 'open' }, person, { id: 'task-detail-done-by' }, ctx, async () => {});
  assert.deepEqual(toasts.map((x) => x.message), [`tasks.doneByToast${JSON.stringify({ name: 'Mia' })}`]);
});

// ── Liste ─────────────────────────────────────────────────────────────────

test('Liste, Haken und Wisch: die Quittung nennt bei einer Serie das naechste Mal und behaelt den Rueckweg', async () => {
  tasks.acknowledgeStatusToggle(null, 7, 'done', answer(THIS_YEAR));
  assert.deepEqual(toasts.map((x) => x.message), [SERIES]);
  assert.equal(typeof toasts[0].onUndo, 'function', 'Rueckgaengig bleibt angeboten');
  assert.equal(toasts[0].duration, 5000);

  // Der Rueckweg schaltet zurueck - und zwar von „erledigt" aus.
  const sent = [];
  globalThis.__apiStub = { patch: async (path, body) => { sent.push([path, body]); return answer(null); } };
  await toasts[0].onUndo();
  assert.deepEqual(sent, [['/tasks/7/status', { status: 'open' }]]);
});

test('Liste, Haken und Wisch: ohne Serie und beim Wiederoeffnen bleibt der bisherige Text', () => {
  tasks.acknowledgeStatusToggle(null, 7, 'done', answer(null));
  tasks.acknowledgeStatusToggle(null, 7, 'open', { data: { id: 7, status: 'open', next_due_date: null } });
  assert.deepEqual(toasts.map((x) => x.message), ['tasks.swipedDoneToast', 'tasks.swipedOpenToast']);
});

test('Liste: Haken und Wisch reichen die ANTWORT ihres Schreibvorgangs an die Quittung', () => {
  // Der Klick-Handler und die Wischgeste haengen an echtem DOM; was sie mit der
  // Antwort tun, laesst sich hier nur lesen. Die Quittung selbst ist oben am
  // laufenden Aufruf gemessen.
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  // Je Aufrufstelle: im Abschnitt davor steht der Schreibvorgang, dessen
  // Antwort in `response` landet - und genau die geht in die Quittung.
  const sites = [...src.matchAll(/(?<!function )acknowledgeStatusToggle\(container, \w+, nextStatus, response\)/g)];
  assert.equal(sites.length, 2, 'Haken und Wisch rufen beide die geteilte Quittung');
  for (const site of sites) {
    const before = src.slice(Math.max(0, site.index - 600), site.index);
    assert.match(before, /const response = await toggleTaskStatus\(\w+, \w+\);/,
      'die Quittung bekommt die Antwort von toggleTaskStatus');
  }
});

test('Liste, Personenwahl: genau EIN Toast - mit Serie der kombinierte, ohne der bisherige', async () => {
  tasks.state.users = [{ id: 3, display_name: 'Mia' }];
  globalThis.__apiStub = { patch: async () => answer(THIS_YEAR) };
  await tasks.completeTaskFor(null, 7, 3);
  assert.deepEqual(toasts.map((x) => x.message), [SERIES_BY('Mia')]);
  assert.equal(typeof toasts[0].onUndo, 'function');

  toasts.length = 0;
  globalThis.__apiStub = { patch: async () => answer(null) };
  await tasks.completeTaskFor(null, 7, 3);
  assert.deepEqual(toasts.map((x) => x.message), [`tasks.doneByToast${JSON.stringify({ name: 'Mia' })}`]);
});

test('Wandtablett: derselbe Text, aber weiter ohne Rueckweg (#1209)', async () => {
  tasks.state.user = { id: 9, access_scope: 'display' };
  tasks.state.displayPeople = [{ id: 3, display_name: 'Mia' }];
  globalThis.__apiStub = { patch: async () => answer(THIS_YEAR) };
  await tasks.completeTaskFor(null, 7, 3);
  assert.deepEqual(toasts.map((x) => x.message), [SERIES_BY('Mia')]);
  assert.equal(toasts[0].onUndo, null);
});

// ── Brett ─────────────────────────────────────────────────────────────────

test('Brett: der Spaltenwechsel nach „Erledigt" sagt es bei einer Serie, sonst nichts', async () => {
  const sent = [];
  let response = answer(THIS_YEAR);
  globalThis.__apiStub = {
    patch: async (path, body) => { sent.push([path, body]); return response; },
    get: async () => ({ data: [] }),
  };
  const container = { querySelector: () => null, querySelectorAll: () => [] };
  tasks.state.viewMode = 'kanban';
  try {
    await tasks.runColumnMove({ id: 7, status: 'open', archived_at: null }, 'done', container);
    assert.deepEqual(sent, [['/tasks/7/status', { status: 'done' }]]);
    assert.deepEqual(toasts.map((x) => x.message), [SERIES]);

    toasts.length = 0;
    response = answer(null);
    await tasks.runColumnMove({ id: 8, status: 'open', archived_at: null }, 'done', container);
    await tasks.runColumnMove({ id: 8, status: 'done', archived_at: null }, 'open', container);
    assert.deepEqual(toasts, []);
  } finally {
    tasks.state.viewMode = 'list';
  }
});

// ── Bearbeiten-Formular (#1620) ───────────────────────────────────────────
//
// Das Status-Feld im Formular speichert ueber PUT /tasks/:id. Der Weg hakt
// genauso ab und legt genauso die Folgeinstanz an, sagte aber nur
// „gespeichert". Gefahren wird der echte Submit-Handler gegen ein
// Attrappen-Formular (dasselbe Vorgehen wie in test:module-readonly-ui): ob
// der Helfer GERUFEN wird, steht nur am Aufrufer.

const feld = (value = '') => ({ value: String(value) });

async function saveInEditForm({ status, response, taskId = '7' }) {
  const calls = [];
  globalThis.__apiStub = {
    put: async (path, body) => { calls.push(['put', path, body]); return response; },
    post: async (path, body) => { calls.push(['post', path, body]); return { data: { id: 7 } }; },
    delete: async (path) => { calls.push(['delete', path]); return { data: null }; },
    get: async () => ({ data: [] }),
    getWithSource: async () => ({ data: { data: [] }, fromCache: false }),
  };
  globalThis.__rruleValues = {
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 0, valid_until: true,
  };
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': feld(taskId),
  };
  const realDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => nodes[id] ?? null,
    documentElement: realDocument.documentElement,
    addEventListener() {},
  };
  const form = { querySelector: () => null };
  const fields = {
    title: 'Blumen giessen', description: '', priority: 'none', category: 'household',
    start_date: '', due_date: THIS_YEAR, due_time: '', points: '0',
  };
  for (const [name, value] of Object.entries(fields)) form[name] = feld(value);
  // Unteraufgaben und neue Aufgaben haben kein Status-Feld.
  if (status) form.status = feld(status);
  try {
    await tasks.handleFormSubmit(
      { preventDefault() {}, target: form },
      { container: null, onChanged: async () => {} },
    );
  } finally {
    delete globalThis.__rruleValues;
    globalThis.document = realDocument;
  }
  return { calls, error: nodes['task-form-error'].hidden ? null : nodes['task-form-error'].textContent };
}

const saved = (next, status = 'done') => ({ data: { id: 7, title: 'Blumen giessen', status, next_due_date: next } });

test('Formular: wer eine Serie ueber das Status-Feld erledigt, liest, wann es weitergeht', async () => {
  const { calls, error } = await saveInEditForm({ status: 'done', response: saved(THIS_YEAR) });
  assert.equal(error, null);
  const put = calls.find((c) => c[0] === 'put');
  assert.equal(put[1], '/tasks/7');
  assert.equal(put[2].status, 'done');
  // EIN Toast, nicht „gespeichert" und darueber noch der Serienhinweis.
  assert.deepEqual(toasts.map((x) => [x.message, x.type]), [[SERIES, 'success']]);
});

test('Formular: ohne naechstes Mal bleibt es beim schlichten „gespeichert"', async () => {
  await saveInEditForm({ status: 'done', response: saved(null) });
  await saveInEditForm({ status: 'open', response: saved(null, 'open') });
  // Ein aelterer Server (oder eine zwischengespeicherte Antwort) ohne das Feld.
  await saveInEditForm({ status: 'done', response: { data: { id: 7, status: 'done' } } });
  assert.deepEqual(toasts.map((x) => x.message), ['tasks.savedToast', 'tasks.savedToast', 'tasks.savedToast']);
});

test('Formular: der Hinweis haengt am Erledigen, nicht an einem Datum in der Antwort', async () => {
  // Der Server liefert das Feld nur beim Uebergang nach „erledigt". Selbst wenn
  // nicht: wer nur den Titel aendert oder die Aufgabe startet, hat nichts
  // erledigt - dieselbe Vorsicht wie in der Detailansicht.
  await saveInEditForm({ status: 'in_progress', response: saved(THIS_YEAR, 'in_progress') });
  await saveInEditForm({ status: null, response: saved(THIS_YEAR, 'open') });
  assert.deepEqual(toasts.map((x) => x.message), ['tasks.savedToast', 'tasks.savedToast']);
});

test('Formular: das Anlegen einer Aufgabe sagt weiter „angelegt"', async () => {
  const { calls } = await saveInEditForm({ status: null, response: saved(THIS_YEAR), taskId: '' });
  assert.ok(calls.some((c) => c[0] === 'post' && c[1] === '/tasks'));
  assert.deepEqual(toasts.map((x) => x.message), ['tasks.createdToast']);
});
