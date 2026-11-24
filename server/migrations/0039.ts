// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 39,
    description: 'Split expense groups, immutable ledger, settlements, recurring expenses, and activity',
    up: `
      CREATE TABLE IF NOT EXISTS expense_groups (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        name                TEXT    NOT NULL,
        description         TEXT,
        type                TEXT    NOT NULL DEFAULT 'general'
                                    CHECK(type IN ('household', 'couple', 'travel', 'event', 'shopping', 'general')),
        avatar_color        TEXT    NOT NULL DEFAULT '#0F766E',
        avatar_document_id  INTEGER REFERENCES family_documents(id) ON DELETE SET NULL,
        default_currency    TEXT    NOT NULL DEFAULT 'EUR',
        status              TEXT    NOT NULL DEFAULT 'active'
                                    CHECK(status IN ('active', 'archived')),
        created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        archived_at         TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS expense_group_members (
        group_id    INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role        TEXT    NOT NULL DEFAULT 'guest'
                            CHECK(role IN ('owner', 'admin', 'guest')),
        invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        joined_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id                INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        title                   TEXT    NOT NULL,
        description             TEXT,
        amount_minor            INTEGER NOT NULL CHECK(amount_minor > 0),
        currency                TEXT    NOT NULL,
        converted_amount_minor  INTEGER NOT NULL CHECK(converted_amount_minor > 0),
        converted_currency      TEXT    NOT NULL,
        exchange_rate_num       INTEGER NOT NULL DEFAULT 1 CHECK(exchange_rate_num > 0),
        exchange_rate_den       INTEGER NOT NULL DEFAULT 1 CHECK(exchange_rate_den > 0),
        exchange_snapshot       TEXT,
        payer_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        category                TEXT    NOT NULL DEFAULT 'general',
        split_method            TEXT    NOT NULL DEFAULT 'equal'
                                      CHECK(split_method IN ('equal', 'exact', 'percentage', 'shares')),
        status                  TEXT    NOT NULL DEFAULT 'active'
                                      CHECK(status IN ('active', 'deleted')),
        expense_date            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
        recurring_rule_id       INTEGER,
        created_by              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deleted_at              TEXT,
        created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS expense_splits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id    INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount_minor  INTEGER NOT NULL CHECK(amount_minor >= 0),
        currency      TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(expense_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS expense_comments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        comment     TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS expense_attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        document_id  INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
        kind         TEXT    NOT NULL DEFAULT 'receipt' CHECK(kind IN ('receipt', 'proof', 'other')),
        created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(expense_id, document_id)
      );

      CREATE TABLE IF NOT EXISTS expense_ledger_entries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        source_type   TEXT    NOT NULL CHECK(source_type IN ('expense', 'expense_reversal', 'settlement', 'settlement_reversal')),
        source_id     INTEGER NOT NULL,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        counterparty_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        amount_minor  INTEGER NOT NULL,
        currency      TEXT    NOT NULL,
        memo          TEXT,
        created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS settlements (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        payer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        payee_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount_minor  INTEGER NOT NULL CHECK(amount_minor > 0),
        currency      TEXT    NOT NULL,
        notes         TEXT,
        proof_document_id INTEGER REFERENCES family_documents(id) ON DELETE SET NULL,
        status        TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
        paid_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deleted_at    TEXT,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS settlement_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id  INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
        from_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        to_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount_minor   INTEGER NOT NULL CHECK(amount_minor > 0),
        currency       TEXT    NOT NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id        INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        title           TEXT    NOT NULL,
        description     TEXT,
        amount_minor    INTEGER NOT NULL CHECK(amount_minor > 0),
        currency        TEXT    NOT NULL,
        payer_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        category        TEXT    NOT NULL DEFAULT 'general',
        split_method    TEXT    NOT NULL DEFAULT 'equal',
        split_snapshot  TEXT    NOT NULL,
        frequency       TEXT    NOT NULL CHECK(frequency IN ('weekly', 'monthly', 'yearly')),
        next_run_date   TEXT    NOT NULL,
        paused_at       TEXT,
        created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS expense_activity (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    INTEGER NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
        actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        type        TEXT    NOT NULL,
        entity_type TEXT    NOT NULL,
        entity_id   INTEGER,
        metadata    TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_expense_groups_updated_at
        AFTER UPDATE ON expense_groups FOR EACH ROW
        BEGIN UPDATE expense_groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_expenses_updated_at
        AFTER UPDATE ON expenses FOR EACH ROW
        BEGIN UPDATE expenses SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_settlements_updated_at
        AFTER UPDATE ON settlements FOR EACH ROW
        BEGIN UPDATE settlements SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_recurring_expenses_updated_at
        AFTER UPDATE ON recurring_expenses FOR EACH ROW
        BEGIN UPDATE recurring_expenses SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_expense_groups_status ON expense_groups(status);
      CREATE INDEX IF NOT EXISTS idx_expense_group_members_user ON expense_group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses(group_id, expense_date DESC);
      CREATE INDEX IF NOT EXISTS idx_expenses_payer ON expenses(payer_id);
      CREATE INDEX IF NOT EXISTS idx_expense_splits_user ON expense_splits(user_id);
      CREATE INDEX IF NOT EXISTS idx_expense_ledger_group_currency_user ON expense_ledger_entries(group_id, currency, user_id);
      CREATE INDEX IF NOT EXISTS idx_expense_ledger_source ON expense_ledger_entries(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_settlements_group_paid ON settlements(group_id, paid_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recurring_expenses_next_run ON recurring_expenses(next_run_date, paused_at);
      CREATE INDEX IF NOT EXISTS idx_expense_activity_group_created ON expense_activity(group_id, created_at DESC);
    `,
  };
