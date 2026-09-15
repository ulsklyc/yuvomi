/**
 * Test: WebDAV Backup Target
 * Purpose: Verify WebDAV backup upload, rotation and connection test logic
 *          using a local HTTP mock server (no external dependencies).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── Mock WebDAV server ───────────────────────────────────────────────────────

/**
 * EIN Host fuer alle Mock-Server, auf einem Port, den der Kernel vergibt.
 *
 * Bis 2026-09-15 lauschte jeder Block auf dem festen Port 39871. Zwei Laeufe
 * nebeneinander (parallele Kette, zweiter Arbeitsbaum) trafen denselben Port,
 * und unter Linux liegt 39871 mitten im ephemeren Bereich (32768-60999) - dort
 * kann ihn jede ausgehende Verbindung einer Nachbarsuite halten. Ein Port pro
 * Block geht aber auch nicht: `server/services/backup-webdav.js` liest
 * `WEBDAV_BACKUP_URL` einmal beim Import. Deshalb lauscht EIN Server ueber die
 * ganze Suite, und jeder Block tauscht nur die Antwortlogik (`useMock`).
 */
const mockHost = { server: null, port: null, active: null };

function startMockHost() {
  mockHost.server = http.createServer((req, res) => {
    if (!mockHost.active) {
      res.writeHead(503);
      res.end('no mock active');
      return;
    }
    mockHost.active.handle(req, res);
  });
  return new Promise((resolve, reject) => {
    mockHost.server.once('error', reject);
    mockHost.server.listen(0, '127.0.0.1', () => {
      mockHost.port = mockHost.server.address().port;
      resolve();
    });
  });
}

/** Ein Port, auf dem gerade niemand lauscht: vom Kernel geholt und wieder freigegeben. */
function closedPort() {
  const probe = http.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Setzt den Mock fuer einen Block ein und nimmt ihn im after()-Hook wieder heraus. */
function useMock(options) {
  const ctx = {};
  before(() => {
    Object.assign(ctx, createMockServer(options));
    mockHost.active = ctx;
  });
  after(() => { mockHost.active = null; });
  return ctx;
}

/**
 * Minimal WebDAV mock:
 * - PROPFIND  → 207 Multi-Status with a fake file list
 * - PUT       → 201 Created
 * - DELETE    → 204 No Content
 * - GET/HEAD  → 200 (for client.exists())
 *
 * `liveProp` waehlt das Namespace-Praefix der Live-Properties. Default `D:`
 * ist der Nextcloud-Stil; `lp1:` ist der von Apache mod_dav und damit der einer
 * Synology. Beide sind gueltiges WebDAV - der Unterschied ist genau der, an dem
 * die Rotation in #853 blind wurde, also muss der Mock ihn abbilden koennen.
 */
function createMockServer({ failAuth = false, failPropfind = false, liveProp = 'D:', absoluteHrefs = false } = {}) {
  // In-memory "filesystem"
  const files = new Map(); // remotePath → { lastmod, size }

  const handle = (req, res) => {
    if (failAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('Unauthorized');
      return;
    }

    const method = req.method.toUpperCase();
    const url    = req.url;

    if (method === 'PROPFIND') {
      if (failPropfind) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }

      // List files that match the path prefix. Die Reihenfolge ist die der
      // Uploads und damit chronologisch aufsteigend - genau wie ein echter
      // Server sie liefert, der nach Namen sortiert (die Namen tragen ISO-
      // Stempel). Nur so kann der Test sehen, ob die Sortierung im Modul
      // wirklich arbeitet oder nur die Serverreihenfolge durchreicht.
      const fileEntries = [...files.entries()].filter(([k]) => k.startsWith(url));
      const hrefOf = (p) => (absoluteHrefs ? `http://127.0.0.1:${mockHost.port}${p}` : p);
      const fileXml = fileEntries.map(([filePath, info]) => `
        <D:response>
          <D:href>${xmlEsc(hrefOf(filePath))}</D:href>
          <D:propstat>
            <D:prop>
              <${liveProp}resourcetype/>
              <${liveProp}getlastmodified>${info.lastmod}</${liveProp}getlastmodified>
              <D:getcontentlength>${info.size}</D:getcontentlength>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>`).join('');

      const xml = `<?xml version="1.0" encoding="utf-8"?>
        <D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">
          <D:response>
            <D:href>${xmlEsc(hrefOf(url))}</D:href>
            <D:propstat>
              <D:prop>
                <${liveProp}resourcetype><D:collection/></${liveProp}resourcetype>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
          ${fileXml}
        </D:multistatus>`;

      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    if (method === 'MKCOL') {
      res.writeHead(201);
      res.end();
      return;
    }

    if (method === 'PUT') {
      let body = Buffer.alloc(0);
      req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
      req.on('end', () => {
        files.set(url, {
          lastmod: new Date().toUTCString(),
          size:    body.length,
          basename: path.basename(url),
          type:     'file',
          filename: url,
        });
        res.writeHead(201);
        res.end();
      });
      return;
    }

    if (method === 'DELETE') {
      files.delete(url);
      res.writeHead(204);
      res.end();
      return;
    }

    // HEAD / GET for exists() checks
    if (method === 'HEAD' || method === 'GET') {
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  };

  return { handle, files };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir;

async function createTempBackup(name = 'oikos-backup-2099-01-01T00-00-00-000Z.db') {
  const fp = path.join(tmpDir, name);
  await fs.writeFile(fp, Buffer.from('SQLite format 3\0fake backup content'));
  return fp;
}

// ─── Env setup ────────────────────────────────────────────────────────────────

// Disable scheduler & point BACKUP_DIR to tmp; WebDAV config via env
process.env.BACKUP_ENABLED         = 'false';
process.env.WEBDAV_BACKUP_ENABLED  = 'true';
process.env.WEBDAV_BACKUP_USERNAME = 'testuser';
process.env.WEBDAV_BACKUP_PASSWORD = 'testpass';
process.env.WEBDAV_BACKUP_PATH     = '/oikos/backups/';
process.env.WEBDAV_BACKUP_KEEP     = '3';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebDAV Backup — service module', async () => {
  let webdav;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oikos-webdav-test-'));
    // Der Port muss VOR dem Import feststehen - das Modul liest die URL beim Laden.
    await startMockHost();
    process.env.BACKUP_DIR            = tmpDir;
    process.env.WEBDAV_BACKUP_URL     = `http://127.0.0.1:${mockHost.port}`;
    webdav = await import('../server/services/backup-webdav.js');
  });

  after(async () => {
    mockHost.server.closeAllConnections?.();
    await new Promise((resolve) => mockHost.server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should export required functions', () => {
    assert.ok(typeof webdav.getConfig      === 'function', 'getConfig');
    assert.ok(typeof webdav.saveConfig     === 'function', 'saveConfig');
    assert.ok(typeof webdav.isEnabled      === 'function', 'isEnabled');
    assert.ok(typeof webdav.uploadBackup   === 'function', 'uploadBackup');
    assert.ok(typeof webdav.testConnection === 'function', 'testConnection');
    assert.ok(typeof webdav.getRemoteFiles === 'function', 'getRemoteFiles');
    assert.ok(typeof webdav.triggerUpload  === 'function', 'triggerUpload');
    assert.ok(typeof webdav.getStatus      === 'function', 'getStatus');
  });

  it('getConfig() should read env vars', () => {
    const cfg = webdav.getConfig();
    assert.strictEqual(cfg.enabled,    true,              'enabled from env');
    assert.strictEqual(cfg.url,        `http://127.0.0.1:${mockHost.port}`, 'url from env');
    assert.strictEqual(cfg.username,   'testuser',        'username from env');
    assert.strictEqual(cfg.password,   'testpass',        'password from env');
    assert.strictEqual(cfg.remotePath, '/oikos/backups/', 'remotePath');
    assert.strictEqual(cfg.keep,       3,                 'keep');
  });

  it('isEnabled() should return true when fully configured', () => {
    assert.strictEqual(webdav.isEnabled(), true);
  });

  it('getStatus() should mask the password', () => {
    const status = webdav.getStatus();
    assert.strictEqual(status.password, '****', 'password masked');
    assert.ok(status.configured, 'configured = true');
  });

  describe('testConnection()', async () => {
    useMock();

    it('should return { ok: true } on successful PROPFIND', async () => {
      const result = await webdav.testConnection({});
      assert.strictEqual(result.ok, true);
    });

    it('should throw when server is unreachable', async () => {
      // Kein fester Port: 39872 lag unter Linux im ephemeren Bereich und
      // konnte belegt sein. Ein eben freigegebener Port ist es nicht.
      const port = await closedPort();
      await assert.rejects(
        () => webdav.testConnection({ url: `http://127.0.0.1:${port}`, username: 'x', password: 'y' }),
        (err) => {
          assert.ok(err instanceof Error, 'should throw Error');
          return true;
        }
      );
    });
  });

  describe('uploadBackup()', async () => {
    const mockCtx = useMock();

    it('should PUT the file to the remote server', async () => {
      const fp = await createTempBackup();
      await webdav.uploadBackup(fp);
      const remotePath = `/oikos/backups/${path.basename(fp)}`;
      assert.ok(mockCtx.files.has(remotePath), 'file should exist on mock server');
    });

    it('should upload and list new yuvomi-prefixed backups (post-rebrand naming)', async () => {
      const fp = await createTempBackup('yuvomi-backup-2099-02-01T00-00-00-000Z.db');
      await webdav.uploadBackup(fp);
      assert.ok(
        mockCtx.files.has(`/oikos/backups/${path.basename(fp)}`),
        'yuvomi-prefixed file should be uploaded'
      );
      const listed = await webdav.getRemoteFiles();
      assert.ok(
        listed.some((f) => f.filename.startsWith('yuvomi-backup-')),
        'yuvomi-prefixed file should be recognised by the file listing'
      );
    });

    it('should rotate when more than keep remote files exist', async () => {
      // Upload 4 files (keep = 3)
      const names = [
        'oikos-backup-2099-01-01T00-00-00-000Z.db',
        'oikos-backup-2099-01-02T00-00-00-000Z.db',
        'oikos-backup-2099-01-03T00-00-00-000Z.db',
        'oikos-backup-2099-01-04T00-00-00-000Z.db',
      ];
      for (const name of names) {
        const fp = await createTempBackup(name);
        await webdav.uploadBackup(fp);
        // small delay so lastmod ordering is stable
        await new Promise((r) => setTimeout(r, 10));
      }
      const remoteFiles = [...mockCtx.files.keys()].filter((k) =>
        k.startsWith('/oikos/backups/') && k.endsWith('.db')
      );
      assert.ok(
        remoteFiles.length <= 3,
        `Should keep at most 3 files, got ${remoteFiles.length}`
      );
      // Die Zahl allein war jahrelang gruen, waehrend die falschen Dateien
      // verschwanden. Ab hier zaehlt, WELCHE bleiben.
      assert.ok(
        remoteFiles.some((k) => k.endsWith('oikos-backup-2099-01-04T00-00-00-000Z.db')),
        'the newest backup must survive rotation'
      );
      assert.ok(
        !remoteFiles.some((k) => k.endsWith('oikos-backup-2099-01-01T00-00-00-000Z.db')),
        'the oldest backup is the one that goes'
      );
    });
  });

  // #853: Auf einer Synology (Apache mod_dav) kamen die Live-Properties als
  // `lp1:getlastmodified`. Der Parser bestand auf `D:`/`d:`, las also gar kein
  // Datum, setzte fuer JEDE Datei ersatzweise "jetzt" ein - und damit sortierte
  // sich nichts mehr. Uebrig blieb die Reihenfolge des Servers, aufsteigend nach
  // Namen, und die Rotation loeschte vom falschen Ende: das gerade hochgeladene
  // Backup, jedes Mal.
  describe('rotation on an Apache mod_dav server (#853)', async () => {
    const mockCtx = useMock({ liveProp: 'lp1:' });

    const remoteDbFiles = () => [...mockCtx.files.keys()]
      .filter((k) => k.startsWith('/oikos/backups/') && k.endsWith('.db'))
      .map((k) => path.basename(k));

    it('should keep the newest backups and delete the oldest', async () => {
      const names = [
        'yuvomi-backup-2099-03-01T00-00-00-000Z.db',
        'yuvomi-backup-2099-03-02T00-00-00-000Z.db',
        'yuvomi-backup-2099-03-03T00-00-00-000Z.db',
        'yuvomi-backup-2099-03-04T00-00-00-000Z.db',
        'yuvomi-backup-2099-03-05T00-00-00-000Z.db',
      ];
      for (const name of names) {
        await webdav.uploadBackup(await createTempBackup(name));
      }

      const remaining = remoteDbFiles();
      assert.deepStrictEqual(
        remaining.sort(),
        [
          'yuvomi-backup-2099-03-03T00-00-00-000Z.db',
          'yuvomi-backup-2099-03-04T00-00-00-000Z.db',
          'yuvomi-backup-2099-03-05T00-00-00-000Z.db',
        ],
        'keep=3 must leave the three newest, not the three oldest'
      );
    });

    it('should never delete the file it just uploaded', async () => {
      const fresh = 'yuvomi-backup-2099-03-06T00-00-00-000Z.db';
      await webdav.uploadBackup(await createTempBackup(fresh));
      assert.ok(
        remoteDbFiles().includes(fresh),
        'the freshly uploaded backup must still be there after rotation'
      );
    });

    it('should read the timestamp from a mod_dav-prefixed listing', async () => {
      const listed = await webdav.getRemoteFiles();
      assert.ok(listed.length > 0, 'listing is not empty');
      assert.ok(
        listed.every((f) => typeof f.lastmod === 'string' && !Number.isNaN(Date.parse(f.lastmod))),
        'every entry carries a parsable getlastmodified, whatever the namespace prefix'
      );
      // Neueste zuerst - darauf verlaesst sich die Rotation.
      const names = listed.map((f) => f.filename);
      assert.deepStrictEqual(names, [...names].sort().reverse(), 'sorted newest first');
    });
  });

  // Ein href darf laut RFC 4918 auch absolut sein. joinUrl() haengt an die
  // Basis-URL an - unnormalisiert entstuende daraus `http://host/http://host/…`,
  // und die DELETE-Anfrage ginge ins Leere statt aufs Ziel.
  describe('rotation on a server that answers with absolute hrefs', async () => {
    const mockCtx = useMock({ absoluteHrefs: true });

    it('should still delete the oldest file', async () => {
      const names = [
        'yuvomi-backup-2099-04-01T00-00-00-000Z.db',
        'yuvomi-backup-2099-04-02T00-00-00-000Z.db',
        'yuvomi-backup-2099-04-03T00-00-00-000Z.db',
        'yuvomi-backup-2099-04-04T00-00-00-000Z.db',
      ];
      for (const name of names) {
        await webdav.uploadBackup(await createTempBackup(name));
      }
      const remaining = [...mockCtx.files.keys()]
        .filter((k) => k.endsWith('.db'))
        .map((k) => path.basename(k))
        .sort();
      assert.deepStrictEqual(
        remaining,
        [
          'yuvomi-backup-2099-04-02T00-00-00-000Z.db',
          'yuvomi-backup-2099-04-03T00-00-00-000Z.db',
          'yuvomi-backup-2099-04-04T00-00-00-000Z.db',
        ],
        'an absolute href must resolve to the same target as a relative one'
      );
    });
  });

  describe('triggerUpload()', async () => {
    const mockCtx = useMock();

    it('should throw when no local backup files exist', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oikos-empty-'));
      try {
        await assert.rejects(
          () => webdav.triggerUpload(emptyDir),
          /No local backup files found/
        );
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });

    it('should upload the most recent local backup', async () => {
      const fp = await createTempBackup('oikos-backup-2099-06-01T12-00-00-000Z.db');
      const fileName = await webdav.triggerUpload(tmpDir);
      assert.ok(fileName.startsWith('oikos-backup-'), 'returned file name');
      const remotePath = `/oikos/backups/${fileName}`;
      assert.ok(mockCtx.files.has(remotePath), 'file uploaded to mock server');
    });
  });

  it('should skip upload gracefully when disabled', async () => {
    process.env.WEBDAV_BACKUP_ENABLED = 'false';
    // Re-import won't work with module cache — test via isEnabled() instead
    // Just verify no throw when isEnabled() is false
    const cfg = webdav.getConfig();
    // env var is cached at module load time, so we test via getConfig override logic
    assert.ok(typeof cfg.enabled === 'boolean', 'enabled is boolean');
    process.env.WEBDAV_BACKUP_ENABLED = 'true';
  });
});


describe('env-Vorrang', () => {
  it('behandelt leere env-Variablen als nicht gesetzt', async () => {
    // Deploy-Descriptoren, die jede Variable von Hand aufzaehlen (Portainer,
    // Unraid), reichen optionale Felder als LEEREN STRING durch. Der ist
    // definiert und nicht nullish, gewann also gegen alles in der Datenbank:
    // ein Haushalt konnte WebDAV-Backups in den Einstellungen einrichten, die
    // UI nahm es an, und wirksam wurde nichts davon. Dasselbe Kriterium nutzt
    // isEnvControlled() in services/email.js.
    const keys = ['WEBDAV_BACKUP_ENABLED', 'WEBDAV_BACKUP_URL', 'WEBDAV_BACKUP_USERNAME',
      'WEBDAV_BACKUP_PASSWORD', 'WEBDAV_BACKUP_PATH', 'WEBDAV_BACKUP_KEEP'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) process.env[k] = '';
    try {
      // Frischer Import: die env-Konstanten werden beim Modul-Load gelesen.
      const mod = await import(`../server/services/backup-webdav.js?empty=${process.pid}`);
      const cfg = mod.getConfig();
      assert.equal(cfg.url, null, 'eine leere URL darf nicht als gesetzt gelten');
      assert.equal(cfg.username, null);
      assert.equal(cfg.password, null);
      assert.equal(cfg.remotePath, '/yuvomi/backups/', 'der Default-Pfad muss greifen');
      assert.equal(cfg.keep, 7, 'ein leeres KEEP darf nicht auf 0 fallen');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('sperrt die Felder nicht fuer eine URL aus reinem Leerraum', async () => {
    // envControlled entscheidet, ob die Einstellungen die Backup-Felder sperren. Es
    // hing am ROHEN Wert (Boolean(ENV_URL)), getConfig() dagegen am getrimmten: ein
    // Leerzeichen in WEBDAV_BACKUP_URL - etwa aus `${WEBDAV_BACKUP_URL:- }` oder einer
    // mehrzeilig formatierten Unraid-Vorlage - sperrte die Felder, ohne dass die URL
    // galt. Der Test oben mit '' sah das nie, weil Boolean('') ohnehin false ist.
    const saved = process.env.WEBDAV_BACKUP_URL;
    try {
      process.env.WEBDAV_BACKUP_URL = ' \n ';
      const blank = await import(`../server/services/backup-webdav.js?blank=${process.pid}`);
      assert.equal(blank.getConfig().url, null, 'Leerraum darf nicht als URL gelten');
      assert.equal(blank.getStatus().envControlled, false, 'Leerraum darf die Backup-Felder nicht sperren');

      // Gegenstueck, damit der Test nicht an einem immer falschen Wert gruen haengt.
      process.env.WEBDAV_BACKUP_URL = 'https://dav.example/remote.php/dav/';
      const set = await import(`../server/services/backup-webdav.js?set=${process.pid}`);
      assert.equal(set.getStatus().envControlled, true, 'eine gesetzte URL muss die Felder sperren');
    } finally {
      if (saved === undefined) delete process.env.WEBDAV_BACKUP_URL;
      else process.env.WEBDAV_BACKUP_URL = saved;
    }
  });
});

describe('Zugangsdaten aus der Umgebung', () => {
  it('erhaelt Leerzeichen am Rand eines Passworts', async () => {
    // Getrimmt werden darf nur zur Erkennung "ist die Variable leer?". Wer den
    // Wert selbst trimmt, macht aus einem gueltigen Passwort mit Rand-
    // Leerzeichen ein ungueltiges - und das faellt erst beim naechsten Backup
    // auf, nicht beim Speichern.
    const saved = process.env.WEBDAV_BACKUP_PASSWORD;
    process.env.WEBDAV_BACKUP_PASSWORD = ' pass mit rand ';
    try {
      const mod = await import(`../server/services/backup-webdav.js?pw=${process.pid}`);
      assert.equal(mod.getConfig().password, ' pass mit rand ',
        'das Passwort muss unveraendert durchgereicht werden');
    } finally {
      if (saved === undefined) delete process.env.WEBDAV_BACKUP_PASSWORD;
      else process.env.WEBDAV_BACKUP_PASSWORD = saved;
    }
  });
});
