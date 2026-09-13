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
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', splitRouter);
const server = app.listen(0);
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
// Geld: Delete räumt Ledger auf
// --------------------------------------------------------------------------
test('Delete der Ausgabe entfernt ihre Ledger-Einträge (Rest = nur Settlement)', async () => {
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

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
