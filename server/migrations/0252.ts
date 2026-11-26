export default {
    version: 252,
    description: 'task_completions: source, so a completion taken over by the CalDAV sync is told apart (#1836)',
    // Der eingehende CalDAV-Sync schreibt seit #1836 einen Erledigungseintrag,
    // wenn eine gespiegelte Aufgabe auf dem Telefon abgehakt wurde. Er hat keine
    // handelnde Person, `user_id` bleibt NULL - und NULL hiess bisher "die
    // Person hat den Haushalt verlassen" (SET NULL). Die Spalte trennt beides:
    // NULL = in Yuvomi abgehakt, 'caldav' = vom Sync uebernommen.
    //
    // KEIN Backfill: welche Bestandszeilen aus einem Sync stammen, laesst sich
    // nicht sagen, und der Sync hat bis hierher gar keine geschrieben.
    up: `
      ALTER TABLE task_completions ADD COLUMN source TEXT;
    `,
  };
