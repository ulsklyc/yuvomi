/**
 * Modul: Aktiv oder ehemalig - der Zustand einer users-Zeile (#1381)
 * Zweck: Die EINE Stelle, die `users.deactivated_at` als SQL schreibt.
 * Abhaengigkeiten: keine - mit Absicht.
 *
 * WARUM DAS NICHT IN household-members.js STEHT, obwohl es dorthin gehoert:
 * jenes Modul importiert `server/db.js`, und dessen Import oeffnet die
 * Datenbank. Die Feed-Dienste, die Erinnerungs-Abgleiche und die
 * Zwei-Faktor-Uebersicht bekommen ihre Verbindung gereicht und importieren
 * `db.js` bewusst nicht; sie brauchen diese Bedingung trotzdem. Deshalb steht
 * der reine SQL-Text hier, ohne Import, und household-members.js reicht ihn
 * weiter und baut `householdMemberSql()` darauf - fuer alles mit Verbindung
 * bleibt jenes Modul die Adresse.
 *
 * `npm run test:user-traces-guard` wird rot, sobald der Spaltenname unter
 * server/ ausserhalb dieses Moduls, des Entfern-Dienstes
 * (services/user-removal.js) und der Migration gelesen oder geschrieben wird.
 */

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) {
    throw new TypeError(`account-state: invalid table alias ${JSON.stringify(alias)}`);
  }
  return alias;
}

/**
 * SQL-Bedingung "die users-Zeile unter `alias` ist nicht deaktiviert".
 *
 * Fuer Stellen, die bewusst jedes KONTO sehen (Token-Subjekte, Hintergrundjobs,
 * Feed-Tokens) und trotzdem keinen Ehemaligen meinen. Listen von MITGLIEDERN
 * nehmen `householdMemberSql()`, das diese Bedingung schon enthaelt.
 *
 * @param {string} alias Tabellenname oder -alias der users-Zeile
 * @returns {string} Bedingung zum Einsetzen in eine WHERE- oder JOIN-Klausel
 */
export function activeAccountSql(alias) {
  return `${checkedAlias(alias)}.deactivated_at IS NULL`;
}

/**
 * Die Spalte fuer eine SELECT-Liste, die den Zustand AUSGIBT (Kontenverwaltung):
 * der Zeitpunkt des Deaktivierens unter dem Namen `deactivated_at`, sonst NULL.
 */
export function deactivatedAtColumnSql(alias) {
  return `${checkedAlias(alias)}.deactivated_at AS deactivated_at`;
}
