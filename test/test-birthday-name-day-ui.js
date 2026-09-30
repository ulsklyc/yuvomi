import test from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedLocales } from '../public/i18n.js';
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
  assert.equal(files.length, getSupportedLocales().length);
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

// Critique 2026-09-26 (P2-2): ein neuer Eintrag ohne Bild zeigte einen roten
// "Bild entfernen"-Knopf fuer ein Bild, das es nicht gibt, und ein "?" als
// Platzhalter, das wie eine Hilfe aussah.
test('photo preview without a name shows the camera glyph, not a question mark', () => {
  const preview = birthdays.__test.birthdayPreviewHtml;
  assert.equal(typeof preview, 'function');
  const empty = preview('', null);
  assert.match(empty, /data-lucide="camera"/);
  assert.doesNotMatch(empty, />\?</);
  assert.match(preview('Anna Berg', null), />AB</, 'a named entry keeps its initials');
  assert.match(preview('Anna Berg', 'data:image/png;base64,AAAA'), /<img /);
});

test('the remove-photo button exists only while there is a photo', () => {
  const src = readFileSync(new URL('../public/pages/birthdays.js', import.meta.url), 'utf8');
  const modal = src.slice(src.indexOf('function openBirthdayModal('), src.indexOf("const reminderOffset = panel.querySelector('#bd-reminder-offset')"));
  assert.match(modal, /id="bd-remove-photo"[^>]*\$\{photoData \? '' : ' hidden'\}/, 'rendered hidden without photo');
  const renderPreview = modal.slice(modal.indexOf('const renderPreview = () => {'), modal.indexOf('nameInput.addEventListener'));
  assert.match(renderPreview, /removePhoto\.hidden = !photoData/, 'follows the photo state after crop and removal');
  const onRemove = modal.slice(modal.indexOf("removePhoto.addEventListener('click'"));
  assert.match(onRemove.slice(0, 400), /photoEdit\?*\.focus\(\)/, 'removing hides the focused button - focus moves to the edit button');
  const css = readFileSync(new URL('../public/styles/birthdays.css', import.meta.url), 'utf8');
  assert.match(css, /\.birthday-modal__photo-action\[hidden\]\s*\{\s*display:\s*none;?\s*\}/, 'display: inline-flex would beat the UA [hidden]');
});

// ── R10 L5: Geburtstage als Liste + Detail ────────────────────────────────

const BD = {
  id: 4, name: 'Onkel Mike', birth_date: '1985-11-02', next_birthday: '2026-11-02', next_age: 41,
  days_until: 36, notes: 'Bruder in Hamburg', name_day: null, reminder_offset: null,
};

test('Liste + Detail: jede Zeile ist fuer den Baustein waehlbar, der Hauptknopf ist ihr Fokusziel', () => {
  const html = birthdays.birthdayItemHtml(BD);
  assert.match(html, /<article class="list-row birthday-item [^"]*" data-id="4" data-md-id="4">/);
  assert.match(html, /<button type="button" class="list-row__main list-row__main--interactive" data-open="4" data-md-focus>/);
});

test('Liste + Detail: die Spalte nennt wann und wie alt, Datum, Notiz - und ein Bild nur, wenn es eins gibt', async () => {
  const { installMiniDom } = await import('./mini-dom.js');
  const restore = installMiniDom();
  try {
    const rows = birthdays.__test.birthdayPaneSections(BD);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    assert.equal(byLabel['birthdays.photoLabel'].node, null, 'ohne Bild keine Initialen-Scheibe als „Profilbild"');
    assert.match(rows[1].value, /birthdays\.ageNoteDays/, 'die Auskunft, die die Zeile nur knapp traegt');
    assert.ok(byLabel['birthdays.birthDateLabel'].value, 'Geburtsdatum');
    assert.equal(byLabel['birthdays.notesLabel'].value, 'Bruder in Hamburg');
    const withPhoto = birthdays.__test.birthdayPaneSections({ ...BD, photo_data: 'data:image/png;base64,AA' });
    assert.ok(withPhoto[0].node, 'mit Bild steht es oben');
  } finally { restore(); }
  assert.equal(birthdays.__test.renderBirthdayPane('999', null), false, 'unbekannte ID: Leerzustand (Rueckgabe-Vertrag)');
});

test('Liste + Detail: Seite, Markup, Klickweg und die klebende Spalte', () => {
  const src = readFileSync(new URL('../public/pages/birthdays.js', import.meta.url), 'utf8');
  assert.match(src, /className: 'birthdays-page app-page--list-detail'/, 'die Seitenwurzel ist der Container der Schwelle');
  assert.match(src, /<div class="split-view birthdays-split">/);
  assert.match(src, /splitViewDetailHtml\(\{\s*id: 'birthdays'/);
  assert.match(src, /if \(_md\) \{ _md\.open\(open\.dataset\.open, open\); return; \}/, 'der Tipp geht durch den Baustein');
  assert.match(src, /mountBirthdaysDetail\(signal\);/);
  const css = readFileSync(new URL('../public/styles/birthdays.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('@container module-surface (min-width: 65rem)'));
  assert.ok(block.length > 0, 'die Spalte gilt ab der Schwelle aus tokens.css');
  assert.match(block, /position: sticky;/);
  assert.match(block, /height: calc\(var\(--viewport-height\) - var\(--birthdays-detail-top/,
    'die Hoehe rechnet ab der gemessenen Oberkante - sonst ragt sie in Ruhe unter den Falz');
});
