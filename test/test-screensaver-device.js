/**
 * Test: What the screensaver shows on this device (#1766)
 * Purpose: The clock and full-bleed photos are device-local choices next to the
 *          idle delay. Tested here: the clock is on and `cover` off unless
 *          chosen otherwise, the default is stored as "no key", a blocked
 *          storage changes nothing; the component shows the household's time
 *          diagonally opposite the caption, turns it on the full minute and
 *          stops it with the overlay, reads both choices at every start (so a
 *          change applies without a reload), and the switches under Appearance
 *          store and confirm. A start by hand (preview(), the wall footer
 *          button and the admin preview) is not dismissed by the mouse that
 *          started it: the cases at the end drive the gestures.
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
  // The timer is armed by a session, not by loading (#1919; the session cases
  // are in test-screensaver-idle.js). Every case here is a signed-in device.
  component.armScreensaver();
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

// ---------------------------------------------------------------------------
// A start by hand (#1766: "the gesture that starts it does not dismiss it
// again"). preview() is what the wall footer button and the admin preview
// call. A mouse that rested before the click, then moves: that first counted
// pointermove used to dismiss the screensaver, or to retire a start still
// waiting for its photos (preview() answered false and the caller said "not
// available"). Fixed times throughout, on the mocked clock.

const fire = (name) => {
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  for (const handler of listeners[name] ?? []) handler(event);
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await flush(); };

/**
 * A click on the start control, as the component sees it: the pointer comes to
 * rest on the button (its last counted move), waits `rested` ms, presses - the
 * pointerdown reaches the component BEFORE the click handler calls preview() -
 * and 80 ms later the click calls preview(). A tap sends touchstart as well and
 * no move at all.
 */
async function startByHand({ rested = 5000, touch = false } = {}) {
  const { preview } = await page();
  // Clean slate: nothing showing, nothing pending, the throttle long expired.
  fire('pointerdown');
  for (const request of requests) request.resolve({ data: { enabled: false, photos: [] } });
  await settle();
  mock.timers.tick(2000);
  requests.length = 0;
  if (!touch) fire('pointermove');
  mock.timers.tick(rested);
  fire('pointerdown');
  if (touch) fire('touchstart');
  mock.timers.tick(80);
  assert.equal(overlay(), undefined, 'the press itself opens nothing');
  const state = { result: 'pending' };
  state.done = preview().then((value) => { state.result = value; });
  assert.equal(requests.length, 1, 'preview() asked for photos');
  state.answer = async (payload = PHOTOS) => { requests[0].resolve(payload); await settle(); };
  return state;
}

test('by hand, mouse rested: a move 50 ms after it opened does not dismiss it', async () => {
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(30);
  await start.answer();
  assert.equal(start.result, true);
  assert.ok(overlay(), 'open');
  mock.timers.tick(50);
  fire('pointermove');
  await settle();
  assert.ok(overlay(), 'the hand leaving the button does not close what it just opened');
  mock.timers.tick(10_000);
  assert.ok(overlay(), 'and it stays');
  fire('pointerdown');
});

test('by hand, photos still loading: a move 50 ms after the click does not retire the start', async () => {
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(50);
  fire('pointermove');
  await settle();
  mock.timers.tick(250);
  await start.answer();
  assert.equal(start.result, true, 'preview() answers true, so no caller says "not available"');
  assert.ok(overlay(), 'and the screensaver is open');
  assert.equal(requests.length, 1, 'one request, no second start');
  fire('pointerdown');
});

test('by hand, photos slower than the throttle: a move while waiting still retires nothing', async () => {
  // 1200 ms after the click is past the 1 s throttle: a grace period counted
  // from the click alone would have run out before the photos arrived.
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(1200);
  fire('pointermove');
  await settle();
  mock.timers.tick(300);
  await start.answer();
  assert.equal(start.result, true);
  assert.ok(overlay(), 'open after 1500 ms of loading');
  // The grace period counts from the opening, not from the click.
  mock.timers.tick(50);
  fire('pointermove');
  await settle();
  assert.ok(overlay(), 'and a move 50 ms after it opened does not dismiss it either');
  fire('pointerdown');
});

test('by hand: a move 1500 ms after it opened dismisses it, as before', async () => {
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(30);
  await start.answer();
  assert.ok(overlay());
  mock.timers.tick(1500);
  fire('pointermove');
  await settle();
  assert.equal(overlay(), undefined, 'the grace period is the 1 s throttle, not longer');
  // And the dismissal armed the idle timer like any other.
  requests.length = 0;
  mock.timers.tick(300_000);
  assert.equal(requests.length, 1, 'the idle timer runs again');
});

test('by hand: a key, a press, a touch and the wheel dismiss it at once, grace period or not', async () => {
  for (const name of ['keydown', 'pointerdown', 'touchstart', 'wheel']) {
    const start = await startByHand({ rested: 5000 });
    mock.timers.tick(30);
    await start.answer();
    assert.ok(overlay(), `open before ${name}`);
    mock.timers.tick(50);
    fire(name);
    assert.equal(overlay(), undefined, `${name} 50 ms after it opened closes it`);
  }
});

test('by hand: a press while the photos load still retires the start', async () => {
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(100);
  fire('pointerdown');
  mock.timers.tick(200);
  await start.answer();
  assert.equal(start.result, false, 'a deliberate gesture wins over a start that has not shown yet');
  assert.equal(overlay(), undefined);
});

test('by hand: a press while the photos load and never arrive leaves moves counting', async () => {
  // The request is retired by the press but still open - it may stall for as
  // long as it likes. Moves must count again from the press on, not from the
  // answer: a hand on the mouse keeps the idle screensaver away.
  await startByHand({ rested: 5000 });
  mock.timers.tick(100);
  fire('pointerdown');
  requests.length = 0;
  mock.timers.tick(200_000);
  fire('pointermove');
  mock.timers.tick(100_000);
  assert.equal(requests.length, 0, 'the move 200 s after the press pushed the idle timer back');
  mock.timers.tick(200_000);
  assert.equal(requests.length, 1, 'and it runs out one idle period after that move');
});

test('by hand, no photos: the start fails, and the next idle screensaver is dismissed by its first move', async () => {
  // A failed start must not leave moves uncounted: the screensaver the idle
  // timer opens afterwards closes on the first move, like every idle start.
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(30);
  await start.answer({ data: { enabled: true, photos: [] } });
  assert.equal(start.result, false);
  assert.equal(overlay(), undefined);
  requests.length = 0;
  mock.timers.tick(300_000);
  assert.equal(requests.length, 1, 'the idle timer asked');
  requests[0].resolve(PHOTOS);
  await settle();
  assert.ok(overlay(), 'idle screensaver open');
  mock.timers.tick(50);
  fire('pointermove');
  assert.equal(overlay(), undefined, 'first move closes it');
});

test('started by the idle timer: the first move dismisses it, exactly as before', async () => {
  await openScreensaver();
  mock.timers.tick(50);
  fire('pointermove');
  assert.equal(overlay(), undefined, 'no grace period for a screensaver nobody started by hand');
});

test('started by the idle timer after one by hand: still no grace period', async () => {
  const start = await startByHand({ rested: 5000 });
  mock.timers.tick(30);
  await start.answer();
  assert.ok(overlay());
  await openScreensaver();
  mock.timers.tick(50);
  fire('pointermove');
  assert.equal(overlay(), undefined);
});

test('by hand, a tap: no move follows, it stays open until the next tap', async () => {
  const start = await startByHand({ rested: 5000, touch: true });
  mock.timers.tick(300);
  await start.answer();
  assert.equal(start.result, true);
  assert.ok(overlay());
  mock.timers.tick(10_000);
  assert.ok(overlay(), 'still open ten seconds later');
  fire('pointerdown');
  fire('touchstart');
  assert.equal(overlay(), undefined, 'the next tap closes it');
});

// R20 (Re-Critique 2026-10-17 a5 P3): ohne Immich startet der Bildschirmschoner
// nie, die drei Optionen standen trotzdem aktiv da. Ohne Verbindung steht EINE
// Zeile, die sagt, was fehlt; Admins bekommen den Weg dorthin.
test('without Immich the device sheet shows one row instead of three dead options', async () => {
  const { render } = await import('../public/settings/pages/personal-appearance.js');
  const keep = globalThis.__apiStub;
  const sheet = () => {
    const c = { dataset: { part: 'device' }, html: '', replaceChildren() { this.html = ''; }, insertAdjacentHTML(_, h) { this.html += h; }, querySelector: () => null, querySelectorAll: () => [] };
    return c;
  };
  const { resetPreferencesCache } = await import('../public/settings/preferences-cache.js');
  try {
    for (const [enabled, role] of [[false, 'member'], [false, 'admin'], [true, 'member']]) {
      resetPreferencesCache();
      globalThis.__apiStub = { get: async () => ({ data: { screensaver_enabled: enabled } }) };
      const c = sheet();
      await render(c, { user: { role } });
      if (enabled) {
        assert.match(c.html, /id="screensaver-idle-select"/, 'mit Immich: die Optionen');
        assert.doesNotMatch(c.html, /screensaver-off-row/);
      } else {
        assert.doesNotMatch(c.html, /screensaver-idle-select|screensaver-clock-toggle|screensaver-cover-toggle/, 'ohne Immich: keine Optionen');
        assert.match(c.html, /id="screensaver-off-row"[\s\S]*settings\.screensaverNeedsImmich/, 'die Zeile sagt, was fehlt');
        assert.equal(/id="screensaver-connect" href="\/settings\/admin\/integrations"/.test(c.html), role === 'admin', 'nur Admins bekommen den Weg zu Immich');
      }
      assert.match(c.html, /wall-mode-toggle/, 'der Wand-Modus bleibt immer');
      // Die Nachtstunden gelten auch fuer die Wand, also auch ohne Immich (#2234).
      assert.match(c.html, /id="night-hours-row"[\s\S]*id="night-hours-from"[\s\S]*id="night-hours-until"/,
        'die Nachtstunden stehen immer da');
    }
  } finally {
    resetPreferencesCache();
    if (keep === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = keep;
  }
});

// ---------------------------------------------------------------------------
// Night hours (#1901, #2234). ONE window for wall and screensaver, chosen on
// this device, read on the household's clock - by theme-init.js for the first
// paint and by the modules afterwards, through the same function.

const night = await import('../public/utils/night-hours.js');
const { setDisplayTimeZone: setZone } = await import('../public/utils/timezone.js');

// The real Date, taken while the module loads: page() mocks it later, and the
// mock's constructor hands back a plain Date, so a subclass of the mock would
// lose its getHours().
const RealDate = Date;

/** A `Date` whose `new Date()` is `iso` and whose DEVICE hour is always `deviceHour`. */
function deviceClock(iso, deviceHour) {
  const Base = RealDate;
  const fixed = Base.parse(iso);
  return class extends Base {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    getHours() { return deviceHour; }
  };
}

/** The real theme-init.js on `/` with wall mode on, as the page head runs it. */
function themeInitNight(entries, DateImpl) {
  const attrs = new Map();
  const root = {
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => { attrs.delete(k); },
    hasAttribute: (k) => attrs.has(k),
  };
  const doc = { documentElement: root, querySelectorAll: () => [], querySelector: () => null };
  new Function('localStorage', 'sessionStorage', 'document', 'location', 'Date', read('../public/theme-init.js'))(
    makeStorage({ 'yuvomi-wall-mode': '1', ...entries }), makeStorage(), doc, { pathname: '/' }, DateImpl,
  );
  return root.hasAttribute('data-wall-night');
}

test('night hours: 22 to 6 unless chosen, stored on this device, the default as no key', async () => {
  await page();
  assert.equal(night.NIGHT_HOURS_KEY, 'yuvomi-night-hours');
  assert.deepEqual(night.getNightHours(), { from: 22, to: 6 });
  assert.deepEqual(night.setNightHours(23, 5), { from: 23, to: 5 });
  assert.equal(pageStorage.getItem(night.NIGHT_HOURS_KEY), '23-5');
  assert.deepEqual(night.getNightHours(), { from: 23, to: 5 });
  night.setNightHours(22, 6);
  assert.equal(pageStorage.map.has(night.NIGHT_HOURS_KEY), false, 'back to the default leaves no key');
  for (const junk of ['', 'abc', '22', '24-6', '7-7', '-1-5']) {
    pageStorage.setItem(night.NIGHT_HOURS_KEY, junk);
    assert.deepEqual(night.getNightHours(), { from: 22, to: 6 }, `${junk} falls back to the default`);
  }
  pageStorage.removeItem(night.NIGHT_HOURS_KEY);
});

test('night hours: across midnight and within one day, on the household clock', async () => {
  await page();
  const at = (iso) => new Date(Date.parse(iso));
  setZone('Asia/Kolkata'); // +05:30
  try {
    // 16:45 UTC = 22:15 Kolkata; 00:15 UTC = 05:45 Kolkata; 01:00 UTC = 06:30 Kolkata
    assert.equal(night.isNightHours(at('2026-10-08T16:45:00Z')), true);
    assert.equal(night.isNightHours(at('2026-10-09T00:15:00Z')), true);
    assert.equal(night.isNightHours(at('2026-10-09T01:00:00Z')), false);
    night.setNightHours(1, 5); // the same day: an AND, not an OR
    assert.equal(night.isNightHours(at('2026-10-08T16:45:00Z')), false, '22:15 is not in 1-5');
    assert.equal(night.isNightHours(at('2026-10-08T21:00:00Z')), true, '02:30 is');
  } finally {
    night.setNightHours(22, 6);
    setZone(null);
  }
});

test('the wall dims in the hours chosen on this device (#2234)', async () => {
  await page();
  const { isWallNight } = await import('../public/utils/wall-mode.js');
  const at = new Date(Date.parse('2026-10-08T14:30:00Z')); // 20:00 in Kolkata
  setZone('Asia/Kolkata');
  try {
    assert.equal(isWallNight(at), false, '20:00 is day by default');
    night.setNightHours(19, 7);
    assert.equal(isWallNight(at), true, 'and night once the device dims from 19:00');
  } finally {
    night.setNightHours(22, 6);
    setZone(null);
  }
});

test('theme-init.js paints the night on the household clock and the hours of this device (#2234)', async () => {
  await page(); // the module above has put the shared function on globalThis
  // 17:30 UTC is 23:00 in Kolkata, while the device's own clock says noon.
  const noonOnDevice = deviceClock('2026-10-08T17:30:00Z', 12);
  assert.equal(themeInitNight({ 'yuvomi-timezone': 'Asia/Kolkata' }, noonOnDevice), true,
    'the household is at 23:00 - the device clock (noon) does not decide');
  assert.equal(themeInitNight({ 'yuvomi-timezone': 'Asia/Kolkata', 'yuvomi-night-hours': '1-5' }, noonOnDevice), false,
    '23:00 is outside 1-5, chosen on this device');
  assert.equal(themeInitNight({}, deviceClock('2026-10-08T17:30:00Z', 11)), false,
    'without a household zone the device hour applies: 11:00 is day');
  assert.equal(themeInitNight({ 'yuvomi-night-hours': '10-14' }, deviceClock('2026-10-08T17:30:00Z', 11)), true,
    'and the chosen hours too');
  // And the module agrees with the first paint at that instant.
  setZone('Asia/Kolkata');
  try {
    assert.equal(night.isNightHours(new noonOnDevice()), true);
  } finally {
    setZone(null);
  }
});

test('the screensaver dims at night without wall mode, and the hour turns it while it shows (#1901)', async () => {
  await page();
  assert.equal(pageRoot.hasAttribute('data-wall-mode'), false, 'no wall mode on this page');
  setZone('UTC');
  try {
    const hour = new Date().getUTCHours();
    // A window that holds the current hour, and then one that does not.
    night.setNightHours(hour, (hour + 2) % 24);
    const node = await openScreensaver();
    assert.equal(node.dataset.night, '', 'dimmed from the first photo');
    night.setNightHours((hour + 3) % 24, (hour + 5) % 24);
    mock.timers.tick(20_000);
    assert.equal('night' in node.dataset, false, 'the next photo is back to full brightness, without a touch');
    night.setNightHours(hour, (hour + 2) % 24);
    mock.timers.tick(20_000);
    assert.equal(node.dataset.night, '', 'and dims again on the next photo');
    gesture();
  } finally {
    night.setNightHours(22, 6);
    setZone(null);
  }
});

test('the night rule dims photo, clock and caption alike, and glides only with motion allowed', () => {
  const css = read('../public/styles/screensaver.css');
  const rule = css.match(/\.photo-screensaver\[data-night\] img,\s*\.photo-screensaver\[data-night\] p \{([^}]*)\}/);
  assert.ok(rule, 'one rule for the photo and both texts (the clock is a p)');
  assert.match(rule[1], /filter: brightness\(var\(--screensaver-night-brightness\)\)/);
  const level = Number(css.match(/--screensaver-night-brightness: ([\d.]+)/)?.[1]);
  assert.ok(level > 0 && level < 1, `darker, not black: ${level}`);
  assert.match(css, /\.photo-screensaver img,\s*\.photo-screensaver p \{\s*transition: opacity 1\.2s ease, filter 2s ease;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.photo-screensaver img,\s*\.photo-screensaver p \{ transition: none; \}/);
});

test('the night-hours selects under Appearance open on the stored hours, store and confirm', async () => {
  await page();
  const { nightHourOptions, bindNightHoursSelects } = await import('../public/settings/pages/personal-appearance.js');
  const html = nightHourOptions(22, 6);
  assert.equal((html.match(/<option /g) || []).length, 24, 'every whole hour');
  assert.match(html, /<option value="22" selected>/);
  assert.match(html, /<option value="6" disabled>/, 'the hour of the other end cannot be picked: no empty window');

  const option = (value) => ({ value: String(value), disabled: false });
  const makeSelect = (value) => ({
    value: String(value),
    options: Array.from({ length: 24 }, (_, hour) => option(hour)),
    handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
  });
  const from = makeSelect(22);
  const until = makeSelect(6);
  bindNightHoursSelects(from, until);
  toasts.length = 0;
  from.value = '23';
  from.handlers.change();
  assert.equal(pageStorage.getItem(night.NIGHT_HOURS_KEY), '23-6');
  assert.equal(until.options[23].disabled, true, 'until now locks 23');
  assert.equal(from.options[6].disabled, true, 'from keeps 6 locked');
  assert.equal(from.options[22].disabled, false);
  assert.deepEqual(toasts.map((toast) => toast.type), ['success']);
  assert.match(toasts[0].message, /^settings\.nightHoursSaved/);
  from.value = '22';
  from.handlers.change();
  assert.equal(pageStorage.map.has(night.NIGHT_HOURS_KEY), false, 'back to the default leaves no key');
});
