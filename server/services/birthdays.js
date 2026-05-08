const BIRTHDAY_COLOR = '#E11D48';
const BIRTHDAY_RRULE = 'FREQ=YEARLY;INTERVAL=1';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizedMonthDay(birthDate, year) {
  const [, monthStr, dayStr] = String(birthDate).split('-');
  const month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);
  if (month === 2 && day === 29 && !leapYear(year)) day = 28;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function nextBirthdayDate(birthDate, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const thisYear = normalizedMonthDay(birthDate, now.getFullYear());
  const today = now.toISOString().slice(0, 10);
  return thisYear >= today
    ? thisYear
    : normalizedMonthDay(birthDate, now.getFullYear() + 1);
}

function nextBirthdayAge(birthDate, from = new Date()) {
  const next = nextBirthdayDate(birthDate, from);
  return parseInt(next.slice(0, 4), 10) - parseInt(String(birthDate).slice(0, 4), 10);
}

function daysUntilBirthday(birthDate, from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const next = nextBirthdayDate(birthDate, now);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextUtc = Date.UTC(
    parseInt(next.slice(0, 4), 10),
    parseInt(next.slice(5, 7), 10) - 1,
    parseInt(next.slice(8, 10), 10),
  );
  return Math.round((nextUtc - todayUtc) / 86400000);
}

function getOffsetMinutes(birthday) {
  if (birthday.reminder_offset === 'custom') {
    const amount = parseInt(birthday.reminder_custom_amount, 10) || 1;
    const unit = birthday.reminder_custom_unit || 'days';
    if (unit === 'weeks') return amount * 10080;
    if (unit === 'days') return amount * 1440;
    if (unit === 'hours') return amount * 60;
    return amount;
  }
  return parseInt(birthday.reminder_offset, 10) || 0;
}

function birthdayReminderAt(birthDate, offsetMin = 0, from = new Date()) {
  const next = nextBirthdayDate(birthDate, from);
  const baseTime = new Date(`${next}T12:00:00Z`).getTime();
  return new Date(baseTime - (offsetMin || 0) * 60000).toISOString();
}

function eventTitle(name) {
  return `Birthday: ${name}`;
}

function eventDescription(name, birthDate) {
  return `Birthday reminder for ${name} (${birthDate}).`;
}

function syncBirthdayCalendarEvent(database, birthday) {
  const payload = {
    title: eventTitle(birthday.name),
    description: eventDescription(birthday.name, birthday.birth_date),
    start_datetime: birthday.birth_date,
    end_datetime: null,
    all_day: 1,
    location: null,
    color: BIRTHDAY_COLOR,
    icon: 'cake',
    assigned_to: null,
    recurrence_rule: BIRTHDAY_RRULE,
    created_by: birthday.created_by,
  };

  if (birthday.calendar_event_id) {
    const existing = database.prepare('SELECT id FROM calendar_events WHERE id = ?').get(birthday.calendar_event_id);
    if (existing) {
      database.prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?, all_day = ?,
            location = ?, color = ?, icon = ?, assigned_to = ?, recurrence_rule = ?, created_by = ?,
            external_source = 'local'
        WHERE id = ?
      `).run(
        payload.title,
        payload.description,
        payload.start_datetime,
        payload.end_datetime,
        payload.all_day,
        payload.location,
        payload.color,
        payload.icon,
        payload.assigned_to,
        payload.recurrence_rule,
        payload.created_by,
        birthday.calendar_event_id,
      );
      return birthday.calendar_event_id;
    }
  }

  const result = database.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day, location, color,
       icon, assigned_to, created_by, recurrence_rule, external_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
  `).run(
    payload.title,
    payload.description,
    payload.start_datetime,
    payload.end_datetime,
    payload.all_day,
    payload.location,
    payload.color,
    payload.icon,
    payload.assigned_to,
    payload.created_by,
    payload.recurrence_rule,
  );

  database.prepare('UPDATE birthdays SET calendar_event_id = ? WHERE id = ?')
    .run(result.lastInsertRowid, birthday.id);
  return result.lastInsertRowid;
}

function syncBirthdayReminder(database, birthday, from = new Date()) {
  if (!birthday.calendar_event_id) return null;

  if (birthday.reminder_offset === '') {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(birthday.calendar_event_id, birthday.created_by);
    return null;
  }

  const offsetMin = getOffsetMinutes(birthday);
  const desired = birthdayReminderAt(birthday.birth_date, offsetMin, from);
  const existing = database.prepare(`
    SELECT * FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    ORDER BY created_at DESC
  `).all(birthday.calendar_event_id, birthday.created_by);

  const active = existing.find((row) => row.dismissed === 0);
  if (active && active.remind_at === desired) return active.id;

  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(birthday.calendar_event_id, birthday.created_by);

  const result = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `).run(birthday.calendar_event_id, desired, birthday.created_by);

  return result.lastInsertRowid;
}

function syncBirthdayArtifacts(database, birthday, from = new Date()) {
  const calendarEventId = syncBirthdayCalendarEvent(database, birthday);
  const refreshed = { ...birthday, calendar_event_id: calendarEventId };
  syncBirthdayReminder(database, refreshed, from);
  return refreshed;
}

function deleteBirthdayArtifacts(database, birthday) {
  if (birthday.calendar_event_id) {
    database.prepare(`
      DELETE FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    `).run(birthday.calendar_event_id, birthday.created_by);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(birthday.calendar_event_id);
  }
}

function hydrateBirthday(row, from = new Date()) {
  const next_birthday = nextBirthdayDate(row.birth_date, from);
  return {
    ...row,
    next_birthday,
    next_age: nextBirthdayAge(row.birth_date, from),
    days_until: daysUntilBirthday(row.birth_date, from),
  };
}

function syncAllBirthdayReminders(database, userId, from = new Date()) {
  const birthdays = database.prepare(`
    SELECT * FROM birthdays WHERE created_by = ? ORDER BY birth_date ASC
  `).all(userId);
  birthdays.forEach((birthday) => {
    const refreshed = birthday.calendar_event_id ? birthday : {
      ...birthday,
      calendar_event_id: syncBirthdayCalendarEvent(database, birthday),
    };
    syncBirthdayReminder(database, refreshed, from);
  });
}

export {
  BIRTHDAY_COLOR,
  BIRTHDAY_RRULE,
  birthdayReminderAt,
  daysUntilBirthday,
  deleteBirthdayArtifacts,
  eventDescription,
  eventTitle,
  hydrateBirthday,
  nextBirthdayAge,
  nextBirthdayDate,
  syncAllBirthdayReminders,
  syncBirthdayArtifacts,
};
