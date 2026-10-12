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
  // Die beiden 403 dieser Routen: test:api fuehrt sie als Gruende, die diese
  // Datei liest (REASONS_READ_BY_A_PAGE), und sucht sie hier in Anfuehrungszeichen.
  // `module_web_install_disabled`: der Betreiber hat MODULES_ALLOW_WEB_INSTALL
  // nicht gesetzt - das Blatt zeigt dann gar keine Knoepfe (installPageStatus);
  // der Satz faengt eine Seite, die vor dem Umschalten geladen wurde.
  'module_session_required':'settings.installModuleErrorSessionRequired',
  'module_web_install_disabled':'settings.installModuleErrorWebInstallDisabled',
  // `not_web_installed` kommt seit Review Runde 4 von BEIDEN Install-Routen:
  // modules/<id> liegt schon da, traegt aber keinen Installationsdatensatz
  // (von Hand kopiert, vielleicht ein Checkout mit offener Arbeit) - der
  // Server ersetzt ihn nicht (409, ohne `existing`), und das Blatt zeigt
  // diesen Satz statt der Ersetzen-Rueckfrage. Der Satz hier sagt, was zu tun
  // ist, um doch zu installieren; den Loeschen-Toast siehe DELETE_REASON_KEYS.
  not_web_installed: 'settings.installModuleErrorNotWebInstalled',
  // Nur beim Loeschen (modules-active.js, deleteErrorText). `bad_id` und
  // `not_web_installed` bietet die Seite gar nicht erst an
  // (isDeletableModule); kommen sie doch, etwa von einer aelteren offenen
  // Seite, sollen sie lesbar sein.
  not_found: 'settings.moduleDeleteErrorNotFound',
  bad_id: 'settings.moduleDeleteErrorBadId',
});

/**
 * Dieselben Gruende beim Loeschen, bis auf einen: `not_web_installed` heisst
 * dort "entferne den Ordner auf dem Server", nicht "... und installiere dann
 * neu". Literaler Schluessel aus demselben Grund wie oben.
 */
const DELETE_REASON_KEYS = Object.freeze({
  ...REASON_KEYS,
  not_web_installed: 'settings.moduleDeleteErrorNotWebInstalled',
});

function errorText(error, keys) {
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
  if (keys[reason]) return t(keys[reason]);
  // Ein 429 ohne bekannten reason (ein Proxy davor, ein aelterer Server) ist
  // trotzdem "zu oft" - nicht "fehlgeschlagen".
  if (error?.status === 429) return t('settings.installModuleErrorTooManyAttempts');
  return serverText || error?.message || t('settings.installModuleErrorGeneric');
}

/**
 * Meldung zu einem fehlgeschlagenen Installieren (und zum Umschalten in
 * "Aktive Module": PATCH enabled:true kann `busy` und `not_writable` nennen,
 * dieselben Saetze wie beim Installieren). Bekannte `reason` lokalisiert;
 * `bad_manifest` nennt dazu den Grund des Loaders (englisch, aber konkret:
 * welches Feld fehlt). Unbekanntes faellt auf den Servertext zurueck, dann auf
 * den allgemeinen Satz. Exportiert fuer die Tests und fuer modules-active.js.
 */
export function installErrorText(error) {
  return errorText(error, REASON_KEYS);
}

/** Meldung zu einem fehlgeschlagenen Loeschen (Toast in "Aktive Module"). */
export function deleteErrorText(error) {
  return errorText(error, DELETE_REASON_KEYS);
}
