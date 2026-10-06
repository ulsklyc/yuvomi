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
 *
 * EIN EHEMALIGES KONTO IST KEIN MITGLIED MEHR (#1381). Wer Spuren in geteilten
 * Daten hinterlassen hat, wird deaktiviert statt geloescht: die Zeile bleibt,
 * damit Urheberschaft und Salden bleiben. `activeAccountSql()` ist die EINE
 * Bedingung dazu (der SQL-Text steht in account-state.js, ohne Datenbank-Import,
 * und wird hier weitergereicht), und `householdMemberSql()` schliesst sie ein -
 * damit faellt ein Ehemaliger aus jeder Auswahl, waehrend der gespeicherte
 * Verweis (Zustaendiger, Teilnehmer, Ersteller) seinen Namen behaelt. "Ehemalig" und "ohne Login" bleiben zwei Tatsachen: Hauspersonal ist
 * aktiv und meldet sich trotzdem nie an.
 */
import * as dbModule from '../db.js';
import { activeAccountSql, deactivatedAtColumnSql } from './account-state.js';

// Weitergereicht: wer eine Verbindung hat, fragt dieses Modul (siehe account-state.js).
export { activeAccountSql, deactivatedAtColumnSql };

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) {
    throw new TypeError(`household-members: invalid table alias ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * Ist dieses Konto aktiv? Die Einzelfrage zu `activeAccountSql()`.
 *
 * Ein Konto, das es nicht gibt, ist NICHT aktiv: wer hier fragt, will wissen,
 * ob er diesem Konto etwas geben darf (eine Sitzung, eine Mail, einen Push).
 */
export function isActiveAccount(userId, { db } = {}) {
  const database = db || dbModule.get();
  return Boolean(database.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${activeAccountSql('u')}`).get(userId));
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
  // Ein Ehemaliger ist kein Mitglied mehr (#1381): die Zeile bleibt fuer
  // Urheberschaft und Salden, aus jeder Auswahl faellt sie hier heraus.
  return `(${activeAccountSql(a)}`
    + ` AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = ${a}.id)`
    + ` AND NOT EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = ${a}.id)`
    // Ein Wandtablett ist kein Familienmitglied (#913, #1208). Es steht hier
    // neben Personal und Gaesten, weil es dieselbe Art Ausnahme ist: eine
    // users-Zeile, die kein Mensch im Haushalt ist. Diese eine Klausel nimmt es
    // aus JEDER Mitgliederliste - Zuweisungen, Teilnehmer, Geburtstage,
    // Erwaehnungen -, weil alle durch dieses Praedikat gehen (#1207).
    + ` AND NOT EXISTS (SELECT 1 FROM display_accounts da WHERE da.user_id = ${a}.id))`;
}

/**
 * SQL-Ausdruck "die Position der users-Zeile unter `alias` in der
 * Haushaltsreihenfolge" (#1644): die gespeicherte Zahl fuer ein
 * Haushaltsmitglied, sonst NULL.
 *
 * DIE POSITION GILT NUR FUER EIN MITGLIED, UND DAS ENTSCHEIDET DER LESER. Wer
 * nach dem Ordnen deaktiviert wird oder Hauspersonal wird, behaelt die Zahl in
 * der Spalte - sie hier auszublenden ist EINE Stelle; sie an jedem Schreibweg
 * zu loeschen (Deaktivieren, Personal anlegen, Gast, Wandtablett) waeren vier,
 * und die fuenfte kaeme mit dem naechsten Kontotyp. Routen geben die Position
 * ueber diesen Ausdruck heraus (`... AS sort_order`), nie die rohe Spalte:
 * der Vergleich im Browser (public/utils/member-order.js) liest genau dieses
 * Feld und kaeme sonst zu einer anderen Reihenfolge als der Server.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile
 * @returns {string}
 */
export function memberPositionSql(alias) {
  const a = checkedAlias(alias);
  return `(CASE WHEN ${householdMemberSql(a)} THEN ${a}.sort_order END)`;
}

/**
 * Dieselbe Sortierung ueber SPALTEN EINES ERGEBNISSES statt ueber die
 * users-Zeile - fuer ein `UNION`, dessen Arme je eine Person liefern.
 * `position` muss dort aus `memberPositionSql()` stammen.
 *
 * NUR UEBER EINER UNTERABFRAGE: `SELECT * FROM (... UNION ALL ...) ORDER BY`.
 * Direkt hinter dem UNION weist SQLite jeden Sortierbegriff ab, der keine
 * Ergebnisspalte ist; und in einem einfachen SELECT neben der users-Tabelle
 * meinte `sort_order` in einem Ausdruck die ROHE Spalte statt des Alias - die
 * Position eines Nicht-Mitglieds kaeme zurueck (test:member-order haelt beides).
 *
 * @param {{ position: string, name: string, id: string }} columns
 * @returns {string}
 */
export function memberOrderOverColumnsSql({ position, name, id }) {
  for (const column of [position, name, id]) {
    if (typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
      throw new TypeError(`household-members: invalid column ${JSON.stringify(column)}`);
    }
  }
  return `(${position} IS NULL) ASC, ${position} ASC, ${name} COLLATE NOCASE ASC, ${id} ASC`;
}

/**
 * DIE EINE REIHENFOLGE DER HAUSHALTSMITGLIEDER (#1644), zum Einsetzen hinter
 * `ORDER BY`. Jede Liste von Personen sortiert hierueber; keine Route schreibt
 * `ORDER BY display_name` selbst.
 *
 *   1. Platzierte vor Unplatzierten (`sort_order` NULL = nicht platziert).
 *   2. Platzierte nach ihrer Position. Luecken sind erlaubt: verglichen wird
 *      die Zahl, nicht ihr Abstand.
 *   3. Unplatzierte nach Anzeigename, `COLLATE NOCASE` - die Regel, die
 *      `/family/members` und die Auswahllisten schon vor #1644 hatten. NOCASE
 *      faltet in SQLite nur ASCII (A-Z); ein Umlaut steht hinter Z. Das ist
 *      die Reihenfolge von vorher und bleibt es, damit ein Haushalt ohne
 *      Positionen nichts wandern sieht.
 *   4. Bei gleichem Namen (und bei zwei gleichen Positionen) die id: ohne
 *      letzten Schluessel waere die Reihenfolge zweier "Alex" dem Zufall des
 *      Abfrageplans ueberlassen und zwischen zwei Routen verschieden.
 *
 * Eine Zeile, die kein Mitglied ist (Kontenverzeichnis `/auth/users`), hat
 * keine Position und steht damit bei den Unplatzierten, nach Name.
 *
 * Nimmt keine Optionen, aus demselben Grund wie `householdMemberSql()`: eine
 * zweite Fassung waere die zweite Reihenfolge. `test:member-order` haelt die
 * Regel und ihren Zwilling im Browser, `test:member-order-guard` haelt, dass
 * unter `server/` keine Personenliste mehr selbst nach dem Namen sortiert.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile
 * @returns {string} Sortierbegriffe zum Einsetzen hinter `ORDER BY`
 */
export function memberOrderSql(alias, ...rest) {
  if (rest.length) {
    throw new TypeError('household-members: memberOrderSql() takes no options - there is one member order (#1644)');
  }
  const a = checkedAlias(alias);
  const position = memberPositionSql(a);
  return `(${position} IS NULL) ASC, ${position} ASC, ${a}.display_name COLLATE NOCASE ASC, ${a}.id ASC`;
}

/**
 * Die Haushaltsmitglieder in der Haushaltsreihenfolge: id und Position. Fuer
 * den Schreibweg (wer darf in der Liste stehen) und fuer Tests.
 *
 * @returns {Array<{ id: number, sort_order: number|null }>}
 */
export function listMemberOrder({ db } = {}) {
  const database = db || dbModule.get();
  return database.prepare(`
    SELECT u.id, ${memberPositionSql('u')} AS sort_order
    FROM users u
    WHERE ${householdMemberSql('u')}
    ORDER BY ${memberOrderSql('u')}
  `).all();
}

/**
 * Warum eine Reihenfolge nicht angenommen wird - `null`, wenn sie stimmt.
 *
 * ALLOWLIST, NICHT DENYLIST: die Liste muss GENAU die Haushaltsmitglieder
 * nennen, jedes einmal. Eine Pruefung "kein Personal, kein Display, kein
 * Ehemaliger" sagte zum naechsten Kontotyp ja; diese fragt die eine Menge, die
 * `householdMemberSql()` ohnehin pflegt. Vollstaendig muss sie sein, weil eine
 * Teilliste zwei Lesarten haette (die Uebrigen behalten ihre Zahl? werden
 * unplatziert?) und der Client sie ohnehin ganz kennt.
 *
 * @param {unknown} order
 * @returns {{ reason: string, error: string }|null}
 */
export function memberOrderProblem(order, { db } = {}) {
  if (!Array.isArray(order) || !order.length
    || order.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return { reason: 'invalid_order', error: 'order must be a non-empty array of user ids (positive integers).' };
  }
  if (new Set(order).size !== order.length) {
    return { reason: 'duplicate_member', error: 'Each household member can be listed only once.' };
  }
  const members = new Set(listMemberOrder({ db }).map((row) => row.id));
  const strangers = order.filter((id) => !members.has(id));
  if (strangers.length) {
    return {
      reason: 'not_a_household_member',
      error: `Only household members have a place in the member order - user ${strangers.join(', ')} is not a household member.`,
    };
  }
  if (order.length !== members.size) {
    const missing = [...members].filter((id) => !order.includes(id));
    return {
      reason: 'incomplete_order',
      error: `The order must list every household member - user ${missing.join(', ')} is missing.`,
    };
  }
  return null;
}

/**
 * Schreibt die Haushaltsreihenfolge: Position 1..n in der genannten Folge, in
 * EINER Transaktion. Der Aufrufer hat `memberOrderProblem()` gefragt.
 *
 * ALLE ANDEREN ZEILEN VERLIEREN IHRE ZAHL. Wer beim Ordnen kein Mitglied war
 * (ehemalig, Personal), stand nicht in der Liste, die jemand geordnet hat -
 * kaeme er spaeter zurueck, waere er "neu" und damit unplatziert, statt mit
 * einer alten Zahl mitten in eine Folge zu fallen, die ohne ihn entstand.
 */
export function writeMemberOrder(order, { db } = {}) {
  const database = db || dbModule.get();
  const clear = database.prepare('UPDATE users SET sort_order = NULL WHERE sort_order IS NOT NULL');
  const place = database.prepare('UPDATE users SET sort_order = ? WHERE id = ?');
  database.transaction(() => {
    clear.run();
    order.forEach((id, index) => place.run(index + 1, id));
  })();
}

/**
 * SQL-Ausdruck fuer `access_scope` der users-Zeile unter `alias`: `display` fuer
 * ein Wandtablett, `split_guest` fuer einen Geteilte-Ausgaben-Gast, sonst
 * `family`. Stand vorher zweimal als wortgleiches CASE (Benutzerliste,
 * Rechte-Matrix) und ein drittes Mal als eigene Abfrage im Login.
 *
 * DIE REIHENFOLGE IST WILLKUERLICH UND DARF ES SEIN: eine Zeile kann nicht
 * beides sein. Ein Display entsteht nur ueber die Display-Route, die eine neue
 * users-Zeile anlegt, und ein Gast nur ueber eine Ausgabengruppe - keine der
 * beiden nimmt ein bestehendes Konto der anderen Art an.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile
 * @returns {string}
 */
export function accessScopeSql(alias) {
  const a = checkedAlias(alias);
  return `CASE`
    + ` WHEN EXISTS (SELECT 1 FROM display_accounts da WHERE da.user_id = ${a}.id) THEN 'display'`
    + ` WHEN EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = ${a}.id) THEN 'split_guest'`
    + ` ELSE 'family' END`;
}

// Die Einzelfrage "ist diese Zeile ein Wandtablett" steht NICHT hier, sondern in
// services/display-accounts.js neben allem anderen, was ein Display ausmacht.
// Hier lebt die Klausel, die es aus den Mitgliederlisten nimmt - zwei Antworten
// auf dieselbe Frage an zwei Orten waeren genau die zweite Wahrheit, gegen die
// dieses Modul gebaut ist.

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
 * `guestsAllowed` gilt fuer die EINE Stelle, an der Gaeste hingehoeren: die
 * Mitglieder einer Ausgabengruppe. Ein Gast existiert fuer geteilte Ausgaben;
 * Hauspersonal bleibt auch dort draussen. Eine Liste macht daraus keine
 * Fassung - das Praedikat selbst kennt keine Optionen.
 *
 * @param {Iterable<number>} userIds
 * @param {{ stored?: Iterable<number>, guestsAllowed?: boolean, db?: object }} [options]
 * @returns {number[]} die abzulehnenden ids, in der Reihenfolge der Anfrage
 */
export function newNonMembers(userIds, { stored = [], guestsAllowed = false, db } = {}) {
  const database = db || dbModule.get();
  const keep = new Set([...stored].map(Number));
  const exists = database.prepare('SELECT 1 FROM users WHERE id = ?');
  const member = database.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}`);
  const scope = database.prepare(`SELECT ${accessScopeSql('u')} AS scope FROM users u WHERE u.id = ?`);
  const active = database.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${activeAccountSql('u')}`);
  return [...new Set([...userIds].map(Number))]
    .filter((id) => Number.isInteger(id) && !keep.has(id) && exists.get(id) && !member.get(id))
    // Ein Gast ist nur dort erlaubt, wo Gaeste hingehoeren - und nur ein
    // aktiver: ein deaktivierter Gast kommt nicht NEU in eine Gruppe (#1381).
    .filter((id) => !(guestsAllowed && scope.get(id)?.scope === 'split_guest' && active.get(id)));
}

/** Die eine Meldung dazu - jede Route sagt dasselbe, damit ein Client einen Grund hat. */
export function nonMemberMessage(ids) {
  return `Only household members can be chosen here - user ${ids.join(', ')} is not a household member.`;
}

/** Dieselbe Meldung fuer die Stelle mit `guestsAllowed`: dort ist nur Hauspersonal ausgeschlossen. */
export function staffMessage(ids) {
  return `Housekeeping staff cannot be chosen here - user ${ids.join(', ')} is neither a household member nor a guest.`;
}
