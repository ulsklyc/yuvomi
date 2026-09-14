/**
 * Modul: OIDC-Client
 * Zweck: OpenID-Connect-Konfiguration (openid-client v6), via Umgebungsvariablen.
 *        getConfig() führt Discovery durch und cached die Configuration für die Laufzeit.
 *        resetClient() wird in Tests verwendet um den Cache zu leeren.
 */
import * as client from 'openid-client';

let _config = null;

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

  // client_secret_basic explizit erzwingen — der v6-Default wäre client_secret_post,
  // was eine stille Verhaltensänderung gegenüber v5 gewesen wäre.
  _config = await client.discovery(
    new URL(process.env.OIDC_ISSUER),
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    client.ClientSecretBasic(process.env.OIDC_CLIENT_SECRET),
  );

  return _config;
}

/**
 * Leert den Configuration-Cache. Nur für Tests.
 */
export function resetClient() {
  _config = null;
}
