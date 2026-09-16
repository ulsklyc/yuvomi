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

test('am Display traegt die Teilaufgabe keine Handlung, beim Menschen schon', () => {
  const amDisplay = alsRolle('display', () => tasks.renderTaskCard(AUFGABE));
  const alsMensch = alsRolle(null, () => tasks.renderTaskCard(AUFGABE));

  // BEIM MENSCHEN ZUERST - eine Zusicherung ueber eine Abwesenheit braucht den
  // Gegenfall, sonst ist sie auch dann gruen, wenn die Teilaufgabe gar nicht
  // mehr gezeichnet wird.
  assert.match(alsMensch, /data-action="toggle-subtask"/, 'der Mensch behaelt die Checkbox');

  assert.ok(!amDisplay.includes('data-action="toggle-subtask"'),
    'am Display darf die Teilaufgabe keine Handlung tragen');
  assert.match(amDisplay, /subtask-item__checkbox[^>]*disabled/,
    'sie bleibt sichtbar, nimmt aber keine Beruehrung an');
  assert.match(amDisplay, /Teller/, 'und die Teilaufgabe selbst steht weiter da');
});

test('am Display wird die Wischgeste gar nicht erst eingehaengt', () => {
  // GEMESSEN AM VERHALTEN, NICHT AM QUELLTEXT. Die Wischgeste hat kein Markup,
  // das sich pruefen liesse - sie entsteht erst beim Verdrahten. Gezaehlt wird
  // deshalb, ob `wireSwipeRows` die Liste ueberhaupt nach ihren Zeilen fragt:
  // tut es das nicht, ist nichts verdrahtet worden.
  //
  // DER ERSTE ANLAUF ZAEHLTE `addEventListener` AUF DER LISTE und war in
  // BEIDEN Rollen null - `wireSwipeRows` haengt seine Listener an die einzelnen
  // `.swipe-row`-Elemente, nicht an die Liste. Ohne den Gegenfall darunter
  // waere diese Suite gruen gewesen und haette nichts gemessen; er ist der
  // einzige Grund, dass es auffiel.
  const liste = () => {
    let gefragt = 0;
    return {
      querySelectorAll(sel) { if (sel === '.swipe-row') gefragt += 1; return []; },
      querySelector: () => null,
      addEventListener() {},
      get gefragt() { return gefragt; },
    };
  };

  const amDisplay = liste();
  alsRolle('display', () => tasks.wireSwipeGestures({ querySelector: () => amDisplay }));
  assert.equal(amDisplay.gefragt, 0, 'am Display wird nicht einmal nach den Zeilen gefragt');

  const alsMensch = liste();
  alsRolle(null, () => tasks.wireSwipeGestures({ querySelector: () => alsMensch }));
  assert.ok(alsMensch.gefragt > 0, 'beim Menschen schon - sonst misst der Fall darueber nichts');
});
