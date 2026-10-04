/**
 * Modul: Fehler -> Satz
 * Zweck: friendlyError - der eine Satz, den die App fuer einen Fehler zeigt, den
 *        keine Seite selbst behandelt (Fehlerbildschirm, unbehandelte Rejection,
 *        window.yuvomi.friendlyError). Aus router.js hierher gezogen (#1640),
 *        damit die Zuordnung ohne Browser pruefbar ist:
 *        test/test-friendly-error.js.
 * Abhaengigkeiten: i18n.js
 */
import { t } from '/i18n.js';

/**
 * @param {unknown} err - ApiError (status, data), ein Netzfehler oder irgendein Wurf
 * @returns {string} uebersetzter Satz, oder der Text des Fehlers selbst
 */
export function friendlyError(err) {
  // Offline-Mutation (ApiError status 0): spezifische Meldung - auch wenn
  // navigator.onLine faelschlich true meldet (Netz weg, aber kein offline-Event).
  if (err?.status === 0) return t('common.errorOfflineMutation');
  if (!navigator.onLine) return t('common.errorOffline');
  // Vor dem Status-Zweig: ein 503 waehrend eines Restores ist kein Serverfehler (#1431).
  if (err?.data?.reason === 'restore_in_progress') return t('common.errorRestoreInProgress');
  const status = err?.status ?? err?.response?.status;
  // EIN Satz fuer "das darfst du nicht" (#1640), derselbe wie in api.js. Bis
  // dahin stand hier ein zweiter ("Zugriff verweigert. Bitte erneut anmelden."),
  // und der riet zur Anmeldung, wo die Sitzung in Ordnung war: eine abgelaufene
  // Sitzung ist ein 401 und laeuft ueber auth:expired, nie hier durch.
  if (status === 403) return t('common.errorNoPermission');
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.errorServer');
  if (err?.name === 'TypeError') return t('common.unexpectedError');
  return err?.data?.error || err?.message || t('common.errorGeneric');
}
