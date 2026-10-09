/**
 * Test: What the screensaver shows on this device (#1766)
 * Purpose: The clock and full-bleed photos are device-local choices next to the
 *          idle delay. Tested here: the clock is on and `cover` off unless
 *          chosen otherwise, the default is stored as "no key", a blocked
 *          storage changes nothing; the component shows the household's time
 *          diagonally opposite the caption, turns it on the full minute and
 *          stops it with the overlay, reads both choices at every start (so a
 *          change applies without a reload), and the switches under Appearance
 *          store and confirm.
 * Run: npm run test:screensaver-device (needs test/test-browser-loader.mjs for
 *      the component's /api.js and /i18n.js)
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prefs = await import('../public/utils/screensaver-idle.js');
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

function withStorage(storage, fn) {
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    return fn();
  } finally {
    globalThis.localStorage = prev;
  }
}

test('the clock is on and cover is off on a device that never chose', () => {
  withStorage(makeStorage(), () => {
    assert.equal(prefs.isScreensaverClockOn(), true);
    assert.equal(prefs.isScreensaverCoverOn(), false);
  });
});

test('each choice is stored on this device, and the default as no key', () => {
  const storage = makeStorage();
  withStorage(storage, () => {
    assert.equal(prefs.setScreensaverClockOn(false), false);
    assert.equal(storage.getItem(prefs.SCREENSAVER_CLOCK_KEY), '0');
    assert.equal(prefs.isScreensaverClockOn(), false);
    prefs.setScreensaverClockOn(true);
    assert.equal(storage.map.has(prefs.SCREENSAVER_CLOCK_KEY), false, 'back to the default leaves no key');

    assert.equal(prefs.setScreensaverCoverOn(true), true);
    assert.equal(storage.getItem(prefs.SCREENSAVER_COVER_KEY), '1');
    assert.equal(prefs.isScreensaverCoverOn(), true);
    prefs.setScreensaverCoverOn(false);
    assert.equal(storage.map.has(prefs.SCREENSAVER_COVER_KEY), false);
  });
  assert.equal(prefs.SCREENSAVER_CLOCK_KEY, 'yuvomi-screensaver-clock');
  assert.equal(prefs.SCREENSAVER_COVER_KEY, 'yuvomi-screensaver-cover');
});

test('a junk value and a blocked storage fall back to the defaults without throwing', () => {
  withStorage(makeStorage({ 'yuvomi-screensaver-clock': 'off', 'yuvomi-screensaver-cover': 'yes' }), () => {
    assert.equal(prefs.isScreensaverClockOn(), true, 'only "0" switches the clock off');
    assert.equal(prefs.isScreensaverCoverOn(), false, 'only "1" switches cover on');
  });
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  withStorage(blocked, () => {
    assert.equal(prefs.isScreensaverClockOn(), true);
    assert.equal(prefs.isScreensaverCoverOn(), false);
    assert.doesNotThrow(() => prefs.setScreensaverClockOn(false));
    assert.doesNotThrow(() => prefs.setScreensaverCoverOn(true));
  });
});

// ---------------------------------------------------------------------------
// The component, driven. Same stubs as test:screensaver-idle: the module is a
// singleton that registers its listeners at load, so the stubs exist before
// the import and stay. `Date` is mocked as well, so the clock can be watched
// turning on the full minute. The loader's formatTime is `String(d)` unless a
// case sets globalThis.__formatTime: one case records the call, one plugs in
// the real formatTime with a display zone and the 12h preference.

const listeners = {};
const toasts = [];
const requests = [];
const pageStorage = makeStorage();

function makeElement(tag) {
  const classes = new Set();
  return {
    tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
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

const pageRoot = {
  dataset: {},
  attrs: new Map(),
  hasAttribute(name) { return this.attrs.has(name); },
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
  setAttribute(name, value) { this.attrs.set(name, String(value)); },
};

const overlay = () => body.children.find((node) => node.className === 'photo-screensaver');
const caption = (node) => node.children.find((child) => child.tag === 'p' && !child.className);
const clockOf = (node) => node.children.find((child) => child.className === 'photo-screensaver__clock');
const gesture = () => {
  for (const handler of listeners.pointerdown) handler({ preventDefault() {}, stopImmediatePropagation() {} });
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const PHOTOS = { data: { enabled: true, photos: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] } };

let component;
async function page() {
  if (component) return component;
  // 03:43:20 UTC, which is 09:13:20 in Kolkata (+05:30, no daylight saving):
  // twenty seconds into a minute, so the first turn is 40 s away, and an hour
  // that differs between the zone and UTC.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 8, 3, 43, 20) });
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
  globalThis.MutationObserver = class { observe() {} };
  globalThis.__apiStub = {
    get: (path) => new Promise((resolve) => { requests.push({ path, resolve }); }),
  };
  component = await import('../public/components/photo-screensaver.js');
  return component;
}

/** Opens the real screensaver the way the idle timer does, and returns it. */
async function openScreensaver() {
  await page();
  gesture();
  requests.length = 0;
  mock.timers.tick(300_000);
  assert.equal(requests.length, 1, 'the idle timer asked for photos');
  requests[0].resolve(PHOTOS);
  await flush();
  const node = overlay();
  assert.ok(node, 'the screensaver is open');
  return node;
}

test('the clock shows formatTime of now, diagonally opposite the caption', async () => {
  const calls = [];
  globalThis.__formatTime = (date) => { calls.push(date); return `formatted-${calls.length}`; };
  let node;
  try {
    node = await openScreensaver();
  } finally {
    delete globalThis.__formatTime;
  }
  const clock = clockOf(node);
  assert.ok(clock, 'on by default');
  // It takes its corner from the caption's `p[data-position]` rules (checked
  // against the stylesheet below) only because it is a `p` too.
  assert.equal(clock.tag, 'p', 'the clock is a p, so the four corner rules reach it');
  assert.equal(calls.length, 1, 'formatTime is what the clock shows');
  assert.ok(calls[0] instanceof Date, 'called with a Date, not a string');
  assert.equal(calls[0].getTime(), Date.now(), 'and with now');
  assert.equal(clock.textContent, 'formatted-1');
  const opposite = (position) => String((Number(position) + 2) % 4);
  assert.equal(clock.dataset.position, opposite(caption(node).dataset.position));

  mock.timers.tick(20_000);
  assert.equal(clock.dataset.position, opposite(caption(node).dataset.position),
    'the next photo moves the caption, and the clock moves with it');
  assert.equal(node.classList.contains('photo-screensaver--cover'), false, 'cover stays off by default');
  gesture();
  assert.equal(overlay(), undefined);
});

test('the clock is the household time: the display zone and the 12h preference', async () => {
  await page();
  // The real formatTime, not the loader's: same module graph as the page, so
  // setDisplayTimeZone() below is the zone it reads.
  const { formatTime } = await import('../public/i18n.js');
  const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
  setDisplayTimeZone('Asia/Kolkata');
  pageStorage.setItem('yuvomi-time-format', '12h');
  globalThis.__formatTime = formatTime;
  try {
    const node = await openScreensaver();
    const clock = clockOf(node);
    const now = new Date();
    assert.equal(now.getUTCHours() === 9, false, 'the case only measures the zone while UTC is another hour');
    const kolkata = new Date(now.getTime() + 5.5 * 3_600_000);
    const hour = kolkata.getUTCHours();
    const expected = `${hour % 12 || 12}:${String(kolkata.getUTCMinutes()).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
    assert.equal(clock.textContent, expected, 'Kolkata wall time, written in 12h');
    gesture();
  } finally {
    delete globalThis.__formatTime;
    setDisplayTimeZone(null);
    pageStorage.removeItem('yuvomi-time-format');
  }
});

test('the clock turns on the full minute and stops with the screensaver', async () => {
  const node = await openScreensaver();
  const clock = clockOf(node);
  const shown = clock.textContent;
  const msToMinute = 60_000 - (new Date().getSeconds() * 1000 + new Date().getMilliseconds());
  mock.timers.tick(msToMinute - 1);
  assert.equal(clock.textContent, shown, 'not before the minute turns');
  mock.timers.tick(1);
  assert.notEqual(clock.textContent, shown);
  assert.equal(new Date().getSeconds(), 0, 'on the full minute');
  assert.equal(clock.textContent, String(new Date()));
  mock.timers.tick(60_000);
  assert.equal(clock.textContent, String(new Date()), 'and every minute after');

  gesture();
  const last = clock.textContent;
  mock.timers.tick(5 * 60_000 - 1);
  assert.equal(clock.textContent, last, 'a dismissed screensaver keeps no clock running');
});

test('both choices are read at every start, so a change needs no reload', async () => {
  await page();
  prefs.setScreensaverClockOn(false);
  prefs.setScreensaverCoverOn(true);
  let node = await openScreensaver();
  assert.equal(clockOf(node), undefined, 'clock switched off on this device');
  assert.equal(node.classList.contains('photo-screensaver--cover'), true, 'full-bleed chosen on this device');
  gesture();

  prefs.setScreensaverClockOn(true);
  prefs.setScreensaverCoverOn(false);
  node = await openScreensaver();
  assert.ok(clockOf(node));
  assert.equal(node.classList.contains('photo-screensaver--cover'), false);
  gesture();
});

test('the switches under Appearance store the choice and confirm it', async () => {
  await page();
  const { bindScreensaverSwitch } = await import('../public/settings/pages/personal-appearance.js');
  const makeToggle = (checked) => ({
    checked, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; },
  });

  toasts.length = 0;
  const clockToggle = makeToggle(false);
  bindScreensaverSwitch(clockToggle, prefs.setScreensaverClockOn);
  clockToggle.handlers.change();
  assert.equal(pageStorage.getItem(prefs.SCREENSAVER_CLOCK_KEY), '0');

  const coverToggle = makeToggle(true);
  bindScreensaverSwitch(coverToggle, prefs.setScreensaverCoverOn);
  coverToggle.handlers.change();
  assert.equal(pageStorage.getItem(prefs.SCREENSAVER_COVER_KEY), '1');

  assert.deepEqual(toasts.map((toast) => [toast.message, toast.type]), [
    ['settings.screensaverDeviceSaved', 'success'],
    ['settings.screensaverDeviceSaved', 'success'],
  ]);
  prefs.setScreensaverClockOn(true);
  prefs.setScreensaverCoverOn(false);

  // Rendered below the delay, wired to exactly these handlers, and searchable.
  const appearance = read('../public/settings/pages/personal-appearance.js');
  const at = (needle) => appearance.indexOf(needle);
  assert.ok(at("id: 'screensaver-clock-toggle'") > at('id="screensaver-idle-select"'));
  assert.ok(at("id: 'screensaver-cover-toggle'") > at("id: 'screensaver-clock-toggle'"));
  assert.match(appearance, /checked: isScreensaverClockOn\(\)/);
  assert.match(appearance, /checked: isScreensaverCoverOn\(\)/);
  assert.match(appearance,
    /bindScreensaverSwitch\(container\.querySelector\('#screensaver-clock-toggle'\), setScreensaverClockOn\)/);
  assert.match(appearance,
    /bindScreensaverSwitch\(container\.querySelector\('#screensaver-cover-toggle'\), setScreensaverCoverOn\)/);
  const registry = read('../public/settings/registry.js');
  assert.match(registry, /'settings\.screensaverClockLabel'/);
  assert.match(registry, /'settings\.screensaverCoverLabel'/);
});

test('positions two apart are opposite corners in the stylesheet', () => {
  // The component puts the clock at (caption + 2) % 4. Whether that is really
  // the opposite corner is decided here, in the four caption rules.
  const css = read('../public/styles/screensaver.css');
  const corners = {};
  for (const [, position, body] of css.matchAll(/\.photo-screensaver p\[data-position="(\d)"\] \{([^}]*)\}/g)) {
    corners[position] = {
      horizontal: /\bleft:/.test(body) ? 'left' : /\bright:/.test(body) ? 'right' : null,
      vertical: /\btop:/.test(body) ? 'top' : /\bbottom:/.test(body) ? 'bottom' : null,
    };
  }
  assert.deepEqual(Object.keys(corners).sort(), ['0', '1', '2', '3'], 'one rule per position');
  for (let position = 0; position < 4; position++) {
    const here = corners[position];
    const there = corners[(position + 2) % 4];
    assert.ok(here.horizontal && here.vertical, `position ${position} is a corner`);
    assert.notEqual(there.horizontal, here.horizontal, `${position} and ${(position + 2) % 4} sit on different sides`);
    assert.notEqual(there.vertical, here.vertical, `${position} and ${(position + 2) % 4} sit on different edges`);
  }
});

test('the clock rule adds size, never a place of its own', () => {
  // A clock pinned to one corner would be a fixed bright area again - the
  // burn-in the moving caption exists to avoid. Its corner must come only
  // from the shared `p[data-position]` rules.
  const css = read('../public/styles/screensaver.css');
  const rules = [...css.matchAll(/([^{}]*\.photo-screensaver__clock[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 1, 'the clock has a rule');
  for (const [, selector, body] of rules) {
    for (const property of ['top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline', 'position']) {
      assert.doesNotMatch(body, new RegExp(`(^|[;\\s])${property}(-[a-z-]+)?\\s*:`),
        `${selector.trim()} must not set ${property}`);
    }
  }
});

test('the stylesheet keeps contain as the default and crops only with the cover class', () => {
  const css = read('../public/styles/screensaver.css');
  assert.match(css, /\.photo-screensaver img \{[^}]*object-fit: contain;/);
  assert.match(css, /\.photo-screensaver--cover img \{ object-fit: cover; \}/);
  assert.match(css, /\.photo-screensaver p\.photo-screensaver__clock \{[^}]*font-variant-numeric: tabular-nums;/);
});
