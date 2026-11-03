/**
 * Modul: Einheiten der Vitalwerte (geteilt zwischen Browser und Server)
 * Zweck: Die eine Quelle dafuer, welche Einheit eine Messart fuehrt, was sich
 *        wohin umrechnen laesst und damit auch, was der Server annimmt (#2375).
 *        Eine zweite Liste am Server liefe nicht bei einem Randfall auseinander,
 *        sondern bei der naechsten Einheit: das Diagramm rechnete sie um, und
 *        die API lehnte sie ab - oder umgekehrt.
 * Abhängigkeiten: keine (isomorph, freigegeben in test/test-layer-boundary.js).
 */

/**
 * Die im Dialog waehlbaren Einheiten je Messart (`metric.units`); die erste ist
 * der Default. Stimmung ist eine Stufe und fuehrt keine Einheit.
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

// EINE EINHEIT JE SERIE (#2328): je Messart eine Basis-Einheit und je Einheit
// (klein geschrieben) die Umrechnung dorthin. Temperatur ist nicht proportional
// und traegt deshalb Hin- und Rueckweg. Zwei Schreibweisen derselben Einheit
// teilen sich EIN Objekt: vitalLimitReading() erkennt daran, dass nichts
// umzurechnen ist und die Grenzen der gelisteten Schreibweise gelten.
const linear = (factor) => ({ toBase: (v) => v * factor, fromBase: (v) => v / factor });
const POUND = linear(0.45359237);
const CELSIUS = linear(1);
const FAHRENHEIT = { toBase: (v) => (v - 32) * 5 / 9, fromBase: (v) => v * 9 / 5 + 32 };
const LENGTH_UNITS = { cm: linear(1), mm: linear(0.1), m: linear(100), in: linear(2.54) };
const UNIT_CONVERSIONS = Object.freeze({
  // 1 stone = 14 lb.
  weight: { kg: linear(1), g: linear(0.001), lb: POUND, lbs: POUND, stone: linear(0.45359237 * 14) },
  height: LENGTH_UNITS,
  head_circumference: LENGTH_UNITS,
  // 1 mmol/L Glukose = 18,0182 mg/dL (molare Masse 180,182 g/mol).
  glucose: { 'mg/dl': linear(1), 'mmol/l': linear(18.0182) },
  temp: { '°c': CELSIUS, c: CELSIUS, '°f': FAHRENHEIT, f: FAHRENHEIT },
});

// `type` und `unit` kommen frei vom Client: nur EIGENE Schluessel zaehlen, sonst
// findet "constructor" eine geerbte Eigenschaft (Review #2049).
const ownEntry = (table, key) => (table && key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
const fold = (unit) => String(unit).trim().toLowerCase();

/** Die Umrechnung einer Einheit dieser Messart, Schreibweise egal. */
function unitConversion(type, unit) {
  if (unit === null || unit === undefined) return undefined;
  return ownEntry(ownEntry(UNIT_CONVERSIONS, type), fold(unit));
}

/** Kennt die Umrechnung diese Einheit? Sonst bleibt der Wert stehen, wie er ist. */
export function isConvertibleVitalUnit(type, unit) {
  return Boolean(unitConversion(type, unit));
}

/**
 * Rechnet einen Wert zwischen zwei Einheiten derselben Messart um. Ohne
 * bekannte Umrechnung (fremde Einheit, Einheit fehlt) kommt der Wert
 * unveraendert zurueck - raten waere schlimmer als stehen lassen.
 */
export function convertVitalValue(type, value, fromUnit, toUnit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const from = unitConversion(type, fromUnit);
  const to = unitConversion(type, toUnit);
  if (!from || !to || from === to) return value;
  // Auf 1e-6 gerundet: 95400 * 0,001 ist sonst 95,39999999999999.
  return Math.round(to.fromBase(from.toBase(value)) * 1e6) / 1e6;
}

/**
 * Was der Server fuer diese Messart annimmt: die gelisteten Einheiten plus alles,
 * was die Umrechnung kennt. null heisst: Typ ohne Metrik, also keine Liste
 * (`type` ist freier Text). Verglichen wird wie bei der Umrechnung, ohne Ruecksicht
 * auf Gross-/Kleinschreibung - sonst haette "KG" im Diagramm einen Platz und an
 * der API keinen.
 */
export function acceptedVitalUnits(type) {
  const listed = ownEntry(VITAL_UNITS, type);
  if (!listed) return null;
  const known = new Set(listed.map(fold));
  const more = Object.keys(ownEntry(UNIT_CONVERSIONS, type) ?? {}).filter((u) => !known.has(u));
  return [...listed, ...more];
}

/** Nimmt der Server diese Einheit fuer diese Messart an? */
export function isAcceptedVitalUnit(type, unit) {
  const accepted = acceptedVitalUnits(type);
  return !accepted || accepted.some((u) => fold(u) === fold(unit));
}

/**
 * Der Wert in der gelisteten Einheit, gegen die die harten Grenzen stehen:
 * "LB" und "lbs" sind `lb`, ohne Rechnung; "g" und "stone" haben keine eigenen
 * Grenzen und werden in die erste Einheit der Messart umgerechnet. Eine Einheit,
 * die niemand kennt (Altzeile), kommt unveraendert zurueck und findet keine Grenze.
 *
 * @returns {{unit: string|null|undefined, value: number|null|undefined}}
 */
export function vitalLimitReading(type, unit, value) {
  const listed = ownEntry(VITAL_UNITS, type);
  if (!listed || unit === null || unit === undefined) return { unit, value };
  const same = listed.find((u) => fold(u) === fold(unit));
  if (same) return { unit: same, value };
  const conversion = unitConversion(type, unit);
  if (!conversion) return { unit, value };
  const twin = listed.find((u) => unitConversion(type, u) === conversion);
  return twin ? { unit: twin, value } : { unit: listed[0], value: convertVitalValue(type, value, unit, listed[0]) };
}
