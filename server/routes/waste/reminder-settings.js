/**
 * Module: Waste collection routes - per-user pickup reminder settings (#1063 Phase 8)
 * Purpose: read/write the CALLING USER's own reminder preferences, one row
 *          per waste type. Personal, not household-wide - the same
 *          "no admin gate, everyone edits only their own" shape as
 *          server/routes/schedule-preferences.js.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { syncWasteRemindersForUser, MIN_OFFSET_DAYS, MAX_OFFSET_DAYS } from '../../services/waste-reminders.js';
import { id as validateId, num, time } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';
import { WasteValidationError } from '../../services/waste-store.js';

const log = createLogger('Waste');
const router = express.Router();

const DEFAULT_OFFSET_DAYS = 1;
const DEFAULT_DELIVERY_TIME = '08:00';

router.get('/', (req, res) => {
  try {
    const userId = currentUserId(req);
    const { types, byTypeId } = store.listReminderSettingsForUser(db.get(), userId);
    const data = types.map((type) => {
      const setting = byTypeId.get(type.id);
      return {
        type_id: type.id,
        type_name: type.name,
        enabled: !!setting?.enabled,
        offset_days: setting?.offset_days ?? DEFAULT_OFFSET_DAYS,
        delivery_time: setting?.delivery_time ?? DEFAULT_DELIVERY_TIME,
      };
    });
    res.json({ data });
  } catch (err) {
    log.error('GET /waste/reminder-settings error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:typeId', (req, res) => {
  try {
    const vTypeId = validateId(req.params.typeId, 'typeId');
    if (vTypeId.error) return res.status(400).json({ error: vTypeId.error, code: 400 });
    const userId = currentUserId(req);
    const body = req.body ?? {};

    const enabled = !!body.enabled;
    const vOffset = num(body.offset_days, 'offset_days', { required: false });
    if (vOffset.error) throw new WasteValidationError([vOffset.error]);
    const offsetDays = vOffset.value ?? DEFAULT_OFFSET_DAYS;
    if (!Number.isInteger(offsetDays) || offsetDays < MIN_OFFSET_DAYS || offsetDays > MAX_OFFSET_DAYS) {
      throw new WasteValidationError([`offset_days must be an integer between ${MIN_OFFSET_DAYS} and ${MAX_OFFSET_DAYS}.`]);
    }
    const vTime = time(body.delivery_time ?? DEFAULT_DELIVERY_TIME, 'delivery_time');
    if (vTime.error) throw new WasteValidationError([vTime.error]);

    // One transaction for the setting write AND the immediate resync
    // (Phase 8's own "must update pending reminders idempotently"
    // requirement, not just the next periodic tick): syncWasteRemindersForUser
    // deletes stale anchors/reminders before creating fresh ones, and without
    // an enclosing transaction a mid-run failure there left the setting saved
    // but the user's reminders in a half-updated state until the next tick
    // papered over it. db.transaction() nests via SAVEPOINT, so this composes
    // safely with syncWasteRemindersForUser's own inner transaction.
    const row = db.get().transaction(() => {
      const saved = store.upsertReminderSetting(db.get(), userId, vTypeId.value, {
        enabled, offsetDays, deliveryTime: vTime.value,
      });
      syncWasteRemindersForUser(db.get(), userId);
      return saved;
    })();

    res.json({ data: { type_id: row.type_id, enabled: !!row.enabled, offset_days: row.offset_days, delivery_time: row.delivery_time } });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/reminder-settings/:typeId error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
