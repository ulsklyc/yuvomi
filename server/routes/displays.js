/**
 * Modul: Display-Konten (Routen, #1208)
 * Zweck: Ein Administrator legt ein Wandtablett an, stellt ihm einen
 *        Kopplungscode aus und widerruft sein Geraet. Das Tablett selbst hat
 *        genau eine Route: den Tausch des Codes gegen sein Credential.
 * Abhaengigkeiten: express, server/db.js (synchron), services/display-accounts.js
 *
 * ZWEI ROUTER IN EINER DATEI, WEIL SIE VERSCHIEDEN TIEF HAENGEN. Alles, was ein
 * Mensch tut, haengt hinter `requireAuth` und `requireAdmin`. Der Tausch haengt
 * DAVOR, denn ein frisch aufgehaengtes Tablett hat noch nichts, womit es sich
 * ausweisen koennte - genau wie `/auth/login`. Die beiden in einer Datei zu
 * halten und in server/index.js an zwei Stellen zu montieren macht diesen
 * Unterschied sichtbar, statt ihn in zwei Dateien zu verstecken.
 */

import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { CURRENT_ONBOARDING_VERSION, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from '../auth.js';
import {
  DISPLAY_COOKIE,
  DISPLAY_PASSWORD_SENTINEL,
  displayCookieOptions,
  issuePairingCode,
  listDisplayDevices,
  redeemPairingCode,
  revokeDisplayDevice,
} from '../services/display-accounts.js';

const log = createLogger('Displays');

/**
 * Der Limiter des Tauschs. Der Kopplungscode ist kurz genug, um ihn abzutippen,
 * also kurz genug, um ihn zu raten - 10 Stellen aus 25 Zeichen sind rund 46 Bit,
 * aber nur zusammen mit einer Grenze fuer Versuche. Ohne sie waere die kurze
 * Gueltigkeit das einzige Hindernis, und 15 Minuten sind viele Versuche.
 *
 * `skipSuccessfulRequests` steht hier NICHT: anders als beim Login zaehlt jeder
 * Versuch. Ein geglueckter Tausch verbraucht den Code ohnehin, es gibt also
 * nichts, was ein Erfolg noch freischalten muesste.
 */
const pairingLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS, 10) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many pairing attempts. Please wait a moment.', code: 429 },
});

// --------------------------------------------------------
// Der oeffentliche Router: genau eine Route, vor requireAuth montiert.
// --------------------------------------------------------
export const pairingRouter = express.Router();

/**
 * POST /api/v1/displays/pair
 * Body: { code, label? }  ->  setzt das Credential als httpOnly-Cookie.
 *
 * DAS CREDENTIAL GEHT NUR ALS COOKIE RAUS, NIE IN DEN RUMPF. Ein Wert, den der
 * Server selbst setzt und der Browser selbst mitschickt, kommt an kein Skript
 * auf der Seite - und damit auch an keines, das eine Erweiterung oder ein
 * fremdes Snippet dort einschleust. Es gibt keinen zweiten Empfaenger, der ihn
 * lesen muesste: die App auf dem Tablett benutzt ihn, sie verwahrt ihn nicht.
 *
 * EINE ABSAGE FUER DREI FAELLE. Unbekannt, abgelaufen, schon benutzt - alle
 * antworten gleich. Wer raet, soll nicht erfahren, ob er nah dran war.
 */
pairingRouter.post('/pair', pairingLimiter, (req, res) => {
  // DIE SITZUNG STIRBT ZUERST, VOR DEM EINLOESEN - UND DAS IST DIE TEURE
  // REIHENFOLGE, ABER DIE RICHTIGE.
  //
  // Warum sie ueberhaupt sterben muss: gekoppelt wird fast immer aus einem
  // angemeldeten Browser heraus - jemand haengt das Tablett auf, meldet sich
  // an, holt sich den Code aus den Einstellungen. Bliebe `yuvomi.sid` daneben
  // liegen, waere es ein schlafender Zweitschluessel: `requireAuth` bevorzugt
  // zwar das Display, aber sobald das Credential faellt (Widerruf, Loeschen),
  // raeumt derselbe Zweig das tote Cookie weg, und der naechste Request findet
  // die alte Sitzung mit den VOLLEN Rechten dieser Person. Ein Widerruf, der
  // das Tablett offener zuruecklaesst als vorher, ist das Gegenteil dessen,
  // was der Knopf verspricht.
  //
  // Warum VOR dem Einloesen: `redeemPairingCode()` ist unumkehrbar. Es
  // verbrennt den Code, legt das Geraet an und widerruft das bisherige Geraet
  // desselben Displays. Scheiterte danach das Zerstoeren, stuende die Route vor
  // der Wahl, entweder den Zweitschluessel liegen zu lassen oder mit 500 zu
  // antworten - und im zweiten Fall waere der Code verbraucht, das Tablett ohne
  // Cookie und ein vorher gekoppeltes Geraet bereits widerrufen. Ein Fehlschlag
  // wuerde die Kopplung also nicht nur verhindern, sondern den Zustand
  // ZERSTOEREN. Zuerst zerstoeren kostet dagegen nichts, was nicht ohnehin weg
  // soll.
  //
  // DER PREIS, offen benannt: auch ein FALSCH eingetippter Code meldet die
  // Sitzung ab. Auf dem Tablett ist das kein Verlust - wer dort koppelt, will
  // die Sitzung ohnehin loswerden, und die Seite fuehrt danach zur Anmeldung
  // zurueck. Fremdauslösung scheidet aus: das Sitzungscookie ist `sameSite:
  // lax`, ein Formular von aussen schickt es gar nicht erst mit.
  const redeem = () => {
    try {
      const paired = redeemPairingCode(req.body?.code, {
        label: typeof req.body?.label === 'string' ? req.body.label.slice(0, 120).trim() || null : null,
      });
      if (!paired) {
        return res.status(400).json({ error: 'This pairing code is not valid.', code: 400 });
      }
      // Die Laufzeit steht in `displayCookieOptions()` - dieselbe Quelle, aus
      // der `requireAuth` nachdatiert.
      res.cookie(DISPLAY_COOKIE, paired.token, displayCookieOptions());
      return res.status(201).json({ data: { paired: true } });
    } catch (err) {
      log.error('POST /pair error:', err);
      return res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  };

  if (typeof req.session?.destroy !== 'function') return redeem();
  return req.session.destroy((err) => {
    // Ein Store, der nicht loeschen kann, darf hier NICHT durchwinken: der
    // Zweitschluessel bliebe genau dann liegen, wenn niemand hinsieht. Jetzt
    // kostet die Absage nichts - der Code ist noch unbenutzt und gilt weiter.
    if (err) {
      log.error('POST /pair session destroy failed:', err);
      return res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
    res.clearCookie(SESSION_COOKIE);
    res.clearCookie(LEGACY_SESSION_COOKIE);
    return redeem();
  });
});

// --------------------------------------------------------
// Der Administrator-Router: hinter requireAuth montiert.
// --------------------------------------------------------
const router = express.Router();

/** Jede Route hier ist Administratorensache - ein Display anzulegen heisst,
 *  einem Geraet dauerhaft Zugang zum Haushalt zu geben. */
router.use(requireAdmin);

/**
 * Die Liste der Displays, je mit ihren Geraeten.
 *
 * DIESE LISTE GEHT BEWUSST NICHT DURCH DAS MITGLIEDER-PRAEDIKAT - sie ist sein
 * Gegenstueck: sie zeigt genau die Konten, die das Praedikat ausschliesst. Der
 * Guard `test:household-member-guard` fuehrt sie deshalb in seiner
 * Ausnahmekarte, mit genau dieser Begruendung.
 *
 * UND DESHALB STEHT `users` HIER IN DER FROM-ZEILE, nicht im JOIN. Beide
 * Schreibweisen liefern dasselbe, aber der Guard liest kein SQL, er sucht
 * `FROM users` - eine Liste, die ueber einen JOIN an ihre Personen kommt, sieht
 * er gar nicht erst (so steht es in seinen Grenzen). Sie waere damit still
 * erlaubt gewesen, ohne Eintrag und ohne Begruendung. Eine Ausnahme, die
 * niemand sieht, ist keine Ausnahme, sondern ein Loch.
 */
router.get('/', (_req, res) => {
  try {
    const rows = db.get().prepare(`
      SELECT u.id, u.display_name, u.avatar_color, da.created_at
        FROM users u
        JOIN display_accounts da ON da.user_id = u.id
       ORDER BY u.display_name
    `).all();
    const data = rows.map((row) => ({
      ...row,
      devices: listDisplayDevices(row.id),
    }));
    return res.json({ data });
  } catch (err) {
    log.error('GET / error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Ein Display anlegen. Body: { display_name }
 *
 * DAS KONTO ENTSTEHT HIER UND NIRGENDWO SONST. Es waere verlockend gewesen, ein
 * bestehendes Konto zu einem Display zu ERKLAEREN, und genau das darf nicht
 * gehen: aus einem Menschen wuerde ein Geraet, seine Aufgaben und Punkte
 * verschwaenden aus jeder Liste, und sein Passwort verloere lautlos seine
 * Wirkung. Ein Display ist von Anfang an eines.
 *
 * `password_hash` traegt den Platzhalter aus dem Dienst, weil die Spalte NOT
 * NULL ist und "dieses Konto hat kein Passwort" in diesem Schema schon einmal
 * so beantwortet wurde (SSO-Konten, `$oidc$`).
 */
router.post('/', (req, res) => {
  try {
    const displayName = String(req.body?.display_name || '').trim();
    if (!displayName || displayName.length > 128) {
      return res.status(400).json({ error: 'A display name is required.', code: 400 });
    }

    let userId = null;
    db.get().transaction(() => {
      // Der Benutzername ist technisch und taucht nirgends auf: ein Display
      // meldet sich nie an. Er muss nur eindeutig sein, und die UNIQUE-Spalte
      // haelt das - ein Zaehler waere eine zweite Buchfuehrung darueber.
      // `randomUUID` und NICHT `Math.random()`: der Name ist zwar kein
      // Geheimnis, aber er steht in der `users`-Tabelle neben Konten, deren
      // Namen es sind, und CodeQL urteilt ueber den Kontext, nicht ueber die
      // Absicht (Alert 89). Eine kryptographische Quelle kostet hier nichts.
      const username = `display-${crypto.randomUUID()}`;
      // `onboarding_version` auf den aktuellen Stand: die Begruessungstour ist
      // fuer einen Menschen gedacht, der die App kennenlernt. An der Kuechenwand
      // stuende sie als Dialog vor dem Kalender, und niemand haette den Auftrag,
      // sie wegzutippen (im Browser gesehen, bevor diese Zeile stand).
      const ins = db.get().prepare(`
        INSERT INTO users (username, display_name, password_hash, role, family_role, onboarding_version)
        VALUES (?, ?, ?, 'member', 'other', ?)
      `).run(username, displayName, DISPLAY_PASSWORD_SENTINEL, CURRENT_ONBOARDING_VERSION);
      userId = Number(ins.lastInsertRowid);
      db.get().prepare('INSERT INTO display_accounts (user_id, created_by) VALUES (?, ?)')
        .run(userId, req.authUserId || null);
    })();

    return res.status(201).json({ data: { id: userId, display_name: displayName, devices: [] } });
  } catch (err) {
    log.error('POST / error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/** Ein Display samt Geraeten entfernen. Die users-Zeile geht mit; die
 *  Nebentabellen haengen per ON DELETE CASCADE daran. */
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.', code: 400 });
    const row = db.get().prepare('SELECT 1 FROM display_accounts WHERE user_id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Display not found.', code: 404 });
    db.get().prepare('DELETE FROM users WHERE id = ?').run(id);
    return res.json({ data: { id, deleted: true } });
  } catch (err) {
    log.error('DELETE /:id error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Einen Kopplungscode ausstellen. Der Klartext steht in DIESER Antwort und
 * danach nirgends mehr - dieselbe Regel wie beim API-Token.
 */
router.post('/:id/pairing-code', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.', code: 400 });
    const row = db.get().prepare('SELECT 1 FROM display_accounts WHERE user_id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Display not found.', code: 404 });

    const { code, expiresAt } = issuePairingCode(id, req.authUserId || null);
    return res.status(201).json({ data: { code, expires_at: expiresAt } });
  } catch (err) {
    log.error('POST /:id/pairing-code error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Ein Geraet widerrufen. Der Weg des Displays endet damit beim naechsten
 * Request, weil die Pruefung bei JEDEM Request in die Datenbank sieht - es gibt
 * keinen zwischengespeicherten Zustand, den ein Widerruf noch einholen muesste.
 */
router.post('/:id/devices/:deviceId/revoke', (req, res) => {
  try {
    const id = Number(req.params.id);
    const deviceId = Number(req.params.deviceId);
    if (!Number.isInteger(id) || !Number.isInteger(deviceId)) {
      return res.status(400).json({ error: 'Invalid id.', code: 400 });
    }
    // Das Geraet muss zu DIESEM Display gehoeren: sonst waere der Pfad eine
    // Verzierung und die Geraete-ID allein die Autoritaet.
    const device = db.get().prepare('SELECT id FROM display_devices WHERE id = ? AND user_id = ?').get(deviceId, id);
    if (!device) return res.status(404).json({ error: 'Device not found.', code: 404 });

    revokeDisplayDevice(deviceId);
    return res.json({ data: { id: deviceId, revoked: true } });
  } catch (err) {
    log.error('POST /:id/devices/:deviceId/revoke error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
