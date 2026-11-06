#!/usr/bin/env node
/**
 * Yuvomi Web Installer - temporary setup server.
 * Zero npm dependencies. Node.js built-ins only.
 * Run: node tools/installer/install-server.js
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_SCHEMA } from './env-schema.js';
import { RERUN_PREFILL_KEYS, RERUN_SECRET_KEYS } from './env-schema.js';
// Nur Node-Built-ins; dieselbe Liste wie beim App-Start (applyFileSecrets).
import { FILE_SECRET_VARS } from '../../server/utils/file-secrets.js';
import { SUPPORTED_LOCALES as INSTALLER_LOCALES } from './i18n-mini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..', '..');
const PORT = 8090;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Resolved lazily so tests can point the installer at a temp directory.
function projectRoot() {
  return process.env.OIKOS_INSTALLER_ROOT
    ? resolve(process.env.OIKOS_INSTALLER_ROOT)
    : DEFAULT_ROOT;
}

const WRITABLE_KEYS = new Set(ENV_SCHEMA.filter(e => e.writeToEnv).map(e => e.key));

/**
 * Sprachen, die der Proxy als `language` an /api/v1/auth/setup weiterreicht.
 *
 * Die App setzt damit die Datensprache des Haushalts (Geburtstagstitel, ICS,
 * Suche) - ohne sie fiel die beim ersten Konto still auf Englisch, obwohl der
 * Nutzer den ganzen Wizard z.B. auf Franzoesisch durchlaufen hatte. Die Liste
 * kommt aus den Installer-Locales, denn nur die kann der Browser schicken; der
 * Server nimmt ausschliesslich Kurzcodes aus getSupportedLocales() an
 * (server/utils/i18n.js), `de-DE` oder `DE` waeren ein 400. Heute sind beide
 * Listen gleich, test-installer-i18n.js haelt sie gleich. Alles andere faellt
 * hier weg, statt die Kontoanlage an einem Sprachcode scheitern zu lassen.
 */
export const SETUP_LANGUAGES = new Set(INSTALLER_LOCALES);

/** Der weiterzureichende Sprachcode, oder null. */
export function setupLanguage(value) {
  return typeof value === 'string' && SETUP_LANGUAGES.has(value) ? value : null;
}

let idleTimer = null;

/**
 * Nachlauf nach dem Anlegen des Admin-Kontos.
 *
 * Vorher waren das harte zwei Sekunden. Solange der Download eine Blob-Kopie im
 * Browser war, ging das: er brauchte den Server nicht. Seit er die echte Datei
 * von /api/env-file holt, war der Knopf fuer jeden tot, der laenger als zwei
 * Sekunden auf dem Abschlussbildschirm brauchte - und die Seite meldete
 * trotzdem "gesichert" und gab den Link zur App frei. Ausgerechnet die
 * Sicherung der einzigen Verschluesselungsschluessel.
 *
 * Fuenf Minuten, und jeder weitere Request setzt sie zurueck: genug fuer den
 * Download, aber der Installer bleibt nicht die vollen 30 Minuten offen,
 * nachdem seine Arbeit getan ist.
 */
const POST_SETUP_IDLE_MS = 5 * 60 * 1000;
let idleMs = IDLE_TIMEOUT_MS;
export function beginPostSetupShutdown() { idleMs = POST_SETUP_IDLE_MS; }

function resetIdle(server) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('\nIdle timeout - shutting down installer server.');
    server.close(() => process.exit(0));
  }, idleMs);
  // Don't let the idle timer keep the process (or a test runner) alive.
  idleTimer.unref?.();
}

/**
 * Allowlist env keys against ENV_SCHEMA and reject values that would inject
 * extra lines into the .env file. Returns { ok, env } or { ok: false, error }.
 */
export function sanitizeEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!WRITABLE_KEYS.has(key)) continue;          // drop unknown keys
    if (value == null || value === '') continue;    // skip empties
    const str = String(value);
    if (/[\n\r]/.test(str)) {
      return { ok: false, error: `Invalid value for ${key}: line breaks are not allowed` };
    }
    clean[key] = str;
  }
  return { ok: true, env: clean };
}

/**
 * Encode a single .env value so Docker Compose reads it back verbatim.
 * Compose's env_file/`.env` parser treats an unescaped `$` as an interpolation
 * (`${VAR}`/`$VAR`), starts an inline comment at a whitespace-preceded `#`, and
 * trims surrounding whitespace. Bare values that contain none of those stay
 * unquoted (keeps simple secrets/paths readable); anything risky is
 * double-quoted with `\`, `"`, backtick escaped, and every `$` doubled to `$$`
 * (Compose's literal-dollar escape). Newlines are already rejected upstream by
 * sanitizeEnv, so a value can never break onto a second line here.
 */
export function encodeEnvValue(str) {
  const dollarSafe = str.replace(/\$/g, '$$$$'); // $ -> $$ (literal dollar for Compose)
  // Quote when the raw value has whitespace, a comment char, quotes, a backtick,
  // or a backslash. Inside the double quotes only `"` and `\` are special to
  // Compose, so those are the only chars escaped (backtick stays literal).
  if (/^\s|\s$|[\s#"'`\\]/.test(str)) {
    return `"${dollarSafe.replace(/(["\\])/g, '\\$1')}"`;
  }
  return dollarSafe;
}

export function renderEnvFile(env) {
  const lines = ['# Generated by Yuvomi Installer'];
  for (const [key, value] of Object.entries(env)) lines.push(`${key}=${encodeEnvValue(value)}`);
  return lines.join('\n') + '\n';
}

/** Escapes in doppelten Anfuehrungszeichen, wie Compose sie aufloest. */
const DOUBLE_QUOTE_ESCAPES = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };

/**
 * Gegenstück zu encodeEnvValue(): der Wert rechts vom `=` so, wie Docker
 * Compose ihn liest (docs.docker.com/compose/how-tos/environment-variables/
 * variable-interpolation, ".env file syntax"):
 *   - unquoted: ein Inline-Kommentar beginnt erst an einem `#` NACH Leerraum
 *     (`./data # x` -> `./data`, `a#b` bleibt), danach wird getrimmt; `$$` ist
 *     ein wörtliches `$`
 *   - 'einfach': wörtlich, kein `$$`, nur `\'` ist ein Escape; alles nach dem
 *     schliessenden Quote ist Kommentar
 *   - "doppelt": `\n \r \t \\ \"` als Escapes, `$$` als `$`; alles nach dem
 *     schliessenden Quote ist Kommentar
 * Vorher kannte der Parser nur doppelte Quotes: `DATA_DIR=./data # storage`
 * kam MIT Kommentar zurück, der Rerun belegte das Feld damit vor und schrieb
 * `DATA_DIR="./data # storage"` - ein anderes Verzeichnis, die Daten schienen
 * weg. Variablen (`$VAR`) löst er bewusst nicht auf.
 */
export function decodeEnvValue(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const ch = value[i];
      if (ch === quote) return quote === '"' ? out.replace(/\$\$/g, '$') : out;
      if (ch === '\\' && i + 1 < value.length) {
        const next = value[i + 1];
        if (quote === "'" ? next === "'" : next in DOUBLE_QUOTE_ESCAPES) {
          out += quote === "'" ? "'" : DOUBLE_QUOTE_ESCAPES[next];
          i++;
          continue;
        }
      }
      out += ch;
    }
    // Kein schliessendes Quote (mehrzeiliger Wert): die Zeile bleibt, wie sie
    // ist - geraten wird nicht.
    return value;
  }
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim().replace(/\$\$/g, '$');
}

/**
 * Eine vorhandene .env einlesen. Nur für Werte gedacht, die erhalten bleiben
 * müssen - der Rest der Datei wird beim Speichern ohnehin neu geschrieben.
 * Fehlt oder bricht die Datei, ist das Ergebnis ein leeres Objekt.
 */
export function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  let content;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return {};
  }
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    env[trimmed.slice(0, separator).trim()] = decodeEnvValue(trimmed.slice(separator + 1));
  }
  return env;
}

/**
 * Die Zuweisungen einer bestehenden .env, die der Client nicht selbst schickt -
 * als ROHE Zeilen, Zeichen für Zeichen.
 *
 * Das ist der Unterschied zu readEnvFile(): dort wird dekodiert, hier nicht.
 * Eine Zeile, die niemand ändern will, soll die Datei genauso wieder verlassen,
 * wie sie hineingekommen ist. Parsen und neu rendern hiesse, Compose-Syntax zu
 * interpretieren und neu maskieren - jede Abweichung zwischen decodeEnvValue
 * und Compose änderte still Passwörter und Pfade (bis Oktober 2026 kannte der
 * Parser weder einfache Anführungszeichen noch angehängte Kommentare).
 *
 * Kommentare und Leerzeilen fallen weg: sie beziehen sich auf den alten Aufbau
 * der Datei und stünden im neuen an der falschen Stelle.
 *
 * `cleared`: Schlüssel, deren Zeile bewusst wegfällt (siehe clearableKeys).
 */
export function preserveUnmanagedLines(envPath, written, cleared = new Set()) {
  if (!existsSync(envPath)) return [];
  let content;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (written[key] || cleared.has(key)) continue;
    lines.push(trimmed);
  }
  return lines;
}

/**
 * Schlüssel, die einen Installer-Rerun überleben MÜSSEN.
 *
 * Ein einmal benutzter DB_ENCRYPTION_KEY verschlüsselt die Datenbank; mit einem
 * neuen Wert bricht der Start ab und die Daten sind ohne den alten Schlüssel
 * nicht mehr zu erreichen. Ein Rerun (Update, Portwechsel, nachgetragenes SMTP)
 * darf eine laufende Installation nicht so zerlegen. SESSION_SECRET ist der
 * harmlosere Fall: ein neuer Wert wirft nur alle Angemeldeten aus der App.
 *
 * Sendet der Client für einen dieser Schlüssel einen Wert, gewinnt der - dann
 * hat der Nutzer ihn im Experten-Modus bewusst eingetragen.
 */
export const PRESERVED_KEYS = ['SESSION_SECRET', 'DB_ENCRYPTION_KEY'];

/**
 * Die Schlüssel aus `clear` (save-env-Body), deren Zeile der Server entfernen
 * darf: der Nutzer hat ihr vorbelegtes Feld im Wizard geleert (clearedKeys in
 * rerun-prefill.js). Erzwungen wird hier, nicht im Client: nur Schlüssel der
 * Allowlist RERUN_PREFILL_KEYS - also nie ein Secret, nie ein PRESERVED_KEY,
 * nie eine `_FILE`-Variante oder eine von Hand ergänzte Zeile - und nur, wenn
 * derselbe Request keinen Wert dafür schickt (dann gewinnt der Wert). Alles
 * andere in `clear` wird stillschweigend ignoriert.
 */
export function clearableKeys(clear, written) {
  if (!Array.isArray(clear)) return new Set();
  return new Set(clear.filter(key => typeof key === 'string'
    && RERUN_PREFILL_KEYS.includes(key)
    && !PRESERVED_KEYS.includes(key)
    && !RERUN_SECRET_KEYS.includes(key)
    && !written[key]));
}

/**
 * Was der Wizard bei einem Rerun aus der bestehenden .env erfahren darf.
 *
 * `rerunValues`: die Werte der Allowlist RERUN_PREFILL_KEYS, sonst nichts - also
 * nie ein Secret, auch keins, dessen Name zufällig unauffällig ist.
 * `keptSecrets`: nur die NAMEN der Secrets, die in der Datei stehen. Damit kann
 * der Wizard "bestehender bleibt" anzeigen und Paarprüfungen (Client-ID ohne
 * Secret) bestehen lassen, ohne den Wert je zu sehen.
 */
export function rerunSnapshot(existingEnv) {
  const rerunValues = {};
  for (const key of RERUN_PREFILL_KEYS) {
    if (existingEnv[key]) rerunValues[key] = existingEnv[key];
  }
  const keptSecrets = RERUN_SECRET_KEYS.filter(key => secretInEnv(existingEnv, key));
  return { rerunValues, keptSecrets };
}

/** Steht `<NAME>_FILE` (server/utils/file-secrets.js) für dieses Secret in der .env? */
export function secretFromFile(existingEnv, key) {
  return FILE_SECRET_VARS.includes(key) && Boolean(existingEnv[`${key}_FILE`]);
}

/**
 * Ist dieses Secret in der .env eingerichtet - als Wert ODER als `<NAME>_FILE`?
 * Ein `GOOGLE_CLIENT_SECRET_FILE` zählte vorher nicht: der Wizard sah eine
 * Client-ID ohne Secret, die Paarprüfung blockierte den Rerun, und wer das
 * Secret dann eintippte, hatte beide Quellen gesetzt - applyFileSecrets()
 * bricht den App-Start in dem Fall ab. Bei SESSION_SECRET_FILE und
 * DB_ENCRYPTION_KEY_FILE erzeugte der Wizard sogar selbst einen zweiten Wert.
 * Gemeldet wird nur der Name, nie der Pfad.
 */
export function secretInEnv(existingEnv, key) {
  return Boolean(existingEnv[key]) || secretFromFile(existingEnv, key);
}

/**
 * Schnittstellen, über die ein Handy im Heimnetz den Host NICHT erreicht:
 * Container-Bridges (Docker, Podman, libvirt, LXC, Kubernetes-CNI), VMs und
 * VPN-Tunnel. Deren Adressen sind oft ebenfalls RFC 1918 (docker0 172.17.0.1,
 * WireGuard 10.x) und sähen sonst genauso gut aus wie das echte LAN.
 */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vnet|vmnet|vboxnet|vethernet|utun|tun|tap|wg|tailscale|zt|ppp|ipsec|cni|flannel|cali|cilium|lxc|lxd|podman|kube|awdl|llw|bridge|anpi|ap\d)/i;

/** Rang einer privaten IPv4: 192.168/16 vor 10/8 vor 172.16/12, sonst null. */
function privateRank(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  // 172.17.0.0/16 ist Dockers Standard-Bridge; heisst sie anders als docker0
  // (Rootless, umbenannt), soll sie trotzdem hinter allem anderen stehen.
  if (/^172\.17\./.test(address)) return 3;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return null;
}

/**
 * Die Adresse, unter der Handys und Tablets im Heimnetz diesen Rechner
 * erreichen - oder null.
 *
 * Der Einfach-Pfad schrieb BASE_URL=http://localhost:3000: Einladungs- und
 * Reset-Links zeigten damit auf das Gerät, auf dem man sie öffnet, und die
 * Fertig-Seite empfahl, die App "auf den Handys" zu installieren, die sie nie
 * erreichen konnten. Nur private IPv4 (RFC 1918), keine internen Adressen und
 * keine virtuellen Schnittstellen. `interfaces` ist injizierbar, damit die Wahl
 * ohne das Netz des Testrechners prüfbar ist.
 */
export function pickLanAddress(interfaces = networkInterfaces()) {
  let best = null;
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      const rank = privateRank(a.address);
      if (rank === null) continue;
      if (!best || rank < best.rank) best = { rank, address: a.address };
    }
  }
  return best ? best.address : null;
}

/**
 * Resolve true/false for whether a command can be spawned successfully.
 * Spawn errors (ENOENT) and non-zero exit codes both count as unavailable.
 */
export function commandAvailable(cmd, args = ['--version']) {
  return new Promise(resolvePromise => {
    let settled = false;
    const done = ok => { if (!settled) { settled = true; resolvePromise(ok); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      return done(false);
    }
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}

/**
 * Detect the available container engine, preferring Docker and falling back to
 * Podman (RHEL/Fedora/CentOS Stream). `check` is injectable for deterministic
 * tests. Returns a descriptor:
 *   { engine: 'docker'|'podman'|null,
 *     composeBin: 'docker'|'podman'|'podman-compose'|null,
 *     compose: string[]|null,   // leading args before the compose subcommand
 *     missing: string[] }       // human-readable list of absent prerequisites
 *
 * Podman uses the dedicated `podman-compose.yml` (SELinux `:Z` labels), so its
 * compose args carry `-f podman-compose.yml`. Docker keeps the default file.
 */
export async function detectEngine(check = commandAvailable) {
  if (await check('docker', ['--version']) && await check('docker', ['compose', 'version'])) {
    return { engine: 'docker', composeBin: 'docker', compose: ['compose'], missing: [] };
  }
  if (await check('podman', ['--version'])) {
    if (await check('podman', ['compose', 'version'])) {
      return { engine: 'podman', composeBin: 'podman', compose: ['compose', '-f', 'podman-compose.yml'], missing: [] };
    }
    if (await check('podman-compose', ['--version'])) {
      return { engine: 'podman', composeBin: 'podman-compose', compose: ['-f', 'podman-compose.yml'], missing: [] };
    }
    return { engine: null, composeBin: null, compose: null, missing: ['podman compose (oder podman-compose)'] };
  }
  return { engine: null, composeBin: null, compose: null, missing: ['docker', 'podman'] };
}

/**
 * Build a compose invocation for the detected engine.
 * docker: `docker compose <sub>`; podman: `podman compose -f podman-compose.yml
 * <sub>`; podman-compose: `podman-compose -f podman-compose.yml <sub>`.
 */
export function composeCommand(engine, subArgs = []) {
  return { cmd: engine.composeBin, args: [...(engine.compose || []), ...subArgs] };
}

/**
 * Build an inspect invocation. Uses the engine binary directly (`podman` even
 * when compose runs via `podman-compose`), since `docker`/`podman inspect`
 * share the same flags and Go templates.
 */
export function inspectCommand(engine, args = []) {
  return { cmd: engine.engine === 'docker' ? 'docker' : 'podman', args };
}

/**
 * Verify the installer's prerequisites (a usable container engine + compose).
 * `check` is injectable so the result is deterministically testable.
 * Returns { ok, missing, engine } where engine is the detectEngine descriptor.
 */
export async function checkPrereqs(check = commandAvailable) {
  const engine = await detectEngine(check);
  return { ok: engine.engine !== null, missing: engine.missing, engine };
}

// Memoized real-engine detection for the HTTP handlers (probes the host once).
// Tests call detectEngine/checkPrereqs directly with an injected check and never
// touch this cache.
let enginePromise = null;
function getEngine() {
  if (!enginePromise) enginePromise = detectEngine();
  return enginePromise;
}

/**
 * Spawn a detached process and resolve as soon as it has started (or failed
 * to start). Used for `docker compose up -d`: the 'spawn' event confirms the
 * launch without waiting for compose to finish; 'error' (e.g. ENOENT when
 * docker is missing) surfaces the failure to the caller instead of swallowing it.
 */
export function spawnStart(cmd, args, opts = {}, onOutput = null, onExit = null) {
  return new Promise(resolvePromise => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolvePromise(v); } };
    let child;
    try {
      // Ohne onOutput bleibt es bei 'ignore' wie bisher. Mit Callback werden
      // stdout/stderr mitgelesen: das ist die einzige Stelle, an der der
      // Fortschritt des Image-Pulls überhaupt entsteht - `up -d` läuft
      // detached weiter, während der Wizard pollt.
      const stdio = onOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore';
      child = spawn(cmd, args, { stdio, ...opts });
    } catch (err) {
      return done({ ok: false, error: err.message });
    }
    if (onOutput) {
      child.stdout?.on('data', d => onOutput(d.toString()));
      child.stderr?.on('data', d => onOutput(d.toString()));
    }
    child.on('error', err => done({ ok: false, error: err.message }));
    // Bewusst beim spawn-Event aufloesen, nicht beim Exit: `up -d` laeuft
    // detached weiter, waehrend das Image geladen wird, und der Request darf
    // darauf nicht warten. Der Exit-Code interessiert trotzdem - er ist das
    // einzige Signal dafuer, dass aus diesem Start kein Container mehr wird.
    //
    // 'close' statt 'exit': 'exit' feuert, sobald der Prozess endet, waehrend die
    // letzten stdout/stderr-Chunks noch unterwegs sein koennen. Der Wizard haette
    // dann einen Fehler-Exit-Code, aber die erklaerende Zeile stuende noch nicht im
    // Startprotokoll - "Erneut versuchen" ohne die Begruendung daneben. 'close'
    // feuert erst, wenn alle stdio-Streams zu sind, also nach dem letzten Chunk.
    child.on('close', code => onExit?.(code));
    child.on('spawn', () => done({ ok: true }));
  });
}

/**
 * Ringpuffer für die Ausgabe des laufenden `compose up -d`. Der Prozess ist
 * detached und lebt länger als der Request, der ihn gestartet hat; ohne diesen
 * Puffer bliebe der längste Moment der Installation (Image laden) ohne jede
 * Rückmeldung. Begrenzt, damit ein hängender Pull den Speicher nicht füllt.
 */
const START_LOG_LIMIT = 8000;
let startLog = '';
export function resetStartLog() { startLog = ''; startExit = null; }
export function getStartLog() { return startLog; }
function appendStartLog(chunk) {
  startLog = (startLog + chunk).slice(-START_LOG_LIMIT);
}

/**
 * Exit-Code des letzten `compose up -d`, oder null solange er laeuft.
 *
 * spawnStart loest beim spawn-Event auf, damit der Request nicht auf den
 * Image-Pull wartet. Damit war der Exit-Code aber niemandes Zustaendigkeit:
 * beendete sich der Befehl danach mit einem Fehler (belegter Port, Image nicht
 * gefunden, fehlende Rechte), sah /api/status weiterhin nur einen fehlenden
 * Container - und der galt als laufender Pull. Der Wizard drehte dann bis zum
 * 15-Minuten-Timeout, statt sofort „Erneut versuchen" anzubieten.
 */
let startExit = null;
export function getStartExit() { return startExit; }
function recordStartExit(code) { startExit = code; }

// Nur diese beiden Zustände sind endgültig. `created` und `restarting` sind
// Durchgangsstationen, und eine leere Ausgabe heisst „den Container gibt es noch
// gar nicht" - der Normalfall, solange `up -d` das Image lädt.
const DEAD_STATES = new Set(['exited', 'dead']);

/**
 * Verdikt aus dem Health-Check, oder null, wenn er keine Aussage trifft (kein
 * Healthcheck definiert, Container nicht vorhanden). Dann entscheidet der
 * Container-Zustand.
 * @returns {{ status: string, phase: string }|null}
 */
export function classifyHealth(healthCode, health) {
  if (healthCode !== 0) return null;
  if (health === 'healthy') return { status: 'running', phase: 'running' };
  if (health === 'starting' || health === 'unhealthy') return { status: 'starting', phase: 'health' };
  return null;
}

/**
 * Verdikt aus `{{.State.Status}}`.
 *
 * Eigene, reine Funktion, weil genau hier der teuerste Fehler des
 * Wartebildschirms sass: ein noch nicht existierender Container (leere Ausgabe)
 * galt als Fehlschlag. Bei jeder Erstinstallation über einer langsamen Leitung
 * sah der Nutzer „Container konnte nicht gestartet werden", während der Pull
 * ganz normal lief. Ohne Prozesse, damit dieser Fall auch auf einer Maschine
 * ohne Container-Engine prüfbar bleibt.
 * @returns {{ status: 'running'|'starting'|'error', phase: 'pull'|'boot' }}
 */
export function classifyContainerState(state, startExitCode = null) {
  if (!state) {
    // Kein Container. Solange `up -d` laeuft (startExitCode === null), ist das
    // der Normalfall waehrend des Pulls. Hat sich der Befehl dagegen schon mit
    // einem Fehler beendet, entsteht hier nie mehr ein Container - dann ist
    // Warten sinnlos und der Nutzer soll es sofort erfahren.
    if (startExitCode !== null && startExitCode !== 0) return { status: 'error', phase: 'boot' };
    return { status: 'starting', phase: 'pull' };
  }
  if (DEAD_STATES.has(state)) return { status: 'error', phase: 'boot' };
  return { status: 'starting', phase: 'boot' };
}

/**
 * spawn() that never throws synchronously.
 *
 * Without a container engine, detectEngine() reports `composeBin: null`, so
 * composeCommand() hands us `cmd: null` and node's normalizeSpawnArguments
 * throws a TypeError *synchronously*. An `.on('error')` handler cannot catch
 * that, and inside a child-process callback there is no try/catch above us
 * either - the throw escapes route() and kills the whole installer process.
 * That is worst for the users who have no engine, i.e. exactly the ones the
 * UI tells to "install it and reload the page".
 *
 * Returns a stand-in that emits 'error' asynchronously instead, so every call
 * site keeps its existing error path.
 */
export function safeSpawn(cmd, args, opts = {}) {
  try {
    return spawn(cmd, args, opts);
  } catch (err) {
    const stub = new EventEmitter();
    stub.stdout = new EventEmitter();
    stub.stderr = new EventEmitter();
    queueMicrotask(() => { stub.emit('error', err); stub.emit('close', null); });
    return stub;
  }
}

/** Obergrenze fuer die Container-Frage im Preflight. */
export const PREFLIGHT_PROBE_TIMEOUT_MS = 3000;

/**
 * Laeuft der yuvomi-Container? Mit Zeitlimit.
 *
 * Der Wizard wartet auf den Preflight, bevor er den Einfach-Pfad freigibt oder
 * Schluessel erzeugt. Engine-Erkennung und `inspect` fragen den Daemon, und
 * eine Engine, die nicht antwortet (Daemon haengt, entfernter Kontext), liess
 * die Antwort nie kommen - obwohl envExists laengst feststand. Nach dem Limit
 * gilt der Container als nicht laufend, und ein haengender Prozess wird
 * beendet. `resolveEngine` und `spawnFn` sind fuer Tests injizierbar.
 */
export async function probeContainerRunning({
  timeoutMs = PREFLIGHT_PROBE_TIMEOUT_MS,
  resolveEngine = getEngine,
  spawnFn = safeSpawn,
} = {}) {
  let timer;
  let child = null;
  let timedOut = false;
  const timeout = new Promise(done => {
    timer = setTimeout(() => { timedOut = true; done(false); }, timeoutMs);
  });
  const probe = (async () => {
    const engine = await resolveEngine();
    // Kam die Engine erst nach dem Zeitlimit, ist die Funktion schon zurueck und
    // ihr finally gelaufen: ein jetzt gestarteter inspect wuerde nie beendet.
    if (timedOut) return false;
    const { cmd, args } = inspectCommand(engine, ['inspect', '--format', '{{.State.Status}}', 'yuvomi']);
    return new Promise(done => {
      child = spawnFn(cmd, args, { stdio: 'pipe' });
      let out = '';
      let settled = false;
      const finish = running => { if (!settled) { settled = true; done(running); } };
      child.stdout?.on('data', d => { out += d.toString().trim(); });
      child.on('error', () => finish(false));
      child.on('close', code => finish(code === 0 && out === 'running'));
    });
  })().catch(() => false);
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* bereits beendet */ }
    }
  }
}

/**
 * Copy an existing .env to .env.bak-<ISO timestamp> before it is overwritten.
 * Returns the backup path, or null when there was nothing to back up.
 * Throws on copy failure so the caller can refuse to overwrite.
 */
export function backupEnvFile(envPath) {
  if (!existsSync(envPath)) return null;
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const backupPath = `${envPath}.bak-${stamp}`;
  copyFileSync(envPath, backupPath);
  return backupPath;
}

// Loopback hostnames the installer will answer state-changing requests for.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Guard state-changing POSTs against cross-site / DNS-rebinding abuse. The
 * installer binds to loopback, but a page the user visits while it runs could
 * still POST to 127.0.0.1:8090 (a "simple" request needs no CORS preflight) and
 * silently write .env, start the stack, or create the first admin. We require
 * both the Host and any Origin/Referer to be loopback: a rebinding attack sends
 * the attacker's domain in Origin (browsers always attach it to cross-origin
 * POSTs), and a rebound Host header is the attacker's name too. Tools like curl
 * (and the test suite) send no Origin and a loopback Host, so they pass.
 */
function isTrustedRequest(req) {
  const hostname = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const source = req.headers.origin || req.headers.referer;
  if (source) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(source).hostname)) return false;
    } catch {
      return false; // unparseable Origin/Referer - reject
    }
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Sicherheits-Header fuer JEDE Antwort. Der Installer zeigt Secrets (Session-
 * und Datenbankschluessel) im Klartext: keine Einbettung in fremde Seiten
 * (Clickjacking - X-Frame-Options fuer alte Browser, frame-ancestors fuer
 * neue), kein Referrer mit der Installer-Adresse an Dritte, kein MIME-Raten.
 * Bewusst KEINE script-src-Regel: install.html traegt sein Skript inline, eine
 * Skript-CSP braeche den Wizard (Critique 2026-10-29).
 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
});

/** Textformate, die sich lohnen zu komprimieren (HTML, JS, JSON, CSS). */
const COMPRESSIBLE = /^(?:text\/(?:html|javascript|css)|application\/json)\b/;
/** Darunter kostet die Kompression mehr, als sie spart (Status-Polling). */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Bevorzugte Kodierung aus Accept-Encoding: br vor gzip, `q=0` heisst nein.
 * Bis 2026-10-29 ging alles unkomprimiert raus - rund 520 kB je Aufruf, davon
 * 280 kB install.html (Critique 2026-10-29, Fast 4G).
 */
export function negotiateEncoding(acceptEncoding = '') {
  const offered = new Map();
  for (const part of String(acceptEncoding).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map(p => p.trim().match(/^q=([\d.]+)$/)).find(Boolean);
    offered.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const ok = name => (offered.has(name) ? offered.get(name) > 0 : (offered.get('*') ?? 0) > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/**
 * Eine Antwort senden, komprimiert, wenn Format, Groesse und Accept-Encoding
 * es hergeben. Die Anfrage kommt ueber res.req (Node setzt sie am Response).
 * Brotli auf Stufe 5 statt 11: der Installer liest seine Dateien je Aufruf
 * frisch (no-store), Stufe 11 kostete bei 280 kB spuerbar CPU je Laden.
 */
function send(res, status, headers, body) {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const out = { ...headers, 'Cache-Control': 'no-store' };
  if (COMPRESSIBLE.test(headers['Content-Type'] || '')) {
    out.Vary = 'Accept-Encoding';
    const encoding = payload.length >= COMPRESS_MIN_BYTES
      ? negotiateEncoding(res.req?.headers?.['accept-encoding'])
      : null;
    if (encoding === 'br') {
      payload = brotliCompressSync(payload, { params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: payload.length,
      } });
      out['Content-Encoding'] = 'br';
    } else if (encoding === 'gzip') {
      payload = gzipSync(payload, { level: 6 });
      out['Content-Encoding'] = 'gzip';
    }
  }
  out['Content-Length'] = payload.length;
  res.writeHead(status, out);
  res.end(payload);
}

function json(res, status, body) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(body));
}

/**
 * Serve a read-only file from the repo's public/ tree so the installer can
 * reuse the app's design tokens and fonts. Missing files yield a 404 instead
 * of throwing, keeping the route handler exception-free.
 */
function serveStatic(res, filePath, contentType) {
  let body;
  try {
    body = readFileSync(filePath);
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
  send(res, 200, { 'Content-Type': contentType }, body);
}


async function route(req, res, server) {
  resetIdle(server);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Jeder API-Zugriff muss von der Loopback-Installerseite kommen, nicht nur der
  // schreibende: /api/status hat den Prozess beendet, und ein GET darauf kann
  // jede beliebige Seite absetzen, die der Nutzer während der Installation
  // offen hat. Die statische Auslieferung (/, tokens.css, Fonts) bleibt frei,
  // sonst scheiterte schon der erste Seitenaufruf.
  if ((req.method === 'POST' || url.pathname.startsWith('/api/')) && !isTrustedRequest(req)) {
    return json(res, 403, { error: 'Cross-origin request rejected' });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, readFileSync(resolve(__dirname, 'install.html')));
  }

  // Das App-Icon als Favicon. Ohne die Route fragte jeder Browser /favicon.ico
  // an und bekam 404 - ein roter Eintrag in der Konsole bei jedem Laden, und
  // im Tab stand kein Zeichen (Critique 2026-10-29). Dieselbe Datei wie die
  // App (public/favicon.ico), read-only wie tokens.css.
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    return serveStatic(res, resolve(projectRoot(), 'public', 'favicon.ico'), 'image/x-icon');
  }

  // App-Designtokens, read-only aus dem Repo (Phase 3: Token-Angleich).
  if (req.method === 'GET' && url.pathname === '/tokens.css') {
    return serveStatic(res, resolve(projectRoot(), 'public', 'styles', 'tokens.css'), 'text/css; charset=utf-8');
  }

  // HIER STAND EINE /fonts/-ROUTE. Sie lieferte Plus Jakarta Sans aus
  // public/fonts, damit der Installer dieselbe Schrift trug wie die App. Mit dem
  // HIG-Redesign ist die Schrift aus der App gefallen: public/ enthaelt kein
  // @font-face mehr, weder sw.js noch das Manifest nennen die Dateien, und der
  // Installer nimmt seit v2.0.0 den System-Stack. Uebrig war eine Route auf zwei
  // Binaerdateien, die niemand anforderte - und ein Test, der ihr 200 zusicherte.
  //
  // Die Dateien sind mitentfallen. Wer die Route zurueckholt, braucht wieder
  // beides: eine Schrift, die die App auch benutzt, und einen Grund.

  // i18n-Mini-Modul des Installers (Phase 4: i18n-Verdrahtung).
  if (req.method === 'GET' && url.pathname === '/i18n-mini.js') {
    return serveStatic(res, resolve(__dirname, 'i18n-mini.js'), 'text/javascript; charset=utf-8');
  }

  // Vorbelegung beim Rerun (reine Funktionen, siehe rerun-prefill.js).
  if (req.method === 'GET' && url.pathname === '/rerun-prefill.js') {
    return serveStatic(res, resolve(__dirname, 'rerun-prefill.js'), 'text/javascript; charset=utf-8');
  }

  // Feldpruefungen, die eine Server-Regel spiegeln (siehe field-checks.js).
  if (req.method === 'GET' && url.pathname === '/field-checks.js') {
    return serveStatic(res, resolve(__dirname, 'field-checks.js'), 'text/javascript; charset=utf-8');
  }

  // Installer-Locale-Dateien. basename() neutralisiert Path-Traversal;
  // nur .json aus tools/installer/locales wird ausgeliefert.
  if (req.method === 'GET' && url.pathname.startsWith('/locales/') && url.pathname.endsWith('.json')) {
    const name = basename(url.pathname);
    return serveStatic(res, resolve(__dirname, 'locales', name), 'application/json; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/defaults') {
    return json(res, 200, { catalog: ENV_SCHEMA });
  }

  if (req.method === 'POST' && url.pathname === '/api/generate-secret') {
    return json(res, 200, { secret: randomBytes(32).toString('hex') });
  }

  if (req.method === 'GET' && url.pathname === '/api/prereqs') {
    try {
      return json(res, 200, await checkPrereqs());
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/preflight') {
    try {
      const existingEnv = readEnvFile(resolve(projectRoot(), '.env'));
      const envExists = existsSync(resolve(projectRoot(), '.env'));
      // Nur die NAMEN der vorhandenen Schlüssel - die Werte bleiben auf dem
      // Server. Das Frontend erzeugt für diese keinen neuen Wert mehr.
      const preservedKeys = PRESERVED_KEYS.filter(key => secretInEnv(existingEnv, key));
      // Die nicht geheimen Werte (Allowlist) für die Vorbelegung, von den
      // Secrets nur die Namen - siehe rerunSnapshot().
      const { rerunValues, keptSecrets } = rerunSnapshot(existingEnv);
      // Mit Zeitlimit: der Wizard wartet auf diese Antwort (siehe probeContainerRunning).
      const containerRunning = await probeContainerRunning();
      return json(res, 200, { envExists, preservedKeys, rerunValues, keptSecrets, containerRunning });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  /**
   * Die tatsächlich geschriebene .env zum Herunterladen.
   *
   * Die Abschlussseite baute ihre Kopie aus dem Browser-Zustand
   * (`renderEnvClient(buildEnv())`). Seit der Server beim Rerun bewahrt, was der
   * Client nicht schickt, ist dieser Zustand die falsche Quelle: der Download
   * enthielt weder die übernommenen Schlüssel noch die beiden bewahrten Secrets,
   * die der Wizard bewusst nie zu sehen bekommt. Wer die Datei als Sicherung
   * beiseitelegte und später zurückspielte, warf damit genau das weg, was der
   * Rerun gerettet hatte - und die Sicherung der einzigen
   * Verschlüsselungsschlüssel war gar keine.
   *
   * Die Secrets verlassen den Server damit nur auf ausdrückliche Anforderung
   * und über dieselbe Loopback-Schranke wie jede andere API-Route; in den
   * JS-Zustand der Seite gelangen sie weiterhin nicht.
   */
  // Die Heimnetz-Adresse fuer den Einfach-Pfad (siehe pickLanAddress). Der
  // Installer selbst lauscht weiter nur auf 127.0.0.1; die App-Container binden
  // per Compose auf 0.0.0.0 und sind damit unter dieser Adresse erreichbar.
  if (req.method === 'GET' && url.pathname === '/api/lan-address') {
    return json(res, 200, { address: pickLanAddress() });
  }

  if (req.method === 'GET' && url.pathname === '/api/env-file') {
    try {
      const envPath = resolve(projectRoot(), '.env');
      if (!existsSync(envPath)) return json(res, 404, { error: '.env not found' });
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename=".env"',
        'Cache-Control': 'no-store',
      });
      return res.end(readFileSync(envPath, 'utf8'));
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/save-env') {
    try {
      const body = await readBody(req);
      const result = sanitizeEnv(body.env);
      if (!result.ok) return json(res, 400, { error: result.error });

      const envPath = resolve(projectRoot(), '.env');

      // Letzte Instanz gegen den zerstörerischen Rerun. Das war eine Allowlist
      // aus zwei Schlüsseln, und damit deckte sie zwei Schlüssel ab statt der
      // Regel: die Datei wird komplett neu geschrieben, sanitizeEnv verwirft
      // leere Werte, und der Wizard startet JEDES Feld leer (er lädt bestehende
      // Werte nie nach). Ein Rerun löschte deshalb alles ausser den beiden
      // Secrets - gemessen 7 von 10 Schlüsseln, darunter DATA_DIR mit dem
      // Datenbankpfad, EMAIL_SMTP_PASS, OIDC_ISSUER und BASE_URL. Die
      // Installation lief danach mit Standardpfad weiter und sah aus, als wären
      // die Daten weg.
      //
      // Die Regel: was der Client nicht mit einem nicht-leeren Wert schickt,
      // bleibt stehen. Auch Schlüssel ausserhalb des Schemas (LOG_LEVEL,
      // OPENWEATHER_*, von Hand ergänzte) - der Installer ist ein
      // Einrichtungswerkzeug und darf keine Zeile verlieren, die er nicht
      // versteht. Dasselbe leistet preserve_unmanaged() in install.sh.
      //
      // Leer heisst deshalb "nicht anfassen", nie "löschen". Seit der Wizard
      // seine Felder beim Rerun mit dem Bestand vorbelegt, SIEHT der Nutzer
      // den Wert aber - und wer ein vorbelegtes Feld leert, will ihn weg haben.
      // Das sagt der Client ausdrücklich mit `clear: [KEY, ...]`
      // (clearedKeys in rerun-prefill.js); entfernt werden nur diese Zeilen,
      // und nur aus der Allowlist (clearableKeys). Ein leeres Feld OHNE
      // Eintrag in `clear` bleibt "nicht anfassen".
      // ... und zwar VERBATIM, nicht ueber readEnvFile geparst und neu
      // gerendert. Ein `EMAIL_SMTP_PASS='a b'` oder ein
      // `DATA_DIR=./data # storage` ist gueltige Compose-Syntax; jede
      // Abweichung zwischen decodeEnvValue und Compose kaeme beim Rendern als
      // anderer Wert zurueck - der Rerun haette still das Passwort geaendert
      // oder ein anderes Verzeichnis gemountet. Der Wizard laesst deshalb auch
      // unveraendert vorbelegte Werte aus dem Request (omitUnchanged in
      // rerun-prefill.js), damit ihre Originalzeile hier ueberlebt.
      //
      // Ein Secret, das die .env per `<NAME>_FILE` bezieht, schreibt der
      // Installer nicht zusaetzlich als Klartext: beide Quellen zugleich lehnt
      // applyFileSecrets() beim App-Start ab. Die Datei-Variante bleibt.
      const existingEnv = readEnvFile(envPath);
      for (const key of FILE_SECRET_VARS) {
        if (result.env[key] && secretFromFile(existingEnv, key) && !result.env[`${key}_FILE`]) {
          delete result.env[key];
        }
      }
      const cleared = clearableKeys(body.clear, result.env);
      const preserved = preserveUnmanagedLines(envPath, result.env, cleared);

      let backup = null;
      try {
        backup = backupEnvFile(envPath);
      } catch (err) {
        // Refuse to overwrite if we cannot secure a backup first.
        return json(res, 500, { error: `Could not back up existing .env: ${err.message}` });
      }

      const rendered = renderEnvFile(result.env);
      writeFileSync(
        envPath,
        preserved.length
          ? `${rendered}\n# Carried over from the previous .env\n${preserved.join('\n')}\n`
          : rendered,
        'utf8',
      );
      return json(res, 200, { ok: true, backup, path: envPath });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    try {
      const engine = await getEngine();
      const { cmd, args } = composeCommand(engine, ['up', '-d']);
      resetStartLog();
      const result = await spawnStart(cmd, args, { cwd: projectRoot() }, appendStartLog, recordStartExit);
      if (!result.ok) console.error(`${cmd} compose error:`, result.error);
      return json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const engine = await getEngine();
    // Ohne Engine gibt es keinen Container, dessen Status man abfragen könnte,
    // und composeCommand() lieferte hier `cmd: null`. Früh und ehrlich
    // antworten, statt einen Spawn zu versuchen, den es nicht geben kann.
    if (!engine.engine) {
      return json(res, 200, { status: 'error', phase: 'engine', logs: `Missing: ${engine.missing.join(', ')}` });
    }
    const health = inspectCommand(engine, ['inspect', '--format', '{{.State.Health.Status}}', 'yuvomi']);
    const stateCmd = inspectCommand(engine, ['inspect', '--format', '{{.State.Status}}', 'yuvomi']);
    const logsCmd = composeCommand(engine, ['logs', '--tail', '30']);
    return new Promise(resolvePromise => {
      let settled = false;
      const reply = payload => { if (!settled) { settled = true; resolvePromise(json(res, 200, payload)); } };
      // A spawn 'error' (engine binary vanished mid-poll) fires on an
      // EventEmitter that would otherwise throw and crash the process outside
      // route()'s catch. Treat any spawn failure here as a transient "starting".
      const onSpawnError = () => reply({ status: 'starting', phase: 'pull', logs: getStartLog() });
      const inspect = safeSpawn(health.cmd, health.args, { stdio: 'pipe' });
      let out = '';
      inspect.on('error', onSpawnError);
      inspect.stdout.on('data', d => { out += d.toString().trim(); });
      inspect.on('close', code => {
        const byHealth = classifyHealth(code, out);
        if (byHealth?.status === 'running') return reply(byHealth);
        if (byHealth) return reply({ ...byHealth, logs: getStartLog() });
        const state = safeSpawn(stateCmd.cmd, stateCmd.args, { stdio: 'pipe' });
        let stateOut = '';
        state.on('error', onSpawnError);
        state.stdout.on('data', d => { stateOut += d.toString().trim(); });
        state.on('close', () => {
          const verdict = classifyContainerState(stateOut, getStartExit());
          if (verdict.status !== 'error') return reply({ ...verdict, logs: getStartLog() });
          const logs = safeSpawn(logsCmd.cmd, logsCmd.args, { cwd: projectRoot(), stdio: 'pipe' });
          let logsOut = '';
          logs.on('error', () => reply({ ...verdict, logs: 'Container engine unavailable.' }));
          logs.stdout.on('data', d => { logsOut += d.toString(); });
          logs.stderr.on('data', d => { logsOut += d.toString(); });
          logs.on('close', () => reply({ ...verdict, logs: logsOut || getStartLog() }));
        });
      });
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/create-admin') {
    try {
      const body = await readBody(req);
      // Pin the proxy target to a valid port; ignore anything else the client sends.
      const oikosPort = Number.isInteger(body.port) && body.port > 0 && body.port < 65536
        ? body.port : 3000;
      const account = {
        username: body.username,
        display_name: body.display_name,
        password: body.password,
      };
      const language = setupLanguage(body.language);
      let result = await postSetup(oikosPort, language ? { ...account, language } : account);
      // Ein Image, das `language` noch gar nicht kennt, ignoriert das Feld (die
      // Route verwirft unbekannte Felder). Ein 400 mit Sprache heisst also: das
      // Image kennt das Feld, aber nicht DIESEN Code. Das darf die Kontoanlage
      // nicht kosten - einmal ohne Sprache wiederholen, sie ist in der App
      // nachtraeglich einstellbar. Absichtlich an jedem 400 und nicht am Text
      // der Meldung: aendert sich deren Wortlaut, bliebe der Nutzer sonst ohne
      // Admin-Konto stehen. Ein 400 aus anderem Grund (Name, Passwort) kommt
      // beim zweiten Versuch unveraendert zurueck, und der ist dann die Antwort.
      if (result.status === 400 && language) {
        console.log(`Setup did not accept language "${language}" - retrying without it.`);
        result = await postSetup(oikosPort, account);
      }

      json(res, result.status, result.body);

      // 404 gehoert dazu: /auth/setup antwortet bei bereits vorhandenem Konto
      // in production mit 404 und nur ausserhalb davon mit 403 (server/auth.js).
      // Jedes reale Deployment setzt NODE_ENV=production, der 403-Zweig war hier
      // also toter Code - und ein Rerun beendete den Installer nie, weil dieser
      // Block nicht lief.
      if (result.status === 201 || result.status === 403 || result.status === 404) {
        // Nicht sofort schliessen: die Abschlussseite bietet den Download der
        // .env an, und der holt die Datei von hier. Ab jetzt gilt der kurze
        // Nachlauf, den jeder weitere Request verlaengert.
        console.log('\nSetup complete - installer will shut down once idle.');
        beginPostSetupShutdown();
        resetIdle(server);
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
}

/**
 * Ein POST an /api/v1/auth/setup der frisch gestarteten App. Loggt nichts vom
 * Body: darin stehen Benutzername und Passwort des ersten Admins.
 */
function postSetup(port, account) {
  const payload = JSON.stringify(account);
  return new Promise((resolvePromise, reject) => {
    const opts = {
      hostname: 'localhost', port,
      path: '/api/v1/auth/setup', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const proxyReq = http.request(opts, proxyRes => {
      let data = '';
      proxyRes.on('data', d => { data += d; });
      proxyRes.on('end', () => {
        try { resolvePromise({ status: proxyRes.statusCode, body: JSON.parse(data) }); }
        catch { resolvePromise({ status: proxyRes.statusCode, body: { error: 'Invalid response from Yuvomi' } }); }
      });
    });
    proxyReq.on('error', reject);
    proxyReq.write(payload);
    proxyReq.end();
  });
}

export function createInstallerServer() {
  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    route(req, res, server).catch(err => json(res, 500, { error: err.message }));
  });
  return server;
}

// Only start listening when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Letztes Netz: ein Wurf aus einem Kind-Prozess-Callback liegt ausserhalb
  // jedes try/catch und beendete den Installer mitten in der Einrichtung. Der
  // Nutzer verlöre damit den Wizard und sähe nur noch eine tote Seite.
  // Lieber weiterlaufen und den Fehler sichtbar machen.
  process.on('uncaughtException', err => {
    console.error('Installer server error (kept running):', err);
  });
  const server = createInstallerServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Yuvomi Web Installer`);
    console.log(`  Open: http://localhost:${PORT}\n`);
    resetIdle(server);
  });
}
