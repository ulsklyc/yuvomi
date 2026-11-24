export default {
    version: 115,
    description: 'Tasks: free-form tags, mirrored from VTODO CATEGORIES (#586)',
    up: `
      -- Tags sind das Gegenstück zu VTODO CATEGORIES und bewusst NICHT die
      -- Kategorie: eine Aufgabe liegt in genau einer Kategorie (einer Schublade),
      -- trägt aber beliebig viele Tags (Etiketten). CATEGORIES auf category
      -- abzubilden hieße, alle Werte ab dem zweiten zu verlieren und beim Push
      -- die Tags zu löschen, die der Server kennt und Yuvomi nie gesehen hat.
      --
      -- Freitext statt verwalteter Liste: die Werte kommen von fremden Servern,
      -- eine Registry würde sich bei jedem Sync mit Fremdwerten füllen und in
      -- jedem Kategorie-Dropdown auftauchen.
      -- Die Spalte tag ist die Schreibweise für die Anzeige, tag_key der
      -- Vergleichsschlüssel (NFC + kleingeschrieben, gebildet in JS). Der
      -- Schlüssel ist keine Bequemlichkeit: SQLites COLLATE NOCASE faltet nur
      -- ASCII, "Äpfel" wäre über "äpfel" nicht auffindbar. Der Primärschlüssel
      -- hängt am Schlüssel, damit dieselbe Aufgabe ein Etikett nicht in zwei
      -- Schreibweisen tragen kann.
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag     TEXT    NOT NULL,
        tag_key TEXT    NOT NULL,
        PRIMARY KEY (task_id, tag_key)
      );

      -- Für den ?tag=-Filter und die Vorschlagsliste.
      CREATE INDEX IF NOT EXISTS idx_task_tags_key ON task_tags(tag_key);
    `,
  };
