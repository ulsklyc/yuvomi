/**
 * Modul: Nur-lesen im Essensplan und in den Rezepten (#1265)
 * Zweck: `meals.js` und `recipes.js` zeichneten einem Mitglied mit
 *        `meals: read` jede Schreib-Geste - Anlegen (FAB, Tagesknopf, leerer
 *        Platz, Leerzustand, Rezept-Spalte), Bearbeiten, Loeschen, Ziehen,
 *        Zufallsplan, Duplizieren, „In den Essensplan" und die
 *        Vorrats-Zuordnung. Der Server antwortete 403; das optimistische
 *        Verschieben sprang zurueck, das Loeschen kam nach dem
 *        Rueckgaengig-Fenster als Fehler wieder.
 *
 *        Die Regel (Kopf von public/utils/module-access.js):
 *          - Handlungen verschwinden, der Zustand bleibt (Regel 2). Ziehen hat
 *            kein Markup und bleibt deshalb UNVERDRAHTET (Regel 3).
 *          - Eine Mahlzeit oeffnet bei `read` eine Leseansicht mit allem, was
 *            der Editor zeigt (Regel 9). Ein Rezept fuehrt per Tipp schon
 *            immer in sein Detail - was nur im Formular stand, steht bei `read`
 *            deshalb dort.
 *          - Eine Positivliste im delegierten Handler nimmt den Effekt.
 *          - „Auf die Einkaufsliste" am Rezept folgt dem Recht des ZIELS
 *            (Regel 8): mit `meals: read` und `shopping: write` bleibt es, und
 *            es ist der eine Schreibaufruf, den diese Rechte ausloesen.
 *          - Die Vorrats-Zuordnung braucht BEIDE Rechte, wie der Server.
 *
 *        Gemessen am echten Markup und an den echten Handlern: die Zusage eines
 *        Riegels ist das AUSBLEIBEN einer Anfrage, das sieht kein Textguard.
 *        Jeder Fall prueft den Schreibrecht-Fall mit - erschiene das Gesuchte
 *        dort nicht, waere der Aufbau des Tests kaputt, nicht die Regel erfuellt.
 *
 * Ausführen: npm run test:kitchen-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.CSS = globalThis.CSS ?? { escape: (value) => String(value) };

const { installMiniDom, MiniElement } = await import('./mini-dom.js');
installMiniDom();
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
// Eine Zutat ohne Zuordnung gibt ein leeres Fragment zurueck (pantryMatchEl).
globalThis.document.createDocumentFragment = () => ({ childNodes: [], dataset: {}, outerHTML: '' });

// Die Seiten setzen Klassen ueber `classList`; der Mini-DOM kennt nur das
// Attribut. Derselbe duenne Aufsatz wie in test-shopping-readonly-ui.js.
Object.defineProperty(MiniElement.prototype, 'classList', {
  get() {
    const el = this;
    const liste = () => el.className.split(/\s+/).filter(Boolean);
    const setze = (l) => { el.className = l.join(' '); };
    return {
      add: (...c) => setze([...new Set([...liste(), ...c])]),
      remove: (...c) => setze(liste().filter((k) => !c.includes(k))),
      contains: (c) => liste().includes(c),
      toggle: (c, an = !liste().includes(c)) => { if (an) setze([...new Set([...liste(), c])]); else setze(liste().filter((k) => k !== c)); return an; },
    };
  },
});

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: meals } = await import('../public/pages/meals.js');
const { __test: recipes } = await import('../public/pages/recipes.js');

async function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

// Das Konto aus dem Auftrag, einmal ohne und einmal mit dem Recht des Ziels.
const LESEN = { meals: 'read', shopping: 'read', pantry: 'read' };
const LESEN_MIT_EINKAUF = { meals: 'read', shopping: 'write', pantry: 'read' };
const LESEN_MIT_VORRAT = { meals: 'read', shopping: 'read', pantry: 'write' };
const SCHREIBEN = { meals: 'write', shopping: 'write', pantry: 'write' };

/** Jeden API-Aufruf mitschreiben, statt ihn zu senden. */
async function aufrufe(fn, antworten = {}) {
  const liste = [];
  const zuvor = globalThis.__apiStub;
  const merke = (method) => async (path) => {
    liste.push(`${method} ${path}`);
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

const schreibend = (liste) => liste.filter((eintrag) => !eintrag.startsWith('GET '));

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

/** Wer ein Rueckgaengig-Fenster oeffnet, kommt hier an. */
async function undoMitschnitt(fn) {
  const fenster = [];
  const zuvor = globalThis.__undoStub;
  globalThis.__undoStub = (opts) => { fenster.push(opts); };
  try {
    await fn();
  } finally {
    globalThis.__undoStub = zuvor;
  }
  return fenster;
}

/** Jedes `data-action="..."` eines Markup-Strings. */
const aktionenImMarkup = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

/** Die `data-action`s eines Knotens und seiner Kinder - der Mini-DOM schreibt `dataset` nicht ins Markup. */
function aktionenImBaum(el) {
  const eigene = el.dataset?.action ? [el.dataset.action] : [];
  const roh = typeof el.outerHTML === 'string' && !el.childNodes ? aktionenImMarkup(el.outerHTML) : [];
  return [...eigene, ...roh, ...(el.childNodes ?? []).flatMap(aktionenImBaum)];
}

/** Ein Knoten, der JEDEN Listener sammelt (der Mini-DOM merkt sich nur den letzten Typ). */
function mitLauschern(el) {
  el.gehoert = [];
  el.handler = {};
  el.addEventListener = (typ, fn) => { el.gehoert.push(typ); (el.handler[typ] ??= []).push(fn); };
  return el;
}

/**
 * Das Panel eines offenen Dialogs: jeder Selektor liefert einen Knoten, der
 * seine Listener sammelt, damit ein Test den Knopf NACH dem Oeffnen druecken
 * kann. `werte[sel] === null` heisst: diesen Knoten gibt es nicht.
 */
function dialogPanel(werte = {}, alle = {}) {
  const knoten = {};
  const mk = (sel) => (knoten[sel] ??= {
    value: werte[sel] ?? '', checked: false, disabled: false, hidden: false, dataset: {}, style: {}, handler: {},
    addEventListener(typ, fn) { (this.handler[typ] ??= []).push(fn); },
    setAttribute() {}, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, classList: { toggle() {}, add() {}, remove() {} },
  });
  return {
    dataset: {},
    querySelector: (sel) => (werte[sel] === null ? null : mk(sel)),
    querySelectorAll: (sel) => alle[sel] ?? [],
    async druecken(sel, typ = 'click') {
      const ziel = knoten[sel];
      assert.ok(ziel?.handler[typ]?.length, `am Knoten ${sel} haengt kein ${typ} - der Aufbau des Tests ist kaputt`);
      for (const fn of ziel.handler[typ]) await fn({ currentTarget: ziel, target: ziel, preventDefault() {}, stopPropagation() {} });
    },
  };
}

const rechte = (modules) => setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });

/** Ein Klick, dessen Ziel einen Knopf mit dieser Aktion findet. */
function klick(action, daten = {}) {
  const btn = { dataset: { action, ...daten }, getAttribute: () => null, blur() {}, isConnected: false };
  return {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
    stopPropagation() {}, preventDefault() {}, button: 0,
  };
}

// -------------------------------------------------------------------------
// Essensplan
// -------------------------------------------------------------------------

const MITTAG = { key: 'lunch', label: 'Mittag' };
const mahlzeit = (over = {}) => ({
  id: 11, title: 'Linsensuppe', date: '2026-10-07', meal_type: 'lunch', recipe_id: null,
  recipe_url: null, notes: null, recurrence_template_id: null, recurrence_end_date: null,
  ingredients: [{ id: 1, name: 'Linsen', quantity: '200 g', category: 'Vorrat', on_shopping_list: 0 }],
  ...over,
});
const reichlich = () => mahlzeit({
  recipe_id: 21, recipe_url: 'https://example.org/linsen', notes: 'Mit Zitrone abschmecken',
  recurrence_template_id: 4, recurrence_end_date: '2026-12-30',
});
const kachel = (meal = mahlzeit()) => meals.renderSlot('2026-10-07', MITTAG, [meal], 2, 2);
const leererPlatz = () => meals.renderSlot('2026-10-07', MITTAG, [], 2, 2);

/** Den Zustand des Essensplans setzen und danach zuruecknehmen. */
async function mitPlan(patch, fn) {
  const zuvor = { ...meals.state };
  Object.assign(meals.state, {
    currentWeek: '2026-10-05', meals: [mahlzeit()], recipes: [{ id: 21, title: 'Linsen nach Oma', source: 'native', ingredients: [] }],
    lists: [{ id: 5, name: 'Wocheneinkauf' }], categories: [], loadError: null, modal: null,
    visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
  }, patch);
  try {
    return await fn();
  } finally {
    Object.assign(meals.state, zuvor);
    meals.setContainerForTest(null);
  }
}

/** Die Woche wirklich zeichnen: das Gitter ist ein Mini-Knoten, der Rest der Seite fehlt. */
function wocheZeichnen() {
  const grid = mitLauschern(new MiniElement('div'));
  meals.setContainerForTest({ querySelector: (sel) => (sel === '#week-grid' ? grid : null), querySelectorAll: () => [] });
  meals.renderWeekGridForTest({ querySelector: (sel) => (sel === '#week-grid' ? grid : null), querySelectorAll: () => [] });
  return grid;
}

test('Essensplan bei `read`: die Karte oeffnet die Leseansicht und traegt keine Handlung', async () => {
  const html = await withAccess(LESEN, () => kachel(mahlzeit({ recurrence_template_id: 4, recipe_url: 'https://example.org/x' })));
  assert.match(html, /data-action="meal-details"/, 'der Tipp auf die Karte bleibt - er liest');
  assert.match(html, /common\.showDetails/, 'und die Karte sagt, was er tut (#1682)');
  assert.match(html, /meal-card__recurrence/, 'das Serien-Zeichen ist Zustand und bleibt');
  assert.match(html, /data-action="open-recipe"/, 'der Rezept-Link ist Lesen und bleibt');
  assert.doesNotMatch(html, /edit-meal|delete-meal|transfer-meal|add-meal|meal-card__drag/,
    'Bearbeiten, Loeschen, Transfer, Anlegen und der Ziehgriff sind Handlungen');
  for (const action of aktionenImMarkup(html)) {
    assert.ok(meals.READ_SAFE_ACTIONS.has(action), `${action} steht im Markup, aber nicht in der Positivliste`);
  }

  const voll = await withAccess(SCHREIBEN, () => kachel());
  for (const erwartet of ['edit-meal', 'delete-meal', 'transfer-meal', 'add-meal']) {
    assert.match(voll, new RegExp(`data-action="${erwartet}"`), `Gegenfall: ${erwartet} steht mit Schreibrecht da`);
  }
  assert.match(voll, /meal-card__drag/, 'Gegenfall: der Ziehgriff');
  assert.doesNotMatch(voll, /common\.showDetails|meal-details/);
});

test('Essensplan bei `read`: der Transfer in den Einkauf bleibt auch mit Einkaufsrecht weg', async () => {
  // Die Route kippt `on_shopping_list` im Plan, der Pfad-Guard verlangt `meals: write`.
  assert.doesNotMatch(await withAccess(LESEN_MIT_EINKAUF, () => kachel()), /transfer-meal/);
  assert.ok(!meals.READ_SAFE_ACTIONS.has('transfer-meal'));
});

test('Essensplan bei `read`: ein leerer Platz ist nur Zustand', async () => {
  const lesend = await withAccess(LESEN, () => leererPlatz());
  assert.match(lesend, /meal-slot--empty meal-slot--static/);
  assert.match(lesend, /meal-slot__type-text/, 'der Platz bleibt benannt');
  assert.doesNotMatch(lesend, /<button|add-meal/);
  assert.match(await withAccess(SCHREIBEN, () => leererPlatz()), /meal-slot__add-btn/, 'Gegenfall');
});

test('Essensplan bei `read`: die gezeichnete Woche traegt kein Anlegen und kein Ziehen', async () => {
  const woche = (modules) => withAccess(modules, () => mitPlan({}, () => {
    const grid = wocheZeichnen();
    return { html: grid.innerHTML, gehoert: grid.gehoert };
  }));

  const lesend = await woche(LESEN);
  assert.match(lesend.html, /day-header__name/, 'die Woche steht');
  assert.match(lesend.html, /Linsensuppe/);
  assert.doesNotMatch(lesend.html, /class="day-add"|add-meal/, 'kein Tagesknopf, kein Plus');
  for (const action of aktionenImMarkup(lesend.html)) {
    assert.ok(meals.READ_SAFE_ACTIONS.has(action), `${action} steht in der Woche, aber nicht in der Positivliste`);
  }
  assert.deepEqual(lesend.gehoert, ['click'],
    'Regel 3: bei `read` haengt nur der Klick - kein dragover, kein drop, kein pointerdown');

  const voll = await woche(SCHREIBEN);
  assert.match(voll.html, /class="day-add"/, 'Gegenfall: der Tagesknopf');
  for (const typ of ['click', 'dragover', 'drop', 'pointerdown']) {
    assert.ok(voll.gehoert.includes(typ), `Gegenfall: ${typ} ist mit Schreibrecht verdrahtet`);
  }
});

test('Essensplan bei `read`: kein FAB, keine Rezept-Spalte, kein Werkzeugmenue', async () => {
  const lesend = await withAccess(LESEN, () => ({ layout: meals.mealsLayoutHtml(), menu: meals.mealsToolsMenuHtml() }));
  assert.doesNotMatch(lesend.layout, /page-fab|recipe-sidebar/);
  assert.match(lesend.layout, /meals-layout--rail-hidden/, 'das Board bekommt die Breite der Spalte');
  assert.match(lesend.layout, /id="week-grid"/);
  assert.equal(lesend.menu, '', 'der Zufallsplan schreibt, der Spalten-Schalter haette nichts zu schalten');

  const voll = await withAccess(SCHREIBEN, () => ({ layout: meals.mealsLayoutHtml(), menu: meals.mealsToolsMenuHtml() }));
  assert.match(voll.layout, /id="fab-new-meal"/, 'Gegenfall');
  assert.match(voll.layout, /id="recipe-sidebar"/);
  assert.doesNotMatch(voll.layout, /meals-layout--rail-hidden/);
  assert.match(voll.menu, /randomize-plan/);
});

test('Essensplan bei `read`: der Leerzustand nennt den Zustand und laedt zu nichts ein', async () => {
  const lesend = await withAccess(LESEN, () => mitPlan({ meals: [] }, () => meals.emptyWeekOptions()));
  assert.deepEqual(Object.keys(lesend).sort(), ['icon', 'title']);
  assert.equal(lesend.title, 'meals.emptyTitle');
  const voll = await withAccess(SCHREIBEN, () => mitPlan({ meals: [] }, () => meals.emptyWeekOptions()));
  assert.equal(voll.action?.label, 'meals.emptyAction', 'Gegenfall');
  assert.ok(voll.description && voll.hint);
});

test('Essensplan bei `read`: die Leseansicht zeigt alles, was der Editor zeigt', async () => {
  const html = await withAccess(LESEN, () => mitPlan({}, () => meals.mealReadHtml(reichlich())));
  for (const label of ['dateLabel', 'mealTypeLabel', 'ingredientsLabel', 'savedRecipeLabel', 'notesLabel', 'recipeUrlLabel', 'recurrenceBadge', 'recurrenceUntilLabel']) {
    assert.match(html, new RegExp(`meals\\.${label}`), `das Feld ${label} fehlt`);
  }
  assert.match(html, /data-view="read"/);
  assert.match(html, /2026-10-07/);
  assert.match(html, /200 g · Linsen \(Vorrat\)/, 'Menge, Zutat und die Kategorie, die NUR im Editor stand');
  assert.match(html, /Linsen nach Oma/, 'das gespeicherte Rezept beim Namen');
  assert.match(html, /Mit Zitrone abschmecken/);
  assert.match(html, /<a class="meal-read__link" href="https:\/\/example\.org\/linsen" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /detail-row__value">meals\.recurrenceWeekly</, 'die Wiederholung als ZUSTAND');
  assert.doesNotMatch(html, /meals\.recurrenceLabel/,
    'die Beschriftung des Schalters ist ein Imperativ („Woechentlich wiederholen") - in einer Leseansicht eine Aufforderung');
  assert.match(html, /2026-12-30/, 'und ihr Ende');
  assert.equal((html.match(/class="detail-row[ "]/g) ?? []).length, 8);
  assert.doesNotMatch(html, /<input|<select|<textarea|<button|form-input|modal-save|modal-delete/,
    'keine Eingabe, kein Speichern, kein Loeschen');

  // Ohne Wert keine Zeile - die Antwort folgt dem Datensatz.
  const karg = await withAccess(LESEN, () => mitPlan({}, () => meals.mealReadHtml(mahlzeit({ ingredients: [] }))));
  assert.equal((karg.match(/class="detail-row[ "]/g) ?? []).length, 2, 'nur Datum und Mahlzeit');

  // Nutzerdaten laufen durch esc(); ein Link ohne http(s) wird keiner.
  const boese = await withAccess(LESEN, () => mitPlan({}, () => meals.mealReadHtml(mahlzeit({
    notes: '<img src=x onerror=alert(1)>', recipe_url: 'javascript:alert(1)',
    ingredients: [{ id: 1, name: '<b>Linsen</b>', quantity: null, category: null }],
  }))));
  assert.doesNotMatch(boese, /<img|<b>|<a /);
});

test('Essensplan bei `read`: jeder Weg in den Dialog oeffnet die Leseansicht oder nichts', async () => {
  const offen = (modules, weg) => withAccess(modules, () => mitPlan({}, () => modalMitschnitt(weg)));
  const m = () => meals.state.meals[0];
  const lesewege = {
    'Karte (Leseknoten)': () => meals.onGridClick(klick('meal-details', { mealId: '11' })),
    'openMealModal direkt': () => meals.openMealModal({ mode: 'edit', meal: m(), date: m().date, mealType: m().meal_type }),
  };
  for (const [name, weg] of Object.entries(lesewege)) {
    const [dialog, ...mehr] = await offen(LESEN, weg);
    assert.ok(dialog && !mehr.length, `${name}: genau ein Dialog`);
    assert.equal(dialog.title, 'Linsensuppe', `${name}: der Name steht im Titel`);
    assert.match(dialog.content, /data-view="read"/, `${name}: Leseansicht`);
    assert.doesNotMatch(dialog.content, /modal-save|modal-delete|<input|<select|<textarea|<button/, `${name}: keine Eingabe`);
  }

  const zu = {
    'Anlegen (FAB, Tagesknopf, Leerzustand)': () => meals.openMealModal({ mode: 'create', date: '2026-10-07', mealType: 'lunch' }),
    'Rezept-Spalte': () => meals.planRecipeFromRail(21),
    'Zufallsplan': () => meals.openRandomizeModal(),
    // Knoten, die ein Rechtewechsel ueberholt hat:
    'stehen gebliebenes Plus': () => meals.onGridClick(klick('add-meal', { date: '2026-10-07', type: 'lunch' })),
    'stehen gebliebenes Bearbeiten': () => meals.onGridClick(klick('edit-meal', { mealId: '11' })),
  };
  for (const [name, weg] of Object.entries(zu)) {
    assert.deepEqual(await offen(LESEN, weg), [], `${name}: bei \`read\` geht nichts auf`);
  }
  // Das stehen gebliebene Bearbeiten ist die Ausnahme der Positivliste: zu, statt Leseansicht.

  for (const name of ['Anlegen (FAB, Tagesknopf, Leerzustand)', 'Rezept-Spalte', 'Zufallsplan', 'stehen gebliebenes Bearbeiten']) {
    const [dialog] = await offen(SCHREIBEN, zu[name]);
    assert.ok(dialog, `Gegenfall ${name}: mit Schreibrecht geht ein Dialog auf`);
    assert.doesNotMatch(dialog.content, /data-view="read"/);
  }
  const [editor] = await offen(SCHREIBEN, () => meals.onGridClick(klick('edit-meal', { mealId: '11' })));
  assert.match(editor.content, /id="modal-save"/);
  assert.match(editor.content, /id="modal-delete"/);
});

test('Essensplan bei `read`: kein Schreibweg schickt eine Anfrage', async () => {
  const rezept = { id: 21, title: 'Linsen nach Oma', source: 'native', meal_types: ['lunch'], ingredients: [] };
  const speichern = () => {
    meals.state.modal = { mode: 'create' };
    const felder = {
      '#modal-save': { disabled: false, textContent: '' },
      '#modal-date': { value: '2026-10-07' }, '#modal-type': { value: 'lunch' }, '#modal-title': { value: 'Suppe' },
      '#modal-notes': { value: '' }, '#modal-recipe-url': { value: '' },
    };
    return meals.saveModal({ querySelector: (sel) => felder[sel] ?? null, querySelectorAll: () => [] });
  };
  const zufall = () => meals.runRandomize({
    querySelector: (sel) => (sel === '#meal-randomize-run' ? { disabled: false } : { checked: false }),
  });
  const wege = {
    'Verschieben (Ziehen)': [() => meals.moveMeal(11, '2026-10-08', 'dinner', { rerender() {} }), 'PUT /meals/11'],
    'Rezept in einen Platz': [() => meals.addRecipeToSlot(rezept, '2026-10-08', 'lunch'), 'POST /meals'],
    'Rezept ersetzt einen Platz': [() => meals.addRecipeToSlot(rezept, '2026-10-07', 'lunch', { replaceMeals: [mahlzeit()] }), 'POST /meals/apply-plan'],
    'Zufallsplan ausfuehren': [zufall, 'POST /meals/apply-plan'],
    'Speichern im Dialog': [speichern, 'POST /meals'],
    'Serie loeschen': [() => {
      meals.state.meals = [mahlzeit({ recurrence_template_id: 4 })];
      return meals.deleteMeal(11, { scope: 'series' });
    }, 'DELETE /meals/11?scope=series'],
  };
  const fahren = (modules, weg) => withAccess(modules, () => mitPlan({ recipes: [rezept] }, async () => {
    meals.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
    const zuvorDatum = meals.state.meals[0].date;
    const liste = schreibend(await aufrufe(weg, {
      'POST /meals': { data: mahlzeit({ id: 12 }) }, 'POST /meals/apply-plan': { data: [] },
    }).catch(() => []));
    return { liste, verschoben: meals.state.meals[0]?.date !== zuvorDatum };
  }));

  for (const [name, [weg, erwartet]] of Object.entries(wege)) {
    const lesend = await fahren(LESEN, weg);
    assert.deepEqual(lesend.liste, [], `${name}: bei \`read\` geht nichts raus`);
    assert.equal(lesend.verschoben, false, `${name}: und nichts zieht optimistisch um`);
    const voll = await fahren(SCHREIBEN, weg);
    assert.ok(voll.liste.includes(erwartet), `Gegenfall ${name}: mit Schreibrecht geht ${erwartet} raus (war: ${voll.liste.join(', ')})`);
  }
});

test('Essensplan bei `read`: Loeschen blendet nichts aus und oeffnet kein Rueckgaengig-Fenster', async () => {
  const loeschen = (modules, ueber) => withAccess(modules, () => mitPlan({}, async () => {
    const karte = { style: {} };
    meals.setContainerForTest({ querySelector: () => karte, querySelectorAll: () => [] });
    const fenster = await undoMitschnitt(ueber);
    return { fenster: fenster.length, ausgeblendet: karte.style.display === 'none' };
  }));
  const wege = {
    'deleteMeal direkt': () => meals.deleteMeal(11),
    'stehen gebliebener Papierkorb': () => meals.onGridClick(klick('delete-meal', { mealId: '11' })),
  };
  for (const [name, weg] of Object.entries(wege)) {
    assert.deepEqual(await loeschen(LESEN, weg), { fenster: 0, ausgeblendet: false }, name);
    assert.deepEqual(await loeschen(SCHREIBEN, weg), { fenster: 1, ausgeblendet: true }, `Gegenfall ${name}`);
  }
});

test('Essensplan: der offene Editor speichert nichts mehr, wenn das Recht inzwischen fehlt', async () => {
  // Der Dialog geht mit Schreibrecht auf; danach wechselt das Recht (jedes
  // `/auth/me` schreibt den Rechte-Store neu), und erst dann faellt der Klick.
  const fahren = (danach) => mitPlan({}, async () => {
    meals.setContainerForTest({ querySelector: () => null, querySelectorAll: () => [] });
    const panel = dialogPanel({ '#modal-title': 'Suppe', '#transfer-missing': null, '#modal-delete': null, '#modal-date': '2026-10-07', '#modal-type': 'lunch' });
    try {
      rechte(SCHREIBEN);
      const [dialog] = await modalMitschnitt(() => meals.openMealModal({ mode: 'create', date: '2026-10-07', mealType: 'lunch' }));
      dialog.onSave(panel);
      rechte(danach);
      return schreibend(await aufrufe(async () => {
        await panel.druecken('#modal-save-as-recipe');
        await panel.druecken('#modal-save');
      }, { 'POST /recipes': { data: { id: 30, title: 'Suppe', source: 'native' } }, 'POST /meals': { data: mahlzeit({ id: 12 }) } }));
    } finally {
      clearPermissions();
    }
  });
  assert.deepEqual(await fahren(LESEN), [], '„Als Rezept speichern" und „Hinzufuegen" schicken bei `read` nichts');
  assert.deepEqual(await fahren(SCHREIBEN), ['POST /recipes', 'POST /meals'], 'Gegenfall: mit Schreibrecht gehen beide raus');
});

test('Essensplan: die Zieh-Verdrahtung folgt einem Rechtewechsel in beide Richtungen', async () => {
  await mitPlan({ recipes: [{ id: 21, title: 'Linsen nach Oma', source: 'native', meal_types: ['lunch'], ingredients: [] }] }, async () => {
    try {
      // (1) Zuerst bei `read` gezeichnet, dann kommt das Schreibrecht: das naechste Zeichnen verdrahtet nach.
      rechte(LESEN);
      const grid = mitLauschern(new MiniElement('div'));
      const seite = { querySelector: (sel) => (sel === '#week-grid' ? grid : null), querySelectorAll: () => [] };
      meals.renderWeekGridForTest(seite);
      assert.deepEqual(grid.gehoert, ['click']);
      rechte(SCHREIBEN);
      meals.renderWeekGridForTest(seite);
      for (const typ of ['dragover', 'drop', 'pointerdown']) {
        assert.ok(grid.gehoert.includes(typ), `${typ} fehlt nach dem Rechtewechsel - das Gitter bliebe bis zum Seitenwechsel ohne Ziehen`);
      }
      const einmal = [...grid.gehoert];
      meals.renderWeekGridForTest(seite);
      assert.deepEqual(grid.gehoert, einmal, 'ein weiteres Zeichnen verdrahtet nichts doppelt');

      // (2) Mit Schreibrecht verdrahtet, dann faellt es weg: die Geste beginnt gar nicht erst.
      const karte = () => {
        const slot = { dataset: { date: '2026-10-07', type: 'lunch' }, classList: { add() {}, remove() {} } };
        const k = { gefangen: 0, dataset: { mealId: '11' }, offsetWidth: 10, offsetHeight: 10, style: {},
          closest: (sel) => (sel === '.meal-slot' ? slot : null), querySelector: () => null,
          setPointerCapture() { k.gefangen += 1; }, addEventListener() {},
          cloneNode: () => ({ classList: { add() {} }, style: {}, remove() {} }) };
        return k;
      };
      const zeigerRunter = (k) => {
        let verhindert = 0;
        grid.handler.pointerdown[0]({ pointerType: 'mouse', pointerId: 1, clientX: 5, clientY: 5,
          target: { closest: (sel) => (sel === '.meal-card' ? k : null) }, preventDefault() { verhindert += 1; } });
        return { gefangen: k.gefangen, verhindert };
      };
      rechte(LESEN);
      assert.deepEqual(zeigerRunter(karte()), { gefangen: 0, verhindert: 0 },
        'bei `read` faengt die Karte den Zeiger nicht - kein Geist, kein Zielrahmen');
      rechte(SCHREIBEN);
      assert.deepEqual(zeigerRunter(karte()), { gefangen: 1, verhindert: 1 }, 'Gegenfall: mit Schreibrecht beginnt das Ziehen');

      // Dasselbe fuer das Rezept aus der Spalte: es wird gezogen, das Recht faellt weg, der Platz nimmt es nicht an.
      const spalte = mitLauschern(new MiniElement('aside'));
      meals.setContainerForTest({ querySelector: (sel) => (sel === '#recipe-sidebar' ? spalte : null), querySelectorAll: () => [] });
      meals.wireRecipeSidebar();
      spalte.handler.dragstart[0]({ dataTransfer: { setData() {} },
        target: { closest: () => ({ dataset: { recipeId: '21' }, classList: { add() {}, remove() {} } }) } });
      const ueberDemPlatz = () => {
        let verhindert = 0;
        const platz = { dataset: { date: '2026-10-08', type: 'lunch' }, classList: { add() {}, remove() {} } };
        grid.handler.dragover[0]({ target: { closest: () => platz }, preventDefault() { verhindert += 1; } });
        return verhindert;
      };
      rechte(LESEN);
      assert.equal(ueberDemPlatz(), 0, 'bei `read` meldet sich der Platz nicht als Ablage');
      rechte(SCHREIBEN);
      assert.equal(ueberDemPlatz(), 1, 'Gegenfall');
    } finally {
      clearPermissions();
    }
  });
});

test('CSS: der leere Platz ohne Handlung bekommt unter dem Zeiger keine Kante', () => {
  const regeln = [...eachRule(readFileSync(new URL('../public/styles/meals.css', import.meta.url), 'utf8'))];
  const hover = regeln.flatMap(({ selector }) => selector.split(','))
    .map((s) => s.trim())
    .filter((s) => /\.meal-slot--empty\S*:(hover|focus-within)/.test(s));
  assert.ok(hover.length >= 2, 'die Hover-Regel des leeren Platzes fehlt');
  for (const selector of hover) {
    assert.match(selector, /\.meal-slot--empty:not\(\.meal-slot--static\):(hover|focus-within)/,
      `${selector} traefe auch den Platz, der nur Zustand ist`);
  }
});

// -------------------------------------------------------------------------
// Rezepte
// -------------------------------------------------------------------------

const rezept = (over = {}) => ({
  id: 21, title: 'Pfannkuchen', source: 'native', notes: 'Teig ruhen lassen', recipe_url: 'https://example.org/pfannkuchen',
  meal_types: ['breakfast', 'lunch', 'dinner', 'snack'], has_own_image: false,
  ingredients: [
    { name: 'Mehl', quantity: '250 g', category: 'Backwaren', pantry_item_id: 3, pantry_item_name: 'Weizenmehl 405' },
    { name: 'Milch', quantity: '500 ml', category: 'Milchprodukte', pantry_item_id: null, pantry_item_name: null },
  ],
  ...over,
});
const kahl = () => rezept({ id: 22, title: 'Butterbrot', notes: null, recipe_url: null, ingredients: [] });

/** Den Zustand der Rezepte setzen, die Liste in einen Mini-Knoten zeichnen lassen und aufraeumen. */
async function mitRezepten(liste, fn) {
  const zuvor = { ...recipes.state };
  const knoten = new MiniElement('div');
  knoten.querySelectorAll = () => [];
  Object.assign(recipes.state, {
    recipes: liste, categories: [], lists: [{ id: 5, name: 'Wocheneinkauf' }], query: '', loadError: null,
    sourceFilter: 'all', plannedRecipeIds: new Set(),
  });
  recipes.setContainerForTest({ querySelector: (sel) => (sel === '#recipes-list' ? knoten : null), querySelectorAll: () => [] });
  try {
    return await fn(knoten);
  } finally {
    Object.assign(recipes.state, zuvor);
    recipes.setContainerForTest(null);
  }
}

const listeZeichnen = (modules, liste = [rezept(), kahl()]) => withAccess(modules, () => mitRezepten(liste, (knoten) => {
  recipes.buildRecipeList();
  return { aktionen: aktionenImBaum(knoten), html: knoten.outerHTML };
}));

test('Rezepte bei `read`: die Zeile klappt auf und traegt keine Handlung', async () => {
  const lesend = await listeZeichnen(LESEN);
  assert.deepEqual([...new Set(lesend.aktionen)], ['toggle-detail'],
    'jede Zeile fuehrt ins Detail - auch die ohne Zutaten, Notiz und Link, die sonst das Formular oeffnete');
  assert.equal(lesend.aktionen.length, 2);
  assert.doesNotMatch(lesend.html, /list-row__actions|recipe-row__more|popover-menu/, 'keine Bedienzone, kein Ueberlaufmenue');
  assert.match(lesend.html, /Pfannkuchen/);
  assert.match(lesend.html, /meals\.ingredientCount/, 'die Zutatenzahl ist Zustand');
  for (const action of lesend.aktionen) {
    assert.ok(recipes.READ_SAFE_ACTIONS.has(action), `${action} steht in der Liste, aber nicht in der Positivliste`);
  }

  const voll = await listeZeichnen(SCHREIBEN);
  for (const erwartet of ['edit', 'duplicate', 'delete', 'add-to-meals', 'to-shopping', 'match-ingredient', 'match-ingredients']) {
    assert.ok(voll.aktionen.includes(erwartet), `Gegenfall: ${erwartet} steht mit Schreibrecht da`);
  }
  assert.match(voll.html, /list-row__actions/);
});

test('Rezepte bei `read`: das Detail zeigt, was sonst nur im Formular stand', async () => {
  const detail = (modules, r = rezept()) => withAccess(modules, () => mitRezepten([r], () => {
    const el = new MiniElement('div');
    recipes.fillRecipeDetail(el, r);
    return { html: el.outerHTML, aktionen: aktionenImBaum(el) };
  }));

  const lesend = await detail(LESEN);
  assert.match(lesend.html, /recipe-card__meal-types/, 'die Mahlzeiten stehen da, auch wenn alle gelten');
  assert.equal((lesend.html.match(/meal-type-badge--/g) ?? []).length, 4);
  assert.match(lesend.html, /recipe-detail__ingredient-category">Backwaren</, 'die Einkaufskategorie je Zutat');
  assert.match(lesend.html, /250 g · Mehl/);
  assert.match(lesend.html, /Teig ruhen lassen/);
  // Der Mini-DOM schreibt `href` nicht ins Markup; der Link ist am Text zu erkennen.
  assert.match(lesend.html, /<a class="btn btn--ghost">.*recipes\.openLink/, 'der Link ist Lesen und bleibt');
  assert.match(lesend.html, /<span class="recipe-detail__ingredient-match">Weizenmehl 405<\/span>/,
    'die bestehende Vorrats-Zuordnung bleibt als Zeichen');
  assert.deepEqual(lesend.aktionen, [], 'kein Einplanen, kein Transfer, keine Zuordnung');

  const voll = await detail(SCHREIBEN);
  assert.doesNotMatch(voll.html, /recipe-card__meal-types|recipe-detail__ingredient-category/,
    'Gegenfall: mit Schreibrecht steht beides im Formular, das Detail bleibt wie es war');
  assert.deepEqual(voll.aktionen.sort(), ['add-to-meals', 'match-ingredient', 'match-ingredients', 'to-shopping']);

  // Ein Rezept ohne alles: bei `read` bleibt ein Detail mit den Mahlzeiten und ohne leere Leiste.
  const karg = await detail(LESEN, kahl());
  assert.match(karg.html, /recipe-card__meal-types/);
  assert.doesNotMatch(karg.html, /recipe-detail__actions/, 'eine Leiste ohne Knopf waere ein leerer Kasten');
});

test('Rezepte: „Auf die Einkaufsliste" folgt dem Einkaufsrecht, nicht dem Kuechenrecht', async () => {
  const knopf = (modules) => withAccess(modules, () => mitRezepten([rezept()], () => {
    const el = new MiniElement('div');
    recipes.fillRecipeDetail(el, rezept());
    return aktionenImBaum(el);
  }));
  assert.deepEqual(await knopf(LESEN_MIT_EINKAUF), ['to-shopping'],
    '`meals: read` + `shopping: write`: der Server nimmt den Uebertrag an, der Knopf bleibt');
  assert.deepEqual(await knopf(LESEN), []);
  assert.ok(!(await knopf({ meals: 'write', shopping: 'read', pantry: 'read' })).includes('to-shopping'),
    'ohne Einkaufsrecht nuetzt das Kuechenrecht nichts');

  const klicken = (modules) => withAccess(modules, () => mitRezepten([rezept()], async () => schreibend(await aufrufe(
    () => recipes.onSplitClick(klick('to-shopping', { id: '21' }), { contains: () => false }),
    { 'POST /recipes/21/to-shopping-list': { data: { transferred: 2, skipped: 0, added_ids: [7, 8] } } },
  ))));
  assert.deepEqual(await klicken(LESEN_MIT_EINKAUF), ['POST /recipes/21/to-shopping-list'],
    'der eine erlaubte Schreibaufruf dieses Kontos');
  assert.deepEqual(await klicken(LESEN), [], 'ohne Einkaufsrecht geht auch er nicht raus');
});

test('Rezepte bei `read`: die Detailspalte traegt nur den Titel', async () => {
  const kopf = (modules) => withAccess(modules, () => mitRezepten([rezept()], () => {
    const body = new MiniElement('div');
    recipes.renderRecipePane(21, body);
    return body.outerHTML;
  }));
  const lesend = await kopf(LESEN);
  assert.match(lesend, /split-view__detail-title">Pfannkuchen</);
  assert.doesNotMatch(lesend, /split-view__detail-actions|<button/);
  const voll = await kopf(SCHREIBEN);
  assert.match(voll, /split-view__detail-actions/, 'Gegenfall');
  assert.match(voll, /common\.edit/);
  assert.equal((voll.split('</header>')[0].match(/<button /g) ?? []).length, 3, 'Bearbeiten, Duplizieren, Loeschen');
});

test('Rezepte bei `read`: kein FAB, und der Leerzustand laedt zu nichts ein', async () => {
  assert.equal(await withAccess(LESEN, () => recipes.fabEl()), null);
  assert.match((await withAccess(SCHREIBEN, () => recipes.fabEl())).outerHTML, /class="page-fab"/, 'Gegenfall');

  const lesend = await withAccess(LESEN, () => recipes.emptyListOptions());
  assert.deepEqual(Object.keys(lesend).sort(), ['icon', 'title']);
  const voll = await withAccess(SCHREIBEN, () => recipes.emptyListOptions());
  assert.equal(voll.action?.label, 'recipes.emptyAction', 'Gegenfall');
});

test('Rezepte bei `read`: der delegierte Handler laesst nur die Positivliste durch', async () => {
  const fahren = (modules, action, daten = {}) => withAccess(modules, () => mitRezepten([rezept()], async () => {
    let fenster = [];
    let dialoge = [];
    const liste = await aufrufe(async () => {
      dialoge = await modalMitschnitt(async () => {
        fenster = await undoMitschnitt(() => recipes.onSplitClick(klick(action, { id: '21', ...daten }), { contains: () => false }));
      });
    }, { 'POST /recipes': { data: rezept({ id: 30 }) } });
    return { liste, dialoge: dialoge.length, fenster: fenster.length };
  }));

  const NICHTS = { liste: [], dialoge: 0, fenster: 0 };
  const zu = [
    ['edit', {}], ['duplicate', {}], ['delete', {}], ['add-to-meals', {}],
    ['match-ingredient', { ingredient: 'Mehl' }], ['match-ingredients', {}],
    ['eine-aktion-von-morgen', {}],
  ];
  for (const [action, daten] of zu) {
    assert.deepEqual(await fahren(LESEN, action, daten), NICHTS, `${action}: bei \`read\` passiert nichts`);
  }
  // Mit dem Vorratsrecht allein bleibt die Zuordnung zu - nicht einmal der Vorrat wird geladen.
  assert.deepEqual(await fahren(LESEN_MIT_VORRAT, 'match-ingredient', { ingredient: 'Mehl' }), NICHTS);
  assert.deepEqual(await fahren(LESEN_MIT_VORRAT, 'match-ingredients'), NICHTS);

  // Gegenfaelle: jede Aktion tut mit Schreibrecht, was sie soll.
  assert.equal((await fahren(SCHREIBEN, 'edit')).dialoge, 1);
  assert.deepEqual((await fahren(SCHREIBEN, 'duplicate')).liste, ['POST /recipes']);
  assert.equal((await fahren(SCHREIBEN, 'delete')).fenster, 1);
  assert.equal((await fahren(SCHREIBEN, 'add-to-meals')).dialoge, 1);
  assert.deepEqual((await fahren(SCHREIBEN, 'match-ingredient', { ingredient: 'Mehl' })), { liste: ['GET /pantry'], dialoge: 1, fenster: 0 });
  assert.deepEqual((await fahren(SCHREIBEN, 'match-ingredients')), { liste: ['GET /pantry'], dialoge: 1, fenster: 0 });
});

test('Rezepte bei `read`: eine Aktion, die morgen dazukommt, ist zu, bis sie auf der Positivliste steht', async () => {
  // Jede heutige Aktion traegt ihren eigenen Riegel; der Riegel des Verteilers
  // ist deshalb nur an einer Aktion zu sehen, die KEINEN hat - also an einer
  // neuen. Sie wird fuer die Dauer des Tests in den Verteiler gehaengt.
  let gelaufen = 0;
  recipes.SPLIT_ACTIONS['aktion-von-morgen'] = () => { gelaufen += 1; };
  const druecken = (modules) => withAccess(modules, () => mitRezepten([rezept()],
    () => recipes.onSplitClick(klick('aktion-von-morgen', { id: '21' }), { contains: () => false })));
  try {
    await druecken(LESEN);
    assert.equal(gelaufen, 0, 'bei `read` laeuft sie nicht - die Positivliste nennt sie nicht');
    await druecken(SCHREIBEN);
    assert.equal(gelaufen, 1, 'Gegenfall: mit Schreibrecht laeuft sie');
    // Und was die Liste nennt, kommt bei `read` durch.
    assert.ok(Object.keys(recipes.SPLIT_ACTIONS).includes('to-shopping') && recipes.READ_SAFE_ACTIONS.has('to-shopping'));
  } finally {
    delete recipes.SPLIT_ACTIONS['aktion-von-morgen'];
  }
});

test('Rezepte: die offenen Dialoge speichern nichts mehr, wenn das Recht inzwischen fehlt', async () => {
  const VORRAT = { 'GET /pantry': { data: [{ id: 3, name: 'Weizenmehl 405' }] },
    'PUT /recipes/21/ingredient-match': { data: { pantry_item_id: 3, pantry_item_name: 'Weizenmehl 405' } } };
  const dialoge = {
    'Zuordnen': {
      oeffnen: () => recipes.openPantryMatchModal(rezept(), 'Mehl'),
      panel: () => dialogPanel({ '#pantry-match-select': '3' }), knopf: '#pantry-match-save',
      erwartet: ['PUT /recipes/21/ingredient-match'],
    },
    'Sammel-Zuordnen': {
      oeffnen: () => recipes.openPantryBulkMatchModal(rezept()),
      panel: () => dialogPanel({}, { 'select[data-ingredient-index]': [{ value: '3', dataset: { ingredientIndex: '0' } }] }),
      knopf: '#pantry-bulk-match-save', erwartet: ['PUT /recipes/21/ingredient-match'],
    },
    'In den Essensplan': {
      oeffnen: () => recipes.planRecipe(rezept(), null),
      panel: () => dialogPanel({ '#plan-date': '2026-10-08', '#plan-type': 'dinner' }), knopf: '#plan-confirm',
      erwartet: ['POST /meals'],
    },
    'Rezept bearbeiten': {
      oeffnen: () => recipes.openRecipeModal('edit', rezept()),
      panel: () => dialogPanel({ '#recipe-title': 'Pfannkuchen' }, { '#recipe-meal-types [data-meal-type]': [], '.ingredient-row': [] }),
      knopf: '#recipe-save', erwartet: ['PUT /recipes/21'],
    },
  };
  for (const [name, d] of Object.entries(dialoge)) {
    const fahren = (danach) => mitRezepten([rezept()], async () => {
      const panel = d.panel();
      try {
        rechte(SCHREIBEN);
        let dialog;
        await aufrufe(async () => { [dialog] = await modalMitschnitt(d.oeffnen); }, VORRAT);
        assert.ok(dialog, `${name}: mit Schreibrecht geht der Dialog auf`);
        dialog.onSave(panel);
        rechte(danach);
        return schreibend(await aufrufe(() => panel.druecken(d.knopf),
          { ...VORRAT, 'PUT /recipes/21': { data: rezept() }, 'POST /meals': { data: {} } }));
      } finally {
        clearPermissions();
      }
    });
    assert.deepEqual(await fahren(LESEN), [], `${name}: nach dem Rechtewechsel schickt der offene Dialog nichts`);
    assert.deepEqual(await fahren(LESEN_MIT_VORRAT), [], `${name}: auch nicht mit dem Vorratsrecht allein`);
    assert.deepEqual(await fahren(SCHREIBEN), d.erwartet, `Gegenfall ${name}`);
  }
});

test('Rezepte bei `read`: kein Schreibweg schickt eine Anfrage, auch nicht direkt gerufen', async () => {
  const formular = () => {
    const felder = { '#recipe-save': { disabled: false }, '#recipe-title': { value: 'Neu' } };
    return { querySelector: (sel) => felder[sel] ?? null, querySelectorAll: () => [] };
  };
  const wege = {
    'Anlegen (FAB, Leerzustand)': () => recipes.openRecipeModal('create'),
    'Bearbeiten (Zeile ohne Detail, Detailkopf)': () => recipes.openRecipeModal('edit', rezept()),
    'Speichern im Dialog': () => recipes.saveRecipe(formular(), 'create', null),
    'Duplizieren': () => recipes.duplicateRecipe(rezept()),
    'Loeschen': () => recipes.removeRecipe(rezept()),
    'In den Essensplan': () => recipes.planRecipe(rezept(), null),
    'Zuordnen': () => recipes.openPantryMatchModal(rezept(), 'Mehl'),
    'Sammel-Zuordnen': () => recipes.openPantryBulkMatchModal(rezept()),
  };
  const fahren = (modules, weg) => withAccess(modules, () => mitRezepten([rezept()], async () => {
    let fenster = [];
    let dialoge = [];
    const liste = await aufrufe(async () => {
      dialoge = await modalMitschnitt(async () => { fenster = await undoMitschnitt(weg); });
    }, { 'POST /recipes': { data: rezept({ id: 30 }) } });
    return liste.length + dialoge.length + fenster.length;
  }));
  for (const [name, weg] of Object.entries(wege)) {
    assert.equal(await fahren(LESEN, weg), 0, `${name}: bei \`read\` kein Aufruf, kein Dialog, kein Rueckgaengig-Fenster`);
    assert.ok(await fahren(SCHREIBEN, weg) > 0, `Gegenfall ${name}: mit Schreibrecht passiert etwas`);
  }
});

test('Rezepte: die Vorrats-Zuordnung braucht Kueche UND Vorrat, wie der Server', async () => {
  const zeichen = (modules) => withAccess(modules, () => {
    const r = rezept();
    const einzeln = recipes.pantryMatchEl(r, r.ingredients[0]);
    return { tag: einzeln.tagName, aktion: einzeln.dataset?.action ?? null, sammel: recipes.pantryMatchBulkEl(r) !== null };
  });
  // `PUT /recipes/:id/ingredient-match`: Pfad-Guard `meals: write`, Route `pantry: write`.
  assert.deepEqual(await zeichen(SCHREIBEN), { tag: 'button', aktion: 'match-ingredient', sammel: true });
  assert.deepEqual(await zeichen(LESEN_MIT_VORRAT), { tag: 'span', aktion: null, sammel: false },
    '`meals: read` + `pantry: write`: der Zustand bleibt, der Knopf endete im 403');
  assert.deepEqual(await zeichen({ meals: 'write', shopping: 'write', pantry: 'read' }), { tag: 'span', aktion: null, sammel: false });
  assert.deepEqual(await zeichen(LESEN), { tag: 'span', aktion: null, sammel: false });
});
