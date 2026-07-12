/**
 * Modul: Zyklus-Logik (Health)
 * Zweck: Reine, DOM-freie Logik für den Zyklus-Tab — Preset-Definitionen
 *        (Blutungsstärke, Symptome, Stimmung) plus die testbaren Kernfunktionen:
 *        - cycleStats():  Ø Zykluslänge/Periodenlänge + Regelmäßigkeit aus der
 *                         Perioden-Historie.
 *        - predictCycle(): aktueller Zyklustag, Phase, Vorhersage der nächsten
 *                          Periode, des Eisprungs und des fruchtbaren Fensters
 *                          (Kalendermethode: Eisprung ≈ Lutealphase vor der
 *                          nächsten Periode, fruchtbares Fenster = 6 Tage).
 *        - buildCycleCalendar(): Monatsraster mit farbcodierten Phasen je Tag.
 *        - cycleRing(): Segment-Brüche (0..1) für das SVG-Ring-Widget.
 *        Bewusst KEINE i18n/DOM — in Node ohne Browser testbar (labelKeys liefern
 *        die Übersetzung erst im UI).
 * Abhängigkeiten: /utils/date.js (ebenfalls DOM-frei).
 */

import { toLocalDateKey, addLocalDays, startOfLocalWeekKey } from '/utils/date.js';

// --------------------------------------------------------
// Preset-Definitionen
// --------------------------------------------------------
// `value` ist der stabile DB-Schlüssel (kein lokalisierter Text). `rank` ordnet
// die Blutungsstärke für die Farb-/Höhenabstufung im UI.
export const FLOW_LEVELS = Object.freeze([
  { value: 'spotting', labelKey: 'health.cycle.flow.spotting', rank: 1 },
  { value: 'light',    labelKey: 'health.cycle.flow.light',    rank: 2 },
  { value: 'medium',   labelKey: 'health.cycle.flow.medium',   rank: 3 },
  { value: 'heavy',    labelKey: 'health.cycle.flow.heavy',    rank: 4 },
]);

export const FLOW_VALUES = Object.freeze(FLOW_LEVELS.map((f) => f.value));

/** Preset-Definition zu einem Flow-Wert oder null. */
export function flowLevel(value) {
  return FLOW_LEVELS.find((f) => f.value === value) || null;
}

// Symptome (Mehrfachauswahl je Tag). Icon = Lucide-Name.
export const SYMPTOM_TYPES = Object.freeze([
  { value: 'cramps',        labelKey: 'health.cycle.symptom.cramps',        icon: 'zap' },
  { value: 'headache',      labelKey: 'health.cycle.symptom.headache',      icon: 'brain' },
  { value: 'backache',      labelKey: 'health.cycle.symptom.backache',      icon: 'move-vertical' },
  { value: 'bloating',      labelKey: 'health.cycle.symptom.bloating',      icon: 'circle-dot' },
  { value: 'tender_breasts', labelKey: 'health.cycle.symptom.tenderBreasts', icon: 'heart' },
  { value: 'acne',          labelKey: 'health.cycle.symptom.acne',          icon: 'sparkle' },
  { value: 'fatigue',       labelKey: 'health.cycle.symptom.fatigue',       icon: 'battery-low' },
  { value: 'nausea',        labelKey: 'health.cycle.symptom.nausea',        icon: 'thermometer' },
  { value: 'cravings',      labelKey: 'health.cycle.symptom.cravings',      icon: 'cookie' },
  { value: 'insomnia',      labelKey: 'health.cycle.symptom.insomnia',      icon: 'moon' },
]);

export const SYMPTOM_VALUES = Object.freeze(SYMPTOM_TYPES.map((s) => s.value));

/** Preset-Definition zu einem Symptom-Wert oder null (unbekannt/entfernt). */
export function symptomType(value) {
  return SYMPTOM_TYPES.find((s) => s.value === value) || null;
}

// Stimmung (Einfachauswahl je Tag).
export const MOOD_TYPES = Object.freeze([
  { value: 'great',     labelKey: 'health.cycle.mood.great',     icon: 'smile' },
  { value: 'good',      labelKey: 'health.cycle.mood.good',      icon: 'smile-plus' },
  { value: 'neutral',   labelKey: 'health.cycle.mood.neutral',   icon: 'meh' },
  { value: 'sensitive', labelKey: 'health.cycle.mood.sensitive', icon: 'cloud-drizzle' },
  { value: 'sad',       labelKey: 'health.cycle.mood.sad',       icon: 'frown' },
  { value: 'irritable', labelKey: 'health.cycle.mood.irritable', icon: 'flame' },
  { value: 'anxious',   labelKey: 'health.cycle.mood.anxious',   icon: 'wind' },
]);

export const MOOD_VALUES = Object.freeze(MOOD_TYPES.map((m) => m.value));

/** Preset-Definition zu einem Mood-Wert oder null. */
export function moodType(value) {
  return MOOD_TYPES.find((m) => m.value === value) || null;
}

// Phasen-Schlüssel (auch als Teil von i18n-Keys: health.cycle.phase.<key>).
export const PHASE = Object.freeze({
  MENSTRUATION: 'menstruation',
  FOLLICULAR: 'follicular',
  FERTILE: 'fertile',
  OVULATION: 'ovulation',
  LUTEAL: 'luteal',
});

// Voreinstellungen, wenn (noch) keine Historie/Einstellung vorliegt.
const DEFAULT_CYCLE = 28;
const DEFAULT_PERIOD = 5;
const DEFAULT_LUTEAL = 14;
const FERTILE_WINDOW_DAYS = 6; // Eisprungtag + 5 Tage davor
const MAX_HISTORY = 6;         // gleitender Mittelwert über bis zu 6 Zyklen
const GESTATION_DAYS = 280;    // Naegele-Regel: 40 Wochen von der letzten Periode

// --------------------------------------------------------
// Datums-Helfer (YYYY-MM-DD, ohne UTC-Shift-Fallen)
// --------------------------------------------------------

function dayKey(value) {
  return String(value ?? '').slice(0, 10);
}

/** Ganzzahlige Tagesdifferenz b − a (beide YYYY-MM-DD). */
export function daysBetween(aKey, bKey) {
  const a = Date.parse(`${dayKey(aKey)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(bKey)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Zahl oder null — behandelt null/undefined/'' als „nicht gesetzt" (nicht als 0). */
function numOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function mean(nums) {
  const list = nums.filter((n) => Number.isFinite(n));
  if (!list.length) return null;
  return list.reduce((s, n) => s + n, 0) / list.length;
}

// --------------------------------------------------------
// Historie: Sortierung & Kennzahlen
// --------------------------------------------------------

/** Perioden aufsteigend nach Startdatum (älteste zuerst); tolerant ggü. Rohdaten. */
export function sortPeriodsAsc(periods) {
  return [...(periods || [])]
    .filter((p) => p && p.start_date)
    .sort((a, b) => {
      const ka = dayKey(a.start_date);
      const kb = dayKey(b.start_date);
      if (ka === kb) return (a.id || 0) - (b.id || 0);
      return ka < kb ? -1 : 1;
    });
}

/** Abstände (in Tagen) zwischen aufeinanderfolgenden Periodenstarts. */
export function cycleGaps(periods) {
  const asc = sortPeriodsAsc(periods);
  const gaps = [];
  for (let i = 1; i < asc.length; i += 1) {
    const gap = daysBetween(asc[i - 1].start_date, asc[i].start_date);
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  return gaps;
}

/** Periodenlängen (Ende − Start + 1) abgeschlossener Episoden. */
export function periodLengths(periods) {
  return sortPeriodsAsc(periods)
    .filter((p) => p.end_date)
    .map((p) => daysBetween(p.start_date, p.end_date) + 1)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 15);
}

/**
 * Kennzahlen aus der Perioden-Historie. Nutzer-Einstellungen (settings) haben
 * Vorrang vor den abgeleiteten Mittelwerten; fehlt beides, greifen Defaults.
 * @returns {{ count, avgCycle, avgPeriod, lutealLength, minCycle, maxCycle,
 *             variation, regular, trackFertility, source }}
 */
export function cycleStats(periods, settings = {}) {
  const asc = sortPeriodsAsc(periods);
  const gaps = cycleGaps(asc).slice(-MAX_HISTORY);
  const lengths = periodLengths(asc).slice(-MAX_HISTORY);

  const derivedCycle = clampInt(mean(gaps), 15, 60);
  const derivedPeriod = clampInt(mean(lengths), 1, 15);

  // Achtung: Number(null) === 0 (nicht NaN) — NULL/'' erst zu null normalisieren,
  // sonst würde eine leere Einstellung fälschlich auf die Clamp-Untergrenze fallen.
  const settingCycle = clampInt(numOrNull(settings.cycle_length_avg), 15, 60);
  const settingPeriod = clampInt(numOrNull(settings.period_length_avg), 1, 15);
  const luteal = clampInt(numOrNull(settings.luteal_length), 8, 18) ?? DEFAULT_LUTEAL;

  const avgCycle = settingCycle ?? derivedCycle ?? DEFAULT_CYCLE;
  const avgPeriod = settingPeriod ?? derivedPeriod ?? DEFAULT_PERIOD;

  const minCycle = gaps.length ? Math.min(...gaps) : null;
  const maxCycle = gaps.length ? Math.max(...gaps) : null;
  const variation = minCycle != null ? maxCycle - minCycle : null;
  // „Regelmäßig", wenn die Schwankung der letzten Zyklen ≤ 7 Tage liegt.
  const regular = gaps.length >= 2 ? variation <= 7 : null;

  return {
    count: asc.length,
    avgCycle,
    avgPeriod,
    lutealLength: luteal,
    minCycle,
    maxCycle,
    variation,
    regular,
    trackFertility: settings.track_fertility === undefined ? true : !!settings.track_fertility,
    source: settingCycle ? 'settings' : (derivedCycle ? 'history' : 'default'),
  };
}

// --------------------------------------------------------
// Schwangerschaft
// --------------------------------------------------------

/**
 * Schwangerschafts-Status aus den Einstellungen. Ist der Schwangerschafts-Modus
 * aktiv, werden alle Zyklus-Vorhersagen angehalten und stattdessen dieser Status
 * angezeigt. Bei gesetztem Entbindungstermin (errechneter Termin, ET) werden SSW
 * (Schwangerschaftswoche), Trimester und Countdown per Naegele-Regel abgeleitet:
 * die letzte Periode (LMP) liegt 280 Tage vor dem ET.
 *
 * @param {Object} settings   - cycle_settings-Zeile.
 * @param {string} [todayKey] - Referenz-„heute" (YYYY-MM-DD).
 * @returns {{ active, dueDate, hasDue, ... }}
 */
export function pregnancyInfo(settings = {}, todayKey = toLocalDateKey(new Date())) {
  const active = !!(settings.pregnancy_mode === 1 || settings.pregnancy_mode === true);
  const dueRaw = settings.pregnancy_due_date ? dayKey(settings.pregnancy_due_date) : null;
  const hasDue = !!dueRaw && !Number.isNaN(Date.parse(`${dueRaw}T00:00:00Z`));
  const today = dayKey(todayKey);

  if (!active || !hasDue) {
    return { active, dueDate: hasDue ? dueRaw : null, hasDue };
  }

  const lmpDate = addLocalDays(dueRaw, -GESTATION_DAYS);
  const daysUntilDue = daysBetween(today, dueRaw);
  // Gestationsalter: Tage seit LMP (auf [0, GESTATION_DAYS] geklemmt für die Anzeige).
  const gestationalDays = Math.max(0, Math.min(GESTATION_DAYS, GESTATION_DAYS - daysUntilDue));
  const gestWeeks = Math.floor(gestationalDays / 7);
  const gestDays = gestationalDays % 7;
  // Trimester: 1 = SSW 0–13, 2 = SSW 14–27, 3 = ab SSW 28.
  const trimester = gestWeeks < 14 ? 1 : (gestWeeks < 28 ? 2 : 3);
  const overdue = daysUntilDue < 0;

  return {
    active,
    dueDate: dueRaw,
    hasDue,
    lmpDate,
    daysUntilDue,
    gestationalDays,
    gestWeeks,
    gestDays,
    trimester,
    overdue,
    progress: Math.max(0, Math.min(1, gestationalDays / GESTATION_DAYS)),
  };
}

// --------------------------------------------------------
// Vorhersage
// --------------------------------------------------------

/**
 * Leitet den aktuellen Zyklusstand + die Vorhersagen ab.
 * Kalendermethode: Eisprung = nächster Periodenstart − Lutealphase; fruchtbares
 * Fenster = Eisprungtag und die 5 Tage davor. Rein statistische Schätzung.
 *
 * @param {Array<Object>} periods - Perioden-Historie (start_date/end_date).
 * @param {Object} settings       - cycle_settings-Zeile (kann leer sein).
 * @param {string} [todayKey]     - Referenz-„heute" (YYYY-MM-DD), Default: heute.
 * @returns {Object} { hasData, ... }
 */
export function predictCycle(periods, settings = {}, todayKey = toLocalDateKey(new Date())) {
  const asc = sortPeriodsAsc(periods);
  const stats = cycleStats(asc, settings);
  const today = dayKey(todayKey);
  const pregnancy = pregnancyInfo(settings, today);

  // Schwangerschafts-Modus hält alle Vorhersagen an — es gibt keinen „nächsten
  // Periodenstart", keinen Eisprung und kein fruchtbares Fenster. Die Historie
  // bleibt erhalten (hasData spiegelt vorhandene Perioden), damit das UI nach
  // der Schwangerschaft nahtlos weiterrechnet.
  if (pregnancy.active) {
    return { hasData: !!asc.length, isPregnant: true, pregnancy, stats, trackFertility: false };
  }

  if (!asc.length) {
    return { hasData: false, isPregnant: false, pregnancy, stats, trackFertility: stats.trackFertility };
  }

  // Jüngster Periodenstart, der nicht in der Zukunft liegt (sonst der jüngste).
  const past = asc.filter((p) => daysBetween(p.start_date, today) >= 0);
  const anchor = (past.length ? past[past.length - 1] : asc[asc.length - 1]);
  const lastStart = dayKey(anchor.start_date);

  const { avgCycle, avgPeriod, lutealLength } = stats;
  const cycleDay = daysBetween(lastStart, today) + 1; // Tag 1 = Starttag

  const nextStart = addLocalDays(lastStart, avgCycle);
  const daysUntilNext = daysBetween(today, nextStart);

  // Aktuelle Blutungsphase: laufende (end offen → avgPeriod) oder abgeschlossene
  // Episode, die „heute" abdeckt.
  const inLoggedPeriod = asc.some((p) => {
    const s = dayKey(p.start_date);
    const e = p.end_date ? dayKey(p.end_date) : addLocalDays(s, avgPeriod - 1);
    return daysBetween(s, today) >= 0 && daysBetween(today, e) >= 0;
  });

  const trackFertility = stats.trackFertility;
  const ovulationDate = addLocalDays(nextStart, -lutealLength);
  const fertileStart = addLocalDays(ovulationDate, -(FERTILE_WINDOW_DAYS - 1));
  const fertileEnd = ovulationDate;

  // Phasen-Bestimmung für „heute".
  let phase = PHASE.FOLLICULAR;
  if (inLoggedPeriod || (cycleDay >= 1 && cycleDay <= avgPeriod)) {
    phase = PHASE.MENSTRUATION;
  } else if (trackFertility && daysBetween(today, ovulationDate) === 0) {
    phase = PHASE.OVULATION;
  } else if (trackFertility && daysBetween(fertileStart, today) >= 0 && daysBetween(today, fertileEnd) >= 0) {
    phase = PHASE.FERTILE;
  } else if (daysBetween(ovulationDate, today) > 0) {
    phase = PHASE.LUTEAL;
  } else {
    phase = PHASE.FOLLICULAR;
  }

  return {
    hasData: true,
    isPregnant: false,
    pregnancy,
    stats,
    trackFertility,
    lastStart,
    cycleDay,
    avgCycle,
    avgPeriod,
    lutealLength,
    nextStart,
    daysUntilNext,
    ovulationDate: trackFertility ? ovulationDate : null,
    fertileStart: trackFertility ? fertileStart : null,
    fertileEnd: trackFertility ? fertileEnd : null,
    daysUntilOvulation: trackFertility ? daysBetween(today, ovulationDate) : null,
    phase,
    inLoggedPeriod,
    isPredictedOverdue: daysUntilNext < 0,
  };
}

// --------------------------------------------------------
// Monatskalender
// --------------------------------------------------------

/** Deckt ein Datum eine geloggte Periode ab? (offene Episode → avgPeriod Tage). */
function loggedPeriodPhase(dateKey, periodsAsc, avgPeriod) {
  return periodsAsc.some((p) => {
    const s = dayKey(p.start_date);
    const e = p.end_date ? dayKey(p.end_date) : addLocalDays(s, avgPeriod - 1);
    return daysBetween(s, dateKey) >= 0 && daysBetween(dateKey, e) >= 0;
  });
}

/**
 * Baut das Monatsraster (6 Wochen) für den Monat um `anchorKey`. Jede Zelle trägt
 * ihre Phase (farbcodiert) und – sofern vorhanden – den Tages-Log (Flow).
 * Vorhergesagte Perioden/Eisprünge werden über bis zu drei Folgezyklen projiziert,
 * damit ein Monat vollständig eingefärbt ist.
 *
 * @param {string} anchorKey - Datum im Zielmonat (YYYY-MM-DD).
 * @param {Object} opts
 * @param {Array}  opts.periods
 * @param {Array}  opts.logs      - cycle_day_logs (für Flow-Punkte).
 * @param {Object} opts.settings
 * @param {string} [opts.todayKey]
 * @param {number} [opts.weekStartsOn=1]
 * @returns {{ month, weeks: Array<Array<Object>> }}
 */
export function buildCycleCalendar(anchorKey, { periods = [], logs = [], settings = {}, todayKey = toLocalDateKey(new Date()), weekStartsOn = 1 } = {}) {
  const asc = sortPeriodsAsc(periods);
  const stats = cycleStats(asc, settings);
  const { avgCycle, avgPeriod, lutealLength, trackFertility } = stats;
  const today = dayKey(todayKey);

  const logByDate = new Map();
  for (const l of (logs || [])) {
    if (l && l.log_date) logByDate.set(dayKey(l.log_date), l);
  }

  // Projizierte Zyklen (nur zukünftige, ab dem letzten geloggten Start).
  // Im Schwangerschafts-Modus entfällt jede Projektion — geloggte Perioden
  // bleiben sichtbar, aber es werden keine künftigen Phasen vorhergesagt.
  const pregnant = pregnancyInfo(settings, today).active;
  const projected = [];
  if (asc.length && !pregnant) {
    const lastStart = dayKey(asc[asc.length - 1].start_date);
    for (let k = 1; k <= 3; k += 1) {
      const start = addLocalDays(lastStart, avgCycle * k);
      const ovul = addLocalDays(start, -lutealLength);
      projected.push({
        start,
        end: addLocalDays(start, avgPeriod - 1),
        ovulation: ovul,
        fertileStart: addLocalDays(ovul, -(FERTILE_WINDOW_DAYS - 1)),
        fertileEnd: ovul,
      });
    }
  }

  const anchor = dayKey(anchorKey);
  const monthStr = anchor.slice(0, 7); // YYYY-MM
  const firstOfMonth = `${monthStr}-01`;
  const gridStart = startOfLocalWeekKey(firstOfMonth, weekStartsOn);

  const cell = (dateKey) => {
    const inMonth = dateKey.slice(0, 7) === monthStr;
    const log = logByDate.get(dateKey) || null;

    let phase = null;
    let predicted = false;
    if (loggedPeriodPhase(dateKey, asc, avgPeriod)) {
      phase = PHASE.MENSTRUATION;
    } else {
      for (const c of projected) {
        if (daysBetween(c.start, dateKey) >= 0 && daysBetween(dateKey, c.end) >= 0) { phase = PHASE.MENSTRUATION; predicted = true; break; }
        if (trackFertility && daysBetween(c.ovulation, dateKey) === 0) { phase = PHASE.OVULATION; predicted = true; break; }
        if (trackFertility && daysBetween(c.fertileStart, dateKey) >= 0 && daysBetween(dateKey, c.fertileEnd) >= 0) { phase = PHASE.FERTILE; predicted = true; break; }
      }
    }

    return {
      dateKey,
      day: Number(dateKey.slice(8, 10)),
      inMonth,
      isToday: dateKey === today,
      isFuture: daysBetween(today, dateKey) > 0,
      phase,
      predicted,
      flow: log?.flow || null,
      hasLog: !!log && !!(log.flow || log.symptoms || log.mood || log.note),
    };
  };

  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const row = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(cell(addLocalDays(gridStart, w * 7 + d)));
    }
    weeks.push(row);
  }
  return { month: monthStr, weeks };
}

// --------------------------------------------------------
// Ring-Widget (Segment-Brüche 0..1 des Zyklus)
// --------------------------------------------------------

/**
 * Wandelt die Vorhersage in Segment-Brüche (0..1 des Zyklus) für das SVG-Ring-
 * Widget. Tag 1 des Zyklus liegt bei Bruch 0; ein voller Zyklus füllt den Kreis.
 * Das UI mappt Bruch → Winkel (frac × 360°, Start oben).
 *
 * @param {Object} prediction - Rückgabe von predictCycle (hasData=true).
 * @returns {null|{ total, segments:Array<{phase,start,end}>, ovulationFrac,
 *                  currentFrac }}
 */
export function cycleRing(prediction) {
  if (!prediction || !prediction.hasData) return null;
  // Kein Zyklus-Ring während der Schwangerschaft (keine avgCycle-Basis).
  if (prediction.isPregnant) return null;
  const total = prediction.avgCycle;
  const seg = (fromDay, toDay) => ({
    start: Math.max(0, (fromDay - 1) / total),
    end: Math.min(1, toDay / total),
  });

  const segments = [];
  // Menstruation: Tag 1..avgPeriod.
  const m = seg(1, prediction.avgPeriod);
  segments.push({ phase: PHASE.MENSTRUATION, start: m.start, end: m.end });

  let ovulationFrac = null;
  if (prediction.trackFertility) {
    const ovDay = total - prediction.lutealLength;            // Zyklustag des Eisprungs
    const fStart = ovDay - (FERTILE_WINDOW_DAYS - 1);
    const f = seg(fStart, ovDay);
    if (f.end > f.start) segments.push({ phase: PHASE.FERTILE, start: f.start, end: f.end });
    const o = seg(ovDay, ovDay);
    segments.push({ phase: PHASE.OVULATION, start: o.start, end: o.end });
    ovulationFrac = (ovDay - 0.5) / total;
  }

  const clampedDay = Math.min(Math.max(prediction.cycleDay, 1), total);
  const currentFrac = (clampedDay - 0.5) / total;

  return { total, segments, ovulationFrac, currentFrac };
}
