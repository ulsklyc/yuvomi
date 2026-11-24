// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 72,
    description: 'add per-scope permissions to api_tokens (module:read/module:write allow-list)',
    up: `
      -- Scopes für API-/MCP-Tokens: JSON-Array aus "modul:read"/"modul:write".
      -- NULL bedeutet bewusst „kein Scoping" → voller rollenbasierter Zugriff, damit
      -- alle vor dieser Migration erstellten Tokens unverändert weiterfunktionieren.
      -- Ein gesetztes (auch leeres) Array schränkt den Token auf die gelisteten
      -- Modul-/Zugriffs-Kombinationen ein (Least Privilege für an LLM-Clients
      -- ausgehändigte MCP-Tokens, siehe Discussion #455).
      ALTER TABLE api_tokens ADD COLUMN scopes TEXT DEFAULT NULL;
    `,
  };
