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
  // Bezahlen ohne das Recht, Betraege der Haushaltshilfe zu sehen (R20).
  ['amounts_hidden', 'housekeeping.errorAmountsHidden'],
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
  // Abfuhr (#1909). Die acht "gibt es nicht mehr" stehen auch in GONE_REASONS.
  // `waste_occurrence_not_found`: der Termin wurde inzwischen geaendert, die
  // Abholung, die verschoben oder ausgesetzt werden sollte, steht nicht mehr
  // im Plan. `waste_override_not_found` sieht nur, wer ihn anders als ueber
  // "Zuruecksetzen" erreicht - dort ist er ein Erfolg (isAlreadyDeleted).
  ['waste_type_not_found', 'waste.errorTypeGone'],
  // Nicht die Abfallart, um die es geht, sondern die im Formular GEWAEHLTE
  // fehlt (Termin, Abholung, Zuordnung, Import): ein eigener Grund, damit
  // `waste_type_not_found` nur eines heisst. Die Seite haelt den Dialog dann
  // offen und frischt die Auswahl auf, statt ihn zu schliessen.
  ['waste_selected_type_not_found', 'waste.errorSelectedTypeGone'],
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
  // Import einer Datei oder einer Adresse. Die Grenzen tragen ihre Zahl als
  // Parameter (CASE_PARAMS). Die drei ohne Praefix sind aelter als die Regel
  // (#1795) und Teil der zugesagten API - sie bleiben, wie sie heissen.
  ['waste_import_empty_file', 'waste.errorImportEmpty'],
  ['waste_import_file_too_large', 'waste.errorImportTooLarge'],
  ['waste_import_event_cap_exceeded', 'waste.errorImportTooManyEvents'],
  ['waste_import_instance_cap_exceeded', 'waste.errorImportTooManyPickups'],
  ['waste_import_label_cap_exceeded', 'waste.errorImportTooManyLabels'],
  // #1938: eine Datei ohne einen einzigen Kalendereintrag ist kein Kalender.
  ['waste_import_no_events', 'waste.errorImportNoEvents'],
  ['preview_changed', 'waste.importPreviewChangedError'],
  ['source_changed', 'waste.importSourceChangedError'],
  ['waste_profile_invalid', 'waste.mappingProfileInvalidFile'],
  ['waste_profile_changed', 'waste.errorProfileChanged'],
  // Quelle mit Adresse: Eingaben des Dialogs, der Handabruf, und je Klasse
  // eines gescheiterten Abrufs EIN Grund (server/services/waste-url-source.js).
  ['waste_source_url_invalid', 'waste.errorSourceUrlInvalid'],
  ['waste_source_url_not_https', 'waste.errorSourceUrlNotHttps'],
  ['waste_source_interval_invalid', 'waste.errorSourceInterval'],
  ['waste_source_not_url', 'waste.errorSourceNotUrl'],
  ['refresh_in_progress', 'waste.errorSourceRefreshRunning'],
  ['waste_source_fetch_http_status', 'waste.errorSourceFetchStatus'],
  ['waste_source_fetch_too_large', 'waste.errorSourceFetchTooLarge'],
  ['waste_source_fetch_blocked', 'waste.errorSourceFetchBlocked'],
  ['waste_source_fetch_unreachable', 'waste.errorSourceFetchUnreachable'],
  // #1938: die Adresse hat geantwortet, aber ohne einen Kalendereintrag. Die
  // bisherigen Abholungen bleiben, der Satz sagt das.
  ['waste_source_fetch_no_events', 'waste.errorSourceFetchNoEvents'],
  // Gesundheit (#1909). Die "gibt es nicht mehr" stehen auch in GONE_REASONS.
  // Der Server sagt 404 auch, wenn die Betreuung fuer diese Person inzwischen
  // entzogen wurde; die Seite laedt dann nach und zeigt den Eintrag nur noch
  // lesend. Unterschieden wird das bewusst nicht (dieselbe Antwort wie fuer
  // einen fremden privaten Eintrag).
  ['health_vital_not_found', 'health.errorVitalGone'],
  // Harte Grenzen der Vitalwerte (Critique R19, server/routes/health/vital-limits.js).
  // Das Formular prueft dieselben vorher; diese Saetze sieht, wer per Import
  // oder einem aelteren Tab an ihm vorbei schreibt.
  ['health_vital_out_of_range', 'health.errorVitalImpossible'],
  ['health_vital_bp_order', 'health.errorVitalBpOrder'],
  ['health_medication_not_found', 'health.errorMedicationGone'],
  ['health_schedule_not_found', 'health.errorScheduleGone'],
  ['health_dose_not_found', 'health.errorDoseGone'],
  ['health_lab_report_not_found', 'health.errorLabReportGone'],
  ['health_lab_result_not_found', 'health.errorLabResultGone'],
  ['health_activity_not_found', 'health.errorActivityGone'],
  ['health_prevention_type_not_found', 'health.errorPreventionTypeGone'],
  // Die im Vorsorge-Dialog GEWAEHLTE Art fehlt: der Dialog bleibt offen und
  // frischt die Auswahl auf (wie `waste_selected_type_not_found`).
  ['health_prevention_selected_type_not_found', 'health.errorSelectedPreventionTypeGone'],
  ['health_prevention_record_not_found', 'health.errorPreventionRecordGone'],
  ['health_nutrition_entry_not_found', 'health.errorNutritionEntryGone'],
  ['health_cycle_period_not_found', 'health.errorPeriodGone'],
  ['health_cycle_log_not_found', 'health.errorCycleDayGone'],
  // Import der Perioden-Historie: was eine eingefuegte oder gewaehlte Datei
  // erreicht. Die Zeilenfehler zeigt der Dialog selbst als Liste.
  ['health_cycle_import_too_large', 'health.errorCycleImportTooLarge'],
  ['health_cycle_import_no_rows', 'health.errorCycleImportNoRows'],
  ['health_cycle_import_too_many_rows', 'health.errorCycleImportTooManyRows'],
  // Dokumente (#1909). Die "gibt es nicht mehr" stehen auch in GONE_REASONS.
  // Die 404 eines Dokuments heisst auch "fuer dich nicht mehr sichtbar" (die
  // Sichtbarkeit wurde geaendert); der Satz sagt deshalb "nicht mehr
  // verfuegbar", und ein Loeschen mit diesem Grund ist kein Erfolg.
  ['documents_folder_not_found', 'documents.errorFolderGone'],
  // Nicht der Ordner, um den es geht, sondern der im Dialog oder in der
  // Auswahl GEWAEHLTE (Elternordner, Zielordner): der Dialog bleibt offen und
  // bietet die aktuellen Ordner an.
  ['documents_selected_folder_not_found', 'documents.errorSelectedFolderGone'],
  ['documents_folder_exists', 'documents.errorFolderExists'],
  ['documents_folder_too_deep', 'documents.errorFolderTooDeep'],
  // Aelter als die Regel und schon Teil der API: der Loeschdialog liest ihn
  // selbst (utils/document-folder-delete.js), Anlegen, Umbenennen und
  // Verschieben eines Ordners im selben Zweig erreichen ihn hier.
  ['FOLDER_DELETE_IN_PROGRESS', 'documents.folderDeleteInProgressToast'],
  ['documents_document_not_found', 'documents.errorDocumentGone'],
  ['documents_file_type_not_allowed', 'documents.errorFileTypeNotAllowed'],
  ['documents_file_content_mismatch', 'documents.errorFileContentMismatch'],
  ['documents_file_empty', 'documents.errorFileEmpty'],
  ['documents_storage_failed', 'documents.errorStorageFailed'],
  // Ein DMS verknuepfen oder dorthin senden (server/routes/dms.js).
  ['dms_account_not_found', 'documents.errorDmsAccountGone'],
  ['dms_document_not_found', 'documents.errorDmsDocumentGone'],
  ['dms_document_already_linked', 'documents.errorDmsAlreadyLinked'],
  ['dms_document_already_stored', 'documents.errorDmsAlreadyStored'],
  ['dms_unreachable', 'documents.dmsSearchError'],
  // Rezepte (#1909). Alle drei stehen auch in GONE_REASONS. Rezepte haben
  // keine Sichtbarkeit: die 404 heisst "geloescht" - von einem anderen
  // Haushaltsmitglied oder vom Abgleich mit einer Rezeptquelle. Ein Loeschen
  // mit diesem Grund ist deshalb ein Erfolg (isAlreadyDeleted).
  ['recipes_recipe_not_found', 'recipes.errorRecipeGone'],
  // Das Rezept steht, aber die Zutat nicht mehr darin (geaendert, oder der
  // Abgleich hat die Zutaten ersetzt).
  ['recipes_ingredient_not_found', 'recipes.errorIngredientGone'],
  // Die im Zuordnungs-Dialog GEWAEHLTE Vorratszeile fehlt: der Dialog bleibt
  // offen und bietet den aktuellen Vorrat an.
  ['recipes_selected_pantry_item_not_found', 'recipes.errorSelectedPantryItemGone'],
  // Eine Mahlzeit aus einem Rezept, das es nicht mehr gibt (server/routes/meals.js).
  ['meals_selected_recipe_not_found', 'recipes.errorRecipeGone'],
  // Abos (#1909). Die "gibt es nicht mehr" stehen auch in GONE_REASONS. Die
  // 404 eines Abos heisst nur "geloescht": die Schreibrouten lesen es ohne
  // Sichtbarkeitsfilter, ein fremdes privates Abo endet mit 403. Ein Loeschen
  // mit diesem Grund ist deshalb ein Erfolg (isAlreadyDeleted).
  ['subscriptions_subscription_not_found', 'subscriptions.errorSubscriptionGone'],
  // Ein abgeschlossenes Abo laesst sich nicht als bezahlt markieren (#2011).
  ['subscriptions_subscription_completed', 'subscriptions.errorSubscriptionCompleted'],
  ['subscriptions_category_not_found', 'subscriptions.errorCategoryGone'],
  ['subscriptions_payment_method_not_found', 'subscriptions.errorPaymentMethodGone'],
  // Nicht die Kategorie, um die es geht, sondern die im Abo-Dialog GEWAEHLTE:
  // der Dialog bleibt offen und bietet die aktuellen an.
  ['subscriptions_selected_category_not_found', 'subscriptions.errorSelectedCategoryGone'],
  ['subscriptions_selected_payment_method_not_found', 'subscriptions.errorSelectedPaymentMethodGone'],
  ['subscriptions_category_exists', 'subscriptions.errorCategoryExists'],
  ['subscriptions_payment_method_exists', 'subscriptions.errorPaymentMethodExists'],
  // Eingaben, die der Abo-Dialog durchlaesst und erst der Server prueft.
  ['subscriptions_end_before_next_payment', 'subscriptions.errorEndBeforeNextPayment'],
  ['subscriptions_occurrence_count_too_low', 'subscriptions.errorOccurrenceCountTooLow'],
  ['subscriptions_logo_content_mismatch', 'subscriptions.errorLogoContentMismatch'],
  // Die Logo-Suche hat geantwortet, aber nichts Brauchbares gefunden.
  ['subscriptions_no_logo_found', 'subscriptions.logoSearchEmpty'],
]);

/**
 * Welche ZAHLEN ein Satz aus der Antwort einsetzen darf: Grund -> Namen (#1909).
 * Der Server gibt sie strukturiert mit (`params` neben `reason`), der Satz
 * traegt sie als `{{name}}`.
 *
 * Eine ALLOWLIST je Grund: nur diese Namen kommen in den Satz, nie ein
 * beliebiges Feld der Antwort, und nur als ganze Zahl (readParams). Fehlt eine
 * oder ist sie keine, sagt die App den allgemeinen Satz der Stelle - ein Satz
 * mit einem leeren Platzhalter waere schlechter als keiner. `count` steht hier
 * nie: der Name waehlt in t() die Pluralform.
 */
export const CASE_PARAMS = new Map([
  ['waste_import_file_too_large', ['limit_mb']],
  ['waste_import_event_cap_exceeded', ['limit']],
  ['waste_import_instance_cap_exceeded', ['limit']],
  ['waste_import_label_cap_exceeded', ['limit']],
  ['waste_source_interval_invalid', ['min', 'max']],
  ['waste_source_fetch_http_status', ['status']],
  ['waste_source_fetch_too_large', ['limit_mb']],
  ['health_cycle_import_too_large', ['limit_kb']],
  ['health_cycle_import_too_many_rows', ['limit']],
  ['documents_folder_too_deep', ['limit']],
]);

const PARAM_MAX = 1_000_000_000;

/**
 * Die erlaubten Zahlen aus `params`, oder null, wenn eine fehlt oder keine ist.
 * Gelesen wird nur das eigene Feld eines schlichten Objekts; heraus kommt ein
 * neues Objekt mit genau den erlaubten Namen.
 */
function readParams(given, names) {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return null;
  const out = {};
  for (const name of names) {
    const value = Object.prototype.hasOwnProperty.call(given, name) ? given[name] : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > PARAM_MAX) return null;
    out[name] = value;
  }
  return out;
}

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
  'waste_selected_type_not_found',
  'waste_schedule_not_found',
  'waste_pickup_not_found',
  'waste_source_not_found',
  'waste_mapping_not_found',
  'waste_override_not_found',
  'waste_occurrence_not_found',
  'health_vital_not_found',
  'health_medication_not_found',
  'health_schedule_not_found',
  'health_dose_not_found',
  'health_lab_report_not_found',
  'health_lab_result_not_found',
  'health_activity_not_found',
  'health_prevention_type_not_found',
  'health_prevention_selected_type_not_found',
  'health_prevention_record_not_found',
  'health_nutrition_entry_not_found',
  'health_cycle_period_not_found',
  'health_cycle_log_not_found',
  'documents_folder_not_found',
  'documents_selected_folder_not_found',
  'documents_document_not_found',
  'dms_account_not_found',
  'dms_document_not_found',
  'recipes_recipe_not_found',
  'recipes_ingredient_not_found',
  'recipes_selected_pantry_item_not_found',
  'meals_selected_recipe_not_found',
  'subscriptions_subscription_not_found',
  'subscriptions_category_not_found',
  'subscriptions_payment_method_not_found',
  'subscriptions_selected_category_not_found',
  'subscriptions_selected_payment_method_not_found',
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
  // Eine Bremse (429) sagt "kurz warten" in der Sprache der Oberflaeche. Bis
  // dahin kam ihr englischer Servertext durch ("Too many requests. Please wait
  // a moment." in deutscher UI, Critique 2026-10-16). Ein Fall mit eigenem
  // Satz behaelt diesen.
  if (status === 429) return CASE_MESSAGES.get(reason) ?? 'common.errorRateLimited';
  return CASE_MESSAGES.get(reason);
}

/**
 * Der Satz zu `knownKey`, fertig uebersetzt - oder nichts. Traegt der Fall
 * Zahlen (CASE_PARAMS), setzt t() sie ein; fehlen sie, gibt es keinen Satz,
 * und der Aufrufer sagt seinen allgemeinen.
 *
 * @param {unknown} err
 * @returns {string|undefined}
 */
function knownSentence(err) {
  const key = knownKey(err);
  if (!key) return undefined;
  const reason = err?.data?.reason;
  // Nur am Fall selbst: eine Absage (403) oder Offline mit demselben `reason`
  // im Rumpf hat einen anderen Satz bekommen und setzt nichts ein.
  const names = CASE_MESSAGES.get(reason) === key ? CASE_PARAMS.get(reason) : undefined;
  if (!names) return t(key);
  const params = readParams(err?.data?.params, names);
  return params ? t(key, params) : undefined;
}

/**
 * DER EINE WEG FUER DIE SEITEN (#1909): aus einem gefangenen Fehler der Satz,
 * den ein Toast zeigt. Bekannter Fall -> sein Satz, alles andere -> der
 * allgemeine Satz der Stelle. Der Text des Servers (`err.data.error`,
 * `err.message`) kommt hier nie heraus; aus der Antwort stammen hoechstens die
 * Zahlen, die CASE_PARAMS fuer den Fall freigibt.
 *
 * @param {unknown} err
 * @param {string} [fallbackKey] - der allgemeine Satz dieser Stelle
 * @returns {string} uebersetzter Satz
 */
export function errorSentence(err, fallbackKey = 'common.errorGeneric') {
  return knownSentence(err) ?? t(fallbackKey);
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
 *   (400, 409, 422 ohne bekannten Grund) der Text des Servers
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
  const known = knownSentence(err);
  if (known) return known;
  const status = err?.status ?? err?.response?.status;
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.errorServer');
  if (err?.name === 'TypeError') return t('common.unexpectedError');
  // Jede andere Antwort des Servers (400, 409, 422 ohne bekannten Grund):
  // ihr eigener Text. Er nennt die Ursache (welches Feld, welcher Konflikt),
  // und der allgemeine Satz an seiner Stelle sagte weniger - das gilt, bis der
  // Aufrufer umgestellt ist und der Server den Fall mit einem `reason` benennt.
  return err?.data?.error || err?.message || t('common.errorGeneric');
}

/**
 * DER SATZ FUER EINEN FEHLGESCHLAGENEN LADEVORGANG (Critique R19, 2026-10-16) -
 * oder nichts, wenn die Ursache unbekannt ist.
 *
 * Bis hierher sagte jeder Ladefehler fest "Bitte pruefe die Verbindung", auch
 * bei einer Bremse (429) oder einem Serverfehler: die Familie suchte den Fehler
 * am eigenen WLAN, waehrend der Server nur kurz warten wollte. Die Zuordnung
 * ist die von friendlyError, mit EINEM Unterschied: der Text des Servers kommt
 * hier nie heraus. Bei einer unbekannten Ursache (400, 409 ohne Grund) bleibt
 * der allgemeine Satz des Aufrufers stehen - `mountLoadError` und der
 * Fehlerzustand der Shell nehmen ihn als Rueckfall.
 *
 * Der Statuscode steht NICHT im Satz: er gehoert in die aufklappbaren Details.
 *
 * @param {unknown} err
 * @returns {string|undefined}
 */
/**
 * Die 503 des Service Workers (`{ error: 'offline' }`, sw.js networkFirstApi):
 * keine Antwort des Servers, sondern kein Netz. Eine Stelle fuer die Frage,
 * damit niemand dafuer `err.data.error` selbst liest.
 */
export function isServiceWorkerOffline(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 503 && err?.data?.error === 'offline';
}

export function loadErrorSentence(err) {
  const status = err?.status ?? err?.response?.status;
  // Ohne Netz: der Browser weiss es (onLine), oder der Service Worker hat fuer
  // eine nicht gecachte Abfrage sein 503 `{ error: 'offline' }` geantwortet
  // (sw.js, networkFirstApi) - das ist kein Serverfehler.
  if (status === 0 || !navigator.onLine) return t('common.errorOffline');
  if (isServiceWorkerOffline(err)) return t('common.errorOffline');
  const known = knownSentence(err);
  if (known) return known;
  if (status === 404) return t('common.errorNotFound');
  if (status >= 500) return t('common.errorServer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return t('common.errorTimeout');
  // Keine Antwort, obwohl der Browser sich fuer online haelt: das Netz auf dem
  // Weg (WLAN, Proxy, Server aus). Genau dafuer ist der Verbindungssatz da.
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message || '')) return t('common.loadErrorDescription');
  return undefined;
}
