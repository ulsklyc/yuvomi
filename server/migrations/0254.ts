// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 254,
    description: 'Birthdays and contacts: a birthday without a year (#2095)',
    // A BIRTHDAY CAN BE A DAY AND A MONTH. iCloud stores one without a year with
    // the placeholder year 1604 and marks it, `BDAY;X-APPLE-OMIT-YEAR=1604:
    // 1604-03-15`; vCard 4 writes `--0315`. The parsers read only the value, so
    // 1604 landed as a real year in contacts and in the birthdays imported from
    // them, with an age of over 400. The flag says "the year is unknown";
    // birth_date and contacts.birthday stay full dates and carry the leap year
    // 2000 as placeholder (29 February stays a valid day, like the name day's
    // `2000-MM-DD` event), so sorting, the next birthday and the reminders keep
    // reading the same column. A reader that shows a year or an age asks the
    // flag first.
    //
    // THE EXISTING 1604 ROWS ARE REPAIRED HERE. 1604 is never a real birth year
    // of a household contact; it is Apple's placeholder. The generated calendar
    // events follow on the next birthday sync, which rewrites their start and
    // description from the row.
    up: `
      ALTER TABLE birthdays ADD COLUMN year_unknown INTEGER NOT NULL DEFAULT 0 CHECK(year_unknown IN (0, 1));
      ALTER TABLE contacts ADD COLUMN birthday_year_unknown INTEGER NOT NULL DEFAULT 0 CHECK(birthday_year_unknown IN (0, 1));
      UPDATE birthdays SET birth_date = '2000' || substr(birth_date, 5), year_unknown = 1
        WHERE substr(birth_date, 1, 5) = '1604-';
      UPDATE contacts SET birthday = '2000' || substr(birthday, 5), birthday_year_unknown = 1
        WHERE substr(birthday, 1, 5) = '1604-';
    `,
  };
