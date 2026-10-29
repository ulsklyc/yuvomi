/**
 * Vorbelegung des Wizards bei einem Rerun über eine bestehende .env.
 *
 * Reine Funktionen ohne DOM: install.html wendet den Plan an, die Tests
 * (test/test-installer-rerun.js) rechnen ihn ohne Browser nach. Die Werte kommen
 * aus /api/preflight (`rerunValues`), und dort nur aus der Allowlist
 * RERUN_PREFILL_KEYS in env-schema.js - ein Secret erreicht diese Datei nie.
 *
 * Der Anlass: jedes Feld startete mit seinem Default, buildEnv() schickte Port,
 * BASE_URL, SESSION_SECURE, TRUST_PROXY, TZ und WEATHER_UNITS immer mit, und
 * der Server bewahrt nur, was der Client NICHT schickt. Ein zweiter Lauf über
 * den Erweitert-Pfad setzte diese Werte still auf Defaults zurück - genau der
 * Pfad, den der Willkommensschritt bei bestehender .env als den sicheren nennt.
 */

/**
 * Schema-Schlüssel -> Feld-ID und Art.
 *   value    : Text-/Select-Wert
 *   on       : Schalter, an genau bei 'true'
 *   notFalse : Schalter, an ausser bei 'false' (Server-Default ist "an")
 */
export const PREFILL_FIELDS = [
  ['WEATHER_LAT', 'wea-lat', 'value'],
  ['WEATHER_LON', 'wea-lon', 'value'],
  ['WEATHER_CITY', 'wea-city', 'value'],
  ['WEATHER_UNITS', 'wea-units', 'value'],
  ['EMAIL_SMTP_HOST', 'email-host', 'value'],
  ['EMAIL_SMTP_PORT', 'email-port', 'value'],
  ['EMAIL_SMTP_SECURE', 'email-secure', 'value'],
  ['EMAIL_SMTP_USER', 'email-user', 'value'],
  ['EMAIL_FROM_ADDRESS', 'email-from', 'value'],
  ['EMAIL_FROM_NAME', 'email-from-name', 'value'],
  ['GOOGLE_CLIENT_ID', 'gcal-id', 'value'],
  ['GOOGLE_DRIVE_CLIENT_ID', 'adv-document-google-drive-client-id', 'value'],
  ['APPLE_USERNAME', 'apple-user', 'value'],
  ['APPLE_CALDAV_URL', 'apple-url', 'value'],
  ['MS_CLIENT_ID', 'outlook-id', 'value'],
  ['SYNC_INTERVAL_MINUTES', 'adv-sync-interval', 'value'],
  ['ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK', 'adv-ics-private', 'on'],
  ['RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK', 'adv-recipe-provider-private', 'on'],
  ['WASTE_SOURCE_ALLOW_PRIVATE_NETWORK', 'adv-waste-source-private', 'on'],
  ['MODULES_ALLOW_WEB_INSTALL', 'adv-module-web-install', 'on'],
  ['OIKOS_HTTP_PORT', 'cfg-port', 'value'],
  ['DATA_DIR', 'adv-data-dir', 'value'],
  ['BASE_URL', 'adv-base-url', 'value'],
  ['OIDC_ISSUER', 'oidc-issuer', 'value'],
  ['OIDC_CLIENT_ID', 'oidc-client-id', 'value'],
  ['OIDC_REDIRECT_URI', 'oidc-redirect', 'value'],
  ['OIDC_TRUST_EMAIL_WITHOUT_VERIFIED_CLAIM', 'adv-oidc-trust-email', 'on'],
  ['OIDC_ALLOW_SIGNUP', 'adv-oidc-allow-signup', 'notFalse'],
  ['AUTH_ALLOW_PASSWORD_LOGIN', 'adv-auth-password-login', 'notFalse'],
  ['BACKUP_ENABLED', 'adv-backup-enable', 'notFalse'],
  ['BACKUP_SCHEDULE', 'adv-backup-schedule', 'value'],
  ['BACKUP_KEEP', 'adv-backup-keep', 'value'],
  ['WEBDAV_BACKUP_ENABLED', 'adv-webdav-backup-enable', 'on'],
  ['WEBDAV_BACKUP_URL', 'adv-webdav-backup-url', 'value'],
  ['WEBDAV_BACKUP_USERNAME', 'adv-webdav-backup-username', 'value'],
  ['WEBDAV_BACKUP_PATH', 'adv-webdav-backup-path', 'value'],
  ['WEBDAV_BACKUP_KEEP', 'adv-webdav-backup-keep', 'value'],
  ['VAPID_SUBJECT', 'adv-push-subject', 'value'],
  ['MAX_UPLOAD_MB', 'adv-max-upload', 'value'],
  ['DOCUMENT_STORAGE_LOCAL_ENABLED', 'adv-document-local-enable', 'on'],
  ['DOCUMENT_STORAGE_LOCAL_PATH', 'adv-document-local-path', 'value'],
  ['DOCUMENT_STORAGE_LOCAL_DIR', 'adv-document-local-dir', 'value'],
  ['DOCUMENT_STORAGE_WEBDAV_ENABLED', 'adv-document-webdav-enable', 'on'],
  ['DOCUMENT_STORAGE_WEBDAV_URL', 'adv-document-webdav-url', 'value'],
  ['DOCUMENT_STORAGE_WEBDAV_USERNAME', 'adv-document-webdav-username', 'value'],
  ['DOCUMENT_STORAGE_WEBDAV_PATH', 'adv-document-webdav-path', 'value'],
  ['DOCUMENT_STORAGE_WEBDAV_ALLOW_PRIVATE_NETWORK', 'adv-document-webdav-private', 'on'],
];

/**
 * Secret -> Feld-ID. Das Feld bleibt leer und zeigt "bestehender bleibt";
 * leer heisst ungesendet, und der Server setzt die alte Zeile wieder ein.
 * SESSION_SECRET und DB_ENCRYPTION_KEY laufen über preservedKeys.
 */
export const KEPT_SECRET_FIELDS = [
  ['FIXER_API_KEY', 'adv-fixer'],
  ['EMAIL_SMTP_PASS', 'email-pass'],
  ['GOOGLE_CLIENT_SECRET', 'gcal-secret'],
  ['GOOGLE_DRIVE_CLIENT_SECRET', 'adv-document-google-drive-client-secret'],
  ['APPLE_APP_SPECIFIC_PASSWORD', 'apple-pass'],
  ['MS_CLIENT_SECRET', 'outlook-secret'],
  ['OIDC_CLIENT_SECRET', 'oidc-client-secret'],
  ['WEBDAV_BACKUP_PASSWORD', 'adv-webdav-backup-password'],
  ['DOCUMENT_STORAGE_WEBDAV_PASSWORD', 'adv-document-webdav-password'],
];

/** Die Zugriffsart, die eine bestehende .env beschreibt. */
export function accessFromEnv(values) {
  // Ohne Zeile gilt der Compose-Default SESSION_SECURE=false, also Direktzugriff.
  return values.SESSION_SECURE === 'true' ? 'proxy' : 'direct';
}

/** Der Hostname aus einer BASE_URL, oder '' wenn sie keiner ist. */
export function hostFromBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // Ein IPv6-Literal kennt isValidHost() in install.html nicht; vorbelegt
    // blockierte es cfg-next beim unveränderten Rerun. Die BASE_URL selbst
    // bleibt übernommen (touched), nur das Host-Feld behält seinen Standard.
    if (u.hostname.startsWith('[')) return '';
    return u.hostname;
  } catch {
    return '';
  }
}

/**
 * Ein Wert mit Compose-Interpolation (`${PUBLIC_HOST}`, `$HTTP_PORT`). Der
 * Parser lässt ihn bewusst unaufgelöst (decodeEnvValue); erst Compose setzt
 * ein. In ein konkretes Feld abgeleitet (Host aus der BASE_URL) wäre er ein
 * anderer, ungültiger Wert - `https://${PUBLIC_HOST}` ergab den Host
 * `${public_host}`, und cfg-next hielt den unveränderten Rerun daran fest.
 */
export function isInterpolated(value) {
  return /\$(\{|[A-Za-z_])/.test(String(value ?? ''));
}

/** Der Hostname aus einer BASE_URL, oder '' wenn sie keiner ist (auch bei Interpolation). */
function hostForField(baseUrl) {
  return isInterpolated(baseUrl) ? '' : hostFromBaseUrl(baseUrl);
}

/**
 * Der Vorbelegungsplan für eine bestehende .env.
 *
 * `fields`: Feld-ID -> Wert (String) bzw. Haken (Boolean).
 * `touched`: Felder, die als "vom Nutzer gesetzt" gelten - sonst überschriebe
 *   die Ableitung aus Host und Port die übernommene BASE_URL sofort wieder.
 * `access`: 'proxy' | 'direct'.
 * `kept`: Feld-IDs der Secrets, die in der .env stehen.
 */
export function prefillPlan(values = {}, keptSecrets = []) {
  const fields = {};
  const touched = [];
  for (const [key, id, kind] of PREFILL_FIELDS) {
    const v = values[key];
    if (kind === 'value') {
      if (v) fields[id] = v;
    } else if (kind === 'on') {
      if (v !== undefined) fields[id] = v === 'true';
    } else if (kind === 'notFalse') {
      if (v !== undefined) fields[id] = v !== 'false';
    }
  }
  // Die Zeitzone ohne Zeile ist die des Containers (UTC), nicht die des
  // Browsers: die Vorbelegung mit der Browserzone schriebe sonst still eine neue.
  fields['cfg-tz'] = values.TZ || 'UTC';
  const host = hostForField(values.BASE_URL || '');
  if (host) fields['cfg-host'] = host;
  if (values.BASE_URL) touched.push('adv-base-url');
  const access = accessFromEnv(values);
  fields['adv-proxy'] = access;
  touched.push('adv-proxy');
  // Gruppenschalter: an, sobald die Gruppe in der .env eingerichtet ist.
  if (values.WEATHER_LAT) fields['wea-enable'] = true;
  if (values.EMAIL_SMTP_HOST) fields['email-enable'] = true;
  if (values.GOOGLE_DRIVE_CLIENT_ID || values.GOOGLE_DRIVE_REDIRECT_URI) {
    fields['adv-document-google-drive-enable'] = true;
  }
  const kept = KEPT_SECRET_FIELDS.filter(([key]) => keptSecrets.includes(key)).map(([, id]) => id);
  return { fields, touched, access, kept };
}

/**
 * SESSION_SECURE und TRUST_PROXY zur gewählten Zugriffsart.
 *
 * Bleibt die Wahl beim Rerun die übernommene, gehen die BESTEHENDEN Werte
 * zurück - leer heisst ungesendet, der Server bewahrt die Zeile. Ein
 * TRUST_PROXY=2 (zwei Proxy-Hops) oder =uniquelocal sonst durch '1' ersetzt,
 * und die Anmeldung hinter dem zweiten Proxy hätte die Client-IP verloren.
 * Erst eine bewusst andere Wahl setzt die Standardpaare.
 */
export function accessEnv(choice, rerun = null) {
  if (rerun && choice === accessFromEnv(rerun)) {
    return { SESSION_SECURE: rerun.SESSION_SECURE || '', TRUST_PROXY: rerun.TRUST_PROXY || '' };
  }
  return choice === 'direct'
    ? { SESSION_SECURE: 'false', TRUST_PROXY: 'loopback' }
    : { SESSION_SECURE: 'true', TRUST_PROXY: '1' };
}

/**
 * Das save-Request ohne die Werte, die unverändert dem Bestand entsprechen.
 *
 * Der Server bewahrt eine Zeile nur VERBATIM, wenn der Client den Schlüssel
 * nicht schickt (preserveUnmanagedLines). Schickte der Wizard den vorbelegten
 * Wert zurück, rendert der Server ihn neu - und jede Abweichung zwischen dem
 * Parser und Compose (Inline-Kommentar, einfache Quotes, Escapes) wird so zu
 * einem anderen Wert: aus `DATA_DIR=./data # storage` wurde
 * `DATA_DIR="./data # storage"`, ein anderes Verzeichnis. Unverändert heisst
 * deshalb: ungesendet, die Originalzeile bleibt Zeichen für Zeichen.
 */
export function omitUnchanged(env, rerun = null, untouchedField = () => false) {
  if (!rerun) return env;
  const out = {};
  for (const [key, raw] of Object.entries(env)) {
    // Ein unberührter Schalter bleibt ungesendet - verglichen am Feldstand nach
    // der Vorbelegung, nicht am serialisierten Wert: ein Compose-Ausdruck wie
    // BACKUP_ENABLED=${BACKUPS:-false} wird als "an" vorbelegt, und die
    // Normalisierung darunter machte daraus beim unberührten Rerun 'true'.
    if (SWITCH_FIELDS.has(key) && untouchedField(SWITCH_FIELDS.get(key))) continue;
    // Ein Schalter schreibt für seinen Standard '' - und '' verwirft der
    // Server, die alte Zeile kaeme zurueck. Wer einen vorbelegten Schalter
    // umlegt, bekommt deshalb den Standard ausdruecklich: aus
    // BACKUP_ENABLED=false wird beim Einschalten 'true', nicht ''.
    const kind = SWITCH_KINDS.get(key);
    const value = kind && raw === '' && rerun[key] !== undefined
      ? (kind === 'on' ? 'false' : 'true')
      : raw;
    if (rerun[key] !== undefined && value === rerun[key]) continue;
    out[key] = value;
  }
  return out;
}

/** Schalter-Schlüssel -> Feld-ID. */
const SWITCH_FIELDS = new Map(
  PREFILL_FIELDS.filter(([, , kind]) => kind === 'on' || kind === 'notFalse').map(([key, id]) => [key, id]),
);

/** Schalter-Schlüssel -> 'on' | 'notFalse' (siehe PREFILL_FIELDS). */
const SWITCH_KINDS = new Map(
  PREFILL_FIELDS.filter(([, , kind]) => kind === 'on' || kind === 'notFalse').map(([key, , kind]) => [key, kind]),
);

/**
 * Die Felder, deren Zustand nach der Vorbelegung festgehalten wird
 * (applyRerunPrefill -> fieldBaseline). Für sie gilt EINE Regel: ein seit der
 * Vorbelegung unverändertes Feld wird weder geprüft noch neu abgeleitet noch
 * gesendet (untouched() in install.html, omitUnchanged() hier). Der Bestand
 * läuft bereits so; ein Prüfer des Wizards, der enger ist als der Server
 * (Compose-Interpolation, Sekundenfeld im Cron), hielt sonst einen
 * unveränderten Rerun fest, und eine Ableitung aus BASE_URL überschrieb
 * bewusst anders gesetzte Werte (registrierte Redirect-URIs).
 */
export const BASELINE_FIELDS = [...new Set([
  ...PREFILL_FIELDS.map(([, id]) => id),
  ...KEPT_SECRET_FIELDS.map(([, id]) => id),
  'cfg-host', 'cfg-tz', 'adv-proxy',
  'wea-enable', 'email-enable', 'adv-document-google-drive-enable',
])];

/**
 * Redirect-URI -> die Felder, von denen sie neben der Adresse abhängt. Bleiben
 * Adresse und diese Felder unverändert, geht die bestehende URI zurück
 * (ungesendet): sie ist beim Anbieter registriert und darf einen anderen Host
 * tragen als BASE_URL. Erst eine Änderung leitet sie neu ab.
 */
export const REDIRECT_SOURCES = {
  GOOGLE_REDIRECT_URI: ['gcal-id'],
  MS_REDIRECT_URI: ['outlook-id'],
  GOOGLE_DRIVE_REDIRECT_URI: ['adv-document-google-drive-enable', 'adv-document-google-drive-client-id'],
  OIDC_REDIRECT_URI: ['oidc-redirect'],
};

/** Die Felder des E-Mail-Schritts samt Schalter (Vollständigkeitsprüfung). */
export const EMAIL_SECTION_FIELDS = [
  'email-enable', 'email-host', 'email-port', 'email-secure', 'email-user',
  'email-pass', 'email-from', 'email-from-name',
];

/**
 * Stimmt der Zustand dieser Felder mit dem nach der Vorbelegung überein?
 * `baseline`/`current`: Feld-ID -> Wert (String) bzw. Haken (Boolean).
 *
 * Eine Teilkonfiguration aus der .env (nur EMAIL_SMTP_HOST, der Absender steht
 * in der App, sync_config) ist gültig: server/services/email.js löst jedes Feld
 * einzeln aus Umgebung oder Datenbank auf. Die Vorbelegung schaltet den
 * Abschnitt dann ein, und die Vollständigkeitsprüfung hielt einen
 * unveränderten Rerun an email.errIncomplete fest. Geprüft wird deshalb nur,
 * was der Nutzer im Abschnitt angefasst hat.
 */
export function unchangedSince(baseline, current, ids) {
  if (!baseline) return false;
  return ids.every(id => baseline[id] === current[id]);
}
