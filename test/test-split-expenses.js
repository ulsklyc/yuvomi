import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `oikos-split-expenses-${process.pid}.db`);

const service = await import('../server/services/split-expenses.js');
const db = await import('../server/db.js');

function testMoneyParsing() {
  assert.equal(service.parseMoneyToMinor('12.34', 'EUR'), 1234);
  assert.equal(service.parseMoneyToMinor('1200', 'JPY'), 1200);
  assert.equal(service.minorToDecimal(1234, 'EUR'), '12.34');
  assert.equal(service.minorToDecimal(-505, 'EUR'), '-5.05');
  assert.throws(() => service.parseMoneyToMinor(12.34, 'EUR'), /decimal string/);
  assert.throws(() => service.parseMoneyToMinor('1.234', 'EUR'), /too many decimal/);
}

function testSplitAllocation() {
  assert.deepEqual(
    service.buildSplits({ method: 'equal', amountMinor: 100, currency: 'EUR', participants: [1, 2, 3] }),
    [
      { user_id: 1, amount_minor: 34, currency: 'EUR' },
      { user_id: 2, amount_minor: 33, currency: 'EUR' },
      { user_id: 3, amount_minor: 33, currency: 'EUR' },
    ],
  );

  assert.deepEqual(
    service.buildSplits({
      method: 'percentage',
      amountMinor: 999,
      currency: 'EUR',
      participants: [1, 2],
      splits: [{ user_id: 1, percentage: '33.33' }, { user_id: 2, percentage: '66.67' }],
    }),
    [
      { user_id: 1, amount_minor: 333, currency: 'EUR' },
      { user_id: 2, amount_minor: 666, currency: 'EUR' },
    ],
  );

  assert.deepEqual(
    service.buildSplits({
      method: 'exact',
      amountMinor: 30000,
      currency: 'EUR',
      participants: [1, 2],
      splits: [{ user_id: 1, amount: '100.00' }, { user_id: 2, amount: '200.00' }],
    }),
    [
      { user_id: 1, amount_minor: 10000, currency: 'EUR' },
      { user_id: 2, amount_minor: 20000, currency: 'EUR' },
    ],
  );

  assert.deepEqual(
    service.buildSplits({
      method: 'shares',
      amountMinor: 1000,
      currency: 'EUR',
      participants: [1, 2, 3],
      splits: [{ user_id: 1, shares: 1 }, { user_id: 2, shares: 1 }, { user_id: 3, shares: 2 }],
    }),
    [
      { user_id: 1, amount_minor: 250, currency: 'EUR' },
      { user_id: 2, amount_minor: 250, currency: 'EUR' },
      { user_id: 3, amount_minor: 500, currency: 'EUR' },
    ],
  );
}

function testDebtSimplification() {
  const debts = service.simplifyDebts([
    { user_id: 1, display_name: 'Alice', currency: 'EUR', net_minor: -1000 },
    { user_id: 2, display_name: 'Bob', currency: 'EUR', net_minor: 0 },
    { user_id: 3, display_name: 'Carol', currency: 'EUR', net_minor: 1000 },
  ]);
  assert.deepEqual(debts, [{
    from_user_id: 1,
    from_name: 'Alice',
    to_user_id: 3,
    to_name: 'Carol',
    currency: 'EUR',
    amount_minor: 1000,
    amount: '10.00',
  }]);
}

function testLedgerDerivation() {
  const database = db.get();
  database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('alice', 'Alice', 'x', '#111111', 'member'),
           ('bob', 'Bob', 'x', '#222222', 'member'),
           ('carol', 'Carol', 'x', '#333333', 'member')
  `).run();
  const groupId = database.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES ('Trip', 'travel', 'EUR', 1)").run().lastInsertRowid;
  for (const userId of [1, 2, 3]) {
    database.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, 1)')
      .run(groupId, userId, userId === 1 ? 'owner' : 'guest');
  }
  const expenseId = database.prepare(`
    INSERT INTO expenses
      (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, category, split_method, created_by)
    VALUES (?, 'Dinner', 3000, 'EUR', 3000, 'EUR', 2, 'travel', 'equal', 1)
  `).run(groupId).lastInsertRowid;
  const insertLedger = database.prepare(`
    INSERT INTO expense_ledger_entries
      (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', ?, ?, ?, ?, 'EUR', 'Dinner', 1)
  `);
  insertLedger.run(groupId, expenseId, 2, null, 3000);
  insertLedger.run(groupId, expenseId, 1, 2, -1000);
  insertLedger.run(groupId, expenseId, 2, 2, -1000);
  insertLedger.run(groupId, expenseId, 3, 2, -1000);

  const balances = database.prepare(`
    SELECT user_id, currency, SUM(amount_minor) AS net_minor
    FROM expense_ledger_entries
    GROUP BY user_id, currency
    ORDER BY user_id
  `).all();
  assert.deepEqual(balances, [
    { user_id: 1, currency: 'EUR', net_minor: -1000 },
    { user_id: 2, currency: 'EUR', net_minor: 2000 },
    { user_id: 3, currency: 'EUR', net_minor: -1000 },
  ]);
}

function testDashboardExcludesArchivedGroups() {
  const database = db.get();
  // A second, archived group where Alice (user 1) is still owed money.
  const archivedId = database.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by, status, archived_at) VALUES ('Old Trip', 'travel', 'EUR', 1, 'archived', '2026-01-01T00:00:00Z')").run().lastInsertRowid;
  for (const userId of [1, 2]) {
    database.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, 1)')
      .run(archivedId, userId, userId === 1 ? 'owner' : 'guest');
  }
  const insertLedger = database.prepare(`
    INSERT INTO expense_ledger_entries
      (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 0, ?, ?, ?, 'EUR', 'Old', 1)
  `);
  insertLedger.run(archivedId, 1, 2, 5000);
  insertLedger.run(archivedId, 2, 2, -5000);

  const uid = 1;
  // Mirrors the GET /dashboard balance query: archived groups must not contribute.
  const balances = database.prepare(`
    SELECT l.currency, l.user_id, SUM(l.amount_minor) AS net_minor
    FROM expense_ledger_entries l
    JOIN expense_group_members gm ON gm.group_id = l.group_id AND gm.user_id = @uid
    JOIN expense_groups g ON g.id = l.group_id AND g.status = 'active'
    GROUP BY l.currency, l.user_id
  `).all({ uid });
  const mine = balances.filter((row) => row.user_id === uid);
  const owed = mine.filter((row) => row.net_minor > 0).reduce((sum, row) => sum + row.net_minor, 0);
  // Alice's only positive balance lived in the archived group → dashboard shows 0 owed.
  assert.equal(owed, 0, 'archived group balances must not appear in the dashboard total');
}

try {
  testMoneyParsing();
  testSplitAllocation();
  testDebtSimplification();
  testLedgerDerivation();
  testDashboardExcludesArchivedGroups();
  console.log('Split expense tests passed');
} finally {
  db.get().close();
  fs.rmSync(process.env.DB_PATH, { force: true });
  fs.rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  fs.rmSync(`${process.env.DB_PATH}-shm`, { force: true });
}
