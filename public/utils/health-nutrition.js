/**
 * Modul: Gesundheit - Naehrwerte (reine Logik)
 * Zweck: Die acht Naehrwerte mit ihren Beschriftungen und Einheiten, und die
 *        eine Rechnung "wie weit ist der Tag gegen das Ziel". Ohne DOM, ohne
 *        `window.yuvomi` - damit die Zusicherung darueber an einer echten
 *        Modulgrenze haengt und nicht am `__test`-Export der Seite (dieselbe
 *        Begruendung wie bei utils/dashboard-widgets.js).
 * Abhaengigkeiten: keine
 *
 * DIE REIHENFOLGE IST DIE DER PACKUNG: Energie, Fett, davon gesaettigte
 * Fettsaeuren, Kohlenhydrate, davon Zucker, Eiweiss, Salz, Ballaststoffe. Wer
 * seine Werte abtippt, liest sie in genau dieser Folge ab - ein Formular in
 * einer anderen Reihenfolge waere ein Suchspiel je Zeile. Dieselbe Folge
 * verwenden Migration 223, die CSV-Kopfzeile und die Kachel.
 */

/**
 * Die acht: `key` ist der Spaltenname (identisch in DB, API und CSV),
 * `labelKey`/`unitKey` sind i18n-Schluessel, `step` die Schrittweite des
 * Zahlenfeldes.
 *
 * `energy_kcal` und nicht `calories`: die Spalte `health_activities.calories`
 * gibt es schon, und sie meint die VERBRANNTE Energie. Ein Wort fuer beide
 * Richtungen waere ein Fehler, der im Wortschatz wartet.
 */
export const NUTRIENTS = Object.freeze([
  { key: 'energy_kcal',     labelKey: 'health.nutrition.nutrient.energyKcal',   unitKey: 'health.nutrition.unit.kcal', step: 1    },
  { key: 'fat_g',           labelKey: 'health.nutrition.nutrient.fat',          unitKey: 'health.nutrition.unit.g',    step: 0.1  },
  { key: 'saturated_fat_g', labelKey: 'health.nutrition.nutrient.saturatedFat', unitKey: 'health.nutrition.unit.g',    step: 0.1  },
  { key: 'carbs_g',         labelKey: 'health.nutrition.nutrient.carbs',        unitKey: 'health.nutrition.unit.g',    step: 0.1  },
  { key: 'sugar_g',         labelKey: 'health.nutrition.nutrient.sugar',        unitKey: 'health.nutrition.unit.g',    step: 0.1  },
  { key: 'protein_g',       labelKey: 'health.nutrition.nutrient.protein',      unitKey: 'health.nutrition.unit.g',    step: 0.1  },
  { key: 'salt_g',          labelKey: 'health.nutrition.nutrient.salt',         unitKey: 'health.nutrition.unit.g',    step: 0.01 },
  { key: 'fiber_g',         labelKey: 'health.nutrition.nutrient.fiber',        unitKey: 'health.nutrition.unit.g',    step: 0.1  },
]);

/** Nur die Schluessel, fuer Schleifen ueber ein API-Objekt. */
export const NUTRIENT_KEYS = Object.freeze(NUTRIENTS.map((n) => n.key));

/** Die Mahlzeitenarten in der Reihenfolge des Tages. */
export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * Wie weit ist `value` gegen `target`?
 *
 * DREI ANTWORTEN, NICHT ZWEI, und der Unterschied ist der Grund, aus dem diese
 * Funktion existiert:
 *   - `target === null`   -> `{ hasTarget: false }`: niemand hat ein Ziel
 *                            gesetzt. Die Anzeige sagt das, statt "0 von 0".
 *   - `target === 0`      -> `{ hasTarget: true, ratio: … }`: ein
 *                            ausdrueckliches Ziel von null. Jeder Wert darueber
 *                            ist eine Ueberschreitung, und 0 ist erreicht.
 *   - `target > 0`        -> der gewoehnliche Anteil.
 *
 * Wer `target` mit `if (!target)` prueft, wirft die ersten beiden Faelle
 * zusammen - genau davor steht diese Funktion.
 *
 * @param {number} value
 * @param {number|null|undefined} target
 * @returns {{ hasTarget: boolean, ratio: number, over: boolean }}
 */
export function nutrientProgress(value, target) {
  if (target === null || target === undefined) return { hasTarget: false, ratio: 0, over: false };
  const current = Number(value) || 0;
  const goal = Number(target);
  // Ein Ziel von 0 hat keinen Anteil, den man teilen koennte - die Division
  // waere Infinity oder NaN. Erreicht ist es bei genau 0, ueberschritten bei
  // allem darueber; der Balken ist damit entweder leer oder voll.
  if (goal === 0) return { hasTarget: true, ratio: current > 0 ? 1 : 0, over: current > 0 };
  const ratio = current / goal;
  return { hasTarget: true, ratio: Math.max(0, Math.min(1, ratio)), over: ratio > 1 };
}
