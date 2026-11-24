// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 275,
    description: 'device_pairing_codes: pairing a signed-in device',
    // Der Code, mit dem eine Browser-Sitzung ein Telefon anmeldet. Eine eigene
    // Tabelle: `display_pairing_codes` fragt beim Einloesen nicht nach dem Zweck,
    // ein Personen-Code dort oeffnete `POST /displays/pair`. Gehasht und mit
    // `used_at` statt Loeschen, aus denselben Gruenden wie dort.
    up: `
      CREATE TABLE IF NOT EXISTS device_pairing_codes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT    NOT NULL UNIQUE,
        expires_at TEXT    NOT NULL,
        used_at    TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_device_pairing_codes_user
        ON device_pairing_codes(user_id);
    `,
  };
