/**
 * Modul: Haushaltsmitglied
 * Zweck: Die eine Antwort auf "ist diese users-Zeile ein Haushaltsmitglied?" und
 *        die eine Herleitung von `access_scope` (#1207).
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
 * JEDE LISTE VON PERSONEN GEHT UEBER `householdMemberSql()`. Beantwortet eine
 * Liste die Frage selbst, steht ein Konto, das alle anderen verbergen, genau
 * dort - nicht verborgen, sondern uneinheitlich sichtbar (#1007).
 * `npm run test:household-member-guard` wird rot, sobald unter `server/` eine
 * Liste aus `users` ohne dieses Praedikat entsteht; die Stellen, die bewusst
 * jede Zeile sehen (Benutzerverwaltung, Anmeldung, Hintergrundjobs je Konto),
 * stehen dort mit Grund in einer Allowlist.
 *
 * DREI FASSUNGEN SIND IN GEBRAUCH, UND DAS IST BESTAND, KEINE ENTSCHEIDUNG.
 * Streng (ohne Personal, ohne Gaeste) ist der Default. `includeGuests` und
 * `includeStaff` gibt es, weil Listen, die vor diesem Modul ihre eigene Klausel
 * hatten, bis heute nur Personal bzw. nur Gaeste ausschliessen. Die Option macht
 * die Abweichung an der Aufrufstelle sichtbar, statt sie still anzugleichen: ob
 * diese Listen streng werden sollen, ist die offene Frage aus #1207. Wer eine
 * Option entfernt, aendert, wen die Liste zeigt - `test:household-members`
 * haelt jede Liste auf ihrer heutigen Fassung fest.
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
 * Beide Optionen zugleich sind ein Fehler, keine Fassung: eine Liste, die jede
 * Zeile sehen muss, gehoert mit Grund in die Allowlist des Guards - ein
 * Praedikatsaufruf, der nichts ausschliesst, saehe dort aus wie eine gefilterte
 * Liste.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile, z. B. 'u' oder 'users'
 * @param {{ includeStaff?: boolean, includeGuests?: boolean }} [options]
 * @returns {string} Bedingung zum Einsetzen in eine WHERE-Klausel
 */
export function householdMemberSql(alias, { includeStaff = false, includeGuests = false } = {}) {
  const a = checkedAlias(alias);
  if (includeStaff && includeGuests) {
    throw new TypeError('household-members: a list that includes staff and guests sees every row - allowlist it in the guard instead');
  }
  const clauses = [];
  if (!includeStaff) clauses.push(`NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = ${a}.id)`);
  if (!includeGuests) clauses.push(`NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = ${a}.id)`);
  return `(${clauses.join(' AND ')})`;
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
 * Gehoert diese Zeile zum Haushalt, im strengen Sinn? Die Einzelpruefung zur
 * Liste: eine Route, die eine Auswahl annimmt, fragt hier, damit die Auswahl
 * niemanden zeigt, den die Route ablehnt, und niemanden verbirgt, den sie
 * akzeptiert.
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
