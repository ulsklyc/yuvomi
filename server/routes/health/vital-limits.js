/**
 * Modul: Gesundheit - harte Grenzen der Vitalwerte (Critique R19, 2026-10-16)
 * Zweck: Lehnt ab, was kein Mensch messen kann. 650 kg, eine Sauerstoff-
 *        saettigung ueber 100 % oder ein systolischer Wert unter dem
 *        diastolischen gingen bis hierher durch und verzerrten danach jeden
 *        Trend, jede Achse und jeden Mittelwert.
 *
 * GROSSZUEGIG, NICHT KLINISCH. Diese Grenzen fragen "ist das moeglich?", nicht
 * "ist das gesund?". Sie liegen jenseits dokumentierter Extremwerte, damit
 * keine echte, wenn auch dramatische Messung abgewiesen wird (ein Neugeborenes,
 * eine Unterkuehlung, eine entgleiste Diabetes-Einstellung). Was nur
 * ungewoehnlich ist, meldet das Formular als weichen Hinweis
 * (public/utils/health-vitals.js, VITAL_SOFT_RANGES) - gespeichert wird es.
 *
 * Belege fuer die Raender, je Zeile:
 *   - Blutdruck: systolisch 40-300, diastolisch 20-200 mmHg. Gemessene
 *     Spitzen liegen um 370/360 mmHg nur unter Maximalbelastung im Labor;
 *     am Oberarm zuhause sind 300 mmHg die Skalengrenze ueblicher Geraete.
 *     Systolisch ist IMMER groesser als diastolisch - Gleichstand oder
 *     Umkehrung ist ein Tippfehler (vertauschte Felder).
 *   - Puls: 20-300 /min (Bradykardie bei Unterkuehlung bis Tachyarrhythmie).
 *   - Blutzucker: 10-2000 mg/dL bzw. 0,5-111 mmol/L. Der hoechste
 *     dokumentierte Wert liegt bei rund 2650 mg/dL - ueber 2000 zeigt kein
 *     Heimgeraet mehr an ("HI" ab etwa 600).
 *   - Gewicht: 0,2-700 kg bzw. 0,4-1550 lb. Frueh- und Neugeborene ab 200 g,
 *     das schwerste dokumentierte Gewicht lag bei rund 635 kg.
 *   - SpO2: 1-100 %. Ueber 100 % ist physikalisch unmoeglich.
 *   - Koerpertemperatur: 10-46 °C bzw. 50-115 °F. Ueberlebte Unterkuehlung bis
 *     13,7 °C, Hitzschlag bis rund 46,5 °C.
 *
 * Eine Einheit, die hier nicht steht (per API oder Import erfasst, etwa
 * "stone" oder "kPa"), hat keine Zahlenraender - nur die Regeln, die ohne
 * Einheit gelten (SpO2 zwischen 1 und 100, systolisch ueber diastolisch).
 */

/** Typ -> Einheit -> [min, max] fuer value_num (inklusive Raender). */
export const VITAL_HARD_LIMITS = Object.freeze({
  bp: Object.freeze({ mmHg: Object.freeze({ sys: [40, 300], dia: [20, 200] }) }),
  glucose: Object.freeze({ 'mg/dL': [10, 2000], 'mmol/L': [0.5, 111] }),
  weight: Object.freeze({ kg: [0.2, 700], lb: [0.4, 1550] }),
  spo2: Object.freeze({ '%': [1, 100] }),
  temp: Object.freeze({ '°C': [10, 46], '°F': [50, 115] }),
});

/** Puls (value_num3 am Blutdruck) in Schlaegen pro Minute. */
export const PULSE_HARD_LIMITS = Object.freeze([20, 300]);

const within = (value, [min, max]) => value >= min && value <= max;
// `type` und `unit` kommen frei vom Client: nur EIGENE Schluessel der Tabellen
// zaehlen, sonst findet "constructor" oder "toString" eine geerbte Eigenschaft
// (Review #2049) und die Pruefung wirft statt "keine Raender" zu sagen.
const own = (table, key) => (table && key != null && Object.hasOwn(table, key) ? table[key] : undefined);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Prueft eine Messung gegen die harten Grenzen.
 *
 * @param {{type: string, unit?: string|null, value_num?: number|null, value_num2?: number|null, value_num3?: number|null}} m
 *   die Messung, wie sie NACH dem Speichern stuende (bei PATCH: Bestand + Aenderung)
 * @returns {null|'bp_order'|'out_of_range'} null, wenn moeglich
 */
export function vitalLimitError({ type, unit, value_num: v1, value_num2: v2, value_num3: v3 }) {
  if (type === 'bp') {
    if (isNum(v1) && isNum(v2) && v1 <= v2) return 'bp_order';
    const limits = own(VITAL_HARD_LIMITS.bp, unit ?? 'mmHg');
    if (limits && ((isNum(v1) && !within(v1, limits.sys)) || (isNum(v2) && !within(v2, limits.dia)))) return 'out_of_range';
    if (isNum(v3) && !within(v3, PULSE_HARD_LIMITS)) return 'out_of_range';
    return null;
  }
  if (!isNum(v1)) return null;
  // Eine Saettigung liegt in jeder Schreibweise in [1, 100], auch ohne oder
  // mit fremder Einheit - beide Raender (Review #2049: -10 und 0 gingen durch).
  if (type === 'spo2' && !within(v1, VITAL_HARD_LIMITS.spo2['%'])) return 'out_of_range';
  const range = own(own(VITAL_HARD_LIMITS, type), unit);
  return range && !within(v1, range) ? 'out_of_range' : null;
}

/**
 * Lehnt eine unmoegliche Messung ab, mit einem `reason` je Fall (#1909): die
 * App zeigt dazu ihren eigenen Satz (friendly-error.js, CASE_MESSAGES).
 *
 * @param {import('express').Response} res
 * @param {'bp_order'|'out_of_range'} kind - aus vitalLimitError
 */
export function refuseImpossibleVital(res, kind) {
  if (kind === 'bp_order') {
    return res.status(400).json({ error: 'Systolic must be greater than diastolic.', code: 400, reason: 'health_vital_bp_order' });
  }
  return res.status(400).json({ error: 'Value is outside the possible range.', code: 400, reason: 'health_vital_out_of_range' });
}
