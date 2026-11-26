export default {
    version: 228,
    description: 'Budget: a series keeps its own definition, the first booking is an ordinary entry (#1035)',
    // DIE ERSTE ZEILE EINER SERIE WAR ZWEIERLEI (#1035): die Vorlage, aus der
    // generateRecurringInstances() jedes kuenftige Vorkommen baut, UND die
    // erste, von Hand erfasste Buchung. "Alle kuenftigen aendern" schrieb
    // deshalb Titel, Betrag, Kategorie, Unterkategorie, Konto und Zustaendige
    // auf eine Buchung, die Jahre zurueckliegen konnte - gemessen: die Miete
    // vom Januar 2020 zog beim Kontowechsel auf das neue Konto um, beide Salden
    // waren danach falsch. Umgekehrt schrieb eine Korrektur NUR der ersten
    // Buchung in jedes kuenftige Vorkommen weiter.
    //
    // Entschieden in #1035 (Option 1): die Serie bekommt eine Definition fuer
    // sich, das Original wird eine gewoehnliche Buchung, die Anker ihrer Serie
    // ist. Hier liegen die WERTE der Vorlage - genau die Felder, die zugleich
    // Tatsachen ueber eine Buchung sind. Der Rhythmus (recurrence_interval,
    // _interval_count, _virtual, _confirm, recurrence_rule) und der Starttag
    // (date) bleiben am Anker: sie haben nur eine Bedeutung, und das Frontend
    // liest sie dort.
    //
    // WAS `recurrence_parent_id IS NULL` DANACH HEISST: nur noch "diese Zeile
    // wurde nicht von einer Serie erzeugt" - eine von Hand erfasste Buchung.
    // Ob sie eine Serie traegt, sagt allein diese Tabelle (eine Zeile je
    // laufender Serie, Schluessel = id des Ankers); ihre Werte sind die der
    // Buchung, nie die der Vorlage. Der einzige Leser, der die Spalte als "das
    // ist die Serie" las, war generateRecurringInstances(); er liest jetzt hier.
    //
    // Schluessel ist die id des Ankers, keine eigene: an ihr haengen schon die
    // Instanzen (recurrence_parent_id), die Ausnahmen
    // (budget_recurrence_skipped.parent_id) und jede API-Adresse einer Serie
    // (/budget/:id/series). Eine zweite id haette all das umziehen muessen,
    // ohne dass eine Frage anders beantwortet waere. Der Preis: die Definition
    // lebt nicht laenger als ihr Anker (ON DELETE CASCADE) - wie bisher.
    //
    // Sichtbarkeit steht mit darin, obwohl eine Serien-Aenderung sie bewusst
    // RUECKWIRKEND auf alle Buchungen der Serie legt: sonst machte eine Einzel-
    // Aenderung der ersten Buchung ("nur dieser Eintrag") jedes kuenftige
    // Vorkommen mit oeffentlich oder privat.
    //
    // DIE TRIGGER halten die Definition fuer JEDEN Schreiber vollstaendig, auch
    // fuer die, die am Router vorbei einfuegen (Demo-Seed, Tests): wird eine
    // Buchung zur Serie, entsteht ihre Definition aus ihren Werten; wird die
    // Serie beendet, faellt sie weg. Ohne Trigger haette eine Serie ohne
    // Definition still keine Vorkommen mehr erzeugt. Nur UPDATE OF
    // is_recurring - der updated_at-Trigger schreibt eine andere Spalte und
    // loest sie nicht aus. EIN KUENFTIGER REBUILD von budget_entries (wie v156)
    // verliert Trigger mit der Tabelle und muss diese drei neu anlegen.
    //
    // Zeitstempel wie jede Entitaetstabelle (CONTRIBUTING.md); updated_at
    // fuehrt PUT /budget/:id/series nach, der einzige Schreiber danach.
    //
    // Die Zustaendigen des Ankers wandern als Vorlage mit; ihre Zeilen am Anker
    // bleiben, sie beschreiben die erste Buchung. Idempotent: IF NOT EXISTS,
    // und gefuellt wird nur fuer Anker ohne Definition - ein zweiter Lauf
    // ueberschreibt keine Definition, die inzwischen von der Buchung abweicht.
    up: `
      CREATE TABLE IF NOT EXISTS budget_series (
        anchor_id   INTEGER PRIMARY KEY REFERENCES budget_entries(id) ON DELETE CASCADE,
        title       TEXT    NOT NULL,
        amount      REAL    NOT NULL,
        full_amount REAL,
        category    TEXT    NOT NULL,
        subcategory TEXT    NOT NULL DEFAULT '',
        account_id  INTEGER REFERENCES budget_accounts(id) ON DELETE SET NULL,
        visibility  TEXT    NOT NULL DEFAULT 'shared'
                            CHECK (visibility IN ('private', 'shared', 'shared_amount')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_budget_series_account ON budget_series(account_id);

      CREATE TABLE IF NOT EXISTS budget_series_responsibles (
        anchor_id INTEGER NOT NULL REFERENCES budget_series(anchor_id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (anchor_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_budget_series_responsibles_user
        ON budget_series_responsibles(user_id);

      -- Nur Anker, die noch KEINE Definition haben: ein zweiter Lauf fasst
      -- weder eine inzwischen abweichende Definition noch ihre (vielleicht
      -- bewusst geleerte) Zustaendigkeit an.
      DROP TABLE IF EXISTS temp._v228_anchors;
      CREATE TEMP TABLE _v228_anchors AS
        SELECT id FROM budget_entries
         WHERE is_recurring = 1 AND recurrence_parent_id IS NULL
           AND id NOT IN (SELECT anchor_id FROM budget_series);

      INSERT INTO budget_series
        (anchor_id, title, amount, full_amount, category, subcategory, account_id, visibility)
      SELECT e.id, e.title, e.amount, e.recurrence_full_amount, e.category, e.subcategory,
             e.account_id, e.visibility
        FROM budget_entries e JOIN _v228_anchors n ON n.id = e.id;

      INSERT OR IGNORE INTO budget_series_responsibles (anchor_id, user_id)
      SELECT r.entry_id, r.user_id
        FROM budget_entry_responsibles r JOIN _v228_anchors n ON n.id = r.entry_id;

      DROP TABLE _v228_anchors;

      CREATE TRIGGER IF NOT EXISTS trg_budget_series_on_insert
        AFTER INSERT ON budget_entries
        WHEN NEW.is_recurring = 1 AND NEW.recurrence_parent_id IS NULL
      BEGIN
        INSERT OR IGNORE INTO budget_series
          (anchor_id, title, amount, full_amount, category, subcategory, account_id, visibility)
        VALUES (NEW.id, NEW.title, NEW.amount, NEW.recurrence_full_amount, NEW.category,
                NEW.subcategory, NEW.account_id, NEW.visibility);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_budget_series_on_start
        AFTER UPDATE OF is_recurring ON budget_entries
        WHEN OLD.is_recurring = 0 AND NEW.is_recurring = 1 AND NEW.recurrence_parent_id IS NULL
      BEGIN
        INSERT OR IGNORE INTO budget_series
          (anchor_id, title, amount, full_amount, category, subcategory, account_id, visibility)
        VALUES (NEW.id, NEW.title, NEW.amount, NEW.recurrence_full_amount, NEW.category,
                NEW.subcategory, NEW.account_id, NEW.visibility);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_budget_series_on_stop
        AFTER UPDATE OF is_recurring ON budget_entries
        WHEN OLD.is_recurring = 1 AND NEW.is_recurring = 0
      BEGIN
        DELETE FROM budget_series WHERE anchor_id = NEW.id;
      END;
    `,
  };
