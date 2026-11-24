// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 70,
    description: 'Reward-System: Teilnehmer, Prämien-Katalog, Einlösungen, Punkte-Ledger',
    up: `
      -- Wer nimmt am Punkte-System teil (opt-in je Mitglied). Zeile vorhanden =
      -- verwaltet; enabled steuert aktive Teilnahme, ohne die Historie zu verlieren.
      CREATE TABLE reward_participants (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Prämien-Katalog (haushaltsweit, von Eltern/Admin gepflegt).
      CREATE TABLE reward_catalog (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        cost        INTEGER NOT NULL,
        icon        TEXT,
        description TEXT,
        is_active   INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Einlöse-Anfragen. Beim Anlegen werden die Punkte per Ledger-Buchung
      -- reserviert; bei Ablehnung/Storno bucht eine Gegenbuchung zurück.
      -- Name/Icon/Kosten werden als Snapshot gehalten, damit spätere
      -- Katalogänderungen die Historie nicht verfälschen.
      CREATE TABLE reward_redemptions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        catalog_id   INTEGER REFERENCES reward_catalog(id) ON DELETE SET NULL,
        reward_name  TEXT    NOT NULL,
        reward_icon  TEXT,
        cost         INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending', 'fulfilled', 'rejected', 'cancelled')),
        note         TEXT,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_at   TEXT,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Einzige Quelle der Wahrheit: der Punktestand eines Mitglieds ist die
      -- Summe aller delta-Werte. Positive delta = verdient/Bonus, negative =
      -- eingelöst/Korrektur. Jede Zeile ist unveränderlich und nachvollziehbar.
      CREATE TABLE reward_ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta         INTEGER NOT NULL,
        type          TEXT    NOT NULL
                              CHECK(type IN ('earn', 'bonus', 'redeem', 'adjust', 'reversal')),
        reason        TEXT,
        task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        redemption_id INTEGER REFERENCES reward_redemptions(id) ON DELETE SET NULL,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Doppelvergabe pro Aufgabe/Mitglied verhindern (Idempotenz-Netz für die
      -- Vergabe bei Statuswechsel nach 'done').
      CREATE UNIQUE INDEX uniq_reward_earn ON reward_ledger(task_id, user_id) WHERE type = 'earn';
      CREATE INDEX idx_reward_ledger_user ON reward_ledger(user_id);
      CREATE INDEX idx_reward_ledger_redemption ON reward_ledger(redemption_id);
      CREATE INDEX idx_reward_redemptions_status ON reward_redemptions(status);
    `,
  };
