/**
 * Module: Waste collection routes - mount router
 * Purpose: combine the per-resource routers under /api/v1/waste. Auth,
 *          module/permission gating, CSRF, and idempotency are all applied
 *          once, globally, at the /api/v1 mount point in server/index.js -
 *          nothing here duplicates that.
 */

import express from 'express';
import typesRouter from './types.js';
import schedulesRouter from './schedules.js';
import pickupsRouter from './pickups.js';
import occurrencesRouter from './occurrences.js';
import sourcesRouter from './sources.js';
import importRouter from './import.js';
import reminderSettingsRouter from './reminder-settings.js';
import feedRouter from './feed.js';

const router = express.Router();

router.use('/types', typesRouter);
router.use('/schedules', schedulesRouter);
router.use('/pickups', pickupsRouter);
router.use('/occurrences', occurrencesRouter);
router.use('/sources', sourcesRouter);
router.use('/import', importRouter);
router.use('/reminder-settings', reminderSettingsRouter);
router.use('/feed', feedRouter);

export default router;
