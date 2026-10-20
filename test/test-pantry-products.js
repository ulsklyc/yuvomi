/**
 * Test: A household product above the stock batch (#1448, part 1)
 * Purpose: Migration 253 groups the existing batches into products by their
 *          own wording (trimmed, whitespace collapsed, case-insensitive, Unicode
 *          case included) and unit, with its own frozen grouping; the start of
 *          the server adopts batches an older version wrote without a product
 *          with the live grouping, and today both give the same products;
 *          every write path (create, full edit, partial PATCH, import from
 *          Shopping, demo seed) leaves no batch without a product; a renamed
 *          batch moves to another product and the old one stays.
 *
 *          The migration runs through the real runner on a database migrated
 *          to v249, as an existing installation runs the update. The routes are
 *          the real routers. The seed is the real script on a throwaway file.
 * Run: npm run test:pantry-products
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

const dbmod = await import('../server/db.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { productKey, assignPantryProduct } = await import('../server/services/pantry-products.js');
const db = dbmod.get();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = tempDir('yuvomi-pantry-products-');

// The real routers, for the write paths further down. Set up before the
// first test: a top-level await between the tests would let the runner finish
// the file early.
const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.authRole = 'member';
  req.session = { userId: USER, role: 'member' };
  next();
});
app.use('/pantry', pantryRouter);
app.use('/shopping', shoppingRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const productRow = (id) => db.prepare('SELECT * FROM pantry_products WHERE id = ?').get(id);
const productCount = () => db.prepare('SELECT COUNT(*) AS c FROM pantry_products').get().c;
const categories = db.prepare('SELECT name FROM shopping_categories ORDER BY sort_order').all().map((c) => c.name);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** A database migrated up to `version`, with one member who entered the stock. */
function databaseAt(version) {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  dbmod.migrate(fresh, dbmod.MIGRATIONS.filter((m) => m.version <= version));
  fresh.prepare(`INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'a', 'A', 'x'), (2, 'b', 'B', 'x')`).run();
  return fresh;
}

/**
 * The stock of a household before migration 253: one row per batch, the
 * wording as people typed it. `created_at`/`updated_at` are explicit, because
 * "most recently updated" and "oldest" decide name, category and author.
 */
const LEGACY_ROWS = [
  // id, name, unit, category, created_by, created_at, updated_at
  [1, 'Milch', 'l', 'Milchprodukte', 2, '2026-01-01T08:00:00Z', '2026-01-05T08:00:00Z'],
  [2, 'MILCH', 'l', 'Getränke', 1, '2026-01-03T08:00:00Z', '2026-02-01T08:00:00Z'],
  [3, 'milch', 'pcs', 'Milchprodukte', 1, '2026-01-02T08:00:00Z', '2026-01-02T08:00:00Z'],
  [4, 'Öl', 'bottle', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
  [5, 'öl', 'bottle', 'Sonstiges', 1, '2026-01-04T08:00:00Z', '2026-01-04T08:00:00Z'],
  [6, '  Reis   Basmati ', 'kg', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
  [7, 'reis basmati', 'kg', 'Sonstiges', 1, '2026-01-02T08:00:00Z', '2026-01-02T08:00:00Z'],
  [8, 'Salz', '', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
  [9, 'salz', '', 'Sonstiges', 1, '2026-01-02T08:00:00Z', '2026-01-02T08:00:00Z'],
  [10, 'Salz', 'pcs', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
  [11, '   ', 'pcs', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
  [12, '', 'pcs', 'Sonstiges', 1, '2026-01-01T08:00:00Z', '2026-01-01T08:00:00Z'],
];

function insertLegacyRows(database) {
  const insert = database.prepare(`
    INSERT INTO pantry_items (id, name, quantity, unit, category, created_by, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)
  `);
  for (const row of LEGACY_ROWS) insert.run(...row);
}

/** Batch id -> what its product says, for comparing two databases. */
function productOfEveryBatch(database) {
  return database.prepare(`
    SELECT pi.id AS batch, pp.name, pp.name_key, pp.unit, pp.category, pp.created_by, pp.created_at, pp.updated_at
    FROM pantry_items pi LEFT JOIN pantry_products pp ON pp.id = pi.product_id
    ORDER BY pi.id
  `).all();
}

const batchIdsByProduct = (database) => database.prepare(`
  SELECT product_id, group_concat(id) AS ids FROM (SELECT id, product_id FROM pantry_items ORDER BY id)
  GROUP BY product_id ORDER BY MIN(id)
`).all().map((r) => r.ids);

const nullProducts = (database) => database.prepare('SELECT COUNT(*) AS c FROM pantry_items WHERE product_id IS NULL').get().c;

// --------------------------------------------------------------------------
// The key
// --------------------------------------------------------------------------

test('productKey: the household wording, trimmed, collapsed, case-insensitive; nothing left -> no key', () => {
  assert.equal(productKey('  Reis \t  Basmati '), 'reis basmati');
  assert.equal(productKey('Öl'), 'öl');
  assert.equal(productKey('ÄPFEL'), 'äpfel');
  assert.equal(productKey('   '), null);
  assert.equal(productKey(''), null);
  assert.equal(productKey(null), null);
});

// --------------------------------------------------------------------------
// Migration 253
// --------------------------------------------------------------------------

test('migration 253 groups the existing batches by wording and unit', () => {
  const legacy = databaseAt(252);
  insertLegacyRows(legacy);
  // The trap a SQL backfill would fall into: SQLite folds ASCII only.
  assert.notEqual(legacy.prepare("SELECT lower('Öl') AS k").get().k, 'öl');

  dbmod.migrate(legacy, dbmod.MIGRATIONS);

  assert.equal(nullProducts(legacy), 0, 'every batch belongs to a product');
  assert.deepEqual(batchIdsByProduct(legacy), [
    '1,2',   // Milch / MILCH, l: case
    '3',     // milch, pcs: same name, other unit
    '4,5',   // Öl / öl: Unicode case
    '6,7',   // "  Reis   Basmati " / "reis basmati": whitespace
    '8,9',   // Salz / salz with an empty unit: the empty unit is a unit
    '10',    // Salz, pcs
    '11',    // a name with nothing left: a product of its own
    '12',    // the same, and NOT joined with 11
  ]);
  assert.equal(legacy.prepare('SELECT COUNT(*) AS c FROM pantry_products').get().c, 8);

  const milk = legacy.prepare(`SELECT * FROM pantry_products WHERE name_key = 'milch' AND unit = 'l'`).get();
  assert.equal(milk.name, 'MILCH', 'name of the most recently updated batch');
  assert.equal(milk.category, 'Getränke', 'category of the most recently updated batch');
  assert.equal(milk.created_by, 2, 'author of the oldest batch');
  assert.equal(milk.created_at, '2026-01-01T08:00:00Z', 'the product exists since its oldest batch');

  const unnamed = legacy.prepare('SELECT name_key FROM pantry_products WHERE id IN (SELECT product_id FROM pantry_items WHERE id IN (11, 12))').all();
  assert.deepEqual(unnamed.map((p) => p.name_key), [null, null]);

  // The entry carries its own grouping: nothing live is called from it.
  const entry = dbmod.MIGRATIONS.find((m) => m.version === 253);
  assert.doesNotMatch(String(entry.afterUp), /groupBatchesIntoProducts|productKey|ingredientMatchKey|assignPantryProduct/);
});

test('migration 253 leaves updated_at of every batch alone and puts the trigger back', () => {
  const legacy = databaseAt(252);
  insertLegacyRows(legacy);
  dbmod.migrate(legacy, dbmod.MIGRATIONS);

  const stamps = legacy.prepare('SELECT id, updated_at FROM pantry_items ORDER BY id').all();
  assert.deepEqual(stamps.map((r) => r.updated_at), LEGACY_ROWS.map((r) => r[6]));

  const triggers = legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pantry_items'`).all();
  assert.deepEqual(triggers.map((t) => t.name), ['trg_pantry_items_updated_at']);
  legacy.prepare('UPDATE pantry_items SET quantity = 2 WHERE id = 1').run();
  assert.notEqual(legacy.prepare('SELECT updated_at FROM pantry_items WHERE id = 1').get().updated_at, '2026-01-05T08:00:00Z');
});

test('pantry_products: unique per key and unit as stored, product_id cascades, the product keeps no minimum yet', () => {
  const columns = db.prepare('PRAGMA table_info(pantry_products)').all().map((c) => c.name);
  assert.deepEqual(columns, ['id', 'name', 'name_key', 'unit', 'category', 'created_by', 'created_at', 'updated_at']);

  const fk = db.prepare('PRAGMA foreign_key_list(pantry_items)').all().find((f) => f.from === 'product_id');
  assert.equal(fk.table, 'pantry_products');
  assert.equal(fk.on_delete, 'CASCADE');

  db.prepare(`INSERT INTO pantry_products (name, name_key, unit) VALUES ('Tee', 'tee', 'pkg')`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO pantry_products (name, name_key, unit) VALUES ('TEE', 'tee', 'pkg')`).run(),
    /UNIQUE/,
  );
  // The unit compares as stored: no folding of the unit.
  db.prepare(`INSERT INTO pantry_products (name, name_key, unit) VALUES ('Tee', 'tee', 'PKG')`).run();
  db.prepare(`DELETE FROM pantry_products WHERE name_key = 'tee'`).run();
});

// --------------------------------------------------------------------------
// The frozen grouping of migration 253 and the live grouping
// --------------------------------------------------------------------------

// Migration 253 carries its own frozen copy of key and grouping; the start of
// the server uses the live groupBatchesIntoProducts() with productKey. Today
// both must give the same products for the same rows. RED HERE MEANS the live
// grouping or ingredient-match-key.js changed. Do NOT touch migration 253: it
// stays what it did. Decide whether the change is meant; if the key changed,
// the stored name_key values follow the old rule and the writers would stop
// finding their products, which needs a migration of its own.
test('the frozen grouping of migration 253 and the live grouping agree today', () => {
  const migrated = databaseAt(252);
  insertLegacyRows(migrated);
  dbmod.migrate(migrated, dbmod.MIGRATIONS);

  // The same rows, written by an older version on an already migrated
  // database: product_id stays NULL, the start adopts them (live grouping).
  const newer = databaseAt(Infinity);
  insertLegacyRows(newer);
  assert.equal(nullProducts(newer), LEGACY_ROWS.length);

  dbmod.adoptOrphanPantryBatches(newer);

  // Same products (name, key, unit, category, author, timestamps) per batch,
  // same membership, same number of products.
  assert.deepEqual(productOfEveryBatch(newer), productOfEveryBatch(migrated));
  assert.deepEqual(batchIdsByProduct(newer), batchIdsByProduct(migrated));
  const count = (database) => database.prepare('SELECT COUNT(*) AS c FROM pantry_products').get().c;
  assert.equal(count(newer), count(migrated));

  // The frozen key and the runtime key agree on every stored name.
  for (const batch of migrated.prepare('SELECT pi.name, pp.name_key FROM pantry_items pi JOIN pantry_products pp ON pp.id = pi.product_id').all()) {
    assert.equal(batch.name_key, productKey(batch.name), `key of "${batch.name}"`);
  }
});

// --------------------------------------------------------------------------
// Adoption at start
// --------------------------------------------------------------------------

test('adoption joins an existing product, creates a missing one, and a second run changes nothing', () => {
  const database = databaseAt(Infinity);
  const milk = database.prepare(`INSERT INTO pantry_items (name, unit, category, created_by) VALUES ('Milch', 'l', 'Milchprodukte', 1)`).run().lastInsertRowid;
  const milkProduct = assignPantryProduct(database, milk, { userId: 1 });

  database.prepare(`
    INSERT INTO pantry_items (id, name, unit, category, created_by, created_at, updated_at) VALUES
      (100, ' MILCH ', 'l', 'Getränke', 2, '2026-03-01T08:00:00Z', '2026-03-02T08:00:00Z'),
      (101, 'Brot', 'pcs', 'Backwaren', 2, '2026-03-01T08:00:00Z', '2026-03-01T08:00:00Z')
  `).run();

  dbmod.adoptOrphanPantryBatches(database);

  assert.equal(nullProducts(database), 0);
  assert.equal(database.prepare('SELECT product_id FROM pantry_items WHERE id = 100').get().product_id, milkProduct);
  const kept = database.prepare('SELECT name, category FROM pantry_products WHERE id = ?').get(milkProduct);
  assert.deepEqual({ ...kept }, { name: 'Milch', category: 'Milchprodukte' }, 'an existing product is joined as it is');
  const bread = database.prepare('SELECT pp.name, pp.unit FROM pantry_items pi JOIN pantry_products pp ON pp.id = pi.product_id WHERE pi.id = 101').get();
  assert.deepEqual({ ...bread }, { name: 'Brot', unit: 'pcs' });
  assert.equal(database.prepare('SELECT updated_at FROM pantry_items WHERE id = 100').get().updated_at, '2026-03-02T08:00:00Z');

  const before = database.prepare('SELECT * FROM pantry_products ORDER BY id').all();
  const batchesBefore = database.prepare('SELECT * FROM pantry_items ORDER BY id').all();
  dbmod.adoptOrphanPantryBatches(database);
  assert.deepEqual(database.prepare('SELECT * FROM pantry_products ORDER BY id').all(), before);
  assert.deepEqual(database.prepare('SELECT * FROM pantry_items ORDER BY id').all(), batchesBefore);
});

test('adoption re-homes a batch whose name or unit no longer matches its product', () => {
  const database = databaseAt(Infinity);
  const insert = database.prepare('INSERT INTO pantry_items (name, unit, created_by) VALUES (?, ?, 1)');
  const milk = insert.run('Milch', 'l').lastInsertRowid;
  const tea = insert.run('Tee', 'pkg').lastInsertRowid;
  const coffee = insert.run('Kaffee', 'pkg').lastInsertRowid;
  const sugar = insert.run('Zucker', 'kg').lastInsertRowid;
  for (const id of [milk, tea, coffee, sugar]) assignPantryProduct(database, id, { userId: 1 });
  const productOf = (id) => database.prepare('SELECT product_id FROM pantry_items WHERE id = ?').get(id).product_id;
  const teaProduct = productOf(tea);
  const coffeeProduct = productOf(coffee);
  const sugarProduct = productOf(sugar);

  // What an older version does: it writes the batch and knows no product.
  database.prepare(`UPDATE pantry_items SET name = ' TEE' WHERE id = ?`).run(coffee);
  database.prepare(`UPDATE pantry_items SET unit = 'g' WHERE id = ?`).run(sugar);
  const milkBefore = database.prepare('SELECT * FROM pantry_items WHERE id = ?').get(milk);
  const coffeeStamp = database.prepare('SELECT updated_at FROM pantry_items WHERE id = ?').get(coffee).updated_at;

  dbmod.adoptOrphanPantryBatches(database);

  assert.equal(productOf(coffee), teaProduct, 'renamed to the wording of another product: it joins that one');
  assert.notEqual(productOf(sugar), sugarProduct, 'another unit: another product');
  assert.equal(database.prepare('SELECT unit FROM pantry_products WHERE id = ?').get(productOf(sugar)).unit, 'g');
  assert.ok(database.prepare('SELECT 1 FROM pantry_products WHERE id = ?').get(coffeeProduct), 'the product left behind stays');
  assert.ok(database.prepare('SELECT 1 FROM pantry_products WHERE id = ?').get(sugarProduct), 'the product left behind stays');
  assert.deepEqual(database.prepare('SELECT * FROM pantry_items WHERE id = ?').get(milk), milkBefore, 'a matching batch is untouched');
  assert.equal(database.prepare('SELECT updated_at FROM pantry_items WHERE id = ?').get(coffee).updated_at, coffeeStamp);

  const before = database.prepare('SELECT * FROM pantry_products ORDER BY id').all();
  const batchesBefore = database.prepare('SELECT * FROM pantry_items ORDER BY id').all();
  dbmod.adoptOrphanPantryBatches(database);
  assert.deepEqual(database.prepare('SELECT * FROM pantry_products ORDER BY id').all(), before);
  assert.deepEqual(database.prepare('SELECT * FROM pantry_items ORDER BY id').all(), batchesBefore);
});

test('init() adopts and re-homes what an older version left, and a second start does nothing', async () => {
  const dbPath = join(tmpDir, 'adopt.db');
  const file = new Database(dbPath);
  file.pragma('foreign_keys = ON');
  dbmod.migrate(file, dbmod.MIGRATIONS);
  file.prepare(`INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'a', 'A', 'x')`).run();
  const tea = file.prepare(`INSERT INTO pantry_items (name, unit, created_by) VALUES ('Tee', 'pkg', 1)`).run().lastInsertRowid;
  const milk = file.prepare(`INSERT INTO pantry_items (name, unit, created_by) VALUES ('Milch', 'l', 1)`).run().lastInsertRowid;
  assignPantryProduct(file, tea, { userId: 1 });
  assignPantryProduct(file, milk, { userId: 1 });
  file.prepare(`INSERT INTO pantry_items (name, unit, created_by) VALUES ('Kaffee', 'pkg', 1), ('kaffee', 'pkg', 1)`).run();
  file.prepare(`UPDATE pantry_items SET name = 'tee' WHERE id = ?`).run(milk);
  file.prepare(`UPDATE pantry_items SET unit = 'pkg' WHERE id = ?`).run(milk);
  file.close();

  const previous = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const snapshot = (conn) => ({
    products: conn.prepare('SELECT * FROM pantry_products ORDER BY id').all(),
    batches: conn.prepare('SELECT * FROM pantry_items ORDER BY id').all(),
  });
  try {
    const started = await import('../server/db.js?adopt-at-start');
    let conn = started.get();
    let after;
    try {
      assert.equal(nullProducts(conn), 0);
      assert.deepEqual(batchIdsByProduct(conn), ['1,2', '3,4'], 'the renamed batch joined the tea, the coffee got a product');
      assert.equal(conn.prepare(`SELECT COUNT(*) AS c FROM pantry_products WHERE name_key = 'milch'`).get().c, 1, 'the milk product stays');
      after = snapshot(conn);
    } finally {
      conn.close();
    }
    const again = await import('../server/db.js?adopt-at-second-start');
    conn = again.get();
    try {
      assert.deepEqual(snapshot(conn), after, 'a second start changes nothing');
    } finally {
      conn.close();
    }
  } finally {
    process.env.DB_PATH = previous;
  }
});

test('init() on a newer database (DB_ALLOW_NEWER_SCHEMA) leaves the batches alone', async () => {
  const dbPath = join(tmpDir, 'newer.db');
  const file = new Database(dbPath);
  dbmod.migrate(file, dbmod.MIGRATIONS);
  file.prepare(`INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'a', 'A', 'x')`).run();
  file.prepare(`INSERT INTO pantry_items (name, unit, created_by) VALUES ('Kakao', 'pkg', 1)`).run();
  file.prepare(`INSERT INTO schema_migrations (version, description) VALUES (999999, 'from a newer version')`).run();
  file.close();

  const previous = { path: process.env.DB_PATH, allow: process.env.DB_ALLOW_NEWER_SCHEMA };
  process.env.DB_PATH = dbPath;
  process.env.DB_ALLOW_NEWER_SCHEMA = '1';
  try {
    const started = await import('../server/db.js?adopt-on-newer');
    const conn = started.get();
    try {
      assert.equal(nullProducts(conn), 1, 'this build is the older one; its rules may be outdated');
    } finally {
      conn.close();
    }
  } finally {
    process.env.DB_PATH = previous.path;
    if (previous.allow === undefined) delete process.env.DB_ALLOW_NEWER_SCHEMA;
    else process.env.DB_ALLOW_NEWER_SCHEMA = previous.allow;
  }
});

// --------------------------------------------------------------------------
// Every write path
// --------------------------------------------------------------------------


test('create: a batch joins the product of its wording and unit, or a new one', async () => {
  const first = await call('POST', '/pantry', { name: 'Hafermilch', quantity: 1, unit: 'l' });
  assert.equal(first.status, 201);
  assert.ok(first.body.data.product_id, 'the response carries product_id');
  const product = productRow(first.body.data.product_id);
  assert.equal(product.name_key, 'hafermilch');
  assert.equal(product.unit, 'l');
  assert.equal(product.created_by, USER);

  const second = await call('POST', '/pantry', { name: '  HAFERMILCH ', quantity: 2, unit: 'l' });
  assert.equal(second.body.data.product_id, first.body.data.product_id, 'same wording, same unit: same product');

  const other = await call('POST', '/pantry', { name: 'Hafermilch', quantity: 2, unit: 'pcs' });
  assert.notEqual(other.body.data.product_id, first.body.data.product_id, 'another unit: another product');

  const list = await call('GET', '/pantry');
  assert.ok(list.body.data.every((item) => Number.isInteger(item.product_id)), 'GET carries product_id on every item');
});

test('PATCH: the stepper leaves the product alone, a rename moves the batch and the old product stays', async () => {
  const keep = await call('POST', '/pantry', { name: 'Joghurt', quantity: 1, unit: 'jar' });
  const moved = await call('POST', '/pantry', { name: 'Joghurt', quantity: 3, unit: 'jar' });
  const yoghurt = moved.body.data.product_id;
  assert.equal(keep.body.data.product_id, yoghurt);
  const productsBefore = productCount();

  const step = await call('PATCH', `/pantry/${moved.body.data.id}`, { quantity: 2 });
  assert.equal(step.body.data.product_id, yoghurt);
  assert.equal(productCount(), productsBefore, 'the stepper creates no product');

  const renamed = await call('PATCH', `/pantry/${moved.body.data.id}`, { name: 'Skyr' });
  assert.notEqual(renamed.body.data.product_id, yoghurt, 'renaming a batch moves it to another product');
  assert.equal(productRow(renamed.body.data.product_id).name_key, 'skyr');
  assert.ok(productRow(yoghurt), 'the product it left stays');

  const skyr = renamed.body.data.product_id;
  const unit = await call('PATCH', `/pantry/${moved.body.data.id}`, { unit: 'pcs' });
  assert.notEqual(unit.body.data.product_id, skyr, 'a unit change moves it too');
  assert.ok(productRow(skyr), 'a product outlives its last batch');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pantry_items WHERE product_id = ?').get(skyr).c, 0);

  const back = await call('PATCH', `/pantry/${moved.body.data.id}`, { name: 'joghurt', unit: 'jar' });
  assert.equal(back.body.data.product_id, yoghurt, 'back to the wording of an existing product: it joins that one');

  const category = categories.find((c) => c !== back.body.data.category);
  const recat = await call('PATCH', `/pantry/${moved.body.data.id}`, { category });
  assert.equal(recat.body.data.product_id, yoghurt);
  assert.equal(productRow(yoghurt).category, category, 'the category is written through to the product');
  assert.equal(productRow(yoghurt).name, 'Joghurt', 'a batch write does not rename the product');

  const caseOnly = await call('PATCH', `/pantry/${moved.body.data.id}`, { name: '  JOGHURT ' });
  assert.equal(caseOnly.body.data.product_id, yoghurt, 'a case or whitespace change keeps the batch in its product');
  assert.equal(productRow(yoghurt).name, 'Joghurt', 'and leaves the product name as it was');
});

test('PUT: a full edit moves the batch when name or unit change and keeps it otherwise', async () => {
  const created = await call('POST', '/pantry', { name: 'Mehl', quantity: 1, unit: 'kg' });
  const flour = created.body.data.product_id;
  const body = { ...created.body.data, quantity: 2 };

  const same = await call('PUT', `/pantry/${created.body.data.id}`, body);
  assert.equal(same.body.data.product_id, flour);

  const renamed = await call('PUT', `/pantry/${created.body.data.id}`, { ...body, name: 'Dinkelmehl' });
  assert.notEqual(renamed.body.data.product_id, flour);
  assert.ok(productRow(flour), 'the old product stays');
});

test('the category reaches the product only when a write changed it', async () => {
  const [first, second, third] = categories;
  const old = await call('POST', '/pantry', { name: 'Linsen', quantity: 1, unit: 'pkg', category: first });
  const fresh = await call('POST', '/pantry', { name: 'Linsen', quantity: 1, unit: 'pkg', category: second });
  const lentils = old.body.data.product_id;
  assert.equal(fresh.body.data.product_id, lentils);
  assert.equal(productRow(lentils).category, second, 'a new batch brings its category');

  // The edit form sends every field; only the expiry changed.
  const expiry = await call('PUT', `/pantry/${old.body.data.id}`, { ...old.body.data, expires_on: '2027-03-01' });
  assert.equal(expiry.status, 200);
  assert.equal(productRow(lentils).category, second, 'an expiry edit leaves the product category alone');

  await call('PATCH', `/pantry/${old.body.data.id}`, { category: first });
  assert.equal(productRow(lentils).category, second, 'a PATCH with the category the batch already has changes nothing');

  await call('PUT', `/pantry/${old.body.data.id}`, { ...old.body.data, category: third });
  assert.equal(productRow(lentils).category, third, 'an edit that changes the category writes it through');
});

test('import from Shopping: a new batch joins the product of its wording', async () => {
  const existing = await call('POST', '/pantry', { name: 'Butter', quantity: 1, unit: 'pcs', location_id: null });
  const list = await call('POST', '/shopping', { name: 'Produkte' });
  const listId = list.body.data.id;
  const butter = await call('POST', `/shopping/${listId}/items`, { name: 'BUTTER' });
  const tea = await call('POST', `/shopping/${listId}/items`, { name: 'Pfefferminztee' });
  await call('PATCH', `/shopping/items/${butter.body.data.id}`, { is_checked: 1 });
  await call('PATCH', `/shopping/items/${tea.body.data.id}`, { is_checked: 1 });

  const imported = await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [
      // Another best-before date: a new batch, the same product.
      { shopping_item_id: butter.body.data.id, quantity: 1, unit: 'pcs', expires_on: '2027-01-10' },
      { shopping_item_id: tea.body.data.id, quantity: 1, unit: 'pkg' },
    ],
  });
  assert.deepEqual(imported.body.data, { added: 2, merged: 0, skipped: 0 });

  const butterRows = db.prepare(`SELECT product_id FROM pantry_items WHERE name IN ('Butter', 'BUTTER')`).all();
  assert.equal(butterRows.length, 2);
  assert.ok(butterRows.every((r) => r.product_id === existing.body.data.product_id));
  const teaRow = db.prepare(`SELECT product_id FROM pantry_items WHERE name = 'Pfefferminztee'`).get();
  assert.equal(productRow(teaRow.product_id).name_key, 'pfefferminztee');
});

test('no write path left a batch without a product', () => {
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM pantry_items').get().c >= 8, 'the writes above reached the database');
  assert.equal(nullProducts(db), 0);
});

// --------------------------------------------------------------------------
// Demo seed
// --------------------------------------------------------------------------

test('the demo seed gives every batch its product and wipes the products with the stock', () => {
  const dbPath = join(tmpDir, 'seed.db');
  const file = new Database(dbPath);
  dbmod.migrate(file, dbmod.MIGRATIONS);
  file.close();

  const seed = () => {
    // Der Seed liest `.env` wie der Server (#2114); ein leerer Wert hält einen
    // Schlüssel aus einer lokalen `.env` von dieser unverschlüsselten Datei fern.
    const run = spawnSync(process.execPath, [resolve(ROOT, 'scripts/seed-demo.js'), '--db', dbPath], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, DB_ENCRYPTION_KEY: '' },
    });
    assert.equal(run.status, 0, `seed-demo.js failed:\n${run.stderr}`);
  };
  const read = () => {
    const conn = new Database(dbPath, { readonly: true });
    try {
      return {
        batches: conn.prepare('SELECT COUNT(*) AS c FROM pantry_items').get().c,
        orphans: nullProducts(conn),
        products: conn.prepare('SELECT COUNT(*) AS c FROM pantry_products').get().c,
        keys: conn.prepare('SELECT pi.name, pp.name_key FROM pantry_items pi JOIN pantry_products pp ON pp.id = pi.product_id').all(),
        empty: conn.prepare('SELECT COUNT(*) AS c FROM pantry_products pp WHERE NOT EXISTS (SELECT 1 FROM pantry_items pi WHERE pi.product_id = pp.id)').get().c,
      };
    } finally {
      conn.close();
    }
  };

  seed();
  const first = read();
  assert.ok(first.batches > 10);
  assert.equal(first.orphans, 0);
  for (const row of first.keys) assert.equal(row.name_key, productKey(row.name));

  // A product the household had before seeding again: the seed wipes it with
  // the stock, it does not leave it behind without batches.
  const conn = new Database(dbPath);
  conn.prepare(`INSERT INTO pantry_products (name, name_key, unit) VALUES ('Leftover', 'leftover', 'pcs')`).run();
  conn.close();

  seed();
  const second = read();
  assert.equal(second.products, first.products, 'a second seed does not pile up products');
  assert.equal(second.orphans, 0);
  assert.equal(second.empty, 0, 'every seeded product has a batch');
});
