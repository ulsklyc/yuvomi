/**
 * Modul: Budget-Tracker (Budget)
 * Zweck: Orchestrator - bündelt die Cluster-Router unter server/routes/budget/ zu
 *        einem Router und erhält die bisherige öffentliche Export-Fläche.
 * Abhängigkeiten: express, server/db.js, server/auth.js
 *
 * Die eigentliche Logik liegt domänenweise in ./budget/*.js:
 *   helpers.js    geteilte Helfer (Sichtbarkeit, Formatierung, Locale, Loans, Konten, Stats-Range)
 *   entries.js    Übersicht, Eintragsliste, CSV-Export, Eintrags-CRUD + Serien
 *   categories.js Kategorien/Subkategorien CRUD + Reihenfolge, Meta
 *   loans.js      Kredite/Darlehen + Raten
 *   accounts.js   Konten (#495)
 *   plans.js      Budgetplan (#468)
 *   stats.js      Statistik-Tab
 */

import express from 'express';

import entriesRouter from './budget/entries.js';
import categoriesRouter from './budget/categories.js';
import loansRouter from './budget/loans.js';
import accountsRouter from './budget/accounts.js';
import plansRouter from './budget/plans.js';
import statsRouter from './budget/stats.js';

const router = express.Router();

// Reihenfolge: spezifische Präfix-Router zuerst, die Eintrags-Routen mit dem
// dynamischen /:id-Muster zuletzt. Alle Pfade sind ohnehin präfix-disjunkt bzw.
// mehrsegmentig (Express' /:id matcht nur ein Segment), die Reihenfolge ist daher
// unkritisch - defensiv bleibt sie wie im Ursprungs-Router erhalten.
router.use(categoriesRouter);
router.use(loansRouter);
router.use(accountsRouter);
router.use(plansRouter);
router.use(statsRouter);
router.use(entriesRouter);

export default router;

// Öffentliche Export-Fläche unverändert (von Tests + index.js konsumiert).
export {
  computeStatsRange,
  generateRecurringInstances, monthsPerInterval, effectiveMonthly, RECURRENCE_INTERVAL_KEYS,
  categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
} from './budget/helpers.js';
export { resolveExportRange } from './budget/entries.js';
export { BUDGET_SAVINGS_KEY, computePlanProgress } from './budget/plans.js';
export { computeStats, statsHandler } from './budget/stats.js';
