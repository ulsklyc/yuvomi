/**
 * Modul: Fuer wen ein Wandtablett handelt (#1209)
 * Zweck: Die eine Pruefung, die beide Display-Handlungen teilen - abhaken und
 *        eine Einloesung beantragen -, bevor sie in die jeweilige Route laufen.
 * Abhaengigkeiten: household-members (das Mitglieder-Praedikat aus #1207),
 *        permissions (die Modulrechte der GEWAEHLTEN Person).
 *
 * WARUM DIESE DATEI NEBEN display-scopes.js UND display-accounts.js STEHT.
 * `display-scopes.js` sagt, welche Pfade ein Display erreicht - eine Tatsache
 * ueber das Produkt, ohne eine einzige Abfrage. `display-accounts.js` haelt die
 * Kopplung: Codes, Credentials, Widerruf. Hier steht die dritte Frage, und sie
 * ist keine von beiden: FUER WEN handelt dieses Geraet gerade, und darf diese
 * Person das ueberhaupt.
 *
 * DIE ANTWORT HAENGT NICHT AM GERAET, SONDERN AM REQUEST. Ein Display hat keine
 * Sitzung je Person und soll keine bekommen: an der Kuechenwand tippt mal die
 * eine, mal der andere, und ein gespeicherter „aktueller Nutzer" waere genau
 * die Zeile, die nach dem Abendessen noch die falsche Person zeigt. Die Wahl
 * geht deshalb in jedem Aufruf mit und gilt nur fuer ihn.
 */

import { isHouseholdMember, nonMemberMessage } from './household-members.js';
import { resolvePermissions } from '../permissions.js';
import * as dbModule from '../db.js';

/**
 * Handelt dieser Request als gekoppeltes Display?
 *
 * EINE FRAGE AN `req`, KEINE AN DIE DATENBANK. `requireAuth()` hat die Antwort
 * beim Anmelden schon gehabt und in `req.authMethod` hinterlegt; sie hier
 * nachzuschlagen hiesse, jede Route an die `display_accounts`-Tabelle zu
 * binden - genau der Fehler, den `permissions.js` im Kommentar zu `isDisplay`
 * beschreibt (fuenf Suiten mit handgebautem Schema fielen daran um).
 */
export function isDisplayRequest(req) {
  return req?.authMethod === 'display';
}

/**
 * Fuer welche Person handelt dieses Display, und darf sie es?
 *
 * Gibt entweder `{ ok: true, userId }` zurueck oder eine fertige Absage. KEIN
 * WURF: beide Aufrufer stehen in einem `try`, das jeden Fehler zu einer 500
 * macht - eine 400, die als 500 herauskommt, ist die Absage, die niemandem
 * sagt, was zu tun ist.
 *
 * DIE DREI PRUEFUNGEN, und warum es genau diese sind (#1209):
 *
 * 1. EINE PERSON MUSS BENANNT SEIN. Ohne Angabe gaebe es einen stillen
 *    Rueckfall auf das Display-Konto selbst - und damit eine Erledigung, die
 *    niemand getan hat, und eine Einloesung fuer ein Konto, das an Belohnungen
 *    gar nicht teilnimmt. Der Rueckfall ist deshalb KEINE Freundlichkeit,
 *    sondern ein Datenfehler, und wird abgelehnt.
 *
 * 2. SIE MUSS EIN HAUSHALTSMITGLIED SEIN - dasselbe Praedikat, das auch das
 *    Zuweisen zieht (#1207, DECISIONS 4), und derselbe Fehlertext. Das schliesst
 *    Gaeste, Hauspersonal und - ausdruecklich - andere Display-Konten aus:
 *    `householdMemberSql()` nimmt sie aus den Mitgliederlisten, also beantwortet
 *    diese eine Frage auch „ein Tablett hakt nicht fuer ein Tablett ab".
 *
 * 3. SIE MUSS DAS MODUL SCHREIBEN DUERFEN. Das Ticket sagt es als Satz („the
 *    chosen person must be allowed to do it"), und ohne diese Zeile waere das
 *    Tablett der Weg an den Modulrechten vorbei: ein Kind mit `tasks: read`
 *    haekt an seinem eigenen Geraet nichts ab, an der Kuechenwand aber schon.
 *    Gefragt wird nach `write`, nicht nach `read` - abhaken ist ein Schreiben.
 *
 * Die Sichtbarkeit des einzelnen Datensatzes steht NICHT hier: sie braucht die
 * Zeile, die nur die Route hat, und ihre Absage ist eine andere (404 statt 403,
 * damit eine private Aufgabe nicht durch die Art der Absage bestaetigt wird).
 *
 * @param {object} req
 * @param {*} rawId  die gewaehlte Person, wie sie im Rumpf ankam
 * @param {'tasks'|'rewards'} moduleKey
 * @param {{ db?: object }} [options]
 * @returns {{ ok: true, userId: number } | { ok: false, status: number, error: string }}
 */
export function displayActingPerson(req, rawId, moduleKey, { db } = {}) {
  const database = db || dbModule.get();
  const userId = rawId == null || rawId === '' ? null : Number(rawId);
  if (!Number.isInteger(userId)) {
    return { ok: false, status: 400, error: 'A paired display must name the person it is acting for.' };
  }
  if (!isHouseholdMember(userId, { db: database })) {
    return { ok: false, status: 400, error: nonMemberMessage([userId]) };
  }
  const user = database
    .prepare('SELECT id, role, family_role FROM users WHERE id = ?')
    .get(userId);
  // Die Zeile GIBT es - `isHouseholdMember` hat sie eben gefunden. Der Guard
  // steht trotzdem: zwischen beiden Abfragen liegt kein `await` und damit kein
  // Yield-Punkt, aber ein `user` von `undefined` liefe hier in einen
  // TypeError und damit in eine 500, und das ist eine schlechtere Absage als
  // die richtige.
  if (!user) {
    return { ok: false, status: 400, error: nonMemberMessage([userId]) };
  }
  const { admin, modules } = resolvePermissions(database, user);
  if (!admin && modules[moduleKey] !== 'write') {
    return {
      ok: false,
      status: 403,
      error: 'The selected person does not have access to this module.',
    };
  }
  return { ok: true, userId };
}
