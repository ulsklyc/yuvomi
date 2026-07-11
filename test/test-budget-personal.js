import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { buildBudgetAssignmentShares } from '../server/services/budget-shares.js';
import { saveBudgetAssignments } from '../server/services/budget-assignment-store.js';
import { loadBudgetEntryWithMeta } from '../server/services/budget-entry-loader.js';
import { aggregateBudgetRows, loadPersonalBudgetRows, resolveBudgetOwnerUserId } from '../server/services/budget-personal.js';

function createBudgetTestDb() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );`);
  database.exec(MIGRATIONS_SQL[1]);
  database.exec(`CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  database.exec(MIGRATIONS_SQL[80]);
  return database;
}

test('equal budget shares split negative amounts across assignees', () => {
  const shares = buildBudgetAssignmentShares({
    amount: -90,
    splitMethod: 'equal',
    assignments: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }],
  });
  assert.equal(shares.length, 3);
  assert.equal(Math.round(shares.reduce((sum, row) => sum + row.amount, 0) * 100) / 100, -90);
});

test('percentage budget shares respect configured percentages', () => {
  const shares = buildBudgetAssignmentShares({
    amount: 100,
    splitMethod: 'percentage',
    assignments: [
      { user_id: 1, share_percentage: 25 },
      { user_id: 2, share_percentage: 75 },
    ],
  });
  assert.equal(shares[0].amount, 25);
  assert.equal(shares[1].amount, 75);
});

test('exact budget shares respect configured amounts', () => {
  const shares = buildBudgetAssignmentShares({
    amount: -120,
    splitMethod: 'exact',
    assignments: [
      { user_id: 1, share_amount: 20 },
      { user_id: 2, share_amount: 100 },
    ],
  });
  assert.equal(shares[0].amount, -20);
  assert.equal(shares[1].amount, -100);
});

test('aggregateBudgetRows computes totals and buckets for personal rows', () => {
  const rows = [
    { date: '2026-03-01', category: 'income', amount: 1000 },
    { date: '2026-03-02', category: 'food', amount: -25 },
    { date: '2026-03-03', category: 'food', amount: -10 },
  ];
  const result = aggregateBudgetRows(rows, ['2026-03-01', '2026-03-02', '2026-03-03'], 'day');
  assert.equal(result.totals.income, 1000);
  assert.equal(result.totals.expenses, -35);
  assert.equal(result.totals.balance, 965);
  assert.equal(result.byCategory[0].category, 'income');
  assert.equal(result.series[1].expenses, -25);
});

test('resolveBudgetOwnerUserId assigns single-user entries to that person', () => {
  assert.equal(resolveBudgetOwnerUserId(10, [{ user_id: 2 }]), 2);
  assert.equal(resolveBudgetOwnerUserId(10, [{ user_id: 2 }, { user_id: 3 }]), 10);
  assert.equal(resolveBudgetOwnerUserId(10, []), 10);
});

test('loadPersonalBudgetRows shows the viewer share when creator is also assigned', () => {
  const database = createBudgetTestDb();
  const creatorId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner', 'Owner', 'x', 'admin')`).run().lastInsertRowid;
  const otherId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('other', 'Other', 'x', 'member')`).run().lastInsertRowid;
  const thirdId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('third', 'Third', 'x', 'member')`).run().lastInsertRowid;
  const entryId = database.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_user_id, split_method)
    VALUES ('Shared bill', -300, 'food', 'groceries', '2026-07-09', ?, ?, 'equal')
  `).run(creatorId, creatorId).lastInsertRowid;
  database.prepare(`
    INSERT INTO budget_entry_assignments (budget_entry_id, user_id, share_amount)
    VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
  `).run(entryId, creatorId, -100, entryId, otherId, -100, entryId, thirdId, -100);

  const rows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', creatorId);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -100);
  assert.equal(rows[0].is_assigned_share, 1);
  assert.equal(rows[0].is_readonly, 0);
});

test('loadPersonalBudgetRows executes with assignment rows and returns other participant shares', () => {
  const database = createBudgetTestDb();
  const creatorId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner2', 'Owner 2', 'x', 'admin')`).run().lastInsertRowid;
  const viewerId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('viewer', 'Viewer', 'x', 'member')`).run().lastInsertRowid;
  const entryId = database.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_user_id, split_method)
    VALUES ('Water bill', -120, 'housing', 'utilities', '2026-07-10', ?, ?, 'exact')
  `).run(creatorId, creatorId).lastInsertRowid;
  database.prepare(`
    INSERT INTO budget_entry_assignments (budget_entry_id, user_id, share_amount)
    VALUES (?, ?, ?), (?, ?, ?)
  `).run(entryId, creatorId, -70, entryId, viewerId, -50);

  const rows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', viewerId);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -50);
  assert.equal(rows[0].title, 'Water bill');
  assert.equal(rows[0].is_readonly, 1);
});

test('saveBudgetAssignments create path yields per-user My budget rows for equal splits', () => {
  const database = createBudgetTestDb();
  const creatorId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner3', 'Owner 3', 'x', 'admin')`).run().lastInsertRowid;
  const secondId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member2', 'Member 2', 'x', 'member')`).run().lastInsertRowid;
  const thirdId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member3', 'Member 3', 'x', 'member')`).run().lastInsertRowid;
  const entryId = database.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_user_id, split_method)
    VALUES ('Internet', -300, 'housing', 'utilities', '2026-07-12', ?, ?, 'equal')
  `).run(creatorId, creatorId).lastInsertRowid;

  saveBudgetAssignments(database, entryId, -300, 'equal', [
    { user_id: creatorId },
    { user_id: secondId },
    { user_id: thirdId },
  ]);

  const creatorRows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', creatorId);
  const secondRows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', secondId);
  const thirdRows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', thirdId);

  assert.equal(creatorRows[0].amount, -100);
  assert.equal(secondRows[0].amount, -100);
  assert.equal(thirdRows[0].amount, -100);
});

test('saveBudgetAssignments update path recalculates viewer shares after split changes', () => {
  const database = createBudgetTestDb();
  const creatorId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner4', 'Owner 4', 'x', 'admin')`).run().lastInsertRowid;
  const viewerId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member4', 'Member 4', 'x', 'member')`).run().lastInsertRowid;
  const entryId = database.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_user_id, split_method)
    VALUES ('Power', -120, 'housing', 'utilities', '2026-07-13', ?, ?, 'exact')
  `).run(creatorId, creatorId).lastInsertRowid;

  saveBudgetAssignments(database, entryId, -120, 'exact', [
    { user_id: creatorId, share_amount: 60 },
    { user_id: viewerId, share_amount: 60 },
  ]);
  let viewerRows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', viewerId);
  assert.equal(viewerRows[0].amount, -60);

  database.prepare('UPDATE budget_entries SET amount = ?, split_method = ? WHERE id = ?').run(-120, 'percentage', entryId);
  saveBudgetAssignments(database, entryId, -120, 'percentage', [
    { user_id: creatorId, share_percentage: 25 },
    { user_id: viewerId, share_percentage: 75 },
  ]);
  viewerRows = loadPersonalBudgetRows(database, '2026-07-01', '2026-07-31', viewerId);

  assert.equal(viewerRows[0].amount, -90);
});

test('loadBudgetEntryWithMeta returns the create/update response shape with assignments', () => {
  const database = createBudgetTestDb();
  const creatorId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner5', 'Owner 5', 'x', 'admin')`).run().lastInsertRowid;
  const memberId = database.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member5', 'Member 5', 'x', 'member')`).run().lastInsertRowid;
  const entryId = database.prepare(`
    INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_user_id, split_method)
    VALUES ('Phone', -80, 'housing', 'internet_tv_phone', '2026-07-14', ?, ?, 'exact')
  `).run(creatorId, creatorId).lastInsertRowid;

  saveBudgetAssignments(database, entryId, -80, 'exact', [
    { user_id: creatorId, share_amount: 50 },
    { user_id: memberId, share_amount: 30 },
  ]);

  const entry = loadBudgetEntryWithMeta(database, entryId);

  assert.equal(entry.id, entryId);
  assert.equal(entry.title, 'Phone');
  assert.equal(entry.creator_name, 'Owner 5');
  assert.equal(entry.loan_payment_id, null);
  assert.equal(entry.loan_title, null);
  assert.equal(entry.assignments.length, 2);
  assert.deepEqual(entry.assignments.map((row) => [row.user_id, row.share_amount]), [
    [memberId, -30],
    [creatorId, -50],
  ]);
});
