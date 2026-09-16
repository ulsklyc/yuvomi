/**
 * Test: Was ein Wandtablett TUT (#1209, entschieden in #913)
 *
 * Zweck: Ein gekoppeltes Display war bis #1208 ein Schaufenster. Jetzt darf es
 *        genau zwei Dinge, stellvertretend fuer eine am Geraet gewaehlte Person:
 *        eine Aufgabe abhaken und eine Einloesung beantragen. Diese Suite misst
 *        die Grenzen dieser zwei Handlungen, nicht ihre Bequemlichkeit:
 *          - ohne benannte Person geht nichts;
 *          - benannt werden koennen nur Haushaltsmitglieder (#1207);
 *          - die GEWAEHLTE Person muss das Modul selbst schreiben duerfen;
 *          - nur der Uebergang nach 'done', kein Zuruecknehmen, kein Ablegen;
 *          - nur haushaltssichtbare Aufgaben, und die Absage darauf ist 404;
 *          - jede andere Schreibroute der beiden Module bleibt zu.
 *
 * WARUM DER ECHTE SERVER UND KEIN NACKTER ROUTER - derselbe Grund wie in
 * test-display-account.js: die Erlaubnis entsteht in den GLOBALEN Gates von
 * server/index.js, und es sind ZWEI hintereinander. Ein Router, den die Suite
 * selbst einhaengt, sieht keinen von beiden; sie waere eine Kopie der Kette,
 * und eine Kopie kann nicht belegen, dass das Original sperrt. Genau dieser
 * Fall ist hier kein Gedankenspiel: das erste Gate durchzulassen und am zweiten
 * zu scheitern sah im Browser aus wie „das Tablett hakt nicht ab".
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-display-actions.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'display-actions',
  env: {
    SESSION_SECRET: 'test-display-actions-secret-min32chars',
    RATE_LIMIT_MAX_ATTEMPTS: '40',
    RATE_LIMIT_WINDOW_MS: '60000',
  },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

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

/**
 * Ein Request, wie ihn das Tablett stellt - und zwar wie ein BROWSER ihn stellt.
 *
 * WARUM HIER EIN COOKIE-GLAS STEHT UND NICHT NUR DAS GERAETE-COOKIE. Ein
 * Display hat keine Sitzung: `requireAuth` erkennt es am Credential und kehrt
 * zurueck, und das Koppeln zerstoert eine vorhandene Sitzung ausdruecklich.
 * Der CSRF-Schutz haengt aber genau daran - `csrfMiddleware` legt seinen Token
 * in `req.session` ab (server/middleware/csrf.js:33-35) und laesst nur
 * `api_method === 'api_token'` daran vorbei. Fuer ein Display heisst das: der
 * erste Request erzeugt eine leere Sitzung NUR fuer den Token, der Server
 * schickt `yuvomi.sid` und `X-CSRF-Token` mit, und der Browser fuehrt beides
 * ab da mit. Ohne dieses Mitfuehren bekommt jeder Request eine neue Sitzung mit
 * neuem Token, und jeder Schreibversuch endet in 403.
 *
 * DAS IST KEINE TESTKULISSE, SONDERN DER ECHTE WEG. Bis #1208 fiel es nicht
 * auf, weil ein Display nur GET stellte und `csrfMiddleware` sichere Methoden
 * durchwinkt. #1209 ist der erste Schreibpfad eines Tabletts, und er laeuft
 * ueber diese leere Sitzung. Ein Test, der den Token von Hand daneben legt,
 * haette die Abhaengigkeit verdeckt statt sie zu belegen - deshalb steht sie
 * hier nachgebaut, mit einem eigenen Test darauf.
 */
function asDisplay(token) {
  const jar = new Map([[DISPLAY_COOKIE, token]]);
  let csrf = null;
  const send = async (method, path, body) => {
    const headers = {
      'Content-Type': 'application/json',
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const fresh = res.headers.get('x-csrf-token');
    if (fresh) csrf = fresh;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // DER VORLAUF-GET IST DER START DER APP, nicht eine Bequemlichkeit des Tests.
  // Ein Tablett laedt seine Seite, und dabei faellt die leere Sitzung samt
  // Token an. Erst danach kann jemand etwas antippen. Ohne diesen Schritt
  // haette der erste Schreibversuch je Test 403 gemessen, und welcher Test das
  // trifft, haenge an der Reihenfolge der Tests: genau die versteckte Kopplung,
  // die eine Suite spaeter zufaellig gruen oder rot macht.
  //
  // UND ER GEHT NICHT AUF `/auth/me`, SO NAHELIEGEND DAS WAERE. Der Auth-Router
  // ist auf `/api/v1/auth` montiert und haengt damit VOR den globalen Gates und
  // vor `csrfMiddleware` - eine Antwort von dort traegt weder Token noch
  // Sitzungs-Cookie. Der erste Anlauf hier tat genau das und mass 403, waehrend
  // jeder andere Test gruen war, weil der erste von ihnen den Token zufaellig
  // schon geholt hatte. `/preferences` liegt hinter den Gates und ist
  // ohnehin einer der drei Pfade, die ein Display beim Start liest.
  return async (method, path, body) => {
    if (!csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) await send('GET', '/preferences');
    return send(method, path, body);
  };
}

const admin = as(await login('admin', 'adminpass123'));

// --------------------------------------------------------
// Der Haushalt: ein Tablett, zwei Mitglieder, ein Gast.
// --------------------------------------------------------
const createdDisplay = await admin('POST', '/displays', { display_name: 'Kueche' });
const displayId = createdDisplay.body.data.id;
const issued = await admin('POST', `/displays/${displayId}/pairing-code`, {});
const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: issued.body.data.code }),
});
const displayToken = decodeURIComponent(
  String(paired.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1],
);
const display = asDisplay(displayToken);

function addMember(username, name, familyRole = 'child') {
  return Number(db.prepare(`
    INSERT INTO users(username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'member', ?) RETURNING id
  `).get(username, name, familyRole).id);
}

const LEA = addMember('lea', 'Lea');
const MAX = addMember('max', 'Max');
// Ein Gast der geteilten Ausgaben ist ausdruecklich KEIN Haushaltsmitglied.
const GAST = addMember('gast', 'Gast');
db.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES (?)').run(GAST);

db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(LEA);
db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(MAX);

/** Eine Aufgabe anlegen, ohne den Umweg ueber die Route - die Sichtbarkeit ist hier das Thema. */
function addTask(title, visibility = 'all', points = 5) {
  return Number(db.prepare(`
    INSERT INTO tasks(title, status, visibility, points, created_by)
    VALUES (?, 'open', ?, ?, 1) RETURNING id
  `).get(title, visibility, points).id);
}

// --------------------------------------------------------
// Die Naht, an der der Schreibweg ueberhaupt haengt
// --------------------------------------------------------

test('der Schreibweg eines Tabletts laeuft ueber eine leere Sitzung, und nur darueber', async () => {
  // DIESER TEST HAELT EINE ABHAENGIGKEIT FEST, DIE NIRGENDS AUSGESPROCHEN IST.
  // Ein Display hat bewusst keine Sitzung - das Koppeln zerstoert sogar eine
  // vorhandene. Der CSRF-Schutz haengt aber an genau ihr: `csrfMiddleware`
  // legt seinen Token in `req.session` und laesst nur `api_token` daran vorbei.
  // Bis #1208 fiel das nicht auf, weil ein Tablett nur las und sichere Methoden
  // durchgewunken werden. Hier ist der erste Schreibpfad, und er funktioniert
  // nur, weil der Browser die leere Sitzung mitfuehrt.
  //
  // Ohne sie ist die Absage 403 - und zwar dieselbe 403 wie bei einer fehlenden
  // Berechtigung. Wer das einmal an der Wand sieht, sucht an der falschen
  // Stelle; deshalb steht die Unterscheidung hier als Messung.
  const id = addTask('Naht');
  const nackt = await fetch(`${BASE}/api/v1/tasks/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=${displayToken}` },
    body: JSON.stringify({ status: 'done', done_by_user_id: LEA }),
  });
  assert.equal(nackt.status, 403, 'ohne den CSRF-Token der Sitzung: abgewiesen');
  assert.equal((await nackt.json()).error, 'Invalid CSRF token.', 'und zwar genau daran');

  // Derselbe Aufruf mit dem Weg, den ein Browser geht, kommt durch.
  assert.equal((await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: LEA })).status, 200);
});

// --------------------------------------------------------
// Die Personenliste des Pickers
// --------------------------------------------------------

test('GET /displays/people liefert die Mitglieder, ohne ihre Kontaktdaten', async () => {
  const res = await display('GET', '/displays/people');
  assert.equal(res.status, 200);
  const names = res.data ?? res.body.data;
  const ids = names.map((p) => p.id);
  assert.ok(ids.includes(LEA) && ids.includes(MAX), 'beide Mitglieder stehen drin');
  assert.ok(!ids.includes(GAST), 'ein Gast ist kein Haushaltsmitglied');
  assert.ok(!ids.includes(displayId), 'und das Tablett waehlt sich nicht selbst');

  // DIE SPALTENLISTE IST DER PUNKT. `/family/members` liefert Telefon, E-Mail
  // und Geburtsdatum gleich mit; an einer Kuechenwand ist das eine Auskunft an
  // jeden, der vorbeigeht. Diese Antwort traegt genau das, was ein Knopf mit
  // einem Gesicht darauf braucht.
  const lea = names.find((p) => p.id === LEA);
  assert.deepEqual(
    Object.keys(lea).sort(),
    ['avatar_color', 'avatar_data', 'can_redeem', 'can_tick_off', 'display_name', 'id'],
    'keine Spalte mehr als diese sechs',
  );
});

test('ein Mensch bekommt die Display-Personenliste nicht', async () => {
  // Sie traegt display-eigene Felder, die anderswo nichts bedeuten - ein Mensch
  // hat /family/members. 403 und nicht 404: den Pfad gibt es.
  assert.equal((await admin('GET', '/displays/people')).status, 403);
});

// --------------------------------------------------------
// Abhaken
// --------------------------------------------------------

test('das Tablett hakt fuer eine benannte Person ab - und der Verlauf trennt beide', async () => {
  const id = addTask('Tisch decken');
  const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: LEA });
  assert.equal(res.status, 200);

  const row = db.prepare('SELECT user_id, done_by_user_id FROM task_completions WHERE task_id = ?').get(id);
  assert.equal(row.done_by_user_id, LEA, 'getan hat es Lea');
  assert.equal(row.user_id, displayId, 'abgehakt hat es das Tablett');

  // Und die Punkte folgen der Person, nicht dem Geraet: das Display nimmt am
  // Belohnungssystem gar nicht teil, eine Buchung auf seinen Namen waere ein
  // Punktestand, den niemand einloesen kann.
  const ledger = db.prepare('SELECT user_id, delta FROM reward_ledger WHERE task_id = ?').all(id);
  assert.deepEqual(ledger.map((l) => l.user_id), [LEA]);
  assert.equal(ledger[0].delta, 5);
});

test('ohne benannte Person hakt das Tablett nichts ab', async () => {
  // KEIN STILLER RUECKFALL AUF DAS GERAET. Er waere eine Erledigung, die
  // niemand getan hat - und der Verlauf truege sie als Tatsache.
  const id = addTask('Muell rausbringen');
  const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done' });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?').get(id).n, 0);
});

test('benannt werden koennen nur Haushaltsmitglieder', async () => {
  const id = addTask('Spuelmaschine');
  for (const wer of [GAST, displayId, 999999]) {
    const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: wer });
    assert.equal(res.status, 400, `abgelehnt: ${wer}`);
  }
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
});

test('die gewaehlte Person muss das Modul selbst schreiben duerfen', async () => {
  // OHNE DIESE ZEILE WAERE DAS TABLETT DER WEG AN DEN MODULRECHTEN VORBEI: ein
  // Kind mit `tasks: read` hakt an seinem eigenen Geraet nichts ab, an der
  // Kuechenwand aber schon.
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'tasks', 'read')
  `).run(String(MAX));

  const id = addTask('Waesche');
  const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: MAX });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');

  db.prepare("DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'tasks'").run(String(MAX));
  const nochmal = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: MAX });
  assert.equal(nochmal.status, 200, 'mit Schreibrecht geht dieselbe Aufgabe durch');
});

test('das Tablett hakt ab - es nimmt nichts zurueck und legt nichts ab', async () => {
  // Zuruecknehmen storniert Punkte und verwirft die Folgeinstanz einer Serie.
  // Das ist eine Korrektur, und Korrekturen bleiben beim Haushalt.
  const id = addTask('Blumen giessen');
  await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: LEA });

  for (const status of ['open', 'in_progress', 'archived']) {
    const res = await display('PATCH', `/tasks/${id}/status`, { status, done_by_user_id: LEA });
    assert.equal(res.status, 403, `abgelehnt: ${status}`);
  }
  const row = db.prepare('SELECT status, archived_at FROM tasks WHERE id = ?').get(id);
  assert.equal(row.status, 'done', 'die Aufgabe steht unveraendert');
  assert.equal(row.archived_at, null, 'und liegt nicht in der Ablage');
});

test('eine Aufgabe, die nicht der ganze Haushalt sieht, gibt es fuer das Tablett nicht', async () => {
  // Die Liste zieht die Sichtbarkeit schon - aber die Liste ist eine Antwort,
  // kein Riegel: diese Route nimmt eine ID aus dem Pfad, und eine ID kann jeder
  // hinschreiben. 404 und nicht 403, sonst ist die Absage die Auskunft, dass es
  // die Aufgabe gibt.
  for (const sichtbarkeit of ['private', 'assignees']) {
    const id = addTask(`Geheim ${sichtbarkeit}`, sichtbarkeit);
    const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: LEA });
    assert.equal(res.status, 404, sichtbarkeit);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
  }
});

test('jede andere Schreibroute der beiden Module bleibt zu', async () => {
  // DIE EIGENTLICHE ZUSAGE DES TICKETS: „no creating, editing or deleting, and
  // no settings". Sie haengt daran, dass die Erlaubnis eine Liste von zwei
  // Routen ist und kein Modul-Scope - mit `tasks:write` waeren alle diese hier
  // offen gewesen.
  const id = addTask('Unantastbar');
  const zu = [
    ['POST', '/tasks', { title: 'Neu' }],
    ['PUT', `/tasks/${id}`, { title: 'Umbenannt' }],
    ['DELETE', `/tasks/${id}`, null],
    ['PATCH', `/tasks/${id}/archive`, { archived: true }],
    ['PATCH', `/tasks/${id}/check`, { line: 0 }],
    ['POST', '/tasks/categories', { key: 'neu', name: 'Neu' }],
    ['POST', `/tasks/${id}/comments`, { body: 'hallo' }],
    ['POST', '/rewards/catalog', { name: 'Eis', cost: 5 }],
    ['POST', '/rewards/bonus', { user_id: LEA, points: 100 }],
  ];
  for (const [method, path, body] of zu) {
    const res = await display(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const row = db.prepare('SELECT title, archived_at FROM tasks WHERE id = ?').get(id);
  assert.equal(row.title, 'Unantastbar');
  assert.equal(row.archived_at, null);
});

// --------------------------------------------------------
// Einloesung beantragen
// --------------------------------------------------------

const KATALOG = await admin('POST', '/rewards/catalog', { name: 'Eis', cost: 3 });
const EIS = KATALOG.body.data.id;

test('das Tablett beantragt eine Einloesung fuer die gewaehlte Person', async () => {
  const res = await display('POST', '/rewards/redemptions', { catalog_id: EIS, user_id: LEA });
  assert.equal(res.status, 201);
  const row = db.prepare('SELECT user_id, requested_by FROM reward_redemptions WHERE id = ?').get(res.body.data.id);
  assert.equal(row.user_id, LEA, 'bekommen hat es Lea');
  assert.equal(row.requested_by, displayId, 'beantragt hat es das Tablett');
});

test('ohne benannte Person beantragt das Tablett nichts', async () => {
  // Der Rueckfall auf das Geraet waere hier besonders irrefuehrend: das
  // Display-Konto nimmt an Belohnungen gar nicht teil, die Absage kaeme also
  // von `isEnrolled` und spraeche von einem Tippfehler statt von einer
  // fehlenden Angabe.
  const vorher = db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions').get().n;
  const res = await display('POST', '/rewards/redemptions', { catalog_id: EIS });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_redemptions').get().n, vorher);
});

test('die Einloesung folgt denselben Grenzen wie das Abhaken', async () => {
  for (const wer of [GAST, displayId, 999999]) {
    assert.equal(
      (await display('POST', '/rewards/redemptions', { catalog_id: EIS, user_id: wer })).status,
      400,
      `abgelehnt: ${wer}`,
    );
  }
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'rewards', 'read')
  `).run(String(MAX));
  assert.equal(
    (await display('POST', '/rewards/redemptions', { catalog_id: EIS, user_id: MAX })).status,
    403,
    'ohne Schreibrecht auf Belohnungen geht es nicht',
  );
  db.prepare("DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'rewards'").run(String(MAX));
});

test('das Entscheiden bleibt, wo der Haushalt es hingelegt hat', async () => {
  // Beantragen ja, freigeben nein - `PATCH /rewards/redemptions/:id` steht
  // ausdruecklich NICHT in der Route-Allowlist.
  const beantragt = await display('POST', '/rewards/redemptions', { catalog_id: EIS, user_id: MAX });
  assert.equal(beantragt.status, 201);
  const id = beantragt.body.data.id;
  for (const action of ['fulfill', 'reject', 'cancel']) {
    assert.equal((await display('PATCH', `/rewards/redemptions/${id}`, { action })).status, 403, action);
  }
  assert.equal(db.prepare('SELECT status FROM reward_redemptions WHERE id = ?').get(id).status, 'pending');
});
