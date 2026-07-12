/**
 * Modul: Kontakt-Kategorien-Test (#357)
 * Zweck: Migration (Seed mit Icons, DE-Namen→Keys, Orphan-Adoption) + CRUD-Routen
 *        inkl. Guards (in-use, letzte Kategorie), Slug-Vergabe, dynamische Validierung.
 * Ausführen: node --experimental-sqlite test/test-contact-categories.js
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

console.log('\n[Contact-Categories-Test] Migration + CRUD-Routen\n');

// --------------------------------------------------------
// 1) Migration-Transform (raw MIGRATIONS_SQL[1] + [84])
// --------------------------------------------------------
{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));`);
  db.exec(MIGRATIONS_SQL[1]);
  // Legacy-Kontakte VOR der Migration: deutsche Namen + ein freier Custom-Wert.
  db.prepare("INSERT INTO contacts (name, category) VALUES ('Dr. Meier', 'Arzt')").run();
  db.prepare("INSERT INTO contacts (name, category) VALUES ('Amt', 'Behörde')").run();
  db.prepare("INSERT INTO contacts (name, category) VALUES ('Nachbar', 'Nachbarschaft')").run();
  db.exec(MIGRATIONS_SQL[84]);

  test('Seed: 7 Bestands-Keys mit label_key + Icon, name NULL', () => {
    const rows = db.prepare('SELECT key, name, label_key, icon FROM contact_categories WHERE label_key IS NOT NULL ORDER BY sort_order').all();
    assert(rows.length === 7, `erwartet 7, war ${rows.length}`);
    assert(rows[0].key === 'doctor' && rows[0].icon === 'stethoscope', 'doctor mit stethoscope-Icon');
    assert(rows.every((r) => r.name === null), 'Seed-Kategorien tragen keinen name');
  });
  test('Migration: deutsche Namen → stabile Keys', () => {
    assert(db.prepare("SELECT category FROM contacts WHERE name = 'Dr. Meier'").get().category === 'doctor', 'Arzt → doctor');
    assert(db.prepare("SELECT category FROM contacts WHERE name = 'Amt'").get().category === 'authority', 'Behörde → authority');
  });
  test('Migration: freier Wert wird als Custom-Kategorie übernommen (Icon tag)', () => {
    const c = db.prepare("SELECT key, name, label_key, icon FROM contact_categories WHERE key = 'Nachbarschaft'").get();
    assert(c && c.name === 'Nachbarschaft' && c.label_key === null && c.icon === 'tag', 'Custom-Kategorie mit Default-Icon');
  });
  db.close();
}

// --------------------------------------------------------
// 2) CRUD-Routen (echte db.js + Express + fetch)
// --------------------------------------------------------
process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-contactcat-${process.pid}.db`);
process.env.SESSION_SECRET = 'contact-categories-test-secret-32bytes';
const db = await import('../server/db.js');
const { default: contactsRouter } = await import('../server/routes/contacts.js');
db.init();
const database = db.get();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; req.session = { userId: 1 }; next(); });
app.use('/contacts', contactsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/contacts`;
const jget = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const jsend = async (u, method, body) => {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await asyncTest('GET /categories liefert 7 Seed-Kategorien mit Icons', async () => {
    const { status, body } = await jget(`${base}/categories`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.length === 7, `erwartet 7, war ${body.data.length}`);
    assert(body.data.some((c) => c.key === 'doctor' && c.icon === 'stethoscope'), 'doctor-Icon vorhanden');
  });

  let customKey;
  await asyncTest('POST /categories erstellt Custom-Kategorie (Slug + Icon tag)', async () => {
    const { status, body } = await jsend(`${base}/categories`, 'POST', { name: 'Nachbarschaft' });
    assert(status === 201, `Status ${status}`);
    assert(body.data.key === 'nachbarschaft', `Slug erwartet nachbarschaft, war ${body.data.key}`);
    assert(body.data.icon === 'tag' && body.data.label_key === null, 'Default-Icon tag, kein label_key');
    customKey = body.data.key;
  });

  await asyncTest('POST /categories mit doppeltem Namen → 409', async () => {
    const { status } = await jsend(`${base}/categories`, 'POST', { name: 'Nachbarschaft' });
    assert(status === 409, `Status ${status}`);
  });

  await asyncTest('PUT benennt Seed-Kategorie um (name gesetzt, label_key gelöscht, Icon bleibt)', async () => {
    const { status, body } = await jsend(`${base}/categories/doctor`, 'PUT', { name: 'Ärzte' });
    assert(status === 200, `Status ${status}`);
    assert(body.data.name === 'Ärzte' && body.data.label_key === null, 'label_key muss NULL werden');
    assert(body.data.icon === 'stethoscope', 'Icon bleibt beim Umbenennen erhalten');
  });

  await asyncTest('PATCH /categories/reorder setzt sort_order', async () => {
    const keys = (await jget(`${base}/categories`)).body.data.map((c) => c.key);
    const reversed = [...keys].reverse();
    const { status } = await jsend(`${base}/categories/reorder`, 'PATCH', { order: reversed });
    assert(status === 200, `Status ${status}`);
    const after = (await jget(`${base}/categories`)).body.data.map((c) => c.key);
    assert(JSON.stringify(after) === JSON.stringify(reversed), 'Reihenfolge muss der Vorgabe folgen');
  });

  await asyncTest('Contact-Create validiert category dynamisch + Default misc', async () => {
    const ok = await jsend(`${base}`, 'POST', { name: 'Kontakt A', category: customKey });
    assert(ok.status === 201, `gültige Kategorie sollte 201 sein, war ${ok.status}`);
    const def = await jsend(`${base}`, 'POST', { name: 'Kontakt B' });
    assert(def.status === 201 && def.body.data.category === 'misc', 'ohne Angabe → misc');
    const bad = await jsend(`${base}`, 'POST', { name: 'Kontakt C', category: 'gibt_es_nicht' });
    assert(bad.status === 400, `unbekannte Kategorie sollte 400 sein, war ${bad.status}`);
  });

  await asyncTest('DELETE blockiert, wenn Kategorie in Benutzung → 409', async () => {
    // Kontakt A nutzt customKey (oben angelegt).
    const { status, body } = await jsend(`${base}/categories/${customKey}`, 'DELETE');
    assert(status === 409, `Status ${status}`);
    assert(body.count === 1, 'count meldet Referenzen');
    assert(body.reason === 'category_in_use', 'stabiler reason-Code für Client-Lokalisierung');
  });

  await asyncTest('DELETE erlaubt, wenn frei → 204', async () => {
    database.prepare('DELETE FROM contacts WHERE category = ?').run(customKey);
    const { status } = await jsend(`${base}/categories/${customKey}`, 'DELETE');
    assert(status === 204, `Status ${status}`);
  });

  await asyncTest('DELETE der letzten Kategorie → 409', async () => {
    database.prepare('DELETE FROM contacts').run();
    const keys = database.prepare('SELECT key FROM contact_categories').all().map((r) => r.key);
    for (const k of keys.slice(1)) database.prepare('DELETE FROM contact_categories WHERE key = ?').run(k);
    const { status } = await jsend(`${base}/categories/${keys[0]}`, 'DELETE');
    assert(status === 409, `Status ${status}`);
  });
} finally {
  server.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* egal */ }
}

console.log(`\n[Contact-Categories-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
