// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 215,
    description: 'Display accounts: a non-member users row that only a paired device can use (#1208)',
    // EIN DISPLAY IST EINE users-ZEILE, KEIN ZWEITER KONTOTYP. Genau so steht es
    // in docs/DECISIONS.md 4: welche Art Mensch eine Zeile ist, ist eine
    // Eigenschaft der Zeile, und Yuvomi hat das schon zweimal so beantwortet -
    // Hauspersonal per `housekeeping_workers`, Ausgaben-Gaeste per
    // `split_expense_guest_users`. `display_accounts` ist die dritte
    // Markierungstabelle desselben Musters, nicht ein neuer Mechanismus daneben.
    //
    // DREI TABELLEN, WEIL ES DREI DINGE SIND: welches Konto ein Display IST,
    // welcher Kopplungscode gerade offen ist, und welches Geraet tatsaechlich
    // gekoppelt wurde. Sie in eine Zeile zu falten hiesse, zwei verschiedene
    // Geheimnisse (Code und Credential) in denselben Spalten zu fuehren und die
    // Regel "ein Code gilt genau einmal" an einem NULL-Vergleich aufzuhaengen.
    up: `
      -- Welche users-Zeile ist ein Display. Nur der Verweis; alles andere
      -- (Name, Farbe) steht wie bei jedem anderen Konto in users.
      CREATE TABLE IF NOT EXISTS display_accounts (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Der Kopplungscode. GEHASHT wie ein API-Token, weil er fuer seine
      -- Lebensdauer einem Credential gleichkommt: wer ihn liest, koppelt sein
      -- eigenes Geraet. used_at statt Loeschen, damit "einmal gueltig" eine
      -- gepruefte Tatsache bleibt und nicht die Abwesenheit einer Zeile.
      CREATE TABLE IF NOT EXISTS display_pairing_codes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT    NOT NULL UNIQUE,
        expires_at TEXT    NOT NULL,
        used_at    TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_display_pairing_codes_user
        ON display_pairing_codes(user_id);

      -- Das Geraete-Credential. KEIN expires_at: an einer Wand meldet sich
      -- niemand an, und ein Ablauf, den erst das dunkle Tablett am
      -- Sonntagmorgen verraet, ist keine Sicherheit, sondern eine Stoerung
      -- (Entscheidung 16.09.). Die Kontrolle ist der Widerruf, und damit er
      -- eine informierte Entscheidung sein kann, steht last_seen_at daneben.
      -- Widerruf setzt revoked_at, es loescht nichts - dieselbe Regel wie bei
      -- api_tokens, damit ein Widerruf nachweisbar bleibt.
      CREATE TABLE IF NOT EXISTS display_devices (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT    NOT NULL UNIQUE,
        label        TEXT,
        last_seen_at TEXT,
        revoked_at   TEXT,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_display_devices_user
        ON display_devices(user_id);
    `,
  };
