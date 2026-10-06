/**
 * Modul: Der Koch einer Serie - Dialog bis Datenbank (#1679)
 * Zweck: "Ganze Serie" schreibt einen mitgeschickten Koch auf die Vorlage und
 *        auf JEDE Mahlzeit der Serie. Der Dialog zeigt aber den Koch EINER
 *        Mahlzeit - und aus den gespeicherten Staenden laesst sich nicht lesen,
 *        ob der gezeigte Koch GEWAEHLT oder nur GEZEIGT ist. Der Vergleich mit
 *        Mahlzeit und Vorlage (erster Stand von PR #1739) schickte ihn deshalb
 *        bei einer blossen Titelaenderung mit: aus Anna/Ben/Carla wurden drei
 *        Ben, eine Woche ohne Koch leerte die ganze Serie, und zusammen mit dem
 *        Materialisieren ohne ehemaligen Koch verlor eine Serie ihren Koch fuer
 *        immer (Review zu #1739, Faelle S1-S6).
 *
 *        Die Regel: der Koch geht im Serien-Umfang NUR mit, wenn ihn jemand in
 *        diesem Dialog gewaehlt hat (`state.modal.cookTouched`). Solange das
 *        niemand tat, zeigt die Auswahl im Serien-Umfang den Koch der Vorlage.
 *
 *        GEMESSEN VOM KLICK BIS ZUR ZEILE: der echte Dialog (openMealModal, die
 *        echte Personenauswahl, die echten Handler an Auswahl, Umfang und
 *        Speichern-Knopf) gegen den echten Router und die echte Datenbank. Je
 *        Fall der gesendete Body UND der Endzustand jeder Woche - ein Body
 *        allein sagt nicht, was der Server daraus macht.
 * Ausfuehren: npm run test:meals-cook
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'meals-cook-series-test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.CSS = globalThis.CSS ?? { escape: (value) => String(value) };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.document.documentElement = globalThis.document.documentElement ?? {};
globalThis.document.documentElement.classList = globalThis.document.documentElement.classList
  ?? { add() {}, remove() {}, toggle() {}, contains: () => false };

const dbmod = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: familyRouter } = await import('../server/routes/family.js');
const { addDays } = await import('../server/services/meal-recurrence.js');
const { removeUser } = await import('../server/services/user-removal.js');
await import('../server/auth.js');
const db = dbmod.get();

// Die ECHTE Personenauswahl hinter den Haken des Loaders.
const picker = await import('../public/components/user-multi-select.js');
globalThis.__renderUserMultiSelect = picker.renderUserMultiSelect;
globalThis.__renderAvatarStack = picker.renderAvatarStack;
globalThis.__getSelectedUserIds = picker.getSelectedUserIds;
globalThis.__bindUserMultiSelect = picker.bindUserMultiSelect;

const { setPermissions } = await import('../public/permissions.js');
const { setHouseholdSize } = await import('../public/utils/household.js');
const { __test: meals } = await import('../public/pages/meals.js');
setPermissions({ admin: false, modules: { meals: 'write', shopping: 'write', pantry: 'write' }, widgets: {}, capabilities: {} });
setHouseholdSize(4);

function addUser(name) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'x', '#34C759', 'member', 'other')
  `).run(name.toLowerCase(), name).lastInsertRowid);
}
const ADMIN = addUser('Admin');
const ANNA = addUser('Anna');
const BEN = addUser('Ben');
const CARLA = addUser('Carla');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.session = { userId: ADMIN, role: 'admin' };
  next();
});
app.use('/family', familyRouter);
app.use('/meals', mealsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --------------------------------------------------------------------------
// Serien und ihr Zustand
// --------------------------------------------------------------------------

const name = (id) => (id == null ? '-' : db.prepare('SELECT display_name FROM users WHERE id = ?').get(id).display_name);
const weekOf = async (s, index) => (await call('GET', `/meals?week=${addDays(s.start, 7 * index)}`)).body.data;

/** Vorlage, Wochen und Titel einer Serie, wie sie in der Datenbank stehen. */
function zustand(s) {
  const tpl = db.prepare('SELECT cook_user_id, title FROM meal_recurrence_templates WHERE id = ?').get(s.tpl);
  const rows = db.prepare('SELECT cook_user_id, title FROM meals WHERE recurrence_template_id = ? ORDER BY date').all(s.tpl);
  return { vorlage: name(tpl.cook_user_id), wochen: rows.map((r) => name(r.cook_user_id)), titel: [...new Set([tpl.title, ...rows.map((r) => r.title)])] };
}

let start = '2040-01-02';
/** Eine Wochenserie mit `weeks` schon entstandenen Mahlzeiten; `einzeln` setzt je Woche einen eigenen Koch. */
async function serie(cook, { weeks = 3, einzeln = {} } = {}) {
  start = addDays(start, 70);
  const first = (await call('POST', '/meals', { date: start, meal_type: 'dinner', title: 'Alt', repeat_weekly: true, cook_user_id: cook })).body.data;
  const s = { tpl: first.recurrence_template_id, start, ids: [first.id] };
  for (let i = 1; i < weeks; i += 1) await naechsteWoche(s);
  for (const [index, id] of Object.entries(einzeln)) {
    assert.equal((await call('PUT', `/meals/${s.ids[index]}`, { cook_user_id: id })).status, 200);
  }
  return s;
}
/** Schlaegt die naechste Woche auf - die Serie materialisiert ihr Vorkommen. */
async function naechsteWoche(s) {
  const meal = (await weekOf(s, s.ids.length)).find((m) => m.recurrence_template_id === s.tpl);
  assert.ok(meal, 'die Woche hat ihr Vorkommen');
  s.ids.push(meal.id);
  return meal;
}

// --------------------------------------------------------------------------
// Der Dialog: echtes Markup, echte Handler, ein Panel aus seinen Checkboxen
// --------------------------------------------------------------------------

/**
 * Oeffnet den Bearbeiten-Dialog der Mahlzeit `index` und gibt zurueck, was ein
 * Mensch daran tun kann: eine Zeile der Auswahl antippen, den Umfang wechseln,
 * den Titel aendern, speichern. Die Checkboxen kommen aus dem ECHTEN Markup;
 * angetippt wird wie im Browser - `checked` kippt, dann laeuft `change`.
 */
async function dialog(s, index) {
  const week = await weekOf(s, index);
  const meal = week.find((m) => m.id === s.ids[index]);
  Object.assign(meals.state, {
    members: (await call('GET', '/family/members')).body.data,
    meals: week, currentWeek: s.start, recipes: [], lists: [], categories: [], loadError: null, modal: null,
  });
  meals.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });

  let opened = null;
  globalThis.__openModal = (opts) => { opened = opts; };
  meals.openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
  assert.ok(opened, 'Vorbedingung: der Editor ist aufgegangen');

  const boxes = [...opened.content.matchAll(/<input type="checkbox" class="user-ms__checkbox([^"]*)" value="([^"]*)"([^>]*)>/g)]
    .map((m) => {
      const none = m[1].includes('user-ms__none');
      return {
        value: m[2], checked: /\bchecked\b/.test(m[3]), none,
        classList: { contains: (cls) => (cls === 'user-ms__none' ? none : cls === 'user-ms__checkbox') },
        matches: (sel) => sel === '.user-ms__checkbox',
      };
    });
  assert.ok(boxes.some((b) => b.none) && boxes.length >= 4, 'Vorbedingung: die Auswahl ist gerendert');

  const handler = { auswahl: [], umfang: [], speichern: [] };
  const knoten = (over = {}) => ({
    value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {}, style: {},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, remove() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    ...over,
  });
  const widget = knoten({
    addEventListener: (type, fn) => { if (type === 'change') handler.auswahl.push(fn); },
    querySelector: (sel) => (sel === '.user-ms__none' ? boxes.find((b) => b.none)
      : sel === '.user-ms__checkbox:checked' ? (boxes.find((b) => b.checked) ?? null) : null),
    querySelectorAll: (sel) => (sel === '.user-ms__checkbox:not(.user-ms__none)' ? boxes.filter((b) => !b.none) : []),
  });
  const felder = {
    '.user-ms[data-ms-name="meal_cook"]': widget,
    '#modal-edit-scope': knoten({ value: 'single', addEventListener: (type, fn) => { if (type === 'change') handler.umfang.push(fn); } }),
    '#modal-save': knoten({ addEventListener: (type, fn) => { if (type === 'click') handler.speichern.push(fn); } }),
    '#modal-date': knoten({ value: meal.date }),
    '#modal-type': knoten({ value: meal.meal_type }),
    '#modal-title': knoten({ value: meal.title }),
    '#modal-notes': knoten(),
    '#modal-recipe-url': knoten(),
    '#modal-recipe-id': knoten(),
    '#modal-repeat-until': knoten(),
  };
  const panel = {
    dataset: {},
    querySelector: (sel) => felder[sel] ?? knoten(),
    querySelectorAll: (sel) => (sel === '[data-ms-input="meal_cook"]:not(.user-ms__none):checked' ? boxes.filter((b) => !b.none && b.checked)
      : sel === '[data-ms-input="meal_cook"]' ? boxes : []),
  };
  opened.onSave(panel);
  assert.equal(handler.auswahl.length, 2, 'Vorbedingung: an der Auswahl haengen die Einzelauswahl und der Beruehrt-Merker');
  assert.equal(handler.umfang.length, 1, 'Vorbedingung: der Umfang ist verdrahtet');
  assert.equal(handler.speichern.length, 1, 'Vorbedingung: der Speichern-Knopf ist verdrahtet');

  return {
    meal,
    /** Was die Auswahl gerade zeigt: der Name der markierten Zeile. */
    gezeigt: () => {
      const an = boxes.filter((b) => b.checked);
      assert.equal(an.length, 1, 'genau eine Zeile ist markiert');
      return an[0].none ? '-' : name(Number(an[0].value));
    },
    beruehrt: () => meals.state.modal.cookTouched,
    /** Eine Zeile antippen: eine id oder null fuer "Niemand". */
    tippen: (id) => {
      const box = boxes.find((b) => (id === null ? b.none : !b.none && Number(b.value) === id));
      assert.ok(box, `die Zeile fuer ${name(id)} steht in der Auswahl`);
      box.checked = !box.checked;
      for (const fn of handler.auswahl) fn({ target: box });
    },
    umfang: (wert) => {
      felder['#modal-edit-scope'].value = wert;
      for (const fn of handler.umfang) fn({ target: felder['#modal-edit-scope'] });
    },
    titel: (wert) => { felder['#modal-title'].value = wert; },
    /** Speichern-Knopf: der Body geht an den ECHTEN Router; zurueck kommt, was gesendet wurde. */
    speichern: async () => {
      const gesendet = [];
      globalThis.__apiStub = {
        get: async () => ({ data: [] }),
        post: async () => ({ data: {} }), patch: async () => ({}), delete: async () => ({}),
        put: async (path, body) => {
          const antwort = await call('PUT', path, body);
          gesendet.push({ path, body, status: antwort.status });
          if (antwort.status >= 400) throw Object.assign(new Error(antwort.body?.error), { data: antwort.body });
          return antwort.body;
        },
      };
      try {
        await handler.speichern[0]();
      } finally {
        globalThis.__apiStub = undefined;
      }
      assert.equal(gesendet.length, 1, 'genau ein Schreibaufruf');
      return gesendet[0];
    },
  };
}

/** Nur den Titel aendern und fuer die ganze Serie speichern - der Koch wird nie angefasst. */
async function nurTitelFuerDieSerie(s, index) {
  const d = await dialog(s, index);
  d.umfang('series');
  d.titel('Neu');
  const beruehrt = d.beruehrt();
  const gesendet = await d.speichern();
  assert.equal(gesendet.path, `/meals/${s.ids[index]}?scope=series`);
  assert.equal(gesendet.status, 200);
  assert.equal(gesendet.body.title, 'Neu', 'Vorbedingung: die Titelaenderung geht raus');
  return { beruehrt, gesendet };
}

// --------------------------------------------------------------------------
// S1-S6: nur der Titel aendert sich, der Koch wird nie angefasst
// --------------------------------------------------------------------------

const TITEL_FAELLE = [
  { fall: 'S1 von W1 aus (Anna, wie die Vorlage)', cook: () => ANNA, einzeln: () => ({ 1: BEN, 2: CARLA }), von: 0, erwartet: { vorlage: 'Anna', wochen: ['Anna', 'Ben', 'Carla'] } },
  { fall: 'S2 von W2 aus (Ben als Ausnahme)', cook: () => ANNA, einzeln: () => ({ 1: BEN, 2: CARLA }), von: 1, erwartet: { vorlage: 'Anna', wochen: ['Anna', 'Ben', 'Carla'] } },
  { fall: 'S3 von W2 aus (einzeln "Niemand")', cook: () => ANNA, einzeln: () => ({ 1: null, 2: BEN }), von: 1, erwartet: { vorlage: 'Anna', wochen: ['Anna', '-', 'Ben'] } },
  { fall: 'S4 Vorlage ohne Koch, von W2 aus (einzeln Ben)', cook: () => null, einzeln: () => ({ 1: BEN, 2: CARLA }), von: 1, erwartet: { vorlage: '-', wochen: ['-', 'Ben', 'Carla'] } },
];

for (const { fall, cook, einzeln, von, erwartet } of TITEL_FAELLE) {
  test(`Titelaenderung an der ganzen Serie laesst jeden Koch stehen: ${fall}`, async () => {
    const s = await serie(cook(), { einzeln: einzeln() });
    assert.deepEqual(zustand(s), { ...erwartet, titel: ['Alt'] }, 'Vorbedingung: der Ausgangszustand');

    const { beruehrt, gesendet } = await nurTitelFuerDieSerie(s, von);
    assert.equal(beruehrt, false, 'niemand hat den Koch gewaehlt');
    assert.ok(!('cook_user_id' in gesendet.body), `der Body traegt keinen Koch (gesendet: ${JSON.stringify(gesendet.body.cook_user_id)})`);
    assert.deepEqual(zustand(s), { ...erwartet, titel: ['Neu'] }, 'jede Woche und die Vorlage behalten ihren Koch, der Titel ist ueberall neu');
  });
}

// Fix A und die Senderegel zusammen: eine Woche, die waehrend der Deaktivierung
// entstand, hat keinen Koch. Schickte eine Titelaenderung von dort `null` mit,
// waere die Vorlage geleert, die Bestandsmahlzeiten verloeren den Namen und der
// Koch kaeme nach der Reaktivierung nicht zurueck.
for (const [fall, von] of [['S5 von der neu entstandenen Woche ohne Koch aus', 2], ['S6 von W1 aus (der ehemalige Koch steht dran)', 0]]) {
  test(`Serie eines deaktivierten Kochs: eine Titelaenderung nimmt ihr den Koch nicht - ${fall}`, async () => {
    const EX = addUser(`Exkoch${von}`);
    const s = await serie(EX, { weeks: 2 });
    assert.equal(removeUser(db, EX).outcome, 'deactivated');
    assert.equal((await naechsteWoche(s)).cook_user_id, null, 'Vorbedingung: die Woche, die jetzt entsteht, hat keinen Koch');
    const vorher = { vorlage: `Exkoch${von}`, wochen: [`Exkoch${von}`, `Exkoch${von}`, '-'] };
    assert.deepEqual(zustand(s), { ...vorher, titel: ['Alt'] });

    const { gesendet } = await nurTitelFuerDieSerie(s, von);
    assert.ok(!('cook_user_id' in gesendet.body), `der Body traegt keinen Koch (gesendet: ${JSON.stringify(gesendet.body.cook_user_id)})`);
    assert.deepEqual(zustand(s), { ...vorher, titel: ['Neu'] }, 'Vorlage und Bestandsmahlzeiten behalten den Namen');

    // Nach der Reaktivierung kocht das Konto die naechste NEUE Woche wieder.
    db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(EX);
    assert.equal((await naechsteWoche(s)).cook_user_id, EX, 'die naechste neue Woche bekommt den Koch der Serie zurueck');
    assert.deepEqual(zustand(s).wochen, [`Exkoch${von}`, `Exkoch${von}`, '-', `Exkoch${von}`],
      'die Woche aus der Zeit der Deaktivierung bleibt ohne Koch');
  });
}

// --------------------------------------------------------------------------
// Die gewollten Faelle: jemand waehlt
// --------------------------------------------------------------------------

test('bewusste Wahl fuer die ganze Serie: Vorlage Anna, diese Woche Ben - ein Klick auf Ben gibt der Serie Ben', async () => {
  const s = await serie(ANNA, { einzeln: { 1: BEN, 2: CARLA } });
  const d = await dialog(s, 1);
  assert.equal(d.gezeigt(), 'Ben', 'der Dialog oeffnet mit dem Koch dieser Mahlzeit');
  d.umfang('series');
  assert.equal(d.gezeigt(), 'Anna', 'im Serien-Umfang steht der Koch der Serie da');
  d.tippen(BEN);
  assert.equal(d.beruehrt(), true);
  assert.equal(d.gezeigt(), 'Ben');

  const gesendet = await d.speichern();
  assert.equal(gesendet.status, 200);
  assert.equal(gesendet.body.cook_user_id, BEN);
  assert.deepEqual(zustand(s), { vorlage: 'Ben', wochen: ['Ben', 'Ben', 'Ben'], titel: ['Alt'] });
});

// Die Serie traegt Anna schon, einzelne Wochen weichen ab. "Anna fuer alle" ist
// trotzdem eine Wahl - der alte Vergleich "gleicht Mahlzeit und Vorlage" hielt
// sie fuer keine. Die Einzelauswahl kippt eine markierte Zeile beim Antippen
// auf "Niemand"; Anna ausdruecklich zu waehlen sind deshalb zwei Tipps.
test('"Anna fuer alle" von W1 aus, obwohl Mahlzeit und Vorlage Anna schon tragen: die Wahl erreicht jede Woche', async () => {
  const s = await serie(ANNA, { einzeln: { 1: BEN, 2: CARLA } });
  const d = await dialog(s, 0);
  d.umfang('series');
  assert.equal(d.gezeigt(), 'Anna');
  d.tippen(ANNA);
  assert.equal(d.gezeigt(), '-', 'die markierte Zeile anzutippen waehlt sie ab - sichtbar als "Niemand"');
  d.tippen(ANNA);
  assert.equal(d.gezeigt(), 'Anna');

  const gesendet = await d.speichern();
  assert.equal(gesendet.body.cook_user_id, ANNA, 'der Koch geht mit, obwohl er keinem gespeicherten Stand widerspricht');
  assert.deepEqual(zustand(s), { vorlage: 'Anna', wochen: ['Anna', 'Anna', 'Anna'], titel: ['Alt'] });
});

test('"Niemand" bewusst fuer die ganze Serie gewaehlt: die Serie verliert ihren Koch', async () => {
  const s = await serie(ANNA, { einzeln: { 1: BEN } });
  const d = await dialog(s, 0);
  d.umfang('series');
  d.tippen(null);
  const gesendet = await d.speichern();
  assert.ok('cook_user_id' in gesendet.body && gesendet.body.cook_user_id === null, '"Niemand" ist eine Angabe');
  assert.deepEqual(zustand(s), { vorlage: '-', wochen: ['-', '-', '-'], titel: ['Alt'] });
});

// --------------------------------------------------------------------------
// Der Wechsel des Umfangs
// --------------------------------------------------------------------------

test('Umfang hin und zurueck ohne Beruehrung: die Auswahl zeigt je Umfang den passenden Koch und setzt den Merker nicht', async () => {
  const s = await serie(ANNA, { einzeln: { 1: BEN, 2: CARLA } });
  const d = await dialog(s, 1);
  assert.equal(d.gezeigt(), 'Ben');
  d.umfang('series');
  assert.equal(d.gezeigt(), 'Anna', 'ganze Serie: der Koch der Vorlage');
  assert.equal(d.beruehrt(), false, 'das Umstellen ist keine Wahl');
  d.umfang('single');
  assert.equal(d.gezeigt(), 'Ben', 'nur diese Mahlzeit: wieder ihr eigener Koch');
  d.umfang('series');
  assert.equal(d.beruehrt(), false);

  const serienweit = await d.speichern();
  assert.ok(!('cook_user_id' in serienweit.body), 'im Serien-Umfang geht ohne Beruehrung kein Koch mit');
  assert.deepEqual(zustand(s), { vorlage: 'Anna', wochen: ['Anna', 'Ben', 'Carla'], titel: ['Alt'] });

  // Und zurueck auf "nur diese Mahlzeit" gespeichert: ihr eigener Koch, nicht der zwischendurch gezeigte.
  const e = await dialog(s, 1);
  e.umfang('series');
  e.umfang('single');
  const einzeln = await e.speichern();
  assert.equal(einzeln.path, `/meals/${s.ids[1]}`);
  assert.equal(einzeln.body.cook_user_id, BEN, 'der Koch dieser Mahlzeit, nicht der der Vorlage');
  assert.deepEqual(zustand(s).wochen, ['Anna', 'Ben', 'Carla']);
});

test('eine beruehrte Auswahl bleibt beim Wechsel des Umfangs stehen', async () => {
  const s = await serie(ANNA, { einzeln: { 1: BEN } });
  const d = await dialog(s, 1);
  d.tippen(CARLA);
  d.umfang('series');
  assert.equal(d.gezeigt(), 'Carla', 'die Wahl wird nicht vom Koch der Vorlage ueberschrieben');
  d.umfang('single');
  assert.equal(d.gezeigt(), 'Carla', 'und nicht vom Koch der Mahlzeit');
  d.umfang('series');
  assert.equal((await d.speichern()).body.cook_user_id, CARLA);
  assert.deepEqual(zustand(s), { vorlage: 'Carla', wochen: ['Carla', 'Carla', 'Carla'], titel: ['Alt'] });
});

// Ein Koch der Vorlage, der kein Mitglied (mehr) ist, hat keine Zeile in der
// Auswahl: sie nennt neben den Mitgliedern nur den gespeicherten Koch DIESER
// Mahlzeit. Dann bleibt beim Wechsel stehen, was da stand.
test('Koch der Vorlage nicht waehlbar: der Wechsel auf "ganze Serie" laesst die Auswahl, wie sie ist - und "nur diese Mahlzeit" speichert weiter', async () => {
  const EX = addUser('Exkoch9');
  const s = await serie(EX, { weeks: 2, einzeln: { 1: BEN } });
  removeUser(db, EX);

  const ben = await dialog(s, 1);
  ben.umfang('series');
  assert.equal(ben.gezeigt(), 'Ben', 'fuer den ehemaligen Koch der Vorlage gibt es keine Zeile - es bleibt der Koch der Mahlzeit');
  assert.equal(ben.beruehrt(), false);

  // An W1 steht der Ehemalige selbst: dort hat er eine Zeile, in beiden Umfaengen.
  const ex = await dialog(s, 0);
  assert.equal(ex.gezeigt(), 'Exkoch9');
  ex.umfang('series');
  assert.equal(ex.gezeigt(), 'Exkoch9');
  ex.umfang('single');
  ex.titel('Nur hier neu');
  const einzeln = await ex.speichern();
  assert.equal(einzeln.status, 200, 'ein unberuehrter, nicht mehr waehlbarer Koch loest bei "nur diese Mahlzeit" keine 400 aus');
  assert.equal(einzeln.body.cook_user_id, EX);
  assert.deepEqual(zustand(s).wochen, ['Exkoch9', 'Ben']);
});

// Scheiterte der Abruf der Mitglieder beim Laden der Seite, boete der Dialog
// nur "Niemand" an. Er holt die Liste beim Oeffnen nach und tauscht die Auswahl.
test('leere Mitgliederliste: der Dialog laedt sie beim Oeffnen nach und reicht die Auswahl nach', async () => {
  const s = await serie(ANNA);
  const meal = (await weekOf(s, 0)).find((m) => m.id === s.ids[0]);
  const mitglieder = (await call('GET', '/family/members')).body.data;
  const abrufe = [];
  globalThis.__apiStub = { get: async (path) => { abrufe.push(path); return { data: mitglieder }; } };

  const eingesetzt = [];
  const altesFeld = { insertAdjacentHTML: (wo, html) => eingesetzt.push([wo, html]), remove: () => eingesetzt.push(['remove']) };
  const knoten = () => ({
    value: '', checked: false, hidden: false, dataset: {}, style: {},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [], focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  const panel = { dataset: {}, querySelector: (sel) => (sel === '.meal-modal__cook' ? altesFeld : knoten()), querySelectorAll: () => [] };

  const oeffnen = async (members) => {
    Object.assign(meals.state, { members, meals: [meal], recipes: [], lists: [], categories: [], modal: null });
    let opened = null;
    globalThis.__openModal = (opts) => { opened = opts; };
    meals.openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
    opened.onSave(panel);
    await new Promise((r) => setTimeout(r, 0));
    return opened;
  };
  try {
    const leer = await oeffnen([]);
    assert.doesNotMatch(leer.content, /value="\d+"[^>]*data-ms-input="meal_cook"[\s\S]*Ben/, 'Vorbedingung: beim Oeffnen fehlen die Mitglieder');
    assert.deepEqual(abrufe, ['/family/members'], 'genau ein Nachladen');
    assert.equal(meals.state.members.length, mitglieder.length, 'in derselben Liste, die die Seite fuehrt');
    assert.equal(eingesetzt.length, 2, 'die Auswahl wird ersetzt');
    assert.equal(eingesetzt[0][0], 'afterend');
    assert.match(eingesetzt[0][1], /class="form-group meal-modal__cook"/);
    assert.match(eingesetzt[0][1], /<span class="user-ms__name">Ben<\/span>/, 'mit den Mitgliedern');
    assert.deepEqual(eingesetzt[1], ['remove']);

    // Gegenfall: mit geladener Liste kein Abruf und kein Tausch.
    abrufe.length = 0; eingesetzt.length = 0;
    await oeffnen(mitglieder);
    assert.deepEqual(abrufe, []);
    assert.deepEqual(eingesetzt, []);
  } finally {
    globalThis.__apiStub = undefined;
  }
});
