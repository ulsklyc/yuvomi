export default {
    version: 156,
    description: 'Budget: third visibility shared_amount - the amount counts towards balances while title, category and notes stay private (#659)',
    foreignKeysOff: true,
    up: `
      -- BETRAG ZAEHLT, ZWECK BLEIBT PRIVAT (#659).
      --
      -- Bisher beantwortet visibility zwei Fragen mit einem Wort: ob ein Eintrag
      -- in die Summen einfliesst UND ob er seine Details zeigt. Fuer geteilte
      -- Konten ist das zu grob. Wer eine private Ausgabe bucht, verschweigt
      -- meistens den ZWECK, nicht den Abfluss - der Kontostand der anderen ist
      -- dadurch aber schlicht falsch, weil ihr Konto real weniger enthaelt.
      --
      -- Die dritte Stufe trennt die beiden Fragen: 'shared_amount' zaehlt wie
      -- 'shared' in Kontostand, Vermoegen und Summen, zeigt aber wie 'private'
      -- keine Details. Fremde sehen die Zeile mit Datum und Betrag, statt Titel,
      -- Kategorie und Notizen aber eine neutrale Maske - der Saldo bleibt so aus
      -- der Liste nachvollziehbar, statt um einen unerklaerten Betrag daneben zu
      -- liegen.
      --
      -- BEWUSST KEINE HAUSHALTS-EINSTELLUNG. Ein Schalter waere billiger, aber
      -- wer ihn umlegt, nimmt die Zusage ALLEN im Haushalt weg, auch denen, die
      -- sie wollten - ein Admin sogar im Alleingang. Eine Zusage, die ein Dritter
      -- abschalten kann, ist keine. Die Wahl bleibt deshalb am einzelnen Eintrag,
      -- bei der Person, um deren Privatsphaere es geht.
      --
      -- SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher Tabelle
      -- neu erstellen (Muster wie v140/v141). foreignKeysOff ist Pflicht: mit
      -- aktiver FK-Durchsetzung wuerde DROP TABLE budget_entries die gekoppelten
      -- Belege (budget_entry_attachments.entry_id), die Wiederholungs-Ausnahmen
      -- (budget_recurrence_skipped.parent_id) und die Inventar-Verknuepfungen
      -- (inventory_item_entries.entry_id) auf jeder bestehenden Installation
      -- mitloeschen - alle drei haengen per ON DELETE CASCADE daran.
      CREATE TABLE budget_entries_new (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        title                     TEXT    NOT NULL,
        amount                    REAL    NOT NULL,
        category                  TEXT    NOT NULL DEFAULT 'Sonstiges',
        date                      TEXT    NOT NULL,
        is_recurring              INTEGER NOT NULL DEFAULT 0,
        recurrence_rule           TEXT,
        created_by                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        recurrence_parent_id      INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
        subcategory               TEXT    NOT NULL DEFAULT '',
        recurrence_interval       TEXT    NOT NULL DEFAULT 'monthly',
        recurrence_virtual        INTEGER NOT NULL DEFAULT 0,
        recurrence_full_amount    REAL,
        account_id                INTEGER REFERENCES budget_accounts(id) ON DELETE SET NULL,
        owner_id                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        visibility                TEXT    NOT NULL DEFAULT 'shared'
                                          CHECK (visibility IN ('private', 'shared', 'shared_amount')),
        recurrence_interval_count INTEGER NOT NULL DEFAULT 1,
        recurrence_confirm        INTEGER NOT NULL DEFAULT 0,
        is_pending                INTEGER NOT NULL DEFAULT 0
      );

      -- Spalten explizit und vollstaendig: v57 hat bei genau diesem Schritt
      -- reminders.pushed_at verloren, v62 musste es nachtragen.
      INSERT INTO budget_entries_new (
        id, title, amount, category, date, is_recurring, recurrence_rule,
        created_by, created_at, updated_at, recurrence_parent_id, subcategory,
        recurrence_interval, recurrence_virtual, recurrence_full_amount,
        account_id, owner_id, visibility, recurrence_interval_count,
        recurrence_confirm, is_pending
      )
      SELECT
        id, title, amount, category, date, is_recurring, recurrence_rule,
        created_by, created_at, updated_at, recurrence_parent_id, subcategory,
        recurrence_interval, recurrence_virtual, recurrence_full_amount,
        account_id, owner_id, visibility, recurrence_interval_count,
        recurrence_confirm, is_pending
      FROM budget_entries;

      DROP TABLE budget_entries;
      ALTER TABLE budget_entries_new RENAME TO budget_entries;

      CREATE INDEX idx_budget_date       ON budget_entries(date);
      CREATE INDEX idx_budget_created_by ON budget_entries(created_by);
      CREATE INDEX idx_budget_parent     ON budget_entries(recurrence_parent_id);
      CREATE INDEX idx_budget_account    ON budget_entries(account_id);
      CREATE INDEX idx_budget_owner      ON budget_entries(owner_id);
      CREATE INDEX idx_budget_pending    ON budget_entries(is_pending) WHERE is_pending = 1;

      CREATE TRIGGER trg_budget_entries_updated_at
        AFTER UPDATE ON budget_entries FOR EACH ROW
        BEGIN UPDATE budget_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
