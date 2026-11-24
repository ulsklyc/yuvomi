export default {
    version: 121,
    description: 'Invite links: admins invite members instead of setting their password',
    up: `
      -- Bauplan wie password_resets: nur der Hash liegt in der DB, der Klartext-
      -- Token verlässt den Server genau einmal. Anders als beim Reset wird der
      -- Datensatz beim Einlösen NICHT gelöscht, sondern markiert: das hält die
      -- Spur "wer hat wen eingeladen" und trägt den Zustand fürs Admin-UI.
      CREATE TABLE IF NOT EXISTS invites (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash       TEXT    NOT NULL,
        email            TEXT,
        username         TEXT,
        display_name     TEXT,
        role             TEXT    NOT NULL DEFAULT 'member'
                                 CHECK(role IN ('admin', 'member')),
        -- kein CHECK: FAMILY_ROLES wächst, eine append-only-Migration darf das
        -- nicht einfrieren. Validierung passiert in der Route.
        family_role      TEXT    NOT NULL DEFAULT 'other',
        created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        expires_at       INTEGER NOT NULL,
        accepted_at      TEXT,
        accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at       TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_hash ON invites(token_hash);
      CREATE INDEX IF NOT EXISTS idx_invites_open ON invites(expires_at)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
    `,
  };
