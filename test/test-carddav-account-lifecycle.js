/**
 * Modul: CardDAV-Konto-Lebenszyklus (Critique-Nachlauf zu #534)
 * Zweck: Drei Lücken, die das Design-Review aufgedeckt hat:
 *        1. Sync-Teilfehler landeten nur im Server-Log - jetzt an `last_error`
 *           am Konto, damit die Karte sie zeigen kann.
 *        2. Es gab kein PUT auf Konten: ein rotiertes Passwort bedeutete löschen
 *           und neu anlegen, samt Verlust der Adressbuch-Auswahl.
 *        3. Sammelschalter „alle an/aus" fährt über dieselbe Toggle-Route.
 * Ausführen: node --experimental-sqlite test/test-carddav-account-lifecycle.js
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

console.log('\n[CardDAV-Konto-Lebenszyklus] Bearbeiten, Sammelschalter, sichtbare Sync-Fehler\n');

const here = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(path.join(here, '..', 'public/settings/pages/sync-contacts.js'), 'utf8');
const serviceSrc = readFileSync(path.join(here, '..', 'server/services/cardav-sync.js'), 'utf8');

process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-cardav-lifecycle-${process.pid}.db`);
process.env.SESSION_SECRET = 'cardav-lifecycle-test-secret-32bytes';

const db = await import('../server/db.js');
const CardDAVSync = await import('../server/services/cardav-sync.js');
const { default: cardavRouter } = await import('../server/routes/cardav.js');
db.init();
const database = db.get();

const mkAccount = (name, url, user) => database.prepare(`
  INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES (?, ?, ?, 'geheim')
`).run(name, url, user).lastInsertRowid;

const accountId = mkAccount('SOGo Familie', 'https://dav.example.com/Contacts/', 'demo');
const otherId = mkAccount('Nextcloud', 'https://cloud.example.org/dav/', 'demo2');

const insertAb = database.prepare(`
  INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
  VALUES (?, ?, ?, ?)
`);
const abIds = [
  insertAb.run(accountId, 'https://dav.example.com/Contacts/a/', 'Familie', 1).lastInsertRowid,
  insertAb.run(accountId, 'https://dav.example.com/Contacts/b/', 'Verein', 0).lastInsertRowid,
  insertAb.run(accountId, 'https://dav.example.com/Contacts/c/', 'Arbeit', 0).lastInsertRowid,
];

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
const row = (id) => database.prepare('SELECT * FROM carddav_accounts WHERE id = ?').get(id);
const enabledCount = (id) => database
  .prepare('SELECT COUNT(*) c FROM carddav_addressbook_selection WHERE account_id = ? AND enabled = 1')
  .get(id).c;

try {
  // ------------------------------------------------------------------
  // Migration 92: Fehlerspalten am Konto
  // ------------------------------------------------------------------
  await asyncTest('carddav_accounts trägt last_error und last_error_at (Migration 92)', () => {
    const cols = database.prepare('PRAGMA table_info(carddav_accounts)').all().map((c) => c.name);
    assert(cols.includes('last_error'), 'last_error fehlt');
    assert(cols.includes('last_error_at'), 'last_error_at fehlt');
  });

  await asyncTest('GET /accounts liefert lastError und lastErrorAt, aber kein Passwort', async () => {
    database.prepare('UPDATE carddav_accounts SET last_error = ?, last_error_at = ? WHERE id = ?')
      .run('Verein: 501 Not Implemented', '2026-07-19T09:10:22Z', accountId);
    const { status, body } = await jget(`${base}/accounts`);
    assert(status === 200, `Status ${status}`);
    const acc = body.data.find((a) => a.id === accountId);
    assert(acc.lastError === 'Verein: 501 Not Implemented', `lastError: ${acc.lastError}`);
    assert(acc.lastErrorAt === '2026-07-19T09:10:22Z', 'lastErrorAt fehlt');
    assert(!('password' in acc), 'Passwort darf nicht ausgeliefert werden');
  });

  await asyncTest('Der Sync-Service reicht die Fehlermeldung des Adressbuchs weiter', () => {
    // Die Meldung muss den Abruf-Fehler verlassen, sonst kann sie niemand zeigen.
    assert(/errorMessage: `\$\{label\}: \$\{err\.message\}`/.test(serviceSrc), 'errorMessage wird nicht zurückgegeben');
    assert(/recordSyncOutcome\(accountId, failures\)/.test(serviceSrc), 'Teilfehler werden nicht festgehalten');
    assert(/recordSyncOutcome\(accountId, \[err\.message\]\)/.test(serviceSrc), 'Totalausfall wird nicht festgehalten');
  });

  await asyncTest('Ein sauberer Lauf löscht die Fehlermeldung wieder', () => {
    // NULL ist die Aussage „zuletzt lief alles durch" und muss aktiv gesetzt werden.
    assert(row(accountId).last_error !== null, 'Vorbedingung: Fehler steht');
    const src = serviceSrc.match(/function recordSyncOutcome[\s\S]*?\n}/)[0];
    assert(/failures\.length[\s\S]*?: null/.test(src), 'leere Fehlerliste schreibt nicht NULL');
  });

  // ------------------------------------------------------------------
  // PUT /accounts/:id - Bearbeiten statt Löschen-und-neu-Anlegen
  // ------------------------------------------------------------------
  await asyncTest('PUT /accounts/:id ändert Name, URL und Benutzer', async () => {
    const { status, body } = await jsend(`${base}/accounts/${accountId}`, 'PUT', {
      name: 'SOGo Haushalt', cardavUrl: 'https://dav.example.com/Contacts2/', username: 'demo-neu',
    });
    assert(status === 200, `Status ${status}`);
    assert(body.data.name === 'SOGo Haushalt', 'Name nicht übernommen');
    assert(body.data.cardavUrl === 'https://dav.example.com/Contacts2/', 'URL nicht übernommen');
    assert(!('password' in body.data), 'Passwort darf nicht in der Antwort stehen');
  });

  await asyncTest('Die Adressbuch-Auswahl überlebt das Bearbeiten', () => {
    const abs = database.prepare('SELECT id, enabled FROM carddav_addressbook_selection WHERE account_id = ? ORDER BY id').all(accountId);
    assert(abs.length === 3, `3 Adressbücher erwartet, ${abs.length} vorhanden`);
    assert(abs[0].enabled === 1 && abs[1].enabled === 0, 'Auswahl verändert');
  });

  await asyncTest('Leeres Passwort lässt das gespeicherte unberührt', async () => {
    const { status } = await jsend(`${base}/accounts/${accountId}`, 'PUT', {
      name: 'SOGo Haushalt', cardavUrl: 'https://dav.example.com/Contacts2/', username: 'demo-neu', password: '   ',
    });
    assert(status === 200, `Status ${status}`);
    assert(row(accountId).password === 'geheim', 'Passwort wurde überschrieben');
  });

  await asyncTest('Neues Passwort wird gesetzt und macht den alten Fehler gegenstandslos', async () => {
    database.prepare('UPDATE carddav_accounts SET last_error = ? WHERE id = ?').run('alter Fehler', accountId);
    const { status } = await jsend(`${base}/accounts/${accountId}`, 'PUT', {
      name: 'SOGo Haushalt', cardavUrl: 'https://dav.example.com/Contacts2/', username: 'demo-neu', password: 'neues-passwort',
    });
    assert(status === 200, `Status ${status}`);
    assert(row(accountId).password === 'neues-passwort', 'Passwort nicht gesetzt');
    assert(row(accountId).last_error === null, 'alter Fehler blieb stehen');
  });

  await asyncTest('Kollidierende URL+Benutzer → 409, Bestand unverändert', async () => {
    const { status } = await jsend(`${base}/accounts/${otherId}`, 'PUT', {
      name: 'Nextcloud', cardavUrl: 'https://dav.example.com/Contacts2/', username: 'demo-neu',
    });
    assert(status === 409, `Status ${status}`);
    assert(row(otherId).carddav_url === 'https://cloud.example.org/dav/', 'Konto wurde trotz Konflikt geändert');
  });

  await asyncTest('PUT auf unbekanntes Konto → 404, leerer Name → 400', async () => {
    assert((await jsend(`${base}/accounts/999999`, 'PUT', { name: 'X', cardavUrl: 'https://x/', username: 'u' })).status === 404, '404 erwartet');
    assert((await jsend(`${base}/accounts/${accountId}`, 'PUT', { name: '', cardavUrl: 'https://x/', username: 'u' })).status === 400, '400 erwartet');
  });

  // ------------------------------------------------------------------
  // Sammelschalter: fährt über die bestehende Toggle-Route
  // ------------------------------------------------------------------
  await asyncTest('Alle aktivieren/deaktivieren über PUT /addressbooks/:id', async () => {
    for (const id of abIds) await jsend(`${base}/addressbooks/${id}`, 'PUT', { enabled: true });
    assert(enabledCount(accountId) === 3, 'nicht alle aktiviert');
    for (const id of abIds) await jsend(`${base}/addressbooks/${id}`, 'PUT', { enabled: false });
    assert(enabledCount(accountId) === 0, 'nicht alle deaktiviert');
  });

  await asyncTest('Die Seite bündelt die Sammelaktion in einem Durchlauf', () => {
    assert(/Promise\.allSettled\(targets\.map/.test(pageSrc), 'Sammelaktion läuft nicht gebündelt');
    assert(/settings\.enableAll/.test(pageSrc) && /settings\.disableAll/.test(pageSrc), 'Sammelschalter fehlen');
    // Nur tatsächlich abweichende Einträge anfassen, nicht blind alle.
    assert(/filter\(\(ab\) => Boolean\(ab\.enabled\) !== enable\)/.test(pageSrc), 'Sammelaktion filtert nicht auf Abweichungen');
  });

  // ------------------------------------------------------------------
  // Frontend-Vertrag
  // ------------------------------------------------------------------
  await asyncTest('Die Karte zeigt Teilfehler statt „verbunden"', () => {
    assert(/if \(account\.lastError\) return t\('settings\.syncPartiallyFailed'\)/.test(pageSrc), 'Status ignoriert lastError');
    assert(/settings\.syncErrorDetail/.test(pageSrc), 'Fehlermeldung wird nicht gezeigt');
  });

  await asyncTest('Serverfehler und Einrichtungslücke tragen verschiedene Töne', () => {
    // Beides amber machte die Seite zur Warnwand und lehrte, Amber zu ignorieren:
    // „kein Adressbuch aktiviert" ist der erwartete Zustand einer frischen
    // Einrichtung, ein 501 vom Server ist es nicht.
    assert(/if \(account\.lastError\) return 'danger';/.test(pageSrc), 'Fehler ist nicht danger');
    assert(/if \(count === 0\) return 'neutral';/.test(pageSrc), '0 Adressbücher ist nicht neutral');
  });

  await asyncTest('Der Fehler hängt an der Adressbuch-Zeile, nicht nur am Konto', () => {
    const cols = database.prepare('PRAGMA table_info(carddav_addressbook_selection)').all().map((c) => c.name);
    assert(cols.includes('last_error'), 'last_error je Adressbuch fehlt (Migration 93)');
    assert(/recordAddressbookOutcome\(selAbook\.id, errorMessage \?\? null\)/.test(serviceSrc), 'Zeilen-Fehler wird nicht geschrieben');
    assert(/last_error as lastError/.test(readFileSync(path.join(here, '..', 'server/routes/cardav.js'), 'utf8')), 'lastError wird nicht ausgeliefert');
    assert(/caldav-calendar-item--failed/.test(pageSrc), 'gescheiterte Zeile wird nicht markiert');
    // Bei einem Fehler ist die Liste die Antwort, nicht das Versteck.
    assert(/addressbooks\.some\(\(ab\) => ab\.lastError\)/.test(pageSrc), 'Liste öffnet bei Fehler nicht');
  });

  await asyncTest('Serverfehler kommen als übersetzbarer Code, nicht als deutscher Klartext', () => {
    const routerSrc = readFileSync(path.join(here, '..', 'server/routes/cardav.js'), 'utf8');
    assert(!/Interner Fehler|nicht gefunden|existiert bereits/.test(routerSrc), 'deutsche Klartexte im Router');
    assert(/errorCode: 'account_duplicate'|'account_duplicate'/.test(routerSrc), 'Konflikt-Code fehlt');
    assert(/function errorMessage\(err\)/.test(pageSrc), 'Client übersetzt Fehlercodes nicht');
    assert(/cardavErrorDuplicate/.test(pageSrc), 'Übersetzungsschlüssel fehlt');
  });

  await asyncTest('Passwort-Hinweise sind per aria-describedby mit dem Feld verknüpft', () => {
    // Ohne die Verknüpfung hört ein Screenreader nur „Password, edit text, blank" -
    // der Satz „leer lassen behält das Passwort" existiert für ihn dann nicht.
    assert(/aria-describedby="\$\{isEdit \? 'cardav-password-keep ' : ''\}cardav-password-hint"/.test(pageSrc),
      'aria-describedby fehlt am Passwortfeld');
    assert(/id="cardav-password-keep"/.test(pageSrc), 'Keep-Hinweis ohne id');
    assert(/id="cardav-password-hint"/.test(pageSrc), 'Provider-Hinweis ohne id');
    // Die Vertrauensaussage gilt dem Formular, nicht dem Feld.
    assert(/settings-form-note[\s\S]{0,120}cardavCredentialsTrustHint/.test(pageSrc),
      'Vertrauenssatz hängt weiter am Passwortfeld');
  });

  await asyncTest('Der Konto-Fehler steht an der Statuszeile, nicht unter dem Button', () => {
    assert(/statusEl\.insertAdjacentElement\('afterend', inlineError\)/.test(pageSrc),
      'Fehler wird nicht hinter der Statuszeile eingesetzt');
  });

  await asyncTest('Buttons tragen drei Gewichte statt einem', () => {
    assert(/syncBtn\.className = 'btn btn--secondary btn--sm'/.test(pageSrc), 'Sync nicht akzentuiert');
    assert(/refreshBtn\.className = 'btn btn--ghost btn--sm'/.test(pageSrc), 'Refresh nicht still');
    assert(/editBtn\.className = 'btn btn--ghost btn--sm'/.test(pageSrc), 'Edit nicht still');
    // Genau ein gefüllter CTA auf der Seite - der Sync-Button ist es nicht.
    assert(!/syncBtn\.className = 'btn btn--primary/.test(pageSrc), 'zweiter Primary je Karte');
  });

  await asyncTest('Toter CSS-Hook entfernt', () => {
    assert(!/caldav-addressbooks-panel/.test(pageSrc), 'Klassenname ohne CSS-Regel wieder da');
  });

  await asyncTest('Abbrechen im Bearbeiten-Dialog läuft durch die Dirty-Guard', () => {
    assert(/cardav-account-cancel'\)\?\.addEventListener\('click', \(\) => closeModal\(\)\)/.test(pageSrc),
      'Cancel schließt weiterhin mit force');
  });

  await asyncTest('Bearbeiten-Dialog ist verdrahtet und admin-gated', () => {
    assert(/function openAccountModal\(account, onDone\)/.test(pageSrc), 'gemeinsames Kontoformular fehlt');
    assert(/api\.put\(`\/contacts\/cardav\/accounts\/\$\{account\.id\}`, payload\)/.test(pageSrc), 'PUT wird nicht gerufen');
    assert(/user\?\.role === 'admin'[\s\S]{0,400}openAccountModal\(account, refresh\)/.test(pageSrc), 'Bearbeiten nicht admin-gated');
    assert(/cardavPasswordKeepHint/.test(pageSrc), 'Hinweis zum leeren Passwortfeld fehlt');
  });
} finally {
  server.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* egal */ }
}

console.log(`\n[CardDAV-Konto-Lebenszyklus] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
