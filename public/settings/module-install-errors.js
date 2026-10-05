/**
 * Modul: Einstellungen - Meldungen zu Modul-Installation und -Loeschen
 * Zweck: Der Server nennt jeden Fehler mit einem stabilen `reason`
 *        (server/services/module-install.js, REASON_STATUS). Hier wird daraus
 *        ein Satz in der UI-Sprache - eine Stelle fuer beide Blaetter, die ihn
 *        zeigen: "Eigenes Modul hinzufuegen" und den Loeschen-Toast in
 *        "Aktive Module".
 * Abhaengigkeiten: /i18n.js
 */

import { formatTime, t } from '/i18n.js';

/**
 * Stabile `reason`-Codes des Servers -> Meldung in der UI-Sprache. Literale
 * Schluessel, damit test:i18n jeden einzelnen sieht.
 */
const REASON_KEYS = Object.freeze({
  bad_url: 'settings.installModuleErrorBadUrl',
  repo_not_found: 'settings.installModuleErrorRepoNotFound',
  ref_not_found: 'settings.installModuleErrorRefNotFound',
  rate_limited: 'settings.installModuleErrorRateLimited',
  install_rate_limited: 'settings.installModuleErrorTooManyAttempts',
  github_failed: 'settings.installModuleErrorGithubFailed',
  not_zip: 'settings.installModuleErrorNotZip',
  too_large: 'settings.installModuleErrorTooLarge',
  too_many_entries: 'settings.installModuleErrorTooManyEntries',
  bomb: 'settings.installModuleErrorBomb',
  unsafe_path: 'settings.installModuleErrorUnsafePath',
  symlink: 'settings.installModuleErrorSymlink',
  encrypted: 'settings.installModuleErrorEncrypted',
  zip64: 'settings.installModuleErrorZip64',
  method: 'settings.installModuleErrorMethod',
  crc: 'settings.installModuleErrorCrc',
  duplicate: 'settings.installModuleErrorDuplicate',
  corrupt: 'settings.installModuleErrorCorrupt',
  unsupported_encoding: 'settings.installModuleErrorUnsupportedEncoding',
  no_manifest: 'settings.installModuleErrorNoManifest',
  path_not_found: 'settings.installModuleErrorPathNotFound',
  exists: 'settings.installModuleErrorExists',
  busy: 'settings.installModuleErrorBusy',
  not_writable: 'settings.installModuleErrorNotWritable',
  not_a_module: 'settings.installModuleErrorNotAModule',
  // Die einzige 403 dieser Routen: test:api fuehrt sie als Grund, den diese
  // Datei liest (REASONS_READ_BY_A_PAGE), und sucht ihn hier in Anfuehrungszeichen.
  'module_session_required':'settings.installModuleErrorSessionRequired',
  // Nur beim Loeschen (modules-active.js nutzt dieselbe Abbildung). `bad_id`
  // bietet die Seite gar nicht erst an (isDeletableModuleId); kommt es doch,
  // etwa von einer aelteren offenen Seite, soll es lesbar sein.
  not_found: 'settings.moduleDeleteErrorNotFound',
  bad_id: 'settings.moduleDeleteErrorBadId',
});

/**
 * Meldung zu einem fehlgeschlagenen Installieren oder Loeschen. Bekannte
 * `reason` lokalisiert; `bad_manifest` nennt dazu den Grund des Loaders
 * (englisch, aber konkret: welches Feld fehlt). Unbekanntes faellt auf den
 * Servertext zurueck, dann auf den allgemeinen Satz. Exportiert fuer die Tests
 * und fuer den Loeschen-Toast in modules-active.js.
 */
export function installErrorText(error) {
  const reason = error?.data?.reason;
  const serverText = typeof error?.data?.error === 'string' ? error.data.error : '';
  if (reason === 'bad_manifest') {
    return serverText
      ? t('settings.installModuleErrorBadManifest', { detail: serverText })
      : t('settings.installModuleErrorGeneric');
  }
  // GitHubs Limit nennt, wann es zurueckgesetzt wird - als Uhrzeit des
  // Betrachters ist das nuetzlicher als "spaeter".
  if (reason === 'rate_limited') {
    const resetAt = error?.data?.resetAt ? new Date(error.data.resetAt) : null;
    if (resetAt && !Number.isNaN(resetAt.getTime())) {
      return t('settings.installModuleErrorRateLimitedUntil', { time: formatTime(resetAt) });
    }
  }
  if (REASON_KEYS[reason]) return t(REASON_KEYS[reason]);
  // Ein 429 ohne bekannten reason (ein Proxy davor, ein aelterer Server) ist
  // trotzdem "zu oft" - nicht "fehlgeschlagen".
  if (error?.status === 429) return t('settings.installModuleErrorTooManyAttempts');
  return serverText || error?.message || t('settings.installModuleErrorGeneric');
}
