/**
 * Test: Rewards-Routen-Schicht (Härtung)
 * Zweck: End-to-End über den echten Router (server/routes/rewards.js) - zuvor nur
 *        ~61% Zeilen / 20 von 24 fn abgedeckt (test:rewards prüft die Service-Schicht
 *        services/rewards.js, nicht die HTTP-Handler). Diese Suite mountet den Router
 *        in einer echten express-App und ruft ihn per fetch mit injiziertem actor auf.
 *        Fokus auf die sicherheitsrelevanten Pfade:
 *          - requireAdmin-Gates (participants, catalog CUD, bonus) - kein Bypass
 *          - Redemption-Autorisierung: Nicht-Admin nur für sich, Admin stellvertretend
 *          - Eltern-Freigabe (requiresApproval): pending vs. sofortiges autoFulfill
 *          - Idempotenz: bereits entschiedene Anfrage -> 409, kein Doppel-Ledger
 *          - Punkte-Integrität: Reservierung bei Einlösung, Rückbuchung bei
 *            reject/cancel, KEINE Rückbuchung bei fulfill
 *          - Validierung/404/400 über Katalog, Bonus, Ledger-Filter
 *
 *        Salden werden über die importierten Service-Helfer getBalance/isEnrolled als
 *        Orakel geprüft; Balance-kritische Fälle nutzen je einen frischen Nutzer, um
 *        Akkumulation in der geteilten :memory:-DB auszuschließen. Keine Systemuhr-
 *        Kopplung (rewards filtert nichts nach "heute").
 * Ausführen: node --experimental-sqlite --test test/test-rewards-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { getBalance, isEnrolled, postLedger } = await import('../server/services/rewards.js');
const db = dbmod.get();

// ── Nutzer (IDs deterministisch ab 1: eigener Prozess je Testdatei) ──────────────
const ADMIN = { id: 1, role: 'admin' };
const KID_A = { id: 2, role: 'member' };
const KID_B = { id: 3, role: 'member' };
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin','Admin','x','admin','parent')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('kida','Kid A','x','member','child')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('kidb','Kid B','x','member','child')").run();
const WORKER = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('willy','Willy','x','member')").run().lastInsertRowid;
db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(WORKER);

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', rewardsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, { actor: a = ADMIN, body } = {}) {
  actor = a;
  const headers = {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* leer */ } }
  return { status: res.status, body: json };
}

// Frischer, teilnehmender Nutzer mit definiertem Startsaldo - isoliert gegen die
// geteilte :memory:-DB. postLedger als Service-Orakel für die Startbuchung.
let kidSeq = 0;
function freshKid(startPoints = 0) {
  const name = `Kid-${++kidSeq}`;
  const id = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', 'member', 'child')")
    .run(name.toLowerCase(), name).lastInsertRowid;
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(id);
  if (startPoints) postLedger(db, { userId: id, delta: startPoints, type: 'bonus', reason: 'seed', createdBy: ADMIN.id });
  return { id, role: 'member', name };
}

// ════════════════════════════════════════════════════════════════════════════════
// GET /overview (leerer Ausgangszustand)
// ════════════════════════════════════════════════════════════════════════════════

test('GET /overview — leerer Ausgangszustand + Metadaten', async () => {
  const res = await call('GET', '/overview', { actor: KID_A });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.balances, [], 'noch keine Teilnehmer');
  assert.deepEqual(res.body.data.catalog, [], 'noch keine Prämien');
  assert.equal(res.body.data.pendingCount, 0);
  assert.equal(res.body.data.isAdmin, false, 'KID_A ist kein Admin');
  assert.equal(res.body.data.me, KID_A.id);
  assert.deepEqual(res.body.data.setup, { participantCount: 0, catalogCount: 0, pointedTaskCount: 0 });
});

// ════════════════════════════════════════════════════════════════════════════════
// requireAdmin-Gates
// ════════════════════════════════════════════════════════════════════════════════

test('Admin-Routen: Nicht-Admin erhält 403', async () => {
  const guarded = [
    ['GET', '/participants'], ['PUT', '/participants/2'], ['POST', '/catalog'],
    ['PATCH', '/catalog/1'], ['DELETE', '/catalog/1'], ['POST', '/bonus'],
  ];
  for (const [method, route] of guarded) {
    // Kein Body: requireAdmin greift vor dem Body-Parsing (fetch verbietet GET-Body).
    const res = await call(method, route, { actor: KID_A });
    assert.equal(res.status, 403, `${method} ${route} -> 403`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// participants
// ════════════════════════════════════════════════════════════════════════════════

test('PUT /participants/:userId — 404 unbekannt, dann enroll KID_A/KID_B', async () => {
  assert.equal((await call('PUT', '/participants/999999', { body: { enabled: true } })).status, 404);
  const a = await call('PUT', `/participants/${KID_A.id}`, { body: { enabled: true } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.data, { user_id: KID_A.id, enabled: true });
  await call('PUT', `/participants/${KID_B.id}`, { body: { enabled: true } });
  assert.ok(isEnrolled(db, KID_A.id) && isEnrolled(db, KID_B.id));
});

test('PUT /participants/:userId — Deaktivieren idempotent (ON CONFLICT)', async () => {
  await call('PUT', `/participants/${KID_B.id}`, { body: { enabled: false } });
  assert.equal(isEnrolled(db, KID_B.id), false);
  // wieder aktivieren für Folgetests
  await call('PUT', `/participants/${KID_B.id}`, { body: { enabled: true } });
  assert.equal(isEnrolled(db, KID_B.id), true);
});

test('GET /participants — Mitglieder mit Flag, Worker ausgeschlossen', async () => {
  const res = await call('GET', '/participants', { actor: ADMIN });
  assert.equal(res.status, 200);
  const names = res.body.data.map((r) => r.display_name);
  assert.ok(names.includes('Kid A') && names.includes('Admin'));
  assert.ok(!names.includes('Willy'), 'Housekeeping-Worker ausgeschlossen');
  const kidA = res.body.data.find((r) => r.id === KID_A.id);
  assert.equal(kidA.enabled, true);
});

// ════════════════════════════════════════════════════════════════════════════════
// catalog
// ════════════════════════════════════════════════════════════════════════════════

let EIS, KINO;
test('POST /catalog — Validierung + Anlegen', async () => {
  assert.equal((await call('POST', '/catalog', { body: { cost: 10 } })).status, 400, 'name Pflicht');
  assert.equal((await call('POST', '/catalog', { body: { name: 'X', cost: 0 } })).status, 400, 'cost >= 1');
  assert.equal((await call('POST', '/catalog', { body: { name: 'X', cost: 2_000_000 } })).status, 400, 'cost <= MAX');
  const eis = await call('POST', '/catalog', { body: { name: 'Eis', cost: 10, icon: '🍦', sort_order: 1 } });
  assert.equal(eis.status, 201);
  assert.equal(eis.body.data.name, 'Eis');
  assert.equal(eis.body.data.cost, 10);
  assert.equal(eis.body.data.is_active, 1, 'neue Prämie ist aktiv');
  EIS = eis.body.data.id;
  KINO = (await call('POST', '/catalog', { body: { name: 'Kino', cost: 50, sort_order: 2 } })).body.data.id;
});

test('PATCH /catalog/:id — 404/400/Teil-Update/Deaktivieren', async () => {
  assert.equal((await call('PATCH', '/catalog/999999', { body: { name: 'X' } })).status, 404);
  assert.equal((await call('PATCH', `/catalog/${EIS}`, { body: { name: '   ' } })).status, 400, 'leerer Name');
  assert.equal((await call('PATCH', `/catalog/${EIS}`, { body: { cost: -5 } })).status, 400, 'cost ungültig');
  const upd = await call('PATCH', `/catalog/${EIS}`, { body: { description: 'Lecker' } });
  assert.equal(upd.body.data.description, 'Lecker');
  assert.equal(upd.body.data.name, 'Eis', 'Name unverändert');
  assert.equal(upd.body.data.cost, 10, 'cost unverändert');
});

test('PATCH /catalog/:id — gesendetes null leert, fehlendes Feld erhält (#789)', async () => {
  // Die UI schickt beim Speichern IMMER alle Felder, leere als `null`. Wer eine
  // Prämie ohne Icon anlegt und danach nur den Preis ändert, schickt also
  // `icon: null` mit - und bekam den Text "null" als Icon zurück.
  const id = (await call('POST', '/catalog', { body: { name: 'Ohne Icon', cost: 7 } })).body.data.id;
  const kept = await call('PATCH', `/catalog/${id}`, { body: { name: 'Ohne Icon', cost: 8, icon: null, description: null } });
  assert.equal(kept.body.data.icon, null, 'icon bleibt NULL, nicht der Text "null"');
  assert.equal(kept.body.data.description, null, 'description bleibt NULL, nicht der Text "null"');
  const stored = db.prepare('SELECT icon, description FROM reward_catalog WHERE id=?').get(id);
  assert.equal(stored.icon, null, 'auch in der DB steht kein "null"');
  assert.equal(stored.description, null);

  // Die Gegenrichtung muss erhalten bleiben: gesendetes `null` LEERT weiterhin,
  // sonst wäre ein gesetztes Icon nicht mehr zu entfernen.
  await call('PATCH', `/catalog/${id}`, { body: { icon: '🎁', description: 'Da' } });
  const cleared = await call('PATCH', `/catalog/${id}`, { body: { icon: null, description: null } });
  assert.equal(cleared.body.data.icon, null, 'null leert ein gesetztes Icon');
  assert.equal(cleared.body.data.description, null, 'null leert eine gesetzte Beschreibung');

  // Und ein fehlendes Feld lässt den Wert unangetastet.
  await call('PATCH', `/catalog/${id}`, { body: { icon: '🍬', description: 'Bleibt' } });
  const untouched = await call('PATCH', `/catalog/${id}`, { body: { cost: 9 } });
  assert.equal(untouched.body.data.icon, '🍬', 'fehlendes icon-Feld ändert nichts');
  assert.equal(untouched.body.data.description, 'Bleibt', 'fehlendes description-Feld ändert nichts');
});

test('GET /catalog — Nicht-Admin nur aktive, Admin all=1 auch inaktive', async () => {
  const tmp = (await call('POST', '/catalog', { body: { name: 'Verborgen', cost: 5 } })).body.data.id;
  await call('PATCH', `/catalog/${tmp}`, { body: { is_active: false } });
  const member = await call('GET', '/catalog', { actor: KID_A });
  assert.ok(!member.body.data.some((r) => r.id === tmp), 'inaktive für Mitglied unsichtbar');
  const adminAll = await call('GET', '/catalog?all=1', { actor: ADMIN });
  assert.ok(adminAll.body.data.some((r) => r.id === tmp), 'Admin sieht mit all=1 auch inaktive');
});

test('DELETE /catalog/:id — 404 + Löschen', async () => {
  const tmp = (await call('POST', '/catalog', { body: { name: 'Wegwerf', cost: 3 } })).body.data.id;
  assert.equal((await call('DELETE', '/catalog/999999')).status, 404);
  const ok = await call('DELETE', `/catalog/${tmp}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_catalog WHERE id=?').get(tmp).n, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// bonus
// ════════════════════════════════════════════════════════════════════════════════

test('POST /bonus — Validierungs-400s', async () => {
  assert.equal((await call('POST', '/bonus', { body: { delta: 10 } })).status, 400, 'user_id Pflicht');
  assert.equal((await call('POST', '/bonus', { body: { user_id: KID_A.id, delta: 0 } })).status, 400, 'delta != 0');
  assert.equal((await call('POST', '/bonus', { body: { user_id: KID_A.id, delta: 2_000_000 } })).status, 400, 'out of range');
  assert.equal((await call('POST', '/bonus', { body: { user_id: WORKER, delta: 10 } })).status, 400, 'nicht teilnehmend');
});

test('POST /bonus — positiv (bonus) und negativ (adjust) verbuchen', async () => {
  const kid = freshKid(0);
  const plus = await call('POST', '/bonus', { body: { user_id: kid.id, delta: 100, reason: 'Aufräumen' } });
  assert.equal(plus.status, 201);
  assert.equal(plus.body.data.balance, 100);
  const minus = await call('POST', '/bonus', { body: { user_id: kid.id, delta: -30, reason: 'Korrektur' } });
  assert.equal(minus.body.data.balance, 70);
  assert.equal(getBalance(db, kid.id), 70, 'Service-Orakel bestätigt Saldo');
  const types = db.prepare('SELECT type FROM reward_ledger WHERE user_id=? ORDER BY id').all(kid.id).map((r) => r.type);
  assert.deepEqual(types, ['bonus', 'adjust'], 'delta>0 -> bonus, delta<0 -> adjust');
});

// ════════════════════════════════════════════════════════════════════════════════
// ledger
// ════════════════════════════════════════════════════════════════════════════════

test('GET /ledger — user_id-Filter, Namens-Joins, limit-Clamp', async () => {
  const kid = freshKid(0);
  await call('POST', '/bonus', { body: { user_id: kid.id, delta: 5, reason: 'Test' } });
  const filtered = await call('GET', `/ledger?user_id=${kid.id}`, { actor: ADMIN });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.data.length >= 1);
  assert.ok(filtered.body.data.every((r) => r.user_id === kid.id), 'nur der gefilterte Nutzer');
  const entry = filtered.body.data[0];
  assert.equal(entry.user_name, kid.name, 'user-Join liefert den Anzeigenamen');
  assert.equal(entry.actor_name, 'Admin', 'created_by-Join');
  // limit-Clamp: >500 wird auf 500 begrenzt (kein Fehler, nur geklemmt).
  assert.equal((await call('GET', '/ledger?limit=99999', { actor: ADMIN })).status, 200);
});

// ════════════════════════════════════════════════════════════════════════════════
// redemptions POST (Einlösung + Reservierung)
// ════════════════════════════════════════════════════════════════════════════════

test('POST /redemptions — 404/400-Pfade', async () => {
  const kid = freshKid(100);
  assert.equal((await call('POST', '/redemptions', { actor: kid, body: { catalog_id: 999999 } })).status, 404, 'unbekannte Prämie');
  // Nicht teilnehmender Nutzer (roh angelegt, kein reward_participants-Eintrag).
  const outsiderId = db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('outsider','Outsider','x','member','child')").run().lastInsertRowid;
  assert.equal((await call('POST', '/redemptions', { actor: { id: outsiderId, role: 'member' }, body: { catalog_id: EIS } })).status, 400, 'nimmt nicht teil');
  const poor = freshKid(5);
  assert.equal((await call('POST', '/redemptions', { actor: poor, body: { catalog_id: KINO } })).status, 400, 'zu wenig Punkte');
  // Admin mit user_id=0 -> 400 user_id required
  assert.equal((await call('POST', '/redemptions', { actor: ADMIN, body: { catalog_id: EIS, user_id: 0 } })).status, 400);
});

test('POST /redemptions — mit Freigabe: pending + Punkte reserviert', async () => {
  const kid = freshKid(100);
  const res = await call('POST', '/redemptions', { actor: kid, body: { catalog_id: EIS } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending', 'Freigabe standardmäßig erforderlich');
  assert.equal(res.body.data.user_id, kid.id);
  assert.equal(res.body.data.cost, 10);
  assert.equal(getBalance(db, kid.id), 90, 'Punkte sofort reserviert (-10)');
});

test('POST /redemptions — Nicht-Admin kann nur für sich selbst einlösen', async () => {
  const self  = freshKid(0);    // teilnehmend, aber ohne Punkte
  const other = freshKid(100);  // teilnehmend, genug Punkte
  // self (nicht Admin) gibt user_id: other an. Würde das beachtet, ginge die Einlösung
  // gegen others Saldo durch (201). Da der Server user_id eines Nicht-Admins ignoriert,
  // fällt targetId auf self -> Saldo 0 < 10 -> 400. Der 400 UND others unberührter Saldo
  // beweisen zusammen, dass fremdes Einlösen nicht möglich ist.
  const res = await call('POST', '/redemptions', { actor: self, body: { catalog_id: EIS, user_id: other.id } });
  assert.equal(res.status, 400, 'user_id eines Nicht-Admins wird ignoriert -> self ohne Punkte');
  assert.equal(getBalance(db, other.id), 100, 'fremdes Konto unangetastet');
});

test('POST /redemptions — Admin kann stellvertretend einlösen', async () => {
  const kid = freshKid(100);
  const res = await call('POST', '/redemptions', { actor: ADMIN, body: { catalog_id: EIS, user_id: kid.id } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user_id, kid.id, 'Admin löst für kid ein');
  assert.equal(getBalance(db, kid.id), 90);
});

test('POST /redemptions — ohne Freigabe: sofortiges autoFulfill', async () => {
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('rewards_require_approval','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  try {
    const kid = freshKid(100);
    const res = await call('POST', '/redemptions', { actor: kid, body: { catalog_id: EIS } });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'fulfilled', 'ohne Freigabe direkt erfüllt');
    assert.equal(res.body.data.decided_by, kid.id);
    assert.equal(getBalance(db, kid.id), 90, 'Punkte bleiben abgezogen');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key='rewards_require_approval'").run();
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// redemptions PATCH (entscheiden) — Idempotenz + Punkte-Rückbuchung
// ════════════════════════════════════════════════════════════════════════════════

async function pendingRedemption(startPoints = 100) {
  const kid = freshKid(startPoints);
  const r = await call('POST', '/redemptions', { actor: kid, body: { catalog_id: EIS } });
  return { kid, id: r.body.data.id };
}

test('PATCH /redemptions/:id — 404 + 400 ungültige Aktion', async () => {
  assert.equal((await call('PATCH', '/redemptions/999999', { body: { action: 'fulfill' } })).status, 404);
  const { id } = await pendingRedemption();
  assert.equal((await call('PATCH', `/redemptions/${id}`, { actor: ADMIN, body: { action: 'nope' } })).status, 400);
});

test('PATCH /redemptions/:id — Autorisierung (fulfill/reject Admin, cancel Owner)', async () => {
  const { kid, id } = await pendingRedemption();
  assert.equal((await call('PATCH', `/redemptions/${id}`, { actor: kid, body: { action: 'fulfill' } })).status, 403, 'Nicht-Admin darf nicht erfüllen');
  assert.equal((await call('PATCH', `/redemptions/${id}`, { actor: KID_B, body: { action: 'cancel' } })).status, 403, 'Fremder darf nicht stornieren');
  // Owner darf stornieren
  const ok = await call('PATCH', `/redemptions/${id}`, { actor: kid, body: { action: 'cancel' } });
  assert.equal(ok.status, 200);
});

test('PATCH /redemptions/:id — fulfill: Punkte bleiben abgezogen', async () => {
  const { kid, id } = await pendingRedemption(100); // Saldo 90 nach Reservierung
  const res = await call('PATCH', `/redemptions/${id}`, { actor: ADMIN, body: { action: 'fulfill' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'fulfilled');
  assert.equal(res.body.data.decided_by, ADMIN.id);
  assert.equal(getBalance(db, kid.id), 90, 'fulfill bucht NICHT zurück');
});

test('PATCH /redemptions/:id — reject: reservierte Punkte zurückgebucht', async () => {
  const { kid, id } = await pendingRedemption(100);
  const res = await call('PATCH', `/redemptions/${id}`, { actor: ADMIN, body: { action: 'reject' } });
  assert.equal(res.body.data.status, 'rejected');
  assert.equal(getBalance(db, kid.id), 100, 'reject bucht +10 zurück');
});

test('PATCH /redemptions/:id — cancel durch Owner bucht zurück', async () => {
  const { kid, id } = await pendingRedemption(100);
  const res = await call('PATCH', `/redemptions/${id}`, { actor: kid, body: { action: 'cancel' } });
  assert.equal(res.body.data.status, 'cancelled');
  assert.equal(getBalance(db, kid.id), 100, 'cancel bucht +10 zurück');
});

test('PATCH /redemptions/:id — 409 wenn bereits entschieden (Idempotenz)', async () => {
  const { kid, id } = await pendingRedemption(100);
  await call('PATCH', `/redemptions/${id}`, { actor: ADMIN, body: { action: 'fulfill' } });
  const balAfterFulfill = getBalance(db, kid.id); // 90 (reserviert, nicht zurückgebucht)
  const again = await call('PATCH', `/redemptions/${id}`, { actor: ADMIN, body: { action: 'reject' } });
  assert.equal(again.status, 409, 'zweite Entscheidung abgelehnt');
  assert.equal(getBalance(db, kid.id), balAfterFulfill, 'kein Doppel-Ledger: der 409-Pfad bucht nichts zurück');
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /redemptions + /overview (nach Aktivität)
// ════════════════════════════════════════════════════════════════════════════════

test('GET /redemptions — Status-Filter + Namens-Joins', async () => {
  const { id } = await pendingRedemption(100);
  const pending = await call('GET', '/redemptions?status=pending', { actor: ADMIN });
  assert.equal(pending.status, 200);
  assert.ok(pending.body.data.every((r) => r.status === 'pending'));
  const mine = pending.body.data.find((r) => r.id === id);
  assert.ok(mine && mine.user_name, 'user_name-Join vorhanden');
  // ungültiger Status-Query wird ignoriert (kein Filter) -> liefert Liste
  assert.equal((await call('GET', '/redemptions?status=bogus', { actor: ADMIN })).status, 200);
});

test('GET /overview — Ränge, Katalog und pendingCount nach Aktivität', async () => {
  const res = await call('GET', '/overview', { actor: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.isAdmin, true);
  assert.ok(res.body.data.catalog.some((c) => c.id === EIS), 'aktive Prämie im Katalog');
  assert.ok(res.body.data.pendingCount >= 1, 'offene Anfragen gezählt');
  // Ränge: absteigend nach balance, gleiche balance -> gleicher Rang.
  const bal = res.body.data.balances;
  for (let i = 1; i < bal.length; i++) assert.ok(bal[i - 1].balance >= bal[i].balance, 'balances absteigend');
  assert.equal(bal[0].rank, 1, 'Spitzenreiter hat Rang 1');
});
