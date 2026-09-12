/**
 * Verifies that a page refresh survives the category manager modal closing
 * before its asynchronous DELETE request completes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = class HTMLElement extends EventTarget {};
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail;
  }
};
globalThis.window = { yuvomi: { showToast() {} } };
globalThis.CSS = { escape: String };

let CategoryManager;
globalThis.customElements = {
  define(name, constructor) {
    if (name === 'yuvomi-category-manager') CategoryManager = constructor;
  },
};

const { api } = await import('/api.js');
await import('../public/components/category-manager.js');

function managerWithCategory(options = {}) {
  const manager = new CategoryManager();
  manager._renderShell = () => {};
  manager._load = () => {};
  manager.configure({ basePath: '/notes/categories', ...options });
  manager._cats = [{ id: 7, name: 'Old', scope: 'personal' }];
  manager._renderGroup = () => {};
  return manager;
}

test('the caller deleteConfirmKey reaches the confirmation dialog', async () => {
  let question;
  globalThis.__confirmOverModal = (...args) => { [question] = args; return false; };
  try {
    const manager = managerWithCategory({ deleteConfirmKey: 'shopping.deleteShopConfirm' });
    await manager._delete('7');
    assert.match(question, /^shopping\.deleteShopConfirm/);
    assert.equal(manager._cats.length, 1);
  } finally {
    delete globalThis.__confirmOverModal;
  }
});

test('scope help supports focus, hover, touch and Escape before modal dismissal', () => {
  const attrs = new Map([['aria-expanded', 'false']]);
  const button = new EventTarget();
  button.setAttribute = (name, value) => attrs.set(name, value);
  button.getAttribute = (name) => attrs.get(name);
  const manager = managerWithCategory();
  manager._groupsEl = new EventTarget();
  manager._groupsEl.querySelector = () => button;
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: button };
  try {
    manager._wireScopeHelp();
    button.dispatchEvent(new Event('focus'));
    assert.equal(attrs.get('aria-expanded'), 'true');
    let stopped = false;
    const escape = new Event('keydown');
    escape.key = 'Escape';
    escape.stopPropagation = () => { stopped = true; };
    manager._groupsEl.dispatchEvent(escape);
    assert.ok(stopped, 'Escape must not dismiss the containing modal');
    assert.equal(attrs.get('aria-expanded'), 'false');
    button.dispatchEvent(new Event('click'));
    assert.equal(attrs.get('aria-expanded'), 'true');
    button.dispatchEvent(new Event('blur'));
    assert.equal(attrs.get('aria-expanded'), 'false');
    globalThis.document.activeElement = null;
    button.dispatchEvent(new Event('mouseenter'));
    assert.equal(attrs.get('aria-expanded'), 'true');
    button.dispatchEvent(new Event('mouseleave'));
    assert.equal(attrs.get('aria-expanded'), 'false');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('configured row icon resolver controls the rendered category glyph', () => {
  const manager = managerWithCategory({
    rowIconResolver: (category) => category.scope === 'personal' ? 'user-round' : 'house',
  });

  const markup = manager._markHtml({ id: 7, name: 'Old', scope: 'personal', icon: 'fallback' });

  assert.match(markup, /data-lucide="user-round"/);
  assert.doesNotMatch(markup, /data-lucide="fallback"/);
});

test('configured scope label key labels the unified scope selector', () => {
  const manager = managerWithCategory({
    unifiedAdd: true,
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
    addScopeLabelKey: 'custom.scope.label',
  });

  assert.match(manager._unifiedAddFormHtml(), /aria-label="custom\.scope\.label"/);
});

test('configured add-name limit reaches the unified category input', () => {
  const legacy = managerWithCategory({ unifiedAdd: true });
  const notes = managerWithCategory({ unifiedAdd: true, addMaxLength: 80 });

  assert.match(legacy._unifiedAddFormHtml(), /maxlength="60"/);
  assert.match(notes._unifiedAddFormHtml(), /maxlength="80"/);
});

test('configured group field renders categories returned with a scope', () => {
  const manager = managerWithCategory({
    groupField: 'scope',
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
  });
  manager._cats = [
    { id: 7, name: 'Mine', scope: 'personal' },
    { id: 8, name: 'Family', scope: 'household' },
  ];

  const markup = manager._groupSectionHtml(manager._groups[1]);

  assert.match(markup, />Family</);
  assert.doesNotMatch(markup, />Mine</);
});

test('configured group field submits a household category with the API scope contract', async () => {
  let posted;
  api.post = async (path, body) => {
    posted = { path, body };
    return { data: { id: 8, ...body } };
  };
  const manager = managerWithCategory({
    groupField: 'scope',
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
    unifiedAdd: true,
  });
  const input = { value: 'Family' };
  const form = {
    dataset: { group: 'personal' },
    querySelector(selector) {
      return selector === 'input' ? input : { value: 'household' };
    },
  };

  await manager._onSubmit({
    preventDefault() {},
    target: { closest: (selector) => selector === '.cat-add-form' ? form : null },
  });

  assert.deepEqual(posted, {
    path: '/notes/categories',
    body: { name: 'Family', scope: 'household' },
  });
  assert.equal(manager._cats.at(-1).scope, 'household');
});

test('a 409 reopens rename with the rejected value', async () => {
  const previousPut = api.put;
  const defaults = [];
  const answers = ['Rejected', null];
  let attempts = 0;
  globalThis.__promptModal = (_label, defaultValue) => {
    defaults.push(defaultValue);
    return answers.shift();
  };
  api.put = async () => {
    attempts += 1;
    throw Object.assign(new Error('exists'), { status: 409 });
  };
  try {
    const manager = managerWithCategory();
    await manager._rename('7');

    assert.deepEqual(defaults, ['Old', 'Rejected']);
    assert.equal(attempts, 1);
    assert.equal(manager._cats[0].name, 'Old');
  } finally {
    api.put = previousPut;
    delete globalThis.__promptModal;
  }
});

test('a non-409 rename error stops without reopening', async () => {
  const previousPut = api.put;
  const defaults = [];
  globalThis.__promptModal = (_label, defaultValue) => {
    defaults.push(defaultValue);
    return 'Offline name';
  };
  api.put = async () => {
    throw Object.assign(new Error('offline'), { status: 0 });
  };
  try {
    const manager = managerWithCategory();
    await manager._rename('7');

    assert.deepEqual(defaults, ['Old']);
    assert.equal(manager._cats[0].name, 'Old');
  } finally {
    api.put = previousPut;
    delete globalThis.__promptModal;
  }
});

test('a successful retry persists the accepted rename', async () => {
  const previousPut = api.put;
  const defaults = [];
  const answers = ['Taken', 'Accepted'];
  let attempts = 0;
  globalThis.__promptModal = (_label, defaultValue) => {
    defaults.push(defaultValue);
    return answers.shift();
  };
  api.put = async (_path, body) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('exists'), { status: 409 });
    return { data: { id: 7, name: body.name, scope: 'personal' } };
  };
  try {
    const manager = managerWithCategory();
    let changes = 0;
    manager.addEventListener('category-manager-changed', () => { changes += 1; });
    await manager._rename('7');

    assert.deepEqual(defaults, ['Old', 'Taken']);
    assert.equal(attempts, 2);
    assert.equal(manager._cats[0].name, 'Accepted');
    assert.equal(changes, 1);
  } finally {
    api.put = previousPut;
    delete globalThis.__promptModal;
  }
});

test('a stale 409 reports the error without reopening rename in a newer modal context', async () => {
  const previousPut = api.put;
  const previousShowToast = globalThis.window.yuvomi.showToast;
  const defaults = [];
  const toasts = [];
  let contextId = 'rename-context';
  let attempts = 0;
  globalThis.__modalContextId = () => contextId;
  globalThis.__promptModal = (_label, defaultValue) => {
    defaults.push(defaultValue);
    return defaults.length === 1 ? 'Rejected' : null;
  };
  globalThis.window.yuvomi.showToast = (message, tone) => { toasts.push({ message, tone }); };
  api.put = async () => {
    attempts += 1;
    contextId = 'newer-modal-context';
    throw Object.assign(new Error('exists'), { status: 409 });
  };
  try {
    const manager = managerWithCategory();
    await manager._rename('7');

    assert.deepEqual(defaults, ['Old']);
    assert.equal(attempts, 1);
    assert.deepEqual(toasts, [{ message: 'exists', tone: 'danger' }]);
    assert.equal(manager._cats[0].name, 'Old');
  } finally {
    api.put = previousPut;
    globalThis.window.yuvomi.showToast = previousShowToast;
    delete globalThis.__modalContextId;
    delete globalThis.__promptModal;
  }
});

test('cancelling rename sends no request and keeps the category', async () => {
  const previousPut = api.put;
  let attempts = 0;
  globalThis.__promptModal = () => null;
  api.put = async () => {
    attempts += 1;
    return { data: { id: 7, name: 'Unexpected', scope: 'personal' } };
  };
  try {
    const manager = managerWithCategory();
    await manager._rename('7');

    assert.equal(attempts, 0);
    assert.equal(manager._cats[0].name, 'Old');
  } finally {
    api.put = previousPut;
    delete globalThis.__promptModal;
  }
});

test('das verzoegerte DELETE meldet sich beim Zuhoerer, der sich nicht abgemeldet hat', async () => {
  let finishDelete;
  let signalDeleteStarted;
  const deleteStarted = new Promise((resolve) => { signalDeleteStarted = resolve; });
  api.delete = () => {
    signalDeleteStarted();
    return new Promise((resolve) => { finishDelete = resolve; });
  };

  const details = [];
  const manager = managerWithCategory();
  manager.addEventListener('category-manager-changed', (e) => { details.push(e.detail); });

  // test-browser-loader.mjs loest confirmOverModal() bereits zu true auf. Auf die
  // Anfrage selbst warten, statt anzunehmen, dass dynamischer Import und Bestaetigung
  // nach einer Runde der Ereignisschleife beide durch sind.
  const deletion = manager._delete('7');
  await deleteStarted;

  // Der Loeschdialog hat das Modal an dieser Stelle laengst geschlossen. Der
  // Zuhoerer haengt am Element, nicht am Dokument, und meldet sich nicht ab -
  // genau das haelt der Wachhund in test-frontend-audit.js ueber alle Aufrufer fest.
  finishDelete({ data: null });
  await deletion;

  assert.deepEqual(details.map(({ action, key }) => ({ action, key })), [{ action: 'delete', key: '7' }]);
  assert.deepEqual(manager._cats, []);
});

test('ein fehlgeschlagenes DELETE behaelt die Kategorie und meldet keine Aenderung', async () => {
  api.delete = async () => { throw new Error('offline'); };
  let eventCount = 0;
  const manager = managerWithCategory();
  manager.addEventListener('category-manager-changed', () => { eventCount += 1; });

  await manager._delete('7');

  assert.equal(eventCount, 0);
  assert.equal(manager._cats.length, 1);
});

test('ohne Argument traegt das Ereignis ein leeres detail, kein undefined', () => {
  // `refresh(e.detail)` in notes.js liest `change.action` - kaeme hier `undefined`
  // heraus, wuerde jede Mutation ausser dem Loeschen am Zugriff scheitern.
  let seen = 'nicht gefeuert';
  const manager = managerWithCategory();
  manager.addEventListener('category-manager-changed', (e) => { seen = e.detail; });

  manager._notifyChanged();

  assert.deepEqual(seen, {});
});
