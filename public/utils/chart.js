/**
 * Geteilte Geometrie einer Auswertungsfläche
 * Zweck: EIN Koordinatensystem für jede Zeitreihe mit Werteachse
 *
 * EXTRAHIERT, NICHT ENTWORFEN. Diese Geometrie stand in health.js und löste den
 * Fall dort für drei Charts (Vitalwerte, Laborwerte, Aktivität) - mit einer
 * Begründung, die für die ganze App gilt: sie sollen „als EIN lesbares System
 * wirken statt als drei verschiedene Kurven-Kästen". Genau dieselbe Aufgabe
 * stellten sich der Budget-Trend und das Abo-Flächenchart, und beide haben sie
 * je eigen und je falscher beantwortet:
 *
 *   health.js          role="img", proportional      Achse IM SVG (5 Ticks)
 *   budget-stats.js    preserveAspectRatio="none"    Achse als Spans daneben
 *   subscriptions.js   preserveAspectRatio="none"    Achse als DIV daneben
 *
 * Beide Fehler hängen zusammen: ohne feste Ränder gibt es keinen Platz für eine
 * Achse im Bild, also wandert sie nach draußen - und dort verschiebt sie sich
 * gegen ihre eigenen Gitterlinien, sobald das Diagramm skaliert. `PAD_L` ist die
 * Antwort auf beides.
 *
 * WAS HIER NICHT HINEINGEHÖRT: die Formatierung eines Achsenwerts. Ob an der
 * Y-Achse „8:24", „125" oder „1.240,00 €" steht, weiß nur das Modul - deshalb
 * nimmt `chartGridMarkup` einen `formatTick`-Callback statt einer Metrik.
 * Geometrie ist geteilt, Vokabular nicht.
 *
 * NICHT FÜR: Anteilsbalken (die brauchen eine Bahn, keine Achse - siehe die
 * vier Zusagen in DESIGN.md) und nicht für den Verteilungs-Donut. Das sind
 * andere Formen, keine anderen Fassungen dieser Form.
 */

import { esc } from '/utils/html.js';

/**
 * Der linke Gutter trägt die Y-Wert-Labels, der untere die X-Labels.
 *
 * PAD_L IST 56, NICHT 40. Bei 40 trug er die Vokabeln der Gesundheit („125",
 * „8:24") und schnitt die des Budgets ab: „5.050,00 €" stand als „3,00 €" da,
 * weil die linke Hälfte aus dem Bild lief. Gezeigt hat das ein Screenshot, nicht
 * die Messung - `getComputedStyle` kennt keinen abgeschnittenen SVG-Text. 56
 * trägt beide Vokabulare; die Kurve verliert dafür 16 von 548 Einheiten. Das ist
 * der Preis dafür, EINE Geometrie zu haben statt einer pro Modul.
 * 600x200 ist ein Seitenverhältnis, kein Pixelmaß: das SVG skaliert
 * proportional (kein `preserveAspectRatio="none"`), die Strichstärken hält
 * `vector-effect="non-scaling-stroke"` konstant, die Achsenschrift die Klasse
 * `.chart` am SVG (panel.css) - jedes SVG dieser Geometrie traegt sie.
 */
export const CHART = Object.freeze({ W: 600, H: 200, PAD_L: 56, PAD_R: 12, PAD_T: 14, PAD_B: 26 });

/** Die vier Plotgrenzen im viewBox-Koordinatensystem. */
export function chartScales() {
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = CHART;
  return { left: PAD_L, right: W - PAD_R, top: PAD_T, bottom: H - PAD_B };
}

/**
 * Fünf horizontale Gitterlinien mit Y-Wert-Beschriftung am linken Rand - eine
 * echte Werteachse statt zweier frei schwebender Min-/Max-Zahlen.
 *
 * @param {number} min  unterster Wert der Skala
 * @param {number} max  oberster Wert der Skala
 * @param {(value: number, wholeTicks: boolean) => string} formatTick
 *        Formatiert einen Achsenwert. `wholeTicks` meldet, dass die Spanne groß
 *        genug für ganzzahlige Labels ist: bei Spannen ab 4 Einheiten sind
 *        Nachkommastellen Pseudo-Präzision („125,9 mmHg", Audit A2-21), bei
 *        kleinen Spannen (Laborwerte 0,5-1,2) sind sie die eigentliche Auskunft.
 */
export function chartGridMarkup(min, max, formatTick) {
  const { W, PAD_L, PAD_R } = CHART;
  const { top, bottom } = chartScales();
  const out = [];
  const wholeTicks = (max - min) >= 4;
  for (let k = 0; k <= 4; k++) {
    const gy = top + (k * (bottom - top)) / 4;
    const val = max - (k * (max - min)) / 4;
    out.push(`<line class="chart__grid" x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" vector-effect="non-scaling-stroke" />`);
    // y = die Gitterlinie selbst: `.chart__axis--y` zentriert per
    // dominant-baseline. Der fruehere Versatz (+3.5 Einheiten) passte nur zu
    // einer Schrift, die mit dem Diagramm skaliert (panel.css, `.chart`).
    out.push(`<text x="${PAD_L - 6}" y="${gy.toFixed(1)}" class="chart__axis chart__axis--y" text-anchor="end">${esc(formatTick(val, wholeTicks))}</text>`);
  }
  return out.join('');
}

/**
 * X-Achsen-Labels (erstes, mittleres, letztes) unter dem Plot, an den
 * Plotgrenzen ausgerichtet: das erste linksbündig, das letzte rechtsbündig.
 * Drei Marken statt einer pro Datenpunkt - eine Zeitachse muss nicht jeden
 * Punkt benennen, sie muss ihre Spanne benennen.
 *
 * @param {string[]} labels  bereits formatierte Beschriftungen
 */
export function chartXLabelsMarkup(labels) {
  if (!labels.length) return '';
  const { H, W, PAD_L, PAD_R } = CHART;
  const y = H - 7;
  const picks = labels.length <= 2
    ? labels.slice()
    : [labels[0], labels[Math.floor((labels.length - 1) / 2)], labels[labels.length - 1]];
  return picks.map((label, idx) => {
    const anchor = idx === 0 ? 'start' : idx === picks.length - 1 ? 'end' : 'middle';
    const px = anchor === 'start' ? PAD_L : anchor === 'end' ? W - PAD_R : (PAD_L + (W - PAD_R)) / 2;
    return `<text x="${px.toFixed(1)}" y="${y}" class="chart__axis" text-anchor="${anchor}">${esc(label)}</text>`;
  }).join('');
}

/**
 * Rechnet einen Wert auf seine Y-Koordinate im Plot. Steht hier, weil jede
 * Zeitreihe sie braucht und drei Module sie bisher je eigen geschrieben haben.
 */
export function chartY(value, min, max) {
  const { top, bottom } = chartScales();
  if (max === min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

/** Rechnet einen Index auf seine X-Koordinate im Plot. */
export function chartX(index, count) {
  const { left, right } = chartScales();
  if (count <= 1) return left;
  return left + (index * (right - left)) / (count - 1);
}
