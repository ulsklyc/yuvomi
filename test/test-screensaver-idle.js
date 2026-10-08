/**
 * Test: Screensaver idle delay per device (#885)
 * Purpose: The delay before the photo screensaver starts is a device-local
 *          choice like wall mode. Tested here: the module only ever applies one
 *          of its steps, the default is stored as "no key", theme-init.js sets
 *          the attribute before any module loads (and only for a valid step),
 *          and the component reads the attribute on every arming and re-arms
 *          when it changes - so a new value applies without a reload.
 * Run: npm run test:screensaver-idle (needs test/test-browser-loader.mjs for
 *      the component's /api.js and /i18n.js)
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const idle = await import('../public/utils/screensaver-idle.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function makeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function makeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => { attrs.delete(k); },
    hasAttribute: (k) => attrs.has(k),
  };
}

function withBrowser(storage, fn) {
  const prev = { document: globalThis.document, localStorage: globalThis.localStorage };
  const root = makeRoot();
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  globalThis.localStorage = storage;
  try {
    return fn(root);
  } finally {
    globalThis.document = prev.document;
    globalThis.localStorage = prev.localStorage;
  }
}

test('the steps are the ones agreed in #885, with five minutes as the default', () => {
  assert.deepEqual(idle.SCREENSAVER_IDLE_STEPS, [60, 120, 300, 600, 900]);
  assert.equal(idle.SCREENSAVER_IDLE_DEFAULT, 300);
  assert.ok(idle.SCREENSAVER_IDLE_STEPS.includes(idle.SCREENSAVER_IDLE_DEFAULT));
  // The component keeps a 30 s floor; no step may sit below it.
  assert.ok(Math.min(...idle.SCREENSAVER_IDLE_STEPS) >= 30);
});

test('only a step is applied - anything else falls back to the default', () => {
  for (const step of idle.SCREENSAVER_IDLE_STEPS) {
    assert.equal(idle.normalizeScreensaverIdle(step), step);
    assert.equal(idle.normalizeScreensaverIdle(String(step)), step, 'stored values are strings');
  }
  for (const junk of [null, undefined, '', 'abc', '45', 0, -60, 30, 59, 61, 3600, '60s', NaN]) {
    assert.equal(idle.normalizeScreensaverIdle(junk), 300, `${String(junk)} -> default`);
  }
});

test('the choice is stored on this device and applied to the running page', () => {
  const storage = makeStorage();
  withBrowser(storage, (root) => {
    assert.equal(idle.getScreensaverIdleSeconds(), 300, 'nothing stored -> default');

    assert.equal(idle.setScreensaverIdleSeconds(60), 60);
    assert.equal(storage.getItem(idle.SCREENSAVER_IDLE_KEY), '60');
    assert.equal(root.getAttribute('data-screensaver-idle'), '60');
    assert.equal(idle.getScreensaverIdleSeconds(), 60);

    // Back to the default removes the key: a device that went back to five
    // minutes looks like one that never touched the setting.
    assert.equal(idle.setScreensaverIdleSeconds(300), 300);
    assert.equal(storage.map.has(idle.SCREENSAVER_IDLE_KEY), false);
    assert.equal(root.getAttribute('data-screensaver-idle'), '300');

    // An invalid choice never lands in storage.
    assert.equal(idle.setScreensaverIdleSeconds(42), 300);
    assert.equal(storage.map.has(idle.SCREENSAVER_IDLE_KEY), false);
  });
});

test('a blocked storage neither throws nor stops the value from applying', () => {
  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  withBrowser(blocked, (root) => {
    assert.equal(idle.getScreensaverIdleSeconds(), 300);
    assert.equal(idle.setScreensaverIdleSeconds(120), 120);
    assert.equal(root.getAttribute('data-screensaver-idle'), '120', 'applies for this session');
  });
});

/** Runs the real theme-init.js against a stub root, as the page head would. */
function runThemeInit(storage) {
  const root = makeRoot();
  const doc = { documentElement: root, querySelectorAll: () => [] };
  new Function('localStorage', 'sessionStorage', 'document', 'location', read('../public/theme-init.js'))(
    storage, makeStorage(), doc, { pathname: '/settings' },
  );
  return root;
}

test('theme-init.js sets the delay before any module loads - and only a valid step', () => {
  for (const step of idle.SCREENSAVER_IDLE_STEPS) {
    const root = runThemeInit(makeStorage({ [idle.SCREENSAVER_IDLE_KEY]: String(step) }));
    assert.equal(root.getAttribute('data-screensaver-idle'), String(step));
  }
  for (const junk of [null, '', 'abc', '45', '0', '3600']) {
    const root = runThemeInit(makeStorage(junk === null ? {} : { [idle.SCREENSAVER_IDLE_KEY]: junk }));
    assert.equal(root.hasAttribute('data-screensaver-idle'), false,
      `${String(junk)} leaves the attribute off, the component keeps its default`);
  }
});

// --------------------------------------------------------
// The component, driven - not read as text (#1665 review)
// --------------------------------------------------------
//
// One page for the rest of the suite: the component arms its timer and
// registers its listeners when it loads, so the stubs below exist before the
// import and stay in place. Each case starts with a gesture, which is what
// resets the component on a real device too.

const listeners = {};
const toasts = [];
const requests = [];
const observers = [];
const pageStorage = makeStorage();

function makeElement(tag) {
  return {
    tag,
    className: '',
    dataset: {},
    children: [],
    classList: { add() {}, remove() {} },
    setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    remove() {},
  };
}

const body = {
  children: [],
  append(node) {
    this.children.push(node);
    node.remove = () => { this.children = this.children.filter((child) => child !== node); };
  },
};

// setAttribute notifies the observers like the browser does, so the select
// below reaches the component through the same path as on a real page.
const pageRoot = {
  dataset: {},
  attrs: new Map(),
  hasAttribute(name) { return this.attrs.has(name); },
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'data-screensaver-idle') this.dataset.screensaverIdle = String(value);
    for (const { callback, filter } of observers) if (filter.includes(name)) callback([{ attributeName: name }]);
  },
};

const overlays = () => body.children.filter((node) => node.className === 'photo-screensaver').length;
const gesture = () => {
  for (const handler of listeners.pointerdown) handler({ preventDefault() {}, stopImmediatePropagation() {} });
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const PHOTOS = { data: { enabled: true, photos: [{ id: 'p1' }] } };

let component;
async function page() {
  if (component) return component;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  globalThis.window = {
    addEventListener: (name, handler) => { (listeners[name] ||= []).push(handler); },
    yuvomi: { showToast: (message, type) => toasts.push({ message, type }) },
  };
  globalThis.document = {
    documentElement: pageRoot,
    body,
    hidden: false,
    createElement: makeElement,
    addEventListener() {},
    querySelectorAll: () => [],
  };
  globalThis.localStorage = pageStorage;
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target, options) {
      assert.equal(target, pageRoot, 'the component watches <html>');
      observers.push({ callback: this.callback, filter: options.attributeFilter });
    }
  };
  globalThis.__apiStub = {
    get: (path) => new Promise((resolve) => { requests.push({ path, resolve }); }),
  };
  component = await import('../public/components/photo-screensaver.js');
  return component;
}

async function freshCase() {
  await page();
  gesture();
  await flush();
  assert.equal(overlays(), 0, 'every case starts without a screensaver');
  requests.length = 0;
  toasts.length = 0;
}

// First among the component cases on purpose: the module is loaded once, and
// every later case sets the attribute. Only here is it still missing, which is
// the state of every device that never touched the setting.
test('an untouched device waits five minutes', async () => {
  await freshCase();
  assert.equal(pageRoot.getAttribute('data-screensaver-idle'), null, 'nothing has set the attribute yet');
  mock.timers.tick(299_999);
  assert.equal(requests.length, 0, 'not before five minutes');
  mock.timers.tick(1);
  assert.equal(requests.length, 1, 'and at five minutes, as before the setting existed');
  gesture();
});

test('a changed delay re-arms the timer from the moment of the change', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '900');
  mock.timers.tick(100_000);
  assert.equal(requests.length, 0);

  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(59_999);
  assert.equal(requests.length, 0, 'not before the new delay has passed');
  mock.timers.tick(1);
  assert.equal(requests.length, 1, '60 s after the change, not 900 s after arming');
  assert.equal(requests[0].path, '/screensaver/photos');
});

test('a change while the photos are loading retires that start - exactly one overlay later', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 1, 'start() is waiting for its photos');

  pageRoot.setAttribute('data-screensaver-idle', '120');
  requests[0].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 0, 'the late answer opens nothing');

  mock.timers.tick(120_000);
  assert.equal(requests.length, 2, 'the re-armed timer asks again');
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1, 'one overlay - none orphaned under it');

  gesture();
  assert.equal(overlays(), 0, 'and a gesture removes it');
});

test('a change while the admin preview is open leaves the preview alone', async () => {
  const { preview } = await page();
  await freshCase();
  const opened = preview();
  assert.equal(requests.length, 1);
  requests[0].resolve(PHOTOS);
  assert.equal(await opened, true);
  assert.equal(overlays(), 1);

  pageRoot.setAttribute('data-screensaver-idle', '60');
  assert.equal(overlays(), 1, 'the preview stays until dismissed');
  mock.timers.tick(15 * 60_000);
  assert.equal(requests.length, 1, 'no second request behind the preview');
  assert.equal(overlays(), 1);
  gesture();
});

test('the select stores the delay, confirms it and re-arms the component', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '900');
  const { bindScreensaverIdleSelect } = await import('../public/settings/pages/personal-appearance.js');
  const select = { value: '60', handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
  bindScreensaverIdleSelect(select);
  select.handlers.change();

  assert.equal(pageStorage.getItem(idle.SCREENSAVER_IDLE_KEY), '60');
  assert.equal(pageRoot.getAttribute('data-screensaver-idle'), '60');
  assert.equal(toasts.length, 1, 'the change is confirmed like the wall-mode toggle');
  assert.equal(toasts[0].type, 'success');
  assert.match(toasts[0].message, /^settings\.screensaverIdleSaved/);
  mock.timers.tick(60_000);
  assert.equal(requests.length, 1, 'the component follows the select without a reload');
  gesture();

  // bindEvents wires exactly this handler to the rendered select.
  assert.match(read('../public/settings/pages/personal-appearance.js'),
    /bindScreensaverIdleSelect\(container\.querySelector\('#screensaver-idle-select'\)\)/);
});

test('the select opens on the delay stored on this device', async () => {
  await page();
  const { screensaverIdleOptions } = await import('../public/settings/pages/personal-appearance.js');
  pageStorage.setItem(idle.SCREENSAVER_IDLE_KEY, '60');
  const options = screensaverIdleOptions();
  assert.match(options, /<option value="60" selected>/);
  assert.equal(options.match(/ selected/g).length, 1, 'exactly one option is selected');
  pageStorage.removeItem(idle.SCREENSAVER_IDLE_KEY);
  assert.match(screensaverIdleOptions(), /<option value="300" selected>/, 'nothing stored: five minutes');
});

test('a running kitchen timer postpones by the chosen delay, not by five minutes', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  pageRoot.setAttribute('data-wall-timer', '');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 0, 'the timer keeps the screensaver away');

  pageRoot.attrs.delete('data-wall-timer');
  mock.timers.tick(59_999);
  assert.equal(requests.length, 0);
  mock.timers.tick(1);
  assert.equal(requests.length, 1, 'the next attempt comes one chosen delay later');
  gesture();
});

test('a delay chosen in another tab reaches this page through the storage event', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '900');
  pageStorage.setItem(idle.SCREENSAVER_IDLE_KEY, '120');
  for (const handler of listeners.storage) handler({ key: 'yuvomi-theme' });
  assert.equal(pageRoot.getAttribute('data-screensaver-idle'), '900', 'other keys are ignored');
  for (const handler of listeners.storage) handler({ key: idle.SCREENSAVER_IDLE_KEY });
  assert.equal(pageRoot.getAttribute('data-screensaver-idle'), '120');

  pageStorage.removeItem(idle.SCREENSAVER_IDLE_KEY);
  for (const handler of listeners.storage) handler({ key: idle.SCREENSAVER_IDLE_KEY });
  assert.equal(pageRoot.getAttribute('data-screensaver-idle'), '300', 'back to the default in the other tab');
  gesture();
});

test('a junk attribute falls back to five minutes, and the 30 s floor stays', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', 'abc');
  mock.timers.tick(299_999);
  assert.equal(requests.length, 0, 'junk is not an immediate start');
  mock.timers.tick(1);
  assert.equal(requests.length, 1);

  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '5');
  mock.timers.tick(29_999);
  assert.equal(requests.length, 0, 'below the floor waits for the floor');
  mock.timers.tick(1);
  assert.equal(requests.length, 1);
  gesture();
});

test('the setting sits next to wall mode in Appearance, not under the Immich connection', () => {
  const appearance = read('../public/settings/pages/personal-appearance.js');
  assert.match(appearance, /from '\/utils\/screensaver-idle\.js'/);
  assert.match(appearance, /id="screensaver-idle-select"/);
  assert.ok(appearance.indexOf('wall-mode-toggle') < appearance.indexOf('screensaver-idle-select'),
    'rendered right after the wall mode card');
  // The household part (server, key, album) is untouched by this setting.
  assert.ok(!/screensaver-idle/.test(read('../public/settings/pages/admin-immich.js')));
});
