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

import { freshTestDbPath } from './tmp-db.js';
freshTestDbPath('contacts-routes');
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

  // PUT: birthday setzen/ändern (Audit R2: Feld ist jetzt im Kontakt-Formular),
  // Weglassen lässt den Wert unangetastet, leerer Wert löscht ihn.
  await asyncTest('PUT /:id setzt, erhält und löscht birthday', async () => {
    const created = await jsend(`${base}`, 'POST', { name: 'BDay Edit', category: 'misc' });
    const bId = created.body.data.id;

    const set = await jsend(`${base}/${bId}`, 'PUT', { birthday: '1985-03-02' });
    assert(set.status === 200, `Status ${set.status}`);
    assert(set.body.data.birthday === '1985-03-02', `birthday gesetzt, war ${set.body.data.birthday}`);

    const untouched = await jsend(`${base}/${bId}`, 'PUT', { notes: 'nur Notiz' });
    assert(untouched.body.data.birthday === '1985-03-02', 'birthday bleibt ohne Feld unangetastet');

    const cleared = await jsend(`${base}/${bId}`, 'PUT', { birthday: '' });
    assert(cleared.body.data.birthday === null, `leerer Wert löscht birthday, war ${cleared.body.data.birthday}`);

    const bad = await jsend(`${base}/${bId}`, 'PUT', { birthday: '02.03.1985' });
    assert(bad.status === 400, `ungültiges Format → 400, war ${bad.status}`);
  });

  // #2095: ein Geburtstag ohne Jahr. Das Datum traegt das Platzhalterjahr 2000,
  // die Marke sagt, dass es keines ist; der Export schreibt Apples Form, damit
  // Apple (und der eigene Import) kein Jahr 1604 oder 2000 als echtes sehen.
  await asyncTest('birthday_year_unknown: speichern, exportieren, mit Jahr abnehmen (#2095)', async () => {
    const created = await jsend(`${base}`, 'POST', {
      name: 'Ohne Jahr', category: 'misc', birthday: '1987-02-29', birthday_year_unknown: true,
    });
    assert(created.status === 201, `Status ${created.status} ${JSON.stringify(created.body)}`);
    assert(created.body.data.birthday === '2000-02-29', `Platzhalterjahr, war ${created.body.data.birthday}`);
    assert(created.body.data.birthday_year_unknown === 1, 'Marke gesetzt');
    const bId = created.body.data.id;

    const { text } = await tget(`${base}/${bId}/vcard`);
    assert(text.includes('BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29'), `Apple-Form im Export: ${text}`);
    assert(!text.includes('BDAY:2000'), 'kein Platzhalterjahr als echtes Jahr');

    const untouched = await jsend(`${base}/${bId}`, 'PUT', { notes: 'nur Notiz' });
    assert(untouched.body.data.birthday_year_unknown === 1, 'Marke bleibt ohne Feld');

    const noYear = await jsend(`${base}/${bId}`, 'PUT', { birthday_year_unknown: false });
    assert(noYear.status === 400, `Abnehmen ohne Jahr → 400, war ${noYear.status}`);

    const withYear = await jsend(`${base}/${bId}`, 'PUT', { birthday_year_unknown: false, birthday: '1988-02-29' });
    assert(withYear.status === 200, `Status ${withYear.status}`);
    assert(withYear.body.data.birthday === '1988-02-29' && withYear.body.data.birthday_year_unknown === 0, 'mit Jahr');

    const cleared = await jsend(`${base}/${bId}`, 'PUT', { birthday: '', birthday_year_unknown: true });
    assert(cleared.body.data.birthday === null && cleared.body.data.birthday_year_unknown === 0, 'ohne Datum keine Marke');
  });

  // ------------------------------------------------------------------
  // Identitaetsfarbe eines verknuepften Mitglieds (Vollton-Regel, DESIGN.md)
  //
  // Die Kontaktzeile zeigte fuer JEDES Mitglied dieselbe Scheibe im Modulton,
  // waehrend dieselben Menschen auf dem Dashboard, im Kalender und in den
  // Aufgaben ihre eigene Farbe tragen. Sie konnte gar nicht anders: die Antwort
  // fuehrte nur `family_user_id`.
  //
  // Geprueft werden LISTE UND DETAIL, weil beide denselben Kontakt liefern -
  // laege der Join nur in der Liste, spraeche die geoeffnete Karte wieder den
  // Modulton (die Reichweite einer Korrektur ist nicht ihre Datei).
  // ------------------------------------------------------------------
  await asyncTest('Liste und Detail liefern die Identitaet eines verknuepften Mitglieds', async () => {
    const linkedId = database.prepare(
      "INSERT INTO contacts (name, category, family_user_id) VALUES ('Mitglied Kontakt', 'misc', ?)"
    ).run(famUserId).lastInsertRowid;

    const list = await jsend(`${base}`, 'GET');
    const row = list.body.data.find((c) => c.id === linkedId);
    assert(row, 'Kontakt steht in der Liste');
    assert(row.family_avatar_color === '#007AFF', `Liste: Farbe ${row.family_avatar_color}`);
    assert(row.family_display_name === 'Fam Mitglied', `Liste: Name ${row.family_display_name}`);

    const detail = await jsend(`${base}/${linkedId}`, 'GET');
    assert(detail.body.data.family_avatar_color === '#007AFF', 'Detail: dieselbe Farbe');

    // Ein Kontakt OHNE Verknuepfung bringt keine fremde Identitaet mit - sonst
    // wuerde die Marke eine Person behaupten, die es nicht gibt.
    const plain = list.body.data.find((c) => !c.family_user_id);
    assert(plain, 'es gibt einen unverknuepften Kontakt');
    assert(plain.family_avatar_color === null, `unverknuepft: ${plain.family_avatar_color}`);

    database.prepare('DELETE FROM contacts WHERE id = ?').run(linkedId);
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
  // Ein abgewiesenes Feld nennt seinen Fall (#1909): der vCard-Import zeigte
  // bis dahin den englischen Servertext, weil nur der das Feld nannte. Jetzt
  // traegt die Antwort `reason` und die Grenze als `params.limit`.
  // ------------------------------------------------------------------
  await asyncTest('POST / mit zu langem Feld nennt Grund und Grenze (#1909)', async () => {
    for (const [field, value, reason, limit] of [
      ['name', 'N'.repeat(201), 'contacts_name_too_long', 200],
      ['lastName', 'L'.repeat(201), 'contacts_name_too_long', 200],
      ['namePrefix', 'P'.repeat(101), 'contacts_name_too_long', 100],
      ['phone', '1'.repeat(101), 'contacts_phone_too_long', 100],
      ['email', `${'e'.repeat(200)}@x.de`, 'contacts_email_too_long', 200],
      ['address', 'A'.repeat(5001), 'contacts_address_too_long', 5000],
      ['notes', 'n'.repeat(5001), 'contacts_notes_too_long', 5000],
    ]) {
      const body = field === 'name' ? { name: value } : { name: 'Import Fall', [field]: value };
      const { status, body: res } = await jsend(base, 'POST', body);
      assert(status === 400, `${field}: Status ${status}`);
      assert(res.reason === reason, `${field}: reason ${res.reason}`);
      assert(res.params?.limit === limit, `${field}: limit ${JSON.stringify(res.params)}`);
      assert(typeof res.error === 'string' && res.error.length > 0, `${field}: error bleibt fuer API-Clients`);
    }
  });

  await asyncTest('POST / mit ungueltigem Geburtstag nennt den Fall, ohne Zahl (#1909)', async () => {
    const { status, body } = await jsend(base, 'POST', { name: 'Import Fall', birthday: '1990-02-30' });
    assert(status === 400, `Status ${status}`);
    assert(body.reason === 'contacts_birthday_invalid', `reason ${body.reason}`);
    assert(body.params === undefined, 'keine Zahl am Datumsfall');
  });

  await asyncTest('POST / ohne Namen bleibt ohne Grund - fehlt ist nicht zu lang (#1909)', async () => {
    const { status, body } = await jsend(base, 'POST', { phone: '123' });
    assert(status === 400, `Status ${status}`);
    assert(body.reason === undefined, `reason ${body.reason}`);
  });

  await asyncTest('POST / mit zwei Befunden nennt das erste Feld, die geloeschte Kategorie nur allein (#1909)', async () => {
    const two = await jsend(base, 'POST', { name: 'Import Fall', phone: '1'.repeat(101), notes: 'n'.repeat(5001) });
    assert(two.body.reason === 'contacts_phone_too_long', `reason ${two.body.reason}`);
    const withCategory = await jsend(base, 'POST', { name: 'Import Fall', category: 'gibt-es-nicht', phone: '1'.repeat(101) });
    assert(withCategory.body.reason === 'contacts_phone_too_long', `reason ${withCategory.body.reason}`);
    const onlyCategory = await jsend(base, 'POST', { name: 'Import Fall', category: 'gibt-es-nicht' });
    assert(onlyCategory.body.reason === 'contacts_selected_category_not_found', `reason ${onlyCategory.body.reason}`);
  });

  await asyncTest('PUT /:id mit zu langem Feld nennt Grund und Grenze (#1909)', async () => {
    const created = await jsend(base, 'POST', { name: 'Fall Bearbeiten' });
    const id = created.body.data.id;
    const notes = await jsend(`${base}/${id}`, 'PUT', { notes: 'n'.repeat(5001) });
    assert(notes.status === 400, `Status ${notes.status}`);
    assert(notes.body.reason === 'contacts_notes_too_long' && notes.body.params?.limit === 5000,
      `notes: ${JSON.stringify(notes.body)}`);
    const birthday = await jsend(`${base}/${id}`, 'PUT', { birthday: '2001-13-01' });
    assert(birthday.body.reason === 'contacts_birthday_invalid', `birthday: ${birthday.body.reason}`);
  });

  // ------------------------------------------------------------------
  // Die Mehrfachfelder nennen ihren Fall (#1909): das Kontaktformular schickt
  // jede Nummer und E-Mail-Adresse als Eintrag, und eine Adresse ohne @ oder
  // eine zu lange Nummer bekam bis dahin nur den allgemeinen Satz. Jede
  // Absage traegt jetzt `reason`, eine Grenze als `params.limit`; der englische
  // `error` bleibt wortgleich fuer API-Clients.
  // ------------------------------------------------------------------
  const MV_CASES = [
    // [Feld, Wert, Grund, Grenze, error]
    ['phones', 'keine Liste', 'contacts_phone_entry_invalid', undefined, 'Phones must be an array'],
    ['phones', Array.from({ length: 21 }, (_, i) => ({ label: 'm', value: `0${i}` })), 'contacts_phones_too_many', 20, 'Too many phone entries (max 20)'],
    ['phones', [null], 'contacts_phone_entry_invalid', undefined, 'Phone entry must be an object'],
    ['phones', [{ label: 'Mobil' }], 'contacts_phone_entry_invalid', undefined, 'Phone requires label and value'],
    ['phones', [{ label: '   ', value: '0800' }], 'contacts_phone_entry_invalid', undefined, 'Phone label invalid or too long'],
    ['phones', [{ label: 'L'.repeat(51), value: '0800' }], 'contacts_phone_label_too_long', 50, 'Phone label invalid or too long'],
    ['phones', [{ label: 'Mobil', value: 12345 }], 'contacts_phone_entry_invalid', undefined, 'Phone value invalid or too long'],
    ['phones', [{ label: 'Mobil', value: '1'.repeat(101) }], 'contacts_phone_too_long', 100, 'Phone value invalid or too long'],
    ['phones', [{ label: 'Mobil', value: '0800', isPrimary: 'ja' }], 'contacts_phone_entry_invalid', undefined, 'Phone isPrimary must be boolean'],
    ['emails', {}, 'contacts_email_entry_invalid', undefined, 'Emails must be an array'],
    ['emails', Array.from({ length: 21 }, (_, i) => ({ label: 'p', value: `a${i}@x.de` })), 'contacts_emails_too_many', 20, 'Too many email entries (max 20)'],
    ['emails', ['a@x.de'], 'contacts_email_entry_invalid', undefined, 'Email entry must be an object'],
    ['emails', [{ value: 'a@x.de' }], 'contacts_email_entry_invalid', undefined, 'Email requires label and value'],
    ['emails', [{ label: 'L'.repeat(51), value: 'a@x.de' }], 'contacts_email_label_too_long', 50, 'Email label invalid or too long'],
    ['emails', [{ label: 'Privat', value: `${'e'.repeat(251)}@x.de` }], 'contacts_email_too_long', 255, 'Email value invalid or too long'],
    ['emails', [{ label: 'Privat', value: 'kein-at-zeichen' }], 'contacts_email_invalid', undefined, 'Email value must be a valid email address'],
    ['emails', [{ label: 'Privat', value: 'a@x.de', isPrimary: 1 }], 'contacts_email_entry_invalid', undefined, 'Email isPrimary must be boolean'],
    ['addresses', 'keine Liste', 'contacts_address_entry_invalid', undefined, 'Addresses must be an array'],
    ['addresses', Array.from({ length: 21 }, () => ({ label: 'h' })), 'contacts_addresses_too_many', 20, 'Too many address entries (max 20)'],
    ['addresses', [42], 'contacts_address_entry_invalid', undefined, 'Address entry must be an object'],
    ['addresses', [{ city: 'Berlin' }], 'contacts_address_entry_invalid', undefined, 'Address requires label'],
    ['addresses', [{ label: 'L'.repeat(51) }], 'contacts_address_label_too_long', 50, 'Address label invalid or too long'],
    ['addresses', [{ label: 'Zuhause', street: 'S'.repeat(256) }], 'contacts_address_part_too_long', 255, 'Address street invalid or too long'],
    ['addresses', [{ label: 'Zuhause', postalCode: 12345 }], 'contacts_address_entry_invalid', undefined, 'Address postalCode invalid or too long'],
    ['addresses', [{ label: 'Zuhause', country: 'C'.repeat(256) }], 'contacts_address_part_too_long', 255, 'Address country invalid or too long'],
    ['addresses', [{ label: 'Zuhause', isPrimary: 'ja' }], 'contacts_address_entry_invalid', undefined, 'Address isPrimary must be boolean'],
  ];
  const expectMvCase = (where, res, [field, , reason, limit, error]) => {
    assert(res.status === 400, `${where} ${field} ${reason}: Status ${res.status}`);
    assert(res.body.reason === reason, `${where} ${field}: reason ${res.body.reason}, erwartet ${reason}`);
    assert(JSON.stringify(res.body.params) === JSON.stringify(limit === undefined ? undefined : { limit }),
      `${where} ${field} ${reason}: params ${JSON.stringify(res.body.params)}`);
    assert(res.body.error === error, `${where} ${field} ${reason}: error ${res.body.error}`);
  };

  await asyncTest('POST / mit abgewiesenem Mehrfachfeld nennt Grund und Grenze, error bleibt (#1909)', async () => {
    for (const c of MV_CASES) {
      expectMvCase('POST', await jsend(base, 'POST', { name: 'Mehrfach Fall', [c[0]]: c[1] }), c);
    }
  });

  await asyncTest('PUT /:id mit abgewiesenem Mehrfachfeld nennt Grund und Grenze, error bleibt (#1909)', async () => {
    const created = await jsend(base, 'POST', { name: 'Mehrfach Bearbeiten' });
    const id = created.body.data.id;
    for (const c of MV_CASES) {
      expectMvCase('PUT', await jsend(`${base}/${id}`, 'PUT', { [c[0]]: c[1] }), c);
    }
  });

  await asyncTest('Mehrfachfelder: der erste scheiternde Eintrag wird benannt, Einzelfelder vorher, gueltige gehen durch (#1909)', async () => {
    // Zwei Befunde in einer Liste: der erste Eintrag.
    const twoInList = await jsend(base, 'POST', { name: 'Mehrfach Fall',
      emails: [{ label: 'Privat', value: 'ohne-at' }, { label: 'L'.repeat(51), value: 'a@x.de' }] });
    assert(twoInList.body.reason === 'contacts_email_invalid', `reason ${twoInList.body.reason}`);
    // Zwei Felder: phones vor emails vor addresses.
    const twoFields = await jsend(base, 'POST', { name: 'Mehrfach Fall',
      addresses: [{ label: 'L'.repeat(51) }], emails: [{ label: 'Privat', value: 'ohne-at' }],
      phones: [{ label: 'Mobil', value: '1'.repeat(101) }] });
    assert(twoFields.body.reason === 'contacts_phone_too_long' && twoFields.body.params?.limit === 100,
      `phones zuerst: ${JSON.stringify(twoFields.body)}`);
    // Ein Einzelfeld scheitert vorher und wird benannt, wie in der ersten Scheibe.
    const single = await jsend(base, 'POST', { name: 'Mehrfach Fall', notes: 'n'.repeat(5001),
      phones: [{ label: 'Mobil', value: '1'.repeat(101) }] });
    assert(single.body.reason === 'contacts_notes_too_long', `Einzelfeld zuerst: ${single.body.reason}`);
    // Die geloeschte Kategorie als einziger Befund der Einzelfelder bleibt ihr Fall.
    const category = await jsend(base, 'POST', { name: 'Mehrfach Fall', category: 'gibt-es-nicht',
      emails: [{ label: 'Privat', value: 'ohne-at' }] });
    assert(category.body.reason === 'contacts_selected_category_not_found', `Kategorie: ${category.body.reason}`);
    // Genau an der Grenze geht es durch.
    const ok = await jsend(base, 'POST', { name: 'Mehrfach Grenze',
      phones: [{ label: 'L'.repeat(50), value: '1'.repeat(100) }],
      emails: [{ label: 'Privat', value: `${'e'.repeat(250)}@x.de` }],
      addresses: [{ label: 'Zuhause', street: 'S'.repeat(255) }] });
    assert(ok.status === 201, `Grenze: ${ok.status} ${JSON.stringify(ok.body)}`);
  });

  await asyncTest('Telefon: Einzelfeld und Liste haben dieselbe Grenze, wie das Formular beide schickt (#1909)', async () => {
    // Das Formular schickt die erste Nummer als `phone` UND als ersten Eintrag
    // von `phones`. Bis hierher liess das Einzelfeld 100 Zeichen zu, die Liste
    // 50: 101 Zeichen hiessen "hoechstens 100", nach dem Kuerzen auf 60
    // "hoechstens 50".
    const formBody = (value) => ({ phone: value, phones: [{ label: 'other', value, isPrimary: true }] });
    for (const length of [60, 100]) {
      const value = '1'.repeat(length);
      const created = await jsend(base, 'POST', { name: `Telefon ${length}`, ...formBody(value) });
      assert(created.status === 201, `POST ${length}: ${created.status} ${JSON.stringify(created.body)}`);
      const id = created.body.data.id;
      const updated = await jsend(`${base}/${id}`, 'PUT', formBody('2'.repeat(length)));
      assert(updated.status === 200, `PUT ${length}: ${updated.status} ${JSON.stringify(updated.body)}`);
      // Die Liste allein, ohne Einzelfeld davor.
      const listOnly = await jsend(`${base}/${id}`, 'PUT', { phones: [{ label: 'other', value: '3'.repeat(length) }] });
      assert(listOnly.status === 200, `PUT nur Liste ${length}: ${listOnly.status} ${JSON.stringify(listOnly.body)}`);
    }
    const tooLong = '1'.repeat(101);
    const expectLimit = (where, res) => {
      assert(res.status === 400, `${where}: Status ${res.status}`);
      assert(res.body.reason === 'contacts_phone_too_long', `${where}: reason ${res.body.reason}`);
      assert(res.body.params?.limit === 100, `${where}: params ${JSON.stringify(res.body.params)}`);
    };
    expectLimit('POST Formular', await jsend(base, 'POST', { name: 'Telefon 101', ...formBody(tooLong) }));
    expectLimit('POST nur Liste', await jsend(base, 'POST', { name: 'Telefon 101', phones: [{ label: 'other', value: tooLong }] }));
    const created = await jsend(base, 'POST', { name: 'Telefon Bearbeiten' });
    expectLimit('PUT Formular', await jsend(`${base}/${created.body.data.id}`, 'PUT', formBody(tooLong)));
    expectLimit('PUT nur Liste', await jsend(`${base}/${created.body.data.id}`, 'PUT', { phones: [{ label: 'other', value: tooLong }] }));
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
