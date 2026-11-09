/**
 * Modul: Strukturierte Kontakt-Namen (#535)
 * Zweck: Der Anzeigename eines Kontakts wird aus den vCard-N-Komponenten
 *        abgeleitet, nicht aus der quellenabhängigen FN-Formatierung. Getestet
 *        werden der geteilte Helper (public/utils/contact-name.js) und die
 *        HTTP-Schicht: POST/PUT leiten `name` aus Vor-/Nachname ab, GET / sortiert
 *        nach Nachname, der vCard-Export gibt echte N-Komponenten aus.
 * Ausführen: node test/test-contact-names.js
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import express from 'express';

import {
  composeDisplayName, normalizeNameParts, splitDisplayName, contactSortKey,
} from '../public/utils/contact-name.js';

let passed = 0, failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'Wert'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
}

console.log('\n[Contact-Names-Test] Strukturierte Namensteile (#535)\n');

import { freshTestDbPath } from './tmp-db.js';
freshTestDbPath('contact-names');
process.env.SESSION_SECRET = 'contact-names-test-secret-32bytes-long';

const db = await import('../server/db.js');
const { default: contactsRouter } = await import('../server/routes/contacts.js');
const { syncFamilyMemberArtifacts } = await import('../server/auth.js');
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
  // ------------------------------------------------------------------
  // Helper (isomorph, auch im Frontend im Einsatz)
  // ------------------------------------------------------------------

  await asyncTest('composeDisplayName baut "Vorname [Zweitname] Nachname" und lässt Titel weg', () => {
    eq(composeDisplayName({ firstName: 'Erika', lastName: 'Mustermann' }), 'Erika Mustermann');
    eq(composeDisplayName({ firstName: 'Hans', middleName: 'Peter', lastName: 'Müller' }), 'Hans Peter Müller');
    eq(composeDisplayName({ namePrefix: 'Dr.', firstName: 'Anna', lastName: 'Berg', nameSuffix: 'jr.' }), 'Anna Berg');
    eq(composeDisplayName({ lastName: 'Nurnachname' }), 'Nurnachname');
    eq(composeDisplayName({}), null, 'ohne Komponenten kein Name');
  });

  await asyncTest('normalizeNameParts trimmt und macht Leerstrings zu null', () => {
    const n = normalizeNameParts({ firstName: '  Anna ', lastName: '   ', middleName: undefined });
    eq(n.firstName, 'Anna');
    eq(n.lastName, null);
    eq(n.middleName, null);
  });

  await asyncTest('splitDisplayName trennt am letzten Namensteil und ist verlustfrei', () => {
    const a = splitDisplayName('Hans-Peter von Müller');
    eq(a.firstName, 'Hans-Peter von');
    eq(a.lastName, 'Müller');
    eq(composeDisplayName(a), 'Hans-Peter von Müller', 'Round-Trip verändert den Namen nicht');

    const single = splitDisplayName('Bäckerei');
    eq(single.firstName, 'Bäckerei');
    eq(single.lastName, null, 'ein einzelnes Wort ist kein Nachname');
  });

  await asyncTest('contactSortKey nimmt den Nachnamen, sonst den Anzeigenamen', () => {
    eq(contactSortKey({ name: 'Anna Zeller', last_name: 'Zeller' }), 'Zeller');
    eq(contactSortKey({ name: 'Bäckerei Schmidt', last_name: null }), 'Bäckerei Schmidt');
    eq(contactSortKey({}), '');
  });

  // ------------------------------------------------------------------
  // POST /contacts
  // ------------------------------------------------------------------

  await asyncTest('POST leitet name aus firstName/lastName ab (Komponenten schlagen ein mitgesendetes name)', async () => {
    const res = await jsend(base, 'POST', {
      name: 'Mustermann, Erika', firstName: 'Erika', lastName: 'Mustermann', category: 'misc',
    });
    eq(res.status, 201);
    eq(res.body.data.name, 'Erika Mustermann');
    eq(res.body.data.first_name, 'Erika');
    eq(res.body.data.last_name, 'Mustermann');
  });

  await asyncTest('POST ohne Komponenten bleibt abwärtskompatibel (name allein genügt)', async () => {
    const res = await jsend(base, 'POST', { name: 'Bäckerei Schmidt', category: 'misc' });
    eq(res.status, 201);
    eq(res.body.data.name, 'Bäckerei Schmidt');
    eq(res.body.data.first_name, null);
    eq(res.body.data.last_name, null);
  });

  await asyncTest('POST übernimmt Zweitname/Titel/Suffix, ohne sie anzuzeigen', async () => {
    const res = await jsend(base, 'POST', {
      firstName: 'Hans', middleName: 'Peter', lastName: 'Müller',
      namePrefix: 'Dr.', nameSuffix: 'jr.', category: 'misc',
    });
    eq(res.status, 201);
    eq(res.body.data.name, 'Hans Peter Müller');
    eq(res.body.data.name_prefix, 'Dr.');
    eq(res.body.data.name_suffix, 'jr.');
  });

  await asyncTest('POST ohne jeden Namen → 400', async () => {
    const res = await jsend(base, 'POST', { category: 'misc' });
    eq(res.status, 400);
  });

  await asyncTest('POST mit zu langem Nachnamen → 400', async () => {
    const res = await jsend(base, 'POST', { firstName: 'A', lastName: 'x'.repeat(500), category: 'misc' });
    eq(res.status, 400);
  });

  // ------------------------------------------------------------------
  // PUT /contacts/:id
  // ------------------------------------------------------------------

  await asyncTest('PUT mit Komponenten schreibt sie und rechnet name neu', async () => {
    const created = await jsend(base, 'POST', { firstName: 'Anna', lastName: 'Alt', category: 'misc' });
    const id = created.body.data.id;

    const res = await jsend(`${base}/${id}`, 'PUT', { firstName: 'Anna', lastName: 'Neu' });
    eq(res.status, 200);
    eq(res.body.data.name, 'Anna Neu');
    eq(res.body.data.last_name, 'Neu');
  });

  await asyncTest('PUT ohne Namensfelder lässt Name und Struktur unberührt', async () => {
    const created = await jsend(base, 'POST', { firstName: 'Bert', lastName: 'Bleibt', category: 'misc' });
    const id = created.body.data.id;

    const res = await jsend(`${base}/${id}`, 'PUT', { phone: '+49 30 1' });
    eq(res.status, 200);
    eq(res.body.data.name, 'Bert Bleibt');
    eq(res.body.data.first_name, 'Bert');
    eq(res.body.data.last_name, 'Bleibt');
  });

  await asyncTest('PUT kann den Nachnamen leeren (Struktur folgt der Eingabe)', async () => {
    const created = await jsend(base, 'POST', { firstName: 'Cem', lastName: 'Weg', category: 'misc' });
    const id = created.body.data.id;

    const res = await jsend(`${base}/${id}`, 'PUT', { firstName: 'Cem', lastName: '' });
    eq(res.status, 200);
    eq(res.body.data.name, 'Cem');
    eq(res.body.data.last_name, null);
  });

  // ------------------------------------------------------------------
  // GET / (Sortierung) + vCard-Export
  // ------------------------------------------------------------------

  await asyncTest('GET / sortiert nach Nachname, Kontakte ohne Struktur nach Anzeigename', async () => {
    database.prepare('DELETE FROM contacts').run();
    await jsend(base, 'POST', { firstName: 'Anna', lastName: 'Zeller', category: 'misc' });
    await jsend(base, 'POST', { firstName: 'Zoe', lastName: 'Albrecht', category: 'misc' });
    await jsend(base, 'POST', { name: 'Malerbetrieb Bunt', category: 'misc' });

    const res = await jget(base);
    eq(res.status, 200);
    const names = res.body.data.map((c) => c.name);
    assert(
      JSON.stringify(names) === JSON.stringify(['Zoe Albrecht', 'Malerbetrieb Bunt', 'Anna Zeller']),
      `Reihenfolge unerwartet: ${JSON.stringify(names)}`
    );
  });

  await asyncTest('vCard-Export gibt echte N-Komponenten aus', async () => {
    const created = await jsend(base, 'POST', {
      firstName: 'Erika', middleName: 'Maria', lastName: 'Mustermann',
      namePrefix: 'Dr.', nameSuffix: 'M.A.', category: 'misc',
    });
    const r = await fetch(`${base}/${created.body.data.id}/vcard`);
    const text = await r.text();
    assert(text.includes('N:Mustermann;Erika;Maria;Dr.;M.A.'), `N-Zeile fehlt:\n${text}`);
    assert(text.includes('FN:Erika Maria Mustermann'), `FN-Zeile fehlt:\n${text}`);
  });

  await asyncTest('vCard-Export ohne Struktur trägt den Anzeigenamen wie bisher', async () => {
    const created = await jsend(base, 'POST', { name: 'Malerbetrieb Bunt', category: 'misc' });
    const r = await fetch(`${base}/${created.body.data.id}/vcard`);
    const text = await r.text();
    assert(text.includes('N:Malerbetrieb Bunt;;;;'), `N-Fallback fehlt:\n${text}`);
  });

  // ------------------------------------------------------------------
  // Gespiegelte Familien-/Gast-Kontakte (server/auth.js, split-expenses.js)
  // ------------------------------------------------------------------

  await asyncTest('Familien-Spiegel leert veraltete Namensteile, wenn der Anzeigename wechselt', () => {
    const userId = database.prepare(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role)
      VALUES ('mirror-a', 'Anna Alt', 'x', '#007AFF', 'member')
    `).run().lastInsertRowid;

    syncFamilyMemberArtifacts(database, userId, { displayName: 'Anna Alt', actorUserId: 1 });
    const contactId = database.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId).id;
    database.prepare("UPDATE contacts SET first_name = 'Anna', last_name = 'Alt' WHERE id = ?").run(contactId);

    syncFamilyMemberArtifacts(database, userId, { displayName: 'Anna Neu', actorUserId: 1 });

    const c = database.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    eq(c.name, 'Anna Neu');
    eq(c.last_name, null, 'alter Nachname darf nicht stehen bleiben');
    eq(contactSortKey(c), 'Anna Neu', 'Sortierung fällt auf den Anzeigenamen zurück');
  });

  await asyncTest('Familien-Spiegel lässt Namensteile stehen, wenn der Anzeigename gleich bleibt', () => {
    const userId = database.prepare(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role)
      VALUES ('mirror-b', 'Bea Bleibt', 'x', '#007AFF', 'member')
    `).run().lastInsertRowid;

    syncFamilyMemberArtifacts(database, userId, { displayName: 'Bea Bleibt', actorUserId: 1 });
    const contactId = database.prepare('SELECT id FROM contacts WHERE family_user_id = ?').get(userId).id;
    database.prepare("UPDATE contacts SET first_name = 'Bea', last_name = 'Bleibt' WHERE id = ?").run(contactId);

    syncFamilyMemberArtifacts(database, userId, { displayName: 'Bea Bleibt', phone: '+49 30 9', actorUserId: 1 });

    const c = database.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    eq(c.last_name, 'Bleibt');
    eq(c.phone, '+49 30 9');
  });

  // ------------------------------------------------------------------
  // Quell-Vertrag: geratene Struktur wird nicht ungefragt gespeichert
  // ------------------------------------------------------------------

  await asyncTest('Import-Dublettenprüfung erkennt umformatierte Namen', () => {
    const src = readFileSync(new URL('../public/pages/contacts.js', import.meta.url), 'utf8');
    // nameVariants ist modul-lokal (keine Export-Fläche); die Regel wird hier über
    // eine wortgleiche Kopie geprüft, der Quell-Guard darunter hält beide synchron.
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const variants = (c) => {
      const out = new Set();
      const display = norm(c.name);
      if (display) { out.add(display); out.add(norm(display.replace(/^([^,]+),\s*(.+)$/, '$2 $1'))); }
      const first = norm(c.first_name ?? c.firstName);
      const last  = norm(c.last_name  ?? c.lastName);
      if (first || last) { out.add(norm(`${first} ${last}`)); out.add(norm(`${last} ${first}`)); }
      out.delete('');
      return out;
    };
    const hit = (a, b) => [...variants(a)].some((v) => variants(b).has(v));

    assert(hit({ name: 'Doe, John' }, { name: 'John Doe', firstName: 'John', lastName: 'Doe' }),
      '"Doe, John" muss zu "John Doe" passen');
    assert(hit({ name: 'Erika Mustermann', first_name: 'Erika', last_name: 'Mustermann' },
               { name: 'Mustermann Erika', firstName: 'Erika', lastName: 'Mustermann' }),
      'gleiche Namensteile in anderer Reihenfolge müssen matchen');
    assert(!hit({ name: 'AutoHaus König' }, { name: 'Malerbetrieb Bunt' }),
      'verschiedene Firmen dürfen nicht als Dublette gelten');

    assert(/function nameVariants\(c\) \{/.test(src), 'nameVariants fehlt in contacts.js');
    assert(/const exists = contactExistsByName\(contact\);/.test(src),
      'Dublettenprüfung bekommt den ganzen Kontakt, nicht nur den Namen');
  });

  await asyncTest('Kontaktliste wird nach dem Laden locale-sortiert (nicht SQLite-NOCASE)', () => {
    const src = readFileSync(new URL('../public/pages/contacts.js', import.meta.url), 'utf8');
    assert(
      /state\.contacts\s+= \[\.\.\.res\.data\]\.sort\(\(a, b\) =>\s*\n\s*catSortIndex\(a\.category\) - catSortIndex\(b\.category\) \|\| byName\(a, b\)/.test(src),
      'Initiale Liste wird nicht mit byName nachsortiert - Reihenfolge springt nach dem ersten Edit'
    );
  });

  await asyncTest('Fremde Kategorie überlebt eine Bearbeitung (PUT ohne category)', async () => {
    // Kontakt mit einer Kategorie, die nicht in contact_categories steht - so
    // entstanden durch Direktimporte in die DB. Der Dialog schickt sie nicht mit;
    // der Server muss sie dann per COALESCE behalten statt sie zu überschreiben.
    const id = database.prepare(
      "INSERT INTO contacts (name, category) VALUES ('Fremd Kategorie', 'legacy-import')"
    ).run().lastInsertRowid;

    const res = await jsend(`${base}/${id}`, 'PUT', { name: 'Fremd Kategorie', phone: '+49 30 5' });
    eq(res.status, 200);
    eq(res.body.data.category, 'legacy-import', 'Kategorie darf nicht stillschweigend wechseln');

    // Mitgeschickt würde sie zu Recht abgelehnt - deshalb lässt der Dialog sie weg.
    const rejected = await jsend(`${base}/${id}`, 'PUT', { category: 'legacy-import' });
    eq(rejected.status, 400);
  });

  await asyncTest('Kontakt-Dialog bietet die Ist-Kategorie als Option an und sendet sie unverändert nicht mit', () => {
    const src = readFileSync(new URL('../public/pages/contacts.js', import.meta.url), 'utf8');
    assert(
      /const orphanCat = isEdit && contact\.category && !catByKey\(contact\.category\)/.test(src),
      'Erkennung der nicht verwalteten Kategorie fehlt - das Select fiele auf die erste Option zurück'
    );
    assert(
      /if \(orphanCat && category === orphanCat\) delete body\.category;/.test(src),
      'unveränderte Fremd-Kategorie wird mitgeschickt und läuft in einen 400'
    );
  });

  await asyncTest('Kontakt-Dialog sendet Namensteile nur bei vorhandener oder berührter Struktur', () => {
    const src = readFileSync(new URL('../public/pages/contacts.js', import.meta.url), 'utf8');
    assert(/let nameTouched = false;/.test(src), 'Dirty-Flag für die Namensfelder fehlt');
    assert(
      /const structured = !isEdit \|\| hadStructure \|\| nameTouched;/.test(src),
      'structured-Bedingung fehlt oder wurde umgeschrieben'
    );
    assert(
      /if \(structured\) \{ body\.firstName = firstName; body\.lastName = lastName; \}/.test(src),
      'Namensteile werden unbedingt gesendet - geratene Struktur würde persistiert'
    );
  });
} finally {
  server.close();
}

console.log(`\n[Contact-Names-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
