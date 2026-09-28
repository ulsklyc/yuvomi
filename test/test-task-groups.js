/**
 * Modul: Aufgaben-Gruppen und ihre stabilen Schlüssel (#812)
 * Zweck: Gruppenköpfe lassen sich zuklappen, und der Zustand wird gespeichert.
 *        Gespeichert werden darf dabei nur ein Schlüssel, der eine Übersetzung
 *        überlebt: das angezeigte Label wechselt mit der Sprache, „Heute" und
 *        „Today" wären sonst zwei verschiedene Gruppen und jeder Sprachwechsel
 *        klappte alles wieder auf.
 *
 *        Deckt ab:
 *          - groupBy liefert je Gruppe { id, label, tasks }
 *          - die id ist sprachunabhängig, das label übersetzt
 *          - der Speicher-Schlüssel trennt die beiden Gruppierungen
 *          - die Reihenfolge der Fälligkeits-Gruppen bleibt die fachliche
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-task-groups.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// /pages/tasks.js zieht zwei Web Components mit (Kategorie- und Tag-Verwalter),
// die zur Ladezeit von HTMLElement ableiten. Node kennt das Global nicht; ein
// leerer Platzhalter reicht, weil hier nur reine Funktionen geprüft werden.
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { __test: tasks } = await import('../public/pages/tasks.js');

const task = (over = {}) => ({ id: 1, title: 'X', category: 'household', due_date: null, ...over });
// Kalendertag in der LOKALEN Zone. `groupBy` vergleicht gegen den lokalen Tag
// (ueber `todayKey()`), und aus `toISOString()` gebildet lag "heute" oestlich
// von UTC zwischen lokaler und UTC-Mitternacht einen Tag zurueck - die Gruppe
// "today" fiel dann weg und der Test kippte. Genau die Falle aus CLAUDE.md.
const dateKey = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const heute = () => dateKey(new Date());
const inTagen = (n) => dateKey(new Date(Date.now() + n * 86400000));

test('groupBy liefert Gruppen mit id, label und Aufgaben', () => {
  const groups = tasks.groupBy([task({ id: 1 }), task({ id: 2, category: 'school' })], 'category');
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.ok(typeof g.id === 'string' && g.id.length > 0, 'jede Gruppe braucht eine id');
    assert.ok(typeof g.label === 'string', 'und ein Label');
    assert.ok(Array.isArray(g.tasks), 'und ihre Aufgaben');
  }
});

test('die id einer Kategorie ist ihr Schlüssel, nicht ihr übersetztes Label', () => {
  const [gruppe] = tasks.groupBy([task({ category: 'household' })], 'category');
  assert.equal(gruppe.id, 'household',
    'das Label kann "Haushalt" oder "Household" sein - gespeichert wird der Schlüssel');
});

test('die Fälligkeits-Gruppen tragen feste ids', () => {
  const groups = tasks.groupBy([
    task({ id: 1, due_date: inTagen(-3) }),
    task({ id: 2, due_date: heute() }),
    task({ id: 3, due_date: inTagen(30) }),
    task({ id: 4, due_date: null }),
  ], 'due');

  const ids = groups.map((g) => g.id);
  assert.deepEqual(ids, ['overdue', 'today', 'later', 'noDate'],
    'ids UND ihre fachliche Reihenfolge: überfällig zuerst, ohne Datum zuletzt');
  for (const g of groups) {
    assert.notEqual(g.id, g.label, 'wäre id === label, hinge der gespeicherte Zustand an der Sprache');
  }
});

// Wie /tasks/categories sie liefert: nach `sort_order`, Seed-Zeilen mit
// label_key und name = NULL. Die Reihenfolge hier ist BEWUSST nicht
// alphabetisch - weder nach Key noch nach Label -, sonst kann der Test die
// beiden Sortierungen nicht auseinanderhalten.
const CATEGORIES = [
  { key: 'household', name: null,     label_key: 'tasks.categoryHousehold', sort_order: 0 },
  { key: 'ca-rental', name: 'CA Rental', label_key: null,                   sort_order: 1 },
  { key: 'misc',      name: null,     label_key: 'tasks.categoryMisc',      sort_order: 2 },
  { key: 'finance',   name: 'Finance',   label_key: null,                   sort_order: 3 },
];

test('die Kategorie-Gruppen folgen der verwalteten Reihenfolge, nicht dem Alphabet', () => {
  // Genau der Fall aus #845: „Household" wurde im Verwalter nach oben gezogen,
  // stand auf der Aufgabenseite aber weiter hinter „CA Rental" und „Finance".
  const groups = tasks.groupBy([
    task({ id: 1, category: 'finance' }),
    task({ id: 2, category: 'household' }),
    task({ id: 3, category: 'ca-rental' }),
  ], 'category', CATEGORIES);

  assert.deepEqual(groups.map((g) => g.id), ['household', 'ca-rental', 'finance'],
    'die Reihenfolge kommt aus sort_order - alphabetisch stuende CA Rental zuerst');
});

test('eine Kategorie ohne Eintrag in der Liste steht hinten, nicht vorne', () => {
  // Eine gerade geloeschte oder noch nicht nachgeladene Kategorie darf die
  // verwaltete Reihenfolge nicht aufmischen: MAX_SAFE_INTEGER, nicht -1.
  const groups = tasks.groupBy([
    task({ id: 1, category: 'ghost' }),
    task({ id: 2, category: 'misc' }),
  ], 'category', CATEGORIES);

  assert.deepEqual(groups.map((g) => g.id), ['misc', 'ghost'],
    'ein unbekannter Key faellt ans Ende');
});

test('die Kategorie-Sortierung liest weder den rohen Key noch eine feste Sprache', () => {
  // Regel ueber die Quelle statt ueber ein Ergebnis: die Fassung vor #845
  // sortierte `a.localeCompare(b, 'de')` - also den internen Schluessel, in
  // fest verdrahtetem Deutsch. Beides bleibt gruen, solange die Testdaten
  // zufaellig passend heissen, deshalb hier die Regel selbst.
  const source = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const groupBySource = source
    .slice(source.indexOf('function groupBy(tasks, mode'), source.indexOf('// Render-Bausteine'))
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  assert.ok(
    !/localeCompare\([^)]*'de'/.test(groupBySource),
    'die Gruppierung sortiert in fest verdrahtetem Deutsch statt in der aktiven Sprache',
  );
  assert.ok(
    groupBySource.includes('catSortIndex('),
    'die Gruppierung fragt nicht catSortIndex() - damit ignoriert sie sort_order (#845)',
  );
});

test('der Speicher-Schlüssel trennt die beiden Gruppierungen', () => {
  // Eine Kategorie darf „heute" heißen, ohne die Fälligkeits-Gruppe mitzuklappen.
  assert.notEqual(tasks.groupKey('category', 'today'), tasks.groupKey('due', 'today'));
  assert.equal(tasks.groupKey('due', 'overdue'), 'due:overdue');
});

test('die Faelligkeits-Rechnung vergleicht Kalendertage, keine Zeitpunkte', () => {
  // Der Fall oben faengt den Fehler NUR in Zonen ab +12 Stunden: dort rundet
  // ein halber Tag Differenz auf einen ganzen auf, und eine heute faellige
  // Aufgabe rutscht eine Gruppe weiter. In Berlin, UTC oder Los Angeles bleibt
  // er gruen, obwohl der Fehler dasteht - der Test ist also genau dort blind,
  // wo er entwickelt wird.
  //
  // Deshalb hier die Regel ueber die Quelle statt ueber ein Ergebnis:
  // `new Date('2026-08-24')` ist UTC-Mitternacht, `setHours(0, 0, 0, 0)` die
  // lokale. Wer die beiden voneinander abzieht, rechnet den Zonen-Offset mit.
  const source = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const groupBySource = source
    .slice(source.indexOf('function groupBy(tasks, mode'), source.indexOf('// Render-Bausteine'))
    // Ohne die Kommentare: der Kommentar an der Fundstelle ZITIERT die alte
    // Rechnung, um zu erklaeren, was daran falsch war. Ein Guard, der Prosa
    // liest, meldet dann genau die Stelle, die ihn befolgt.
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  assert.ok(
    !/new Date\(task\.due_date\)/.test(groupBySource),
    'die Gruppierung parst ein Datum als Instant - `parseLocalDateKey()` liest es als Kalendertag',
  );
  assert.ok(
    !/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(groupBySource),
    'die Gruppierung baut ihre Tagesgrenze aus der Wanduhr statt aus `todayKey()`',
  );
  assert.ok(
    groupBySource.includes('todayKey()'),
    'die Gruppierung fragt nicht `todayKey()` - damit folgt sie nicht der Haushaltszone (#829)',
  );
});

// ── Die Beschriftung geht nach derselben Uhr wie die Gruppierung ────────────
/* Die Gruppierung folgt seit #829 `todayKey()` und damit der Anzeigezone. Die
 * Beschriftung daneben tat es nicht: sie baute aus `due_date`/`due_time` ein
 * `new Date(...)` und las dessen Browser-Getter. Dieselbe Ansicht ging damit
 * nach zwei Uhren - eine Aufgabe konnte unter "Morgen" stehen und "Heute
 * faellig" heissen (Nachlese aus #851).
 *
 * Zwei Dinge sind zu pruefen, und nur das erste faellt in diesem Kontext auf:
 * dass "heute"/"morgen" der Anzeigezone folgen, und dass die eingetippte
 * Wanduhrzeit als STEMPEL an die Formatierer geht statt als Zeitpunkt der
 * Browser-Zone. Die fertige Schreibweise laesst sich hier nicht pruefen - i18n
 * ist im Node-Kontext nicht die echte Implementierung. */

const tzModule = await import('/utils/timezone.js');

test('die Faelligkeits-Beschriftung folgt der Anzeigezone, nicht dem Browser', () => {
  const p2 = (n) => String(n).padStart(2, '0');
  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tzModule.setDisplayTimeZone(zone);
      const now = tzModule.nowFields();
      const today = `${now.year}-${p2(now.month)}-${p2(now.day)}`;
      const shift = (days) => {
        const [y, m, d] = today.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
      };

      assert.match(tasks.formatDueDate(today, '21:00:00').label, /tasks\.(dueToday|overdue)/,
        `${zone}: der heutige Tag der Anzeigezone muss als heute gelten`);
      assert.match(tasks.formatDueDate(shift(1), '09:30:00').label, /tasks\.dueTomorrow/,
        `${zone}: der Folgetag der Anzeigezone ist morgen`);
      assert.match(tasks.formatDueDate(shift(-1), '21:00:00').label, /tasks\.overdue/,
        `${zone}: gestern ist ueberfaellig`);

      // Und die Gruppierung sagt fuer dieselben Tage dasselbe.
      const groups = tasks.groupBy([
        task({ id: 1, due_date: today }),
        task({ id: 2, due_date: shift(1) }),
        task({ id: 3, due_date: shift(-1) }),
      ], 'due');
      assert.ok(groups.some((g) => g.id === 'today'), `${zone}: Gruppe "heute" fehlt`);
      assert.ok(groups.some((g) => g.id === 'overdue'), `${zone}: Gruppe "ueberfaellig" fehlt`);
    }
  } finally {
    tzModule.setDisplayTimeZone(null);
  }
});

test('die Wanduhrzeit geht als Stempel an die Formatierer, nicht als Date', () => {
  try {
    tzModule.setDisplayTimeZone('Pacific/Honolulu');
    const now = tzModule.nowFields();
    const p2 = (n) => String(n).padStart(2, '0');
    const [y, m, d] = [now.year, now.month, now.day];
    const yesterday = new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
    const label = tasks.formatDueDate(yesterday, '21:00:00').label;
    assert.match(label, new RegExp(`${yesterday}T21:00|21:00`),
      `die eingetippte Uhrzeit muss erhalten bleiben, erhalten: ${label}`);
    assert.ok(!/GMT/.test(label),
      `ein Date-Umweg friert die Zeit in der Browser-Zone ein, erhalten: ${label}`);
  } finally {
    tzModule.setDisplayTimeZone(null);
  }
});

// --------------------------------------------------------
// Filterachse Kategorie (D#1017): der Server kannte `?category=` seit #825,
// das Panel bot die Achse nie an. Der Filterzustand muss sie tragen, der
// Query-String muss sie senden - in BEIDEN Ansichten, weil die Liste nach
// Kategorie gruppieren kann und das Board nicht.
test('normalizeFilterSet traegt die Kategorie-Achse als Liste', () => {
  const set = tasks.normalizeFilterSet({ status: 'open', category: 'garden' });
  assert.deepEqual(set.category, ['garden']);
  assert.deepEqual(tasks.normalizeFilterSet({}).category, []);
  assert.deepEqual(tasks.normalizeFilterSet({ category: ['a', 'b'] }).category, ['a', 'b']);
});

test('taskQuery sendet jede gewaehlte Kategorie als eigenen Parameter, auch im Kanban', () => {
  const before = { filters: tasks.state.filters, viewMode: tasks.state.viewMode, showFuture: tasks.state.showFuture };
  try {
    tasks.state.showFuture = false;
    tasks.state.filters = tasks.normalizeFilterSet({ status: ['open'], category: ['garden', 'household'] });
    tasks.state.viewMode = 'list';
    const list = new URLSearchParams(tasks.taskQuery().slice(1));
    assert.deepEqual(list.getAll('category'), ['garden', 'household']);
    assert.deepEqual(list.getAll('status'), ['open']);
    tasks.state.viewMode = 'kanban';
    const board = new URLSearchParams(tasks.taskQuery().slice(1));
    assert.deepEqual(board.getAll('category'), ['garden', 'household']);
    assert.deepEqual(board.getAll('status'), [], 'im Kanban sind die Spalten der Status');
  } finally {
    Object.assign(tasks.state, before);
  }
});

// -------------------------------------------------------------------------
// Teilaufgaben als Eingabezeile (Re-Critique 2026-09-28, A3 P1-1)
//
// "Teilaufgabe hinzufuegen" oeffnete einen modalen Prompt je Punkt; fuenf
// Punkte kosteten fuenfzehn Gesten. Jetzt wird der Knopf an Ort und Stelle
// zum Feld: Enter legt an und laesst den Fokus stehen, Escape schliesst.
// Gefahren wird der echte Knoten aus subtaskListNode() gegen einen kleinen
// DOM mit Ereignissen (mini-dom kennt keine) und einen eigenen api-Stub.
// -------------------------------------------------------------------------

function eventDom() {
  let active = null;
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), attrs: new Map(), dataset: {}, children: [], handlers: {},
      hidden: false, value: '', disabled: false, parent: null, isConnected: true,
      setAttribute(k, v) { this.attrs.set(k, String(v)); },
      getAttribute(k) { return this.attrs.get(k) ?? null; },
      removeAttribute(k) { this.attrs.delete(k); },
      appendChild(n) { n.parent = this; this.children.push(n); return n; },
      append(...ns) { ns.forEach((n) => this.appendChild(n)); },
      replaceChildren(...ns) { this.children = []; this.append(...ns); },
      // Wie im echten DOM: ein schon eingehaengter Knoten WANDERT.
      insertBefore(n, ref) {
        if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
        n.parent = this;
        const i = this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, n);
        return n;
      },
      contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; },
      addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); },
      focus() { active = this; },
      fire(type, extra = {}) {
        const ev = { type, target: this, defaultPrevented: false, propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...extra };
        return Promise.all((this.handlers[type] ?? []).map((fn) => fn(ev))).then(() => ev);
      },
    };
    return el;
  };
  return { document: { createElement: make }, active: () => active };
}

test('Teilaufgabe: der Knopf wird zur Eingabezeile, Enter legt an und behaelt den Fokus, Escape schliesst', async () => {
  const dom = eventDom();
  const vorher = { document: globalThis.document, window: globalThis.window, api: globalThis.__apiStub };
  globalThis.document = dom.document;
  globalThis.window = { yuvomi: { showToast() {} } };
  const posts = [];
  globalThis.__apiStub = { post: async (url, body) => { posts.push([url, body]); return { data: { id: 90 + posts.length, title: body.title, status: 'open' } }; } };
  try {
    const { __test: detail } = await import('../public/components/task-detail.js');
    let changed = 0;
    const task = { id: 7, title: 'Umzug', status: 'open', subtasks: [] };
    const wrap = detail.subtaskListNode(task, { onChanged: () => { changed += 1; } });
    const add = wrap.children.find((n) => /detail-subtask--add/.test(n.className));
    const form = wrap.children.find((n) => n.tagName === 'FORM');
    const input = form.children[0];
    assert.ok(add && form && input, 'Knopf und Eingabezeile stehen in der Liste');
    assert.equal(form.hidden, true, 'die Zeile ist zu, bis sie gebraucht wird');
    assert.match(input.getAttribute('aria-label') ?? '', /tasks\.subtaskAddNamed/, 'das Feld hat einen Namen');

    await add.fire('click');
    assert.equal(form.hidden, false, 'ein Klick oeffnet das Feld an Ort und Stelle');
    assert.equal(add.hidden, true);
    assert.equal(dom.active(), input, 'der Fokus steht im Feld');

    for (const title of ['Kartons', 'Transporter']) {
      input.value = title;
      const ev = await form.fire('submit');
      assert.ok(ev.defaultPrevented, 'kein Seitenwechsel durch das Formular');
      assert.equal(input.value, '', 'nach dem Anlegen ist das Feld leer fuer die naechste');
      assert.equal(form.hidden, false, 'und bleibt offen');
      assert.equal(dom.active(), input, 'mit dem Fokus darin');
    }
    assert.deepEqual(posts.map(([url, body]) => [url, body.title, body.parent_task_id]),
      [['/tasks', 'Kartons', 7], ['/tasks', 'Transporter', 7]]);
    assert.equal(changed, 2, 'die Umgebung erfaehrt jede Anlage');
    const rows = wrap.children.filter((n) => n.dataset.subtaskId);
    assert.deepEqual(rows.map((r) => r.dataset.subtaskId), ['91', '92'], 'die neuen Zeilen stehen vor dem Feld');
    assert.ok(wrap.children.indexOf(rows[1]) < wrap.children.indexOf(add));

    const esc = await input.fire('keydown', { key: 'Escape' });
    assert.ok(esc.propagationStopped, 'Escape schliesst nur das Feld, nicht das Blatt darum');
    assert.equal(form.hidden, true);
    assert.equal(add.hidden, false);
    assert.equal(dom.active(), add, 'der Fokus kehrt auf den Knopf zurueck');

    await add.fire('click');
    input.value = '   ';
    await form.fire('submit');
    assert.equal(form.hidden, true, 'Enter auf leerem Feld schliesst');
    assert.equal(posts.length, 2, 'und legt nichts an');
  } finally {
    globalThis.document = vorher.document;
    globalThis.window = vorher.window;
    if (vorher.api === undefined) delete globalThis.__apiStub; else globalThis.__apiStub = vorher.api;
  }
});

test('Teilaufgabe: kein modaler Prompt mehr, weder in der Leseansicht noch aus der Liste', () => {
  const detail = readFileSync(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert.ok(!/promptModal\(/.test(detail), 'task-detail.js fragt den Titel nicht mehr per Dialog ab');
  const handler = page.slice(page.indexOf("if (action === 'add-subtask') {"));
  assert.ok(handler.length > 0 && !/promptModal\(|addSubtask\(/.test(handler.slice(0, 800)),
    'die Aktion der Liste oeffnet die Leseansicht mit der Eingabezeile');
  assert.match(handler.slice(0, 800), /composeSubtaskFor = parentId/);
});

test('Aufgabendialog: Prioritaet und Kategorie offen im Hauptteil, der Aufklapper nennt, was dahinter liegt (A3 P1-2)', () => {
  const vorher = globalThis.__advancedSection;
  const optionen = [];
  globalThis.__advancedSection = (inner, options) => { optionen.push(options); return `<ADV>${inner}</ADV>`; };
  try {
    const html = tasks.renderModalContent({ task: null, users: [], reminder: null });
    const adv = html.indexOf('<ADV>');
    assert.ok(adv > 0, 'der Aufklapper steht im Dialog');
    for (const id of ['task-priority', 'task-category']) {
      const at = html.indexOf(`id="${id}"`);
      assert.ok(at > 0 && at < adv, `${id} steht vor dem Aufklapper, nicht dahinter`);
    }
    const hint = optionen.at(-1)?.hint ?? '';
    assert.ok(hint.length > 0, 'ohne hint sagt "Weitere Einstellungen" nicht, was dahinter liegt');
    for (const key of ['tasks.startDateLabel', 'tasks.pointsLabel', 'tasks.tagsLabel']) {
      assert.ok(hint.includes(key), `der Hinweis nennt ${key}: ${hint}`);
    }
    assert.ok(!hint.includes('tasks.priorityLabel'), 'was offen steht, nennt der Hinweis nicht');
  } finally {
    if (vorher === undefined) delete globalThis.__advancedSection; else globalThis.__advancedSection = vorher;
  }
});

test('Teilaufgabe: Knopf und Feld verstecken sich wirklich - display: flex sticht sonst hidden', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/detail-view.css', import.meta.url), 'utf8');
  const hides = (sel) => [...eachRule(css)].some((r) => r.selector.split(',').some((s) => s.trim() === sel)
    && /display:\s*none/.test(r.body));
  assert.ok(hides('.detail-subtask--add[hidden]'), 'der Knopf verschwindet, solange das Feld offen ist');
  assert.ok(hides('.detail-subtask-compose[hidden]'), 'das Feld verschwindet, solange es zu ist');
});
