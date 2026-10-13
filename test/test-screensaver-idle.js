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
import { createNavigateHarness } from './router-navigate-harness.js';

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
const documentListeners = {};
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
    addEventListener: (name, handler) => { (documentListeners[name] ||= []).push(handler); },
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
    get: (path) => new Promise((resolve, reject) => { requests.push({ path, resolve, reject }); }),
  };
  component = await import('../public/components/photo-screensaver.js');
  return component;
}

// THE SESSION, THROUGH THE ROUTER'S OWN navigate() (#1919). Nobody arms the
// component by hand here: signing in is `navigate('/', user)` from the sign-in
// page, a page load with a running session is the auth guard answering
// `/auth/me` - the real utils/router-navigate.js both times, with the real
// component as its `armScreensaver`. Only the two ways out are played by hand,
// because router.js cannot be imported: `auth:expired` as api.js fires it, and
// `disarmScreensaver()` as forgetSessionState() calls it.
const MEMBER = { id: 1, username: 'anna', role: 'member' };
const DISPLAY = { id: 9, username: 'kitchen', role: 'member', access_scope: 'display' };
const router = () => ({ armScreensaver: component.armScreensaver });
const signIn = (user = MEMBER) => createNavigateHarness(router()).navigate('/', user);
const loadWithSession = (user) => createNavigateHarness({ ...router(), sessionUser: user }).navigate('/', false);
const loadWithoutSession = () => createNavigateHarness(router()).navigate('/', false);
const sessionExpires = () => { for (const handler of listeners['auth:expired'] || []) handler({}); };
const idlePeriods = async (count, ms) => {
  for (let i = 0; i < count; i += 1) { mock.timers.tick(ms); await flush(); }
};

async function freshCase() {
  await page();
  await signIn();
  gesture();
  await flush();
  assert.equal(overlays(), 0, 'every case starts without a screensaver');
  requests.length = 0;
  toasts.length = 0;
}

// FIRST OF ALL, AND BEFORE ANYBODY SIGNS IN (#1919): the page as index.html
// loads it on /login and /setup. There is nobody whose screensaver it could be,
// so nothing may leave the component - the answer would be a 401, api.js would
// fire `auth:expired`, and the router would draw the sign-in page again over a
// form somebody is filling in. Typing into that form is the gesture below.
test('on a signed-out page no request leaves the component, however long it idles', async () => {
  await page();
  await idlePeriods(3, 300_000);
  assert.equal(requests.length, 0, 'three idle periods after loading: nothing asked');

  gesture();
  for (const handler of listeners.keydown) handler({ preventDefault() {}, stopImmediatePropagation() {} });
  await idlePeriods(10, 300_000);
  assert.equal(requests.length, 0, 'ten idle periods after typing: still nothing asked');

  // A tab that comes back to the front is no sign-in either.
  for (const handler of documentListeners.visibilitychange || []) handler({});
  await idlePeriods(3, 300_000);
  assert.equal(requests.length, 0);

  // And a page load that finds no session (the auth guard gets its 401 and
  // sends the visitor to /login) arms nothing on the way.
  await loadWithoutSession();
  gesture();
  await idlePeriods(3, 300_000);
  assert.equal(requests.length, 0, 'a failed /auth/me is not a session');
  assert.equal(overlays(), 0);
});

test('signing in arms the timer without a reload', async () => {
  await page();
  assert.equal(requests.length, 0);
  // What pages/login.js does with the answer of /auth/login. No gesture after
  // it: the click that sent the form came before the session existed.
  await signIn();
  mock.timers.tick(299_999);
  assert.equal(requests.length, 0, 'not before the idle delay');
  mock.timers.tick(1);
  assert.equal(requests.length, 1, 'one idle period after signing in');
  assert.equal(requests[0].path, '/screensaver/photos');
  requests[0].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1, 'and the screensaver opens on the page that was loaded signed out');
  gesture();
  requests.length = 0;
});

// A page load with a running session never passes the sign-in page: the auth
// guard asks /auth/me and that is where the session becomes known.
test('a page that loads into a running session is armed by the auth guard', async () => {
  await page();
  sessionExpires();
  gesture();
  await idlePeriods(2, 300_000);
  assert.equal(requests.length, 0, 'signed out again: nothing asked');

  await loadWithSession(MEMBER);
  mock.timers.tick(300_000);
  assert.equal(requests.length, 1, 'armed by /auth/me, without a gesture');
  requests[0].reject(new Error('later'));
  await flush();
  gesture();
  requests.length = 0;
});

// A PAIRED DISPLAY HAS NO USER SESSION, BUT IT IS SOMEBODY (#1793). Its access
// is its own cookie, and /auth/me answers with an account of scope `display` -
// "signed in" must not mean "a person". The wall is the device the screensaver
// was built for (#693), and nobody touches it: switched on by an administrator
// it has to open on its own, and switched off while showing it has to come
// down and ask again.
test('a paired display is armed like a session and keeps its switch-on and switch-off', async () => {
  await page();
  sessionExpires();
  await loadWithSession(DISPLAY);

  mock.timers.tick(300_000);
  assert.equal(requests.length, 1, 'the display asks after its idle delay, untouched');
  requests[0].reject(new Error('Token scope does not permit this operation.'));
  await flush();
  assert.equal(overlays(), 0, 'switched off: the 403 shows nothing');

  mock.timers.tick(300_000);
  assert.equal(requests.length, 2, 'and knocks again one idle period later');
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1, 'switched on in between: it opens without a touch');

  const image = body.children.find((node) => node.className === 'photo-screensaver').children
    .find((node) => node.tag === 'img');
  image.onerror();
  assert.equal(overlays(), 0, 'switched off while showing: no black wall');
  mock.timers.tick(300_000);
  assert.equal(requests.length, 3, 'and it asks again, still untouched');
  requests[2].reject(new Error('Token scope does not permit this operation.'));
  await flush();
  gesture();
  requests.length = 0;
});

// First among the cases that set the delay on purpose: the module is loaded
// once, and every later case sets the attribute. Only here is it still missing, which is
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

// A paired display starts with its screensaver switched off (#1766, #1793):
// the photo request answers 403. Nobody touches a wall tablet, so a refusal
// must not use up the only scheduled attempt - otherwise switching the display
// on reaches the wall only with the next touch.
test('a refused request knocks again after one idle period, without a gesture', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('Token scope does not permit this operation.'));
  await flush();
  assert.equal(overlays(), 0);

  mock.timers.tick(59_999);
  assert.equal(requests.length, 1, 'not before the next idle period');
  mock.timers.tick(1);
  assert.equal(requests.length, 2, 'asks again on its own');
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1, 'switched on in between: the screensaver opens without anyone touching the tablet');
  gesture();
});

test('a retired start that fails later does not arm a second timer', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 1, 'start() is waiting');
  gesture();
  mock.timers.tick(30_000);
  // Thirty seconds after the gesture: a re-arm here would push the gesture's
  // timer back by thirty seconds.
  requests[0].reject(new Error('late'));
  await flush();
  mock.timers.tick(30_000);
  assert.equal(requests.length, 2, 'the gesture\'s timer still fires on time - the retired start armed nothing');
  gesture();
});

// An administrator switches the display off while the screensaver shows: the
// next image is refused. Without a handler the picture never comes back and the
// wall shows black with only the text moving over it.
test('an image that fails to load takes the overlay down and knocks again later', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  requests[0].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1);
  const overlayNode = body.children.find((node) => node.className === 'photo-screensaver');
  const image = overlayNode.children.find((node) => node.tag === 'img');
  assert.equal(typeof image.onerror, 'function', 'the image handles its own failure');

  image.onerror();
  assert.equal(overlays(), 0, 'no black wall');
  mock.timers.tick(59_999);
  assert.equal(requests.length, 1);
  mock.timers.tick(1);
  assert.equal(requests.length, 2, 'and the next idle period asks again');
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1);

  // An error from an overlay that is already gone does nothing - thirty
  // seconds after the gesture, a re-arm would push its timer back.
  gesture();
  mock.timers.tick(30_000);
  image.onerror();
  mock.timers.tick(30_000);
  assert.equal(requests.length, 3, 'the gesture\'s timer fires on time - a stale image error re-arms nothing');
  gesture();
});

// The session ends under a running page: the request answers 401, and api.js
// fires `auth:expired` before it throws - which the router answers by drawing
// the sign-in page. From there on the page is a signed-out page (#1919): not
// the next gesture arms the timer (that was #1793, and it left one request per
// visit to the sign-in page), only the next session does.
test('a request that ends the session disarms - no gesture, only the next sign-in arms it', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 1);
  // What api.js does on a 401: the event first, synchronously, then the throw.
  sessionExpires();
  requests[0].reject(new Error('Sitzung abgelaufen.'));
  await flush();
  await idlePeriods(10, 60_000);
  assert.equal(requests.length, 1, 'ten idle periods later: still the one request');
  assert.equal(overlays(), 0);

  // Filling in the sign-in form, a delay changed in another tab, a tab coming
  // back to the front: none of them is a session.
  gesture();
  await idlePeriods(3, 60_000);
  pageRoot.setAttribute('data-screensaver-idle', '120');
  await idlePeriods(3, 120_000);
  pageRoot.setAttribute('data-screensaver-idle', '60');
  for (const handler of documentListeners.visibilitychange || []) handler({});
  await idlePeriods(3, 60_000);
  assert.equal(requests.length, 1, 'the sign-in page asks for nothing');

  await signIn();
  mock.timers.tick(59_999);
  assert.equal(requests.length, 1);
  mock.timers.tick(1);
  assert.equal(requests.length, 2, 'one idle period after signing in');
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1, 'and the screensaver opens for the new session');
  gesture();
});

// The other way out is the deliberate one: "Sign out" runs clearSession() and
// never fires `auth:expired`. Both ways end in forgetSessionState(), which is
// where the router disarms.
test('signing out takes a showing screensaver down and disarms', async () => {
  await freshCase();
  pageRoot.setAttribute('data-screensaver-idle', '60');
  mock.timers.tick(60_000);
  requests[0].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 1);

  component.disarmScreensaver();
  assert.equal(overlays(), 0, 'the photos of the household do not stay over the sign-in page');
  gesture();
  await idlePeriods(5, 60_000);
  assert.equal(requests.length, 1, 'and nothing is asked after it');

  // A start that was still waiting for its photos when the session went.
  await signIn();
  mock.timers.tick(60_000);
  assert.equal(requests.length, 2);
  component.disarmScreensaver();
  requests[1].resolve(PHOTOS);
  await flush();
  assert.equal(overlays(), 0, 'a late answer opens nothing on a signed-out page');
  await idlePeriods(3, 60_000);
  assert.equal(requests.length, 2);
  await signIn();
  gesture();
});

// router.js cannot be imported (it hangs on the browser), so its half is read:
// forgetSessionState() is the one function both ways out run through, and the
// router hands the component's own arming to navigate().
test('the router disarms where every session ends and hands navigate() the arming', () => {
  const router = read('../public/router.js');
  const forget = router.slice(router.indexOf('function forgetSessionState()'));
  const body = forget.slice(0, forget.indexOf('\n}\n'));
  assert.match(body, /^\s*disarmScreensaver\(\);$/m, 'forgetSessionState() disarms the screensaver');
  assert.match(router, /import \{[^}]*\barmScreensaver\b[^}]*\bdisarmScreensaver\b[^}]*\} from '\/components\/photo-screensaver\.js';/);
  assert.match(router, /createNavigate\(routerState, \{[^}]*\barmScreensaver\b[^}]*\}\)/);
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
