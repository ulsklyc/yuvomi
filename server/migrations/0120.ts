// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 120,
    description: 'Mealie integration: store recipe slug and image flag for link rebuild and thumbnails',
    up: `
      -- Slug persistieren: recipe_url wird bei jedem Sync neu daraus gebaut, ohne
      -- erneuten Abruf. Sonst erreichte eine geänderte external_url nur Rezepte,
      -- die sich in Mealie selbst wieder ändern.
      ALTER TABLE recipes ADD COLUMN mealie_slug TEXT;
      ALTER TABLE recipes ADD COLUMN mealie_has_image INTEGER NOT NULL DEFAULT 0;
    `,
  };
