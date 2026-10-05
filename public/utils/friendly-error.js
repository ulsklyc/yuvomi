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
 * Grund einer Absage (403, `reason` im Rumpf) -> Schluessel ihres Satzes.
 *
 * EINE Liste fuer beide Stellen: api.js uebersetzt damit `message` und
 * `data.error`, friendlyError reicht denselben Satz durch. Eine Map, damit ein
 * Grund wie `__proto__` nichts findet.
 *
 * Hier steht nur, was fuer JEDE Seite dasselbe heisst. Gruende, die eine Seite
 * selbst liest (Kalender-Anhang, Ordner loeschen, Anmeldung), und solche ohne
 * eigenen Satz fuehrt test:api als Liste - ein neuer `reason` am Server muss
 * sich dort einordnen.
 */
export const REFUSAL_MESSAGES = new Map([
  ['module_access_denied', 'common.errorModuleNoAccess'],
  ['module_read_only', 'settings.permReadOnlyBanner'],
  ['task_locked', 'tasks.errorLocked'],
  ['recipe_mirrored', 'recipes.errorMirrored'],
  // api.js holt bei einer 403 auf einen Schreibzugriff einmal ein frisches
  // Token und wiederholt. Diesen Satz sieht also nur, wem das nicht half.
  ['csrf_invalid', 'common.errorFormExpired'],
  ['contact_email_protected', 'contacts.emailLockedHint'],
]);

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
  //
  // Nennt die Absage einen Grund, fuer den es einen Satz gibt, dann dieser: er
  // sagt mehr (nur lesen, gesperrte Aufgabe, gespiegeltes Rezept). Nachgeschlagen
  // wird am Grund, nicht am Text des Fehlers - ein unbekannter oder gar kein
  // Grund ergibt den allgemeinen Satz, nie den englischen des Servers.
  if (status === 403) return t(REFUSAL_MESSAGES.get(err?.data?.reason) ?? 'common.errorNoPermission');
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.errorServer');
  if (err?.name === 'TypeError') return t('common.unexpectedError');
  return err?.data?.error || err?.message || t('common.errorGeneric');
}
