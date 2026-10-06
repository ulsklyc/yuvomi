/**
 * Test: Rezept in den Essensplan ohne Ziehen (Re-Kritik 2026-09-28, A4 P1-1)
 *
 * Zweck: Das Kernszenario der Kueche ("Dienstag gibt es Lachs") hatte auf
 *        keinem Geraet einen direkten, zugaenglichen Weg:
 *        (a) die Rezept-Spalte des Boards bestand aus `article draggable` ohne
 *            Knopf, ohne Fokus und ohne Klick - per Tastatur ging es gar nicht,
 *            und ein Klick auf eine Karte tat nichts;
 *        (b) das Namens-Autocomplete kannte nur die Mahlzeit-Historie; ein nie
 *            geplantes Rezept erschien nicht, und ein Treffer setzte nur den
 *            Titel - ohne Zutaten und ohne `recipe_id`;
 *        (c) die Vorschlagsliste war fuer den Screenreader unsichtbar: kein
 *            `role=combobox`, keine Optionen, kein `aria-expanded`.
 *
 * WIE GEMESSEN WIRD. Am laufenden Programm, nicht am Quelltext: die Ziel-
 * Rechnung der Spalte als reine Funktion, die Spalte ueber ihren echten
 * Renderer und ihren echten Klick-Handler, der Dialog ueber das echte
 * `openMealModal` mit seinem `onSave`. Die Attrappen unten bauen nur so viel
 * DOM nach, wie diese Pfade anfassen - Kinder, Attribute, Listener.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-meals-recipe-entry.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.inserted = [];
    this.hidden = false;
    this.value = '';
    this.id = '';
    this.className = '';
    this._text = '';
    const self = this;
    this.classList = {
      add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove(...c) { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      toggle(c, on) { if (on ?? !this.contains(c)) this.add(c); else this.remove(c); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent ?? '').join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this.inserted = []; cs.forEach((c) => this.appendChild(c)); }
  insertAdjacentHTML(_pos, html) { this.inserted.push(String(html)); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  fire(type, ev = {}) {
    const e = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...ev };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) {
      const m = sel.match(/^\[data-action="(.+)"\]$/);
      if (m && n.dataset?.action === m[1]) return n;
      if (sel.startsWith('.') && n.classList?.contains(sel.slice(1))) return n;
    }
    return null;
  }
  focus() {}
}

function installDocument() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (txt) => ({ textContent: String(txt) }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return () => { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; };
}

globalThis.HTMLElement = globalThis.HTMLElement ?? FakeEl;
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { __test: meals } = await import('../public/pages/meals.js');
const { todayKey } = await import('../public/utils/date.js');

const PIZZA = {
  id: 7, title: 'Pizza selbst gemacht', source: 'native', meal_types: ['dinner'],
  notes: 'Teig am Vortag', recipe_url: '', ingredients: [{ name: 'Mehl', quantity: '500 g', category: 'Backen' }],
};
const PORRIDGE = { id: 8, title: 'Porridge', source: 'native', meal_types: [], notes: '', recipe_url: '', ingredients: [] };

// ---------------------------------------------------------------------------
// (a) Die Rezept-Spalte: Knopf statt nur Ziehen, und wohin der Knopf plant
// ---------------------------------------------------------------------------

test('Spalte: das Ziel ist heute, in der Mahlzeit nach Uhrzeit, sonst der naechste freie Tag', () => {
  const base = {
    weekStart: '2026-09-28', today: '2026-09-30', visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'], meals: [],
  };
  assert.deepEqual(meals.railRecipeTarget({ ...base, recipe: PORRIDGE, hour: 18 }), { date: '2026-09-30', mealType: 'dinner' },
    'abends heute Abendessen');
  assert.deepEqual(meals.railRecipeTarget({ ...base, recipe: PORRIDGE, hour: 7 }), { date: '2026-09-30', mealType: 'breakfast' },
    'morgens Fruehstueck - nicht immer die erste Spalte');
  assert.deepEqual(meals.railRecipeTarget({ ...base, recipe: PORRIDGE, hour: 12 }), { date: '2026-09-30', mealType: 'lunch' });

  const belegt = [{ date: '2026-09-30', meal_type: 'dinner' }];
  assert.deepEqual(meals.railRecipeTarget({ ...base, recipe: PORRIDGE, hour: 18, meals: belegt }), { date: '2026-10-01', mealType: 'dinner' },
    'ist heute schon etwas geplant, rueckt es auf den naechsten freien Tag');

  assert.deepEqual(meals.railRecipeTarget({ ...base, recipe: PIZZA, hour: 7 }), { date: '2026-09-30', mealType: 'dinner' },
    'ein Rezept nur fuers Abendessen landet nicht im Fruehstueck');
  assert.deepEqual(
    meals.railRecipeTarget({ ...base, recipe: PORRIDGE, hour: 7, visibleMealTypes: ['lunch', 'dinner'] }),
    { date: '2026-09-30', mealType: 'lunch' },
    'eine ausgeblendete Mahlzeit ist kein Ziel');

  assert.deepEqual(meals.railRecipeTarget({ ...base, weekStart: '2026-10-05', recipe: PORRIDGE, hour: 18 }), { date: '2026-10-05', mealType: 'dinner' },
    'in einer kuenftigen Woche beginnt die Suche am Montag der sichtbaren Woche');
});

test('Spalte: jede Rezeptkarte traegt einen Knopf, der das Rezept mit Namen einplant', () => {
  const restore = installDocument();
  const sidebar = new FakeEl('aside');
  const saved = meals.state.recipes;
  meals.state.recipes = [PIZZA];
  meals.setContainerForTest({ querySelector: (sel) => (sel === '#recipe-sidebar' ? sidebar : null) });
  try {
    meals.renderRecipeSidebar();
    const list = sidebar.children.find((c) => c.className === 'recipe-sidebar__list');
    assert.ok(list, 'die Spalte hat ihre Liste gebaut');
    const card = list.children[0];
    assert.equal(card.draggable, true, 'Ziehen bleibt als Beschleuniger');
    const btn = card.children.find((c) => c.tagName === 'BUTTON');
    assert.ok(btn, 'die Karte traegt einen echten Knopf - fokussierbar und per Enter bedienbar');
    assert.equal(btn.type, 'button');
    assert.equal(btn.dataset.action, 'plan-recipe');
    assert.equal(btn.dataset.recipeId, '7');
    assert.match(btn.getAttribute('aria-label') ?? '', /meals\.planRecipeNamed.*Pizza selbst gemacht/,
      'der Name sagt, WAS der Knopf tut, und nennt das Rezept');
    const hint = sidebar.children.find((c) => c.className === 'recipe-sidebar__hint');
    assert.match(hint.textContent, /recipes\.railHint/, 'der Hinweis nennt nicht mehr nur das Ziehen');
  } finally {
    meals.state.recipes = saved;
    restore();
  }
});

/** Panel-Attrappe fuer den Mahlzeit-Dialog: je Selektor EIN Element. */
function dialogPanel() {
  const els = new Map();
  const el = (sel) => {
    if (!els.has(sel)) {
      const e = new FakeEl(sel === '#modal-title' ? 'input' : 'div');
      e.id = sel.replace(/^#/, '');
      els.set(sel, e);
    }
    return els.get(sel);
  };
  return { querySelector: el, querySelectorAll: () => [], el };
}

test('Spalte: Klick auf den Knopf oeffnet "Mahlzeit hinzufuegen" mit gesetztem Rezept', async () => {
  const restore = installDocument();
  const sidebar = new FakeEl('aside');
  const savedRecipes = meals.state.recipes;
  const savedWeek = meals.state.currentWeek;
  const savedMeals = meals.state.meals;
  meals.state.recipes = [PIZZA];
  meals.state.meals = [];
  meals.state.currentWeek = meals.getMondayOf(todayKey());
  meals.setContainerForTest({ querySelector: (sel) => (sel === '#recipe-sidebar' ? sidebar : null) });
  let opened = null;
  const zuvor = globalThis.__openModal;
  globalThis.__openModal = (opts) => { opened = opts; };
  try {
    delete sidebar.dataset.eventsWired;
    meals.wireRecipeSidebar();
    const btn = new FakeEl('button');
    btn.dataset.action = 'plan-recipe';
    btn.dataset.recipeId = '7';
    const inner = new FakeEl('span');
    btn.appendChild(inner);
    sidebar.fire('click', { target: inner });

    assert.ok(opened, 'der Klick oeffnet den Dialog');
    assert.match(opened.content, /<option value="7" selected>/, 'das Rezept ist im Dialog gewaehlt');
    assert.match(opened.content, /class="form-input" id="modal-type">[\s\S]*value="dinner" selected/,
      'Mahlzeit nach Rezept und Uhrzeit (Pizza ist nur Abendessen)');

    const panel = dialogPanel();
    opened.onSave(panel);
    assert.equal(panel.el('#modal-title').value, 'Pizza selbst gemacht', 'Titel aus dem Rezept');
    assert.equal(panel.el('#modal-recipe-id').value, '7', 'recipe_id geht mit');
    assert.match(panel.el('#ingredient-list').inserted.join(''), /Mehl/, 'die Zutaten kommen mit - der Weg zum Einkauf');
  } finally {
    globalThis.__openModal = zuvor;
    meals.state.recipes = savedRecipes;
    meals.state.meals = savedMeals;
    meals.state.currentWeek = savedWeek;
    meals.state.modal = null;
    restore();
  }
});

// ---------------------------------------------------------------------------
// (b) + (c) Das Namens-Autocomplete: Rezepte als Vorschlag, als Combobox
// ---------------------------------------------------------------------------

test('Autocomplete: gespeicherte Rezepte stehen vor der Historie, ohne Doppelung', () => {
  const hits = meals.mealTitleSuggestions('pi', [PIZZA, PORRIDGE], [{ title: 'Pizza selbst gemacht' }, { title: 'Pita mit Falafel' }]);
  assert.deepEqual(hits, [
    { title: 'Pizza selbst gemacht', recipeId: 7 },
    { title: 'Pita mit Falafel', recipeId: null },
  ], 'das nie geplante Rezept erscheint, der gleichnamige Historien-Eintrag nicht noch einmal');
  assert.deepEqual(meals.mealTitleSuggestions('RIDGE', [PIZZA, PORRIDGE], []), [{ title: 'Porridge', recipeId: 8 }],
    'Gross-/Kleinschreibung und Wortteile zaehlen nicht');
});

test('Autocomplete: das Namensfeld ist eine ARIA-1.2-Combobox', () => {
  const html = meals.buildModalContent({ mode: 'create', date: '2026-09-30', mealType: 'dinner', fromSlot: true });
  const input = html.match(/<input[^>]*id="modal-title"[^>]*>/)?.[0] ?? '';
  assert.match(input, /role="combobox"/);
  assert.match(input, /aria-autocomplete="list"/);
  assert.match(input, /aria-expanded="false"/);
  assert.match(input, /aria-controls="modal-autocomplete"/);
  assert.match(html, /id="modal-autocomplete"[^>]*role="listbox"[^>]*aria-label="meals\.suggestionsLabel"/);
});

test('Autocomplete: Rezepttreffer per Tastatur waehlen setzt Rezept, Zutaten und recipe_id', async () => {
  const restore = installDocument();
  const savedRecipes = meals.state.recipes;
  const savedMembers = meals.state.members;
  meals.state.recipes = [PIZZA, PORRIDGE];
  // Die Mitglieder sind geladen: mit leerer Liste holt der Dialog sie beim
  // Oeffnen nach (#1679), und der Stub unten beantwortet JEDEN GET mit
  // Titelvorschlaegen - die kaemen sonst als "Mitglieder" in die Koch-Auswahl.
  meals.state.members = [{ id: 1, display_name: 'Anna', avatar_color: '#FF9500', avatar_data: null }];
  const zuvorModal = globalThis.__openModal;
  const zuvorApi = globalThis.__apiStub;
  let opened = null;
  globalThis.__openModal = (opts) => { opened = opts; };
  globalThis.__apiStub = { get: async () => ({ data: [{ title: 'Pita mit Falafel' }] }) };
  try {
    meals.openMealModal({ mode: 'create', date: '2026-09-30', mealType: 'dinner', fromSlot: true });
    const panel = dialogPanel();
    opened.onSave(panel);
    const input = panel.el('#modal-title');
    const box = panel.el('#modal-autocomplete');

    input.value = 'Pi';
    input.fire('input');
    await new Promise((r) => setTimeout(r, 260));

    assert.equal(box.hidden, false, 'die Liste ist offen');
    assert.equal(input.getAttribute('aria-expanded'), 'true', 'und sagt es');
    assert.equal(box.children.length, 2);
    const [first, second] = box.children;
    assert.equal(first.getAttribute('role'), 'option');
    assert.match(first.textContent, /Pizza selbst gemacht/);
    assert.match(first.textContent, /meals\.suggestionRecipe/, 'ein Rezept ist als Rezept erkennbar');
    assert.ok(first.id && second.id && first.id !== second.id, 'jede Option hat eine eigene id');

    const down = input.fire('keydown', { key: 'ArrowDown' });
    assert.equal(down.defaultPrevented, true);
    assert.equal(input.getAttribute('aria-activedescendant'), first.id, 'der Fokus bleibt im Feld, die Markierung wandert');
    assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.equal(second.getAttribute('aria-selected'), 'false');

    const enter = input.fire('keydown', { key: 'Enter' });
    // Im Browser gemessen: bis zum Dialog durchgereicht, loeste dasselbe Enter
    // dessen Speichern aus - die Mahlzeit war angelegt, bevor man sie sah.
    assert.equal(enter.stopped, true, 'das Enter fuer den Vorschlag erreicht das Speichern des Dialogs nicht');
    assert.equal(input.value, 'Pizza selbst gemacht');
    assert.equal(panel.el('#modal-recipe-id').value, '7', 'recipe_id ist gesetzt');
    assert.match(panel.el('#ingredient-list').inserted.join(''), /Mehl/, 'applyRecipe hat die Zutaten eingesetzt');
    assert.equal(box.hidden, true);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);

    // Escape schliesst die Liste, nicht den Dialog.
    input.value = 'Pi';
    input.fire('input');
    await new Promise((r) => setTimeout(r, 260));
    const esc = input.fire('keydown', { key: 'Escape' });
    assert.equal(box.hidden, true);
    assert.equal(esc.stopped, true, 'das Escape fuer die Liste erreicht den Dialog nicht');

    // Historien-Treffer setzt nur den Titel.
    panel.el('#modal-recipe-id').value = '';
    input.value = 'Pi';
    input.fire('input');
    await new Promise((r) => setTimeout(r, 260));
    input.fire('keydown', { key: 'ArrowDown' });
    input.fire('keydown', { key: 'ArrowDown' });
    input.fire('keydown', { key: 'Enter' });
    assert.equal(input.value, 'Pita mit Falafel');
    assert.equal(panel.el('#modal-recipe-id').value, '', 'ein Historien-Eintrag ist kein Rezept');
  } finally {
    globalThis.__openModal = zuvorModal;
    globalThis.__apiStub = zuvorApi;
    meals.state.recipes = savedRecipes;
    meals.state.members = savedMembers;
    meals.state.modal = null;
    restore();
  }
});

// ---------------------------------------------------------------------------
// Verschieben per Ziehen: sofort, und im Fehlerfall hoerbar (Critique 2026-10-05, R16)
// ---------------------------------------------------------------------------
// `moveMeal` wartete auf den Server und baute erst danach neu: die Karte stand
// solange am alten Platz - das Ablegen sah aus, als haette es nicht geklappt.
// Scheiterte der Aufruf, baute die Woche still neu, und die Karte war ohne ein
// Wort wieder da, wo sie herkam.

test('Verschieben: die Karte steht sofort am Ziel, waehrend der Server noch antwortet', async () => {
  const meal = { id: 5, date: '2026-10-05', meal_type: 'lunch', title: 'Lachs' };
  meals.state.meals = [meal];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  globalThis.__apiStub = { put: (path, body) => { calls.push([path, body]); return gate.then(() => ({ data: null })); } };
  let renders = 0;
  const pending = meals.moveMeal(5, '2026-10-07', 'dinner', { rerender: () => { renders += 1; } });
  assert.deepEqual([meal.date, meal.meal_type], ['2026-10-07', 'dinner'], 'der Zustand zieht vor der Antwort um');
  assert.equal(renders, 1, 'und die Woche ist schon neu gezeichnet');
  assert.deepEqual(calls, [['/meals/5', { date: '2026-10-07', meal_type: 'dinner' }]]);
  release();
  await pending;
  assert.deepEqual([meal.date, meal.meal_type], ['2026-10-07', 'dinner']);
  delete globalThis.__apiStub;
});

test('Verschieben: scheitert der Server, kehrt die Karte zurueck UND es gibt eine Meldung', async () => {
  const meal = { id: 5, date: '2026-10-05', meal_type: 'lunch', title: 'Lachs' };
  meals.state.meals = [meal];
  globalThis.__apiStub = { put: async () => { const err = new Error('boom'); err.data = { error: 'Nicht erlaubt' }; throw err; } };
  const toasts = [];
  const prevYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { ...prevYuvomi, showToast: (...args) => toasts.push(args), friendlyError: (err) => err.data?.error };
  let renders = 0;
  try {
    await meals.moveMeal(5, '2026-10-07', 'dinner', { rerender: () => { renders += 1; } });
  } finally {
    globalThis.window.yuvomi = prevYuvomi;
    delete globalThis.__apiStub;
  }
  assert.deepEqual([meal.date, meal.meal_type], ['2026-10-05', 'lunch'], 'der Zustand steht wieder am Ursprung');
  assert.equal(renders, 2, 'einmal optimistisch, einmal zurueck');
  assert.deepEqual(toasts, [['Nicht erlaubt', 'danger']], 'der Fehler wird gemeldet, nicht verschluckt');
});

// Zweimal ziehen, bevor der Server geantwortet hat (Review #1673). Jeder Zug
// merkte sich als Ursprung den Platz, an dem die Karte GERADE stand - beim
// zweiten also das optimistische Ziel des ersten. Scheiterten beide, kehrte
// die Karte auf einen Tag zurueck, den der Server nie gespeichert hat.
function gatedPut() {
  const calls = [];
  const put = (path, body) => new Promise((resolve, reject) => { calls.push({ path, body, resolve, reject }); });
  return { calls, put };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('Verschieben: scheitern zwei Zuege derselben Karte, steht sie am letzten BESTAETIGTEN Platz', async () => {
  const meal = { id: 5, date: '2026-10-05', meal_type: 'lunch', title: 'Lachs' };
  meals.state.meals = [meal];
  const { calls, put } = gatedPut();
  globalThis.__apiStub = { put };
  const prevYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { ...prevYuvomi, showToast: () => {}, friendlyError: () => 'x' };
  try {
    const first = meals.moveMeal(5, '2026-10-06', 'lunch', { rerender: () => {} });
    const second = meals.moveMeal(5, '2026-10-07', 'dinner', { rerender: () => {} });
    assert.deepEqual([meal.date, meal.meal_type], ['2026-10-07', 'dinner'], 'optimistisch am Ziel des zweiten Zugs');
    await tick();
    assert.equal(calls.length, 1, 'der zweite Aufruf wartet, bis der erste entschieden ist');
    calls[0].reject(new Error('boom'));
    await first;
    assert.deepEqual([meal.date, meal.meal_type], ['2026-10-07', 'dinner'], 'der Platz gehoert noch dem spaeteren Zug');
    await tick();
    assert.equal(calls.length, 2);
    calls[1].reject(new Error('boom'));
    await second;
    assert.deepEqual([meal.date, meal.meal_type], ['2026-10-05', 'lunch'], 'nicht das gescheiterte Ziel des ersten Zugs');
  } finally {
    globalThis.window.yuvomi = prevYuvomi;
    delete globalThis.__apiStub;
  }
});

test('Verschieben: gelingt der erste Zug und scheitert der zweite, bleibt das Ziel des ersten', async () => {
  const meal = { id: 5, date: '2026-10-05', meal_type: 'lunch', title: 'Lachs' };
  meals.state.meals = [meal];
  const { calls, put } = gatedPut();
  globalThis.__apiStub = { put };
  const prevYuvomi = globalThis.window.yuvomi;
  globalThis.window.yuvomi = { ...prevYuvomi, showToast: () => {}, friendlyError: () => 'x' };
  try {
    const first = meals.moveMeal(5, '2026-10-06', 'lunch', { rerender: () => {} });
    const second = meals.moveMeal(5, '2026-10-07', 'dinner', { rerender: () => {} });
    await tick();
    calls[0].resolve({ data: null });
    await first;
    await tick();
    calls[1].reject(new Error('boom'));
    await second;
    assert.deepEqual([meal.date, meal.meal_type], ['2026-10-06', 'lunch'], 'dort steht sie auch auf dem Server');
  } finally {
    globalThis.window.yuvomi = prevYuvomi;
    delete globalThis.__apiStub;
  }
});

test('Speichern: die Quittung nennt das Ergebnis, nicht den Dialogtitel', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/meals.js', import.meta.url), 'utf8');
  // „Mahlzeit hinzufuegen" als Erfolgsmeldung liest sich wie eine Aufforderung.
  assert.doesNotMatch(src, /showToast\([^)]*t\('meals\.(addMealTitle|editMeal)'\)/);
  assert.match(src, /showToast\(mode === 'create' \? t\('meals\.mealSaved'\) : t\('meals\.mealUpdated'\), 'success'\)/);
});
