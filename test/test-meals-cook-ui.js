/**
 * Modul: Der Koch einer Mahlzeit - Oberflaeche (#1679)
 * Zweck: Der Koch ist in der Wochenansicht und in der Uebersichtskachel als
 *        Avatar zu sehen und wird im Mahlzeit-Dialog mit der Personenauswahl des
 *        Aufgabendialogs gewaehlt - begrenzt auf EINE Person. Bei `meals: read`
 *        (Nur-lesen-Oberflaeche seit #1731) bleibt er als Zeichen stehen: an der
 *        Karte und als Wert in der Leseansicht; eine Wahl gibt es dort nicht.
 *
 *        Gemessen am echten Markup und an den echten Handlern. Der Test-Loader
 *        stubt die Personenauswahl (`/components/user-multi-select.js`) fuer
 *        alle Suiten auf leeres Markup - hier haengt ueber seine Haken die
 *        ECHTE Komponente, sonst waere "der Avatar steht da" eine Aussage ueber
 *        den Stub.
 *
 *        Jeder Fall prueft sein Gegenstueck mit (ohne Koch, mit Schreibrecht):
 *        erschiene das Gesuchte dort nicht, waere der Aufbau des Tests kaputt,
 *        nicht die Regel erfuellt. Die Serverseite steht in test-meals-cook.js.
 * Ausfuehren: npm run test:meals-cook
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.CSS = globalThis.CSS ?? { escape: (value) => String(value) };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// utils/household.js spiegelt die Haushaltsgroesse als Klasse an die Wurzel;
// der Mini-DOM kennt dort kein `classList`.
globalThis.document.documentElement = globalThis.document.documentElement ?? {};
globalThis.document.documentElement.classList = globalThis.document.documentElement.classList
  ?? { add() {}, remove() {}, toggle() {}, contains: () => false };

// Die ECHTE Komponente hinter den Haken des Loaders (siehe Kopf).
const picker = await import('../public/components/user-multi-select.js');
globalThis.__renderUserMultiSelect = picker.renderUserMultiSelect;
globalThis.__renderAvatarStack = picker.renderAvatarStack;
globalThis.__getSelectedUserIds = picker.getSelectedUserIds;
globalThis.__bindUserMultiSelect = picker.bindUserMultiSelect;

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { setHouseholdSize, clearHouseholdSize } = await import('../public/utils/household.js');
const { toLocalDateKey } = await import('../public/utils/date.js');
const { __test: meals } = await import('../public/pages/meals.js');
const { __test: dashboard } = await import('../public/pages/dashboard.js');

const LESEN = { meals: 'read', shopping: 'read', pantry: 'read' };
const SCHREIBEN = { meals: 'write', shopping: 'write', pantry: 'write' };

async function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

const ANNA = { id: 1, display_name: 'Anna', avatar_color: '#FF9500', avatar_data: null };
const BEN = { id: 2, display_name: 'Ben', avatar_color: '#34C759', avatar_data: null };
const MITGLIEDER = [ANNA, BEN];

const MITTAG = { key: 'lunch', label: 'Mittag' };
const mahlzeit = (over = {}) => ({
  id: 11, title: 'Linsensuppe', date: '2026-10-07', meal_type: 'lunch', recipe_id: null,
  recipe_url: null, notes: null, recurrence_template_id: null, recurrence_end_date: null,
  cook_user_id: null, cook_name: null, cook_color: null,
  ingredients: [{ id: 1, name: 'Linsen', quantity: '200 g', category: 'Vorrat', on_shopping_list: 0 }],
  ...over,
});
const mitBen = (over = {}) => mahlzeit({ cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759', ...over });
const kachel = (meal) => meals.renderSlot('2026-10-07', MITTAG, [meal], 2, 2);

/** Der Abschnitt des Markups zwischen zwei Marken - leer, wenn die erste fehlt. */
function abschnitt(html, von, bis) {
  const start = html.indexOf(von);
  if (start < 0) return '';
  const ende = html.indexOf(bis, start + von.length);
  return html.slice(start, ende < 0 ? undefined : ende);
}

/** Den Zustand des Essensplans setzen und danach zuruecknehmen. */
async function mitPlan(patch, fn) {
  const zuvor = { ...meals.state };
  Object.assign(meals.state, {
    currentWeek: '2026-10-05', meals: [mahlzeit()], recipes: [], lists: [], categories: [], members: MITGLIEDER,
    loadError: null, modal: null, visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
  }, patch);
  try {
    return await fn();
  } finally {
    Object.assign(meals.state, zuvor);
    meals.setContainerForTest(null);
  }
}

/** Jeden API-Aufruf mit Pfad UND Body mitschreiben, statt ihn zu senden. */
async function aufrufe(fn, antworten = {}) {
  const liste = [];
  const zuvor = globalThis.__apiStub;
  const merke = (method) => async (path, body) => {
    liste.push({ method, path, body });
    return antworten[`${method} ${path}`] ?? { data: [] };
  };
  globalThis.__apiStub = {
    get: merke('GET'), post: merke('POST'), put: merke('PUT'), patch: merke('PATCH'), delete: merke('DELETE'),
  };
  try {
    await fn();
  } finally {
    globalThis.__apiStub = zuvor;
  }
  return liste;
}

/** Wer ein Modal oeffnet, kommt hier an - mit seinen Optionen. */
async function modalMitschnitt(fn) {
  const geoeffnet = [];
  const zuvor = globalThis.__openModal;
  globalThis.__openModal = (opts) => { geoeffnet.push(opts); };
  try {
    await fn();
  } finally {
    globalThis.__openModal = zuvor;
  }
  return geoeffnet;
}

// -------------------------------------------------------------------------
// Wochenansicht
// -------------------------------------------------------------------------

test('Wochenansicht: eine Mahlzeit mit Koch traegt seinen Avatar in der Meta-Zeile, mit Namen fuer Screenreader', async () => {
  const html = await withAccess(SCHREIBEN, () => kachel(mitBen()));
  const meta = abschnitt(html, 'class="meal-card__meta"', '</button>');
  assert.match(meta, /class="meal-card__cook"/, 'das Koch-Zeichen steht in der Meta-Zeile');
  assert.match(meta, /class="avatar-stack__item"/, 'als Avatar der geteilten Komponente');
  assert.match(meta, /background-color:#34C759/, 'in der Farbe der Person');
  assert.match(meta, /title="Ben"/);
  assert.match(meta, /<span class="sr-only">meals\.cookNamed\{&quot;name&quot;:&quot;Ben&quot;\}<\/span>/,
    'der Name geht als Satz mit - die Scheibe traegt ihn sonst nur als title');
  assert.match(meta, /meal-card__ingredients-count/, 'die Zutatenzahl bleibt daneben');
  assert.ok(meta.indexOf('meal-card__cook') < meta.indexOf('meal-card__ingredients-count'), 'der Avatar steht vor der Zutatenzahl');

  // Der Titel ist der knappste Platz der Karte: dort steht der Avatar nie.
  const titel = abschnitt(html, 'class="meal-card__title"', 'class="meal-card__meta"');
  assert.match(titel, /meal-card__title-text/, 'Vorbedingung: der Titelabschnitt wurde gefunden');
  assert.doesNotMatch(titel, /meal-card__cook|avatar-stack/, 'nicht in der Titelzeile');
});

test('Wochenansicht: ohne Koch rendert die Karte wie bisher', async () => {
  const html = await withAccess(SCHREIBEN, () => kachel(mahlzeit()));
  assert.doesNotMatch(html, /meal-card__cook|avatar-stack|meals\.cookNamed/);
  assert.match(html, /meal-card__ingredients-count/, 'Vorbedingung: die Karte hat ihre Meta-Zeile');

  const ohneAlles = await withAccess(SCHREIBEN, () => kachel(mahlzeit({ ingredients: [] })));
  assert.doesNotMatch(ohneAlles, /meal-card__meta/, 'ohne Koch und ohne Zutaten gibt es keine Meta-Zeile');
});

test('Wochenansicht: ein Koch ohne Zutaten bekommt seine eigene Meta-Zeile; ein Profilbild ersetzt die Initialen', async () => {
  const nurKoch = await withAccess(SCHREIBEN, () => kachel(mitBen({ ingredients: [] })));
  const meta = abschnitt(nurKoch, 'class="meal-card__meta"', '</button>');
  assert.match(meta, /meal-card__cook/);
  assert.doesNotMatch(meta, /meal-card__ingredients-count/);

  // DAS BILD KOMMT AUS DER MITGLIEDERLISTE, nicht aus der Mahlzeit: der Server
  // haengt es nicht mehr an jede Zeile der Woche. Die Mahlzeit nennt nur die id.
  const BEN_MIT_BILD = { ...BEN, avatar_data: 'data:image/png;base64,QkVO' };
  const karte = (modules, members) => withAccess(modules, () => mitPlan({ members }, () => kachel(mitBen())));
  const mitBild = await karte(SCHREIBEN, [ANNA, BEN_MIT_BILD]);
  assert.match(mitBild, /<img src="data:image\/png;base64,QkVO" alt="Ben"/, 'das Profilbild des Mitglieds steht an der Karte');
  assert.match(abschnitt(mitBild, 'class="meal-card__cook"', '</button>'), /<img src="data:image\/png;base64,QkVO"/, 'und zwar am Koch-Zeichen');
  assert.match(await karte(LESEN, [ANNA, BEN_MIT_BILD]), /<img src="data:image\/png;base64,QkVO" alt="Ben"/, 'auch bei `read`');

  // Ohne Bild am Mitglied, und fuer einen Koch, der in der Liste nicht steht
  // (ehemalig, Hauspersonal): die Initialen auf seiner Farbe, kein leeres Bild.
  for (const members of [MITGLIEDER, [ANNA], []]) {
    const ohneBild = await karte(SCHREIBEN, members);
    assert.match(ohneBild, /class="meal-card__cook"/, 'das Zeichen bleibt');
    assert.doesNotMatch(ohneBild, /<img src="data:/, 'kein Bild');
    assert.match(ohneBild, /background-color:#34C759/, 'die Farbe aus der Mahlzeit');
  }
  // Ein Bildfeld an der Mahlzeit selbst liest niemand mehr.
  assert.doesNotMatch(await withAccess(SCHREIBEN, () => mitPlan({}, () => kachel(mitBen({ cook_avatar: 'data:image/png;base64,QUxU' })))), /QUxU/);
});

test('Wochenansicht: der Name des Kochs laeuft durch esc()', async () => {
  const html = await withAccess(SCHREIBEN, () => kachel(mitBen({ cook_name: '<img src=x onerror=alert(1)>"' })));
  assert.doesNotMatch(html, /<img src=x/, 'kein rohes Markup aus dem Namen');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
});

test('Wochenansicht bei `read`: der Koch bleibt als Zeichen an der Karte', async () => {
  const html = await withAccess(LESEN, () => kachel(mitBen()));
  assert.match(html, /data-action="meal-details"/, 'Vorbedingung: die Karte ist die Lesefassung');
  assert.match(html, /class="meal-card__cook"/, 'der Koch ist Zustand und bleibt');
  assert.match(html, /meals\.cookNamed\{&quot;name&quot;:&quot;Ben&quot;\}/);
});

// -------------------------------------------------------------------------
// Uebersichtskachel
// -------------------------------------------------------------------------

test('Uebersicht: der Slot einer Mahlzeit mit Koch traegt den Avatar in der Kopfzeile, vor dem Symbol der Mahlzeitenart', () => {
  const html = dashboard.renderTodayMeals([
    { meal_type: 'lunch', title: 'Linsensuppe', cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759' },
    { meal_type: 'dinner', title: 'Pasta', cook_user_id: null, cook_name: null },
  ], ['lunch', 'dinner']);

  const mittag = abschnitt(html, 'data-type="lunch"', 'data-type="dinner"');
  const kopf = abschnitt(mittag, 'class="meal-slot__header"', 'class="meal-slot__title');
  assert.match(kopf, /class="meal-slot__cook"/, 'das Koch-Zeichen steht im Kopf des Slots');
  assert.match(kopf, /class="avatar-stack__item"/);
  assert.match(kopf, /background-color:#34C759/);
  assert.match(kopf, /<span class="sr-only">meals\.cookNamed\{&quot;name&quot;:&quot;Ben&quot;\}<\/span>/);
  assert.ok(kopf.indexOf('meal-slot__type') < kopf.indexOf('meal-slot__cook'), 'nach dem Typ-Label');
  assert.ok(kopf.indexOf('meal-slot__cook') < kopf.indexOf('meal-slot__icon'), 'vor dem Symbol');
  assert.doesNotMatch(abschnitt(mittag, 'class="meal-slot__title', '</div>'), /avatar-stack/, 'nicht in der Titelzeile');

  const abend = html.slice(html.indexOf('data-type="dinner"'));
  assert.match(abend, /Pasta/, 'Vorbedingung: der zweite Slot ist gezeichnet');
  assert.doesNotMatch(abend, /meal-slot__cook|avatar-stack|meals\.cookNamed/, 'ohne Koch rendert der Slot wie bisher');
});

test('Uebersicht, Heute-Blatt: die Zeile der Mahlzeit traegt den Koch als ihre Person', () => {
  // Alle drei Mahlzeitenarten, damit die Auswahl "was steht als Naechstes an"
  // zu jeder Uhrzeit eine Mahlzeit findet - der Test haengt nicht an der Uhr.
  const heute = (over) => ['breakfast', 'lunch', 'dinner'].map((meal_type, i) => ({
    id: 30 + i, meal_type, title: `Gericht ${i}`, cook_user_id: null, cook_name: null, cook_color: null, ...over,
  }));
  const zeile = (todayMeals, users) => dashboard.buildTodayProgram({ todayMeals, users }, { includeTasks: false, includeCalendar: false })
    .rows.find((row) => row.kind === 'meal');

  // Das Bild steht in `users` derselben Dashboard-Antwort, nicht an der Mahlzeit.
  const USERS = [{ id: 1, display_name: 'Anna', avatar_color: '#FF9500', avatar_data: null },
    { id: 2, display_name: 'Ben', avatar_color: '#34C759', avatar_data: 'data:image/png;base64,QkVO' }];
  const mit = zeile(heute({ cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759' }), USERS);
  assert.ok(mit, 'Vorbedingung: das Heute-Blatt hat seine Mahlzeit-Zeile');
  assert.deepEqual(mit.who, { id: 2, display_name: 'Ben', color: '#34C759', avatar_data: 'data:image/png;base64,QkVO' },
    'wen die Zeile angeht, ist der Koch - das Ueberlappungszeichen liest genau diese Person');
  assert.equal(zeile(heute({ cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759' })).who.avatar_data, null,
    'ohne `users` (oder fuer einen Koch, der dort nicht steht) bleiben die Initialen');

  // Die Kachel "Heute essen" nimmt denselben Weg.
  const slot = (users) => dashboard.renderTodayMeals(
    [{ meal_type: 'lunch', title: 'Suppe', cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759' }], ['lunch'], users);
  assert.match(abschnitt(slot(USERS), 'class="meal-slot__cook"', 'meal-slot__icon'), /<img src="data:image\/png;base64,QkVO" alt="Ben"/,
    'das Profilbild im Kopf des Slots');
  assert.doesNotMatch(slot([USERS[0]]), /<img src="data:/, 'ohne Eintrag in `users` kein Bild');
  assert.match(slot(undefined), /class="meal-slot__cook"/, 'und ohne Liste bleibt das Zeichen');

  const ohne = zeile(heute());
  assert.ok(ohne, 'Vorbedingung');
  assert.equal(ohne.who, null, 'ohne Koch bleibt die Zeile, wie sie war');
});

// renderTodayMeals() nimmt die Liste als Argument - ob die Kachel sie auch
// BEKOMMT, entscheidet der eine Aufruf in renderDashboardLayout(). Fehlte
// `data.users` dort, blieben alle Tests darueber gruen und die Kachel zeigte
// fuer jeden Koch nur noch Initialen (Review zu #1739).
test('Uebersicht: die Mahlzeiten-Kachel bekommt `users` der Dashboard-Antwort - das Profilbild des Kochs steht im Slot', () => {
  const USERS = [{ id: 1, display_name: 'Anna', avatar_color: '#FF9500', avatar_data: null },
    { id: 2, display_name: 'Ben', avatar_color: '#34C759', avatar_data: 'data:image/png;base64,QkVO' }];
  const todayMeals = [{ id: 31, meal_type: 'lunch', title: 'Suppe', cook_user_id: 2, cook_name: 'Ben', cook_color: '#34C759' }];
  const kachel = (data) => {
    const zuvor = globalThis.window.yuvomi;
    globalThis.window.yuvomi = null;
    try {
      return dashboard.renderDashboardLayout([{ id: 'meals', visible: true, size: '2x1' }], data, null, 'EUR', { visibleMealTypes: ['lunch'] });
    } finally {
      globalThis.window.yuvomi = zuvor;
    }
  };
  const slot = (html) => abschnitt(html, 'class="meal-slot__cook"', 'meal-slot__icon');

  const mit = kachel({ todayMeals, users: USERS });
  assert.match(mit, /data-type="lunch"/, 'Vorbedingung: die Kachel ist gezeichnet');
  assert.match(slot(mit), /<img src="data:image\/png;base64,QkVO" alt="Ben"/, 'das Bild aus `users` steht am Koch-Zeichen');

  // Gegenfall: ohne `users` (oder ohne Bild dort) die Initialen auf der Farbe.
  const ohne = kachel({ todayMeals });
  assert.ok(slot(ohne), 'das Zeichen bleibt');
  assert.doesNotMatch(ohne, /<img src="data:/);
});

// Entschieden zu #1737: Kochen ist eine Zustaendigkeit wie eine Aufgabe, also
// zaehlt der Koch am Wandtablett unter "Wer heute dran ist" mit. Der Abschnitt
// zaehlt `who` ueber alle Zeilen des Tages; faellt `who` an der Mahlzeit-Zeile
// weg, verschwindet, wer heute NUR kocht, ohne dass sonst etwas rot wuerde.
test('Wandtablett, "Wer heute dran ist": der Koch der heutigen Mahlzeit zaehlt mit', () => {
  const heute = (over) => ['breakfast', 'lunch', 'dinner'].map((meal_type, i) => ({
    id: 30 + i, meal_type, title: `Gericht ${i}`, cook_user_id: null, cook_name: null, cook_color: null, ...over,
  }));
  const ANNA_WAND = { id: 1, display_name: 'Anna Beispiel', avatar_color: '#FF9500', avatar_data: null };
  const BEN_WAND = { id: 2, display_name: 'Ben Beispiel', avatar_color: '#34C759', avatar_data: null };
  const wer = (todayMeals, urgentTasks = []) => {
    // Ohne App-Huelle, wie test-dashboard.js die Wand rendert: `window.yuvomi`
    // traegt hier nur den Toast-Stub, keine Modul-Abfrage.
    const zuvor = globalThis.window.yuvomi;
    globalThis.window.yuvomi = null;
    try {
      const html = dashboard.renderWallSurface({ todayMeals, urgentTasks, users: [ANNA_WAND, BEN_WAND] }, null, {});
      return abschnitt(html, 'class="wall__who"', '</section>');
    } finally {
      globalThis.window.yuvomi = zuvor;
    }
  };
  const mitglieder = (html) => [...html.matchAll(/<span aria-hidden="true">(\d+)<\/span>[\s\S]*?<span class="wall-who__name">([^<]*)<\/span>/g)]
    .map((m) => `${m[2]}:${m[1]}`);

  setHouseholdSize(2);
  try {
    const nurKoch = wer(heute({ cook_user_id: 2, cook_name: 'Ben Beispiel', cook_color: '#34C759' }));
    assert.ok(nurKoch, 'Vorbedingung: der Abschnitt ist gebaut');
    assert.deepEqual(mitglieder(nurKoch), ['Ben:1'], 'wer heute nur kocht, ist heute dran - mit einer Sache');
    assert.doesNotMatch(nurKoch, /wall-who__none/);

    // Kochen zaehlt NEBEN einer Aufgabe, nicht statt ihrer.
    const aufgabe = { id: 5, title: 'Muell', status: 'open', due_date: toLocalDateKey(new Date()), due_time: '08:00', assigned_users: [{ id: 2, display_name: 'Ben Beispiel', color: '#34C759' }] };
    const beides = wer(heute({ cook_user_id: 2, cook_name: 'Ben Beispiel', cook_color: '#34C759' }), [aufgabe]);
    const ohneKochen = wer(heute(), [aufgabe]);
    assert.deepEqual(mitglieder(ohneKochen), ['Ben:1'], 'Vorbedingung: die Aufgabe allein zaehlt eins');
    assert.deepEqual(mitglieder(beides), ['Ben:2'], 'Aufgabe und Kochen sind zwei Dinge');

    // Gegenfall: ohne Koch ist niemand dran.
    const niemand = wer(heute());
    assert.match(niemand, /wall-who__none/, 'eine Mahlzeit ohne Koch setzt niemanden auf die Liste');
    assert.deepEqual(mitglieder(niemand), []);
  } finally {
    clearHouseholdSize();
  }
});

test('Uebersicht: der Name des Kochs laeuft durch esc()', () => {
  const html = dashboard.renderTodayMeals([
    { meal_type: 'lunch', title: 'Suppe', cook_user_id: 2, cook_name: '"><script>x</script>', cook_color: '#34C759' },
  ], ['lunch']);
  // Als Teilstring geprueft, nicht per Regex: gesucht ist genau die Zeichenfolge
  // aus dem Namen oben, kein Filter fuer Markup.
  assert.ok(!html.includes('<script'), 'kein rohes Markup aus dem Namen');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;x&lt;/script&gt;'), 'der Name steht escaped da');
});

// -------------------------------------------------------------------------
// Leseansicht bei `read`
// -------------------------------------------------------------------------

test('Leseansicht bei `read`: der Koch steht als Wert da - mit Avatar und Namen, ohne Auswahl', async () => {
  const offen = (modules, meal) => withAccess(modules, () => mitPlan({ meals: [meal] }, () => modalMitschnitt(
    () => meals.openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type }),
  )));

  const [lesend, ...mehr] = await offen(LESEN, mitBen());
  assert.ok(lesend && !mehr.length, 'genau ein Dialog');
  assert.match(lesend.content, /data-view="read"/, 'Vorbedingung: es ist die Leseansicht');
  const zeile = abschnitt(lesend.content, 'data-lucide="cooking-pot"', 'data-lucide="list"');
  assert.match(zeile, /meals\.cookLabel/, 'die Zeile ist beschriftet');
  assert.match(zeile, /class="meal-read__cook"/);
  assert.match(zeile, /class="avatar-stack__item"/, 'der Avatar');
  assert.match(zeile, /<span>Ben<\/span>/, 'und der Name ausgeschrieben');
  assert.doesNotMatch(lesend.content, /user-ms|data-ms-input|<input|<select|<button/, 'keine Auswahl und keine Eingabe');

  const [ohneKoch] = await offen(LESEN, mahlzeit());
  assert.match(ohneKoch.content, /data-view="read"/);
  assert.doesNotMatch(ohneKoch.content, /meals\.cookLabel|cooking-pot/, 'ohne Koch keine Zeile - ein Strich waere ein Wert, den es nicht gibt');

  // Gegenfall: mit Schreibrecht ist es der Editor mit der Auswahl.
  const [editor] = await offen(SCHREIBEN, mitBen());
  assert.doesNotMatch(editor.content, /data-view="read"/);
  assert.match(editor.content, /class="user-ms" data-ms-name="meal_cook"/);
});

// Die Wochenkarte und die Uebersicht messen `esc()` am Namen je selbst; die
// Leseansicht schreibt ihn an einer DRITTEN Stelle aus, und zwar als sichtbaren
// Text. Ohne `esc()` dort blieb jeder der beiden anderen Tests gruen.
test('Leseansicht bei `read`: der Name des Kochs laeuft durch esc()', async () => {
  const meal = mitBen({ cook_name: 'Ben"><img src=x onerror=alert(1)>&<b>' });
  const [lesend] = await withAccess(LESEN, () => mitPlan({ meals: [meal] }, () => modalMitschnitt(
    () => meals.openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type }),
  )));
  assert.match(lesend.content, /data-view="read"/, 'Vorbedingung: es ist die Leseansicht');
  const zeile = abschnitt(lesend.content, 'class="meal-read__cook"', 'data-lucide="list"');
  assert.ok(zeile, 'Vorbedingung: die Koch-Zeile ist da');
  assert.ok(zeile.includes('<span>Ben&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&lt;b&gt;</span>'),
    'der ausgeschriebene Name steht escaped da');
  assert.doesNotMatch(lesend.content, /<img src=x|<b>/, 'und nirgends im Dialog roh');
});

// Ein Abruf, der scheitert, ist kein Haushalt ohne Mitglieder. Der leere
// Fallback behauptete genau das - der Dialog bot nur noch "Niemand" an, und
// nichts sagte, warum.
test('loadMembers: ein gescheiterter Abruf wird gemeldet und loescht die geladene Liste nicht', async () => {
  const gemeldet = [];
  const zuvorError = console.error;
  const zuvorStub = globalThis.__apiStub;
  console.error = (...args) => { gemeldet.push(args); };
  const fehler = Object.assign(new Error('Netz weg'), { status: 503 });
  globalThis.__apiStub = { get: async () => { throw fehler; } };
  let members;
  try {
    members = await withAccess(SCHREIBEN, () => mitPlan({ members: MITGLIEDER }, async () => {
      await meals.loadMembers();
      return meals.state.members;
    }));
  } finally {
    console.error = zuvorError;
    globalThis.__apiStub = zuvorStub;
  }
  assert.equal(gemeldet.length, 1, 'der Fehler wird nicht still geschluckt');
  assert.ok(gemeldet[0].includes(fehler), 'gemeldet wird der Fehler selbst');
  assert.deepEqual(members, MITGLIEDER, 'die schon geladene Liste bleibt - kein "es gibt keine Mitglieder"');
});

test('die Mitgliederliste kommt aus /family/members - auch bei `read`, wo sie das Bild des Kochs traegt', async () => {
  const laden = (modules) => withAccess(modules, () => mitPlan({ members: [{ id: 99 }] }, async () => {
    const liste = await aufrufe(() => meals.loadMembers(), { 'GET /family/members': { data: MITGLIEDER } });
    return { pfade: liste.map((a) => `${a.method} ${a.path}`), members: meals.state.members };
  }));

  // Bei `read` gibt es keine Wahl (die Leseansicht hat keine Auswahl), die
  // Liste traegt aber das Profilbild, das nicht mehr an jeder Mahlzeit haengt.
  const lesend = await laden(LESEN);
  assert.deepEqual(lesend.pfade, ['GET /family/members'], 'EIN Abruf fuer die ganze Seite, keiner je Mahlzeit');
  assert.deepEqual(lesend.members, MITGLIEDER);

  const schreibend = await laden(SCHREIBEN);
  assert.deepEqual(schreibend.pfade, ['GET /family/members'], 'die eine Mitgliederliste (householdMemberSql)');
  assert.deepEqual(schreibend.members, MITGLIEDER);
});

// -------------------------------------------------------------------------
// Dialog: die Auswahl
// -------------------------------------------------------------------------

/** Die Optionen einer gerenderten Auswahl: [{ value, checked, name }]. */
function optionen(html) {
  const widget = abschnitt(html, 'data-ms-name="meal_cook"', 'id="ingredient-list"');
  return [...widget.matchAll(/<input type="checkbox" class="user-ms__checkbox([^"]*)" value="([^"]*)"([^>]*)>[\s\S]*?<span class="user-ms__name">([^<]*)<\/span>/g)]
    .map((m) => ({ value: m[2], checked: /\bchecked\b/.test(m[3]), name: m[4], none: m[1].includes('user-ms__none') }));
}

test('Dialog: die Koch-Auswahl ist die Personenauswahl - Mitglieder plus "Niemand", der gespeicherte Koch gewaehlt', async () => {
  const bauen = (opts) => withAccess(SCHREIBEN, () => mitPlan({}, () => meals.buildModalContent(opts)));

  const neu = await bauen({ mode: 'create', date: '2026-10-07', mealType: 'lunch' });
  assert.match(neu, /<label class="label">meals\.cookLabel<\/label>/, 'mit eigener Beschriftung');
  assert.deepEqual(optionen(neu), [
    { value: '', checked: true, name: 'userMultiSelect.nobody', none: true },
    { value: '1', checked: false, name: 'Anna', none: false },
    { value: '2', checked: false, name: 'Ben', none: false },
  ], 'eine neue Mahlzeit hat niemanden');
  assert.ok(neu.indexOf('data-ms-name="meal_cook"') < neu.indexOf('id="ingredient-list"'),
    'die Auswahl steht im Hauptteil des Dialogs, nicht unter "Erweitert"');

  const meal = mitBen();
  const bearbeiten = await bauen({ mode: 'edit', date: meal.date, mealType: 'lunch', meal });
  assert.deepEqual(optionen(bearbeiten).filter((o) => o.checked).map((o) => o.name), ['Ben'], 'der gespeicherte Koch ist gewaehlt');
});

test('Dialog: ein gespeicherter Koch, der kein Mitglied (mehr) ist, steht in der Auswahl - sonst naehme das Speichern ihn still heraus', async () => {
  const meal = mitBen({ cook_user_id: 7, cook_name: 'Clara', cook_color: '#5856D6' });
  const html = await withAccess(SCHREIBEN, () => mitPlan({}, () => meals.buildModalContent({ mode: 'edit', date: meal.date, mealType: 'lunch', meal })));
  assert.deepEqual(optionen(html).map((o) => [o.name, o.checked]), [
    ['userMultiSelect.nobody', false], ['Anna', false], ['Ben', false], ['Clara', true],
  ]);
  // Neu angeboten wird sie nicht: an einer anderen Mahlzeit fehlt sie.
  const andere = await withAccess(SCHREIBEN, () => mitPlan({}, () => meals.buildModalContent({ mode: 'edit', date: meal.date, mealType: 'lunch', meal: mahlzeit() })));
  assert.deepEqual(optionen(andere).map((o) => o.name), ['userMultiSelect.nobody', 'Anna', 'Ben']);
});

// R17 Schritt 5 (Critique 2026-10-07, A4 P2): "Mahlzeit bearbeiten" war mobil
// 1899px lang, "Aenderung anwenden auf" stand bei y 1813 hinter "Weitere
// Einstellungen". Der Umfang entscheidet, was Speichern tut - er steht oben.
// Die Zutaten sind beim Bearbeiten eingeklappt und nennen ihre Zahl.
async function dialogMitAbschnitten(opts) {
  const abschnitte = [];
  const vorher = globalThis.__advancedSection;
  globalThis.__advancedSection = (inner, options) => {
    abschnitte.push({ inner, options });
    return `<!--abschnitt-${abschnitte.length - 1}-->`;
  };
  try {
    const html = await withAccess(SCHREIBEN, () => mitPlan({}, () => meals.buildModalContent(opts)));
    return { html, abschnitte };
  } finally {
    if (vorher === undefined) delete globalThis.__advancedSection; else globalThis.__advancedSection = vorher;
  }
}

test('Dialog einer Serie: der Umfang steht als Erstes im Dialog, nicht hinter "Weitere Einstellungen"', async () => {
  const serie = mahlzeit({ recurrence_template_id: 5, recurrence_end_date: '2026-12-31' });
  const { html, abschnitte } = await dialogMitAbschnitten({ mode: 'edit', date: serie.date, mealType: 'lunch', meal: serie });
  const umfang = html.indexOf('id="modal-edit-scope"');
  assert.ok(umfang >= 0, 'der Umfang steht im sichtbaren Teil');
  for (const marke of ['id="modal-date"', 'id="modal-title"', 'data-ms-name="meal_cook"', '<!--abschnitt-0-->']) {
    assert.ok(html.indexOf(marke) > umfang, `der Umfang steht vor ${marke}`);
  }
  assert.ok(html.indexOf('meal-recurrence-note') >= 0 && html.indexOf('meal-recurrence-note') < umfang, 'der Serienhinweis geht voran');
  const ende = html.indexOf('id="modal-repeat-until-group" hidden');
  assert.ok(ende > umfang && ende < html.indexOf('id="modal-date"'), 'das Wiederholungs-Ende bleibt beim Umfang, verborgen bis "Serie"');
  assert.equal((html.match(/id="modal-edit-scope"/g) ?? []).length, 1, 'genau EIN Umfang-Feld');
  for (const a of abschnitte) {
    assert.doesNotMatch(a.inner, /modal-edit-scope|modal-repeat-until/, 'in keinem Aufklapper steht noch ein Stueck davon');
  }
  const erweitert = abschnitte.find((a) => /id="modal-recipe-id"/.test(a.inner));
  assert.equal(erweitert.options.open, false, 'die Serie allein oeffnet "Weitere Einstellungen" nicht mehr');

  // Gegenfall: ohne Serie gibt es keinen Umfang, und Anlegen behaelt den Schalter.
  const einzel = await dialogMitAbschnitten({ mode: 'edit', date: serie.date, mealType: 'lunch', meal: mahlzeit() });
  assert.doesNotMatch(einzel.html + einzel.abschnitte.map((a) => a.inner).join(''), /modal-edit-scope/);
  const neu = await dialogMitAbschnitten({ mode: 'create', date: serie.date, mealType: 'lunch' });
  assert.match(neu.abschnitte.map((a) => a.inner).join(''), /id="modal-repeat-weekly"/, 'Anlegen: "Woechentlich wiederholen" bleibt, wo es war');
});

test('Dialog: die Zutaten sind beim Bearbeiten eingeklappt und nennen ihre Zahl - beim Anlegen und ohne Zutaten stehen sie offen', async () => {
  const drei = mahlzeit({ ingredients: [1, 2, 3].map((id) => ({ id, name: `Zutat ${id}`, quantity: '', category: 'Vorrat', on_shopping_list: 1 })) });
  const { html, abschnitte } = await dialogMitAbschnitten({ mode: 'edit', date: drei.date, mealType: 'lunch', meal: drei });
  const zutaten = abschnitte.find((a) => /id="ingredient-list"/.test(a.inner));
  assert.ok(zutaten, 'die Zutaten stehen im geteilten Aufklapper');
  assert.equal(zutaten.options.label, 'meals.ingredientsLabel · 3', 'er nennt die Zahl');
  assert.ok(!zutaten.options.open, 'und startet geschlossen');
  assert.match(zutaten.inner, /id="add-ingredient-btn"/, '"Zutat hinzufuegen" steht bei der Liste');
  assert.equal((zutaten.inner.match(/class="ingredient-row/g) ?? []).length, 3);
  assert.match(html, /<div class="meal-ingredients-fold" id="modal-ingredients-fold">\s*<!--abschnitt-0-->/, 'vor "Weitere Einstellungen"');

  for (const [name, opts] of [
    ['Anlegen', { mode: 'create', date: drei.date, mealType: 'lunch' }],
    ['Bearbeiten ohne Zutaten', { mode: 'edit', date: drei.date, mealType: 'lunch', meal: mahlzeit({ ingredients: [] }) }],
  ]) {
    const offen = await dialogMitAbschnitten(opts);
    assert.match(offen.html, /<label class="form-label">meals\.ingredientsLabel<\/label>\s*<div class="ingredient-list" id="ingredient-list">/, `${name}: Liste offen im Dialog`);
    assert.ok(!offen.abschnitte.some((a) => /id="ingredient-list"/.test(a.inner)), `${name}: nicht im Aufklapper`);
  }
});

test('Dialog im Solo-Haushalt: die Auswahl ist verborgen, nicht entfernt', async () => {
  const feld = (html) => html.match(/<div class="form-group meal-modal__cook"([^>]*)>/)?.[1];
  const bauen = (members, meal = null) => withAccess(SCHREIBEN, () => mitPlan({ members }, () => meals.buildModalContent(
    meal ? { mode: 'edit', date: meal.date, mealType: 'lunch', meal } : { mode: 'create', date: '2026-10-07', mealType: 'lunch' },
  )));
  try {
    setHouseholdSize(1);
    const solo = await bauen([ANNA]);
    assert.match(feld(solo), /\bhidden\b/, 'eine Reihe aus der Nutzerin selbst und "Niemand" fragt nichts');
    assert.match(solo, /data-ms-name="meal_cook"/, 'das Feld bleibt im DOM - der Absende-Pfad liest es');
    // Steht schon jemand anderes an der Mahlzeit, gibt es eine echte Wahl.
    assert.doesNotMatch(feld(await bauen([ANNA], mitBen())), /\bhidden\b/);

    setHouseholdSize(2);
    assert.equal(feld(await bauen(MITGLIEDER)), '', 'Gegenfall: im Mehrpersonenhaushalt steht sie da');
  } finally {
    clearHouseholdSize();
  }
});

// -------------------------------------------------------------------------
// Dialog: eine Person, nicht mehrere
// -------------------------------------------------------------------------

/** Ein Auswahl-Widget aus Stub-Checkboxen, an dem der echte Handler haengt. */
function auswahl(namen) {
  const box = (klasse, value, checked = false) => ({
    value, checked, klasse,
    matches: (sel) => sel === '.user-ms__checkbox',
    classList: { contains: (c) => klasse.split(' ').includes(c) },
  });
  const none = box('user-ms__checkbox user-ms__none', '', true);
  const personen = namen.map((name, i) => box('user-ms__checkbox', String(i + 1)));
  const alle = [none, ...personen];
  let handler = null;
  const widget = {
    addEventListener: (typ, fn) => { if (typ === 'change') handler = fn; },
    querySelector: (sel) => {
      if (sel === '.user-ms__none') return none;
      if (sel === '.user-ms__checkbox:checked') return alle.find((b) => b.checked) ?? null;
      throw new Error(`unerwarteter Selektor ${sel}`);
    },
    querySelectorAll: (sel) => {
      if (sel === '.user-ms__checkbox:not(.user-ms__none)') return personen;
      throw new Error(`unerwarteter Selektor ${sel}`);
    },
  };
  const container = { querySelector: (sel) => (sel.includes('data-ms-name="meal_cook"') ? widget : null) };
  return {
    container,
    /** Wie ein Klick: Zustand umschalten, dann das change-Ereignis. */
    tippen(index) {
      const ziel = index === 'none' ? none : personen[index];
      ziel.checked = !ziel.checked;
      handler({ target: ziel });
    },
    gewaehlt: () => alle.filter((b) => b.checked).map((b) => (b === none ? 'none' : namen[personen.indexOf(b)])),
    verdrahtet: () => handler !== null,
  };
}

test('Auswahl mit `single`: eine neue Wahl loest die vorige ab, und Abwaehlen fuehrt zu "Niemand" zurueck', () => {
  const a = auswahl(['Anna', 'Ben', 'Cem']);
  picker.bindUserMultiSelect(a.container, 'meal_cook', { single: true });
  assert.ok(a.verdrahtet(), 'Vorbedingung: der Handler haengt am Widget');
  assert.deepEqual(a.gewaehlt(), ['none']);

  a.tippen(0);
  assert.deepEqual(a.gewaehlt(), ['Anna'], '"Niemand" faellt mit der ersten Wahl');
  a.tippen(1);
  assert.deepEqual(a.gewaehlt(), ['Ben'], 'eine Mahlzeit hat EINEN Koch: Ben loest Anna ab');
  a.tippen(1);
  assert.deepEqual(a.gewaehlt(), ['none'], 'den Gewaehlten abzuwaehlen heisst "Niemand" - keine Reihe ohne Markierung');
  a.tippen(2);
  a.tippen('none');
  assert.deepEqual(a.gewaehlt(), ['none'], '"Niemand" leert die Auswahl');

  // Gegenfall: ohne `single` bleibt es die Mehrfachauswahl der Aufgaben.
  const mehrfach = auswahl(['Anna', 'Ben', 'Cem']);
  picker.bindUserMultiSelect(mehrfach.container, 'meal_cook');
  mehrfach.tippen(0);
  mehrfach.tippen(1);
  assert.deepEqual(mehrfach.gewaehlt(), ['Anna', 'Ben']);
});

test('Dialog: openMealModal verdrahtet die Koch-Auswahl als Einzelauswahl', async () => {
  const bindungen = [];
  const zuvor = globalThis.__bindUserMultiSelect;
  globalThis.__bindUserMultiSelect = (...args) => { bindungen.push(args); };
  const knoten = () => ({
    value: '', checked: false, hidden: false, dataset: {}, style: {},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [], focus() {},
  });
  const panel = { dataset: {}, querySelector: () => knoten(), querySelectorAll: () => [] };
  try {
    const [dialog] = await withAccess(SCHREIBEN, () => mitPlan({}, () => modalMitschnitt(
      () => meals.openMealModal({ mode: 'create', date: '2026-10-07', mealType: 'lunch' }),
    )));
    assert.ok(dialog, 'Vorbedingung: der Editor ist aufgegangen');
    dialog.onSave(panel);
  } finally {
    globalThis.__bindUserMultiSelect = zuvor;
  }
  assert.equal(bindungen.length, 1, 'genau eine Personenauswahl wird verdrahtet');
  const [gebunden, name, optionenArg] = bindungen[0];
  assert.equal(gebunden, panel);
  assert.equal(name, 'meal_cook');
  assert.deepEqual(optionenArg, { single: true });
});

// -------------------------------------------------------------------------
// Dialog: was beim Speichern rausgeht
// -------------------------------------------------------------------------

/** Das Formular als Stub: die Felder des Dialogs und die gewaehlte Koch-Checkbox. */
function formular({ koch = null, scope = null, titel = 'Linsensuppe' } = {}) {
  const felder = {
    '#modal-save': { disabled: false, textContent: '' },
    '#modal-date': { value: '2026-10-07' }, '#modal-type': { value: 'lunch' }, '#modal-title': { value: titel },
    '#modal-notes': { value: '' }, '#modal-recipe-url': { value: '' },
    ...(scope ? { '#modal-edit-scope': { value: scope } } : {}),
  };
  return {
    querySelector: (sel) => felder[sel] ?? null,
    querySelectorAll: (sel) => (
      sel === '[data-ms-input="meal_cook"]:not(.user-ms__none):checked' && koch !== null ? [{ value: String(koch) }] : []
    ),
  };
}

async function speichern({ modal, form }) {
  const liste = await withAccess(SCHREIBEN, () => mitPlan({ meals: modal.meal ? [modal.meal] : [] }, () => {
    meals.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
    return aufrufe(async () => {
      meals.state.modal = modal;
      await meals.saveModal(form);
    }, { 'POST /meals': { data: mahlzeit({ id: 12 }) } });
  }));
  return liste.filter((a) => a.method !== 'GET');
}

test('Speichern: eine neue Mahlzeit schickt den gewaehlten Koch mit - oder null', async () => {
  const [mitKoch, ...mehr] = await speichern({ modal: { mode: 'create' }, form: formular({ koch: 2 }) });
  assert.ok(mitKoch && !mehr.length, 'genau ein Schreibaufruf');
  assert.equal(`${mitKoch.method} ${mitKoch.path}`, 'POST /meals');
  assert.equal(mitKoch.body.cook_user_id, 2);
  assert.equal(mitKoch.body.title, 'Linsensuppe', 'Vorbedingung: der Body ist der des Dialogs');

  const [ohneKoch] = await speichern({ modal: { mode: 'create' }, form: formular() });
  assert.equal(ohneKoch.body.cook_user_id, null, '"Niemand" geht als null raus');
  assert.ok('cook_user_id' in ohneKoch.body);
});

test('Speichern: nur diese Mahlzeit - der Koch geht immer mit, auch als null', async () => {
  const meal = mitBen({ ingredients: [] });
  const [gewechselt] = await speichern({ modal: { mode: 'edit', meal }, form: formular({ koch: 1 }) });
  assert.equal(`${gewechselt.method} ${gewechselt.path}`, 'PUT /meals/11');
  assert.equal(gewechselt.body.cook_user_id, 1);

  const [entfernt] = await speichern({ modal: { mode: 'edit', meal }, form: formular() });
  assert.equal(entfernt.path, '/meals/11');
  assert.equal(entfernt.body.cook_user_id, null, 'den Koch herauszunehmen ist eine Angabe, kein fehlendes Feld');
});

// Die Senderegel fuer "ganze Serie", am Absendeweg allein: der Koch geht NUR
// mit, wenn ihn jemand in diesem Dialog gewaehlt hat (`cookTouched`). Welcher
// Koch an der Mahlzeit oder an der Vorlage steht, spielt keine Rolle - aus den
// gespeicherten Staenden laesst sich "gewaehlt" nicht von "gezeigt"
// unterscheiden. Klick, Umfang-Wechsel und der Endzustand je Woche ueber den
// echten Router stehen in test-meals-cook-series.js.
test('Speichern mit Serien-Umfang: der Koch geht nur mit, wenn er in diesem Dialog gewaehlt wurde', async () => {
  const serienBody = async (meal, form, cookTouched) => {
    const [put, ...mehr] = await speichern({ modal: { mode: 'edit', meal, ...(cookTouched === undefined ? {} : { cookTouched }) }, form });
    assert.ok(put && !mehr.length, 'genau ein Schreibaufruf');
    assert.equal(`${put.method} ${put.path}`, 'PUT /meals/11?scope=series');
    return put.body;
  };
  const gleich = mitBen({ recurrence_template_id: 4, recurrence_cook_user_id: 2, ingredients: [] });
  const abweichend = mitBen({ recurrence_template_id: 4, recurrence_cook_user_id: 1, ingredients: [] });
  const ohne = mahlzeit({ recurrence_template_id: 4, recurrence_cook_user_id: 1, ingredients: [] });

  // Unberuehrt: nichts geht mit - gleich, welcher Stand wovon abweicht.
  for (const [fall, meal, koch] of [
    ['Mahlzeit und Vorlage gleich', gleich, 2],
    ['Mahlzeit weicht von der Vorlage ab', abweichend, 2],
    ['Mahlzeit ohne Koch, Vorlage mit', ohne, null],
    ['die Auswahl zeigt den Koch der Vorlage', abweichend, 1],
  ]) {
    for (const merker of [false, undefined]) {
      const body = await serienBody(meal, formular({ koch, scope: 'series', titel: 'Neuer Titel' }), merker);
      assert.equal(body.title, 'Neuer Titel', `${fall}: Vorbedingung, die Serienaenderung geht raus`);
      assert.ok(!('cook_user_id' in body), `${fall} (cookTouched ${merker}): kein Koch im Body`);
    }
  }

  // Beruehrt: es geht mit, was gewaehlt ist - auch wenn es keinem Stand widerspricht.
  assert.equal((await serienBody(gleich, formular({ koch: 2, scope: 'series' }), true)).cook_user_id, 2, 'derselbe Koch, bewusst fuer alle');
  assert.equal((await serienBody(abweichend, formular({ koch: 1, scope: 'series' }), true)).cook_user_id, 1);
  const geleert = await serienBody(gleich, formular({ scope: 'series' }), true);
  assert.ok('cook_user_id' in geleert && geleert.cook_user_id === null, '"Niemand" ist eine Angabe');

  // "Nur diese Mahlzeit" bleibt, wie es war: der Koch geht immer mit, beruehrt oder nicht.
  const [einzeln] = await speichern({ modal: { mode: 'edit', meal: abweichend }, form: formular({ koch: 2 }) });
  assert.equal(einzeln.path, '/meals/11');
  assert.equal(einzeln.body.cook_user_id, 2);
});

// -------------------------------------------------------------------------
// Stylesheets: was das Markup nennt, hat eine Regel
// -------------------------------------------------------------------------

test('Stylesheets: die Koch-Zeichen schrumpfen nicht, und der Avatar der Kachel steht am Ende des Kopfs', () => {
  const regel = (datei, selektor) => {
    const css = readFileSync(new URL(`../public/styles/${datei}`, import.meta.url), 'utf8');
    for (const { selector, body, at } of eachRule(css)) {
      if (!at.length && selector.split(',').map((part) => part.trim()).includes(selektor)) return body;
    }
    return null;
  };
  const karte = regel('meals.css', '.meal-card__cook');
  assert.ok(karte, '.meal-card__cook hat eine Regel in meals.css');
  assert.match(karte, /flex:\s*none/, 'die Scheibe bleibt neben einer langen Zutatenzahl rund');

  const slot = regel('dashboard.css', '.meal-slot__cook');
  assert.ok(slot, '.meal-slot__cook hat eine Regel in dashboard.css');
  assert.match(slot, /flex:\s*none/);
  assert.match(slot, /margin-inline-start:\s*auto/, 'sonst setzte space-between den Avatar in die Mitte des Kopfs');

  assert.ok(regel('meals.css', '.meal-read__cook'), '.meal-read__cook hat eine Regel in meals.css');
});
