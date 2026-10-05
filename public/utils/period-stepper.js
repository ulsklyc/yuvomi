/**
 * Modul: Zeitraum-Stepper (period-stepper)
 * Zweck: DER EINE Zeitraum-Kopf der App - Markup und Reset-Regel fuer
 *        Kalender, Essensplan, Budget, Berichte der Haushaltshilfe und den
 *        Vergleich im Schichtplan.
 * Abhaengigkeiten: /utils/html.js
 *
 * WARUM (Critique 2026-10-05, R16 P1 "Bausteine werden nicht vererbt"):
 * fuenf Module bauten denselben Stepper je selbst - fuenf Markups, vier Kopien
 * der Reset-Regel (`.is-current` + `inert` + Fokus-Uebergabe), und der
 * Schichtplan hatte sie gar nicht: "Heute" stand dort auch in der laufenden
 * Woche. Die Reihenfolge stimmte seit R16 Schritt 2 ueberein, aber nur, weil
 * sie fuenfmal gleich abgeschrieben war.
 *
 * DIE REGEL, EINMAL:
 * - Reihenfolge im MARKUP (= Tab-Folge): Pfeil zurueck, Wert, Pfeil vor,
 *   DAHINTER der Reset ("Heute"/"Aktuell" ist ein Reset, kein Schritt).
 * - Die Pfeile nennen ihr OBJEKT ("Vorherige Woche", "Naechster Monat") - ein
 *   Pfeil ohne Namen wirft hier, statt stumm ausgeliefert zu werden.
 * - Der Reset zeigt sich nur, wenn der laufende Zeitraum NICHT zu sehen ist.
 *   Verborgen per `.is-current` + `inert`, nie per `hidden`: die Box bleibt im
 *   Fluss, kein Pfeil wandert (#1200). Hatte er den Fokus, uebernimmt ihn der
 *   Zurueck-Pfeil - `inert` wuerfe ihn sonst auf <body>.
 * - Tastatur: drei bzw. vier echte Knoepfe in Lesereihenfolge; Kuerzel sagt
 *   ein Modul ueber `keys` an (`aria-keyshortcuts`), ausgeloest werden sie im
 *   Dispatcher der Shell (router.js).
 *
 * - Blaettern TAUSCHT DEN INHALT GERICHTET (`swapPeriod`, R16 Bewegung): der
 *   neue Zeitraum kommt von der Seite, zu der man blaettert - 8px + Blende,
 *   derselbe Richtungssinn wie das Wischen (utils/period-swipe.js). Vorher
 *   schnitt jedes Modul hart; nur der Kalender glitt, und nur per Touch.
 *
 * Die Module behalten ihre ids und Klassen (Layout, Tests, Kuerzel haengen
 * daran); dazu kommen die geteilten Klassen `period-stepper__*`, an denen die
 * Shell-Regeln haengen (layout.css).
 */
import { esc } from '/utils/html.js';
import { swapContent } from '/utils/content-swap.js';

function attrsHtml(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

function arrowHtml(dir, { id, label, title = false, keys, attrs } = {}) {
  if (!label) throw new Error(`period-stepper: der Pfeil "${dir}" braucht einen Namen mit Objekt`);
  return `<button type="button" class="btn btn--icon period-stepper__${dir}"${attrsHtml({
    id,
    'aria-label': label,
    title: title ? label : undefined,
    'aria-keyshortcuts': keys,
    ...attrs,
  })}><i data-lucide="chevron-${dir === 'prev' ? 'left' : 'right'}" aria-hidden="true"></i></button>`;
}

/**
 * @param {object} o
 * @param {{ id?: string, label: string, title?: boolean, keys?: string, attrs?: object }} o.prev
 * @param {{ id?: string, label: string, title?: boolean, keys?: string, attrs?: object }} o.next
 * @param {{ id?: string, className?: string, text?: string, live?: boolean, attrs?: object }} o.value
 *        der Wert zwischen den Pfeilen; `text` ist Klartext und wird escaped
 * @param {{ id?: string, className?: string, label: string, current?: boolean, keys?: string, attrs?: object }} [o.reset]
 *        `current: true` rendert ihn verborgen (laufender Zeitraum ist zu sehen)
 * @returns {string} Markup: prev, value, next, reset - in dieser Reihenfolge
 */
export function periodStepperHtml({ prev, next, value = {}, reset = null }) {
  const valueHtml = `<span class="period-stepper__value${value.className ? ` ${esc(value.className)}` : ''}"${attrsHtml({
    id: value.id,
    'aria-live': value.live ? 'polite' : undefined,
    ...value.attrs,
  })}>${esc(value.text ?? '')}</span>`;
  const resetHtml = reset ? `<button type="button" class="btn btn--secondary period-stepper__reset${reset.className ? ` ${esc(reset.className)}` : ''}${reset.current ? ' is-current' : ''}"${attrsHtml({
    id: reset.id,
    'aria-keyshortcuts': reset.keys,
    inert: reset.current ? true : undefined,
    ...reset.attrs,
  })}>${esc(reset.label)}</button>` : '';
  return `
          ${arrowHtml('prev', prev)}
          ${valueHtml}
          ${arrowHtml('next', next)}
          ${resetHtml}`;
}

/**
 * Zieht den Reset auf den Stand nach: verborgen, wenn der laufende Zeitraum zu
 * sehen ist. Die EINE Fassung der Regel, die vorher in calendar.js, meals.js,
 * budget.js und housekeeping.js je einmal stand.
 *
 * @param {ParentNode|null} root  Wurzel, in der der Stepper steht
 * @param {object} o
 * @param {string} o.reset        Selektor des Reset-Knopfs
 * @param {boolean} o.isCurrent   ist der laufende Zeitraum zu sehen?
 * @param {string} [o.prev]       Selektor des Zurueck-Pfeils (Fokus-Uebergabe)
 * @param {string} [o.next]       Selektor des Weiter-Pfeils (Ersatz, falls der erste fehlt)
 * @returns {HTMLElement|null} der Reset-Knopf
 */
export function syncPeriodReset(root, { reset, isCurrent, prev = '.period-stepper__prev', next = '.period-stepper__next' }) {
  const btn = root?.querySelector?.(reset);
  if (!btn) return null;
  // `typeof document` statt eines nackten Bezeichners: Testumgebungen ohne DOM
  // stubben `document` nicht immer, und ein nackter Bezeichner wirft dort
  // schon beim Werteauswerten.
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (isCurrent && active === btn) {
    (root.querySelector(prev) || root.querySelector(next))?.focus();
  }
  btn.classList.toggle('is-current', Boolean(isCurrent));
  btn.inert = Boolean(isCurrent);
  // Der Wert nennt, ob man neben dem laufenden Zeitraum steht (layout.css
  // faerbt ihn dort, wo der Reset auf dem Wert liegt statt daneben).
  btn.parentElement?.querySelector?.('.period-stepper__value')?.classList.toggle('period-stepper__value--away', !isCurrent);
  return btn;
}

/**
 * Der Zeitraum hat gewechselt: tauscht den Inhalt des Traegers und blendet ihn
 * in Schrittrichtung ein. Die EINE Stelle, an der die Stepper-Module ihren
 * Inhaltswechsel einhaengen - die Regeln (kein Endzustand an einer Animation,
 * reduzierte Bewegung, Abbruch durch den naechsten Schritt) stehen in
 * utils/content-swap.js.
 *
 * @param {Element|null} host   Traeger des Zeitraum-Inhalts (ueberlebt den Tausch)
 * @param {number} step         > 0 weiter, < 0 zurueck; beim Reset die Richtung
 *                              zum laufenden Zeitraum, 0 = nur Blende
 * @param {() => void} update   zeichnet den neuen Zeitraum (synchron)
 * @returns {Animation|null}
 */
export function swapPeriod(host, step, update) {
  return swapContent(host, update, { direction: step });
}
