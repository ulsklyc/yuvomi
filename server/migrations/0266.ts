export default {
    version: 266,
    description: 'sync: a mirrored row is marked once a sync run has seen its object (#1839)',
    up: `
      -- GESEHEN, NICHT HOCHGELADEN (#1839, Entscheidung 9.10.): eine Zeile gilt
      -- erst als Spiegel, wenn ein Abruf ihr Objekt auf dem Server gefunden hat.
      -- "Der PUT hat geantwortet" ist kein Beleg: vor #1837 stempelte ein
      -- abgelehnter Upload die Zeile zum Spiegel eines Objekts, das es nie gab,
      -- und der naechste Prune loeschte sie als "anderswo entfernt".
      --
      -- 1 setzt nur der Abruf (der Prune, fuer jede Zeile, deren UID er
      -- gesehen hat), nie der Upload. Der Prune loescht nur gesehene Zeilen;
      -- eine nie gesehene, hier angelegte faellt auf lokal zurueck und geht
      -- erneut hinauf. Bestandszeilen starten mit 0: der erste Lauf nach dem
      -- Update loescht nichts, was er nicht gesehen hat.
      ALTER TABLE calendar_events ADD COLUMN seen_on_server INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks           ADD COLUMN seen_on_server INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shopping_items  ADD COLUMN seen_on_server INTEGER NOT NULL DEFAULT 0;
    `,
  };
