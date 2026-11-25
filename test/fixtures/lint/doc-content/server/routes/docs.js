// DOC-CONTENT fixture (#2956): an UPDATE on family_documents that sets a content column
// (storage_key, storage_backend, storage_provider, content_data, mime_type, file_size)
// is a finding, one line per spelling (`doc-N` in a comment on the line where the string
// starts). Silent: a metadata update, a content column in the WHERE clause, another table,
// an interpolated table name, a comment.
const db = { prepare: (/** @type {string} */ sql) => ({ sql, run() {} }) };
const table = 'family_documents';
const size = 1;

db.prepare('UPDATE family_documents SET storage_key = ? WHERE id = ?').run(); // doc-1
db.prepare(/* doc-2 */ `UPDATE "family_documents"
  SET name = ?,
      content_data = ?
  WHERE id = ?`).run();
db.prepare('update or ignore [family_documents] set mime_type = ? where id = ?').run(); // doc-3
db.prepare(`UPDATE family_documents SET file_size = ${size}, storage_backend = 'local' WHERE id = ?`).run(); // doc-4
db.prepare("UPDATE `family_documents` SET storage_provider = 'external' WHERE id = ?").run(); // doc-5

db.prepare('UPDATE family_documents SET name = ?, status = ? WHERE id = ?').run();
db.prepare('UPDATE family_documents SET status = ? WHERE storage_key = ?').run();
db.prepare('UPDATE family_document_access SET user_id = ? WHERE document_id = ?').run();
db.prepare(`UPDATE ${table} SET storage_key = ?`).run();
// UPDATE family_documents SET storage_key = ? in a comment
