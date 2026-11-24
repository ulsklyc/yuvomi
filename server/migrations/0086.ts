// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 86,
    description: 'Link family documents to tasks (#503)',
    up: `
      -- Verknüpft Dokumente aus dem Dokumente-Modul mit Aufgaben (n:m, #503).
      -- ON DELETE CASCADE auf beiden Seiten: löscht die Verknüpfung, wenn entweder
      -- die Aufgabe oder das Dokument entfernt wird (das jeweils andere bleibt
      -- bestehen). created_by hält fest, wer verknüpft hat.
      CREATE TABLE IF NOT EXISTS task_documents (
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (task_id, document_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_documents_document ON task_documents(document_id);
    `,
  };
