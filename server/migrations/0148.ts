// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 148,
    description: 'PRN medications: minimum interval and default dose per dose (#700)',
    up: `
      -- Discussion #700: "bei Bedarf" stand seit v65 als Spalte, im Formular und
      -- als Abzeichen in der Liste - nur gebucht werden konnte so eine Dosis
      -- nicht, weil beide Buchungspfade an einem Knopf hingen, den erst ein
      -- Zeitplan erzeugt. Ein Bedarfsmedikament hat definitionsgemaess keinen.
      --
      -- min_interval_hours ist der Mindestabstand zweier Dosen in Stunden. Er
      -- ist der eigentliche Wunsch aus der Meldung: aus ihm und der letzten
      -- Einnahme faellt der Zeitpunkt, ab dem die naechste erlaubt ist. REAL,
      -- weil "alle 4,5 Stunden" auf Beipackzetteln vorkommt. NULL = kein
      -- Abstand hinterlegt, dann bleibt der Countdown aus.
      --
      -- prn_dose_qty ist die uebliche Menge je Bedarfseinnahme - das Gegenstueck
      -- zu medication_schedules.dose_qty, das es fuer eine geplante Dosis schon
      -- gibt. Ohne sie wuesste die Bedarfsbuchung keine Menge und koennte den
      -- Bestand nicht mitfuehren, waehrend die geplante das seit jeher tut.
      ALTER TABLE medications ADD COLUMN min_interval_hours REAL;
      ALTER TABLE medications ADD COLUMN prn_dose_qty REAL;
    `,
  };
