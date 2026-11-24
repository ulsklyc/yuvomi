export default {
    version: 159,
    description: 'Two-factor authentication: TOTP secrets and recovery codes per user (#672)',
    up: `
      -- Ein Nutzer hat hoechstens ein Geheimnis, deshalb ist user_id der
      -- Schluessel und keine eigene id noetig.
      --
      -- confirmed_at NULL bedeutet: die Einrichtung laeuft, das Geheimnis ist
      -- erzeugt und angezeigt, aber noch nicht durch einen Code bestaetigt.
      -- Dieser Zwischenstand gehoert bewusst in die Datenbank und nicht in die
      -- Session: wer den QR scannt und dann die Seite neu laedt, soll nicht von
      -- vorn anfangen - und ein unbestaetigtes Geheimnis schuetzt nichts, kann
      -- also gefahrlos liegen bleiben, bis es ersetzt wird.
      --
      -- last_step haelt den zuletzt eingeloesten Zeitschritt fest. RFC 6238
      -- Abschnitt 5.2 verlangt diese Sperre: ohne sie bleibt ein abgefangener
      -- Code das volle Toleranzfenster lang ein zweites Mal gueltig.
      CREATE TABLE IF NOT EXISTS user_totp (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret       TEXT    NOT NULL,
        confirmed_at TEXT,
        last_step    INTEGER,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Wiederherstellungscodes stehen nur als Hash hier. Ein eingeloester Code
      -- wird nicht geloescht, sondern mit used_at gestempelt: so kann die
      -- Oberflaeche "noch 7 von 10 uebrig" sagen, ohne mitzuzaehlen.
      CREATE TABLE IF NOT EXISTS user_recovery_codes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT    NOT NULL,
        used_at    TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON user_recovery_codes(user_id);
    `,
  };
