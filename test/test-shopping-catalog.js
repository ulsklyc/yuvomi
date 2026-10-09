/**
 * Testes funcionais do catálogo personalizado de compras.
 * Utiliza exclusivamente banco SQLite em memória.
 */
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'shopping-catalog-test-secret';
process.env.DB_PATH = ':memory:';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');

const db = dbmod.get();

// Usuário fictício necessário para as chaves estrangeiras das listas.
db.prepare(`
  INSERT INTO users (id, username, display_name, password_hash, role)
  VALUES (1, 'catalog-test', 'Catalog Test', 'test-only', 'member')
`).run();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = 1;
  req.authRole = 'member';
  req.session = { userId: 1, role: 'member' };
  next();
});
app.use('/', shoppingRouter);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));

const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((resolve, reject) => {
  server.close(err => err ? reject(err) : resolve());
}));

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('GET /catalog retorna produtos cadastrados', async () => {
  const result = await call('GET', '/catalog');
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.data));
});

test('POST /catalog cadastra produto e GET permite pesquisar', async () => {
  const created = await call('POST', '/catalog', {
    name: 'Produto Teste Catalogo',
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.data.name, 'Produto Teste Catalogo');

  const found = await call('GET', '/catalog?q=Teste%20Catalogo');
  assert.equal(found.status, 200);
  assert.ok(found.body.data.some(p => p.id === created.body.data.id));
});

test('POST /catalog rejeita nome duplicado sem diferenciar maiúsculas', async () => {
  const result = await call('POST', '/catalog', {
    name: 'produto teste catalogo',
  });
  assert.equal(result.status, 409);
});

test('POST /catalog rejeita nome vazio', async () => {
  const result = await call('POST', '/catalog', { name: '   ' });
  assert.equal(result.status, 400);
});

test('POST /catalog rejeita categoria inexistente', async () => {
  const result = await call('POST', '/catalog', {
    name: 'Outro Produto Teste',
    category: 'Categoria Que Nao Existe XYZ',
  });
  assert.equal(result.status, 400);
});

test('GET /catalog retorna campos do histórico de preços', async () => {
  const result = await call('GET', '/catalog?q=Produto%20Teste%20Catalogo');
  assert.equal(result.status, 200);

  const product = result.body.data.find(p => p.name === 'Produto Teste Catalogo');
  assert.ok(product);
  assert.equal(product.last_price_cents, null);
  assert.equal(product.lowest_price_cents, null);
  assert.equal(product.price_history_count, 0);
});

test('PATCH /catalog edita nome e categoria do produto', async () => {
  const created = await call('POST', '/catalog', { name: 'Produto Para Editar' });
  assert.equal(created.status, 201);

  const categories = await call('GET', '/categories');
  const category = categories.body.data[0].name;

  const updated = await call('PATCH', `/catalog/${created.body.data.id}`, {
    name: 'Produto Editado',
    category,
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.name, 'Produto Editado');
  assert.equal(updated.body.data.category, category);
});

test('PATCH /catalog rejeita nome duplicado', async () => {
  const created = await call('POST', '/catalog', { name: 'Produto Unico Para Editar' });
  assert.equal(created.status, 201);

  const updated = await call('PATCH', `/catalog/${created.body.data.id}`, {
    name: 'PRODUTO EDITADO',
  });

  assert.equal(updated.status, 409);
});

test('PATCH /catalog retorna 404 para produto inexistente', async () => {
  const result = await call('PATCH', '/catalog/999999', {
    name: 'Produto Inexistente',
  });

  assert.equal(result.status, 404);
});

test('PATCH /catalog rejeita categoria inválida', async () => {
  const created = await call('POST', '/catalog', { name: 'Produto Categoria Teste' });
  assert.equal(created.status, 201);

  const updated = await call('PATCH', `/catalog/${created.body.data.id}`, {
    category: 'Categoria Inexistente XYZ',
  });

  assert.equal(updated.status, 400);
});

test('GET /catalog/:id/history retorna o historico de compras', async () => {
  const created = await call('POST', '/catalog', { name: 'Produto Historico Teste' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  db.prepare(`
    INSERT INTO shopping_price_history (product_id, unit_price_cents, quantity)
    VALUES (?, ?, ?)
  `).run(id, 1250, '2');

  const result = await call('GET', `/catalog/${id}/history`);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.product.last_price_cents, 1250);
  assert.equal(result.body.data.history.length, 1);
  assert.equal(result.body.data.history[0].unit_price_cents, 1250);
});

test('GET /catalog/:id/history retorna 404 para produto inexistente', async () => {
  const result = await call('GET', '/catalog/999999/history');
  assert.equal(result.status, 404);
});

test('DELETE /catalog remove produto e historico, preservando itens antigos', async () => {
  const list = await call('POST', '/', { name: 'Lista Teste Exclusao Catalogo' });
  assert.equal(list.status, 201);

  const item = await call('POST', `/${list.body.data.id}/items`, {
    name: 'Produto Exclusao Teste',
  });
  assert.equal(item.status, 201);

  const product = db.prepare(`
    SELECT * FROM shopping_products WHERE name = ?
  `).get('Produto Exclusao Teste');
  assert.ok(product);

  db.prepare(`
    INSERT INTO shopping_price_history (product_id, unit_price_cents)
    VALUES (?, ?)
  `).run(product.id, 899);

  const deleted = await call('DELETE', `/catalog/${product.id}`);
  assert.equal(deleted.status, 200);

  assert.equal(
    db.prepare('SELECT id FROM shopping_products WHERE id = ?').get(product.id),
    undefined
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS total FROM shopping_price_history WHERE product_id = ?')
      .get(product.id).total,
    0
  );

  const preserved = db.prepare('SELECT * FROM shopping_items WHERE id = ?')
    .get(item.body.data.id);

  assert.ok(preserved);
  assert.equal(preserved.name, 'Produto Exclusao Teste');
  assert.equal(preserved.product_id, null);
});

test('DELETE /catalog retorna 404 para produto inexistente', async () => {
  const result = await call('DELETE', '/catalog/999999');
  assert.equal(result.status, 404);
});

test('Adicionar produto do catálogo recupera automaticamente o último preço', async () => {
  const created = await call('POST', '/catalog', {
    name: 'Arroz Teste Preco Automatico',
  });
  assert.equal(created.status, 201);

  const productId = created.body.data.id;

  db.prepare(`
    INSERT INTO shopping_price_history (product_id, unit_price_cents, quantity)
    VALUES (?, ?, ?)
  `).run(productId, 2590, '1');

  const list = await call('POST', '/', {
    name: 'Lista Teste Preco Automatico',
  });
  assert.equal(list.status, 201);

  const categories = await call('GET', '/categories');
  const category = categories.body.data[0].name;

  const added = await call('POST', `/${list.body.data.id}/items`, {
    name: 'Arroz Teste Preco Automatico',
    quantity: '2',
    category,
  });

  assert.equal(added.status, 201);
  assert.equal(added.body.data.product_id, productId);
  assert.equal(added.body.data.unit_price_cents, 2590);
  assert.equal(added.body.data.last_price_cents, 2590);
});


test('Compra confirmada permanece no histórico após desmarcar e é corrigida ao remarcar', async () => {
  const list = await call('POST', '/', { name: 'Lista Teste Historico Permanente' });
  assert.equal(list.status, 201);
  const added = await call('POST', `/${list.body.data.id}/items`, {
    name: 'Produto Historico Permanente', quantity: '1',
  });
  assert.equal(added.status, 201);
  const itemId = added.body.data.id;
  const productId = added.body.data.product_id;

  const first = await call('PATCH', `/items/${itemId}`, {
    is_checked: 1, quantity: '1', price_cents: 2590,
  });
  assert.equal(first.status, 200);

  const unchecked = await call('PATCH', `/items/${itemId}`, { is_checked: 0 });
  assert.equal(unchecked.status, 200);
  assert.equal(unchecked.body.data.is_checked, 0);

  const historyAfterUncheck = await call('GET', `/catalog/${productId}/history`);
  assert.equal(historyAfterUncheck.status, 200);
  assert.equal(historyAfterUncheck.body.data.history.length, 1);
  assert.equal(historyAfterUncheck.body.data.history[0].unit_price_cents, 2590);

  const corrected = await call('PATCH', `/items/${itemId}`, {
    is_checked: 1, quantity: '2', price_cents: 2790,
  });
  assert.equal(corrected.status, 200);
  const historyAfterCorrection = await call('GET', `/catalog/${productId}/history`);
  assert.equal(historyAfterCorrection.status, 200);
  assert.equal(historyAfterCorrection.body.data.history.length, 1);
  assert.equal(historyAfterCorrection.body.data.history[0].unit_price_cents, 2790);
  assert.equal(historyAfterCorrection.body.data.history[0].quantity, '2');
});
