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
// --------------------------------------------------------

import { createLogger } from '../logger.js';
import * as outbound from './calendar-outbound.js';
import { patchICSEvent } from '../utils/ics-patch.js';
import { eventDateTimeFields } from '../utils/ics-datetime.js';
import { householdTimeZone } from '../utils/timezone.js';
import * as db from '../db.js';
import { nearestIcalColorName } from '../utils/ical-color.js';
import { outboundEvent } from './outbound-dtstart.js';
import { upsertExternalCalendar } from './external-calendars.js';

const log = createLogger('CalDAVOutbound');

const label = (source) => (source === 'apple' ? 'Apple' : 'CalDAV');

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
function applyMove(eventId, source, calendarUrl, destCal, objectUrl) {
  const conn = db.get();
  const selected = conn.prepare(
    'SELECT calendar_name, calendar_color FROM caldav_calendar_selection WHERE calendar_url = ? LIMIT 1'
  ).get(calendarUrl);
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
function deletedByUser(source, uid, sourceObjectUrl, sourceCalendarUrl) {
  return !!db.get().prepare(`
    SELECT 1 FROM calendar_pending_deletions
    WHERE source = ? AND event_external_id = ?
      AND (object_url = ? OR (object_url IS NULL AND calendar_external_id = ?))
  `).get(source, uid, sourceObjectUrl, sourceCalendarUrl);
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
  const when = eventDateTimeFields(outboundEvent(event), householdZone);

  const fields = {
    SUMMARY:     event.title,
    DESCRIPTION: event.description || null,
    LOCATION:    event.location || null,
    RRULE:       event.recurrence_rule || null,
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
        const match = items.find((i) => i.url === obj.url) || (items.length === 1 ? items[0] : null);
        if (!match) continue;
        index.set(match.uid, {
          url: obj.url || match.url, etag: obj.etag, data: obj.data, calendarUrl,
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
 * @returns {Promise<{deleted:number,updated:number}>}
 */
export async function flushAccount(client, source, { deletions, updates, needsCalendars }) {
  const wanted = updates
    .filter((e) => e.external_object_url)
    .map((e) => ({
      uid: e.external_calendar_id,
      url: e.external_object_url,
      calendarUrl: e.__calendarUrl,
    }));

  const objectIndex = await fetchObjectsByUrl(client, wanted);

  let calendarsByUrl = new Map();
  if (needsCalendars) {
    try {
      const cals = await client.fetchCalendars();
      calendarsByUrl = new Map((cals || []).map((c) => [c.url, c]));
    } catch (err) {
      log.warn(`Could not list calendars for the immediate attempt: ${err.message}`);
    }
  }

  // ownCalendarUrls bewusst nicht gesetzt: ohne vollen Abruf ist "der Server
  // führt das Objekt nicht mehr" nicht belegbar, und ein Tombstone ohne bekannte
  // URL darf hier nicht als erledigt gelten. Er bleibt für den Sync liegen.
  const deleted = deletions.length ? await processPendingDeletions(client, source, objectIndex) : 0;
  const updated = objectIndex.size ? await processPendingUpdates(client, source, objectIndex, calendarsByUrl) : 0;
  return { deleted, updated };
}

/**
 * Arbeitet vorgemerkte Löschungen auf einem CalDAV-Server ab.
 * @param {object} client       tsdav-Client
 * @param {string} source       'caldav' | 'apple'
 * @param {Map}    objectIndex  UID → { url, etag, data, calendarUrl } aus dem Inbound dieses Laufs
 * @param {Set}    [ownCalendarUrls] Kalender dieses Accounts; fremde Tombstones bleiben unangetastet
 * @returns {Promise<number>} erledigte Tombstones
 */
export async function processPendingDeletions(client, source, objectIndex, ownCalendarUrls = null) {
  const rows = outbound.pendingDeletions(source);
  if (rows.length === 0) return 0;

  let done = 0;
  for (const row of rows) {
    // Mehrere Accounts teilen sich die Tombstone-Tabelle: nur anfassen, was zu den
    // gerade abgerufenen Kalendern gehört, sonst zählt ein fremder Account fremde
    // Fehlversuche hoch und verwirft am Ende eine fremde Löschung.
    if (ownCalendarUrls && row.calendar_external_id && !ownCalendarUrls.has(row.calendar_external_id)) continue;

    const known = objectIndex.get(row.event_external_id);
    const url   = row.object_url || known?.url || null;

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
      await client.deleteCalendarObject({ calendarObject: { url, etag: known?.etag } });
      outbound.dropDeletion(row.id);
      done++;
    } catch (err) {
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
 * @returns {Promise<number>} erfolgreich verarbeitete Termine
 */
export async function processPendingUpdates(client, source, objectIndex, calendarsByUrl = new Map()) {
  const events = outbound.pendingUpdates(source);
  if (events.length === 0) return 0;

  // Einmal je Lauf, nicht je Termin: die Zone steht in sync_config und aendert
  // sich waehrend eines Sync-Durchlaufs nicht.
  const zone = householdTimeZone(db.get());

  let done = 0;
  for (const event of events) {
    const known = objectIndex.get(event.external_calendar_id);
    const url   = event.external_object_url || known?.url || null;

    // Weder gespeichert noch im aktuellen Abruf enthalten: das Objekt gehört zu
    // einem anderen Account. Nichts tun, nichts verwerfen - dessen Lauf übernimmt.
    if (!url) continue;

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
          await client.createCalendarObject({
            calendar:   { ...destCal, url: collectionUrl },
            filename,
            iCalString: patched,
          });
          // Erst nach erfolgreichem Anlegen löschen: scheitert das Löschen, steht
          // der Termin doppelt - das ist reparabel. Umgekehrt wäre er weg.
          try {
            await client.deleteCalendarObject({ calendarObject: { url, etag: known.etag } });
          } catch (err) {
            log.error(`[${label(source)}] Event ${event.id} was copied to ${moveTo} but could not be removed from its old calendar:`, err.message);
          }
          // Während der beiden awaits lokal entfernt. Hat der Nutzer gelöscht, gilt
          // der Tombstone der Route nur der Quelle; die Kopie im Ziel bliebe stehen,
          // und der nächste Lauf importierte den Termin von dort neu. Ein Aufräumen
          // dagegen soll den Anbieter nicht anfassen - siehe deletedByUser.
          if (!outbound.reloadEvent(event.id)) {
            if (deletedByUser(source, event.external_calendar_id, url, known.calendarUrl)) {
              outbound.queueDeletion({
                source, calendarExternalId: moveTo, eventExternalId: event.external_calendar_id, objectUrl,
              });
              log.warn(`[${label(source)}] Event ${event.id} was deleted during its move, queued the deletion of its copy in ${moveTo}.`);
            }
            continue;
          }
          applyMove(event.id, source, moveTo, destCal, objectUrl);
          outbound.settleOutbound(fresh, moveTo);
          done++;
          continue; // der Patch ist mit dem Anlegen bereits geschrieben
        } catch (err) {
          outbound.handleUpdateError(err, event, 'move', label(source), outbound.clearOutboundMove);
          continue;
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
      outbound.settleOutbound(fresh);
      done++;
    } catch (err) {
      outbound.handleUpdateError(err, event, 'update', label(source));
    }
  }
  return done;
}
