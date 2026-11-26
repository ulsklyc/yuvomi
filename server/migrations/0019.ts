export default {
    version: 19,
    description: 'Separate family member role from system access role',
    up: `
      ALTER TABLE users ADD COLUMN family_role TEXT NOT NULL DEFAULT 'other'
        CHECK(family_role IN ('dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'));

      CREATE INDEX IF NOT EXISTS idx_users_family_role ON users(family_role);
    `,
  };
