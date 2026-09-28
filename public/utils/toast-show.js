/**
 * Modul: Toast anzeigen
 * Zweck: showToast - die EINE Rueckmeldungsflaeche der App (window.yuvomi.showToast).
 *        Aus router.js hierher gezogen (Re-Critique 2026-09-28), damit ihr
 *        Verhalten ohne Browser pruefbar ist: test/test-toast-show.js.
 * Abhaengigkeiten: i18n.js, utils/toast-surface.js, utils/ux.js
 */
import { t } from '/i18n.js';
import { toastSurface } from '/utils/toast-surface.js';
// Relativ, nicht '/utils/ux.js': im Browser dieselbe URL, im Test aber das echte
// Modul statt der Attrappe des Test-Loaders (die kennt keine Wischgeste).
import { wireSwipeToDismiss } from './ux.js';

const TOAST_SUCCESS_KEY = 'yuvomi:toastSuccessCount';
export const TOAST_SUCCESS_MAX = 50;
/** Mindestrest, mit dem eine pausierte Frist weiterlaeuft. */
export const TOAST_RESUME_MIN_MS = 2000;
/** So lange steht eine stille Ansage in der Live-Region, dann raeumt sie sich ab. */
const ANNOUNCE_MS = 5000;

function _toastSvg(children) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'toast__icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of children) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

const TOAST_ICONS = {
  success: () => _toastSvg([['polyline', { points: '20 6 9 17 4 12' }]]),
  danger:  () => _toastSvg([
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line',   { x1: '12', y1: '8',  x2: '12',   y2: '12' }],
    ['line',   { x1: '12', y1: '16', x2: '12.01', y2: '16' }],
  ]),
  warning: () => _toastSvg([
    ['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }],
    ['line', { x1: '12', y1: '9',  x2: '12',   y2: '13' }],
    ['line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }],
  ]),
};

export function showToast(message, type = 'default', duration = 3000, onUndo = null) {
  const container = toastSurface((type === 'danger' || type === 'warning') ? 'assertive' : 'polite');
  if (!container) return;

  // Aktions-Button: Legacy-Undo (Funktion) oder benannte Aktion ({ label, onClick }).
  const action = typeof onUndo === 'function'
    ? { label: t('common.undo'), onClick: onUndo }
    : (onUndo && typeof onUndo.onClick === 'function' ? onUndo : null);

  // Long Loop: nach TOAST_SUCCESS_MAX Erfolgen verstummt die FLAECHE, nie die
  // Ansage. Bis 2026-09-28 kehrte hier ein `return` zurueck, und ein
  // Screenreader hoerte ab dem 51. Erfolg nie mehr "Gespeichert" (A1 P2-4).
  // Aktions-Toasts (Undo oder benannte Aktion) sind wichtig -> nie still.
  if (type === 'success' && !action && successSurfaceSpent()) {
    announceQuietly(container, message);
    return;
  }

  // Max. 3 gleichzeitige Toasts (global): ältesten entfernen falls Limit erreicht
  const existing = document.querySelectorAll('.toast-container .toast');
  if (existing.length >= 3) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type !== 'default' ? `toast--${type}` : ''}`;
  // Keine eigene Live-Rolle: die Region (hoeflich oder bestimmt) sagt an.
  // `role="alert"` machte jeden Toast bestimmt, auch in der hoeflichen Region,
  // und liess ihn je nach Screenreader doppelt ansagen.

  const iconEl = TOAST_ICONS[type]?.();
  if (iconEl) toast.appendChild(iconEl);
  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  if (action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast__undo';
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      deadline.cancel();
      toast.remove();
      action.onClick();
    });
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);
  const dismiss = () => {
    deadline.cancel();
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  // Die Frist pausiert unter Zeiger und Fokus (A1 P2-3, WCAG 2.2.1): wer zu
  // "Rueckgaengig" tabbt oder langsamer liest als die Frist, verliert den Toast
  // nicht unter der Hand.
  const deadline = pausableDeadline(toast, dismiss, duration);

  // Wischen zum Verwerfen: die Geste samt ihrer zwei Fallen liegt in
  // `wireSwipeToDismiss` (utils/ux.js), das CSS-Gegenstück ist das
  // `touch-action: pan-y` auf `.toast`.
  wireSwipeToDismiss(toast, { onDismiss: dismiss });
}


/**
 * Zaehlt einen Erfolg und sagt, ob die sichtbare Flaeche verbraucht ist.
 * Ein Speicher, der wirft (privates Fenster, gesperrte Website-Daten), zaehlt
 * nicht - die Rueckmeldung erscheint dann einfach.
 * @returns {boolean}
 */
function successSurfaceSpent() {
  try {
    const count = parseInt(localStorage.getItem(TOAST_SUCCESS_KEY) ?? '0', 10) + 1;
    localStorage.setItem(TOAST_SUCCESS_KEY, String(count));
    return count > TOAST_SUCCESS_MAX;
  } catch {
    return false;
  }
}

/**
 * Nur die Ansage, ohne Flaeche: ein unsichtbarer Knoten in der Live-Region.
 * Er ist bewusst kein `.toast` - Stapelgrenze und Toast-Lage zaehlen ihn nicht.
 * @param {HTMLElement} container  die hoefliche Region
 * @param {string} message
 */
function announceQuietly(container, message) {
  const note = document.createElement('div');
  note.className = 'sr-only';
  note.textContent = message;
  container.appendChild(note);
  setTimeout(() => note.remove(), ANNOUNCE_MS);
}

/**
 * Eine Frist, die unter Zeiger und Fokus stillsteht. Zeiger und Fokus sind
 * zwei Griffe: sie laeuft erst weiter, wenn beide los sind, und dann mit
 * mindestens `minRest` - eine Restfrist von 300ms nach dem Wegzeigen waere
 * dasselbe Verschwinden, nur spaeter.
 *
 * Ein Fokuswechsel INNERHALB des Toasts (Text -> Rueckgaengig) ist kein
 * Loslassen: `focusout` mit einem `relatedTarget` im Toast zaehlt nicht.
 *
 * @param {HTMLElement} el
 * @param {() => void} onExpire
 * @param {number} duration  ms
 * @param {{ minRest?: number }} [opts]
 * @returns {{ cancel: () => void }}
 */
export function pausableDeadline(el, onExpire, duration, { minRest = TOAST_RESUME_MIN_MS } = {}) {
  let remaining = duration;
  let startedAt = Date.now();
  let timer = setTimeout(expire, remaining);
  let done = false;
  const holds = new Set();

  function expire() {
    if (done) return;
    done = true;
    onExpire();
  }
  function hold(reason) {
    if (done) return;
    if (holds.size === 0) {
      clearTimeout(timer);
      remaining -= Date.now() - startedAt;
    }
    holds.add(reason);
  }
  function release(reason) {
    if (done || !holds.delete(reason) || holds.size > 0) return;
    remaining = Math.max(remaining, minRest);
    startedAt = Date.now();
    timer = setTimeout(expire, remaining);
  }

  el.addEventListener('pointerenter', () => hold('pointer'));
  el.addEventListener('pointerleave', () => release('pointer'));
  el.addEventListener('focusin', () => hold('focus'));
  el.addEventListener('focusout', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    release('focus');
  });

  return {
    cancel() {
      done = true;
      clearTimeout(timer);
    },
  };
}
