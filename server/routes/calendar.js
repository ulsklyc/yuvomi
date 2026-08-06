/**
 * Modul: Kalender (Calendar) - Orchestrator
 * Zweck: Mountet die Kalender-Sub-Router (Lese/Google/Apple/Abos/Feed/CRUD/CalDAV)
 *        unter dem gemeinsamen Basispfad. Aufgeteilt aus dem vormaligen God-File
 *        server/routes/calendar.js; Route-Pfade und Reihenfolge bleiben identisch.
 *
 * Reihenfolge-Vertrag: Alle spezifischen Pfade (/google, /apple, /subscriptions,
 * /feed, /holidays, /upcoming, /search, /sync-targets) MÜSSEN vor dem CRUD-Router
 * (mit /:id) gemountet werden, sonst würde /:id sie verschlucken. CalDAV nutzt
 * ausschließlich Mehr-Segment-Pfade und kollidiert daher nicht mit /:id.
 *
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import express from 'express';

import readRouter from './calendar/read.js';
import googleRouter from './calendar/google.js';
import appleRouter from './calendar/apple.js';
import subscriptionsRouter from './calendar/subscriptions.js';
import feedRouter from './calendar/feed.js';
import crudRouter from './calendar/crud.js';
import caldavRouter from './calendar/caldav.js';
import outlookRouter from './calendar/outlook.js';
import syncTargetsRouter from './calendar/sync-targets.js';
import { googleTarget } from './calendar/helpers.js';

const router = express.Router();

router.use(readRouter);
router.use(googleRouter);
router.use(appleRouter);
router.use(subscriptionsRouter);
router.use(feedRouter);
router.use(syncTargetsRouter);
router.use(crudRouter);
router.use(caldavRouter);
// Outlook nutzt wie CalDAV ausschließlich Mehr-Segment-Pfade (/outlook/...)
// und kollidiert daher nicht mit /:id.
router.use(outlookRouter);

export default router;

// Nur für Tests re-exportiert (test/test-google-multi.js) - Fläche unverändert.
export const __test = { googleTarget };
