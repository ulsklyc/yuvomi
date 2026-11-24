// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 195,
    description: 'heal contacts auto-created for family/guest members with the legacy Sonstiges category (#1140)',
    up: `
      -- Die Kontakte, die beim Anlegen eines Haushaltsmitglieds oder Gasts
      -- gespiegelt werden (server/auth.js, server/routes/split-expenses.js),
      -- schrieben weiterhin die alte, deutsche Kategorie 'Sonstiges' statt des
      -- stabilen Keys 'misc'. Da 'Sonstiges' kein Key in contact_categories
      -- ist, gab die UI ihn unuebersetzt aus (#1140).
      --
      -- BEWUSST BREITER ALS MIGRATION 91: die beschraenkte sich auf
      -- carddav_uid IS NOT NULL, um manuell angelegte Kontakte zu schonen.
      -- Diese Vorsicht traegt hier nichts mehr: die Spalte hat
      -- DEFAULT 'Sonstiges', und das Kontaktformular bietet nur Keys aus
      -- contact_categories an - kein Nutzer kann den rohen Wert von Hand
      -- eingegeben haben. Jede verbliebene 'Sonstiges'-Zeile ist ein
      -- liegengebliebener Legacy-Default, keine Nutzerentscheidung.
      UPDATE contacts SET category = 'misc' WHERE category = 'Sonstiges';
    `,
  };
