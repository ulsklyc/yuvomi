// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 134,
    description: 'Recipe provider mirrors: generalize Mealie-only schema for multiple providers (#530)',
    up: `
      -- mealie_accounts -> recipe_provider_accounts, mit Provider-Diskriminator.
      -- ADD COLUMN mit CHECK ist hier unproblematisch, weil der DEFAULT
      -- ('mealie') die Bedingung erfuellt und kein Bestandsdatensatz ein
      -- Backfill braucht. Eine spaetere Erweiterung des CHECKs (z.B. um
      -- 'recipesage') braucht das Rebuild-Muster (CREATE+COPY+DROP+RENAME) wie
      -- an anderer Stelle in dieser Datei, da SQLite einen CHECK nicht per
      -- ALTER erweitern kann - hier nicht noetig, da nur 'mealie' und
      -- 'tandoor' mit dieser Migration ausgeliefert werden.
      ALTER TABLE mealie_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'mealie'
        CHECK(provider IN ('mealie', 'tandoor'));

      -- Echtes RENAME TO (kein CREATE+DROP): bei aktivem foreign_keys schreibt
      -- SQLite jede REFERENCES mealie_accounts(...) Klausel im Schema auf den
      -- neuen Namen um - recipes.mealie_account_id's FK-Ziel wird dabei
      -- automatisch mitgezogen, ohne dass recipes hier angefasst wird.
      ALTER TABLE mealie_accounts RENAME TO recipe_provider_accounts;

      -- Spalten-Umbenennung auf recipes: RENAME COLUMN erhaelt die Daten, die
      -- (nun umgeleitete) FK, und schreibt auch die Spaltenliste des
      -- partiellen UNIQUE-Index um.
      ALTER TABLE recipes RENAME COLUMN mealie_account_id TO provider_account_id;
      ALTER TABLE recipes RENAME COLUMN mealie_recipe_id TO provider_recipe_id;
      ALTER TABLE recipes RENAME COLUMN mealie_updated_at TO provider_updated_at;
      -- provider_slug's Bedeutung ist ab jetzt adapterabhaengig: Mealie legt
      -- hier seinen eigenen Rezept-Slug ab (fuer /g/{groupSlug}/r/{slug}
      -- Links); Tandoor legt hier den relativen Bildpfad ab (fuer den
      -- Thumbnail-Proxy), da Tandoors Rezept-Link nur die numerische Id
      -- braucht, die bereits in provider_recipe_id steht.
      ALTER TABLE recipes RENAME COLUMN mealie_slug TO provider_slug;
      ALTER TABLE recipes RENAME COLUMN mealie_has_image TO provider_has_image;
    `,
  };
