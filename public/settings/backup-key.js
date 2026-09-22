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

/**
 * Wert fuer `aria-describedby` des Feldes. Ueber HTTP gehoert die Warnung
 * dazu: der Fokus springt beim Einblenden direkt ins Feld, und ohne die
 * Verknuepfung hoerte ein Screenreader-Nutzer sie nie. Ueber HTTPS gehoert sie
 * NICHT dazu - ein per `aria-describedby` verknuepftes Element wird auch dann
 * vorgelesen, wenn es `hidden` ist (accname), die Warnung kaeme also falsch.
 * @param {string} protocol  `window.location.protocol`
 */
export function keyFieldDescribedBy(protocol) {
  return protocol === 'http:' ? `${HINT_ID} ${HTTP_ID}` : HINT_ID;
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
 * Kopieren) - dort ist er nicht widerlegt. Feld und Wert bleiben, damit der
 * zweite Versuch mit einer neu geholten Datei nicht am Abtippen scheitert.
 */
const KEEP_REASONS = new Set(['backup_damaged', 'backup_unreadable']);

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

/** Base64 der UTF-8-Bytes - so erwartet der Server `X-Backup-Key`. */
export function encodeBackupKey(key) {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
