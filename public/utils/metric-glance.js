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
import { leadStep } from '/utils/metric-card.js';

/**
 * OHNE `controls` IST DIE ZEILE EIN ZEICHEN, KEIN KNOPF (R16 Schritt 2b):
 * ein Reiter mit EINER Kennzahl (Konten: Nettovermoegen) hat nichts
 * aufzuklappen - die Karte darunter nennte dieselbe Zahl noch einmal. Die
 * Zeile steht dann als `div` ohne Pfeil, in derselben Form wie die der
 * Nachbarreiter; die Karte bleibt unter 640px ausgeblendet.
 *
 * @param {object} o
 * @param {string} o.id        id des Aufklappers
 * @param {string} [o.controls]  id des Bereichs, den er auf- und zuklappt; ohne ihn steht die Zeile statisch
 * @param {boolean} o.expanded
 * @param {string} o.label     Leitwert-Beschriftung (Klartext, wird escaped)
 * @param {string} o.value     Leitwert, schon formatiert (Klartext, wird escaped)
 * @param {'neutral'|'positive'|'negative'|'forecast'} [o.tone]
 * @param {{ label: string, amount?: string, tone?: string }[]} [o.flows]
 *        hoechstens zwei Nebenwerte rechts; `amount` optional (z.B. „8 aktiv")
 * @param {boolean} [o.lead]   die Zahl FUEHRT den Bildschirm (R18): Display-Stufe,
 *        die Nebenwerte stehen als ruhige Zeile darunter (`glanceLeadClass`)
 */
export function metricGlanceHtml({ id, controls, expanded, label, value, tone = 'neutral', flows = [], lead: leads = false }) {
  const carrier = `row-carrier budget-glance${leads ? ` ${glanceLeadClass(value)}` : ''}`;
  const side = flows.filter(Boolean).slice(0, 2);
  const flowsHtml = side.length ? `
        <span class="budget-glance__flows">${side.map((f) => `
          <span class="budget-glance__flow${f.tone ? ` budget-glance__flow--${esc(f.tone)}` : ''}">${esc(f.label)}${f.amount != null ? ` <span class="budget-glance__amount">${esc(f.amount)}</span>` : ''}</span>`).join('')}
        </span>` : '';
  const lead = `
        <span class="budget-glance__lead">
          <span class="budget-glance__label">${esc(label)}</span>
          <span class="budget-glance__value budget-glance__value--${esc(tone)}">${esc(value)}</span>
        </span>${flowsHtml}`;
  if (!controls) {
    return `
    <div class="${carrier}">
      <div class="budget-glance__row budget-glance__row--static"${id ? ` id="${esc(id)}"` : ''}>${lead}
      </div>
    </div>`;
  }
  return `
    <div class="${carrier}">
      <button type="button" class="budget-glance__row budget-glance__balance" id="${esc(id)}"
              aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${esc(controls)}">${lead}
        <i data-lucide="chevron-down" class="icon-sm budget-glance__chevron" aria-hidden="true"></i>
      </button>
    </div>`;
}

/**
 * EINE LEITZAHL JE GELD-BILDSCHIRM (Critique R18, 2026-10-07). Mobil war das
 * groesste Element jedes Budget-Reiters das Wort "Budget" (34px), der Saldo
 * stand in 18px daneben. Mit dieser Klasse traegt die Zahl der Kurzzeile eine
 * Display-Stufe und die Nebenwerte ruecken als ruhige Zeile darunter
 * (panel.css `.budget-glance--lead`). Die Laengenstufe haelt sechsstellige
 * Betraege und lange Waehrungszeichen bei 390px in einer Zeile.
 */
export function glanceLeadClass(value) {
  const step = leadStep(value);
  return `budget-glance--lead${step ? ` budget-glance--lead-${step}` : ''}`;
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
