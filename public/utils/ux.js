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
