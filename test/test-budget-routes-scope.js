/**
 * Test: Budget-Routen im Personal-Modus (#476/#505)
 * Zweck: End-to-End über den echten Router — Default-Sichtbarkeit, Lese-Scope
 *        (mine/household), 403-Gates für fremde Einträge. Kein Admin-Bypass.
 * Ausführen: node --experimental-sqlite --test test/test-budget-routes-scope.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();

// Zwei Mitglieder + ein Admin.
const A = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')`).run().lastInsertRowid;
const B = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('b','B','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;

function setMode(mode) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
}

let actor = { id: A, role: 'member' };
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id }; next(); });
  app.use('/', budgetRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

const MONTH = '2026-05';
async function createEntry(app, as, body) {
  actor = as;
  const res = await fetch(`${app.baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: body.title, amount: -10, date: `${MONTH}-10`, ...body }),
  });
  return res;
}
async function listIds(app, as, scope) {
  actor = as;
  const q = scope ? `&scope=${scope}` : '';
  const res = await fetch(`${app.baseUrl}/?month=${MONTH}${q}`);
  const body = await res.json();
  return body.data.map((e) => ({ id: e.id, title: e.title, visibility: e.visibility, owner_id: e.owner_id }));
}

test('personal-Modus: neue Einträge sind default privat', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const res = await createEntry(app, { id: A, role: 'member' }, { title: 'A default' });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.data.visibility, 'private');
    assert.equal(body.data.owner_id, A);
  } finally { await app.close(); }
});

test('personal-Modus: B sieht A privat NICHT, aber A geteilt', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const priv = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A priv', visibility: 'private' })).json();
    const shared = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A shared', visibility: 'shared' })).json();

    // B in Haushalts-Ansicht: nur der geteilte Topf.
    const bHousehold = await listIds(app, { id: B, role: 'member' }, 'household');
    const bTitles = bHousehold.map((e) => e.title);
    assert.ok(bTitles.includes('A shared'), 'B sieht geteilt');
    assert.ok(!bTitles.includes('A priv'), 'B sieht A privat nicht');

    // Admin ebenfalls kein Zugriff auf A privat (kein Bypass).
    const adminHousehold = await listIds(app, { id: ADMIN, role: 'admin' }, 'household');
    assert.ok(!adminHousehold.map((e) => e.title).includes('A priv'), 'Admin sieht A privat nicht');

    // A in Mein-Ansicht: beide eigenen.
    const aMine = await listIds(app, { id: A, role: 'member' }, 'mine');
    const aTitles = aMine.map((e) => e.title);
    assert.ok(aTitles.includes('A priv') && aTitles.includes('A shared'), JSON.stringify(aTitles));

    void priv; void shared;
  } finally { await app.close(); }
});

test('personal-Modus: B darf A-Eintrag nicht ändern/löschen (403)', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const entry = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A own', visibility: 'shared' })).json();
    const eid = entry.data.id;

    actor = { id: B, role: 'member' };
    const put = await fetch(`${app.baseUrl}/${eid}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'hijack' }),
    });
    assert.equal(put.status, 403, 'B darf nicht bearbeiten');

    const del = await fetch(`${app.baseUrl}/${eid}`, { method: 'DELETE' });
    assert.equal(del.status, 403, 'B darf nicht löschen');

    // Admin ebenfalls nicht (kein Bypass): A privat.
    const priv = await (await createEntry(app, { id: A, role: 'member' }, { title: 'A secret', visibility: 'private' })).json();
    actor = { id: ADMIN, role: 'admin' };
    const adminDel = await fetch(`${app.baseUrl}/${priv.data.id}`, { method: 'DELETE' });
    assert.equal(adminDel.status, 403, 'Admin darf A privat nicht löschen');
  } finally { await app.close(); }
});

test('shared-Modus: B sieht und bearbeitet A-Eintrag (Altverhalten)', async () => {
  setMode('shared');
  const app = await startApp();
  try {
    const entry = await (await createEntry(app, { id: A, role: 'member' }, { title: 'shared-mode' })).json();
    const list = await listIds(app, { id: B, role: 'member' });
    assert.ok(list.map((e) => e.title).includes('shared-mode'), 'B sieht im shared-Modus');

    actor = { id: B, role: 'member' };
    const put = await fetch(`${app.baseUrl}/${entry.data.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'edited' }),
    });
    assert.equal(put.status, 200, 'B darf im shared-Modus bearbeiten');
  } finally { await app.close(); }
});

// ============================================================
// Dritte Stufe: Betrag zaehlt, Zweck bleibt privat (#659)
//
// Diese Tests gehen bewusst ueber die ROUTEN und nicht ueber die Helfer aus
// services/budget-visibility.js. Deren Suite pruefen die SQL-Fragmente und die
// Maskierungsfunktion isoliert - waere das alles, bliebe ein Lesepfad, dem
// jemand die Maskierung wieder herausnimmt, gruen. Die Maske muss dort sitzen,
// wo die Antwort das Haus verlaesst.
// ============================================================

/** Legt eine fremde 'shared_amount'-Buchung von A an und gibt ihre Antwort zurueck. */
async function createAmountOnly(app, title = 'A Skin', extra = {}) {
  return (await createEntry(app, { id: A, role: 'member' }, {
    title, visibility: 'shared_amount', category: 'leisure', amount: -25, ...extra,
  })).json();
}

/* Die Tests unten fragen als B/Admin IMMER mit scope=household. Ohne den
 * Parameter steht der Ansichts-Filter auf 'mine' (owner_id = ich), und dann
 * fehlt eine fremde Buchung voellig zu Recht - unabhaengig von ihrer Stufe.
 * Der Kontostand ist die Ausnahme: er ist ungescoped, weil ein Saldo nicht
 * davon abhaengen darf, welche Ansicht gerade offen ist.
 *
 * Alle Tests teilen EINE In-Memory-DB, Eintraege frueherer Tests bleiben also
 * liegen. Deshalb wird hier nach dem TITEL gesucht und nicht nach der Stufe. */
const byId = (rows, id) => rows.find((e) => e.id === id);

test('#659 personal: POST nimmt shared_amount an', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app);
    assert.equal(created.data.visibility, 'shared_amount');
    assert.equal(created.data.owner_id, A);
  } finally { await app.close(); }
});

test('#659 personal: B sieht die Zeile, aber nicht ihren Zweck', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app, 'Overwatch-Skin');

    actor = { id: B, role: 'member' };
    const body = await (await fetch(`${app.baseUrl}/?month=${MONTH}&scope=household`)).json();
    const row = byId(body.data, created.data.id);
    assert.ok(row, 'die Zeile muss in der Liste stehen - sonst passt der Saldo nicht dazu');
    assert.equal(row.amount, -25, 'der Betrag ist der Grund, warum die Zeile dasteht');
    assert.equal(row.date, `${MONTH}-10`, 'das Datum bleibt');
    assert.equal(row.details_hidden, true, 'Flag fuer die Oberflaeche');
    assert.equal(row.title, '', 'kein Titel');
    assert.equal(row.category, '__private__', 'Sammel-Bucket statt echter Kategorie');
    assert.equal(row.subcategory, '', 'keine Unterkategorie');
    assert.equal(row.attachments, undefined, 'Belege verraten den Zweck genauso');
    assert.ok(!JSON.stringify(row).includes('Overwatch'), 'kein Rest des Titels irgendwo in der Antwort');
  } finally { await app.close(); }
});

test('#659 personal: A sieht den eigenen Eintrag unveraendert', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app, 'Nur fuer A');
    const row = byId(await listIds(app, { id: A, role: 'member' }, 'mine'), created.data.id);
    assert.equal(row.title, 'Nur fuer A', 'der Eigentuemer sieht seinen Titel');
  } finally { await app.close(); }
});

test('#659 personal: Admin bekommt keinen Bypass auf den Zweck', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app, 'Admin darf das nicht lesen');
    actor = { id: ADMIN, role: 'admin' };
    const body = await (await fetch(`${app.baseUrl}/?month=${MONTH}&scope=household`)).json();
    const row = byId(body.data, created.data.id);
    assert.ok(row, 'der Betrag zaehlt auch fuer den Admin');
    assert.equal(row.title, '', 'aber der Titel bleibt zu');
  } finally { await app.close(); }
});

test('#659 personal: die Kategorie-Aufschluesselung verraet den Zweck nicht', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    // Gemessen wird das DELTA, nicht der Absolutwert: alle Tests teilen eine
    // In-Memory-DB, im Bucket liegen also auch die Buchungen der Tests davor.
    const summaryFor = async (who) => {
      actor = who;
      return (await (await fetch(`${app.baseUrl}/summary?month=${MONTH}&scope=household`)).json()).data;
    };
    const asB = { id: B, role: 'member' };
    const before = await summaryFor(asB);
    const bucketBefore = before.byCategory.find((c) => c.category === '__private__')?.total ?? 0;
    const leisureBefore = before.byCategory.find((c) => c.category === 'leisure')?.total ?? 0;

    await createAmountOnly(app, 'Skin', { category: 'leisure' });
    // ENTSCHEIDEND: ein SICHTBARER Eintrag DERSELBEN Kategorie daneben. Ohne ihn
    // enthaelt 'leisure' nur die maskierte Buchung, und dann sieht ein falsches
    // `GROUP BY category` (echte Spalte schlaegt Output-Alias) genauso aus wie
    // das richtige `GROUP BY 1` - die Gegenprobe blieb an dieser Stelle gruen.
    await createEntry(app, { id: B, role: 'member' }, {
      title: 'B Kino', visibility: 'shared', category: 'leisure', amount: -7,
    });

    const after = await summaryFor(asB);
    const bucket = after.byCategory.find((c) => c.category === '__private__');
    assert.ok(bucket, 'fremdes shared_amount braucht einen eigenen Sammel-Bucket');
    assert.equal(Math.round((bucket.total - bucketBefore) * 100), -2500,
      'der Betrag muss im Sammel-Bucket ankommen');
    const leisureAfter = after.byCategory.find((c) => c.category === 'leisure')?.total ?? 0;
    assert.equal(Math.round((leisureAfter - leisureBefore) * 100), -700,
      'leisure darf sich NUR um die sichtbare Buchung bewegen - kaeme der maskierte '
      + 'Betrag hier an, waere der Zweck verraten');
    // Die Aufschluesselung muss die Gesamtsumme ergeben, sonst wirkt die Uebersicht falsch.
    const sum = after.byCategory.reduce((acc, c) => acc + c.total, 0);
    assert.equal(Math.round(sum * 100), Math.round(after.balance * 100),
      'Summe der Kategorien muss den Saldo ergeben');
  } finally { await app.close(); }
});

test('#659 personal: auch die Statistik nutzt den Sammel-Bucket', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    await createAmountOnly(app, 'Skin', { category: 'leisure' });

    actor = { id: B, role: 'member' };
    const stats = await (await fetch(`${app.baseUrl}/stats?range=month&anchor=${MONTH}-10&scope=household`)).json();
    const cats = stats.data.byCategory;
    assert.ok(cats.some((c) => c.category === '__private__'), 'Statistik braucht den Bucket ebenso');
    assert.ok(!cats.some((c) => c.category === 'leisure' && c.total === -25),
      'die echte Kategorie darf auch hier nichts ausweisen');
  } finally { await app.close(); }
});

test('#659 personal: der CSV-Export ist maskiert', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    await createAmountOnly(app, 'Overwatch-Skin', { category: 'leisure' });

    actor = { id: B, role: 'member' };
    const csv = await (await fetch(`${app.baseUrl}/export?month=${MONTH}&scope=household`)).text();
    assert.ok(!csv.includes('Overwatch'), 'der Export waere sonst der bequemste Weg an den Zweck');

    // Zeilengenau pruefen, nicht ueber die ganze Datei: 'leisure' steht dort
    // legitim, sobald irgendeine SICHTBARE Buchung diese Kategorie hat.
    const masked = csv.split('\n').filter((l) => l.includes('Private entry'));
    assert.ok(masked.length, 'die Zeile bleibt drin, mit Platzhalter');
    for (const line of masked) {
      assert.ok(!line.includes('leisure'), `Kategorie im Export geleakt: ${line}`);
      assert.ok(line.includes('Private'), 'die Kategoriespalte traegt den Platzhalter');
      assert.ok(line.includes('-25.00'), `Betrag fehlt in der maskierten Zeile: ${line}`);
    }
  } finally { await app.close(); }
});

test('#659 personal: A sieht im eigenen Export den vollen Titel', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    await createAmountOnly(app, 'Overwatch-Skin');
    actor = { id: A, role: 'member' };
    const csv = await (await fetch(`${app.baseUrl}/export?month=${MONTH}&scope=mine`)).text();
    assert.ok(csv.includes('Overwatch-Skin'), 'der Eigentuemer exportiert seine eigenen Daten voll');
  } finally { await app.close(); }
});

test('#659 personal: der Betrag landet im Kontostand der anderen', async () => {
  setMode('personal');
  const app = await startApp();
  try {
    // Genau die Zahl, um die es in #659 geht: der Saldo eines geteilten Kontos.
    const acc = db.prepare(`INSERT INTO budget_accounts (name, type, starting_balance, created_by)
                            VALUES ('Giro', 'checking', 100, ?)`).run(A).lastInsertRowid;
    await createAmountOnly(app, 'Skin', { account_id: Number(acc), date: '2020-01-05' });

    actor = { id: B, role: 'member' };
    const accounts = await (await fetch(`${app.baseUrl}/accounts`)).json();
    const giro = accounts.data.accounts.find((a) => a.id === Number(acc));
    assert.equal(giro.current_balance, 75, 'der fremde shared_amount-Betrag muss den Saldo mindern');
    assert.equal(giro.entry_count, 1, 'und die Zeile zaehlt mit, sie ist ja sichtbar');
  } finally { await app.close(); }
});

test('#659 shared-Modus: keine Maskierung (Altverhalten)', async () => {
  setMode('shared');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app, 'Sichtbar im Altmodus');
    const row = byId(await listIds(app, { id: B, role: 'member' }), created.data.id);
    assert.equal(row.title, 'Sichtbar im Altmodus', 'im shared-Modus wird nie maskiert');
  } finally { await app.close(); }
});

test('#659 personal: das Inventar behandelt shared_amount wie privat', async () => {
  // Andere Achse als der Kontostand: eine Verknuepfung zwischen Buchung und
  // Gegenstand IST eine Aussage darueber, wofuer das Geld war. Hier fehlt auch
  // keine Summe, wenn die Buchung wegbleibt - also bleibt sie ganz weg.
  setMode('personal');
  const app = await startApp();
  try {
    const created = await createAmountOnly(app, 'Konsole heimlich');
    const shared = await (await createEntry(app, { id: A, role: 'member' }, {
      title: 'A offen', visibility: 'shared', amount: -30,
    })).json();

    const { visibleEntry } = await import('../server/routes/inventory/entry-links.js');
    assert.equal(visibleEntry(created.data.id, B), undefined,
      'B darf die shared_amount-Buchung im Inventar nicht sehen');
    assert.ok(visibleEntry(shared.data.id, B), 'eine echt geteilte Buchung schon');
    assert.ok(visibleEntry(created.data.id, A), 'der Eigentuemer sieht seine eigene');
  } finally { await app.close(); }
});
