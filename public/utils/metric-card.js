/**
 * Modul: Geteilte Kennzahl-Bauteile (.metric-card, panel.css)
 * Zweck: Das Valenz-Muster der Trend-Zeile als EINE API halten.
 *
 * Farbe und Richtung sind zwei Kanäle (Critique 2026-08-10, P0):
 *   - Der PFEIL zeigt die Richtung der Zahl auf der Karte.
 *   - Die FARBE trägt allein die Valenz: `betterWhen` sagt pro Kennzahl, ob
 *     mehr oder weniger die gute Richtung ist. Ohne `betterWhen` (null) bleibt
 *     die Farbe Sekundärtext - für Metriken, bei denen „hoch" je nach Kontext
 *     gut ODER schlecht ist (Gewicht, SpO₂, Glukose).
 *
 * Diese Datei existiert, damit der Budget-P0 (Vorzeichen der Differenz als
 * Farbe gelesen) nicht als Kopie in die anderen Kennzahl-Familien wandert:
 * wer eine Trend-Zeile rendert, entscheidet die Valenz HIER, nicht im Modul.
 * Die Textformate bleiben Modulsache (Geldbetrag vs. Messwert).
 */

/**
 * Valenz einer Veränderung: welche Farbe die Trend-Zeile trägt.
 * @param {number} delta Veränderung im Anzeigeraum der Karte
 * @param {'higher'|'lower'|null} betterWhen Welche Richtung die gute ist;
 *        null = die Metrik hat keine feste gute Richtung (Farbe bleibt neutral)
 * @returns {'positive'|'negative'|'neutral'}
 */
export function trendValence(delta, betterWhen) {
  if (betterWhen == null || delta === 0) return 'neutral';
  const rising = delta > 0;
  const improved = betterWhen === 'lower' ? !rising : rising;
  return improved ? 'positive' : 'negative';
}

/**
 * Richtungs-Icon der Veränderung (Lucide-Name). Die Richtung spricht immer
 * über den Pfeil, nie über die Farbe.
 */
export function trendIcon(delta) {
  if (delta > 0) return 'trending-up';
  if (delta < 0) return 'trending-down';
  return 'minus';
}

/**
 * Markup der Trend-Zeile einer Kennzahlkarte.
 * @param {object} opts
 * @param {number} opts.delta Veränderung im Anzeigeraum der Karte
 * @param {'higher'|'lower'|null} [opts.betterWhen]
 * @param {string} opts.text Bereits escapter/markup-fertiger Zeilentext
 * @param {boolean} [opts.icon] Pfeil rendern (false z. B. für „wie im Jul")
 * @returns {string} `<span class="metric-card__trend ...">`
 */
export function trendMarkup({ delta, betterWhen = null, text, icon = true }) {
  const valence = trendValence(delta, betterWhen);
  const iconHtml = icon
    ? `<i data-lucide="${trendIcon(delta)}" class="icon-sm" aria-hidden="true"></i>`
    : '';
  return `<span class="metric-card__trend metric-card__trend--${valence}">${iconHtml}${text}</span>`;
}

/**
 * DIE ZEICHENZAHL EINER LEITZAHL (Critique R18, 2026-10-07).
 *
 * Bis R23 waehlte die Leitzahl daraus ihre Schriftstufe. Seit D12 steht sie in
 * EINER festen Stufe je Ort und wird nur kleiner, wenn sie wirklich nicht passt
 * (`fitMetricLeads` unten). Die Zahl bleibt fuer eine LAYOUT-Frage: eine
 * Viererreihe mit langer Leitzahl bricht am Tablet in zwei mal zwei
 * (budget.css `.metric-grid--long-lead`).
 *
 * @param {string} text der fertig formatierte Wert (Klartext)
 * @returns {''|'long'|'xlong'|'xxlong'}
 */
export function leadStep(text) {
  const n = Array.from(String(text ?? '')).length;
  if (n <= 10) return '';
  if (n <= 13) return 'long';
  if (n <= 17) return 'xlong';
  return 'xxlong';
}

/**
 * Klassen der fuehrenden Kennzahlkarte. Der Wert-Parameter bleibt fuer die
 * Aufrufer stehen, entscheidet aber nichts mehr (R23, D12).
 */
export function leadCardClass() {
  return 'metric-card--lead';
}

// Die Werte, die fitMetricLeads misst: die fuehrende Karte, die Kurzzeile mit
// Leitzahl (utils/metric-glance.js) und die Kennzahlkachel der Uebersicht
// (`.metric-card--tile`, DW-P2-7) - mobil fuellt sie sich per `auto-fit`, ab
// 768px steht sie in der Spaltenzahl ihres Hoehenmodells (U15); die Breite der
// Reihe sagt in beiden Faellen nichts ueber die Breite der Kachel.
const LEAD_VALUES = '.metric-card--lead > .metric-card__value, .budget-glance--lead .budget-glance__value, .metric-card--tile > .metric-card__value';
const FIT_STEPS = 2;
let fitObserver = null;

/**
 * VERKLEINERN NUR BEI UEBERLAUF (R23, D12).
 *
 * Misst je Leitzahl ihren Traeger (die Karte bzw. die Kurzzeile): laeuft der
 * Inhalt ueber, tritt die Zahl eine Stufe zurueck (`data-fit="1"`, Title 2),
 * notfalls zwei (`"2"`, Title 3) - die Stufen stehen in panel.css. Ueber einen
 * ResizeObserver: sein erster Rueckruf kommt nach dem Layout und VOR dem
 * ersten Bild, also ohne sichtbaren Sprung, und jede Breitenaenderung
 * (Drehen, Seitenleiste, aufgeklappte Kennzahlen) misst neu. Ein verborgener
 * Traeger (0px) wird nicht gemessen; er meldet sich, sobald er erscheint.
 *
 * @param {ParentNode} root  frisch gezeichneter Bereich
 */
export function fitMetricLeads(root) {
  if (!root?.querySelectorAll || typeof ResizeObserver === 'undefined') return;
  const values = root.querySelectorAll(LEAD_VALUES);
  if (!values.length) return;
  fitObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!entry.target.isConnected) fitObserver.unobserve(entry.target);
      else fitLead(entry.target);
    }
  });
  for (const value of values) {
    const box = value.closest('.metric-card, .budget-glance__row');
    if (box) fitObserver.observe(box);
  }
}

/* UEBERLAUF HEISST AUCH: UEBER DIE EIGENE BOX (U15, Review p11). Gemessen
 * wurde nur der Traeger - eine Zahl, die in sein Polster lief, fiel dort nicht
 * auf: "10 im Monat" stand in der 176px-Kachel der Uebersicht 3px vor der
 * Kante, in 158px "-196,14 €" 10px. Darum zaehlt die Box der Zahl mit (1px
 * Rundung Spiel; eine Box ohne Breite, etwa inline, wird nicht gefragt). */
function overflows(box, value) {
  return box.scrollWidth > box.clientWidth
    || (value.clientWidth > 0 && value.scrollWidth > value.clientWidth + 1);
}

function fitLead(box) {
  const value = box.querySelector(LEAD_VALUES);
  if (!value || box.clientWidth === 0) return;
  value.removeAttribute('data-fit');
  for (let step = 1; step <= FIT_STEPS && overflows(box, value); step += 1) {
    value.setAttribute('data-fit', String(step));
  }
}
