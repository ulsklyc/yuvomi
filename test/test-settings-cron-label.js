/**
 * Tests: Cron-Ausdruck als Klartext (Settings-Audit 2026-07-27)
 * Zweck: Die Administrationsseite zeigte den rohen `BACKUP_SCHEDULE`
 *        ("Zeitplan 0 2 * * *"). formatCronSchedule() übersetzt die geläufigen
 *        Rhythmen und liefert für alles Übrige null, damit der Ausdruck selbst
 *        stehen bleibt statt falsch zusammengefasst zu werden.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-settings-cron-label.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Der Loader stubbt /i18n.js mit `t(key, params) => key + JSON.stringify(params)`.
// Geprüft wird damit die Musterzuordnung und die Parameterbelegung; die Texte
// selbst deckt die Locale-Vollständigkeit weiter unten ab.
const { formatCronSchedule, cronScheduleIntervalMs } = await import('../public/settings/cron-label.js');

const parse = (expr) => {
  const out = formatCronSchedule(expr);
  if (out == null) return null;
  const at = out.indexOf('{');
  return { key: out.slice(0, at), params: JSON.parse(out.slice(at)) };
};

test('täglich: Standardplan 0 2 * * *', () => {
  const result = parse('0 2 * * *');
  assert.equal(result.key, 'settings.backupSchedulerCronDaily');
  assert.match(result.params.time, /02:00/);
});

test('wöchentlich: Wochentag als Name, nicht als Zahl', () => {
  const monday = parse('30 3 * * 1');
  assert.equal(monday.key, 'settings.backupSchedulerCronWeekly');
  assert.equal(monday.params.weekday, 'Montag');

  // Cron kennt Sonntag als 0 und als 7 - beide müssen denselben Tag nennen.
  assert.equal(parse('0 4 * * 0').params.weekday, 'Sonntag');
  assert.equal(parse('0 4 * * 7').params.weekday, 'Sonntag');
  assert.equal(parse('0 4 * * SUN').params.weekday, 'Sonntag');
});

test('wöchentlich: Kurz- und Langname, ohne Unterschied zwischen Groß und Klein', () => {
  // node-cron nimmt `sun`..`sat` und `sunday`..`saturday` in jeder Schreibung.
  const faelle = {
    sun: 'Sonntag', mon: 'Montag', tue: 'Dienstag', wed: 'Mittwoch', thu: 'Donnerstag', fri: 'Freitag', sat: 'Samstag',
    sunday: 'Sonntag', monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch',
    thursday: 'Donnerstag', friday: 'Freitag', saturday: 'Samstag',
    Fri: 'Freitag', WEDNESDAY: 'Mittwoch', Saturday: 'Samstag',
  };
  for (const [name, weekday] of Object.entries(faelle)) {
    const result = parse(`0 2 * * ${name}`);
    assert.equal(result?.key, 'settings.backupSchedulerCronWeekly', name);
    assert.equal(result?.params.weekday, weekday, name);
  }
});

test('wöchentlich ist nur EIN Wochentag: Liste, Bereich und Namensrest sind kein Muster', () => {
  // `mon-fri` läuft an fünf Tagen. Als "Jeden Montag" gelesen, stünde ein
  // falscher Satz auf der Karte, und "überfällig" mäße an sieben Tagen statt
  // an einem.
  for (const expr of [
    '0 2 * * mon-fri', // Bereich aus Namen
    '0 2 * * mon,wed', // Liste aus Namen
    '0 2 * * mon,wed,fri',
    '0 2 * * monday-friday',
    '0 2 * * monx', // kein Name, nur ein Anfang davon
    '0 2 * * mo',
    '0 2 * * mondays',
    '0 2 * * mon/2', // Schritt
    '0 2 * * 1-5', // Bereich aus Zahlen
    '0 2 * * 1,3',
    '0 2 * * 1#2', // zweiter Montag im Monat
    '0 2 * * 5L', // letzter Freitag im Monat
  ]) {
    assert.equal(formatCronSchedule(expr), null, `${expr} ist kein einzelner Wochentag`);
    assert.equal(cronScheduleIntervalMs(expr), null, `${expr} hat keinen ablesbaren Abstand`);
  }

  // Gegenprobe: der einzelne Tag behält seine sieben Tage, als Zahl wie als Name.
  const week = 7 * 24 * 60 * 60 * 1000;
  for (const expr of ['0 2 * * 1', '0 2 * * mon', '0 2 * * Monday', '0 2 * * 7']) {
    assert.equal(cronScheduleIntervalMs(expr), week, expr);
  }
});

test('monatlich: Tag im Monat', () => {
  const result = parse('15 1 15 * *');
  assert.equal(result.key, 'settings.backupSchedulerCronMonthly');
  assert.equal(result.params.day, 15);
});

test('Stundenintervall: count trägt die Pluralwahl, minute bleibt zweistellig', () => {
  const every6 = parse('0 */6 * * *');
  assert.equal(every6.key, 'settings.backupSchedulerCronHourly');
  assert.equal(every6.params.count, 6);
  assert.equal(every6.params.minute, '00');
  assert.equal(parse('5 */1 * * *').params.count, 1);
});

test('unbekannte Muster liefern null, damit der Ausdruck selbst stehen bleibt', () => {
  for (const expr of [
    '0 2 * 3 *', // Monatsfeld eingeschränkt
    '0 2,14 * * *', // Liste
    '0 8-17 * * *', // Bereich
    '*/15 * * * *', // Minutenintervall
    '0 2 1 * 1', // Tag im Monat UND Wochentag
    '0 2 * *', // zu wenige Felder
    '0 2 * * * *', // zu viele Felder
    '0 2 32 * *', // ungültiger Tag
    '0 2 * * 9', // ungültiger Wochentag
    '0 */0 * * *', // ungültiger Schritt
    '', null, undefined,
  ]) {
    assert.equal(formatCronSchedule(expr), null, `${JSON.stringify(expr)} sollte null liefern`);
  }
});

test('alle Locales kennen die vier Zeitplan-Muster', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const required = [
    'backupSchedulerCronDaily',
    'backupSchedulerCronWeekly',
    'backupSchedulerCronMonthly',
    'backupSchedulerCronHourly',
    'backupSchedulerCronHourly_one',
  ];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const settings = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).settings;
    for (const key of required) {
      assert.ok(typeof settings[key] === 'string' && settings[key], `${file}: ${key} fehlt`);
    }
    assert.match(settings.backupSchedulerCronDaily, /\{\{time\}\}/, `${file}: Daily ohne {{time}}`);
    assert.match(settings.backupSchedulerCronWeekly, /\{\{weekday\}\}/, `${file}: Weekly ohne {{weekday}}`);
    assert.match(settings.backupSchedulerCronMonthly, /\{\{day\}\}/, `${file}: Monthly ohne {{day}}`);
    assert.match(settings.backupSchedulerCronHourly, /\{\{count\}\}/, `${file}: Hourly ohne {{count}}`);
  }
});
