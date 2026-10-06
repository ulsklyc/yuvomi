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
 * herausgeben: `cook_user_id` steht schon in `m.*`, dazu Name, Farbe und Bild
 * der Person. EIN Ausdruck fuer jede Abfrage, die Mahlzeiten liest - hier und
 * in der Uebersicht (server/routes/dashboard.js) -, mit dem Join daneben. Die
 * Mahlzeit steht in beiden Abfragen unter dem Alias `m`.
 *
 * KEIN `householdMemberSql()` AM JOIN: das ist keine Liste von Personen, aus
 * der jemand waehlt, sondern der Name an einem gespeicherten Verweis. Ein Koch,
 * der inzwischen ehemalig ist, behaelt seinen Namen an der Mahlzeit, so wie der
 * Zustaendige einer Aufgabe; wer NEU waehlbar ist, entscheidet `cookRefusal()`.
 */
export const MEAL_COOK_COLUMNS_SQL = `
           cook.display_name AS cook_name, cook.avatar_color AS cook_color,
           cook.avatar_data AS cook_avatar`;
export const MEAL_COOK_JOIN_SQL = 'LEFT JOIN users cook ON cook.id = m.cook_user_id';

/**
 * Liest `cook_user_id` aus einem Request-Body.
 *
 * DREI ZUSTAENDE, UND DER UNTERSCHIED TRAEGT: fehlt das Feld, ist der Koch
 * "nicht angefasst" (`given: false`) - ein Client, der nur das Datum schickt
 * (Verschieben per Ziehen), darf ihn nicht loeschen. `null` oder ein leerer
 * String heisst ausdruecklich "niemand". Alles andere muss eine positive ganze
 * Zahl sein; eine Liste ist es nie, eine Mahlzeit hat EINEN Koch.
 *
 * @returns {{ given: boolean, value: number|null, error: string|null }}
 */
export function cookField(raw) {
  if (raw === undefined) return { given: false, value: null, error: null };
  if (raw === null || raw === '') return { given: true, value: null, error: null };
  const id = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
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
