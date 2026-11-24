// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 192,
    description: 'own image for recipes typed into yuvomi',
    up: `
      -- EIN BILD JE REZEPT (#1059, Schritt 2).
      --
      -- Schritt 1 zeigte im Planer und auf der Uebersichtskachel das Bild eines
      -- gespiegelten Provider-Rezepts; wer keinen Mealie- oder Tandoor-Server
      -- betreibt - die Mehrheit - sah dort weiter nur Text. Diese Spalte traegt
      -- das selbst hochgeladene Bild.
      --
      -- ALS DATA-URL IN DER ZEILE, wie das Gegenstandsfoto (Migration 142) und
      -- das Geburtstagsbild: ein Bild je Datensatz, dieselbe Groessengrenze,
      -- derselbe Zuschnitt im Client. Ein eigener Speicherort waere die dritte
      -- Bauart fuer dieselbe Sache - und die Dokumentenablage ist fuer Dateien
      -- da, die der Haushalt VERWALTET, nicht fuer eine Vorschau, die zu ihrer
      -- Zeile gehoert und mit ihr verschwindet.
      ALTER TABLE recipes ADD COLUMN image_data TEXT;
    `,
  };
