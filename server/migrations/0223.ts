// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 223,
    description: 'Health: daily nutrition target per person and a logged intake (#1326)',
    up: `
      -- ACHT SPALTEN, FEST, UND DIESELBEN ACHT UEBERALL (docs/DECISIONS.md
      -- Abschnitt 8). Energie in Kilokalorien, Fett, davon gesaettigte
      -- Fettsaeuren, Kohlenhydrate, davon Zucker, Eiweiss, Salz und
      -- Ballaststoffe: die sieben Pflichtangaben der EU-Naehrwerttabelle plus
      -- Ballaststoffe - also der Satz, den jemand von der Packung vor sich
      -- ablist, statt einer hier ausgedachten Auswahl.
      --
      -- WARUM FEST UND NICHT nutrient_key/value: eine neunte Spalte spaeter ist
      -- eine Migration, die jede Bestandsinstallation nehmen muss; ein
      -- Schluessel/Wert-Paar dagegen hiesse "was immer jemand eintippt", und
      -- genau in dieser Form waechst ein Produktkatalog eine Zeile nach der
      -- anderen - das ist die Absage aus #714.
      --
      -- WARUM DIE EINHEIT IM NAMEN STEHT: ein blosses "fat" sagt nicht, ob dort
      -- Gramm oder Milligramm liegen, und eine REAL-Spalte nimmt beides
      -- klaglos bis in alle Ewigkeit. "energy_kcal" sagt ausserdem, welche
      -- Energieeinheit gewaehlt wurde - eine Packung nennt auch kJ, die
      -- Anzeige darf rechnen, die Spalte fuehrt eine davon.
      --
      -- UND KEINE SPALTE HEISST "calories": health_activities.calories (v65)
      -- ist die Energie, die eine Sporteinheit VERBRENNT. Ein Wort fuer beide
      -- Richtungen waere ein Fehler, der im Wortschatz wartet, und er trifft
      -- zuerst den CSV-Export, wo beide Bereiche in einer Datei liegen.
      --
      -- "fiber", nicht "fibre": die Prosa unter docs/ ist britisch, das Schema
      -- ist es nicht - "color" (v1) ist das bestehende Vorbild. Spalten folgen
      -- dem Schema.

      -- Das Tagesziel je Person. SPARSE wie health_fasting_settings (v209):
      -- keine Zeile heisst "kein Ziel", und deshalb ist jede der acht Spalten
      -- nullbar. Der Unterschied traegt hier wirklich etwas: NULL ist "nicht
      -- gesetzt", 0 ist das ausdrueckliche Ziel "null Gramm Zucker" - wer die
      -- Spalte als falsy liest, macht aus der zweiten Aussage die erste.
      CREATE TABLE health_nutrition_targets (
        user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        energy_kcal      REAL CHECK (energy_kcal      IS NULL OR energy_kcal      >= 0),
        fat_g            REAL CHECK (fat_g            IS NULL OR fat_g            >= 0),
        saturated_fat_g  REAL CHECK (saturated_fat_g  IS NULL OR saturated_fat_g  >= 0),
        carbs_g          REAL CHECK (carbs_g          IS NULL OR carbs_g          >= 0),
        sugar_g          REAL CHECK (sugar_g          IS NULL OR sugar_g          >= 0),
        protein_g        REAL CHECK (protein_g        IS NULL OR protein_g        >= 0),
        salt_g           REAL CHECK (salt_g           IS NULL OR salt_g           >= 0),
        fiber_g          REAL CHECK (fiber_g          IS NULL OR fiber_g          >= 0),
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_health_nutrition_targets_updated_at
        AFTER UPDATE ON health_nutrition_targets FOR EACH ROW BEGIN
          UPDATE health_nutrition_targets SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE user_id = OLD.user_id; END;

      -- Der erfasste Eintrag. Die acht Zahlen stehen als Werte HIER und zeigen
      -- nicht auf ein Rezept: wer naechsten Monat sein Rezept aendert, darf
      -- damit nicht umschreiben, was jemand letzte Woche gegessen hat -
      -- dieselbe Begruendung, aus der v193 den bezahlten Preis am
      -- Einkaufsartikel speichert statt auf ein Produkt zu zeigen.
      CREATE TABLE health_nutrition_entries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Wanduhrzeit des Haushalts (YYYY-MM-DDTHH:mm), kein Instant: "heute"
        -- ist hier ein Kalendertag, und der faellt in der Haushaltszone
        -- (server/utils/timezone.js, todayKey). Ein UTC-Zeitpunkt haette am
        -- Abend westlich und am Morgen oestlich von UTC den Nachbartag
        -- getragen.
        consumed_at     TEXT    NOT NULL,
        meal_type       TEXT    CHECK (meal_type IS NULL OR meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
        title           TEXT    NOT NULL,
        energy_kcal     REAL CHECK (energy_kcal     IS NULL OR energy_kcal     >= 0),
        fat_g           REAL CHECK (fat_g           IS NULL OR fat_g           >= 0),
        saturated_fat_g REAL CHECK (saturated_fat_g IS NULL OR saturated_fat_g >= 0),
        carbs_g         REAL CHECK (carbs_g         IS NULL OR carbs_g         >= 0),
        sugar_g         REAL CHECK (sugar_g         IS NULL OR sugar_g         >= 0),
        protein_g       REAL CHECK (protein_g       IS NULL OR protein_g       >= 0),
        salt_g          REAL CHECK (salt_g          IS NULL OR salt_g          >= 0),
        fiber_g         REAL CHECK (fiber_g         IS NULL OR fiber_g         >= 0),
        note            TEXT,
        -- DAS KANONISCHE VOKABULAR AUS docs/DECISIONS.md ABSCHNITT 5, nicht das
        -- Paar private/family, das die Gesundheit sonst fuehrt. Abschnitt 5
        -- nennt dieses Paar unter den Vokabularen, die er normalisieren will,
        -- und haelt einen neuen Gesundheits-Tab, der mit einer eigenen Spalte
        -- in ebendiesem Paar ankam (PR #1019), als den Fall fest, den er
        -- verhindern soll. "Neue Module nehmen den kanonischen Satz von
        -- Anfang an" ist der Satz, und ein Tagebuch je Person ist das
        -- Zeilenaufkommen eines neuen Moduls.
        --
        -- Der benannte Satz aus der Mitte des Vokabulars ('assignees') steht
        -- bewusst NICHT im CHECK: die Gesundheit hat keine Zuweisungstabelle,
        -- der Wert waere hier von 'private' nicht unterscheidbar und damit ein
        -- Wert, der etwas anderes behauptet, als er tut. Er kommt, wenn es
        -- eine Zuordnung gibt, die ihn traegt.
        visibility      TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'all')),
        created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_health_nutrition_entries_updated_at
        AFTER UPDATE ON health_nutrition_entries FOR EACH ROW BEGIN
          UPDATE health_nutrition_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = OLD.id; END;

      -- Die eine Abfrage, die diese Tabelle staendig fahren muss, ist "alles von
      -- dieser Person an diesem Tag" - Eigentuemer plus Datumsanfang von
      -- consumed_at, in genau dieser Reihenfolge.
      CREATE INDEX idx_health_nutrition_entries_user_date
        ON health_nutrition_entries(user_id, consumed_at);
    `,
  };
