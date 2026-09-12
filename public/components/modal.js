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
 *               initialFocus, headerAction }) → void
 *   closeModal({ force }) → Promise<void>
 *   confirmModal(message, opts) → Promise<boolean>       (ersetzt ein offenes Modal)
 *   confirmOverModal(message, opts) → Promise<boolean>   (parkt es und gibt es zurück)
 *
 * Nachträglich gemountete Panes (Detailansicht → Formular, detail-view.js)
 *   mountFooter(panel)             → hebt eine neu gerenderte Fußzeile ans Panel
 *   refreshDirtySnapshot()         → Dirty-Basis auf den jetzigen Stand setzen
 *   focusFirstField(panel)         → Fokus nach dem Pane-Wechsel, touch-bewusst
 *   updateHeaderAction(panel, …)   → Beschriftung/Handler des Kopf-Buttons tauschen
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { pushOverlay, dropOverlay, isOverlayOpen } from '/utils/overlay-history.js';

let activeOverlay = null;
let previouslyFocused = null;
// Das Fokusziel des letzten Schliessens - `refocusAfterRender()` greift darauf
// zurueck, wenn die Seite erst nach einem `await` fertig gerendert hat.
let _lastRestore = null;
let focusTrapHandler = null;
let _initialFormSnapshot = null;
let _initialFormTimeout = null;
let _modalFormSeq = 0;
// Monotone Kennung des zuletzt tatsaechlich eingesetzten Shared-Modals. Ein
// asynchroner Ablauf kann damit erkennen, dass inzwischen ein anderer Dialog
// den einzigen Slot besessen hat - auch wenn dieser schon wieder geschlossen
// wurde und im DOM deshalb keine Spur mehr hinterlaesst.
let _modalGeneration = 0;

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
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    pageRoot: document.getElementById('main-content')?.firstElementChild ?? null,
  };
}

/** Ob seit captureModalContext() weder Dialog noch Seiteninstanz wechselte. */
export function isModalContextCurrent(context) {
  if (!context || context.generation !== _modalGeneration) return false;
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
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
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
// Dateneingabe gehört.
const FIRST_FIELD = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

// --------------------------------------------------------
// Focus-Trap (Spec §5.2)
// --------------------------------------------------------

function trapFocus(container, initialFocus = 'first-field') {
  focusTrapHandler = (e) => {
    // Tab-Trap: Fokus innerhalb des Modals halten
    if (e.key === 'Tab') {
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
    if (e.key === 'Enter') {
      const active = document.activeElement;
      const isInput = active.tagName === 'INPUT' && active.type !== 'submit' && active.type !== 'button';
      const isSelect = active.tagName === 'SELECT';

      if (isInput || isSelect) {
        const submitBtn = container.querySelector('button[type="submit"], .btn--primary');
        if (submitBtn && !submitBtn.disabled) {
          e.preventDefault();
          submitBtn.click();
        }
      }
    }
  };
  container.addEventListener('keydown', focusTrapHandler);

  // Virtual Keyboard: Focused Input in sichtbaren Bereich scrollen
  function onInputFocus(e) {
    const tag = e.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    setTimeout(() => {
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
 */
function applyInitialFocus(container, initialFocus) {
  if (initialFocus === 'none') return;

  if (initialFocus && typeof initialFocus.focus === 'function') {
    setTimeout(() => initialFocus.focus(), 50);
    return;
  }

  const first = container.querySelector(FIRST_FIELD) ?? container.querySelector(FOCUSABLE);
  if (first) {
    setTimeout(() => first.focus(), 50);
  }
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

  const target = panel.querySelector(FIRST_FIELD) ?? panel.querySelector(FOCUSABLE);
  target?.focus();
  return target ?? null;
}

// --------------------------------------------------------
// Dirty-Check Helpers
// --------------------------------------------------------

function serializeForm(container) {
  const inputs = container.querySelectorAll('input:not([type="file"]), select, textarea');
  return Array.from(inputs).map((el) => `${el.name || el.id}=${el.value}`).join('&');
}

function isFormDirty(container) {
  if (_initialFormSnapshot === null) return false;
  return serializeForm(container) !== _initialFormSnapshot;
}

function _snapshotNow() {
  if (!activeOverlay) return;
  _initialFormSnapshot = serializeForm(activeOverlay.querySelector('.modal-panel') ?? activeOverlay);
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

// --------------------------------------------------------
// Escape-Handler
// --------------------------------------------------------

function onEscape(e) {
  if (e.key === 'Escape') closeModal();
}

// --------------------------------------------------------
// Swipe-to-Close (Mobile)
// --------------------------------------------------------

// Beruehrungs-Schlupf der Wischgeste, in BEIDE Richtungen derselbe: unterhalb
// davon entscheidet sie weder "Sheet ziehen" noch "Inhalt scrollen".
const SHEET_SWIPE_SLOP_PX = 10;

function _wireSheetSwipe(panel) {
  let startY = 0;
  let dragging = false;
  // Hat dieser Finger das Sheet schon nach unten gezogen? Erst dann gehört eine
  // Aufwärtsbewegung zum Zug; davor ist sie Scrollen des Inhalts (#981).
  let pulled = false;

  // Scroll position is now on the body, not the panel itself
  const scrollBody = panel.querySelector('.modal-panel__body');

  panel.addEventListener('touchstart', (e) => {
    // Nur von der Handle-Zone (obere 48px) oder wenn Panel ganz oben → Swipe erlauben
    const touchY = e.touches[0].clientY;
    const rect = panel.getBoundingClientRect();
    const isHandleZone = touchY - rect.top < 48;
    const isScrolledToTop = (scrollBody ? scrollBody.scrollTop : panel.scrollTop) <= 0;
    if (!isHandleZone && !isScrolledToTop) return;
    startY = touchY;
    dragging = true;
    pulled = false;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) {
      // RICHTUNGSSPERRE (#981). Ein frisch geöffneter Dialog steht oben, also
      // begann JEDE Wischgeste im Inhalt als verfolgter Zug, und der schrieb
      // bei jedem Aufwärts-Frame `translateY(0)` ans Panel. Solange die
      // Einfahranimation das Panel hält (`forwards`), aendert das nichts; mit
      // "Bewegung reduzieren" gibt es keine Animation, das Inline-transform
      // wirkt, und iOS bricht das Scrollen des Inhalts ab - gemessen im
      // Simulator: 0 bis 30 px statt 500 bis 675 px fuer dieselbe Geste.
      // Aufwärts, bevor das Sheet gezogen wurde, ist deshalb kein Zug: die
      // Geste gibt ab und fasst das Panel nicht an.
      //
      // Aber erst jenseits derselben Schwelle, die abwärts gilt: ein Finger
      // zittert beim Aufsetzen, und ein einzelner Pixel nach oben durfte eine
      // gewollte Schliessgeste nicht verwerfen. Innerhalb der Schwelle
      // passiert nichts - kein Abbruch, kein Schreibzugriff.
      if (!pulled) {
        if (dy < -SHEET_SWIPE_SLOP_PX) dragging = false;
        return;
      }
      // Ein begonnener Zug bleibt verfolgt, wenn der Finger zurückkehrt - sonst
      // endete touchend ohne Rücksetzen und das Panel stünde verschoben
      // (b7c0312c). Zurückgesetzt wird einmal, nicht in jedem Frame.
      if (panel.style.transform) panel.style.transform = '';
      return;
    }
    // Erst ab der Schwelle animieren: Verhindert winzige Transforms durch
    // normale Taps, die danach zurückgesetzt werden müssten.
    if (dy > SHEET_SWIPE_SLOP_PX) {
      pulled = true;
      panel.style.transform = `translateY(${(dy - SHEET_SWIPE_SLOP_PX) * 0.6}px)`;
    }
  }, { passive: true });

  panel.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80) {
      panel.style.transform = '';
      closeModal();
    } else {
      // Transform-Reset per rAF verzögern: DOM-Mutationen direkt in touchend
      // unterbrechen auf iOS WebKit die Touch→Click-Konvertierung - der click-Event
      // auf Child-Elementen (Buttons) wird gecancelt → Buttons reagieren nicht.
      requestAnimationFrame(() => { panel.style.transform = ''; });
    }
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
    snapshot: _initialFormSnapshot ?? (panel ? serializeForm(panel) : null),
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

// Dialog beendet, Modal darunter lebt weiter → exakt wiederherstellen.
function _resumeSuspendedModal({ overlay, id, title, titleId, snapshot, restoreFocus, trigger }) {
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
  _initialFormSnapshot = snapshot;
  previouslyFocused = restoreFocus;
  document.body.style.overflow = 'hidden';
  modalState = 'open';
  // Der Dialog hat den Escape-Handler beim Schließen abgemeldet; ohne das
  // erneute Anmelden reagiert das wiederhergestellte Modal nicht mehr auf Esc.
  document.removeEventListener('keydown', onEscape);
  document.addEventListener('keydown', onEscape);
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
  const pending = confirmModal(message, opts);
  const dialogOverlay = document.getElementById('shared-modal-overlay');
  try {
    const confirmed = await pending;
    await _awaitOverlayRemoval(dialogOverlay);
    return confirmed;
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

function _doClose(overlayEl) {
  const target = overlayEl ?? activeOverlay;
  if (!target) return;

  target.remove();

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
  const ownerForm = bodyFooter.closest('form');
  if (ownerForm) {
    if (!ownerForm.id) ownerForm.id = `modal-form-${++_modalFormSeq}`;
    bodyFooter.querySelectorAll('button, input, select, textarea').forEach((el) => {
      if (!el.hasAttribute('form')) el.setAttribute('form', ownerForm.id);
    });
  }

  // Beim Pane-Wechsel hängt bereits die Fußzeile der vorigen Ansicht am Panel.
  // Sie muss weichen, sonst stehen zwei Fußzeilen übereinander.
  [...panel.children]
    .filter((el) => el !== bodyFooter && el.classList?.contains('modal-panel__footer'))
    .forEach((el) => el.remove());

  panel.appendChild(bodyFooter);
  return bodyFooter;
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
 * @param {'first-field'|'none'|HTMLElement} [opts.initialFocus='first-field'] - siehe applyInitialFocus
 * @param {{label: string, id?: string, onClick?: Function}} [opts.headerAction] - Textbutton rechts im Kopf, links vom Schließen-X
 */
export function openModal({
  title, content, onSave, onDelete, onClose, size = 'md',
  initialFocus = 'first-field', headerAction = null,
} = {}) {
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

  const html = `
    <div class="modal-overlay" id="shared-modal-overlay" aria-label="${t('modal.overlayLabel')}">
      <div class="modal-panel${sizeClass}" role="dialog" aria-modal="true"
           aria-labelledby="shared-modal-title">
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
          ${content}
        </div>
      </div>
    </div>`;

  _modalGeneration += 1;
  document.body.insertAdjacentHTML('beforeend', html);
  activeOverlay = document.getElementById('shared-modal-overlay');
  activeOverlay._onCloseCallback = onClose;

  // Lucide-Icons rendern
  if (window.lucide) window.lucide.createIcons({ el: activeOverlay });

  // Focus-Trap
  const panel = activeOverlay.querySelector('.modal-panel');

  mountFooter(panel);

  // Kopf-Aktion verdrahten: der Listener ruft immer den aktuell hinterlegten
  // Callback, damit updateHeaderAction() ihn später tauschen kann, ohne den
  // Listener neu zu binden.
  const actionBtn = panel.querySelector('.modal-panel__action');
  if (actionBtn) {
    actionBtn._onAction = headerAction?.onClick;
    actionBtn.addEventListener('click', () => actionBtn._onAction?.());
  }

  trapFocus(panel, initialFocus);

  // Snapshot für Dirty-Check (kurzer Delay: Felder könnten noch per JS befüllt werden)
  if (_initialFormTimeout) clearTimeout(_initialFormTimeout);
  _initialFormSnapshot = null;
  _initialFormTimeout = setTimeout(_snapshotNow, 150);

  // Swipe-to-Close auf Mobile
  if (window.innerWidth < 768) {
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
  document.removeEventListener('keydown', onEscape);
  document.addEventListener('keydown', onEscape);

  // Callback für Aufrufer
  if (typeof onSave === 'function') onSave(panel);

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

// --------------------------------------------------------
// closeModal
// --------------------------------------------------------

/**
 * @returns {Promise<boolean>} ob der Dialog wirklich zugeht. `false` heisst
 *   ausschliesslich: der Nutzer hat das Verwerfen ungespeicherter Aenderungen
 *   abgelehnt, das Modal bleibt offen. Die Zurueck-Geste braucht diese
 *   Unterscheidung (#871) - ohne sie verloere ein abgelehntes Schliessen den
 *   History-Marker, und die naechste Geste fuehre aus der Seite heraus.
 */
export async function closeModal({ force = false } = {}) {
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

  document.removeEventListener('keydown', onEscape);

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

  // Animation handling
  const isMobile = window.innerWidth < 768;
  if (isMobile && panel) {
    panel.classList.add('modal-panel--closing');
    // _doClose setzt modalState auf 'idle', sobald der Overlay final entfernt wird.
    const fallback = setTimeout(() => {
      _doClose(capturedOverlay);
    }, 400); // Slightly longer fallback
    panel.addEventListener('animationend', () => {
      clearTimeout(fallback);
      _doClose(capturedOverlay);
    }, { once: true });
    return true;
  }

  _doClose(capturedOverlay);
  return true;
}

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
      title: label,
      size: 'sm',
      content: `
        <form id="prompt-modal-form" class="form-stack">
          <div class="form-field">
            <label class="sr-only" for="prompt-modal-input">${esc(label)}</label>
            <input class="form-input" id="prompt-modal-input" type="text"
                   value="${esc(defaultValue)}" autocomplete="off">
          </div>
          <div class="modal-actions">
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
          finish(input.value.trim() || null);
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
      title: label,
      size: 'sm',
      content: `
        <form id="select-modal-form" class="form-stack">
          <div class="form-field">
            <label class="sr-only" for="select-modal-input">${esc(label)}</label>
            <select class="form-input" id="select-modal-input">${optionsHtml}</select>
          </div>
          <div class="modal-actions">
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
 */
export function confirmModal(message, { confirmLabel, cancelLabel, danger = false, detail = null } = {}) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    openModal({
      title: message,
      size: 'sm',
      content: `
        ${detail ? `<p class="modal-confirm__detail">${esc(detail)}</p>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn--secondary" id="confirm-modal-cancel">${cancelLabel ?? t('common.cancel')}</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="confirm-modal-ok">
            ${confirmLabel ?? t('common.confirm')}
          </button>
        </div>`,
      onClose: () => finish(false),
      onSave(panel) {
        panel.querySelector('#confirm-modal-ok')?.addEventListener('click', () => finish(true));
        panel.querySelector('#confirm-modal-cancel')?.addEventListener('click', () => finish(false));
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

/** Nur fuer Tests: Gesten und Bestaetigungen ohne echtes Panel treiben. */
export const __test = {
  wireSheetSwipe: _wireSheetSwipe,
  createConfirmOverModal,
  finishSuspendedConfirmation,
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
function _ensureFieldError(group, input, message) {
  // Defensiv: die Klassen-Umschaltung funktioniert auch auf schlanken
  // Containern, das Anlegen einer Meldung braucht einen echten DOM-Knoten.
  if (typeof group.querySelector !== 'function' || typeof group.appendChild !== 'function') return;

  let el = group.querySelector('.form-field__error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'form-field__error';
    // Live-Region: Screenreader hören die Meldung auch dann, wenn der Fokus
    // nicht springt (Critique-Folgebefund zu WCAG 4.1.3).
    el.setAttribute?.('role', 'alert');
    el.textContent = t('common.required');
    // Direkt hinter das Feld, nicht ans Gruppenende: liegen Hinweistexte
    // dazwischen, rutscht die Meldung sonst weit weg (gemessen 86px beim
    // Passwortfeld) und liest sich als Fehler des ganzen Formulars.
    if (typeof input.insertAdjacentElement === 'function') {
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
function _focusField(input) {
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

function _validateField(input) {
  const group = input.closest('.form-field') ?? input.parentElement;
  const hasValue = input.value.trim().length > 0;
  if (group) _ensureFieldError(group, input);
  group?.classList.toggle('form-field--error', !hasValue);
  group?.classList.toggle('form-field--valid', hasValue);
  input.setAttribute('aria-invalid', String(!hasValue));

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

export function wireBlurValidation(formContainer) {
  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    input.addEventListener('blur', () => _validateField(input));
    // Sofortige Entwarnung: ist das Feld bereits als fehlerhaft markiert,
    // räumt die nächste Eingabe den Fehler ohne erneuten Blur auf.
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') _validateField(input);
    });
  });
}

export function validateAll(formContainer) {
  let firstInvalid = null;
  let allValid = true;

  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    const valid = _validateField(input);
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
export function reportFieldError(input, message) {
  if (!input) return false;
  const group = (typeof input.closest === 'function' ? input.closest('.form-field') : null) ?? input.parentElement;
  if (!group) return false;

  _ensureFieldError(group, input, message);
  group.classList?.add('form-field--error');
  group.classList?.remove('form-field--valid');
  input.setAttribute?.('aria-invalid', 'true');
  _focusField(input);

  if (typeof input.addEventListener === 'function' && typeof input.removeEventListener === 'function') {
    const clear = () => {
      input.removeEventListener('input', clear);
      input.removeEventListener('change', clear);
      group.classList?.remove('form-field--error');
      input.setAttribute?.('aria-invalid', 'false');
      const el = typeof group.querySelector === 'function' ? group.querySelector('.form-field__error') : null;
      if (el?.dataset?.defaultText !== undefined) {
        el.textContent = el.dataset.defaultText;
        delete el.dataset.defaultText;
      }
    };
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }
  return false;
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
 * @param {string} [opts.label]     - Aufklapper-Beschriftung (Default: t('modal.moreSettings'))
 * @param {boolean} [opts.open=false] - Initial geöffnet (z. B. wenn Sekundärfelder bereits befüllt sind)
 * @returns {string} HTML-String
 */
export function advancedSection(innerHtml, { label, open = false } = {}) {
  return `
    <details class="form-advanced"${open ? ' open' : ''}>
      <summary class="form-advanced__summary">
        <span>${esc(label ?? t('modal.moreSettings'))}</span>
        <i data-lucide="chevron-down" class="form-advanced__chevron" aria-hidden="true"></i>
      </summary>
      <div class="form-advanced__body">
        ${innerHtml}
      </div>
    </details>`;
}
