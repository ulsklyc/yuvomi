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

// --------------------------------------------------------
// Verzögertes Löschen mit Undo-Fenster (kanonisches Muster, Audit F-13)
// --------------------------------------------------------

const _pendingDeletes = new Set();
let _deleteFlushBound = false;

function bindDeleteFlush() {
  if (_deleteFlushBound) return;
  _deleteFlushBound = true;
  // Tab-Schließen/Reload innerhalb des Undo-Fensters: offene Löschungen sofort
  // mit keepalive-Fetch abschicken, statt sie stillschweigend zu verlieren —
  // sonst „kam der Eintrag zurück", obwohl die UI ihn längst entfernt hatte.
  window.addEventListener('pagehide', () => {
    for (const entry of [..._pendingDeletes]) entry.flush();
  });
}

/**
 * Kanonisches Undo-Löschmuster: UI sofort aktualisieren (macht der Aufrufer),
 * Server-Delete erst nach Ablauf des Undo-Fensters. Deckt die Lücke des
 * bisherigen Inline-Musters: bei Reload/Tab-Schließen im Fenster wird der
 * Delete jetzt per keepalive nachgereicht statt verloren.
 *
 * @param {Object} opts
 * @param {(ctx: { keepalive: boolean }) => Promise<void>} opts.commit
 *        Führt den Server-Delete aus; ctx.keepalive an api.delete durchreichen.
 * @param {(err?: Error) => void} [opts.restore]
 *        Stellt die UI wieder her — bei Undo (ohne err) und bei fehl-
 *        geschlagenem Commit (mit err; dort auch Fehlermeldung zeigen).
 * @param {string} opts.message  - Toast-Text
 * @param {number} [opts.duration=5000] - Undo-Fenster in ms
 */
export function scheduleUndoableDelete({ commit, restore, message, duration = 5000 }) {
  bindDeleteFlush();
  let settled = false;
  const entry = {};
  const finish = async ({ keepalive = false } = {}) => {
    if (settled) return;
    settled = true;
    _pendingDeletes.delete(entry);
    clearTimeout(entry.timer);
    try {
      await commit({ keepalive });
    } catch (err) {
      // Beim pagehide-Flush ist die Seite weg — kein UI-Restore mehr möglich.
      if (!keepalive) restore?.(err);
    }
  };
  entry.flush = () => { finish({ keepalive: true }); };
  entry.timer = setTimeout(() => finish(), duration);
  _pendingDeletes.add(entry);
  window.yuvomi?.showToast(message, 'default', duration, () => {
    if (settled) return;
    settled = true;
    _pendingDeletes.delete(entry);
    clearTimeout(entry.timer);
    restore?.();
  });
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
 * Reagiert auf Scroll, Größenänderungen (ResizeObserver: Viewport-Resize,
 * Ein-/Ausklappen, Font-Nachladen) UND Inhaltswechsel (MutationObserver:
 * Re-Render via replaceChildren/insertAdjacentHTML ändert scrollWidth, ohne
 * dass sich die Elementgröße ändert — der RO allein sähe das nicht).
 *
 * @param {HTMLElement} el
 * @param {Object} [opts]
 * @param {'x'|'y'} [opts.axis='x']
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function wireScrollFade(el, { axis = 'x' } = {}) {
  if (!el) return { update: () => {}, destroy: () => {} };
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
  const mo = new MutationObserver(update);
  mo.observe(el, { childList: true, subtree: true });
  update();
  return {
    update,
    destroy: () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    },
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
