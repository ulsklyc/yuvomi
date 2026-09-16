/**
 * Modul: Display-Konten (#1208, entschieden in #913)
 * Zweck: Ein Wandtablett bekommt ein Konto, das nur ein gekoppeltes GERAET
 *        benutzen kann - kein Passwort, kein SSO, keine Sitzung, kein zweiter
 *        Faktor. Diese Datei haelt die drei Geheimnisse und die eine
 *        Scope-Liste, die daran haengt.
 * Abhaengigkeiten: node:crypto, server/db.js (synchroner Treiber - kein `await`
 *        vor DB-Calls).
 *
 * WARUM KEIN NORMALES KONTO. Eine Sitzung endet nach sieben Tagen, also tippte
 * jemand regelmaessig ein Passwort auf ein Geraet, das an der Wand haengt - und
 * dieses Passwort ist das wertvollste, was auf dem Tablett liegt. In einem
 * Haushalt, der nur per SSO anmeldet, koennte so ein Konto gar nicht erst
 * existieren. Und ein zweiter Faktor auf einem Geraet, von dem sich nie jemand
 * abmeldet, schuetzt nichts.
 *
 * WARUM KEINE express-SESSION, SONDERN EIN EIGENES COOKIE. Eine Sitzung ist der
 * Zustand eines angemeldeten Menschen: sie traegt `userId`, sie geht durch
 * `setupAuthSession()`, sie kennt einen Wartezustand fuer den zweiten Faktor,
 * und sie laeuft ab. Nichts davon passt auf ein Geraet. Ein eigenes Cookie
 * laesst die gesamte Anmelde-Maschinerie unberuehrt - `canSignIn`, 2FA, der
 * Sitzungs-Store sehen ein Display nie - und der Preis dafuer ist genau ein
 * zusaetzlicher Zweig in `requireAuth()`.
 *
 * WARUM DREI GEHEIMNISSE UND ZWEI TABELLEN. Der Kopplungscode ist kurz, gilt
 * kurz und genau einmal; das Credential ist lang und gilt, bis es jemand
 * widerruft. Beide werden GEHASHT gespeichert: wer die Datenbank liest, soll
 * sich kein Tablett bauen koennen. Der Klartext existiert jeweils genau einmal,
 * in der Antwort, die ihn erzeugt hat.
 */

import crypto from 'node:crypto';
import * as dbModule from '../db.js';

// Die reinen Listen liegen in server/display-scopes.js - OHNE Abhaengigkeiten,
// damit server/permissions.js sie lesen kann, ohne ueber diese Datei
// server/db.js mitzuziehen (genau daran hing test:db-isolation: vier Suiten
// legten eine echte yuvomi.db im Repo an, weil sie nur Rechte aufloesten).
// Hier durchgereicht, damit die Aufrufer eine Anlaufstelle behalten.
export {
  DISPLAY_SCOPES, DISPLAY_SCOPE_MODULES, DISPLAY_READ_PATHS, displayMayRead,
} from '../display-scopes.js';

/**
 * Cookie-Name des Geraete-Credentials.
 *
 * `oikos` steht hier bewusst NICHT: das Praefix bleibt nur, wo
 * Bestandsinstallationen daran haengen (Image, Volume, Quadlet, der alte
 * Sitzungs-Cookie-Name). Dieses Cookie ist neu, es gibt keinen Bestand, und ein
 * Alt-Name waere eine Schuld, die nie jemand eingegangen ist.
 */
export const DISPLAY_COOKIE = 'yuvomi.display';

/** Praefix des Klartext-Credentials - macht einen Fund in einem Log erkennbar. */
const DEVICE_TOKEN_PREFIX = 'yuvomi_display_';

/**
 * Der Platzhalter im Passwortfeld. `users.password_hash` ist NOT NULL, und ein
 * Konto ohne Passwort ist in diesem Schema schon einmal beantwortet worden:
 * SSO-Konten tragen `$oidc$` (services/oidc.js). Ein Display traegt sein eigenes
 * Zeichen aus demselben Grund und mit derselben Wirkung - kein Passwort-Hash
 * dieser Welt vergleicht sich erfolgreich dagegen.
 */
export const DISPLAY_PASSWORD_SENTINEL = '$display$';

/**
 * Das Alphabet des Kopplungscodes: Grossbuchstaben und Ziffern OHNE die Paare,
 * die auf einem Bildschirm gleich aussehen (0/O, 1/I/L, 8/B, 5/S, 2/Z). Wer den
 * Code von einem Laptop abliest und auf einer Bildschirmtastatur eintippt, soll
 * nicht an der Schriftart scheitern.
 */
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const CODE_LENGTH = 10;

/** Wie lange ein Kopplungscode gilt. Kurz, weil er fuer seine Lebensdauer einem
 *  Credential gleichkommt: wer ihn liest, koppelt sein eigenes Geraet. */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/** sha256, wie bei den API-Tokens - dasselbe Verfahren fuer dieselbe Art Geheimnis. */
function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Ein Kopplungscode in Klartext.
 *
 * `randomInt` statt `randomBytes() % alphabet.length`: der Modulo-Weg bevorzugt
 * die vorderen Zeichen des Alphabets, weil 256 kein Vielfaches von 25 ist. Bei
 * zehn Stellen ist der Unterschied klein, aber er ist umsonst zu vermeiden.
 */
export function generatePairingCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Die Schreibweise, in der ein Code verglichen wird.
 *
 * Ein Mensch tippt ihn ab, also fallen Leerzeichen und Bindestriche weg (die
 * Anzeige gruppiert ihn zur Lesbarkeit) und Kleinbuchstaben werden gross. Ohne
 * das scheitert die Kopplung an einer Autokorrektur, und der Fehler saehe aus
 * wie ein falscher Code.
 */
export function normalizePairingCode(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Das Geraete-Credential aus dem Cookie-Header eines Requests.
 *
 * VON HAND GEPARST, WEIL DAS PROJEKT KEINEN cookie-parser HAT und ein
 * Fremdpaket fuer eine Zeile Zeichenkettenarbeit die falsche Rechnung waere
 * (Frameworkfreiheit als Dauerentscheidung, CONTRIBUTING.md). express-session
 * parst sein eigenes Cookie selbst, die CSRF-Pruefung vergleicht gegen die
 * Sitzung - es gibt im Haus schlicht keinen fertigen Leser, den man teilen
 * koennte.
 *
 * Die Aufteilung ist bewusst streng: nur das erste `=` trennt Name und Wert,
 * denn base64url endet auf keinem `=`, aber ein fremdes Cookie darf eines
 * enthalten, ohne diesen Leser durcheinanderzubringen.
 */
export function displayTokenFromRequest(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== DISPLAY_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/** Ist diese users-Zeile ein Display? */
export function isDisplayAccount(userId, { db } = {}) {
  const database = db || dbModule.get();
  return Boolean(database.prepare('SELECT 1 FROM display_accounts WHERE user_id = ?').get(userId));
}

/**
 * Einen Kopplungscode fuer ein Display ausstellen.
 *
 * DER VORHERIGE CODE VERFAELLT DABEI. Zwei offene Codes fuer dasselbe Display
 * waeren zwei Schluessel fuer dieselbe Tuer, und der aeltere haenge unbemerkt in
 * der Welt - ein Administrator, der auf „neuen Code" tippt, weil der alte
 * verlorenging, erwartet genau das Gegenteil.
 *
 * @returns {{ code: string, expiresAt: string }} der Klartext, genau einmal
 */
export function issuePairingCode(userId, createdBy, { db } = {}) {
  const database = db || dbModule.get();
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  database.transaction(() => {
    database.prepare(`
      UPDATE display_pairing_codes SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL
    `).run(nowIso(), userId);
    database.prepare(`
      INSERT INTO display_pairing_codes (user_id, code_hash, expires_at, created_by)
      VALUES (?, ?, ?, ?)
    `).run(userId, hash(code), expiresAt, createdBy || null);
  })();
  return { code, expiresAt };
}

/**
 * Einen Kopplungscode gegen ein Geraete-Credential tauschen.
 *
 * DIE PRUEFUNG UND DAS ENTWERTEN SIND EINE EINHEIT. Beide stehen in derselben
 * Transaktion, und was den Doppeleinsatz tatsaechlich verhindert, ist der
 * synchrone Treiber: zwischen Lesen und Schreiben liegt kein Yield-Punkt, an
 * dem ein zweiter Request dazwischenkaeme (CLAUDE.md, kein `await` vor
 * DB-Calls).
 *
 * `spent.changes !== 1` ist deshalb KEIN Riegel, sondern eine Behauptung ueber
 * die Zeile darueber - und sie ist als solche gekennzeichnet, weil keine
 * Messung sie rot bekommt (per Mutation geprueft). Sie bleibt trotzdem stehen:
 * sie kostet nichts und faellt laut aus, sollte das SELECT je aus dieser
 * Transaktion wandern. Was die Einmaligkeit BELEGT, ist der Test, der denselben
 * Code zweimal einloest.
 *
 * @returns {{ token: string, deviceId: number, userId: number }|null} null, wenn
 *          der Code unbekannt, abgelaufen oder schon benutzt ist - EIN Ergebnis
 *          fuer alle drei, damit die Antwort nicht verraet, welcher Fall vorlag.
 */
export function redeemPairingCode(rawCode, { label = null, db } = {}) {
  const database = db || dbModule.get();
  const code = normalizePairingCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;

  const token = DEVICE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  let result = null;

  database.transaction(() => {
    const now = nowIso();
    const row = database.prepare(`
      SELECT id, user_id FROM display_pairing_codes
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(hash(code), now);
    if (!row) return;

    const spent = database.prepare(
      'UPDATE display_pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
    ).run(now, row.id);
    if (spent.changes !== 1) return;

    // EIN DISPLAY, EIN GERAET. Ein neuer Kopplungsvorgang widerruft das alte
    // Credential, statt ein zweites danebenzustellen: sonst bliebe das Tablett,
    // das jemand gerade ersetzt hat, still gueltig - und „zuletzt gesehen"
    // zeigte zwei Zeilen fuer ein Geraet, von dem nur eines an der Wand haengt.
    database.prepare(
      'UPDATE display_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).run(now, row.user_id);

    const ins = database.prepare(
      'INSERT INTO display_devices (user_id, token_hash, label) VALUES (?, ?, ?)',
    ).run(row.user_id, hash(token), label || null);
    result = { token, deviceId: Number(ins.lastInsertRowid), userId: row.user_id };
  })();

  return result;
}

/**
 * Das Credential eines Requests aufloesen.
 *
 * `last_seen_at` WIRD HIER GESCHRIEBEN, und zwar bei jedem Request. Es ist die
 * einzige Auskunft, auf die ein Widerruf sich stuetzen kann: „welches Tablett
 * ist das eigentlich" beantwortet niemand aus einem Namen, den ein Mensch vor
 * Monaten vergeben hat. Die Schreiblast ist eine UPDATE-Zeile auf einem
 * eindeutigen Index, dieselbe, die `api_tokens.last_used_at` schon traegt.
 *
 * @returns {{ userId: number, deviceId: number }|null}
 */
export function authenticateDisplayDevice(token, { db } = {}) {
  if (!token || typeof token !== 'string') return null;
  const database = db || dbModule.get();
  const row = database.prepare(`
    SELECT d.id, d.user_id
      FROM display_devices d
      JOIN display_accounts da ON da.user_id = d.user_id
     WHERE d.token_hash = ? AND d.revoked_at IS NULL
  `).get(hash(token));
  if (!row) return null;
  database.prepare('UPDATE display_devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { userId: row.user_id, deviceId: row.id };
}

/**
 * Ein Geraet widerrufen. Setzt `revoked_at`, es loescht nichts - dieselbe Regel
 * wie beim API-Token, damit ein Widerruf nachweisbar bleibt. Idempotent ueber
 * `COALESCE`: zweimal widerrufen verschiebt den Zeitpunkt nicht.
 */
export function revokeDisplayDevice(deviceId, { db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(
    'UPDATE display_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?',
  ).run(nowIso(), deviceId).changes > 0;
}

/** Die Geraete eines Displays, neueste zuerst - ohne jedes Geheimnis. */
export function listDisplayDevices(userId, { db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(`
    SELECT id, label, last_seen_at, revoked_at, created_at
      FROM display_devices WHERE user_id = ?
     ORDER BY id DESC
  `).all(userId);
}
