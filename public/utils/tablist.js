import { wireScrollFade } from '/utils/ux.js';

/**
 * Modul: Tablist-Verhalten — geteilte WAI-ARIA-Tab-Navigation
 *
 * EINE Verhaltens-Quelle (Klick + Pfeiltasten/Home/End + Roving-Tabindex + ARIA)
 * für Tab-Leisten, deren Buttons bereits im Markup stehen (rewards,
 * housekeeping, budget, calendar). `renderSubTabs` ist die Variante, die die
 * Leiste selbst baut und dabei Deep-Link-Routen, Zustandszahlen und
 * Panel-Synchronisierung mitbringt (health, kitchen). So teilen beide dieselbe
 * Interaktions-Grammatik, ohne dass ein Modul die Tastatur-Navigation erneut
 * von Hand nachbaut.
 *
 * WO DIE LEISTE STEHT, ENTSCHEIDET NICHT DIESE WAHL. Hier stand bis Runde 6
 * „aus Layout-Gründen" - das war eine Beobachtung, kein Kriterium, und weil
 * keines dastand, entschied jedes Modul neu. Das Kriterium ist der
 * `module:`-Wert der Zielroute (ROUTES in router.js):
 *
 *   Wechselt die Leiste ihn, ist SIE die Kopf-Navigation und trägt keinen Titel
 *   über sich - der Tab-Name IST der Modulname (Küche: vier eigenständige
 *   Module unter einer Leiste).
 *   Wechselt sie ihn nicht, oder wechselt sie gar keine Route, gehört sie unter
 *   den Large Title in den kanonischen `page-toolbar`-Kopf (Gesundheit, Budget,
 *   Belohnungen, Haushaltshilfe).
 *   Sektionen mit eigener Shell (Einstellungen) führen ihren Titel in ihrem
 *   eigenen Kopf. Das ist der dritte Fall der Regel, keine Ausnahme von ihr.
 *
 * Warum die Route und nicht der Helfername: Gesundheits Tabs SIND echte Routen
 * (HEALTH_ROUTES), tragen aber alle `module: 'health'`. Ein Guard auf
 * „renderSubTabs gegen wireTablist" wäre damit entweder verletzt oder falsch.
 * Geprüft wird die Regel auf Ebene 2 (Struktur, aus ROUTES abgeleitet) in
 * test-frontend-audit.js.
 *
 * Erwartetes Markup:
 *   - Container: role="tablist"    (mode 'tabs')  bzw. role="radiogroup" ('select')
 *   - Buttons:   role="tab"/"radio", data-tab-id="<id>"
 * Der Helper setzt den Auswahlzustand, tabindex und die aktive Klasse und ruft
 * onChange(id) beim Wechsel.
 *
 * `mode` trennt die beiden Fragen, die eine Leiste stellen kann, ohne die
 * Verhaltensschicht zu spalten: 'tabs' wechselt eine SICHT (aria-selected +
 * aria-current), 'select' wählt EINEN WERT aus einer Filterleiste (aria-checked).
 * Vorher trugen die Wert-Leisten des Budgets role="group" mit aria-pressed und
 * standen damit ohne Pfeiltasten-Navigation da, während die Sicht-Leisten daneben
 * welche hatten (Critique 2026-07-30, P1). Pfeiltasten + Roving-Tabindex sind für
 * radiogroup ohnehin das vorgeschriebene Muster.
 *
 * @param {HTMLElement} container            - die Leiste (role="tablist"|"radiogroup")
 * @param {object}      opts
 * @param {string}      opts.activeId         - initial aktive Tab-id
 * @param {Function}    opts.onChange         - onChange(id) beim Wechsel
 * @param {string}      [opts.activeClass='sub-tab--active']
 * @param {'tabs'|'select'} [opts.mode='tabs']
 * @param {boolean}     [opts.manualActivation=false] - Review zu #1099: OPT-IN,
 *        Vorgabe bleibt automatische Aktivierung (Pfeiltasten wechseln SOFORT
 *        die Sicht, wie bisher, fuer jeden bestehenden Aufrufer unveraendert).
 *        Mit `true` bewegen Pfeiltasten/Home/End nur den Tastatur-Fokus
 *        (rovierendes tabindex, sichtbarer :focus-visible-Ring) OHNE
 *        onChange() aufzurufen oder die aktive Sicht zu wechseln - erst
 *        Enter/Leertaste (oder ein Klick) aktiviert den fokussierten Tab.
 *        Fuer eine Leiste, deren onChange() einen Tab-Wechsel navigiert/neu
 *        laedt (z.B. Schedule: Statistik-Fetch, S-03-Nachfrage bei
 *        ungespeicherten Aenderungen), waere sonst JEDER Pfeiltastendruck beim
 *        blossen Durchblaettern ein echter Wechsel.
 * @returns {{ setActive: (id: string, opts?: { focus?: boolean }) => void }}
 */
/**
 * Holt einen Tab in den sichtbaren Bereich SEINER Leiste, indem nur deren
 * scrollLeft angepasst wird - anders als Element.scrollIntoView werden
 * scrollbare Vorfahren (inkl. overflow:hidden-Container) NICHT mitgescrollt.
 * Auf nicht-ueberlaufenden Leisten (Desktop) ist es ein No-op, ein schon ganz
 * sichtbarer Tab bewegt die Leiste nicht.
 *
 * DAS ZIEL IST EIN RASTPUNKT, NICHT DER KLEINSTE VERSATZ (#1504). Die Bar-Leisten
 * rasten ein (`scroll-snap-type: x proximity`, Reiter `snap-align: start`,
 * layout.css) und tragen ein Scroll-Polster (`.u-scroll-fade`, filter-chip.css).
 * Die Vorfassung schob genau um die fehlenden Pixel - und der Browser zog die
 * Leiste danach auf den naechsten Rastpunkt, der auch HINTER ihr liegen kann:
 * Budget "Kredite" bei 390px stand bei 327-404, die Leiste endet bei 374,
 * scrollLeft blieb 0. Ob es traf, hing an Breite und Sprache (375 zufaellig
 * ja; 320, 360, 390, 414 nein).
 *
 * Deshalb wird die Lage selbst gewaehlt: der erste Rastpunkt, an dem der Tab
 * samt Polster in die Leiste passt. Ein Rastpunkt ist die Lage, an der ein
 * Reiter mit seinem Anfang am Polster steht - dort hat das Einrasten nichts
 * mehr zu verschieben. Gerechnet wird in der Leserichtung (Abstand vom Anfang
 * der Leiste), damit RTL denselben Weg nimmt: dort laeuft scrollLeft ins
 * Negative.
 */
function scrollTabIntoView(container, btn) {
  const c = container.getBoundingClientRect();
  const size = c.right - c.left;
  if (!(size > 0)) return;
  const style = globalThis.getComputedStyle?.(container);
  const rtl = style?.direction === 'rtl';
  const sign = rtl ? -1 : 1;
  const pos = sign * container.scrollLeft;
  const padStart = parseFloat(style?.scrollPaddingInlineStart) || 0;
  const padEnd = parseFloat(style?.scrollPaddingInlineEnd) || 0;
  // Anfang und Ende eines Reiters als Abstand vom Anfang des Leisteninhalts.
  const span = (el) => {
    const r = el.getBoundingClientRect();
    const start = (rtl ? c.right - r.right : r.left - c.left) + pos;
    return { start, end: start + (r.right - r.left) };
  };
  const tab = span(btn);
  const TOLERANCE = 0.5; // Sub-Pixel: ein buendiger Reiter gilt als sichtbar
  if (tab.start >= pos - TOLERANCE && tab.end <= pos + size + TOLERANCE) return;

  // Die Lage, an der der Tab selbst am Polster steht - weiter darf die Leiste
  // nie laufen, sonst verschwaende sein Anfang.
  const own = tab.start - padStart;
  let target = own;
  if (tab.start >= pos) {
    // Der Tab liegt hinter dem sichtbaren Bereich: so wenig wie moeglich
    // schieben, aber bis zu einer Lage, die stehen bleibt.
    const need = tab.end - size + padEnd;
    const snaps = style?.scrollSnapType && style.scrollSnapType !== 'none'
      && String(globalThis.getComputedStyle?.(btn)?.scrollSnapAlign ?? '').includes('start');
    if (snaps) {
      const points = [...container.querySelectorAll('[data-tab-id]')]
        .map((b) => span(b).start - padStart)
        .filter((p) => p >= need && p <= own);
      if (points.length) target = Math.min(...points);
    } else {
      target = Math.min(need, own);
    }
  }
  const max = container.scrollWidth - container.clientWidth;
  if (Number.isFinite(max)) target = Math.min(target, Math.max(0, max));
  container.scrollLeft = sign * Math.max(0, target);
}

export function wireTablist(container, { activeId, onChange, activeClass = 'sub-tab--active', mode = 'tabs', manualActivation = false } = {}) {
  if (!container) return { setActive() {} };
  let current = activeId;

  const buttons = () => [...container.querySelectorAll('[data-tab-id]')];

  const paint = () => {
    let activeBtn = null;
    buttons().forEach((b) => {
      const on = b.dataset.tabId === current;
      b.classList.toggle(activeClass, on);
      // Sicht vs. Wert: aria-current="page" gehört zur Navigation und wäre auf
      // einem Filterwert eine Falschaussage („Sie sind hier").
      if (mode === 'select') {
        b.setAttribute('aria-checked', String(on));
      } else {
        b.setAttribute('aria-selected', String(on));
        if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      }
      b.tabIndex = on ? 0 : -1;
      if (on) activeBtn = b;
    });
    // Überlaufende Leisten (Mobil): den aktiven Tab in den sichtbaren
    // Scroll-Bereich holen (Audit A2-18) — aber NUR die Leiste selbst scrollen.
    // Element.scrollIntoView scrollt jeden scrollbaren Vorfahren mit, auch
    // overflow:hidden-Container wie .calendar-page (die per JS scrollbar bleiben,
    // aber weder Scrollbar noch Touch zum Zurückscrollen bieten). Auf schmalen
    // Viewports kippte das die ganze Seite horizontal weg und ließ sich nur per
    // Neu-Render zurückholen (#565).
    if (activeBtn) scrollTabIntoView(container, activeBtn);
  };

  const setActive = (id, { focus = false } = {}) => {
    if (!id || id === current) return;
    // Richtung des Wechsels in der Reihenfolge der Leiste: > 0 heisst "zu einem
    // spaeteren Reiter". Der Aufrufer reicht sie an swapContent() weiter
    // (utils/content-swap.js), damit der neue Inhalt von der Seite kommt, zu
    // der man gewechselt hat. 0, wenn einer der beiden nicht in der Leiste steht.
    const order = buttons().map((b) => b.dataset.tabId);
    const from = order.indexOf(current);
    const to = order.indexOf(id);
    const direction = from < 0 || to < 0 ? 0 : Math.sign(to - from);
    current = id;
    paint();
    if (focus) buttons().find((b) => b.dataset.tabId === id)?.focus();
    onChange?.(id, { direction });
  };

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab-id]');
    if (btn) setActive(btn.dataset.tabId);
  });

  // Nur bei manualActivation gebraucht: bewegt das rovierende tabindex/den
  // Fokus auf einen Tab, OHNE current/paint()/onChange anzufassen - die
  // Sicht wechselt erst, wenn commitFocusedTab() (Enter/Leertaste) das
  // ausdruecklich tut.
  const focusTab = (btn) => {
    buttons().forEach((b) => { b.tabIndex = b === btn ? 0 : -1; });
    btn.focus();
    scrollTabIntoView(container, btn);
  };

  container.addEventListener('keydown', (e) => {
    const moveKeys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (manualActivation && (e.key === 'Enter' || e.key === ' ')) {
      const btn = e.target.closest('[data-tab-id]');
      if (!btn) return;
      e.preventDefault();
      setActive(btn.dataset.tabId, { focus: true });
      return;
    }
    if (!moveKeys.includes(e.key)) return;
    const b = buttons();
    if (!b.length) return;
    const focusedIndex = b.indexOf(document.activeElement);
    const currentIndex = Math.max(0, b.findIndex((x) => x.dataset.tabId === current));
    const index = focusedIndex >= 0 ? focusedIndex : currentIndex;
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % b.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + b.length) % b.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = b.length - 1;
    e.preventDefault();
    if (manualActivation) focusTab(b[next]);
    else setActive(b[next]?.dataset.tabId, { focus: true });
  });

  // Aktiven Tab extern synchronisieren (ohne onChange) — für Zustandswechsel,
  // die NICHT über die Leiste ausgelöst werden (z. B. Kalender: Klick auf einen
  // Tag wechselt in die Tagesansicht).
  const sync = (id) => { current = id; paint(); };

  // Scroll-Affordanz für überlaufende Leisten: geteilte has-fade-Masken
  // (filter-chip.css) auf jeder wireTablist-Leiste, nicht nur im Budget.
  wireScrollFade(container);

  paint(); // initiale Roving-Tabindex/ARIA-Zustände setzen
  return { setActive, sync };
}
