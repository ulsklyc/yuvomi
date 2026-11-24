export default {
    version: 124,
    description: 'Split guests stay confined when their group is deleted (group_id ON DELETE SET NULL)',
    up: `
      -- Rechteausweitung: split_expense_guest_users traegt zwei Aussagen in
      -- einer Zeile - DASS ein Konto beschraenkt ist (die Existenz der Zeile,
      -- die server/index.js abfragt) und WORAUF (group_id). Das CASCADE aus
      -- v40 hat beim Loeschen der Gruppe die ganze Zeile mitgenommen und damit
      -- auch die erste Aussage geloescht. Der zugehoerige users-Eintrag blieb
      -- unveraendert bestehen: aus einem Gast wurde ein haushaltsweit
      -- berechtigtes Konto, das die uebrige API erreicht. Eine Gruppe ohne
      -- Ausgaben und Ausgleiche laesst sich loeschen (409-Guard in
      -- routes/split-expenses.js), der Weg dorthin stand also jedem
      -- Gruppen-Owner offen.
      --
      -- SET NULL loescht nur noch die Zuordnung. Der Gast bleibt ein Gast und
      -- sieht nichts mehr - die Routen behandeln group_id IS NULL als "keine
      -- Gruppe", nicht als "keine Beschraenkung".
      --
      -- SQLite kann eine FK-Aktion nicht per ALTER aendern, daher der Rebuild.
      -- Keine Tabelle referenziert split_expense_guest_users, das DROP zieht
      -- also nichts mit sich; foreignKeysOff ist dafuer nicht noetig.
      CREATE TABLE split_expense_guest_users_new (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        group_id   INTEGER REFERENCES expense_groups(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO split_expense_guest_users_new (user_id, group_id, created_by, created_at)
        SELECT user_id, group_id, created_by, created_at FROM split_expense_guest_users;

      DROP TABLE split_expense_guest_users;
      ALTER TABLE split_expense_guest_users_new RENAME TO split_expense_guest_users;

      -- Der Index hing an der gedroppten Tabelle und muss neu angelegt werden.
      CREATE INDEX IF NOT EXISTS idx_split_guest_group ON split_expense_guest_users(group_id);
    `,
  };
