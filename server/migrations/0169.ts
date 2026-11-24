// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 169,
    description: 'Reminders: a reminder on a shared event reaches its assignees, not only its author (#921)',
    // GEMELDET WAR EIN VERPASSTER TERMIN, KEIN FEHLBEDIENUNGSFALL. Eine Frau
    // legt einen Termin an, weist ihn beiden zu und setzt eine Erinnerung. Sie
    // bekommt sie, er bekommt nichts - und wenn er denselben Termin oeffnet,
    // steht das Erinnerungsfeld LEER da. Beide hielten sie fuer geteilt.
    //
    // Der Grund steht im Schema: `reminders` kennt nur `created_by`. Es gab
    // keine Zeile fuer ihn, also gab es auch nichts zu zeigen und nichts
    // zuzustellen. Das Feld log nicht - es hatte schlicht keine Auskunft, und
    // genau das ist der Schaden: eine leere Anzeige liest sich als "es ist
    // keine gesetzt", nicht als "deine ist keine gesetzt".
    //
    // EINE ZEILE JE PERSON, NICHT EINE ZEILE MIT MEHREREN EMPFAENGERN. Was an
    // einer Erinnerung haengt, ist durchweg persoenlich: `dismissed` (wer sie
    // weggewischt hat), `pushed_at` (wem sie schon zugestellt wurde) und die
    // Uhrzeit selbst, die jeder fuer sich verschieben darf. Eine geteilte Zeile
    // mit einer Empfaengerliste braeuchte fuer jedes dieser drei Felder eine
    // zweite Tabelle - und die Abfragen, die heute auf `created_by` stehen,
    // muessten alle umgeschrieben werden.
    //
    // WOFUER assigned_from GEBRAUCHT WIRD. Die Spalte haelt fest, aus WESSEN
    // Geste eine Zeile entstanden ist; NULL heisst "selbst gesetzt", und das
    // sind alle Bestandszeilen. Ohne sie liessen sich zwei Faelle nicht
    // auseinanderhalten, die verschieden ausgehen muessen: eine Erinnerung, die
    // jemand sich SELBST auf 10 Minuten gestellt hat, darf beim naechsten
    // Speichern des Erstellers nicht auf dessen Wert zurueckspringen - eine
    // geerbte darf es. Der Fremdschluessel steht auf SET NULL: verlaesst die
    // Person den Haushalt, bleibt die Erinnerung ihres Kollegen bestehen und
    // gilt ab dann als seine eigene.
    up: `
      ALTER TABLE reminders ADD COLUMN assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_reminders_assigned_from ON reminders(assigned_from);
    `,
  };
