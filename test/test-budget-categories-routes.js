/**
 * Test: Budget-Kategorien-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten budget/categories-Router - härtet die bislang
 *        ungetestete CRUD-Route-Schicht für Kategorien und Subkategorien ab.
 *        Fokus: Validierung (400: Name-Pflicht, Typ-oneOf), Dubletten (409, NOCASE,
 *        typ-/kategorie-scoped), Nicht-gefunden (404), Schutz-Sperren (409 in-use via
 *        budget_entries, 409 letzte Kategorie/Subkategorie), Reihenfolge, sowie die
 *        Lese-Endpunkte (meta, lokalisierte Liste mit genesteten Subkategorien).
 *        Migration 88 legte KEINE visibility auf Kategorien → kein Auth-Gate-Teil.
 * Ausführen: node --experimental-sqlite --test test/test-budget-categories-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: catRouter } = await import('../server/routes/budget/categories.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;

let actor = { id: U, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', catRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

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

async function newCategory(name, type = 'expense') {
  const r = await call('POST', '/categories', { name, type });
  return r.body.data;
}

function useEntry(categoryKey, subcategoryKey = '') {
  db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by) VALUES ('E', -5, ?, ?, '2026-06-01', ?)`)
    .run(categoryKey, subcategoryKey ?? '', U);
}

// --------------------------------------------------------------------------
// Lese-Endpunkte
// --------------------------------------------------------------------------
test('GET /meta: liefert Kategorie-Buckets', async () => {
  const r = await call('GET', '/meta');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.categories));
  assert.ok(Array.isArray(r.body.data.expenseCategories));
  assert.ok(Array.isArray(r.body.data.incomeCategories));
  assert.equal(typeof r.body.data.expenseSubcategories, 'object');
});

test('GET /categories: lokalisierte Liste mit genesteten Subkategorien + lang', async () => {
  const r = await call('GET', '/categories?lang=de');
  assert.equal(r.status, 200);
  assert.equal(r.body.lang, 'de');
  assert.ok(r.body.data.length > 0);
  const withSub = r.body.data.find((c) => Array.isArray(c.subcategories));
  assert.ok(withSub, 'jede Kategorie trägt ein subcategories-Array');
  assert.ok('label' in r.body.data[0], 'lokalisiertes label ergänzt');
});

test('GET /categories: unbekannte Sprache fällt auf en zurück', async () => {
  const r = await call('GET', '/categories?lang=xx');
  assert.equal(r.body.lang, 'en');
});

test('GET /categories/:key/subcategories: unbekannte Kategorie → 404', async () => {
  const r = await call('GET', '/categories/does-not-exist/subcategories');
  assert.equal(r.status, 404);
});

// --------------------------------------------------------------------------
// POST /categories
// --------------------------------------------------------------------------
test('POST /categories: leerer Name → 400', async () => {
  const r = await call('POST', '/categories', { name: '' });
  assert.equal(r.status, 400);
});

test('POST /categories: ungültiger Typ → 400', async () => {
  const r = await call('POST', '/categories', { name: 'X', type: 'asset' });
  assert.equal(r.status, 400);
});

test('POST /categories: legt Kategorie an (Default-Typ expense, sort_order max+1)', async () => {
  const maxBefore = db.prepare(`SELECT COALESCE(MAX(sort_order),-1) m FROM budget_categories WHERE type='expense'`).get().m;
  const r = await call('POST', '/categories', { name: 'Hobby' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.type, 'expense');
  assert.equal(r.body.data.sort_order, maxBefore + 1);
});

test('POST /categories: Dublette (NOCASE, gleicher Typ) → 409', async () => {
  await newCategory('DupCat', 'expense');
  const r = await call('POST', '/categories', { name: 'dupcat', type: 'expense' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'category_exists');
});

test('POST /categories: gleicher Name in anderem Typ ist erlaubt', async () => {
  await newCategory('CrossType', 'expense');
  const r = await call('POST', '/categories', { name: 'CrossType', type: 'income' });
  assert.equal(r.status, 201);
});

// --------------------------------------------------------------------------
// PUT /categories/:key
// --------------------------------------------------------------------------
test('PUT /categories/:key: unbekannt → 404', async () => {
  const r = await call('PUT', '/categories/nope', { name: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /categories/:key: leerer Name → 400', async () => {
  const cat = await newCategory('RenameMe');
  const r = await call('PUT', `/categories/${cat.key}`, { name: '' });
  assert.equal(r.status, 400);
});

test('PUT /categories/:key: Namenskonflikt → 409', async () => {
  const a = await newCategory('PutA');
  await newCategory('PutB');
  const r = await call('PUT', `/categories/${a.key}`, { name: 'PutB' });
  assert.equal(r.status, 409);
});

test('PUT /categories/:key: benennt um', async () => {
  const cat = await newCategory('OldName');
  const r = await call('PUT', `/categories/${cat.key}`, { name: 'NewName' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'NewName');
});

// --------------------------------------------------------------------------
// DELETE /categories/:key
// --------------------------------------------------------------------------
test('DELETE /categories/:key: unbekannt → 404', async () => {
  const r = await call('DELETE', '/categories/nope');
  assert.equal(r.status, 404);
});

test('DELETE /categories/:key: in Benutzung → 409 (count)', async () => {
  const cat = await newCategory('InUseCat');
  useEntry(cat.key);
  const r = await call('DELETE', `/categories/${cat.key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'category_in_use');
  assert.equal(r.body.count, 1);
});

test('DELETE /categories/:key: mit Subkategorien → 409', async () => {
  const cat = await newCategory('HasSubsCat');
  await call('POST', `/categories/${cat.key}/subcategories`, { name: 'Child' });
  const r = await call('DELETE', `/categories/${cat.key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'category_has_subcategories');
});

test('DELETE /categories/:key: löscht ungenutzte Kategorie (204)', async () => {
  const cat = await newCategory('DeleteMe');
  const r = await call('DELETE', `/categories/${cat.key}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM budget_categories WHERE key = ?').get(cat.key).c, 0);
});

// --------------------------------------------------------------------------
// PATCH /categories/reorder
// --------------------------------------------------------------------------
test('PATCH /categories/reorder: ungültiger Typ → 400', async () => {
  const r = await call('PATCH', '/categories/reorder', { type: 'asset', order: [] });
  assert.equal(r.status, 400);
});

test('PATCH /categories/reorder: setzt sort_order gemäß Reihenfolge', async () => {
  const a = await newCategory('OrderA');
  const b = await newCategory('OrderB');
  const r = await call('PATCH', '/categories/reorder', { type: 'expense', order: [b.key, a.key] });
  assert.equal(r.status, 200);
  const oa = db.prepare('SELECT sort_order FROM budget_categories WHERE key = ?').get(a.key).sort_order;
  const ob = db.prepare('SELECT sort_order FROM budget_categories WHERE key = ?').get(b.key).sort_order;
  assert.equal(ob, 0);
  assert.equal(oa, 1);
});

// --------------------------------------------------------------------------
// Subkategorien
// --------------------------------------------------------------------------
test('POST subcategories: unbekannte Kategorie → 404', async () => {
  const r = await call('POST', '/categories/nope/subcategories', { name: 'S' });
  assert.equal(r.status, 404);
});

test('POST subcategories: income-Kategorie erlaubt keine Subkategorie → 404', async () => {
  const inc = await newCategory('IncCat', 'income');
  const r = await call('POST', `/categories/${inc.key}/subcategories`, { name: 'S' });
  assert.equal(r.status, 404);
});

test('POST subcategories: leerer Name → 400', async () => {
  const cat = await newCategory('SubParent1');
  const r = await call('POST', `/categories/${cat.key}/subcategories`, { name: '' });
  assert.equal(r.status, 400);
});

test('POST subcategories: legt an; Dublette → 409', async () => {
  const cat = await newCategory('SubParent2');
  const r1 = await call('POST', `/categories/${cat.key}/subcategories`, { name: 'Sub' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.data.category_key, cat.key);
  const r2 = await call('POST', `/categories/${cat.key}/subcategories`, { name: 'sub' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.reason, 'subcategory_exists');
});

test('PUT subcategory: unbekannt → 404', async () => {
  const cat = await newCategory('SubParent3');
  const r = await call('PUT', `/categories/${cat.key}/subcategories/nope`, { name: 'X' });
  assert.equal(r.status, 404);
});

test('PUT subcategory: Namenskonflikt → 409', async () => {
  const cat = await newCategory('SubParent4');
  const a = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'SA' })).body.data;
  await call('POST', `/categories/${cat.key}/subcategories`, { name: 'SB' });
  const r = await call('PUT', `/categories/${cat.key}/subcategories/${a.key}`, { name: 'SB' });
  assert.equal(r.status, 409);
});

test('PUT subcategory: benennt um', async () => {
  const cat = await newCategory('SubParent5');
  const s = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'S1' })).body.data;
  const r = await call('PUT', `/categories/${cat.key}/subcategories/${s.key}`, { name: 'S1neu' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'S1neu');
});

test('DELETE subcategory: unbekannt → 404', async () => {
  const cat = await newCategory('SubParent6');
  const r = await call('DELETE', `/categories/${cat.key}/subcategories/nope`);
  assert.equal(r.status, 404);
});

test('DELETE subcategory: letzte Subkategorie → 409', async () => {
  const cat = await newCategory('SubParent7');
  const s = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'Einzig' })).body.data;
  const r = await call('DELETE', `/categories/${cat.key}/subcategories/${s.key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'subcategory_last');
});

test('DELETE subcategory: in Benutzung → 409', async () => {
  const cat = await newCategory('SubParent8');
  const keep = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'Behalten' })).body.data;
  const used = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'Benutzt' })).body.data;
  useEntry(cat.key, used.key);
  const r = await call('DELETE', `/categories/${cat.key}/subcategories/${used.key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'subcategory_in_use');
  assert.equal(r.body.count, 1);
  assert.ok(keep, 'zweite Subkategorie verhindert last-Sperre vor in-use-Prüfung');
});

test('DELETE subcategory: löscht ungenutzte (204)', async () => {
  const cat = await newCategory('SubParent9');
  const a = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'A' })).body.data;
  await call('POST', `/categories/${cat.key}/subcategories`, { name: 'B' }); // damit A nicht letzte ist
  const r = await call('DELETE', `/categories/${cat.key}/subcategories/${a.key}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM budget_subcategories WHERE key = ?').get(a.key).c, 0);
});

test('PATCH subcategory reorder: setzt sort_order gemäß Reihenfolge', async () => {
  const cat = await newCategory('SubParent10');
  const a = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'RA' })).body.data;
  const b = (await call('POST', `/categories/${cat.key}/subcategories`, { name: 'RB' })).body.data;
  const r = await call('PATCH', `/categories/${cat.key}/subcategories/reorder`, { order: [b.key, a.key] });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT sort_order FROM budget_subcategories WHERE key = ?').get(b.key).sort_order, 0);
  assert.equal(db.prepare('SELECT sort_order FROM budget_subcategories WHERE key = ?').get(a.key).sort_order, 1);
});

// --------------------------------------------------------------------------
// Letzte-Kategorie-Sperre (destruktiv für income → als Letztes)
// --------------------------------------------------------------------------
test('DELETE /categories/:key: letzte Kategorie eines Typs → 409', async () => {
  // alle income-Kategorien bis auf eine entfernen (in fresh :memory: keine in Benutzung)
  let income = (await call('GET', '/categories?lang=en')).body.data.filter((c) => c.type === 'income');
  for (const c of income.slice(1)) {
    await call('DELETE', `/categories/${c.key}`);
  }
  income = (await call('GET', '/categories?lang=en')).body.data.filter((c) => c.type === 'income');
  assert.equal(income.length, 1, 'genau eine income-Kategorie übrig');
  const r = await call('DELETE', `/categories/${income[0].key}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'category_last');
});

test.after(() => server.close());
