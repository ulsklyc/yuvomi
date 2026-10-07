/**
 * Modul: Taschengeld-Lauf (#1734)
 * Zweck: Bucht die faelligen Gutschriften nach Plan - kurz nach dem Start und
 *        danach stuendlich.
 * Abhängigkeiten: server/db.js, services/reward-money.js.
 *
 * KURZ NACH DEM START, NICHT ERST NACH EINER STUNDE: der Fall, fuer den der
 * Lauf nachbucht, ist der Server, der aus war. Wer ihn morgens einschaltet,
 * soll die Gutschrift nicht erst eine Stunde spaeter sehen.
 */

import { isRestoreRunning } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { creditDueAllowances } from './reward-money.js';

const log = createLogger('RewardMoneyScheduler');

function tick() {
  // Rein lokal und ohne await, aber waehrend eines Restores gesperrt: den Lauf
  // auslassen statt am Riegel zu scheitern, der naechste holt nach.
  if (isRestoreRunning()) return;
  try {
    const result = creditDueAllowances(db.get(), {
      onError: (plan, err) => log.error(`Allowance plan ${plan.id} failed:`, err),
    });
    if (result.credited || result.paused || result.failed) {
      log.info(`Pocket money: ${result.credited} credited, ${result.paused} paused, ${result.failed} failed.`);
    }
  } catch (err) {
    log.error('Pocket money credit run failed:', err);
  }
}

export function startRewardMoneyScheduler() {
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
