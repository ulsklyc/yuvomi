/**
 * Test: Budgetplan (geplantes/geschätztes Budget, Discussion #468)
 * Deckt ab: computePlanProgress (Plan vs. Ist + Sparziel), GET/PUT/DELETE /budget/plans,
 * Validierung (Kategorie, Positivbetrag), Sparziel-Sentinel, Routen-Reihenfolge vor /:id.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DB_PATH = path.join(os.tmpdir(), `oikos-budget-plans-${process.pid}.db`);
process.env.SESSION_SECRET = 'budget-plans-test-session-secret-32-bytes';

const db = await import('../server/db.js');
const budget = await import('../server/routes/budget.js');
const budgetRouter = budget.default;
const { computePlanProgress, BUDGET_SAVINGS_KEY } = budget;

let passed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; } };

const database = db.get();
const MONTH = '2026-07';

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
  await test('computePlanProgress: leer → keine Pläne, kein Sparziel', () => {
    seedEntries();
    const r = computePlanProgress(database, MONTH);
    assert.deepEqual(r.plans, []);
    assert.equal(r.savings, null);
    assert.equal(r.totalPlanned, 0);
  });

  await test('computePlanProgress: Kategorie unter/über Budget', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catA, 300); // Ist 200 < 300
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(catB, 400); // Ist 450 > 400
    const r = computePlanProgress(database, MONTH);
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
    const r = computePlanProgress(database, MONTH);
    assert.ok(r.savings);
    assert.equal(r.savings.planned, 2000);
    assert.equal(r.savings.actual, 2350);
    assert.equal(r.savings.met, true);
    assert.equal(r.plans.length, 0, 'Sentinel taucht nicht als Kategorie-Plan auf');
  });

  await test('computePlanProgress: Sparziel nicht erreicht', () => {
    seedEntries();
    database.prepare('INSERT INTO budget_plans (category, amount) VALUES (?, ?)').run(BUDGET_SAVINGS_KEY, 3000);
    const r = computePlanProgress(database, MONTH);
    assert.equal(r.savings.met, false);
    assert.equal(r.savings.remaining, 650); // 3000 - 2350
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
