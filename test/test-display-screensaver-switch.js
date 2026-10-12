/**
 * Test: The per-display screensaver switch on the wall tablets page (#1766)
 * Purpose: An administrator decides per display whether it shows the photo
 *          screensaver (the server side, gate and route, is measured in
 *          test:display-account). Tested here: the card renders the switch in
 *          the state the server reports, the real page wires it, a change sends
 *          exactly `{ show_screensaver }` to that display and confirms it, and a
 *          failed request puts the switch back and says why.
 * Run: npm run test:display-screensaver-switch (needs
 *      test/test-browser-loader.mjs for /api.js, /i18n.js and the modal)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const toasts = [];
const patches = [];
let patchResult = () => Promise.resolve({ data: {} });

globalThis.window = {
  yuvomi: { showToast: (message, type) => toasts.push({ message, type }) },
};
globalThis.__apiStub = {
  get: async () => ({ data: [] }),
  patch: (path, body) => { patches.push({ path, body }); return patchResult(path, body); },
};

const page = await import('../public/settings/pages/admin-displays.js');

function makeToggle({ id = '7', name = 'Kitchen', checked = true } = {}) {
  return { checked, disabled: false, dataset: { displayScreensaver: id, name } };
}

function makeList() {
  const handlers = {};
  return {
    handlers,
    addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: () => null,
  };
}

const errorEl = () => ({ textContent: '', hidden: true });
const changeOn = (toggle) => ({ target: { closest: (selector) => (selector === '[data-display-screensaver]' ? toggle : null) } });

async function fire(list, event) {
  await Promise.all((list.handlers.change || []).map((handler) => handler(event)));
}

test('the card shows the switch in the state the server reports', () => {
  const off = page.renderDisplay({ id: 7, display_name: 'Kitchen', show_screensaver: false, devices: [] });
  const input = off.match(/<input[^>]*id="display-screensaver-7"[^>]*>/)?.[0];
  assert.ok(input, 'one switch per display, with its own id');
  assert.match(input, /role="switch"/);
  assert.match(input, /data-display-screensaver="7"/);
  assert.doesNotMatch(input, /\schecked\b/, 'off as reported');
  assert.match(off, /settings\.displayScreensaverLabel/);
  assert.match(off, /id="display-screensaver-hint-7"[^>]*>settings\.displayScreensaverHint</);

  const on = page.renderDisplay({ id: 8, display_name: 'Hall <b>', show_screensaver: true, devices: [] });
  const onInput = on.match(/<input[^>]*id="display-screensaver-8"[^>]*>/)?.[0];
  assert.match(onInput, /\schecked\b/, 'on as reported');
  assert.match(onInput, /data-name="Hall &lt;b&gt;"/, 'the name is escaped');
});

test('the real page wires the switch to the list', async () => {
  const list = makeList();
  const nodes = {
    '#display-list': list,
    '#display-form': { addEventListener() {} },
    '#display-error': errorEl(),
  };
  const container = {
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => nodes[selector] ?? null,
  };
  await page.render(container);
  assert.equal(list.handlers.change?.length, 1, 'render() binds exactly one change handler on the list');

  patches.length = 0;
  toasts.length = 0;
  await fire(list, changeOn(makeToggle({ id: '7', checked: true })));
  assert.deepEqual(patches, [{ path: '/displays/7', body: { show_screensaver: true } }]);
});

test('a change sends exactly that display\'s choice and confirms it', async () => {
  const list = makeList();
  page.bindDisplayScreensaverSwitches(list, errorEl());
  patches.length = 0;
  toasts.length = 0;

  const toggle = makeToggle({ id: '7', name: 'Kitchen', checked: false });
  await fire(list, changeOn(toggle));
  assert.deepEqual(patches, [{ path: '/displays/7', body: { show_screensaver: false } }]);
  assert.deepEqual(toasts, [{ message: 'settings.displayScreensaverOff{"name":"Kitchen"}', type: 'success' }]);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false, 'usable again afterwards');

  toggle.checked = true;
  await fire(list, changeOn(toggle));
  assert.deepEqual(patches.at(-1), { path: '/displays/7', body: { show_screensaver: true } });
  assert.equal(toasts.at(-1).message, 'settings.displayScreensaverOn{"name":"Kitchen"}');

  // Any other change in the list (there is none today) is not this switch.
  patches.length = 0;
  await fire(list, changeOn(null));
  assert.equal(patches.length, 0);
});

test('the switch is locked while its request runs, and a new change clears an old error', async () => {
  const list = makeList();
  const error = { textContent: 'Display not found.', hidden: false };
  page.bindDisplayScreensaverSwitches(list, error);
  let release;
  patchResult = () => new Promise((resolve) => { release = resolve; });
  try {
    const toggle = makeToggle({ checked: true });
    const pending = fire(list, changeOn(toggle));
    assert.equal(toggle.disabled, true, 'a second flip cannot race the first request');
    assert.equal(error.hidden, true, 'the error from before is gone');
    assert.equal(error.textContent, '');
    release({ data: {} });
    await pending;
    assert.equal(toggle.disabled, false);
  } finally {
    patchResult = () => Promise.resolve({ data: {} });
  }
});

test('a failed request puts the switch back and says why', async () => {
  const list = makeList();
  const error = errorEl();
  page.bindDisplayScreensaverSwitches(list, error);
  toasts.length = 0;
  patchResult = () => Promise.reject(new Error('Display not found.'));
  try {
    const toggle = makeToggle({ checked: true });
    await fire(list, changeOn(toggle));
    assert.equal(toggle.checked, false, 'back to the state the server still has');
    assert.equal(toggle.disabled, false);
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Display not found.');
    assert.equal(toasts.length, 0, 'no confirmation for a change that did not happen');
  } finally {
    patchResult = () => Promise.resolve({ data: {} });
  }
});
