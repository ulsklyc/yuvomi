/** Account transfers are facts written in pairs, never by a mirroring trigger. */
export const TRANSFER_INCOME_CATEGORY = 'Geschenke & Transfers';
export const TRANSFER_SAVING_CATEGORY = 'financial_other';
export const TRANSFER_SAVING_SUBCATEGORY = 'saving';

export function transferPair(database, entry) {
  const partner = database.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.transfer_entry_id);
  if (!partner || partner.transfer_entry_id !== entry.id) throw new Error('Broken transfer pair');
  return partner;
}

export function linkTransfer(database, firstId, secondId) {
  // Both rows exist before either immediate foreign key is set.
  database.prepare('UPDATE budget_entries SET transfer_entry_id = ? WHERE id = ?').run(secondId, firstId);
  database.prepare('UPDATE budget_entries SET transfer_entry_id = ? WHERE id = ?').run(firstId, secondId);
}

export function createTransfer(database, values) {
  return database.transaction(() => {
    const insert = database.prepare(`
      INSERT INTO budget_entries (title, amount, category, subcategory, date, account_id,
        is_recurring, recurrence_interval, recurrence_interval_count, recurrence_confirm,
        created_by, owner_id, visibility)
      VALUES (@title, @amount, @category, @subcategory, @date, @account_id,
        @is_recurring, @recurrence_interval, @recurrence_interval_count, @recurrence_confirm,
        @created_by, @owner_id, @visibility)
    `);
    const outgoing = insert.run({ ...values, amount: -values.amount, account_id: values.from_account_id }).lastInsertRowid;
    const incoming = insert.run({ ...values, amount: values.amount, account_id: values.to_account_id,
      category: TRANSFER_INCOME_CATEGORY, subcategory: '' }).lastInsertRowid;
    linkTransfer(database, outgoing, incoming);
    return database.prepare('SELECT * FROM budget_entries WHERE id = ?').get(outgoing);
  })();
}

/** Runs inside the transaction that changed the entry, including confirmation. */
export function mirrorTransfer(database, id) {
  const entry = database.prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
  const partner = transferPair(database, entry);
  database.prepare(`UPDATE budget_entries SET amount = ?, title = ?, date = ?,
    visibility = ?, is_pending = ? WHERE id = ?`)
    .run(-entry.amount, entry.title, entry.date, entry.visibility, entry.is_pending, partner.id);
}

export function deleteTransfer(database, entry) {
  return database.transaction(() => {
    const partner = transferPair(database, entry);
    for (const row of [entry, partner]) {
      if (row.recurrence_parent_id) database.prepare(`
        INSERT OR IGNORE INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)
      `).run(row.recurrence_parent_id, row.date);
    }
    // Deleting a series anchor ends both series and removes their instances.
    if (entry.is_recurring || partner.is_recurring) database.prepare(`
      DELETE FROM budget_entries WHERE recurrence_parent_id IN (?, ?)
    `).run(entry.id, partner.id);
    database.prepare('DELETE FROM budget_entries WHERE id = ?').run(entry.id);
  })();
}
