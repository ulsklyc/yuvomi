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
  // BASE_URL: ohne ihn verschickt /forgot-password keinen Link (#1532).
  env: { SESSION_SECRET: 'test-restore-server-secret-min-32-chars', BASE_URL: 'http://127.0.0.1' },
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

// ---------------------------------------------------------------------------
// Restarbeit #1441
// ---------------------------------------------------------------------------

/**
 * Die Anmeldung an `bcrypt.compare` anhalten: sie hat den Nutzer dann schon
 * gelesen und schreibt die Sitzung erst danach - genau die Luecke, in die ein
 * Restore fallen kann.
 */
async function holdLoginAtPasswordCheck() {
  const bcrypt = (await import('bcrypt')).default;
  const realCompare = bcrypt.compare;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const atCompare = new Promise((resolve) => { reached = resolve; });
  bcrypt.compare = async (...args) => {
    reached();
    await gate;
    return realCompare.apply(bcrypt, args);
  };
  return { atCompare, release, restoreCompare: () => { bcrypt.compare = realCompare; } };
}

/** Eine frische Anmeldung per http.request, damit der Test sie abbrechen kann. */
function startLogin() {
  const body = JSON.stringify({ username: 'admin', password: 'adminpass123' });
  const url = new URL(`${BASE}/api/v1/auth/login`);
  let resolveAnswer;
  const answer = new Promise((resolve) => { resolveAnswer = resolve; });
  const req = http.request({
    host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
  }, (res) => {
    res.resume();
    res.on('end', () => resolveAnswer({ status: res.statusCode, cookie: res.headers['set-cookie'] }));
  });
  req.on('error', () => resolveAnswer({ status: 0, cookie: null }));
  req.end(body);
  return { answer, abort: () => req.destroy() };
}

function sessionCount() {
  return dbmod.get().prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
}

/**
 * Restore starten, waehrend die Anmeldung am Passwortvergleich haengt, und die
 * Anmeldung erst freigeben, wenn der Restore fertig ist - hoechstens nach
 * `holdMs`. Wartet der Restore auf die Anmeldung, laeuft die Frist ab und die
 * Anmeldung schreibt in die ALTE Datenbank; tut er es nicht, schreibt sie nach
 * dem Tausch in die eingespielte.
 */
async function restoreDuringHeldLogin({ abortClient = false, holdMs = 3000 } = {}) {
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  await dbmod.backupToFile(backupPath);
  const sessionsInBackup = sessionCount();
  const held = await holdLoginAtPasswordCheck();
  let restoreOutcome;
  try {
    const login = startLogin();
    await held.atCompare;
    if (abortClient) {
      login.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const restore = dbmod.restoreFromFile(backupPath).then(() => 'eingespielt', (err) => err.reason ?? err.message);
    let timer;
    restoreOutcome = await Promise.race([
      restore.then((outcome) => `vor der Anmeldung ${outcome}`),
      new Promise((resolve) => { timer = setTimeout(() => resolve('wartet auf die Anmeldung'), holdMs); }),
    ]);
    clearTimeout(timer);
    held.release();
    await login.answer;
    await restore;
    // Die Sitzung schreibt express-session beim Beenden der Antwort; einen
    // Tick Luft, falls der Client schon weg ist.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    held.release();
    held.restoreCompare();
  }
  return { restoreOutcome, sessionsInBackup, sessionsAfter: sessionCount() };
}

test('#1441 eine Anmeldung, die vor dem Restore begann, wird abgewartet und schreibt ihre Sitzung nicht in die eingespielte Datenbank', async () => {
  const { restoreOutcome, sessionsInBackup, sessionsAfter } = await restoreDuringHeldLogin();
  assert.equal(sessionsAfter, sessionsInBackup, 'die eingespielte Datenbank traegt genau die Sitzungen des Backups');
  assert.equal(restoreOutcome, 'wartet auf die Anmeldung', 'der Restore wartet die laufende Anmeldung ab');
});

test('#1441 legt der Client waehrend der Anmeldung auf, wird ihr Handler trotzdem abgewartet', async () => {
  const { restoreOutcome, sessionsInBackup, sessionsAfter } = await restoreDuringHeldLogin({ abortClient: true });
  assert.equal(sessionsAfter, sessionsInBackup, 'die eingespielte Datenbank traegt genau die Sitzungen des Backups');
  assert.equal(restoreOutcome, 'wartet auf die Anmeldung', 'der Restore wartet den noch laufenden Handler ab');
});

// ---------------------------------------------------------------------------
// #1532: Arbeit, die nach der Antwort weiterlaeuft
// ---------------------------------------------------------------------------

/**
 * Einen Restore neben einer haengenden Arbeit laufen lassen und die Arbeit erst
 * freigeben, wenn der Restore fertig ist - hoechstens nach `holdMs`. Wartet der
 * Restore auf sie, laeuft die Frist ab; tut er es nicht, ist er vorher fertig.
 */
async function restoreBesideHeldWork(backupPath, release, { holdMs = 3000 } = {}) {
  const restore = dbmod.restoreFromFile(backupPath).then(() => 'eingespielt', (err) => err.reason ?? err.message);
  let timer;
  const outcome = await Promise.race([
    restore.then((result) => `vor der Arbeit ${result}`),
    new Promise((resolve) => { timer = setTimeout(() => resolve('wartet auf die Arbeit'), holdMs); }),
  ]);
  clearTimeout(timer);
  release();
  await restore;
  return outcome;
}

function heldGate() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const atGate = new Promise((resolve) => { reached = resolve; });
  return { gate, atGate, reached, release };
}

async function csrfToken() {
  const res = await fetch(`${BASE}/api/v1/notes`, { headers: { Cookie: COOKIE } });
  const token = res.headers.get('x-csrf-token');
  assert.ok(token, 'Vorbedingung: ein CSRF-Token');
  return token;
}

test('#1532 die Reset-Mail nach der Antwort wird abgewartet und schreibt kein Token in die eingespielte Datenbank', async () => {
  const database = dbmod.get();
  const admin = database.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const contact = database.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(admin.id);
  if (contact) database.prepare("UPDATE contacts SET email = 'admin@example.org' WHERE id = ?").run(contact.id);
  else database.prepare("INSERT INTO contacts (name, email, family_user_id) VALUES ('Admin', 'admin@example.org', ?)").run(admin.id);
  database.prepare('DELETE FROM password_resets').run();

  const { emailService } = await import('../server/services/email.js');
  const real = { isConfigured: emailService.isConfigured, sendMail: emailService.sendMail };
  const held = heldGate();
  let mails = 0;
  emailService.isConfigured = () => true;
  emailService.sendMail = async () => {
    mails += 1;
    held.reached();
    await held.gate;
    return {};
  };
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  let outcome;
  try {
    await dbmod.backupToFile(backupPath);
    const ask = () => fetch(`${BASE}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin' }),
    });
    // Der erste Antrag legt sein Token an und haengt im Versand; der zweite
    // wartet in der Kette auf ihn und legt sein Token erst danach an.
    assert.equal((await ask()).status, 200, 'Vorbedingung: erster Antrag');
    await held.atGate;
    assert.equal((await ask()).status, 200, 'Vorbedingung: zweiter Antrag');
    await new Promise((resolve) => setTimeout(resolve, 50));
    outcome = await restoreBesideHeldWork(backupPath, held.release);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    held.release();
    emailService.isConfigured = real.isConfigured;
    emailService.sendMail = real.sendMail;
  }
  assert.equal(mails >= 1, true, 'Vorbedingung: der Versand wurde erreicht');
  const tokens = dbmod.get().prepare('SELECT COUNT(*) AS n FROM password_resets').get().n;
  assert.equal(tokens, 0, 'die eingespielte Datenbank traegt nur die Tokens des Backups (keine)');
  assert.equal(outcome, 'wartet auf die Arbeit', 'der Restore wartet den Versand nach der Antwort ab');
});

test('#1532 der Erwaehnungs-Push nach der Antwort wird abgewartet und schreibt nicht in die eingespielte Datenbank', async () => {
  const csrf = await csrfToken();
  const headers = { Cookie: COOKIE, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  const created = await fetch(`${BASE}/api/v1/auth/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'bea1532', display_name: 'Bea', password: 'beapass1234' }),
  });
  assert.ok([200, 201].includes(created.status), `Vorbedingung: zweites Mitglied (${created.status} ${await created.text()})`);
  const bea = dbmod.get().prepare("SELECT id FROM users WHERE username = 'bea1532'").get();
  const task = await fetch(`${BASE}/api/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'Erwaehnung #1532' }) });
  assert.equal(task.status, 201, 'Vorbedingung: eine Aufgabe');
  const taskId = (await task.json()).data.id;
  const endpoint = 'https://push.example.org/1532';
  dbmod.get().prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(bea.id, endpoint, 'p256dh-1532', 'auth-1532');

  const webpush = (await import('web-push')).default;
  const realSend = webpush.sendNotification;
  const held = heldGate();
  let pushes = 0;
  webpush.sendNotification = async () => {
    pushes += 1;
    held.reached();
    await held.gate;
    return { statusCode: 201 };
  };
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  let outcome;
  try {
    await dbmod.backupToFile(backupPath);
    const comment = await fetch(`${BASE}/api/v1/tasks/${taskId}/comments`, {
      method: 'POST', headers, body: JSON.stringify({ comment: '@Bea schau mal' }),
    });
    assert.equal(comment.status, 201, 'Vorbedingung: der Kommentar');
    await held.atGate;
    outcome = await restoreBesideHeldWork(backupPath, held.release);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    held.release();
    webpush.sendNotification = realSend;
  }
  assert.equal(pushes, 1, 'Vorbedingung: der Push wurde erreicht');
  const row = dbmod.get().prepare('SELECT last_used_at FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  assert.equal(row?.last_used_at ?? null, null, 'die eingespielte Datenbank traegt den Stand des Backups (nie benutzt)');
  assert.equal(outcome, 'wartet auf die Arbeit', 'der Restore wartet den Push nach der Antwort ab');
});

test('#1532 der Kalender-Sofortversuch beginnt waehrend eines Restores nicht, auch bei geschlossener Verbindung', async () => {
  const outbound = await import('../server/services/calendar-outbound.js');
  const restore = await restoreHeldWhileCopying({ phase: 'closed' });
  let result;
  try {
    assert.equal(dbmod.isDatabaseOpen(), false, 'Vorbedingung: die Verbindung ist zu');
    result = await outbound.flushOutbound().then((value) => value, (err) => ({ geworfen: err.message }));
  } finally {
    restore.release();
    await restore.done;
  }
  assert.deepEqual(result, { success: false, skipped: 'restore_in_progress' });
});

// ---------------------------------------------------------------------------
// #1551: GET-Anfragen, die nach einem await schreiben
// ---------------------------------------------------------------------------

/**
 * Ein Outlook-Konto mit gueltigem Token (kein Refresh noetig) und ein
 * `fetch`, das Graph beantwortet - auf Wunsch erst nach `held.release()`. `?refresh=true` holt die Kalenderliste von Graph
 * und schreibt sie danach in `outlook_calendar_selection` - eine GET-Anfrage,
 * die nach einem await schreibt.
 */
function outlookGraph({ hold = true } = {}) {
  const envKeys = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_REDIRECT_URI'];
  const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.MS_CLIENT_ID = 'client-1551';
  process.env.MS_CLIENT_SECRET = 'secret-1551';
  process.env.MS_REDIRECT_URI = 'http://127.0.0.1/api/v1/calendar/outlook/callback';
  const database = dbmod.get();
  database.prepare('DELETE FROM outlook_calendar_selection').run();
  database.prepare('DELETE FROM outlook_accounts').run();
  const accountId = database.prepare(`
    INSERT INTO outlook_accounts (name, access_token, refresh_token, token_expiry)
    VALUES ('Outlook 1551', 'access-1551', 'refresh-1551', ?)
  `).run(new Date(Date.now() + 60 * 60 * 1000).toISOString()).lastInsertRowid;

  const held = heldGate();
  let graphCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://graph.microsoft.com/')) return realFetch(url, options);
    graphCalls += 1;
    if (hold) {
      held.reached();
      await held.gate;
    }
    return new Response(JSON.stringify({ value: [{ id: 'cal-1551', name: 'Familie', hexColor: '#123456', canEdit: true }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const restoreEnv = () => {
    globalThis.fetch = realFetch;
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  };
  return { accountId, held, graphCalls: () => graphCalls, restoreEnv };
}

test('#1551 eine GET-Anfrage, die nach dem Warten auf Graph schreibt, wird abgewartet und schreibt nicht in die eingespielte Datenbank', async () => {
  const outlook = outlookGraph();
  const backupPath = join(tempDir('yuvomi-test-restore-server-'), 'backup.db');
  let outcome;
  let status;
  try {
    await dbmod.backupToFile(backupPath);
    const request = fetch(`${BASE}/api/v1/calendar/outlook/accounts/${outlook.accountId}/calendars?refresh=true`, {
      headers: { Cookie: COOKIE },
    });
    await outlook.held.atGate;
    outcome = await restoreBesideHeldWork(backupPath, outlook.held.release);
    const res = await request;
    status = res.status;
    await res.arrayBuffer();
  } finally {
    outlook.held.release();
    outlook.restoreEnv();
  }
  assert.equal(outlook.graphCalls(), 1, 'Vorbedingung: die Anfrage hat Graph erreicht');
  assert.equal(status, 200, 'die Anfrage selbst gelingt');
  const rows = dbmod.get().prepare('SELECT COUNT(*) AS n FROM outlook_calendar_selection').get().n;
  assert.equal(rows, 0, 'die eingespielte Datenbank traegt die Kalenderauswahl des Backups (keine)');
  assert.equal(outcome, 'wartet auf die Arbeit', 'der Restore wartet die GET-Anfrage ab');
});

test('#1551 waehrend eines Restores beginnt eine GET-Anfrage, die nach einem await schreibt, gar nicht erst', async () => {
  // Graph antwortet sofort: ohne Abweisung schriebe die Anfrage danach in die
  // gesperrte Verbindung.
  const outlook = outlookGraph({ hold: false });
  const restore = await restoreHeldWhileCopying();
  let status;
  let body;
  try {
    const res = await fetch(`${BASE}/api/v1/calendar/outlook/accounts/${outlook.accountId}/calendars?refresh=true`, {
      headers: { Cookie: COOKIE },
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } finally {
    restore.release();
    await restore.done;
    outlook.restoreEnv();
  }
  assert.equal(status, 503, 'abgewiesen statt nach dem Warten auf Graph in die gesperrte Verbindung zu schreiben');
  assert.equal(body.reason, 'restore_in_progress');
  assert.equal(outlook.graphCalls(), 0, 'Graph wurde gar nicht erst gefragt');
});
