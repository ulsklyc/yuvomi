/**
 * EINE ZEILE STATT KENNZAHL-WAND (Re-Critique 2026-09-28, A5 P1-3).
 *
 * Mobil standen in Abos vier Kennzahl-Karten (2x2, 200px), in Darlehen drei
 * Karten plus eine Summenzeile, in Aufteilung der Saldo-Block vor dem ersten
 * Objekt - die erste Abo-Zeile bei y=478 von 844. Die Budget-Uebersicht hatte
 * die Loesung schon (`balanceGlanceHtml` in budget.js): EINE Zeile im
 * Zeilentraeger nennt die Leitzahl und daneben zwei Nebenwerte, ein Tipp
 * klappt die Karten auf. Diese Datei ist dieselbe Zeile fuer die anderen
 * Budget-Reiter - Markup und Klassen der Uebersicht (`.budget-glance*`,
 * budget.css), damit es EINE Form bleibt.
 *
 * Nur Markup und das Umschalten: budget.css zeigt den Traeger erst unter
 * 640px und blendet dort den eingeklappten Bereich (`.budget-glance-details`)
 * aus. Ab 640px bleibt die Kennzahl-Zeile stehen, die Zeile gibt es nicht.
 */
import { esc } from '/utils/html.js';

/**
 * @param {object} o
 * @param {string} o.id        id des Aufklappers
 * @param {string} o.controls  id des Bereichs, den er auf- und zuklappt
 * @param {boolean} o.expanded
 * @param {string} o.label     Leitwert-Beschriftung (Klartext, wird escaped)
 * @param {string} o.value     Leitwert, schon formatiert (Klartext, wird escaped)
 * @param {'neutral'|'positive'|'negative'|'forecast'} [o.tone]
 * @param {{ label: string, amount?: string, tone?: string }[]} [o.flows]
 *        hoechstens zwei Nebenwerte rechts; `amount` optional (z.B. „8 aktiv")
 */
export function metricGlanceHtml({ id, controls, expanded, label, value, tone = 'neutral', flows = [] }) {
  const side = flows.filter(Boolean).slice(0, 2);
  const flowsHtml = side.length ? `
        <span class="budget-glance__flows">${side.map((f) => `
          <span class="budget-glance__flow${f.tone ? ` budget-glance__flow--${esc(f.tone)}` : ''}">${esc(f.label)}${f.amount != null ? ` <span class="budget-glance__amount">${esc(f.amount)}</span>` : ''}</span>`).join('')}
        </span>` : '';
  return `
    <div class="row-carrier budget-glance">
      <button type="button" class="budget-glance__row budget-glance__balance" id="${esc(id)}"
              aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${esc(controls)}">
        <span class="budget-glance__lead">
          <span class="budget-glance__label">${esc(label)}</span>
          <span class="budget-glance__value budget-glance__value--${esc(tone)}">${esc(value)}</span>
        </span>${flowsHtml}
        <i data-lucide="chevron-down" class="icon-sm budget-glance__chevron" aria-hidden="true"></i>
      </button>
    </div>`;
}

/**
 * Auf- und Zuklappen ohne Neuaufbau: der Knopf behaelt Fokus und Position,
 * nur Klasse und aria-expanded ziehen nach. `onChange(expanded)` merkt sich
 * den Zustand im Modul, damit ein spaeterer Neuaufbau ihn wiederfindet.
 */
export function wireMetricGlance(root, id, onChange) {
  const button = root?.querySelector(`#${id}`);
  if (!button) return;
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // Ueber das Dokument, nicht die Wurzel: der Bereich darf neben dem Slot
    // der Zeile stehen (Aufteilung: #split-glance neben #split-summary).
    button.ownerDocument?.getElementById(button.getAttribute('aria-controls'))?.classList.toggle('is-expanded', expanded);
    onChange?.(expanded);
  });
}
