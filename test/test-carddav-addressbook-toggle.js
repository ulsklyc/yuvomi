/**
 * Modul: CardDAV-Adressbuch-Umschaltung (#534)
 * Zweck: Pinnt den Vertrag zwischen Settings-Seite und cardav-Router. Der Bug war eine
 *        Route-Diskrepanz: das Frontend rief POST /accounts/:id/addressbooks/toggle
 *        (existiert nicht → HTTP 404), während der Router PUT /addressbooks/:id anbietet.
 *        Zusätzlich: unbekannte Adressbuch-ID → 404 statt 500, und die Leseliste liefert
 *        `name` (nicht `display_name`), worauf das Frontend zugreifen muss.
 * Ausführen: node --experimental-sqlite test/test-carddav-addressbook-toggle.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

let passed = 0, failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[CardDAV-Adressbuch-Toggle] Frontend↔Router-Vertrag (#534)\n');

const here = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(path.join(here, '..', 'public/settings/pages/sync-contacts.js'), 'utf8');
const routerSrc = readFileSync(path.join(here, '..', 'server/routes/cardav.js'), 'utf8');

process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-cardav-toggle-${process.pid}.db`);
process.env.SESSION_SECRET = 'cardav-toggle-test-secret-32bytes-long';

const db = await import('../server/db.js');
const { default: cardavRouter } = await import('../server/routes/cardav.js');
db.init();
const database = db.get();

const accountId = database.prepare(`
  INSERT INTO carddav_accounts (name, carddav_url, username, password)
  VALUES ('Test-Konto', 'https://dav.example.com/', 'user', 'secret')
`).run().lastInsertRowid;

const insertAb = database.prepare(`
  INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
  VALUES (?, ?, ?, 1)
`);
const personalId = insertAb.run(accountId, 'https://dav.example.com/Contacts/personal/', 'Personal').lastInsertRowid;
const sharedId = insertAb.run(accountId, 'https://dav.example.com/Contacts/shared/', 'Shared').lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; req.session = { userId: 1 }; next(); });
app.use('/contacts/cardav', cardavRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/contacts/cardav`;

const jget = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const jsend = async (u, method, body) => {
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const enabledOf = (id) => database
  .prepare('SELECT enabled FROM carddav_addressbook_selection WHERE id = ?')
  .get(id).enabled;

try {
  // ------------------------------------------------------------------
  // Regression #534: die Seite darf nur existierende Routen aufrufen
  // ------------------------------------------------------------------
  await asyncTest('sync-contacts.js ruft keine /addressbooks/toggle-Route auf (#534)', () => {
    assert(!pageSrc.includes('addressbooks/toggle'), 'toter Endpunkt /addressbooks/toggle wieder verdrahtet');
  });

  await asyncTest('sync-contacts.js schaltet per PUT /contacts/cardav/addressbooks/:id um', () => {
    assert(
      /api\.put\(`\/contacts\/cardav\/addressbooks\/\$\{ab\.id\}`/.test(pageSrc),
      'PUT auf /contacts/cardav/addressbooks/${ab.id} fehlt',
    );
    assert(/router\.put\('\/addressbooks\/:id'/.test(routerSrc), 'Router-Gegenstück PUT /addressbooks/:id fehlt');
  });

  await asyncTest('sync-contacts.js liest den vom Router gelieferten Feldnamen `name`', () => {
    assert(!pageSrc.includes('ab.display_name'), 'display_name existiert in der Antwort nicht');
    assert(pageSrc.includes('ab.name || ab.url'), 'Anzeige fällt nicht von name auf url zurück');
  });

  await asyncTest('sync-contacts.js hängt den vollen Namen als title an (Ellipse)', () => {
    assert(/name\.title = ab\.name \? /.test(pageSrc), 'title-Attribut fehlt');
  });

  await asyncTest('sync-contacts.js liest die camelCase-Kontofelder der API', () => {
    assert(!/account\.cardav_url|account\.last_sync/.test(pageSrc), 'snake_case-Felder liefert die API nicht');
    assert(pageSrc.includes('account.cardavUrl'), 'cardavUrl wird nicht gelesen');
    assert(pageSrc.includes('account.lastSync'), 'lastSync wird nicht gelesen');
  });

  await asyncTest('GET /accounts liefert cardavUrl und lastSync', async () => {
    const { status, body } = await jget(`${base}/accounts`);
    assert(status === 200, `Status ${status}`);
    const acc = body.data.find((a) => a.id === accountId);
    assert(acc, 'Testkonto nicht in der Liste');
    assert('cardavUrl' in acc && 'lastSync' in acc, 'cardavUrl/lastSync fehlen');
    assert(!('password' in acc), 'Passwort darf nicht ausgeliefert werden');
  });

  // ------------------------------------------------------------------
  // Leseliste: Feldvertrag (id/url/name/enabled)
  // ------------------------------------------------------------------
  await asyncTest('GET /accounts/:id/addressbooks liefert id, url, name, enabled', async () => {
    const { status, body } = await jget(`${base}/accounts/${accountId}/addressbooks`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.length === 2, `2 Adressbücher erwartet, ${body.data.length} erhalten`);
    for (const ab of body.data) {
      for (const key of ['id', 'url', 'name', 'enabled']) {
        assert(key in ab, `Feld ${key} fehlt`);
      }
    }
  });

  // ------------------------------------------------------------------
  // Toggle-Verhalten
  // ------------------------------------------------------------------
  await asyncTest('PUT /addressbooks/:id { enabled: false } deaktiviert genau ein Adressbuch', async () => {
    const { status, body } = await jsend(`${base}/addressbooks/${personalId}`, 'PUT', { enabled: false });
    assert(status === 200, `Status ${status}`);
    assert(body.data.enabled === false, 'Antwort meldet enabled=false');
    assert(enabledOf(personalId) === 0, 'personal ist deaktiviert');
    assert(enabledOf(sharedId) === 1, 'shared bleibt unangetastet');
  });

  await asyncTest('PUT /addressbooks/:id { enabled: true } aktiviert wieder', async () => {
    const { status } = await jsend(`${base}/addressbooks/${personalId}`, 'PUT', { enabled: true });
    assert(status === 200, `Status ${status}`);
    assert(enabledOf(personalId) === 1, 'personal ist wieder aktiv');
  });

  await asyncTest('PUT /addressbooks/:id ohne enabled → 400', async () => {
    const { status } = await jsend(`${base}/addressbooks/${personalId}`, 'PUT', {});
    assert(status === 400, `Status ${status}`);
  });

  await asyncTest('PUT /addressbooks/:id für unbekannte ID → 404 (nicht 500)', async () => {
    const { status } = await jsend(`${base}/addressbooks/999999`, 'PUT', { enabled: false });
    assert(status === 404, `Status ${status}`);
  });
} finally {
  server.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* egal */ }
}

console.log(`\n[CardDAV-Adressbuch-Toggle] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
