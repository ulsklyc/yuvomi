/**
 * Modul: Aktivitäts-Aggregation (Health)
 * Zweck: Reine, DOM-freie Logik für den Aktivität-Tab — Preset-Definitionen
 *        (ACTIVITY_TYPES: Trainingsarten mit labelKey + Lucide-Icon) plus zwei
 *        testbare Kernfunktionen: weekSummary() bucketet Trainingseinheiten in
 *        7 Tages-Buckets (Mo–So) mit Dauer-Summe je Tag (fürs SVG-Balken-Chart)
 *        und liefert den Zeitraum (from/to); activityTotals() summiert
 *        Anzahl/Dauer/Distanz/Kalorien über eine Einheiten-Liste (fürs
 *        Summen-Karten-Grid). Buckets-/Datums-Logik spiegelt buildVitalBuckets
 *        (health-vitals.js).
 * Abhängigkeiten: /utils/date.js (ebenfalls DOM-frei) — bewusst KEINE i18n/DOM,
 *        damit die Funktionen in Node ohne Browser-Umgebung getestet werden.
 */

import { addLocalDays, parseLocalDateKey, startOfLocalWeekKey, todayKey } from '/utils/date.js';
import { isRollingAnchor, stepVitalAnchor } from '/utils/health-vitals.js';

// --------------------------------------------------------
// Preset-Definitionen (Trainingsarten)
// --------------------------------------------------------
// `value` wird als type in der DB gespeichert (stabiler Schlüssel, kein
// lokalisierter Text); die Freitext-Option speichert stattdessen den rohen
// Eingabetext. `labelKey` liefert das lokalisierte Label, `icon` das Lucide-
// Icon. Reihenfolge = Anzeige-Reihenfolge im Auswahl-Menü.
export const ACTIVITY_TYPES = Object.freeze([
  { value: 'running',  labelKey: 'health.activity.type.running',  icon: 'footprints' },
  { value: 'cycling',  labelKey: 'health.activity.type.cycling',  icon: 'bike' },
  { value: 'swimming', labelKey: 'health.activity.type.swimming', icon: 'waves' },
  { value: 'strength', labelKey: 'health.activity.type.strength', icon: 'dumbbell' },
  { value: 'yoga',     labelKey: 'health.activity.type.yoga',     icon: 'flower' },
  { value: 'walking',  labelKey: 'health.activity.type.walking',  icon: 'move' },
  { value: 'other',    labelKey: 'health.activity.type.other',    icon: 'activity' },
]);

export const ACTIVITY_TYPE_VALUES = Object.freeze(ACTIVITY_TYPES.map((a) => a.value));

/** Preset-Definition zu einem type-Wert oder null (Freitext-Typ). */
export function activityType(value) {
  return ACTIVITY_TYPES.find((a) => a.value === value) || null;
}

/** Datums-Anteil (YYYY-MM-DD) eines performed_at-Zeitstempels ohne UTC-Shift. */
function dateKeyOf(performedAt) {
  return String(performedAt ?? '').slice(0, 10);
}

function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bucketet Trainingseinheiten in 7 Tages-Buckets mit Dauer-Summe je Tag.
 * Einheiten außerhalb des Fensters werden ignoriert. Spiegelt die Wochen-Logik
 * von buildVitalBuckets (health-vitals.js):
 *
 * DIE LAUFENDE WOCHE IST GLEITEND (Critique 2026-10-05, R16). Am Montag war
 * die Kalenderwoche leer, waehrend die Bereichsliste den Lauf vom Sonntag
 * meldete. Liegt heute in der Woche des Ankers, sind es die letzten 7 Tage,
 * endend heute; zurueckgeblaettert bleibt es die Kalenderwoche ab
 * `weekStartsOn`. Jeder Bucket nennt deshalb seinen `weekday` (0 = Montag) -
 * die Spalten beginnen nicht mehr immer am Wochenanfang.
 *
 * @param {Array<Object>} activities - Einheiten mit performed_at + duration_min.
 * @param {Object} opts
 * @param {string} [opts.anchor]        - Anker-Datum (YYYY-MM-DD) in der Woche.
 * @param {number} [opts.weekStartsOn=1]
 * @param {string} [opts.today]         - nur fuer Tests; sonst `todayKey()`.
 * @returns {{ buckets: Array<{ key:string, date:string, index:number, weekday:number,
 *             durationMin:number, count:number }>, from:string, to:string }}
 */
export function weekSummary(activities, opts = {}) {
  const { anchor, weekStartsOn = 1, today = todayKey() } = opts;
  // Ein Anker hinter heute in der laufenden Woche meint die Kalenderwoche
  // (isRollingAnchor): dorthin springt die Seite nach dem Speichern einer
  // Einheit mit Datum in der Zukunft, und dorthin fuehrt "Weiter".
  const start = isRollingAnchor('week', anchor, weekStartsOn, { today })
    ? addLocalDays(today, -6)
    : startOfLocalWeekKey(anchor || today, weekStartsOn);

  const buckets = [];
  const index = new Map();
  for (let i = 0; i < 7; i++) {
    const d = addLocalDays(start, i);
    // getDay(): 0 = Sonntag. Auf 0 = Montag gedreht, wie die Label-Liste der Seite.
    const weekday = (parseLocalDateKey(d).getDay() + 6) % 7;
    buckets.push({ key: d, date: d, index: i, weekday, durationMin: 0, count: 0 });
    index.set(d, i);
  }
  const from = start;
  const to = buckets[6].date;

  const list = Array.isArray(activities) ? activities : [];
  for (const a of list) {
    if (!a) continue;
    const i = index.get(dateKeyOf(a.performed_at));
    if (i === undefined) continue;
    const dur = toFiniteOrNull(a.duration_min);
    if (dur !== null) buckets[i].durationMin += dur;
    buckets[i].count += 1;
  }

  return { buckets, from, to };
}

/**
 * Blaettert die Aktivitaetswoche: dieselbe lueckenlose Folge wie die
 * Vitalwerte (stepVitalAnchor) - vorige Kalenderwoche, gleitend bis heute,
 * laufende Kalenderwoche, naechste Kalenderwoche.
 */
export function stepActivityAnchor(anchorKey, dir, weekStartsOn = 1, opts = {}) {
  return stepVitalAnchor('week', anchorKey, dir, weekStartsOn, opts);
}

/**
 * Summiert Anzahl/Dauer/Distanz/Kalorien über eine Einheiten-Liste. Fehlende
 * oder ungültige Zahlenfelder werden übersprungen; count zählt jede Einheit.
 *
 * @param {Array<Object>} activities - Einheiten mit duration_min/distance_km/calories.
 * @returns {{ count:number, durationMin:number, distanceKm:number, calories:number }}
 */
export function activityTotals(activities) {
  const list = Array.isArray(activities) ? activities : [];
  let count = 0;
  let durationMin = 0;
  let distanceKm = 0;
  let calories = 0;
  for (const a of list) {
    if (!a) continue;
    count += 1;
    const dur = toFiniteOrNull(a.duration_min);
    if (dur !== null) durationMin += dur;
    const dist = toFiniteOrNull(a.distance_km);
    if (dist !== null) distanceKm += dist;
    const cal = toFiniteOrNull(a.calories);
    if (cal !== null) calories += cal;
  }
  return { count, durationMin, distanceKm, calories };
}
