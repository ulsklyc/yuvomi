// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 272,
    description: 'Documents: optional household member the document is about',
    // Die Person, um die es in einem Dokument geht (#1705), getrennt von der
    // Person, die es abgelegt hat. Sie entscheidet ueber Erinnerung und Filter,
    // NIE darueber, wer das Dokument sieht (DECISIONS 1): `documentVisibleSql()`
    // kennt die Spalte bewusst nicht. SET NULL, weil ein geloeschtes Konto dem
    // Haushalt nicht den Pass nimmt. Bewacht, damit ein zweiter Lauf auf einer
    // gedrifteten Datenbank nicht scheitert.
    up(database) {
      const cols = database.prepare('PRAGMA table_info(family_documents)').all();
      if (!cols.some((col) => col.name === 'subject_user_id')) {
        database.exec('ALTER TABLE family_documents ADD COLUMN subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_family_documents_subject ON family_documents(subject_user_id)');
    },
  };
