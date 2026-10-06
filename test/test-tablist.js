/**
 * Test: manualActivation option of the shared tablist behaviour layer
 * Modul: /public/utils/tablist.js
 *
 * WARUM ALS VERHALTENSTEST UND NICHT ALS TEXTGUARD: Review of #1099, nice to
 * have. Ohne manualActivation aktiviert jeder Pfeiltastendruck den Tab
 * sofort - fuer eine Leiste, deren onChange() einen echten Wechsel navigiert/
 * neu laedt (Schedule: Statistik-Fetch, S-03-Nachfrage bei ungespeicherten
 * Aenderungen), heisst blosses Durchblaettern mit den Pfeiltasten damit jeden
 * Tastendruck einen Wechsel. Ein Textguard nach "manualActivation" im
 * Quelltext waere gruen geblieben, sobald die Option existiert, aber nichts
 * mehr tut - deshalb hier ueber die echten Handler, wie schon
 * test-popover-menu.js es fuer das geteilte Ueberlaufmenue vormacht: ein
 * minimaler, handgebauter DOM-Stub (kein jsdom, keine Fremd-Dependency,
 * netzfrei) statt eines echten Browsers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// wireScrollFade() (utils/ux.js) braucht ResizeObserver/MutationObserver -
// no-op-Stubs, dasselbe Prinzip wie global.HTMLElement in test-popover-menu.js.
global.ResizeObserver = class { observe() {} disconnect() {} };
global.MutationObserver = class { observe() {} disconnect() {} };

const { wireTablist } = await import('../public/utils/tablist.js');

/** Kleinstes Element, das die Selektorwege/Klassen von tablist.js bedient. */
function el(tag, { tabId } = {}) {
  const classes = new Set();
  const attrs = {};
  const node = {
    tag,
    dataset: tabId ? { tabId } : {},
    tabIndex: -1,
    _focused: false,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      has: (c) => classes.has(c),
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; },
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 20 }; },
    focus() { node._focused = true; global.document.activeElement = node; },
    closest(sel) { return sel === '[data-tab-id]' && tabId ? node : null; },
    _listeners: {},
    addEventListener(type, handler) {
      (node._listeners[type] ??= []).push(handler);
    },
    dispatch(type, event) {
      for (const handler of node._listeners[type] ?? []) handler(event);
    },
  };
  return node;
}

/** Container mit vier Tab-Buttons, wie Schedules eigene Leiste (S-10). */
function makeTablist() {
  const buttons = ['shifts', 'patterns', 'statistics', 'overview'].map((id) => el('button', { tabId: id }));
  const container = el('div');
  container.scrollLeft = 0;
  container.querySelectorAll = (sel) => (sel === '[data-tab-id]' ? buttons : []);
  return { container, buttons };
}

function keydown(key) {
  return { key, preventDefault() { this.defaultPrevented = true; } };
}

test('manualActivation: ArrowRight only moves focus, does not call onChange or repaint the active tab', () => {
  const { container, buttons } = makeTablist();
  global.document = { activeElement: buttons[0] };
  let changeCount = 0;
  wireTablist(container, { activeId: 'shifts', manualActivation: true, onChange: () => { changeCount += 1; } });

  container.dispatch('keydown', keydown('ArrowRight'));

  assert.equal(changeCount, 0, 'arrow keys must not activate a tab under manualActivation');
  assert.equal(buttons[1]._focused, true, 'focus must move to the next tab');
  assert.equal(buttons[0].getAttribute('aria-selected'), 'true', 'the previously active tab must still be selected - nothing was committed');
  assert.equal(buttons[1].getAttribute('aria-selected'), 'false', 'the merely-focused tab must not become selected yet');
});

test('manualActivation: repeated ArrowRight presses never call onChange (the exact #1099 bug)', () => {
  const { container, buttons } = makeTablist();
  global.document = { activeElement: buttons[0] };
  let changeCount = 0;
  wireTablist(container, { activeId: 'shifts', manualActivation: true, onChange: () => { changeCount += 1; } });

  container.dispatch('keydown', keydown('ArrowRight'));
  container.dispatch('keydown', keydown('ArrowRight'));
  container.dispatch('keydown', keydown('ArrowRight'));

  assert.equal(changeCount, 0, 'browsing through every tab with the keyboard must not fire onChange even once');
  assert.equal(buttons[3]._focused, true, 'focus must have advanced three tabs (shifts -> patterns -> statistics -> overview)');
});

test('manualActivation: Enter commits the focused tab, calling onChange exactly once', () => {
  const { container, buttons } = makeTablist();
  global.document = { activeElement: buttons[0] };
  const changed = [];
  wireTablist(container, { activeId: 'shifts', manualActivation: true, onChange: (id) => changed.push(id) });

  container.dispatch('keydown', keydown('ArrowRight')); // focus -> patterns, no commit
  // Ein echtes 'keydown' blubbert vom Button zum Container hoch - der Stub
  // bildet das nicht nach, darum hier direkt am Container mit `target` wie
  // beim echten Event.
  container.dispatch('keydown', { key: 'Enter', preventDefault() {}, target: buttons[1] });

  assert.deepEqual(changed, ['patterns'], 'Enter must commit exactly the focused tab, exactly once');
  assert.equal(buttons[1].getAttribute('aria-selected'), 'true', 'the committed tab is now the active one');
  assert.equal(buttons[0].getAttribute('aria-selected'), 'false');
});

test('without manualActivation (default, every other wireTablist caller), ArrowRight still activates immediately', () => {
  const { container, buttons } = makeTablist();
  global.document = { activeElement: buttons[0] };
  const changed = [];
  wireTablist(container, { activeId: 'shifts', onChange: (id) => changed.push(id) });

  container.dispatch('keydown', keydown('ArrowRight'));

  assert.deepEqual(changed, ['patterns'], 'automatic activation (the default, unchanged for budget/calendar/rewards/housekeeping/kitchen/health) must still fire onChange on every arrow press');
});

// R16 (Bewegung): der Reiterwechsel nennt seine Richtung in der Reihenfolge der
// Leiste, damit der neue Inhalt von der Seite kommt, zu der man gewechselt hat
// (utils/content-swap.js). Vorwaerts +1, rueckwaerts -1 - auch ueber den Umbruch
// der Pfeiltasten hinweg zaehlt die Lage in der Leiste, nicht die Taste.
test('onChange carries the direction of the switch in tab order', () => {
  const { container, buttons } = makeTablist();
  global.document = { activeElement: buttons[0] };
  const seen = [];
  const handle = wireTablist(container, { activeId: buttons[0].dataset.tabId, onChange: (id, meta) => seen.push([id, meta?.direction]) });

  handle.setActive(buttons[2].dataset.tabId);
  handle.setActive(buttons[1].dataset.tabId);
  handle.setActive('not-in-the-bar');

  assert.deepEqual(seen, [
    [buttons[2].dataset.tabId, 1],
    [buttons[1].dataset.tabId, -1],
    ['not-in-the-bar', 0],
  ]);
});

// ---------------------------------------------------------------------------
// #1504: der aktive Reiter liegt im sichtbaren Bereich der Leiste - auch wenn
// die Leiste einrastet.
//
// Gemessen im Browser (Budget, de, 390px): "Kredite" stand bei 327-404, die
// Leiste endet bei 374, scrollLeft blieb 0. scrollTabIntoView schob um die
// fehlenden 30px, und `scroll-snap-type: x proximity` mit `snap-align: start`
// zog die Leiste auf den naechsten Rastpunkt zurueck - der lag bei 0. Dasselbe
// bei 320 (Abos, 21px), 360 (Berichte, 8px) und 414 (Kredite 6px, Berichte
// 20px); bei 375 traf der Rastpunkt zufaellig.
//
// Der Stub modelliert deshalb genau das, was die Regel bricht: eine Leiste,
// deren scrollLeft nach JEDEM Setzen auf den naechsten Rastpunkt springt (die
// strengste Fassung von Einrasten - haelt der aktive Reiter dort, haelt er bei
// `proximity` erst recht). Die Reiterbreiten sind die gemessenen.
// ---------------------------------------------------------------------------
const BUDGET_TABS = [
  ['budget', 0, 82], ['accounts', 85, 148], ['plan', 151, 196], ['subscriptions', 199, 309],
  ['loans', 311, 388], ['reports', 391, 463], ['split-expenses', 465, 551],
];
const STRIP_LEFT = 16;
const PAD = 24;

function makeSnappingStrip({ width, rtl = false, snap = true }) {
  const scrollWidth = BUDGET_TABS.at(-1)[2];
  const max = Math.max(0, scrollWidth - width);
  const clamp = (v) => Math.min(max, Math.max(0, v));
  const snapPoints = BUDGET_TABS.map(([, start]) => clamp(start - PAD));
  let pos = 0; // logische Scroll-Lage, 0 am Anfang der Leiste
  const container = el('div');
  container.clientWidth = width;
  container.scrollWidth = scrollWidth;
  container.getBoundingClientRect = () => ({ left: STRIP_LEFT, right: STRIP_LEFT + width, top: 0, bottom: 44 });
  Object.defineProperty(container, 'scrollLeft', {
    get: () => (rtl ? -pos : pos),
    set: (value) => {
      let next = clamp(rtl ? -value : value);
      if (snap) next = snapPoints.reduce((best, p) => (Math.abs(p - next) < Math.abs(best - next) ? p : best), snapPoints[0]);
      pos = next;
    },
  });
  const buttons = BUDGET_TABS.map(([id, start, end]) => {
    const b = el('button', { tabId: id });
    b.getBoundingClientRect = () => (rtl
      ? { left: STRIP_LEFT + width - end + pos, right: STRIP_LEFT + width - start + pos, top: 0, bottom: 44 }
      : { left: STRIP_LEFT + start - pos, right: STRIP_LEFT + end - pos, top: 0, bottom: 44 });
    return b;
  });
  container.querySelectorAll = (sel) => (sel === '[data-tab-id]' ? buttons : []);
  global.getComputedStyle = (node) => (node === container
    ? { direction: rtl ? 'rtl' : 'ltr', scrollSnapType: snap ? 'x proximity' : 'none', scrollPaddingInlineStart: `${PAD}px`, scrollPaddingInlineEnd: `${PAD}px` }
    : { scrollSnapAlign: snap ? 'start' : 'none' });
  /** Wie viele Pixel des Reiters ausserhalb der Leiste liegen. */
  const cut = (id) => {
    const r = buttons.find((b) => b.dataset.tabId === id).getBoundingClientRect();
    return Math.max(0, STRIP_LEFT - r.left) + Math.max(0, r.right - (STRIP_LEFT + width));
  };
  return { container, buttons, cut };
}

// Leistenbreiten = Viewport minus 2 x 16px Seitenrand: 320, 360, 375, 390, 414.
const STRIP_WIDTHS = [288, 328, 343, 358, 382];

for (const rtl of [false, true]) {
  const label = rtl ? 'rtl' : 'ltr';

  test(`#1504 (${label}): a snapping strip opened on any tab shows that tab completely`, () => {
    const hidden = [];
    for (const width of STRIP_WIDTHS) {
      for (const [id] of BUDGET_TABS) {
        const { container, buttons, cut } = makeSnappingStrip({ width, rtl });
        global.document = { activeElement: buttons[0] };
        wireTablist(container, { activeId: id });
        if (cut(id) > 0.5) hidden.push(`${width}px ${id}: ${Math.round(cut(id))}px outside`);
      }
    }
    assert.deepEqual(hidden, [], 'a reload or deep link must not leave the active tab outside the strip');
  });

  test(`#1504 (${label}): switching between any two tabs of a snapping strip shows the new one completely`, () => {
    const hidden = [];
    for (const width of STRIP_WIDTHS) {
      for (const [from] of BUDGET_TABS) {
        for (const [to] of BUDGET_TABS) {
          if (from === to) continue;
          const { container, buttons, cut } = makeSnappingStrip({ width, rtl });
          global.document = { activeElement: buttons[0] };
          const handle = wireTablist(container, { activeId: from });
          handle.setActive(to);
          if (cut(to) > 0.5) hidden.push(`${width}px ${from} -> ${to}: ${Math.round(cut(to))}px outside`);
        }
      }
    }
    assert.deepEqual(hidden, []);
  });

  test(`#1504 (${label}): a strip without snapping still brings the tab in, and leaves a visible one alone`, () => {
    const { container, buttons, cut } = makeSnappingStrip({ width: 358, rtl, snap: false });
    global.document = { activeElement: buttons[0] };
    const handle = wireTablist(container, { activeId: 'budget' });
    assert.equal(Math.abs(container.scrollLeft), 0, 'a visible tab must not move the strip');
    handle.setActive('accounts');
    assert.equal(Math.abs(container.scrollLeft), 0, 'a visible tab must not move the strip');
    handle.setActive('loans');
    assert.ok(cut('loans') <= 0.5, 'the tab is inside the strip');
    handle.setActive('budget');
    assert.equal(Math.abs(container.scrollLeft), 0, 'going back to the first tab returns to the start');
  });
}
