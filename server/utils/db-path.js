/**
 * Modul: Pfad der Datenbankdatei
 * Zweck: Die EINE Stelle, die aus DB_PATH den Pfad ableitet, den server/db.js
 *        öffnet. Der Secret-Handschlag (server/utils/auto-secrets.js) läuft
 *        VOR db.js und muss wissen, ob dort schon eine Datenbank liegt - ein
 *        Nachbau, der nur `yuvomi.db` prüft, gäbe einer noch nicht migrierten
 *        `oikos.db` einen neuen Schlüssel, und db.js verschlüsselte sie danach
 *        still damit. Deshalb lesen beide hier.
 *
 * Yuvomi hieß früher „Oikos". Die DB-Datei lag standardmäßig unter `oikos.db`
 * (bzw. `/data/oikos.db` in allen ausgelieferten Docker-Templates). Damit
 * Bestands-Nutzer beim Update NICHTS von Hand ändern müssen, wird der
 * effektive Pfad abgeleitet:
 *   - kein DB_PATH gesetzt              → <root>/yuvomi.db
 *   - DB_PATH endet auf oikos.db        → <dir>/yuvomi.db  (Legacy-Default erkannt)
 *   - DB_PATH endet auf yuvomi.db       → <dir>/yuvomi.db  (neuer Default)
 *   - beliebiger anderer DB_PATH        → unverändert (Custom-Pfad wird respektiert)
 * In allen „managed" Fällen wird eine vorhandene `oikos.db` beim Start einmalig
 * nach `yuvomi.db` migriert (server/db.js, migrateLegacyDbFile). Dass auch der
 * NEUE Default `yuvomi.db` als managed gilt, ist bewusst: aktualisiert ein
 * Bestands-User seine Compose-Datei auf den neuen Default, lägen die Daten
 * weiter in `oikos.db` - die Migration greift trotzdem.
 */
import path from 'node:path';

/** Projektwurzel: Ablage der Datenbank, wenn DB_PATH fehlt. */
const ROOT_DIR = path.join(import.meta.dirname, '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dbPath: string, legacyPath: string | null }} `legacyPath` ist
 *   die `oikos.db` daneben, `null` außer im „managed" Layout. `:memory:`
 *   kommt als Custom-Pfad unverändert zurück.
 */
export function resolveDbPath(env = process.env) {
  const configured = env.DB_PATH;
  const baseDir = configured ? path.dirname(configured) : ROOT_DIR;
  const base = configured ? path.basename(configured) : null;
  const isManagedLayout = !configured || base === 'oikos.db' || base === 'yuvomi.db';
  return {
    dbPath: isManagedLayout ? path.join(baseDir, 'yuvomi.db') : configured,
    legacyPath: isManagedLayout ? path.join(baseDir, 'oikos.db') : null,
  };
}

/**
 * Verzeichnis für die beim ersten Start erzeugten Secrets: `.secrets` neben der
 * Datenbank, also auf demselben Volume (server/utils/auto-secrets.js).
 * `null` für `:memory:` - dort gibt es kein Volume, das sie halten könnte.
 * @param {string} dbPath aufgelöster Pfad aus resolveDbPath()
 * @returns {string | null}
 */
export function secretsDirFor(dbPath) {
  if (dbPath === ':memory:') return null;
  return path.join(path.dirname(dbPath), '.secrets');
}
