/**
 * Test: Detail-/Vorschauansicht für Termine und Aufgaben
 *
 * Deckt ab:
 *  - detail-view.js exportiert openDetailView und baut DOM ohne innerHTML
 *  - Präsentationsweiche: Popover nur bei Breakpoint UND Anker
 *  - modal.js trägt die drei Bausteine des Pane-Wechsels (initialFocus,
 *    refreshDirtySnapshot, mountFooter) - ohne sie bricht der Wechsel in der
 *    Bedienung, nicht im Test
 *  - calendar.js und tasks.js öffnen auf allen Einstiegen die Detailansicht und
 *    nicht mehr direkt das Formular; neue Einträge bleiben davon ausgenommen
 *  - showEventPopup und .event-popup sind rückstandslos entfernt
 *  - describeRRule beschreibt die Wiederholung im Klartext
 *  - neue i18n-Keys in ALLEN Locales vorhanden und nicht leer
 *  - detail-view.css deckt Popover-Variante und prefers-reduced-motion ab
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = async (path) => (
  await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
).replace(/\r\n/g, '\n');

const detailJs   = () => read('public/components/detail-view.js');
const detailCss  = () => read('public/styles/detail-view.css');
const modalJs    = () => read('public/components/modal.js');
const calendarJs = () => read('public/pages/calendar.js');
const tasksJs    = () => read('public/pages/tasks.js');
const contactsJs = () => read('public/pages/contacts.js');
const rruleJs    = () => read('public/rrule-ui.js');

// Die neuen Keys, gruppiert nach ihrem Namensraum in den Locale-Dateien.
// `common` steht bewusst nicht dabei: Der Kopf-Button nutzt mit `common.back`
// einen Bestandskey, die Ansicht braucht dort nichts Neues.
const NEW_KEYS = {
  calendar:  ['detailWhen', 'detailCalendar'],
  reminders: ['sectionTitlePlural'],
  rrule:     ['summaryUntil', 'summaryCount', 'summaryCount_one'],
  tasks:     ['statusLabel', 'detailStart', 'detailFinish', 'detailReopen', 'subtasksLabel', 'swipeView'],
};

// Keys, die mit dem alten Popup bzw. der alten Wisch-Beschriftung entfallen sind.
const REMOVED_KEYS = { calendar: ['popupEdit'], tasks: ['swipeEdit'] };

// --------------------------------------------------------
// Komponente
// --------------------------------------------------------

test('detail-view.js exportiert die öffentliche API', async () => {
  const src = await detailJs();
  assert.match(src, /export function openDetailView\(/, 'openDetailView muss exportiert sein');
  assert.match(src, /export function closeDetailView\(/, 'closeDetailView muss exportiert sein');
  assert.match(src, /export function detailRowEl\(/, 'der Zeilen-Renderer muss wiederverwendbar sein');
});

test('die Komponente baut DOM, statt Markup zu setzen', async () => {
  const src = await detailJs();
  assert.doesNotMatch(src, /\.innerHTML\s*=/, 'kein innerHTML');
  assert.doesNotMatch(src, /insertAdjacentHTML/, 'auch kein Markup-String über insertAdjacentHTML');
  assert.match(src, /createElement/, 'Elemente über createElement');
  assert.match(src, /textContent\s*=/, 'Werte als Text, nicht als Markup');
});

test('Präsentationsweiche verlangt Breakpoint UND Anker', async () => {
  const src = await detailJs();
  assert.match(src, /POPOVER_MIN_WIDTH\s*=\s*768/, 'Breakpoint bei 768px');
  assert.match(
    src,
    /window\.innerWidth\s*>=\s*POPOVER_MIN_WIDTH\s*&&\s*!!opts\.anchor/,
    'Popover nur, wenn beides zutrifft - sonst Sheet',
  );
});

test('der Wechsel ins Formular löst die drei Fallen in fester Reihenfolge', async () => {
  const src = await detailJs();
  const form = src.slice(src.indexOf('function switchToForm'), src.indexOf('function switchToDetail'));
  assert.ok(form.length > 0, 'switchToForm muss existieren');
  assert.match(form, /opts\.edit\.mount\(/, 'das Formular entsteht erst beim Wechsel (Lazy Mount)');
  assert.match(form, /mountFooter\(/, 'Falle 2: die Formular-Fußzeile muss ans Panel');
  assert.match(form, /refreshDirtySnapshot\(/, 'Falle 1: die Dirty-Basis muss nachgezogen werden');
  assert.match(form, /focusFirstField\(/, 'Falle 3: der Fokus muss bewusst gesetzt werden');
});

test('die Dirty-Basis wird nur beim ersten Mount gezogen', async () => {
  const src = await detailJs();
  const form = src.slice(src.indexOf('function switchToForm'), src.indexOf('function switchToDetail'));
  // Beim zweiten „Bearbeiten" stehen die Eingaben des Nutzers im Formular. Ein
  // Snapshot fröre sie als Ausgangsstand ein, das Schließen ginge ohne
  // Verwerfen-Frage durch und die Eingaben wären still verloren.
  assert.match(form, /if \(firstMount\) refreshDirtySnapshot\(\)/, 'sonst friert der zweite Besuch die Eingaben als „unverändert" ein');
});

test('nachgereichte Zeilen landen nie in einer fremden Ansicht', async () => {
  const src = await detailJs();
  // Eine verspätete Serverantwort darf nicht in die Ansicht schreiben, die der
  // Nutzer inzwischen geöffnet hat - der Termin von eben in die Karte von jetzt.
  assert.match(src, /let activeViewToken = 0/, 'jede Ansicht bekommt eine Nummer');
  assert.match(src, /if \(activeViewToken !== token\) return false/, 'update verwirft sich für abgelöste Ansichten');
  // Auch X, Escape, Backdrop und Wischgeste müssen die Nummer ungültig machen,
  // nicht nur der Weg über closeDetailView().
  assert.match(src, /onClose\(\)\s*\{[\s\S]*?activeViewToken === token[\s\S]*?activeViewToken = 0/, 'das Sheet invalidiert beim Schließen');

  // Die vorige Ansicht wird in openDetailView abgeräumt, VOR der Nummernvergabe.
  // Stünde closeDetailView() wieder in openAsPopover, löschte es die Nummer der
  // Ansicht, die es gerade aufbaut - alles Nachgereichte fiele lautlos weg. Im
  // Quelltext sieht das harmlos aus, im Browser gemessen kam nichts mehr an.
  // Nur der Funktionskopf bis zum ersten Aufbauschritt - Escape und Außenklick
  // weiter unten rufen closeDetailView() völlig zu Recht.
  const popoverHead = src.slice(
    src.indexOf('function openAsPopover'),
    src.indexOf('const popover = document.createElement'),
  );
  assert.doesNotMatch(popoverHead, /closeDetailView\(\)/, 'openAsPopover darf sich nicht selbst die Nummer löschen');

  const api = src.slice(src.indexOf('export function openDetailView'));
  const close = api.indexOf('closeDetailView()');
  const assign = api.indexOf('activeViewToken = token');
  assert.ok(close > -1 && assign > close, 'erst die alte Ansicht schließen, dann nummerieren');
});

test('der Wechsel ins Formular ist gegen Doppelklick gesperrt', async () => {
  const src = await detailJs();
  const form = src.slice(src.indexOf('async function switchToForm'), src.indexOf('function switchToDetail'));
  // Zwischen await und fertigem Formular darf kein zweiter Klick durch, sonst
  // baut mount() ein zweites Mal auf und verwirft die Eingaben des ersten.
  assert.match(form, /state\.mode !== 'detail'/, 'nur aus der Leseansicht heraus');
  assert.match(form, /state\.mode = 'switching'/, 'Zwischenzustand vor dem await');
});

test('der Kopf-Button im Formular verspricht kein Speichern', async () => {
  const src = await detailJs();
  const form = src.slice(src.indexOf('function switchToForm'), src.indexOf('function switchToDetail'));
  // „Fertig" heißt auf jeder Plattform „übernehmen". Der Knopf wechselt aber nur
  // die Ansicht, und die zeigt danach wieder den gespeicherten Stand.
  assert.match(form, /label: t\('common\.back'\)/, 'der Knopf wechselt die Ansicht, er übernimmt nichts');
  assert.doesNotMatch(form, /common\.done/, '„Fertig" verspricht ein Speichern, das nicht stattfindet');
});

test('beide Fußzeilen werden aufbewahrt statt verworfen', async () => {
  const src = await detailJs();
  assert.match(src, /function detachFooter\(/, 'Fußzeilen werden abgehängt, nicht entfernt');
  assert.match(src, /state\.detailFooter/, 'die Detail-Fußzeile überlebt den Wechsel');
  assert.match(src, /state\.formFooter/, 'die Formular-Fußzeile überlebt den Rückwechsel');
});

test('das Popover ist bedienbar ohne Maus und gibt den Fokus zurück', async () => {
  const src = await detailJs();
  const popover = src.slice(src.indexOf('function openAsPopover'));
  assert.match(popover, /role', 'dialog'|setAttribute\('role', 'dialog'\)/, 'als Dialog ausgezeichnet');
  assert.match(popover, /aria-labelledby/, 'mit dem Titel verknüpft');
  assert.match(popover, /'Escape'/, 'Escape schließt');
  assert.match(popover, /e\.key !== 'Tab'|'Tab'/, 'Tab bleibt im Popover');
  assert.match(popover, /opts\.anchor\?\.focus\?\.\(\)/, 'Fokus kehrt zum Auslöser zurück');
});

test('die Detailansicht öffnet ohne Autofokus', async () => {
  const src = await detailJs();
  assert.match(src, /initialFocus:\s*'none'/, 'kein Feldfokus - sonst fährt die Tastatur hoch');
});

// --------------------------------------------------------
// modal.js: das Fundament
// --------------------------------------------------------

test('modal.js exportiert die Bausteine des Pane-Wechsels', async () => {
  const src = await modalJs();
  assert.match(src, /export function refreshDirtySnapshot\(/);
  assert.match(src, /export function mountFooter\(/);
  assert.match(src, /export function focusFirstField\(/);
  assert.match(src, /export function updateHeaderAction\(/);
});

test('initialFocus ist rückwärtskompatibel voreingestellt', async () => {
  const src = await modalJs();
  assert.match(
    src,
    /initialFocus\s*=\s*'first-field'/,
    "Default bleibt 'first-field', damit bestehende Modals unverändert öffnen",
  );
  assert.match(src, /if \(initialFocus === 'none'\) return;/, "'none' unterdrückt den Autofokus");
});

test('nach dem Wechsel entscheidet die Zeigerfähigkeit über den Fokus', async () => {
  const src = await modalJs();
  const fn = src.slice(src.indexOf('export function focusFirstField'));
  assert.match(fn, /\(pointer: coarse\)/, 'auf Fingergeräten kein Feldfokus');
  assert.match(fn, /modal-panel__title/, 'stattdessen der Panel-Kopf');
});

test('mountFooter räumt eine bereits gehobene Fußzeile weg', async () => {
  const src = await modalJs();
  const fn = src.slice(src.indexOf('export function mountFooter'), src.indexOf('export function updateHeaderAction'));
  assert.match(fn, /modal-panel__footer/, 'sucht die Fußzeile im Body');
  assert.match(fn, /setAttribute\('form'/, 'verankert Submit-Buttons am Formular (#543)');
  assert.match(fn, /\.remove\(\)/, 'entfernt die Fußzeile der vorigen Ansicht');
});

// --------------------------------------------------------
// Kalender
// --------------------------------------------------------

test('das alte Termin-Popup ist rückstandslos entfernt', async () => {
  const js = await calendarJs();
  const css = await read('public/styles/calendar.css');
  assert.doesNotMatch(js, /showEventPopup/, 'showEventPopup ist weg');
  assert.doesNotMatch(js, /event-popup/, 'keine .event-popup-Klassen mehr im Modul');
  assert.doesNotMatch(css, /\.event-popup/, 'kein .event-popup-Block mehr im CSS');
});

test('jeder Weg zu einem Termin führt in die Detailansicht', async () => {
  const src = await calendarJs();
  assert.match(src, /async function openEventDetail\(ev, anchor = null\)/, 'ein einziger Einstieg');
  assert.match(src, /import \{ openDetailView.*\} from '\/components\/detail-view\.js'/);

  // Kein Aufrufpfad darf an der Detailansicht vorbei ins Formular führen; der
  // Anlege-Pfad und der Popover-Rückfall sind die benannten Ausnahmen.
  const editCalls = [...src.matchAll(/openEventModal\(\{[^}]*mode:\s*'edit'/g)];
  assert.equal(
    editCalls.length,
    1,
    "nur der Desktop-Popover-Rückfall darf noch direkt ins Bearbeiten-Formular führen",
  );
  assert.match(src, /standalone:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?openEventModal\(/, 'und zwar als edit.standalone');
});

test('das Formular wartet auf die Erinnerungen, die Leseansicht nicht', async () => {
  const src = await calendarJs();
  const fn = src.slice(src.indexOf('async function openEventDetail'), src.indexOf('async function loadReminderForEvent'));

  // Die Leseansicht erscheint sofort: Der Ladeaufruf darf das Öffnen nicht mehr
  // blockieren, sonst ist der Antipp-Moment wieder einen Roundtrip lang stumm.
  const load = fn.indexOf('loadReminderForEvent(');
  const open = fn.indexOf('openDetailView(');
  assert.ok(load > -1 && open > -1, 'beide Aufrufe müssen existieren');
  assert.doesNotMatch(
    fn.slice(load, open),
    /await\s+loadReminderForEvent/,
    'kein await zwischen Laden und Öffnen - der Tap muss sofort etwas zeigen',
  );

  // Das Formular dagegen MUSS sie haben: saveEvent liest die Erinnerungen aus
  // den Formularzeilen und löscht die des Termins, wenn es keine findet.
  assert.match(fn, /ready:\s*remindersReady/, 'der Wechsel ins Formular wartet auf die Erinnerungen');
  assert.match(fn, /standalone:\s*async[\s\S]*?await remindersReady/, 'der Desktop-Weg ebenso');
  assert.match(fn, /view\.update\(/, 'die Erinnerungszeile wird nachgetragen');
});

test('ein neuer Termin startet weiterhin direkt im Formular', async () => {
  const src = await calendarJs();
  assert.match(src, /openEventModal\(\{ mode: 'create' \}\)/, 'der Anlege-Pfad bleibt unangetastet');
});

test('die Termin-Verdrahtung ist zweigeteilt', async () => {
  const src = await calendarJs();
  assert.match(src, /function wireEventForm\(panel, \{ mode, event = null, reminder = null \}\)/);
  assert.match(src, /onSave\(panel\) \{ wireEventForm\(panel/, 'openEventModal nutzt dieselbe Verdrahtung');
  assert.match(src, /mount: \(panel, pane\) =>/, 'die Detailansicht mountet das Formular später');

  // Die Sync-Ziele braucht nur das Formular: ein Roundtrip je Nachschauen wäre
  // verschenkt.
  const wire = src.slice(src.indexOf('function wireEventForm'));
  assert.match(wire, /loadSyncTargets\(/, 'loadSyncTargets läuft im Formular-Mount');
});

test('die Termin-Detailansicht zeigt, was das alte Popup verschwieg', async () => {
  const src = await calendarJs();
  const fn = src.slice(src.indexOf('function renderEventDetail'), src.indexOf('async function openEventDetail'));
  assert.match(fn, /recurrenceRow\(ev\.recurrence_rule\)/, 'Wiederholung im Klartext');
  assert.match(fn, /reminderSummary\(/, 'Erinnerungen im Klartext');
  assert.match(fn, /visibilityRow\(ev\.visibility\)/, 'Sichtbarkeit');
  assert.match(fn, /assignedRow\(ev\.assigned_users/, 'Zugewiesene über die geteilte Zeile');
});

test('die Weiterleitung für Haushaltshilfe-Besuche greift vor der Detailansicht', async () => {
  const src = await calendarJs();
  const fn = src.slice(src.indexOf('async function openEventDetail'));
  const guard = fn.indexOf('housekeeping_visit_id');
  const open = fn.indexOf('openDetailView(');
  assert.ok(guard > -1 && guard < open, 'sonst führte der Weg über die Detailansicht ins Leere');
});

// --------------------------------------------------------
// Aufgaben
// --------------------------------------------------------

test('alle fünf Aufgaben-Einstiege führen in die Detailansicht', async () => {
  const src = await tasksJs();
  assert.match(src, /function openTaskDetail\(\{ task, users = \[\], reminder = null \}, container\)/);

  // Nur Aufrufe zählen, nicht die Definition darüber.
  const detailCalls = [...src.matchAll(/openTaskDetail\(\{ task, users: state\.users, reminder \}, container\)/g)];
  assert.equal(detailCalls.length, 4, 'Listenzeile/Stift, Kanban, Wischen und Deep-Link');

  // Übrig bleibt genau ein openTaskModal-Aufruf: der FAB für neue Aufgaben.
  // Die Definition darüber trägt Defaults (`= {}`) und zählt nicht mit.
  const modalCalls = [...src.matchAll(/^\s+openTaskModal\(\{.*\}, container\);$/gm)];
  assert.equal(modalCalls.length, 1, 'nur der Anlege-Pfad öffnet noch direkt das Formular');
  assert.match(src, /openTaskModal\(\{ users: state\.users \}, container\)/, 'und zwar ohne task');
});

test('die Wisch-Geste heißt Ansehen, nicht Bearbeiten', async () => {
  const src = await tasksJs();
  assert.match(src, /tasks\.swipeView/, 'neuer Schlüssel');
  assert.doesNotMatch(src, /tasks\.swipeEdit/, 'der alte ist ersetzt, nicht umgedeutet');
});

test('die Aufgaben-Verdrahtung ist zweigeteilt und behält die Tag-Reihenfolge', async () => {
  const src = await tasksJs();
  assert.match(src, /function wireTaskForm\(panel, \{ task = null, container \}\)/);

  // modalTags ist ein Working-Set, das renderTagChips direkt nach dem Rendern
  // liest - es muss VOR renderModalContent gesetzt werden.
  const mountStart = src.indexOf('mount: (panel, pane) =>');
  const mount = src.slice(mountStart, src.indexOf('wireTaskForm(panel, { task, container });', mountStart));
  assert.ok(mount.length > 0, 'der Mount-Block muss auffindbar sein');
  const tags = mount.indexOf('modalTags =');
  const render = mount.indexOf('renderModalContent(');
  assert.ok(tags > -1 && render > -1 && tags < render, 'modalTags wird vor dem Rendern gesetzt');
});

test('der Status lässt sich aus der Detailansicht weiterschalten', async () => {
  const src = await tasksJs();
  assert.match(src, /const NEXT_STATUS = \{/, 'die Kette open → in_progress → done ist benannt');
  assert.match(src, /open:\s*\{ status: 'in_progress'/);
  assert.match(src, /in_progress:\s*\{ status: 'done'/);
  assert.match(src, /done:\s*\{ status: 'open'/);
  assert.doesNotMatch(src, /archived:\s*\{ status:/, 'archivierte Aufgaben werden nicht weitergeschaltet');

  const fn = src.slice(src.indexOf('async function advanceTaskStatus'));
  assert.match(fn, /api\.patch\(`\/tasks\/\$\{task\.id\}\/status`/, 'nutzt die bestehende Route');
  assert.match(fn, /task\.status = previous;/, 'rollt bei Fehler zurück');
  assert.match(fn, /showToast\(/, 'und meldet den Fehler');
});

test('die Aufgaben-Detailansicht führt die Leseinformationen der Karte', async () => {
  const src = await tasksJs();
  const fn = src.slice(src.indexOf('function renderTaskDetail'), src.indexOf('function openTaskDetail'));
  for (const key of ['tasks.statusLabel', 'tasks.priorityLabel', 'tasks.dueDateLabel', 'tasks.startDateLabel',
    'tasks.categoryLabel', 'tasks.pointsLabel', 'tasks.tagsLabel',
    'tasks.subtasksLabel', 'tasks.documentsLabel', 'tasks.descriptionLabel']) {
    assert.match(fn, new RegExp(key.replace('.', '\\.')), `${key} fehlt in der Detailansicht`);
  }
  // Der Anker ab Erledigung reist als zweites Argument mit (#658), die Zeile
  // bleibt aber die geteilte - deshalb offen bis zur Klammer statt exakt.
  assert.match(fn, /recurrenceRow\(task\.recurrence_rule[),]/, 'Wiederholung über die geteilte Zeile');
  assert.match(fn, /visibilityRow\(task\.visibility\)/, 'Sichtbarkeit über die geteilte Zeile');
  assert.match(fn, /assignedRow\(task\.assigned_users/, 'Zugewiesene über die geteilte Zeile');
});

// Die Zeilen, die beide Module wortgleich bauten, wohnen jetzt an einer Stelle.
// Ohne diesen Test verlöre die Umstellung ihre Absicherung: Die Modul-Tests oben
// prüfen nur noch den Aufruf, nicht mehr Icon und Beschriftung.
test('die geteilten Zeilen tragen Icon und Beschriftung', async () => {
  const rrule = await rruleJs();
  const repeat = rrule.slice(rrule.indexOf('export function recurrenceRow'));
  assert.match(repeat, /icon: 'repeat'/, 'Wiederholungs-Icon');
  assert.match(repeat, /rrule\.labelRepeat/, 'Beschriftung der Wiederholungszeile');
  assert.match(repeat, /describeRRule\(rule[),]/, 'Klartext aus describeRRule');

  const detail = await detailJs();
  const assigned = detail.slice(detail.indexOf('export function assignedRow'));
  // Das Icon folgt der Anzahl - genau diese Kopplung stand vorher doppelt.
  assert.match(assigned, /names\.length > 1 \? 'users' : 'user'/, 'Icon folgt der Anzahl');
  assert.match(assigned, /fallbackName/, 'freier Name als Rückfall (Kalender)');
});

/**
 * Fußzeilen-Aktionen schließen ohne Verwerfen-Frage.
 *
 * Dieselbe Regel wie in test-frontend-audit.js (#625, Geburtstage 2931a76b),
 * hier aber für die Schreibweise, die erst mit dieser Komponente entstand: Die
 * Aktion bekommt ihr Schließen als blankes `close` hereingereicht, also greift
 * dort weder `closeModal(` noch `closeDetailView(`. Ein ungebundenes `close(`
 * im globalen Audit spräche auf jeden Popover- und Stream-Aufruf an, deshalb
 * steht die Prüfung hier, bei der Komponente, die den Alias vergibt.
 *
 * Warum das überhaupt beißt: `switchToDetail` versteckt das Formular nur
 * (`hidden`), es bleibt im DOM und zählt weiter in den Dirty-Check. Nach
 * „Bearbeiten → tippen → Zurück" fragt eine Fußzeilen-Aktion ohne `force` also
 * nach dem Verwerfen von Feldern, über die der Nutzer mit dem Löschen bzw. dem
 * bereits abgeschickten Schreibvorgang längst entschieden hat - zwei
 * Rückfragen für eine Entscheidung.
 */
test('Fußzeilen-Aktionen schließen die Detailansicht mit force', async () => {
  // Anker ist die Destrukturierung, nicht der Name: `close` allein trägt in
  // calendar.js auch ein fremder Icon-Dialog mit eigener lokaler close().
  const HANDLER = /onClick:\s*(async\s*)?\(\s*\{[^}]*\bclose\b[^}]*\}\s*\)\s*=>/;
  const CLOSE_CALL = /(?<![.\w])close\s*\(/;
  const WINDOW = 16;
  const violations = [];

  // Jede Seite, die die Komponente nutzt, gehört hierher - die Regel gilt für
  // den Alias, nicht für eine Auswahl von Dateien.
  const pages = [
    ['calendar.js', await calendarJs()],
    ['tasks.js',    await tasksJs()],
    ['contacts.js', await contactsJs()],
  ];
  for (const [name, src] of pages) {
    const lines = src.split('\n');
    lines.forEach((line, index) => {
      if (!HANDLER.test(line)) return;
      const indent = line.search(/\S/);

      for (let offset = 0; offset <= WINDOW; offset += 1) {
        const candidate = lines[index + offset];
        if (candidate === undefined) break;
        // Handler-Ende: schließende Klammer auf Höhe der Verdrahtung. Beim
        // einzeiligen Handler prüft nur offset 0, dort steht alles.
        if (offset > 0 && /^\s*\}/.test(candidate) && candidate.search(/\S/) <= indent) break;
        if (!CLOSE_CALL.test(candidate) || /force/.test(candidate)) continue;
        violations.push(`${name}:${index + offset + 1}: ${candidate.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, [],
    'close() einer Fußzeilen-Aktion braucht { force: true } - siehe closeDetailView');
});

// --------------------------------------------------------
// Kontakte
// --------------------------------------------------------

test('beide Kontakt-Einstiege führen in die Leseansicht', async () => {
  const src = await contactsJs();

  // Listenzeile und Deep-Link (?open=<id> aus der globalen Suche) landeten
  // beide direkt im Formular - genau der Fall, den die Komponente ablöst.
  assert.match(src, /if \(c\) openContactDetail\(c\)/, 'Antippen in der Liste');
  assert.match(src, /if \(contact\) openContactDetail\(contact\)/, 'Deep-Link ?open=<id>');

  // Die Neuanlage bleibt im Formular: dort ist Tippen die Absicht.
  assert.match(src, /openContactModal\(\{ mode: 'create'/, 'Neuanlage weiterhin direkt ins Formular');
});

test('der Wechsel ins Formular wartet auf die nachgeladenen Mehrfachwerte', async () => {
  const src = await contactsJs();

  // Die Listen-API führt weder Zweitnummern noch Adressen. buildContactForm
  // liest sie aus contact.phones/emails und fällt ohne sie auf den
  // Legacy-Einzelwert zurück - ein Formular, das vor der Antwort entsteht,
  // schriebe beim Speichern genau eine Nummer und verlöre alle weiteren.
  const fn = src.slice(src.indexOf('function openContactDetail'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const ready = fetchFullContact\(/, 'Einzelabruf als ready-Promise');
  assert.match(body, /\bready,/, 'ready wird an edit übergeben');
  assert.match(body, /mount: \(panel, pane\)/, 'Formular entsteht erst beim Wechsel');
  assert.match(body, /buildContactForm\(\{ mode: 'edit', contact: full \}\)/,
    'das Formular bekommt den nachgeladenen Kontakt, nicht den Listeneintrag');
});

test('die Leseansicht führt alle Nummern, Mails und Adressen', async () => {
  const src = await contactsJs();
  const fn = src.slice(src.indexOf('function renderContactDetail'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // Der Kern des Gewinns: die Liste zeigt je einen Legacy-Einzelwert, ein
  // Kontakt mit Dienst- und Mobilnummer bot bisher nur eine zum Antippen an.
  for (const [group, legacy] of [['phones', 'phone'], ['emails', 'email'], ['addresses', 'address']]) {
    assert.ok(body.includes(`contact.${group}?.length`),
      `${group} muss als Mehrfachwert gelesen werden`);
    assert.ok(body.includes(`contact.${legacy}`),
      `${legacy} bleibt der Rückfall, solange der Einzelabruf noch läuft`);
  }

  // CardDAV-Felder, die das Formular nicht führt und die App bisher nirgends zeigte.
  for (const field of ['organization', 'job_title', 'website', 'nickname']) {
    assert.ok(body.includes(`contact.${field}`), `${field} gehört in die Leseansicht`);
  }
});

test('Kontaktdaten kommen als Text ins DOM, nie als Markup', async () => {
  const src = await contactsJs();
  const fn = src.slice(src.indexOf('function contactLinksNode'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // Namen und Notizen kommen ungeprüft aus CardDAV. textContent kann sie nicht
  // als HTML interpretieren; ein insertAdjacentHTML an dieser Stelle könnte es.
  assert.match(body, /\.textContent = /, 'Werte über textContent setzen');
  assert.doesNotMatch(body, /insertAdjacentHTML|innerHTML/, 'kein Markup-Pfad für Kontaktdaten');
});

test('alle Locales tragen die neuen Kontakt-Schlüssel', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 23, `erwartet mindestens 23 Locales, gefunden ${files.length}`);

  for (const file of files) {
    const json = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const key of ['organizationLabel', 'websiteLabel', 'nicknameLabel']) {
      assert.ok(json.contacts?.[key], `${file}: contacts.${key} fehlt oder ist leer`);
      // Der erste Versuch setzte sie versehentlich in den shopping-Block: der
      // Anker `notesLabel` steht in beiden Namensräumen, und die Schlüssel-
      // parität blieb dabei grün, weil alle 23 Dateien denselben Fehler trugen.
      assert.ok(!json.shopping?.[key], `${file}: contacts.${key} liegt im falschen Block (shopping)`);
    }
  }
});

// --------------------------------------------------------
// Wiederholung im Klartext
// --------------------------------------------------------

test('describeRRule beschreibt Rhythmus, Tage und Ende', async () => {
  const src = await rruleJs();
  assert.match(src, /export function describeRRule\(/);
  const fn = src.slice(src.indexOf('export function describeRRule'));
  assert.match(fn, /if \(!p\.freq\) return '';/, 'ohne Regel keine Zeile');
  assert.match(fn, /p\.freq === 'WEEKLY' && p\.byday\.length/, 'Wochentage nur bei WEEKLY');
  assert.match(fn, /rrule\.summaryCount/, 'COUNT wird benannt');
  assert.match(fn, /rrule\.summaryUntil/, 'UNTIL wird benannt');
  assert.match(fn, /·/, 'die Endebedingung bekommt einen Trenner');
});

// --------------------------------------------------------
// CSS
// --------------------------------------------------------

test('detail-view.css deckt beide Präsentationen und Bewegungsreduktion ab', async () => {
  const css = await detailCss();
  assert.match(css, /\.detail-view\s*\{/);
  assert.match(css, /\.detail-row\s*\{/);
  assert.match(css, /\.detail-view__accent\s*\{/);
  assert.match(css, /\.detail-popover\s*\{/, 'Popover-Variante');
  assert.match(css, /prefers-reduced-motion/, 'Bewegungsreduktion');
  assert.match(css, /\.modal-panel--resizing/, 'Höhenübergang des Sheets');
});

test('detail-view.css nutzt ausschließlich Tokens', async () => {
  const css = await detailCss();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, ''); // Kommentare erklären Werte, sie setzen keine
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, 'kein rohes Hex');
  assert.doesNotMatch(body, /:\s*-?\d+(\.\d+)?(px|rem|em)\b/, 'keine rohen Längen');
  assert.doesNotMatch(body, /rgba?\(/, 'keine rohen Farben');
});

test('die Detailansicht ist in der Shell eingebunden', async () => {
  const html = await read('public/index.html');
  assert.match(html, /styles\/detail-view\.css/, 'geteilte Komponenten-CSS gehört in die Shell');
});

test('Komponente und Stil liegen im Precache', async () => {
  const sw = await read('public/sw.js');
  assert.match(sw, /'\/components\/detail-view\.js'/, 'sonst fehlt sie offline');
  assert.match(sw, /'\/styles\/detail-view\.css'/);
});

// --------------------------------------------------------
// i18n
// --------------------------------------------------------

test('alle Locales tragen die neuen Schlüssel (nicht leer)', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 20, 'der volle Locale-Satz wird erwartet');

  for (const file of files) {
    const json = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [group, keys] of Object.entries(NEW_KEYS)) {
      for (const key of keys) {
        const value = json[group]?.[key];
        assert.equal(typeof value, 'string', `${file}: ${group}.${key} muss ein String sein`);
        assert.ok(value.trim().length > 0, `${file}: ${group}.${key} darf nicht leer sein`);
      }
    }
  }
});

test('die Zähl-Variante trägt in jeder Locale ihren Platzhalter', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const json = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    assert.match(json.rrule.summaryCount, /\{\{count\}\}/, `${file}: {{count}} fehlt`);
    assert.match(json.rrule.summaryCount_one, /\{\{count\}\}/, `${file}: _one braucht denselben Platzhalter`);
    assert.match(json.rrule.summaryUntil, /\{\{date\}\}/, `${file}: {{date}} fehlt`);
  }
});

test('die abgelösten Schlüssel sind überall entfernt', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const json = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [group, keys] of Object.entries(REMOVED_KEYS)) {
      for (const key of keys) {
        assert.equal(json[group]?.[key], undefined, `${file}: ${group}.${key} ist abgelöst und muss weg`);
      }
    }
  }
});
