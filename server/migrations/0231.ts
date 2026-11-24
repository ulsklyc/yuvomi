// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 231,
    description: 'Users: a deactivated account keeps its row (#1381)',
    // WER SPUREN IN GETEILTEN DATEN HINTERLASSEN HAT, WIRD DEAKTIVIERT STATT
    // GELOESCHT (#1381). `DELETE FROM users` liess bis hierher die
    // Fremdschluessel entscheiden: was ein Konto angelegt hatte, ging per
    // CASCADE mit (Buchungen, Termine, Notizen, Dokumente), und wer an einer
    // geteilten Ausgabe beteiligt war, liess sich wegen RESTRICT gar nicht
    // entfernen. Die Zeile bleibt jetzt stehen und traegt hier, seit wann sie
    // kein Zugang mehr ist.
    //
    // NULL = aktiv. Eine eigene Spalte und kein weiterer Wert einer
    // bestehenden: "ehemalig" und "hat keinen Login" (Hauspersonal, Display)
    // sind zwei Tatsachen. Beide weist `canSignIn()` ab, aber nur Ehemalige
    // fallen aus den Auswahllisten - das Praedikat dazu steht einmal, in
    // server/services/household-members.js (`activeAccountSql()`).
    //
    // KEIN BACKFILL: vor dieser Migration gab es den Zustand nicht. Kein
    // Index: gefragt wird immer zusammen mit der id oder ueber alle Zeilen
    // einer Tabelle, die so viele Zeilen hat wie der Haushalt Menschen.
    //
    // Ein kuenftiger Rebuild von users muss die Spalte mitnehmen.
    up: `
      ALTER TABLE users ADD COLUMN deactivated_at TEXT;
    `,
  };
