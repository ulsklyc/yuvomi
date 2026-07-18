/**
 * Test: Backup-/Restore-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - die untertestete Routen-Schicht von
 *        server/routes/backup.js. Die dahinterliegenden Services sind separat
 *        abgedeckt (test:backup-scheduler, test:backup-webdav, test:db); hier geht
 *        es um die Handler selbst: das requireAdmin-Gate auf jeder Route
 *        (kein Bypass), Validierung (400), das Größenlimit (413), den echten
 *        Backup->Restore-Roundtrip sowie die WebDAV-Konfig-Validierung/Persistenz.
 *
 *        Zwei bewusste Abweichungen vom :memory:-Standardmuster, weil Backup/Restore
 *        inhärent dateibasiert sind:
 *          - DB_PATH zeigt auf eine isolierte Temp-Datei (restoreFromFile schreibt
 *            fs.copyFile(src, DB_PATH); :memory: wäre eine Datei namens ":memory:").
 *          - WebDAV-Ziele sind ein IN-PROCESS Loopback-Stub (kein externes Netz),
 *            der PROPFIND->207 / PUT->201 beantwortet; die Fehlerpfade (unkonfiguriert)
 *            decken die catch-Zweige ohne Netz ab.
 * Ausführen: node --experimental-sqlite --test test/test-backup-routes.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

// ── Isolierte Temp-Umgebung VOR den dynamischen Imports einrichten ──────────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-backup-routes-'));
const DB_DIR = path.join(TMP_ROOT, 'db');
const BACKUP_DIR = path.join(TMP_ROOT, 'backups');
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = path.join(DB_DIR, 'oikos.db');
process.env.BACKUP_DIR = BACKUP_DIR;
// Klein genug, dass ein >4mb-Upload zuverlässig 413 auslöst, groß genug für ein
// echtes Schema-Backup (deutlich < 4mb).
process.env.BACKUP_UPLOAD_LIMIT = '4mb';
// Sicherstellen, dass keine echte WebDAV-Env die DB-getriebene Konfig überschreibt.
for (const k of ['WEBDAV_BACKUP_ENABLED', 'WEBDAV_BACKUP_URL', 'WEBDAV_BACKUP_USERNAME',
  'WEBDAV_BACKUP_PASSWORD', 'WEBDAV_BACKUP_PATH', 'WEBDAV_BACKUP_KEEP']) {
  delete process.env[k];
}

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: backupRouter } = await import('../server/routes/backup.js');
const database = () => dbmod.get(); // frisch lesen: restore re-initialisiert das Singleton

// ── Loopback-WebDAV-Stub (in-process, kein externes Netz) ───────────────────────
const REMOTE_FILE = 'yuvomi-backup-2026-01-01T00-00-00-000Z.db';
const davSeen = []; // Methoden-Log für Assertions
const davServer = http.createServer((req, res) => {
  davSeen.push(req.method);
  // Body vollständig lesen (PUT-Uploads), dann antworten.
  req.resume();
  req.on('end', () => {
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0"?>`
        + `<D:multistatus xmlns:D="DAV:">`
        + `<D:response><D:href>/backups/${REMOTE_FILE}</D:href>`
        + `<D:propstat><D:prop><D:resourcetype/>`
        + `<D:getlastmodified>Wed, 01 Jan 2026 00:00:00 GMT</D:getlastmodified>`
        + `</D:prop></D:propstat></D:response>`
        + `</D:multistatus>`,
      );
      return;
    }
    if (req.method === 'PUT' || req.method === 'MKCOL') { res.writeHead(201); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(200); res.end();
  });
});
const davBase = await new Promise((r) => davServer.listen(0, '127.0.0.1', () => {
  r(`http://127.0.0.1:${davServer.address().port}`);
}));

// ── App mit injizierter Auth (actor zur Request-Zeit gelesen) ───────────────────
let actor = { id: 1, role: 'admin' };
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', backupRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

const ADM = { id: 1, role: 'admin' };
const MEM = { id: 2, role: 'member' };

async function call(method, route, { actor: a, body, raw, contentType } = {}) {
  if (a) actor = a;
  const headers = {};
  let payload;
  if (raw !== undefined) {
    headers['Content-Type'] = contentType || 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* leer */ } }
  return { status: res.status, body: json, buf, contentType: ct };
}

test.after(() => {
  server.close();
  davServer.close();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Auth-Gate: kein Admin-Bypass ────────────────────────────────────────────────
test('requireAdmin: Nicht-Admin bekommt 403 auf allen Routen', async () => {
  const routes = [
    ['GET', '/status'],
    ['GET', '/database'],
    ['POST', '/trigger'],
    ['GET', '/webdav/config'],
    ['PUT', '/webdav/config'],
    ['POST', '/webdav/test'],
    ['GET', '/webdav/files'],
    ['POST', '/webdav/trigger'],
  ];
  for (const [method, route] of routes) {
    const r = await call(method, route, { actor: MEM });
    assert.equal(r.status, 403, `${method} ${route} muss für Nicht-Admin 403 liefern`);
  }
  // /restore ebenfalls (raw-Body-Route)
  const rr = await call('POST', '/restore', { actor: MEM, raw: Buffer.from('x') });
  assert.equal(rr.status, 403, 'POST /restore muss für Nicht-Admin 403 liefern');
});

// ── GET /status ─────────────────────────────────────────────────────────────────
test('GET /status: liefert Schema-Version, Upload-Limit und Scheduler-Status', async () => {
  const r = await call('GET', '/status', { actor: ADM });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.schema_version, dbmod.currentVersion());
  assert.ok(d.schema_version > 0, 'Migrationen sind gelaufen');
  assert.equal(d.restore_upload_limit, '4mb');
  assert.ok(d.scheduler, 'scheduler-Objekt vorhanden');
  assert.equal(d.scheduler.backupDir, BACKUP_DIR);
  assert.ok(d.scheduler.webdav, 'scheduler.webdav-Status eingebettet');
});

// ── POST /trigger: echter lokaler Backup (WebDAV noch aus) ──────────────────────
test('POST /trigger: erzeugt eine echte lokale Backup-Datei in BACKUP_DIR', async () => {
  const before = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
  const r = await call('POST', '/trigger', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.success, true);
  assert.ok(r.body.data.file.endsWith('.db'), 'Dateiname des Backups zurückgegeben');
  const after = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
  assert.ok(after.length > before.length, 'neue Backup-Datei liegt physisch vor');
  // Inhalt der GENAU zurückgemeldeten Datei ist eine gültige SQLite-Datei
  // (nicht readdir-Reihenfolge-abhängig).
  const created = path.join(BACKUP_DIR, r.body.data.file);
  assert.ok(after.includes(r.body.data.file), 'zurückgemeldete Datei liegt physisch vor');
  const magic = fs.readFileSync(created).subarray(0, 16).toString('latin1');
  assert.ok(magic.startsWith('SQLite format 3'), 'lokales Backup ist eine SQLite-Datei');
});

// ── GET /database: Download eines validen Backups ───────────────────────────────
test('GET /database: lädt eine valide SQLite-Backup-Datei herunter', async () => {
  const r = await call('GET', '/database', { actor: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.buf.length > 0, 'Body nicht leer');
  assert.equal(r.buf.subarray(0, 16).toString('latin1').startsWith('SQLite format 3'), true);
  // Muss eine echte Yuvomi-DB sein (schema_migrations vorhanden) → für den späteren
  // Restore-Roundtrip wiederverwendbar.
  assert.ok(r.buf.length < 4 * 1024 * 1024, 'Schema-Backup liegt unter dem 4mb-Limit');
});

// ── POST /restore: Validierung (fasst die Live-DB NICHT an) ──────────────────────
test('POST /restore: leerer Body → 400', async () => {
  const r = await call('POST', '/restore', { actor: ADM, raw: Buffer.alloc(0) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /required/i);
});

test('POST /restore: kein gültiges SQLite → 400, Live-DB unangetastet', async () => {
  const versionBefore = dbmod.currentVersion();
  const r = await call('POST', '/restore', { actor: ADM, raw: Buffer.from('das ist keine datenbank') });
  assert.equal(r.status, 400);
  assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
  // Live-DB weiterhin nutzbar und unverändert (validateBackupFile wirft VOR dem
  // destruktiven Teil von restoreFromFile).
  assert.equal(dbmod.currentVersion(), versionBefore);
  assert.doesNotThrow(() => database().prepare('SELECT 1').get());
});

// ── WebDAV-Konfig: Validierung ──────────────────────────────────────────────────
test('GET /webdav/config: unkonfiguriert → Passwort null, nicht configured', async () => {
  const r = await call('GET', '/webdav/config', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.configured, false);
  assert.equal(r.body.data.password, null);
});

test('PUT /webdav/config: Validierungsfehler → 400', async () => {
  const cases = [
    { body: { enabled: 'yes' }, rx: /enabled/ },
    { body: { url: 123 }, rx: /url/ },
    { body: { url: 'ftp://example.com/dav' }, rx: /http/ },
    { body: { keep: 0 }, rx: /keep/ },
    { body: { keep: 'many' }, rx: /keep/ },
  ];
  for (const c of cases) {
    const r = await call('PUT', '/webdav/config', { actor: ADM, body: c.body });
    assert.equal(r.status, 400, `Body ${JSON.stringify(c.body)} muss 400 liefern`);
    assert.match(r.body.error, c.rx);
  }
  // Kein Teil der ungültigen Konfig darf persistiert worden sein.
  const status = await call('GET', '/webdav/config', { actor: ADM });
  assert.equal(status.body.data.configured, false);
});

test('POST /webdav/test: unkonfiguriert → 400 (URL/Benutzer/Passwort fehlen)', async () => {
  const r = await call('POST', '/webdav/test', { actor: ADM, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /required/i);
});

// ── WebDAV-Konfig: valide Persistenz + Maskierung ───────────────────────────────
test('PUT /webdav/config: valide Konfig wird gespeichert, Passwort maskiert', async () => {
  const r = await call('PUT', '/webdav/config', {
    actor: ADM,
    body: { enabled: true, url: davBase, username: 'dav', password: 's3cret', remotePath: '/backups/', keep: 7 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, true);
  assert.equal(r.body.data.configured, true);
  assert.equal(r.body.data.url, davBase);
  assert.equal(r.body.data.username, 'dav');
  assert.equal(r.body.data.password, '****', 'Passwort wird nie im Klartext zurückgegeben');
  assert.equal(r.body.data.keep, 7);
  // Persistiert: erneutes GET zeigt dieselbe (maskierte) Konfig.
  const again = await call('GET', '/webdav/config', { actor: ADM });
  assert.equal(again.body.data.configured, true);
  assert.equal(again.body.data.password, '****');
});

// ── WebDAV-Happy-Paths gegen den Loopback-Stub ──────────────────────────────────
test('POST /webdav/test: erreichbarer Server → ok mit Dateizahl', async () => {
  const r = await call('POST', '/webdav/test', { actor: ADM, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, true);
  // Der Stub liefert genau eine Backup-Datei → scharfes Orakel statt typeof.
  assert.equal(r.body.data.files, 1);
});

test('GET /webdav/files: listet die entfernten Backup-Dateien', async () => {
  const r = await call('GET', '/webdav/files', { actor: ADM });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].filename, REMOTE_FILE, 'Stub-Datei erscheint in der Liste');
});

test('POST /webdav/trigger: erstellt lokalen Snapshot und lädt per PUT hoch', async () => {
  davSeen.length = 0;
  const r = await call('POST', '/webdav/trigger', { actor: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.file.endsWith('.db'), 'hochgeladener Dateiname zurückgegeben');
  assert.ok(typeof r.body.data.timestamp === 'string');
  assert.ok(davSeen.includes('PUT'), 'ein PUT-Upload ging an den WebDAV-Stub');
});

test('POST /webdav/test: explizite Overrides werden verwendet', async () => {
  const r = await call('POST', '/webdav/test', {
    actor: ADM,
    body: { url: davBase, username: 'other', password: 'pw2', remotePath: '/backups/' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, true);
});

test('GET /webdav/files: nicht erreichbares Ziel → 500', async () => {
  // Konfig auf einen refused-Port umbiegen: listRemoteBackups wirft → catch → 500.
  const put = await call('PUT', '/webdav/config', {
    actor: ADM,
    body: { enabled: true, url: 'http://127.0.0.1:1', username: 'dav', password: 'x', remotePath: '/backups/', keep: 7 },
  });
  assert.equal(put.status, 200);
  const r = await call('GET', '/webdav/files', { actor: ADM });
  assert.equal(r.status, 500);
  assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
});

// ── POST /restore: Größenlimit (413) ────────────────────────────────────────────
test('POST /restore: Upload über dem Limit → 413', async () => {
  const tooLarge = Buffer.alloc(5 * 1024 * 1024, 0); // > 4mb
  const r = await call('POST', '/restore', { actor: ADM, raw: tooLarge });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /too large/i);
});

// ── POST /restore: echter Roundtrip (re-initialisiert die DB) — als LETZTES ──────
test('POST /restore: valides Backup wird wiederhergestellt (Roundtrip)', async () => {
  const versionBefore = dbmod.currentVersion();
  // Frisches Backup der aktuellen DB ziehen …
  const dl = await call('GET', '/database', { actor: ADM });
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.length < 4 * 1024 * 1024);
  // … und exakt dieses wieder einspielen.
  const r = await call('POST', '/restore', { actor: ADM, raw: dl.buf });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.schema_version, versionBefore);
  // DB nach Re-Init weiter nutzbar.
  assert.doesNotThrow(() => database().prepare('SELECT MAX(version) FROM schema_migrations').get());
});
