/**
 * Modul: Einkaufslisten-Test
 * Zweck: Validiert alle Shopping-API-Abfragen, Sortierung, Constraints
 * Ausführen: node --experimental-sqlite test-shopping.js
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { url } from '../server/middleware/validate.js';
import { aggregateMealIngredients, parseQuantity } from '../server/services/shopping-import.js';

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
db.exec(MIGRATIONS_SQL[44]); // FTS5 search_index + Item-Trigger (indiziert notes)

const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;

console.log('\n[Shopping-Test] Listen, Artikel, Sortierung\n');

test('Einkaufslisten-Zeilen toggeln nur außerhalb interaktiver Controls', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  assert(/function shouldIgnoreShoppingRowToggle/.test(source), 'Row-Toggle-Guard muss als Helper existieren');
  assert(/button, a, input, select, textarea, \[data-no-row-toggle\]/.test(source), 'Interaktive Controls müssen ignoriert werden');
  assert(/closest\('\.shopping-item'\)/.test(source), 'Klicks müssen auf Einkaufszeilen begrenzt sein');
  assert(/data-item-id/.test(source), 'Zeilen-Toggle muss die Artikel-ID aus data-item-id lesen');
});

test('Shopping-Löschaktionen importieren den gemeinsamen Undo-Helper', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  assert(
    /import\s*\{[^}]*\bscheduleUndoableDelete\b[^}]*\}\s*from\s*'\/utils\/ux\.js'/.test(source),
    'scheduleUndoableDelete muss aus /utils/ux.js importiert werden',
  );
  // Drei Löschwege, drei Male derselbe Helfer: Einzel-Artikel, „Abgehakt löschen"
  // und - seit Critique 2026-07-30 - die ganze Liste. Der Sicherheitsgradient war
  // invertiert: der einzelne Artikel hatte Undo und keine Rückfrage, die Liste des
  // ganzen Haushalts eine Rückfrage und kein Undo.
  const calls = source.match(/\bscheduleUndoableDelete\s*\(/g) ?? [];
  assert(calls.length === 3, `Einzel-, Sammel- und Listenlöschung müssen den Undo-Helper nutzen, gefunden: ${calls.length}`);
  // Die Liste behält ZUSÄTZLICH ihre Rückfrage - eine Rückfrage schützt vor dem
  // Fehlgriff, ein Undo vor dem falschen Entschluss.
  const deleteList = source.slice(source.indexOf("action === 'delete-list'"));
  assert(/confirmModal\(/.test(deleteList.slice(0, 1200)), 'die Listenlöschung braucht weiter eine Rückfrage');
  assert(/deleteListConfirm'?,?\s*\{[\s\S]{0,120}count/.test(deleteList.slice(0, 1600)),
    'die Rückfrage muss die Artikelzahl nennen - „und alle Artikel löschen?" sagte nicht, wie viele');
});

// --------------------------------------------------------
// Kategorie-Verwaltung wandert nach Shopping (Task 7)
// --------------------------------------------------------
test('Shopping-Seite importiert den Category-Manager und öffnet ihn bei manage=categories', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  // Seit Audit F-15 nutzt Einkauf die geteilte Komponente (wie Budget/Tasks/Kontakte).
  assert(/components\/category-manager\.js/.test(source), 'shopping.js muss den geteilten Category-Manager importieren');
  assert(/yuvomi-category-manager/.test(source), 'shopping.js muss das geteilte Custom Element verwenden');
  assert(/basePath:\s*'\/shopping\/categories'/.test(source), 'shopping.js muss die Komponente auf /shopping/categories konfigurieren');
  assert(/manage.*===\s*'categories'|get\('manage'\)|manage=categories|'manage'/.test(source), 'shopping.js muss den manage-Query-Parameter auswerten');
  assert(/shopping\.manageCategories/.test(source), 'Eine übersetzte „Kategorien verwalten"-Aktion muss vorhanden sein');
  assert(/category-manager-changed/.test(source), 'shopping.js muss auf das category-manager-changed-Event reagieren');
});

test('Shopping-Seite bietet einen Essensplan-Import mit Datumsbereich an', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  // Die Aktion, nicht ihre Schreibweise: sie stand als `data-action`-Attribut
  // im Listenkopf und ist seit dessen Wegfall (2026-08-11) ein Eintrag im
  // Ueberlaufmenue der Chip-Leiste, wo popoverMenuHtml das Attribut erzeugt.
  // Beide Fassungen erfuellen die Zusage „der Import ist von hier erreichbar".
  assert(
    /data-action="import-meals"|action:\s*'import-meals'/.test(source),
    'Die Einkaufsseite muss eine Import-Aktion aus dem Essensplan anbieten',
  );
  assert(/function openMealPlanImport/.test(source), 'Shopping-Seite muss einen Import-Dialog für den Essensplan besitzen');
  assert(/api\.post\(`\/shopping\/\$\{state\.activeListId\}\/import-meal-plan`/.test(source), 'Import-Dialog muss die Shopping-Range-Import-Route aufrufen');
  assert(/shopping\.importMealsEmpty/.test(source), 'Import-Dialog muss leere Bereiche mit einer Shopping-spezifischen Meldung behandeln');
  assert(/type="date" id="shopping-import-from"/.test(source), 'Import-Dialog muss ein Von-Datum anbieten');
  assert(/type="date" id="shopping-import-to"/.test(source), 'Import-Dialog muss ein Bis-Datum anbieten');
  assert(/addLocalDays\(today, 6\)/.test(source), 'Import-Dialog muss standardmäßig 7 Tage (heute + 6) vorauswählen');
});

test('Geteilter Category-Manager erfüllt die Web-Component-Verträge (Einkauf, Audit F-15)', () => {
  const source = readFileSync(new URL('../public/components/category-manager.js', import.meta.url), 'utf8');
  assert(/customElements\.define\(\s*'yuvomi-category-manager'/.test(source), 'Tag-Name muss yuvomi-category-manager sein');
  assert(/disconnectedCallback/.test(source), 'Lifecycle-Cleanup muss vorhanden sein');
  // Numerische Shopping-IDs und String-Keys (Budget/Tasks/Kontakte) laufen über
  // denselben Schlüssel-Helper — die Route-Pfade bleiben basePath-relativ.
  assert(/_keyOf\(item\)/.test(source), 'Komponente braucht den key/id-Schlüssel-Helper');
  assert(/item\.key \?\? item\.id/.test(source), '_keyOf muss auf numerische ids zurückfallen');
  assert(/api\.patch\(`\$\{this\._basePath\}\/reorder`/.test(source), 'Reorder muss PATCH auf basePath/reorder nutzen');
  assert(/import\s*\{\s*esc\s*\}\s*from\s*'\/utils\/html\.js'/.test(source), 'User-Daten müssen via esc() escaped werden');
  assert(!/\.innerHTML\s*=/.test(source), 'Komponente darf innerHTML nicht zuweisen');
  const disconnectFn = source.match(/disconnectedCallback\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert(/removeEventListener/.test(disconnectFn), 'disconnectedCallback muss Listener entfernen');
});

test('Der Kategorie-Manager frischt im Ereignis auf, nicht beim Schliessen', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  const fn = source.match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'openCategoryManager muss auffindbar sein');
  assert(/manager\.addEventListener\('category-manager-changed'/.test(fn), 'onSave muss den Listener registrieren');
  assert(/manager\.configure\(\{/.test(fn), 'onSave muss die geteilte Komponente konfigurieren');
  assert(/labelResolver:\s*\(item\) => categoryLabel\(item\.name\)/.test(fn), 'labelResolver muss Default-Kategorien lokalisieren');
  // Frueher stand hier die Umkehrung: onClose MUSSTE abmelden. Gemessen am
  // 08.09.2026 kommt das Ereignis beim Loeschen erst, wenn das Element schon
  // aus dem Dokument ist (`confirmOverModal` raeumt das Modal darunter ab,
  // `api.delete` laeuft danach) - die Abmeldung verpasste also genau die
  // Loeschung, und der gleichfalls in onClose ausgewertete `changed`-Merker
  // stand dabei auf false. Beides ist jetzt gesperrt.
  assert(!/removeEventListener\('category-manager-changed'/.test(fn), 'onClose darf sich nicht abmelden - das liefe vor dem Loeschen');
  assert(/const onCategoriesChanged = async \(\) => \{[\s\S]*?loadCategories\(\)[\s\S]*?renderListContent\(container\)/.test(fn),
    'die Auffrischung der sichtbaren Liste gehoert in den Ereignis-Handler');
  // Und die Artikel muessen mit: der Einkauf haelt die Kategorie als NAME in
  // `shopping_items.category`, also schreibt der Server beim Umbenennen und
  // beim Loeschen in die Artikelzeilen (`UPDATE shopping_items SET category`).
  // `loadCategories()` fasst `state.items` nicht an, und `groupItemsByCategory`
  // liest den Namen von dort - ohne Nachladen stehen die Zeilen unter der alten
  // Ueberschrift am Listenende.
  // `listId` statt `state.activeListId`: der Nutzer kann waehrend des Rundlaufs
  // die Liste wechseln, und dann gehoert weder das Schreiben noch das Rendern
  // mehr diesem Handler.
  assert(/const onCategoriesChanged = async \(\) => \{[\s\S]*?const listId = state\.activeListId;[\s\S]*?loadItems\(listId\)[\s\S]*?renderListContent\(container\)/.test(fn),
    'der Handler muss auch die Artikel nachladen - der Server weist sie beim Loeschen um');
});

let listId, list2Id, itemId1, itemId2, itemId3;

// --------------------------------------------------------
// Listen-CRUD
// --------------------------------------------------------
test('Liste erstellen', () => {
  const r = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', ?)`).run(uid);
  listId = r.lastInsertRowid;
  assert(listId > 0);
});

test('Zweite Liste erstellen', () => {
  const r = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('dm', ?)`).run(uid);
  list2Id = r.lastInsertRowid;
  assert(list2Id > 0);
});

test('Alle Listen mit Zähler abrufbar', () => {
  const lists = db.prepare(`
    SELECT sl.*,
      COUNT(si.id) AS item_total,
      SUM(CASE WHEN si.is_checked = 1 THEN 1 ELSE 0 END) AS item_checked
    FROM shopping_lists sl
    LEFT JOIN shopping_items si ON si.list_id = sl.id
    GROUP BY sl.id ORDER BY sl.created_at ASC
  `).all();
  assert(lists.length === 2, `Erwartet 2, erhalten ${lists.length}`);
  assert(lists[0].name === 'REWE');
  assert(lists[0].item_total === 0, 'Noch keine Artikel');
});

test('Liste umbenennen', () => {
  db.prepare(`UPDATE shopping_lists SET name = 'REWE Wocheneinkauf' WHERE id = ?`).run(listId);
  const l = db.prepare('SELECT name FROM shopping_lists WHERE id = ?').get(listId);
  assert(l.name === 'REWE Wocheneinkauf', 'Name aktualisiert');
});

// --------------------------------------------------------
// Artikel-CRUD
// --------------------------------------------------------
test('Artikel hinzufügen - Obst & Gemüse', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, quantity, category)
    VALUES (?, 'Äpfel', '1 kg', 'Obst & Gemüse')`).run(listId);
  itemId1 = r.lastInsertRowid;
  assert(itemId1 > 0);
});

test('Artikel hinzufügen - Milchprodukte', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, quantity, category)
    VALUES (?, 'Milch', '1 Liter', 'Milchprodukte')`).run(listId);
  itemId2 = r.lastInsertRowid;
  assert(itemId2 > 0);
});

test('Artikel hinzufügen - Backwaren', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, category)
    VALUES (?, 'Brot', 'Backwaren')`).run(listId);
  itemId3 = r.lastInsertRowid;
  assert(itemId3 > 0);
});

// --------------------------------------------------------
// Supermarkt-Gang-Sortierung
// --------------------------------------------------------
test('Sortierung nach Supermarkt-Gang-Logik', () => {
  const categories = [
    'Obst & Gemüse', 'Backwaren', 'Milchprodukte', 'Fleisch & Fisch',
    'Tiefkühl', 'Getränke', 'Haushalt', 'Drogerie', 'Sonstiges',
  ];
  const caseExpr = categories.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ');

  const items = db.prepare(`
    SELECT * FROM shopping_items
    WHERE list_id = ?
    ORDER BY CASE category ${caseExpr} ELSE 9 END, is_checked ASC, created_at ASC
  `).all(listId);

  assert(items.length === 3, `Erwartet 3, erhalten ${items.length}`);
  assert(items[0].category === 'Obst & Gemüse', `Erste Kategorie: ${items[0].category}`);
  assert(items[1].category === 'Backwaren',     `Zweite Kategorie: ${items[1].category}`);
  assert(items[2].category === 'Milchprodukte', `Dritte Kategorie: ${items[2].category}`);
});

test('Abgehakte Artikel ans Ende innerhalb der Kategorie', () => {
  // Zweiten Artikel in Obst einfügen
  db.prepare(`INSERT INTO shopping_items (list_id, name, category, is_checked)
    VALUES (?, 'Bananen', 'Obst & Gemüse', 1)`).run(listId);

  const categories = [
    'Obst & Gemüse', 'Backwaren', 'Milchprodukte', 'Fleisch & Fisch',
    'Tiefkühl', 'Getränke', 'Haushalt', 'Drogerie', 'Sonstiges',
  ];
  const caseExpr = categories.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ');

  const items = db.prepare(`
    SELECT * FROM shopping_items WHERE list_id = ?
    ORDER BY CASE category ${caseExpr} ELSE 9 END, is_checked ASC, created_at ASC
  `).all(listId);

  const obst = items.filter((i) => i.category === 'Obst & Gemüse');
  assert(obst[0].name === 'Äpfel',   'Nicht abgehakt zuerst');
  assert(obst[1].name === 'Bananen', 'Abgehakt danach');
  assert(obst[1].is_checked === 1,   'Bananen ist abgehakt');
});

// --------------------------------------------------------
// Artikel abhaken
// --------------------------------------------------------
test('Artikel abhaken (toggle)', () => {
  db.prepare(`UPDATE shopping_items SET is_checked = 1 WHERE id = ?`).run(itemId1);
  const item = db.prepare('SELECT is_checked FROM shopping_items WHERE id = ?').get(itemId1);
  assert(item.is_checked === 1, 'Artikel abgehakt');
});

test('Artikel wieder aktivieren', () => {
  db.prepare(`UPDATE shopping_items SET is_checked = 0 WHERE id = ?`).run(itemId1);
  const item = db.prepare('SELECT is_checked FROM shopping_items WHERE id = ?').get(itemId1);
  assert(item.is_checked === 0, 'Artikel wieder aktiv');
});

// --------------------------------------------------------
// Abgehakte löschen
// --------------------------------------------------------
test('"Abgehakte löschen" entfernt nur is_checked=1', () => {
  db.prepare(`UPDATE shopping_items SET is_checked = 1 WHERE id IN (?, ?)`).run(itemId1, itemId2);

  // Äpfel (itemId1) + Milch (itemId2) + Bananen (bereits checked aus vorherigem Test) = 3
  const result = db.prepare(`DELETE FROM shopping_items WHERE list_id = ? AND is_checked = 1`).run(listId);
  assert(result.changes === 3, `Gelöscht: ${result.changes}, erwartet: 3`);

  const remaining = db.prepare(`SELECT * FROM shopping_items WHERE list_id = ?`).all(listId);
  assert(remaining.every((i) => i.is_checked === 0), 'Nur nicht-abgehakte verbleiben');
  assert(remaining.length === 1, `Verbleibend: ${remaining.length} (nur Brot)`);
});

// --------------------------------------------------------
// Autocomplete
// --------------------------------------------------------
test('Autocomplete-Suggestions nach Prefix', () => {
  db.prepare(`INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Joghurt', 'Milchprodukte')`).run(listId);
  db.prepare(`INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Käse', 'Milchprodukte')`).run(listId);

  const results = db.prepare(`
    SELECT DISTINCT name FROM shopping_items
    WHERE name LIKE ? COLLATE NOCASE
    ORDER BY name ASC LIMIT 8
  `).all('J%');

  assert(results.length >= 1, 'Mindestens 1 Vorschlag');
  assert(results[0].name === 'Joghurt', `Erwartet Joghurt, erhalten: ${results[0].name}`);
});

test('Autocomplete - kein Match gibt leeres Array', () => {
  const results = db.prepare(`
    SELECT DISTINCT name FROM shopping_items WHERE name LIKE ? COLLATE NOCASE
  `).all('XXXXXXXX%');
  assert(results.length === 0, 'Kein Match erwartet');
});

test('Essensplan-Import aggregiert gleiche Zutaten mit numerischen Mengen', () => {
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Tomaten', quantity: '2', category: 'Obst & Gemüse' },
    { id: 2, meal_id: 11, name: 'Tomaten', quantity: '3', category: 'Obst & Gemüse' },
  ]);
  assert(result.length === 1, `Erwartet 1 aggregierten Eintrag, erhalten ${result.length}`);
  assert(result[0].name === 'Tomaten', 'Name muss erhalten bleiben');
  assert(result[0].quantity === '5', `Erwartet summierte Menge 5, erhalten ${result[0].quantity}`);
  assert(result[0].added_from_meal === null, 'Bei mehreren Mahlzeiten darf kein einzelner meal-Verweis gesetzt werden');
});

test('Essensplan-Import aggregiert gleiche Zutaten mit Einheiten', () => {
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Reis', quantity: '100 g', category: 'Sonstiges' },
    { id: 2, meal_id: 11, name: 'Reis', quantity: '50 g', category: 'Sonstiges' },
  ]);
  assert(result.length === 1, `Erwartet 1 aggregierten Eintrag, erhalten ${result.length}`);
  assert(result[0].quantity === '150 g', `Erwartet summierte Menge 150 g, erhalten ${result[0].quantity}`);
});

test('Essensplan-Import summiert auch Mengen mit gleicher Einheit', () => {
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Eier', quantity: '1 pack', category: 'Milchprodukte' },
    { id: 2, meal_id: 11, name: 'Eier', quantity: '1 pack', category: 'Milchprodukte' },
    { id: 3, meal_id: 12, name: 'Eier', quantity: '2 pack', category: 'Milchprodukte' },
  ]);
  assert(result.length === 1, `Erwartet 1 aggregierten Eintrag, erhalten ${result.length}`);
  assert(result[0].quantity === '4 pack', `Erwartet summierte Menge 4 pack, erhalten ${result[0].quantity}`);
});

test('parseQuantity liest eine Menge in fremden Ziffern', () => {
  // `\d` ist in JavaScript ASCII. Vorher traf die Regex „۲۵۰ g" ueberhaupt nicht,
  // die Zutat fiel wortlos aus der Summierung und stand danach zweimal
  // untereinander auf der Liste - ein Haushalt, der seine eigenen Ziffern
  // benutzt, bekam stillschweigend eine schlechtere Einkaufsliste.
  for (const [eingabe, betrag, einheit] of [
    ['۲۵۰ g', 250, 'g'],   // fa
    ['٢٥٠ g', 250, 'g'],   // ar
    ['२५० g', 250, 'g'],   // hi
    ['๒๕๐ g', 250, 'g'],   // th
    ['۱٫۵ kg', 1.5, 'kg'], // oestlicher Dezimaltrenner
    // Das oestliche Tausenderzeichen hat einen eigenen Test - es wird
    // aufgeloest, nicht wie ein ASCII-Komma gedeutet.
  ]) {
    const ergebnis = parseQuantity(eingabe);
    assert(ergebnis !== null, `"${eingabe}" wurde gar nicht gelesen`);
    assert(ergebnis.amount === betrag, `"${eingabe}": ${ergebnis.amount} statt ${betrag}`);
    assert(ergebnis.unit === einheit, `"${eingabe}": Einheit "${ergebnis.unit}" statt "${einheit}"`);
  }
});

test('parseQuantity laesst das bestehende Verhalten unveraendert', () => {
  // Die Umschrift darf nur HINZUFUEGEN. Jeder dieser Faelle lief vorher schon so.
  for (const [eingabe, erwartet] of [
    ['250 g', { amount: 250, unit: 'g' }],
    ['1,5 kg', { amount: 1.5, unit: 'kg' }],
    ['1.5 kg', { amount: 1.5, unit: 'kg' }],
    ['12', { amount: 12, unit: '' }],
    ['-3 EL', { amount: -3, unit: 'el' }],
    ['1,000 g', { amount: 1, unit: 'g' }],
    ['eine Prise', null],
    ['', null],
  ]) {
    const ergebnis = parseQuantity(eingabe);
    assert(JSON.stringify(ergebnis) === JSON.stringify(erwartet),
      `"${eingabe}": ${JSON.stringify(ergebnis)} statt ${JSON.stringify(erwartet)}`);
  }
});

test('parseQuantity schneidet die Einheit aus dem Original, nicht aus der Umschrift', () => {
  // Umgeschrieben wird nur, was gerechnet wird. Sonst verloere ein zweiter
  // Zahlenteil seine Ziffern und die gespeicherte Einheit saehe anders aus als
  // die, die dasteht.
  assert(parseQuantity('۲ x ۵۰۰ g').unit === 'x ۵۰۰ g',
    `Einheit war "${parseQuantity('۲ x ۵۰۰ g').unit}"`);
  assert(parseQuantity('۲۵۰ گرم').unit === 'گرم',
    `Einheit war "${parseQuantity('۲۵۰ گرم').unit}"`);
});

test('parseQuantity loest das oestliche Tausenderzeichen auf', () => {
  // U+066C ist per Unicode EINDEUTIG ein Tausenderzeichen - anders als das
  // ASCII-Komma, dem der Server ohne Region nicht ansieht, ob es gruppiert oder
  // trennt. „١٬٠٠٠ g" heisst tausend Gramm. Es auf ein Komma abzubilden und dem
  // bestehenden Pfad zu ueberlassen las daraus 1: der Faktor tausend daneben,
  // mit Information, die man selbst weggeworfen hatte.
  assert(parseQuantity('١٬٠٠٠ g').amount === 1000, `erhalten ${parseQuantity('١٬٠٠٠ g').amount}`);
  assert(parseQuantity('٢٬٥٠٠ g').amount === 2500, `erhalten ${parseQuantity('٢٬٥٠٠ g').amount}`);
  // Das ASCII-Komma bleibt unangetastet - dort fehlt genau diese Eindeutigkeit.
  assert(parseQuantity('1,000 g').amount === 1, 'ASCII-Verhalten darf sich nicht aendern');
  // Und der oestliche DEZIMALtrenner (U+066B) bleibt ein Dezimaltrenner.
  assert(parseQuantity('١٢٫٥ kg').amount === 12.5, `erhalten ${parseQuantity('١٢٫٥ kg').amount}`);
});

test('parseQuantity prueft eine Gruppierung, statt den Trenner nur wegzuwerfen', () => {
  // Die Aufloesung war erst bedingungslos: „٢٬٥٠ g" wurde 250, „٢٬٠٠٠٠ g" wurde
  // 20000. Beides sind KEINE gueltigen Gruppierungen - zwei bzw. vier Stellen
  // hinter dem Zeichen -, sondern vermutlich Tippfehler. Eine Zahl, die nur zur
  // Haelfte einem Muster folgt, ist keine Zahl.
  assert(parseQuantity('٢٬٥٠ g') === null, 'zwei Stellen sind keine Gruppierung');
  assert(parseQuantity('٢٬٥ g') === null, 'eine Stelle auch nicht');
  assert(parseQuantity('٢٬٠٠٠٠ g') === null, 'vier Stellen auch nicht');
  assert(parseQuantity('٢٬٥٠٠ g').amount === 2500, 'die gueltige Form bleibt lesbar');
  // Mehrere Gruppen in voller Laenge: vorher wurde nur die erste gelesen und der
  // Rest zur Einheit („١٬٠٠٠٬٠٠٠ g" ergab 1000 mit Einheit „٬٠٠٠ g").
  assert(parseQuantity('١٬٠٠٠٬٠٠٠ g').amount === 1000000,
    `erhalten ${JSON.stringify(parseQuantity('١٬٠٠٠٬٠٠٠ g'))}`);
  // Und mit Dezimalteil dahinter.
  assert(parseQuantity('١٬٠٠٠٫٥ g').amount === 1000.5,
    `erhalten ${JSON.stringify(parseQuantity('١٬٠٠٠٫٥ g'))}`);
});

test('parseQuantity weist ein mehrdeutiges Komma in fremden Ziffern ab', () => {
  // bn, hi und th gruppieren mit dem ASCII-Komma. „১,০০০ g" heisst dort tausend
  // Gramm - die naive ASCII-Deutung machte daraus ein Gramm, also den Faktor 1000
  // daneben. Der Server kann die richtige Deutung nicht sicher wissen, und diese
  // Eingaben hatten vor der Umschrift GAR KEIN Verhalten: sie nachtraeglich einer
  // Deutung zu unterwerfen, die fuer sie nie gedacht war, waere die schlechtere
  // von zwei Antworten.
  for (const eingabe of ['১,০০০ g', '१,००० g', '๑,๐๐๐ g']) {
    assert(parseQuantity(eingabe) === null, `"${eingabe}" darf nicht als 1 gelten`);
  }
  // Ein Punkt an derselben Stelle ist dort dagegen der Dezimaltrenner.
  assert(parseQuantity('১.৫ kg').amount === 1.5, 'bn: Punkt trennt dezimal');
  assert(parseQuantity('१.५ kg').amount === 1.5, 'hi: Punkt trennt dezimal');
});

test('parseQuantity laesst den ASCII-Pfad vollstaendig unberuehrt', () => {
  // Eine reine ASCII-Zahl deutet dieser Server seit jeher naiv. Das zu aendern
  // waere eine eigene Entscheidung mit Folgen fuer bestehende Daten - die
  // strengere Regel gilt deshalb NUR fuer Zahlen mit fremden Zeichen, die vorher
  // ohnehin kein Verhalten hatten.
  for (const [eingabe, erwartet] of [
    ['1,000 g', { amount: 1, unit: 'g' }],
    ['1,000,000 g', { amount: 1, unit: ',000 g' }],
    ['2x500 g', { amount: 2, unit: 'x500 g' }],
    ['1.5 kg', { amount: 1.5, unit: 'kg' }],
  ]) {
    assert(JSON.stringify(parseQuantity(eingabe)) === JSON.stringify(erwartet),
      `"${eingabe}": ${JSON.stringify(parseQuantity(eingabe))} statt ${JSON.stringify(erwartet)}`);
  }
});

test('parseQuantity laesst einen Bruch dem Rohtext-Pfad', () => {
  // „١/٢ kg" ergaebe sonst Betrag 1 mit Einheit „/٢ kg", und zwei halbe Kilo
  // stuenden als „2 /٢ kg" auf der Liste. Ohne Umschrift traf die Regex solche
  // Mengen gar nicht - dort gehoeren sie weiter hin, bis jemand Brueche rechnet.
  assert(parseQuantity('١/٢ kg') === null, 'oestlicher Bruch darf nicht als 1 gelten');
  // Derselbe Fehler stand fuer ASCII schon vorher da, nur unbemerkt.
  assert(parseQuantity('1/2 kg') === null, 'ASCII-Bruch darf nicht als 1 gelten');
  const summe = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Butter', quantity: '١/٢ kg', category: 'Sonstiges' },
    { id: 2, meal_id: 11, name: 'Butter', quantity: '١/٢ kg', category: 'Sonstiges' },
  ]);
  assert(summe[0].quantity === '2 x ١/٢ kg', `erhalten ${summe[0].quantity}`);
});

test('Essensplan-Import fasst gleiche Mengen mit Zahlen IM Rest zusammen', () => {
  // Die Einheit bleibt fuer die Anzeige im Original, aber der Schluessel nutzt
  // ihre umgeschriebene Fassung: „۲ x ۵۰۰ g" und „2 x 500 g" sind dieselbe Menge
  // und gehoerten sonst in zwei Zeilen.
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Milch', quantity: '۲ x ۵۰۰ g', category: 'Sonstiges' },
    { id: 2, meal_id: 11, name: 'Milch', quantity: '2 x 500 g', category: 'Sonstiges' },
  ]);
  assert(result.length === 1, `Erwartet 1 Eintrag, erhalten ${result.length}`);
  assert(result[0].quantity === '4 x ۵۰۰ g', `erhalten ${result[0].quantity}`);
});

test('Essensplan-Import summiert dieselbe Zutat ueber Schreibweisen hinweg', () => {
  // Der eigentliche Nutzen: zwei Mahlzeiten, dieselbe Zutat, verschieden
  // geschrieben. Vorher ergaben sie zwei Zeilen, weil die eine als Text galt.
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Mehl', quantity: '۲۵۰ g', category: 'Sonstiges' },
    { id: 2, meal_id: 11, name: 'Mehl', quantity: '250 g', category: 'Sonstiges' },
  ]);
  assert(result.length === 1, `Erwartet 1 aggregierten Eintrag, erhalten ${result.length}`);
  assert(result[0].quantity === '500 g', `Erwartet 500 g, erhalten ${result[0].quantity}`);
});

test('Essensplan-Import zählt rein textuelle Mengen sichtbar zusammen', () => {
  const result = aggregateMealIngredients([
    { id: 1, meal_id: 10, name: 'Salz', quantity: 'nach Geschmack', category: 'Sonstiges' },
    { id: 2, meal_id: 11, name: 'Salz', quantity: 'nach Geschmack', category: 'Sonstiges' },
  ]);
  assert(result.length === 1, `Erwartet 1 aggregierten Eintrag, erhalten ${result.length}`);
  assert(result[0].quantity === '2 x nach Geschmack', `Erwartet 2 x nach Geschmack, erhalten ${result[0].quantity}`);
});

// --------------------------------------------------------
// Zähler-Abfrage
// --------------------------------------------------------
test('Listen-Zähler korrekt nach Änderungen', () => {
  const list = db.prepare(`
    SELECT sl.*,
      COUNT(si.id) AS item_total,
      SUM(CASE WHEN si.is_checked = 1 THEN 1 ELSE 0 END) AS item_checked
    FROM shopping_lists sl
    LEFT JOIN shopping_items si ON si.list_id = sl.id
    WHERE sl.id = ?
    GROUP BY sl.id
  `).get(listId);
  assert(list.item_total > 0, `item_total=${list.item_total}`);
  assert(list.item_checked === 0, 'Keine abgehakten mehr');
});

// --------------------------------------------------------
// Cascade-Löschung
// --------------------------------------------------------
test('Liste löschen entfernt alle Artikel (CASCADE)', () => {
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(list2Id);
  const items = db.prepare('SELECT * FROM shopping_items WHERE list_id = ?').all(list2Id);
  assert(items.length === 0, 'Keine Artikel nach Listen-Löschung');
});

test('Nicht existierende Liste gibt keine Zeile', () => {
  const list = db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(99999);
  assert(!list, 'Sollte undefined sein');
});

// --------------------------------------------------------
// Scroll-Erhalt beim Abhaken (Issue #276)
// --------------------------------------------------------
test('Abhaken aktualisiert nur die betroffene Zeile statt die ganze Liste neu zu rendern', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  assert(/function updateItemRow\(container, item\)/.test(source), 'updateItemRow-Helper muss existieren');

  // toggleShoppingItem darf die Liste nicht mehr komplett neu aufbauen (würde scrollTop auf 0 klemmen)
  const toggleFn = source.match(/async function toggleShoppingItem[\s\S]*?\n}/)?.[0] ?? '';
  assert(toggleFn, 'toggleShoppingItem muss auffindbar sein');
  assert(/updateItemRow\(container, item\)/.test(toggleFn), 'Klick-Toggle muss updateItemRow nutzen');
  assert(!/updateItemsList\(/.test(toggleFn), 'Klick-Toggle darf updateItemsList nicht mehr aufrufen');

  // updateItemRow darf den Listen-Container nicht leeren
  const rowFn = source.match(/function updateItemRow[\s\S]*?\n}/)?.[0] ?? '';
  assert(!/#items-list/.test(rowFn), 'updateItemRow darf den Listen-Container nicht ansprechen/leeren');
});

// --------------------------------------------------------
test('Klick-Delegation wird pro #list-content nur einmal gebunden (Issue #398)', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  const wireFn = source.match(/function wireListContentEvents[\s\S]*?\n}/)?.[0] ?? '';
  assert(wireFn, 'wireListContentEvents muss auffindbar sein');

  // Die Klick-Delegation hängt am stabilen #list-content (nur Kinder werden via
  // replaceChildren ersetzt). switchList/rename rufen wireListContentEvents erneut auf —
  // ohne Guard würde der Listener dupliziert und ein Toggle-Klick höbe sich auf.
  const guardIdx = wireFn.search(/dataset\.eventsWired/);
  const clickIdx = wireFn.search(/addEventListener\('click'/);
  assert(guardIdx >= 0, 'wireListContentEvents muss einen Einmal-Guard (dataset.eventsWired) besitzen');
  assert(clickIdx >= 0, 'wireListContentEvents muss die Klick-Delegation binden');
  assert(guardIdx < clickIdx, 'Der Einmal-Guard muss vor der Klick-Bindung greifen');

  // Umbenennen muss ohne Maus gehen. Hier stand `assert(/function
  // wireRenameKeydown/)` - der Helfer uebersetzte „Enter" auf dem Listen-Titel in
  // einen Klick, weil der Titel ein `<span role="button" tabindex="0">` war, also
  // ein nachgebauter Knopf ohne Tastaturverhalten. Der Test pinnte damit die
  // KRUECKE statt der Zusage und waere rot geworden, obwohl die Bedienbarkeit
  // stieg: seit dem Wegfall des Listenkopfs (2026-08-11) ist Umbenennen ein
  // Eintrag im Ueberlaufmenue und damit ein echter <button>, den der Browser
  // selbst per Enter und Leertaste bedient.
  //
  // Geprueft wird deshalb das Gegenteil: dass rename-list NICHT wieder als
  // nachgebauter Knopf auftaucht. Ein `role="button"` in der Naehe der Aktion
  // hiesse, dass die JS-Kruecke zurueckmuesste.
  assert(
    /action:\s*'rename-list'|data-action="rename-list"/.test(source),
    'Die Aktion „Liste umbenennen" muss es weiterhin geben',
  );
  const renameMarkup = source.match(/.{0,200}rename-list.{0,200}/gs) ?? [];
  assert(renameMarkup.length > 0, 'rename-list nicht auffindbar - der Test misst dann nichts');
  for (const snippet of renameMarkup) {
    assert(
      !/role="button"/.test(snippet),
      'rename-list haengt wieder an einem nachgebauten Knopf (role="button"). '
      + 'Ein echtes <button> bringt Enter und Leertaste vom Browser mit; ein Span '
      + 'braucht dafuer wieder eigenes JS.',
    );
  }
});

// --------------------------------------------------------
// Rich-Attribute: notes + url (#426)
// --------------------------------------------------------
test('Artikel speichert notes + url und gibt sie zurück', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, category, notes, url)
    VALUES (?, 'Wasserfilter', 'Haushalt', 'Modell BWT 814873', 'https://example.com/filter')`).run(listId);
  const item = db.prepare('SELECT notes, url FROM shopping_items WHERE id = ?').get(r.lastInsertRowid);
  assert(item.notes === 'Modell BWT 814873', `notes: ${item.notes}`);
  assert(item.url === 'https://example.com/filter', `url: ${item.url}`);
});

test('notes/url sind optional (NULL erlaubt)', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Salz', 'Sonstiges')`).run(listId);
  const item = db.prepare('SELECT notes, url FROM shopping_items WHERE id = ?').get(r.lastInsertRowid);
  assert(item.notes === null && item.url === null, 'notes/url default NULL');
});

test('FTS-Suche findet Artikel über die Notiz (body indiziert notes)', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, category, notes)
    VALUES (?, 'Batterien', 'Haushalt', 'Zzxglobber Spezialgroesse')`).run(listId);
  const hit = db.prepare(`SELECT entity_id FROM search_index WHERE entity = 'item' AND search_index MATCH ?`).get('Zzxglobber');
  assert(hit && Number(hit.entity_id) === Number(r.lastInsertRowid), 'Artikel muss über die Notiz auffindbar sein');
});

test('FTS-Update spiegelt geänderte Notiz', () => {
  const r = db.prepare(`INSERT INTO shopping_items (list_id, name, category, notes)
    VALUES (?, 'Kaffee', 'Getränke', 'alteNotiz')`).run(listId);
  db.prepare('UPDATE shopping_items SET notes = ? WHERE id = ?').run('Qwxplumbus', r.lastInsertRowid);
  const hit = db.prepare(`SELECT entity_id FROM search_index WHERE entity = 'item' AND search_index MATCH ?`).get('Qwxplumbus');
  assert(hit && Number(hit.entity_id) === Number(r.lastInsertRowid), 'Aktualisierte Notiz muss im Index landen');
  const stale = db.prepare(`SELECT entity_id FROM search_index WHERE entity = 'item' AND search_index MATCH ?`).get('alteNotiz');
  assert(!stale, 'Alte Notiz darf nicht mehr im Index sein');
});

// --------------------------------------------------------
// url()-Validator (XSS-Härtung: nur http/https)
// --------------------------------------------------------
test('url() akzeptiert http/https', () => {
  assert(url('https://example.com', 'URL').value === 'https://example.com', 'https ok');
  assert(url('http://x.io/pfad?q=1', 'URL').value === 'http://x.io/pfad?q=1', 'http ok');
  assert(url('https://example.com', 'URL').error === null, 'kein Fehler bei gültiger URL');
});

test('url() blockt javascript:/data:/ftp: (XSS-Schutz)', () => {
  assert(url('javascript:alert(1)', 'URL').error, 'javascript: muss abgelehnt werden');
  assert(url('data:text/html,<script>', 'URL').error, 'data: muss abgelehnt werden');
  assert(url('ftp://host/file', 'URL').error, 'ftp: muss abgelehnt werden');
  assert(url('javascript:alert(1)', 'URL').value === null, 'kein Wert bei Ablehnung');
});

test('url() lehnt Unsinn ab und erlaubt Leerwert', () => {
  assert(url('kein link', 'URL').error, 'ungültige URL muss Fehler geben');
  assert(url('', 'URL').value === null && url('', 'URL').error === null, 'leer ist erlaubt (optional)');
  assert(url(null, 'URL').error === null, 'null ist erlaubt');
  assert(url('https://x.io/' + 'a'.repeat(2100), 'URL').error, 'Überlänge muss abgelehnt werden');
});

// --------------------------------------------------------
// Frontend: Detail-Drawer (Progressive Disclosure)
// --------------------------------------------------------
test('shopping.js rendert Detail-Button + Indikatoren und öffnet den Drawer', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  assert(/data-action="item-details"/.test(source), 'Zeile muss einen Details-Button (item-details) haben');
  assert(/function renderItemMeta/.test(source), 'renderItemMeta muss die Indikatoren rendern');
  assert(/function openItemDetails/.test(source), 'openItemDetails muss existieren');
  const fn = source.match(/function openItemDetails[\s\S]*?\n\}/)?.[0] ?? '';
  assert(/openModal\(/.test(fn), 'Detail-Drawer muss openModal nutzen');
  assert(/api\.patch\(`\/shopping\/items\/\$\{item\.id\}`/.test(fn), 'Speichern muss per PATCH erfolgen');
  assert(/rel="noopener noreferrer"/.test(fn) && /target="_blank"/.test(fn), 'Link-Vorschau muss rel=noopener + target=_blank setzen');
  assert(/esc\(/.test(fn), 'User-Daten im Drawer müssen via esc() escaped werden');
  assert(!/\.innerHTML\s*=/.test(fn), 'Drawer darf innerHTML nicht zuweisen');
  // Aktion muss verdrahtet sein.
  assert(/action === 'item-details'/.test(source), 'wireListContentEvents muss die item-details-Aktion behandeln');
});

test('Detail-Refresh aktualisiert die Zeile, ohne das .shopping-item zu ersetzen (Swipe-Closures bleiben intakt)', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  // Hieß refreshItemMeta, solange der Dialog nur Link und Notiz bearbeiten konnte.
  // Seit Name, Menge und Kategorie editierbar sind (Critique 2026-07-30, P2), muss
  // die Zeile Name UND Menge mitziehen - die Funktion deckt beides ab.
  const fn = source.match(/function refreshItemName[\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'refreshItemName muss existieren');
  assert(!/#items-list/.test(fn), 'refreshItemName darf die Liste nicht neu aufbauen');
  assert(/list-row__name/.test(fn), 'der Name muss aktualisiert werden');
  assert(/list-row__meta/.test(fn), 'die Menge muss aktualisiert werden - sie kann auch wegfallen');
  // Ein Kategoriewechsel verschiebt die Zeile in eine andere Gruppe; das kann keine
  // Zeilen-Auffrischung leisten, dafür muss die Liste neu gruppiert werden.
  const details = source.match(/function openItemDetails[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert(/categoryChanged/.test(details), 'ein Kategoriewechsel muss die Gruppierung neu aufbauen');
});

// --------------------------------------------------------
// Route: notes/url-Validierung
// --------------------------------------------------------
test('shopping-Route validiert und persistiert notes/url', () => {
  const source = readFileSync(new URL('../server/routes/shopping.js', import.meta.url), 'utf8');
  assert(/import\s*\{[^}]*\burl\b[^}]*\}\s*from\s*'\.\.\/middleware\/validate\.js'/.test(source), 'Route muss den url()-Validator importieren');
  assert(/url\(req\.body\.url,\s*'URL'\)/.test(source), 'POST muss req.body.url über url() validieren');
  assert(/INSERT INTO shopping_items \(list_id, name, quantity, category, notes, url\)/.test(source), 'INSERT muss notes/url enthalten');
  assert(/SET is_checked = \?, name = \?, quantity = \?, category = \?, notes = \?, url = \?/.test(source), 'UPDATE muss notes/url enthalten');
});

test('shopping-Route bietet einen Datumsbereich-Import aus dem Essensplan an', () => {
  const source = readFileSync(new URL('../server/routes/shopping.js', import.meta.url), 'utf8');
  assert(/router\.post\('\/:listId\/import-meal-plan'/.test(source), 'Shopping-Route muss eine Import-Route für den Essensplan bereitstellen');
  assert(/aggregateMealIngredients/.test(source), 'Import-Route muss aggregierte Zutaten verwenden');
  assert(/m\.date BETWEEN \? AND \?/.test(source), 'Import-Route muss Mahlzeiten nach Datumsbereich filtern');
  assert(/mi\.on_shopping_list = 0/.test(source), 'Bereits übertragene Zutaten dürfen nicht erneut importiert werden');
});

// --------------------------------------------------------
// Kompakte Kategorien mit Auf-/Zuklappen (#1039)
//
// Verhaltensgetrieben (echte Speicher-/Umschaltfunktionen ueber `__test`)
// steht in test-shopping-ux.js; hier bleiben nur die echten Markup-/CSS-
// Vertraege, die keine Laufzeit brauchen.
// --------------------------------------------------------
test('Gruppenkopf ist eine echte Disclosure (h2 > button[aria-expanded])', () => {
  const source = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  assert(/<h2 class="list-group__title">[\s\S]{0,80}<button type="button" class="list-group__toggle" data-category-toggle=/.test(source),
    'die Kategorie-Ueberschrift muss ein h2 mit echtem Umschalt-Knopf sein (Tasks-Muster, #812)');
  assert(/aria-expanded="\$\{collapsed \? 'false' : 'true'\}" aria-controls=/.test(source),
    'der Knopf muss aria-expanded/aria-controls tragen');
  assert(/class="list-rows" id="\$\{rowsId\}" \$\{collapsed \? 'hidden' : ''\}/.test(source),
    'die Zeilen bleiben im DOM und werden nur per [hidden] gefaltet - kein Rerender, keine verlorenen Sortable-Instanzen');
});

test('Kompakte Zeile und engerer Gruppen-Rhythmus sind Shopping-only, nicht die geteilte Grammatik', () => {
  const css = readFileSync(new URL('../public/styles/shopping.css', import.meta.url), 'utf8');
  assert(/\.shopping-item\s*\{[^}]*padding-block:\s*0;/s.test(css),
    'die redundante Blockpolsterung (das Bedienelement traegt schon --target-lg) muss NUR im Einkauf entfallen');
  assert(/\.shopping-page \.list-scroller\s*\{\s*gap:\s*var\(--space-3\);\s*\}/.test(css),
    'der Gruppenabstand darf nur innerhalb von .shopping-page verengt werden, nicht app-weit');
  assert(/\.shopping-page \.list-group\s*\{\s*gap:\s*var\(--space-1\);\s*\}/.test(css),
    'der Kopf-zu-Fläche-Abstand darf nur innerhalb von .shopping-page verengt werden');

  const listRowCss = readFileSync(new URL('../public/styles/list-row.css', import.meta.url), 'utf8');
  assert(!/\.list-group\s*\{[^}]*gap:\s*var\(--space-1\)/s.test(listRowCss),
    'die geteilte .list-group-Regel muss ihren app-weiten Abstand behalten - die Abweichung gehoert nach shopping.css');
});

test('Der Listen-Scroller traegt einen duennen, getoenten Scrollbalken (#1039)', () => {
  const css = readFileSync(new URL('../public/styles/list-row.css', import.meta.url), 'utf8');
  assert(/\.list-scroller\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*var\(--module-accent\)\s*transparent;\s*\}/.test(css),
    'Firefox braucht scrollbar-width/scrollbar-color direkt an .list-scroller');
  assert(/\.list-scroller::-webkit-scrollbar\s*\{\s*width:\s*10px;\s*\}/.test(css),
    'WebKit/Chromium brauchen die eigene Pseudo-Element-Fassung');
  assert(/\.list-scroller::-webkit-scrollbar-thumb:hover/.test(css),
    'eine reine --tint-hint-Kante braucht laut tokens.css einen Hover-Bezug, sonst traegt sie nicht allein');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
console.log(`\n[Shopping-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
