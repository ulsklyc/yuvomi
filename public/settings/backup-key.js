/**
 * Modul: Einstellungen (Settings) - Schluessel eines fremden Backups (#1267)
 * Zweck: Feld, Kodierung und Sichtbarkeitsregel fuer den Backup-Schluessel im
 *        Restore-Dialog. Eigenes Modul, damit die Regel im Node-Test als
 *        Programm laeuft und nicht nur als Text geprueft wird.
 * Abhängigkeiten: /i18n.js
 */

import { t } from '/i18n.js';

const HINT_ID = 'backup-restore-key-hint';
const HTTP_ID = 'backup-restore-key-http';
/** Fehlerbox des Restore-Formulars; sie steht in admin-backup.js. */
export const RESTORE_ERROR_ID = 'backup-restore-error';

/**
 * Wert fuer `aria-describedby` des Feldes. Ueber HTTP gehoert die Warnung
 * dazu: der Fokus springt beim Einblenden direkt ins Feld, und ohne die
 * Verknuepfung hoerte ein Screenreader-Nutzer sie nie. Ueber HTTPS gehoert sie
 * NICHT dazu - ein per `aria-describedby` verknuepftes Element wird auch dann
 * vorgelesen, wenn es `hidden` ist (accname), die Warnung kaeme also falsch.
 *
 * Die Fehlerbox gehoert nur dazu, solange sie sichtbar ist - aus demselben
 * Grund: eine versteckte alte Meldung kaeme sonst mit. Ohne den Verweis hoerte
 * ein Screenreader sie aber gar nicht im Zusammenhang mit dem Feld: der Fokus
 * springt hinein, und `role="alert"` kuendigt die Meldung nur beim Erscheinen an.
 * @param {string} protocol  `window.location.protocol`
 * @param {{ withError?: boolean }} [options]
 */
export function keyFieldDescribedBy(protocol, { withError = false } = {}) {
  const ids = protocol === 'http:' ? [HINT_ID, HTTP_ID] : [HINT_ID];
  if (withError) ids.push(RESTORE_ERROR_ID);
  return ids.join(' ');
}

/** Markup des Feldes; `aria-describedby` setzt `keyFieldDescribedBy()` beim Einblenden. */
export function backupKeyFieldHtml(protocol = '') {
  return `
            <div class="form-group" id="backup-restore-key-group" hidden>
              <label class="form-label" for="backup-restore-key">${t('settings.backupRestoreKeyLabel')}</label>
              <input class="form-input" type="password" id="backup-restore-key"
                autocomplete="off" autocapitalize="off" spellcheck="false"
                aria-describedby="${keyFieldDescribedBy(protocol)}" />
              <p class="form-hint" id="${HINT_ID}">${t('settings.backupRestoreKeyHint')}</p>
              <p class="form-hint form-hint--danger" id="${HTTP_ID}" hidden>${t('settings.backupRestoreKeyHttpWarning')}</p>
            </div>`;
}

/** Gruende, bei denen der Schluessel des Backups weiterhilft: Feld zeigen. */
const SHOW_REASONS = new Set(['backup_key_required', 'backup_key_wrong', 'backup_key_invalid']);
/**
 * Gruende, bei denen die Datei das Problem ist und nicht der Schluessel:
 * `backup_damaged` gibt es nur mit bewiesen richtigem Schluessel,
 * `backup_unreadable` auch VOR seiner Pruefung (etwa fehlendes Leserecht beim
 * Kopieren) - dort ist er nicht widerlegt. `backup_corrupt` meldet die
 * Integritaetspruefung nach dem Oeffnen (#1422), bei einem fremden Backup also
 * erst nach dem Umschluesseln mit dem richtigen Schluessel. Feld und Wert
 * bleiben, damit der zweite Versuch mit einer neu geholten Datei nicht am
 * Abtippen scheitert. `restore_in_progress` (ein anderer Restore laeuft noch)
 * sagt ueber Datei und Schluessel gar nichts - auch dann bleibt beides.
 */
const KEEP_REASONS = new Set(['backup_damaged', 'backup_unreadable', 'backup_corrupt', 'restore_in_progress', 'restore_busy']);

/**
 * Was nach einem gescheiterten Restore mit dem Feld geschieht.
 * `own_key_missing` setzt zurueck: ohne eigenen Schluessel lehnt der Server
 * jeden Backup-Schluessel ab.
 * @param {string | undefined} reason
 * @returns {'show' | 'keep' | 'reset'}
 */
export function keyFieldAfterError(reason) {
  if (SHOW_REASONS.has(reason)) return 'show';
  if (KEEP_REASONS.has(reason)) return 'keep';
  return 'reset';
}

/** Saetze aneinander; nach dem CJK-Punkt „。" ohne Leerzeichen. */
function sentences(...parts) {
  return parts.reduce((text, part) => (text.endsWith('。') ? text + part : `${text} ${part}`));
}

/**
 * Grund aus server/db.js bzw. server/routes/backup.js -> Text. Die Schluessel
 * stehen ausgeschrieben da, damit die i18n-Guards sie als Aufruf finden.
 */
export const REASON_TEXT = Object.freeze({
  backup_key_required: () => t('settings.backupRestoreErrorKeyRequired'),
  // Beide Texte nennen auch den ANDEREN Ausgang, wie ihre Servertexte
  // (`nenntSchluesselUndAlternative()` in test-db-encryption.js): ohne
  // Klartext-Kopf ist die Datei verschluesselt ODER keine Datenbank, und
  // SQLite sagt nicht, welches. Die Alternative ist ein eigener Key, damit ein
  // Test sie in jeder Sprache strukturell nachweisen kann.
  backup_key_wrong: () => sentences(
    t('settings.backupRestoreErrorKeyWrong'),
    t('settings.backupRestoreErrorKeyRightButNotDb'),
    t('settings.backupRestoreErrorNothingChanged'),
  ),
  backup_key_invalid: () => t('settings.backupRestoreErrorKeyInvalid'),
  own_key_missing: () => sentences(
    t('settings.backupRestoreErrorOwnKeyMissing'),
    t('settings.backupRestoreErrorNeverEncrypted'),
    t('settings.backupRestoreErrorNothingChanged'),
  ),
  backup_damaged: () => t('settings.backupRestoreErrorDamaged'),
  backup_unreadable: () => t('settings.backupRestoreErrorUnreadable'),
  // Ohne Satz ueber den Schluessel: auch ein Klartext-Backup kann es treffen.
  backup_corrupt: () => t('settings.backupRestoreErrorCorrupt'),
  restore_in_progress: () => t('settings.backupRestoreErrorInProgress'),
  // Noch laufende Arbeit, der Restore hat nach seiner Frist aufgegeben (#1431).
  restore_busy: () => t('settings.backupRestoreErrorBusy'),
});

/**
 * Text fuer die Fehlerbox nach einem gescheiterten Restore.
 *
 * Der Server schreibt seine Auskunft englisch und ausfuehrlich (bis zu 944
 * Zeichen) - fuer das Log und die Kommandozeile. Im Dialog zaehlt der
 * `reason`: jeder bekannte Grund hat einen knappen, uebersetzten Text mit dem
 * naechsten Schritt, ein unbekannter den allgemeinen. Die Servermeldung wird
 * NICHT angehaengt; sie steht im Server-Log, und die Texte sagen das.
 *
 * Ohne `reason` bleibt es bei der Servermeldung, wie in `twoFactorErrorText()`
 * (personal-account.js): diese Fehler tragen ihren Inhalt nur im Text, etwa
 * „Backup aus einer neueren Yuvomi-Version, erst aktualisieren". Ein
 * allgemeiner Text verloere genau den naechsten Schritt.
 * @param {{ message?: string, data?: { reason?: string } } | undefined} err
 * @returns {string}
 */
export function restoreErrorText(err) {
  const reason = err?.data?.reason;
  if (!reason) return err?.message || t('common.errorGeneric');
  return Object.hasOwn(REASON_TEXT, reason)
    ? REASON_TEXT[reason]()
    : t('settings.backupRestoreErrorGeneric');
}

/** Base64 der UTF-8-Bytes - so erwartet der Server `X-Backup-Key`. */
export function encodeBackupKey(key) {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
