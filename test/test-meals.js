/**
 * Modul: Essensplan-Test
 * Zweck: Validiert alle Meals-API-Abfragen, Zutaten-CRUD, Wochensortierung,
 *        Einkaufslisten-Integration
 * Ausführen: node --experimental-sqlite test-meals.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { datesForTemplateInRange, mealWeekday } from '../server/services/meal-recurrence.js';
import { __test as mealsUi } from '../public/pages/meals.js';
import { toDecimalString } from '../public/utils/money.js';
import { todayKey } from '../public/utils/date.js';
import { t } from '../public/i18n.js';
import { setDisplayTimeZone, _resetDisplayTimeZoneCache } from '../public/utils/timezone.js';
import { parseQuantity } from '../server/services/shopping-import.js';
import { eachRule } from './css-rules.js';
// Dieselben Module, die meals.js ueber den Loader sieht (browser-absolute Pfade):
// das Griff-Label wird gegen genau das t()/esc() verglichen, das es erzeugt hat.
import { t as pageT } from '/i18n.js';
import { esc as pageEsc } from '/utils/html.js';

const mealsSource = readFileSync(new URL('../public/pages/meals.js', import.meta.url), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);
db.exec(MIGRATIONS_SQL[13]);
db.exec(MIGRATIONS_SQL[64]);
db.exec(MIGRATIONS_SQL[73]);

// Test-Benutzer
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;

// Einkaufsliste für Integration-Tests
const sl = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', ?)`).run(uid);
const listId = sl.lastInsertRowid;

console.log('\n[Meals-Test] Wochenplan, Zutaten, Einkaufslisten-Integration\n');

let mealId1, mealId2, mealId3, ingId1, ingId2;

// --------------------------------------------------------
// Mahlzeit CRUD
// --------------------------------------------------------
test('Mahlzeit erstellen (Mittagessen)', () => {
  const r = db.prepare(`
    INSERT INTO meals (date, meal_type, title, notes, created_by)
    VALUES ('2026-03-23', 'lunch', 'Spaghetti Bolognese', 'Klassiker', ?)
  `).run(uid);
  mealId1 = r.lastInsertRowid;
  assert(mealId1 > 0);
});

test('Mahlzeit erstellen (Frühstück)', () => {
  const r = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-23', 'breakfast', 'Müsli mit Früchten', ?)
  `).run(uid);
  mealId2 = r.lastInsertRowid;
  assert(mealId2 > 0);
});

test('Mahlzeit erstellen (andere Woche)', () => {
  const r = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-30', 'dinner', 'Pizza Margherita', ?)
  `).run(uid);
  mealId3 = r.lastInsertRowid;
  assert(mealId3 > 0);
});

test('Mahlzeiten einer Woche abrufen', () => {
  const meals = db.prepare(`
    SELECT * FROM meals
    WHERE date BETWEEN '2026-03-23' AND '2026-03-29'
    ORDER BY date ASC,
      CASE meal_type
        WHEN 'breakfast' THEN 0
        WHEN 'lunch'     THEN 1
        WHEN 'dinner'    THEN 2
        WHEN 'snack'     THEN 3
        ELSE 4
      END ASC
  `).all();
  assert(meals.length === 2, `Erwartet 2, erhalten ${meals.length}`);
  assert(meals[0].meal_type === 'breakfast', 'Frühstück zuerst');
  assert(meals[1].meal_type === 'lunch', 'Mittagessen danach');
});

test('Andere Woche hat nur eigene Mahlzeiten', () => {
  const meals = db.prepare(`
    SELECT * FROM meals WHERE date BETWEEN '2026-03-30' AND '2026-04-05'
  `).all();
  assert(meals.length === 1, `Erwartet 1, erhalten ${meals.length}`);
  assert(meals[0].title === 'Pizza Margherita');
});

test('Mahlzeit aktualisieren', () => {
  db.prepare(`UPDATE meals SET title = 'Spaghetti Carbonara', notes = NULL WHERE id = ?`).run(mealId1);
  const m = db.prepare('SELECT title, notes FROM meals WHERE id = ?').get(mealId1);
  assert(m.title === 'Spaghetti Carbonara', 'Titel aktualisiert');
  assert(m.notes === null, 'Notizen gelöscht');
});

test('Mahlzeit-Typ-Constraint (ungültiger Wert)', () => {
  let threw = false;
  try {
    db.prepare(`INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-03-24', 'brunch', 'Test', ?)`).run(uid);
  } catch { threw = true; }
  assert(threw, 'Constraint muss verletzt werden');
});

// --------------------------------------------------------
// Wiederkehrende Mahlzeiten
// --------------------------------------------------------
let recurrenceTemplateId;

test('Wiederkehrende Mahlzeit: Wochentag wird Montag-basiert berechnet', () => {
  assert(mealWeekday('2026-03-23') === 0, 'Montag ist 0');
  assert(mealWeekday('2026-03-29') === 6, 'Sonntag ist 6');
});

test('Wiederkehrende Mahlzeit: Daten starten nicht vor dem Startdatum', () => {
  const dates = datesForTemplateInRange(
    { start_date: '2026-03-25', weekday: 2 },
    '2026-03-23',
    '2026-04-12'
  );
  assert(dates.length === 3, `3 Mittwoche erwartet, erhalten ${dates.length}`);
  assert(dates[0] === '2026-03-25', 'Startdatum ist erstes Vorkommen');
  assert(dates[2] === '2026-04-08', 'Folgewoche korrekt');
});

test('Wiederkehrende Mahlzeit: Template und Zutaten anlegen', () => {
  const template = db.prepare(`
    INSERT INTO meal_recurrence_templates
      (start_date, weekday, meal_type, title, notes, created_by)
    VALUES ('2026-03-25', 2, 'dinner', 'Pasta Wednesday', 'weekly', ?)
  `).run(uid);
  recurrenceTemplateId = template.lastInsertRowid;

  db.prepare(`
    INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
    VALUES (?, 'Pasta', '500g', 'Sonstiges')
  `).run(recurrenceTemplateId);

  assert(recurrenceTemplateId > 0, 'Template angelegt');
});

test('Wiederkehrende Mahlzeit: nur ein Vorkommen pro Template und Datum', () => {
  db.prepare(`
    INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
    VALUES ('2026-04-01', 'dinner', 'Pasta Wednesday', ?, ?)
  `).run(recurrenceTemplateId, uid);

  let threw = false;
  try {
    db.prepare(`
      INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
      VALUES ('2026-04-01', 'dinner', 'Pasta Wednesday again', ?, ?)
    `).run(recurrenceTemplateId, uid);
  } catch { threw = true; }

  assert(threw, 'Unique-Index verhindert doppelte Vorkommen');
});

test('Wiederkehrende Mahlzeit: Skip-Ausnahme blockiert ein Datum', () => {
  db.prepare(`
    INSERT INTO meal_recurrence_exceptions (template_id, date, created_by)
    VALUES (?, '2026-04-08', ?)
  `).run(recurrenceTemplateId, uid);

  const exception = db.prepare(`
    SELECT 1 FROM meal_recurrence_exceptions
    WHERE template_id = ? AND date = '2026-04-08'
  `).get(recurrenceTemplateId);
  assert(exception, 'Ausnahme gespeichert');
});

// --------------------------------------------------------
// Serie bearbeiten / löschen (scope=series) — spiegelt die Route-Handler-SQL
// --------------------------------------------------------

test('Serie bearbeiten: Template + alle Instanzen + Zutaten propagieren', () => {
  const tpl = db.prepare(`
    INSERT INTO meal_recurrence_templates
      (start_date, weekday, meal_type, title, notes, created_by)
    VALUES ('2026-05-04', 0, 'breakfast', 'Porridge', NULL, ?)
  `).run(uid).lastInsertRowid;
  db.prepare(`INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
              VALUES (?, 'Oats', '100g', 'Sonstiges')`).run(tpl);

  const i1 = db.prepare(`INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
                         VALUES ('2026-05-04', 'breakfast', 'Porridge', ?, ?)`).run(tpl, uid).lastInsertRowid;
  const i2 = db.prepare(`INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
                         VALUES ('2026-05-11', 'breakfast', 'Porridge', ?, ?)`).run(tpl, uid).lastInsertRowid;
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Oats', '100g')`).run(i1);
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Oats', '100g')`).run(i2);

  // Handler scope=series: Titel/Notes ändern, Zutaten komplett ersetzen
  db.prepare(`UPDATE meal_recurrence_templates
              SET meal_type = 'breakfast', title = 'Overnight Oats', notes = 'kalt', recipe_url = NULL, recipe_id = NULL
              WHERE id = ?`).run(tpl);
  db.prepare(`UPDATE meals
              SET meal_type = 'breakfast', title = 'Overnight Oats', notes = 'kalt'
              WHERE recurrence_template_id = ?`).run(tpl);
  db.prepare(`DELETE FROM meal_recurrence_ingredients WHERE template_id = ?`).run(tpl);
  db.prepare(`INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
              VALUES (?, 'Oats', '100g', 'Sonstiges'), (?, 'Milk', '200ml', 'Sonstiges')`).run(tpl, tpl);
  for (const iid of [i1, i2]) {
    db.prepare(`DELETE FROM meal_ingredients WHERE meal_id = ?`).run(iid);
    db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity)
                VALUES (?, 'Oats', '100g'), (?, 'Milk', '200ml')`).run(iid, iid);
  }

  const titles = db.prepare(`SELECT DISTINCT title FROM meals WHERE recurrence_template_id = ?`).all(tpl);
  assert(titles.length === 1 && titles[0].title === 'Overnight Oats', 'alle Instanzen tragen neuen Titel');
  const ingCount = db.prepare(`SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ?`).get(i2).c;
  assert(ingCount === 2, 'Instanz-Zutaten wurden ersetzt (2 Einträge)');
  const tplIng = db.prepare(`SELECT COUNT(*) c FROM meal_recurrence_ingredients WHERE template_id = ?`).get(tpl).c;
  assert(tplIng === 2, 'Template-Zutaten wurden ersetzt (2 Einträge)');
});

test('Serie löschen: Instanzen zuerst entfernen, dann Template (kein SET-NULL-Waisenrest)', () => {
  const tpl = db.prepare(`
    INSERT INTO meal_recurrence_templates
      (start_date, weekday, meal_type, title, created_by)
    VALUES ('2026-06-01', 0, 'lunch', 'Soup', ?)
  `).run(uid).lastInsertRowid;
  db.prepare(`INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
              VALUES (?, 'Broth', '1L', 'Sonstiges')`).run(tpl);
  db.prepare(`INSERT INTO meal_recurrence_exceptions (template_id, date, created_by)
              VALUES (?, '2026-06-08', ?)`).run(tpl, uid);
  const s1 = db.prepare(`INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
                         VALUES ('2026-06-01', 'lunch', 'Soup', ?, ?)`).run(tpl, uid).lastInsertRowid;
  db.prepare(`INSERT INTO meals (date, meal_type, title, recurrence_template_id, created_by)
              VALUES ('2026-06-15', 'lunch', 'Soup', ?, ?)`).run(tpl, uid);
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Broth', '1L')`).run(s1);

  // Handler scope=series: erst Instanzen, dann Template (CASCADE für Template-Zutaten/Ausnahmen)
  db.prepare(`DELETE FROM meals WHERE recurrence_template_id = ?`).run(tpl);
  db.prepare(`DELETE FROM meal_recurrence_templates WHERE id = ?`).run(tpl);

  assert(db.prepare(`SELECT COUNT(*) c FROM meals WHERE recurrence_template_id = ?`).get(tpl).c === 0, 'keine Instanzen mit Template-Bezug');
  assert(db.prepare(`SELECT COUNT(*) c FROM meals WHERE title = 'Soup' AND recurrence_template_id IS NULL`).get().c === 0, 'keine verwaisten Einzel-Mahlzeiten (SET NULL)');
  assert(db.prepare(`SELECT COUNT(*) c FROM meal_recurrence_templates WHERE id = ?`).get(tpl).c === 0, 'Template gelöscht');
  assert(db.prepare(`SELECT COUNT(*) c FROM meal_recurrence_ingredients WHERE template_id = ?`).get(tpl).c === 0, 'Template-Zutaten via CASCADE entfernt');
  assert(db.prepare(`SELECT COUNT(*) c FROM meal_recurrence_exceptions WHERE template_id = ?`).get(tpl).c === 0, 'Ausnahmen via CASCADE entfernt');
});

// --------------------------------------------------------
// Zutaten CRUD
// --------------------------------------------------------
test('Zutat hinzufügen', () => {
  const r = db.prepare(`
    INSERT INTO meal_ingredients (meal_id, name, quantity)
    VALUES (?, 'Hackfleisch', '500g')
  `).run(mealId1);
  ingId1 = r.lastInsertRowid;
  assert(ingId1 > 0);
});

test('Zweite Zutat hinzufügen', () => {
  const r = db.prepare(`
    INSERT INTO meal_ingredients (meal_id, name, quantity)
    VALUES (?, 'Spaghetti', '400g')
  `).run(mealId1);
  ingId2 = r.lastInsertRowid;
  assert(ingId2 > 0);
});

test('Zutaten einer Mahlzeit abrufen', () => {
  const ings = db.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? ORDER BY id ASC
  `).all(mealId1);
  assert(ings.length === 2, `Erwartet 2, erhalten ${ings.length}`);
  assert(ings[0].name === 'Hackfleisch');
  assert(ings[1].name === 'Spaghetti');
});

test('Zutat aktualisieren (Menge ändern)', () => {
  db.prepare(`UPDATE meal_ingredients SET quantity = '600g' WHERE id = ?`).run(ingId1);
  const ing = db.prepare('SELECT quantity FROM meal_ingredients WHERE id = ?').get(ingId1);
  assert(ing.quantity === '600g', 'Menge aktualisiert');
});

test('on_shopping_list-Flag setzen', () => {
  db.prepare(`UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?`).run(ingId1);
  const ing = db.prepare('SELECT on_shopping_list FROM meal_ingredients WHERE id = ?').get(ingId1);
  assert(ing.on_shopping_list === 1, 'Flag gesetzt');
});

test('Nur offene Zutaten haben on_shopping_list = 0', () => {
  const open = db.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0
  `).all(mealId1);
  assert(open.length === 1, `Erwartet 1 offene Zutat, erhalten ${open.length}`);
  assert(open[0].name === 'Spaghetti');
});

test('Zutat löschen', () => {
  db.prepare('DELETE FROM meal_ingredients WHERE id = ?').run(ingId2);
  const remaining = db.prepare('SELECT * FROM meal_ingredients WHERE meal_id = ?').all(mealId1);
  assert(remaining.length === 1, 'Nur noch eine Zutat');
});

// --------------------------------------------------------
// Cascade-Verhalten
// --------------------------------------------------------
test('Mahlzeit löschen entfernt Zutaten (CASCADE)', () => {
  // Neue Mahlzeit mit Zutat
  const m = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-25', 'snack', 'Apfel', ?)
  `).run(uid);
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name) VALUES (?, 'Apfel')`).run(m.lastInsertRowid);

  db.prepare('DELETE FROM meals WHERE id = ?').run(m.lastInsertRowid);
  const ings = db.prepare('SELECT * FROM meal_ingredients WHERE meal_id = ?').all(m.lastInsertRowid);
  assert(ings.length === 0, 'Zutaten nach Mahlzeit-Löschung entfernt');
});

// --------------------------------------------------------
// Einkaufslisten-Integration
// --------------------------------------------------------
test('Offene Zutaten einer Woche abfragen', () => {
  // Mahlzeit für Integration-Test anlegen
  const m = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-24', 'dinner', 'Risotto', ?)
  `).run(uid);
  const mid = m.lastInsertRowid;

  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Reis', '300g')`).run(mid);
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Parmesan', '100g')`).run(mid);

  const open = db.prepare(`
    SELECT mi.* FROM meal_ingredients mi
    JOIN meals mo ON mo.id = mi.meal_id
    WHERE mo.date BETWEEN '2026-03-23' AND '2026-03-29'
      AND mi.on_shopping_list = 0
  `).all();
  // Spaghetti (ingId1 wurde gelöscht), Hackfleisch (on_shopping_list=1 gesetzt), Reis, Parmesan
  assert(open.length >= 2, `Mindestens 2 offene Zutaten, erhalten ${open.length}`);
});

test('Zutaten → Einkaufsliste übertragen (INSERT + Flag setzen)', () => {
  // Frische Mahlzeit mit 2 Zutaten
  const m = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-24', 'lunch', 'Suppe', ?)
  `).run(uid);
  const mid = m.lastInsertRowid;

  const i1 = db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity) VALUES (?, 'Karotten', '3 Stück')`).run(mid).lastInsertRowid;
  const i2 = db.prepare(`INSERT INTO meal_ingredients (meal_id, name) VALUES (?, 'Zwiebeln')`).run(mid).lastInsertRowid;

  // Transfer-Logik aus server/routes/meals.js simulieren
  const ingredients = db.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0
  `).all(mid);

  assert(ingredients.length === 2, `Erwartet 2, erhalten ${ingredients.length}`);

  const insertItem = db.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
    VALUES (?, ?, ?, 'Sonstiges', ?)
  `);
  const markDone = db.prepare(`UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?`);

  for (const ing of ingredients) {
    insertItem.run(listId, ing.name, ing.quantity, mid);
    markDone.run(ing.id);
  }

  // Prüfen: Artikel in Einkaufsliste
  const items = db.prepare(`
    SELECT * FROM shopping_items WHERE added_from_meal = ?
  `).all(mid);
  assert(items.length === 2, `Erwartet 2 Einkaufsartikel, erhalten ${items.length}`);
  assert(items[0].name === 'Karotten', `Erster Artikel: ${items[0].name}`);

  // Prüfen: Flags gesetzt
  const stillOpen = db.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0
  `).all(mid);
  assert(stillOpen.length === 0, 'Alle Zutaten als übertragen markiert');
});

test('Zweiter Transfer überträgt nichts (alle bereits markiert)', () => {
  // Mahlzeit aus vorherigem Test - alle on_shopping_list = 1
  const suppe = db.prepare(`SELECT id FROM meals WHERE title = 'Suppe'`).get();
  const open = db.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0
  `).all(suppe.id);
  assert(open.length === 0, 'Keine offenen Zutaten mehr');
});

test('added_from_meal FK auf meals(id) gesetzt', () => {
  const items = db.prepare(`
    SELECT si.*, m.title AS meal_title
    FROM shopping_items si
    JOIN meals m ON m.id = si.added_from_meal
    WHERE si.added_from_meal IS NOT NULL
    LIMIT 5
  `).all();
  assert(items.length > 0, 'Mindestens ein Artikel mit Mahlzeit-Referenz');
  assert(items[0].meal_title, 'meal_title verknüpft');
});

test('Rezepte speichern passende meal_types für Planer-Features', () => {
  const recipeId = db.prepare(`
    INSERT INTO recipes (title, meal_types, created_by)
    VALUES ('Porridge', 'breakfast,snack', ?)
  `).run(uid).lastInsertRowid;
  const recipe = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(recipeId);
  assert(recipe.meal_types === 'breakfast,snack', `meal_types gespeichert: ${recipe.meal_types}`);
});

test('Randomize-Helfer plant nur kompatible Rezepte in freie Slots', () => {
  const plan = mealsUi.buildRandomMealAssignments({
    weekStart: '2026-03-23',
    visibleMealTypes: ['breakfast', 'dinner'],
    meals: [{ id: 99, date: '2026-03-23', meal_type: 'breakfast', title: 'Bestehend' }],
    recipes: [
      { id: 1, title: 'Porridge', meal_types: ['breakfast'], ingredients: [] },
      { id: 2, title: 'Pasta', meal_types: ['dinner'], ingredients: [] },
    ],
    replaceExisting: false,
    pick: () => 0,
  });

  assert(plan.assignments.every((item) => item.mealType === 'dinner' || item.date !== '2026-03-23'), 'belegte Slots bleiben ohne Replace unberührt');
  assert(plan.assignments.some((item) => item.mealType === 'dinner' && item.recipe.id === 2), 'kompatibles Dinner-Rezept wird zugewiesen');
  assert(plan.deleteMealIds.length === 0, 'ohne Replace werden keine Mahlzeiten gelöscht');
});

test('Randomize-Helfer markiert bestehende Mahlzeiten zum Ersetzen', () => {
  const plan = mealsUi.buildRandomMealAssignments({
    weekStart: '2026-03-23',
    visibleMealTypes: ['breakfast'],
    meals: [{ id: 42, date: '2026-03-23', meal_type: 'breakfast', title: 'Bestehend' }],
    recipes: [{ id: 1, title: 'Porridge', meal_types: ['breakfast'], ingredients: [] }],
    replaceExisting: true,
    pick: () => 0,
  });

  assert(plan.assignments.some((item) => item.date === '2026-03-23' && item.mealType === 'breakfast'), 'belegte Slots werden bei Replace neu geplant');
  assert(plan.deleteMealIds.includes(42), 'bestehende Mahlzeit wird zum Löschen markiert');
});

test('Randomize-Helfer meldet volle Wochen getrennt von Rezeptmangel', () => {
  const plan = mealsUi.buildRandomMealAssignments({
    weekStart: '2026-03-23',
    visibleMealTypes: ['breakfast'],
    meals: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, date: `2026-03-${String(23 + i).padStart(2, '0')}`, meal_type: 'breakfast', title: 'Belegt' })),
    recipes: [{ id: 1, title: 'Porridge', meal_types: ['breakfast'], ingredients: [] }],
    replaceExisting: false,
    pick: () => 0,
  });

  assert(plan.assignments.length === 0, 'bei voller Woche werden keine neuen Mahlzeiten geplant');
  assert(plan.reason === 'week_full', `Erwarteter Grund week_full, erhalten ${plan.reason}`);
});

test('Randomize-Helfer vermeidet gleiche Rezepte in benachbarten Tages-Slots wenn Alternativen existieren', () => {
  const plan = mealsUi.buildRandomMealAssignments({
    weekStart: '2026-03-23',
    visibleMealTypes: ['dinner'],
    meals: [],
    recipes: [
      { id: 1, title: 'Pasta', meal_types: ['dinner'], ingredients: [] },
      { id: 2, title: 'Soup', meal_types: ['dinner'], ingredients: [] },
    ],
    replaceExisting: false,
    pick: () => 0,
  });

  const first = plan.assignments.find((item) => item.date === '2026-03-23' && item.mealType === 'dinner');
  const second = plan.assignments.find((item) => item.date === '2026-03-24' && item.mealType === 'dinner');
  assert(first && second, 'benachbarte Dinner-Slots müssen geplant sein');
  assert(first.recipe.id !== second.recipe.id, 'aufeinanderfolgende Tage sollen unterschiedliche Rezepte nutzen');
});

test('Randomize-Helfer vermeidet gleiche Rezepte in benachbarten Mahlzeiten desselben Tages', () => {
  const plan = mealsUi.buildRandomMealAssignments({
    weekStart: '2026-03-23',
    visibleMealTypes: ['breakfast', 'lunch'],
    meals: [],
    recipes: [
      { id: 1, title: 'Wrap', meal_types: ['breakfast', 'lunch'], ingredients: [] },
      { id: 2, title: 'Salad', meal_types: ['breakfast', 'lunch'], ingredients: [] },
    ],
    replaceExisting: false,
    pick: () => 0,
  });

  const breakfast = plan.assignments.find((item) => item.date === '2026-03-23' && item.mealType === 'breakfast');
  const lunch = plan.assignments.find((item) => item.date === '2026-03-23' && item.mealType === 'lunch');
  assert(breakfast && lunch, 'benachbarte Mahlzeiten desselben Tages müssen geplant sein');
  assert(breakfast.recipe.id !== lunch.recipe.id, 'benachbarte Mahlzeiten desselben Tages sollen unterschiedliche Rezepte nutzen');
});

test('Meals-Route bietet einen atomaren apply-plan Endpunkt für Replace-Flows', () => {
  const source = readFileSync(new URL('../server/routes/meals.js', import.meta.url), 'utf8');
  assert(/router\.post\('\/apply-plan'/.test(source), 'apply-plan Route muss existieren');
  assert(/db\.transaction\(\(\) => \{[\s\S]*replaceExisting/.test(source), 'apply-plan muss als DB-Transaktion laufen');
  assert(/deleteMealOccurrence/.test(source), 'apply-plan soll bestehende Mahlzeiten serverseitig mit Wiederholungs-Semantik ersetzen');
  assert(!/const created = db\.transaction\([\s\S]*\}\)\(\);/.test(source), 'apply-plan darf das Ergebnis des DB-Transaction-Helfers nicht erneut aufrufen');
});

// --------------------------------------------------------
// Mehrere Mahlzeiten pro Slot
// --------------------------------------------------------
test('Mehrere Mahlzeiten pro Slot anlegen (gleiche date + meal_type)', () => {
  const m1 = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-26', 'breakfast', 'Omelette', ?)
  `).run(uid);
  const m2 = db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2026-03-26', 'breakfast', 'French Toast', ?)
  `).run(uid);
  assert(m1.lastInsertRowid > 0, 'Erste Mahlzeit angelegt');
  assert(m2.lastInsertRowid > 0, 'Zweite Mahlzeit angelegt');
  assert(m1.lastInsertRowid !== m2.lastInsertRowid, 'Unterschiedliche IDs');
});

test('Mehrere Mahlzeiten desselben Slots werden gemeinsam abgefragt', () => {
  const meals = db.prepare(`
    SELECT * FROM meals
    WHERE date = '2026-03-26' AND meal_type = 'breakfast'
    ORDER BY id ASC
  `).all();
  assert(meals.length === 2, `Erwartet 2, erhalten ${meals.length}`);
  assert(meals[0].title === 'Omelette');
  assert(meals[1].title === 'French Toast');
});

test('Löschen einer Mahlzeit lässt die andere im Slot bestehen', () => {
  const [first] = db.prepare(`
    SELECT id FROM meals WHERE date = '2026-03-26' AND meal_type = 'breakfast' ORDER BY id ASC
  `).all();
  db.prepare('DELETE FROM meals WHERE id = ?').run(first.id);
  const remaining = db.prepare(`
    SELECT * FROM meals WHERE date = '2026-03-26' AND meal_type = 'breakfast'
  `).all();
  assert(remaining.length === 1, `Erwartet 1 verbleibende Mahlzeit, erhalten ${remaining.length}`);
  assert(remaining[0].title === 'French Toast', 'Richtige Mahlzeit verblieben');
});

// --------------------------------------------------------
// Autocomplete-Simulation
// --------------------------------------------------------
test('Mahlzeit-Autocomplete nach Prefix', () => {
  const results = db.prepare(`
    SELECT DISTINCT title, meal_type FROM meals
    WHERE title LIKE ? COLLATE NOCASE
    ORDER BY title ASC LIMIT 10
  `).all('S%');
  assert(results.length >= 1, `Mindestens 1 Treffer, erhalten ${results.length}`);
  const titles = results.map((r) => r.title);
  assert(titles.some((t) => t.startsWith('S') || t.startsWith('s')), 'Treffer beginnt mit S');
});

test('Autocomplete ohne Treffer gibt leeres Array', () => {
  const results = db.prepare(`
    SELECT DISTINCT title FROM meals WHERE title LIKE ? COLLATE NOCASE
  `).all('XXXXXXXXXXX%');
  assert(results.length === 0, 'Leeres Ergebnis erwartet');
});

// --------------------------------------------------------
// Wochenhelfer-Logik (ohne Server)
// --------------------------------------------------------
test('Wochenberechnung: Montag der aktuellen Woche', () => {
  // 2026-03-24 ist ein Dienstag → Montag ist 2026-03-23
  function getMondayOf(dateStr) {
    const d   = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1 - day);
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  assert(getMondayOf('2026-03-24') === '2026-03-23', 'Montag korrekt berechnet');
  assert(getMondayOf('2026-03-23') === '2026-03-23', 'Montag bleibt Montag');
  assert(getMondayOf('2026-03-29') === '2026-03-23', 'Sonntag → gleicher Montag');
  assert(getMondayOf('2026-03-30') === '2026-03-30', 'Nächster Montag');
});

// PR #1200 Review Runde 3, Nice-to-have 2: keine Suite pinnte fest, dass
// `formatWeekLabel()` den schmalen Wochen-Format-Umschalter ueberhaupt liest -
// ein hartcodiertes `narrow = true`/`false` anstelle des `matchMedia`-Aufrufs
// bliebe unbemerkt gruen. Ein rein TEXTLICHER Vergleich zwischen schmal/breit
// waere hier blind: der Browser-Loader stubbt `formatDate`/`formatDayMonth`
// beide auf `String(d)`, beide Zweige liefern also dieselbe Zeichenkette. Der
// Spy prueft deshalb den echten AUFRUF: `formatWeekLabel()` muss
// `window.matchMedia('(max-width: 639px)')` tatsaechlich befragen - fehlt der
// Aufruf (weil `narrow` fest verdrahtet wurde), faellt das hier durch.
test('formatWeekLabel() befragt tatsaechlich matchMedia fuer den schmalen Umschalter', () => {
  const zuvorWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    matchMedia: (query) => { calls.push(query); return { matches: false }; },
  };
  try {
    mealsUi.formatWeekLabel('2026-09-14');
    assert(calls.includes('(max-width: 639px)'),
      'formatWeekLabel() muss window.matchMedia("(max-width: 639px)") aufrufen - sonst ist der schmale Umschalter fest verdrahtet statt live gelesen');
  } finally {
    globalThis.window = zuvorWindow;
  }
});

// --------------------------------------------------------
// Rezept skalieren: Zutatenmengen (Umschrift nach Region)
// --------------------------------------------------------

/**
 * Fuehrt `fn` unter einer anderen Format-Locale aus. Die Locale ist im Browser
 * eine Haushalts-Einstellung und entscheidet ueber Ziffernsystem, Trenner und
 * Gruppierung; der Browser-Loader dieser Suite liest sie aus
 * `globalThis.__formatLocale` (Standard 'de').
 */
function withFormatLocale(locale, fn) {
  const vorher = globalThis.__formatLocale;
  globalThis.__formatLocale = locale;
  try { fn(); } finally { globalThis.__formatLocale = vorher; }
}

/** Kurzform fuer die Erwartung einer skalierten Menge. */
function scaled(locale, quantity, factor, erwartet) {
  let ist;
  withFormatLocale(locale, () => { ist = mealsUi.scaleQuantityText(quantity, factor); });
  assert(ist === erwartet, `${locale}: "${quantity}" x${factor} -> "${ist}", erwartet "${erwartet}"`);
}

test('Skalieren: die gewoehnlichen Zutatenmengen rechnen wie bisher', () => {
  scaled('de', '250 g', 2, '500 g');
  scaled('de', '1 kg', 2, '2 kg');
  scaled('de', '3 EL', 0.5, '1,5 EL');
  scaled('de', '1 Zwiebel', 3, '3 Zwiebel');
  // Brueche: gemischt und einfach, beide weiter erkannt.
  scaled('de', '1 1/2 Tassen', 2, '3 Tassen');
  scaled('de', '1/2 TL', 3, '1,5 TL');
  // Ohne Zahl gibt es nichts zu rechnen - die Zeile bleibt, wie sie dasteht.
  scaled('de', 'eine Prise', 2, 'eine Prise');
  // Faktor 1 fasst nichts an, auch keine Schreibweise.
  scaled('de', '1.5 kg', 1, '1.5 kg');
});

test('Skalieren: Trenner und Ziffern der Ausgabe folgen der Region, nicht der Eingabe', () => {
  // Vorher schaute sich die Funktion den Trenner aus der Eingabe ab (`useComma`).
  // Eine aus Mealie gespiegelte "1.5" blieb damit in einer deutschen Oberflaeche
  // eine "1.5" - die Anzeige richtete sich nach der Herkunft der Zutat statt nach
  // dem Haushalt, der sie liest.
  scaled('de', '1.5 kg', 3, '4,5 kg');
  scaled('en-US', '1,5 kg', 3, '1,5 kg');   // in en-US ist das Komma kein Trenner
  scaled('en-US', '1.5 kg', 3, '4.5 kg');
  // Und die Eingabe wird in derselben Region gelesen: in de trennt das Komma.
  scaled('de', '1,5 kg', 2, '3 kg');
});

test('Skalieren: eine gruppierte Menge wird abgewiesen, nicht geraten', () => {
  // Der Kern des Fehlers. Unter en-US gruppiert das Komma Tausender: "1,000 g"
  // heisst tausend Gramm. Die alte Fassung las daraus die Basis 1 und
  // multiplizierte die - eine Zutat, die um den Faktor 1000 zu klein im Rezept
  // stand, ohne dass irgendwo etwas erschien.
  //
  // Abgewiesen heisst hier UNVERAENDERT, nicht "1 Stueck" wie im Einkauf: die
  // Menge IST der Text der Zutat, und der Originaltext ist die einzige Antwort,
  // die nichts erfindet.
  scaled('en-US', '1,000 g', 2, '1,000 g');
  scaled('de', '1.000 g', 2, '1.000 g');
  // Auch in oestlichen Ziffern - die Gruppierungspruefung muss sie sehen. Die
  // fuehrende Ziffer ist bewusst nicht die 1, sonst waere der abgeschnittene
  // Anfang vom richtigen Ergebnis nicht zu unterscheiden.
  scaled('ar-EG', '٢٬٠٠٠ g', 2, '٢٬٠٠٠ g');
  // Aber NUR im fuehrenden Token: eine Gruppierung im Rest wird gar nicht
  // gelesen und darf die Zeile nicht ungeskaliert stehen lassen.
  scaled('de', '2 Dosen à 1.000 ml', 2, '4 Dosen à 1.000 ml');
  scaled('en-US', '2 cans à 1,000 ml', 2, '4 cans à 1,000 ml');
  // Gegenprobe zur Regel selbst: in de trennt das Komma, "1,000" IST dort eins.
  scaled('de', '1,000 g', 2, '2 g');
  scaled('en-US', '1.000 g', 2, '2 g');
});

test('Skalieren: oestliche Ziffern kommen ueberhaupt an', () => {
  // `\d` ist in JavaScript ASCII. Unter fa oder ar-EG traf die alte Regex die
  // Ziffern der eigenen Oberflaeche nicht - die Zeile blieb ungeskaliert zwischen
  // skalierten Geschwistern stehen, was ein falsches Rezept ergibt.
  scaled('fa', '۲۵۰ g', 2, '۵۰۰ g');
  scaled('ar-EG', '١٫٥ kg', 2, '٣ kg');
  // Auch ein ANDERES System als das der Region wird gelesen - seit die Umschrift
  // aus utils/digits.js dahintersteht, dieselbe, die der Server benutzt. Vorher
  // blieb so eine Zeile liegen; jetzt wird sie gerechnet und in den Ziffern der
  // eingestellten Region ausgegeben. Das traegt auch den Regionswechsel: eine
  // unter ar-EG gespeicherte Menge bleibt unter fa lesbar.
  scaled('fa', '١٫٥ kg', 2, '۳ kg');
});

test('Skalieren: der Rest der Zeile behaelt seine eigenen Ziffern', () => {
  // Umgeschrieben wird nur, was auch gerechnet wird. Steht hinter der fuehrenden
  // Zahl ein zweiter Zahlenteil, kam er vorher aus der umgeschriebenen Fassung
  // zurueck und verlor dabei seine Ziffern: unter fa wurde „۲ x ۵۰۰ g" zu
  // „۴ x 500 g", also eine Zeile in zwei Schriften.
  // Die geschriebene Zahl steht in den Ziffern der Region, genau wie der Rest -
  // eine Zeile, eine Schrift. Bis v2.65 stand sie in ASCII, weil der Server nichts
  // anderes lesen konnte; seit er dieselbe Umschrift benutzt, ist der Grund weg.
  scaled('fa', '۲ x ۵۰۰ g', 2, '۴ x ۵۰۰ g');
  scaled('fa', '۲ x ۱٫۵ kg', 2, '۴ x ۱٫۵ kg');
  scaled('fa', '۱ ۱/۲ Tassen', 2, '۳ Tassen');
  // Umgekehrt darf der Rest auch nichts DAZUgewinnen: die ASCII-Zeile bleibt ASCII.
  scaled('de', '2 x 500 g', 2, '4 x 500 g');
  // Der realistischste Fall, und er braucht keine fremde Region: in de ist das
  // Komma der Dezimaltrenner, die Umschrift ersetzt es also im GANZEN Text. Kam
  // der Rest von dort, wurde aus einer Gebindegroesse „0,5 l" ein „0.5 l" - und
  // dieser Text wird in der Zutatenzeile gespeichert.
  scaled('de', '2 Dosen à 0,5 l', 2, '4 Dosen à 0,5 l');
  scaled('de', '3 Glaeser à 250 ml', 2, '6 Glaeser à 250 ml');
  // Umschliessender Leerraum faellt weg, statt die Zahl zu verschieben.
  scaled('de', '  250 g  ', 2, '500 g');
  // Astrale Ziffern (40 der 77 Systeme): sie belegen zwei UTF-16-Einheiten, ihr
  // ASCII-Ergebnis eine. Mit einem `.length`-Offset schnitt `restOf` mitten in
  // ein Zeichen - gemessen kam „4\uDD52 x 500 g" heraus, eine halbe
  // Ersatzzeichen-Paarung, und dieser kaputte Text ging in die Zutatenzeile.
  scaled('de', '𞥒 x 500 g', 2, '4 x 500 g');
  scaled('de', '𞥒 kg', 2, '4 kg');
  scaled('de', '𑜲𑜵𑜰 g', 2, '500 g');
  // Kein halbes Ersatzzeichen im Ergebnis - die Zeile wird gespeichert.
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const probe of ['𞥒 x 500 g', '𞥒 kg', '𑜲𑜵𑜰 g', '۲ x ۵۰۰ g']) {
    withFormatLocale('de', () => {
      const ergebnis = mealsUi.scaleQuantityText(probe, 2);
      assert(!unpaired.test(ergebnis), `"${probe}" ergab kaputtes "${ergebnis}"`);
    });
  }
});

test('Skalieren: die Umschrift ist positionstreu - darauf baut der Rest der Zeile', () => {
  // scaleQuantityText schneidet den Rest per Offset aus dem ORIGINAL. Das geht
  // nur, solange toDecimalString ein Zeichen gegen genau ein Zeichen tauscht.
  // Faellt die Zusicherung, verrutscht hier still der Schnitt - deshalb steht sie
  // als eigener Test da und nicht nur als Kommentar in money.js.
  const proben = ['۲ x ۵۰۰ g', '٢٬٠٠٠ g', '1,5 kg', 'eine Prise', '🍎 2 kg', '1.000', '1 1/2 Tassen'];
  for (const locale of ['de', 'en-US', 'fa', 'ar-EG']) {
    withFormatLocale(locale, () => {
      for (const probe of proben) {
        const um = toDecimalString(probe);
        // Leer heisst abgewiesen (gruppiert) - dann gibt es keinen Offset zu halten.
        assert(um === '' || um.length === probe.trim().length,
          `${locale}: "${probe}" (${probe.trim().length}) -> "${um}" (${um.length})`);
      }
    });
  }
});

test('Skalieren: die geschriebene Zahl bleibt serverlesbar', () => {
  // `parseQuantity` in server/services/shopping-import.js liest die gespeicherte
  // Zutatenmenge beim Uebertrag in die Einkaufsliste. Kommt sie dort nicht an,
  // faellt die Zutat aus der Summierung - aus einer Anzeigefrage wuerde ein
  // Funktionsverlust.
  // Gegen den ECHTEN parseQuantity, nicht gegen einen Nachbau seiner Regex: der
  // Nachbau, der hier stand, haette die Umstellung auf regionseigene Ziffern fuer
  // unlesbar erklaert, obwohl der Server sie laengst liest. Ein Test, der eine
  // fremde Regel KOPIERT, misst die Kopie.
  for (const locale of ['de', 'en-US', 'fa', 'ar-EG', 'fr']) {
    let ergebnis;
    withFormatLocale(locale, () => { ergebnis = mealsUi.scaleQuantityText('1000 g', 2); });
    assert(parseQuantity(ergebnis)?.amount === 2000,
      `${locale}: "${ergebnis}" ist fuer den Server unlesbar`);
  }
  // Der TRENNER folgt trotzdem der Region - nur die Ziffern sind Datenformat.
  scaled('de', '1,5 kg', 3, '4,5 kg');
  scaled('fr', '1,5 kg', 3, '4,5 kg');
  scaled('en-US', '1.5 kg', 3, '4.5 kg');
});

test('Skalieren: die Multiplikator-Schreibweise bleibt lesbar', () => {
  // Die Abschneide-Pruefung war erst „irgendein Zeichen zwischen zwei Ziffern".
  // Das traf auch „2x500 g" - ein `x` ist aber kein Trenner, nach ihm ist die 2
  // vollstaendig gelesen. Die Zeile blieb dadurch ungeskaliert stehen, also genau
  // der Fehler, gegen den diese Funktion angetreten ist.
  scaled('de', '2x500 g', 2, '4x500 g');
  scaled('de', '3x Dose', 2, '6x Dose');
  scaled('de', '2 x 500 g', 2, '4 x 500 g');
  // Auch das typografische Kreuz und der Stern - keins davon trennt eine Zahl.
  scaled('de', '2×500 ml', 2, '4×500 ml');
  scaled('de', '2 × 500 ml', 2, '4 × 500 ml');
});

test('Skalieren: eine mitten im Trenner abgeschnittene Zahl bleibt stehen', () => {
  // Unter fa ist das ASCII-Komma weder Dezimal- noch Gruppierungszeichen. Ohne
  // diese Pruefung laese die Regex nur die "1" und schriebe "۲,5 kg" - eine
  // halbierte Zutat in einer Schreibweise, die es in keiner Region gibt.
  scaled('fa', '1,5 kg', 2, '1,5 kg');
  scaled('ar-EG', '1,5 kg', 2, '1,5 kg');
  // Auch der Schweizer Gruppierungsapostroph, den keine der beiden Regionen kennt.
  scaled('de', "1'000 g", 2, "1'000 g");
  // Und in den BRUCH-Zweigen, nicht nur bei der Dezimalzahl: bricht ein Nenner im
  // Trenner ab, wurde aus „1/2,5 cup" die Rechnung 1/2 mal Faktor plus dem Rest
  // „,5 cup" - also „1,5 cup", eine plausible und falsche Menge. Der Fehler traf
  // JEDE Region, nicht nur die mit eigenen Ziffern.
  scaled('de', '1/2,5 cup', 2, '1/2,5 cup');
  scaled('de', '1 1/2,5 Tassen', 2, '1 1/2,5 Tassen');
  scaled('en-US', '1/2.5 cup', 2, '1/2.5 cup');
  scaled('ar-EG', '١/٢٫٥ cup', 2, '١/٢٫٥ cup');
  scaled('ar-EG', '١ ١/٢٫٥ cup', 2, '١ ١/٢٫٥ cup');
  // Gegenprobe: der gewoehnliche Bruch rechnet unveraendert weiter.
  scaled('de', '1/2 cup', 2, '1 cup');
  scaled('ar-EG', '١ ١/٢ cup', 2, '٣ cup');
  // Ein Leerzeichen trennt dagegen zwei Angaben und schneidet nichts ab.
  scaled('de', '2 x 500 g', 2, '4 x 500 g');
});

// --------------------------------------------------------
// Zeitraum-Kopf (#1164)
// --------------------------------------------------------

// Fake-Knopf mit einer echten (Set-gestuetzten) classList und einem
// `inert`-Feld - genug DOM-Oberflaeche, um `.is-current` und `inert` wie im
// echten Browser zu pruefen, ohne eine ganze DOM-Bibliothek zu laden.
function fakeResetButton() {
  const classes = new Set();
  const attrs = {};
  return {
    inert: false,
    innerHTML: '',
    textContent: '',
    title: '',
    dataset: {},
    // PR #1200 Review Runde 6, Blocking 1: bis dahin wurde das eingefuegte
    // Markup nirgends gehalten, nur dass ueberhaupt eingefuegt wird - der
    // schmale Icon-Zweig in syncTodayButton() haette also genauso gut gar
    // nichts einfuegen koennen, ohne dass ein Test das gesehen haette. Jetzt
    // haelt insertedHTML das kumulierte Markup fest, damit ein Test unten
    // wirklich pruefen kann, DASS ein `data-lucide="calendar-check"`-Icon
    // eingefuegt wurde, statt nur zu vertrauen, dass es passiert.
    insertedHTML: '',
    classList: {
      toggle(cls, force) { if (force) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    insertAdjacentHTML(position, html) { this.insertedHTML += html; },
    // PR #1200 Review Runde 5, Nice-to-have 1: ein echtes `focus()`, das
    // `globalThis.document.activeElement` tatsaechlich umschreibt - vorher
    // war `document` ein nacktes Objekt ohne irgendeinen Weg, `activeElement`
    // zu veraendern, also blieb ein Test, der auf einen UNVERAENDERTEN Fokus
    // pruefte, auch dann gruen, wenn der geprüfte Handler selbst einen Knopf
    // fokussierte (die Pruefung konnte den Unterschied gar nicht sehen).
    focus() { if (globalThis.document) globalThis.document.activeElement = this; },
  };
}

// #1164: EIN Positions- und EINE Sichtbarkeitsregel fuer den Zeitraum-Reset.
// Verhaltensgetrieben: geprueft werden der GERENDERTE Kopf und die echte
// Sync-Funktion, nicht der Quelltext.
//
// PR #1200 Review, Blocking 1: `hidden` loeste in `display: none` auf und nahm
// die Box aus dem Fluss - `.week-nav__label` (`flex: 1`) wuchs dann in den
// frei gewordenen Platz und "›" ruckte um die Knopfbreite, sobald der Reset
// erschien/verschwand (gemessen 5/11 ueber 33 Layouts). Ersetzt durch
// `.is-current` (visibility, Box bleibt im Fluss) + `inert`
// (Zeiger/Fokus/A11y-Baum). Dieser Test pinnt jetzt GENAU DIESEN Mechanismus
// fest: eine Rueckkehr zu `hidden` faellt hier durch.
test('Zeitraum-Kopf: zurueck, Wert, vor - dahinter „Heute", per .is-current+inert verborgen in der aktuellen Woche (#1164, #1200)', () => {
  // (a) Reihenfolge im gerenderten Markup: der Reset steht HINTER dem Stepper,
  // im week-nav-Slot - nicht mehr bei den Inhalts-Aktionen.
  const ids = [...mealsUi.weekNavHtml().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert(JSON.stringify(ids) === JSON.stringify(['week-prev', 'week-label', 'week-next', 'week-today']),
    `erwartet zurueck, Wert, vor, Reset - gerendert: ${ids.join(', ')}`);

  // (b) Sichtbarkeit: in der aktuellen Woche traegt der Reset `.is-current`
  // und `inert`, behaelt aber sein Element (der Slot bleibt reserviert).
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = {
    querySelector: (sel) => (sel === '#week-today' ? btn : sel === '#week-prev' ? prevBtn : null),
  };
  const zuvor = mealsUi.state.currentWeek;
  try {
    mealsUi.state.currentWeek = mealsUi.getMondayOf(todayKey());
    mealsUi.syncTodayButton(root);
    assert(btn.classList.contains('is-current') === true, 'in der aktuellen Woche muss der Reset .is-current tragen');
    assert(btn.inert === true, 'in der aktuellen Woche muss der Reset inert sein');
    mealsUi.state.currentWeek = '2000-01-03';
    mealsUi.syncTodayButton(root);
    assert(btn.classList.contains('is-current') === false, 'in einer anderen Woche darf der Reset nicht .is-current sein');
    assert(btn.inert === false, 'in einer anderen Woche darf der Reset nicht inert sein');
  } finally {
    mealsUi.state.currentWeek = zuvor;
  }
});

// PR #1200 Review, Should-fix 3: Enter auf „Heute" laedt die aktuelle Woche
// und macht den (fokussierten) Knopf damit selbst inert - ohne Gegenmassnahme
// faellt der Fokus auf `<body>`.
test('syncTodayButton() rettet den Fokus vor dem eigenen inert-Werden', () => {
  const btn = fakeResetButton();
  const prevBtn = fakeResetButton();
  const root = { querySelector: (sel) => (sel === '#week-today' ? btn : sel === '#week-prev' ? prevBtn : null) };
  const zuvor = mealsUi.state.currentWeek;
  const zuvorDocument = globalThis.document;
  try {
    globalThis.document = { activeElement: btn };
    mealsUi.state.currentWeek = '2000-01-03'; // erst NICHT aktuell
    mealsUi.syncTodayButton(root);
    assert(btn.inert === false);

    let fokussiert = false;
    prevBtn.focus = () => { fokussiert = true; globalThis.document.activeElement = prevBtn; };
    mealsUi.state.currentWeek = mealsUi.getMondayOf(todayKey()); // jetzt wird der fokussierte Knopf aktuell
    mealsUi.syncTodayButton(root);
    assert(fokussiert === true, 'der Fokus muss vor dem inert-Werden auf den Zurueck-Pfeil wandern');
    assert(btn.inert === true);
  } finally {
    mealsUi.state.currentWeek = zuvor;
    globalThis.document = zuvorDocument;
  }
});

// PR #1200 Review Runde 6, Blocking 1: keine Suite betrat je den schmalen
// Zweig von syncTodayButton() - jeder `matchMedia`-Stub in dieser Datei lieferte
// unbedingt `{ matches: false }` (u. a. `fakeResetButton()`s eigene
// `insertAdjacentHTML()`, die bislang gar nichts festhielt). Der Reviewer hat
// gegengeprueft: `public/pages/meals.js:337-353` - die `aria-label`/`title`-
// Zuweisung, das Icon-Einfuegen UND die Text-Wiederherstellung - vollstaendig
// geloescht, und `test:meals`, `test:frontend-audit` sowie
// `test:mobile-scroll-layout` blieben ALLE bei exit 0 stehen. CONTRIBUTING.md:
// "Ein Guard, der nie rot gesehen wurde, ist kein Beweis." Dieser Test treibt
// die ECHTE `syncTodayButton()` gegen einen `matchMedia`-Stub, der fuer
// `NARROW_WEEK_LABEL_QUERY` tatsaechlich `{ matches: true }` liefert, und
// prueft BEIDE Richtungen: schmal -> kein sichtbarer Text, ein
// `data-lucide="calendar-check"`-Icon, das uebersetzte Wort auf
// `aria-label`/`title`; zurueck ueber die Schwelle -> der sichtbare Text kommt
// zurueck.
test('syncTodayButton() schaltet unter 640px wirklich auf ein textloses Icon um und zurueck (PR #1200 Review Runde 6, Blocking 1)', () => {
  const btn = fakeResetButton();
  const root = { querySelector: (sel) => (sel === '#week-today' ? btn : null) };
  const zuvorWeek = mealsUi.state.currentWeek;
  const zuvorWindow = globalThis.window;
  try {
    // Eine Woche, die garantiert nicht die aktuelle ist - der Fokus-Rettungs-
    // Zweig (siehe Test oben) ist hier nicht der Gegenstand der Pruefung.
    mealsUi.state.currentWeek = '2000-01-03';
    const label = t('meals.today');

    // (a) schmal: matchMedia liefert fuer NARROW_WEEK_LABEL_QUERY matches:true.
    globalThis.window = { lucide: undefined, matchMedia: () => ({ matches: true }) };
    mealsUi.syncTodayButton(root);
    assert(btn.textContent === '',
      `unter 640px darf der Reset keinen sichtbaren Text tragen - textContent ist stattdessen "${btn.textContent}"`);
    assert(btn.insertedHTML.includes('data-lucide="calendar-check"'),
      `unter 640px muss der Reset ein data-lucide="calendar-check"-Icon einfuegen - eingefuegtes Markup: "${btn.insertedHTML}"`);
    assert(btn.getAttribute('aria-label') === label,
      `aria-label muss das uebersetzte Wort tragen, obwohl der sichtbare Text zum Icon wird - erhalten "${btn.getAttribute('aria-label')}"`);
    assert(btn.title === label,
      `title muss ebenfalls das uebersetzte Wort tragen - erhalten "${btn.title}"`);
    assert(btn.dataset.iconOnly === 'true',
      'dataset.iconOnly muss auf "true" stehen, sobald der Icon-Zweig genommen wurde');

    // (b) zurueck ueber die Schwelle: matchMedia liefert wieder matches:false -
    // der sichtbare Text muss zurueckkommen, nicht nur aria-label/title.
    globalThis.window = { lucide: undefined, matchMedia: () => ({ matches: false }) };
    mealsUi.syncTodayButton(root);
    assert(btn.textContent === label,
      `ab 640px muss der sichtbare Text wieder das uebersetzte Wort sein - stattdessen "${btn.textContent}"`);
    assert(btn.dataset.iconOnly === 'false',
      'dataset.iconOnly muss auf "false" zurueckfallen, sobald der Text-Zweig wieder genommen wird');
  } finally {
    mealsUi.state.currentWeek = zuvorWeek;
    globalThis.window = zuvorWindow;
  }
});

// Minimales Fake-DOM-Element: genug Oberflaeche fuer `mountEmptyState()`
// (utils/empty-state.js) - `createElement`/`createTextNode`, `className`,
// `setAttribute`, `appendChild`/`append`, `classList`, `replaceChildren`,
// `removeAttribute`. Kein echtes DOM, keine jsdom-Abhaengigkeit - dieselbe
// Idee wie `fakeResetButton()` oben, nur fuer den Leerzustands-Zweig.
function fakeDomElement(tag) {
  const classes = new Set();
  return {
    tagName: tag,
    className: '',
    attributes: {},
    style: {},
    dataset: {},
    children: [],
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, force) { if (force) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { this.children.push(...items); },
    insertAdjacentHTML() { /* Markup wird nicht geprueft - nur, dass gebaut wird */ },
    replaceChildren(...items) { this.children = items; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function withMinimalDom(fn) {
  const zuvorDocument = globalThis.document;
  const zuvorWindow = globalThis.window;
  globalThis.document = {
    createElement: (tag) => fakeDomElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
  globalThis.window = { lucide: undefined, matchMedia: () => ({ matches: false }) };
  try { return fn(); }
  finally {
    globalThis.document = zuvorDocument;
    globalThis.window = zuvorWindow;
  }
}

// PR #1200 Review Runde 3, Nice-to-have 1: der bisherige Test las
// `renderWeekGrid()` als QUELLTEXT (Regex auf den Funktionskoerper) - ein
// auskommentiertes `// syncTodayButton();` im echten Render-Pfad blieb gruen,
// solange der String noch irgendwo im Funktionskoerper stand (PR #1200
// Review Runde 3, Nice-to-have 1). Dieser Test laesst den ECHTEN Render-Pfad
// laufen: `renderWeekGridForTest()` setzt den Modul-internen Container auf
// einen Test-Container und ruft `renderWeekGrid()` unveraendert auf; geprueft
// wird das SICHTBARE ERGEBNIS am echten `#week-today`-Knoten, nicht der
// Quelltext.
test('renderWeekGrid() verdrahtet syncTodayButton() wirklich in den Render-Pfad', () => {
  withMinimalDom(() => {
    const grid = fakeDomElement('div');
    const label = fakeDomElement('span');
    const todayBtn = fakeResetButton();
    const prevBtn = fakeResetButton();
    const testContainer = {
      querySelector(sel) {
        if (sel === '#week-grid') return grid;
        if (sel === '#week-label') return label;
        if (sel === '#week-today') return todayBtn;
        if (sel === '#week-prev') return prevBtn;
        return null;
      },
    };
    const zuvorWeek = mealsUi.state.currentWeek;
    const zuvorMeals = mealsUi.state.meals;
    const zuvorError = mealsUi.state.loadError;
    try {
      // Aktuelle Woche + leerer Plan: `renderWeekGrid()` haengt am
      // Leerzustand-Zweig auf, NACHDEM es `syncTodayButton()` aufgerufen hat -
      // der guenstigste echte Durchlauf, der die Verdrahtung noch beobachtet.
      mealsUi.state.currentWeek = mealsUi.getMondayOf(todayKey());
      mealsUi.state.meals = [];
      mealsUi.state.loadError = null;
      mealsUi.renderWeekGridForTest(testContainer);
      assert(todayBtn.classList.contains('is-current') === true,
        'renderWeekGrid() muss syncTodayButton() wirklich aufrufen - „Heute" traegt in der aktuellen Woche sonst kein .is-current');
    } finally {
      mealsUi.state.currentWeek = zuvorWeek;
      mealsUi.state.meals = zuvorMeals;
      mealsUi.state.loadError = zuvorError;
    }
  });
});

// PR #1200 Review Runde 3, Nice-to-have 4: `formatWeekLabel()` las
// `matchMedia` bisher nur beim Rendern - ein Fenster, das ueber die
// 640px-Schwelle gezogen wird, behielt bis zum naechsten Wochenwechsel das
// alte Format. `onNarrowWeekLabelQueryChange()` ist der Change-Handler einer
// gehaltenen `MediaQueryList` (Modul-Top-Level, siehe meals.js); dieser Test
// ruft ihn direkt auf und prueft, dass er tatsaechlich neu zeichnet -
// erkennbar am selben sichtbaren Ergebnis wie beim Verdrahtungstest oben
// (`syncTodayButton()` laeuft innerhalb von `renderWeekGrid()` erneut).
test('onNarrowWeekLabelQueryChange() zeichnet die Wochen-Navigation neu, wenn der Container noch sichtbar ist', () => {
  withMinimalDom(() => {
    const grid = fakeDomElement('div');
    const label = fakeDomElement('span');
    const todayBtn = fakeResetButton();
    todayBtn.classList.toggle('is-current', false); // Startzustand: absichtlich falsch
    const prevBtn = fakeResetButton();
    const testContainer = {
      isConnected: true,
      querySelector(sel) {
        if (sel === '#week-grid') return grid;
        if (sel === '#week-label') return label;
        if (sel === '#week-today') return todayBtn;
        if (sel === '#week-prev') return prevBtn;
        return null;
      },
    };
    const zuvorWeek = mealsUi.state.currentWeek;
    const zuvorMeals = mealsUi.state.meals;
    const zuvorError = mealsUi.state.loadError;
    try {
      mealsUi.state.currentWeek = mealsUi.getMondayOf(todayKey());
      mealsUi.state.meals = [];
      mealsUi.state.loadError = null;
      mealsUi.renderWeekGridForTest(testContainer); // Container einmal "montieren"
      todayBtn.classList.toggle('is-current', false); // und wieder falsch machen

      mealsUi.onNarrowWeekLabelQueryChange();
      assert(todayBtn.classList.contains('is-current') === true,
        'onNarrowWeekLabelQueryChange() muss bei sichtbarem Container neu zeichnen (renderWeekGrid()/syncTodayButton())');

      // Nicht mehr sichtbar (Navigation weg von /meals): kein Zeichnen ins Leere.
      testContainer.isConnected = false;
      todayBtn.classList.toggle('is-current', false);
      mealsUi.onNarrowWeekLabelQueryChange();
      assert(todayBtn.classList.contains('is-current') === false,
        'onNarrowWeekLabelQueryChange() darf nach dem Verlassen der Seite (isConnected=false) nicht mehr zeichnen');
    } finally {
      mealsUi.state.currentWeek = zuvorWeek;
      mealsUi.state.meals = zuvorMeals;
      mealsUi.state.loadError = zuvorError;
    }
  });
});

// PR #1200 Review, Befund 5: weekNavHtml() rendert den Reset ohne
// .is-current/inert, und ohne diese Gegenmassnahme blitzt er bei jedem
// frischen Laden von /meals sichtbar auf, bevor renderWeekGrid() ihn nach dem
// ersten Laden wieder korrekt einstellt.
test('render() synchronisiert „Heute" VOR dem ersten Laden, gegen das Aufblitzen (Befund 5)', () => {
  const renderStart = mealsSource.indexOf('export async function render(container, { user }) {');
  const loadIdx = mealsSource.indexOf('await Promise.all([loadWeek(monday)');
  assert(renderStart > -1 && loadIdx > -1, 'render()/Promise.all-Aufruf nicht gefunden');
  const syncIdx = mealsSource.indexOf('syncTodayButton();', renderStart);
  assert(syncIdx > -1 && syncIdx < loadIdx,
    'syncTodayButton() muss zwischen dem Beginn von render() und dem ersten Laden aufgerufen werden');
});

// PR #1200 Review, Befund 8: dieser Test berechnete sein Soll bisher mit
// demselben getMondayOf(todayKey()) wie die Seite selbst - eine Regression in
// der Zonenumrechnung waere hier unsichtbar geblieben, weil beide Seiten
// denselben (moeglicherweise kaputten) Weg gegangen waeren. Eine explizit
// gesetzte Haushaltszone, die von der Prozesszone des Testlaeufers abweicht,
// und ein UNABHAENGIG (rohes Intl.DateTimeFormat statt todayKey()) berechnetes
// Soll zwingen die Umrechnung wirklich auf den Pruefstand - dasselbe Muster
// wie test-calendar-timezone-window.js (dort per `process.env.TZ`, hier per
// der Haushaltszonen-API, die die Seite selbst befragt).
test('„Heute" im Essensplan folgt der HAUSHALTSZONE, nicht der Prozesszone des Testlaeufers (Befund 8)', () => {
  const zuvorWeek = mealsUi.state.currentWeek;
  const RealDate = globalThis.Date;
  try {
    setDisplayTimeZone('America/Los_Angeles');

    // Ein per `new Date()` gelesenes „jetzt" faellt nur dann auf, wenn Prozess-
    // und Haushaltszone tatsaechlich verschiedene WOCHEN sehen - ein kaputtes
    // `zonedFields()` (das die Haushaltszone ignoriert und auf die Prozesszone
    // zurückfaellt) waere sonst UNSICHTBAR geblieben. Ein fest eingefrorener
    // Zeitpunkt nahe der UTC-Mitternacht an einem Montag erzwingt das
    // unabhaengig davon, wann die Suite laeuft: 02:30 UTC am Montag ist in Los
    // Angeles (UTC-8 im Januar) noch Sonntag 18:30 der VORWOCHE.
    const fixed = new RealDate('2026-01-12T02:30:00Z');
    class FixedDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed.getTime(); }
    }
    globalThis.Date = FixedDate;

    const erwarteterHeuteKey = '2026-01-11'; // LA-Kalendertag (Sonntag) bei 2026-01-12T02:30Z
    const prozessHeuteKey = '2026-01-12'; // UTC-Kalendertag (Montag) desselben Zeitpunkts
    const erwarteterMontag = mealsUi.getMondayOf(erwarteterHeuteKey);
    const prozessMontag = mealsUi.getMondayOf(prozessHeuteKey);
    assert(erwarteterMontag !== prozessMontag,
      'Testaufbau fehlerhaft: LA- und Prozesstag muessen fuer diese Pruefung verschiedene Wochen ergeben');

    // PR #1200 Review Runde 3, Nice-to-have 3: nicht `todayKey()` isoliert
    // aufrufen, sondern durch die ECHTE Sync-Funktion beobachten - ein
    // Rueckfall von `todayKey()` auf ein naives `new Date().toISOString()`
    // (Prozesszone statt Haushaltszone) faellt nur auf, wenn das RESULTAT von
    // `syncTodayButton()` am DOM-Knoten geprueft wird, nicht der Rueckgabewert
    // von `todayKey()` selbst.
    const btnLaWoche = fakeResetButton();
    const rootLaWoche = { querySelector: (sel) => (sel === '#week-today' ? btnLaWoche : null) };
    mealsUi.state.currentWeek = erwarteterMontag; // die tatsaechlich laufende (LA-)Woche
    mealsUi.syncTodayButton(rootLaWoche);
    assert(btnLaWoche.classList.contains('is-current') === true,
      `syncTodayButton() muss die LA-Woche (${erwarteterMontag}) als aktuell erkennen - stattdessen .is-current=${btnLaWoche.classList.contains('is-current')}. ` +
      'Ein auf die Prozesszone zurueckgefallenes todayKey() saehe hier die falsche Woche.');

    const btnProzessWoche = fakeResetButton();
    const rootProzessWoche = { querySelector: (sel) => (sel === '#week-today' ? btnProzessWoche : null) };
    mealsUi.state.currentWeek = prozessMontag; // die UTC-Prozesswoche - in LA nicht die aktuelle
    mealsUi.syncTodayButton(rootProzessWoche);
    assert(btnProzessWoche.classList.contains('is-current') === false,
      `syncTodayButton() darf die Prozesszonen-Woche (${prozessMontag}) NICHT als aktuell erkennen - stattdessen .is-current=${btnProzessWoche.classList.contains('is-current')}. ` +
      'Ein auf die Prozesszone zurueckgefallenes todayKey() saehe genau diese Woche faelschlich als aktuell an.');
  } finally {
    globalThis.Date = RealDate;
    mealsUi.state.currentWeek = zuvorWeek;
    setDisplayTimeZone(null);
    _resetDisplayTimeZoneCache();
  }
});

// PR #1200 Review Runde 4, Should-fix 2: `onNarrowWeekLabelQueryChange()` rief
// bisher `renderWeekGrid()` auf - eine Bildschirmdrehung ueber die 640px-
// Schwelle riss damit das GANZE Wochengitter neu auf (jede Karte, den
// Stagger, den Scroll zur heutigen Spalte), obwohl nur das Label ein anderes
// Format braucht. Stand der Fokus auf einer Mahlzeit-Karte, fiel er dabei auf
// `<body>` - main haelt ihn auf der Karte. Dieser Test pinnt beide Haelften
// des Fixes fest: der Handler darf das Grid nicht anfassen (Spione auf den
// Methoden, die ein echter renderWeekGrid()-Durchlauf nachweislich benutzt -
// siehe Testaufbau oben), und ein zuvor gesetzter Fokus muss unveraendert
// bleiben.
test('onNarrowWeekLabelQueryChange() aktualisiert nur Label und Reset, nicht das Wochengitter (Runde 4, Should-fix 2)', () => {
  withMinimalDom(() => {
    const grid = fakeDomElement('div');
    let gridTouched = false;
    const zuvorRemoveAttribute = grid.removeAttribute.bind(grid);
    grid.removeAttribute = (name) => { gridTouched = true; zuvorRemoveAttribute(name); };
    grid.setAttribute = (name, value) => { gridTouched = true; grid.attributes[name] = value; };
    const zuvorReplaceChildren = grid.replaceChildren.bind(grid);
    grid.replaceChildren = (...items) => { gridTouched = true; zuvorReplaceChildren(...items); };

    const label = fakeDomElement('span');
    const todayBtn = fakeResetButton();
    const prevBtn = fakeResetButton();
    const strayCard = fakeResetButton(); // Stellvertreter fuer eine fokussierte Mahlzeit-Karte
    const testContainer = {
      isConnected: true,
      querySelector(sel) {
        if (sel === '#week-grid') return grid;
        if (sel === '#week-label') return label;
        if (sel === '#week-today') return todayBtn;
        if (sel === '#week-prev') return prevBtn;
        return null;
      },
    };
    const zuvorWeek = mealsUi.state.currentWeek;
    const zuvorMeals = mealsUi.state.meals;
    const zuvorError = mealsUi.state.loadError;
    const zuvorDocument = globalThis.document;
    try {
      mealsUi.state.currentWeek = mealsUi.getMondayOf(todayKey());
      mealsUi.state.meals = [];
      mealsUi.state.loadError = null;

      // Testaufbau-Beweis: ein ECHTER renderWeekGrid()-Durchlauf beruehrt das
      // Grid nachweislich (Leerzustand-Zweig ruft grid.removeAttribute auf) -
      // ohne diesen Beweis waere ein "gridTouched bleibt false" unten wertlos.
      mealsUi.renderWeekGridForTest(testContainer);
      assert(gridTouched === true,
        'Testaufbau fehlerhaft: ein echter renderWeekGrid()-Durchlauf muss das Grid beruehren, sonst beweist der Test unten nichts');

      gridTouched = false;
      globalThis.document = { activeElement: strayCard };
      mealsUi.onNarrowWeekLabelQueryChange();

      assert(gridTouched === false,
        'onNarrowWeekLabelQueryChange() darf das Wochengitter NICHT anfassen - das rebuildet Karten, Stagger und Scroll unnoetig (Runde 4, Should-fix 2)');
      assert(globalThis.document.activeElement === strayCard,
        'onNarrowWeekLabelQueryChange() darf den Fokus nicht verschieben - ein Grid-Rebuild waere genau der Weg, ueber den main den Fokus verliert');
      assert(todayBtn.classList.contains('is-current') === true,
        'onNarrowWeekLabelQueryChange() muss trotzdem syncTodayButton() ausfuehren - nur das Grid bleibt unberuehrt, nicht Label/Reset');
    } finally {
      mealsUi.state.currentWeek = zuvorWeek;
      mealsUi.state.meals = zuvorMeals;
      mealsUi.state.loadError = zuvorError;
      globalThis.document = zuvorDocument;
    }
  });
});

// PR #1200 Review Runde 4, Nice-to-have 3b: der bestehende Test oben ruft
// `onNarrowWeekLabelQueryChange()` direkt auf - das prueft, dass der Handler
// TUT, was er soll, aber nicht, dass er ueberhaupt an ein echtes
// `matchMedia(...)`-Change-Ereignis gebunden ist. Ein geloeschtes
// `addEventListener('change', ...)` in meals.js liesse `test:meals` komplett
// gruen, weil kein Test je einen echten Aufruf des Verdrahtungs-Einzeilers
// beobachtet. Dieser Test importiert das Modul FRISCH (Cache-Buster in der
// Spezifizierer-Query, dasselbe Muster wie test-nav-badges.js/
// test-overlay-history.js) gegen ein `window.matchMedia`, dessen
// `addEventListener` selbst ein Spion ist - nur ein echter Modul-Top-Level-
// Aufruf von `addEventListener('change', ...)` erzeugt hier einen Treffer.
const _narrowWeekLabelListenerCalls = await (async () => {
  const calls = [];
  const zuvorWindow = globalThis.window;
  globalThis.window = {
    matchMedia: (query) => ({
      matches: false,
      addEventListener(type, handler) { calls.push({ query, type, handler }); },
    }),
  };
  try {
    await import(`../public/pages/meals.js?narrow-week-label-listener-probe=${process.pid}-${Date.now()}`);
  } finally {
    globalThis.window = zuvorWindow;
  }
  return calls;
})();

test('meals.js registriert onNarrowWeekLabelQueryChange() wirklich per matchMedia(...).addEventListener() (Runde 4, Nice-to-have 3b)', () => {
  assert(_narrowWeekLabelListenerCalls.length === 1,
    `erwartet genau eine addEventListener()-Registrierung beim Modul-Import, erhalten: ${_narrowWeekLabelListenerCalls.length}. ` +
    'Eine geloeschte addEventListener-Zeile in meals.js waere hier 0, nicht 1.');
  const [call] = _narrowWeekLabelListenerCalls;
  assert(call.query === '(max-width: 639px)',
    `erwartet die Anmeldung auf "(max-width: 639px)", erhalten: "${call.query}"`);
  assert(call.type === 'change',
    `erwartet ein "change"-Ereignis, erhalten: "${call.type}"`);
  // PR #1200 Review Runde 5, Nice-to-have 2: `typeof call.handler ===
  // 'function'` stand jeder Funktion offen, auch `renderWeekGrid` selbst -
  // genau der Rueckfall aus Runde 4, den die Verdrahtung verhindern soll.
  // Der Funktionsname pinnt fest, DASS es der schmale Handler ist, nicht nur
  // irgendeine Funktion.
  assert(call.handler.name === 'onNarrowWeekLabelQueryChange',
    `erwartet den Handler "onNarrowWeekLabelQueryChange", erhalten: "${call.handler.name}". ` +
    'Ein anderer registrierter Handler (z. B. renderWeekGrid direkt) waere hier ein Rueckfall auf Runde 4.');
});

// --------------------------------------------------------
// Ziehgriff der schmalen Zeile (#1317)
//
// Auf dem Handy nahm der Browser jeden Zug an der Karte als Scroll des
// pan-y-Scrollers und brach den Pointer mit pointercancel ab. Die Proben laufen
// durch den ECHTEN pointerdown-Handler aus wireDragDrop() und lesen den Zustand,
// den ein begonnener Zug hinterlaesst (`meal-slot--dragging`), statt den
// Quelltext zu durchsuchen. Die Browser-Messung (echte Touch-Eingabe per CDP)
// steht im PR; hier haelt die Kette die drei Teile fest, die sie braucht:
// Griff im Markup, Geste nur am Griff, `touch-action: none` nur am Griff.
// --------------------------------------------------------

/** Minimaler Elementbaum: genau das, was der pointerdown-Handler anfasst. */
function dragFakeEl(classes, { parent = null, dataset = {}, shown = true } = {}) {
  const el = {
    classes: new Set(classes),
    parent,
    dataset,
    children: [],
    shown,
    listeners: {},
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
    },
    closest(sel) {
      const cls = sel.replace(/^\./, '');
      for (let n = el; n; n = n.parent) if (n.classes.has(cls)) return n;
      return null;
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children) {
          if (c.classes.has(cls)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
    getClientRects: () => (el.shown ? [{ width: 48, height: 48 }] : []),
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {},
  };
  if (parent) parent.children.push(el);
  return el;
}

/** Baut Slot > Karte > {Titel, Griff, Aktionen} und verdrahtet den echten Handler. */
function dragFixture({ handleShown = true } = {}) {
  const grid = dragFakeEl(['week-grid']);
  const slot = dragFakeEl(['meal-slot'], { parent: grid, dataset: { date: '2026-09-21', type: 'dinner' } });
  const card = dragFakeEl(['meal-card'], { parent: slot, dataset: { mealId: '7' } });
  const open = dragFakeEl(['meal-card__open'], { parent: card });
  const handle = dragFakeEl(['meal-card__drag'], { parent: card, shown: handleShown });
  const icon = dragFakeEl(['lucide'], { parent: handle });
  const actions = dragFakeEl(['meal-card__actions'], { parent: card });

  const zuvorWindow = globalThis.window;
  // reduce: true haelt den Geist aus der Probe - er braucht document.body.
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try { mealsUi.wireDragDrop(grid); } finally { globalThis.window = zuvorWindow; }

  const down = (target, pointerType) => {
    let prevented = false;
    for (const fn of grid.listeners.pointerdown ?? []) {
      fn({ target, pointerType, pointerId: 1, clientX: 10, clientY: 10,
        preventDefault: () => { prevented = true; } });
    }
    return { dragging: slot.classes.has('meal-slot--dragging'), prevented };
  };
  return { slot, card, open, handle, icon, actions, down };
}

test('#1317: die Mahlzeit-Zeile traegt einen Ziehgriff mit benanntem Label, ausserhalb der Aktionsleiste', () => {
  const title = 'Pasta "al forno" & Salat';
  const html = mealsUi.renderSlot('2026-09-21', { key: 'dinner', label: 'Abendessen' },
    [{ id: 7, date: '2026-09-21', meal_type: 'dinner', title, ingredients: [] }], 1, 1);
  const handle = html.match(/<span class="meal-card__drag"[^>]*>[\s\S]*?<\/span>/);
  assert(handle, 'kein .meal-card__drag im Markup der Mahlzeit - ohne Griff hat der Finger keinen Ort, der das Ziehen besitzt');
  assert(handle[0].includes('data-lucide="grip-vertical"'), 'Griff ohne grip-vertical-Icon (dasselbe Zeichen wie Einkauf, Kategorien, Quick-Links)');
  const expectedLabel = pageEsc(pageT('meals.dragHandle', { title }));
  assert(handle[0].includes(`aria-label="${expectedLabel}"`),
    `Griff-Label muss t('meals.dragHandle') mit escaptem Titel sein, gefunden: ${handle[0].match(/aria-label="[^"]*"/)?.[0]}`);
  assert(!handle[0].includes(title), 'der Titel steht unescaped im Griff-Markup');
  const actionsAt = html.indexOf('class="meal-card__actions"');
  assert(actionsAt > html.indexOf(handle[0]),
    'der Griff muss VOR und damit ausserhalb von .meal-card__actions stehen - wireDragDrop nimmt die Aktionsleiste vom Ziehen aus');
});

test('#1317: ein Finger auf dem Kartenrumpf beginnt KEINEN Zug, wenn die Zeile einen Griff zeigt (die Geste gehoert dem Scroller)', () => {
  const f = dragFixture();
  const r = f.down(f.open, 'touch');
  assert(!r.dragging, 'Touch auf dem Titel hat einen Zug begonnen - der Browser beansprucht die Geste als Scroll und bricht ihn mit pointercancel ab');
  assert(!r.prevented, 'Touch auf dem Rumpf ruft preventDefault - der Handler darf die Geste gar nicht erst anfassen');
});

test('#1317: ein Finger auf dem Griff (auch auf seinem Icon) beginnt den Zug', () => {
  const f = dragFixture();
  assert(f.down(f.icon, 'touch').dragging, 'Touch auf dem Griff-Icon hat keinen Zug begonnen');
  const g = dragFixture();
  assert(g.down(g.handle, 'pen').dragging, 'Stift auf dem Griff hat keinen Zug begonnen');
});

test('#1317: die Maus greift weiter die ganze Karte (Desktop unveraendert)', () => {
  const f = dragFixture();
  assert(f.down(f.open, 'mouse').dragging, 'Maus auf dem Kartenrumpf beginnt keinen Zug mehr - Desktop-Drag waere gebrochen');
  const g = dragFixture({ handleShown: false });
  assert(g.down(g.open, 'mouse').dragging, 'Maus auf dem Board (Griff ausgeblendet) beginnt keinen Zug mehr');
});

test('#1317: ohne sichtbaren Griff (breites Board auf Touch) bleibt es beim bisherigen Verhalten', () => {
  const f = dragFixture({ handleShown: false });
  assert(f.down(f.open, 'touch').dragging, 'Touch auf dem Board ohne Griff beginnt keinen Zug mehr - dort gibt es keinen anderen Ort');
  const g = dragFixture();
  assert(!g.down(g.actions, 'touch').dragging, 'die Aktionsleiste ist weiterhin kein Griff');
});

test('#1317: touch-action: none sitzt am Griff der schmalen Zeile und NUR dort, sichtbar nur in der schmalen Fassung', () => {
  const css = readFileSync(new URL('../public/styles/meals.css', import.meta.url), 'utf8');
  const narrow = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  const rules = [...eachRule(css)];
  const handleRules = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === '.meal-card__drag'));
  const narrowRule = handleRules.find((r) => narrow(r) && /touch-action:\s*none/.test(r.body));
  assert(narrowRule, 'kein `.meal-card__drag { touch-action: none }` im (max-width: 639px)-Block');
  assert(/display:\s*flex/.test(narrowRule.body), 'der Griff ist in der schmalen Fassung nicht sichtbar geschaltet');
  const base = handleRules.find((r) => r.at.length === 0);
  assert(base && /display:\s*none/.test(base.body), 'der Griff muss ausserhalb der schmalen Fassung ausgeblendet sein (Board greift die ganze Karte)');
  assert(css.indexOf(base.body) < css.indexOf(narrowRule.body),
    'die ausblendende Basisregel muss VOR der schmalen stehen, sonst gewinnt sie bei gleicher Spezifitaet');
  const offenders = rules.filter((r) => /touch-action:\s*none/.test(r.body)
    && !r.selector.split(',').every((s) => s.trim().endsWith('.meal-card__drag')));
  assert(offenders.length === 0,
    `touch-action: none ausserhalb des Griffs zerlegt das Scrollen der Woche: ${offenders.map((r) => r.selector.trim()).join(' | ')}`);
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Meals-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
