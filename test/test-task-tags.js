/**
 * Modul: Aufgaben-Tags (#586)
 * Zweck: Hält die zwei Dinge fest, die dieses Feature ausmachen und die je für
 *        sich still brechen können:
 *
 *          - Migration v114 baut `tasks` neu, um den Kategorie-Default zu
 *            reparieren, den v83 stehen ließ. Ein Rebuild droppt die Tabelle und
 *            nimmt Indizes und die drei Suchindex-Trigger mit. Werden die nicht
 *            vollständig neu angelegt, läuft die Suche danach still auf einem
 *            einfrierenden Index weiter - nichts wirft, nichts fehlt sichtbar.
 *          - Tags sind bewusst NICHT die Kategorie. Eine Aufgabe liegt in einer
 *            Schublade, trägt aber beliebig viele Etiketten. Die Suite hält
 *            fest, dass beide Achsen unabhängig bleiben.
 *
 *        Der CalDAV-Weg (CATEGORIES rein und raus) liegt in
 *        test-caldav-todo-outbound.js, wo schon der übrige VTODO-Verkehr steht.
 * Ausführen: npm run test:task-tags
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-tags-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { createTasksApp } = await import('./tasks-app.js');
const { normalizeTags, tagsKey, setTags, loadTags, allTags, setItemTags, loadItemTags,
  MAX_TAGS, MAX_TAG_LEN } = await import('../server/utils/task-tags.js');
const { runSearch } = await import('../server/services/search.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  // Fremdschlüssel wie im Migrations-Runner pausieren, wo die Migration es
  // verlangt - sonst reißt der Rebuild von `tasks` die abhängigen Zeilen mit.
  for (const migration of migrations) {
    if (!migration.foreignKeysOff) { applyMigration(db, migration); continue; }
    db.pragma('foreign_keys = OFF');
    try { applyMigration(db, migration); } finally { db.pragma('foreign_keys = ON'); }
  }
  return db;
}

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function seedTask({ createdBy = ALICE, category = undefined } = {}) {
  return category === undefined
    ? get().prepare('INSERT INTO tasks (title, created_by) VALUES (?, ?)')
        .run(`Task-${randomUUID()}`, createdBy).lastInsertRowid
    : get().prepare('INSERT INTO tasks (title, created_by, category) VALUES (?, ?, ?)')
        .run(`Task-${randomUUID()}`, createdBy, category).lastInsertRowid;
}

async function createHarness({ userId = ALICE, role = 'admin' } = {}) {
  const app = await createTasksApp({
    auth: (req, _res, next) => {
      req.authUserId = userId;
      req.authRole = role;
      req.session = { userId, role };
      next();
    },
  });
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

// ── Migration v114: der reparierte Kategorie-Default ────────────────────────────

test('v114: neue Aufgaben ohne Kategorie landen auf einem gültigen Key', () => {
  const id = seedTask();
  const category = get().prepare('SELECT category FROM tasks WHERE id = ?').get(id).category;
  assert.equal(category, 'misc');
  // Der eigentliche Fehler von v83 war nicht der Name, sondern dass der Wert in
  // keiner Kategorie stand: die Aufgabe fiel aus jedem Dropdown und Filter.
  const known = get().prepare('SELECT 1 FROM task_categories WHERE key = ?').get(category);
  assert.ok(known, `Spalten-Default "${category}" muss in task_categories existieren`);
});

test('v114: der Rebuild lässt keinen Index und keinen Trigger zurück', () => {
  const objects = get().prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name = 'tasks' AND type != 'table'"
  ).all();
  const names = objects.map((o) => o.name);

  for (const index of ['idx_tasks_status', 'idx_tasks_assigned', 'idx_tasks_parent',
                       'idx_tasks_start_date', 'idx_tasks_external']) {
    assert.ok(names.includes(index), `Index ${index} fehlt nach dem Rebuild`);
  }
  for (const trigger of ['trg_search_tasks_ai', 'trg_search_tasks_au', 'trg_search_tasks_ad']) {
    assert.ok(names.includes(trigger), `Trigger ${trigger} fehlt nach dem Rebuild`);
  }
});

test('v114: die Suchindex-Trigger feuern noch (vorhanden heißt nicht wirksam)', () => {
  const id = seedTask();
  const indexed = () => get().prepare(
    "SELECT title FROM search_index WHERE entity = 'task' AND entity_id = ?"
  ).get(id);

  assert.ok(indexed(), 'INSERT muss den Suchindex füllen');

  get().prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Umbenannt', id);
  assert.equal(indexed().title, 'Umbenannt', 'UPDATE muss den Suchindex nachziehen');

  get().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(indexed(), undefined, 'DELETE muss den Suchindex aufräumen');
});

// ── Normalisierung ─────────────────────────────────────────────────────────────

test('normalizeTags trimmt, entfernt Leeres und eint Groß-/Kleinschreibung', () => {
  assert.deepEqual(normalizeTags(['  Garten ', '', '   ', 'garten', 'Haus']), ['Garten', 'Haus']);
});

test('normalizeTags nimmt auch einen kommaseparierten String', () => {
  assert.deepEqual(normalizeTags('Garten, Haus ,, Hof'), ['Garten', 'Haus', 'Hof']);
});

test('normalizeTags deckelt Anzahl und Länge, statt abzulehnen', () => {
  const many = normalizeTags(Array.from({ length: MAX_TAGS + 10 }, (_, i) => `tag-${i}`));
  assert.equal(many.length, MAX_TAGS);
  const long = normalizeTags(['x'.repeat(MAX_TAG_LEN + 50)]);
  assert.equal(long[0].length, MAX_TAG_LEN);
});

test('tagsKey ignoriert die Reihenfolge', () => {
  // Sonst löste eine bloße Umsortierung einen Push zum CalDAV-Server aus.
  assert.equal(tagsKey(['Garten', 'Haus']), tagsKey(['Haus', 'Garten']));
  assert.notEqual(tagsKey(['Garten']), tagsKey(['Garten', 'Haus']));
});

test('tagsKey achtet auf die Schreibweise', () => {
  // Die Gegenprobe zur Reihenfolge, und der Grund steht am Umbenennen: würde
  // tagsKey die Schreibweise einebnen, erreichte ein Umbenennen von "garten" auf
  // "Garten" den CalDAV-Server nie. Lokal stünde die neue Schreibweise, der
  // Feldvergleich sähe keine Änderung, und der nächste Sync-Lauf holte die alte
  // zurück - eine Umbenennung, die sich von selbst rückgängig macht.
  assert.notEqual(tagsKey(['garten']), tagsKey(['Garten']));
});

// ── Speicherschicht ────────────────────────────────────────────────────────────

test('setTags ersetzt die Liste vollständig', () => {
  const id = seedTask();
  setTags(get(), id, ['Garten', 'Haus']);
  assert.deepEqual(loadTags(get(), id), ['Garten', 'Haus']);

  setTags(get(), id, ['Hof']);
  assert.deepEqual(loadTags(get(), id), ['Hof']);

  setTags(get(), id, []);
  assert.deepEqual(loadTags(get(), id), []);
});

test('Tags verschwinden mit ihrer Aufgabe (CASCADE)', () => {
  const id = seedTask();
  setTags(get(), id, ['Garten']);
  get().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(get().prepare('SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?').get(id).n, 0);
});

test('allTags zählt über Aufgaben hinweg', () => {
  const a = seedTask();
  const b = seedTask();
  setTags(get(), a, ['Zähltest']);
  setTags(get(), b, ['Zähltest']);
  const entry = allTags(get(), ALICE).find((e) => e.tag === 'Zähltest');
  assert.equal(entry.count, 2);
  get().prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(a, b);
});

// ── API ────────────────────────────────────────────────────────────────────────

test('POST legt Tags an, GET liefert sie zurück', async () => {
  const h = await createHarness();
  try {
    const post = await h.call('POST', '/', { title: 'Rasen mähen', tags: ['Garten', 'Sommer'] });
    assert.equal(post.status, 201);
    assert.deepEqual(post.body.data.tags, ['Garten', 'Sommer']);

    const detail = await h.call('GET', `/${post.body.data.id}`);
    assert.deepEqual(detail.body.data.tags, ['Garten', 'Sommer']);
  } finally {
    await h.close();
  }
});

test('PUT ohne tags-Feld lässt die Tags unangetastet', async () => {
  const h = await createHarness();
  try {
    const post = await h.call('POST', '/', { title: 'Unberührt', tags: ['Garten'] });
    const id = post.body.data.id;

    const put = await h.call('PUT', `/${id}`, { title: 'Umbenannt' });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.data.tags, ['Garten'],
      'Ein Client, der nur den Titel schickt, darf keine Tags verlieren');
  } finally {
    await h.close();
  }
});

test('PUT mit leerem Array entfernt alle Tags', async () => {
  const h = await createHarness();
  try {
    const post = await h.call('POST', '/', { title: 'Leeren', tags: ['Garten'] });
    const put = await h.call('PUT', `/${post.body.data.id}`, { tags: [] });
    assert.deepEqual(put.body.data.tags, []);
  } finally {
    await h.close();
  }
});

test('POST weist eine Tag-Liste ab, die keine ist', async () => {
  const h = await createHarness();
  try {
    const res = await h.call('POST', '/', { title: 'Kaputt', tags: { garten: true } });
    assert.equal(res.status, 400, 'Ein Objekt darf nicht als leere Liste durchgehen');
  } finally {
    await h.close();
  }
});

test('GET ?tag= filtert ohne Rücksicht auf Groß-/Kleinschreibung', async () => {
  const h = await createHarness();
  try {
    const marker = `Filtertest-${randomUUID().slice(0, 8)}`;
    const withTag = await h.call('POST', '/', { title: 'Mit Tag', tags: [marker] });
    await h.call('POST', '/', { title: 'Ohne Tag' });

    const hit = await h.call('GET', `/?tag=${encodeURIComponent(marker.toLowerCase())}`);
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.body.data.map((t) => t.id), [withTag.body.data.id]);
  } finally {
    await h.close();
  }
});

test('Tags und Kategorie bleiben getrennte Achsen', async () => {
  const h = await createHarness();
  try {
    // Der ganze Grund für die eigene Tabelle: ein Tag darf die Schublade nicht
    // umstellen, und alle Werte müssen überleben - nicht nur der erste.
    const post = await h.call('POST', '/', {
      title: 'Zwei Achsen', category: 'household', tags: ['Garten', 'Sommer', 'Balkon'],
    });
    assert.equal(post.body.data.category, 'household');
    assert.equal(post.body.data.tags.length, 3);
  } finally {
    await h.close();
  }
});

test('GET /tags listet die vergebenen Tags mit Häufigkeit', async () => {
  const h = await createHarness();
  try {
    const marker = `Liste-${randomUUID().slice(0, 8)}`;
    await h.call('POST', '/', { title: 'A', tags: [marker] });
    await h.call('POST', '/', { title: 'B', tags: [marker] });

    const res = await h.call('GET', '/tags');
    assert.equal(res.status, 200);
    const entry = res.body.data.find((e) => e.tag === marker);
    assert.equal(entry?.count, 2);
  } finally {
    await h.close();
  }
});

test('meta/options liefert die Tags für die Filterleiste mit', async () => {
  const h = await createHarness();
  try {
    const marker = `Meta-${randomUUID().slice(0, 8)}`;
    await h.call('POST', '/', { title: 'Meta', tags: [marker] });
    const res = await h.call('GET', '/meta/options');
    assert.ok(res.body.tags.some((e) => e.tag === marker));
  } finally {
    await h.close();
  }
});

// ── Sichtbarkeit (#474 auf dem Tag-Lesepfad) ───────────────────────────────────
//
// Ein Tag ist Freitext und trägt damit selbst Inhalt. Eine Tag-Liste ohne
// Sichtbarkeitsprüfung verrät den Inhalt einer privaten Aufgabe, obwohl die
// Aufgabe selbst nirgends auftaucht - der dokumentierte Anwendungsfall
// ("Überraschung vorbereiten") wäre damit hinfällig. Die folgenden drei Tests
// halten fest, dass die Regel auf beiden Tag-Routen greift und dass sie nicht
// über das Ziel hinausschießt.

test('GET /tags verschweigt die Tags einer privaten Aufgabe', async () => {
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const marker = `Geheim-${randomUUID().slice(0, 8)}`;
    await owner.call('POST', '/', { title: 'Geschenk kaufen', visibility: 'private', tags: [marker] });

    const mine = await owner.call('GET', '/tags');
    assert.ok(mine.body.data.some((e) => e.tag === marker),
      'Der eigenen Ersteller:in bleibt der Tag erhalten');

    const theirs = await other.call('GET', '/tags');
    assert.equal(theirs.body.data.some((e) => e.tag === marker), false,
      'Der Tag einer privaten Aufgabe darf in keiner fremden Filterleiste stehen');
  } finally {
    await owner.close();
    await other.close();
  }
});

test('meta/options verschweigt sie ebenso', async () => {
  // Zweiter Lesepfad, dieselbe Quelle: die Filterleiste wird beim Seitenaufbau
  // aus meta/options gefüllt und erst danach aus /tags nachgeladen. Ein Leck an
  // nur einer der beiden Stellen fiele beim Testen der anderen nicht auf.
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const marker = `Geheim-${randomUUID().slice(0, 8)}`;
    await owner.call('POST', '/', { title: 'Zweiter Pfad', visibility: 'private', tags: [marker] });

    const theirs = await other.call('GET', '/meta/options');
    assert.equal(theirs.body.tags.some((e) => e.tag === marker), false);
  } finally {
    await owner.close();
    await other.close();
  }
});

test('der Zähler in /tags überspringt die unsichtbaren Aufgaben', async () => {
  // Nicht nur der Tag-Name verrät etwas, auch seine Häufigkeit: stünde eine
  // private Aufgabe im Zähler eines sonst öffentlichen Tags, wäre ihre Existenz
  // ablesbar, ohne dass sie in irgendeiner Liste auftaucht.
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const marker = `Zähler-${randomUUID().slice(0, 8)}`;
    await owner.call('POST', '/', { title: 'Für alle', tags: [marker] });
    await owner.call('POST', '/', { title: 'Nur für mich', visibility: 'private', tags: [marker] });

    assert.equal(
      (await owner.call('GET', '/tags')).body.data.find((e) => e.tag === marker)?.count, 2);
    assert.equal(
      (await other.call('GET', '/tags')).body.data.find((e) => e.tag === marker)?.count, 1,
      'Fremde dürfen nur die sichtbare Aufgabe mitgezählt bekommen');
  } finally {
    await owner.close();
    await other.close();
  }
});

// ── Mehrfach-Filter ────────────────────────────────────────────────────────────

test('mehrere Tags verbinden sich mit UND, nicht mit ODER', async () => {
  // Jeder weitere Filter in derselben Leiste engt ein (Status UND Priorität UND
  // Person). Ein Tag, der die Liste plötzlich wachsen ließe, wäre dort ein Bruch.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const beide  = await h.call('POST', '/', { title: 'A', tags: [`x${m}`, `y${m}`] });
    await h.call('POST', '/', { title: 'B', tags: [`x${m}`] });

    const res = await h.call('GET', `/?tag=x${m}&tag=y${m}`);
    assert.deepEqual(res.body.data.map((t) => t.id), [beide.body.data.id]);
  } finally {
    await h.close();
  }
});

test('ein einzelnes ?tag= ist genau EIN Tag, auch mit Komma darin', async () => {
  // Der Fall, der die CSV-Bequemlichkeit gekostet hat: bei genau einem
  // Vorkommen liefert Express einen String, nicht ein Array. Wurde der am Komma
  // getrennt, suchte "Haus, Hof" nach zwei Tags und fand garantiert nichts -
  // dabei ist genau das ein Tag, den CATEGORIES ausdrücklich zulässt.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const tag = `Haus, Hof ${m}`;
    const treffer = await h.call('POST', '/', { title: 'Mit Komma', tags: [tag] });
    await h.call('POST', '/', { title: 'Nur Haus', tags: [`Haus ${m}`] });

    const res = await h.call('GET', `/?tag=${encodeURIComponent(tag)}`);
    assert.deepEqual(res.body.data.map((t) => t.id), [treffer.body.data.id]);
  } finally {
    await h.close();
  }
});

test('der Tag-Filter faltet auch Umlaute', async () => {
  // SQLites COLLATE NOCASE faltet nur ASCII: "Äpfel" wäre über "äpfel" nicht
  // auffindbar, über "ÄPFEL" schon. Deshalb liegt der Vergleich auf einer
  // eigenen, in JS normalisierten Spalte.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const post = await h.call('POST', '/', { title: 'Obst', tags: [`Äpfel${m}`] });

    for (const schreibweise of [`äpfel${m}`, `ÄPFEL${m}`, `Äpfel${m}`]) {
      const res = await h.call('GET', `/?tag=${encodeURIComponent(schreibweise)}`);
      assert.deepEqual(res.body.data.map((t) => t.id), [post.body.data.id],
        `"${schreibweise}" muss dieselbe Aufgabe finden`);
    }
  } finally {
    await h.close();
  }
});

test('Umlaut-Schreibweisen gelten auch beim Zählen und Umbenennen als ein Tag', async () => {
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    await h.call('POST', '/', { title: 'A', tags: [`Öl${m}`] });
    await h.call('POST', '/', { title: 'B', tags: [`öl${m}`] });

    const eintraege = (await h.call('GET', '/tags')).body.data
      .filter((e) => e.tag.toLowerCase().includes(`öl${m}`.toLowerCase()));
    assert.equal(eintraege.length, 1, 'Die Filterleiste zeigt ein Etikett, nicht zwei');
    assert.equal(eintraege[0].count, 2);

    const um = await h.call('PUT', `/tags/${encodeURIComponent(`ÖL${m}`)}`, { name: `Speiseöl${m}` });
    assert.equal(um.body.data.updated, 2, 'Umbenennen erwischt beide Schreibweisen');
  } finally {
    await h.close();
  }
});

// ── Verwaltung: umbenennen, entfernen, bulk ────────────────────────────────────

test('PUT /tags/:tag benennt auf allen sichtbaren Aufgaben um', async () => {
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`alt${m}`, 'Haus'] });
    const b = await h.call('POST', '/', { title: 'B', tags: [`alt${m}`] });

    const res = await h.call('PUT', `/tags/${encodeURIComponent(`alt${m}`)}`, { name: `neu${m}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.updated, 2);

    assert.deepEqual(loadTags(get(), a.body.data.id), ['Haus', `neu${m}`]);
    assert.deepEqual(loadTags(get(), b.body.data.id), [`neu${m}`]);
  } finally {
    await h.close();
  }
});

test('Umbenennen auf einen vorhandenen Tag führt beide zusammen, ohne Dublette', async () => {
  // Der Fall, an dem ein naives UPDATE task_tags SET tag=? scheitert: der
  // Primärschlüssel vergleicht Bytes, "Haus" und "haus" wären zwei Zeilen, und
  // die Aufgabe trüge hinterher beide Schreibweisen desselben Etiketts.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`alt${m}`, `ziel${m}`] });

    await h.call('PUT', `/tags/${encodeURIComponent(`alt${m}`)}`, { name: `ZIEL${m}` });
    assert.deepEqual(loadTags(get(), a.body.data.id), [`ZIEL${m}`],
      'Zusammengeführt auf die getippte Schreibweise, genau einmal');
  } finally {
    await h.close();
  }
});

test('die Zusammenführung eint auch die Aufgaben, die nur den Zieltag tragen', async () => {
  // Sonst stünde dasselbe Etikett hinterher in zwei Schreibweisen im Bestand.
  // allTags gruppiert NOCASE und zeigt davon genau eine - welche, entscheidet
  // dann die Zeile, die SQLite zuerst greift.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const mitAlt  = await h.call('POST', '/', { title: 'A', tags: [`alt${m}`] });
    const nurZiel = await h.call('POST', '/', { title: 'B', tags: [`ziel${m}`] });

    const res = await h.call('PUT', `/tags/${encodeURIComponent(`alt${m}`)}`, { name: `ZIEL${m}` });
    assert.equal(res.body.data.updated, 2);
    assert.deepEqual(loadTags(get(), mitAlt.body.data.id),  [`ZIEL${m}`]);
    assert.deepEqual(loadTags(get(), nurZiel.body.data.id), [`ZIEL${m}`]);

    const entries = res.body.data.tags.filter((e) => e.tag.toLowerCase() === `ziel${m}`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tag, `ZIEL${m}`, 'Die Filterleiste zeigt eine eindeutige Schreibweise');
  } finally {
    await h.close();
  }
});

test('Umbenennen kann allein die Schreibweise ändern', async () => {
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`klein${m}`] });

    const res = await h.call('PUT', `/tags/${encodeURIComponent(`klein${m}`)}`, { name: `KLEIN${m}` });
    assert.equal(res.body.data.updated, 1, 'Eine reine Umschreibung ist eine Änderung');
    assert.deepEqual(loadTags(get(), a.body.data.id), [`KLEIN${m}`]);
  } finally {
    await h.close();
  }
});

test('DELETE /tags/:tag löst den Tag, lässt die Aufgaben stehen', async () => {
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'Bleibt', tags: [`weg${m}`, 'Haus'] });

    const res = await h.call('DELETE', `/tags/${encodeURIComponent(`weg${m}`)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(loadTags(get(), a.body.data.id), ['Haus']);
    assert.equal((await h.call('GET', `/${a.body.data.id}`)).status, 200, 'Die Aufgabe lebt');
  } finally {
    await h.close();
  }
});

test('Umbenennen und Löschen fassen fremde private Aufgaben nicht an', async () => {
  // Die Kehrseite der Sichtbarkeitsregel: wer eine Zeile nicht sehen darf, darf
  // sie auch nicht ändern. Sonst verriete allein die gemeldete Trefferzahl, dass
  // es sie gibt.
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const m = randomUUID().slice(0, 6);
    const geheim = await owner.call('POST', '/', {
      title: 'Geheim', visibility: 'private', tags: [`geteilt${m}`],
    });
    const offen = await other.call('POST', '/', { title: 'Offen', tags: [`geteilt${m}`] });

    const res = await other.call('PUT', `/tags/${encodeURIComponent(`geteilt${m}`)}`, { name: `neu${m}` });
    assert.equal(res.body.data.updated, 1, 'Nur die sichtbare Aufgabe zählt mit');
    assert.deepEqual(loadTags(get(), offen.body.data.id), [`neu${m}`]);
    assert.deepEqual(loadTags(get(), geheim.body.data.id), [`geteilt${m}`],
      'Die private Aufgabe behält ihren Tag');
  } finally {
    await owner.close();
    await other.close();
  }
});

test('PUT /tags/:tag auf einen unbekannten Tag → 404', async () => {
  const h = await createHarness();
  try {
    const res = await h.call('PUT', `/tags/gibtesnicht-${randomUUID().slice(0, 8)}`, { name: 'X' });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('POST /tags/apply hängt an und nimmt weg, in einem Aufruf', async () => {
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`weg${m}`] });
    const b = await h.call('POST', '/', { title: 'B', tags: [`weg${m}`, 'Haus'] });

    const res = await h.call('POST', '/tags/apply', {
      ids: [a.body.data.id, b.body.data.id], add: [`neu${m}`], remove: [`weg${m}`],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.updated, 2);
    assert.deepEqual(loadTags(get(), a.body.data.id), [`neu${m}`]);
    assert.deepEqual(loadTags(get(), b.body.data.id), ['Haus', `neu${m}`]);
  } finally {
    await h.close();
  }
});

test('POST /tags/apply zählt nur, was sich wirklich geändert hat', async () => {
  // Sonst meldete "3 Aufgaben aktualisiert", wo zwei den Tag schon trugen - und
  // jede unveränderte Aufgabe liefe zusätzlich als Push zum CalDAV-Server.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`da${m}`] });
    const b = await h.call('POST', '/', { title: 'B' });

    const res = await h.call('POST', '/tags/apply', {
      ids: [a.body.data.id, b.body.data.id], add: [`da${m}`],
    });
    assert.equal(res.body.data.updated, 1);
  } finally {
    await h.close();
  }
});

test('POST /tags/apply überspringt Aufgaben, die die Person nicht sehen darf', async () => {
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const m = randomUUID().slice(0, 6);
    const geheim = await owner.call('POST', '/', { title: 'Geheim', visibility: 'private' });
    const offen  = await other.call('POST', '/', { title: 'Offen' });

    const res = await other.call('POST', '/tags/apply', {
      ids: [geheim.body.data.id, offen.body.data.id], add: [`x${m}`],
    });
    assert.equal(res.body.data.updated, 1);
    assert.deepEqual(loadTags(get(), geheim.body.data.id), []);
  } finally {
    await owner.close();
    await other.close();
  }
});

test('POST /tags/apply ohne ids oder ohne Änderung → 400', async () => {
  const h = await createHarness();
  try {
    assert.equal((await h.call('POST', '/tags/apply', { add: ['X'] })).status, 400);
    const task = await h.call('POST', '/', { title: 'Leer' });
    assert.equal((await h.call('POST', '/tags/apply', { ids: [task.body.data.id] })).status, 400);
  } finally {
    await h.close();
  }
});

// ── Wiederkehrende Aufgaben ────────────────────────────────────────────────────

test('die Folgeinstanz einer Serie erbt die Tags', async () => {
  // Tags gehören zur Aufgabe, nicht zum einzelnen Durchlauf. Ohne das Erben
  // verlöre eine wöchentliche Aufgabe ihre Etiketten beim ersten Abhaken, und
  // zwar lautlos: die Folgeinstanz sieht ansonsten vollständig aus.
  const h = await createHarness();
  try {
    const marker = `Serie-${randomUUID().slice(0, 8)}`;
    const past = new Date(Date.now() - 21 * 86400_000).toISOString().slice(0, 10);
    const post = await h.call('POST', '/', {
      title: `Bad putzen ${marker}`, due_date: past,
      is_recurring: true, recurrence_rule: 'FREQ=WEEKLY', tags: [marker, 'Haushalt'],
    });
    assert.equal(post.status, 201);

    const done = await h.call('PATCH', `/${post.body.data.id}/status`, { status: 'done' });
    assert.equal(done.status, 200);

    const followups = get().prepare(
      `SELECT id FROM tasks WHERE title = ? AND status = 'open' AND parent_task_id IS NULL`,
    ).all(`Bad putzen ${marker}`);
    assert.equal(followups.length, 1, 'Vorbedingung: genau eine Folgeinstanz');
    assert.deepEqual(loadTags(get(), followups[0].id), ['Haushalt', marker].sort((a, b) =>
      a.localeCompare(b, 'de', { sensitivity: 'base' })));
  } finally {
    await h.close();
  }
});

// ── Globale Suche ──────────────────────────────────────────────────────────────
//
// Ein Tag ist Freitext und damit Inhalt. Die Aufgabenliste filtert danach; fände
// die globale Suche ihn nicht, führte dasselbe Wort je nach Eingabefeld zu einem
// Treffer oder zu keinem.

test('die Suche findet eine Aufgabe über ihren Tag', async () => {
  const h = await createHarness();
  try {
    const marker = `suchtag${randomUUID().slice(0, 6)}`;
    const post = await h.call('POST', '/', { title: 'Nichts Passendes im Titel', tags: [marker] });

    const hits = runSearch(get(), marker, ALICE).tasks;
    assert.deepEqual(hits.map((t) => t.id), [post.body.data.id]);
  } finally {
    await h.close();
  }
});

test('ein nachträglich vergebener Tag landet ohne Zutun im Index', () => {
  // Der Trigger auf `tasks` sieht nur die Zeile. Ohne die eigenen Trigger auf
  // task_tags bliebe eine reine Tag-Änderung unindiziert - die Aufgabe selbst
  // wird dabei nicht angefasst.
  const marker = `nachtrag${randomUUID().slice(0, 6)}`;
  const id = seedTask();
  assert.equal(runSearch(get(), marker, ALICE).tasks.length, 0, 'Vorbedingung');

  setTags(get(), id, [marker]);
  assert.deepEqual(runSearch(get(), marker, ALICE).tasks.map((t) => t.id), [id]);
});

test('ein entfernter Tag verschwindet aus dem Index', () => {
  const marker = `entfernt${randomUUID().slice(0, 6)}`;
  const id = seedTask();
  setTags(get(), id, [marker]);
  assert.equal(runSearch(get(), marker, ALICE).tasks.length, 1, 'Vorbedingung');

  setTags(get(), id, []);
  assert.equal(runSearch(get(), marker, ALICE).tasks.length, 0);
});

test('eine gelöschte Aufgabe hinterlässt keine Karteileiche im Index', () => {
  // Der Fall, an dem ein VALUES-INSERT im Tag-Trigger scheitert: beim Löschen
  // räumt CASCADE die Tag-Zeilen ab und feuert den Trigger, obwohl es die
  // Aufgabe nicht mehr gibt. Das INSERT ... SELECT findet dann nichts.
  const marker = `leiche${randomUUID().slice(0, 6)}`;
  const id = seedTask();
  setTags(get(), id, [marker]);

  get().prepare('DELETE FROM tasks WHERE id = ?').run(id);

  assert.equal(runSearch(get(), marker, ALICE).tasks.length, 0);
  assert.equal(
    get().prepare(`SELECT COUNT(*) AS n FROM search_index WHERE entity = 'task' AND entity_id = ?`).get(id).n,
    0, 'Auch die Indexzeile selbst muss weg sein');
});

// ── Einkaufsposten ─────────────────────────────────────────────────────────────

test('Einkaufsposten tragen dieselbe Tag-Achse und sind darüber auffindbar', () => {
  // Eine CalDAV-Erinnerungsliste kann auf Aufgaben ODER auf den Einkauf zeigen
  // (#617). Bis hierher fielen die CATEGORIES eines Einkaufspostens weg.
  const marker = `einkauf${randomUUID().slice(0, 6)}`;
  const listId = get().prepare(
    'INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)'
  ).run(`Liste-${randomUUID()}`, ALICE).lastInsertRowid;
  const itemId = get().prepare(
    'INSERT INTO shopping_items (list_id, name) VALUES (?, ?)'
  ).run(listId, 'Milch').lastInsertRowid;

  setItemTags(get(), itemId, ['Bio', marker]);
  assert.deepEqual(loadItemTags(get(), itemId), ['Bio', marker]);
  assert.deepEqual(runSearch(get(), marker, ALICE).items.map((i) => i.id), [itemId]);

  get().prepare('DELETE FROM shopping_items WHERE id = ?').run(itemId);
  assert.equal(runSearch(get(), marker, ALICE).items.length, 0, 'CASCADE räumt auch den Index');
});

test('die Kategorie eines Einkaufspostens bleibt von den Tags unberührt', () => {
  // Die Kategorie ist hier der Gang im Laden - eine verwaltete Liste. Fremde
  // CATEGORIES hineinzuspülen liesse sie bei jedem Sync wachsen.
  const listId = get().prepare(
    'INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)'
  ).run(`Liste-${randomUUID()}`, ALICE).lastInsertRowid;
  const itemId = get().prepare(
    'INSERT INTO shopping_items (list_id, name) VALUES (?, ?)'
  ).run(listId, 'Äpfel').lastInsertRowid;
  const before = get().prepare('SELECT category FROM shopping_items WHERE id = ?').get(itemId).category;

  setItemTags(get(), itemId, ['Obst & Gemüse', 'Bio']);

  assert.equal(get().prepare('SELECT category FROM shopping_items WHERE id = ?').get(itemId).category, before);
});

// ── Unteraufgaben ──────────────────────────────────────────────────────────────

test('eine Unteraufgabe liefert ihre Tags mit', async () => {
  // Sonst fehlten sie in der Antwort, und ein PUT auf Basis dieser Zeile
  // schriebe sie still weg.
  const h = await createHarness();
  try {
    const parent = await h.call('POST', '/', { title: 'Eltern' });
    const marker = `unter${randomUUID().slice(0, 6)}`;
    await h.call('POST', '/', {
      title: 'Kind', parent_task_id: parent.body.data.id, tags: [marker],
    });

    const detail = await h.call('GET', `/${parent.body.data.id}`);
    assert.equal(detail.body.data.subtasks.length, 1);
    assert.deepEqual(detail.body.data.subtasks[0].tags, [marker]);
  } finally {
    await h.close();
  }
});

test('eine private Unteraufgabe bleibt Fremden verborgen, samt ihrer Tags', async () => {
  // loadSubtasks hing noch nie an der Sichtbarkeitsregel: unter einer geteilten
  // Elternaufgabe wurde eine private Unteraufgabe samt Titel ausgeliefert. Mit
  // den Tags käme deren Freitext dazu.
  const bob = seedUser('bob', 'member');
  const owner = await createHarness();
  const other = await createHarness({ userId: bob, role: 'member' });
  try {
    const m = randomUUID().slice(0, 6);
    const parent = await owner.call('POST', '/', { title: 'Geteilte Eltern' });
    await owner.call('POST', '/', {
      title: 'Geheimes Kind', parent_task_id: parent.body.data.id,
      visibility: 'private', tags: [`geheim${m}`],
    });
    await owner.call('POST', '/', {
      title: 'Offenes Kind', parent_task_id: parent.body.data.id, tags: [`offen${m}`],
    });

    const mine = await owner.call('GET', `/${parent.body.data.id}`);
    assert.equal(mine.body.data.subtasks.length, 2, 'Der Ersteller sieht beide');

    const theirs = await other.call('GET', `/${parent.body.data.id}`);
    assert.deepEqual(theirs.body.data.subtasks.map((s) => s.title), ['Offenes Kind']);
    assert.equal(
      JSON.stringify(theirs.body.data.subtasks).includes(`geheim${m}`), false,
      'Auch der Tag der privaten Unteraufgabe darf nicht durchscheinen');
  } finally {
    await owner.close();
    await other.close();
  }
});

test('v114 nimmt den AUTOINCREMENT-Hochstand über den Rebuild mit', () => {
  // Der Fall spielt sich über die Migration hinweg ab, nicht innerhalb einer
  // Sitzung: wer vor dem Upgrade die höchste Aufgabe gelöscht hat, dessen
  // Rebuild kopiert nur die überlebenden Zeilen und liesse sqlite_sequence auf
  // deren Maximum zurückfallen. Die nächste Aufgabe bekäme eine schon vergebene
  // ID - und reminders zeigt ohne Fremdschlüssel darauf, eine verwaiste
  // Erinnerung fiele der neuen Aufgabe zu.
  //
  // Deshalb eine eigene Datenbank, die bei v113 anhält, Aufgaben anlegt, die
  // höchste löscht und erst dann weitermigriert.
  const db = buildMigratedDatabase(MIGRATIONS.filter((m) => m.version <= 113));
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
              VALUES ('seq', 'Seq', 'h', 'admin')`).run();
  const insert = db.prepare('INSERT INTO tasks (title, created_by) VALUES (?, 1)');
  insert.run('eins');
  const hoechste = Number(insert.run('zwei').lastInsertRowid);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(hoechste);

  for (const migration of MIGRATIONS.filter((m) => m.version > 113)) {
    if (!migration.foreignKeysOff) { applyMigration(db, migration); continue; }
    db.pragma('foreign_keys = OFF');
    try { applyMigration(db, migration); } finally { db.pragma('foreign_keys = ON'); }
  }

  const naechste = Number(insert.run('drei').lastInsertRowid);
  assert.ok(naechste > hoechste,
    `Die neue Aufgabe erbt eine schon vergebene ID (${naechste}, zuvor vergeben: ${hoechste})`);
  db.close();
});

test('Punkt-Tags entstehen gar nicht erst', () => {
  // "." und ".." lösen sich im Pfadsegment der Verwaltungsrouten auf:
  // /tasks/tags/.. wird zu /tasks/, das Umbenennen landete still auf einer
  // fremden Route. Prozentkodieren hilft nicht, %2E wird ebenso aufgelöst.
  assert.deepEqual(normalizeTags(['.', '..', 'Garten']), ['Garten']);
  // Die Gegenprobe: alles andere übersteht das Segment und bleibt erlaubt.
  assert.deepEqual(normalizeTags(['a/b', 'a\\b', 'Haus, Hof', '...']),
    ['a/b', 'a\\b', 'Haus, Hof', '...']);
});

test('Umbenennen nimmt einen Namen mit Komma als EINEN Tag', async () => {
  // Derselbe Fehler wie beim Filter, eine Funktion weiter: die String-Form von
  // normalizeTags trennt am Komma, "Haus, Hof" wäre zu "Haus" geworden - bei
  // gemeldetem Erfolg.
  const h = await createHarness();
  try {
    const m = randomUUID().slice(0, 6);
    const a = await h.call('POST', '/', { title: 'A', tags: [`alt${m}`] });
    const res = await h.call('PUT', `/tags/${encodeURIComponent(`alt${m}`)}`, { name: `Haus, Hof ${m}` });
    assert.equal(res.status, 200);
    assert.deepEqual(loadTags(get(), a.body.data.id), [`Haus, Hof ${m}`]);
  } finally {
    await h.close();
  }
});

test('v114 rettet den Hochstand auch, wenn keine Aufgabe überlebt', () => {
  // Die Gegenprobe zum Fall darüber. Sie hält fest, dass auch der Extremfall
  // trägt: eine Kopie mit null Zeilen legt für die neue Tabelle trotzdem einen
  // sqlite_sequence-Eintrag an (seq = 0), den das RENAME mitnimmt - erst
  // dadurch findet das UPDATE etwas vor, das es anheben kann.
  const db = buildMigratedDatabase(MIGRATIONS.filter((m) => m.version <= 113));
  db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
              VALUES ('leer', 'Leer', 'h', 'admin')`).run();
  const insert = db.prepare('INSERT INTO tasks (title, created_by) VALUES (?, 1)');
  insert.run('eins');
  const hoechste = Number(insert.run('zwei').lastInsertRowid);
  db.prepare('DELETE FROM tasks').run();          // ALLE, nicht nur die höchste

  for (const migration of MIGRATIONS.filter((m) => m.version > 113)) {
    if (!migration.foreignKeysOff) { applyMigration(db, migration); continue; }
    db.pragma('foreign_keys = OFF');
    try { applyMigration(db, migration); } finally { db.pragma('foreign_keys = ON'); }
  }

  const naechste = Number(insert.run('drei').lastInsertRowid);
  assert.ok(naechste > hoechste,
    `Auch bei leerer Tabelle darf keine ID erneut vergeben werden (${naechste}, zuvor: ${hoechste})`);
  db.close();
});
