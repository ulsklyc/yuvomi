/**
 * Modul: Einstellungen (Settings) — Schutz vor stillem Verwerfen
 * Zweck: Ein Klick in die Seitenleiste tauschte das Blatt sofort aus; halb
 *        ausgefüllte Formulare waren wortlos weg (Critique 2026-07-27). Der
 *        Guard merkt sich, in welchen Formularen der Nutzer gearbeitet hat, und
 *        fragt nach, bevor dieser Stand verloren geht.
 * Abhängigkeiten: /i18n.js, /components/modal.js, /utils/leave-guard.js
 *
 * JEDER WEG FRAGT, NICHT NUR DIE SEITENLEISTE (Re-Critique 2026-09-28 R15,
 * A7 P1-1). Gefragt wurde bisher nur in den Links der Shell; Zurueck, die
 * Befehlspalette, die Tab-Leiste und das Mehr-Blatt liefen am Guard vorbei
 * in `navigate()` - und warfen den offenen Stand wortlos weg. Jetzt meldet
 * sich der Guard beim Verlassen-Schutz des Routers an (utils/leave-guard.js),
 * SOLANGE etwas offen ist, und nur so lange: ohne offenen Stand bleibt die
 * Navigation ohne await (siehe hasLeaveGuard im Router). Die Rueckfrage ist
 * dieselbe wie die des Dialogs und des Anpassen-Modus (danger, "Verwerfen").
 *
 * ZWEI ARTEN VON OFFENEM STAND: Formulare mit eigenem Absenden (automatisch
 * erkannt) und Blaetter ohne Formular, die ihren Stand selbst kennen - die
 * Rechte-Matrix mit ihrem Speichern-Knopf (`trackLeafEdits`).
 */

import { t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import { setLeaveGuard } from '/utils/leave-guard.js';

// Formular-Referenzen statt eines Flags: so bleibt erkennbar, ob der offene
// Stand ueberhaupt noch im Dokument haengt.
const dirtyForms = new Set();
// Blaetter ohne Formular: Knoten -> "ist etwas offen?". Der Knoten sagt, ob
// die Quelle noch im Dokument steht; faellt er heraus, faellt sie mit.
const dirtySources = new Map();
let unloadBound = false;
let releaseLeaveGuard = null;

/**
 * Nur Formulare mit eigenem Absenden koennen ungespeicherte Aenderungen haben.
 * Die vielen Schalter und Auswahlfelder der Einstellungen schreiben sofort -
 * eine Rueckfrage waere dort schlicht falsch.
 */
function savableForm(target) {
  if (typeof target?.closest !== 'function') return null;
  // Ein Schalter, der sofort speichert, hinterlaesst keinen offenen Stand -
  // auch nicht, wenn er in einem Formular mit Speichern-Knopf steht
  // (Feiertage: die Ebenen schalten sofort, Land und Farben warten auf
  // "Speichern"). Markiert per `data-instant-save` am Eingabeelement.
  if (target.closest('[data-instant-save]')) return null;
  const form = target.closest('form');
  if (!form) return null;
  return form.querySelector('button[type="submit"], input[type="submit"]') ? form : null;
}

// Verlaesst der Nutzer die Einstellungen, verschwindet die Shell aus dem
// Dokument. Die Pruefung auf isConnected raeumt den Zustand damit von selbst
// ab, ohne dass es einen "Settings verlassen"-Haken braeuchte.
function hasOpenEdits() {
  for (const form of dirtyForms) {
    if (!form.isConnected) dirtyForms.delete(form);
  }
  let sourceOpen = false;
  for (const [node, isDirty] of dirtySources) {
    if (!node.isConnected) dirtySources.delete(node);
    else if (isDirty()) sourceOpen = true;
  }
  return dirtyForms.size > 0 || sourceOpen;
}

/**
 * Haelt die Anmeldung beim Router im Takt mit dem offenen Stand: angemeldet,
 * solange etwas offen ist, sonst abgemeldet. Blaetter mit eigener Quelle rufen
 * das nach jeder Aenderung ihres Stands (siehe trackLeafEdits).
 */
export function syncLeafEdits() {
  if (hasOpenEdits()) {
    if (!releaseLeaveGuard) {
      releaseLeaveGuard = setLeaveGuard(async () => {
        // Seit der Anmeldung gespeichert oder abgehaengt: nichts zu fragen.
        if (!hasOpenEdits()) {
          syncLeafEdits();
          return true;
        }
        return confirmLeafExit();
      });
    }
  } else if (releaseLeaveGuard) {
    releaseLeaveGuard();
    releaseLeaveGuard = null;
  }
}

/**
 * Ein Blatt ohne Formular meldet seinen offenen Stand selbst an (Rechte-Matrix).
 * @param {Node} node          Knoten des Blatts; faellt er aus dem Dokument, endet die Quelle
 * @param {() => boolean} isDirty
 * @returns {() => void} Abmeldung
 */
export function trackLeafEdits(node, isDirty) {
  dirtySources.set(node, isDirty);
  syncLeafEdits();
  return () => {
    if (dirtySources.get(node) === isDirty) dirtySources.delete(node);
    syncLeafEdits();
  };
}

function onBeforeUnload(event) {
  if (!hasOpenEdits()) return;
  event.preventDefault();
  event.returnValue = '';
}

/**
 * Bindet das Tracking an den Blatt-Container. Der Container ist pro Blatt neu,
 * die Listener verschwinden also mit ihm.
 */
export function watchLeafForms(container) {
  // Neues Blatt: offene Formulare des alten sind weg. Quellen NICHT leeren -
  // das Blatt hat seine eben beim Rendern angemeldet; abgehaengte faellt
  // hasOpenEdits() ueber isConnected heraus.
  dirtyForms.clear();
  syncLeafEdits();

  const mark = (event) => {
    // Nur echte Eingaben: programmatisch gesetzte Werte (Daten aus der API,
    // Re-Renders eines Blatts) duerfen nicht als Nutzerarbeit zaehlen.
    if (!event.isTrusted) return;
    const form = savableForm(event.target);
    if (form) {
      dirtyForms.add(form);
      syncLeafEdits();
    }
  };
  const release = (event) => {
    const form = event.target?.closest?.('form');
    if (form) {
      dirtyForms.delete(form);
      syncLeafEdits();
    }
  };

  container.addEventListener('input', mark, true);
  container.addEventListener('change', mark, true);
  container.addEventListener('submit', release, true);
  container.addEventListener('reset', release, true);

  if (!unloadBound) {
    window.addEventListener('beforeunload', onBeforeUnload);
    unloadBound = true;
  }
}

export function clearLeafEdits() {
  dirtyForms.clear();
  dirtySources.clear();
  syncLeafEdits();
}

/**
 * Die Rueckfrage vor dem Verlassen - der Router ruft sie ueber den
 * Verlassen-Schutz fuer jeden Weg. Liefert true, wenn weitergegangen werden
 * darf; nach "Verwerfen" ist nichts mehr offen.
 */
export async function confirmLeafExit() {
  if (!hasOpenEdits()) return true;
  const confirmed = await confirmModal(t('modal.unsavedChanges'), {
    // Wie der Dialog-Schutz (components/modal.js) und der Anpassen-Modus:
    // "Verwerfen" wirft Eingaben unwiderruflich weg, rot benennt das.
    danger: true,
    confirmLabel: t('modal.discardChanges'),
    // Eigener Folgentext: "in diesem Formular" stimmte fuer die Rechte-Matrix
    // nicht, und ein roter Dialog nennt seine Folgen ausgeschrieben.
    detail: t('settings.leaveDiscardDetail'),
  });
  if (confirmed) clearLeafEdits();
  return confirmed;
}
