// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 229,
    description: 'Budget: a series keeps its own start date (#1545)',
    // DER STARTTAG WAR NOCH DAS DATUM DER ERSTEN BUCHUNG (#1545). v228 hat die
    // Werte der Vorlage vom Anker getrennt, den Starttag aber dort gelassen:
    // occurrenceDatesInMonth() leitet jedes spaetere Vorkommen (Tag im Monat,
    // Wochentag, das "alle N"-Raster) aus ihm ab. Eine Korrektur NUR der ersten
    // Buchung ("abgebucht wurde am 6., nicht am 5.") verschob deshalb das
    // Raster jedes Vorkommens, das noch nicht angelegt war, und bei Wochen-
    // oder "alle N"-Serien sogar, welche Tage es ueberhaupt gibt.
    //
    // Die Definition bekommt ihren eigenen Starttag. Gefuellt aus dem Datum des
    // Ankers - das war bis hierher der Starttag, jede Serie behaelt also genau
    // ihr Raster. Die Trigger aus v228 legen neue Definitionen an; sie werden
    // hier mit derselben Bedingung neu angelegt und nehmen den Starttag aus
    // der Buchung mit (DROP + CREATE, weil ein Trigger sich nicht aendern
    // laesst). Ein kuenftiger Rebuild von budget_entries verliert sie weiter
    // mit der Tabelle, siehe v228.
    //
    // NULL-faehig, weil ADD COLUMN ein NOT NULL nur mit Vorgabewert nimmt, und
    // jeder Vorgabewert waere ein erfundener Starttag. Geschrieben wird die
    // Spalte von dieser Migration, den Triggern und PUT /budget/:id/series;
    // generateRecurringInstances() liest bei NULL das Datum des Ankers, also
    // genau das Verhalten bis v228.
    //
    // GRID_FROM: ab welchem Tag das heutige Raster gilt. Eine Serien-Aenderung,
    // die das Raster verschiebt (Starttag oder Rhythmus), raeumt nur ab heute
    // ab; was davor liegt, ist gebucht und steht auf dem alten Raster. Der
    // Monatsaufruf kennt das alte Raster nicht mehr und legte in einem schon
    // gefuellten vergangenen Monat ein zweites Vorkommen daneben (Review-Befund
    // in #1585). Vor grid_from erzeugt generateRecurringInstances() deshalb
    // nichts. NULL = das Raster galt schon immer, keine Grenze - der Bestand
    // bleibt, wie er ist.
    //
    // Idempotent: jede Spalte kommt nur dazu, wenn sie fehlt, und gefuellt
    // wird nur, was noch keinen Starttag hat - ein zweiter Lauf ueberschreibt
    // keinen inzwischen geaenderten.
    up(db) {
      const columns = db.prepare('PRAGMA table_info(budget_series)').all().map((c) => c.name);
      if (!columns.includes('start_date')) {
        db.exec('ALTER TABLE budget_series ADD COLUMN start_date TEXT');
      }
      if (!columns.includes('grid_from')) {
        db.exec('ALTER TABLE budget_series ADD COLUMN grid_from TEXT');
      }
      // "Gibt es das Vorkommen an diesem Tag schon?" fragt occurrenceWriter()
      // fuer jedes Vorkommen. Mit dem Index nur auf recurrence_parent_id las
      // die Frage jede Buchung der Serie - beim Einfrieren der Vergangenheit
      // vor einer Rasteraenderung (#1585) quadratisch: gemessen 290 s fuer
      // eine Wochenserie ueber 100.000 Vorkommen. Ein kuenftiger Rebuild von
      // budget_entries (wie v156) muss ihn mit anlegen.
      db.exec('CREATE INDEX IF NOT EXISTS idx_budget_parent_date ON budget_entries(recurrence_parent_id, date)');
      db.exec(`
        UPDATE budget_series
           SET start_date = (SELECT e.date FROM budget_entries e WHERE e.id = budget_series.anchor_id)
         WHERE start_date IS NULL;

        DROP TRIGGER IF EXISTS trg_budget_series_on_insert;
        CREATE TRIGGER trg_budget_series_on_insert
          AFTER INSERT ON budget_entries
          WHEN NEW.is_recurring = 1 AND NEW.recurrence_parent_id IS NULL
        BEGIN
          INSERT OR IGNORE INTO budget_series
            (anchor_id, title, amount, full_amount, category, subcategory, account_id, visibility,
             start_date)
          VALUES (NEW.id, NEW.title, NEW.amount, NEW.recurrence_full_amount, NEW.category,
                  NEW.subcategory, NEW.account_id, NEW.visibility, NEW.date);
        END;

        DROP TRIGGER IF EXISTS trg_budget_series_on_start;
        CREATE TRIGGER trg_budget_series_on_start
          AFTER UPDATE OF is_recurring ON budget_entries
          WHEN OLD.is_recurring = 0 AND NEW.is_recurring = 1 AND NEW.recurrence_parent_id IS NULL
        BEGIN
          INSERT OR IGNORE INTO budget_series
            (anchor_id, title, amount, full_amount, category, subcategory, account_id, visibility,
             start_date)
          VALUES (NEW.id, NEW.title, NEW.amount, NEW.recurrence_full_amount, NEW.category,
                  NEW.subcategory, NEW.account_id, NEW.visibility, NEW.date);
        END;
      `);
    },
  };
