// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 150,
    description: 'countdown flag on events and tasks (#647)',
    up: `
      -- Discussion #647: "XX Tage bis ..." - und die eigentliche Arbeit war die
      -- Frage, WO das lebt. Der Thread hat sie zu Ende diskutiert und kommt auf
      -- ein Flag an dem, was es ohnehin schon gibt, statt auf ein zweites
      -- System:
      --
      --   @Kyrodan zaehlt bis zu Terminen, die er sowieso im Kalender fuehrt
      --   (Urlaub, "Disney+ verlaengern"). Ein eigenes Objekt hiesse fuer ihn,
      --   dasselbe Datum zweimal zu pflegen.
      --
      --   @jamespurnama1 zaehlt bis zum Fuehrerschein und bis zum Luftfilter -
      --   nichts davon ist ein Termin, und sein Punkt ist die RUECKSETZUNG auf
      --   dieselbe DAUER, nicht auf dasselbe Datum. Das ist genau
      --   tasks.recurrence_from_completion (Migration 137, #658), das es hier
      --   schon gibt. Er hat als Aufloesung ein Uebersichts-Widget
      --   vorgeschlagen, das aus BEIDEN Quellen einsammelt.
      --
      -- Ein drittes Objekt haette also nur eine dritte Schreibweise fuer eine
      -- Faelligkeit hinzugefuegt, die zweimal existiert. Zwei Flags und ein
      -- Widget kommen ohne aus.
      --
      -- Bei calendar_events gehoert das Flag in dieselbe Gruppe wie icon (v53)
      -- und visibility (v83): Yuvomi-eigene Felder ohne CalDAV-/Google-
      -- Gegenstueck. Es steht nicht in MIRRORED_FIELDS
      -- (services/calendar-outbound.js), loest also keinen Push aus, und der
      -- Rueckweg schreibt eine feste Spaltenliste, laesst es also stehen - eine
      -- Anzeigeeinstellung, die nur hier etwas bedeutet, ueberlebt damit jeden
      -- Sync-Lauf.
      ALTER TABLE calendar_events ADD COLUMN countdown INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks           ADD COLUMN countdown INTEGER NOT NULL DEFAULT 0;
    `,
  };
