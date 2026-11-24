export default {
    version: 127,
    description: 'Tasks: repeat from the completion day instead of the due date (#658)',
    up: `
      -- Bis hierher rechnete die Serie ausschliesslich vom Faelligkeitsdatum:
      -- eine woechentliche Aufgabe, faellig Samstag und erst Montag erledigt, war
      -- wieder am Samstag faellig - also fuenf Tage spaeter, nicht sieben. Fuer
      -- Termine ist das richtig (der Muellabfuhrtag verschiebt sich nicht, weil
      -- man die Tonne spaeter rausstellt), fuer Pflegeintervalle ist es falsch
      -- (der Filter haelt ab dem Wechsel, nicht ab dem geplanten Wechsel).
      --
      -- Beides ist legitim, also entscheidet es die Aufgabe selbst. Default 0:
      -- Bestandsserien behalten ihre faelligkeitsverankerte Rechnung.
      ALTER TABLE tasks ADD COLUMN recurrence_from_completion INTEGER NOT NULL DEFAULT 0;
    `,
  };
