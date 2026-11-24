export default {
    version: 89,
    description: 'CardDAV contact origin: distinguish remotely imported from locally adopted contacts',
    up: `
      -- Herkunft eines CardDAV-verknüpften Kontakts. Der Sync muss entscheiden
      -- können, was passiert, wenn der Server einen Kontakt nicht mehr liefert:
      --   'remote' = ausschließlich aus CardDAV importiert → darf gelöscht werden.
      --   'merged' = ein bereits lokal vorhandener Kontakt, den die Smart-Merge-
      --              Logik nur adoptiert hat (Treffer über E-Mail/Telefon). Er
      --              trägt lokal gepflegte Daten, die remote nie existiert haben,
      --              und wird deshalb nur entkoppelt statt gelöscht.
      -- NULL = kein CardDAV-Bezug (rein lokaler Kontakt).
      --
      -- Bestand bekommt bewusst 'merged' und NICHT 'remote': für bereits
      -- synchronisierte Kontakte ist die Herkunft nicht mehr rekonstruierbar. Die
      -- konservative Annahme kostet höchstens einen Kontakt, der nach dem
      -- Remote-Löschen als lokaler Kontakt zurückbleibt; die umgekehrte Annahme
      -- würde beim ersten Sync Nutzerdaten vernichten. Ab dieser Migration frisch
      -- importierte Kontakte tragen ihre echte Herkunft.
      ALTER TABLE contacts ADD COLUMN carddav_origin TEXT
        CHECK (carddav_origin IN ('remote', 'merged'));

      UPDATE contacts SET carddav_origin = 'merged' WHERE carddav_uid IS NOT NULL;
    `,
  };
