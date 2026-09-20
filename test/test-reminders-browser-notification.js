import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add() {} };
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll() { return this.children.filter((child) => child.className?.includes('toast')); }
  remove() { this.removed = true; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('reminder toast text follows the document direction in RTL locales', () => {
  const css = readFileSync(new URL('../public/styles/reminders.css', import.meta.url), 'utf8');
  const rule = css.match(/\.toast__reminder-text\s*\{[^}]+\}/)?.[0] || '';
  assert.match(rule, /text-align:\s*start/);
  assert.doesNotMatch(rule, /text-align:\s*left/);
});

test('polling localizes fasting reminders on the device and exposes a keyboard link', async () => {
  const container = new Element('div');
  const notifications = [];
  const navigated = [];
  const dismissed = [];
  let focused = 0;
  let pending = [{ id: 101, entity_type: 'fasting_goal', entity_id: 7, entity_title: null }];

  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notifications.push(this);
    }
    close() { this.closed = true; }
  }

  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    getElementById: () => container,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    Notification: FakeNotification,
    focus: () => { focused += 1; },
    yuvomi: { navigate: (path) => navigated.push(path) },
  };
  globalThis.Notification = FakeNotification;
  globalThis.__apiStub = {
    get: async () => ({ data: pending }),
    patch: async (path) => { dismissed.push(path); return {}; },
  };
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = () => 1;
  globalThis.setInterval = () => 2;
  globalThis.clearInterval = () => {};

  const { init, refresh, stop } = await import('../public/reminders.js');
  try {
    init();
    await settle();

    const goalToast = container.children.at(-1);
    const goalAction = goalToast.children[1];
    assert.equal(goalAction.tag, 'button');
    assert.equal(goalAction.type, 'button');
    assert.equal(goalAction.children[1].textContent, 'health.fasting.goalReached');
    assert.equal(notifications.at(-1).title, 'health.fasting.title');
    assert.equal(notifications.at(-1).options.body, 'health.fasting.goalReached');
    goalAction.listeners.click();
    assert.deepEqual(navigated, ['/health/fasting']);
    assert.deepEqual(dismissed, ['/reminders/101/dismiss']);

    notifications[0].onclick();
    assert.equal(focused, 1);
    assert.deepEqual(navigated, ['/health/fasting', '/health/fasting']);
    assert.equal(notifications[0].closed, true);

    pending = [{ id: 102, entity_type: 'fasting_next_start', entity_id: 7, entity_title: null }];
    refresh();
    await settle();
    assert.equal(container.children.at(-1).children[1].children[1].textContent, 'health.fasting.remindNext');
    assert.equal(notifications.at(-1).options.body, 'health.fasting.remindNext');

    pending = [{ id: 103, entity_type: 'task', entity_title: 'Buy milk' }];
    refresh();
    await settle();
    const taskToast = container.children.at(-1);
    const taskAction = taskToast.children[1];
    assert.equal(taskAction.tag, 'button');
    assert.equal(taskAction.type, 'button');
    assert.equal(taskAction.children[1].textContent, 'Buy milk');
    assert.equal(notifications.at(-1).options.body, 'Buy milk');
    assert.equal(notifications.at(-1).onclick, undefined);
    taskAction.listeners.click();
    await settle();
    assert.equal(taskToast.removed, true);
    assert.deepEqual(dismissed, ['/reminders/101/dismiss', '/reminders/103/dismiss']);
    assert.deepEqual(navigated, ['/health/fasting', '/health/fasting']);
  } finally {
    stop();
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    delete globalThis.__apiStub;
    delete globalThis.Notification;
    delete globalThis.window;
    delete globalThis.document;
  }
});
