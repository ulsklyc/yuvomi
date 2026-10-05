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
