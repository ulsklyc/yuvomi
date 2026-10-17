/** Independent birthday subscriptions; reminders do not control this export. */
import { randomBytes } from 'node:crypto';
import { escapeICSText, foldLine, findUserIdByFeedToken as sharedFindUserIdByFeedToken } from './ics-export.js';
import { eventTitle, nameDayEventTitle } from './birthdays.js';
import { resolveHouseholdFormats, translate } from '../utils/i18n.js';

export function buildBirthdayFeed(database, now = new Date()) {
  const { locale } = resolveHouseholdFormats(database);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Yuvomi//Birthdays//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(translate(locale, 'nav.birthdays'))}`];
  for (const birthday of database.prepare('SELECT id, name, birth_date, name_day FROM birthdays ORDER BY id').all()) {
    const dates = [
      { kind: 'birthday', day: birthday.birth_date?.slice(5, 10), title: eventTitle(birthday.name, locale) },
      { kind: 'name-day', day: birthday.name_day, title: nameDayEventTitle(birthday.name, locale) },
    ];
    for (const entry of dates) {
      if (!entry.day) continue;
      // A leap-year anchor retains February 29 and keeps birth years out of the feed.
      const date = '2000-' + entry.day;
      const parsed = new Date(date + 'T00:00:00Z');
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) continue;
      parsed.setUTCDate(parsed.getUTCDate() + 1);
      lines.push('BEGIN:VEVENT', `UID:${entry.kind}-${birthday.id}@yuvomi`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${parsed.toISOString().slice(0, 10).replace(/-/g, '')}`,
        entry.day === '02-29' ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1'
          : 'RRULE:FREQ=YEARLY;INTERVAL=1', 'TRANSP:TRANSPARENT',
        `SUMMARY:${escapeICSText(entry.title)}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function getFeedToken(database, userId) {
  return database.prepare('SELECT birthday_feed_token AS token FROM users WHERE id = ?').get(userId)?.token ?? null;
}

export function regenerateFeedToken(database, userId) {
  const token = randomBytes(32).toString('base64url');
  database.prepare('UPDATE users SET birthday_feed_token = ? WHERE id = ?').run(token, userId);
  return token;
}

export function clearFeedToken(database, userId) {
  database.prepare('UPDATE users SET birthday_feed_token = NULL WHERE id = ?').run(userId);
}

export function findUserIdByFeedToken(database, token) {
  return sharedFindUserIdByFeedToken(database, 'birthday_feed_token', token);
}
