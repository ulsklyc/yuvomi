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
  try {
    assert.throws(() => dbmod.get(), /Not initialized/, 'Vorbedingung: die Verbindung ist zu');
    api = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: COOKIE } });
    apiBody = await api.text();
    asset = await fetch(`${BASE}/manifest.json`, { headers: { Cookie: COOKIE } });
    await asset.arrayBuffer();
  } finally {
    restore.release();
    await restore.done;
  }
  assert.equal(api.status, 503, `GET /auth/me bei geschlossener Verbindung: ${api.status} ${apiBody}`);
  assert.equal(JSON.parse(apiBody).reason, 'restore_in_progress');
  assert.equal(asset.status, 200, 'statische Dateien laden weiter, auch mit Sitzungs-Cookie');
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
