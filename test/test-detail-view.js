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

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Einen Namen als Literal in ein RegExp setzen.
 *
 * VOLLSTAENDIG, nicht nur das Zeichen, das gerade stoert: Hier stand einmal
 * `.replace(/-/g, '\\-')`, weil Klassennamen Bindestriche tragen - und liess
 * jedes andere Metazeichen durch, den Backslash zuerst. Aus einem Namen wird
 * dann ein Muster, das etwas anderes sucht als den Namen, und ein Guard, der
 * still am Falschen vorbeimisst (CodeQL js/incomplete-sanitization).
 */
const reLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, (ch) => `\\${ch}`);

const detailJs   = () => read('public/components/detail-view.js');
const detailCss  = () => read('public/styles/detail-view.css');
const modalJs    = () => read('public/components/modal.js');
const calendarJs = () => read('public/pages/calendar.js');
const tasksJs    = () => read('public/pages/tasks.js');
const taskDetailJs = () => read('public/components/task-detail.js');
const dashboardJs  = () => read('public/pages/dashboard.js');
const contactsJs = () => read('public/pages/contacts.js');
const rruleJs    = () => read('public/rrule-ui.js');

// Die neuen Keys, gruppiert nach ihrem Namensraum in den Locale-Dateien.
// `common` steht bewusst nicht dabei: Der Kopf-Button nutzt mit `common.back`
// einen Bestandskey, die Ansicht braucht dort nichts Neues.
const NEW_KEYS = {
  calendar:  ['detailWhen', 'detailCalendar', 'openInMap'],
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

test('das nachgeladene Formular bekommt seine Lucide-Icons (#1141)', async () => {
  const src = await detailJs();
  const form = src.slice(src.indexOf('function switchToForm'), src.indexOf('function switchToDetail'));
  // edit.mount() fuegt sein Markup erst beim Wechsel ein - der createIcons-Lauf
  // beim urspruenglichen Oeffnen der Leseansicht (renderIcons(panel) in
  // onSave()) kommt dafuer zu frueh und erreicht dieses Formular nie. Ohne
  // einen zweiten Lauf bleiben `data-lucide`-Platzhalter im Formular leer -
  // z. B. alle 13 Knoepfe der Markdown-Formatierungsleiste ueber der
  // Aufgaben-Notiz.
  const mountIdx = form.indexOf('opts.edit.mount(');
  const iconsIdx = form.indexOf('renderIcons(pane)');
  assert.ok(mountIdx > -1 && iconsIdx > -1, 'renderIcons(pane) muss nach dem Mount stehen');
  assert.ok(iconsIdx > mountIdx, 'die Icons muessen NACH dem Einfuegen des Formular-Markups erzeugt werden');
});

test('„Abbrechen" wirkt auch in einem nachträglich gebauten Formular (#738)', async () => {
  const src = await modalJs();
  const open = src.slice(src.indexOf('export function openModal'), src.indexOf('export async function closeModal'));

  // Der Anlassfall: Das Bearbeiten-Formular entsteht erst beim Klick auf
  // „Bearbeiten" (switchToForm → edit.mount, siehe Test oben). Wer die
  // Abbrechen-Knöpfe beim Öffnen des Modals einzeln verdrahtet, erreicht dieses
  // Formular nie - sein „Abbrechen" tat sichtbar nichts.
  assert.doesNotMatch(
    open,
    /querySelectorAll\(\s*'\[data-action="close-modal"\]'\s*\)[\s\S]{0,120}addEventListener/,
    'einmaliges Verdrahten je Knoten erreicht kein später gebautes Formular'
  );
  assert.match(
    open,
    /addEventListener\('click',[\s\S]{0,200}closest\('\[data-action="close-modal"\]'\)/,
    'die Abbrechen-Knöpfe müssen delegiert am Overlay hängen'
  );
});

test('die Module mit Leseansicht nutzen genau diese Abbrechen-API (#738)', async () => {
  // Die zweite Hälfte des Nachweises: Der delegierte Listener oben hilft nur,
  // wenn die nachgeladenen Formulare wirklich data-action="close-modal" tragen.
  // Ohne diese Kopplung liefe der Guard über eine leere Menge.
  for (const [name, src] of [
    ['tasks.js', await tasksJs()],
    ['recipes.js', await read('public/pages/recipes.js')],
    ['shopping.js', await read('public/pages/shopping.js')],
  ]) {
    assert.match(src, /data-action="close-modal"/, `${name} baut sein Abbrechen über die geteilte API`);
  }
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
  const close = api.indexOf('closeDetailView(');
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

test('im Sheet steht Bearbeiten als Hauptaktion unten, Löschen zurückgenommen am Anfang (Critique 2026-09-24)', async () => {
  const src = await detailJs();
  const sheet = src.slice(src.indexOf('function openAsSheet'), src.indexOf('// Präsentation: Popover'));
  // Der Knopf entsteht in der FUSSZEILE, als Primaerknopf, NACH den Aktionen
  // des Aufrufers - also am Ende, in der Daumenzone.
  assert.match(sheet, /\[\.\.\.\(opts\.actions \?\? \[\]\), \{\s*id: 'detail-view-edit',[\s\S]{0,120}variant: 'primary'/,
    'mit edit.primary gehört Bearbeiten als Primärknopf ans Ende der Fußzeile');
  // Oben bleibt kein zweites Bearbeiten stehen; der Kopfknopf erscheint erst im
  // Formular, als „Zurück".
  assert.match(sheet, /hidden: primaryEdit/, 'der Kopfknopf muss in der Leseansicht verborgen sein');
  const back = src.slice(src.indexOf('function switchToDetail'), src.indexOf('// Kopf-Aktion'));
  assert.match(back, /hidden: state\.primaryEdit/, 'zurück in der Leseansicht muss der Kopfknopf wieder verschwinden');
  // Löschen steht am ANFANG - logisch, damit RTL es nicht an das Ende schiebt.
  const css = await detailCss();
  assert.match(css, /\.detail-view__action--start \{\s*margin-inline-end: auto;/, 'Löschen muss am Anfang stehen, auch in RTL');
  // Der Kalender nimmt die Option; sein Löschen bleibt zurückgenommen.
  const cal = await calendarJs();
  const detail = cal.slice(cal.indexOf('async function openEventDetail('), cal.indexOf('async function loadReminderForEvent('));
  assert.match(detail, /primary: true,/, 'der Termin-Sheet setzt Bearbeiten nicht als Hauptaktion');
  assert.match(detail, /id: 'detail-delete',[\s\S]{0,80}variant: 'danger-ghost',[\s\S]{0,40}align: 'start'/,
    'Löschen bleibt destruktiv gestylt und am Anfang, nicht an der Primärposition');
});

test('im Popover gilt dieselbe Ordnung wie im Sheet: Löschen am Anfang, Bearbeiten primär am Ende (Re-Kritik 2026-09-25)', async () => {
  const src = await detailJs();
  const popover = src.slice(src.indexOf('function openAsPopover'), src.indexOf('const footer = detailFooterEl(actions)'));
  // Mit edit.primary kommt Bearbeiten NACH den Aktionen des Aufrufers - sonst
  // steht Löschen direkt daneben und sein `--start` wirkt nicht, weil es nicht
  // mehr das erste Element ist.
  assert.match(popover, /opts\.edit\?\.primary\s*\?\s*\[\.\.\.\(opts\.actions \?\? \[\]\), edit\]/,
    'mit edit.primary gehört Bearbeiten ans Ende der Popover-Fußzeile');
  assert.match(popover, /opts\.edit\.primary \? \{ variant: 'primary'/,
    'mit edit.primary ist Bearbeiten auch im Popover der Primärknopf');
  // Ohne die Option bleibt alles wie bisher (Kontakte, Inventar, Budget ...).
  assert.match(popover, /:\s*\[edit, \.\.\.\(opts\.actions \?\? \[\]\)\]/,
    'ohne edit.primary steht Bearbeiten weiter vorne');
  assert.match(popover, /: \{ variant: 'secondary' \}/, 'ohne edit.primary bleibt Bearbeiten sekundär');
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
  // Der Fokus kehrt zum Auslöser zurück - über den Merker der Modal-Schicht, damit
  // er auch nach einem Neuaufbau wiedergefunden wird (#1083).
  assert.match(popover, /merker: rememberFocus\(opts\.anchor\)/, 'der Auslöser wird beim Öffnen gemerkt');
  assert.match(popover, /restoreFocusAfterClose\(merker\)/, 'und beim Schließen zurückgegeben');
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
  // Seit R10 (L5) mit der Detailspalte der Agenda als drittem Ort - derselbe Einstieg.
  assert.match(src, /async function openEventDetail\(ev, anchor = null, \{ pane = null \} = \{\}\)/, 'ein einziger Einstieg');
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
  // Seit R18 stehen WANN und WER im Kopf (eventDetailHead); die geteilte Zeile
  // bleibt fuer den frei eingetragenen Namen ohne Konto.
  assert.match(fn, /ev\.assigned_users\?\.length \? null : assignedRow\(\[\], t\('calendar\.assignedLabel'\), ev\.assigned_name \|\| ''\)/,
    'ein freier Name ohne Konto bleibt eine Zeile');
  assert.doesNotMatch(fn, /calendar\.detailWhen/, 'die Wann-Zeile ist in den Kopf gewandert');
  const head = src.slice(src.indexOf('function eventDetailHead'), src.indexOf('function eventMapUrl'));
  assert.match(head, /dot: resolveEventBackground\(ev\)/, 'Farbpunkt statt Farbstreifen');
  assert.match(head, /subtitle: eventWhenRelative\(ev\)/, 'die Zeit in Worten');
  assert.match(head, /subtitleLabel: t\('calendar\.detailWhen'\)/, 'Screenreader hoeren weiter "Wann"');
  assert.match(head, /people: ev\.assigned_users \?\? \[\]/, 'Personen als Avatare');
  const open = src.slice(src.indexOf('async function openEventDetail'));
  assert.match(open, /head: eventDetailHead\(ev\),/);
  assert.doesNotMatch(open.slice(0, open.indexOf('sections: renderEventDetail')), /accentColor:/, 'kein frei stehender Farbstreifen mehr');
});

test('der Ort öffnet sich als ausdrückliche Aktion in einer Karte, nicht als Link auf dem Text (#1110)', async () => {
  const src = await calendarJs();
  const fn = src.slice(src.indexOf('function mapRowAction'), src.indexOf('function renderEventDetail'));
  // Die Aktion hängt an der Karten-URL, und die entsteht nur aus einem Ortstext,
  // der nach fmtLocation etwas übrig lässt. Kodierung und Leerfall misst
  // test:calendar, das Aufräumen der Test gleich darunter.
  assert.match(fn, /const mapUrl = eventMapUrl\(ev\.location\);\s*if \(!mapUrl\) return null;/,
    'nur mit Ort gibt es die Aktion');
  assert.match(fn, /id: 'detail-open-map'/);
  assert.match(fn, /label: t\('calendar\.openInMap'\)/);
  assert.match(fn, /window\.open\(mapUrl, '_blank', 'noopener'\)/,
    'neuer Tab ohne Zugriff zurück auf die App - wie der vCard-Export in Kontakte');

  // R10 L6 (A2 P3): die Aktion ist Folgeaktion der Ort-Zeile, nicht dritte
  // Fusszeilen-Aktion - der Fuss blieb sonst dreireihig. Der Wert bleibt
  // reiner Text: Freitext wie "Zoom" ist keine Adresse.
  const detail = src.slice(src.indexOf('function renderEventDetail'), src.indexOf('async function openEventDetail'));
  assert.match(detail, /\{ icon: 'map-pin', label: t\('calendar\.locationLabel'\), value: ev\.location \? fmtLocation\(ev\.location\) : '', action: mapRowAction\(ev\) \}/);
  const open = src.slice(src.indexOf('async function openEventDetail'), src.indexOf('async function loadReminderForEvent'));
  assert.doesNotMatch(open, /detail-open-map|eventMapUrl\(/, 'die Karte steht nicht mehr in der Fusszeile');

  // Die geteilte Zeile kennt die Folgeaktion: ein Knopf (keine Verlinkung des Werts).
  const dv = await detailJs();
  const row = dv.slice(dv.indexOf('export function detailRowEl'), dv.indexOf('function visibilityRow') > 0 ? dv.indexOf('function visibilityRow') : undefined);
  assert.match(row, /action && typeof action\.onClick === 'function'/);
  assert.match(row, /btn\.className = 'btn btn--ghost btn--sm detail-row__action'/);
});

test('die Kartensuche räumt den Ortstext über das ECHTE fmtLocation auf (#1110)', async () => {
  // test:calendar läuft mit dem Browser-Loader, und der ersetzt `/utils/html.js`
  // durch einen Stub mit `fmtLocation = Identität`. Was das Aufräumen braucht,
  // lässt sich dort nicht messen - hier ohne Loader, gegen die echte Funktion.
  const { fmtLocation } = await import('../public/utils/html.js');
  assert.equal(fmtLocation('Rathaus\\nMarktplatz 1\\, 12345 Musterstadt'), 'Rathaus, Marktplatz 1, 12345 Musterstadt',
    'eine ICS-escapte, mehrzeilige Adresse wird EINE Suchzeile');
  assert.equal(fmtLocation('\\n'), '', 'nur ein escapter Umbruch: nichts zu suchen, also keine Aktion');
  assert.equal(fmtLocation(' , ; '), '', 'nur Trenner: ebenso');

  // Und eventMapUrl benutzt genau diese Funktion, bevor es kodiert.
  const src = await calendarJs();
  const fn = src.slice(src.indexOf('function eventMapUrl'), src.indexOf('function renderEventDetail'));
  assert.match(fn, /const query = fmtLocation\(location \?\? ''\)\.trim\(\);/);
  assert.match(fn, /return query \? `https:\/\/www\.openstreetmap\.org\/search\?query=\$\{encodeURIComponent\(query\)\}` : '';/);
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

test('jeder Weg zu einer bestehenden Aufgabe führt in die Detailansicht', async () => {
  const src = await tasksJs();
  // Die Ansicht selbst wohnt seit #918 in der geteilten Komponente, damit die
  // Übersicht und der Kalender dieselbe öffnen können statt einer kleineren.
  assert.match(await taskDetailJs(), /export function openTaskDetail\(\{/);

  // Nur Aufrufe zählen, nicht die Definition darüber.
  // Die Zahl steht hier als BUCHFÜHRUNG, nicht als Obergrenze: ein neuer
  // Einstieg soll diesen Test rot machen, damit jemand entscheidet, wohin er
  // führt. Beim Verlauf (#791) hat er genau das getan.
  //
  // Liste + Detail (2026-09-26): Listenzeile, Stift und Deep-Link laufen unter
  // der Schwelle ueber EINEN Weg (`openTaskSheet`, zugleich `openNarrow` des
  // Bausteins); ab der Schwelle zeichnet `renderTaskPane` dieselbe Ansicht in
  // die Detailspalte - mit `{ pane }`, also nicht als Sheet.
  //
  // Verlauf in Liste + Detail (#1550): ein Verlaufseintrag hat keinen eigenen
  // Aufruf mehr, er geht durch denselben Baustein (`openHistoryEntry` ->
  // `taskMd.open`, darunter `openTaskSheet`) - daher einer weniger.
  const detailCalls = [...src.matchAll(/^\s+openTaskView\(task, reminder, container\);$/gm)];
  assert.equal(detailCalls.length, 3, 'Kanban, Wischen und openTaskSheet (Listenzeile/Stift/Deep-Link/Verlauf)');
  assert.match(src, /function openHistoryEntry\(id, trigger, container\) \{\n  if \(taskMd\) taskMd\.open\(id, trigger\);\n  else openTaskSheet\(id, container\);/,
    'der Verlauf fuehrt ueber den Baustein bzw. openTaskSheet in dieselbe Ansicht');
  assert.match(src, /openTaskView\(task, reminder, container, \{ pane: body \}\)/,
    'die Detailspalte zeigt dieselbe Leseansicht, nicht eine eigene');

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
  assert.match(src, /function wireTaskForm\(panel, \{ task = null, container = null, onChanged = \(\) => loadTasks\(container\) \}\)/);

  // modalTags ist ein Working-Set, das renderTagChips direkt nach dem Rendern
  // liest - es muss VOR renderModalContent gesetzt werden. Der Mount-Block
  // steht seit #918 in dieser Datei und nicht mehr in der Ansicht: das Formular
  // gehört dem Modul, die Leseansicht bekommt es gereicht.
  const mountStart = src.indexOf('mount: (panel, pane) =>');
  const mount = src.slice(mountStart, src.indexOf('wireTaskForm(panel, { task, container });', mountStart));
  assert.ok(mount.length > 0, 'der Mount-Block muss auffindbar sein');
  const tags = mount.indexOf('modalTags =');
  const render = mount.indexOf('renderModalContent(');
  assert.ok(tags > -1 && render > -1 && tags < render, 'modalTags wird vor dem Rendern gesetzt');
});


test('die Leseansicht ist nicht an ihr Modul genagelt (#918)', async () => {
  const detail = await taskDetailJs();
  // Was nur eine Ansicht wissen kann, kommt im Aufruf und nicht aus einem
  // Seiten-State: sonst kann sie nur oeffnen, wer diesen State haelt - und
  // genau deshalb bot die Uebersicht ein eigenes Kaertchen mit zwei Knoepfen an.
  assert.doesNotMatch(detail, /\bstate\.\w/, 'die Komponente liest keinen fremden Seiten-State');
  assert.doesNotMatch(detail, /loadTasks\(/, 'sie laedt keine fremde Liste nach');
  for (const field of ['users', 'currentUserId', 'isAdmin', 'categories', 'onChanged']) {
    assert.match(detail, new RegExp('\\b' + reLiteral(field) + '\\b'), field + ' kommt ueber den Aufruf');
  }

  // Und die zwei Ansichten, die vorher eine kleinere Fassung bauten oder
  // wegnavigierten, oeffnen jetzt genau diese.
  const dash = await dashboardJs();
  assert.match(dash, /openTaskById\(taskId, \{ user, container, onChanged: rerender \}\)/,
    'die Uebersicht oeffnet die geteilte Ansicht');
  assert.doesNotMatch(dash, /openTaskQuickAction/,
    'das Zwei-Knopf-Kaertchen ist ersetzt, nicht daneben stehen geblieben');

  // DER BETRACHTER REIST MIT. Ohne ihn faellt `mine` bei jedem Kommentar auf
  // false und eine gesperrte Aufgabe (#830) sieht fuer ihre eigene Autorin
  // gesperrt aus: die Ansicht boete weniger an, als erlaubt ist, und zwar
  // still. Er kommt aus dem Router-Argument der Seite, nicht aus einem Global.
  assert.match(await taskDetailJs(), /currentUserId,\s*isAdmin,/,
    'die Komponente nimmt den Betrachter entgegen');

  const cal = await calendarJs();
  assert.match(cal, /user: state\.user,/, 'der Kalender reicht den Betrachter durch');
  assert.doesNotMatch(cal, /navigate\(`\/tasks\?open=/,
    'ein Aufgaben-Chip wirft den Nutzer nicht mehr aus dem Kalender');
  assert.match(cal, /openTaskFromCalendar\(taskChip\.dataset\.taskId\)/,
    'er oeffnet die Aufgabe an Ort und Stelle');
});

test('der Kontext erreicht JEDEN Knoten der Leseansicht (#918)', async () => {
  const detail = await taskDetailJs();
  // Ein einziger vergessener Durchgriff reicht: `commentRowNode` liest
  // `ctx.currentUserId` in seiner ersten Zeile, und der Abbrechen-Weg des
  // Kommentar-Editors baute die Zeile ohne ctx neu. Der Kommentar blieb dann
  // im Bearbeiten-Zustand stecken - ein TypeError, den keine Route sieht.
  const calls = detail.match(/commentRowNode\(comment,\s*\{[^}]*\}/g) ?? [];
  assert.ok(calls.length >= 2, 'beide Aufrufer von commentRowNode muessen auffindbar sein');
  for (const call of calls) {
    assert.match(call, /\bctx\b/, `commentRowNode ohne Kontext: ${call}`);
  }
  for (const fn of ['commentTextNode', 'wireMentionSuggest', 'subtaskListNode', 'commentsNode']) {
    for (const call of detail.match(new RegExp(reLiteral(fn) + '\\([^)]*\\)', 'g')) ?? []) {
      if (call.startsWith(fn + '(function') || /^\w+\(\s*\w+\s*,\s*ctx\s*\)$/.test(call)) continue;
      assert.match(call, /\bctx\b/, `${fn} ohne Kontext: ${call}`);
    }
  }
});

test('der Rueckgaengig-Streifen blendet JEDE Darstellung der Aufgabe aus (#918)', async () => {
  const detail = await taskDetailJs();
  const fn = detail.slice(detail.indexOf('function taskRowsIn('),
                          detail.indexOf('export async function deleteTaskWithUndo('));
  assert.ok(fn.length > 0, 'taskRowsIn ist nicht mehr auffindbar');

  // DIE UEBERSICHT NENNT IHR OBJEKT ANDERS. Eine Cockpit-Zeile kann jedes
  // Modul meinen und traegt `data-object-kind`/`data-object-id`; ein Selektor
  // nur auf `data-task-id` findet dort nichts, und der Streifen sagte fuenf
  // Sekunden lang „geloescht", waehrend die Zeile klickbar stehen blieb.
  assert.match(fn, /data-task-id=/, 'die Listen-Schreibweise');
  assert.match(fn, /data-object-kind="task"/, 'die Uebersicht-Schreibweise');
  assert.match(fn, /querySelectorAll/,
    'dieselbe Aufgabe kann zugleich im Cockpit und im Dringend-Widget stehen');

  // Und die Uebersicht muss diese Namen wirklich vergeben - sonst liefe der
  // Guard ueber eine leere Menge.
  const dash = await dashboardJs();
  assert.match(dash, /data-object-kind="\$\{esc\(row\.kind\)\}" data-object-id=/,
    'die Cockpit-Zeile benennt ihr Objekt');
  assert.match(dash, /class="task-item" data-task-id=/, 'die Widget-Zeile nennt ihre Aufgabe');
});

test('wer die Aufgabe von aussen oeffnet, bekommt ihr Blatt (#918)', async () => {
  // DER ROUTER HAELT GENAU EIN SEITEN-BLATT (loadPageStyle in router.js). Auf
  // der Uebersicht ist das dashboard.css, im Kalender calendar.css - tasks.css
  // ist dort NICHT geladen, und von dort kommt das Aussehen der Leseansicht
  // UND des Formulars. Gemessen ohne dieses Blatt: ein Etikett mit
  // `border-radius: 0px` statt `9999px`, eine Autorenzeile mit Gewicht 400.
  const src = await tasksJs();
  assert.match(src, /function ensureTaskStyles\(\)/, 'der Einstieg von aussen stellt das Blatt sicher');
  const fn = src.slice(src.indexOf('function ensureTaskStyles()'),
                       src.indexOf('export async function openTaskById('));
  assert.match(fn, /link\.onload/, 'und WARTET darauf - sonst steht der Inhalt einmal roh da');
  assert.match(fn, /link\.onerror/, 'ein fehlendes Blatt darf die Aufgabe nicht verschlucken');
  assert.match(src, /ensureTaskStyles\(\),/,
    'der Aufruf haengt im selben await wie das Laden der Aufgabe');

  // Und die Gegenprobe zur Regel: die Klassen, die Ansicht und Formular
  // vergeben, muessen wirklich aus einem Blatt kommen, das sonst fehlte -
  // sonst liefe der Guard ueber eine leere Menge und sicherte nichts.
  const { eachRule } = await import('./css-rules.js');
  const selektoren = [...eachRule(await read('public/styles/tasks.css'))]
    .map((r) => r.selector).join('\n');
  const detail = await taskDetailJs();
  const klassen = new Set();
  for (const m of detail.matchAll(/className = '([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c) klassen.add(c);
  }
  assert.ok(klassen.size >= 15,
    `nur ${klassen.size} Klassen gefunden - das Muster passt nicht mehr auf die Komponente`);
  // UEBER DIE SELEKTOREN, nicht ueber den Dateitext: eine Klasse, die nur in
  // einem KOMMENTAR steht, ist keine Regel. Genau daran war die erste Fassung
  // dieses Guards blind und liess `.priority-badge` durch.
  const ausTasksCss = [...klassen].filter((c) =>
    new RegExp('\\.' + reLiteral(c) + '(?![\\w-])').test(selektoren));
  assert.ok(ausTasksCss.length >= 5,
    'die Leseansicht bezieht kaum noch etwas aus tasks.css - dann sichert dieser Guard nichts: '
    + ausTasksCss.join(', '));
});
test('derselbe Loeschbefehl verhaelt sich auf beiden Wegen gleich (#918)', async () => {
  const src = await tasksJs();
  // Der Container hat ZWEI Zwecke: eine Liste nachladen (die die Uebersicht
  // nicht hat) und die Zeile beim Loeschen ausblenden (die sie sehr wohl hat).
  // Wurde er wegen des ersten auf null gesetzt, fiel das zweite mit weg, und
  // Loeschen ueber das Formular liess die Zeile den ganzen Streifen lang stehen.
  const block = src.slice(src.indexOf('export async function openTaskById('));
  assert.match(block, /wireTaskForm\(panel, \{ task, container, onChanged \}\)/,
    'das von aussen gemountete Formular bekommt seinen Container');
  assert.doesNotMatch(block, /container: null/,
    'ein genullter Container nimmt dem Loeschen sein optimistisches Ausblenden');
});

test('ohne Auswahl wird kein Bearbeiten angeboten (#918)', async () => {
  const src = await tasksJs();
  const block = src.slice(src.indexOf('export async function openTaskById('));
  // Scheitert /tasks/meta/options, ist die Kategorienliste leer. Ein Formular
  // darauf schickte eine leere Kategorie an einen Server, der sie ablehnt -
  // nachdem wartende Datei-Uploads schon durch sind.
  assert.match(block, /const canOfferEdit = state\.categories\.length > 0/,
    'die Bedingung fuer ein brauchbares Formular ist benannt');
  assert.match(block, /edit: !canOfferEdit \? null :/,
    'ohne sie faellt der Bearbeiten-Knopf weg statt in einen Fehler zu fuehren');
});
test('der Status lässt sich aus der Detailansicht weiterschalten', async () => {
  const src = await taskDetailJs();
  // WELCHE Knoepfe bei welchem Status herauskommen, misst test:task-detail-finish
  // am laufenden Aufruf - ein Guard ueber den Quelltext sieht eine Zuordnung,
  // die dasteht, nicht eine, die auch greift. Hier bleibt, was daneben steht:
  // dass es die Zuordnung ueberhaupt gibt, dass Abgelegtes nicht darin vorkommt,
  // und dass der Schreibweg dahinter seinen Fehler zurueckrollt und meldet.
  assert.match(src, /const STATUS_ACTIONS = \{/, 'die Statusziele sind an einer Stelle benannt');
  assert.match(src, /status: 'in_progress'/, 'das Starten ist eines davon');
  assert.match(src, /status: 'done'/, 'das Erledigen ebenso');
  assert.match(src, /status: 'open'/, 'und das Zuruecknehmen');
  assert.doesNotMatch(src, /archived:\s*\[/, 'archivierte Aufgaben werden nicht weitergeschaltet');

  const fn = src.slice(src.indexOf('async function advanceTaskStatus'));
  assert.match(fn, /api\.patch\(`\/tasks\/\$\{task\.id\}\/status`/, 'nutzt die bestehende Route');
  assert.match(fn, /task\.status = previous;/, 'rollt bei Fehler zurück');
  assert.match(fn, /showToast\(/, 'und meldet den Fehler');
});

test('die Aufgaben-Detailansicht führt die Leseinformationen der Karte', async () => {
  const src = await taskDetailJs();
  const fn = src.slice(src.indexOf('function renderTaskDetail'), src.indexOf('export function openTaskDetail'));
  // Seit R18 stehen Faelligkeit und Personen im Kopf (taskDetailHead).
  for (const key of ['tasks.statusLabel', 'tasks.priorityLabel', 'tasks.startDateLabel',
    'tasks.categoryLabel', 'tasks.pointsLabel', 'tasks.tagsLabel',
    'tasks.subtasksLabel', 'tasks.documentsLabel', 'tasks.descriptionLabel']) {
    assert.match(fn, new RegExp(reLiteral(key)), `${key} fehlt in der Detailansicht`);
  }
  // Der Anker ab Erledigung reist als zweites Argument mit (#658), die Zeile
  // bleibt aber die geteilte - deshalb offen bis zur Klammer statt exakt.
  assert.match(fn, /recurrenceRow\(task\.recurrence_rule[),]/, 'Wiederholung über die geteilte Zeile');
  assert.match(fn, /visibilityRow\(task\.visibility\)/, 'Sichtbarkeit über die geteilte Zeile');
  const head = src.slice(src.indexOf('function taskDetailHead'), src.indexOf('function renderTaskDetail'));
  assert.match(head, /subtitle: due\?\.label \?\? ''/, 'die Faelligkeit in den Worten der Liste');
  assert.match(head, /subtitleLabel: t\('tasks\.dueDateLabel'\)/);
  assert.match(head, /people: task\.assigned_users \?\? \[\]/, 'Zugewiesene als Avatare im Kopf');
  assert.match(src, /head: taskDetailHead\(task\),/);
  // Erledigen ist die Hauptaktion: der EINE Primaerknopf im Fuss.
  const steps = src.slice(src.indexOf('const STATUS_ACTIONS = {'), src.indexOf('/** Prioritätsbadge'));
  assert.equal(steps.match(/id: 'task-detail-finish'[^}]*variant: 'primary'/g)?.length, 2, 'offen und in Arbeit');
  assert.equal(steps.match(/variant: 'primary'/g)?.length, 2, 'nur Erledigen ist primaer');
});

/* DETAILANSICHTEN MIT KOPF (Critique R18, 2026-10-07). Termin, Aufgabe und
 * Geburtstag oeffneten als Schluessel-Wert-Zeilen, Personen als Kommatext,
 * darueber eine frei stehende 2px-Farblinie. Gemessen wird der laufende
 * Renderer in einem kleinen Schein-DOM, nicht sein Quelltext. */
test('R18: der Kopf der Leseansicht - Unterzeile mit Farbpunkt, Kennzahlen, Personen als Avatare', async () => {
  const { register } = await import('node:module');
  register('./test-browser-loader.mjs', import.meta.url);
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.textContent = '';
      this.styles = {}; this.style = { setProperty: (k, v) => { this.styles[k] = v; } };
      this.classList = { add: (c) => { this.className = `${this.className} ${c}`.trim(); } };
      this.dataset = {};
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.children.push(c)); }
    find(cls) {
      if (String(this.className).split(/\s+/).includes(cls)) return this;
      for (const c of this.children) { const hit = c.find?.(cls); if (hit) return hit; }
      return null;
    }
    all(cls, out = []) {
      if (String(this.className).split(/\s+/).includes(cls)) out.push(this);
      for (const c of this.children) c.all?.(cls, out);
      return out;
    }
    get text() { return this.textContent + this.children.map((c) => c.text ?? '').join(''); }
  }
  const saved = {};
  for (const k of ['document', 'HTMLElement']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  Object.assign(globalThis, { document: { createElement: (tag) => new El(tag) }, HTMLElement: El });
  try {
    const { detailHeadEl } = await import('../public/components/detail-view.js');
    assert.equal(detailHeadEl(undefined), null);
    assert.equal(detailHeadEl({ dot: '#00668F', subtitle: '  ', people: [], facts: [''] }), null, 'ohne einen Teil entsteht kein Kopf - auch kein Punkt allein');

    // Termin: Farbpunkt, Zeit in Worten (Screenreadern beim Namen genannt), Personen.
    const termin = detailHeadEl({
      dot: '#00668F', subtitle: 'Heute, 20:00 - 22:00', subtitleLabel: 'Wann',
      people: [{ display_name: 'Emma <b>Johnson</b>', color: '#CE2A63' }, { display_name: 'Leo', avatar_data: 'data:image/png;base64,AA' }, { color: '#000000' }],
      peopleLabel: 'Zugewiesen',
    });
    assert.equal(termin.className, 'detail-head');
    const line = termin.find('detail-head__subtitle');
    assert.equal(line.find('detail-head__dot').styles['--detail-accent'], '#00668F', 'der Punkt traegt die Kalenderfarbe');
    assert.equal(line.find('detail-head__dot').attrs['aria-hidden'], 'true');
    assert.equal(line.text, 'Wann: Heute, 20:00 - 22:00');
    assert.equal(line.find('sr-only').textContent, 'Wann: ', 'das Label ist nur fuer Screenreader');
    const people = termin.find('detail-head__people');
    assert.equal(people.tagName, 'UL');
    assert.equal(people.attrs['aria-label'], 'Zugewiesen');
    const persons = people.all('detail-head__person');
    assert.equal(persons.length, 2, 'eine Person ohne Namen steht nicht da');
    assert.equal(persons[0].find('detail-head__name').textContent, 'Emma <b>Johnson</b>', 'der Name ist Text, kein Markup');
    const scheibe = persons[0].find('detail-head__avatar');
    assert.equal(scheibe.attrs['aria-hidden'], 'true', 'die Scheibe ist Schmuck neben dem Namen');
    assert.equal(scheibe.styles['background-color'], '#CE2A63', 'Identitaetsfarbe der Person');
    assert.ok(scheibe.styles.color, 'mit lesbarer Tinte darauf');
    assert.match(scheibe.textContent, /^E/, 'Initialen');
    const bild = persons[1].find('detail-head__avatar').children[0];
    assert.equal(bild.tagName, 'IMG');
    assert.equal(bild.alt, '', 'das Bild wiederholt den Namen nicht');

    // Geburtstag: Bild gross, hoechstens zwei Kennzahlen.
    const media = new El('div');
    const geburtstag = detailHeadEl({ media, facts: ['wird 41', '', 'in 26 Tagen', 'zu viel'] });
    assert.equal(geburtstag.className, 'detail-head detail-head--media');
    assert.equal(geburtstag.find('detail-head__media').children[0], media);
    assert.deepEqual(geburtstag.all('detail-head__fact').map((f) => f.textContent), ['wird 41', 'in 26 Tagen']);
    assert.equal(geburtstag.find('detail-head__subtitle'), null);
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }

  // Der Koerper: mit Farbpunkt im Kopf entfaellt der Farbstreifen; der Kopf steht vor den Zeilen.
  const src = await detailJs();
  const bodyFn = src.slice(src.indexOf('function detailBodyEl('), src.indexOf('function detailGroupEl('));
  assert.match(bodyFn, /const headEl = detailHeadEl\(head\);\s*if \(headEl\) view\.appendChild\(headEl\);/);
  assert.match(bodyFn, /if \(accentColor && !\(headEl && head\.dot\)\)/, 'dieselbe Farbe stuende sonst zweimal da');
  assert.ok(bodyFn.indexOf('detailHeadEl(head)') < bodyFn.indexOf("rows.className = 'detail-view__rows'"));
  // Popover, Blatt und Spalte tragen den Titel in Title 3.
  const typo = await read('public/styles/typography.css');
  const { eachRule } = await import('./css-rules.js');
  const role = [...eachRule(typo)].filter((r) => r.selector.split(',').some((s) => s.trim() === '.detail-popover__title'));
  assert.equal(role.length, 1, 'das Popover hat genau EINE Rolle in der Rollenschicht');
  assert.match(role[0].body, /font-size:\s*var\(--type-section-title\)/, 'derselbe Termin trug im Popover 17px und im Blatt 20px');
  assert.doesNotMatch(await detailCss(), /\.detail-popover__title \{[^}]*font-size/, 'die Groesse steht in der Rollenschicht, nicht am Bauteil');
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
  // Den Deep-Link loest seit R4 der Liste-+-Detail-Baustein ein (EIN Leser fuer
  // `?open=`): in der Spalte waehlt er aus, darunter ruft er `openNarrow` - und
  // der ist derselbe Weg wie das Antippen, also die Leseansicht.
  const mount = src.slice(src.indexOf('mountMasterDetail({'));
  const opts = mount.slice(0, mount.indexOf('\n    });'));
  assert.match(opts, /deepLinkNarrow:\s*true/, 'Deep-Link ?open=<id> auch unter der Schwelle');
  assert.match(opts, /openNarrow:\s*\(id\)\s*=>\s*openContactById\(id\)/, 'Deep-Link ?open=<id> in die Leseansicht');

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
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '') // Kommentare erklären Werte, sie setzen keine
    // Eine Bruchstelle kann kein Token sein (var() gilt in @media nicht); seit
    // R14 traegt die Datei die mobile Fussregel der Aufgaben-Detailansicht.
    // Geprueft werden die Deklarationen, nicht die Praeambel.
    .replace(/@media[^{]*\{/g, '@media {');
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

/**
 * DER KLICK NEBEN DAS POPOVER SCHLIESST NUR (Re-Kritik 2026-09-28, P1).
 *
 * Im Kalender lief der Klick, der die Leseansicht schloss, weiter zur leeren
 * Wochenspalte darunter - und die oeffnete "Neuer Termin". Die Regel gilt fuer
 * JEDES Popover der Leseansicht, nicht nur im Kalender, also wird sie hier am
 * laufenden openDetailView() gemessen und nicht am Quelltext: das echte Modul,
 * ein Klick, der den Ablauf des Browsers nachgeht (Capture am Dokument, dann
 * das Ziel, dann Bubbling zurueck zum Dokument), und ein Seiten-Handler am
 * Ziel, der mitzaehlt. Der Loader leitet nur i18n und modal.js auf Stubs um;
 * detail-view.js und overlay-history.js laufen wie im Browser.
 */
test('Klick neben das Popover schliesst es und loest darunter nichts aus', async () => {
  const { register } = await import('node:module');
  register('./test-browser-loader.mjs', import.meta.url);

  const saved = {};
  for (const k of ['window', 'document', 'history', 'location', 'matchMedia', 'HTMLElement']) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }

  // Ein Dokument mit echter Ereignisreihenfolge: Capture-Listener am Dokument,
  // Listener am Ziel, Bubble-Listener am Dokument - mit stopPropagation und
  // stopImmediatePropagation wie im DOM. Mehr braucht das Popover nicht.
  const docListeners = [];
  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parent = null;
      this.attrs = {};
      this.dataset = {};
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
      this.listeners = [];
      this.className = '';
      this.id = '';
      this.textContent = '';
    }
    get isConnected() {
      let n = this;
      while (n.parent) n = n.parent;
      return n === body;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    // R18: das geschlossene Popover gibt seine Kennung sofort frei (leavePopover).
    removeAttribute(k) { delete this.attrs[k]; if (k === 'id') this.id = ''; }
    appendChild(c) { if (c && typeof c === 'object') c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    replaceChild(next, prev) { const i = this.children.indexOf(prev); this.children[i] = next; next.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    contains(n) { for (let c = n; c; c = c.parent) if (c === this) return true; return false; }
    closest(sel) {
      for (let c = this; c; c = c.parent) {
        if (sel.split(',').some((s) => {
          const t = s.trim();
          if (t.startsWith('.')) return String(c.className).split(/\s+/).includes(t.slice(1));
          const m = t.match(/^\[role="(.+)"\]$/);
          return m ? c.attrs?.role === m[1] : false;
        })) return c;
      }
      return null;
    }
    addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => l.fn !== fn); }
    querySelectorAll() { return []; }
    focus() {}
    getBoundingClientRect() { return { top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20 }; }
  }
  const body = new FakeEl('body');
  const doc = {
    body,
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    activeElement: null,
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, fn, opts) {
      const capture = opts === true || Boolean(opts?.capture);
      docListeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || Boolean(opts?.capture);
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i !== -1) docListeners.splice(i, 1);
    },
  };

  function click(target) {
    const ev = {
      type: 'click', target, isTrusted: true, defaultPrevented: false,
      stopped: false, stoppedNow: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.stoppedNow = true; },
    };
    const run = (list) => {
      for (const l of [...list]) {
        if (ev.stoppedNow) return;
        l.fn(ev);
      }
    };
    run(docListeners.filter((l) => l.type === 'click' && l.capture));
    if (!ev.stopped) run(target.listeners.filter((l) => l.type === 'click'));
    if (!ev.stopped) run(docListeners.filter((l) => l.type === 'click' && !l.capture));
    return ev;
  }

  Object.assign(globalThis, {
    window: { innerWidth: 1440, lucide: undefined },
    document: doc,
    history: { state: null, pushState() {}, back() {} },
    location: { href: 'http://localhost/calendar' },
    matchMedia: () => ({ matches: false }),
    HTMLElement: FakeEl,
  });

  try {
    const { openDetailView } = await import('../public/components/detail-view.js');

    // Die leere Wochenspalte: ihr Klick-Handler legt einen Termin an.
    const column = new FakeEl('div');
    body.appendChild(column);
    let angelegt = 0;
    column.addEventListener('click', () => { angelegt += 1; });
    const anchor = new FakeEl('button');
    column.appendChild(anchor);

    const view = openDetailView({ title: 'Emmas Geburtstagsfeier', anchor, sections: [] });
    assert.ok(body.children.some((c) => c.id === 'detail-view-popover'), 'die Weiche hat ein Popover gebaut');
    // Der Listener bindet erst im naechsten Tick (sonst schloesse der oeffnende Klick).
    await new Promise((r) => setTimeout(r, 0));

    const outside = docListeners.find((l) => l.type === 'click');
    assert.ok(outside, 'das Popover hoert auf Klicks daneben');
    assert.equal(outside.capture, true,
      'der Klick daneben muss VOR den Handlern der Seite ankommen (Capture), sonst hat die Spalte schon angelegt');

    const erster = click(column);
    assert.equal(view.isOpen(), false, 'der Klick daneben schliesst das Popover');
    assert.equal(angelegt, 0, 'der Klick, der das Popover schliesst, darf darunter nichts anlegen');
    assert.equal(erster.defaultPrevented, true, 'auch die Standardaktion (ein Link darunter) bleibt aus');
    assert.equal(docListeners.filter((l) => l.type === 'click').length, 0, 'der Listener ist mit dem Popover weg');

    click(column);
    assert.equal(angelegt, 1, 'der ZWEITE Klick legt wie gewohnt an');

    // Gegenfall: ein Knopf in einer anderen Ebene (Rueckfrage ueber dem Popover)
    // muss tun, was er sagt - er schliesst das Popover, wird aber nicht geschluckt.
    const view2 = openDetailView({ title: 'Termin', anchor, sections: [] });
    await new Promise((r) => setTimeout(r, 0));
    const overlay = new FakeEl('div');
    overlay.className = 'modal-overlay';
    body.appendChild(overlay);
    const confirmBtn = new FakeEl('button');
    overlay.appendChild(confirmBtn);
    let bestaetigt = 0;
    confirmBtn.addEventListener('click', () => { bestaetigt += 1; });
    click(confirmBtn);
    assert.equal(bestaetigt, 1, 'ein Knopf in einem Dialog ueber dem Popover bleibt bedienbar');
    assert.equal(view2.isOpen(), false);
    // Das Overlay-Register gleicht die History im Microtask ab - erst danach
    // duerfen die Attrappen weg, sonst stolpert es nach dem Test ins Leere.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
});
