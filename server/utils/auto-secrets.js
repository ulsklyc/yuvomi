/**
 * Modul: Secrets, die beim ersten Start von selbst entstehen
 * Zweck: SESSION_SECRET und DB_ENCRYPTION_KEY muss niemand mehr vor dem ersten
 *        Start erzeugen: fehlen sie, legt Yuvomi sie unter
 *        `<Verzeichnis von DB_PATH>/.secrets/<NAME>` an und liest sie von dort
 *        bei jedem weiteren Start. Paketierer (NAS-Kataloge, BigBear, CapRover,
 *        Dokploy) müssen dann keine Secrets mehr abfragen oder fest einbauen.
 *
 *        Läuft im Handschlag server/utils/load-file-secrets.js, also nach
 *        `<NAME>_FILE` und VOR server/db.js und server/auth.js, die beide
 *        Werte beim Laden aus process.env lesen. Bewusst in Node und nicht im
 *        Entrypoint: der Container startet auch ohne root (TrueNAS 568:568),
 *        und die Dateien sollen dem Prozess-User gehören.
 *
 *        Reihenfolge je Secret:
 *          1. `<NAME>` aus der Umgebung              → 'env'
 *          2. `<NAME>_FILE`                          → 'file'
 *          3. die gespeicherte Datei                 → 'stored'
 *          4. neu erzeugen und speichern             → 'generated'
 *        Gilt 1 oder 2 und liegt trotzdem eine gespeicherte Datei da, gewinnt
 *        der ausdrückliche Wert, und das Log sagt es (Name und Pfad, nie der
 *        Wert). Ein Platzhalter `REPLACE_WITH_*` ist ein ausdrücklicher Wert:
 *        er wird hier nicht überstimmt, die Guards in auth.js und db.js
 *        brechen an ihm ab wie bisher.
 *
 *        BESTANDSINSTALLATIONEN BLEIBEN, WIE SIE SIND. Das trägt der
 *        Datenbankschlüssel: er entsteht nur, solange am Pfad aus
 *        server/utils/db-path.js weder `yuvomi.db` noch eine Legacy-`oikos.db`
 *        liegt. Gäbe es ihn für eine vorhandene Klartext-Datenbank, würde
 *        db.js sie beim Start still damit verschlüsseln (encryptPlaintextDatabase)
 *        - ein Schlüssel, von dem der Betreiber nichts weiß, über seinen Daten.
 *        `DB_ENCRYPTION_AUTO_KEY=false` verhindert nur das Erzeugen, für eine
 *        bewusst unverschlüsselte Neuinstallation; eine schon gespeicherte
 *        Datei wird auch dann gelesen, sonst öffnete sich die Datenbank nicht.
 *        SESSION_SECRET hat keinen Schalter: ohne lief eine Bestandsinstallation
 *        nie (auth.js bricht ab), und ein neues kostet nur einen Login.
 *
 *        Eine gespeicherte Datei, die leer ist oder sich nicht lesen lässt,
 *        bricht den Start ab. Still neu zu erzeugen hiesse beim
 *        Datenbankschlüssel, die vorhandene Datenbank auszusperren.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { resolveDbPath, secretsDirFor } from './db-path.js';

/** Die beiden Secrets, die dieses Modul erzeugen darf. */
export const AUTO_SECRET_VARS = Object.freeze(['SESSION_SECRET', 'DB_ENCRYPTION_KEY']);

/**
 * Herkunft und Ablage je Secret, gemerkt beim Handschlag. Nicht in process.env:
 * ein Kindprozess erbte sie sonst, und eine Herkunft lässt sich dort fälschen.
 * @type {Map<string, { origin: 'env' | 'file' | 'stored' | 'generated', storedPath: string | null }>}
 */
const state = new Map();

/** 32 Zufallsbytes als Hex, wie `openssl rand -hex 32` aus der Doku. */
export function generateSecretValue() {
  return randomBytes(32).toString('hex');
}

/**
 * Wo `name` gespeichert wird bzw. würde: `<Verzeichnis von DB_PATH>/.secrets/<name>`.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} `null` für `DB_PATH=:memory:`
 */
export function storedSecretPathFor(name, env = process.env) {
  const dir = secretsDirFor(resolveDbPath(env).dbPath);
  return dir ? path.join(dir, name) : null;
}

/** Gibt es einen Verzeichniseintrag? Nur ENOENT heißt nein - ein EACCES ist kein Beleg für eine fehlende Datei. */
function entryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

/**
 * Inhalt der gespeicherten Datei; `null`, wenn es sie nicht gibt.
 * @throws {Error} wenn sie da ist, aber leer oder unlesbar
 */
function readStored(name, filePath, read) {
  let raw;
  try {
    raw = read(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(
      `${name} is stored in ${filePath}, which cannot be read (${err?.code || err?.message}). ` +
      `Give it to the user Yuvomi runs as (mode 600). It is not created again: ` +
      (name === 'DB_ENCRYPTION_KEY'
        ? 'a new key would lock you out of the database encrypted with this one.'
        : 'a new value would sign everyone out, and the cause would stay hidden.')
    );
  }
  const value = raw.replace(/[\r\n]+$/, '');
  if (value === '') {
    throw new Error(
      `${filePath} is empty, so ${name} cannot be read from it. It is not created again: ` +
      (name === 'DB_ENCRYPTION_KEY'
        ? 'a new key would lock you out of a database encrypted with the old one. Restore the file '
          + 'from your backup of the key, or set DB_ENCRYPTION_KEY.'
        : `delete ${filePath} to have a new one generated (everyone signs in again once), or set ${name}.`)
    );
  }
  return value;
}

/**
 * Schreibt `value` unteilbar nach `filePath` (Verzeichnis 0700, Datei 0600).
 *
 * Erst eine eigene Arbeitsdatei (`wx`, fsync), dann `link()` an den Zielnamen:
 * der scheitert mit EEXIST, wenn ein zweiter Prozess gleichzeitig gewonnen hat,
 * statt dessen Wert zu überschreiben - wie bei `.creating` in db.js. Dann gilt
 * der Wert des anderen. Kennt das Dateisystem keine harten Links (manche
 * Netzfreigaben), fällt es auf `rename()` zurück, mit Probe auf das Ziel
 * unter einer Sperre `<Datei>.lock`.
 *
 * @returns {string} der Wert, der danach in der Datei steht
 */
function writeStored(name, filePath, value, read, link = linkSync) {
  const dir = path.dirname(filePath);
  mkdirSync(path.dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${value}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    link(tmp, filePath);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      rmSync(tmp, { force: true });
      return readStored(name, filePath, read);
    }
    // Ohne harte Links: rename() ersetzt ein vorhandenes Ziel still, Probe und
    // rename allein liessen zwei gleichzeitige Erststarts beide gewinnen. Ein
    // Sperrverzeichnis (mkdir ist unteilbar) macht beides zu einem Schritt; wer
    // es nicht bekommt, wartet, bis der Gewinner fertig ist, und liest dessen Wert.
    const lock = `${filePath}.lock`;
    try {
      mkdirSync(lock);
    } catch (lockErr) {
      rmSync(tmp, { force: true });
      if (lockErr?.code !== 'EEXIST') throw lockErr;
      return waitForStored(name, filePath, lock, read);
    }
    try {
      if (entryExists(filePath)) {
        rmSync(tmp, { force: true });
        return readStored(name, filePath, read);
      }
      renameSync(tmp, filePath);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  rmSync(tmp, { force: true });
  // Verzeichniseintrag auf die Platte, best effort: manche Dateisysteme können
  // fsync auf ein Verzeichnis nicht (siehe DIRECTORY_SYNC_UNSUPPORTED in db.js).
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* der Eintrag ist trotzdem da, nur nicht sofort dauerhaft */ }
  return value;
}

/** So lange wartet ein Verlierer auf die Sperre des Gewinners (writeStored). */
const LOCK_WAIT_MS = 10_000;

/**
 * Wartet, bis ein anderer Prozess seine Sperre aufgibt, und liest dessen Wert.
 * Synchron (Atomics.wait), weil der ganze Handschlag vor db.js synchron läuft.
 * Bleibt die Sperre stehen (Absturz mitten im Schreiben), bricht der Start mit
 * ihrem Pfad ab, statt einen zweiten Wert zu erzeugen.
 */
function waitForStored(name, filePath, lock, read) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (entryExists(lock)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Another start is still writing ${name} (${lock} exists). If no other Yuvomi ` +
        `process is running, delete ${lock} and start again.`
      );
    }
    Atomics.wait(pause, 0, 0, 50);
  }
  const value = readStored(name, filePath, read);
  if (value === null) {
    throw new Error(`Another start was writing ${name} to ${filePath} and gave up. Start again.`);
  }
  return value;
}

/** Steht ein Wert in `env`? Leer gilt als nicht gesetzt, wie in file-secrets.js. */
function isSet(env, name) {
  return env[name] !== undefined && env[name] !== '';
}

/**
 * Löst SESSION_SECRET und DB_ENCRYPTION_KEY auf und merkt sich die Herkunft.
 * Läuft NACH applyFileSecrets().
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]  Ziel, Default process.env
 * @param {string[]} [options.fromFile]  Namen, die applyFileSecrets() geladen hat
 * @param {{ info: Function, warn: Function }} options.log
 * @param {() => string} [options.generate]  für Tests austauschbar
 * @param {(p: string) => string} [options.read]  für Tests austauschbar
 * @param {boolean} [options.create]  `false`: nur lesen, nie erzeugen und nie
 *   eine Datei oder ein Verzeichnis anlegen - für Werkzeuge neben dem Server
 *   (server/check-backup.js), die einen vorhandenen Schlüssel brauchen, aber
 *   kein Erststart sind
 * @throws {Error} bei unlesbarer/leerer gespeicherter Datei oder wenn ein
 *   erzeugter Wert nicht gespeichert werden kann
 */
export function applyAutoSecrets({
  env = process.env,
  fromFile = [],
  log,
  generate = generateSecretValue,
  read = (p) => readFileSync(p, 'utf8'),
  create = true,
}) {
  const { dbPath, legacyPath } = resolveDbPath(env);
  for (const name of AUTO_SECRET_VARS) {
    const storedPath = storedSecretPathFor(name, env);

    if (isSet(env, name)) {
      const origin = fromFile.includes(name) ? 'file' : 'env';
      state.set(name, { origin, storedPath: null });
      if (storedPath && entryExists(storedPath)) {
        log.warn(
          `${name} is set ${origin === 'file' ? `through ${name}_FILE` : 'in the environment'}, so ` +
          `${storedPath} is not used. Keep only one of the two.`
        );
      }
      continue;
    }

    if (storedPath) {
      const value = readStored(name, storedPath, read);
      if (value !== null) {
        env[name] = value;
        state.set(name, { origin: 'stored', storedPath });
        continue;
      }
    }

    if (!create) continue;

    if (name === 'SESSION_SECRET') {
      if (!storedPath) {
        // :memory: hält auch die Sessions nur im Speicher; ein Wert für diesen
        // einen Lauf ist hier genau so dauerhaft wie alles andere.
        env[name] = generate();
        state.set(name, { origin: 'generated', storedPath: null });
        log.info('Generated SESSION_SECRET for this run only: DB_PATH is :memory:, so there is nowhere to keep it.');
        continue;
      }
      env[name] = store(name, storedPath, generate(), read);
      state.set(name, { origin: 'generated', storedPath });
      log.info(`Generated SESSION_SECRET and stored it in ${storedPath}.`);
      continue;
    }

    // DB_ENCRYPTION_KEY: nur für eine Neuinstallation.
    if (!storedPath) continue;
    if (env.DB_ENCRYPTION_AUTO_KEY === 'false') continue;
    if (entryExists(dbPath) || (legacyPath && entryExists(legacyPath))) continue;
    env[name] = store(name, storedPath, generate(), read);
    state.set(name, { origin: 'generated', storedPath });
    log.warn(
      `Generated DB_ENCRYPTION_KEY for this new installation and stored it in ${storedPath}. ` +
      'It lies on the same volume as the database, so it protects a database file or backup that ' +
      'leaves this machine, not a stolen volume. Keep a copy of it somewhere else (Settings > ' +
      'Household > Backup and restore shows it): without it, your backups cannot be opened once this volume is ' +
      'lost. A key of your own through DB_ENCRYPTION_KEY or DB_ENCRYPTION_KEY_FILE is stronger.'
    );
  }
}

/** writeStored() mit einer Meldung, die sagt, was jetzt zu tun ist. */
function store(name, storedPath, value, read) {
  try {
    return writeStored(name, storedPath, value, read);
  } catch (err) {
    throw new Error(
      `${name} is not set, and the generated value could not be stored in ${storedPath} ` +
      `(${err?.code || err?.message}). Give the user Yuvomi runs as write access to ` +
      `${path.dirname(path.dirname(storedPath))}, or set ${name} yourself.`,
      { cause: err }
    );
  }
}

/**
 * Woher der aktuelle Wert kam: 'env' (`<NAME>` gesetzt), 'file' (`<NAME>_FILE`),
 * 'stored' (aus `.secrets/` gelesen), 'generated' (bei diesem Start erzeugt).
 * `null`: nicht gesetzt, oder der Handschlag lief in diesem Prozess nicht
 * (Tests, Skripte, die db.js direkt importieren).
 *
 * Für die Admin-Anzeige: einen Wert zeigen darf sie nur bei 'stored' und
 * 'generated' - bei 'env'/'file' gehört er dem Betreiber und steht dort schon.
 * @param {'SESSION_SECRET' | 'DB_ENCRYPTION_KEY'} name
 * @returns {'env' | 'file' | 'stored' | 'generated' | null}
 */
export function secretOrigin(name) {
  return state.get(name)?.origin ?? null;
}

/**
 * Pfad der gespeicherten Datei, aus der der aktuelle Wert kommt bzw. in die er
 * geschrieben wurde. `null` bei 'env'/'file', ohne Wert und bei `:memory:`.
 * @param {'SESSION_SECRET' | 'DB_ENCRYPTION_KEY'} name
 * @returns {string | null}
 */
export function storedSecretPath(name) {
  return state.get(name)?.storedPath ?? null;
}

/** NUR FÜR TESTS: writeStored() mit austauschbarem link(), für Dateisysteme ohne harte Links. */
export function _writeStoredForTest(name, filePath, value, read, link) {
  return writeStored(name, filePath, value, read, link);
}

/** NUR FÜR TESTS: gemerkte Herkunft vergessen. */
export function _resetAutoSecretState() {
  state.clear();
}
