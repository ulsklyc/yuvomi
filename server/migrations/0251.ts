export default {
    version: 251,
    description: 'users: avatar_key, a random key per profile picture for its address',
    // Listen tragen statt der Data-URL die Adresse `/api/v1/people/:id/avatar?v=`
    // (services/person-avatar.js), und `v` ist dieser Schluessel. ZWEI AUFGABEN:
    //   - Er wechselt mit JEDEM neuen Bild - der Offline-Cache des Service
    //     Workers ist nach der Adresse geschluesselt, eine gleiche Adresse zeigte
    //     offline das alte Bild (die Laenge der Data-URL reichte nicht).
    //   - Er ist nicht zu raten - die Route gibt das Bild nur mit ihm heraus.
    //     Mit einer Zaehlversion holte jede Sitzung und jedes Wanddisplay per
    //     Durchzaehlen der ids auch Bilder von Personen, die es in keiner Zeile
    //     sieht (Hauspersonal, Ausgaben-Gaeste, deaktivierte Konten).
    // Beides Codex-Review zu #2056.
    //
    // TRIGGER STATT DER SCHREIBSTELLEN: das Bild wird an fuenf Stellen
    // geschrieben, und eine neue sechste vergaesse den Schluessel still.
    // `reconcileCriticalSchema()` legt Spalte, Schluessel und Trigger nach,
    // wenn eine Datei sie verloren hat.
    up: `
      ALTER TABLE users ADD COLUMN avatar_key TEXT;
      UPDATE users SET avatar_key = lower(hex(randomblob(16)))
        WHERE avatar_data IS NOT NULL AND avatar_data <> '';
      CREATE TRIGGER IF NOT EXISTS trg_users_avatar_key_update
        AFTER UPDATE OF avatar_data ON users FOR EACH ROW
        WHEN NEW.avatar_data IS NOT OLD.avatar_data
        BEGIN
          UPDATE users SET avatar_key = CASE
            WHEN NEW.avatar_data IS NULL OR NEW.avatar_data = '' THEN NULL
            ELSE lower(hex(randomblob(16))) END
          WHERE id = OLD.id;
        END;
      CREATE TRIGGER IF NOT EXISTS trg_users_avatar_key_insert
        AFTER INSERT ON users FOR EACH ROW
        WHEN NEW.avatar_data IS NOT NULL AND NEW.avatar_data <> ''
        BEGIN UPDATE users SET avatar_key = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
    `,
  };
