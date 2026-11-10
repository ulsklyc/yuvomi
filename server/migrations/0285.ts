export default {
    version: 285,
    description: 'Family: user availability status with expiry (#1591)',
    // Ein Mitglied kann den anderen zeigen, ob es gerade erreichbar ist:
    // available, busy, do_not_disturb oder away. Der Status traegt immer ein
    // Verfallsdatum (expires_at, UTC) - er erlischt automatisch, kein manuelles
    // Zuruecksetzen noetig. UPSERT auf user_id: ein Eintrag pro Person.
    up: `
      CREATE TABLE IF NOT EXISTS user_availability (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state      TEXT    NOT NULL CHECK (state IN ('available', 'busy', 'do_not_disturb', 'away')),
        note       TEXT,
        expires_at TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (user_id)
      );
    `,
  };
