export default {
    version: 38,
    description: 'Calendar attachment document linkage',
    up: `
      ALTER TABLE calendar_events ADD COLUMN attachment_document_id INTEGER REFERENCES family_documents(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_calendar_attachment_document ON calendar_events(attachment_document_id);
    `,
  };
