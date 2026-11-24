// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 119,
    description: 'Mealie integration: separate public link URL from the server-reachable sync URL',
    up: `
      -- base_url muss vom Server aus erreichbar sein (oft ein Docker-internes
      -- Compose-Hostname) und ist damit für den Browser des Nutzers meist tot.
      -- external_url trägt die von außen erreichbare Adresse für die Deep-Links.
      ALTER TABLE mealie_accounts ADD COLUMN external_url TEXT;
    `,
  };
