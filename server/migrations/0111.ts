export default {
    version: 111,
    description: 'meal recurrence: optional end date (#619)',
    up: `
      -- Eine wöchentliche Mahlzeit lief bisher ohne Horizont: jede aufgeschlagene
      -- Woche materialisierte eine weitere Instanz, ohne dass die Serie je hätte
      -- enden können (#619). end_date ist die Grenze; NULL bleibt bewusst
      -- „unbegrenzt", damit bestehende Serien unverändert weiterlaufen.
      ALTER TABLE meal_recurrence_templates ADD COLUMN end_date TEXT;
    `,
  };
