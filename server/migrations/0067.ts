// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 67,
    description: 'Store local family_documents.content_data as binary BLOB instead of base64 TEXT (#332)',
    // Reine Datenmigration ohne DDL: Die Spalte behält TEXT-Affinität, SQLite
    // speichert gebundene Buffer aber als BLOB (TEXT-Affinität konvertiert nur
    // Numerik zu Text, niemals BLOB). Ergebnis: ~25 % weniger Speicher pro lokal
    // gespeichertem Dokument und kein base64-En-/Decode mehr beim Lesen/Schreiben.
    // RAM-schonend für kleine Geräte (Raspberry Pi): erst nur die IDs sammeln,
    // dann Dokument für Dokument einzeln laden, dekodieren und zurückschreiben.
    // Idempotent (bereits binäre Werte werden übersprungen); WebDAV-/DMS-Zeilen
    // (content_data = '') bleiben unberührt.
    up: (database) => {
      const ids = database.prepare(`
        SELECT id FROM family_documents
        WHERE storage_backend = 'local'
          AND content_data IS NOT NULL
          AND content_data <> ''
      `).all().map((row) => row.id);
      const read = database.prepare('SELECT content_data FROM family_documents WHERE id = ?');
      const write = database.prepare('UPDATE family_documents SET content_data = ? WHERE id = ?');
      for (const id of ids) {
        const value = read.get(id)?.content_data;
        if (value === null || value === undefined || Buffer.isBuffer(value)) continue;
        write.run(Buffer.from(String(value), 'base64'), id);
      }
    },
  };
