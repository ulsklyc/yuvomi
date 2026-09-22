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
 * Dialoge mit eigenen Kopf- und Fusszeilen. Traegt ein Dialog keins von beiden,
 * gelten seine Bedienelemente selbst als Leisten - nie mehr der ganze Dialog:
 * damit fiel Lage 5 auf die schon verworfene Lage 2 zurueck. Welcher Dialog
 * welchen Weg nimmt, haelt das Register in test/test-toast-placement.js fest.
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

/** Rueckfall ohne Auszeichnung: die Bedienelemente selbst. */
const CONTROL_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

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
 * @returns {null | {top: number}} null = der Stapel bleibt, wo er steht
 */
export function chooseToastPlacement({
  viewport, gap, safeTop = 0, safeBottom = 0,
  stack, dockedHeight, dockedWidth, dockedCenter,
  primary, dialogs, zones,
}) {
  if (!dialogs.some((d) => intersects(stack, d))) return null;

  const h = dockedHeight;
  const left = dockedCenter - dockedWidth / 2;
  const right = dockedCenter + dockedWidth / 2;
  const minTop = safeTop + gap;
  const maxTop = viewport.height - safeBottom - gap - h;
  const at = (top) => ({ top, bottom: top + h, left, right, width: dockedWidth, height: h });
  const inView = (top) => top >= minTop && top <= maxTop;
  const clear = (top, list) => !list.some((r) => intersects(at(top), r));

  // 2. und 3.: neben dem Dialog, ohne ihn zu beruehren.
  for (const top of [primary.top - gap - h, primary.bottom + gap]) {
    if (inView(top) && clear(top, dialogs)) return { top };
  }

  // 4. Am eigenen Platz, solange dort keine Bedienleiste liegt.
  if (!zones.some((z) => intersects(stack, z))) return null;

  // 5. Ueber der unteren Bedienleiste des Dialogs.
  const middle = primary.top + primary.height / 2;
  const lower = zones.filter((z) => z.top >= middle && z.left < primary.right && z.right > primary.left);
  if (lower.length) {
    const top = Math.min(...lower.map((z) => z.top)) - gap - h;
    if (inView(top) && clear(top, zones)) return { top };
  }

  // 6. Die naechste freie Lage an einer Kante - erst mit Abstand zur Leiste,
  // dann auf Stoss, wenn die Luecke fuer den Abstand zu schmal ist.
  const edgesAt = (margin) => [minTop, maxTop, ...zones.flatMap((z) => [z.top - margin - h, z.bottom + margin])];
  const candidates = [...edgesAt(gap), ...edgesAt(0)].filter(inView);
  const nearest = (list) => list
    .filter((top) => clear(top, zones))
    .sort((a, b) => Math.abs(a - stack.top) - Math.abs(b - stack.top))[0];
  const free = nearest(edgesAt(gap).filter(inView)) ?? nearest(edgesAt(0).filter(inView));
  if (free !== undefined) return { top: free };

  // 7. Nichts ist frei: die kleinste verdeckte Flaeche, und immer im Bild.
  if (maxTop < minTop) return { top: minTop };
  let best = minTop;
  let bestArea = Infinity;
  for (const top of candidates.length ? candidates : [minTop]) {
    const area = zones.reduce((sum, z) => sum + overlapArea(at(top), z), 0);
    if (area < bestArea) {
      best = top;
      bestArea = area;
    }
  }
  return { top: best };
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

function visibleRects(elements) {
  return elements
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
}

/**
 * Die Bedienleisten eines Dialogs: die ausgezeichneten, sonst seine
 * Bedienelemente, und nur wenn er keine hat, er selbst.
 */
function dialogZones(dialog) {
  const own = (selector) => [...dialog.querySelectorAll(selector)]
    .filter((el) => el.closest(DIALOG_SELECTOR) === dialog);
  const marked = visibleRects(own(ACTION_ZONE_SELECTOR));
  if (marked.length) return marked;
  const controls = visibleRects(own(CONTROL_SELECTOR));
  return controls.length ? controls : [dialog.getBoundingClientRect()];
}

function pxProperty(el, name) {
  const value = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function undock(stack) {
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
  const dockedHeight = stack.getBoundingClientRect().height;

  const decision = chooseToastPlacement({
    viewport,
    gap,
    safeTop: pxProperty(document.documentElement, '--safe-area-inset-top'),
    safeBottom: pxProperty(document.documentElement, '--safe-area-inset-bottom'),
    stack: rect,
    dockedHeight,
    dockedWidth: width,
    dockedCenter: center,
    primary,
    dialogs,
    zones,
  });
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

  const stackMutations = new MutationObserver(schedule);
  stackMutations.observe(stack, { childList: true, subtree: true });
  // Das GANZE Dokument, nicht nur `body`: Dialoge entstehen auch tiefer (das
  // Onboarding in der Shell, die Auswahlfenster in einem Formular). Waehrend der
  // Stapel leer ist, kostet ein Umbau damit nur diese eine Abfrage.
  const documentMutations = new MutationObserver(() => {
    if (occupied() || stack.dataset.dock) schedule();
  });
  documentMutations.observe(document.body, { childList: true, subtree: true });
  resize?.observe(stack);

  // Nach JEDER Einfahrt neu messen, solange etwas im Stapel steht - nicht nur,
  // wenn schon ein Dialog bekannt ist: der erste Blick faellt in dessen Einfahrt.
  const onSettled = () => { if (occupied()) schedule(); };
  window.addEventListener('resize', schedule);
  document.addEventListener('animationend', onSettled, true);
  document.addEventListener('transitionend', onSettled, true);
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    stackMutations.disconnect();
    documentMutations.disconnect();
    dialogMutations.disconnect();
    resize?.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('animationend', onSettled, true);
    document.removeEventListener('transitionend', onSettled, true);
    undock(stack);
  };
}
