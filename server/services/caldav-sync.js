/**
 * Modul: Generic CalDAV Sync
 * Zweck: Multi-Account CalDAV synchronization with calendar selection
 * Abhängigkeiten: tsdav, server/db.js, server/services/ics-parser.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CalDAV');

import * as db from '../db.js';

// Reused functions from apple-calendar.js
import {
  parseICS,
  formatICSDate,
  tzLocalToUTC,
  applyDuration
} from './ics-parser.js';

function escapeICSText(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Convert a DB datetime string (YYYY-MM-DDThh:mm or ...hh:mm:ss[.ms][Z/±offset])
// to RFC 5545 basic format (YYYYMMDDTHHmmss[Z/±hhmm]).
// parseTimeInput returns HH:MM (no seconds) — without this, servers like mailbox.org
// receive HHMM (4 digits) instead of HHMMSS (6), and default to 00:00 (#246).
export function toICSDatetime(dt) {
  if (!dt) return '';
  if (!dt.includes('T')) return dt.replace(/-/g, '') + 'T000000';
  const [datePart, rest] = dt.split('T');
  const dateStr = datePart.replace(/-/g, '');
  const m = rest.match(/^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return `${dateStr}T000000`;
  const ss = m[3] || '00';
  const tz = (m[4] || '').replace(':', '');
  return `${dateStr}T${m[1]}${m[2]}${ss}${tz}`;
}

function buildCalDAVICS(event) {
  const uid  = `oikos-${event.id}@oikos.local`;
  const now  = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Oikos//CalDAV Sync//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeICSText(event.title)}`,
  ];

  if (event.all_day) {
    const startDate = event.start_datetime.slice(0, 10).replace(/-/g, '');
    const endSrc    = (event.end_datetime || event.start_datetime).slice(0, 10);
    const endD      = new Date(endSrc + 'T00:00:00');
    endD.setDate(endD.getDate() + 1);
    const endDate = `${endD.getFullYear()}${String(endD.getMonth() + 1).padStart(2, '0')}${String(endD.getDate()).padStart(2, '0')}`;
    lines.push(`DTSTART;VALUE=DATE:${startDate}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
  } else {
    lines.push(`DTSTART:${toICSDatetime(event.start_datetime)}`);
    lines.push(`DTEND:${toICSDatetime(event.end_datetime || event.start_datetime)}`);
  }

  if (event.description)     lines.push(`DESCRIPTION:${escapeICSText(event.description)}`);
  if (event.location)        lines.push(`LOCATION:${escapeICSText(event.location)}`);
  if (event.recurrence_rule) lines.push(event.recurrence_rule);

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// --------------------------------------------------------
// Helper Functions
// --------------------------------------------------------

function normalizeCalColor(c) {
  if (!c) return null;
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7); // strip alpha
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return null;
}

function upsertExternalCalendar(source, externalId, name, color) {
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, name, color);
  return row.id;
}

// --------------------------------------------------------
// Credentials Helpers
// --------------------------------------------------------

function getAccountById(accountId) {
  return db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
}

function getAllAccounts() {
  return db.get().prepare('SELECT * FROM caldav_accounts').all();
}

// --------------------------------------------------------
// Connection Testing
// --------------------------------------------------------

async function testConnection(caldavUrl, username, password) {
  try {
    const { createDAVClient } = await import('tsdav');
    const client = await createDAVClient({
      serverUrl:          caldavUrl,
      credentials:        { username, password },
      authMethod:         'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    if (!calendars.length) {
      throw new Error('Connected, but no calendars found.');
    }

    return { ok: true, calendars };
  } catch (err) {
    log.error('Connection test failed:', err.message);
    throw new Error(`CalDAV connection failed: ${err.message}`);
  }
}

// --------------------------------------------------------
// Account Management
// --------------------------------------------------------

async function addAccount(name, caldavUrl, username, password) {
  // Validate inputs
  if (!name || !caldavUrl || !username || !password) {
    throw new Error('All fields required: name, caldavUrl, username, password');
  }

  // Test connection first
  const { calendars } = await testConnection(caldavUrl, username, password);

  // Check for duplicate
  const existing = db.get().prepare(
    'SELECT id FROM caldav_accounts WHERE caldav_url = ? AND username = ?'
  ).get(caldavUrl, username);

  if (existing) {
    throw new Error('Account with this URL and username already exists.');
  }

  // Warn if DB_ENCRYPTION_KEY not set
  if (!process.env.DB_ENCRYPTION_KEY) {
    log.warn('WARNING: DB_ENCRYPTION_KEY is not set - CalDAV credentials will be stored unencrypted.');
  }

  // Insert account
  const result = db.get().prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES (?, ?, ?, ?)
  `).run(name, caldavUrl, username, password);

  const accountId = result.lastInsertRowid;

  // Insert calendar selections (all enabled by default)
  const calendarData = [];
  for (const cal of calendars) {
    const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
    const calName = cal.displayName || 'Unnamed Calendar';

    db.get().prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, ?, 1)
    `).run(accountId, cal.url, calName, calColor);

    calendarData.push({ url: cal.url, name: calName, color: calColor, enabled: true });
  }

  log.info(`Added CalDAV account "${name}" with ${calendars.length} calendars.`);

  return { accountId, calendars: calendarData };
}

function listAccounts() {
  const accounts = db.get().prepare(`
    SELECT id, name, caldav_url, username, created_at, last_sync
    FROM caldav_accounts
    ORDER BY created_at DESC
  `).all();

  // Do NOT return password (security)
  return accounts.map(acc => ({
    id: acc.id,
    name: acc.name,
    caldavUrl: acc.caldav_url,
    username: acc.username,
    createdAt: acc.created_at,
    lastSync: acc.last_sync,
  }));
}

async function updateAccount(accountId, { name, caldavUrl, username, password }) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  // If credentials changed, test connection
  const credentialsChanged =
    (caldavUrl && caldavUrl !== account.caldav_url) ||
    (username && username !== account.username) ||
    (password && password !== account.password);

  if (credentialsChanged) {
    const testUrl = caldavUrl || account.caldav_url;
    const testUser = username || account.username;
    const testPwd = password || account.password;

    const { calendars } = await testConnection(testUrl, testUser, testPwd);

    // If credentials changed, refresh calendar list
    if (calendars) {
      // Delete old selections
      db.get().prepare('DELETE FROM caldav_calendar_selection WHERE account_id = ?').run(accountId);

      // Insert new selections
      for (const cal of calendars) {
        const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
        const calName = cal.displayName || 'Unnamed Calendar';

        db.get().prepare(`
          INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
          VALUES (?, ?, ?, ?, 1)
        `).run(accountId, cal.url, calName, calColor);
      }
    }
  }

  // Update account
  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name); }
  if (caldavUrl) { updates.push('caldav_url = ?'); values.push(caldavUrl); }
  if (username) { updates.push('username = ?'); values.push(username); }
  if (password) { updates.push('password = ?'); values.push(password); }

  if (updates.length === 0) {
    throw new Error('No fields to update.');
  }

  values.push(accountId);

  db.get().prepare(`
    UPDATE caldav_accounts SET ${updates.join(', ')} WHERE id = ?
  `).run(...values);

  log.info(`Updated CalDAV account ${accountId}.`);

  return { success: true };
}

function deleteAccount(accountId) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  // CASCADE will delete caldav_calendar_selection entries
  db.get().prepare('DELETE FROM caldav_accounts WHERE id = ?').run(accountId);

  // Events with calendar_ref_id to deleted account remain (orphaned but visible)

  log.info(`Deleted CalDAV account ${accountId} ("${account.name}").`);

  return { success: true };
}

// --------------------------------------------------------
// Calendar Selection
// --------------------------------------------------------

async function getCalendars(accountId, { refresh = false } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  if (!refresh) {
    // Return from DB
    const calendars = db.get().prepare(`
      SELECT calendar_url, calendar_name, calendar_color, enabled
      FROM caldav_calendar_selection
      WHERE account_id = ?
      ORDER BY calendar_name
    `).all(accountId);

    return calendars.map(cal => ({
      calendarUrl: cal.calendar_url,
      calendarName: cal.calendar_name,
      calendarColor: cal.calendar_color,
      enabled: cal.enabled === 1,
    }));
  }

  // Refresh from server
  const { calendars } = await testConnection(account.caldav_url, account.username, account.password);

  // Update DB
  db.get().prepare('DELETE FROM caldav_calendar_selection WHERE account_id = ?').run(accountId);

  const result = [];
  for (const cal of calendars) {
    const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
    const calName = cal.displayName || 'Unnamed Calendar';

    db.get().prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, ?, 1)
    `).run(accountId, cal.url, calName, calColor);

    result.push({
      calendarUrl: cal.url,
      calendarName: calName,
      calendarColor: calColor,
      enabled: true,
    });
  }

  log.info(`Refreshed calendars for account ${accountId}.`);

  return result;
}

function updateCalendarSelection(accountId, calendarUrl, enabled) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  const enabledValue = enabled ? 1 : 0;

  const result = db.get().prepare(`
    UPDATE caldav_calendar_selection
    SET enabled = ?
    WHERE account_id = ? AND calendar_url = ?
  `).run(enabledValue, accountId, calendarUrl);

  if (result.changes === 0) {
    throw new Error(`Calendar not found for account ${accountId}.`);
  }

  log.info(`Calendar selection updated: account ${accountId}, calendar ${calendarUrl}, enabled=${enabled}`);

  return { success: true };
}

// --------------------------------------------------------
// Sync
// --------------------------------------------------------

async function sync() {
  const accounts = getAllAccounts();

  if (accounts.length === 0) {
    log.info('No CalDAV accounts configured.');
    return { success: true, syncedAccounts: 0, syncedEvents: 0 };
  }

  let totalSyncedEvents = 0;
  let successfulAccounts = 0;

  for (const account of accounts) {
    try {
      log.info(`Syncing CalDAV account ${account.id} ("${account.name}")...`);

      // Create tsdav client
      const { createDAVClient } = await import('tsdav');
      const client = await createDAVClient({
        serverUrl:          account.caldav_url,
        credentials:        { username: account.username, password: account.password },
        authMethod:         'Basic',
        defaultAccountType: 'caldav',
      });

      // Get enabled calendars for this account
      const enabledCalendars = db.get().prepare(`
        SELECT calendar_url, calendar_name, calendar_color
        FROM caldav_calendar_selection
        WHERE account_id = ? AND enabled = 1
      `).all(account.id);

      if (enabledCalendars.length === 0) {
        log.info(`Account ${account.id}: no enabled calendars, skipping.`);
        continue;
      }

      // Fetch all calendars from server
      const serverCalendars = await client.fetchCalendars();

      // Inbound sync: CalDAV → Oikos
      let accountEventCount = 0;

      for (const selCal of enabledCalendars) {
        // Find matching calendar from server
        const serverCal = serverCalendars.find(sc => sc.url === selCal.calendar_url);

        if (!serverCal) {
          log.warn(`Calendar ${selCal.calendar_url} not found on server, disabling.`);
          db.get().prepare(`
            UPDATE caldav_calendar_selection SET enabled = 0
            WHERE account_id = ? AND calendar_url = ?
          `).run(account.id, selCal.calendar_url);
          continue;
        }

        // Fetch calendar objects
        let calObjects;
        try {
          calObjects = await client.fetchCalendarObjects({ calendar: serverCal });
        } catch (err) {
          log.error(`Failed to fetch calendar objects from ${selCal.calendar_name}:`, err.message);
          continue;
        }

        // Upsert external calendar metadata
        const calRefId = upsertExternalCalendar('caldav', selCal.calendar_url, selCal.calendar_name, selCal.calendar_color);

        // Parse and upsert events
        for (const obj of calObjects) {
          const parsed = parseICS(obj.data || '');

          for (const ev of parsed) {
            try {
              const existing = db.get().prepare(
                `SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'caldav'`
              ).get(ev.uid);

              if (existing) {
                // Update
                db.get().prepare(`
                  UPDATE calendar_events
                  SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
                      all_day = ?, location = ?, recurrence_rule = ?, color = ?, calendar_ref_id = ?
                  WHERE id = ?
                `).run(
                  ev.summary, ev.description, ev.dtstart, ev.dtend,
                  ev.allDay ? 1 : 0, ev.location, ev.rrule, selCal.calendar_color, calRefId, existing.id
                );
              } else {
                // Insert
                const owner = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
                const createdBy = owner ? owner.id : 1;

                db.get().prepare(`
                  INSERT INTO calendar_events
                    (title, description, start_datetime, end_datetime, all_day,
                     location, color, external_calendar_id, external_source, recurrence_rule, calendar_ref_id, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'caldav', ?, ?, ?)
                `).run(
                  ev.summary, ev.description, ev.dtstart, ev.dtend,
                  ev.allDay ? 1 : 0, ev.location, selCal.calendar_color, ev.uid, ev.rrule, calRefId, createdBy
                );
              }

              accountEventCount++;
            } catch (err) {
              log.error(`Failed to upsert event UID ${ev.uid}:`, err.message);
            }
          }
        }
      }

      // Outbound sync: Oikos → CalDAV (events with target_caldav_account_id)
      const localEvents = db.get().prepare(`
        SELECT * FROM calendar_events
        WHERE external_source = 'local' AND target_caldav_account_id = ?
      `).all(account.id);

      for (const event of localEvents) {
        try {
          // Find target calendar
          const targetCal = serverCalendars.find(sc => sc.url === event.target_caldav_calendar_url);

          if (!targetCal) {
            log.warn(`Target calendar ${event.target_caldav_calendar_url} not found, skipping event ${event.id}.`);
            continue;
          }

          const uid     = `oikos-${event.id}@oikos.local`;
          const icsData = buildCalDAVICS(event);

          // Upload to CalDAV
          await client.createCalendarObject({
            calendar: targetCal,
            filename: `${uid}.ics`,
            iCalString: icsData,
          });

          // Update event to mark as synced
          db.get().prepare(`
            UPDATE calendar_events
            SET external_source = 'caldav', external_calendar_id = ?
            WHERE id = ?
          `).run(uid, event.id);

          accountEventCount++;
        } catch (err) {
          log.error(`Failed to upload event ${event.id} to CalDAV:`, err.message);
        }
      }

      // Update last_sync for account
      db.get().prepare(`
        UPDATE caldav_accounts SET last_sync = ? WHERE id = ?
      `).run(new Date().toISOString(), account.id);

      totalSyncedEvents += accountEventCount;
      successfulAccounts++;

      log.info(`Account ${account.id} sync complete: ${accountEventCount} events.`);

    } catch (err) {
      log.error(`Sync failed for account ${account.id}:`, err.message);
      // Continue with next account (don't abort entire sync)
    }
  }

  log.info(`CalDAV sync complete: ${successfulAccounts}/${accounts.length} accounts, ${totalSyncedEvents} events.`);

  return { success: true, syncedAccounts: successfulAccounts, syncedEvents: totalSyncedEvents };
}

function getStatus() {
  const accounts = getAllAccounts();

  const accountStatus = accounts.map(acc => {
    const calendarCount = db.get().prepare(
      'SELECT COUNT(*) as count FROM caldav_calendar_selection WHERE account_id = ? AND enabled = 1'
    ).get(acc.id).count;

    return {
      id: acc.id,
      name: acc.name,
      caldavUrl: acc.caldav_url,
      username: acc.username,
      lastSync: acc.last_sync,
      enabledCalendars: calendarCount,
    };
  });

  const totalCalendars = db.get().prepare(
    'SELECT COUNT(*) as count FROM caldav_calendar_selection WHERE enabled = 1'
  ).get().count;

  return {
    accounts: accountStatus,
    totalAccounts: accounts.length,
    totalEnabledCalendars: totalCalendars,
  };
}

// --------------------------------------------------------
// Exports
// --------------------------------------------------------

export {
  addAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  getCalendars,
  updateCalendarSelection,
  sync,
  getStatus
};
