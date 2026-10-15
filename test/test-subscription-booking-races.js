/**
 * Test: die Buchung eines Abos im Rennen um den Wechselkurs (#2004)
 * Modul: server/routes/subscriptions.js (syncBudgetExpense, POST /, PUT /:id,
 *        POST /:id/renew)
 *
 * Ein Abo in fremder Waehrung holt vor seiner Buchung den Kurs - ein await.
 * In dieser Luecke laufen andere Requests fuer dasselbe Abo. Gemessen wird
 * jedes Rennen ueber den echten Router auf einer In-Memory-DB; die Kurse
 * kommen ueber `_setRatesForTest` aus einem Tor, das jeden Abruf festhaelt,
 * bis der Test ihn freigibt. So steht die konkurrierende Anfrage GENAU in der
 * Luecke, und die Reihenfolge, in der die Kurse zurueckkommen, waehlt der
 * Test - jedes Rennen laeuft in beiden Reihenfolgen und muss gleich enden.
 *
 *  6. Sichtbarkeit wechselt in der Luecke (Datenschutz, zuerst): ein privates
 *     Abo darf keine geteilte Buchung behalten - auch nicht beim Anlegen.
 *  1. Verlaengern gegen Speichern: je eine Buchung am bezahlten und am neuen Tag.
 *  2. Pause waehrend Verlaengern: die bezahlte Buchung bleibt.
 *  3. Pause waehrend Speichern: ein pausiertes Abo behaelt keine Buchung.
 *  4. Zwei Betraege kommen verkehrt herum zurueck: es gilt der Betrag des Abos.
 *  5. Waehrungswechsel in der Luecke: Betrag und Titel in der neuen Waehrung.
 *  5b. Die Budget-Waehrung wechselt in der Luecke: niemand bucht danach nach,
 *     also muss der wartende Sync den Kurs neu holen.
 *  Dazu: zweimal Verlaengern (auf main zeigte das Abo je nach Reihenfolge auf
 *  die mittlere Buchung) und, dass das Design nicht schlechter endet als main:
 *  Verlaengern in der Luecke eines PUT, Betrag auf BEIDEN Buchungen.
 *
 * Ausfuehren: TZ=UTC npm run test:subscription-booking-races
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.FIXER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const routes = await import('../server/routes/subscriptions.js');
const db = dbmod.get();

const user = (name, role) => db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
).run(name, name, 'x', role).lastInsertRowid;
const ADA = user('ada', 'member');
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', 'EUR')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'shared')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

// Der Nutzer kommt aus dem Header, nicht aus einer Variablen: zwei Requests
// sind hier gleichzeitig unterwegs.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = Number(req.get('x-test-user')) || ADA;
  req.authUserId = id; req.authRole = 'member'; req.session = { userId: id, role: 'member' };
  next();
});
app.use('/', routes.default);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => { routes._setRatesForTest(null); server.close(); });

async function call(method, route, body) {
  const headers = { 'x-test-user': String(ADA) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Wert je Waehrung in EUR; ein Abruf liefert wie getRates nur die erfragte
// Waehrung, relativ zur Basis - ein Kurs je Paar, wie ihn der Cache liefert.
const RATES = { EUR: 1, USD: 0.5, GBP: 2 };
const ratesAnswer = (base, list) => ({
  rates: Object.fromEntries([[base, 1], ...list.map((c) => [c, RATES[c] / RATES[base]])]),
  source: 'cache', fetchedAt: null,
});
const plainRates = async (base, list) => ratesAnswer(base, list);

/**
 * Das Tor vor den Kursen. Jeder Abruf wartet, bis der Test ihn freigibt;
 * `auto` gibt alles frei, was danach noch kommt (ein Neuversuch nach einem
 * Waehrungswechsel holt den Kurs ein zweites Mal).
 */
function rateGate() {
  const pending = [];
  let auto = false;
  routes._setRatesForTest(async (base, list) => {
    if (!auto) {
      await new Promise((release) => pending.push({ currency: list[0], release }));
    }
    return ratesAnswer(base, list);
  });
  return {
    pending,
    async waitFor(n) {
      for (let i = 0; i < 400 && pending.length < n; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.ok(pending.length >= n, `es warten ${pending.length} statt ${n} Kursabrufe`);
    },
    release(index) { pending[index].release(); },
    autoRelease() { auto = true; for (const p of pending) p.release(); },
  };
}

const ORDERS = [['zweiter zuerst', [1, 0]], ['erster zuerst', [0, 1]]];

/**
 * Nach dem Freigeben eines Kurses: warten, bis DIESER Request fertig ist oder
 * einen weiteren Kurs anfragt (Neuversuch nach Waehrungswechsel). Keine feste
 * Wartezeit - sonst waeren "beide Reihenfolgen" nur ein Wettlauf mit der Uhr.
 */
async function released(promise, gate, before) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  while (!done && gate.pending.length <= before) await new Promise((r) => setTimeout(r, 2));
}

/**
 * Zwei Requests in der Luecke: `first` wartet auf seinen Kurs, dann kommt
 * `second`. Beide werden in `order` freigegeben (Index 0 = first). Laeuft
 * `second` ohne Kurs durch (Pause, gleiche Waehrung), steht `secondAwaits` auf
 * false; dann wird nur `first` freigegeben.
 */
async function race({ first, second, order, secondAwaits = true }) {
  const gate = rateGate();
  const results = [];
  let pFirst; let pSecond;
  try {
    pFirst = first();
    await gate.waitFor(1);
    pSecond = second();
    if (secondAwaits) await gate.waitFor(2);
    if (secondAwaits) {
      const promises = [pFirst, pSecond];
      for (const index of order) {
        const before = gate.pending.length;
        gate.release(index);
        await released(promises[index], gate, before);
      }
    } else {
      results[1] = await pSecond;
      gate.release(0);
    }
  } finally {
    // Auch wenn eine Vorbedingung scheitert: nichts bleibt am Tor haengen.
    gate.autoRelease();
    results[0] = await pFirst;
    if (pSecond) results[1] = await pSecond;
    routes._setRatesForTest(null);
  }
  for (const r of results) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return results;
}

let seq = 0;
async function abo(extra = {}) {
  routes._setRatesForTest(plainRates);
  seq += 1;
  const r = await call('POST', '/', {
    name: `Abo${seq}`, amount: 10, currency: 'USD', billing_cycle: 'monthly',
    next_payment_date: '2030-01-15', visibility: 'shared', ...extra,
  });
  routes._setRatesForTest(null);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
const bookings = (row) => db.prepare(
  "SELECT id, title, amount, date, owner_id, visibility FROM budget_entries WHERE title LIKE ? ORDER BY date, id",
).all(`${row.name}%`);
const subRow = (id) => db.prepare('SELECT * FROM budget_subscriptions WHERE id = ?').get(id);

// --- 6. Datenschutz zuerst ---------------------------------------------------

test('6. privat geschaltet, waehrend ein anderer Speichervorgang auf den Kurs wartet - die Buchung wird privat, in jeder Reihenfolge', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    await race({
      first: () => call('PUT', `/${a.id}`, { amount: 20 }),
      second: () => call('PUT', `/${a.id}`, { visibility: 'private' }),
      order,
    });
    const s = subRow(a.id);
    assert.equal(s.visibility, 'private', label);
    const rows = bookings(a);
    assert.equal(rows.length, 1, `${label}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].visibility, 'private', `${label}: ein privates Abo hat eine ${rows[0].visibility}-Buchung`);
    assert.equal(rows[0].owner_id, s.owner_id, label);
    assert.equal(rows[0].id, s.budget_entry_id, label);
  }
});

test('6. privat geschaltet, waehrend das Anlegen auf den Kurs wartet - die erste Buchung ist schon privat', async () => {
  const gate = rateGate();
  seq += 1;
  const name = `Neu${seq}`;
  const pPost = call('POST', '/', { name, amount: 10, currency: 'USD', billing_cycle: 'monthly', next_payment_date: '2030-01-15', visibility: 'shared' });
  await gate.waitFor(1);
  const id = db.prepare('SELECT id FROM budget_subscriptions WHERE name = ?').get(name).id;
  // Sichtbarkeit direkt umschalten: ein PUT in gleicher Waehrung liefe ohne Kurs.
  const put = call('PUT', `/${id}`, { visibility: 'private' });
  await gate.waitFor(2);
  const before = gate.pending.length;
  gate.release(1);
  await released(put, gate, before);
  gate.release(0);
  gate.autoRelease();
  const [post, after] = [await pPost, await put];
  routes._setRatesForTest(null);
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal(after.status, 200);
  const rows = bookings({ name });
  assert.deepEqual(rows.map((r) => r.visibility), ['private'], JSON.stringify(rows));
});

// --- 1. Verlaengern gegen Speichern -----------------------------------------

test('1. gespeichert, waehrend Verlaengern auf den Kurs wartet - je eine Buchung am bezahlten und am neuen Tag', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    const paidId = subRow(a.id).budget_entry_id;
    await race({
      first: () => call('POST', `/${a.id}/renew`, {}),
      second: () => call('PUT', `/${a.id}`, { notes: 'x' }),
      order,
    });
    const rows = bookings(a);
    assert.deepEqual(rows.map((r) => r.date), ['2030-01-15', '2030-02-15'], `${label}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].id, paidId, `${label}: die bezahlte Buchung bleibt die alte Zeile`);
    assert.equal(subRow(a.id).budget_entry_id, rows[1].id, `${label}: das Abo zeigt auf die naechste Zahlung`);
    assert.deepEqual(rows.map((r) => r.amount), [-5, -5], label);
  }
});

// --- 2. Pause waehrend Verlaengern ------------------------------------------

test('2. pausiert, waehrend Verlaengern auf den Kurs wartet - die bezahlte Buchung bleibt, keine fuer die naechste Zahlung', async () => {
  const a = await abo();
  const paidId = subRow(a.id).budget_entry_id;
  await race({
    first: () => call('POST', `/${a.id}/renew`, {}),
    second: () => call('PUT', `/${a.id}`, { enabled: false }),
    order: [0],
    secondAwaits: false,
  });
  const s = subRow(a.id);
  assert.deepEqual([s.enabled, s.next_payment_date, s.occurrences_done, s.budget_entry_id], [0, '2030-02-15', 1, null]);
  const rows = bookings(a);
  assert.deepEqual(rows.map((r) => [r.id, r.date, r.amount]), [[paidId, '2030-01-15', -5]], `die bezahlte Zahlung fehlt: ${JSON.stringify(rows)}`);
});

// --- 3. Pause waehrend Speichern --------------------------------------------

test('3. pausiert, waehrend ein Speichervorgang auf den Kurs wartet - das pausierte Abo behaelt keine Buchung', async () => {
  const a = await abo();
  await race({
    first: () => call('PUT', `/${a.id}`, { amount: 20 }),
    second: () => call('PUT', `/${a.id}`, { enabled: false }),
    order: [0],
    secondAwaits: false,
  });
  const s = subRow(a.id);
  assert.deepEqual([s.enabled, s.amount, s.budget_entry_id], [0, 20, null]);
  assert.deepEqual(bookings(a), [], 'ein pausiertes Abo bucht nichts');
});

// --- 4. Zwei Betraege verkehrt herum ----------------------------------------

test('4. zwei Betragsaenderungen, deren Kurse verkehrt herum zurueckkommen - die Buchung traegt den Betrag des Abos', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    await race({
      first: () => call('PUT', `/${a.id}`, { amount: 20 }),
      second: () => call('PUT', `/${a.id}`, { amount: 30 }),
      order,
    });
    assert.equal(subRow(a.id).amount, 30, label);
    assert.deepEqual(bookings(a).map((r) => r.amount), [-15], label);
  }
});

// --- 5. Waehrungswechsel ----------------------------------------------------

test('5. Waehrung gewechselt, waehrend ein Speichervorgang auf den alten Kurs wartet - Betrag und Titel in der neuen Waehrung', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    await race({
      first: () => call('PUT', `/${a.id}`, { amount: 20 }),
      second: () => call('PUT', `/${a.id}`, { currency: 'GBP' }),
      order,
    });
    const s = subRow(a.id);
    assert.deepEqual([s.currency, s.amount], ['GBP', 20], label);
    const rows = bookings(a);
    assert.deepEqual(rows.map((r) => [r.title, r.amount]), [[`${a.name} (GBP)`, -40]], `${label}: ${JSON.stringify(rows)}`);
  }
});

test('5. Budget-Waehrung gewechselt, waehrend ein Speichervorgang auf den Kurs wartet - die Buchung rechnet in die neue', async () => {
  const setBudgetCurrency = (c) => db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(c);
  const a = await abo();
  const gate = rateGate();
  const put = call('PUT', `/${a.id}`, { amount: 40 });
  await gate.waitFor(1);
  // Die Einstellung bucht nichts nach: nur der wartende Sync kann es richten.
  setBudgetCurrency('GBP');
  gate.autoRelease();
  const r = await put;
  routes._setRatesForTest(null);
  setBudgetCurrency('EUR');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(bookings(a).map((x) => [x.title, x.amount]), [[`${a.name} (USD)`, -10]], '40 USD = 10 GBP, nicht die 5 EUR von vorher');
});

// --- nicht schlechter als main ----------------------------------------------

test('Verlaengern in der Luecke eines PUT endet wie auf main - beide Buchungen tragen den neuen Betrag, an ihrem Tag', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    const paidId = subRow(a.id).budget_entry_id;
    await race({
      first: () => call('PUT', `/${a.id}`, { amount: 20 }),
      second: () => call('POST', `/${a.id}/renew`, {}),
      order,
    });
    const rows = bookings(a);
    assert.deepEqual(rows.map((r) => [r.date, r.amount]), [['2030-01-15', -10], ['2030-02-15', -10]], `${label}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].id, paidId, label);
    assert.equal(subRow(a.id).budget_entry_id, rows[1].id, label);
  }
});

test('zweimal verlaengert, beide warten auf den Kurs - drei Buchungen an drei Tagen, das Abo zeigt auf die letzte (auf main je nach Reihenfolge auf die mittlere)', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo();
    await race({
      first: () => call('POST', `/${a.id}/renew`, {}),
      second: () => call('POST', `/${a.id}/renew`, {}),
      order,
    });
    const s = subRow(a.id);
    assert.deepEqual([s.next_payment_date, s.occurrences_done], ['2030-03-15', 2], label);
    const rows = bookings(a);
    assert.deepEqual(rows.map((r) => [r.date, r.amount]), [['2030-01-15', -5], ['2030-02-15', -5], ['2030-03-15', -5]], `${label}: ${JSON.stringify(rows)}`);
    assert.equal(s.budget_entry_id, rows[2].id, label);
  }
});

test('ohne Rennen: Verlaengern in fremder Waehrung bucht wie bisher - bezahlte Zeile bleibt, neue Zeile am naechsten Tag', async () => {
  routes._setRatesForTest(plainRates);
  const a = await abo();
  routes._setRatesForTest(plainRates);
  const r = await call('POST', `/${a.id}/renew`, {});
  routes._setRatesForTest(null);
  assert.equal(r.status, 200);
  const rows = bookings(a);
  assert.deepEqual(rows.map((x) => [x.date, x.amount, x.title]), [['2030-01-15', -5, `${a.name} (USD)`], ['2030-02-15', -5, `${a.name} (USD)`]]);
  assert.equal(r.body.data.budget_entry_id, rows[1].id);
});

// --- Review-Runde 1 zu #2008 ---------------------------------------------------

const setBudgetCurrency = (c) => db.prepare(`INSERT INTO sync_config (key, value) VALUES ('currency', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(c);

test('6. privat geschaltet - die Buchung ist privat, schon waehrend der Kurs geholt wird', async () => {
  const a = await abo();
  let seen = null;
  routes._setRatesForTest(async (base, list) => {
    seen = bookings(a).map((r) => r.visibility);
    return ratesAnswer(base, list);
  });
  const r = await call('PUT', `/${a.id}`, { visibility: 'private' });
  routes._setRatesForTest(null);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['private'], 'im await ist die Buchung schon privat, nicht erst danach');
  assert.deepEqual(bookings(a).map((x) => x.visibility), ['private']);
});

test('6. privat geschaltet, und die Budget-Waehrung kippt bei jedem Kursabruf - die Buchung ist privat, Betrag und Titel bleiben unberuehrt', async () => {
  const a = await abo();
  const vorher = bookings(a)[0];
  const flips = ['GBP', 'EUR', 'GBP', 'EUR', 'GBP'];
  let n = 0;
  routes._setRatesForTest(async (base, list) => {
    // Der Kurs passt beim Zurueckkommen nie mehr: der Neuversuch erschoepft sich.
    setBudgetCurrency(flips[n++ % flips.length]);
    return ratesAnswer(base, list);
  });
  const r = await call('PUT', `/${a.id}`, { visibility: 'private' });
  routes._setRatesForTest(null);
  setBudgetCurrency('EUR');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(n >= 3, `der Neuversuch lief (${n} Abrufe)`);
  const rows = bookings(a);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].visibility, 'private', 'ein privates Abo hat nach dem erschoepften Neuversuch eine geteilte Buchung');
  assert.deepEqual([rows[0].title, rows[0].amount], [vorher.title, vorher.amount], 'nichts mit einem unpassenden Kurs geschrieben');
});

test('pausiert, aber noch verknuepft (Altbestand), dann verlaengert - die Buchung geht wie auf main, keine Waise', async () => {
  const a = await abo();
  db.prepare('UPDATE budget_subscriptions SET enabled = 0 WHERE id = ?').run(a.id);
  routes._setRatesForTest(plainRates);
  const r = await call('POST', `/${a.id}/renew`, {});
  routes._setRatesForTest(null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(bookings(a), [], 'die verknuepfte Buchung eines pausierten Abos bleibt nicht unverknuepft liegen');
  assert.equal(subRow(a.id).budget_entry_id, null);
});

test('Verlaengern, und der Kurs scheitert danach - 200 mit dem festgeschriebenen Stand, kein zweites Verlaengern durch einen Neuversuch', async () => {
  const a = await abo();
  const paidId = subRow(a.id).budget_entry_id;
  routes._setRatesForTest(async () => { throw new Error('rates down'); });
  const r = await call('POST', `/${a.id}/renew`, {});
  routes._setRatesForTest(null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.next_payment_date, r.body.data.occurrences_done], ['2030-02-15', 1], 'die Antwort traegt den Stand, der schon gespeichert ist');
  const rows = bookings(a);
  assert.deepEqual(rows.map((x) => [x.id === paidId, x.date]), [[true, '2030-01-15'], [false, '2030-02-15']], JSON.stringify(rows));
  assert.equal(subRow(a.id).budget_entry_id, rows[1].id);
});

test('letzte Zahlung im await eines anderen Verlaengerns - das Budget zeigt alle bezahlten Zahlungen, das Abo ist abgeschlossen', async () => {
  for (const [label, order] of ORDERS) {
    const a = await abo({ end_type: 'after_count', occurrence_count: 2 });
    await race({
      first: () => call('POST', `/${a.id}/renew`, {}),
      second: () => call('POST', `/${a.id}/renew`, {}),
      order,
    });
    const s = subRow(a.id);
    assert.deepEqual([s.enabled, s.occurrences_done, s.budget_entry_id, Boolean(s.completed_at)], [0, 2, null, true], label);
    const rows = bookings(a);
    assert.deepEqual(rows.map((x) => [x.date, x.amount]), [['2030-01-15', -5], ['2030-02-15', -5]], `${label}: ${JSON.stringify(rows)}`);
  }
});

test('letzte Zahlung ohne Rennen, fremde Waehrung - die bezahlte Buchung bleibt mit umgerechnetem Betrag, unverknuepft, keine naechste', async () => {
  const a = await abo({ end_type: 'after_count', occurrence_count: 1, amount: 30 });
  const paidId = subRow(a.id).budget_entry_id;
  routes._setRatesForTest(plainRates);
  const r = await call('POST', `/${a.id}/renew`, {});
  routes._setRatesForTest(null);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'completed');
  assert.deepEqual(bookings(a).map((x) => [x.id, x.date, x.amount]), [[paidId, '2030-01-15', -15]]);
  assert.equal(subRow(a.id).budget_entry_id, null);
});

// --- Codex-Befunde zu ca8bc9329 (#2008) ------------------------------------------

test('von privat auf geteilt mit neuem Namen und Betrag - kein alter privater Inhalt wird geteilt, auch nicht im await oder nach erschoepftem Neuversuch', async () => {
  for (const exhaust of [false, true]) {
    const a = await abo({ visibility: 'private', name: `Geheim${exhaust ? 'X' : 'Y'}${seq}` });
    const vorher = bookings(a)[0];
    assert.equal(vorher.visibility, 'private');
    const seen = [];
    let n = 0;
    routes._setRatesForTest(async (base, list) => {
      seen.push(...db.prepare('SELECT title, amount, visibility FROM budget_entries WHERE id = ?').all(vorher.id));
      if (exhaust) setBudgetCurrency(['GBP', 'EUR'][n++ % 2]);
      return ratesAnswer(base, list);
    });
    const r = await call('PUT', `/${a.id}`, { visibility: 'shared', name: `${a.name}-neu`, amount: 20 });
    routes._setRatesForTest(null);
    setBudgetCurrency('EUR');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const row of seen) {
      assert.ok(row.visibility === 'private' || (row.title === `${a.name}-neu (USD)` && row.amount === -10),
        `${exhaust ? 'erschoepft' : 'im await'}: geteilt mit altem Inhalt ${JSON.stringify(row)}`);
    }
    const after = db.prepare('SELECT title, amount, visibility FROM budget_entries WHERE id = ?').get(vorher.id);
    if (exhaust) {
      assert.deepEqual({ ...after }, { title: vorher.title, amount: vorher.amount, visibility: 'private' }, 'erschoepft: die Buchung bleibt auf der engeren Sichtbarkeit');
    } else {
      assert.deepEqual({ ...after }, { title: `${a.name}-neu (USD)`, amount: -10, visibility: 'shared' }, 'mit dem Kurs: alles zusammen');
    }
  }
});

test('Verlaengern laesst Sichtbarkeit und Eigentuemer der bezahlten Buchung, wie sie der Nutzer gesetzt hat', async () => {
  const BEN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('ben', 'ben', 'x', 'member')").run().lastInsertRowid;
  for (const [label, patch] of [['privat gestellt', { visibility: 'private', owner_id: ADA }], ['anderer Eigentuemer', { visibility: 'private', owner_id: BEN }]]) {
    const a = await abo();
    const paidId = subRow(a.id).budget_entry_id;
    db.prepare('UPDATE budget_entries SET visibility = ?, owner_id = ? WHERE id = ?').run(patch.visibility, patch.owner_id, paidId);
    routes._setRatesForTest(plainRates);
    const r = await call('POST', `/${a.id}/renew`, {});
    routes._setRatesForTest(null);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const paid = db.prepare('SELECT visibility, owner_id FROM budget_entries WHERE id = ?').get(paidId);
    assert.deepEqual({ ...paid }, patch, `${label}: die bezahlte Zahlung wird beim Abkoppeln nicht fuer den Haushalt sichtbar`);
    const next = db.prepare('SELECT visibility, owner_id FROM budget_entries WHERE id = ?').get(subRow(a.id).budget_entry_id);
    assert.deepEqual({ ...next }, { visibility: 'shared', owner_id: ADA }, `${label}: die naechste folgt dem Abo`);
  }
});
