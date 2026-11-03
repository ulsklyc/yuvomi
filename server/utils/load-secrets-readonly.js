/**
 * Modul: Secrets lesen, ohne sie anzulegen (Werkzeuge neben dem Server)
 * Zweck: Vorab-Import für Befehle, die `server/db.js` in einem zweiten Prozess
 *        neben dem laufenden Server öffnen - der dokumentierte Backup-Befehl
 *        (`node --import ./server/utils/load-secrets-readonly.js -e ...`, in
 *        docs/installation.md und public/settings/pages/admin-backup.js).
 *        db.js liest DB_ENCRYPTION_KEY beim Laden aus process.env; ohne diesen
 *        Import kennt der Befehl weder `_FILE` noch den beim ersten Start unter
 *        `.secrets/` gespeicherten Schlüssel und bricht ab.
 *
 *        Dieselbe Reihenfolge wie der Server (env > _FILE > gespeichert), aber
 *        NIE erzeugen (`create: false`): ein Werkzeug ist kein Erststart. Der
 *        volle Handschlag (load-file-secrets.js) legte auf einem leeren oder
 *        falsch eingehängten Volume einen neuen Schlüssel an, und der Befehl
 *        schriebe danach ein Backup mit einem Schlüssel, den niemand kennt.
 */
import { applyFileSecrets } from './file-secrets.js';
import { applyAutoSecrets } from './auto-secrets.js';
import { createLogger } from '../logger.js';

const log = createLogger('Secrets');

try {
  applyAutoSecrets({ fromFile: applyFileSecrets(), log, create: false });
} catch (err) {
  log.error(err.message);
  process.exit(1);
}
