/**
 * Test: Telefon-Anzeige-/Hilfsschicht (Frontend-Wrapper) + Server-E.164 + Phase-2
 * (value_e164-Backfill & format-unabhängiges CardDAV-Matching).
 *
 * Netz-frei: der Frontend-Wrapper wird über die self-gehostete Vendor-Kopie
 * (public/vendor/libphonenumber/) geprimt; der Server nutzt das npm-Paket.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import * as core from '../public/vendor/libphonenumber/core.min.mjs';
import {
  __primePhoneLib, formatPhoneDisplay, toTelHref, isPlausiblePhone, countryFromRegion,
} from '../public/utils/phone.js';
import { toE164, defaultCountryFromConfig, countryFromRegion as srvCountryFromRegion } from '../server/utils/phone.js';
import { MIGRATIONS, _setTestDatabase, _resetTestDatabase } from '../server/db.js';
import { parseAndMergeContact } from '../server/services/cardav-sync.js';

const metadata = JSON.parse(
  readFileSync(new URL('../public/vendor/libphonenumber/metadata.min.json', import.meta.url), 'utf8')
);

// Baut eine vollständige In-Memory-DB durch Anwenden ALLER Migrationen (wie die
// echte migrate()). So bleibt das Test-Schema produktionstreu.
function buildFullDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
  }
  return db;
}

// ------------------------------------------------------------------
// Phase 1 - Frontend-Wrapper (geprimt gegen die Vendor-Kopie, net-frei)
// ------------------------------------------------------------------
describe('phone.js (Frontend-Wrapper)', () => {
  before(() => {
    __primePhoneLib({
      parse: core.parsePhoneNumberFromString,
      AsYouType: core.AsYouType,
      isPossible: core.isPossiblePhoneNumber,
      metadata,
    });
  });

  it('formatiert national bei gleichem Land', async () => {
    assert.equal(await formatPhoneDisplay('030 12345678', 'DE'), '030 12345678');
    assert.equal(await formatPhoneDisplay('+493012345678', 'DE'), '030 12345678');
  });

  it('formatiert international bei fremdem Land', async () => {
    assert.equal(await formatPhoneDisplay('+12025550173', 'DE'), '+1 202 555 0173');
  });

  it('gibt nicht-parsbare Werte 1:1 als Rohwert zurück', async () => {
    assert.equal(await formatPhoneDisplay('kein Anschluss', 'DE'), 'kein Anschluss');
    assert.equal(await formatPhoneDisplay('', 'DE'), '');
  });

  it('tel:-Link nutzt bevorzugt E.164', async () => {
    assert.equal(await toTelHref('030 12345678', 'DE'), 'tel:+493012345678');
    assert.equal(await toTelHref('+1 202 555 0173', 'DE'), 'tel:+12025550173');
  });

  it('tel:-Link fällt bei nicht-parsbarem Wert auf den Rohwert zurück', async () => {
    // Reiner Text ohne Ziffern ist nicht parsebar → Rohwert bleibt erhalten.
    assert.equal(await toTelHref('Durchwahl', 'DE'), 'tel:Durchwahl');
  });

  it('Plausibilität ist unverbindlich und nie blockierend', async () => {
    assert.equal(await isPlausiblePhone('030 12345678', 'DE'), true);
    assert.equal(await isPlausiblePhone('1', 'DE'), false);     // zu kurz
    assert.equal(await isPlausiblePhone('', 'DE'), true);       // leer → kein Warnhinweis
  });

  it('countryFromRegion leitet ISO-Land aus BCP-47 ab', () => {
    assert.equal(countryFromRegion('de-DE'), 'DE');
    assert.equal(countryFromRegion('en-US'), 'US');
    assert.equal(countryFromRegion('custom'), null);
    assert.equal(countryFromRegion(''), null);
    assert.equal(countryFromRegion(null), null);
  });

  it('degradiert zum Rohwert, wenn die Lib nicht ladbar ist (offline)', async () => {
    __primePhoneLib(null); // erzwingt Import-Fehler von /vendor/... in Node → Fallback
    assert.equal(await formatPhoneDisplay('030 12345678', 'DE'), '030 12345678');
    assert.equal(await isPlausiblePhone('1', 'DE'), true); // ohne Lib nie warnen
    // wieder primen für nachfolgende (Reihenfolge-unabhängige) Läufe
    __primePhoneLib({
      parse: core.parsePhoneNumberFromString, AsYouType: core.AsYouType,
      isPossible: core.isPossiblePhoneNumber, metadata,
    });
  });
});

// ------------------------------------------------------------------
// Phase 2 - Server-E.164-Util
// ------------------------------------------------------------------
describe('server/utils/phone.js (E.164)', () => {
  it('berechnet E.164 nur für plausible Nummern', () => {
    assert.equal(toE164('030 12345678', 'DE'), '+493012345678');
    assert.equal(toE164('+49 30 12345678', undefined), '+493012345678'); // intl braucht kein Default
    assert.equal(toE164('foobar', 'DE'), null);
    assert.equal(toE164('', 'DE'), null);
    assert.equal(toE164(null, 'DE'), null);
  });

  it('zwei Format-Varianten derselben Nummer ergeben dieselbe E.164', () => {
    assert.equal(toE164('030 12345678', 'DE'), toE164('+49 30 12345678', 'DE'));
  });

  it('defaultCountryFromConfig bevorzugt region, sonst holiday_country', () => {
    const mk = (map) => ({ prepare: () => ({ get: (k) => (k in map ? { value: map[k] } : undefined) }) });
    assert.equal(defaultCountryFromConfig(mk({ region: 'de-DE' })), 'DE');
    assert.equal(defaultCountryFromConfig(mk({ region: '', holiday_country: 'FR' })), 'FR');
    assert.equal(defaultCountryFromConfig(mk({})), null);
    assert.equal(srvCountryFromRegion('en-GB'), 'GB');
  });
});

// ------------------------------------------------------------------
// Phase 2 - Backfill (Migration 95) & Datenerhalt
// ------------------------------------------------------------------
describe('Migration 95 Backfill (value_e164)', () => {
  it('setzt value_e164 nur wo parsebar und lässt value unangetastet', () => {
    const db = buildFullDb();
    db.prepare("INSERT INTO sync_config (key, value) VALUES ('region', 'de-DE')").run();
    const cid = db.prepare("INSERT INTO contacts (name, category) VALUES ('A', 'misc')").run().lastInsertRowid;
    // Rohwerte OHNE value_e164 (simuliert Bestand vor Phase 2).
    const raw1 = '030 12345678';
    const raw2 = '+49 30 12345678';
    const raw3 = 'Durchwahl 5';               // nicht parsebar → bleibt NULL
    for (const v of [raw1, raw2, raw3]) {
      db.prepare("INSERT INTO contact_phones (contact_id, label, value, is_primary) VALUES (?, 'x', ?, 0)").run(cid, v);
    }
    db.prepare('UPDATE contact_phones SET value_e164 = NULL').run(); // Backfill-Ausgangslage

    const migration95 = MIGRATIONS.find((m) => m.version === 95);
    migration95.afterUp(db);

    const rows = db.prepare('SELECT value, value_e164 FROM contact_phones ORDER BY id').all();
    // value byte-genau erhalten
    assert.deepEqual(rows.map((r) => r.value), [raw1, raw2, raw3]);
    // parsebare → E.164, nicht parsebare → NULL
    assert.equal(rows[0].value_e164, '+493012345678');
    assert.equal(rows[1].value_e164, '+493012345678');
    assert.equal(rows[2].value_e164, null);
    db.close();
  });
});

// ------------------------------------------------------------------
// Phase 2 - CardDAV-Matching (erweitert, nicht ersetzt)
// ------------------------------------------------------------------
describe('CardDAV-Matching mit value_e164', () => {
  const vcard = (uid, tel) =>
    `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Max Muster\r\nN:Muster;Max;;;\r\nTEL;TYPE=CELL:${tel}\r\nEND:VCARD`;

  function setup(regionValue) {
    const db = buildFullDb();
    if (regionValue) db.prepare("INSERT INTO sync_config (key, value) VALUES ('region', ?)").run(regionValue);
    const accId = db.prepare(
      "INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('acc', 'https://d.example/dav/', 'u', 'p')"
    ).run().lastInsertRowid;
    db.prepare(
      "INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name) VALUES (?, ?, 'AB')"
    ).run(accId, 'https://d.example/dav/ab/');
    _setTestDatabase(db);
    return { db, accId, ab: 'https://d.example/dav/ab/' };
  }

  it('Format-Varianten derselben Nummer verschmelzen (kein Duplikat)', async () => {
    const { db, accId, ab } = setup('de-DE');
    // Erster Kontakt: internationale Schreibweise.
    await parseAndMergeContact(vcard('uid-1', '+49 30 12345678'), accId, ab);
    // Zweiter Import: andere UID, SELBE Nummer in nationaler Schreibweise.
    await parseAndMergeContact(vcard('uid-2', '030 12345678'), accId, ab);

    const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
    assert.equal(count, 1, 'Format-Varianz darf keinen Zweitkontakt anlegen');
    _resetTestDatabase();
    db.close();
  });

  it('NULL value_e164 fällt sauber auf den exakten Rohwert-Vergleich zurück', async () => {
    const { db, accId, ab } = setup(null); // kein Default-Land → nationale Nr. nicht parsebar
    // Nicht parsebare, aber identische Rohwerte → Match über cp.value (Fallback).
    await parseAndMergeContact(vcard('uid-1', 'Durchwahl-42'), accId, ab);
    await parseAndMergeContact(vcard('uid-2', 'Durchwahl-42'), accId, ab);

    const phones = db.prepare('SELECT value, value_e164 FROM contact_phones').all();
    assert.ok(phones.every((p) => p.value_e164 === null), 'nicht parsebar → value_e164 NULL');
    const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
    assert.equal(count, 1, 'exakter Rohwert-Match verhindert Duplikat auch ohne E.164');
    _resetTestDatabase();
    db.close();
  });
});
