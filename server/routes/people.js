/**
 * Modul: Profilbilder
 * Zweck: GET /api/v1/people/:id/avatar - das Bild einer Person als Bytes, fuer
 *        die Adressen, die Listen statt der Data-URL tragen
 *        (services/person-avatar.js).
 * Abhaengigkeiten: express, server/db.js, services/person-avatar.js, logger
 *
 * WER ES LESEN DARF: wer die Adresse in seinen Zeilen bekommt - eine Sitzung
 * und ein Wanddisplay (Aufgaben, Termine, Notizen, Uebersicht); das Bild zeigt
 * nur das Gesicht, das dort ohnehin daneben stand. Ein API-Token bekommt statt
 * der Adresse die Data-URL (`inlineAvatarUrls`) und mit Scopes keinen Zugang
 * zur Route; die Ausnahme im Scope-Gate in server/index.js gilt nur dem
 * Display. Das Gast-Gate laesst einen Ausgaben-Gast nur an die geteilten
 * Ausgaben.
 */

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as db from '../db.js';
import { parseAvatarDataUrl } from '../services/person-avatar.js';
import { createLogger } from '../logger.js';

const log = createLogger('People');
const router = express.Router();

/** Vergleich in konstanter Zeit; ein fehlender Schluessel passt nie. */
function keyMatches(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !stored) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.get('/:id/avatar', (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid person ID.', code: 400 });
    }
    const row = db.get().prepare('SELECT avatar_data, avatar_key FROM users WHERE id = ?').get(Number(req.params.id));
    const image = parseAvatarDataUrl(row?.avatar_data);
    // NUR MIT DEM SCHLUESSEL AUS DER ZEILE (`?v=`, Migration 251). Fehlt er
    // oder passt er nicht, heisst die Antwort dasselbe 404 wie "kein Bild":
    // wer ids durchzaehlt, erfaehrt nicht einmal, wer eines hat.
    if (!image || !keyMatches(req.query.v, row?.avatar_key)) {
      return res.status(404).json({ error: 'No picture for this person.', code: 404 });
    }

    const etag = `"${createHash('sha256').update(image.bytes).digest('hex').slice(0, 32)}"`;
    // Ueberschreibt das `no-store`, das server/index.js jeder API-Antwort setzt.
    // `immutable`, weil der Schluessel mit jedem neuen Bild wechselt: unter
    // dieser Adresse steht nie ein anderes Bild.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('ETag', etag);
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.type(image.mime);
    res.set('Content-Length', String(image.bytes.length));
    return res.end(image.bytes);
  } catch (err) {
    log.error('Avatar read error:', err);
    return res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
