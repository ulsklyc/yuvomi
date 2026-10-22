/**
 * Modul: OIDC-Client
 * Zweck: OpenID-Connect-Konfiguration (openid-client v6), via Umgebungsvariablen.
 *        getConfig() führt Discovery durch und cached die Configuration für die Laufzeit.
 *        resetClient() wird in Tests verwendet um den Cache zu leeren.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as client from 'openid-client';

let _config = null;

/**
 * Die Redirect-URI des laufenden Code-Tauschs, je Aufruf (#1768).
 * Siehe `exchangeAuthorizationCode`.
 */
const grantRedirectUri = new AsyncLocalStorage();

/**
 * `fetch` fuer die Anfragen an den Anbieter. Reicht alles unveraendert durch,
 * nur die Token-Anfrage des Code-Tauschs bekommt die Redirect-URI, die die
 * Authorize-Anfrage getragen hat. Das ist der Weg, den `openid-client` dafuer
 * dokumentiert (`customFetch`, Beispiel "Correcting the redirect_uri token
 * endpoint request parameter"): die Bibliothek leitet den Wert sonst aus der
 * Callback-URL ab, und zusaetzliche Token-Parameter ueberschreibt sie.
 *
 * Ein Code-Tausch ohne festgehaltenen Wert wird abgewiesen statt mit dem
 * abgeleiteten gesendet: der abgeleitete ist genau der, der abweichen kann.
 */
function providerFetch(url, options) {
  const body = options?.body;
  if (body instanceof URLSearchParams && body.get('grant_type') === 'authorization_code') {
    const redirectUri = grantRedirectUri.getStore();
    if (typeof redirectUri !== 'string' || !redirectUri) {
      throw new Error('OIDC code exchange without the redirect URI of its authorize request.');
    }
    body.set('redirect_uri', redirectUri);
  }
  return fetch(url, options);
}

/**
 * Gibt true zurück wenn alle vier OIDC-Umgebungsvariablen gesetzt sind.
 * @returns {boolean}
 */
export function isOidcEnabled() {
  return !!(
    process.env.OIDC_ISSUER &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET &&
    process.env.OIDC_REDIRECT_URI
  );
}

/**
 * Darf eine SSO-Anmeldung ein noch unbekanntes Konto ANLEGEN? (#654)
 *
 * Wer Yuvomi an einen IdP haengt, den er nicht nur fuer diesen Haushalt
 * betreibt, teilt damit sein ganzes Verzeichnis: bisher bekam jeder, der sich
 * dort anmelden konnte, beim ersten Klick auf „Mit SSO anmelden" ungefragt ein
 * Konto im Familienplaner. Ein Verzeichnis ist aber eine Liste von Menschen,
 * keine Liste von Haushaltsmitgliedern.
 *
 * Der Default bleibt `true`: jede bestehende Installation verhaelt sich nach
 * dem Update unveraendert. Ausgeschaltet wird ausdruecklich, und dann bleibt
 * die ZUORDNUNG zu bereits angelegten Konten erhalten - der Admin legt das
 * Konto an, die erste SSO-Anmeldung verknuepft es. Nur das Anlegen faellt weg.
 *
 * Gelesen wird bewusst pro Aufruf und nicht beim Import: derselbe Prozess
 * bedient in den Tests beide Zustaende, und ein gecachter Schalter waere ein
 * Sicherheitsschalter, der vom Zeitpunkt des ersten Imports abhaengt.
 * @returns {boolean}
 */
export function isOidcSignupAllowed() {
  return process.env.OIDC_ALLOW_SIGNUP !== 'false';
}

/**
 * Der `password_hash` eines Kontos, das ausschliesslich per SSO hineinkommt.
 *
 * Kein bcrypt-Hash, sondern ein Platzhalter: `verifyPassword` laeuft trotzdem
 * durch (Timing) und kann nie zutreffen, weil kein bcrypt-Vergleich gegen einen
 * Nicht-Hash gelingt. Damit ist "dieses Konto hat kein Passwort" ein Zustand in
 * der Spalte selbst und nicht eine zusaetzliche Spalte, die irgendwo
 * mitgeprueft werden muesste.
 *
 * Liegt hier und nicht in `auth.js`, seit ihn ausser der Anmeldung auch das
 * Anlegen, das Aendern und der Passwort-Reset kennen muessen (#847): eine
 * zweite Schreibweise des Platzhalters waere ein Konto mit einem Passwort, das
 * niemand gesetzt hat.
 */
export const OIDC_PASSWORD_SENTINEL = '$oidc$';

/**
 * Traegt dieses Konto den Platzhalter statt eines echten Passworts?
 * @param {string|null|undefined} passwordHash
 * @returns {boolean}
 */
export function isSsoOnlyAccount(passwordHash) {
  return passwordHash === OIDC_PASSWORD_SENTINEL;
}

/**
 * Darf man sich mit Benutzername und Passwort anmelden? (#847)
 *
 * Wer seinen Haushalt an einen Identitaetsanbieter haengt, hat bisher trotzdem
 * eine zweite Tuer offen: das Anmeldeformular, den Passwort-Reset und an jedem
 * Konto einen Hash. Fuer ein Setup, in dem der Anbieter die einzige Wahrheit
 * ueber Identitaeten ist, ist das eine Tuer zu viel.
 *
 * Zwei Eigenschaften sind Absicht:
 *
 * 1. Nur der ausdrueckliche Wert `false` schaltet ab. Ein Sicherheitsschalter,
 *    der auf jeden gesetzten Wert reagiert, macht aus einem Tippfehler eine
 *    Aussperrung - dieselbe Regel wie bei `OIDC_ALLOW_SIGNUP`.
 *
 * 2. Ohne vollstaendig konfiguriertes OIDC wird der Schalter IGNORIERT. Sonst
 *    schliesst eine einzelne Zeile in der `.env` den Haushalt aus seiner
 *    eigenen App aus, ohne dass es einen zweiten Weg hinein gaebe. Der Server
 *    meldet diesen Fall beim Start (siehe `passwordLoginWarning`).
 *
 * Gelesen wird pro Aufruf, nicht beim Import - siehe `isOidcSignupAllowed`.
 * @returns {boolean}
 */
export function isPasswordLoginEnabled({ hasLinkedSsoAccount = true } = {}) {
  if (process.env.AUTH_ALLOW_PASSWORD_LOGIN !== 'false') return true;
  // Fail-open 1: ohne SSO gaebe es keinen Weg hinein.
  if (!isOidcEnabled()) return true;
  // Fail-open 2: konfiguriertes SSO heisst noch nicht, dass jemand hindurch
  // kommt. Eine frische Installation legt ihren ersten Administrator ueber
  // `/setup` mit einem Passwort an - griffe der Schalter schon davor, waere
  // dieses Konto im selben Moment tot, `/setup` danach zu und niemand mehr
  // administrativ drin. Erst wenn mindestens ein ADMINISTRATOR-Konto mit dem
  // Anbieter verknuepft ist, gibt es einen zweiten Weg, den man zumachen kann
  // (die Abfrage dazu steht in `auth.js` und `index.js`, beide mit
  // `role = 'admin'`).
  // Der Aufrufer reicht die Antwort herein; der Default haelt diese Datei frei
  // von der Datenbank und laesst den Schalter im Zweifel GREIFEN.
  return !hasLinkedSsoAccount;
}

/**
 * Gibt den Warntext zurueck, wenn `AUTH_ALLOW_PASSWORD_LOGIN=false` gesetzt,
 * aber wirkungslos ist - sonst `null`. Der Aufrufer loggt ihn beim Start.
 *
 * Ein still ignorierter Sicherheitsschalter ist schlimmer als gar keiner: der
 * Betreiber glaubt, das Formular sei zu, und es ist offen.
 * @returns {string|null}
 */
export function passwordLoginWarning({ hasLinkedSsoAccount = true } = {}) {
  if (process.env.AUTH_ALLOW_PASSWORD_LOGIN !== 'false') return null;
  if (!isOidcEnabled()) {
    return 'AUTH_ALLOW_PASSWORD_LOGIN=false is ignored because OIDC is not fully configured '
      + '(OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI). '
      + 'Password login stays enabled - otherwise nobody could sign in.';
  }
  // Der zweite Fail-open-Zustand braucht dieselbe Meldung wie der erste. Er ist
  // der ERWARTETE Zustand einer frischen Installation, aber von aussen sieht er
  // aus wie der eingeschaltete Riegel - und ohne Hinweis haelt der Betreiber
  // das Anmeldeformular fuer zu, waehrend es offen steht.
  if (!hasLinkedSsoAccount) {
    return 'AUTH_ALLOW_PASSWORD_LOGIN=false has no effect yet because no administrator account is '
      + 'linked to the OIDC provider. Password login stays enabled until an administrator signs '
      + 'in through SSO at least once - a member signing in does not count, otherwise an '
      + 'administrator without a linked account could be locked out of the administration.';
  }
  return null;
}

/**
 * Gibt die initialisierte OIDC-Configuration zurück (Discovery bei erstem Aufruf).
 * Gibt null zurück wenn OIDC nicht konfiguriert ist.
 * @returns {Promise<import('openid-client').Configuration|null>}
 */
export async function getConfig() {
  if (!isOidcEnabled()) return null;
  if (_config) return _config;

  // Vor der Discovery: ein Tippfehler im Schalter soll beim ersten SSO-Klick
  // mit seinem Namen scheitern, nicht erst am Token-Endpunkt als invalid_client.
  const configured = configuredTokenAuthMethod();
  _config = await client.discovery(
    new URL(process.env.OIDC_ISSUER),
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    tokenEndpointAuth(process.env.OIDC_CLIENT_SECRET, configured),
    { [client.customFetch]: providerFetch },
  );

  return _config;
}

/** Die beiden Wege, auf denen sich Yuvomi am Token-Endpunkt ausweist (#2144). */
export const TOKEN_AUTH_METHODS = Object.freeze(['client_secret_basic', 'client_secret_post']);

/**
 * Der ausdruecklich gesetzte Wert von `OIDC_TOKEN_AUTH_METHOD`, sonst `null`.
 * Ein unbekannter Wert wirft: still auf einen Default zurueckzufallen hiesse,
 * dass der Betreiber glaubt, umgestellt zu haben, und es nicht hat.
 * @returns {'client_secret_basic'|'client_secret_post'|null}
 */
export function configuredTokenAuthMethod() {
  const value = (process.env.OIDC_TOKEN_AUTH_METHOD ?? '').trim();
  if (!value) return null;
  if (!TOKEN_AUTH_METHODS.includes(value)) {
    throw new Error(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')} or empty, got "${value.slice(0, 40)}".`);
  }
  return value;
}

/**
 * Welche Methode gilt fuer diesen Anbieter?
 *
 * Ohne Schalter bleibt es `client_secret_basic` - das Verhalten jeder
 * Bestandsinstallation und nach RFC 8414 2 der Default, wenn ein Anbieter
 * `token_endpoint_auth_methods_supported` gar nicht nennt. Nur ein Anbieter,
 * der ausdruecklich `client_secret_post` und NICHT `client_secret_basic`
 * anbietet, bekommt `post`: Basic wuerde er ohnehin ablehnen.
 *
 * @param {object|undefined} serverMetadata  Discovery-Dokument des Anbieters
 * @param {string|null} configured           Ergebnis von `configuredTokenAuthMethod()`
 */
export function resolveTokenAuthMethod(serverMetadata, configured) {
  if (configured) return configured;
  const supported = serverMetadata?.token_endpoint_auth_methods_supported;
  if (Array.isArray(supported)
    && supported.includes('client_secret_post')
    && !supported.includes('client_secret_basic')) {
    return 'client_secret_post';
  }
  return 'client_secret_basic';
}

/**
 * Formular-Kodierung eines Werts nach application/x-www-form-urlencoded, wie
 * RFC 6749 2.3.1 sie fuer Client-ID und Secret im Basic-Header verlangt.
 *
 * Bewusst NICHT `ClientSecretBasic` aus `openid-client`: `oauth4webapi`
 * kodiert dort zusaetzlich `-`, `_`, `.`, `!`, `~`, `*`, `'`, `(` und `)`, die
 * das Formularformat unveraendert laesst. Ein Anbieter, der den Header nicht
 * zurueckdekodiert (Gitea, #2144), sah dadurch eine UUID-Client-ID als
 * `a7f39c21%2D6b84...` und antwortete `invalid_client`. `URLSearchParams`
 * implementiert genau den Serialisierer des Formats: ein Anbieter, der
 * dekodiert, bekommt denselben Wert wie zuvor, einer, der es nicht tut, sieht
 * IDs und Secrets aus Buchstaben, Ziffern und `-._*` jetzt woertlich.
 * @param {string} value
 */
function formUrlEncode(value) {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

/**
 * Der Authorization-Header fuer `client_secret_basic`.
 * @param {string} clientId
 * @param {string} clientSecret
 */
export function basicAuthorization(clientId, clientSecret) {
  const credentials = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`;
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}

/**
 * Die Client-Authentifizierung fuer `openid-client` (Signatur von
 * `ClientAuth`). Die Methode wird je Anfrage aus dem Discovery-Dokument
 * bestimmt, das die Bibliothek hereinreicht; der Schalter ist zu dem Zeitpunkt
 * schon geprueft. Synchron, wie `ClientSecretBasic` es war: der `fetch`-Haken
 * in `providerFetch` liest die Redirect-URI aus dem AsyncLocalStorage des
 * Aufrufs (#1768).
 */
function tokenEndpointAuth(clientSecret, configured) {
  return (as, clientMetadata, body, headers) => {
    if (resolveTokenAuthMethod(as, configured) === 'client_secret_post') {
      return client.ClientSecretPost(clientSecret)(as, clientMetadata, body, headers);
    }
    headers.set('authorization', basicAuthorization(clientMetadata.client_id, clientSecret));
    return undefined;
  };
}

/**
 * Tauscht den Code aus dem Callback gegen Tokens - mit GENAU der Redirect-URI,
 * die die Authorize-Anfrage dieses Laufs getragen hat (#1768).
 *
 * RFC 6749, 4.1.3: der Anbieter muss einen Tausch ablehnen, dessen
 * `redirect_uri` nicht identisch mit der aus der Authorize-Anfrage ist.
 * `authorizationCodeGrant` bekommt nur eine URL und nimmt deren Form ohne Query
 * als Redirect-URI. Aus `OIDC_REDIRECT_URI` und dem Pfad der eingehenden
 * Anfrage gebaut, war das die NORMALISIERTE Herkunft der Variable mit dem Pfad,
 * der bei Express ankam: `https://Host:443/...` wurde zu `https://host/...`,
 * und ein Pfad, den der Reverse Proxy umschreibt, ging mit. Die Anmeldung
 * scheiterte dann nach dem erfolgreichen Login beim Anbieter mit `invalid_grant`.
 *
 * Von der eingehenden Anfrage kommen deshalb nur die Antwortparameter (`code`,
 * `state`, `iss`, `error`): die URL fuer die Bibliothek traegt den
 * festgehaltenen Wert als Basis, und `providerFetch` setzt ihn in der
 * Token-Anfrage Zeichen fuer Zeichen. Der Wert reist ueber AsyncLocalStorage
 * und nicht ueber die geteilte Configuration, weil zwei Anmeldungen
 * gleichzeitig laufen koennen.
 *
 * @param {import('openid-client').Configuration} config
 * @param {object} args
 * @param {string} args.redirectUri  Wert aus der Authorize-Anfrage dieses Laufs
 * @param {string} args.query        Query der eingehenden Callback-Anfrage, mit oder ohne `?`
 * @param {object} args.checks       expectedState, expectedNonce, pkceCodeVerifier
 */
export function exchangeAuthorizationCode(config, { redirectUri, query, checks }) {
  if (typeof redirectUri !== 'string' || !redirectUri) {
    throw new TypeError('exchangeAuthorizationCode needs the redirect URI of the authorize request.');
  }
  const currentUrl = new URL(redirectUri);
  currentUrl.search = query ?? '';
  currentUrl.hash = '';
  return grantRedirectUri.run(redirectUri, () => client.authorizationCodeGrant(config, currentUrl, checks));
}

/**
 * Leert den Configuration-Cache. Nur für Tests.
 */
export function resetClient() {
  _config = null;
}

const ERROR_TEXT_MAX = 300;

function errorText(value) {
  return typeof value === 'string' && value ? value.slice(0, ERROR_TEXT_MAX) : undefined;
}

/**
 * Macht aus einem Fehler des OIDC-Wegs das, was ins Log gehoert (#1675).
 *
 * Der Logger schreibt von einem Error nur `name`, `message` und `stack`. Bei
 * einem Fehler vom Anbieter steht die eigentliche Auskunft aber in den Feldern
 * daneben: `oauth4webapi` meldet eine abgelehnte Token-Anfrage als
 * `ResponseBodyError` mit der immer gleichen Meldung "server responded with an
 * error in the response body", und ob dahinter `invalid_client` (Client-ID oder
 * Secret) oder `invalid_grant` (Code, Redirect-URI, PKCE) steckt, sagen nur
 * `error` und `error_description`. Ohne sie kann niemand seine eigene
 * Konfiguration einordnen.
 *
 * Uebernommen wird eine feste Liste, nie das Fehlerobjekt als Ganzes: an
 * `response` haengt die Anfrage samt Authorization-Header, und der Antwortkoerper
 * (`cause`) gehoert dem Anbieter. Code, Tokens und Secret kommen in keinem der
 * gelisteten Felder vor. Texte sind gekappt, weil sie von aussen kommen.
 *
 * - `error`, `error_description`, `status`: Antwort des Token-Endpunkts, oder
 *   die Fehlerparameter, mit denen der Anbieter zum Callback zurueckleitet.
 * - `challenges`: ein 401 mit `WWW-Authenticate` statt eines JSON-Koerpers.
 * - `cause`: der Netzwerkfehler unter einem "fetch failed" (DNS, Zertifikat,
 *   Verbindung) - der haeufigste Grund, warum schon die Discovery scheitert.
 *
 * @param {unknown} err
 * @returns {object}
 */
export function describeOidcError(err) {
  if (!(err instanceof Error)) return { message: errorText(String(err)) };

  const detail = { name: err.name, message: err.message };
  const code = errorText(err.code);
  if (code) detail.code = code;
  const error = errorText(err.error);
  if (error) detail.error = error;
  const description = errorText(err.error_description);
  if (description) detail.error_description = description;
  if (Number.isInteger(err.status)) detail.status = err.status;

  const { cause } = err;
  if (Array.isArray(cause)) {
    const challenges = cause
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const challenge = { scheme: errorText(entry.scheme) };
        const challengeError = errorText(entry.parameters?.error);
        if (challengeError) challenge.error = challengeError;
        const challengeDescription = errorText(entry.parameters?.error_description);
        if (challengeDescription) challenge.error_description = challengeDescription;
        return challenge;
      });
    if (challenges.length) detail.challenges = challenges;
  } else if (cause instanceof Error) {
    detail.cause = { name: cause.name, message: errorText(cause.message) };
    const causeCode = errorText(cause.code);
    if (causeCode) detail.cause.code = causeCode;
  }

  detail.stack = err.stack;
  return detail;
}
