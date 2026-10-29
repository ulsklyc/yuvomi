/**
 * Test: Die Eingabezeile "Teilaufgabe hinzufuegen" legt im Blatt wirklich an (#1598)
 *
 * Zweck: Seit v2.70.0 wird der Knopf "Teilaufgabe hinzufuegen" in der
 *        Leseansicht zum Feld, Enter soll anlegen. In der Detailspalte ab
 *        1280px tat es das - im BLATT (jedes Telefon, jedes schmale Fenster)
 *        nie: der Focus-Trap von modal.js faengt Enter in jedem einzeiligen
 *        Feld ab und klickt den ERSTEN `button[type="submit"]` des ganzen
 *        Panels. In der Aufgabe ist das "Kommentieren" - der leere Kommentar
 *        tat nichts, `preventDefault()` nahm dem eigenen Formular des Feldes
 *        die implizite Absendung, und einen sichtbaren Knopf gab es nicht. Es
 *        blieb kein Weg, eine Teilaufgabe anzulegen.
 *
 * ZWEI SEITEN, BEIDE GEMESSEN. Der Trap muss den Absende-Knopf des Formulars
 * nehmen, in dem das Feld steht, und die Eingabezeile muss einen solchen Knopf
 * fuehren - eine Seite allein laesst den Fehler stehen. Der Trap laeuft hier
 * als ECHTE Funktion aus modal.js (`__test.trapFocus`) gegen Attrappen, die
 * Eingabezeile kommt aus dem echten `openTaskDetail`.
 *
 * Ausfuehren: npm run test:subtask-compose
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
import { installMiniDom } from './mini-dom.js';

installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};

const { __test: modalTest } = await import('../public/components/modal.js');
const { openTaskDetail } = await import('../public/components/task-detail.js');

// --------------------------------------------------------
// Der Trap: Enter gehoert dem Formular des Feldes
// --------------------------------------------------------

/**
 * Ein Knopf, der seine Klicks zaehlt. `form` ist sein Formular-BESITZER wie im
 * Browser (`button.form`): das umgebende <form> oder das per `form="id"`
 * zugeordnete - so haengt `mountFooter()` den Speichern-Knopf der Fusszeile an
 * sein Formular (#543). `versteckt` heisst: er steht in einem `[hidden]`-Ast.
 */
function knopf(name, { form = null, imFormular = false, versteckt = false } = {}) {
  const k = {
    name, type: 'submit', disabled: false, clicks: 0, form,
    click() { this.clicks += 1; },
    closest(selector) { return versteckt && selector.includes('[hidden]') ? {} : null; },
  };
  if (form && imFormular) form.eigene.push(k);
  return k;
}

/** Ein Formular; `querySelector` sieht nur Knoepfe, die IN ihm stehen. */
function formular() {
  return {
    eigene: [],
    querySelector(selector) {
      return selector.includes('button[type="submit"]') ? (this.eigene[0] ?? null) : null;
    },
  };
}

/** Ein Panel mit seinen Absende-Knoepfen in Dokumentreihenfolge. */
function panelMit(...knoepfe) {
  const listeners = new Map();
  const absender = (selector) => (selector.includes('button[type="submit"]') ? knoepfe : []);
  return {
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {},
    querySelector(selector) { return absender(selector)[0] ?? null; },
    querySelectorAll(selector) { return absender(selector); },
  };
}

const feld = (form) => ({ tagName: 'INPUT', type: 'text', form });

/** Enter im gegebenen Feld druecken; liefert, ob der Trap es verschluckt hat. */
function enterIn(panel, field) {
  globalThis.document.activeElement = field;
  let prevented = false;
  panel.listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented = true; } });
  return prevented;
}

test('Enter in einem Feld mit eigenem Formular klickt DESSEN Absende-Knopf, nicht den ersten des Panels', () => {
  assert.equal(typeof modalTest.trapFocus, 'function', 'modal.js gibt den Trap nicht mehr fuer Tests heraus');
  // Dokumentreihenfolge des Aufgabenblatts, hier bewusst UMGEKEHRT gestellt:
  // "Kommentieren" steht vorn, damit die Reihenfolge den Fehler nicht verdeckt.
  const kommentarForm = formular();
  const zeile = formular();
  const kommentieren = knopf('Kommentieren', { form: kommentarForm, imFormular: true });
  const hinzufuegen = knopf('Hinzufuegen', { form: zeile, imFormular: true });
  const panel = panelMit(kommentieren, hinzufuegen);
  modalTest.trapFocus(panel, 'none');

  enterIn(panel, feld(zeile));

  assert.equal(kommentieren.clicks, 0,
    'Enter in der Teilaufgaben-Zeile hat "Kommentieren" ausgeloest - der Trap nimmt den ersten Absende-Knopf des Panels statt den des Formulars');
  assert.equal(hinzufuegen.clicks, 1, 'der Absende-Knopf des eigenen Formulars wurde nicht ausgeloest');
});

test('ein Formular OHNE eigenen Absende-Knopf faellt weiter auf den des Panels (#543)', () => {
  // DER GEGENFALL: die meisten Blaetter tragen ihren Speichern-Knopf in der
  // Fusszeile, also AUSSERHALB des Formulars. Naehme der Trap nur noch Knoepfe
  // aus dem Formular, speicherte Enter dort nichts mehr.
  const speichern = knopf('Speichern');
  const panel = panelMit(speichern);
  modalTest.trapFocus(panel, 'none');

  assert.equal(enterIn(panel, feld(formular())), true);
  assert.equal(speichern.clicks, 1, 'Feld in einem Formular ohne eigenen Knopf');

  assert.equal(enterIn(panel, feld(null)), true);
  assert.equal(speichern.clicks, 2, 'Feld ganz ohne Formular');
});

test('ein gesperrter Absende-Knopf des eigenen Formulars loest nichts aus - auch nicht den des Panels', () => {
  // Gesperrt heisst "gerade unterwegs". Der Rueckfall auf das Panel waere hier
  // genau der Fehler aus #1598 durch die Hintertuer.
  const zeile = formular();
  const kommentieren = knopf('Kommentieren', { form: formular(), imFormular: true });
  const hinzufuegen = knopf('Hinzufuegen', { form: zeile, imFormular: true });
  hinzufuegen.disabled = true;
  const panel = panelMit(kommentieren, hinzufuegen);
  modalTest.trapFocus(panel, 'none');

  enterIn(panel, feld(zeile));
  assert.equal(kommentieren.clicks, 0);
  assert.equal(hinzufuegen.clicks, 0);
});

test('im Bearbeiten-Formular trifft Enter Speichern, nicht einen Knopf der versteckten Leseansicht', () => {
  // DAS BLATT NACH "BEARBEITEN" (Review zu PR #1611): die Leseansicht bleibt
  // `hidden` im DOM stehen, samt Teilaufgaben-Zeile und Kommentarfeld - und sie
  // steht VOR dem Formular. `mountFooter()` hebt die Fusszeile des Formulars
  // ans Panel und bindet "Speichern" per `form="id"` an sein Formular: der
  // Knopf steht also nicht mehr IN ihm, gehoert ihm aber. Der Rueckfall nahm
  // den ersten Treffer im Dokument - den versteckten Knopf der Leseansicht.
  const zeile = formular();
  const bearbeiten = formular();
  const hinzufuegen = knopf('Hinzufuegen', { form: zeile, imFormular: true, versteckt: true });
  const kommentieren = knopf('Kommentieren', { form: formular(), imFormular: true, versteckt: true });
  const speichern = knopf('Speichern', { form: bearbeiten });
  const panel = panelMit(hinzufuegen, kommentieren, speichern);
  modalTest.trapFocus(panel, 'none');

  assert.equal(enterIn(panel, feld(bearbeiten)), true, 'Enter wurde nicht als Absenden behandelt');
  assert.equal(hinzufuegen.clicks, 0, 'Enter im Titelfeld hat den versteckten "Hinzufuegen"-Knopf der Leseansicht ausgeloest');
  assert.equal(kommentieren.clicks, 0, 'Enter im Titelfeld hat das versteckte "Kommentieren" ausgeloest');
  assert.equal(speichern.clicks, 1, 'Enter im Titelfeld speichert die Aufgabe nicht');
});

test('der Rueckfall nimmt weder versteckte Knoepfe noch die eines FREMDEN Formulars', () => {
  // Sichtbar, aber fremd: ein zweites Formular im selben Blatt. Sein Absender
  // ist nicht die Antwort auf Enter in diesem Feld - lieber die formlose
  // Hauptaktion des Panels dahinter.
  const fremd = knopf('Kommentieren', { form: formular(), imFormular: true });
  const versteckt = knopf('Alt', { versteckt: true });
  const speichern = knopf('Speichern');
  const panel = panelMit(versteckt, fremd, speichern);
  modalTest.trapFocus(panel, 'none');

  assert.equal(enterIn(panel, feld(formular())), true);
  assert.deepEqual([versteckt.clicks, fremd.clicks, speichern.clicks], [0, 0, 1]);

  // Und wenn NUR Verstecktes da ist, passiert nichts - Enter bleibt beim Browser.
  const leer = panelMit(knopf('Alt', { versteckt: true }));
  modalTest.trapFocus(leer, 'none');
  assert.equal(enterIn(leer, feld(formular())), false, 'ein versteckter Knopf darf Enter nicht verschlucken');
});

// --------------------------------------------------------
// Die Eingabezeile: ein sichtbarer Knopf, der absendet
// --------------------------------------------------------

/** Die Eingabezeile der echten Leseansicht fuer eine Aufgabe, die man aendern darf. */
function eingabezeile() {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  try {
    openTaskDetail({
      task: { id: 7, title: 'Tisch decken', status: 'open', visibility: 'all', created_by: 2, subtasks: [] },
      currentUserId: 2,
    });
  } finally {
    delete globalThis.__openDetailView;
  }
  assert.ok(gesehen, 'die Leseansicht wurde gar nicht geoeffnet');
  const section = gesehen.sections.find((s) => s?.label === 'tasks.subtasksLabel');
  assert.ok(section?.node, 'die Leseansicht fuehrt keinen Teilaufgaben-Abschnitt');
  const form = section.node.childNodes.find((n) => n.tagName === 'form');
  assert.ok(form, 'die Eingabezeile ist kein <form> mehr');
  return form;
}

test('die Eingabezeile fuehrt neben dem Feld einen beschrifteten Absende-Knopf', () => {
  const form = eingabezeile();
  const input = form.childNodes.find((n) => n.tagName === 'input');
  assert.ok(input, 'das Feld fehlt');

  const submit = form.childNodes.find((n) => n.tagName === 'button' && n.type === 'submit');
  assert.ok(submit,
    'die Eingabezeile hat keinen button[type="submit"] - ohne ihn gibt es auf dem Telefon keinen sichtbaren Weg, '
    + 'die Teilaufgabe anzulegen, und der Focus-Trap des Blatts findet nur fremde Knoepfe');
  assert.equal(submit.textContent, 'common.add', 'der Knopf traegt seinen Namen als sichtbaren Text aus t()');
  assert.ok(form.childNodes.indexOf(input) < form.childNodes.indexOf(submit), 'der Knopf steht hinter dem Feld');
});

// --------------------------------------------------------
// R24 (Critique G2-Aufgaben-P2-2 / P3-2): Werte, Kommentar, Teilaufgaben
// --------------------------------------------------------

const { readFile } = await import('node:fs/promises');
const { eachRule } = await import('./css-rules.js');
const tasksCss = await readFile(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');
const detailCss = await readFile(new URL('../public/styles/detail-view.css', import.meta.url), 'utf8');
const regel = (css, selector) => [...eachRule(css)].find((r) => r.selector.trim() === selector && !r.at.length);

/** Die Abschnitte der echten Leseansicht. */
function leseansicht(task) {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  try {
    openTaskDetail({ task: { id: 7, title: 'Tisch decken', status: 'open', visibility: 'all', created_by: 2, subtasks: [], ...task }, currentUserId: 2 });
  } finally {
    delete globalThis.__openDetailView;
  }
  return gesehen.sections;
}

const knoten = (node, pred) => {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  for (const kind of node.childNodes ?? []) {
    const hit = knoten(kind, pred);
    if (hit) return hit;
  }
  return null;
};

test('R24: die Prioritaet ist in der Leseansicht ein Wert wie Status und Kategorie, kein Etikett der Metazeile', () => {
  const prio = leseansicht({ priority: 'high' }).find((s) => s?.label === 'tasks.priorityLabel');
  assert.ok(prio?.node, 'die Zeile Prioritaet fehlt');
  assert.equal(prio.node.className, 'detail-priority', 'das 13px-Etikett `.priority-badge` stand zwischen Werten in Body 17');
  assert.ok(knoten(prio.node, (n) => /priority-dot--high/.test(n.className ?? '')), 'die Rangmarke bleibt');
  const r = regel(tasksCss, '.detail-priority');
  assert.ok(r, '.detail-priority hat keine Regel');
  assert.doesNotMatch(r.body, /font-size|color:/, 'Groesse und Farbe erbt der Wert (`.detail-row__value`)');
});

test('R24: der Kommentar ist EINE Zeile mit dem Senden-Pfeil im Feld, ohne Ziehgriff', () => {
  const sec = leseansicht({}).find((s) => s?.label === 'tasks.commentsLabel');
  const form = knoten(sec.node, (n) => n.tagName === 'form');
  assert.ok(form, 'das Kommentarformular fehlt');
  const box = knoten(form, (n) => n.className === 'task-comments__field');
  const feld = knoten(box, (n) => n.tagName === 'textarea');
  const senden = knoten(box, (n) => n.tagName === 'button');
  assert.equal(feld?.rows, 1, 'einzeilig, waechst beim Tippen');
  assert.ok(senden, 'der Senden-Knopf steht IM Feldtraeger, nicht in einer eigenen Zeile darunter');
  assert.equal(senden.type, 'submit');
  assert.equal(senden.getAttribute('aria-label'), 'tasks.commentSubmit', 'der Pfeil traegt seinen Namen');
  assert.deepEqual(form.childNodes.filter((n) => n.tagName === 'button'), [], 'kein zweiter Knopf neben dem Feld');
  const input = regel(tasksCss, 'textarea.task-comment__input');
  assert.match(input?.body ?? '', /resize:\s*none/, 'kein nativer Ziehgriff (er schlug `textarea.input` in layout.css)');
  assert.match(input.body, /field-sizing:\s*content/);
  const pfeil = regel(tasksCss, '.task-comments__send');
  assert.match(pfeil?.body ?? '', /position:\s*absolute/);
  assert.match(pfeil.body, /inset-inline-end:\s*0/);
});

test('R24: der Stand der Teilaufgaben steht als Knopf in der Metazeile, die Liste rueckt unter den Titel', async () => {
  const { __test: tasks } = await import('../public/pages/tasks.js');
  const html = tasks.renderTaskCard({
    id: 7, title: 'Tisch decken', status: 'open', visibility: 'all', created_by: 2,
    subtask_total: 2, subtask_done: 1, assigned_users: [],
    subtasks: [{ id: 8, title: 'Teller', status: 'done' }, { id: 9, title: 'Besteck', status: 'open' }],
  });
  const meta = /<div class="task-card__meta">([\s\S]*?)\n          <\/div>/.exec(html)?.[1] ?? '';
  assert.match(meta, /<button type="button" class="subtask-toggle" data-action="toggle-subtasks"[^>]*aria-expanded="false"/,
    'der Aufklapper steht IN der Metazeile');
  assert.match(meta, /<span>1\/2<\/span>/, 'mit dem Stand als Text');
  assert.doesNotMatch(html, /subtask-progress/, 'kein 26px-Balken mehr unter der Zeile');
  const flaeche = regel(tasksCss, '.subtask-toggle::before');
  assert.match(flaeche?.body ?? '', /inset-block:\s*calc\(50% - var\(--target-base\) \/ 2\)/, 'Trefferflaeche 44 hoch');
  const metaRegel = regel(tasksCss, '.task-card__meta');
  assert.match(metaRegel.body, /overflow-x:\s*clip/);
  assert.doesNotMatch(metaRegel.body, /overflow:\s*hidden/, '`hidden` schnitt die Trefferflaeche auf die Textzeile');
  const liste = regel(tasksCss, '.subtask-list');
  assert.match(liste.body, /padding-inline:\s*var\(--task-title-inset\)/, 'die Ringe fluchten mit dem Titel');
});

test('R24: "Teilaufgabe hinzufuegen" ist eine ruhige Zeile, keine gestrichelte Kapsel - in der Liste wie im Detail', () => {
  for (const [css, sel] of [[tasksCss, '.subtask-item__add'], [detailCss, '.detail-subtask--add']]) {
    const r = regel(css, sel);
    assert.ok(r, `${sel} hat keine Regel`);
    assert.doesNotMatch(r.body, /dashed/, `${sel}: die einzige gestrichelte Kapsel der App`);
    assert.doesNotMatch(r.body, /radius-full/, `${sel}: keine Kapsel`);
  }
});

/* R24 S13 (Uebergabe S8): der Hinweis im einzeiligen Kommentarfeld endete am
 * Telefon in einer Ellipse - "Kommentar schreiben, @ erwähnt jemanden" ist bei
 * 17px 320px breit, das Feld laesst neben dem Senden-Pfeil 238px (390px,
 * gemessen). Jetzt die kurze Form "Kommentar, @ zum Erwähnen": gemessen in
 * allen 27 Sprachen 92-225px. Der Guard zaehlt Zeichen als Naeherung - die
 * Breite haengt an der Schrift, die Zahl an der Fassung. */
test('R24 S13: der Kommentar-Hinweis passt am Telefon in jeder Sprache in die Zeile', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const zuLang = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const text = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).tasks?.commentPlaceholder ?? '';
    assert.ok(text.includes('@'), `${file}: der Hinweis nennt die Erwaehnung`);
    if ([...text].length > 30) zuLang.push(`${file}: ${[...text].length}`);
  }
  assert.deepEqual(zuLang, [], 'laenger als 30 Zeichen laeuft am Telefon in die Ellipse');
});

/* Codex an #2364: Cmd/Strg+Enter ruft `requestSubmit()` - der gesperrte
 * Senden-Pfeil haelt das nicht auf. Ein zweiter Druck (oder die
 * Tastenwiederholung), waehrend der erste Kommentar noch speichert, schickte
 * denselben Kommentar noch einmal, samt Erwaehnungs-Mitteilungen. */
test('R24: ein zweites Cmd+Enter, waehrend der Kommentar speichert, schickt ihn nicht noch einmal', async () => {
  const { MiniElement } = await import('./mini-dom.js');
  const vorher = MiniElement.prototype.addEventListener;
  MiniElement.prototype.addEventListener = function (typ, handler) {
    this.listener = typ;
    ((this.handlers ??= {})[typ] ??= []).push(handler);
  };
  const posts = [];
  let fertig;
  const zuvor = globalThis.__apiStub;
  globalThis.__apiStub = {
    get: async () => ({ data: [] }),
    post: (path, body) => { posts.push([path, body]); return new Promise((r) => { fertig = r; }); },
  };
  try {
    const sec = leseansicht({}).find((s) => s?.label === 'tasks.commentsLabel');
    const form = knoten(sec.node, (n) => n.tagName === 'form');
    const feld = knoten(form, (n) => n.tagName === 'textarea');
    form.requestSubmit = () => form.handlers.submit.forEach((h) => h({ preventDefault() {} }));
    feld.value = 'Bin dabei @Alex';
    const cmdEnter = () => feld.handlers.keydown.forEach((h) => h({ key: 'Enter', metaKey: true, isComposing: false, keyCode: 13, preventDefault() {} }));
    cmdEnter();
    cmdEnter();
    cmdEnter();
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 1, 'jeder Druck schickte denselben Kommentar noch einmal');
    fertig({ data: {} });
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
    feld.value = 'Zweiter';
    cmdEnter();
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 2, 'nach dem Speichern geht der naechste Kommentar wieder');
  } finally {
    MiniElement.prototype.addEventListener = vorher;
    globalThis.__apiStub = zuvor;
  }
});
