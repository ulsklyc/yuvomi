/**
 * Test suite: the "Diagnostics" section of the admin sheet "System"
 * (Phase 1b section G, the surface of `GET /api/v1/system/diagnostics`).
 *
 * The sheet is rendered through its real entry `render()` against the mini DOM:
 * every field of the answer shows up as a row, the button puts one plain text
 * (the same in every language, for a bug report) on the clipboard, a browser
 * without a clipboard gets the text marked in a field instead of a false
 * "copied", and a failed request shows one calm sentence with a retry instead
 * of empty rows.
 *
 * Nothing here reads the source of the sheet: the rows are whatever the code
 * built, and the handlers are the ones it attached.
 *
 * Run: npm run test:settings-diagnostics
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement, MiniText } from './mini-dom.js';

installMiniDom();

/** The mini DOM only notes THAT a listener hangs; here it has to run. */
class LiveElement extends MiniElement {
  nodeType = 1;
  hidden = false;
  disabled = false;
  value = '';
  /** @type {Record<string, (event?: unknown) => unknown>} */
  handlers = {};
  classList = {
    add: (/** @type {string[]} */ ...names) => { this.className = [this.className, ...names].filter(Boolean).join(' '); },
  };
  /** @param {string} type @param {(event?: unknown) => unknown} [fn] */
  addEventListener(type, fn) { if (fn) this.handlers[type] = fn; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
/** @type {any} */ (globalThis.document).createElement = (/** @type {string} */ tag) => new LiveElement(tag);

/**
 * Every element below `node`, in document order.
 * @param {any} node
 * @returns {Generator<any>}
 */
function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (child instanceof MiniText || !(child instanceof MiniElement)) continue;
    yield child;
    yield* elements(child);
  }
}
const hasClass = (/** @type {any} */ el, /** @type {string} */ name) => el.className.split(/\s+/).includes(name);
const byClass = (/** @type {any} */ root, /** @type {string} */ name) => [...elements(root)].filter((el) => hasClass(el, name));
const byTag = (/** @type {any} */ root, /** @type {string} */ tag) => [...elements(root)].filter((el) => el.tagName === tag);
/** Intl puts a no-break space between number and unit; a test reads the words. */
const plain = (/** @type {string} */ text) => text.replace(/[  ]/g, ' ');

/** The rows of the section as label -> { value, className of the value }. */
function rowsOf(/** @type {any} */ host) {
  /** @type {Map<string, { value: string, valueClass: string }>} */
  const rows = new Map();
  for (const row of byClass(host, 'settings-info-row')) {
    const [label] = byClass(row, 'settings-info-label');
    const [value] = byClass(row, 'settings-info-value');
    rows.set(label.textContent, { value: plain(value.textContent), valueClass: value.className });
  }
  return rows;
}

/**
 * The sheet as the shell hands it over: the markup arrives as a string, and
 * the nodes the sheet asks for by id are live elements. A selector whose id is
 * not in the markup answers null, as a real container would.
 */
function createContainer() {
  /** @type {Map<string, LiveElement>} */
  const nodes = new Map();
  let markup = '';
  return {
    get markup() { return markup; },
    replaceChildren() { markup = ''; nodes.clear(); },
    insertAdjacentHTML(/** @type {string} */ _position, /** @type {string} */ html) { markup += html; },
    querySelector(/** @type {string} */ selector) {
      const id = /^#([\w-]+)$/.exec(selector)?.[1];
      if (!id || !markup.includes(`id="${id}"`)) return null;
      if (!nodes.has(id)) nodes.set(id, new LiveElement('div'));
      return nodes.get(id);
    },
    host() { return this.querySelector('#system-diagnostics-host'); },
  };
}

const DIAGNOSTICS = {
  version: '2.89.1',
  build_revision: 'rev-abc123',
  node: 'v24.11.0',
  platform: 'linux',
  arch: 'arm64',
  sqlite: { version: '3.50.4', encrypted: true },
  schema_version: 131,
  last_migration_at: '2026-11-10T08:12:44Z',
  database_bytes: 5033165,
  wal_bytes: 0,
  data_dir_free_bytes: 55834574848,
  uptime_seconds: 86400,
  backup: {
    last_attempt: '2026-11-12T02:00:00.000Z',
    last_success: '2026-11-11T02:00:00.000Z',
    reason: 'disk_full',
    next_run: '2026-11-13T02:00:00.000Z',
    local: true,
    webdav: false,
  },
  key_source: 'stored',
  ready: { status: 'ready' },
  modules_installed: 3,
};

const REPORT = [
  'Yuvomi diagnostics',
  'version: 2.89.1',
  'build_revision: rev-abc123',
  'node: v24.11.0',
  'platform: linux',
  'arch: arm64',
  'sqlite.version: 3.50.4',
  'sqlite.encrypted: true',
  'schema_version: 131',
  'last_migration_at: 2026-11-10T08:12:44Z',
  'database_bytes: 5033165',
  'wal_bytes: 0',
  'data_dir_free_bytes: 55834574848',
  'uptime_seconds: 86400',
  'backup.last_attempt: 2026-11-12T02:00:00.000Z',
  'backup.last_success: 2026-11-11T02:00:00.000Z',
  'backup.reason: disk_full',
  'backup.next_run: 2026-11-13T02:00:00.000Z',
  'backup.local: true',
  'backup.webdav: false',
  'key_source: stored',
  'ready: ready',
  'modules_installed: 3',
].join('\n');

const NOW = Date.parse('2026-11-12T10:00:00.000Z');

/** @type {{ message: string, tone: string }[]} */
let toasts = [];
/** @type {string[]} */
let requested = [];

/**
 * @param {{ diagnostics?: object | Error, navigator?: object, execCommand?: (command: string) => boolean }} [world]
 */
async function renderSheet({ diagnostics = DIAGNOSTICS, navigator = {}, execCommand = () => false } = {}) {
  toasts = [];
  requested = [];
  /** @type {any} */ (globalThis).__apiStub = {
    get: async (/** @type {string} */ path) => {
      requested.push(path);
      if (path === '/version') return { version: '2.89.1', setup_required: false };
      if (path === '/system/diagnostics') {
        const answer = /** @type {any} */ (globalThis).__diagnosticsAnswer;
        if (answer instanceof Error) throw answer;
        return { data: answer };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  /** @type {any} */ (globalThis).__diagnosticsAnswer = diagnostics;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, ...navigator }, configurable: true, writable: true });
  /** @type {any} */ (globalThis.document).execCommand = execCommand;
  /** @type {any} */ (globalThis).window = {
    addEventListener() {},
    dispatchEvent() {},
    yuvomi: { showToast: (/** @type {string} */ message, /** @type {string} */ tone) => { toasts.push({ message, tone }); } },
  };
  const { render } = await import('../public/settings/pages/admin-system.js');
  const container = createContainer();
  await render(container, { user: { role: 'admin' } });
  return container;
}

const copyButton = (/** @type {any} */ host) => byTag(host, 'button').find((el) => el.textContent.includes('settings.diagnosticsCopy'));

test.beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: NOW }); });
test.afterEach(() => { mock.timers.reset(); });

test('every field of the answer is a row, in four groups', async () => {
  const container = await renderSheet();
  const host = container.host();
  assert.ok(host, 'the sheet carries a place for the diagnostics');
  assert.ok(requested.includes('/system/diagnostics'), 'the sheet asks the diagnostics endpoint');

  assert.deepEqual(byTag(host, 'h3').map((el) => el.textContent), [
    'settings.diagnosticsGroupApp',
    'settings.diagnosticsGroupServer',
    'settings.diagnosticsGroupDatabase',
    'settings.diagnosticsGroupBackup',
  ]);

  const rows = rowsOf(host);
  const value = (/** @type {string} */ label) => rows.get(label)?.value;
  assert.equal(value('settings.systemVersionLabel'), 'settings.systemVersionValue{"version":"2.89.1"}');
  assert.equal(value('settings.diagnosticsBuild'), 'rev-abc123');
  assert.equal(value('settings.diagnosticsReady'), 'settings.diagnosticsReadyYes');
  // Uptime as the moment the server started: now minus 86400 seconds.
  assert.match(value('settings.diagnosticsRunningSince') ?? '', /2026-11-11T10:00:00\.000Z/);
  assert.equal(value('settings.diagnosticsModules'), '3');

  assert.equal(value('Node.js'), 'v24.11.0');
  assert.equal(value('settings.diagnosticsPlatform'), 'linux (arm64)');
  assert.equal(value('SQLite'), '3.50.4');

  assert.equal(value('settings.diagnosticsSchemaVersion'), '131');
  assert.match(value('settings.diagnosticsLastMigration') ?? '', /2026-11-10T08:12:44Z/);
  assert.equal(value('settings.diagnosticsDatabaseSize'), '4,8 MB');
  assert.equal(value('settings.diagnosticsWalSize'), '0 kB');
  assert.equal(value('settings.diagnosticsFreeSpace'), '52 GB');
  assert.equal(value('settings.diagnosticsEncryption'), 'settings.diagnosticsEnabled');
  assert.equal(value('settings.diagnosticsKeySource'), 'settings.diagnosticsKeySourceStored');

  assert.equal(value('settings.diagnosticsBackupLocal'), 'settings.diagnosticsEnabled');
  assert.equal(value('settings.diagnosticsBackupWebdav'), 'settings.diagnosticsDisabled');
  assert.match(value('settings.diagnosticsBackupLastAttempt') ?? '', /2026-11-12T02:00:00\.000Z/);
  assert.match(value('settings.diagnosticsBackupLastSuccess') ?? '', /2026-11-11T02:00:00\.000Z/);
  assert.equal(value('settings.diagnosticsBackupLastError'), 'settings.diagnosticsBackupReasonDiskFull');
  assert.match(rows.get('settings.diagnosticsBackupLastError')?.valueClass ?? '', /settings-info-value--danger/);
  assert.match(value('settings.diagnosticsBackupNextRun') ?? '', /2026-11-13T02:00:00\.000Z/);

  assert.equal(rows.size, 21, 'one row per field, platform and architecture share one');
});

test('the button puts the report on the clipboard and says so', async () => {
  /** @type {string[]} */
  const written = [];
  const container = await renderSheet({
    navigator: { clipboard: { writeText: async (/** @type {string} */ text) => { written.push(text); } } },
    execCommand: () => { throw new Error('not needed with a clipboard'); },
  });
  const host = container.host();
  const button = copyButton(host);
  assert.ok(button, 'the section has a copy button');
  assert.equal(button.type, 'button');

  await button.handlers.click();

  assert.deepEqual(written, [REPORT], 'field names and raw values, the same in every language');
  assert.deepEqual(toasts, [{ message: 'settings.diagnosticsCopied', tone: 'success' }]);
  const [field] = byTag(host, 'textarea');
  assert.equal(field.hidden, true, 'the text field stays away while the clipboard works');
});

test('without a clipboard the report stands marked in a field, and nothing claims "copied"', async () => {
  // http in the home network: no Clipboard API, and the selection way fails too.
  const container = await renderSheet({ navigator: {}, execCommand: () => false });
  const host = container.host();
  const [field] = byTag(host, 'textarea');
  assert.equal(field.hidden, true, 'precondition: the field is hidden before the click');

  await copyButton(host).handlers.click();

  assert.deepEqual(toasts, [], 'no "copied" when nothing was copied, and no second message beside the field');
  assert.equal(field.hidden, false);
  assert.equal(field.value, REPORT);
  assert.equal(field.selected, true, 'marked, so that it can be copied by hand');
  assert.equal(field.focused, true);
  assert.equal(field.getAttribute('aria-label'), 'settings.diagnosticsTextLabel');
  // `id` is a property on a real element; the mini DOM keeps it where it was put.
  const idOf = (/** @type {any} */ el) => el.id ?? el.getAttribute('id');
  assert.ok(field.getAttribute('aria-describedby'), 'precondition: the field names its description');
  const hint = [...elements(host)].find((el) => idOf(el) === field.getAttribute('aria-describedby'));
  assert.equal(hint?.textContent, 'settings.diagnosticsCopyFailed', 'the field is described by the sentence that says what to do');
  assert.equal(hint?.hidden, false);
});

test('without a clipboard the selection way still copies', async () => {
  /** @type {string[]} */
  const commands = [];
  const container = await renderSheet({ navigator: {}, execCommand: (command) => { commands.push(command); return true; } });
  const host = container.host();

  await copyButton(host).handlers.click();

  assert.deepEqual(commands, ['copy']);
  assert.deepEqual(toasts, [{ message: 'settings.diagnosticsCopied', tone: 'success' }]);
  const [field] = byTag(host, 'textarea');
  assert.equal(field.value, REPORT, 'what was marked for the copy is the report');
  assert.equal(field.hidden, true, 'and the field leaves again after a copy that worked');
});

test('a failed request shows one sentence and a retry, no rows and no copy button', async () => {
  const container = await renderSheet({ diagnostics: Object.assign(new Error('boom'), { status: 500 }) });
  const host = container.host();

  assert.equal(rowsOf(host).size, 0, 'no empty rows');
  assert.equal(copyButton(host), undefined, 'nothing to copy');
  const alerts = [...elements(host)].filter((el) => el.getAttribute('role') === 'alert');
  assert.deepEqual(alerts.map((el) => el.textContent), ['common.errorServer']);
  const [retry] = byTag(host, 'button');
  assert.equal(retry.textContent, 'settings.retry');
  // The version card above is its own request and does not go down with it.
  assert.equal(rowsOf(container.querySelector('#system-info-host')).get('settings.systemVersionLabel')?.value,
    'settings.systemVersionValue{"version":"2.89.1"}');

  /** @type {any} */ (globalThis).__diagnosticsAnswer = DIAGNOSTICS;
  await retry.handlers.click();
  assert.equal(rowsOf(host).get('settings.diagnosticsSchemaVersion')?.value, '131', 'the retry brings the rows');
  assert.ok(copyButton(host));
});

test('a value the server could not read is "unknown", never "not yet"', async () => {
  // What the endpoint answers when the backup status cannot be read and the
  // installation is unencrypted, built by hand and not ready.
  const container = await renderSheet({
    diagnostics: {
      ...DIAGNOSTICS,
      build_revision: null,
      sqlite: { version: null, encrypted: false },
      last_migration_at: null,
      database_bytes: null,
      wal_bytes: null,
      data_dir_free_bytes: null,
      backup: { last_attempt: null, last_success: null, reason: null, next_run: null, local: null, webdav: null },
      key_source: null,
      ready: { status: 'not_ready', reason: 'data_dir_not_writable' },
      modules_installed: null,
    },
    navigator: { clipboard: { writeText: async (/** @type {string} */ text) => { /** @type {any} */ (globalThis).__written = text; } } },
  });
  const host = container.host();
  const rows = rowsOf(host);
  const value = (/** @type {string} */ label) => rows.get(label)?.value;

  assert.equal(rows.has('settings.diagnosticsBuild'), false, 'no build row without a revision');
  assert.equal(rows.has('settings.diagnosticsKeySource'), false, 'no key source without encryption');
  assert.equal(rows.has('settings.diagnosticsBackupLastError'), false, 'no error row without a reason');
  assert.equal(value('settings.diagnosticsEncryption'), 'settings.diagnosticsDisabled');
  assert.equal(value('settings.diagnosticsReady'), 'settings.diagnosticsNotReadyDataDir');
  assert.match(rows.get('settings.diagnosticsReady')?.valueClass ?? '', /settings-info-value--danger/);
  for (const label of [
    'SQLite', 'settings.diagnosticsLastMigration', 'settings.diagnosticsDatabaseSize', 'settings.diagnosticsWalSize',
    'settings.diagnosticsFreeSpace', 'settings.diagnosticsModules', 'settings.diagnosticsBackupLocal',
    'settings.diagnosticsBackupWebdav', 'settings.diagnosticsBackupLastAttempt', 'settings.diagnosticsBackupLastSuccess',
    'settings.diagnosticsBackupNextRun',
  ]) {
    assert.equal(value(label), 'settings.diagnosticsUnknown', label);
  }

  await copyButton(host).handlers.click();
  const report = String(/** @type {any} */ (globalThis).__written);
  assert.match(report, /^build_revision: null$/m);
  assert.match(report, /^backup\.local: null$/m);
  assert.match(report, /^ready: not_ready \(data_dir_not_writable\)$/m);
  assert.equal(report.split('\n').length, REPORT.split('\n').length, 'the report keeps its lines, whatever is missing');
});

test('a backup that is on but has not run yet says so', async () => {
  const container = await renderSheet({
    diagnostics: {
      ...DIAGNOSTICS,
      backup: { last_attempt: null, last_success: null, reason: null, next_run: null, local: true, webdav: false },
    },
  });
  const rows = rowsOf(container.host());
  assert.equal(rows.get('settings.diagnosticsBackupLastAttempt')?.value, 'settings.diagnosticsNever');
  assert.equal(rows.get('settings.diagnosticsBackupLastSuccess')?.value, 'settings.diagnosticsNever');
  assert.equal(rows.get('settings.diagnosticsBackupNextRun')?.value, 'settings.diagnosticsNotScheduled');
});
