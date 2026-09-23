/**
 * Modul: Toast-Lage ueber offenen Dialogen (#1160)
 * Zweck: Der untere Shell-Stapel (Toasts, Sammelpille) weicht den Bedienleisten
 *        eines offenen Dialogs aus. Er bleibt sichtbar, aber er liegt nicht ueber
 *        Kopf, Fuss oder Aktionszeile eines Dialogs und nimmt deshalb keinen
 *        Klick, der dem Dialog gilt.
 *
 * ANLASS (12.09.2026, gemessen bei 1280x900): der Toast einer faelligen
 * Erinnerung lag genau auf "Speichern" des Kalenderdialogs. `elementFromPoint`
 * auf der Knopfmitte lieferte `.toast--reminder`, der Klick verwarf die
 * Erinnerung und speicherte nichts - ohne Fehlermeldung. Der Stapel steht ueber
 * Dialogen (`--z-toast` ueber `--z-modal`), damit eine Meldung waehrend eines
 * Dialogs sichtbar bleibt; positioniert ist er aber fuer die Seite, nicht fuer
 * den Dialog. Auf dem Telefon lag er ebenso ueber der ersten Fusszeile des
 * Sheets.
 *
 * WARUM NICHT `pointer-events: none` AUF DEM TOAST: dann gaebe er den Klick
 * zwar durch, verdeckte den Knopf aber weiter - wer "Speichern" nicht sieht,
 * trifft ihn auch nicht. Und der Erinnerungs-Toast IST bedienbar (Verwerfen,
 * Oeffnen). Der Behaelter ist seit jeher `pointer-events: none`, nur der Toast
 * selbst nimmt Klicks; das bleibt so.
 *
 * WARUM NICHT CSS-ANKERPOSITIONIERUNG: sie ist nicht Baseline-weit verfuegbar
 * (iOS vor 26 kennt sie nicht), und die Entscheidung haengt an Hoehen, die erst
 * gemessen feststehen: ob ueber dem Dialog Platz fuer den Stapel ist, sieht
 * keine Regel voraus.
 *
 * DIE ZUSAGE, und sie gilt fuer JEDE Geometrie (test:toast-placement rechnet
 * sie ueber tausende nach): der Stapel liegt ganz im Bild, innerhalb der
 * Sicherheitszonen, und er verdeckt keine Bedienleiste, solange es irgendeine
 * Lage gibt, die keine verdeckt. Die erste Fassung hielt das nicht: bei einem
 * Vollbild-Dialog ohne erkannte Leisten landete der Stapel ganz ueber dem
 * oberen Rand, unsichtbar und nicht mehr wegzuklicken (Review an #1421).
 *
 * DIE REIHENFOLGE DER LAGEN, jeweils die erste, die passt:
 *   1. Wo er steht, wenn er keinen Dialog beruehrt - eine Meldung springt nicht
 *      ohne Grund.
 *   2. Ueber dem Dialog (Telefon: der Streifen ueber dem Sheet; Desktop: ueber
 *      einem kurzen Dialog). Er verdeckt dann nichts.
 *   3. Unter dem Dialog, aus demselben Grund.
 *   4. Wo er steht, wenn er dort nur Inhalt verdeckt, keine Bedienleiste.
 *   5. Im Dialog, direkt ueber seiner unteren Bedienleiste; er verdeckt dann das
 *      Ende des scrollbaren Inhalts, der sich unter ihm hervorholen laesst.
 *   6. Jede andere freie Lage, die naechste zu seinem Platz. Freie Lagen liegen
 *      immer an einer Kante - einer Leiste oder des Bildes -, deshalb reicht es,
 *      diese Kanten durchzugehen.
 *   7. Gibt es keine freie Lage, die mit der kleinsten verdeckten Flaeche. Ist
 *      der Stapel hoeher als das Bild, beginnt er oben, damit sein erster
 *      Toast sichtbar und wegzuklicken bleibt.
 *
 * WO DIE LEISTEN SIND: `.modal-panel__header/__footer` und `.modal-actions`
 * (openModal, confirmModal, Detailansicht) und `[data-dialog-actions]` fuer
 * Dialoge mit eigenen Kopf- und Fusszeilen - UND IMMER DAZU jeder sichtbare
 * Knopf und Link des Dialogs. Die Auszeichnung ist eine Verstaerkung, keine
 * Voraussetzung: openModal-Dialoge tragen immer einen `.modal-panel__header`,
 * ihre Speichern-Zeile steht aber oft in einer eigenen Klasse im Koerper
 * (`.settings-form-actions`, `.housekeeping-form-submit`). Solange der
 * Rueckfall nur griff, wenn GAR NICHTS ausgezeichnet war, lag dort "Speichern"
 * wieder unter dem Toast (Ersatz-Review an #1421, gemessen an "Mitglied
 * bearbeiten"). Weggescrollte Knoepfe zaehlen nicht: jede Flaeche wird auf den
 * sichtbaren Ausschnitt ihrer scrollenden Vorfahren beschnitten, und ein Scroll
 * misst neu. Welcher Dialog welche Leisten auszeichnet, haelt das Register in
 * test/test-toast-placement.js fest.
 *
 * DAZU DAS FOKUSSIERTE ELEMENT (WCAG 2.4.11, Focus Not Obscured): ein Feld ist
 * keine Leiste, aber wer per Tab darauf landet, muss seinen Fokus sehen. Die
 * a11y-Runde auf 64cc2f5c0 mass im Budget-Dialog bei 375px `#bm-title` ganz
 * unter dem Toast, in "Mitglied bearbeiten" und Housekeeping ebenso ein Feld.
 * Frei gehalten wird nur das GERADE fokussierte Element, nicht jedes Feld -
 * sonst faende der Stapel in einem Formular nie Platz und klappte staendig
 * ein. Es zaehlt nur, wenn es in einem offenen Dialog liegt und nicht der
 * Dialog selbst ist; `focusin` misst neu, beschnitten wie die Knoepfe.
 *
 * FINDET SICH KEIN FREIER PLATZ und stehen mehrere Toasts im Stapel, zeigt er
 * nur noch den juengsten (bei 568x320 deckten drei Toasts im Kalender-Editor
 * dessen Kopf). Die uebrigen bleiben im Dokument, zurueckgenommen
 * (`.toast--tucked`) und `inert`, und kommen wieder, sobald Platz ist.
 *
 * Die Abstaende kommen aus tokens.css (`--toast-dock-gap` in layout.css), die
 * Lage schreibt dieses Modul als drei Variablen an den Stapel; die Regel, die
 * sie liest, steht bei `.shell-bottom-stack[data-dock]` in layout.css.
 */

/** Was als offener Dialog zaehlt: jede Dialogrolle, sichtbar und nicht inert. */
export const DIALOG_SELECTOR = '[role="dialog"]';

/** Die ausgezeichneten Bedienleisten eines Dialogs. */
export const ACTION_ZONE_SELECTOR =
  '.modal-panel__header, .modal-panel__footer, .modal-actions, [data-dialog-actions]';

/**
 * Immer dazu: die Bedienelemente selbst. `summary` ist der Ausloeser einer
 * Klappe ("Weitere Einstellungen" im Budget-Dialog) und nimmt einen Klick wie
 * ein Knopf; lag der Toast darauf, traf ein Klick dort den Toast.
 */
const CONTROL_SELECTOR = 'button, [type="submit"], a[href], [role="button"], summary';

/** Rueckfall fuer einen Dialog ganz ohne Knoepfe (Datumswahl ohne Leiste). */
const FIELD_SELECTOR = 'input, select, textarea, [tabindex]:not([tabindex="-1"])';

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Entscheidet die Lage des Stapels. Rein, damit sie ohne Browser pruefbar ist.
 *
 * @param {object} input
 * @param {{width:number,height:number}} input.viewport
 * @param {number} input.gap              Abstand zu Dialogkanten und Bildrand (px)
 * @param {number} [input.safeTop=0]      obere Sicherheitszone (px)
 * @param {number} [input.safeBottom=0]   untere Sicherheitszone (px)
 * @param {DOMRect|object} input.stack    Lage des Stapels an seinem Platz
 * @param {number} input.dockedHeight     Hoehe des Stapels in der Dialogbreite
 * @param {number} input.dockedWidth
 * @param {number} input.dockedCenter     waagerechte Mitte am Dialog
 * @param {DOMRect|object} input.primary  der Dialog, an dem er sich ausrichtet
 * @param {Array<DOMRect|object>} input.dialogs alle offenen Dialoge
 * @param {Array<DOMRect|object>} input.zones   alle Bedienleisten
 * @param {Array<DOMRect|object>} [input.keepClear=[]] Shell-Flaechen, die frei
 *        bleiben muessen, solange daneben Platz ist (die sichtbare untere Navigation)
 * @param {DOMRect|object|null} [input.focused=null] das fokussierte Element im
 *        Dialog; es zaehlt wie eine Bedienleiste (WCAG 2.4.11)
 * @returns {null | {top: number, covers: boolean}} null = der Stapel bleibt,
 *          wo er steht; `covers` = auch diese Lage beruehrt eine Leiste
 */
export function chooseToastPlacement({
  viewport, gap, safeTop = 0, safeBottom = 0,
  stack, dockedHeight, dockedWidth, dockedCenter,
  primary, dialogs, zones: marked, keepClear = [], focused = null,
}) {
  if (!dialogs.some((d) => intersects(stack, d))) return null;
  const zones = focused ? [...marked, focused] : marked;

  const h = dockedHeight;
  const left = dockedCenter - dockedWidth / 2;
  const right = dockedCenter + dockedWidth / 2;
  const minTop = safeTop + gap;
  const maxTop = viewport.height - safeBottom - gap - h;
  const at = (top) => ({ top, bottom: top + h, left, right, width: dockedWidth, height: h });
  const clear = (top, list) => !list.some((r) => intersects(at(top), r));
  // Im Bild UND neben der Navigation: die Grundlage des Stapels haelt ihr
  // `--nav-bottom-height` frei, eine Lage am Dialog muss das ebenso. Ein
  // Popover (Detailansicht ab 768px) deckt sie nicht ab, ein Toast darauf
  // naehme ihre Tipps (Review an #1421).
  const inBounds = (top) => top >= minTop && top <= maxTop;
  const inView = (top) => inBounds(top) && clear(top, keepClear);

  const result = (top) => ({ top, covers: !clear(top, zones) });

  // 2. und 3.: neben dem Dialog, ohne ihn zu beruehren.
  for (const top of [primary.top - gap - h, primary.bottom + gap]) {
    if (inView(top) && clear(top, dialogs)) return result(top);
  }

  // 4. Am eigenen Platz, solange dort keine Bedienleiste liegt.
  if (!zones.some((z) => intersects(stack, z))) return null;

  // 5. Ueber der unteren Bedienleiste des Dialogs.
  const middle = primary.top + primary.height / 2;
  const lower = zones.filter((z) => z.top >= middle && z.left < primary.right && z.right > primary.left);
  if (lower.length) {
    const top = Math.min(...lower.map((z) => z.top)) - gap - h;
    if (inView(top) && clear(top, zones)) return result(top);
  }

  // 6. Die naechste freie Lage an einer Kante - erst mit Abstand zur Leiste,
  // dann auf Stoss, wenn die Luecke fuer den Abstand zu schmal ist.
  const edgesAt = (margin) => [minTop, maxTop, ...[...zones, ...keepClear]
    .flatMap((z) => [z.top - margin - h, z.bottom + margin])];
  const candidates = [...edgesAt(gap), ...edgesAt(0)].filter(inView);
  const nearest = (list) => list
    .filter((top) => clear(top, zones))
    .sort((a, b) => Math.abs(a - stack.top) - Math.abs(b - stack.top))[0];
  const free = nearest(edgesAt(gap).filter(inView)) ?? nearest(edgesAt(0).filter(inView));
  if (free !== undefined) return result(free);

  // 7. Nichts ist frei: die kleinste verdeckte Flaeche, und immer im Bild -
  // neben der Navigation, wenn es das gibt, sonst auch auf ihr.
  if (maxTop < minTop) return result(minTop);
  const fallback = candidates.length
    ? candidates
    : [...edgesAt(gap), ...edgesAt(0)].filter(inBounds);
  let best = minTop;
  let bestArea = Infinity;
  for (const top of fallback.length ? fallback : [minTop]) {
    const area = zones.reduce((sum, z) => sum + overlapArea(at(top), z), 0);
    if (area < bestArea) {
      best = top;
      bestArea = area;
    }
  }
  return result(best);
}

function isOpen(el) {
  if (el.closest('[inert]')) return false;
  // OHNE `opacityProperty`: ein Dialog faehrt mit Deckkraft 0 ein, und gemessen
  // wird im ersten Frame nach dem Einfuegen. Mit ihr galt der Kalenderdialog
  // dort als geschlossen, und niemand fragte nach der Einfahrt wieder nach.
  const visible = typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ visibilityProperty: true })
    : el.getClientRects().length > 0;
  if (!visible) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0
    && r.bottom > 0 && r.right > 0
    && r.top < document.documentElement.clientHeight
    && r.left < document.documentElement.clientWidth;
}

function openDialogs() {
  return [...document.querySelectorAll(DIALOG_SELECTOR)].filter(isOpen);
}

/**
 * Das sichtbare Rechteck eines Elements: beschnitten auf jeden scrollenden oder
 * schneidenden Vorfahren bis zum Dialog. Ein weggescrollter Knopf ist keine
 * Leiste - er liegt hinter dem Rand des Koerpers, nicht unter dem Toast.
 */
function clippedRect(el, dialog) {
  const r = el.getBoundingClientRect();
  let top = r.top;
  let bottom = r.bottom;
  let left = r.left;
  let right = r.right;
  for (let node = el.parentElement; node && node !== dialog.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = node.getBoundingClientRect();
    top = Math.max(top, c.top);
    bottom = Math.min(bottom, c.bottom);
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
    if (node === dialog) break;
  }
  if (bottom - top <= 0 || right - left <= 0) return null;
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

/**
 * Das fokussierte Element, wenn es in einem der offenen Dialoge liegt -
 * beschnitten auf seinen sichtbaren Ausschnitt. Fokus auf `body`, ausserhalb
 * der Dialoge oder auf dem Dialog selbst (openModal fokussiert das Panel)
 * zaehlt nicht: dessen Rechteck ist der ganze Dialog.
 *
 * EIN VISUELL VERSTECKTES FELD ZEIGT SEINEN FOKUS AM LABEL (#1429-Folge). Die
 * Personen-Chips (`.user-ms`) verstecken ihre Checkbox als 1x1-Pixel am linken
 * Rand; den Fokusring traegt das Label. Frei gehalten wurde nur das Pixel, und
 * im Kalender-Editor lag bei 1280x900 jeder Chip beim Tab-Fokus unter dem
 * Toast. Ist das Feld hoechstens einen Pixel breit oder hoch, zaehlt deshalb
 * sein Label - das umschliessende oder das per `for` verbundene.
 */
function focusedRect(dialogEls) {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return null;
  const dialog = active.closest(DIALOG_SELECTOR);
  if (!dialog || active === dialog || !dialogEls.includes(dialog)) return null;
  if (active.getClientRects().length === 0) return null;
  return clippedRect(visibleFocusTarget(active), dialog);
}

function visibleFocusTarget(active) {
  const r = active.getBoundingClientRect();
  if (r.width > 1 && r.height > 1) return active;
  const label = active.closest('label') ?? active.labels?.[0];
  return label && label.getClientRects().length > 0 ? label : active;
}

function visibleRects(elements, dialog) {
  return elements
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => clippedRect(el, dialog))
    .filter(Boolean);
}

/**
 * Die Bedienleisten eines Dialogs: die ausgezeichneten UND seine Knoepfe, und
 * nur wenn er beides nicht hat, seine Felder oder er selbst.
 */
function dialogZones(dialog) {
  const own = (selector) => [...dialog.querySelectorAll(selector)]
    .filter((el) => el.closest(DIALOG_SELECTOR) === dialog);
  const zones = [
    ...visibleRects(own(ACTION_ZONE_SELECTOR), dialog),
    ...visibleRects(own(CONTROL_SELECTOR), dialog),
  ];
  if (zones.length) return zones;
  const fields = visibleRects(own(FIELD_SELECTOR), dialog);
  return fields.length ? fields : [dialog.getBoundingClientRect()];
}

/**
 * Shell-Flaechen, die der Stapel frei laesst: die untere Navigation, solange
 * sie sichtbar ist und kein Dialog-Hintergrund ueber ihr liegt. Ein modales
 * Overlay deckt sie ab (dann ist sie ohnehin nicht zu erreichen), ein Popover
 * nicht.
 */
function uncoveredChrome() {
  const nav = document.querySelector('.nav-bottom');
  if (!nav || nav.getClientRects().length === 0) return [];
  const r = nav.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return [];
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && nav.contains(hit) ? [r] : [];
}

function pxProperty(el, name) {
  const value = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * WANN EIN TOAST KAM, nicht wo er steht. Der Stapel haengt die bestimmte
 * Live-Region (Fehler, Warnungen) immer HINTER die hoefliche (Erinnerungen);
 * wer "den letzten" nach DOM-Reihenfolge behielt, behielt deshalb jede
 * Fehlermeldung und nahm die Erinnerung zurueck, die gerade eingetroffen war
 * (Review an #1421). Die Beobachtung des Stapels vergibt die Nummer beim
 * Einfuegen.
 */
const ARRIVAL = new WeakMap();
let arrivalCount = 0;

function noteArrivals(records) {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      const toasts = node.matches('.toast') ? [node] : [...node.querySelectorAll('.toast')];
      for (const toast of toasts) if (!ARRIVAL.has(toast)) ARRIVAL.set(toast, ++arrivalCount);
    }
  }
}

/** Der Stapel nimmt zurueckgenommene Toasts wieder auf. */
function untuck(stack) {
  for (const toast of stack.querySelectorAll('.toast--tucked')) {
    toast.classList.remove('toast--tucked');
    toast.inert = false;
  }
}

/**
 * Nimmt alle Toasts bis auf den juengsten zurueck. Sie bleiben im Dokument,
 * sind aber `inert`: ihre Knoepfe (Verwerfen, Oeffnen) waren sonst per Tab
 * erreichbar - unsichtbar, ohne Fokusring, unter einem Dialog ohne Fokusfalle
 * wie der Symbolwahl im Kalender (Review an #1421). Gibt zurueck, ob sich
 * etwas geaendert hat.
 */
function tuckAllButNewest(stack) {
  const toasts = [...stack.querySelectorAll('.toast')].filter((t) => t.getClientRects().length > 0);
  if (toasts.length < 2) return false;
  // Ohne Nummer (vor der Beobachtung eingefuegt) gilt ein Toast als aelter als
  // jeder nummerierte, und unter diesen entscheidet die DOM-Reihenfolge.
  const rank = (i) => ARRIVAL.get(toasts[i]) ?? i - toasts.length;
  let newestIndex = 0;
  for (let i = 1; i < toasts.length; i += 1) if (rank(i) > rank(newestIndex)) newestIndex = i;
  const newest = toasts[newestIndex];
  for (const toast of toasts) {
    if (toast === newest) continue;
    toast.classList.add('toast--tucked');
    toast.inert = true;
  }
  return true;
}

function undock(stack) {
  untuck(stack);
  delete stack.dataset.dock;
  stack.style.removeProperty('--toast-dock-top');
  stack.style.removeProperty('--toast-dock-center');
  stack.style.removeProperty('--toast-dock-width');
}

/**
 * Misst und setzt die Lage des Stapels einmal. Gibt die gewaehlte Lage zurueck
 * (oder null, wenn er an seinem Platz bleibt).
 * @param {HTMLElement} stack
 */
export function placeToastStack(stack) {
  undock(stack);
  const rect = stack.getBoundingClientRect();
  if (rect.height === 0) return null;

  const dialogEls = openDialogs();
  if (!dialogEls.length) return null;
  // Ausgerichtet wird am obersten MODALEN Dialog; eine Datumswahl oder ein
  // Popover in ihm bekommt keine eigene Lage, zaehlt aber als Bedienflaeche.
  const modal = dialogEls.filter((d) => d.getAttribute('aria-modal') === 'true'
    || d.classList.contains('modal-panel'));
  const candidates = modal.length ? modal : dialogEls;
  const primaryEl = candidates[candidates.length - 1];

  const dialogs = dialogEls.map((d) => d.getBoundingClientRect());
  // Ein Dialog, in dem ein anderer offen ist (die Dokumentauswahl im
  // Aufgabenformular), liegt unter ihm; seine Leisten sind dann nicht zu
  // erreichen und nehmen dem Stapel nur Platz.
  const zones = dialogEls
    .filter((d) => !dialogEls.some((other) => other !== d && d.contains(other)))
    .flatMap(dialogZones);

  const viewport = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
  const gap = pxProperty(stack, '--toast-dock-gap');
  const primary = primaryEl.getBoundingClientRect();
  const width = Math.min(rect.width, Math.max(primary.width - 2 * gap, 0)) || rect.width;
  const half = width / 2;
  const center = Math.min(
    Math.max(primary.left + primary.width / 2, gap + half),
    viewport.width - gap - half,
  );

  // In der Dialogbreite messen: ein schmalerer Stapel bricht um und wird hoeher.
  stack.style.setProperty('--toast-dock-width', `${width}px`);
  stack.style.setProperty('--toast-dock-center', `${center}px`);
  stack.dataset.dock = 'measure';

  const input = {
    viewport,
    gap,
    safeTop: pxProperty(document.documentElement, '--safe-area-inset-top'),
    safeBottom: pxProperty(document.documentElement, '--safe-area-inset-bottom'),
    stack: rect,
    dockedHeight: stack.getBoundingClientRect().height,
    dockedWidth: width,
    dockedCenter: center,
    primary,
    dialogs,
    zones,
    keepClear: uncoveredChrome(),
    focused: focusedRect(dialogEls),
  };
  let decision = chooseToastPlacement(input);
  // Kein freier Platz fuer den ganzen Stapel: nur der letzte Toast bleibt sichtbar.
  if (decision?.covers && tuckAllButNewest(stack)) {
    decision = chooseToastPlacement({ ...input, dockedHeight: stack.getBoundingClientRect().height });
  }
  if (!decision) {
    undock(stack);
    return null;
  }
  stack.style.setProperty('--toast-dock-top', `${decision.top}px`);
  stack.dataset.dock = 'placed';
  return decision;
}

/**
 * Haelt die Lage des Stapels aktuell: wenn ein Toast kommt oder geht, ein
 * Dialog auf- oder zugeht, sich seine Groesse aendert oder er fertig
 * eingefahren ist (die Einfahrt skaliert und verschiebt das Panel, gemessen
 * wird deshalb erst nach `animationend`). Einmal je Frame, und nur, solange
 * etwas im Stapel steht.
 *
 * @param {HTMLElement} stack
 * @returns {() => void} baut die Beobachter wieder ab
 */
export function watchToastPlacement(stack) {
  let frame = 0;
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const dialogMutations = new MutationObserver(() => schedule());
  let observedDialogs = [];
  const occupied = () => Boolean(stack.querySelector(':scope > :not(:empty)'));

  function observeDialogs() {
    const current = occupied() ? openDialogs() : [];
    if (current.length === observedDialogs.length && current.every((d, i) => d === observedDialogs[i])) return;
    observedDialogs = current;
    dialogMutations.disconnect();
    resize?.disconnect();
    resize?.observe(stack);
    for (const d of current) {
      // Nur Attribute: Knoten, die kommen und gehen, sieht schon der
      // Beobachter am Dokument.
      dialogMutations.observe(d.closest('.modal-overlay') ?? d, {
        subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'class'],
      });
      resize?.observe(d);
    }
  }

  function run() {
    frame = 0;
    placeToastStack(stack);
    observeDialogs();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(run);
  }

  const stackMutations = new MutationObserver((records) => {
    noteArrivals(records);
    schedule();
  });
  stackMutations.observe(stack, { childList: true, subtree: true });
  // Der ganze Baum unter `body`, nicht nur seine Kinder: Dialoge entstehen auch
  // tiefer (das Onboarding in der Shell, die Auswahlfenster in einem Formular).
  // Waehrend der Stapel leer ist, kostet ein Umbau damit nur diese eine Abfrage.
  const documentMutations = new MutationObserver(() => {
    if (occupied() || stack.dataset.dock) schedule();
  });
  documentMutations.observe(document.body, { childList: true, subtree: true });
  resize?.observe(stack);

  // Nach JEDER Einfahrt neu messen, solange etwas im Stapel steht - nicht nur,
  // wenn schon ein Dialog bekannt ist: der erste Blick faellt in dessen Einfahrt.
  const onSettled = () => { if (occupied()) schedule(); };
  window.addEventListener('resize', schedule);
  // Die Bildschirmtastatur verkleinert nur den sichtbaren Ausschnitt.
  window.visualViewport?.addEventListener('resize', onSettled);
  document.addEventListener('animationend', onSettled, true);
  document.addEventListener('transitionend', onSettled, true);
  // Der Koerper eines Dialogs scrollt, und mit ihm wandern seine Knoepfe unter
  // den Stapel (Einkauf, Artikel-Details bei 1280x700). Scroll bubbelt nicht,
  // daher in der Capture-Phase; passiv und je Frame einmal.
  // Beim Scrollen der Seite ohne Dialog gibt es nichts zu messen: ohne offenen
  // Dialog und ohne gesetzte Lage steigt der Beobachter vor jeder Messung aus.
  const onScroll = () => {
    if (!stack.dataset.dock && !observedDialogs.length) return;
    onSettled();
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // Das fokussierte Feld zaehlt als Bedienflaeche (WCAG 2.4.11): ein Tab in
  // einem Dialog misst neu. Fokus ohne offenen Dialog oder ausserhalb von ihm
  // steigt vor jeder Messung aus.
  const onFocus = (event) => {
    if (!observedDialogs.some((d) => d.contains(event.target))) return;
    schedule();
  };
  document.addEventListener('focusin', onFocus);
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    stackMutations.disconnect();
    documentMutations.disconnect();
    dialogMutations.disconnect();
    resize?.disconnect();
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', onSettled);
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('animationend', onSettled, true);
    document.removeEventListener('transitionend', onSettled, true);
    undock(stack);
  };
}
