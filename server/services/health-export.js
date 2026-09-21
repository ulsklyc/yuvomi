/**
 * Modul: Gesundheits-CSV-Export (Health)
 * Zweck: Reine, testbare CSV-Serialisierung für den Übersicht-Export je Bereich
 *        (Vitalwerte, Aktivitäten, Laborwerte, Medikamenten-Logs). Bekommt bereits
 *        gescopte/gefilterte DB-Zeilen und erzeugt daraus die CSV-Nutzlast; das
 *        HTTP-Handling (Header, BOM, Range-/Visibility-Filter) bleibt in der Route.
 *        Spaltenüberschriften sind bewusst sprachneutrale Maschinen-Header (wie der
 *        Budget-Export) — der Export ist für den Arztbesuch/Import gedacht.
 * Abhängigkeiten: keine (nur String-Operationen) — überall importierbar/testbar.
 */

/**
 * Serialisiert einen einzelnen CSV-Wert: doppelte Anführungszeichen verdoppeln,
 * das Ganze quoten und Formel-Injection (=,+,-,@,Tab,CR am Zeilenanfang) mit einem
 * führenden Apostroph entschärfen. Spiegelt csvSafe im Budget-Export.
 */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s}"`;
}

/**
 * Baut eine CSV-Nutzlast aus Header-Array und Zeilen-Arrays (jede Zelle über
 * csvCell). Ohne Zeilen wird nur der Header zurückgegeben. Kein BOM — das setzt
 * die Route (Excel-Kompatibilität).
 */
export function toCsv(header, rows) {
  const head = (header || []).map(csvCell).join(',');
  const body = (rows || []).map((r) => (r || []).map(csvCell).join(',')).join('\n');
  return body ? `${head}\n${body}` : head;
}

const VITALS_HEADER = ['measured_at', 'type', 'value_num', 'value_num2', 'value_num3', 'unit', 'note', 'visibility'];
const ACTIVITIES_HEADER = ['performed_at', 'type', 'duration_min', 'distance_km', 'intensity', 'calories', 'note', 'visibility'];
const LABS_HEADER = ['report_date', 'lab_name', 'analyte', 'value_num', 'unit', 'ref_low', 'ref_high', 'flag', 'visibility', 'note'];
const MED_LOGS_HEADER = ['scheduled_at', 'medication', 'status', 'taken_at', 'dose_qty', 'note'];
const CYCLE_HEADER = ['start_date', 'end_date', 'period_length_days', 'cycle_length_days', 'note', 'visibility'];
// Die acht Naehrwerte tragen ihre Einheit im Spaltennamen, und `energy_kcal`
// heisst nicht `calories`: diese Datei fuehrt ACTIVITIES_HEADER mit genau
// dieser Spalte, und dort ist es die VERBRANNTE Energie. Ein Wort fuer beide
// Richtungen faellt zuerst hier auf - wer beide Auszuege nebeneinanderlegt,
// haette zweimal `calories` mit entgegengesetzter Bedeutung.
const NUTRITION_HEADER = [
  'consumed_at', 'meal_type', 'title',
  'energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugar_g', 'protein_g', 'salt_g', 'fiber_g',
  'note', 'visibility',
];

/** Inklusive Tagesdifferenz zweier YYYY-MM-DD-Schlüssel (b − a), sonst ''. */
function daySpan(aKey, bKey, inclusive = false) {
  if (!aKey || !bKey) return '';
  const a = Date.parse(`${String(aKey).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(bKey).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return '';
  return Math.round((b - a) / 86400000) + (inclusive ? 1 : 0);
}

/** Vitalwerte-Zeilen → CSV. */
export function vitalsToCsv(rows) {
  return toCsv(VITALS_HEADER, (rows || []).map((r) => VITALS_HEADER.map((k) => r[k])));
}

/** Aktivitäts-Zeilen → CSV. */
export function activitiesToCsv(rows) {
  return toCsv(ACTIVITIES_HEADER, (rows || []).map((r) => ACTIVITIES_HEADER.map((k) => r[k])));
}

/**
 * Laborbefunde → CSV. Jeder Analyt wird zu einer eigenen Zeile (Befund-Kopf pro
 * Analyt wiederholt); Befunde ganz ohne Analyten erscheinen als Kopfzeile.
 * @param {Array<Object>} reports - Befunde mit `results`-Array.
 */
export function labsToCsv(reports) {
  const rows = [];
  for (const report of (reports || [])) {
    const results = Array.isArray(report.results) ? report.results : [];
    if (!results.length) {
      rows.push([report.report_date, report.lab_name, '', '', '', '', '', '', report.visibility, report.note]);
      continue;
    }
    for (const r of results) {
      rows.push([
        report.report_date, report.lab_name, r.analyte, r.value_num, r.unit,
        r.ref_low, r.ref_high, r.flag, report.visibility, report.note,
      ]);
    }
  }
  return toCsv(LABS_HEADER, rows);
}

/**
 * Medikamenten-Dosis-Logs → CSV.
 * @param {Array<Object>} logs - Log-Zeilen mit `medication_name`.
 */
export function medLogsToCsv(logs) {
  return toCsv(MED_LOGS_HEADER, (logs || []).map((l) => [
    l.scheduled_at, l.medication_name, l.status, l.taken_at, l.dose_qty, l.note,
  ]));
}

/**
 * Naehrwert-Eintraege → CSV.
 *
 * Ein nicht angegebener Wert bleibt LEER und wird nicht zu 0: die Zelle sagt
 * damit "nicht angegeben", so wie die Spalte es speichert. Eine 0 dort waere
 * die Behauptung, die Mahlzeit habe nichts davon enthalten - und genau die
 * Verwechslung ist der Grund, aus dem die Spalten nullbar sind.
 */
export function nutritionToCsv(rows) {
  return toCsv(NUTRITION_HEADER, (rows || []).map((r) => NUTRITION_HEADER.map((k) => r[k])));
}

/**
 * Perioden-Episoden → CSV. Erwartet chronologisch aufsteigende Zeilen (älteste
 * zuerst), damit die Zykluslänge = Abstand zum jeweils nächsten Periodenstart
 * berechnet werden kann; die letzte (jüngste) Periode hat keine Folge-Periode und
 * bleibt in der Zykluslänge leer.
 * @param {Array<Object>} periods - Zeilen mit start_date/end_date/note/visibility.
 */
export function cycleToCsv(periods) {
  const list = periods || [];
  const rows = list.map((p, i) => {
    const next = list[i + 1];
    return [
      p.start_date,
      p.end_date || '',
      p.end_date ? daySpan(p.start_date, p.end_date, true) : '',
      next ? daySpan(p.start_date, next.start_date) : '',
      p.note,
      p.visibility,
    ];
  });
  return toCsv(CYCLE_HEADER, rows);
}

export const HEALTH_EXPORT_HEADERS = Object.freeze({
  vitals: VITALS_HEADER,
  activities: ACTIVITIES_HEADER,
  labs: LABS_HEADER,
  medLogs: MED_LOGS_HEADER,
  cycle: CYCLE_HEADER,
  nutrition: NUTRITION_HEADER,
});
