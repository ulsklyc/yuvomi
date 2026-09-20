/**
 * Modul: Gesundheit (Health)
 * Zweck: Orchestrator - bündelt die Cluster-Router unter server/routes/health/ zu
 *        einem Router und erhält die bisherige öffentliche Export-Fläche
 *        (Default-Export = Router, gemountet unter /api/v1/health).
 * Abhängigkeiten: express
 *
 * Die eigentliche Logik liegt tab-weise in ./health/*.js:
 *   helpers.js      geteilte Helfer (Sichtbarkeit, Validierung/Update, CSV-Bausteine)
 *   vitals.js       Vitalwerte (health_vitals)
 *   medications.js  Medikamente + Einnahmeplan + Dosis-Log (+ take/skip)
 *   labs.js         Laborbefunde + Analyten
 *   activities.js   Aktivitäten
 *   export.js       CSV-Übersichts-Exporte (vitals/activities/labs/meds-logs)
 *   cycle.js        Zyklus (Perioden/Tages-Logs/Einstellungen) + Zyklus-Export
 *   cycle-feed.js   Zyklus: Token-Verwaltung fuer den vorhergesagten ICS-Feed
 *   caregivers.js   Betreuung: wer darf fuer wen eintragen (#584)
 *   visibility-defaults.js  persoenliche Standard-Sichtbarkeit je Bereich (#958)
 *   prevention.js   Vorsorge & Impfungen: Typ-Register + Protokoll + Faelligkeit
 *
 * Scoping/Visibility-Modell (siehe ./health/helpers.js):
 *   - Jede Zeile gehört einem Nutzer (`user_id`, "Eigentümer").
 *   - Lesen: erlaubt für den Eigentümer ODER wenn `visibility = 'family'`.
 *   - Schreiben/Ändern/Löschen: der Eigentümer - oder eine betreuende Person
 *     (health_care_grants, #584), die die betreute Person dann auch vollständig
 *     sieht. Der Zyklus-Tab ist davon bewusst ausgenommen.
 *   - Verschachtelte Entitäten (Schedules/Logs, Lab-Results) erben Scoping/Visibility
 *     von ihrem Eltern-Datensatz (Medikament bzw. Befund).
 */

import express from 'express';

import vitalsRouter from './health/vitals.js';
import medicationsRouter from './health/medications.js';
import labsRouter from './health/labs.js';
import activitiesRouter from './health/activities.js';
import exportRouter from './health/export.js';
import cycleRouter from './health/cycle.js';
import cycleFeedRouter from './health/cycle-feed.js';
import caregiversRouter from './health/caregivers.js';
import visibilityDefaultsRouter from './health/visibility-defaults.js';
import fastingRouter from './health/fasting.js';
import preventionRouter from './health/prevention.js';

const router = express.Router();

// Reihenfolge wie im Ursprungs-Router: alle Pfade sind präfix-disjunkt bzw.
// mehrsegmentig (Express' /:id matcht nur ein Segment), die Reihenfolge ist daher
// unkritisch - defensiv bleibt sie wie zuvor erhalten.
router.use(vitalsRouter);
router.use(medicationsRouter);
router.use(labsRouter);
router.use(activitiesRouter);
router.use(exportRouter);
router.use(cycleRouter);
router.use(cycleFeedRouter);
router.use(caregiversRouter);
router.use(visibilityDefaultsRouter);
router.use(fastingRouter);
router.use(preventionRouter);

export default router;
