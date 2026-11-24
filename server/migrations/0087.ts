// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 87,
    description: 'School-holiday group code for multilingual cantons (#434)',
    up: `
      -- OpenHolidays modelliert innerhalb EINER Subdivision teils mehrere
      -- Schulferien-Regime (z. B. Kanton Bern: deutschsprachige Region CH-BE-VS
      -- vs. französischsprachiger Berner Jura CH-BE-EO), unterschieden nur über
      -- das "groups"-Feld. group_code hält diesen Gruppen-Code je Cache-Zeile,
      -- damit die konfigurierte Ferien-Gruppe lese-seitig gefiltert werden kann
      -- (NULL = gilt für die gesamte Subdivision, z. B. Feiertage). (#434)
      ALTER TABLE holiday_cache ADD COLUMN group_code TEXT;
    `,
  };
