/**
 * Modul: Der Koch einer Mahlzeit - Server (#1679)
 * Zweck: Eine Mahlzeit kannte nur, wer sie eingetragen hat (`created_by`),
 *        nicht, wer kocht. `cook_user_id` an `meals` und an
 *        `meal_recurrence_templates` (Migration 235) traegt EIN
 *        Haushaltsmitglied als Koch, und jeder Schreibweg des Meals-Routers
 *        nimmt ihn mit:
 *
 *          - POST / und PUT /:id, samt der Vorlage, die sie schreiben;
 *          - PUT /:id?scope=series (Vorlage und alle Mahlzeiten der Serie)
 *            gegen PUT /:id (nur diese Mahlzeit);
 *          - das Materialisieren einer Serie beim Aufschlagen einer Woche;
 *          - POST /apply-plan.
 *
 *        Wer waehlbar ist, entscheidet das eine Mitglieder-Praedikat
 *        (docs/DECISIONS.md, Eintrag 4): Hauspersonal, Geteilte-Ausgaben-Gast
 *        und Wandtablett lehnen die Routen als NEUE Wahl ab; ein Koch, der
 *        schon gespeichert ist, bleibt speicherbar. Faellt die users-Zeile weg,
 *        setzt der Fremdschluessel den Koch auf NULL und die Mahlzeit bleibt.
 *
 *        Gemessen am echten Router ueber HTTP und an der echten Datenbank
 *        (alle Migrationen), nie an einer nachgebauten Query. Jede Ablehnung
 *        hat eine Positivkontrolle daneben, damit ein 400 nicht aus einem
 *        anderen Grund kommt als dem, um den es geht. Die Oberflaeche dazu
 *        steht in test-meals-cook-ui.js.
 * Ausfuehren: npm run test:meals-cook
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'meals-cook-test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { addDays } = await import('../server/services/meal-recurrence.js');
const { todayKey } = await import('../server/utils/timezone.js');
const { removeUser } = await import('../server/services/user-removal.js');
const { cookField } = await import('../server/services/meal-cook.js');
// Legt die `sessions`-Tabelle an: das Deaktivieren eines Kontos beendet seine
// Sitzungen in derselben Transaktion (server/services/user-removal.js).
await import('../server/auth.js');
const { MIGRATIONS } = dbmod;
const db = dbmod.get();

// --------------------------------------------------------------------------
// Fixtures: zwei Mitglieder und je ein Konto jeder Art, die kein Mitglied ist.
// --------------------------------------------------------------------------

function addUser(username, displayName, role = 'member') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'x', '#34C759', ?, 'other')
  `).run(username, displayName, role).lastInsertRowid);
}

const ANNA = addUser('anna', 'Anna', 'admin'); // Mitglied, traegt die Mahlzeiten ein
const BEN = addUser('ben', 'Ben'); // Mitglied
const CLARA = addUser('clara', 'Clara'); // Hauspersonal
const DORA = addUser('dora', 'Dora'); // Geteilte-Ausgaben-Gast
const WAND = addUser('wand', 'Kuechentablett'); // Wandtablett

db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(CLARA);
const GROUP = Number(db.prepare(`
  INSERT INTO expense_groups (name, default_currency, created_by) VALUES ('Urlaub', 'EUR', ?)
`).run(ANNA).lastInsertRowid);
db.prepare("INSERT INTO expense_group_members (group_id, user_id, role) VALUES (?, ?, 'guest')").run(GROUP, DORA);
db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(DORA, GROUP, ANNA);
db.prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)').run(WAND, ANNA);

const NON_MEMBERS = { Hauspersonal: CLARA, 'Geteilte-Ausgaben-Gast': DORA, Wandtablett: WAND };

let actor = ANNA;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor;
  req.authRole = actor === ANNA ? 'admin' : 'member';
  req.session = { userId: actor, role: req.authRole };
  next();
});
app.use('/dashboard', dashboardRouter);
app.use('/', mealsRouter);
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
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

const createMeal = (fields) => call('POST', '/', { date: '2031-03-03', meal_type: 'dinner', title: 'Eintopf', ...fields });
const cookOf = (id) => db.prepare('SELECT cook_user_id FROM meals WHERE id = ?').get(id)?.cook_user_id;
const templateCook = (id) => db.prepare('SELECT cook_user_id FROM meal_recurrence_templates WHERE id = ?').get(id)?.cook_user_id;
const weekOf = async (date) => (await call('GET', `/?week=${date}`)).body.data;

/** Ein Koch, den keine Route mehr annaehme, direkt in die Zeile - der Altbestand. */
const storeCook = (mealId, userId) => db.prepare('UPDATE meals SET cook_user_id = ? WHERE id = ?').run(userId, mealId);

// --------------------------------------------------------------------------
// Migration 235
// --------------------------------------------------------------------------

test('Migration 235: beide Spalten, nullable, auf users(id) mit ON DELETE SET NULL - und sie ist der letzte Eintrag ihrer Nummer', () => {
  const migration = MIGRATIONS.find((m) => m.description.includes('(#1679)'));
  assert.ok(migration, 'die Migration zu #1679 steht in MIGRATIONS');
  assert.equal(migration.version, 235);

  for (const table of ['meals', 'meal_recurrence_templates']) {
    const column = db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === 'cook_user_id');
    assert.ok(column, `${table}.cook_user_id fehlt`);
    assert.equal(column.notnull, 0, `${table}.cook_user_id ist nullable - NULL heisst "niemand"`);
    assert.equal(column.dflt_value, null, `${table}: kein Default, kein Backfill`);
    const fk = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find((f) => f.from === 'cook_user_id');
    assert.ok(fk, `${table}.cook_user_id traegt einen Fremdschluessel`);
    assert.equal(fk.table, 'users');
    assert.equal(fk.to, 'id');
    assert.equal(fk.on_delete, 'SET NULL');
  }
});

// --------------------------------------------------------------------------
// Speichern und Lesen
// --------------------------------------------------------------------------

test('POST /: der Koch wird gespeichert und kommt mit Name und Farbe zurueck - ohne sein Bild', async () => {
  db.prepare("UPDATE users SET avatar_data = 'data:image/png;base64,QkVO' WHERE id = ?").run(BEN);
  const r = await createMeal({ cook_user_id: BEN });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.cook_user_id, BEN);
  assert.equal(r.body.data.cook_name, 'Ben');
  assert.equal(r.body.data.cook_color, '#34C759');
  assert.ok(!('cook_avatar' in r.body.data), 'das Bild haengt nicht an der Mahlzeit');
  assert.equal(r.body.data.created_by, ANNA, 'wer eintraegt, bleibt eine eigene Angabe neben dem Koch');
  assert.equal(cookOf(r.body.data.id), BEN);
});

test('POST / ohne Koch: die Mahlzeit ist, was jede Mahlzeit bisher war', async () => {
  const r = await createMeal({ date: '2031-03-04' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.cook_user_id, null);
  assert.equal(r.body.data.cook_name, null);
});

test('GET /: die Woche traegt den Koch - und er ist fuer ein zweites Mitglied derselbe', async () => {
  const created = (await createMeal({ date: '2031-04-07', title: 'Risotto', cook_user_id: BEN })).body.data;
  const sicht = async (wer) => {
    actor = wer;
    try {
      const meal = (await weekOf('2031-04-07')).find((m) => m.id === created.id);
      return { cook_user_id: meal.cook_user_id, cook_name: meal.cook_name, cook_color: meal.cook_color };
    } finally {
      actor = ANNA;
    }
  };
  const anna = await sicht(ANNA);
  assert.deepEqual(anna, { cook_user_id: BEN, cook_name: 'Ben', cook_color: '#34C759' });
  assert.deepEqual(await sicht(BEN), anna, 'der Plan gehoert dem Haushalt: beide sehen dieselbe Mahlzeit mit demselben Koch');
});

test('PUT /:id: setzt, wechselt und entfernt den Koch; ein fehlendes Feld laesst ihn stehen', async () => {
  const id = (await createMeal({ date: '2031-03-05' })).body.data.id;

  const gesetzt = await call('PUT', `/${id}`, { cook_user_id: BEN });
  assert.equal(gesetzt.status, 200);
  assert.equal(gesetzt.body.data.cook_user_id, BEN);
  assert.equal(gesetzt.body.data.cook_name, 'Ben');

  // Verschieben per Ziehen schickt nur das Datum: der Koch darf dabei nicht fallen.
  const verschoben = await call('PUT', `/${id}`, { date: '2031-03-06' });
  assert.equal(verschoben.status, 200);
  assert.equal(verschoben.body.data.date, '2031-03-06');
  assert.equal(cookOf(id), BEN, 'ohne `cook_user_id` im Body bleibt der Koch');

  assert.equal((await call('PUT', `/${id}`, { cook_user_id: ANNA })).body.data.cook_user_id, ANNA);

  const entfernt = await call('PUT', `/${id}`, { cook_user_id: null });
  assert.equal(entfernt.status, 200);
  assert.equal(entfernt.body.data.cook_user_id, null);
  assert.equal(cookOf(id), null, '`null` nimmt den Koch heraus');
});

test('Uebersicht: die Mahlzeit von heute traegt ihren Koch', async () => {
  const today = todayKey(db);
  const id = (await createMeal({ date: today, meal_type: 'lunch', title: 'Heute-Suppe', cook_user_id: BEN })).body.data.id;
  try {
    const r = await call('GET', '/dashboard');
    assert.equal(r.status, 200);
    const meal = r.body.todayMeals.find((m) => m.id === id);
    assert.ok(meal, 'die Mahlzeit von heute steht in der Uebersicht');
    assert.equal(meal.cook_user_id, BEN);
    assert.equal(meal.cook_name, 'Ben');
    assert.equal(meal.cook_color, '#34C759');
    assert.ok(!('cook_avatar' in meal), 'das Bild haengt nicht an der Mahlzeit');
    assert.equal(r.body.users.find((u) => u.id === BEN).avatar_data, 'data:image/png;base64,QkVO',
      'es steht einmal in `users` derselben Antwort - von dort nimmt es die Oberflaeche, auch am Wandtablett');
  } finally {
    db.prepare('DELETE FROM meals WHERE id = ?').run(id);
  }
});

// --------------------------------------------------------------------------
// Serie
// --------------------------------------------------------------------------

// Weit in der Zukunft und je Test ein eigener Wochentag-Block: die Serien
// duerfen sich weder untereinander noch mit der aktuellen Woche beruehren.
test('Serie: die Vorlage traegt den Koch, und jede Mahlzeit, die aus ihr entsteht, beginnt mit ihm', async () => {
  const start = '2041-06-03';
  const first = (await createMeal({ date: start, title: 'Montagspasta', repeat_weekly: true, cook_user_id: BEN })).body.data;
  assert.equal(first.cook_user_id, BEN);
  assert.equal(templateCook(first.recurrence_template_id), BEN, 'der Koch steht an der Vorlage');

  const next = addDays(start, 7);
  const materialised = (await weekOf(next)).find((m) => m.recurrence_template_id === first.recurrence_template_id);
  assert.ok(materialised, 'die Folgewoche hat ihr Vorkommen bekommen');
  assert.notEqual(materialised.id, first.id);
  assert.equal(materialised.cook_user_id, BEN, 'das neue Vorkommen beginnt mit dem Koch der Serie');
  assert.equal(materialised.cook_name, 'Ben');
});

test('Serie: den Koch EINER Mahlzeit zu aendern laesst die Serie in Ruhe', async () => {
  const start = '2042-06-03';
  const first = (await createMeal({ date: start, title: 'Dienstagscurry', repeat_weekly: true, cook_user_id: BEN })).body.data;
  const tpl = first.recurrence_template_id;
  const second = (await weekOf(addDays(start, 7))).find((m) => m.recurrence_template_id === tpl);

  const r = await call('PUT', `/${second.id}`, { cook_user_id: ANNA });
  assert.equal(r.status, 200);
  assert.equal(cookOf(second.id), ANNA, 'diese Mahlzeit hat den neuen Koch');
  assert.equal(cookOf(first.id), BEN, 'die andere Mahlzeit der Serie nicht');
  assert.equal(templateCook(tpl), BEN, 'die Vorlage nicht');

  const third = (await weekOf(addDays(start, 14))).find((m) => m.recurrence_template_id === tpl);
  assert.equal(third.cook_user_id, BEN, 'und was danach entsteht, beginnt weiter mit dem Koch der Serie');
});

test('Serie: mit scope=series erreicht der Koch die Vorlage, jede Mahlzeit der Serie und alles, was noch entsteht', async () => {
  const start = '2043-06-03';
  const first = (await createMeal({ date: start, title: 'Mittwochssuppe', repeat_weekly: true, cook_user_id: BEN })).body.data;
  const tpl = first.recurrence_template_id;
  const second = (await weekOf(addDays(start, 7))).find((m) => m.recurrence_template_id === tpl);

  const r = await call('PUT', `/${second.id}?scope=series`, { cook_user_id: ANNA });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.cook_user_id, ANNA);
  assert.equal(templateCook(tpl), ANNA, 'die Vorlage');
  assert.equal(cookOf(first.id), ANNA, 'die andere Mahlzeit der Serie');
  assert.equal(cookOf(second.id), ANNA, 'die bearbeitete Mahlzeit');

  const third = (await weekOf(addDays(start, 14))).find((m) => m.recurrence_template_id === tpl);
  assert.equal(third.cook_user_id, ANNA, 'und ein neues Vorkommen');

  const geleert = await call('PUT', `/${second.id}?scope=series`, { cook_user_id: null });
  assert.equal(geleert.status, 200);
  assert.equal(templateCook(tpl), null, '`null` nimmt den Koch aus der ganzen Serie');
  assert.equal(cookOf(first.id), null);
});

test('Serie: scope=series OHNE `cook_user_id` laesst jeden Koch stehen, auch den einzeln gesetzten', async () => {
  const start = '2044-06-03';
  const first = (await createMeal({ date: start, title: 'Freitagsfisch', repeat_weekly: true, cook_user_id: BEN })).body.data;
  const tpl = first.recurrence_template_id;
  const second = (await weekOf(addDays(start, 7))).find((m) => m.recurrence_template_id === tpl);
  await call('PUT', `/${second.id}`, { cook_user_id: ANNA });

  const r = await call('PUT', `/${second.id}?scope=series`, { title: 'Freitagsfisch mit Salat' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT title FROM meals WHERE id = ?').get(first.id).title, 'Freitagsfisch mit Salat',
    'Positivkontrolle: die Serienaenderung ist angekommen');
  assert.equal(templateCook(tpl), BEN, 'die Vorlage behaelt ihren Koch');
  assert.equal(cookOf(first.id), BEN);
  assert.equal(cookOf(second.id), ANNA, 'die einzeln getroffene Wahl ueberlebt eine Titelaenderung an der Serie');
});

// --------------------------------------------------------------------------
// apply-plan
// --------------------------------------------------------------------------

test('POST /apply-plan: jede Zuweisung behaelt ihren Koch - additiv, mit replace_existing und mit skip_occupied', async () => {
  const plan = (date) => [
    { date, meal_type: 'lunch', title: 'Salat', cook_user_id: BEN },
    { date, meal_type: 'dinner', title: 'Auflauf', cook_user_id: ANNA },
    { date, meal_type: 'snack', title: 'Obst' },
  ];
  const cooks = (data) => Object.fromEntries(data.map((m) => [m.title, m.cook_user_id]));
  const expected = { Salat: BEN, Auflauf: ANNA, Obst: null };

  const additiv = await call('POST', '/apply-plan', { assignments: plan('2032-05-03') });
  assert.equal(additiv.status, 201);
  assert.deepEqual(cooks(additiv.body.data), expected);
  assert.equal(additiv.body.data.find((m) => m.title === 'Salat').cook_name, 'Ben');
  for (const meal of additiv.body.data) assert.equal(cookOf(meal.id), expected[meal.title], `${meal.title} in der Zeile`);

  const ersetzt = await call('POST', '/apply-plan', { assignments: plan('2032-05-03'), replace_existing: true });
  assert.equal(ersetzt.status, 201);
  assert.deepEqual(cooks(ersetzt.body.data), expected);

  const leereSlots = await call('POST', '/apply-plan', { assignments: plan('2032-05-04'), skip_occupied: true });
  assert.equal(leereSlots.status, 201);
  assert.deepEqual(cooks(leereSlots.body.data), expected);
});

// --------------------------------------------------------------------------
// Wer waehlbar ist
// --------------------------------------------------------------------------

for (const [art, userId] of Object.entries(NON_MEMBERS)) {
  test(`${art} ist als Koch nicht waehlbar: POST, PUT, scope=series und apply-plan lehnen die neue Wahl ab`, async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM meals').get().c;

    const angelegt = await createMeal({ date: '2033-01-03', cook_user_id: userId });
    assert.equal(angelegt.status, 400);
    assert.match(angelegt.body.error, /not a household member/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM meals').get().c, before, 'und nichts wurde angelegt');

    // Positivkontrolle: dieselbe Anfrage mit einem Mitglied geht durch.
    const meal = (await createMeal({ date: '2033-01-03', cook_user_id: BEN })).body.data;
    assert.equal(meal.cook_user_id, BEN);

    const geaendert = await call('PUT', `/${meal.id}`, { cook_user_id: userId });
    assert.equal(geaendert.status, 400);
    assert.match(geaendert.body.error, /not a household member/);
    assert.equal(cookOf(meal.id), BEN, 'der gespeicherte Koch bleibt');

    const serie = (await createMeal({ date: '2045-01-02', title: `Serie ${art}`, repeat_weekly: true, cook_user_id: BEN })).body.data;
    const alsSerie = await call('PUT', `/${serie.id}?scope=series`, { cook_user_id: userId, title: 'Umbenannt' });
    assert.equal(alsSerie.status, 400);
    assert.equal(templateCook(serie.recurrence_template_id), BEN);
    assert.equal(db.prepare('SELECT title FROM meals WHERE id = ?').get(serie.id).title, `Serie ${art}`,
      'eine abgelehnte Serienaenderung schreibt auch den Titel nicht');

    const mitSerie = await createMeal({ date: '2046-01-01', title: 'Neue Serie', repeat_weekly: true, cook_user_id: userId });
    assert.equal(mitSerie.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM meal_recurrence_templates WHERE title = 'Neue Serie'").get().c, 0);

    const countBeforePlan = db.prepare('SELECT COUNT(*) AS c FROM meals').get().c;
    const plan = await call('POST', '/apply-plan', {
      assignments: [
        { date: '2033-01-04', meal_type: 'lunch', title: 'Erste', cook_user_id: BEN },
        { date: '2033-01-04', meal_type: 'dinner', title: 'Zweite', cook_user_id: userId },
      ],
    });
    assert.equal(plan.status, 400);
    assert.match(plan.body.error, /not a household member/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM meals').get().c, countBeforePlan,
      'ein Nicht-Mitglied in EINER Zuweisung weist den ganzen Plan ab');
  });

  test(`${art} als gespeicherter Koch bleibt speicherbar - nur eine NEUE Wahl wird geprueft`, async () => {
    const meal = (await createMeal({ date: '2034-02-06', title: 'Altbestand' })).body.data;
    storeCook(meal.id, userId);

    const gelesen = (await weekOf('2034-02-06')).find((m) => m.id === meal.id);
    assert.equal(gelesen.cook_user_id, userId, 'der gespeicherte Koch wird weiter gezeigt');
    assert.ok(gelesen.cook_name, 'mit seinem Namen');

    // Der Dialog schickt den Koch beim Speichern unveraendert mit.
    const r = await call('PUT', `/${meal.id}`, { title: 'Altbestand, umbenannt', cook_user_id: userId });
    assert.equal(r.status, 200, 'die Mahlzeit laesst sich mit ihrem Koch weiter speichern');
    assert.equal(r.body.data.title, 'Altbestand, umbenannt');
    assert.equal(cookOf(meal.id), userId);

    // Einmal herausgenommen, ist es eine neue Wahl und wird abgelehnt.
    assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: null })).status, 200);
    assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: userId })).status, 400);
    assert.equal(cookOf(meal.id), null);
  });
}

test('gespeicherter Koch einer Serie: scope=series nimmt den Koch der VORLAGE weiter an - der Koch einer einzelnen Mahlzeit ist fuer die Serie eine neue Wahl', async () => {
  const first = (await createMeal({ date: '2047-03-04', title: 'Serie mit Altbestand', repeat_weekly: true, cook_user_id: BEN })).body.data;
  const tpl = first.recurrence_template_id;
  db.prepare('UPDATE meal_recurrence_templates SET cook_user_id = ? WHERE id = ?').run(CLARA, tpl);

  const vonDerVorlage = await call('PUT', `/${first.id}?scope=series`, { cook_user_id: CLARA });
  assert.equal(vonDerVorlage.status, 200, 'der Koch der Vorlage ist gespeicherter Stand');
  assert.equal(cookOf(first.id), CLARA);

  // Ein Nicht-Mitglied steht nur an EINER Mahlzeit der Serie (Altbestand). Der
  // Serien-Umfang schriebe es auf die Vorlage und auf alle anderen Mahlzeiten -
  // dort stand es nie, also ist es dort eine neue Wahl.
  const second = (await weekOf(addDays('2047-03-04', 7))).find((m) => m.recurrence_template_id === tpl);
  db.prepare('UPDATE meal_recurrence_templates SET cook_user_id = ? WHERE id = ?').run(BEN, tpl);
  storeCook(first.id, DORA);
  storeCook(second.id, BEN);
  const vonDerMahlzeit = await call('PUT', `/${first.id}?scope=series`, { cook_user_id: DORA, title: 'Umbenannt' });
  assert.equal(vonDerMahlzeit.status, 400, 'der Koch EINER Mahlzeit macht ihn nicht zum gespeicherten Koch der Serie');
  assert.match(vonDerMahlzeit.body.error, /not a household member/);
  assert.equal(templateCook(tpl), BEN, 'die Vorlage bekommt ihn nicht');
  assert.equal(cookOf(second.id), BEN, 'die andere Mahlzeit der Serie nicht');
  assert.equal(cookOf(first.id), DORA, 'und an seiner Mahlzeit bleibt er stehen');

  // Die Mahlzeit bleibt mit ihm speicherbar: fuer sich allein, und im
  // Serien-Umfang, solange der Koch nicht mitgeschickt wird.
  assert.equal((await call('PUT', `/${first.id}`, { cook_user_id: DORA, notes: 'einzeln' })).status, 200);
  assert.equal((await call('PUT', `/${first.id}?scope=series`, { title: 'Serie, umbenannt' })).status, 200);
  assert.equal(cookOf(first.id), DORA);
  assert.equal(templateCook(tpl), BEN);

  const fremd = await call('PUT', `/${first.id}?scope=series`, { cook_user_id: WAND });
  assert.equal(fremd.status, 400, 'wer nirgends steht, ist erst recht eine neue Wahl');
});

test('ungueltige und unbekannte Angaben: 400 statt Fremdschluessel-Fehler, nichts geschrieben', async () => {
  const meal = (await createMeal({ date: '2035-02-05', cook_user_id: BEN })).body.data;
  const before = db.prepare('SELECT COUNT(*) AS c FROM meals').get().c;

  for (const wert of ['abc', -1, 0, 1.5, [BEN], { id: BEN }, true]) {
    const angelegt = await createMeal({ date: '2035-02-06', cook_user_id: wert });
    assert.equal(angelegt.status, 400, `POST mit ${JSON.stringify(wert)}`);
    // Die Meldung nennt die FORM, nicht "nicht gefunden": eine Liste oder ein
    // Bruch ist keine unbekannte Person, sondern keine id.
    assert.match(angelegt.body.error, /Koch muss die ID eines Haushaltsmitglieds sein/, `POST mit ${JSON.stringify(wert)}`);
    const geaendert = await call('PUT', `/${meal.id}`, { cook_user_id: wert });
    assert.equal(geaendert.status, 400, `PUT mit ${JSON.stringify(wert)}`);
    assert.match(geaendert.body.error, /Koch muss die ID eines Haushaltsmitglieds sein/, `PUT mit ${JSON.stringify(wert)}`);
  }
  const unbekannt = await createMeal({ date: '2035-02-06', cook_user_id: 999999 });
  assert.equal(unbekannt.status, 400);
  assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: 999999 })).status, 400);

  // KEINE AUSKUNFT UEBER KONTEN: "gibt es nicht" und "gibt es, ist aber kein
  // Mitglied" bekommen dieselbe Antwort - Status, Felder und Wortlaut bis auf
  // die id, die der Aufrufer selbst geschickt hat. Und keine Antwort nennt
  // Name, Art oder Bild des abgelehnten Kontos.
  const gleich = (r, id) => ({ status: r.status, keys: Object.keys(r.body).sort(), error: r.body.error.replaceAll(String(id), '<id>'), code: r.body.code });
  for (const [art, userId] of Object.entries(NON_MEMBERS)) {
    const abgelehnt = await createMeal({ date: '2035-02-06', cook_user_id: userId });
    assert.deepEqual(gleich(abgelehnt, userId), gleich(unbekannt, 999999), `POST: ${art} gegen ein Konto, das es nicht gibt`);
    const beimAendern = await call('PUT', `/${meal.id}`, { cook_user_id: userId });
    assert.deepEqual(gleich(beimAendern, userId), gleich(await call('PUT', `/${meal.id}`, { cook_user_id: 999999 }), 999999), `PUT: ${art}`);
    const text = JSON.stringify(abgelehnt.body) + JSON.stringify(beimAendern.body);
    assert.doesNotMatch(text, /Clara|Dora|Kuechentablett|cook_name|cook_avatar|display_name|staff|guest|display|Hauspersonal|Gast/i,
      `${art}: die Absage nennt nur die id`);
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM meals').get().c, before);
  assert.equal(cookOf(meal.id), BEN);

  // Positivkontrolle: die id als Ziffernfolge und `null` ("niemand") gelten.
  assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: String(ANNA) })).body.data.cook_user_id, ANNA);
  assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: null })).body.data.cook_user_id, null);
});

// `Number()` liest "", " " und false als 0, true als 1, "1e1" als 10 und "0x1"
// als 1. Wer die Form an `Number()` prueft, nimmt einen Tippfehler als id an -
// und zwar als eine, die es geben kann: die Werte unten treffen mit ANNA (1)
// und einem zehnten Konto echte Mitglieder.
test('cookField: nur eine positive ganze Zahl oder null - nichts, was erst `Number()` zu einer id macht', async () => {
  const feld = (wert) => cookField(wert);
  assert.deepEqual(feld(undefined), { given: false, value: null, error: null }, 'fehlt das Feld, ist der Koch nicht angefasst');
  assert.deepEqual(feld(null), { given: true, value: null, error: null }, '`null` heisst niemand');
  assert.deepEqual(feld(7), { given: true, value: 7, error: null });
  assert.deepEqual(feld('7'), { given: true, value: 7, error: null }, 'die reine Ziffernfolge eines Formulars');
  assert.deepEqual(feld('120'), { given: true, value: 120, error: null }, 'eine Null IN der Zahl ist keine fuehrende');

  const ZEHN = [];
  while (ZEHN.length === 0 || ZEHN.at(-1) < 10) ZEHN.push(addUser(`fueller${ZEHN.length}`, `Fueller ${ZEHN.length}`));
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id IN (1, 10)').all().length === 2,
    'Vorbedingung: die Konten 1 und 10 gibt es - ein durchgerutschter Wert braechte ein 200, kein 400 aus anderem Grund');

  const meal = (await createMeal({ date: '2035-04-02', cook_user_id: BEN })).body.data;
  const before = db.prepare('SELECT COUNT(*) AS c FROM meals').get().c;
  const KEINE_ID = ['', ' ', '\t', '1e1', '0x1', '0b1', '1.0', '+1', '-1', ' 1', '1 ', '01', '0', '١', true, false,
    Number.MAX_SAFE_INTEGER + 1, 1e21, '9007199254740993'];
  for (const wert of KEINE_ID) {
    const name = JSON.stringify(wert);
    assert.deepEqual(feld(wert), { given: true, value: null, error: 'Koch muss die ID eines Haushaltsmitglieds sein.' }, `cookField(${name})`);
    const angelegt = await createMeal({ date: '2035-04-03', cook_user_id: wert });
    assert.equal(angelegt.status, 400, `POST mit ${name}`);
    assert.match(angelegt.body.error, /Koch muss die ID eines Haushaltsmitglieds sein/, `POST mit ${name}`);
    assert.equal((await call('PUT', `/${meal.id}`, { cook_user_id: wert })).status, 400, `PUT mit ${name}`);
    assert.equal((await call('POST', '/apply-plan', { assignments: [{ date: '2035-04-03', meal_type: 'lunch', title: 'X', cook_user_id: wert }] })).status,
      400, `apply-plan mit ${name}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM meals').get().c, before, 'nichts geschrieben');
  assert.equal(cookOf(meal.id), BEN, 'und der Koch steht noch');
});

// Die eigene Antwort auf ein Konto, das es nicht gibt, steht in `cookRefusal()`
// und gilt an JEDER Stelle, die es ruft. POST und PUT misst der Test darueber;
// der Serien-Umfang und apply-plan rufen es an eigenen Stellen. Faellt der
// Aufruf dort weg, faengt den Wert nur noch der Fremdschluessel - mit 500.
test('ein Konto, das es nicht gibt: scope=series und apply-plan antworten mit demselben 400 wie POST, nichts geschrieben', async () => {
  const start = '2049-06-01';
  const first = (await createMeal({ date: start, title: 'Serie fuer Unbekannt', repeat_weekly: true, cook_user_id: BEN })).body.data;
  const tpl = first.recurrence_template_id;
  const vergleich = await createMeal({ date: '2035-05-01', cook_user_id: 999999 });
  assert.equal(vergleich.status, 400, 'Vorbedingung: POST lehnt das unbekannte Konto ab');
  const before = db.prepare('SELECT COUNT(*) AS c FROM meals').get().c;

  const serie = await call('PUT', `/${first.id}?scope=series`, { title: 'Umbenannt', cook_user_id: 999999 });
  assert.equal(serie.status, 400, 'scope=series');
  assert.deepEqual(serie.body, vergleich.body, 'scope=series: derselbe Wortlaut wie POST');
  assert.equal(templateCook(tpl), BEN, 'die Vorlage behaelt ihren Koch');
  assert.equal(cookOf(first.id), BEN);
  assert.equal(db.prepare('SELECT title FROM meals WHERE id = ?').get(first.id).title, 'Serie fuer Unbekannt',
    'und der Rest des Aufrufs ist auch nicht geschrieben');

  for (const modus of [{}, { replace_existing: true }, { skip_occupied: true }]) {
    const plan = await call('POST', '/apply-plan', {
      ...modus,
      assignments: [
        { date: '2035-05-02', meal_type: 'lunch', title: 'Mit Ben', cook_user_id: BEN },
        { date: '2035-05-02', meal_type: 'dinner', title: 'Mit Unbekannt', cook_user_id: 999999 },
      ],
    });
    assert.equal(plan.status, 400, `apply-plan ${JSON.stringify(modus)}`);
    assert.deepEqual(plan.body, vergleich.body, `apply-plan ${JSON.stringify(modus)}: derselbe Wortlaut wie POST`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM meals').get().c, before, 'keine Mahlzeit entstanden, auch nicht die gueltige daneben');

  // Positivkontrolle: derselbe Aufruf mit einem Mitglied geht durch.
  assert.equal((await call('PUT', `/${first.id}?scope=series`, { title: 'Umbenannt', cook_user_id: ANNA })).status, 200);
  assert.equal(templateCook(tpl), ANNA);
});

// --------------------------------------------------------------------------
// Das Konto des Kochs faellt weg
// --------------------------------------------------------------------------

test('die users-Zeile des Kochs wird geloescht: Mahlzeit und Serie bleiben, ohne Koch', async () => {
  const GAST = addUser('kochgast', 'Kochgast');
  const einzeln = (await createMeal({ date: '2036-03-03', title: 'Von Anna eingetragen', cook_user_id: GAST })).body.data;
  const serie = (await createMeal({ date: '2048-03-03', title: 'Serie des Kochgasts', repeat_weekly: true, cook_user_id: GAST })).body.data;
  assert.equal(cookOf(einzeln.id), GAST);

  db.prepare('DELETE FROM users WHERE id = ?').run(GAST);

  const zeile = db.prepare('SELECT title, cook_user_id, created_by FROM meals WHERE id = ?').get(einzeln.id);
  assert.deepEqual(zeile, { title: 'Von Anna eingetragen', cook_user_id: null, created_by: ANNA },
    'die Mahlzeit, die jemand anderes eingetragen hat, bleibt - ohne Koch');
  assert.equal(cookOf(serie.id), null);
  assert.equal(templateCook(serie.recurrence_template_id), null, 'auch die Vorlage verliert nur den Koch');

  const gelesen = (await weekOf('2036-03-03')).find((m) => m.id === einzeln.id);
  assert.equal(gelesen.cook_user_id, null);
  assert.equal(gelesen.cook_name, null);
});

// Was `DELETE /auth/users/:id` tatsaechlich tut (#1381): ein Konto mit einer Spur
// in geteilten Daten wird deaktiviert statt geloescht. Der Koch ist eine solche
// Spur, wie der Zustaendige einer Aufgabe - die Mahlzeit behaelt ihn mit Namen.
test('das Konto des Kochs wird entfernt: es wird deaktiviert, die Mahlzeit behaelt ihren Koch, neu waehlbar ist er nicht', async () => {
  const EX = addUser('exkoch', 'Exkoch');
  const meal = (await createMeal({ date: '2037-03-02', title: 'Vom Exkoch gekocht', cook_user_id: EX })).body.data;

  const result = removeUser(db, EX);
  assert.equal(result.outcome, 'deactivated');
  assert.ok(result.traces.some((trace) => trace.table === 'meals' && trace.column === 'cook_user_id'),
    'der Koch-Verweis zaehlt als Spur in geteilten Daten');

  const gelesen = (await weekOf('2037-03-02')).find((m) => m.id === meal.id);
  assert.equal(gelesen.cook_user_id, EX);
  assert.equal(gelesen.cook_name, 'Exkoch', 'der gespeicherte Verweis behaelt seinen Namen');

  assert.equal((await call('PUT', `/${meal.id}`, { title: 'Umbenannt', cook_user_id: EX })).status, 200,
    'und die Mahlzeit laesst sich mit ihm weiter speichern');
  assert.equal((await createMeal({ date: '2037-03-03', cook_user_id: EX })).status, 400,
    'als neue Wahl ist ein ehemaliges Konto kein Haushaltsmitglied mehr');
});

// Das Materialisieren legt NEUE Mahlzeiten an. Kopierte es den Koch der Vorlage
// ungeprueft, stuende ein deaktiviertes Konto in jeder kuenftigen Woche neu im
// Plan, waehrend POST und PUT genau diesen Koch ablehnen (Review zu #1737).
test('Serie eines entfernten Kochs: was NEU aus ihr entsteht, hat keinen Koch - Bestand und Vorlage behalten ihn', async () => {
  const EX = addUser('exserie', 'Exserienkoch');
  const start = '2050-06-06';
  const first = (await createMeal({ date: start, title: 'Serie des Exkochs', repeat_weekly: true, cook_user_id: EX })).body.data;
  const tpl = first.recurrence_template_id;
  const second = (await weekOf(addDays(start, 7))).find((m) => m.recurrence_template_id === tpl);
  assert.equal(second.cook_user_id, EX, 'Vorbedingung: solange das Konto Mitglied ist, entsteht die Mahlzeit mit ihm');

  assert.equal(removeUser(db, EX).outcome, 'deactivated');
  assert.equal((await createMeal({ date: '2037-04-01', cook_user_id: EX })).status, 400,
    'Vorbedingung: die Schreibroute lehnt ihn als neue Wahl ab');

  const third = (await weekOf(addDays(start, 14))).find((m) => m.recurrence_template_id === tpl);
  assert.ok(third, 'die Serie laeuft weiter');
  assert.equal(third.title, 'Serie des Exkochs');
  assert.equal(third.cook_user_id, null, 'die neu entstandene Mahlzeit traegt das ehemalige Mitglied nicht');
  assert.equal(third.cook_name, null);
  assert.equal(cookOf(third.id), null, 'auch in der Zeile');

  assert.equal(cookOf(first.id), EX, 'die bestehenden Mahlzeiten behalten ihn (#1381)');
  assert.equal(cookOf(second.id), EX);
  assert.equal((await weekOf(addDays(start, 7))).find((m) => m.id === second.id).cook_name, 'Exserienkoch', 'mit Namen');
  assert.equal(templateCook(tpl), EX, 'die Vorlage wird nicht still umgeschrieben');

  // Dieselbe Frage fuer jede Art Nicht-Mitglied, die als Altbestand an einer
  // Vorlage stehen kann - und die Gegenprobe mit einem Mitglied daneben.
  for (const [art, userId] of Object.entries({ ...NON_MEMBERS, Mitglied: BEN })) {
    db.prepare('UPDATE meal_recurrence_templates SET cook_user_id = ? WHERE id = ?').run(userId, tpl);
    const woche = addDays(start, 7 * (3 + Object.keys(NON_MEMBERS).concat('Mitglied').indexOf(art)));
    const neu = (await weekOf(woche)).find((m) => m.recurrence_template_id === tpl);
    assert.ok(neu, `${art}: die Woche hat ihr Vorkommen`);
    assert.equal(neu.cook_user_id, art === 'Mitglied' ? BEN : null, `${art} an der Vorlage`);
  }
});

// Was der Dialog braucht, um "ganze Serie" richtig zu speichern: den Koch der
// SERIE neben dem dieser Mahlzeit.
test('GET / und jede Antwort eines Schreibwegs nennen den Koch der Serie als `recurrence_cook_user_id`', async () => {
  const start = '2051-06-05';
  const first = (await createMeal({ date: start, title: 'Serie mit zwei Koechen', repeat_weekly: true, cook_user_id: ANNA })).body.data;
  const tpl = first.recurrence_template_id;
  assert.equal(first.recurrence_cook_user_id, ANNA, 'schon in der Antwort auf POST');
  const second = (await weekOf(addDays(start, 7))).find((m) => m.recurrence_template_id === tpl);

  const einzeln = await call('PUT', `/${second.id}`, { cook_user_id: BEN });
  assert.equal(einzeln.body.data.cook_user_id, BEN);
  assert.equal(einzeln.body.data.recurrence_cook_user_id, ANNA, 'die Mahlzeit weicht ab, die Serie nicht');
  const gelesen = (await weekOf(addDays(start, 7))).find((m) => m.id === second.id);
  assert.equal(gelesen.cook_user_id, BEN);
  assert.equal(gelesen.recurrence_cook_user_id, ANNA);

  // Der Fall aus dem Review, am Server: Vorlage Anna, diese Mahlzeit Ben, die
  // ganze Serie wird mit Ben gespeichert.
  const serie = await call('PUT', `/${second.id}?scope=series`, { cook_user_id: BEN });
  assert.equal(serie.status, 200);
  assert.equal(serie.body.data.recurrence_cook_user_id, BEN);
  assert.equal(templateCook(tpl), BEN, 'die Vorlage hat den gewaehlten Koch');
  assert.equal(cookOf(first.id), BEN);

  const ohneSerie = (await createMeal({ date: '2035-06-01', cook_user_id: BEN })).body.data;
  assert.equal(ohneSerie.recurrence_cook_user_id, null, 'ohne Serie gibt es keinen Serienkoch');
});

// `users.avatar_data` ist eine Data-URL bis in die Hunderte Kilobyte. An jeder
// Mahlzeit haengend kam dasselbe Bild in EINEM Wochenabruf so oft, wie die
// Person kocht: 21 Mahlzeiten, 21-mal (Review zu #1737).
test('das Bild des Kochs haengt an keiner Mahlzeit: eine volle Woche wiegt nicht 21 Profilbilder', async () => {
  const BILD = `data:image/png;base64,${'QUJD'.repeat(50_000)}`; // 200 KB
  const KOCH = addUser('bildkoch', 'Bildkoch');
  db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(BILD, KOCH);
  const montag = '2052-01-01'; // ein Montag
  assert.equal(new Date(`${montag}T00:00:00Z`).getUTCDay(), 1, 'Vorbedingung: die Woche beginnt hier');

  const plan = [];
  for (let tag = 0; tag < 7; tag += 1) {
    for (const meal_type of ['breakfast', 'lunch', 'dinner']) {
      plan.push({ date: addDays(montag, tag), meal_type, title: `${meal_type} ${tag}`, cook_user_id: KOCH });
    }
  }
  const angelegt = await call('POST', '/apply-plan', { assignments: plan });
  assert.equal(angelegt.status, 201);
  assert.equal(angelegt.body.data.length, 21);

  const res = await fetch(`${baseUrl}/?week=${montag}`);
  const text = await res.text();
  // Die Serien der Tests darueber laufen ohne Ende und stehen auch in dieser
  // Woche; gemessen werden die 21 Mahlzeiten dieses Kochs, gewogen wird alles.
  const woche = JSON.parse(text).data.filter((meal) => meal.cook_user_id === KOCH);
  assert.equal(woche.length, 21, 'Vorbedingung: die ganze Woche ist gelesen');
  for (const meal of woche) {
    assert.equal(meal.cook_name, 'Bildkoch', 'Name und Farbe fuer die Initialen-Scheibe bleiben');
    assert.equal(meal.cook_color, '#34C759');
    assert.ok(!('cook_avatar' in meal), 'kein Bildfeld an der Mahlzeit');
  }
  assert.ok(!text.includes('QUJDQUJD'), 'und das Bild steht unter keinem anderen Namen in der Antwort');
  assert.ok(text.length < BILD.length / 4, `die Woche wiegt ${text.length} Zeichen - weniger als ein Viertel EINES Bildes (${BILD.length})`);

  // Dieselbe Frage an jede andere Antwort, die eine Mahlzeit herausgibt.
  const einzeln = JSON.stringify((await call('PUT', `/${woche[0].id}`, { title: 'Umbenannt' })).body)
    + JSON.stringify(angelegt.body);
  assert.ok(!einzeln.includes('QUJDQUJD') && !einzeln.includes('cook_avatar'), 'auch PUT und apply-plan tragen es nicht');
});
