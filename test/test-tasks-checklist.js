/**
 * Test: Antippbare Checklisten in Aufgaben (Discussion #917)
 *
 * Das Gegenstueck zu test-notes-checklist.js. Die REGEL selbst
 * (markdown-checklist.js) ist dort geprueft und wird hier nicht wiederholt -
 * geprueft wird, was die Aufgaben eigenhaendig tun:
 *
 *  - PATCH /:id/check aendert genau eine Zeile der Beschreibung
 *  - zwei Mitglieder haken verschiedene Zeilen ab, ohne sich zu ueberschreiben
 *    (der Grund, warum die Route neben PUT existiert)
 *  - die SPERRE (#830) haelt einen Haken NICHT auf, die SICHTBARKEIT schon
 *  - eine CalDAV-gespiegelte Aufgabe wird fuer den Push vorgemerkt, eine
 *    folgenlose Wiederholung nicht
 *  - die Detailansicht schaltet die Kaestchen frei, Dashboard und Kalender nicht
 *  - i18n: die neuen Keys in allen Locales
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-tasks-checklist.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile, readdir } from 'node:fs/promises';

const dbmod = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const database = dbmod.get();

const mkUser = (name) => database
  .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')")
  .run(name, name).lastInsertRowid;

const OWNER    = mkUser('owner');
const OTHER    = mkUser('other');
const OUTSIDER = mkUser('outsider');

// Wer gerade ruft - die Testfaelle schalten das um, statt drei Server zu bauen.
let actingUser = OWNER;
let actingRole = 'member';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actingUser;
  req.authRole   = actingRole;
  req.session    = { userId: actingUser, role: actingRole };
  next();
});
app.use('/', tasksRouter);
const server  = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/* KEIN VERKEHR AUSSER ZUM EIGENEN TESTSERVER.
 *
 * Die Route stoesst nach einem Haken auf einer gespiegelten Aufgabe einen
 * Sofort-Push an (flushOutbound). Ohne diese Klammer ging daraus ein echter
 * DNS- und Verbindungsversuch nach draussen - ein Test, dessen Laufzeit vom
 * Netz des Rechners abhaengt, ist kein deterministischer Test mehr.
 *
 * Der Wrapper laesst nur den eigenen Server durch und weist alles andere ab.
 * Damit ist die Suite nicht nur netzfrei, sie BELEGT es auch: telefonierte die
 * Route je woandershin, faellt es hier auf statt in einer roten CI. */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input);
  if (url.startsWith(baseUrl)) return realFetch(input, init);
  return Promise.reject(new Error(`Test darf nicht nach draussen rufen: ${url}`));
};
test.after(() => { globalThis.fetch = realFetch; });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

/**
 * Direkt in die Tabelle statt ueber POST: die Anlage-Route zieht Kategorien,
 * Serien und Punkte mit, und nichts davon hat mit einem Haken zu tun.
 */
function newTask(description, extra = {}) {
  const cols = { title: 'T', description, created_by: OWNER, visibility: 'all', ...extra };
  const keys = Object.keys(cols);
  return database.prepare(
    `INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map((k) => cols[k])).lastInsertRowid;
}

const descriptionOf = (id) => database.prepare('SELECT description FROM tasks WHERE id = ?').get(id).description;

// --------------------------------------------------------------------------
// Die Route
// --------------------------------------------------------------------------

test('PATCH /:id/check setzt genau einen Haken', async () => {
  const id = newTask('- [ ] Zelt\n- [ ] Schlafsack');
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.description, '- [x] Zelt\n- [ ] Schlafsack');
  assert.equal(descriptionOf(id), '- [x] Zelt\n- [ ] Schlafsack');
});

test('PATCH /:id/check nimmt ihn wieder zurueck', async () => {
  const id = newTask('- [x] Zelt');
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: false });
  assert.equal(r.body.data.description, '- [ ] Zelt');
});

test('der Rest der Beschreibung bleibt zeichengetreu', async () => {
  const id = newTask('Packliste\r\n\r\n  * [ ] Zelt  \r\n- [ ] Schlafsack');
  await call('PATCH', `/${id}/check`, { line: 2, checked: true });
  assert.equal(descriptionOf(id), 'Packliste\r\n\r\n  * [x] Zelt  \r\n- [ ] Schlafsack',
    'Zeilenenden, Einzug und nachlaufende Leerzeichen gehoeren nicht zum Haken');
});

test('zwei Mitglieder haken verschiedene Zeilen ab - beide Haken bleiben', async () => {
  const id = newTask('- [ ] Zelt\n- [ ] Schlafsack');
  // Beide haben denselben Stand gesehen. Ueber PUT gaebe es hier genau einen
  // Haken, weil der zweite Schreiber den ganzen Text mitbraechte.
  //
  // `expect` ist die Zeile OHNE ihren Umbruch: splitKeepingLineEndings trennt
  // Text und Trenner in getrennte Felder, und der Client liest parts[line * 2].
  actingUser = OWNER;
  const first = await call('PATCH', `/${id}/check`, { line: 0, checked: true, expect: '- [ ] Zelt' });
  actingUser = OTHER;
  const second = await call('PATCH', `/${id}/check`, { line: 1, checked: true, expect: '- [ ] Schlafsack' });
  actingUser = OWNER;
  assert.equal(first.status, 200, 'der erste Haken muss durchgehen');
  assert.equal(second.status, 200, 'der zweite auch - sie meinen verschiedene Zeilen');
  assert.equal(descriptionOf(id), '- [x] Zelt\n- [x] Schlafsack');
});

test('veraltete Zeile → 409 statt eines Hakens in der falschen Zeile', async () => {
  const id = newTask('- [ ] Zelt\n- [ ] Schlafsack');
  const r = await call('PATCH', `/${id}/check`, { line: 1, checked: true, expect: '- [ ] Zelt' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'stale');
  assert.equal(descriptionOf(id), '- [ ] Zelt\n- [ ] Schlafsack', 'nichts darf geschrieben worden sein');
});

test('eine Zeile ohne Kaestchen laesst sich nicht abhaken', async () => {
  const id = newTask('Nur Text');
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'not_a_checklist_line');
});

test('eine Zeile hinter dem Textende laesst sich nicht abhaken', async () => {
  const id = newTask('- [ ] Zelt');
  const r = await call('PATCH', `/${id}/check`, { line: 9, checked: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'out_of_range');
});

test('eine Aufgabe ohne Beschreibung laeuft nicht in einen Fehler', async () => {
  const id = newTask(null);
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 409, 'kein 500 - eine leere Beschreibung hat schlicht keine Zeile 0');
});

test('fehlende oder falsch getypte Angaben → 400', async () => {
  const id = newTask('- [ ] Zelt');
  assert.equal((await call('PATCH', `/${id}/check`, { checked: true })).status, 400);
  assert.equal((await call('PATCH', `/${id}/check`, { line: -1, checked: true })).status, 400);
  assert.equal((await call('PATCH', `/${id}/check`, { line: 0 })).status, 400);
  assert.equal((await call('PATCH', `/${id}/check`, { line: 0, checked: 'ja' })).status, 400);
  assert.equal((await call('PATCH', `/${id}/check`, { line: 0, checked: true, expect: 7 })).status, 400);
});

test('eine unbekannte Aufgabe → 404', async () => {
  assert.equal((await call('PATCH', '/999999/check', { line: 0, checked: true })).status, 404);
});

// --------------------------------------------------------------------------
// Sperre und Sichtbarkeit - zwei Regeln, die hier verschieden ausgehen
// --------------------------------------------------------------------------

test('eine GESPERRTE Aufgabe laesst sich weiterhin abhaken', async () => {
  // #830 sperrt die DEFINITION, nicht den Fortschritt: PATCH /:id/status kommt
  // ebenfalls ohne mayEditTaskDefinition aus. Ein Checklisten-Haken ist
  // derselbe Vorgang eine Ebene tiefer.
  const id = newTask('- [ ] Zelt', { locked: 1 });
  actingUser = OTHER;
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  actingUser = OWNER;
  assert.equal(r.status, 200, 'gesperrt heisst nicht unantastbar - abhaken darf jeder, der sie sieht');
  assert.equal(descriptionOf(id), '- [x] Zelt');
});

test('eine private Aufgabe eines anderen bleibt unerreichbar', async () => {
  // 404 statt 403, wie ueberall in diesem Router: dass es sie gibt, ist selbst
  // schon eine Auskunft (Muster aus #769).
  const id = newTask('- [ ] Geheim', { visibility: 'private' });
  actingUser = OUTSIDER;
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  actingUser = OWNER;
  assert.equal(r.status, 404);
  assert.equal(descriptionOf(id), '- [ ] Geheim', 'eine geratene id darf nichts schreiben');
});

test('wer zugewiesen ist, darf abhaken', async () => {
  const id = newTask('- [ ] Zelt', { visibility: 'assignees' });
  database.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, OTHER);
  actingUser = OTHER;
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  actingUser = OWNER;
  assert.equal(r.status, 200);
});

// --------------------------------------------------------------------------
// CalDAV: die Beschreibung ist ein gespiegeltes Feld
// --------------------------------------------------------------------------

const dirtyOf = (id) => database.prepare('SELECT outbound_dirty FROM tasks WHERE id = ?').get(id).outbound_dirty;

// isMirrored() verlangt ein Konto, das es WIRKLICH gibt - eine erfundene
// external_account_id genuegt nicht, und ohne dieses Konto waeren die beiden
// Tests darunter aus dem falschen Grund gruen.
const ACCOUNT = database.prepare(
  "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('A', 'https://x/dav', 'u', 'p')"
).run().lastInsertRowid;

test('ein Haken auf einer gespiegelten Aufgabe wird fuer den Push vorgemerkt', async () => {
  // Ohne diesen Marker bliebe der Haken lokal und der naechste Inbound
  // ueberschriebe ihn wieder - der Nutzer haekt ab, und es kommt zurueck.
  const id = newTask('- [ ] Zelt', {
    external_source: 'caldav', external_uid: 'uid-1', external_account_id: ACCOUNT,
  });
  await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  assert.equal(dirtyOf(id), 1);
});

test('ein folgenloser Tap merkt nichts vor', async () => {
  // Zwei Leute haken denselben Punkt ab: der zweite Aufruf ist kein Fehler,
  // aber auch keine Aenderung - und darf der Gegenstelle keine melden.
  const id = newTask('- [x] Zelt', {
    external_source: 'caldav', external_uid: 'uid-2', external_account_id: ACCOUNT,
  });
  const r = await call('PATCH', `/${id}/check`, { line: 0, checked: true });
  assert.equal(r.status, 200, 'einig zu sein ist kein Konflikt');
  assert.equal(dirtyOf(id), 0);
});

// --------------------------------------------------------------------------
// Die Oberflaeche
// --------------------------------------------------------------------------

test('die Aufgaben-Detailansicht schaltet die Kaestchen frei', async () => {
  // Die Ansicht wohnt seit #918 in der geteilten Komponente - und damit gelten
  // die Kaestchen ueberall, wo eine Aufgabe geoeffnet wird, nicht nur im Modul.
  const src = await readFile(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  assert.match(src, /interactive:\s*true/, 'die Kaestchen sind Bedienelemente');
  assert.match(src, /tasks\/\$\{task\.id\}\/check/, 'sie schreiben ueber die schmale Route zurueck');
  assert.match(src, /note-md-box\[data-md-line\]/, 'ein Klick auf das Kaestchen wird erkannt');
});

test('der Zeilenindex wird gegen den GESEHENEN Text geprueft', async () => {
  const src = await readFile(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  assert.match(src, /splitKeepingLineEndings\(task\.description\)\[line \* 2\]/,
    'expect ist die Gegenprobe zum Index - ohne sie landet ein Haken in der falschen Zeile');
  assert.match(src, /task\.description = res\.data\.description/,
    'der lokale Stand kommt aus der Antwort, sonst laeuft expect beim zweiten Tap ins Leere');
});

test('Dashboard und Kalender rendern Aufgabentext NICHT interaktiv', async () => {
  // Dieselbe Begruendung wie bei den Notizen: beide zeigen einen Auszug, dessen
  // Zeilennummern nicht die der Aufgabe sind.
  for (const page of ['dashboard.js', 'calendar.js']) {
    const src = await readFile(new URL(`../public/pages/${page}`, import.meta.url), 'utf8');
    for (const c of src.match(/renderMarkdownLight\([^)]*\)/g) ?? []) {
      assert.doesNotMatch(c, /checklist|interactive/, `${page} zeigt einen Auszug, keinen Stand`);
    }
  }
});

// --------------------------------------------------------------------------
// i18n
// --------------------------------------------------------------------------

test('die neuen Keys stehen in allen Locales und sind uebersetzt', async () => {
  const dir   = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 24, `unerwartet wenige Locales: ${files.length}`);

  const de = JSON.parse(await readFile(new URL('de.json', dir), 'utf8'));
  for (const f of files) {
    const d = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    for (const key of ['checklistToggle', 'checkConflict']) {
      assert.ok(d.tasks?.[key], `${f}: tasks.${key} fehlt`);
      assert.doesNotMatch(d.tasks[key], /\[de:/, `${f}: tasks.${key} ist ein Platzhalter`);
      if (f !== 'de.json' && f !== 'en.json') {
        assert.notEqual(d.tasks[key], de.tasks[key], `${f}: tasks.${key} steht noch auf Deutsch`);
      }
    }
  }
});
