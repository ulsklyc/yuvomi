/**
 * Test: Split-Expenses-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - Autorisierung (requireGroupAccess,
 *        canManageGroup, Gast-Confinement) und Geld-/Ledger-Integrität
 *        (Ausgabe -> Salden, Settlement, Edit/Delete-Ledger-Konsistenz). Die
 *        reine Split-Mathematik liegt bereits in test-split-expenses.js; hier
 *        geht es um die Route-/Zugriffs-Schicht, die zuvor ungetestet war.
 * Ausführen: node --experimental-sqlite --test test/test-split-expenses-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const db = dbmod.get();

// --- Nutzer: Owner + In-Gruppen-Manager + einfaches Mitglied + Aussenstehender + System-Admin ---
function mkUser(username, role = 'member') {
  return db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?)`,
  ).run(username, username.toUpperCase(), role).lastInsertRowid;
}
const OWNER = mkUser('owner');
const MGR = mkUser('mgr');
const MEM = mkUser('mem');
const OUTSIDER = mkUser('outsider');
const ADMIN = mkUser('admin', 'admin');

// Aktueller Akteur pro Request (die Middleware liest ihn zur Request-Zeit).
let actor = { id: OWNER, role: 'member' };
function as(id, role = 'member') { actor = { id, role }; }

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  // cookieSession: eine Sitzung, die neben einem API-Token mitkommt - requireAuth
  // setzt authUserId/authRole dann aus dem Token, req.session bleibt die Sitzung.
  req.session = actor.cookieSession ?? { userId: actor.id, role: actor.role };
  // Beide Rechte-Achsen wie in requireAuth/applyRoleModuleAccess; ohne Angabe
  // unbeschraenkt, damit die uebrigen Faelle unveraendert laufen.
  req.sessionModuleAccess = actor.moduleAccess ?? null;
  req.authScopes = actor.scopes ?? null;
  next();
});
app.use('/', splitRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, { actor: a, body } = {}) {
  if (a) actor = a;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

// Salden eines Nutzers in einer Gruppe abrufen (Map user_id -> net_minor).
async function netByUser(groupId, viewer = { id: OWNER, role: 'member' }) {
  const { body } = await call('GET', `/groups/${groupId}/balances`, { actor: viewer });
  const map = new Map();
  for (const row of body.data.balances) map.set(row.user_id, row.net_minor);
  return map;
}

// --------------------------------------------------------------------------
// Gemeinsamer Fixture-Aufbau: eine Gruppe mit Owner + Manager + Mitglied.
// --------------------------------------------------------------------------
let GROUP;
test('setup: Owner legt Gruppe an und fügt Manager (admin) + Mitglied (guest) hinzu', async () => {
  const created = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'WG-Kasse', type: 'household', default_currency: 'EUR' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.member_role, 'owner');
  GROUP = created.body.data.id;

  const addMgr = await call('POST', `/groups/${GROUP}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MGR, role: 'admin' } });
  assert.equal(addMgr.status, 201);
  assert.equal(addMgr.body.data.role, 'admin');

  const addMem = await call('POST', `/groups/${GROUP}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MEM, role: 'guest' } });
  assert.equal(addMem.status, 201);
  assert.equal(addMem.body.data.role, 'guest');
});

// --------------------------------------------------------------------------
// Autorisierung: requireGroupAccess
// --------------------------------------------------------------------------
test('requireGroupAccess: Aussenstehender bekommt 404 auf Gruppen-Endpunkte', async () => {
  const r = await call('GET', `/groups/${GROUP}/members`, { actor: { id: OUTSIDER, role: 'member' } });
  assert.equal(r.status, 404);
});

test('requireGroupAccess: Mitglied hat Lesezugriff', async () => {
  const r = await call('GET', `/groups/${GROUP}/members`, { actor: { id: MEM, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 3);
});

test('requireGroupAccess: System-Admin ohne Mitgliedschaft hat Zugriff (bewusster Bypass)', async () => {
  const r = await call('GET', `/groups/${GROUP}/members`, { actor: { id: ADMIN, role: 'admin' } });
  assert.equal(r.status, 200);
});

test('requireGroupAccess: Token eines Aussenstehenden neben einer Admin-Sitzung bekommt 404, die Admin-Sitzung allein 200', async () => {
  const withToken = await call('GET', `/groups/${GROUP}/members`, {
    actor: { id: OUTSIDER, role: 'member', cookieSession: { userId: ADMIN, role: 'admin' } },
  });
  assert.equal(withToken.status, 404, 'der Bypass urteilt nach der Rolle des Token-Subjekts');
  const adminOnly = await call('GET', `/groups/${GROUP}/members`, { actor: { id: ADMIN, role: 'admin' } });
  assert.equal(adminOnly.status, 200);
});

// --------------------------------------------------------------------------
// Autorisierung: canManageGroup
// --------------------------------------------------------------------------
test('canManageGroup: einfaches Mitglied (guest-Rolle) darf Gruppe nicht ändern -> 403', async () => {
  const r = await call('PATCH', `/groups/${GROUP}`, { actor: { id: MEM, role: 'member' }, body: { name: 'Hijack' } });
  assert.equal(r.status, 403);
});

test('canManageGroup: In-Gruppen-Admin darf Gruppe ändern', async () => {
  const r = await call('PATCH', `/groups/${GROUP}`, { actor: { id: MGR, role: 'member' }, body: { name: 'WG-Kasse 2' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'WG-Kasse 2');
});

test('canManageGroup: einfaches Mitglied darf keine Mitglieder aufnehmen -> 403', async () => {
  const r = await call('POST', `/groups/${GROUP}/members`, { actor: { id: MEM, role: 'member' }, body: { user_id: OUTSIDER, role: 'guest' } });
  assert.equal(r.status, 403);
});

test('Owner kann nicht entfernt werden -> 400', async () => {
  const r = await call('DELETE', `/groups/${GROUP}/members/${OWNER}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Geld: Ausgabe -> Salden (Ledger netto null, korrekte Schuldverteilung)
// --------------------------------------------------------------------------
let EXPENSE;
test('Ausgabe (equal, 30.00 EUR, 3 Teilnehmer): Zahler +20.00, je Teilnehmer -10.00', async () => {
  const r = await call('POST', `/groups/${GROUP}/expenses`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OWNER, participants: [OWNER, MGR, MEM], expense_date: '2026-05-10' },
  });
  assert.equal(r.status, 201);
  EXPENSE = r.body.data.id;

  const net = await netByUser(GROUP);
  assert.equal(net.get(OWNER), 2000, 'Zahler netto +2000 minor');
  assert.equal(net.get(MGR), -1000);
  assert.equal(net.get(MEM), -1000);
  // Ledger summiert über alle Nutzer zu null.
  const total = [...net.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 0, 'Ledger netto null');
});

test('Ausgabe-Validierung: Nicht-Mitglied als Zahler -> 400', async () => {
  const r = await call('POST', `/groups/${GROUP}/expenses`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'X', amount: '5.00', currency: 'EUR', split_method: 'equal', payer_id: OUTSIDER, participants: [OWNER] },
  });
  assert.equal(r.status, 400);
});

test('Ausgabe-Autorisierung: fremdes Mitglied (nicht Ersteller/Manager) darf nicht löschen -> 403', async () => {
  const r = await call('DELETE', `/expenses/${EXPENSE}`, { actor: { id: MEM, role: 'member' } });
  assert.equal(r.status, 403);
});

test('loadExpense-Sichtbarkeit: Aussenstehender sieht Ausgabe nicht -> 404', async () => {
  const r = await call('PUT', `/expenses/${EXPENSE}`, { actor: { id: OUTSIDER, role: 'member' }, body: { title: 'Y', amount: '1.00', currency: 'EUR' } });
  assert.equal(r.status, 404);
});

// Der PUT prueft die Mitgliedschaft von Zahler und Beteiligten wie der POST
// (GHSA-4p5w-5346-8598): vorher liess sich einer Person, die nie in der Gruppe
// war, eine Schuld zuschreiben, die sie nirgends sieht.
test('PUT /expenses/:id — Nicht-Mitglied als Zahler oder Beteiligter -> 400, Salden unveraendert', async () => {
  const before = await netByUser(GROUP);
  const payer = await call('PUT', `/expenses/${EXPENSE}`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OUTSIDER, participants: [OWNER, MGR], expense_date: '2026-05-10' },
  });
  assert.equal(payer.status, 400, `erwartet 400, bekommen ${payer.status}`);
  const participant = await call('PUT', `/expenses/${EXPENSE}`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Einkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', payer_id: OWNER, participants: [OWNER, OUTSIDER], expense_date: '2026-05-10' },
  });
  assert.equal(participant.status, 400, `erwartet 400, bekommen ${participant.status}`);
  const after = await netByUser(GROUP);
  assert.deepEqual([...after.entries()], [...before.entries()], 'kein Saldo fuer den Aussenstehenden, keine Verschiebung');
  assert.equal(after.has(OUTSIDER), false);
});

// --------------------------------------------------------------------------
// Geld: Edit ersetzt Splits ohne Doppelbuchung
// --------------------------------------------------------------------------
test('Edit der Ausgabe auf 60.00: Salden verdoppeln sich, keine Ledger-Doppelbuchung', async () => {
  const r = await call('PUT', `/expenses/${EXPENSE}`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Einkauf', amount: '60.00', currency: 'EUR', split_method: 'equal', payer_id: OWNER, participants: [OWNER, MGR, MEM], expense_date: '2026-05-10' },
  });
  assert.equal(r.status, 200);
  const net = await netByUser(GROUP);
  assert.equal(net.get(OWNER), 4000, 'Zahler +40.00 nach Edit (nicht +60.00 durch Doppelbuchung)');
  assert.equal(net.get(MGR), -2000);
  assert.equal(net.get(MEM), -2000);
});

// --------------------------------------------------------------------------
// Geld: Settlement bewegt Salden korrekt
// --------------------------------------------------------------------------
test('Settlement: MGR zahlt 20.00 an OWNER -> MGR ausgeglichen, OWNER-Saldo sinkt', async () => {
  const r = await call('POST', `/groups/${GROUP}/settlements`, {
    actor: { id: OWNER, role: 'member' },
    body: { payer_id: MGR, payee_id: OWNER, amount: '20.00', currency: 'EUR' },
  });
  assert.equal(r.status, 201);
  const net = await netByUser(GROUP);
  assert.equal(net.has(MGR), false, 'MGR ausgeglichen (aus Salden gefiltert)');
  assert.equal(net.get(OWNER), 2000, 'OWNER von +40.00 auf +20.00');
  assert.equal(net.get(MEM), -2000);
});

test('Settlement-Validierung: identische Nutzer -> 400', async () => {
  const r = await call('POST', `/groups/${GROUP}/settlements`, { actor: { id: OWNER, role: 'member' }, body: { payer_id: OWNER, payee_id: OWNER, amount: '5.00' } });
  assert.equal(r.status, 400);
});

test('Settlement-Validierung: Nicht-Mitglied -> 400', async () => {
  const r = await call('POST', `/groups/${GROUP}/settlements`, { actor: { id: OWNER, role: 'member' }, body: { payer_id: OUTSIDER, payee_id: OWNER, amount: '5.00' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Geld: Delete bucht eine Gegenbuchung (#1382)
// --------------------------------------------------------------------------
test('Delete der Ausgabe hebt ihre Buchung per Gegenbuchung auf (Rest = nur Settlement)', async () => {
  const r = await call('DELETE', `/expenses/${EXPENSE}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  const net = await netByUser(GROUP);
  // Nach Wegfall der 60.00-Ausgabe bleibt nur die Settlement-Buchung:
  // MGR +2000, OWNER -2000 (MEM war nur an der Ausgabe beteiligt -> 0, gefiltert).
  assert.equal(net.get(MGR), 2000);
  assert.equal(net.get(OWNER), -2000);
  assert.equal(net.has(MEM), false);
});

test('Gruppe mit Finanzhistorie kann nicht gelöscht werden -> 409 (archivieren)', async () => {
  const r = await call('DELETE', `/groups/${GROUP}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 409);
});

// --------------------------------------------------------------------------
// Gast-Confinement (split_expense_guest_users)
// --------------------------------------------------------------------------
let GUEST_GROUP, GUEST_ID;
test('Gast-Anlage: Owner erzeugt confined Gast in eigener Gruppe', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Reise', type: 'travel' } });
  GUEST_GROUP = g.body.data.id;
  const guest = await call('POST', `/groups/${GUEST_GROUP}/guests`, {
    actor: { id: OWNER, role: 'member' },
    body: { display_name: 'Gast Gustav', password: 'supersecret', family_role: 'other' },
  });
  assert.equal(guest.status, 201);
  GUEST_ID = guest.body.data.id;
});

test('Gast-Anlage-Validierung: Passwort < 8 Zeichen -> 400', async () => {
  const r = await call('POST', `/groups/${GUEST_GROUP}/guests`, { actor: { id: OWNER, role: 'member' }, body: { display_name: 'Kurz', password: 'short' } });
  assert.equal(r.status, 400);
});

test('Gast sieht nur seine eigene Gruppe', async () => {
  const r = await call('GET', '/groups', { actor: { id: GUEST_ID, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].id, GUEST_GROUP);
});

test('Gast hat keinen Zugriff auf fremde Gruppe -> 404', async () => {
  const r = await call('GET', `/groups/${GROUP}/members`, { actor: { id: GUEST_ID, role: 'member' } });
  assert.equal(r.status, 404);
});

test('Gast darf keine Gruppe anlegen -> 403', async () => {
  const r = await call('POST', '/groups', { actor: { id: GUEST_ID, role: 'member' }, body: { name: 'Heimlich' } });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// Metadaten + Gast-Varianten (uniqueUsername, syncGuestArtifacts-Birthday)
// --------------------------------------------------------------------------
test('GET /meta liefert Enum-Listen + Default-Währung', async () => {
  const r = await call('GET', '/meta', { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.currencies) && r.body.data.currencies.includes('EUR'));
  assert.ok(r.body.data.currencies.includes('MYR'));
  assert.ok(r.body.data.split_methods.includes('equal'));
  assert.ok(r.body.data.frequencies.includes('monthly'));
  assert.equal(typeof r.body.data.default_currency, 'string');
});

test('Gast-Anlage mit explizitem Username + Geburtsdatum legt Kontakt + Geburtstag an', async () => {
  const r = await call('POST', `/groups/${GUEST_GROUP}/guests`, {
    actor: { id: OWNER, role: 'member' },
    body: { display_name: 'Gast Greta', password: 'supersecret', username: 'greta.custom', birth_date: '1985-03-03' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.username, 'greta.custom');
  const newId = r.body.data.id;
  // syncGuestArtifacts: Kontakt- und Geburtstags-Artefakt am neuen Nutzer.
  const contact = db.prepare('SELECT * FROM contacts WHERE family_user_id = ?').get(newId);
  assert.ok(contact, 'Kontakt-Artefakt angelegt');
  const bday = db.prepare('SELECT * FROM birthdays WHERE family_user_id = ?').get(newId);
  assert.ok(bday, 'Geburtstags-Artefakt angelegt');
  assert.equal(bday.birth_date, '1985-03-03');
});

test('Gast-Anlage mit bereits vergebenem Username -> 409', async () => {
  const r = await call('POST', `/groups/${GUEST_GROUP}/guests`, {
    actor: { id: OWNER, role: 'member' },
    body: { display_name: 'Kollision', password: 'supersecret', username: 'greta.custom' },
  });
  assert.equal(r.status, 409);
});

test('Gast-Anlage: gespiegelter Kontakt traegt den Kategorie-Key misc (#1140)', async () => {
  const r = await call('POST', `/groups/${GUEST_GROUP}/guests`, {
    actor: { id: OWNER, role: 'member' },
    body: { display_name: 'Gast Milo', password: 'supersecret' },
  });
  assert.equal(r.status, 201);
  // syncGuestArtifacts schrieb frueher das deutsche Literal 'Sonstiges' - kein
  // Key in contact_categories, die UI zeigte es unuebersetzt an (#1140). Der
  // Spiegel-Kontakt muss den stabilen Key 'misc' tragen.
  const contact = db.prepare('SELECT category FROM contacts WHERE family_user_id = ?').get(r.body.data.id);
  assert.ok(contact, 'Kontakt-Artefakt angelegt');
  assert.equal(contact.category, 'misc', 'gespiegelter Gast-Kontakt nutzt den stabilen Key misc');
});

// --------------------------------------------------------------------------
// Betriebsgruppe OPS: Liste, Filter, Kommentare, Aktivität, Suche, Dashboard
// --------------------------------------------------------------------------
let OPS, OPS_E1;
test('setup OPS: Gruppe mit Owner + Manager + Mitglied + zwei Ausgaben', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Ops-Kasse', type: 'general', default_currency: 'EUR' } });
  OPS = g.body.data.id;
  await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MGR, role: 'admin' } });
  await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MEM, role: 'guest' } });

  const e1 = await call('POST', `/groups/${OPS}/expenses`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Supermarkt', description: 'Wocheneinkauf', amount: '30.00', currency: 'EUR', split_method: 'equal', category: 'groceries', payer_id: OWNER, participants: [OWNER, MGR, MEM], expense_date: '2026-05-10' },
  });
  assert.equal(e1.status, 201);
  OPS_E1 = e1.body.data.id;

  // Ausgabe mit Fremdwährung (converted_amount) + Beleg-Anhang.
  const doc = db.prepare(`
    INSERT INTO family_documents (name, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('Beleg', 'beleg.pdf', 'application/pdf', 10, x'255044', ?)
  `).run(OWNER).lastInsertRowid;
  const e2 = await call('POST', `/groups/${OPS}/expenses`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Hotel', amount: '110.00', currency: 'USD', converted_amount: '100.00', converted_currency: 'EUR', split_method: 'equal', category: 'travel', payer_id: MGR, participants: [OWNER, MGR], attachment_document_ids: [doc], expense_date: '2026-05-11' },
  });
  assert.equal(e2.status, 201);
  assert.equal(e2.body.data.attachments.length, 1, 'Beleg-Anhang serialisiert');
  assert.equal(e2.body.data.currency, 'USD');
  assert.equal(e2.body.data.converted_currency, 'EUR');
});

test('GET /groups/:id/expenses listet Ausgaben mit Pagination + Splits', async () => {
  const r = await call('GET', `/groups/${OPS}/expenses`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 2);
  assert.equal(r.body.pagination.has_more, false);
  const supermarkt = r.body.data.find((e) => e.title === 'Supermarkt');
  assert.equal(supermarkt.splits.length, 3, 'Splits per Batch geladen');
});

test('GET /groups/:id/expenses: q-Filter grenzt auf Titel/Beschreibung ein', async () => {
  const r = await call('GET', `/groups/${OPS}/expenses?q=Hotel`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].title, 'Hotel');
});

test('GET /groups/:id/expenses: category-Filter + limit/offset-Pagination', async () => {
  const cat = await call('GET', `/groups/${OPS}/expenses?category=groceries`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(cat.body.data.length, 1);
  assert.equal(cat.body.data[0].category, 'groceries');
  const paged = await call('GET', `/groups/${OPS}/expenses?limit=1&offset=0`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(paged.body.data.length, 1);
  assert.equal(paged.body.pagination.has_more, true, 'weitere Seite vorhanden');
  const rec = await call('GET', `/groups/${OPS}/expenses?recurring=1`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(rec.body.data.length, 0, 'keine Ausgabe hat eine Wiederholungsregel');
});

test('member-candidates: Owner 200, Gast 403, Aussenstehender 404', async () => {
  const ok = await call('GET', `/groups/${OPS}/member-candidates`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.data));
  const guest = await call('GET', `/groups/${GUEST_GROUP}/member-candidates`, { actor: { id: GUEST_ID, role: 'member' } });
  assert.equal(guest.status, 403);
  const outsider = await call('GET', `/groups/${OPS}/member-candidates`, { actor: { id: OUTSIDER, role: 'member' } });
  assert.equal(outsider.status, 404);
});

test('POST /expenses/:id/comments: Erfolg + leerer Kommentar 400', async () => {
  const ok = await call('POST', `/expenses/${OPS_E1}/comments`, { actor: { id: MEM, role: 'member' }, body: { comment: 'Passt so.' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.comment, 'Passt so.');
  const bad = await call('POST', `/expenses/${OPS_E1}/comments`, { actor: { id: OWNER, role: 'member' }, body: { comment: '' } });
  assert.equal(bad.status, 400);
});

test('loadExpense: System-Admin ohne Mitgliedschaft darf kommentieren (bewusster Bypass)', async () => {
  const r = await call('POST', `/expenses/${OPS_E1}/comments`, { actor: { id: ADMIN, role: 'admin' }, body: { comment: 'Admin-Notiz' } });
  assert.equal(r.status, 201);
});

test('GET /groups/:id/activity liefert Aktivitäts-Log mit geparster Metadata', async () => {
  const r = await call('GET', `/groups/${OPS}/activity`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 3, 'Gruppen-/Mitglieder-/Ausgaben-Ereignisse');
  const created = r.body.data.find((a) => a.type === 'expense_created');
  assert.ok(created.metadata && typeof created.metadata === 'object', 'Metadata als Objekt geparst');
});

test('GET /search findet Gruppe, Ausgabe und Person', async () => {
  const r = await call('GET', `/search?q=Supermarkt`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.expenses.length, 1);
  assert.equal(r.body.data.expenses[0].title, 'Supermarkt');
  const grp = await call('GET', `/search?q=Ops-Kasse`, { actor: { id: OWNER, role: 'member' } });
  assert.ok(grp.body.data.groups.some((g) => g.id === OPS));
  const ppl = await call('GET', `/search?q=MGR`, { actor: { id: OWNER, role: 'member' } });
  assert.ok(ppl.body.data.people.some((p) => p.id === MGR));
});

test('GET /search: Gast bleibt auf eigene Gruppe eingeschränkt', async () => {
  const r = await call('GET', `/search?q=`, { actor: { id: GUEST_ID, role: 'member' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.groups.every((g) => g.id === GUEST_GROUP), 'nur eigene Gruppe sichtbar');
});

test('GET /dashboard aggregiert Salden, Gruppen und jüngste Ausgaben', async () => {
  const r = await call('GET', '/dashboard', { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.total_owed));
  assert.ok(Array.isArray(r.body.data.total_owing));
  assert.ok(Array.isArray(r.body.data.groups));
  assert.ok(r.body.data.recent_expenses.some((e) => e.title === 'Supermarkt'));
});

// --------------------------------------------------------------------------
// Wiederkehrende Ausgaben (recurring): CRUD + Pause-Autorisierung
// --------------------------------------------------------------------------
let OPS_REC;
test('GET /dashboard: Gast bleibt auf eigene Gruppe eingeschränkt', async () => {
  const r = await call('GET', '/dashboard', { actor: { id: GUEST_ID, role: 'member' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.groups.every((g) => g.id === GUEST_GROUP), 'nur eigene Gruppe im Gast-Dashboard');
});

test('GET /groups/:id/recurring ist zunächst leer', async () => {
  const r = await call('GET', `/groups/${OPS}/recurring`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 0);
});

test('POST /groups/:id/recurring: Anlage + ungültige Frequenz 400', async () => {
  const bad = await call('POST', `/groups/${OPS}/recurring`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'daily', next_run_date: '2026-06-01', payer_id: OWNER, participants: [OWNER, MGR] },
  });
  assert.equal(bad.status, 400);
  const ok = await call('POST', `/groups/${OPS}/recurring`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'monthly', next_run_date: '2026-06-01', payer_id: OWNER, participants: [OWNER, MGR] },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.frequency, 'monthly');
  OPS_REC = ok.body.data.id;
  const list = await call('GET', `/groups/${OPS}/recurring`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(list.body.data.length, 1);
});

test('POST /recurring/:id/pause: Toggle pausiert und reaktiviert', async () => {
  const paused = await call('POST', `/recurring/${OPS_REC}/pause`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(paused.status, 200);
  assert.ok(paused.body.data.paused_at, 'pausiert');
  const resumed = await call('POST', `/recurring/${OPS_REC}/pause`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.paused_at, null, 'reaktiviert');
});

test('POST /recurring/:id/pause: unbekannte ID -> 404', async () => {
  const r = await call('POST', '/recurring/999999/pause', { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 404);
});

test('POST /recurring/:id/pause: Nicht-Ersteller ohne Manage-Recht -> 403', async () => {
  const r = await call('POST', `/recurring/${OPS_REC}/pause`, { actor: { id: MEM, role: 'member' } });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// Mitglied via Kontakt (userFromContact) inkl. eindeutiger Username-Vergabe
// --------------------------------------------------------------------------
test('POST members via contact_id: neuer Nutzer, Kontakt verknüpft, Username eindeutig', async () => {
  // Kontaktname kollidiert bewusst mit bestehendem Username 'owner'.
  const contactId = db.prepare(`INSERT INTO contacts (name, category) VALUES ('owner', 'Sonstiges')`).run().lastInsertRowid;
  const r = await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { contact_id: contactId, role: 'guest' } });
  assert.equal(r.status, 201);
  const created = db.prepare('SELECT username FROM users WHERE id = ?').get(r.body.data.user_id);
  assert.equal(created.username, 'owner.2', 'Kollision mit bestehendem Username aufgelöst');
  const linked = db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(contactId);
  assert.equal(linked.family_user_id, r.body.data.user_id, 'Kontakt mit neuem Nutzer verknüpft');
});

test('POST members via contact_id: bereits verknüpfter Kontakt nutzt bestehenden Nutzer', async () => {
  const contactId = db.prepare(`INSERT INTO contacts (name, category, family_user_id) VALUES ('Verknuepft', 'Sonstiges', ?)`).run(OUTSIDER).lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { contact_id: contactId, role: 'guest' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.user_id, OUTSIDER, 'bestehender Nutzer aus Kontakt übernommen');
  const after = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert.equal(after, before, 'kein neuer Nutzer angelegt');
});

test('POST members via contact_id mit Geburtstag: erzeugt Nutzer + Geburtstags-Artefakt', async () => {
  const contactId = db.prepare(`INSERT INTO contacts (name, category, phone, birthday) VALUES ('Bday Kontakt', 'Sonstiges', '0170', '1992-07-07')`).run().lastInsertRowid;
  const r = await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { contact_id: contactId, role: 'guest' } });
  assert.equal(r.status, 201);
  const bday = db.prepare('SELECT birth_date FROM birthdays WHERE family_user_id = ?').get(r.body.data.user_id);
  assert.ok(bday, 'Geburtstag aus Kontakt übernommen');
  assert.equal(bday.birth_date, '1992-07-07');
});

// Der Kontakt ist Quelldatum aus `contacts`: ohne dessen Leserecht (Mitglied
// oder Token) antwortet die Route wie bei einer unbekannten ID und legt
// nichts an - sonst verriete der angelegte Gast Name, Telefon und E-Mail. Ein
// freier Kontakt braucht dazu das Schreibrecht, weil er verknuepft wird.
test('POST members via contact_id: ohne Kontaktrecht 404 wie eine unbekannte ID, nichts angelegt', async () => {
  const frei = db.prepare(`INSERT INTO contacts (name, category, phone, email) VALUES ('Geheim Kontakt', 'Sonstiges', '0171', 'geheim@example.test')`).run().lastInsertRowid;
  const verknuepft = db.prepare(`INSERT INTO contacts (name, category, family_user_id) VALUES ('Geheim Verknuepft', 'Sonstiges', ?)`).run(mkUser('geheim.verknuepft')).lastInsertRowid;
  const users = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const members = () => db.prepare('SELECT COUNT(*) AS n FROM expense_group_members WHERE group_id = ?').get(OPS).n;

  const unbekannt = await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { contact_id: 999999, role: 'guest' } });
  assert.equal(unbekannt.status, 404, 'eine unbekannte Kontakt-ID ist 404, kein 500');

  const vorherNutzer = users();
  const vorherMitglieder = members();
  for (const actor of [
    { id: OWNER, role: 'member', moduleAccess: { contacts: 'none' } },
    { id: OWNER, role: 'member', scopes: ['budget:write'] },
  ]) {
    for (const contactId of [frei, verknuepft]) {
      const r = await call('POST', `/groups/${OPS}/members`, { actor, body: { contact_id: contactId, role: 'guest' } });
      assert.equal(r.status, 404, 'dieselbe Antwort wie bei einer unbekannten ID');
      assert.equal(r.body.error, unbekannt.body.error, 'auch derselbe Text');
    }
  }
  assert.equal(users(), vorherNutzer, 'kein Gastnutzer angelegt');
  assert.equal(members(), vorherMitglieder, 'kein Mitglied hinzugefuegt');
  assert.equal(db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(frei).family_user_id, null, 'Kontakt nicht verknuepft');

  // Ein FREIER Kontakt wird beim Hinzufuegen beschrieben: er bekommt ein
  // Konto (`family_user_id`), und Name, Telefon und E-Mail werden danach aus
  // dem Konto gespiegelt. Das ist ein Schreibvorgang in `contacts` und braucht
  // dessen Schreibrecht; ein schon verknuepfter Kontakt wird nur gelesen.
  const kontakt = () => db.prepare('SELECT name, category, phone, email, family_user_id FROM contacts WHERE id = ?').get(frei);
  const vorherKontakt = kontakt();
  for (const actor of [
    { id: OWNER, role: 'member', moduleAccess: { contacts: 'read' } },
    { id: OWNER, role: 'member', scopes: ['budget:write', 'contacts:read'] },
  ]) {
    const lesend = await call('POST', `/groups/${OPS}/members`, { actor, body: { contact_id: frei, role: 'guest' } });
    assert.equal(lesend.status, 403, 'contacts: read beschreibt keinen freien Kontakt');
  }
  assert.deepEqual(kontakt(), vorherKontakt, 'der Kontakt ist unveraendert');
  assert.equal(users(), vorherNutzer, 'kein Gastnutzer angelegt');
  assert.equal(members(), vorherMitglieder, 'kein Mitglied hinzugefuegt');

  const verknuepftLesend = await call('POST', `/groups/${OPS}/members`, {
    actor: { id: OWNER, role: 'member', moduleAccess: { contacts: 'read' } }, body: { contact_id: verknuepft, role: 'guest' },
  });
  assert.equal(verknuepftLesend.status, 201, 'ein verknuepfter Kontakt wird nur gelesen: read reicht');

  const schreibend = await call('POST', `/groups/${OPS}/members`, {
    actor: { id: OWNER, role: 'member', moduleAccess: { contacts: 'write' } }, body: { contact_id: frei, role: 'guest' },
  });
  assert.equal(schreibend.status, 201, 'contacts: write verknuepft den freien Kontakt');
  assert.ok(kontakt().family_user_id, 'jetzt mit Konto');
});

// Der Passwort-Hash ist der einzige asynchrone Schritt. Liegt er zwischen dem
// Lesen des Kontakts und dem Schreiben des Gastes, legen zwei gleichzeitige
// Anfragen zwei Gaeste fuer denselben Kontakt an.
test('POST members via contact_id: zwei gleichzeitige Anfragen legen EINEN Gast an', async () => {
  const contactId = db.prepare(`INSERT INTO contacts (name, category) VALUES ('Parallel Kontakt', 'Sonstiges')`).run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const body = { contact_id: contactId, role: 'guest' };
  const actor = { id: OWNER, role: 'member' };
  const [a, b] = await Promise.all([
    call('POST', `/groups/${OPS}/members`, { actor, body }),
    call('POST', `/groups/${OPS}/members`, { actor, body }),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.data.user_id, b.body.data.user_id, 'beide Antworten nennen denselben Gast');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before + 1, 'genau ein neuer Nutzer');
});

// WAEHREND DES HASHES AENDERT SICH DIE WELT. Der Passwort-Hash ist der einzige
// asynchrone Schritt der Route; alles, worauf geschrieben wird - Gruppe,
// Verwalterrecht, Kontakt -, muss NACH ihm noch einmal gelesen werden, in
// derselben synchronen Transaktion wie das Schreiben. Sonst bleibt ein Gast
// ohne Gruppe zurueck oder ein entzogenes Recht schreibt trotzdem.
// Der Eingriff laeuft GENAU beim Start des Hashes: `bcrypt.hash` wird fuer
// einen Aufruf umhuellt (server/utils/password.js liest die Methode erst beim
// Aufruf vom geteilten Modulobjekt). Kein Timer - ein langsamer Runner liefe
// sonst still vor der Vorpruefung in den Eingriff und maesse die Vorpruefung
// statt der Neupruefung. Dass der Eingriff lief, prueft die Naht selbst.
async function duringHash(action, request) {
  const original = bcrypt.hash;
  let ran = false;
  bcrypt.hash = function hashWithIntervention(...args) {
    bcrypt.hash = original;
    ran = true;
    action();
    return original.apply(this, args);
  };
  try {
    return await request();
  } finally {
    bcrypt.hash = original;
    assert.ok(ran, 'der Eingriff lief waehrend des Hashes');
  }
}

test('POST members via contact_id: Gruppe waehrend des Hashes geloescht -> 404, kein verwaister Gast', async () => {
  const g = (await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Verschwindet', type: 'household', default_currency: 'EUR' } })).body.data.id;
  const contactId = db.prepare(`INSERT INTO contacts (name, category) VALUES ('Hash Kontakt Gruppe', 'Sonstiges')`).run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = await duringHash(
    () => db.prepare('DELETE FROM expense_groups WHERE id = ?').run(g),
    () => call('POST', `/groups/${g}/members`, { actor: { id: OWNER, role: 'member' }, body: { contact_id: contactId, role: 'guest' } }),
  );
  assert.equal(r.status, 404, 'die Gruppe gibt es nicht mehr');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'kein Gastnutzer ohne Gruppe');
  assert.equal(db.prepare('SELECT family_user_id FROM contacts WHERE id = ?').get(contactId).family_user_id, null, 'Kontakt nicht verknuepft');
});

test('POST members via contact_id: Verwalterrecht waehrend des Hashes entzogen -> 403, nichts angelegt', async () => {
  const g = (await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Entzogen', type: 'household', default_currency: 'EUR' } })).body.data.id;
  assert.equal((await call('POST', `/groups/${g}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MGR, role: 'admin' } })).status, 201);
  const contactId = db.prepare(`INSERT INTO contacts (name, category) VALUES ('Hash Kontakt Recht', 'Sonstiges')`).run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = await duringHash(
    () => db.prepare("UPDATE expense_group_members SET role = 'guest' WHERE group_id = ? AND user_id = ?").run(g, MGR),
    () => call('POST', `/groups/${g}/members`, { actor: { id: MGR, role: 'member' }, body: { contact_id: contactId, role: 'guest' } }),
  );
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'kein Gastnutzer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_group_members WHERE group_id = ?').get(g).n, 2, 'keine neue Mitgliedschaft');
});

test('POST guests: Gruppe waehrend des Hashes geloescht -> 404, kein verwaister Gast', async () => {
  const g = (await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Verschwindet Gast', type: 'household', default_currency: 'EUR' } })).body.data.id;
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = await duringHash(
    () => db.prepare('DELETE FROM expense_groups WHERE id = ?').run(g),
    () => call('POST', `/groups/${g}/guests`, { actor: { id: OWNER, role: 'member' }, body: { display_name: 'Waise', password: 'geheim12345' } }),
  );
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'kein Gastnutzer ohne Gruppe');
});

test('POST guests: zwei gleichzeitige Anfragen mit demselben Benutzernamen -> 201 und 409', async () => {
  const body = { display_name: 'Zwilling', username: 'zwilling.gast', password: 'geheim12345' };
  const actor = { id: OWNER, role: 'member' };
  const results = await Promise.all([
    call('POST', `/groups/${GROUP}/guests`, { actor, body }),
    call('POST', `/groups/${GROUP}/guests`, { actor, body }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], 'der zweite ist ein Konflikt, kein Serverfehler');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'zwilling.gast'").get().n, 1);
});

test('POST members: user_id noch contact_id -> 400', async () => {
  const r = await call('POST', `/groups/${OPS}/members`, { actor: { id: OWNER, role: 'member' }, body: { role: 'guest' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Mitglied entfernen, Archivieren, leere Gruppe löschen
// --------------------------------------------------------------------------
test('DELETE member: erfolgreiche Entfernung + unbekanntes Mitglied 404', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Remove-Test' } });
  const rg = g.body.data.id;
  await call('POST', `/groups/${rg}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: OUTSIDER, role: 'guest' } });
  const del = await call('DELETE', `/groups/${rg}/members/${OUTSIDER}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM expense_group_members WHERE group_id = ? AND user_id = ?').get(rg, OUTSIDER), undefined);
  const missing = await call('DELETE', `/groups/${rg}/members/${OUTSIDER}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(missing.status, 404);
});

test('POST /groups/:id/archive: Mitglied 403, Owner 200 -> Gruppe archiviert', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Archiv-Test' } });
  const ag = g.body.data.id;
  await call('POST', `/groups/${ag}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MEM, role: 'guest' } });
  const denied = await call('POST', `/groups/${ag}/archive`, { actor: { id: MEM, role: 'member' } });
  assert.equal(denied.status, 403);
  const ok = await call('POST', `/groups/${ag}/archive`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(ok.status, 200);
  const archived = await call('GET', '/groups?status=archived', { actor: { id: OWNER, role: 'member' } });
  assert.ok(archived.body.data.some((x) => x.id === ag));
});

test('POST /groups/:id/unarchive: Mitglied 403, Owner 200 -> Gruppe wieder aktiv (#574)', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Unarchiv-Test' } });
  const ug = g.body.data.id;
  await call('POST', `/groups/${ug}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MEM, role: 'guest' } });
  await call('POST', `/groups/${ug}/archive`, { actor: { id: OWNER, role: 'member' } });

  const denied = await call('POST', `/groups/${ug}/unarchive`, { actor: { id: MEM, role: 'member' } });
  assert.equal(denied.status, 403);
  const stillArchived = db.prepare('SELECT status FROM expense_groups WHERE id = ?').get(ug);
  assert.equal(stillArchived.status, 'archived');

  const ok = await call('POST', `/groups/${ug}/unarchive`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT status, archived_at FROM expense_groups WHERE id = ?').get(ug);
  assert.equal(row.status, 'active');
  assert.equal(row.archived_at, null, 'archived_at wird beim Wiederherstellen geleert');

  const active = await call('GET', '/groups', { actor: { id: OWNER, role: 'member' } });
  assert.ok(active.body.data.some((x) => x.id === ug), 'Gruppe steht wieder in der aktiven Liste');
  const archived = await call('GET', '/groups?status=archived', { actor: { id: OWNER, role: 'member' } });
  assert.ok(!archived.body.data.some((x) => x.id === ug), 'und nicht mehr im Archiv');
  const logged = db.prepare("SELECT 1 FROM expense_activity WHERE group_id = ? AND type = 'group_unarchived'").get(ug);
  assert.ok(logged, 'Wiederherstellen landet im Aktivitätsverlauf');
});

test('POST /groups/:id/unarchive: Aussenstehender bekommt 404 (kein Gruppen-Leak)', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Unarchiv-Fremd' } });
  const fg = g.body.data.id;
  await call('POST', `/groups/${fg}/archive`, { actor: { id: OWNER, role: 'member' } });
  const r = await call('POST', `/groups/${fg}/unarchive`, { actor: { id: OUTSIDER, role: 'member' } });
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT status FROM expense_groups WHERE id = ?').get(fg).status, 'archived');
});

test('DELETE /groups/:id: Gruppe ohne Finanzhistorie wird gelöscht', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Leer-Test' } });
  const eg = g.body.data.id;
  const del = await call('DELETE', `/groups/${eg}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM expense_groups WHERE id = ?').get(eg), undefined);
});

// --------------------------------------------------------------------------
// Standard-Aufteilung pro Gruppe (#517)
// --------------------------------------------------------------------------
let DGROUP;
test('split-defaults setup: Gruppe mit percentage-Default anlegen, Mitglieder hinzufügen', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Splitdefault', default_split_method: 'percentage' } });
  assert.equal(g.status, 201);
  assert.equal(g.body.data.default_split_method, 'percentage', 'Methode wird beim Anlegen übernommen');
  assert.equal(g.body.data.default_split_config ?? null, null, 'ohne weitere Mitglieder noch keine Config');
  DGROUP = g.body.data.id;
  await call('POST', `/groups/${DGROUP}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MGR, role: 'admin' } });
  await call('POST', `/groups/${DGROUP}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MEM, role: 'guest' } });
});

test('split-defaults: percentage-Werte pro Mitglied werden gespeichert und zurückgegeben', async () => {
  const r = await call('PATCH', `/groups/${DGROUP}`, {
    actor: { id: OWNER, role: 'member' },
    body: { default_split_method: 'percentage', default_split_config: [{ user_id: OWNER, percentage: '60' }, { user_id: MGR, percentage: '40' }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.default_split_method, 'percentage');
  assert.deepEqual(JSON.parse(r.body.data.default_split_config), [{ user_id: OWNER, percentage: '60' }, { user_id: MGR, percentage: '40' }]);
});

test('split-defaults: Nicht-Mitglieder und ungültige Werte werden verworfen (keine 100%-Pflicht)', async () => {
  const r = await call('PATCH', `/groups/${DGROUP}`, {
    actor: { id: OWNER, role: 'member' },
    body: { default_split_method: 'percentage', default_split_config: [
      { user_id: OWNER, percentage: '70' },
      { user_id: OUTSIDER, percentage: '30' }, // kein Mitglied -> raus
      { user_id: MGR, percentage: 'abc' },     // ungültiges Format -> raus
    ] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body.data.default_split_config), [{ user_id: OWNER, percentage: '70' }]);
});

test('split-defaults: shares-Default nimmt nur positive Ganzzahlen', async () => {
  const r = await call('PATCH', `/groups/${DGROUP}`, {
    actor: { id: OWNER, role: 'member' },
    body: { default_split_method: 'shares', default_split_config: [{ user_id: OWNER, shares: 2 }, { user_id: MGR, shares: 1 }, { user_id: MEM, shares: 0 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.default_split_method, 'shares');
  assert.deepEqual(JSON.parse(r.body.data.default_split_config), [{ user_id: OWNER, shares: 2 }, { user_id: MGR, shares: 1 }]);
});

test('split-defaults: Wechsel auf equal löscht die Config', async () => {
  const r = await call('PATCH', `/groups/${DGROUP}`, { actor: { id: OWNER, role: 'member' }, body: { default_split_method: 'equal' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.default_split_method, 'equal');
  assert.equal(r.body.data.default_split_config ?? null, null);
});

test('split-defaults: PATCH ohne Default-Felder lässt bestehende Aufteilung unangetastet', async () => {
  await call('PATCH', `/groups/${DGROUP}`, { actor: { id: OWNER, role: 'member' }, body: { default_split_method: 'percentage', default_split_config: [{ user_id: OWNER, percentage: '50' }, { user_id: MGR, percentage: '50' }] } });
  const r = await call('PATCH', `/groups/${DGROUP}`, { actor: { id: OWNER, role: 'member' }, body: { name: 'Splitdefault 2' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Splitdefault 2');
  assert.equal(r.body.data.default_split_method, 'percentage');
  assert.deepEqual(JSON.parse(r.body.data.default_split_config), [{ user_id: OWNER, percentage: '50' }, { user_id: MGR, percentage: '50' }]);
});

test('split-defaults: Guest darf Defaults nicht ändern -> 403', async () => {
  const r = await call('PATCH', `/groups/${DGROUP}`, { actor: { id: MEM, role: 'member' }, body: { default_split_method: 'equal' } });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// Verwaister Gast: die Gruppe verschwindet, das Confinement nicht
//
// split_expense_guest_users trägt zwei Aussagen: DASS ein Konto beschränkt ist
// (Existenz der Zeile - genau das fragt der Guard in server/index.js ab) und
// WORAUF (group_id). Das CASCADE aus Migration v40 nahm beim Löschen der
// Gruppe die ganze Zeile mit, der users-Eintrag blieb: aus dem Gast wurde ein
// haushaltsweit berechtigtes Konto. Migration 124 stellt das auf SET NULL um,
// die Routen lesen group_id IS NULL als "keine Gruppe", nicht als "frei".
// --------------------------------------------------------------------------
let ORPHAN_GROUP, ORPHAN_ID, SIDE_GROUP, SIDE_EXPENSE;
test('setup verwaister Gast: Gast in leerer Gruppe, zusätzlich Mitglied einer zweiten Gruppe', async () => {
  const g = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Wochenendtrip', type: 'travel' } });
  ORPHAN_GROUP = g.body.data.id;
  const guest = await call('POST', `/groups/${ORPHAN_GROUP}/guests`, {
    actor: { id: OWNER, role: 'member' },
    body: { display_name: 'Gast Orphan', password: 'supersecret', family_role: 'other' },
  });
  assert.equal(guest.status, 201);
  ORPHAN_ID = guest.body.data.id;

  // Zweite Gruppe mit Finanzhistorie, in der der Gast Mitglied wird. Erst so
  // wird sichtbar, ob das Confinement nach dem Löschen noch greift - ohne
  // Mitgliedschaft würde schon die Mitglieder-Prüfung alles abfangen.
  const side = await call('POST', '/groups', { actor: { id: OWNER, role: 'member' }, body: { name: 'Nebenkasse', type: 'general', default_currency: 'EUR' } });
  SIDE_GROUP = side.body.data.id;
  await call('POST', `/groups/${SIDE_GROUP}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: ORPHAN_ID, role: 'guest' } });
  const e = await call('POST', `/groups/${SIDE_GROUP}/expenses`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Nebenkassen-Beleg', amount: '20.00', currency: 'EUR', split_method: 'equal', category: 'general', payer_id: OWNER, participants: [OWNER, ORPHAN_ID], expense_date: '2026-05-20' },
  });
  assert.equal(e.status, 201);
  SIDE_EXPENSE = e.body.data.id;
});

test('Gast mit Gruppe erreicht die fremde Ausgabe nicht per ID', async () => {
  // /expenses/:id hängt nicht an requireGroupAccess, sondern an der
  // Mitgliedschaft - lesend, kommentierend und schreibend.
  const guest = { id: ORPHAN_ID, role: 'member' };
  const comment = await call('POST', `/expenses/${SIDE_EXPENSE}/comments`, { actor: guest, body: { comment: 'mitgelesen' } });
  assert.equal(comment.status, 404);
  const put = await call('PUT', `/expenses/${SIDE_EXPENSE}`, { actor: guest, body: { title: 'umbenannt', amount: '1.00', currency: 'EUR' } });
  assert.equal(put.status, 404);
  const del = await call('DELETE', `/expenses/${SIDE_EXPENSE}`, { actor: guest });
  assert.equal(del.status, 404);
  // Gegenprobe: Der Owner kommt weiterhin heran.
  const owner = await call('POST', `/expenses/${SIDE_EXPENSE}/comments`, { actor: { id: OWNER, role: 'member' }, body: { comment: 'ok' } });
  assert.equal(owner.status, 201);
});

test('Gast mit Gruppe sieht die fremde Gruppe auch im Dashboard nicht', async () => {
  // Noch vor dem Löschen: Die Mitgliedschaft allein öffnet Salden und Ausgaben
  // der Nebenkasse, das Confinement muss auch hier greifen.
  const r = await call('GET', '/dashboard', { actor: { id: ORPHAN_ID, role: 'member' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.groups.map((g) => g.id), [ORPHAN_GROUP], 'nur die eigene Gruppe');
  // Die einzige Ausgabe und der einzige Ledger-Eintrag des Gasts liegen in der
  // Nebenkasse - beides darf über die Mitgliedschaft nicht durchschlagen.
  assert.deepEqual(r.body.data.recent_expenses, [], 'keine fremden Ausgaben');
  assert.deepEqual(r.body.data.total_owing, [], 'kein Saldo aus der Nebenkasse');
  assert.deepEqual(r.body.data.total_owed, []);
});

test('leere Gast-Gruppe wird gelöscht -> 200', async () => {
  const r = await call('DELETE', `/groups/${ORPHAN_GROUP}`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM expense_groups WHERE id = ?').get(ORPHAN_GROUP), undefined);
});

test('Gruppenlöschung behält die Confinement-Zeile und leert nur die Zuordnung', () => {
  // Genau diese Abfrage fährt der Guard in server/index.js. Fehlt die Zeile,
  // ist das Gast-Login ein normales Haushaltskonto (Rechteausweitung).
  const row = db.prepare('SELECT * FROM split_expense_guest_users WHERE user_id = ?').get(ORPHAN_ID);
  assert.ok(row, 'Gast bleibt als Gast eingetragen');
  assert.equal(row.group_id, null, 'nur die Gruppenzuordnung fällt weg');
});

test('access_scope des verwaisten Gasts bleibt split_guest', () => {
  // Spiegelt USER_PUBLIC_COLUMNS aus server/auth.js (auch von routes/permissions.js genutzt).
  const scope = db.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = users.id
    ) THEN 'split_guest' ELSE 'family' END AS access_scope
    FROM users WHERE id = ?
  `).get(ORPHAN_ID);
  assert.equal(scope.access_scope, 'split_guest');
});

test('verwaister Gast erreicht die zweite Gruppe nicht, obwohl er Mitglied ist -> 404', async () => {
  const r = await call('GET', `/groups/${SIDE_GROUP}/members`, { actor: { id: ORPHAN_ID, role: 'member' } });
  assert.equal(r.status, 404);
});

test('verwaister Gast sieht keine Gruppen und kein Dashboard', async () => {
  const groups = await call('GET', '/groups', { actor: { id: ORPHAN_ID, role: 'member' } });
  assert.equal(groups.status, 200);
  assert.deepEqual(groups.body.data, []);
  const dash = await call('GET', '/dashboard', { actor: { id: ORPHAN_ID, role: 'member' } });
  assert.equal(dash.status, 200);
  assert.deepEqual(dash.body.data.groups, []);
  // Salden und jüngste Ausgaben hängen an der Mitgliedschaft, nicht an der
  // Gruppenliste - ohne eigenen Filter blieben sie sichtbar.
  assert.deepEqual(dash.body.data.recent_expenses, [], 'keine Ausgaben');
  assert.deepEqual(dash.body.data.total_owing, [], 'keine offenen Schulden');
  assert.deepEqual(dash.body.data.total_owed, [], 'keine offenen Forderungen');
});

test('verwaister Gast: Suche liefert nichts (kein Fallback auf "unbeschränkt")', async () => {
  const r = await call('GET', '/search?q=', { actor: { id: ORPHAN_ID, role: 'member' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.groups, [], 'keine Gruppen');
  assert.deepEqual(r.body.data.expenses, [], 'keine Ausgaben');
  assert.deepEqual(r.body.data.people, [], 'keine Personen');
  // Gegenprobe: Für den Owner findet dieselbe Suche die Nebenkasse sehr wohl.
  const owner = await call('GET', '/search?q=Nebenkassen', { actor: { id: OWNER, role: 'member' } });
  assert.ok(owner.body.data.expenses.some((e) => e.title === 'Nebenkassen-Beleg'), 'Owner sieht den Beleg');
});

test('verwaister Gast darf weiterhin keine Gruppe anlegen -> 403', async () => {
  const r = await call('POST', '/groups', { actor: { id: ORPHAN_ID, role: 'member' }, body: { name: 'Freigeschaltet?' } });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// member-candidates liest Kontakte und Geburtstage: die Felder folgen deren
// Leserecht (Kontakte = `contacts`, Geburtstage = `calendar`), auf beiden
// Achsen. Die Route bleibt offen - die Auswahl der Haushaltsmitglieder
// braucht nur Name und ID.
// --------------------------------------------------------------------------
test('member-candidates: Kontakt- und Geburtstagsfelder folgen dem Leserecht', async () => {
  db.prepare("UPDATE contacts SET family_user_id = NULL WHERE family_user_id = ?").run(OWNER);
  db.prepare(`INSERT INTO contacts (name, phone, email, family_user_id) VALUES ('Owner Kontakt', '+49 111', 'owner@example.test', ?)`).run(OWNER);
  db.prepare(`INSERT INTO contacts (name, phone, email, birthday) VALUES ('Nachbarin Kandidat', '+49 222', 'nachbarin@example.test', '1980-05-06')`).run();
  db.prepare(`INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('Owner', '1975-01-02', ?, ?)`).run(OWNER, OWNER);

  const path = `/groups/${GROUP}/member-candidates`;
  const owner = (rows) => rows.find((r) => r.source === 'user' && r.user_id === OWNER);
  const nachbarin = (rows) => rows.find((r) => r.source === 'contact' && r.display_name === 'Nachbarin Kandidat');

  // Vorbedingung: mit allen Rechten stehen die Felder da, sonst misst der Rest nichts.
  const voll = await call('GET', path, { actor: { id: OWNER, role: 'member' } });
  assert.equal(voll.status, 200);
  assert.equal(owner(voll.body.data).phone, '+49 111');
  assert.equal(owner(voll.body.data).email, 'owner@example.test');
  assert.equal(owner(voll.body.data).birth_date, '1975-01-02');
  assert.equal(nachbarin(voll.body.data)?.email, 'nachbarin@example.test');

  const ohneKontakte = await call('GET', path, { actor: { id: OWNER, role: 'member', moduleAccess: { contacts: 'none' } } });
  assert.equal(ohneKontakte.status, 200, 'die Auswahl der Haushaltsmitglieder bleibt');
  assert.equal(owner(ohneKontakte.body.data).display_name, 'OWNER');
  assert.equal(owner(ohneKontakte.body.data).phone, null, 'keine Telefonnummer ohne contacts');
  assert.equal(owner(ohneKontakte.body.data).email, null, 'keine E-Mail ohne contacts');
  assert.equal(owner(ohneKontakte.body.data).birth_date, '1975-01-02', 'der Geburtstag haengt am Kalender, nicht an contacts');
  assert.equal(ohneKontakte.body.data.some((r) => r.source === 'contact'), false, 'keine Kontakte als Kandidaten');

  const ohneKalender = await call('GET', path, { actor: { id: OWNER, role: 'member', moduleAccess: { calendar: 'none' } } });
  assert.equal(owner(ohneKalender.body.data).birth_date, null, 'kein Geburtstag ohne calendar');
  assert.equal(owner(ohneKalender.body.data).phone, '+49 111', 'Kontaktfelder bleiben mit contacts');
  assert.equal(nachbarin(ohneKalender.body.data)?.birth_date, '1980-05-06', 'der Geburtstag eines Kontakts ist Kontaktdatum');

  const lesend = await call('GET', path, { actor: { id: OWNER, role: 'member', moduleAccess: { contacts: 'read', calendar: 'read' } } });
  assert.equal(owner(lesend.body.data).phone, '+49 111', 'read reicht');
  assert.equal(owner(lesend.body.data).birth_date, '1975-01-02');
  assert.equal(lesend.body.data.some((r) => r.source === 'contact'), false,
    'freie Kontakte nur mit Schreibrecht: hinzufuegen verknuepft sie');

  const token = await call('GET', path, { actor: { id: OWNER, role: 'member', scopes: ['budget:write'] } });
  assert.equal(token.status, 200);
  assert.equal(owner(token.body.data).phone, null, 'Token ohne contacts:read');
  assert.equal(owner(token.body.data).email, null);
  assert.equal(owner(token.body.data).birth_date, null, 'Token ohne calendar:read');
  assert.equal(token.body.data.some((r) => r.source === 'contact'), false);
});

test('negative und Minus-Null-Betraege: 400 mit der Regel im Klartext, nichts wird gespeichert (#1607)', async () => {
  // Das Schema haelt negative Betraege seit jeher ab (CHECK an expenses,
  // expense_splits, settlements) - gespeichert wurde also nie einer. Die Antwort
  // war aber der rohe SQLite-Text ("CHECK constraint failed: ..."), und "-0" kam
  // an der Null-Pruefung vorbei: als Genau-Anteil wurde es als Anteil 0
  // gespeichert, obwohl "0" abgelehnt wird.
  const owner = { id: OWNER, role: 'member' };
  const zaehle = () => db.prepare('SELECT (SELECT COUNT(*) FROM expenses) AS e, (SELECT COUNT(*) FROM settlements) AS s, (SELECT COUNT(*) FROM expense_ledger_entries) AS l').get();
  const vorher = zaehle();
  const ausgabe = (extra) => call('POST', `/groups/${GROUP}/expenses`, {
    actor: owner, body: { title: 'Probe', amount: '10.00', payer_id: OWNER, participants: [OWNER, MEM], ...extra },
  });
  const genau = (a, b) => ausgabe({ split_method: 'exact', splits: [{ user_id: OWNER, amount: a }, { user_id: MEM, amount: b }] });
  const zahlung = (amount) => call('POST', `/groups/${GROUP}/settlements`, { actor: owner, body: { payer_id: MEM, payee_id: OWNER, amount } });

  for (const [name, antwort, regel] of [
    ['Genau-Anteil -5 / 15', await genau('-5', '15'), /^split amount must be greater than zero\.$/],
    ['Genau-Anteil -0 / 10', await genau('-0', '10'), /^split amount must be greater than zero\.$/],
    ['Genau-Anteil 0 / 10', await genau('0', '10'), /^split amount must be greater than zero\.$/],
    ['Gesamtbetrag -10', await ausgabe({ amount: '-10.00' }), /^amount must be greater than zero\.$/],
    ['Gesamtbetrag -0', await ausgabe({ amount: '-0' }), /^amount must be greater than zero\.$/],
    ['Zahlung -5', await zahlung('-5'), /^amount must be greater than zero\.$/],
    ['Zahlung -0', await zahlung('-0'), /^amount must be greater than zero\.$/],
    ['Prozent -50 / 150', await ausgabe({ split_method: 'percentage', splits: [{ user_id: OWNER, percentage: '-50' }, { user_id: MEM, percentage: '150' }] }), /^Percentages must be decimal strings/],
    ['Anteile -1 / 3', await ausgabe({ split_method: 'shares', splits: [{ user_id: OWNER, shares: -1 }, { user_id: MEM, shares: 3 }] }), /^Shares must be positive integers\.$/],
  ]) {
    assert.equal(antwort.status, 400, name);
    assert.match(antwort.body.error, regel, name);
  }
  assert.deepEqual(zaehle(), vorher, 'keine Ausgabe, keine Zahlung, keine Ledger-Zeile');

  // Gegenprobe: derselbe Aufruf mit gueltigen Genau-Anteilen geht durch.
  const gut = await genau('4', '6');
  assert.equal(gut.status, 201);
  assert.deepEqual(gut.body.data.splits.map((s) => s.amount_minor).sort((x, y) => x - y), [400, 600]);
});

// --------------------------------------------------------------------------
// Serien pruefen ihre Aufteilung beim Anlegen, mit derselben Regel wie eine
// Ausgabe. Bis hierher nahm POST /groups/:id/recurring Zahler, Beteiligte und
// `splits` ungeprueft und schrieb sie in `split_snapshot`; erst der Buchungslauf
// rechnete sie durch `buildSplits`. Eine unerfuellbare Serie liess ihn werfen
// (und mit ihr jede andere faellige Serie der Instanz, denn der Lauf ist EINE
// Transaktion), eine Serie mit einer gruppenfremden Person buchte dieser eine
// Schuld in eine Gruppe, die sie nie gesehen hat.
// --------------------------------------------------------------------------
const serie = (extra, groupId = GROUP) => call('POST', `/groups/${groupId}/recurring`, {
  actor: { id: OWNER, role: 'member' },
  body: { title: 'Strom', amount: '10.00', currency: 'EUR', frequency: 'monthly', next_run_date: '2026-01-15', payer_id: OWNER, participants: [OWNER, MEM], ...extra },
});
const serienZahl = () => db.prepare('SELECT COUNT(*) AS n FROM recurring_expenses').get().n;

test('POST /groups/:id/recurring: ungueltige Aufteilung -> 400, nichts gespeichert', async () => {
  const vorher = serienZahl();
  for (const [name, antwort, regel] of [
    ['Zahler ist kein Mitglied', await serie({ payer_id: OUTSIDER }), /^Payer must be a group member\.$/],
    ['Beteiligter ist kein Mitglied', await serie({ participants: [OWNER, OUTSIDER] }), /^All participants must be group members\.$/],
    ['Beteiligter existiert nicht', await serie({ participants: [OWNER, 999999] }), /^All participants must be group members\.$/],
    ['Beteiligte leer', await serie({ participants: [] }), /^participants must contain at least one member\.$/],
    ['Genau: Summe ungleich Betrag', await serie({ split_method: 'exact', splits: [{ user_id: OWNER, amount: '4.00' }, { user_id: MEM, amount: '5.00' }] }), /^Exact splits must add up to the expense amount\.$/],
    ['Genau: Anteil fehlt', await serie({ split_method: 'exact', splits: [{ user_id: OWNER, amount: '10.00' }] }), /^Each participant needs an exact split amount\.$/],
    ['Genau: Betrag als Zahl', await serie({ split_method: 'exact', splits: [{ user_id: OWNER, amount: 4 }, { user_id: MEM, amount: 6 }] }), /^split amount must be sent as a decimal string/],
    ['Genau: splits ist kein Array', await serie({ split_method: 'exact', splits: 'alles ich' }), /^Each participant needs an exact split amount\.$/],
    ['Prozent: Summe 90', await serie({ split_method: 'percentage', splits: [{ user_id: OWNER, percentage: '50' }, { user_id: MEM, percentage: '40' }] }), /^Percentages must add up to 100\.$/],
    ['Prozent: ohne splits', await serie({ split_method: 'percentage' }), /^Percentages must be decimal strings/],
    ['Anteile: 0', await serie({ split_method: 'shares', splits: [{ user_id: OWNER, shares: 0 }, { user_id: MEM, shares: 1 }] }), /^Shares must be positive integers\.$/],
  ]) {
    assert.equal(antwort.status, 400, name);
    assert.match(antwort.body.error, regel, name);
  }
  assert.equal(serienZahl(), vorher, 'keine der abgelehnten Serien liegt in der Tabelle');
});

test('POST /groups/:id/recurring: gespeichert wird die gepruefte Aufteilung, nicht der Request', async () => {
  const r = await serie({
    split_method: 'percentage',
    participants: [String(OWNER), MEM, MEM],
    splits: [
      { user_id: OUTSIDER, percentage: '100' },
      { user_id: OWNER, percentage: '30', amount: '99.00', note: 'x' },
      { user_id: String(MEM), percentage: '70' },
    ],
  });
  assert.equal(r.status, 201);
  const row = db.prepare('SELECT split_method, split_snapshot FROM recurring_expenses WHERE id = ?').get(r.body.data.id);
  assert.equal(row.split_method, 'percentage');
  assert.deepEqual(JSON.parse(row.split_snapshot), {
    participants: [OWNER, MEM],
    splits: [{ user_id: OWNER, percentage: '30' }, { user_id: MEM, percentage: '70' }],
  });
  // Gleichteilung traegt keine Einzelwerte: was mitkommt, wird nicht aufbewahrt.
  const gleich = await serie({ splits: [{ user_id: OUTSIDER, amount: '10.00' }] });
  assert.equal(gleich.status, 201);
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT split_snapshot FROM recurring_expenses WHERE id = ?').get(gleich.body.data.id).split_snapshot),
    { participants: [OWNER, MEM], splits: [] },
  );
});

// #1444: der Buchungslauf schrieb die Ledger-Zeilen mit einem eigenen INSERT.
// Gemessen wird der Lauf selbst gegen dieselbe Ausgabe ueber POST .../expenses -
// aendert sich die Buchungsregel nur auf einer Seite, wird das hier rot.
test('Buchungslauf: eine faellige Serie bucht dieselben Ledger-Zeilen wie POST /expenses', async () => {
  const { processDueRecurringExpenses } = await import('../server/services/split-expenses-scheduler.js');
  const owner = { id: OWNER, role: 'member' };
  const g = await call('POST', '/groups', { actor: owner, body: { name: 'Serienlauf', type: 'household', default_currency: 'EUR' } });
  const gid = g.body.data.id;
  for (const uid of [MGR, MEM]) {
    assert.equal((await call('POST', `/groups/${gid}/members`, { actor: owner, body: { user_id: uid, role: 'guest' } })).status, 201);
  }
  // Alles andere Faellige ruht, damit der Lauf nur diese Gruppe bucht.
  db.prepare('UPDATE recurring_expenses SET paused_at = ? WHERE paused_at IS NULL').run('2026-01-01T00:00:00Z');

  const faelle = [
    { title: 'Gleich', amount: '10.00', split_method: 'equal' },
    { title: 'Genau', amount: '10.00', split_method: 'exact', splits: [{ user_id: OWNER, amount: '1.00' }, { user_id: MGR, amount: '2.50' }, { user_id: MEM, amount: '6.50' }] },
    { title: 'Prozent', amount: '10.01', split_method: 'percentage', splits: [{ user_id: OWNER, percentage: '33.33' }, { user_id: MGR, percentage: '33.33' }, { user_id: MEM, percentage: '33.34' }] },
    { title: 'Anteile', amount: '0.10', split_method: 'shares', splits: [{ user_id: OWNER, shares: 1 }, { user_id: MGR, shares: 1 }, { user_id: MEM, shares: 1 }] },
  ];
  const gemeinsam = { currency: 'EUR', payer_id: MGR, participants: [OWNER, MGR, MEM] };
  for (const fall of faelle) {
    const r = await call('POST', `/groups/${gid}/recurring`, { actor: owner, body: { ...gemeinsam, ...fall, frequency: 'monthly', next_run_date: '2026-01-31' } });
    assert.equal(r.status, 201, fall.title);
    const e = await call('POST', `/groups/${gid}/expenses`, { actor: owner, body: { ...gemeinsam, ...fall, expense_date: '2026-01-31' } });
    assert.equal(e.status, 201, fall.title);
  }

  assert.deepEqual(processDueRecurringExpenses('2026-01-31'), { generated: faelle.length, paused: 0, failed: 0 });

  const zeilen = (where) => db.prepare(`
    SELECT e.title, l.group_id, l.source_type, l.user_id, l.counterparty_id, l.amount_minor, l.currency, l.memo, l.created_by
    FROM expense_ledger_entries l JOIN expenses e ON e.id = l.source_id AND l.source_type IN ('expense', 'expense_reversal')
    WHERE e.group_id = ? AND ${where}
    ORDER BY e.title, l.id
  `).all(gid);
  const vomLauf = zeilen('e.recurring_rule_id IS NOT NULL');
  const vonDerRoute = zeilen('e.recurring_rule_id IS NULL');
  assert.equal(vomLauf.length, faelle.length * 4, 'je Serie eine Zahler-Zeile und drei Anteile');
  assert.deepEqual(vomLauf, vonDerRoute);
  const anteile = (where) => db.prepare(`
    SELECT e.title, s.user_id, s.amount_minor, s.currency
    FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
    WHERE e.group_id = ? AND ${where} ORDER BY e.title, s.id
  `).all(gid);
  assert.deepEqual(anteile('e.recurring_rule_id IS NOT NULL'), anteile('e.recurring_rule_id IS NULL'));

  // Der Lauf hat den Termin weitergestellt und bucht denselben Tag nicht zweimal.
  assert.deepEqual(processDueRecurringExpenses('2026-01-31'), { generated: 0, paused: 0, failed: 0 });
});

// --------------------------------------------------------------------------
// Der Buchungslauf je Serie. Bis hierher buchte er alle faelligen Serien in
// EINER Transaktion: warf eine, war der ganze Lauf zurueckgerollt, kein Termin
// rueckte vor, und der naechste Lauf eine Stunde spaeter scheiterte an derselben
// Serie. Sichtbar war das nur im Serverlog.
// --------------------------------------------------------------------------
async function serienGruppe(name) {
  const owner = { id: OWNER, role: 'member' };
  const g = await call('POST', '/groups', { actor: owner, body: { name, type: 'household', default_currency: 'EUR' } });
  const gid = g.body.data.id;
  for (const uid of [MGR, MEM]) {
    assert.equal((await call('POST', `/groups/${gid}/members`, { actor: owner, body: { user_id: uid, role: 'guest' } })).status, 201);
  }
  // Alles andere Faellige ruht, damit jeder Fall nur seine eigenen Serien sieht.
  db.prepare('UPDATE recurring_expenses SET paused_at = ? WHERE paused_at IS NULL').run('2026-01-01T00:00:00Z');
  return gid;
}
const serieIn = async (gid, extra) => {
  const r = await call('POST', `/groups/${gid}/recurring`, {
    actor: { id: OWNER, role: 'member' },
    body: { title: 'Strom', amount: '9.00', currency: 'EUR', frequency: 'monthly', next_run_date: '2026-03-10', payer_id: OWNER, participants: [OWNER, MGR, MEM], ...extra },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
};
const serienStand = (id) => db.prepare('SELECT next_run_date, paused_at FROM recurring_expenses WHERE id = ?').get(id);
const gebucht = (id) => db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE recurring_rule_id = ?').get(id).n;
const autoPausen = (id) => db.prepare("SELECT actor_id, metadata FROM expense_activity WHERE type = 'recurring_auto_paused' AND entity_type = 'recurring_expense' AND entity_id = ?").all(id)
  .map((row) => ({ actor_id: row.actor_id, ...JSON.parse(row.metadata) }));
const { processDueRecurringExpenses: serienLauf } = await import('../server/services/split-expenses-scheduler.js');

test('Buchungslauf: eine unbuchbare Bestandsserie pausiert sich, die gesunde daneben wird gebucht', async () => {
  const gid = await serienGruppe('Lauf-Bestand');
  // Bestand von vor der Pruefung beim Anlegen: die Route nimmt so etwas nicht
  // mehr an, also liegt die Zeile so in der Tabelle, wie der alte POST sie schrieb.
  const kaputt = await serieIn(gid, { title: 'Kaputt', next_run_date: '2026-03-01' });
  db.prepare("UPDATE recurring_expenses SET split_method = 'exact', split_snapshot = ? WHERE id = ?")
    .run(JSON.stringify({ participants: [OWNER, MGR], splits: [{ user_id: OWNER, amount: '1.00' }] }), kaputt);
  const keinJson = await serieIn(gid, { title: 'Kein JSON', next_run_date: '2026-03-02' });
  db.prepare("UPDATE recurring_expenses SET split_snapshot = '{participants' WHERE id = ?").run(keinJson);
  const gesund = await serieIn(gid, { title: 'Gesund' });

  let ergebnis;
  assert.doesNotThrow(() => { ergebnis = serienLauf('2026-03-10'); });
  assert.deepEqual(ergebnis, { generated: 1, paused: 2, failed: 0 });
  assert.equal(gebucht(gesund), 1);
  assert.equal(serienStand(gesund).next_run_date, '2026-04-10');
  assert.equal(serienStand(gesund).paused_at, null);
  for (const [id, title] of [[kaputt, 'Kaputt'], [keinJson, 'Kein JSON']]) {
    assert.equal(gebucht(id), 0, title);
    assert.ok(serienStand(id).paused_at, `${title} ist pausiert`);
    assert.deepEqual(autoPausen(id), [{ actor_id: null, title, reason: 'split_invalid' }], title);
  }
  assert.equal(serienStand(kaputt).next_run_date, '2026-03-01', 'der Termin einer pausierten Serie bleibt stehen');

  // Der Grund steht im Verlauf der Gruppe, den die App zeigt.
  const verlauf = await call('GET', `/groups/${gid}/activity`, { actor: { id: OWNER, role: 'member' } });
  assert.equal(verlauf.body.data.filter((a) => a.type === 'recurring_auto_paused').length, 2);

  // Zweiter Lauf: nichts mehr faellig ausser nichts - er wirft nicht und schreibt keinen zweiten Eintrag.
  assert.deepEqual(serienLauf('2026-03-10'), { generated: 0, paused: 0, failed: 0 });
  assert.equal(autoPausen(kaputt).length, 1);
});

test('Buchungslauf: wer die Gruppe verlassen hat, wird nicht mehr gebucht - die Serie pausiert', async () => {
  const gid = await serienGruppe('Lauf-Austritt');
  const beteiligt = await serieIn(gid, { title: 'Beteiligter geht' });
  const zahlt = await serieIn(gid, { title: 'Zahler geht', payer_id: MGR, participants: [OWNER, MEM] });
  const bleibt = await serieIn(gid, { title: 'Bleibt', participants: [OWNER, MEM] });
  assert.equal((await call('DELETE', `/groups/${gid}/members/${MGR}`, { actor: { id: OWNER, role: 'member' } })).status, 200);
  const ledgerVorher = db.prepare('SELECT COUNT(*) AS n FROM expense_ledger_entries WHERE group_id = ?').get(gid).n;

  assert.deepEqual(serienLauf('2026-03-10'), { generated: 1, paused: 2, failed: 0 });
  assert.equal(gebucht(bleibt), 1);
  for (const [id, title] of [[beteiligt, 'Beteiligter geht'], [zahlt, 'Zahler geht']]) {
    assert.equal(gebucht(id), 0, title);
    assert.ok(serienStand(id).paused_at, title);
    assert.deepEqual(autoPausen(id), [{ actor_id: null, title, reason: 'not_a_member' }], title);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_ledger_entries WHERE group_id = ? AND user_id = ?').get(gid, MGR).n, 0, 'keine Ledger-Zeile fuer die ausgetretene Person');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_ledger_entries WHERE group_id = ?').get(gid).n, ledgerVorher + 3, 'nur die gesunde Serie hat gebucht');

  // Wieder aufgenommen und fortgesetzt, bucht die Serie wieder.
  assert.equal((await call('POST', `/groups/${gid}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: MGR, role: 'guest' } })).status, 201);
  // `missed: 'book'`: der Termin vom 10.03. liegt fuer die echte Uhr in der
  // Vergangenheit, und ohne die Angabe ueberspringt Fortsetzen ihn (#1647).
  assert.equal((await call('POST', `/recurring/${beteiligt}/pause`, { actor: { id: OWNER, role: 'member' }, body: { missed: 'book' } })).body.data.paused_at, null);
  assert.deepEqual(serienLauf('2026-03-10'), { generated: 1, paused: 0, failed: 0 });
  assert.equal(gebucht(beteiligt), 1);
});

test('Buchungslauf: das Konto eines Beteiligten ist geloescht - die Serie pausiert, die andere bucht', async () => {
  const gid = await serienGruppe('Lauf-Konto');
  const weg = mkUser('gleichweg');
  assert.equal((await call('POST', `/groups/${gid}/members`, { actor: { id: OWNER, role: 'member' }, body: { user_id: weg, role: 'guest' } })).status, 201);
  const mitIhm = await serieIn(gid, { title: 'Mit geloeschtem Konto', participants: [OWNER, weg] });
  const ohneIhn = await serieIn(gid, { title: 'Ohne', participants: [OWNER, MEM] });
  db.prepare('DELETE FROM users WHERE id = ?').run(weg);

  assert.deepEqual(serienLauf('2026-03-10'), { generated: 1, paused: 1, failed: 0 });
  assert.equal(gebucht(ohneIhn), 1);
  assert.equal(gebucht(mitIhm), 0);
  assert.ok(serienStand(mitIhm).paused_at);
  assert.deepEqual(autoPausen(mitIhm), [{ actor_id: null, title: 'Mit geloeschtem Konto', reason: 'not_a_member' }]);
});

// Die Gegenrichtung: pausiert wird nur, was die SERIE unbuchbar macht. Ein
// Fehler im Code ist keiner davon - er darf nicht als "Serie kaputt" enden und
// damit eine gesunde Serie still abschalten.
test('Buchungslauf: ein Programmierfehler pausiert keine Serie und haelt die naechste nicht auf', async () => {
  const gid = await serienGruppe('Lauf-Codefehler');
  const trifft = await serieIn(gid, { title: 'Trifft den Fehler', next_run_date: '2026-03-01' });
  const danach = await serieIn(gid, { title: 'Danach' });
  const { generateRecurringExpense } = await import('../server/services/split-expenses-scheduler.js');
  const mitFehler = (database, recurring) => {
    if (recurring.id === trifft) return undefined.nichtDa;
    return generateRecurringExpense(database, recurring);
  };

  assert.deepEqual(serienLauf('2026-03-10', mitFehler), { generated: 1, paused: 0, failed: 1 });
  assert.equal(gebucht(danach), 1);
  assert.equal(gebucht(trifft), 0);
  assert.deepEqual(serienStand(trifft), { next_run_date: '2026-03-01', paused_at: null }, 'unpausiert, Termin unveraendert');
  assert.deepEqual(autoPausen(trifft), []);
  // Ohne den Fehler holt der naechste Lauf sie nach.
  assert.deepEqual(serienLauf('2026-03-10'), { generated: 1, paused: 0, failed: 0 });
  assert.equal(gebucht(trifft), 1);
});

// --------------------------------------------------------------------------
// Fortsetzen ueberspringt versaeumte Termine (#1647). Bis hierher loeschte der
// Umschalter nur `paused_at`; `next_run_date` blieb stehen, und der stuendliche
// Lauf buchte je Lauf einen versaeumten Termin mit Originaldatum nach.
//
// Die Uhr steht je Fall fest (nur `Date`, Timer laufen echt weiter, sonst
// haengt fetch), und die Zone des Haushalts ist gesetzt statt geerbt: "heute"
// der Route und "heute" des Laufs kommen beide aus `todayKey(db)`.
// --------------------------------------------------------------------------
const { nextRunNotBefore } = await import('../server/services/split-expenses-scheduler.js');
const { todayKey: haushaltsTag } = await import('../server/utils/timezone.js');
const setzeZone = (zone) => db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(zone);
async function zurZeit(t, iso, zone, fn) {
  const vorher = db.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value;
  setzeZone(zone);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    t.mock.timers.reset();
    if (vorher) setzeZone(vorher);
    else db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
}
const pausiert = async (gid, extra) => {
  const id = await serieIn(gid, extra);
  assert.ok((await call('POST', `/recurring/${id}/pause`, { actor: { id: OWNER, role: 'member' } })).body.data.paused_at, 'pausiert');
  return id;
};
const setzeFort = (id, body) => call('POST', `/recurring/${id}/pause`, { actor: { id: OWNER, role: 'member' }, body });
const fortgesetzt = (id) => db.prepare("SELECT metadata FROM expense_activity WHERE type = 'recurring_resumed' AND entity_id = ? ORDER BY id").all(id).map((r) => JSON.parse(r.metadata));
// Der Lauf, wie der Scheduler ihn faehrt: ohne Argument, "heute" aus der Zone.
const stuendlich = (mal) => { let n = 0; for (let i = 0; i < mal; i += 1) n += serienLauf().generated; return n; };

test('Fortsetzen: sechs versaeumte Monate werden uebersprungen, kein Lauf bucht die Vergangenheit', async (t) => {
  const gid = await serienGruppe('Fortsetzen-Sechs');
  // Faellig am 10. jedes Monats, pausiert seit Maerz, "heute" ist der 20.08.
  const id = await pausiert(gid, { next_run_date: '2026-03-10' });
  await zurZeit(t, '2026-08-20T10:00:00Z', 'Europe/Berlin', async () => {
    const r = await setzeFort(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paused_at, null);
    assert.equal(r.body.data.next_run_date, '2026-09-10', 'naechster Termin im Raster, nicht vergangen');
    assert.ok(r.body.data.next_run_date >= haushaltsTag(db));
    assert.equal(stuendlich(8), 0, 'acht Laeufe buchen nichts fuer die Vergangenheit');
    assert.equal(gebucht(id), 0);
    assert.deepEqual(serienStand(id), { next_run_date: '2026-09-10', paused_at: null });
    // 10.03. bis 10.08. sind sechs Termine.
    assert.deepEqual(fortgesetzt(id), [{ skipped: 6 }]);
  });
  // Am naechsten Termin bucht die Serie wieder, genau einmal und mit diesem Datum.
  await zurZeit(t, '2026-09-10T10:00:00Z', 'Europe/Berlin', async () => {
    assert.equal(stuendlich(3), 1);
    assert.deepEqual(db.prepare('SELECT expense_date FROM expenses WHERE recurring_rule_id = ?').all(id), [{ expense_date: '2026-09-10' }]);
  });
});

test('Fortsetzen mit missed: "book" laesst den Termin stehen, der Lauf holt jeden versaeumten nach', async (t) => {
  const gid = await serienGruppe('Fortsetzen-Book');
  const id = await pausiert(gid, { next_run_date: '2026-03-10' });
  await zurZeit(t, '2026-08-20T10:00:00Z', 'Europe/Berlin', async () => {
    const r = await setzeFort(id, { missed: 'book' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.next_run_date, '2026-03-10');
    assert.deepEqual(fortgesetzt(id), [{}]);
    assert.equal(stuendlich(8), 6, 'je Lauf ein Termin, bis keiner mehr faellig ist');
    assert.deepEqual(
      db.prepare('SELECT expense_date FROM expenses WHERE recurring_rule_id = ? ORDER BY expense_date').all(id).map((e) => e.expense_date),
      ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10'],
    );
    assert.equal(serienStand(id).next_run_date, '2026-09-10');
  });
});

test('Fortsetzen mit missed: "skip" ist die Vorgabe beim Namen genannt', async (t) => {
  const gid = await serienGruppe('Fortsetzen-Skip');
  const id = await pausiert(gid, { next_run_date: '2026-03-10' });
  await zurZeit(t, '2026-08-20T10:00:00Z', 'Europe/Berlin', async () => {
    assert.equal((await setzeFort(id, { missed: 'skip' })).body.data.next_run_date, '2026-09-10');
  });
});

test('Fortsetzen: ist nichts versaeumt, bleibt der Termin, und ein Termin von heute wird gebucht', async (t) => {
  const gid = await serienGruppe('Fortsetzen-Nichts');
  const kuenftig = await pausiert(gid, { title: 'Kuenftig', next_run_date: '2026-09-10' });
  const heute = await pausiert(gid, { title: 'Heute', next_run_date: '2026-08-20' });
  await zurZeit(t, '2026-08-20T10:00:00Z', 'Europe/Berlin', async () => {
    assert.equal((await setzeFort(kuenftig)).body.data.next_run_date, '2026-09-10');
    assert.equal((await setzeFort(heute)).body.data.next_run_date, '2026-08-20');
    assert.deepEqual(fortgesetzt(kuenftig), [{}]);
    assert.deepEqual(fortgesetzt(heute), [{}]);
    // Der heutige Termin ist faellig, nicht versaeumt.
    assert.equal(stuendlich(2), 1);
    assert.equal(gebucht(heute), 1);
    assert.equal(gebucht(kuenftig), 0);
  });
});

// Das Raster einer Serie ist das, was der LAUF gebucht haette. Eine Monatsserie
// am 31. klemmt in kuerzeren Monaten aufs Monatsende und kehrt auf ihren
// Ankertag zurueck (#1721: 31.01. -> 28.02. -> 31.03.; vorher lief sie auf den
// 03.03. ueber und blieb dort). Gemessen wird gegen den Lauf selbst statt gegen
// eine zweite Rechnung: eine Zwillingsserie, nie pausiert, Tag fuer Tag
// gebucht - wo sie am Ende steht, muss die fortgesetzte auch stehen. Wo das
// Raster selbst liegt, haelt test:split-recurring-anchor.
test('Fortsetzen: eine Monatsserie am 31. landet dort, wo der Lauf sie hingezaehlt haette', async (t) => {
  for (const [frequency, start, jetzt] of [
    ['monthly', '2026-01-31', '2026-08-20T10:00:00Z'],
    ['monthly', '2025-10-31', '2026-08-20T10:00:00Z'],
    ['monthly', '2026-03-10', '2026-08-10T10:00:00Z'],
    ['weekly', '2026-02-27', '2026-08-20T10:00:00Z'],
    ['yearly', '2020-02-29', '2026-08-20T10:00:00Z'],
  ]) {
    const gid = await serienGruppe(`Fortsetzen-Raster-${frequency}-${start}`);
    const zwilling = await serieIn(gid, { title: 'Zwilling', frequency, next_run_date: start });
    const id = await pausiert(gid, { title: 'Pausiert', frequency, next_run_date: start });
    await zurZeit(t, jetzt, 'Europe/Berlin', async () => {
      const gestern = new Date(Date.parse(`${haushaltsTag(db)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      // Der Zwilling bucht alles bis gestern; sein naechster Termin ist der
      // erste, der nicht vergangen ist.
      let runden = 0;
      while (serienLauf(gestern).generated) runden += 1;
      const r = await setzeFort(id);
      assert.equal(r.body.data.next_run_date, serienStand(zwilling).next_run_date, `${frequency} ab ${start}`);
      assert.ok(r.body.data.next_run_date >= haushaltsTag(db), `${frequency} ab ${start}: nicht vergangen`);
      assert.deepEqual(fortgesetzt(id), [runden ? { skipped: runden } : {}], `${frequency} ab ${start}: Zahl der Termine`);
      assert.equal(gebucht(id), 0);
    });
  }
  // Festgehalten, damit sichtbar bleibt, WAS das Raster am 31. ist.
  assert.deepEqual(nextRunNotBefore('2026-01-31', 'monthly', '2026-08-20', 31), { date: '2026-08-31', skipped: 7 });
  // Ohne Anker klemmt die Serie und bleibt am 28. - kein Monat faellt aus.
  assert.deepEqual(nextRunNotBefore('2026-01-31', 'monthly', '2026-08-20'), { date: '2026-08-28', skipped: 7 });
});

// "Heute" ist der Tag des Haushalts. Beide Faelle liegen so, dass der UTC-Tag
// die andere Antwort gaebe: einmal ist der Haushalt noch am Vortag (Termin von
// heute bleibt und wird gebucht), einmal schon am Folgetag (Termin ist vorbei).
test('Fortsetzen misst am Tag des Haushalts, nicht am UTC-Tag', async (t) => {
  const gid = await serienGruppe('Fortsetzen-Zone');
  const west = await pausiert(gid, { title: 'West', next_run_date: '2026-03-15' });
  const ost = await pausiert(gid, { title: 'Ost', next_run_date: '2026-03-15' });
  // 16.07. 03:00 UTC ist in Los Angeles der 15.07., 20:00: der Termin ist heute.
  await zurZeit(t, '2026-07-16T03:00:00Z', 'America/Los_Angeles', async () => {
    assert.equal(haushaltsTag(db), '2026-07-15');
    assert.equal((await setzeFort(west)).body.data.next_run_date, '2026-07-15');
    assert.deepEqual(fortgesetzt(west), [{ skipped: 4 }]);
    assert.equal(stuendlich(2), 1);
    assert.deepEqual(db.prepare('SELECT expense_date FROM expenses WHERE recurring_rule_id = ?').all(west), [{ expense_date: '2026-07-15' }]);
  });
  db.prepare('UPDATE recurring_expenses SET paused_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', west);
  // 15.07. 20:00 UTC ist auf Kiritimati der 16.07., 10:00: der Termin ist vorbei.
  await zurZeit(t, '2026-07-15T20:00:00Z', 'Pacific/Kiritimati', async () => {
    assert.equal(haushaltsTag(db), '2026-07-16');
    assert.equal((await setzeFort(ost)).body.data.next_run_date, '2026-08-15');
    assert.deepEqual(fortgesetzt(ost), [{ skipped: 5 }]);
    assert.equal(stuendlich(2), 0);
    assert.equal(gebucht(ost), 0);
  });
});

test('Fortsetzen: unbekannter Wert fuer missed -> 400 mit reason, nichts aendert sich', async (t) => {
  const gid = await serienGruppe('Fortsetzen-400');
  const id = await pausiert(gid, { next_run_date: '2026-03-10' });
  const vorher = serienStand(id);
  await zurZeit(t, '2026-08-20T10:00:00Z', 'Europe/Berlin', async () => {
    for (const missed of ['all', '', 0, true, ['book'], { book: 1 }, 'BOOK']) {
      const r = await setzeFort(id, { missed });
      assert.equal(r.status, 400, JSON.stringify(missed));
      assert.deepEqual(r.body, { error: 'missed must be "skip" or "book".', code: 400, reason: 'invalid_missed' });
    }
    assert.deepEqual(serienStand(id), vorher, 'weiter pausiert, Termin unveraendert');
    assert.deepEqual(fortgesetzt(id), []);
    // `null` ist "keine Angabe", wie ein fehlendes Feld.
    assert.equal((await setzeFort(id, { missed: null })).body.data.next_run_date, '2026-09-10');
    // Die Serie laeuft jetzt wieder, der naechste Aufruf wuerde pausieren. Der
    // Wert wird bei JEDEM Aufruf geprueft, nicht nur beim Fortsetzen: ein
    // Umschalter weiss nicht, was der Aufrufer meinte, und eine Eingabe, die
    // beim Fortsetzen abgelehnt wird, soll beim Pausieren nicht still durchgehen.
    const laufend = serienStand(id);
    const r = await setzeFort(id, { missed: 'all' });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'invalid_missed');
    assert.deepEqual(serienStand(id), laufend, 'nicht pausiert');
  });
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
