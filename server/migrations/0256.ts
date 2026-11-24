// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 256,
    description: 'push_subscriptions: wall_paused_at timestamp pauses delivery while the wall is shown (#1904)',
    // EIN GERAET IM WANDMODUS SOLL KEINE PERSOENLICHEN SYSTEM-BENACHRICHTIGUNGEN
    // BEKOMMEN (#1904). Der Server ueberspringt Abos, bei denen `wall_paused_at`
    // in den letzten 12 Stunden gesetzt wurde; die Seite setzt diesen Zeitstempel
    // per PUT /push/wall-mode, wenn der Wandmodus beginnt, und loescht ihn, wenn
    // er endet. Laeuft ohne Erneuerung ab - nach 12 Stunden heilt sich ein Geraet
    // ohne aktiven Wandmodus von selbst (#1904). Bestandszeilen bleiben NULL.
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(push_subscriptions)').all().map((c) => c.name));
      if (!columns.has('wall_paused_at')) {
        database.exec('ALTER TABLE push_subscriptions ADD COLUMN wall_paused_at TEXT');
      }
    },
  };
