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
 *   3. DIE ECHTE APP (seit Phase 1a: dist/, gebaut): jede Precache-Datei aus
 *      dist/sw.js kommt mit dem ETag ihrer Bytes und bleibt ueber einen
 *      Neustart gleich; gehashte Chunks sind unveraenderlich, alles andere
 *      revalidiert; ohne Build startet der Server nicht.
 *   4. KEIN SCHNITT MEHR AUF DER LEITUNG. Von R19 bis Phase 1a schnitt dieser
 *      Weg Kommentare aus eigenem JS/CSS (strip-comments.js, entfernt mit dem
 *      Build): seit `npm run build` minifiziert Vite, und was geht, ist die
 *      gebaute Datei, Byte fuer Byte.
 * Ausfuehren: node --test test/test-static-assets.js
 *
 * Roh ueber node:http: `fetch` packt Brotli von selbst aus und versteckt damit
 * genau die Header, um die es geht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createStaticAssets, COMPRESSIBLE_EXTENSIONS } from '../server/utils/static-assets.js';
import { MISSING_BUILD_MESSAGE, resolveFrontendDir } from '../server/utils/frontend-dir.js';
import { DIST, distPrecache } from './dist-build.js';
import { tempDir } from './tmp-dir.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

/** Ein Server wie in server/index.js: compression(), die Speicher-Fassung, express.static. */
async function serve(root, { brotli = true, compress, limits } = {}) {
  const app = express();
  app.use(compression());
  const setHeaders = (res, filePath, stat) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('ETag', assets.etagFor(filePath, stat));
  };
  const assets = createStaticAssets(root, { brotli, setHeaders, ...(compress ? { compress } : {}), ...(limits ?? {}) });
  // Wie in server/index.js: eine Bremse VOR dem Speicher, die ueber der Grenze
  // nicht abweist, sondern nur am Speicher vorbeifuehrt.
  app.use(rateLimit({
    windowMs: 60_000,
    max: limits?.requestsPerMinute ?? 100_000,
    standardHeaders: false,
    legacyHeaders: false,
    handler: assets.overLimit,
  }), assets.middleware);
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
// 2b. Der Speicher hat eine Grenze, und ein Pfad ist keine Datei
// --------------------------------------------------------
// Statische Dateien sind ohne Anmeldung abrufbar. Solange der Schluessel der
// Pfad aus der Adresse war, bekam jede SCHREIBWEISE derselben Datei einen
// eigenen Eintrag samt eigener Brotli-Fassung: auf einem Dateisystem ohne
// Gross-/Kleinschreibung /app.js, /App.js, /APP.JS, ueberall jeder Symlink.
// "Hoechstens so viel wie public/ wiegt" galt damit nur als Annahme. Der Test
// nimmt Symlinks, weil die auch auf dem Linux der CI zwei Namen fuer eine
// Datei sind.

/**
 * Legt einen Symlink an oder ueberspringt den Test, wenn das System keinen
 * erlaubt: unter Windows brauchen Symlinks auf Dateien den Entwicklermodus
 * oder Adminrechte (EPERM). Unter Linux gelingt er immer.
 */
function symlinkOrSkip(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    t.skip(`Symlink nicht anlegbar (${err.code}) - unter Windows braucht er den Entwicklermodus`);
    return false;
  }
}

test('many names for one file are one stored version, compressed once', async (t) => {
  const fx = fixture();
  fx.write('app.js', SCRIPT);
  const names = ['/app.js'];
  for (let i = 0; i < 5; i += 1) {
    if (!symlinkOrSkip(t, path.join(fx.dir, 'app.js'), path.join(fx.dir, `alias-${i}.js`))) {
      fx.cleanup();
      return;
    }
    names.push(`/alias-${i}.js`);
  }
  let runs = 0;
  const compress = (buffer, _options, cb) => { runs += 1; setTimeout(() => cb(null, buffer.subarray(0, 10)), 5); };
  const srv = await serve(fx.dir, { compress });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  for (const name of names) await srv.request(name, { 'accept-encoding': 'br' });
  await srv.compressed();
  for (const name of names) {
    const res = await srv.request(name, { 'accept-encoding': 'br' });
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.etag, sha(Buffer.from(SCRIPT)), name);
  }
  assert.equal(runs, 1, 'eine Datei wird einmal komprimiert, egal unter wie vielen Namen');
  assert.deepEqual(srv.assets.stats(), { files: 1, bytes: 10, pending: 0 });
});

test('a link that leaves the folder is never read into memory', async (t) => {
  const fx = fixture();
  const outside = fixture();
  const secret = outside.write('outside.js', SCRIPT);
  if (!symlinkOrSkip(t, secret, path.join(fx.dir, 'leak.js'))) {
    fx.cleanup();
    outside.cleanup();
    return;
  }
  let runs = 0;
  const compress = (buffer, _options, cb) => { runs += 1; cb(null, buffer.subarray(0, 10)); };
  const srv = await serve(fx.dir, { compress });
  t.after(async () => { await srv.close(); fx.cleanup(); outside.cleanup(); });

  await srv.request('/leak.js', { 'accept-encoding': 'br' });
  await srv.compressed();
  assert.equal(runs, 0);
  assert.equal(srv.assets.stats().files, 0);
});

test('the stored versions stop at the byte limit - beyond it compression() serves', async (t) => {
  const fx = fixture();
  for (const name of ['a.js', 'b.js', 'c.js']) fx.write(name, SCRIPT + name);
  const compress = (buffer, _options, cb) => setTimeout(() => cb(null, buffer.subarray(0, 10)), 5);
  const srv = await serve(fx.dir, { compress, limits: { maxBytes: 20 } });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  for (const name of ['/a.js', '/b.js', '/c.js']) {
    await srv.request(name, { 'accept-encoding': 'br' });
    await srv.compressed();
  }
  assert.deepEqual(srv.assets.stats(), { files: 2, bytes: 20, pending: 0 });
  // Die dritte kommt weiter an, nur eben wie vorher durch compression() -
  // und sie wird nicht bei jeder Anfrage wieder in die Schlange gestellt.
  const res = await srv.request('/c.js', { 'accept-encoding': 'br' });
  assert.equal(res.status, 200);
  assert.equal(brotliDecompressSync(res.body).toString(), SCRIPT + 'c.js');
  assert.equal(srv.assets.stats().pending, 0);
});

test('the number of remembered files is limited, the oldest goes first', async (t) => {
  const fx = fixture();
  for (const name of ['a.js', 'b.js', 'c.js']) fx.write(name, SCRIPT + name);
  const compress = (buffer, _options, cb) => setTimeout(() => cb(null, buffer.subarray(0, 10)), 5);
  const srv = await serve(fx.dir, { compress, limits: { maxEntries: 2 } });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  for (const name of ['/a.js', '/b.js', '/c.js']) {
    await srv.request(name, { 'accept-encoding': 'br' });
    await srv.compressed();
  }
  const stats = srv.assets.stats();
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, 20, 'die Bytes des verdraengten Eintrags zaehlen nicht weiter');
  // Der ETag bleibt der Inhalts-Hash, auch fuer die verdraengte Datei.
  const res = await srv.request('/a.js');
  assert.equal(res.headers.etag, sha(Buffer.from(SCRIPT + 'a.js')));
});

test('over the request limit a client loses the store, never the file', async (t) => {
  const fx = fixture();
  for (const name of ['a.js', 'b.js']) fx.write(name, SCRIPT + name);
  let runs = 0;
  const compress = (buffer, _options, cb) => { runs += 1; setTimeout(() => cb(null, buffer.subarray(0, 10)), 5); };
  const srv = await serve(fx.dir, { compress, limits: { requestsPerMinute: 1 } });
  t.after(async () => { await srv.close(); fx.cleanup(); });

  // Die erste Anfrage liegt in der Grenze: sie stoesst die Kompression an.
  await srv.request('/a.js', { 'accept-encoding': 'br' });
  await srv.compressed();
  assert.equal(runs, 1);

  // Jede weitere liegt darueber: sie bekommt ihre Datei wie vor R18 durch
  // express.static und compression() - 200, richtiger Inhalt, richtiger ETag -,
  // aber sie liest nichts in den Speicher und stellt nichts in die Schlange.
  const res = await srv.request('/b.js', { 'accept-encoding': 'br' });
  assert.equal(res.status, 200);
  assert.equal(brotliDecompressSync(res.body).toString(), SCRIPT + 'b.js');
  assert.equal(res.headers.etag, sha(Buffer.from(SCRIPT + 'b.js')));
  assert.equal(runs, 1, 'ueber der Grenze wird nichts komprimiert');
  assert.equal(srv.assets.stats().pending, 0);

  // Auch die schon gespeicherte Fassung kommt dann nicht aus dem Speicher.
  const again = await srv.request('/a.js', { 'accept-encoding': 'br' });
  assert.equal(again.status, 200);
  assert.equal(brotliDecompressSync(again.body).toString(), SCRIPT + 'a.js');
});

test('the path from the address never leaves the folder, however it is spelled', async (t) => {
  const fx = fixture();
  const outside = fixture();
  fx.write('app.js', SCRIPT);
  outside.write('secret.js', SCRIPT + 'secret');
  let runs = 0;
  const compress = (buffer, _options, cb) => { runs += 1; cb(null, buffer.subarray(0, 10)); };
  const srv = await serve(fx.dir, { compress });
  t.after(async () => { await srv.close(); fx.cleanup(); outside.cleanup(); });

  const escape = `/..%2f${path.basename(outside.dir)}/secret.js`;
  for (const urlPath of [escape, `/%2e%2e/${path.basename(outside.dir)}/secret.js`, '/app.js%00.css', '/.hidden.js']) {
    const res = await srv.request(urlPath, { 'accept-encoding': 'br' });
    assert.notEqual(res.status, 200, urlPath);
  }
  await srv.compressed();
  assert.equal(runs, 0);
  assert.equal(srv.assets.stats().files, 0);
});

// --------------------------------------------------------
// 3. Die echte App (dist/): jede Precache-Datei, und die Verdrahtung
// --------------------------------------------------------

test('every precached file of the built app is served with its content ETag, stable across restarts', async (t) => {
  const first = await serve(DIST, { brotli: false });
  const second = await serve(DIST, { brotli: false });
  t.after(async () => { await first.close(); await second.close(); });
  const list = distPrecache();
  assert.ok(list.length >= 150, `nur ${list.length} Precache-Eintraege gelesen`);

  const wrong = [];
  for (const urlPath of list) {
    const res = await first.request(urlPath);
    const file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
    const expected = sha(readFileSync(file));
    const again = await second.request(urlPath, { 'if-none-match': res.headers.etag });
    if (res.status !== 200 || res.headers.etag !== expected || again.status !== 304) {
      wrong.push(`${urlPath} (${res.status}, ${res.headers.etag}, erneut ${again.status})`);
    }
  }
  assert.deepEqual(wrong, [], 'ohne Inhalts-ETag ist die Revalidierung beim Precache nicht sicher');
});

test('the worker revalidates its precache, and the server serves dist/ both ways from one header function', () => {
  const sw = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const install = sw.slice(sw.indexOf("self.addEventListener('install'"), sw.indexOf("self.addEventListener('activate'"));
  // Shell und Rueckfallsprache; einen eigenen Seiten-Cache gibt es seit dem Build nicht mehr.
  assert.equal([...install.matchAll(/cache: 'no-cache'/g)].length, 2);
  assert.doesNotMatch(install, /cache: 'reload'/);

  const index = readFileSync(path.join(import.meta.dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(index, /res\.setHeader\('ETag', staticAssets\.etagFor\(filePath, stat\)\);/);
  assert.match(index, /createStaticAssets\(STATIC_DIR, \{[\s\S]*?setHeaders: setStaticHeaders,\s*\}\);/);
  assert.match(index, /app\.use\(staticStoreLimiter, staticAssets\.middleware\);\s*\n\s*app\.use\(express\.static\(STATIC_DIR, \{[\s\S]*?setHeaders: setStaticHeaders,/,
    'die Speicher-Fassung steht VOR express.static, hinter ihrer Bremse, und teilt dessen Header');
  assert.match(index, /const STATIC_DIR = FRONTEND\.dir \?\?/, 'der Server liefert dist/ (utils/frontend-dir.js), nicht public/');
  assert.doesNotMatch(index, /express\.static\(PUBLIC_DIR|root: path\.join\(import\.meta\.dirname, '\.\.', 'public'\)/, 'ein Weg liefert noch die ungebauten Quellen');
  assert.match(index, /res\.sendFile\('index\.html', \{ root: STATIC_DIR \}\);/);
  // Die Bremse fuehrt ueber der Grenze am Speicher vorbei, statt abzuweisen:
  // ein 429 auf ein Stylesheet oder ein Modul zerlegte die App.
  assert.match(index, /const staticStoreLimiter = rateLimit\(\{[\s\S]*?handler: staticAssets\.overLimit,\s*\}\);/);
  assert.doesNotMatch(index, /app\.use\(staticAssets\.middleware\)/, 'nie ohne die Bremse davor');
  assert.match(index, /process\.env\.STATIC_BROTLI/);
  assert.ok(index.indexOf('app.use(compression());') < index.indexOf('app.use(staticStoreLimiter, staticAssets.middleware);'),
    'compression() bleibt davor - es uebernimmt alles, was nicht aus dem Speicher kommt');
  // Die Startpruefung laeuft als Import vor Sperre und Datenbank (nach dem
  // Secrets-Handschlag, der erste Import bleibt: test:file-secrets).
  const at = index.indexOf("import { FRONTEND } from './utils/require-frontend.js';");
  assert.ok(at > 0 && at < index.indexOf("import './utils/claim-instance-lock.js';") && at < index.indexOf("import * as db from './db.js';"),
    'die Pruefung auf dist/ kommt erst nach Sperre oder Datenbank');
});

test('hashed chunks are immutable for a year, facades, HTML, the worker and copied files revalidate', () => {
  const index = readFileSync(path.join(import.meta.dirname, '..', 'server', 'index.js'), 'utf8');
  const fn = index.slice(index.indexOf('function setStaticHeaders('), index.indexOf('\n}\n', index.indexOf('function setStaticHeaders(')));
  const setHeaders = new Function('path', 'HASHED_DIR', 'staticAssets', `${fn}\n}; return setStaticHeaders;`)(
    path, path.join('/srv/dist', 'assets') + path.sep, { etagFor: () => 'W/"x"' },
  );
  const headerFor = (/** @type {string} */ file) => {
    /** @type {Record<string, string>} */
    const headers = {};
    setHeaders({ setHeader: (/** @type {string} */ k, /** @type {string} */ v) => { headers[k] = v; } }, file, {});
    return headers['Cache-Control'];
  };
  assert.equal(headerFor('/srv/dist/assets/router-Ab12Cd34.js'), 'public, max-age=31536000, immutable');
  assert.equal(headerFor('/srv/dist/assets/router-Ab12Cd34.js.map'), 'public, max-age=31536000, immutable');
  for (const file of ['/srv/dist/api.js', '/srv/dist/i18n.js', '/srv/dist/utils/html.js', '/srv/dist/index.html', '/srv/dist/sw.js', '/srv/dist/styles/layout.css', '/srv/dist/locales/de.json']) {
    assert.equal(headerFor(file), 'no-cache, must-revalidate', file);
  }
});

test('without a build the server refuses to start, under npm run dev it serves no files', () => {
  const root = tempDir('yuvomi-frontend-');
  try {
    assert.throws(() => resolveFrontendDir(root, {}), (err) => err instanceof Error && err.message === MISSING_BUILD_MESSAGE);
    assert.match(MISSING_BUILD_MESSAGE, /npm run build/);
    assert.match(MISSING_BUILD_MESSAGE, /npm run dev/);
    mkdirSync(path.join(root, 'public'), { recursive: true });
    writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html>');
    assert.throws(() => resolveFrontendDir(root, {}), 'public/ allein ist kein Rueckfall');
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html>');
    assert.throws(() => resolveFrontendDir(root, {}), 'ohne dist/sw.js ist der Build unvollstaendig');
    writeFileSync(path.join(root, 'dist', 'sw.js'), '');
    assert.deepEqual(resolveFrontendDir(root, {}), { mode: 'dist', dir: path.join(root, 'dist'), serviceWorker: path.join(root, 'dist', 'sw.js') });
    assert.deepEqual(resolveFrontendDir(root, { YUVOMI_DEV_FRONTEND: 'vite' }), { mode: 'vite-dev', dir: null, serviceWorker: null });
    // Die Testanordnung der Browser-Suiten (YUVOMI_BUILD_LAYOUT=modules) liegt
    // nach test:document-guards in dist/; `npm start` darf sie nicht still
    // ausliefern. Nur wer sie ausdruecklich will (der Harness), bekommt sie.
    mkdirSync(path.join(root, 'dist', '.vite'), { recursive: true });
    writeFileSync(path.join(root, 'dist', '.vite', 'modules.json'), JSON.stringify({ layout: 'modules' }));
    assert.throws(() => resolveFrontendDir(root, {}), (err) => err instanceof Error && /test layout/.test(err.message) && /npm run build/.test(err.message));
    assert.equal(resolveFrontendDir(root, { YUVOMI_BUILD_LAYOUT: 'modules' }).mode, 'dist');
    writeFileSync(path.join(root, 'dist', '.vite', 'modules.json'), JSON.stringify({ layout: 'bundle' }));
    assert.equal(resolveFrontendDir(root, {}).mode, 'dist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('what counts as compressible covers the text types the app ships', () => {
  for (const ext of ['.js', '.mjs', '.css', '.json', '.html', '.svg']) assert.ok(COMPRESSIBLE_EXTENSIONS.has(ext), ext);
  for (const ext of ['.png', '.jpg', '.webp', '.woff2', '.ico']) assert.ok(!COMPRESSIBLE_EXTENSIONS.has(ext), ext);
});

// --------------------------------------------------------
// 4. Kein Schnitt mehr auf der Leitung (seit Phase 1a)
// --------------------------------------------------------

test('what goes out is the file, byte for byte, on every encoding', async (t) => {
  const fx = fixture();
  const code = `/** Modul: ein Kommentar, den frueher der Server schnitt. */\n${SCRIPT}`;
  fx.write('app.js', code);
  const srv = await serve(fx.dir);
  t.after(async () => { await srv.close(); fx.cleanup(); });
  const identity = await srv.request('/app.js', { 'accept-encoding': 'identity' });
  assert.equal(identity.body.toString(), code);
  assert.equal(identity.headers.etag, sha(Buffer.from(code)));
  await srv.request('/app.js', { 'accept-encoding': 'br' });
  await srv.compressed();
  const br = await srv.request('/app.js', { 'accept-encoding': 'br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(br.body).toString(), code);
  assert.equal(br.headers.etag, identity.headers.etag);
  const gz = await srv.request('/app.js', { 'accept-encoding': 'gzip' });
  if (gz.headers['content-encoding'] === 'gzip') assert.equal(gunzipSync(gz.body).toString(), code);
});

test('the comment cutter is gone with the build', () => {
  const lib = readFileSync(path.join(import.meta.dirname, '..', 'server', 'utils', 'static-assets.js'), 'utf8');
  assert.doesNotMatch(lib, /from '\.\/strip-comments\.js'|\bstrip\s*=/, 'static-assets.js schneidet wieder');
  assert.throws(() => statSync(path.join(import.meta.dirname, '..', 'server', 'utils', 'strip-comments.js')), 'strip-comments.js liegt noch da');
});
