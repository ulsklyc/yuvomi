/**
 * Modul: Der Koch einer Mahlzeit (#1679)
 * Zweck: Die eine Stelle fuer den Personenverweis `cook_user_id` an `meals` und
 *        `meal_recurrence_templates`: wie er gelesen wird (Name, Farbe, Bild
 *        neben der Mahlzeit), wie er aus einem Request kommt und wen eine Route
 *        als Koch annimmt.
 * Abhaengigkeiten: server/db.js, server/services/household-members.js
 *
 * EINE ZUSTAENDIGKEIT, KEIN BESITZ. Der Essensplan gehoert dem Haushalt; der
 * Koch aendert nichts daran, wer eine Mahlzeit sieht oder bearbeitet - das
 * haengt weiter allein am `meals`-Recht. Es ist dieselbe Art Verweis wie der
 * Zustaendige einer Aufgabe (docs/DECISIONS.md, Eintrag 4).
 */
import * as dbModule from '../db.js';
import { newNonMembers, nonMemberMessage } from './household-members.js';

/**
 * Der Koch einer Mahlzeit (#1679), wie ihn die Leseabfragen neben `created_by`
 * herausgeben: `cook_user_id` steht schon in `m.*`, dazu Name und Farbe der
 * Person. EIN Ausdruck fuer jede Abfrage, die Mahlzeiten liest - hier und
 * in der Uebersicht (server/routes/dashboard.js) -, mit dem Join daneben. Die
 * Mahlzeit steht in beiden Abfragen unter dem Alias `m`.
 *
 * KEIN `householdMemberSql()` AM JOIN: das ist keine Liste von Personen, aus
 * der jemand waehlt, sondern der Name an einem gespeicherten Verweis. Ein Koch,
 * der inzwischen ehemalig ist, behaelt seinen Namen an der Mahlzeit, so wie der
 * Zustaendige einer Aufgabe; wer NEU waehlbar ist, entscheidet `cookRefusal()`.
 */
/*
 * DAS BILD GEHT NICHT MIT. `users.avatar_data` ist eine Data-URL bis in die
 * Hunderte Kilobyte; an jeder Mahlzeit haengend kaeme dasselbe Bild in einem
 * Wochenabruf so oft, wie die Person kocht - 21 Mahlzeiten, 21-mal. Name und
 * Farbe reichen fuer die Initialen-Scheibe; das Bild holt die Oberflaeche
 * einmal je Person aus der Mitgliederliste, die sie ohnehin laedt
 * (`/family/members` im Planer, `users` in der Antwort von `/dashboard`).
 */
export const MEAL_COOK_COLUMNS_SQL = `
           cook.display_name AS cook_name, cook.avatar_color AS cook_color`;
export const MEAL_COOK_JOIN_SQL = 'LEFT JOIN users cook ON cook.id = m.cook_user_id';

/**
 * Liest `cook_user_id` aus einem Request-Body.
 *
 * DREI ZUSTAENDE, UND DER UNTERSCHIED TRAEGT: fehlt das Feld, ist der Koch
 * "nicht angefasst" (`given: false`) - ein Client, der nur das Datum schickt
 * (Verschieben per Ziehen), darf ihn nicht loeschen. `null` heisst
 * ausdruecklich "niemand". Alles andere muss eine positive ganze Zahl sein;
 * eine Liste ist es nie, eine Mahlzeit hat EINEN Koch.
 *
 * STRENG AN DER FORM, NICHT AN `Number()`: `Number()` liest "", " " und `false`
 * als 0, `true` als 1, "1e1" als 10 und "0x1" als 1 - ein Tippfehler oder ein
 * leeres Formularfeld wuerde so zu einer id oder zu "niemand". Angenommen wird
 * eine Zahl, die eine positive ganze Zahl IST, oder dieselbe als reine
 * Ziffernfolge ohne Rand und ohne fuehrende Null ("12", wie ein Formular sie
 * schickt). Der leere String ist kein "niemand": dafuer gibt es `null`.
 *
 * @returns {{ given: boolean, value: number|null, error: string|null }}
 */
export function cookField(raw) {
  if (raw === undefined) return { given: false, value: null, error: null };
  if (raw === null) return { given: true, value: null, error: null };
  const id = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { given: true, value: null, error: 'Koch muss die ID eines Haushaltsmitglieds sein.' };
  }
  return { given: true, value: id, error: null };
}

/**
 * Warum dieser Koch nicht angenommen wird - `null`, wenn er passt.
 *
 * WAEHLBAR IST, WEN `householdMemberSql()` LIEFERT (docs/DECISIONS.md, Eintrag
 * 4): Hauspersonal, Geteilte-Ausgaben-Gaeste, Wandtabletts und Ehemalige
 * lehnt `newNonMembers()` ab, dieselbe Frage wie bei den Zustaendigen einer
 * Aufgabe. `stored` ist der gespeicherte Stand: wer an dieser Mahlzeit (oder
 * ihrer Serie) schon steht, bleibt gueltig, damit sie sich weiter speichern
 * laesst, ohne dass jemand still aus ihr verschwindet.
 *
 * Ein Konto, das es nicht gibt, meldet `newNonMembers()` mit Absicht nicht -
 * hier bekaeme es sonst der Fremdschluessel zu fassen und die Route antwortete
 * mit 500. Es bekommt DIESELBE Antwort wie ein Konto, das kein Mitglied ist,
 * im Wortlaut und im Status: "gibt es nicht" gegen "gibt es, ist aber Personal,
 * Gast oder Wandtablett" zu unterscheiden, gaebe ueber Konten Auskunft, nach
 * denen niemand gefragt hat. Die Meldung nennt nur die id, die der Aufrufer
 * selbst geschickt hat - nie Name, Art oder Bild.
 *
 * Liest nur, synchron; der Aufrufer schreibt ohne `await` dazwischen.
 */
export function cookRefusal(cookId, stored = [], { db: database } = {}) {
  if (cookId === null) return null;
  const kept = stored.filter((id) => id !== null && id !== undefined).map(Number);
  if (kept.includes(cookId)) return null;
  const conn = database || dbModule.get();
  if (!conn.prepare('SELECT 1 FROM users WHERE id = ?').get(cookId)) return nonMemberMessage([cookId]);
  const strangers = newNonMembers([cookId], { stored: kept, db: conn });
  return strangers.length ? nonMemberMessage(strangers) : null;
}

/**
 * Der Koch, mit dem eine NEUE Mahlzeit aus einer Serie entsteht: der Koch der
 * Vorlage - oder niemand, wenn die Schreibroute ihn heute als neue Wahl
 * ablehnte.
 *
 * DIESELBE FRAGE WIE BEIM SCHREIBEN, DURCH DASSELBE PRAEDIKAT (`cookRefusal()`
 * ohne gespeicherten Stand): das Materialisieren legt eine Zeile an, die es
 * vorher nicht gab, und fuer die gibt es keinen "schon gespeicherten" Koch.
 * Ohne diese Frage truege jede kuenftige Woche weiter ein ehemaliges Mitglied
 * ein, das POST und PUT an derselben Stelle ablehnen. Die Vorlage bleibt, wie
 * sie ist, und bestehende Mahlzeiten behalten ihren Koch mit Namen (#1381):
 * wird das Konto wieder Mitglied, kocht es die naechste neue Woche wieder.
 *
 * Liest nur, synchron.
 */
export function cookForNewOccurrence(templateCookId, { db: database } = {}) {
  if (templateCookId === null || templateCookId === undefined) return null;
  const id = Number(templateCookId);
  return cookRefusal(id, [], { db: database }) === null ? id : null;
}
