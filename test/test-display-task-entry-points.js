/**
 * Test: Am Wandtablett fuehrt genau EIN Weg zum Abhaken (#1209)
 *
 * Zweck: `PATCH /tasks/:id/status` ist in der Schreib-Allowlist eines Displays,
 *        und die Aufgabenseite bietet DREI Wege dorthin an: den Statusknopf,
 *        die Wischgeste und die Teilaufgaben-Checkbox. Nur der erste kann nach
 *        der Person fragen - am Display ersetzt ihn die Personenauswahl. Die
 *        beiden anderen haken sofort ab, ohne jemanden zu benennen, und liefen
 *        dort in die 400 des Servers („A paired display must name the person it
 *        is acting for.") - englischer Rohtext auf deutscher Oberflaeche.
 *
 * WARUM DAS EINE EIGENE SUITE IST. `test:display-actions` misst den Server und
 * ist dort vollstaendig: die Route WEIST diese Aufrufe korrekt ab. Genau
 * deshalb sieht sie den Fehler nicht - er besteht darin, dass die Oberflaeche
 * eine Handlung ANBIETET, die der Server zu Recht verweigert. Das ist dieselbe
 * Klasse wie der Undo-Rueckruf im Toast und der Statusknopf selbst, und sie
 * laesst sich nur an der Seite messen, nicht an der Route.
 *
 * Ausfuehren: npm run test:display-task-entry-points
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
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');

const AUFGABE = {
  id: 7, title: 'Tisch decken', status: 'open', visibility: 'all', points: 5,
  subtasks: [{ id: 71, title: 'Teller', status: 'open' }],
  subtask_total: 1, subtask_done: 0,
};

/** Die Seite in eine Rolle versetzen und danach sauber zuruecklassen. */
function alsRolle(scope, fn) {
  const vorher = tasks.state.user;
  tasks.state.user = scope ? { id: 4, access_scope: scope } : { id: 2 };
  try { return fn(); } finally { tasks.state.user = vorher; }
}

test('am Display ist die Teilaufgabe ein Zustandszeichen, kein Bedienelement', () => {
  const amDisplay = alsRolle('display', () => tasks.renderTaskCard(AUFGABE));
  const alsMensch = alsRolle(null, () => tasks.renderTaskCard(AUFGABE));

  // BEIM MENSCHEN ZUERST - eine Zusicherung ueber eine Abwesenheit braucht den
  // Gegenfall, sonst ist sie auch dann gruen, wenn die Teilaufgabe gar nicht
  // mehr gezeichnet wird.
  assert.match(alsMensch, /data-action="toggle-subtask"/, 'der Mensch behaelt die Checkbox');

  assert.ok(!amDisplay.includes('data-action="toggle-subtask"'),
    'am Display darf die Teilaufgabe keine Handlung tragen');
  assert.match(amDisplay, /Teller/, 'und die Teilaufgabe selbst steht weiter da');

  // KEIN KNOPF, AUCH KEIN DEAKTIVIERTER. Ein `disabled`-Knopf war der erste
  // Anlauf und die halbe Loesung: er behaelt Form, Trefflaeche und
  // Hover-Einladung eines Bedienelements. Gemessen wird deshalb die
  // Abwesenheit des Knopfes selbst, nicht ein Attribut daran.
  const teilaufgabenBlock = amDisplay.slice(amDisplay.indexOf('subtask-item'));
  assert.ok(!/<button[^>]*subtask-item__checkbox/.test(teilaufgabenBlock),
    'am Display steht dort kein button');
  assert.match(amDisplay, /subtask-item__checkbox--static/,
    'sondern das Zustandszeichen');

  // UND DIE BESCHRIFTUNG VERSPRICHT NICHTS. „als erledigt markieren" an einem
  // Element, das nichts tut, ist fuer einen Screenreader eine Handlung, die es
  // nicht gibt - die Beschriftung nennt am Display den ZUSTAND.
  // Der Loader liefert fuer `t()` den Schluessel zurueck, nicht die
  // Uebersetzung - gemessen wird deshalb, WELCHER Schluessel dort steht. Das
  // ist hier sogar die schaerfere Frage: `subtaskMarkDone` ist eine Handlung,
  // `statusOpen` ein Zustand, und der Unterschied ist genau der Befund.
  const label = amDisplay.match(/aria-label="Teller[^"]*"/)?.[0] ?? '';
  assert.ok(!label.includes('subtaskMarkDone'),
    `am Display verspricht die Beschriftung keine Handlung, war: ${label}`);
  assert.match(label, /Teller: tasks\.status/, `sie nennt den Zustand, war: ${label}`);
  assert.match(alsMensch, /subtaskMarkDone/, 'beim Menschen bleibt die Handlung benannt');
});

test('am Display faellt nur die SCHREIB-Seite der Wischgeste weg, die Lese-Seite bleibt', () => {
  // GEMESSEN AN DEN VERDRAHTETEN SEITEN. Die Wischgeste hat kein Markup, das
  // sich pruefen liesse, und ein Zaehler auf dem Aufruf beantwortet nur, DASS
  // verdrahtet wurde - nicht WELCHE Seite, und genau das ist hier die Regel.
  //
  // ZWEI ANLAEUFE STANDEN VORHER HIER, und beide waren falsch. Der erste
  // zaehlte `addEventListener` auf der Liste und war in BEIDEN Rollen null,
  // weil `wireSwipeRows` an den einzelnen Zeilen haengt. Der zweite zaehlte
  // den Aufruf und verlangte am Display null - er war gruen, als die Geste
  // dort KOMPLETT wegfiel, und hat damit uebersehen, dass mit der Schreib-Seite
  // auch das Oeffnen der Detailansicht verschwand: reines Lesen, das ein
  // Display ueberall sonst darf.
  const liste = () => ({ querySelectorAll: () => [], querySelector: () => null, addEventListener() {} });

  const amDisplay = alsRolle('display', () => tasks.wireSwipeGestures({ querySelector: liste }));
  assert.equal(amDisplay.leading, null, 'am Display keine Schreib-Seite');
  assert.ok(amDisplay.trailing, 'aber die Lese-Seite bleibt - sie oeffnet nur die Detailansicht');

  const alsMensch = alsRolle(null, () => tasks.wireSwipeGestures({ querySelector: liste }));
  assert.ok(alsMensch.leading, 'beim Menschen bleiben beide Seiten');
  assert.ok(alsMensch.trailing);
});

// --------------------------------------------------------
// Die Darstellung dahinter - ein Guard, weil CSS still versagt
// --------------------------------------------------------

const { eachRule } = await import('./css-rules.js');
const { readFileSync } = await import('node:fs');
const TASKS_CSS = readFileSync(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');

/** Die Regeln zu einem Selektor, in Quellreihenfolge, mit ihrer At-Kette. */
function regelnFuer(muster) {
  const out = [];
  let n = 0;
  for (const regel of eachRule(TASKS_CSS)) {
    n += 1;
    if (muster.test(regel.selector)) out.push({ ...regel, nr: n });
  }
  return out;
}

test('das Zustandszeichen steht dort, wo es die Basisregeln ueberhaupt schlagen kann', () => {
  // WARUM DAS EIN EIGENER FALL IST. Die drei Regeln haben DIESELBE
  // Spezifitaet wie die Basisregeln der Checkbox. Stehen sie davor, verlieren
  // sie nach Quellreihenfolge - und zwar lautlos: das Markup stimmt, die Regel
  // existiert, und der Kasten sieht trotzdem weiter aus wie ein Knopf. Genau
  // das ist beim ersten Anlauf passiert, als der Block versehentlich in der
  // `prefers-reduced-motion`-Abfrage landete. Ein Guard auf die POSITION ist
  // hier die einzige Messung, die das findet.
  const basis = regelnFuer(/^\.subtask-item__checkbox(:hover|::before)?$/);
  const statisch = regelnFuer(/\.subtask-item__checkbox--static/);

  assert.equal(basis.length, 3, 'Basis, :hover und ::before');
  assert.equal(statisch.length, 3, 'cursor, :hover und ::before des Zustandszeichens');

  const letzteBasis = Math.max(...basis.map((r) => r.nr));
  for (const regel of statisch) {
    assert.ok(regel.nr > letzteBasis,
      `${regel.selector} muss nach den Basisregeln stehen (ist ${regel.nr}, Basis endet ${letzteBasis})`);
    // UND AUF DER BASISEBENE. In einer At-Abfrage gaelte sie nur fuer die
    // Nutzer, die deren Bedingung erfuellen - am Wandtablett haengt das an
    // niemandes Systemeinstellung.
    assert.deepEqual(regel.at, [],
      `${regel.selector} darf in keinem At-Block stehen, steht aber in ${JSON.stringify(regel.at)}`);
  }
});

test('der Bewegungs-Verzicht deckt weiter beide Abhak-Zeichen', () => {
  // DIE REGRESSION, DIE DER ERSTE ANLAUF NEBENBEI EINBAUTE. Der Block wurde
  // mitten in die Selektorliste dieser Regel geschoben und trennte
  // `.task-status-btn--done` von seinem `animation: none` - unter reduzierter
  // Bewegung lief der check-pop wieder, wogegen die Abfrage gebaut ist
  // (Audit F-07). Nichts daran war sichtbar, ausser man stellt die
  // Systemeinstellung um und hakt etwas ab.
  const treffer = [...eachRule(TASKS_CSS)].filter((r) => /animation:\s*none/.test(r.body)
    && r.at.some((a) => a.includes('prefers-reduced-motion')));
  const selektoren = treffer.flatMap((r) => r.selector.split(',').map((x) => x.trim()));
  assert.ok(selektoren.includes('.task-status-btn--done'),
    `der grosse Haken muss dabei sein, gefunden: ${JSON.stringify(selektoren)}`);
  assert.ok(selektoren.includes('.subtask-item__checkbox--done'),
    `die Teilaufgabe auch, gefunden: ${JSON.stringify(selektoren)}`);
});
