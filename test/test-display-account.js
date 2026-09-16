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

test('das Display erreicht keine Auth-Route ausser der eigenen Zeile', async () => {
  // Der Auth-Router haengt VOR den globalen Gates (GHSA-xcv5-6w6x-x5q2), also
  // reicht das Scope-Gate dort nicht - er hat seinen eigenen Riegel.
  const display = asDisplay(displayToken);
  for (const [method, path] of [
    ['GET', '/auth/users'], ['GET', '/auth/api-tokens'], ['GET', '/auth/oidc/config'],
    ['POST', '/auth/logout'], ['POST', '/auth/api-tokens'],
  ]) {
    const res = await display(method, path);
    assert.equal(res.status, 403, `${method} ${path} war ${res.status}`);
  }
});

test('das Display darf genau die drei Geruestpfade LESEN, und nur lesend', async () => {
  // Ohne sie startet die App auf dem Tablett nicht: der Auth-Guard in
  // public/router.js fragt `/auth/me` als erstes und wirft bei einem Fehler auf
  // die Anmeldeseite. Im Browser gemessen - jeder Endpunkt fuer sich verhielt
  // sich richtig, und die Wand blieb trotzdem leer.
  //
  // Keiner der drei liefert Haushaltsdaten: die eigene Zeile, die
  // Darstellungseinstellungen, die Modulliste. Dasselbe Zugestaendnis hat der
  // Ausgaben-Gast schon.
  const display = asDisplay(displayToken);
  for (const path of ['/auth/me', '/preferences', '/modules']) {
    assert.equal((await display('GET', path)).status, 200, `${path} muss lesbar sein`);
  }
  // Exakt, nicht als Praefix - und nur GET.
  assert.equal((await display('GET', '/permissions/catalog')).status, 403);
  assert.equal((await display('PATCH', '/preferences', { week_start: 1 })).status, 403);
});

test('die Rechte-Nutzlast traegt die Scope-Liste als Modulrechte', async () => {
  // DIE OBERFLAECHE HAENGT DARAN, NICHT AN EINER ZWEITEN LISTE IM FRONTEND. Die
  // Uebersicht bot dem Tablett Kacheln fuer Geburtstage, Budget und Notizen an,
  // die der Server dann leer liess (im Browser gesehen). Statt einer
  // Display-Sonderabfrage im Dashboard loest `resolvePermissions()` die
  // Scope-Liste in Modulrechte auf - und Navigation, Kacheln und der
  // Anlege-Knopf folgen derselben Quelle wie fuer jedes eingeschraenkte
  // Mitglied auch.
  const me = await asDisplay(displayToken)('GET', '/auth/me');
  assert.equal(me.status, 200);
  const modules = me.body.permissions.modules;

  for (const key of ['calendar', 'tasks', 'rewards']) {
    assert.equal(modules[key], 'read', `${key} muss lesbar sein`);
  }
  for (const key of ['budget', 'documents', 'health', 'notes', 'shopping', 'housekeeping']) {
    assert.equal(modules[key], 'none', `${key} muss gesperrt sein`);
  }
  // `read` und nicht `write`: daran haengt, dass der Anlege-Knopf verschwindet.
  assert.ok(!Object.values(modules).includes('write'), 'ein Display schreibt in keinem Modul');
});

test('gesperrte Module nehmen ihre Kacheln mit', async () => {
  // Die Vererbung stand schon da ("Widgets erben die Modulsperre") - sie greift
  // nur, weil die Verengung VOR ihr laeuft. Steht sie danach, sind die Module
  // gesperrt und die Kacheln trotzdem sichtbar.
  const me = await asDisplay(displayToken)('GET', '/auth/me');
  const widgets = me.body.permissions.widgets;
  for (const id of ['budget', 'notes', 'shopping', 'health']) {
    assert.equal(widgets[id], 'none', `Kachel ${id} muss gesperrt sein`);
  }
});

test('eine gespeicherte Rechtezeile kann ein Display nicht aufbohren', async () => {
  // Die Verengung steht NACH den beiden apply()-Durchgaengen: was ein Display
  // darf, ist eine Produktentscheidung und kein Feld, das ein Administrator
  // setzen kann. Hier wird genau das versucht.
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'documents', 'write')
  `).run(String(displayId));

  const me = await asDisplay(displayToken)('GET', '/auth/me');
  assert.equal(me.body.permissions.modules.documents, 'none', 'die gespeicherte Zeile wird ueberschrieben');
  assert.equal((await asDisplay(displayToken)('GET', '/documents')).status, 403);

  db.prepare("DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'documents'")
    .run(String(displayId));
});

test('ein Display zaehlt als Mitleser, sonst verschwinden die Sichtbarkeitsfelder', async () => {
  // DER GEFAEHRLICHSTE DER SIEBEN BEFUNDE. `othersCanRead()` zaehlte nur Konten
  // mit `access_scope = 'family'`. In einem Ein-Personen-Haushalt MIT Tablett
  // meldete die Antwort damit "niemand sonst liest mit", `hidesPrivacyControls()`
  // blendete die Sichtbarkeitsauswahl aus, jeder neue Eintrag blieb auf „alle" -
  // und stand an der Kuechenwand, ohne dass die Person ihn haette privat stellen
  // koennen. Genau die stille Preisgabe, gegen die DECISIONS 1 gebaut ist.
  const me = await admin('GET', '/auth/me');
  assert.equal(me.status, 200);
  const canRead = me.body.othersCanRead ?? [];
  assert.ok(canRead.includes('tasks'), 'das Tablett liest Aufgaben mit');
  assert.ok(canRead.includes('calendar'), 'und den Kalender');
  // MIT SEINEN Rechten aufgeloest, nicht mit denen eines Mitglieds: was ein
  // Display nicht lesen darf, darf die Felder auch nicht stehen lassen.
  assert.ok(!canRead.includes('health'), 'Gesundheit liest es nicht - dort bleibt es beim Solo-Fall');
});

test('ein kaputtes Cookie ist kein Credential, sondern ein 401', async () => {
  // `decodeURIComponent` WIRFT bei einer kaputten Prozentfolge, und der Leser
  // haengt an zwei unauthentifizierten Stellen. Ein Browser mit
  // `Cookie: yuvomi.display=%` bekaeme sonst auf JEDEN Request ein 500 - auch
  // auf die Anmeldung, also ohne jeden Weg zurueck.
  for (const kaputt of ['%', '%zz', '%E0%A4']) {
    const res = await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: `${DISPLAY_COOKIE}=${kaputt}` } });
    assert.equal(res.status, 401, `"${kaputt}" muss 401 sein, war ${res.status}`);
  }
  // Und die Anmeldung bleibt erreichbar - das ist der Punkt.
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=%` },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
  });
  assert.equal(login.status, 200, 'ein unlesbares Cookie darf keinen Menschen aussperren');
});

test('das Display erreicht kein MCP-Werkzeug', async () => {
  // `/mcp` liegt bewusst ausserhalb der /api/v1-Gates, und der Display-Zweig in
  // `requireAuth` setzt Scopes unabhaengig vom Pfad. Ohne eigenen Riegel
  // erreichte ein Tablett hier `list_api_operations` und `get_api_operation` -
  // beide ohne `scope`, also an der Scope-Pruefung vorbei - und bekaeme den
  // vollstaendigen OpenAPI-Katalog samt Administratorrouten, den `/openapi.json`
  // ueber REST nur Administratoren zeigt.
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=${displayToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.json().catch(() => null);
  const namen = (body?.result?.tools ?? []).map((t) => t.name);
  assert.deepEqual(namen, [], `ein Display darf kein Werkzeug sehen, sah: ${namen.join(', ')}`);
});

test('das Display steht nicht in der Kontenverwaltung', async () => {
  // `GET /auth/users` ist die Kontenliste, und die Familien-Seite rendert jede
  // Zeile daraus als bearbeitbares Familienmitglied - mit Familienrolle,
  // Loeschknopf und, beim Speichern, einem Kontakt und einem Geburtstag fuer
  // das Geraet. Ein Display gehoert dort nicht hin; es hat seine eigene Seite.
  const users = await admin('GET', '/auth/users');
  assert.equal(users.status, 200);
  const ids = (users.body.data ?? []).map((u) => u.id);
  assert.ok(!ids.includes(displayId), 'kein Wandtablett in der Kontenverwaltung');
  assert.ok(ids.length > 0, 'die Menschen stehen weiterhin drin');
});

test('das Display liest keine Abo-URLs, ein Mensch schon', async () => {
  // EINE QUELL-URL IST EIN ZUGANGSDATUM. Private Kalenderfeeds tragen ihr
  // Geheimnis regelmaessig IM Pfad - wer sie liest, hat den Kalender dauerhaft,
  // auch nachdem das Tablett laengst widerrufen wurde. Die Luecke gab es vor
  // diesem Ticket schon fuer ein gescoptes Token mit `calendar:read`; gemessen
  // wird deshalb an den Scopes, nicht an der Anmeldeart.
  const created = await admin('POST', '/calendar/subscriptions', {
    name: 'Schulferien', url: 'https://example.invalid/feed.ics?token=geheim', color: '#6366f1', shared: 1,
  });
  assert.ok([200, 201].includes(created.status), `Abo anlegen: ${created.status}`);

  const alsMensch = await admin('GET', '/calendar/subscriptions');
  assert.equal(alsMensch.status, 200);
  assert.ok(alsMensch.body.data.some((sub) => typeof sub.url === 'string'),
    'wer ein Abo bearbeiten darf, sieht seine URL weiterhin');

  const alsDisplay = await asDisplay(displayToken)('GET', '/calendar/subscriptions');
  assert.equal(alsDisplay.status, 200, 'die Liste selbst bleibt lesbar - nur das Geheimnis nicht');
  for (const sub of alsDisplay.body.data ?? []) {
    assert.ok(!('url' in sub), 'die Quell-URL darf ein Display nicht erreichen');
  }
  assert.ok((alsDisplay.body.data ?? []).some((sub) => sub.name === 'Schulferien'),
    'der Name bleibt, damit der Kalender weiter beschriftet ist');
});

test('die eigene Zeile nennt das Display als das, was es ist', async () => {
  // `access_scope` traegt die dritte Auspraegung, und das Frontend haengt daran:
  // die schmale Navigation in public/router.js entscheidet danach, ob sie vier
  // Eintraege zeigt oder die volle Mitglieder-Leiste.
  const me = await asDisplay(displayToken)('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.access_scope, 'display');
  assert.equal(me.body.user.id, displayId);
  assert.equal(me.body.user.onboarding_pending, false, 'die Begruessungstour gilt fuer Menschen');
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

test('ein widerrufenes Credential raeumt sein Cookie ab', async () => {
  // SONST IST DAS GERAET FUER IMMER UNBRAUCHBAR: das Cookie ist httpOnly, kein
  // Skript der Seite kommt daran, und der Display-Zweig griffe bei JEDEM
  // weiteren Request - auch nach einer erfolgreichen Anmeldung als Mensch. Wer
  // ein Tablett zurueckbaut, muesste die Websitedaten von Hand loeschen.
  const res = await fetch(`${BASE}/api/v1/tasks`, {
    headers: { Cookie: `${DISPLAY_COOKIE}=${displayToken}` },
  });
  assert.equal(res.status, 401, 'der Request bleibt abgewiesen');
  const setCookie = String(res.headers.get('set-cookie') || '');
  assert.match(setCookie, new RegExp(`${DISPLAY_COOKIE}=`), 'die Antwort raeumt das Cookie ab');
  assert.match(setCookie, /Expires=Thu, 01 Jan 1970|Max-Age=0/,
    'und zwar so, dass der Browser es wirklich vergisst');
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
// Runde 2 des Reviews: was der Uebergang zum Display sonst noch offen liess
// --------------------------------------------------------

test('die Kopplung toetet die Sitzung, aus der heraus gekoppelt wurde', async () => {
  // GEKOPPELT WIRD FAST IMMER AUS EINEM ANGEMELDETEN BROWSER. Bliebe
  // `yuvomi.sid` daneben liegen, waere es ein schlafender Zweitschluessel: das
  // Display-Credential fuehrt zwar, aber sobald es faellt (Widerruf, Loeschen),
  // raeumt requireAuth das tote Cookie weg - und der naechste Request faende
  // die alte Sitzung mit den VOLLEN Rechten dieser Person. Der Widerruf haette
  // das Tablett damit offener zurueckgelassen als vorher.
  const created = await admin('POST', '/displays', { display_name: 'Uebergang' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const session = await login('admin', 'adminpass123');

  // Vorbedingung: diese Sitzung traegt gerade noch volle Rechte.
  assert.equal((await fetch(`${BASE}/api/v1/documents`, { headers: { Cookie: session.cookie } })).status, 200);

  const res = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
    body: JSON.stringify({ code: issued.body.data.code }),
  });
  assert.equal(res.status, 201);

  // Nur die Sitzung, ohne das Geraete-Cookie - so sieht es der Browser nach
  // einem Widerruf.
  const after = await fetch(`${BASE}/api/v1/documents`, { headers: { Cookie: session.cookie } });
  assert.equal(after.status, 401, 'die Sitzung ist serverseitig zerstoert, nicht nur ueberdeckt');
});

test('auch ein falscher Code meldet die Sitzung ab - und verbrennt nichts', async () => {
  // DIE REIHENFOLGE IST DER PUNKT. `redeemPairingCode()` ist unumkehrbar: es
  // verbrennt den Code, legt das Geraet an und widerruft das bisherige Geraet
  // desselben Displays. Stuende das Zerstoeren der Sitzung DAHINTER, liesse ein
  // Fehlschlag dort einen verbrauchten Code, ein Tablett ohne Cookie und ein
  // bereits widerrufenes Vorgaengergeraet zurueck - der Fehlschlag wuerde den
  // Zustand also nicht nur verhindern, sondern zerstoeren. Zuerst zerstoeren
  // kostet nichts, und der Preis dafuer steht hier: ein Tippfehler meldet ab.
  const session = await login('admin', 'adminpass123');
  assert.equal((await fetch(`${BASE}/api/v1/documents`, { headers: { Cookie: session.cookie } })).status, 200);

  const created = await admin('POST', '/displays', { display_name: 'Tippfehler' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});

  const res = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
    body: JSON.stringify({ code: 'AAAAAAAAAA' }),
  });
  assert.equal(res.status, 400, 'der falsche Code wird abgewiesen');
  assert.equal(
    (await fetch(`${BASE}/api/v1/documents`, { headers: { Cookie: session.cookie } })).status,
    401,
    'die Sitzung ist trotzdem weg - sie stirbt VOR dem Einloesen',
  );

  // Und der echte Code lebt noch: der Fehlversuch hat ihn nicht angefasst.
  assert.equal((await pair(issued.body.data.code)).status, 201);
});

test('das Geraete-Cookie wird nachdatiert, aber nicht bei jedem Zugriff', async () => {
  // Browser kappen persistente Cookies (Chromium bei 400 Tagen). Eine einmal
  // geschriebene Zehnjahresfrist ist damit keine - ein Tablett an der Wand
  // waere nach gut einem Jahr von selbst leer gewesen, ohne Widerruf. An JEDE
  // Antwort gehoert das Credential aber auch nicht: es steht im Klartext im
  // Set-Cookie-Kopf, und hinter diesem Guard liegt mit /weather/icon eine
  // oeffentlich cachebare Antwort.
  const created = await admin('POST', '/displays', { display_name: 'Nachdatiert' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;

  const res = await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(res.status, 200);
  const setCookie = String(res.headers.get('set-cookie') || '');
  assert.match(setCookie, new RegExp(`${DISPLAY_COOKIE}=`), 'der erste Zugriff frischt auf');

  // Der zweite folgt Sekunden spaeter - er darf das Credential NICHT noch
  // einmal in den Kopf schreiben.
  const zweiter = await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(zweiter.status, 200);
  assert.doesNotMatch(
    String(zweiter.headers.get('set-cookie') || ''),
    new RegExp(`${DISPLAY_COOKIE}=`),
    'der naechste Zugriff schweigt, bis die Frist um ist',
  );

  // UND DIE FRIST MUSS WIEDER UM GEHEN KOENNEN. Haengte sie an `last_seen_at`,
  // waere sie nach dem ersten Zugriff nie wieder faellig - ein Tablett, das
  // staendig anfragt, haelt dieses Feld ja dauerhaft frisch, und das Cookie
  // liefe nach einem Jahr doch ab. Genau dieser Zustand wird hier gestellt:
  // Geraet war eben noch da (last_seen_at = jetzt), aber zuletzt vor 13 Stunden
  // nachdatiert.
  const geraet = db.prepare(
    'SELECT id FROM display_devices WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  ).get(created.body.data.id);
  const vor13h = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  db.prepare('UPDATE display_devices SET cookie_refreshed_at = ? WHERE id = ?').run(vor13h, geraet.id);

  const dritter = await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(dritter.status, 200);
  assert.match(
    String(dritter.headers.get('set-cookie') || ''),
    new RegExp(`${DISPLAY_COOKIE}=`),
    'nach Ablauf der Frist wird wieder nachdatiert - auch bei staendigem Betrieb',
  );

  // Die REGEL messen, nicht die Zahl: unter jeder Browser-Kappung und weit
  // genug ueber einem Tag, damit ein Tablett nicht taeglich am Netz haengen
  // muss. Ein Literal hier waere beim naechsten Nachjustieren rot geworden,
  // ohne dass etwas kaputt ist.
  const maxAge = Number(setCookie.match(/Max-Age=(\d+)/i)?.[1] ?? 0);
  assert.ok(maxAge > 30 * 24 * 60 * 60, `Max-Age ${maxAge} ist zu kurz fuer ein unbeaufsichtigtes Geraet`);
  assert.ok(maxAge <= 400 * 24 * 60 * 60, `Max-Age ${maxAge} liegt ueber der 400-Tage-Kappung der Browser`);
});

test('ein Display kann kein Subjekt eines API-Tokens sein', async () => {
  // Der Weg drumherum: die Display-Id als `subject_user_id` eintragen. Der
  // Token-Zweig loest Rechte OHNE `isDisplay` auf - die feste Leseliste greift
  // dort nicht, ein ungescoptes Token haette also die vollen Schreibrechte
  // eines Mitglieds unter dem Namen des Wandtabletts.
  const res = await admin('POST', '/auth/api-tokens', { name: 'Tablett-Umweg', subject_user_id: displayId });
  assert.equal(res.status, 400);
  assert.match(res.body?.error || '', /display/i);
});

test('calendar:read reicht NICHT an das Kontaktbuch', async () => {
  // GET /birthdays/import/candidates zaehlt jeden Kontakt mit Namen und
  // Geburtsdatum auf. Der Pfad-Guard urteilt am ersten Segment, und
  // `moduleForPath('/birthdays')` ergibt `calendar` - jedes Credential mit
  // `calendar:read` kam damit an eine Liste, die `contacts` verlangt.
  assert.ok(DISPLAY_SCOPES.includes('calendar:read'), 'Vorbedingung: das Display hat calendar:read');
  assert.ok(!DISPLAY_SCOPES.some((s) => s.startsWith('contacts:')), 'Vorbedingung: contacts ist NICHT dabei');

  // Ein FRISCHES Geraet: das Credential aus dem ersten Test ist weiter oben
  // schon widerrufen worden, und ein 401 haette hier nach bestandener Pruefung
  // ausgesehen, ohne die Regel je zu beruehren.
  const created = await admin('POST', '/displays', { display_name: 'Kontaktprobe' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;
  const display = asDisplay(token);
  // Vorbedingung am SELBEN Praefix: das Display erreicht /birthdays sehr wohl.
  // Sonst waere das 403 unten auch dann gruen, wenn der ganze Zweig gesperrt
  // waere - und der Riegel, um den es geht, nie gemessen.
  assert.equal((await display('GET', '/birthdays')).status, 200, 'Vorbedingung: /birthdays ist offen');

  const denied = await display('GET', '/birthdays/import/candidates');
  assert.equal(denied.status, 403);

  // Dieselbe Luecke ist aelter als das Display: ein gescoptes API-Token trifft
  // sie genauso.
  const tokenRes = await admin('POST', '/auth/api-tokens', { name: 'Nur Kalender', scopes: ['calendar:read'] });
  assert.equal(tokenRes.status, 201);
  const scoped = await fetch(`${BASE}/api/v1/birthdays/import/candidates`, {
    headers: { Authorization: `Bearer ${tokenRes.body.token}` },
  });
  assert.equal(scoped.status, 403, 'auch ein Token mit calendar:read bleibt draussen');

  // Und die Gegenrichtung: wer Kontakte darf, kommt weiterhin durch - sonst
  // haette der Riegel den Geburtstags-Import selbst erschlagen.
  assert.equal((await admin('GET', '/birthdays/import/candidates')).status, 200);
});

test('der Katalog nennt die Kopplungsroute als unauthentifiziert', async () => {
  // Sonst traegt `op()` Bearer, API-Key und Cookie ein und verlangt von einem
  // frisch aufgehaengten Tablett genau das Credential, das es sich dort erst
  // holt.
  const spec = (await admin('GET', '/openapi.json')).body;
  const pairOp = spec?.paths?.['/api/v1/displays/pair']?.post;
  const loginOp = spec?.paths?.['/api/v1/auth/login']?.post;
  const listOp = spec?.paths?.['/api/v1/displays']?.get;
  assert.ok(pairOp && loginOp && listOp, 'alle drei stehen im Katalog');

  // GEGEN /auth/login GEMESSEN, NICHT GEGEN EIN LITERAL. Wie dieses Projekt
  // "oeffentlich" schreibt, ist seine Entscheidung (heute: `security` fehlt
  // ganz) - der Kopplungstausch soll dieselbe Schreibweise tragen wie die
  // andere Route ohne Anmeldung, nicht eine zufaellig gleich aussehende.
  assert.deepEqual(pairOp.security, loginOp.security, 'wie /auth/login deklariert');
  // Und die Gegenprobe, damit der Vergleich nicht leer bestehen kann: eine
  // Route MIT Anmeldung traegt die Anforderung sichtbar.
  assert.ok(Array.isArray(listOp.security) && listOp.security.length > 0,
    'Vorbedingung: authentifizierte Operationen nennen ihre Verfahren');
});

// --------------------------------------------------------
// Runde 3: was die Modul-Scopes sonst noch mitbrachten
// --------------------------------------------------------

test('ein Display sieht die Verwaltungsdaten der Sync-Konten NICHT', async () => {
  // `calendar:read` reicht bis in die Statusrouten hinein, weil der Pfad-Guard
  // am ersten Segment urteilt. Dort stehen Server-Adresse und Benutzername der
  // angebundenen Konten - ein Tablett an der Kuechenwand haette ausgelesen,
  // wohin dieser Haushalt synchronisiert und unter welchem Namen.
  db.prepare(`
    INSERT INTO caldav_accounts(name, caldav_url, username, password)
    VALUES ('Fastmail', 'https://caldav.example.org/dav/', 'anna@example.org', 'x')
  `).run();

  const created = await admin('POST', '/displays', { display_name: 'Statusprobe' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;

  // Vorbedingung: die Sitzung sieht die Felder sehr wohl - sonst waere die
  // Probe unten auch dann gruen, wenn die Route gar nichts mehr liefert.
  const alsMensch = await admin('GET', '/calendar/caldav/status');
  assert.equal(alsMensch.status, 200);
  const kontoMensch = alsMensch.body.data.accounts.find((a) => a.name === 'Fastmail');
  assert.equal(kontoMensch.caldavUrl, 'https://caldav.example.org/dav/');
  assert.equal(kontoMensch.username, 'anna@example.org');

  const alsDisplay = await asDisplay(token)('GET', '/calendar/caldav/status');
  assert.equal(alsDisplay.status, 200, 'die Route bleibt erreichbar - nur aermer');
  const konto = alsDisplay.body.data.accounts.find((a) => a.name === 'Fastmail');
  assert.ok(konto, 'das Konto steht weiterhin in der Liste');
  assert.equal(konto.caldavUrl, undefined, 'die Server-Adresse fehlt');
  assert.equal(konto.username, undefined, 'der Benutzername fehlt');

  // UND DIE BEIDEN ANDEREN ANBINDUNGEN AUCH. Google und Apple liefern den
  // Fehlertext des letzten Laufs mit; der kommt vom Gegenueber und traegt
  // regelmaessig dessen Adresse oder eine Kontokennung in sich.
  db.prepare("INSERT OR REPLACE INTO sync_config(key, value) VALUES ('google_last_error', ?)")
    .run('401 from https://www.googleapis.com/calendar/v3/users/anna@example.org');
  const alsMenschGoogle = await admin('GET', '/calendar/google/status');
  assert.equal(alsMenschGoogle.status, 200);
  assert.ok(alsMenschGoogle.body.lastError, 'Vorbedingung: die Sitzung sieht den Fehlertext');

  const googleDisplay = await asDisplay(token)('GET', '/calendar/google/status');
  assert.equal(googleDisplay.status, 200);
  assert.equal(googleDisplay.body.lastError, undefined, 'der Fehlertext fehlt');
  assert.equal(googleDisplay.body.lastErrorAt, undefined, 'und sein Zeitpunkt auch');
  assert.ok('connected' in googleDisplay.body, 'der Rest der Antwort bleibt stehen');

  const appleDisplay = await asDisplay(token)('GET', '/calendar/apple/status');
  assert.equal(appleDisplay.status, 200);
  assert.equal(appleDisplay.body.lastError, undefined, 'dasselbe bei Apple');
});

test('die Sync-Ziel-Listen gehoeren dem, der auch speichern darf', async () => {
  // Sie fuellen ein Feld im Aufgaben- und im Termindialog und nennen dabei die
  // angebundenen Konten samt Sammlungs-URL. Ein Display darf nur lesen, sieht
  // den Dialog also nie - die Liste hatte es trotzdem.
  const created = await admin('POST', '/displays', { display_name: 'Zielprobe' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const display = asDisplay((await pair(issued.body.data.code)).token);

  assert.equal((await display('GET', '/tasks')).status, 200, 'Vorbedingung: Aufgaben sind offen');
  assert.equal((await display('GET', '/tasks/sync-targets')).status, 403);
  assert.equal((await display('GET', '/calendar/sync-targets')).status, 403);

  // Und die Gegenrichtung: wer schreiben darf, bekommt seine Auswahl.
  assert.equal((await admin('GET', '/tasks/sync-targets')).status, 200);
  assert.equal((await admin('GET', '/calendar/sync-targets')).status, 200);
});

test('auch /auth/me frischt auf - der Riegel davor verbraucht die Frist nicht', async () => {
  // ZWEI PRUEFUNGEN JE REQUEST. Der Riegel des Auth-Routers ruft
  // `authenticateDisplayDevice()` und wirft das Ergebnis weg, erst `requireAuth`
  // danach setzt Cookies. Verbrauchte schon das Feststellen die Frist, bekaeme
  // ausgerechnet `/auth/me` nie eine Auffrischung - und genau die fragt ein
  // Tablett beim Start als erstes.
  const created = await admin('POST', '/displays', { display_name: 'Riegelprobe' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const token = (await pair(issued.body.data.code)).token;

  // Einmal anfragen, damit die erste (faellige) Auffrischung verbraucht ist,
  // dann die Uhr zurueckstellen.
  await fetch(`${BASE}/api/v1/tasks`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  const geraet = db.prepare(
    'SELECT id FROM display_devices WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  ).get(created.body.data.id);
  const vor13h = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  db.prepare('UPDATE display_devices SET cookie_refreshed_at = ? WHERE id = ?').run(vor13h, geraet.id);

  const res = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(res.status, 200);
  assert.match(
    String(res.headers.get('set-cookie') || ''),
    new RegExp(`${DISPLAY_COOKIE}=`),
    'die Auffrischung ueberlebt den doppelten Durchlauf',
  );
});

test('ein Display sieht von /preferences nur den Darstellungsteil', async () => {
  // Die Route steht dem Display offen, weil die App ohne sie nicht startet -
  // ihre Antwort ist aber die Sammelstelle des ganzen Haushalts. Die genauen
  // Wohnkoordinaten an einem Geraet, das oeffentlich haengt, sind das
  // deutlichste Beispiel; Budget-Betriebsart, Zyklus-Einstellungen und die
  // Standard-Sync-Ziele gehoeren genauso wenig dorthin.
  const created = await admin('POST', '/displays', { display_name: 'Praeferenzprobe' });
  const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const display = asDisplay((await pair(issued.body.data.code)).token);

  const alsMensch = await admin('GET', '/preferences');
  assert.equal(alsMensch.status, 200);
  // Vorbedingung: die Sitzung bekommt die Felder tatsaechlich - sonst waere die
  // Probe unten auch dann gruen, wenn die Route sie gar nicht mehr liefert.
  assert.ok('weather_lat' in alsMensch.body.data);
  assert.ok('budget_mode' in alsMensch.body.data);

  const res = await display('GET', '/preferences');
  assert.equal(res.status, 200);
  for (const key of ['weather_lat', 'weather_lon', 'budget_mode', 'housekeeping_payment_tasks',
    'tasks_default_target', 'calendar_default_target', 'visible_meal_types']) {
    assert.equal(key in res.body.data, false, `${key} gehoert nicht an die Wand`);
  }
  // Und was die App zum Starten und Zeichnen braucht, ist da - ein zu enger
  // Filter waere derselbe Fehler in die andere Richtung (im Browser gemessen:
  // ohne diese Felder faellt der Auth-Guard in seinen catch).
  for (const key of ['language_effective', 'date_format', 'time_format', 'week_start',
    'timezone_effective', 'app_name', 'disabled_modules', 'dashboard_widgets']) {
    assert.ok(key in res.body.data, `${key} fehlt dem Tablett`);
  }
});

test('der Katalog beschreibt den Rumpf der Kopplung', async () => {
  // Ohne Schema laesst `op()` den Rumpf ganz weg - ein erzeugter Client haette
  // kein Argument fuer den Code, und die Route antwortet dann mit 400.
  const spec = (await admin('GET', '/openapi.json')).body;
  const schema = spec?.paths?.['/api/v1/displays/pair']?.post
    ?.requestBody?.content?.['application/json']?.schema;
  assert.ok(schema, 'die Kopplungsroute nennt ihren Rumpf');
  assert.deepEqual(schema.required, ['code']);
  assert.ok(schema.properties?.label, 'der optionale Name steht auch dabei');

  const create = spec?.paths?.['/api/v1/displays']?.post
    ?.requestBody?.content?.['application/json']?.schema;
  assert.deepEqual(create?.required, ['display_name']);
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
