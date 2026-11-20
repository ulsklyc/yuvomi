/**
 * Module: Waste collection routes - per-user pickup reminder settings (#1063 Phase 8)
 * Purpose: read/write the CALLING USER's own reminder preferences, one row
 *          per waste type. Personal, not household-wide - the same
 *          "no admin gate, everyone edits only their own" shape as
 *          server/routes/schedule-preferences.js. A catch answers only the
 *          typed waste errors; anything else reaches the central error
 *          handler (#2810).
 */

import express from 'express';
import { validateRequest } from '../../api/validate-request.ts';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { syncWasteRemindersForUser } from '../../services/waste-reminders.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId } from './helpers.js';

const router = express.Router();

const DEFAULT_OFFSET_DAYS = 1;
const DEFAULT_DELIVERY_TIME = '08:00';

router.get('/', validateRequest(), (req, res) => {
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
});

router.put('/:typeId', validateRequest(), (req, res) => {
  const vTypeId = validateId(req.params.typeId, 'typeId');
  if (vTypeId.error) return res.status(400).json({ error: vTypeId.error, code: 400 });
  const userId = currentUserId(req);
  // The schema of WasteReminderSettingUpdateInput (server/openapi/waste-inputs.js)
  // requires all three and refuses before this handler runs (#2810): `enabled`
  // a boolean, `offset_days` an integer within MIN_OFFSET_DAYS..MAX_OFFSET_DAYS
  // (server/services/waste-fields.js), `delivery_time` HH:MM by TIME_PATTERN,
  // so an empty time never reaches the NOT NULL column.
  const { enabled, offset_days: offsetDays, delivery_time: deliveryTime } = req.body;

  try {
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
        enabled, offsetDays, deliveryTime,
      });
      syncWasteRemindersForUser(db.get(), userId);
      return saved;
    })();

    res.json({ data: { type_id: row.type_id, enabled: !!row.enabled, offset_days: row.offset_days, delivery_time: row.delivery_time } });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    throw err;
  }
});

export default router;
