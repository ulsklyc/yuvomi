/**
 * Test: Extension module permissions
 * Run: node --experimental-sqlite --test test/test-extension-permissions.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-ext-perms-'));
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR;

function writeModule(folder, manifest, files = {}) {
  const dir = path.join(MODULES_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

writeModule('demo-ext', {
  id: 'demo-ext',
  name: 'Demo Extension',
  entry: 'index.js',
  capabilities: {
    permissions: {
      module: { label: 'Demo Extension', icon: 'box' },
      widgets: [{ id: 'summary', label: 'Summary' }],
    },
    widgets: [{
      id: 'summary',
      entry: 'widgets/summary.js',
      label: 'Summary widget',
      defaultSize: '1x2',
    }],
    api: { prefix: '/api/extensions/demo-ext' },
  },
}, {
  'index.js': 'export async function render() {}\n',
  'widgets/summary.js': 'export async function renderWidget() {}\n',
});

writeModule('taskextras', {
  id: 'taskextras',
  name: 'Task Extras',
  entry: 'index.js',
  capabilities: {
    permissions: { module: { label: 'Task Extras', icon: 'box' } },
    api: { prefix: '/api/tasks' },
  },
}, { 'index.js': 'export async function render() {}\n' });

const dbmod = await import('../server/db.js');
const svc = await import('../server/services/modules.js');
const {
  resolvePermissions,
  permissionCatalog,
  normalizePermissionInput,
  replaceSubjectPermissions,
  setExtensionPermissionCatalog,
  buildSessionModuleAccess,
  moduleAccessVerdict,
} = await import('../server/permissions.js');
const { extensionPermissionKey, normalizeCapabilities } = await import('../server/services/module-capabilities.js');
const { moduleForPath, setExtensionScopeModules } = await import('../server/scopes.js');

const db = dbmod.get();

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

test('listModules exposes extension capabilities and catalog merge', async () => {
  const mods = await svc.listModules({ admin: false });
  assert.equal(mods.length, 1);
  assert.equal(mods[0].capabilities.permissionModuleKey, 'ext:demo-ext');
  assert.equal(mods[0].capabilities.widgets[0].id, 'demo-ext:summary');

  const catalog = permissionCatalog();
  assert.ok(catalog.modules.some((m) => m.key === 'ext:demo-ext'));
  assert.ok(catalog.widgets.some((w) => w.id === 'demo-ext:summary'));
  assert.ok(catalog.scopeModuleKeys.includes('ext:demo-ext'));
});

test('resolvePermissions includes extension keys and widget inherit', async () => {
  const user = { id: 2, role: 'member', family_role: 'child' };
  replaceSubjectPermissions(db, 'user', user.id, {
    modules: { 'ext:demo-ext': 'none' },
    widgets: {},
  });

  const resolved = resolvePermissions(db, user);
  assert.equal(resolved.modules['ext:demo-ext'], 'none');
  assert.equal(resolved.widgets['demo-ext:summary'], 'none');
});

test('normalizePermissionInput accepts extension widget id', async () => {
  await svc.listModules({ admin: true });
  const rows = normalizePermissionInput({
    modules: { 'ext:demo-ext': 'read' },
    widgets: { 'demo-ext:summary': 'none' },
  });
  assert.ok(rows.some((r) => r.resource_key === 'ext:demo-ext'));
  assert.ok(rows.some((r) => r.resource_key === 'demo-ext:summary'));
});

test('extensionPermissionKey helper', () => {
  assert.equal(extensionPermissionKey('demo-ext'), 'ext:demo-ext');
});

const capsStubs = {
  publicUrl: () => '',
  pathExists: async () => true,
  isSafeRelativeFile: () => true,
};

function capsRaw(prefix) {
  return {
    name: 'Task Extras',
    capabilities: {
      permissions: { module: { label: 'Task Extras', icon: 'box' } },
      api: { prefix },
    },
  };
}

test('normalizeCapabilities rejects a prefix that collides with a core module', async () => {
  await assert.rejects(
    () => normalizeCapabilities(capsRaw('/api/tasks'), 'taskextras', '/tmp/mod', capsStubs.publicUrl, capsStubs.pathExists, capsStubs.isSafeRelativeFile),
    /must be \/api\/extensions\/taskextras/,
  );
});

test('normalizeCapabilities rejects a prefix anchored to a different module id', async () => {
  await assert.rejects(
    () => normalizeCapabilities(capsRaw('/api/extensions/other-id'), 'taskextras', '/tmp/mod', capsStubs.publicUrl, capsStubs.pathExists, capsStubs.isSafeRelativeFile),
    /must be \/api\/extensions\/taskextras/,
  );
});

test('normalizeCapabilities accepts /api/extensions/{moduleId} with a trailing slash', async () => {
  const caps = await normalizeCapabilities(
    capsRaw('/api/extensions/taskextras/'),
    'taskextras',
    '/tmp/mod',
    capsStubs.publicUrl,
    capsStubs.pathExists,
    capsStubs.isSafeRelativeFile,
  );
  assert.equal(caps.apiPrefix, '/api/extensions/taskextras');
  assert.equal(caps.scopeKey, 'ext:taskextras');
});

test('stored ext permission rows are dropped while the catalog is empty (deny-list fail-open)', async () => {
  const user = { id: 99, role: 'member', family_role: 'child' };
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, ?, ?, ?)
  `).run('user', String(user.id), 'module', 'ext:demo-ext', 'none');

  setExtensionPermissionCatalog({ permissionModules: [], permissionWidgets: [] });
  setExtensionScopeModules([]);

  const emptyResolved = resolvePermissions(db, user);
  assert.equal(emptyResolved.modules['ext:demo-ext'], undefined);
  const emptyMap = buildSessionModuleAccess(emptyResolved);
  assert.equal(moduleAccessVerdict(emptyMap, 'ext:demo-ext', 'write'), 'allow');

  await svc.listModules({ admin: true });
  const loaded = resolvePermissions(db, user);
  assert.equal(loaded.modules['ext:demo-ext'], 'none');
  const loadedMap = buildSessionModuleAccess(loaded);
  assert.equal(moduleAccessVerdict(loadedMap, 'ext:demo-ext', 'write'), 'none');
});

test('listModules is awaited before app.listen so the catalog is populated at accept', () => {
  const raw = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const bootAt = raw.indexOf('// Server starten');
  assert.ok(bootAt >= 0, 'boot section marker is present');
  // Line comments only: withoutBlockComments treats the `*/*` in `Accept: */*`
  // as a comment opener and swallows app.listen with it.
  const src = raw.slice(bootAt).replace(/^\s*\/\/.*$/gm, '');
  const listenIdx = src.indexOf('app.listen(');
  assert.ok(listenIdx >= 0, 'app.listen is present');
  const awaitIdx = src.lastIndexOf('await listModules', listenIdx);
  assert.ok(awaitIdx >= 0 && awaitIdx < listenIdx, 'await listModules must precede app.listen');
  assert.doesNotMatch(src, /listModules\s*\([^)]*\)\s*\.catch/);
});

test('a colliding api.prefix never reaches PREFIX_TO_MODULE', async () => {
  const mods = await svc.listModules({ admin: true });
  const colliding = mods.find((m) => m.id === 'taskextras');
  assert.ok(colliding, 'taskextras is listed for admin');
  assert.equal(colliding.status, 'error');
  assert.match(colliding.error, /must be \/api\/extensions\/taskextras/);

  const catalog = permissionCatalog();
  assert.ok(!catalog.scopeModuleKeys.includes('ext:taskextras'));
  assert.equal(moduleForPath('/tasks/5'), 'tasks');
});

// ---------------------------------------------------------------------------
// #1009: der Gruppenschluessel der Rechtematrix
//
// Gemeldet als Serverfehler ("Unknown module: ext"), und der Server hatte
// recht: moduleKeySet() mischt die Extension-Module ein, die Menge KENNT den
// Schluessel. Abgeschnitten wurde er in der Oberflaeche, weil
// `const [type, key] = String(group).split(':')` bei `module:ext:<id>` nach
// zwei Feldern aufhoert. Die Regel steht jetzt in einer eigenen Datei; hier
// wird sie geprueft, und darunter, dass die Aufrufstelle sie auch benutzt.
// ---------------------------------------------------------------------------

test('parsePermissionGroup trennt am ersten Doppelpunkt, nicht an allen (#1009)', async () => {
  const { parsePermissionGroup } = await import('../public/utils/permission-group.js');

  // Kernmodule und Kern-Widgets: ein Paar, unveraendertes Verhalten.
  assert.deepEqual(parsePermissionGroup('module:tasks'), { type: 'module', key: 'tasks' });
  assert.deepEqual(parsePermissionGroup('widget:countdown'), { type: 'widget', key: 'countdown' });

  // DER GEMELDETE FALL. Der Schluessel eines Fremdmoduls ist `ext:<modulId>`
  // (extensionPermissionKey), das Markup schreibt `module:${key}`.
  assert.deepEqual(
    parsePermissionGroup('module:ext:mein-modul'),
    { type: 'module', key: 'ext:mein-modul' },
    'der Schluessel eines Fremdmoduls behaelt sein ext:-Praefix',
  );

  // Dieselbe Falle eine Ebene tiefer: eine Fremd-Widget-Id ist
  // `<modulId>:<widgetId>`, der Gruppenschluessel also dreiteilig.
  assert.deepEqual(
    parsePermissionGroup('widget:mein-modul:kachel'),
    { type: 'widget', key: 'mein-modul:kachel' },
    'die Widget-Id bleibt vollstaendig',
  );

  // Modul-Ids duerfen Bindestriche und Ziffern tragen; mehr als drei
  // Komponenten sind damit nicht ausgeschlossen.
  assert.deepEqual(
    parsePermissionGroup('widget:a:b:c'),
    { type: 'widget', key: 'a:b:c' },
    'nur der erste Doppelpunkt trennt - alles danach gehoert dem Schluessel',
  );

  // Kein Doppelpunkt und leerer Rest liefern einen leeren Schluessel, damit der
  // Aufrufer abbrechen kann. Vorher stand hier `undefined` und landete als
  // Objektschluessel im Entwurf.
  assert.deepEqual(parsePermissionGroup('module'), { type: 'module', key: '' });
  assert.deepEqual(parsePermissionGroup('module:'), { type: 'module', key: '' });
  assert.deepEqual(parsePermissionGroup(''), { type: '', key: '' });
  assert.deepEqual(parsePermissionGroup(null), { type: '', key: '' });
});

test('die Rechtematrix zerlegt dataset.group nicht mehr selbst (#1009)', () => {
  const src = fs.readFileSync(
    new URL('../public/settings/pages/admin-permissions.js', import.meta.url),
    'utf8',
  );

  // Die Gegenprobe zur Zeile oben: der Helfer kann richtig sein und die Seite
  // ihn trotzdem nicht benutzen. Geprueft wird deshalb die Aufrufstelle selbst.
  assert.doesNotMatch(
    src,
    /dataset\.group\s*\)?\s*\.split\s*\(/,
    'dataset.group darf nicht mehr per split zerlegt werden - das schneidet ext:<id> ab',
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bparsePermissionGroup\b[^}]*\}\s*from\s*'\/utils\/permission-group\.js'/,
    'die Seite muss den gemeinsamen Helfer importieren',
  );
  assert.match(
    src,
    // R24 (E11): die Stufe ist eine Auswahl je Zeile (`select`), vorher ein Segment (`opt`).
    /parsePermissionGroup\s*\(\s*select\.dataset\.group\s*\)/,
    'und ihn auf dataset.group anwenden',
  );

  // Die Widget-Id-Zerlegung an anderer Stelle ist KORREKT und bleibt: dort ist
  // die erste Komponente gesucht (die Modul-Id), nicht die letzte.
  assert.match(src, /id\.split\(':'\)\[0\]/, 'widgetLabel darf weiterhin die Modul-Id abschneiden');
});
