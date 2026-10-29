/**
 * Test: EINE Rueckmeldung mit Rueckweg (Critique R23, D6)
 * Zweck: Statusaktionen (Abhaken, Freigeben, Auschecken, Einnehmen, Abo bezahlen)
 *        quittieren "<Objekt> <Verb>" mit Rueckgaengig, das am Server ECHT
 *        zuruecknimmt; Loeschen geht mit Rueckgaengig, eine Rueckfrage bleibt nur
 *        den Behaeltern (Medikament mit Protokoll, Laborbefund, Konto mit
 *        Buchungen, Ausgabengruppe). Die Server-Gegenwege halten die Route-Suiten
 *        (rewards-routes, housekeeping-routes, health-api,
 *        subscription-renew-permission); hier steht, dass die Seiten sie nutzen.
 * Ausfuehren: node --test test/test-feedback-undo-ui.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** Der Rumpf einer Funktion (bis zur naechsten Funktion auf oberster Ebene). */
function body(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} fehlt`);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n(?:async )?function |\n\/\*\*|\nconst [A-Za-z]+ = /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test('ux.js: offerUndo ist der eine Baustein der Quittung mit Rueckweg', () => {
  const ux = read('public/utils/ux.js');
  const fn = body(ux, 'export function offerUndo(');
  assert.match(fn, /showToast\(message, 'default', duration, action, \{ scope, handle \}\)/, 'eine Form: default, Frist, Aktion (seit R24 mit Modul-Marke und Nachtrag)');
  // QUITTUNG IM TIPP (R24): Rueckgaengig wartet auf die laufende Anfrage und tut nichts, wenn sie scheiterte.
  assert.match(fn, /if \(pending\) \{\s*try \{ await pending; \} catch \{ return; \}\s*\}\s*try \{\s*await undo\(\);/);
});

test('Aufgaben: die Quittung liest den Titel VOR dem Neuladen und nennt offene Teilaufgaben', () => {
  const src = read('public/pages/tasks.js');
  // An beiden Gesten (Haken, Wisch) steht der Schnappschuss vor dem Statuswechsel -
  // und seit R24 (G0-Shell-P1-2) die Quittung auch VOR dem ersten `await`: sie
  // bekommt die laufende Anfrage, nicht deren Antwort.
  const sites = [...src.matchAll(/const before = taskSnapshot\((\w+)\);(?:\s*\/\/[^\n]*)*\s*const pending = toggleTaskStatus\(\w+, \w+\);\s*acknowledgeStatusToggle\(container, \1, nextStatus, pending, before\);\s*try \{\s*await pending;/g)];
  assert.equal(sites.length, 2, 'Haken und Wisch quittieren im Tipp, mit Titel und Teilaufgaben von vor dem Wechsel');
  assert.equal((src.match(/acknowledgeStatusToggle\(container, \w+, nextStatus, \w+, before\)/g) ?? []).length, 2);
  const ack = body(src, 'function acknowledgeStatusToggle(');
  assert.match(ack, /tasks\.doneSubtasksOpen/);
  assert.match(ack, /tasks\.checkAllSubtasks/);
  assert.match(ack, /offerUndo\(/);
});

test('Belohnungen: Freigeben/Ablehnen fragen nicht, Rueckgaengig schickt reopen', () => {
  const fn = body(read('public/pages/rewards.js'), 'async function decideRedemption(');
  // Vor der Anfrage: keine Rueckfrage. Der Dialog im Fehlerweg (vergriffen) bleibt.
  assert.doesNotMatch(fn.slice(0, fn.indexOf('try {')), /confirmModal\(/, 'keine Rueckfrage vor einer Entscheidung');
  assert.match(fn, /action: 'reopen'/);
  assert.match(fn, /decisionSentence\(row, action\)/);
});

test('Haushaltshilfe: Auschecken quittiert mit Name und oeffnet die Sitzung wieder', () => {
  const src = read('public/pages/housekeeping.js');
  const fn = body(src, 'async function toggleSession(');
  assert.match(fn, /housekeeping\.checkedOutNamed/);
  assert.match(fn, /\/housekeeping\/work-sessions\/\$\{sessionId\}\/reopen/);
  // Folgezustand: nach dem Auschecken ist "Einchecken" nicht mehr der Primaerknopf.
  assert.match(src, /checkedIn \|\| doneToday \? 'btn--secondary' : 'btn--primary'/);
  assert.match(src, /housekeeping\.checkInAgain/);
});

// R24 (G0-Shell-P1-2, G2-Quer-P2-2): die Quittung kam nach dem Roundtrip
// (300-700 ms) und hiess "Aufgabe erledigt." - ohne Objekt, und nach einem
// Modulwechsel im naechsten Modul. Jetzt steht sie VOR dem ersten `await` und
// nennt die Arbeit; der Besuch geht mit Rueckgaengig statt mit Rueckfrage.
test('Haushaltshilfe: Erledigen und Ein-/Auschecken quittieren im Tipp, der Besuch geht mit Rueckgaengig', () => {
  const src = read('public/pages/housekeeping.js');
  const complete = body(src, 'async function completeTask(');
  assert.match(complete, /const pending = api\.post\(`\/housekeeping\/decay-tasks\/\$\{task\.id\}\/complete`, \{\}\);\s*offerUndo\(\{\s*message: t\('housekeeping\.taskDoneNamed', \{ name: task\.name \}\),\s*pending,/,
    'Erledigen: Quittung mit Namen, bevor die Anfrage antwortet');
  assert.ok(complete.indexOf('offerUndo(') < complete.indexOf('await '), 'kein await vor der Quittung');
  const session = body(src, 'async function toggleSession(');
  assert.ok(session.indexOf("t('housekeeping.checkedOutNamed'") < session.indexOf('await pending'), 'Auschecken: Quittung vor dem Warten');
  assert.ok(session.indexOf("t('housekeeping.checkedInNamed'") < session.lastIndexOf('await pending'), 'Einchecken: Quittung vor dem Warten');
  const wire = body(src, 'function wireVisitRows(');
  assert.doesNotMatch(wire, /confirmModal\(/, 'ein Besuch ist kein Behaelter - keine Rueckfrage');
  const del = body(src, 'function deleteVisitWithUndo(');
  assert.match(del, /scheduleUndoableDelete\(\{\s*message: t\('housekeeping\.visitDeletedNamed', \{ date \}\)/);
  assert.match(body(src, 'async function payVisit('), /housekeeping\.visitPaidNamed/);
  assert.match(body(src, 'async function unpayVisit('), /housekeeping\.visitUnpaidNamed/);
});

test('Gesundheit: eine Dosis quittiert mit Namen und schreibt beim Rueckgaengig den Abzug gut', () => {
  const src = read('public/pages/health.js');
  const ack = body(src, 'function acknowledgeDose(');
  assert.match(ack, /\/health\/logs\/\$\{log\.id\}\/undo/);
  assert.match(ack, /stock_deducted/);
  for (const fn of ['async function handlePrnDose(', 'async function handleDose(', 'async function handleOverviewDose(']) {
    assert.match(body(src, fn), /acknowledgeDose\(/, `${fn} quittiert ueber acknowledgeDose`);
    assert.doesNotMatch(body(src, fn), /showToast\(t\('health\.meds\.doseSaved'\)/, `${fn}: kein "Eintrag aktualisiert."`);
  }
  // Ein Loeschdialekt: Zeilen mit Rueckgaengig, die Behaelter fragen.
  for (const fn of ['function deleteMedLog(', 'function deleteActivity(', 'function deletePeriod(', 'function deleteDayLog(']) {
    const b = body(src, fn);
    assert.doesNotMatch(b, /confirmOverModal\(/, `${fn}: keine Rueckfrage`);
    assert.match(b, /deleteRowWithUndo\(/, `${fn}: Rueckgaengig`);
  }
  assert.match(body(src, 'async function deleteMed('), /confirmOverModal\(/, 'Medikament mit Protokoll ist ein Behaelter');
  assert.match(body(src, 'async function deleteLabReport('), /confirmOverModal\(/, 'Befund mit Werten ist ein Behaelter');
});

test('Abos: Bezahlen fragt nicht und nimmt per Marke zurueck; Loeschen geht mit Rueckgaengig', () => {
  const src = read('public/pages/subscriptions.js');
  const renew = body(src, 'async function renewSubscription(');
  assert.doesNotMatch(renew, /confirmModal\(/);
  assert.match(renew, /renew\/undo`, response\.undo\)/, 'zurueck geht nur die Marke des Servers');
  const del = body(src, 'async function deleteSubscription(');
  assert.doesNotMatch(del, /confirmModal\(/);
  assert.match(del, /scheduleUndoableDelete\(/);
  assert.match(del, /common\.deletedNamed/);
});

test('Inventar, Konto, geteilte Ausgabe, Notiz: Loeschen mit Rueckgaengig und Namen; ein Konto mit Buchungen fragt', () => {
  const inv = body(read('public/pages/inventory.js'), 'async function removeItem(');
  assert.doesNotMatch(inv, /confirmModal\(/);
  assert.match(inv, /scheduleUndoableDelete\(/);
  const budget = read('public/pages/budget.js');
  assert.match(budget, /if \(!\(Number\(account\.entry_count\) > 0\)\) \{[\s\S]{0,200}deleteEmptyAccountWithUndo\(account\)/);
  assert.match(body(budget, 'function deleteEmptyAccountWithUndo('), /scheduleUndoableDelete\(/);
  // Fremde private Buchungen am Konto weiss die Seite nicht (kein Orakel), und der
  // Server antwortet darauf nicht anders (Huelle, test:budget-accounts).
  assert.doesNotMatch(budget, /has_hidden_entries|account_delete_refused/);
  const split = read('public/pages/split-expenses.js');
  const del = split.slice(split.indexOf("#split-delete-expense')?.addEventListener"), split.indexOf("#split-expense-form')?.addEventListener('submit'"));
  assert.doesNotMatch(del, /confirmOverModal\(/);
  assert.match(del, /scheduleUndoableDelete\(/);
  assert.match(body(read('public/pages/notes.js'), 'async function deleteNote('), /common\.deletedNamed/);
});
