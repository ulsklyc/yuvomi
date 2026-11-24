// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 74,
    description: 'role- and member-based access permissions for modules and widgets (#467)',
    up: `
      -- Zugriffsrechte pro Subjekt (Familienrolle ODER einzelnes Mitglied) auf
      -- Module und Dashboard-Widgets. Bewusst SPARSE: nur Zeilen, die vom
      -- Standard (voller Zugriff) abweichen, werden gespeichert. Fehlt eine Zeile,
      -- gilt für Module 'write' und für Widgets 'allow' — dadurch verhalten sich
      -- alle Bestands-Installationen nach der Migration unverändert (kein
      -- Zwangs-Lockout). Admins umgehen dieses System vollständig (Bypass in der
      -- Auflösungslogik), damit sich niemand selbst aussperren kann. Siehe #467.
      --
      --   subject_type  'role'  → subject_id = users.family_role
      --                 'user'  → subject_id = users.id (als Text)
      --   resource_type 'module'→ resource_key = Permissions-Modulschlüssel
      --                 'widget'→ resource_key = Dashboard-Widget-ID
      --   access        Module : 'none' | 'read' | 'write'
      --                 Widget : 'none' (gesperrt) | 'allow' (verfügbar)
      CREATE TABLE IF NOT EXISTS access_permissions (
        subject_type  TEXT NOT NULL CHECK(subject_type IN ('role', 'user')),
        subject_id    TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('module', 'widget')),
        resource_key  TEXT NOT NULL,
        access        TEXT NOT NULL CHECK(access IN ('none', 'read', 'write', 'allow')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (subject_type, subject_id, resource_type, resource_key)
      );
      CREATE INDEX IF NOT EXISTS idx_access_permissions_subject
        ON access_permissions(subject_type, subject_id);
    `,
  };
