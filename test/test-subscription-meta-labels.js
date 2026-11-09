/**
 * Modul: Abos - Kategorien und Zahlungsarten sprechen die Lesersprache
 * Zweck: Die Vorgabezeilen beider Listen stehen als englischer TEXT in der
 *        Datenbank ('Credit Card', 'Entertainment'). Wer sie anzeigen will,
 *        braucht einen Schluessel, keinen Namensabgleich.
 *
 *        Anlass (#950, 2026-08-30): Im Feld "Kategorien und Zahlungsarten
 *        verwalten" standen die Kategorien auf Spanisch und die Zahlungsarten
 *        daneben auf Englisch. Es war nie eine zweite Uebersetzung noetig,
 *        sondern die erste an der falschen Stelle - die Kategorien hatten im
 *        Frontend eine Karte von englischen Namen auf i18n-Schluessel, die
 *        Zahlungsarten keine. Eine solche Karte kann ausserdem nicht wissen,
 *        ob 'Other' die Vorgabe oder eine selbst angelegte Zeile desselben
 *        Namens meint.
 *
 *        Seit Migration 170 tragen beide Tabellen `label_key`, wie
 *        task_categories, contact_categories und inventory_categories es
 *        laengst tun. Diese Suite haelt die drei Zusagen fest, die daran
 *        haengen: der Schluessel EXISTIERT in den Locales, er REIST mit
 *        (Metadaten, Abo-Zeile, Aufschluesselung), und Umbenennen LOESCHT ihn.
 * Ausfuehren: node --test test/test-subscription-meta-labels.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';

import { freshTestDbPath } from './tmp-db.js';
freshTestDbPath('subscription-meta-labels');
process.env.SESSION_SECRET = 'subscription-meta-labels-session-secret-32';

const db = await import('../server/db.js');
const { default: subscriptionsRouter } = await import('../server/routes/subscriptions.js');

db.init();
const database = db.get();

// Ein Abo haengt an seinem Ersteller (FK auf users). Ohne diese Zeile schlaegt
// jedes POST mit FOREIGN KEY constraint failed fehl - und zwar mit HTTP 500,
// also ohne zu sagen, was fehlt.
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'admin')").run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
app.use('/subscriptions', subscriptionsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/subscriptions`;

const req = async (method, subPath, body) => {
  const res = await fetch(`${baseUrl}${subPath}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const locale = (lang) => JSON.parse(fs.readFileSync(new URL(`../public/locales/${lang}.json`, import.meta.url), 'utf8'));
const lookup = (json, key) => key.split('.').reduce((o, k) => o?.[k], json);

test('jede Vorgabezeile traegt einen Schluessel, jede davon steht in ALLEN Locales', () => {
  const rows = [
    ...database.prepare('SELECT name, label_key FROM subscription_categories').all(),
    ...database.prepare('SELECT name, label_key FROM subscription_payment_methods').all(),
  ];
  // Ohne diese Probe waeren die Zusicherungen darunter gruen ueber einer
  // leeren Liste - eine Assertion ueber nichts ist keine Zusicherung.
  assert.ok(rows.length >= 13, `nur ${rows.length} Vorgabezeilen - wurden sie noch geseedet?`);

  const ohneSchluessel = rows.filter((r) => !r.label_key).map((r) => r.name);
  assert.deepEqual(ohneSchluessel, [],
    'Diese Vorgabezeilen haben keinen label_key und stuenden damit in jeder Oberflaeche\n'
    + 'auf Englisch da. Migration 170 setzt ihn ueber den Namen - eine neue Vorgabe braucht\n'
    + 'eine neue Migration, die ihren Schluessel nachtraegt.');

  const langs = fs.readdirSync(new URL('../public/locales/', import.meta.url))
    .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  assert.ok(langs.length >= 20, `nur ${langs.length} Locales gefunden - stimmt der Pfad noch?`);

  const fehlend = [];
  for (const lang of langs) {
    const json = locale(lang);
    for (const row of rows) {
      const value = lookup(json, row.label_key);
      if (!value) fehlend.push(`${lang}: ${row.label_key}`);
    }
  }
  assert.deepEqual(fehlend, [],
    'Ein label_key ohne Wert in einer Sprache faellt dort auf den nackten Schluesselnamen\n'
    + 'zurueck - sichtbar als "subscriptions.paymentMethodCreditCard" in der Oberflaeche.');
});

test('der Schluessel reist mit: Metadaten, Abo-Zeile und Aufschluesselung', async () => {
  const meta = await req('GET', '/meta');
  assert.equal(meta.status, 200);
  const creditCard = meta.body.data.payment_methods.find((m) => m.name === 'Credit Card');
  const entertainment = meta.body.data.categories.find((c) => c.name === 'Entertainment');
  assert.equal(creditCard.label_key, 'subscriptions.paymentMethodCreditCard');
  assert.equal(entertainment.label_key, 'budget.subcatSubscriptionEntertainment');

  const created = await req('POST', '', {
    name: 'Streaming', amount: 10, currency: 'EUR', billing_cycle: 'monthly',
    next_payment_date: '2027-01-15', category_id: entertainment.id, payment_method_id: creditCard.id,
  });
  assert.equal(created.status, 201);

  const list = await req('GET', '');
  const row = list.body.data.subscriptions.find((s) => s.id === created.body.data.id);
  assert.equal(row.payment_method_label_key, 'subscriptions.paymentMethodCreditCard',
    'die Abo-Zeile fuehrt den Schluessel denormalisiert neben dem Namen mit');
  assert.equal(row.category_label_key, 'budget.subcatSubscriptionEntertainment');

  const byMethod = list.body.data.summary.by_payment_method.find((e) => e.id === creditCard.id);
  assert.equal(byMethod.label_key, 'subscriptions.paymentMethodCreditCard');
  assert.equal(byMethod.amount, 10);
});

test('die Sammelposition erfindet kein englisches Wort', async () => {
  // Hier stand `row.payment_method_name || 'Unspecified'`: ein Anzeigetext im
  // Datenfeld, den kein Klient uebersetzen konnte - eine spanische Oberflaeche
  // las "Unspecified". Die Sammelposition traegt jetzt id/name/label_key auf
  // null und ueberlaesst das Wort dem Leser.
  const ohne = await req('POST', '', {
    name: 'Ohne Zuordnung', amount: 5, currency: 'EUR', billing_cycle: 'monthly',
    next_payment_date: '2027-02-20',
  });
  assert.equal(ohne.status, 201);

  const list = await req('GET', '');
  const sammel = list.body.data.summary.by_payment_method.find((e) => e.id === null);
  assert.ok(sammel, 'ein Abo ohne Zahlungsart braucht eine Sammelposition');
  assert.equal(sammel.name, null);
  assert.equal(sammel.label_key, null);
  assert.equal(sammel.amount, 5);

  const sammelKat = list.body.data.summary.by_category.find((e) => e.id === null);
  assert.equal(sammelKat.name, null);
  assert.equal(sammelKat.label_key, null);

  for (const eintrag of [...list.body.data.summary.by_category, ...list.body.data.summary.by_payment_method]) {
    assert.ok(!['Uncategorized', 'Unspecified'].includes(eintrag.name),
      `"${eintrag.name}" ist ein Anzeigetext im Datenfeld - er gehoert dem Leser, nicht der Antwort`);
  }
});

test('Umbenennen loescht den Schluessel, der eigene Name gilt', async () => {
  const meta = await req('GET', '/meta');
  const paypal = meta.body.data.payment_methods.find((m) => m.name === 'PayPal');
  const utilities = meta.body.data.categories.find((c) => c.name === 'Utilities');

  const umbenannt = await req('PUT', `/payment-methods/${paypal.id}`, { name: 'Hauskasse' });
  assert.equal(umbenannt.status, 200);
  assert.equal(umbenannt.body.data.name, 'Hauskasse');
  assert.equal(umbenannt.body.data.label_key, null,
    'ein umbenannter Eintrag darf nicht weiter uebersetzt werden - sonst kaeme der alte Name zurueck');

  const kat = await req('PUT', `/categories/${utilities.id}`, { name: 'Nebenkosten', color: '#334155' });
  assert.equal(kat.status, 200);
  assert.equal(kat.body.data.label_key, null);

  const neu = await req('POST', '/payment-methods', { name: 'Bargeld' });
  assert.equal(neu.status, 201);
  assert.equal(neu.body.data.label_key, null, 'eine selbst angelegte Zeile traegt nie einen Schluessel');

  // Eine eigene Zeile, die zufaellig wie eine Vorgabe heisst, bleibt eigen -
  // genau das konnte die alte Namenskarte im Frontend nicht auseinanderhalten.
  const gleichnamig = await req('POST', '/payment-methods', { name: 'Bank Transfer 2' });
  assert.equal(gleichnamig.body.data.label_key, null);
});

test('ein Farbwechsel ist keine Umbenennung - der Schluessel bleibt', async () => {
  // DER VERWALTEN-DIALOG SCHICKT NAME UND FARBE ZUSAMMEN, auch wenn nur die
  // Farbe angefasst wurde; der Klient reicht dazu den Kanon-Namen unveraendert
  // zurueck (data-original-name). Ein `label_key = NULL` bei JEDEM Speichern
  // haette die Seed-Kategorien beim ersten Farbwechsel auf die Sprache dieses
  // Klienten festgenagelt - derselbe Verlust, den Migration 143 beim Inventar
  // behoben hat. Der erste Wurf dieses Fixes hatte genau den Fehler.
  const meta = await req('GET', '/meta');
  const health = meta.body.data.categories.find((c) => c.name === 'Health');
  assert.equal(health.label_key, 'budget.subcatSubscriptionHealth');

  const nurFarbe = await req('PUT', `/categories/${health.id}`, { name: 'Health', color: '#123456' });
  assert.equal(nurFarbe.status, 200);
  assert.equal(nurFarbe.body.data.color, '#123456');
  assert.equal(nurFarbe.body.data.label_key, 'budget.subcatSubscriptionHealth',
    'unveraenderter Name → der Schluessel bleibt, sonst heisst die Kategorie fortan "Health" statt "Gesundheit"');

  // Dieselbe Zusicherung fuer die Zahlungsarten: ein Speichern ohne echte
  // Aenderung darf nichts kosten.
  const apple = meta.body.data.payment_methods.find((m) => m.name === 'Apple Pay');
  const gleich = await req('PUT', `/payment-methods/${apple.id}`, { name: 'Apple Pay' });
  assert.equal(gleich.status, 200);
  assert.equal(gleich.body.data.label_key, 'subscriptions.paymentMethodApplePay');

  // Und die Gegenprobe: ein WIRKLICH anderer Name loest den Schluessel weiterhin.
  const echt = await req('PUT', `/categories/${health.id}`, { name: 'Gesundheitskram', color: '#123456' });
  assert.equal(echt.body.data.label_key, null);
});

test('der Backfill trifft nur die UNVERAENDERTE Vorgabe (#950)', () => {
  // GEFUNDEN IN DER PR-DURCHSICHT. Der erste Wurf glich nur den Namen ab. Zwei
  // Faelle gehen damit falsch aus, und beide sind still:
  //
  //   (1) Wer eine Vorgabe LOESCHT und danach eine eigene Kategorie desselben
  //       Namens anlegt, bekaeme einen Schluessel aufgedrueckt - sein
  //       gewaehlter Name waere durch Uebersetzungen ersetzt. (Ohne das
  //       Loeschen geht es gar nicht: `name` ist UNIQUE COLLATE NOCASE.)
  //   (2) Wer eine Vorgabe UMBENENNT, behaelt seinen Namen - den trifft der
  //       Namensabgleich schon nicht. Ein Anker allein ueber
  //       `budget_subcategory_key` wuerde ihn aber treffen, denn der Schluessel
  //       bleibt an der Zeile.
  //
  // Erst BEIDE Bedingungen zusammen treffen genau die unveraenderte Vorgabe.
  // Die Migration schreibt je ein UPDATE pro Vorgabe - hier stehen alle sechs,
  // damit der Test wirklich das nachvollzieht, was laeuft, und nicht einen
  // Ausschnitt davon.
  const PAARE = [
    ['subscription_entertainment', 'Entertainment', 'budget.subcatSubscriptionEntertainment'],
    ['subscription_productivity',  'Productivity',  'budget.subcatSubscriptionProductivity'],
    ['subscription_utilities',     'Utilities',     'budget.subcatSubscriptionUtilities'],
    ['subscription_health',        'Health',        'budget.subcatSubscriptionHealth'],
    ['subscription_education',     'Education',     'budget.subcatSubscriptionEducation'],
    ['subscription_other',         'Other',         'budget.subcatSubscriptionOther'],
  ];
  const backfill = () => {
    for (const [key, name, labelKey] of PAARE) {
      database.prepare('UPDATE subscription_categories SET label_key = ? WHERE budget_subcategory_key = ? AND name = ?')
        .run(labelKey, key, name);
    }
  };

  // (1) Vorgabe weg, eigene Zeile mit demselben Namen und eigenem Schluessel.
  database.prepare("DELETE FROM subscription_categories WHERE budget_subcategory_key = 'subscription_education'").run();
  const eigene = database.prepare(
    "INSERT INTO subscription_categories (name, color, sort_order, budget_subcategory_key) VALUES ('Education', '#D97706', 99, 'subscription_category_99')"
  ).run().lastInsertRowid;

  // (2) Vorgabe umbenannt - Schluessel bleibt, Name nicht.
  database.prepare("UPDATE subscription_categories SET name = 'Krimskrams', label_key = NULL WHERE budget_subcategory_key = 'subscription_other'").run();
  const umbenannt = database.prepare("SELECT id FROM subscription_categories WHERE budget_subcategory_key = 'subscription_other'").get().id;

  backfill();

  const lies = (id) => database.prepare('SELECT name, label_key FROM subscription_categories WHERE id = ?').get(id);
  assert.equal(lies(eigene).label_key, null,
    'eine selbst angelegte Kategorie mit einem Vorgabe-NAMEN darf keinen Schluessel bekommen');
  assert.equal(lies(umbenannt).label_key, null,
    'eine umbenannte Vorgabe behaelt ihren Namen - der Schluessel allein darf sie nicht zurueckholen');

  // (3) UND DIE PAARUNG SELBST. Zwei getrennte IN-Listen haetten die beiden
  // Faelle oben zwar abgefangen, aber nicht diesen: wer eine Vorgabe loescht
  // und eine ANDERE auf den frei gewordenen Namen umbenennt, erfuellt beide
  // Listen - und bekaeme die Beschriftung seines ALTEN Schluessels. Die Zeile
  // hiesse fortan "Produktivitaet", obwohl er "Education" geschrieben hat.
  // Gefunden in der PR-Durchsicht, erst nachdem (1) und (2) behoben waren.
  //
  // 'Education' ist durch (1) frei; 'Productivity' steht noch unveraendert da
  // und bekommt diesen Namen. Die Zusicherung darf dabei NICHT in einem `if`
  // stehen: die erste Fassung dieses Falls baute auf einer Zeile auf, die (1)
  // geloescht hatte - der Block lief nie, und die Gegenprobe blieb gruen.
  database.prepare('DELETE FROM subscription_categories WHERE id = ?').run(eigene);
  database.prepare("UPDATE subscription_categories SET name = 'Education', label_key = NULL WHERE budget_subcategory_key = 'subscription_productivity'").run();
  const gekreuzt = database.prepare("SELECT id FROM subscription_categories WHERE budget_subcategory_key = 'subscription_productivity'").get();
  assert.ok(gekreuzt, 'ohne diese Zeile prueft die Zusicherung darunter nichts');

  backfill();
  assert.equal(lies(gekreuzt.id).label_key, null,
    'ein Schluessel darf nur mit SEINEM eigenen Namen zusammen greifen, nicht mit irgendeinem aus der Liste');

  // Gegenprobe: eine unveraenderte Vorgabe traegt ihn weiterhin.
  const echt = database.prepare(
    "SELECT label_key FROM subscription_categories WHERE budget_subcategory_key = 'subscription_entertainment' AND name = 'Entertainment'"
  ).get();
  assert.equal(echt.label_key, 'budget.subcatSubscriptionEntertainment');
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  db.get().close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  }
});
