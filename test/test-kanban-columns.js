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

test('der Koerper ist ausblendbar, obwohl display: flex die UA-Regel sticht', async () => {
  // NICHT KOSMETIK: `.kanban-col__body` setzt `display: flex`, und eine
  // Klassenregel sticht das `[hidden] { display: none }` des Browsers. Ohne
  // diese Regel traegt eine zugeklappte Spalte ihr Attribut und steht trotzdem
  // sichtbar da - fuer Screenreader zugleich als versteckt ausgewiesen.
  const regeln = [...eachRule(tasksCss)];
  const koerper = regeln.find((r) => r.selector === '.kanban-col__body');
  assert.ok(koerper, '.kanban-col__body fehlt');
  assert.match(koerper.body, /display:\s*flex/, 'der Koerper ist ein Flex-Container');

  // Seit R21 S9a die EINE globale Regel in reset.css statt einer je Klasse.
  const { globalHiddenRule } = await import('./css-rules.js');
  assert.ok(globalHiddenRule(), 'ohne die globale [hidden]-Regel waere hidden wirkungslos');
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

test('alle Spaltenkoepfe gleich hoch: die Archiv-Aktion ist eine kompakte Zeilenaktion (A3 P2-1)', () => {
  // Gemessen 50/50/70/50px: der 44px-Knopf "Alles Erledigte archivieren"
  // hob nur den Erledigt-Kopf. Jetzt Kanon-Zeilenaktion, sichtbar so hoch wie
  // --target-sm, und JEDER Kopf haelt diese Hoehe als Mindesthoehe.
  const html = brett();
  const knopf = /<button[^>]*data-kanban-archive-done[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(knopf, /class="row-action kanban-col__action"/, `Kanon row-action statt btn: ${knopf}`);
  assert.match(knopf, /aria-label="[^"]+"/, 'die Aktion hat einen Namen');

  const regeln = [...eachRule(tasksCss)];
  const kopf = regeln.find((r) => r.selector.trim() === '.kanban-col__header' && !r.at.length);
  assert.match(kopf?.body ?? '', /min-height:\s*calc\(var\(--target-sm\)/, `jeder Kopf haelt die Aktionshoehe: ${kopf?.body}`);
  const aktion = regeln.find((r) => r.selector.trim() === '.row-action.kanban-col__action' && !r.at.length);
  assert.match(aktion?.body ?? '', /(?:^|[\s;])height:\s*var\(--target-sm\)/, `die Aktion ist sichtbar kompakt: ${aktion?.body}`);
  const treffer = regeln.find((r) => r.selector.trim() === '.row-action.kanban-col__action::before');
  assert.match(treffer?.body ?? '', /--target-base/, 'die Treffflaeche waechst auf die Zielgroesse');
});

// #1607: eine gesperrte Aufgabe (`task.locked`, "nur die Zugewiesenen duerfen
// aendern") trug ihr Schloss in der Liste, im Brett nicht - wer die Ansicht
// wechselte, verlor die Auskunft und erfuhr sie erst am abgelehnten Zug.
test('eine gesperrte Aufgabe traegt ihr Schloss auch auf der Brettkarte', () => {
  const gesperrt = { ...AUFGABE(7, 'open'), locked: 1 };
  const schloss = (html) => /<span[^>]*>\s*<i data-lucide="lock"[^>]*><\/i>\s*<\/span>/.exec(html)?.[0] ?? null;

  const inListe = schloss(tasks.renderTaskCard(gesperrt));
  assert.ok(inListe, 'die Listenzeile zeigt kein Schloss - die Sonde findet das Vorbild nicht');
  assert.match(inListe, /role="img"/);
  assert.match(inListe, /aria-label="tasks\.lockedBadge"/, 'das Zeichen nennt seinen Zustand');

  const karte = tasks.renderKanbanCard(gesperrt);
  assert.equal(schloss(karte), inListe, 'die Brettkarte zeigt nicht dasselbe Zeichen wie die Liste');
  const meta = /<div class="kanban-card__meta">([\s\S]*?)<\/div>/.exec(karte)?.[1] ?? '';
  assert.ok(schloss(meta), 'das Schloss steht nicht in der Metazeile der Karte');

  // Und die andere Richtung: ohne Sperre kein Schloss, in keiner Ansicht.
  const offen = AUFGABE(8, 'open');
  assert.equal(schloss(tasks.renderKanbanCard(offen)), null);
  assert.equal(schloss(tasks.renderTaskCard(offen)), null);
});

// #1607: der Weiterschalt-Knopf ist ein Icon ohne Text. Sein Name war nur das
// Verb („In Bearbeitung setzen") - in einer Spalte mit zehn Karten zehnmal
// derselbe Name, und ein Screenreader konnte die Knoepfe nicht auseinander-
// halten. Der Name nennt jetzt die Aufgabe, der Tooltip bleibt beim Verb.
test('der Weiterschalt-Knopf einer Brettkarte nennt seine Aufgabe', () => {
  const knopf = (task) => /<button class="kanban-card__status-btn"[^>]*>/.exec(tasks.renderKanbanCard(task))?.[0] ?? '';
  const name = (task) => /aria-label="([^"]*)"/.exec(knopf(task))?.[1] ?? null;
  const tooltip = (task) => / title="([^"]*)"/.exec(knopf(task))?.[1] ?? null;

  const a = { ...AUFGABE(1, 'open'), title: 'Waesche' };
  const b = { ...AUFGABE(2, 'open'), title: 'Einkauf' };
  assert.ok(name(a) && name(b), 'Reichweite: beide Karten tragen den Knopf');
  assert.notEqual(name(a), name(b), 'zwei Karten derselben Spalte tragen denselben Knopfnamen');

  for (const [status, key, verb] of [
    ['open', 'tasks.kanbanMoveToInProgressNamed', 'tasks.kanbanMoveToInProgress'],
    ['in_progress', 'tasks.kanbanMoveToDoneNamed', 'tasks.kanbanMoveToDone'],
    ['done', 'tasks.kanbanMoveToOpenNamed', 'tasks.kanbanMoveToOpen'],
  ]) {
    const task = { ...AUFGABE(3, status), title: 'Waesche' };
    assert.ok(name(task).startsWith(key), `${status}: ${name(task)}`);
    assert.ok(name(task).includes('Waesche'), `${status}: der Name nennt die Aufgabe nicht`);
    assert.equal(tooltip(task), verb, `${status}: der Tooltip bleibt das Verb`);
  }

  // Aus der Ablage fuehrt der Knopf zurueck - mit dem Namen, den die Liste
  // dafuer schon hat.
  const abgelegt = { ...AUFGABE(4, 'done'), title: 'Waesche', archived_at: '2026-10-01T10:00:00Z' };
  assert.ok(name(abgelegt).startsWith('tasks.unarchiveNamed'), name(abgelegt));

  // Der Titel ist Nutzereingabe und steht in einem Attribut.
  const boese = { ...AUFGABE(5, 'open'), title: 'a"><img src=x onerror=1>' };
  assert.doesNotMatch(tasks.renderKanbanCard(boese), /<img/, 'der Titel bricht aus dem Attribut aus');
  assert.ok(name(boese).includes('&quot;'), 'der Name traegt den Titel maskiert');
});

/**
 * R22 (Critique a2, Persona Alex; D17/D22): EINE SPALTE HAT EINEN DECKEL.
 * "Offen" trug 158 Karten untereinander, jede mit Knoten und Zeichen, die der
 * Wechsel ins Brett im selben Frame baute (4x CPU: 282-338 ms, 4.100 Knoten).
 * Ab KANBAN_COL_CAP steht darunter "N weitere anzeigen", der Spaltenkopf zaehlt
 * weiter alle, und der Tipp zeigt die ganze Spalte.
 */
test('R22: eine Spalte zeigt hoechstens KANBAN_COL_CAP Karten, darunter "N weitere anzeigen"', async () => {
  const cols = tasks.KANBAN_COLS();
  const cap = tasks.KANBAN_COL_CAP;
  assert.equal(cap, 50, 'der Deckel liegt bei 50 Karten (D17)');
  const grouped = {};
  for (const col of cols) grouped[col.status] = [];
  for (let i = 1; i <= cap + 12; i++) grouped.open.push(AUFGABE(i, 'open'));
  grouped.done.push(AUFGABE(900, 'done'));
  const html = tasks.kanbanBoardHtml(cols, grouped);
  const offen = html.match(/data-status="open"[\s\S]*?(?=<div class="kanban-col[ "])/)[0];
  assert.equal((offen.match(/class="kanban-card /g) ?? []).length, cap, 'mehr Karten als der Deckel');
  assert.match(offen, /<span class="kanban-col__count">62<\/span>/, 'der Spaltenkopf zaehlt alle Karten');
  const de = JSON.parse(await readFile(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  assert.ok(de.tasks.kanbanShowMore, 'tasks.kanbanShowMore fehlt in de.json');
  assert.match(offen, /<button type="button" class="kanban-col__more" data-kanban-more="open">/, 'ohne Knopf bleibt der Rest unerreichbar');
  assert.doesNotMatch(html.replace(offen, ''), /kanban-col__more/, 'eine Spalte unter dem Deckel traegt keinen Knopf');
  tasks.showWholeKanbanCol('open');
  const ganz = tasks.kanbanBoardHtml(cols, grouped);
  assert.equal((ganz.match(/class="kanban-card /g) ?? []).length, cap + 13, 'nach dem Tipp steht die ganze Spalte');
  assert.doesNotMatch(ganz, /kanban-col__more/);
});

// R23 S11 (Critique G2 P3 "Kanban ⏵ mehrdeutig"): "In Bearbeitung setzen"
// trug das Abspielzeichen eines Medienspielers. Der Knopf sagt einen STATUS
// an wie seine Geschwister (Haken = erledigt, Pfeil zurueck = wieder offen).
test('R23: der Weiterschalt-Knopf der Karte traegt kein Abspielzeichen', async () => {
  const src = await readFile(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => /next === 'in_progress' \? '/.test(l)) ?? '';
  assert.match(line, /next === 'in_progress' \? 'circle-dot-dashed'/, line);
  assert.doesNotMatch(src, /'circle-play'/);
});

// R24 (Critique G2-Aufgaben-P3-1): die LEERE Ablage nahm ein Viertel des
// Bretts ("Keine Aufgaben" in 280px neben drei arbeitenden Spalten). Leer ist
// sie am Desktop nur so breit wie ihr Kopf - und bleibt Ablageziel.
test('R24: die leere Ablage ist nur ihr Kopf breit, die gefuellte eine volle Spalte', () => {
  const cols = tasks.KANBAN_COLS();
  const grouped = {};
  for (const col of cols) grouped[col.status] = [];
  grouped.open.push(AUFGABE(1, 'open'));
  const leer = tasks.kanbanBoardHtml(cols, grouped);
  assert.match(leer, /class="kanban-col kanban-col--vacant" data-status="archived"/, 'die leere Ablage traegt ihre Marke');
  assert.match(leer, /data-drop-zone="archived"/, 'und bleibt Ablageziel');
  assert.equal((leer.match(/kanban-col--vacant/g) ?? []).length, 1, 'nur die Ablage, keine leere Arbeitsspalte');
  grouped.archived.push({ ...AUFGABE(2, 'done'), archived_at: '2026-10-01T10:00:00Z' });
  assert.doesNotMatch(tasks.kanbanBoardHtml(cols, grouped), /kanban-col--vacant/, 'mit Karte ist sie eine volle Spalte');
  const regel = [...eachRule(tasksCss)].find((r) => r.selector.trim() === '.kanban-board:has(> .kanban-col--vacant)');
  assert.ok(regel, 'Rasterregel fuer die leere Ablage fehlt');
  assert.ok(regel.at.some((a) => /min-width:\s*1024px/.test(a)), 'nur dort, wo alle Spalten nebeneinander stehen');
  assert.match(regel.body, new RegExp(`repeat\\(${cols.length - 1}, minmax\\(0, 1fr\\)\\) max-content`),
    'die arbeitenden Spalten teilen sich den Rest, die Ablage nimmt ihre Inhaltsbreite');
});

// R24 (Critique G2-Aufgaben-P3-4): der Weiterschalt-Knopf war ein 24px-Kreis
// mit wechselndem Zeichen; das Verb stand nur im Tooltip. Jetzt steht es da.
test('R24: der Weiterschalt-Knopf traegt sein Verb sichtbar, der Name nennt weiter die Aufgabe', () => {
  const verb = (task) => /<span class="kanban-card__status-verb">([^<]*)<\/span>/.exec(tasks.renderKanbanCard(task))?.[1];
  assert.equal(verb(AUFGABE(1, 'open')), 'tasks.detailStart');
  assert.equal(verb(AUFGABE(1, 'in_progress')), 'tasks.detailFinish');
  assert.equal(verb(AUFGABE(1, 'done')), 'tasks.detailReopen');
  assert.equal(verb({ ...AUFGABE(1, 'done'), archived_at: '2026-10-01T10:00:00Z' }), 'tasks.kanbanRestore');
  assert.match(tasks.renderKanbanCard(AUFGABE(1, 'open')), /aria-label="[^"]*kanbanMoveToInProgressNamed/,
    'der Name nennt weiter Handlung UND Aufgabe (#1607)');
  // Mobil ist die Karte eine Zeile: dort bleibt der Kreis, das Verb geht.
  const mobil = [...eachRule(tasksCss)].find((r) => r.selector.trim() === '.kanban-card__status-verb'
    && r.at.some((a) => /max-width:\s*639px/.test(a)));
  assert.ok(mobil && /display:\s*none/.test(mobil.body), 'unter 640px kostete das Verb dem Titel 90px');
});
