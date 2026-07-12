/**
 * Modul: Aufgaben-Kategorien-Test (#494, #357)
 * Zweck: Migration (Seed, Sonstiges→misc, Orphan-Adoption) + CRUD-Routen inkl.
 *        Guards (in-use, letzte Kategorie), Slug-Vergabe, dynamische Validierung.
 * Ausführen: node --experimental-sqlite test/test-task-categories.js
 */

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[Task-Categories-Test] Migration + CRUD-Routen\n');

// --------------------------------------------------------
// 1) Migration-Transform (raw MIGRATIONS_SQL[1] + [83])
// --------------------------------------------------------
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));`);
  db.exec(MIGRATIONS_SQL[1]);
  db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('u', 'U', 'x')").run();
  // Legacy-Aufgaben VOR der Migration: 'Sonstiges' + ein freier Custom-Wert.
  db.prepare("INSERT INTO tasks (title, category, created_by) VALUES ('a', 'Sonstiges', 1)").run();
  db.prepare("INSERT INTO tasks (title, category, created_by) VALUES ('b', 'household', 1)").run();
  db.prepare("INSERT INTO tasks (title, category, created_by) VALUES ('c', 'Garten', 1)").run();
  db.exec(MIGRATIONS_SQL[83]);

  test('Seed: 8 Bestands-Keys mit label_key, name NULL', () => {
    const rows = db.prepare('SELECT key, name, label_key FROM task_categories WHERE label_key IS NOT NULL ORDER BY sort_order').all();
    assert(rows.length === 8, `erwartet 8, war ${rows.length}`);
    assert(rows[0].key === 'household' && rows[0].label_key === 'tasks.categoryHousehold', 'household zuerst mit i18n-Key');
    assert(rows.every((r) => r.name === null), 'Seed-Kategorien tragen keinen name');
  });
  test('Migration: Sonstiges → misc', () => {
    assert(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE category = 'Sonstiges'").get().n === 0, 'kein Sonstiges mehr');
    assert(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE category = 'misc'").get().n === 1, 'ein Task auf misc');
  });
  test('Migration: freier Wert wird als Custom-Kategorie übernommen', () => {
    const g = db.prepare("SELECT key, name, label_key FROM task_categories WHERE key = 'Garten'").get();
    assert(g && g.name === 'Garten' && g.label_key === null, 'Garten als Custom-Kategorie (name gesetzt, kein label_key)');
  });
  db.close();
}

// --------------------------------------------------------
// 2) CRUD-Routen (echte db.js + Express + fetch)
// --------------------------------------------------------
process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-taskcat-${process.pid}.db`);
process.env.SESSION_SECRET = 'task-categories-test-secret-32bytes-long';
const db = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
db.init();
const database = db.get();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'admin')").run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; req.session = { userId: 1 }; next(); });
app.use('/tasks', tasksRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/tasks`;
const jget = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const jsend = async (u, method, body) => {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await asyncTest('GET /categories liefert die 8 Seed-Kategorien', async () => {
    const { status, body } = await jget(`${base}/categories`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.length === 8, `erwartet 8, war ${body.data.length}`);
    assert(body.data.some((c) => c.key === 'misc' && c.label_key === 'tasks.categoryMisc'), 'misc mit label_key');
  });

  let customKey;
  await asyncTest('POST /categories erstellt Custom-Kategorie mit Slug-Key', async () => {
    const { status, body } = await jsend(`${base}/categories`, 'POST', { name: 'Möbel & Deko' });
    assert(status === 201, `Status ${status}`);
    assert(body.data.key === 'mobel_deko', `Slug erwartet mobel_deko, war ${body.data.key}`);
    assert(body.data.name === 'Möbel & Deko' && body.data.label_key === null, 'name gesetzt, kein label_key');
    customKey = body.data.key;
  });

  await asyncTest('POST /categories mit doppeltem Namen → 409', async () => {
    const { status } = await jsend(`${base}/categories`, 'POST', { name: 'Möbel & Deko' });
    assert(status === 409, `Status ${status}`);
  });

  await asyncTest('POST /categories ohne Namen → 400', async () => {
    const { status } = await jsend(`${base}/categories`, 'POST', {});
    assert(status === 400, `Status ${status}`);
  });

  await asyncTest('PUT benennt Seed-Kategorie um (name gesetzt, label_key gelöscht)', async () => {
    const { status, body } = await jsend(`${base}/categories/misc`, 'PUT', { name: 'Diverses' });
    assert(status === 200, `Status ${status}`);
    assert(body.data.name === 'Diverses' && body.data.label_key === null, 'label_key muss NULL werden');
    // zurückbenennen für spätere Guard-Tests irrelevant; Key bleibt 'misc'
    assert(body.data.key === 'misc', 'Key bleibt stabil');
  });

  await asyncTest('PATCH /categories/reorder setzt sort_order', async () => {
    const keys = (await jget(`${base}/categories`)).body.data.map((c) => c.key);
    const reversed = [...keys].reverse();
    const { status } = await jsend(`${base}/categories/reorder`, 'PATCH', { order: reversed });
    assert(status === 200, `Status ${status}`);
    const after = (await jget(`${base}/categories`)).body.data.map((c) => c.key);
    assert(JSON.stringify(after) === JSON.stringify(reversed), 'Reihenfolge muss der Vorgabe folgen');
  });

  await asyncTest('DELETE blockiert, wenn Kategorie in Benutzung → 409', async () => {
    database.prepare("INSERT INTO tasks (title, category, created_by) VALUES ('x', ?, 1)").run(customKey);
    const { status, body } = await jsend(`${base}/categories/${customKey}`, 'DELETE');
    assert(status === 409, `Status ${status}`);
    assert(body.count === 1, 'count meldet die Anzahl der Referenzen');
    assert(body.reason === 'category_in_use', 'stabiler reason-Code für Client-Lokalisierung');
  });

  await asyncTest('DELETE erlaubt, wenn Kategorie frei ist → 204', async () => {
    database.prepare('DELETE FROM tasks WHERE category = ?').run(customKey);
    const { status } = await jsend(`${base}/categories/${customKey}`, 'DELETE');
    assert(status === 204, `Status ${status}`);
    assert(!database.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(customKey), 'Kategorie entfernt');
  });

  await asyncTest('DELETE der letzten Kategorie → 409', async () => {
    // Alle bis auf eine direkt entfernen (nicht referenziert), dann letzte via Route.
    database.prepare("DELETE FROM tasks").run();
    const keys = database.prepare('SELECT key FROM task_categories').all().map((r) => r.key);
    for (const k of keys.slice(1)) database.prepare('DELETE FROM task_categories WHERE key = ?').run(k);
    const { status, body } = await jsend(`${base}/categories/${keys[0]}`, 'DELETE');
    assert(status === 409, `Status ${status}`);
    assert(body.reason === 'category_last', 'stabiler reason-Code category_last');
  });

  await asyncTest('Task-Create validiert category dynamisch gegen die DB', async () => {
    const remaining = database.prepare('SELECT key FROM task_categories LIMIT 1').get().key;
    const ok = await jsend(`${base}`, 'POST', { title: 'T1', category: remaining });
    assert(ok.status === 201, `gültige Kategorie sollte 201 sein, war ${ok.status}`);
    const bad = await jsend(`${base}`, 'POST', { title: 'T2', category: 'gibt_es_nicht' });
    assert(bad.status === 400, `unbekannte Kategorie sollte 400 sein, war ${bad.status}`);
  });
} finally {
  server.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* egal */ }
}

console.log(`\n[Task-Categories-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
