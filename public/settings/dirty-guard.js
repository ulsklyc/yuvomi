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
 * OFFEN IST NUR EIN FORMULAR MIT EIGENEM ABSENDEN (automatisch erkannt). Bis
 * R24 kannte der Guard eine zweite Art - Blaetter ohne Formular, die ihren
 * Stand selbst anmelden (`trackLeafEdits`, fuer die Rechte-Matrix mit ihrem
 * Speichern-Knopf). Seit E11 speichert die Matrix jede Zeile sofort und hat
 * keinen Entwurf mehr; ohne Nutzer ist der Weg entfallen (R24 S12).
 */

import { t } from '/i18n.js';
import { confirmModal } from '/components/modal.js';
import { setLeaveGuard } from '/utils/leave-guard.js';

// Formular-Referenzen statt eines Flags: so bleibt erkennbar, ob der offene
// Stand ueberhaupt noch im Dokument haengt.
const dirtyForms = new Set();
// Das zuletzt abgeschickte Formular, dessen Speichern noch aussteht - siehe
// "ERST NACH DEM ERFOLG" in watchLeafForms.
let pendingForm = null;
// Das window, an dem die beiden Zuhoerer haengen. Im Browser gibt es nur eins;
// ein Test, der window austauscht, bekommt sie an seinem neu.
let boundTo = null;
let releaseLeaveGuard = null;

// Wie api.js ihn ausschreibt (WRITE_EVENT): der Test-Loader stubt api.js, ein
// Import der Konstante braeche jede Suite, die diesen Guard laedt.
const WRITE_EVENT = 'yuvomi:write';

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
  return dirtyForms.size > 0;
}

/**
 * Haelt die Anmeldung beim Router im Takt mit dem offenen Stand: angemeldet,
 * solange etwas offen ist, sonst abgemeldet.
 */
function syncLeafEdits() {
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

function onBeforeUnload(event) {
  if (!hasOpenEdits()) return;
  event.preventDefault();
  event.returnValue = '';
}

/**
 * Ein geglueckter Schreibvorgang (api.js meldet nur Erfolge) gibt das
 * abgeschickte Formular frei - es sei denn, es traegt noch einen Feldfehler:
 * dann hat sein Absenden nichts geschrieben, und der Erfolg gehoert einem
 * anderen Weg (ein Sofort-Schalter daneben).
 */
function onWriteSucceeded() {
  const form = pendingForm;
  pendingForm = null;
  if (!form || !dirtyForms.has(form)) return;
  if (typeof form.querySelector === 'function' && form.querySelector('[aria-invalid="true"]')) return;
  dirtyForms.delete(form);
  syncLeafEdits();
}

/**
 * Bindet das Tracking an den Blatt-Container. Der Container ist pro Blatt neu,
 * die Listener verschwinden also mit ihm.
 */
export function watchLeafForms(container) {
  // Neues Blatt: offene Formulare des alten sind weg.
  dirtyForms.clear();
  pendingForm = null;
  syncLeafEdits();

  const mark = (event) => {
    // Nur echte Eingaben: programmatisch gesetzte Werte (Daten aus der API,
    // Re-Renders eines Blatts) duerfen nicht als Nutzerarbeit zaehlen.
    if (!event.isTrusted) return;
    const form = savableForm(event.target);
    if (form) {
      dirtyForms.add(form);
      // Nach dem Absenden weitergetippt: das Neue ist mit keinem Speichern
      // unterwegs, ein spaeter eintreffender Erfolg gibt es nicht frei.
      if (form === pendingForm) pendingForm = null;
      syncLeafEdits();
    }
  };
  /* ERST NACH DEM ERFOLG (Critique R21, a5). Das Absenden gab das Formular
   * sofort frei - in der Capture-Phase, also BEVOR sein eigener Handler
   * pruefen oder speichern konnte. Scheiterte die Pruefung am Feld oder lehnte
   * der Server ab, galt das Blatt trotzdem als sauber: der naechste Wechsel
   * fragte nicht, und die Eingabe war weg. Jetzt merkt sich das Absenden nur,
   * welches Formular unterwegs ist; frei wird es mit dem naechsten
   * geglueckten Schreibvorgang (`yuvomi:write`, onWriteSucceeded), mit einem
   * `reset` oder wenn das Blatt es nach dem Speichern neu zeichnet
   * (isConnected). */
  const submitted = (event) => {
    const form = event.target?.closest?.('form');
    if (form && dirtyForms.has(form)) pendingForm = form;
  };
  const release = (event) => {
    const form = event.target?.closest?.('form');
    if (form) {
      dirtyForms.delete(form);
      if (form === pendingForm) pendingForm = null;
      syncLeafEdits();
    }
  };

  container.addEventListener('input', mark, true);
  container.addEventListener('change', mark, true);
  container.addEventListener('submit', submitted, true);
  container.addEventListener('reset', release, true);

  if (boundTo !== window) {
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener(WRITE_EVENT, onWriteSucceeded);
    boundTo = window;
  }
}

export function clearLeafEdits() {
  dirtyForms.clear();
  pendingForm = null;
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
    // Eigener Folgentext: ein roter Dialog nennt seine Folgen ausgeschrieben.
    detail: t('settings.leaveDiscardDetail'),
  });
  if (confirmed) clearLeafEdits();
  return confirmed;
}
