/**
 * Modul: UX Utilities
 * Zweck: Wiederverwendbare Animationshelfer (Stagger, Vibration)
 * Abhängigkeiten: keine
 */

/**
 * Gestaffeltes Einblenden einer NodeList oder eines Arrays von Elementen.
 * Maximal MAX_STAGGER Elemente werden verzögert, der Rest sofort eingeblendet.
 *
 * @param {NodeList|Element[]} elements
 * @param {Object} [opts]
 * @param {number} [opts.delay=30]     - ms zwischen jedem Element
 * @param {number} [opts.duration=180] - ms pro Element
 * @param {number} [opts.max=5]        - Maximale Anzahl gestaffelter Elemente
 */
export function stagger(elements, { delay = 30, duration = 180, max = 5 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els = Array.from(elements);
  els.forEach((el, i) => {
    const itemDelay = i < max ? i * delay : max * delay;
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease`;
    setTimeout(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, itemDelay);
  });
}

/**
 * Vibrationsmuster abspielen, wenn die API verfügbar ist und
 * keine reduzierte Bewegung gewünscht wird.
 *
 * @param {number|number[]} pattern - ms oder [an, aus, an, ...]-Array
 */
export function vibrate(pattern) {
  if (!navigator.vibrate) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  navigator.vibrate(pattern);
}

/**
 * Führt eine DELETE-Aktion aus und zeigt einen Undo-Toast.
 *
 * @param {Object} opts
 * @param {() => Promise<void>} opts.onDelete      - Async-Funktion die DELETE ausführt
 * @param {() => Promise<void>} [opts.onUndo]      - Async-Funktion die die Aktion rückgängig macht
 * @param {string} opts.toastMessage               - Text für den Toast
 * @param {'success'|'danger'} [opts.toastType]    - Toast-Typ, default 'success'
 */
export async function deleteWithUndo({ onDelete, onUndo, toastMessage, toastType = 'success' }) {
  await onDelete();
  if (window.yuvomi?.showToast) {
    window.yuvomi.showToast(
      toastMessage,
      toastType,
      onUndo ? 4000 : 2000,
      onUndo ?? null,
    );
  }
}

/**
 * Scroll-Affordanz für überlaufende Leisten und Listen (Audit F-01/F-06):
 * setzt `has-fade-start`/`has-fade-end` auf dem Element, solange in der
 * jeweiligen Richtung verborgener Inhalt liegt. Die zugehörigen Masken liegen
 * im CSS des Aufrufers (z. B. budget.css Tabs, layout.css Sidebar).
 *
 * Reagiert auf Scroll UND Größenänderungen (ResizeObserver deckt Viewport-
 * Resize, Ein-/Ausklappen und Font-Nachladen ab; beobachtet werden Container
 * und erstes Kind, damit auch Inhaltszuwachs triggert).
 *
 * @param {HTMLElement} el
 * @param {Object} [opts]
 * @param {'x'|'y'} [opts.axis='x']
 * @returns {() => void} Aufräumfunktion (Listener/Observer lösen)
 */
export function wireScrollFade(el, { axis = 'x' } = {}) {
  if (!el) return () => {};
  const eps = 8; // Toleranz: kein Fade bei minimalem Sub-Pixel-Offset
  const update = () => {
    const pos = axis === 'y' ? el.scrollTop : el.scrollLeft;
    const max = axis === 'y'
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
    el.classList.toggle('has-fade-start', pos > eps);
    el.classList.toggle('has-fade-end', pos < max - eps);
  };
  el.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(el);
  if (el.firstElementChild) ro.observe(el.firstElementChild);
  update();
  return () => {
    el.removeEventListener('scroll', update);
    ro.disconnect();
  };
}

/**
 * Führt eine asynchrone Aktion aus und markiert das auslösende Control derweil
 * als beschäftigt: `disabled` gegen Doppelauslösung, `aria-busy` für Screenreader,
 * optional eine Lade-Klasse.
 *
 * Der eigentliche Zweck ist das `finally`: `disabled` entzieht dem fokussierten
 * Element den Fokus (er fällt auf <body>), und ohne Rückgabe landet die Tastatur
 * nach jeder Aktion wieder am Seitenanfang. Der Fokus wird nur zurückgegeben,
 * wenn das Control ihn vorher hatte und noch im Dokument hängt - nach einem
 * Re-Render ist es abgehängt und ein focus() ginge ins Leere.
 *
 * @param {HTMLElement} control                 - Button, Checkbox, Select …
 * @param {() => Promise<any>} task             - Die auszuführende Aktion
 * @param {Object} [opts]
 * @param {string|null} [opts.loadingClass]     - Klasse während der Aktion, z. B. 'btn--loading'
 * @returns {Promise<any>} Rückgabewert von task
 */
export async function withBusy(control, task, { loadingClass = null } = {}) {
  const hadFocus = document.activeElement === control;
  if (loadingClass) control.classList.add(loadingClass);
  control.setAttribute('aria-busy', 'true');
  control.disabled = true;
  try {
    return await task();
  } finally {
    control.disabled = false;
    control.removeAttribute('aria-busy');
    if (loadingClass) control.classList.remove(loadingClass);
    if (hadFocus && control.isConnected && document.activeElement !== control) {
      control.focus({ preventScroll: true });
    }
  }
}
