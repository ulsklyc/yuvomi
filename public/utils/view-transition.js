/**
 * Modul: Seitenwechsel als View Transition
 * Zweck: Der Router tauscht den Seiteninhalt in EINEM Schritt, und das Bild
 *        dazwischen macht der Browser - alter Inhalt blendet in den neuen, das
 *        Chrome steht.
 *
 * WARUM (Critique 2026-09-26, P2-1): der Router ersetzte den alten Inhalt
 * sofort und startete den neuen bei `opacity: 0`. Dazwischen stand ein leerer
 * Frame (gemessen nach 38ms: Deckkraft 0,00), danach schwang der Inhalt mit der
 * Glas-Feder 2px ueber sein Ziel, und in der Kueche glitt die angetippte
 * Tab-Leiste mit, weil sie Teil der neuen Seite ist. Apple wechselt Tabs ohne
 * Slide: Navigation, Kopf und Tab-Leisten STEHEN, nur der Inhalt wechselt.
 *
 * WAS STEHT, bekommt einen `view-transition-name` und wird damit aus dem
 * Wurzelbild herausgeloest (Regeln in layout.css, Abschnitt Seiten-Uebergang):
 *   - Seitenleiste und untere Kapsel: per CSS unter `html.page-swapping`, und
 *     NUR fuer die Dauer des Wechsels. Sie zeigen dort nur ihr LEBENDES neues
 *     Bild - die Pille der Kapsel gleitet schon seit dem Tipp (updateNav in
 *     router.js), ein eingefrorenes altes Bild darueber waere ein Geisterbild.
 *     Dauerhaft darf der Name nicht stehen (Re-Critique 2026-09-28, A1 P1-1):
 *     er macht die Leiste zur Backdrop Root, und der `backdrop-filter` der
 *     Kapsel darin sah nur noch den transparenten Elternknoten - Schrift lief
 *     scharf zwischen den Tab-Labels durch. Guard: test-motion.js (8).
 *   - Die Kuechen-Leiste: per CSS (kitchen-tabs.css); sie ist sogar derselbe
 *     Knoten vorher und nachher (utils/kitchen-tabs.js), ihre Kapsel gleitet
 *     live.
 *   - Der Seitenkopf `.page-toolbar`: HIER per Inline-Stil, und nur der erste
 *     im Inhalt. Ein Name darf je Zustand nur EINMAL vorkommen, sonst verwirft
 *     der Browser die ganze Transition - und manche Seiten tragen einen
 *     zweiten Kopf (`.page-toolbar--in-group` unter der Kuechen-Leiste).
 *     Sein Inhalt blendet ueber, der Kopf selbst gleitet nicht.
 *
 * OHNE API (oder im verdeckten Tab) tauscht der Router direkt; der Rueckfall
 * ist eine reine Blende ohne Versatz (`.page-transition--in` in layout.css).
 *
 * UNTER REDUZIERTER BEWEGUNG LAEUFT DIE TRANSITION (Critique 2026-10-16, A5):
 * sie ist eine Blende, keine Bewegung - und "Bewegung faellt weg, Ueberblenden
 * bleibt" (reset.css). Bis dahin tauschte der Router dort direkt, der
 * Rueckfall war eine Animation, die reset.css auf 0s setzt, und der Wechsel
 * schnitt hart, waehrend Mehr-Blatt und Popover blendeten. Die Gruppen (Lage,
 * Groesse) stehen dort per CSS still, die Bilder blenden `--duration-sm`.
 */

const TOOLBAR_NAME = 'page-toolbar';
/** Klasse an <html>, unter der Seitenleiste und Kapsel ihren Namen tragen. */
const SWAPPING_CLASS = 'page-swapping';

/** So lange nach der Blende wartet ein abgebrochener Tipp noch auf sein `click`. */
const LOST_TAP_WINDOW_MS = 1000;

/**
 * So lange haelt ein Seitenwechsel hoechstens das alte Bild, waehrend die
 * Zielseite ihren ersten echten Inhalt zeichnet (Critique R21, D1).
 *
 * WARUM: der Browser nahm das neue Bild gleich nach dem synchronen Teil von
 * render() auf - und der zeigt das Skelett. Die Blende lief also vom alten
 * Inhalt INS SKELETT, und der echte Inhalt sprang 45-123 ms spaeter (4x CPU:
 * 139-245 ms) mitten in die laufende Blende (gemessen auf allen Hauptzielen,
 * mobil und Laptop, 0 von 6 Wechseln mit Inhalt im neuen Bild). Jetzt wartet
 * der Update-Callback auf den Render der Seite, aber nie laenger als diese
 * Frist: eine langsame Seite blendet danach wie bisher ins Skelett, statt das
 * alte Bild stehen zu lassen. 150 ms liegen unter der Schwelle, ab der ein
 * Tipp ohne Antwort als Haenger gilt - die Kapsel hat ihn da laengst quittiert.
 */
export const FIRST_RENDER_WAIT_MS = 150;

/**
 * Wartet auf `rendered`, hoechstens `ms` lang. Ein Fehler der Seite haelt den
 * Wechsel nicht an - er gehoert dem Router, der denselben Render selbst abwartet.
 * @param {unknown} rendered  was der Tausch zurueckgab (Promise oder nichts)
 * @param {number} [ms]
 * @returns {Promise<void>|null}  null, wenn es nichts abzuwarten gibt
 */
export function awaitFirstRender(rendered, ms = FIRST_RENDER_WAIT_MS) {
  if (!rendered || typeof rendered.then !== 'function') return null;
  let timer = null;
  return Promise.race([
    Promise.resolve(rendered).then(() => {}, () => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).then(() => clearTimeout(timer));
}

/**
 * WAS LAEUFT, HAELT MIT DEM BILD AN (Critique R21, D1). Solange der
 * Update-Callback auf den Render wartet, zeichnet der Browser nichts - die
 * Zeit der laufenden Animationen lief aber weiter. Die Pille der Kapsel
 * gleitet seit dem Tipp; nach der Wartezeit stand sie gemessen 74px weiter
 * (100 -> 26, ohne Frame dazwischen) und sprang. Angehalten setzt jede
 * Bewegung nach dem Warten dort fort, wo das Bild stand.
 *
 * Nur, was gerade LAEUFT: eine absichtlich pausierte Animation bleibt, wie sie
 * ist, und was waehrend des Wartens entsteht, startet ohnehin erst mit dem
 * naechsten gezeichneten Frame.
 *
 * VERSCHOBEN WIRD DER START, nicht `pause()` und nicht `currentTime` (im
 * Browser gemessen): beide rechnen mit der Zeit der Dokument-Zeitleiste, und
 * die steht waehrend des Wartens - sie rueckt nur mit gezeichneten Frames
 * vor. Ein Anhalten wurde nie wirksam, ein Zuruecksetzen setzte auf denselben
 * Start, und mit dem ersten Frame danach sprang die Zeitleiste um die ganze
 * Wartezeit. Der Start jeder laufenden Animation rueckt deshalb um die
 * gewartete Zeit nach hinten - sie setzt dort fort, wo das alte Bild stand.
 * @param {Document} [doc]
 * @param {() => number} [now]  Uhr (Tests)
 * @returns {() => void} setzt die gehaltenen Animationen an ihrer Stelle fort
 */
export function holdRunningAnimations(doc = typeof document !== 'undefined' ? document : null, now = () => performance.now()) {
  let held = [];
  let since = 0;
  try {
    held = (doc?.getAnimations?.() ?? []).filter((anim) => anim.playState === 'running');
    // Auch eine eben gestartete, deren Start noch aussteht (die Kuechen-Kapsel
    // gleitet seit dem Tipp, 10 ms vor dem Wechsel): ihr Start loeste erst
    // nach dem Warten auf, und zwar rueckwirkend auf den letzten gezeichneten
    // Frame - gemessen stand sie im ersten Frame danach 33 ms weit (16 -> 64px).
    // Ihr Start wird hier auf diesen Frame festgelegt, also auf denselben Wert,
    // und ruckt dann wie jeder andere nach.
    const frame = doc?.timeline?.currentTime;
    if (Number.isFinite(frame)) {
      for (const anim of held) {
        if (anim.startTime == null && anim.pending) anim.startTime = frame;
      }
    }
    since = now();
  } catch {
    held = [];
  }
  return () => {
    const lost = held.length ? now() - since : 0;
    for (const anim of held) {
      try {
        // Ersetzt oder abgebrochen ('idle', pausiert) bleibt, wie es ist.
        if (lost > 0 && anim.playState === 'running' && Number.isFinite(anim.startTime)) {
          anim.startTime += lost;
        }
      } catch { /* inzwischen abgebrochen */ }
    }
    held = [];
  };
}

/** Klasse an <html> fuer die Dauer eines Theme-Wechsels (kein Chrome-Name). */
const THEME_CLASS = 'theme-swapping';

/**
 * `html.page-swapping` GEHOERT ALLEN, DIE SIE GERADE BRAUCHEN (Review #2049,
 * Runde 2). Seitenwechsel (swapPage) und Regionswechsel (swapRegion in
 * utils/content-swap.js) setzen dieselbe Klasse. Ein Tipp in die Navigation
 * waehrend eines Regionswechsels bricht diesen ab und startet einen
 * Seitenwechsel - und das spaete Aufraeumen des Regionswechsels nahm dem
 * laufenden Seitenwechsel die Klasse wieder weg: Navigation, Seitenleiste und
 * FAB verloren mitten im Wechsel ihre Namen und blendeten mit der Wurzel.
 * Jetzt zaehlt jedes Dokument seine Halter, und die Klasse faellt erst mit
 * dem letzten. Beide Wechsel gehen ueber diese eine Stelle.
 */
const _swappingHolds = new WeakMap();

/**
 * Setzt `html.page-swapping` und gibt die Freigabe dieses Halters zurueck.
 * Eine zweite Freigabe desselben Halters tut nichts.
 * @param {Element|null|undefined} [html]
 * @returns {() => void}
 */
export function holdPageSwapping(html = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!html?.classList) return () => {};
  _swappingHolds.set(html, (_swappingHolds.get(html) ?? 0) + 1);
  html.classList.add(SWAPPING_CLASS);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (_swappingHolds.get(html) ?? 1) - 1;
    if (left > 0) {
      _swappingHolds.set(html, left);
      return;
    }
    _swappingHolds.delete(html);
    html.classList.remove(SWAPPING_CLASS);
  };
}

/** Pfad, von dem der laufende Seitenwechsel kommt - null beim Kaltstart. */
let _from = null;
/** Zaehlt die Wechsel; nur der juengste raeumt den Kopfnamen ab. */
let _generation = 0;

/**
 * Woher die gerade gerenderte Seite kam. Fuer Bauteile, die ueber den Wechsel
 * hinweg stehen bleiben wollen (die Kuechen-Leiste gleitet nur, wenn man aus
 * der Kueche kommt).
 * @returns {string|null}
 */
export function navigationFrom() {
  return _from;
}

/**
 * Ob der Browser den Wechsel als View Transition zeigen kann. Reduzierte
 * Bewegung ist KEIN Ausschluss: die Transition ist eine Blende (layout.css
 * haelt dort ihre Gruppen still).
 * @returns {boolean}
 */
export function canViewTransition() {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false;
  // Verdeckt ueberspringt der Browser ohnehin (InvalidStateError); die Abfrage
  // spart nur die Ausnahme.
  if (document.visibilityState === 'hidden') return false;
  return true;
}

/** Ob der Browser Typen an einer Transition kennt (`:active-view-transition-type()`). */
function supportsTransitionTypes() {
  try {
    return typeof CSS !== 'undefined' && CSS.supports('selector(:active-view-transition-type(a))');
  } catch {
    return false;
  }
}

function nameToolbar(root) {
  const toolbar = root?.querySelector?.('.page-toolbar') ?? null;
  if (toolbar) toolbar.style.viewTransitionName = TOOLBAR_NAME;
  return toolbar;
}

/**
 * Fuehrt den Inhaltstausch aus - als View Transition, wenn moeglich.
 *
 * `update` laeuft in beiden Faellen genau einmal und synchron zu Ende, bevor
 * das zurueckgegebene Promise aufloest; Fehler daraus kommen dort an.
 *
 * DAS NEUE BILD ZEIGT DEN INHALT, NICHT DAS SKELETT (Critique R21, D1). Gibt
 * `update` ein Promise zurueck (der Router: den Render der Seite), wartet die
 * Transition im Callback darauf - hoechstens FIRST_RENDER_WAIT_MS lang, so
 * lange steht das alte Bild. Der Kopf bekommt seinen Namen erst danach: eine
 * Seite, die ihn mit den Daten neu baut, haette sonst den Namen am alten
 * Knoten stehen lassen (zwei Traeger verwerfen die ganze Transition).
 *
 * @param {() => (void|Promise<unknown>)} update  tauscht den Inhalt (synchroner
 *   Teil des Renders) und gibt auf Wunsch zurueck, worauf das neue Bild wartet
 * @param {object}     opts
 * @param {Element}    opts.content  der Scrollport, dessen Inhalt getauscht wird
 * @param {string|null} opts.from    Pfad vor dem Wechsel
 * @param {boolean}    opts.animate  false beim Kaltstart
 * @param {() => Promise<void>} [opts.whenSettled] wann die App einen nachgereichten
 *   Tipp annimmt (der Router: wenn seine Navigation durch ist - vorher verwirft
 *   er jede weitere)
 * @param {() => void} [opts.settle] bringt, was gerade AUSFAEHRT, an sein Ende,
 *   bevor der Browser das alte Bild aufnimmt (siehe unten)
 * @param {string[]} [opts.types] Typen der Transition (`:active-view-transition-type()`
 *   in layout.css); ohne Unterstuetzung laeuft der Wechsel ohne sie
 * @returns {Promise<{ transition: boolean, finished: Promise<void> }>}
 */
export async function swapPage(update, { content, from = null, animate = true, whenSettled = null, settle = null, types = [] } = {}) {
  _from = from;

  if (!animate || !canViewTransition()) {
    update();
    return { transition: false, finished: Promise.resolve() };
  }

  // KEIN HALB AUSGEFAHRENES BLATT IM ALTEN BILD (Re-Critique 2026-10-17, P1).
  // Der Tipp auf ein Ziel im Mehr-Blatt schliesst es, und es faehrt
  // `--sheet-out` lang aus - der Seitenwechsel startet mitten darin. Das alte
  // Bild ist ein Standbild: das Blatt stand darin mit der Deckkraft des
  // Augenblicks (gemessen 0,31-0,60) eingefroren ueber der neuen Seite und
  // blendete erst mit der Wurzel aus, 100 ms bei 1x, 400 ms bei 4x CPU. Was
  // bis hierher ausgefahren ist, hat seine Bewegung gehabt; der Rest faellt in
  // diesen Frame, und das alte Bild zeigt nur noch die Seite.
  settle?.();

  const generation = ++_generation;
  // VOR startViewTransition: der Browser nimmt das alte Bild gleich danach auf,
  // und ohne Namen blendete die Leiste dort mit der Wurzel.
  const releaseSwapping = holdPageSwapping();
  let oldToolbar = nameToolbar(content);
  let newToolbar = null;
  const callback = async () => {
    // Der alte Kopf faellt mit dem Tausch ohnehin aus dem Dokument; der Name
    // geht trotzdem vorher weg, falls eine Seite ihren Kopf wiederverwendet.
    // Danach laesst ihn dieser Rueckruf los: haelt etwas den Rueckruf (der
    // Stapel einer Ausnahme, R20), hielte er sonst den ganzen alten Baum.
    if (oldToolbar) oldToolbar.style.viewTransitionName = '';
    oldToolbar = null;
    // Das alte Bild ist aufgenommen; ab hier zeichnet der Browser bis zum Ende
    // dieses Rueckrufs nichts. Was laeuft (die Pille seit dem Tipp), haelt an.
    const resume = holdRunningAnimations(document);
    try {
      const rendered = update();
      // D1: das alte Bild steht, bis die Seite gezeichnet hat - hoechstens
      // FIRST_RENDER_WAIT_MS. Erst danach traegt der Kopf seinen Namen.
      await awaitFirstRender(rendered);
      newToolbar = nameToolbar(content);
    } finally {
      resume();
    }
  };
  const transition = document.startViewTransition(types.length && supportsTransitionTypes()
    ? { update: callback, types }
    : callback);
  // `ready` lehnt ab, wenn der Browser die Transition verwirft (doppelter
  // Name, verdeckter Tab) - das ist kein Fehler des Wechsels, der Tausch
  // selbst laeuft trotzdem.
  transition.ready.catch(() => {});
  // Ein Tipp beendet die Blende. Solange eine Wurzel-Transition laeuft, trifft
  // Chromium jeden Zeiger nur auf <html> - `::view-transition { pointer-events:
  // none }` aendert daran nichts (gemessen 2026-09-27: Seitenleisten-Tipps 30
  // und 110ms nach dem Wechsel verpufften alle). Jeder weitere Tipp erreicht
  // danach die neue Seite, statt bis zum Ende der Blende ins Leere zu gehen.
  //
  // DER TIPP, DER ABBRICHT, WIRD NACHGEREICHT (Critique R19). Er hatte sein
  // Ziel schon als <html> getroffen; sein `click` landet deshalb ebenfalls auf
  // <html> (gemeinsamer Vorfahr von Druck und Loslassen) und ging verloren -
  // gemessen etwa jeder achte Tipp in schneller Folge, fast immer einer in die
  // Navigation, die ueber dem Wechsel steht. Gemerkt wird die Stelle des
  // Drucks; kommt sein `click` auf <html> an, wird er dort angehalten und nach
  // dem Ende der Blende an das Element gereicht, das an dieser Stelle steht.
  // Fand der `click` sein Ziel selbst, passiert nichts; ein Wischen erzeugt
  // keinen `click` und damit auch nichts Nachgereichtes.
  // Das Dokument dieses Wechsels: die Zuhoerer leben laenger als der Aufruf.
  const doc = document;
  const html = doc.documentElement;
  let lostTap = null;
  const skipOnTap = (event) => {
    transition.skipTransition();
    if (event && html && event.target === html && (event.button ?? 0) === 0 && event.isPrimary !== false) {
      lostTap = { x: event.clientX, y: event.clientY };
    }
  };
  const replayLostTap = (event) => {
    const tap = lostTap;
    lostTap = null;
    doc.removeEventListener?.('click', replayLostTap, { capture: true });
    if (!tap || event?.target !== html) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    finished.then(() => whenSettled?.()).then(() => {
      const target = doc.elementFromPoint?.(tap.x, tap.y);
      if (target && target !== html && target !== doc.body) target.click?.();
    });
  };
  doc.addEventListener?.('pointerdown', skipOnTap, { capture: true, once: true });
  doc.addEventListener?.('click', replayLostTap, { capture: true });
  const finished = transition.finished
    .catch(() => {})
    .finally(() => {
      doc.removeEventListener?.('pointerdown', skipOnTap, { capture: true });
      // Ein Tipp ohne `click` (gewischt, lange gehalten) laesst nichts haengen:
      // der Zuhoerer wartet noch einen Augenblick auf das Loslassen, dann geht er.
      setTimeout(() => {
        lostTap = null;
        doc.removeEventListener?.('click', replayLostTap, { capture: true });
      }, LOST_TAP_WINDOW_MS);
      // Erst jetzt ist die Leiste keine Backdrop Root mehr - das Glas blurrt.
      // Die Klasse faellt aber erst mit ihrem letzten Halter: ein juengerer
      // Seiten- oder Regionswechsel haelt sie weiter (holdPageSwapping).
      releaseSwapping();
      // Temporaer: ein stehengebliebener Name kollidierte beim naechsten
      // Wechsel mit einem zweiten Kopf derselben Seite. Nur der juengste
      // Wechsel raeumt auf: verwirft ein zweiter Tipp diese Transition, loest
      // `finished` auf, bevor der zweite sein altes Bild aufnimmt - und derselbe
      // Kopf-Knoten traegt dann schon dessen Namen.
      if (generation !== _generation) return;
      if (newToolbar) newToolbar.style.viewTransitionName = '';
    });
  // Wirft, wenn `update` wirft - der Router faengt es in seinem catch.
  await transition.updateCallbackDone;
  return { transition: true, finished };
}


/**
 * Fuehrt einen GEWAEHLTEN Theme-Wechsel aus - als Blende ueber die Wurzel, wo
 * der Browser sie kann (Critique R18: hell <-> dunkel schlug in einem Frame um,
 * jede Flaeche einzeln).
 *
 * Kein Name, kein Chrome, das steht: das ganze Dokument blendet vom alten ins
 * neue Bild, in der Dauer der Seitenblende (`::view-transition-*(root)` in
 * layout.css). `page-swapping` bleibt aus - die Leisten wechseln ihre Farbe
 * mit und duerfen nicht als lebendes Bild ueber einem alten Grund stehen.
 *
 * NUR FUER DIE WAHL IN DEN EINSTELLUNGEN. Der Nachtwechsel des Wandmodus
 * (utils/wall-mode.js) schaltet ohne Blende: dort schaut niemand hin, und eine
 * Blende an einem Wandtablett ist eine Bewegung ohne Anlass.
 *
 * `update` laeuft genau einmal. Ohne API und im verdeckten Tab synchron (ein
 * Fehler daraus kommt beim Aufrufer an), sonst im Callback der Transition -
 * auch unter reduzierter Bewegung: ein Farbwechsel als Blende ist dort die
 * gewollte Alternative zum harten Umschlag, nicht eine Bewegung.
 *
 * @param {() => void} update  setzt das Theme
 * @returns {Promise<void>} aufgeloest, wenn die Blende durch ist
 */
export function swapTheme(update) {
  if (!canViewTransition()) {
    update();
    return Promise.resolve();
  }
  const root = document.documentElement;
  root?.classList.add(THEME_CLASS);
  const transition = document.startViewTransition(update);
  transition.ready?.catch?.(() => {});
  return Promise.resolve(transition.finished)
    .catch(() => {})
    .finally(() => root?.classList.remove(THEME_CLASS));
}
