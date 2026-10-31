/**
 * Test: Rotation im Aufgaben-Dialog und in der Detailansicht
 * Zweck: Die Serverseite der Rotation haelt test:task-rotation. Hier steht, was
 * die Oberflaeche daraus macht:
 * - der Abschnitt „Rotation" gehoert an die wiederkehrende Aufgabe:
 * ohne Regel verborgen, mit Regel sichtbar, und ein GESETZTER Modus
 * holt ihn zurueck (R16: beim Bearbeiten darf nichts Gesetztes
 * versteckt sein); im Ein-Personen-Haushalt gibt es ihn gar nicht - 
 * unter zwei Koepfen ist Rotation dieselbe Person in anderem Kostuem;
 * - die Verdrahtung am Frequenzfeld loest den Abschnitt mit der Regel
 * aus und wieder ein, der Pool folgt dem Modus;
 * - das Absenden uebergibt rotation_mode und rotation_pool in der
 * Reihenfolge der Auswahl (Reihenfolge = Ablieferungsreihenfolge), und
 * die Server-Regeln (Modus nur mit Regel, Modus nur mit Pool >= 2)
 * blockieren schon hier mit Meldung - der Nutzer sieht einen deutschen
 * Satz am Dialog, nicht die englische 400-Antwort;
 * - die Detailansicht nennt bei round_robin den naechsten Empfaenger aus
 * rotation_next_user - der Server loest ihn an genau der Stelle auf,
 * die auch die naechste Instanz vergibt (nextRotationEntry), die
 * Ansicht baut also keine zweite Rechnung nach. Kein Name ohne
 * Aufloesung: der Modus allein ist dann die ganze Antwort.
 *
 * Gefahren wird ueber die echten Wege: dasselbe Markup, das der Dialog baut,
 * dasselbe handleFormSubmit, das der Speichern-Knopf faehrt, dasselbe
 * rotationDetailRow, das die Leseansicht in ihre Zeilen legt.
 *
 * Ausfuehren: npm run test:rotation-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Die Seiten ziehen Web Components mit, die zur Ladezeit von HTMLElement
// ableiten (Muster aus test-kanban-columns.js / test-module-readonly-ui.js).
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
// getSelectedUserIds() loest den Namen-Selektor ueber CSS.escape.
globalThis.CSS = globalThis.CSS ?? { escape: String };

const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

// Der Loader stubt die Personen-Auswahl auf leeres Markup; der Pool IST aber
// genau diese Auswahl - also werden die Haken auf die echte Komponente gesetzt
// (dasselbe Muster wie __apiStub). Ohne diese zwei Zeilen maße der Test einer
// leeren Huelle hinterher.
const echterPicker = await import('../public/components/user-multi-select.js');
globalThis.__renderUserMultiSelect = echterPicker.renderUserMultiSelect;
globalThis.__getSelectedUserIds = echterPicker.getSelectedUserIds;

const { __test: tasks } = await import('../public/pages/tasks.js');
const { __test: detail } = await import('../public/components/task-detail.js');

const MITGLIEDER = [
  { id: 1, display_name: 'Anna', avatar_color: '#FF3B30' },
  { id: 2, display_name: 'Ben', avatar_color: '#007AFF' },
  { id: 3, display_name: 'Cem', avatar_color: '#34C759' },
];

const wiederkehrend = (over = {}) => ({
  id: 7, title: 'Muell rausbringen', status: 'open', category: 'household',
  recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 0,
  assigned_users: [], tags: [], documents: [], ...over,
});

/** Der Rotationsabschnitt aus dem echten Dialog-Markup, oder ''. */
function rotationsSection(html) {
  const start = html.search(/<div class="form-group" id="task-rotation-section"[\s>]/);
  if (start < 0) return '';
  const end = html.indexOf('<div id="task-form-error"', start);
  assert.ok(end > start, 'der Abschnitt endet vor der Fehlerzeile des Formulars');
  return html.slice(start, end);
}

// --------------------------------------------------------
// 1. Der Abschnitt haengt an der Wiederholung
// --------------------------------------------------------

test('ohne wiederkehrende Aufgabe bleibt der Rotationsabschnitt verborgen', () => {
  const section = rotationsSection(tasks.renderModalContent({ task: null, users: MITGLIEDER }));
  assert.ok(section, 'der Abschnitt steht im Formular (versteckt, nicht weg - der Absende-Pfad liest das Feld)');
  assert.match(section, /^<div class="form-group" id="task-rotation-section" hidden/,
    'eine Aufgabe ohne Regel verteilt nichts - die Frage gibt es hier nicht');
});

test('bei wiederkehrender Aufgabe ist der Abschnitt sichtbar, der Pool aber noch nicht', () => {
  const section = rotationsSection(tasks.renderModalContent({ task: wiederkehrend(), users: MITGLIEDER }));
  assert.ok(section);
  assert.doesNotMatch(section, /^<div class="form-group" id="task-rotation-section"[^>]*hidden/);
  assert.match(section, /id="task-rotation-pool" hidden/,
    'ohne Modus ist die Personenfrage noch keine Frage');
});

test('ein gesetzter Modus holt den Abschnitt zurueck und zeigt den Pool samt Auswahl', () => {
  // Der R16-Fall: eine Aufgabe dreht schon, auch wenn ihre Regel gerade nicht
  // sichtbar ist - Gesetztes darf nicht versteckt sein.
  const section = rotationsSection(tasks.renderModalContent({
    task: wiederkehrend({ recurrence_rule: null, rotation_mode: 'round_robin', rotation_pool: [3, 1] }),
    users: MITGLIEDER,
  }));
  assert.doesNotMatch(section, /^<div class="form-group" id="task-rotation-section"[^>]*hidden/);
  assert.doesNotMatch(section, /id="task-rotation-pool"[^>]*hidden/);
  assert.match(section, /<option value="round_robin" selected>/, 'der gespeicherte Modus steht vorausgewaehlt da');
  const checked = [...section.matchAll(/<input type="checkbox"[^>]*value="(\d+)"\s+checked/g)].map((m) => m[1]);
  assert.deepEqual(checked, ['3', '1'],
    'die Zeilen folgen dem gespeicherten Pool, nicht der Mitgliederliste (#1763: An order, not a set)');
});

test('im Ein-Personen-Haushalt gibt es den Abschnitt nicht', () => {
  // Unter zwei Koepfen ist "Rotation" die alte Zuordnung in anderem Kostuem
  // (server/services/task-rotation.js). Kein Knoten heisst auch: kein Feld im
  // Absenden - ein etwaiger Bestand bleibt, statt ueber einen nicht bedienbaren
  // Weg geloescht zu werden.
  const html = tasks.renderModalContent({ task: wiederkehrend(), users: [MITGLIEDER[0]] });
  assert.doesNotMatch(html, /id="task-rotation-section"/);
  assert.doesNotMatch(html, /data-ms-input="task_rotation"/);
});

test('ein Bestandswert ausserhalb der Liste faellt auf „ohne Rotation" zurueck', () => {
  // Dasselbe Muster wie das Statusfeld: der Browser wuerde sonst die erste
  // Option zeigen, waehrend der Bestand einen anderen Wert traegt.
  const section = rotationsSection(tasks.renderModalContent({
    task: wiederkehrend({ rotation_mode: 'zufaellig' }), users: MITGLIEDER,
  }));
  assert.match(section, /<option value="" selected>/);
  assert.doesNotMatch(section, /<option value="[^"]+" selected>/,
    'genau eine Option traegt selected - die erste');
});

// --------------------------------------------------------
// 1b. Der Pool ist eine Reihung, die man umsortieren kann (#1763)
// --------------------------------------------------------

test('die Zeilen stehen in gespeicherter Ablieferungsreihenfolge, nicht in Mitgliederliste', () => {
  // Reproduktion aus der zweiten Review: der Editor zeigte die Mitglieder in
  // Haushaltsliste - die gespeicherte Reihenfolge war im Dialog unsichtbar,
  // und ein Speichern ohne Anfuhrung konnte sie still umdeuten. Jetzt steht
  // die Reihung im Markup, und die Mitgliederliste ordnet sie nicht mehr um.
  const section = rotationsSection(tasks.renderModalContent({
    task: wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: [3, 1] }),
    users: MITGLIEDER,
  }));
  const rows = [...section.matchAll(/data-rotation-row data-user-id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [3, 1, 2], 'die beiden Gesetzten vorn, in gespeicherter Ordnung - dann der Rest');
});

test('jede Zeile hat die Schritte hoch und runter, die Raender sind zu', () => {
  const section = rotationsSection(tasks.renderModalContent({
    task: wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: [3, 1] }),
    users: MITGLIEDER,
  }));
  // Oben gibt es kein hoch, unten kein runter - wie in der Kategorieverwaltung.
  const anNa = /data-user-id="3"[\s\S]*?<\/li>/.exec(section)?.[0] || '';
  assert.match(anNa, /data-rotation-move="up"[^>]*disabled|disabled[^>]*data-rotation-move="up"/,
    'der Kopf der Reihung kann nicht hoeher');
  assert.doesNotMatch(anNa, /data-rotation-move="down"[^>]*disabled/, 'hinunter schon');
  const kevin = /data-user-id="1"[\s\S]*?<\/li>/.exec(section)?.[0] || '';
  assert.doesNotMatch(kevin, /data-rotation-move="up"[^>]*disabled/);
  assert.match(kevin, /data-rotation-move="down"[^>]*disabled|disabled[^>]*data-rotation-move="down"/,
    'der letzte Kopf kann nicht tiefer');
  const max = /data-user-id="2"[\s\S]*?<\/li>/.exec(section)?.[0] || '';
  assert.match(max, /data-rotation-move="up"[^>]*disabled/, 'der Nicht-Setzte hat gar keine Richtung');
});

test('der Hinweis nennt die Regel vom Abhaken durch eine andere Person', () => {
  // Zweite Review, Punkt 6: die Regel steht im Code und im SPEC, aber das
  // Formular, in dem man die Rotation setzt, sagte nichts davon.
  const section = rotationsSection(tasks.renderModalContent({
    task: wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: [1, 3] }),
    users: MITGLIEDER,
  }));
  assert.match(section, /tasks\.rotationAdvancesHint/,
    'der Hinweis haengt direkt am Pool, nicht nur im Handbuch');
});

// --------------------------------------------------------
// 2. Die Verdrahtung am Frequenzfeld
// --------------------------------------------------------

/** Ein Knoten mit value/hidden und Lauschern, wie wireRotationGate sie braucht. */
function knoten({ hidden = false, value = '' } = {}) {
  const listeners = {};
  return {
    hidden, value,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of listeners[type] ?? []) fn(); },
  };
}

/** Der Abschnitt als Handknoten statt als Markup - die Verdrahtung hat kein Markup. */
function gate({ freq = '', mode = '', sectionHidden = true, poolHidden = true } = {}) {
  const freqKnoten = knoten({ value: freq });
  const section = knoten({ hidden: sectionHidden });
  const modeSelect = knoten({ value: mode });
  const pool = knoten({ hidden: poolHidden });
  const panel = { querySelector: (sel) => ({
    '#task-rotation-section': section,
    '#task-rotation-mode': modeSelect,
    '#task-rotation-pool': pool,
  }[sel] ?? null) };
  const echtesDocument = globalThis.document;
  globalThis.document = { querySelector: (sel) => (sel === '#task-rrule-freq' ? freqKnoten : null) };
  try {
    tasks.wireRotationGate(panel);
  } finally {
    // Der Lauscher haelt den Frequenzknoten in seiner Closure - das Dokument
    // kann gleich zurueck, es wird bei `fire` nicht mehr gelesen.
    globalThis.document = echtesDocument;
  }
  return { freq: freqKnoten, section, modeSelect, pool };
}

test('die Verdrahtung haelt die Regel ein, die das Markup beim Oeffnen zeigt', () => {
  // Ausgangslage neu (ohne Regel, ohne Modus): verborgen. Gegenprobe mit
  // gesetztem Modus: sichtbar - ein Listener, der beim Binden nicht syncen
  // wuerde, zeigte beim Oeffnen einer Rotationsaufgabe das Gegenteil.
  assert.equal(gate({}).section.hidden, true);
  assert.equal(gate({ mode: 'round_robin', sectionHidden: true, poolHidden: true }).section.hidden, false);
});

test('Frequenz waehlen loest den Abschnitt aus, Frequenz raeumen ihn wieder ein', () => {
  const g = gate({});
  g.freq.value = 'WEEKLY'; g.freq.fire('change');
  assert.equal(g.section.hidden, false, 'ab jetzt gibt es ein zweites Vorkommen - die Frage darf gestellt werden');
  g.freq.value = ''; g.freq.fire('change');
  assert.equal(g.section.hidden, true);
});

test('Frequenz raeumen bei gesetztem Modus laesst den Abschnitt stehen', () => {
  // Der Modus ist Gesetztes (R16) - verschwinden liesse er sich nur durch
  // stillschweigendes Loeschen, und das ist der Absende-Pfad nicht.
  const g = gate({ freq: 'WEEKLY', mode: 'round_robin', sectionHidden: false, poolHidden: false });
  g.freq.value = ''; g.freq.fire('change');
  assert.equal(g.section.hidden, false);
});

test('der Pool folgt dem Modus - mit Modus hervor, ohne wieder zurueck', () => {
  const g = gate({ freq: 'WEEKLY', sectionHidden: false });
  assert.equal(g.pool.hidden, true, 'Ausgangslage');
  g.modeSelect.value = 'round_robin'; g.modeSelect.fire('change');
  assert.equal(g.pool.hidden, false);
  g.modeSelect.value = ''; g.modeSelect.fire('change');
  assert.equal(g.pool.hidden, true);
});

// --------------------------------------------------------
// 3. Das Absenden: Modus und Pool gehen hinaus, Fehler bleiben hier
// --------------------------------------------------------

const feld = (value = '') => ({ value: String(value) });

/**
 * Formular-Attrappe. Benannte Felder liegen direkt darauf (genau so liest der
 * Handler: `form.title.value`); die Pool-Kaestchen antworten auf dieselbe
 * Selektor-Frage, die getSelectedUserIds im Browser stellt - die Antwort ist
 * die DOM-Reihenfolge, und genau die ist hier die Ablieferungsreihenfolge.
 */
function attrappenFormular({ poolIds = [], rotationRows = null, byId = {}, ...named } = {}) {
  const form = {
    querySelector: (sel) => byId[sel] ?? null,
    querySelectorAll: (sel) => (
      String(sel).includes('task_rotation')
        // Live-Zeilen (der Umsortier-Test): was gesetzt ist und in welcher
        // Reihenfolge die Kinder stehen, ist die gesendete Ablieferungsordnung.
        ? (rotationRows
            ? rotationRows.filter((r) => r.querySelector('input.user-ms__checkbox').checked)
              .map((r) => ({ value: r.dataset.userId }))
            : poolIds.map((id) => ({ value: String(id) })))
        : []
    ),
  };
  for (const [name, value] of Object.entries(named)) form[name] = feld(value);
  return form;
}

function attrappenDokument(taskId = '7') {
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': feld(taskId),
  };
  return {
    getElementById: (id) => nodes[id] ?? null,
    documentElement: { lang: 'de', classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
    addEventListener() {},
    errorNode: nodes['task-form-error'],
  };
}

/**
 * Faehrt handleFormSubmit gegen die Attrappe und liefert zurueck, was an den
 * Server ging - und ob die Fehlerzeile sich gemeldet hat (ein stiller Abbruch
 * waere kein Befund).
 */
async function speichernUndSenden({ recurring, mode = '', poolIds = [], rotationRows = null, taskId = '7' }) {
  const calls = [];
  const record = (method) => async (path, body) => {
    calls.push({ method, path, body });
    return method === 'post' ? { data: { id: 9 } } : { data: null };
  };
  globalThis.__apiStub = {
    get: record('get'),
    getWithSource: async (path) => { calls.push({ method: 'get', path }); return { data: { tags: [] }, fromCache: false }; },
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
  };
  globalThis.__rruleValues = {
    is_recurring: recurring, recurrence_rule: recurring ? 'FREQ=WEEKLY' : null,
    recurrence_from_completion: 0, valid_until: true,
  };
  const echtesDocument = globalThis.document;
  const doc = attrappenDokument(taskId);
  globalThis.document = doc;
  const echterToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = () => {};
  const form = attrappenFormular({
    poolIds, rotationRows,
    title: 'Muell rausbringen', description: '', priority: 'none', category: 'household',
    start_date: '', due_date: '2026-11-02', due_time: '', points: '0', status: 'open',
    byId: {
      '#task-rotation-mode': feld(mode),
      '#task-visibility': feld('all'),
      '#reminder-toggle': { checked: false },
    },
  });
  try {
    await tasks.handleFormSubmit(
      { preventDefault() {}, target: form },
      { container: null, onChanged: async () => {} },
    );
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__rruleValues;
    globalThis.document = echtesDocument;
    if (echterToast === undefined) delete globalThis.window.yuvomi.showToast;
    else globalThis.window.yuvomi.showToast = echterToast;
  }
  const writes = calls.filter((c) => (c.method === 'put' || c.method === 'post') && c.path.startsWith('/tasks'));
  return { body: writes[0]?.body, writes, fehler: doc.errorNode.hidden ? null : doc.errorNode.textContent };
}

test('der Pool geht in der Reihenfolge der Auswahl als rotation_pool hinaus', async () => {
  // Der Kernfall: die Auswahl-Reihenfolge IST die Ablieferungsreihenfolge - 
  // sie darf beim Absenden nicht sortiert, dedupliziert oder umgekehrt werden.
  const { body, fehler } = await speichernUndSenden({
    recurring: true, mode: 'round_robin', poolIds: [2, 1, 3],
  });
  assert.equal(fehler, null);
  assert.equal(body.rotation_mode, 'round_robin');
  assert.deepEqual(body.rotation_pool, [2, 1, 3]);
});

test('ohne Modus sendet das Formular rotation_mode null und laesst den Pool weg', async () => {
  const { body, fehler } = await speichernUndSenden({ recurring: true, mode: '', poolIds: [] });
  assert.equal(fehler, null);
  assert.equal(body.rotation_mode, null, 'null ist die Abwahl - der Server loescht Modus und Pool');
  assert.equal('rotation_pool' in body, false, 'ein Pool ohne Modus waere eine Aussage ueber nichts');
});

test('ein Modus mit nur einem Kopf im Pool blockiert das Speichern mit Meldung', async () => {
  // Dieselbe Regel wie der Server (rotation_mode requires a pool of at least
  // 2 members) - aber in der Sprache der App, am Dialog, statt als englische
  // 400 nach dem Absenden.
  const { writes, fehler } = await speichernUndSenden({ recurring: true, mode: 'round_robin', poolIds: [1] });
  assert.deepEqual(writes, [], 'nichts geht hinaus');
  assert.equal(fehler, 'tasks.rotationNeedsPool');
});

test('ein Modus ohne wiederkehrende Aufgabe blockiert das Speichern mit Meldung', async () => {
  // Erreichbar ist das ueber das Frequenzfeld, solange ein Modus gesetzt ist
  // (der Abschnitt bleibt sichtbar - siehe die gate-Tests oben).
  const { writes, fehler } = await speichernUndSenden({ recurring: false, mode: 'round_robin', poolIds: [1, 2] });
  assert.deepEqual(writes, [], 'die Kombination waerte ein 400 des Servers');
  assert.equal(fehler, 'tasks.rotationNeedsRecurring');
});

test('die Absende-Pruefung haengt nicht am Modus-Fehler-Vorschau-Text', async () => {
  // Gegenprobe gegen einen Handler, der IMMER abbricht: mit legaler
  // Kombination geht die Anfrage raus (der erste Fall zaehlt nur im Paar).
  const { writes, fehler } = await speichernUndSenden({ recurring: true, mode: 'round_robin', poolIds: [3, 2] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/tasks/7');
  assert.equal(fehler, null);
});

// --------------------------------------------------------
// 4. Die Detailansicht: „als naechstes" ohne Serveraufruf
// --------------------------------------------------------

const LESEKONTEXT = { users: MITGLIEDER };

test('round_robin nennt den Nachfolger beim Namen, den der Server geloest hat', () => {
  const row = detail.rotationDetailRow(
    wiederkehrend({
      rotation_mode: 'round_robin', rotation_pool: [1, 2, 3],
      rotation_last_user: 1, rotation_last_position: 0, rotation_next_user: 2,
    }),
    LESEKONTEXT,
  );
  // Der Stub setzt Platzhalter ein und laesst den Schluessel stehn - der Name
  // muss im eingesetzten Text stehen, nicht nur im Muster.
  assert.equal(row.value, 'tasks.rotationNext{"mode":"tasks.rotationModeRoundRobin","name":"Ben"}');
  assert.equal(row.label, 'tasks.rotationLabel');
});

test('die Ansicht folgt rotation_next_user, nicht einer eigenen Rechnung', () => {
  // Der Server kennt den Positionen-Zeiger, die Luecken abgegangener
  // Mitglieder und die deaktivierten Koepfe (#1381) - eine eigene Rechnung im
  // Client waerte eine zweite Quelle der Wahrheit mit eigener Irrtumsmoeglich-
  // keit. Hier: der naechste Kopf waere lokal Ben (last_user ist Anna), der
  // Server sagt Cem - und Cem steht da.
    const row = detail.rotationDetailRow(
    wiederkehrend({
      rotation_mode: 'round_robin', rotation_pool: [1, 2, 3],
      rotation_last_user: 1, rotation_last_position: 1, rotation_next_user: 3,
    }),
      LESEKONTEXT,
    );
  assert.match(row.value, /"name":"Cem"/, 'der Server-Pick gewinnt');
});

test('ohne aufloesbaren Nachfolger bleibt nur der Modus - kein erfundener Name', () => {
  // Geloeschter Account, ferne Serie oder keine Rotation (null): ohne
  // Anzeigename faellt die Vorhersage weg, der Modus ist die ehrliche
  // Antwort - ein "#9" waere Raten.
  for (const next of [null, undefined, 99]) {
  const row = detail.rotationDetailRow(
      wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: [1, 2], rotation_next_user: next }),
    LESEKONTEXT,
  );
    assert.equal(row.value, 'tasks.rotationModeRoundRobin', `rotation_next_user = ${next}`);
  }
});

test('ohne Modus, ohne Pool oder unter zwei Koepfen bleibt die Zeile leer', () => {
  // Die leere `value` blendet die Detailzeile aus (Muster der Ablagezeile).
  const faelle = [
    wiederkehrend({}),
    wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: null }),
    wiederkehrend({ rotation_mode: 'round_robin', rotation_pool: [1] }),
  ];
  for (const task of faelle) {
    assert.equal(detail.rotationDetailRow(task, LESEKONTEXT).value, '', JSON.stringify(task.rotation_mode));
  }
});

test('ein unbekannter Modusname bleibt ohne Zeile, statt zu raten', () => {
  const row = detail.rotationDetailRow(
    wiederkehrend({ rotation_mode: 'wuerfeln', rotation_pool: [1, 2] }),
    LESEKONTEXT,
  );
  assert.equal(row.value, '');
});

test('die Rotationszeile steht direkt unter der Wiederholungszeile der Leseansicht', async () => {
  // Die Reihenfolge ist die Aussage: Rotation ohne Wiederholung waere ein
  // Modus ins Leere. Gemessen an der Auslieferung selbst, nicht an einem
  // Nachbau - faellt die recurrenceRow-Zeile weg, faellt die Reihenfolge mit.
  const quelle = (await import('node:fs')).readFileSync(
    new URL('../public/components/task-detail.js', import.meta.url), 'utf8',
  );
  const rows = quelle.slice(quelle.indexOf('function renderTaskDetail'));
  assert.ok(
    rows.indexOf('recurrenceRow(') < rows.indexOf('rotationDetailRow('),
    'die Rotationszeile muss AUF die Wiederholungszeile folgen, nicht vor ihr stehen',
  );
});

// --------------------------------------------------------
// 5. Umsortieren: Klick trifft die Reihung, die Reihung trifft den Pool
// --------------------------------------------------------

function fakeMoveButton(row) {
  const btn = {
    disabled: false,
    setAttribute(k) { if (k === 'disabled') btn.disabled = true; },
    removeAttribute(k) { if (k === 'disabled') btn.disabled = false; },
    closest: (sel) => (sel === '[data-rotation-row]' ? row : btn),
  };
  return btn;
}

function fakeRow(id, checked) {
  const checkbox = { checked, value: String(id), matches: (sel) => sel === '.user-ms__checkbox' };
  const row = {
    dataset: { userId: String(id) },
    buttons: { up: null, down: null },
    querySelector(sel) {
      if (sel === 'input.user-ms__checkbox') return checkbox;
      const m = /\[data-rotation-move="(\w+)"\]/.exec(sel);
      return m ? row.buttons[m[1]] : null;
    },
    closest: (sel) => (sel === '[data-rotation-row]' ? row : null),
  };
  row.buttons.up = fakeMoveButton(row);
  row.buttons.down = fakeMoveButton(row);
  row.buttons.up.dataset = { rotationMove: 'up' };
  row.buttons.down.dataset = { rotationMove: 'down' };
  return row;
}

function fakeList(rows) {
  const listeners = {};
  const list = {
    children: rows,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    fire(name, ev = {}) { for (const fn of listeners[name] || []) fn(ev); },
    insertBefore(node, ref) {
      const at = list.children.indexOf(node);
      if (at >= 0) list.children.splice(at, 1);
      const idx = ref ? list.children.indexOf(ref) : -1;
      if (idx < 0) list.children.push(node);
      else list.children.splice(idx, 0, node);
    },
    order() { return list.children.filter((r) => r.querySelector('input.user-ms__checkbox').checked)
      .map((r) => Number(r.dataset.userId)); },
  };
  for (const r of rows) r.parentElement = list;
  return list;
}

test('ein Klick auf hoch tauscht die Zeilen und die Raender wandern mit', () => {
  // Der zweite Kopf rueckt nach vorn: die Reihung, die der Absende-Pfad danach
  // aus dem DOM liest, ist die neue Ablieferungsordnung. Vor dem Umbau gab es
  // diese Bedienung nicht - die Reihenfolge war dem Zufall der Mitgliederliste
  // ueberlassen.
  const oben = fakeRow(3, true);
  const unten = fakeRow(1, true);
  const rest = fakeRow(2, false);
  const list = fakeList([oben, unten, rest]);
  const panel = { querySelector: (sel) => (sel.includes('rotation-pool__list') ? list : null) };
  tasks.wireRotationOrder(panel);
  assert.deepEqual(list.order(), [3, 1], 'Ausgangslage: der erste Kopf steht oben');
  assert.equal(oben.buttons.up.disabled, true, 'oben gibt es kein hoch');
  list.fire('click', { target: unten.buttons.up });
  assert.deepEqual(list.order(), [1, 3], 'der zweite Kopf ist nach vorn gerueckt');
  assert.equal(unten.buttons.up.disabled, true, 'nun ist er oben - das Rand wandert mit');
  assert.equal(oben.buttons.up.disabled, false, 'der bisherige Kopf darf wieder hoch');
  assert.equal(oben.buttons.down.disabled, true, 'und ganz unten gibt es kein runter');
  list.fire('click', { target: oben.buttons.down });
  assert.deepEqual(list.order(), [1, 3], 'ein Klick ueber den Rand hinaus verschiebt nichts');
});

test('die Reihenfolge der geordneten Zeilen ist die Reihenfolge des Pools', async () => {
  // Das Ende der Kette: DOM-Reihenfolge -> getSelectedUserIds -> rotation_pool.
  // Dasselbe Formular, dieselben Zeilen - nur die Ordnung hat sich bewegt.
  const vorn = fakeRow(1, true);
  const hinten = fakeRow(3, true);
  const list = fakeList([vorn, hinten]);
  const erste = await speichernUndSenden({
    recurring: true, mode: 'round_robin', rotationRows: list.children,
  });
  assert.deepEqual(erste.body.rotation_pool, [1, 3], 'Markup-Reihenfolge ist die gesendete Ordnung');
  assert.equal(tasks.moveRotationRow(hinten, -1), true);
  const zweite = await speichernUndSenden({
    recurring: true, mode: 'round_robin', rotationRows: list.children,
  });
  assert.deepEqual(zweite.body.rotation_pool, [3, 1],
    'nach dem Tausch sendet dasselbe Formular die neue Ordnung');
});

// --------------------------------------------------------
// 6. Die Privat-Warnung liest den Pool mit (#1763)
// --------------------------------------------------------

test('eine private Aufgabe, die an ein anderes Mitglied rotiert, warnt', () => {
  // Der Pool rotiert die naechste Instanz an jemanden, der sie bei "Nur ich"
  // nicht sieht.hing die Warnung nur an den Zustaendigen, bliebe sie stumm.
  const select = { value: 'private', addEventListener() {} };
  const warn = { hidden: true, closest: () => null };
  const privateWarn = { hidden: true, closest: () => null };
  const container = { addEventListener() {} };
  const panel = {
    querySelector: (sel) => {
      if (sel === '#vis') return select;
      if (sel === '#warn') return warn;
      if (sel === '#priv') return privateWarn;
      return container;
    },
    querySelectorAll: (sel) => (sel.includes('task_rotation')
      ? [{ checked: true, value: '2' }]
      : []),
  };
  tasks.wireVisibilityWarning(panel, '#vis', 'task_assigned', '#warn', '#priv', 1, 'task_rotation');
  assert.equal(privateWarn.hidden, false,
    'privat plus Pool mit einer anderen Person = Warnung, nicht Schweigen');
});
