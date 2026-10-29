/**
 * Modul: Shared Modal-System
 * Zweck: Einheitliches Modal mit Focus-Trap, Escape-Handler, Overlay-Click,
 *        Focus-Restore, Scroll-Lock und aria-modal.
 *        Auf Mobile: Bottom Sheet mit Swipe-to-Close und Slide-out-Animation.
 * Abhängigkeiten: CSS-Klassen aus layout.css (.modal-overlay, .modal-panel, etc.)
 *                 i18n.js (t)
 *
 * API:
 *   openModal({ title, content, onSave, onDelete, onClose, size,
 *               initialFocus, headerAction, staged }) → void
 *               (`staged`: Buehne zuerst, Formular nach dem ersten Bild;
 *               `content` darf dann eine Funktion sein - siehe _canStage)
 *   closeModal({ force }) → Promise<void>
 *   confirmModal(message, opts) → Promise<boolean>       (ersetzt ein offenes Modal)
 *   confirmOverModal(message, opts) → Promise<boolean>   (parkt es und gibt es zurück)
 *   askOverModal(ask) → Promise<Antwort>                 (dasselbe für einen eigenen Dialog)
 *
 * Nachträglich gemountete Panes (Detailansicht → Formular, detail-view.js)
 *   mountFooter(panel)             → hebt eine neu gerenderte Fußzeile ans Panel
 *   decorateFooterDelete(footer)   → erkennt Löschen im Fuß (mobil Icon-Knopf)
 *   refreshDirtySnapshot()         → Dirty-Basis auf den jetzigen Stand setzen
 *   swapFieldsKeepingDirtyBase(panel, swap) → Felder im offenen Formular
 *                                    tauschen, ohne dass der Tausch als Eingabe zählt
 *   focusFirstField(panel)         → Fokus nach dem Pane-Wechsel, touch-bewusst
 *   updateHeaderAction(panel, …)   → Beschriftung/Handler des Kopf-Buttons tauschen
 */

import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { pushOverlay, dropOverlay, isOverlayOpen } from '/utils/overlay-history.js';
import { wireSheetDrag } from '/utils/sheet-drag.js';
import { iconElement } from '/utils/lucide-icons.js';
import { expandIn, durationToken, easingToken, isImeComposing } from '/utils/ux.js';
import { errorSentence } from '/utils/friendly-error.js';

let activeOverlay = null;
let previouslyFocused = null;
// Das Fokusziel des letzten Schliessens - `refocusAfterRender()` greift darauf
// zurueck, wenn die Seite erst nach einem `await` fertig gerendert hat.
let _lastRestore = null;
let focusTrapHandler = null;
// Die Dirty-Basis des offenen Formulars: `{ fields, entries }` - die Felder vom
// Snapshot und je Feld sein Eintrag (siehe _takeDirtyBase).
let _initialFormSnapshot = null;
// Dieselbe Basis, auffindbar ueber ihr Panel - auch waehrend das Formular unter
// einer Rueckfrage geparkt ist und `_initialFormSnapshot` dem Dialog darueber
// gehoert (swapFieldsKeepingDirtyBase).
const _dirtyBaseByPanel = new WeakMap();
let _initialFormTimeout = null;
let _modalFormSeq = 0;
// Monotone Kennung des zuletzt tatsaechlich eingesetzten Shared-Modals. Ein
// asynchroner Ablauf kann damit erkennen, dass inzwischen ein anderer Dialog
// den einzigen Slot besessen hat - auch wenn dieser schon wieder geschlossen
// wurde und im DOM deshalb keine Spur mehr hinterlaesst.
let _modalGeneration = 0;

/**
 * Ob dieses Modal beim Schliessen ueberhaupt nach ungespeicherten Eingaben
 * fragen darf.
 *
 * NICHT JEDES MODAL IST EIN FORMULAR. Der Dirty-Guard vergleicht stumpf alle
 * `input/select/textarea` im Kasten gegen ihren Stand beim Oeffnen - fuer ein
 * Formular mit „Speichern" genau richtig, fuer ein ANSICHTSBLATT falsch: die
 * Filter des Kalenders (pages/calendar.js, openCalendarFilters) sind eine Reihe
 * Schalter, die SOFORT wirken und sofort gespeichert sind. Es gibt dort weder
 * einen Speichern-Knopf noch etwas zu verwerfen - trotzdem fragte jedes
 * Schliessen nach dem Umlegen einer Ebene „Aenderungen verwerfen?", und ein
 * „Verwerfen" nahm die Aenderung nicht etwa zurueck, sondern liess sie stehen.
 * Der Dialog log also zweimal: er behauptete einen Verlust, den es nicht gab,
 * und versprach ein Zuruecknehmen, das er nicht leistete.
 *
 * Der Schalter steht hier und nicht als Abfrage auf eine Klasse, weil nur die
 * aufrufende Seite weiss, ob ihre Felder auf ein Speichern warten.
 */
let _dirtyGuardEnabled = true;

// Modal-Lebenszyklus als explizite Zustandsmaschine (Audit 1.5). Ersetzt die
// frühere ad-hoc-Jonglage aus einem Boolean-Schließ-Flag plus temporär
// genullten Globals. Gültige Zustände:
//   idle       - kein Modal offen
//   open       - Modal sichtbar und interaktiv
//   confirming - „Änderungen verwerfen?"-Dialog liegt über einem dirty Modal
//   closing    - Schließ-Animation/Cleanup läuft (blockt erneutes Schließen)
let modalState = 'idle';

/**
 * Merkt den UI-Kontext, in dem ein asynchroner Modal-Ablauf gestartet wurde.
 * Neben dem Shared-Slot gehoert die konkrete Seiteninstanz dazu: Pfadvergleich
 * allein erkennt Navigation weg und wieder zurueck nicht, der alte Page-Wrapper
 * bleibt danach aber dauerhaft getrennt.
 */
export function captureModalContext() {
  return {
    generation: _modalGeneration,
    // Der Dialog selbst, fuer closeModal({ context }): nur DIESEN darf ein
    // spaeter Ablauf schliessen (#1997).
    overlay: activeOverlay,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    pageRoot: document.getElementById('main-content')?.firstElementChild ?? null,
  };
}

/**
 * Ob der Dialog, der bei captureModalContext() offen war, noch der offene ist -
 * derselbe Knoten, auch nach einer Rueckfrage, die ihn geparkt und
 * zurueckgegeben hat. Die Regel hinter closeModal({ context }) (#1997); eine
 * Seite fragt sie selbst nur fuer das, was AN DIESEM DIALOG haengt (etwa den
 * Fokus nach dem Schliessen zurueckzutragen).
 */
export function isOwnModalOpen(context) {
  // Schliessend zaehlt nicht als offen: activeOverlay zeigt bis _doClose()
  // noch auf den Knoten, waehrend er schon ausfaehrt - der Nutzer hat ihn
  // dann bewusst zugemacht, und nichts soll ihn danach neu aufbauen (Codex an #2021).
  return Boolean(context?.overlay) && context.overlay === activeOverlay && modalState !== 'closing';
}

/**
 * Der Kontext fuer einen Dialog, der erst nach einer Antwort aufgeht (#1997):
 * wie captureModalContext(), dazu ein Platz in der Reihe der Oeffnungswuensche.
 * Tippt der Nutzer A und dann B, bevor eine der Anfragen zurueck ist, gilt nur
 * B - in welcher Reihenfolge die Antworten auch kommen. Ohne den Platz fingen
 * beide dieselbe Generation, die zuerst angekommene Antwort oeffnete, und der
 * zuletzt gewaehlte Dialog wurde verworfen (Codex an #2132).
 */
let _openIntent = 0;
export function captureOpenContext() {
  _openIntent += 1;
  return { ...captureModalContext(), intent: _openIntent };
}

/** Ob seit captureModalContext() weder Dialog noch Seiteninstanz wechselte. */
export function isModalContextCurrent(context) {
  if (!context || context.generation !== _modalGeneration) return false;
  // Ein neuerer Oeffnungswunsch loest einen aelteren ab (captureOpenContext).
  if (context.intent !== undefined && context.intent !== _openIntent) return false;
  const route = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (context.route !== route) return false;
  return !context.pageRoot || context.pageRoot.isConnected;
}

/**
 * DAS MODAL-SYSTEM HAELT GENAU EINEN EINTRAG IN DER ZURUECK-GESTE (#871),
 * nicht einen je geoeffnetem Dialog.
 *
 * Es stapelt per Konstruktion nicht: `openModal()` schliesst ein vorheriges
 * Modal, und `confirmModal()` PARKT das darunter liegende, statt es zu
 * schliessen. Aus Sicht des Nutzers ist also durchgehend „ein Dialog offen" -
 * und das ist genau die Ebene, die eine Zurueck-Geste meint.
 *
 * Ein Marker je Dialog haette zwei Fehler: der Wechsel Modal→Modal wuerde
 * einen `history.back()` gegen ein `pushState()` im selben Tick fuehren
 * (Reihenfolge nicht zugesichert), und ein Zurueck ueber einem
 * Bestaetigungsdialog verbrauchte den Marker des Formulars darunter mit.
 */
let _overlayToken = null;

/**
 * Der Rueckweg aus der Zurueck-Geste - und vom Sitzungsende, das `force`
 * setzt.
 *
 * `false` heisst „das Modal steht noch", und das Register haelt seinen Eintrag
 * dann fest. Zwei Faelle fuehren dahin, und beide erkennt man am ZUSTAND:
 * abgelehntes Verwerfen, und ein geschlossener Bestaetigungsdialog, unter dem
 * ein geparktes Formular wieder auftaucht. In beiden steht `modalState`
 * danach auf 'open'.
 *
 * NICHT AM DOM ABLESBAR, und das ist hier bezahlt worden: eine erste Fassung
 * fragte `document.querySelector('.modal-overlay')`. Auf Mobil - also auf
 * genau der Plattform, um die es in #871 geht - loest `closeModal()` aber
 * BEVOR das Overlay aus dem DOM faellt: es startet nur die Schliessanimation
 * und raeumt erst auf `animationend` ab. Jede erfolgreiche Wischgeste galt
 * damit 400 ms lang als „abgelehnt".
 */
/**
 * DER EINTRAG FOLGT DEM ZUSTAND, NICHT DEM EREIGNIS (#871).
 *
 * Das war die Lehre aus drei Anlaeufen. Der Token wurde erst beim Oeffnen
 * gesetzt und beim Schliessen zurueckgegeben, und beide Stellen mussten
 * wissen, ob unter dem Kasten, der gerade zugeht, noch einer liegt. Sie
 * konnten es nicht zuverlaessig wissen:
 *
 *   - Ein Bestaetigungsdialog PARKT das Formular darunter. Fuer `_doClose` ist
 *     er `activeOverlay`, also gab dieser Zweig den Token des FORMULARS
 *     zurueck - und `_resumeSuspendedModal` holte es danach ohne Registrierung
 *     wieder hervor.
 *   - Der Bestaetigungs-Ablauf laeuft in einer eigenen, nicht abgewarteten
 *     Kette. Wer direkt nach `closeModal()` fragt, ob noch etwas offen ist,
 *     fragt zu frueh - `modalState` steht dann auf 'idle' oder 'closing', und
 *     das gleich folgende Formular sah aus wie nichts.
 *
 * Eine Zustandsfrage kennt diese Reihenfolgen nicht: liegt ein
 * `.modal-overlay` im Dokument, ist ein Dialog offen, sonst nicht. Ein
 * geparktes Formular liegt darin - `inert`, aber vorhanden -, ein
 * schliessendes auf Mobil auch noch, und beides ist richtig so: solange es zu
 * sehen ist, gehoert ihm die Zurueck-Geste.
 *
 * Aufgerufen nach JEDEM Uebergang. Das Register gleicht seinen History-Marker
 * ohnehin verzoegert ab, also heben sich Zwischenzustaende innerhalb eines
 * Ticks gegenseitig auf, statt zwei History-Operationen auszuloesen.
 */
function _syncOverlayRegistration() {
  const open = Boolean(document.querySelector('.modal-overlay'));
  if (open) {
    /* `isOverlayOpen` und nicht nur `!== null`: `handleBackNavigation()` nimmt
     * den Eintrag aus dem Register, BEVOR es schliessen laesst. Wer danach nur
     * fragt, ob er einen Token HAT, haelt sich fuer angemeldet und ist es
     * nicht - genau so verlor ein wieder hervorgeholtes Formular seinen
     * Anspruch auf die naechste Geste, und der Router navigierte dahinter weg.
     * Live nachgestellt an der Kategorie-Verwaltung. */
    if (_overlayToken === null || !isOverlayOpen(_overlayToken)) {
      _overlayToken = pushOverlay(_closeFromBackNavigation);
    }
    return;
  }
  if (_overlayToken !== null) {
    const token = _overlayToken;
    _overlayToken = null;
    dropOverlay(token);
  }
}

/**
 * Der Rueckweg aus der Zurueck-Geste und aus dem Zwang (Sitzungsende,
 * Navigation).
 *
 * Gibt IMMER `true`: ob danach noch etwas steht, meldet nicht diese Antwort,
 * sondern `_syncOverlayRegistration()` - und zwar dann, wenn es wirklich
 * feststeht. Bleibt das Formular offen (abgelehntes Verwerfen) oder taucht ein
 * geparktes wieder auf, meldet es sich von selbst neu an.
 *
 * `force` heisst: es fragt niemand mehr, und es kommt nichts zurueck. Ein
 * `closeModal({force:true})` erwischt aber nur den OBERSTEN Kasten, und der
 * laufende Bestaetigungs-Ablauf holte danach sein geparktes Formular hervor -
 * ueber der Anmeldeseite, mit Scroll-Sperre und einem Escape-Handler auf einem
 * entfernten Knoten. Deshalb fallen hier auch die geparkten Kaesten; sie sind
 * `inert` und haben keinen eigenen Schliessweg mehr. `_resumeSuspendedModal`
 * erkennt an ihrem entfernten Knoten, dass es nichts mehr zurueckzuholen gibt.
 */
async function _closeFromBackNavigation({ force = false } = {}) {
  await closeModal({ force });
  if (force) {
    document.querySelectorAll('.modal-overlay').forEach((el) => _removeOverlay(el));
  }
  _syncOverlayRegistration();
  return true;
}

// Overlay-Dimming: theme-color abdunkeln im Standalone-Modus
const OVERLAY_THEME_COLOR = '#1A1A1A';

// Die Seitenwurzel - letzter Halt fuer den Fokus, wenn der Ausloeser weg ist.
// `renderAppShell()` in router.js vergibt die id und setzt `tabIndex = -1`; sie
// ist ausserdem das Ziel des Skip-Links, also per Design die Stelle „hier
// beginnt der Seiteninhalt".
const PAGE_ROOT_ID = 'main-content';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// Erstes echtes Eingabefeld eines Formulars - der Ort, an den der Fokus bei
// Dateneingabe gehört. `tabindex="-1"` zaehlt nicht: ein Feld ausserhalb der
// Tab-Folge ist ein Werkzeug eines anderen Bedienelements, kein Einstieg. In
// "Mitglied bearbeiten" landete der Erstfokus sonst auf dem versteckten
// Datei-Input der Avatar-Vorschau, und `.sr-only:focus-visible` zeigte ihn als
// Streifen ueber dem Dialogkopf (a11y-Runde). Dasselbe gilt fuer das native
// Feld hinter dem Datepicker (`.ydp__native`).
const FIRST_FIELD = [
  'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
].join(', ');

// DER ERSTFOKUS GEHT INS ERSTE PFLICHT- ODER WERTFELD (Critique R23, D8). Das
// erste Feld in DOM-Reihenfolge war oft keins, in das man tippt: die Logo-Suche
// des Abos, die Typ-Auswahl des Vitalwerts, ein Schalter, das Symbol einer
// Praemie. Vorrang hat deshalb das erste PFLICHTFELD zum Tippen, dann das erste
// Feld zum Tippen ueberhaupt, erst dann irgendein Feld (Auswahl, Schalter).
const TYPED = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'
  + ':not([type="color"]):not([type="range"]):not([type="button"]):not([type="submit"])'
  + ':not([disabled]):not([tabindex="-1"]):not([readonly])';
const TYPED_FIELD = `${TYPED}, textarea:not([disabled]):not([tabindex="-1"]):not([readonly])`;
// Die Datumsauswahl (`yuvomi-datepicker`) traegt `required` am Element, nicht
// an ihrem Tippfeld - sie zaehlt trotzdem als Pflichtfeld.
const REQUIRED_TYPED_FIELD = `${TYPED}[required], textarea[required]:not([disabled]):not([tabindex="-1"]):not([readonly]),`
  + ` yuvomi-datepicker[required] ${TYPED}`;

/**
 * Das Ziel des Erstfokus in `root` (siehe oben), sonst das erste Fokussierbare.
 * Ein Feld in einer verborgenen Gruppe (`[hidden]`, etwa die Monatsfelder einer
 * woechentlichen Regel) zaehlt nicht: der Fokus darauf liefe still ins Leere,
 * und der Dialog bliebe ohne Einstieg (im Browser gemessen, Entsorgung).
 */
export function firstEntryField(root) {
  const usable = (el) => !el.closest?.('[hidden], [inert]');
  const all = (selector) => (typeof root.querySelectorAll === 'function'
    ? [...root.querySelectorAll(selector)]
    : [root.querySelector?.(selector)].filter(Boolean));
  for (const selector of [REQUIRED_TYPED_FIELD, TYPED_FIELD, FIRST_FIELD, FOCUSABLE]) {
    const hit = all(selector).find(usable);
    if (hit) return hit;
  }
  return null;
}

// --------------------------------------------------------
// Focus-Trap (Spec §5.2)
// --------------------------------------------------------

/**
 * Der Knopf, den Enter in einem einzeiligen Feld ausloest.
 *
 * 1. Der Absender des Formulars, dem das Feld gehoert. `button.form` ist der
 *    Formular-BESITZER: das umgebende <form> oder das per `form="id"`
 *    zugeordnete - so bindet `mountFooter()` das "Speichern" der Fusszeile an
 *    sein Formular, obwohl es nicht mehr darin steht (#543).
 * 2. Sonst die Hauptaktion des Panels, aber nie die eines FREMDEN Formulars.
 *
 * Versteckte Aeste (`[hidden]`, `[inert]`) zaehlen in beiden Stufen nicht. Ein
 * GESPERRTER eigener Absender bleibt der Treffer und loest nichts aus: gesperrt
 * heisst "unterwegs", nicht "nimm einen anderen".
 */
function enterSubmitTarget(active, container) {
  const form = active.form ?? null;
  const candidates = [...container.querySelectorAll('button[type="submit"], .btn--primary')]
    .filter((btn) => !btn.closest?.('[hidden], [inert]'));
  const own = form ? candidates.find((btn) => btn.type === 'submit' && btn.form === form) : null;
  return own ?? candidates.find((btn) => !form || !btn.form || btn.form === form) ?? null;
}

function trapFocus(container, initialFocus = 'first-field') {
  focusTrapHandler = (e) => {
    // Tab-Trap: Fokus innerhalb des Modals halten - NUR ohne natives
    // <dialog> (Safari < 15.4). Ein modaler Dialog haelt den Fokus selbst, und
    // der Fang am Panel sprang vom letzten Feld zurueck aufs erste: der
    // Toast-Stapel, der waehrend des Dialogs IN ihm neben dem Panel liegt
    // (_syncTopLayerGuests), war so per Tastatur nie zu erreichen, sein
    // "Rueckgaengig" nur mit der Maus (Modern-Web-Guidance-Audit, Befund 9).
    if (e.key === 'Tab') {
      if (container.closest?.('dialog')?.open) return;
      const focusable = container.querySelectorAll(FOCUSABLE);
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    // Enter in einzeiligen Inputs/Selects → Formular absenden (Standard-Web-
    // Konvention, Audit 1.4). Textareas behalten ihr Standardverhalten (Zeilen-
    // umbruch), Submit-/Button-Elemente lösen ohnehin ihren eigenen Klick aus.
    // Waehrend einer IME-Umwandlung bestaetigt Enter das Schriftzeichen.
    if (e.key === 'Enter' && !isImeComposing(e)) {
      const active = document.activeElement;
      const isInput = active.tagName === 'INPUT' && active.type !== 'submit' && active.type !== 'button';
      const isSelect = active.tagName === 'SELECT';

      if (isInput || isSelect) {
        // WEM GEHOERT DIESES ENTER (#1598)? Ein Blatt kann mehr als ein
        // Formular tragen - die Aufgabe hat die Teilaufgaben-Zeile UND das
        // Kommentarfeld -, und nach "Bearbeiten" steht die Leseansicht samt
        // beiden `hidden` VOR dem Formular im DOM. Der erste Treffer im
        // Dokument war deshalb "Kommentieren" bzw. ein Knopf, den niemand
        // sieht; `preventDefault()` nahm dem richtigen Formular die Absendung.
        const submitBtn = enterSubmitTarget(active, container);
        if (submitBtn && !submitBtn.disabled) {
          e.preventDefault();
          submitBtn.click();
        }
      }
    }
  };
  container.addEventListener('keydown', focusTrapHandler);

  // Virtual Keyboard: Focused Input in sichtbaren Bereich scrollen
  //
  // NUR WAS NICHT SCHON OBEN IM BILD STEHT (R21 S7, Critique a3). Ein hohes
  // Feld - der Notiztext mit 300px Mindesthoehe - laesst sich nicht
  // zentrieren: der Koerper rollte beim Wechsel in den Editor 54px hoch, und
  // der Umschalter Lesen/Bearbeiten stand 38 von 48px unter dem Blattkopf.
  // Steht die Oberkante des Felds schon in der oberen Haelfte seines
  // Scrollports, bleibt alles stehen; tiefer liegende Felder (die die
  // Tastatur verdecken wuerde) ruecken wie bisher in die Mitte.
  function onInputFocus(e) {
    const tag = e.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    setTimeout(() => {
      const port = e.target.closest('.modal-panel__body');
      if (port) {
        const top = e.target.getBoundingClientRect().top;
        const box = port.getBoundingClientRect();
        if (top >= box.top && top < box.top + box.height / 2) return;
      }
      e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }
  container.addEventListener('focusin', onInputFocus);
  container._onInputFocus = onInputFocus;

  applyInitialFocus(container, initialFocus);
}

/**
 * Setzt den Fokus beim Öffnen.
 *
 *   'first-field' (Default) - Enthält das Modal ein Formular, gehört der Fokus in
 *                             das erste Eingabefeld, nicht auf das Schließen-X.
 *                             Sonst beginnt jede Dateneingabe mit einem Tab an
 *                             der Aktion vorbei, die man gerade nicht will.
 *   'none'                  - Der Aufrufer setzt den Fokus selbst. Für Ansichten
 *                             ohne Eingabeabsicht (Detailansicht): dort gibt es
 *                             nichts zu tippen, und ein Feldfokus fährt auf dem
 *                             Smartphone grundlos die Tastatur hoch.
 *   HTMLElement             - genau dieses Element.
 *
 * DER ERSTFOKUS KOMMT 50 MS SPAETER - UND DARF DANN NICHTS MEHR UEBERSCHREIBEN
 * (#1156). Auf einem langsamen Geraet liegt der Timer laenger, und bis dahin hat
 * schon jemand gewaehlt: gemessen am Speichern-Tor, wo `confirmOverModal` das
 * Formular parkt, fragt und den Fokus beim Fortsetzen auf den Speichern-Knopf
 * zurueckgibt. Der liegengebliebene Timer zog ihn danach ins erste Feld, und
 * nichts holte ihn zurueck. Er fokussiert deshalb nur noch, wenn das Ziel noch
 * haengt, das Modal nicht geparkt (`inert`) ist und seit dem Planen niemand den
 * Fokus im Modal oder in einer Oberflaeche darueber gewaehlt hat.
 *
 * "ODER DARUEBER" (Review zu #1193): der Datepicker oeffnet sein Popover direkt
 * unter `document.body` und fokussiert synchron hinein - ausserhalb des Modals,
 * ohne es inert zu machen. Eine Wache, die nur im Modal nachsieht, haette den
 * Fokus aus dem offenen Kalender zurueck ins erste Feld gerissen.
 *
 * "DARUEBER", NICHT "IRGENDWO" (zweite Runde derselben Review): wer waehrend der
 * Verzoegerung Tab drueckt, landet auf einem Element der Seite DAHINTER - die ist
 * nicht inert, der Fokus-Trap haengt nur am Panel. Zaehlte das als Wahl, kaeme der
 * Fokus nie in den Dialog, und der Trap griffe nie. Ein Seitenelement dahinter ist
 * also so wenig eine Wahl wie ein auf body gefallener Fokus.
 */
function applyInitialFocus(container, initialFocus) {
  if (initialFocus === 'none') return;

  const target = resolveInitialFocus(container, initialFocus);
  if (target) {
    const beimPlanen = document.activeElement;
    setTimeout(() => _focusInitialUnlessClaimed(container, target, beimPlanen), 50);
  }
}

/**
 * Wohin der Erstfokus geht.
 *
 * `'edit'` - BEARBEITEN HOLT AM FINGER KEINE TASTATUR (R23, D13; Critique G3
 * "Karte oeffnet Bearbeiten mit Autofokus", Rest aus S1 fuer die Buchung).
 * Wer einen bestehenden Eintrag antippt, will ihn meist erst ansehen; ein
 * Feldfokus fuhr die Tastatur hoch und verdeckte rund 40 % des Blatts. Ohne
 * schwebenden Zeiger nimmt deshalb der Titel des Blatts den Fokus (tabindex
 * -1, ohne Ring, ein Screenreader liest ihn vor) - dieselbe Regel wie beim
 * Wechsel aus einer Leseansicht ins Formular (focusFirstField). Am Zeiger
 * bleibt es beim ersten Feld: dort faehrt keine Tastatur hoch.
 */
function resolveInitialFocus(container, initialFocus) {
  if (initialFocus === 'none') return null;
  if (initialFocus && typeof initialFocus.focus === 'function') return initialFocus;
  // EIN SELEKTOR NENNT DAS PFLICHTFELD, DAS DIE REGEL NICHT FINDET (R24,
  // Critique G5 P2-4). `firstEntryField` sucht zuerst ein Tippfeld - steht
  // vor dem ersten Tippfeld eine Pflicht-AUSWAHL (Aktivitaet: „Art *" vor dem
  // Zeitpunkt), landete der Fokus im Datum und die Tastatur fuhr hoch. Ein
  // Dialog, dessen Pflichtfeld eine Auswahl ist, nennt sie; fehlt sie, gilt
  // die Regel.
  if (typeof initialFocus === 'string' && /^[#.[]/.test(initialFocus)) {
    const named = container.querySelector?.(initialFocus);
    if (named && !named.closest?.('[hidden], [inert]')) return named;
  }
  if (initialFocus === 'edit' && typeof matchMedia === 'function' && matchMedia('(hover: none)').matches) {
    const heading = container.querySelector?.('.modal-panel__title');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      return heading;
    }
  }
  return firstEntryField(container);
}

function _focusInitialUnlessClaimed(container, target, beimPlanen) {
  if (!target.isConnected) return;
  if (container.closest?.('[inert]')) return;
  const jetzt = document.activeElement;
  // Gewaehlt ist nur ein Fokus im Modal selbst oder in einem Popover darueber.
  // body (der Ausloeser wurde weggerendert) und die Seite dahinter (Tab waehrend
  // der Verzoegerung) sind keine Wahl - das Modal bekommt seinen Einstieg trotzdem.
  const gewaehlt = jetzt && jetzt !== beimPlanen
    && (container.contains(jetzt) || Boolean(jetzt.closest?.('[popover]')));
  if (gewaehlt) return;
  // KEIN FOKUSRING AM SCHLIESSEN-KNOPF NACH EINEM TIPP (R23, Critique G4). Hat
  // der Dialog kein Feld (Dokument-Betrachter, Leseansichten), fiel der
  // Erstfokus auf das erste Fokussierbare - das X im Kopf -, und Chromium
  // zeichnet nach einem Zeigerklick auf eine nicht fokussierbare Zeile fuer
  // jeden Skript-Fokus den Ring: ein umrandetes X, das niemand angesteuert hat.
  // Per Zeiger geoeffnet nimmt deshalb der Titel den Fokus (tabindex -1, ohne
  // Ring, ein Screenreader liest ihn vor); per Tastatur geoeffnet - der
  // Ausloeser zeigte seinen Ring - bleibt es beim X.
  // `showModal()` hat das X schon fokussiert, bevor hier geplant wurde - die
  // Geste steht deshalb am Dialog (_enterTopLayer); ohne ihn (Node-Sonden,
  // Div-Rueckfall) zaehlt der Fokus beim Planen.
  const keyboard = container.closest?.('dialog')?._openedByKeyboard ?? _openedByKeyboard(beimPlanen);
  if (target.matches?.('.modal-panel__close') && !keyboard) {
    const heading = container.querySelector?.('.modal-panel__title');
    if (heading && typeof heading.focus === 'function') {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus();
      return;
    }
  }
  target.focus();
}

/** Zeigte der Ausloeser seinen Fokusring? Rueckfall ohne `<dialog>` (Sonden). */
function _openedByKeyboard(el) {
  try { return el?.matches?.(':focus-visible') === true; } catch { return false; }
}

// Die letzte Eingabeart: Zeiger oder Taste. Ohne jede Eingabe (ein Dialog, den
// die App selbst oeffnet) gilt "Tastatur" - dann bleibt es beim X mit Ring,
// wie bisher.
let _lastInput = 'keyboard';
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', () => { _lastInput = 'pointer'; }, true);
  document.addEventListener('keydown', () => { _lastInput = 'keyboard'; }, true);
}

/**
 * War die letzte Eingabe eine Taste? Der EINE Zeuge fuer "per Tastatur
 * geoeffnet" (R23 S6/S11). Der `:focus-visible` des Ausloesers taugt nicht:
 * nach einem Seitenwechsel traegt ihn die Seitenwurzel auch nach Mausklick.
 * Ohne jede Eingabe gilt "Tastatur", wie beim Erstfokus der Dialoge.
 * @returns {boolean}
 */
export function lastInputWasKeyboard() {
  return _lastInput === 'keyboard';
}

/**
 * Fokus nach einem Pane-Wechsel innerhalb eines offenen Modals (Detailansicht →
 * Formular). `trapFocus` läuft nur beim Öffnen; ohne diesen Aufruf bliebe der
 * Fokus auf dem verschwundenen „Bearbeiten"-Button und Screenreader verlören
 * den Faden.
 *
 * Auf Fingergeräten landet er bewusst NICHT im ersten Feld: Man hat „Bearbeiten"
 * gedrückt, nicht „Tippen". Ein Feldfokus würde die Tastatur hochfahren, die
 * rund 40 % des Sheets verdeckt. Der Panel-Kopf ist der ruhige Einstieg - er
 * nennt die Ansicht und liegt vor allen Feldern in der Tab-Reihenfolge.
 */
export function focusFirstField(panel) {
  if (!panel) return null;

  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    const heading = panel.querySelector('.modal-panel__title');
    if (heading) {
      // Überschriften sind nicht von Haus aus fokussierbar; tabindex="-1" macht
      // sie programmatisch erreichbar, ohne sie in die Tab-Kette zu hängen.
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus();
      return heading;
    }
  }

  const target = firstEntryField(panel);
  target?.focus();
  return target ?? null;
}

// --------------------------------------------------------
// Dirty-Check Helpers
// --------------------------------------------------------

// `[data-dirty-ignore]` opts a single control OUT of the dirty comparison
// (S-14): a purely structural/UI-mode field (e.g. a hidden `mode` input that a
// segmented control rewrites on every click, with no typed content of its
// own) would otherwise make `isFormDirty()` report a change the user never
// made - switching segments alone triggered "Discard changes?" with zero
// typed input. Opt-in per field, not a blanket exclusion of disabled/hidden
// fieldsets: a real field that starts disabled/hidden (e.g. a conditional
// fieldset a mode enables) must still count once it holds typed content.
function serializeForm(container) {
  return formFields(container).map(serializeField).join('&');
}

function formFields(container) {
  return Array.from(container.querySelectorAll(
    'input:not([type="file"]):not([data-dirty-ignore]), select:not([data-dirty-ignore]), textarea:not([data-dirty-ignore])'
  ));
}

// EIN HAKEN IST SEIN ZUSTAND, NICHT SEIN WERT (#1775). Eine Checkbox traegt
// als `value` "on" (oder was das Markup ihr gab), ob sie gesetzt ist oder
// nicht - verglichen wurde also ein Text, der sich nie aendert: wer nur
// "Aktiv" umlegte und den Dialog schloss, verlor die Aenderung ohne die
// Verwerfen-Frage. Fuer Checkbox und Radio steht deshalb `checked` mit im
// Schnappschuss. Ein Blatt, dessen Haken SOFORT wirken und gespeichert sind,
// ist ein Ansichtsblatt und oeffnet mit `dirtyGuard: false`.
function serializeField(el) {
  const state = el.type === 'checkbox' || el.type === 'radio' ? `:${el.checked ? 1 : 0}` : '';
  return `${el.name || el.id}=${el.value}${state}`;
}

function isFormDirty(container) {
  // Ein Ansichtsblatt hat nichts Ungespeichertes - siehe _dirtyGuardEnabled.
  if (!_dirtyGuardEnabled) return false;
  if (_initialFormSnapshot === null) return false;
  return serializeForm(container) !== _initialFormSnapshot.entries.join('&');
}

// Die Basis steht JE FELD da, nicht als ein Text, und merkt sich das ELEMENT
// zu jedem Eintrag: nur so laesst sich spaeter sagen, welcher Eintrag zu
// welchem Feld gehoert, egal wie viele Felder inzwischen dazukamen oder
// gingen (swapFieldsKeepingDirtyBase). Verglichen wird weiter der eine Text -
// fuer jeden Dialog, der nie Felder tauscht, ist das der Vergleich von immer.
function _takeDirtyBase(panel) {
  const fields = formFields(panel);
  const base = { fields, entries: fields.map(serializeField) };
  _dirtyBaseByPanel.set(panel, base);
  return base;
}

function _snapshotNow() {
  if (!activeOverlay) return;
  _initialFormSnapshot = _takeDirtyBase(activeOverlay.querySelector('.modal-panel') ?? activeOverlay);
}

/**
 * Setzt die Dirty-Basis auf den aktuellen Feldstand.
 *
 * Nötig, wenn ein Formular erst NACH dem Öffnen entsteht: Der Snapshot beim
 * Öffnen erfasst dann eine Detailansicht ohne Felder, also den leeren String.
 * Sobald das Formular gemountet ist, liefert `serializeForm` plötzlich
 * `title=Zahnarzt&…`, und das Schließen fragt „Änderungen verwerfen?", obwohl
 * niemand etwas geändert hat.
 *
 * Der zweite, verzögerte Snapshot spiegelt `openModal`: Felder, die per API
 * nachgeladen werden (Selects, Datepicker), sind erst danach befüllt.
 */
export function refreshDirtySnapshot() {
  _snapshotNow();
  if (_initialFormTimeout) clearTimeout(_initialFormTimeout);
  _initialFormTimeout = setTimeout(_snapshotNow, 150);
}

/**
 * Tauscht Felder im offenen Formular, ohne dass der Tausch als Eingabe zaehlt
 * (#1784).
 *
 * Wer einem offenen Dialog Felder NACHREICHT (eine Auswahl, deren Optionen erst
 * jetzt geladen sind), veraendert, was `serializeForm` liest - und das
 * Schliessen fragt "Aenderungen verwerfen?", obwohl niemand etwas angefasst
 * hat. `refreshDirtySnapshot()` waere hier die falsche Antwort: es friert den
 * JETZIGEN Stand ein und damit auch, was der Nutzer inzwischen getippt hat -
 * das Schliessen ginge ohne Frage durch, und die Eingabe waere still weg.
 *
 * Deshalb je ELEMENT. Die Basis kennt zu jedem Eintrag sein Feld:
 *   - was der Tausch ENTFERNT, faellt aus der Basis;
 *   - was er NEU bringt, geht mit dem Stand hinein, den `swap` ihm gegeben hat,
 *     an der Stelle, an der es im Formular steht;
 *   - alles andere bleibt, wie es war. Eine getippte Eingabe bleibt eine
 *     Aenderung, und wer sie zuruecknimmt, ist wieder sauber. Eine Zeile, die
 *     der Nutzer vor dem Tausch hinzugefuegt hat, bleibt ebenfalls eine - sie
 *     war schon da und kommt deshalb NICHT in die Basis; nimmt er sie wieder
 *     weg, steht der Dialog im Oeffnungszustand.
 *
 * Die Basis wird ueber das Panel gefunden und AN ORT UND STELLE geaendert. Sie
 * ist dasselbe Objekt, das ein geparktes Formular in seinem Token traegt - der
 * Tausch erreicht es also auch unter einer Rueckfrage, und das Zurueckholen
 * bringt die nachgefuehrte Basis mit.
 *
 * `swap` laeuft synchron und IMMER - auch fuer ein Panel ohne Basis.
 *
 * @param {Element} panel - das `.modal-panel`, das `onSave` bekommen hat
 * @param {() => void} swap - der Tausch samt allem, was die neuen Felder
 *   programmatisch setzt (Vorauswahl), bevor der Nutzer sie zu sehen bekommt
 */
export function swapFieldsKeepingDirtyBase(panel, swap) {
  const base = _dirtyBaseByPanel.get(panel) ?? null;
  const before = base ? new Set(formFields(panel)) : null;
  swap();
  if (!base) return;
  const after = formFields(panel);
  const present = new Set(after);
  // Vom Tausch entfernt: vorher da, jetzt weg. Was schon VOR dem Tausch
  // fehlte, hat der Nutzer entfernt - das bleibt als Aenderung in der Basis.
  const swappedOut = (el) => before.has(el) && !present.has(el);
  const rows = base.fields.map((el, i) => [el, base.entries[i]]).filter(([el]) => !swappedOut(el));
  const known = new Set(rows.map(([el]) => el));
  // Neu ist, was weder vorher da war noch in der Basis steht. Was vorher da
  // war und nicht in der Basis steht, hat der Nutzer hinzugefuegt.
  const added = after.filter((el) => !known.has(el) && !before.has(el));
  const gap = base.fields.findIndex(swappedOut);
  if (gap >= 0) {
    // Der Tausch ERSETZT: das Neue nimmt den Platz dessen ein, was er entfernt
    // hat - gezaehlt in der Basis, nicht im Formular, denn dort koennen Zeilen
    // des Nutzers dazwischenstehen oder fehlen.
    // `gap` ist das ERSTE Entfernte - davor steht also nichts, was fehlt.
    rows.splice(gap, 0, ...added.map((el) => [el, serializeField(el)]));
  } else {
    // Der Tausch fuegt nur HINZU: hinter das naechste Feld davor, das die
    // Basis kennt.
    const fresh = new Set(added);
    let anchor = null;
    for (const el of after) {
      if (known.has(el)) { anchor = el; continue; }
      if (!fresh.has(el)) continue;
      const at = anchor ? rows.findIndex(([row]) => row === anchor) + 1 : 0;
      rows.splice(at, 0, [el, serializeField(el)]);
      known.add(el);
      anchor = el;
    }
  }
  base.fields = rows.map(([el]) => el);
  base.entries = rows.map(([, entry]) => entry);
}

// --------------------------------------------------------
// Escape-Handler
// --------------------------------------------------------

/**
 * ESC GEHOERT DER OBERSTEN EBENE - UND DIESER HANDLER ENTSCHEIDET, NICHT DER
 * BROWSER (D7, Critique 2026-10-16).
 *
 * Seit das Modal ein natives `<dialog>` ist, hat Esc einen zweiten Weg: den
 * `cancel`-Request des Browsers. Ihm allein zu folgen geht nicht. Chrome laesst
 * `cancel` nur EINMAL je Nutzeraktivierung abbrechen - gemessen (Chrome 155):
 * das zweite Esc ohne Klick dazwischen meldet `cancelable: false` und schliesst
 * den Dialog hart, an der Rueckfrage "Aenderungen verwerfen?" vorbei. Deshalb
 * nimmt dieser Handler den Tastendruck selbst (`preventDefault` unterdrueckt
 * den Request) und fuehrt ihn durch `closeModal()` samt Dirty-Guard.
 *
 * WEM DAS ESC GILT, sagt der naechste Besitzer des Ziels:
 *   - das Modal selbst -> schliessen.
 *   - ein Popover darin (Menue) oder ein eigenes natives `<dialog>` darueber
 *     (Symbolauswahl, Zuschnitt) -> der Browser schliesst es per Request, hier
 *     nichts tun.
 *   - ein selbstgebautes `.modal-overlay`-Div darin (Kalender-Symbolwahl,
 *     Hilfe) -> es schliesst mit eigenem Handler; hier nur den Request
 *     unterdruecken, sonst ginge das Formular darunter mit zu.
 * Ein Handler weiter unten, der Esc selbst erledigt (`defaultPrevented`, etwa
 * der Datepicker), hat Vorrang.
 */
function onEscape(e) {
  if (e === _escKeptBelow) _escKeptBelow = null;
  if (e.key !== 'Escape' || e.defaultPrevented || !activeOverlay) return;
  // Esc waehrend einer IME-Umwandlung bricht die Umwandlung ab, nicht das
  // Formular. preventDefault haelt den close-Request des <dialog> zurueck
  // (Codex-Review zu #2055).
  if (isImeComposing(e)) {
    e.preventDefault();
    return;
  }
  const owner = e.target?.closest?.('[popover], dialog, .modal-overlay') ?? null;
  if (owner && owner !== activeOverlay) {
    if (owner.matches('[popover], dialog')) return;
    e.preventDefault();
    return;
  }
  e.preventDefault();
  closeModal();
}

/**
 * EIN ESC, DAS EIN HANDLER DARUNTER FUER SICH BEHAELT, SCHLIESST AUCH PER
 * `cancel` NICHT. Die Fasten-Hilfe, die Anhang-Auswahl und Menues schliessen
 * ihre eigene Ebene auf Esc mit `stopPropagation()`; beim div-Overlay erreichte
 * das Esc `onEscape` darum nie, und das Formular blieb stehen. Der native
 * Dialog bekommt danach aber noch den Close-Request des Browsers - gemessen
 * ging der ganze Einstellungsdialog mit dem Tooltip zu. Der Capture-Listener
 * merkt sich jedes Esc; kommt es nicht bis `onEscape`, gehoert der folgende
 * `cancel` desselben Tastendrucks nicht dem Modal. Der Browser schickt ihn
 * in derselben Aufgabe, deshalb verfaellt die Marke mit der naechsten: die
 * Zurueck-Geste (ein `cancel` ohne Esc) schliesst weiter.
 */
let _escKeptBelow = null;
function onEscapeCapture(e) {
  if (e.key !== 'Escape') return;
  _escKeptBelow = e;
  setTimeout(() => { if (_escKeptBelow === e) _escKeptBelow = null; }, 0);
}

function bindEscape() {
  document.removeEventListener('keydown', onEscapeCapture, true);
  document.addEventListener('keydown', onEscapeCapture, true);
  document.removeEventListener('keydown', onEscape);
  document.addEventListener('keydown', onEscape);
}

function unbindEscape() {
  document.removeEventListener('keydown', onEscapeCapture, true);
  document.removeEventListener('keydown', onEscape);
  _escKeptBelow = null;
}

// --------------------------------------------------------
// Top-Layer (natives <dialog>, D7)
// --------------------------------------------------------

/**
 * Was ueber einem offenen Dialog sichtbar UND bedienbar bleiben muss: der
 * untere Shell-Stapel (Toasts, Sammelpille). Ein modaler Dialog macht alles
 * ausserhalb seiner selbst inert - auch ein Popover in der Top-Layer, gemessen
 * (Chrome 155): weder ein vorher noch ein nachher gezeigtes Popover ausserhalb
 * nimmt Fokus. Ein Toast mit "Rueckgaengig" waere ueber dem Formular nur noch
 * ein Bild. Er zieht deshalb fuer die Dauer des Dialogs IN den obersten Dialog
 * und kehrt danach an seinen Platz zurueck. Er bleibt `position: fixed` am
 * Viewport; die Lage rechnet weiter utils/toast-placement.js.
 */
const TOP_LAYER_GUESTS = '.shell-bottom-stack';
const _guestHome = new WeakMap();

/** Der oberste bedienbare Shared-Dialog: offen, nicht geparkt, nicht im Ausgang. */
function _topmostSharedDialog() {
  const open = [...document.querySelectorAll('dialog.modal-overlay')]
    .filter((d) => d.open && !d.inert && !d.classList.contains('modal-overlay--closing'));
  return open[open.length - 1] ?? null;
}

/**
 * DIE SAMMELAKTIONS-PILLE ZIEHT MIT, ABER NICHT BEDIENBAR. Sie steht im selben
 * Stapel wie die Toasts, gehoert aber zur Seite hinter dem Dialog: ihre
 * Aktionen (auch Loeschen) waren per Tab und Klick erreichbar, sobald der
 * Dialog den Fokus dem Browser ueberliess (Codex-Review zu #2058). Inert nur,
 * solange sie im Dialog wohnt, und nur, wenn sie es vorher nicht schon war.
 */
function _holdBulkPill(guest, hold) {
  const pill = guest.querySelector?.('.bulk-pill-layer');
  if (!pill) return;
  if (hold && !pill.inert) { pill.inert = true; pill._inertByModal = true; }
  if (!hold && pill._inertByModal) { pill.inert = false; pill._inertByModal = false; }
}

/** Gaeste in den obersten Dialog holen oder nach Hause schicken. `leaving` zieht sie sicher heraus. */
function _syncTopLayerGuests(leaving = null) {
  if (typeof document.querySelectorAll !== 'function') return;
  let host = _topmostSharedDialog();
  if (host === leaving) host = null;
  for (const guest of document.querySelectorAll(TOP_LAYER_GUESTS)) {
    if (host) {
      if (guest.parentElement === host) continue;
      if (!_guestHome.has(guest)) _guestHome.set(guest, { parent: guest.parentElement, next: guest.nextSibling });
      host.append(guest);
      _holdBulkPill(guest, true);
      continue;
    }
    const home = _guestHome.get(guest);
    if (!home) continue;
    _guestHome.delete(guest);
    _holdBulkPill(guest, false);
    if (!home.parent?.isConnected) { document.body.append(guest); continue; }
    home.parent.insertBefore(guest, home.next?.parentNode === home.parent ? home.next : null);
  }
}

/** Ein Overlay aus dem Dokument nehmen - vorher die Gaeste herausholen, sonst gingen Toasts mit. */
function _removeOverlay(overlay) {
  if (overlay?.querySelector?.(TOP_LAYER_GUESTS)) _syncTopLayerGuests(overlay);
  overlay?.remove?.();
}

/**
 * In die Top-Layer: `showModal()` macht den Hintergrund inert, faengt Tab im
 * Dialog (die Abdunklung traegt sein erstes Kind, `.modal-overlay__scrim`). Ohne `<dialog>`-Unterstuetzung (Node-
 * Sonden) bleibt es beim Div-Verhalten.
 */
function _enterTopLayer(overlay) {
  if (typeof overlay?.showModal === 'function' && !overlay.open && overlay.isConnected) {
    // Die Geste VOR `showModal()` merken (R23, siehe _focusInitialUnlessClaimed):
    // danach steht der Fokus schon auf dem X. Der Ring des vorher fokussierten
    // Elements taugt nicht als Zeuge - nach einem Seitenwechsel traegt ihn die
    // per Skript fokussierte Seitenwurzel auch nach einem Mausklick (gemessen).
    overlay._openedByKeyboard = _lastInput === 'keyboard';
    overlay.showModal();
  }
  _syncTopLayerGuests();
}

/**
 * AUS DER TOP-LAYER AM ANFANG DES AUSGANGS, NICHT AM ENDE.
 *
 * Bliebe der Dialog bis nach seiner Animation modal, waere die Seite noch
 * 150-400 ms inert - und wer nach `await closeModal()` ein Feld fokussiert
 * (Restore-Dialog, neu gezeichnete Listen), fokussierte ins Leere. `close()`
 * hebt die Sperre sofort; `.modal-overlay--closing` haelt den Knoten sichtbar
 * (layout.css), jetzt als gewoehnliche Ebene auf `--z-modal`; die Abdunklung
 * ist sein eigener Knoten (`.modal-overlay__scrim`, #1801) und blendet dort aus.
 *
 * Der Browser gibt beim `close()` den Fokus an das Element zurueck, das ihn vor
 * `showModal()` hatte. Das ist hier gemerkt (`_nativeRestored`), damit
 * `_doClose()` es nicht fuer eine Wahl des Aufrufers haelt und sein Nachfassen
 * (Ausloeser weggerendert) trotzdem scharf stellt.
 */
function _leaveTopLayer(overlay) {
  if (typeof overlay?.close !== 'function' || !overlay.open) {
    _syncTopLayerGuests(overlay);
    return;
  }
  const vorher = document.activeElement;
  overlay._closingByModal = true;
  overlay.close();
  const nachher = document.activeElement;
  if (nachher && nachher !== vorher && !overlay.contains(nachher)) overlay._nativeRestored = nachher;
  _syncTopLayerGuests(overlay);
}

/**
 * Der Browser hat einen Dialog geschlossen, den niemand hier geschlossen hat:
 * ein Close-Request, dessen `cancel` sich nicht abbrechen liess (Zurueck-Geste
 * auf Android ohne Aktivierung, siehe onEscape). Der Knoten steht noch im
 * Dokument, nur nicht mehr in der Top-Layer. Er kommt zurueck - in der alten
 * Reihenfolge, geparkte zuerst - und der Request laeuft danach regulaer durch
 * `closeModal()`, damit ungespeicherte Eingaben ihre Rueckfrage bekommen.
 */
function _onNativeClose(event) {
  const overlay = event.currentTarget;
  if (overlay._closingByModal || !overlay.isConnected) return;
  if ((overlay._restacking ?? 0) > 0) { overlay._restacking -= 1; return; }
  const fokus = document.activeElement;
  const stapel = [...document.querySelectorAll('dialog.modal-overlay')]
    .filter((d) => d.isConnected && !d._closingByModal && typeof d.showModal === 'function');
  for (const d of stapel) {
    if (d.open) { d._restacking = (d._restacking ?? 0) + 1; d.close(); }
  }
  for (const d of stapel) _enterTopLayer(d);
  if (fokus?.isConnected && activeOverlay?.contains(fokus)) fokus.focus();
  _syncTopLayerGuests();
  if (overlay === activeOverlay && modalState === 'open') closeModal();
}

/**
 * UNTER REDUZIERTER BEWEGUNG BLENDET DAS MODAL UEBER statt hart zu schneiden
 * (Critique 2026-10-16) - nur Opacity, keine Bewegung. Per Web Animations,
 * nicht per CSS: die globale Sperre (reset.css) setzt jede CSS-Animation auf
 * 0s, und eine CSS-Transition griffe nicht - die Einfahrt haelt Opacity per
 * `forwards` fest, und der Wechsel aus der Top-Layer im Ausgang verwirft den
 * Vorher-Stil (gemessen, Chrome 155: kein Transition-Objekt).
 * @returns {Animation|null}
 */
function _reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _fade(overlay, from, to) {
  // GRUND UND TAFEL, NICHT DER DIALOG (#1801): eine Deckkraft unter 1 am
  // Dialog machte ihn zur Backdrop Root, und der Blur des Grunds saehe die
  // Seite nicht mehr. Die beiden Kinder blenden gemeinsam; das Ende der
  // Tafel ist das Ende der Blende.
  const timing = {
    duration: durationToken('--duration-sm', 150),
    easing: easingToken('--ease-out'),
    fill: to === 0 ? 'forwards' : 'none',
  };
  let last = null;
  for (const el of [overlay?.querySelector?.('.modal-overlay__scrim'), overlay?.querySelector?.('.modal-panel')]) {
    if (typeof el?.animate === 'function') last = el.animate([{ opacity: from }, { opacity: to }], timing);
  }
  return last;
}

/** Close-Request (Esc ohne unseren Handler, Zurueck-Geste): durch closeModal(). */
function _onCancel(event) {
  event.preventDefault();
  if (_escKeptBelow) { _escKeptBelow = null; return; }
  if (event.currentTarget === activeOverlay && modalState === 'open') closeModal();
}

// --------------------------------------------------------
// Swipe-to-Close (Mobile)
// --------------------------------------------------------

// EINE Sheet-Grammatik fuer Dialog und Mehr-Blatt (utils/sheet-drag.js,
// Re-Critique 2026-09-27): 1:1 mitgehen, schliessen ab 80px Weg ODER
// Flick-Tempo > 0.5px/ms, sonst zurueckfedern (`--duration-lg` + `--ease-out`),
// nach oben ein Gummiband. Richtungssperre (#981) und das Aufraeumen per rAF
// (iOS-Click-Konvertierung) stehen dort.
//
// Bei ungespeicherten Aenderungen schliesst `closeModal()` nicht, sondern
// fragt nach - dann federt die Tafel in ihre Ruhelage unter die Rueckfrage,
// statt am alten Zug stehen zu bleiben.
//
// Der Grund folgt dem Zug (#1801): er ist ein eigener Knoten unter der Tafel
// (`.modal-overlay__scrim`), also nimmt seine Deckkraft die Tafel nicht mit.
function _wireSheetSwipe(panel) {
  return wireSheetDrag(panel, {
    scroller: () => panel.querySelector('.modal-panel__body') ?? panel,
    dim: () => panel.parentElement?.querySelector(':scope > .modal-overlay__scrim') ?? null,
    onDismiss: () => {
      const dirty = isFormDirty(panel);
      closeModal();
      return !dirty;
    },
  });
}

// --------------------------------------------------------
// Suspend/Restore für Dialoge über einem offenen Modal (Audit 1.5)
//
// Das Shared-Modal kennt bewusst kein Stacking: ein Dialog nutzt denselben
// Overlay-Slot wie das Formular darunter. Damit der nachfolgende
// openModal()-Aufruf (in confirmModal) das Formular nicht wegräumt, wird es
// kurzzeitig aus dem aktiven Slot gelöst und in einem Token geparkt. Diese drei
// Helfer kapseln die Übergänge, statt die Globals frei „auszuleihen".
//
// Genutzt vom Dirty-Guard („Änderungen verwerfen?") und von confirmOverModal.
// --------------------------------------------------------

/**
 * Wartet, bis ein Overlay wirklich aus dem DOM ist. `closeModal` kehrt auf
 * Mobile schon zurück, wenn die 200-ms-Exit-Animation *startet* - der Dialog
 * hängt dann noch bis zu 400 ms im Baum. Wer in diesem Fenster das Modal
 * darunter zurückholt, hat kurzzeitig zwei Dialoge mit derselben Titel-id und
 * einen Escape-Handler, der bereits gegen das wiederhergestellte Formular läuft.
 */
function _awaitOverlayRemoval(node, timeout = 600) {
  if (!node?.isConnected) return Promise.resolve();
  return new Promise((resolve) => {
    let fallback;
    const done = () => {
      clearTimeout(fallback);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => { if (!node.isConnected) done(); });
    observer.observe(document.body, { childList: true });
    // Reißleine: ohne sie hinge das Modal darunter für immer im Suspend, falls
    // das Entfernen ausbleibt (abgebrochene Animation, entkoppelter Knoten).
    fallback = setTimeout(done, timeout);
  });
}

function _suspendActiveModal() {
  const overlay = activeOverlay;
  // previouslyFocused wandert mit: der Dialog darüber setzt es auf sein eigenes
  // Auslöser-Element und nullt es beim Schließen. Ohne das Parken verlöre ein
  // fortlebendes Modal seinen Focus-Restore auf die Zeile, aus der es kam.
  // Die Titel-id muss mit: beide Panels tragen `aria-labelledby="shared-modal-
  // title"`, und der Browser löst eine doppelt vergebene id auf das ERSTE
  // Element im DOM auf - das geparkte Formular. Ohne das Ablegen sagen
  // Screenreader den Dialog mit dem Titel des Formulars darunter an (gemessen:
  // „Wirklich löschen?" wurde als „Test-Formular" vorgelesen).
  const title = overlay.querySelector('#shared-modal-title');
  const panel = overlay.querySelector('.modal-panel');
  const token = {
    overlay,
    id: overlay.id,
    title,
    titleId: title?.id ?? null,
    // Fällt der Dialog in die 150-ms-Lücke vor dem ersten Snapshot, entsteht er
    // hier: das gleich folgende openModal löscht den ausstehenden Timer, und ein
    // null-Snapshot schaltet isFormDirty() für die restliche Lebensdauer des
    // Formulars ab - der Dirty-Guard wäre danach still tot.
    snapshot: _initialFormSnapshot ?? (panel ? _takeDirtyBase(panel) : null),
    // Mit demselben Grund wie der Snapshot daneben: der Dialog, der sich gleich
    // darüberlegt, läuft selbst durch openModal() und setzt den Wächter dabei
    // auf seinen Standardwert. Ohne dieses Merken käme ein geparktes
    // Ansichtsblatt (dirtyGuard:false) mit eingeschaltetem Wächter zurück.
    dirtyGuard: _dirtyGuardEnabled,
    restoreFocus: previouslyFocused,
    // Zwei verschiedene Fokusziele: `restoreFocus` zeigt nach draußen (die Zeile,
    // aus der das Modal kam) und gilt für dessen späteres Schließen; `trigger`
    // ist der Knopf IM Modal, der den Dialog auslöste. inert entzieht ihm sofort
    // den Fokus, also muss er beim Zurückholen wieder gesetzt werden.
    trigger: document.activeElement,
  };
  if (title) title.removeAttribute('id');
  overlay.removeAttribute('id');
  // Das geparkte Modal bleibt sichtbar unter dem Dialog liegen. `inert` nimmt
  // es aus dem Accessibility-Baum und der Tab-Reihenfolge: Screenreader lesen
  // sonst durch den Dialog hindurch das Formular darunter vor, als wäre es
  // bedienbar. Der Focus-Trap des Dialogs allein deckt das nicht ab - er hält
  // den Tab-Fokus, aber nicht den Lesecursor.
  overlay.inert = true;
  activeOverlay = null;
  modalState = 'confirming';
  return token;
}

/**
 * Geparkte Dialoge, deren Ablauf inzwischen fertig ist (#1997): closeModal({
 * context }) traf sie unter einer Rueckfrage an. Beim Zurueckholen gehen sie
 * zu; bestaetigt der Nutzer stattdessen das Verwerfen, gehen sie ohnehin zu.
 */
const _closeOnResume = new WeakSet();

/** Geparkt heisst: noch im Dokument und `inert` - das setzt nur _suspendActiveModal. */
function _isParked(overlay) {
  return Boolean(overlay?.isConnected) && overlay.inert === true && overlay !== activeOverlay;
}

// Dialog beendet, Modal darunter lebt weiter → exakt wiederherstellen.
function _resumeSuspendedModal({ overlay, id, title, titleId, snapshot, dirtyGuard = true, restoreFocus, trigger }) {
  /* ES GIBT NICHTS ZURUECKZUHOLEN, WENN DER KNOTEN WEG IST (#871).
   *
   * Sitzungsende und echte Navigation raeumen alle Kaesten aus dem Dokument,
   * auch die geparkten - der Bestaetigungs-Ablauf darueber laeuft aber in
   * einer eigenen Kette weiter und kam kurz darauf hier an. Er setzte dann
   * `activeOverlay` auf einen entfernten Knoten, `modalState` auf 'open' und
   * die Scroll-Sperre auf die naechste Seite: die Anmeldeseite blieb
   * unscrollbar, mit einem Escape-Handler auf einem Phantom, und heilte erst,
   * wenn irgendwo das naechste Modal aufging. */
  if (!overlay.isConnected) {
    _syncOverlayRegistration();
    return;
  }
  if (id) overlay.id = id;
  if (title && titleId) title.id = titleId;
  // Vor dem Setzen des Fokus: ein inertes Element nimmt keinen an.
  overlay.inert = false;
  activeOverlay = overlay;
  // Geparkt war er weiter offen - es sei denn, der Browser hat ihn mit der
  // Rueckfrage zusammen geschlossen (ein Close-Request ohne Aktivierung
  // schliesst die ganze Gruppe). Dann zurueck in die Top-Layer; die Gaeste
  // (Toasts) ziehen zu ihm zurueck.
  _enterTopLayer(overlay);
  _initialFormSnapshot = snapshot;
  _dirtyGuardEnabled = dirtyGuard;
  previouslyFocused = restoreFocus;
  document.body.style.overflow = 'hidden';
  modalState = 'open';
  // Der Dialog hat den Escape-Handler beim Schließen abgemeldet; ohne das
  // erneute Anmelden reagiert das wiederhergestellte Modal nicht mehr auf Esc.
  bindEscape();
  // Das Formular ist wieder da - und damit auch sein Anspruch auf die
  // Zurueck-Geste (#871). Hat der Bestaetigungsdialog den Eintrag beim
  // Schliessen mitgenommen, kommt er hier zurueck.
  _syncOverlayRegistration();
  if (window.yuvomi?.setThemeColor) {
    window.yuvomi.setThemeColor(OVERLAY_THEME_COLOR, OVERLAY_THEME_COLOR);
  }
  // Fokus zurück auf den auslösenden Knopf - nur wenn er noch zu diesem Modal
  // gehört, sonst zöge ein Element von außerhalb den Fokus aus dem Dialog heraus.
  if (trigger?.isConnected && overlay.contains(trigger) && typeof trigger.focus === 'function') {
    trigger.focus();
  }
  // Waehrend er geparkt lag, ist sein Speichern fertig geworden (#1997).
  if (_closeOnResume.delete(overlay)) closeModal({ force: true });
}

/**
 * Stellt die Frage über einem bereits geparkten Modal und kehrt erst zurück,
 * wenn der Dialog aus dem DOM verschwunden ist. Beide Aufrufer (Dirty-Guard und
 * confirmOverModal) brauchen genau das: solange der Dialog noch hängt, wäre das
 * Zurückholen ein Zustand mit zwei Dialogen, doppelter Titel-id und einem
 * Escape-Handler, der schon auf das Formular zeigt.
 *
 * Der Dialog entsteht synchron im Promise-Executor von confirmModal, deshalb
 * lässt sich sein Overlay direkt nach dem Aufruf greifen.
 */
async function _confirmOverSuspended(message, opts, suspended) {
  return _askOverSuspended(() => confirmModal(message, opts), suspended);
}

/**
 * Derselbe Ablauf für einen Dialog, den der Aufrufer selbst baut (#1284): `ask`
 * öffnet ihn über openModal und liefert ein Promise auf die Antwort. Auch hier
 * entsteht der Dialog synchron, also greift der Overlay-Zugriff direkt danach.
 */
async function _askOverSuspended(ask, suspended) {
  const pending = ask();
  const dialogOverlay = document.getElementById('shared-modal-overlay');
  try {
    const answer = await pending;
    await _awaitOverlayRemoval(dialogOverlay);
    return answer;
  } catch (err) {
    // Ein geparktes Modal ist inert und damit unbedienbar. Scheitert der Dialog,
    // muss es zurückkommen - sonst steht die App bis zum Reload.
    _resumeSuspendedModal(suspended);
    throw err;
  }
}

// Nutzer bestätigt das Verwerfen → dirty Modal wieder zum aktiven Overlay
// machen, damit die nachfolgende Schließ-Logik es regulär abräumt. Der geparkte
// Fokus kommt mit, sonst läuft der Focus-Restore in _doClose ins Leere.
function _discardSuspendedModal({ overlay, restoreFocus }) {
  // Geht ohnehin zu - ein gemerktes spaetes Schliessen ist damit erledigt.
  _closeOnResume.delete(overlay);
  // Auch der Weg nach draußen hebt inert auf: das Overlay durchläuft noch die
  // reguläre Schließ-Logik samt Animation und soll dabei kein Sonderzustand sein.
  overlay.inert = false;
  activeOverlay = overlay;
  previouslyFocused = restoreFocus;
}

// --------------------------------------------------------
// _doClose - gemeinsame Cleanup-Logik
// --------------------------------------------------------

/**
 * WOHIN DER FOKUS BEIM SCHLIESSEN GEHT - der gemerkte Ausloeser kann weg sein.
 *
 * Ein Handler, der den Bereich neu rendert, aus dem das Modal kam, tauscht den
 * Knopf aus, der es geoeffnet hat. `.focus()` auf dem abgehaengten Knoten ist
 * ein No-op - ohne Fehler, ohne Spur: der Fokus faellt auf `document.body`, und
 * wer mit Tastatur oder Screenreader bedient, verliert seine Position.
 *
 * DAS PASSIERT AN ZWEI STELLEN, und sie brauchen verschiedene Antworten:
 *
 *   A) Der Handler rendert, WAEHREND das Modal offen ist. Beim Schliessen ist
 *      der gemerkte Knoten schon tot - der Wiederfinder unten greift.
 *      Gemessen: 1 Stelle (der Kategorie-Manager im Budget).
 *   B) Der Handler rendert, NACHDEM geschlossen wurde - `closeModal()` und in
 *      der Zeile darauf `renderGrid()`. Der Restore war korrekt und wird eine
 *      Zeile spaeter weggerendert. Gemessen: 30 Stellen, davon 19 synchron.
 *      Dagegen hilft nur das Nachfassen in `_refocusIfDropped`.
 *
 * Der Wiederfinder haengt nicht an der id: die typischen Ausloeser sind
 * Listenzeilen und Rasterzellen, und die tragen `data-id` oder `data-action`,
 * keine id. Von den sieben Nutzern des Kategorie-Managers geben nur drei ihrem
 * Ausloeser eine id - bei den 83 Modal-Oeffnungen im Projekt ist das die
 * Ausnahme, nicht die Regel.
 *
 * Bleibt nichts wiederzufinden, ist die Seitenwurzel der Halt - kein guter
 * Platz, aber ein Platz IN der Seite, von dem aus Tab weiterlaeuft.
 * `document.body` ist dagegen kein Fokusziel, sondern das Fehlen eines Fokus.
 *
 * EIN VERSTECKTER POPOVER-EINTRAG IST KEIN FALL DAVON, obwohl er danach
 * aussieht: `utils/popover-menu.js` blendet sein Menue nur aus, ein Eintrag
 * meldet also weiter `isConnected === true`. Gemessen (Chrome 152, Maus wie
 * Tastatur) gibt `hidePopover()` den Fokus aber schon in der Capture-Phase des
 * Klicks an den TRIGGER zurueck - also bevor der Seiten-Handler das Modal
 * oeffnet. Der gemerkte Ausloeser ist damit nie der Menueintrag, sondern der
 * Trigger, und der ist sichtbar und fokussierbar. Eine Sichtbarkeitspruefung
 * hier waere ein Layout-Read auf jedem Schliessen ohne einen Fall, der ihn
 * braucht.
 *
 * `rememberFocus` und `focusRestoreTarget` sind fuer die Sonden in
 * `test/test-modal-utils.js` exportiert: die Entscheidung laesst sich so ohne
 * den vollen Oeffnen-Schliessen-Pfad messen, der ein echtes DOM braeuchte.
 */
export function rememberFocus(el) {
  if (!el || !el.tagName || typeof el.focus !== 'function') return null;
  // `document.body` IST KEIN FOKUSZIEL, sondern das Fehlen eines - und es kommt
  // durch jede Typpruefung, weil es `focus()` von HTMLElement erbt (gemessen:
  // `typeof document.body.focus === 'function'`). Als Merker waere es toedlich:
  // `isConnected` ist immer wahr und der Fokus liegt bereits darauf, also braeche
  // jedes spaetere Nachfassen an seiner ersten Wache ab - das Gegenteil dessen,
  // wofuer diese Schicht da ist.
  //
  // Der Fall ist Alltag, nicht Ausnahme: oeffnet ein Dialog aus einer Zeile, die
  // selbst nicht fokussierbar ist (ein `<div>`, ein `<tr>`), steht `activeElement`
  // auf `body` (Review zu #1070).
  if (el === document.body || el.tagName === 'BODY') return null;
  return {
    el,
    id: el.id || null,
    tag: el.tagName,
    // Als Attribut lesen: bei SVG ist `className` ein Objekt, kein String.
    cls: el.getAttribute?.('class') ?? null,
    data: el.dataset ? { ...el.dataset } : {},
    // DIE ZEILE, IN DER DER KNOPF STECKT (Review zu #1070). Bei Listenzeilen
    // traegt nicht der Knopf die Identitaet, sondern sein Vorfahre:
    // `<div class="list-row" data-id="42"><button data-action="open-detail">`
    // in inventory, dasselbe in pantry. Ohne diesen Anker sehen alle Zeilen
    // gleich aus - gleicher Tag, gleiche Klasse, gleiches `data-action` - und
    // der Fokus landete nach dem Speichern zuverlaessig auf der ERSTEN Zeile.
    rowId: el.closest?.('[data-id]')?.dataset?.id ?? null,
  };
}

/**
 * Denselben Knopf im frisch gebauten Baum wiederfinden.
 *
 * Ueber die id, wo es eine gibt. Sonst ueber die data-Attribute: eine
 * Listenzeile heisst `.note-card[data-id="42"]`, eine Kalenderzelle
 * `[data-action="add-meal"][data-date][data-type]` - die id fehlt dort, die
 * Identitaet steht in den data-Werten. Verglichen wird in JS statt per
 * Selektor-String, weil ein Attributwert Anfuehrungszeichen enthalten darf und
 * ein gebauter Selektor daran zerbraeche.
 *
 * Ohne data-Attribute wird NICHT gesucht: Tag und Klasse allein treffen
 * irgendeinen Knopf derselben Sorte, und ein falsches Fokusziel ist schlimmer
 * als keines.
 */
function _findAgain(memo) {
  if (memo.id) {
    const byId = document.getElementById(memo.id);
    if (byId) return byId;
  }
  const alle = Object.keys(memo.data);
  if (!alle.length && memo.rowId === null) return null;
  // ZWEI ANLAEUFE, weil nicht jedes data-Feld Identitaet traegt. Der
  // Umbenennen-Knopf einer Teilaufgabe fuehrt `data-action` und `data-id` -
  // aber auch `data-title`, und genau das aendert sich beim Umbenennen. Ein
  // Vergleich, der Gleichheit ALLER Felder verlangt, findet danach nichts mehr
  // (Review zu #1070).
  //
  // Erst also der genaue Treffer, dann der auf den identitaetstragenden Feldern.
  // Die Reihenfolge ist wichtig: wo alle Felder passen, ist es sicher dasselbe
  // Element; die zweite Runde ist der Rueckfall, nicht die Regel. Und weil
  // beide Runden auf Eindeutigkeit bestehen, wird dabei nichts geraten.
  // IDENTITAET HEISST NICHT IMMER `id`. Das Repo fuehrt ein Dutzend eigener
  // Schluesselfelder - `data-meal-id`, `data-entry-id`, `data-expense-id` und
  // weitere -, die als `dataset.mealId` ankommen. Ein Filter, der nur `id`
  // kennt, haelt eine Mahlzeitenkarte fuer identitaetslos und laesst den
  // Rueckfall auf die Wurzel laufen, obwohl der Knopf eindeutig bestimmt waere
  // (Review zu #1070).
  const istIdentitaet = (k) => k === 'action' || k === 'id' || /Id$/.test(k);
  const identitaet = alle.filter(istIdentitaet);
  const engerAlsAlle = identitaet.length && identitaet.length < alle.length;
  // DIE KLASSE IST DARSTELLUNG, KEINE IDENTITAET - im dritten Anlauf faellt sie
  // weg. Eine Mahlzeitenkarte traegt `meal-card__open--with-thumb`, sobald das
  // Rezept ein Bild hat; wer beim Bearbeiten eines hinzufuegt, aendert damit die
  // Klasse des Knopfes, ueber den er gekommen ist (Review zu #1070). Erst der
  // genaue Treffer, dann der ohne veraenderliche Nutzlast, dann der ohne
  // Darstellung - jeder besteht auf Eindeutigkeit, es wird also nichts geraten.
  const runden = [
    { keys: alle, mitKlasse: true },
    ...(engerAlsAlle ? [{ keys: identitaet, mitKlasse: true }] : []),
    // Der klassenlose Anlauf nur bei STARKER Identitaet: eine Aktion UND ein
    // Schluesselfeld. Ein Schluessel allein reicht nicht - dieselbe Nummer steht
    // in einer anderen Liste fuer etwas anderes, und ohne die Klasse waeren die
    // beiden nicht mehr zu unterscheiden.
    ...(identitaet.includes('action') && identitaet.some((k) => k !== 'action')
      ? [{ keys: identitaet, mitKlasse: false }]
      : []),
  ];
  for (const { keys, mitKlasse } of runden) {
    const treffer = _kandidaten(memo, keys, mitKlasse);
    if (treffer.length === 1) return treffer[0];
  }
  return null;
}

/** Die Elemente, die in Tag, den gegebenen data-Feldern, der Zeile und optional der Klasse passen. */
function _kandidaten(memo, keys, mitKlasse) {
  const treffer = [];
  for (const kandidat of document.getElementsByTagName(memo.tag)) {
    if (mitKlasse && kandidat.getAttribute('class') !== memo.cls) continue;
    if (!keys.every((k) => kandidat.dataset[k] === memo.data[k])) continue;
    if ((kandidat.closest?.('[data-id]')?.dataset?.id ?? null) !== memo.rowId) continue;
    treffer.push(kandidat);
    // Zwei reichen als Beweis, dass es nicht eindeutig ist.
    if (treffer.length > 1) break;
  }
  // MEHRDEUTIG HEISST NEIN. Bleiben mehrere Kandidaten, ist keiner davon
  // nachweislich der gesuchte, und ein falsches Fokusziel ist schlimmer als
  // keines: es setzt den Nutzer an eine Stelle, die er nicht gewaehlt hat.
  // Dann lieber die Seitenwurzel.
  return treffer;
}

/**
 * Ein Fokusziel, das den Fokus auch ANNIMMT.
 *
 * Betrifft genau ein Element: die Seitenwurzel. Alles andere, was diese Weiche
 * zurueckgibt, ist ein Knopf oder eine Zeile und damit von Natur aus
 * fokussierbar.
 *
 * `renderAppShell()` in router.js setzt `tabIndex = -1` - aber nur fuer die
 * Routen mit App-Shell. Die fuenf Auth-Seiten (login, setup, join,
 * forgot-password, reset-password) rendern ihr eigenes
 * `<main id="main-content">` ohne das Attribut, und dort ist `.focus()` ein
 * No-op: gemessen faellt der Fokus auf `document.body` - genau der stille
 * Ausfall, den diese Weiche verhindern soll, nur eine Route weiter.
 *
 * Erreichbar ist das ueber ein Sitzungsende bei offenem Dialog:
 * `closeAllOverlays()` schliesst mit `force`, und auf Mobil haengt `_doClose`
 * an `animationend` beziehungsweise einem 400-ms-Timer - es kann also laufen,
 * nachdem `/login` schon gerendert hat.
 *
 * `hasAttribute` und nicht `el.tabIndex`: das Property liest auch ohne Attribut
 * `-1` und kann die beiden Faelle gar nicht unterscheiden (gemessen).
 */
function _focusable(el) {
  if (el && el.id === PAGE_ROOT_ID && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  return el;
}

export function focusRestoreTarget(memo) {
  if (!memo) return null;
  if (memo.el?.isConnected) return memo.el;
  // Durch `_focusable` MUESSEN beide Wege: war der Ausloeser selbst die
  // Seitenwurzel, liefert das Wiederfinden sie direkt zurueck, und ein
  // Rueckgabewert daran vorbei haette wieder kein tabindex (Review zu #1069).
  return _focusable(_findAgain(memo) ?? document.getElementById(PAGE_ROOT_ID));
}

/**
 * NACHFASSEN, WENN DIE SEITE DAS FOKUSZIEL GLEICH DANACH WEGRENDERT.
 *
 * 30 Stellen im Projekt rufen `closeModal()` und rendern in der Zeile darauf
 * neu. Der Restore oben ist dann korrekt und trotzdem wertlos: er sitzt auf
 * einem Knoten, den der naechste `replaceChildren()` entfernt. Gemessen landet
 * der Fokus danach auf `document.body`.
 *
 * BEWUSST NACHTRAEGLICH UND NICHT VERZOEGERT. Den Restore generell einen Frame
 * spaeter zu setzen haette den Normalfall aller 83 Modal-Oeffnungen angefasst,
 * fuer einen Fehler, der nur einen Teil davon trifft. So bleibt der haeufige
 * Weg Zeichen fuer Zeichen der alte, und nur der kaputte bekommt eine zweite
 * Runde.
 *
 * Drei Bedingungen, und jede einzelne verhindert einen Schaden:
 *   - das Ziel ist wirklich verschwunden (sonst gab es nichts zu reparieren),
 *   - der Fokus liegt auf `body` (hat die Seite selbst etwas fokussiert, ist
 *     ihre Wahl die bessere - wir wuerden sie ueberschreiben),
 *   - es ist kein Modal offen (sonst risse das Nachfassen den Fokus aus einem
 *     Dialog, der in derselben Geste aufgegangen ist).
 *
 * Der asynchrone Fall bleibt offen: rendert die Seite erst nach einem `await`
 * (11 der 30 Stellen), ist dieser Frame laengst vorbei. Dort muss die Seite
 * selbst nachziehen; ein laengeres Warten waere geraten und nicht gemessen.
 */
/**
 * Fokussieren UND nachsehen, ob es gewirkt hat.
 *
 * Der ganze Vorgang hier dreht sich darum, dass `.focus()` still fehlschlaegt.
 * Genau das kann auch ein Ersatz: der neu gebaute Knopf ist vielleicht
 * `disabled` (in rewards wird der Einloesen-Knopf es, sobald die Punkte nicht
 * mehr reichen) oder ausgeblendet. Dann ist er der eindeutige Treffer, nimmt
 * den Fokus aber nicht an - und ohne diese Rueckmeldung wuesste niemand davon.
 *
 * Nur die Seitenwurzel bekommt `preventScroll`: sie IST der Scrollport
 * (#main-content == .app-content), ein Fokus mit Scroll risse die
 * wiederhergestellte Position nach oben.
 */
function _fokussiere(el) {
  if (!el || typeof el.focus !== 'function') return false;
  el.focus(el.id === PAGE_ROOT_ID ? { preventScroll: true } : undefined);
  return document.activeElement === el;
}

/**
 * Ein Ziel setzen und, wenn es nicht angenommen wird, auf die Wurzel ausweichen.
 */
function _fokussiereMitRueckfall(el) {
  if (_fokussiere(el)) return el;
  const wurzel = _focusable(document.getElementById(PAGE_ROOT_ID));
  if (wurzel && wurzel !== el && _fokussiere(wurzel)) return wurzel;
  return null;
}

function _tryRefocus(memo, ziel) {
  // WAR DAS ZIEL UNSER EIGENER RUECKFALL, darf ein spaeterer Lauf es ersetzen.
  // Ein Loader, der den Ausloeser sofort gegen ein Skelett tauscht und ihn erst
  // nach der Abfrage neu baut, laesst den Frame-Lauf auf der Wurzel landen; ohne
  // diese Ausnahme haetten `isConnected` und `activeElement` danach jeden
  // weiteren Versuch abgewiesen, und der Fokus bliebe an der Seitenwurzel
  // haengen, obwohl der Knopf laengst wieder da ist (Review zu #1070).
  const istRueckfall = ziel.id === PAGE_ROOT_ID;
  // NICHT `isConnected` FRAGEN, SONDERN OB DAS ZIEL DEN FOKUS NOCH HAELT. Ein
  // Knoten kann im Dokument haengen und trotzdem unbedienbar sein: der
  // Loesch-Weg der Aufgaben setzt die Zeile auf `display: none`, statt sie zu
  // entfernen (`deleteTaskWithUndo` in components/task-detail.js), und der Fokus
  // faellt dabei auf `body`, waehrend der Knoten verbunden bleibt. Dieselbe
  // Familie wie ein `disabled` gewordener Ersatz - beide melden Anwesenheit und
  // nehmen keinen Fokus (Review zu #1070).
  if (ziel.isConnected && document.activeElement === ziel && !istRueckfall) return;
  if (activeOverlay) return;
  // Hat die Seite selbst etwas fokussiert, gilt ihre Wahl. Der Fokus auf dem
  // Ziel selbst zaehlt hier als "noch niemand hat gewaehlt": beim Rueckfall darf
  // ein besseres Ziel ihn abloesen.
  const frei = document.activeElement === document.body || document.activeElement === ziel;
  if (!frei) return;
  const ersatz = focusRestoreTarget(memo);
  if (!ersatz) return;
  // AUCH WENN DER ERSATZ DASSELBE ELEMENT IST. Bis hierher kommt nur, wer den
  // Fokus NICHT haelt - ein erneuter Versuch bewegt also nichts, was jemand
  // gewaehlt haette. Genau das war die Luecke: eine versteckte Zeile bleibt
  // verbunden, `focusRestoreTarget` gibt sie darum unveraendert zurueck, und
  // ein `ersatz === ziel`-Abbruch haette den Rueckfall auf die Wurzel nie
  // erreicht (Review zu #1070). `_fokussiereMitRueckfall` prueft die Wirkung
  // und weicht aus, wenn der Fokus nicht ankommt.
  const gesetzt = _fokussiereMitRueckfall(ersatz);
  // DAS ERGEBNIS ZURUECKSCHREIBEN. Sonst zeigt der Merker weiter auf das alte,
  // inzwischen abgehaengte Element, waehrend der Fokus laengst auf der Wurzel
  // sitzt - und der naechste Lauf urteilt ueber ein Ziel, das es nicht mehr
  // gibt. Genau so verlor der spaetere `refocusAfterRender()` den frisch
  // wieder aufgebauten Knopf (Review zu #1070).
  if (gesetzt && _lastRestore) _lastRestore.ziel = gesetzt;
}

function _refocusIfDropped(memo, ziel) {
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => _tryRefocus(memo, ziel));
}

/**
 * DERSELBE GRIFF FUER DIE SEITE, DIE ERST NACH EINEM `await` RENDERT.
 *
 * `closeModal(); await loadX(); renderY();` - da ist der Frame aus
 * `_refocusIfDropped` laengst vorbei, und die Schicht kann nicht wissen, wann
 * das Laden fertig ist. Nur die Seite weiss das, also ruft sie hier an.
 * Gemessen betrifft das 11 der 30 Stellen (split-expenses 4, budget 3,
 * documents 2, housekeeping 1, tasks 1).
 *
 * DER AUFRUF IST IMMER SICHER. Es sind dieselben drei Wachen wie beim
 * automatischen Nachfassen: ist nichts kaputtgegangen, hat die Seite selbst
 * etwas fokussiert oder steht schon wieder ein Dialog offen, tut er nichts.
 * Man kann ihn also hinter jedes Rendern nach einem Schliessen setzen, ohne je
 * Stelle beweisen zu muessen, dass sie bricht - und ohne dass ein zweiter
 * Fokussprung entsteht, wo alles heil blieb.
 *
 * Kein `await` noetig: der Fokus wird gesetzt, sobald der Aufruf laeuft.
 */
export function refocusAfterRender() {
  if (!_lastRestore) return;
  // DER MERKER GILT FUER SEINEN GANZEN SCHLIESSVORGANG, nicht fuer einen Aufruf.
  //
  // Ein Vorgang kann mehrfach neu aufbauen: das Loeschen eines Budget-Plans
  // rendert einmal sofort und ein zweites Mal, wenn jemand den Toast-Rueckgaengig
  // drueckt. Beide Male ist derselbe Knopf gemeint. Ein Merker, der beim ersten
  // Gebrauch verfaellt, macht den zweiten Weg wirkungslos (Review zu #1070).
  //
  // Verworfen wird er stattdessen gezielt - beim naechsten Oeffnen und ueber
  // `forgetRestore()`, das jeder aufruft, der etwas AN DIESER SCHICHT VORBEI
  // schliesst. Sonst wirkte er dort weiter, wo sie gar nicht beteiligt war.
  _tryRefocus(_lastRestore.memo, _lastRestore.ziel);
}

/**
 * DEN FOKUS UEBER EINEN NEUAUFBAU TRAGEN, DEN KEIN SCHLIESSEN AUSLOEST (#1083).
 *
 * `refocusAfterRender()` gehoert zu einem Schliessvorgang: sein Merker ist der
 * Ausloeser des letzten Dialogs. Das Loeschen im Kalender rendert aber ein
 * zweites Mal, wenn das Undo-Fenster ablaeuft - Sekunden spaeter und ausserhalb
 * jedes Handlers (`scheduleCalendarDeleteWithUndo` in utils/calendar-delete.js).
 * Bis dahin hat der Nutzer weitergearbeitet: gemessen in der Agenda stand der
 * Fokus auf der naechsten Zeile, `renderView()` tauschte `#cal-body` aus, und er
 * fiel auf BODY. Der Merker des Dialogs zeigte auf die geloeschte Zeile und
 * haette die Seitenwurzel geliefert, nicht die Zeile, auf der der Nutzer stand.
 *
 * Gemerkt wird deshalb DIREKT VOR dem Neuaufbau, was den Fokus haelt, und
 * dasselbe Element danach im neuen Baum wiedergefunden. Die Wachen sind die des
 * Nachfassens: war vorher nichts fokussiert, haelt das Element den Fokus noch,
 * hat der Neuaufbau selbst etwas fokussiert oder steht ein Dialog offen, tut der
 * Aufruf nichts. Der Merker des letzten Schliessens bleibt unberuehrt.
 *
 * @param {() => void} render  der synchrone Neuaufbau
 * @returns {HTMLElement|null} das Element, das den Fokus bekam, sonst null
 */
export function renderKeepingFocus(render) {
  const memo = rememberFocus(document.activeElement);
  render();
  if (!memo || activeOverlay) return null;
  if (memo.el.isConnected && document.activeElement === memo.el) return null;
  if (document.activeElement !== document.body) return null;
  return _fokussiereMitRueckfall(focusRestoreTarget(memo));
}

/**
 * Den Merker verwerfen, weil etwas an dieser Schicht vorbei geschlossen wurde.
 *
 * `closeDetailView()` kehrt im Popover-Zweig frueh zurueck, ohne `closeModal()`
 * anzufassen. Ohne diesen Ruf bliebe der Merker des vorigen, unbeteiligten
 * Dialogs stehen, und ein spaeteres Nachfassen setzte den Fokus in dessen
 * Zusammenhang - ein falsches Ziel ist schlimmer als keines.
 */
export function forgetRestore() {
  _lastRestore = null;
}

/**
 * Den Fokus nach einem Schliessen AN dieser Schicht vorbei zurueckgeben - mit
 * demselben Merker wie `_doClose` (#1083).
 *
 * Das Popover der Detailansicht schliesst ohne `closeModal()`. Bisher verwarf es
 * dabei nur den fremden Merker: der Fokus fiel mit dem entfernten Popover auf
 * `body`, und ein `refocusAfterRender()` nach dem Neuaufbau hatte nichts, worauf
 * es sich beziehen konnte. Hier laeuft derselbe Weg wie beim Modal - Ziel
 * bestimmen, mit Rueckfall fokussieren, Merker setzen, einen Frame spaeter
 * nachfassen.
 *
 * @param {ReturnType<typeof rememberFocus>} memo  der beim Oeffnen gemerkte Ausloeser
 * @returns {HTMLElement|null} das Element, das den Fokus tatsaechlich bekam
 */
export function restoreFocusAfterClose(memo) {
  _lastRestore = null;
  if (!memo) return null;
  const gesetzt = _fokussiereMitRueckfall(focusRestoreTarget(memo));
  if (gesetzt) {
    _lastRestore = { memo, ziel: gesetzt };
    _refocusIfDropped(memo, gesetzt);
  }
  return gesetzt;
}

/**
 * Wartende auf das Ende EINES Overlays, je Knoten. Aufgeloest wird in
 * `_doClose()` nach dem Focus-Restore - wer danach fokussiert, gewinnt.
 * @type {Map<HTMLElement, Array<() => void>>}
 */
const _closeWaiters = new Map();

/**
 * Loest auf, sobald das gerade offene Modal wirklich weg ist und seinen Fokus
 * zurueckgegeben hat; ohne offenes Modal sofort.
 *
 * `confirmModal()` loest schon beim Klick auf, mobil laeuft das Schliessen aber
 * noch bis zu 400 ms weiter (Animation) und setzt am Ende den Fokus auf den
 * Ausloeser. Wer nach der Rueckfrage selbst fokussiert - etwa ein Feld, das
 * eine schnelle Serverantwort einblendet -, verliert ihn sonst an dieses Ende.
 * Gilt fuer das Overlay, das beim Aufruf offen ist, nicht fuer ein spaeteres.
 * @returns {Promise<void>}
 */
export function whenModalClosed() {
  const overlay = activeOverlay;
  if (!overlay || !overlay.isConnected) return Promise.resolve();
  return new Promise((resolve) => {
    const list = _closeWaiters.get(overlay) ?? [];
    list.push(resolve);
    _closeWaiters.set(overlay, list);
  });
}

function _releaseCloseWaiters(overlay) {
  const list = _closeWaiters.get(overlay);
  if (!list) return;
  _closeWaiters.delete(overlay);
  for (const resolve of list) resolve();
}

function _doClose(overlayEl) {
  const target = overlayEl ?? activeOverlay;
  if (!target) return;

  target._undock?.();
  _removeOverlay(target);

  // Globalen State nur zurücksetzen wenn kein neues Modal zwischenzeitlich geöffnet wurde.
  if (activeOverlay === target) {
    activeOverlay = null;
    modalState = 'idle';

    // Und der Registereintrag folgt dem neuen Zustand (#871). `target.remove()`
    // steht schon oben, das DOM ist also aktuell.
    _syncOverlayRegistration();

    // Scroll-Lock aufheben
    document.body.style.overflow = '';

    // Focus-Restore
    const merkzettel = previouslyFocused;
    previouslyFocused = null;
    // HAT DER AUFRUFER SCHON FOKUSSIERT, BLEIBT ES DABEI. closeModal() loest mit
    // dem START des Ausgangs auf (seit 2026-09-26 auch am Desktop); wer darauf
    // wartet, neu zeichnet und ein Steuerelement fokussiert, verloere es sonst
    // ~150 ms spaeter an den alten Ausloeser. Im Dialog selbst kann der Fokus
    // hier nicht mehr stehen - das Overlay ist schon entfernt, der Browser hat
    // ihn auf <body> fallen lassen.
    const aktiv = document.activeElement;
    // Den Fokus, den der Browser beim `close()` selbst zurueckgab, hat kein
    // Aufrufer gesetzt - er zaehlt nicht als dessen Wahl (siehe _leaveTopLayer).
    const vomBrowser = Boolean(aktiv) && aktiv === target._nativeRestored;
    if (aktiv && !vomBrowser && aktiv !== document.body && aktiv !== document.documentElement && !target.contains?.(aktiv)) {
      if (window.yuvomi?.restoreThemeColor) window.yuvomi.restoreThemeColor();
      _releaseCloseWaiters(target);
      return;
    }
    const restoreTarget = focusRestoreTarget(merkzettel);
    // Das TATSAECHLICH fokussierte Element merken, nicht das gewuenschte: nimmt
    // der Ersatz den Fokus nicht an, steht danach die Wurzel dort, und die
    // spaeteren Laeufe muessen von ihr ausgehen.
    const gesetzt = _fokussiereMitRueckfall(restoreTarget);
    if (gesetzt) {
      // Rendert die Seite gleich danach, ist dieser Fokus schon wieder weg.
      _lastRestore = { memo: merkzettel, ziel: gesetzt };
      _refocusIfDropped(merkzettel, gesetzt);
    }

    // Standalone: Statusbar-Farbe zur aktuellen Route wiederherstellen
    if (window.yuvomi?.restoreThemeColor) {
      window.yuvomi.restoreThemeColor();
    }
  }

  // Erst NACH dem Focus-Restore: wer auf das Schliessen gewartet hat, setzt
  // seinen Fokus danach und behaelt ihn.
  _releaseCloseWaiters(target);
}

// --------------------------------------------------------
// Fußzeilen-Umzug
// --------------------------------------------------------

/**
 * Hebt eine im Body gerenderte `.modal-panel__footer` ans Panel.
 *
 * Aufrufer rendern ihre Fußzeile historisch im content, also im scrollenden
 * Body. Strukturell gehört sie ans Panel: sonst liegt die Primäraktion bei
 * langen Formularen unter der Falz und ist mobil mit offener Tastatur
 * unerreichbar (Audit A2-20). Die Inline-Styles des alten In-Body-Layouts
 * (border:none, padding:0, margin-top) fallen mit dem Move weg, damit das
 * kanonische Footer-CSS (.modal-panel > .modal-panel__footer) greift.
 *
 * Eigene Funktion, weil der Umzug nicht nur beim Öffnen gebraucht wird: Ein
 * später gemountetes Formular (Detailansicht → Bearbeiten) bringt seine eigene
 * Fußzeile mit, die sonst im scrollenden Body liegen bliebe - und ein
 * „Speichern" mit type="submit" löste dort kein submit aus (#543).
 *
 * @param {HTMLElement} panel
 * @returns {HTMLElement|null} die umgezogene Fußzeile, oder null
 */
export function mountFooter(panel) {
  const bodyFooter = [...panel.querySelectorAll('.modal-panel__body .modal-panel__footer')].pop();
  if (!bodyFooter) return null;

  bodyFooter.removeAttribute('style');
  // Liegt die Fußzeile in einem <form>, löst das Anheben ans Panel ihre
  // Bedienelemente aus dem Formular - ein „Speichern"/„Übernehmen"-Button mit
  // type="submit" löst dann kein submit-Event mehr aus, und der Klick tut
  // scheinbar nichts (#543). Vor dem Verschieben die Formular-Zugehörigkeit
  // per form-Attribut festzurren; so submittet der Button das Formular auch
  // außerhalb des Formular-DOM (Standard-HTML-Assoziation).
  // Die id ueber das ATTRIBUT lesen, nie ueber `form.id`: ein Feld mit
  // name="id" ueberdeckt die Eigenschaft am <form>, `form.id` ist dann das
  // Feld, und der Knopf zeigte auf form="[object HTMLInputElement]" - kein
  // Formular, kein submit, der Haushaltshilfe-Dialog speicherte nie (#1976).
  const ownerForm = bodyFooter.closest('form');
  if (ownerForm) {
    let formId = ownerForm.getAttribute('id');
    if (!formId) {
      formId = `modal-form-${++_modalFormSeq}`;
      ownerForm.setAttribute('id', formId);
    }
    bodyFooter.querySelectorAll('button, input, select, textarea').forEach((el) => {
      if (!el.hasAttribute('form')) el.setAttribute('form', formId);
    });
  }

  // Beim Pane-Wechsel hängt bereits die Fußzeile der vorigen Ansicht am Panel.
  // Sie muss weichen, sonst stehen zwei Fußzeilen übereinander.
  [...panel.children]
    .filter((el) => el !== bodyFooter && el.classList?.contains('modal-panel__footer'))
    .forEach((el) => el.remove());

  panel.appendChild(bodyFooter);
  decorateFooterDelete(bodyFooter);
  collapseEmptyBody(panel);
  return bodyFooter;
}

/**
 * EIN RUMPF OHNE INHALT IST KEIN RUMPF (R18).
 *
 * Eine Rückfrage ohne `detail` besteht nur aus Frage (Titel) und Fuß. Nach dem
 * Anheben der Fußzeile blieb ihr Rumpf als leerer Kasten stehen: zweimal 16px
 * Polster zwischen der Linie des Kopfs und der des Fußes (Abmelden, gemessen
 * 32px Leere zwischen zwei Haarlinien). Das trifft jede Rückfrage ohne
 * Erklärtext, nicht eine bestimmte.
 *
 * Der Rumpf wird dafür nur WIRKLICH leer gemacht - übrig waren die
 * Leerzeichen des Template-Literals, und an denen scheitert `:empty`. Den
 * Rest trägt das Stylesheet (`.modal-panel__body:empty`, layout.css): keine
 * Klasse, die jemand wieder abnehmen müsste, wenn ein Aufrufer den Rumpf
 * später füllt - dann ist er nicht mehr `:empty` und steht von selbst wieder.
 *
 * @param {HTMLElement} panel
 * @returns {boolean} true, wenn der Rumpf geleert wurde
 */
export function collapseEmptyBody(panel) {
  const body = panel?.querySelector?.('.modal-panel__body');
  if (!body) return false;
  if (body.children.length > 0 || body.textContent.trim() !== '') return false;
  body.replaceChildren();
  return true;
}

/**
 * Woran der Fuß sein Löschen erkennt. Die Module schreiben es seit Jahren als
 * `.btn--danger-outline` (seit R24 alle; `.btn--danger-ghost` ist entfallen) -
 * die Klasse IST die Auszeichnung, kein Modul muss etwas nachtragen. `data-footer-delete`
 * nimmt einen Knopf auf, der anders aussieht; `data-footer-delete="off"` nimmt
 * einen heraus, bei dem Löschen die Primäraktion des Dialogs ist.
 */
export const FOOTER_DELETE_SELECTOR = '.btn--danger-outline, [data-footer-delete]';

/**
 * Der Name des Objekts, das der Knopf löscht: ausdrücklich gesetzt
 * (`data-delete-name`), sonst das erste Textfeld des Formulars - dort steht bei
 * jedem Objekt sein Titel -, und in der Detailansicht der Dialogtitel, denn
 * dort IST er der Objektname (detail-view.js).
 */
function footerDeleteObjectName(btn) {
  const own = btn.dataset?.deleteName?.trim();
  if (own) return own;
  const panel = btn.closest?.('.modal-panel');
  const scope = btn.form ?? panel?.querySelector('.modal-panel__body');
  const field = scope?.querySelector?.('input[type="text"], input:not([type])');
  const typed = field?.value?.trim();
  if (typed) return typed;
  if (btn.closest?.('.detail-view__footer')) return panel?.querySelector('.modal-panel__title')?.textContent?.trim() || '';
  return '';
}

/**
 * DER DIALOGFUSS MIT LÖSCHEN PASST MOBIL IN EINE ZEILE (Re-Critique
 * 2026-09-27, R9 M8).
 *
 * WAS GEMESSEN WAR: Löschen · Abbrechen · Speichern brauchen bei 390px rund
 * 345px, der Fuß hat 332. Der Umbruch aus #872 hielt alles im Bild, stellte
 * aber „Speichern" allein in eine zweite Zeile - die Primäraktion stand unter
 * der Nebenaktion, in jedem Dialog mit Löschen (Kalender, Medikament,
 * Mahlzeit ...).
 *
 * DIE ANTWORT IST APPLES: Löschen wird auf dem Telefon ein 44px-Papierkorb links,
 * Abbrechen und Primär bleiben rechts beschriftet. Einmal hier statt je Modul -
 * deshalb erkennt die Shell den Knopf an seiner Klasse, packt seinen Text in
 * eine eigene Spanne (die das CSS mobil ausblendet, ohne sie dem Screenreader
 * zu nehmen), ergänzt ein fehlendes Papierkorb-Symbol und gibt ihm den
 * Objektnamen: „Einkauf löschen" statt eines nackten „Löschen", sobald das
 * Wort selbst nicht mehr dasteht. Ein vorhandenes `aria-label` gewinnt immer.
 *
 * Idempotent: ein zweiter Umzug derselben Fußzeile (Pane-Wechsel) ändert nichts.
 *
 * @param {HTMLElement|null} footer
 * @returns {HTMLElement[]} die erkannten Löschen-Knöpfe
 */
export function decorateFooterDelete(footer) {
  if (!footer?.querySelectorAll) return [];
  const found = [...footer.querySelectorAll(FOOTER_DELETE_SELECTOR)]
    .filter((btn) => btn.tagName === 'BUTTON' && btn.dataset?.footerDelete !== 'off');
  footer.classList.toggle('modal-panel__footer--has-delete', found.length > 0);
  // EINE ZEILE NUR FÜR DIE KANONISCHE DREIHEIT (Löschen · Abbrechen · Primär).
  // Die Detailansicht trägt neben Löschen drei beschriftete Aktionen
  // (Erledigen, Starten, Aufgabe archivieren) - in eine Zeile gezwungen,
  // quetschten sie sich auf je ~80px. Dort bleibt der Umbruch aus #872, der
  // Papierkorb spart trotzdem eine Knopfbreite. Icon-Knöpfe (Archivieren im
  // Kontodialog) zählen nicht mit: sie brauchen nur ihre 44px.
  // Ausgeblendete Knoepfe zaehlen nicht: die Notiz traegt Lese- und
  // Editor-Fuss in EINER Zeile und blendet je Ansicht aus (notes.js ruft
  // decorateFooterDelete nach jedem Wechsel erneut).
  // Ebenso wenig der leise Knopf des Leseblatts, den detail-view.css mobil auf
  // sein Symbol faltet (Duplizieren, Als vCard exportieren): er braucht dort
  // nur seine 44px, wie ein Icon-Knopf.
  const leseFuss = footer.classList.contains('detail-view__footer') && Boolean(footer.querySelector(':scope > .btn--primary'));
  const faltetZumSymbol = (b) => leseFuss && b.classList.contains('btn--ghost')
    && Boolean(b.querySelector(':scope > svg, :scope > i')) && Boolean(b.querySelector(':scope > .btn__label'));
  // Die Eintraege eines Mehr-Menues im Fuss (R24, detailFooterEl `more`)
  // stehen nicht im Fuss, sondern im Popover darueber - sie zaehlen nicht.
  const labelled = [...footer.querySelectorAll('button')]
    .filter((b) => !found.includes(b) && !b.classList.contains('btn--icon') && !b.hidden && b.style?.display !== 'none'
      && !faltetZumSymbol(b) && !b.classList.contains('popover-menu__item'));
  footer.classList.toggle('modal-panel__footer--one-row', found.length > 0 && labelled.length <= 2);
  // DAS WORT BLEIBT, WO PLATZ IST (R23, Critique G3/G5). Der Papierkorb ist
  // die Antwort auf die DREIHEIT, die bei 390px nicht in eine Zeile passt. Die
  // Leseansicht (Rezept, Kontakt, Notiz) traegt neben Loeschen nur EINE
  // beschriftete Aktion ("Bearbeiten") und ein Icon - dort stand mobil ein
  // nackter roter Papierkorb neben einem nackten Duplizieren, und das einzige
  // Wort im Fuss war "Bearbeiten". Mit hoechstens einer beschrifteten Nachbarin
  // behaelt Loeschen sein Wort (layout.css, `--delete-worded`).
  footer.classList.toggle('modal-panel__footer--delete-worded', found.length > 0 && labelled.length <= 1);
  for (const btn of found) {
    if (btn.classList.contains('modal-panel__delete')) continue;
    btn.classList.add('modal-panel__delete');
    // DIE DETAILANSICHT TRAEGT IHR WORT SCHON IN EINER SPANNE (`.btn__label`,
    // components/detail-view.js), nicht als losen Text. Die blieb sichtbar und
    // ragte mobil aus dem 48px-Quadrat (Re-Critique 2026-09-28, A5 P2-4) - sie
    // wird deshalb selbst die Wortspanne, statt eine zweite zu bekommen.
    const ownLabel = [...btn.childNodes].find((n) => n.nodeType === 1 && n.classList?.contains('btn__label'));
    if (ownLabel) ownLabel.classList.add('modal-panel__delete-label');
    const loose = [...btn.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (loose.length && ownLabel) {
      ownLabel.textContent = [ownLabel.textContent.trim(), ...loose.map((n) => n.textContent.trim())].join(' ');
      loose.forEach((n) => n.remove());
    } else if (loose.length) {
      const label = document.createElement('span');
      label.className = 'modal-panel__delete-label';
      label.textContent = loose.map((n) => n.textContent.trim()).join(' ');
      loose.forEach((n) => n.remove());
      btn.appendChild(label);
    }
    if (!btn.querySelector('svg, [data-lucide]')) {
      const icon = iconElement('trash-2', { class: 'icon-md' });
      if (icon) btn.prepend(icon);
    }
    if (!btn.hasAttribute('aria-label')) {
      const name = footerDeleteObjectName(btn);
      if (name) btn.setAttribute('aria-label', t('common.deleteNamed', { name }));
    }
  }
  return found;
}

// --------------------------------------------------------
// Kopf-Aktion
// --------------------------------------------------------

/**
 * Tauscht Beschriftung und Handler des Kopf-Buttons zur Laufzeit - „Bearbeiten"
 * wird nach dem Wechsel ins Formular zu „Fertig". Der Klick-Listener bleibt
 * dabei derselbe; er ruft immer den aktuell hinterlegten Callback auf.
 */
export function updateHeaderAction(panel, { label, onClick, hidden = false } = {}) {
  const btn = panel?.querySelector('.modal-panel__action');
  if (!btn) return null;
  if (typeof label === 'string') btn.textContent = label;
  if (onClick !== undefined) btn._onAction = onClick;
  btn.hidden = hidden;
  return btn;
}

// --------------------------------------------------------
// Totzeit gegen den Doppeltipp (#1284)
// --------------------------------------------------------

/**
 * Wie lange eine frisch geöffnete RÜCKFRAGE keine Zeiger-Betätigung annimmt.
 *
 * DER DIALOG FÄHRT IN DIE HAND, DIE GERADE GETIPPT HAT. Auf Handybreite ist
 * das Modal ein Sheet, und `glass-sheet-in` (glass.css) schiebt es 300 ms
 * lang von unten nach oben - quer durch die Stelle, an der eben noch
 * „Speichern" stand. Gemessen in headless Chrome: ein zweiter Tipp 40-70 ms
 * nach dem Öffnen der Serien-Rückfrage wählte eine Reichweite aus, ohne dass
 * die Frage je gelesen wurde; auf dem Desktop legte das Löschen aus dem
 * Popover „Nur diesen Termin" unter den zweiten Klick eines Doppelklicks.
 * Beides trifft jede Rückfrage des geteilten Systems, nicht nur den neuen
 * Dialog: die Löschfrage geht denselben Weg durch `confirmModal` → `openModal`.
 *
 * NUR RÜCKFRAGEN, und das ist der Unterschied, der zählt. Die Sperre hing
 * zuerst an `openModal` selbst und traf damit jedes Overlay - 62 Aufrufe in
 * 20 Dateien, Formulare und Ansichtsblätter darunter. Dort ist der erste
 * Zeigerklick Absicht: jemand hat das Blatt aufgemacht und tippt hinein. Im
 * Notizblatt fiel so der Moduswechsel weg, und eine Sonde wartete 42 s auf
 * eine Vorschlagsliste, die nie kam. Scharf gestellt wird deshalb einzeln,
 * über `pointerDeadTime: true` - siehe openModal.
 *
 * 350 ms deckt die Einfahrt (280 ms) samt Rest ab und liegt unter der
 * Schwelle, ab der ein GEWOLLTER zweiter Klick sich verschluckt anfühlt.
 */
const POINTER_DEAD_TIME_MS = 350;

/**
 * Genau die Ereignisse, mit denen ein Zeiger etwas auslöst.
 *
 * Die Touch-Ereignisse stehen bewusst NICHT dabei: `touchstart`/`touchmove`
 * tragen das Scrollen des Inhalts und die Wischgeste des Sheets
 * (`_wireSheetSwipe`), und sie abzufangen hieße, eine Geste mittendrin
 * abzuschneiden. Der Tipp selbst kommt ohnehin hier vorbei - als `click` mit
 * `pointerType: 'touch'`.
 */
const POINTER_ACTIVATION_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

/**
 * Kommt dieses Ereignis von einem Zeiger - oder von Tastatur bzw. Screenreader?
 *
 * DIE TOTZEIT UNTERSCHEIDET DIE EREIGNISART, NICHT NUR DIE ZEIT. Eine Sperre,
 * die auch `Enter`/`Space` schluckt, wäre kein Schutz, sondern ein Rückschritt
 * in der Bedienbarkeit: wer mit Tastatur bedient, tabbt in den Dialog und
 * drückt - dazwischen liegen keine 350 ms Nachdenkzeit, die man ihm abziehen
 * dürfte, und er hat auch nie „danebengetippt", weil kein Sheet unter seinen
 * Finger gefahren ist.
 *
 * Zwei Merkmale, und EINES genügt, weil keines für sich vollständig ist:
 * Chrome liefert einen per Tastatur ausgelösten Klick als PointerEvent mit
 * leerem `pointerType` und `detail === 0` - dasselbe gilt für `element.click()`
 * und für die Betätigung durch einen Screenreader. Ein Tipp trägt
 * `pointerType: 'touch'`, ein älterer MouseEvent ohne `pointerType` immerhin
 * `detail >= 1`. Nur auf `pointerType` zu hören ließe den Tipp durch, sobald
 * ein Browser den Kompatibilitätsklick ohne Zeigerart schickt; nur auf
 * `detail` zu hören ließe `pointerdown` durch, das kein `detail` führt.
 */
function _isPointerActivation(event) {
  if (typeof event?.pointerType === 'string' && event.pointerType !== '') return true;
  return typeof event?.detail === 'number' && event.detail > 0;
}

/**
 * Hängt die Totzeit an ein frisch geöffnetes Overlay.
 *
 * CAPTURE AUF DER WURZEL UND ALS ERSTER LISTENER. Capture, damit das Ereignis
 * fällt, bevor irgendein Handler im Dialog es sieht; als erster, weil ein
 * Klick auf das Overlay SELBST (der Schließweg über den Hintergrund) im
 * AT_TARGET-Fall landet - dort laufen Capture- und Bubble-Listener desselben
 * Knotens in Registrierungsreihenfolge, und `stopImmediatePropagation` wirkt
 * nur auf das, was noch kommt.
 *
 * `now` und `duration` sind für die Sonden da: eine Totzeit belegt man, indem
 * man die Zeit vorstellt, nicht indem man die Konstante im Quelltext sucht.
 *
 * @param {EventTarget} root
 * @param {{now?: () => number, duration?: number}} [opts]
 * @returns {(event: Event) => void} der angehängte Handler (für Sonden)
 */
export function armPointerDeadTime(root, { now = () => performance.now(), duration = POINTER_DEAD_TIME_MS } = {}) {
  const openedAt = now();
  const swallow = (event) => {
    if (now() - openedAt >= duration) return;
    if (!_isPointerActivation(event)) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  for (const type of POINTER_ACTIVATION_EVENTS) root.addEventListener(type, swallow, true);
  return swallow;
}

// --------------------------------------------------------
// openModal
// --------------------------------------------------------

/**
 * Öffnet ein Modal mit dem Shared-System.
 *
 * @param {Object}   opts
 * @param {string}   opts.title    - Titel im Modal-Header
 * @param {string}   opts.content  - HTML-String für den Modal-Body
 * @param {Function} [opts.onSave]   - Callback, wird nach Einfügen in DOM aufgerufen
 * @param {Function} [opts.onClose]  - Callback, wird aufgerufen wenn das Modal geschlossen wird
 * @param {Function} [opts.onDelete] - Falls vorhanden, wird ein Löschen-Button eingebaut
 * @param {string}   [opts.size='md'] - 'sm' (400px) | 'md' (520px) | 'lg' (680px) | 'xl' (min(960px, 95vw)); Breiten siehe layout.css .modal-panel--*
 * @param {'first-field'|'edit'|'none'|HTMLElement|string} [opts.initialFocus='first-field'] - siehe applyInitialFocus
 *   (ein Selektor ab `#`, `.` oder `[` nennt das Pflichtfeld, resolveInitialFocus);
 *   `'edit'` fuer das Bearbeiten eines bestehenden Eintrags (resolveInitialFocus)
 * @param {{label: string, id?: string, onClick?: Function}} [opts.headerAction] - Textbutton rechts im Kopf, links vom Schließen-X
 * @param {boolean} [opts.dirtyGuard=true] - `false` für Ansichtsblätter, deren
 *   Felder sofort wirken und nichts zu speichern haben (siehe _dirtyGuardEnabled).
 *   Für alles mit einem Speichern-Knopf bleibt es an.
 * @param {boolean} [opts.pointerDeadTime=false] - `true` NUR für Rückfragen, also
 *   Dialoge, deren Knöpfe eine Frage beantworten. Sie nehmen dann 350 ms lang
 *   keinen Zeigerklick an, damit ein Tipp, der noch zum Öffnen gehörte, nicht
 *   ungelesen antwortet (siehe POINTER_DEAD_TIME_MS). Ein Formular, das jemand
 *   selbst aufgemacht hat, bekommt das NICHT: dort ist der erste Klick Absicht.
 */
// --------------------------------------------------------
// Bearbeiten IN der Detailspalte (Critique R19)
// --------------------------------------------------------

/**
 * AB DER SPLIT-SCHWELLE BEARBEITET MAN IN DER DETAILSPALTE, darunter bleibt es
 * das Modal (Entscheidung Ulas, 2026-10-16). Bei Aufgaben (680px) und Rezepten
 * (520px) lag das Formular als zweites Fenster ueber Liste und Detail.
 *
 * DAS FORMULAR BLEIBT DIESER DIALOG - nur sein Ort wechselt. Das Panel legt
 * sich deckungsgleich auf die Detailspalte (`.modal-overlay--docked`,
 * layout.css), der Grund daneben wird nicht abgedunkelt. Alles, was der Dialog
 * zusagt, bleibt damit unveraendert erhalten, ohne zweite Fassung: Fokus und
 * Fokusfalle, Escape und Abbrechen, die Frage nach ungespeicherten Aenderungen
 * (ein Klick auf die Liste ist ein Schliessen und fragt sie), der EINE
 * History-Marker der Zurueck-Geste und die Serien-Rueckfragen, die sich als
 * eigene Dialoge darueberlegen. Die Liste ist waehrenddessen inert wie hinter
 * jedem Dialog - wie in Kontakte am Mac, wo der Bearbeiten-Modus erst endet,
 * bevor eine andere Karte gewaehlt wird.
 *
 * EIN WEG: der Knopf „Bearbeiten" im Kopf der Detailspalte meldet seine Spalte
 * an (`detailPaneHeaderEl`, Aktion mit `dock: true`, utils/master-detail.js),
 * bevor er den Dialog des Moduls oeffnet. Das naechste openModal() nimmt die
 * Anmeldung, wenn sie frisch ist und die Spalte steht; sonst oeffnet es wie
 * immer. Wird die Spalte waehrend des Bearbeitens schmaler als die Schwelle
 * (Fenster, Seitenleiste), wird der Dialog wieder ein gewoehnlicher.
 */
let _dockIntent = null;
/** Wie lange eine Anmeldung gilt: lang genug fuer ein Modul, das vor dem Dialog noch laedt. */
const DOCK_INTENT_MS = 3000;

/**
 * Meldet die Spalte an, in die der naechste Dialog sich legt.
 * @param {HTMLElement|null} el  die Detailspalte (`.split-view__detail`)
 */
export function dockNextModal(el) {
  _dockIntent = el ? { el, until: Date.now() + DOCK_INTENT_MS } : null;
}

function _dockVisible(el) {
  if (!el?.isConnected || getComputedStyle(el).display === 'none') return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function _takeDockIntent() {
  const intent = _dockIntent;
  _dockIntent = null;
  if (!intent || Date.now() > intent.until) return null;
  return _dockVisible(intent.el) ? intent.el : null;
}

/** Legt das Panel auf die Spalte und haelt es dort, solange sie steht. */
function _dockOverlay(overlay, dock) {
  if (!overlay || !dock) return;
  const place = () => {
    const rect = _dockVisible(dock);
    if (!rect) { overlay.classList.remove('modal-overlay--docked'); return; }
    overlay.classList.add('modal-overlay--docked');
    overlay.style.setProperty('--dock-top', `${rect.top}px`);
    overlay.style.setProperty('--dock-left', `${rect.left}px`);
    overlay.style.setProperty('--dock-width', `${rect.width}px`);
    overlay.style.setProperty('--dock-height', `${rect.height}px`);
  };
  place();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
  ro?.observe(dock);
  window.addEventListener?.('resize', place);
  overlay._undock = () => {
    ro?.disconnect();
    window.removeEventListener?.('resize', place);
    overlay._undock = null;
  };
}

/**
 * DAS ERSTE BLATT IN ZWEI FRAMES: ERST DIE BUEHNE, DANN DIE FELDER (Critique
 * R21, a6 P3 "Erstes Blatt kalt").
 *
 * Gemessen am Telefon (390px, 4x CPU, Seed): FAB -> "Neue Aufgabe" kostete
 * einen Handler von 95-105 ms und eine INP von 152-176 ms; das erste Bild kam
 * erst, als Formular, Datumsfelder und Verdrahtung fertig waren. Davon waren
 * rund 60 ms Stil und Layout, die `showModal()` und das Lesen von
 * `innerWidth` mitten im Aufbau erzwangen, der Rest das Formular selbst.
 *
 * `staged: true` teilt das Oeffnen: im Tipp steht nur die Buehne - Dialog in
 * der Top-Layer, Abdunklung, Kopf -, die Tafel bleibt unsichtbar und ohne
 * Einfahrt (`.modal-panel--pending`, layout.css). Nach dem ersten Bild kommen
 * Formular, Fusszeile, Fokus, Dirty-Basis und `onSave`, und erst dann faehrt
 * die Tafel ein - mit ihrer ganzen Feder, weil keine Arbeit mehr in ihre
 * ersten Frames faellt. Eine leere Tafel, die waechst, zeigt sich nie.
 *
 * Nur fuer Aufrufer, die nach `openModal()` nicht synchron ins Formular
 * greifen (alles Verdrahten steht in `onSave`): die FAB-Blaetter der Module.
 * `content` darf dann eine Funktion sein, die das Markup erst im zweiten
 * Schritt baut. Ersetzt der Aufruf ein offenes Modal (Leseansicht ->
 * Bearbeiten) oder fehlt `requestAnimationFrame` / ist das Dokument verborgen,
 * laeuft alles wie immer in einem Schritt.
 */
function _canStage() {
  return typeof requestAnimationFrame === 'function' && typeof setTimeout === 'function'
    && typeof document !== 'undefined' && document.visibilityState !== 'hidden';
}

/** Netz, falls nie ein Frame kommt: dann fuellt der Timer, wie frueher in einem Schritt. */
const STAGE_FALLBACK_MS = 120;

/**
 * Laeuft nach dem naechsten Bild: rAF liegt vor dem Malen, die Aufgabe danach
 * dahinter. `scheduler.postTask` (user-blocking) zieht sie vor andere wartende
 * Aufgaben; ohne Scheduler-API (Safari, aeltere Browser) setTimeout 0.
 * @param {() => void} fn
 */
function _afterNextPaint(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => {
    const sched = typeof window !== 'undefined' ? window.scheduler : null;
    if (sched && typeof sched.postTask === 'function') {
      sched.postTask(run, { priority: 'user-blocking' }).catch(() => run());
    } else {
      setTimeout(run, 0);
    }
  });
  setTimeout(run, STAGE_FALLBACK_MS);
}

export function openModal({
  title, content, onSave, onDelete, onClose, size = 'md',
  initialFocus = 'first-field', headerAction = null, dirtyGuard = true,
  pointerDeadTime = false, staged = false,
} = {}) {
  // Die Anmeldung gilt diesem Aufruf - auch wenn er gleich ein voriges Modal
  // ablöst, und auch wenn die Spalte nicht (mehr) steht.
  const dock = _takeDockIntent();

  // VOR JEDER DOM-AENDERUNG LESEN. `innerWidth` nach dem Scroll-Lock und dem
  // Einfuegen erzwang eine Stilberechnung des ganzen Dokuments (gemessen 4x
  // CPU: 13-16 ms mitten im Tipp) - die Breite ist vorher dieselbe.
  const narrow = window.innerWidth < 768;
  // Zwei Schritte nur, wenn kein Modal abgeloest wird (siehe _canStage).
  const stage = Boolean(staged) && !activeOverlay && _canStage();

  // Vorheriges Modal schließen (kein Stacking).
  if (activeOverlay) {
    activeOverlay.removeAttribute('id');
    // force:true ensures we don't trigger another dirty check while opening a new modal
    closeModal({ force: true });
  }

  // Focus-Restore vorbereiten
  previouslyFocused = rememberFocus(document.activeElement);
  // Der Merker des vorigen Schliessens ist mit diesem Dialog erledigt.
  _lastRestore = null;

  // Scroll-Lock
  document.body.style.overflow = 'hidden';

  const sizeClass = size !== 'md' ? ` modal-panel--${size}` : '';

  // Kopf-Aktion („Bearbeiten"): Textbutton, kein Icon-Rätsel. Er steht links vom
  // Schließen-X, weil er die häufigere Absicht trägt und das X seinen gewohnten
  // Platz in der Ecke behält.
  const headerActionHtml = headerAction
    ? `<button type="button" class="modal-panel__action" id="${esc(headerAction.id ?? 'modal-header-action')}">${esc(headerAction.label)}</button>`
    : '';

  const markup = () => (typeof content === 'function' ? content() : content);
  const html = `
    <dialog class="modal-overlay" id="shared-modal-overlay" aria-labelledby="shared-modal-title">
      <div class="modal-overlay__scrim" aria-hidden="true"></div>
      <div class="modal-panel${sizeClass}${stage ? ' modal-panel--pending' : ''}">
        <div class="modal-panel__header">
          <h2 class="modal-panel__title" id="shared-modal-title">${esc(title)}</h2>
          <div class="modal-panel__header-actions">
            ${headerActionHtml}
            <button class="modal-panel__close" data-action="close-modal" aria-label="${t('modal.closeLabel')}">
              <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="modal-panel__body">
          ${stage ? '' : markup()}
        </div>
      </div>
    </dialog>`;

  _modalGeneration += 1;
  document.body.insertAdjacentHTML('beforeend', html);
  activeOverlay = document.getElementById('shared-modal-overlay');
  activeOverlay._onCloseCallback = onClose;
  activeOverlay.addEventListener('cancel', _onCancel);
  activeOverlay.addEventListener('close', _onNativeClose);

  // VOR JEDEM ANDEREN LISTENER AUF DIESEM KNOTEN: die Totzeit schluckt einen
  // Zeigerklick, der noch zum Öffnen gehört, und ihre Reihenfolge entscheidet
  // mit - siehe armPointerDeadTime.
  //
  // NUR FÜR RÜCKFRAGEN. Sie schluckt jeden Zeigerklick auf dem Overlay, also
  // auch den auf ein Feld oder einen Umschalter. In einer Rückfrage ist der
  // verfrühte Klick eine ANTWORT auf eine ungelesene Frage; in einem Formular,
  // das jemand selbst aufgemacht hat, ist er Absicht, und ihn zu schlucken ist
  // der Fehler. Gemessen: der Moduswechsel im Notizblatt fiel weg, und die
  // Sonde wartete 42 s auf eine Vorschlagsliste, die nie kam.
  if (pointerDeadTime) armPointerDeadTime(activeOverlay);

  // Lucide-Icons rendern
  if (window.lucide) window.lucide.createIcons({ el: activeOverlay });

  // Focus-Trap
  const panel = activeOverlay.querySelector('.modal-panel');

  if (!stage) mountFooter(panel);

  // IN DIE TOP-LAYER, BEVOR DER ERSTFOKUS GEPLANT WIRD (D7). `showModal()`
  // fokussiert synchron das erste Bedienelement (das Schliessen-X); trapFocus
  // merkt diesen Stand als "beim Planen" und setzt 50 ms spaeter den
  // eigentlichen Einstieg (erstes Feld). Ab hier ist der Hintergrund inert:
  // Tab verlaesst den Dialog nicht mehr, Screenreader lesen die Seite
  // dahinter nicht mit.
  // In der Spalte, wenn „Bearbeiten" dort aufgerufen hat (siehe dockNextModal).
  // Vor dem Eintritt in die Top-Layer: die Einfahrt ist dann schon die der Spalte.
  _dockOverlay(activeOverlay, dock);
  _enterTopLayer(activeOverlay);
  if (_reducedMotion()) _fade(activeOverlay, 0, 1);

  // Kopf-Aktion verdrahten: der Listener ruft immer den aktuell hinterlegten
  // Callback, damit updateHeaderAction() ihn später tauschen kann, ohne den
  // Listener neu zu binden.
  const actionBtn = panel.querySelector('.modal-panel__action');
  if (actionBtn) {
    actionBtn._onAction = headerAction?.onClick;
    actionBtn.addEventListener('click', () => actionBtn._onAction?.());
  }

  if (!stage) trapFocus(panel, initialFocus);

  // Snapshot für Dirty-Check: sofort den Ist-Zustand aufnehmen (meist die
  // leeren Vorgabewerte), sonst wertet der Dirty-Guard ein schnelles
  // Tippen+Escape/Overlay-Klick innerhalb des folgenden Delays fälschlich als
  // unverändert - `isFormDirty` hält `null` für "nichts zu vergleichen", nicht
  // für "noch nichts eingegeben". Der verzögerte zweite Snapshot bleibt für
  // Felder, die erst nach dem Öffnen per JS befüllt werden (Selects, Datepicker).
  //
  // NACH dem `closeModal({force:true})` oben: dessen Aufräumen stellt den
  // Wächter auf den Standardwert zurück, ein früheres Setzen wäre wieder
  // eingesammelt worden.
  _dirtyGuardEnabled = dirtyGuard;
  if (_initialFormTimeout) clearTimeout(_initialFormTimeout);
  _snapshotNow();
  _initialFormTimeout = setTimeout(_snapshotNow, 150);

  // Swipe-to-Close auf Mobile
  if (narrow) {
    _wireSheetSwipe(panel);
  }

  // Ab jetzt faengt die Zurueck-Geste diesen Dialog ab, statt die Seite
  // darunter zu wechseln (#871).
  _syncOverlayRegistration();

  // Overlay-Click schließt Modal
  activeOverlay.addEventListener('click', (e) => {
    if (e.target === activeOverlay) closeModal();
  });

  // iOS PWA: touchend als Fallback
  activeOverlay.addEventListener('touchend', (e) => {
    if (e.target === activeOverlay) closeModal();
  }, { passive: true });

  // Close-Buttons: Header-X und jedes Footer-„Abbrechen" mit data-action="close-modal"
  // (kanonische Abbrechen-API der Modal-Fußzeilen, laeuft durch den Dirty-Guard).
  //
  // DELEGIERT, NICHT JE KNOTEN GEBUNDEN: Ein querySelectorAll erreicht nur, was
  // beim Öffnen schon im DOM steht. Der Bearbeiten-Pfad der Detailansicht baut
  // sein Formular aber erst beim Klick auf „Bearbeiten" (detail-view.js,
  // switchToForm → edit.mount), und dessen „Abbrechen" bekam deshalb nie einen
  // Listener - der Klick tat sichtbar nichts (#738). Betroffen war jedes Modul
  // mit Leseansicht: Aufgaben, Einkauf, Vorrat, Haushalt, Rezepte.
  activeOverlay.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-action="close-modal"]')) closeModal();
  });

  // Escape (nur einmal binden)
  bindEscape();

  // „Weitere Angaben" klappt ins Bild, nicht unter den Fuss (Critique R21).
  _wireAdvancedReveal(panel);

  // Callback für Aufrufer
  if (!stage && typeof onSave === 'function') onSave(panel);

  // Gestuft: Formular, Fusszeile, Fokus, Dirty-Basis und `onSave` nach dem
  // ersten Bild, in derselben Reihenfolge wie oben - dann faehrt die Tafel ein.
  // Ist der Dialog bis dahin zu oder abgeloest, bleibt es bei der Buehne.
  if (stage) {
    const overlay = activeOverlay;
    _afterNextPaint(() => {
      if (overlay !== activeOverlay || !overlay.isConnected || modalState !== 'open') return;
      const body = panel.querySelector('.modal-panel__body');
      body.insertAdjacentHTML('beforeend', markup());
      if (window.lucide) window.lucide.createIcons({ el: body });
      mountFooter(panel);
      trapFocus(panel, 'none');
      if (_initialFormTimeout) clearTimeout(_initialFormTimeout);
      _snapshotNow();
      _initialFormTimeout = setTimeout(_snapshotNow, 150);
      // Sichtbar VOR `onSave`: wer dort selbst fokussiert, braucht eine Tafel,
      // die Fokus annimmt. Gemalt wird ohnehin erst nach dieser Aufgabe.
      panel.classList.remove('modal-panel--pending');
      // Der Erstfokus kommt hier sofort, nicht 50 ms spaeter: seit dem Tipp
      // konnte ihn niemand waehlen (die Tafel war unsichtbar), und ein spaeter
      // Fokus erzwang Stil und Layout mitten in der Einfahrt. Was `onSave`
      // selbst fokussiert, gilt als Wahl und bleibt (_focusInitialUnlessClaimed).
      const planned = document.activeElement;
      const target = resolveInitialFocus(panel, initialFocus);
      if (typeof onSave === 'function') onSave(panel);
      if (target) _focusInitialUnlessClaimed(panel, target, planned);
    });
  }

  // Loading-State
  panel.addEventListener('submit', (e) => {
    const btn = e.target.querySelector('[type="submit"], .btn--primary');
    if (!btn || btn.disabled) return;
    btn.classList.add('btn--loading');
    requestAnimationFrame(() => {
      if (!btn.disabled) { btn.classList.remove('btn--loading'); return; }
      const mo = new MutationObserver(() => {
        if (!btn.disabled) { btn.classList.remove('btn--loading'); mo.disconnect(); }
      });
      mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    });
  }, { capture: true });

  // Standalone: Statusbar abdunkeln
  if (window.yuvomi?.setThemeColor) {
    window.yuvomi.setThemeColor(OVERLAY_THEME_COLOR, OVERLAY_THEME_COLOR);
  }

  modalState = 'open';
}

/**
 * „WEITERE ANGABEN" KLAPPT INS BILD, NICHT UNTER DEN FUSS (Critique R21, a4).
 *
 * Der Aufklapper steht in langen Dialogen am unteren Rand des Scrollbereichs.
 * Am Telefon ging er auf, und alles, was er zeigte, lag unter der festen
 * Fusszeile: gemessen im Buchungsdialog 0 von 5 neuen Zeilen sichtbar, die
 * erste 8px unter der Kante des Fusses. Wer ihn antippt, bekommt jetzt so viel
 * vom Neuen zu sehen, wie hineinpasst - die Beschriftung bleibt dabei im Bild,
 * damit klar ist, was da aufging.
 *
 * Nur auf den Klick hin: ein Aufklapper, der schon offen geladen wird (beim
 * Bearbeiten, sobald dahinter ein Wert steht) oder den ein Feldfehler aufmacht
 * (constraintErrors), feuert dasselbe `toggle` und darf den Dialog nicht
 * verschieben. `toggle` steigt nicht auf - deshalb die Capture-Phase.
 */
function _wireAdvancedReveal(panel) {
  let clicked = null;
  panel.addEventListener('click', (event) => {
    const summary = event.target instanceof Element ? event.target.closest('details.form-advanced > summary') : null;
    clicked = summary ? summary.parentElement : null;
  }, true);
  panel.addEventListener('toggle', (event) => {
    const details = event.target;
    if (details !== clicked) return;
    clicked = null;
    if (!details.open) return;
    requestAnimationFrame(() => _revealOpenedSection(panel, details));
  }, true);
}

function _revealOpenedSection(panel, details) {
  const body = details.querySelector('.form-advanced__body') ?? details;
  const scroller = details.closest('.modal-panel__body') ?? panel;
  if (typeof scroller.scrollBy !== 'function') return;
  const view = scroller.getBoundingClientRect();
  // Die Fusszeile steht fest ueber dem Scrollbereich oder klebt in ihm: was
  // hinter ihr liegt, ist nicht zu sehen.
  const footer = panel.querySelector('.modal-panel__footer');
  const footerTop = footer ? footer.getBoundingClientRect().top : view.bottom;
  const visibleBottom = Math.min(view.bottom, footerTop > view.top ? footerTop : view.bottom);
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4')) || 16;
  const need = body.getBoundingClientRect().bottom + gap - visibleBottom;
  const summary = details.querySelector('summary') ?? details;
  const room = summary.getBoundingClientRect().top - view.top;
  const delta = Math.min(need, room);
  if (delta <= 1) return;
  scroller.scrollBy({ top: delta, behavior: _reducedMotion() ? 'auto' : 'smooth' });
}

// --------------------------------------------------------
// closeModal
// --------------------------------------------------------

/**
 * EIN SPAETER ABLAUF SCHLIESST NUR SEINEN EIGENEN DIALOG (#1997). Es gibt einen
 * einzigen Modal-Slot, und `closeModal()` ohne Weiteres schliesst, was gerade
 * darin liegt. Wer erst nach einem `await` schliesst (Speichern kam an,
 * Verknuepfen ist durch), trifft so den Dialog, den der Nutzer INZWISCHEN
 * geoeffnet hat - samt allem, was er dort schon eingetippt hat, denn
 * `force: true` fragt nicht nach. Deshalb haelt der Aufrufer VOR der Anfrage
 * `captureModalContext()` fest und reicht es hier als `context` herein:
 * geschlossen wird nur, wenn noch genau dieser Dialog im Slot liegt.
 *
 * Verglichen wird der Overlay-Knoten, nicht die Generation und nicht die
 * Route. Die Generation zaehlt jedes openModal(), auch die Rueckfrage
 * „Aenderungen verwerfen?", die den Dialog nur parkt und ihn danach als
 * DENSELBEN Knoten zurueckgibt - sein Erfolg muesste ihn weiter schliessen
 * duerfen. Ein neu geoeffneter Dialog ist dagegen immer ein neuer Knoten, auch
 * wenn er dieselbe Maske zeigt. Die Seite spielt fuer das Schliessen keine
 * Rolle: liegt der eigene Dialog noch offen, ist Schliessen richtig, gleich
 * was die Seite darunter inzwischen neu gezeichnet hat.
 *
 * @param {{ force?: boolean, context?: ReturnType<typeof captureModalContext> | null }} [options]
 * @returns {Promise<boolean>} ob der Dialog wirklich zugeht. `false` heisst
 *   ausschliesslich: der Nutzer hat das Verwerfen ungespeicherter Aenderungen
 *   abgelehnt, das Modal bleibt offen. Die Zurueck-Geste braucht diese
 *   Unterscheidung (#871) - ohne sie verloere ein abgelehntes Schliessen den
 *   History-Marker, und die naechste Geste fuehre aus der Seite heraus. Ist
 *   der Dialog aus `context` schon weg, ist das ebenfalls `true`: er ist zu,
 *   und der Dialog, der jetzt offen ist, geht diesen Aufrufer nichts an.
 */
export async function closeModal({ force = false, context = null } = {}) {
  if (context && !isOwnModalOpen(context)) {
    // Geparkt statt ersetzt: der eigene Dialog liegt unter einer Rueckfrage
    // („Aenderungen verwerfen?") und kommt bei „Abbrechen" zurueck. Ihn jetzt
    // zu schliessen, schloesse die Rueckfrage; ihn stehen zu lassen, liesse
    // einen schon gespeicherten Dialog offen (Speichern-Knopf noch gesperrt).
    // Also merken - _resumeSuspendedModal schliesst ihn, sobald er zurueck ist.
    if (_isParked(context.overlay)) _closeOnResume.add(context.overlay);
    return true;
  }
  // Bereits im Schließ-Lauf? Erneute Aufrufe (z.B. schnelles Doppel-Schließen,
  // Hardware-Back) ignorieren - der Dialog geht ohnehin zu, also `true`.
  if (!activeOverlay || modalState === 'closing') return true;

  if (!force) {
    const panel = activeOverlay.querySelector('.modal-panel');
    if (panel && isFormDirty(panel)) {
      // Dirty Modal in den Confirm-Slot parken (modalState → 'confirming').
      const suspended = _suspendActiveModal();

      const confirmed = await _confirmOverSuspended(t('modal.unsavedChanges'), {
        // danger: „Verwerfen" wirft Eingaben unwiderruflich weg. Als
        // btn--primary lud die Optik im Moment des Zögerns zur destruktiven
        // Wahl ein (Critique 2026-08-31); rot benennt die Konsequenz.
        danger: true,
        confirmLabel: t('modal.discardChanges'),
        detail: t('modal.unsavedChangesDetail'),
      }, suspended);

      if (!confirmed) {
        // Verwerfen abgebrochen → dirty Modal exakt wiederherstellen, samt
        // Fokus auf dem Element, das den Dialog ausgelöst hat.
        _resumeSuspendedModal(suspended);
        return false;
      }

      // Verwerfen bestätigt → dirty Modal wieder aktiv, regulär abräumen.
      _discardSuspendedModal(suspended);
    }
  }

  // Finale Schließphase beginnt hier.
  modalState = 'closing';

  if (_initialFormTimeout) {
    clearTimeout(_initialFormTimeout);
    _initialFormTimeout = null;
  }
  _initialFormSnapshot = null;
  // Der Wächter gilt je Modal, nicht je Sitzung: das nächste openModal() soll
  // ihn wieder anhaben, wenn es nichts anderes sagt.
  _dirtyGuardEnabled = true;

  unbindEscape();

  const capturedOverlay = activeOverlay;
  const panel = capturedOverlay.querySelector('.modal-panel');

  if (typeof capturedOverlay._onCloseCallback === 'function') {
    capturedOverlay._onCloseCallback();
  }

  // Focus-Trap Cleanup
  if (focusTrapHandler) {
    if (panel) panel.removeEventListener('keydown', focusTrapHandler);
    focusTrapHandler = null;
  }
  if (panel?._onInputFocus) {
    panel.removeEventListener('focusin', panel._onInputFocus);
  }

  // Ausgang: Tafel und Overlay auf JEDER Breite (Critique 2026-09-26, P1-1).
  // Bis dahin gab es ihn nur mobil, und auch dort lief er nie - glass.css
  // schlug die Schliess-Regel, `animationend` kam nicht, und dieser Timer
  // raeumte nach 400ms eine Tafel ab, die die ganze Zeit reglos stand. Die
  // Kaskade haelt jetzt test-motion.js; der Timer bleibt als Sicherheitsnetz
  // fuer den Fall, dass das Ende doch ausbleibt (verdeckter Tab, abgehaengter
  // Knoten).
  //
  // Unter reduzierter Bewegung BLENDET DAS MODAL AUS statt hart zu schneiden
  // (Critique 2026-10-16, siehe _fade). Ohne Web Animations (Sonden ohne
  // Layout) geht der Knoten sofort; ein Netz faengt eine Blende, die nie endet.
  const reduceMotion = _reducedMotion();
  if (panel) {
    capturedOverlay.classList.add('modal-overlay--closing');
    // Ab hier ist die Seite wieder bedienbar, der Knoten blendet nur noch aus.
    _leaveTopLayer(capturedOverlay);
  }
  const blende = panel && reduceMotion ? _fade(capturedOverlay, 1, 0) : null;
  if (blende) {
    let fertig = false;
    const abraeumen = () => {
      if (fertig) return;
      fertig = true;
      _doClose(capturedOverlay);
    };
    setTimeout(abraeumen, MODAL_EXIT_FALLBACK_MS);
    blende.finished.then(abraeumen, abraeumen);
    return true;
  }
  if (panel && !reduceMotion) {
    panel.classList.add('modal-panel--closing');
    // _doClose setzt modalState auf 'idle', sobald der Overlay final entfernt wird.
    const fallback = setTimeout(() => {
      panel.removeEventListener('animationend', onExitEnd);
      _doClose(capturedOverlay);
    }, MODAL_EXIT_FALLBACK_MS);
    // NUR das Ende der eigenen Ausgangs-Animation. `animationend` blubbert: ein
    // Kind, das gerade fertig wird (Haken-Pop, Fehler-Wackeln), raeumte die
    // Tafel sonst mitten im Ausgang ab.
    function onExitEnd(event) {
      if (event.target !== panel) return;
      panel.removeEventListener('animationend', onExitEnd);
      clearTimeout(fallback);
      _doClose(capturedOverlay);
    }
    panel.addEventListener('animationend', onExitEnd);
    return true;
  }

  _doClose(capturedOverlay);
  return true;
}

/* Laenger als der laengste Ausgang (mobil `--duration-md` = 200ms), damit das
 * Netz nur greift, wenn das Ende wirklich ausbleibt. */
const MODAL_EXIT_FALLBACK_MS = 400;

// --------------------------------------------------------
// promptModal
// --------------------------------------------------------

export function promptModal(label, defaultValue = '') {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    openModal({
      pointerDeadTime: true,
      title: label,
      size: 'sm',
      content: `
        <form id="prompt-modal-form" class="form-stack">
          <div class="form-field">
            <label class="sr-only" for="prompt-modal-input">${esc(label)}</label>
            <input class="form-input" id="prompt-modal-input" type="text"
                   value="${esc(defaultValue)}" autocomplete="off">
          </div>
          <div class="modal-panel__footer">
            <button type="button" class="btn btn--secondary" id="prompt-modal-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary" id="prompt-modal-ok">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        const form  = panel.querySelector('#prompt-modal-form');
        const input = panel.querySelector('#prompt-modal-input');
        const cancel = panel.querySelector('#prompt-modal-cancel');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          // Ein leeres Feld ist keine Antwort (#1607). Bis dahin loeste es mit
          // null auf - demselben Wert wie Abbrechen -, der Dialog ging zu und
          // nichts geschah: Speichern sah aus wie ein Fehler ohne Text. null
          // heisst jetzt nur noch "abgebrochen"; kein Aufrufer liest ein leeres
          // Feld als gueltige Eingabe.
          const value = input.value.trim();
          if (!value) {
            reportFieldError(input, t('common.required'));
            return;
          }
          finish(value);
        });

        cancel.addEventListener('click', () => finish(null));

        setTimeout(() => {
          input.focus();
          input.select();
        }, 50);
      },
    });
  });
}

// --------------------------------------------------------
// selectModal
// --------------------------------------------------------

export function selectModal(label, options) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    const optionsHtml = options
      .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('');

    openModal({
      pointerDeadTime: true,
      title: label,
      size: 'sm',
      content: `
        <form id="select-modal-form" class="form-stack">
          <div class="form-field">
            <label class="sr-only" for="select-modal-input">${esc(label)}</label>
            <select class="form-input" id="select-modal-input">${optionsHtml}</select>
          </div>
          <div class="modal-panel__footer">
            <button type="button" class="btn btn--secondary" id="select-modal-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary" id="select-modal-ok">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        const form   = panel.querySelector('#select-modal-form');
        const select = panel.querySelector('#select-modal-input');
        const cancel = panel.querySelector('#select-modal-cancel');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          finish(select.value);
        });

        cancel.addEventListener('click', () => finish(null));
      },
    });
  });
}

// --------------------------------------------------------
// confirmModal
// --------------------------------------------------------

// Optional onConfirm completes the action before the confirmation is dismissed.
function wireConfirmation(panel, finish, onConfirm) {
  const ok = panel.querySelector('#confirm-modal-ok');
  const cancel = panel.querySelector('#confirm-modal-cancel');
  const error = panel.querySelector('#confirm-modal-error');
  let pending = false;
  ok?.addEventListener('click', async () => {
    if (pending) return;
    if (!onConfirm) return finish(true);
    pending = true;
    ok.disabled = true;
    if (cancel) cancel.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    if (error) error.hidden = true;
    try {
      await onConfirm();
      finish(true);
    } catch (err) {
      if (error) {
        // Der Satz der App, nie der des Servers oder des Browsers (#1909).
        error.textContent = errorSentence(err);
        error.hidden = false;
      }
    } finally {
      pending = false;
      ok.disabled = false;
      if (cancel) cancel.disabled = false;
      panel.removeAttribute('aria-busy');
    }
  });
  cancel?.addEventListener('click', () => { if (!pending) finish(false); });
}

/**
 * Bestätigungsdialog. `message` ist die Frage (wird zum Titel), `detail` die
 * optionale Folgen-Erklärung darunter. Die Trennung erlaubt es, das Objekt der
 * Aktion in der Frage zu benennen („‚SOGo Familie' trennen?") und die Konsequenz
 * separat zu erklären, ohne beides in einen Titel zu pressen.
 *
 * `cancelLabel` benennt den ZWEITEN Ausgang, wenn er eine eigene Handlung ist
 * und kein Abbruch. Beim Abwählen eines synchronisierten Kalenders etwa lauten
 * die Wege „Behalten" und „Löschen" - beide tun etwas, und „Abbrechen" auf dem
 * einen Knopf verschwiege, dass die Termine dann bleiben (#732). Ohne die
 * Angabe steht dort weiterhin „Abbrechen".
 * Optionales `onConfirm` wird vor dem Schliessen abgewartet. Bei einem Fehler
 * bleibt der Dialog fuer einen erneuten Versuch offen und zeigt die Meldung.
 */
export function confirmModal(message, { confirmLabel, cancelLabel, danger = false, detail = null, onConfirm } = {}) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    openModal({
      pointerDeadTime: true,
      title: message,
      size: 'sm',
      content: `
        ${detail ? `<p class="modal-confirm__detail">${esc(detail)}</p>` : ''}
        ${onConfirm ? '<p class="form-error" id="confirm-modal-error" role="alert" hidden></p>' : ''}
        <div class="modal-panel__footer">
          <button type="button" class="btn btn--secondary" id="confirm-modal-cancel">${cancelLabel ?? t('common.cancel')}</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="confirm-modal-ok">
            ${confirmLabel ?? t('common.confirm')}
          </button>
        </div>`,
      onClose: () => finish(false),
      onSave(panel) {
        wireConfirmation(panel, finish, onConfirm);
      },
    });
  });
}

async function finishSuspendedConfirmation(
  confirmed,
  closeOnConfirm,
  suspended,
  { resume = _resumeSuspendedModal, close = closeModal } = {},
) {
  resume(suspended);
  if (confirmed && closeOnConfirm) await close({ force: true });
  return confirmed;
}

/**
 * Bestätigung ÜBER einem offenen Modal, ohne es zu verdrängen.
 *
 * `confirmModal` läuft durch `openModal`, und das räumt ein offenes Modal mit
 * `force: true` weg (kein Stacking, siehe _suspendActiveModal). Aus einem
 * Formular-Modal heraus gefragt heißt das: ausgerechnet der Abbrechen-Pfad -
 * der einzige Grund, aus dem man überhaupt fragt - vernichtet die Eingaben,
 * ohne den Dirty-Guard auch nur zu streifen. Diese Variante parkt das Formular
 * stattdessen im Suspend-Token und gibt es bei „Abbrechen" unverändert zurück,
 * inklusive Dirty-Snapshot, Escape-Handler und Focus-Restore.
 *
 * Bestätigt der Nutzer, schließt das geparkte Modal mit `force: true`: die
 * Entscheidung nimmt die Eingaben ohnehin mit, eine zweite Rückfrage wäre
 * falsch (#625). Mit `closeOnConfirm: false` kehrt das Formular auch nach
 * Bestätigung zurück: ein Speichern darf anschließend noch validieren,
 * weitere Entscheidungen erfragen oder einen Serverfehler anzeigen.
 *
 * Ohne offenes Modal identisch mit `confirmModal` - eine Löschfunktion, die aus
 * Liste und Modal gleichermaßen aufgerufen wird, braucht keine Fallunterscheidung.
 *
 * @param {string} message - die Frage (wird zum Titel), wie bei confirmModal
 * @param {Object} [opts] - confirmModal-Optionen plus closeOnConfirm (Default true)
 * @returns {Promise<boolean>}
 */
function createConfirmOverModal({
  getActiveOverlay = () => activeOverlay,
  getModalState = () => modalState,
  showConfirmation = confirmModal,
  suspend = _suspendActiveModal,
  confirmSuspended = _confirmOverSuspended,
  resume = _resumeSuspendedModal,
  close = closeModal,
} = {}) {
  return async function confirmOverModal(message, { closeOnConfirm = true, ...opts } = {}) {
    // Nur ein regulär offenes Modal lässt sich parken: läuft gerade eine
    // Schließ-Animation oder liegt schon ein Dialog im Slot, gibt es nichts zu
    // schützen, und ein Suspend würde den laufenden Übergang zerlegen.
    if (!getActiveOverlay() || getModalState() !== 'open') return showConfirmation(message, opts);

    const suspended = suspend();
    const confirmed = await confirmSuspended(message, opts, suspended);
    // Erst zurückholen, dann ggf. schließen: das Abräumen soll durch die reguläre
    // Schließ-Logik laufen, nicht an ihrem 'closing'-Wächter vorbei. Der Fokus
    // kehrt dabei auf den auslösenden Knopf zurück (siehe _resumeSuspendedModal).
    return finishSuspendedConfirmation(
      confirmed,
      closeOnConfirm,
      suspended,
      { resume, close },
    );
  };
}

export const confirmOverModal = createConfirmOverModal();

/**
 * Eine Rückfrage ÜBER einem offenen Modal, deren Dialog der Aufrufer selbst
 * baut - für Fragen, die mehr als zwei Ausgänge haben (#1284: „Nur diesen
 * Termin" / „Diesen und folgende" / „Ganze Serie" / Abbrechen beim Speichern
 * eines Serientermins).
 *
 * Dieselbe Mechanik wie `confirmOverModal` mit `closeOnConfirm: false`: das
 * Formular wird geparkt, `ask()` öffnet den Dialog über `openModal` und liefert
 * ein Promise auf die Antwort, danach kommt das Formular in JEDEM Fall zurück -
 * samt Dirty-Snapshot, Escape-Handler und Fokus auf dem auslösenden Knopf. Was
 * mit der Antwort geschieht (speichern, eine Meldung an einem Feld zeigen,
 * abbrechen), entscheidet der Aufrufer am wiederhergestellten Formular.
 *
 * Ohne offenes Modal ruft es `ask()` einfach auf.
 *
 * @param {() => Promise<*>} ask - öffnet den Dialog, löst zur Antwort auf
 * @returns {Promise<*>} die Antwort von `ask`
 */
function createAskOverModal({
  getActiveOverlay = () => activeOverlay,
  getModalState = () => modalState,
  suspend = _suspendActiveModal,
  askSuspended = _askOverSuspended,
  resume = _resumeSuspendedModal,
} = {}) {
  return async function askOverModal(ask) {
    // Dieselbe Bedingung wie bei confirmOverModal: nur ein regulär offenes
    // Modal lässt sich parken.
    if (!getActiveOverlay() || getModalState() !== 'open') return ask();
    const suspended = suspend();
    const answer = await askSuspended(ask, suspended);
    resume(suspended);
    return answer;
  };
}

export const askOverModal = createAskOverModal();

/** Nur fuer Tests: Gesten und Bestaetigungen ohne echtes Panel treiben. */
export const __test = {
  serializeForm,
  // Critique R21: „Weitere Angaben" klappt ins Bild (der Zuhoerer am Panel).
  wireAdvancedReveal: (panel) => _wireAdvancedReveal(panel),
  // #1784: die Dirty-Basis als Programm - ein Overlay ohne openModal() zum
  // offenen Formular erklaeren (Basis sofort, ohne den 150-ms-Nachlauf), den
  // Waechter fragen und wieder aufraeumen.
  isFormDirty,
  adoptOverlayForTest(overlay) {
    activeOverlay = overlay;
    _dirtyGuardEnabled = true;
    _snapshotNow();
  },
  releaseOverlayForTest() {
    activeOverlay = null;
    _initialFormSnapshot = null;
  },
  // Das echte Parken und Zurueckholen (confirmOverModal/askOverModal), ohne
  // den Dialog dazwischen: die Basis wandert im Token mit.
  suspendActiveModal: _suspendActiveModal,
  resumeSuspendedModal: _resumeSuspendedModal,
  wireSheetSwipe: _wireSheetSwipe,
  createConfirmOverModal,
  createAskOverModal,
  finishSuspendedConfirmation,
  wireConfirmation,
  applyInitialFocus,
  trapFocus,
};

// --------------------------------------------------------
// Validation & Feedback
// --------------------------------------------------------

let _fieldErrorSeq = 0;

/**
 * Stellt sicher, dass die Feldgruppe eine Fehlermeldung besitzt und dass das
 * Eingabefeld per `aria-describedby` darauf zeigt. Ohne diese Verknüpfung
 * bekommen Screenreader die Meldung nie zu hören - ein Sammelbanner am
 * Formularende erfüllt WCAG 3.3.1 nicht.
 */
function _ensureFieldError(group, input, message, { live = true } = {}) {
  // Defensiv: die Klassen-Umschaltung funktioniert auch auf schlanken
  // Containern, das Anlegen einer Meldung braucht einen echten DOM-Knoten.
  if (typeof group.querySelector !== 'function' || typeof group.appendChild !== 'function') return;

  let el = group.querySelector('.form-field__error');
  const created = !el;
  if (!el) {
    el = document.createElement('p');
    el.className = 'form-field__error';
  }
  // Live-Region: Screenreader hören die Meldung auch dann, wenn der Fokus
  // nicht springt (Critique-Folgebefund zu WCAG 4.1.3). SPRINGT er aufs Feld,
  // liest der Screenreader die Meldung dort ueber aria-describedby vor - eine
  // Alarm-Rolle daneben sagte sie ein zweites Mal, und beim Speichern mit
  // mehreren Fehlern liefen mehrere Alarme ineinander (Critique R19 Nachlese,
  // Guide accessible-error-announcement: "avoid double announcement").
  // Gesetzt bzw. genommen VOR der Textaenderung, sonst gilt sie fuer diese
  // schon nicht mehr.
  if (live) el.setAttribute?.('role', 'alert');
  else el.removeAttribute?.('role');
  if (created) {
    el.textContent = t('common.required');
    // Direkt hinter das Feld, nicht ans Gruppenende: liegen Hinweistexte
    // dazwischen, rutscht die Meldung sonst weit weg (gemessen 86px beim
    // Passwortfeld) und liest sich als Fehler des ganzen Formulars.
    // AUSNAHME DIE FORMULARZEILE (`.form-row`, utils/form-row.js; R19): dort
    // steht das Feld in der rechten Spalte, und eine Meldung dahinter drueckte
    // es auf seine Mindestbreite (gemessen 52px im CardDAV-Dialog bei 390).
    // Die Meldung gehoert unter die Zeile, ueber beide Spalten (layout.css).
    if (group.classList?.contains?.('form-row')) {
      group.appendChild(el);
    } else if (typeof input.insertAdjacentElement === 'function') {
      input.insertAdjacentElement('afterend', el);
    } else {
      group.appendChild(el);
    }
  }
  if (message && el.textContent !== message) {
    // Eigene Meldung (z. B. „Enddatum vor Startdatum") anzeigen; den bisherigen
    // Text zum Wiederherstellen merken, damit eine spätere Pflichtfeld-
    // Validierung nicht die veraltete Spezialmeldung zeigt.
    if (el.dataset && el.dataset.defaultText === undefined) el.dataset.defaultText = el.textContent;
    el.textContent = message;
  } else if (!message && el.dataset && el.dataset.defaultText !== undefined) {
    el.textContent = el.dataset.defaultText;
    delete el.dataset.defaultText;
  }
  if (!el.id) el.id = `${input.id || `modal-field-${++_fieldErrorSeq}`}-error`;
  const describedBy = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!describedBy.includes(el.id)) {
    describedBy.push(el.id);
    input.setAttribute('aria-describedby', describedBy.join(' '));
  }
}

/* Erstes Fehlerfeld in den Blick holen: Fokus ohne Doppel-Scroll, dann das
 * Feld mittig in den scrollbaren Modal-Body scrollen. Ohne das verortete nur
 * ein Toast unten links den Fehler - bei langen Formularen blieb das Feld
 * unsichtbar (Critique P1). */
/**
 * Liest der Screenreader die Meldung beim Fokus selbst? Ja, wenn der Fokus
 * auf genau dem Element landet, das aria-describedby traegt - ein natives
 * Feld. Ein Custom Element (yuvomi-datepicker) gibt den Fokus an sein inneres
 * Feld weiter, die Beschreibung haengt aber am Aussenelement.
 */
function _describesOnFocus(input) {
  return typeof input?.matches === 'function' && input.matches('input, select, textarea, button');
}

function _focusField(input) {
  // Ein Feld hinter einem geschlossenen "Weitere Angaben" (advancedSection)
  // ist nicht fokussierbar und unsichtbar: der Fehler klappt seinen Abschnitt
  // auf, statt ins Leere zu zeigen (R24, Umbuchung/Darlehen).
  for (let d = input?.closest?.('details:not([open])'); d; d = d.parentElement?.closest?.('details:not([open])')) d.open = true;
  // Custom Elements (z. B. yuvomi-datepicker) sind selbst nicht fokussierbar:
  // stattdessen ihren inneren Formular-Knoten fokussieren.
  const isNative = typeof input.matches === 'function' && input.matches('input, select, textarea, button');
  const focusTarget = (!isNative && typeof input.querySelector === 'function'
    ? input.querySelector('input, select, textarea')
    : null) ?? input;
  if (typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true });
  if (typeof input.scrollIntoView === 'function') {
    // Bewusst instant statt smooth: Chrome bricht einen laufenden Smooth-
    // Scroll bei der gleichzeitigen Fehlertext-Einfügung ab (live gemessen),
    // und ein Fehler soll das Feld ohnehin SOFORT verorten.
    input.scrollIntoView({ block: 'center' });
  }
}

function _validateField(input, { live = true } = {}) {
  const group = input.closest('.form-field') ?? input.parentElement;
  const hasValue = input.value.trim().length > 0;
  const wasShown = Boolean(group?.classList.contains?.('form-field--error'));
  if (group) _ensureFieldError(group, input, undefined, { live });
  group?.classList.toggle('form-field--error', !hasValue);
  group?.classList.toggle('form-field--valid', hasValue);
  input.setAttribute('aria-invalid', String(!hasValue));
  // Die Meldung zieht auf, statt zu erscheinen: sie ist eine Zeile hoch, und
  // alles darunter rueckte in einem Frame um rund 24px - auch der Knopf, auf
  // den der Zeiger gerade zielt (R18). `expandIn` ist der Baustein dafuer.
  if (!hasValue && !wasShown) {
    const el = typeof group?.querySelector === 'function' ? group.querySelector('.form-field__error') : null;
    if (el) expandIn(el, { duration: durationToken('--duration-md', 200) });
  }

  if (!hasValue && group) {
    const count = parseInt(group.dataset.errorCount ?? '0', 10) + 1;
    group.dataset.errorCount = String(count);
    if (count >= 2) {
      group.classList.remove('form-field--error-repeat');
      void group.offsetWidth;
      group.classList.add('form-field--error-repeat');
      group.addEventListener('animationend', () => group.classList.remove('form-field--error-repeat'), { once: true });
    }
  } else if (hasValue && group) {
    group.dataset.errorCount = '0';
  }

  return hasValue;
}

/**
 * Felder, in die schon jemand geschrieben hat - je Knoten, ohne Spur im DOM.
 *
 * EIN UNBERUEHRTES PFLICHTFELD RUEGT NICHT (R18). Der Dialog oeffnet mit dem
 * Fokus im ersten Feld; der erste Tab, der Griff zum Datumswaehler, ein Klick
 * daneben - alles ein `blur` auf einem leeren Titel, und jedes davon meldete
 * "Dieses Feld ist erforderlich.", bevor irgendwer etwas versaeumt hatte
 * ("Neuer Termin", zwei Laeufe). Geruegt wird, wo eine Eingabe FEHLT: nach
 * dem Absenden (`validateAll`) oder wenn jemand das Feld beschrieben und
 * wieder geleert hat. Wer es nur durchquert, hat nichts falsch gemacht.
 */
const _touchedFields = new WeakSet();

export function wireBlurValidation(formContainer) {
  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    input.addEventListener('blur', () => {
      const pristineEmpty = input.value.trim().length === 0
        && !_touchedFields.has(input)
        && input.getAttribute('aria-invalid') !== 'true';
      if (pristineEmpty) return;
      _validateField(input);
    });
    // Sofortige Entwarnung: ist das Feld bereits als fehlerhaft markiert,
    // räumt die nächste Eingabe den Fehler ohne erneuten Blur auf.
    input.addEventListener('input', () => {
      _touchedFields.add(input);
      if (input.getAttribute('aria-invalid') === 'true') _validateField(input);
    });
  });
}

export function validateAll(formContainer) {
  let firstInvalid = null;
  let allValid = true;

  // Beim Absenden: der Fokus geht aufs erste leere Pflichtfeld und liest dort
  // seine Meldung - keine Alarm-Rolle je Feld daneben (Critique R19 Nachlese,
  // dieselbe Regel wie reportFieldErrors). Beim Verlassen eines Feldes (Blur)
  // bleibt die Meldung eine Live-Region, dort springt kein Fokus.
  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    const valid = _validateField(input, { live: !_describesOnFocus(input) });
    if (!valid && !firstInvalid) firstInvalid = input;
    if (!valid) allValid = false;
  });

  if (firstInvalid) _focusField(firstInvalid);
  return allValid;
}

/**
 * Meldet einen feldbezogenen Fehler mit eigener Meldung am Ort des Geschehens:
 * Meldung unter dem Feld (aria-describedby), Fehler-Rahmen über die
 * form-field--error-Tokens, Fokus + Scroll aufs Feld. Ersetzt die ortlosen
 * Fehler-Toasts der Modal-Speicherpfade (Critique P1); der Fehler räumt sich
 * bei der nächsten Eingabe im Feld selbst auf. Gibt immer false zurück, damit
 * Speicherpfade kompakt `return reportFieldError(...)` abbrechen können.
 */
export function reportFieldError(input, message, { focus = true, live = !(focus && _describesOnFocus(input)) } = {}) {
  if (!input) return false;
  const group = (typeof input.closest === 'function' ? input.closest('.form-field') : null) ?? input.parentElement;
  if (!group) return false;

  const wasShown = Boolean(group.classList?.contains?.('form-field--error'));
  _ensureFieldError(group, input, message, { live });
  group.classList?.add('form-field--error');
  group.classList?.remove('form-field--valid');
  // Dieselbe Bewegung wie in _validateField: die Meldung zieht auf.
  if (!wasShown && typeof group.querySelector === 'function') {
    const el = group.querySelector('.form-field__error');
    if (el) expandIn(el, { duration: durationToken('--duration-md', 200) });
  }
  input.setAttribute?.('aria-invalid', 'true');
  if (focus) _focusField(input);

  if (typeof input.addEventListener === 'function' && typeof input.removeEventListener === 'function') {
    const clear = () => {
      input.removeEventListener('input', clear);
      input.removeEventListener('change', clear);
      _clearFieldErrorIn(group, input);
    };
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }
  return false;
}

function _clearFieldErrorIn(group, input) {
  group.classList?.remove('form-field--error');
  input.setAttribute?.('aria-invalid', 'false');
  const el = typeof group.querySelector === 'function' ? group.querySelector('.form-field__error') : null;
  if (el?.dataset?.defaultText !== undefined) {
    el.textContent = el.dataset.defaultText;
    delete el.dataset.defaultText;
  }
}

/**
 * Raeumt einen Feldfehler, den `reportFieldError()` gesetzt hat, ohne dass im
 * Feld getippt wurde - fuer Handler, die denselben Wert erneut pruefen (eine
 * Suche, die beim zweiten Versuch klappt). Sonst raeumt ihn erst die naechste
 * Eingabe, und das Feld stuende mit dem alten Fehler neben gueltigen Treffern.
 */
export function clearFieldError(input) {
  if (!input) return;
  const group = (typeof input.closest === 'function' ? input.closest('.form-field') : null) ?? input.parentElement;
  if (!group) return;
  _clearFieldErrorIn(group, input);
}

/**
 * ALLE FELDFEHLER EINES FORMULARS AUF EINMAL (Critique R19, 2026-10-16).
 *
 * Die Speicherpfade prueften Feld fuer Feld und brachen beim ersten Fehler ab:
 * wer im Budget Titel UND Kategorie vergass, sah erst den einen Fehler, dann
 * nach dem naechsten Klick den anderen - und der Titel wurde vor dem Betrag
 * geprueft, obwohl der Betrag oben steht. Hier stehen alle Meldungen zugleich
 * an ihren Feldern, und der Fokus geht auf das ERSTE fehlerhafte Feld in der
 * Reihenfolge des Dokuments, nicht in der Reihenfolge der Pruefung.
 *
 * Ein Eintrag ist `[feld, meldung]`; leere Eintraege (`false`, `null`, ein
 * fehlendes Feld) zaehlen nicht, sodass ein Aufrufer `bedingung && [feld, text]`
 * schreiben kann. Mehrere Meldungen fuer DASSELBE Feld: die erste gewinnt.
 *
 * @param {Array<[Element|null|undefined, string]|false|null|undefined>} errors
 * @returns {boolean} true, wenn mindestens ein Fehler gemeldet wurde
 */
export function reportFieldErrors(errors) {
  const seen = new Set();
  const list = [];
  for (const entry of errors ?? []) {
    const input = Array.isArray(entry) ? entry[0] : null;
    if (!input || seen.has(input)) continue;
    seen.add(input);
    list.push(entry);
  }
  if (!list.length) return false;
  // Node.DOCUMENT_POSITION_FOLLOWING = 4: b steht hinter a.
  list.sort(([a], [b]) => {
    if (typeof a.compareDocumentPosition !== 'function') return 0;
    return (a.compareDocumentPosition(b) & 4) ? -1 : 1;
  });
  // Das erste Feld in DOM-Reihenfolge - destrukturiert, weil der
  // Initialen-Guard (test:initials) doppelte Null-Indizes als handgebaute
  // Initialen-Regel liest.
  const [[firstField]] = list;
  // EINE Ansage, nicht eine je Feld (Critique R19 Nachlese): der Fokus geht
  // aufs erste Feld, und dort liest der Screenreader dessen Meldung. Die
  // uebrigen stehen an ihren Feldern (aria-invalid, aria-describedby) und
  // werden beim Weitergehen gelesen - drei Alarme auf einmal liefen
  // ineinander. Nur ein Feld, das seine Beschreibung beim Fokus nicht selbst
  // liest (Datepicker), behaelt die Alarm-Rolle.
  for (const [input, message] of list) {
    reportFieldError(input, message, { focus: false, live: input === firstField && !_describesOnFocus(input) });
  }
  _focusField(firstField);
  return true;
}

/**
 * DIE REGELN DES MARKUPS, IN DER STIMME DER APP (Critique R21, a5).
 *
 * Ein Formular mit `novalidate` zeigt keine Browser-Blasen mehr - aber dann
 * prueft auch niemand mehr `required`, `min`, `max`, `step` und den Zahltyp,
 * die im Markup stehen. Statt sie im Handler ein zweites Mal von Hand
 * nachzurechnen, liest diese Funktion den ValidityState jedes Feldes (Guide
 * `forms`: "use ValidityState interfaces") und macht daraus Eintraege fuer
 * `reportFieldErrors()`: die Regel bleibt im Markup, die Meldung steht am Feld.
 *
 * Ausgenommen: Felder, die gerade nicht gezeichnet sind (`display: none` am
 * Feld oder einem Vorfahren - ihr Wert geht nicht mit), und die inneren Felder
 * des Datumsfelds, das seine Eingabe selbst prueft. Ein Feld in einem
 * zugeklappten „Weitere Angaben" zaehlt: der Aufklapper geht dafuer auf.
 *
 * @param {HTMLFormElement|null|undefined} form
 * @returns {Array<[Element, string]>}
 */
export function constraintErrors(form) {
  const out = [];
  for (const el of Array.from(form?.elements ?? [])) {
    if (!el.willValidate || el.validity?.valid !== false) continue;
    if (el.closest?.('yuvomi-datepicker')) continue;
    const folded = el.closest?.('details:not([open])');
    if (folded) folded.open = true;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) {
      // Auch aufgeklappt nicht gezeichnet: kein Feld, das jemand sieht.
      if (folded) folded.open = false;
      continue;
    }
    out.push([el, constraintMessage(el)]);
  }
  return out;
}

function constraintMessage(el) {
  const v = el.validity;
  const num = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? getNumberFormat({ maximumFractionDigits: 6 }).format(n) : String(raw);
  };
  if (v.valueMissing) return t('common.required');
  if (v.badInput) return t('common.fieldNumber');
  if (v.rangeUnderflow) return t('common.fieldMin', { min: num(el.min) });
  if (v.rangeOverflow) return t('common.fieldMax', { max: num(el.max) });
  if (v.stepMismatch) {
    const step = Number(el.step);
    return Number.isInteger(step) && step === 1 ? t('common.fieldWholeNumber') : t('common.fieldStep', { step: num(el.step) });
  }
  return t('common.fieldInvalid');
}

export function btnSuccess(btn, originalLabel) {
  btn.classList.remove('btn--loading');
  const label = originalLabel ?? btn.textContent;
  btn.classList.add('btn--success');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('aria-hidden', 'true');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '20 6 9 17 4 12');
    svg.appendChild(poly);
    btn.replaceChildren(svg);
  }
  setTimeout(() => {
    btn.classList.remove('btn--success');
    btn.textContent = label;
  }, 700);
}

export function btnLoading(btn) {
  btn.classList.add('btn--loading');
  btn.disabled = true;
  return () => {
    btn.classList.remove('btn--loading');
    btn.disabled = false;
  };
}

export function btnError(btn) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    btn.classList.add('btn--error-static');
    setTimeout(() => btn.classList.remove('btn--error-static'), 700);
    return;
  }
  btn.classList.remove('btn--shaking');
  void btn.offsetWidth;
  btn.classList.add('btn--shaking');
  btn.addEventListener('animationend', () => btn.classList.remove('btn--shaking'), { once: true });
}

// --------------------------------------------------------
// Dialogregel Erstfokus (Critique R24 S3, DESIGN.md D4)
// --------------------------------------------------------

/**
 * DER ERSTFOKUS EINES DIALOGS, DER ANLEGT UND BEARBEITET. Anlegen: das erste
 * Pflichtfeld (Tastatur ist gewollt, es wird gleich getippt). Bearbeiten:
 * `'edit'` - am Finger nimmt der Titel den Fokus, keine Tastatur ueber dem
 * halben Blatt (R23 D13; resolveInitialFocus). Guard: `test:control-dialect`
 * "edit-autofocus" (jeder Dialog mit Bearbeiten-Titel setzt initialFocus).
 *
 * @param {boolean} isEdit
 * @param {string} [required] - Selektor des ersten Pflichtfelds, wenn es eine
 *   Auswahl ist (die Regel sucht Tippfelder zuerst, resolveInitialFocus)
 * @returns {string}
 */
export function dialogInitialFocus(isEdit, required = 'first-field') {
  return isEdit ? 'edit' : required;
}

// --------------------------------------------------------
// Progressive Disclosure: „Weitere Einstellungen"
// --------------------------------------------------------

/**
 * Kapselt Sekundärfelder eines Formulars in einem einklappbaren <details>.
 * Häufigste Felder bleiben oben sichtbar, seltene wandern hinter einen
 * „Weitere Einstellungen"-Aufklapper. Gibt einen HTML-String zurück, der in
 * den `content` von openModal() eingesetzt wird (Injektion via
 * insertAdjacentHTML in openModal - kein innerHTML).
 *
 * Die enthaltenen Felder bleiben unabhängig vom Auf-/Zuklappen im DOM, sodass
 * bestehende querySelector-Verdrahtung, Dirty-Check und Validierung
 * unverändert funktionieren.
 *
 * @param {string} innerHtml        - Markup der Sekundärfelder (bereits esc-sicher)
 * @param {Object} [opts]
 * @param {string} [opts.label]     - Aufklapper-Beschriftung (Default: t('modal.moreDetails') -
 *   EIN Wort fuer diesen Baustein in jedem Modul, Critique R21 D15)
 * @param {boolean} [opts.open=false] - Initial geöffnet (z. B. wenn Sekundärfelder bereits befüllt sind)
 * @param {string} [opts.hint]      - Zweite Zeile unter der Beschriftung: was hinter dem
 *   Aufklapper liegt (Klartext, wird escaped). Ohne sie findet ein Feld dort nur, wer
 *   schon weiss, dass es existiert.
 * @returns {string} HTML-String
 */
export function advancedSection(innerHtml, { label, open = false, hint = '' } = {}) {
  const text = esc(label ?? t('modal.moreDetails'));
  const labelHtml = hint
    ? `<span class="form-advanced__label"><span>${text}</span><span class="form-advanced__hint">${esc(hint)}</span></span>`
    : `<span>${text}</span>`;
  return `
    <details class="form-advanced"${open ? ' open' : ''}>
      <summary class="form-advanced__summary">
        ${labelHtml}
        <i data-lucide="chevron-down" class="form-advanced__chevron" aria-hidden="true"></i>
      </summary>
      <div class="form-advanced__body">
        ${innerHtml}
      </div>
    </details>`;
}
