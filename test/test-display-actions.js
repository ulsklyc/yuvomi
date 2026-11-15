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
 * Ausfuehren: node --test test/test-display-actions.js
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

test('eine Serie aus einer anderen App hakt auch das Tablett nicht ab (#2506)', async () => {
  // Die Regel fuehrt iOS Erinnerungen oder Tasks.org. Ein Haken hier schickte
  // COMPLETED auf den Master, und die andere App beendete die ganze Serie.
  const id = addTask('Muell (Telefon)');
  db.prepare("UPDATE tasks SET external_source = 'caldav', external_uid = 'muell@phone', external_rrule = 'FREQ=WEEKLY' WHERE id = ?").run(id);
  const res = await display('PATCH', `/tasks/${id}/status`, { status: 'done', done_by_user_id: LEA });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'task_foreign_series');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id = ?').get(id).n, 0, 'keine Punkte');
});

test('eine unsichtbare Aufgabe antwortet auf JEDE Nutzlast gleich - und wie eine, die es nie gab', async () => {
  // Die Liste zieht die Sichtbarkeit schon - aber die Liste ist eine Antwort,
  // kein Riegel: diese Route nimmt eine ID aus dem Pfad, und eine ID kann jeder
  // hinschreiben. 404 und nicht 403, sonst ist die Absage die Auskunft, dass es
  // die Aufgabe gibt.
  //
  // ALS MATRIX, UND DAS IST DER PUNKT. Die erste Fassung prueft zwei Faelle
  // einzeln: Nicht-`done`-Status gegen eine SICHTBARE Aufgabe, und Sichtbarkeit
  // nur mit `status: 'done'`. Genau die Kombination dazwischen fehlte - und
  // genau dort lag der Fehler: die Statuspruefung stand vor der
  // Sichtbarkeitspruefung, also beantwortete `{"status":"open"}` auf eine
  // private Aufgabe ein 403 („darf nur abhaken") und auf eine erfundene
  // Kennung ein 404. Der Unterschied zwischen beiden Antworten war die
  // Auskunft, die diese Route verweigern soll: eine private Aufgabe liess sich
  // ueber ihre blosse Kennung nachweisen. Zwei gruene Einzelfaelle, deren
  // Kreuzung niemand einsetzt, messen die Regel nicht.
  //
  // Die ERFUNDENE Kennung steht als Vergleichswert daneben, denn die Zusage
  // lautet nicht „404", sondern „nicht unterscheidbar von einer, die es nicht
  // gibt". Ohne sie waere auch ein durchgaengiges 403 gruen zu bekommen.
  const erfunden = 999999;
  for (const sichtbarkeit of ['private', 'assignees']) {
    const id = addTask(`Geheim ${sichtbarkeit}`, sichtbarkeit);
    for (const status of ['done', 'open', 'in_progress', 'archived']) {
      const unsichtbar = await display('PATCH', `/tasks/${id}/status`, { status, done_by_user_id: LEA });
      const gibtEsNicht = await display('PATCH', `/tasks/${erfunden}/status`, { status, done_by_user_id: LEA });
      assert.equal(unsichtbar.status, 404, `${sichtbarkeit} + ${status}`);
      assert.deepEqual(unsichtbar.body, gibtEsNicht.body,
        `${sichtbarkeit} + ${status}: die Antwort muss der auf eine erfundene Kennung gleichen`);
    }
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
    assert.equal(db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id).archived_at, null);
  }
});

test('the wall rule also holds for the history of a task (GET /tasks/:id/completions)', async () => {
  // The same rule as PATCH /:id/status above: a display sees only what the whole
  // household sees (householdVisible). Before this, GET /:id/completions asked the
  // task row rule rowVisible(db, 'tasks', ...) for the display account too, so a task
  // with visibility `assignees` that names the display showed its history to the
  // wall while ticking it off answered 404. The app never offers a display as an
  // assignee (meta/options and newNonMembers go through householdMemberSql), so
  // the row is seeded directly - the rule must not hang on that.
  const vera = await admin('POST', '/auth/users', {
    username: 'vera', display_name: 'Vera', password: 'verapass12345', role: 'member',
  });
  assert.equal(vera.status, 201, `create member: ${JSON.stringify(vera.body)}`);
  const VERA = vera.body.user.id;
  const asVera = as(await login('vera', 'verapass12345'));

  /**
   * A task with one completion entry and the given assignees.
   * @param {string} title @param {string} visibility @param {number[]} assignees
   */
  const seeded = (title, visibility, assignees) => {
    const id = addTask(title, visibility);
    for (const userId of assignees) {
      db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
    }
    db.prepare(`
      INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
      VALUES (?, ?, 1, '2026-01-02T10:00:00Z')
    `).run(id, id);
    return id;
  };
  const forDisplay = seeded('Fenster putzen', 'assignees', [displayId, VERA]);
  const forAll = seeded('Muell rausbringen', 'all', []);

  const hidden = await display('GET', `/tasks/${forDisplay}/completions`);
  const unknown = await display('GET', '/tasks/999999/completions');
  assert.equal(hidden.status, 404, 'an assignees task is not on the wall, even when it names the display');
  assert.deepEqual(hidden.body, unknown.body, 'the refusal must equal the one for an unknown id');

  const shared = await display('GET', `/tasks/${forAll}/completions`);
  assert.equal(shared.status, 200, 'a household task keeps its history on the wall');
  assert.equal(shared.body.data.length, 1);

  const member = await asVera('GET', `/tasks/${forDisplay}/completions`);
  assert.equal(member.status, 200, 'a person assigned to the task still reads its history');
  assert.equal(member.body.data.length, 1);

  // THE SERIES TOO, NOT ONLY THE ASKED ROW. The answer is the history of the whole
  // repetition chain, and every earlier instance is filtered on its own. A shared
  // instance whose predecessor is an assignees task naming the display would carry
  // that predecessor's entry to the wall if only the asked row met the wall rule.
  const earlier = seeded('Fenster putzen (vorher)', 'assignees', [displayId, VERA]);
  const later = seeded('Fenster putzen (jetzt)', 'all', []);
  db.prepare('UPDATE tasks SET is_recurring = 1, recurrence_origin_id = ? WHERE id = ?').run(earlier, later);
  db.prepare('UPDATE task_completions SET series_id = ? WHERE task_id = ?').run(earlier, later);

  const wallSeries = await display('GET', `/tasks/${later}/completions`);
  assert.equal(wallSeries.status, 200);
  assert.deepEqual(wallSeries.body.data.map((/** @type {any} */ e) => e.task_id), [later],
    'the wall shows only the household-visible instance of the series');

  const memberSeries = await asVera('GET', `/tasks/${later}/completions`);
  assert.deepEqual(memberSeries.body.data.map((/** @type {any} */ e) => e.task_id).sort(), [earlier, later].sort(),
    'an assigned person still reads the whole series');
});

test('the wall rule holds at every task read: list, detail, comments and the household feed', async () => {
  // The same rule as PATCH /:id/status and GET /:id/completions above: a display
  // reads only what the whole household sees (householdVisible). These four reads
  // asked the task row rule with the display account as the viewer, so a task with
  // visibility `assignees` that names the display stood on the wall. The app never
  // offers a display as an assignee, so the rows are seeded directly.
  const wanda = await admin('POST', '/auth/users', {
    username: 'wanda', display_name: 'Wanda', password: 'wandapass12345', role: 'member',
  });
  assert.equal(wanda.status, 201, `create member: ${JSON.stringify(wanda.body)}`);
  const WANDA = wanda.body.user.id;
  const asWanda = as(await login('wanda', 'wandapass12345'));

  /**
   * A task with one completion entry, one comment and the given assignees.
   * @param {string} title @param {string} visibility @param {number[]} assignees
   * @param {number | null} [parent]
   */
  const seeded = (title, visibility, assignees, parent = null) => {
    const id = addTask(title, visibility);
    if (parent != null) db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(parent, id);
    for (const userId of assignees) {
      db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
    }
    db.prepare(`
      INSERT INTO task_completions (task_id, series_id, user_id, completed_at)
      VALUES (?, ?, 1, '2099-01-02T10:00:00Z')
    `).run(id, id);
    db.prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, 1, ?)').run(id, `note on ${title}`);
    return id;
  };
  const forDisplay = seeded('Keller aufraeumen', 'assignees', [displayId, WANDA]);
  const forAll = seeded('Blumen giessen', 'all', []);
  // A household task whose subtask is shared only with its assignees, the display
  // among them: the list carries subtasks, counts and progress, the detail the rows.
  const parent = seeded('Fahrrad warten', 'all', []);
  const hiddenSub = seeded('Fahrrad: Schloss tauschen', 'assignees', [displayId, WANDA], parent);
  const sharedSub = seeded('Fahrrad: Reifen pumpen', 'all', [], parent);

  /** @param {(m: string, p: string) => Promise<{ status: number, body: any }>} who */
  const listed = async (who) => {
    const res = await who('GET', '/tasks');
    assert.equal(res.status, 200);
    return res.body.data;
  };
  /** @param {(m: string, p: string) => Promise<{ status: number, body: any }>} who */
  const feedIds = async (who) => {
    const res = await who('GET', '/tasks/completions?limit=200');
    assert.equal(res.status, 200);
    return res.body.data.map((/** @type {any} */ e) => e.task_id);
  };

  // GET /tasks
  const wall = await listed(display);
  assert.ok(!wall.some((/** @type {any} */ t) => t.id === forDisplay), 'the list leaves an assignees task off the wall');
  assert.ok(wall.some((/** @type {any} */ t) => t.id === forAll), 'a household task stays in the wall list');
  const wallParent = wall.find((/** @type {any} */ t) => t.id === parent);
  assert.ok(wallParent, 'the household parent stays in the wall list');
  assert.deepEqual(wallParent.subtasks.map((/** @type {any} */ s) => s.id), [sharedSub],
    'the list carries only the household subtask to the wall');
  assert.equal(wallParent.subtask_total, 1, 'the subtask count counts only household subtasks');
  assert.equal(wallParent.subtask_done, 0);
  const people = await listed(asWanda);
  assert.ok(people.some((/** @type {any} */ t) => t.id === forDisplay), 'an assigned person still lists the task');
  const personParent = people.find((/** @type {any} */ t) => t.id === parent);
  assert.deepEqual(personParent.subtasks.map((/** @type {any} */ s) => s.id).sort(), [hiddenSub, sharedSub].sort(),
    'an assigned person still sees both subtasks');
  assert.equal(personParent.subtask_total, 2);

  // GET /tasks/:id
  const unknownTask = await display('GET', '/tasks/999999');
  const hiddenTask = await display('GET', `/tasks/${forDisplay}`);
  assert.equal(hiddenTask.status, 404, 'the detail of an assignees task answers 404 on the wall');
  assert.deepEqual(hiddenTask.body, unknownTask.body, 'the refusal must equal the one for an unknown id');
  assert.equal((await display('GET', `/tasks/${forAll}`)).status, 200, 'a household task keeps its detail');
  const wallDetail = await display('GET', `/tasks/${parent}`);
  assert.deepEqual(wallDetail.body.data.subtasks.map((/** @type {any} */ s) => s.id), [sharedSub],
    'the detail carries only the household subtask to the wall');
  assert.equal((await asWanda('GET', `/tasks/${forDisplay}`)).status, 200, 'an assigned person still reads the detail');
  const personDetail = await asWanda('GET', `/tasks/${parent}`);
  assert.equal(personDetail.body.data.subtasks.length, 2, 'an assigned person still reads both subtasks');

  // GET /tasks/:id/comments
  const unknownComments = await display('GET', '/tasks/999999/comments');
  const hiddenComments = await display('GET', `/tasks/${forDisplay}/comments`);
  assert.equal(hiddenComments.status, 404, 'the comments of an assignees task answer 404 on the wall');
  assert.deepEqual(hiddenComments.body, unknownComments.body, 'the refusal must equal the one for an unknown id');
  const sharedComments = await display('GET', `/tasks/${forAll}/comments`);
  assert.equal(sharedComments.status, 200, 'a household task keeps its comments');
  assert.equal(sharedComments.body.data.length, 1);
  const personComments = await asWanda('GET', `/tasks/${forDisplay}/comments`);
  assert.equal(personComments.status, 200, 'an assigned person still reads the comments');
  assert.equal(personComments.body.data.length, 1);

  // GET /tasks/completions
  const wallFeed = await feedIds(display);
  assert.ok(!wallFeed.includes(forDisplay), 'the feed leaves the entry of an assignees task off the wall');
  assert.ok(!wallFeed.includes(hiddenSub), 'the feed leaves the entry of an assignees subtask off the wall');
  assert.ok(wallFeed.includes(forAll) && wallFeed.includes(sharedSub), 'household entries stay in the wall feed');
  const personFeed = await feedIds(asWanda);
  assert.ok(personFeed.includes(forDisplay) && personFeed.includes(hiddenSub), 'an assigned person still reads both entries');
});

test('the wall rule holds at the remaining task reads: tags, documents, dashboard, points ledger', async () => {
  // Four reads outside the task routes above asked the task row rule with the display
  // account as the viewer: the tag lists, the linked documents of a task, the task
  // parts of the personal dashboard (no audience=household) and the task reference of
  // a points ledger row. A task with visibility `assignees` that names the display
  // showed through all four. The app never offers a display as an assignee, so the
  // rows are seeded directly.
  const created = await admin('POST', '/auth/users', {
    username: 'wilma', display_name: 'Wilma', password: 'wilmapass12345', role: 'member',
  });
  assert.equal(created.status, 201, `create member: ${JSON.stringify(created.body)}`);
  const WILMA = created.body.user.id;
  const asWilma = as(await login('wilma', 'wilmapass12345'));
  const { todayKey } = await import('../server/utils/timezone.js');
  const today = todayKey(db);

  /**
   * A task due today, flagged as a countdown, in its own category, with one tag and
   * one points row for Lea.
   * @param {string} title @param {string} visibility @param {number[]} assignees
   */
  const seeded = (title, visibility, assignees) => {
    const id = addTask(title, visibility);
    db.prepare("UPDATE tasks SET due_date = ?, countdown = 1, category = 'wallrest' WHERE id = ?").run(today, id);
    for (const userId of assignees) {
      db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
    }
    db.prepare('INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)').run(id, `tag-${id}`, `tag-${id}`);
    db.prepare(`
      INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, unit, created_by)
      VALUES (?, 4, 'earn', ?, ?, 'points', 1)
    `).run(LEA, title, id);
    return id;
  };
  const forDisplay = seeded('Dachboden', 'assignees', [displayId, WILMA]);
  const forAll = seeded('Hecke schneiden', 'all', []);

  // GET /tasks/tags and the tags of GET /tasks/meta/options
  /** @param {(m: string, p: string) => Promise<{ status: number, body: any }>} who */
  const tagLists = async (who) => {
    const tags = await who('GET', '/tasks/tags');
    const options = await who('GET', '/tasks/meta/options');
    assert.equal(tags.status, 200);
    assert.equal(options.status, 200);
    return [tags.body.data, options.body.tags].map((list) => list.map((/** @type {any} */ t) => t.tag));
  };
  for (const list of await tagLists(display)) {
    assert.ok(!list.includes(`tag-${forDisplay}`), 'the tag of an assignees task stays off the wall');
    assert.ok(list.includes(`tag-${forAll}`), 'the tag of a household task stays on the wall');
  }
  for (const list of await tagLists(asWilma)) {
    assert.ok(list.includes(`tag-${forDisplay}`) && list.includes(`tag-${forAll}`), 'an assigned person still lists both tags');
  }
  // A tag that also hangs on a household task stays.
  db.prepare('INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)').run(forAll, `tag-${forDisplay}`, `tag-${forDisplay}`);
  const [shared] = await tagLists(display);
  assert.ok(shared.includes(`tag-${forDisplay}`), 'a tag shared with a household task stays on the wall');
  db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_key = ?').run(forAll, `tag-${forDisplay}`);

  // GET /tasks/:id/documents
  const unknownDocs = await display('GET', '/tasks/999999/documents');
  const hiddenDocs = await display('GET', `/tasks/${forDisplay}/documents`);
  assert.equal(hiddenDocs.status, 404, 'the documents of an assignees task answer 404 on the wall');
  assert.deepEqual(hiddenDocs.body, unknownDocs.body, 'the refusal must equal the one for an unknown id');
  const sharedDocs = await display('GET', `/tasks/${forAll}/documents`);
  assert.equal(sharedDocs.status, 403, 'a household task keeps the refusal of a reader without documents');
  assert.equal(sharedDocs.body.reason, 'cross_module_access');
  assert.equal((await asWilma('GET', `/tasks/${forDisplay}/documents`)).status, 200, 'an assigned person still reads the documents');

  // GET /dashboard without audience=household
  /** @param {(m: string, p: string) => Promise<{ status: number, body: any }>} who @param {string} [query] */
  const overview = async (who, query = '') => {
    const res = await who('GET', `/dashboard?tasks_category=wallrest${query}`);
    assert.equal(res.status, 200);
    const b = res.body;
    return {
      urgent: b.urgentTasks.map((/** @type {any} */ t) => t.id),
      open: b.openTaskCount,
      members: b.memberTodayTasks.map((/** @type {any} */ m) => m.user_id),
      countdowns: b.countdowns.filter((/** @type {any} */ c) => c.source === 'task').map((/** @type {any} */ c) => c.id),
    };
  };
  const wallOverview = await overview(display);
  assert.ok(!wallOverview.urgent.includes(forDisplay), 'urgentTasks leaves an assignees task off the wall');
  assert.ok(wallOverview.urgent.includes(forAll), 'a household task stays in urgentTasks');
  assert.equal(wallOverview.open, 1, 'openTaskCount counts only the household task');
  assert.ok(!wallOverview.members.includes(displayId) && !wallOverview.members.includes(WILMA),
    'memberTodayTasks counts no assignee of the hidden task');
  assert.ok(!wallOverview.countdowns.includes(forDisplay), 'the task countdowns leave an assignees task off the wall');
  assert.ok(wallOverview.countdowns.includes(forAll), 'a household task stays among the countdowns');
  assert.deepEqual((await overview(display, '&audience=household')).urgent, [forAll], 'the household audience answers as before');
  const personOverview = await overview(asWilma);
  assert.deepEqual(personOverview.urgent.sort(), [forDisplay, forAll].sort(), 'an assigned person still sees both');
  assert.equal(personOverview.open, 2);
  assert.ok(personOverview.members.includes(WILMA), 'an assigned person still counts the task');
  assert.ok(personOverview.countdowns.includes(forDisplay) && personOverview.countdowns.includes(forAll));

  // GET /rewards/ledger: the row and its points stay, only the task reference goes.
  /** @param {(m: string, p: string) => Promise<{ status: number, body: any }>} who @param {string} reason */
  const ledgerRow = async (who, reason) => {
    const res = await who('GET', '/rewards/ledger?limit=500');
    assert.equal(res.status, 200);
    const ids = db.prepare('SELECT id FROM reward_ledger WHERE reason = ?').all(reason).map((/** @type {any} */ r) => r.id);
    return res.body.data.find((/** @type {any} */ e) => ids.includes(e.id));
  };
  const wallHidden = await ledgerRow(display, 'Dachboden');
  assert.ok(wallHidden, 'the ledger row itself stays on the wall');
  assert.equal(wallHidden.delta, 4, 'with its points');
  assert.equal(wallHidden.task_id, null, 'the wall does not learn the task of an assignees row');
  assert.equal(wallHidden.reason, null, 'nor its title');
  const wallShared = await ledgerRow(display, 'Hecke schneiden');
  assert.equal(wallShared.task_id, forAll, 'a household task keeps its reference on the wall');
  assert.equal(wallShared.reason, 'Hecke schneiden');
  const personHidden = await ledgerRow(asWilma, 'Dachboden');
  assert.equal(personHidden.task_id, forDisplay, 'an assigned person still reads the reference');
  assert.equal(personHidden.reason, 'Dachboden');
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
