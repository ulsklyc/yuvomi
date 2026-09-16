/**
 * Test: Display-Konto und Geraete-Kopplung (#1208, entschieden in #913)
 *
 * Zweck: Ein Wandtablett bekommt ein Konto, das nur ein gekoppeltes Geraet
 *        benutzen kann. Die vier Zusagen aus dem Ticket sind Sicherheitszusagen,
 *        keine Bequemlichkeiten, und sie werden hier einzeln gemessen:
 *          - ein gekoppeltes Display erreicht weder /auth/*, noch
 *            Administratorrouten, noch ein Modul ausserhalb seiner Liste;
 *          - es taucht in keiner Personenliste auf (#1207);
 *          - ein Widerruf endet den Zugang beim NAECHSTEN Request;
 *          - ein Kopplungscode gilt genau einmal und laeuft ab.
 *        Dazu die Anmeldesperre: ein Display meldet sich nicht an, weder mit
 *        Passwort noch ueber SSO.
 *
 * WARUM DER ECHTE SERVER (test/server-ready.js) UND KEIN NACKTER ROUTER. Die
 * ganze Frage dieses Tickets ist, ob die GLOBALEN Gates ein Display genauso
 * behandeln wie ein gescoptes Token - und die haengen in server/index.js
 * zwischen `requireAuth` und den Modul-Routern. Ein Router, den eine Suite
 * selbst einhaengt, sieht sie nie; er waere eine Kopie der Kette, und eine
 * Kopie kann nicht belegen, dass das Original sperrt.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-display-account.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

// DAS VERSUCHSBUDGET IST HOCHGESETZT, NICHT ABGESCHALTET. Der Tausch haengt
// hinter einem Limiter, und die Voreinstellung (fuenf Versuche je Minute) ist
// nach den ersten Koppelversuchen aufgebraucht - die uebrigen Pruefungen haetten
// danach 429 gemessen und nicht die Regel, um die es ihnen geht. Statt den
// Limiter wegzudrehen bekommt er ein Budget, das alle Faelle hier durchlaesst,
// und der letzte Test hier verbraucht es absichtlich: ein Limiter, den keine
// Messung je greifen sieht, ist eine Behauptung.
const RATE_LIMIT_MAX = 40;
const { baseUrl: BASE } = await startTestServer({
  name: 'display-account',
  env: {
    SESSION_SECRET: 'test-display-account-secret-min32chars',
    RATE_LIMIT_MAX_ATTEMPTS: String(RATE_LIMIT_MAX),
    RATE_LIMIT_WINDOW_MS: '60000',
  },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { DISPLAY_COOKIE, DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

/** Ein Request, wie ihn das Tablett stellt: nur das Geraete-Cookie, sonst nichts. */
function asDisplay(token) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function pair(code) {
  const res = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const setCookie = String(res.headers.get('set-cookie') || '');
  const match = setCookie.match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`));
  return { status: res.status, token: match ? decodeURIComponent(match[1]) : null };
}

const admin = as(await login('admin', 'adminpass123'));

// --------------------------------------------------------
// Anlegen und Koppeln
// --------------------------------------------------------
let displayId;
let displayToken;

test('ein Administrator legt ein Display an und koppelt ein Geraet', async () => {
  const created = await admin('POST', '/displays', { display_name: 'Kueche' });
  assert.equal(created.status, 201);
  displayId = created.body.data.id;
  assert.deepEqual(created.body.data.devices, [], 'ein frisches Display hat noch kein Geraet');

  const issued = await admin('POST', `/displays/${displayId}/pairing-code`, {});
  assert.equal(issued.status, 201);
  const code = issued.body.data.code;
  assert.match(code, /^[ACDEFGHJKMNPQRTUVWXY34679]{10}$/, 'zehn Stellen aus dem verwechslungsarmen Alphabet');

  const paired = await pair(code);
  assert.equal(paired.status, 201);
  assert.ok(paired.token, 'das Credential kommt als Cookie, nicht im Rumpf');
  displayToken = paired.token;
});

test('das Credential steht NICHT im Antwortrumpf', async () => {
  // Ein Wert, den der Server setzt und der Browser mitschickt, erreicht kein
  // Skript auf der Seite. Stuende er zusaetzlich im JSON, waere genau das
  // wieder offen - und zwar fuer jedes Snippet, das dort mitliest.
  const created = await admin('POST', '/displays', { display_name: 'Flur' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const res = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: issued.body.data.code }),
  });
  const body = await res.json();
  assert.deepEqual(body, { data: { paired: true } });
});

test('der Kopplungscode gilt genau einmal', async () => {
  const created = await admin('POST', '/displays', { display_name: 'Einmal' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const code = issued.body.data.code;

  assert.equal((await pair(code)).status, 201);
  const again = await pair(code);
  assert.equal(again.status, 400, 'der zweite Versuch bekommt kein zweites Credential');
  assert.equal(again.token, null);
});

test('ein abgelaufener Kopplungscode wird abgewiesen', async () => {
  const created = await admin('POST', '/displays', { display_name: 'Abgelaufen' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  // Die Frist in die Vergangenheit ziehen, statt sie abzuwarten: die Uhr ist
  // hier kein Messgegenstand, die Bedingung ist es.
  db.prepare("UPDATE display_pairing_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?")
    .run(created.body.data.id);

  const res = await pair(issued.body.data.code);
  assert.equal(res.status, 400);
  assert.equal(res.token, null);
});

test('ein neuer Code entwertet den vorherigen', async () => {
  // Zwei offene Codes waeren zwei Schluessel fuer dieselbe Tuer, und der
  // aeltere haenge unbemerkt in der Welt.
  const created = await admin('POST', '/displays', { display_name: 'Zwei Codes' });
  const first = (await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {})).body.data.code;
  const second = (await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {})).body.data.code;

  assert.equal((await pair(first)).status, 400, 'der alte Code ist verfallen');
  assert.equal((await pair(second)).status, 201);
});

test('ein erfundener Code koppelt nichts', async () => {
  assert.equal((await pair('AAAAAAAAAA')).status, 400);
  assert.equal((await pair('')).status, 400);
  assert.equal((await pair('ZU-KURZ')).status, 400);
});

// --------------------------------------------------------
// Was ein gekoppeltes Display darf - und was nicht
// --------------------------------------------------------
test('das Display liest genau die Module seiner Liste', async () => {
  const display = asDisplay(displayToken);
  for (const scope of DISPLAY_SCOPES) {
    assert.equal(scope.endsWith(':read'), true, `${scope} ist in diesem Schritt lesend (#1209 bringt die Aktionen)`);
  }
  assert.equal((await display('GET', '/tasks')).status, 200);
  assert.equal((await display('GET', '/dashboard')).status, 200);
});

test('jedes Modul ausserhalb der Liste ist gesperrt', async () => {
  const display = asDisplay(displayToken);
  for (const path of ['/health/vitals', '/budget/entries', '/documents', '/notes', '/contacts']) {
    const res = await display('GET', path);
    assert.equal(res.status, 403, `${path} muss gesperrt sein, war ${res.status}`);
    assert.match(String(res.body?.error), /scope/i, `${path} muss am Scope-Gate scheitern`);
  }
});

test('das Display schreibt nichts, auch nicht in seinen eigenen Modulen', async () => {
  // Die Scope-Liste ist lesend; `write` schliesst `read` ein, aber nicht
  // umgekehrt. Das globale Gate sperrt deshalb VOR der Route - und damit auch
  // vor der CSRF-Pruefung, die ein Display ohne Sitzung gar nicht bestehen
  // koennte.
  const display = asDisplay(displayToken);
  const res = await display('POST', '/tasks', { title: 'Vom Tablett' });
  assert.equal(res.status, 403);
  // DIE ABSAGE WIRD BENANNT, NICHT NUR DER CODE. Ohne Scope-Gate faellt derselbe
  // Request in die CSRF-Pruefung und bekommt AUCH 403 - der Test waere gruen
  // geblieben, waehrend die Regel, die er prueft, ausgebaut ist (gemessen per
  // Mutation). Erst die Meldung unterscheidet die beiden Sperren.
  assert.match(String(res.body?.error), /scope/i, 'das Scope-Gate sperrt, nicht die CSRF-Pruefung');
});

test('das Display erreicht keine Auth-Route', async () => {
  // Der Auth-Router haengt VOR den globalen Gates (GHSA-xcv5-6w6x-x5q2), also
  // reicht das Scope-Gate dort nicht - er hat seinen eigenen Riegel.
  const display = asDisplay(displayToken);
  for (const [method, path] of [['GET', '/auth/me'], ['GET', '/auth/users'], ['GET', '/auth/api-tokens']]) {
    const res = await display(method, path);
    assert.equal(res.status, 403, `${method} ${path} war ${res.status}`);
  }
});

test('das Display legt kein weiteres Display an und widerruft keines', async () => {
  const display = asDisplay(displayToken);
  assert.equal((await display('GET', '/displays')).status, 403);
  assert.equal((await display('POST', '/displays', { display_name: 'Selbstbedienung' })).status, 403);
  assert.equal((await display('POST', `/displays/${displayId}/pairing-code`, {})).status, 403);
});

test('das Display sieht nur haushaltssichtbare Zeilen, nie private', async () => {
  const privateTask = await admin('POST', '/tasks', { title: 'Geheim', visibility: 'private' });
  assert.equal(privateTask.status, 201);
  const openTask = await admin('POST', '/tasks', { title: 'Fuer alle', visibility: 'all' });
  assert.equal(openTask.status, 201);

  const seen = await asDisplay(displayToken)('GET', '/tasks');
  assert.equal(seen.status, 200);
  const titles = (seen.body.data ?? []).map((t) => t.title);
  assert.ok(titles.includes('Fuer alle'));
  assert.ok(!titles.includes('Geheim'), 'die Sichtbarkeitsregel gilt fuer ein Display wie fuer jeden');
});

// --------------------------------------------------------
// Ein Display ist kein Mensch
// --------------------------------------------------------
test('das Display steht in keiner Personenliste', async () => {
  const members = await admin('GET', '/family/members');
  assert.equal(members.status, 200);
  const ids = (members.body.data ?? []).map((m) => m.id);
  assert.ok(!ids.includes(displayId), 'die Mitgliederliste zeigt kein Wandtablett');

  const options = await admin('GET', '/tasks/meta/options');
  assert.equal(options.status, 200);
  const optionIds = (options.body.data?.users ?? []).map((u) => u.id);
  assert.ok(!optionIds.includes(displayId), 'auch der Zuweisungs-Picker nicht');
});

test('das Display kann nicht als erledigende Person benannt werden (#1205)', async () => {
  // Dieselbe Grenze wie beim Zuweisen: was in keiner Liste steht, darf auch
  // keine Route annehmen - sonst waere die Liste eine Verzierung.
  const task = await admin('POST', '/tasks', { title: 'Nicht vom Tablett' });
  const res = await admin('PATCH', `/tasks/${task.body.data.id}/status`, {
    status: 'done', done_by_user_id: displayId,
  });
  assert.equal(res.status, 400);
});

test('das Display meldet sich nicht mit Passwort an - auch nicht mit einem echten', async () => {
  // DER PLATZHALTER ALLEIN IST KEIN BELEG, und der erste Anlauf dieses Tests
  // war genau das: er warf den Platzhalter als Passwort gegen den Login und sah
  // ihn scheitern - aber das taete jeder Nicht-bcrypt-Wert, auch ohne jede
  // Sperre (per Mutation gemessen: der Test blieb gruen, nachdem die Regel
  // ausgebaut war). Die Sperre ist erst gezeigt, wenn ein Konto mit einem
  // ECHTEN, passenden Hash trotzdem abgewiesen wird.
  //
  // Sie sitzt in `canSignIn()` - demselben Ort, an dem seit
  // GHSA-4jcg-7jvj-p4v9 auch das Personal abgewiesen wird, und damit in einem
  // Zug fuer Passwort-Login, OIDC-Rueckweg und E-Mail-Verknuepfung.
  const row = db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(displayId);
  assert.equal(row.password_hash, '$display$', 'angelegt wird es mit dem Platzhalter');

  const bcrypt = (await import('bcrypt')).default;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync('tabletpass123', 10), displayId);

  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: row.username, password: 'tabletpass123' }),
  });
  assert.notEqual(res.status, 200, 'ein Display meldet sich nicht an, egal was in der Spalte steht');

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('$display$', displayId);
});

// --------------------------------------------------------
// Widerruf
// --------------------------------------------------------
test('ein Widerruf endet den Zugang beim naechsten Request', async () => {
  const display = asDisplay(displayToken);
  assert.equal((await display('GET', '/tasks')).status, 200, 'vorher erreichbar');

  const devices = (await admin('GET', '/displays')).body.data.find((d) => d.id === displayId).devices;
  const active = devices.find((d) => d.revoked_at === null);
  assert.ok(active, 'genau ein aktives Geraet');

  const revoked = await admin('POST', `/displays/${displayId}/devices/${active.id}/revoke`, {});
  assert.equal(revoked.status, 200);

  // Kein Zwischenspeicher, der den Widerruf noch einholen muesste: die Pruefung
  // sieht bei JEDEM Request in die Datenbank.
  assert.equal((await display('GET', '/tasks')).status, 401, 'danach nicht mehr');
});

test('ein widerrufenes Credential faellt nicht auf eine Sitzung zurueck', async () => {
  // Der gefaehrliche Fall: auf dem Tablett hat jemand ausserdem eine Sitzung
  // hinterlassen. Ein widerrufenes Display darf dann NICHT stillschweigend als
  // diese Person weiterlaufen - es soll leer bleiben.
  const session = await login('admin', 'adminpass123');
  const res = await fetch(`${BASE}/api/v1/auth/me`, {
    headers: { Cookie: `${session.cookie}; ${DISPLAY_COOKIE}=${displayToken}` },
  });
  assert.notEqual(res.status, 200);
});

test('ein gekoppeltes Display gewinnt gegen eine daneben liegende Sitzung', async () => {
  // Dieselbe Regel aus der anderen Richtung: die ENGERE Berechtigung gewinnt.
  // Liefe die Sitzung vor, waere ein Tablett, auf dem sich einmal ein Elternteil
  // angemeldet hat, ein vollwertiges Elternkonto an der Kuechenwand.
  const created = await admin('POST', '/displays', { display_name: 'Vorrang' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;
  const session = await login('admin', 'adminpass123');

  const res = await fetch(`${BASE}/api/v1/documents`, {
    headers: { Cookie: `${session.cookie}; ${DISPLAY_COOKIE}=${token}` },
  });
  assert.equal(res.status, 403, 'das Display-Credential fuehrt, nicht die Sitzung');
});

test('ein Display loeschen nimmt seine Geraete mit', async () => {
  const created = await admin('POST', '/displays', { display_name: 'Wegwerf' });
  const id = created.body.data.id;
  const issued = await admin('POST', `/displays/${id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;
  assert.equal((await asDisplay(token)('GET', '/tasks')).status, 200);

  assert.equal((await admin('DELETE', `/displays/${id}`)).status, 200);
  assert.equal((await asDisplay(token)('GET', '/tasks')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM display_devices WHERE user_id = ?').get(id).n, 0);
});

// --------------------------------------------------------
// Der Limiter - absichtlich zuletzt, weil er das Budget aufbraucht
// --------------------------------------------------------
test('geratene Kopplungscodes laufen in die Versuchsgrenze', async () => {
  // Zehn Stellen aus 25 Zeichen sind rund 46 Bit, aber Entropie allein ist
  // keine Sperre: ohne Grenze waere die Viertelstunde Gueltigkeit das einzige
  // Hindernis, und eine Viertelstunde sind viele Versuche.
  let seen429 = false;
  for (let i = 0; i < RATE_LIMIT_MAX + 10 && !seen429; i += 1) {
    const res = await fetch(`${BASE}/api/v1/displays/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AAAAAAAAAA' }),
    });
    if (res.status === 429) seen429 = true;
  }
  assert.equal(seen429, true, 'der Limiter greift, bevor das Raten billig wird');
});
