// --------------------------------------------------------
// Inbound-Löschungen für synchronisierte Kalender (#508).
//
// Termine, die ein Server nicht mehr ausliefert, müssen lokal verschwinden. Ohne
// diesen Schritt bleiben in iCloud/Nextcloud gelöschte Termine für immer stehen,
// weil die Inbound-Syncs sonst nur upserten.
//
// Geteilt von caldav-sync.js und apple-calendar.js. Google braucht das nicht: dort
// meldet der Sync-Token-Delta Löschungen aktiv als `status: 'cancelled'`. ICS auch
// nicht: dort ist der Feed ein einzelner atomarer Request.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
const log = createLogger('CalendarPrune');

/**
 * Entfernt lokal die Termine eines externen Kalenders, die der Server nicht mehr
 * ausliefert.
 *
 * Der Scope ist strikt `calendar_ref_id` + `source`: lokale Termine und noch nicht
 * hochgeladene Outbound-Termine (`external_source = 'local'`) bleiben unangetastet.
 *
 * `calendarUids` sind die UIDs, die genau dieser Kalender geliefert hat, und dienen
 * nur dem Leer-Guard. Verglichen wird gegen `accountUids` (alle UIDs des Accounts),
 * damit ein zwischen zwei Kalendern verschobener Termin nicht gelöscht und unter
 * neuer ID wieder angelegt wird — das würde seine Zuweisungen verlieren.
 *
 * Leer-Guard: Liefert ein Kalender keine einzige UID, obwohl lokal Termine an ihm
 * hängen, wird nicht gelöscht. Ein leeres Fetch-Ergebnis ist weit häufiger ein
 * stiller Server- oder Auth-Fehler als ein tatsächlich geleerter Kalender, und der
 * Preis für die falsche Annahme wäre der Totalverlust des Kalenders.
 *
 * @param {object} database          Datenbank-Handle
 * @param {object} opts
 * @param {number} opts.calRefId     external_calendars.id des Kalenders
 * @param {Set}    opts.calendarUids UIDs, die dieser Kalender geliefert hat
 * @param {Set}    [opts.accountUids] Alle UIDs des Accounts (default: calendarUids)
 * @param {string} [opts.source]     external_source-Wert ('caldav' | 'apple')
 * @param {string} [opts.calendarName] Nur für die Log-Ausgabe
 * @param {number} [opts.accountId]  CalDAV-Konto, dessen Abruf das ist (#1860).
 *   Dann fallen nur Termine DIESES Kontos: führen zwei Konten denselben
 *   Kalender oder dieselbe UID, sagt der Abruf des einen nichts über den
 *   Termin des anderen, und eine Zeile ohne Konto hat niemand abgerufen.
 *   Ohne Angabe (Apple) zählt wie bisher nur Kalender und Quelle.
 * @returns {number} Anzahl gelöschter Termine.
 */
export function pruneDeletedEvents(database, {
  calRefId,
  calendarUids,
  accountUids = calendarUids,
  source = 'caldav',
  calendarName = null,
  accountId = null,
} = {}) {
  const localEvents = accountId == null
    ? database.prepare(`
      SELECT id, external_calendar_id FROM calendar_events
      WHERE calendar_ref_id = ? AND external_source = ?
    `).all(calRefId, source)
    : database.prepare(`
      SELECT id, external_calendar_id FROM calendar_events
      WHERE calendar_ref_id = ? AND external_source = ? AND caldav_account_id = ?
    `).all(calRefId, source, accountId);

  const stale = localEvents.filter(ev => !accountUids.has(ev.external_calendar_id));
  if (stale.length === 0) return 0;

  if (calendarUids.size === 0) {
    const label = calendarName ? `"${calendarName}"` : `ref ${calRefId}`;
    log.warn(
      `Calendar ${label}: server returned no events, but ${stale.length} exist locally. ` +
      `Skipping deletion — assuming a fetch error rather than an emptied calendar.`
    );
    return 0;
  }

  const del = database.prepare('DELETE FROM calendar_events WHERE id = ?');
  for (const ev of stale) del.run(ev.id);

  return stale.length;
}

// --------------------------------------------------------
// Aufräumen auf Wunsch des Nutzers (#732).
//
// Etwas anderes als der Prune darüber, obwohl beide Termine löschen: dort
// entscheidet der Server ("der Kalender liefert diesen Termin nicht mehr"), hier
// der Mensch ("ich will diesen Kalender in Yuvomi nicht mehr sehen"). Deshalb
// kein Leer-Guard und kein UID-Abgleich - die Auswahl ist die Ansage.
//
// LOKAL, NICHT NACH AUSSEN: Gelöscht wird mit einem direkten DELETE, ohne
// `queueEventDeletion`. Der Fremdkalender bleibt unberührt, und das ist der
// Zweck: Wer einen Kalender abwählt, räumt seine Kopie weg und nicht das
// Original beim Anbieter. Ein Tombstone hier würde beim nächsten Lauf die
// Termine in iCloud/Nextcloud löschen - aus einem Aufräumen würde ein
// Datenverlust bei allen anderen Clients derselben Familie.
// --------------------------------------------------------

/** Die external_calendars-Zeilen eines Kalenders bzw. aller Kalender einer Auswahl. */
function calendarRefIds(database, externalIds) {
  if (!externalIds.length) return [];
  const marks = externalIds.map(() => '?').join(',');
  return database.prepare(
    `SELECT id FROM external_calendars WHERE source IN ('caldav','apple') AND external_id IN (${marks})`
  ).all(...externalIds).map((r) => r.id);
}

/**
 * Wie viele lokal gespiegelte Termine hängen an diesen Kalendern?
 *
 * Die Zahl steht in der Rückfrage, bevor gelöscht wird - eine Frage ohne Zahl
 * ("Termine löschen?") lässt den Nutzer raten, ob es drei oder dreihundert sind.
 *
 * @param {object} database
 * @param {string[]} externalIds  calendar_url je Kalender (external_calendars.external_id)
 * @param {{accountId?: number}} [scope] nur die Termine dieses CalDAV-Kontos (#1860):
 *   dieselbe Kalender-URL kann in der Auswahl zweier Konten stehen
 * @returns {number}
 */
export function countMirroredEvents(database, externalIds, { accountId = null } = {}) {
  const refIds = calendarRefIds(database, externalIds);
  if (!refIds.length) return 0;
  const marks = refIds.map(() => '?').join(',');
  const ofAccount = accountId == null ? '' : ' AND caldav_account_id = ?';
  return database.prepare(
    `SELECT COUNT(*) AS n FROM calendar_events
     WHERE calendar_ref_id IN (${marks}) AND external_source IN ('caldav','apple')${ofAccount}`
  ).get(...refIds, ...(accountId == null ? [] : [accountId])).n;
}

/**
 * Entfernt die lokal gespiegelten Termine dieser Kalender.
 *
 * Der Scope ist derselbe wie beim Prune: `calendar_ref_id` + gespiegelte Quelle.
 * Lokale Termine bleiben unangetastet, auch wenn sie diesen Kalender als
 * Hochladeziel tragen - sie sind noch nirgends gespiegelt, es gäbe nichts
 * aufzuräumen.
 *
 * Lokal BEARBEITETE Termine (`user_modified`) gehen bewusst mit: Wer "alle
 * Termine dieses Kalenders löschen" wählt, meint alle. Eine stille Ausnahme
 * liesse einzelne Zeilen zurück, deren Herkunft danach niemand mehr erkennt,
 * und die Rückfrage hätte eine Zahl genannt, die nicht stimmt.
 *
 * @param {{accountId?: number}} [scope] nur die Termine dieses CalDAV-Kontos (#1860)
 * @returns {number} Anzahl gelöschter Termine
 */
export function deleteMirroredEvents(database, externalIds, { accountId = null } = {}) {
  const refIds = calendarRefIds(database, externalIds);
  if (!refIds.length) return 0;
  const marks = refIds.map(() => '?').join(',');
  const ofAccount = accountId == null ? '' : ' AND caldav_account_id = ?';
  const result = database.prepare(
    `DELETE FROM calendar_events
     WHERE calendar_ref_id IN (${marks}) AND external_source IN ('caldav','apple')${ofAccount}`
  ).run(...refIds, ...(accountId == null ? [] : [accountId]));
  const removed = Number(result.changes) || 0;
  if (removed) log.info(`Removed ${removed} mirrored event(s) on user request.`);
  return removed;
}

/**
 * Wie viele gespiegelte Termine gehören diesem CalDAV-Konto (#1860)? Über das
 * Konto der Zeile, nicht über die Kalender seiner Auswahl: ein Termin gehört
 * seinem Konto auch dann noch, wenn sein Kalender dort nicht mehr geführt wird.
 */
export function countAccountEvents(database, accountId) {
  return database.prepare(
    "SELECT COUNT(*) AS n FROM calendar_events WHERE external_source = 'caldav' AND caldav_account_id = ?"
  ).get(accountId).n;
}

/**
 * Entfernt die lokal gespiegelten Termine dieses CalDAV-Kontos. Lokal, nicht
 * nach aussen - wie `deleteMirroredEvents`.
 * @returns {number} Anzahl gelöschter Termine
 */
export function deleteAccountEvents(database, accountId) {
  const result = database.prepare(
    "DELETE FROM calendar_events WHERE external_source = 'caldav' AND caldav_account_id = ?"
  ).run(accountId);
  const removed = Number(result.changes) || 0;
  if (removed) log.info(`Removed ${removed} mirrored event(s) on user request.`);
  return removed;
}

// --------------------------------------------------------
// Aufräumen nach dem Trennen eines Kontos (#820).
//
// Das Trennen löscht Tokens und Kalenderauswahl, nicht aber die schon gespiegelten
// Termine. Die bleiben als Waisen liegen: ihr `calendar_ref_id` zeigt ins Leere, kein
// Sync fasst sie je wieder an, und beim erneuten Verbinden legt der Inbound sie unter
// neuen Zeilen nochmal an - sichtbar als Dubletten, am deutlichsten bei Serien. Von
// Hand ist das nicht zu räumen: es gibt nur das Löschen je Termin.
//
// Der Scope ist die Quelle, nicht der Kalender: nach dem Trennen ist die
// Kalenderzuordnung gerade das, was fehlt. Lokale Termine (`external_source = 'local'`)
// bleiben unangetastet - auch die, die auf einen Upload warten.
//
// LOKAL, NICHT NACH AUSSEN: wie beim Aufräumen darüber ein direktes DELETE ohne
// Tombstone. Wer seine Kopie wegräumt, löscht nicht den Kalender beim Anbieter.
// --------------------------------------------------------

/**
 * Wie viele Termine dieser Sync-Quelle liegen lokal? Die Zahl steht in der Rückfrage.
 *
 * @param {object} database
 * @param {string} source  external_source-Wert ('google' | 'apple')
 * @returns {number}
 */
export function countSourceEvents(database, source) {
  return database.prepare(
    'SELECT COUNT(*) AS n FROM calendar_events WHERE external_source = ?'
  ).get(source).n;
}

/**
 * Entfernt alle lokal gespiegelten Termine dieser Sync-Quelle.
 *
 * @param {object} database
 * @param {string} source  external_source-Wert ('google' | 'apple')
 * @returns {number} Anzahl gelöschter Termine
 */
export function deleteSourceEvents(database, source) {
  const result = database.prepare(
    'DELETE FROM calendar_events WHERE external_source = ?'
  ).run(source);
  const removed = Number(result.changes) || 0;
  if (removed) log.info(`Removed ${removed} mirrored ${source} event(s) on user request.`);
  return removed;
}
