/**
 * Test: Module-Installation aus den Einstellungen (ZIP-Upload und GitHub)
 * Zweck: server/services/module-install.js, server/services/module-github.js und
 *        die neuen Routen in server/routes/modules.js. Substanz:
 *          - Modul im Archiv finden: Wurzel, GitHub-Oberordner, tief verschachtelt
 *            (Ordnername ≠ id → installiert als manifest.id), mehrere Kandidaten
 *            (422 + candidates, dann path), path_not_found, no_manifest
 *          - Manifest-Fehler (entry fehlt, id ungueltig, manifestVersion 2)
 *          - nicht erlaubte Dateien werden uebersprungen und gemeldet
 *          - neu installiert = AUSGESCHALTET, Assets 404 bis zum Einschalten; nur ein GitHub-Update aus derselben
 *            Quelle behaelt den Zustand;
 *            Ersetzen ohne overwrite → 409 exists (+ installierte Version)
 *          - Rollback, wenn der Tausch scheitert (simuliert)
 *          - Loeschen (+404, Symlink verweigert, ungueltige id)
 *          - Punkt-Ordner tauchen nicht in listModules auf; `.yuvomi-install.json`
 *            erscheint als `install` und wird von der Asset-Route NICHT ausgeliefert
 *          - nicht beschreibbar → 503 (simuliert ueber den access-Hook: chmod auf
 *            Ordnern ist unter Windows wirkungslos)
 *          - gleichzeitige Installation → busy; Admin-Gate 403; 413 mit 20-MB-Text;
 *            Rate-Limit 429
 *          - GitHub: URL-Parser-Tabelle, Ref-Aufloesung, tree/<a>/<b>/<pfad>,
 *            Redirect auf fremden Host verweigert, Rate-Limit 403 → 429, Download
 *            ueber dem Limit → too_large, User-Agent gesendet, Ende-zu-Ende ueber
 *            die Route mit Commit aus dem ZIP-Kommentar
 *          - Runde 1 der Review: nur Browser-Sitzung (module_session_required), Quelle
 *            gewechselt → wieder aus, path='' waehlt die Wurzel, Elternordner →
 *            multiple, install nur in der Admin-Liste, 415 bei fremdem
 *            Content-Encoding, nicht schreibbarer Name → unsafe_path,
 *            Persistenz-Erkennung (isPersistent) ueber injizierte /proc-Dateien
 *          - Runde 2: jedes ZIP-Ersetzen und jede andere Quelle schaltet zur
 *            Pruefung aus (disabledForReview/disabledReason), Ref-Probe nur per
 *            SHA, 409/422 zaehlen nicht zum Limit, releases/latest ohne
 *            brauchbaren Tag → Fehler, Tiefe unter dem Oberordner, verschachtelte
 *            Module werden nicht mitkopiert
 *
 *        Kein Netz: der GitHub-Transport ist ein Fake (__setGithubRequestForTests /
 *        createGithubInstaller({ request })). MODULES_DIR zeigt auf einen
 *        Temp-Ordner, die DB ist In-Memory.
 * Ausführen: node --experimental-sqlite --test test/test-module-install.js
 */

import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { tempDir } from './tmp-dir.js';

const TMP_ROOT = tempDir('yuvomi-module-install-');
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const modulesSvc = await import('../server/services/modules.js');
const install = await import('../server/services/module-install.js');
const github = await import('../server/services/module-github.js');
const { default: modulesRouter } = await import('../server/routes/modules.js');

// ── Kleiner ZIP-Schreiber (deflate) ─────────────────────────────────────────
// Die boesartigen Archive prueft test-zip-reader.js; hier genuegen gueltige.
function makeZip(files, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const flags = 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    const chunk = Buffer.concat([local, nameBuf, comp]);
    locals.push(chunk);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment, 'latin1');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}

function moduleFiles(id, { version = '1.0.0', prefix = '', extra = {}, manifest = {} } = {}) {
  return {
    [`${prefix}module.json`]: JSON.stringify({ id, name: `Mod ${id}`, version, entry: 'index.js', ...manifest }),
    [`${prefix}index.js`]: `export default { id: '${id}', version: '${version}' };\n`,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`${prefix}${k}`, v])),
  };
}

const dirExists = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const stagingLeftovers = () => fs.readdirSync(MODULES_DIR).filter((n) => n.startsWith('.install-') || n.startsWith('.backup-'));

// ── App mit injizierter Auth ────────────────────────────────────────────────
// Jede Admin-Anfrage bekommt eine eigene Nutzer-Id: das Install-Limit zaehlt
// je Nutzer (10 je 10 Minuten), und diese Suite installiert weit oefter. Die
// Limit-Probe selbst nimmt eine feste Id.
let nextAdminId = 100;
const admin = () => ({ id: nextAdminId++, role: 'admin' });
const MEM = { id: 2, role: 'member' };
let actor = admin();
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  // Wie requireAuth: 'session' fuer den Browser, 'api_token' fuer Tokens.
  req.authMethod = actor.method ?? 'session';
  next();
});
app.use(express.json());
app.use('/', modulesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, route, { actor: a, json, raw, contentType = 'application/zip' } = {}) {
  actor = a || admin();
  const headers = {};
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (raw !== undefined) {
    headers['Content-Type'] = contentType;
    body = raw;
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { parsed = JSON.parse(buf.toString('utf8')); } catch { /* leer */ }
  }
  return { status: res.status, body: parsed, buf };
}

const postZip = (zip, query = '', a) => call('POST', `/install/zip${query}`, { raw: zip, actor: a });

test.after(() => {
  github.__setGithubRequestForTests(null);
  server.close();
});

// ── Finden des Moduls im Archiv ─────────────────────────────────────────────

test('ZIP mit Modul an der Wurzel: installiert, AUSGESCHALTET, mit install-Metadaten', async () => {
  const r = await postZip(makeZip(moduleFiles('root-mod', { extra: { 'style.css': '.a{}', 'lib/util.mjs': 'export {}' } })));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'root-mod');
  assert.equal(r.body.data.enabled, false, 'ein neues Modul startet ausgeschaltet');
  assert.equal(r.body.data.status, 'disabled');
  assert.equal(r.body.replaced, false);
  assert.deepEqual(r.body.skipped, []);
  assert.equal(r.body.data.install.source, 'zip');
  assert.match(r.body.data.install.installedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.body.data.install.installedBy, undefined, 'wer installiert hat, steht nicht in der Antwort');
  assert.ok(fs.existsSync(path.join(MODULES_DIR, 'root-mod', 'lib', 'util.mjs')));
  assert.ok(fs.existsSync(path.join(MODULES_DIR, 'root-mod', '.yuvomi-install.json')));
  assert.deepEqual(stagingLeftovers(), [], 'kein Staging-Ordner bleibt liegen');
  // Nutzer sehen es nicht, solange es aus ist.
  const list = await call('GET', '/', { actor: MEM });
  assert.ok(!list.body.data.some((m) => m.id === 'root-mod'));
});

// Anders als der Haushaltsschalter der eingebauten Module (DECISIONS.md, 11):
// ein ausgeschaltetes Fremdmodul wird gar nicht ausgeliefert.
test('ein frisch installiertes Modul liefert seinen Einstieg erst nach dem Einschalten aus', async () => {
  const r = await postZip(makeZip(moduleFiles('gate-mod')));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.enabled, false);
  const before = await call('GET', '/assets/gate-mod/index.js', { actor: MEM });
  assert.equal(before.status, 404, 'aus: der Einstieg antwortet 404');

  const on = await call('PATCH', '/gate-mod', { json: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const after = await call('GET', '/assets/gate-mod/index.js', { actor: MEM });
  assert.equal(after.status, 200);
  assert.match(after.buf.toString('utf8'), /id: 'gate-mod'/);

  await call('PATCH', '/gate-mod', { json: { enabled: false } });
  assert.equal((await call('GET', '/assets/gate-mod/index.js', { actor: MEM })).status, 404, 'wieder aus: wieder 404');
});

test('ZIP mit GitHub-Oberordner: der eine gemeinsame Ordner wird abgestreift', async () => {
  const r = await postZip(makeZip(moduleFiles('top-mod', { prefix: 'owner-top-mod-1a2b3c/' })));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'top-mod');
  assert.equal(r.body.data.install.path, null, 'Modul liegt an der (abgestreiften) Wurzel');
  assert.ok(fs.existsSync(path.join(MODULES_DIR, 'top-mod', 'index.js')));
});

test('tief verschachtelt, Ordnername ≠ id: installiert als manifest.id, nur der Modulordner wird kopiert', async () => {
  const files = {
    'repo-abc/README.md': '# repo',
    'repo-abc/server/app.py': 'print(1)',
    ...moduleFiles('example-plugin', { prefix: 'repo-abc/plugins/example/module/' }),
  };
  const r = await postZip(makeZip(files));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'example-plugin');
  assert.equal(r.body.data.install.path, 'plugins/example/module');
  assert.ok(dirExists(path.join(MODULES_DIR, 'example-plugin')));
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'module')), 'nie der Archiv-Ordnername');
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'example-plugin', 'README.md')), 'Dateien ausserhalb des Modulordners bleiben draussen');
  assert.deepEqual(r.body.skipped, [], 'was ausserhalb liegt, ist nicht "uebersprungen", es gehoert nicht dazu');

  const banking = await postZip(makeZip(moduleFiles('banking', { prefix: 'repo-1f2e/modules/banking/' })));
  assert.equal(banking.status, 201);
  assert.equal(banking.body.data.install.path, 'modules/banking');
  // Ohne Repo-Oberordner ist `modules/` selbst der eine gemeinsame Ordner und
  // wird abgestreift - der Pfad zaehlt ab dort.
  const bare = await postZip(makeZip(moduleFiles('banking-two', { prefix: 'modules/banking-two/' })));
  assert.equal(bare.status, 201);
  assert.equal(bare.body.data.install.path, 'banking-two');
});

test('mehrere Kandidaten → 422 multiple mit candidates, dann waehlt path', async () => {
  const zip = makeZip({
    ...moduleFiles('multi-a', { prefix: 'repo/modules/a/', version: '0.1.0' }),
    ...moduleFiles('multi-b', { prefix: 'repo/modules/b/', version: '0.2.0' }),
    'repo/node_modules/dep/module.json': '{"id":"ignored-dep"}',
    'repo/.github/module.json': '{"id":"ignored-dot"}',
    'repo/1/2/3/4/5/6/7/module.json': '{"id":"too-deep"}',
  });
  const r = await postZip(zip);
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'multiple');
  assert.equal(r.body.code, 422);
  assert.deepEqual(r.body.candidates, [
    { path: 'modules/a', id: 'multi-a', name: 'Mod multi-a', version: '0.1.0' },
    { path: 'modules/b', id: 'multi-b', name: 'Mod multi-b', version: '0.2.0' },
  ], 'node_modules, Punkt-Ordner und Tiefe > 6 zaehlen nicht');

  const chosen = await postZip(zip, '?path=modules/b');
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
  assert.equal(chosen.body.data.id, 'multi-b');
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'multi-a')));
});

test('path ohne Treffer → 400 path_not_found; kein module.json → 400 no_manifest', async () => {
  const r = await postZip(makeZip(moduleFiles('pathless', { prefix: 'x/' })), '?path=nope/here');
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'path_not_found');
  const traversal = await postZip(makeZip(moduleFiles('pathless')), '?path=../etc');
  assert.equal(traversal.body.reason, 'path_not_found');

  const none = await postZip(makeZip({ 'README.md': 'hi', 'index.js': '' }));
  assert.equal(none.status, 400);
  assert.equal(none.body.reason, 'no_manifest');
});

test('kaputtes Manifest → 400 bad_manifest (entry fehlt, id ungueltig, manifestVersion 2, kein JSON)', async () => {
  const cases = [
    { 'module.json': JSON.stringify({ id: 'no-entry-file', entry: 'index.js' }) },
    { 'module.json': JSON.stringify({ id: 'Bad_ID', entry: 'index.js' }), 'index.js': '' },
    { 'module.json': JSON.stringify({ entry: 'index.js' }), 'index.js': '' },
    { 'module.json': JSON.stringify({ id: 'future-mod', entry: 'index.js', manifestVersion: 2 }), 'index.js': '' },
    { 'module.json': '{ kein json', 'index.js': '' },
    // Die Einstiegsdatei hat eine erlaubte Endung, aber ein Widget-Entry fehlt.
    {
      'module.json': JSON.stringify({ id: 'widget-miss', entry: 'index.js', capabilities: { widgets: [{ id: 'w', entry: 'w.js', label: 'W' }] } }),
      'index.js': '',
    },
  ];
  for (const files of cases) {
    const r = await postZip(makeZip(files));
    assert.equal(r.status, 400, `${files['module.json']} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason, 'bad_manifest');
  }
  const future = await postZip(makeZip(cases[3]));
  assert.match(future.body.error, /manifestVersion 2/, 'die Meldung des Loaders kommt durch');
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'future-mod')));
  assert.deepEqual(stagingLeftovers(), []);
});

test('nicht erlaubte Dateien werden uebersprungen und gemeldet', async () => {
  const r = await postZip(makeZip(moduleFiles('skip-mod', {
    extra: {
      'build.sh': '#!/bin/sh',
      'bin/tool.exe': 'MZ',
      'server.py': 'x',
      '.env': 'SECRET=1',
      '.github/workflows/ci.md': 'ci',
      '.yuvomi-install.json': '{"source":"github","url":"https://evil"}',
      'LICENSE': 'MIT',
      'NOTICE.txt': 'n',
      'img/a.WEBP': 'x',
      'fonts/f.woff2': 'x',
    },
  })));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.skipped, ['.env', '.github/workflows/ci.md', '.yuvomi-install.json', 'bin/tool.exe', 'build.sh', 'server.py']);
  const dir = path.join(MODULES_DIR, 'skip-mod');
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(dir, 'img', 'a.WEBP')), 'Endung ohne Ruecksicht auf Gross/Klein');
  assert.ok(!fs.existsSync(path.join(dir, 'build.sh')));
  assert.equal(r.body.data.install.source, 'zip', 'die Metadaten aus dem Archiv werden nie uebernommen');
});

// ── Ersetzen ────────────────────────────────────────────────────────────────

test('Ersetzen ohne overwrite → 409 exists mit installiertem und neuem Modul', async () => {
  await postZip(makeZip(moduleFiles('replace-mod', { version: '1.0.0' })));
  const r = await postZip(makeZip(moduleFiles('replace-mod', { version: '2.0.0' })));
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'exists');
  const { install: existingInstall, ...existing } = r.body.existing;
  assert.deepEqual(existing, { id: 'replace-mod', name: 'Mod replace-mod', version: '1.0.0' });
  assert.equal(existingInstall.source, 'zip');
  assert.equal(existingInstall.installedBy, undefined);
  assert.deepEqual(r.body.incoming, { id: 'replace-mod', name: 'Mod replace-mod', version: '2.0.0' });
  assert.equal(r.body.sourceChanged, false, 'ZIP ueber ZIP ist dieselbe Quelle');
  assert.equal(r.body.replaceDisabledReason, 'zip_replace', 'die Frage weiss vorher, dass das Ersetzen ausschaltet');
});

// Runde 2 (R3): JEDES Ersetzen aus einer ZIP-Datei schaltet zur Pruefung aus.
// Zwei Uploads haben keine pruefbare gemeinsame Herkunft.
test('ZIP-Ersetzen schaltet ein eingeschaltetes Modul zur Pruefung aus', async () => {
  await modulesSvc.setModuleEnabled('replace-mod', true);
  const r = await postZip(makeZip(moduleFiles('replace-mod', { version: '2.0.0' })), '?overwrite=1');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.replaced, true);
  assert.equal(r.body.data.version, '2.0.0');
  assert.equal(r.body.data.enabled, false, 'neuer Code aus einer ZIP-Datei startet aus');
  assert.equal(r.body.disabledForReview, true);
  assert.equal(r.body.disabledReason, 'zip_replace');
  assert.deepEqual(stagingLeftovers(), [], 'Sicherung wird nach Erfolg entfernt');
});

test('ZIP-Ersetzen eines ausgeschalteten Moduls: bleibt aus, Antwort sagt es trotzdem', async () => {
  await modulesSvc.setModuleEnabled('replace-mod', false);
  const r = await postZip(makeZip(moduleFiles('replace-mod', { version: '3.0.0' })), '?overwrite=1');
  assert.equal(r.status, 201);
  assert.equal(r.body.data.enabled, false);
  assert.equal(r.body.disabledForReview, true, 'der neue Code wartet auf Pruefung, egal wie es vorher stand');
  assert.equal(r.body.disabledReason, 'zip_replace');
});

test('neue Installation: disabledForReview ist immer da und false, disabledReason null', async () => {
  const r = await postZip(makeZip(moduleFiles('fresh-flag-mod')));
  assert.equal(r.status, 201);
  assert.equal(r.body.disabledForReview, false);
  assert.equal(r.body.disabledReason, null);
  assert.ok(!('disabledBecauseSourceChanged' in r.body), 'der alte Name ist weg');
});

test('Rollback: scheitert der Tausch, steht das alte Modul wieder da', async () => {
  const restore = install.__setInstallFsOpsForTests({
    rename: async (from, to) => {
      if (path.basename(path.dirname(from)).startsWith('.install-')) {
        const err = new Error('simulated EIO');
        err.code = 'EIO';
        throw err;
      }
      return fs.promises.rename(from, to);
    },
  });
  try {
    await assert.rejects(
      install.installFromZip(makeZip(moduleFiles('replace-mod', { version: '9.9.9' })), { overwrite: true }),
      /simulated EIO/,
    );
  } finally {
    restore();
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(MODULES_DIR, 'replace-mod', 'module.json'), 'utf8'));
  assert.equal(manifest.version, '3.0.0', 'die alte Fassung ist zurueck');
  assert.deepEqual(stagingLeftovers(), [], 'weder Staging noch Sicherung bleiben liegen');
});

test('Rollback bei einer NEUEN Installation laesst keinen Disabled-Eintrag zurueck', async () => {
  const restore = install.__setInstallFsOpsForTests({
    rename: async () => { throw Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' }); },
  });
  try {
    await assert.rejects(install.installFromZip(makeZip(moduleFiles('never-there'))), /EXDEV/);
  } finally {
    restore();
  }
  assert.equal(modulesSvc.isModuleDisabled('never-there'), false);
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'never-there')));
});

test('Ziel ist ein Symlink/kein Ordner → 409 not_a_module ohne existing, auch mit overwrite', async (t) => {
  fs.writeFileSync(path.join(MODULES_DIR, 'file-mod'), 'not a folder');
  for (const query of ['', '?overwrite=1']) {
    const r = await postZip(makeZip(moduleFiles('file-mod')), query);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'not_a_module');
    assert.equal(r.body.existing, undefined, 'kein existing: die UI bietet sonst ein Ersetzen an, das scheitert');
  }
  assert.equal(fs.readFileSync(path.join(MODULES_DIR, 'file-mod'), 'utf8'), 'not a folder');
  fs.rmSync(path.join(MODULES_DIR, 'file-mod'));
  t.diagnostic('file target refused');
});

// ── Listen, Metadaten, Assets ───────────────────────────────────────────────

test('Punkt-Ordner (Staging/Sicherung) tauchen in listModules nicht auf', async () => {
  const dir = path.join(MODULES_DIR, '.backup-ghost-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ id: '.backup-ghost-1', entry: 'index.js' }));
  const mods = await modulesSvc.listModules({ admin: true });
  assert.ok(!mods.some((m) => m.id.startsWith('.')), mods.map((m) => m.id).join(', '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install ist null fuer ein von Hand kopiertes Modul und bei kaputter Metadaten-Datei', async () => {
  const dir = path.join(MODULES_DIR, 'manual-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ id: 'manual-mod', entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  let mods = await modulesSvc.listModules({ admin: true });
  assert.equal(mods.find((m) => m.id === 'manual-mod').install, null);
  fs.writeFileSync(path.join(dir, '.yuvomi-install.json'), '{ kaputt');
  mods = await modulesSvc.listModules({ admin: true });
  assert.equal(mods.find((m) => m.id === 'manual-mod').install, null);
  fs.writeFileSync(path.join(dir, '.yuvomi-install.json'), JSON.stringify({ source: 'zip', pad: 'x'.repeat(5000) }));
  mods = await modulesSvc.listModules({ admin: true });
  assert.equal(mods.find((m) => m.id === 'manual-mod').install, null, 'groesser als 4 KiB wird ignoriert');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('die Asset-Route liefert keine Punktdateien aus, normale Assets weiter', async () => {
  const zip = makeZip(moduleFiles('asset-mod', { extra: { 'sub/ok.js': 'ok' } }));
  assert.equal((await postZip(zip)).status, 201);
  await modulesSvc.setModuleEnabled('asset-mod', true);
  // Eine Punktdatei unterhalb, wie sie ein Betreiber von Hand ablegen koennte.
  fs.writeFileSync(path.join(MODULES_DIR, 'asset-mod', 'sub', '.hidden.js'), 'secret');

  const meta = await call('GET', '/assets/asset-mod/.yuvomi-install.json', { actor: MEM });
  assert.equal(meta.status, 404);
  assert.ok(!meta.buf.toString().includes('installedBy'));
  assert.equal((await call('GET', '/assets/asset-mod/sub/.hidden.js', { actor: MEM })).status, 404);
  assert.equal((await call('GET', '/assets/asset-mod/sub/ok.js', { actor: MEM })).status, 200);
  assert.equal((await call('GET', '/assets/asset-mod/index.js', { actor: MEM })).status, 200);
  // Traversal bleibt 400 wie bisher.
  await assert.rejects(modulesSvc.resolveAssetPath('asset-mod', '../x.js'), (e) => e.status === 400);
});

// ── Loeschen ────────────────────────────────────────────────────────────────

test('DELETE /:id loescht Ordner und Disabled-Eintrag; danach 404', async () => {
  await postZip(makeZip(moduleFiles('delete-mod')));
  assert.equal(modulesSvc.isModuleDisabled('delete-mod'), true);
  const r = await call('DELETE', '/delete-mod');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { id: 'delete-mod', deleted: true });
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'delete-mod')));
  assert.equal(modulesSvc.isModuleDisabled('delete-mod'), false, 'eine spaetere Neuinstallation startet frisch');
  const again = await call('DELETE', '/delete-mod');
  assert.equal(again.status, 404);
  assert.equal(again.body.reason, 'not_found');
});

test('DELETE /:id: ungueltige id → 400, Symlink wird verweigert', async (t) => {
  const bad = await call('DELETE', '/Bad_ID');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'bad_id');

  const outside = path.join(TMP_ROOT, 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const link = path.join(MODULES_DIR, 'linked-mod');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (err) {
    t.skip(`Symlink nicht anlegbar: ${err.code}`);
    return;
  }
  const r = await call('DELETE', '/linked-mod');
  assert.equal(r.status, 400);
  assert.equal(r.body.reason, 'not_a_module');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'nichts hinter dem Link wurde geloescht');
  fs.unlinkSync(link);
});

// ── Schreibbarkeit, Sperre, Gates, Grenzen ──────────────────────────────────

test('nicht beschreibbar → info.writable=false und 503 not_writable', async () => {
  const restore = install.__setInstallFsOpsForTests({
    access: async () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
  });
  try {
    const info = await call('GET', '/install/info');
    assert.equal(info.status, 200);
    const { persistent, ...rest } = info.body.data;
    assert.deepEqual(rest, { writable: false, maxZipMb: 20 });
    // Der Wert selbst haengt vom Rechner ab (Container oder nicht); die Logik
    // pruefen die isPersistent-Tests am Ende mit injizierten /proc-Dateien.
    assert.ok([true, false, null].includes(persistent));
    const r = await postZip(makeZip(moduleFiles('ro-mod')));
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, 'not_writable');
    const del = await call('DELETE', '/replace-mod');
    assert.equal(del.status, 503);
  } finally {
    restore();
  }
  const ok = await call('GET', '/install/info');
  assert.equal(ok.body.data.writable, true);
});

test('gleichzeitige Installation → die zweite bekommt busy', async () => {
  const [a, b] = await Promise.allSettled([
    install.installFromZip(makeZip(moduleFiles('busy-a'))),
    install.installFromZip(makeZip(moduleFiles('busy-b'))),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.reason, 'busy');
  assert.equal(b.reason.status, 409);
});

test('Admin-Gate: Mitglieder bekommen 403 auf allen neuen Routen', async () => {
  assert.equal((await call('GET', '/install/info', { actor: MEM })).status, 403);
  assert.equal((await call('POST', '/install/zip', { actor: MEM, raw: makeZip(moduleFiles('member-mod')) })).status, 403);
  assert.equal((await call('POST', '/install/github', { actor: MEM, json: { url: 'owner/repo' } })).status, 403);
  assert.equal((await call('DELETE', '/busy-a', { actor: MEM })).status, 403);
  assert.ok(fs.existsSync(path.join(MODULES_DIR, 'busy-a')));
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'member-mod')));
});

test('leerer Body oder falscher Content-Type → 400 not_zip; Muell → not_zip', async () => {
  assert.equal((await call('POST', '/install/zip')).body.reason, 'not_zip');
  assert.equal((await call('POST', '/install/zip', { raw: 'hello', contentType: 'text/plain' })).body.reason, 'not_zip');
  const junk = await postZip(Buffer.from('definitely not a zip file, sorry'));
  assert.equal(junk.status, 400);
  assert.equal(junk.body.reason, 'not_zip');
});

test('mehr als 20 MB Body → 413 too_large mit der richtigen Grenze', async () => {
  const r = await postZip(Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal(r.status, 413);
  assert.equal(r.body.reason, 'too_large');
  assert.match(r.body.error, /\b20 MB\b/);
});

test('Rate-Limit: die elfte Installation in zehn Minuten → 429', async () => {
  const same = { id: 4242, role: 'admin' };
  for (let i = 0; i < 10; i += 1) {
    const r = await call('POST', '/install/zip', { actor: same, raw: 'x', contentType: 'text/plain' });
    assert.equal(r.status, 400);
  }
  const limited = await call('POST', '/install/github', { actor: same, json: { url: 'owner/repo' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 429);
  assert.equal(limited.body.reason, 'install_rate_limited', 'nicht dasselbe wie GitHubs rate_limited');
  // Ein anderer Admin ist davon nicht betroffen.
  assert.equal((await call('POST', '/install/zip', { raw: 'x', contentType: 'text/plain' })).status, 400);
});

test('veraltete Staging-Ordner werden aufgeraeumt, Sicherungen nicht', async () => {
  const stale = path.join(MODULES_DIR, '.install-stale');
  const backup = path.join(MODULES_DIR, '.backup-x-1');
  fs.mkdirSync(stale);
  fs.mkdirSync(backup);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(backup, old, old);
  await install.cleanupStaleStaging();
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(backup), 'eine Sicherung kann die letzte Kopie sein');
  fs.rmSync(backup, { recursive: true });
});

// ── GitHub ──────────────────────────────────────────────────────────────────

test('GitHub-URL-Parser: gueltige Formen', () => {
  const ok = [
    ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['  https://github.com/owner/repo/  ', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['https://www.github.com/owner/repo.git', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['https://github.com/owner/repo?tab=readme#top', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['owner/repo', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['owner/my.repo_x-1.git', { owner: 'owner', repo: 'my.repo_x-1', kind: 'repo' }],
    ['https://github.com/owner/repo/tree/main', { owner: 'owner', repo: 'repo', kind: 'tree', segments: ['main'] }],
    ['https://github.com/o/r/tree/feature/x/plugins/demo', { owner: 'o', repo: 'r', kind: 'tree', segments: ['feature', 'x', 'plugins', 'demo'] }],
    ['https://github.com/owner/repo/releases/tag/v1.2.3', { owner: 'owner', repo: 'repo', kind: 'tag', ref: 'v1.2.3' }],
    ['https://github.com/owner/repo/releases/latest', { owner: 'owner', repo: 'repo', kind: 'latest' }],
    // Ohne Schema, wie aus der Adresszeile kopiert.
    ['github.com/owner/repo', { owner: 'owner', repo: 'repo', kind: 'repo' }],
    ['www.github.com/owner/repo/tree/main/mods', { owner: 'owner', repo: 'repo', kind: 'tree', segments: ['main', 'mods'] }],
    ['GitHub.com/owner/repo/releases/latest', { owner: 'owner', repo: 'repo', kind: 'latest' }],
  ];
  for (const [input, expected] of ok) assert.deepEqual(github.parseGithubUrl(input), expected, input);
});

test('GitHub-URL-Parser: ungueltige Formen → bad_url', () => {
  for (const input of [
    '',
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://gist.github.com/owner/abc123',
    'https://github.com.evil.example/owner/repo',
    'https://github.com:8443/owner/repo',
    'https://user:pw@github.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/..',
    'https://github.com/owner/.',
    'owner/..',
    'https://github.com/-bad/repo',
    'https://github.com/owner/repo/blob/main/module.json',
    'https://github.com/owner/repo/releases',
    'file:///etc/passwd',
    'gitlab.com/owner/repo',
    'github.com.evil.example/owner/repo',
    'github.com/owner',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => github.parseGithubUrl(input), (e) => e.reason === 'bad_url', JSON.stringify(input));
  }
});

// Fake-Transport: Tabelle URL → Antwort; jede Anfrage wird mitgeschrieben.
function fakeResponse(status, { json, body, headers = {} } = {}) {
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : (body ?? Buffer.alloc(0));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    body: Readable.from(Array.isArray(payload) ? payload : [payload]),
    // Ein Stream laesst sich nur einmal lesen; der Fake baut die Antwort aus
    // dieser Beschreibung bei jedem Aufruf neu.
    spec: { status, json, body, headers },
  };
}

function fakeTransport(routes) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url, opts });
    const handler = routes[url];
    if (!handler) return fakeResponse(404, { json: { message: 'Not Found' } });
    if (typeof handler === 'function') return handler(url, opts);
    return fakeResponse(handler.spec.status, handler.spec);
  };
  return { request, calls };
}

const API = 'https://api.github.com/repos';

test('Ref-Aufloesung: neueste Release → tag_name; User-Agent und Accept gesendet', async () => {
  const t = fakeTransport({
    [`${API}/owner/repo/releases/latest`]: fakeResponse(200, { json: { tag_name: 'v2.0.0' } }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  const resolved = await gh.resolve('https://github.com/owner/repo');
  assert.deepEqual(resolved, { owner: 'owner', repo: 'repo', ref: 'v2.0.0', path: null }, 'null = kein Ordner genannt');
  const { headers, redirect, lookup } = t.calls[0].opts;
  assert.match(headers['User-Agent'], /^yuvomi\/\d+\.\d+\.\d+/);
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.equal(redirect, 'manual', 'Redirects folgt der Installer selbst');
  assert.equal(typeof lookup, 'function', 'der SSRF-Lookup reist mit');
});

test('Ref-Aufloesung: keine Release (404) → default_branch; kein Repo → repo_not_found', async () => {
  const t = fakeTransport({
    [`${API}/owner/repo`]: fakeResponse(200, { json: { default_branch: 'develop' } }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  assert.equal((await gh.resolve('owner/repo')).ref, 'develop');
  assert.equal((await gh.resolve('https://github.com/owner/repo/releases/latest')).ref, 'develop');
  await assert.rejects(gh.resolve('owner/missing'), (e) => e.reason === 'repo_not_found' && e.status === 404);
});

test('Ref-Aufloesung: release tag und explizite ref/path ueberschreiben', async () => {
  const t = fakeTransport({});
  const gh = github.createGithubInstaller({ request: t.request });
  assert.deepEqual(await gh.resolve('https://github.com/o/r/releases/tag/v1.0.0'), { owner: 'o', repo: 'r', ref: 'v1.0.0', path: null });
  assert.deepEqual(await gh.resolve('o/r', { ref: 'main', path: '/plugins/x/' }), { owner: 'o', repo: 'r', ref: 'main', path: 'plugins/x' });
  assert.deepEqual(await gh.resolve('https://github.com/o/r/tree/feature/x/mods/a', { ref: 'feature/x' }),
    { owner: 'o', repo: 'r', ref: 'feature/x', path: 'mods/a' });
  // Ein ausdruecklicher Pfad - auch der leere fuer die Wurzel - schlaegt den
  // Ordner der tree-URL: er kommt aus der Kandidatenliste genau dieses Archivs.
  assert.deepEqual(await gh.resolve('https://github.com/o/r/tree/feature/x/mods', { ref: 'feature/x', path: '' }),
    { owner: 'o', repo: 'r', ref: 'feature/x', path: '' });
  assert.deepEqual(await gh.resolve('https://github.com/o/r/tree/feature/x/mods', { ref: 'feature/x', path: 'mods/b' }),
    { owner: 'o', repo: 'r', ref: 'feature/x', path: 'mods/b' });
  // Der Pfad aus der URL wird genauso normalisiert wie ein uebergebener.
  assert.deepEqual(await gh.resolve('https://github.com/o/r/tree/main/mods/a/', { ref: 'main' }),
    { owner: 'o', repo: 'r', ref: 'main', path: 'mods/a' });
  assert.equal(t.calls.length, 0, 'eine bekannte ref braucht keine API-Abfrage');
  await assert.rejects(gh.resolve('o/r', { ref: '../x' }), (e) => e.reason === 'bad_url');
});

test('tree/<a>/<b>/<pfad>: kuerzeste existierende ref gewinnt, Rest ist der Pfad', async () => {
  const t = fakeTransport({
    [`${API}/o/r/commits/feature/x`]: fakeResponse(200, { json: { sha: 'f'.repeat(40) } }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  const resolved = await gh.resolve('https://github.com/o/r/tree/feature/x/plugins/example/module');
  assert.deepEqual(resolved, { owner: 'o', repo: 'r', ref: 'feature/x', path: 'plugins/example/module' });
  assert.deepEqual(t.calls.map((c) => c.url), [`${API}/o/r/commits/feature`, `${API}/o/r/commits/feature/x`]);

  const none = fakeTransport({});
  await assert.rejects(github.createGithubInstaller({ request: none.request }).resolve('https://github.com/o/r/tree/a/b/c/d'),
    (e) => e.reason === 'ref_not_found');
  assert.equal(none.calls.length, 3, 'hoechstens drei Kandidaten');
});

test('Redirect auf einen Host ausserhalb der Allowlist wird verweigert', async () => {
  const t = fakeTransport({
    [`${API}/o/r/zipball/main`]: fakeResponse(302, { headers: { location: 'https://codeload.github.com/o/r/legacy.zip/main' } }),
    'https://codeload.github.com/o/r/legacy.zip/main': fakeResponse(302, { headers: { location: 'https://evil.example/payload.zip' } }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  await assert.rejects(gh.fetchArchive('o/r', { ref: 'main' }), (e) => e.reason === 'github_failed' && /evil\.example/.test(e.message));
  assert.ok(!t.calls.some((c) => c.url.includes('evil.example')), 'der fremde Host wird nie angefragt');

  const downgrade = fakeTransport({
    [`${API}/o/r/zipball/main`]: fakeResponse(302, { headers: { location: 'http://codeload.github.com/x.zip' } }),
  });
  await assert.rejects(github.createGithubInstaller({ request: downgrade.request }).fetchArchive('o/r', { ref: 'main' }),
    (e) => e.reason === 'github_failed');
});

test('Rate-Limit von GitHub (403, remaining 0) → 429 rate_limited mit resetAt', async () => {
  const t = fakeTransport({
    [`${API}/o/r/releases/latest`]: fakeResponse(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } }),
  });
  await assert.rejects(github.createGithubInstaller({ request: t.request }).resolve('o/r'), (e) => {
    assert.equal(e.reason, 'rate_limited');
    assert.equal(e.status, 429);
    assert.equal(e.extra.resetAt, new Date(1900000000 * 1000).toISOString());
    return true;
  });
  const other = fakeTransport({ [`${API}/o/r/releases/latest`]: fakeResponse(500) });
  await assert.rejects(github.createGithubInstaller({ request: other.request }).resolve('o/r'),
    (e) => e.reason === 'github_failed' && e.status === 502);
});

test('Download ueber der Grenze → too_large (Content-Length und gestreamt)', async () => {
  const big = Buffer.alloc(2048);
  const declared = fakeTransport({ [`${API}/o/r/zipball/main`]: fakeResponse(200, { body: big, headers: { 'content-length': '2048' } }) });
  await assert.rejects(github.createGithubInstaller({ request: declared.request, maxBytes: 1024 }).fetchArchive('o/r', { ref: 'main' }),
    (e) => e.reason === 'too_large' && e.status === 413);
  const streamed = fakeTransport({
    [`${API}/o/r/zipball/main`]: () => fakeResponse(200, { body: [Buffer.alloc(600), Buffer.alloc(600)] }),
  });
  await assert.rejects(github.createGithubInstaller({ request: streamed.request, maxBytes: 1024 }).fetchArchive('o/r', { ref: 'main' }),
    (e) => e.reason === 'too_large');
});

test('Netzfehler und Timeout → github_failed, ohne die rohe Fehlermeldung', async () => {
  const gh = github.createGithubInstaller({ request: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); } });
  await assert.rejects(gh.fetchArchive('o/r', { ref: 'main' }), (e) => e.reason === 'github_failed' && /in time/.test(e.message));
  // Die Meldung des Transports (aufgeloeste Adressen, Urteil des SSRF-Guards)
  // gehoert ins Log, nicht in die Antwort.
  const net = github.createGithubInstaller({ request: async () => { throw new Error('getaddrinfo 10.0.0.7 blocked by SSRF guard'); } });
  await assert.rejects(net.fetchArchive('o/r', { ref: 'main' }), (e) => {
    assert.equal(e.reason, 'github_failed');
    assert.equal(e.message, 'Could not reach GitHub.');
    return true;
  });
});

test('Allowlist: nur api.github.com, github.com und codeload.github.com', async () => {
  assert.deepEqual([...github.ALLOWED_DOWNLOAD_HOSTS].sort(), ['api.github.com', 'codeload.github.com', 'github.com']);
  for (const host of ['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com']) {
    const t = fakeTransport({
      [`${API}/o/r/zipball/main`]: fakeResponse(302, { headers: { location: `https://${host}/x.zip` } }),
    });
    await assert.rejects(github.createGithubInstaller({ request: t.request }).fetchArchive('o/r', { ref: 'main' }),
      (e) => e.reason === 'github_failed', host);
    assert.ok(!t.calls.some((c) => c.url.includes(host)), `${host} wird nie angefragt`);
  }
});

test('POST /install/github Ende-zu-Ende: Redirect auf codeload, Pfad aus tree-URL, Commit aus ZIP-Kommentar', async () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const zip = makeZip({
    ...moduleFiles('gh-mod', { prefix: 'o-r-abcdef0/plugins/gh/', version: '0.3.0' }),
    ...moduleFiles('gh-other', { prefix: 'o-r-abcdef0/plugins/other/' }),
  }, { comment: sha });
  const t = fakeTransport({
    [`${API}/o/r/commits/main`]: fakeResponse(200, { json: { sha } }),
    [`${API}/o/r/zipball/main`]: fakeResponse(302, { headers: { location: 'https://codeload.github.com/o/r/legacy.zip/refs/heads/main' } }),
    'https://codeload.github.com/o/r/legacy.zip/refs/heads/main': () => fakeResponse(200, { body: zip }),
  });
  github.__setGithubRequestForTests(t.request);
  try {
    const r = await call('POST', '/install/github', { json: { url: 'https://github.com/o/r/tree/main/plugins/gh' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.id, 'gh-mod');
    assert.equal(r.body.data.enabled, false);
    assert.deepEqual(r.body.data.install, {
      source: 'github', url: 'https://github.com/o/r', ref: 'main', commit: sha, path: 'plugins/gh',
      installedAt: r.body.data.install.installedAt,
    });
    // Ohne path: zwei Module im Repo → 422 mit Kandidaten.
    const t2 = fakeTransport({
      [`${API}/o/r/releases/latest`]: fakeResponse(200, { json: { tag_name: 'main' } }),
      [`${API}/o/r/zipball/main`]: () => fakeResponse(200, { body: zip }),
    });
    github.__setGithubRequestForTests(t2.request);
    const multi = await call('POST', '/install/github', { json: { url: 'o/r' } });
    assert.equal(multi.status, 422);
    assert.deepEqual(multi.body.candidates.map((c) => c.path), ['plugins/gh', 'plugins/other']);
    const exists = await call('POST', '/install/github', { json: { url: 'o/r', path: 'plugins/gh' } });
    assert.equal(exists.status, 409);
    assert.equal(exists.body.existing.id, 'gh-mod');
    assert.equal(exists.body.existing.name, 'Mod gh-mod');
    assert.equal(exists.body.existing.version, '0.3.0');
    assert.equal(exists.body.existing.install.url, 'https://github.com/o/r');
    assert.equal(exists.body.existing.install.path, 'plugins/gh');
    assert.equal(exists.body.sourceChanged, false, 'dasselbe Repo, derselbe Ordner');
    assert.equal(exists.body.replaceDisabledReason, null, 'ein Update aus derselben Quelle behaelt den Schalter');
    await modulesSvc.setModuleEnabled('gh-mod', true);
    const replaced = await call('POST', '/install/github', { json: { url: 'o/r', path: 'plugins/gh', overwrite: true } });
    assert.equal(replaced.status, 201);
    assert.equal(replaced.body.replaced, true);
    assert.equal(replaced.body.data.enabled, true, 'Update aus derselben Quelle behaelt den Schalter');
    assert.equal(replaced.body.disabledForReview, false);
    assert.equal(replaced.body.disabledReason, null);
    // Der andere Kandidat ist ein eigenes Modul mit eigener Kennung: neu.
    const other = await call('POST', '/install/github', { json: { url: 'o/r', path: 'plugins/other' } });
    assert.equal(other.status, 201, 'gh-other ist eine andere Kennung, also neu');
    // Fehler-Formen ueber die Route.
    assert.equal((await call('POST', '/install/github', { json: {} })).body.reason, 'bad_url');
    const bad = await call('POST', '/install/github', { json: { url: 'https://gitlab.com/o/r' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.reason, 'bad_url');
    assert.equal(bad.body.code, 400);
  } finally {
    github.__setGithubRequestForTests(null);
  }
});

test('POST /install/github haelt die Sperre waehrend des Downloads: parallele Installation → 409 busy', async () => {
  let release;
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const zip = makeZip(moduleFiles('slow-mod'));
  github.__setGithubRequestForTests(async (url) => {
    if (url.endsWith('/zipball/main')) {
      entered();
      await gate;
      return fakeResponse(200, { body: zip });
    }
    return fakeResponse(404);
  });
  try {
    const first = call('POST', '/install/github', { json: { url: 'o/slow', ref: 'main' } });
    await enteredP;
    const second = await postZip(makeZip(moduleFiles('other-mod')));
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'busy');
    release();
    assert.equal((await first).status, 201);
  } finally {
    github.__setGithubRequestForTests(null);
  }
});

// ── Review Runde 1 ──────────────────────────────────────────────────────────

test('nur aus einer Browser-Sitzung: Token und Display → 403 module_session_required, vor Body und Limit', async () => {
  const tokenAdmin = { id: 7777, role: 'admin', method: 'api_token' };
  const zip = makeZip(moduleFiles('token-mod'));
  for (const method of ['api_token', 'display']) {
    const a = { ...tokenAdmin, method };
    const z = await call('POST', '/install/zip', { actor: a, raw: zip });
    assert.equal(z.status, 403);
    assert.equal(z.body.reason, 'module_session_required');
    const g = await call('POST', '/install/github', { actor: a, json: { url: 'o/r' } });
    assert.equal(g.body.reason, 'module_session_required');
    const d = await call('DELETE', '/busy-a', { actor: a });
    assert.equal(d.status, 403);
    assert.equal(d.body.reason, 'module_session_required');
  }
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'token-mod')));
  assert.ok(fs.existsSync(path.join(MODULES_DIR, 'busy-a')), 'nichts geloescht');
  // Abgewiesene Token-Anfragen verbrauchen das Install-Limit nicht: die Sperre
  // steht vor dem Limiter.
  for (let i = 0; i < 11; i += 1) await call('POST', '/install/zip', { actor: tokenAdmin, raw: 'x', contentType: 'text/plain' });
  const browser = await call('POST', '/install/zip', { actor: { id: 7777, role: 'admin' }, raw: 'x', contentType: 'text/plain' });
  assert.equal(browser.status, 400, 'derselbe Nutzer im Browser ist nicht gedrosselt');
  // Lesen und Schalten bleiben fuer Tokens offen.
  assert.equal((await call('GET', '/install/info', { actor: tokenAdmin })).status, 200);
});

test('Ersetzen aus einer anderen Quelle schaltet das Modul wieder aus', async () => {
  // Erst per ZIP, eingeschaltet.
  assert.equal((await postZip(makeZip(moduleFiles('src-mod', { version: '1.0.0' })))).status, 201);
  await modulesSvc.setModuleEnabled('src-mod', true);
  const ghZip = makeZip(moduleFiles('src-mod', { prefix: 'o-src-1/', version: '2.0.0' }));
  github.__setGithubRequestForTests(async (url) => (url.endsWith('/zipball/main')
    ? fakeResponse(200, { body: ghZip })
    : fakeResponse(404)));
  try {
    const ask = await call('POST', '/install/github', { json: { url: 'o/src', ref: 'main' } });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.sourceChanged, true, 'ZIP → GitHub ist eine andere Quelle');
    assert.equal(ask.body.replaceDisabledReason, 'source_changed');
    const r = await call('POST', '/install/github', { json: { url: 'o/src', ref: 'main', overwrite: true } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.replaced, true);
    assert.equal(r.body.disabledForReview, true);
    assert.equal(r.body.disabledReason, 'source_changed');
    assert.equal(r.body.data.enabled, false, 'neuer Code unter vertrauter Kennung startet aus');
    // Dasselbe Repo noch einmal: gleiche Quelle, der (jetzt ausgeschaltete)
    // Zustand bleibt, und es ist kein "wegen Quelle ausgeschaltet".
    await modulesSvc.setModuleEnabled('src-mod', true);
    const again = await call('POST', '/install/github', { json: { url: 'https://github.com/O/SRC', ref: 'main', overwrite: true } });
    assert.equal(again.status, 201);
    assert.equal(again.body.disabledForReview, false, 'Gross/Klein im Repo-Namen ist dieselbe Quelle');
    assert.equal(again.body.data.enabled, true);
    // Ein anderes Repo unter derselben Kennung: GitHub → GitHub, aber andere Quelle.
    const other = await call('POST', '/install/github', { json: { url: 'o/fork', ref: 'main', overwrite: true } });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(other.body.disabledForReview, true);
    assert.equal(other.body.disabledReason, 'source_changed');
    assert.equal(other.body.data.enabled, false, 'ein anderes Repo ist neuer Code');
  } finally {
    github.__setGithubRequestForTests(null);
  }
  // Ein bereits ausgeschaltetes Modul: Quelle wechselt, es bleibt aus, und die
  // Antwort nennt den Grund trotzdem - der neue Code wartet auf Pruefung.
  await modulesSvc.setModuleEnabled('src-mod', false);
  const off = await postZip(makeZip(moduleFiles('src-mod', { version: '3.0.0' })), '?overwrite=1');
  assert.equal(off.body.disabledForReview, true);
  assert.equal(off.body.disabledReason, 'source_changed', 'GitHub → ZIP: die Quelle geht vor');
  assert.equal(off.body.data.enabled, false);

  // Von Hand kopiert (keine Metadaten) → jede Installation darueber ist eine
  // andere Quelle.
  const dir = path.join(MODULES_DIR, 'hand-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ id: 'hand-mod', entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  await modulesSvc.setModuleEnabled('hand-mod', true);
  const hand = await postZip(makeZip(moduleFiles('hand-mod')), '?overwrite=1');
  assert.equal(hand.body.disabledForReview, true);
  assert.equal(hand.body.disabledReason, 'source_changed');
  assert.equal(hand.body.data.enabled, false);

  // Scheitert der Tausch, kommt auch der Schalter zurueck.
  await modulesSvc.setModuleEnabled('hand-mod', true);
  fs.rmSync(path.join(dir, '.yuvomi-install.json'));
  const restore = install.__setInstallFsOpsForTests({
    rename: async (from, to) => {
      if (path.basename(path.dirname(from)).startsWith('.install-')) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      return fs.promises.rename(from, to);
    },
  });
  try {
    await assert.rejects(install.installFromZip(makeZip(moduleFiles('hand-mod')), { overwrite: true }), /EIO/);
  } finally {
    restore();
  }
  assert.equal(modulesSvc.isModuleDisabled('hand-mod'), false, 'der alte Schalter steht wieder');
});

test('isSameInstallSource: Tabelle', () => {
  const same = install.isSameInstallSource;
  assert.equal(same({ source: 'zip' }, { source: 'zip' }), true);
  assert.equal(same(null, { source: 'zip' }), false, 'ohne Metadaten: unbekannte Herkunft');
  assert.equal(same({ source: 'github', url: 'https://github.com/o/r' }, { source: 'zip' }), false);
  assert.equal(same({ source: 'github', url: 'https://github.com/o/r', path: null }, { source: 'github', url: 'https://github.com/O/r/' }), true);
  assert.equal(same({ source: 'github', url: 'https://github.com/o/r', path: 'a' }, { source: 'github', url: 'https://github.com/o/r', path: 'b' }), false);
  assert.equal(same({ source: 'github', url: 'https://github.com/o/r' }, { source: 'github', url: 'https://github.com/o/other' }), false);
});

test('path="" waehlt das Modul an der Wurzel, neben einem verschachtelten (ZIP und GitHub)', async () => {
  const zip = makeZip({
    ...moduleFiles('root-cand', { prefix: 'repo-1/' }),
    ...moduleFiles('nested-cand', { prefix: 'repo-1/sub/x/' }),
  });
  const multi = await postZip(zip);
  assert.equal(multi.status, 422);
  assert.deepEqual(multi.body.candidates.map((c) => c.path).sort(), ['', 'sub/x']);
  const root = await postZip(zip, '?path=');
  assert.equal(root.status, 201, JSON.stringify(root.body));
  assert.equal(root.body.data.id, 'root-cand', 'leerer path ist eine Wahl, kein "nicht angegeben"');
  const nested = await postZip(zip, '?path=sub/x');
  assert.equal(nested.body.data.id, 'nested-cand');

  github.__setGithubRequestForTests(async (url) => (url.endsWith('/zipball/main') ? fakeResponse(200, { body: zip }) : fakeResponse(404)));
  try {
    const ghMulti = await call('POST', '/install/github', { json: { url: 'o/two', ref: 'main' } });
    assert.equal(ghMulti.status, 422);
    const ghRoot = await call('POST', '/install/github', { json: { url: 'o/two', ref: 'main', path: '', overwrite: true } });
    assert.equal(ghRoot.status, 201, JSON.stringify(ghRoot.body));
    assert.equal(ghRoot.body.data.id, 'root-cand');
  } finally {
    github.__setGithubRequestForTests(null);
  }
});

test('path auf einen Elternordner mit mehreren Modulen → 422 multiple mit genau denen darunter', async () => {
  const zip = makeZip({
    ...moduleFiles('parent-a', { prefix: 'repo-2/mods/a/' }),
    ...moduleFiles('parent-b', { prefix: 'repo-2/mods/b/' }),
    ...moduleFiles('parent-c', { prefix: 'repo-2/other/c/' }),
    'repo-2/empty/README.md': 'x',
  });
  const r = await postZip(zip, '?path=mods');
  assert.equal(r.status, 422);
  assert.equal(r.body.reason, 'multiple');
  assert.deepEqual(r.body.candidates.map((c) => c.path), ['mods/a', 'mods/b']);
  const none = await postZip(zip, '?path=empty');
  assert.equal(none.status, 400);
  assert.equal(none.body.reason, 'path_not_found', 'nichts darunter: weiter path_not_found');
});

test('GET /: install nur in der Admin-Liste (?admin=1 als Admin)', async () => {
  assert.equal((await postZip(makeZip(moduleFiles('list-mod')))).status, 201);
  await modulesSvc.setModuleEnabled('list-mod', true);
  const member = await call('GET', '/', { actor: MEM });
  const seen = member.body.data.find((m) => m.id === 'list-mod');
  assert.ok(seen, 'das eingeschaltete Modul ist fuer Mitglieder sichtbar');
  assert.ok(!('install' in seen), 'aber ohne Herkunft');
  const adminPlain = await call('GET', '/');
  assert.ok(!('install' in adminPlain.body.data.find((m) => m.id === 'list-mod')), 'ohne ?admin=1 auch fuer Admins nicht');
  const adminList = await call('GET', '/?admin=1');
  assert.equal(adminList.body.data.find((m) => m.id === 'list-mod').install.source, 'zip');
  const memberAdmin = await call('GET', '/?admin=1', { actor: MEM });
  assert.ok(!('install' in memberAdmin.body.data.find((m) => m.id === 'list-mod')), '?admin=1 als Mitglied zaehlt nicht');
});

test('fremdes Content-Encoding → 415 unsupported_encoding', async () => {
  actor = admin();
  const res = await fetch(`${baseUrl}/install/zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Content-Encoding': 'x-unknown' },
    body: makeZip(moduleFiles('enc-mod')),
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.reason, 'unsupported_encoding');
  assert.equal(body.code, 415);
});

test('ein Name, den das Dateisystem nicht schreiben kann → 400 unsafe_path statt 500', async () => {
  for (const code of ['EEXIST', 'ENOENT', 'EINVAL', 'ENAMETOOLONG']) {
    const restore = install.__setInstallFsOpsForTests({
      writeFile: async () => { throw Object.assign(new Error(`simulated ${code}`), { code }); },
    });
    try {
      const r = await postZip(makeZip(moduleFiles('fsname-mod')));
      assert.equal(r.status, 400, code);
      assert.equal(r.body.reason, 'unsafe_path', code);
    } finally {
      restore();
    }
  }
  assert.deepEqual(stagingLeftovers(), []);
  assert.ok(!fs.existsSync(path.join(MODULES_DIR, 'fsname-mod')));
});

// ── Persistenz (isPersistent) ───────────────────────────────────────────────
// Die /proc-Dateien sind injiziert; so laeuft dieselbe Tabelle unter Windows,
// in einem Container und auf einem Linux-Host.

const PROC_DIR = path.join(TMP_ROOT, 'proc');
fs.mkdirSync(PROC_DIR, { recursive: true });
const MARKER = path.join(PROC_DIR, 'dockerenv');
fs.writeFileSync(MARKER, '');
const NO_FILE = path.join(PROC_DIR, 'does-not-exist');

function mountinfo(...mounts) {
  return mounts.map(([mp, type], i) => `${100 + i} 1 0:${i} / ${mp} rw,relatime - ${type} none rw`).join('\n') + '\n';
}

async function probe(overrides, text) {
  const file = path.join(PROC_DIR, `mountinfo-${Math.random().toString(36).slice(2)}`);
  if (text !== undefined) fs.writeFileSync(file, text);
  const restore = install.__setPersistenceProbeForTests({
    platform: 'linux',
    containerMarkers: [MARKER],
    cgroupPath: NO_FILE,
    mountinfoPath: text === undefined ? NO_FILE : file,
    modulesDir: '/app/modules',
    realpath: async (p) => p,
    ...overrides,
  });
  try {
    return await install.isPersistent();
  } finally {
    restore();
  }
}

test('isPersistent: Volume auf dem Modulordner, nur Root-Overlay, Volume weiter oben, unlesbar, kein Container', async () => {
  const root = ['/', 'overlay'];
  assert.equal(await probe({}, mountinfo(root, ['/app/modules', 'ext4'], ['/etc/hosts', 'ext4'])), true, 'Volume genau auf dem Ordner');
  assert.equal(await probe({}, mountinfo(root, ['/etc/hosts', 'ext4'], ['/data', 'ext4'])), false, 'nur das Root-Overlay (Umbrel)');
  assert.equal(await probe({}, mountinfo(root, ['/app', 'ext4'])), true, 'unter einem Volume weiter oben');
  assert.equal(await probe({}, mountinfo(root, ['/app/modules-old', 'ext4'])), false, 'ein Praefix-Nachbar zaehlt nicht');
  assert.equal(await probe({ modulesDir: '/srv/my modules' }, mountinfo(root, ['/srv/my\\040modules', 'ext4'])), true, 'Leerzeichen als \\040');
  assert.equal(await probe({}, undefined), null, 'mountinfo unlesbar → unbekannt');
  assert.equal(await probe({}, ''), null, 'leer → unbekannt');
  // Kein Container: kein Marker, cgroup ohne Hinweis, Root ist kein Overlay.
  const cgroup = path.join(PROC_DIR, 'cgroup-host');
  fs.writeFileSync(cgroup, '0::/user.slice/user-1000.slice\n');
  assert.equal(await probe({ containerMarkers: [NO_FILE], cgroupPath: cgroup }, mountinfo(['/', 'ext4'])), true, 'Host');
  assert.equal(await probe({ containerMarkers: [NO_FILE], cgroupPath: NO_FILE }, undefined), true, 'Linux ohne /proc-Hinweis');
  assert.equal(await probe({ platform: 'win32' }, mountinfo(root)), true, 'nicht Linux');
  // Container nur am cgroup-Eintrag oder am Overlay-Root erkannt.
  const cgroupDocker = path.join(PROC_DIR, 'cgroup-docker');
  fs.writeFileSync(cgroupDocker, '12:pids:/docker/0123abcd\n');
  assert.equal(await probe({ containerMarkers: [NO_FILE], cgroupPath: cgroupDocker }, mountinfo(['/', 'ext4'])), false);
  assert.equal(await probe({ containerMarkers: [NO_FILE] }, mountinfo(root)), false, 'cgroup v2 ohne Namen: Overlay-Root');
  // realpath folgt einem Link auf ein Volume.
  assert.equal(await probe({ realpath: async () => '/data/modules' }, mountinfo(root, ['/data', 'ext4'])), true);
  // Wirft nie, auch wenn realpath wirft.
  assert.equal(await probe({ realpath: async () => { throw new Error('ENOENT'); } }, mountinfo(root)), false);
});

test('parseMountinfo: Mountpunkt und Dateisystemtyp, optionale Felder, Escapes', () => {
  const text = '36 35 98:0 /mnt1 /mnt\\040two rw,noatime master:1 shared:2 - ext3 /dev/root rw,errors=continue\n'
    + 'kaputte zeile ohne trenner\n'
    + '1 0 0:1 / / rw - overlay overlay rw\n';
  assert.deepEqual(install.parseMountinfo(text), [
    { mountPoint: '/mnt two', fsType: 'ext3' },
    { mountPoint: '/', fsType: 'overlay' },
  ]);
});

// ── Review Runde 2 ──────────────────────────────────────────────────────────

test('replaceDisabledReason: Tabelle (R3)', () => {
  const why = install.replaceDisabledReason;
  const gh = { source: 'github', url: 'https://github.com/o/r', path: 'mods/a' };
  assert.equal(why(gh, { ...gh, url: 'https://github.com/O/R/' }), null, 'dasselbe Repo und derselbe Ordner behalten den Schalter');
  assert.equal(why(gh, { ...gh, path: 'mods/b' }), 'source_changed');
  assert.equal(why(gh, { source: 'zip' }), 'source_changed', 'GitHub → ZIP: die Quelle geht vor');
  assert.equal(why({ source: 'zip' }, { source: 'zip' }), 'zip_replace', 'ZIP ueber ZIP ist nie "dasselbe"');
  assert.equal(why(null, gh), 'source_changed', 'von Hand kopiert');
});

test('tree-URL: die Ref-Probe fragt nur nach der SHA und liest keinen Rumpf (R1)', async () => {
  const huge = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const sha = Buffer.from('f'.repeat(40));
  const t = fakeTransport({
    // Mit dem vollen Commit-Medientyp antwortet GitHub mit Megabytes (Diff);
    // ueber der JSON-Grenze hiess das bisher "Archiv zu gross".
    [`${API}/o/r/commits/feature/x`]: (_url, opts) => fakeResponse(200, {
      body: opts.headers.Accept === 'application/vnd.github.sha' ? sha : huge,
    }),
    // 422: kein gueltiger Ref-Name - wie 404 der naechste Kandidat.
    [`${API}/o/r/commits/feature`]: fakeResponse(422, { json: { message: 'No commit found for SHA: feature' } }),
  });
  const resolved = await github.createGithubInstaller({ request: t.request }).resolve('https://github.com/o/r/tree/feature/x/mods/a');
  assert.deepEqual(resolved, { owner: 'o', repo: 'r', ref: 'feature/x', path: 'mods/a' });
  assert.ok(t.calls.every((c) => c.opts.headers.Accept === 'application/vnd.github.sha'), 'jede Probe fragt nur die SHA');

  // Selbst ein riesiger Rumpf mit dem SHA-Typ wird nicht gelesen: 2xx genuegt.
  const big = fakeTransport({
    [`${API}/o/r/commits/main`]: () => fakeResponse(200, { body: huge, headers: { 'content-length': String(huge.length) } }),
  });
  assert.equal((await github.createGithubInstaller({ request: big.request }).resolve('https://github.com/o/r/tree/main/x')).ref, 'main');

  // Alles andere ist github_failed, nie too_large.
  const broken = fakeTransport({ [`${API}/o/r/commits/main`]: fakeResponse(500) });
  await assert.rejects(github.createGithubInstaller({ request: broken.request }).resolve('https://github.com/o/r/tree/main/x'),
    (e) => e.reason === 'github_failed' && e.status === 502);
});

test('releases/latest mit unbrauchbarem tag_name → Fehler statt still der Standardzweig (R7)', async () => {
  const t = fakeTransport({
    [`${API}/o/r/releases/latest`]: fakeResponse(200, { json: { tag_name: 'v1 beta/../x' } }),
    [`${API}/o/r`]: fakeResponse(200, { json: { default_branch: 'main' } }),
  });
  await assert.rejects(github.createGithubInstaller({ request: t.request }).resolve('o/r'),
    (e) => e.reason === 'ref_not_found' && /tag or tree URL/.test(e.message));
  assert.ok(!t.calls.some((c) => c.url === `${API}/o/r`), 'der Standardzweig wird gar nicht erst gefragt');
  const missing = fakeTransport({ [`${API}/o/r/releases/latest`]: fakeResponse(200, { json: { name: 'no tag' } }) });
  await assert.rejects(github.createGithubInstaller({ request: missing.request }).resolve('o/r'), (e) => e.reason === 'ref_not_found');
});

test('Kandidaten-Tiefe zaehlt unter dem abgestreiften Oberordner: 6 gilt, 7 nicht (R8)', async () => {
  const six = makeZip(moduleFiles('depth-six', { prefix: 'o-r-1a2b/1/2/3/4/5/6/' }));
  const r = await postZip(six);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.install.path, '1/2/3/4/5/6');
  const seven = makeZip(moduleFiles('depth-seven', { prefix: 'o-r-1a2b/1/2/3/4/5/6/7/' }));
  const s = await postZip(seven);
  assert.equal(s.status, 400);
  assert.equal(s.body.reason, 'no_manifest', 'sieben Ordner tief wird nicht gesucht');
});

test('Wurzelmodul mit verschachteltem Modul darunter: dessen Ordner kommt nicht mit (E3)', async () => {
  const zip = makeZip({
    ...moduleFiles('outer-mod', { prefix: 'repo-3/', extra: { 'plugins/readme.md': 'kept', 'plugins/shared.js': 'kept' } }),
    ...moduleFiles('inner-mod', { prefix: 'repo-3/plugins/x/module/', extra: { 'inner.css': '.x{}' } }),
    // Zu tief, um angeboten zu werden - und trotzdem ein anderes Modul.
    'repo-3/a/b/c/d/e/f/g/module.json': '{"id":"deep-mod","entry":"i.js"}',
    'repo-3/a/b/c/d/e/f/g/i.js': '',
  });
  const r = await postZip(zip, '?path=');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'outer-mod');
  const dir = path.join(MODULES_DIR, 'outer-mod');
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'readme.md')), 'was zum Wurzelmodul gehoert, bleibt');
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'shared.js')));
  assert.ok(!fs.existsSync(path.join(dir, 'plugins', 'x')), 'das andere Modul wird nicht mitkopiert');
  assert.ok(!fs.existsSync(path.join(dir, 'a')), 'auch nicht eines, das zu tief zum Anbieten liegt');
  assert.ok(!r.body.skipped.some((p) => p.startsWith('plugins/x/')), 'ein anderes Modul ist nicht "uebersprungen"');
});

test('Install-Limit: 409 exists und 422 multiple zaehlen nicht, Fehlversuche schon (R4)', async () => {
  const same = { id: 5151, role: 'admin' };
  const first = await call('POST', '/install/zip', { actor: same, raw: makeZip(moduleFiles('limit-mod')) });
  assert.equal(first.status, 201);
  const again = makeZip(moduleFiles('limit-mod'));
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await call('POST', '/install/zip', { actor: same, raw: again })).status, 409);
  }
  const multi = makeZip({ ...moduleFiles('lim-a', { prefix: 'r/a/' }), ...moduleFiles('lim-b', { prefix: 'r/b/' }) });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call('POST', '/install/zip', { actor: same, raw: multi })).status, 422);
  }
  // Gezaehlt bisher: die eine Installation. Neun Fehlversuche fuellen das Limit.
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await call('POST', '/install/zip', { actor: same, raw: 'x', contentType: 'text/plain' })).status, 400);
  }
  const limited = await call('POST', '/install/zip', { actor: same, raw: again });
  assert.equal(limited.status, 429, 'Fehlversuche (400) zaehlen weiter');
  assert.equal(limited.body.reason, 'install_rate_limited');
});
