/**
 * Test: Rezept -> Einkauf durch die ECHTEN Gates (#1290, Entscheidung 22.09.2026)
 * Zweck: `POST /recipes/:id/to-shopping-list` LIEST ein Rezept und SCHREIBT in
 *        den Einkauf. Der Pfad-Guard in server/index.js misst `/recipes` als
 *        `meals` und verlangte dafuer bisher `meals: write` - ein Mitglied, das
 *        den Essensplan nur ansehen darf, konnte so kein Rezept auf die Liste
 *        setzen, obwohl dabei am Essensplan nichts geschrieben wird. Entschieden:
 *        fuer GENAU diese Route reicht `meals: read` (Quelle lesen), die Route
 *        verlangt weiter `shopping: write` (Ziel schreiben). Fuer Mitgliedsrechte
 *        und Token-Scopes gleich.
 *
 *        Die Ausnahme ist schmal, und die Suite haelt die Raender fest: jeder
 *        andere Schreibweg unter `/recipes` bleibt bei `meals: write`, eine
 *        andere Methode auf demselben Pfad ebenso, `meals: none` bleibt zu, und
 *        Mahlzeit -> Einkauf bleibt bei `meals: write` (dort kippt die Route
 *        `on_shopping_list` im Essensplan). Die Schreibweise des Pfads wird wie
 *        sonst am Guard gefaltet (GHSA-cvwj, test-module-gate-path-case.js).
 *
 *        Gemessen wird der EFFEKT mit: nach einem 403 ist kein Artikel entstanden.
 * Ausfuehren: npm run test:recipe-transfer-gate
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'recipe-transfer-gate',
  env: { SESSION_SECRET: 'test-recipe-transfer-gate-secret-min32c' },
});
const dbmod = await import('../server/db.js');
const db = dbmod.get();

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = as(await login('admin', 'adminpass123'));
const list = await admin('POST', '/shopping', { name: 'REWE' });
assert.equal(list.status, 201, 'Einkaufsliste');
const LIST = list.body.data.id;

const created = await admin('POST', '/auth/users', { username: 'member1', display_name: 'Member', password: 'memberpass123' });
assert.equal(created.status, 201);
const memberId = created.body.user.id;
const member = as(await login('member1', 'memberpass123'));

async function setAccess(modules) {
  const r = await admin('PUT', `/permissions/user/${memberId}`, { modules });
  assert.equal(r.status, 200, `Rechte ${JSON.stringify(modules)}`);
}

let n = 0;
/** Ein frisches Rezept mit einer eindeutigen Zutat, damit der Effekt zaehlbar ist. */
async function seedRecipe() {
  n += 1;
  const zutat = `Zutat-${n}`;
  const r = await admin('POST', '/recipes', { title: `Rezept ${n}`, ingredients: [{ name: zutat, quantity: '1' }] });
  assert.equal(r.status, 201, 'Rezept anlegen');
  return { id: r.body.data.id, zutat };
}
const onList = (zutat) => db.prepare('SELECT COUNT(*) AS c FROM shopping_items WHERE list_id = ? AND name = ?').get(LIST, zutat).c;

function withToken(scopes) {
  n += 1;
  const token = `yuvomi_test_recipe_transfer_${n}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes)
    VALUES (?, ?, 'yuvomi_test', 1, ?)
  `).run(`t${n}`, crypto.createHash('sha256').update(token).digest('hex'), JSON.stringify(scopes));
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

// -------------------------------------------------------------------------
// Mitgliedsrechte
// -------------------------------------------------------------------------

test('Mitglied mit meals: read + shopping: write setzt ein Rezept auf die Liste', async () => {
  await setAccess({ meals: 'read', shopping: 'write' });
  const { id, zutat } = await seedRecipe();
  const r = await member('POST', `/recipes/${id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(onList(zutat), 1);
});

test('Mitglied mit meals: read + shopping: read bleibt draussen - das Ziel entscheidet die Route', async () => {
  await setAccess({ meals: 'read', shopping: 'read' });
  const { id, zutat } = await seedRecipe();
  const r = await member('POST', `/recipes/${id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 403);
  assert.equal(onList(zutat), 0);
});

test('Mitglied mit meals: none bleibt draussen - wer die Quelle nicht lesen darf, uebertraegt sie nicht', async () => {
  await setAccess({ meals: 'none', shopping: 'write' });
  const { id, zutat } = await seedRecipe();
  const r = await member('POST', `/recipes/${id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 403);
  assert.equal(onList(zutat), 0);
});

test('meals: read - jeder andere Schreibweg unter /recipes bleibt zu', async () => {
  await setAccess({ meals: 'read', shopping: 'write' });
  const { id } = await seedRecipe();
  assert.equal((await member('PUT', `/recipes/${id}`, { title: 'umbenannt' })).status, 403, 'PUT /recipes/:id');
  assert.equal((await member('DELETE', `/recipes/${id}`)).status, 403, 'DELETE /recipes/:id');
  assert.equal((await member('POST', '/recipes', { title: 'neu' })).status, 403, 'POST /recipes');
  assert.equal((await member('POST', `/recipes/${id}/duplicate`)).status, 403, 'POST /recipes/:id/duplicate');
  // Dieselbe Adresse mit einer anderen Methode: die Ausnahme nennt POST.
  assert.equal((await member('PUT', `/recipes/${id}/to-shopping-list`, { listId: LIST })).status, 403, 'PUT auf den Transferpfad');
  // Ein laengerer Pfad ist nicht mitgemeint.
  assert.equal((await member('POST', `/recipes/${id}/to-shopping-listX`, { listId: LIST })).status, 403, 'kein startsWith');
  const titel = db.prepare('SELECT title FROM recipes WHERE id = ?').get(id).title;
  assert.notEqual(titel, 'umbenannt', 'das Rezept blieb unveraendert');
});

test('meals: read - Mahlzeit -> Einkauf bleibt bei meals: write (die Route schreibt in den Plan)', async () => {
  await setAccess({ meals: 'read', shopping: 'write' });
  const meal = await admin('POST', '/meals', {
    date: '2026-09-21', meal_type: 'lunch', title: 'Suppe', ingredients: [{ name: 'Linsen-gate', quantity: '1' }],
  });
  assert.equal(meal.status, 201, JSON.stringify(meal.body));
  const r = await member('POST', `/meals/${meal.body.data.id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 403);
  assert.equal(onList('Linsen-gate'), 0);
});

test('Schreibweise und Schlussstrich: gefaltet wie der Guard sonst (GHSA-cvwj)', async () => {
  const { id, zutat } = await seedRecipe();
  await setAccess({ meals: 'none', shopping: 'write' });
  for (const pfad of [`/Recipes/${id}/To-Shopping-List`, `/RECIPES/${id}/to-shopping-list/`]) {
    assert.equal((await member('POST', pfad, { listId: LIST })).status, 403, `meals: none, ${pfad}`);
  }
  assert.equal(onList(zutat), 0);
  await setAccess({ meals: 'read', shopping: 'write' });
  const r = await member('POST', `/Recipes/${id}/To-Shopping-List/`, { listId: LIST });
  assert.equal(r.status, 200, 'dieselbe Route unter anderer Schreibweise urteilt gleich');
  assert.equal(onList(zutat), 1);
  assert.equal((await member('PUT', `/Recipes/${id}`, { title: 'umbenannt' })).status, 403, 'PUT /Recipes/:id bleibt zu');
});

// -------------------------------------------------------------------------
// Token-Scopes: dieselbe Regel auf der zweiten Achse
// -------------------------------------------------------------------------

test('Token mit meals:read + shopping:write setzt ein Rezept auf die Liste', async () => {
  await setAccess({});
  const call = withToken(['meals:read', 'shopping:write']);
  const { id, zutat } = await seedRecipe();
  const r = await call('POST', `/recipes/${id}/to-shopping-list`, { listId: LIST });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(onList(zutat), 1);
  assert.equal((await call('PUT', `/recipes/${id}`, { title: 'umbenannt' })).status, 403, 'PUT /recipes/:id bleibt zu');
  assert.equal((await call('POST', `/meals/1/to-shopping-list`, { listId: LIST })).status, 403, 'Mahlzeit -> Einkauf bleibt zu');
});

test('Token mit meals:read + shopping:read bleibt draussen', async () => {
  const call = withToken(['meals:read', 'shopping:read']);
  const { id, zutat } = await seedRecipe();
  assert.equal((await call('POST', `/recipes/${id}/to-shopping-list`, { listId: LIST })).status, 403);
  assert.equal(onList(zutat), 0);
});

test('READ_LEVEL_WRITES: jeder Eintrag mit Methodenliste nennt genau die Methoden des Routers', async () => {
  const { READ_LEVEL_WRITES } = await import('../server/scopes.js');
  const routers = { recipes: (await import('../server/routes/recipes.js')).default };
  const mitMethoden = READ_LEVEL_WRITES.filter((e) => e.methods !== null);
  assert.ok(mitMethoden.length > 0, 'Gegenprobe: es gibt Eintraege mit Methodenliste');
  for (const entry of mitMethoden) {
    const re = new RegExp(entry.pattern, entry.flags);
    const praefix = entry.pattern.match(/^\^\\\/([a-z-]+)\\\//)?.[1];
    assert.ok(routers[praefix], `${entry.id}: den Router fuer /${praefix} hier eintragen`);
    const methoden = new Set();
    for (const layer of routers[praefix].stack) {
      if (!layer.route) continue;
      const beispiel = `/${praefix}${String(layer.route.path).replace(/:[A-Za-z_]+/g, '1')}`;
      if (!re.test(beispiel)) continue;
      for (const [m, an] of Object.entries(layer.route.methods)) if (an) methoden.add(m.toUpperCase());
    }
    assert.deepEqual([...methoden].sort(), [...entry.methods].sort(),
      `${entry.id}: die Tabelle muss genau die Methoden nennen, die der Router unter dem Pfad fuehrt`);
  }
});

test('Token ohne meals-Scope bleibt draussen, auch unter anderer Schreibweise', async () => {
  const call = withToken(['shopping:write']);
  const { id, zutat } = await seedRecipe();
  for (const pfad of [`/recipes/${id}/to-shopping-list`, `/Recipes/${id}/To-Shopping-List/`]) {
    assert.equal((await call('POST', pfad, { listId: LIST })).status, 403, pfad);
  }
  assert.equal(onList(zutat), 0);
});
