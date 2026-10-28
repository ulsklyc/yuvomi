import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './mini-dom.js';

installMiniDom();
globalThis.window.yuvomi = { showToast() {} };
const { setPermissions } = await import('../public/permissions.js');
const { __test: birthdays } = await import('../public/pages/birthdays.js');
setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
birthdays.setContainerForTest({ querySelector: () => null });

function control(value = '') {
  return {
    value, checked: false, disabled: false, textContent: '', handlers: {}, focusCalls: 0,
    addEventListener(type, fn) { this.handlers[type] = fn; },
    focus() { this.focusCalls += 1; document.activeElement = this; },
    fire(type) { return this.handlers[type]?.(); },
  };
}

const candidate = (id, extra = {}) => ({ id, name: `Contact ${id}`, birthday: '1990-07-18', ...extra });

async function open(withBirthday = [], withoutBirthday = []) {
  const toasts = [];
  window.yuvomi.showToast = (...args) => toasts.push(args);
  const controls = new Map([
    ['#bd-import-submit', control()], ['#bd-import-cancel', control()],
    ['#bd-import-status', control()], ['[data-import-reason]', control()],
  ]);
  let html;
  let boxes;
  globalThis.__apiStub = {
    get: async (path) => ({ data: path.endsWith('/candidates') ? { withBirthday, withoutBirthday } : [] }),
  };
  globalThis.__openModal = (options) => {
    html = options.content;
    // Build controls from the rendered inputs, including any accidental ineligible rows.
    boxes = [...html.matchAll(/<input type="checkbox" value="(\d+)"/g)].map((m) => control(m[1]));
    if (html.includes('id="bd-import-toggle"')) controls.set('#bd-import-toggle', control());
    options.onSave({
      querySelector: (selector) => controls.get(selector) ?? null,
      querySelectorAll: (selector) => {
        // R23 link buttons for suggested matches are not part of the selection.
        if (selector === '[data-import-link]') return [];
        assert.equal(selector, '.bd-import__list input:not(:disabled)');
        return boxes;
      },
    });
  };
  await birthdays.openImportModal();
  return {
    html, boxes, toasts, toggle: controls.get('#bd-import-toggle'),
    submit: controls.get('#bd-import-submit'), status: controls.get('#bd-import-status'),
    cancel: controls.get('#bd-import-cancel'), reason: controls.get('[data-import-reason]'),
  };
}

test.afterEach(() => {
  for (const key of ['__apiStub', '__openModal', '__closeModal', '__isOwnModalOpen']) delete globalThis[key];
  delete document.activeElement;
});

test('bulk and individual selection keep the action label, count and announcement in sync', async () => {
  const { boxes, toggle, submit, status, reason } = await open([
    candidate(1), candidate(2), candidate(3, { already_imported: true }),
  ], [{ id: 4, name: 'No birthday' }]);
  assert.deepEqual(boxes.map((b) => b.value), ['1', '2']);
  assert.ok(boxes.every((b) => !b.checked));
  assert.equal(toggle.textContent, 'contacts.importSelectAll');
  // R24 (D4): der Primaerknopf ist nie gesperrt - ohne Wahl sagt er beim Tippen, was fehlt.
  assert.equal(submit.disabled, false);
  assert.equal(status.textContent, '', 'opening the dialog stays silent');
  await submit.fire('click');
  assert.equal(reason.textContent, 'birthdays.importNothingSelected', 'die Meldung steht am Dialog');
  assert.equal(reason.hidden, false);

  toggle.fire('click');
  assert.ok(boxes.every((b) => b.checked));
  assert.equal(toggle.textContent, 'contacts.importDeselectAll');
  assert.equal(submit.disabled, false);
  assert.match(submit.textContent, /"count":2/);
  assert.match(status.textContent, /"count":2/);

  boxes[0].checked = false;
  boxes[0].fire('change');
  assert.equal(toggle.textContent, 'contacts.importSelectAll');
  assert.match(submit.textContent, /"count":1/);
  toggle.fire('click');
  assert.ok(boxes.every((b) => b.checked), 'a partial selection selects all');
  toggle.fire('click');
  assert.ok(boxes.every((b) => !b.checked));
  assert.equal(submit.disabled, false);
  assert.equal(toggle.textContent, 'contacts.importSelectAll');
  assert.match(status.textContent, /"count":0/);
  for (const box of boxes) {
    box.checked = true;
    box.fire('change');
  }
  assert.equal(toggle.textContent, 'contacts.importDeselectAll', 'individual checks can also select all');
});

test('no bulk action appears when there are no eligible contacts', async () => {
  for (const rows of [
    [],
    [candidate(1, { already_imported: true })],
    // A row suggesting a link to an existing birthday has no checkbox to select.
    [candidate(1, { suggested_birthday_id: 9, suggested_birthday_name: 'Ingrid Miller' })],
  ]) {
    const dialog = await open(rows, [{ id: 2, name: 'No birthday' }]);
    assert.equal(dialog.toggle, undefined);
    assert.equal(dialog.boxes.length, 0);
    assert.equal(dialog.submit.disabled, false, 'R24 D4: nie gesperrt, sagt beim Tippen, was fehlt');
  }
});

test('large selections import in bounded batches and cannot change or submit twice in flight', async () => {
  const { toggle, submit, boxes } = await open(Array.from({ length: 501 }, (_, i) => candidate(i + 1)));
  toggle.fire('click');
  const writes = [];
  const toasts = [];
  window.yuvomi.showToast = (...args) => toasts.push(args);
  let finishFirst;
  globalThis.__apiStub.post = async (path, body) => {
    assert.equal(path, '/birthdays/import');
    writes.push(body.contact_ids);
    if (writes.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return { data: { imported: body.contact_ids.length } };
  };
  const saving = submit.fire('click');
  assert.equal(toggle.disabled, true);
  assert.equal(submit.disabled, true);
  assert.ok(boxes.every((b) => b.disabled));
  toggle.fire('click');
  await submit.fire('click');
  assert.equal(writes.length, 1);
  assert.ok(boxes.every((b) => b.checked));
  finishFirst();
  await saving;
  assert.deepEqual(writes.map((ids) => ids.length), [500, 1]);
  assert.deepEqual(writes.flat(), boxes.map((b) => Number(b.value)));
  assert.ok(toasts.some(([message, kind]) => kind === 'success' && /"count":501/.test(message)));
});

test('a failed later batch shows saved progress, reloads the list and preserves the total on retry', async () => {
  const { toggle, submit, boxes, toasts } = await open(Array.from({ length: 501 }, (_, i) => candidate(i + 1)));
  toggle.fire('click');
  const imported = new Set();
  let reloads = 0;
  globalThis.__apiStub.get = async (path) => {
    assert.equal(path, '/birthdays');
    reloads += 1;
    return { data: [...imported].map((id) => ({ id })) };
  };
  let calls = 0;
  globalThis.__apiStub.post = async (_path, { contact_ids }) => {
    calls += 1;
    if (calls === 2) throw new Error('Offline');
    const fresh = contact_ids.filter((id) => !imported.has(id));
    fresh.forEach((id) => imported.add(id));
    return { data: { imported: fresh.length } };
  };
  await submit.fire('click');
  assert.equal(imported.size, 500, 'completed batches remain imported after a later failure');
  assert.equal(reloads, 1, 'saved rows are reloaded even when the import is incomplete');
  assert.equal(birthdays.state.birthdays.length, 500);
  assert.ok(toasts.some(([message, kind]) => kind === 'warning'
    && message.includes('birthdays.importSuccess{"count":500}')),
  'the partial failure names the saved count');
  assert.ok(!toasts.some(([, kind]) => kind === 'success'), 'an incomplete import is not reported as complete');
  assert.equal(toggle.disabled, false);
  assert.equal(submit.disabled, false);
  assert.ok(boxes.every((b) => b.checked && !b.disabled));
  await submit.fire('click');
  assert.equal(calls, 4);
  assert.equal(imported.size, 501, 'retry imports the remainder without duplicates');
  assert.equal(reloads, 2);
  assert.ok(toasts.some(([message, kind]) => kind === 'success'
    && message.includes('birthdays.importSuccess{"count":501}')),
  'the final count includes the earlier successful batch');
});

test('a first-batch failure reports only the error and leaves the controls ready for retry', async () => {
  const { toggle, submit, boxes, toasts } = await open([candidate(1)]);
  toggle.fire('click');
  let reloads = 0;
  globalThis.__apiStub.get = async () => { reloads += 1; return { data: [] }; };
  globalThis.__apiStub.post = async () => { throw new Error('Offline'); };
  await submit.fire('click');
  assert.equal(reloads, 0, 'nothing saved means there is nothing to refresh');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'danger');
  assert.ok(!toasts[0][0].includes('birthdays.importSuccess'));
  assert.equal(submit.disabled, false);
  assert.equal(toggle.disabled, false);
  assert.ok(boxes[0].checked && !boxes[0].disabled);
});

test('a reload failure preserves the partial-save message and keeps import retry available', async (t) => {
  const { toggle, submit, boxes, toasts } = await open(Array.from({ length: 501 }, (_, i) => candidate(i + 1)));
  toggle.fire('click');
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  globalThis.__apiStub.post = async () => {
    calls += 1;
    if (calls === 2) throw new Error('Import unavailable');
    return { data: { imported: 500 } };
  };
  globalThis.__apiStub.get = async () => { throw new Error('Reload unavailable'); };
  await submit.fire('click');
  assert.equal(calls, 2, 'a failed reload does not repeat any writes');
  assert.ok(toasts.some(([message, kind]) => kind === 'warning'
    && message.includes('birthdays.importSuccess{"count":500}')));
  assert.ok(toasts.some(([message, kind]) => kind === 'warning' && message === 'common.savedReloadFailed'));
  assert.equal(submit.disabled, false);
  assert.equal(toggle.disabled, false);
  assert.ok(boxes.every((box) => box.checked && !box.disabled));
});

test('a failed import hands focus back to the import button only while its dialog is open', async () => {
  const failing = async () => { throw new Error('Offline'); };

  const lost = await open([candidate(1)]);
  lost.toggle.fire('click');
  globalThis.__apiStub.post = failing;
  document.activeElement = document.body;
  await lost.submit.fire('click');
  assert.equal(lost.submit.focusCalls, 1, 'focus dropped by the disabled button returns for the retry');

  const moved = await open([candidate(1)]);
  moved.toggle.fire('click');
  globalThis.__apiStub.post = failing;
  document.activeElement = moved.cancel;
  await moved.submit.fire('click');
  assert.equal(moved.submit.focusCalls, 0, 'focus the user moved elsewhere is left alone');

  const closed = await open([candidate(1)]);
  closed.toggle.fire('click');
  globalThis.__apiStub.post = failing;
  globalThis.__isOwnModalOpen = () => false;
  document.activeElement = document.body;
  await closed.submit.fire('click');
  assert.equal(closed.submit.focusCalls, 0, 'a dialog closed during the request gets no focus');
});
