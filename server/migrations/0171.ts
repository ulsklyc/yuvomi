// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 171,
    description: 'Invites carry the starting permissions the admin chose, applied at first login (#869)',
    // DER STANDARD WAR FUER DIE MIGRATION ENTSCHIEDEN, NICHT FUER DIE
    // EINLADUNG. `access_permissions` speichert sparsam: keine Zeile heisst
    // voller Zugriff (v74). Das war richtig, damit bestehende Haushalte sich
    // nach dem Update genauso verhalten wie vorher - und es wurde still zur
    // Antwort auf jede kuenftige Einladung mit. Der Melder in #869 hat den
    // Satz geliefert, an dem das kippt: Rechte lassen sich spaeter oeffnen,
    // aber wer einmal etwas gesehen hat, hat es gesehen.
    //
    // WARUM DIE ANTWORT HIER STEHT UND NICHT IM STANDARD: den Standard
    // umzudrehen wuerde beim naechsten Update genau die Haushalte aussperren,
    // die v74 schuetzen sollte. Diese Spalte aendert dagegen nur, was eine
    // NEUE Einladung mitbringt. Bestehende Konten, bestehende Zeilen und der
    // Standard selbst bleiben unberuehrt; eine Einladung ohne Wert (alle
    // bestehenden) verhaelt sich exakt wie bisher.
    //
    // GESPEICHERT WIRD DAS AUFGELOESTE SET, nicht der Name der Vorlage. Was
    // der Admin im Formular gesehen und abgeschickt hat, ist das, was beim
    // ersten Login gilt - auch wenn jemand das Rollenprofil in der Woche
    // dazwischen aendert. Form: `{"modules":{...},"widgets":{...}}`, dieselbe
    // wie `normalizePermissionInput()` sie annimmt, sparsam wie die Tabelle
    // selbst (nur Abweichungen).
    up: `
      ALTER TABLE invites ADD COLUMN permissions TEXT;
    `,
  };
