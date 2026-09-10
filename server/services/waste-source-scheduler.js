/**
 * Module: Waste collection - URL source scheduler (#1063 Phase 7)
 * Purpose: low-frequency scan that refreshes due URL sources. Follows the
 *          same setTimeout+setInterval+.unref() shape as push-scheduler.js/
 *          medication-scheduler.js/recipe-provider-sync.js - no explicit stop
 *          function, the unref'd timers simply don't hold the process open.
 * Dependencies: server/services/waste-url-source.js, server/db.js
 */
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { listDueUrlSources, WasteConflictError } from './waste-store.js';
import { refreshUrlSource } from './waste-url-source.js';

const log = createLogger('Waste');

const SCAN_INTERVAL_MS = 5 * 60_000;

// A single scan-level lock (not per-source): a household has at most a
// handful of waste sources, so one scan finishing well within the 5-minute
// interval is the expected case: this only guards against a scan that is
// unexpectedly still running (a slow/hanging fetch) when the next tick fires.
//
// It says NOTHING about the other caller. Der Handknopf
// (routes/waste/sources.js#POST /:id/refresh) laeuft an diesem Riegel vorbei,
// weil er ihn nicht kennt - die Sperre GEGEN IHN sitzt je Quelle in
// waste-url-source.js#inFlight und meldet sich unten als WasteConflictError.
let scanRunning = false;

export async function runDueWasteSourceRefreshes() {
  if (scanRunning) {
    log.info('Waste source scan already running - skipped this tick.');
    return;
  }
  scanRunning = true;
  try {
    const due = listDueUrlSources(db.get());
    // Parallel, not sequential (M-2 der Auditrunde): ein Haushalt hat
    // hoechstens eine Handvoll Quellen (invariant #8), und jede ist bereits
    // per eigenem `inFlight`-Claim isoliert (waste-url-source.js) - nichts
    // verlangt hier eine Reihenfolge. Ein `for`-`await` liess eine einzelne
    // langsame/haengende Quelle (bis zu FETCH_TIMEOUT_MS) jede andere faellige
    // Quelle in demselben Tick unnoetig warten lassen, obwohl der eigentliche
    // Riegel - der Scan als Ganzes lief noch - laengst durchlaufen war.
    await Promise.allSettled(due.map(async (source) => {
      try {
        await refreshUrlSource(db.get(), source.id);
      } catch (err) {
        // Diese Quelle aktualisiert gerade jemand von Hand - kein Fehler,
        // sondern genau das, was der Claim leisten soll. Sie ist danach
        // ohnehin frisch, der naechste Tick findet sie nicht mehr faellig.
        if (err instanceof WasteConflictError) {
          log.info(`Waste source ${source.id} is already being refreshed - skipped this tick.`);
          return;
        }
        // Per-source failure isolation (recipe-provider-sync.js's own
        // pattern): one broken source must never block the others in the
        // same scan. Fetch- UND Auswertungsfehler sind zu diesem Zeitpunkt
        // bereits in der Quelle vermerkt (last_error/backoff, siehe
        // waste-url-source.js); hier bleibt nur noch das Protokoll.
        log.error(`Waste source ${source.id} refresh failed:`, err?.message || err);
      }
    }));
  } finally {
    scanRunning = false;
  }
}

export function startWasteSourceScheduler() {
  const run = () => {
    runDueWasteSourceRefreshes().catch((err) => log.error('Waste source scheduler run failed:', err?.message || err));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, SCAN_INTERVAL_MS).unref();
  log.info('Waste source scheduler active (every 5 min).');
}
