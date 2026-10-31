/**
 * Modul: Vorheraufgaben in der Oberflaeche (Blockiert durch)
 * Zweck: Der Server haelt die Regel (test:task-prerequisites); diese Suite
 *        misst, was der Client daraus macht: der Dialog bietet den Picker und
 *        schickt die Liste, die Karte traegt das Zahlzeichen nur bei offenen
 *        Vorbedingungen, die Leseansicht zeigt den Stand, und die Absage nennt
 *        die offenen Vorbedingungen beim Namen (max drei, Rest als Zahl).
 *
 * Gefahren mit dem Browser-Loader (Stubs fuer /api.js und Co.) und dem
 * Mini-DOM fuer die bauenden Renderer - dasselbe Muster wie
 * test-task-approval-ui.js: gemessen wird Verhalten, nicht Quelltextfantasie.
 *
 * Ausfuehren: npm run test:task-prerequisites-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
globalThis.window = globalThis.window ?? {};
const toasts = [];
globalThis.window.yuvomi = { showToast: (msg, type) => toasts.push({ msg, type }) };

const { __test: tasks } = await import('../public/pages/tasks.js');
const { __test: detailTest } = await import('../public/components/task-detail.js');
const { prerequisiteBlockSentence, MAX_NAMED_PREREQS } = await import('../public/utils/task-prerequisites.js');

const tasksSrc = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
const detailSrc = readFileSync(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Dialog: Abschnitt, Picker, Absendepfad
// ---------------------------------------------------------------------------

test('der Dialog bietet den Abschnitt an - zugeklappt bei neu, offen bei gesetzt', () => {
  const leer = tasks.renderModalContent({ task: null, users: [] });
  assert.match(leer, /id="task-prereqs"/, 'der Abschnitt fehlt im Neuanlage-Formular');
  assert.doesNotMatch(leer, /id="task-prereqs"[^>]*\bopen\b/, 'ohne Auswahl bleibt er zu');

  const bearbeitet = tasks.renderModalContent({
    task: { id: 7, title: 'Pavillon einraeumen', status: 'open', prerequisites: [{ id: 3, title: 'Seitenteile waschen', done: false }] },
    users: [],
  });
  assert.match(bearbeitet, /id="task-prereqs"[^>]*\bopen\b/, 'eine gesetzte Auswahl bleibt offen');
});

test('der Picker haelt die Auswahl, bietet die Selbstreferenz nicht und meldet Leere', () => {
  const html = tasks.prereqRowsHtml(
    [{ id: 3, title: 'Seitenteile waschen' }, { id: 4, title: 'Sonne runter' }], [3], 9);
  assert.match(html, /value="3"[^>]*\bchecked\b/, 'die gesetzte Vorbedingung ist angekreuzt');
  assert.doesNotMatch(html, /value="9"/, 'die Aufgabe selbst steht nie zur Wahl');

  const selbst = tasks.prereqRowsHtml([{ id: 9, title: 'Ich selbst' }], [], 9);
  assert.match(selbst, /data-prereqs-empty/, 'ohne Kandidaten steht der Hinweis, keine Liste');
});

test('das Speichern schickt die Liste nur, wenn der Abschnitt beruehrt wurde oder etwas setzt', () => {
  assert.match(tasksSrc, /if \(modalPrereqTouched \|\| modalPrereqIds\.length\) body\.prerequisites = \[\.\.\.modalPrereqIds\]/,
    'Absendepfad: nie-geoeffnet-ohne-Auswahl schickt den Schluessel nicht');
});

// ---------------------------------------------------------------------------
// Liste und Brett: das Zahlzeichen
// ---------------------------------------------------------------------------

test('die Marke steht nur bei offenen Vorbedingungen - Zeile und Brett teilen sie', () => {
  assert.match(tasks.renderBlockedBadge({ open_prerequisite_count: 2 }), /role="img"/);
  assert.match(tasks.renderBlockedBadge({ open_prerequisite_count: 2 }), /task-card__blocked/);
  assert.equal(tasks.renderBlockedBadge({ open_prerequisite_count: 0 }), '');
  assert.equal(tasks.renderBlockedBadge({}), '');
  const calls = [...tasksSrc.matchAll(/\$\{renderBlockedBadge\(task\)\}/g)];
  assert.equal(calls.length, 2, 'Liste und Brett - wie beim Schloss (#1607)');
});

// ---------------------------------------------------------------------------
// Die Absage: offene Vorbedingungen beim Namen
// ---------------------------------------------------------------------------

test('der Absagesatz nennt max drei Titel, der Rest wird Zahl', () => {
  const err = { status: 409, data: { reason: 'tasks_prerequisite_open', open_prerequisites: [
    { id: 1, title: 'Seitenteile waschen' },
    { id: 2, title: 'Sonne runter' },
    { id: 3, title: 'Schlauch holen' },
    { id: 4, title: 'Tor oeffnen' },
    { id: 5, title: 'Licht aus' },
  ] } };
  const satz = prerequisiteBlockSentence(err);
  assert.ok(satz, 'die Absage bekommt einen Satz');
  assert.match(satz, /Seitenteile waschen/);
  assert.match(satz, /Schlauch holen/);
  assert.doesNotMatch(satz, /Tor oeffnen/, 'ab dem vierten Titel wird gezählt');
  assert.match(satz, /2/, 'der Rest zaehlt');
  assert.ok(satz.length < 200, 'der Satz bleibt eine Zeile');
});

test('falscher Fall und fehlende Titel ergeben null - die Aufrufer halten ihre Saetze bereit', () => {
  assert.equal(prerequisiteBlockSentence({ status: 409, data: { reason: 'other', open_prerequisites: [{ title: 'X' }] } }), null);
  assert.equal(prerequisiteBlockSentence({ status: 400, body: { error: 'bad' } }), null);
  assert.equal(prerequisiteBlockSentence({ status: 409, data: { reason: 'tasks_prerequisite_open', open_prerequisites: [] } }), null);
  assert.equal(prerequisiteBlockSentence({}), null);
  assert.equal(MAX_NAMED_PREREQS, 3);
});

test('alle Abhakwege nutzen den Satz (Liste, Brett, Leseansicht)', () => {
  const uses = [...tasksSrc.matchAll(/prerequisiteBlockSentence\(err\)/g)];
  assert.ok(uses.length >= 2, 'Liste und Brett fragen den Helfer');
  assert.match(detailSrc, /prerequisiteBlockSentence\(err\) \?\? errorSentence\(err\)/,
    'die Leseansicht dieselbe Reihenfolge: eigener Satz vor allgemein');
});

// ---------------------------------------------------------------------------
// Leseansicht: der Stand
// ---------------------------------------------------------------------------

test('die Leseansicht zeigt die Vorbedingungen mit Stand - und faellt ohne weg', () => {
  assert.equal(detailTest.prerequisitesNode([]), null);
  assert.equal(detailTest.prerequisitesNode(undefined), null);
  const node = detailTest.prerequisitesNode([
    { id: 3, title: 'Seitenteile waschen', status: 'done', done: true, assigned_name: 'Diana' },
    { id: 4, title: 'Sonne runter', status: 'open', done: false },
  ]);
  const html = node.outerHTML;
  assert.match(html, /detail-prereq--done/, 'die erledigte traegt den Haken-Stand');
  assert.match(html, /Seitenteile waschen/);
  assert.match(html, /Sonne runter/);
  assert.match(html, /Diana/, 'die Person der Vorbedingung ist sichtbar');
  assert.equal((html.match(/role="img"/g) ?? []).length, 2, 'eine Zeile je Vorbedingung');
});
