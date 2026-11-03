/**
 * Modul: Handschlag für Secrets beim Start
 * Zweck: Steht als ERSTER Import in server/index.js (und vor server/db.js in
 *        setup.js und scripts/restore-backup.js). ES-Module werden in der
 *        Reihenfolge ihrer Imports ausgewertet, dieses also vor server/db.js und
 *        server/auth.js, die DB_ENCRYPTION_KEY und SESSION_SECRET beim Laden aus
 *        process.env lesen.
 *        Erst `<NAME>_FILE` (server/utils/file-secrets.js), danach die beim
 *        ersten Start erzeugten Secrets (server/utils/auto-secrets.js) - in
 *        dieser Reihenfolge, weil ein ausdrücklicher Wert die gespeicherte
 *        Datei schlägt.
 */
import { applyFileSecrets, looseSecretFiles } from './file-secrets.js';
import { applyAutoSecrets } from './auto-secrets.js';
import { createLogger } from '../logger.js';

const log = createLogger('Secrets');

try {
  const loaded = applyFileSecrets();
  if (loaded.length > 0) log.info(`Loaded from files: ${loaded.join(', ')}`);
  for (const warning of looseSecretFiles()) log.warn(warning);
  applyAutoSecrets({ fromFile: loaded, log });
} catch (err) {
  log.error(err.message);
  process.exit(1);
}
