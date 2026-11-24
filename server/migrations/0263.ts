// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 263,
    description: 'split expenses: a recurring expense remembers when it started failing (#1746)',
    up: `
      -- Der erste unerwartete Fehlschlag des Buchungslaufs (#1746), ISO-Zeitpunkt
      -- in UTC, oder NULL. Ein unerwarteter Fehler (ein Bug, die Umgebung)
      -- pausiert eine Serie bewusst nicht, damit kein Fehler auf unserer Seite
      -- still die Miete eines Haushalts anhaelt; stattdessen steht er hier und
      -- die Zeile zeigt ihn. Der Lauf setzt ihn beim ersten Fehlschlag und laesst
      -- ihn bei weiteren stehen; eine Buchung, ein Bearbeiten und eine Pause aus
      -- bekanntem Grund leeren ihn (server/services/split-expenses-scheduler.js,
      -- PUT /split-expenses/recurring/:id). Bestandsserien starten ohne.
      -- Ein kuenftiger Rebuild von recurring_expenses muss die Spalte mitnehmen.
      ALTER TABLE recurring_expenses ADD COLUMN failed_at TEXT;
    `,
  };
