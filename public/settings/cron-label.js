/**
 * Modul: Einstellungen (Settings) — Cron-Ausdruck in Klartext
 * Zweck: `BACKUP_SCHEDULE` ist eine freie Cron-Zeile aus der Umgebung. Sie roh
 *        anzuzeigen ("0 2 * * *") verlangt vom Betreiber, Cron zu lesen; die
 *        Administrationsseite nennt daher zuerst den Zeitpunkt und führt den
 *        Ausdruck nur als Beleg mit.
 * Abhängigkeiten: /i18n.js, /utils/timezone.js
 *
 * ZWEI ZONEN, EINE UHRZEIT. Der Cron läuft in der Zone des Servers (`TZ`,
 * sonst UTC), die Karte zeigt "Nächstes Backup" in der Haushaltszone. Der Satz
 * liest seine Uhrzeit deshalb nicht aus dem Ausdruck, sondern aus dem
 * tatsächlichen nächsten Lauf (`nextRun`), umgerechnet mit denselben Helfern
 * wie jeder andere Zeitpunkt der App (`zonedFields`). Wo das keine Aussage für
 * jeden Lauf ergibt, gibt es keinen Satz, und der Ausdruck steht da.
 */

import { t, formatTime, getLocale } from '/i18n.js';
import { isValidTimeZone, zonedFields, zonedWeekday } from '/utils/timezone.js';

const NUMBER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const pad2 = (n) => String(n).padStart(2, '0');

// Cron zählt Wochentage ab Sonntag und lässt 7 als zweiten Sonntag zu.
// node-cron nimmt Kurz- und Langnamen in jeder Schreibung (`sun`, `Sunday`).
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Der EINE Wochentag eines Felds, 0 (Sonntag) bis 6, oder null.
 *
 * DAS GANZE FELD MUSS DER TAG SEIN: `mon-fri` und `mon,wed,fri` fangen mit
 * einem Namen an, laufen aber an mehreren Tagen. Am Anfang abgeschnitten,
 * stand dort "Jeden Montag", und "überfällig" maß an sieben Tagen statt an
 * einem.
 *
 * @param {string} field
 * @returns {number | null}
 */
function parseWeekday(field) {
  if (NUMBER.test(field)) {
    const value = Number(field);
    return value >= 0 && value <= 7 ? value % 7 : null;
  }
  const name = field.toLowerCase();
  const index = WEEKDAY_NAMES.findIndex((day) => name === day || name === day.slice(0, 3));
  return index === -1 ? null : index;
}

function timeLabel(hour, minute) {
  // Als reine Uhrzeit, nicht als Date: ein Zeitplan ist Wanduhrzeit, und ein
  // Date waere ein Zeitpunkt, den eine gesetzte Haushaltszone verschoebe.
  return formatTime(`${pad2(hour)}:${pad2(minute)}`);
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
 * Der Versatz einer Zone gegen UTC zu einem Zeitpunkt, in Minuten. Aus
 * `zonedFields` gerechnet; ohne `zone` die Haushaltszone, in der die Karte
 * schreibt.
 * @param {number} ms
 * @param {string | null} [zone]
 * @returns {number | null}
 */
function offsetMinutes(ms, zone) {
  const f = zone === undefined ? zonedFields(ms) : zonedFields(ms, zone);
  if (!f) return null;
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return Math.round((wall - ms) / 60_000);
}

/**
 * Trifft der nächste Lauf in der Zone des Servers die Uhrzeit und den Tag des
 * Ausdrucks? Wenn nicht, gehört er nicht zu diesem Zeitplan.
 * @param {CronPattern} pattern
 * @param {number} ms
 * @param {string} serverZone
 * @returns {boolean}
 */
function matchesServerClock(pattern, ms, serverZone) {
  const f = zonedFields(ms, serverZone);
  if (!f || f.minute !== pattern.minute) return false;
  if (pattern.kind === 'hourly') return f.hour % pattern.count === 0;
  if (f.hour !== pattern.hour) return false;
  if (pattern.kind === 'weekly') return new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay() === pattern.weekday;
  if (pattern.kind === 'monthly') return f.day === pattern.day;
  return true;
}

/**
 * Das Muster in der Haushaltszone, abgelesen am nächsten Lauf, oder null.
 *
 * - Uhrzeit (und beim Stundenintervall die Minute) ist die des nächsten Laufs
 *   in der Haushaltszone, auch bei Zonen mit halber Stunde (+05:30).
 * - Wochen- und Monatstag kippen mit, wenn der Lauf über Mitternacht rutscht.
 *   Keine Zone verschiebt weiter als einen Tag; ein nächster Lauf, der weiter
 *   weg liegt, gehört nicht zu diesem Ausdruck.
 * - Ein Monatstag kippt nur, wo es Ausgangs- und Zieltag in jedem Monat gibt
 *   (1.-28.). Der 31. um 23:00 UTC ist in Berlin der 1. - aber nur nach
 *   Monaten mit 31 Tagen.
 * - Ändert sich der Abstand zwischen Haushalts- und Serverzone bis zum
 *   übernächsten Lauf (eine der beiden stellt um, die andere nicht), stimmte
 *   der Satz nur noch einmal: null.
 *
 * GLEICHE FELDER SIND KEINE GLEICHE ZONE. Ein UTC-Server und ein Haushalt in
 * London nennen im Winter dieselbe Uhrzeit, nach der Umstellung nicht mehr.
 * Deshalb zählt die Zone, die der Server nennt (`scheduler.timezone`): mit ihr
 * wird an beiden Zonen geprüft, und in derselben Zone (oder einer mit
 * denselben Regeln) bleibt der Abstand 0 und der Satz über die Umstellung
 * stehen - der Cron folgt der Wanduhr des Servers. Nennt der Server keine
 * (älterer Server, neue Oberfläche aus dem Cache), gilt UTC, der Standard des
 * Schedulers: geprüft wird dann immer, an der Haushaltszone.
 *
 * @param {CronPattern} pattern
 * @param {unknown} nextRun
 * @param {unknown} serverZone
 * @returns {CronPattern | null}
 */
function householdPattern(pattern, nextRun, serverZone) {
  if (typeof nextRun !== 'string' || !nextRun) return null;
  const ms = Date.parse(nextRun);
  if (Number.isNaN(ms)) return null;
  const f = zonedFields(ms);
  if (!f) return null;
  const server = isValidTimeZone(serverZone) ? /** @type {string} */ (serverZone) : null;
  if (server && !matchesServerClock(pattern, ms, server)) return null;

  /** @type {CronPattern} */
  let local;
  if (pattern.kind === 'hourly') {
    local = { kind: 'hourly', count: pattern.count, minute: f.minute };
  } else if (pattern.kind === 'daily') {
    local = { kind: 'daily', hour: f.hour, minute: f.minute };
  } else if (pattern.kind === 'weekly') {
    const weekday = zonedWeekday(ms);
    if (weekday == null) return null;
    const shift = (weekday - pattern.weekday + 7) % 7;
    if (shift !== 0 && shift !== 1 && shift !== 6) return null;
    local = { kind: 'weekly', weekday, hour: f.hour, minute: f.minute };
  } else {
    const day = f.day;
    if (day !== pattern.day) {
      if (Math.abs(day - pattern.day) !== 1 || pattern.day > 28 || day < 1 || day > 28) return null;
    }
    local = { kind: 'monthly', day, hour: f.hour, minute: f.minute };
  }

  // Der übernächste Lauf liegt einen Abstand weiter (beim Monat höchstens).
  // Ändert sich bis dahin der Abstand der beiden Zonen, nennt der Satz für ihn
  // eine andere Uhrzeit.
  const later = ms + intervalOf(pattern);
  const householdNow = offsetMinutes(ms);
  const householdLater = offsetMinutes(later);
  const serverNow = server ? offsetMinutes(ms, server) : 0;
  const serverLater = server ? offsetMinutes(later, server) : 0;
  if (householdNow == null || householdLater == null || serverNow == null || serverLater == null) return null;
  const drift = (householdLater - serverLater) - (householdNow - serverNow);
  // Beim Stundenintervall steht nur die Minute im Satz: eine volle Stunde
  // Umstellung lässt sie stehen.
  const changed = pattern.kind === 'hourly' ? drift % 60 !== 0 : drift !== 0;
  return changed ? null : local;
}

/**
 * Übersetzt die geläufigen Backup-Rhythmen in einen Satz in der Haushaltszone.
 * Alles darüber hinaus (Listen, Bereiche, Monatsfelder) liefert null - dort
 * bleibt der Ausdruck selbst die ehrlichste Auskunft. Ebenso ohne `nextRun`
 * (kein laufender Zeitplan): ohne ihn wüsste der Satz nicht, in welcher Zone
 * sein "02:00" gilt.
 *
 * @param {unknown} expression
 * @param {unknown} nextRun Der nächste Lauf als ISO-Zeitpunkt (`scheduler.nextRun`)
 * @param {unknown} [serverZone] Die Zone des Crons (`scheduler.timezone`); fehlt sie, gilt UTC
 * @returns {string | null}
 */
export function formatCronSchedule(expression, nextRun, serverZone) {
  const parsed = parseCronSchedule(expression);
  if (!parsed) return null;
  const pattern = householdPattern(parsed, nextRun, serverZone);
  if (!pattern) return null;

  if (pattern.kind === 'hourly') {
    return t('settings.backupSchedulerCronHourly', {
      count: pattern.count,
      minute: pad2(pattern.minute),
    });
  }

  const time = timeLabel(pattern.hour, pattern.minute);
  if (pattern.kind === 'daily') return t('settings.backupSchedulerCronDaily', { time });
  if (pattern.kind === 'weekly') {
    return t('settings.backupSchedulerCronWeekly', { weekday: weekdayLabel(pattern.weekday), time });
  }
  return t('settings.backupSchedulerCronMonthly', { day: pattern.day, time });
}

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
  return pattern ? intervalOf(pattern) : null;
}

/**
 * @param {CronPattern} pattern
 * @returns {number}
 */
function intervalOf(pattern) {
  if (pattern.kind === 'hourly') return pattern.count * HOUR_MS;
  if (pattern.kind === 'daily') return DAY_MS;
  if (pattern.kind === 'weekly') return 7 * DAY_MS;
  return (pattern.day > 28 ? 62 : 31) * DAY_MS;
}
