/** Account transfers through the real router: currencies and atomic paired bookings. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.SESSION_SECRET = 'transfer-route-test';
process.env.DB_PATH = ':memory:';
const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();
const initialCategories = db.prepare('SELECT * FROM budget_categories').all();
const initialSubcategories = db.prepare('SELECT * FROM budget_subcategories').all();
const user = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('transfers', 'Transfers', 'x', 'member')").run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = user; req.authRole = 'member'; req.session = { userId: user }; next(); });
app.use('/', budgetRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
test.afterEach(() => {
  db.exec('DROP TRIGGER IF EXISTS fail_transfer_link');
  db.exec('DELETE FROM budget_entries; DELETE FROM budget_accounts;');
  db.exec('DELETE FROM budget_subcategories; DELETE FROM budget_categories;');
  for (const [table, rows] of [['budget_categories', initialCategories], ['budget_subcategories', initialSubcategories]]) {
    const columns = Object.keys(rows[0]);
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(key => '@' + key).join(',')})`);
    for (const entry of rows) insert.run(entry);
  }
  db.prepare("DELETE FROM sync_config WHERE key = 'currency'").run();
});

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
function account(currency = null) {
  return Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Transfer account', 'checking', ?, ?)").run(currency, user).lastInsertRowid);
}
function payload(overrides = {}) {
  return { title: 'Transfer', amount: 100, date: '2045-01-10', from_account_id: overrides.from_account_id ?? account(), to_account_id: overrides.to_account_id ?? account(), ...overrides };
}
async function create(overrides = {}) {
  const res = await call('POST', '/transfers', payload(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}
const row = id => db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
function assertPair(first, second) {
  assert.ok(first, 'first transfer leg exists');
  assert.ok(second, 'second transfer leg exists');
  assert.equal(first.transfer_entry_id, second.id);
  assert.equal(second.transfer_entry_id, first.id);
  assert.equal(first.amount, -second.amount);
  for (const key of ['title', 'date', 'visibility', 'is_pending']) assert.equal(first[key], second[key], key);
}
async function instances(anchor, month = '2045-02') {
  const res = await call('GET', `/?month=${month}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return db.prepare('SELECT * FROM budget_entries WHERE recurrence_parent_id IN (?, ?) AND date LIKE ? ORDER BY amount').all(anchor.id, anchor.transfer_entry_id, `${month}-%`);
}

test('transfers refuse different effective currencies without writing either leg', async () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('currency', 'JPY') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  for (const currencies of [['EUR', 'USD'], [null, 'EUR'], ['EUR', null], ['EUR', '']]) {
    const res = await call('POST', '/transfers', payload({ from_account_id: account(currencies[0]), to_account_id: account(currencies[1]) }));
    assert.equal(res.status, 400, JSON.stringify(currencies));
    assert.equal(res.body.reason, 'transfer_currency_mismatch');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n, 0);
  }
});

test('transfers accept matching explicit currencies and household currency fallbacks', async () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('currency', 'JPY') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  for (const currencies of [['USD', 'USD'], [null, 'JPY'], ['JPY', null], [null, null], ['', 'JPY']]) {
    const entry = await create({ from_account_id: account(currencies[0]), to_account_id: account(currencies[1]) });
    assertPair(row(entry.id), row(entry.transfer_entry_id));
  }
});

test('transfer and generic entry edits cannot move a leg into a different currency', async () => {
  const anchor = await create({ is_recurring: true });
  const foreign = account('USD');
  const before = db.prepare('SELECT * FROM budget_entries ORDER BY id').all();
  const series = db.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all();
  for (const [path, body] of [
    [`/transfers/${anchor.id}`, { to_account_id: foreign }],
    [`/transfers/${anchor.id}/series`, { from_account_id: foreign }],
    [`/${anchor.id}`, { account_id: foreign }],
    [`/${anchor.transfer_entry_id}`, { account_id: foreign }],
  ]) {
    const res = await call('PUT', path, body);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.reason, 'transfer_currency_mismatch', path);
    assert.deepEqual(db.prepare('SELECT * FROM budget_entries ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all(), series);
  }
});

for (const currencyChange of ['account', 'household']) {
  test(`existing transfers remain editable after ${currencyChange === 'account' ? 'an account' : 'a household'} currency change`, async () => {
    db.prepare("INSERT INTO sync_config (key, value) VALUES ('currency', 'EUR') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const entry = await create({ from_account_id: account('EUR'), to_account_id: account(), is_recurring: true });
    if (currencyChange === 'account') {
      const changed = await call('PUT', `/accounts/${entry.account_id}`, { currency: 'USD' });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
    } else {
      db.prepare("UPDATE sync_config SET value = 'USD' WHERE key = 'currency'").run();
    }
    for (const path of [`/transfers/${entry.id}`, `/${entry.transfer_entry_id}`, `/transfers/${entry.id}/series`]) {
      const title = `Renamed through ${path}`;
      const edited = await call('PUT', path, { title });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(row(entry.id).title, title);
      assertPair(row(entry.id), row(entry.transfer_entry_id));
      assert.equal(row(entry.id).account_id, entry.account_id);
      assert.equal(row(entry.transfer_entry_id).account_id, entry.to_account_id);
    }
  });
}

test('a single transfer edit moves its incoming leg to the selected destination', async () => {
  const entry = await create();
  const destination = account();
  const edited = await call('PUT', `/transfers/${entry.id}`, { to_account_id: destination });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.to_account_id, destination);
  assert.equal(row(entry.transfer_entry_id).account_id, destination);
  assert.equal(row(entry.id).account_id, entry.account_id);
  assertPair(row(entry.id), row(entry.transfer_entry_id));
});

test('series edits rewrite both legs of already materialised future instances', async () => {
  const anchor = await create({ date: '2020-01-10', is_recurring: true });
  const future = [...await instances(anchor), ...await instances(anchor, '2045-03')];
  assert.equal(future.length, 4);
  const source = account();
  const destination = account();
  const edited = await call('PUT', `/transfers/${anchor.id}/series`, {
    title: 'Rewritten future', amount: 175, from_account_id: source, to_account_id: destination,
    visibility: 'private', recurrence_confirm: true,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  for (const original of future) {
    const updated = row(original.id);
    assert.ok(updated, 'existing occurrence keeps its ID');
    assert.equal(updated.title, 'Rewritten future');
    assert.equal(updated.amount, original.amount < 0 ? -175 : 175);
    assert.equal(updated.account_id, original.amount < 0 ? source : destination);
    assert.equal(updated.visibility, 'private');
    assert.equal(updated.is_pending, 1);
    assert.equal(updated.date, original.date);
    assertPair(updated, row(updated.transfer_entry_id));
  }
  assert.equal(row(anchor.id).title, anchor.title, 'past booking retains its title');
  assert.equal(row(anchor.id).amount, -100, 'past booking retains its amount');
});

test('PUT /:id mirrors a correction from either leg to its partner', async () => {
  const entry = await create();
  for (const [id, amount, date, visibility] of [
    [entry.id, -125.75, '2045-01-11', 'private'],
    [entry.transfer_entry_id, 83.25, '2045-01-12', 'shared'],
  ]) {
    const title = `Corrected ${id}`;
    const res = await call('PUT', `/${id}`, { amount, date, title, visibility });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const edited = row(id);
    assert.equal(edited.amount, amount);
    assert.equal(edited.date, date);
    assert.equal(edited.title, title);
    assert.equal(edited.visibility, visibility);
    assertPair(edited, row(edited.transfer_entry_id));
  }
});

test('materialised recurring transfers stay linked and out of income, expenses and plans', async () => {
  const anchor = await create({ is_recurring: true });
  const generated = await instances(anchor);
  assert.equal(generated.length, 2);
  assertPair(...generated);
  assert.deepEqual(generated.map(e => e.recurrence_parent_id), [anchor.id, anchor.transfer_entry_id]);
  const summary = await call('GET', '/summary?month=2045-02');
  assert.equal(summary.status, 200);
  for (const key of ['income', 'expenses', 'balance']) assert.equal(summary.body.data[key], 0, key);
  assert.equal(summary.body.data.transfers, 100);
  const stats = await call('GET', '/stats?range=month&anchor=2045-02-01');
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.data.totals, { income: 0, expenses: 0, balance: 0 });
  assert.deepEqual(stats.body.data.byCategory, []);
  assert.ok(stats.body.data.series.every(e => e.income === 0 && e.expenses === 0 && e.balance === 0));
  const plans = await call('GET', '/plans?month=2045-02');
  assert.equal(plans.status, 200);
  assert.equal(plans.body.data.totalActual, 0);
  assert.equal((await instances(anchor)).length, 2, 'reading the month again does not duplicate either leg');
});

test('deleting one recurring instance deletes both legs and skips both anchors on that date', async () => {
  const anchor = await create({ is_recurring: true });
  const generated = await instances(anchor);
  assert.equal(generated.length, 2);
  assertPair(...generated);
  const res = await call('DELETE', `/${generated[1].id}`);
  assert.equal(res.status, 204, JSON.stringify(res.body));
  for (const entry of generated) assert.equal(row(entry.id), undefined);
  assert.deepEqual(db.prepare('SELECT parent_id, date FROM budget_recurrence_skipped ORDER BY parent_id').all(),
    [anchor.id, anchor.transfer_entry_id].sort((a, b) => a - b).map(parent_id => ({ parent_id, date: '2045-02-10' })));
  assert.equal((await instances(anchor)).length, 0, 'neither skipped leg is regenerated');
  assertPair(row(anchor.id), row(anchor.transfer_entry_id));
  assertPair(...await instances(anchor, '2045-03'));
});

test('confirming a pending transfer instance corrects and books both legs only', async () => {
  const anchor = await create({ is_recurring: true, recurrence_confirm: true });
  const generated = await instances(anchor);
  assert.equal(generated.length, 2);
  assertPair(...generated);
  assert.ok(generated.every(e => e.is_pending === 1));
  assert.equal((await call('GET', '/summary?month=2045-02')).body.data.transfers, 0, 'pending transfers are not booked outflows');
  const res = await call('PATCH', `/${generated[1].id}/confirm`, { amount: 135.25, date: '2045-02-12' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const outgoing = row(generated[0].id);
  const incoming = row(generated[1].id);
  assertPair(outgoing, incoming);
  assert.equal(outgoing.amount, -135.25);
  assert.equal(incoming.amount, 135.25);
  assert.equal(outgoing.date, '2045-02-12');
  assert.equal(outgoing.is_pending, 0);
  assert.equal(row(anchor.id).amount, -100, 'the booked anchor stays unchanged');
  const summary = (await call('GET', '/summary?month=2045-02')).body.data;
  assert.equal(summary.income, 0);
  assert.equal(summary.expenses, 0);
  assert.equal(summary.transfers, 135.25);
});

test('a forced failure inside createTransfer rolls back both inserted legs and series', async () => {
  const observed = [];
  db.function('observe_transfer_rows', count => { observed.push(count); return 0; });
  db.exec(`CREATE TRIGGER fail_transfer_link BEFORE UPDATE OF transfer_entry_id ON budget_entries
    WHEN NEW.transfer_entry_id IS NOT NULL BEGIN
      SELECT observe_transfer_rows((SELECT COUNT(*) FROM budget_entries));
      SELECT RAISE(ABORT, 'forced transfer link failure');
    END;`);
  const res = await call('POST', '/transfers', payload({ is_recurring: true }));
  assert.equal(res.status, 500);
  assert.deepEqual(observed, [2], 'failure happens after both legs have been inserted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_series').get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('transfers fall back to remaining household categories when shipped keys have been deleted', async () => {
  db.prepare("DELETE FROM budget_subcategories WHERE category_key = 'financial_other'").run();
  db.prepare("DELETE FROM budget_categories WHERE key IN ('financial_other', 'Geschenke & Transfers')").run();
  const expected = type => db.prepare('SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order, name COLLATE NOCASE LIMIT 1').get(type).key;
  const outgoingCategory = expected('expense');
  const incomingCategory = expected('income');
  const entry = await create({ is_recurring: true });
  assert.equal(entry.category, outgoingCategory);
  assert.equal(row(entry.transfer_entry_id).category, incomingCategory);
  assertPair(row(entry.id), row(entry.transfer_entry_id));
  const edited = await call('PUT', `/transfers/${entry.id}`, { title: 'Fallback edit' });
  assert.equal(edited.status, 200);
  assert.equal((await call('PUT', `/transfers/${entry.id}/series`, { amount: 125 })).status, 200);
  const generated = await instances(entry);
  assertPair(...generated);
  assert.deepEqual(generated.map(e => e.category), [outgoingCategory, incomingCategory]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_categories WHERE key IN ('financial_other', 'Geschenke & Transfers')").get().n, 0);
});

test('transfers reuse a household Savings key and work without a Savings subcategory', async () => {
  db.prepare("DELETE FROM budget_subcategories WHERE key = 'saving'").run();
  db.prepare("INSERT INTO budget_subcategories (key, category_key, name) VALUES ('my_savings', 'financial_other', 'Savings')").run();
  const entry = await create();
  assert.equal(entry.category, 'financial_other');
  assert.equal(entry.subcategory, 'my_savings');
  await call('DELETE', `/${entry.id}`);
  db.prepare("DELETE FROM budget_subcategories WHERE category_key = 'financial_other'").run();
  const withoutSubcategory = await create();
  assert.equal(withoutSubcategory.subcategory, '');
});

test('accounts with linked transfers cannot be deleted but can be archived', async () => {
  const entry = await create();
  const partner = row(entry.transfer_entry_id);
  for (const id of [entry.account_id, partner.account_id]) {
    const res = await call('DELETE', `/accounts/${id}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'account_has_transfers');
    assertPair(row(entry.id), row(partner.id));
    assert.equal(row(entry.id).account_id, entry.account_id);
    assert.equal(row(partner.id).account_id, partner.account_id);
    assert.equal((await call('PUT', `/accounts/${id}`, { archived: true })).status, 200);
    assert.equal(db.prepare('SELECT archived FROM budget_accounts WHERE id = ?').get(id).archived, 1);
  }
  assert.equal((await call('PUT', `/transfers/${entry.id}`, { title: 'Still editable' })).status, 200);
  await call('DELETE', `/${entry.id}`);
  assert.equal((await call('DELETE', `/accounts/${entry.account_id}`)).status, 204);
});

test('the ledger exposes the partner account even when filtered to one account', async () => {
  const entry = await create();
  const res = await call('GET', `/?month=2045-01&account_id=${entry.account_id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].transfer_account_id, row(entry.transfer_entry_id).account_id);
});

test('summary.transfers counts booked transfer outflows regardless of their category', async () => {
  const entry = await create({ category: 'food' });
  const res = await call('GET', '/summary?month=2045-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.transfers, 100);
  assert.equal(Object.hasOwn(res.body.data, 'moved_to_savings'), false);
  assert.equal(res.body.data.income, 0);
  assert.equal(res.body.data.expenses, 0);
  assert.equal(entry.category, 'food');
});

test('new transfers refuse archived source and destination accounts without writing either leg', async () => {
  const archived = account();
  db.prepare('UPDATE budget_accounts SET archived = 1 WHERE id = ?').run(archived);
  for (const key of ['from_account_id', 'to_account_id']) {
    const res = await call('POST', '/transfers', payload({ [key]: archived, is_recurring: true }));
    assert.equal(res.status, 400, key);
    assert.equal(res.body.reason, 'transfer_account_archived');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_entries').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_series').get().n, 0);
  }
});

test('transfer, series and generic entry edits refuse changing either account to an archived one', async () => {
  const entry = await create({ is_recurring: true });
  const archived = account();
  db.prepare('UPDATE budget_accounts SET archived = 1 WHERE id = ?').run(archived);
  const before = db.prepare('SELECT * FROM budget_entries ORDER BY id').all();
  const series = db.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all();
  for (const [path, body] of [
    [`/transfers/${entry.id}`, { from_account_id: archived }],
    [`/transfers/${entry.id}`, { to_account_id: archived }],
    [`/transfers/${entry.id}/series`, { from_account_id: archived }],
    [`/transfers/${entry.id}/series`, { to_account_id: archived }],
    [`/${entry.id}`, { account_id: archived }],
    [`/${entry.transfer_entry_id}`, { account_id: archived }],
  ]) {
    const res = await call('PUT', path, body);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.reason, 'transfer_account_archived');
    assert.deepEqual(db.prepare('SELECT * FROM budget_entries ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all(), series);
  }
});

test('a title-only series edit preserves both current definitions after account and amount changes', async () => {
  const anchor = await create({ date: '2020-01-06', is_recurring: true, recurrence_interval: 'weekly', recurrence_interval_count: 2, recurrence_confirm: true });
  const destination = account();
  assert.equal((await call('PUT', `/transfers/${anchor.id}/series`, { to_account_id: destination, amount: 175 })).status, 200);
  assert.equal((await call('PUT', `/transfers/${anchor.id}/series`, { title: 'Only renamed' })).status, 200);
  const definitions = db.prepare('SELECT * FROM budget_series WHERE anchor_id IN (?, ?) ORDER BY amount').all(anchor.id, anchor.transfer_entry_id);
  assert.deepEqual(definitions.map(e => e.amount), [-175, 175]);
  assert.equal(definitions[1].account_id, destination);
  const generated = await instances(anchor, '2045-04');
  assert.ok(generated.length >= 2);
  assert.ok(generated.filter(e => e.amount > 0).every(e => e.account_id === destination));
  const occurrence = generated.find(e => e.amount < 0);
  const read = await call('GET', `/transfers/${occurrence.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.series.recurrence_interval, 'weekly');
  assert.equal(read.body.data.series.recurrence_interval_count, 2);
  assert.equal(read.body.data.series.recurrence_confirm, 1);
  assert.equal(read.body.data.series.to_account_id, destination);
  assert.equal(read.body.data.series.amount, -175);
  assert.equal(row(anchor.id).amount, -100, 'the original booked amount is historical');
});

test('an unchanged interval is accepted on a single transfer edit', async () => {
  const entry = await create({ is_recurring: true, recurrence_interval: 'weekly' });
  const edited = await call('PUT', `/transfers/${entry.id}`, { title: 'Renamed', recurrence_interval: 'weekly' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assertPair(row(entry.id), row(entry.transfer_entry_id));
  assert.equal((await call('PUT', `/transfers/${entry.id}`, { recurrence_interval: 'monthly' })).status, 400);
});

test('KWD transfer amounts retain three decimals on create, edit, recurrence and confirmation', async () => {
  const entry = await create({ amount: 1.005, is_recurring: true, recurrence_confirm: true,
    from_account_id: account('KWD'), to_account_id: account('KWD') });
  assert.equal(entry.amount, -1.005);
  assert.equal(row(entry.transfer_entry_id).amount, 1.005);
  assert.equal((await call('PUT', `/${entry.id}`, { amount: -2.005 })).status, 200);
  assert.equal(row(entry.transfer_entry_id).amount, 2.005);
  assert.equal((await call('PUT', `/transfers/${entry.id}`, { amount: 3.005 })).status, 200);
  assert.equal(row(entry.id).amount, -3.005);
  const generated = await instances(entry);
  assertPair(...generated);
  assert.equal(generated[0].amount, -1.005, 'editing one booking does not edit the definition');
  assert.equal((await call('PATCH', `/${generated[1].id}/confirm`, { amount: 4.005 })).status, 200);
  assert.equal(row(generated[0].id).amount, -4.005);
  assert.equal(row(generated[1].id).amount, 4.005);
  const accounts = (await call('GET', '/accounts')).body.data.accounts;
  assert.equal(accounts.find(e => e.id === entry.account_id).projected_balance, -7.01);
  const invalid = await call('POST', '/transfers', payload({ amount: 0.0001, from_account_id: entry.from_account_id, to_account_id: entry.to_account_id }));
  assert.equal(invalid.status, 400, 'off-grid amounts must be refused rather than rounded');
  const yenSource = account('JPY');
  const yenTarget = account('JPY');
  assert.equal((await call('PUT', `/transfers/${entry.id}`, { from_account_id: yenSource, to_account_id: yenTarget })).status, 400,
    'changing currencies does not grandfather the previous fractional amount');
});

test('Savings chart filters select the stored subcategory without colliding with a household saving category', async () => {
  const transfer = await create();
  db.prepare("INSERT INTO budget_categories (key, name, type) VALUES ('saving', 'My own saving category', 'expense')").run();
  const ordinary = await call('POST', '/', { title: 'Own category', amount: -50, category: 'saving', date: '2045-01-11' });
  assert.equal(ordinary.status, 201);
  const summary = (await call('GET', '/summary?month=2045-01')).body.data;
  const bar = summary.byCategory.find(e => e.transfers === 100);
  assert.notEqual(bar.category, 'saving');
  const filtered = await call('GET', `/?month=2045-01&category=${encodeURIComponent(bar.category)}`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.data.map(e => e.id), [transfer.id]);
  const own = await call('GET', '/?month=2045-01&category=saving');
  assert.deepEqual(own.body.data.map(e => e.id), [ordinary.body.data.id]);
});
