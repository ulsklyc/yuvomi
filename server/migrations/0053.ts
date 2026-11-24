// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { decodeHtmlEntities } from '../utils/html-entities.js';

export default {
    version: 53,
    description: 'Repair HTML-entity-encoded external calendar names (e.g. "&amp;")',
    up(db) {
      // Provider-Namen wurden bisher verbatim gespeichert; Google liefert für
      // Import-Kalender HTML-entity-encodierte Namen ("Termine &amp; …"), die
      // im UI doppelt escaped als literales "&amp;" erscheinen. Der Ingest
      // normalisiert ab jetzt zu Klartext — Bestandszeilen hier nachziehen.
      const rows = db.prepare('SELECT id, name FROM external_calendars').all();
      const update = db.prepare('UPDATE external_calendars SET name = ? WHERE id = ?');
      for (const { id, name } of rows) {
        const decoded = decodeHtmlEntities(name);
        if (decoded !== name) update.run(decoded, id);
      }
    },
  };
