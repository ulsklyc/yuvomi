/**
 * Test: Die Absagen der Budget-Routen sprechen Englisch
 * Zweck: `error` ist Teil der zugesagten `/api/v1`-Oberflaeche. Die App zeigt
 *        ihn seit #1668 nie mehr an (sie liest `reason`), ein API-Client aber
 *        schon - und bekam bis hierher teils deutsche Saetze ("month muss
 *        YYYY-MM sein") und teils Mischsaetze, weil ein deutscher Feldname in
 *        einen englischen Validator gereicht wurde ("Titel is required.").
 *
 *        Zwei Beine, weil jedes fuer sich blind waere:
 *          1. Der echte Budget-Router wird als Programm gefahren. Jede der
 *             unten gefuehrten Anfragen muss abgelehnt werden (4xx), und ihr
 *             Satz darf kein deutsches Wort tragen. Ein Fall, der ploetzlich
 *             durchgeht, ist rot - sonst misst die Zeile nichts mehr.
 *          2. Die Anfrageliste deckt nur, was in ihr steht. Deshalb liest ein
 *             zweiter Test die Saetze und Feldnamen, die die Routen-Dateien
 *             an `error`, `refusal()` und die geteilten Validatoren reichen,
 *             und prueft sie mit DERSELBEN Regel. Er allein waere ein
 *             Textguard; er faengt die Stelle, fuer die noch keine Anfrage
 *             gefuehrt ist.
 *
 *        AUSNAHME, bewusst: "must be one of: <Schluessel>" zaehlt die
 *        erlaubten Werte auf, und die Schluessel der mitgelieferten
 *        Einnahmekategorien sind deutsche Woerter ("Erwerbseinkommen").
 *        Das sind gespeicherte Daten, kein Wortlaut; die Aufzaehlung wird vor
 *        der Pruefung ausgeblendet.
 *
 *        `BUDGET_REFUSALS_DUMP=<datei>` schreibt Status, `reason` und `error`
 *        jeder Anfrage als JSON - fuer den Vorher/Nachher-Vergleich, wenn
 *        jemand den Wortlaut anfasst.
 * Ausführen: npm run test:budget-error-language
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();

const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run().lastInsertRowid;
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'shared')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = ADMIN; req.authRole = 'admin'; req.session = { userId: ADMIN }; next(); });
app.use('/', budgetRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, body) {
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: res.status, body: json };
}

// ── Die eine Regel ────────────────────────────────────────────────────────────
// Umlaute und ß, dazu die Woerter, aus denen die alten Saetze und Feldnamen
// bestanden, und die naheliegenden Nachbarn. Wortgrenzen, damit "Type" nicht an
// "Typ" haengen bleibt. "Name" und "Bank" sind in beiden Sprachen dasselbe Wort.
const GERMAN = new RegExp(
  '[äöüÄÖÜß]|\\b(?:'
  + 'muss|müssen|darf|dürfen|sein|liegen|haben|zwischen|und|oder|nicht|ist|sind|kein|keine|als|'
  + 'ungültig|ungueltig|gültig|gueltig|gefunden|erforderlich|fehlt|groesser|kleiner|höchstens|mindestens|'
  + 'Zeichen|Betrag|Titel|Datum|Monat|Kategorie|Unterkategorie|Intervall|Anzahl|Wiederholung|'
  + 'Konto|Kontotyp|Startsaldo|Kreditlimit|Farbe|Waehrung|Typ|Darlehen|Buchung|Eintrag|Serie'
  + ')\\b',
  'i',
);

/** Die Aufzaehlung erlaubter Werte ist Datenbestand, kein Wortlaut (siehe Kopf). */
const withoutKeyList = (sentence) => sentence.replace(/must be one of: [^.]*\./g, 'must be one of: <keys>.');

function germanIn(sentence) {
  const m = withoutKeyList(sentence).match(GERMAN);
  return m ? m[0] : null;
}

test('die Regel selbst: sie erkennt die alten Saetze und laesst die neuen durch', () => {
  for (const old of [
    'month muss YYYY-MM sein',
    'Betrag muss größer als 0 sein.',
    'range muss week|month|year sein',
    'q muss 1-100 Zeichen haben',
    'Intervall-Anzahl muss zwischen 1 und 99 liegen.',
    'Titel is required.',
    'Kontotyp must be one of: checking, savings.',
    'Typ must be one of: expense, income.',
    'Kreditlimit must not be negative.',
    'Farbe must be a valid HEX color (#RRGGBB).',
  ]) assert.ok(germanIn(old), `nicht erkannt: ${old}`);
  for (const fine of [
    'Title is required.',
    'Type must be one of: expense, income.',
    'Category must be one of: Erwerbseinkommen, Kapitalerträge, food.',
    'Interest rate must be between 0 and 100.',
    'Name is required.',
    'Bank may be at most 100 characters long.',
  ]) assert.equal(germanIn(fine), null, `faelschlich erkannt: ${fine}`);
});

// ── Bein 1: der Router als Programm ───────────────────────────────────────────
test('keine Absage der Budget-Routen traegt deutschen Wortlaut', async () => {
  const seen = [];
  const run = async (label, method, route, body) => {
    const r = await call(method, route, body);
    seen.push({ label, method, route, status: r.status, reason: r.body?.reason ?? null, error: r.body?.error ?? null });
    return r;
  };
  const ok = { title: 'T', amount: -5, date: '2030-01-10' };
  const long = 'x'.repeat(300);

  // Lesewege
  await run('g-summary-month', 'GET', '/summary?month=2030-13-01');
  await run('g-list-month', 'GET', '/?month=nope');
  await run('g-search-empty', 'GET', '/?q=');
  await run('g-search-long', 'GET', `/?q=${long}`);
  await run('g-stats-range', 'GET', '/stats?range=decade');
  await run('g-stats-anchor', 'GET', '/stats?range=month&anchor=nope');
  // Plan
  await run('pl-category', 'PUT', '/plans/nope', { amount: 10 });
  await run('pl-missing', 'PUT', '/plans/food', {});
  await run('pl-nan', 'PUT', '/plans/food', { amount: 'abc' });
  await run('pl-zero', 'PUT', '/plans/food', { amount: 0 });
  // Buchungen
  await run('e-title', 'POST', '/', { amount: -5, date: '2030-01-10' });
  await run('e-title-long', 'POST', '/', { ...ok, title: long });
  await run('e-amount', 'POST', '/', { title: 'T', date: '2030-01-10' });
  await run('e-amount-nan', 'POST', '/', { ...ok, amount: 'abc' });
  await run('e-category', 'POST', '/', { ...ok, category: 'nope' });
  await run('e-date', 'POST', '/', { ...ok, date: 'nope' });
  await run('e-date-missing', 'POST', '/', { title: 'T', amount: -5 });
  await run('e-date-calendar', 'POST', '/', { ...ok, date: '2030-02-31' });
  await run('e-rrule', 'POST', '/', { ...ok, is_recurring: 1, recurrence_rule: 'nope' });
  await run('e-interval', 'POST', '/', { ...ok, is_recurring: 1, recurrence_interval: 'hourly' });
  await run('e-count', 'POST', '/', { ...ok, is_recurring: 1, recurrence_interval_count: 0 });
  await run('e-sub', 'POST', '/', { ...ok, subcategory: 'nope' });
  await run('e-account', 'POST', '/', { ...ok, account_id: 987654 });
  await run('e-account-nan', 'POST', '/', { ...ok, account_id: 'abc' });
  await run('e-all', 'POST', '/', { date: 'nope' });
  const id = (await call('POST', '/', ok)).body.data.id;
  await run('p-title', 'PUT', `/${id}`, { title: long });
  await run('p-amount', 'PUT', `/${id}`, { amount: 'abc' });
  await run('p-category', 'PUT', `/${id}`, { category: 'nope' });
  await run('p-date', 'PUT', `/${id}`, { date: 'nope' });
  await run('p-rrule', 'PUT', `/${id}`, { recurrence_rule: 'nope' });
  await run('p-interval', 'PUT', `/${id}`, { recurrence_interval: 'hourly' });
  await run('p-count', 'PUT', `/${id}`, { recurrence_interval_count: 0 });
  await run('p-sub', 'PUT', `/${id}`, { subcategory: 'nope' });
  await run('p-account', 'PUT', `/${id}`, { account_id: 987654 });
  await run('s-notrec', 'PUT', `/${id}/series`, { title: 'X' });
  await run('sd-notrec', 'DELETE', `/${id}/series`);
  await run('c-booked', 'PATCH', `/${id}/confirm`, {});
  await run('p-404', 'PUT', '/987654', { title: 'X' });
  const rid = (await call('POST', '/', { ...ok, is_recurring: 1, recurrence_interval: 'monthly' })).body.data.id;
  await run('s-title', 'PUT', `/${rid}/series`, { title: long });
  await run('s-amount', 'PUT', `/${rid}/series`, { amount: 'abc' });
  await run('s-category', 'PUT', `/${rid}/series`, { category: 'nope' });
  await run('s-rrule', 'PUT', `/${rid}/series`, { recurrence_rule: 'nope' });
  await run('s-interval', 'PUT', `/${rid}/series`, { recurrence_interval: 'hourly' });
  await run('s-count', 'PUT', `/${rid}/series`, { recurrence_interval_count: 0 });
  await run('s-start', 'PUT', `/${rid}/series`, { start_date: 'nope' });
  await run('s-end', 'PUT', `/${rid}/series`, { is_recurring: false });
  await run('s-account', 'PUT', `/${rid}/series`, { account_id: 987654 });
  const pend = db.prepare("INSERT INTO budget_entries (title, amount, category, subcategory, date, is_pending, created_by, owner_id, visibility) VALUES ('P', -5, 'food', '', '2030-01-10', 1, ?, ?, 'shared')").run(ADMIN, ADMIN).lastInsertRowid;
  await run('c-amount', 'PATCH', `/${pend}/confirm`, { amount: 'abc' });
  await run('c-date', 'PATCH', `/${pend}/confirm`, { date: 'nope' });
  // Konten
  await run('a-name', 'POST', '/accounts', {});
  await run('a-name-long', 'POST', '/accounts', { name: long });
  await run('a-type', 'POST', '/accounts', { name: 'N', type: 'nope' });
  await run('a-balance', 'POST', '/accounts', { name: 'N', starting_balance: 'abc' });
  await run('a-color', 'POST', '/accounts', { name: 'N', color: 'nope' });
  await run('a-bank', 'POST', '/accounts', { name: 'N', credit_bank: long });
  await run('a-limit', 'POST', '/accounts', { name: 'N', credit_limit: 'abc' });
  await run('a-limit-neg', 'POST', '/accounts', { name: 'N', credit_limit: -1 });
  const aid = (await call('POST', '/accounts', { name: 'Giro' })).body.data.id;
  await run('ap-name', 'PUT', `/accounts/${aid}`, { name: '' });
  await run('ap-type', 'PUT', `/accounts/${aid}`, { type: 'nope' });
  await run('ap-balance', 'PUT', `/accounts/${aid}`, { starting_balance: 'abc' });
  await run('ap-color', 'PUT', `/accounts/${aid}`, { color: 'nope' });
  await run('ap-bank', 'PUT', `/accounts/${aid}`, { credit_bank: long });
  await run('ap-limit', 'PUT', `/accounts/${aid}`, { credit_limit: 'abc' });
  await run('ap-limit-neg', 'PUT', `/accounts/${aid}`, { credit_limit: -1 });
  await run('ap-404', 'PUT', '/accounts/987654', { name: 'X' });
  // Kategorien
  await run('k-name', 'POST', '/categories', {});
  await run('k-type', 'POST', '/categories', { name: 'Neu', type: 'nope' });
  const key = (await call('POST', '/categories', { name: 'Probe' })).body.data.key;
  await run('k-dup', 'POST', '/categories', { name: 'probe' });
  await run('kp-name', 'PUT', `/categories/${key}`, { name: '' });
  await run('kr-type', 'PATCH', '/categories/reorder', { type: 'nope', order: [] });
  await run('ks-name', 'POST', `/categories/${key}/subcategories`, {});
  const sub = (await call('POST', `/categories/${key}/subcategories`, { name: 'Unter' })).body.data.key;
  await run('ks-dup', 'POST', `/categories/${key}/subcategories`, { name: 'unter' });
  await run('ksp-name', 'PUT', `/categories/${key}/subcategories/${sub}`, { name: '' });
  await run('k-404', 'PUT', '/categories/nope', { name: 'X' });
  // Darlehen und Raten
  await run('lo-empty', 'POST', '/loans', {});
  await run('lo-direction', 'POST', '/loans', { borrower: 'R', total_amount: 100, installment_count: 1, start_month: '2026-01', direction: 'nope' });
  await run('lo-month', 'POST', '/loans', { borrower: 'R', total_amount: 100, installment_count: 1, start_month: 'nope' });
  await run('lo-count', 'POST', '/loans', { borrower: 'R', total_amount: 100, installment_count: 0, start_month: '2026-01' });
  await run('lo-interest', 'POST', '/loans', { borrower: 'R', start_month: '2026-01', interest_mode: 'annuity', principal: -1 });
  const lid = (await call('POST', '/loans', { borrower: 'R', title: 'R', total_amount: 1200, installment_count: 12, start_month: '2026-01' })).body.data.id;
  await run('lp-title', 'PUT', `/loans/${lid}`, { title: '' });
  await run('lp-amount', 'PUT', `/loans/${lid}`, { total_amount: 'abc' });
  await run('lp-count', 'PUT', `/loans/${lid}`, { installment_count: 0 });
  await run('l-amount', 'POST', `/loans/${lid}/payments`, { amount: 'abc', paid_date: '2026-01-05' });
  await run('l-date', 'POST', `/loans/${lid}/payments`, { amount: 100, paid_date: 'nope' });
  await run('l-number', 'POST', `/loans/${lid}/payments`, { installment_number: 99, amount: 100, paid_date: '2026-01-05' });
  await run('l-zero', 'POST', `/loans/${lid}/payments`, { amount: 0, paid_date: '2026-01-05' });
  await run('l-exceeds', 'POST', `/loans/${lid}/payments`, { amount: 99999, paid_date: '2026-01-05' });
  const pay = await call('POST', `/loans/${lid}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-01-05' });
  assert.equal(pay.status, 201, 'Vorbedingung: die erste Rate wird gebucht');
  await run('l-paid', 'POST', `/loans/${lid}/payments`, { installment_number: 1, amount: 100, paid_date: '2026-01-05' });
  const eid = db.prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE loan_id = ?').get(lid).budget_entry_id;
  await run('p-loan-zero', 'PUT', `/${eid}`, { amount: 0 });
  await run('p-loan-exceeds', 'PUT', `/${eid}`, { amount: 99999 });
  await run('l-404', 'POST', '/loans/987654/payments', { amount: 1, paid_date: '2026-01-05' });

  if (process.env.BUDGET_REFUSALS_DUMP) {
    writeFileSync(process.env.BUDGET_REFUSALS_DUMP, `${JSON.stringify(seen, null, 2)}\n`);
  }

  // Erst die Vorbedingung, dann die Aussage: eine Anfrage, die durchgeht oder
  // ohne Satz abgelehnt wird, hat nichts gemessen.
  const notRefused = seen.filter((s) => s.status < 400 || s.status >= 500 || typeof s.error !== 'string' || !s.error);
  assert.deepEqual(notRefused, [], 'jede gefuehrte Anfrage wird mit einem Satz abgelehnt');

  const german = seen
    .map((s) => ({ ...s, word: germanIn(s.error) }))
    .filter((s) => s.word)
    .map((s) => `${s.label} (${s.method} ${s.route.slice(0, 40)}): "${s.error.slice(0, 120)}" - deutsch: "${s.word}"`);
  assert.deepEqual(german, [], `Absagen mit deutschem Wortlaut:\n  ${german.join('\n  ')}`);
});

// ── Bein 2: was die Dateien an Saetzen und Feldnamen hinausreichen ────────────
// Gelesen werden nur Zeilen, an denen ein Satz die Datei Richtung Antwort
// verlaesst: ein `error:`, ein `refusal(`, ein Aufruf eines geteilten
// Validators (dessen zweites Argument als Feldname im Satz landet). Kommentare
// bleiben deutsch und zaehlen nicht.
const OUTBOUND = /\berror:|\brefusal\(|\b(?:str|num|oneOf|rrule|collectErrors|validateDate|validateMonth|validateColor)\(/;
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

function outboundLiterals(source) {
  const found = [];
  source.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (!OUTBOUND.test(line)) return;
    for (const m of line.matchAll(LITERAL)) found.push({ line: i + 1, text: m[1] ?? m[2] });
  });
  return found;
}

test('kein Satz und kein Feldname, den die Budget-Routen hinausreichen, ist deutsch', () => {
  const dir = new URL('../server/routes/budget/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, `Vorbedingung: die Routen-Dateien sind da (${files.length})`);
  let read = 0;
  const offenders = [];
  for (const file of files) {
    for (const lit of outboundLiterals(readFileSync(new URL(file, dir), 'utf8'))) {
      read += 1;
      const word = germanIn(lit.text);
      if (word) offenders.push(`${file}:${lit.line} "${lit.text.slice(0, 100)}" - deutsch: "${word}"`);
    }
  }
  assert.ok(read > 100, `Vorbedingung: der Leser findet die Saetze ueberhaupt (${read})`);
  assert.deepEqual(offenders, [], `deutsche Saetze oder Feldnamen:\n  ${offenders.join('\n  ')}`);
});
