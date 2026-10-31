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
 * Eine Einheit, die hier nicht steht (eine Altzeile aus der Zeit, als die API
 * jeden Text annahm, etwa "g", "stone" oder "kPa"), hat keine Zahlenraender -
 * nur die Regeln, die ohne Einheit gelten (SpO2 zwischen 1 und 100, systolisch
 * ueber diastolisch). Neu geschrieben wird so eine Einheit nicht mehr, siehe
 * VITAL_UNITS (#2375).
 */

/**
 * Typ -> Einheiten, die geschrieben werden duerfen. Dieselbe Liste wie
 * `metric.units` im Dialog (public/utils/health-vitals.js, das der Server wegen
 * seiner Browser-Importe nicht laden kann); test:health-vitals haelt beide
 * gleich. Exakte Schreibweise: die Grenzen oben sind nach ihr verschluesselt,
 * "KG" liefe sonst an ihnen vorbei wie "g".
 */
export const VITAL_UNITS = Object.freeze({
  bp: Object.freeze(['mmHg']),
  glucose: Object.freeze(['mg/dL', 'mmol/L']),
  weight: Object.freeze(['kg', 'lb']),
  height: Object.freeze(['cm', 'in']),
  head_circumference: Object.freeze(['cm', 'in']),
  spo2: Object.freeze(['%']),
  temp: Object.freeze(['°C', '°F']),
  sleep: Object.freeze(['h']),
  mood: Object.freeze([]),
});

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
 * Passt die Einheit zur Metrik? Ohne Einheit ist nichts zu pruefen (`unit` ist
 * optional), und ein Typ ohne Metrik hat keine Liste: `type` ist freier Text.
 *
 * @param {{type: string, unit?: string|null}} m
 * @returns {null|readonly string[]} null, wenn sie passt; sonst die erlaubten
 */
export function vitalUnitError({ type, unit }) {
  if (unit === null || unit === undefined) return null;
  const allowed = own(VITAL_UNITS, type);
  return !allowed || allowed.includes(unit) ? null : allowed;
}

/**
 * Lehnt eine Einheit ab, die die Metrik nicht fuehrt (#2375). `error` nennt
 * API-Nutzern die erlaubten Einheiten, die App zeigt zum `reason` ihren Satz.
 *
 * @param {import('express').Response} res
 * @param {readonly string[]} allowed - aus vitalUnitError
 */
export function refuseVitalUnit(res, allowed) {
  const hint = allowed.length ? `Use one of: ${allowed.join(', ')}.` : 'It takes no unit.';
  return res.status(400).json({ error: `Unit not accepted for this measurement. ${hint}`, code: 400, reason: 'health_vital_unit_invalid' });
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
