/**
 * Modul: Kontakt-Routen-Test
 * Zweck: HTTP-Schicht von server/routes/contacts.js, soweit test-contact-categories.js
 *        (Kategorien-CRUD) und test-family-contacts.js sie nicht abdecken: Multi-Value-
 *        Felder (phones/emails/addresses) bei POST/PUT inkl. Replacement-Semantik,
 *        GET /-Filter (category + q), vCard-Export mit Escaping, validateAddresses-
 *        Feldzweige, sowie die 404/403-Pfade (GET/:id, DELETE/:id family, Kategorie-404).
 * Ausführen: node --experimental-sqlite test/test-contacts-routes.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

let passed = 0, failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

console.log('\n[Contacts-Routes-Test] HTTP-Schicht der Kontakt-Routen\n');

process.env.DB_PATH = path.join(os.tmpdir(), `yuvomi-contacts-routes-${process.pid}.db`);
process.env.SESSION_SECRET = 'contacts-routes-test-secret-32bytes-long';

const db = await import('../server/db.js');
const { default: contactsRouter, validateAddresses } = await import('../server/routes/contacts.js');
db.init();
const database = db.get();

// Ein Nutzer für den family_user_id-Bezug (Familienmitglied-Kontakt, Lösch-Schutz 403).
const famUserId = database.prepare(
  "INSERT INTO users (username, display_name, password_hash, avatar_color, role) VALUES ('contacts-fam', 'Fam Mitglied', 'x', '#007AFF', 'member')"
).run().lastInsertRowid;

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
const tget = async (u) => {
  const r = await fetch(u);
  return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
};

try {
  // ------------------------------------------------------------------
  // validateAddresses: Feldzweige (exportiert) - city/state/postalCode/country
  // ------------------------------------------------------------------
  await asyncTest('validateAddresses lehnt ungültige Feldtypen/-längen ab', () => {
    assert(validateAddresses([{ label: 'Home', city: 123 }]).valid === false, 'city Nicht-String → invalid');
    assert(validateAddresses([{ label: 'Home', state: 'x'.repeat(256) }]).valid === false, 'state zu lang → invalid');
    assert(validateAddresses([{ label: 'Home', postalCode: 42 }]).valid === false, 'postalCode Nicht-String → invalid');
    assert(validateAddresses([{ label: 'Home', country: 'y'.repeat(256) }]).valid === false, 'country zu lang → invalid');
    // Gültige, vollständige Adresse passiert.
    const ok = validateAddresses([{ label: 'Home', street: 'Weg 1', city: 'Berlin', state: 'BE', postalCode: '10115', country: 'DE', isPrimary: true }]);
    assert(ok.valid === true, 'vollständig gültige Adresse ist valide');
  });

  // ------------------------------------------------------------------
  // GET /meta
  // ------------------------------------------------------------------
  await asyncTest('GET /meta liefert Kategorien-Liste', async () => {
    const { status, body } = await jget(`${base}/meta`);
    assert(status === 200, `Status ${status}`);
    assert(Array.isArray(body.data.categories) && body.data.categories.length > 0, 'Kategorien vorhanden');
  });

  // ------------------------------------------------------------------
  // POST / mit Multi-Value-Feldern
  // ------------------------------------------------------------------
  let contactId;
  await asyncTest('POST / legt Kontakt mit phones/emails/addresses an (201, Response mit Multi-Values)', async () => {
    const { status, body } = await jsend(`${base}`, 'POST', {
      name: 'Erika Muster',
      category: 'misc',
      phone: '030-111',
      email: 'erika@example.com',
      phones: [
        { label: 'Mobil', value: '0170-1', isPrimary: true },
        { label: 'Büro', value: '030-2' },
      ],
      emails: [{ label: 'Privat', value: 'erika@example.com', isPrimary: true }],
      addresses: [
        { label: 'Zuhause', street: 'Hauptstr 1', city: 'Berlin', postalCode: '10115', country: 'DE', isPrimary: true },
        // Adresse mit nur Label → optionale Felder werden zu NULL gespeichert.
        { label: 'Nur Label' },
      ],
    });
    assert(status === 201, `Status ${status}`);
    assert(body.data.name === 'Erika Muster', 'Name gespeichert');
    assert(body.data.phones.length === 2, `2 Telefonnummern, war ${body.data.phones.length}`);
    // Primär-Sortierung: is_primary DESC → das primäre Mobil steht vorn.
    assert(body.data.phones[0].isPrimary === true && body.data.phones[0].label === 'Mobil', 'primäres Telefon zuerst, isPrimary bool');
    assert(body.data.emails.length === 1 && body.data.emails[0].isPrimary === true, 'eine E-Mail, primär');
    assert(body.data.addresses.length === 2, `2 Adressen, war ${body.data.addresses.length}`);
    // Primär-Sortierung: die vollständige (isPrimary) Adresse steht vorn.
    assert(body.data.addresses[0].postalCode === '10115' && body.data.addresses[0].country === 'DE', 'vollständige Adresse zuerst, Felder gemappt');
    const labelOnly = body.data.addresses.find((a) => a.label === 'Nur Label');
    assert(labelOnly && labelOnly.street === null && labelOnly.city === null && labelOnly.country === null, 'Label-Only-Adresse: optionale Felder NULL');
    contactId = body.data.id;
  });

  await asyncTest('POST / mit ungültigen emails → 400', async () => {
    const { status, body } = await jsend(`${base}`, 'POST', { name: 'Bad Email', emails: [{ label: 'X', value: 'keine-email' }] });
    assert(status === 400, `Status ${status}`);
    assert(/email/i.test(body.error), 'Fehlermeldung nennt E-Mail');
  });

  await asyncTest('POST / mit ungültigen addresses → 400', async () => {
    const { status } = await jsend(`${base}`, 'POST', { name: 'Bad Addr', addresses: [{ street: 'ohne Label' }] });
    assert(status === 400, `Status ${status}`);
  });

  // ------------------------------------------------------------------
  // GET /:id
  // ------------------------------------------------------------------
  await asyncTest('GET /:id liefert Kontakt mit Multi-Values', async () => {
    const { status, body } = await jget(`${base}/${contactId}`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.id === contactId, 'richtige ID');
    assert(body.data.phones.length === 2 && body.data.emails.length === 1, 'Multi-Values geladen');
  });

  await asyncTest('GET /:id für unbekannte ID → 404', async () => {
    const { status } = await jget(`${base}/99999`);
    assert(status === 404, `Status ${status}`);
  });

  // ------------------------------------------------------------------
  // GET / Filter (category + q)
  // ------------------------------------------------------------------
  await asyncTest('GET / ohne Filter enthält den Kontakt', async () => {
    const { status, body } = await jget(`${base}`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.some((c) => c.id === contactId), 'Kontakt in ungefilterter Liste');
  });

  await asyncTest('GET /?category= filtert nach Kategorie', async () => {
    const { status, body } = await jget(`${base}?category=misc`);
    assert(status === 200, `Status ${status}`);
    assert(body.data.every((c) => c.category === 'misc'), 'nur misc-Kontakte');
    assert(body.data.some((c) => c.id === contactId), 'unser misc-Kontakt enthalten');
  });

  await asyncTest('GET /?q= sucht in name/phone/email', async () => {
    const byName = await jget(`${base}?q=Erika`);
    assert(byName.status === 200 && byName.body.data.some((c) => c.id === contactId), 'Treffer über Name');
    const byPhone = await jget(`${base}?q=030-111`);
    assert(byPhone.body.data.some((c) => c.id === contactId), 'Treffer über Telefon');
    const none = await jget(`${base}?q=GibtEsNichtXYZ`);
    assert(none.body.data.length === 0, 'kein Treffer für Unsinns-Query');
  });

  // ------------------------------------------------------------------
  // PUT /:id - Multi-Value-Replacement + Validierung + 404
  // ------------------------------------------------------------------
  await asyncTest('PUT /:id ersetzt Multi-Values (delete + insert) und Skalare', async () => {
    const { status, body } = await jsend(`${base}/${contactId}`, 'PUT', {
      name: 'Erika Neu',
      notes: 'aktualisiert',
      phones: [{ label: 'Nur eins', value: '0800-1' }],
      emails: [],
      addresses: [{ label: 'Neu', city: 'Hamburg' }],
    });
    assert(status === 200, `Status ${status}`);
    assert(body.data.name === 'Erika Neu' && body.data.notes === 'aktualisiert', 'Skalare aktualisiert');
    assert(body.data.phones.length === 1 && body.data.phones[0].value === '0800-1', 'Telefone ersetzt (1)');
    assert(body.data.emails.length === 0, 'E-Mails geleert (Replacement mit leerem Array)');
    assert(body.data.addresses.length === 1 && body.data.addresses[0].city === 'Hamburg', 'Adresse ersetzt');
  });

  await asyncTest('PUT /:id mit ungültigen emails → 400', async () => {
    const { status } = await jsend(`${base}/${contactId}`, 'PUT', { emails: [{ label: 'X', value: 'kaputt' }] });
    assert(status === 400, `Status ${status}`);
  });

  await asyncTest('PUT /:id mit ungültigen addresses → 400', async () => {
    const { status } = await jsend(`${base}/${contactId}`, 'PUT', { addresses: [{ label: 'X', country: 12345 }] });
    assert(status === 400, `Status ${status}`);
  });

  await asyncTest('PUT /:id für unbekannte ID → 404', async () => {
    const { status } = await jsend(`${base}/99999`, 'PUT', { name: 'X' });
    assert(status === 404, `Status ${status}`);
  });

  // ------------------------------------------------------------------
  // GET /:id/vcard - vollständige vCard + Escaping + 404
  // ------------------------------------------------------------------
  await asyncTest('GET /:id/vcard exportiert vCard 3.0 mit Escaping', async () => {
    // Kontakt mit Sonderzeichen für den Escaping-Pfad (Komma/Semikolon/Backslash/Newline).
    const created = await jsend(`${base}`, 'POST', {
      name: 'Meyer, Hans; A\\B',
      category: 'misc',
      phone: '030-999',
      email: 'hans@example.com',
      address: 'Weg 2, Etage 3',
      notes: 'Zeile1\nZeile2',
    });
    const vId = created.body.data.id;
    const { status, text, contentType, disposition } = await tget(`${base}/${vId}/vcard`);
    assert(status === 200, `Status ${status}`);
    assert(/text\/vcard/.test(contentType), `Content-Type vcard, war ${contentType}`);
    assert(/attachment; filename=".*\.vcf"/.test(disposition), 'Content-Disposition mit .vcf-Dateiname');
    assert(text.startsWith('BEGIN:VCARD\r\nVERSION:3.0'), 'vCard-Kopf mit CRLF');
    assert(text.includes('FN:Meyer\\, Hans\\; A\\\\B'), 'Name escaped (Komma/Semikolon/Backslash)');
    assert(text.includes('TEL;TYPE=VOICE:030-999'), 'Telefonzeile');
    assert(text.includes('EMAIL:hans@example.com'), 'E-Mail-Zeile');
    assert(text.includes('NOTE:Zeile1\\nZeile2'), 'Notiz mit escaptem Zeilenumbruch');
    assert(text.includes('CATEGORIES:misc'), 'Kategorie-Zeile');
    assert(text.trim().endsWith('END:VCARD'), 'vCard-Ende');
  });

  await asyncTest('GET /:id/vcard für unbekannte ID → 404', async () => {
    const { status } = await tget(`${base}/99999/vcard`);
    assert(status === 404, `Status ${status}`);
  });

  // ------------------------------------------------------------------
  // Geburtstag (birthday): POST speichert, GET liefert, vCard exportiert BDAY,
  // ungültiges Format → 400. Speist den #518-Geburtstags-Import.
  // ------------------------------------------------------------------
  await asyncTest('POST / speichert birthday, GET liefert es, vCard exportiert BDAY', async () => {
    const created = await jsend(`${base}`, 'POST', {
      name: 'Geburtstagskind', category: 'misc', birthday: '1990-07-18',
    });
    assert(created.status === 201, `Status ${created.status}`);
    assert(created.body.data.birthday === '1990-07-18', `birthday in Response, war ${created.body.data.birthday}`);
    const bId = created.body.data.id;

    const got = await jget(`${base}/${bId}`);
    assert(got.body.data.birthday === '1990-07-18', 'birthday via GET');

    const { text } = await tget(`${base}/${bId}/vcard`);
    assert(text.includes('BDAY:1990-07-18'), 'vCard enthält BDAY');
  });

  await asyncTest('POST / mit ungültigem birthday-Format → 400', async () => {
    const { status, body } = await jsend(`${base}`, 'POST', { name: 'Bad BDay', birthday: '18.07.1990' });
    assert(status === 400, `Status ${status}`);
    assert(/geburtstag|birthday|YYYY-MM-DD/i.test(body.error), 'Fehlermeldung nennt Datum/Format');
  });

  // ------------------------------------------------------------------
  // DELETE /:id - Familienmitglied-Schutz (403), Erfolg (204), 404
  // ------------------------------------------------------------------
  await asyncTest('DELETE /:id eines Familienmitglied-Kontakts → 403', async () => {
    const famContactId = database.prepare(
      "INSERT INTO contacts (name, category, family_user_id) VALUES ('Fam Kontakt', 'misc', ?)"
    ).run(famUserId).lastInsertRowid;
    const { status, body } = await jsend(`${base}/${famContactId}`, 'DELETE');
    assert(status === 403, `Status ${status}`);
    assert(/Familienmitglieder/.test(body.error), 'Fehlermeldung nennt Familienmitglieder');
    // Kontakt bleibt bestehen.
    assert(database.prepare('SELECT 1 FROM contacts WHERE id = ?').get(famContactId), 'Familien-Kontakt nicht gelöscht');
  });

  await asyncTest('DELETE /:id eines normalen Kontakts → 204', async () => {
    const { status } = await jsend(`${base}/${contactId}`, 'DELETE');
    assert(status === 204, `Status ${status}`);
    assert(!database.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId), 'Kontakt gelöscht');
  });

  await asyncTest('DELETE /:id für unbekannte ID → 404', async () => {
    const { status } = await jsend(`${base}/99999`, 'DELETE');
    assert(status === 404, `Status ${status}`);
  });

  // ------------------------------------------------------------------
  // Kategorie-404-Pfade (Ergänzung zu test-contact-categories.js)
  // ------------------------------------------------------------------
  await asyncTest('PUT /categories/:key für unbekannten Key → 404', async () => {
    const { status } = await jsend(`${base}/categories/gibt-es-nicht`, 'PUT', { name: 'Egal' });
    assert(status === 404, `Status ${status}`);
  });

  await asyncTest('DELETE /categories/:key für unbekannten Key → 404', async () => {
    const { status } = await jsend(`${base}/categories/gibt-es-nicht`, 'DELETE');
    assert(status === 404, `Status ${status}`);
  });
} finally {
  server.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* egal */ }
}

console.log(`\n[Contacts-Routes-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed > 0 ? 1 : 0);
