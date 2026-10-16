/**
 * Modul: Eigene native Dialoge im Bild des geteilten Modals (D7)
 * Zweck: Die Symbolauswahl (components/icon-picker.js) und der Zuschnitt
 *        (utils/avatar-crop.js) sind seit jeher ein `<dialog>` mit
 *        `showModal()`. Seit das geteilte Modal dieselbe Mechanik nutzt,
 *        tragen sie auch dieselbe Praesentation: `.dialog-surface` (layout.css)
 *        gibt Tafel, `::backdrop`, Einfahrt (Blatt mobil, Scale-in am Desktop)
 *        und Ausgang aus denselben Tokens und Kurven. Vorher verschwanden sie
 *        hart und lagen auf einem eigenen, flachen Grund.
 *
 * Der Ausgang laeuft IN der Top-Layer (die Seite darunter bleibt die 150-200 ms
 * inert) und loest erst auf, wenn der Knoten weg ist. Wer danach fokussiert -
 * das Formular, aus dem die Wahl kam -, fokussiert deshalb nichts Inertes.
 */

import { durationToken, easingToken } from '/utils/ux.js';

/** Laenger als der laengste Ausgang (`--sheet-out`), nur das Netz. */
const DISMISS_FALLBACK_MS = 400;

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Unter reduzierter Bewegung blendet der Dialog statt zu fahren - nur Opacity,
 * per Web Animations (die CSS-Sperre in reset.css setzt Animationen auf 0s).
 * Direkt nach `showModal()` aufrufen.
 * @param {HTMLDialogElement} dialog
 */
export function revealDialog(dialog) {
  if (!reducedMotion() || typeof dialog?.animate !== 'function') return;
  dialog.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: durationToken('--duration-sm', 150),
    easing: easingToken('--ease-out'),
  });
}

/**
 * Den Dialog ausfahren lassen und danach entfernen.
 * @param {HTMLDialogElement} dialog
 * @returns {Promise<void>} loest auf, sobald der Knoten aus dem Dokument ist
 */
export function dismissDialog(dialog) {
  if (!dialog?.isConnected) return Promise.resolve();
  if (dialog._dismissing) return dialog._dismissing;
  dialog._dismissing = new Promise((resolve) => {
    let fertig = false;
    const weg = () => {
      if (fertig) return;
      fertig = true;
      dialog.remove();
      resolve();
    };
    if (!dialog.open || typeof dialog.getAnimations !== 'function') { weg(); return; }
    dialog.classList.add('dialog-surface--closing');
    if (reducedMotion()) {
      dialog.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: durationToken('--duration-sm', 150),
        easing: easingToken('--ease-out'),
        fill: 'forwards',
      });
    }
    const laufend = dialog.getAnimations({ subtree: true });
    if (!laufend.length) { weg(); return; }
    setTimeout(weg, DISMISS_FALLBACK_MS);
    Promise.allSettled(laufend.map((a) => a.finished)).then(weg);
  });
  return dialog._dismissing;
}
