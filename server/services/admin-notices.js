/**
 * Module: Admin Notices
 * Purpose: Push notifications to household admins about operational events
 *          they need to act on (a failed backup, and more to come - a failed
 *          WebDAV upload is the next one).
 * Dependencies: server/services/push.js, server/services/household-members.js
 */

import { pushService as defaultPushService } from './push.js';
import { householdMemberSql } from './household-members.js';

/**
 * @typedef {Object} PushService
 * @property {(userId: number, payload: Object) => Promise<number>} sendPushToUser
 */

/**
 * Sends a push notification to every admin who is a household member
 * (#1207): an admin account that is a wall tablet, a guest, a housekeeping
 * worker, or deactivated gets none of these - they are operational notices
 * for the people who run the installation, not household announcements.
 *
 * Best effort: a rejected send is counted as zero and never thrown, so one
 * admin's broken subscription cannot stop the others from being told.
 *
 * @param {Object} opts
 * @param {Object} opts.database
 * @param {{ title: string, body: string, url?: string, tag?: string, priority?: string }} opts.payload
 * @param {PushService} [opts.pushService] - { sendPushToUser }
 * @returns {Promise<number>} how many admins actually received the push
 *   (sendPushToUser returns 0 without a subscription, not just the count of
 *   settled promises)
 */
export async function notifyAdmins({ database, payload, pushService = defaultPushService }) {
  const db = /** @type {{ prepare: (sql: string) => { all: () => { id: number }[] } }} */ (database);
  const admins = db.prepare(`
    SELECT u.id FROM users u
    WHERE u.role = 'admin' AND ${householdMemberSql('u')}
    ORDER BY u.id ASC
  `).all();
  if (!admins.length) return 0;

  const results = await Promise.allSettled(
    admins.map((u) => pushService.sendPushToUser(u.id, payload)),
  );
  return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
}
