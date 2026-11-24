// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 175,
    description: 'Permissions: allow fine-grained capability resources',
    // `access_permissions.resource_type` is protected by a CHECK constraint.
    // SQLite cannot extend that constraint in place, so the table is rebuilt
    // while preserving every existing module and widget override verbatim.
    // No concrete capability is registered here; features can add one without
    // having to change this core table again.
    up: `
      CREATE TABLE access_permissions_new (
        subject_type  TEXT NOT NULL CHECK(subject_type IN ('role', 'user')),
        subject_id    TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('module', 'widget', 'capability')),
        resource_key  TEXT NOT NULL,
        access        TEXT NOT NULL CHECK(access IN ('none', 'read', 'write', 'allow')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (subject_type, subject_id, resource_type, resource_key)
      );
      INSERT INTO access_permissions_new
        (subject_type, subject_id, resource_type, resource_key, access, updated_at)
      SELECT subject_type, subject_id, resource_type, resource_key, access, updated_at
      FROM access_permissions;
      DROP TABLE access_permissions;
      ALTER TABLE access_permissions_new RENAME TO access_permissions;
      CREATE INDEX IF NOT EXISTS idx_access_permissions_subject
        ON access_permissions(subject_type, subject_id);
    `,
  };
