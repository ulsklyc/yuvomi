/**
 * Modul: Push (Web Push)
 * Zweck: REST-API für VAPID-Public-Key, Subscribe/Unsubscribe und Test-Push.
 *        Jede Route prueft die Anfrage vor dem Handler gegen ihre Operation im
 *        OpenAPI-Dokument (`validateRequest()`, #2810 Gruppe 11b): Form und
 *        Typ der Felder prueft allein das Dokument (Schritt b). Ob ein
 *        Endpoint eine oeffentliche https-Adresse ist, prueft weiter der
 *        Handler (checkPushEndpoint: Hostliste und Netz, kein Muster), ebenso
 *        einen leeren Endpoint. Ein unerwarteter Fehler geht an den zentralen
 *        Fehlerhandler (server/middleware/error-handler.js).
 * Abhängigkeiten: express, server/db.js, server/services/push.js
 */
import express from 'express';
import * as db from '../db.js';
import { checkPushEndpoint, pushService as defaultPushService } from '../services/push.js';
import { validateRequest } from '../api/validate-request.ts';

/**
 * The push router; tests hand in their own push service and database.
 * @param {{ pushService?: Pick<typeof defaultPushService, 'getPublicKey' | 'sendPushToUser'>, database?: any }} [options]
 */
export function buildRouter({ pushService = defaultPushService, database } = {}) {
  const getDb = () => (database || db.get());
  const router = express.Router();

  router.get('/vapid-public-key', validateRequest(), (req, res) => {
    res.json({ data: { key: pushService.getPublicKey() } });
  });

  router.post('/subscribe', validateRequest(), (req, res) => {
    const userId = req.authUserId || req.session.userId;
    // `keys` mit `p256dh` und `auth` (Text, nicht leer) und `endpoint` als
    // Text bis 2048 Zeichen prueft das Dokument (PushSubscribeInput). Ein
    // leerer Endpoint kommt dort durch und behaelt hier seinen Satz.
    const { endpoint, keys } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required.', code: 400 });
    }
    // Ein Endpoint ist ein Ziel, an das der Server spaeter selbst sendet:
    // nur oeffentliche https-Adressen, wie sie jeder Push-Dienst vergibt.
    // Der Versand prueft erneut (Bestandszeilen, DNS beim Verbindungsaufbau).
    // checkPushEndpoint prueft Typ und Laenge selbst, bevor es `new URL()`
    // ruft: diese Senke haengt nicht am Dokument.
    if (!checkPushEndpoint(endpoint).ok) {
      return res.status(400).json({ error: 'endpoint must be a public https address.', code: 400 });
    }
    const ua = req.get('user-agent') || null;
    getDb().prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id       = excluded.user_id,
        p256dh        = excluded.p256dh,
        auth          = excluded.auth,
        user_agent    = excluded.user_agent,
        wall_paused_at = CASE WHEN excluded.user_id != user_id THEN NULL ELSE wall_paused_at END
    `).run(userId, endpoint, keys.p256dh, keys.auth, ua);
    const row = getDb().prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    res.status(201).json({ data: { id: row.id } });
  });

  router.post('/unsubscribe', validateRequest(), (req, res) => {
    const userId = req.authUserId || req.session.userId;
    // `endpoint` als Text prueft das Dokument; leer ist er dort erlaubt und
    // antwortet hier mit seinem eigenen Satz.
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required.', code: 400 });
    }
    getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
    res.status(204).end();
  });

  router.put('/wall-mode', validateRequest(), (req, res) => {
    const userId = req.authUserId || req.session.userId;
    // `endpoint` als Text und `active` als Wahrheitswert prueft das Dokument
    // (PushWallModeInput, beide Pflicht).
    const { endpoint, active } = req.body || {};
    // active=true: Pause setzen (jetzt); active=false: Pause loeschen.
    // Der Zeitstempel laeuft nach WALL_PAUSE_MAX_AGE_HOURS ab - eine Erneuerung
    // beim Laden und beim Aufwachen stellt sicher, dass eine lang laufende Wand
    // weiter stumm bleibt (#1904). Der SQL-Text waehlt nur zwischen zwei festen
    // Ausdruecken; `active` selbst steht nie darin.
    getDb().prepare(
      `UPDATE push_subscriptions SET wall_paused_at = ${active ? "datetime('now')" : 'NULL'} WHERE endpoint = ? AND user_id = ?`,
    ).run(endpoint, userId);
    res.status(204).end();
  });

  // Async: Express 5 reicht ein abgelehntes Promise (etwa ein Fehler des
  // Push-Dienstes) an den zentralen Fehlerhandler.
  router.post('/test', validateRequest(), async (req, res) => {
    const userId = req.authUserId || req.session.userId;
    // Die drei Felder sind optional und, wenn da, Text (PushTestInput).
    const title = req.body?.title ?? 'Yuvomi';
    const body  = req.body?.body ?? '';
    const testEndpoint = req.body?.endpoint ?? null;
    // Vor dem Senden zählen: Wird das Abo beim Senden als "gone" entfernt,
    // bleibt devices > 0 bei sent === 0 und der Client kann "abgelaufen"
    // von "nie registriert" unterscheiden.
    const devices = getDb()
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
      .get(userId)?.n ?? 0;
    // Wand-Pause nur am anfragenden Geraet aufheben. Ohne Endpoint bleibt
    // die Pause bestehen - kein Fallback-Loeschen aller Geraete (#1904).
    if (testEndpoint) {
      getDb().prepare("UPDATE push_subscriptions SET wall_paused_at = NULL WHERE user_id = ? AND endpoint = ?").run(userId, testEndpoint);
    }
    const sent = await pushService.sendPushToUser(userId, { title, body, url: '/reminders', tag: 'push-test' });
    res.json({ data: { sent, devices } });
  });

  return router;
}

export default buildRouter();
