/**
 * Modul: Schichtplan-Erinnerungen (Schedule v3)
 * Zweck: Soll-Zustand der `schedule_entry`-Erinnerungen herstellen - ein
 *        rollierendes Fenster (heute .. +7 Tage) je Nutzer mit aktiviertem
 *        Vorlauf, periodisch aufgeloest ueber resolveEntries()/scheduleData().
 *
 * WARUM EIN ANKER NOETIG IST, ANDERS ALS BEI JEDEM BISHERIGEN entity_type:
 * ein Musterzyklus-Tag ist keine gespeicherte Zeile (das ist der ganze Punkt
 * von "computed on read", server/services/schedule.js), hat also keine
 * stabile Id, an die `reminders.entity_id` haengen koennte. Ein Override
 * HAT eine echte Zeilen-Id (schedule_overrides.id), ein Musters-Tag nicht -
 * zwei verschiedene IDs fuer denselben Begriff waeren zwei Wahrheiten. Die
 * Anker-Tabelle `schedule_reminder_entries` (Migration 184) loest das
 * einheitlich: EIN Anker je (Nutzer, Tag), gleich ob der Tag aus einem Muster
 * oder einer Ausnahme stammt. Sie ist nicht die Wahrheit ueber den
 * Schichtplan - das bleibt resolveEntries() -, nur ein Ausleihschein dafuer,
 * dass reminders.entity_id auf etwas Stabiles zeigt.
 *
 * GLEICHE GRUNDFORM WIE server/services/pantry-reminders.js: loeschen, was
 * gegenstandslos wurde, ergaenzen, was fehlt, bestehende Zeilen unangetastet
 * lassen (kein Zuruecksetzen von pushed_at/dismissed bei jedem Lauf). Ohne die
 * Vorrats-spezifische "auf morgen 09:00 klemmen"-Sonderbehandlung: eine
 * Schicht hat schon eine Uhrzeit, es gibt nichts zu erraten, und ein bereits
 * verstrichener Erinnerungszeitpunkt bedeutet schlicht "zu spaet, keine
 * Meldung mehr" statt eines Rettungsversuchs fuer eine kurze Frischware-Frist.
 */

import { localToUTC, householdTimeZone, todayKey, shiftDateKey, utcToWall } from '../utils/timezone.js';
import { resolvePermissions } from '../permissions.js';
import { createLogger } from '../logger.js';
import { scheduleData } from './schedule.js';

const log = createLogger('ScheduleReminders');

// Kurzes Fenster, bewusst kuerzer als der ICS-Feed (395 Tage): eine Erinnerung
// braucht nur zu existieren, bevor sie faellig wird, und ein Sync-Lauf alle
// paar Minuten holt neue Tage laengst nach, bevor sie in Reichweite kommen.
// Ein Jahr Anker-Zeilen im Voraus waere reine Vorratshaltung ohne Nutzen.
const REMINDER_WINDOW_DAYS = 7;

function pad(n) { return String(n).padStart(2, '0'); }

function toNaiveUTC(isoWithZ) {
  // reminders.remind_at ist im ganzen Baum naiv-UTC (siehe
  // server/utils/reminder-schedule.js); localToUTC() liefert ein 'Z'-Suffix,
  // das hier wie ueberall sonst abgeschnitten wird statt ein zweites Mal den
  // Offset zu tragen.
  return isoWithZ.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

function subtractMinutes(naiveUTC, minutes) {
  const d = new Date(`${naiveUTC}Z`);
  d.setUTCMinutes(d.getUTCMinutes() - Math.max(0, Number(minutes) || 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Zonen-Offset (Minuten, Wanduhr minus UTC) an einem gegebenen UTC-Zeitpunkt,
 * ueber utcToWall gelesen - dieselbe Intl-Quelle wie ueberall sonst in diesem
 * Baum, nur zurueckgerechnet in eine Zahl statt Datumsteilen.
 */
function offsetMinutesAt(utcMs, tzid) {
  const wall = utcToWall(new Date(utcMs).toISOString(), tzid);
  if (!wall) return null;
  return (Date.parse(`${wall.date}T${wall.time}Z`) - utcMs) / 60000;
}

/**
 * Lokale Wanduhrzeit -> UTC, DST-korrekt per Fixpunkt-Iteration.
 *
 * server/utils/timezone.js#localToUTC macht nur EINEN Durchgang: die lokalen
 * Ziffern werden als UTC gelesen, der Zonen-Offset AN DIESEM (falschen) Punkt
 * bestimmt und einmal angewandt. Das stimmt, solange der Offset an der
 * falschen und der richtigen Stelle gleich ist - rund um eine DST-Grenze aber
 * nicht (bis zu einer Offset-Breite daneben), und eine wegen des Frühjahrs-
 * sprungs gar nicht existierende Wanduhrzeit wird gar nicht erst erkannt.
 * Dieser Sync braucht die tatsaechliche Minute (eine Erinnerung, die eine
 * Stunde zu frueh oder spaet feuert, ist keine Erinnerung mehr) - deshalb hier
 * eine eigene, lokale Zweitfassung statt den geteilten Helfer anzufassen:
 * andere Aufrufer verlassen sich auf dessen exaktes (Ein-Durchgang-)Verhalten.
 *
 * Verfahren (der uebliche Zwei-Pass-Fixpunkt): Startschaetzung wie localToUTC,
 * daraus den Offset ablesen, die Schaetzung damit korrigieren, den Offset an
 * DIESER korrigierten Stelle erneut ablesen. Bleibt er gleich, ist das
 * Ergebnis exakt (der Rundlauf-Test, den ein einzelner Durchgang nie macht).
 * Weicht er ab, liegt localStr auf/um eine DST-Grenze:
 * - Zweiter Durchgang stabilisiert sich (Herbst/Fold, die Wanduhrzeit gab es
 *   zweimal): das Ergebnis des zweiten Durchgangs gilt - eine der beiden
 *   gueltigen Antworten, deterministisch statt zufaellig.
 * - Kein Fixpunkt nach zwei Durchgaengen (Fruehling/Luecke, die Wanduhrzeit
 *   gab es GAR NICHT): um die Luecke vorschieben, deren Breite die Differenz
 *   der beiden gesehenen Offsets ist - dokumentierter Ausweichweg, keine
 *   perfekte Antwort, weil es keine gibt.
 *
 * Ground-truth manuell geprueft (Europe/Berlin, siehe PR-Notizen): 06:00 lokal
 * am 2026-03-29 (schon CEST, +02:00) -> 04:00Z; 06:00 lokal am 2026-10-25
 * (schon wieder CET, +01:00) -> 05:00Z; beide Tage liegen fuer 06:00 bereits
 * auf der jeweils richtigen Seite der Grenze, single-pass und diese Funktion
 * stimmen dort ueberein - der Unterschied zeigt sich erst innerhalb der
 * Sprung-/Fold-Stunde selbst.
 *
 * @param {string} localStr  'YYYY-MM-DDTHH:mm:ss' ohne Offset
 * @param {string} tzid      IANA-Zone
 * @returns {string} UTC-ISO mit 'Z'
 */
function localToUTCPrecise(localStr, tzid) {
  const naiveMs = Date.parse(`${localStr}Z`);
  if (Number.isNaN(naiveMs)) return localToUTC(localStr, tzid);

  const o1 = offsetMinutesAt(naiveMs, tzid);
  if (o1 == null) return localToUTC(localStr, tzid);
  const guessA = naiveMs - o1 * 60000;

  const o2 = offsetMinutesAt(guessA, tzid);
  if (o2 == null) return localToUTC(localStr, tzid);
  if (o2 === o1) return new Date(guessA).toISOString().replace('.000Z', 'Z');

  const guessB = naiveMs - o2 * 60000;
  const o3 = offsetMinutesAt(guessB, tzid);
  if (o3 === o2) return new Date(guessB).toISOString().replace('.000Z', 'Z');

  // Kein Fixpunkt in zwei Durchgaengen: Fruehjahrsluecke. Um die Luecke
  // vorschieben statt eine Antwort vorzutaeuschen, die es nicht gibt.
  const gapMinutes = Math.abs(o2 - o1);
  return new Date(guessA + gapMinutes * 60000).toISOString().replace('.000Z', 'Z');
}

/**
 * Erinnerungszeitpunkt fuer eine Schicht: Datum+Startzeit in der
 * Haushaltszone, minus Vorlaufminuten, als naiv-UTC.
 */
function shiftReminderAt(dateKey, startTime, offsetMinutes, tz) {
  const utc = toNaiveUTC(localToUTCPrecise(`${dateKey}T${startTime}:00`, tz));
  return subtractMinutes(utc, offsetMinutes);
}

function scheduleDisabled(database) {
  const row = database.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  if (!row?.value) return false;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.includes('schedule');
  } catch {
    return false;
  }
}

function lacksSchedule(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return true;
  return resolvePermissions(database, user).modules.schedule === 'none';
}

/**
 * Extras haben ihren EIGENEN Vorlauf (schedule_extra_shifts.reminder_offset_minutes),
 * unabhaengig vom haushaltweiten Feld auf `users` - ein Extra kann Erinnerungen
 * wollen, obwohl der Nutzer den Vorlauf fuer seine regulaere Schicht nie
 * eingeschaltet hat, oder umgekehrt. Keine Anker-Tabelle noetig: eine
 * schedule_extra_shifts-Zeile IST schon die stabile Id, sobald sie angelegt
 * wird - anders als ein Musterzyklus-Tag (siehe Modulkommentar oben).
 */
function syncExtraRemindersForUser(database, userId, entries, tz, now) {
  const qualifying = entries.filter((e) => e.source === 'extra' && e.shift_type?.start_time && e.shift_type?.end_time && e.reminder_offset_minutes != null);
  const qualifyingIds = new Set(qualifying.map((e) => e.extra_id));

  const existing = database.prepare(`SELECT id, entity_id, remind_at FROM reminders WHERE entity_type = 'schedule_extra_entry' AND created_by = ?`).all(userId);
  for (const row of existing) {
    if (!qualifyingIds.has(row.entity_id)) database.prepare('DELETE FROM reminders WHERE id = ?').run(row.id);
  }
  const byExtraId = new Map(existing.map((row) => [row.entity_id, row]));

  for (const entry of qualifying) {
    const remindAt = shiftReminderAt(entry.date_key, entry.shift_type.start_time, entry.reminder_offset_minutes, tz);
    const current = byExtraId.get(entry.extra_id);
    if (current) {
      if (current.remind_at === remindAt) continue;
      database.prepare('DELETE FROM reminders WHERE id = ?').run(current.id);
    }
    if (`${remindAt}Z` > isoNow(now)) {
      database.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('schedule_extra_entry', ?, ?, ?)`).run(entry.extra_id, remindAt, userId);
    }
  }
}

function dropExtraReminders(database, userId) {
  database.prepare(`DELETE FROM reminders WHERE entity_type = 'schedule_extra_entry' AND created_by = ?`).run(userId);
}

/**
 * STRANDIERTE ERINNERUNGEN OHNE ANKER einsammeln: `schedule_reminder_entries.
 * shift_type_id` ist bewusst ON DELETE CASCADE (Migration 184's Kommentar),
 * anders als jeder andere lebende Bezug auf `schedule_shift_types` (Overrides,
 * Musterzyklus-Tage, Extras haengen alle mit RESTRICT daran). Loescht jemand
 * eine Ausnahme, ohne dass dieser Sync sofort danach laeuft, und wird der nun
 * unbenutzte Schichttyp geloescht, BEVOR der naechste Lauf den Anker selbst
 * als gegenstandslos erkennt, reisst die Kaskade den Anker weg - die
 * `reminders`-Zeile (entity_type 'schedule_entry') bleibt zurueck und zeigt
 * auf eine Anker-Id, die es nicht mehr gibt. Weder dropPrimary() (gleich
 * unten, geht ueber vorhandene Anker-Ids) noch die Abraeum-Schleife im
 * Hauptpfad (geht ebenfalls ueber vorhandene Anker-Ids) findet so eine Zeile -
 * beide muessten den Anker noch sehen, um ihn abzuraeumen. Deshalb hier ein
 * Abgleich, der NICHT ueber Anker-Ids geht: eine indizierte NOT EXISTS statt
 * einer Schleife je Zeile (reminders.entity_id traegt keinen echten
 * Fremdschluessel, dasselbe polymorphe Muster wie ueberall sonst hier).
 *
 * Extras (entity_type 'schedule_extra_entry') haengen mit RESTRICT an
 * schedule_shift_types, koennen also nicht auf demselben Weg verwaisen - aber
 * eine schedule_extra_shifts-Zeile kann verschwinden (Loeschen ueber
 * routes/schedule-extras.js), waehrend syncExtraRemindersForUser() aus
 * irgendeinem Grund genau diesen Lauf nicht sieht (z.B. eine Ausnahme weiter
 * oben in diesem Lauf, siehe syncAllScheduleReminders()'s try/catch je
 * Nutzer). Gleiche Absicherung, gleicher Grund.
 */
function sweepStrandedReminders(database, userId) {
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'schedule_entry' AND created_by = ?
      AND NOT EXISTS (SELECT 1 FROM schedule_reminder_entries e WHERE e.id = reminders.entity_id)
  `).run(userId);
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'schedule_extra_entry' AND created_by = ?
      AND NOT EXISTS (SELECT 1 FROM schedule_extra_shifts s WHERE s.id = reminders.entity_id)
  `).run(userId);
}

/**
 * Soll-Zustand fuer EINEN Nutzer herstellen: Anker anlegen/abraeumen und die
 * zugehoerigen `reminders`-Zeilen nachziehen.
 */
function syncScheduleRemindersForUser(database, userId, now = new Date()) {
  // ZUERST das, was gar keinen Anker mehr hat (siehe sweepStrandedReminders
  // oben) - unabhaengig davon, ob der Rest dieser Funktion gleich abschaltet
  // (scheduleDisabled/lacksSchedule unten) oder normal durchlaeuft: beide
  // Pfade darunter gehen ueber vorhandene Anker-Ids und wuerden eine bereits
  // verwaiste Zeile nie finden.
  sweepStrandedReminders(database, userId);

  const dropPrimary = () => {
    // Anker zuerst abfragen, dann beides loeschen - reminders.entity_id
    // traegt keinen echten Fremdschluessel auf schedule_reminder_entries
    // (dasselbe polymorphe Muster wie bei jedem anderen entity_type).
    const anchors = database.prepare('SELECT id FROM schedule_reminder_entries WHERE user_id = ?').all(userId);
    if (anchors.length) {
      const ids = anchors.map((a) => a.id);
      database.prepare(`DELETE FROM reminders WHERE entity_type = 'schedule_entry' AND entity_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    database.prepare('DELETE FROM schedule_reminder_entries WHERE user_id = ?').run(userId);
  };

  if (scheduleDisabled(database) || lacksSchedule(database, userId)) {
    dropPrimary();
    dropExtraReminders(database, userId);
    return;
  }

  const tz = householdTimeZone(database);
  const today = todayKey(database, now);
  const to = shiftDateKey(today, REMINDER_WINDOW_DAYS);
  const { entries } = scheduleData(today, to, userId);

  // Extras werden UNABHAENGIG vom haushaltweiten Vorlauf synchronisiert (siehe
  // syncExtraRemindersForUser oben) - immer, gleich ob der primaere Pfad unten
  // ueberhaupt laeuft.
  syncExtraRemindersForUser(database, userId, entries, tz, now);

  const user = database.prepare('SELECT id, schedule_reminder_offset_minutes FROM users WHERE id = ?').get(userId);
  const offsetMinutes = user?.schedule_reminder_offset_minutes;
  if (offsetMinutes == null) {
    dropPrimary();
    return;
  }

  // Nur Tage mit einer UHRZEIT qualifizieren sich - ein freier Tag hat keinen
  // Beginn, und ein zeitloser Typ (Urlaub, Krank) ebenso wenig. Dieselbe Regel
  // wie der ICS-Export (server/services/schedule-ics.js) fuer "ganztaegig".
  // `source !== 'extra'` haelt den primaeren Pfad getrennt von Extras - sonst
  // wuerde ein Extra am selben Datum die Map ueberschreiben oder einen
  // bestehenden Anker als "gegenstandslos" abraeumen, obwohl der Tag noch die
  // primaere Schicht hat. Ein Musterzyklus-Tag kann jetzt MEHRERE qualifizierende
  // Eintraege am selben Datum liefern (Stundenplan) - der Schluessel traegt
  // deshalb pattern_day_id mit, sonst wuerde die Map alle bis auf den letzten
  // stillschweigend verwerfen. Ein Override bleibt weiterhin hoechstens einer
  // je Tag (pattern_day_id ist dort immer null), der leere String dahinter
  // ist nur eine Map-Schluessel-Bequemlichkeit, keine SQL-NULL-Semantik.
  const qualifying = entries.filter((e) => e.source !== 'extra' && e.shift_type?.start_time && e.shift_type?.end_time);
  const slotKey = (dateKey, patternDayId) => `${dateKey}:${patternDayId ?? ''}`;
  const qualifyingBySlot = new Map(qualifying.map((e) => [slotKey(e.date_key, e.pattern_day_id), e]));

  // GEGENSTANDSLOSES ZUERST, gleiche Reihenfolge wie der Vorrats-Sync: ein
  // Anker, dessen Tag/Slot nicht mehr qualifiziert (Override entfernt eine
  // Zeit-Schicht, Musters geaendert, eine Klasse verschwunden, ...), geht
  // mitsamt seiner Erinnerung. Ein Speichern im Muster-Tageseditor vergibt
  // JEDER Zeile eine frische pattern_day_id (server/routes/schedule.js's
  // PUT /patterns/:id/days loescht und legt immer alle Tage neu an) - ein
  // Anker unter der alten Id qualifiziert deshalb beim naechsten Lauf nicht
  // mehr und wird hier abgeraeumt, dann unten unter der neuen Id neu angelegt.
  // Absichtlich keine DB-Kaskade dafuer (siehe Migration 188's Kommentar).
  const existingAnchors = database.prepare('SELECT id, date_key, shift_type_id, pattern_day_id FROM schedule_reminder_entries WHERE user_id = ?').all(userId);
  for (const anchor of existingAnchors) {
    const entry = qualifyingBySlot.get(slotKey(anchor.date_key, anchor.pattern_day_id));
    if (!entry || entry.shift_type_id !== anchor.shift_type_id) {
      database.prepare(`DELETE FROM reminders WHERE entity_type = 'schedule_entry' AND entity_id = ?`).run(anchor.id);
      database.prepare('DELETE FROM schedule_reminder_entries WHERE id = ?').run(anchor.id);
    }
  }

  const upsertAnchor = database.prepare(`
    INSERT INTO schedule_reminder_entries (user_id, date_key, shift_type_id, pattern_day_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date_key, COALESCE(pattern_day_id, 0)) DO UPDATE SET shift_type_id = excluded.shift_type_id
    RETURNING id
  `);

  for (const entry of qualifying) {
    const anchorId = upsertAnchor.get(userId, entry.date_key, entry.shift_type_id, entry.pattern_day_id).id;
    const remindAt = shiftReminderAt(entry.date_key, entry.shift_type.start_time, offsetMinutes, tz);

    const existing = database.prepare(`
      SELECT id, remind_at FROM reminders WHERE entity_type = 'schedule_entry' AND entity_id = ?
    `).get(anchorId);

    if (existing) {
      // BESTEHENDE ZEILE UNANGETASTET, wenn der Zielzeitpunkt gleich bleibt -
      // sonst risse ein Lauf alle paar Minuten pushed_at/dismissed zurueck und
      // dieselbe Meldung ginge immer wieder raus.
      if (existing.remind_at !== remindAt) {
        database.prepare('DELETE FROM reminders WHERE id = ?').run(existing.id);
        // Kein Neuanlegen fuer einen inzwischen verstrichenen Zielzeitpunkt -
        // eine verschobene Schicht, deren neuer Vorlauf schon hinter uns liegt,
        // bekommt keine Meldung mehr nachgereicht.
        if (`${remindAt}Z` > isoNow(now)) {
          database.prepare(`
            INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('schedule_entry', ?, ?, ?)
          `).run(anchorId, remindAt, userId);
        }
      }
      continue;
    }

    // NEU NUR, WENN DER ZIELZEITPUNKT NOCH BEVORSTEHT - ein Tag, der schon vor
    // dem Sync-Lauf faellig gewesen waere, ist keine Vorwarnung mehr, sondern
    // stumpfe Nachzustellung. Gleiche Haltung wie beim Vorrat fuer den
    // ungeklemmten Fall, ohne dessen Frischware-Sonderregel.
    if (`${remindAt}Z` > isoNow(now)) {
      database.prepare(`
        INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('schedule_entry', ?, ?, ?)
      `).run(anchorId, remindAt, userId);
    }
  }
}

function isoNow(now) {
  return now.toISOString();
}

/**
 * Fuer jeden Nutzer mit aktiviertem Vorlauf den Soll-Zustand herstellen.
 * Laeuft periodisch, gleiche Stelle wie der Vorrats-Sync
 * (server/services/notifications.js#processDueNotifications).
 */
export function syncAllScheduleReminders(database, now = new Date()) {
  const users = database.prepare(`
    SELECT id FROM users WHERE schedule_reminder_offset_minutes IS NOT NULL
  `).all();
  // Bereits abgeschaltete Konten koennen trotzdem noch Anker/Erinnerungen von
  // einer frueheren Einstellung tragen (Modul zwischenzeitlich gesperrt,
  // Berechtigung entzogen) - drop() in syncScheduleRemindersForUser() raeumt
  // sie ueber die dortigen Gates ab, auch wenn diese Auswahl sie nicht traf.
  const anyAnchor = database.prepare('SELECT user_id FROM schedule_reminder_entries GROUP BY user_id').all();
  // Extras haben ihren eigenen Vorlauf (siehe syncExtraRemindersForUser) - ein
  // Nutzer ohne eigenen users.schedule_reminder_offset_minutes taucht sonst
  // nirgends in dieser Auswahl auf, obwohl ein Extra ihn durchaus braucht.
  const anyExtraOffset = database.prepare('SELECT DISTINCT user_id FROM schedule_extra_shifts WHERE reminder_offset_minutes IS NOT NULL').all();
  const anyExtraReminder = database.prepare(`SELECT DISTINCT created_by AS user_id FROM reminders WHERE entity_type = 'schedule_extra_entry'`).all();
  const candidateIds = new Set([...users.map((u) => u.id), ...anyAnchor.map((a) => a.user_id), ...anyExtraOffset.map((r) => r.user_id), ...anyExtraReminder.map((r) => r.user_id)]);
  for (const userId of candidateIds) {
    try {
      syncScheduleRemindersForUser(database, userId, now);
    } catch (err) {
      log.error(`Schedule reminder sync failed for user ${userId}:`, err?.message || err);
    }
  }
}

export { syncScheduleRemindersForUser };
