/**
 * Modul: Gravatar-Import fuer das Profilbild
 * Zweck: EIN Abruf auf Klick des Mitglieds ("Mein Gravatar verwenden" unter
 *        Einstellungen -> Konto): das Bild, das gravatar.com fuer die gespeicherte
 *        Adresse fuehrt, wird einmal geholt und wie ein Upload in
 *        `users.avatar_data` abgelegt. Danach wird nichts mehr nachgeladen -
 *        kein Scheduler, kein Abruf beim Login, kein Hotlinking (die CSP laesst
 *        fuer Bilder nur 'self' und data: zu).
 *
 * WAS DEN SERVER VERLAESST: der SHA-256-Hash der getrimmten, ASCII-klein
 * geschriebenen Adresse (derselbe Schluessel wie beim E-Mail-Abgleich,
 * `emailMatchKey()`), die IP dieses Servers und der User-Agent aus
 * server/utils/http.js. Nie die Adresse selbst, nie der Name.
 *
 * AUS, SOLANGE GRAVATAR_BASE_URL NICHT GESETZT IST: dann geht nichts hinaus,
 * und die Kontoseite zeigt weder Knopf noch Hinweis (gravatarEnabled()).
 *
 * WARUM DIESELBE HAERTUNG WIE BEI DER ABO-LOGO-SUCHE: das Ziel waehlt der
 * Betreiber per GRAVATAR_BASE_URL (gravatar.com oder ein Libravatar-Spiegel) -
 * und ein Spiegel kann umleiten. Deshalb laeuft
 * der Abruf durch safeRequest() mit dem Anti-Rebinding-Lookup aus ssrf.js,
 * mit Timeout, mit Groessengrenze und mit Signaturpruefung des Inhalts: ein
 * `Content-Type: image/png` aus einer fremden Antwort beweist nichts.
 *
 * Abhaengigkeiten: node:crypto, server/utils/http.js, server/utils/ssrf.js,
 *                  server/utils/file-signature.js, server/utils/email-match.js
 */

import crypto from 'node:crypto';
import { safeRequest } from '../utils/http.js';
import { createGuardedLookup, isBlockedHostname } from '../utils/ssrf.js';
import { contentMatchesMime } from '../utils/file-signature.js';
import { emailMatchKey } from '../utils/email-match.js';

export const DEFAULT_GRAVATAR_SIZE = 256;
// 512 KiB. Ein 256px-Avatar liegt weit darunter; die Grenze ist eine
// Prozessgrenze gegen einen Spiegel, der etwas anderes liefert. Als data-URL
// (Base64, Faktor 4/3) bleibt sie unter MAX_AVATAR_DATA_LENGTH in server/auth.js,
// sonst lehnte normalizeAvatarData() ab, was hier gerade durchgelassen wurde.
export const MAX_GRAVATAR_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
// Dieselben drei Typen, die normalizeAvatarData() fuer einen Upload zulaesst -
// und fuer jeden kennt server/utils/file-signature.js eine Signatur, es gibt
// also keinen Typ, der "ungeprueft" passierte.
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Ein Fehler mit maschinenlesbarem Grund (snake_case) fuer die Route und die
 * Oberflaeche. Die Meldung ist fuer Menschen und nennt nie den Hash, die
 * Basis-URL oder einen Serverpfad.
 */
export class GravatarError extends Error {
  constructor(reason, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GravatarError';
    this.reason = reason;
  }
}

/**
 * Die konfigurierte Basis-URL, getrimmt. Nicht gesetzt oder leer -> '' -> die
 * Funktion ist AUS. Es gibt keinen eingebauten Default: ein Abruf bei einem
 * oeffentlichen Dienst mit einem stabilen Kennzeichen einer Person kann nicht
 * die Voreinstellung sein (docs/SCOPE.md, Geocoder-Eintrag und #656) - der
 * Betreiber schaltet ihn ein, indem er die Variable setzt (gravatar.com oder
 * ein Libravatar-Spiegel). Zur Laufzeit gelesen, damit Tests process.env vor
 * dem Aufruf setzen koennen (wie readPrivateNetworkOptIn).
 */
export function gravatarBaseUrl(env = process.env) {
  const raw = env.GRAVATAR_BASE_URL;
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

/**
 * Ist der Import eingeschaltet? Genau dann, wenn GRAVATAR_BASE_URL einen
 * nicht leeren Wert traegt. Ein gesetzter, aber falscher Wert zaehlt als
 * eingeschaltet: der Betreiber wollte die Funktion, und der Fehler soll laut
 * werden (500 gravatar_bad_base_url im Log), nicht als "aus" verschwinden.
 * Die Route fragt hier zuerst, GET /auth/me reicht die Antwort als
 * `gravatarAvailable` an die Kontoseite - nie die URL selbst.
 */
export function gravatarEnabled(env = process.env) {
  return gravatarBaseUrl(env) !== '';
}

/**
 * SHA-256 (hex) des Vergleichsschluessels der Adresse - getrimmt, nur A-Z
 * klein geschrieben. Gravatar selbst hasht "trim + lowercase"; fuer eine
 * ASCII-Adresse ist das dasselbe, und fuer alles andere ist der Schluessel des
 * E-Mail-Abgleichs die eine Regel im Haus (server/utils/email-match.js).
 */
export function gravatarHash(email) {
  return crypto.createHash('sha256').update(emailMatchKey(email), 'utf8').digest('hex');
}

/**
 * Die Basis-URL geprueft: https, ein Hostname, der nicht per se intern ist, und
 * mit abschliessendem Schraegstrich, damit der Hash als Pfadsegment angehaengt
 * wird und nicht an ein Segment des Betreibers klebt. Query und Fragment sind
 * kein Fehler, aber sie wuerden `?s=&d=` zerreissen - deshalb abgelehnt.
 *
 * @throws {GravatarError} gravatar_disabled bei leerem Wert,
 *                         gravatar_bad_base_url bei allem, was keine https-URL ist
 */
function resolvedBase(base) {
  const value = base === undefined ? gravatarBaseUrl() : String(base ?? '').trim();
  if (!value) throw new GravatarError('gravatar_disabled', 'Gravatar import is switched off on this server.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new GravatarError('gravatar_bad_base_url', 'GRAVATAR_BASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || isBlockedHostname(parsed.hostname)) {
    throw new GravatarError('gravatar_bad_base_url', 'GRAVATAR_BASE_URL must be an https URL to a public host.');
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

/**
 * Die URL, die abgerufen wird. `d=404` bittet Gravatar, fuer eine unbekannte
 * Adresse 404 zu antworten statt eines generierten Platzhalters - sonst
 * speicherte der Import ein Bild, das niemand hochgeladen hat.
 *
 * @param {string} email
 * @param {object} [opts]
 * @param {number} [opts.size=256]
 * @param {string} [opts.base]  Basis-URL; Default aus GRAVATAR_BASE_URL
 */
export function gravatarUrl(email, { size = DEFAULT_GRAVATAR_SIZE, base } = {}) {
  const url = new URL(gravatarHash(email), resolvedBase(base));
  url.search = `?s=${Number.isInteger(size) && size > 0 ? size : DEFAULT_GRAVATAR_SIZE}&d=404`;
  return url.href;
}

function contentType(res) {
  return String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

/**
 * Liest den Body groessenbegrenzt in einen Buffer (Idiom aus
 * subscription-logo.js#readLimited): erst die Ankuendigung (Content-Length),
 * dann jeder Chunk - ein Server, der mehr schickt als angekuendigt, laeuft in
 * dieselbe Grenze.
 */
async function readLimited(res, limit) {
  const announced = Number(res.headers.get('content-length') || 0);
  if (announced > limit) {
    res.body.destroy();
    throw new GravatarError('gravatar_too_large', 'The Gravatar image is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const value of res.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > limit) {
      res.body.destroy();
      throw new GravatarError('gravatar_too_large', 'The Gravatar image is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Holt das Gravatar zur Adresse - genau einmal.
 *
 * @param {string|null} email  Die EINE gespeicherte Adresse des Mitglieds
 *        (memberEmail() liefert null, wenn es keine eindeutige gibt).
 * @param {object} [opts]
 * @param {Function} [opts.request=safeRequest]  Injizierbar fuer Tests (kein Netz).
 * @param {Function} [opts.lookup]   Node-style DNS-Lookup; Default ist der
 *        Anti-Rebinding-Lookup aus ssrf.js. Er reist bei safeRequest mit jedem
 *        Redirect mit, ein Spiegel kann also nicht ins LAN umleiten.
 * @param {string}   [opts.base]     Basis-URL (Default: GRAVATAR_BASE_URL)
 * @param {number}   [opts.size=256]
 * @param {number}   [opts.timeoutMs=8000]
 * @returns {Promise<{ dataUrl: string, contentType: string, bytes: number }|null>}
 *          null, wenn Gravatar kein Bild fuer die Adresse hat (404).
 * @throws {GravatarError} no_email, gravatar_disabled, gravatar_bad_base_url,
 *         gravatar_unreachable, gravatar_too_large, gravatar_not_image
 */
export async function fetchGravatar(email, {
  request = safeRequest,
  lookup = createGuardedLookup(),
  base,
  size = DEFAULT_GRAVATAR_SIZE,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!emailMatchKey(email)) {
    throw new GravatarError('no_email', 'Save an email address in your profile first.');
  }
  // Die URL VOR der Adresspruefung zu bauen hiesse, einem Konto ohne Adresse
  // "abgeschaltet" zu melden - der Grund, den es selbst beheben kann, geht vor.
  const url = gravatarUrl(email, { size, base });

  let res;
  try {
    res = await request(url, {
      headers: { Accept: 'image/png,image/jpeg,image/webp' },
      signal: AbortSignal.timeout(timeoutMs),
      lookup,
    });
  } catch (err) {
    // Timeout, DNS, vom Guard abgewiesene Adresse, TLS, zu viele Redirects:
    // fuer das Mitglied ist das alles "nicht erreichbar". Was genau, steht als
    // `cause` im Log der Route, nicht in der Antwort.
    throw new GravatarError('gravatar_unreachable', 'gravatar.com could not be reached.', { cause: err });
  }

  if (res.status === 404) {
    res.body.destroy();
    return null;
  }
  if (!res.ok) {
    res.body.destroy();
    throw new GravatarError('gravatar_unreachable', 'gravatar.com could not be reached.');
  }

  const type = contentType(res);
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    res.body.destroy();
    throw new GravatarError('gravatar_not_image', 'The Gravatar response is not a PNG, JPEG or WebP image.');
  }

  // Was beim LESEN des Koerpers reisst (Timeout mitten im Stream, ein Socket,
  // der frueher zugeht als die Content-Length verspricht, ein kaputtes gzip),
  // ist derselbe Fall wie ein Verbindungsfehler davor: die Gegenseite war nicht
  // erreichbar. Ohne diese Huelle fiele es als nackter Error auf 500.
  let image;
  try {
    image = await readLimited(res, MAX_GRAVATAR_BYTES);
  } catch (err) {
    if (err instanceof GravatarError) throw err;
    throw new GravatarError('gravatar_unreachable', 'gravatar.com could not be reached.', { cause: err });
  }
  // Der Typ kommt aus einer fremden Antwort; die Bytes muessen ihn bestaetigen,
  // genau wie bei einem Upload (dataUrlContentMatches in den Upload-Routen).
  if (!contentMatchesMime(image, type)) {
    throw new GravatarError('gravatar_not_image', 'The Gravatar response is not a PNG, JPEG or WebP image.');
  }

  return {
    dataUrl: `data:${type};base64,${image.toString('base64')}`,
    contentType: type,
    bytes: image.byteLength,
  };
}
