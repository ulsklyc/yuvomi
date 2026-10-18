/**
 * Modul: Profilbilder
 * Zweck: GET /api/v1/people/:id/avatar - das Bild einer Person als Bytes, fuer
 *        die Adressen, die Listen statt der Data-URL tragen
 *        (services/person-avatar.js).
 * Abhaengigkeiten: express, server/db.js, services/person-avatar.js, logger
 *
 * WER ES LESEN DARF: jedes angemeldete Konto ausser einem Ausgaben-Gast - eine
 * Sitzung, ein Wanddisplay, ein Token. Sie alle bekommen die Adresse in den
 * Zeilen, die sie lesen duerfen (Aufgaben, Termine, Notizen, Uebersicht), und
 * das Bild zeigt nur das Gesicht, das dort ohnehin daneben stand. Das Gast-Gate
 * in server/index.js laesst einen Gast nur an die geteilten Ausgaben; die
 * Gate-Ausnahme fuer Scopes steht dort an `isPersonAvatarRead()`.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import * as db from '../db.js';
import { parseAvatarDataUrl } from '../services/person-avatar.js';
import { createLogger } from '../logger.js';

const log = createLogger('People');
const router = express.Router();

router.get('/:id/avatar', (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid person ID.', code: 400 });
    }
    const row = db.get().prepare('SELECT avatar_data FROM users WHERE id = ?').get(Number(req.params.id));
    const image = parseAvatarDataUrl(row?.avatar_data);
    if (!image) return res.status(404).json({ error: 'No picture for this person.', code: 404 });

    const etag = `"${createHash('sha256').update(image.bytes).digest('hex').slice(0, 32)}"`;
    // Ueberschreibt das `no-store`, das server/index.js jeder API-Antwort setzt:
    // der Browser darf das Bild halten, fragt aber vor jeder Wiederverwendung
    // ueber eine neue Seite nach (304, wenn es sich nicht geaendert hat).
    res.set('Cache-Control', 'private, no-cache');
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
