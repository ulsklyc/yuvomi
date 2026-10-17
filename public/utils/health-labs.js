/**
 * Modul: Laborwerte-Logik (Health)
 * Zweck: Reine, DOM-freie Kernfunktionen für den Laborwerte-Tab — Referenz-Flag-
 *        Ableitung fürs Vorschau-UI (deriveFlag, spiegelt die Server-Ableitung),
 *        Befund-Kennzahlen (summarizeReport: Analyten-Anzahl + Auffälligkeiten),
 *        distinkte Analyt-Namen (analyteNames) und der chronologische Werteverlauf
 *        eines wiederkehrenden Analyten über mehrere Befunde (analyteTrend, fürs
 *        SVG-Chart). Analog zu health-vitals.js/health-meds.js bewusst OHNE
 *        i18n/DOM, damit die Funktionen in Node ohne Browser-Umgebung testbar sind.
 * Abhängigkeiten: keine (nur String-/Zahl-Logik; date.js-Helfer nicht nötig,
 *        da Befunde bereits YYYY-MM-DD-Datumsschlüssel tragen).
 */

/** Wandelt einen Wert in eine endliche Zahl oder null. */
function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Datums-Anteil (YYYY-MM-DD) eines report_date ohne UTC-Shift. */
function dateKeyOf(date) {
  return String(date ?? '').slice(0, 10);
}

// Referenz-Flags in fester Reihenfolge; identisch zur Server-Ableitung.
export const LAB_FLAGS = Object.freeze(['low', 'normal', 'high']);

/**
 * Leitet ein Referenz-Flag (low|normal|high) aus Wert + Referenzbereich ab.
 * Spiegelt die serverseitige Ableitung (server/routes/health.js) für die
 * Vorschau im Erfassungs-UI — der Server bleibt die maßgebliche Quelle.
 *
 * - Wert unter ref_low            → 'low'
 * - Wert über ref_high            → 'high'
 * - innerhalb / eine Grenze da    → 'normal'
 * - keine Grenze gesetzt / kein Wert → null (kein Flag)
 *
 * @param {number|string|null} value
 * @param {number|string|null} refLow
 * @param {number|string|null} refHigh
 * @returns {'low'|'normal'|'high'|null}
 */
export function deriveFlag(value, refLow, refHigh) {
  const v = toFiniteOrNull(value);
  if (v === null) return null;
  const low = toFiniteOrNull(refLow);
  const high = toFiniteOrNull(refHigh);
  if (low !== null && v < low) return 'low';
  if (high !== null && v > high) return 'high';
  if (low !== null || high !== null) return 'normal';
  return null;
}

/**
 * Kennzahlen eines Befunds: Anzahl Analyten + Anzahl Auffälligkeiten.
 * Auffällig = flag gesetzt und ungleich 'normal' (also 'low' oder 'high').
 *
 * @param {Object} report - Befund mit results[] (analyte, flag, …).
 * @returns {{ total:number, abnormal:number, hasAbnormal:boolean }}
 */
export function summarizeReport(report) {
  const results = report && Array.isArray(report.results) ? report.results : [];
  const total = results.length;
  const abnormal = results.filter((r) => r && r.flag && r.flag !== 'normal').length;
  return { total, abnormal, hasAbnormal: abnormal > 0 };
}

/**
 * Distinkte Analyt-Namen über alle Befunde, in Erst-Auftreten-Reihenfolge.
 * Vergleich case-insensitiv; zurückgegeben wird die zuerst gesehene Schreibweise.
 *
 * @param {Array<Object>} reports - Befunde mit results[].
 * @returns {string[]}
 */
export function analyteNames(reports) {
  const seen = new Map(); // lowercase → Original-Schreibweise (erstes Auftreten)
  const list = Array.isArray(reports) ? reports : [];
  for (const rep of list) {
    const results = rep && Array.isArray(rep.results) ? rep.results : [];
    for (const r of results) {
      const raw = r && r.analyte != null ? String(r.analyte).trim() : '';
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (!seen.has(key)) seen.set(key, raw);
    }
  }
  return [...seen.values()];
}

/**
 * Chronologischer Werteverlauf eines Analyten über mehrere Befunde (fürs Chart).
 * Matcht den Analyt-Namen case-insensitiv, übernimmt nur Befunde mit endlichem
 * Wert und sortiert aufsteigend nach report_date (bei Gleichstand nach id).
 *
 * @param {Array<Object>} reports    - Befunde mit report_date, id, results[].
 * @param {string} analyteName       - gesuchter Analyt (case-insensitiv).
 * @returns {Array<{ reportId:number|null, date:string, value:number,
 *                   unit:string|null, flag:string|null,
 *                   refLow:number|null, refHigh:number|null }>}
 */
export function analyteTrend(reports, analyteName) {
  const name = String(analyteName ?? '').trim().toLowerCase();
  if (!name) return [];
  const list = Array.isArray(reports) ? reports : [];
  const points = [];

  for (const rep of list) {
    if (!rep) continue;
    const results = Array.isArray(rep.results) ? rep.results : [];
    const match = results.find(
      (r) => r && String(r.analyte ?? '').trim().toLowerCase() === name
    );
    if (!match) continue;
    const value = toFiniteOrNull(match.value_num);
    if (value === null) continue;
    points.push({
      reportId: rep.id ?? null,
      date: dateKeyOf(rep.report_date),
      value,
      unit: match.unit ?? null,
      flag: match.flag ?? null,
      refLow: toFiniteOrNull(match.ref_low),
      refHigh: toFiniteOrNull(match.ref_high),
    });
  }

  points.sort((a, b) => {
    if (a.date === b.date) return (a.reportId || 0) - (b.reportId || 0);
    return a.date < b.date ? -1 : 1;
  });
  return points;
}

/**
 * Der Analyt, dessen Verlauf der Tab zuerst zeigt (R20, Re-Critique
 * 2026-10-17 a5 P2-6). Bis R20 war es schlicht der erste Name der Liste -
 * im Demo-Haushalt Ferritin, waehrend im neuesten Befund Vitamin D auffaellig
 * war, genau der Wert, nach dem man schaut. Jetzt in dieser Reihenfolge:
 *   1. ein auffaelliger Wert des neuesten Befunds mit mindestens zwei Punkten
 *      (ein Verlauf, der etwas zeigt),
 *   2. ein auffaelliger Wert des neuesten Befunds,
 *   3. der erste Analyt mit mindestens zwei Punkten,
 *   4. der erste Name.
 * "Neuester Befund" ist der mit dem spaetesten report_date (bei Gleichstand
 * die hoehere id) - die Reihenfolge der Liste ist Sache der Anzeige.
 *
 * @param {Array<Object>} reports
 * @returns {string|null}
 */
export function defaultTrendAnalyte(reports) {
  const names = analyteNames(reports);
  if (names.length === 0) return null;
  const list = (Array.isArray(reports) ? reports : []).filter(Boolean);
  const latest = list.reduce((best, rep) => {
    if (!best) return rep;
    const a = dateKeyOf(rep.report_date);
    const b = dateKeyOf(best.report_date);
    if (a !== b) return a > b ? rep : best;
    return (rep.id || 0) > (best.id || 0) ? rep : best;
  }, null);
  const canonical = (raw) => names.find((n) => n.toLowerCase() === String(raw ?? '').trim().toLowerCase()) ?? null;
  const abnormal = (latest && Array.isArray(latest.results) ? latest.results : [])
    .filter((r) => r && r.flag && r.flag !== 'normal')
    .map((r) => canonical(r.analyte))
    .filter(Boolean);
  const hasTrend = (name) => analyteTrend(list, name).length >= 2;
  return abnormal.find(hasTrend) ?? abnormal[0] ?? names.find(hasTrend) ?? names[0];
}
