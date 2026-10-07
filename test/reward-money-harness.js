/**
 * Modul: Der Testhaushalt der Taschengeld-Suiten (#1734)
 * Zweck: Der ECHTE Server (test/server-ready.js) mit einem Admin, drei Kindern
 *        (Emma und Leo mit Konto, Mia ohne), einem gekoppelten Wandtablett und
 *        den Helfern, die beide Suiten teilen.
 *
 * WARUM ZWEI SUITEN EINEN HAUSHALT TEILEN: der Server begrenzt die API auf 300
 * Aufrufe je Minute und Adresse (server/index.js), und eine Suite, die alles
 * misst, lief in die 429. Jede Suite ist ein eigener Prozess mit eigenem
 * Server und eigener Datenbank - geteilt wird nur dieser Aufbau.
 */
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

export async function rewardMoneyHousehold(name) {

  const { baseUrl: BASE } = await startTestServer({
    name,
    env: {
      SESSION_SECRET: 'test-reward-money-secret-min32chars!',
      RATE_LIMIT_MAX_ATTEMPTS: '60',
      RATE_LIMIT_WINDOW_MS: '60000',
    },
  });
  const dbmod = await import('../server/db.js');
  const db = dbmod.get();
  const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
  const rewards = await import('../server/services/rewards.js');
  const money = await import('../server/services/reward-money.js');
  const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');
  const { parseDateKey } = await import('../server/utils/interval-date.js');

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

  function withToken(token) {
    return async (method, path, body) => {
      const res = await fetch(`${BASE}/api/v1${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  }

  /** Ein Request wie vom Tablett: Geraete-Cookie plus die leere Sitzung fuer den CSRF-Token (test-display-actions.js). */
  function asDisplay(token) {
    const jar = new Map([[DISPLAY_COOKIE, token]]);
    let csrf = null;
    const send = async (method, path, body) => {
      const headers = { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const fresh = res.headers.get('x-csrf-token');
      if (fresh) csrf = fresh;
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return async (method, path, body) => {
      if (!csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) await send('GET', '/preferences');
      return send(method, path, body);
    };
  }

  const admin = as(await login('admin', 'adminpass123'));
  const ADMIN_ID = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

  async function member(username) {
    const created = await admin('POST', '/auth/users', { username, display_name: username, password: `${username}-pass-123` });
    assert.equal(created.status, 201, `Konto ${username}`);
    return { id: created.body.user.id, call: as(await login(username, `${username}-pass-123`)) };
  }

  // EMMA hat Taschengeld und sammelt Punkte. LEO ist das Geschwisterkind, mit
  // eigenem Konto - er darf seines sehen und ihres nicht. MIA hat kein Konto.
  const emma = await member('emma');
  const leo = await member('leo');
  const mia = await member('mia');
  for (const m of [emma, leo]) {
    assert.equal((await admin('PUT', `/rewards/participants/${m.id}`, { enabled: true })).status, 200);
  }

  // Das Wandtablett.
  const createdDisplay = await admin('POST', '/displays', { display_name: 'Kueche' });
  const DISPLAY_ID = createdDisplay.body.data.id;
  const issued = await admin('POST', `/displays/${DISPLAY_ID}/pairing-code`, {});
  const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: issued.body.data.code }),
  });
  const display = asDisplay(decodeURIComponent(
    String(paired.headers.get('set-cookie') || '').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1],
  ));

  // Unverwechselbare Betraege: was in einer Antwort an Leo oder das Tablett
  // auftaucht, laesst sich am Text finden.
  const EMMA_START = 7_731;   // 77,31
  const LEO_START = 1_203;    // 12,03

  const credit = (m, minor, reason = null) => admin('POST', '/rewards/money/entries', {
    user_id: m.id, amount: (minor / 100).toFixed(2), direction: 'credit', ...(reason ? { reason } : {}),
  });
  assert.equal((await credit(emma, EMMA_START, 'Startguthaben-Emma')).status, 201);
  assert.equal((await credit(leo, LEO_START, 'Startguthaben-Leo')).status, 201);

  const moneyOf = (id) => rewards.ledgerBalance(db, id, 'money');
  const pointsOf = (id) => rewards.ledgerBalance(db, id, 'points');
  const moneyRows = (id) => db.prepare("SELECT * FROM reward_ledger WHERE user_id = ? AND unit = 'money' ORDER BY id").all(id);

  /** Ein frisches Mitglied ohne Vorgeschichte - fuer Faelle, die einen sauberen Saldo brauchen. */
  let seq = 0;
  function freshKid({ enrolled = false } = {}) {
    seq += 1;
    const id = Number(db.prepare(`
      INSERT INTO users(username, display_name, password_hash, role, family_role)
      VALUES (?, ?, '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'member', 'child') RETURNING id
    `).get(`fresh-${seq}`, `Fresh ${seq}`).id);
    if (enrolled) db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(id);
    return id;
  }
  // Eine Geldzeile von Hand - samt der Kontozeile, ohne die es kein Konto gibt.
  const sqlMoney = (id, delta, type = 'bonus', currency = 'EUR') => {
    db.prepare('INSERT OR IGNORE INTO reward_money_accounts (user_id, currency) VALUES (?, ?)').run(id, currency);
    return db.prepare(
      "INSERT INTO reward_ledger (user_id, delta, type, unit, currency) VALUES (?, ?, ?, 'money', ?)",
    ).run(id, delta, type, currency);
  };

  return {
    BASE, dbmod, db, rewards, money, todayKey, shiftDateKey, parseDateKey, withToken, admin, ADMIN_ID, member, emma, leo, mia, display, DISPLAY_ID, EMMA_START, LEO_START, credit, moneyOf, pointsOf, moneyRows, freshKid, sqlMoney,
  };
}
