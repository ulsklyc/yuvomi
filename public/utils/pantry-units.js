/**
 * Modul: Vorrats-Einheiten (Pantry units)
 * Zweck: Kanonische Mengeneinheiten und Mengen-Normalisierung, geteilt zwischen
 *        Router-Validierung und Formular.
 * Abhängigkeiten: keine
 *
 * Isomorph und bewusst importfrei: der Vorrats-Router importiert diese Datei
 * direkt (Eintrag in der SHARED_ISOMORPHIC-Allowlist von test-layer-boundary.js).
 * Eine Einheit, die hier fehlt, existiert für beide Schichten nicht - genau das
 * ist der Punkt, denn ein CHECK-Constraint wäre in SQLite ein Tabellen-Rebuild.
 */

export const PANTRY_UNITS = Object.freeze([
  'pcs', 'g', 'kg', 'ml', 'l', 'pkg', 'can', 'bottle', 'jar', 'bag',
]);

export const DEFAULT_PANTRY_UNIT = 'pcs';

/**
 * Schrittweite des ±-Steppers je Einheit. Ohne sie wäre "+1" bei Mehl ein
 * ganzes Kilo und bei Zucker ein einzelnes Gramm - beides unbrauchbar.
 * Zählbares geht in Einerschritten, Gewicht und Volumen in Haushaltsportionen.
 */
export const PANTRY_UNIT_STEP = Object.freeze({
  pcs: 1, g: 100, kg: 0.5, ml: 100, l: 0.5,
  pkg: 1, can: 1, bottle: 1, jar: 1, bag: 1,
});

/** Schrittweite einer Einheit; unbekannte Einheiten schreiten um 1. */
export function pantryUnitStep(unit) {
  return PANTRY_UNIT_STEP[normalizePantryUnit(unit)] ?? 1;
}

/** Obergrenze der Menge. Verhindert, dass ein Tippfehler die Zeile sprengt. */
export const MAX_PANTRY_QUANTITY = 1_000_000;

const UNIT_SET = new Set(PANTRY_UNITS);

/**
 * Unbekannte oder leere Einheit → Default. Bewusst kein Fehler: die Einheit ist
 * Beiwerk der Menge, ein 400 dafür würde ein Speichern blockieren, dessen
 * eigentliche Nutzlast (Name + Menge) in Ordnung ist.
 * @param {any} value
 * @returns {string}
 */
export function normalizePantryUnit(value) {
  const key = String(value ?? '').trim();
  return UNIT_SET.has(key) ? key : DEFAULT_PANTRY_UNIT;
}

/**
 * Menge auf zwei Nachkommastellen runden, auf [0, MAX_PANTRY_QUANTITY] klemmen.
 * Ohne das Runden schreibt der ±-Stepper Fließkomma-Artefakte in die DB
 * (0.1 + 0.2 = 0.30000000000000004) und die Zeile zeigt sie an.
 * @param {any} value
 * @param {{ fallback?: number }} [opts]
 * @returns {number}
 */
export function normalizePantryQuantity(value, { fallback = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_PANTRY_QUANTITY, Math.max(0, Math.round(n * 100) / 100));
}

/**
 * Menge mit Einheit fuer die Anzeige: „6 Dosen", „1 Dose", „1,5 kg".
 *
 * DIE EINHEIT FLEKTIERT MIT DER MENGE (Re-Critique 2026-09-27, W2). Hier gab
 * es keinen geteilten Helfer; Vorrat und Uebersicht setzten je den Einheitennamen
 * hinter die Zahl, und das ist der Singular - „6 Dose", „3 Packung". Die Locale
 * traegt dafuer `pantry.units.<unit>_one|_two|_few|_many|_other`; t() waehlt die
 * Kategorie ueber Intl.PluralRules, also auch Bruchzahlen richtig („1,5 Dosen",
 * im Polnischen „1,5 puszki"). Der Basisschluessel bleibt der Name der Einheit,
 * den das Auswahlfeld ohne Menge zeigt.
 *
 * `t` und `formatNumber` kommen vom Aufrufer, damit diese Datei importfrei und
 * damit fuer den Server ladbar bleibt (siehe Dateikopf).
 *
 * @param {number|string} quantity
 * @param {string} unit
 * @param {{ t: (key: string, params?: object) => string, formatNumber: (n: number) => string }} deps
 * @returns {string}
 */
export function pantryQuantityLabel(quantity, unit, { t, formatNumber }) {
  const amount = Number(quantity) || 0;
  const key = `pantry.units.${unit}`;
  const label = t(key, { count: amount });
  // Rueckfall auf den Rohwert: eine Einheit ohne Locale-Key (Fremdimport,
  // direkter DB-Zugriff) stuende sonst als nackter Schluessel in der Zeile.
  return `${formatNumber(amount)} ${label === key ? String(unit ?? '') : label}`;
}
