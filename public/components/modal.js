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
let focusTrapHandler = null;
let _initialFormSnapshot = null;
let _initialFormTimeout = null;
let _modalFormSeq = 0;

// Modal-Lebenszyklus als explizite Zustandsmaschine (Audit 1.5). Ersetzt die
// frühere ad-hoc-Jonglage aus einem Boolean-Schließ-Flag plus temporär
// genullten Globals. Gültige Zustände:
//   idle       - kein Modal offen
//   open       - Modal sichtbar und interaktiv
//   confirming - „Änderungen verwerfen?"-Dialog liegt über einem dirty Modal
//   closing    - Schließ-Animation/Cleanup läuft (blockt erneutes Schließen)
let modalState = 'idle';

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

function _wireSheetSwipe(panel) {
  let startY = 0;
  let dragging = false;

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
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { panel.style.transform = 'translateY(0)'; return; } // Aufwärts: Panel zurücksetzen, dragging bleibt aktiv
    // Erst ab 10px Bewegung animieren: Verhindert winzige Transforms durch
    // normale Taps, die danach zurückgesetzt werden müssten.
    if (dy > 10) panel.style.transform = `translateY(${(dy - 10) * 0.6}px)`;
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
 * Ein Handler, der waehrend des offenen Modals einen Seitenbereich neu rendert,
 * tauscht den Knopf aus, der das Modal geoeffnet hat. Der gemerkte Zeiger zeigt
 * danach auf einen abgehaengten Knoten, und `.focus()` darauf ist ein No-op:
 * der Fokus faellt auf `document.body`, und wer mit Tastatur oder Screenreader
 * bedient, verliert seine Position in der Seite.
 *
 * Zwei Stufen, weil die erste nicht ueberall greift. Die id-Suche trifft den
 * Knopf, der an derselben Stelle wieder aufgebaut wurde; nur 3 der 7 Nutzer des
 * Kategorie-Managers geben ihrem Ausloeser aber ueberhaupt eine id (inventory
 * 2x und pantry haengen den Handler an `data-action`, shopping an einem
 * Popover-Trigger). Fuer sie ist die Seitenwurzel der Halt - kein guter Platz,
 * aber ein Platz IN der Seite, von dem aus Tab weiterlaeuft. `document.body`
 * ist dagegen kein Fokusziel, sondern das Fehlen eines Fokus.
 *
 * DIE ZWEITE STUFE IST VORSORGE, nicht Reparatur: gemessen liegt heute genau
 * bei EINEM der sieben - dem Budget - der Ausloeser im Bereich, den der Handler
 * austauscht, und der hat eine id. Die Wurzel faengt den naechsten id-losen
 * Ausloeser, der dazukommt. Ohne sie waere das wieder ein stiller Ausfall, und
 * genau das war der Befund.
 *
 * EIN VERSTECKTER POPOVER-EINTRAG IST KEIN FALL DAVON, obwohl er danach
 * aussieht: `utils/popover-menu.js` blendet sein Menue nur aus, ein Eintrag
 * meldet also weiter `isConnected === true`. Gemessen (Chrome 152, Maus wie
 * Tastatur) gibt `hidePopover()` den Fokus aber an den TRIGGER zurueck, und
 * zwar in der Capture-Phase des Klicks - also bevor der Seiten-Handler das
 * Modal oeffnet. `previouslyFocused` ist damit nie der Menueintrag, sondern der
 * Trigger, und der ist sichtbar und fokussierbar. Eine Sichtbarkeitspruefung
 * hier waere ein Layout-Read auf jedem Schliessen ohne einen Fall, der ihn
 * braucht.
 *
 * Eine Seite, die es genauer will, gibt ihrem Ausloeser eine id. Das ist
 * billiger als eine Option, die jede aufrufende Stelle einzeln pflegen muesste.
 *
 * Exportiert fuer die Sonde in `test/test-modal-utils.js`: das Fokusziel laesst
 * sich so ohne den vollen Oeffnen-Schliessen-Pfad messen, der ein echtes DOM
 * braeuchte.
 */
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

export function focusRestoreTarget(remembered) {
  if (!remembered) return null;
  if (remembered.isConnected) return remembered;
  // getElementById und kein Selektor: eine id darf Zeichen enthalten, an denen
  // querySelector scheitert.
  const replacement = remembered.id ? document.getElementById(remembered.id) : null;
  // Durch `_focusable` MUESSEN beide Wege: war der Ausloeser selbst die
  // Seitenwurzel, liefert die id-Suche sie direkt zurueck, und ein Rueckgabewert
  // an `_pageRoot()` vorbei haette wieder kein tabindex (Review zu #1069).
  return _focusable(replacement ?? document.getElementById(PAGE_ROOT_ID));
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
    const restoreTarget = focusRestoreTarget(previouslyFocused);
    if (restoreTarget && typeof restoreTarget.focus === 'function') {
      // Nur die Seitenwurzel bekommt `preventScroll`: sie IST der Scrollport
      // (#main-content == .app-content), ein Fokus mit Scroll risse die
      // wiederhergestellte Position nach oben. Ein Ersatzknopf steht dagegen
      // an der Stelle, an der der Nutzer ohnehin war.
      restoreTarget.focus(restoreTarget.id === PAGE_ROOT_ID ? { preventScroll: true } : undefined);
    }
    previouslyFocused = null;

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
  previouslyFocused = document.activeElement;

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
 * falsch (#625).
 *
 * Ohne offenes Modal identisch mit `confirmModal` - eine Löschfunktion, die aus
 * Liste und Modal gleichermaßen aufgerufen wird, braucht keine Fallunterscheidung.
 *
 * @param {string} message - die Frage (wird zum Titel), wie bei confirmModal
 * @param {Object} [opts]  - identisch zu confirmModal ({ confirmLabel, danger, detail })
 * @returns {Promise<boolean>}
 */
export async function confirmOverModal(message, opts = {}) {
  // Nur ein regulär offenes Modal lässt sich parken: läuft gerade eine
  // Schließ-Animation oder liegt schon ein Dialog im Slot, gibt es nichts zu
  // schützen, und ein Suspend würde den laufenden Übergang zerlegen.
  if (!activeOverlay || modalState !== 'open') return confirmModal(message, opts);

  const suspended = _suspendActiveModal();
  const confirmed = await _confirmOverSuspended(message, opts, suspended);
  // Erst zurückholen, dann ggf. schließen: das Abräumen soll durch die reguläre
  // Schließ-Logik laufen, nicht an ihrem 'closing'-Wächter vorbei. Der Fokus
  // kehrt dabei auf den auslösenden Knopf zurück (siehe _resumeSuspendedModal).
  _resumeSuspendedModal(suspended);
  if (confirmed) await closeModal({ force: true });
  return confirmed;
}

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
