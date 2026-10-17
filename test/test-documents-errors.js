/**
 * Tests: die Fehler der Dokumente (#1909)
 * Module: server/routes/documents.js, server/routes/dms.js (link, push),
 *         public/pages/documents.js, public/utils/document-folder-delete.js
 *
 * Der Server nennt den Fall (`reason`), die Seite sagt den Satz der App - nie
 * den des Servers. Sagt der Grund, dass es das Ziel der Handlung nicht mehr
 * gibt (ein anderes Haushaltsmitglied hat den Ordner oder das Dokument
 * geloescht), holt die Seite Ordner und Dokumente selbst neu; ein offener
 * Dialog geht zu. Fehlt nur der im Dialog GEWAEHLTE Ordner, bleibt der Dialog
 * offen und bietet die aktuellen Ordner an.
 *
 * LOESCHEN AUF "GIBT ES NICHT MEHR" IST HIER KEIN ERFOLG. Die 404 eines
 * Dokuments heisst geloescht ODER fuer dich nicht mehr sichtbar (die
 * Sichtbarkeit wurde geaendert, die Zeile steht noch) - wie in der Gesundheit
 * zeigt die Seite den Satz und laedt nach, statt "geloescht" zu behaupten.
 *
 * Gefahren wird auf beiden Seiten der ECHTE Code:
 * - Server: die echten Router (documents, dms) ueber einer migrierten
 *   In-Memory-DB, das DMS ueber `_setAdapterFactory`.
 * - Seite: die echten Handler bis in ihr catch, ueber den api-Stub des Loaders
 *   (`__apiStub`), den Modal-Stub (`__openModal`, `__closeModal`), die
 *   Auswahl- und Eingabe-Stubs (`__selectModal`, `__promptModal`) und den
 *   Ruecknahme-Stub (`__undoStub`).
 *
 * Ausfuehren: npm run test:documents-errors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'documents-errors-test-secret';
const { tempDir } = await import('./tmp-dir.js');
const storageRoot = tempDir('yuvomi-documents-errors-');
process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;

globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
const toasts = [];
globalThis.window.yuvomi = { ...globalThis.window.yuvomi, showToast: (text, kind) => { toasts.push([text, kind]); } };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter, _setStageUploadForTest } = await import('../server/routes/documents.js');
const { stageDocumentUpload } = await import('../server/services/document-storage.js');
const { default: dmsRouter, _setAdapterFactory } = await import('../server/routes/dms.js');
const { __test: page } = await import('../public/pages/documents.js');
const { CASE_MESSAGES, CASE_PARAMS, GONE_REASONS } = await import('../public/utils/friendly-error.js');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const moduleDb = get();
const db = buildTestDb();
_setTestDatabase(db);
moduleDb.close();
test.after(() => db.close());
const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ada', 'Ada', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/documents/dms', dmsRouter);
app.use('/api/v1/documents', documentsRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}/api/v1/documents`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const GONE = 999999;
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`;
const upload = (extra = {}) => ({ name: 'Scan', original_name: 'scan.pdf', content_data: PDF, ...extra });

async function folder(name, parent_id = null) {
  const r = await call('POST', '/folders', { name, parent_id });
  assert.equal(r.status, 201, `Ordner ${name}: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}

async function documentRow(extra = {}) {
  const r = await call('POST', '', upload(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

const SERVER_GONE = [
  ['GET', `/folders/${GONE}/delete-impact`, null, 'documents_folder_not_found', 'Folder not found.'],
  ['PUT', `/folders/${GONE}`, { name: 'x' }, 'documents_folder_not_found', 'Folder not found.'],
  ['DELETE', `/folders/${GONE}`, null, 'documents_folder_not_found', 'Folder not found.'],
  ['PUT', `/${GONE}`, { name: 'x' }, 'documents_document_not_found', 'Document not found.'],
  ['PATCH', `/${GONE}/archive`, { archived: true }, 'documents_document_not_found', 'Document not found.'],
  ['DELETE', `/${GONE}`, null, 'documents_document_not_found', 'Document not found.'],
];

for (const [method, path, body, reason, error] of SERVER_GONE) {
  test(`Server: ${method} ${path.replace(String(GONE), ':id')} auf etwas, das es nicht mehr gibt, nennt ${reason}`, async () => {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [404, reason, error]);
  });
}

test('Server: ein Ordner unter einem inzwischen geloeschten Ordner - anlegen und verschieben nennen den gewaehlten Ordner, Status 400 wie bisher', async () => {
  const id = await folder('Verschieben-Quelle');
  for (const [method, path] of [['POST', '/folders'], ['PUT', `/folders/${id}`]]) {
    const r = await call(method, path, { name: 'Unterordner', parent_id: GONE });
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [400, 'documents_selected_folder_not_found', 'Parent folder not found.'], `${method} ${path}`);
  }
});

test('Server: ein Dokument in einen inzwischen geloeschten Ordner - hochladen und aendern antworten 400 mit dem Fall statt 500', async () => {
  const id = await documentRow();
  for (const [method, path, body] of [['POST', '', upload({ folder_id: GONE })], ['PUT', `/${id}`, { folder_id: GONE }]]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [400, 'documents_selected_folder_not_found', 'Folder not found.'], `${method} ${path}`);
  }
});

test('Server: der Zielordner verschwindet WAEHREND des Hochladens - 400 mit dem Fall statt 500, und die abgelegte Datei wird weggeraeumt', async () => {
  // Zwischen der Pruefung und dem Einfuegen liegt das Ablegen der Datei, ein
  // await: dort kommt ein anderes Loeschen dazwischen (Review zu #1994).
  // Gefahren mit der Ordner-Ablage, damit die abgelegte Datei sichtbar ist.
  const { readdirSync } = await import('node:fs');
  const target = await folder('Verschwindet beim Hochladen');
  const files = () => readdirSync(storageRoot, { recursive: true }).filter((name) => String(name).endsWith('.pdf'));
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  const before = files().length;
  _setStageUploadForTest(async (args) => {
    const staged = await stageDocumentUpload(args);
    db.prepare('DELETE FROM family_document_folders WHERE id = ?').run(target);
    return staged;
  });
  try {
    const r = await call('POST', '', upload({ folder_id: target }));
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [400, 'documents_selected_folder_not_found', 'Folder not found.'], JSON.stringify(r.body));
    assert.equal(files().length, before, 'die schon abgelegte Datei bleibt nicht liegen');
  } finally {
    _setStageUploadForTest(null);
    delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  }
});

test('Server: ein Name, den es unter den Geschwistern schon gibt - anlegen, umbenennen und verschieben nennen den Fall', async () => {
  const parent = await folder('Eltern');
  await folder('Doppelt', parent);
  const other = await folder('Anders', parent);
  const wanderer = await folder('Doppelt');
  for (const [method, path, body] of [
    ['POST', '/folders', { name: 'Doppelt', parent_id: parent }],
    ['PUT', `/folders/${other}`, { name: 'Doppelt' }],
    ['PUT', `/folders/${wanderer}`, { parent_id: parent }],
  ]) {
    const r = await call(method, path, body);
    assert.deepEqual([r.status, r.body?.reason, r.body?.error], [409, 'documents_folder_exists', 'A folder with this name already exists here.'], `${method} ${path}`);
  }
});

test('Server: zu tief verschachtelt - anlegen und verschieben tragen den Fall und die Grenze als Zahl', async () => {
  let parent = null;
  for (let level = 1; level <= 5; level += 1) parent = await folder(`Ebene ${level}`, parent);
  const r = await call('POST', '/folders', { name: 'Ebene 6', parent_id: parent });
  assert.deepEqual([r.status, r.body?.reason, r.body?.params], [400, 'documents_folder_too_deep', { limit: 5 }]);
  const loose = await folder('Lose');
  const moved = await call('PUT', `/folders/${loose}`, { parent_id: parent });
  assert.deepEqual([moved.status, moved.body?.reason, moved.body?.params], [400, 'documents_folder_too_deep', { limit: 5 }]);
});

test('Server: was eine gewaehlte Datei am Hochladen scheitern laesst, traegt seinen Fall', async () => {
  for (const [content_data, reason] of [
    ['data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA', 'documents_file_type_not_allowed'],
    [`data:application/pdf;base64,${Buffer.from('kein pdf').toString('base64')}`, 'documents_file_content_mismatch'],
    // Eine leere Datei liest der Browser als `data:<typ>;base64,` ohne Inhalt.
    ['data:application/pdf;base64,', 'documents_file_empty'],
  ]) {
    const r = await call('POST', '', upload({ content_data }));
    assert.deepEqual([r.status, r.body?.reason], [400, reason], content_data.slice(0, 40));
  }
});

test('Server: ein Speicher, der nicht schreiben kann, nennt den Fall (502 wie bisher)', async () => {
  // Die Ablage im Ordner ist an, der Ordner aber eine DATEI: das Schreiben
  // scheitert wie an einem schreibgeschuetzten oder fehlenden Mount.
  const blocker = join(storageRoot, 'kein-verzeichnis');
  writeFileSync(blocker, 'x');
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = blocker;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  try {
    const r = await call('POST', '', upload());
    assert.deepEqual([r.status, r.body?.reason], [502, 'documents_storage_failed'], JSON.stringify(r.body));
  } finally {
    process.env.DOCUMENT_STORAGE_LOCAL_PATH = storageRoot;
    delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  }
});

test('Server: DMS verknuepfen und senden nennen ihre Faelle', async () => {
  const account = db.prepare(`INSERT INTO dms_accounts (provider, name, base_url, api_token)
    VALUES ('paperless', 'Paperless', 'https://dms.test', 'token')`).run().lastInsertRowid;
  let behaviour = 'ok';
  _setAdapterFactory(() => ({
    async getDocument(id) {
      if (behaviour === 'gone') throw Object.assign(new Error('nope'), { status: 404 });
      if (behaviour === 'down') throw new Error('ECONNREFUSED');
      return { title: `DMS ${id}`, filename: 'a.pdf', url: 'https://dms.test/a' };
    },
    async upload() {
      if (behaviour === 'down') throw new Error('ECONNREFUSED');
      return { taskId: 't' };
    },
  }));
  try {
    const expectReason = async (path, body, status, reason, label) => {
      const r = await call('POST', path, body);
      assert.deepEqual([r.status, r.body?.reason], [status, reason], `${label}: ${JSON.stringify(r.body)}`);
    };
    await expectReason('/dms/link', { account_id: GONE, dms_document_id: '1' }, 404, 'dms_account_not_found', 'link, Konto weg');
    await expectReason('/dms/push', { account_id: GONE, document_id: 1 }, 404, 'dms_account_not_found', 'push, Konto weg');
    assert.equal((await call('POST', '/dms/link', { account_id: account, dms_document_id: '7' })).status, 201);
    await expectReason('/dms/link', { account_id: account, dms_document_id: '7' }, 409, 'dms_document_already_linked', 'link doppelt');
    behaviour = 'gone';
    await expectReason('/dms/link', { account_id: account, dms_document_id: '8' }, 404, 'dms_document_not_found', 'link, im DMS geloescht');
    behaviour = 'down';
    await expectReason('/dms/link', { account_id: account, dms_document_id: '9' }, 502, 'dms_unreachable', 'link, DMS weg');
    const local = await documentRow({ name: 'Lokal' });
    await expectReason('/dms/push', { account_id: account, document_id: local }, 502, 'dms_unreachable', 'push, DMS weg');
    behaviour = 'ok';
    await expectReason('/dms/push', { account_id: account, document_id: GONE }, 404, 'documents_document_not_found', 'push, Dokument weg');
    const linked = db.prepare("SELECT id FROM family_documents WHERE storage_backend = 'dms'").get().id;
    await expectReason('/dms/push', { account_id: account, document_id: linked }, 400, 'dms_document_already_stored', 'push, schon im DMS');
  } finally {
    _setAdapterFactory(null);
  }
});

test('Server: DMS verknuepfen - was NACH der Antwort des DMS lokal scheitert, ist kein "DMS nicht erreichbar"', async () => {
  // Codex an #1994: das catch der Route deckte auch das lokale Einfuegen.
  const account = db.prepare(`INSERT INTO dms_accounts (provider, name, base_url, api_token)
    VALUES ('paperless', 'Lokal', 'https://dms-local.test', 'token')`).run().lastInsertRowid;
  let during = null;
  _setAdapterFactory(() => ({
    async getDocument(id) {
      during?.();
      // Ohne Titel scheitert das Einfuegen an NOT NULL - ein lokaler Fehler.
      return { title: id === 'ohne-titel' ? null : `DMS ${id}`, filename: 'a.pdf', url: 'https://dms-local.test/a' };
    },
  }));
  try {
    let r = await call('POST', '/dms/link', { account_id: account, dms_document_id: 'ohne-titel' });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body?.reason, undefined, 'kein Grund, der dem DMS die Schuld gibt');
    // Das Konto verschwindet, waehrend das DMS antwortet.
    during = () => db.prepare('DELETE FROM dms_accounts WHERE id = ?').run(account);
    r = await call('POST', '/dms/link', { account_id: account, dms_document_id: '1' });
    assert.deepEqual([r.status, r.body?.reason], [404, 'dms_account_not_found'], JSON.stringify(r.body));
  } finally {
    _setAdapterFactory(null);
  }
});

const SERVER_REASONS = [
  ...new Set(SERVER_GONE.map((c) => c[3])),
  'documents_selected_folder_not_found', 'documents_folder_exists', 'documents_folder_too_deep',
  'documents_file_type_not_allowed', 'documents_file_content_mismatch', 'documents_file_empty',
  'documents_storage_failed', 'dms_account_not_found', 'dms_document_already_linked',
  'dms_document_not_found', 'dms_unreachable', 'dms_document_already_stored',
];

test('Server: jeder Grund der Dokumente hat einen Satz, und jeder "gibt es nicht mehr" laedt nach', () => {
  for (const reason of SERVER_REASONS) {
    assert.ok(CASE_MESSAGES.has(reason), `${reason}: kein Satz`);
    assert.equal(GONE_REASONS.has(reason), reason.endsWith('_not_found'), reason);
  }
  assert.deepEqual(CASE_PARAMS.get('documents_folder_too_deep'), ['limit']);
  assert.deepEqual([...CASE_MESSAGES.keys()].filter((r) => /^(documents|dms)_/.test(r)).sort(), [...SERVER_REASONS].sort(),
    'ein Grund in CASE_MESSAGES, den kein Server dieser Suite nennt');
  // Der aeltere Grund des Ordner-Loeschens erreicht auch Anlegen, Umbenennen
  // und Verschieben - dort ohne den eigenen Weg des Loeschdialogs.
  assert.equal(CASE_MESSAGES.get('FOLDER_DELETE_IN_PROGRESS'), 'documents.folderDeleteInProgressToast');
});

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

const SERVER_TEXT = 'Server sentence.';
const fehler = (status, reason, params) => Object.assign(new Error(SERVER_TEXT), {
  name: 'ApiError', status,
  data: { error: SERVER_TEXT, code: status, ...(reason ? { reason } : {}), ...(params ? { params } : {}) },
});

const FOLDERS = [{ id: 3, name: 'Wohnung', parent_id: null }, { id: 4, name: 'Auto', parent_id: null }];
const DOC = { id: 10, name: 'Vertrag', category: 'home', visibility: 'family', status: 'active', folder_id: null, created_by: 1, storage_backend: 'local' };

/** Den Seitenzustand fuer einen Fall herstellen und danach zuruecksetzen. */
async function mitSeite({ container: given = null, ...patch }, fn) {
  const s = page.state;
  const zuvor = { ...s, selected: new Set(s.selected) };
  Object.assign(s, {
    currentUserId: 1, isAdmin: true, allDocuments: [{ ...DOC }], documents: [{ ...DOC }], folders: FOLDERS.map((f) => ({ ...f })),
    members: [], directory: [], dmsAccounts: [], status: 'active', query: '', queryText: '', category: '', folderId: '',
    expiringSoon: false, selectMode: false, selected: new Set(), view: 'list',
  }, patch);
  // Ohne eigenen Traeger: eine Seite, die gerade angezeigt wird (im DOM).
  const container = given ?? { querySelector: () => null, querySelectorAll: () => [], isConnected: true };
  page.setContainerForTest(container);
  try {
    return await fn();
  } finally {
    Object.assign(s, zuvor);
    page.setContainerForTest(null);
  }
}

/**
 * Mit einem api-Stub laufen lassen. `calls` schreibt jede Anfrage mit,
 * `closed` jedes Schliessen eines Dialogs. Lesen liefert leere Listen, wenn
 * `antworten.get` nichts anderes sagt; die Schreibwege nennt der Test.
 */
async function mit(antworten, lauf) {
  toasts.length = 0;
  const calls = [];
  const closed = [];
  const stub = {
    get: async (path) => { calls.push(['GET', path]); return antworten.get?.(path) ?? { data: [] }; },
  };
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    stub[verb] = async (path, body) => {
      calls.push([verb.toUpperCase(), path]);
      if (!antworten[verb]) throw new Error(`kein Stub fuer ${verb} ${path}`);
      return antworten[verb](path, body);
    };
  }
  const zuvor = { api: globalThis.__apiStub, close: globalThis.__closeModal, select: globalThis.__selectModal, prompt: globalThis.__promptModal };
  globalThis.__apiStub = stub;
  globalThis.__closeModal = (opts) => { closed.push(opts ?? {}); return true; };
  globalThis.__selectModal = async () => antworten.select ?? null;
  globalThis.__promptModal = async () => antworten.prompt ?? null;
  try {
    await lauf();
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.__apiStub = zuvor.api;
    globalThis.__closeModal = zuvor.close;
    globalThis.__selectModal = zuvor.select;
    globalThis.__promptModal = zuvor.prompt;
  }
  const gets = calls.filter(([verb]) => verb === 'GET').map(([, path]) => path);
  return { calls, closed, gets };
}

const reloaded = (gets) => gets.includes('/documents/folders') && gets.some((p) => p.startsWith('/documents?status='));

const assertNoServerText = (...texte) => {
  for (const [text] of toasts) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Toast');
  for (const text of texte) assert.doesNotMatch(String(text), /Server sentence/, 'der Text des Servers im Formular');
};

/** Ein Formular-Element, das Werte, Text, Fokus und neu gebaute Optionen merkt. */
function feld(werte, selector) {
  const wert = werte[selector];
  return {
    value: typeof wert === 'string' ? wert : '', files: Array.isArray(wert) ? wert : [],
    disabled: false, hidden: false, textContent: '', html: null, focused: 0, dataset: {},
    focus() { this.focused += 1; },
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_where, html) { this.html = (this.html ?? '') + html; },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}

function formular(werte = {}) {
  const gemerkt = new Map();
  return {
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!gemerkt.has(selector)) gemerkt.set(selector, feld(werte, selector));
      return gemerkt.get(selector);
    },
  };
}

// --- Ordner ---------------------------------------------------------------

const ORDNER_FAELLE = [
  [fehler(404, 'documents_folder_not_found'), 'documents.errorFolderGone', true],
  [fehler(400, 'documents_selected_folder_not_found'), 'documents.errorSelectedFolderGone', true],
  [fehler(400, 'documents_folder_too_deep', { limit: 5 }), 'documents.errorFolderTooDeep{"limit":5}', false],
  [fehler(409, 'documents_folder_exists'), 'documents.errorFolderExists', false],
  [fehler(409, 'FOLDER_DELETE_IN_PROGRESS'), 'documents.folderDeleteInProgressToast', false],
  [fehler(400), 'common.unknownError', false],
  [fehler(500), 'common.unknownError', false],
];

for (const [name, lauf, antwort] of [
  ['verschieben', () => page.moveFolder({ ...FOLDERS[0] }), { select: '4' }],
  ['umbenennen', () => page.renameFolder({ ...FOLDERS[0] }), { prompt: 'Keller' }],
]) {
  test(`Seite: Ordner ${name} - ein bekannter Fall wird sein Satz, alles andere der allgemeine, nie der des Servers; "gibt es nicht mehr" laedt nach`, async () => {
    for (const [err, expected, gone] of ORDNER_FAELLE) {
      const { gets } = await mitSeite({}, () => mit({ ...antwort, put: async () => { throw err; } }, lauf));
      assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
      assert.equal(reloaded(gets), gone, `${err.data.reason ?? err.status}: nachgeladen ${gets.join(', ')}`);
      assertNoServerText();
    }
  });
}

test('Seite: Ordner loeschen, den es nicht mehr gibt - schon die Vorschau sagt es und die Seite laedt nach', async () => {
  const { gets, calls } = await mitSeite({}, () => mit({
    get: (path) => { if (path.includes('/delete-impact')) throw fehler(404, 'documents_folder_not_found'); return { data: [] }; },
  }, () => page.deleteFolder({ ...FOLDERS[0] })));
  assert.deepEqual(toasts, [['documents.errorFolderGone', 'danger']]);
  assert.ok(reloaded(gets), `nachgeladen: ${gets.join(', ')}`);
  assert.equal(calls.some(([verb]) => verb === 'DELETE'), false);
});

test('Seite: Ordner loeschen scheitert am Server - der Fall oder der allgemeine Satz, nie der Text des Servers', async () => {
  const impact = { data: { id: 3, removed_folders: 1, documents: 0, can_delete_documents: true, linked_records: {}, snapshot: 'a'.repeat(64) } };
  for (const [err, expected, gone] of [
    [fehler(404, 'documents_folder_not_found'), 'documents.errorFolderGone', true],
    [fehler(500), 'common.unknownError', false],
    [fehler(400), 'common.unknownError', false],
  ]) {
    const { gets } = await mitSeite({}, () => mit({
      get: (path) => (path.includes('/delete-impact') ? impact : { data: [] }),
      delete: async () => { throw err; },
    }, () => page.deleteFolder({ ...FOLDERS[0] })));
    assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
    assert.equal(reloaded(gets), gone, `nachgeladen: ${gets.join(', ')}`);
    assertNoServerText();
  }
});

test('Seite: neuer Ordner - der Fall steht im Formular, der gewaehlte Elternordner, den es nicht mehr gibt, wird frisch angeboten', async () => {
  for (const [err, expected, refilled] of [
    [fehler(409, 'documents_folder_exists'), 'documents.errorFolderExists', false],
    [fehler(400, 'documents_folder_too_deep', { limit: 5 }), 'documents.errorFolderTooDeep{"limit":5}', false],
    [fehler(400, 'documents_selected_folder_not_found'), 'documents.errorSelectedFolderGone', true],
    [fehler(400), 'common.unknownError', false],
  ]) {
    const panel = formular({ '#document-folder-name': 'Belege', '#document-folder-parent': '3' });
    let submit = null;
    panel.querySelector('#document-folder-form').addEventListener = (type, fn) => { if (type === 'submit') submit = fn; };
    const { gets, closed } = await mitSeite({}, () => mit({
      get: (path) => (path === '/documents/folders' ? { data: [FOLDERS[1]] } : { data: [] }),
      post: async () => { throw err; },
    }, async () => {
      globalThis.__openModal = (opts) => opts.onSave(panel);
      try { page.openFolderModal(); } finally { delete globalThis.__openModal; }
      assert.equal(typeof submit, 'function', 'das Formular hat einen Submit-Handler');
      await submit({ preventDefault() {} });
    }));
    const error = panel.querySelector('#document-folder-error');
    assert.equal(error.textContent, expected, `${err.status} ${err.data.reason ?? ''}`);
    assert.equal(error.hidden, false);
    assert.deepEqual(toasts, [], 'der Dialog sagt es selbst');
    assert.deepEqual(closed, [], 'der Dialog bleibt offen');
    const parent = panel.querySelector('#document-folder-parent');
    assert.equal(gets.includes('/documents/folders'), refilled, `Ordner frisch: ${gets.join(', ')}`);
    if (refilled) {
      assert.equal(parent.value, '', 'die Auswahl steht auf der obersten Ebene');
      assert.equal(parent.focused, 1, 'und traegt den Fokus');
      assert.match(parent.html ?? '', /Auto/, 'die aktuellen Ordner stehen zur Wahl');
      assert.doesNotMatch(parent.html ?? '', /Wohnung/, 'der geloeschte nicht mehr');
    }
    assertNoServerText(error.textContent);
  }
});

// --- Dokumente ------------------------------------------------------------

const DOKUMENT_FAELLE = [
  [fehler(404, 'documents_document_not_found'), 'documents.errorDocumentGone', true],
  [fehler(500), 'common.unknownError', false],
  [fehler(400), 'common.unknownError', false],
];

test('Seite: archivieren - ein Dokument, das es nicht mehr gibt, sagt es und die Liste kommt frisch; sonst der allgemeine Satz', async () => {
  for (const [err, expected, gone] of DOKUMENT_FAELLE) {
    const { gets } = await mitSeite({}, () => mit({ patch: async () => { throw err; } },
      () => page.runDocumentAction('archive', { ...DOC })));
    assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
    assert.equal(reloaded(gets), gone, `nachgeladen: ${gets.join(', ')}`);
    assertNoServerText();
  }
});

test('Seite: mehrere archivieren und verschieben - derselbe Weg', async () => {
  for (const [name, lauf, verb, antwort] of [
    ['archivieren', () => page.archiveSelected(), 'patch', {}],
    ['verschieben', () => page.moveSelected(), 'put', { select: '4' }],
  ]) {
    for (const [err, expected, gone] of [
      ...DOKUMENT_FAELLE,
      [fehler(400, 'documents_selected_folder_not_found'), 'documents.errorSelectedFolderGone', true],
    ]) {
      const { gets } = await mitSeite({ selectMode: true, selected: new Set([DOC.id]) },
        () => mit({ ...antwort, [verb]: async () => { throw err; } }, lauf));
      assert.deepEqual(toasts, [[expected, 'danger']], `${name}: ${err.status} ${err.data.reason ?? ''}`);
      assert.equal(reloaded(gets), gone, `${name}: nachgeladen ${gets.join(', ')}`);
      assertNoServerText();
    }
  }
});

test('Seite: loeschen mit Ruecknahme, das "nicht gefunden" wird - kein Erfolg und kein Zurueckstellen, sondern Satz und frischer Stand', async () => {
  for (const [err, expected, restored] of [
    [fehler(404, 'documents_document_not_found'), 'documents.errorDocumentGone', false],
    [fehler(500), 'common.unknownError', true],
    [fehler(502, 'documents_storage_failed'), 'documents.errorStorageFailed', true],
  ]) {
    await mitSeite({}, async () => {
      let opts = null;
      globalThis.__undoStub = (o) => { opts = o; };
      try { page.deleteDocuments([{ ...DOC }]); } finally { delete globalThis.__undoStub; }
      assert.ok(opts, 'der Ruecknahme-Weg wurde gestartet');
      assert.equal(page.state.allDocuments.length, 0, 'die Karte ist sofort weg');
      const { gets } = await mit({ delete: async () => { throw err; } }, async () => {
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      assert.deepEqual(toasts, [[expected, 'danger']], `${err.status} ${err.data.reason ?? ''}`);
      assert.equal(page.state.allDocuments.some((d) => d.id === DOC.id), restored, 'zurueckgestellt');
      assert.equal(reloaded(gets), !restored, `nachgeladen: ${gets.join(', ')}`);
      assertNoServerText();
    });
  }
});

test('Seite: mehrere loeschen, eines ist schon weg - nachgeladen wird erst, wenn auch die anderen Loeschungen durch sind', async () => {
  // Review zu #1994: Promise.all brach beim ersten "gibt es nicht mehr" ab,
  // und das Nachladen holte das zweite Dokument zurueck, dessen Loeschen noch lief.
  const zweites = { ...DOC, id: 11, name: 'Rechnung' };
  const log = [];
  await mitSeite({ allDocuments: [{ ...DOC }, zweites], documents: [{ ...DOC }, zweites] }, async () => {
    let opts = null;
    globalThis.__undoStub = (o) => { opts = o; };
    try { page.deleteDocuments([{ ...DOC }, zweites]); } finally { delete globalThis.__undoStub; }
    await mit({
      get: (path) => { log.push(`GET ${path}`); return { data: [] }; },
      delete: async (path) => {
        if (path.endsWith('/10')) throw fehler(404, 'documents_document_not_found');
        for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
        log.push(`geloescht ${path}`);
        return {};
      },
    }, async () => {
      try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
    });
    assert.deepEqual(toasts, [['documents.errorDocumentGone', 'danger']]);
    const firstGet = log.findIndex((x) => x.startsWith('GET '));
    assert.ok(firstGet > log.indexOf('geloescht /documents/11') && log.includes('geloescht /documents/11'), log.join(' | '));
  });
});

test('Seite: an ein DMS senden und aus einem DMS verknuepfen - die Faelle des DMS als Satz der App', async () => {
  const account = { id: 1, name: 'Paperless' };
  for (const [err, expected, gone] of [
    [fehler(404, 'dms_account_not_found'), 'documents.errorDmsAccountGone', true],
    [fehler(404, 'documents_document_not_found'), 'documents.errorDocumentGone', true],
    [fehler(400, 'dms_document_already_stored'), 'documents.errorDmsAlreadyStored', false],
    [fehler(502, 'dms_unreachable'), 'documents.dmsSearchError', false],
    [fehler(502, 'documents_storage_failed'), 'documents.errorStorageFailed', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    const { gets } = await mitSeite({ dmsAccounts: [account] }, () => mit({ post: async () => { throw err; } },
      () => page.runDocumentAction('push-dms', { ...DOC })));
    assert.deepEqual(toasts, [[expected, 'danger']], `push ${err.status} ${err.data.reason ?? ''}`);
    assert.equal(reloaded(gets), gone, `push: nachgeladen ${gets.join(', ')}`);
    // Das Konto ist weg: die Seite fragt auch die Konten neu.
    assert.equal(gets.includes('/documents/meta/options'), gone, `push: Konten frisch ${gets.join(', ')}`);
    assertNoServerText();
  }
  for (const [err, expected, gone] of [
    [fehler(409, 'dms_document_already_linked'), 'documents.errorDmsAlreadyLinked', false],
    [fehler(404, 'dms_document_not_found'), 'documents.errorDmsDocumentGone', true],
    [fehler(404, 'dms_account_not_found'), 'documents.errorDmsAccountGone', true],
    [fehler(502, 'dms_unreachable'), 'documents.dmsSearchError', false],
    [fehler(500), 'common.unknownError', false],
  ]) {
    let ok = null;
    const { gets, closed } = await mitSeite({ dmsAccounts: [account] }, () => mit({ post: async () => { throw err; } },
      async () => { ok = await page.linkDmsDocument({ id: '7' }, account.id); }));
    assert.equal(ok, false, 'der Knopf wird wieder bedienbar');
    assert.deepEqual(toasts, [[expected, 'danger']], `link ${err.status} ${err.data.reason ?? ''}`);
    assert.equal(closed.length, gone ? 1 : 0, 'der Verknuepfen-Dialog geht nur zu, wenn sein Stand veraltet ist');
    assert.equal(reloaded(gets), gone, `link: nachgeladen ${gets.join(', ')}`);
    assertNoServerText();
  }
});

// --- Formular des Dokuments -----------------------------------------------

const BEARBEITEN = { '#document-name': 'Vertrag neu', '#document-category': 'home', '#document-visibility': 'family', '#document-status': 'active', '#document-folder': '3' };

async function speichere(err, werte = BEARBEITEN) {
  const form = formular(werte);
  const panel = formular();
  const result = await mitSeite({}, () => mit({
    get: (path) => (path === '/documents/folders' ? { data: [FOLDERS[1]] } : { data: [] }),
    put: async () => { throw err; },
  }, () => page.saveDocument({ target: form, preventDefault() {} }, { ...DOC }, panel)));
  return { ...result, form, error: form.querySelector('#document-error') };
}

test('Seite: Dokument speichern, das es nicht mehr gibt - sein Satz, der Dialog geht zu, die Liste kommt frisch', async () => {
  const { error, closed, gets } = await speichere(fehler(404, 'documents_document_not_found'));
  assert.deepEqual(toasts, [['documents.errorDocumentGone', 'danger']]);
  assert.equal(closed.length, 1);
  assert.ok(reloaded(gets), `nachgeladen: ${gets.join(', ')}`);
  assertNoServerText(error.textContent);
});

test('Seite: Dokument speichern in einen Ordner, den es nicht mehr gibt - der Dialog bleibt, die Auswahl steht auf "kein Ordner" mit Fokus', async () => {
  const { error, closed, gets, form } = await speichere(fehler(400, 'documents_selected_folder_not_found'));
  assert.equal(error.textContent, 'documents.errorSelectedFolderGone');
  assert.equal(error.hidden, false);
  assert.deepEqual(closed, []);
  assert.ok(gets.includes('/documents/folders'), `Ordner frisch: ${gets.join(', ')}`);
  const select = form.querySelector('#document-folder');
  assert.equal(select.value, '');
  assert.equal(select.focused, 1);
  assert.match(select.html ?? '', /Auto/);
  assert.doesNotMatch(select.html ?? '', /Wohnung/);
});

test('Seite: Dokument speichern scheitert anders - der Fall oder der allgemeine Satz im Formular, eine eigene Pruefung behaelt ihren Satz', async () => {
  for (const [err, expected] of [
    [fehler(400, 'documents_file_type_not_allowed'), 'documents.errorFileTypeNotAllowed'],
    [fehler(400, 'documents_file_content_mismatch'), 'documents.errorFileContentMismatch'],
    [fehler(400, 'documents_file_empty'), 'documents.errorFileEmpty'],
    [fehler(502, 'documents_storage_failed'), 'documents.errorStorageFailed'],
    [fehler(400), 'common.unknownError'],
    [fehler(500), 'common.unknownError'],
  ]) {
    const { error, closed } = await speichere(err);
    assert.equal(error.textContent, expected, `${err.status} ${err.data.reason ?? ''}`);
    assert.equal(error.hidden, false);
    assert.deepEqual(closed, []);
    assertNoServerText(error.textContent);
  }
  // Die Pruefung der Seite selbst (leerer Name) wirft einen eigenen Satz -
  // der bleibt, wie er ist.
  const { error } = await speichere(fehler(500), { ...BEARBEITEN, '#document-name': '' });
  assert.equal(error.textContent, 'common.required');
});

test('Seite: Ordner hochladen - eine gescheiterte Datei nennt den Fall der App, nie den Text des Servers', () => {
  assert.equal(page.folderUploadFailureText({ reason: SERVER_TEXT, error: fehler(400, 'documents_file_type_not_allowed') }), 'documents.errorFileTypeNotAllowed');
  assert.equal(page.folderUploadFailureText({ reason: SERVER_TEXT, error: fehler(500) }), 'common.unknownError');
  assert.equal(page.folderUploadFailureText({ reason: 'Folder creation returned no id.' }), 'common.unknownError');
  assert.equal(page.folderUploadFailureText({ reason: 'rate-limited' }), 'documents.folderUpload.reasonRateLimited');
});

test('Seite: Ordner hochladen bis zur Ergebniszeile - Ordner und Datei, die am Server scheitern, nennen den Fall der App', async () => {
  // Gefahren wird der echte Ablauf (executeFolderUploadPlan) bis in die
  // Fehlerliste, die renderFolderUploadResult zeigt: nur wenn der gefangene
  // Fehler dort ankommt, kann die Zeile seinen Fall nennen (Review zu #1994).
  const { executeFolderUploadPlan } = await import('../public/utils/folder-upload.js');
  const plan = {
    folders: [{ action: 'create', targetRef: 'new:House', parentRef: 'root', name: 'House', key: 'House' }],
    files: [{ action: 'upload', targetRef: 'root', relativePath: 'scan.exe', uploadName: 'scan', uploadOriginalName: 'scan.exe' }],
  };
  const result = await executeFolderUploadPlan(plan, {
    createFolder: async () => { throw fehler(400, 'documents_folder_too_deep', { limit: 5 }); },
    uploadFile: async () => { throw fehler(400, 'documents_file_type_not_allowed'); },
  });
  assert.deepEqual(result.failed.map((failure) => [failure.kind, page.folderUploadFailureText(failure)]), [
    ['folder', 'documents.errorFolderTooDeep{"limit":5}'],
    ['file', 'documents.errorFileTypeNotAllowed'],
  ]);
});

/** Ein Seitentraeger, der mitschreibt, wonach gezeichnet wird. */
function traeger() {
  const gefragt = [];
  // Eine Seite, die gerade angezeigt wird: im DOM eingehaengt.
  return { gefragt, isConnected: true, querySelector: (sel) => { gefragt.push(sel); return null; }, querySelectorAll: () => [] };
}

const BAUM = [{ id: 4, name: 'Auto', parent_id: 5 }, { id: 5, name: 'Zeta', parent_id: null }];

test('Seite: der gewaehlte Ordner ist weg - die Auswahl behaelt ihre Reihenfolge, und die Seitenleiste zeigt den frischen Stand', async () => {
  // Dokument-Dialog: die Liste, wie openDocumentModal sie baut.
  const form = formular(BEARBEITEN);
  const seite = traeger();
  await mitSeite({ container: seite }, () => mit({
    get: (path) => (path === '/documents/folders' ? { data: BAUM } : { data: [] }),
    put: async () => { throw fehler(400, 'documents_selected_folder_not_found'); },
  }, () => page.saveDocument({ target: form, preventDefault() {} }, { ...DOC }, formular())));
  const liste = form.querySelector('#document-folder').html;
  assert.ok(liste.indexOf('Auto') < liste.indexOf('Zeta'), `Reihenfolge der Liste: ${liste}`);
  assert.ok(seite.gefragt.includes('#documents-folder-browser'), 'die Seitenleiste wurde neu gezeichnet');

  // Neuer Ordner: der Baum, eingerueckt, wie openFolderModal ihn baut.
  const panel = formular({ '#document-folder-name': 'Belege', '#document-folder-parent': '3' });
  let submit = null;
  panel.querySelector('#document-folder-form').addEventListener = (type, fn) => { if (type === 'submit') submit = fn; };
  await mitSeite({}, () => mit({
    get: (path) => (path === '/documents/folders' ? { data: BAUM } : { data: [] }),
    post: async () => { throw fehler(400, 'documents_selected_folder_not_found'); },
  }, async () => {
    globalThis.__openModal = (opts) => opts.onSave(panel);
    try { page.openFolderModal(); } finally { delete globalThis.__openModal; }
    await submit({ preventDefault() {} });
  }));
  const baum = panel.querySelector('#document-folder-parent').html;
  assert.ok(baum.indexOf('Zeta') < baum.indexOf('Auto'), `Reihenfolge des Baums: ${baum}`);
  assert.match(baum, />\u00a0\u00a0Auto</, 'der Unterordner steht eingerueckt, mit geschuetzten Leerzeichen');
});

test('Seite: "gibt es nicht mehr", und die Seite wurde inzwischen verlassen - nichts wird mehr gezeichnet', async () => {
  const alt = traeger();
  const neu = traeger();
  await mitSeite({ container: alt }, () => mit({
    get: (path) => { if (path === '/documents/folders') page.setContainerForTest(neu); return { data: [] }; },
    patch: async () => { throw fehler(404, 'documents_document_not_found'); },
  }, () => page.runDocumentAction('archive', { ...DOC })));
  assert.deepEqual(toasts, [['documents.errorDocumentGone', 'danger']]);
  assert.deepEqual(neu.gefragt, [], 'in den neuen Traeger zeichnet das alte Nachladen nicht');
  assert.equal(alt.gefragt.includes('#documents-folder-browser'), false, 'in den alten auch nicht');
});

test('Seite: "gibt es nicht mehr", und inzwischen ist ein anderer Dialog offen - der bleibt offen', async () => {
  // Codex an #1994: der Dialog der Handlung wird nur geschlossen, wenn er noch
  // der offene ist. Zwischen Anfrage und Antwort wechselt hier das Modal.
  let modal = 'dialog-der-handlung';
  globalThis.__modalContextId = () => modal;
  try {
    const form = formular(BEARBEITEN);
    const speichern = await mitSeite({}, () => mit({
      put: async () => { modal = 'ein-anderer-dialog'; throw fehler(404, 'documents_document_not_found'); },
    }, () => page.saveDocument({ target: form, preventDefault() {} }, { ...DOC }, formular())));
    assert.deepEqual(toasts, [['documents.errorDocumentGone', 'danger']]);
    assert.deepEqual(speichern.closed, [], 'Speichern: der fremde Dialog bleibt offen');
    assert.ok(reloaded(speichern.gets), 'nachgeladen wird trotzdem');

    modal = 'dialog-der-handlung';
    const verknuepfen = await mitSeite({ dmsAccounts: [{ id: 1, name: 'Paperless' }] }, () => mit({
      post: async () => { modal = 'ein-anderer-dialog'; throw fehler(404, 'dms_document_not_found'); },
    }, () => page.linkDmsDocument({ id: '7' }, 1)));
    assert.deepEqual(verknuepfen.closed, [], 'Verknuepfen: der fremde Dialog bleibt offen');

    // Gegenfall: derselbe Dialog ist noch offen - er geht zu.
    modal = 'dialog-der-handlung';
    const gleich = await mitSeite({}, () => mit({ put: async () => { throw fehler(404, 'documents_document_not_found'); } },
      () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())));
    assert.equal(gleich.closed.length, 1);
  } finally {
    delete globalThis.__modalContextId;
  }
});

// #1997: die ERFOLGSWEGE. Kommt die Antwort erst, nachdem der Nutzer den
// Dialog geschlossen und einen anderen geoeffnet hat, schliesst sie nur den
// EIGENEN. Ob der Slot noch denselben Dialog haelt, entscheidet
// closeModal({ context }) in components/modal.js (am echten Modul gemessen in
// test-modal-dead-time.js); hier zaehlt die Verdrahtung: jeder Erfolgsweg
// reicht den VOR der Anfrage gemerkten Kontext hinein. Ohne ihn traefe das
// force-Schliessen den Dialog, der gerade offen ist, samt seinen Eingaben.
test('Seite: Erfolg nach Dialogwechsel - jeder Erfolgsweg schliesst nur mit dem Kontext von VOR der Anfrage (#1997)', async () => {
  const wege = [
    ['Dokument speichern', () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())],
    ['neuer Ordner', async () => {
      const panel = formular({ '#document-folder-name': 'Belege', '#document-folder-parent': '' });
      let submit = null;
      panel.querySelector('#document-folder-form').addEventListener = (type, fn) => { if (type === 'submit') submit = fn; };
      globalThis.__openModal = (opts) => opts.onSave(panel);
      try { page.openFolderModal(); } finally { delete globalThis.__openModal; }
      await submit({ preventDefault() {} });
    }],
    ['aus dem DMS verknuepfen', () => page.linkDmsDocument({ id: '7' }, 1)],
  ];
  for (const [name, lauf] of wege) {
    let kontext = 'eigener-dialog';
    globalThis.__modalContextId = () => kontext;
    const wechsel = (antwort) => { kontext = 'ein-anderer-dialog'; return antwort; };
    try {
      const { closed } = await mitSeite({ dmsAccounts: [{ id: 1, name: 'Paperless' }] }, () => mit({
        put: () => wechsel({ data: { ...DOC } }),
        post: () => wechsel({ data: { id: 77 } }),
      }, lauf));
      assert.equal(closed.length, 1, `${name}: genau ein Schliessen`);
      assert.equal(closed[0].force, true, `${name}: force wie bisher`);
      assert.equal(closed[0].context, 'eigener-dialog',
        `${name}: geschlossen wird ohne den Kontext von vor der Anfrage - die spaete Antwort traefe den Dialog, der jetzt offen ist`);
      assert.equal(toasts.some(([, art]) => art === 'danger'), false, `${name}: der Erfolg ist kein Fehler`);
    } finally {
      delete globalThis.__modalContextId;
    }
  }
});

test('Seite: neuer Ordner, Elternordner weg - die neu aufgebaute Auswahl ist Zeichen fuer Zeichen die beim Oeffnen', async () => {
  // Codex an #1994: der Neuaufbau rueckte mit gewoehnlichen Leerzeichen ein,
  // die eine Option zusammenfasst - Unterordner standen dann auf der obersten
  // Ebene. Drei Ebenen, damit eine falsche Tiefe auffaellt.
  const tief = [{ id: 5, name: 'Zeta', parent_id: null }, { id: 4, name: 'Auto', parent_id: 5 }, { id: 6, name: 'Reifen', parent_id: 4 }];
  const labels = (html) => Object.fromEntries([...String(html).matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]));
  const panel = formular({ '#document-folder-name': 'Belege', '#document-folder-parent': '3' });
  let submit = null;
  let content = '';
  panel.querySelector('#document-folder-form').addEventListener = (type, fn) => { if (type === 'submit') submit = fn; };
  await mitSeite({ folders: [...tief, { id: 3, name: 'Wohnung', parent_id: null }] }, () => mit({
    get: (path) => (path === '/documents/folders' ? { data: tief } : { data: [] }),
    post: async () => { throw fehler(400, 'documents_selected_folder_not_found'); },
  }, async () => {
    globalThis.__openModal = (opts) => { content = opts.content; opts.onSave(panel); };
    try { page.openFolderModal(); } finally { delete globalThis.__openModal; }
    await submit({ preventDefault() {} });
  }));
  const beimOeffnen = labels(content);
  delete beimOeffnen['3'];
  assert.equal(Object.keys(beimOeffnen).length, 3, content);
  assert.deepEqual(labels(panel.querySelector('#document-folder-parent').html), beimOeffnen);
});

// Codex an #2001, Nachtrag zu #1994: die Navigation in ein anderes Modul leert
// `_container` nicht - die Variable zeigt weiter auf den abgehaengten Traeger.
// "Derselbe Traeger" allein haelt dann nicht; er muss auch noch im DOM haengen.
test('Seite: die Seite wird verlassen, waehrend das Nachladen laeuft (derselbe, nun abgehaengte Traeger) - kein Zeichnen, kein Fokus', async () => {
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    const seite = traeger();
    await mitSeite({ container: seite }, () => mit({
      get: (path) => { if (path === '/documents/folders') seite.isConnected = false; return { data: [] }; },
      patch: async () => { throw fehler(404, 'documents_document_not_found'); },
    }, () => page.runDocumentAction('archive', { ...DOC })));
    assert.deepEqual(toasts, [['documents.errorDocumentGone', 'danger']]);
    assert.equal(seite.gefragt.includes('#documents-folder-browser'), false, 'die abgehaengte Seite wird nicht gezeichnet');
    assert.equal(refocus, 0, 'der Fokus der neuen Seite bleibt, wo er ist');

    // Gegenfall: die Seite bleibt eingehaengt - gezeichnet wird, der Fokus kommt.
    const bleibt = traeger();
    await mitSeite({ container: bleibt }, () => mit({ patch: async () => { throw fehler(404, 'documents_document_not_found'); } },
      () => page.runDocumentAction('archive', { ...DOC })));
    assert.ok(bleibt.gefragt.includes('#documents-folder-browser'));
    assert.equal(refocus, 1);
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

test('Seite: der gewaehlte Ordner ist weg und die Seite wird waehrenddessen verlassen - die abgehaengte Seite wird nicht gezeichnet', async () => {
  const seite = traeger();
  await mitSeite({ container: seite }, () => mit({
    get: (path) => {
      if (path === '/documents/folders') seite.isConnected = false;
      return path === '/documents/folders' ? { data: BAUM } : { data: [] };
    },
    put: async () => { throw fehler(400, 'documents_selected_folder_not_found'); },
  }, () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())));
  assert.equal(seite.gefragt.includes('#documents-folder-browser'), false);
});

test('Seite: loeschen mit Ruecknahme, und die Seite wurde inzwischen verlassen (abgehaengter Traeger) - kein Nachladen, kein Zurueckstellen', async () => {
  for (const scheitert of [false, true]) {
    const seite = traeger();
    await mitSeite({ container: seite }, async () => {
      let opts = null;
      globalThis.__undoStub = (o) => { opts = o; };
      try { page.deleteDocuments([{ ...DOC }]); } finally { delete globalThis.__undoStub; }
      seite.isConnected = false;
      const { gets } = await mit({ delete: async () => { if (scheitert) throw fehler(500); return {}; } }, async () => {
        try { await opts.commit({ keepalive: false }); } catch (e) { opts.restore(e); }
      });
      assert.equal(gets.some((p) => p.startsWith('/documents?status=')), false, `${scheitert}: nachgeladen ${gets.join(', ')}`);
      assert.deepEqual(toasts, [], `${scheitert}: kein Toast auf einer verlassenen Seite`);
      assert.equal(page.state.allDocuments.some((d) => d.id === DOC.id), false, `${scheitert}: nicht zurueckgestellt`);
    });
  }
});

// Codex an #2001: die Pruefung VOR dem Nachladen reicht nicht - waehrend des
// GET kann die Seite verlassen werden. Jeder Weg, der nach `await
// loadDocuments()` zeichnet, fragt danach noch einmal.
test('Seite: die Seite wird WAEHREND des Nachladens nach einer Handlung verlassen - danach wird nichts mehr gezeichnet', async () => {
  const faelle = [
    ['loeschen (Ruecknahme abgelaufen)', {}, async () => {
      let opts = null;
      globalThis.__undoStub = (o) => { opts = o; };
      try { page.deleteDocuments([{ ...DOC }]); } finally { delete globalThis.__undoStub; }
      await opts.commit({ keepalive: false });
    }],
    ['archivieren (Menue)', {}, () => page.runDocumentAction('archive', { ...DOC })],
    ['archivieren (Auswahl)', { selected: new Set([DOC.id]), selectMode: true }, () => page.archiveSelected()],
    ['verschieben (Auswahl)', { selected: new Set([DOC.id]), selectMode: true }, () => page.moveSelected()],
    ['speichern (Dialog)', {}, () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())],
    ['aus dem DMS verknuepfen', { dmsAccounts: [{ id: 1, name: 'Paperless' }] }, () => page.linkDmsDocument({ id: '7' }, 1)],
  ];
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    for (const [name, patch, lauf] of faelle) {
      const seite = traeger();
      let bisDahin = null;
      refocus = 0;
      const { gets } = await mitSeite({ container: seite, ...patch }, () => mit({
        get: (path) => {
          if (path.startsWith('/documents?status=')) { seite.isConnected = false; bisDahin = seite.gefragt.length; }
          return { data: [] };
        },
        delete: async () => ({}), patch: async () => ({}), put: async () => ({}), post: async () => ({}),
        select: '3',
      }, lauf));
      assert.ok(gets.some((p) => p.startsWith('/documents?status=')), `${name}: Vorbedingung, nachgeladen wurde (${gets.join(', ')})`);
      assert.deepEqual(seite.gefragt.slice(bisDahin), [], `${name}: nach dem Verlassen nichts gezeichnet`);
      assert.equal(refocus, 0, `${name}: kein Fokus`);
    }
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

// Codex an #2001: `owner` merkt die Aufrufstelle VOR der Anfrage. Erst in
// reportError gelesen, waere es nach "verlassen und zurueck" der NEUE
// Container - die spaete Antwort der alten Seite luede nach und zeichnete in
// die neue, bevor die ihren eigenen Aufbau beendet hat.
test('Seite: verlassen und zurueck (neuer Traeger), dann kommt eine spaete "gibt es nicht mehr"-Antwort - kein Nachladen, nichts in die neue Seite', async () => {
  const faelle = [
    ['speichern', 'put', fehler(404, 'documents_document_not_found'), () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())],
    ['speichern, Ordner weg', 'put', fehler(400, 'documents_selected_folder_not_found'), () => page.saveDocument({ target: formular(BEARBEITEN), preventDefault() {} }, { ...DOC }, formular())],
    ['archivieren', 'patch', fehler(404, 'documents_document_not_found'), () => page.runDocumentAction('archive', { ...DOC })],
    ['Ordner umbenennen', 'put', fehler(404, 'documents_folder_not_found'), () => page.renameFolder(FOLDERS[0])],
    ['Ordner verschieben', 'put', fehler(404, 'documents_folder_not_found'), () => page.moveFolder(FOLDERS[0])],
    ['Ordner loeschen (Vorschau)', 'get', fehler(404, 'documents_folder_not_found'), () => page.deleteFolder(FOLDERS[0])],
  ];
  let refocus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  try {
    for (const [name, verb, err, lauf] of faelle) {
      refocus = 0;
      const neu = traeger();
      const zurueck = () => { page.setContainerForTest(neu); throw err; };
      let nachher = [];
      await mitSeite({}, async () => {
        const { calls } = await mit({
          get: (path) => (verb === 'get' && path.includes('/delete-impact') ? zurueck() : { data: [] }),
          [verb === 'get' ? 'x' : verb]: async () => zurueck(),
          prompt: 'Neu', select: '',
        }, lauf);
        const i = calls.findIndex(([v]) => v === verb.toUpperCase());
        nachher = calls.slice(i + 1).filter(([v]) => v === 'GET').map(([, p]) => p);
      });
      assert.deepEqual(nachher, [], `${name}: kein Nachladen nach der spaeten Antwort`);
      assert.deepEqual(neu.gefragt, [], `${name}: in die neue Seite wird nichts gezeichnet`);
      assert.equal(refocus, 0, `${name}: kein Fokus`);
    }
  } finally {
    delete globalThis.__refocusAfterRender;
  }
});

// ---------------------------------------------------------------------------
// #2005: spaete Antworten einer verlassenen Seite
// ---------------------------------------------------------------------------

/** Eine Antwort, die erst kommt, wenn der Test es sagt. */
function spaet() {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

// Die erste Seite laedt beim Aufbau Mitglieder und Metadaten, wird verlassen
// und neu betreten; die neue Seite laedt dasselbe und ist fertig. Erst danach
// kommt die Antwort der alten - sie darf den Stand der neuen nicht ersetzen.
test('Seite (#2005): die spaete Mitglieder-Antwort einer verlassenen Seite ueberschreibt die der neuen nicht', async () => {
  const alt = traeger();
  const neu = traeger();
  await mitSeite({ container: alt }, async () => {
    const altMitglieder = spaet();
    const altVerzeichnis = spaet();
    let runde = 0;
    await mit({
      get: (path) => {
        if (runde === 0) return path === '/family/members' ? altMitglieder.promise : altVerzeichnis.promise;
        return { data: [{ id: path === '/family/members' ? 2 : 3, display_name: 'Neu' }] };
      },
    }, async () => {
      const ersteSeite = page.loadMembers();
      runde = 1;
      page.setContainerForTest(neu, { built: true });
      await page.loadMembers();
      altMitglieder.resolve({ data: [{ id: 1, display_name: 'Alt' }] });
      altVerzeichnis.resolve({ data: [{ id: 1, display_name: 'Alt' }] });
      await ersteSeite;
    });
    assert.deepEqual(page.state.members.map((m) => m.id), [2], 'die Mitglieder der neuen Seite');
    assert.deepEqual(page.state.directory.map((m) => m.id), [3], 'das Verzeichnis der neuen Seite');
  });
});

test('Seite (#2005): die spaete Metadaten-Antwort einer verlassenen Seite - weder ihr Stand noch ihr Scheitern ersetzt den der neuen', async () => {
  for (const ausgang of ['antwortet', 'scheitert']) {
    const neu = traeger();
    await mitSeite({ container: traeger() }, async () => {
      const altMeta = spaet();
      let runde = 0;
      await mit({
        get: () => (runde === 0 ? altMeta.promise : {
          data: { dms_accounts: [{ id: 9, name: 'Paperless' }], active_upload_backend: 'dms', is_admin: false },
        }),
      }, async () => {
        const ersteSeite = page.loadMetaOptions();
        runde = 1;
        page.setContainerForTest(neu, { built: true });
        await page.loadMetaOptions();
        if (ausgang === 'antwortet') {
          altMeta.resolve({ data: { dms_accounts: [], active_upload_backend: 'local', is_admin: true } });
        } else {
          altMeta.reject(fehler(500));
        }
        await ersteSeite;
      });
      assert.deepEqual(
        [page.state.dmsAccounts.map((a) => a.id), page.state.activeUploadBackend, page.state.isAdmin],
        [[9], 'dms', false],
        `${ausgang}: der Stand der neuen Seite`,
      );
    });
  }
});

// Codex an #2001: ein Ordner-Loeschen, dessen Antwort oder Nachladen erst nach
// "verlassen und zurueck" ankommt, schreibt den Stand ohne den Ordner in den
// modulweiten Zustand. Die neue Seite muss ihn dann auch zeigen - sonst steht
// der geloeschte Ordner dort bis zum naechsten Neuzeichnen.
test('Seite (#2005): Ordner loeschen, die Antwort kommt nach "verlassen und zurueck" - die neue Seite zeigt den Stand ohne den Ordner', async () => {
  const impact = { data: { id: 3, removed_folders: 1, documents: 0, can_delete_documents: true, linked_records: {}, snapshot: 'a'.repeat(64) } };
  let refocus = 0;
  let mitFokus = 0;
  globalThis.__refocusAfterRender = () => { refocus += 1; };
  globalThis.__renderKeepingFocus = () => { mitFokus += 1; };
  try {
    for (const fertig of [true, false]) {
      refocus = 0;
      mitFokus = 0;
      const alt = traeger();
      const neu = traeger();
      let ordner = null;
      await mitSeite({ container: alt }, async () => {
        await mit({
          get: (path) => {
            if (path.includes('/delete-impact')) return impact;
            return path === '/documents/folders' ? { data: [FOLDERS[1]] } : { data: [] };
          },
          delete: async () => { page.setContainerForTest(neu, { built: fertig }); return { data: { folder_deleted: true } }; },
        }, () => page.deleteFolder({ ...FOLDERS[0] }));
        ordner = page.state.folders.map((f) => f.id);
      });
      assert.deepEqual(ordner, [4], 'Vorbedingung: der Stand ohne den Ordner ist geladen');
      if (fertig) {
        assert.ok(neu.gefragt.includes('#documents-folder-browser'), 'die neue, fertig aufgebaute Seite zeichnet den Stand ohne den Ordner');
        // Codex an #2020: renderAll() tauscht Zeilen, Chips und Ordner aus -
        // der Fokus der neuen Seite muss ueber das Neuzeichnen getragen werden.
        assert.equal(mitFokus, 1, 'die neue Seite wird mit ihrem Fokus neu gezeichnet');
      } else {
        // Wie bei der spaeten "gibt es nicht mehr"-Antwort: in eine Seite, die
        // noch aufbaut, zeichnet der alte Weg nicht - das tut ihr Aufbau.
        assert.deepEqual(neu.gefragt, [], 'in eine noch aufbauende Seite wird nicht gezeichnet');
      }
      assert.equal(alt.gefragt.includes('#documents-folder-browser'), false, 'die verlassene Seite wird nicht gezeichnet');
      assert.equal(refocus, 0, 'der Fokus der neuen Seite bleibt, wo er ist');
    }
  } finally {
    delete globalThis.__refocusAfterRender;
    delete globalThis.__renderKeepingFocus;
  }
});

// Codex an #2020: laedt die neue Seite inzwischen selbst neuer (Status-Reiter),
// nimmt der Applier die alte Antwort nicht an - und die alte Handlung darf dann
// nicht aus dem ueberholten Stand zeichnen, sie ersetzte das Lade-Skelett der
// neuen Seite mit Dokumenten des falschen Status.
test('Seite (#2005): Ordner loeschen nach "verlassen und zurueck", die neue Seite laedt inzwischen selbst - die ueberholte Antwort zeichnet nicht', async () => {
  const impact = { data: { id: 3, removed_folders: 1, documents: 0, can_delete_documents: true, linked_records: {}, snapshot: 'a'.repeat(64) } };
  const alt = traeger();
  const neu = traeger();
  let eigenesLaden = null;
  let dokumente = 0;
  await mitSeite({ container: alt }, async () => {
    await mit({
      get: (path) => {
        if (path.includes('/delete-impact')) return impact;
        if (path.startsWith('/documents?status=') && dokumente++ === 0) {
          // Die neue Seite wechselt den Reiter, waehrend das alte Nachladen laeuft.
          eigenesLaden = page.loadDocuments();
        }
        return { data: [] };
      },
      delete: async () => { page.setContainerForTest(neu, { built: true }); return { data: { folder_deleted: true } }; },
    }, () => page.deleteFolder({ ...FOLDERS[0] }));
    assert.equal(await eigenesLaden, true, 'Vorbedingung: das Laden der neuen Seite ist das juengste');
  });
  assert.equal(dokumente, 2, 'Vorbedingung: zwei Dokument-Anfragen');
  assert.deepEqual(neu.gefragt, [], 'die ueberholte Antwort zeichnet nicht in die neue Seite');
});

// Codex an #2020: ein Ordner, angelegt auf der alten Seite und erst nach
// "verlassen und zurueck" bestaetigt, waehlt sich nicht in die neue Seite.
test('Seite (#2005): neuer Ordner, die Antwort kommt nach "verlassen und zurueck" - die Ordnerauswahl der neuen Seite bleibt', async () => {
  const panel = formular({ '#document-folder-name': 'Belege', '#document-folder-parent': '' });
  let submit = null;
  panel.querySelector('#document-folder-form').addEventListener = (type, fn) => { if (type === 'submit') submit = fn; };
  const neu = traeger();
  let auswahl = null;
  await mitSeite({ container: traeger() }, async () => {
    await mit({
      post: async () => {
        page.setContainerForTest(neu, { built: true });
        page.state.folderId = '4';
        return { data: { id: 77 } };
      },
    }, async () => {
      globalThis.__openModal = (opts) => opts.onSave(panel);
      try { page.openFolderModal(); } finally { delete globalThis.__openModal; }
      await submit({ preventDefault() {} });
    });
    auswahl = page.state.folderId;
  });
  assert.equal(auswahl, '4', 'die Auswahl der neuen Seite');
});

test('Seite (#2005): Ordner samt Dokumenten loeschen mit Ruecknahme, Teilergebnis nach "verlassen und zurueck" - die neue Seite zeigt den Stand', async () => {
  const impact = { data: { id: 3, removed_folders: 1, documents: 2, can_delete_documents: true, linked_records: {}, snapshot: 'a'.repeat(64) } };
  const alt = traeger();
  const neu = traeger();
  await mitSeite({ container: alt }, async () => {
    let opts = null;
    const knopf = (id) => ({ addEventListener: (type, fn) => { if (id === '#documents-folder-delete-documents' && type === 'click') fn(); } });
    await mit({ get: (path) => (path.includes('/delete-impact') ? impact : { data: [] }) }, async () => {
      globalThis.__openModal = (o) => o.onSave({ querySelector: knopf });
      globalThis.__undoStub = (o) => { opts = o; };
      try { await page.deleteFolder({ ...FOLDERS[0] }); } finally {
        delete globalThis.__openModal;
        delete globalThis.__undoStub;
      }
    });
    assert.ok(opts, 'Vorbedingung: das Loeschen wartet auf die Ruecknahme');
    page.setContainerForTest(neu, { built: true });
    const { gets } = await mit({
      get: (path) => (path === '/documents/folders' ? { data: FOLDERS } : { data: [] }),
      delete: async () => ({ data: { folder_deleted: false, deleted_documents: 1, failed_documents: [{ id: 11, failure_stage: 'storage' }] } }),
    }, () => opts.commit({ keepalive: false }));
    assert.ok(reloaded(gets), `Vorbedingung: das Teilergebnis laedt nach (${gets.join(', ')})`);
    assert.ok(neu.gefragt.includes('#documents-folder-browser'), 'die neue Seite zeichnet den Stand nach dem Teilergebnis');
  });
});

// Re-Critique 2026-10-17, P1: "Bitte waehle eine Datei aus." stand als
// Formularfehler am Fuss des Dialogs (mobil bei y=1086 von 844, unsichtbar),
// und der Fokus blieb auf "Hochladen". Der Fehler gehoert an die Ablage.
test('Seite: Hochladen ohne Datei - der Fehler steht an der Ablage, Fokus und Blick gehen dorthin', async () => {
  for (const [dateien, satz] of [
    [[], 'documents.fileRequired'],
    [[{ name: 'riesig.pdf', size: 10 ** 12 }], 'documents.fileTooLargeNamed{"name":"riesig.pdf"}'],
  ]) {
    const form = formular();
    const attrs = new Map();
    const input = Object.assign(form.querySelector('#document-file'), {
      files: dateien,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      removeAttribute(name) { attrs.delete(name); },
    });
    const dropzone = form.querySelector('#document-dropzone');
    let scrolled = 0;
    dropzone.scrollIntoView = () => { scrolled += 1; };
    dropzone.getAttribute = () => null;
    const gemeldet = [];
    globalThis.__reportFieldError = (feld, text, opts) => gemeldet.push([feld, text, opts]);
    let posted = 0;
    try {
      await mitSeite({}, () => mit({ post: async () => { posted += 1; return { data: {} }; } },
        () => page.saveDocument({ target: form, preventDefault() {} }, null, formular())));
    } finally {
      delete globalThis.__reportFieldError;
    }
    assert.equal(gemeldet.length, 1, `${satz}: genau eine Meldung am Feld`);
    assert.equal(gemeldet[0][0], dropzone, 'die Meldung steht an der Ablage');
    assert.equal(gemeldet[0][1], satz);
    assert.equal(form.querySelector('#document-error').hidden, true, 'nicht als Formularfehler am Fuss');
    assert.equal(input.focused, 1, 'der Fokus geht in die Dateiwahl');
    assert.equal(attrs.get('aria-invalid'), 'true', 'die Dateiwahl sagt ihren Zustand an');
    assert.equal(scrolled, 1, 'die Ablage kommt in den Blick');
    assert.equal(posted, 0, 'nichts wird hochgeladen');
  }
});
