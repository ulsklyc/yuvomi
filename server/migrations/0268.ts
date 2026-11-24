// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 268,
    description: 'CalDAV: one task or shopping row per UID across accounts, and a deleted account releases its rows (#1906, #1885)',
    // EINE ZEILE JE UID (#1906, Entscheidung 27.10., wie #1879 fuer Termine).
    // Fuehrten zwei Konten dieselbe Erinnerungsliste, legte jedes seine eigene
    // Zeile an: dieselbe Aufgabe stand zweimal da. Die Dubletten werden hier
    // zusammengefuehrt; die AELTERE Zeile (kleinste id) bleibt und behaelt ihr
    // Konto. Von der juengeren gehen Kommentare, Dokumente und Zuweisungen auf
    // die aeltere ueber (Doppeltes wird uebersprungen), ebenso ihre
    // Unteraufgaben, die Folgeaufgaben einer Serie und die Verweise aus der
    // Haushaltshilfe. Ihre Erledigungen fallen: sie sind fast immer der Spiegel
    // derselben Erledigung, und doppelt zaehlten Verlauf und Punkte zweimal.
    // Unteraufgaben haengen VOR dem Loeschen um, sonst naehme CASCADE sie mit;
    // ihre eigene UID-Gruppe fuehrt sie danach zusammen.
    //
    // KONTO WEG, ZEILE BLEIBT (#1885, Entscheidung 27.10.). Wie bei Terminen
    // (v238, ON DELETE SET NULL): eine Zeile eines geloeschten Kontos verliert
    // ihr Konto, bleibt Spiegel, und das naechste Konto, das die UID liefert,
    // uebernimmt sie. Ein Trigger statt eines Fremdschluessels: der haette die
    // drei grossen Tabellen samt Suchindex und Triggern neu gebaut. Er raeumt
    // auch die Upload-Ziele (Aufgaben, Termine), die bisher von Hand fielen.
    up(db) {
      const groups = (table) => db.prepare(`
        SELECT external_uid AS uid, MIN(id) AS keep FROM ${table}
         WHERE external_source = 'caldav' AND external_uid IS NOT NULL
         GROUP BY external_uid HAVING COUNT(*) > 1
      `).all();
      const youngerOf = (table, uid, keep) => db.prepare(`
        SELECT id FROM ${table} WHERE external_source = 'caldav' AND external_uid = ? AND id <> ?
      `).all(uid, keep).map((r) => r.id);

      for (const { uid, keep } of groups('tasks')) {
        for (const drop of youngerOf('tasks', uid, keep)) {
          db.prepare('UPDATE tasks SET parent_task_id = ? WHERE parent_task_id = ?').run(keep, drop);
          db.prepare('UPDATE tasks SET recurrence_origin_id = ? WHERE recurrence_origin_id = ?').run(keep, drop);
          db.prepare('UPDATE task_comments SET task_id = ? WHERE task_id = ?').run(keep, drop);
          db.prepare('UPDATE OR IGNORE task_documents SET task_id = ? WHERE task_id = ?').run(keep, drop);
          db.prepare('UPDATE OR IGNORE task_assignments SET task_id = ? WHERE task_id = ?').run(keep, drop);
          db.prepare('UPDATE housekeeping_work_sessions SET payment_task_id = ? WHERE payment_task_id = ?').run(keep, drop);
          db.prepare("DELETE FROM caldav_upload_attempts WHERE kind = 'task' AND row_id = ?").run(drop);
          db.prepare('DELETE FROM tasks WHERE id = ?').run(drop);
        }
      }
      for (const { uid, keep } of groups('shopping_items')) {
        for (const drop of youngerOf('shopping_items', uid, keep)) {
          db.prepare('UPDATE housekeeping_supply_requests SET shopping_item_id = ? WHERE shopping_item_id = ?').run(keep, drop);
          db.prepare("DELETE FROM caldav_upload_attempts WHERE kind = 'item' AND row_id = ?").run(drop);
          db.prepare('DELETE FROM shopping_items WHERE id = ?').run(drop);
        }
      }

      // Bestand, der schon heute auf ein geloeschtes Konto zeigt (gedriftete DB).
      db.exec(`
        UPDATE tasks SET external_account_id = NULL
         WHERE external_account_id IS NOT NULL AND external_account_id NOT IN (SELECT id FROM caldav_accounts);
        UPDATE shopping_items SET external_account_id = NULL
         WHERE external_account_id IS NOT NULL AND external_account_id NOT IN (SELECT id FROM caldav_accounts);

        CREATE TRIGGER trg_caldav_accounts_release_rows
          AFTER DELETE ON caldav_accounts FOR EACH ROW
          BEGIN
            UPDATE tasks
               SET external_account_id = NULL, outbound_dirty = 0, outbound_attempts = 0
             WHERE external_account_id = OLD.id;
            UPDATE tasks
               SET target_caldav_account_id = NULL, target_caldav_list_url = NULL
             WHERE target_caldav_account_id = OLD.id;
            UPDATE shopping_items
               SET external_account_id = NULL, outbound_dirty = 0, outbound_attempts = 0,
                   outbound_move = 0, outbound_move_attempts = 0, outbound_move_since = NULL, outbound_move_by = NULL
             WHERE external_account_id = OLD.id;
            UPDATE calendar_events
               SET target_caldav_account_id = NULL, target_caldav_calendar_url = NULL
             WHERE target_caldav_account_id = OLD.id;
          END;
      `);
    },
  };
