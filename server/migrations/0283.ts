// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 283,
    description: 'tasks: restore the updated_at trigger lost to the table rebuilds',
    // `trg_tasks_updated_at` entstand in Migration 1 und ging dabei verloren,
    // wie v4/v25/v114 die `tasks`-Tabelle neu aufbauen: `DROP TABLE` nimmt
    // die an der Tabelle hängenden Trigger mit, und kein Rebuild legte ihn
    // wieder an. v114 dokumentierte den Trigger-Verlust sogar und baute die
    // drei Suchindex-Trigger nach, aber das `updated_at`-Trigger übersah.
    // Ergebnis: In jeder Datenbank ab v4 steht `tasks.updated_at` auf dem
    // Erstellungszeitpunkt und rückt bei keiner UPDATE-Bewegung mehr, während
    // `calendar_events` den Trigger in jedem Rebuild nachlegt und deshalb
    // korrekt lief. Nur nach vorn: Zeilen behalten ihren vorhandenen Wert.
    // `IF NOT EXISTS` heilt auch gedriftete Datenbanken, auf denen man den
    // Trigger manuell wiederhergestellt hatte.
    up: `
      CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
        AFTER UPDATE ON tasks FOR EACH ROW
        BEGIN UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
