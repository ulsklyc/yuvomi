/**
 * Modul: Idempotenz für schreibende Anfragen der öffentlichen API (#822)
 * Zweck: Ein wiederholter POST mit demselben `Idempotency-Key` legt kein
 *        zweites Mal an, sondern gibt die Antwort des ersten Versuchs zurück.
 * Abhängigkeiten: node:crypto, server/db.js (Tabelle `idempotency_keys`, v153)
 *
 * WARUM DAS NICHT DER CLIENT LÖSEN KANN: schickt er POST und die Antwort geht
 * unterwegs verloren, weiß er hinterher nicht, ob angelegt wurde. Wiederholt
 * er, riskiert er eine Dublette; wiederholt er nicht, riskiert er den Verlust.
 * Auflösen lässt sich das nur an der Stelle, die die Mutation ausführt.
 *
 * OPT-IN ÜBER DEN HEADER, und das ist der Grund, warum die Middleware für den
 * ganzen `/api/v1`-Namensraum gilt statt nur für den Endpoint, an dem #822
 * gemeldet wurde: ohne Header ändert sich für keinen bestehenden Aufrufer
 * irgendetwas. Eine Zusage, die nur an einem von zwanzig Endpoints gilt, wäre
 * dagegen selbst eine Falle - der nächste Aufrufer probiert sie beim zweiten
 * und bekommt stillschweigend seine Dublette.
 *
 * NUR POST. PUT und DELETE sind per HTTP-Definition schon idempotent, GET ist
 * folgenlos. PATCH bleibt bewusst draußen: dort ist die Wiederholung fachlich
 * mehrdeutig (ein „setze auf X" ist idempotent, ein „erhöhe um 1" nicht), und
 * eine halbe Zusage ist schlechter als keine.
 *
 * Antwortverhalten:
 *   - Erster Versuch          → Route läuft, Antwort wird festgehalten
 *   - Wiederholung, gleich    → gespeicherte Antwort, `Idempotent-Replayed: true`
 *   - Wiederholung, anders    → 409 (Schlüssel für zwei verschiedene Anfragen)
 *   - Wiederholung, parallel  → 409 (der erste Versuch läuft noch)
 */

import crypto from 'node:crypto';
import * as db from '../db.js';

const HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/** Lebensdauer eines Schlüssels. Danach ist er wieder frei - dieselbe Frist,
 *  die auch Stripe seinen Aufrufern zusagt. */
const TTL_HOURS = 24;

/** Nach dieser Frist gilt ein Vorgang ohne Antwort als abgebrochen (Prozess
 *  während der Ausführung gestorben). Ohne sie bliebe der Schlüssel bis zum
 *  Ablauf der TTL blockiert und der Aufrufer käme nie wieder durch. */
const IN_FLIGHT_TIMEOUT_SECONDS = 60;

/**
 * Kanonische Serialisierung für den Fingerabdruck.
 *
 * `JSON.stringify` allein reicht nicht: es schreibt die Schlüssel in
 * Einfügereihenfolge, und `{a:1,b:2}` und `{b:2,a:1}` sind derselbe Rumpf mit
 * zwei verschiedenen Zeichenketten. Der Aufrufer, der sein Objekt beim Retry
 * neu zusammensetzt, bekäme sonst einen Konflikt für eine Anfrage, die er
 * unverändert wiederholt hat.
 *
 * @param {any} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Fingerabdruck einer Anfrage: Methode, Pfad und Rumpf.
 * @param {import('express').Request} req
 * @returns {string} sha256-Hex
 */
function fingerprint(req) {
  const body = req.body === undefined ? null : req.body;
  return crypto.createHash('sha256')
    .update(`${req.method}\n${req.path}\n${canonicalize(body)}`)
    .digest('hex');
}

/**
 * Räumt abgelaufene Schlüssel weg. Läuft nur auf Anfragen, die überhaupt einen
 * Schlüssel tragen - das ist selten genug, dass es keinen Cron braucht, und
 * häufig genug, dass die Tabelle nicht wächst.
 * @param {import('better-sqlite3').Database} conn
 */
function purgeExpired(conn) {
  conn.prepare(
    `DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)`,
  ).run(`-${TTL_HOURS} hours`);
}

/**
 * Idempotenz-Middleware. Muss NACH requireAuth laufen (`req.authUserId`).
 */
function idempotencyMiddleware(req, res, next) {
  const key = req.get(HEADER);
  // `undefined` heisst „kein Header" - ein LEERER Header dagegen ist ein
  // Aufrufer, der Retry-Sicherheit zu haben glaubt und keine bekaeme. Der wird
  // abgewiesen statt still durchgewunken.
  if (key === undefined || req.method !== 'POST') return next();

  const trimmed = key.trim();
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH || /[^\x20-\x7E]/.test(trimmed)) {
    return res.status(400).json({
      error: `Idempotency-Key must be printable ASCII, 1 to ${MAX_KEY_LENGTH} characters.`,
      code: 400,
    });
  }

  const userId = req.authUserId;
  if (!userId) return next(); // ohne Akteur kein Gedächtnis - nicht unsere Ebene

  const conn = db.get();
  const hash = fingerprint(req);
  let recordId = null;

  try {
    purgeExpired(conn);

    // Der Platzhalter entsteht VOR der Route: ein gleichzeitiger zweiter
    // Versuch stößt sich damit am eindeutigen Index, statt neben dem ersten
    // herzulaufen. Genau dieser Fall - Client bricht ab und wiederholt sofort -
    // ist der, für den der Header überhaupt geschickt wird.
    const insert = conn.prepare(`
      INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO NOTHING
    `).run(userId, trimmed, req.method, req.path, hash);

    if (insert.changes === 0) {
      const existing = conn.prepare(
        'SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?',
      ).get(userId, trimmed);

      // Zwischen Konflikt und Lesen kann die Zeile abgelaufen und geräumt
      // worden sein. Dann ist es schlicht ein neuer Vorgang.
      if (!existing) return next();

      if (existing.request_hash !== hash) {
        return res.status(409).json({
          error: 'This Idempotency-Key was already used for a different request.',
          code: 409,
          // Fester Grund fuer Clients: der Text darf sich aendern, der Grund nicht.
          reason: 'idempotency_key_reused',
        });
      }

      if (existing.status === null) {
        const stale = conn.prepare(
          `SELECT created_at < datetime('now', ?) AS stale FROM idempotency_keys WHERE id = ?`,
        ).get(`-${IN_FLIGHT_TIMEOUT_SECONDS} seconds`, existing.id);

        if (!stale?.stale) {
          return res.status(409).json({
            error: 'A request with this Idempotency-Key is still in progress.',
            code: 409,
            // Der Ausgang der ersten Anfrage ist offen - ein Client behaelt
            // Schluessel und Rumpf fuer den naechsten Versuch.
            reason: 'idempotency_in_progress',
          });
        }
        // Abgebrochener Vorgang: der Platzhalter wird übernommen und die
        // Anfrage läuft erneut. Das Restrisiko ist bewusst - fiel der Prozess
        // zwischen Mutation und Festhalten der Antwort, kann die Wiederholung
        // ein zweites Mal anlegen. Die Alternative wäre ein Schlüssel, der bis
        // zum TTL-Ablauf tot ist, und das trifft jeden Abbruch statt nur den
        // seltenen Fall, in dem beide Hälften auseinanderfielen.
        conn.prepare(`UPDATE idempotency_keys SET created_at = datetime('now') WHERE id = ?`)
          .run(existing.id);
        recordId = existing.id;
      } else {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(existing.status).json(JSON.parse(existing.response_body));
      }
    } else {
      recordId = insert.lastInsertRowid;
    }
  } catch {
    // Ein Gedächtnisproblem darf die eigentliche Anfrage nicht abweisen: ohne
    // Idempotenz ist sie das, was sie vor #822 war, mit Fehler ist sie weg.
    return next();
  }

  const originalJson = res.json.bind(res);
  let captured = false;

  // FESTGEHALTEN WIRD VOR DEM SENDEN, nicht im `finish`-Ereignis. Der Aufrufer
  // bekommt seine Antwort damit erst, wenn sie auch wiederholbar ist - sonst
  // läge zwischen „Antwort ist raus" und „Antwort ist gespeichert" genau die
  // Lücke, gegen die der Header antritt.
  res.json = (body) => {
    if (!captured) {
      captured = true;
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          db.get().prepare(`
            UPDATE idempotency_keys
               SET status = ?, response_body = ?, completed_at = datetime('now')
             WHERE id = ?
          `).run(res.statusCode, JSON.stringify(body ?? null), recordId);
        } else {
          // Fehlschläge werden nicht zementiert: ein 400 nach korrigierter
          // Eingabe oder ein 500 nach behobener Ursache muss mit demselben
          // Schlüssel erneut versucht werden können.
          db.get().prepare('DELETE FROM idempotency_keys WHERE id = ?').run(recordId);
        }
      } catch { /* siehe oben: Antwort geht vor */ }
    }
    return originalJson(body);
  };

  // Antworten ohne JSON-Rumpf (Downloads, `sendStatus`, abgebrochene
  // Verbindungen) lassen sich nicht wiedergeben - ihr Platzhalter darf den
  // Schlüssel nicht dauerhaft belegen.
  res.on('finish', () => {
    if (captured) return;
    try {
      db.get().prepare('DELETE FROM idempotency_keys WHERE id = ? AND status IS NULL').run(recordId);
    } catch { /* best effort */ }
  });

  return next();
}

export default idempotencyMiddleware;
export { canonicalize, fingerprint, TTL_HOURS, IN_FLIGHT_TIMEOUT_SECONDS, MAX_KEY_LENGTH };
