/**
 * Der Portionen-Stepper - EIN Baustein fuer Rezept und Mahlzeit (R24, E12).
 *
 * Ein Rezept kennt seit Migration 270, fuer wie viele Portionen seine Mengen
 * gelten (`recipes.servings`). Der Stepper steht ueber den Zutaten im
 * Rezept-Leseblatt, in der Detailspalte und im Mahlzeit-Dialog und rechnet die
 * Mengen live um (`scaleQuantityText`, utils/scale-quantity.js). Er ersetzt das
 * Faktorfeld „Zutaten skalieren" (`<input type=number step=0.1>` hinter
 * „Weitere Angaben"), das nur mit gewaehltem Rezept wirkte und sonst still blieb.
 *
 * OHNE GESPEICHERTE PORTIONEN rechnet er in Vielfachen des Rezepts („Menge
 * × 1,5", Schritte von 0,5): ein Bestandsrezept behauptet keine Zahl, die
 * niemand eingetragen hat, und laesst sich trotzdem umrechnen. Dasselbe
 * Bedienelement, ein anderes Wort - kein zweites Feld.
 *
 * Markup per String (Dialoge) und per Verdrahtung am Wurzelknoten; der Wert
 * steht im `<output>` (Live-Region, damit ein Vorleser den neuen Wert hoert).
 */

import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { servingsFactor } from '/utils/scale-quantity.js';

const MIN_SERVINGS = 1;
const MAX_SERVINGS = 99;
const MULTIPLES = { min: 0.5, max: 10, step: 0.5 };

/** Grenzen und Schritt des Steppers, je nachdem ob das Rezept Portionen kennt. */
export function servingsRange(base) {
  return base
    ? { min: MIN_SERVINGS, max: MAX_SERVINGS, step: 1 }
    : MULTIPLES;
}

/** Der sichtbare Wert: „4" bei Portionen, „× 1,5" bei Vielfachen. */
export function servingsValueText(base, value) {
  const number = getNumberFormat({ maximumFractionDigits: 1 }).format(value);
  return base ? number : t('recipes.servingsTimes', { value: number });
}

/**
 * @param {object} opts
 * @param {string} opts.id          eindeutiger Praefix (Label-Bezug)
 * @param {number|null} opts.base   recipe.servings oder null
 * @param {number} [opts.value]     Startwert (sonst base bzw. 1)
 * @param {string} [opts.className] zusaetzliche Klasse am Traeger
 */
export function servingsStepperHtml({ id, base, value, className = '' }) {
  const start = value ?? base ?? 1;
  const range = servingsRange(base);
  const label = base ? t('recipes.servingsLabel') : t('recipes.servingsMultipleLabel');
  return `
    <div class="servings-stepper${className ? ` ${esc(className)}` : ''}" role="group"
         aria-labelledby="${esc(id)}-label" data-servings-stepper
         data-base="${base ?? ''}" data-value="${start}">
      <span class="servings-stepper__label" id="${esc(id)}-label">${esc(label)}</span>
      <button type="button" class="servings-stepper__btn" data-servings-step="-1"
              aria-label="${esc(base ? t('recipes.servingsFewer') : t('recipes.servingsLess'))}"${start <= range.min ? ' disabled' : ''}>
        <i data-lucide="minus" class="icon-md" aria-hidden="true"></i>
      </button>
      <output class="servings-stepper__value" aria-live="polite">${esc(servingsValueText(base, start))}</output>
      <button type="button" class="servings-stepper__btn" data-servings-step="1"
              aria-label="${esc(base ? t('recipes.servingsMore') : t('recipes.servingsMoreMultiple'))}"${start >= range.max ? ' disabled' : ''}>
        <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`;
}

/** Der aktuelle Wert eines Steppers. */
export function servingsValueOf(stepper) {
  return Number(stepper?.dataset.value) || 1;
}

/** Der Faktor, mit dem die gespeicherten Mengen umgerechnet werden. */
export function servingsFactorOf(stepper) {
  const base = Number(stepper?.dataset.base) || null;
  return servingsFactor(base, servingsValueOf(stepper));
}

/**
 * Setzt einen Stepper auf einen Wert (geklemmt), ohne `onChange` zu rufen.
 * @returns {number} der gesetzte Wert
 */
export function setServingsValue(stepper, value) {
  const base = Number(stepper.dataset.base) || null;
  const range = servingsRange(base);
  const next = Math.min(range.max, Math.max(range.min, Math.round(value / range.step) * range.step));
  stepper.dataset.value = String(next);
  const out = stepper.querySelector('.servings-stepper__value');
  if (out) out.textContent = servingsValueText(base, next);
  const [minus, plus] = stepper.querySelectorAll('[data-servings-step]');
  // Einen fokussierten Knopf zu sperren wirft den Fokus auf <body>: dann auf
  // den Gegenknopf ausweichen, der als einziger noch etwas tut.
  for (const [btn, other, blocked] of [[minus, plus, next <= range.min], [plus, minus, next >= range.max]]) {
    if (!btn) continue;
    if (blocked && !btn.disabled && document.activeElement === btn) other?.focus();
    btn.disabled = blocked;
  }
  return next;
}

/**
 * Verdrahtet jeden Stepper unter `root` (Delegation, ein Listener).
 * `onChange(stepper, value, factor)` laeuft nach jedem Schritt.
 */
export function wireServingsSteppers(root, onChange) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-servings-step]');
    if (!btn || btn.disabled) return;
    const stepper = btn.closest('[data-servings-stepper]');
    if (!stepper || !root.contains(stepper)) return;
    const base = Number(stepper.dataset.base) || null;
    const { step } = servingsRange(base);
    const value = setServingsValue(stepper, servingsValueOf(stepper) + Number(btn.dataset.servingsStep) * step);
    onChange?.(stepper, value, servingsFactor(base, value));
  });
}
