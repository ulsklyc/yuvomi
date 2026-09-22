/**
 * Modul: Toast-Lage ueber offenen Dialogen (#1160)
 * Zweck: Der untere Shell-Stapel (Toasts, Sammelpille) weicht den Bedienknoepfen
 *        eines offenen Dialogs aus. Er bleibt sichtbar, aber er liegt nie ueber
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
 * DIE REIHENFOLGE DER LAGEN, jeweils die erste, die passt:
 *   1. Wo er steht, wenn er keinen Dialog beruehrt - eine Meldung springt nicht
 *      ohne Grund.
 *   2. Ueber dem Dialog, wenn dort Platz ist (Telefon: der Streifen ueber dem
 *      Sheet; Desktop: ueber einem kurzen Dialog). Er verdeckt dann nichts.
 *   3. Unter dem Dialog, aus demselben Grund.
 *   4. Wo er steht, wenn er dort nur Inhalt verdeckt, keine Bedienleiste.
 *   5. Im Dialog, direkt ueber seiner unteren Aktionsleiste. Er verdeckt dann
 *      das untere Ende des scrollbaren Inhalts, der sich unter ihm hervorholen
 *      laesst, aber keinen Knopf in Kopf oder Fuss.
 * Nur wenn nichts davon passt (ein Dialog, der die ganze Hoehe fuellt und
 * keinen Inhalt zwischen Kopf und Fuss laesst), bleibt Lage 5 ohne Pruefung
 * des Kopfes - ein verdeckter Kopf ist dann das kleinere Uebel als ein
 * verdecktes "Speichern".
 *
 * Die Abstaende kommen aus tokens.css (`--toast-dock-gap` in layout.css), die
 * Lage schreibt dieses Modul als drei Variablen an den Stapel; die Regel, die
 * sie liest, steht bei `.shell-bottom-stack[data-dock]` in layout.css.
 */

/** Was als offener Dialog zaehlt: jede Dialogrolle, sichtbar und nicht inert. */
export const DIALOG_SELECTOR = '[role="dialog"]';

/**
 * Die Bedienleisten eines Dialogs. Liegt keine davon im Dialog (Datumswahl,
 * kleine Auswahlfenster), gilt der ganze Dialog als Bedienflaeche.
 */
export const ACTION_ZONE_SELECTOR = '.modal-panel__header, .modal-panel__footer, .modal-actions';

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function box(top, bottom, left, right) {
  return { top, bottom, left, right, width: right - left, height: bottom - top };
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
 * @returns {null | {edge: 'top'|'bottom', offset: number, mode: string}}
 *          null = der Stapel bleibt, wo er steht
 */
export function chooseToastPlacement({
  viewport, gap, safeTop = 0, safeBottom = 0,
  stack, dockedHeight, dockedWidth, dockedCenter,
  primary, dialogs, zones,
}) {
  if (!dialogs.some((d) => intersects(stack, d))) return null;

  const left = dockedCenter - dockedWidth / 2;
  const right = dockedCenter + dockedWidth / 2;
  const h = dockedHeight;
  const clearOf = (rect, list) => !list.some((r) => intersects(rect, r));

  // 2. Ueber dem Dialog.
  const aboveBottom = primary.top - gap;
  const above = box(aboveBottom - h, aboveBottom, left, right);
  if (above.top >= safeTop + gap && clearOf(above, dialogs)) {
    return { mode: 'above-dialog', edge: 'bottom', offset: viewport.height - aboveBottom };
  }

  // 3. Unter dem Dialog.
  const belowTop = primary.bottom + gap;
  const below = box(belowTop, belowTop + h, left, right);
  if (below.bottom <= viewport.height - safeBottom - gap && clearOf(below, dialogs)) {
    return { mode: 'below-dialog', edge: 'top', offset: belowTop };
  }

  // 4. Am eigenen Platz, solange dort keine Bedienleiste liegt.
  if (clearOf(stack, zones)) return null;

  // 5. Ueber der unteren Aktionsleiste des Dialogs.
  const middle = primary.top + primary.height / 2;
  const lower = zones.filter((z) => z.top + z.height / 2 >= middle
    && z.left < primary.right && z.right > primary.left);
  const floor = lower.length ? Math.min(...lower.map((z) => z.top)) : primary.bottom;
  const dockBottom = floor - gap;
  const docked = box(dockBottom - h, dockBottom, left, right);
  if (docked.top >= safeTop && clearOf(docked, zones)) {
    return { mode: 'above-actions', edge: 'bottom', offset: viewport.height - dockBottom };
  }
  return { mode: 'above-actions-forced', edge: 'bottom', offset: viewport.height - dockBottom };
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

function openDialogs(root = document) {
  return [...root.querySelectorAll(DIALOG_SELECTOR)].filter(isOpen);
}

function pxProperty(el, name) {
  const value = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function undock(stack) {
  delete stack.dataset.dock;
  stack.style.removeProperty('--toast-dock-offset');
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
  const zones = dialogEls.flatMap((d) => {
    const own = [...d.querySelectorAll(ACTION_ZONE_SELECTOR)]
      .filter((z) => z.closest(DIALOG_SELECTOR) === d && z.getClientRects().length > 0)
      .map((z) => z.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return own.length ? own : [d.getBoundingClientRect()];
  });

  const viewport = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
  const gap = pxProperty(stack, '--toast-dock-gap');
  const primary = primaryEl.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.width, primary.width - 2 * gap));
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
  stack.style.setProperty('--toast-dock-offset', `${decision.offset}px`);
  stack.dataset.dock = decision.edge;
  return decision;
}

/**
 * Haelt die Lage des Stapels aktuell: wenn ein Toast kommt oder geht, ein
 * Dialog auf- oder zugeht, sich seine Groesse aendert oder er fertig
 * eingefahren ist (die Einfahrt skaliert und verschiebt das Panel, gemessen
 * wird deshalb erst nach `animationend`). Einmal je Frame.
 *
 * @param {HTMLElement} stack
 * @returns {() => void} baut die Beobachter wieder ab
 */
export function watchToastPlacement(stack) {
  let frame = 0;
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const dialogMutations = new MutationObserver(() => schedule());
  let observedDialogs = [];

  function observeDialogs() {
    const current = stack.getBoundingClientRect().height > 0 ? openDialogs() : [];
    if (current.length === observedDialogs.length && current.every((d, i) => d === observedDialogs[i])) return;
    observedDialogs = current;
    dialogMutations.disconnect();
    resize?.disconnect();
    resize?.observe(stack);
    for (const d of current) {
      dialogMutations.observe(d.closest('.modal-overlay') ?? d, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'class'],
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
  const bodyMutations = new MutationObserver(schedule);
  bodyMutations.observe(document.body, { childList: true });
  resize?.observe(stack);

  // Nach JEDER Einfahrt neu messen, solange etwas im Stapel steht - nicht nur,
  // wenn schon ein Dialog bekannt ist: der erste Blick faellt in dessen Einfahrt.
  const onSettled = () => { if (stack.querySelector(':scope > :not(:empty)')) schedule(); };
  window.addEventListener('resize', schedule);
  document.addEventListener('animationend', onSettled, true);
  document.addEventListener('transitionend', onSettled, true);
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    stackMutations.disconnect();
    bodyMutations.disconnect();
    dialogMutations.disconnect();
    resize?.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('animationend', onSettled, true);
    document.removeEventListener('transitionend', onSettled, true);
    undock(stack);
  };
}
