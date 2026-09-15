/**
 * Modul: Haushaltsmitglied
 * Zweck: Die eine Antwort auf "ist diese users-Zeile ein Haushaltsmitglied?",
 *        die eine Herleitung von `access_scope` und die eine Pruefung fuer
 *        Routen, die Personen annehmen (#1207).
 * Abhaengigkeiten: server/db.js
 *
 * EINE users-ZEILE IST NICHT AUTOMATISCH EIN HAUSHALTSMITGLIED (docs/DECISIONS.md,
 * Eintrag 4). Zwei Arten stehen heute daneben, das Display-Konto (#913) wird die
 * dritte:
 *
 *   - **Hauspersonal** (`housekeeping_workers`) - ein Konto, damit die Person
 *     ihre eigenen Aufgaben sieht, nicht damit sie den Haushalt mitliest.
 *   - **Geteilte-Ausgaben-Gaeste** (`split_expense_guest_users`) - Externe.
 *     `server/index.js` sperrt sie aus jeder `/api/v1/*`-Route ausser
 *     `/split-expenses`.
 *
 * JEDE LISTE VON MITGLIEDERN GEHT UEBER `householdMemberSql()`, und es gibt
 * genau EINE Fassung: ohne Personal, ohne Gaeste (entschieden am 15.09.2026,
 * #1207). Beantwortet eine Liste die Frage selbst, steht ein Konto, das alle
 * anderen verbergen, genau dort - nicht verborgen, sondern uneinheitlich
 * sichtbar (#1007). `npm run test:household-member-guard` wird rot, sobald
 * unter `server/` eine Liste aus `users` ohne dieses Praedikat entsteht; die
 * Stellen, die bewusst jedes KONTO sehen (Benutzerverwaltung, Anmeldung,
 * Rechte-Matrix, API-Token-Subjekte, Hintergrundjobs je Konto), stehen dort
 * mit Grund in einer Allowlist.
 *
 * UND ALLES ODER NICHTS GILT AUCH BEIM SCHREIBEN. Eine Auswahl, die Personal
 * nicht anbietet, waehrend die Route es annimmt, verbirgt nichts. Routen, die
 * Personen fuer eine dieser Listen annehmen, fragen deshalb `newNonMembers()`
 * - mit dem GESPEICHERTEN Stand daneben: ein Verweis, der schon besteht, bleibt
 * gueltig, damit ein alter Datensatz mit Personal oder Gast weiter speicherbar
 * ist und niemand still aus ihm verschwindet.
 */
import * as dbModule from '../db.js';

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) {
    throw new TypeError(`household-members: invalid table alias ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * SQL-Bedingung "die users-Zeile unter `alias` ist ein Haushaltsmitglied".
 *
 * Nimmt bewusst KEINE Optionen mehr. Die frueheren `includeGuests` und
 * `includeStaff` hielten fest, was Listen vor diesem Modul zeigten; seit alle
 * Listen streng sind, waere jede Option nur ein Weg zurueck in die
 * uneinheitliche Sichtbarkeit. Ein Aufruf mit zweitem Argument wirft, statt es
 * still zu ignorieren. Eine Liste, die jede Zeile sehen muss, gehoert mit Grund
 * in die Allowlist des Guards.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile, z. B. 'u' oder 'users'
 * @returns {string} Bedingung zum Einsetzen in eine WHERE-Klausel
 */
export function householdMemberSql(alias, ...rest) {
  if (rest.length) {
    throw new TypeError('household-members: householdMemberSql() takes no options - every list of members is strict (#1207)');
  }
  const a = checkedAlias(alias);
  return `(NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = ${a}.id)`
    + ` AND NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = ${a}.id))`;
}

/**
 * SQL-Ausdruck fuer `access_scope` der users-Zeile unter `alias`: `split_guest`
 * fuer einen Geteilte-Ausgaben-Gast, sonst `family`. Stand vorher zweimal als
 * wortgleiches CASE (Benutzerliste, Rechte-Matrix) und ein drittes Mal als
 * eigene Abfrage im Login.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile
 * @returns {string}
 */
export function accessScopeSql(alias) {
  const a = checkedAlias(alias);
  return `CASE WHEN EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = ${a}.id) THEN 'split_guest' ELSE 'family' END`;
}

/**
 * Gehoert diese Zeile zum Haushalt? Die Einzelpruefung zur Liste: eine Route,
 * die eine Auswahl annimmt, fragt hier, damit die Auswahl niemanden zeigt, den
 * die Route ablehnt, und niemanden verbirgt, den sie akzeptiert.
 *
 * Getrennt von der Adressfrage (`memberEmail()` in member-email.js), weil die
 * beiden Absagen verschiedene sind: "kenne ich nicht" gegen "hat keine
 * Adresse hinterlegt". Wer sie zusammenwirft, kann dem Nutzer nicht sagen,
 * was zu tun ist.
 */
export function isHouseholdMember(userId, { db } = {}) {
  const database = db || dbModule.get();
  return Boolean(database.prepare(`
    SELECT 1 FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}
  `).get(userId));
}

/**
 * Welche der genannten Konten kaemen NEU dazu und sind keine Haushaltsmitglieder?
 *
 * `stored` ist der gespeicherte Stand des Datensatzes (die Zustaendigen einer
 * Aufgabe, die Teilnehmer eines Termins ...). Wer dort schon steht, bleibt
 * gueltig - sonst liesse sich ein alter Datensatz mit Personal oder Gast nicht
 * mehr speichern, ohne diese Person zu entfernen.
 *
 * Ein Konto, das es gar nicht gibt, meldet diese Funktion NICHT: dafuer hat
 * jede Route schon ihre eigene Antwort (404, still verwerfen, eigene Meldung),
 * und die bleibt, wie sie ist.
 *
 * @param {Iterable<number>} userIds
 * @param {{ stored?: Iterable<number>, db?: object }} [options]
 * @returns {number[]} die abzulehnenden ids, in der Reihenfolge der Anfrage
 */
export function newNonMembers(userIds, { stored = [], db } = {}) {
  const database = db || dbModule.get();
  const keep = new Set([...stored].map(Number));
  const exists = database.prepare('SELECT 1 FROM users WHERE id = ?');
  const member = database.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}`);
  return [...new Set([...userIds].map(Number))]
    .filter((id) => Number.isInteger(id) && !keep.has(id) && exists.get(id) && !member.get(id));
}

/** Die eine Meldung dazu - jede Route sagt dasselbe, damit ein Client einen Grund hat. */
export function nonMemberMessage(ids) {
  return `Only household members can be chosen here - user ${ids.join(', ')} is not a household member.`;
}
