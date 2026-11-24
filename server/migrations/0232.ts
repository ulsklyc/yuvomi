// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 232,
    description: 'Users: one household member order (#1644)',
    // EINE REIHENFOLGE DER MITGLIEDER JE HAUSHALT (#1644, aus #1605). Nicht je
    // Person, nicht je Modul: wer hinsieht, sieht dieselbe. Gesetzt wird sie
    // per Ziehen in den Familien-Einstellungen, nur von Administratoren
    // (PATCH /api/v1/family/members/reorder).
    //
    // NULL = NICHT PLATZIERT, UND KEIN BACKFILL. Ein Haushalt, der die
    // Einstellung nie anfasst, hat lauter NULL und sieht die Reihenfolge von
    // vorher: Unplatzierte stehen nach den Platzierten, nach Anzeigename. Ein
    // Backfill haette aus "nie entschieden" eine Entscheidung gemacht - und
    // jedes neue Mitglied stuende danach hinter Z statt im Alphabet.
    //
    // GELESEN WIRD DIE SPALTE AN EINER STELLE: `memberOrderSql()` in
    // server/services/household-members.js (und ihr Zwilling im Browser,
    // public/utils/member-order.js). Dort gilt die Position nur fuer ein
    // Haushaltsmitglied - Hauspersonal, Gaeste, Wandtabletts und ehemalige
    // Konten haben keine, auch wenn hier noch eine Zahl stuende.
    //
    // Kein Index: sortiert wird eine Tabelle mit so vielen Zeilen, wie der
    // Haushalt Menschen hat. Ein kuenftiger Rebuild von users muss die Spalte
    // mitnehmen.
    up: `
      ALTER TABLE users ADD COLUMN sort_order INTEGER;
    `,
  };
