import test from 'node:test';
import assert from 'node:assert/strict';

test('polled fasting browser notification focuses and SPA-navigates on click', async () => {
  const navigated = [];
  let focused = 0;
  let closed = 0;
  let scheduledDelay = null;
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) {
      this.title = title;
      this.options = options;
      FakeNotification.last = this;
    }
    close() { closed += 1; }
  }
  globalThis.window = {
    Notification: FakeNotification,
    focus: () => { focused += 1; },
    yuvomi: { navigate: (path) => navigated.push(path) },
  };
  globalThis.Notification = FakeNotification;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (_fn, delay) => { scheduledDelay = delay; return 1; };
  try {
    const { showBrowserNotification } = await import('../public/reminders.js');
    showBrowserNotification('Půst', 'Cíl splněn', '/health/fasting');
    assert.equal(FakeNotification.last.title, 'Půst');
    assert.deepEqual(FakeNotification.last.options, { body: 'Cíl splněn', icon: '/icons/icon-192.png' });
    assert.equal(scheduledDelay, 8000);
    FakeNotification.last.onclick();
    assert.equal(focused, 1);
    assert.deepEqual(navigated, ['/health/fasting']);
    assert.equal(closed, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.Notification;
    delete globalThis.window;
  }
});

test('polling payload reaches fasting toast and notification while non-fasting fallbacks stay unchanged', async () => {
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {};
      this.style = { setProperty() {} };
      this.classList = { add() {} };
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelectorAll() { return this.children.filter((child) => child.className?.includes('toast')); }
    remove() { this.removed = true; }
  }
  const container = new Element('div');
  const notifications = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
    close() {}
  }
  const navigated = [];
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    getElementById: () => container,
  };
  globalThis.window = { Notification: FakeNotification, yuvomi: { navigate: (path) => navigated.push(path) } };
  globalThis.Notification = FakeNotification;
  globalThis.__apiStub = { patch: async () => ({}) };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 1;
  try {
    const { processReminders } = await import('../public/reminders.js');
    processReminders([{ id: 101, entity_type: 'fasting_goal', entity_title: '', notification_title: 'Půst', notification_body: 'Cíl splněn', target_url: '/health/fasting' }]);
    const fastingToast = container.children.at(-1);
    assert.equal(fastingToast.children[1].children[1].textContent, 'Cíl splněn');
    assert.equal(notifications.at(-1).title, 'Půst');
    assert.equal(notifications.at(-1).options.body, 'Cíl splněn');
    fastingToast.listeners.click({ target: null });
    assert.deepEqual(navigated, ['/health/fasting']);

    processReminders([{ id: 102, entity_type: 'task', entity_title: 'Buy milk' }]);
    const taskToast = container.children.at(-1);
    assert.equal(taskToast.children[1].children[1].textContent, 'Buy milk');
    assert.equal(notifications.at(-1).options.body, 'Buy milk');
    assert.equal(notifications.at(-1).onclick, undefined);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.__apiStub;
    delete globalThis.Notification;
    delete globalThis.window;
    delete globalThis.document;
  }
});
