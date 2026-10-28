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
 * @param {boolean} [o.everywhere] die Zeile steht in JEDER Breite, nicht nur unter
 *        640px (Critique R24, E2 "eine Kennzahlkarte oben"): fuer Flaechen, deren
 *        Kennzahlen keine Seitenspalte mehr tragen. Nur statisch (ohne `controls`) -
 *        es gibt dann keine Karten, die sie aufklappen koennte.
 */
export function metricGlanceHtml({ id, controls, expanded, label, value, tone = 'neutral', flows = [], lead: leads = false, everywhere = false }) {
  const carrier = `row-carrier budget-glance${leads ? ` ${glanceLeadClass(value)}` : ''}${everywhere && !controls ? ' budget-glance--everywhere' : ''}`;
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
 * stand in 18px daneben. Mit dieser Klasse traegt die Zahl der Kurzzeile
 * Title 1 und die Nebenwerte ruecken als ruhige Zeile darunter (panel.css
 * `.budget-glance--lead`). Seit R23 (D12) eine feste Stufe; zu lange Betraege
 * verkleinert `fitMetricLeads` (utils/metric-card.js), nicht die Zeichenzahl.
 */
export function glanceLeadClass() {
  return 'budget-glance--lead';
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

/**
 * DER KENNZAHL-SLOT STEHT AB DEM ERSTEN BILD (Critique R22, D4). Abos und
 * Aufteilung bauten Kurzzeile und Kennzahlkarten erst mit den Daten; bis dahin
 * war der Slot leer, und die Liste darunter rutschte beim Eintreffen um ihre
 * Hoehe nach unten - gemessen nach dem Reiterwechsel mobil 0,0996 (Abos) und
 * 0,060 (Aufteilung), am Laptop 0,025. CLS verschweigt das, weil der Sprung
 * einer Eingabe folgt (`hadRecentInput`).
 *
 * Das Skelett ist dasselbe Markup wie die echte Zeile und die echten Karten,
 * nur mit Platzhaltertext in `.skeleton-text` (durchsichtig, Schimmer): die
 * Hoehen kommen aus denselben Regeln, nicht aus nachgerechneten Zahlen.
 *
 * @param {object} [o]
 * @param {boolean} [o.lead]      wie `metricGlanceHtml` - die Zahl fuehrt
 * @param {boolean} [o.controls]  die echte Zeile klappt auf (Pfeil)
 * @param {number}  [o.flows]     Zahl der Nebenwerte (0-2)
 * @param {boolean} [o.everywhere] wie `metricGlanceHtml` - die Zeile steht in jeder Breite (R24, E2)
 * @returns {string}
 */
export function metricGlanceSkeletonHtml({ lead = false, controls = true, flows = 1, everywhere = false } = {}) {
  const bar = (text) => `<span class="skeleton skeleton-text">${text}</span>`;
  const side = Math.max(0, Math.min(2, flows));
  const flowsHtml = side ? `
        <span class="budget-glance__flows">${Array.from({ length: side }, () => `
          <span class="budget-glance__flow">${bar('0000000 00,00')}</span>`).join('')}
        </span>` : '';
  return `
    <div class="row-carrier budget-glance${lead ? ` ${glanceLeadClass('000,00')}` : ''}${everywhere && !controls ? ' budget-glance--everywhere' : ''}" aria-hidden="true">
      <div class="budget-glance__row${controls ? ' budget-glance__balance' : ' budget-glance__row--static'}">
        <span class="budget-glance__lead">
          <span class="budget-glance__label">${bar('0000000000')}</span>
          <span class="budget-glance__value budget-glance__value--neutral">${bar('000,00')}</span>
        </span>${flowsHtml}${controls ? `
        <span class="budget-glance__chevron icon-sm"></span>` : ''}
      </div>
    </div>`;
}

/**
 * Kennzahlkarten als Skelett in ihrer Form (siehe oben): Beschriftung, Wert
 * und auf Wunsch eine Fussnote je Karte.
 * @param {number} [count]
 * @param {object} [o]
 * @param {boolean} [o.note]  die echten Karten tragen eine Fussnote
 * @param {string} [o.tag]    Element der echten Karte (`article` oder `div`)
 * @returns {string}
 */
export function metricCardsSkeletonHtml(count = 3, { note = true, tag = 'article' } = {}) {
  const bar = (text) => `<span class="skeleton skeleton-text">${text}</span>`;
  return Array.from({ length: Math.max(1, count) }, () => `
    <${tag} class="metric-card" aria-hidden="true">
      <div class="metric-card__label">${bar('0000000000')}</div>
      <div class="metric-card__value">${bar('000,00')}</div>${note ? `
      <div class="metric-card__note">${bar('0000000000')}</div>` : ''}
    </${tag}>`).join('');
}
