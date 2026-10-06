/**
 * Test: Ankertag einer wiederkehrenden geteilten Ausgabe (#1721)
 *
 * Zweck: Eine Monatsserie am 29., 30. oder 31. lief im ersten kuerzeren Monat
 *        in den Folgemonat ueber (31.01. -> 03.03.), liess damit einen Monat
 *        ohne Buchung und blieb danach fuer immer am 1., 2. oder 3. Die Serie
 *        merkt sich jetzt den Tag, fuer den sie gedacht ist (`anchor_day`):
 *        Monats- und Jahresschritte klemmen aufs Monatsende und heben den Tag
 *        wieder auf den Anker, sobald der Monat ihn hat (31 -> 28/29 -> 31).
 *
 *        Gemessen wird dort, wo es bucht, nicht nur an der Hilfsfunktion:
 *          - der BUCHUNGSLAUF selbst, ueber eine per Route angelegte Serie:
 *            jeder Monat genau eine Buchung, am Ankertag oder Monatsletzten;
 *          - `nextRunNotBefore()` (das Fortsetzen) zaehlt mit derselben
 *            Rechnung, und die Route reicht den Anker auch wirklich durch;
 *          - Migration 234 gegen eine Bestands-DB auf Stand 233: belegt
 *            gedriftete Serien kehren zurueck, alles Unbelegte bleibt stehen.
 *
 * DIE ERWARTUNG WIRD GESPRUNGEN, DER CODE ZAEHLT. Die Solltermine unten
 * stehen als "Starttag + n Monate, geklemmt" da, der Lauf rueckt Termin fuer
 * Termin vor. Zwei Rechnungen, die dasselbe liefern muessen - eine Kopie der
 * Schrittfunktion im Test maesse nur sich selbst.
 *
 * KEINE UHR: der Lauf bekommt seinen Tag als Argument, und wo "heute" aus der
 * Zone kommt (Fortsetzen, Migration), stehen Uhr UND Haushaltszone fest.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-split-recurring-anchor.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';

const dbmod = await import('../server/db.js');
const { default: splitRouter } = await import('../server/routes/split-expenses.js');
const { nextRunNotBefore, processDueRecurringExpenses } = await import('../server/services/split-expenses-scheduler.js');
const { MIGRATIONS, migrate } = dbmod;
const db = dbmod.get();

const mkUser = (database, username) => database.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
).run(username, username.toUpperCase()).lastInsertRowid;
const OWNER = mkUser(db, 'owner');
const MEM = mkUser(db, 'mem');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = OWNER;
  req.authRole = 'member';
  req.session = { userId: OWNER, role: 'member' };
  req.sessionModuleAccess = null;
  req.authScopes = null;
  next();
});
app.use('/', splitRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

// Eine Gruppe je Fall; alles andere Faellige ruht, damit der Lauf nur die
// Serie dieses Falls bucht.
async function gruppe(name) {
  const g = await call('POST', '/groups', { name, type: 'household', default_currency: 'EUR' });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.data.id;
  assert.equal((await call('POST', `/groups/${gid}/members`, { user_id: MEM, role: 'guest' })).status, 201);
  db.prepare('UPDATE recurring_expenses SET paused_at = ? WHERE paused_at IS NULL').run('2020-01-01T00:00:00Z');
  return gid;
}
async function serie(gid, extra) {
  const r = await call('POST', `/groups/${gid}/recurring`, {
    title: 'Miete', amount: '900.00', currency: 'EUR', frequency: 'monthly', payer_id: OWNER, participants: [OWNER, MEM], ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
const stand = (id) => db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id);
const buchungen = (id) => db.prepare('SELECT expense_date FROM expenses WHERE recurring_rule_id = ? ORDER BY id').all(id).map((r) => r.expense_date);

// Der Lauf, so oft bis `anzahl` Termine gebucht sind. `bis` liegt hinter allen
// Sollterminen: der Lauf bucht je Aufruf einen Termin der Serie, mit dem
// Termin als Datum, und stellt weiter.
function laufe(id, anzahl, bis) {
  for (let i = 0; i < anzahl; i += 1) {
    assert.deepEqual(processDueRecurringExpenses(bis), { generated: 1, paused: 0, failed: 0 }, `Lauf ${i + 1}`);
  }
  db.prepare("UPDATE recurring_expenses SET paused_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(id);
  return buchungen(id);
}

// Die Sollrechnung, GESPRUNGEN: Starttag + n Monate, der Tag der Starttag oder
// der Monatsletzte. Haengt nie am Vortermin.
const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const letzter = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function monatsSoll(start, anzahl) {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: anzahl }, (_, n) => {
    const yy = y + Math.floor((m - 1 + n) / 12);
    const mm = ((m - 1 + n) % 12) + 1;
    return key(yy, mm, Math.min(d, letzter(yy, mm)));
  });
}
const tagDanach = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// --------------------------------------------------------------------------
// Vorbedingung: die Sollrechnung selbst. Laege sie daneben, waere alles
// darunter gegen eine falsche Erwartung gruen.
// --------------------------------------------------------------------------
test('Vorbedingung: die Sollrechnung klemmt und kehrt zurueck', () => {
  assert.deepEqual(monatsSoll('2026-01-31', 5), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(monatsSoll('2028-01-30', 3), ['2028-01-30', '2028-02-29', '2028-03-30']);
  assert.deepEqual(monatsSoll('2026-11-29', 4), ['2026-11-29', '2026-12-29', '2027-01-29', '2027-02-28']);
});

// --------------------------------------------------------------------------
// Der Buchungslauf: dreizehn Buchungen sind der Starttermin und zwoelf
// Monatsschritte. Gemeinjahr 2026 und Schaltjahr 2028, dazu ein Start im Maerz
// (der April ist der erste kurze Monat) und einer ueber den Jahreswechsel.
// --------------------------------------------------------------------------
for (const start of [
  '2026-01-29', '2026-01-30', '2026-01-31',
  '2028-01-29', '2028-01-30', '2028-01-31',
  '2026-03-31', '2026-11-30',
]) {
  test(`Lauf: Monatsserie ab ${start} bucht jeden Monat genau einmal, am Ankertag oder Monatsletzten`, async () => {
    const gid = await gruppe(`Lauf-${start}`);
    const angelegt = await serie(gid, { next_run_date: start });
    const ankertag = Number(start.slice(8));

    // Die Termine zuerst: sie sind die Aussage. Der Anker danach - er ist das
    // Mittel, und stuende er vorn, fiele der Fall schon an der fehlenden
    // Spalte, bevor ein einziges Datum verglichen ist.
    const soll = monatsSoll(start, 14);
    const gebucht = laufe(angelegt.id, 13, soll[13]);
    assert.deepEqual(gebucht, soll.slice(0, 13));
    // Jeder Monat genau einmal - als eigene Aussage, nicht nur ueber die Liste.
    assert.equal(new Set(gebucht.map((d) => d.slice(0, 7))).size, 13, 'kein Monat doppelt, keiner ausgelassen');
    assert.equal(stand(angelegt.id).next_run_date, soll[13], 'der naechste Termin steht im Raster');

    assert.equal(angelegt.anchor_day, ankertag, 'die Antwort nennt den Ankertag');
    assert.equal(stand(angelegt.id).anchor_day, ankertag, 'der Ankertag steht in der Zeile, der Lauf laesst ihn stehen');
  });
}

test('Lauf: Jahresserie ab 29.02. bucht am 28.02. und im Schaltjahr wieder am 29.02.', async () => {
  const gid = await gruppe('Lauf-jaehrlich');
  const angelegt = await serie(gid, { frequency: 'yearly', next_run_date: '2028-02-29' });
  assert.deepEqual(
    laufe(angelegt.id, 5, '2033-01-01'),
    ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'],
  );
  assert.equal(stand(angelegt.id).next_run_date, '2033-02-28');
  assert.equal(angelegt.anchor_day, 29);
});

test('Lauf: eine Jahresserie am 31.03. bleibt, wo sie ist', async () => {
  const gid = await gruppe('Lauf-jaehrlich-31');
  const angelegt = await serie(gid, { frequency: 'yearly', next_run_date: '2027-03-31' });
  assert.deepEqual(laufe(angelegt.id, 3, '2030-01-01'), ['2027-03-31', '2028-03-31', '2029-03-31']);
});

test('Lauf: woechentlich bleibt sieben Tage, der Anker hebt dort nichts', async () => {
  const gid = await gruppe('Lauf-woechentlich');
  const angelegt = await serie(gid, { frequency: 'weekly', next_run_date: '2026-01-31' });
  assert.deepEqual(
    laufe(angelegt.id, 6, '2026-12-31'),
    ['2026-01-31', '2026-02-07', '2026-02-14', '2026-02-21', '2026-02-28', '2026-03-07'],
  );
});

// Eine Zeile ohne Anker gibt es nach der Migration nicht mehr, aber die Spalte
// laesst NULL zu (ADD COLUMN). Ohne Anker klemmt der Schritt und hebt nicht -
// kein uebersprungener Monat, kein Wurf.
test('Lauf: ohne Anker klemmt der Schritt, ohne einen Monat auszulassen', async () => {
  const gid = await gruppe('Lauf-ohne-Anker');
  const angelegt = await serie(gid, { next_run_date: '2026-01-31' });
  db.prepare('UPDATE recurring_expenses SET anchor_day = NULL WHERE id = ?').run(angelegt.id);
  assert.deepEqual(laufe(angelegt.id, 4, '2026-12-31'), ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28']);
});

// Ein Termin in Datumsform, der kein Datum ist. Die Route laesst ihn nicht
// herein, aber eine Zeile aus einem Import oder von Hand kann ihn tragen. Vor
// #1721 las der Schritt ihn wie `new Date()` es tut (31.02. = 03.03.) und
// rueckte weiter; ein Schritt, der daran wirft, liesse den Lauf an dieser Serie
// stuendlich scheitern, ohne sie je zu pausieren.
test('Lauf: ein Termin wie 2026-02-31 wird gebucht und rueckt weiter, statt stuendlich zu scheitern', async () => {
  const gid = await gruppe('Lauf-kaputtes-Datum');
  const angelegt = await serie(gid, { next_run_date: '2026-01-31' });
  db.prepare("UPDATE recurring_expenses SET next_run_date = '2026-02-31' WHERE id = ?").run(angelegt.id);
  assert.deepEqual(processDueRecurringExpenses('2026-03-05'), { generated: 1, paused: 0, failed: 0 });
  assert.equal(stand(angelegt.id).next_run_date, '2026-04-30', 'vom 03.03. aus einen Monat weiter, auf den Anker gehoben');
  assert.deepEqual(processDueRecurringExpenses('2026-03-05'), { generated: 0, paused: 0, failed: 0 });
  // Dasselbe durch das Fortsetzen: gezaehlt, nicht stehen geblieben.
  assert.deepEqual(nextRunNotBefore('2026-02-31', 'monthly', '2026-05-15', 31), { date: '2026-05-31', skipped: 2 });
  assert.deepEqual(nextRunNotBefore('2026-02-31', 'weekly', '2026-03-05'), { date: '2026-03-10', skipped: 1 });
});

// --------------------------------------------------------------------------
// nextRunNotBefore(): dieselbe Rechnung wie der Lauf. Ein Schritt ist "der
// erste Termin, der nicht vor dem Tag nach dem Termin liegt".
// --------------------------------------------------------------------------
for (const start of ['2026-01-29', '2026-01-30', '2026-01-31', '2028-01-29', '2028-01-30', '2028-01-31']) {
  test(`nextRunNotBefore: zwoelf Monatsschritte ab ${start} liegen im Raster`, () => {
    const anker = Number(start.slice(8));
    const soll = monatsSoll(start, 13);
    const termine = [start];
    for (let i = 0; i < 12; i += 1) {
      const schritt = nextRunNotBefore(termine.at(-1), 'monthly', tagDanach(termine.at(-1)), anker);
      assert.equal(schritt.skipped, 1);
      termine.push(schritt.date);
    }
    assert.deepEqual(termine, soll);
    // Und in einem Zug ueber alle zwoelf: gezaehlt landet es am selben Tag.
    assert.deepEqual(nextRunNotBefore(start, 'monthly', soll[12], anker), { date: soll[12], skipped: 12 });
  });
}

test('nextRunNotBefore: Jahresserie ab 29.02. und eine Pause ueber kurze Monate', () => {
  assert.deepEqual(nextRunNotBefore('2028-02-29', 'yearly', '2029-01-01', 29), { date: '2029-02-28', skipped: 1 });
  assert.deepEqual(nextRunNotBefore('2028-02-29', 'yearly', '2032-01-01', 29), { date: '2032-02-29', skipped: 4 });
  assert.deepEqual(nextRunNotBefore('2026-01-31', 'monthly', '2026-08-20', 31), { date: '2026-08-31', skipped: 7 });
  assert.deepEqual(nextRunNotBefore('2026-01-31', 'weekly', '2026-02-20', 31), { date: '2026-02-21', skipped: 3 });
});

// Das Fortsetzen durch die ROUTE: sie muss den Anker der Zeile durchreichen.
// Eine Hilfsfunktion, die ihn kennt, hilft nichts, wenn der Aufrufer ihn
// weglaesst - dann klemmte die Serie nach der Pause am 28. fest.
test('Fortsetzen (Route): eine Serie am 31. kommt nach der Pause am Monatsletzten an und danach wieder am 31.', async (t) => {
  const gid = await gruppe('Fortsetzen-Anker');
  const angelegt = await serie(gid, { next_run_date: '2026-01-31' });
  assert.ok((await call('POST', `/recurring/${angelegt.id}/pause`)).body.data.paused_at, 'pausiert');

  const vorher = db.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value;
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  // Nur `Date`: Timer laufen echt weiter, sonst haengt fetch.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-15T10:00:00Z') });
  try {
    const r = await call('POST', `/recurring/${angelegt.id}/pause`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.next_run_date, '2026-06-30');
    assert.equal(r.body.data.anchor_day, 31, 'das Fortsetzen setzt kein Datum, der Anker bleibt');
  } finally {
    t.mock.timers.reset();
    if (vorher) db.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(vorher);
    else db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
  assert.deepEqual(laufe(angelegt.id, 3, '2026-12-31'), ['2026-06-30', '2026-07-31', '2026-08-31']);
});

// --------------------------------------------------------------------------
// Migration 234 gegen den Bestand.
//
// Die Fixture faehrt den ECHTEN Runner bis 233, saet Serien und ihre gebuchten
// Ausgaben, und faehrt dann den Rest. "Heute" der Migration steht fest: Uhr
// und Haushaltszone der Fixture-DB.
// --------------------------------------------------------------------------
const ANCHOR_MIGRATION = MIGRATIONS.find((m) => m.version === 234);

function bestand(zone = 'Europe/Berlin') {
  const old = new Database(join(tempDir('yuvomi-split-anchor-'), 'db.sqlite'));
  old.pragma('journal_mode = WAL');
  old.pragma('foreign_keys = ON');
  migrate(old, MIGRATIONS.filter((m) => m.version <= 233));
  assert.equal(old.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 233, 'die Fixture steht auf 233');
  const user = mkUser(old, 'owner');
  const group = old.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES ('WG', 'household', 'EUR', ?)").run(user).lastInsertRowid;
  old.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(zone);
  const addSerie = (title, frequency, nextRunDate, gebucht = [], { pausedAt = null } = {}) => {
    const id = old.prepare(`
      INSERT INTO recurring_expenses (group_id, title, amount_minor, currency, payer_id, split_snapshot, frequency, next_run_date, paused_at, created_by)
      VALUES (?, ?, 90000, 'EUR', ?, '{}', ?, ?, ?, ?)
    `).run(group, title, user, frequency, nextRunDate, pausedAt, user).lastInsertRowid;
    for (const eintrag of gebucht) {
      // `edited`: die Spur, die eine Bearbeitung hinterlaesst - 'activity' (der
      // Verlaufseintrag, den PUT /expenses/:id schreibt), 'updated' (der
      // updated_at-Trigger) oder 'both', wie die App es tut.
      const { date, deleted = false, edited = null } = typeof eintrag === 'string' ? { date: eintrag } : eintrag;
      const created = '2026-01-01T08:00:00Z';
      const updated = edited === 'updated' || edited === 'both' ? '2026-01-05T09:00:00Z' : created;
      const expenseId = old.prepare(`
        INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, expense_date, recurring_rule_id, status, deleted_at, created_by, created_at, updated_at)
        VALUES (?, ?, 90000, 'EUR', 90000, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(group, title, user, date, id, deleted ? 'deleted' : 'active', deleted ? '2026-02-01T00:00:00Z' : null, user, created, updated).lastInsertRowid;
      // Jede Buchung traegt den Eintrag des Laufs; er ist KEINE Bearbeitung.
      old.prepare("INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata) VALUES (?, ?, 'recurring_generated', 'expense', ?, '{}')").run(group, user, expenseId);
      if (edited === 'activity' || edited === 'both') {
        old.prepare("INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata) VALUES (?, ?, 'expense_edited', 'expense', ?, '{}')").run(group, user, expenseId);
      }
    }
    return id;
  };
  const lies = (id) => old.prepare('SELECT next_run_date, anchor_day FROM recurring_expenses WHERE id = ?').get(id);
  return { old, addSerie, lies };
}

// Die Migration "heute" fahren: nur `Date` steht, wie oben.
function migriere(t, old, iso) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    migrate(old, MIGRATIONS.filter((m) => m.version <= 234));
  } finally {
    t.mock.timers.reset();
  }
}

// Was der echte Lauf bis zum 06.10.2026 aus einer Serie ab `start` gemacht hat:
// der Ueberlauf von damals, hier nachgerechnet, damit die Fixture ein typischer
// Datensatz ist und kein zurechtgelegter Randfall.
function gedriftet(start, bisVor) {
  const termine = [];
  let date = start;
  while (date < bisVor) {
    termine.push(date);
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    date = d.toISOString().slice(0, 10);
  }
  return { gebucht: termine, next: date };
}

test('Vorbedingung: die Fixture bildet den Fehler von damals nach', () => {
  const { gebucht, next } = gedriftet('2026-01-31', '2026-10-06');
  assert.deepEqual(gebucht.slice(0, 3), ['2026-01-31', '2026-03-03', '2026-04-03']);
  assert.equal(gebucht.at(-1), '2026-10-03');
  assert.equal(next, '2026-11-03');
});

// Bewusst kein "steht am Ende der Kette": das waere mit der naechsten Migration
// rot. Die Reihenfolge haelt test:migrations-append-only.
test('Migration 234: legt die Spalte an, jede Serie bekommt den Tag ihres Termins', (t) => {
  assert.ok(ANCHOR_MIGRATION, 'Migration 234 fehlt');
  assert.match(ANCHOR_MIGRATION.description, /#1721/);
  const { old, addSerie, lies } = bestand();
  try {
    const id = addSerie('Strom', 'monthly', '2026-10-15', ['2026-08-15', '2026-09-15']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2026-10-15', anchor_day: 15 });
    assert.throws(() => old.prepare('UPDATE recurring_expenses SET anchor_day = 32 WHERE id = ?').run(id), /CHECK/);
    assert.throws(() => old.prepare('UPDATE recurring_expenses SET anchor_day = 0 WHERE id = ?').run(id), /CHECK/);
  } finally { old.close(); }
});

test('Migration 234 (a): eine belegt gedriftete Monatsserie kehrt auf ihren Tag zurueck, ohne Nachbuchung', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    const d30 = gedriftet('2026-01-30', '2026-10-06');
    const d29 = gedriftet('2026-01-29', '2026-10-06');
    const maerz = gedriftet('2026-03-31', '2026-10-06');
    assert.deepEqual([d31.next, d30.next, d29.next, maerz.next], ['2026-11-03', '2026-11-02', '2026-11-01', '2026-11-01']);
    const am31 = addSerie('Miete 31', 'monthly', d31.next, d31.gebucht);
    const am30 = addSerie('Miete 30', 'monthly', d30.next, d30.gebucht);
    const am29 = addSerie('Miete 29', 'monthly', d29.next, d29.gebucht);
    const abMaerz = addSerie('Miete Maerz', 'monthly', maerz.next, maerz.gebucht);
    // Pausiert und laengst vergangen: der Termin darf nicht dorthin rutschen,
    // wo er sofort faellig waere - er bleibt, der Anker kommt trotzdem.
    const pausiert = addSerie('Pausiert', 'monthly', '2026-06-03', ['2026-01-31', '2026-03-03', '2026-04-03', '2026-05-03'], { pausedAt: '2026-05-10T00:00:00Z' });
    const vorher = old.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;

    migriere(t, old, '2026-10-06T10:00:00Z');

    assert.deepEqual(lies(am31), { next_run_date: '2026-11-30', anchor_day: 31 });
    assert.deepEqual(lies(am30), { next_run_date: '2026-11-30', anchor_day: 30 });
    assert.deepEqual(lies(am29), { next_run_date: '2026-11-29', anchor_day: 29 });
    assert.deepEqual(lies(abMaerz), { next_run_date: '2026-11-30', anchor_day: 31 });
    assert.deepEqual(lies(pausiert), { next_run_date: '2026-06-03', anchor_day: 31 });
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, vorher, 'der ausgelassene Monat wird nicht nachgebucht');

    // Von dort aus weiter, mit der Rechnung des Laufs: 30.11. -> 31.12.
    assert.equal(nextRunNotBefore('2026-11-30', 'monthly', '2026-12-01', lies(am31).anchor_day).date, '2026-12-31');
    // Die pausierte kehrt beim Fortsetzen zurueck.
    assert.equal(nextRunNotBefore('2026-06-03', 'monthly', '2026-10-06', lies(pausiert).anchor_day).date, '2026-10-31');
  } finally { old.close(); }
});

test('Migration 234 (a): der Zielmonat ist der Februar - Monatsende, im Schaltjahr der 29.', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const gemein = gedriftet('2026-01-31', '2027-01-10');
    assert.equal(gemein.next, '2027-02-03');
    const id = addSerie('Miete', 'monthly', gemein.next, gemein.gebucht);
    const schalt = addSerie('Schalt', 'monthly', '2028-02-03', ['2026-01-31', '2026-03-03', '2028-01-03'], { pausedAt: null });
    migriere(t, old, '2027-01-10T10:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2027-02-28', anchor_day: 31 });
    assert.deepEqual(lies(schalt), { next_run_date: '2028-02-29', anchor_day: 31 });
  } finally { old.close(); }
});

test('Migration 234 (b): eine Serie, die wirklich am 2. angelegt wurde, bleibt am 2.', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const amZweiten = addSerie('Am 2.', 'monthly', '2026-11-02', ['2026-08-02', '2026-09-02', '2026-10-02']);
    const nieGebucht = addSerie('Neu am 31.', 'monthly', '2026-10-31');
    const neuAmDritten = addSerie('Neu am 3.', 'monthly', '2026-11-03');
    // Am 29. begonnen, heute am 3.: das ist nicht der Ueberlauf (der 29. landet
    // am 1.), also kein Beleg.
    const passtNicht = addSerie('29 -> 3', 'monthly', '2026-11-03', ['2026-01-29', '2026-10-03']);
    // Woechentlich: Tag des Monats sagt dort nichts.
    const woche = addSerie('Woche', 'weekly', '2026-10-10', ['2026-01-31', '2026-10-03']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(amZweiten), { next_run_date: '2026-11-02', anchor_day: 2 });
    assert.deepEqual(lies(nieGebucht), { next_run_date: '2026-10-31', anchor_day: 31 });
    assert.deepEqual(lies(neuAmDritten), { next_run_date: '2026-11-03', anchor_day: 3 });
    assert.deepEqual(lies(passtNicht), { next_run_date: '2026-11-03', anchor_day: 3 });
    assert.deepEqual(lies(woche), { next_run_date: '2026-10-10', anchor_day: 10 });
  } finally { old.close(); }
});

test('Migration 234 (c): ohne die erste Ausgabe gibt es keinen Beleg und keine Reparatur', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    // Die erste Ausgabe fehlt ganz (aus der Tabelle entfernt) ...
    const entfernt = addSerie('Entfernt', 'monthly', d31.next, d31.gebucht.slice(1));
    // ... oder ist als geloescht markiert, wie die App loescht.
    const geloescht = addSerie('Geloescht', 'monthly', d31.next, [{ date: d31.gebucht[0], deleted: true }, ...d31.gebucht.slice(1)]);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(entfernt), { next_run_date: '2026-11-03', anchor_day: 3 });
    assert.deepEqual(lies(geloescht), { next_run_date: '2026-11-03', anchor_day: 3 });
  } finally { old.close(); }
});

test('Migration 234 (d): gaebe das Zurueckstellen eine zweite Buchung im Monat, bleibt der Termin - nur der Anker kommt', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    // Die letzte gebuchte Ausgabe liegt schon im Monat des naechsten Termins
    // (ihr Datum wurde von Hand verschoben): der November hat seine Buchung.
    const doppelt = addSerie('Doppelt', 'monthly', d31.next, [...d31.gebucht.slice(0, -1), '2026-11-01']);
    // Gegenstueck im selben Lauf, damit sichtbar ist, dass (d) an der letzten
    // Buchung haengt und nicht an der Fixture.
    const frei = addSerie('Frei', 'monthly', d31.next, d31.gebucht);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(doppelt), { next_run_date: '2026-11-03', anchor_day: 31 });
    assert.deepEqual(lies(frei), { next_run_date: '2026-11-30', anchor_day: 31 });
    // Mit dem naechsten Schritt ist auch sie zurueck: 03.11. -> 31.12.
    assert.equal(nextRunNotBefore('2026-11-03', 'monthly', '2026-11-04', lies(doppelt).anchor_day).date, '2026-12-31');
  } finally { old.close(); }
});

// Die Riegel von (d), jeder fuer sich. Ein Gegenstueck je Fall, das NUR im
// genannten Merkmal abweicht und zurueckgestellt wird - sonst hielte der Fall
// auch, wenn die Migration gar nichts taete.
test('Migration 234 (d): auch eine geloeschte Buchung des Monats zaehlt - der Monat hatte seine Buchung', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    const geloescht = addSerie('Geloescht im November', 'monthly', d31.next, [...d31.gebucht, { date: '2026-11-01', deleted: true }]);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(geloescht), { next_run_date: '2026-11-03', anchor_day: 31 });
  } finally { old.close(); }
});

test('Migration 234 (d): eine Buchung NACH dem neuen Termin, in einem anderen Monat, haelt ihn ebenfalls', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    // Von Hand in den Dezember datiert: der neue Termin (30.11.) laege VOR der
    // letzten Buchung der Serie.
    const spaeter = addSerie('Spaeter', 'monthly', d31.next, [...d31.gebucht.slice(0, -1), '2026-12-05']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(spaeter), { next_run_date: '2026-11-03', anchor_day: 31 });
  } finally { old.close(); }
});

// Die ERSTE Ausgabe ist die mit der kleinsten id - die, die der Lauf zuerst
// geschrieben hat - nicht die mit dem aeltesten Datum. Hier ist die erste
// Buchung weg, und eine spaetere wurde auf einen 31. zurueckdatiert: nach
// Datum sortiert saehe das wie ein Beleg aus.
test('Migration 234 (c): die erste Ausgabe ist die mit der kleinsten id, nicht die mit dem aeltesten Datum', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const d31 = gedriftet('2026-01-31', '2026-10-06');
    const id = addSerie('Nach id', 'monthly', d31.next, [...d31.gebucht.slice(1), '2026-01-31']);
    // Die Gegenrichtung: erste nach id am 31., eine spaetere traegt ein
    // aelteres Datum am 3. - der Beleg gilt.
    const beleg = addSerie('Beleg nach id', 'monthly', d31.next, [...d31.gebucht, '2025-12-03']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2026-11-03', anchor_day: 3 });
    assert.deepEqual(lies(beleg), { next_run_date: '2026-11-30', anchor_day: 31 });
  } finally { old.close(); }
});

// --------------------------------------------------------------------------
// Der Beleg muss EINDEUTIG sein. PUT /expenses/:id kann das Datum einer
// Serienbuchung aendern: eine Serie, die wirklich am 01.06. angelegt und deren
// erste Ausgabe auf den 31.05. umdatiert wurde, sieht aus wie eine Drift. Eine
// bearbeitete erste Ausgabe ist deshalb kein Beleg. Zwei Spuren, jede fuer
// sich hinreichend: der Verlaufseintrag `expense_edited` und ein `updated_at`,
// das nicht mehr `created_at` ist.
// --------------------------------------------------------------------------
test('Migration 234: eine bearbeitete erste Ausgabe ist kein Beleg - die Serie bleibt unangetastet', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const rest = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];
    const faelle = Object.fromEntries(['both', 'activity', 'updated'].map((edited) => [
      edited, addSerie(`Am 1. (${edited})`, 'monthly', '2026-11-01', [{ date: '2026-05-31', edited }, ...rest]),
    ]));
    // Derselbe Datensatz ohne Spur einer Bearbeitung: das IST die Drift und
    // wird repariert. Und: eine bearbeitete SPAETERE Ausgabe nimmt der ersten
    // nichts.
    const unbearbeitet = addSerie('Drift', 'monthly', '2026-11-01', ['2026-05-31', ...rest]);
    const spaetereBearbeitet = addSerie('Drift, spaeter bearbeitet', 'monthly', '2026-11-01', ['2026-05-31', { date: '2026-07-01', edited: 'both' }, ...rest.slice(1)]);
    migriere(t, old, '2026-10-06T10:00:00Z');
    for (const [edited, id] of Object.entries(faelle)) {
      assert.deepEqual(lies(id), { next_run_date: '2026-11-01', anchor_day: 1 }, edited);
    }
    assert.deepEqual(lies(unbearbeitet), { next_run_date: '2026-11-30', anchor_day: 31 });
    assert.deepEqual(lies(spaetereBearbeitet), { next_run_date: '2026-11-30', anchor_day: 31 });
  } finally { old.close(); }
});

// --------------------------------------------------------------------------
// Der ausgelassene Monat liegt noch VOR uns. Die Serie hat am 31.10. gebucht,
// der Termin steht am 01.12., und die Migration laeuft am 10.11.: der November
// ist noch zu haben. Dann geht der Termin in den Monat NACH der letzten
// Buchung, nicht in den Monat des gedrifteten Termins - sonst bliebe der
// November ohne Not leer. Kein Nachbuchen: der Termin liegt in der Zukunft.
// --------------------------------------------------------------------------
test('Migration 234: liegt der ausgelassene Monat noch vor uns, bekommt er seinen Termin', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const november = addSerie('Miete', 'monthly', '2026-12-01', ['2026-08-31', '2026-10-01', '2026-10-31']);
    // Der Kandidat liegt am Tag der Migration selbst: heute ist nicht vergangen.
    const heute = addSerie('Heute', 'monthly', '2026-12-02', ['2026-10-30']);
    migriere(t, old, '2026-11-10T10:00:00Z');
    assert.deepEqual(lies(november), { next_run_date: '2026-11-30', anchor_day: 31 });
    assert.deepEqual(lies(heute), { next_run_date: '2026-11-30', anchor_day: 30 });
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 4, 'keine Ausgabe entsteht');
  } finally { old.close(); }
});

test('Migration 234: der ausgelassene Februar liegt noch vor uns', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const id = addSerie('Miete', 'monthly', '2026-03-03', ['2026-01-31']);
    migriere(t, old, '2026-02-10T10:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2026-02-28', anchor_day: 31 });
  } finally { old.close(); }
});

test('Migration 234: ist der ausgelassene Monat schon vorbei, gilt der Monat des gedrifteten Termins', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    // Am 30.11. gemessen ist der Kandidat (30.11.) heute und gilt noch ...
    const amLetzten = addSerie('Am letzten Tag', 'monthly', '2026-12-01', ['2026-10-31']);
    migriere(t, old, '2026-11-30T10:00:00Z');
    assert.deepEqual(lies(amLetzten), { next_run_date: '2026-11-30', anchor_day: 31 });
  } finally { old.close(); }
  const zweite = bestand();
  try {
    // ... einen Tag spaeter ist er vergangen: der November bleibt leer, der
    // Termin geht auf den 31.12. - nachgebucht wird nicht.
    const vorbei = zweite.addSerie('Vorbei', 'monthly', '2026-12-01', ['2026-10-31'], { pausedAt: '2026-11-15T00:00:00Z' });
    migriere(t, zweite.old, '2026-12-01T10:00:00Z');
    assert.deepEqual(zweite.lies(vorbei), { next_run_date: '2026-12-31', anchor_day: 31 });
  } finally { zweite.old.close(); }
});

test('Migration 234: eine Jahresserie vom 29.02. kehrt vom 01.03. zurueck', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const gemein = addSerie('Versicherung', 'yearly', '2027-03-01', ['2024-02-29', '2025-03-01', '2026-03-01']);
    const schalt = addSerie('Beitrag', 'yearly', '2028-03-01', ['2024-02-29', '2025-03-01', '2026-03-01', '2027-03-01'], { pausedAt: '2027-04-01T00:00:00Z' });
    const echtErster = addSerie('Am 1.3.', 'yearly', '2027-03-01', ['2025-03-01', '2026-03-01']);
    const anderswo = addSerie('31.01.', 'yearly', '2027-03-01', ['2026-01-31']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(gemein), { next_run_date: '2027-02-28', anchor_day: 29 });
    assert.deepEqual(lies(schalt), { next_run_date: '2028-02-29', anchor_day: 29 });
    assert.deepEqual(lies(echtErster), { next_run_date: '2027-03-01', anchor_day: 1 });
    assert.deepEqual(lies(anderswo), { next_run_date: '2027-03-01', anchor_day: 1 });
    assert.equal(nextRunNotBefore('2027-02-28', 'yearly', '2027-03-01', 29).date, '2028-02-29');
  } finally { old.close(); }
});

// Die Periode einer Jahresserie ist das JAHR: eine Buchung im Januar 2027
// (von Hand datiert) heisst, 2027 hat seine Buchung - auch wenn sie in einem
// anderen Monat liegt als der neue Termin.
test('Migration 234: eine Jahresserie, die im Zieljahr schon gebucht hat, bleibt unberuehrt', (t) => {
  const { old, addSerie, lies } = bestand();
  try {
    const id = addSerie('Versicherung', 'yearly', '2027-03-01', ['2024-02-29', '2025-03-01', '2027-01-15']);
    migriere(t, old, '2026-10-06T10:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2027-03-01', anchor_day: 1 });
  } finally { old.close(); }
});

// Jaehrlich liegt der zurueckgestellte Termin VOR dem alten (28.02. vor 01.03.).
// Laege er damit in der Vergangenheit, buchte der naechste Lauf ihn sofort und
// rueckdatiert nach. Dann bleibt die Zeile ganz, wie sie ist: ein Anker 29 an
// einem Maerztermin hoebe den naechsten Schritt auf den 29. Maerz.
test('Migration 234: rutschte der Jahrestermin in die Vergangenheit, bleibt die Serie unberuehrt', (t) => {
  const { old, addSerie, lies } = bestand('Pacific/Kiritimati');
  try {
    const id = addSerie('Versicherung', 'yearly', '2027-03-01', ['2024-02-29', '2025-03-01', '2026-03-01']);
    // 28.02. 11:00 UTC ist in Kiritimati (UTC+14) schon der 01.03.: gemessen
    // wird am Tag des Haushalts, nicht am UTC-Tag.
    migriere(t, old, '2027-02-28T11:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2027-03-01', anchor_day: 1 });
    assert.equal(nextRunNotBefore('2027-03-01', 'yearly', '2027-03-02', lies(id).anchor_day).date, '2028-03-01');
  } finally { old.close(); }
});

test('Migration 234: derselbe Zeitpunkt, Zone westlich - der 28.02. ist noch heute und wird gesetzt', (t) => {
  const { old, addSerie, lies } = bestand('America/Los_Angeles');
  try {
    const id = addSerie('Versicherung', 'yearly', '2027-03-01', ['2024-02-29', '2025-03-01', '2026-03-01']);
    migriere(t, old, '2027-02-28T11:00:00Z');
    assert.deepEqual(lies(id), { next_run_date: '2027-02-28', anchor_day: 29 });
  } finally { old.close(); }
});
