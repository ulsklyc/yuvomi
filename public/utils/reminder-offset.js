/**
 * Reminder-Offset-Helfer (rein, ohne DOM/i18n)
 * Zweck: Rückrechnung des Versatzes zwischen Task-Fälligkeit und gespeichertem
 *        `remind_at`, sowie Auflösung auf ein UI-Preset.
 *
 * Wichtig: `remind_at` wird beim Speichern via `Date#toISOString()` als UTC
 * abgelegt (ohne abschließendes "Z"). Daher muss es hier ebenfalls als UTC
 * interpretiert werden — sonst entsteht ein doppelter Zeitzonen-Offset, der
 * sich bei jedem Speichern erneut aufaddiert (Issue #354).
 */

const TZ_SUFFIX = /[zZ]|[+-]\d{2}:?\d{2}$/;

/**
 * Parst einen gespeicherten `remind_at`-Wert als UTC, falls keine
 * Zeitzonenangabe vorhanden ist.
 * @param {string} value
 * @returns {Date}
 */
export function parseRemindAtAsUtc(value) {
  return new Date(TZ_SUFFIX.test(value) ? value : `${value}Z`);
}

/**
 * Millisekunden-Versatz zwischen Fälligkeit (lokal) und Erinnerung (UTC).
 * @returns {number|null} positiver Versatz in ms, oder null bei fehlenden Daten
 */
export function parseOffsetMsFromReminder(task, reminder) {
  if (!task?.due_date || !reminder?.remind_at) return null;
  const due = task.due_time
    ? new Date(`${task.due_date}T${task.due_time}`)
    : new Date(`${task.due_date}T23:59:59`);
  const remind = parseRemindAtAsUtc(reminder.remind_at);
  if (Number.isNaN(due.getTime()) || Number.isNaN(remind.getTime())) return null;
  return due.getTime() - remind.getTime();
}

const PRESET_MAP = new Map([
  [0, 'offset_at_time'],
  [15 * 60 * 1000, 'offset_15m'],
  [60 * 60 * 1000, 'offset_1h'],
  [24 * 60 * 60 * 1000, 'offset_1d'],
  [2 * 24 * 60 * 60 * 1000, 'offset_2d'],
  [7 * 24 * 60 * 60 * 1000, 'offset_1w'],
  [14 * 24 * 60 * 60 * 1000, 'offset_2w'],
]);

/**
 * Löst Task + Reminder auf das passende UI-Preset auf.
 *
 * EIN VERSATZ KANN NEGATIV SEIN, und dann bildet ihn kein Preset ab. `remind_at`
 * ist ein absoluter Zeitpunkt, der Vorlauf wird daraus zurückgerechnet - zieht
 * jemand die Fälligkeit VOR die bestehende Erinnerung, liegt die Erinnerung
 * danach. Vorher fiel dieser Fall auf `offset_at_time` zurück: der Dialog
 * behauptete „Zum Startzeitpunkt", während die Erinnerung Tage später feuerte,
 * und das nächste Speichern verschob sie ungefragt auf die behauptete Stelle.
 * Jetzt bekommt der Fall einen eigenen Namen (`offset_after_due`), den die
 * Oberfläche benennen und beim Speichern unangetastet lassen kann.
 *
 * Unter einer Minute Versatz bleibt „zum Zeitpunkt" - in BEIDE Richtungen,
 * sonst hinge an ein paar Sekunden Rundung eine Warnung.
 *
 * @returns {{ preset: string, amount: string, unit: string }}
 */
export function resolveReminderPreset(task, reminder) {
  const offset = parseOffsetMsFromReminder(task, reminder);
  if (offset === null) return { preset: 'offset_15m', amount: '15', unit: 'minutes' };
  if (PRESET_MAP.has(offset)) return { preset: PRESET_MAP.get(offset), amount: '1', unit: 'days' };
  const minutes = Math.round(offset / 60000);
  if (minutes > 0) return { preset: 'offset_custom', amount: String(minutes), unit: 'minutes' };
  if (minutes < 0) return { preset: 'offset_after_due', amount: '1', unit: 'days' };
  return { preset: 'offset_at_time', amount: '1', unit: 'days' };
}

const UNIT_FACTOR_MS = new Map([
  ['minutes', 60 * 1000],
  ['hours', 60 * 60 * 1000],
  ['days', 24 * 60 * 60 * 1000],
  ['weeks', 7 * 24 * 60 * 60 * 1000],
]);

const PRESET_OFFSET_MS = new Map(
  [...PRESET_MAP].map(([ms, preset]) => [preset, ms])
);

/**
 * Schreibt einen `remind_at`-Wert so, wie ihn der Server ablegt: naiv-UTC ohne
 * Zonen-Suffix (siehe `parseRemindAtAsUtc`).
 * @param {string} value
 * @returns {string|null}
 */
function naiveUtc(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = TZ_SUFFIX.test(text) ? new Date(text) : new Date(`${text}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19);
}

/**
 * Der Zeitpunkt, den ein Preset ergibt - die Gegenrichtung zu
 * `resolveReminderPreset`.
 *
 * `offset_after_due` RECHNET NICHT. Für diesen Zustand gibt es keinen Vorlauf,
 * aus dem sich etwas rechnen ließe; gerechnet würde hier stets das Falsche, und
 * der einzige ehrliche Wert ist der gespeicherte Zeitpunkt selbst. Deshalb
 * reicht der Fall `storedRemindAt` unverändert durch, statt die Erinnerung beim
 * Speichern stillschweigend zu verschieben.
 *
 * @param {string} preset UI-Preset (`offset_15m`, `offset_custom`, ...)
 * @param {{dueDate?: string, dueTime?: string|null, amount?: number|string,
 *          unit?: string, storedRemindAt?: string|null}} options
 * @returns {string|null} naiv-UTC `YYYY-MM-DDTHH:MM:SS`, oder null wenn das
 *          Preset keinen Zeitpunkt ergibt (fehlende Fälligkeit, ungültiger
 *          Custom-Wert, kein gespeicherter Zeitpunkt zum Behalten).
 */
export function remindAtFromPreset(preset, {
  dueDate = '', dueTime = null, amount = 0, unit = 'days', storedRemindAt = null,
} = {}) {
  if (preset === 'offset_after_due') return naiveUtc(storedRemindAt);
  if (preset === 'offset_none' || !dueDate) return null;

  let offsetMs;
  if (preset === 'offset_custom') {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    // Eine unbekannte Einheit wird NICHT geraten. Die abgeloeste Kette liess
    // sie in den letzten else-Zweig fallen und rechnete sie als Wochen - das
    // war der Zufall einer Schreibweise, keine Entscheidung. Aus dem Auswahlfeld
    // kommen nur die vier bekannten Werte; kaeme je ein fuenfter, ist eine
    // Fehlermeldung ehrlicher als ein stillschweigend falscher Zeitpunkt.
    const factor = UNIT_FACTOR_MS.get(unit);
    if (factor === undefined) return null;
    offsetMs = value * factor;
  } else {
    offsetMs = PRESET_OFFSET_MS.get(preset);
    if (offsetMs === undefined) return null;
  }

  const due = new Date(`${dueDate}T${dueTime || '23:59:59'}`);
  if (Number.isNaN(due.getTime())) return null;
  return new Date(due.getTime() - offsetMs).toISOString().slice(0, 19);
}
