export default {
    version: 224,
    description: 'Inventory: recurring tracked dates, a service log, and a manual odometer',
    up: `
      -- NULL bleibt das heutige Einmal-Verhalten (kein Zyklus) - jede
      -- bestehende Zeile behaelt sich so unveraendert. Ein Wert rollt das
      -- Datum bei jedem "Erledigt" um interval_months weiter
      -- (server/utils/interval-date.js#addMonthsClamped).
      ALTER TABLE inventory_item_dates ADD COLUMN interval_months INTEGER
        CHECK (interval_months IS NULL OR (interval_months BETWEEN 1 AND 600));
      -- Nur ein Hinweis ("noch 1400 km"), nie eine Erinnerung - die App kennt
      -- den naechsten Kilometerstand nicht im Voraus (docs/SCOPE.md).
      ALTER TABLE inventory_item_dates ADD COLUMN interval_distance INTEGER
        CHECK (interval_distance IS NULL OR interval_distance > 0);

      -- Manuelle Kilometerstand-Ablesung - nie eine Telematik-/Fahrzeug-API,
      -- das ist die eigene harte Grenze des Vorschlags. Bewusst auf die
      -- Kategorie "Fahrzeuge" begrenzt (Nutzer-Entscheidung 2026-09-17), aber
      -- als EIGENSCHAFT der Kategorie-Zeile, nicht als Literal in der
      -- Validierung (Review #1257): 'vehicles' ist eine ganz normale, vom
      -- Haushalt loeschbare Zeile in inventory_categories (items.js:89
      -- validCategoryKeys()) - ein hartcodierter Stringvergleich wuerde beim
      -- Loeschen und bei jedem selbst angelegten Fahrzeug-Ersatz ("Motorrad",
      -- "Wohnmobil") lautlos brechen. tracks_odometer traegt das stattdessen.
      ALTER TABLE inventory_categories ADD COLUMN tracks_odometer INTEGER NOT NULL DEFAULT 0;
      UPDATE inventory_categories SET tracks_odometer = 1 WHERE key = 'vehicles';

      ALTER TABLE inventory_items ADD COLUMN odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0);
      ALTER TABLE inventory_items ADD COLUMN odometer_unit TEXT
        CHECK (odometer_unit IS NULL OR odometer_unit IN ('km', 'mi'));
      ALTER TABLE inventory_items ADD COLUMN odometer_on TEXT;

      -- Die Historie, die heute bei jedem Item-Speichern verloren geht
      -- (item-dates.js#writeTrackedDates ist volles Replace, siehe dessen
      -- Modulkopf). item_date_id ist SET NULL statt CASCADE: "die naechste
      -- Frist wurde am 2026-03-11 erledigt" bleibt wahr, nachdem die Frist-Zeile
      -- durch den naechsten Item-Speichervorgang eine neue id bekommen hat oder
      -- ganz verschwunden ist - deshalb tragen label/performed_on hier ihre
      -- eigene Momentaufnahme statt sich auf den Join zu verlassen.
      CREATE TABLE inventory_item_service_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        item_date_id INTEGER REFERENCES inventory_item_dates(id) ON DELETE SET NULL,
        label        TEXT    NOT NULL,
        performed_on TEXT    NOT NULL,
        odometer     INTEGER CHECK (odometer IS NULL OR odometer >= 0),
        vendor       TEXT,
        note         TEXT,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX idx_inventory_item_service_log_item ON inventory_item_service_log(item_id, performed_on DESC);
      CREATE TRIGGER trg_inventory_item_service_log_updated_at AFTER UPDATE ON inventory_item_service_log FOR EACH ROW BEGIN
        UPDATE inventory_item_service_log SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
