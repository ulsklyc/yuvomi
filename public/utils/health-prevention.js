/**
 * Modul: Vorsorge - Intervall-Eingabe (Monate/Jahre)
 * Zweck: Die zwei Formulare, die ein Intervall abfragen (Typ-Register in
 *        Einstellungen, der Datensatz-Override im Prevention-Tab), lassen den
 *        Haushalt in Monaten ODER Jahren eintippen - gespeichert wird immer in
 *        Monaten (health_prevention_types.default_interval_months,
 *        health_prevention_records.interval_months), wie es der Server schon
 *        erwartet. Eine Umrechnung hier, keine zweite Kopie je Formular.
 * Abhängigkeiten: keine.
 */

/**
 * Monate -> die freundlichste Eingabe-Darstellung: ein glattes Vielfaches von
 * 12 wird als Jahre gezeigt (120 -> "10 Jahre"), alles andere bleibt in
 * Monaten (18 -> "18 Monate") statt krumme Bruchjahre zu erzeugen.
 * @param {number|null} months
 * @returns {{ value: number|string, unit: 'months'|'years' }}
 */
export function intervalMonthsToInput(months) {
  if (months == null || months === '') return { value: '', unit: 'months' };
  const n = Number(months);
  if (Number.isFinite(n) && n > 0 && n % 12 === 0) return { value: n / 12, unit: 'years' };
  return { value: n, unit: 'months' };
}

/**
 * Die Formulareingabe zurück in Monate - so, wie der Server es speichert.
 * @param {string|number} value
 * @param {'months'|'years'} unit
 * @returns {number|null} - null = nichts eingegeben, NaN = keine gültige Zahl
 */
export function intervalInputToMonths(value, unit) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return unit === 'years' ? Math.round(n * 12) : Math.round(n);
}
