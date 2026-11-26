export default {
    version: 155,
    description: 'Tasks: locked flag - a locked task keeps its definition closed to everyone but its creator and admins (#830)',
    up: `
      -- AUFGABE SPERREN (#830).
      --
      -- Der Wunsch: Eltern legen eine Aufgabe fest, Kinder sollen sie erledigen
      -- koennen, aber nicht umschreiben. Die Modulrechte koennen das nicht
      -- ausdruecken - sie kennen nur read-only fuers GANZE Modul, und read-only
      -- verhindert auch das Abhaken, womit der Zweck entfaellt.
      --
      -- Der Riegel sitzt deshalb an der einzelnen Aufgabe und trennt zwei Dinge,
      -- die bisher eines waren: die DEFINITION (Titel, Beschreibung, Kategorie,
      -- Termine, Wiederholung, Punkte, Sichtbarkeit, Tags, Dokumente, Loeschen)
      -- ist zu, waehrend die INTERAKTION (Ansehen, Abhaken, Kommentieren,
      -- eigene Erinnerung, sich selbst zuweisen) offen bleibt.
      --
      -- BEWUSST KEINE ABLEITUNG AUS family_role. Eine Familienrolle sagt, wer
      -- jemand IST, nicht was er DARF - und "Elternteil" ist dort kein einzelner
      -- Wert: dad/mom/parent sicher, grandparent je nach Haushalt, relative
      -- nicht. Jede Regel darauf muesste diese Liste raten. #584 hat dieselbe
      -- Ableitung bereits einmal durch explizite Grants ersetzt; berechtigt sind
      -- hier Ersteller:in und Admins.
      --
      -- Default 0: bestehende Aufgaben verhalten sich unveraendert.
      ALTER TABLE tasks ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
    `,
  };
