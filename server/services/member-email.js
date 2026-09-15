/**
 * Modul: Mailadresse eines Haushaltsmitglieds
 * Zweck: Die eine Antwort auf "wen darf ich per Mail erreichen und wie" (#944).
 * Abhaengigkeiten: server/db.js
 *
 * EIN MITGLIED HAT KEINE EIGENE ADRESSE. `users` traegt keine Mailspalte; die
 * Adresse haengt am verknuepften Kontakt (`contacts.family_user_id`). Wer das
 * nicht weiss, sucht sie an der falschen Stelle - und wer es an einer zweiten
 * Stelle nachbaut, hat zwei Fassungen derselben Frage. Der Passwort-Reset
 * beantwortete sie bereits so; seit dem Versand der Einkaufsliste tut es ein
 * zweiter Aufrufer, und beide fragen hier.
 *
 * UND NICHT JEDE `users`-ZEILE IST EIN HAUSHALTSMITGLIED. Zwei Arten stehen
 * ausdruecklich daneben:
 *
 *   - **Hauspersonal** (`housekeeping_workers`) - ein Konto, damit die Person
 *     ihre eigenen Aufgaben sieht, nicht damit sie den Haushalt mitliest.
 *   - **Geteilte-Ausgaben-Gaeste** (`split_expense_guest_users`) - Externe.
 *     `server/index.js` sperrt sie aus jeder `/api/v1/*`-Route ausser
 *     `/split-expenses`, und trotzdem legt der Gast-Sync ihnen einen Kontakt
 *     mit Adresse an. Wer nur "gibt es diese users-Zeile" fragt, haelt sie
 *     deshalb faelschlich fuer erreichbar.
 *
 * Die Bedingung steht darum EINMAL, in `server/services/household-members.js`
 * (#1207), und wird von der Liste hier (Empfaengerauswahl) wie von der
 * Einzelpruefung `isHouseholdMember()` dort (Route) benutzt. Waeren es zwei
 * Fassungen, koennte die Auswahl jemanden verbergen, den die Route weiterhin
 * akzeptiert - und genau das ist die Luecke, gegen die sie geschrieben ist.
 *
 * SIE GILT ABER NICHT FUER JEDE FRAGE AN DIESES MODUL. Der Passwort-Reset
 * braucht dieselbe Adresssuche und gilt ausdruecklich auch fuer Gaeste; wer
 * die Mitgliedschaft in `memberEmail()` hineinzoege, naehme einem Gast den Weg
 * zurueck in sein eigenes Konto. Die beiden Fragen bleiben deshalb getrennt.
 */
import * as dbModule from '../db.js';
import { householdMemberSql } from './household-members.js';

/**
 * Genau EINE Adresse, oder gar keine.
 *
 * `contacts.email` ist ein Freitextfeld und kommt teils aus CardDAV. Steht dort
 * "a@x.de, b@y.de", reicht nodemailer beides als Empfaengerliste weiter - beim
 * Passwort-Reset ginge der Link an ein zweites Postfach, bei der Einkaufsliste
 * der Haushaltsinhalt. Im Zweifel lieber nicht erreichbar als an den Falschen:
 * ein Reset laesst sich ueber die Administration nachholen, eine verschickte
 * Mail nicht zurueckholen.
 */
function singleAddress(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // Trenner einer Adressliste, und Leerraum, hinter dem eine zweite anfangen
  // koennte. Zeilenumbrueche faengt `\s` mit ab - die machten aus dem
  // Empfaenger-Header weitere Header.
  if (/[,;\s]/.test(raw)) return null;
  const at = raw.indexOf('@');
  if (at <= 0 || raw.indexOf('@', at + 1) !== -1) return null;
  return raw;
}

/**
 * Die Adresse eines Kontos - OHNE Mitgliedschaftsfrage, und das ist Absicht.
 *
 * Die beiden Aufrufer stellen verschiedene Fragen. Der Passwort-Reset gilt
 * ausdruecklich auch fuer Geteilte-Ausgaben-Gaeste (`server/auth.js`, der
 * forgot-password-Pfad prueft `isSplitExpenseGuest()` als eigenen Grund) - ein
 * Gast hat ein Passwort und darf es zuruecksetzen. Wer die Mitgliedschaft hier
 * hineinzoege, naehme ihm den Weg zurueck in sein eigenes Konto.
 *
 * Wer beides braucht, fragt beides: erst `isHouseholdMember()`, dann diese
 * Funktion. Genau so macht es die Versandroute der Einkaufsliste.
 *
 * @returns {string|null} Adresse, oder null wenn es keine eindeutige gibt.
 */
export function memberEmail(userId, { db } = {}) {
  const database = db || dbModule.get();
  const row = database.prepare(`
    SELECT email FROM contacts
    WHERE family_user_id = ? AND email IS NOT NULL AND email != ''
    LIMIT 1
  `).get(userId);
  return singleAddress(row?.email);
}

/**
 * Alle Haushaltsmitglieder (kein Hauspersonal, kein Geteilte-Ausgaben-Gast) -
 * fuer eine Auswahlliste, die dann noch nach ihrer eigenen Frage filtert (z. B.
 * Health-Zugriff, Familienrolle). Dieselbe Mitgliedschafts-Bedingung wie
 * `isHouseholdMember()` (household-members.js), damit die Liste niemanden
 * zeigt, den die Einzelpruefung ablehnt, und niemanden verbirgt, den sie
 * akzeptiert.
 */
export function listHouseholdMembers({ db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(`
    SELECT u.id, u.display_name, u.family_role
    FROM users u
    WHERE ${householdMemberSql('u')}
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all();
}

/**
 * Mitglieder, die per Mail erreichbar sind - fuer eine Empfaengerauswahl.
 * Dieselbe Bedingung wie `memberEmail()`, damit die Auswahl niemanden zeigt,
 * den die Route ablehnt, und niemanden verbirgt, den sie akzeptiert.
 */
export function listEmailableMembers({ db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(`
    SELECT u.id, u.display_name, c.email
    FROM users u
    JOIN contacts c ON c.family_user_id = u.id
    WHERE c.email IS NOT NULL AND c.email != '' AND ${householdMemberSql('u')}
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all()
    .map((row) => ({ ...row, email: singleAddress(row.email) }))
    .filter((row) => row.email !== null);
}
