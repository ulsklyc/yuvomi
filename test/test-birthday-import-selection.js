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
    value, checked: false, disabled: false, textContent: '', handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    fire(type) { return this.handlers[type]?.(); },
  };
}

const candidate = (id, extra = {}) => ({ id, name: `Contact ${id}`, birthday: '1990-07-18', ...extra });

async function open(withBirthday = [], withoutBirthday = []) {
  const controls = new Map([
    ['#bd-import-submit', control()], ['#bd-import-cancel', control()],
    ['#bd-import-status', control()],
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
        assert.equal(selector, '.bd-import__list input:not(:disabled)');
        return boxes;
      },
    });
  };
  await birthdays.openImportModal();
  return {
    html, boxes, toggle: controls.get('#bd-import-toggle'),
    submit: controls.get('#bd-import-submit'), status: controls.get('#bd-import-status'),
  };
}

test.afterEach(() => {
  for (const key of ['__apiStub', '__openModal', '__closeModal']) delete globalThis[key];
});

test('bulk and individual selection keep the action label, count and announcement in sync', async () => {
  const { boxes, toggle, submit, status } = await open([
    candidate(1), candidate(2), candidate(3, { already_imported: true }),
  ], [{ id: 4, name: 'No birthday' }]);
  assert.deepEqual(boxes.map((b) => b.value), ['1', '2']);
  assert.ok(boxes.every((b) => !b.checked));
  assert.equal(toggle.textContent, 'contacts.importSelectAll');
  assert.equal(submit.disabled, true);
  assert.equal(status.textContent, '', 'opening the dialog stays silent');

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
  assert.equal(submit.disabled, true);
  assert.equal(toggle.textContent, 'contacts.importSelectAll');
  assert.match(status.textContent, /"count":0/);
  for (const box of boxes) {
    box.checked = true;
    box.fire('change');
  }
  assert.equal(toggle.textContent, 'contacts.importDeselectAll', 'individual checks can also select all');
});

test('no bulk action appears when there are no eligible contacts', async () => {
  for (const rows of [[], [candidate(1, { already_imported: true })]]) {
    const dialog = await open(rows, [{ id: 2, name: 'No birthday' }]);
    assert.equal(dialog.toggle, undefined);
    assert.equal(dialog.boxes.length, 0);
    assert.equal(dialog.submit.disabled, true);
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

test('a failed later batch keeps the selection available for an idempotent retry', async () => {
  const { toggle, submit, boxes } = await open(Array.from({ length: 501 }, (_, i) => candidate(i + 1)));
  toggle.fire('click');
  const imported = new Set();
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
  assert.equal(toggle.disabled, false);
  assert.equal(submit.disabled, false);
  assert.ok(boxes.every((b) => b.checked && !b.disabled));
  await submit.fire('click');
  assert.equal(calls, 4);
  assert.equal(imported.size, 501, 'retry imports the remainder without duplicates');
});
