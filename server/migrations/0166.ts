// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 166,
    description: 'Calendar: an event may have no colour of its own, so the assignee can lend theirs (#891)',
    // WARUM DIE SPALTE NULLABLE WIRD. `resolveEventColor` faellt seit jeher auf
    // die Farbe der zugewiesenen Person zurueck - nur konnte der Zweig nie
    // erreicht werden: `color` war NOT NULL DEFAULT '#007AFF' und lehnte auch
    // den Leerstring ab, jeder Termin trug also immer eine eigene Farbe. Seit
    // #815 die Eigenfarbe VOR die abgeleitete stellt, hat das die Personenfarbe
    // und `cal_color` zu totem Code gemacht (#856). NULL ist der Zustand, der
    // gefehlt hat: "dieser Termin hat keine eigene Farbe".
    //
    // SQLite kennt kein DROP NOT NULL, deshalb das Rebuild-Muster wie v98/v137.
    // foreignKeysOff ist Pflicht: vier Tabellen zeigen auf calendar_events, zwei
    // davon (event_assignments, calendar_event_exceptions) mit ON DELETE CASCADE
    // - ein DROP TABLE bei aktiver Durchsetzung wuerde ihre Zeilen mitnehmen.
    //
    // BESTANDSDATEN BLEIBEN UNVERAENDERT. Verlockend waere, '#007AFF' als "nie
    // gewaehlt" zu lesen - der Wert steht heute in keiner Palette. Er stand aber
    // bis zum OKLCH-Wechsel an erster Stelle von EVENT_COLORS, ein Termin aus der
    // v1-Zeit kann ihn also bewusst tragen. Eine Migration, die eine bewusste
    // Wahl wegwirft, ist teurer als eine, die nichts tut: synchronisierte Termine
    // normalisieren sich beim naechsten Sync von selbst (der Import schreibt die
    // geerbte Farbe nicht mehr in die Eigenfarb-Spalte), und lokale Termine
    // bekommen im Dialog die ausdrueckliche Wahl "Farbe der zugewiesenen Person".
    foreignKeysOff: true,
    // WARUM HIER EINE FUNKTION STEHT UND NICHT NUR SQL. Der Rebuild liest unten
    // eine feste Liste von 36 Spalten. Genau eine davon ist nicht garantiert:
    // `tzid` steht in CRITICAL_COLUMNS, weil es DBs gibt, auf denen Migration 97
    // als angewendet gilt, die Spalte aber fehlt (#549 - derselbe Fall wie
    // reminders.pushed_at in #538). `reconcileCriticalSchema()` repariert das,
    // laeuft aber NACH `migrate()` - auf so einer DB waere dieser Rebuild also
    // schon an `no such column: tzid` gescheitert, und zwar beim Update einer
    // Bestandsinstallation. Die Absicherung gehoert deshalb VOR das SQL.
    up(db) {
      const spalten = new Set(db.prepare('PRAGMA table_info(calendar_events)').all().map((c) => c.name));
      if (!spalten.has('tzid')) db.exec('ALTER TABLE calendar_events ADD COLUMN tzid TEXT');

      db.exec(`
      CREATE TABLE calendar_events_new (
        id                           INTEGER PRIMARY KEY AUTOINCREMENT,
        title                        TEXT    NOT NULL,
        description                  TEXT,
        start_datetime               TEXT    NOT NULL,
        end_datetime                 TEXT,
        all_day                      INTEGER NOT NULL DEFAULT 0,
        location                     TEXT,
        color                        TEXT,
        assigned_to                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        external_calendar_id         TEXT,
        external_source              TEXT    NOT NULL DEFAULT 'local'
                                             CHECK(external_source IN ('local', 'google', 'apple', 'ics', 'caldav')),
        recurrence_rule              TEXT,
        subscription_id              INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
        user_modified                INTEGER NOT NULL DEFAULT 0,
        calendar_ref_id              INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL,
        icon                         TEXT    NOT NULL DEFAULT 'calendar',
        attachment_name              TEXT,
        attachment_mime              TEXT,
        attachment_size              INTEGER,
        attachment_data              TEXT,
        target_caldav_account_id     INTEGER,
        target_caldav_calendar_url   TEXT,
        created_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        attachment_document_id       INTEGER REFERENCES family_documents(id) ON DELETE SET NULL,
        target_google_calendar_id    TEXT,
        visibility                   TEXT    NOT NULL DEFAULT 'all',
        tzid                         TEXT,
        outbound_dirty               INTEGER NOT NULL DEFAULT 0,
        outbound_attempts            INTEGER NOT NULL DEFAULT 0,
        outbound_move_to             TEXT,
        external_object_url          TEXT,
        countdown                    INTEGER NOT NULL DEFAULT 0,
        target_outlook_account_id    INTEGER,
        target_outlook_calendar_id   TEXT
      );

      INSERT INTO calendar_events_new
        (id, title, description, start_datetime, end_datetime, all_day, location, color,
         assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
         subscription_id, user_modified, calendar_ref_id, icon,
         attachment_name, attachment_mime, attachment_size, attachment_data,
         target_caldav_account_id, target_caldav_calendar_url, created_at, updated_at,
         attachment_document_id, target_google_calendar_id, visibility, tzid,
         outbound_dirty, outbound_attempts, outbound_move_to, external_object_url,
         countdown, target_outlook_account_id, target_outlook_calendar_id)
      SELECT id, title, description, start_datetime, end_datetime, all_day, location, color,
             assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
             subscription_id, user_modified, calendar_ref_id, icon,
             attachment_name, attachment_mime, attachment_size, attachment_data,
             target_caldav_account_id, target_caldav_calendar_url, created_at, updated_at,
             attachment_document_id, target_google_calendar_id, visibility, tzid,
             outbound_dirty, outbound_attempts, outbound_move_to, external_object_url,
             countdown, target_outlook_account_id, target_outlook_calendar_id
      FROM calendar_events;

      -- Die Trigger haengen an der alten Tabelle und gehen mit ihr; der
      -- Suchindex bleibt dabei unberuehrt, weil DROP TABLE keinen DELETE-Trigger
      -- ausloest und der INSERT oben auf der noch triggerlosen neuen Tabelle lief.
      DROP TRIGGER IF EXISTS trg_calendar_events_updated_at;
      DROP TRIGGER IF EXISTS trg_search_events_ai;
      DROP TRIGGER IF EXISTS trg_search_events_au;
      DROP TRIGGER IF EXISTS trg_search_events_ad;
      DROP TABLE calendar_events;
      ALTER TABLE calendar_events_new RENAME TO calendar_events;

      CREATE TRIGGER trg_calendar_events_updated_at
        AFTER UPDATE ON calendar_events FOR EACH ROW
        BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
                COALESCE(NEW.title, ''),
                TRIM(COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.location, '')));
      END;

      CREATE TRIGGER trg_search_events_au AFTER UPDATE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
                COALESCE(NEW.title, ''),
                TRIM(COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.location, '')));
      END;

      CREATE TRIGGER trg_search_events_ad AFTER DELETE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
      END;

      CREATE INDEX idx_calendar_start ON calendar_events(start_datetime);
      CREATE INDEX idx_calendar_assigned ON calendar_events(assigned_to);
      CREATE INDEX idx_calendar_external_id ON calendar_events(external_calendar_id);
      CREATE INDEX idx_calendar_sub ON calendar_events(subscription_id);
      CREATE INDEX idx_cal_events_ref ON calendar_events(calendar_ref_id);
      CREATE UNIQUE INDEX idx_calendar_sub_extid ON calendar_events (subscription_id, external_calendar_id);
      CREATE INDEX idx_calendar_attachment_document ON calendar_events(attachment_document_id);
      CREATE INDEX idx_calendar_recurring ON calendar_events(start_datetime) WHERE recurrence_rule IS NOT NULL;
      CREATE INDEX idx_calendar_outbound_dirty ON calendar_events(outbound_dirty) WHERE outbound_dirty = 1;
      `);
    },
  };
