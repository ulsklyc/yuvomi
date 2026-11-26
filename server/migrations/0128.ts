export default {
    version: 128,
    description: 'Budget: recurrence as unit + count, weekly included, skips keyed by day (#636)',
    up: `
      -- Das Intervall war eine Liste aus drei Rhythmen (monthly/half_year/yearly).
      -- Alle zwei Wochen, alle drei Monate, alle zwei Jahre: nicht abbildbar,
      -- obwohl genau solche Vertraege der Alltag sind (#636). Es wird deshalb zu
      -- Einheit + Anzahl.
      ALTER TABLE budget_entries ADD COLUMN recurrence_interval_count INTEGER NOT NULL DEFAULT 1;

      -- 'half_year' faellt als eigener Schluessel weg: es IST monatlich x 6. Zwei
      -- Schreibweisen fuer denselben Rhythmus haetten sonst dauerhaft
      -- nebeneinander gestanden, und jede Auswertung muesste beide kennen.
      -- Verlustfrei: derselbe Abstand, dieselbe Glaettung.
      UPDATE budget_entries
         SET recurrence_interval = 'monthly', recurrence_interval_count = 6
       WHERE recurrence_interval = 'half_year';

      -- Eine geloeschte Instanz wurde als uebersprungener MONAT vermerkt. Das war
      -- richtig, solange eine Serie hoechstens ein Vorkommen pro Monat hatte -
      -- bei einer Wochenserie haette das Loeschen eines Dienstags die drei
      -- uebrigen Wochen gleich mit unterdrueckt. Der Vermerk haengt jetzt am
      -- Faelligkeitstag, wie das Vorkommen selbst.
      CREATE TABLE budget_recurrence_skipped_new (
        parent_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
        date      TEXT    NOT NULL,
        PRIMARY KEY (parent_id, date)
      );

      -- Bestand umrechnen: der Tag ergibt sich aus dem Starttag der Serie, am
      -- Monatsende gekappt - dieselbe Regel, nach der die Instanz entstanden waere.
      INSERT OR IGNORE INTO budget_recurrence_skipped_new (parent_id, date)
      SELECT s.parent_id,
             s.month || '-' || substr('0' || MIN(
               CAST(strftime('%d', p.date) AS INTEGER),
               CAST(strftime('%d', date(s.month || '-01', '+1 month', '-1 day')) AS INTEGER)
             ), -2)
        FROM budget_recurrence_skipped s
        JOIN budget_entries p ON p.id = s.parent_id;

      DROP TABLE budget_recurrence_skipped;
      ALTER TABLE budget_recurrence_skipped_new RENAME TO budget_recurrence_skipped;
    `,
  };
