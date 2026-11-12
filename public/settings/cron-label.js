/**
 * Modul: Einstellungen (Settings) — Cron-Ausdruck in Klartext
 * Zweck: `BACKUP_SCHEDULE` ist eine freie Cron-Zeile aus der Umgebung. Sie roh
 *        anzuzeigen ("0 2 * * *") verlangt vom Betreiber, Cron zu lesen; die
 *        Administrationsseite nennt daher zuerst den Zeitpunkt und führt den
 *        Ausdruck nur als Beleg mit.
 * Abhängigkeiten: /i18n.js
 */

import { t, formatTime, getLocale } from '/i18n.js';

const NUMBER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

// Cron zählt Wochentage ab Sonntag und lässt 7 als zweiten Sonntag zu.
const WEEKDAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseWeekday(field) {
  if (NUMBER.test(field)) {
    const value = Number(field);
    return value >= 0 && value <= 7 ? value % 7 : null;
  }
  const named = WEEKDAY_NAMES[field.slice(0, 3).toLowerCase()];
  return named ?? null;
}

function timeLabel(hour, minute) {
  // Als reine Uhrzeit, nicht als Date: ein Zeitplan ist Wanduhrzeit, und ein
  // Date waere ein Zeitpunkt, den eine gesetzte Haushaltszone verschoebe.
  const p2 = (n) => String(n).padStart(2, '0');
  return formatTime(`${p2(hour)}:${p2(minute)}`);
}

function weekdayLabel(dow) {
  // 2000-01-02 war ein Sonntag: +dow trifft jeden Wochentag ohne Zeitzonenrechnung.
  const date = new Date(2000, 0, 2 + dow);
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'long' }).format(date);
}

/**
 * Das erkannte Muster eines Cron-Ausdrucks. EINE Zerlegung für den Klartext
 * und für den Abstand zweier Läufe: was der Satz "Täglich um 02:00" nennt, ist
 * dann auch das, woran die Backup-Karte "überfällig" misst. Alles außerhalb
 * der vier Muster (Listen, Bereiche, Monatsfelder) ist null.
 *
 * @typedef {{ kind: 'hourly', count: number, minute: number }
 *   | { kind: 'daily', hour: number, minute: number }
 *   | { kind: 'weekly', weekday: number, hour: number, minute: number }
 *   | { kind: 'monthly', day: number, hour: number, minute: number }} CronPattern
 * @param {unknown} expression
 * @returns {CronPattern | null}
 */
function parseCronSchedule(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dom, month, dow] = fields;
  if (month !== '*') return null;

  const stepHour = hour.match(STEP);
  if (stepHour && NUMBER.test(minute) && dom === '*' && dow === '*') {
    const count = Number(stepHour[1]);
    if (count < 1 || count > 23) return null;
    return { kind: 'hourly', count, minute: Number(minute) };
  }

  if (!NUMBER.test(minute) || !NUMBER.test(hour)) return null;
  const at = { hour: Number(hour), minute: Number(minute) };

  if (dom === '*' && dow === '*') return { kind: 'daily', ...at };
  if (dom === '*' && dow !== '*') {
    const weekday = parseWeekday(dow);
    if (weekday == null) return null;
    return { kind: 'weekly', weekday, ...at };
  }
  if (dow === '*' && NUMBER.test(dom)) {
    const day = Number(dom);
    if (day < 1 || day > 31) return null;
    return { kind: 'monthly', day, ...at };
  }
  return null;
}

/**
 * Übersetzt die geläufigen Backup-Rhythmen in einen Satz. Alles darüber hinaus
 * (Listen, Bereiche, Monatsfelder) liefert null - dort bleibt der Ausdruck
 * selbst die ehrlichste Auskunft.
 *
 * @param {unknown} expression
 * @returns {string | null}
 */
export function formatCronSchedule(expression) {
  const pattern = parseCronSchedule(expression);
  if (!pattern) return null;

  if (pattern.kind === 'hourly') {
    return t('settings.backupSchedulerCronHourly', {
      count: pattern.count,
      minute: String(pattern.minute).padStart(2, '0'),
    });
  }

  const time = timeLabel(pattern.hour, pattern.minute);
  if (pattern.kind === 'daily') return t('settings.backupSchedulerCronDaily', { time });
  if (pattern.kind === 'weekly') {
    return t('settings.backupSchedulerCronWeekly', { weekday: weekdayLabel(pattern.weekday), time });
  }
  return t('settings.backupSchedulerCronMonthly', { day: pattern.day, time });
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Der längste Abstand zwischen zwei Läufen eines erkannten Zeitplans, in
 * Millisekunden; null für alles, was `formatCronSchedule` auch nicht nennt.
 *
 * DER LÄNGSTE, NICHT DER ÜBLICHE: wer hieran "überfällig" misst, darf nie zu
 * früh warnen. Ein Monat zählt deshalb 31 Tage. Ein Lauf am 29., 30. oder 31.
 * fällt in kurzen Monaten aus (Cron holt ihn nicht nach), der Abstand reicht
 * dann über zwei Monate: höchstens 61 Tage (31. Oktober bis 31. Dezember),
 * hier 62.
 *
 * @param {unknown} expression
 * @returns {number | null}
 */
export function cronScheduleIntervalMs(expression) {
  const pattern = parseCronSchedule(expression);
  if (!pattern) return null;
  if (pattern.kind === 'hourly') return pattern.count * HOUR_MS;
  if (pattern.kind === 'daily') return DAY_MS;
  if (pattern.kind === 'weekly') return 7 * DAY_MS;
  return (pattern.day > 28 ? 62 : 31) * DAY_MS;
}
