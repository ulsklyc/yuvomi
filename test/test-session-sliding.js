/**
 * Test: Die Sitzung gleitet - 90 Tage ohne Benutzung, das Cookie gedrosselt
 *
 * Zweck: #1356, entschieden in D#1242. Vorher war jede Anmeldung sieben Tage
 *        nach dem Login zu Ende, auch bei taeglicher Benutzung: der Store
 *        verlaengerte sich bei jedem Request, das Cookie im Browser nie
 *        (`express-session` ohne `rolling` schickt bei unveraenderter Sitzung
 *        kein neues `Set-Cookie`). Jetzt datiert `requireAuth` das Cookie auf
 *        jetzt + 90 Tage, aber hoechstens alle zwoelf Stunden - dieselbe Drossel
 *        wie beim Wandtablett.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Nach mehr als zwoelf Stunden datiert ein authentifizierter Request das
 *      Cookie auf jetzt + 90 Tage. Das ist der Fehler aus dem Ticket.
 *   2. Innerhalb von zwoelf Stunden kommt KEIN neues Session-Cookie - weder
 *      nach der Anmeldung noch nach einer Auffrischung. Sonst stuende die
 *      Session-ID in jeder Antwort.
 *   3. Statische Dateien datieren nie, und sie verbrauchen die Frist auch
 *      nicht: der naechste API-Request frischt trotzdem auf. `rolling: true`
 *      waere hier rot, weil die Session-Middleware VOR den statischen Dateien
 *      haengt.
 *   4. Alle Lebensdauern sind dieselbe: Session-Cookie beim Login, beim
 *      Auffrischen und bei der oikos.sid-Uebernahme, CSRF-Cookie beim Login,
 *      in `/auth/me` und in der CSRF-Middleware - und der Store-Eintrag laeuft
 *      nie VOR dem Cookie ab.
 *   5. Eine Bestandssitzung mit der alten Woche rueckt sofort auf 90 Tage vor.
 *   6. Eine faellige Auffrischung in einem Request, waehrend dessen die
 *      Sitzung widerrufen wird, legt die geloeschte Zeile nicht neu an
 *      (Review zu #1407: `set()` ist ein `INSERT OR REPLACE`).
 *
 * DIE UHR IST GEMOCKT, NUR `Date`. Der Server laeuft im selben Prozess
 * (`server-ready.js`), also sehen express-session, der Session-Store und die
 * Routen dieselbe Uhr wie der Test. Timer bleiben echt, sonst stuende der
 * HTTP-Server. Die Startzeit ist eine ganze Sekunde, weil `Expires` nur
 * sekundengenau im Kopf steht - so laesst sich exakt vergleichen.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-session-sliding.js
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, cookieHeader } from './server-ready.js';

// Die Entscheidung aus D#1242 als Zahl, bewusst NICHT aus dem Servercode
// importiert: der Test soll die Zusage messen, nicht die Konstante nachsprechen.
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NINETY_DAYS = 90 * DAY;

const { baseUrl: BASE } = await startTestServer({
  name: 'session-sliding',
  env: { SESSION_SECRET: 'test-session-sliding-secret-min32chars' },
});
const db = (await import('../server/db.js')).get();

const T0 = Math.floor(Date.now() / 1000) * 1000;
mock.timers.enable({ apis: ['Date'], now: T0 });
/** Die gemockte Uhr auf T0 + offset stellen. */
function clockAt(offset) {
  mock.timers.setTime(T0 + offset);
}

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

/** Alle Set-Cookie-Zeilen eines Namens. */
function setCookieLines(res, name) {
  return (res.headers.getSetCookie?.() ?? []).filter((line) => line.startsWith(`${name}=`));
}

/** Ablaufzeitpunkt einer Set-Cookie-Zeile in ms; `Max-Age` geht vor `Expires`, wie im Browser. */
function expiryOf(line, now) {
  const maxAge = /;\s*Max-Age=(\d+)/i.exec(line);
  if (maxAge) return now + Number(maxAge[1]) * 1000;
  const expires = /;\s*Expires=([^;]+)/i.exec(line);
  assert.ok(expires, `Cookie ohne Ablauf (waere ein Sitzungscookie): ${line}`);
  return Date.parse(expires[1]);
}

/** Store-Ablauf der einen Sitzung, die zu diesem Cookie gehoert. */
function storeExpiry(cookie) {
  const signed = decodeURIComponent(/yuvomi\.sid=([^;]+)/.exec(cookie)[1]);
  const sid = signed.slice(2, signed.lastIndexOf('.'));
  const row = db.prepare('SELECT expired_at FROM sessions WHERE sid = ?').get(sid);
  assert.ok(row, 'Sitzung steht im Store');
  return row.expired_at;
}

async function login(at) {
  clockAt(at);
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
  });
  assert.equal(res.status, 200, 'Anmeldung');
  return res;
}

async function me(cookie, at) {
  clockAt(at);
  const res = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, `/auth/me bei T0+${(at / HOUR).toFixed(1)}h`);
  return res;
}

test('nach mehr als zwoelf Stunden datiert ein Request das Cookie auf jetzt + 90 Tage', async () => {
  const cookie = cookieHeader((await login(0)).headers.get('set-cookie'));
  const at = 13 * HOUR;
  const res = await me(cookie, at);
  const lines = setCookieLines(res, 'yuvomi.sid');
  assert.ok(lines.length > 0, 'die Antwort traegt ein neues Session-Cookie');
  for (const line of lines) {
    assert.equal(expiryOf(line, T0 + at), T0 + at + NINETY_DAYS, `neu datiert auf jetzt + 90 Tage: ${line}`);
  }
  // Der Store zieht mit - auf den Millisekundenwert, den das Cookie traegt.
  assert.equal(storeExpiry(cookie), T0 + at + NINETY_DAYS, 'Store-Ablauf == Cookie-Ablauf');
});

test('innerhalb von zwoelf Stunden kommt kein neues Session-Cookie', async () => {
  const loginRes = await login(0);
  const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
  const [loginLine] = setCookieLines(loginRes, 'yuvomi.sid');
  assert.equal(expiryOf(loginLine, T0), T0 + NINETY_DAYS, 'die Anmeldung stellt 90 Tage aus');

  for (const at of [1 * HOUR, 11 * HOUR + 59 * 60 * 1000]) {
    const res = await me(cookie, at);
    assert.deepEqual(setCookieLines(res, 'yuvomi.sid'), [], `kein Session-Cookie bei T0+${at / HOUR}h`);
  }
  // Nach der Auffrischung beginnt die Frist neu: 13h frischt auf, 14h nicht.
  assert.ok(setCookieLines(await me(cookie, 13 * HOUR), 'yuvomi.sid').length > 0, 'Auffrischung bei 13h');
  assert.deepEqual(setCookieLines(await me(cookie, 14 * HOUR), 'yuvomi.sid'), [], 'keine zweite Auffrischung eine Stunde spaeter');
});

test('statische Dateien datieren nie und verbrauchen die Frist nicht', async () => {
  const cookie = cookieHeader((await login(0)).headers.get('set-cookie'));
  clockAt(20 * HOUR);
  for (const path of ['/', '/index.html', '/styles/tokens.css', '/manifest.json']) {
    const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, `${path} ist erreichbar`);
    await res.arrayBuffer();
    assert.deepEqual(setCookieLines(res, 'yuvomi.sid'), [], `${path} traegt kein Session-Cookie`);
  }
  // Die Frist ist noch da: der naechste API-Request frischt auf.
  const res = await me(cookie, 20 * HOUR);
  assert.ok(setCookieLines(res, 'yuvomi.sid').length > 0, 'der API-Request danach frischt auf');
});

test('Session-Cookie, CSRF-Cookie und Store teilen eine Lebensdauer', async () => {
  const loginRes = await login(0);
  const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
  const expiries = [];
  const collect = (res, name, now, where) => {
    const lines = setCookieLines(res, name);
    assert.ok(lines.length > 0, `${where} setzt ${name}`);
    for (const line of lines) expiries.push([where, name, expiryOf(line, now) - now]);
  };

  collect(loginRes, 'yuvomi.sid', T0, 'Login');
  collect(loginRes, 'csrf-token', T0, 'Login');

  const meRes = await me(cookie, 1 * HOUR);
  collect(meRes, 'csrf-token', T0 + HOUR, '/auth/me');

  // Eine Route hinter der CSRF-Middleware (erkennbar am X-CSRF-Token-Kopf).
  clockAt(2 * HOUR);
  const tasks = await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: cookie } });
  await tasks.arrayBuffer();
  assert.ok(tasks.headers.get('x-csrf-token'), 'die CSRF-Middleware lief');
  collect(tasks, 'csrf-token', T0 + 2 * HOUR, 'csrfMiddleware');

  // Die Uebernahme eines alten oikos.sid-Cookies setzt yuvomi.sid von Hand.
  const legacy = cookie.replace('yuvomi.sid=', 'oikos.sid=');
  const legacyRes = await me(legacy, 3 * HOUR);
  collect(legacyRes, 'yuvomi.sid', T0 + 3 * HOUR, 'oikos.sid-Uebernahme');

  const falsch = expiries.filter(([, , ms]) => ms !== NINETY_DAYS);
  assert.deepEqual(falsch, [], 'jede Lebensdauer ist 90 Tage');

  // Der Store laeuft nie VOR dem Cookie ab (sonst fuehrte ein gueltiges Cookie
  // ins Leere) und hoechstens eine Drosselfrist danach.
  const cookieExpiry = expiryOf(setCookieLines(loginRes, 'yuvomi.sid')[0], T0);
  const store = storeExpiry(cookie);
  assert.ok(store >= cookieExpiry, `Store (${store}) nicht vor dem Cookie (${cookieExpiry})`);
  assert.ok(store - cookieExpiry <= 12 * HOUR, 'Store hoechstens zwoelf Stunden nach dem Cookie');
});

test('eine Sitzung von vor #1356 rueckt beim ersten Request auf 90 Tage vor', async () => {
  // Bestandssitzungen tragen die alte Woche als `originalMaxAge` und als
  // Ablauf (`sess.cookie.expires`). express-session setzt am Ende auf
  // `originalMaxAge` zurueck; wer nur `maxAge` umstellt, schickt wieder sieben
  // Tage hinaus.
  const cookie = cookieHeader((await login(0)).headers.get('set-cookie'));
  const signed = decodeURIComponent(/yuvomi\.sid=([^;]+)/.exec(cookie)[1]);
  const sid = signed.slice(2, signed.lastIndexOf('.'));
  const row = db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid);
  const sess = JSON.parse(row.sess);
  sess.cookie.originalMaxAge = 7 * DAY;
  sess.cookie.expires = new Date(T0 + 7 * DAY).toISOString();
  db.prepare('UPDATE sessions SET sess = ?, expired_at = ? WHERE sid = ?')
    .run(JSON.stringify(sess), T0 + 7 * DAY, sid);

  const at = 1 * HOUR;
  const lines = setCookieLines(await me(cookie, at), 'yuvomi.sid');
  assert.ok(lines.length > 0, 'die Bestandssitzung wird sofort aufgefrischt');
  for (const line of lines) {
    assert.equal(expiryOf(line, T0 + at), T0 + at + NINETY_DAYS, `90 Tage statt der alten Woche: ${line}`);
  }
  assert.equal(storeExpiry(cookie), T0 + at + NINETY_DAYS, 'der Store zieht mit');
});

test('eine faellige Auffrischung holt eine widerrufene Sitzung nicht zurueck', async () => {
  // DAS RENNEN AUS DEM REVIEW ZU #1407. Ein Request ist schon an `requireAuth`
  // vorbei und wartet in seinem Handler, waehrend die Sitzung widerrufen wird
  // (`invalidateUserSessions`, Passwort-Reset, 2FA, Kontoloeschung - alle
  // loeschen die Zeile). War er faellig und hat die Auffrischung `req.session`
  // veraendert, nimmt express-session am Ende `set()` statt `touch()`, und das
  // `INSERT OR REPLACE` legt die geloeschte Zeile fuer 90 Tage neu an.
  //
  // Der Halt ist eine Middleware direkt HINTER `requireAuth` im echten Stapel:
  // sie wartet auf ein Versprechen, das der Test erst nach dem DELETE einloest.
  const { default: app } = await import('../server/index.js');
  const { requireAuth } = await import('../server/auth.js');
  let release;
  let arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { arrived = resolve; });
  app.use('/api/v1', async (req, res, next) => {
    if (req.headers['x-test-hold'] !== '1') return next();
    arrived();
    await gate;
    next();
  });
  const stack = app.router.stack;
  const hold = stack.pop();
  const authAt = stack.findIndex((layer) => layer.handle === requireAuth);
  assert.ok(authAt >= 0, 'requireAuth steht im Stapel');
  stack.splice(authAt + 1, 0, hold);

  try {
    const cookie = cookieHeader((await login(0)).headers.get('set-cookie'));
    const signed = decodeURIComponent(/yuvomi\.sid=([^;]+)/.exec(cookie)[1]);
    const sid = signed.slice(2, signed.lastIndexOf('.'));

    clockAt(13 * HOUR); // faellig
    const pending = fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: cookie, 'x-test-hold': '1' } });
    await reached;
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); // der Widerruf
    release();
    const res = await pending;
    await res.arrayBuffer();

    const row = db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(sid);
    assert.equal(row, undefined, 'die widerrufene Sitzung bleibt geloescht');
    clockAt(13 * HOUR + 60_000);
    const direct = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(direct.status, 401, 'der Folgerequest mit dem alten Cookie wird abgewiesen');
  } finally {
    stack.splice(stack.indexOf(hold), 1);
    release();
  }
});

test('keine ausgeschriebene Lebensdauer neben der Konstante', () => {
  // DER TEXTGUARD DECKT, WAS KEIN REQUEST ERREICHT: den Fallback im Store
  // (`sess.cookie?.maxAge ?? ...`), der nur ohne Cookie-Daten greift. Jede
  // Code-Zeile mit `maxAge` in den beiden Dateien muss die Konstante nennen.
  // Kommentare werden VOR der Pruefung abgeschnitten, damit ein
  // `// SESSION_MAX_AGE_MS` hinter einem Literal nicht gruen macht; reine
  // Kommentarzeilen sind kein lebender Wert und fallen weg.
  const abweichungen = [];
  for (const datei of ['server/auth.js', 'server/middleware/csrf.js']) {
    const quelle = readFileSync(new URL(`../${datei}`, import.meta.url), 'utf8');
    let imBlock = false;
    quelle.split('\n').forEach((zeile, i) => {
      let code = zeile;
      if (imBlock) {
        const ende = code.indexOf('*/');
        if (ende === -1) return;
        code = code.slice(ende + 2);
        imBlock = false;
      }
      code = code.replace(/\/\*.*?\*\//g, '');
      const start = code.indexOf('/*');
      if (start !== -1) { code = code.slice(0, start); imBlock = true; }
      code = code.replace(/\/\/.*$/, '');
      if (!/\bmaxAge\b/.test(code)) return;
      if (/\bmaxAge\s*[:=?]/.test(code) && !code.includes('SESSION_MAX_AGE_MS')) {
        abweichungen.push(`${datei}:${i + 1}: ${zeile.trim()}`);
      }
    });
  }
  assert.deepEqual(abweichungen, [], 'jede maxAge-Zuweisung nennt SESSION_MAX_AGE_MS');
});
