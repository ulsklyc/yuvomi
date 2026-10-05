/**
 * Modul: Vitalwerte-Aggregation (Health)
 * Zweck: Reine, DOM-freie Logik für den Vitalwerte-Tab — Metrik-Definitionen
 *        plus die testbare Kernfunktion computeVitalSeries(), die Rohmessungen
 *        in ein zeitraum-gebucketetes Trend-Serien-Objekt (fürs SVG-Chart) und
 *        Kennzahlen (letzter Wert + Delta zum Vorwert, fürs Karten-Grid)
 *        überführt.
 * Abhängigkeiten: /utils/date.js (ebenfalls DOM-frei) — bewusst KEINE i18n/DOM,
 *        damit die Funktion in Node ohne Browser-Umgebung getestet werden kann.
 */

import {
  toLocalDateKey,
  parseLocalDateKey,
  addLocalDays,
  startOfLocalWeekKey,
  todayKey,
} from '/utils/date.js';

// --------------------------------------------------------
// Metrik-Definitionen
// --------------------------------------------------------
// Die fünf Stufen der Stimmungs-Skala (#609). Der gespeicherte Wert ist die
// Zahl; die Stufe liefert Label und Gesicht dazu. Steht vor VITAL_METRICS, weil
// die Metrik ihre Achsengrenzen von hier bezieht.
export const MOOD_SCALE = Object.freeze([
  { value: 1, icon: 'frown', labelKey: 'health.vitals.mood.veryBad' },
  { value: 2, icon: 'annoyed', labelKey: 'health.vitals.mood.bad' },
  { value: 3, icon: 'meh', labelKey: 'health.vitals.mood.okay' },
  { value: 4, icon: 'smile', labelKey: 'health.vitals.mood.good' },
  { value: 5, icon: 'laugh', labelKey: 'health.vitals.mood.veryGood' },
]);

export const MOOD_MIN = MOOD_SCALE[0].value;
export const MOOD_MAX = MOOD_SCALE[MOOD_SCALE.length - 1].value;

// `channels` beschreibt die genutzten numerischen Kanäle (value_num,
// value_num2, value_num3). Blutdruck belegt drei (Systole/Diastole/Puls),
// alle übrigen Metriken genau einen. `units` listet die im Erfassungs-Dialog
// wählbaren Einheiten; die erste ist der Default.
//
// `format` sagt, wie ein Wert gelesen wird, und steuert damit zugleich das
// Eingabefeld: 'pair' zeigt zwei Kanäle als 120/80, 'duration' rechnet die in
// `value_num` gespeicherten Dezimalstunden in Stunden und Minuten zurück,
// 'scale' zeigt eine Stufe der Skala statt einer nackten Zahl. Fehlt das Feld,
// ist der Wert eine schlichte Zahl mit Einheit. Vor #609 stand diese
// Fallunterscheidung als `type === 'bp'` an fünf Stellen im Seitenmodul; jede
// weitere Metrik hätte sie ein weiteres Mal vervielfacht.
export const VITAL_METRICS = Object.freeze([
  {
    type: 'bp',
    icon: 'heart-pulse',
    labelKey: 'health.vitals.metric.bp',
    channels: ['value_num', 'value_num2', 'value_num3'],
    channelLabelKeys: [
      'health.vitals.channel.systolic',
      'health.vitals.channel.diastolic',
      'health.vitals.channel.pulse',
    ],
    units: ['mmHg'],
    format: 'pair',
  },
  {
    type: 'glucose',
    icon: 'droplet',
    labelKey: 'health.vitals.metric.glucose',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.glucose'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    type: 'weight',
    icon: 'scale',
    labelKey: 'health.vitals.metric.weight',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.weight'],
    units: ['kg', 'lb'],
  },
  // Körpermaße (#683). Stehen bewusst neben dem Gewicht: bei einem Säugling
  // werden die drei gemeinsam erhoben, und wer eines eintragen will, sucht die
  // anderen daneben. Beide bleiben rohe Messwerte ohne Bewertung - eine
  // Perzentile braucht Referenzdaten nach Geschlecht und Alter und wäre ein
  // eigenes Vorhaben, keine Eigenschaft der Metrik.
  {
    type: 'height',
    icon: 'ruler',
    labelKey: 'health.vitals.metric.height',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.height'],
    units: ['cm', 'in'],
  },
  {
    type: 'head_circumference',
    icon: 'circle-dot',
    labelKey: 'health.vitals.metric.headCircumference',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.headCircumference'],
    units: ['cm', 'in'],
  },
  {
    type: 'spo2',
    icon: 'activity',
    labelKey: 'health.vitals.metric.spo2',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.spo2'],
    units: ['%'],
  },
  {
    type: 'temp',
    icon: 'thermometer',
    labelKey: 'health.vitals.metric.temp',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.temp'],
    units: ['°C', '°F'],
  },
  // Schlafdauer einer Nacht (#609). Gespeichert werden Dezimalstunden, damit
  // Trend, Mittelwert und Delta dieselbe Rechnung wie bei jeder anderen Metrik
  // benutzen; gelesen und eingegeben wird in Stunden und Minuten, weil niemand
  // „7,5" für siebeneinhalb Stunden tippt. `measured_at` ist das Ende des
  // Schlafs (der Morgen), nicht das Zubettgehen - sonst läge eine Nacht je nach
  // Einschlafzeit mal vor, mal nach Mitternacht und damit im falschen Tag.
  {
    type: 'sleep',
    icon: 'moon',
    labelKey: 'health.vitals.metric.sleep',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.sleep'],
    units: ['h'],
    format: 'duration',
  },
  // Stimmung als 1-5-Skala (#609). Bewusst ohne Einheit: die Zahl ist eine
  // Stufe, kein Messwert. Nicht zu verwechseln mit der Stimmung im
  // Zyklus-Tagebuch - die benennt eine ART (gereizt, ängstlich, sensibel) und
  // gehört zu einem Zyklustag, diese hier misst, wie gut es einem geht, und
  // steht jeder Person offen, auch ohne Zyklus-Tab.
  // `domain` klemmt die Chart-Achse auf die volle Skala. Ohne sie zoomt der
  // Chart auf die vorkommenden Werte: eine Woche zwischen 4 und 5 sähe dann aus
  // wie ein Absturz, und die gerundeten Achsen-Ticks wiederholten sich
  // („5, 5, 5, 4, 4"). Eine Stufenskala ist nur vor ihrer eigenen Spannweite zu
  // lesen - bei Messwerten mit offener Spanne wäre dieselbe Klemmung falsch.
  {
    type: 'mood',
    icon: 'smile',
    labelKey: 'health.vitals.metric.mood',
    channels: ['value_num'],
    channelLabelKeys: ['health.vitals.metric.mood'],
    units: [],
    format: 'scale',
    domain: { min: MOOD_MIN, max: MOOD_MAX },
  },
]);

/**
 * Stufe zu einem gespeicherten Stimmungswert. Gerundet, weil die Serie über
 * mehrere Einträge eines Tages mittelt (3,5 zeigt das Gesicht der 4).
 */
export function moodStep(value) {
  // Number(null) und Number('') sind 0 und würden auf die unterste Stufe
  // geklemmt - „kein Wert" wäre dann „sehr schlecht".
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.min(MOOD_MAX, Math.max(MOOD_MIN, Math.round(n)));
  return MOOD_SCALE.find((s) => s.value === rounded) || null;
}

/** Dezimalstunden in ganze Stunden + Minuten. 7.5 -> { hours: 7, minutes: 30 }. */
export function splitDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Auf die Minute runden, bevor gesplittet wird: 7.999 darf nicht als
  // „7 h 60 min" herauskommen.
  const totalMinutes = Math.round(n * 60);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** Stunden + Minuten in Dezimalstunden. Umkehrung von splitDuration(). */
export function durationToHours(hours, minutes) {
  const h = Number(hours) || 0;
  const m = Number(minutes) || 0;
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return null;
  return Math.round((h * 60 + m)) / 60;
}

export const VITAL_TYPES = Object.freeze(VITAL_METRICS.map((m) => m.type));

export function vitalMetric(type) {
  return VITAL_METRICS.find((m) => m.type === type) || null;
}

const CHANNEL_KEYS = ['value_num', 'value_num2', 'value_num3'];

/** Datums-Anteil (YYYY-MM-DD) eines measured_at-Zeitstempels ohne UTC-Shift. */
function dateKeyOf(measuredAt) {
  return String(measuredAt).slice(0, 10);
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Laenge des gleitenden Standardfensters je Zeitraum (Tage, endend heute). */
export const ROLLING_WINDOW_DAYS = { week: 7, month: 30 };

/** Kennung des Kalenderzeitraums eines Tages: Wochenanfang bzw. YYYY-MM. */
function periodId(range, key, weekStartsOn) {
  return range === 'week' ? startOfLocalWeekKey(key, weekStartsOn) : key.slice(0, 7);
}

/** Letzter Tag des Kalenderzeitraums (Woche/Monat), in dem `key` liegt. */
function periodEnd(range, key, weekStartsOn) {
  if (range === 'week') return addLocalDays(startOfLocalWeekKey(key, weekStartsOn), 6);
  const d = parseLocalDateKey(key);
  return toLocalDateKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * Gilt fuer diesen Anker das gleitende Fenster? Nur, wenn er im laufenden
 * Zeitraum liegt UND nicht hinter heute. Ein Anker hinter heute im laufenden
 * Zeitraum meint dessen Kalenderfenster: Messwerte und Einheiten duerfen ein
 * Datum in der Zukunft tragen, und der Rest der Woche bzw. des Monats laege
 * sonst in KEINEM erreichbaren Fenster (gleitend endet heute, "Weiter"
 * begann erst mit dem naechsten Kalenderzeitraum).
 */
export function isRollingAnchor(range, anchorKey, weekStartsOn = 1, { today = todayKey() } = {}) {
  if (range !== 'week' && range !== 'month') return false;
  const anchor = anchorKey || today;
  return anchor <= today && periodId(range, anchor, weekStartsOn) === periodId(range, today, weekStartsOn);
}

/**
 * Blaettert den Anker um einen Zeitraum. Die Fenster reihen sich lueckenlos:
 *
 *   ... voriger Kalenderzeitraum <-> gleitend bis heute
 *       <-> laufender Kalenderzeitraum <-> naechster Kalenderzeitraum ...
 *
 * Der Halt "laufender Kalenderzeitraum" (Anker = dessen letzter Tag) entfaellt,
 * wenn heute selbst der letzte Tag ist - dann liegt nichts mehr dahinter. Der
 * Monat blaettert ueber den Monatsersten: `setMonth()` auf einem 31. lief in
 * den uebernaechsten Monat ueber und liess einen ganzen Monat aus.
 *
 * @param {'week'|'month'|'year'} range
 * @param {string} anchorKey  YYYY-MM-DD
 * @param {number} dir        -1 zurueck, +1 weiter
 * @param {number} [weekStartsOn=1]
 * @param {{ today?: string }} [opts]  `today` nur fuer Tests
 * @returns {string} der neue Anker
 */
export function stepVitalAnchor(range, anchorKey, dir, weekStartsOn = 1, { today = todayKey() } = {}) {
  const anchor = anchorKey || today;
  if (range === 'year') {
    const d = parseLocalDateKey(anchor);
    d.setFullYear(d.getFullYear() + dir);
    return toLocalDateKey(d);
  }
  const kind = range === 'week' ? 'week' : 'month';
  const current = periodId(kind, today, weekStartsOn);
  const end = periodEnd(kind, today, weekStartsOn);
  const hasRest = end > today;
  if (periodId(kind, anchor, weekStartsOn) === current) {
    if (anchor <= today && dir > 0 && hasRest) return end;
    if (anchor > today && dir < 0) return today;
  }
  let next;
  if (kind === 'week') {
    next = addLocalDays(anchor, 7 * dir);
  } else {
    const d = parseLocalDateKey(anchor);
    next = toLocalDateKey(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }
  if (periodId(kind, next, weekStartsOn) !== current) return next;
  // Von hinten kommend zuerst das Kalenderfenster, von vorn das gleitende.
  return dir < 0 && hasRest ? end : today;
}

/**
 * Baut die Bucket-Achse für einen Zeitraum.
 * - week:  7 Tages-Buckets
 * - month: ein Tages-Bucket je Tag
 * - year:  12 Monats-Buckets (Jan–Dez) des Anker-Jahres
 *
 * DER LAUFENDE ZEITRAUM IST GLEITEND (Critique 2026-10-05, R16). Woche und
 * Monat waren Kalenderfenster: am 05.10. zeigte "Monat" fuenf Tage, und ueber
 * vier Messungen der Vorwoche stand "Zu wenige Messwerte fuer einen Trend".
 * Liegt HEUTE im Kalenderzeitraum des Ankers und der Anker nicht hinter heute
 * (`isRollingAnchor`), ist das Fenster deshalb die letzten 7 bzw. 30 Tage,
 * endend heute. Wer zurueckblaettert (der Anker liegt
 * in einer anderen Woche, einem anderen Monat), bekommt wie bisher die
 * Kalenderwoche ab `weekStartsOn` bzw. den Kalendermonat - "September" ist
 * dort die Frage, nicht "die 30 Tage vor dem 5. September". `from`/`to` nennen
 * das Fenster, das wirklich gilt; die Beschriftung liest sie.
 *
 * @param {'week'|'month'|'year'} range
 * @param {string} [anchorKey]   YYYY-MM-DD im Zeitraum, Standard heute
 * @param {number} [weekStartsOn=1]
 * @param {{ today?: string }} [opts]  `today` nur fuer Tests; sonst `todayKey()`
 *        (Tag des Haushalts, utils/date.js).
 * @returns {{ buckets: Array<{key,date,gran}>, from: string, to: string, gran: string }}
 */
export function buildVitalBuckets(range, anchorKey, weekStartsOn = 1, { today = todayKey() } = {}) {
  const anchor = anchorKey || today;
  const rolling = (days) => {
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addLocalDays(today, -i);
      buckets.push({ key: d, date: d, gran: 'day' });
    }
    return { buckets, from: buckets[0].date, to: today, gran: 'day' };
  };

  if (range === 'year') {
    const year = parseLocalDateKey(anchor).getFullYear();
    const buckets = [];
    for (let m = 0; m < 12; m++) {
      const first = toLocalDateKey(new Date(year, m, 1));
      buckets.push({ key: first.slice(0, 7), date: first, gran: 'month' });
    }
    return { buckets, from: buckets[0].date, to: toLocalDateKey(new Date(year, 11, 31)), gran: 'month' };
  }

  if (range === 'week') {
    const start = startOfLocalWeekKey(anchor, weekStartsOn);
    if (isRollingAnchor('week', anchor, weekStartsOn, { today })) return rolling(ROLLING_WINDOW_DAYS.week);
    const buckets = [];
    for (let i = 0; i < 7; i++) {
      const d = addLocalDays(start, i);
      buckets.push({ key: d, date: d, gran: 'day' });
    }
    return { buckets, from: start, to: buckets[6].date, gran: 'day' };
  }

  // month (Default)
  // Am 31. reichen 30 Tage nur bis zum 2.: der Monatserste laege weder hier
  // noch im Vormonat. Das Fenster waechst dann auf den ganzen Monat.
  if (isRollingAnchor('month', anchor, weekStartsOn, { today })) {
    return rolling(Math.max(ROLLING_WINDOW_DAYS.month, Number(today.slice(8, 10))));
  }
  const d = parseLocalDateKey(anchor);
  const year = d.getFullYear();
  const month = d.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const buckets = [];
  for (let i = 1; i <= days; i++) {
    const key = toLocalDateKey(new Date(year, month, i));
    buckets.push({ key, date: key, gran: 'day' });
  }
  return { buckets, from: buckets[0].date, to: buckets[days - 1].date, gran: 'day' };
}

/**
 * Aggregiert Rohmessungen zu einer Trend-Serie plus Kennzahlen.
 *
 * @param {Array<Object>} rows  - Vitalwerte-Zeilen (beliebige Typen; wird intern
 *                                 nach `type` gefiltert). Erwartete Felder:
 *                                 type, value_num, value_num2, value_num3,
 *                                 unit, measured_at.
 * @param {Object} opts
 * @param {string} opts.type            - Metrik-Typ (bp|glucose|weight|spo2|temp)
 * @param {'week'|'month'|'year'} [opts.range='month']
 * @param {string} [opts.anchor]        - Anker-Datum (YYYY-MM-DD) im Zeitraum
 * @param {number} [opts.weekStartsOn=1]
 * @returns {{
 *   type: string, range: string, from: string, to: string, gran: string,
 *   channels: string[],
 *   points: Array<{ key:string, date:string, count:number,
 *                   value_num:number|null, value_num2:number|null, value_num3:number|null }>,
 *   hasData: boolean,
 *   latest: Object|null, previous: Object|null,
 *   deltas: { value_num:number|null, value_num2:number|null, value_num3:number|null }
 * }}
 */
export function computeVitalSeries(rows, opts = {}) {
  const { type, range = 'month', anchor, weekStartsOn = 1, today } = opts;
  const metric = vitalMetric(type);
  const channels = metric ? metric.channels : ['value_num'];

  const typeRows = (Array.isArray(rows) ? rows : []).filter((r) => r && r.type === type);

  // Kennzahlen: letzter + vorletzter Wert über ALLE Messungen dieses Typs,
  // unabhängig vom gewählten Zeitraum (das Delta zeigt die jüngste Änderung).
  const sorted = [...typeRows].sort((a, b) => {
    const ka = String(a.measured_at);
    const kb = String(b.measured_at);
    if (ka === kb) return (b.id || 0) - (a.id || 0);
    return ka < kb ? 1 : -1;
  });
  const latest = sorted[0] || null;
  const previous = sorted[1] || null;

  const deltas = { value_num: null, value_num2: null, value_num3: null };
  if (latest && previous) {
    for (const key of CHANNEL_KEYS) {
      const cur = toFiniteOrNull(latest[key]);
      const prev = toFiniteOrNull(previous[key]);
      if (cur !== null && prev !== null) deltas[key] = cur - prev;
    }
  }

  // Zeitraum-Serie: Buckets aufbauen und Messungen einsortieren.
  const { buckets, from, to, gran } = buildVitalBuckets(range, anchor, weekStartsOn, today ? { today } : undefined);
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  const acc = buckets.map(() => ({
    count: 0,
    sums: { value_num: 0, value_num2: 0, value_num3: 0 },
    counts: { value_num: 0, value_num2: 0, value_num3: 0 },
  }));

  for (const row of typeRows) {
    const dk = dateKeyOf(row.measured_at);
    if (dk < from || dk > to) continue;
    const bucketKey = gran === 'month' ? dk.slice(0, 7) : dk;
    const i = index.get(bucketKey);
    if (i === undefined) continue;
    acc[i].count += 1;
    for (const key of CHANNEL_KEYS) {
      const val = toFiniteOrNull(row[key]);
      if (val !== null) { acc[i].sums[key] += val; acc[i].counts[key] += 1; }
    }
  }

  const points = buckets.map((b, i) => {
    const a = acc[i];
    const avg = (key) => (a.counts[key] > 0 ? a.sums[key] / a.counts[key] : null);
    return {
      key: b.key,
      date: b.date,
      count: a.count,
      value_num: avg('value_num'),
      value_num2: avg('value_num2'),
      value_num3: avg('value_num3'),
    };
  });

  return {
    type,
    range,
    from,
    to,
    gran,
    channels,
    points,
    hasData: points.some((p) => p.count > 0),
    latest,
    previous,
    deltas,
  };
}
