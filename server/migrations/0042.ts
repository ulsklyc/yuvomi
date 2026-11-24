export default {
    version: 42,
    description: 'OIDC/SSO: oidc_sub and oidc_provider columns on users',
    up: `
      ALTER TABLE users ADD COLUMN oidc_sub      TEXT;
      ALTER TABLE users ADD COLUMN oidc_provider TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub
        ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
    `,
  };
