/**
 * Modul: Statische Dateien - Inhalts-ETag und Brotli aus dem Speicher (R18)
 * Zweck: server/utils/static-assets.js hinter einem echten Express-Server.
 *   1. DER ETAG KOMMT AUS DEM INHALT. Der Service Worker revalidiert beim
 *      Precache (`no-cache`) und verlaesst sich darauf, dass ein gleicher ETag
 *      gleichen Inhalt heisst: eine geaenderte Datei MUSS neu kommen, auch
 *      wenn Groesse und Aenderungszeit gleich bleiben, und eine unveraenderte
 *      darf nach einem Neustart oder in einem neuen Image nicht neu kommen.
 *   2. BROTLI IST NUR TRANSPORT. Die Fassung aus dem Speicher ist bytegleich
 *      zum Original, traegt denselben ETag und dasselbe Cache-Control, und
 *      wer `br` nicht annimmt, bekommt sie nicht.
 * Ausfuehren: node --test test/test-static-assets.js
 *
 * Roh ueber node:http: `fetch` packt Brotli von selbst aus und versteckt damit
 * genau die Header, um die es geht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createContext, runInContext } from 'node:vm';
import express from 'express';
import compression from 'compression';
import { createStaticAssets, COMPRESSIBLE_EXTENSIONS } from '../server/utils/static-assets.js';
import { tempDir } from './tmp-dir.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

/** Ein Server wie in server/index.js: compression(), die Speicher-Fassung, express.static. */
async function serve(root, { brotli = true, compress } = {}) {
  const app = express();
  app.use(compression());
  const setHeaders = (res, filePath, stat) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('ETag', assets.etagFor(filePath, stat));
  };
  const assets = createStaticAssets(root, { brotli, setHeaders, ...(compress ? { compress } : {}) });
  app.use(assets.middleware);
  app.use(express.static(root, { etag: true, lastModified: true, redirect: false, setHeaders }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  return {
    assets,
    close: () => new Promise((resolve) => server.close(resolve)),
    request(urlPath, headers = {}, method = 'GET') {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
    },
    /** Wartet, bis die Hintergrund-Kompression durch ist - hoechstens 10 s. */
    async compressed() {
      const until = Date.now() + 10000;
      while (assets.stats().pending > 0) {
        if (Date.now() > until) throw new Error('Kompression wurde nicht fertig');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

function fixture() {
  const dir = tempDir('yuvomi-static-');
  const write = (name, content) => {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    utimesSync(file, FIXED_TIME, FIXED_TIME);
    return file;
  };
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sha = (buffer) => `W/"${createHash('sha1').update(buffer).digest('base64url')}"`;
// Eine echte Datei der App als Vorlage: an erfundenem, sich wiederholendem
// Text ist jede Stufe gleich gut, und der Vergleich der Stufen misst nichts.
const SCRIPT = readFileSync(path.join(PUBLIC_DIR, 'api.js'), 'utf8');

// --------------------------------------------------------
// 1. ETag aus dem Inhalt
// --------------------------------------------------------

test('the ETag is the hash of the content', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });

  const res = await srv.request('/app.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.etag, sha(Buffer.from(SCRIPT)));
});

test('a file that changes with the same size and the same mtime gets a new ETag and comes again', async (t) => {
  const fx = fixture();
  const file = fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const before = await srv.request('/app.js');

  // Derselbe Fall wie ein reproduzierbar gebautes Image: gleiche Laenge,
  // gleiche Aenderungszeit, anderer Inhalt. Ein ETag aus Groesse und Zeit
  // bliebe stehen. Der Server laeuft dabei neu an (neues Image = neuer Prozess).
  const changed = SCRIPT.replace("const API_BASE = '/api/v1';", "const API_BASE = '/api/v2';");
  assert.notEqual(changed, SCRIPT);
  assert.equal(changed.length, SCRIPT.length);
  fx.write('app.js', changed);
  assert.equal(statSync(file).mtimeMs, FIXED_TIME.getTime());
  const restarted = await serve(fx.dir);
  t.after(() => restarted.close());

  const after = await restarted.request('/app.js', { 'if-none-match': before.headers.etag });
  assert.equal(after.status, 200, 'die geaenderte Datei MUSS neu kommen');
  assert.notEqual(after.headers.etag, before.headers.etag);
  assert.equal(after.body.toString(), changed);
});

test('an unchanged file answers 304 - also after a restart and with a new mtime', async (t) => {
  const fx = fixture();
  const file = fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const first = await srv.request('/app.js');

  // Ein neues Image traegt fuer jede Datei eine neue Aenderungszeit.
  const later = new Date('2026-06-01T00:00:00Z');
  utimesSync(file, later, later);
  const restarted = await serve(fx.dir);
  t.after(() => restarted.close());

  const again = await restarted.request('/app.js', {
    'if-none-match': first.headers.etag,
    'if-modified-since': first.headers['last-modified'],
  });
  assert.equal(again.status, 304, 'gleicher Inhalt darf nicht neu uebertragen werden');
  assert.equal(again.body.length, 0);
});

test('a file edited while the server runs is hashed again', async (t) => {
  const fx = fixture();
  const file = fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const before = await srv.request('/app.js');

  writeFileSync(file, `${SCRIPT}// neu\n`);
  const after = await srv.request('/app.js', { 'if-none-match': before.headers.etag });
  assert.equal(after.status, 200);
  assert.equal(after.headers.etag, sha(Buffer.from(`${SCRIPT}// neu\n`)));
});

test('binary files get the content ETag too - the precache holds icons', async (t) => {
  const fx = fixture();
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  fx.write('icons/icon.png', bytes);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });

  const res = await srv.request('/icons/icon.png', { 'accept-encoding': 'br' });
  assert.equal(res.headers.etag, sha(bytes));
  assert.equal(res.headers['content-encoding'], undefined, 'Bilder werden nicht noch einmal komprimiert');
  assert.deepEqual(res.body, bytes);
});

// --------------------------------------------------------
// 2. Brotli aus dem Speicher
// --------------------------------------------------------

test('brotli from memory is the same bytes, the same ETag and the same Cache-Control', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const plain = await srv.request('/app.js');

  // Die erste Anfrage stoesst die Kompression nur an und geht durch compression().
  const first = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.equal(first.status, 200);
  assert.equal(brotliDecompressSync(first.body).toString(), SCRIPT);
  await srv.compressed();
  assert.equal(srv.assets.stats().files, 1);

  const second = await srv.request('/app.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(second.headers['content-encoding'], 'br');
  assert.equal(Number(second.headers['content-length']), second.body.length, 'feste Laenge: die Fassung liegt fertig im Speicher');
  assert.ok(second.body.length < first.body.length, `Stufe 11 (${second.body.length}) ist nicht kleiner als compression() (${first.body.length})`);
  assert.deepEqual(brotliDecompressSync(second.body), Buffer.from(SCRIPT), 'Inhalt bytegleich, Kommentare eingeschlossen');
  assert.equal(second.headers.etag, plain.headers.etag);
  assert.equal(second.headers['cache-control'], plain.headers['cache-control']);
  assert.equal(second.headers['content-type'], plain.headers['content-type']);
  assert.equal(second.headers['last-modified'], plain.headers['last-modified']);
  assert.match(second.headers.vary, /Accept-Encoding/i);
});

test('a client without br never gets the stored version', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  await srv.request('/app.js', { 'accept-encoding': 'br' });
  await srv.compressed();

  const identity = await srv.request('/app.js', { 'accept-encoding': 'identity' });
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.body.toString(), SCRIPT);

  const gzip = await srv.request('/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(gzip.headers['content-encoding'], 'gzip', 'compression() uebernimmt wie bisher');
});

test('revalidating the stored version answers 304', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const first = await srv.request('/app.js', { 'accept-encoding': 'br' });
  await srv.compressed();

  const res = await srv.request('/app.js', { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
  assert.equal(res.status, 304);
  assert.equal(res.body.length, 0);
  assert.equal(res.headers['content-encoding'], undefined);
});

test('a file edited while the server runs never comes out of the old stored version', async (t) => {
  const fx = fixture();
  const file = fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  await srv.request('/app.js', { 'accept-encoding': 'br' });
  await srv.compressed();

  const changed = `${SCRIPT}export const more = 1;\n`;
  writeFileSync(file, changed);
  const res = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.equal(brotliDecompressSync(res.body).toString(), changed);
  await srv.compressed();
  const again = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.equal(brotliDecompressSync(again.body).toString(), changed);
  assert.equal(again.headers.etag, sha(Buffer.from(changed)));
});

test('HEAD, range requests, small files and unknown paths', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  fx.write('tiny.js', 'export {};\n');
  fx.write('.secret.js', SCRIPT);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  for (const name of ['/app.js', '/tiny.js']) await srv.request(name, { 'accept-encoding': 'br' });
  await srv.compressed();

  const head = await srv.request('/app.js', { 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-encoding'], 'br');
  assert.equal(head.body.length, 0);

  const range = await srv.request('/app.js', { 'accept-encoding': 'br', range: 'bytes=0-9' });
  assert.equal(range.status, 206, 'Teilabrufe rechnen in Bytes des Originals');
  assert.equal(range.body.toString(), SCRIPT.slice(0, 10));

  assert.equal(srv.assets.stats().files, 1, 'unter 1 KB lohnt die Kodierung nicht');
  assert.equal((await srv.request('/missing.js', { 'accept-encoding': 'br' })).status, 404);
  assert.equal((await srv.request('/.secret.js', { 'accept-encoding': 'br' })).status, 404);
  assert.equal((await srv.request('/%2e%2e/%2e%2e/etc/passwd', { 'accept-encoding': 'br' })).status, 404);
  assert.notEqual((await srv.request('/%E0%A4%A', { 'accept-encoding': 'br' })).status, 500, 'kaputte Kodierung im Pfad');
});

test('STATIC_BROTLI=off: nothing is stored, the ETag stays', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir, { brotli: false });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  await srv.request('/app.js', { 'accept-encoding': 'br' });
  const res = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.deepEqual(srv.assets.stats(), { files: 0, bytes: 0, pending: 0 });
  assert.equal(brotliDecompressSync(res.body).toString(), SCRIPT, 'compression() liefert weiter');
  assert.equal(res.headers.etag, sha(Buffer.from(SCRIPT)));
});

test('a failing compression leaves the file with compression()', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const srv = await serve(fx.dir, { compress: (_buffer, _options, cb) => setImmediate(() => cb(new Error('kaputt'))) });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  await srv.request('/app.js', { 'accept-encoding': 'br' });
  await srv.compressed();
  const res = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.equal(res.status, 200);
  assert.equal(brotliDecompressSync(res.body).toString(), SCRIPT);
  assert.equal(srv.assets.stats().files, 0);
});

test('files are compressed one after the other, not all at once', async (t) => {
  const fx = fixture();
  for (const name of ['a.js', 'b.js', 'c.js']) fx.write(name, SCRIPT + name);
  let running = 0;
  let most = 0;
  const compress = (buffer, _options, cb) => {
    running += 1;
    most = Math.max(most, running);
    setTimeout(() => { running -= 1; cb(null, buffer.subarray(0, 10)); }, 15);
  };
  const srv = await serve(fx.dir, { compress });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  await Promise.all(['/a.js', '/b.js', '/c.js'].map((name) => srv.request(name, { 'accept-encoding': 'br' })));
  await srv.compressed();
  assert.equal(most, 1, 'der Threadpool gehoert auch dem Rest des Servers');
  assert.equal(srv.assets.stats().files, 3);
});

// --------------------------------------------------------
// 3. Die echte App: jede Precache-Datei, und die Verdrahtung
// --------------------------------------------------------

function precacheList() {
  const noop = () => {};
  const sandbox = {
    self: { addEventListener: noop, location: { origin: 'https://app.test' } },
    caches: { open: async () => ({ match: async () => undefined, delete: async () => {} }), keys: async () => [] },
    fetch: async () => ({ ok: false }),
    Request: class {}, Response: class {}, Headers: class {},
    URL, console, Date, Promise, parseInt, Symbol, Set, Map, setTimeout, clearTimeout,
  };
  const src = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const lists = runInContext(`${src}\n;({ APP_SHELL, PAGE_MODULES, PRECACHED_LOCALES })`, createContext(sandbox));
  return [...Array.from(lists.APP_SHELL), ...Array.from(lists.PAGE_MODULES), ...Array.from(lists.PRECACHED_LOCALES)];
}

test('every precached file of the app is served with its content ETag, stable across restarts', async (t) => {
  const first = await serve(PUBLIC_DIR, { brotli: false });
  const second = await serve(PUBLIC_DIR, { brotli: false });
  t.after(async () => { await first.close(); await second.close(); });
  const list = precacheList();
  assert.ok(list.length > 250, `nur ${list.length} Precache-Eintraege gelesen`);

  const wrong = [];
  for (const urlPath of list) {
    const res = await first.request(urlPath);
    const file = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
    const expected = sha(readFileSync(file));
    const again = await second.request(urlPath, { 'if-none-match': res.headers.etag });
    if (res.status !== 200 || res.headers.etag !== expected || again.status !== 304) {
      wrong.push(`${urlPath} (${res.status}, ${res.headers.etag}, erneut ${again.status})`);
    }
  }
  assert.deepEqual(wrong, [], 'ohne Inhalts-ETag ist die Revalidierung beim Precache nicht sicher');
});

test('the worker revalidates its precache, and the server serves both ways from one header function', () => {
  const sw = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const install = sw.slice(sw.indexOf("self.addEventListener('install'"), sw.indexOf("self.addEventListener('activate'"));
  assert.equal([...install.matchAll(/cache: 'no-cache'/g)].length, 3);
  assert.doesNotMatch(install, /cache: 'reload'/);

  const index = readFileSync(path.join(import.meta.dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(index, /res\.setHeader\('ETag', staticAssets\.etagFor\(filePath, stat\)\);/);
  assert.match(index, /createStaticAssets\(PUBLIC_DIR, \{[\s\S]*?setHeaders: setStaticHeaders,\s*\}\);/);
  assert.match(index, /app\.use\(staticAssets\.middleware\);\s*\n\s*app\.use\(express\.static\(PUBLIC_DIR, \{[\s\S]*?setHeaders: setStaticHeaders,/,
    'die Speicher-Fassung steht VOR express.static und teilt dessen Header');
  assert.match(index, /process\.env\.STATIC_BROTLI/);
  assert.ok(index.indexOf('app.use(compression());') < index.indexOf('app.use(staticAssets.middleware);'),
    'compression() bleibt davor - es uebernimmt alles, was nicht aus dem Speicher kommt');
});

test('what counts as compressible covers the text types the app ships', () => {
  for (const ext of ['.js', '.mjs', '.css', '.json', '.html', '.svg']) assert.ok(COMPRESSIBLE_EXTENSIONS.has(ext), ext);
  for (const ext of ['.png', '.jpg', '.webp', '.woff2', '.ico']) assert.ok(!COMPRESSIBLE_EXTENSIONS.has(ext), ext);
});
