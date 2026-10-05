/**
 * Test: Budgetplan (geplantes/geschätztes Budget, Discussion #468)
 * Deckt ab: computePlanProgress (Plan vs. Ist + Sparziel), GET/PUT/DELETE /budget/plans,
 * Validierung (Kategorie, Positivbetrag), Sparziel-Sentinel, Routen-Reihenfolge vor /:id.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { freshTestDbPath } from './tmp-db.js';
freshTestDbPath('budget-plans');
process.env.SESSION_SECRET = 'budget-plans-test-session-secret-32-bytes';

const db = await import('../server/db.js');
const budget = await import('../server/routes/budget.js');
const budgetRouter = budget.default;
const { computePlanProgress, BUDGET_SAVINGS_KEY } = budget;

let passed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; } };

const database = db.get();
// Das Urteil (over/met) liefert computePlanProgress nur fuer den LAUFENDEN Monat (#1005),
// also laeuft die Suite darauf - sonst pruefte sie eine Zusicherung, die es dort nicht gibt.
const helpers = await import('../server/routes/budget/helpers.js');
const { thisMonthLocalKey } = helpers;
const MONTH = thisMonthLocalKey();
const PAST_MONTH = '2026-01';
// Die Logik-Tests rechnen bewusst ueber den ganzen Haushalt - ausdruecklich,
// denn ohne Kontext wirft computePlanProgress (fail-closed, #659).
const HOUSEHOLD = { householdWide: true };

database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'admin')").run();

// Zwei Ausgabenkategorien aus den Default-Seeds ziehen.
const expenseCats = database.prepare("SELECT key FROM budget_categories WHERE type = 'expense' ORDER BY sort_order LIMIT 2").all();
assert.ok(expenseCats.length >= 2, 'zwei Ausgabenkategorien erwartet');
const [catA, catB] = expenseCats.map((c) => c.key);

function seedEntries() {
  database.prepare('DELETE FROM budget_entries').run();
  database.prepare('DELETE FROM budget_plans').run();
  const ins = database.prepare("INSERT INTO budget_entries (title, amount, category, date, created_by) VALUES (?, ?, ?, ?, 1)");
  ins.run('Gehalt', 3000, catA, `${MONTH}-01`);        // Einnahme
  ins.run('Ausgabe A1', -120, catA, `${MONTH}-05`);
  ins.run('Ausgabe A2', -80,  catA, `${MONTH}-15`);    // catA Ausgaben gesamt 200
  ins.run('Ausgabe B',  -450, catB, `${MONTH}-10`);    // catB Ausgaben gesamt 450
  ins.run('Alt', -999, catB, '2026-06-10');            // anderer Monat → ignoriert
}

const server = (() => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/budget', budgetRouter);
  return app.listen(0, '127.0.0.1');
})();
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/budget`;

try {
  // ---- computePlanProgress: reine Logik -------------------------------------
  await test('computePlanProgress: ohne Betrachter-Kontext wirft sie statt alles zu zaehlen', () => {
    // Ein stiller Default auf den ganzen Haushalt oeffnete das Leck aus #659
    // fuer jeden kuenftigen Aufrufer, der die Argumente vergisst - gruen.
    const { budgetFilter, budgetCategoryExpr } = helpers;
    const req = { query: {}, authUserId: 1, session: { userId: 1 } };
    for (const [label, ctx] of [
      ['ohne Kontext', undefined],
      ['leeres Objekt', {}],
      ['nur Filter', { filter: budgetFilter(req, 'budget_entries') }],
      ['nur Kategorie-Ausdruck', { categoryExpr: budgetCategoryExpr(req, 'budget_entries') }],
      ['householdWide nicht true', { householdWide: 1 }],
      ['householdWide plus Filter', { householdWide: true, filter: budgetFilter(req, 'budget_entries') }],
    ]) {
      assert.throws(() => computePlanProgress(database, MONTH, ctx), TypeError, `${label}: muss werfen`);
    }
    assert.ok(computePlanProgress(database, MONTH, {
      filter: budgetFilter(req, 'budget_entries'),
      categoryExpr: budgetCategoryExpr(req, 'budget_entries'),
    }), 'mit Betrachter-Kontext rechnet sie');
    assert.ok(computePlanProgress(database, MONTH, HOUSEHOLD), 'ausdruecklich haushaltsweit ebenso');
  });

  await test('computePlanProgress: leer → keine Pläne, kein Sparziel', () => {
    seedEntries();
    const r = computePlanProgress(database, MONTH, HOUSEHOLD);
    assert.deepEqual(r.plans, []);
    assert.equal(r.savings, null);
    assert.equal(r.totalPlanned, 0);
  });

  await test('computePlanProgress: Kategorie unter/über Budget', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catA, 300); // Ist 200 < 300
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catB, 400); // Ist 450 > 400
    const r = computePlanProgress(database, MONTH, HOUSEHOLD);
    const byCat = Object.fromEntries(r.plans.map((p) => [p.category, p]));
    assert.equal(byCat[catA].planned, 300);
    assert.equal(byCat[catA].actual, 200);
    assert.equal(byCat[catA].remaining, 100);
    assert.equal(byCat[catA].over, false);
    assert.equal(byCat[catB].actual, 450);
    assert.equal(byCat[catB].remaining, -50);
    assert.equal(byCat[catB].over, true);
    assert.equal(r.totalPlanned, 700);
    assert.equal(r.totalActual, 650);
    // Sortierung: höchste Auslastung (catB 1.125) zuerst.
    assert.equal(r.plans[0].category, catB);
  });

  await test('computePlanProgress: Sparziel vs. Netto-Saldo', () => {
    seedEntries(); // income 3000, expenses 650 → balance 2350
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(BUDGET_SAVINGS_KEY, 2000);
    const r = computePlanProgress(database, MONTH, HOUSEHOLD);
    assert.ok(r.savings);
    assert.equal(r.savings.planned, 2000);
    assert.equal(r.savings.actual, 2350);
    assert.equal(r.savings.met, true);
    assert.equal(r.plans.length, 0, 'Sentinel taucht nicht als Kategorie-Plan auf');
  });

  await test('computePlanProgress: Sparziel nicht erreicht', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(BUDGET_SAVINGS_KEY, 3000);
    const r = computePlanProgress(database, MONTH, HOUSEHOLD);
    assert.equal(r.savings.met, false);
    assert.equal(r.savings.remaining, 650); // 3000 - 2350
  });

  // ---- Kein Urteil ueber die Vergangenheit (#1005) ---------------------------
  await test('vergangener Monat: geplant/ist bleiben, over faellt weg', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catB, 400);
    const now  = computePlanProgress(database, MONTH, HOUSEHOLD);
    const past = computePlanProgress(database, PAST_MONTH, HOUSEHOLD);
    assert.equal(now.isCurrentMonth, true);
    assert.equal(past.isCurrentMonth, false);
    assert.equal(now.plans[0].over, true, 'laufender Monat behaelt sein Urteil');
    const pastRow = past.plans.find((p) => p.category === catB);
    assert.ok(pastRow, 'der Plan wird weiter ausgewiesen');
    assert.equal(pastRow.planned, 400, 'geplant ist eine Tatsache und bleibt');
    assert.equal(pastRow.over, null, 'ueber das Damals urteilt Yuvomi nicht');
  });

  await test('vergangener Monat: Planaenderung dreht kein altes Urteil mehr um', () => {
    // Der Kern von #1005: budget_plans hat keine Zeitachse, ein spaeter gesetzter
    // Betrag kippte vorher das "ueber Budget" eines abgeschlossenen Monats.
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catB, 500);
    const before = computePlanProgress(database, PAST_MONTH, HOUSEHOLD).plans.find((p) => p.category === catB);
    database.prepare('UPDATE budget_plans SET amount = ? WHERE category = ?').run(400, catB);
    const after = computePlanProgress(database, PAST_MONTH, HOUSEHOLD).plans.find((p) => p.category === catB);
    assert.equal(before.over, null);
    assert.equal(after.over, null, 'kein Urteil, also auch kein rueckwirkend gedrehtes');
  });

  await test('vergangener Monat: auch das Sparziel urteilt nicht', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(BUDGET_SAVINGS_KEY, 2000);
    assert.equal(computePlanProgress(database, MONTH, HOUSEHOLD).savings.met, true);
    assert.equal(computePlanProgress(database, PAST_MONTH, HOUSEHOLD).savings.met, null);
  });

  // ---- Routen ---------------------------------------------------------------
  await test('PUT legt Plan an, GET liefert Fortschritt', async () => {
    seedEntries();
    const put = await fetch(`${base}/plans/${catA}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 250 }),
    });
    assert.equal(put.status, 200);
    const get = await fetch(`${base}/plans?month=${MONTH}`);
    const body = (await get.json()).data;
    assert.equal(body.month, MONTH);
    assert.equal(body.plans[0].category, catA);
    assert.equal(body.plans[0].planned, 250);
    assert.equal(body.plans[0].actual, 200);
  });

  await test('PUT /plans/:category kollidiert nicht mit /:id (kein Entry-Update)', async () => {
    seedEntries();
    const before = database.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n;
    await fetch(`${base}/plans/${catA}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100 }),
    });
    const after = database.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n;
    assert.equal(before, after, 'Einträge unverändert');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_plans WHERE category = ?').get(catA).n, 1);
  });

  await test('PUT ist idempotent (Upsert)', async () => {
    seedEntries();
    for (const a of [100, 175]) {
      await fetch(`${base}/plans/${catA}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: a }),
      });
    }
    assert.equal(database.prepare('SELECT amount FROM budget_plans WHERE category = ?').get(catA).amount, 175);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_plans').get().n, 1);
  });

  await test('PUT Sparziel via Sentinel', async () => {
    seedEntries();
    const res = await fetch(`${base}/plans/${encodeURIComponent(BUDGET_SAVINGS_KEY)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 1500 }),
    });
    assert.equal(res.status, 200);
    const body = (await (await fetch(`${base}/plans?month=${MONTH}`)).json()).data;
    assert.ok(body.savings);
    assert.equal(body.savings.planned, 1500);
  });

  await test('PUT lehnt ungültige Kategorie ab (400)', async () => {
    const res = await fetch(`${base}/plans/__not_a_category__`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(res.status, 400);
  });

  await test('PUT lehnt nicht-positiven Betrag ab (400)', async () => {
    for (const amount of [0, -5]) {
      const res = await fetch(`${base}/plans/${catA}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }),
      });
      assert.equal(res.status, 400, `amount=${amount}`);
    }
  });

  await test('DELETE entfernt Plan', async () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catA, 250);
    const res = await fetch(`${base}/plans/${catA}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM budget_plans WHERE category = ?').get(catA).n, 0);
  });

  await test('computeStats liefert plans-Map für Ziel-Marker', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catA, 250);
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(BUDGET_SAVINGS_KEY, 900);
    const stats = budget.computeStats(database, { range: 'month', anchor: `${MONTH}-15` });
    assert.equal(stats.plans[catA], 250);
    assert.ok(!(BUDGET_SAVINGS_KEY in stats.plans), 'Sparziel nicht in Kategorie-Plänen');
  });

  console.log(`\n${passed} passed`);
} finally {
  server.close();
}
