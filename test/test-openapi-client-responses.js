/**
 * Test: Echte Antworten gegen die Schemas des Client-Vertrags (Refs #255)
 *
 * Zweck: `test:openapi-client-contract` prueft, dass ein Schema da ist, nicht ob es
 *        stimmt. Ein erzeugtes Modell, das am ersten echten Datensatz scheitert,
 *        ist schlimmer als keines. Diese Suite faehrt jede Lese- und Schreib-
 *        Operation des Vertrags gegen einen echten Server und haelt die Antwort
 *        gegen die Spec. Felder, die das Schema nicht nennt, sind rot.
 *
 * Ausfuehren: npm run test:openapi-client-responses
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';
import { schemaProblems } from './openapi-schema-check.js';
import { buildOpenApiSpec } from '../server/openapi.js';
import { toLocalDateKey } from '../public/utils/date.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'openapi-client-responses',
  env: { SESSION_SECRET: 'test-openapi-client-responses-min32chars', RATE_LIMIT_MAX_ATTEMPTS: 200 },
});

const API = `${BASE}/api/v1`;
const json = { 'Content-Type': 'application/json' };
const spec = buildOpenApiSpec({ protocol: 'http', get: () => 'localhost' }, '0.0.0');

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
});
const cookie = cookieHeader(loginRes.headers.get('set-cookie'));
const { csrfToken } = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
const session = { ...json, Cookie: cookie, 'X-CSRF-Token': csrfToken };

/**
 * Ruft eine Operation auf und prueft die Antwort gegen ihr Schema.
 * @param {string} method klein, wie in der Spec
 * @param {string} template der Pfad der Spec, etwa `/api/v1/tasks/{id}`
 * @param {object} [options] `params` fuer den Pfad, `query`, `body`, `headers`, `ignore`
 * @returns die geparste Antwort, fuer den naechsten Schritt
 */
async function call(method, template, { params = {}, query = '', body, headers = session, ignore = [] } = {}) {
  const label = `${method.toUpperCase()} ${template}`;
  const path = template.replace(/\{(\w+)\}/g, (_, name) => params[name]);
  const res = await fetch(`${BASE}${path}${query}`, {
    method: method.toUpperCase(), headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const response = spec.paths[template]?.[method]?.responses?.[res.status];
  assert.ok(response, `${label}: Status ${res.status} nicht in der Spec. ${text.slice(0, 200)}`);
  assert.ok(res.status < 300, `${label}: ${res.status} ${text.slice(0, 200)}`);
  // Keine Antwort, kein Schema: dasselbe laesst test:openapi-client-contract zu.
  if (res.status === 204) return null;
  const resolved = response.$ref
    ? response.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], spec)
    : response;
  const schema = resolved.content?.['application/json']?.schema;
  assert.ok(schema, `${label}: ${res.status} ohne Schema`);
  assert.deepEqual(schemaProblems(spec, schema, data, '$', { ignore }), [], label);
  return data;
}

// Die Abschnitte fuellen je Modul die Fixtures und rufen `call()`. Sie teilen sich
// den Server, jeder legt seine Daten selbst an.

// --- Anmeldung, Geraete, Instanz, Uebersicht, Erinnerungen ---
{
  const seed = async (method, path, body, headers = session) => {
    const res = await fetch(`${API}${path}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    assert.ok(res.status < 300, `${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  /** Eine eigene Sitzung, fuer alles, was nicht das Admin-Konto sein soll. */
  const signIn = async (username, password) => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: json, body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200, `Anmeldung ${username}`);
    const Cookie = cookieHeader(res.headers.get('set-cookie'));
    const { csrfToken: token } = await seed('GET', '/auth/me', undefined, { Cookie });
    return { ...json, Cookie, 'X-CSRF-Token': token };
  };

  const account = async (username, family_role = 'parent') => {
    const password = `${username}-pass-123`;
    const { user } = await seed('POST', '/auth/users', { username, display_name: username, password, family_role });
    return { id: user.id, headers: await signIn(username, password), password };
  };

  /** Ein Tag der Haushaltszone, genau wie ihn die Route rechnet. */
  const householdDay = async (offset = 0) => {
    const [db, { todayKey, shiftDateKey }] = await Promise.all([
      import('../server/db.js'), import('../server/utils/timezone.js'),
    ]);
    return shiftDateKey(todayKey(db.get()), offset);
  };

  const { user: { id: adminId } } = await seed('GET', '/auth/me');
  const utcStamp = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19);
  const HOUR_MS = 60 * 60 * 1000;

  test('Instanz: ohne Anmeldung nur, was vor der Anmeldung zaehlt', async () => {
    const open = await call('get', '/api/v1/version', { headers: json });
    assert.equal(open.product, 'yuvomi');
    assert.equal('version' in open, false);
    assert.equal('max_upload_bytes' in open, false);

    const signedIn = await call('get', '/api/v1/version');
    assert.equal(typeof signedIn.version, 'string');
    assert.ok(signedIn.max_upload_bytes > 0);
  });

  test('Anmeldung: Passwort, Konto und Anmeldewege', async () => {
    const options = await call('get', '/api/v1/auth/oidc/config', { headers: json });
    assert.equal(options.password_login_enabled, true);

    const login = await call('post', '/api/v1/auth/login', {
      headers: json, body: { username: 'admin', password: 'adminpass123' },
    });
    assert.equal(login.permissions.admin, true);
    assert.equal(typeof login.user.onboarding_pending, 'boolean');
    assert.ok('version' in login.user.changelog_seen);

    const me = await call('get', '/api/v1/auth/me');
    assert.equal(me.user.id, adminId);
    assert.equal(typeof me.csrfToken, 'string');
    assert.ok(me.sessionExpiresAt > Date.now());
    assert.equal(me.user.sso_only, false);
    assert.equal(me.user.access_scope, 'family');

    // Ein Konto, das alles ausgefuellt hat: die Felder oben standen alle auf null.
    const person = await account('konto-profil');
    await seed('PATCH', '/auth/me/profile', {
      avatar_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      phone: '+49 30 123', email: 'profil@example.org', birth_date: '1980-02-29',
    }, person.headers);
    await seed('POST', '/auth/changelog-seen', { latest: '99.0.0' }, person.headers);
    const { user } = await call('get', '/api/v1/auth/me', { headers: person.headers });
    assert.equal(user.phone, '+49 30 123');
    assert.equal(user.email, 'profil@example.org');
    assert.equal(user.birth_date, '1980-02-29');
    assert.equal(user.changelog_seen.latest, '99.0.0');
    assert.match(user.avatar_data, /^data:image\/png/);
  });

  test('Anmeldung: zweiter Faktor mit Wiederherstellungscode und TOTP', async () => {
    const { generateCode } = await import('../server/utils/totp.js');
    const person = await account('konto-2fa');
    const { data: setup } = await seed('POST', '/auth/2fa/setup', {}, person.headers);
    const { data: enabled } = await seed('POST', '/auth/2fa/enable', { code: generateCode(setup.secret) }, person.headers);

    const body = { username: 'konto-2fa', password: person.password };
    const challenge = await call('post', '/api/v1/auth/login', { headers: json, body });
    assert.deepEqual(challenge, { twoFactorRequired: true, recoveryAvailable: true });

    // Der Wartezustand haengt am Cookie der Anmeldung, und `call()` gibt keine Kopfzeilen heraus.
    const pending = async () => {
      const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: json, body: JSON.stringify(body) });
      return { ...json, Cookie: cookieHeader(res.headers.get('set-cookie')) };
    };
    const byRecovery = await call('post', '/api/v1/auth/2fa/verify', {
      headers: await pending(), body: { code: enabled.recovery_codes[0] },
    });
    assert.equal(byRecovery.twoFactorMethod, 'recovery');
    assert.equal(byRecovery.recoveryRemaining, enabled.recovery_codes.length - 1);
    assert.equal(byRecovery.user.id, person.id);

    // Der naechste Schritt: den, mit dem eingeschaltet wurde, nimmt der Server nicht zweimal.
    const byTotp = await call('post', '/api/v1/auth/2fa/verify', {
      headers: await pending(), body: { code: generateCode(setup.secret, Date.now() + 30_000) },
    });
    assert.equal(byTotp.twoFactorMethod, 'totp');
  });

  test('Geraete: ausstellen, koppeln, lesen, abmelden', async () => {
    const LIST = '/api/v1/auth/devices';
    const added = await call('post', LIST, {
      body: { name: 'Telefon', platform: 'ios', device_id: 'telefon-vertrag-1' },
    });
    assert.equal(added.data.current, false);
    const bearer = { ...json, Authorization: `Bearer ${added.credential}` };

    const fromSession = await call('get', LIST);
    assert.equal(fromSession.data.find((row) => row.id === added.data.id).current, false);
    const fromDevice = await call('get', LIST, { headers: bearer });
    const own = fromDevice.data.find((row) => row.id === added.data.id);
    assert.equal(own.current, true);
    assert.equal(typeof own.last_used_at, 'string');

    // Mit Bearer gibt es keine Sitzung und damit weder CSRF-Token noch Ablauf,
    // und ein Admin ist auf dem Geraet ein gewoehnliches Mitglied.
    const me = await call('get', '/api/v1/auth/me', { headers: bearer });
    assert.equal('csrfToken' in me, false);
    assert.equal('sessionExpiresAt' in me, false);
    assert.equal(me.permissions.admin, false);
    assert.equal(typeof (await call('get', '/api/v1/version', { headers: bearer })).version, 'string');

    const { data: pairing } = await seed('POST', '/auth/devices/pair', { server: BASE });
    const redeemed = await call('post', '/api/v1/auth/devices/pair/redeem', {
      headers: json, body: { code: pairing.code, name: 'Tablet', platform: 'ipados', device_id: 'tablet-vertrag-1' },
    });
    assert.equal(redeemed.data.name, 'Tablet');

    assert.deepEqual(await call('delete', '/api/v1/auth/devices/{id}', { params: { id: redeemed.data.id } }), { ok: true });
    assert.deepEqual(await call('delete', '/api/v1/auth/devices/current', { headers: bearer }), { ok: true });
    assert.equal((await fetch(`${API}/auth/me`, { headers: bearer })).status, 401);
  });

  test('Erinnerungen: bevorstehend, faellig, verworfen, je Herkunft', async () => {
    const { data: task } = await seed('POST', '/tasks', { title: 'Vertrag pruefen', due_date: await householdDay(2) });
    const heir = await account('konto-erbe');
    const { data: event } = await seed('POST', '/calendar', {
      title: 'Vertragstermin', start_datetime: `${await householdDay(2)}T10:00:00Z`, assigned_to: [heir.id],
    });
    const remind = async (entity_type, entity_id, offsetMs) => (await seed('POST', '/reminders', {
      entity_type, entity_id, remind_at: utcStamp(offsetMs),
    })).data;
    await remind('task', task.id, 24 * HOUR_MS);
    await remind('event', event.id, 24 * HOUR_MS);

    const upcoming = await call('get', '/api/v1/reminders/upcoming', {
      query: `?from=${utcStamp(0)}&to=${utcStamp(48 * HOUR_MS)}`,
    });
    assert.deepEqual(upcoming.data.map((row) => row.entity_title).sort(), ['Vertrag pruefen', 'Vertragstermin']);
    for (const row of upcoming.data) assert.ok(row.fires_at.endsWith('Z'));
    const inherited = await call('get', '/api/v1/reminders/upcoming', {
      query: `?from=${utcStamp(0)}&to=${utcStamp(48 * HOUR_MS)}&types=event`, headers: heir.headers,
    });
    assert.equal(inherited.data[0].assigned_from, adminId);

    const dueTask = await remind('task', task.id, -HOUR_MS);
    await remind('event', event.id, -HOUR_MS);
    // Die Meldung eines zurueckgenommenen Umzugs entsteht nur im CalDAV-Rueckweg;
    // hier ruft die Suite denselben Dienst, den dieser Weg ruft.
    const [db, { noteMoveTakenBack }] = await Promise.all([
      import('../server/db.js'), import('../server/services/shopping-move-notices.js'),
    ]);
    const { data: back } = await seed('POST', '/shopping', { name: 'Vertrag zurueck' });
    const { data: target } = await seed('POST', '/shopping', { name: 'Vertrag Ziel' });
    const { data: item } = await seed('POST', `/shopping/${back.id}/items`, { name: 'Hafer' });
    noteMoveTakenBack(db.get(), {
      movedBy: adminId, itemId: item.id, itemName: item.name, backListId: back.id, targetListId: target.id, reason: 'refused',
    });

    const pending = await call('get', '/api/v1/reminders/pending');
    assert.ok(['task', 'event', 'shopping_move_returned'].every((type) => pending.data.some((row) => row.entity_type === type)));
    const returned = pending.data.find((row) => row.entity_type === 'shopping_move_returned');
    assert.equal(returned.move_notice.reason, 'refused');
    assert.equal(returned.target_url, `/shopping?list=${back.id}`);
    assert.deepEqual((await call('get', '/api/v1/reminders/pending', { query: '?audience=household' })).data, []);

    assert.deepEqual(await call('patch', '/api/v1/reminders/{id}/dismiss', { params: { id: dueTask.id } }), { data: { id: dueTask.id } });
    const left = await call('get', '/api/v1/reminders/pending');
    assert.equal(left.data.some((row) => row.id === dueTask.id), false);
  });

  test('Uebersicht: volle Daten, Konten mit weniger Rechten, Wand und abgeschaltete Module', async () => {
    const DASHBOARD = '/api/v1/dashboard';
    // Die App liest diese drei in v1 nicht, und ihre Modelle sollen sie nicht
    // kennen. Das Schema laesst deshalb weitere Felder zu - was die Suite sonst
    // rot machen wuerde, prueft `overview()` darum selbst.
    const NOT_IN_CONTRACT = ['budget', 'health', 'fasting'];
    const ignore = NOT_IN_CONTRACT.map((field) => `$.${field}`);
    const listed = spec.components.schemas.DashboardResponse.properties;
    const overview = async ({ query = '', headers = session } = {}) => {
      const data = await call('get', DASHBOARD, { query, headers, ignore });
      assert.deepEqual(Object.keys(data).filter((key) => !(key in listed) && !NOT_IN_CONTRACT.includes(key)), []);
      return data;
    };

    const today = await householdDay();
    const { data: { disabled_modules: disabledBefore } } = await seed('GET', '/preferences');
    // Abfuhr und Schichtplan sind auf einer neuen Installation aus, sonst bleiben ihre Felder leer.
    await seed('PUT', '/preferences', { disabled_modules: [] });
    try {
      const child = await account('konto-kind', 'child');
      const stranger = await account('konto-gast', 'grandparent');
      const restricted = await account('konto-eng');

      const { data: members } = await seed('GET', '/family/members');
      await seed('PATCH', '/family/members/reorder', { order: members.map((row) => row.id).reverse() });
      await seed('PATCH', '/auth/me/profile', { birth_date: `2012-${today.slice(5)}` }, child.headers);

      await seed('POST', '/tasks', {
        title: 'Heute faellig', description: 'Mit Text', start_date: await householdDay(-1), due_date: today, due_time: '18:00', priority: 'high',
        assigned_to: [adminId, child.id], countdown: 1, visibility: 'all',
      });
      await seed('POST', '/tasks', { title: 'Von gestern', due_date: await householdDay(-1), assigned_to: [adminId] });
      await seed('POST', '/tasks', { title: 'Schon fertig', due_date: today, assigned_to: [adminId], status: 'done' });
      await seed('POST', '/calendar', {
        title: 'Elternabend', start_datetime: `${await householdDay(1)}T17:00:00Z`, end_datetime: `${await householdDay(1)}T18:00:00Z`,
        assigned_to: [adminId], countdown: 1,
      });
      await seed('POST', '/calendar', { title: 'Klassenfahrt', start_datetime: today, all_day: 1, assigned_to: [child.id] });

      const { data: list } = await seed('POST', '/shopping', { name: 'Wocheneinkauf' });
      const { data: emptyList } = await seed('POST', '/shopping', { name: 'Noch leer' });
      await seed('POST', `/shopping/${list.id}/items`, { name: 'Milch', quantity: '2 l' });
      await seed('POST', `/shopping/${list.id}/items`, { name: 'Brot' });

      const { data: recipe } = await seed('POST', '/recipes', { title: 'Linsensuppe' });
      await seed('POST', '/meals', {
        date: today, meal_type: 'dinner', title: 'Suppe', notes: 'scharf', recipe_id: recipe.id, recipe_url: 'https://example.org/suppe', cook_user_id: child.id,
      });
      await seed('POST', '/meals', { date: today, meal_type: 'lunch', title: 'Jede Woche', repeat_weekly: true });

      const { data: category } = await seed('POST', '/notes/categories', { name: 'Vertrag', scope: 'household' });
      await seed('POST', '/notes', { title: 'Oben', content: 'Text', pinned: 1, category_ids: [category.id] });

      await seed('POST', '/birthdays', {
        name: 'Tante', birth_date: `1952-${today.slice(5)}`, name_day: today.slice(5), notes: 'Blumen',
        reminder_offset: 'custom', reminder_custom_amount: 2, reminder_custom_unit: 'days',
      });
      await seed('POST', '/birthdays', { name: 'Onkel', birth_date: `2000-${today.slice(5)}`, year_unknown: true });
      await seed('POST', '/quick-links', { name: 'Kita', url: 'https://example.org', color: '#336699', icon_name: 'star' });
      await seed('POST', '/documents', {
        name: 'Ausweis', original_name: 'ausweis.txt', content_data: 'data:text/plain;base64,YQ==',
        expires_at: await householdDay(3), subject_user_id: child.id,
      });

      const { data: location } = await seed('POST', '/pantry/locations', { name: 'Vertragskeller' });
      await seed('POST', '/pantry', { name: 'Joghurt', quantity: 2, unit: 'pcs', location_id: location.id, expires_on: today });
      await seed('POST', '/pantry', { name: 'Sahne', quantity: 1, unit: 'pcs', expires_on: await householdDay(-2) });

      const { data: worker } = await seed('POST', '/housekeeping/worker', { display_name: 'Petra', daily_rate: 50 });
      await seed('POST', '/housekeeping/work-sessions/check-in', { worker_id: worker.id, daily_rate: 50 });
      await seed('POST', '/housekeeping/work-sessions/check-out', { worker_id: worker.id });
      await seed('POST', '/housekeeping/work-sessions/check-in', { worker_id: worker.id, daily_rate: 50 });

      await seed('PUT', `/rewards/participants/${adminId}`, { enabled: true });
      await seed('PUT', `/rewards/participants/${child.id}`, { enabled: true });
      await seed('POST', '/rewards/catalog', { name: 'Kino', cost: 50, quantity: 3 });
      await seed('POST', '/rewards/bonus', { user_id: child.id, delta: 20, reason: 'Geholfen' });

      const { data: shift } = await seed('POST', '/schedule/shift-types', { name: 'Frueh', short_code: 'F', start_time: '06:00', end_time: '14:00', icon: 'sun' });
      await seed('PUT', `/schedule/overrides/${today}`, { shift_type_id: shift.id });
      const { data: wasteType } = await seed('POST', '/waste/types', { name: 'Papier', color: '#3366CC', icon: 'recycle' });
      await seed('POST', '/waste/pickups', { type_id: wasteType.id, date: today });

      const { data: group } = await seed('POST', '/split-expenses/groups', { name: 'Urlaub', default_currency: 'EUR' });
      await seed('POST', `/split-expenses/groups/${group.id}/members`, { user_id: child.id });
      await seed('POST', `/split-expenses/groups/${group.id}/expenses`, {
        title: 'Hotel', amount: '90.00', currency: 'EUR', payer_id: child.id, participants: [adminId, child.id],
        split_method: 'equal', expense_date: today,
      });

      await seed('PUT', '/health/nutrition/targets', { energy_kcal: 2000 });
      await seed('POST', '/health/nutrition/entries', {
        title: 'Fruehstueck', consumed_at: `${today}T08:00`, meal_type: 'breakfast', energy_kcal: 400, visibility: 'private',
      });

      const full = await overview();
      for (const field of ['users', 'upcomingEvents', 'familyEvents', 'weekEvents', 'birthdays', 'urgentTasks', 'memberTodayTasks',
        'wallTasks', 'todayMeals', 'pinnedNotes', 'shoppingLists', 'countdowns', 'quicklinks', 'wastePickups', 'myShiftsToday']) {
        assert.ok(full[field].length > 0, `${field} ist leer und belegt nichts`);
      }
      assert.equal('shoppingTile' in full, false);
      assert.equal(full.rewards.view, 'approver');
      assert.equal(full.rewards.me, adminId);
      assert.ok(full.splitBalance.net.length && full.splitBalance.positions.length);
      assert.equal(full.nutrition.entryCount, 1);
      assert.equal(full.nutrition.target.energy_kcal, 2000);
      assert.equal(full.housekeeping.present, true);
      assert.equal(typeof full.housekeeping.lastVisit, 'string');
      assert.ok(full.pantryExpiring.items.length === 2 && full.pantryExpiring.todayItems.length === 1);
      assert.deepEqual([...new Set(full.countdowns.map((row) => row.source))].sort(), ['document', 'event', 'task']);
      assert.equal(full.countdowns.find((row) => row.source === 'document').person_name, 'konto-kind');
      assert.ok(full.birthdays.some((row) => row.kind === 'name_day'));
      assert.ok(full.todayMeals.some((row) => row.cook_name === 'konto-kind' && row.recipe_has_own_image === 0));
      assert.ok(full.todayMeals.some((row) => row.recurrence_template_id !== null));
      assert.ok(full.users.every((row) => Number.isInteger(row.sort_order)));
      assert.ok(full.birthdays.some((row) => row.family_user_id === child.id && row.family_user_color));
      assert.ok(full.birthdays.some((row) => row.reminder_custom_amount === 2));

      const tile = await overview({ query: `?shopping_list=${emptyList.id}&shopping_list=${list.id}` });
      assert.equal(tile.shoppingTile.listCount, 2);
      assert.ok(tile.shoppingTile.lists.some((row) => row.items.length === 0));

      // Wer selbst sammelt, sieht die eigene Zeile und die letzte Gutschrift, aber keine Betraege.
      const own = await overview({ headers: child.headers });
      assert.equal(own.rewards.view, 'self');
      assert.equal(own.rewards.recent.length, 1);
      assert.equal(own.housekeeping.unpaidAmount, null);

      const notCollecting = await overview({ headers: stranger.headers });
      assert.equal(notCollecting.rewards.view, 'family');

      // Ein Konto ohne Module: jedes Feld bleibt da, in seiner leeren Form.
      await seed('PUT', `/permissions/user/${restricted.id}`, {
        modules: Object.fromEntries(['calendar', 'tasks', 'meals', 'notes', 'shopping', 'budget', 'rewards', 'health',
          'housekeeping', 'waste', 'schedule', 'pantry'].map((key) => [key, 'none'])),
      });
      const denied = await overview({ query: `?shopping_list=${list.id}`, headers: restricted.headers });
      assert.equal('shoppingTile' in denied, false);
      assert.equal(denied.rewards.view, null);
      assert.equal('me' in denied.rewards, false);
      assert.equal(denied.nutrition.date, null);
      assert.deepEqual(denied.urgentTasks, []);

      const household = await overview({ query: '?audience=household' });
      assert.deepEqual(household.pinnedNotes, []);
      assert.equal(household.housekeeping.present, true);

      const { data: display } = await seed('POST', '/displays', { display_name: 'Kueche' });
      const { data: pairing } = await seed('POST', `/displays/${display.id}/pairing-code`, {});
      const paired = await fetch(`${API}/displays/pair`, { method: 'POST', headers: json, body: JSON.stringify({ code: pairing.code }) });
      const wall = await overview({ query: '?audience=household', headers: { Cookie: cookieHeader(paired.headers.get('set-cookie')) } });
      assert.deepEqual(wall.pantryExpiring.todayItems, [{ name: 'Joghurt' }]);
      assert.ok(wall.todayMeals.every((row) => !('notes' in row)));

      const { credential } = await seed('POST', '/auth/devices', { name: 'Uebersicht', platform: 'ios', device_id: 'uebersicht-vertrag' });
      const onDevice = await overview({ headers: { ...json, Authorization: `Bearer ${credential}` } });
      assert.ok(onDevice.urgentTasks.length > 0);

      // Der Haushalt hat die Module abgeschaltet: dieselbe leere Form wie ohne Recht.
      await seed('PUT', '/preferences', { disabled_modules: ['calendar', 'tasks', 'shopping', 'rewards', 'health', 'pantry'] });
      const switchedOff = await overview({ query: `?shopping_list=${list.id}` });
      assert.deepEqual(switchedOff.upcomingEvents, []);
      assert.equal(switchedOff.pantryExpiring.total, 0);
    } finally {
      await seed('PUT', '/preferences', { disabled_modules: disabledBefore });
    }
  });
}

// --- Aufgaben, Kalender ---

// Tage relativ zu heute, weil `/calendar/upcoming` nur nach vorn schaut. Der Abstand
// von mehreren Tagen haelt jede Zone und jede Uhrzeit aus.
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days) => toLocalDateKey(new Date(Date.now() + days * DAY_MS));
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const UTC_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

async function fixture(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: session, body: JSON.stringify(body) });
  assert.ok(res.status < 300, `${method} ${path}: ${res.status}`);
  return res.json();
}

/** Liest wie der Client: ein API-Token mit genau diesen Scopes. */
async function tokenHeaders(scopes) {
  const { token } = await fixture('POST', '/auth/api-tokens', { name: scopes.join(' '), scopes });
  return { ...json, Authorization: `Bearer ${token}` };
}

const member = await fixture('POST', '/auth/users', {
  username: 'aufgaben-kalender', display_name: 'Mia', password: 'memberpass123', family_role: 'parent', avatar_data: PIXEL_PNG,
});
const memberId = member.user.id;
const { user: me } = await (await fetch(`${API}/auth/me`, { headers: session })).json();

test('Aufgaben: jede Operation mit vollen Daten', async () => {
  const LIST = '/api/v1/tasks';
  const ONE = '/api/v1/tasks/{id}';
  const STATUS = '/api/v1/tasks/{id}/status';

  const { data: category } = await fixture('POST', '/tasks/categories', { name: 'Garten' });
  const { data: event } = await fixture('POST', '/calendar', {
    title: 'Beleg', start_datetime: inDays(30), attachment_name: 'beleg.png', attachment_data: PIXEL_PNG,
  });

  const { data: task } = await call('post', LIST, {
    body: {
      title: 'Hecke schneiden',
      description: '- [ ] Schere holen\n- [x] Leiter holen',
      category: category.key,
      tags: ['Garten', 'Haus, Hof'],
      priority: 'high',
      start_date: inDays(-1),
      due_date: inDays(10),
      due_time: '09:30',
      assigned_to: [memberId, me.id],
      is_recurring: true,
      recurrence_rule: 'FREQ=WEEKLY',
      recurrence_from_completion: true,
      points: 5,
      visibility: 'assignees',
      countdown: true,
      locked: true,
    },
  });
  assert.equal(task.assigned_to, memberId);
  assert.match(task.assigned_avatar, /^\/api\/v1\/people\/\d+\/avatar\?v=/);
  assert.match(task.created_at, UTC_STAMP);
  assert.match(task.due_date, DAY_KEY);

  const { data: subtask } = await call('post', LIST, { body: { title: 'Schere', parent_task_id: task.id, assigned_to: memberId } });
  await call('post', LIST, { body: { title: 'Kompost', parent_task_id: task.id, status: 'done' } });
  const { data: minimal } = await call('post', LIST, { body: { title: 'Ohne alles' } });
  assert.equal(minimal.due_date, null);
  const { data: inFuture } = await call('post', LIST, { body: { title: 'Spaeter', start_date: inDays(20), status: 'in_progress' } });
  await fixture('PUT', `/tasks/${task.id}/documents`, { document_ids: [event.attachment_document_id] });

  const { data: rows } = await call('get', LIST);
  const row = rows.find((candidate) => candidate.id === task.id);
  assert.equal(row.subtask_total, 2);
  assert.equal(row.subtask_done, 1);
  assert.equal(row.document_count, 1);
  assert.ok(row.subtasks.some((entry) => entry.id === subtask.id));
  assert.ok(!rows.some((candidate) => candidate.id === inFuture.id));
  const { data: future } = await call('get', LIST, { query: '?include_future=1&tag=Garten&status=open&status=in_progress&priority=high' });
  assert.deepEqual(future.map((candidate) => candidate.id), [task.id]);
  await call('get', LIST, { query: `?assigned_to=${memberId}&category=${category.key}&archived=1` });

  const options = await call('get', '/api/v1/tasks/meta/options');
  assert.ok(options.categories.some((entry) => entry.key === category.key && entry.name === 'Garten' && entry.label_key === null));
  assert.ok(options.categories.some((entry) => entry.key === 'misc' && entry.name === null && entry.label_key));
  assert.ok(options.tags.some((entry) => entry.tag === 'Garten' && entry.count === 1));
  assert.ok(options.statuses.includes('archived'));

  const { data: detail } = await call('get', ONE, { params: { id: task.id } });
  assert.equal(detail.document_count, 1);
  assert.equal(detail.documents[0].id, event.attachment_document_id);
  assert.match(detail.documents[0].linked_at, UTC_STAMP);
  assert.equal(detail.subtasks[0].id, subtask.id);
  assert.deepEqual(detail.subtasks[0].assigned_users.map((person) => person.id), [memberId]);

  // Ohne Leserecht auf Dokumente: nicht gesagt statt 0, und das Bild als Data-URL.
  const tasksOnly = await tokenHeaders(['tasks:read']);
  const { data: asToken } = await call('get', ONE, { params: { id: task.id }, headers: tasksOnly });
  assert.equal(asToken.document_count, null);
  assert.equal(asToken.documents, null);
  assert.match(asToken.assigned_avatar, /^data:image\/png;base64,/);
  const { data: tokenRows } = await call('get', LIST, { headers: tasksOnly });
  assert.ok(tokenRows.every((candidate) => candidate.document_count === null));

  const { data: updated } = await call('put', ONE, {
    params: { id: task.id },
    body: { title: 'Hecke schneiden lassen', tags: 'Garten, Hof', due_time: null, assigned_to: me.id, points: 7.9, locked: false },
  });
  assert.equal(updated.next_due_date, null);
  assert.equal(updated.points, 7);
  assert.equal(updated.subtasks.length, 2);
  assert.ok(!('documents' in updated));
  const { data: updatedSubtask } = await call('put', ONE, { params: { id: subtask.id }, body: { status: 'in_progress' } });
  assert.equal(updatedSubtask.parent_task_id, task.id);
  assert.equal((await fetch(`${API}/tasks/${subtask.id}`, { headers: session })).status, 404, 'GET liest nur Hauptaufgaben');

  const { data: series } = await call('post', LIST, { body: { title: 'Muell', due_date: inDays(2), is_recurring: true, recurrence_rule: 'FREQ=WEEKLY' } });
  const { data: finished } = await call('put', ONE, { params: { id: series.id }, body: { status: 'done' } });
  assert.match(finished.next_due_date, DAY_KEY);

  const { data: ticked } = await call('patch', '/api/v1/tasks/{id}/check', {
    params: { id: task.id }, body: { line: 0, checked: true, expect: '- [ ] Schere holen' },
  });
  assert.equal(ticked.description, '- [x] Schere holen\n- [x] Leiter holen');

  const { data: done } = await call('patch', STATUS, { params: { id: task.id }, body: { status: 'done', done_by_user_id: memberId } });
  assert.match(done.next_due_date, DAY_KEY);
  assert.equal(done.archived_at, null);
  const { data: reopened } = await call('patch', STATUS, { params: { id: task.id }, body: { status: 'open' } });
  assert.equal(reopened.next_due_date, null);
  const { data: filed } = await call('patch', STATUS, { params: { id: task.id }, body: { status: 'archived' } });
  assert.equal(filed.status, 'open');
  assert.match(filed.archived_at, UTC_STAMP);
  assert.ok(!('next_due_date' in filed), 'die Ablage nennt keine naechste Faelligkeit');
  const { data: archive } = await call('get', LIST, { query: '?archived=only' });
  assert.equal(archive.find((candidate) => candidate.id === task.id).archived_at, filed.archived_at);

  assert.deepEqual(await call('delete', ONE, { params: { id: minimal.id } }), { ok: true });
});

test('Kalender: jede Operation mit vollen Daten', async () => {
  const LIST = '/api/v1/calendar';
  const ONE = '/api/v1/calendar/{id}';

  const { data: own } = await fixture('POST', '/calendar/calendars', { name: 'Eigener', color: '#445566' });
  await fixture('POST', `/calendar/calendars/${own.id}/feed/regenerate`, {});

  const { data: timed } = await call('post', LIST, {
    body: {
      title: 'Zahnarzt',
      description: 'Kontrolle',
      start_datetime: `${inDays(3)}T10:00`,
      end_datetime: `${inDays(3)}T11:00:30`,
      location: 'Praxis\nHauptstrasse 1',
      color: '#112233',
      icon: 'car',
      assigned_to: [memberId, me.id],
      visibility: 'assignees',
      countdown: true,
      attachment_name: 'brief.png',
      attachment_data: PIXEL_PNG,
    },
  });
  assert.match(timed.start_datetime, WALL_CLOCK, 'zeitgebunden: Wanduhrzeit ohne Zone');
  assert.equal(timed.all_day, 0);
  assert.match(timed.attachment_preview_url, /^\/api\/v1\/documents\/\d+\/preview$/);
  assert.equal(timed.attachment_locked, false);
  assert.match(timed.created_at, UTC_STAMP);

  const { data: allDay } = await call('post', LIST, {
    body: { title: 'Urlaub', start_datetime: inDays(4), end_datetime: inDays(6), all_day: true, local_calendar_id: own.id },
  });
  assert.match(allDay.start_datetime, DAY_KEY, 'ganztaegig: nur das Datum');
  assert.equal(allDay.all_day, 1);
  assert.equal(allDay.local_calendar_id, own.id);
  assert.equal(allDay.local_calendar_color, '#445566');

  const { data: offset } = await call('post', LIST, { body: { title: 'Instant', start_datetime: `${inDays(7)}T16:00:00Z` } });
  assert.match(offset.start_datetime, WALL_CLOCK, 'ein Offset wird Wanduhrzeit');

  const { data: series } = await call('post', LIST, {
    body: { title: 'Lauftreff', start_datetime: `${inDays(5)}T18:00`, recurrence_rule: 'FREQ=DAILY;COUNT=3' },
  });
  assert.equal(series.series_id, series.id);
  assert.equal(series.is_local_recurring_series, true);

  const { data: allDaySeries } = await call('post', LIST, {
    body: { title: 'Fasten', start_datetime: inDays(5), all_day: true, recurrence_rule: 'FREQ=DAILY;COUNT=3' },
  });
  const { data: override } = await call('put', '/api/v1/calendar/{seriesId}/occurrences/{recurrenceId}', {
    params: { seriesId: allDaySeries.id, recurrenceId: inDays(6) }, body: { title: 'Fasten, einmal anders' },
  });
  assert.equal(override.is_occurrence_override, true);

  // Geburtstag und Namenstag erzeugen ihre Termine selbst.
  const birthday = inDays(8);
  await fixture('POST', '/birthdays', { name: 'Oma', birth_date: `1950${birthday.slice(4)}`, name_day: inDays(9).slice(5) });
  await fixture('POST', '/birthdays', { name: 'Opa', birth_date: `2000${birthday.slice(4)}`, year_unknown: true });

  // Ein Import mit eigener Zone landet als Instant in der Zeile, nicht als Wanduhrzeit.
  const compact = inDays(10).replaceAll('-', '');
  await fixture('POST', '/calendar/import', {
    ics: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:s5-zone@test', `DTSTAMP:${compact}T000000Z`,
      `DTSTART;TZID=America/New_York:${compact}T090000`, `DTEND;TZID=America/New_York:${compact}T100000`,
      'SUMMARY:Import', 'RRULE:FREQ=DAILY;COUNT=2', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
  });

  // Fremdquellen kommen nur ueber einen Sync-Lauf herein, und der braucht ein Netz.
  // Deshalb die Zeilen, die er schreibt, direkt.
  const { get: database } = await import('../server/db.js');
  const synced = database().prepare('INSERT INTO external_calendars (source, external_id, name, color) VALUES (?, ?, ?, ?)')
    .run('caldav', 'https://dav.test/cal/', 'Dienst', '#ABCDEF').lastInsertRowid;
  const subscription = database().prepare('INSERT INTO ics_subscriptions (name, url, color, shared, created_by) VALUES (?, ?, ?, 1, ?)')
    .run('Schule', 'https://ics.test/schule.ics', '#FEDCBA', me.id).lastInsertRowid;
  const syncedRow = database().prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, external_source, external_calendar_id, calendar_ref_id, tzid)
    VALUES ('Dienstplan', ?, ?, ?, 'caldav', 'uid-1', ?, 'Europe/Berlin')
  `).run(`${inDays(11)}T08:00:00+01:00`, `${inDays(11)}T09:00:00+01:00`, me.id, synced).lastInsertRowid;
  const icsRow = database().prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, created_by, external_source, external_calendar_id, subscription_id)
    VALUES ('Ferien', ?, 1, ?, 'ics', 'uid-2', ?)
  `).run(inDays(12), me.id, subscription).lastInsertRowid;

  const from = inDays(1);
  const to = inDays(14);
  const list = await call('get', LIST, { query: `?from=${from}&to=${to}` });
  assert.equal(list.from, from);
  assert.equal(list.to, to);
  const named = (title) => list.data.filter((row) => row.title === title);
  assert.equal(named('Lauftreff').length, 3);
  assert.equal(named('Lauftreff')[1].is_recurring_instance, 1);
  assert.equal(named('Lauftreff')[0].is_series_start, 1);
  assert.ok(list.data.some((row) => row.is_occurrence_override === true));
  const oma = list.data.find((row) => row.birthday_name === 'Oma' && row.birthday_event_kind === 'birthday');
  assert.match(oma.birthday_date, DAY_KEY);
  const nameDay = list.data.find((row) => row.birthday_event_kind === 'name_day');
  assert.match(nameDay.name_day, /^\d{2}-\d{2}$/);
  assert.equal(list.data.find((row) => row.birthday_name === 'Opa').birthday_date, null);
  const imported = named('Import')[0];
  assert.equal(imported.tzid, 'America/New_York');
  assert.match(imported.start_datetime, /Z$/, 'mit eigener Zone: Instant');
  assert.match(imported.recurrence_id, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const shift = named('Dienstplan')[0];
  assert.equal(shift.external_source, 'caldav');
  assert.equal(shift.cal_name, 'Dienst');
  assert.equal(shift.source_calendar_name, 'Dienst');
  assert.match(shift.start_datetime, /\+01:00$/, 'synchronisiert: Instant mit Offset');
  assert.equal(named('Ferien')[0].cal_name, 'Schule');
  await call('get', LIST, { query: `?from=${from}&to=${to}&assigned_to=${memberId}&source=local` });
  await call('get', LIST);

  const upcoming = await call('get', '/api/v1/calendar/upcoming', { query: '?limit=20' });
  assert.ok(upcoming.data.length > 5 && upcoming.data.length <= 20);
  assert.ok(!('creator_name' in upcoming.data[0]));
  await call('get', '/api/v1/calendar/upcoming');

  const calendars = await call('get', '/api/v1/calendar/calendars');
  const mine = calendars.data.find((entry) => entry.id === own.id);
  assert.match(mine.feed_url, /\/feed\/calendar\/.+\.ics$/);
  assert.ok(mine.event_count >= 1);
  assert.equal(calendars.data.find((entry) => entry.is_default).feed_token, null);
  const sourceKeys = calendars.sources.map((source) => source.key);
  for (const key of [`local:${own.id}`, `cal:${synced}`, `sub:${subscription}`]) assert.ok(sourceKeys.includes(key), key);

  const { data: detail } = await call('get', ONE, { params: { id: timed.id } });
  assert.equal(detail.assigned_users.length, 2);
  assert.match(detail.assigned_users[0].avatar_data ?? detail.assigned_users[1].avatar_data, /^\/api\/v1\/people\//);
  assert.equal(detail.creator_name, 'Admin');
  await call('get', ONE, { params: { id: oma.id } });
  await call('get', ONE, { params: { id: Number(syncedRow) } });
  await call('get', ONE, { params: { id: Number(icsRow) } });
  await call('get', ONE, { params: { id: series.id } });

  const calendarOnly = await tokenHeaders(['calendar:read']);
  const { data: asToken } = await call('get', ONE, { params: { id: timed.id }, headers: calendarOnly });
  assert.equal(asToken.attachment_locked, null);
  assert.equal(asToken.attachment_document_id, null);
  assert.equal(asToken.attachment_name, null);
  await call('get', LIST, { query: `?from=${from}&to=${to}`, headers: calendarOnly });

  const { data: edited } = await call('put', ONE, {
    params: { id: timed.id },
    body: { title: 'Zahnarzt, neu', end_datetime: null, color: null, description: null, remove_attachment: true, local_calendar_id: own.id },
  });
  assert.equal(edited.end_datetime, null);
  assert.equal(edited.color, null);
  assert.equal(edited.attachment_document_id, null);
  const { data: reseries } = await call('put', ONE, { params: { id: series.id }, body: { recurrence_rule: 'FREQ=DAILY;COUNT=2' } });
  assert.equal(reseries.recurrence_rule, 'FREQ=DAILY;COUNT=2');
  await call('put', ONE, { params: { id: Number(syncedRow) }, body: { title: 'Dienstplan, bearbeitet' } });

  assert.equal(await call('delete', ONE, { params: { id: offset.id } }), null);
});

// --- Einkauf ---

const SHOPPING = '/api/v1/shopping';
const SHOPPING_ITEMS = `${SHOPPING}/{listId}/items`;
const SHOPPING_ITEM = `${SHOPPING}/items/{itemId}`;
const SHOPPING_CHECKED = `${SHOPPING}/{listId}/items/checked`;

const shoppingList = async (name) => (await call('post', SHOPPING, { body: { name } })).data;
const shoppingItem = async (listId, body) => (await call('post', SHOPPING_ITEMS, { params: { listId }, body })).data;
const tickShoppingItem = (itemId) => call('patch', SHOPPING_ITEM, { params: { itemId }, body: { is_checked: true } });

/** Fuer Fixtures aus Operationen, die nicht zum Vertrag gehoeren und kein Schema haben. */
async function shoppingFixture(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: session, body: JSON.stringify(body) });
  assert.ok(res.ok, `${path}: ${res.status}`);
  return (await res.json()).data;
}

test('Einkauf: Listen mit und ohne Artikel, Laufnummern, Kategorien', async () => {
  const empty = await shoppingList('Leer');
  const filled = await shoppingList('Wocheneinkauf');
  const ticked = await shoppingItem(filled.id, { name: 'Salz' });
  await shoppingItem(filled.id, { name: 'Pfeffer' });
  await tickShoppingItem(ticked.id);

  const lists = (await call('get', SHOPPING)).data;
  const of = (list) => lists.find((row) => row.id === list.id);
  assert.deepEqual(
    [of(empty).item_total, of(empty).item_checked, of(empty).accepts_new_items],
    [0, 0, 1],
  );
  assert.deepEqual([of(filled).item_total, of(filled).item_checked], [2, 1]);

  const versions = (await call('get', `${SHOPPING}/versions`)).data;
  assert.ok(versions.some((row) => row.list_id === empty.id && row.version === 0));
  assert.ok(versions.some((row) => row.list_id === filled.id && row.version > 0));

  const categories = (await call('get', `${SHOPPING}/categories`)).data;
  assert.ok(categories.some((category) => category.name === 'Sonstiges'));

  const emptyItems = await call('get', SHOPPING_ITEMS, { params: { listId: empty.id } });
  assert.deepEqual(emptyItems.data, []);
  assert.equal(emptyItems.list.id, empty.id);
  assert.equal(emptyItems.version, 0);
});

test('Einkauf: Artikel mit allen Feldern, Preis, Laden, Mahlzeit und Umzug', async () => {
  const list = await shoppingList('Markt');
  const other = await shoppingList('Baumarkt');
  const store = await shoppingFixture('/shopping/stores', { name: 'Hofladen' });
  const meal = await shoppingFixture('/meals', {
    date: '2031-01-15', meal_type: 'dinner', title: 'Suppe', ingredients: [{ name: 'Lauch', quantity: '2' }],
  });
  assert.ok(meal.id);
  await shoppingFixture(`/shopping/${list.id}/import-meal-plan`, { from: '2031-01-15', to: '2031-01-15' });

  const created = await call('post', SHOPPING_ITEMS, {
    params: { listId: list.id },
    body: { name: 'Hafermilch', quantity: '2 l', category: 'Getränke', notes: 'ungesüßt', url: 'https://example.org/hafer' },
  });
  assert.equal(created.data.notes, 'ungesüßt');
  assert.equal(created.list_change.list_id, list.id);
  assert.ok(created.list_change.after > created.list_change.before);

  const minimal = await shoppingItem(list.id, { name: 'Kerzen' });
  assert.deepEqual([minimal.quantity, minimal.category, minimal.notes, minimal.url], [null, 'Sonstiges', null, null]);

  const itemId = created.data.id;
  const bought = await call('patch', SHOPPING_ITEM, {
    params: { itemId }, body: { is_checked: true, price_cents: 199, store_id: store.id },
  });
  assert.deepEqual([bought.data.is_checked, bought.data.price_cents, bought.data.store_id], [1, 199, store.id]);

  const items = await call('get', SHOPPING_ITEMS, { params: { listId: list.id } });
  const byName = (name) => items.data.find((item) => item.name === name);
  assert.equal(byName('Lauch').added_from_meal, meal.id);
  assert.deepEqual(byName('Hafermilch').tags, []);
  assert.equal(items.version, bought.list_change.after);

  // Nur POST und PATCH lassen `tags` weg, und `null` raeumt Preis, Laden und Menge ab.
  assert.equal('tags' in bought.data, false);
  const cleared = await call('patch', SHOPPING_ITEM, {
    params: { itemId }, body: { price_cents: null, store_id: null, quantity: null, notes: null, url: null },
  });
  assert.deepEqual(
    [cleared.data.price_cents, cleared.data.store_id, cleared.data.quantity, cleared.data.notes, cleared.data.url],
    [null, null, null, null, null],
  );

  const moved = await call('patch', SHOPPING_ITEM, { params: { itemId: minimal.id }, body: { list_id: other.id } });
  assert.equal(moved.data.list_id, other.id);
  assert.equal(moved.list_change.list_id, list.id);

  const gone = await call('delete', SHOPPING_ITEM, { params: { itemId } });
  assert.equal(gone.ok, true);
  assert.equal(gone.list_change.list_id, list.id);
});

test('Einkauf: Vorschlaege nach vorherigem Einkauf', async () => {
  const list = await shoppingList('Vorrat');
  await shoppingItem(list.id, { name: 'Kokosmilch', quantity: '1 Dose', category: 'Haushalt' });
  await shoppingItem(list.id, { name: 'Kokosmilch', quantity: '2 Dosen', category: 'Getränke' });
  await shoppingItem(list.id, { name: 'Kokosflocken' });

  const { data } = await call('get', `${SHOPPING}/suggestions`, { query: '?q=koko' });
  assert.deepEqual(data, [
    { name: 'Kokosflocken', category: 'Sonstiges', quantity: null },
    { name: 'Kokosmilch', category: 'Getränke', quantity: '2 Dosen' },
  ]);
  assert.deepEqual((await call('get', `${SHOPPING}/suggestions`)).data, []);
});

test('Einkauf: abgehakte Artikel loeschen, mit und ohne `ids`', async () => {
  const list = await shoppingList('Abgehakt');
  const [named, rest, later, open] = await Promise.all(
    ['Eins', 'Zwei', 'Drei', 'Offen'].map((name) => shoppingItem(list.id, { name })),
  );
  for (const item of [named, rest, later]) await tickShoppingItem(item.id);
  const params = { listId: list.id };

  const some = await call('delete', SHOPPING_CHECKED, { params, body: { ids: [named.id, open.id] } });
  assert.equal(some.deleted, 1);
  assert.equal(some.list_change.list_id, list.id);
  assert.equal(typeof some.list_change.before, 'number');

  const all = await call('delete', SHOPPING_CHECKED, { params });
  assert.equal(all.deleted, 2);

  const left = (await call('get', SHOPPING_ITEMS, { params })).data;
  assert.deepEqual(left.map((item) => item.id), [open.id]);

  // Die Route schlaegt die Liste nicht nach, daher `null` in `before` und `after`.
  const missing = await call('delete', SHOPPING_CHECKED, { params: { listId: 999999 } });
  assert.deepEqual(missing, { deleted: 0, list_change: { list_id: 999999, before: null, after: null } });
});

test('Einkauf: gespiegelte, nur lesbare Liste mit Etiketten und Sync-Feldern', async () => {
  // Tags und Sync-Spalten schreibt nur der CalDAV-Lauf, und der braucht einen
  // fremden Server. Die Zeilen entstehen deshalb direkt in der Datenbank, mit
  // `outbound_dirty = 0`: es liegt nichts an, das ein Lauf hinausschicken wollte.
  const db = (await import('../server/db.js')).get();
  const { setItemTags } = await import('../server/utils/task-tags.js');

  const list = await shoppingList('Gespiegelt');
  const item = await shoppingItem(list.id, { name: 'Vom Server' });
  const account = db.prepare(
    'INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES (?, ?, ?, ?)',
  ).run('Nur lesbar', 'http://127.0.0.1:9/', 'fixture', 'fixture').lastInsertRowid;
  db.prepare(`
    INSERT INTO caldav_reminder_selection
      (account_id, list_url, list_name, target_module, target_list_id, enabled, writable)
    VALUES (?, ?, ?, 'shopping', ?, 1, 0)
  `).run(account, 'http://127.0.0.1:9/list/', 'Nur lesbar', list.id);
  db.prepare(`
    UPDATE shopping_items
       SET external_uid = 'uid-1', external_source = 'caldav', external_account_id = ?,
           external_object_url = 'http://127.0.0.1:9/list/uid-1.ics', seen_on_server = 1,
           outbound_move_since = datetime('now'), outbound_move_by = 1
     WHERE id = ?
  `).run(account, item.id);
  setItemTags(db, item.id, ['Bio', 'Vorrat']);

  const row = (await call('get', SHOPPING)).data.find((entry) => entry.id === list.id);
  assert.equal(row.accepts_new_items, 0);

  const [mirrored] = (await call('get', SHOPPING_ITEMS, { params: { listId: list.id } })).data;
  assert.deepEqual([...mirrored.tags].sort(), ['Bio', 'Vorrat']);
  assert.deepEqual(
    [mirrored.external_source, mirrored.external_uid, mirrored.external_account_id],
    ['caldav', 'uid-1', Number(account)],
  );
});

test('die Spec ist geladen', () => assert.ok(spec.paths['/api/v1/tasks']));
