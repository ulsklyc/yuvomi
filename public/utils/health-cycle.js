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
 *        - buildCycleCalendar(): Monatsraster mit farbcodierten Phasen je Tag
 *                          (Eisprung/fruchtbares Fenster des AKTUELLEN Zyklus
 *                          teilen sich seit v2 dieselbe Rechnung wie
 *                          predictCycle(), inkl. BBT-Bestätigung - Details im
 *                          Dokblock dort).
 *        - cycleRing(): Segment-Brüche (0..1) für das SVG-Ring-Widget.
 *        - normalizeSymptomEntries() (Phase 2): Symptom-Auswahl eines Tages zu
 *                          `{key, intensity}[]`, Intensität 1-3 optional.
 *        - predictSymptomLikelihood() (v2): projiziert zusätzlich auf den
 *                          NÄCHSTEN Zyklus, nicht nur den laufenden.
 *        - pmsWindow() (v2): abgeleitetes PMS-Fenster aus dem
 *                          Symptom-Zyklustag-Muster.
 *        - periodFlowSummary() (v2, B-2): stärkster Flow-Wert + geloggte Tage
 *                          EINER Periode, für den Historie-Chip.
 *        - periodFlowLoad() (v2, B-3): Summe der Flow-Ränge EINER Periode,
 *                          für den Blutungslast-Trend.
 *        - heavyBleedingSignal() (v2, B-4): Muster-Prädikat für den ruhigen
 *                          "mit Ärztin/Arzt besprechen"-Hinweis.
 *        - feelingFrequencyByPhase() (v2): wie symptomFrequencyByPhase(),
 *                          über `feelings` statt `symptoms`.
 *        - painSummary() (v2): Schmerztage aktueller Zyklus vs. Ø +
 *                          Ø-Intensität über die schmerzbezogenen Symptome.
 *        - peakPainDay() (v2, Nutzer-Feedback): welcher Zyklustag laut
 *                          Historie im Mittel am staerksten schmerzt, fuer die
 *                          Today-Bubble.
 *        Bewusst KEINE i18n/DOM — in Node ohne Browser testbar (labelKeys liefern
 *        die Übersetzung erst im UI).
 * Abhängigkeiten: ./date.js (ebenfalls DOM-frei; relativer Import, siehe
 *                 Kommentar dort - server/services/cycle-reminders.js
 *                 importiert diese Datei direkt).
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
//
// RELATIV, NICHT '/utils/date.js': anders als der Rest der App (die feste
// Wurzel-Pfade fuer browser-weite Eindeutigkeit nutzt) muss DIESE Datei auch
// ausserhalb des Browsers ohne Loader-Trick importierbar bleiben - Node
// kennt '/utils/date.js' nicht als Web-Root-Pfad, sondern als absoluten
// Dateisystempfad, der nicht existiert. server/services/cycle-reminders.js
// importiert diese Datei direkt (Single Source of Truth fuer die
// Vorhersage-Mathematik, server und Client rechnen dasselbe), und date.js
// liegt im selben Verzeichnis - ein relativer Import loest in beiden Welten
// identisch auf.
import { addLocalDays, startOfLocalWeekKey, todayKey as householdToday } from './date.js';

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

// Symptome (Mehrfachauswahl je Tag, seit Phase 2 mit optionaler 1-3-
// Intensitaet je Auswahl). Icon = Lucide-Name. `hasIntensity` steht an jedem
// Eintrag (nicht als globale Regel), damit ein Preset ohne sinnvolle Abstufung
// (kaeme eines dazu) sie auslassen koennte, ohne die Form der Liste zu aendern.
export const SYMPTOM_TYPES = Object.freeze([
  { value: 'cramps',        labelKey: 'health.cycle.symptom.cramps',        icon: 'zap',            hasIntensity: true },
  { value: 'headache',      labelKey: 'health.cycle.symptom.headache',      icon: 'brain',           hasIntensity: true },
  { value: 'backache',      labelKey: 'health.cycle.symptom.backache',      icon: 'move-vertical',   hasIntensity: true },
  { value: 'bloating',      labelKey: 'health.cycle.symptom.bloating',      icon: 'circle-dot',      hasIntensity: true },
  { value: 'tender_breasts', labelKey: 'health.cycle.symptom.tenderBreasts', icon: 'heart',          hasIntensity: true },
  { value: 'acne',          labelKey: 'health.cycle.symptom.acne',          icon: 'sparkle',         hasIntensity: true },
  { value: 'fatigue',       labelKey: 'health.cycle.symptom.fatigue',       icon: 'battery-low',     hasIntensity: true },
  { value: 'nausea',        labelKey: 'health.cycle.symptom.nausea',        icon: 'thermometer',     hasIntensity: true },
  { value: 'cravings',      labelKey: 'health.cycle.symptom.cravings',      icon: 'cookie',          hasIntensity: true },
  { value: 'insomnia',      labelKey: 'health.cycle.symptom.insomnia',      icon: 'moon',            hasIntensity: true },
  { value: 'constipation',  labelKey: 'health.cycle.symptom.constipation',  icon: 'circle-dashed',   hasIntensity: true },
  { value: 'diarrhea',      labelKey: 'health.cycle.symptom.diarrhea',      icon: 'droplets',        hasIntensity: true },
  { value: 'joint_pain',    labelKey: 'health.cycle.symptom.jointPain',     icon: 'bone',             hasIntensity: true },
  { value: 'dizziness',     labelKey: 'health.cycle.symptom.dizziness',     icon: 'waves',            hasIntensity: true },
  { value: 'hot_flashes',   labelKey: 'health.cycle.symptom.hotFlashes',    icon: 'thermometer-sun',  hasIntensity: true },
  { value: 'swelling',      labelKey: 'health.cycle.symptom.swelling',      icon: 'glass-water',      hasIntensity: true },
  { value: 'libido_change', labelKey: 'health.cycle.symptom.libidoChange',  icon: 'flame',            hasIntensity: true },
  { value: 'discharge_change', labelKey: 'health.cycle.symptom.dischargeChange', icon: 'droplet',     hasIntensity: true },
  { value: 'appetite_change', labelKey: 'health.cycle.symptom.appetiteChange', icon: 'utensils',      hasIntensity: true },
  { value: 'concentration_difficulty', labelKey: 'health.cycle.symptom.concentrationDifficulty', icon: 'brain-circuit', hasIntensity: true },
]);

export const SYMPTOM_VALUES = Object.freeze(SYMPTOM_TYPES.map((s) => s.value));

// Abstufung einer Symptom-Auswahl (1-3, optional). Kein 4./5. Grad - drei
// Stufen sind schnell antippbar und decken, was ein Tagesprotokoll braucht;
// mehr waere eine klinische Skala, die dieses Modul nicht sein will (siehe
// "kein Medizinprodukt" in docs/SPEC.md).
export const INTENSITY_LEVELS = Object.freeze([
  { value: 1, labelKey: 'health.cycle.intensity.mild' },
  { value: 2, labelKey: 'health.cycle.intensity.moderate' },
  { value: 3, labelKey: 'health.cycle.intensity.severe' },
]);

/** labelKey zu einer Intensitaet (1-3) oder null, wenn keine gueltige Stufe. */
export function symptomIntensityLabelKey(intensity) {
  const level = INTENSITY_LEVELS.find((l) => l.value === Number(intensity));
  return level ? level.labelKey : null;
}

const SYMPTOM_KEY_RE = /^[a-z0-9_]{1,32}$/;

/**
 * Normalisiert eine Symptom-Auswahl zu `{ key, intensity }[]`, dedupliziert
 * nach `key` (letzter Eintrag gewinnt) und klemmt `intensity` auf 1-3 oder
 * `null`. Nimmt sowohl das aktuelle Array-Format
 * (`[{ key, intensity }, ...]`) als auch, für Abwärtskompatibilität mit vor
 * Phase 2 gespeicherten Werten, einen Komma-String oder ein reines
 * String-Array ohne Intensität entgegen - beide ergeben `intensity: null`.
 * Unbekannte/unlesbare Einträge werden still verworfen, nicht als Fehler
 * gemeldet: dieselbe Haltung wie die frühere `normalizeSymptoms()`.
 *
 * @param {Array<string|{key: string, intensity?: number}>|string} raw
 * @returns {Array<{key: string, intensity: number|null}>}
 */
export function normalizeSymptomEntries(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = typeof raw === 'string' ? raw.split(',') : (Array.isArray(raw) ? raw : []);
  const byKey = new Map();
  for (const item of list) {
    const isObj = item !== null && typeof item === 'object';
    const key = String(isObj ? (item.key ?? '') : item).trim().toLowerCase();
    if (!SYMPTOM_KEY_RE.test(key)) continue;
    const n = isObj ? Number(item.intensity) : NaN;
    const intensity = Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
    byKey.set(key, { key, intensity });
  }
  return [...byKey.values()];
}

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

// --------------------------------------------------------
// Geschlossene Wertelisten, EIN
// Zuhause statt DREIER Kopien (server/routes/health/cycle.js +
// public/pages/health.js hielten je eine eigene, plus die hormonelle
// Teilmenge unten in dieser Datei) - dasselbe Vorbild wie FLOW_LEVELS/
// MOOD_TYPES oben. server/routes/health/cycle.js importiert die *_VALUES
// (dasselbe Muster wie sein bestehender MOOD_VALUES-Import), health.js
// importiert die *_TYPES (labelKeys bleiben, wie sie waren).
// --------------------------------------------------------

export const CERVIX_MUCUS_TYPES = Object.freeze([
  { value: 'dry',      labelKey: 'health.cycle.mucus.dry' },
  { value: 'sticky',   labelKey: 'health.cycle.mucus.sticky' },
  { value: 'creamy',   labelKey: 'health.cycle.mucus.creamy' },
  { value: 'watery',   labelKey: 'health.cycle.mucus.watery' },
  { value: 'eggwhite', labelKey: 'health.cycle.mucus.eggwhite' },
]);
export const CERVIX_MUCUS_VALUES = Object.freeze(CERVIX_MUCUS_TYPES.map((m) => m.value));

// LH- und Schwangerschaftstest teilen sich dieselben zwei Ergebnisse
// und denselben labelKey-Namensraum (health.cycle.test.<value>) - kein
// eigenes _TYPES-Objekt noetig, der labelKey ist aus dem Wert selbst
// ableitbar (siehe Aufrufstellen in health.js).
export const TEST_RESULT_VALUES = Object.freeze(['negative', 'positive']);

// Hart privat (siehe server/routes/health/cycle.js GET /cycle/logs und
// docs/SPEC.md, Abschnitt "Owner-only axis").
export const INTIMACY_TYPES = Object.freeze([
  { value: 'protected',   labelKey: 'health.cycle.intimacy.protected' },
  { value: 'unprotected', labelKey: 'health.cycle.intimacy.unprotected' },
  { value: 'solo',        labelKey: 'health.cycle.intimacy.solo' },
]);
export const INTIMACY_VALUES = Object.freeze(INTIMACY_TYPES.map((i) => i.value));

// Dieselbe geschlossene Auswahl wie zuvor server/routes/health/cycle.js#
// CONTRACEPTION_VALUES (Quelle der Wahrheit fuer die Validierung bleibt hier) -
// 'none' ist ein bewusst gewaehlter Wert ("keine Verhuetung", explizit
// angegeben) und bleibt von der leeren Option ("nicht angegeben", `null` in
// der DB) unterschieden. `hormonal` steht direkt an jedem Eintrag - die
// hormonelle Teilmenge (HORMONAL_CONTRACEPTION_VALUES) leitet sich daraus ab,
// statt eine zweite, von Hand synchron zu haltende Liste zu sein.
export const CONTRACEPTION_TYPES = Object.freeze([
  { value: 'none',         labelKey: 'health.cycle.settings.contraceptionOptions.none',         hormonal: false },
  { value: 'pill',         labelKey: 'health.cycle.settings.contraceptionOptions.pill',         hormonal: true },
  { value: 'hormonal_iud', labelKey: 'health.cycle.settings.contraceptionOptions.hormonal_iud', hormonal: true },
  { value: 'copper_iud',   labelKey: 'health.cycle.settings.contraceptionOptions.copper_iud',   hormonal: false },
  { value: 'implant',      labelKey: 'health.cycle.settings.contraceptionOptions.implant',      hormonal: true },
  { value: 'injection',    labelKey: 'health.cycle.settings.contraceptionOptions.injection',    hormonal: true },
  { value: 'patch',        labelKey: 'health.cycle.settings.contraceptionOptions.patch',        hormonal: true },
  { value: 'ring',         labelKey: 'health.cycle.settings.contraceptionOptions.ring',         hormonal: true },
  { value: 'condom',       labelKey: 'health.cycle.settings.contraceptionOptions.condom',       hormonal: false },
  { value: 'other',        labelKey: 'health.cycle.settings.contraceptionOptions.other',        hormonal: false },
]);
export const CONTRACEPTION_VALUES = Object.freeze(CONTRACEPTION_TYPES.map((c) => c.value));
// Die HORMONELLE Teilmenge unterdrueckt typischerweise den Eisprung -
// eine Kupferspirale, Kondom, "keine" oder "andere" aendern am Zyklus selbst
// nichts. `null`/unbekannt zaehlt nicht dazu. suppressesFertility() (unten)
// liest ausschliesslich diese abgeleitete Liste.
export const HORMONAL_CONTRACEPTION_VALUES = Object.freeze(
  CONTRACEPTION_TYPES.filter((c) => c.hormonal).map((c) => c.value),
);

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
// erst ab 3 Lücken (4 geloggte Perioden) gilt der Mittelwert als belastbar; exportiert,
// damit die UI dieselbe Schwelle für die "noch X Perioden"-Hinweise nutzen kann.
export const MIN_HISTORY_GAPS = 3;
const GESTATION_DAYS = 280;    // Naegele-Regel: 40 Wochen von der letzten Periode

// Allgemein ueblicher Zykluslaenge-Bereich (Phase 4d), Standardliteratur (z.B.
// ACOG-nahe Quellen) - bewusst ZUSAETZLICH zum SELBSTBEZUEGLICHEN `regular`/
// `variation` in cycleStats() (Abweichung vom eigenen Mittel), nicht dessen
// Ersatz: die beiden beantworten verschiedene Fragen ("liegt das im
// allgemein ueblichen Bereich" vs. "ist DEIN Zyklus fuer DICH konsistent").
export const TYPICAL_CYCLE_RANGE = Object.freeze({ min: 24, max: 38 });

/** Liegt eine Zykluslaenge (Tage) im allgemein ueblichen Bereich? */
export function isTypicalCycleLength(days) {
  return Number.isFinite(days) && days >= TYPICAL_CYCLE_RANGE.min && days <= TYPICAL_CYCLE_RANGE.max;
}

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

// A-3: Grenzen einer PLAUSIBLEN Lücke zwischen zwei Periodenstarts. Unter 10
// Tagen ist es praktisch nie ein neuer Zyklus (eher eine Zwischenblutung/
// Doppel-Erfassung), über 90 Tagen sprengt es selbst großzügige Zyklen (siehe
// TYPICAL_CYCLE_RANGE, die enger gefasste "üblich"-Spanne, die das NICHT
// ersetzt). Eine einzelne solche Ausreißer-Lücke darf den gleitenden
// Mittelwert/die Schwankung nicht verzerren (siehe cycleStats()) - sie
// erscheint stattdessen in `excludedGaps`, damit die UI sie später erklären
// statt still verschlucken kann.
const PLAUSIBLE_GAP_MIN_DAYS = 10;
const PLAUSIBLE_GAP_MAX_DAYS = 90;
// Eine harte 90-Tage-Obergrenze schnitt bislang JEDE Lücke
// einer Person mit echten (PCOS-/oligomenorrhoe-typischen) ~95-100-Tage-
// Zyklen weg - der Mittelwert fiel dann trotz konsistenter Historie auf den
// 28-Tage-Default zurück (source 'insufficient_history' statt 'history'), und
// Erinnerungen feuerten rund dreimal zu oft. Zwischen PLAUSIBLE_GAP_MAX_DAYS
// (90) und dieser Obergrenze gilt eine Lücke als "lang, aber rettbar" (siehe
// cycleStats()) - jenseits von 365 Tagen ist selbst das keine sinnvolle
// Zyklusannahme mehr und bleibt IMMER ausgeschlossen, wie unter
// PLAUSIBLE_GAP_MIN_DAYS.
const LONG_GAP_MAX_DAYS = 365;

/**
 * Zerlegt die Perioden-Historie in Lücken (Tage zwischen aufeinanderfolgenden
 * Starts) und trennt drei Gruppen: PLAUSIBLE (10-90 Tage), LANG-ABER-RETTBAR
 * (>90 bis 365 Tage, Fix 4 - s.u. in cycleStats(), ob sie tatsächlich in den
 * Mittelwert einfließen) und TATSAECHLICH ausgeschlossen (<10 Tage, >365 Tage,
 * ODER einer der beiden beteiligten Starts liegt in der Zukunft relativ zu
 * `todayKey` - ein noch nicht begonnener Zyklus ist keine abgeschlossene
 * Lücke, weder die davor noch die danach; dieselbe Haltung wie predictCycle()s
 * Anker-Filter). `chronological` behaelt beide rettbaren Gruppen in der
 * urspruenglichen zeitlichen Reihenfolge (fuer MAX_HISTORY-Deckelung in
 * cycleStats(), die die zeitlich JUENGSTEN Lücken braucht, egal aus welcher
 * Gruppe). Gemeinsame Basis von cycleGaps() (nur `plausible`) und cycleStats()
 * (das zusätzlich `long` und die Ausschluss-Anzahl braucht) - eine zweite
 * Kopie derselben Iteration wäre die Alternative gewesen.
 * @returns {{ plausible: number[], long: number[],
 *             chronological: Array<{gap: number, long: boolean}>,
 *             trulyExcludedCount: number, rawCount: number }}
 */
function classifyCycleGaps(periods, todayKey) {
  const asc = sortPeriodsAsc(periods);
  const today = dayKey(todayKey);
  const plausible = [];
  const long = [];
  const chronological = [];
  let trulyExcludedCount = 0;
  let rawCount = 0;
  for (let i = 1; i < asc.length; i += 1) {
    const prevStart = dayKey(asc[i - 1].start_date);
    const curStart = dayKey(asc[i].start_date);
    const gap = daysBetween(prevStart, curStart);
    if (!Number.isFinite(gap) || gap <= 0) continue;
    rawCount += 1;
    const eitherFuture = daysBetween(today, prevStart) > 0 || daysBetween(today, curStart) > 0;
    if (eitherFuture || gap < PLAUSIBLE_GAP_MIN_DAYS || gap > LONG_GAP_MAX_DAYS) {
      trulyExcludedCount += 1;
      continue;
    }
    if (gap > PLAUSIBLE_GAP_MAX_DAYS) {
      long.push(gap);
      chronological.push({ gap, long: true });
    } else {
      plausible.push(gap);
      chronological.push({ gap, long: false });
    }
  }
  return { plausible, long, chronological, trulyExcludedCount, rawCount };
}

/**
 * Abstände (in Tagen) zwischen aufeinanderfolgenden Periodenstarts - NUR die
 * plausiblen (siehe classifyCycleGaps()). cycleLengthTrend() (Trend-Ansicht)
 * nutzt bewusst NICHT diese gefilterte Liste, sondern rekonstruiert ihre
 * eigenen Rohwerte: ein Trend-Chart soll einen Ausreißer SEHEN, nicht
 * verschwinden lassen - nur der gleitende Mittelwert (cycleStats()) braucht
 * den Schutz vor einer einzelnen verzerrenden Lücke.
 * @param {Array<Object>} periods
 * @param {string} [todayKey] - Referenz-„heute" für die Zukunfts-Prüfung.
 */
export function cycleGaps(periods, todayKey = householdToday()) {
  return classifyCycleGaps(periods, todayKey).plausible;
}

/**
 * Zykluslängen-Verlauf für die Trend-Ansicht (Phase 4) - dieselben Abstände
 * wie cycleGaps(), aber mit dem Datum des jeweils NEUEN Zyklus statt einer
 * nackten Zahl, und über die GESAMTE Historie statt der letzten MAX_HISTORY:
 * cycleStats() begrenzt den gleitenden Mittelwert bewusst, ein Trend-Chart
 * soll dagegen genau zeigen, ob/wie sich der Rhythmus über die Zeit verändert.
 * @param {Array<Object>} periods
 * @returns {Array<{date: string, days: number}>}
 */
export function cycleLengthTrend(periods) {
  const asc = sortPeriodsAsc(periods);
  const trend = [];
  for (let i = 1; i < asc.length; i += 1) {
    const days = daysBetween(asc[i - 1].start_date, asc[i].start_date);
    if (Number.isFinite(days) && days > 0) trend.push({ date: dayKey(asc[i].start_date), days });
  }
  return trend;
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
 * Vorrang vor den abgeleiteten Mittelwerten; der abgeleitete Mittelwert greift
 * erst ab MIN_HISTORY_GAPS Lücken, sonst (und ganz ohne Historie) greift der
 * Default. `source` unterscheidet die vier Fälle: 'settings' | 'history' |
 * 'insufficient_history' (Historie vorhanden, aber noch unter der Schwelle) |
 * 'default'.
 * @param {string} [todayKey] - Referenz-„heute" für die Zukunfts-Prüfung der
 *        Lücken (siehe classifyCycleGaps()); Default wie im Rest des Moduls.
 * @returns {{ count, avgCycle, avgPeriod, lutealLength, minCycle, maxCycle,
 *             variation, regular, trackFertility, excludedGaps,
 *             plausibleGapCount, source }}
 */
export function cycleStats(periods, settings = {}, todayKey = householdToday()) {
  const asc = sortPeriodsAsc(periods);
  const {
    plausible: allPlausible, long: allLong, chronological, trulyExcludedCount, rawCount,
  } = classifyCycleGaps(asc, todayKey);

  // Reichen die PLAUSIBLEN (10-90 Tage) Luecken allein
  // schon fuer MIN_HISTORY_GAPS, bleibt es dabei - eine einzelne lange Luecke
  // bei sonst normalen Zyklen ist weiterhin ein Ausreisser, kein Signal fuer
  // einen generell langen Zyklus (Beispiel: drei 28-Tage-Luecken + eine
  // 200-Tage-Luecke -> Mittel bleibt 28, die lange Luecke bleibt ausgeschlossen).
  // Reicht die plausible Menge NICHT, aber PLAUSIBEL+LANG zusammen erreichen
  // die Schwelle, werden auch die langen Luecken fuer den Mittelwert gerettet
  // (konsistente ~95-100-Tage-Zyklen/PCOS-Oligomenorrhoe, deren Historie sonst
  // komplett unter den 90-Tage-Deckel gefallen waere und faelschlich auf den
  // 28-Tage-Default zurueckfiel). `chronological` haelt beide Gruppen in der
  // urspruenglichen zeitlichen Reihenfolge, damit die MAX_HISTORY-Deckelung
  // unten weiterhin die zeitlich JUENGSTEN Luecken waehlt. Das bestehende
  // clampInt(...,15,60) weiter unten deckelt das Ergebnis ohnehin auf
  // hoechstens 60 - reproduziert also denselben Wert, den ein solcher Zyklus
  // schon vor Einfuehrung der 90-Tage-Obergrenze bekommen haette.
  const rescueLong = allPlausible.length < MIN_HISTORY_GAPS
    && (allPlausible.length + allLong.length) >= MIN_HISTORY_GAPS;
  const allGaps = rescueLong ? chronological.map((c) => c.gap) : allPlausible;
  const gaps = allGaps.slice(-MAX_HISTORY);
  const lengths = periodLengths(asc).slice(-MAX_HISTORY);

  // Ein einzelner (oder zweiter) Zyklus kann ein Ausreißer sein - der abgeleitete
  // Mittelwert gilt erst ab MIN_HISTORY_GAPS Lücken als belastbar genug, um den
  // DEFAULT_CYCLE-Fallback zu ersetzen. Darunter bleibt es beim Default, auch wenn
  // schon (wenige) Perioden geloggt sind - das unterscheidet 'insufficient_history'
  // von einem echten Kaltstart ohne jede Historie.
  const derivedCycle = gaps.length >= MIN_HISTORY_GAPS ? clampInt(mean(gaps), 15, 60) : null;
  const derivedPeriod = lengths.length >= MIN_HISTORY_GAPS ? clampInt(mean(lengths), 1, 15) : null;

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
  // „Regelmäßig", wenn die Schwankung der letzten (plausiblen) Zyklen ≤ 7 Tage liegt.
  const regularFromGaps = gaps.length >= 2 ? variation <= 7 : null;
  // Im Perimenopause-Modus ist Unregelmäßigkeit ERWARTET - das
  // Regelmäßig/Unregelmäßig-Urteil wäre hier keine falsche Berechnung, aber
  // eine irreführende Aussage, deshalb explizit unterdrückt (null) statt eines
  // vermeidbaren "unregelmäßig"-Alarms. Ob/wie die UI stattdessen ein
  // Typisch/Atypisch-Badge aus `nextStartRange` (predictCycle()) ableitet, ist
  // bewusst NICHT Sache dieser Funktion.
  const perimenopauseMode = !!(settings.perimenopause_mode === 1 || settings.perimenopause_mode === true);
  const regular = perimenopauseMode ? null : regularFromGaps;

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
    // A-3/Fix 4: wie viele Lücken TATSAECHLICH ausgeschlossen blieben - immer
    // die < 10 Tage/> 365 Tage/zukunftsbeteiligten (trulyExcludedCount), PLUS
    // die langen (90-365 Tage) NUR, wenn sie NICHT gerettet wurden (siehe
    // rescueLong oben) - eine gerettete lange Lücke ist Teil des Mittelwerts,
    // keine ausgeschlossene mehr.
    excludedGaps: trulyExcludedCount + (rescueLong ? 0 : allLong.length),
    // Anzahl der tatsächlich fürs Mittel verwendeten (auf MAX_HISTORY
    // gedeckelten) Lücken - plausibel allein, oder plausibel+lang, wenn Fix 4s
    // Rettung gegriffen hat (siehe rescueLong oben). predictCycle() braucht
    // denselben Wert für die MIN_HISTORY_GAPS-Schwelle des Perimenopause-
    // Bereichs, ohne ihn ein zweites Mal zu berechnen.
    plausibleGapCount: gaps.length,
    // 'insufficient_history' bleibt an der ROHEN Lückenzahl (rawCount) hängen,
    // nicht an der plausiblen: eine Historie aus lauter unplausiblen Lücken
    // ("Historie vorhanden, aber Datenmüll") ist etwas anderes als ein echter
    // Kaltstart ganz ohne geloggte zweite Periode.
    source: settingCycle ? 'settings' : (derivedCycle ? 'history' : (rawCount > 0 ? 'insufficient_history' : 'default')),
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
export function pregnancyInfo(settings = {}, todayKey = householdToday()) {
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
// Basaltemperatur (BBT) — Eisprung-Bestätigung per Temperaturanstieg
// --------------------------------------------------------

// 0,2 °C ist die uebliche Schwelle der "3-ueber-6"-Coverline-Methode
// (Fruchtbarkeitsbewusstsein-Praxis, nicht klinisch normiert - siehe
// "kein Medizinprodukt" in docs/SPEC.md). Sechs Tage Basislinie, drei Tage
// ueber der Schwelle in Folge.
const TEMP_SHIFT_THRESHOLD_C = 0.2;
const TEMP_BASELINE_READINGS = 6;
const TEMP_SUSTAINED_DAYS = 3;

/** Celsius aus einem Wert + Einheit ('c'|'f'), oder null bei unbrauchbarer Eingabe. */
function toCelsius(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit === 'f' ? (n - 32) * 5 / 9 : n;
}

/**
 * Basaltemperatur-Messungen aus Tages-Logs, nach Celsius vereinheitlicht,
 * chronologisch sortiert. Geteilte Grundlage für detectTemperatureShift() und
 * bbtSeries() - beide brauchen dieselbe Extraktion, nur mit/ohne Zyklus-Filter.
 * @param {Array<Object>} dayLogs
 * @param {string} [sinceKey] - nur Messungen ab diesem Datum (YYYY-MM-DD).
 */
function temperatureReadings(dayLogs, sinceKey = null) {
  const since = sinceKey ? dayKey(sinceKey) : null;
  return (dayLogs || [])
    .filter((l) => l && l.basal_temp != null && (!since || dayKey(l.log_date) >= since))
    .map((l) => ({ date: dayKey(l.log_date), celsius: toCelsius(l.basal_temp, l.basal_temp_unit) }))
    .filter((r) => r.celsius != null)
    .sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
}

/**
 * Basaltemperatur-Reihe für die Trend-Ansicht (Phase 4) - alle geloggten
 * Messungen, nicht nur die des laufenden Zyklus (anders als
 * detectTemperatureShift(), das bewusst nur den AKTUELLEN Zyklus bewertet).
 * @param {Array<Object>} dayLogs
 * @returns {Array<{date: string, celsius: number}>}
 */
export function bbtSeries(dayLogs) {
  return temperatureReadings(dayLogs);
}

/**
 * Zyklus-Grenzen je geloggter Periode - die gemeinsame Basis von
 * symptomFrequencyByPhase() (Phase 4) und symptomCyclePattern() (Phase 4c),
 * herausgezogen statt zweimal dieselbe Rekonstruktion zu pflegen. Aufsteigend
 * sortiert (ältester Zyklus zuerst), wie sortPeriodsAsc() es liefert.
 *
 * Der letzte (ggf. noch laufende) Zyklus hat keinen "nächsten" Periodenstart -
 * er fällt auf Ø-Zykluslänge (cycleStats()) zurück, dieselbe Regel wie
 * predictCycle().
 *
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {Array<{cycleStart: string, nextStart: string, mensEnd: string, lutealStart: string}>}
 */
function reconstructCycles(periods, settings = {}) {
  const asc = sortPeriodsAsc(periods);
  if (!asc.length) return [];
  const stats = cycleStats(asc, settings);
  return asc.map((p, i) => {
    const cycleStart = dayKey(p.start_date);
    const nextStart = i + 1 < asc.length ? dayKey(asc[i + 1].start_date) : addLocalDays(cycleStart, stats.avgCycle);
    const mensEnd = p.end_date ? dayKey(p.end_date) : addLocalDays(cycleStart, stats.avgPeriod - 1);
    const lutealStart = addLocalDays(nextStart, -stats.lutealLength);
    return { cycleStart, nextStart, mensEnd, lutealStart };
  });
}

/**
 * Ordnet EINEN Tag innerhalb EINES bekannten Zyklus einer von drei Phasen zu.
 *
 * DREI EIMER STATT FÜNF, UND DAS IST ABSICHT: predictCycle()/buildCycleCalendar()
 * kennen fünf Phasen, aber immer nur für EINEN (den aktuellen) Zyklus relativ zu
 * "heute". Für JEDEN historischen Tag dieselben fünf Grenzen (insbesondere
 * follikulär vs. fruchtbar) nachzubilden bräuchte eine zweite, über alle
 * vergangenen Zyklen laufende Kopie dieser Logik - fehleranfällig für einen
 * Nutzen, den ein grobes Raster schon trägt. Menstruation (geloggter Zeitraum)
 * und Luteal (Eisprung-Tag bis zum nächsten Periodenbeginn, aus dem TATSÄCHLICHEN
 * Abstand der jeweiligen Perioden - nicht aus einem Haushalts-Durchschnitt)
 * beantworten die eigentlich gefragten Muster ("PMS-Symptome", "Periodenschmerz");
 * alles andere fällt in eine dritte "other"-Sammelkategorie - kein eigener
 * PHASE-Wert, weil sie bewusst KEIN fruchtbares Fenster behauptet.
 *
 * @param {{cycleStart: string, mensEnd: string, lutealStart: string}} cyc - ein Eintrag aus reconstructCycles().
 * @param {string} dateKey
 * @returns {string} PHASE.MENSTRUATION | PHASE.LUTEAL | 'other'
 */
function classifyDayPhase(cyc, dateKey) {
  if (daysBetween(cyc.cycleStart, dateKey) >= 0 && daysBetween(dateKey, cyc.mensEnd) >= 0) return PHASE.MENSTRUATION;
  if (daysBetween(cyc.lutealStart, dateKey) >= 0) return PHASE.LUTEAL;
  return 'other';
}

/**
 * Generischer Kern von symptomFrequencyByPhase()/feelingFrequencyByPhase()
 * (v2) - beide zaehlen Vorkommen einer Tages-Log-Eigenschaft
 * (Symptome bzw. Gefuehle) je Zyklus-Phase; die einzige Abweichung ist, WELCHE
 * Eintraege ein Log traegt. `extractEntries(log)` liefert dieselbe
 * `{key, intensity}[]`-Form wie normalizeSymptomEntries() (intensity darf
 * `null` sein). Tage vor der ersten geloggten Periode gehören zu keinem
 * bekannten Zyklus und werden übersprungen, nicht geraten.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} settings - cycle_settings-Zeile (für luteal_length).
 * @param {(log: Object) => Array<{key: string, intensity: number|null}>} extractEntries
 * @returns {Array<{key: string, menstruation: number, luteal: number, other: number, total: number, avgIntensity: number|null}>}
 *          absteigend nach total sortiert.
 */
function frequencyByPhase(dayLogs, periods, settings, extractEntries) {
  const cycles = reconstructCycles(periods, settings);
  if (!cycles.length) return [];

  function phaseFor(dateKey) {
    const cyc = cycles.find((c) => daysBetween(c.cycleStart, dateKey) >= 0 && daysBetween(dateKey, c.nextStart) > 0);
    return cyc ? classifyDayPhase(cyc, dateKey) : null;
  }

  const counts = new Map();
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const phase = phaseFor(dayKey(log.log_date));
    if (!phase) continue;
    for (const entry of extractEntries(log)) {
      const c = counts.get(entry.key) || { key: entry.key, [PHASE.MENSTRUATION]: 0, [PHASE.LUTEAL]: 0, other: 0, total: 0, _intensities: [] };
      c[phase] += 1;
      c.total += 1;
      if (entry.intensity != null) c._intensities.push(entry.intensity);
      counts.set(entry.key, c);
    }
  }
  // avgIntensity (Phase 4b): Mittel der gradierten Vorkommen, oder null, wenn
  // keine einzige Auswahl gradiert wurde - "nicht gradiert" bleibt von "mild"
  // unterscheidbar. Gefuehle liefern nie eine Intensitaet (s.u.), avgIntensity
  // bleibt fuer sie deshalb immer null - kein erfundener Wert.
  return [...counts.values()]
    .map(({ _intensities, ...c }) => ({ ...c, avgIntensity: mean(_intensities) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Symptom-Häufigkeit je Zyklus-Phase, für die Trend-Ansicht (Phase 4) -
 * beantwortet "häufen sich meine Symptome vor der Periode" statt nur "wie oft
 * kam Symptom X überhaupt vor".
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {Array<{key: string, menstruation: number, luteal: number, other: number, total: number}>}
 *          absteigend nach total sortiert.
 */
export function symptomFrequencyByPhase(dayLogs, periods, settings = {}) {
  return frequencyByPhase(dayLogs, periods, settings, (log) => normalizeSymptomEntries(log.symptoms));
}

/**
 * Gefuehls-Eintraege EINES Tages-Logs, normalisiert auf dieselbe
 * `{key, intensity}`-Form wie normalizeSymptomEntries() (intensity ist hier
 * immer `null` - Gefuehle kennen keine Staerke). `feelings` (Array, seit
 * Migration 211) hat Vorrang - und zwar auch als LEERES Array: ein bewusst
 * geleertes `feelings: []` ist "keine Gefuehle mehr", nicht "keine Angabe",
 * und darf NICHT auf das eingefrorene `mood` zurueckfallen (vorher wurde ein
 * geloeschtes Gefuehl beim naechsten Laden aus dem alten `mood`-Wert
 * wiederbelebt, weil `[].length` falsy ist). Der Fallback
 * auf das alte Einzelfeld `mood` als Ein-Element-Liste greift NUR, wenn
 * `feelings` ueberhaupt fehlt (kein Array ist) - also fuer Zeilen aus der Zeit
 * vor Migration 211, deren Formular `feelings` noch nie gesendet hat.
 * Unbekannte/nicht in MOOD_VALUES enthaltene Werte werden still verworfen,
 * dieselbe Haltung wie normalizeSymptomEntries().
 * @param {Object} log
 * @returns {Array<{key: string, intensity: null}>}
 */
export function normalizeFeelingEntries(log) {
  const list = Array.isArray(log?.feelings)
    ? log.feelings
    : (log?.mood ? [log.mood] : []);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (!MOOD_VALUES.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, intensity: null });
  }
  return out;
}

/**
 * Gefühls-Häufigkeit je Zyklus-Phase (v2) - dieselbe Frage wie
 * symptomFrequencyByPhase(), nur über `feelings` statt `symptoms` (siehe
 * normalizeFeelingEntries() für die Legacy-`mood`-Rückfalllogik).
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {Array<{key: string, menstruation: number, luteal: number, other: number, total: number, avgIntensity: null}>}
 *          absteigend nach total sortiert.
 */
export function feelingFrequencyByPhase(dayLogs, periods, settings = {}) {
  return frequencyByPhase(dayLogs, periods, settings, normalizeFeelingEntries);
}

/**
 * Schweregrad-Verlauf EINES Symptoms über die Zeit (Phase 4b) - anders als
 * symptomFrequencyByPhase() (wie oft/wo im Zyklus) beantwortet das "wird es
 * schlimmer oder besser". Nur gradierte Vorkommen dieses einen Symptoms,
 * chronologisch; ungradierte Auswahl hat keinen Schweregrad zu plotten.
 * @param {Array<Object>} dayLogs
 * @param {string} symptomKey
 * @returns {Array<{date: string, intensity: number}>}
 */
export function symptomIntensityTrend(dayLogs, symptomKey) {
  const out = [];
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    for (const entry of normalizeSymptomEntries(log.symptoms)) {
      if (entry.key === symptomKey && entry.intensity != null) {
        out.push({ date: dayKey(log.log_date), intensity: entry.intensity });
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
}

/**
 * Zyklustag-Muster EINES Symptoms über die letzten `maxCycles` Zyklen
 * (Phase 4c) - beantwortet "an welchem Zyklustag taucht das typischerweise
 * auf", eine dritte Frage neben "wie oft" (symptomFrequencyByPhase) und "wie
 * stark" (symptomIntensityTrend). Zyklustage sind 1-indiziert ab dem
 * jeweiligen cycleStart, nicht Kalendertage - erst dadurch lassen sich Zyklen
 * unterschiedlicher Länge im selben Raster vergleichen.
 *
 * `occurredCount`/`totalCount` zählen ZYKLEN (nicht Einzel-Vorkommen): "in 2
 * von 3 Zyklen" - ein Symptom, das innerhalb eines Zyklus mehrfach auftaucht,
 * zählt für diesen einen Zyklus trotzdem nur einmal. `mostCommonPhase` zählt
 * dagegen jedes Einzel-Vorkommen; bei Gleichstand gewinnt Menstruation vor
 * Luteal vor Sonstige (die Sammelkategorie gewinnt einen Gleichstand nie) -
 * eine feste, dokumentierte Regel statt eines unklaren "irgendeine".
 *
 * Jeder Zyklus traegt zusaetzlich `phaseByDay` (ein Eintrag je Zyklustag,
 * 'menstruation' | 'luteal' | 'other') - eine Erweiterung ueber die im Plan
 * skizzierte `{cycleStart, cycleLength, occurredOnDays}`-Form hinaus: die
 * geplante UI (ein Raster mit phasengefaerbten Tageszellen) braucht genau
 * diese Klassifikation, und sie hier einmal mitzuliefern ist die einzige
 * Alternative zu einer dritten, im UI-Code laufenden Kopie derselben
 * Grenzen-Rekonstruktion (siehe classifyDayPhase()-Dokblock).
 *
 * `typicalDaysBeforePeriod`: die haeufigste "N Tage vor der naechsten Periode"-
 * Zahl unter den LUTEALEN Vorkommen (nutzerseitig angefragt, statt nur der
 * groben Phase - "tritt 2 Tage vorher auf" ist konkreter als "tritt in der
 * Lutealphase auf"). Nur dort ist "davor" eine natuerliche Bezugsgroesse;
 * waehrend der Menstruation oder in "Sonstige" bleibt sie unbeantwortet
 * (`null`). +1, weil der letzte Zyklustag selbst schon 1 Tag davor liegt,
 * nicht 0 Tage. Erst ab zwei Zyklen mit demselben Wert gilt es als Muster,
 * sonst `null` - ein einzelner Treffer waere Zufall, kein Befund.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} settings - cycle_settings-Zeile (für luteal_length).
 * @param {string} symptomKey
 * @param {number} [maxCycles=6]
 * @returns {{cycles: Array<{cycleStart: string, cycleLength: number, occurredOnDays: number[], phaseByDay: string[]}>,
 *            occurredCount: number, totalCount: number, mostCommonPhase: string|null,
 *            typicalDaysBeforePeriod: number|null}}
 */
export function symptomCyclePattern(dayLogs, periods, settings = {}, symptomKey, maxCycles = 6) {
  const allCycles = reconstructCycles(periods, settings);
  if (!allCycles.length) return { cycles: [], occurredCount: 0, totalCount: 0, mostCommonPhase: null, typicalDaysBeforePeriod: null };

  // Juengster Zyklus zuerst, auf maxCycles gedeckelt.
  const recent = [...allCycles].reverse().slice(0, maxCycles);
  // Nach dem CYKLUS-OBJEKT selbst indiziert, nicht nach cycleStart: zwei
  // Perioden mit identischem Startdatum (entartete, aber vom Schema nicht
  // ausgeschlossene Eingabe) haetten sonst denselben String-Schluessel und
  // teilten sich dieselbe occurredOnDays-Liste.
  const occByCycle = new Map(recent.map((c) => [c, []]));
  const phaseCounts = { [PHASE.MENSTRUATION]: 0, [PHASE.LUTEAL]: 0, other: 0 };

  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const dateKey = dayKey(log.log_date);
    const cyc = recent.find((c) => daysBetween(c.cycleStart, dateKey) >= 0 && daysBetween(dateKey, c.nextStart) > 0);
    if (!cyc) continue;
    const hasSymptom = normalizeSymptomEntries(log.symptoms).some((e) => e.key === symptomKey);
    if (!hasSymptom) continue;
    occByCycle.get(cyc).push(daysBetween(cyc.cycleStart, dateKey) + 1);
    phaseCounts[classifyDayPhase(cyc, dateKey)] += 1;
  }

  const cycles = recent.map((c) => {
    const cycleLength = daysBetween(c.cycleStart, c.nextStart);
    const phaseByDay = Array.from({ length: cycleLength }, (_, i) => classifyDayPhase(c, addLocalDays(c.cycleStart, i)));
    return {
      cycleStart: c.cycleStart,
      cycleLength,
      occurredOnDays: occByCycle.get(c).sort((a, b) => a - b),
      phaseByDay,
    };
  });

  const occurredCount = cycles.filter((c) => c.occurredOnDays.length > 0).length;
  const maxPhaseCount = Math.max(...Object.values(phaseCounts));
  const mostCommonPhase = maxPhaseCount > 0
    ? [PHASE.MENSTRUATION, PHASE.LUTEAL, 'other'].find((k) => phaseCounts[k] === maxPhaseCount)
    : null;

  // Haeufigste "N Tage vor der Periode" unter den LUTEALEN Vorkommen - "vor
  // der Periode" ist nur dort eine natuerliche Bezugsgroesse (waehrend der
  // Menstruation oder in der Sammelkategorie "Sonstige" ergibt "davor" keinen
  // intuitiven Sinn). +1, weil der letzte Zyklustag selbst schon 1 Tag vor dem
  // naechsten Periodenbeginn liegt, nicht 0. Erst ab zwei Zyklen mit demselben
  // Wert gilt das als Muster statt Zufall; bei Gleichstand gewinnt der Wert
  // aus dem juengeren Zyklus (cycles ist bereits juengster-zuerst sortiert).
  const lutealDaysBeforeCounts = new Map();
  for (const c of cycles) {
    for (const day of c.occurredOnDays) {
      if (c.phaseByDay[day - 1] !== PHASE.LUTEAL) continue;
      const daysBefore = c.cycleLength - day + 1;
      lutealDaysBeforeCounts.set(daysBefore, (lutealDaysBeforeCounts.get(daysBefore) || 0) + 1);
    }
  }
  let typicalDaysBeforePeriod = null;
  let bestCount = 1;
  for (const [daysBefore, count] of lutealDaysBeforeCounts) {
    if (count > bestCount) { bestCount = count; typicalDaysBeforePeriod = daysBefore; }
  }

  return { cycles, occurredCount, totalCount: cycles.length, mostCommonPhase, typicalDaysBeforePeriod };
}

// Mindestanteil der ELIGIBLEN Zyklen (die diesen Zyklustag ueberhaupt hatten),
// in denen ein Symptom an genau diesem Tag vorkam, bevor "typischerweise an
// Tag N" als Muster gilt - ein Anteil, kein Absolutwert, damit er unabhaengig
// von der Zyklusanzahl bleibt. Ungefaehr Clues sichtbares Verhalten; dieselbe
// undogmatische Haltung wie beim Zykluslaenge-Referenzbereich (Phase 4d) -
// kein Anspruch auf einen validierten klinischen Wert.
const LIKELIHOOD_THRESHOLD = 0.5;
// Unter zwei eligiblen Zyklen ist ein Treffer Zufall, kein Muster.
const MIN_ELIGIBLE_CYCLES_FOR_DAY = 2;

/**
 * Sagt vorher, an welchen Tagen des AKTUELLEN Zyklus ein Symptom aufgrund
 * seines bisherigen Zyklustag-Musters (symptomCyclePattern(), Phase 4c)
 * wahrscheinlich auftritt (Phase 4e) - die einzige Funktion in diesem Modul,
 * die tatsaechlich VORWAERTS vorhersagt statt Historie zusammenzufassen.
 *
 * Fuer jeden Zyklustag zaehlt nur, wie oft er unter den Zyklen vorkam, die
 * UEBERHAUPT so lang waren (kuerzere Zyklen verduennen den Anteil sonst zu
 * Unrecht) - "eligibel" statt pauschal "alle betrachteten Zyklen".
 *
 * Ohne mindestens MIN_HISTORY_GAPS betrachtete Zyklen (dieselbe Schwelle wie
 * Phase 0 fuer den Zykluslaenge-Mittelwert, statt einer vierten eigenen
 * Konstante) gibt es keine Vorhersage - nur `todayCycleDay` bleibt sinnvoll
 * berechenbar, unabhaengig von der Vorhersage-Zuverlaessigkeit.
 *
 * WORTWAHL IST HIER WICHTIGER ALS SONST IM MODUL: "wahrscheinlich" bleibt
 * eine Musteraussage ("tritt oft um diesen Tag auf"), keine medizinisch
 * klingende Prognose - dieselbe "kein Medizinprodukt"-Disziplin wie beim
 * bestehenden Fruchtbarkeitsfenster-Disclaimer.
 *
 * C-2: die gefundenen Zyklustage werden zusätzlich auf den NÄCHSTEN
 * projizierten Zyklus gemappt (nicht nur den laufenden) - sonst liegt bei
 * einem Symptom, das typischerweise zur Zyklusmitte oder später auftritt,
 * jeder Marker spätestens ab Zyklusmitte schon in der Vergangenheit (live
 * beobachtet). Der nächste Start kommt bewusst aus der KALENDERMETHODE
 * (projectFutureCycles()[0].start, derselbe Wert wie predictCycle().nextStart
 * ohne BBT-Bestätigung) - ein per Temperaturanstieg bestätigter Eisprung
 * bestätigt nur den EISPRUNG DIESES Zyklus, nie den Beginn des nächsten.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} settings - cycle_settings-Zeile.
 * @param {string} symptomKey
 * @param {string} [todayKey]
 * @returns {{likelyDates: string[], todayCycleDay: number, isLikelyToday: boolean,
 *            nextLikelyDate: string|null}}
 */
export function predictSymptomLikelihood(dayLogs, periods, settings = {}, symptomKey, todayKey = householdToday()) {
  const asc = sortPeriodsAsc(periods);
  if (!asc.length) return { likelyDates: [], todayCycleDay: 0, isLikelyToday: false, nextLikelyDate: null };

  const today = dayKey(todayKey);
  const lastStart = dayKey(asc[asc.length - 1].start_date);
  const todayCycleDay = daysBetween(lastStart, today) + 1;

  const pattern = symptomCyclePattern(dayLogs, periods, settings, symptomKey);
  if (pattern.totalCount < MIN_HISTORY_GAPS) {
    return { likelyDates: [], todayCycleDay, isLikelyToday: false, nextLikelyDate: null };
  }

  const maxDay = Math.max(...pattern.cycles.map((c) => c.cycleLength));
  const likelyDayNumbers = [];
  for (let day = 1; day <= maxDay; day++) {
    const eligible = pattern.cycles.filter((c) => c.cycleLength >= day);
    if (eligible.length < MIN_ELIGIBLE_CYCLES_FOR_DAY) continue;
    const hits = eligible.filter((c) => c.occurredOnDays.includes(day)).length;
    if (hits / eligible.length >= LIKELIHOOD_THRESHOLD) likelyDayNumbers.push(day);
  }

  const nextProjected = projectFutureCycles(asc, settings, today)[0] || null;

  const likelyDates = likelyDayNumbers.map((day) => addLocalDays(lastStart, day - 1));
  if (nextProjected) {
    for (const day of likelyDayNumbers) likelyDates.push(addLocalDays(nextProjected.start, day - 1));
  }

  const isLikelyToday = likelyDayNumbers.includes(todayCycleDay);
  const futureDates = likelyDates.filter((d) => daysBetween(today, d) > 0).sort();
  const nextLikelyDate = futureDates.length ? futureDates[0] : null;

  return { likelyDates, todayCycleDay, isLikelyToday, nextLikelyDate };
}

/**
 * Erkennt den Temperaturanstieg, der einen Eisprung bestätigt (Coverline-
 * Methode): der erste Tag, dessen Wert mindestens TEMP_SHIFT_THRESHOLD_C ueber
 * dem Mittel der TEMP_BASELINE_READINGS vorangehenden (niedrigeren) Messungen
 * liegt, sofern die naechsten TEMP_SUSTAINED_DAYS − 1 Tage denselben Schwellwert
 * halten. Arbeitet auf der REIHENFOLGE der tatsaechlich geloggten Messungen,
 * nicht auf Kalendertagen - fehlende Tage sind damit kein Sonderfall.
 *
 * Bewusst KEINE Ausnahme-Regel fuer einen einzelnen Ausreisser-Tag (wie echte
 * Fruchtbarkeitsbewusstsein-Methoden sie kennen) - eine einfache, nachvoll-
 * ziehbare Regel statt einer zweiten, die niemand ohne Anleitung nachrechnen
 * kann. Rauschen (ein Tag unter der Schwelle innerhalb der drei) lässt diesen
 * Kandidaten scheitern; die Schleife prüft den nächsten möglichen Starttag.
 *
 * @param {Array<Object>} dayLogs  - cycle_day_logs-Zeilen (log_date, basal_temp, basal_temp_unit).
 * @param {string} cycleStart      - Beginn des aktuellen Zyklus (YYYY-MM-DD); Messungen davor zählen nicht.
 * @returns {string|null} Datum (YYYY-MM-DD) des ersten Tages im Anstieg, oder null ohne hinreichenden Befund.
 */
export function detectTemperatureShift(dayLogs, cycleStart) {
  const readings = temperatureReadings(dayLogs, cycleStart);

  if (readings.length < TEMP_BASELINE_READINGS + TEMP_SUSTAINED_DAYS) return null;

  for (let i = TEMP_BASELINE_READINGS; i <= readings.length - TEMP_SUSTAINED_DAYS; i += 1) {
    const baseline = mean(readings.slice(i - TEMP_BASELINE_READINGS, i).map((r) => r.celsius));
    if (baseline == null) continue;
    const threshold = baseline + TEMP_SHIFT_THRESHOLD_C;
    const sustained = readings.slice(i, i + TEMP_SUSTAINED_DAYS).every((r) => r.celsius >= threshold);
    if (sustained) return readings[i].date;
  }
  return null;
}

// --------------------------------------------------------
// Vorhersage
// --------------------------------------------------------

/** Unterdrückt die eingestellte Verhütungsmethode die Fruchtbarkeits-Vorhersage?
 * HORMONAL_CONTRACEPTION_VALUES (oben bei den Preset-Definitionen aus
 * CONTRACEPTION_TYPES abgeleitet) ist die einzige Quelle dieser Teilmenge.
 * Exportiert, damit server/services/cycle-ics.js dieselbe Regel anwendet wie
 * predictCycle() unten - der abonnierte Feed soll nicht weiter Eisprung-/
 * Fruchtbares-Fenster-Termine verschicken, waehrend der Zyklus-Tab selbst die
 * Vorhersage pausiert. */
export function suppressesFertility(settings = {}) {
  return HORMONAL_CONTRACEPTION_VALUES.includes(settings?.contraception);
}

/**
 * EINE Regel für den Anker-Periodenstart, den sowohl
 * predictCycle() als auch projectFutureCycles() brauchen - der jüngste
 * Periodenstart, der NICHT in der Zukunft liegt (sonst, mangels eines
 * vergangenen Starts, der jüngste überhaupt). Vorher hatte projectFutureCycles()
 * eine zweite, einfachere Kopie (immer der allerletzte Eintrag, auch wenn er
 * in der Zukunft lag), die bei einer bereits im Voraus geloggten Periode ein
 * ANDERES Ankerdatum lieferte als predictCycle() - buildCycleCalendar()s
 * `projected.slice(1)` verwarf dadurch ein echtes Fenster und malte
 * stattdessen ein Fenster mit dem falschen (zukünftigen) Anker direkt neben
 * die geloggte künftige Periode. Mit einer einzigen Regel liefert
 * projectFutureCycles()[0] jetzt exakt denselben Start wie predictCycle()s
 * `nextStart`.
 * @param {Array<Object>} asc - aufsteigend sortierte Perioden (sortPeriodsAsc()).
 * @param {string} today - Referenz-„heute" (YYYY-MM-DD, bereits normalisiert).
 * @returns {string} YYYY-MM-DD
 */
function latestNonFutureStart(asc, today) {
  const past = asc.filter((p) => daysBetween(p.start_date, today) >= 0);
  const anchor = past.length ? past[past.length - 1] : asc[asc.length - 1];
  return dayKey(anchor.start_date);
}

/**
 * Leitet den aktuellen Zyklusstand + die Vorhersagen ab.
 * Kalendermethode: Eisprung = nächster Periodenstart − Lutealphase; fruchtbares
 * Fenster = Eisprungtag und die 5 Tage davor. Rein statistische Schätzung -
 * bestätigt ein Temperaturanstieg (detectTemperatureShift()) den Eisprung des
 * LAUFENDEN Zyklus, ersetzt dessen Datum das kalendarische (`ovulationConfirmed:
 * true`); künftige Zyklen bleiben Kalendermethode, da es für sie noch keine
 * Messwerte geben kann.
 *
 * Verhütung: eine HORMONELLE Verhütungsmethode (siehe
 * HORMONAL_CONTRACEPTION_VALUES) schaltet Eisprung/fruchtbares Fenster genauso
 * ab wie `track_fertility: 0` - `trackFertility` bleibt der EINE Schalter, den
 * cycleRing()/buildCycleCalendar() schon abfragen, `fertilitySuppressed`
 * dokumentiert zusätzlich WARUM ('contraception' oder `null`), damit das UI
 * das nicht einfach kommentarlos verschwinden lässt.
 *
 * Perimenopause: ist `settings.perimenopause_mode` gesetzt UND liegen
 * mindestens MIN_HISTORY_GAPS plausible Lücken vor (cycleStats().
 * plausibleGapCount - siehe dort), kommt zusätzlich `nextStartRange` dazu:
 * eine Spanne aus dem TATSÄCHLICHEN Min/Max der jüngsten plausiblen Lücken
 * (cycleStats().minCycle/maxCycle, keine zweite Berechnung) auf den Anker-
 * Start angewendet. `nextStart` bleibt UNVERÄNDERT der Mittelwert-basierte Wert
 * (Abwärtskompatibilität für bestehende Aufrufer). Die Typisch/Atypisch-Badge-
 * Entscheidung aus dieser Spanne ist bewusst Sache des UI, nicht dieser Funktion.
 *
 * @param {Array<Object>} periods - Perioden-Historie (start_date/end_date).
 * @param {Object} settings       - cycle_settings-Zeile (kann leer sein).
 * @param {string} [todayKey]     - Referenz-„heute" (YYYY-MM-DD), Default: heute.
 * @param {Array<Object>} [dayLogs] - Tages-Logs (fuer die BBT-Bestätigung; ohne sie bleibt es Kalendermethode).
 * @returns {Object} { hasData, ..., fertilitySuppressed, perimenopause, nextStartRange }
 */
export function predictCycle(periods, settings = {}, todayKey = householdToday(), dayLogs = []) {
  const asc = sortPeriodsAsc(periods);
  const today = dayKey(todayKey);
  const stats = cycleStats(asc, settings, today);
  const pregnancy = pregnancyInfo(settings, today);
  const contraceptionSuppresses = suppressesFertility(settings);
  const fertilitySuppressed = contraceptionSuppresses ? 'contraception' : null;

  // Schwangerschafts-Modus hält alle Vorhersagen an — es gibt keinen „nächsten
  // Periodenstart", keinen Eisprung und kein fruchtbares Fenster. Die Historie
  // bleibt erhalten (hasData spiegelt vorhandene Perioden), damit das UI nach
  // der Schwangerschaft nahtlos weiterrechnet.
  if (pregnancy.active) {
    return { hasData: !!asc.length, isPregnant: true, pregnancy, stats, trackFertility: false, fertilitySuppressed };
  }

  if (!asc.length) {
    return {
      hasData: false, isPregnant: false, pregnancy, stats,
      trackFertility: stats.trackFertility && !contraceptionSuppresses,
      fertilitySuppressed,
    };
  }

  // Jüngster Periodenstart, der nicht in der Zukunft liegt (sonst der jüngste)
  // - latestNonFutureStart() (Fix 5), dieselbe Regel wie projectFutureCycles().
  const lastStart = latestNonFutureStart(asc, today);

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

  // Hormonelle Verhütung schaltet die Fruchtbarkeits-Ausgabe genauso ab
  // wie track_fertility=0 - beide fließen in DENSELBEN Schalter ein, den
  // cycleRing()/buildCycleCalendar() bereits abfragen (siehe HORMONAL_
  // CONTRACEPTION_VALUES-Dokblock oben).
  const trackFertility = stats.trackFertility && !contraceptionSuppresses;
  let ovulationDate = addLocalDays(nextStart, -lutealLength);
  let ovulationConfirmed = false;
  if (trackFertility) {
    const confirmed = detectTemperatureShift(dayLogs, lastStart);
    if (confirmed) { ovulationDate = confirmed; ovulationConfirmed = true; }
  }
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

  // Perimenopause-Bereich - zusätzlich zum mittelwert-basierten
  // `nextStart` (unverändert, Abwärtskompatibilität) eine Spanne aus dem
  // TATSÄCHLICHEN Min/Max der jüngsten plausiblen Lücken (cycleStats(), keine
  // zweite Berechnung), erst ab MIN_HISTORY_GAPS plausiblen Lücken - sonst
  // wäre die Spanne aus zu wenigen Datenpunkten geraten statt abgeleitet.
  // `perimenopause` spiegelt dagegen NUR die Einstellung (auch ohne
  // ausreichende Historie schon "an", damit das UI z.B. "sammle noch Daten"
  // anzeigen kann statt den Modus fälschlich als aus zu behandeln).
  const perimenopauseMode = !!(settings.perimenopause_mode === 1 || settings.perimenopause_mode === true);
  const nextStartRange = (perimenopauseMode && stats.plausibleGapCount >= MIN_HISTORY_GAPS)
    ? { min: addLocalDays(lastStart, stats.minCycle), max: addLocalDays(lastStart, stats.maxCycle) }
    : null;

  return {
    hasData: true,
    isPregnant: false,
    pregnancy,
    stats,
    trackFertility,
    fertilitySuppressed,
    lastStart,
    cycleDay,
    avgCycle,
    avgPeriod,
    lutealLength,
    nextStart,
    daysUntilNext,
    ovulationDate: trackFertility ? ovulationDate : null,
    ovulationConfirmed: trackFertility ? ovulationConfirmed : false,
    fertileStart: trackFertility ? fertileStart : null,
    fertileEnd: trackFertility ? fertileEnd : null,
    daysUntilOvulation: trackFertility ? daysBetween(today, ovulationDate) : null,
    phase,
    inLoggedPeriod,
    isPredictedOverdue: daysUntilNext < 0,
    perimenopause: perimenopauseMode,
    nextStartRange,
  };
}

// --------------------------------------------------------
// Monatskalender
// --------------------------------------------------------

/**
 * Datumsspanne EINER Periode: abgeschlossen → start_date..end_date, offen
 * (kein end_date, laeuft noch) → start_date..start_date+avgPeriod-1. Von
 * loggedPeriodPhase() (Kalenderzellen) UND periodFlowSummary() (B-2,
 * Historie-Chip) geteilt, statt die "offene Episode" Regel zweimal zu pflegen.
 */
function periodDateRange(period, avgPeriod) {
  const s = dayKey(period.start_date);
  const e = period.end_date ? dayKey(period.end_date) : addLocalDays(s, avgPeriod - 1);
  return { start: s, end: e };
}

/** Deckt ein Datum eine geloggte Periode ab? (offene Episode → avgPeriod Tage). */
function loggedPeriodPhase(dateKey, periodsAsc, avgPeriod) {
  return periodsAsc.some((p) => {
    const { start: s, end: e } = periodDateRange(p, avgPeriod);
    return daysBetween(s, dateKey) >= 0 && daysBetween(dateKey, e) >= 0;
  });
}

/**
 * B-2/B-3: Blutungsstärke-Kennzahlen EINER Periode in
 * EINEM Durchlauf über ihre Log-Spanne (periodDateRange(), dieselbe "offene
 * Episode laeuft avgPeriod Tage"-Regel wie loggedPeriodPhase()) - stärkster
 * geloggter Flow-Wert (B-2, Historie-Chip) UND die Summe der FLOW_LEVELS-
 * Ränge (B-3, Blutungslast-Trend: "insgesamt stärker/schwächer geworden" statt
 * nur "stärkster Tag" - ein einzelner starker Tag in einer sonst leichten
 * Periode soll die Last nicht wie einen durchgehend starken Zyklus aussehen
 * lassen). periodFlowSummary()/periodFlowLoad() waren bislang zwei fast
 * identische Schleifen über dieselbe Spanne; sie bleiben als dünne Wrapper
 * bestehen (kleinerer Diff an den bestehenden Aufrufstellen in health.js).
 *
 * @param {Object} period - eine Zeile aus cycle.periods (start_date, end_date?).
 * @param {Array<Object>} logs - cycle_day_logs (log_date, flow).
 * @param {number} [avgPeriod=DEFAULT_PERIOD] - Fallback-Länge einer offenen
 *        Episode; Aufrufer sollten cycleStats(...).avgPeriod durchreichen,
 *        wenn bekannt (History kennt die echte Zyklushistorie).
 * @returns {{heaviest: string|null, load: number, loggedDays: number}|null}
 *          null, wenn im Zeitraum kein einziger Tag einen Flow-Wert trägt.
 */
export function periodFlowStats(period, logs, avgPeriod = DEFAULT_PERIOD) {
  const { start, end } = periodDateRange(period, avgPeriod);
  let heaviestRank = 0;
  let heaviest = null;
  let load = 0;
  let loggedDays = 0;
  for (const log of (logs || [])) {
    if (!log?.flow || !log.log_date) continue;
    const d = dayKey(log.log_date);
    if (daysBetween(start, d) < 0 || daysBetween(d, end) < 0) continue;
    loggedDays += 1;
    const level = flowLevel(log.flow);
    if (level) {
      load += level.rank;
      if (level.rank > heaviestRank) { heaviestRank = level.rank; heaviest = level.value; }
    }
  }
  return loggedDays ? { heaviest, load, loggedDays } : null;
}

/** Dünner Wrapper um periodFlowStats() - nur der stärkste Flow-Wert + Anzahl geloggter Tage (B-2, Historie-Chip). */
export function periodFlowSummary(period, logs, avgPeriod = DEFAULT_PERIOD) {
  const stats = periodFlowStats(period, logs, avgPeriod);
  return stats ? { heaviest: stats.heaviest, loggedDays: stats.loggedDays } : null;
}

/** Dünner Wrapper um periodFlowStats() - nur die Blutungslast + Anzahl geloggter Tage (B-3, Trend). */
export function periodFlowLoad(period, logs, avgPeriod = DEFAULT_PERIOD) {
  const stats = periodFlowStats(period, logs, avgPeriod);
  return stats ? { load: stats.load, loggedDays: stats.loggedDays } : null;
}

// Letzten wie vielen ABGESCHLOSSENEN Episoden das Blutungsstärke-Muster
// (heavyBleedingSignal()) betrachtet - 5 ist großzügig genug für ein Muster,
// ohne uralte Historie mitzuziehen, die für die aktuelle Situation nichts
// mehr aussagt.
const HEAVY_BLEEDING_LOOKBACK = 5;
// Ab wie vielen "schweren" Episoden unter den betrachteten das Muster gilt -
// zwei von fünf wäre noch im Rahmen normaler Schwankung, drei ein wiederholter
// Befund.
const HEAVY_BLEEDING_MIN_HEAVY_COUNT = 3;
// Eine Periode über 7 Tage gilt in gängiger Patientenaufklärung (z. B.
// ACOG-nahe Quellen) als "verlängert" - dieselbe undogmatische Haltung wie
// TYPICAL_CYCLE_RANGE, kein Anspruch auf einen klinisch validierten Wert.
const LONG_PERIOD_THRESHOLD_DAYS = 7;

/**
 * B-4: ruhiges Muster-Prädikat für den ergänzenden Hinweis "das mit einem Arzt
 * besprechen" - KEINE Diagnose, dieselbe Zurückhaltung wie der übrige
 * "kein Medizinprodukt"-Disclaimer. Betrachtet nur ABGESCHLOSSENE Episoden
 * (end_date gesetzt) - eine noch laufende Periode ist weder als "schwer" noch
 * als "lang" fertig beobachtet. 'heavy' hat Vorrang vor 'long', wenn beides
 * zuträfe - die UI zeigt ohnehin nur EINEN Hinweis, keine Rangfolge sonst nötig.
 * @param {Array<Object>} periods
 * @param {Array<Object>} logs
 * @returns {false|'heavy'|'long'}
 */
export function heavyBleedingSignal(periods, logs) {
  const completed = sortPeriodsAsc(periods).filter((p) => p.end_date).slice(-HEAVY_BLEEDING_LOOKBACK);
  if (!completed.length) return false;

  const heavyCount = completed.filter((p) => periodFlowSummary(p, logs)?.heaviest === 'heavy').length;
  if (heavyCount >= HEAVY_BLEEDING_MIN_HEAVY_COUNT) return 'heavy';

  const hasLongEpisode = completed.some((p) => daysBetween(p.start_date, p.end_date) + 1 > LONG_PERIOD_THRESHOLD_DAYS);
  if (hasLongEpisode) return 'long';

  return false;
}

// Die vier schmerzbezogenen Symptom-Presets - eine feste, kleine Liste
// (kein weiteres Preset-Feld auf SYMPTOM_TYPES, das jedes andere Symptom auch
// bräuchte, nur um an EINER Stelle vier Werte auszuzeichnen).
export const PAIN_SYMPTOM_VALUES = Object.freeze(['cramps', 'headache', 'backache', 'joint_pain']);

/**
 * Schmerz-Zusammenfassung über die vier schmerzbezogenen Symptome
 * (PAIN_SYMPTOM_VALUES) - EIN kompaktes Feld statt vier Einzel-Trends.
 * "Schmerztage" zählt TAGE, nicht Einzel-Einträge: ein Tag mit zwei
 * Schmerz-Symptomen zählt trotzdem nur einmal (dieselbe Zählweise wie
 * symptomCyclePattern()s `occurredOnDays`).
 *
 * `currentCyclePainDays`: Schmerztage seit Beginn des laufenden (jüngsten
 * geloggten) Zyklus bis `todayKey`.
 * `avgPainDaysPerCycle`: Mittel der Schmerztage über die ABGESCHLOSSENEN
 * Zyklen (alle außer dem laufenden) - `null` ohne einen einzigen.
 * `avgIntensity`: Mittel ALLER gradierten Schmerz-Vorkommen, unabhängig vom
 * Zyklus - ein einzelner Zyklus hätte oft zu wenige gradierte Werte für ein
 * aussagekräftiges Mittel.
 *
 * `null` als Ganzes, wenn noch nie ein Schmerz-Symptom geloggt wurde - keine
 * Kachel ohne jede Grundlage.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @param {string} [todayKey]
 * @returns {{currentCyclePainDays: number, avgPainDaysPerCycle: number|null, avgIntensity: number|null}|null}
 */
export function painSummary(dayLogs, periods, settings = {}, todayKey = householdToday()) {
  const isPainEntry = (entry) => PAIN_SYMPTOM_VALUES.includes(entry.key);
  const painEntriesOf = (log) => normalizeSymptomEntries(log?.symptoms).filter(isPainEntry);

  const hasAnyPain = (dayLogs || []).some((log) => painEntriesOf(log).length > 0);
  if (!hasAnyPain) return null;

  const cycles = reconstructCycles(periods, settings);
  const today = dayKey(todayKey);

  // Schmerztage je rekonstruiertem Zyklus (ein Set aus Datumsschlüsseln - ein
  // Tag mit mehreren Schmerz-Symptomen zählt trotzdem nur einmal).
  const painDaysByCycle = cycles.map(() => new Set());
  const intensities = [];
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const entries = painEntriesOf(log);
    if (!entries.length) continue;
    for (const e of entries) if (e.intensity != null) intensities.push(e.intensity);
    const dk = dayKey(log.log_date);
    const idx = cycles.findIndex((c) => daysBetween(c.cycleStart, dk) >= 0 && daysBetween(dk, c.nextStart) > 0);
    if (idx >= 0) painDaysByCycle[idx].add(dk);
  }

  // Laufender Zyklus = der letzte rekonstruierte (dessen `nextStart` bei einer
  // noch nicht begonnenen Folgeperiode aus dem Ø-Zyklus geschätzt ist, siehe
  // reconstructCycles()) - Schmerztage darin nur bis heute zählen, ein "Tag"
  // in der Zukunft hat ohnehin keinen Log.
  const currentIdx = cycles.length - 1;
  const currentCyclePainDays = currentIdx >= 0
    ? [...painDaysByCycle[currentIdx]].filter((dk) => daysBetween(dk, today) >= 0).length
    : 0;

  // Ø nur über ABGESCHLOSSENE Zyklen (alle außer dem laufenden) - der laufende
  // ist noch nicht fertig beobachtet und würde den Schnitt sonst systematisch
  // nach unten ziehen.
  const pastCounts = painDaysByCycle.slice(0, -1).map((s) => s.size);
  const avgPainDaysPerCycle = pastCounts.length ? mean(pastCounts) : null;

  return { currentCyclePainDays, avgPainDaysPerCycle, avgIntensity: mean(intensities) };
}

// Mindestanzahl VERSCHIEDENER abgeschlossener Zyklen mit einer gradierten
// Auswahl an genau diesem Zyklustag, bevor "dein staerkster Schmerztag" als
// Muster gilt - ein einzelner starker Nachmittag ist Zufall, kein Befund
// (dieselbe Zurueckhaltung wie MIN_ELIGIBLE_CYCLES_FOR_DAY bei
// predictSymptomLikelihood()).
const MIN_CYCLES_FOR_PEAK_PAIN_DAY = 2;
// Ab dieser Ø-Intensitaet (Skala 1-3, siehe INTENSITY_LEVELS) gilt ein Tag
// ueberhaupt erst als schmerzhaft genug fuer die Aussage - "mild" (Ø < 2)
// waere keine "staerkster Schmerztag"-Behauptung wert.
const MIN_AVG_INTENSITY_FOR_PEAK_PAIN_DAY = 2;

/**
 * Der Zyklustag, an dem die Schmerz-Symptome (PAIN_SYMPTOM_VALUES) laut
 * Historie im Mittel am staerksten ausfallen - fuer die Today-Bubble
 * ("heute ist laut deinem Muster oft dein staerkster Schmerztag").
 *
 * Nur ABGESCHLOSSENE Zyklen zaehlen (reconstructCycles() ohne den letzten,
 * laufenden Eintrag - derselbe Grund wie bei painSummary()s
 * `avgPainDaysPerCycle`: ein noch nicht fertig beobachteter Zyklus wuerde das
 * Mittel verzerren, nicht bestaetigen). Je Schmerz-Symptom UND Zyklustag wird
 * ueber alle GRADIERTEN (1-3) Vorkommen der abgeschlossenen Zyklen gemittelt;
 * eine ungradierte Auswahl traegt keine Intensitaet bei (dieselbe Regel wie
 * `avgIntensity` in painSummary()/frequencyByPhase()). Der Tag mit dem
 * hoechsten Mittel gewinnt, aber erst ab MIN_CYCLES_FOR_PEAK_PAIN_DAY
 * verschiedenen Zyklen MIT gradierter Auswahl an genau diesem Tag und einem
 * Mittel ab MIN_AVG_INTENSITY_FOR_PEAK_PAIN_DAY - sonst `null`.
 *
 * Bei Gleichstand gewinnt der FRUEHERE Zyklustag (aufsteigende Tagesschleife,
 * nur ein STRENG hoeheres Mittel ersetzt den bisherigen Bestwert); bei einem
 * Gleichstand zwischen zwei Symptomen am selben Tag gewinnt das Symptom, das
 * zuerst in PAIN_SYMPTOM_VALUES steht - beides eine feste, willkuerliche, aber
 * deterministische Regel statt eines unklaren "irgendeins".
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {{cycleDay: number, symptomKey: string, avgIntensity: number, cycles: number}|null}
 */
export function peakPainDay(dayLogs, periods, settings = {}) {
  const allCycles = reconstructCycles(periods, settings);
  // Der letzte Eintrag ist der laufende Zyklus (siehe Dokblock) - hier immer
  // ausgeschlossen, unabhaengig von "heute", weil diese Funktion rein aus der
  // Historie ableitet; der Aufrufer vergleicht das Ergebnis selbst gegen den
  // aktuellen Zyklustag.
  const pastCycles = allCycles.slice(0, -1);
  if (pastCycles.length < MIN_CYCLES_FOR_PEAK_PAIN_DAY) return null;

  // Eimer je (Symptom, Zyklustag): gradierte Intensitaeten + welche Zyklen
  // (per Index) ueberhaupt beigetragen haben - Letzteres zaehlt VERSCHIEDENE
  // Zyklen, nicht Einzel-Eintraege (ein Symptom kommt je Tag ohnehin nur
  // einmal normalisiert vor, siehe normalizeSymptomEntries()).
  const buckets = new Map();
  let maxDay = 0;
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const dk = dayKey(log.log_date);
    const cycIdx = pastCycles.findIndex((c) => daysBetween(c.cycleStart, dk) >= 0 && daysBetween(dk, c.nextStart) > 0);
    if (cycIdx < 0) continue;
    const day = daysBetween(pastCycles[cycIdx].cycleStart, dk) + 1;
    if (day > maxDay) maxDay = day;
    for (const entry of normalizeSymptomEntries(log.symptoms)) {
      if (!PAIN_SYMPTOM_VALUES.includes(entry.key) || entry.intensity == null) continue;
      const key = `${entry.key}|${day}`;
      let b = buckets.get(key);
      if (!b) { b = { intensities: [], cycleIdxs: new Set() }; buckets.set(key, b); }
      b.intensities.push(entry.intensity);
      b.cycleIdxs.add(cycIdx);
    }
  }

  let best = null;
  for (let day = 1; day <= maxDay; day += 1) {
    for (const symptomKey of PAIN_SYMPTOM_VALUES) {
      const b = buckets.get(`${symptomKey}|${day}`);
      if (!b || b.cycleIdxs.size < MIN_CYCLES_FOR_PEAK_PAIN_DAY) continue;
      const avgIntensity = mean(b.intensities);
      if (avgIntensity < MIN_AVG_INTENSITY_FOR_PEAK_PAIN_DAY) continue;
      // Strikt groesser statt >=: die aufsteigende Tagesschleife trifft den
      // frueheren Tag zuerst, ein Gleichstand darf ihn deshalb nicht verdraengen.
      if (!best || avgIntensity > best.avgIntensity) {
        best = { cycleDay: day, symptomKey, avgIntensity, cycles: b.cycleIdxs.size };
      }
    }
  }
  return best;
}

/**
 * Projiziert die nächsten drei Zyklen (Periode, Eisprung, fruchtbares Fenster)
 * rein nach der Kalendermethode - die Formel stand bisher inline in
 * buildCycleCalendar() (die sie jetzt von hier aufruft) und braucht der
 * ICS-Feed (Phase 5, server/services/cycle-ics.js) für denselben Horizont.
 * Eine dritte Kopie derselben Rechnung wäre die Alternative gewesen.
 *
 * Leer im Schwangerschafts-Modus oder ganz ohne Historie - keine Projektion
 * ohne Basis, dieselbe Regel wie predictCycle()/buildCycleCalendar() schon
 * immer befolgt haben.
 *
 * @param {Array<Object>} periods
 * @param {Object} [settings]
 * @param {string} [todayKey]
 * @returns {Array<{start: string, end: string, ovulation: string, fertileStart: string, fertileEnd: string}>}
 */
export function projectFutureCycles(periods, settings = {}, todayKey = householdToday()) {
  const asc = sortPeriodsAsc(periods);
  if (!asc.length || pregnancyInfo(settings, todayKey).active) return [];

  const stats = cycleStats(asc, settings, todayKey);
  // Fix 5: derselbe Anker wie predictCycle() (latestNonFutureStart(), s.o.) -
  // vorher war es hier immer der allerletzte Eintrag, auch wenn dessen Start
  // in der Zukunft lag (siehe Dokblock dort für den dadurch entstandenen
  // Kalender-Bug).
  const lastStart = latestNonFutureStart(asc, dayKey(todayKey));
  const projected = [];
  for (let k = 1; k <= 3; k += 1) {
    const start = addLocalDays(lastStart, stats.avgCycle * k);
    const ovulation = addLocalDays(start, -stats.lutealLength);
    projected.push({
      start,
      end: addLocalDays(start, stats.avgPeriod - 1),
      ovulation,
      fertileStart: addLocalDays(ovulation, -(FERTILE_WINDOW_DAYS - 1)),
      fertileEnd: ovulation,
    });
  }
  return projected;
}

/**
 * Baut das Monatsraster (6 Wochen) für den Monat um `anchorKey`. Jede Zelle trägt
 * ihre Phase (farbcodiert) und – sofern vorhanden – den Tages-Log (Flow).
 * Vorhergesagte Perioden/Eisprünge werden über bis zu drei Folgezyklen projiziert,
 * damit ein Monat vollständig eingefärbt ist.
 *
 * A-1: das Eisprung-/fruchtbare Fenster des AKTUELLEN Zyklus (des ersten, noch
 * offenen Fensters nach der letzten geloggten Periode) kommt NICHT mehr aus
 * der reinen Kalendermethode (projectFutureCycles()[0]), sondern aus
 * predictCycle() - derselben Rechnung, die auch Hero/Ring (cycleRing())
 * anzeigen, inklusive einer BBT-Bestätigung (detectTemperatureShift()). Ohne
 * diese Angleichung widersprachen sich Kalender und Ring, sobald ein
 * Temperaturanstieg den Eisprung bestätigte: beide Rechnungen liefern
 * zufällig dasselbe Datum, solange NICHTS bestätigt ist (beide nutzen
 * `nextStart − lutealLength`), aber predictCycle() ersetzt dieses Datum durch
 * den Messwert, projectFutureCycles() kann das nicht (sie kennt nur die
 * Kalendermethode). Cells des bestätigten Fensters tragen `confirmed: true,
 * predicted: false` - sie sind ein MESSWERT, keine Vorhersage mehr. Ab dem
 * ZWEITEN projizierten Zyklus (`k>=2`) bleibt es bei der reinen
 * Kalendermethode, da es für die Zukunft naturgemäß noch keine Messwerte
 * geben kann; die Periodenprojektion selbst (Blutung) bleibt für ALLE drei
 * Folgezyklen unverändert Kalendermethode - ein bestätigter Eisprung bestätigt
 * nur den Eisprung, nie den nächsten Periodenbeginn.
 *
 * Eine hormonelle Verhütungsmethode unterdrückt die Fruchtbarkeits-
 * Anzeige genauso wie im Ring/Hero (siehe predictCycle()) - dieselbe Prüfung
 * gilt hier auch für die reine Kalender-Projektion der Folgezyklen, sonst
 * widerspräche der Kalender dem Ring in genau demselben Fall.
 *
 * @param {string} anchorKey - Datum im Zielmonat (YYYY-MM-DD).
 * @param {Object} opts
 * @param {Array}  opts.periods
 * @param {Array}  opts.logs      - cycle_day_logs (für Flow-Punkte + BBT).
 * @param {Object} opts.settings
 * @param {string} [opts.todayKey]
 * @param {number} [opts.weekStartsOn=1]
 * @returns {{ month, weeks: Array<Array<Object>> }}
 */
export function buildCycleCalendar(anchorKey, { periods = [], logs = [], settings = {}, todayKey = householdToday(), weekStartsOn = 1 } = {}) {
  const asc = sortPeriodsAsc(periods);
  const stats = cycleStats(asc, settings, todayKey);
  const { avgPeriod } = stats;
  const today = dayKey(todayKey);

  const logByDate = new Map();
  for (const l of (logs || [])) {
    if (l && l.log_date) logByDate.set(dayKey(l.log_date), l);
  }

  // Projizierte Zyklen (nur zukünftige, ab dem letzten geloggten Start) -
  // dieselbe Projektion wie projectFutureCycles() (Phase 5 braucht denselben
  // Horizont fuer den ICS-Feed), hier nur aufgerufen statt inline wiederholt.
  // Für die BLUTUNG gelten weiterhin ALLE drei (Kalendermethode, s.o.).
  const projected = projectFutureCycles(asc, settings, today);
  // Eisprung/fruchtbares Fenster des ERSTEN (aktuellen) Fensters kommt aus
  // predictCycle() (s. Dokblock); die übrigen (k>=2) bleiben reine Projektion.
  const currentPrediction = predictCycle(asc, settings, today, logs);
  const futureFertileWindows = projected.slice(1);
  // predictCycle() liefert `trackFertility` bereits in
  // JEDEM Zweig korrekt (auch hasData=false und Schwangerschaft, siehe dessen
  // Dokblock/Rückgaben) - die vorige Ternary hier duplizierte dieselbe
  // Umschaltung (Einstellung UND Verhütungs-Unterdrückung) ein zweites Mal.
  const trackFertility = currentPrediction.trackFertility;

  const anchor = dayKey(anchorKey);
  const monthStr = anchor.slice(0, 7); // YYYY-MM
  const firstOfMonth = `${monthStr}-01`;
  const gridStart = startOfLocalWeekKey(firstOfMonth, weekStartsOn);

  const cell = (dateKey) => {
    const inMonth = dateKey.slice(0, 7) === monthStr;
    const log = logByDate.get(dateKey) || null;

    let phase = null;
    let predicted = false;
    let confirmed = false;
    if (loggedPeriodPhase(dateKey, asc, avgPeriod)) {
      phase = PHASE.MENSTRUATION;
    } else {
      // Blutung: für ALLE projizierten Folgezyklen reine Kalendermethode - ein
      // bestätigter Eisprung sagt nichts über den nächsten Periodenbeginn aus.
      for (const c of projected) {
        if (daysBetween(c.start, dateKey) >= 0 && daysBetween(dateKey, c.end) >= 0) { phase = PHASE.MENSTRUATION; predicted = true; break; }
      }

      if (!phase && trackFertility) {
        if (
          currentPrediction.fertileStart
          && daysBetween(currentPrediction.fertileStart, dateKey) >= 0
          && daysBetween(dateKey, currentPrediction.fertileEnd) >= 0
        ) {
          // Aktuelles Fenster: bestätigt ODER kalendarisch, je nachdem, was
          // predictCycle() geliefert hat (siehe Dokblock oben).
          phase = daysBetween(currentPrediction.ovulationDate, dateKey) === 0 ? PHASE.OVULATION : PHASE.FERTILE;
          confirmed = !!currentPrediction.ovulationConfirmed;
          predicted = !confirmed;
        } else {
          // Folgezyklen (k>=2): reine Kalendermethode, nie "confirmed".
          for (const c of futureFertileWindows) {
            if (daysBetween(c.ovulation, dateKey) === 0) { phase = PHASE.OVULATION; predicted = true; break; }
            if (daysBetween(c.fertileStart, dateKey) >= 0 && daysBetween(dateKey, c.fertileEnd) >= 0) { phase = PHASE.FERTILE; predicted = true; break; }
          }
        }
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
      // A-1: true nur für das per BBT bestätigte Fenster des aktuellen Zyklus -
      // eine Vorhersage (`predicted`) und eine Bestätigung (`confirmed`)
      // schließen sich für eine Zelle gegenseitig aus (siehe Dokblock oben).
      confirmed,
      flow: log?.flow || null,
      // symptoms und feelings sind seit Phase 2 Arrays ({key,...}[] bzw.
      // string[], vom Server zusammengesetzt) - ein LEERES Array ist in JS
      // wahr, `.length` ist die eigentliche Frage "gibt es welche". `mood`
      // bleibt als Legacy-Fallback für alte, noch nicht neu gespeicherte
      // Einträge relevant (R2: eine Speicherung ohne `feelings`/`mood`-Key
      // lässt `mood` unangetastet, ein Speichern mit diesen Keys löscht es
      // aber ohne Ersatz in `feelings` zu schreiben - ein reiner
      // Feelings/Zervixschleim/Test-Tag hätte sonst keinen Punkt im
      // Kalender, obwohl echte Daten geloggt wurden).
      hasLog: !!log && !!(
        log.flow
        || log.symptoms?.length
        || log.feelings?.length
        || log.mood
        || log.note
        || log.cervix_mucus
        || log.lh_test
        || log.pregnancy_test
        || log.basal_temp
      ),
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
    // Kalendermethode: Zyklustag des Eisprungs = Zykluslänge − Lutealphase.
    // Bei bestätigtem Anstieg (Phase 3) zählt stattdessen der TATSÄCHLICHE
    // Zyklustag des bestätigten Datums - sonst zeigte der Ring weiter die
    // kalendarische Position, obwohl ein Messwert etwas anderes belegt.
    let ovDay = total - prediction.lutealLength;
    if (prediction.ovulationConfirmed && prediction.lastStart && prediction.ovulationDate) {
      ovDay = daysBetween(prediction.lastStart, prediction.ovulationDate) + 1;
    }
    const fStart = ovDay - (FERTILE_WINDOW_DAYS - 1);
    const f = seg(fStart, ovDay);
    if (f.end > f.start) segments.push({ phase: PHASE.FERTILE, start: f.start, end: f.end });
    const o = seg(ovDay, ovDay);
    segments.push({ phase: PHASE.OVULATION, start: o.start, end: o.end });
    ovulationFrac = (ovDay - 0.5) / total;
  }

  const clampedDay = Math.min(Math.max(prediction.cycleDay, 1), total);
  const currentFrac = (clampedDay - 0.5) / total;

  return { total, segments, ovulationFrac, currentFrac, ovulationConfirmed: !!prediction.ovulationConfirmed };
}

// --------------------------------------------------------
// PMS-Fenster
// --------------------------------------------------------

/**
 * Leitet ein PMS-Fenster (praemenstruelle Tage) aus dem bisherigen Symptom-
 * Zyklustag-Muster ab - dieselbe symptomCyclePattern()-Maschinerie
 * (`typicalDaysBeforePeriod`) wie predictSymptomLikelihood(), hier aber über
 * ALLE SYMPTOM_TYPES statt eines einzelnen Schlüssels, um die insgesamt
 * beobachtete prämenstruelle Spanne zu finden statt nur die eines Symptoms.
 *
 * BEWUSST NUR SYMPTOME, KEINE GEFÜHLE: Tages-Logs tragen zusätzlich
 * `feelings` (Array, dieselben Werte wie MOOD_VALUES) - negative Gefühle
 * ('sad', 'irritable', 'anxious', 'sensitive') wären inhaltlich ein
 * naheliegendes zweites Signal. symptomCyclePattern() prüft `normalize
 * SymptomEntries(log.symptoms)` aber fest verdrahtet gegen EINEN Schlüssel;
 * `feelings` dort einzubeziehen bräuchte entweder einen zweiten Parameter,
 * der eine andere Log-Eigenschaft und ein anderes Matching abfragt (die
 * Funktion ist bereits an mehreren Stellen getestet und referenziert - siehe
 * predictSymptomLikelihood()), oder eine zweite, im Wesentlichen identische
 * Kopie der Zyklustag-Rekonstruktion nur für Gefühle. Beides ist die
 * Testdopplung, die dieses Modul an anderer Stelle (siehe reconstructCycles()-
 * Dokblock) bewusst vermeidet - deshalb bleibt es hier bei Symptomen; eine
 * spätere Erweiterung von symptomCyclePattern() um einen generischen
 * "occurredOn(log)"-Prädikat-Parameter wäre der sauberere Ort dafür.
 *
 * Fensterberechnung: unter allen Symptomen mit einem echten Muster
 * (`typicalDaysBeforePeriod != null`) die kleinste ("näher an der Periode")
 * und größte ("am weitesten davor") Tageszahl - das Fenster deckt die ganze
 * beobachtete Spanne ab, nicht nur den häufigsten Einzelwert. Die dem
 * nächsten Periodenbeginn nähere Grenze wird auf mindestens 2 Tage davor
 * geklemmt - ein "PMS-Fenster" von 0-1 Tagen vor der Periode wäre von der
 * Menstruation selbst kaum unterscheidbar.
 *
 * `null`, wenn: Schwangerschafts-Modus aktiv, `settings.show_pms === 0`, keine
 * Historie/Vorhersage möglich, oder kein einziges Symptom ein Muster zeigt.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile.
 * @param {string} [todayKey] - optionale Erweiterung über die Kern-Signatur
 *        hinaus, für deterministische Aufrufe/Tests; Default wie im Rest des
 *        Moduls das echte "heute" (predictCycle()s `nextStart` hängt bei
 *        einer bereits vergangenen letzten Periode ohnehin nicht davon ab).
 * @returns {{start: string, end: string, symptomKeys: string[]}|null}
 */
export function pmsWindow(dayLogs, periods, settings = {}, todayKey = householdToday()) {
  if (settings.show_pms === 0) return null;
  if (pregnancyInfo(settings, todayKey).active) return null;

  const prediction = predictCycle(periods, settings, todayKey, dayLogs);
  if (!prediction.hasData || !prediction.nextStart) return null;

  const daysBeforeBySymptom = new Map();
  for (const key of SYMPTOM_VALUES) {
    const pattern = symptomCyclePattern(dayLogs, periods, settings, key);
    if (pattern.typicalDaysBeforePeriod != null) daysBeforeBySymptom.set(key, pattern.typicalDaysBeforePeriod);
  }
  if (!daysBeforeBySymptom.size) return null;

  const values = [...daysBeforeBySymptom.values()];
  const minDaysBefore = Math.max(2, Math.min(...values));
  const maxDaysBefore = Math.max(...values, minDaysBefore);

  return {
    start: addLocalDays(prediction.nextStart, -maxDaysBefore),
    end: addLocalDays(prediction.nextStart, -minDaysBefore),
    symptomKeys: [...daysBeforeBySymptom.keys()],
  };
}
