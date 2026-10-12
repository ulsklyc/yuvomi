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
 * Fall, den der Server benennt (`reason` an einer 400/404/409) -> Schluessel
 * seines Satzes (#1909). Die Fortsetzung von REFUSAL_MESSAGES ueber die 403
 * hinaus: der Server nennt den Fall, die App besitzt den Satz.
 *
 * Hier steht, was ein NUTZER erreichen kann (die Liste wurde inzwischen
 * geloescht, den Laden gibt es schon). Eine Validierung, die nur ein Aufrufer
 * der API ausloest, bekommt keinen Eintrag - sie faellt auf den allgemeinen
 * Satz. Die Gruende tragen ihr Modul im Namen, weil die Liste fuer alle Seiten
 * gilt. Eine Map, damit ein Grund wie `__proto__` nichts findet.
 */
export const CASE_MESSAGES = new Map([
  ['shopping_list_not_found', 'shopping.errorListGone'],
  ['shopping_item_not_found', 'shopping.errorItemGone'],
  ['shopping_store_not_found', 'shopping.errorStoreGone'],
  ['shopping_store_exists', 'shopping.errorStoreExists'],
  ['shopping_category_not_found', 'shopping.errorCategoryGone'],
  // Dieselben Gruende liest der Kategorie-Manager selbst (mit Zaehler, wo es
  // einen gibt); hier stehen die beiden ohne Zaehler, fuer jede andere Stelle.
  ['category_exists', 'category.errorExists'],
  ['category_last', 'category.errorLast'],
  // Abfuhr (#1909). Die sieben "gibt es nicht mehr" stehen auch in GONE_REASONS.
  // `waste_occurrence_not_found`: der Termin wurde inzwischen geaendert, die
  // Abholung, die verschoben oder ausgesetzt werden sollte, steht nicht mehr
  // im Plan. `waste_override_not_found` sieht nur, wer ihn anders als ueber
  // "Zuruecksetzen" erreicht - dort ist er ein Erfolg (isAlreadyDeleted).
  ['waste_type_not_found', 'waste.errorTypeGone'],
  ['waste_schedule_not_found', 'waste.errorScheduleGone'],
  ['waste_pickup_not_found', 'waste.errorPickupGone'],
  ['waste_source_not_found', 'waste.errorSourceGone'],
  ['waste_mapping_not_found', 'waste.errorMappingGone'],
  ['waste_override_not_found', 'waste.errorOverrideGone'],
  ['waste_occurrence_not_found', 'waste.errorOccurrenceGone'],
  ['waste_type_in_use', 'waste.typeDeleteRefused'],
  ['waste_pickup_exists', 'waste.pickupDuplicateError'],
  // Eingaben, die der Termin-Dialog durchlaesst und erst der Server prueft.
  ['waste_schedule_anchor_date_invalid', 'waste.errorScheduleAnchorRequired'],
  ['waste_schedule_ends_before_anchor', 'waste.errorScheduleEndsBeforeStart'],
  ['waste_schedule_weekdays_required', 'waste.errorScheduleWeekdaysRequired'],
  ['waste_schedule_interval_invalid', 'waste.errorScheduleInterval'],
  ['waste_schedule_month_day_invalid', 'waste.errorScheduleMonthDay'],
  ['waste_schedule_anchor_not_month_day', 'waste.errorScheduleAnchorNotMonthDay'],
  ['waste_schedule_anchor_not_last_day', 'waste.errorScheduleAnchorNotLastDay'],
  ['waste_schedule_anchor_not_ordinal_weekday', 'waste.errorScheduleAnchorNotWeekday'],
  ['waste_pickup_date_invalid', 'waste.errorDateRequired'],
  ['waste_override_date_invalid', 'waste.errorDateRequired'],
  ['waste_override_same_date', 'waste.errorOverrideSameDate'],
  ['waste_reminder_offset_invalid', 'waste.errorReminderOffset'],
  ['waste_reminder_time_invalid', 'waste.errorReminderTime'],
]);

/**
 * Gruende, die sagen: das Ding, auf das die Handlung zielte, gibt es nicht
 * mehr - der Stand der Seite ist also veraltet (jemand anderes im Haushalt hat
 * es geloescht). Die Seite laedt dann selbst nach, statt dem Nutzer dazu zu
 * raten (#1909); der Satz sagt nur noch, was passiert ist.
 *
 * Eine ALLOWLIST, kein Muster auf `_not_found` und nie der blanke Status 404:
 * ein Grund, den diese Liste nicht kennt, loest kein Nachladen aus. Jeder
 * Eintrag hat einen Satz in CASE_MESSAGES, und jeder `*_not_found` dort steht
 * hier - beides haelt test:friendly-error.
 */
export const GONE_REASONS = new Set([
  'shopping_list_not_found',
  'shopping_item_not_found',
  'shopping_store_not_found',
  'shopping_category_not_found',
  'waste_type_not_found',
  'waste_schedule_not_found',
  'waste_pickup_not_found',
  'waste_source_not_found',
  'waste_mapping_not_found',
  'waste_override_not_found',
  'waste_occurrence_not_found',
]);

/**
 * Sagt dieser Fehler, dass das Ziel der Handlung verschwunden ist?
 * Der Grund einer Absage (403) zaehlt nur an einer Absage - wie in `knownKey`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isGone(err) {
  const status = err?.status ?? err?.response?.status;
  return status !== 403 && GONE_REASONS.has(err?.data?.reason);
}

/**
 * War das LOESCHEN schon erledigt? Wer etwas loescht, das ein anderes
 * Haushaltsmitglied schon geloescht hat, bekommt "gibt es nicht mehr" - und hat
 * damit, was er wollte. Das ist kein Fehler, den die Seite melden muesste: kein
 * Toast, und die Zeile kommt nicht zurueck.
 *
 * Nur fuer den Loeschweg, und nur fuer den Grund des Dings, das geloescht
 * werden sollte: `reason` nennt der Aufrufer. Ein Loeschen, das an etwas
 * ANDEREM scheitert (die Liste des Artikels, ein unbekannter Grund, eine blanke
 * 404, eine Absage), bleibt ein Fehler. Abhaken oder Speichern auf einem
 * verschwundenen Ding fragen hier nie - sie behalten Toast und Nachladen.
 *
 * @param {unknown} err
 * @param {string} reason - der Grund "dieses Ding gibt es nicht mehr"
 * @returns {boolean}
 */
export function isAlreadyDeleted(err, reason) {
  return isGone(err) && err.data.reason === reason;
}

/**
 * Der Satz, den die App fuer diesen Fehler SICHER kennt - oder nichts.
 * Eine Stelle fuer friendlyError und errorSentence, damit beide dasselbe sagen.
 *
 * @param {unknown} err
 * @returns {string|undefined} Schluessel
 */
function knownKey(err) {
  // Offline-Mutation (ApiError status 0).
  if (err?.status === 0) return 'common.errorOfflineMutation';
  const reason = err?.data?.reason;
  // Ein 503 waehrend eines Restores ist kein Serverfehler (#1431).
  if (reason === 'restore_in_progress') return 'common.errorRestoreInProgress';
  const status = err?.status ?? err?.response?.status;
  // EIN Satz fuer "das darfst du nicht" (#1640), derselbe wie in api.js. Nennt
  // die Absage einen Grund, fuer den es einen Satz gibt, dann dieser. Der Grund
  // einer Absage zaehlt nur an einer Absage, und umgekehrt.
  if (status === 403) return REFUSAL_MESSAGES.get(reason) ?? 'common.errorNoPermission';
  return CASE_MESSAGES.get(reason);
}

/**
 * DER EINE WEG FUER DIE SEITEN (#1909): aus einem gefangenen Fehler der Satz,
 * den ein Toast zeigt. Bekannter Fall -> sein Satz, alles andere -> der
 * allgemeine Satz der Stelle. Der Text des Servers (`err.data.error`,
 * `err.message`) kommt hier nie heraus.
 *
 * @param {unknown} err
 * @param {string} [fallbackKey] - der allgemeine Satz dieser Stelle
 * @returns {string} uebersetzter Satz
 */
export function errorSentence(err, fallbackKey = 'common.errorGeneric') {
  return t(knownKey(err) ?? fallbackKey);
}

/**
 * UEBERGANG (#1909): der Satz fuer Aufrufer, die noch nicht umgestellt sind.
 * Jeder wandert mit der Scheibe seines Moduls zu `errorSentence`; bis dahin
 * sagt er hier nicht weniger als vor #1909. Bekannter Fall -> sein Satz, sonst
 * der Text des Servers (`err.data.error`), sonst der allgemeine Satz. Wer noch
 * hier fragt, steht als Zahl in test:frontend-audit (FRIENDLY_ERROR_CALLERS).
 *
 * @param {unknown} err - ApiError (status, data), ein Netzfehler oder irgendein Wurf
 * @returns {string} uebersetzter Satz, oder an einem Status ohne eigenen Satz
 *   (400, 409, 422, 429 ohne bekannten Grund) der Text des Servers
 */
export function friendlyError(err) {
  // Offline-Mutation (ApiError status 0): spezifische Meldung - auch wenn
  // navigator.onLine faelschlich true meldet (Netz weg, aber kein offline-Event).
  if (err?.status === 0) return t('common.errorOfflineMutation');
  if (!navigator.onLine) return t('common.errorOffline');
  // Nachgeschlagen wird am Grund, nicht am Text des Fehlers - an einer Absage
  // (403) ergibt ein unbekannter oder gar kein Grund den allgemeinen Satz, nie
  // den des Servers. Bis #1640 stand fuer die 403 ein zweiter Satz hier
  // ("Zugriff verweigert. Bitte erneut anmelden."), und der riet zur Anmeldung,
  // wo die Sitzung in Ordnung war: eine abgelaufene Sitzung ist ein 401 und
  // laeuft ueber auth:expired, nie hier durch.
  const known = knownKey(err);
  if (known) return t(known);
  const status = err?.status ?? err?.response?.status;
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.errorServer');
  if (err?.name === 'TypeError') return t('common.unexpectedError');
  // Jede andere Antwort des Servers (400, 409, 422, 429 ohne bekannten Grund):
  // ihr eigener Text. Er nennt die Ursache (welches Feld, welcher Konflikt),
  // und der allgemeine Satz an seiner Stelle sagte weniger - das gilt, bis der
  // Aufrufer umgestellt ist und der Server den Fall mit einem `reason` benennt.
  return err?.data?.error || err?.message || t('common.errorGeneric');
}
