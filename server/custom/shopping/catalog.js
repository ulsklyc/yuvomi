/**
 * Yuvomi — Catálogo de compras
 *
 * Funções independentes da API Express.
 * O banco é recebido como argumento para facilitar testes.
 */

/**
 * Localiza um produto pelo nome ou cadastra um novo.
 */
export function ensureShoppingProduct(db, name, category = null) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return null;

  db.prepare(`
    INSERT OR IGNORE INTO shopping_products (name, category)
    VALUES (?, ?)
  `).run(cleanName, category);

  let product = db.prepare(`
    SELECT *
    FROM shopping_products
    WHERE name = ? COLLATE NOCASE
  `).get(cleanName);

  if (product && category && product.category !== category) {
    db.prepare(`
      UPDATE shopping_products
      SET category = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(category, product.id);

    product = { ...product, category };
  }

  return product;
}

/**
 * Consulta os preços de compras anteriores de um produto.
 */
export function loadProductPriceInfo(db, productId) {
  const empty = {
    last_price_cents: null,
    previous_price_cents: null,
    lowest_price_cents: null,
  };

  if (!productId) return empty;

  const rows = db.prepare(`
    SELECT unit_price_cents
    FROM shopping_price_history
    WHERE product_id = ?
    ORDER BY purchased_at DESC, id DESC
    LIMIT 2
  `).all(productId);

  const lowest = db.prepare(`
    SELECT MIN(unit_price_cents) AS value
    FROM shopping_price_history
    WHERE product_id = ?
  `).get(productId);

  return {
    last_price_cents: rows[0]?.unit_price_cents ?? null,
    previous_price_cents: rows[1]?.unit_price_cents ?? null,
    lowest_price_cents: lowest?.value ?? null,
  };
}

/**
 * Acrescenta informações de preço histórico a um item.
 */
export function attachShoppingPriceInfo(db, item) {
  if (!item) return item;

  return {
    ...item,
    ...loadProductPriceInfo(db, item.product_id),
  };
}

/**
 * Registra ou atualiza o preço de uma compra confirmada.
 *
 * Preserva o comportamento da versão personalizada antiga:
 * cada item da lista possui no máximo um registro de compra.
 */
export function recordShoppingPurchase(db, item) {
  if (!item?.product_id || item.unit_price_cents == null) return;

  db.prepare(`
    INSERT INTO shopping_price_history
      (product_id, shopping_item_id, unit_price_cents, quantity)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shopping_item_id) WHERE shopping_item_id IS NOT NULL
    DO UPDATE SET
      product_id = excluded.product_id,
      unit_price_cents = excluded.unit_price_cents,
      quantity = excluded.quantity
  `).run(
    item.product_id,
    item.id,
    item.unit_price_cents,
    item.quantity ?? null
  );
}

/**
 * Converte o preço decimal informado pela interface para centavos.
 * Aceita vírgula ou ponto como separador decimal.
 */
export function parseUnitPriceCents(value, currency = 'EUR') {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { value: null, error: null };
  }
  let digits = 2;
  try { digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().minimumFractionDigits; }
  catch { /* ISO invalid: fallback to two digits */ }
  const normalized = String(value).trim().replace(',', '.');
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);
  if (!pattern.test(normalized)) return { value: null, error: 'Invalid price.' };
  const [whole, decimals = ''] = normalized.split('.');
  const units = Number(whole) * 10 ** digits + Number(decimals.padEnd(digits, '0'));
  if (!Number.isSafeInteger(units) || units < 0 || units > 100000000) {
    return { value: null, error: 'Invalid price.' };
  }
  return { value: units, error: null };
}
