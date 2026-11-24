/**
 * Module: the public read-only ICS feeds (Discussion #387)
 * Purpose: the six subscription addresses `/feed/<kind>/<token>.ics` that a
 *          calendar app polls. Mounted by server/index.js at `/feed`, outside
 *          `/api/v1`: no session, no CSRF, the token in the URL is the secret.
 *          Until group 13 of #2810 these were inline routes in server/index.js;
 *          here they carry `validateRequest()` like every other route file.
 *
 *          Order per route: `feedLimiter` (30 requests per minute and address,
 *          ONE instance, so the six feeds share one count as before), then
 *          `validateRequest()`, then the handler. The schema of `token` is
 *          only `type: string` (decision 2): the length and the lookup stay in
 *          the sink (`findUserIdByFeedToken`), an unknown token stays a 404.
 *
 *          A feed has no catch of its own: an unexpected error goes to the
 *          central error handler, which answers the JSON 500 and logs the
 *          route PATTERN, never the path with the token.
 * Dependencies: express, express-rate-limit, server/db.js, the feed services
 */

// @ts-expect-error express 5 ships no type declarations (TS7016); new code type-checks clean
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import { validateRequest } from '../api/validate-request.ts';
import { actorForUser, mayReceiveFeed } from '../authorize/index.ts';
import { FEED_MODULE } from '../services/reminder-origins.js';
import * as icsExport from '../services/ics-export.js';
import { findCalendarByFeedToken } from '../services/local-calendars.js';
import * as birthdayIcs from '../services/birthday-ics.js';
import * as inventoryDeadlinesIcs from '../services/inventory-deadlines-ics.js';
import * as cycleIcs from '../services/cycle-ics.js';
import * as scheduleIcs from '../services/schedule-ics.js';
import * as wasteIcs from '../services/waste-ics.js';

const router = express.Router();

/** One limiter for all six feeds: they share the count per address. */
const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// A member's feed follows the member's module permission (#2615). The feeds sit
// outside `/api/v1`, so the module gate there never reached them, and revoking
// a permission leaves the feed tokens in place. On `none` - and for an owner
// that no longer resolves - the feed answers 200 with an EMPTY calendar under
// the same headers instead of 404: the subscription stays in the calendar app
// and fills again once the permission is given back (skip, do not delete, as
// the delivery of reminders since #1289). `read` keeps delivering, an admin is
// never affected. The household module switch stays deliberately open for
// feeds (docs/DECISIONS.md). A feed is a delivery, not a request: `receive`,
// without token scopes, and no feed for a display or a split guest
// (mayReceiveFeed in server/authorize/).
/**
 * @param {number} userId
 * @param {string} feed a key of FEED_MODULE
 * @returns {boolean}
 */
function feedModuleDenied(userId, feed) {
  return !mayReceiveFeed(actorForUser(db.get(), userId), /** @type {any} */ (FEED_MODULE)[feed]);
}

router.get('/calendar/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  const userId = icsExport.findUserIdByFeedToken(db.get(), 'calendar_feed_token', req.params.token);
  const localCalendar = userId ? null : findCalendarByFeedToken(db.get(), req.params.token);
  if (!userId && !localCalendar) return res.status(404).type('text/plain').send('Not found');
  // A local calendar's token belongs to the calendar, not to a member: no gate.
  const ics = !userId
    ? icsExport.buildCalendarFeed(db.get(), localCalendar.id)
    : feedModuleDenied(userId, 'calendar')
      ? icsExport.buildEmptyFeed(db.get())
      : icsExport.buildFeed(db.get(), userId);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `inline; filename="${localCalendar ? `yuvomi-${localCalendar.id}.ics` : 'yuvomi.ics'}"`);
  res.type('text/calendar; charset=utf-8').send(ics);
});

router.get('/birthdays/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  const userId = birthdayIcs.findUserIdByFeedToken(db.get(), req.params.token);
  if (!userId) return res.status(404).type('text/plain').send('Not found');
  const ics = feedModuleDenied(userId, 'birthdays')
    ? birthdayIcs.buildEmptyBirthdayFeed(db.get())
    : birthdayIcs.buildBirthdayFeed(db.get());
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline; filename="yuvomi-birthdays.ics"');
  res.type('text/calendar; charset=utf-8').send(ics);
});

// Eigenständiger Feed für Inventar-Garantiefristen (Stufe 4) - getrennt vom
// Haushaltskalender-Feed oben, siehe server/services/inventory-deadlines-ics.js.
router.get('/inventory-deadlines/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  // Auflösen statt nur prüfen, wie beim Kalender-Feed oben: das Token gehört
  // einem Nutzer, damit es einzeln zurückziehbar ist. In den Feed-Inhalt geht
  // die Id nicht ein - Inventar ist Haushaltseigentum ohne Sichtbarkeitsachse.
  // The id decides only whether the owner still has the module (#2615).
  const userId = inventoryDeadlinesIcs.findUserIdByFeedToken(db.get(), req.params.token);
  if (!userId) return res.status(404).type('text/plain').send('Not found');
  const ics = feedModuleDenied(userId, 'inventory-deadlines')
    ? inventoryDeadlinesIcs.buildEmptyInventoryDeadlinesFeed(db.get())
    : inventoryDeadlinesIcs.buildInventoryDeadlinesFeed(db.get());
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline; filename="yuvomi-inventory-deadlines.ics"');
  res.type('text/calendar; charset=utf-8').send(ics);
});

// Vorhergesagter Zyklus-Feed (Phase 5, Health) - anders als der Inventar-Feed
// oben ist der INHALT hier schon personengebunden (cycle_periods.user_id),
// nicht nur das Token; siehe server/services/cycle-ics.js.
//
// THE VIEW LOCK DOES NOT GATE THIS FEED, THE REVOKED MODULE DOES (#2615).
// server/services/cycle-reminders.js stops the reminder sync once the cycle
// tab is locked (household or personal, healthCycleViews()); this feed keeps
// delivering then - the content is the token owner's own, and an existing
// subscription on another device should not run empty just because the view
// is locked in the app; switching it off stays "disable feed" in the settings.
// `health: none` is a different thing: an administrative decision about the
// member, and it empties the feed like every other one (feedModuleDenied()).
router.get('/cycle/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  const userId = cycleIcs.findUserIdByFeedToken(db.get(), req.params.token);
  if (!userId) return res.status(404).type('text/plain').send('Not found');
  const ics = feedModuleDenied(userId, 'cycle')
    ? cycleIcs.buildEmptyCycleFeed(db.get())
    : cycleIcs.buildCycleFeed(db.get(), userId);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline; filename="yuvomi-cycle.ics"');
  res.type('text/calendar; charset=utf-8').send(ics);
});

// Eigenständiger Feed für den persönlichen Schichtplan (Schedule v3) - anders
// als beim Inventar-Feed steckt hier die Nutzer-Id auch im Inhalt: gefeedet
// werden NUR die eigenen aufgelösten Einträge dieses Tokens, siehe
// server/services/schedule-ics.js.
router.get('/schedule/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  const userId = scheduleIcs.findUserIdByFeedToken(db.get(), req.params.token);
  if (!userId) return res.status(404).type('text/plain').send('Not found');
  const ics = feedModuleDenied(userId, 'schedule')
    ? scheduleIcs.buildEmptyScheduleFeed(db.get())
    : scheduleIcs.buildScheduleFeed(db.get(), userId);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline; filename="yuvomi-schedule.ics"');
  res.type('text/calendar; charset=utf-8').send(ics);
});

// Eigenständiger Feed für Abfuhrtermine (Waste, Stufe 10) - anders als beim
// Schichtplan-Feed oben steckt hier keine Nutzer-Id im INHALT (Abfuhrtermine
// sind Haushaltseigentum ohne Sichtbarkeitsachse, wie beim Inventar-Feed);
// nur das optionale Typ-Filter je Nutzer, siehe server/services/waste-ics.js.
router.get('/waste/:token.ics', feedLimiter, validateRequest(), (/** @type {any} */ req, /** @type {any} */ res) => {
  const userId = wasteIcs.findUserIdByFeedToken(db.get(), req.params.token);
  if (!userId) return res.status(404).type('text/plain').send('Not found');
  const ics = feedModuleDenied(userId, 'waste')
    ? wasteIcs.buildEmptyWasteFeed(db.get())
    : wasteIcs.buildWasteFeed(db.get(), userId);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline; filename="yuvomi-waste.ics"');
  res.type('text/calendar; charset=utf-8').send(ics);
});

export default router;
