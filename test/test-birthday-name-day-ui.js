import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const birthdays = await import('../public/pages/birthdays.js');
const { __test: calendar } = await import('../public/pages/calendar.js');
const { localizeBirthdayEvent } = await import('../public/utils/birthday-event.js');

test('person detail preselects the stored name-day month and day', () => {
  assert.equal(typeof birthdays.renderNameDayField, 'function');
  const html = birthdays.renderNameDayField({ name_day: '05-24' });
  assert.match(html, /id="bd-name-day-month"/);
  assert.match(html, /id="bd-name-day-day"/);
  assert.match(html, /value="05" selected/);
  assert.match(html, /value="24" selected/);
  assert.match(html, /id="bd-name-day-clear"/);
});

test('name-day selection produces canonical MM-DD or an empty value', () => {
  assert.equal(typeof birthdays.normalizeNameDaySelection, 'function');
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('5', '3'),
    { value: '05-03', complete: true },
  );
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('', ''),
    { value: null, complete: true },
  );
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('05', ''),
    { value: null, complete: false },
  );
});

test('February offers 29 days, April 30 and January 31', () => {
  assert.equal(typeof birthdays.daysInNameDayMonth, 'function');
  assert.equal(birthdays.daysInNameDayMonth('02'), 29);
  assert.equal(birthdays.daysInNameDayMonth('04'), 30);
  assert.equal(birthdays.daysInNameDayMonth('01'), 31);
});

test('badge counts nearby birthdays and name days as separate occurrences', () => {
  assert.equal(typeof birthdays.countBirthdaysSoon, 'function');
  assert.equal(birthdays.countBirthdaysSoon([
    { days_until: 2, name_day_days_until: 1 },
    { days_until: 10, name_day_days_until: 3 },
    { days_until: 20, name_day_days_until: null },
  ]), 3);
});

test('person list renders the name-day countdown, date and label after the birthday', () => {
  assert.equal(typeof birthdays.birthdayItemHtml, 'function');
  const html = birthdays.birthdayItemHtml({
    id: 7,
    name: 'Jiří Pech',
    birth_date: '1989-12-18',
    next_birthday: '2026-12-18',
    next_age: 37,
    days_until: 108,
    name_day: '04-24',
    next_name_day: '2027-04-24',
    name_day_days_until: 235,
  });

  assert.match(html, /birthday-item__meta--with-name-day/);
  // Plural-`count` statt `days` (Critique 2026-09-26): "in 1 Tagen" brach in
  // Sprachen mit anderen Pluralformen.
  assert.match(html, /birthdays\.inDays\{&quot;count&quot;:235\}/);
  assert.match(html, /2027-04-24/);
  assert.match(html, /birthdays\.celebratesNameDay/);
});

test('name-day list label exists in every supported locale', () => {
  const localeDir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 24);
  for (const file of files) {
    const locale = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'));
    assert.equal(typeof locale.birthdays.celebratesNameDay, 'string', file);
    assert.ok(locale.birthdays.celebratesNameDay.trim(), file);
  }
});

test('calendar localizes name days differently from birthdays', () => {
  const localized = localizeBirthdayEvent({
    id: 17,
    birthday_name: 'Jiří',
    birthday_event_kind: 'name_day',
    title: 'stored title',
    description: 'stored description',
  });

  assert.match(localized.title, /^birthdays\.nameDayCalendarEventTitle/);
  assert.match(localized.description, /^birthdays\.nameDayCalendarEventDescription/);
  assert.doesNotMatch(localized.title, /^birthdays\.calendarEventTitle/);
});

test('calendar renders the generated name-day icon as a balloon', () => {
  assert.equal(calendar.eventIconName('balloon'), 'balloon');
  const html = calendar.eventIconHtml('balloon');
  assert.match(html, /event-icon--custom/);
  assert.match(html, /M18 8c0 4-3\.5 8-6 8s-6-4-6-8/);
  assert.doesNotMatch(html, /data-lucide/);
});

// Critique 2026-09-26: der Namenstag las "in 0 Tagen" und "in 1 Tagen" - die
// Heute/Morgen-Weiche stand nur im Geburtstags-Chip.
const nameDayRow = (days) => birthdays.birthdayItemHtml({
  id: 8, name: 'Jana Nováková', birth_date: '1990-01-10', next_birthday: '2027-01-10', next_age: 37,
  days_until: 106, name_day: '09-26', next_name_day: '2026-09-26', name_day_days_until: days,
});
const nameDayText = (html) => html.match(/<span class="birthday-item__name-day">([^<]*)</)?.[1] ?? '';

test('name-day countdown says today and tomorrow instead of "in 0/1 days"', () => {
  assert.match(nameDayText(nameDayRow(0)), /^common\.today · /);
  assert.match(nameDayText(nameDayRow(1)), /^common\.tomorrow · /);
  assert.match(nameDayText(nameDayRow(2)), /^birthdays\.inDays\{&quot;count&quot;:2\} · /);
});

test('birthday and name-day countdowns pass a plural count, never a bare days number', () => {
  const html = birthdays.birthdayItemHtml({
    id: 9, name: 'Tom', birth_date: '1990-10-06', next_birthday: '2026-10-06', next_age: 36, days_until: 10,
  });
  assert.match(html, /birthdays\.inDays\{&quot;count&quot;:10\}/);
  assert.doesNotMatch(html + nameDayRow(5), /&quot;days&quot;/);
});

test('every locale pluralizes birthdays.inDays on {{count}}', () => {
  const localeDir = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
    const block = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8')).birthdays;
    assert.match(block.inDays, /\{\{count\}\}/, `${file}: inDays`);
    assert.doesNotMatch(block.inDays, /\{\{days\}\}/, `${file}: inDays`);
    assert.match(block.inDays_one ?? '', /\{\{count\}\}/, `${file}: inDays_one`);
  }
});
