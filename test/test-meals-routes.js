/**
 * Test: Meals-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Meals-Router - härtet die bislang nur via
 *        DB-Logik simulierte Route-Schicht ab (test-meals.js baut die Handler
 *        nach, ruft sie aber nicht auf). Fokus: Validierung (400), Nicht-
 *        gefunden (404), Zustandsübergänge der Wiederholungs-Serien
 *        (Template/Exceptions/Instanzen), Zutaten-CRUD und die Transfer-Semantik
 *        „Zutaten → Einkaufsliste" (nur offene übertragen, Idempotenz, Wochen-Scope).
 *        Meals sind haushaltsweit (kein owner/visibility), daher kein Auth-Gate-Teil.
 * Ausführen: node --experimental-sqlite --test test/test-meals-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
// Der Einkaufs-Router hängt mit drin, weil die Rücknahme eines Transfers über
// ihn läuft (POST /shopping/items/undo-transfer). Beim Mahlzeit-Pfad gehört das
// `on_shopping_list`-Flag zum Übertrag und muss mit zurück - das ist ohne beide
// Router nicht prüfbar.
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { addDays, mealWeekday } = await import('../server/services/meal-recurrence.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;
const LIST = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', ?)`).run(U).lastInsertRowid;
const RECIPE = db.prepare(`INSERT INTO recipes (title, created_by) VALUES ('Suppe', ?)`).run(U).lastInsertRowid;

let actor = { id: U, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/shopping', shoppingRouter);
app.use('/', mealsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

async function createMeal(fields) {
  return call('POST', '/', { date: '2026-06-15', meal_type: 'lunch', title: 'Pasta', ...fields });
}

// --------------------------------------------------------------------------
// GET /suggestions
// --------------------------------------------------------------------------
test('GET /suggestions: leere Query liefert leere Liste', async () => {
  const r = await call('GET', '/suggestions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

test('GET /suggestions: Präfix-Treffer liefert distinct Titel + Typ', async () => {
  await createMeal({ date: '2026-01-05', title: 'Lasagne' });
  await createMeal({ date: '2026-01-06', title: 'Lasagne' }); // Duplikat → DISTINCT
  const r = await call('GET', '/suggestions?q=Las');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].title, 'Lasagne');
  assert.equal(r.body.data[0].meal_type, 'lunch');
});

// --------------------------------------------------------------------------
// POST / (anlegen) - Validierung
// --------------------------------------------------------------------------
test('POST /: fehlender meal_type → 400', async () => {
  const r = await call('POST', '/', { date: '2026-06-15', title: 'X' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Mahlzeit-Typ/);
});

test('POST /: ungültiger meal_type → 400', async () => {
  const r = await createMeal({ meal_type: 'brunch' });
  assert.equal(r.status, 400);
});

test('POST /: ungültiges Datum → 400', async () => {
  const r = await createMeal({ date: '15.06.2026' });
  assert.equal(r.status, 400);
});

test('POST /: unbekannte recipe_id → 400', async () => {
  const r = await createMeal({ recipe_id: 99999 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Rezept nicht gefunden/);
});

test('POST /: Erfolg persistiert Mahlzeit + Zutaten, created_by gesetzt', async () => {
  const r = await createMeal({
    title: 'Curry',
    notes: 'scharf',
    ingredients: [{ name: 'Reis', quantity: '200g' }, { name: '' }], // leere gefiltert
  });
  assert.equal(r.status, 201);
  const meal = r.body.data;
  assert.equal(meal.title, 'Curry');
  assert.equal(meal.created_by, U);
  assert.equal(meal.ingredients.length, 1);
  assert.equal(meal.ingredients[0].name, 'Reis');
  const row = db.prepare('SELECT created_by FROM meals WHERE id = ?').get(meal.id);
  assert.equal(row.created_by, U);
});

// Synthetisches Zukunftsdatum: die Materialisierung greift nur für Vorlagen mit
// start_date <= Wochenende. Ein Datum weit in der Zukunft entkoppelt diesen Test
// von der Systemuhr - der spätere „GET / ohne Woche"-Aufruf (aktuelle Woche) kann
// diese Vorlage nie versehentlich vor-materialisieren.
const RECUR_BASE = '2040-06-04';

test('POST / mit repeat_weekly: Template + Sofort-Instanz mit recurrence_template_id', async () => {
  const r = await createMeal({ date: RECUR_BASE, title: 'Wochen-Pasta', repeat_weekly: true });
  assert.equal(r.status, 201);
  const meal = r.body.data;
  assert.ok(meal.recurrence_template_id, 'Instanz trägt Template-Bezug');
  const tpl = db.prepare('SELECT * FROM meal_recurrence_templates WHERE id = ?').get(meal.recurrence_template_id);
  assert.equal(tpl.title, 'Wochen-Pasta');
  assert.equal(tpl.weekday, mealWeekday(RECUR_BASE));
});

// --------------------------------------------------------------------------
// GET / (Wochenübersicht)
// --------------------------------------------------------------------------
test('GET / ohne Woche liefert Struktur mit weekStart/weekEnd', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.match(r.body.weekStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.body.weekEnd, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET /?week: nur Meals der Woche, sortiert nach meal_type (breakfast<lunch<dinner<snack)', async () => {
  // isolierte Woche im März 2026
  await createMeal({ date: '2026-03-10', meal_type: 'dinner', title: 'D' });
  await createMeal({ date: '2026-03-10', meal_type: 'breakfast', title: 'B' });
  await createMeal({ date: '2026-03-10', meal_type: 'snack', title: 'S' });
  await createMeal({ date: '2026-03-10', meal_type: 'lunch', title: 'L' });
  const r = await call('GET', '/?week=2026-03-10');
  assert.equal(r.status, 200);
  const sameDay = r.body.data.filter((m) => m.date === '2026-03-10');
  assert.deepEqual(sameDay.map((m) => m.meal_type), ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.ok('ingredients' in sameDay[0]);
});

test('GET /?week: materialisiert wiederkehrende Meals in Folgewoche', async () => {
  // Template aus RECUR_BASE (siehe repeat_weekly-Test) → Instanz eine Woche später
  const next = addDays(RECUR_BASE, 7);
  const before = db.prepare('SELECT COUNT(*) c FROM meals WHERE date = ?').get(next).c;
  assert.equal(before, 0, 'noch keine Instanz vor GET');
  const r = await call('GET', `/?week=${next}`);
  assert.equal(r.status, 200);
  const inst = db.prepare('SELECT * FROM meals WHERE date = ? AND recurrence_template_id IS NOT NULL').get(next);
  assert.ok(inst, 'Instanz materialisiert');
  assert.equal(inst.title, 'Wochen-Pasta');
});

// --------------------------------------------------------------------------
// POST /apply-plan
// --------------------------------------------------------------------------
test('POST /apply-plan: leere Zuweisungen → 400', async () => {
  const r = await call('POST', '/apply-plan', { assignments: [] });
  assert.equal(r.status, 400);
});

test('POST /apply-plan: ungültige Zuweisung → 400 (nichts angelegt)', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM meals').get().c;
  const r = await call('POST', '/apply-plan', {
    assignments: [
      { date: '2026-04-01', meal_type: 'lunch', title: 'ok' },
      { date: '2026-04-01', meal_type: 'brunch', title: 'bad' },
    ],
  });
  assert.equal(r.status, 400);
  const after = db.prepare('SELECT COUNT(*) c FROM meals').get().c;
  assert.equal(after, before, 'kein Teil-Insert bei Validierungsfehler');
});

test('POST /apply-plan: unbekannte recipe_id → 400', async () => {
  const r = await call('POST', '/apply-plan', {
    assignments: [{ date: '2026-04-01', meal_type: 'lunch', title: 'x', recipe_id: 99999 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Rezept nicht gefunden/);
});

test('POST /apply-plan: legt mehrere Mahlzeiten an', async () => {
  const r = await call('POST', '/apply-plan', {
    assignments: [
      { date: '2026-04-06', meal_type: 'breakfast', title: 'Müsli' },
      { date: '2026-04-06', meal_type: 'lunch', title: 'Salat' },
    ],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.length, 2);
});

test('POST /apply-plan mit replace_existing: ersetzt Meals im selben Slot', async () => {
  await createMeal({ date: '2026-04-13', meal_type: 'dinner', title: 'Alt' });
  const r = await call('POST', '/apply-plan', {
    replace_existing: true,
    assignments: [{ date: '2026-04-13', meal_type: 'dinner', title: 'Neu' }],
  });
  assert.equal(r.status, 201);
  const rows = db.prepare(`SELECT title FROM meals WHERE date = '2026-04-13' AND meal_type = 'dinner'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Neu');
});

// --------------------------------------------------------------------------
// PUT /:id
// --------------------------------------------------------------------------
test('PUT /:id: unbekannte ID → 404', async () => {
  const r = await call('PUT', '/999999', { title: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültiger meal_type → 400', async () => {
  const m = (await createMeal({ date: '2026-05-04', title: 'Edit' })).body.data;
  const r = await call('PUT', `/${m.id}`, { meal_type: 'brunch' });
  assert.equal(r.status, 400);
});

test('PUT /:id: unbekannte recipe_id → 400', async () => {
  const m = (await createMeal({ date: '2026-05-05', title: 'Edit2' })).body.data;
  const r = await call('PUT', `/${m.id}`, { recipe_id: 99999 });
  assert.equal(r.status, 400);
});

test('PUT /:id: Felder werden persistiert', async () => {
  const m = (await createMeal({ date: '2026-05-06', title: 'Vorher', notes: 'a' })).body.data;
  const r = await call('PUT', `/${m.id}`, { title: 'Nachher', notes: 'b', recipe_id: RECIPE });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'Nachher');
  const row = db.prepare('SELECT title, notes, recipe_id FROM meals WHERE id = ?').get(m.id);
  assert.equal(row.title, 'Nachher');
  assert.equal(row.notes, 'b');
  assert.equal(row.recipe_id, RECIPE);
});

test('PUT /:id?scope=series: schreibt Template + alle Instanzen + ersetzt Zutaten', async () => {
  const created = (await createMeal({ date: '2026-07-06', title: 'Serie', repeat_weekly: true, ingredients: [{ name: 'Alt' }] })).body.data;
  const tplId = created.recurrence_template_id;
  // zweite Instanz materialisieren
  const next = addDays('2026-07-06', 7);
  await call('GET', `/?week=${next}`);
  const r = await call('PUT', `/${created.id}?scope=series`, { title: 'Serie-Neu', ingredients: [{ name: 'Neu1' }, { name: 'Neu2' }] });
  assert.equal(r.status, 200);
  const tpl = db.prepare('SELECT title FROM meal_recurrence_templates WHERE id = ?').get(tplId);
  assert.equal(tpl.title, 'Serie-Neu');
  const instTitles = db.prepare('SELECT DISTINCT title FROM meals WHERE recurrence_template_id = ?').all(tplId);
  assert.deepEqual(instTitles.map((t) => t.title), ['Serie-Neu'], 'alle Instanzen umbenannt');
  const tplIng = db.prepare('SELECT COUNT(*) c FROM meal_recurrence_ingredients WHERE template_id = ?').get(tplId).c;
  assert.equal(tplIng, 2, 'Template-Zutaten ersetzt');
  const instIng = db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ?').get(created.id).c;
  assert.equal(instIng, 2, 'Instanz-Zutaten ersetzt');
});

test('PUT /:id: Datumsverschiebung einer Serien-Instanz erzeugt Ausnahme', async () => {
  const created = (await createMeal({ date: '2026-08-03', title: 'Move', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  const r = await call('PUT', `/${created.id}`, { date: '2026-08-04' });
  assert.equal(r.status, 200);
  const exc = db.prepare('SELECT 1 FROM meal_recurrence_exceptions WHERE template_id = ? AND date = ?').get(tplId, '2026-08-03');
  assert.ok(exc, 'Ausnahme für Original-Datum angelegt');
  const row = db.prepare('SELECT date FROM meals WHERE id = ?').get(created.id);
  assert.equal(row.date, '2026-08-04', 'Instanz verschoben');
});

// --------------------------------------------------------------------------
// DELETE /:id
// --------------------------------------------------------------------------
test('DELETE /:id: unbekannte ID → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: löscht Mahlzeit + Zutaten (CASCADE)', async () => {
  const m = (await createMeal({ date: '2026-05-11', title: 'Del', ingredients: [{ name: 'Z' }] })).body.data;
  const r = await call('DELETE', `/${m.id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE id = ?').get(m.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ?').get(m.id).c, 0);
});

test('DELETE /:id einer Serien-Instanz erzeugt Ausnahme statt Neu-Materialisierung', async () => {
  const created = (await createMeal({ date: '2026-09-07', title: 'DelSerie', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  const r = await call('DELETE', `/${created.id}`);
  assert.equal(r.status, 204);
  const exc = db.prepare('SELECT 1 FROM meal_recurrence_exceptions WHERE template_id = ? AND date = ?').get(tplId, '2026-09-07');
  assert.ok(exc, 'Ausnahme angelegt');
  // erneutes Laden der Woche materialisiert die Instanz NICHT erneut
  await call('GET', '/?week=2026-09-07');
  const cnt = db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, '2026-09-07').c;
  assert.equal(cnt, 0, 'keine Neu-Materialisierung nach Ausnahme');
});

// --------------------------------------------------------------------------
// Wiederholungs-Grenze (#619)
// --------------------------------------------------------------------------
test('POST / mit repeat_until: Template trägt end_date, Materialisierung hört dort auf', async () => {
  const start = '2041-03-04';
  const until = addDays(start, 7); // genau eine weitere Wiederholung
  const created = (await createMeal({ date: start, title: 'Begrenzt', repeat_weekly: true, repeat_until: until })).body.data;
  const tplId = created.recurrence_template_id;
  assert.equal(
    db.prepare('SELECT end_date FROM meal_recurrence_templates WHERE id = ?').get(tplId).end_date,
    until,
  );
  assert.equal(created.recurrence_end_date, until, 'Antwort nennt das Serien-Ende');

  await call('GET', `/?week=${until}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, until).c, 1);

  // Die Woche NACH dem Ende bleibt leer - genau das fehlte in #619
  const beyond = addDays(start, 14);
  await call('GET', `/?week=${beyond}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, beyond).c, 0);
});

test('POST /: repeat_until vor dem Datum → 400', async () => {
  const r = await createMeal({ date: '2041-04-01', repeat_weekly: true, repeat_until: '2041-03-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Wiederholungs-Ende/);
});

test('POST /: repeat_until ohne repeat_weekly bleibt folgenlos', async () => {
  const r = await createMeal({ date: '2041-04-08', title: 'Einmalig', repeat_until: '2041-04-01' });
  assert.equal(r.status, 201, 'kein Fehler, weil ohne Serie kein Ende existiert');
  assert.equal(r.body.data.recurrence_template_id, null);
});

test('PUT /:id?scope=series mit repeat_until: kürzt die Serie und räumt spätere Instanzen ab', async () => {
  const start = '2041-05-06';
  const created = (await createMeal({ date: start, title: 'Kürzen', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  const week2 = addDays(start, 7);
  const week3 = addDays(start, 14);
  await call('GET', `/?week=${week2}`);
  await call('GET', `/?week=${week3}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ?').get(tplId).c, 3);

  const r = await call('PUT', `/${created.id}?scope=series`, { repeat_until: week2 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT end_date FROM meal_recurrence_templates WHERE id = ?').get(tplId).end_date, week2);
  const dates = db.prepare('SELECT date FROM meals WHERE recurrence_template_id = ? ORDER BY date').all(tplId).map((m) => m.date);
  assert.deepEqual(dates, [start, week2], 'Instanz hinter dem Ende entfernt');

  // Und sie kommt nicht zurück
  await call('GET', `/?week=${week3}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, week3).c, 0);
});

test('PUT /:id?scope=series mit leerem repeat_until: Serie läuft wieder unbegrenzt', async () => {
  const start = '2041-06-03';
  const until = addDays(start, 7);
  const created = (await createMeal({ date: start, title: 'Entgrenzen', repeat_weekly: true, repeat_until: until })).body.data;
  const tplId = created.recurrence_template_id;

  const r = await call('PUT', `/${created.id}?scope=series`, { repeat_until: '' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT end_date FROM meal_recurrence_templates WHERE id = ?').get(tplId).end_date, null);

  const beyond = addDays(start, 14);
  await call('GET', `/?week=${beyond}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, beyond).c, 1);
});

test('PUT /:id?scope=series: repeat_until vor Serienbeginn → 400', async () => {
  const created = (await createMeal({ date: '2041-07-01', title: 'Zu früh', repeat_weekly: true })).body.data;
  const r = await call('PUT', `/${created.id}?scope=series`, { repeat_until: '2041-06-01' });
  assert.equal(r.status, 400);
});

test('DELETE /:id?scope=future: beendet die Serie ab diesem Termin, Vergangenes bleibt', async () => {
  const start = '2041-08-05';
  const created = (await createMeal({ date: start, title: 'AbHier', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  const week2 = addDays(start, 7);
  const week3 = addDays(start, 14);
  await call('GET', `/?week=${week2}`);
  await call('GET', `/?week=${week3}`);

  const second = db.prepare('SELECT id FROM meals WHERE recurrence_template_id = ? AND date = ?').get(tplId, week2);
  const r = await call('DELETE', `/${second.id}?scope=future`);
  assert.equal(r.status, 204);

  const dates = db.prepare('SELECT date FROM meals WHERE recurrence_template_id = ? ORDER BY date').all(tplId).map((m) => m.date);
  assert.deepEqual(dates, [start], 'nur der Termin vor dem Schnitt bleibt');
  assert.equal(
    db.prepare('SELECT end_date FROM meal_recurrence_templates WHERE id = ?').get(tplId).end_date,
    addDays(week2, -1),
  );

  // Kein Nachwachsen mehr - der Kern von #619
  await call('GET', `/?week=${week2}`);
  await call('GET', `/?week=${week3}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ?').get(tplId).c, 1);
});

test('DELETE /:id?scope=future auf dem ersten Termin entfernt die Vorlage ganz', async () => {
  const start = '2041-09-02';
  const created = (await createMeal({ date: start, title: 'AbStart', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  await call('GET', `/?week=${addDays(start, 7)}`);

  const r = await call('DELETE', `/${created.id}?scope=future`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meal_recurrence_templates WHERE id = ?').get(tplId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ?').get(tplId).c, 0);
});

test('DELETE /:id?scope=future ohne Serie löscht nur die Mahlzeit', async () => {
  const m = (await createMeal({ date: '2041-10-07', title: 'Solo' })).body.data;
  const r = await call('DELETE', `/${m.id}?scope=future`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE id = ?').get(m.id).c, 0);
});

test('DELETE /:id?scope=series: entfernt alle Instanzen + Template', async () => {
  const created = (await createMeal({ date: '2026-10-05', title: 'GanzeSerie', repeat_weekly: true })).body.data;
  const tplId = created.recurrence_template_id;
  await call('GET', `/?week=${addDays('2026-10-05', 7)}`); // zweite Instanz
  const r = await call('DELETE', `/${created.id}?scope=series`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ?').get(tplId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meal_recurrence_templates WHERE id = ?').get(tplId).c, 0);
});

// --------------------------------------------------------------------------
// Zutaten-CRUD
// --------------------------------------------------------------------------
test('POST /:id/ingredients: unbekannte Mahlzeit → 404', async () => {
  const r = await call('POST', '/999999/ingredients', { name: 'X' });
  assert.equal(r.status, 404);
});

test('POST /:id/ingredients: fehlender Name → 400', async () => {
  const m = (await createMeal({ date: '2026-05-18', title: 'Ing' })).body.data;
  const r = await call('POST', `/${m.id}/ingredients`, { name: '   ' });
  assert.equal(r.status, 400);
});

test('POST /:id/ingredients: fügt Zutat hinzu', async () => {
  const m = (await createMeal({ date: '2026-05-19', title: 'Ing2' })).body.data;
  const r = await call('POST', `/${m.id}/ingredients`, { name: 'Mehl', quantity: '500g', category: 'Backen' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'Mehl');
  assert.equal(r.body.data.quantity, '500g');
  assert.equal(r.body.data.category, 'Backen');
});

test('PATCH /ingredients/:ingId: unbekannt → 404', async () => {
  const r = await call('PATCH', '/ingredients/999999', { name: 'X' });
  assert.equal(r.status, 404);
});

test('PATCH /ingredients/:ingId: setzt on_shopping_list-Flag + Menge', async () => {
  const m = (await createMeal({ date: '2026-05-20', title: 'Ing3', ingredients: [{ name: 'Salz', quantity: '1TL' }] })).body.data;
  const ingId = m.ingredients[0].id;
  const r = await call('PATCH', `/ingredients/${ingId}`, { on_shopping_list: true, quantity: '2TL' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.on_shopping_list, 1);
  assert.equal(r.body.data.quantity, '2TL');
});

test('DELETE /ingredients/:ingId: unbekannt → 404', async () => {
  const r = await call('DELETE', '/ingredients/999999');
  assert.equal(r.status, 404);
});

test('DELETE /ingredients/:ingId: löscht Zutat', async () => {
  const m = (await createMeal({ date: '2026-05-21', title: 'Ing4', ingredients: [{ name: 'Pfeffer' }] })).body.data;
  const ingId = m.ingredients[0].id;
  const r = await call('DELETE', `/ingredients/${ingId}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE id = ?').get(ingId).c, 0);
});

// --------------------------------------------------------------------------
// Transfer: Zutaten → Einkaufsliste
// --------------------------------------------------------------------------
test('POST /:id/to-shopping-list: unbekannte Mahlzeit → 404', async () => {
  const r = await call('POST', '/999999/to-shopping-list', { listId: LIST });
  assert.equal(r.status, 404);
});

test('POST /:id/to-shopping-list: fehlende listId → 400', async () => {
  const m = (await createMeal({ date: '2026-06-01', title: 'T', ingredients: [{ name: 'A' }] })).body.data;
  const r = await call('POST', `/${m.id}/to-shopping-list`, {});
  assert.equal(r.status, 400);
});

test('POST /:id/to-shopping-list: unbekannte Liste → 404', async () => {
  const m = (await createMeal({ date: '2026-06-02', title: 'T2', ingredients: [{ name: 'A' }] })).body.data;
  const r = await call('POST', `/${m.id}/to-shopping-list`, { listId: 999999 });
  assert.equal(r.status, 404);
});

test('POST /:id/to-shopping-list: überträgt nur offene, markiert sie, idempotent', async () => {
  const m = (await createMeal({ date: '2026-06-03', title: 'T3', ingredients: [{ name: 'Ei' }, { name: 'Butter' }] })).body.data;
  const r1 = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.transferred, 2);
  const items = db.prepare('SELECT name, added_from_meal FROM shopping_items WHERE list_id = ? AND added_from_meal = ?').all(LIST, m.id);
  assert.equal(items.length, 2);
  const open = db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0').get(m.id).c;
  assert.equal(open, 0, 'alle als übertragen markiert');
  // zweiter Aufruf überträgt nichts
  const r2 = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r2.body.data.transferred, 0);
  assert.deepEqual(r2.body.data.added_ids, []);
});

/**
 * Beim Mahlzeit-Pfad gehört das `on_shopping_list`-Flag zum Übertrag.
 *
 * Wer nur die Einkaufsartikel löscht, lässt die Zutaten für immer als „schon
 * übertragen" zurück - weder auf der Liste noch erneut übertragbar. Genau
 * deshalb läuft die Rücknahme über einen eigenen Endpunkt und nicht über N
 * DELETEs (Audit 2026-07-30, P1-B).
 */
test('POST /:id/to-shopping-list: das Undo nimmt Artikel UND Zutaten-Flag zurück', async () => {
  const m = (await createMeal({
    date: '2026-06-04', title: 'Undo', ingredients: [{ name: 'Hafer' }, { name: 'Zimt' }],
  })).body.data;
  db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(LIST, 'Fremd');

  const r = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.body.data.transferred, 2);
  assert.equal(r.body.data.added_ids.length, 2);

  const undo = await call('POST', '/shopping/items/undo-transfer', { ids: r.body.data.added_ids });
  assert.equal(undo.body.data.removed, 2);

  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE added_from_meal = ?').get(m.id).c, 0,
    'die erzeugten Artikel sind weg',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE list_id = ? AND name = ?').get(LIST, 'Fremd').c, 1,
    'der Fremdartikel bleibt unberührt',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0').get(m.id).c, 2,
    'die Zutaten sind wieder offen',
  );

  // Der Beweis, dass die Rücknahme vollständig war: derselbe Transfer geht erneut.
  const again = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(again.body.data.transferred, 2);
});

test('POST /week-to-shopping-list: fehlende listId → 400', async () => {
  const r = await call('POST', '/week-to-shopping-list', { week: '2026-06-15' });
  assert.equal(r.status, 400);
});

test('POST /week-to-shopping-list: ungültige Woche → 400', async () => {
  const r = await call('POST', '/week-to-shopping-list', { listId: LIST, week: 'foo' });
  assert.equal(r.status, 400);
});

test('POST /week-to-shopping-list: unbekannte Liste → 404', async () => {
  const r = await call('POST', '/week-to-shopping-list', { listId: 999999, week: '2026-06-15' });
  assert.equal(r.status, 404);
});

test('POST /week-to-shopping-list: überträgt offene Zutaten der ganzen Woche', async () => {
  // eigene, unberührte Woche
  await createMeal({ date: '2026-11-02', meal_type: 'lunch', title: 'W1', ingredients: [{ name: 'Nudeln' }] });
  await createMeal({ date: '2026-11-04', meal_type: 'dinner', title: 'W2', ingredients: [{ name: 'Soße' }, { name: 'Käse' }] });
  const r = await call('POST', '/week-to-shopping-list', { listId: LIST, week: '2026-11-02' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 3);
  // erneut → 0
  const r2 = await call('POST', '/week-to-shopping-list', { listId: LIST, week: '2026-11-02' });
  assert.equal(r2.body.data.transferred, 0);
});

test.after(() => server.close());

// --------------------------------------------------------------------------
// Transfer-Fallback: Mahlzeit aus Rezept ohne eigene Zutaten
// --------------------------------------------------------------------------

const RECIPE_WITH_ING = db.prepare(`INSERT INTO recipes (title, created_by) VALUES ('Curry', ?)`).run(U).lastInsertRowid;
db.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, 'Reis', '250 g', 'Grundnahrung')`).run(RECIPE_WITH_ING);
db.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, 'Kokosmilch', '400 ml')`).run(RECIPE_WITH_ING);

test('GET /: rezeptbasierte Mahlzeit ohne eigene Zutaten meldet recipe_ingredient_count', async () => {
  await createMeal({ date: '2026-10-05', title: 'Curry-Abend', recipe_id: RECIPE_WITH_ING });
  const r = await call('GET', '/?week=2026-10-05');
  const meal = r.body.data.find((m) => m.title === 'Curry-Abend');
  assert.equal(meal.ingredients.length, 0, 'keine virtuellen Zutaten im Array');
  assert.equal(meal.recipe_ingredient_count, 2, 'aber die Zahl ist bekannt');
});

test('GET /: Mahlzeit mit eigenen Zutaten meldet recipe_ingredient_count 0', async () => {
  await createMeal({
    date: '2026-10-06', title: 'Eigenbau', recipe_id: RECIPE_WITH_ING,
    ingredients: [{ name: 'Nudeln' }],
  });
  const r = await call('GET', '/?week=2026-10-05');
  const meal = r.body.data.find((m) => m.title === 'Eigenbau');
  assert.equal(meal.ingredients.length, 1);
  assert.equal(meal.recipe_ingredient_count, 0, 'eigene Zutaten haben Vorrang');
});

test('POST /:id/to-shopping-list: materialisiert Rezeptzutaten und überträgt sie', async () => {
  const m = (await createMeal({ date: '2026-10-07', title: 'Curry-Transfer', recipe_id: RECIPE_WITH_ING })).body.data;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ?').get(m.id).c, 0);

  const r = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 2);

  const copied = db.prepare('SELECT name, quantity, category, on_shopping_list FROM meal_ingredients WHERE meal_id = ? ORDER BY id').all(m.id);
  assert.equal(copied.length, 2, 'Rezeptzutaten wurden zu echten meal_ingredients');
  assert.equal(copied[0].name, 'Reis');
  assert.equal(copied[0].quantity, '250 g');
  assert.equal(copied[0].category, 'Grundnahrung');
  assert.equal(copied[1].category, 'Sonstiges', 'Default greift wie bei eigenen Zutaten');
  assert.ok(copied.every((c) => c.on_shopping_list === 1), 'alle als übertragen markiert');

  const items = db.prepare('SELECT name FROM shopping_items WHERE list_id = ? AND added_from_meal = ?').all(LIST, m.id);
  assert.equal(items.length, 2);
});

test('POST /:id/to-shopping-list: materialisiert nicht erneut nach vollständigem Transfer', async () => {
  const m = (await createMeal({ date: '2026-10-08', title: 'Curry-Zweitlauf', recipe_id: RECIPE_WITH_ING })).body.data;
  await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });

  const second = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(second.body.data.transferred, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ?').get(m.id).c, 2,
    'keine Duplikate durch zweite Materialisierung',
  );
});

test('POST /:id/to-shopping-list: eigene Zutaten schließen die Rezeptzutaten aus', async () => {
  const m = (await createMeal({
    date: '2026-10-09', title: 'Nur-Eigen', recipe_id: RECIPE_WITH_ING,
    ingredients: [{ name: 'Brot' }],
  })).body.data;

  const r = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.body.data.transferred, 1, 'nur die eigene Zutat, kein Reis/Kokosmilch');
  const names = db.prepare('SELECT name FROM meal_ingredients WHERE meal_id = ?').all(m.id).map((i) => i.name);
  assert.deepEqual(names, ['Brot']);
});

test('POST /:id/to-shopping-list: Mahlzeit ohne Rezept und ohne Zutaten → 0 übertragen', async () => {
  const m = (await createMeal({ date: '2026-10-10', title: 'Leer' })).body.data;
  const r = await call('POST', `/${m.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 0);
});
