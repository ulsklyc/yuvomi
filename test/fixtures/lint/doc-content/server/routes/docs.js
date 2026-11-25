// DOC-CONTENT fixture (#2956): an UPDATE (also with alias, schema prefix or a row-value
// list) or an upsert on family_documents that sets a content column (storage_key,
// storage_backend, storage_provider, content_data, mime_type, file_size), and an
// INSERT OR REPLACE / REPLACE INTO family_documents, is a finding, one line per spelling (`doc-N` in a comment on the line where the string
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
db.prepare('UPDATE family_documents AS d SET storage_key = ? WHERE d.id = ?').run(); // doc-6
db.prepare('UPDATE family_documents d SET content_data = ? WHERE d.id = ?').run(); // doc-7
db.prepare('UPDATE main.family_documents SET mime_type = ? WHERE id = ?').run(); // doc-8
db.prepare('UPDATE "main"."family_documents" SET file_size = ? WHERE id = ?').run(); // doc-9
db.prepare('INSERT INTO family_documents (id, storage_key) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET storage_key = excluded.storage_key').run(); // doc-10
db.prepare('UPDATE family_documents SET (name, storage_backend) = (?, ?) WHERE id = ?').run(); // doc-11
db.prepare('UPDATE family_documents SET "storage_key" = ? WHERE id = ?').run(); // doc-12
db.prepare('INSERT OR REPLACE INTO family_documents (id, name) VALUES (?, ?)').run(); // doc-13
db.prepare('REPLACE INTO main.family_documents (id, name) VALUES (?, ?)').run(); // doc-14

db.prepare('UPDATE family_documents SET name = ?, status = ? WHERE id = ?').run();
db.prepare('UPDATE family_documents SET status = ? WHERE storage_key = ?').run();
db.prepare('UPDATE family_document_access SET user_id = ? WHERE document_id = ?').run();
db.prepare(`UPDATE ${table} SET storage_key = ?`).run();
// The same forms on other tables, and a content column read or in WHERE, stay silent.
db.prepare('UPDATE family_documents AS d SET name = ? WHERE d.storage_key = ?').run();
db.prepare('INSERT INTO family_documents (name) VALUES (?)').run();
db.prepare('INSERT INTO family_documents (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run();
db.prepare('INSERT INTO other_docs (id, storage_key) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET storage_key = excluded.storage_key').run();
db.prepare('UPDATE main.other_docs AS d SET storage_key = ? WHERE d.id = ?').run();
db.prepare('UPDATE family_documents SET name = COALESCE(?, storage_key) WHERE id = ?').run();
db.prepare('UPDATE family_documents_archive SET storage_key = ?').run();
db.prepare('INSERT OR REPLACE INTO other_docs (id) VALUES (?)').run();
// UPDATE family_documents SET storage_key = ? in a comment
