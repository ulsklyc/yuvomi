// --------------------------------------------------------
// Ausgehende Änderungen für CalDAV-Server (Issue #593).
//
// Geteilt vom generischen Multi-Account-Sync (caldav-sync.js) und vom
// Apple-Legacy-Sync (apple-calendar.js): beide sprechen dasselbe Protokoll und
// hätten sonst zwei Kopien derselben Logik.
//
// CalDAV kennt keinen Aufruf "ändere Event X in Kalender Y": ein Kalenderobjekt
// wird über SEINE eigene URL angefasst. Die URL steht seit Migration v106 in
// calendar_events.external_object_url; für Termine, die davor synchronisiert
// wurden, löst der laufende Sync sie über die UID der gerade geholten Objekte auf.
//
// EIN KONTO JE AUFRUF (#1860). Der generische Sync führt mehrere Konten, und
// jeder Durchgang hier arbeitet mit dem Client genau eines davon. Er bekommt
// deshalb das Konto genannt (`accountId`) und sieht nur dessen Zeilen und
// Löschaufträge. Welches Objekt gemeint ist, sagt dann der Abruf DIESES Kontos
// (`ObjectIndex`), und die Anfrage geht an die Adresse, die dieser Abruf
// genannt hat. Apple kennt kein Konto: ohne `accountId` gilt für beides der
// Stand von vorher.
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as outbound from './calendar-outbound.js';
import { patchICSEvent } from '../utils/ics-patch.js';
import { eventDateTimeFields, rruleForDtstart } from '../utils/ics-datetime.js';
import { householdTimeZone } from '../utils/timezone.js';
import * as db from '../db.js';
import { nearestIcalColorName } from '../utils/ical-color.js';
import { outboundEvent, outboundRecurrenceRule } from './outbound-dtstart.js';
import { icsSnapshot } from './outbound-echo.js';
import { findObjectWithUid } from '../utils/own-uid.js';
import { upsertExternalCalendar } from './external-calendars.js';
import { isOriginRefusal, sameObjectAddress } from '../utils/caldav-client.js';

const log = createLogger('CalDAVOutbound');

const label = (source) => (source === 'apple' ? 'Apple' : 'CalDAV');

/**
 * Die Kalenderobjekte, die ein Konto in EINEM Lauf geliefert hat.
 *
 * Nach aussen eine Map UID → { url, etag, data, calendarUrl }, wie bisher. Sie
 * merkt sich zusätzlich, an welcher Adresse und in welchem Kalender jedes
 * Objekt lag: dieselbe UID kann während eines Umzugs kurz in zwei Kalendern
 * eines Kontos stehen, und die Map allein behielte nur das zuletzt gesehene.
 */
export class ObjectIndex extends Map {
  #byUrl = new Map();
  #byCalendarUid = new Map();

  static #key(calendarUrl, uid) { return `${calendarUrl}\n${uid}`; }

  /** Eine fertige Map (Apple, Sofortversuch) als Index lesen. */
  static from(entries) {
    if (entries instanceof ObjectIndex) return entries;
    const index = new ObjectIndex();
    for (const [uid, entry] of entries ?? []) index.set(uid, entry);
    return index;
  }

  set(uid, entry) {
    super.set(uid, entry);
    if (entry?.url) {
      const known = this.#byUrl.get(entry.url);
      // Ein Objekt führt eine UID; trägt es mehrere, gilt für die Adresse die erste.
      if (!known || known.uid === null) this.#byUrl.set(entry.url, { uid, entry });
    }
    if (entry?.calendarUrl) this.#byCalendarUid.set(ObjectIndex.#key(entry.calendarUrl, uid), entry);
    return this;
  }

  /** Ein Objekt, aus dem sich kein Termin lesen liess: bekannt ist nur seine Adresse. */
  noteObject(entry) {
    if (entry?.url && !this.#byUrl.has(entry.url)) this.#byUrl.set(entry.url, { uid: null, entry });
  }

  /**
   * Die UID, die der Abruf an dieser Adresse gesehen hat: `undefined`, wenn er
   * dort nichts führt, `null` bei einem Objekt ohne lesbaren Termin.
   */
  uidAt(url) {
    return url ? this.#byUrl.get(url)?.uid : undefined;
  }

  /** Was der Abruf an genau dieser Adresse gesehen hat: `{ uid, entry }` oder `undefined`. */
  at(url) {
    return url ? this.#byUrl.get(url) : undefined;
  }

  /**
   * Das Objekt zu einer Zeile oder einem Löschauftrag, in dieser Reihenfolge:
   *   1. an genau der gespeicherten Adresse (wörtlich gleich), sofern dort
   *      diese UID liegt;
   *   2. mit dieser UID im Kalender der Zeile;
   *   3. mit dieser UID irgendwo im Konto (`anywhere`).
   *
   * @param {object}  wanted
   * @param {string}  wanted.uid
   * @param {string}  [wanted.url]         gespeicherte Objektadresse
   * @param {string}  [wanted.calendarUrl] Kalender, in dem die Zeile liegt
   * @param {boolean} [wanted.anywhere]    Stufe 3 zulassen
   * @param {boolean} [wanted.unparsed]    an der Adresse auch ein Objekt ohne
   *                                       lesbaren Termin gelten lassen
   * @returns {object|null} { url, etag, data, calendarUrl }
   */
  find({ uid, url = null, calendarUrl = null, anywhere = true, unparsed = false }) {
    const atAddress = url ? this.#byUrl.get(url) : null;
    if (atAddress && (atAddress.uid === uid || (unparsed && atAddress.uid === null))) return atAddress.entry;
    const inCalendar = calendarUrl ? this.#byCalendarUid.get(ObjectIndex.#key(calendarUrl, uid)) : null;
    if (inCalendar) return inCalendar;
    return anywhere ? (this.get(uid) ?? null) : null;
  }
}

/**
 * Zieht die Zeile nach einem Umzug auf den Zielkalender und das dort angelegte
 * Objekt nach - wie `applyMove` bei Google.
 *
 * Ohne das zeigen calendar_ref_id und external_object_url bis zum nächsten
 * Inbound-Lauf auf die Quelle, deren Objekt gerade gelöscht wurde. Ein Löschen in
 * diesem Fenster ginge per DELETE an die tote URL, deren 404 den Tombstone als
 * erledigt verwirft, und der nächste Lauf importierte den Termin aus dem Ziel neu;
 * eine Bearbeitung liefe ebenso ins 404 und fiele weg.
 *
 * Name und Farbe kommen aus der Kontoauswahl, also dieselben Werte, die der
 * Inbound schreibt: der Helfer überschreibt beide, und ein null hätte die Farbe
 * einer bestehenden Kalenderzeile bis dahin gelöscht.
 */
function applyMove(eventId, source, calendarUrl, destCal, objectUrl, accountId = null) {
  const conn = db.get();
  // Zwei Konten können dieselbe Kalender-URL führen, mit eigenem Namen und
  // eigener Farbe: gelesen wird die Auswahl des Kontos, das umgezogen hat.
  const selected = accountId == null
    ? conn.prepare(
      'SELECT calendar_name, calendar_color FROM caldav_calendar_selection WHERE calendar_url = ? LIMIT 1'
    ).get(calendarUrl)
    : conn.prepare(
      'SELECT calendar_name, calendar_color FROM caldav_calendar_selection WHERE account_id = ? AND calendar_url = ?'
    ).get(accountId, calendarUrl);
  const known = selected ? null : conn.prepare(
    'SELECT name, color FROM external_calendars WHERE source = ? AND external_id = ?'
  ).get(source, calendarUrl);

  const calRefId = upsertExternalCalendar(
    source, calendarUrl,
    selected?.calendar_name || known?.name || destCal.displayName || calendarUrl,
    selected ? selected.calendar_color : (known?.color ?? null),
  );
  conn.prepare(
    'UPDATE calendar_events SET calendar_ref_id = ?, external_object_url = ? WHERE id = ?'
  ).run(calRefId, objectUrl, eventId);
}

/**
 * Hat der Nutzer den Termin gelöscht, während sein Umzug lief? Dann steht der
 * Tombstone der Löschroute für genau das Objekt in der Quelle - über dessen URL,
 * bei Altbestand ohne gespeicherte URL über den Quellkalender.
 *
 * Eine fehlende Zeile allein sagt das nicht. Das Aufräumen eines abgewählten
 * Kalenders, das Trennen eines Kontos und der Prune löschen ebenfalls lokal, und
 * zwar ausdrücklich, ohne den Anbieter anzufassen (calendar-prune.js). Ein
 * Tombstone für die Kopie im Ziel löschte dort einen Termin, den andere Clients
 * derselben Familie weiter sehen sollen.
 *
 * Dass der Tombstone hier überhaupt noch steht, hält die Serialisierung in
 * `server/utils/sync-lock.js`: ein paralleler Durchgang räumte ihn sonst ab,
 * bevor der Umzug hier ankommt, und die Kopie im Ziel bliebe stehen, bis der
 * nächste Inbound-Lauf den gelöschten Termin von dort neu importiert.
 */
function deletedByUser(source, uid, sourceObjectUrl, sourceCalendarUrl, accountId = null) {
  // Der Tombstone der Route trägt das Konto der gelöschten Zeile; der eines
  // anderen Kontos mit derselben UID meint einen anderen Termin.
  const ofAccount = accountId == null ? '' : ' AND caldav_account_id = ?';
  return !!db.get().prepare(`
    SELECT 1 FROM calendar_pending_deletions
    WHERE source = ? AND event_external_id = ?${ofAccount}
      AND (object_url = ? OR (object_url IS NULL AND calendar_external_id = ?))
  `).get(source, uid, ...(accountId == null ? [] : [accountId]), sourceObjectUrl, sourceCalendarUrl);
}

/**
 * Kalender-Properties eines lokalen Termins für patchICSEvent.
 *
 * Die Zeitangaben kommen seit #938 aus `eventDateTimeFields`: der Fall, den es
 * hier gab und der hier nicht auffiel, ist der lokal angelegte Termin. Er hat
 * kein `tzid`, also stand ein `DTSTART:20260830T100000` ohne jede Zone im PUT -
 * floating time, die iOS richtig raet und ein DAViCal-Backend gar nicht erst
 * anzeigt. Jetzt traegt er die Zone des Haushalts.
 *
 * Zurueck kommt das Feld-Objekt UND die Zone, deren VTIMEZONE mitgeschickt
 * werden muss - zusammen, weil ein TZID ohne seinen Block ein ungueltiges
 * Objekt ergibt und getrennte Rueckgabewerte den Aufrufer einladen, das zweite
 * zu vergessen.
 *
 * @param {object} event
 * @param {string|null} householdZone Zone des Haushalts; ohne sie bleibt es beim
 *        UTC-Suffix - eindeutig, aber ohne Zonenbezug.
 * @returns {{ fields: object, tzid: string|null }}
 */
export function icsFieldsForEvent(event, householdZone = null) {
  // Start/Ende mit der eigenen Wiederholungsregel in Einklang (#986); ein
  // importiertes DTSTART bleibt unberuehrt (#756).
  const when = eventDateTimeFields(outboundEvent(event, { householdZone }), householdZone);

  const fields = {
    SUMMARY:     event.title,
    DESCRIPTION: event.description || null,
    LOCATION:    event.location || null,
    // Reines Datum als UNTIL neben getimtem DTSTART -> Ende des Ortstags (#1974);
    // ein UNTIL aus dem alten Formular an einer eigenen Serie ohne Zone zuvor
    // zum Datum (#1992).
    RRULE:       event.recurrence_rule ? rruleForDtstart(outboundRecurrenceRule(event), when) : null,
    DTSTART:     when.dtstart,
    DTEND:       when.dtend,
  };

  // COLOR ist Teil von MIRRORED_FIELDS, wurde aber nie geschrieben (#897): eine
  // Umfaerbung kostete einen PUT, der beim Server nichts aenderte.
  //
  // DREI FAELLE, und der Unterschied zwischen den letzten beiden ist der ganze
  // Punkt von #899:
  //
  //   1. Eine Eigenfarbe, die sich abbilden laesst → ihr CSS3-Name geht hinaus.
  //   2. Keine Eigenfarbe, und der Nutzer hat sie GELEERT (color_modified = 1)
  //      → null, und der Patcher entfernt die COLOR-Zeile. Verwaltet heisst
  //      ersetzen UND entfernen; erst hier wird die zweite Haelfte gebraucht.
  //   3. Keine Eigenfarbe, weil wir nie eine gelernt haben (color_modified = 0)
  //      → das Feld bleibt weg, "nicht anfassen".
  //
  // Fall 3 ist keine Vorsicht ohne Anlass. Ein Termin kommt ohne COLOR herein,
  // jemand faerbt ihn spaeter auf dem SERVER, und Yuvomi erfaehrt davon erst
  // beim naechsten Inbound-Lauf - der aber laeuft nicht zwischen der Bearbeitung
  // und ihrem Push. Ein pauschales null haette dessen Farbe abgeraeumt, und vor
  // #899 dauerhaft: das Gatter hing an `user_modified`, das jede Bearbeitung
  // setzt, also holte auch kein spaeterer Lauf sie zurueck.
  //
  // Eine Farbe, die sich nicht abbilden laesst (kein gueltiges #RRGGBB), faellt
  // NICHT in Fall 2: `event.color` steht, geleert wurde nichts. Sie bleibt in
  // Fall 3 - ein null wuerde eine fremde Farbe wegwerfen, um einen Wert
  // wiederzugeben, den wir gar nicht ausdruecken koennen.
  const colorName = nearestIcalColorName(event.color);
  if (colorName) fields.COLOR = colorName;
  else if (!event.color && event.color_modified) fields.COLOR = null;

  return { fields, tzid: when.tzid };
}

/** Dateiname eines Kalenderobjekts aus seiner URL, ersatzweise aus der UID. */
export function filenameFromUrl(url, uid) {
  const last = String(url).split('/').filter(Boolean).pop();
  return last && last.includes('.') ? last : `${uid}.ics`;
}

/**
 * Holt gezielt einzelne Kalenderobjekte statt ganzer Kalender - die Grundlage des
 * Sofortversuchs direkt nach einer Bearbeitung (#593). Ein voller Kalenderabruf
 * wäre dafür unverhältnismäßig; hier zählt nur das eine geänderte Objekt.
 *
 * @param {object} client
 * @param {Array<{uid:string,url:string,calendarUrl:string}>} wanted
 * @returns {Promise<Map>} UID → { url, etag, data, calendarUrl }
 */
export async function fetchObjectsByUrl(client, wanted) {
  const index = new Map();
  if (!wanted.length) return index;

  // Nach Kalender gruppieren: fetchCalendarObjects adressiert Objekte innerhalb
  // einer Collection.
  const byCalendar = new Map();
  for (const item of wanted) {
    if (!item.url || !item.calendarUrl) continue;
    if (!byCalendar.has(item.calendarUrl)) byCalendar.set(item.calendarUrl, []);
    byCalendar.get(item.calendarUrl).push(item);
  }

  for (const [calendarUrl, items] of byCalendar) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar:   { url: calendarUrl },
        objectUrls: items.map((i) => i.url),
      });
      // Über die URL zurück auf den Termin abbilden - verlässlicher als die UID
      // erneut aus dem Objekt zu parsen.
      for (const obj of objects || []) {
        const match = items.find((i) => sameObjectAddress(i.url, obj.url));
        if (!match) continue;
        index.set(match.uid, {
          url: match.url, etag: obj.etag, data: obj.data, calendarUrl,
        });
      }
    } catch (err) {
      // Kein Grund zur Sorge: der reguläre Sync-Lauf holt den Kalender ohnehin.
      log.warn(`Could not fetch calendar objects from ${calendarUrl} for the immediate attempt: ${err.message}`);
    }
  }
  return index;
}

/**
 * Sofortversuch für einen CalDAV-Account: erledigt, was ohne vollen Kalenderabruf
 * geht. Löschungen brauchen nur die gespeicherte Objekt-URL, Änderungen zusätzlich
 * das Originalobjekt; ein Umzug zusätzlich die Kalenderliste.
 *
 * Was hier nicht klappt, bleibt vorgemerkt und läuft im nächsten Sync mit.
 *
 * `accountId`: bei CalDAV das Konto, mit dessen Client gearbeitet wird. Die
 * Arbeit wird unten je Konto neu gelesen; ohne es ginge für 'caldav' nichts
 * hinaus. `isSelected`: ist dieser Kalender für das Konto EINGESCHALTET? Ein
 * Löschauftrag für einen anderen bleibt liegen (#1884), siehe
 * `processPendingDeletions`.
 * @returns {Promise<{deleted:number,updated:number}>}
 */
export async function flushAccount(client, source, { deletions, updates, needsCalendars, accountId = null, isSelected = null }) {
  const wanted = updates
    .filter((e) => e.external_object_url)
    .map((e) => ({
      uid: e.external_calendar_id,
      url: e.external_object_url,
      calendarUrl: e.__calendarUrl,
    }));

  const objectIndex = await fetchObjectsByUrl(client, wanted);

  // null = unbekannt. Auch ohne Abruf: zwischen der Auswahl der Arbeit und hier
  // liegt ein await, in dem ein Umzug vorgemerkt worden sein kann - eine leere
  // Liste hiesse für ihn "das Ziel ist verschwunden".
  let calendarsByUrl = null;
  if (needsCalendars) {
    try {
      const cals = await client.fetchCalendars();
      calendarsByUrl = new Map((cals || []).map((c) => [c.url, c]));
    } catch (err) {
      // null, nicht leer: eine gescheiterte Auflistung weiss nicht, welche
      // Kalender es gibt. Mit einer leeren Liste gälte jedes Umzugsziel als
      // verschwunden, und der wartende Umzug würde verworfen.
      calendarsByUrl = null;
      log.warn(`Could not list calendars for the immediate attempt: ${err.message}`);
    }
  }

  // ownCalendarUrls bewusst nicht gesetzt: ohne vollen Abruf ist "der Server
  // führt das Objekt nicht mehr" nicht belegbar, und ein Tombstone ohne bekannte
  // URL darf hier nicht als erledigt gelten. Er bleibt für den Sync liegen.
  const deleted = deletions.length ? await processPendingDeletions(client, source, objectIndex, null, { accountId, isSelected }) : 0;
  const updated = objectIndex.size ? await processPendingUpdates(client, source, objectIndex, calendarsByUrl, { accountId }) : 0;
  return { deleted, updated };
}

/**
 * Arbeitet vorgemerkte Löschungen auf einem CalDAV-Server ab.
 *
 * MIT KONTO (CalDAV), wohin die Anfrage im Sync-Lauf geht:
 *   1. Kennt der Abruf dieses Kontos das Objekt (`ObjectIndex.find`), an die
 *      Adresse aus dem Abruf.
 *   2. Sonst an die gespeicherte Adresse - sofern der Abruf dort nichts
 *      ANDERES führt. Dass ein Objekt in einer Antwort fehlt, belegt nicht,
 *      dass es fort ist: eine leere oder unvollständige Antwort sieht genauso
 *      aus, und ohne die Anfrage käme der gelöschte Termin beim nächsten Lauf
 *      zurück. Ein 404 erledigt den Auftrag dann von selbst.
 *   3. Ohne Anfrage fällt der Auftrag nur, wenn an der gespeicherten Adresse
 *      inzwischen ein anderer Termin liegt oder gar keine Adresse gespeichert
 *      ist und der Abruf das Objekt nicht führt.
 * EIN BEDINGTER AUFTRAG (#1883, `isConditionalDeletion`) gilt nur dem Objekt
 * an seiner Adresse in dem Stand, für den er vorgemerkt wurde - der Rest eines
 * Umzugs, dessen Quelle ihr Löschen abgelehnt hat. Er sucht sein Objekt NICHT
 * über die UID: das DELETE geht an die gespeicherte Adresse, mit dem
 * gespeicherten ETag als If-Match. Führt der Abruf dort einen anderen Stand
 * oder einen anderen Termin, fällt der Auftrag ohne Anfrage; antwortet der
 * Server mit 412, fällt er ebenfalls. Beides heisst: was dort liegt, ist nicht
 * mehr der Rest des Umzugs (der Termin wurde woanders zurückgelegt), und ein
 * Löschen nähme ihn aus beiden Kalendern. Das gilt auch im Sofortversuch und
 * für Apple.
 *
 * Liegt die Adresse nicht auf dem Server des Kontos, stellt der Client die
 * Anfrage nicht (`withAccountOrigin`). Im Lauf heisst das: dieses Objekt liegt
 * nicht bei diesem Konto, der Auftrag wird mit Meldung abgeräumt. Im
 * Sofortversuch, der keinen Abruf hat, bleibt er ohne gezählten Versuch für den
 * Lauf liegen.
 *
 * EIN AUFTRAG FÜR EINEN ABGEWÄHLTEN KALENDER WARTET (#1884, `isSelected`).
 * Abschalten heisst nicht aufräumen: solange der Kalender abgewählt ist, geht
 * dorthin kein DELETE, weder im Lauf noch im Sofortversuch. Der Auftrag bleibt
 * stehen, zählt dabei keinen Versuch und läuft, sobald der Kalender wieder
 * eingeschaltet ist. Vorher übersprang ihn nur der Lauf; der Sofortversuch
 * schickte das DELETE trotzdem, und jede Absage dort zählte, bis der Auftrag
 * nach fünf aufgegeben war und der gelöschte Termin beim Wieder-Einschalten
 * zurückkam. Endgültig fällt ein wartender Auftrag, wenn es seinen Kalender
 * nicht mehr gibt (`dropDeletionsOfMissingCalendars`) oder sein Konto gelöscht
 * wird. Gefragt wird je Auftrag unmittelbar vor seiner Anfrage: davor liegen
 * die awaits der Aufträge davor, und die Auswahl kann sich in jedem ändern.
 *
 * @param {object} client       tsdav-Client
 * @param {string} source       'caldav' | 'apple'
 * @param {Map}    objectIndex  UID → { url, etag, data, calendarUrl } aus dem Inbound dieses Laufs
 * @param {Set}    [ownCalendarUrls] die in diesem Lauf abgerufenen Kalender; nur beim vollen Abruf gesetzt
 * @param {object} [scope]
 * @param {number} [scope.accountId] CalDAV-Konto, dem der Client gehört
 * @param {boolean} [scope.complete] jeder eingeschaltete Kalender des Kontos wurde abgerufen
 * @param {(calendarUrl: string) => boolean} [scope.isSelected] ist der Kalender
 *   für dieses Konto jetzt eingeschaltet? Ein Auftrag ohne Kalender wird nicht
 *   gefragt. Ohne die Funktion (Apple kennt keine Auswahl) gilt jeder als
 *   eingeschaltet.
 * @param {{sent: number}} [scope.outcome] zählt mit, was der Server wirklich gelöscht hat
 * @returns {Promise<number>} erledigte Tombstones - auch die, die ohne Anfrage fielen
 */
export async function processPendingDeletions(client, source, objectIndex, ownCalendarUrls = null, {
  accountId = null, complete = true, isSelected = null, outcome = null,
} = {}) {
  const rows = outbound.pendingDeletions(source, { accountId });
  if (rows.length === 0) return 0;

  const index = accountId == null ? null : ObjectIndex.from(objectIndex);

  let done = 0;
  for (const row of rows) {
    // Nur anfassen, was zu den gerade abgerufenen Kalendern gehört: der Kalender
    // dieses Auftrags wurde in diesem Lauf nicht gelesen (abgewählt, Abruf
    // gescheitert), also weiss niemand, ob sein Objekt noch dort liegt.
    if (ownCalendarUrls && row.calendar_external_id && !ownCalendarUrls.has(row.calendar_external_id)) continue;
    // Abgewählt (#1884): dort wird nichts gelöscht, und der Auftrag altert nicht.
    if (isSelected && row.calendar_external_id && !isSelected(row.calendar_external_id)) continue;

    let known;
    let url;
    const conditional = outbound.isConditionalDeletion(row);
    if (conditional) {
      // Was dieser Durchgang an der Adresse des Auftrags gesehen hat. Ohne
      // Konto (Apple) kennt die Map nur ein Objekt je UID.
      let seen;
      if (index) {
        seen = index.at(row.object_url);
      } else {
        const entry = objectIndex.get(row.event_external_id);
        seen = entry?.url === row.object_url ? { uid: row.event_external_id, entry } : undefined;
      }
      const otherEvent = seen && seen.uid !== null && seen.uid !== row.event_external_id;
      const otherState = seen?.entry?.etag && seen.entry.etag !== row.etag;
      if (otherEvent || otherState) {
        log.info(`[${label(source)}] The entry of event ${row.event_external_id} in its old calendar has changed since its removal was queued, dropping the pending deletion.`);
        outbound.dropDeletion(row.id);
        done++;
        continue;
      }
      url = row.object_url;
    } else if (index) {
      known = index.find({
        uid: row.event_external_id, url: row.object_url,
        calendarUrl: row.calendar_external_id || null,
        anywhere: !row.calendar_external_id, unparsed: true,
      });
      if (known) {
        url = known.url;
      } else if (row.object_url && index.uidAt(row.object_url) === undefined) {
        url = row.object_url;
      } else if (row.object_url && ownCalendarUrls) {
        log.info(`[${label(source)}] Another entry now lives at the stored address of event ${row.event_external_id}, dropping the pending deletion.`);
        outbound.dropDeletion(row.id);
        done++;
        continue;
      } else {
        url = null;
      }
      // Ohne Adresse und ohne Kalender am Auftrag belegt nur ein vollständiger
      // Abruf, dass das Objekt fort ist.
      if (!url && ownCalendarUrls && !row.calendar_external_id && !complete) continue;
    } else {
      known = objectIndex.get(row.event_external_id);
      url   = row.object_url || known?.url || null;
    }

    if (!url) {
      // Zuständig, aber der Server liefert das Objekt nicht mehr aus: dann ist es
      // dort bereits weg und der Tombstone hat sein Ziel erreicht.
      if (ownCalendarUrls) {
        log.info(`[${label(source)}] Event ${row.event_external_id} is no longer on the server, dropping the pending deletion.`);
        outbound.dropDeletion(row.id);
        done++;
      }
      continue;
    }

    try {
      await client.deleteCalendarObject({ calendarObject: { url, etag: conditional ? row.etag : known?.etag } });
      outbound.dropDeletion(row.id);
      done++;
      if (outcome) outcome.sent++;
    } catch (err) {
      // 412 auf den gespeicherten ETag: das Objekt hat sich geändert, seit der
      // Auftrag vorgemerkt wurde. Kein Wiederholungsfall - ein späterer Versuch
      // käme nur mit einem frischen ETag durch, und der löschte genau das, was
      // die Vorbedingung schützt.
      if (conditional && outbound.outboundErrorStatus(err) === 412) {
        log.info(`[${label(source)}] The entry of event ${row.event_external_id} in its old calendar has changed since its removal was queued, dropping the pending deletion.`);
        outbound.dropDeletion(row.id);
        done++;
        continue;
      }
      if (isOriginRefusal(err)) {
        // Nichts wurde gesendet.
        if (ownCalendarUrls) {
          log.warn(`[${label(source)}] The stored address of event ${row.event_external_id} is not on the server of its account and the account does not hold the entry, dropping the pending deletion.`);
          outbound.dropDeletion(row.id);
          done++;
        } else {
          log.warn(`[${label(source)}] The stored address of event ${row.event_external_id} is not on the server of its account, leaving its deletion to the next sync run.`);
        }
        continue;
      }
      if (outbound.handleDeletionError(err, row, label(source))
          && outbound.classifyOutboundError(err) === 'settled') {
        done++;
      }
    }
  }
  return done;
}

/**
 * Schiebt lokal bearbeitete, bereits synchronisierte Termine zum Server.
 * Ein Wechsel des Zielkalenders wird als Anlegen im Ziel + Löschen in der Quelle
 * ausgeführt: CalDAV kennt kein Verschieben.
 *
 * MIT KONTO (CalDAV) sagt der Abruf dieses Kontos, welches Objekt gemeint ist
 * (`ObjectIndex.find`), und die Anfrage geht an DESSEN Adresse. Die
 * gespeicherte Adresse wählt nur aus; weicht sie ab, wird sie nach dem Senden
 * nachgezogen.
 *
 * @param {Map|null} [calendarsByUrl] Kalender-URL → Collection; `null`, wenn die
 *                                    Auflistung gescheitert ist (Umzüge warten dann)
 * @param {object} [scope]
 * @param {number} [scope.accountId] CalDAV-Konto, dem der Client gehört
 * @param {boolean} [scope.fullRun]  voller Sync-Lauf (nicht der Sofortversuch)
 * @returns {Promise<number>} erfolgreich verarbeitete Termine
 */
export async function processPendingUpdates(client, source, objectIndex, calendarsByUrl = null, { accountId = null, fullRun = false } = {}) {
  const events = outbound.pendingUpdates(source, { accountId });
  if (events.length === 0) return 0;

  const index = accountId == null ? null : ObjectIndex.from(objectIndex);
  const calendarOfRow = index ? db.get().prepare(
    'SELECT external_id FROM external_calendars WHERE id = ? AND source = ?'
  ) : null;

  // Einmal je Lauf, nicht je Termin: die Zone steht in sync_config und aendert
  // sich waehrend eines Sync-Durchlaufs nicht.
  const zone = householdTimeZone(db.get());

  let done = 0;
  for (const event of events) {
    let known;
    let url;
    if (index) {
      known = index.find({
        uid: event.external_calendar_id, url: event.external_object_url,
        calendarUrl: event.calendar_ref_id
          ? (calendarOfRow.get(event.calendar_ref_id, source)?.external_id ?? null)
          : null,
      });
      url = known?.url ?? null;
    } else {
      known = objectIndex.get(event.external_calendar_id);
      url   = event.external_object_url || known?.url || null;
    }

    // Weder gespeichert noch im aktuellen Abruf enthalten: in diesem Lauf gibt
    // es keinen Weg zum Objekt. Nichts tun, nichts verwerfen. Der volle Lauf
    // meldet das Vertagen; der Sofortversuch holt nur einzelne Objekte und
    // bleibt still.
    if (!url) {
      if (index && fullRun) log.warn(`[${label(source)}] No source object for event ${event.id} in this run, deferring its update.`);
      continue;
    }

    if (!known?.data) {
      // Ohne das Originalobjekt bliebe nur, es neu zu bauen - und das verlöre
      // alles, was Yuvomi nicht kennt (Teilnehmer, Alarme, Kategorien).
      log.warn(`[${label(source)}] No source object for event ${event.id} in this run, deferring its update.`);
      continue;
    }

    // Frisch nachladen: zwischen der Auswahl und hier liegt ein await, in dem eine
    // weitere Bearbeitung eingetroffen sein kann.
    const fresh = outbound.reloadEvent(event.id);
    if (!fresh) continue; // parallel gelöscht - der Tombstone-Pfad übernimmt

    const { fields, tzid } = icsFieldsForEvent(fresh, zone);
    const patched = patchICSEvent(known.data, event.external_calendar_id, fields, { tzid });
    if (!patched) {
      log.warn(`[${label(source)}] Event ${event.external_calendar_id} has no editable VEVENT in its calendar object, dropping its update.`);
      outbound.clearOutbound(event.id);
      continue;
    }

    // ── Wechsel des Zielkalenders: anlegen im Ziel, löschen in der Quelle ──────
    const moveTo = event.outbound_move_to;
    if (moveTo && moveTo !== known.calendarUrl) {
      // Kalenderliste unbekannt (Auflistung gescheitert): der Umzug bleibt
      // vorgemerkt, der Sync-Lauf entscheidet mit einer echten Liste.
      if (calendarsByUrl === null) continue;
      const destCal = calendarsByUrl.get(moveTo);
      if (!destCal) {
        log.warn(`[${label(source)}] Destination calendar ${moveTo} is not available, keeping event ${event.id} where it is.`);
        outbound.clearOutboundMove(event.id);
      } else {
        try {
          const filename = filenameFromUrl(url, event.external_calendar_id);
          // tsdav löst den Dateinamen relativ zur Kalender-URL auf. Ohne Schrägstrich
          // am Ende ersetzte er deren letztes Segment, und das Objekt landete neben
          // der Collection statt darin - wie der Upload-Pfad als Collection behandeln.
          const collectionUrl = String(destCal.url).replace(/\/?$/, '/');
          const objectUrl = new URL(filename, collectionUrl).href;
          try {
            await client.createCalendarObject({
              calendar:   { ...destCal, url: collectionUrl },
              filename,
              iCalString: patched,
            });
          } catch (err) {
            // 412: der Name ist im Ziel vergeben. Trägt das Objekt dort die UID
            // dieses Termins, ist es die Kopie eines früheren Versuchs - dann
            // geht der Umzug weiter, mit dem aktuellen Stand als Änderung auf
            // die Kopie. Eine fremde UID an der Adresse heisst: nicht unseres,
            // die Quelle bleibt, der Fehler nimmt den üblichen Weg.
            if (err?.status !== 412) throw err;
            const copy = await findObjectWithUid(client, collectionUrl, objectUrl, event.external_calendar_id);
            if (!copy) throw err;
            await client.updateCalendarObject({
              calendarObject: { url: objectUrl, etag: copy.etag, data: patched },
            });
          }
          // Erst nach erfolgreichem Anlegen löschen: scheitert das Löschen, steht
          // der Termin doppelt - das ist reparabel. Umgekehrt wäre er weg.
          let sourceRefusal = null;
          try {
            await client.deleteCalendarObject({ calendarObject: { url, etag: known.etag } });
          } catch (err) {
            // Eine Absage kommt seit dem Wrapper in caldav-client.js hier an.
            // 404/410 heisst: die Quelle ist schon weg, der Umzug ist vollzogen.
            if (outbound.classifyOutboundError(err) !== 'settled') sourceRefusal = err;
          }
          // Während der beiden awaits lokal entfernt. Hat der Nutzer gelöscht, gilt
          // der Tombstone der Route nur der Quelle; die Kopie im Ziel bliebe stehen,
          // und der nächste Lauf importierte den Termin von dort neu. Ein Aufräumen
          // dagegen soll den Anbieter nicht anfassen - siehe deletedByUser.
          //
          // Gelesen VOR der Vormerkung darunter: die legt selbst einen Auftrag
          // für die Quelle an, und an genau dem erkennt deletedByUser den Nutzer.
          const stillThere    = !!outbound.reloadEvent(event.id);
          const userDeletedIt = !stillThere
            && deletedByUser(source, event.external_calendar_id, event.external_object_url || url, known.calendarUrl, accountId);

          // Die Quelle hat ihr Löschen abgelehnt (#1861). Die Kopie liegt im
          // Ziel, der Umzug ist also zur Hälfte vollzogen - und galt bisher als
          // ganz: niemand versuchte es wieder, der Termin lag für immer in
          // beiden Kalendern. Das offene Löschen wird vorgemerkt wie jedes
          // andere und läuft mit denselben Versuchen; der Abruf verdeckt dafür
          // nur das Objekt in der Quelle, nicht die Kopie
          // (`pendingDeletionGuard`). Kalender UND Adresse des Auftrags kommen
          // aus `known`, dem Objekt, an das das DELETE ging - nicht aus der
          // Zeile, die einen anderen Kalender nennen kann. Hat der Nutzer
          // gelöscht, steht der Auftrag der Route schon.
          if (sourceRefusal && !userDeletedIt) {
            // Der Auftrag gilt dem Objekt in dem Stand, den dieser Umzug
            // kopiert hat (#1883): sein ETag geht mit. Nach einem 412 ist
            // gerade dieser Stand schon überholt - dann bleibt der Auftrag
            // ohne Bedingung, wie vor #1883.
            const queued = outbound.queueRefusedDeletion({
              source, calendarExternalId: known.calendarUrl,
              eventExternalId: event.external_calendar_id, objectUrl: known.url, accountId,
              etag: outbound.outboundErrorStatus(sourceRefusal) === 412 ? null : (known.etag ?? null),
            }, sourceRefusal);
            if (queued) {
              log.warn(`[${label(source)}] Event ${event.id} was copied to ${moveTo} but could not be removed from its old calendar (${sourceRefusal.message}); the removal is tried again.`);
            } else if (stillThere) {
              // Für dieses Objekt steht schon der Auftrag eines anderen Kontos,
              // und der bleibt, wie er ist. Der Umzug gilt dann NICHT als
              // vollzogen: er bleibt vorgemerkt, zählt einen Versuch und läuft
              // wie jeder gescheiterte Umzug wieder (die Kopie im Ziel wird
              // dabei übernommen) - bis die Quelle fort ist oder aufgegeben wird.
              log.warn(`[${label(source)}] Event ${event.id} was copied to ${moveTo} but could not be removed from its old calendar (${sourceRefusal.message}), and another account already has a pending deletion for that entry; the move stays pending.`);
              outbound.handleUpdateError(sourceRefusal, event, 'move', label(source), outbound.clearOutboundMove);
              continue;
            }
          }

          if (!stillThere) {
            if (userDeletedIt) {
              outbound.queueDeletion({
                source, calendarExternalId: moveTo, eventExternalId: event.external_calendar_id, objectUrl, accountId,
              });
              log.warn(`[${label(source)}] Event ${event.id} was deleted during its move, queued the deletion of its copy in ${moveTo}.`);
            }
            continue;
          }
          applyMove(event.id, source, moveTo, destCal, objectUrl, accountId);
          // Das Objekt im Ziel ist ab jetzt das gewollte: ein Auftrag aus einem
          // früheren Umzug in die Gegenrichtung darf es nicht mehr treffen.
          outbound.dropDeletionsIn({
            source, calendarExternalId: moveTo, eventExternalId: event.external_calendar_id, accountId,
          });
          // Mit dem Anlegen ging der Patch hinaus: sein Schnappschuss (#1956).
          outbound.settleOutbound(fresh, moveTo, fresh, { snapshot: icsSnapshot(fresh, patched, event.external_calendar_id, zone) });
          done++;
          continue; // der Patch ist mit dem Anlegen bereits geschrieben
        } catch (err) {
          // 404/410 auf das Anlegen heisst "das ZIEL ist weg", nicht "der Termin
          // ist weg": nur der Umzug fällt, eine wartende Bearbeitung geht unten
          // im bisherigen Kalender hinaus. handleUpdateError läse es als
          // "erledigt" und nähme die Bearbeitung mit.
          if (outbound.classifyOutboundError(err) !== 'settled') {
            outbound.handleUpdateError(err, event, 'move', label(source), outbound.clearOutboundMove);
            continue;
          }
          log.warn(`[${label(source)}] Destination calendar ${moveTo} no longer accepts event ${event.id} (${err.message}), keeping it where it is.`);
          outbound.clearOutboundMove(event.id);
        }
      }
    } else if (moveTo) {
      outbound.clearOutboundMove(event.id);
    }

    if (!event.outbound_dirty) continue;

    try {
      await client.updateCalendarObject({
        calendarObject: { url, etag: known.etag, data: patched },
      });
      // Die Adresse kam aus dem Abruf; die Zeile merkt sich die, an der ihr
      // Objekt wirklich liegt.
      if (index && url !== event.external_object_url) outbound.recordObjectUrl(event.id, url);
      outbound.settleOutbound(fresh, null, fresh, { snapshot: icsSnapshot(fresh, patched, event.external_calendar_id, zone) });
      done++;
    } catch (err) {
      outbound.handleUpdateError(err, event, 'update', label(source));
    }
  }
  return done;
}
