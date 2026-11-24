// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 179,
    description: 'Health: optional basal body temperature per day log, for temperature-shift ovulation confirmation',
    // Ein Skalarwert je Tag wie flow/mood - keine eigene Tabelle noetig, die
    // Zeile existiert schon. Kein CHECK auf basal_temp_unit: dieselbe
    // Freitext-Konvention wie health_vitals.unit (kein haushaltweiter
    // C/F-Schalter existiert). Die Wertebereichs-/Einheiten-Pruefung (nur
    // 'c'/'f', plausibler Koerpertemperatur-Bereich) liegt in der Route, nicht
    // im Schema - dieselbe Aufteilung wie ueberall sonst in diesem Modul.
    up: `
      ALTER TABLE cycle_day_logs ADD COLUMN basal_temp REAL;
      ALTER TABLE cycle_day_logs ADD COLUMN basal_temp_unit TEXT;
    `,
  };
