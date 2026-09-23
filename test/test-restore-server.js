/**
 * Test-Suite: der laufende Server waehrend eines Restores (#1431).
 *
 * Waehrend `restoreFromFile()` die Arbeitsdatei kopiert, ist die Verbindung
 * gesperrt (`query_only`). Gemessen am echten Server, im selben Prozess:
 *   - Ein Seitenaufruf mit Sitzung bekommt 200. Die Sitzung schreibt auch bei
 *     Lesezugriffen (`touch`, Nachdatieren des Cookies); vorher endete das mit
 *     SQLITE_READONLY in 500.
 *   - Ein Schreibzugriff bekommt 503 `restore_in_progress`.
 *   - Ein zweiter Restore bekommt 409, bevor sein Upload gelesen wird: der
 *     Request hier schickt einen Bruchteil der angekuendigten Laenge und
 *     bekommt die Antwort trotzdem.
 *
 * Lauf: npm run test:restore-server
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { startTestServer, cookieHeader } from './server-ready.js';
import { tempDir } from './tmp-dir.js';

const { baseUrl: BASE, server } = await startTestServer({
  name: 'restore-server',
  env: { SESSION_SECRET: 'test-restore-server-secret-min-32-chars' },
});
const dbmod = await import('../server/db.js');

after(() => server.close());

const setup = await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
assert.equal(setup.status, 201, 'Vorbedingung: Einrichtung gelingt');
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
assert.equal(login.status, 200, 'Vorbedingung: Anmeldung');
const COOKIE = cookieHeader(login.headers.get('set-cookie'));
assert.ok(COOKIE.includes('yuvomi.sid='), 'Vorbedingung: eine Sitzung');

/** Die Sitzung so stellen, dass `requireAuth` das Cookie nachdatieren will. */
function makeCookieRefreshDue() {
  const database = dbmod.get();
  for (const row of database.prepare('SELECT sid, sess FROM sessions').all()) {
    const sess = JSON.parse(row.sess);
    sess.cookie.expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    database.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), row.sid);
  }
}

/**
 * Einen Restore starten und anhalten: beim Kopieren der Arbeitsdatei
 * (`phase: 'staging'`, Verbindung offen, aber gesperrt) oder beim Anlegen der
 * Rollback-Kopie (`phase: 'closed'`, Verbindung zu).
 * @returns {Promise<{ release: () => void, done: Promise<unknown> }>}
 */
async function restoreHeldWhileCopying({ phase = 'staging' } = {}) {
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const holdAt = phase === 'closed' ? dbmod.getPath() : backupPath;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const copying = new Promise((resolve) => { reached = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === holdAt) {
      reached();
      await gate;
    }
    return realCopyFile(src, dest, mode);
  };
  const done = dbmod.restoreFromFile(backupPath).finally(() => { fsp.copyFile = realCopyFile; });
  await copying;
  assert.equal(dbmod.isRestoreRunning(), true, 'Vorbedingung: der Restore laeuft');
  return { release, done };
}

test('#1431 ein Seitenaufruf mit Sitzung bekommt waehrend eines Restores 200, nicht 500', async () => {
  makeCookieRefreshDue();
  const restore = await restoreHeldWhileCopying();
  let status;
  let body;
  try {
    const res = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
    status = res.status;
    body = await res.text();
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(status, 200, `GET /auth/me waehrend des Restores: ${status} ${body}`);
  // Danach wieder normal - und die Sitzung gilt weiter.
  const after = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
  assert.equal(after.status, 200);
});

test('#1431 ein Schreibzugriff bekommt waehrend eines Restores 503 restore_in_progress', async () => {
  const restore = await restoreHeldWhileCopying();
  let res;
  let body;
  try {
    res = await fetch(`${BASE}/api/v1/notes`, {
      method: 'POST',
      headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'waehrend des Restores' }),
    });
    body = await res.json();
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(res.status, 503);
  assert.equal(body.reason, 'restore_in_progress');
});

test('#1431 ein zweiter Restore bekommt 409, bevor sein Upload gelesen wird', async () => {
  const restore = await restoreHeldWhileCopying();
  let answer;
  try {
    answer = await new Promise((resolve, reject) => {
      const url = new URL(`${BASE}/api/v1/backup/restore`);
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          Cookie: COOKIE,
          'Content-Type': 'application/octet-stream',
          // Angekuendigt 64 MiB, geschickt wird nur der erste Block: kommt
          // eine Antwort, hat der Server nicht auf den Rest gewartet.
          'Content-Length': String(64 * 1024 * 1024),
        },
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('keine Antwort, solange der Upload unvollstaendig ist - der Server liest ihn'));
      }, 5000);
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode, body: text });
        });
      });
      req.on('error', (err) => {
        // Der Server schliesst die Verbindung nach der Antwort; ein EPIPE beim
        // Weiterschreiben ist dann erwartet.
        if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') { clearTimeout(timer); reject(err); }
      });
      req.write(Buffer.alloc(64 * 1024));
    });
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(answer.status, 409, `zweiter Restore: ${answer.status} ${answer.body}`);
  assert.equal(JSON.parse(answer.body).reason, 'restore_in_progress');
});

test('#1431 solange die Verbindung zu ist, bekommt ein Seitenaufruf 503 restore_in_progress statt 500', async () => {
  // Angehalten beim Anlegen der Rollback-Kopie: die Verbindung ist dann zu.
  const restore = await restoreHeldWhileCopying({ phase: 'closed' });
  let api;
  let apiBody;
  let asset;
  let feed;
  try {
    assert.throws(() => dbmod.get(), /Not initialized/, 'Vorbedingung: die Verbindung ist zu');
    api = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
    apiBody = await api.text();
    asset = await fetch(`${BASE}/manifest.json`, { headers: { Cookie: COOKIE } });
    await asset.arrayBuffer();
    feed = await fetch(`${BASE}/feed/calendar/irgendein-token.ics`);
    await feed.arrayBuffer();
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(api.status, 503, `GET /auth/me bei geschlossener Verbindung: ${api.status} ${apiBody}`);
  assert.equal(JSON.parse(apiBody).reason, 'restore_in_progress');
  assert.equal(asset.status, 200, 'statische Dateien laden weiter, auch mit Sitzungs-Cookie');
  assert.equal(feed.status, 503, 'ein Kalender-Feed bekommt 503 statt 500');
  const after = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
  assert.equal(after.status, 200, 'danach wieder normal');
});

test('#1431 ein OAuth-Start waehrend eines Restores bekommt 503, keinen Redirect ohne gespeicherten state', async () => {
  const restore = await restoreHeldWhileCopying();
  let res;
  let body;
  try {
    res = await fetch(`${BASE}/api/v1/calendar/outlook/auth`, { headers: { Cookie: COOKIE }, redirect: 'manual' });
    body = await res.text();
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(res.status, 503, `OAuth-Start: ${res.status} ${body}`);
  assert.equal(JSON.parse(body).reason, 'restore_in_progress');
});

test('#1431 eine schreibende Anfrage, die vor dem Restore begann, wird abgewartet und landet nicht in der neuen Datenbank', async () => {
  const me = await fetch(`${BASE}/api/v1/notes`, { headers: { Cookie: COOKIE } });
  const csrf = me.headers.get('x-csrf-token');
  assert.ok(csrf, 'Vorbedingung: ein CSRF-Token');
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const marker = `waehrend-des-restores-${Date.now()}`;
  const body = JSON.stringify({ title: 'Upload', content: marker });
  const order = [];
  // Der Restore darf nicht fertig werden, bevor die Anfrage beantwortet ist:
  // sonst liefe sie ganz danach und waere schlicht eine spaetere Anfrage.
  let answered;
  const requestDone = new Promise((resolve) => { answered = resolve; });
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    if (String(src) === backupPath) {
      order.push('Restore kopiert');
      await requestDone;
    }
    return realCopyFile(src, dest, mode);
  };
  let restore;
  let answer;
  try {
    answer = await new Promise((resolve, reject) => {
      const url = new URL(`${BASE}/api/v1/notes`);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: {
          Cookie: COOKIE, 'X-CSRF-Token': csrf,
          'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => { order.push('Anfrage fertig'); answered(); resolve({ status: res.statusCode, body: text }); });
      });
      req.on('error', reject);
      // Kopf und die erste Haelfte: die Anfrage ist zugelassen, der Koerper
      // (wie ein Upload) noch unterwegs.
      req.write(body.slice(0, 10));
      setTimeout(() => {
        restore = dbmod.restoreFromFile(backupPath);
        setTimeout(() => req.end(body.slice(10)), 300);
      }, 200);
    });
    await restore;
  } finally {
    answered();
    fsp.copyFile = realCopyFile;
  }
  // Zwei zulaessige Ausgaenge: die Anfrage war schon festgehalten und lief vor
  // dem Restore zu Ende (landet in der alten Datenbank), oder sie las ihren
  // Koerper noch, als der Restore begann, und wird abgewiesen. Nie: Erfolg
  // nach dem Kopieren, also in der neuen Datenbank.
  if ([200, 201].includes(answer.status)) {
    assert.deepEqual(order, ['Anfrage fertig', 'Restore kopiert'], 'erst die Anfrage, dann der Restore');
  } else {
    assert.equal(answer.status, 503, `abgewiesen: ${answer.status} ${answer.body}`);
    assert.equal(JSON.parse(answer.body).reason, 'restore_in_progress');
  }
  const inNewDb = dbmod.get().prepare('SELECT COUNT(*) AS n FROM notes WHERE content = ?').get(marker).n;
  assert.equal(inNewDb, 0, 'die Notiz steht nicht in der eingespielten Datenbank');
});

/** POST mit halbem Koerper; `finish()` schickt den Rest und liefert die Antwort. */
function slowPost(path, { cookie, csrf, body }) {
  const url = new URL(`${BASE}${path}`);
  let resolveAnswer;
  const answer = new Promise((resolve) => { resolveAnswer = resolve; });
  const headers = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolveAnswer({ status: res.statusCode, body: text }));
  });
  req.on('error', () => resolveAnswer({ status: 0, body: '' }));
  req.write(body.slice(0, 5));
  return { finish: () => { req.end(body.slice(5)); return answer; } };
}

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => 'fertig'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('haengt'), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test('#1431 eine unangemeldete Anfrage mit langsamem Koerper haelt den Restore nicht auf', async () => {
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const slow = slowPost('/api/v1/notes', { body: JSON.stringify({ content: 'von aussen' }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restore = dbmod.restoreFromFile(backupPath);
  const outcome = await within(restore, 5000);
  await slow.finish();
  await restore;
  assert.equal(outcome, 'fertig', 'der Restore darf nicht auf eine unangemeldete Anfrage warten');
});

test('#1431 ein Restore ueber /api/v1/backup/restore/ (mit Schraegstrich) wartet nicht auf sich selbst', async () => {
  const me = await fetch(`${BASE}/api/v1/notes`, { headers: { Cookie: COOKIE } });
  const csrf = me.headers.get('x-csrf-token');
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const { readFileSync } = await import('node:fs');
  const upload = fetch(`${BASE}/api/v1/backup/restore/`, {
    method: 'POST',
    headers: { Cookie: COOKIE, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
    body: readFileSync(backupPath),
    signal: AbortSignal.timeout(15000),
  });
  let res;
  try {
    res = await upload;
  } catch (err) {
    assert.fail(`der Restore haengt (wartet auf seine eigene Anfrage): ${err.name}`);
  }
  const body = await res.text();
  assert.equal(res.status, 200, `Restore mit Schraegstrich: ${res.status} ${body}`);
});
