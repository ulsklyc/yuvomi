// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 255,
    description: 'recipe providers: an account remembers the case of its last failed sync',
    // DER FALL DES LETZTEN FEHLSCHLAGS STEHT NEBEN SEINEM TEXT (#1909), wie bei
    // den Abfuhr-Quellen (Migration 247). Bisher trug ein Rezeptdienst-Konto nur
    // `last_error`, den rohen Text des Adapters oder des Netzes ("Mealie request
    // failed (401)", "getaddrinfo ENOTFOUND mealie", "HTTP 404"), und die Karte
    // in Einstellungen > Kueche zeigte ihn so. `last_error_reason` haelt den
    // Fall (recipe_providers_sync_*, recipe_providers_private_network),
    // `last_error_params` seine Zahlen als JSON (der Status) - den Satz baut
    // die App. Bestandszeilen bleiben NULL: sie bekommen den allgemeinen Satz,
    // bis der naechste Abgleich seinen Fall schreibt.
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(recipe_provider_accounts)').all().map((c) => c.name));
      if (!columns.has('last_error_reason')) database.exec('ALTER TABLE recipe_provider_accounts ADD COLUMN last_error_reason TEXT');
      if (!columns.has('last_error_params')) database.exec('ALTER TABLE recipe_provider_accounts ADD COLUMN last_error_params TEXT');
    },
  };
