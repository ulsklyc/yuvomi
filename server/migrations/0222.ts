export default {
    version: 222,
    description: 'Recipes: the household can confirm which stock row an ingredient means (#1314)',
    up: `
      -- Die EINE Aussage aus #1314, Stufe 1: "diese Zutat meint diese Zeile in
      -- meinem Vorrat". Kein Katalog, keine kanonischen Namen - die Grenze aus
      -- docs/DECISIONS.md Abschnitt 7 laeuft genau hier: ein Vergleich zweier
      -- Zeilen, die der Haushalt selbst angelegt hat, bleibt ohne Pflege wahr;
      -- eine Tabelle von Produktidentitaeten muesste jemand ewig richtig halten.
      --
      -- WARUM EINE EIGENE TABELLE UND KEINE SPALTE AUF recipe_ingredients. Das
      -- war die erste Messung dieser Arbeit, und sie hat das Modell bestimmt:
      -- recipe_ingredients wird beim Speichern eines Rezepts KOMPLETT NEU
      -- GESCHRIEBEN. server/routes/recipes.js (PUT /:id) fuehrt ein "DELETE FROM
      -- recipe_ingredients WHERE recipe_id = ?" und danach ein INSERT je Zutat;
      -- server/services/recipe-provider-sync.js tut bei jedem Spiegel-Lauf
      -- dasselbe. Eine Spalte auf dieser Tabelle waere also nach dem naechsten
      -- Speichern weg - still, ohne Fehler, und niemand haette es gemerkt.
      --
      -- Der Anker ist deshalb (recipe_id, ingredient_key): das Rezept ueberlebt,
      -- und der Name wird beim Neuschreiben unveraendert wieder eingefuegt.
      -- ingredient_key ist der Name getrimmt, kleingeschrieben und mit
      -- zusammengezogenem Leerraum (public/utils/ingredient-match-key.js, von
      -- Server und Oberflaeche geteilt) - NICHT als Aehnlichkeitssuche, sondern
      -- damit dieselbe Zutat nach einem Speichern wiedererkannt wird. Wer die
      -- Zutat umbenennt, hat eine andere Zutat gemeint, und die Zuordnung faellt
      -- zu Recht weg.
      CREATE TABLE IF NOT EXISTS recipe_ingredient_pantry_matches (
        recipe_id      INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        -- Normalisierter Zutatenname, siehe oben. Kein FK auf
        -- recipe_ingredients.id: genau die ID gibt es nach dem naechsten
        -- Speichern nicht mehr.
        ingredient_key TEXT    NOT NULL,
        -- ON DELETE CASCADE, und die Wahl ist nur in DIESER Tabelle die
        -- richtige. Das Schema nebenan setzt sonst ueberall SET NULL, wo die
        -- Zeile auch ohne ihr Gegenueber noch etwas bedeutet: meals.recipe_id
        -- (v13) laesst die Mahlzeit stehen, wenn das Rezept geht;
        -- pantry_items.location_id laesst den Bestand stehen, wenn der Lagerort
        -- geht; pantry_items.created_by wurde in v109 eigens von CASCADE auf
        -- SET NULL zurueckgebaut, weil ein geloeschtes Mitglied sonst den
        -- halben Vorrat mitgenommen haette. CASCADE steht dort, wo die Zeile
        -- NICHTS ausser der Verbindung ist - recipe_ingredients.recipe_id.
        --
        -- Diese Zeile ist nichts ausser der Verbindung. Ist die Vorratszeile
        -- weg, ist die Aussage des Haushalts gegenstandslos: sie galt dieser
        -- Packung, nicht einem Produkt (der Vorrat fuehrt bewusst Chargen, siehe
        -- Kommentar an pantry_items). Eine Zuordnung, die ins Leere zeigt, waere
        -- schlimmer als keine, und SET NULL liesse genau die stehen.
        --
        -- Und weil die Verbindung hier wohnt statt auf recipe_ingredients,
        -- reicht CASCADE nie bis zur Zutat: das Rezept behaelt sie, sie ist nur
        -- wieder unzugeordnet. Auf einer Spalte haette dieselbe Klausel die
        -- Zutat aus dem Rezept geloescht.
        pantry_item_id INTEGER NOT NULL REFERENCES pantry_items(id) ON DELETE CASCADE,
        -- Wer bestaetigt hat, als Herkunftsnachweis. SET NULL aus demselben
        -- Grund wie in v109: ein ausscheidendes Mitglied nimmt keine
        -- Haushaltsdaten mit.
        confirmed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        -- Eine Zutat zeigt auf hoechstens eine Vorratszeile. Ein erneutes
        -- Bestaetigen ersetzt die alte Aussage, statt eine zweite danebenzulegen.
        PRIMARY KEY (recipe_id, ingredient_key)
      );

      -- Fuer das Aufraeumen beim Loeschen einer Vorratszeile: ohne ihn sucht
      -- SQLite die betroffenen Zuordnungen mit einem Tabellendurchlauf.
      CREATE INDEX IF NOT EXISTS idx_ripm_pantry_item
        ON recipe_ingredient_pantry_matches(pantry_item_id);

      CREATE TRIGGER IF NOT EXISTS trg_ripm_updated_at
        AFTER UPDATE ON recipe_ingredient_pantry_matches FOR EACH ROW
        BEGIN
          UPDATE recipe_ingredient_pantry_matches
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE recipe_id = OLD.recipe_id AND ingredient_key = OLD.ingredient_key;
        END;
    `,
  };
