/**
 * Test: Das Brett zeigt jede Spalte, und jede laesst sich zuklappen (#1250)
 *
 * Zwei Befunde, eine Ursache - das Brett hat keine Grenze nach unten:
 *
 * 1. DIE VIERTE SPALTE STAND IN DER ZWEITEN RASTERZEILE. `KANBAN_COLS()` fuehrt
 *    offen, laufend, erledigt und abgelegt; `tasks.css` legte ab 640px
 *    `repeat(3, 1fr)`. "Abgelegt" fiel damit unter "Offen", und weil eine
 *    Rasterzeile ihre Hoehe von ihrer hoechsten Zelle nimmt, wanderte es mit
 *    jeder erledigten Aufgabe weiter nach unten. Die Drei-Spalten-Regel stammt
 *    aus dem Redesign vom Maerz, die vierte Spalte kam Ende April dazu: die
 *    Spalte wurde ergaenzt, das Layout nicht.
 * 2. "ERLEDIGT" UND "ABGELEGT" WACHSEN MONOTON. Das Brett haengt seinen
 *    Statusfilter bewusst nicht an die Abfrage und holt zusaetzlich das Archiv,
 *    zeigt also jede Aufgabe, die der Haushalt je hatte. Ein Fenster auf der
 *    Serverseite scheidet aus (docs/SCOPE.md: "lists are not paginated"), also
 *    muss man zuklappen koennen.
 *
 * WAS DIESE SUITE ANDERS MACHT ALS EIN TEXTGUARD. Die Rasterprobe zaehlt die
 * Spalten NICHT gegen eine Zahl im Stylesheet, sondern gegen `KANBAN_COLS()` -
 * sonst haelt sie nur die Schreibweise fest und geht beim naechsten Zuwachs
 * genauso still daneben wie beim letzten. Das Markup wird am Ergebnis von
 * `kanbanBoardHtml()` gemessen, nicht am Quelltext.
 *
 * Ausfuehren: npm run test:kanban-columns
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');
const tasksCss = await readFile(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');

const AUFGABE = (id, status) => ({
  id, title: `Aufgabe ${id}`, status, visibility: 'all', subtasks: [],
});

/** Das Brett mit je einer Aufgabe je Spalte. */
function brett() {
  const cols = tasks.KANBAN_COLS();
  const grouped = {};
  cols.forEach((col, i) => { grouped[col.status] = [AUFGABE(i + 1, col.status)]; });
  return tasks.kanbanBoardHtml(cols, grouped);
}

/** Eine Spalte zuklappen und danach sauber zuruecklassen. */
function mitZugeklappt(status, fn) {
  tasks.toggleKanbanCol(status);
  try { return fn(); } finally { tasks.toggleKanbanCol(status); }
}

/**
 * Die Spaltenzahl der breitesten Rasterstufe von `.kanban-board`.
 *
 * Ueber `eachRule()` statt per eigenem Regex - ein selbstgebautes Muster liest
 * den Kommentar ueber der Regel mit und findet dort jede Zahl, die jemand
 * erwaehnt hat.
 */
function breitesteRasterstufe() {
  let beste = null;
  for (const rule of eachRule(tasksCss)) {
    if (!rule.selector.split(',').some((sel) => sel.trim() === '.kanban-board')) continue;
    const spalten = /grid-template-columns:\s*repeat\(\s*(\d+)/.exec(rule.body);
    if (!spalten) continue;
    const mq = rule.at.map((a) => /min-width:\s*(\d+)px/.exec(a)).find(Boolean);
    const ab = mq ? Number(mq[1]) : 0;
    if (!beste || ab > beste.ab) beste = { ab, spalten: Number(spalten[1]) };
  }
  return beste;
}

test('das Raster legt so viele Spalten, wie das Brett fuehrt', () => {
  const stufe = breitesteRasterstufe();
  assert.ok(stufe, '.kanban-board hat keine repeat()-Rasterregel');
  assert.equal(stufe.spalten, tasks.KANBAN_COLS().length,
    `die breiteste Stufe (ab ${stufe.ab}px) legt ${stufe.spalten} Spalten, `
    + `KANBAN_COLS() fuehrt ${tasks.KANBAN_COLS().length} - die ueberzaehligen fallen in eine zweite Rasterzeile`);
});

test('jede Spalte traegt einen Knopf zum Zuklappen, keine anklickbare Ueberschrift', () => {
  const html = brett();
  for (const col of tasks.KANBAN_COLS()) {
    assert.match(html, new RegExp(`<button[^>]*data-kanban-toggle="${col.status}"`),
      `Spalte ${col.status} hat keinen Knopf`);
  }
  // KEIN Knopf ohne gemeldeten Zustand: ohne aria-expanded sagt er der
  // Tastaturbedienung nicht, was er bewirkt hat.
  assert.equal((html.match(/data-kanban-toggle=/g) ?? []).length,
    (html.match(/aria-expanded=/g) ?? []).length,
    'jeder Spaltenknopf meldet seinen Zustand');
});

test('eine zugeklappte Spalte versteckt ihren Koerper und behaelt ihren Zaehler', () => {
  const offen = brett();
  const zu = mitZugeklappt('done', brett);

  // DER GEGENFALL ZUERST - ohne ihn waere die Zusicherung auch dann gruen,
  // wenn der Koerper gar nicht mehr gezeichnet wuerde.
  assert.match(offen, /<div class="kanban-col__body" id="kanban-col-done"[^>]*>/,
    'offen steht der Koerper ohne hidden da');
  assert.ok(!/id="kanban-col-done"[^>]*hidden/.test(offen), 'und traegt kein hidden');

  assert.match(zu, /id="kanban-col-done"[^>]*hidden/, 'zugeklappt traegt der Koerper hidden');
  assert.match(zu, /data-kanban-toggle="done"[^>]*aria-expanded="false"/,
    'und der Knopf meldet es');
  assert.match(zu, /kanban-col--collapsed/, 'die Spalte ist als zugeklappt gezeichnet');

  // Der Zaehler bleibt: eine zugeklappte Spalte muss sagen koennen, wie viel
  // sie verbirgt, sonst klappt man sie zum Nachsehen wieder auf.
  assert.match(zu, /<span class="kanban-col__count">1<\/span>/,
    'der Zaehler steht weiter da');
});

test('die anderen Spalten bleiben vom Zuklappen unberuehrt', () => {
  const zu = mitZugeklappt('done', brett);
  assert.ok(!/id="kanban-col-open"[^>]*hidden/.test(zu), 'offen bleibt offen');
  assert.match(zu, /data-kanban-toggle="open"[^>]*aria-expanded="true"/,
    'und meldet das auch');
});

test('der Koerper hat eine eigene hidden-Regel, weil display: flex sie sonst sticht', () => {
  // NICHT KOSMETIK: `.kanban-col__body` setzt `display: flex`, und eine
  // Klassenregel sticht das `[hidden] { display: none }` des Browsers. Ohne
  // diese Regel traegt eine zugeklappte Spalte ihr Attribut und steht trotzdem
  // sichtbar da - fuer Screenreader zugleich als versteckt ausgewiesen.
  const regeln = [...eachRule(tasksCss)];
  const koerper = regeln.find((r) => r.selector === '.kanban-col__body');
  assert.ok(koerper, '.kanban-col__body fehlt');
  assert.match(koerper.body, /display:\s*flex/, 'der Koerper ist ein Flex-Container');

  const versteckt = regeln.find((r) => r.selector === '.kanban-col__body[hidden]');
  assert.ok(versteckt, '.kanban-col__body[hidden] fehlt - hidden waere wirkungslos');
  assert.match(versteckt.body, /display:\s*none/, 'und sie muss display: none setzen');
});

/**
 * Ein Brett, das `wireKanbanSortable` abfragen kann, ohne ein echtes DOM.
 * Gebraucht werden genau zwei Faehigkeiten: der Container findet das Brett, und
 * das Brett zaehlt seine Ablegezonen auf.
 */
function fakeBoard(zugeklappt = []) {
  const zonen = tasks.KANBAN_COLS().map((col) => ({ dataset: { dropZone: col.status } }));
  const board = { querySelectorAll: () => zonen };
  return { container: { querySelector: (sel) => (sel === '.kanban-board' ? board : null) }, zonen };
}

test('eine zugeklappte Spalte wird gar nicht erst als Ablegeziel verdrahtet', async () => {
  // DER RIEGEL HAT KEIN MARKUP, und deshalb steht er hier und nicht oben: eine
  // Ablegezone, die niemand verdrahtet, sieht im HTML aus wie jede andere.
  // SortableJS liest keine Sichtbarkeit - eine Instanz auf einem versteckten
  // Knoten nimmt weiter Karten an, und die verschwinden dann in einer Spalte,
  // die niemand sieht.
  const verdrahtet = async (status) => {
    globalThis.__sortableCalls = [];
    const { container } = fakeBoard();
    const zurueck = status ? (tasks.toggleKanbanCol(status), () => tasks.toggleKanbanCol(status)) : () => {};
    try {
      tasks.wireKanbanSortable(container);
      // makeSortable ist async; ein Tick reicht, der Stub loest sofort auf.
      await new Promise((r) => setTimeout(r, 0));
      return globalThis.__sortableCalls.map((c) => c.el.dataset.dropZone).sort();
    } finally {
      zurueck();
      delete globalThis.__sortableCalls;
    }
  };

  // DER GEGENFALL ZUERST: ohne ihn waere die Zusicherung auch dann gruen, wenn
  // ueberhaupt nichts mehr verdrahtet wuerde.
  const alle = await verdrahtet(null);
  assert.deepEqual(alle, tasks.KANBAN_COLS().map((c) => c.status).sort(),
    'offen wird jede Spalte verdrahtet');

  const ohneDone = await verdrahtet('done');
  assert.ok(!ohneDone.includes('done'),
    `die zugeklappte Spalte darf kein Ziel sein, verdrahtet wurde: ${ohneDone.join(', ')}`);
  assert.equal(ohneDone.length, tasks.KANBAN_COLS().length - 1,
    'und die anderen bleiben Ziele');
});

test('beide Beschriftungen liegen in allen Locales und sind nicht leer', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const { readdir } = await import('node:fs/promises');
  const dateien = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(dateien.length >= 20, `nur ${dateien.length} Locale-Dateien gefunden`);

  for (const datei of dateien) {
    const d = JSON.parse(await readFile(new URL(datei, dir), 'utf8'));
    for (const key of ['kanbanColCollapse', 'kanbanColExpand']) {
      const wert = d.tasks?.[key];
      assert.ok(typeof wert === 'string' && wert.trim(), `${datei}: tasks.${key} fehlt oder ist leer`);
      assert.ok(!wert.includes('[de:'), `${datei}: tasks.${key} traegt einen Platzhalter`);
    }
    assert.notEqual(d.tasks.kanbanColCollapse, d.tasks.kanbanColExpand,
      `${datei}: Zu- und Aufklappen tragen denselben Text`);
  }
});
