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
 * DIE LEITZAHL WAEHLT IHRE STUFE NACH IHRER LAENGE (Critique R18, 2026-10-07).
 *
 * Je Geld-Reiter fuehrt EINE Zahl auf einer Display-Stufe. Wie breit sie
 * laeuft, weiss CSS nicht - die Zeichenzahl schon: "2.503,89 €" (10 Zeichen)
 * traegt bei 390px die volle Stufe, "175.444,93 €" (12) braucht eine darunter,
 * "CHF 175'444.93" (14) noch eine. Gemessen in fetten Systemziffern: rund
 * 0,6em je Zeichen. Die Stufen selbst stehen als clamp() in panel.css
 * (`--metric-lead-size`); diese Funktion nennt nur die Klasse.
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

/** Klassen der fuehrenden Kennzahlkarte: `metric-card--lead` samt Laengenstufe. */
export function leadCardClass(text) {
  const step = leadStep(text);
  return `metric-card--lead${step ? ` metric-card--lead-${step}` : ''}`;
}
