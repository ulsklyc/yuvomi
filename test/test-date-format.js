/**
 * Test: die EINE Datums- und Zeitschreibweise der App (R23, D11,
 * public/utils/date-format.js).
 *
 * Gefahren wird die echte public/i18n.js mit den echten Locale-Dateien
 * (de, en, fr), dazu die 12-Stunden-Einstellung und eine Haushaltszone, die
 * von der Prozesszone abweicht. Das Skript laeuft unter TZ=UTC,
 * Pacific/Auckland und America/Los_Angeles: ein Test, der nur in der Zone
 * des Entwicklers laeuft, sieht den Nachbartag nie.
 *
 * "Heute" kommt als fester Key herein, wo die Regel daran haengt; wo die
 * Funktion die Uhr selbst fragt, wird die Haushaltszone so gewaehlt, dass
 * sie einen anderen Tag hat als UTC (Gegenprobe: ein `toISOString().slice`
 * waere dort einen Tag daneben).
 *
 * Ausfuehren: npm run test:date-format
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Browser-absolute Pfade ('/i18n.js', '/utils/...') auf public/ - auf das
// ORIGINAL, nicht auf die Stubs von test-browser-loader.mjs.
const publicUrl = pathToFileURL(path.join(root, 'public') + path.sep).href;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith('/') && !spec.startsWith('//')) return next(new URL('.' + spec, ${JSON.stringify(publicUrl)}).href, ctx);
    return next(spec, ctx);
  }`)}`);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.fetch = async (url) => {
  const file = path.join(root, 'public', String(url));
  return { ok: true, json: async () => JSON.parse(readFileSync(file, 'utf8')) };
};
globalThis.document = { documentElement: { lang: '', dir: '' } };
globalThis.window = { dispatchEvent: () => true, matchMedia: () => ({ matches: false }) };
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['de'], language: 'de' }, configurable: true });

const i18n = await import('/i18n.js');
await i18n.initI18n();
const tz = await import('/utils/timezone.js');
const fmt = await import('/utils/date-format.js');

const ZONE = process.env.TZ || 'UTC';
const NBSP = /[  ]/g;
const plain = (s) => String(s).replace(NBSP, ' ');
// Der kurze Wochentag kommt aus ICU, und dessen Fassung haengt an der
// ICU-Version ("Fr" in Node, "Fr." in Chrome) - der Test fragt dieselbe Quelle.
const wd = (locale, key) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
  .format(new Date(`${key}T12:00:00Z`));

async function as({ locale = 'de', time = '24h', date = 'dmy', region = null }, fn) {
  await i18n.setLocale(locale);
  store.set('yuvomi-time-format', time);
  store.set('yuvomi-date-format', date);
  if (region) store.set('yuvomi-number-locale', region); else store.delete('yuvomi-number-locale');
  try { return await fn(); } finally {
    store.delete('yuvomi-number-locale');
    await i18n.setLocale('de');
  }
}

test(`TZ=${ZONE}: Spanne "06:00 - 14:00", Zeitwort einmal, 12 h ohne "Uhr"`, async () => {
  await as({ locale: 'de' }, () => {
    assert.equal(fmt.timeSpanText('06:00', '14:00', { suffix: false }), '06:00 - 14:00');
    assert.equal(fmt.timeSpanText('06:00', '14:00'), '06:00 - 14:00 Uhr');
    assert.equal(fmt.timeSpanText('06:00', null), '06:00 Uhr');
    assert.equal(fmt.timeSpanText('06:00', '06:00', { suffix: false }), '06:00');
  });
  await as({ locale: 'en', time: '12h', date: 'mdy' }, () => {
    assert.equal(fmt.timeSpanText('06:00', '14:00'), '6:00 AM - 2:00 PM');
    assert.equal(fmt.clockText('2026-10-24T21:15'), '9:15 PM');
  });
  await as({ locale: 'fr' }, () => {
    // fr hat kein Zeitwort; die Ziffern bleiben 24 h.
    assert.equal(plain(fmt.timeSpanText('06:00', '14:00')), '06:00 - 14:00');
  });
});

test(`TZ=${ZONE}: Schichtspanne folgt der 12-Stunden-Einstellung (vorher roh "22:00-06:00")`, async () => {
  await as({ locale: 'de' }, () => {
    assert.equal(fmt.shiftTimeText({ start_time: '06:00', end_time: '14:00' }), '06:00 - 14:00');
    assert.equal(fmt.shiftTimeText({ start_time: '22:00', end_time: '06:00' }), '22:00 - 06:00 +1');
    assert.equal(fmt.shiftTimeText({ start_time: '07:00', end_time: '07:00' }), '07:00 - 07:00 +1 · 24 h');
    assert.equal(fmt.shiftTimeText({ start_time: null, end_time: null }), '');
  });
  await as({ locale: 'en', time: '12h' }, () => {
    assert.equal(fmt.shiftTimeText({ start_time: '22:00', end_time: '06:00' }), '10:00 PM - 6:00 AM +1');
  });
});

test(`TZ=${ZONE}: Datum - Jahr nur ausserhalb des laufenden, Wochentag kurz`, async () => {
  const today = '2026-10-24';
  await as({ locale: 'de' }, () => {
    assert.equal(fmt.dateText('2026-10-30', { today }), '30.10.');
    assert.equal(fmt.dateText('2027-01-08', { today }), '08.01.2027');
    assert.equal(fmt.dateText('2026-10-30', { today, weekday: true }), `${wd('de', '2026-10-30')}, 30.10.`);
    assert.equal(fmt.dateText('2026-10-30', { today, year: true }), '30.10.2026');
  });
  await as({ locale: 'en', date: 'mdy' }, () => {
    assert.equal(fmt.dateText('2026-10-30', { today, weekday: true }), `${wd('en', '2026-10-30')}, 10/30`);
    assert.equal(fmt.dateText('2027-01-08', { today }), '01/08/2027');
  });
  await as({ locale: 'fr', date: 'dmy_slash' }, () => {
    assert.equal(fmt.dateText('2026-10-30', { today, weekday: true }), `${wd('fr', '2026-10-30')}, 30/10`);
  });
});

test(`TZ=${ZONE}: Zeitraum - das Jahr hoechstens einmal (vorher "19.10.2026 - 25.10.2026")`, async () => {
  const today = '2026-10-24';
  await as({ locale: 'de' }, () => {
    assert.equal(fmt.dateRangeText('2026-10-19', '2026-10-25', { today }), '19.10. - 25.10.');
    assert.equal(fmt.dateRangeText('2027-03-01', '2027-03-07', { today }), '01.03. - 07.03.2027');
    assert.equal(fmt.dateRangeText('2026-12-28', '2027-01-03', { today }), '28.12.2026 - 03.01.2027');
  });
});

test(`TZ=${ZONE}: Abstand "in 6 Tagen" wie die Geburtstage, nicht "6 Tage" wie eine Dauer`, async () => {
  const today = '2026-10-24';
  await as({ locale: 'de' }, () => {
    assert.equal(fmt.relativeDayText('2026-10-24', { today }), 'Heute');
    assert.equal(fmt.relativeDayText('2026-10-25', { today }), 'Morgen');
    assert.equal(fmt.relativeDayText('2026-10-23', { today }), 'Gestern');
    assert.equal(fmt.relativeDayText('2026-10-30', { today }), 'in 6 Tagen');
    assert.equal(fmt.relativeDayText('2026-10-21', { today }), 'vor 3 Tagen');
    assert.equal(fmt.relativeDayText('2026-12-01', { today }), 'in 5 Wochen');
    assert.equal(fmt.relativeDayText('2027-02-24', { today }), 'in 4 Monaten');
    assert.equal(fmt.relativeDayText('2028-10-24', { today }), 'in 2 Jahren');
    assert.equal(plain(fmt.dateWithDistanceText('2026-10-30', { today })), `${wd('de', '2026-10-30')}, 30.10. · in 6 Tagen`);
    assert.match(fmt.dateWithDistanceText('2026-10-30', { today }), /^[^ ]+ · [^ ]+$/, 'umbrechen darf nur der Trenner');
    assert.equal(fmt.dateWithDistanceText('2026-10-25', { today }), 'Morgen');
  });
  await as({ locale: 'en' }, () => {
    assert.equal(fmt.relativeDayText('2026-10-30', { today }), 'in 6 days');
    assert.equal(fmt.relativeDayText('2026-10-25', { today }), 'Tomorrow');
  });
  await as({ locale: 'fr' }, () => {
    assert.equal(plain(fmt.relativeDayText('2026-10-30', { today })), 'dans 6 jours');
  });
  // Die Zahl gehoert der Region, das Wort der Sprache: Arabisch-Ziffern unter
  // ar-SA, Wort englisch.
  await as({ locale: 'en', region: 'ar-SA' }, () => {
    assert.match(fmt.relativeDayText('2026-11-05', { today }), /^in ١٢ days$/);
  });
});

test(`TZ=${ZONE}: "heute" ist der Tag der HAUSHALTSZONE, nicht der UTC-Tag`, async () => {
  // Ein Zeitpunkt, an dem Auckland schon den naechsten Tag hat und Los Angeles
  // noch den vorigen: 2026-10-24T12:30Z ist in Auckland 25.10. 01:30, in
  // Los Angeles 24.10. 05:30.
  const instant = '2026-10-24T12:30:00Z';
  await as({ locale: 'de' }, () => {
    tz.setDisplayTimeZone('Pacific/Auckland');
    try {
      assert.equal(fmt.dateText(instant, { today: '2026-10-25' }), '25.10.');
      assert.equal(fmt.relativeDayText(instant, { today: '2026-10-25' }), 'Heute');
      assert.equal(fmt.weekdayShort(instant), wd('de', '2026-10-25'));
    } finally { tz.setDisplayTimeZone(null); }
    tz.setDisplayTimeZone('America/Los_Angeles');
    try {
      assert.equal(fmt.dateText(instant, { today: '2026-10-24' }), '24.10.');
      assert.equal(fmt.weekdayShort(instant), wd('de', '2026-10-24'));
      // Ein Datums-Key wird gelesen, nie umgerechnet - auch westlich von UTC.
      assert.equal(fmt.dateText('2026-10-24', { today: '2026-10-24', weekday: true }), `${wd('de', '2026-10-24')}, 24.10.`);
    } finally { tz.setDisplayTimeZone(null); }
  });
});

test(`TZ=${ZONE}: Anteil ueber Intl der Region (vorher "53%" von Hand)`, async () => {
  await as({ locale: 'de' }, () => {
    assert.equal(plain(fmt.percentText(53)), '53 %');
    assert.equal(plain(fmt.percentText(0.531, { ratio: true })), '53 %');
  });
  await as({ locale: 'en' }, () => {
    assert.equal(fmt.percentText(53), '53%');
  });
  await as({ locale: 'fr' }, () => {
    assert.equal(plain(fmt.percentText(112)), '112 %');
  });
  assert.equal(fmt.percentText(Number.NaN), '');
});
