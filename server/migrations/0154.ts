// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 154,
    description: 'Outlook (Microsoft Graph) one-way push: accounts, calendar selection, event links, event target columns',
    up: `
      -- Outlook.com spricht kein CalDAV mehr - der einzige Schreibweg ist die
      -- Microsoft Graph API. Neuer Provider "Outlook-Push": one-way
      -- Yuvomi -> Outlook fuer persoenliche Microsoft-Konten (outlook.com /
      -- M365 Family), Multi-Account wie caldav_accounts.

      -- Ein verbundenes Microsoft-Konto. OAuth-Tokens liegen pro Konto-Zeile,
      -- NICHT in sync_config (Multi-Account). auto_sync_calendar_id +
      -- owner_user_id aktivieren den Auto-Sync: alle fuer den Owner sichtbaren
      -- lokalen Termine werden automatisch in diesen einen Kalender gepusht.
      CREATE TABLE outlook_accounts (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        name                  TEXT NOT NULL,
        ms_user_id            TEXT,
        email                 TEXT,
        access_token          TEXT NOT NULL,
        refresh_token         TEXT NOT NULL,
        token_expiry          TEXT,
        needs_reauth          INTEGER NOT NULL DEFAULT 0,
        auto_sync_calendar_id TEXT,
        owner_user_id         INTEGER REFERENCES users(id),
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_sync             TEXT,
        last_error            TEXT
      );
      -- Reconnect desselben Microsoft-Kontos ersetzt die Tokens statt zu duplizieren.
      CREATE UNIQUE INDEX idx_outlook_accounts_ms_user
        ON outlook_accounts(ms_user_id) WHERE ms_user_id IS NOT NULL;

      -- Beim Verbinden von Graph geladene Kalender; enabled = als Push-Ziel
      -- waehlbar. Neue Kalender starten deaktiviert: der Connect-Flow fuehrt
      -- erst zur Anlage eines dedizierten Zielkalenders.
      CREATE TABLE outlook_calendar_selection (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id     INTEGER NOT NULL REFERENCES outlook_accounts(id) ON DELETE CASCADE,
        calendar_id    TEXT NOT NULL,
        calendar_name  TEXT NOT NULL,
        calendar_color TEXT,
        can_edit       INTEGER NOT NULL DEFAULT 1,
        enabled        INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(account_id, calendar_id)
      );

      -- Push-Zustand je (Event, Konto): ein Termin kann in mehrere Konten
      -- gepusht werden (je Familienmitglied ein eigener Zielkalender).
      -- BEWUSST KEIN FK auf calendar_events: die Zeile muss das Loeschen des
      -- lokalen Events ueberleben, damit der naechste Sync das Remote-Event in
      -- Outlook loescht (Tombstone). Anders als Google/CalDAV gibt es keinen
      -- Handoff zu external_source='outlook' - ohne Inbound-Sync wuerde das
      -- Event danach einfrieren; es bleibt dauerhaft 'local'.
      CREATE TABLE outlook_event_links (
        event_id            INTEGER NOT NULL,
        account_id          INTEGER NOT NULL REFERENCES outlook_accounts(id) ON DELETE CASCADE,
        outlook_calendar_id TEXT NOT NULL,
        outlook_event_id    TEXT NOT NULL,
        content_hash        TEXT,
        -- Graph-ETag des Events nach dem letzten eigenen Schreibzugriff. Der Sync
        -- listet je Kalender einmal id+changeKey: weicht der Key ab, wurde der
        -- Termin in Outlook veraendert und wird auf den Yuvomi-Stand zurueckgesetzt;
        -- fehlt die id, wurde er in Outlook geloescht und wird neu angelegt.
        outlook_change_key  TEXT,
        last_pushed_at      TEXT,
        last_error          TEXT,
        PRIMARY KEY (event_id, account_id)
      );
      CREATE INDEX idx_outlook_links_account ON outlook_event_links(account_id);

      -- Explizites Push-Ziel am Event (Muster target_caldav_* /
      -- target_google_calendar_id); gewinnt gegen den Auto-Sync-Kalender.
      -- Keine external_source-CHECK-Erweiterung noetig (kein Handoff, s. o.).
      ALTER TABLE calendar_events ADD COLUMN target_outlook_account_id INTEGER;
      ALTER TABLE calendar_events ADD COLUMN target_outlook_calendar_id TEXT;
    `,
  };
