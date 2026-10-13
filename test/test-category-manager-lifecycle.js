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

// --------------------------------------------------------------------------
// Sprache der Liste (#1859)
// --------------------------------------------------------------------------
// Budget ist der eine Aufrufer, dessen Route die Labels auf dem Server
// uebersetzt. Ohne `lang` antwortet sie in der Haushaltssprache - die
// Oberflaeche ist aber je Browser gewaehlt, und ein Mitglied mit anderer
// Browsersprache saehe sonst im Verwalter eine andere Sprache als ringsum.
async function listPathFor(options, locale) {
  const previousGet = api.get;
  const previousLocale = globalThis.__locale;
  const paths = [];
  api.get = async (path) => { paths.push(path); return { data: [{ key: 'housing', name: 'Housing' }] }; };
  if (locale === undefined) delete globalThis.__locale; else globalThis.__locale = locale;
  try {
    const manager = managerWithCategory(options);
    await manager._fetch();
    assert.deepEqual(manager._cats, [{ key: 'housing', name: 'Housing' }]);
    return paths;
  } finally {
    api.get = previousGet;
    if (previousLocale === undefined) delete globalThis.__locale; else globalThis.__locale = previousLocale;
  }
}

test('localizedLabels: die Liste wird in der Oberflaechensprache des Browsers angefragt', async () => {
  assert.deepEqual(
    await listPathFor({ basePath: '/budget/categories', localizedLabels: true }, 'en'),
    ['/budget/categories?lang=en'],
  );
  // Die Sprache wird je Abruf gelesen, nicht beim configure() eingefroren, und
  // ein Tag mit Region geht unverstuemmelt durch.
  assert.deepEqual(
    await listPathFor({ basePath: '/budget/categories', localizedLabels: true }, 'pt-BR'),
    ['/budget/categories?lang=pt-BR'],
  );
});

test('ohne localizedLabels bleibt der Listenpfad der nackte basePath', async () => {
  // Die acht uebrigen Aufrufer uebersetzen im Browser; ihre Routen kennen kein
  // `lang`, und ein angehaengter Parameter waere nur ein zweiter Cache-Schluessel
  // neben dem, unter dem die Seite dieselbe Liste holt.
  assert.deepEqual(await listPathFor({ basePath: '/tasks/categories' }, 'en'), ['/tasks/categories']);
});

test('localizedLabels: Schreibwege tragen die Sprache nicht', async () => {
  const previousPut = api.put;
  const previousDelete = api.delete;
  const paths = [];
  globalThis.__promptModal = () => 'New';
  globalThis.__confirmOverModal = () => true;
  api.put = async (path) => { paths.push(path); return { data: { id: 7, name: 'New' } }; };
  api.delete = async (path) => { paths.push(path); return { data: null }; };
  try {
    const manager = managerWithCategory({ basePath: '/budget/categories', localizedLabels: true });
    await manager._rename('7');
    await manager._delete('7');
    assert.deepEqual(paths, ['/budget/categories/7', '/budget/categories/7']);
  } finally {
    api.put = previousPut;
    api.delete = previousDelete;
    delete globalThis.__promptModal;
    delete globalThis.__confirmOverModal;
  }
});

// #1909: der Verwalter zeigt den Satz der App, nicht den des Servers - dort,
// wo der Aufrufer es verlangt (`errorFallbackKey`, heute der Einkauf).
const serverAnswer = (status, error, reason) => Object.assign(new Error(error), {
  status, data: { error, code: status, ...(reason ? { reason } : {}) },
});

test('errorFallbackKey: ein Fehler ohne bekannten Grund zeigt den allgemeinen Satz, nie den des Servers', () => {
  const manager = managerWithCategory({ basePath: '/shopping/stores', errorFallbackKey: 'common.errorGeneric' });
  assert.equal(manager._errMsg(serverAnswer(400, 'Name ist erforderlich.')), 'common.errorGeneric');
  assert.equal(manager._errMsg(serverAnswer(409, 'Diesen Laden gibt es schon.', 'some_future_reason')), 'common.errorGeneric');
  // Ein Fall, den die App kennt, bekommt seinen Satz - auch ein fremder des Verwalters.
  assert.equal(manager._errMsg(serverAnswer(409, 'Store already exists.', 'shopping_store_exists')), 'shopping.errorStoreExists');
  assert.equal(manager._errMsg(serverAnswer(404, 'Store not found.', 'shopping_store_not_found')), 'shopping.errorStoreGone');
  assert.equal(manager._errMsg(serverAnswer(403, 'Not authorized.')), 'common.errorNoPermission');
  // Die eigenen Gruende des Verwalters bleiben, wie sie waren.
  assert.equal(manager._errMsg(serverAnswer(409, 'Category already exists.', 'category_exists')), 'category.errorExists');
  assert.equal(manager._errMsg(serverAnswer(400, 'The last category cannot be deleted.', 'category_last')), 'category.errorLast');
});

test('ohne errorFallbackKey bleibt der Rueckfall der anderen Module unveraendert', () => {
  const manager = managerWithCategory();
  assert.equal(manager._errMsg(serverAnswer(400, 'Name ist erforderlich.')), 'Name ist erforderlich.');
  assert.equal(manager._errMsg(serverAnswer(409, 'Category already exists.', 'category_exists')), 'category.errorExists');
});

test('der Einkauf verlangt den allgemeinen Satz an beiden Verwaltern', async () => {
  const { readFileSync } = await import('node:fs');
  const { withoutCommentsKeepingLines } = await import('./source-text.js');
  const page = withoutCommentsKeepingLines(readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8'));
  const calls = [...page.matchAll(/manager\.configure\(\{[\s\S]*?\n\s*\}\);/g)].map((m) => m[0]);
  assert.equal(calls.length, 2, 'Laeden und Kategorien');
  for (const call of calls) assert.match(call, /errorFallbackKey:\s*'common\.errorGeneric'/);
});

// #1909: sagt der Server, dass es die Zeile nicht mehr gibt (jemand anderes hat
// sie geloescht, waehrend der Dialog offen war), holt der Manager seine Liste
// selbst neu und meldet dem Aufrufer eine Aenderung - der Satz raet nicht mehr
// zum Neuladen. Gefahren wird das echte `_delete` bis in sein catch.
async function deleteAnswering(err, { connected = true, options = {} } = {}) {
  const manager = managerWithCategory({ basePath: '/shopping/stores', errorFallbackKey: 'common.errorGeneric', ...options });
  let loads = 0;
  manager._load = () => { loads += 1; };
  manager.isConnected = connected;
  let changed = 0;
  const details = [];
  manager.addEventListener('category-manager-changed', (e) => { changed += 1; details.push(e.detail); });
  const toasts = [];
  const previousToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = (text, kind) => toasts.push([text, kind]);
  globalThis.__confirmOverModal = () => true;
  // Direkt gesetzt wie in den Faellen oben: sie haben `api.delete` ersetzt.
  const previousDelete = api.delete;
  api.delete = async () => { throw err; };
  try {
    await manager._delete('7');
  } finally {
    delete globalThis.__confirmOverModal;
    api.delete = previousDelete;
    globalThis.window.yuvomi.showToast = previousToast;
  }
  // Nicht aufzaehlbar: die Faelle oben vergleichen das Ergebnis als Ganzes.
  return Object.defineProperties({ loads, changed, toasts }, {
    details: { value: details }, rows: { value: manager._cats.length },
  });
}

test('a row that is gone on the server reloads the manager and tells the page', async () => {
  const gone = serverAnswer(404, 'Store not found.', 'shopping_store_not_found');
  assert.deepEqual(await deleteAnswering(gone), {
    loads: 1, changed: 1, toasts: [['shopping.errorStoreGone', 'danger']],
  });
  // Beim Loeschen ist das Element schon aus dem Dokument: nichts zu zeichnen,
  // aber die Seite darunter muss es trotzdem erfahren.
  const detached = await deleteAnswering(gone, { connected: false });
  assert.equal(detached.loads, 0);
  assert.equal(detached.changed, 1);
});

test('any other failure reloads nothing', async () => {
  for (const err of [
    serverAnswer(404, 'Not found.'),
    serverAnswer(409, 'Store already exists.', 'shopping_store_exists'),
    serverAnswer(403, 'Not authorized.', 'shopping_store_not_found'),
    serverAnswer(500, 'Internal error.'),
  ]) {
    const { loads, changed, toasts } = await deleteAnswering(err);
    assert.equal(loads, 0);
    assert.equal(changed, 0);
    assert.equal(toasts.length, 1);
  }
});

test('a failing load does not start another load', async () => {
  const manager = new CategoryManager();
  manager._renderShell = () => {};
  let fetches = 0;
  let changed = 0;
  manager.addEventListener('category-manager-changed', () => { changed += 1; });
  manager._fetch = async () => { fetches += 1; throw serverAnswer(404, 'Store not found.', 'shopping_store_not_found'); };
  await manager._load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.equal(changed, 0);
});

// #1909, Folge: wer eine Zeile loescht, die jemand anderes schon geloescht hat,
// hat sein Ziel erreicht. Den Grund dafuer nennt der AUFRUFER
// (`alreadyDeletedReason`) - die Komponente kennt keinen Grund eines Moduls,
// und ohne die Option aendert sich fuer niemanden etwas.
test('alreadyDeletedReason: deleting a row that is already gone takes the success path', async () => {
  for (const [basePath, reason] of [
    ['/shopping/stores', 'shopping_store_not_found'],
    ['/shopping/categories', 'shopping_category_not_found'],
  ]) {
    const result = await deleteAnswering(serverAnswer(404, 'Not found.', reason), {
      options: { basePath, alreadyDeletedReason: reason },
    });
    assert.deepEqual(result.toasts, [['category.deleted', 'default']], reason);
    assert.equal(result.rows, 0, 'the row left the manager');
    assert.equal(result.changed, 1);
    assert.deepEqual(result.details.map(({ action, key, item }) => ({ action, key, id: item?.id })),
      [{ action: 'delete', key: '7', id: 7 }], 'the same event detail as any delete');
    // Der Erfolgsweg laedt nicht neu - das tut nur `_fail`.
    assert.equal(result.loads, 0);
  }
});

test('alreadyDeletedReason: any other failure of a delete stays a failure', async () => {
  const options = { alreadyDeletedReason: 'shopping_store_not_found' };
  for (const [err, sentence, toldPage] of [
    [serverAnswer(404, 'Not found.'), 'common.errorGeneric', false],
    [serverAnswer(500, 'Internal error.'), 'common.errorGeneric', false],
    [serverAnswer(403, 'Not authorized.', 'shopping_store_not_found'), 'common.errorNoPermission', false],
    [serverAnswer(404, 'Not found.', 'some_future_not_found'), 'common.errorGeneric', false],
    [serverAnswer(400, 'The last category cannot be deleted.', 'category_last'), 'category.errorLast', false],
    // Ein anderes Ding ist weg, nicht diese Zeile: Fehler, und `_fail` laedt neu.
    [serverAnswer(404, 'Category not found.', 'shopping_category_not_found'), 'shopping.errorCategoryGone', true],
    [Object.assign(new Error('offline'), { status: 0 }), 'common.errorOfflineMutation', false],
  ]) {
    const result = await deleteAnswering(err, { options });
    assert.deepEqual(result.toasts, [[sentence, 'danger']]);
    assert.equal(result.rows, 1, 'the row stays');
    assert.equal(result.changed, toldPage ? 1 : 0);
    assert.ok(result.details.every((d) => d.action !== 'delete'));
  }
});

test('alreadyDeletedReason: a reason outside the allowlist of gone reasons never counts', async () => {
  // `isAlreadyDeleted` fragt GONE_REASONS: ein Aufrufer kann keinen beliebigen
  // Grund zum Erfolg erklaeren (etwa "in Benutzung").
  for (const reason of ['category_in_use', 'category_last', 'some_future_not_found']) {
    const result = await deleteAnswering(serverAnswer(409, 'Refused.', reason), {
      options: { alreadyDeletedReason: reason },
    });
    assert.equal(result.rows, 1, reason);
    assert.equal(result.toasts[0][1], 'danger', reason);
  }
});

test('without alreadyDeletedReason nothing changes for the other modules', async () => {
  // Die Routen der anderen Module nennen keinen `reason`: eine blanke 404.
  // Und selbst ein Grund des Einkaufs zaehlt ohne die Option nicht.
  const base = { basePath: '/notes/categories', errorFallbackKey: undefined };
  const blank = await deleteAnswering(serverAnswer(404, 'Category not found.'), { options: base });
  assert.deepEqual(blank.toasts, [['Category not found.', 'danger']], 'der alte Rueckfall auf den Servertext');
  assert.equal(blank.rows, 1);
  assert.equal(blank.changed, 0);
  const named = await deleteAnswering(serverAnswer(404, 'Store not found.', 'shopping_store_not_found'), { options: base });
  assert.equal(named.rows, 1);
  assert.equal(named.toasts[0][1], 'danger');
  for (const ignored of ['', null, 42, {}]) {
    const result = await deleteAnswering(serverAnswer(404, 'Store not found.', 'shopping_store_not_found'), {
      options: { alreadyDeletedReason: ignored },
    });
    assert.equal(result.rows, 1, `alreadyDeletedReason: ${JSON.stringify(ignored)}`);
  }
});

test('only shopping names an alreadyDeletedReason, once per manager', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { withoutCommentsKeepingLines } = await import('./source-text.js');
  const dir = new URL('../public/pages/', import.meta.url);
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const page = withoutCommentsKeepingLines(readFileSync(new URL(file, dir), 'utf8'));
    for (const m of page.matchAll(/alreadyDeletedReason:\s*'([^']+)'/g)) found.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(found.sort(), [
    'shopping.js: shopping_category_not_found',
    'shopping.js: shopping_store_not_found',
  ]);
});

// #1929: der Einkauf verwaltet mit dieser Komponente Laeden. Die Rueckfrage hatte
// schon eigene Keys, die drei Erfolgs-Toasts und der Name des Loeschknopfs nicht:
// wer einen Laden loeschte, las "Kategorie geloescht". Gefahren werden die echten
// Wege (`_onSubmit`, `_rename`, `_delete`, `_rowActionsHtml`), je einmal MIT den
// Optionen und einmal OHNE - ohne sie bleibt exakt der bisherige Key.
const STORE_WORDING = {
  addedKey: 'shopping.storeAdded',
  renamedKey: 'shopping.storeRenamed',
  deletedKey: 'shopping.storeDeleted',
  deleteNamedKey: 'shopping.storeDeleteNamed',
};

/** Anlegen, umbenennen und loeschen: die drei Toasts in dieser Reihenfolge. */
async function successToasts(options) {
  const manager = managerWithCategory(options);
  const toasts = [];
  const previousToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = (text, kind) => toasts.push([text, kind]);
  const previous = { post: api.post, put: api.put, delete: api.delete };
  api.post = async (_path, body) => ({ data: { id: 8, ...body } });
  api.put = async (_path, body) => ({ data: { id: 7, ...body } });
  api.delete = async () => ({ data: null });
  globalThis.__promptModal = () => 'Renamed';
  globalThis.__confirmOverModal = () => true;
  try {
    const input = { value: 'Fresh' };
    const form = { dataset: { group: '' }, querySelector: (selector) => (selector === 'input' ? input : null) };
    await manager._onSubmit({
      preventDefault() {},
      target: { closest: (selector) => (selector === '.cat-add-form' ? form : null) },
    });
    await manager._rename('7');
    await manager._delete('7');
  } finally {
    Object.assign(api, previous);
    delete globalThis.__promptModal;
    delete globalThis.__confirmOverModal;
    globalThis.window.yuvomi.showToast = previousToast;
  }
  return toasts;
}

/** Die Namen (`aria-label`) der Zeilenknoepfe, wie `t` aus dem Loader sie schreibt. */
function rowActionLabels(options, rowOptions = {}) {
  const manager = managerWithCategory(options);
  const html = manager._rowActionsHtml('Rewe', { isFirst: false, isLast: false, ...rowOptions });
  return [...html.matchAll(/aria-label="([a-zA-Z.]+)\{/g)].map((m) => m[1]);
}

test('wording options: a manager configured for stores names the store in all three toasts', async () => {
  assert.deepEqual(await successToasts(STORE_WORDING), [
    ['shopping.storeAdded', 'success'],
    ['shopping.storeRenamed', 'success'],
    ['shopping.storeDeleted', 'default'],
  ]);
});

test('wording options: without them the three toasts are exactly the keys they were', async () => {
  assert.deepEqual(await successToasts({}), [
    ['category.added', 'success'],
    ['category.renamed', 'success'],
    ['category.deleted', 'default'],
  ]);
});

test('wording options: the delete button is named after the caller\'s thing', () => {
  assert.deepEqual(rowActionLabels(STORE_WORDING), [
    'category.renameNamed', 'category.moveUpNamed', 'category.moveDownNamed', 'shopping.storeDeleteNamed',
  ]);
  // Eine Unterzeile ist keine Zeile des Aufrufers: sie behaelt ihren eigenen Namen.
  assert.equal(rowActionLabels(STORE_WORDING, { sub: true }).at(-1), 'category.deleteSubNamed');
});

test('wording options: without them the delete button keeps today\'s name', () => {
  assert.deepEqual(rowActionLabels({}), [
    'category.renameNamed', 'category.moveUpNamed', 'category.moveDownNamed', 'category.deleteNamed',
  ]);
  assert.equal(rowActionLabels({}, { sub: true }).at(-1), 'category.deleteSubNamed');
});

test('wording options: an empty or missing value never blanks a text', async () => {
  const blank = { addedKey: '', renamedKey: null, deletedKey: undefined, deleteNamedKey: '' };
  assert.deepEqual((await successToasts(blank)).map(([text]) => text), [
    'category.added', 'category.renamed', 'category.deleted',
  ]);
  assert.equal(rowActionLabels(blank).at(-1), 'category.deleteNamed');
});
