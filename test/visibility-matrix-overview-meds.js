/**
 * Visibility matrix helper: how many medications the health tile of one overview
 * read (GET /dashboard) counts.
 *
 * The tile carries aggregates, not rows, and `health.hasMeds` alone is true for
 * every account that owns one medication: a tile that also read the family-visible
 * or cared-for medications of others would still say true. So one extra read puts
 * every seeded medication at stock 0, and `health.lowStockCount` is then the number
 * of medications the tile reads (it counts every read medication with stock <= 0).
 *
 * Kept out of test-visibility-matrix.js, which stands at its max-lines limit.
 *
 * The seed leaves `stock_qty` NULL and no other cell reads it; the stock goes back
 * to NULL right after the read, before anything else is measured.
 */

/**
 * @param {{
 *   db: any,
 *   medications: { id: number }[],
 *   read: () => Promise<{ status: number, body: any }>,
 *   statusValue: (res: { status: number, body: any }) => unknown,
 * }} tools
 * @returns {Promise<unknown>} the count, or the refusal of the read
 */
export async function overviewMedicationCount({ db, medications, read, statusValue }) {
  const setStock = db.prepare('UPDATE medications SET stock_qty = ? WHERE id = ?');
  for (const row of medications) setStock.run(0, row.id);
  try {
    const res = await read();
    if (res.status !== 200) return statusValue(res);
    return res.body.health?.lowStockCount ?? null;
  } finally {
    for (const row of medications) setStock.run(null, row.id);
  }
}
