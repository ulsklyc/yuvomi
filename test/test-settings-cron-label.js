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
const { setDisplayTimeZone } = await import('../public/utils/timezone.js');

// Die Haushaltszone, in der die Karte ihre Uhrzeit nennt. localStorage gibt es
// in Node nicht; setDisplayTimeZone hält den Wert dann im Prozess-Cache.
/** @template T @param {string} zone @param {() => T} fn @returns {T} */
const inZone = (zone, fn) => {
  setDisplayTimeZone(zone);
  try { return fn(); } finally { setDisplayTimeZone(null); }
};

// Der Sonntag, an dem die Musterfälle unten ihren nächsten Lauf haben (UTC).
const SUNDAY = Date.UTC(2026, 10, 15);
/** Der nächste Lauf `day` Tage nach SUNDAY um `hour`:`minute` UTC, als ISO-Text wie vom Server. */
const runAt = (/** @type {number} */ day, /** @type {number} */ hour, minute = 0) => new Date(SUNDAY + ((day * 24 + hour) * 60 + minute) * 60_000).toISOString();

/**
 * Der Satz zu `expr`, zerlegt in Schlüssel und Parameter. Die Serverzone
 * (`scheduler.timezone`) ist UTC, wenn nichts anderes genannt ist. Ohne
 * `nextRun` stehen Server- und Haushaltszone beide auf UTC und der nächste Lauf ist der,
 * den der Ausdruck dort nennt - dann prüfen die Fälle nur die Musterzuordnung.
 */
/** @param {unknown} expr @param {unknown} [nextRun] @param {string} [zone] @param {string | null} [serverZone] */
const parse = (expr, nextRun = literalRun(expr), zone = 'UTC', serverZone = 'UTC') => {
  const out = inZone(zone, () => formatCronSchedule(expr, nextRun, serverZone));
  if (out == null) return null;
  const at = out.indexOf('{');
  return { key: out.slice(0, at), params: JSON.parse(out.slice(at)) };
};

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Der Lauf, den ein Ausdruck der vier Muster in UTC nach SUNDAY als nächsten hätte. */
/** @param {unknown} expr */
function literalRun(expr) {
  const [minute, hour, dom, , dow] = String(expr ?? '').trim().split(/\s+/);
  const m = Number(minute) || 0;
  if (/^\*\//.test(hour ?? '')) return runAt(0, 0, m);
  const h = Number(hour) || 0;
  if (dom && dom !== '*') return new Date(Date.UTC(2026, 11, Number(dom), h, m)).toISOString();
  if (dow && dow !== '*') {
    const index = /^\d+$/.test(dow) ? Number(dow) % 7 : DOW.indexOf(dow.slice(0, 3).toLowerCase());
    return runAt(Math.max(index, 0), h, m);
  }
  return runAt(0, h, m);
}

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
    assert.equal(formatCronSchedule(expr, runAt(1, 2)), null, `${expr} ist kein einzelner Wochentag`);
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
    assert.equal(formatCronSchedule(expr, runAt(0, 2)), null, `${JSON.stringify(expr)} sollte null liefern`);
  }
});

// ── Die Uhrzeit des Haushalts, nicht die des Servers ────────────────────────
//
// Der Cron läuft in der Serverzone (`TZ`, sonst UTC), die Zeile "Nächstes
// Backup" steht in der Haushaltszone. Der Satz nimmt seine Uhrzeit deshalb aus
// dem tatsächlichen nächsten Lauf (`nextRun`) und nennt sie in der
// Haushaltszone - eine Uhrzeit, eine Zone. Server UTC, Haushalt Berlin:

test('Haushaltszone: täglich um 02:00 UTC steht als 03:00 da', () => {
  const daily = parse('0 2 * * *', runAt(1, 2), 'Europe/Berlin');
  assert.equal(daily?.key, 'settings.backupSchedulerCronDaily');
  assert.equal(daily?.params.time, '03:00');
});

test('Haushaltszone: der Wochentag kippt mit, wenn der Lauf über Mitternacht rutscht', () => {
  // Sonntag 23:00 UTC ist Montag 00:00 in Berlin.
  const weekly = parse('0 23 * * sun', runAt(0, 23), 'Europe/Berlin');
  assert.equal(weekly?.key, 'settings.backupSchedulerCronWeekly');
  assert.equal(weekly?.params.weekday, 'Montag');
  assert.equal(weekly?.params.time, '00:00');

  // Und rückwärts: Montag 03:00 UTC ist Sonntag 22:00 in New York.
  const back = parse('0 3 * * mon', runAt(1, 3), 'America/New_York');
  assert.equal(back?.params.weekday, 'Sonntag');
  assert.equal(back?.params.time, '22:00');
});

test('Haushaltszone: der Monatstag kippt mit, solange es ihn in jedem Monat gibt', () => {
  // Am 14. um 23:00 UTC ist in Berlin schon der 15.
  const monthly = parse('0 23 14 * *', '2026-12-14T23:00:00.000Z', 'Europe/Berlin');
  assert.equal(monthly?.key, 'settings.backupSchedulerCronMonthly');
  assert.equal(monthly?.params.day, 15);
  assert.equal(monthly?.params.time, '00:00');

  // Der 31. um 23:00 UTC ist in Berlin der 1. des Folgemonats - aber nur in
  // Monaten mit 31 Tagen. "Monatlich am 1." wäre falsch: der Ausdruck bleibt.
  assert.equal(parse('0 23 31 * *', '2026-12-31T23:00:00.000Z', 'Europe/Berlin'), null);
  // Der 28. um 23:00 UTC wird in Berlin der 29. oder (im Februar) der 1. März.
  assert.equal(parse('0 23 28 * *', '2026-12-28T23:00:00.000Z', 'Europe/Berlin'), null);
  // Der 1. um 00:30 UTC ist in New York der letzte Tag des Vormonats.
  assert.equal(parse('30 0 1 * *', '2026-12-01T00:30:00.000Z', 'America/New_York'), null);
});

test('Haushaltszone mit halber Stunde (+05:30): die Minute wandert mit', () => {
  const daily = parse('0 2 * * *', runAt(1, 2), 'Asia/Kolkata');
  assert.equal(daily?.params.time, '07:30');

  // Alle 6 Stunden zur Minute 00 in UTC sind in Indien alle 6 Stunden zur Minute 30.
  const every6 = parse('0 */6 * * *', runAt(1, 0), 'Asia/Kolkata');
  assert.equal(every6?.key, 'settings.backupSchedulerCronHourly');
  assert.equal(every6?.params.count, 6);
  assert.equal(every6?.params.minute, '30');

  // Eine volle Stunde Versatz lässt die Minute stehen.
  assert.equal(parse('15 */6 * * *', runAt(1, 0, 15), 'Europe/Berlin')?.params.minute, '15');
});

test('Sommerzeit des Haushalts vor dem übernächsten Lauf: der Ausdruck bleibt', () => {
  // Berlin stellt am 28.03.2027 um. Der Lauf am 27. ist 03:00 MEZ, der am 28.
  // schon 04:00 MESZ - "Täglich um 03:00" stimmte nur noch einmal.
  assert.equal(parse('0 2 * * *', '2027-03-27T02:00:00.000Z', 'Europe/Berlin'), null);
  assert.equal(parse('0 2 * * sat', '2027-03-27T02:00:00.000Z', 'Europe/Berlin'), null);
  assert.equal(parse('0 2 1 * *', '2027-03-01T02:00:00.000Z', 'Europe/Berlin'), null);
  // Gegenprobe: eine Woche früher steht der Satz.
  assert.equal(parse('0 2 * * *', '2027-03-20T02:00:00.000Z', 'Europe/Berlin')?.params.time, '03:00');
});

test('Server und Haushalt in derselben Zone: der Satz ist der Ausdruck, auch vor der Umstellung', () => {
  // TZ=Europe/Berlin am Server: der Lauf um 02:00 MEZ ist 01:00 UTC. Der Cron
  // folgt der Wanduhr des Servers, also bleibt es über die Umstellung 02:00.
  const daily = parse('0 2 * * *', '2027-03-27T01:00:00.000Z', 'Europe/Berlin', 'Europe/Berlin');
  assert.equal(daily?.params.time, '02:00');
  // Zwei Namen mit denselben Regeln: der Abstand der Zonen bleibt 0.
  assert.equal(parse('0 2 * * *', '2027-03-27T01:00:00.000Z', 'Europe/Berlin', 'Europe/Paris')?.params.time, '02:00');
});

test('gleiche Felder zu einem Zeitpunkt sind keine gleiche Zone (UTC-Server, Haushalt London)', () => {
  // Im Winter steht London auf UTC: der Lauf am 27.03.2027 ist dort 02:00,
  // der am 28. aber 03:00 BST. "Täglich um 02:00" stimmte nur noch einmal.
  assert.equal(parse('0 2 * * *', '2027-03-27T02:00:00.000Z', 'Europe/London', 'UTC'), null);
  // Gegenprobe: eine Woche früher steht der Satz.
  assert.equal(parse('0 2 * * *', '2027-03-20T02:00:00.000Z', 'Europe/London', 'UTC')?.params.time, '02:00');
});

test('die Serverzone stellt um, der Haushalt nicht: der Ausdruck bleibt', () => {
  // TZ=Europe/Berlin am Server, Haushalt in Indien (keine Sommerzeit). Der Lauf
  // am 27.03.2027 (02:00 MEZ) ist 06:30, der am 28. (02:00 MESZ) schon 05:30.
  assert.equal(parse('0 2 * * *', '2027-03-27T01:00:00.000Z', 'Asia/Kolkata', 'Europe/Berlin'), null);
  // Gegenprobe: eine Woche früher steht der Satz in indischer Zeit.
  assert.equal(parse('0 2 * * *', '2027-03-20T01:00:00.000Z', 'Asia/Kolkata', 'Europe/Berlin')?.params.time, '06:30');
});

test('gemessen wird am tatsächlichen Folgelauf, nicht an einem Messpunkt danach', () => {
  // Server New York, Haushalt Berlin, Lauf am 29.: der 29.09.2026 ist 08:00 in
  // Berlin, der 29.10. aber 07:00 (Berlin hat am 25.10. umgestellt, New York
  // erst am 01.11.). 62 Tage später, am 30.11., stimmt der Abstand wieder.
  assert.equal(parse('0 2 29 * *', '2026-09-29T06:00:00.000Z', 'Europe/Berlin', 'America/New_York'), null);
  // Dasselbe beim 31-Tage-Abstand: der 27.02.2027 ist 08:00, der 27.03. schon
  // 07:00 (New York stellt am 14.03. um, Berlin am 28.03.), am Messpunkt 30.03.
  // haben beide umgestellt.
  assert.equal(parse('0 2 27 * *', '2027-02-27T07:00:00.000Z', 'Europe/Berlin', 'America/New_York'), null);

  // Gegenfall: im Sommer liegen beide Läufe in derselben Lage, der Satz bleibt.
  const summer = parse('0 2 29 * *', '2026-06-29T06:00:00.000Z', 'Europe/Berlin', 'America/New_York');
  assert.equal(summer?.key, 'settings.backupSchedulerCronMonthly');
  assert.equal(summer?.params.day, 29);
  assert.equal(summer?.params.time, '08:00');
  // Und ein Zwischenstand, der keinen Lauf trifft, kostet den Satz nicht: der
  // 01.03.2027 und der 01.04.2027 sind beide 08:00 in Berlin.
  assert.equal(parse('0 2 1 * *', '2027-03-01T07:00:00.000Z', 'Europe/Berlin', 'America/New_York')?.params.time, '08:00');
});

test('ohne Serverzone (alter Server): immer prüfen, keine Abkürzung', () => {
  // Fehlt `scheduler.timezone`, kann die Oberfläche nicht wissen, ob Server
  // und Haushalt dieselbe Wanduhr haben. Sie prüft die Umstellung des
  // Haushalts, als liefe der Server auf UTC - auch dann, wenn der nächste
  // Lauf zufällig genau die Uhrzeit des Ausdrucks nennt.
  // Direkt aufgerufen: `parse` setzte für `undefined` seine Vorgabe UTC ein.
  const inBerlin = (/** @type {string} */ nextRun, /** @type {unknown} */ serverZone) => (
    inZone('Europe/Berlin', () => formatCronSchedule('0 2 * * *', nextRun, serverZone)));
  for (const serverZone of [null, undefined, '', 'Mars/Olympus_Mons']) {
    assert.equal(inBerlin('2027-03-27T01:00:00.000Z', serverZone), null, String(serverZone));
    assert.equal(inBerlin('2026-11-16T01:00:00.000Z', serverZone), `settings.backupSchedulerCronDaily${JSON.stringify({ time: '02:00' })}`, String(serverZone));
  }
  assert.equal(inZone('Europe/Berlin', () => formatCronSchedule('0 2 * * *', '2026-11-16T01:00:00.000Z')), `settings.backupSchedulerCronDaily${JSON.stringify({ time: '02:00' })}`, 'ohne drittes Argument');
});

test('mit Serverzone muss der nächste Lauf dort die Uhrzeit des Ausdrucks treffen', () => {
  // 03:00 UTC ist nie ein Lauf von "0 2 * * *" auf einem UTC-Server.
  assert.equal(parse('0 2 * * *', '2026-11-16T03:00:00.000Z', 'Europe/Berlin', 'UTC'), null);
  // Sonntag 23:00 in Berlin ist Sonntag 22:00 UTC - kein Lauf von "0 23 * * sun" in UTC.
  assert.equal(parse('0 23 * * sun', '2026-11-15T22:00:00.000Z', 'Europe/Berlin', 'UTC'), null);
});

test('ohne nächsten Lauf kein Satz: dann steht der Ausdruck', () => {
  // Ohne `nextRun` wüsste der Satz nicht, in welcher Zone sein "02:00" gilt.
  for (const nextRun of [null, undefined, '', 'kein Zeitpunkt']) {
    assert.equal(inZone('Europe/Berlin', () => formatCronSchedule('0 2 * * *', nextRun)), null, String(nextRun));
  }
});

test('ein nächster Lauf, der nicht zum Ausdruck passt, ergibt keinen Satz', () => {
  // Montag 02:00 ist nie der Lauf eines Mittwochsplans - weiter weg als einen
  // Tag kann keine Zone verschieben.
  assert.equal(parse('0 2 * * wed', runAt(1, 2), 'Europe/Berlin'), null);
  assert.equal(parse('0 2 15 * *', '2026-12-10T02:00:00.000Z', 'Europe/Berlin'), null);
});

test('der Abstand für "überfällig" hängt nicht an der Zone', () => {
  // cronScheduleIntervalMs liest nur den Ausdruck: ein Tag bleibt ein Tag.
  const day = 24 * 60 * 60 * 1000;
  inZone('Asia/Kolkata', () => {
    assert.equal(cronScheduleIntervalMs('0 2 * * *'), day);
    assert.equal(cronScheduleIntervalMs('0 23 * * sun'), 7 * day);
    assert.equal(cronScheduleIntervalMs('0 */6 * * *'), day / 4);
    assert.equal(cronScheduleIntervalMs('0 23 31 * *'), 62 * day);
  });
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
